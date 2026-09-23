//! Deterministic sketch generators for tests, benchmarks and the oracle corpus.
//!
//! Every generated sketch starts from a *ground-truth* geometry. Dimension values are
//! measured on it, so constraint sets are consistent unless a variant deliberately breaks
//! them; the input coordinates are the ground truth plus noise, so the solver has work
//! to do. The pseudo-random generator is SplitMix64 (no dependency, identical on every
//! target).

use forge_core::math;

use crate::model::{Constraint, ConstraintKind, Entity, Sketch, c};

/// SplitMix64 pseudo-random numbers.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    /// Seeded generator.
    pub fn new(seed: u64) -> Self {
        Self(seed ^ 0x9E37_79B9_7F4A_7C15)
    }
    /// Next 64 random bits.
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in `[0, 1)`.
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }
    /// Uniform in `[lo, hi)`.
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.unit()
    }
    /// Uniform integer in `0..n` (`n > 0`).
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
    /// `true` with probability `p`.
    pub fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }
}

/// What the generator intended (not ground truth about the solver's answer).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    /// Degrees of freedom remain.
    Under,
    /// Exactly determined.
    Fully,
    /// Consistent, with redundant constraints.
    Redundant,
    /// Deliberately contradicting constraints.
    Conflict,
}

/// A generated sketch with its provenance.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Generated {
    /// Unique name (`family/variant/seed`).
    pub name: String,
    /// Family (`rectangle`, `slot`, `bolt_circle`, `rounded_rect`, `arc_chain`, `polygon`).
    pub family: String,
    /// Design intent.
    pub intent: Intent,
    /// Analytic DOF when the generator knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_dof: Option<usize>,
    /// Constraint ids expected to form the minimal conflicting set, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_conflict: Option<Vec<String>>,
    /// The sketch.
    pub sketch: Sketch,
}

/// Incremental sketch builder with noisy input coordinates.
struct B<'a> {
    s: Sketch,
    rng: &'a mut Rng,
    noise: f64,
    /// Ground-truth position of every point (fix constraints pin these, not the noisy
    /// input coordinates).
    truth: Vec<(String, [f64; 2])>,
}

impl<'a> B<'a> {
    fn new(rng: &'a mut Rng, noise: f64) -> Self {
        Self {
            s: Sketch::default(),
            rng,
            noise,
            truth: Vec::new(),
        }
    }
    fn point(&mut self, id: &str, p: [f64; 2]) -> String {
        let (nx, ny) = (
            self.rng.range(-self.noise, self.noise),
            self.rng.range(-self.noise, self.noise),
        );
        self.s
            .entities
            .push(Entity::point(id, p[0] + nx, p[1] + ny));
        self.truth.push((id.to_owned(), p));
        id.to_owned()
    }
    /// Fix a point at its ground-truth position.
    fn fix(&mut self, id: &str) -> String {
        let t = self
            .truth
            .iter()
            .find(|(k, _)| k == id)
            .map(|(_, p)| *p)
            .expect("fix a generated point");
        self.con(ConstraintKind::Fix {
            entity: id.to_owned(),
            x: Some(t[0]),
            y: Some(t[1]),
        })
    }
    fn exact_point(&mut self, id: &str, p: [f64; 2]) -> String {
        self.s.entities.push(Entity::point(id, p[0], p[1]));
        id.to_owned()
    }
    fn line(&mut self, id: &str, a: &str, b: &str) -> String {
        self.s.entities.push(Entity::line(id, a, b));
        id.to_owned()
    }
    fn circle(&mut self, id: &str, center: &str, r: f64) -> String {
        let n = self.rng.range(-0.2 * self.noise, 0.2 * self.noise);
        self.s
            .entities
            .push(Entity::circle(id, center, (r + n).max(0.1 * r)));
        id.to_owned()
    }
    fn arc(&mut self, id: &str, center: &str, start: &str, end: &str) -> String {
        self.s.entities.push(Entity::arc(id, center, start, end));
        id.to_owned()
    }
    fn con(&mut self, kind: ConstraintKind) -> String {
        let id = format!("k{}", self.s.constraints.len());
        self.s.constraints.push(Constraint::new(id.clone(), kind));
        id
    }
    fn construction(&mut self) {
        if let Some(e) = self.s.entities.last_mut() {
            e.construction = true;
        }
    }
    fn fixed(&mut self) {
        if let Some(e) = self.s.entities.last_mut() {
            e.fixed = true;
        }
    }
}

fn rot(p: [f64; 2], o: [f64; 2], th: f64) -> [f64; 2] {
    let (s, co) = math::sin_cos(th);
    let (dx, dy) = (p[0] - o[0], p[1] - o[1]);
    [o[0] + co * dx - s * dy, o[1] + s * dx + co * dy]
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    math::hypot(b[0] - a[0], b[1] - a[1])
}

fn generated(
    name: String,
    family: &str,
    intent: Intent,
    dof: Option<usize>,
    conflict: Option<Vec<String>>,
    s: Sketch,
) -> Generated {
    Generated {
        name,
        family: family.to_owned(),
        intent,
        expected_dof: dof,
        expected_conflict: conflict,
        sketch: s,
    }
}

/// Rectangle variants (index `0..RECT_VARIANTS`).
pub const RECT_VARIANTS: usize = 16;

/// A rectangle made of four lines. `variant % 2 == 1` uses separate line endpoints tied
/// by coincident constraints (8 more parameters, 8 more equations).
pub fn rectangle(seed: u64, variant: usize) -> Generated {
    let mut rng = Rng::new(seed);
    let o = [rng.range(-50.0, 50.0), rng.range(-50.0, 50.0)];
    let (w, h) = (rng.range(5.0, 80.0), rng.range(5.0, 80.0));
    let set = (variant / 2) % 8;
    let separate = variant % 2 == 1;
    let rotated = set == 5;
    let th = if rotated { rng.range(0.2, 1.2) } else { 0.0 };
    let (w, h) = if set == 6 { (w, w) } else { (w, h) };
    let corners =
        [o, [o[0] + w, o[1]], [o[0] + w, o[1] + h], [o[0], o[1] + h]].map(|p| rot(p, o, th));
    let noise = 0.02 * w.min(h);
    let mut b = B::new(&mut rng, noise);
    let p: Vec<String> = (0..4)
        .map(|i| b.point(&format!("p{i}"), corners[i]))
        .collect();
    let mut ends = Vec::new();
    for i in 0..4 {
        let j = (i + 1) % 4;
        if separate {
            let a = b.point(&format!("l{i}a"), corners[i]);
            let e = b.point(&format!("l{i}b"), corners[j]);
            ends.push((a, e));
        } else {
            ends.push((p[i].clone(), p[j].clone()));
        }
    }
    let l: Vec<String> = (0..4)
        .map(|i| {
            let (a, e) = ends[i].clone();
            b.line(&format!("L{i}"), &a, &e)
        })
        .collect();
    if separate {
        // The corner points p_i are then only used as coincident anchors.
        for i in 0..4 {
            let prev = (i + 3) % 4;
            b.con(c::coincident(&ends[i].0, &p[i]));
            b.con(c::coincident(&ends[prev].1, &p[i]));
        }
    }
    // Separate endpoints: 4 corners + 8 ends = 24 params, 16 coincident equations → 8.
    let base_dof = 8usize;
    let hv = |b: &mut B| {
        b.con(c::horizontal(&l[0]));
        b.con(c::vertical(&l[1]));
        b.con(c::horizontal(&l[2]));
        b.con(c::vertical(&l[3]));
    };
    let name = format!("rectangle/{variant}/{seed}");
    let fam = "rectangle";
    match set {
        0 => {
            let s = b.s;
            generated(name, fam, Intent::Under, Some(base_dof), None, s)
        }
        1 => {
            hv(&mut b);
            generated(name, fam, Intent::Under, Some(base_dof - 4), None, b.s)
        }
        2 => {
            hv(&mut b);
            b.con(c::distance(&p[0], &p[1], w));
            b.con(c::distance(&p[1], &p[2], h));
            generated(name, fam, Intent::Under, Some(2), None, b.s)
        }
        3 | 4 => {
            hv(&mut b);
            b.con(c::distance(&p[0], &p[1], w));
            b.con(c::distance(&p[1], &p[2], h));
            b.fix(&p[0]);
            if set == 3 {
                generated(name, fam, Intent::Fully, Some(0), None, b.s)
            } else {
                // A reference dimension changes nothing.
                let id = format!("k{}", b.s.constraints.len());
                b.s.constraints.push(
                    Constraint::new(id, c::distance(&p[0], &p[2], dist(corners[0], corners[2])))
                        .reference(),
                );
                generated(name, fam, Intent::Fully, Some(0), None, b.s)
            }
        }
        5 => {
            // Rotated: parallel/perpendicular + an angle to a fixed reference line.
            let r0 = b.exact_point("ref0", [0.0, -100.0]);
            b.fixed();
            let r1 = b.exact_point("ref1", [10.0, -100.0]);
            b.fixed();
            let rl = b.line("ref", &r0, &r1);
            b.construction();
            b.con(c::parallel(&l[0], &l[2]));
            b.con(c::parallel(&l[1], &l[3]));
            b.con(c::perpendicular(&l[0], &l[1]));
            b.con(c::distance(&p[0], &p[1], w));
            b.con(c::distance(&p[1], &p[2], h));
            b.fix(&p[0]);
            b.con(c::angle(&rl, &l[0], math::rad_to_deg(th)));
            generated(name, fam, Intent::Fully, Some(0), None, b.s)
        }
        6 => {
            // Square: equal sides.
            hv(&mut b);
            b.con(c::equal(&l[0], &l[1]));
            b.con(c::distance(&p[0], &p[1], w));
            b.fix(&p[0]);
            generated(name, fam, Intent::Fully, Some(0), None, b.s)
        }
        _ => {
            // Fully constrained plus one extra constraint: redundant or conflicting.
            hv(&mut b);
            let d01 = b.con(c::distance(&p[0], &p[1], w));
            let d12 = b.con(c::distance(&p[1], &p[2], h));
            b.fix(&p[0]);
            let k = b.rng.below(8);
            let (intent, conflict) = match k {
                0 => {
                    b.con(c::parallel(&l[0], &l[2]));
                    (Intent::Redundant, None)
                }
                1 => {
                    b.con(c::distance(&p[3], &p[2], w));
                    (Intent::Redundant, None)
                }
                2 => {
                    b.con(c::perpendicular(&l[0], &l[1]));
                    (Intent::Redundant, None)
                }
                3 => {
                    b.con(c::equal(&l[0], &l[2]));
                    (Intent::Redundant, None)
                }
                4 => {
                    let d = w + b.rng.range(1.0, 5.0);
                    b.con(c::distance(&p[0], &p[1], d));
                    (Intent::Conflict, Some(vec![d01.clone()]))
                }
                5 => {
                    let a = b.rng.range(60.0, 85.0);
                    b.con(c::angle(&l[0], &l[1], a));
                    (Intent::Conflict, None)
                }
                6 => {
                    let d = h + b.rng.range(1.0, 5.0);
                    b.con(c::distance(&p[1], &p[2], d));
                    (Intent::Conflict, Some(vec![d12.clone()]))
                }
                _ => {
                    let dd = dist(corners[0], corners[2]) + b.rng.range(1.0, 5.0);
                    b.con(c::distance(&p[0], &p[2], dd));
                    (Intent::Conflict, None)
                }
            };
            // For duplicated dimensions the minimal set is exactly {old, new}.
            let conflict = conflict.map(|mut v| {
                v.push(format!("k{}", b.s.constraints.len() - 1));
                v
            });
            let dof = if intent == Intent::Redundant {
                Some(0)
            } else {
                None
            };
            generated(format!("{name}/{k}"), fam, intent, dof, conflict, b.s)
        }
    }
}

/// Slot variants.
pub const SLOT_VARIANTS: usize = 10;

/// A slot: two lines tangent to two end arcs. `variant % 2 == 1` uses separate line
/// endpoints with coincident constraints.
pub fn slot(seed: u64, variant: usize) -> Generated {
    let mut rng = Rng::new(seed);
    let c1 = [rng.range(-40.0, 40.0), rng.range(-40.0, 40.0)];
    let len = rng.range(10.0, 60.0);
    let r = rng.range(2.0, 15.0);
    let set = (variant / 2) % 5;
    let separate = variant % 2 == 1;
    let th = if set == 2 { rng.range(0.2, 1.3) } else { 0.0 };
    let (s, co) = math::sin_cos(th);
    let u = [co, s];
    let nrm = [-s, co];
    let c2 = [c1[0] + len * u[0], c1[1] + len * u[1]];
    let at = |c: [f64; 2], k: f64| [c[0] + k * r * nrm[0], c[1] + k * r * nrm[1]];
    let noise = 0.02 * r;
    let mut b = B::new(&mut rng, noise);
    let pc1 = b.point("c1", c1);
    let pc2 = b.point("c2", c2);
    let t1 = b.point("t1", at(c1, 1.0));
    let t2 = b.point("t2", at(c2, 1.0));
    let b1 = b.point("b1", at(c1, -1.0));
    let b2 = b.point("b2", at(c2, -1.0));
    let a1 = b.arc("A1", &pc1, &t1, &b1);
    let a2 = b.arc("A2", &pc2, &b2, &t2);
    let (lt, lb) = if separate {
        let lt1 = b.point("lt1", at(c1, 1.0));
        let lt2 = b.point("lt2", at(c2, 1.0));
        let lb1 = b.point("lb1", at(c1, -1.0));
        let lb2 = b.point("lb2", at(c2, -1.0));
        let lt = b.line("Lt", &lt1, &lt2);
        let lb = b.line("Lb", &lb1, &lb2);
        b.con(c::coincident(&lt1, &t1));
        b.con(c::coincident(&lt2, &t2));
        b.con(c::coincident(&lb1, &b1));
        b.con(c::coincident(&lb2, &b2));
        (lt, lb)
    } else {
        (b.line("Lt", &t1, &t2), b.line("Lb", &b1, &b2))
    };
    b.con(c::tangent(&lt, &a1));
    b.con(c::tangent(&lt, &a2));
    b.con(c::tangent(&lb, &a1));
    b.con(c::tangent(&lb, &a2));
    let eq = b.con(c::equal(&a1, &a2));
    let name = format!("slot/{variant}/{seed}");
    let fam = "slot";
    if set == 0 {
        return generated(name, fam, Intent::Under, Some(5), None, b.s);
    }
    let rad = b.con(c::radius(&a1, r));
    b.con(c::distance(&pc1, &pc2, len));
    b.fix(&pc1);
    if th == 0.0 {
        let ax = b.line("axis", &pc1, &pc2);
        b.construction();
        b.con(c::horizontal(&ax));
    } else {
        let r0 = b.exact_point("ref0", [0.0, -100.0]);
        b.fixed();
        let r1 = b.exact_point("ref1", [10.0, -100.0]);
        b.fixed();
        let rl = b.line("ref", &r0, &r1);
        b.construction();
        let ax = b.line("axis", &pc1, &pc2);
        b.construction();
        b.con(c::angle(&rl, &ax, math::rad_to_deg(th)));
    }
    match set {
        1 | 2 => generated(name, fam, Intent::Fully, Some(0), None, b.s),
        3 => {
            match b.rng.below(3) {
                0 => b.con(c::parallel(&lt, &lb)),
                1 => b.con(c::equal(&lt, &lb)),
                _ => b.con(c::distance(&t1, &t2, len)),
            };
            generated(name, fam, Intent::Redundant, Some(0), None, b.s)
        }
        _ => {
            let (intent, conflict) = if b.rng.chance(0.5) {
                let v = r + b.rng.range(0.5, 3.0);
                let k = b.con(c::radius(&a2, v));
                (Intent::Conflict, Some(vec![eq, rad, k]))
            } else {
                let v = len + b.rng.range(1.0, 5.0);
                b.con(c::distance(&t1, &t2, v));
                (Intent::Conflict, None)
            };
            generated(name, fam, intent, None, conflict, b.s)
        }
    }
}

/// Bolt-circle variants.
pub const BOLT_VARIANTS: usize = 6;

/// A bolt circle: `n` equal holes on a construction circle, equally spaced by angles.
pub fn bolt_circle(seed: u64, variant: usize) -> Generated {
    let mut rng = Rng::new(seed);
    let n = 3 + rng.below(6);
    let ctr = [rng.range(-30.0, 30.0), rng.range(-30.0, 30.0)];
    let big = rng.range(20.0, 60.0);
    let hole = rng.range(1.0, 0.8 * big * math::sin(math::PI / n as f64));
    let phi0 = 0.0;
    let step = 360.0 / n as f64;
    let noise = 0.01 * big;
    let mut b = B::new(&mut rng, noise);
    let pc = b.point("C", ctr);
    let bc = b.circle("BC", &pc, big);
    b.construction();
    let mut holes = Vec::new();
    let mut spokes = Vec::new();
    for i in 0..n {
        let a = math::deg_to_rad(phi0 + step * i as f64);
        let (s, co) = math::sin_cos(a);
        let hc = b.point(&format!("h{i}"), [ctr[0] + big * co, ctr[1] + big * s]);
        holes.push(b.circle(&format!("H{i}"), &hc, hole));
        spokes.push(b.line(&format!("S{i}"), &pc, &hc));
        b.construction();
    }
    let set = variant % BOLT_VARIANTS;
    b.fix(&pc);
    b.con(c::radius(&bc, big));
    for i in 0..n {
        let hc = format!("h{i}");
        b.con(c::point_on_circle(&hc, &bc));
    }
    let mut eqs = Vec::new();
    for i in 1..n {
        eqs.push(b.con(c::equal(&holes[0], &holes[i])));
    }
    let r0 = if set == 1 {
        None
    } else {
        Some(b.con(c::radius(&holes[0], hole)))
    };
    if set != 2 {
        b.con(c::horizontal(&spokes[0]));
    }
    let mut angles = Vec::new();
    for i in 0..n - 1 {
        angles.push(b.con(c::angle(&spokes[i], &spokes[i + 1], step)));
    }
    let name = format!("bolt_circle/{variant}/{seed}/n{n}");
    let fam = "bolt_circle";
    match set {
        0 => generated(name, fam, Intent::Fully, Some(0), None, b.s),
        1 | 2 => generated(name, fam, Intent::Under, Some(1), None, b.s),
        3 => {
            b.con(c::angle(&spokes[n - 1], &spokes[0], step));
            generated(name, fam, Intent::Redundant, Some(0), None, b.s)
        }
        4 => {
            let v = step + b.rng.range(2.0, 8.0);
            let k = b.con(c::angle(&spokes[n - 1], &spokes[0], v));
            let mut set: Vec<String> = angles.clone();
            set.push(k);
            generated(name, fam, Intent::Conflict, None, Some(set), b.s)
        }
        _ => {
            let v = hole + b.rng.range(0.3, 1.0);
            let k = b.con(c::radius(&holes[n - 1], v));
            let set = vec![eqs[n - 2].clone(), r0.expect("radius of hole 0"), k];
            generated(name, fam, Intent::Conflict, None, Some(set), b.s)
        }
    }
}

/// Rounded-rectangle variants.
pub const ROUNDED_VARIANTS: usize = 4;

/// A rectangle with four tangent corner arcs (lines tangent to arcs at shared points).
pub fn rounded_rect(seed: u64, variant: usize) -> Generated {
    let mut rng = Rng::new(seed);
    let o = [rng.range(-40.0, 40.0), rng.range(-40.0, 40.0)];
    let (w, h) = (rng.range(20.0, 80.0), rng.range(20.0, 80.0));
    let r = rng.range(1.0, 0.3 * w.min(h));
    let noise = 0.01 * r;
    let mut b = B::new(&mut rng, noise);
    // Arc centers (inset by r), counter-clockwise from the bottom-right corner; corner i's
    // arc turns from direction dirs[i] to dirs[i + 1].
    let cs = [
        [o[0] + w - r, o[1] + r],
        [o[0] + w - r, o[1] + h - r],
        [o[0] + r, o[1] + h - r],
        [o[0] + r, o[1] + r],
    ];
    let dirs = [[0.0, -1.0], [1.0, 0.0], [0.0, 1.0], [-1.0, 0.0]];
    let cp: Vec<String> = (0..4).map(|i| b.point(&format!("c{i}"), cs[i])).collect();
    // For corner i the arc runs from direction dirs[i] to dirs[i+1] (counter-clockwise).
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    for i in 0..4 {
        let d0 = dirs[i];
        let d1 = dirs[(i + 1) % 4];
        starts.push(b.point(
            &format!("s{i}"),
            [cs[i][0] + r * d0[0], cs[i][1] + r * d0[1]],
        ));
        ends.push(b.point(
            &format!("e{i}"),
            [cs[i][0] + r * d1[0], cs[i][1] + r * d1[1]],
        ));
    }
    let arcs: Vec<String> = (0..4)
        .map(|i| b.arc(&format!("A{i}"), &cp[i], &starts[i], &ends[i]))
        .collect();
    // Side i runs from the end of arc i to the start of arc i+1.
    let lines: Vec<String> = (0..4)
        .map(|i| b.line(&format!("L{i}"), &ends[i], &starts[(i + 1) % 4]))
        .collect();
    for i in 0..4 {
        b.con(c::tangent(&lines[i], &arcs[i]));
        b.con(c::tangent(&lines[i], &arcs[(i + 1) % 4]));
    }
    let equals: Vec<String> = (1..4)
        .map(|i| b.con(c::equal(&arcs[0], &arcs[i])))
        .collect();
    // Sides: L0 right (vertical), L1 top (horizontal), L2 left, L3 bottom.
    b.con(c::vertical(&lines[0]));
    b.con(c::horizontal(&lines[1]));
    b.con(c::vertical(&lines[2]));
    b.con(c::horizontal(&lines[3]));
    let name = format!("rounded_rect/{variant}/{seed}");
    let fam = "rounded_rect";
    let set = variant % ROUNDED_VARIANTS;
    if set == 0 {
        return generated(name, fam, Intent::Under, Some(5), None, b.s);
    }
    let rad = b.con(c::radius(&arcs[0], r));
    b.con(c::distance(&cp[0], &cp[1], h - 2.0 * r));
    b.con(c::distance(&cp[1], &cp[2], w - 2.0 * r));
    b.fix(&cp[0]);
    match set {
        1 => generated(name, fam, Intent::Fully, Some(0), None, b.s),
        2 => {
            b.con(c::distance(&cp[3], &cp[2], h - 2.0 * r));
            generated(name, fam, Intent::Redundant, Some(0), None, b.s)
        }
        _ => {
            let v = 2.0 * r + b.rng.range(0.5, 2.0);
            let k = b.con(c::diameter(&arcs[2], v));
            // radius(A0) + equal(A0, A2) contradict the diameter of A2.
            let set = vec![equals[1].clone(), rad, k];
            generated(name, fam, Intent::Conflict, None, Some(set), b.s)
        }
    }
}

/// Arc-chain variants.
pub const ARC_CHAIN_VARIANTS: usize = 4;

/// Two arcs meeting tangentially at a shared point (an S-curve), arc–arc tangency.
pub fn arc_chain(seed: u64, variant: usize) -> Generated {
    let mut rng = Rng::new(seed);
    let c1 = [rng.range(-20.0, 20.0), rng.range(-20.0, 20.0)];
    let (r1, r2) = (rng.range(5.0, 30.0), rng.range(5.0, 30.0));
    let a0 = rng.range(0.0, 1.0);
    let a1 = a0 + rng.range(0.6, 1.8);
    let g = rng.range(0.6, 1.5);
    let u = [math::cos(a1), math::sin(a1)];
    let c2 = [c1[0] + (r1 + r2) * u[0], c1[1] + (r1 + r2) * u[1]];
    let s1 = [c1[0] + r1 * math::cos(a0), c1[1] + r1 * math::sin(a0)];
    let m = [c1[0] + r1 * u[0], c1[1] + r1 * u[1]];
    let ae = a1 + math::PI - g;
    let e = [c2[0] + r2 * math::cos(ae), c2[1] + r2 * math::sin(ae)];
    let noise = 0.01 * r1.min(r2);
    let mut b = B::new(&mut rng, noise);
    let pc1 = b.point("c1", c1);
    let ps = b.point("s", s1);
    let pm = b.point("m", m);
    let pc2 = b.point("c2", c2);
    let pe = b.point("e", e);
    let arc1 = b.arc("A1", &pc1, &ps, &pm);
    // The second arc runs clockwise in the drawing, i.e. counter-clockwise from e to m.
    let arc2 = b.arc("A2", &pc2, &pe, &pm);
    b.con(c::tangent(&arc1, &arc2));
    let name = format!("arc_chain/{variant}/{seed}");
    let fam = "arc_chain";
    let set = variant % ARC_CHAIN_VARIANTS;
    if set == 0 {
        return generated(name, fam, Intent::Under, Some(7), None, b.s);
    }
    b.fix(&pc1);
    b.fix(&ps);
    b.con(c::radius(&arc2, r2));
    b.con(c::distance(&ps, &pm, dist(s1, m)));
    b.con(c::distance(&pm, &pe, dist(m, e)));
    match set {
        1 => generated(name, fam, Intent::Fully, Some(0), None, b.s),
        2 => {
            b.con(c::distance(&pc1, &pc2, r1 + r2));
            generated(name, fam, Intent::Redundant, Some(0), None, b.s)
        }
        _ => {
            let v = r1 + b.rng.range(1.0, 3.0);
            b.con(c::radius(&arc1, v));
            generated(name, fam, Intent::Conflict, None, None, b.s)
        }
    }
}

/// A random convex polygon with a random subset of dimensions measured on the ground
/// truth (consistent, often redundant); with `conflict`, one value is then perturbed.
pub fn polygon(seed: u64, conflict: bool) -> Generated {
    let mut rng = Rng::new(seed);
    let k = 3 + rng.below(4);
    let ctr = [rng.range(-30.0, 30.0), rng.range(-30.0, 30.0)];
    let rad = rng.range(15.0, 50.0);
    let mut pts = Vec::new();
    for i in 0..k {
        let a = (i as f64 + rng.range(-0.25, 0.25)) * math::TAU / k as f64;
        let rr = rad * rng.range(0.7, 1.0);
        pts.push([ctr[0] + rr * math::cos(a), ctr[1] + rr * math::sin(a)]);
    }
    let horizontal0 = rng.chance(0.5);
    if horizontal0 {
        pts[1][1] = pts[0][1];
    }
    let noise = 0.01 * rad;
    let mut b = B::new(&mut rng, noise);
    let p: Vec<String> = (0..k).map(|i| b.point(&format!("p{i}"), pts[i])).collect();
    let l: Vec<String> = (0..k)
        .map(|i| b.line(&format!("L{i}"), &p[i], &p[(i + 1) % k]))
        .collect();
    if horizontal0 {
        b.con(c::horizontal(&l[0]));
    }
    let ncon = 2 + b.rng.below(2 * k + 2);
    let mut dims = Vec::new();
    for _ in 0..ncon {
        match b.rng.below(6) {
            0..=2 => {
                let i = b.rng.below(k);
                let mut j = b.rng.below(k);
                if j == i {
                    j = (i + 1) % k;
                }
                dims.push(b.con(c::distance(&p[i], &p[j], dist(pts[i], pts[j]))));
            }
            3 => {
                let i = b.rng.below(k);
                let mut j = b.rng.below(k);
                if j == i {
                    j = (i + 1) % k;
                }
                let (u, v) = (
                    [
                        pts[(i + 1) % k][0] - pts[i][0],
                        pts[(i + 1) % k][1] - pts[i][1],
                    ],
                    [
                        pts[(j + 1) % k][0] - pts[j][0],
                        pts[(j + 1) % k][1] - pts[j][1],
                    ],
                );
                let ang = math::rad_to_deg(math::atan2(
                    u[0] * v[1] - u[1] * v[0],
                    u[0] * v[0] + u[1] * v[1],
                ));
                dims.push(b.con(c::angle(&l[i], &l[j], ang)));
            }
            4 => {
                let i = b.rng.below(k);
                b.fix(&p[i]);
            }
            _ => {
                // Distance from a vertex to a non-adjacent edge line.
                let i = b.rng.below(k);
                let j = (i + 1 + b.rng.below(k.max(3) - 2)) % k;
                if j != i && (j + 1) % k != i {
                    let (a, e) = (pts[j], pts[(j + 1) % k]);
                    let d = ((e[0] - a[0]) * (pts[i][1] - a[1])
                        - (e[1] - a[1]) * (pts[i][0] - a[0]))
                        .abs()
                        / dist(a, e);
                    if d > 1e-3 {
                        dims.push(b.con(c::distance(&p[i], &l[j], d)));
                    }
                }
            }
        }
    }
    let mut intent = Intent::Under;
    if conflict && !dims.is_empty() {
        let pick = dims[b.rng.below(dims.len())].clone();
        let bump = b.rng.range(1.0, 4.0);
        let delta = b.rng.range(0.15, 0.4);
        for con in &mut b.s.constraints {
            if con.id == pick {
                match &mut con.kind {
                    ConstraintKind::Distance { value, .. } => *value += bump,
                    ConstraintKind::Angle { value, .. } => *value += math::rad_to_deg(delta),
                    _ => {}
                }
            }
        }
        intent = Intent::Conflict;
    }
    let name = format!("polygon/{}/{seed}/k{k}", if conflict { "c" } else { "ok" });
    generated(name, "polygon", intent, None, None, b.s)
}

/// The oracle / property corpus: `count` sketches cycling through all families.
pub fn corpus(seed: u64, count: usize) -> Vec<Generated> {
    let mut rng = Rng::new(seed);
    (0..count)
        .map(|i| {
            let s = rng.next_u64();
            match i % 8 {
                0 | 1 => rectangle(s, rng.below(RECT_VARIANTS)),
                2 => slot(s, rng.below(SLOT_VARIANTS)),
                3 => bolt_circle(s, rng.below(BOLT_VARIANTS)),
                4 => rounded_rect(s, rng.below(ROUNDED_VARIANTS)),
                5 => arc_chain(s, rng.below(ARC_CHAIN_VARIANTS)),
                6 => polygon(s, false),
                _ => polygon(s, rng.chance(0.5)),
            }
        })
        .collect()
}

/// A single-cluster benchmark sketch with about `entities` entities: a crenellated,
/// rectilinear outline (alternating horizontal/vertical lines with length dimensions)
/// plus circular holes, each located by two distances to outline vertices and a radius.
///
/// With `fully`, the first vertex is fixed and every edge but one horizontal and one
/// vertical (closure) is dimensioned: 0 DOF. Otherwise the fix and every 7th dimension
/// are left out, so drags move geometry.
pub fn benchmark(entities: usize, fully: bool) -> Sketch {
    // entities = 2k (vertices + edges) + 2h (hole centers + circles), k = 4T + 2.
    let teeth = ((entities as f64 / 3.0 - 2.0) / 4.0).round().max(1.0) as usize;
    let (a, depth, height) = (6.0, 4.0, 40.0);
    let mut pts: Vec<[f64; 2]> = vec![[0.0, 0.0]];
    let mut x = 0.0;
    for t in 0..teeth {
        pts.push([x + a, 0.0]);
        pts.push([x + a, -depth]);
        pts.push([x + 2.0 * a, -depth]);
        if t + 1 < teeth {
            pts.push([x + 2.0 * a, 0.0]);
        }
        x += 2.0 * a;
    }
    pts.push([x, height]);
    pts.push([0.0, height]);
    let k = pts.len();
    let holes = (entities.saturating_sub(2 * k) / 2).max(1);
    let mut rng = Rng::new(0xB0B0 + entities as u64);
    let mut b = B::new(&mut rng, 0.2);
    let v: Vec<String> = (0..k).map(|i| b.point(&format!("v{i}"), pts[i])).collect();
    let e: Vec<String> = (0..k)
        .map(|i| b.line(&format!("E{i}"), &v[i], &v[(i + 1) % k]))
        .collect();
    // The outline is built from exact coordinates: an edge is horizontal iff its end
    // y-coordinates are bitwise equal.
    let horizontal = |i: usize| pts[i][1].total_cmp(&pts[(i + 1) % k][1]).is_eq();
    for (i, edge) in e.iter().enumerate() {
        if horizontal(i) {
            b.con(c::horizontal(edge));
        } else {
            b.con(c::vertical(edge));
        }
    }
    let (mut skipped_h, mut skipped_v) = (false, false);
    for i in 0..k {
        let skip = if horizontal(i) {
            &mut skipped_h
        } else {
            &mut skipped_v
        };
        if !*skip {
            *skip = true;
            continue;
        }
        if !fully && i % 7 == 3 {
            continue;
        }
        b.con(c::distance(
            &v[i],
            &v[(i + 1) % k],
            dist(pts[i], pts[(i + 1) % k]),
        ));
    }
    if fully {
        b.fix(&v[0]);
    }
    let top = [k - 2, k - 1];
    for j in 0..holes {
        let va = (2 * j + 1) % (k - 2);
        let vb = top[j % 2];
        let ctr = [pts[va][0] + 2.0, 8.0 + 6.0 * (j % 4) as f64];
        let cc = b.point(&format!("hc{j}"), ctr);
        let ci = b.circle(&format!("H{j}"), &cc, 1.5);
        b.con(c::radius(&ci, 1.5));
        b.con(c::distance(&cc, &v[va], dist(ctr, pts[va])));
        b.con(c::distance(&cc, &v[vb], dist(ctr, pts[vb])));
    }
    b.s
}
