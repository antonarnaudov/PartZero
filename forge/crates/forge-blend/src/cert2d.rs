//! Certified tests on the boundary curves of a face, in its `(u, v)` parameter plane.
//!
//! # Representation
//! Every pcurve piece is converted into **rational Bézier segments** ([`Bez`]) that represent
//! it exactly up to floating-point rounding (relative 1e-15, far below any tolerance used
//! here): a line is one degree-1 segment; a circle or ellipse arc is split into rational
//! quadratics of at most a quarter turn (control point at the intersection of the end
//! tangents, weight `cos(Δ/2)`, the affine image of the circular case); a B-spline is cut
//! into its Bézier segments by knot insertion (Boehm, in homogeneous coordinates).
//!
//! A rational Bézier segment with positive weights lies in the **convex hull** of its control
//! points, so these bounds are rigorous: the box of the control points, and the band of
//! half-width [`Bez::width`] around the chord (every control point is within `width` of the
//! chord segment, hence so is the hull). De Casteljau subdivision at the middle (in
//! homogeneous coordinates) shrinks both, the width quadratically.
//!
//! # Tests
//! - [`meet_ex`]: do two segments come within `tol` of each other, ignoring contacts inside
//!   given **joint balls** (around a vertex the two pieces share)? Pairs are separated by
//!   boxes and by projection on each chord's normal and direction ("fat lines"); what is not
//!   separated is subdivided until both pieces are flat (`width <= tol/8`, and near a joint
//!   ball also short), where the chord distance decides. [`Meet::Apart`] is a certificate,
//!   [`Meet::Near`] a contact found; anything the work budget or the depth limit does not
//!   resolve is [`Meet::Unresolved`] — undecided, which the operations never count as a
//!   contact (W6 review round 5).
//! - [`Boundary::crossings_ex`]: the pairs of boundary edges of a face that meet (away from
//!   the vertices they share), with the periodic copies of periodic faces, and apart from
//!   them the pairs the budget or the depth limit leaves unresolved.
//! - [`Boundary::contains`]: point in face. `None` when the point is within `tol` of the
//!   boundary (certified by the same subdivision) or the answer cannot be certified;
//!   otherwise the **nearest crossing** of a ray with the boundary decides, with crossings
//!   isolated by the variation-diminishing property (a segment whose control polygon crosses
//!   the ray's line once crosses it exactly once, inside the hull's extent), refined until
//!   the nearest one is separated from the others; crossings that coincide within `tol` (a
//!   vertex on the ray) count by their net direction.
//!
//! `tol` is the face's parameter-space tolerance ([`face_tol`]): `LINEAR_TOLERANCE` divided
//! by a bound of the surface's metric, so that two boundary points declared to meet are
//! within `LINEAR_TOLERANCE` in 3D.

use forge_core::geom::{Curve2, NurbsCurve2, Surface};
use forge_core::linalg::{Point2, Vec2};
use forge_core::math;
use forge_core::predicates::orient2d;
use forge_ir::v1::LINEAR_TOLERANCE;

use crate::plan::Plan;

/// Largest subdivision depth of one pair (both pieces together).
const MAX_DEPTH: u32 = 160;
/// Work budget (pairs of pieces examined) of one [`Boundary::crossings_ex`] call.
const CROSSINGS_BUDGET: usize = 2_000_000;

std::thread_local! {
    /// A smaller crossing budget on this thread (tests of what an exhausted budget does:
    /// [`crate::testing::with_crossings_budget`]).
    static BUDGET: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

/// The crossing budget in force on this thread.
fn crossings_budget() -> usize {
    BUDGET.with(|b| b.get()).unwrap_or(CROSSINGS_BUDGET)
}

/// Runs `f` with the crossing budget set to `budget` on this thread.
pub(crate) fn with_crossings_budget<R>(budget: usize, f: impl FnOnce() -> R) -> R {
    let old = BUDGET.with(|b| b.replace(Some(budget)));
    let out = f();
    BUDGET.with(|b| b.set(old));
    out
}

/// Work budget of one [`meet_ex`] query issued alone.
pub(crate) const MEET_BUDGET: usize = 400_000;
/// Radius of the ball around a shared vertex in which contacts are ignored, in units of the
/// face tolerance.
pub(crate) const JOINT_BALL: f64 = 100.0;
/// Largest distance (face tolerances) between two end points of one vertex in the
/// parameter plane for them to count as the same joint.
const JOINT_GAP: f64 = 1000.0;

/// A rational Bézier segment in the plane (degree = number of points − 1), positive weights.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Bez {
    pub p: Vec<Point2>,
    pub w: Vec<f64>,
}

impl Bez {
    /// The segment from `a` to `b`.
    pub fn line(a: Point2, b: Point2) -> Self {
        Bez {
            p: vec![a, b],
            w: vec![1.0, 1.0],
        }
    }
    pub fn start(&self) -> Point2 {
        self.p[0]
    }
    pub fn end(&self) -> Point2 {
        self.p[self.p.len() - 1]
    }
    pub fn is_linear(&self) -> bool {
        self.p.len() == 2
    }
    pub fn shifted(&self, d: Vec2) -> Self {
        Bez {
            p: self.p.iter().map(|&q| q + d).collect(),
            w: self.w.clone(),
        }
    }
    pub fn reversed(&self) -> Self {
        let mut b = self.clone();
        b.p.reverse();
        b.w.reverse();
        b
    }
    /// De Casteljau at the parametric middle, in homogeneous coordinates.
    pub fn split(&self) -> (Bez, Bez) {
        self.split_at(0.5)
    }
    /// De Casteljau at `s` in homogeneous coordinates: the segments over `[0, s]` and
    /// `[s, 1]` of the underlying (rational) polynomial — for `s` outside `[0, 1]` one of
    /// them extends the segment (its polynomial continuation). The weights of an extension
    /// may be non-positive; see [`Bez::weights_ok`].
    pub fn split_at(&self, s: f64) -> (Bez, Bez) {
        let n = self.p.len();
        let mut h: Vec<[f64; 3]> = (0..n)
            .map(|i| {
                let w = self.w[i];
                [self.p[i].x * w, self.p[i].y * w, w]
            })
            .collect();
        let mut left = Vec::with_capacity(n);
        let mut right = Vec::with_capacity(n);
        left.push(h[0]);
        right.push(h[n - 1]);
        let r = 1.0 - s;
        for k in 1..n {
            for i in 0..(n - k) {
                h[i] = [
                    r * h[i][0] + s * h[i + 1][0],
                    r * h[i][1] + s * h[i + 1][1],
                    r * h[i][2] + s * h[i + 1][2],
                ];
            }
            left.push(h[0]);
            right.push(h[n - 1 - k]);
        }
        right.reverse();
        let from = |v: Vec<[f64; 3]>| Bez {
            p: v.iter()
                .map(|x| Point2::new(x[0] / x[2], x[1] / x[2]))
                .collect(),
            w: v.iter().map(|x| x[2]).collect(),
        };
        (from(left), from(right))
    }
    /// All weights finite and positive (the convex-hull property holds).
    pub fn weights_ok(&self) -> bool {
        self.w.iter().all(|w| w.is_finite() && *w > 0.0) && self.p.iter().all(|p| p.is_finite())
    }
    /// Box of the control points.
    pub fn bbox(&self) -> (Point2, Point2) {
        let mut lo = self.p[0];
        let mut hi = self.p[0];
        for q in &self.p[1..] {
            lo = Point2::new(lo.x.min(q.x), lo.y.min(q.y));
            hi = Point2::new(hi.x.max(q.x), hi.y.max(q.y));
        }
        (lo, hi)
    }
    /// Largest distance of a control point from the chord segment: the hull (hence the
    /// curve) lies within this distance of the chord.
    pub fn width(&self) -> f64 {
        let (a, b) = (self.start(), self.end());
        let n = self.p.len();
        self.p[1..n - 1]
            .iter()
            .map(|&q| pseg(q, a, b))
            .fold(0.0, f64::max)
    }
    fn within_ball(&self, c: Point2, r: f64) -> bool {
        self.p.iter().all(|q| q.distance(c) <= r)
    }
}

fn diag(b: (Point2, Point2)) -> f64 {
    b.0.distance(b.1)
}

/// Gap between two boxes (0 when they overlap).
fn box_gap(a: (Point2, Point2), b: (Point2, Point2)) -> f64 {
    let dx = (b.0.x - a.1.x).max(a.0.x - b.1.x).max(0.0);
    let dy = (b.0.y - a.1.y).max(a.0.y - b.1.y).max(0.0);
    dx.max(dy)
}

fn box_point_dist(b: (Point2, Point2), q: Point2) -> f64 {
    let dx = (b.0.x - q.x).max(q.x - b.1.x).max(0.0);
    let dy = (b.0.y - q.y).max(q.y - b.1.y).max(0.0);
    math::hypot(dx, dy)
}

/// Distance from `q` to the segment `a b`.
pub(crate) fn pseg(q: Point2, a: Point2, b: Point2) -> f64 {
    let d = b - a;
    let l2 = d.dot(d);
    if l2 <= 0.0 {
        return q.distance(a);
    }
    let t = ((q - a).dot(d) / l2).clamp(0.0, 1.0);
    q.distance(a + d * t)
}

/// Closed segments `p q` and `r s` intersect (exact orientation signs; touching counts).
pub(crate) fn segs_cross(p: Point2, q: Point2, r: Point2, s: Point2) -> bool {
    let d1 = orient2d(p, q, r);
    let d2 = orient2d(p, q, s);
    let d3 = orient2d(r, s, p);
    let d4 = orient2d(r, s, q);
    if ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0))
        && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
    {
        return true;
    }
    let on = |a: Point2, b: Point2, c: Point2| {
        c.x >= a.x.min(b.x) && c.x <= a.x.max(b.x) && c.y >= a.y.min(b.y) && c.y <= a.y.max(b.y)
    };
    (d1 == 0.0 && on(p, q, r))
        || (d2 == 0.0 && on(p, q, s))
        || (d3 == 0.0 && on(r, s, p))
        || (d4 == 0.0 && on(r, s, q))
}

/// Distance between the segments `a0 a1` and `b0 b1` (0 when they intersect).
pub(crate) fn seg_dist(a0: Point2, a1: Point2, b0: Point2, b1: Point2) -> f64 {
    if segs_cross(a0, a1, b0, b1) {
        return 0.0;
    }
    pseg(a0, b0, b1)
        .min(pseg(a1, b0, b1))
        .min(pseg(b0, a0, a1))
        .min(pseg(b1, a0, a1))
}

/// Are the hulls of `a` and `b` more than `tol` apart along `a`'s chord normal or chord
/// direction?
fn fat_separated(a: &Bez, b: &Bez, tol: f64) -> bool {
    let p0 = a.start();
    let Some(t) = (a.end() - p0).normalize() else {
        return false;
    };
    for axis in [t.perp(), t] {
        let range = |x: &Bez| {
            x.p.iter()
                .map(|&q| (q - p0).dot(axis))
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), d| {
                    (l.min(d), h.max(d))
                })
        };
        let (alo, ahi) = range(a);
        let (blo, bhi) = range(b);
        if blo > ahi + tol || bhi < alo - tol {
            return true;
        }
    }
    false
}

/// Two straight segments with a joint in one ball: the distance from one segment to the
/// other is a convex function along it that is ~0 at the joint, so a contact outside the
/// ball exists iff the point where either segment leaves the ball is within `tol` of the
/// other segment. `None` when the pair is not of this form.
fn lines_meet(a: &Bez, b: &Bez, tol: f64, balls: &[(Point2, f64)]) -> Option<bool> {
    if seg_dist(a.start(), a.end(), b.start(), b.end()) > tol {
        return Some(false);
    }
    if balls.is_empty() {
        return Some(true);
    }
    for &(c, r) in balls {
        let at = |x: &Bez| {
            if x.start().distance(c) <= r {
                Some((x.start(), x.end()))
            } else if x.end().distance(c) <= r {
                Some((x.end(), x.start()))
            } else {
                None
            }
        };
        let (Some((va, fa)), Some((vb, fb))) = (at(a), at(b)) else {
            continue;
        };
        // The point where a segment starting at `v` towards `far` leaves the ball.
        let exit = |v: Point2, far: Point2| -> Option<Point2> {
            let d = far - v;
            let len = d.norm();
            let dir = d / len;
            // |v + s·dir − c| = r, the larger root.
            let w = v - c;
            let bq = w.dot(dir);
            let cq = w.dot(w) - r * r;
            let disc = bq * bq - cq;
            if disc.is_nan() || disc < 0.0 {
                return None;
            }
            let s = -bq + math::sqrt(disc);
            (s < len).then(|| v + dir * s)
        };
        let from_a = exit(va, fa).is_some_and(|x| pseg(x, vb, fb) <= tol);
        let from_b = exit(vb, fb).is_some_and(|x| pseg(x, va, fa) <= tol);
        return Some(from_a || from_b);
    }
    None
}

/// Do `a` and `b` come within `tol` of each other at a point outside every ball of
/// `balls`? `false` is certified; an unresolved query (budget or depth) is `true`. Test
/// helper: the operations use [`meet_ex`], whose unresolved answer is undecided.
#[cfg(test)]
pub(crate) fn meet(
    a: &Bez,
    b: &Bez,
    tol: f64,
    balls: &[(Point2, f64)],
    budget: &mut usize,
) -> bool {
    meet_ex(a, b, tol, balls, budget) != Meet::Apart
}

/// Pairs of edges (indices of a plan).
pub(crate) type EdgePairs = Vec<(usize, usize)>;

/// The three answers of [`meet_ex`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Meet {
    /// Certified farther than `tol` apart outside the balls.
    Apart,
    /// Two flat sub-pieces within `tol` plus their widths (at most `1.25·tol`): a contact
    /// found, not only suspected.
    Near,
    /// The work budget or the depth limit ran out first (W6 review round 4: a shell counts
    /// this as unverified, never as walls colliding).
    Unresolved,
}

/// [`meet`], telling a contact found from a query left unresolved.
pub(crate) fn meet_ex(
    a: &Bez,
    b: &Bez,
    tol: f64,
    balls: &[(Point2, f64)],
    budget: &mut usize,
) -> Meet {
    let yes = |r: bool| if r { Meet::Near } else { Meet::Apart };
    if a.is_linear()
        && b.is_linear()
        && let Some(r) = lines_meet(a, b, tol, balls)
    {
        return yes(r);
    }
    let rmin = balls.iter().map(|x| x.1).fold(f64::INFINITY, f64::min);
    let near_ball =
        |bx: (Point2, Point2)| balls.iter().any(|&(c, r)| box_point_dist(bx, c) <= r + tol);
    let mut stack: Vec<(Bez, Bez, u32)> = vec![(a.clone(), b.clone(), 0)];
    while let Some((a, b, d)) = stack.pop() {
        if *budget == 0 {
            return Meet::Unresolved;
        }
        *budget -= 1;
        let (ba, bb) = (a.bbox(), b.bbox());
        if box_gap(ba, bb) > tol {
            continue;
        }
        if balls
            .iter()
            .any(|&(c, r)| a.within_ball(c, r) || b.within_ball(c, r))
        {
            continue;
        }
        if fat_separated(&a, &b, tol) || fat_separated(&b, &a, tol) {
            continue;
        }
        let (wa, wb) = (a.width(), b.width());
        let fine = |w: f64, bx: (Point2, Point2)| {
            w <= 0.125 * tol && (!near_ball(bx) || diag(bx) <= 0.125 * rmin)
        };
        let (fa, fb) = (fine(wa, ba), fine(wb, bb));
        if fa && fb {
            if seg_dist(a.start(), a.end(), b.start(), b.end()) <= tol + wa + wb {
                return Meet::Near;
            }
            continue;
        }
        if d >= MAX_DEPTH {
            return Meet::Unresolved;
        }
        let split_a = !fa && (fb || diag(ba) >= diag(bb));
        if split_a {
            let (x, y) = a.split();
            stack.push((y, b.clone(), d + 1));
            stack.push((x, b, d + 1));
        } else {
            let (x, y) = b.split();
            stack.push((a.clone(), y, d + 1));
            stack.push((a, x, d + 1));
        }
    }
    Meet::Apart
}

/// Is `q` farther than `tol` from the segment `b`? `false` when within `tol` or not
/// certified.
fn clear_of(b: &Bez, q: Point2, tol: f64) -> bool {
    let mut stack = vec![(b.clone(), 0u32)];
    while let Some((b, d)) = stack.pop() {
        let bx = b.bbox();
        if box_point_dist(bx, q) > tol {
            continue;
        }
        let w = b.width();
        let dc = pseg(q, b.start(), b.end());
        if dc - w > tol {
            continue;
        }
        if w <= 0.125 * tol || d >= MAX_DEPTH {
            return false;
        }
        let (x, y) = b.split();
        stack.push((x, d + 1));
        stack.push((y, d + 1));
    }
    true
}

/// Exact rational Bézier segments of `c(t) = o + a·cos t + b·sin t` over `[t0, t1]`.
fn conic(o: Point2, a: Vec2, b: Vec2, t0: f64, t1: f64) -> Vec<Bez> {
    let n = ((t1 - t0) / math::FRAC_PI_2).ceil().max(1.0) as usize;
    let dt = (t1 - t0) / n as f64;
    let at = |t: f64| {
        let (s, c) = math::sin_cos(t);
        o + a * c + b * s
    };
    (0..n)
        .map(|i| {
            let ta = t0 + dt * i as f64;
            let tb = if i + 1 == n {
                t1
            } else {
                t0 + dt * (i + 1) as f64
            };
            let half = 0.5 * (tb - ta);
            let (s, c) = math::sin_cos(ta + half);
            let ch = math::cos(half);
            Bez {
                p: vec![at(ta), o + (a * c + b * s) / ch, at(tb)],
                w: vec![1.0, ch, 1.0],
            }
        })
        .collect()
}

// Knot values are compared exactly: multiplicities and span ends are defined by equal knots.
#[allow(clippy::float_cmp)]
/// The Bézier segments of a B-spline over `[t0, t1]` (clamped where the range reaches the
/// ends of its domain). A range beyond the knot domain follows the polynomial continuation
/// of the end span, as B-spline evaluation does (an edge extended past its input end keeps
/// its pcurve): the end segment is extended by de Casteljau extrapolation.
fn nurbs(n: &NurbsCurve2, t0: f64, t1: f64) -> Option<Vec<Bez>> {
    let p = n.degree();
    let (a, b) = n.domain();
    let (c0, c1) = (t0.max(a), t1.min(b));
    if c0 >= c1 {
        return None;
    }
    let k = n.knots();
    let len = k.len();
    if (c0 <= a && !k[..=p].iter().all(|&x| x == a))
        || (c1 >= b && !k[len - 1 - p..].iter().all(|&x| x == b))
    {
        return None;
    }
    let mut cuts: Vec<f64> = Vec::new();
    if c0 > a {
        cuts.push(c0);
    }
    for &x in k {
        if x > c0 && x < c1 && cuts.last() != Some(&x) {
            cuts.push(x);
        }
    }
    if c1 < b {
        cuts.push(c1);
    }
    let mut c = n.clone();
    for u in cuts {
        let m = c.knots().iter().filter(|&&x| x == u).count();
        if m < p {
            c = c.insert_knot(u, p - m).ok()?;
        }
    }
    let k = c.knots();
    let cp = c.control_points();
    let mut out: Vec<(f64, f64, Bez)> = Vec::new();
    let mut reach = c0;
    for j in p..cp.len() {
        let (lo, hi) = (k[j], k[j + 1]);
        if hi <= lo || lo < c0 || hi > c1 {
            continue;
        }
        if lo != reach {
            return None;
        }
        reach = hi;
        out.push((
            lo,
            hi,
            Bez {
                p: (j - p..=j)
                    .map(|i| Point2::new(cp[i][0], cp[i][1]))
                    .collect(),
                w: (j - p..=j).map(|i| c.weight(i)).collect(),
            },
        ));
    }
    if reach != c1 || out.is_empty() {
        return None;
    }
    if t0 < c0 {
        let (lo, hi, bz) = out.remove(0);
        let (_, ext) = bz.split_at((t0 - lo) / (hi - lo));
        if !ext.weights_ok() {
            return None;
        }
        out.insert(0, (t0, hi, ext));
    }
    if t1 > c1 {
        let (lo, hi, bz) = out.pop().expect("segments");
        let (ext, _) = bz.split_at((t1 - lo) / (hi - lo));
        if !ext.weights_ok() {
            return None;
        }
        out.push((lo, t1, ext));
    }
    Some(out.into_iter().map(|x| x.2).collect())
}

/// The rational Bézier segments of `pc` over `range`, in traversal order (`fwd` false:
/// from `range.1` to `range.0`). `None` for an empty range or a B-spline that cannot be
/// cut (unclamped at an end of the range).
pub(crate) fn pieces(pc: &Curve2, range: (f64, f64), fwd: bool) -> Option<Vec<Bez>> {
    let (t0, t1) = range;
    if t0.is_nan() || t1.is_nan() || t0 >= t1 {
        return None;
    }
    let mut out = match pc {
        Curve2::Line(l) => vec![Bez::line(l.eval(t0), l.eval(t1))],
        Curve2::Circle(c) => conic(
            c.center(),
            Vec2::new(c.radius(), 0.0),
            Vec2::new(0.0, c.radius()),
            t0,
            t1,
        ),
        Curve2::Ellipse(e) => conic(
            e.center(),
            e.x_dir() * e.rx(),
            e.x_dir().perp() * e.ry(),
            t0,
            t1,
        ),
        Curve2::BSpline(n) => nurbs(n, t0, t1)?,
        // A spiral (a modelled thread's end on a plane) has no rational Bézier form:
        // undecided, never assumed clear.
        Curve2::Spiral(_) => return None,
    };
    if !fwd {
        out.reverse();
        out = out.iter().map(Bez::reversed).collect();
    }
    Some(out)
}

/// The parameter-space tolerance of a face on `surf` whose domain box is `lo..hi`:
/// `LINEAR_TOLERANCE` over a bound of the surface's metric (at least 1).
pub(crate) fn face_tol(surf: &Surface, lo: Point2, hi: Point2) -> f64 {
    let m = match surf {
        Surface::Plane(_) | Surface::BSpline(_) => 1.0,
        Surface::Cylinder(c) => c.radius(),
        Surface::Sphere(s) => s.radius(),
        Surface::Torus(t) => t.major() + t.minor(),
        Surface::Cone(c) => {
            let r = c.radius_at(lo.y).abs().max(c.radius_at(hi.y).abs());
            r.max(1.0 / math::cos(c.half_angle()))
        }
        // |S_u| = √(v² + p²), |S_v| = √(1 + k²).
        Surface::Helicoid(h) => {
            let v = lo.y.abs().max(hi.y.abs());
            math::hypot(v, h.rise()).max(math::hypot(1.0, h.slope()))
        }
    };
    LINEAR_TOLERANCE / m.max(1.0)
}

/// Unit tangent and signed curvature (about the tangent's left normal) of `b` at its start.
fn leave(b: &Bez) -> Option<(Vec2, f64)> {
    let d1 = b.p[1] - b.p[0];
    let len = d1.norm();
    let t = d1.normalize()?;
    if b.p.len() == 2 {
        return Some((t, 0.0));
    }
    let n = (b.p.len() - 1) as f64;
    let d2 = b.p[2] - b.p[1];
    let k = ((n - 1.0) / n) * (b.w[0] * b.w[2] / (b.w[1] * b.w[1])) * d1.perp_dot(d2)
        / (len * len * len);
    k.is_finite().then_some((t, k))
}

/// Radius of the ball around a joint of `a` and `b` (both starting at the joint) in which
/// contacts are ignored: at least `JOINT_BALL · tol`; where the pieces leave the joint at an
/// acute angle or tangentially (a cusp, as where a concave blend's profile arc meets the
/// face it is tangent to), the distance at which the local model of their separation,
/// `|sin θ|·s + |Δκ|·s²/2`, reaches `4·tol` — so the contacts ignored are within about
/// `4·tol` of each other — capped at half the shorter piece (beyond that, curves that stay
/// together, a fold-back, meet).
fn joint_radius(a: &Bez, b: &Bez, tol: f64) -> f64 {
    let base = JOINT_BALL * tol;
    let (Some((ta, ka)), Some((tb, kb))) = (leave(a), leave(b)) else {
        return base;
    };
    if ta.dot(tb) <= 0.0 {
        return base;
    }
    let sin = ta.perp_dot(tb).abs();
    let dk = (ka - kb).abs();
    let target = 4.0 * tol;
    let rho = if dk > 0.0 {
        (-sin + math::sqrt(sin * sin + 2.0 * dk * target)) / dk
    } else if sin > 0.0 {
        target / sin
    } else {
        f64::INFINITY
    };
    let cap = 0.5 * a.start().distance(a.end()).min(b.start().distance(b.end()));
    if rho.is_nan() || rho <= base {
        return base;
    }
    rho.min(cap).max(base)
}

/// End point identity of a use: a vertex, or the closure point of a ring edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum End {
    V(usize),
    Ring(usize),
}

#[derive(Clone, Debug)]
struct Use {
    edge: usize,
    start: (End, Point2),
    end: (End, Point2),
    /// Indices of its first and last piece.
    first: usize,
    last: usize,
}

/// The boundary of one face in its parameter plane, as rational Bézier segments (loops
/// lifted so that consecutive pieces continue each other across periods).
#[derive(Clone, Debug)]
pub(crate) struct Boundary {
    /// The face's parameter-space tolerance ([`face_tol`]).
    pub tol: f64,
    per: (Option<f64>, Option<f64>),
    sense: bool,
    pieces: Vec<Bez>,
    piece_use: Vec<usize>,
    uses: Vec<Use>,
    /// Edges whose pcurve could not be converted (the face cannot be certified).
    pub unconverted: Vec<usize>,
    /// Segments closing the gaps between consecutive uses of a loop (their pcurves are
    /// evaluated separately at the shared vertex and may differ by rounding): the point test
    /// needs each loop as one closed chain, or a ray through a vertex can slip through.
    joints: Vec<Bez>,
}

/// Point-in-face verdict ([`Boundary::contains_ex`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Inside {
    In,
    Out,
    /// Within about `tol` of the boundary.
    Boundary,
    /// Not certified.
    Unknown,
}

impl Boundary {
    /// The boundary of face `f` of `plan`; `None` when the face is absent or a use has no
    /// pcurve.
    pub fn of_face(plan: &Plan, f: usize) -> Option<Boundary> {
        let face = plan.fs[f].as_ref()?;
        let (pu, pv) = face.surf.periodicity();
        let mut segs: Vec<Bez> = Vec::new();
        let mut piece_use = Vec::new();
        let mut uses = Vec::new();
        let mut unconverted = Vec::new();
        let mut joints: Vec<Bez> = Vec::new();
        for lp in &face.loops {
            let loop_first = segs.len();
            let mut prev: Option<Point2> = None;
            for u in lp {
                let e = &plan.es[u.edge];
                let pc = u.pc.as_ref()?;
                let Some(mut ps) = pieces(pc, e.range, u.fwd) else {
                    unconverted.push(u.edge);
                    continue;
                };
                if let Some(p0) = prev {
                    let s = ps[0].start();
                    let du = pu.map_or(0.0, |p| ((p0.x - s.x) / p).round() * p);
                    let dv = pv.map_or(0.0, |p| ((p0.y - s.y) / p).round() * p);
                    if du != 0.0 || dv != 0.0 {
                        ps = ps.iter().map(|b| b.shifted(Vec2::new(du, dv))).collect();
                    }
                }
                prev = Some(ps[ps.len() - 1].end());
                let (s, en) = if e.is_ring() {
                    (End::Ring(u.edge), End::Ring(u.edge))
                } else {
                    let (a, b) = (End::V(e.start.expect("open")), End::V(e.end.expect("open")));
                    if u.fwd { (a, b) } else { (b, a) }
                };
                let ui = uses.len();
                uses.push(Use {
                    edge: u.edge,
                    start: (s, ps[0].start()),
                    end: (en, ps[ps.len() - 1].end()),
                    first: segs.len(),
                    last: segs.len() + ps.len() - 1,
                });
                for b in ps {
                    segs.push(b);
                    piece_use.push(ui);
                }
            }
            // Close the loop's chain: a segment across every gap between consecutive pieces
            // (the last one to the first, in the period copy nearest it).
            let n = segs.len() - loop_first;
            for k in 0..n {
                let a = segs[loop_first + k].end();
                let mut b = segs[loop_first + (k + 1) % n].start();
                if k + 1 == n {
                    b.x += pu.map_or(0.0, |p| ((a.x - b.x) / p).round() * p);
                    b.y += pv.map_or(0.0, |p| ((a.y - b.y) / p).round() * p);
                }
                // (A zero-length joint crosses nothing and is harmless.)
                joints.push(Bez::line(a, b));
            }
        }
        let (mut lo, mut hi) = (
            Point2::new(f64::INFINITY, f64::INFINITY),
            Point2::new(f64::NEG_INFINITY, f64::NEG_INFINITY),
        );
        for b in &segs {
            let (l, h) = b.bbox();
            lo = Point2::new(lo.x.min(l.x), lo.y.min(l.y));
            hi = Point2::new(hi.x.max(h.x), hi.y.max(h.y));
        }
        let tol = if segs.is_empty() {
            LINEAR_TOLERANCE
        } else {
            face_tol(&face.surf, lo, hi)
        };
        Some(Boundary {
            tol,
            per: (pu, pv),
            sense: face.sense,
            pieces: segs,
            piece_use,
            uses,
            unconverted,
            joints,
        })
    }

    /// Whole-period shifts of `b` that can bring it near `a` (the zero shift included).
    fn shifts(&self, a: (Point2, Point2), b: (Point2, Point2)) -> Vec<Vec2> {
        let range = |per: Option<f64>, alo: f64, ahi: f64, blo: f64, bhi: f64| -> Vec<f64> {
            match per {
                Some(p) => {
                    let pad = self.tol;
                    let k0 = ((alo - bhi - pad) / p).ceil() as i64;
                    let k1 = ((ahi - blo + pad) / p).floor() as i64;
                    let mut v: Vec<f64> = (k0..=k1).map(|k| k as f64 * p).collect();
                    if !v.contains(&0.0) {
                        v.push(0.0);
                    }
                    v
                }
                None => vec![0.0],
            }
        };
        let us = range(self.per.0, a.0.x, a.1.x, b.0.x, b.1.x);
        let vs = range(self.per.1, a.0.y, a.1.y, b.0.y, b.1.y);
        us.iter()
            .flat_map(|&du| vs.iter().map(move |&dv| Vec2::new(du, dv)))
            .collect()
    }

    /// The piece of use `u` at its start (`at_start`) or end, oriented away from that end.
    fn leaving(&self, u: usize, at_start: bool) -> Bez {
        let us = &self.uses[u];
        if at_start {
            self.pieces[us.first].clone()
        } else {
            self.pieces[us.last].reversed()
        }
    }

    /// Joint balls of uses `ua` and `ub` (the latter shifted by `s`): around every end point
    /// they share, of the radius [`joint_radius`] gives.
    fn joint_balls(&self, ua: usize, ub: usize, s: Vec2) -> Vec<(Point2, f64)> {
        let (a, b) = (&self.uses[ua], &self.uses[ub]);
        let mut out = Vec::new();
        for (ia, (ea, pa)) in [a.start, a.end].into_iter().enumerate() {
            for (ib, (eb, pb)) in [b.start, b.end].into_iter().enumerate() {
                let pb = pb + s;
                let gap = pa.distance(pb);
                if ea == eb && gap <= JOINT_GAP * self.tol {
                    let la = self.leaving(ua, ia == 0);
                    let lb = self.leaving(ub, ib == 0).shifted(s);
                    out.push((pa, joint_radius(&la, &lb, self.tol) + gap));
                }
            }
        }
        out
    }

    /// Pairs of edges of the face (smaller index first) whose images meet or come within
    /// `tol` of each other away from the vertices they share, including the periodic copies;
    /// deduplicated, in the order found. An edge whose pcurve cannot be converted is paired
    /// with itself (not certified). Test helper: the operations use [`Boundary::crossings_ex`].
    #[cfg(test)]
    pub fn crossings(&self) -> Vec<(usize, usize)> {
        let (mut found, open) = self.crossings_ex();
        for k in open {
            if !found.contains(&k) {
                found.push(k);
            }
        }
        found
    }

    /// [`Boundary::crossings`] split into the pairs found to meet ([`Meet::Near`]) and the
    /// pairs left unresolved (the work budget or the depth limit, or an unconverted pcurve,
    /// paired with itself).
    pub fn crossings_ex(&self) -> (EdgePairs, EdgePairs) {
        let mut open: Vec<(usize, usize)> = self.unconverted.iter().map(|&e| (e, e)).collect();
        let mut out: Vec<(usize, usize)> = Vec::new();
        let n = self.pieces.len();
        let boxes: Vec<(Point2, Point2)> = self.pieces.iter().map(Bez::bbox).collect();
        let mut budget = crossings_budget();
        for i in 0..n {
            for j in i..n {
                let (ui, uj) = (self.piece_use[i], self.piece_use[j]);
                let (ei, ej) = (self.uses[ui].edge, self.uses[uj].edge);
                let key = (ei.min(ej), ei.max(ej));
                if out.contains(&key) {
                    continue;
                }
                for s in self.shifts(boxes[i], boxes[j]) {
                    let zero = s.x == 0.0 && s.y == 0.0;
                    if zero && ui == uj {
                        continue;
                    }
                    let bj = (boxes[j].0 + s, boxes[j].1 + s);
                    if box_gap(boxes[i], bj) > self.tol {
                        continue;
                    }
                    let b = self.pieces[j].shifted(s);
                    let balls = self.joint_balls(ui, uj, s);
                    match meet_ex(&self.pieces[i], &b, self.tol, &balls, &mut budget) {
                        Meet::Apart => {}
                        Meet::Near => {
                            out.push(key);
                            open.retain(|k| *k != key);
                            break;
                        }
                        Meet::Unresolved => {
                            if !open.contains(&key) {
                                open.push(key);
                            }
                        }
                    }
                }
            }
        }
        (out, open)
    }

    /// Does the curve given by `other` (pieces in this face's parameter plane) come within
    /// `tol` of the boundary, outside the balls `balls`? [`Meet::Apart`] is certified,
    /// [`Meet::Near`] found; [`Meet::Unresolved`] when the budget or the depth limit ran out
    /// first or a pcurve could not be converted (W6 review round 5: undecided, not a meeting).
    pub fn meets_curve(&self, other: &[Bez], balls: &[(Point2, f64)]) -> Meet {
        if !self.unconverted.is_empty() {
            return Meet::Unresolved;
        }
        // The balls' centres come from projections (canonical parameters), the loops may be
        // lifted into other period copies: every nearby copy of each ball counts.
        let ks = |p: Option<f64>| -> Vec<f64> {
            p.map_or(vec![0.0], |p| (-2..=2).map(|k| k as f64 * p).collect())
        };
        let balls: Vec<(Point2, f64)> = balls
            .iter()
            .flat_map(|&(c, r)| {
                let (us, vs) = (ks(self.per.0), ks(self.per.1));
                us.into_iter().flat_map(move |du| {
                    vs.clone()
                        .into_iter()
                        .map(move |dv| (c + Vec2::new(du, dv), r))
                })
            })
            .collect();
        let balls = &balls[..];
        let mut budget = crossings_budget();
        let mut open = false;
        for o in other {
            let ob = o.bbox();
            for b in &self.pieces {
                let bb = b.bbox();
                for s in self.shifts(ob, bb) {
                    if box_gap(ob, (bb.0 + s, bb.1 + s)) > self.tol {
                        continue;
                    }
                    match meet_ex(o, &b.shifted(s), self.tol, balls, &mut budget) {
                        Meet::Apart => {}
                        Meet::Near => return Meet::Near,
                        Meet::Unresolved => open = true,
                    }
                }
            }
        }
        if open { Meet::Unresolved } else { Meet::Apart }
    }

    /// Is `q` farther than `tol` from every periodic copy of the boundary?
    fn clear(&self, q: Point2) -> bool {
        for b in self.pieces.iter().chain(&self.joints) {
            let bb = b.bbox();
            let qb = (q, q);
            for s in self.shifts(qb, bb) {
                if box_point_dist((bb.0 + s, bb.1 + s), q) > self.tol {
                    continue;
                }
                if !clear_of(&b.shifted(s), q, self.tol) {
                    return false;
                }
            }
        }
        true
    }

    /// Point in face (see the module docs): `Some(inside)`, or `None` when `q` is within
    /// `tol` of the boundary or the answer is not certified.
    pub fn contains(&self, q: Point2) -> Option<bool> {
        match self.contains_ex(q) {
            Inside::In => Some(true),
            Inside::Out => Some(false),
            Inside::Boundary | Inside::Unknown => None,
        }
    }

    /// [`Boundary::contains`] with its `None` split (W6 review round 5): [`Inside::Boundary`]
    /// when `q` is within about `tol` of the boundary (found by subdivision down to flat
    /// pieces), [`Inside::Unknown`] when the answer is not certified (an unconverted pcurve,
    /// the work budget or the depth limit).
    pub fn contains_ex(&self, q: Point2) -> Inside {
        if !self.unconverted.is_empty() {
            return Inside::Unknown;
        }
        if self.pieces.is_empty() {
            return Inside::In;
        }
        if !self.clear(q) {
            return Inside::Boundary;
        }
        let (pu, pv) = self.per;
        // Cast along `across` from `q`, the coordinate `along` fixed.
        let (along, per_along, per_across) = if pv.is_some() && pu.is_none() {
            (1usize, pv, pu)
        } else {
            (0usize, pu, pv)
        };
        let c = |p: Point2, i: usize| if i == 0 { p.x } else { p.y };
        let across = 1 - along;
        let (qa, qc) = (c(q, along), c(q, across));
        let tol = self.tol;
        // Crossings: (distance range from q along ±across, net along-direction, piece).
        #[derive(Clone)]
        struct Cr {
            lo: f64,
            hi: f64,
            dir: i32,
            up: bool,
            bez: Bez,
            depth: u32,
        }
        let mut crs: Vec<Cr> = Vec::new();
        let mut stack: Vec<(Bez, u32)> = Vec::new();
        for b in self.pieces.iter().chain(&self.joints) {
            let (lo, hi) = b.bbox();
            let (alo, ahi) = (c(lo, along), c(hi, along));
            match per_along {
                Some(p) => {
                    let k0 = ((alo - qa) / p).ceil() as i64;
                    let k1 = ((ahi - qa) / p).floor() as i64;
                    for k in k0..=k1 {
                        let d = -(k as f64) * p;
                        let s = if along == 0 {
                            Vec2::new(d, 0.0)
                        } else {
                            Vec2::new(0.0, d)
                        };
                        stack.push((b.shifted(s), 0));
                    }
                }
                None => {
                    if alo <= qa && ahi >= qa {
                        stack.push((b.clone(), 0));
                    }
                }
            }
        }
        // Classify one piece against the ray's line; push crossings or split.
        let mut work = 0usize;
        let classify =
            |b: Bez, depth: u32, stack: &mut Vec<(Bez, u32)>, crs: &mut Vec<Cr>| -> bool {
                let side = |p: &Point2| c(*p, along) > qa;
                let sides: Vec<bool> = b.p.iter().map(side).collect();
                let changes = sides.windows(2).filter(|w| w[0] != w[1]).count();
                if changes == 0 {
                    return true;
                }
                if changes >= 2 {
                    if depth >= MAX_DEPTH {
                        return false;
                    }
                    let (x, y) = b.split();
                    stack.push((x, depth + 1));
                    stack.push((y, depth + 1));
                    return true;
                }
                let dir = if sides[sides.len() - 1] { 1 } else { -1 };
                let (lo, hi) = b.bbox();
                let (clo, chi) = (c(lo, across), c(hi, across));
                let push = |lo: f64, hi: f64, up: bool, crs: &mut Vec<Cr>| {
                    crs.push(Cr {
                        lo,
                        hi,
                        dir,
                        up,
                        bez: b.clone(),
                        depth,
                    });
                };
                match per_across {
                    None => {
                        if clo - qc > 0.0 {
                            push(clo - qc, chi - qc, true, crs);
                            return true;
                        }
                        if chi - qc < 0.0 {
                            push(qc - chi, qc - clo, false, crs);
                            return true;
                        }
                    }
                    Some(p) => {
                        let lo_m = math::rem_euclid(clo - qc, p);
                        if lo_m > 0.0 && lo_m + (chi - clo) < p {
                            push(lo_m, lo_m + (chi - clo), true, crs);
                            return true;
                        }
                    }
                }
                // The piece's hull straddles q on the line: refine (q is clear of the curve).
                if depth >= MAX_DEPTH {
                    return false;
                }
                let (x, y) = b.split();
                stack.push((x, depth + 1));
                stack.push((y, depth + 1));
                true
            };
        while let Some((b, d)) = stack.pop() {
            work += 1;
            if work > MEET_BUDGET || !classify(b, d, &mut stack, &mut crs) {
                return Inside::Unknown;
            }
        }
        // The nearest crossing towards +across, else towards −across (a face running up to a
        // pole or apex on that side).
        for up in [true, false] {
            if !up && per_across.is_some() {
                break;
            }
            let mut side: Vec<Cr> = crs.iter().filter(|x| x.up == up).cloned().collect();
            loop {
                if side.is_empty() {
                    break;
                }
                work += 1;
                if work > MEET_BUDGET {
                    return Inside::Unknown;
                }
                side.sort_by(|a, b| a.lo.total_cmp(&b.lo));
                // The cluster of crossings overlapping the nearest one (transitively).
                let mut hi = side[0].hi;
                let mut m = 1;
                while m < side.len() && side[m].lo <= hi {
                    hi = hi.max(side[m].hi);
                    m += 1;
                }
                if m == 1 {
                    let d_along = side[0].dir as f64;
                    let sign = if up { 1.0 } else { -1.0 };
                    let left = if along == 0 {
                        d_along * sign < 0.0
                    } else {
                        d_along * sign > 0.0
                    };
                    return if left == self.sense {
                        Inside::In
                    } else {
                        Inside::Out
                    };
                }
                let tiny = side[..m].iter().all(|x| x.hi - x.lo <= tol);
                if tiny {
                    let net: i32 = side[..m].iter().map(|x| x.dir).sum();
                    if net == 0 {
                        side.drain(..m);
                        continue;
                    }
                    let d_along = net.signum() as f64;
                    let sign = if up { 1.0 } else { -1.0 };
                    let left = if along == 0 {
                        d_along * sign < 0.0
                    } else {
                        d_along * sign > 0.0
                    };
                    return if left == self.sense {
                        Inside::In
                    } else {
                        Inside::Out
                    };
                }
                // Refine the wide members of the cluster.
                let mut rest: Vec<Cr> = side.split_off(m);
                let cluster = std::mem::take(&mut side);
                let mut sub: Vec<Cr> = Vec::new();
                for x in cluster {
                    if x.hi - x.lo <= tol {
                        sub.push(x);
                        continue;
                    }
                    if x.depth >= MAX_DEPTH {
                        return Inside::Unknown;
                    }
                    let (a, b) = x.bez.split();
                    let mut st = vec![(a, x.depth + 1), (b, x.depth + 1)];
                    let mut found: Vec<Cr> = Vec::new();
                    while let Some((bz, d)) = st.pop() {
                        work += 1;
                        if work > MEET_BUDGET || !classify(bz, d, &mut st, &mut found) {
                            return Inside::Unknown;
                        }
                    }
                    sub.extend(found.into_iter().filter(|y| y.up == up));
                }
                sub.append(&mut rest);
                side = sub;
            }
        }
        Inside::Out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::geom::{Circle2, Ellipse2, Line2};

    /// Point of a rational Bézier at `s` (de Casteljau).
    fn eval(b: &Bez, s: f64) -> Point2 {
        let mut h: Vec<[f64; 3]> =
            b.p.iter()
                .zip(&b.w)
                .map(|(p, w)| [p.x * w, p.y * w, *w])
                .collect();
        let n = h.len();
        for k in 1..n {
            for i in 0..(n - k) {
                let next = h[i + 1];
                for (x, y) in h[i].iter_mut().zip(next) {
                    *x = (1.0 - s) * *x + s * y;
                }
            }
        }
        Point2::new(h[0][0] / h[0][2], h[0][1] / h[0][2])
    }

    fn circle(cx: f64, cy: f64, r: f64) -> Curve2 {
        Circle2::new(Point2::new(cx, cy), r).unwrap().into()
    }

    #[test]
    fn conic_pieces_lie_on_the_conic() {
        let c = circle(1.0, -2.0, 3.0);
        let ps = pieces(&c, (0.3, 5.9), true).unwrap();
        assert_eq!(ps.len(), 4);
        assert!(ps[0].start().distance(c.eval(0.3)) < 1e-14);
        assert!(ps[3].end().distance(c.eval(5.9)) < 1e-14);
        for b in &ps {
            for k in 0..=16 {
                let q = eval(b, k as f64 / 16.0);
                let d = (q.distance(Point2::new(1.0, -2.0)) - 3.0).abs();
                assert!(d < 1e-13, "{d}");
            }
        }
        let e: Curve2 = Ellipse2::new(Point2::new(0.5, 0.5), Vec2::new(1.0, 1.0), 4.0, 1.5)
            .unwrap()
            .into();
        let ps = pieces(&e, (-1.0, 2.0), false).unwrap();
        assert!(ps[0].start().distance(e.eval(2.0)) < 1e-14);
        for b in &ps {
            for k in 0..=16 {
                let q = eval(b, k as f64 / 16.0);
                let (_, d) = e.project(q);
                assert!(d < 1e-12, "{d}");
            }
        }
    }

    #[test]
    fn bspline_pieces_reproduce_the_curve() {
        let n = NurbsCurve2::new(
            3,
            vec![0.0, 0.0, 0.0, 0.0, 1.0, 2.5, 4.0, 4.0, 4.0, 4.0],
            vec![
                [0.0, 0.0],
                [1.0, 2.0],
                [2.0, -1.0],
                [3.0, 3.0],
                [5.0, 0.0],
                [6.0, 1.0],
            ],
            Some(vec![1.0, 2.0, 0.5, 1.0, 3.0, 1.0]),
        )
        .unwrap();
        let c: Curve2 = n.into();
        let ps = pieces(&c, (0.4, 3.7), true).unwrap();
        assert_eq!(ps.len(), 3);
        assert!(ps[0].start().distance(c.eval(0.4)) < 1e-12);
        assert!(ps[2].end().distance(c.eval(3.7)) < 1e-12);
        // The union of the pieces' samples lies on the curve.
        for b in &ps {
            for k in 0..=8 {
                let q = eval(b, k as f64 / 8.0);
                let (_, d) = c.project(q);
                assert!(d < 1e-9, "{d}");
            }
        }
    }

    #[test]
    fn bspline_ranges_beyond_the_domain_follow_the_end_spans() {
        let n = NurbsCurve2::new(
            2,
            vec![0.0, 0.0, 0.0, 1.0, 2.0, 2.0, 2.0],
            vec![[0.0, 0.0], [1.0, 1.0], [2.0, 0.0], [3.0, 1.0]],
            None,
        )
        .unwrap();
        let c: Curve2 = n.into();
        let ps = pieces(&c, (-0.5, 2.25), true).unwrap();
        assert_eq!(ps.len(), 2);
        assert!(ps[0].start().distance(c.eval(-0.5)) < 1e-12);
        assert!(ps[1].end().distance(c.eval(2.25)) < 1e-12);
        let line: Curve2 = NurbsCurve2::new(
            1,
            vec![0.0, 0.0, 8.0, 8.0],
            vec![[20.0, 10.0], [20.0, 18.0]],
            None,
        )
        .unwrap()
        .into();
        let ps = pieces(&line, (-1.5, 8.0), false).unwrap();
        assert_eq!(ps.len(), 1);
        assert!(ps[0].start().distance(Point2::new(20.0, 18.0)) < 1e-12);
        assert!(ps[0].end().distance(Point2::new(20.0, 8.5)) < 1e-12);
    }

    #[test]
    fn subdivision_keeps_the_curve() {
        let c = circle(0.0, 0.0, 10.0);
        let b = pieces(&c, (0.0, 1.5), true).unwrap().remove(0);
        let (l, r) = b.split();
        assert!(l.end().distance(r.start()) < 1e-14);
        for x in [&l, &r] {
            for k in 0..=8 {
                let q = eval(x, k as f64 / 8.0);
                assert!((q.norm() - 10.0).abs() < 1e-12);
            }
            assert!(x.width() < b.width());
        }
    }

    #[test]
    fn meet_detects_overlaps_below_any_sampling_resolution() {
        // Two circles of radius 40 whose gap is -1e-5 (overlap), at an angle between the
        // samples a 48-chord polyline would take.
        for deg in [0.0f64, 3.75, 11.25, 22.5, 41.0] {
            let a = deg.to_radians();
            let d = 80.0 - 1e-5;
            let c1 = circle(0.0, 0.0, 40.0);
            let c2 = circle(d * a.cos(), d * a.sin(), 40.0);
            let p1 = pieces(&c1, (0.0, math::TAU), true).unwrap();
            let p2 = pieces(&c2, (0.0, math::TAU), true).unwrap();
            let mut budget = MEET_BUDGET;
            let hit = p1
                .iter()
                .any(|x| p2.iter().any(|y| meet(x, y, 1e-6, &[], &mut budget)));
            assert!(hit, "overlap at {deg}° missed");
            // Apart by 1e-5: certified disjoint.
            let d = 80.0 + 1e-5;
            let c2 = circle(d * a.cos(), d * a.sin(), 40.0);
            let p2 = pieces(&c2, (0.0, math::TAU), true).unwrap();
            let hit = p1
                .iter()
                .any(|x| p2.iter().any(|y| meet(x, y, 1e-6, &[], &mut budget)));
            assert!(!hit, "false contact at {deg}°");
        }
    }

    #[test]
    fn joints_are_excluded_but_fold_backs_are_not() {
        let v = Point2::new(0.0, 0.0);
        let a = Bez::line(Point2::new(-5.0, 0.0), v);
        let ball = [(v, 1e-4)];
        let mut budget = MEET_BUDGET;
        // A corner at 90°.
        let b = Bez::line(v, Point2::new(0.0, 5.0));
        assert!(!meet(&a, &b, 1e-6, &ball, &mut budget));
        // A continuation.
        let b = Bez::line(v, Point2::new(5.0, 0.0));
        assert!(!meet(&a, &b, 1e-6, &ball, &mut budget));
        // A fold back along the same line.
        let b = Bez::line(v, Point2::new(-3.0, 1e-9));
        assert!(meet(&a, &b, 1e-6, &ball, &mut budget));
        // A diagonal line leaving the corner.
        let c: Curve2 = Line2::through(v, Point2::new(1.0, 1.0)).unwrap().into();
        let lp = pieces(&c, (0.0, 2.0), true).unwrap();
        assert!(!meet(&a, &lp[0], 1e-6, &ball, &mut budget));
        // An arc leaving the corner tangentially to `a`'s line (a G1 continuation), then
        // an arc that leaves it and comes back across `a` beyond the ball.
        let cont = pieces(&circle(0.0, 2.0, 2.0), (-math::FRAC_PI_2, 0.0), true).unwrap();
        assert!(cont[0].start().distance(v) < 1e-14);
        assert!(!meet(&a, &cont[0], 1e-6, &ball, &mut budget));
        let t0 = math::atan2(-0.1, 1.0);
        let back = pieces(&circle(-1.0, 0.1, 1.0f64.hypot(0.1)), (t0, t0 + 3.6), true).unwrap();
        assert!(back[0].start().distance(v) < 1e-12);
        assert!(back.iter().any(|x| meet(&a, x, 1e-6, &ball, &mut budget)));
    }

    #[test]
    fn a_ray_through_a_vertex_whose_pieces_do_not_meet_exactly_is_not_lost() {
        use crate::plan::{PE, PF, PU, Plan};
        use forge_core::geom::{Circle3, Curve3, Line3, Plane, Surface};
        use forge_core::linalg::{Frame, Point3};
        // A stadium-shaped hole whose east arc starts 4e-15 off the end of the top line
        // (as offset edges do), and a point below that vertex inside the hole.
        let prov = || crate::keys::derived("t", "x", "k");
        let mut plan = Plan::default();
        plan.shells.push(true);
        let v = |plan: &mut Plan, x: f64, y: f64| plan.add_v(Point3::new(x, y, 0.0), prov());
        let (a, b, c, d) = (
            v(&mut plan, 9.5, 5.6),
            v(&mut plan, 17.5, 5.6),
            v(&mut plan, 17.5, 17.4),
            v(&mut plan, 9.5, 17.4),
        );
        let line = |plan: &mut Plan, s: usize, e: usize, p: Point3, q: Point3| {
            let dir = (q - p).normalize().unwrap();
            plan.add_e(PE {
                curve: Curve3::Line(Line3::new(p, dir).unwrap()),
                range: (0.0, p.distance(q)),
                start: Some(s),
                end: Some(e),
                tol: LINEAR_TOLERANCE,
                prov: prov(),
            })
        };
        let arc = |plan: &mut Plan, s: usize, e: usize, cx: f64, t0: f64, t1: f64| {
            plan.add_e(PE {
                curve: Curve3::Circle(
                    Circle3::new(Frame::world().with_origin(Point3::new(cx, 11.5, 0.0)), 5.9)
                        .unwrap(),
                ),
                range: (t0, t1),
                start: Some(s),
                end: Some(e),
                tol: LINEAR_TOLERANCE,
                prov: prov(),
            })
        };
        let bot = line(
            &mut plan,
            a,
            b,
            Point3::new(9.5, 5.6, 0.0),
            Point3::new(17.5, 5.6, 0.0),
        );
        let east = arc(
            &mut plan,
            b,
            c,
            17.5 + 4e-15,
            -math::FRAC_PI_2,
            math::FRAC_PI_2,
        );
        let top = line(
            &mut plan,
            c,
            d,
            Point3::new(17.5, 17.4, 0.0),
            Point3::new(9.5, 17.4, 0.0),
        );
        let west = arc(&mut plan, d, a, 9.5, math::FRAC_PI_2, 3.0 * math::FRAC_PI_2);
        let o = [(0.0, 0.0), (27.0, 0.0), (27.0, 23.0), (0.0, 23.0)];
        let ov: Vec<usize> = o.iter().map(|&(x, y)| v(&mut plan, x, y)).collect();
        let mut outer = Vec::new();
        for i in 0..4 {
            let (p, q) = (o[i], o[(i + 1) % 4]);
            let e = line(
                &mut plan,
                ov[i],
                ov[(i + 1) % 4],
                Point3::new(p.0, p.1, 0.0),
                Point3::new(q.0, q.1, 0.0),
            );
            outer.push(PU {
                edge: e,
                fwd: true,
                pc: None,
            });
        }
        let hole: Vec<PU> = [west, top, east, bot]
            .into_iter()
            .map(|e| PU {
                edge: e,
                fwd: false,
                pc: None,
            })
            .collect();
        let f = plan.add_f(PF {
            surf: Surface::Plane(Plane::new(Frame::world())),
            sense: true,
            prov: prov(),
            loops: vec![outer, hole],
            shell: 0,
            hint: None,
        });
        plan.fill_pcurves().unwrap();
        let bd = Boundary::of_face(&plan, f).unwrap();
        assert_eq!(bd.contains(Point2::new(17.5, 6.5)), Some(false));
        assert_eq!(bd.contains(Point2::new(17.5, 3.0)), Some(true));
        assert_eq!(bd.contains(Point2::new(17.5, 20.0)), Some(true));
        assert_eq!(bd.contains(Point2::new(9.5, 10.0)), Some(false));
    }

    #[test]
    fn points_are_classified_with_a_clearance_certificate() {
        use crate::plan::{PE, PF, PU, Plan};
        use forge_core::geom::{Circle3, Cylinder, Plane, Surface};
        use forge_core::linalg::{Frame, Point3};
        // An annulus in the plane z = 0 (outer radius 5, inner 2), and a cylinder band.
        let prov = || crate::keys::derived("t", "x", "k");
        let mut plan = Plan::default();
        let ring = |r: f64, z: f64| PE {
            curve: forge_core::geom::Curve3::Circle(
                Circle3::new(Frame::world().with_origin(Point3::new(0.0, 0.0, z)), r).unwrap(),
            ),
            range: (0.0, math::TAU),
            start: None,
            end: None,
            tol: LINEAR_TOLERANCE,
            prov: prov(),
        };
        let (o, i) = (plan.add_e(ring(5.0, 0.0)), plan.add_e(ring(2.0, 0.0)));
        plan.shells.push(true);
        let f = plan.add_f(PF {
            surf: Surface::Plane(Plane::new(Frame::world())),
            sense: true,
            prov: prov(),
            loops: vec![
                vec![PU {
                    edge: o,
                    fwd: true,
                    pc: None,
                }],
                vec![PU {
                    edge: i,
                    fwd: false,
                    pc: None,
                }],
            ],
            shell: 0,
            hint: None,
        });
        let (top, bot) = (plan.add_e(ring(5.0, 3.0)), plan.add_e(ring(5.0, -1.0)));
        let g = plan.add_f(PF {
            surf: Surface::Cylinder(Cylinder::new(Frame::world(), 5.0).unwrap()),
            sense: true,
            prov: prov(),
            loops: vec![
                vec![PU {
                    edge: top,
                    fwd: false,
                    pc: None,
                }],
                vec![PU {
                    edge: bot,
                    fwd: true,
                    pc: None,
                }],
            ],
            shell: 0,
            hint: Some(Point2::new(1.0, 1.0)),
        });
        plan.fill_pcurves().unwrap();
        let bd = Boundary::of_face(&plan, f).unwrap();
        assert!(bd.crossings().is_empty());
        assert_eq!(bd.contains(Point2::new(3.0, 0.5)), Some(true));
        assert_eq!(bd.contains(Point2::new(0.5, 0.5)), Some(false));
        assert_eq!(bd.contains(Point2::new(7.0, 0.0)), Some(false));
        assert_eq!(bd.contains(Point2::new(5.0 - 1e-3, 0.0)), Some(true));
        assert_eq!(bd.contains(Point2::new(5.0 + 1e-3, 0.0)), Some(false));
        // On the boundary (within tol): not certified.
        assert_eq!(bd.contains(Point2::new(5.0 + 1e-8, 0.0)), None);
        let s = std::f64::consts::FRAC_1_SQRT_2 * 2.0;
        assert_eq!(bd.contains(Point2::new(s, s)), None);
        let bc = Boundary::of_face(&plan, g).unwrap();
        assert!(bc.crossings().is_empty());
        for u in [0.0, 1.0, 3.0, 6.0, 9.0, -4.0] {
            assert_eq!(bc.contains(Point2::new(u, 1.0)), Some(true), "u {u}");
            assert_eq!(bc.contains(Point2::new(u, 3.5)), Some(false), "u {u}");
            assert_eq!(bc.contains(Point2::new(u, -1.5)), Some(false), "u {u}");
        }
    }
}
