//! The F2 robustness corpus (IR v1 plan, W6): deterministic random prismatic parts — boxes,
//! plates with holes, bosses, slots, pockets, L-blocks, **obstacles** (holes, cross holes,
//! tunnels and bosses closer to the blended edge than the blend reaches) and **oblique
//! prisms** (triangles, hexagons, wedges: corners whose faces are not perpendicular) — with a
//! fillet, chamfer or shell each ([`cases`]); and the **curved** families ([`curved_cases`],
//! W6 review round 2): shafts with a D-flat (line edges between a plane and a cylinder),
//! crossing holes (B-spline intersection edges) and spherical dimples and domes (circle
//! edges between a plane and a sphere; W6 review round 3: Forge blends the D-flat's and the
//! sphere's analytic pairs, the cross holes and the D-flat's corners still measure what it
//! does not). Bases are sequences of IR v0 operands (one sketch + one extrude each) combined by
//! booleans, so that the OCCT oracle rebuilds them independently
//! (`forge-blend/oracle/occt_blend_diff.py`). Edges and faces are chosen on Forge's base by
//! geometric predicates and handed to the oracle as probes.

use forge_blend::Convexity;
use forge_core::geom::Curve3;
use forge_core::linalg::Point3;
use forge_core::topo::{Body, EdgeId, FaceId};
use forge_ops::boolean::BodyOp;
use forge_ops::boolean::corpus::{Operand, Rng};

use super::{boolean, circle, polygon, prism_op, rect, slot, xy};
use forge_ir::{Frame, PlaneSpec};

/// How a step combines its operand with the body so far.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepOp {
    New,
    Join,
    Cut,
}

impl StepOp {
    pub fn name(self) -> &'static str {
        match self {
            StepOp::New => "new",
            StepOp::Join => "join",
            StepOp::Cut => "cut",
        }
    }
}

/// The operation of a case.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CaseOp {
    Fillet { r: f64 },
    Chamfer { d: f64 },
    Chamfer2 { d: f64, d2: f64 },
    ChamferAngle { d: f64, angle: f64 },
    Shell { t: f64, outward: bool },
}

/// One corpus case.
#[derive(Clone, Debug)]
pub struct Case {
    pub id: String,
    pub family: &'static str,
    pub steps: Vec<(StepOp, Operand)>,
    /// Blends applied (by Forge, and by the oracle with OCCT) before `op` — the maker
    /// sequences (fillet → shell, fillet → fillet; W6 review round 4).
    pub pre: Vec<PreOp>,
    pub op: CaseOp,
    /// Selection rule (resolved on the built base).
    pub select: &'static str,
    /// Seed for the random parts of the selection.
    pub pick: u64,
    /// The family's closed form of the result's volume, when it has one (an independent
    /// reference for the oracle, written from the geometry, not from Forge).
    pub closed: Option<ClosedForm>,
}

/// A blend applied before a case's operation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PreOp {
    pub op: CaseOp,
    pub select: &'static str,
}

/// Closed forms of the sequence families' results.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ClosedForm {
    /// Box `a × b × c`, its vertical edges rounded by `rv`, then its bottom edge loop by `rb`
    /// (the case's own fillet when that is the operation).
    Enclosure {
        a: f64,
        b: f64,
        c: f64,
        rv: f64,
        rb: f64,
    },
    /// Box `a × b × c` with all twelve edges rounded by `r`.
    RoundedBox { a: f64, b: f64, c: f64, r: f64 },
}

impl Case {
    /// The body the operation applies to: the base with the `pre` blends (Forge's).
    pub fn prepared(&self) -> Result<Body, forge_blend::BlendError> {
        let mut b = self.base();
        for k in 0..self.pre.len() {
            b = self.apply_pre(k, &b)?.1;
        }
        Ok(b)
    }

    /// The `k`-th `pre` blend on `b`: its edges (on `b`) and the result.
    pub fn apply_pre(
        &self,
        k: usize,
        b: &Body,
    ) -> Result<(Vec<EdgeId>, Body), forge_blend::BlendError> {
        let p = self.pre[k];
        let edges = select_edges_by(p.select, self.pick, b);
        let opts = forge_blend::BlendOptions::new(format!("p{k}"));
        let picks = forge_blend::pick_edges(b, 0, &edges);
        let out = match p.op {
            CaseOp::Fillet { r } => forge_blend::fillet(b, &picks, r, &opts)?,
            CaseOp::Chamfer { d } => {
                forge_blend::chamfer(b, &picks, &forge_blend::ChamferSpec::Equal { d }, &opts)?
            }
            other => panic!("pre-op {other:?}"),
        };
        Ok((edges, out.body))
    }

    pub fn base(&self) -> Body {
        let mut body: Option<Body> = None;
        for (k, (op, operand)) in self.steps.iter().enumerate() {
            let b = operand.build().expect("operand");
            body = Some(match (op, body) {
                (StepOp::New, _) => b,
                (StepOp::Join, Some(t)) => boolean(t, b, BodyOp::Join, &format!("b{k}")),
                (StepOp::Cut, Some(t)) => boolean(t, b, BodyOp::Cut, &format!("b{k}")),
                _ => panic!("first step must be new"),
            });
        }
        body.expect("steps")
    }
}

/// Midpoint of an edge (at its middle parameter).
pub fn edge_mid(b: &Body, e: EdgeId) -> Point3 {
    let e = b.edge(e).expect("edge");
    e.curve.eval(0.5 * (e.t_range.0 + e.t_range.1))
}

fn bbox(b: &Body) -> (Point3, Point3) {
    let mut lo = Point3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY);
    let mut hi = -lo;
    for (_, v) in b.vertices().iter() {
        lo = lo.min_components(v.point);
        hi = hi.max_components(v.point);
    }
    for (_, e) in b.edges().iter() {
        for k in 0..=16 {
            let p = e
                .curve
                .eval(e.t_range.0 + (e.t_range.1 - e.t_range.0) * k as f64 / 16.0);
            lo = lo.min_components(p);
            hi = hi.max_components(p);
        }
    }
    (lo, hi)
}

fn is_line(b: &Body, e: EdgeId) -> bool {
    matches!(b.edge(e).expect("edge").curve, Curve3::Line(_))
}

fn is_circle(b: &Body, e: EdgeId) -> bool {
    matches!(b.edge(e).expect("edge").curve, Curve3::Circle(_))
}

fn vertical(b: &Body, e: EdgeId) -> bool {
    match &b.edge(e).expect("edge").curve {
        Curve3::Line(l) => l.dir().z.abs() > 1.0 - 1e-12,
        _ => false,
    }
}

/// Non-smooth edges only (smooth ones cannot be blended).
fn blendable(b: &Body) -> Vec<EdgeId> {
    b.edges()
        .iter()
        .map(|(id, _)| id)
        .filter(|&e| {
            matches!(
                forge_blend::edge_convexity(b, e),
                Some(Convexity::Convex | Convexity::Concave)
            )
        })
        .collect()
}

fn conv(b: &Body, e: EdgeId) -> Option<Convexity> {
    forge_blend::edge_convexity(b, e)
}

/// The edges a selection rule picks on `b`.
pub fn select_edges(case: &Case, b: &Body) -> Vec<EdgeId> {
    select_edges_by(case.select, case.pick, b)
}

/// The edges selection rule `select` picks on `b` (random parts seeded by `pick`).
pub fn select_edges_by(select: &str, pick: u64, b: &Body) -> Vec<EdgeId> {
    let mut rng = Rng::new(pick);
    let (lo, hi) = bbox(b);
    let top = |e: EdgeId| (edge_mid(b, e).z - hi.z).abs() < 1e-9;
    let bottom = |e: EdgeId| (edge_mid(b, e).z - lo.z).abs() < 1e-9;
    let all = blendable(b);
    let pick_one = |rng: &mut Rng, v: &[EdgeId]| -> Vec<EdgeId> {
        if v.is_empty() {
            vec![]
        } else {
            vec![v[rng.below(v.len())]]
        }
    };
    let at_vertex = |rng: &mut Rng, k: usize| -> Vec<EdgeId> {
        let vs: Vec<_> = b.vertices().iter().map(|(id, _)| id).collect();
        let v = vs[rng.below(vs.len())];
        let mut es: Vec<EdgeId> = b
            .edges()
            .iter()
            .filter(|(_, e)| e.start == Some(v) || e.end == Some(v))
            .map(|(id, _)| id)
            .filter(|e| all.contains(e))
            .collect();
        es.truncate(k);
        es
    };
    let sel: Vec<EdgeId> = match select {
        "one" => pick_one(&mut rng, &all),
        // The first line edge at the bottom (its tangent chain does the rest).
        "bottom_one" => all
            .iter()
            .copied()
            .filter(|&e| bottom(e) && is_line(b, e))
            .take(1)
            .collect(),
        "corner2" => at_vertex(&mut rng, 2),
        "corner3" => at_vertex(&mut rng, 3),
        "top" => all.iter().copied().filter(|&e| top(e)).collect(),
        "bottom" => all.iter().copied().filter(|&e| bottom(e)).collect(),
        "vertical" => all.iter().copied().filter(|&e| vertical(b, e)).collect(),
        "all" => all.clone(),
        "random" => {
            let k = 1 + rng.below(all.len().min(5));
            let mut v = all.clone();
            let mut out = Vec::new();
            for _ in 0..k {
                if v.is_empty() {
                    break;
                }
                out.push(v.remove(rng.below(v.len())));
            }
            out
        }
        "front_top" => all
            .iter()
            .copied()
            .filter(|&e| is_line(b, e) && top(e) && (edge_mid(b, e).y - lo.y).abs() < 1e-9)
            .collect(),
        "circles" => all.iter().copied().filter(|&e| is_circle(b, e)).collect(),
        "circles_top" => all
            .iter()
            .copied()
            .filter(|&e| is_circle(b, e) && top(e))
            .collect(),
        "one_circle" => {
            let c: Vec<_> = all.iter().copied().filter(|&e| is_circle(b, e)).collect();
            pick_one(&mut rng, &c)
        }
        "convex" => all
            .iter()
            .copied()
            .filter(|&e| conv(b, e) == Some(Convexity::Convex))
            .collect(),
        "concave" => all
            .iter()
            .copied()
            .filter(|&e| conv(b, e) == Some(Convexity::Concave))
            .collect(),
        "concave_lines" => all
            .iter()
            .copied()
            .filter(|&e| conv(b, e) == Some(Convexity::Concave) && is_line(b, e))
            .collect(),
        "outer_top" => all
            .iter()
            .copied()
            .filter(|&e| {
                let m = edge_mid(b, e);
                top(e)
                    && is_line(b, e)
                    && ((m.x - lo.x).abs() < 1e-9
                        || (m.x - hi.x).abs() < 1e-9
                        || (m.y - lo.y).abs() < 1e-9
                        || (m.y - hi.y).abs() < 1e-9)
            })
            .collect(),
        "inner_top" => {
            // One convex top edge not on the outline (a slot or pocket rim); the chain does
            // the rest.
            let c: Vec<_> = all
                .iter()
                .copied()
                .filter(|&e| {
                    let m = edge_mid(b, e);
                    top(e)
                        && (m.x - lo.x).abs() > 1e-9
                        && (m.x - hi.x).abs() > 1e-9
                        && (m.y - lo.y).abs() > 1e-9
                        && (m.y - hi.y).abs() > 1e-9
                })
                .collect();
            pick_one(&mut rng, &c)
        }
        other => panic!("unknown selection {other}"),
    };
    sel
}

/// The open faces of a shell case.
pub fn select_faces(case: &Case, b: &Body) -> Vec<FaceId> {
    let (lo, hi) = bbox(b);
    let at = |z: f64| -> Vec<FaceId> {
        b.faces()
            .iter()
            .filter(|(_, f)| match &f.surface {
                forge_core::geom::Surface::Plane(p) => {
                    p.frame().z().z.abs() > 1.0 - 1e-12 && (p.frame().origin().z - z).abs() < 1e-9
                }
                _ => false,
            })
            .map(|(id, _)| id)
            .collect()
    };
    match case.select {
        "open_top" => at(hi.z),
        "open_bottom" => at(lo.z),
        "open_top_bottom" => {
            let mut v = at(hi.z);
            v.extend(at(lo.z));
            v
        }
        "closed" => vec![],
        "open_side" => b
            .faces()
            .iter()
            .filter(|(_, f)| match &f.surface {
                forge_core::geom::Surface::Plane(p) => {
                    p.frame().z().x.abs() > 1.0 - 1e-12
                        && (p.frame().origin().x - lo.x).abs() < 1e-9
                }
                _ => false,
            })
            .map(|(id, _)| id)
            .collect(),
        other => panic!("unknown face selection {other}"),
    }
}

/// A ball of radius `r` centred at `c`, as a revolved half disc (one sketch + one sweep).
fn ball_op(feature: &str, c: [f64; 3], r: f64) -> Operand {
    let curves = vec![
        super::arc("a", [0.0, c[2] - r], [0.0, c[2] + r], [0.0, c[2]], true),
        super::line("x", [0.0, c[2] + r], [0.0, c[2] - r]),
    ];
    let mut op = prism_op(
        feature,
        frame([c[0], c[1], 0.0], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]),
        curves,
        1.0,
    );
    op.sweep = forge_ops::boolean::corpus::Sweep::Revolve {
        axis: forge_ir::SketchAxis {
            origin: [0.0, 0.0],
            direction: [0.0, 1.0],
        },
        angle: 360.0,
        direction: forge_ir::SweepDirection::Normal,
    };
    op
}

/// `n` cases of the curved families from `seed` (ids `s{seed}-c{i}-{family}`), round-robin:
/// a shaft with a D-flat, a block with crossing holes, a plate with a spherical dimple or
/// dome.
#[allow(clippy::type_complexity)]
pub fn curved_cases(seed: u64, n: usize) -> Vec<Case> {
    let mut rng = Rng::new(seed ^ 0x5eed_c0ed);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let pick = rng.next_u64();
        let shell = rng.below(6) == 0;
        let (family, steps, scale, sel_opts, shell_opts): (
            &'static str,
            Vec<(StepOp, Operand)>,
            f64,
            &[&'static str],
            &[&'static str],
        ) = match i % 3 {
            0 => {
                let r = g(&mut rng, 4.0, 15.0);
                let h = g(&mut rng, 6.0, 30.0);
                let f = g(&mut rng, 0.2 * r, 0.8 * r);
                let c = [r + 2.0, r + 2.0];
                let shaft = prism_op("shaft", xy(0.0), vec![circle("c", c, r)], h);
                let flat = prism_op(
                    "flat",
                    xy(-1.0),
                    rect(c[0] + r - f, c[1] - r - 1.0, f + 2.0, 2.0 * r + 2.0),
                    h + 2.0,
                );
                (
                    "dflat",
                    vec![(StepOp::New, shaft), (StepOp::Cut, flat)],
                    h.min(r - f / 2.0),
                    &["vertical", "top", "one", "all"],
                    &["open_top", "closed"],
                )
            }
            1 => {
                let w = g(&mut rng, 20.0, 50.0);
                let d = g(&mut rng, 20.0, 50.0);
                let h = g(&mut rng, 12.0, 30.0);
                let r1 = g(&mut rng, 2.0, (w.min(d) / 4.0).min(8.0));
                let r2 = g(&mut rng, 1.0, (h / 4.0).min(r1 * 1.5).max(1.0));
                let c = [(w / 2.0 * 2.0).round() / 2.0, (d / 2.0 * 2.0).round() / 2.0];
                let base = prism_op("base", xy(0.0), rect(0.0, 0.0, w, d), h);
                let v = prism_op("hv", xy(-1.0), vec![circle("c", c, r1)], h + 2.0);
                let x = prism_op(
                    "hx",
                    frame([-1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
                    vec![circle("c", [c[1], (h / 2.0 * 2.0).round() / 2.0], r2)],
                    w + 2.0,
                );
                (
                    "cross_hole",
                    vec![(StepOp::New, base), (StepOp::Cut, v), (StepOp::Cut, x)],
                    r1.min(r2).min(h / 4.0),
                    &["one", "circles", "all", "random"],
                    &["open_top", "closed"],
                )
            }
            _ => {
                let w = g(&mut rng, 20.0, 50.0);
                let d = g(&mut rng, 20.0, 50.0);
                let h = g(&mut rng, 6.0, 20.0);
                let rs = g(&mut rng, 3.0, (w.min(d) / 4.0).min(10.0));
                let depth = g(&mut rng, 1.0, (rs - 0.5).min(h - 1.0).max(1.0));
                let c = [(w / 2.0 * 2.0).round() / 2.0, (d / 2.0 * 2.0).round() / 2.0];
                let base = prism_op("base", xy(0.0), rect(0.0, 0.0, w, d), h);
                let dome = rng.below(2) == 0;
                let step = if dome {
                    // A dome standing `depth` above the top face.
                    (
                        StepOp::Join,
                        ball_op("ball", [c[0], c[1], h + depth - rs], rs),
                    )
                } else {
                    // A dimple `depth` deep.
                    (
                        StepOp::Cut,
                        ball_op("ball", [c[0], c[1], h - depth + rs], rs),
                    )
                };
                (
                    "sphere",
                    vec![(StepOp::New, base), step],
                    depth.min(h / 2.0),
                    &["circles", "one_circle", "top", "one"],
                    &["open_bottom", "closed"],
                )
            }
        };
        let (op, select) = if shell {
            let t = ((scale * rng.range(0.05, 0.6)) * 100.0).round() / 100.0;
            (
                CaseOp::Shell {
                    t: t.max(0.05),
                    outward: rng.below(4) == 0,
                },
                shell_opts[rng.below(shell_opts.len())],
            )
        } else {
            (
                fillet_or_chamfer(&mut rng, scale, true),
                sel_opts[rng.below(sel_opts.len())],
            )
        };
        out.push(Case {
            id: format!("s{seed}-c{i:03}-{family}"),
            family,
            steps,
            pre: Vec::new(),
            op,
            select,
            pick,
            closed: None,
        });
    }
    out
}

fn frame(origin: [f64; 3], normal: [f64; 3], x_dir: [f64; 3]) -> PlaneSpec {
    PlaneSpec::Frame(Frame {
        origin,
        normal,
        x_dir,
    })
}

fn g(rng: &mut Rng, lo: f64, hi: f64) -> f64 {
    rng.grid(lo, hi, 0.5)
}

fn plate(rng: &mut Rng, w: (f64, f64), d: (f64, f64), h: (f64, f64)) -> (f64, f64, f64, Operand) {
    let (w, d, h) = (g(rng, w.0, w.1), g(rng, d.0, d.1), g(rng, h.0, h.1));
    (w, d, h, prism_op("base", xy(0.0), rect(0.0, 0.0, w, d), h))
}

/// Up to `n` non-overlapping circles inside `[0, w] × [0, d]` with margin.
fn circles(rng: &mut Rng, n: usize, w: f64, d: f64, r: (f64, f64)) -> Vec<([f64; 2], f64)> {
    let mut out: Vec<([f64; 2], f64)> = Vec::new();
    for _ in 0..40 {
        if out.len() >= n {
            break;
        }
        let rr = g(rng, r.0, r.1);
        if 2.0 * rr + 2.0 > w.min(d) {
            continue;
        }
        let c = [
            g(rng, rr + 1.0, w - rr - 1.0),
            g(rng, rr + 1.0, d - rr - 1.0),
        ];
        if out
            .iter()
            .all(|(o, ro)| ((o[0] - c[0]).powi(2) + (o[1] - c[1]).powi(2)).sqrt() > ro + rr + 1.0)
        {
            out.push((c, rr));
        }
    }
    out
}

fn fillet_or_chamfer(rng: &mut Rng, scale: f64, chamfers: bool) -> CaseOp {
    let f = rng.range(0.03, 0.6);
    let v = (scale * f * 100.0).round() / 100.0;
    let v = v.max(0.05);
    if !chamfers || rng.below(3) != 0 {
        return CaseOp::Fillet { r: v };
    }
    match rng.below(4) {
        0 | 1 => CaseOp::Chamfer { d: v },
        2 => CaseOp::Chamfer2 {
            d: v,
            d2: ((v * rng.range(0.4, 1.6)) * 100.0).round() / 100.0,
        },
        _ => CaseOp::ChamferAngle {
            d: v,
            angle: (rng.range(20.0, 70.0) * 10.0).round() / 10.0,
        },
    }
}

/// `n` cases from `seed`, round-robin over the families.
#[allow(clippy::type_complexity)]
pub fn cases(seed: u64, n: usize) -> Vec<Case> {
    let mut rng = Rng::new(seed);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let kind = i % 9;
        let pick = rng.next_u64();
        let shell = rng.below(6) == 0;
        let (family, steps, scale, sel_opts, shell_opts): (
            &'static str,
            Vec<(StepOp, Operand)>,
            f64,
            &[&'static str],
            &[&'static str],
        ) = match kind {
            0 => {
                let (w, d, h, base) = plate(&mut rng, (4.0, 40.0), (4.0, 40.0), (4.0, 30.0));
                (
                    "box",
                    vec![(StepOp::New, base)],
                    w.min(d).min(h),
                    &[
                        "one", "corner2", "corner3", "top", "vertical", "all", "random",
                    ],
                    &["open_top", "closed", "open_top_bottom", "open_side"],
                )
            }
            1 => {
                let (w, d, h, base) = plate(&mut rng, (20.0, 60.0), (20.0, 50.0), (3.0, 12.0));
                let mut steps = vec![(StepOp::New, base)];
                let through = rng.below(3) != 0;
                let depth = g(&mut rng, 1.0, (h - 1.0).max(1.0));
                let k = 1 + rng.below(3);
                let cs = circles(&mut rng, k, w, d, (1.0, 6.0));
                let mut rmin = f64::INFINITY;
                for (k, (c, r)) in cs.iter().enumerate() {
                    rmin = rmin.min(*r);
                    let (z0, hh) = if through {
                        (-1.0, h + 2.0)
                    } else {
                        (h - depth, depth + 1.0)
                    };
                    steps.push((
                        StepOp::Cut,
                        prism_op(&format!("h{k}"), xy(z0), vec![circle("c", *c, *r)], hh),
                    ));
                }
                (
                    "plate_holes",
                    steps,
                    h.min(rmin * 2.0),
                    &[
                        "circles_top",
                        "one_circle",
                        "circles",
                        "outer_top",
                        "top",
                        "convex",
                    ],
                    &["open_top", "open_bottom", "closed"],
                )
            }
            2 => {
                let (w, d, h, base) = plate(&mut rng, (20.0, 60.0), (20.0, 50.0), (3.0, 10.0));
                let mut steps = vec![(StepOp::New, base)];
                let k = 1 + rng.below(2);
                let cs = circles(&mut rng, k, w, d, (1.5, 8.0));
                let bh = g(&mut rng, 2.0, 15.0);
                let mut rmin = f64::INFINITY;
                for (k, (c, r)) in cs.iter().enumerate() {
                    rmin = rmin.min(*r);
                    steps.push((
                        StepOp::Join,
                        prism_op(&format!("b{k}"), xy(h), vec![circle("c", *c, *r)], bh),
                    ));
                }
                (
                    "boss",
                    steps,
                    h.min(rmin).min(bh),
                    &[
                        "circles_top",
                        "concave",
                        "circles",
                        "one_circle",
                        "outer_top",
                    ],
                    &["open_bottom", "closed"],
                )
            }
            3 => {
                let (w, d, h, base) = plate(&mut rng, (24.0, 60.0), (16.0, 40.0), (3.0, 12.0));
                let r = g(&mut rng, 1.5, (d / 4.0).min(5.0));
                let len = g(&mut rng, 2.0, (w - 2.0 * r - 4.0).clamp(2.0, 15.0));
                let c = [(w / 2.0 * 2.0).round() / 2.0, (d / 2.0 * 2.0).round() / 2.0];
                let through = rng.below(2) == 0;
                let depth = g(&mut rng, 1.0, (h - 1.0).max(1.0));
                let (z0, hh) = if through {
                    (-1.0, h + 2.0)
                } else {
                    (h - depth, depth + 1.0)
                };
                let steps = vec![
                    (StepOp::New, base),
                    (StepOp::Cut, prism_op("slot", xy(z0), slot(c, len, r), hh)),
                ];
                (
                    "slot",
                    steps,
                    h.min(r),
                    &["inner_top", "concave", "outer_top", "top"],
                    &["open_top", "closed"],
                )
            }
            4 => {
                let (w, d, h, base) = plate(&mut rng, (16.0, 50.0), (16.0, 50.0), (4.0, 14.0));
                let pw = g(&mut rng, 4.0, w - 4.0);
                let pd = g(&mut rng, 4.0, d - 4.0);
                let x0 = g(&mut rng, 2.0, w - pw - 2.0);
                let y0 = g(&mut rng, 2.0, d - pd - 2.0);
                let depth = g(&mut rng, 1.0, h - 1.0);
                let steps = vec![
                    (StepOp::New, base),
                    (
                        StepOp::Cut,
                        prism_op("pocket", xy(h - depth), rect(x0, y0, pw, pd), depth + 1.0),
                    ),
                ];
                (
                    "pocket",
                    steps,
                    (h - depth).min(depth).min(pw.min(pd) / 2.0),
                    &[
                        "concave",
                        "concave_lines",
                        "inner_top",
                        "outer_top",
                        "corner3",
                        "one",
                    ],
                    &["open_bottom", "closed"],
                )
            }
            6 => {
                // An obstacle closer to the front top edge than the blend reaches.
                let (w, d, h, base) = plate(&mut rng, (16.0, 40.0), (16.0, 40.0), (6.0, 20.0));
                let gap = g(&mut rng, 0.5, 3.0);
                let rh = g(&mut rng, 0.5, 2.0);
                let x = g(&mut rng, rh + 2.0, w - rh - 2.0);
                let obstacle = match rng.below(4) {
                    // A vertical hole, through or blind from above.
                    0 => {
                        let depth = g(&mut rng, 1.0, h + 2.0);
                        (
                            StepOp::Cut,
                            prism_op(
                                "h0",
                                xy(h - depth),
                                vec![circle("c", [x, gap + rh], rh)],
                                depth + 1.0,
                            ),
                        )
                    }
                    // A cross hole along x under the top face.
                    1 => (
                        StepOp::Cut,
                        prism_op(
                            "h0",
                            frame([-1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
                            vec![circle("c", [gap + rh, h - gap - rh], rh)],
                            w + 2.0,
                        ),
                    ),
                    // A 1 × 0.5 tunnel along y just under the top face.
                    2 => (
                        StepOp::Cut,
                        prism_op("t0", xy(h - gap - 0.5), rect(x, -1.0, 1.0, d + 2.0), 0.5),
                    ),
                    // A boss on the top face next to the edge.
                    _ => (
                        StepOp::Join,
                        prism_op(
                            "b0",
                            xy(h),
                            vec![circle("c", [x, gap + rh], rh)],
                            g(&mut rng, 1.0, 5.0),
                        ),
                    ),
                };
                (
                    "obstacle",
                    vec![(StepOp::New, base), obstacle],
                    (2.0 * gap + 2.0 * rh).min(h),
                    &["front_top"],
                    &["open_bottom", "closed"],
                )
            }
            7 => {
                // An L-block (a base and a wall) with a boss or a hole next to the inside
                // corner.
                let w = g(&mut rng, 16.0, 40.0);
                let d = g(&mut rng, 10.0, 30.0);
                let h = g(&mut rng, 3.0, 10.0);
                let t = g(&mut rng, 3.0, 8.0);
                let hw = g(&mut rng, 4.0, 15.0);
                let gap = g(&mut rng, 0.5, 3.0);
                let rh = g(&mut rng, 0.5, 1.5);
                let y = g(&mut rng, rh + 1.0, d - rh - 1.0);
                let base = prism_op("base", xy(0.0), rect(0.0, 0.0, w, d), h);
                let wall = prism_op("wall", xy(h), rect(0.0, 0.0, t, d), hw);
                let feature = match rng.below(3) {
                    0 => (
                        StepOp::Join,
                        prism_op(
                            "b0",
                            xy(h),
                            vec![circle("c", [t + gap + rh, y], rh)],
                            g(&mut rng, 1.0, 4.0),
                        ),
                    ),
                    1 => (
                        StepOp::Cut,
                        prism_op(
                            "h0",
                            xy(-1.0),
                            vec![circle("c", [t + gap + rh, y], rh)],
                            h + 2.0,
                        ),
                    ),
                    _ => (
                        StepOp::Cut,
                        prism_op(
                            "h0",
                            frame([-1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
                            vec![circle("c", [y, h + gap + rh], rh)],
                            t + 2.0,
                        ),
                    ),
                };
                (
                    "lblock_obstacle",
                    vec![(StepOp::New, base), (StepOp::Join, wall), feature],
                    (2.0 * gap + 2.0 * rh).min(h).min(t),
                    &["concave_lines", "concave"],
                    &["open_top", "closed"],
                )
            }
            8 => {
                // Oblique prisms: the vertical faces meet at angles other than 90°.
                let h = g(&mut rng, 4.0, 20.0);
                let s = g(&mut rng, 10.0, 30.0);
                let pts: Vec<[f64; 2]> = match rng.below(3) {
                    0 => {
                        let a = g(&mut rng, 0.2 * s, 0.8 * s);
                        vec![[0.0, 0.0], [s, 0.0], [a, g(&mut rng, 0.5 * s, s)]]
                    }
                    1 => (0..6)
                        .map(|k| {
                            let t = forge_core::math::PI / 3.0 * k as f64;
                            let (sn, cs) = forge_core::math::sin_cos(t);
                            [(s * cs * 2.0).round() / 2.0, (s * sn * 2.0).round() / 2.0]
                        })
                        .collect(),
                    _ => {
                        let top = g(&mut rng, 0.3 * s, 0.9 * s);
                        let off = g(&mut rng, 0.0, s - top);
                        vec![[0.0, 0.0], [s, 0.0], [off + top, 0.7 * s], [off, 0.7 * s]]
                    }
                };
                let steps = vec![(StepOp::New, prism_op("base", xy(0.0), polygon(&pts), h))];
                (
                    "oblique",
                    steps,
                    h.min(0.25 * s),
                    &["all", "top", "vertical", "corner3", "one", "random"],
                    &["open_top", "closed"],
                )
            }
            _ => {
                let w = g(&mut rng, 10.0, 40.0);
                let d = g(&mut rng, 10.0, 40.0);
                let h = g(&mut rng, 3.0, 20.0);
                let a = g(&mut rng, 3.0, w - 3.0);
                let bb = g(&mut rng, 3.0, d - 3.0);
                let pts = [[0.0, 0.0], [w, 0.0], [w, bb], [a, bb], [a, d], [0.0, d]];
                let steps = vec![(StepOp::New, prism_op("base", xy(0.0), polygon(&pts), h))];
                (
                    "lblock",
                    steps,
                    h.min(a).min(bb).min(w - a).min(d - bb),
                    &[
                        "concave", "top", "one", "corner2", "corner3", "all", "random",
                    ],
                    &["open_top", "open_bottom", "closed"],
                )
            }
        };
        let (op, select) = if shell {
            let t = ((scale * rng.range(0.05, 0.6)) * 100.0).round() / 100.0;
            (
                CaseOp::Shell {
                    t: t.max(0.05),
                    outward: rng.below(4) == 0,
                },
                shell_opts[rng.below(shell_opts.len())],
            )
        } else {
            (
                fillet_or_chamfer(&mut rng, scale, true),
                sel_opts[rng.below(sel_opts.len())],
            )
        };
        out.push(Case {
            id: format!("s{seed}-{i:04}-{family}"),
            family,
            steps,
            pre: Vec::new(),
            op,
            select,
            pick,
            closed: None,
        });
    }
    out
}

/// `n` cases of the **sequence** families from `seed` (ids `s{seed}-q{i}-{family}`; W6 review
/// round 4: the maker workflows — fillet → shell, fillet → fillet, chamfer → shell — that one
/// operation on an unblended base never exercises), round-robin: a box with its vertical
/// edges and bottom loop filleted (an enclosure) then shelled, a box with all twelve edges
/// filleted then shelled (closed, or opened through its smooth top or bottom), the enclosure's
/// bottom loop as the operation itself, a chamfered box shelled, a plate with a filleted hole
/// shelled. The first three carry their closed form ([`ClosedForm`]).
#[allow(clippy::type_complexity)]
pub fn seq_cases(seed: u64, n: usize) -> Vec<Case> {
    let mut rng = Rng::new(seed ^ 0x5e9_5e9);
    let mut out = Vec::with_capacity(n);
    let round2 = |x: f64| (x * 100.0).round() / 100.0;
    for i in 0..n {
        let pick = rng.next_u64();
        let kind = i % 5;
        let (a, b, c) = (
            g(&mut rng, 16.0, 60.0),
            g(&mut rng, 16.0, 50.0),
            g(&mut rng, 8.0, 30.0),
        );
        let base = prism_op("base", xy(0.0), rect(0.0, 0.0, a, b), c);
        let outward = rng.below(4) == 0;
        let (family, steps, pre, op, select, closed): (
            &'static str,
            Vec<(StepOp, Operand)>,
            Vec<PreOp>,
            CaseOp,
            &'static str,
            Option<ClosedForm>,
        ) = match kind {
            0 | 2 => {
                let rv = g(&mut rng, 2.0, (a.min(b) / 4.0).max(2.5));
                let rb = g(&mut rng, 0.5, (rv - 0.5).min(c / 3.0).max(0.5));
                let vert = PreOp {
                    op: CaseOp::Fillet { r: rv },
                    select: "vertical",
                };
                if kind == 0 {
                    let t = round2(rb * rng.range(0.1, 1.2)).max(0.05);
                    let sel = ["open_top", "closed", "open_bottom"][rng.below(3)];
                    (
                        "enc_shell",
                        vec![(StepOp::New, base)],
                        vec![
                            vert,
                            PreOp {
                                op: CaseOp::Fillet { r: rb },
                                select: "bottom_one",
                            },
                        ],
                        CaseOp::Shell { t, outward },
                        sel,
                        Some(ClosedForm::Enclosure { a, b, c, rv, rb }),
                    )
                } else {
                    // The bottom loop is the operation (sometimes past the vertical radius).
                    let r = round2(rv * rng.range(0.1, 1.3)).max(0.05);
                    (
                        "enc_fillet",
                        vec![(StepOp::New, base)],
                        vec![vert],
                        CaseOp::Fillet { r },
                        "bottom_one",
                        Some(ClosedForm::Enclosure { a, b, c, rv, rb: r }),
                    )
                }
            }
            1 => {
                let r = g(&mut rng, 0.5, (a.min(b).min(c) / 4.0).max(1.0));
                let t = round2(r * rng.range(0.1, 1.2)).max(0.05);
                let sel = ["closed", "open_top", "open_bottom"][rng.below(3)];
                (
                    "rbox_shell",
                    vec![(StepOp::New, base)],
                    vec![PreOp {
                        op: CaseOp::Fillet { r },
                        select: "all",
                    }],
                    CaseOp::Shell { t, outward },
                    sel,
                    Some(ClosedForm::RoundedBox { a, b, c, r }),
                )
            }
            3 => {
                let d = g(&mut rng, 0.5, (a.min(b).min(c) / 5.0).max(1.0));
                let t = round2(c.min(a).min(b) * rng.range(0.03, 0.3)).max(0.05);
                let pre_sel = ["one", "top", "vertical"][rng.below(3)];
                (
                    "chamfer_shell",
                    vec![(StepOp::New, base)],
                    vec![PreOp {
                        op: CaseOp::Chamfer { d },
                        select: pre_sel,
                    }],
                    CaseOp::Shell { t, outward },
                    ["open_bottom", "closed"][rng.below(2)],
                    None,
                )
            }
            _ => {
                let rh = g(&mut rng, 2.0, (a.min(b) / 5.0).max(2.5));
                let cc = [(a / 2.0 * 2.0).round() / 2.0, (b / 2.0 * 2.0).round() / 2.0];
                let hole = prism_op("h0", xy(-1.0), vec![circle("c", cc, rh)], c + 2.0);
                let r = g(&mut rng, 0.5, (c / 4.0).clamp(0.5, 3.0));
                let t = round2(r * rng.range(0.1, 1.2)).max(0.05);
                (
                    "hole_shell",
                    vec![(StepOp::New, base), (StepOp::Cut, hole)],
                    vec![PreOp {
                        op: CaseOp::Fillet { r },
                        select: "circles_top",
                    }],
                    CaseOp::Shell { t, outward },
                    ["open_bottom", "closed"][rng.below(2)],
                    None,
                )
            }
        };
        out.push(Case {
            id: format!("s{seed}-q{i:03}-{family}"),
            family,
            steps,
            pre,
            op,
            select,
            pick,
            closed,
        });
    }
    out
}

/// `n` cases of the **adversarial** families from `seed` (ids `s{seed}-a{i}-{family}`; W6
/// review round 4: non-convex and tilted parts, where the core families have only convex
/// oblique prisms and 270° L-blocks), round-robin: star prisms (reflex vertices of any
/// angle), wedges with a tilted top, blocks with a V-groove, plates with a rib.
#[allow(clippy::type_complexity)]
pub fn adv_cases(seed: u64, n: usize) -> Vec<Case> {
    let mut rng = Rng::new(seed ^ 0xad_5a17);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let pick = rng.next_u64();
        let shell = rng.below(6) == 0;
        let (family, steps, scale, sel_opts, shell_opts): (
            &'static str,
            Vec<(StepOp, Operand)>,
            f64,
            &[&'static str],
            &[&'static str],
        ) = match i % 4 {
            0 => {
                let k = 5 + rng.below(3);
                let ro = g(&mut rng, 8.0, 20.0);
                let ri = (ro * rng.range(0.4, 0.7) * 2.0).round() / 2.0;
                let h = g(&mut rng, 3.0, 12.0);
                let pts: Vec<[f64; 2]> = (0..2 * k)
                    .map(|j| {
                        let t = forge_core::math::PI / k as f64 * j as f64;
                        let r = if j % 2 == 0 { ro } else { ri };
                        let (sn, cs) = forge_core::math::sin_cos(t);
                        [
                            ((ro + 1.0 + r * cs) * 1000.0).round() / 1000.0,
                            ((ro + 1.0 + r * sn) * 1000.0).round() / 1000.0,
                        ]
                    })
                    .collect();
                let arm = ri * forge_core::math::sin(forge_core::math::PI / k as f64);
                (
                    "star",
                    vec![(StepOp::New, prism_op("base", xy(0.0), polygon(&pts), h))],
                    h.min(arm),
                    &[
                        "one", "corner2", "corner3", "top", "all", "random", "vertical", "concave",
                    ],
                    &["open_top", "closed"],
                )
            }
            1 => {
                let w = g(&mut rng, 10.0, 40.0);
                let d = g(&mut rng, 10.0, 40.0);
                let h1 = g(&mut rng, 4.0, 20.0);
                let h2 = g(&mut rng, 4.0, 20.0);
                let h2 = if (h2 - h1).abs() < 1.0 { h1 + 2.0 } else { h2 };
                let wedge = prism_op(
                    "base",
                    frame([0.0, 0.0, 0.0], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]),
                    polygon(&[[0.0, 0.0], [w, 0.0], [w, h1], [0.0, h2]]),
                    d,
                );
                (
                    "wedge_tilt",
                    vec![(StepOp::New, wedge)],
                    h1.min(h2).min(w).min(d) / 2.0,
                    &["top", "one", "corner2", "corner3", "all", "random"],
                    &["open_bottom", "closed"],
                )
            }
            2 => {
                let (w, d, h, base) = plate(&mut rng, (12.0, 40.0), (12.0, 40.0), (5.0, 20.0));
                let gw = g(&mut rng, 1.0, (d / 4.0).max(1.5));
                let depth = g(&mut rng, 1.0, (h - 2.0).max(1.5));
                let y0 = g(&mut rng, gw + 1.0, (d - gw - 1.0).max(gw + 1.5));
                let groove = prism_op(
                    "g0",
                    frame([-1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
                    polygon(&[[y0 - gw, h + 1.0], [y0, h - depth], [y0 + gw, h + 1.0]]),
                    w + 2.0,
                );
                (
                    "vgroove",
                    vec![(StepOp::New, base), (StepOp::Cut, groove)],
                    (h - depth).min(gw).min(depth),
                    &[
                        "concave", "top", "one", "corner2", "corner3", "all", "random",
                    ],
                    &["open_bottom", "closed"],
                )
            }
            _ => {
                let (w, d, h, base) = plate(&mut rng, (16.0, 50.0), (16.0, 50.0), (3.0, 10.0));
                let t = g(&mut rng, 1.0, 4.0);
                let len = g(&mut rng, 0.5 * d, (d - 2.0).max(0.5 * d + 0.5));
                let x0 = g(&mut rng, 1.0, (w - t - 1.0).max(1.5));
                let y0 = g(&mut rng, 1.0, (d - len - 1.0).max(1.0));
                let rh = g(&mut rng, 3.0, 10.0);
                let rib = prism_op("r0", xy(h), rect(x0, y0, t, len), rh);
                (
                    "rib",
                    vec![(StepOp::New, base), (StepOp::Join, rib)],
                    (t / 2.0).min(h).min(rh),
                    &[
                        "concave", "top", "one", "corner3", "all", "convex", "random",
                    ],
                    &["open_bottom", "closed"],
                )
            }
        };
        let (op, select) = if shell {
            let t = ((scale * rng.range(0.05, 0.6)) * 100.0).round() / 100.0;
            (
                CaseOp::Shell {
                    t: t.max(0.05),
                    outward: rng.below(4) == 0,
                },
                shell_opts[rng.below(shell_opts.len())],
            )
        } else {
            (
                fillet_or_chamfer(&mut rng, scale, true),
                sel_opts[rng.below(sel_opts.len())],
            )
        };
        out.push(Case {
            id: format!("s{seed}-a{i:03}-{family}"),
            family,
            steps,
            pre: Vec::new(),
            op,
            select,
            pick,
            closed: None,
        });
    }
    out
}
