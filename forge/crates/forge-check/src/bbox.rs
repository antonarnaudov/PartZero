//! Tight axis-aligned bounding box of the exact geometry (not enlarged by tolerances).
//!
//! A coordinate's extreme over a face is attained on the face boundary or at an interior
//! critical point of the coordinate function, where the surface normal is parallel to
//! that axis, or at a singular point of the surface. The box is therefore the union of:
//! - all vertices;
//! - every edge's analytic extremes (lines: end points; circles and ellipses:
//!   `t* = atan2(r_y·Y_i, r_x·X_i)` and `t* + π` when inside the edge range; B-splines:
//!   roots of `C'_i` bracketed on a fine grid and refined by bisection; helices and
//!   spirals: certified branch and bound on interval enclosures);
//! - per face, the analytic critical points of spheres and tori (normal ∥ axis) that
//!   lie inside the trimmed domain, and the singular points the face reaches (cone
//!   apex, sphere poles, spindle-torus axis points, horn-torus centre). Planes,
//!   cylinders and cones have no interior extremes besides the apex; helicoids have none
//!   (every critical point is a saddle).

use std::collections::BTreeSet;

use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::{Frame, Point3, Vec3};
use forge_core::math;
use forge_core::scalar::Interval;
use forge_core::topo::{Body, EdgeId, ShellId};

use crate::CheckError;
use crate::domain::{
    FaceDomain, SINGULAR_LINE_EPS, contains, face_domain, singular_v, touches_singular,
};

/// An angle `t` lies in an edge's range `[t0, t1]` (mod 2π) up to this, relative to
/// `1 + |t1|`: the range ends are computed values, so an extreme exactly at an end may
/// round a few ulps outside it (it is then also the end point, which is added anyway).
const ANGLE_RANGE_EPS: f64 = 1e-15;

/// A world axis is parallel to a sphere's or torus's axis when its component orthogonal
/// to that axis (a unit-vector component) is at most this: the coordinate is then extreme
/// along whole circles `v = ±π/2` rather than at isolated points.
const AXIS_PARALLEL_EPS: f64 = 1e-15;

/// Axis-aligned box accumulator.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Aabb {
    pub min: Point3,
    pub max: Point3,
}

impl Aabb {
    pub fn empty() -> Self {
        Self {
            min: Vec3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY),
            max: Vec3::new(f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY),
        }
    }
    pub fn add(&mut self, p: Point3) {
        self.min = self.min.min_components(p);
        self.max = self.max.max_components(p);
    }
    pub fn is_empty(&self) -> bool {
        self.min.x > self.max.x
    }
    pub fn center(&self) -> Point3 {
        (self.min + self.max) * 0.5
    }
}

fn axis(i: usize) -> Vec3 {
    match i {
        0 => Vec3::unit_x(),
        1 => Vec3::unit_y(),
        _ => Vec3::unit_z(),
    }
}

/// `true` if angle `t` lies in `[t0, t1]` modulo 2π.
fn in_range(t: f64, t0: f64, t1: f64) -> bool {
    let d = math::wrap_angle(t - t0, 0.0);
    d <= t1 - t0 + ANGLE_RANGE_EPS * (1.0 + t1.abs())
}

fn add_edge(b: &mut Aabb, curve: &Curve3, t0: f64, t1: f64) -> Result<(), CheckError> {
    b.add(curve.eval(t0));
    b.add(curve.eval(t1));
    let conic = |b: &mut Aabb, f: &Frame, rx: f64, ry: f64| {
        for i in 0..3 {
            let (xi, yi) = (f.x().dot(axis(i)), f.y().dot(axis(i)));
            if xi == 0.0 && yi == 0.0 {
                continue;
            }
            let t = math::atan2(ry * yi, rx * xi);
            for tt in [t, t + math::PI] {
                if in_range(tt, t0, t1) {
                    b.add(curve.eval(tt));
                }
            }
        }
    };
    match curve {
        Curve3::Line(_) => {}
        Curve3::Circle(c) => conic(b, c.frame(), c.radius(), c.radius()),
        Curve3::Ellipse(e) => conic(b, e.frame(), e.rx(), e.ry()),
        Curve3::Helix(_) => {
            for p in curve_extreme_points(curve, t0, t1)? {
                b.add(p);
            }
        }
        Curve3::BSpline(_) => {
            // Roots of each derivative component, bracketed on a fine grid.
            let n = 256;
            for i in 0..3 {
                let comp = |t: f64| curve.d1(t).dot(axis(i));
                let mut ta = t0;
                let mut fa = comp(ta);
                for k in 1..=n {
                    let tb = if k == n {
                        t1
                    } else {
                        t0 + (t1 - t0) * k as f64 / n as f64
                    };
                    let fb = comp(tb);
                    if (fa < 0.0) != (fb < 0.0) {
                        let (mut lo, mut hi, mut flo) = (ta, tb, fa);
                        for _ in 0..80 {
                            let mid = 0.5 * (lo + hi);
                            let fm = comp(mid);
                            if (fm < 0.0) == (flo < 0.0) {
                                lo = mid;
                                flo = fm;
                            } else {
                                hi = mid;
                            }
                        }
                        b.add(curve.eval(0.5 * (lo + hi)));
                    }
                    ta = tb;
                    fa = fb;
                }
            }
        }
    }
    Ok(())
}

/// The points of `curve` over `[t0, t1]` where each world coordinate is smallest and
/// largest (six points: `−x, +x, −y, +y, −z, +z`), by certified branch and bound on
/// interval enclosures ([`extreme_on_range`]). For curves whose extremes have no closed
/// form (helices and spirals); also used by forge-refs' per-edge boxes.
pub fn curve_extreme_points(curve: &Curve3, t0: f64, t1: f64) -> Result<Vec<Point3>, CheckError> {
    let mut out = Vec::with_capacity(6);
    for i in 0..3 {
        for sign in [-1.0, 1.0] {
            let e = axis(i).lift::<Interval>() * Interval::point(sign);
            let t = extreme_on_range(
                |t: Interval| curve.eval(t).dot(e),
                |t: Interval| curve.d1(t).dot(e),
                |t: f64| sign * curve.eval(t).dot(axis(i)),
                t0,
                t1,
            )
            .ok_or(CheckError::Unsupported {
                what: "bounding box of a curve (extreme search out of budget)",
            })?;
            out.push(curve.eval(t));
        }
    }
    Ok(out)
}

/// Relative precision of [`extreme_on_range`]: the maximum found is within this (times
/// `1 +` its magnitude) of the true maximum.
const EXTREME_REL_TOL: f64 = 1e-14;

/// Sub-intervals [`extreme_on_range`] may examine before giving up.
const EXTREME_BUDGET: usize = 200_000;

/// The parameter maximizing `f` over `[t0, t1]`, by branch and bound on the interval
/// enclosure `fi` (certified: a piece is dropped only when its enclosure's upper bound is
/// at most the best value found plus [`EXTREME_REL_TOL`]). Used where the extremes have no
/// closed form (spirals and conical helices; circular helices too, for one code path).
///
/// The incumbent starts from a sample every π/32 of the parameter (an angle for every curve
/// this serves), and the pieces are examined best-first (largest upper bound first, ties by
/// creation order): only pieces around the maxima survive. `None` if [`EXTREME_BUDGET`] runs
/// out.
fn extreme_on_range(
    fi: impl Fn(Interval) -> Interval,
    dfi: impl Fn(Interval) -> Interval,
    f: impl Fn(f64) -> f64,
    t0: f64,
    t1: f64,
) -> Option<f64> {
    // Upper bound of `f` over `[a, b]`: the better of the natural enclosure and the
    // mean-value form `f(m) + f'([a, b])·([a, b] − m)`, which converges quadratically where
    // the natural one (cos and sin enclosed separately) only converges linearly.
    let upper = |a: f64, b: f64| -> f64 {
        let m = 0.5 * (a + b);
        let natural = fi(Interval::new(a, b)).hi();
        let centred = fi(Interval::point(m))
            + dfi(Interval::new(a, b)) * (Interval::new(a, b) - Interval::point(m));
        natural.min(centred.hi())
    };
    use std::cmp::Ordering;
    use std::collections::BinaryHeap;
    #[derive(PartialEq)]
    struct Piece {
        hi: f64,
        seq: usize,
        a: f64,
        b: f64,
    }
    impl Eq for Piece {}
    impl PartialOrd for Piece {
        fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
            Some(self.cmp(o))
        }
    }
    impl Ord for Piece {
        fn cmp(&self, o: &Self) -> Ordering {
            self.hi.total_cmp(&o.hi).then(o.seq.cmp(&self.seq))
        }
    }
    let n = (((t1 - t0) / (math::PI / 32.0)).ceil() as usize).clamp(8, 1 << 16);
    let at = |k: usize| {
        if k == n {
            t1
        } else {
            t0 + (t1 - t0) * (k as f64 / n as f64)
        }
    };
    let mut best = (t0, f(t0));
    for k in 1..=n {
        let t = at(k);
        let v = f(t);
        if v > best.1 {
            best = (t, v);
        }
    }
    let mut heap = BinaryHeap::new();
    let mut seq = 0usize;
    for k in 0..n {
        let (a, b) = (at(k), at(k + 1));
        heap.push(Piece {
            hi: upper(a, b),
            seq,
            a,
            b,
        });
        seq += 1;
    }
    let mut steps = 0usize;
    while let Some(p) = heap.pop() {
        let tol = EXTREME_REL_TOL * (1.0 + best.1.abs());
        if p.hi <= best.1 + tol {
            break; // every remaining piece is bounded by this one
        }
        steps += 1;
        if steps > EXTREME_BUDGET {
            return None;
        }
        let m = 0.5 * (p.a + p.b);
        if !(m > p.a && m < p.b) {
            continue; // resolution limit: the piece is a point
        }
        let fm = f(m);
        if fm > best.1 {
            best = (m, fm);
        }
        for (a, b) in [(p.a, m), (m, p.b)] {
            heap.push(Piece {
                hi: upper(a, b),
                seq,
                a,
                b,
            });
            seq += 1;
        }
    }
    Some(best.0)
}

/// Interior critical points `(u, v)` of the coordinate functions of a sphere or torus
/// (where the normal is parallel to a world axis); `None` in the `v` slot stands for a
/// whole critical circle `v = ±π/2` (world axis parallel to the surface axis).
fn critical_uv(f: &Frame, torus: bool) -> Vec<(Option<f64>, f64)> {
    let mut out = Vec::new();
    for i in 0..3 {
        let e = axis(i);
        let (ex, ey, ez) = (e.dot(f.x()), e.dot(f.y()), e.dot(f.z()));
        let h = math::hypot(ex, ey);
        if h <= AXIS_PARALLEL_EPS {
            out.push((None, math::FRAC_PI_2));
            out.push((None, -math::FRAC_PI_2));
            continue;
        }
        let u1 = math::atan2(ey, ex);
        if torus {
            let (va, vb) = (math::atan2(ez, h), math::atan2(ez, -h));
            out.extend([
                (Some(u1), va),
                (Some(u1), va + math::PI),
                (Some(u1 + math::PI), vb),
                (Some(u1 + math::PI), vb + math::PI),
            ]);
        } else {
            let va = math::atan2(ez, h);
            out.extend([(Some(u1), va), (Some(u1 + math::PI), -va)]);
        }
    }
    out
}

/// Candidate `v` representatives of `v` for the domain (periodic `v` → shift into the
/// face's lifted range).
fn v_candidates(dom: &FaceDomain<'_>, v: f64) -> Vec<f64> {
    match dom.surface.periodicity().1 {
        None => {
            // A spindle-torus patch is 2π-periodic as a formula but not as a domain:
            // bring the angle into the patch's representation, centred on its range. An
            // angle outside the patch's range is a critical point of the *other* sheet,
            // never of this face (Phase 0 audit H2: wrapping it into the range put
            // points of the other sheet into the box).
            if let Surface::Torus(t) = dom.surface
                && let Some((v0, v1)) = t.spindle_v_range()
            {
                let mid = 0.5 * (v0 + v1);
                let w = math::wrap_angle(v, mid - math::PI);
                let eps = SINGULAR_LINE_EPS * (1.0 + w.abs());
                return if w >= v0 - eps && w <= v1 + eps {
                    vec![w]
                } else {
                    Vec::new()
                };
            }
            vec![v]
        }
        Some(per) => {
            let (lo, hi) = if dom.is_loopless() {
                (0.0, per)
            } else {
                dom.v_extent()
            };
            let k0 = ((lo - v) / per).floor() as i64 - 1;
            let k1 = ((hi - v) / per).ceil() as i64 + 1;
            (k0..=k1).map(|k| v + k as f64 * per).collect()
        }
    }
}

fn add_face(b: &mut Aabb, dom: &FaceDomain<'_>) -> Result<(), CheckError> {
    let s = dom.surface;
    let frame = match s {
        Surface::Plane(_) | Surface::Cylinder(_) => None,
        Surface::Cone(_) => None,
        Surface::Sphere(sp) => Some((*sp.frame(), false)),
        Surface::Torus(t) => Some((*t.frame(), true)),
        // A helicoid has no interior extreme of a coordinate: at a critical point of
        // `e·S` the Hessian `[[v·k·e_z, h·sin(ψ − u)], [h·sin(ψ − u), 0]]` has negative
        // determinant (a saddle) unless `e ⟂ z` and `v = 0` (the axis, outside faces).
        Surface::Helicoid(_) => None,
        Surface::BSpline(_) => {
            return Err(CheckError::Unsupported {
                what: "bounding box of B-spline faces",
            });
        }
    };
    // Singular points the face reaches.
    for vs in singular_v(s) {
        if touches_singular(dom, vs) {
            b.add(s.eval(0.0, vs));
        }
    }
    let Some((f, torus)) = frame else {
        return Ok(());
    };
    let (u_lo, u_hi) = if dom.is_loopless() {
        (0.0, math::TAU)
    } else {
        dom.u_extent()
    };
    for (u, v) in critical_uv(&f, torus) {
        let us: Vec<f64> = match u {
            Some(u) => vec![u],
            None => vec![0.5 * (u_lo + u_hi)],
        };
        for u in us {
            for vv in v_candidates(dom, v) {
                if contains(dom, u, vv) {
                    b.add(s.eval(u, vv));
                    break;
                }
            }
        }
    }
    Ok(())
}

/// The tight box of a body, and the per-face domains' consistency as a side effect.
pub(crate) fn body_box(body: &Body, gap_tol: f64) -> Result<Aabb, CheckError> {
    let mut b = Aabb::empty();
    for v in body.vertices().values() {
        b.add(v.point);
    }
    for e in body.edges().values() {
        add_edge(&mut b, &e.curve, e.t_range.0, e.t_range.1)?;
    }
    for f in body.faces().values() {
        let dom = face_domain(body, f, gap_tol)?;
        add_face(&mut b, &dom)?;
    }
    if b.is_empty() {
        return Err(CheckError::Empty);
    }
    Ok(b)
}

/// The tight box of one shell: its faces' edges, their vertices and the faces' interior
/// extremes (it bounds the shell-nesting rays and rules out points outside it).
pub(crate) fn shell_box(body: &Body, shell: ShellId, gap_tol: f64) -> Result<Aabb, CheckError> {
    let sh = body.shell(shell).ok_or(CheckError::Empty)?;
    let mut edges: BTreeSet<EdgeId> = BTreeSet::new();
    let mut b = Aabb::empty();
    for &fid in &sh.faces {
        let f = body.face(fid).ok_or(CheckError::Empty)?;
        let dangling = || CheckError::Dangling {
            face: f.provenance.name(),
        };
        for &lid in &f.loops {
            for &cid in &body.loop_(lid).ok_or_else(dangling)?.coedges {
                edges.insert(body.coedge(cid).ok_or_else(dangling)?.edge);
            }
        }
        add_face(&mut b, &face_domain(body, f, gap_tol)?)?;
    }
    for eid in edges {
        let Some(e) = body.edge(eid) else { continue };
        for v in [e.start, e.end].into_iter().flatten() {
            if let Some(v) = body.vertex(v) {
                b.add(v.point);
            }
        }
        add_edge(&mut b, &e.curve, e.t_range.0, e.t_range.1)?;
    }
    if b.is_empty() {
        return Err(CheckError::Empty);
    }
    Ok(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::geom::Helix3;

    fn dense_extremes(c: &Curve3, t0: f64, t1: f64) -> ([f64; 3], [f64; 3]) {
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        let n = 200_000;
        for k in 0..=n {
            let t = t0 + (t1 - t0) * k as f64 / n as f64;
            let p = c.eval(t).to_array();
            for i in 0..3 {
                lo[i] = lo[i].min(p[i]);
                hi[i] = hi[i].max(p[i]);
            }
        }
        (lo, hi)
    }

    #[test]
    fn helix_and_spiral_extremes_bound_a_dense_sampling_tightly() {
        let tilted = Frame::from_normal_x(
            Vec3::new(1.0, -2.0, 0.5),
            Vec3::new(0.3, -0.2, 1.0),
            Vec3::new(1.0, 1.0, 0.0),
        )
        .unwrap();
        let axis = Frame::from_normal_x(
            Vec3::new(0.0, 0.0, 10.0),
            Vec3::new(0.0, 0.0, -1.0),
            Vec3::new(1.0, 0.0, 0.0),
        )
        .unwrap();
        for (c, t0, t1) in [
            (
                Curve3::from(Helix3::new(axis, 3.3, 0.0, 0.2).unwrap()),
                -1.0,
                49.0,
            ),
            (
                Curve3::from(Helix3::new(tilted, 3.3, 0.0, -0.2).unwrap()),
                3.0,
                40.0,
            ),
            (
                Curve3::from(Helix3::new(tilted, 20.0, -0.35, 0.0).unwrap()),
                45.0,
                47.2,
            ),
        ] {
            let pts = curve_extreme_points(&c, t0, t1).expect("extremes");
            let (lo, hi) = dense_extremes(&c, t0, t1);
            for i in 0..3 {
                let got_lo = pts
                    .iter()
                    .map(|p| p.to_array()[i])
                    .fold(f64::INFINITY, f64::min);
                let got_hi = pts
                    .iter()
                    .map(|p| p.to_array()[i])
                    .fold(f64::NEG_INFINITY, f64::max);
                assert!(
                    got_lo <= lo[i] + 1e-13 && got_lo >= lo[i] - 1e-6,
                    "{i}: {got_lo} vs {}",
                    lo[i]
                );
                assert!(
                    got_hi >= hi[i] - 1e-13 && got_hi <= hi[i] + 1e-6,
                    "{i}: {got_hi} vs {}",
                    hi[i]
                );
            }
        }
    }
}
