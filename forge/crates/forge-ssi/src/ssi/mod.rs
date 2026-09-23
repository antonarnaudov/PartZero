//! Surface–surface intersection: dispatch, context, assembly of the intersection graph.

pub(crate) mod bound;
pub(crate) mod carrier;
pub(crate) mod exact;
pub(crate) mod fit;
pub(crate) mod march;

use forge_core::geom::{Curve2, Curve3, Surface};
use forge_core::math;
use forge_core::scalar::Interval;
use forge_core::{Point2, Point3, Vec3};

use crate::clip::{ParamCurve, Patch, clip_to_patches_around};
use crate::error::{Operand, SsiError};
use crate::func::{mid, param_slack, uv_near};
use crate::ssi::bound::{certify_curve, curve_segments};
use crate::ssi::carrier::{Carrier, ExactNodes, exact_pcurve, output_curve};
use crate::ssi::exact::{ExactOutcome, Feature};
use crate::ssi::fit::{
    FitOptions, Node, densify_periodic, nurbs2, periodic_flags, refine, verify_pcurves,
};
use crate::tolerance::SsiTolerance;
use crate::types::{
    Branch, Contact, IntersectionGraph, Method, Representation, SsiStats, UvBox, Vertex, VertexKind,
};

/// Intersect two surfaces restricted to parameter boxes.
///
/// Returns the intersection graph (branches with pcurves on both surfaces, vertices,
/// isolated tangential contacts, or a coincidence), see [`IntersectionGraph`]. Closed
/// forms are used for the analytic families listed in the crate docs; every other pair
/// is solved by certified subdivision + marching + certified fitting. Every returned
/// curve point is within `tol.fit` of both surfaces.
///
/// # Errors
/// `SSI_UNSUPPORTED` (B-spline surfaces), `SSI_INVALID_DOMAIN`, `SSI_INVALID_TOLERANCE`,
/// and — never silently — `SSI_TANGENT_UNRESOLVED`, `SSI_NOT_CONVERGED`,
/// `SSI_FIT_FAILED`, `SSI_BUDGET_EXCEEDED`, `SSI_INCONSISTENT` with diagnostics.
pub fn intersect_surfaces(
    a: &Surface,
    domain_a: UvBox,
    b: &Surface,
    domain_b: UvBox,
    tol: &SsiTolerance,
) -> Result<IntersectionGraph, SsiError> {
    tol.validate()?;
    for (s, op) in [(a, Operand::A), (b, Operand::B)] {
        if matches!(s, Surface::BSpline(_)) {
            return Err(SsiError::Unsupported {
                operand: op,
                what: "B-spline surfaces (no implicit form yet)",
            });
        }
    }
    domain_a.validate(a, Operand::A)?;
    domain_b.validate(b, Operand::B)?;
    let ctx = Ctx::new(
        Patch {
            surf: a,
            dom: domain_a,
        },
        Patch {
            surf: b,
            dom: domain_b,
        },
        *tol,
    );
    if ctx.disjoint() {
        return Ok(IntersectionGraph::empty(Method::Disjoint));
    }
    // Closed forms first; a closed-form result that fails its certificate falls back to
    // marching.
    if let Some(outcome) = exact::detect(&ctx)
        && let Some(g) = exact_graph(&ctx, &outcome)?
    {
        return Ok(g);
    }
    march::march(&ctx)
}

/// An axis-aligned box.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Aabb {
    pub lo: Point3,
    pub hi: Point3,
}

impl Aabb {
    pub fn diag(&self) -> f64 {
        self.hi.distance(self.lo)
    }
    pub fn intersect(&self, o: &Aabb, pad: f64) -> Option<Aabb> {
        let lo = self.lo.max_components(o.lo) - Vec3::new(pad, pad, pad);
        let hi = self.hi.min_components(o.hi) + Vec3::new(pad, pad, pad);
        (lo.x <= hi.x && lo.y <= hi.y && lo.z <= hi.z).then_some(Aabb { lo, hi })
    }
    pub fn corners(&self) -> [Point3; 8] {
        core::array::from_fn(|i| {
            Point3::new(
                if i & 1 == 0 { self.lo.x } else { self.hi.x },
                if i & 2 == 0 { self.lo.y } else { self.hi.y },
                if i & 4 == 0 { self.lo.z } else { self.hi.z },
            )
        })
    }
}

/// Certified bounding box of a patch (interval evaluation on an 8 × 8 grid).
pub(crate) fn patch_bbox(p: &Patch<'_>) -> Aabb {
    let n = 8;
    let (u0, u1) = p.dom.u;
    let (v0, v1) = p.dom.v;
    let mut lo = Point3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY);
    let mut hi = -lo;
    for i in 0..n {
        for j in 0..n {
            let ua = u0 + (u1 - u0) * i as f64 / n as f64;
            let ub = if i + 1 == n {
                u1
            } else {
                u0 + (u1 - u0) * (i + 1) as f64 / n as f64
            };
            let va = v0 + (v1 - v0) * j as f64 / n as f64;
            let vb = if j + 1 == n {
                v1
            } else {
                v0 + (v1 - v0) * (j + 1) as f64 / n as f64
            };
            let e = p.surf.eval(Interval::new(ua, ub), Interval::new(va, vb));
            lo = lo.min_components(Point3::new(e.x.lo(), e.y.lo(), e.z.lo()));
            hi = hi.max_components(Point3::new(e.x.hi(), e.y.hi(), e.z.hi()));
        }
    }
    Aabb { lo, hi }
}

/// Shared context of one surface–surface query.
pub(crate) struct Ctx<'a> {
    pub a: Patch<'a>,
    pub b: Patch<'a>,
    pub tol: SsiTolerance,
    /// Problem size: the larger patch bounding-box diagonal (mm).
    pub scale: f64,
    pub bbox: [Aabb; 2],
}

impl<'a> Ctx<'a> {
    pub fn new(a: Patch<'a>, b: Patch<'a>, tol: SsiTolerance) -> Self {
        let bbox = [patch_bbox(&a), patch_bbox(&b)];
        let scale = bbox[0].diag().max(bbox[1].diag()).max(1e-9);
        Self {
            a,
            b,
            tol,
            scale,
            bbox,
        }
    }
    /// Snap distance for closed-form decisions.
    pub fn snap(&self) -> f64 {
        0.1 * self.tol.fit
    }
    /// Directions parallel within the snap distance over the problem size.
    pub fn parallel(&self, d1: Vec3, d2: Vec3) -> bool {
        d1.cross(d2).norm() * self.scale <= self.snap()
    }
    /// Directions perpendicular within the snap distance over the problem size.
    pub fn perpendicular(&self, d1: Vec3, d2: Vec3) -> bool {
        d1.dot(d2).abs() * self.scale <= self.snap()
    }
    /// The patch bounding boxes are disjoint (by more than `fit`).
    pub fn disjoint(&self) -> bool {
        self.bbox[0]
            .intersect(&self.bbox[1], self.tol.fit)
            .is_none()
    }
    /// The common bounding box, padded by `fit`.
    pub fn common_box(&self) -> Option<Aabb> {
        self.bbox[0].intersect(&self.bbox[1], self.tol.fit)
    }
    pub fn patches(&self) -> [Patch<'a>; 2] {
        [self.a, self.b]
    }
    pub fn surfs(&self) -> [&'a Surface; 2] {
        [self.a.surf, self.b.surf]
    }
}

/// Singular points of a surface (sphere poles, cone apex, horn-torus centre, spindle
/// axis points) whose parameters lie in the box.
pub(crate) fn singular_points(p: &Patch<'_>) -> Vec<(Point3, f64)> {
    let (v0, v1) = p.dom.v;
    let slack = 1e-9;
    let mut out = Vec::new();
    match p.surf {
        Surface::Sphere(s) => {
            if v1 >= math::FRAC_PI_2 - slack {
                out.push((s.eval(0.0, math::FRAC_PI_2), math::FRAC_PI_2));
            }
            if v0 <= -math::FRAC_PI_2 + slack {
                out.push((s.eval(0.0, -math::FRAC_PI_2), -math::FRAC_PI_2));
            }
        }
        Surface::Cone(c) => {
            let va = c.apex_v();
            if va >= v0 - slack && va <= v1 + slack {
                out.push((c.apex(), va));
            }
        }
        Surface::Torus(t) => {
            if let Some((a, b)) = t.spindle_v_range() {
                for v in [a, b] {
                    if crate::types::in_range(p.dom.v, None, v, slack) {
                        out.push((t.eval(0.0, v), v));
                    }
                }
            } else if t.minor() >= t.major()
                && crate::types::in_range(p.dom.v, Some(math::TAU), math::PI, slack)
            {
                out.push((t.frame().origin(), math::PI));
            }
        }
        _ => {}
    }
    out
}

/// `true` if the surface Jacobian is singular at `uv` (pole, apex, axis point).
pub(crate) fn singular_param(s: &Surface, uv: Point2) -> bool {
    let [_, su, sv] = s.derivs1(uv.x, uv.y);
    su.norm() <= 1e-9 * sv.norm().max(1e-300) || sv.norm() <= 1e-9 * su.norm().max(1e-300)
}

/// Parameters of a curve point on a surface, continued from `prev`; at a parametric
/// singularity the periodic parameter is taken as the one-sided limit along the curve
/// (`side` = +1 towards larger `t`, −1 towards smaller).
pub(crate) fn uv_on_curve<C: ParamCurve>(
    s: &Surface,
    c: &C,
    t: f64,
    prev: Point2,
    side: f64,
    dt: f64,
) -> Point2 {
    let p = c.point(t);
    let uv = uv_near(s, p, prev.x, prev.y);
    if !singular_param(s, uv) {
        return uv;
    }
    let q = c.point(t + side * dt);
    let lim = uv_near(s, q, prev.x, prev.y);
    Point2::new(lim.x, uv.y)
}

// ---------------------------------------------------------------------------------------
// Exact assembly

/// A branch before vertex numbering.
#[derive(Clone, Debug)]
pub(crate) struct PreBranch {
    pub branch: Branch,
    pub ends: Option<[PreVertex; 2]>,
}

/// A vertex before numbering.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PreVertex {
    pub point: Point3,
    pub uv: [Point2; 2],
    pub kind: VertexKind,
    pub contact: Contact,
}

/// A clipped piece of a carrier.
#[derive(Clone, Copy, Debug)]
struct Piece {
    t0: f64,
    t1: f64,
    closed: bool,
    kinds: [VertexKind; 2],
}

/// Natural parameter ranges of a carrier inside the common bounding box.
fn carrier_ranges(ctx: &Ctx, c: &Carrier) -> Vec<(f64, f64, bool)> {
    let Some(bx) = ctx.common_box() else {
        return Vec::new();
    };
    match c {
        Carrier::Circle(_) | Carrier::Ellipse(_) => vec![(0.0, math::TAU, true)],
        Carrier::Line(l) => {
            let (o, d) = (l.origin(), l.dir());
            let (mut lo, mut hi) = (f64::NEG_INFINITY, f64::INFINITY);
            for k in 0..3 {
                let (ok, dk, bl, bh) = match k {
                    0 => (o.x, d.x, bx.lo.x, bx.hi.x),
                    1 => (o.y, d.y, bx.lo.y, bx.hi.y),
                    _ => (o.z, d.z, bx.lo.z, bx.hi.z),
                };
                if dk.abs() < 1e-300 {
                    if ok < bl || ok > bh {
                        return Vec::new();
                    }
                    continue;
                }
                let (t1, t2) = ((bl - ok) / dk, (bh - ok) / dk);
                lo = lo.max(t1.min(t2));
                hi = hi.min(t1.max(t2));
            }
            if lo < hi {
                vec![(lo, hi, false)]
            } else {
                Vec::new()
            }
        }
        Carrier::Section(s) => {
            let r = bx
                .corners()
                .iter()
                .fold(0.0f64, |m, q| m.max(q.distance(s.apex)));
            s.ranges(r * 1.01 + ctx.tol.fit)
                .into_iter()
                .map(|(a, b)| (a, b, false))
                .collect()
        }
    }
}

/// Split clipped pieces at parameters of singular points / crossings.
fn split_pieces(
    pieces: Vec<(f64, f64)>,
    whole_closed: bool,
    period: f64,
    splits: &[(f64, VertexKind)],
    eps: f64,
) -> Vec<Piece> {
    let db = VertexKind::DomainBoundary;
    if whole_closed {
        let (t0, _) = pieces[0];
        let mut s: Vec<(f64, VertexKind)> = splits
            .iter()
            .map(|&(t, k)| (t0 + math::wrap_angle(t - t0, 0.0), k))
            .collect();
        s.sort_by(|a, b| a.0.total_cmp(&b.0));
        s.dedup_by(|b, a| (b.0 - a.0).abs() <= eps);
        if s.is_empty() {
            return vec![Piece {
                t0,
                t1: t0 + period,
                closed: true,
                kinds: [db, db],
            }];
        }
        let n = s.len();
        return (0..n)
            .map(|i| {
                let (a, ka) = s[i];
                let (b, kb) = if i + 1 < n {
                    s[i + 1]
                } else {
                    (s[0].0 + period, s[0].1)
                };
                Piece {
                    t0: a,
                    t1: b,
                    closed: false,
                    kinds: [ka, kb],
                }
            })
            .collect();
    }
    let mut out = Vec::new();
    for (a, b) in pieces {
        let mut cuts: Vec<(f64, VertexKind)> = Vec::new();
        let mut kinds = [db, db];
        for &(t, k) in splits {
            // Periodic carriers: bring t into the piece's window.
            let cand = if period > 0.0 {
                let base = a + math::wrap_angle(t - a, 0.0);
                [base, base - period]
            } else {
                [t, t]
            };
            for tt in cand {
                if (tt - a).abs() <= eps {
                    kinds[0] = k;
                } else if (tt - b).abs() <= eps {
                    kinds[1] = k;
                } else if tt > a && tt < b {
                    cuts.push((tt, k));
                }
            }
        }
        cuts.sort_by(|x, y| x.0.total_cmp(&y.0));
        cuts.dedup_by(|y, x| (y.0 - x.0).abs() <= eps);
        let mut start = (a, kinds[0]);
        for (t, k) in cuts {
            out.push(Piece {
                t0: start.0,
                t1: t,
                closed: false,
                kinds: [start.1, k],
            });
            start = (t, k);
        }
        out.push(Piece {
            t0: start.0,
            t1: b,
            closed: false,
            kinds: [start.1, kinds[1]],
        });
    }
    out
}

/// Build the graph of a closed-form outcome. `Ok(None)` if a branch fails its
/// certificate (the caller falls back to marching).
fn exact_graph(ctx: &Ctx, out: &ExactOutcome) -> Result<Option<IntersectionGraph>, SsiError> {
    if let Some(c) = out.coincidence {
        let mut g = IntersectionGraph::empty(out.method);
        g.coincidence = Some(c);
        return Ok(Some(g));
    }
    let sing: Vec<Point3> = singular_points(&ctx.a)
        .into_iter()
        .chain(singular_points(&ctx.b))
        .map(|(p, _)| p)
        .collect();
    let mut pre = Vec::new();
    let mut stats = SsiStats::default();
    for f in &out.features {
        for (t0, t1, closed) in carrier_ranges(ctx, &f.carrier) {
            // Where the carrier passes through a pole or apex, the box constraints on `u` are
            // undefined: the clip leaves the curve within the fit tolerance of it unsearched.
            let mut avoid: Vec<(f64, f64)> = Vec::new();
            for &x in &sing {
                let (t, d) = f.carrier.project(x);
                if d > ctx.tol.fit {
                    continue;
                }
                let h = 1e-6 * (t1 - t0).abs().max(1e-300);
                let speed = f.carrier.point(t + h).distance(f.carrier.point(t - h)) / (2.0 * h);
                let delta = ctx.tol.fit / speed.max(1e-300);
                let period = if closed { t1 - t0 } else { 0.0 };
                for tt in [t, t - period, t + period] {
                    if tt >= t0 && tt <= t1 {
                        avoid.push((tt, delta));
                    }
                }
            }
            avoid.sort_by(|a, b| a.0.total_cmp(&b.0));
            avoid.dedup_by(|b, a| a.0.to_bits() == b.0.to_bits());
            let (pieces, whole) =
                clip_to_patches_around(&f.carrier, t0, t1, &ctx.patches(), closed, &avoid)?;
            if pieces.is_empty() {
                continue;
            }
            let mut splits: Vec<(f64, VertexKind)> = Vec::new();
            for &x in &sing {
                let (t, d) = f.carrier.project(x);
                if d <= ctx.tol.fit {
                    splits.push((t, VertexKind::SurfaceSingularity));
                }
            }
            for &(x, k) in &f.splits {
                let (t, d) = f.carrier.project(x);
                if d <= ctx.tol.fit {
                    splits.push((t, k));
                }
            }
            let period = if closed { math::TAU } else { 0.0 };
            let eps = 1e-10 * (t1 - t0).abs().max(1.0);
            for piece in split_pieces(pieces, whole && closed, period, &splits, eps) {
                match exact_piece(ctx, f, &piece, &mut stats)? {
                    Some(b) => pre.push(b),
                    None => return Ok(None),
                }
            }
        }
    }
    let mut iso = Vec::new();
    for p in &out.points {
        let uv = [
            uv_near(ctx.a.surf, p.p, mid(ctx.a.dom.u), mid(ctx.a.dom.v)),
            uv_near(ctx.b.surf, p.p, mid(ctx.b.dom.u), mid(ctx.b.dom.v)),
        ];
        let inside = [ctx.a, ctx.b].iter().zip(uv).all(|(pa, uv)| {
            let slack = param_slack(pa.surf, uv, ctx.tol.fit);
            pa.dom.contains(pa.surf, uv, slack)
        });
        if inside {
            iso.push(PreVertex {
                point: p.p,
                uv,
                kind: p.kind,
                contact: p.contact,
            });
        }
    }
    Ok(Some(finalize(ctx, pre, iso, out.method, true, stats)))
}

/// Pcurves (exact or fitted) of an exact 3D curve, and the verified pcurve error.
fn pcurves_for(
    ctx: &Ctx,
    curve: &Curve3,
    range: (f64, f64),
    stats: &mut SsiStats,
) -> Result<Option<([Curve2; 2], f64)>, SsiError> {
    let surfs = ctx.surfs();
    let dt = 1e-7 * (range.1 - range.0);
    let refs = [ctx.a.refs(), ctx.b.refs()].map(|(u, v)| Point2::new(u, v));
    let start = [0, 1].map(|k| uv_on_curve(surfs[k], curve, range.0, refs[k], 1.0, dt));
    let mut out: [Option<Curve2>; 2] = [None, None];
    for k in 0..2 {
        out[k] = exact_pcurve(curve, range, surfs[k], start[k]);
    }
    // Fit the missing ones.
    let need = [out[0].is_none(), out[1].is_none()];
    let mut err = 0.0f64;
    if need[0] || need[1] {
        let src = ExactNodes { curve, surfs };
        let n0 = initial_count(curve, range);
        let mut nodes: Vec<Node> = Vec::with_capacity(n0 + 1);
        let mut prev = start;
        for i in 0..=n0 {
            let t = if i == n0 {
                range.1
            } else {
                range.0 + (range.1 - range.0) * i as f64 / n0 as f64
            };
            let mut node = src.node(t, prev);
            // One-sided limits at parametric singularities of the ends.
            for k in 0..2 {
                let side = if i == n0 { -1.0 } else { 1.0 };
                node.uv[k] = uv_on_curve(surfs[k], curve, t, prev[k], side, dt);
            }
            prev = node.uv;
            nodes.push(node);
        }
        let opts = FitOptions {
            fit: ctx.tol.fit,
            need_3d: false,
            need_pcurve: need,
            max_nodes: 20_000,
            min_span: 1e-9 * (range.1 - range.0),
            // The 3D curve is exact here; only pcurves are fitted.
            check_position: false,
        };
        let flags = [periodic_flags(surfs[0]), periodic_flags(surfs[1])];
        let nodes = densify_periodic(nodes, &src, flags, opts.max_nodes)?;
        let nodes = refine(nodes, &src, surfs, curve, &opts)?;
        stats.spans += nodes.len() - 1;
        for k in 0..2 {
            if need[k] {
                out[k] = Some(Curve2::BSpline(nurbs2(&nodes, k)?));
            }
        }
        let v = verify_pcurves(&nodes, surfs, curve);
        for k in 0..2 {
            if need[k] {
                err = err.max(v[k]);
            }
        }
    }
    // Verify exact pcurves densely too.
    for k in 0..2 {
        if !need[k] {
            let pc = out[k].as_ref().expect("exact");
            err = err.max(pcurve_error(surfs[k], pc, curve, range, 64));
        }
    }
    let [Some(a), Some(b)] = out else {
        return Ok(None);
    };
    Ok(Some(([a, b], err)))
}

/// Sampled `max |S(pc(t)) − C(t)|`.
pub(crate) fn pcurve_error(
    s: &Surface,
    pc: &Curve2,
    c: &Curve3,
    (t0, t1): (f64, f64),
    n: usize,
) -> f64 {
    let mut e: f64 = 0.0;
    for i in 0..=n {
        let t = t0 + (t1 - t0) * i as f64 / n as f64;
        let uv = pc.eval(t);
        e = e.max(s.eval(uv.x, uv.y).distance(c.eval(t)));
    }
    e
}

fn initial_count(c: &Curve3, (t0, t1): (f64, f64)) -> usize {
    match c {
        Curve3::Line(_) => 4,
        Curve3::Circle(_) | Curve3::Ellipse(_) => {
            (((t1 - t0) / (math::PI / 8.0)).ceil() as usize).max(2)
        }
        Curve3::BSpline(n) => (n.knots().len() / 2).max(4),
    }
}

/// Certified error bound of a 3D curve against both surfaces.
fn curve_bound(ctx: &Ctx, curve: &Curve3, range: (f64, f64)) -> (f64, bool) {
    let segs = curve_segments(curve, range.0, range.1);
    let mut worst: f64 = 0.0;
    let mut complete = true;
    for s in ctx.surfs() {
        let b = certify_curve(&segs, s, 0.5 * ctx.tol.fit, ctx.tol.fit);
        worst = worst.max(b.bound);
        complete &= b.complete;
    }
    (worst, complete)
}

/// Smallest angle between the normals and the orientation sign along a curve.
pub(crate) fn angle_and_sense(
    ctx: &Ctx,
    curve: &Curve3,
    range: (f64, f64),
    pc: &[Curve2; 2],
) -> (f64, Option<bool>) {
    let surfs = ctx.surfs();
    let mut min_angle = f64::INFINITY;
    let mut sense = 0.0;
    for i in 0..=8 {
        let t = range.0 + (range.1 - range.0) * (i as f64 + 0.5) / 9.5;
        let n: Vec<Vec3> = (0..2)
            .map(|k| {
                let uv = pc[k].eval(t);
                surfs[k].normal(uv.x, uv.y).unwrap_or(Vec3::zero())
            })
            .collect();
        let x = n[0].cross(n[1]);
        min_angle = min_angle.min(math::asin(x.norm().min(1.0)));
        if i == 4 {
            sense = curve.d1(t).dot(x);
        }
    }
    let s = if sense > 0.0 {
        Some(true)
    } else if sense < 0.0 {
        Some(false)
    } else {
        None
    };
    (min_angle, s)
}

fn exact_piece(
    ctx: &Ctx,
    f: &Feature,
    piece: &Piece,
    stats: &mut SsiStats,
) -> Result<Option<PreBranch>, SsiError> {
    let (curve, range) = output_curve(&f.carrier, piece.t0, piece.t1)?;
    let Some((pc, pc_err)) = pcurves_for(ctx, &curve, range, stats)? else {
        return Ok(None);
    };
    let (bound3, _) = curve_bound(ctx, &curve, range);
    let error_bound = bound3.max(pc_err);
    if error_bound.is_nan() || error_bound > ctx.tol.fit {
        return Ok(None);
    }
    let (min_angle, sense) = angle_and_sense(ctx, &curve, range, &pc);
    let tangent = f.contact.is_tangent();
    let branch = Branch {
        curve: curve.clone(),
        range,
        pcurve_a: pc[0].clone(),
        pcurve_b: pc[1].clone(),
        closed: piece.closed,
        contact: f.contact,
        sense: if tangent { None } else { sense },
        representation: Representation::Exact,
        start: None,
        end: None,
        error_bound,
        min_angle,
    };
    let ends = if piece.closed {
        None
    } else {
        let mk = |t: f64, kind: VertexKind| {
            let uv = [pc[0].eval(t), pc[1].eval(t)];
            PreVertex {
                point: curve.eval(t),
                uv,
                kind,
                contact: match kind {
                    VertexKind::Singular | VertexKind::TangentPoint => {
                        Contact::Tangent { gap: 0.0 }
                    }
                    _ => f.contact,
                },
            }
        };
        Some([mk(range.0, piece.kinds[0]), mk(range.1, piece.kinds[1])])
    };
    Ok(Some(PreBranch { branch, ends }))
}

/// Merge distance for vertices shared by several branch ends.
fn vertex_merge_distance(ctx: &Ctx) -> f64 {
    (100.0 * ctx.tol.fit).max(1e-9 * ctx.scale)
}

fn kind_rank(k: VertexKind) -> u8 {
    match k {
        VertexKind::DomainBoundary => 0,
        VertexKind::TangentPoint => 1,
        VertexKind::Singular => 2,
        VertexKind::SurfaceSingularity => 3,
    }
}

fn lex(a: Point3, b: Point3) -> core::cmp::Ordering {
    a.x.total_cmp(&b.x)
        .then(a.y.total_cmp(&b.y))
        .then(a.z.total_cmp(&b.z))
}

/// Sort branches, number vertices (merging coincident ends) and build the graph.
pub(crate) fn finalize(
    ctx: &Ctx,
    mut pre: Vec<PreBranch>,
    mut iso: Vec<PreVertex>,
    method: Method,
    certified_complete: bool,
    mut stats: SsiStats,
) -> IntersectionGraph {
    pre.sort_by(|x, y| {
        let (bx, by) = (&x.branch, &y.branch);
        lex(bx.curve.eval(bx.range.0), by.curve.eval(by.range.0))
            .then(lex(bx.curve.eval(bx.range.1), by.curve.eval(by.range.1)))
    });
    let merge = vertex_merge_distance(ctx);
    let mut vertices: Vec<Vertex> = Vec::new();
    let on = |pv: &PreVertex, k: usize| {
        let p = ctx.patches()[k];
        let slack = param_slack(p.surf, pv.uv[k], ctx.tol.fit);
        on_box_boundary(&p, pv.uv[k], slack)
    };
    let add = |pv: &PreVertex, vertices: &mut Vec<Vertex>| -> usize {
        if let Some(i) = vertices
            .iter()
            .position(|v| v.point.distance(pv.point) <= merge)
        {
            if kind_rank(pv.kind) > kind_rank(vertices[i].kind) {
                // A special point (tangent point, crossing, surface singularity) is located
                // exactly; a domain-boundary end merged with it (a clip end up to the merge
                // distance away, e.g. where a padded box ends just past a sphere pole) must
                // not move it: the vertex takes the special point's position.
                vertices[i].kind = pv.kind;
                vertices[i].contact = pv.contact;
                vertices[i].point = pv.point;
                vertices[i].uv_a = pv.uv[0];
                vertices[i].uv_b = pv.uv[1];
                vertices[i].on_boundary_a = on(pv, 0);
                vertices[i].on_boundary_b = on(pv, 1);
            }
            return i;
        }
        let on = |k: usize| on(pv, k);
        vertices.push(Vertex {
            point: pv.point,
            uv_a: pv.uv[0],
            uv_b: pv.uv[1],
            kind: pv.kind,
            on_boundary_a: on(0),
            on_boundary_b: on(1),
            contact: pv.contact,
        });
        vertices.len() - 1
    };
    let mut branches = Vec::with_capacity(pre.len());
    for p in &pre {
        let mut b = p.branch.clone();
        if let Some(ends) = &p.ends {
            b.start = Some(add(&ends[0], &mut vertices));
            b.end = Some(add(&ends[1], &mut vertices));
        }
        branches.push(b);
    }
    iso.sort_by(|x, y| lex(x.point, y.point));
    for v in &iso {
        add(v, &mut vertices);
    }
    stats.spans = stats.spans.max(0);
    IntersectionGraph {
        branches,
        vertices,
        coincidence: None,
        method,
        certified_complete,
        stats,
    }
}

/// `true` if `uv` is on the boundary of a patch's box (non-periodic or partial
/// directions only), within `slack`.
fn on_box_boundary(p: &Patch<'_>, uv: Point2, slack: [f64; 2]) -> bool {
    let near = |x: f64, (a, b): (f64, f64), per: Option<f64>, s: f64| match per {
        Some(pp) => {
            let w = math::wrap_angle(x - a, 0.0);
            w <= s || (w - (b - a)).abs() <= s || (pp - w) <= s
        }
        None => (x - a).abs() <= s || (x - b).abs() <= s,
    };
    let (pu, pv) = p.surf.periodicity();
    (!p.dom.full_u(p.surf) && near(uv.x, p.dom.u, pu, slack[0]))
        || (!p.dom.full_v(p.surf) && near(uv.y, p.dom.v, pv, slack[1]))
}
