//! 2D primitives of the sketch checks: arc parametrization, distances, and the contact
//! points of two curves (SPEC §3.1 stage 2).
//!
//! # Contact semantics and tolerances
//! Two curves are in **contact** where they intersect, touch, or come within the linear
//! tolerance `tol` of each other ([R-3]: inclusive). Contacts are found in closed form:
//! - **line/line**: proper crossings are decided **exactly** with [`orient2d`] (the four
//!   orientation signs); touches within `tol` are the endpoints of one segment within
//!   `tol` of the other (the closest approach of two non-crossing segments is always at
//!   an endpoint); an overlap is a collinear-within-`tol` stretch longer than `tol`.
//! - **line/arc**: the line meets the carrier circle at `sf ± √(r² − h²)` (`h` = distance
//!   centre→line, `sf` = foot parameter); `|h − r| ≤ tol` is a tangency at the foot point.
//!   Candidates count when they lie on the segment (±`tol`) and in the arc's angular range
//!   (±`tol/r`). Endpoints within `tol` of the other curve are touches.
//! - **arc/arc**: two-circle intersection; external/internal tangency when the centre
//!   distance is within `tol` of `r1 + r2` / `|r1 − r2|`; identical carrier circles (centres
//!   and radii within `tol`) overlap when their common angular range is longer than
//!   `tol` along the circle. Endpoint touches as above.
//!
//! The caller excuses contacts within `2·tol` of an endpoint the two curves share.
//! `r² − h²` is evaluated as `(r − h)(r + h)` so near-tangent roots keep full relative
//! accuracy; all transcendental functions go through `forge_core::math`.

use forge_core::linalg::Point2;
use forge_core::{math, orient2d};

/// Carrier circle and angular extent of an IR arc (SPEC §3 [R-6]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArcGeom {
    /// Centre.
    pub center: Point2,
    /// Radius `|start − center|`.
    pub radius: f64,
    /// Angle of `start − center`.
    pub start_angle: f64,
    /// Signed sweep in the IR direction (positive = counter-clockwise), `0 < |sweep| < 2π`.
    pub sweep: f64,
}

impl ArcGeom {
    /// Geometry of the IR arc `start → end` about `center`.
    pub fn from_ir(start: Point2, end: Point2, center: Point2, ccw: bool) -> Self {
        let ds = start - center;
        let de = end - center;
        let ts = math::atan2(ds.y, ds.x);
        let te = math::atan2(de.y, de.x);
        let sweep = if ccw {
            math::wrap_angle(te - ts, 0.0)
        } else {
            -math::wrap_angle(ts - te, 0.0)
        };
        Self {
            center,
            radius: ds.norm(),
            start_angle: ts,
            sweep,
        }
    }
    /// Point of the carrier circle at angle `a`.
    pub fn point_at(&self, a: f64) -> Point2 {
        circle_point(self.center, self.radius, a)
    }
    /// The carrier-circle point where the arc ends (may differ from the IR `end` by up to
    /// the tolerance).
    pub fn geometric_end(&self) -> Point2 {
        self.point_at(self.start_angle + self.sweep)
    }
    /// Counter-clockwise normalized primitive.
    pub fn prim(&self) -> Prim {
        let (t0, sweep) = if self.sweep > 0.0 {
            (self.start_angle, self.sweep)
        } else {
            (self.start_angle + self.sweep, -self.sweep)
        };
        Prim::Arc {
            c: self.center,
            r: self.radius,
            t0,
            sweep,
            full: false,
        }
    }
}

/// `center + r·(cos a, sin a)`.
pub fn circle_point(center: Point2, r: f64, a: f64) -> Point2 {
    let (s, c) = math::sin_cos(a);
    Point2::new(center.x + r * c, center.y + r * s)
}

/// A curve as a segment or a counter-clockwise arc.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Prim {
    /// Segment `a → b`.
    Seg {
        /// Start.
        a: Point2,
        /// End.
        b: Point2,
    },
    /// Counter-clockwise arc of the circle `(c, r)` over angles `[t0, t0 + sweep]`;
    /// `full` marks a whole circle.
    Arc {
        /// Centre.
        c: Point2,
        /// Radius.
        r: f64,
        /// Start angle.
        t0: f64,
        /// Sweep in `(0, 2π]`.
        sweep: f64,
        /// Whole circle.
        full: bool,
    },
}

impl Prim {
    /// A whole circle.
    pub fn circle(c: Point2, r: f64) -> Self {
        Prim::Arc {
            c,
            r,
            t0: 0.0,
            sweep: math::TAU,
            full: true,
        }
    }
    fn endpoints(&self) -> Vec<Point2> {
        match *self {
            Prim::Seg { a, b } => vec![a, b],
            Prim::Arc { full: true, .. } => vec![],
            Prim::Arc {
                c, r, t0, sweep, ..
            } => {
                vec![circle_point(c, r, t0), circle_point(c, r, t0 + sweep)]
            }
        }
    }
}

/// `true` if angle `t` lies in the counter-clockwise range `[t0, t0 + sweep]` widened by
/// `slack` radians on both ends.
pub fn contains_angle(t0: f64, sweep: f64, full: bool, t: f64, slack: f64) -> bool {
    if full {
        return true;
    }
    let d = math::wrap_angle(t - t0, 0.0);
    d <= sweep + slack || d >= math::TAU - slack
}

/// Distance from `p` to the segment `a → b` (non-degenerate).
pub fn dist_point_seg(p: Point2, a: Point2, b: Point2) -> f64 {
    let d = b - a;
    let t = ((p - a).dot(d) / d.norm_squared()).clamp(0.0, 1.0);
    p.distance(a + d * t)
}

/// Distance from `p` to an arc primitive.
pub fn dist_point_arc(p: Point2, c: Point2, r: f64, t0: f64, sweep: f64, full: bool) -> f64 {
    let v = p - c;
    let rho = v.norm();
    if full || (rho > 0.0 && contains_angle(t0, sweep, false, math::atan2(v.y, v.x), 0.0)) {
        return (rho - r).abs();
    }
    p.distance(circle_point(c, r, t0))
        .min(p.distance(circle_point(c, r, t0 + sweep)))
}

fn dist_point_prim(p: Point2, q: &Prim) -> f64 {
    match *q {
        Prim::Seg { a, b } => dist_point_seg(p, a, b),
        Prim::Arc {
            c,
            r,
            t0,
            sweep,
            full,
        } => dist_point_arc(p, c, r, t0, sweep, full),
    }
}

/// Contacts between two curves.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Contacts {
    /// Contact points (intersections, tangencies, touches within tolerance).
    pub points: Vec<Point2>,
    /// The curves share a stretch longer than the tolerance.
    pub overlap: bool,
}

/// All contacts between `p` and `q` (see the module docs).
pub fn contacts(p: &Prim, q: &Prim, tol: f64) -> Contacts {
    let mut out = match (*p, *q) {
        (Prim::Seg { a, b }, Prim::Seg { a: c, b: d }) => seg_seg(a, b, c, d, tol),
        (Prim::Seg { a, b }, arc @ Prim::Arc { .. })
        | (arc @ Prim::Arc { .. }, Prim::Seg { a, b }) => seg_arc(a, b, &arc, tol),
        (a1 @ Prim::Arc { .. }, a2 @ Prim::Arc { .. }) => arc_arc(&a1, &a2, tol),
    };
    // Endpoint touches, both ways.
    for e in p.endpoints() {
        if dist_point_prim(e, q) <= tol {
            out.points.push(e);
        }
    }
    for e in q.endpoints() {
        if dist_point_prim(e, p) <= tol {
            out.points.push(e);
        }
    }
    out
}

fn opposite(x: f64, y: f64) -> bool {
    (x > 0.0 && y < 0.0) || (x < 0.0 && y > 0.0)
}

/// Length of the overlap of segment `c → d` with segment `a → b` when both ends of `cd`
/// lie within `tol` of the line `ab` (0 otherwise).
fn collinear_overlap(a: Point2, b: Point2, c: Point2, d: Point2, tol: f64) -> f64 {
    let ab = b - a;
    let len = ab.norm();
    let dir = ab / len;
    if dir.perp_dot(c - a).abs() > tol || dir.perp_dot(d - a).abs() > tol {
        return 0.0;
    }
    let (qc, qd) = (dir.dot(c - a), dir.dot(d - a));
    let lo = qc.min(qd).max(0.0);
    let hi = qc.max(qd).min(len);
    hi - lo
}

fn seg_seg(a: Point2, b: Point2, c: Point2, d: Point2, tol: f64) -> Contacts {
    let mut out = Contacts::default();
    let (o1, o2) = (orient2d(a, b, c), orient2d(a, b, d));
    let (o3, o4) = (orient2d(c, d, a), orient2d(c, d, b));
    if opposite(o1, o2) && opposite(o3, o4) {
        // A proper crossing (decided exactly); the point itself is approximate.
        let (r, s) = (b - a, d - c);
        let t = (c - a).perp_dot(s) / r.perp_dot(s);
        out.points.push(a + r * t);
    }
    if collinear_overlap(a, b, c, d, tol) > tol || collinear_overlap(c, d, a, b, tol) > tol {
        out.overlap = true;
    }
    out
}

fn seg_arc(a: Point2, b: Point2, arc: &Prim, tol: f64) -> Contacts {
    let mut out = Contacts::default();
    let Prim::Arc {
        c,
        r,
        t0,
        sweep,
        full,
    } = *arc
    else {
        return out;
    };
    let d = b - a;
    let len = d.norm();
    let dh = d / len;
    let rel = c - a;
    let sf = rel.dot(dh);
    let h = dh.perp_dot(rel).abs();
    let mut cands = Vec::new();
    if (h - r).abs() <= tol {
        cands.push(sf);
    } else if h < r {
        let w = ((r - h) * (r + h)).sqrt();
        cands.push(sf - w);
        cands.push(sf + w);
    }
    for q in cands {
        if q >= -tol && q <= len + tol {
            let p = a + dh * q;
            let v = p - c;
            if contains_angle(t0, sweep, full, math::atan2(v.y, v.x), tol / r) {
                out.points.push(p);
            }
        }
    }
    out
}

/// Angular overlap (radians) of two counter-clockwise arcs of the same circle.
fn arc_overlap(t1: f64, s1: f64, f1: bool, t2: f64, s2: f64, f2: bool) -> f64 {
    if f1 || f2 {
        return s1.min(s2);
    }
    let u0 = t1 + math::wrap_angle(t2 - t1, 0.0);
    let mut tot = 0.0;
    for shift in [0.0, -math::TAU] {
        let lo = t1.max(u0 + shift);
        let hi = (t1 + s1).min(u0 + shift + s2);
        if hi > lo {
            tot += hi - lo;
        }
    }
    tot
}

fn arc_arc(p: &Prim, q: &Prim, tol: f64) -> Contacts {
    let mut out = Contacts::default();
    let (
        Prim::Arc {
            c: c1,
            r: r1,
            t0: t1,
            sweep: s1,
            full: f1,
        },
        Prim::Arc {
            c: c2,
            r: r2,
            t0: t2,
            sweep: s2,
            full: f2,
        },
    ) = (*p, *q)
    else {
        return out;
    };
    let dv = c2 - c1;
    let dd = dv.norm();
    if dd <= tol && (r1 - r2).abs() <= tol {
        if arc_overlap(t1, s1, f1, t2, s2, f2) * r1.max(r2) > tol {
            out.overlap = true;
        }
        return out;
    }
    if dd <= tol || dd > r1 + r2 + tol || dd < (r1 - r2).abs() - tol {
        return out;
    }
    let u = dv / dd;
    let mut pts = Vec::new();
    if (dd - (r1 + r2)).abs() <= tol {
        pts.push(c1 + u * r1);
    } else if (dd - (r1 - r2).abs()).abs() <= tol {
        pts.push(c1 + u * if r1 >= r2 { r1 } else { -r1 });
    } else {
        let aa = (r1 * r1 - r2 * r2 + dd * dd) / (2.0 * dd);
        let hh = ((r1 - aa) * (r1 + aa)).max(0.0).sqrt();
        let base = c1 + u * aa;
        let perp = u.perp();
        pts.push(base + perp * hh);
        pts.push(base - perp * hh);
    }
    for pt in pts {
        let (v1, v2) = (pt - c1, pt - c2);
        if contains_angle(t1, s1, f1, math::atan2(v1.y, v1.x), tol / r1)
            && contains_angle(t2, s2, f2, math::atan2(v2.y, v2.x), tol / r2)
        {
            out.points.push(pt);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(a: [f64; 2], b: [f64; 2]) -> Prim {
        Prim::Seg {
            a: a.into(),
            b: b.into(),
        }
    }

    #[test]
    fn exact_proper_crossing_is_found() {
        let c = contacts(
            &seg([0.0, 0.0], [2.0, 2.0]),
            &seg([0.0, 2.0], [2.0, 0.0]),
            1e-6,
        );
        assert_eq!(c.points.len(), 1);
        assert!(c.points[0].distance(Point2::new(1.0, 1.0)) < 1e-15);
        assert!(!c.overlap);
    }

    #[test]
    fn t_junction_touch_and_overlap_are_found() {
        let c = contacts(
            &seg([0.0, 0.0], [2.0, 0.0]),
            &seg([1.0, 0.0], [1.0, 1.0]),
            1e-6,
        );
        assert!(
            c.points
                .iter()
                .any(|p| p.distance(Point2::new(1.0, 0.0)) < 1e-15)
        );
        let o = contacts(
            &seg([0.0, 0.0], [2.0, 0.0]),
            &seg([1.0, 1e-7], [3.0, 0.0]),
            1e-6,
        );
        assert!(o.overlap);
        let far = contacts(
            &seg([0.0, 0.0], [2.0, 0.0]),
            &seg([0.0, 1e-5], [2.0, 1e-5]),
            1e-6,
        );
        assert!(!far.overlap && far.points.is_empty());
    }

    #[test]
    fn tangent_line_touches_circle_at_foot_point() {
        let circle = Prim::circle(Point2::new(0.0, 0.0), 1.0);
        let c = contacts(&seg([-2.0, 1.0], [2.0, 1.0]), &circle, 1e-6);
        assert_eq!(c.points.len(), 1);
        assert!(c.points[0].distance(Point2::new(0.0, 1.0)) < 1e-12);
        let miss = contacts(&seg([-2.0, 1.00001], [2.0, 1.00001]), &circle, 1e-6);
        assert!(miss.points.is_empty());
    }

    #[test]
    fn arcs_of_the_same_circle_overlap_only_when_their_ranges_do() {
        let a = ArcGeom::from_ir([1.0, 0.0].into(), [0.0, 1.0].into(), Point2::zero(), true);
        let b = ArcGeom::from_ir([0.0, 1.0].into(), [-1.0, 0.0].into(), Point2::zero(), true);
        let h = std::f64::consts::FRAC_1_SQRT_2;
        let c = ArcGeom::from_ir([h, h].into(), [-1.0, 0.0].into(), Point2::zero(), true);
        assert!(!contacts(&a.prim(), &b.prim(), 1e-6).overlap);
        assert!(contacts(&a.prim(), &c.prim(), 1e-6).overlap);
    }

    #[test]
    fn clockwise_arc_sweep_is_negative() {
        let a = ArcGeom::from_ir(
            [10.0, 0.0].into(),
            [0.0, -10.0].into(),
            Point2::zero(),
            false,
        );
        assert!((a.sweep + math::FRAC_PI_2).abs() < 1e-15);
        assert!(a.geometric_end().distance(Point2::new(0.0, -10.0)) < 1e-14);
    }
}
