//! Piecewise quintic Hermite B-spline fitting of intersection curves and pcurves.
//!
//! # How the output tolerance is met
//! A branch is represented by **nodes**: exact points of the intersection curve (on both
//! surfaces to rounding level: marching nodes are Newton-projected, closed-form nodes are
//! evaluated) with exact first and second derivatives `C'`, `C''` and, per surface, exact
//! parameters `(u, v)` with their first and second derivatives (from
//! `C' = J·(u', v')` and `C'' = J·(u'', v'') + S_uu u'² + 2 S_uv u'v' + S_vv v'²`,
//! `J = [S_u S_v]`). For marched curves `C''` solves `∇F·C'' = −C'ᵀ H_F C'` for both
//! surfaces' distance forms plus `C'·C'' = 0` (arc-length parametrization). Between
//! consecutive nodes the 3D curve and both pcurves are the **quintic Hermite**
//! interpolants of this data (`C²` across nodes), so all three share the parameter `t`
//! and interpolate exactly at the nodes; the interpolation error is `O(h⁶)`.
//!
//! Refinement: every span is checked at `t = ¼, ½, ¾` of its width — distance of the 3D
//! interpolant to both surfaces (distance forms), and `|S(pcurve(t)) − C(t)|` for each
//! pcurve — and split by inserting an exact node at its midpoint while any error exceeds
//! `fit / 4`.
//!
//! Afterwards the 3D curve's distance to both surfaces is **certified** over every span
//! with the Bernstein bound of [`crate::ssi::bound`]; pcurve consistency is verified on a
//! denser sample (16 points per span). The result is stored as a clamped degree-5
//! B-spline with interior knots of multiplicity 5 (each span its own Bézier segment).

use forge_core::geom::{NurbsCurve2, NurbsCurve3, Surface};
use forge_core::{Point2, Point3, Vec2, Vec3};

use crate::error::SsiError;
use crate::func::dist;

/// Exact data of the intersection curve at one parameter.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Node {
    /// Curve parameter.
    pub t: f64,
    /// Point.
    pub p: Point3,
    /// `dC/dt`.
    pub d: Vec3,
    /// `d²C/dt²`.
    pub dd: Vec3,
    /// Parameters on surface a and b.
    pub uv: [Point2; 2],
    /// `d(u, v)/dt` on a and b.
    pub duv: [Vec2; 2],
    /// `d²(u, v)/dt²` on a and b.
    pub dduv: [Vec2; 2],
}

/// `d²(u, v)/dt²` of a pcurve through `uv` with parameter derivative `duv`, for a 3D
/// curve with second derivative `dd`; `None` at parametric singularities.
pub(crate) fn uv_second(surf: &Surface, uv: Point2, duv: Vec2, dd: Vec3) -> Option<Vec2> {
    let s = surf.derivs2(uv.x, uv.y);
    let rhs =
        dd - s.duu * (duv.x * duv.x) - s.duv * (2.0 * duv.x * duv.y) - s.dvv * (duv.y * duv.y);
    let big = s.du.norm().max(s.dv.norm());
    if !(s.du.norm() > 1e-9 * big && s.dv.norm() > 1e-9 * big) {
        return None;
    }
    crate::func::solve_jacobian(s.du, s.dv, rhs).map(|(a, b)| Vec2::new(a, b))
}

/// Bézier control points (degree 5) of the quintic Hermite span between `a` and `b`
/// for values `(p0, d0, a0)`, `(p1, d1, a1)` and width `h`.
#[inline]
fn quintic_ctrl<V>(p0: V, d0: V, a0: V, p1: V, d1: V, a1: V, h: f64) -> [V; 6]
where
    V: Copy
        + core::ops::Add<Output = V>
        + core::ops::Sub<Output = V>
        + core::ops::Mul<f64, Output = V>,
{
    [
        p0,
        p0 + d0 * (h / 5.0),
        p0 + d0 * (2.0 * h / 5.0) + a0 * (h * h / 20.0),
        p1 - d1 * (2.0 * h / 5.0) + a1 * (h * h / 20.0),
        p1 - d1 * (h / 5.0),
        p1,
    ]
}

/// Evaluate a degree-5 Bézier at `s ∈ [0, 1]` (Bernstein form).
#[inline]
fn bezier5<V>(c: &[V; 6], s: f64) -> V
where
    V: Copy + core::ops::Add<Output = V> + core::ops::Mul<f64, Output = V>,
{
    let r = 1.0 - s;
    let (s2, r2) = (s * s, r * r);
    let (s3, r3) = (s2 * s, r2 * r);
    let b = [
        r3 * r2,
        5.0 * s * r2 * r2,
        10.0 * s2 * r3,
        10.0 * s3 * r2,
        5.0 * s2 * s2 * r,
        s3 * s2,
    ];
    c[0] * b[0] + c[1] * b[1] + c[2] * b[2] + c[3] * b[3] + c[4] * b[4] + c[5] * b[5]
}

/// Control points of the 3D span.
fn ctrl3(a: &Node, b: &Node) -> [Point3; 6] {
    quintic_ctrl(a.p, a.d, a.dd, b.p, b.d, b.dd, b.t - a.t)
}

/// Control points of the pcurve span on surface `k`.
fn ctrl2(a: &Node, b: &Node, k: usize) -> [Point2; 6] {
    quintic_ctrl(
        a.uv[k],
        a.duv[k],
        a.dduv[k],
        b.uv[k],
        b.duv[k],
        b.dduv[k],
        b.t - a.t,
    )
}

/// Quintic Hermite 3D point between two nodes at `t`.
pub(crate) fn hermite3(a: &Node, b: &Node, t: f64) -> Point3 {
    bezier5(&ctrl3(a, b), (t - a.t) / (b.t - a.t))
}

/// Quintic Hermite pcurve point (surface `k`) between two nodes at `t`.
pub(crate) fn hermite2(a: &Node, b: &Node, k: usize, t: f64) -> Point2 {
    bezier5(&ctrl2(a, b, k), (t - a.t) / (b.t - a.t))
}

/// Coordinate `dim` (0: u, 1: v) of the pcurve control points on surface `k`.
pub(crate) fn ctrl2_coord(a: &Node, b: &Node, k: usize, dim: usize) -> [f64; 6] {
    ctrl2(a, b, k).map(|p| if dim == 0 { p.x } else { p.y })
}

/// Produces exact nodes between existing ones.
pub(crate) trait NodeSource {
    /// An exact node at `t ∈ (lo.t, hi.t)`.
    fn node_at(&self, lo: &Node, hi: &Node, t: f64) -> Result<Node, SsiError>;
}

/// What to fit and how finely.
#[derive(Clone, Copy, Debug)]
pub(crate) struct FitOptions {
    /// Output tolerance.
    pub fit: f64,
    /// Fit the 3D curve (false: the 3D curve is exact and supplied separately).
    pub need_3d: bool,
    /// Fit the pcurve on a / b.
    pub need_pcurve: [bool; 2],
    /// Node budget per branch.
    pub max_nodes: usize,
    /// Spans shorter than this (parameter units) are not split further.
    pub min_span: f64,
    /// Also bound the distance of the 3D interpolant to the *exact* intersection curve
    /// (at each span midpoint, against an exact node from the source). Needed for
    /// marched branches: near-tangential crossings let a curve that is within `fit` of
    /// both surfaces drift up to `fit / sin(angle)` along the curve's normal.
    pub check_position: bool,
}

/// Reference 3D point of the span at `t`: the exact curve if known, else the 3D
/// interpolant.
pub(crate) trait Reference3 {
    fn point(&self, a: &Node, b: &Node, t: f64) -> Point3;
}

/// The fitted 3D interpolant is the reference (marched branches).
pub(crate) struct HermiteRef;
impl Reference3 for HermiteRef {
    fn point(&self, a: &Node, b: &Node, t: f64) -> Point3 {
        hermite3(a, b, t)
    }
}

/// Worst error of a span at `samples` interior points: `(e3d, [e_pa, e_pb])`.
pub(crate) fn span_errors<R: Reference3>(
    a: &Node,
    b: &Node,
    surfs: [&Surface; 2],
    refc: &R,
    opts: &FitOptions,
    samples: usize,
) -> (f64, [f64; 2]) {
    let mut e3: f64 = 0.0;
    let mut ep = [0.0f64; 2];
    for i in 1..=samples {
        let t = a.t + (b.t - a.t) * i as f64 / (samples + 1) as f64;
        let c = refc.point(a, b, t);
        if opts.need_3d {
            for s in surfs {
                e3 = e3.max(dist(s, c).abs());
            }
        }
        for k in 0..2 {
            if opts.need_pcurve[k] {
                let uv = hermite2(a, b, k, t);
                let q = surfs[k].eval(uv.x, uv.y);
                ep[k] = ep[k].max(q.distance(c));
            }
        }
    }
    (e3, ep)
}

/// Insert nodes until every span meets `fit / 4` at its three quarter points.
pub(crate) fn refine<S: NodeSource, R: Reference3>(
    mut nodes: Vec<Node>,
    src: &S,
    surfs: [&Surface; 2],
    refc: &R,
    opts: &FitOptions,
) -> Result<Vec<Node>, SsiError> {
    let target = 0.25 * opts.fit;
    let mut i = 0;
    while i + 1 < nodes.len() {
        let (a, b) = (nodes[i], nodes[i + 1]);
        let (mut e3, ep) = span_errors(&a, &b, surfs, refc, opts, 3);
        // Positional check against an exact midpoint node (reused as the split node).
        let mut exact_mid = None;
        if opts.check_position && e3.max(ep[0]).max(ep[1]) <= target {
            let n = src.node_at(&a, &b, 0.5 * a.t + 0.5 * b.t)?;
            let dev = hermite3(&a, &b, n.t) - n.p;
            let tn = n.d.normalize().unwrap_or(Vec3::zero());
            e3 = e3.max((dev - tn * dev.dot(tn)).norm());
            exact_mid = Some(n);
        }
        let worst = e3.max(ep[0]).max(ep[1]);
        if worst > target && (b.t - a.t) > opts.min_span {
            if nodes.len() >= opts.max_nodes {
                return Err(SsiError::FitFailed {
                    what: if e3 >= ep[0].max(ep[1]) {
                        "3d curve"
                    } else if ep[0] >= ep[1] {
                        "pcurve a"
                    } else {
                        "pcurve b"
                    },
                    achieved: worst,
                    required: opts.fit,
                    spans: nodes.len() - 1,
                });
            }
            let n = match exact_mid {
                Some(n) => n,
                None => src.node_at(&a, &b, 0.5 * a.t + 0.5 * b.t)?,
            };
            nodes.insert(i + 1, n);
            continue;
        }
        i += 1;
    }
    Ok(nodes)
}

/// Make periodic pcurve parameters continuous: insert exact nodes until no periodic
/// parameter changes by more than π/4 between consecutive nodes (near a pole a curve's
/// longitude swings quickly, and a jump of about π is ambiguous), then re-unwrap every
/// node relative to its predecessor. `periodic[k] = [u periodic, v periodic]` for
/// surface `k`.
pub(crate) fn densify_periodic<S: NodeSource>(
    mut nodes: Vec<Node>,
    src: &S,
    periodic: [[bool; 2]; 2],
    max_nodes: usize,
) -> Result<Vec<Node>, SsiError> {
    let lim = forge_core::math::FRAC_PI_4;
    let jumps = |a: &Node, b: &Node| {
        (0..2).any(|k| {
            (periodic[k][0] && (b.uv[k].x - a.uv[k].x).abs() > lim)
                || (periodic[k][1] && (b.uv[k].y - a.uv[k].y).abs() > lim)
        })
    };
    let mut i = 0;
    while i + 1 < nodes.len() {
        let (a, b) = (nodes[i], nodes[i + 1]);
        if jumps(&a, &b) && (b.t - a.t) > 1e-12 * (1.0 + a.t.abs()) && nodes.len() < max_nodes {
            let n = src.node_at(&a, &b, 0.5 * a.t + 0.5 * b.t)?;
            nodes.insert(i + 1, n);
            continue;
        }
        i += 1;
    }
    let tau = forge_core::math::TAU;
    for i in 1..nodes.len() {
        for (k, per) in periodic.iter().enumerate() {
            let prev = nodes[i - 1].uv[k];
            let cur = &mut nodes[i].uv[k];
            if per[0] {
                cur.x += tau * ((prev.x - cur.x) / tau).round();
            }
            if per[1] {
                cur.y += tau * ((prev.y - cur.y) / tau).round();
            }
        }
    }
    Ok(nodes)
}

/// Parameters `t` where the pcurve `k` of a node list crosses the box `dom` of its
/// surface: each span's pcurve coordinate is a cubic Bézier (control values from the
/// Hermite data), so a span whose control values all lie on one side of a bound cannot
/// cross it (convex hull); the others are subdivided (de Casteljau) down to `1e-13` of
/// the span and the crossing located there. Periodic coordinates compare against the
/// bound shifted by whole periods next to the span.
pub(crate) fn pcurve_box_crossings(
    nodes: &[Node],
    k: usize,
    dom: &crate::types::UvBox,
    full: [bool; 2],
    periodic: [bool; 2],
) -> Vec<f64> {
    fn roots(c: [f64; 6], a: f64, b: f64, depth: u32, out: &mut Vec<f64>) {
        let (lo, hi) = c
            .iter()
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), &x| {
                (l.min(x), h.max(x))
            });
        if lo > 0.0 || hi < 0.0 {
            return;
        }
        if depth >= 44 || b - a <= 1e-13 * (1.0 + a.abs()) {
            out.push(0.5 * a + 0.5 * b);
            return;
        }
        // de Casteljau at 1/2: left = first column, right = last row.
        let mut rows = [c; 6];
        for r in 1..6 {
            for i in 0..6 - r {
                rows[r][i] = 0.5 * (rows[r - 1][i] + rows[r - 1][i + 1]);
            }
        }
        let left: [f64; 6] = core::array::from_fn(|r| rows[r][0]);
        let right: [f64; 6] = core::array::from_fn(|r| rows[5 - r][r]);
        let m = 0.5 * a + 0.5 * b;
        roots(left, a, m, depth + 1, out);
        roots(right, m, b, depth + 1, out);
    }
    let tau = forge_core::math::TAU;
    let mut out = Vec::new();
    for w in nodes.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        for (dim, range) in [(0usize, dom.u), (1usize, dom.v)] {
            if full[dim] {
                continue;
            }
            let c = ctrl2_coord(a, b, k, dim);
            let centre = c.iter().sum::<f64>() / 6.0;
            for bound in [range.0, range.1] {
                let bnd = if periodic[dim] {
                    bound + tau * ((centre - bound) / tau).round()
                } else {
                    bound
                };
                let mut rs = Vec::new();
                roots(c.map(|x| x - bnd), 0.0, 1.0, 0, &mut rs);
                out.extend(rs.into_iter().map(|s| a.t + (b.t - a.t) * s));
            }
        }
    }
    out.sort_by(f64::total_cmp);
    out.dedup_by(|y, x| (*y - *x).abs() <= 1e-12 * (1.0 + x.abs()));
    out
}

/// `[u periodic, v periodic]` of a surface.
pub(crate) fn periodic_flags(s: &Surface) -> [bool; 2] {
    let (pu, pv) = s.periodicity();
    [pu.is_some(), pv.is_some()]
}

/// Dense verification of pcurve consistency (16 samples per span): the worst
/// `|S_k(pcurve_k(t)) − C(t)|` for `k = a, b`.
pub(crate) fn verify_pcurves<R: Reference3>(
    nodes: &[Node],
    surfs: [&Surface; 2],
    refc: &R,
) -> [f64; 2] {
    let opts = FitOptions {
        fit: 0.0,
        need_3d: false,
        need_pcurve: [true, true],
        max_nodes: 0,
        min_span: 0.0,
        check_position: false,
    };
    let mut out = [0.0f64; 2];
    for w in nodes.windows(2) {
        let (_, ep) = span_errors(&w[0], &w[1], surfs, refc, &opts, 15);
        out[0] = out[0].max(ep[0]);
        out[1] = out[1].max(ep[1]);
    }
    out
}

/// Degree of the fitted B-splines.
pub(crate) const FIT_DEGREE: usize = 5;

/// Knot vector with interior knots of multiplicity 5 (one Bézier segment per span).
fn hermite_knots(nodes: &[Node]) -> Vec<f64> {
    let n = nodes.len();
    let mut k = Vec::with_capacity(FIT_DEGREE * n + 2);
    k.extend([nodes[0].t; FIT_DEGREE + 1]);
    for node in &nodes[1..n - 1] {
        k.extend([node.t; FIT_DEGREE]);
    }
    k.extend([nodes[n - 1].t; FIT_DEGREE + 1]);
    k
}

/// The 3D quintic B-spline of the Hermite interpolant.
pub(crate) fn nurbs3(nodes: &[Node]) -> Result<NurbsCurve3, SsiError> {
    let mut ctrl: Vec<[f64; 3]> = Vec::with_capacity(FIT_DEGREE * nodes.len() + 1);
    ctrl.push(nodes[0].p.to_array());
    for w in nodes.windows(2) {
        let c = ctrl3(&w[0], &w[1]);
        ctrl.extend(c[1..].iter().map(|p| p.to_array()));
    }
    NurbsCurve3::new(FIT_DEGREE, hermite_knots(nodes), ctrl, None)
        .map_err(|_| fit_error("3d curve"))
}

/// The pcurve (surface `k`) quintic B-spline of the Hermite interpolant.
pub(crate) fn nurbs2(nodes: &[Node], k: usize) -> Result<NurbsCurve2, SsiError> {
    let mut ctrl: Vec<[f64; 2]> = Vec::with_capacity(FIT_DEGREE * nodes.len() + 1);
    ctrl.push(nodes[0].uv[k].to_array());
    for w in nodes.windows(2) {
        let c = ctrl2(&w[0], &w[1], k);
        ctrl.extend(c[1..].iter().map(|p| p.to_array()));
    }
    NurbsCurve2::new(FIT_DEGREE, hermite_knots(nodes), ctrl, None)
        .map_err(|_| fit_error(if k == 0 { "pcurve a" } else { "pcurve b" }))
}

fn fit_error(what: &'static str) -> SsiError {
    SsiError::FitFailed {
        what,
        achieved: f64::INFINITY,
        required: 0.0,
        spans: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::geom::Sphere;
    use forge_core::math;
    use forge_core::{Frame, Vec3};

    /// Exact nodes of a latitude circle of a sphere, parametrized by angle.
    struct Latitude {
        s: Surface,
        r: f64,
        h: f64,
    }
    impl Latitude {
        fn node(&self, t: f64) -> Node {
            let (st, ct) = math::sin_cos(t);
            let p = Vec3::new(self.r * ct, self.r * st, self.h);
            let d = Vec3::new(-self.r * st, self.r * ct, 0.0);
            let dd = Vec3::new(-self.r * ct, -self.r * st, 0.0);
            let lat = math::atan2(self.h, self.r);
            let uv = Point2::new(t, lat);
            Node {
                t,
                p,
                d,
                dd,
                uv: [uv, Point2::new(t, 0.0)],
                duv: [Vec2::new(1.0, 0.0), Vec2::new(1.0, 0.0)],
                dduv: [Vec2::zero(), Vec2::zero()],
            }
        }
    }
    impl NodeSource for Latitude {
        fn node_at(&self, _: &Node, _: &Node, t: f64) -> Result<Node, SsiError> {
            Ok(self.node(t))
        }
    }

    #[test]
    fn refinement_meets_the_tolerance_and_builds_valid_splines() {
        let s: Surface = Sphere::new(Frame::world(), 5.0).expect("s").into();
        let src = Latitude {
            s: s.clone(),
            r: 4.0,
            h: 3.0,
        };
        let nodes = vec![src.node(0.0), src.node(math::PI), src.node(math::TAU)];
        let opts = FitOptions {
            fit: 1e-7,
            need_3d: true,
            need_pcurve: [true, false],
            max_nodes: 10_000,
            min_span: 1e-12,
            check_position: true,
        };
        let nodes = refine(nodes, &src, [&src.s, &src.s], &HermiteRef, &opts).expect("fit");
        assert!(nodes.len() > 4 && nodes.len() < 200, "{}", nodes.len());
        let c = nurbs3(&nodes).expect("3d");
        for i in 0..=400 {
            let t = math::TAU * i as f64 / 400.0;
            let p = c.eval(t);
            assert!(dist(&s, p).abs() < 1e-7, "t = {t}");
        }
        let pc = nurbs2(&nodes, 0).expect("2d");
        for i in 0..=400 {
            let t = math::TAU * i as f64 / 400.0;
            let uv = pc.eval(t);
            assert!(s.eval(uv.x, uv.y).distance(c.eval(t)) < 1e-7, "t = {t}");
        }
        let segs = crate::ssi::bound::bezier_segments(&c);
        let b = crate::ssi::bound::certify_curve(&segs, &s, 1e-7, 1e-7);
        assert!(b.complete && b.bound <= 1e-7, "{b:?}");
    }
}
