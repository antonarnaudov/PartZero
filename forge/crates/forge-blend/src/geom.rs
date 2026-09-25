//! Small closed-form geometry: intersections of lines, planes and circles, plane sections of
//! cylinders, frames, and arcs between two points of a curve.

use forge_core::geom::{Circle3, Curve3, Ellipse3, Line3, Plane, Surface};
use forge_core::linalg::{Frame, Point3, Vec3};
use forge_core::math;

/// The point where the line `o + s·d` meets the plane through `po` with normal `pn`;
/// `None` when they are parallel (|d·n| ≤ 1e-12 for unit vectors).
pub(crate) fn line_plane(o: Point3, d: Vec3, po: Point3, pn: Vec3) -> Option<Point3> {
    let den = d.dot(pn);
    if den.abs() <= 1e-12 * d.norm() * pn.norm() {
        return None;
    }
    let s = (po - o).dot(pn) / den;
    Some(o + d * s)
}

/// Closest points of two lines; `None` when (nearly) parallel.
///
/// Written with the cross product `n = d1 × d2` (`s = ((o2 − o1) × d2) · n / |n|²`, likewise
/// `t`) rather than the normal equations' `a·c − b²`, which cancels catastrophically for
/// nearly parallel lines (W6 review round 6: two blended edges meeting at 179.994° lost 1e-6
/// mm in their mitre point and failed as "inconsistent").
pub(crate) fn line_line(o1: Point3, d1: Vec3, o2: Point3, d2: Vec3) -> Option<(Point3, Point3)> {
    let n = d1.cross(d2);
    let nn = n.dot(n);
    if nn <= 1e-24 * d1.dot(d1) * d2.dot(d2) {
        return None;
    }
    let w = o2 - o1;
    let s = w.cross(d2).dot(n) / nn;
    let t = w.cross(d1).dot(n) / nn;
    Some((o1 + d1 * s, o2 + d2 * t))
}

/// The point on three planes `n_i · x = d_i` (Cramer's rule); `None` when two are nearly
/// parallel (relative determinant below 1e-9).
pub(crate) fn three_planes(n: [Vec3; 3], d: [f64; 3]) -> Option<Point3> {
    let c12 = n[1].cross(n[2]);
    let det = n[0].dot(c12);
    let scale = n[0].norm() * n[1].norm() * n[2].norm();
    if det.abs() <= 1e-9 * scale {
        return None;
    }
    let x = (c12 * d[0] + n[2].cross(n[0]) * d[1] + n[0].cross(n[1]) * d[2]) / det;
    x.is_finite().then_some(x)
}

/// A frame at `o` with z axis `z` and x axis the component of `x_hint` perpendicular to
/// `z` (any perpendicular when `x_hint` is parallel to `z`).
pub(crate) fn frame_zx(o: Point3, z: Vec3, x_hint: Vec3) -> Option<Frame> {
    let z = z.normalize()?;
    let x = (x_hint - z * x_hint.dot(z))
        .normalize()
        .or_else(|| z.any_perpendicular())?;
    Frame::from_normal_x(o, z, x)
}

/// The section of the cylinder (axis through `ao` along unit `at`, radius `r`) by the plane
/// `pl`: a circle when the plane is perpendicular to the axis (within 1e-12 of the sines),
/// otherwise an ellipse, its frame normal being the plane's frame z (so that its image on
/// the plane turns counter-clockwise). `None` when the plane is parallel to the axis.
pub(crate) fn cylinder_plane_section(ao: Point3, at: Vec3, r: f64, pl: &Plane) -> Option<Curve3> {
    let pf = pl.frame();
    let n = pf.z();
    let c = line_plane(ao, at, pf.origin(), n)?;
    let cos = at.dot(n).abs();
    let minor = at.cross(n);
    if minor.norm() <= 1e-12 {
        let fr = pf.with_origin(c);
        return Circle3::new(fr, r).ok().map(Curve3::Circle);
    }
    let m = minor.normalize()?;
    let big = n.cross(m).normalize()?;
    let fr = Frame::from_normal_x(c, n, big)?;
    Ellipse3::new(fr, r / cos, r).ok().map(Curve3::Ellipse)
}

/// A circle of radius `r` centred at `c` in the plane of `pl` (frame = the plane's frame,
/// moved): its pcurve on the plane is an exact counter-clockwise circle.
pub(crate) fn circle_in_plane(c: Point3, r: f64, pl: &Plane) -> Option<Circle3> {
    Circle3::new(pl.frame().with_origin(c), r).ok()
}

/// Wrap `x` into `[0, 2π)`.
pub(crate) fn wrap(x: f64) -> f64 {
    math::rem_euclid(x, math::TAU)
}

/// The parameter range of `curve` running between points `a` and `b` that lie on it, and
/// whether the curve direction goes from `a` to `b`. For periodic curves, the arc
/// containing (the projection of) `mid`. `None` when `a` and `b` project to the same
/// parameter (a degenerate arc).
pub(crate) fn arc_between(
    curve: &Curve3,
    a: Point3,
    b: Point3,
    mid: Point3,
) -> Option<((f64, f64), bool)> {
    let (ta, _) = curve.project(a);
    let (tb, _) = curve.project(b);
    match curve.period() {
        None => {
            if ta < tb {
                Some(((ta, tb), true))
            } else if tb < ta {
                Some(((tb, ta), false))
            } else {
                None
            }
        }
        Some(per) => {
            let (tm, _) = curve.project(mid);
            let len = math::rem_euclid(tb - ta, per);
            if len <= 0.0 {
                return None;
            }
            let m = math::rem_euclid(tm - ta, per);
            if m < len {
                Some(((ta, ta + len), true))
            } else {
                let len2 = math::rem_euclid(ta - tb, per);
                (len2 > 0.0).then_some(((tb, tb + len2), false))
            }
        }
    }
}

/// The unit vector from `from` to `to`.
pub(crate) fn dir(from: Point3, to: Point3) -> Option<Vec3> {
    (to - from).normalize()
}

/// The plane surface of a face, if planar.
pub(crate) fn as_plane(s: &Surface) -> Option<&Plane> {
    match s {
        Surface::Plane(p) => Some(p),
        _ => None,
    }
}

/// A line through `a` along `d` (unit), as a curve.
pub(crate) fn line(a: Point3, d: Vec3) -> Option<Curve3> {
    Line3::new(a, d).ok().map(Curve3::Line)
}

/// Arc length of a curve over a range (lines and circles in closed form).
pub(crate) fn length(c: &Curve3, r: (f64, f64)) -> f64 {
    match c {
        Curve3::Line(_) => r.1 - r.0,
        Curve3::Circle(k) => k.radius() * (r.1 - r.0),
        _ => c.arc_length(r.0, r.1),
    }
}

/// The parameter distance that corresponds to `LINEAR_TOLERANCE` along `c`: the tolerance
/// divided by a bound of the curve's speed (1 for a line, the radius of a circle, the larger
/// radius of an ellipse, the largest control-leg length times the degree for a B-spline).
pub(crate) fn param_tol(c: &Curve3) -> f64 {
    let speed = match c {
        Curve3::Line(l) => l.dir().norm(),
        Curve3::Circle(k) => k.radius(),
        Curve3::Ellipse(e) => e.rx().max(e.ry()),
        // |C'|² = a² + ρ² + p², bounded where the radius is largest (the edge's range is not
        // known here: the radius at t = 0 plus a generous turn count of radius change).
        Curve3::Helix(h) => {
            let r = h.radius().abs() + 1e3 * h.radius_rate().abs();
            (h.radius_rate() * h.radius_rate() + r * r + h.rise() * h.rise()).sqrt()
        }
        Curve3::BSpline(n) => {
            let cp = n.control_points();
            let k = n.knots();
            let p = n.degree();
            (1..cp.len())
                .map(|i| {
                    let span = k[i + p] - k[i];
                    let d = Vec3::new(
                        cp[i][0] - cp[i - 1][0],
                        cp[i][1] - cp[i - 1][1],
                        cp[i][2] - cp[i - 1][2],
                    );
                    if span > 0.0 {
                        p as f64 * d.norm() / span
                    } else {
                        0.0
                    }
                })
                .fold(0.0, f64::max)
        }
    };
    forge_ir::v1::LINEAR_TOLERANCE / speed.max(1e-300)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oblique_cylinder_sections_lie_on_the_cylinder_and_plane() {
        let ao = Vec3::new(1.0, 2.0, 3.0);
        let at = Vec3::new(0.0, 0.6, 0.8);
        let pl =
            Plane::from_point_normal(Vec3::new(0.0, 0.0, 5.0), Vec3::new(0.3, 0.1, 1.0)).unwrap();
        let c = cylinder_plane_section(ao, at, 2.5, &pl).unwrap();
        assert_eq!(c.kind_name(), "ellipse");
        for i in 0..32 {
            let p = c.eval(i as f64 * 0.2);
            let w = p - ao;
            let dist = (w - at * w.dot(at)).norm();
            assert!((dist - 2.5).abs() < 1e-12, "{dist}");
            assert!(pl.signed_distance(p).abs() < 1e-12);
        }
        let perp = Plane::new(Frame::from_normal_x(Vec3::zero(), at, Vec3::unit_x()).unwrap());
        assert_eq!(
            cylinder_plane_section(ao, at, 2.5, &perp)
                .unwrap()
                .kind_name(),
            "circle"
        );
    }

    #[test]
    fn arcs_between_points_follow_the_middle() {
        let c = Curve3::Circle(Circle3::new(Frame::world(), 1.0).unwrap());
        let a = Vec3::new(1.0, 0.0, 0.0);
        let b = Vec3::new(0.0, 1.0, 0.0);
        let ((t0, t1), fwd) = arc_between(&c, a, b, Vec3::new(0.7, 0.7, 0.0)).unwrap();
        assert!(fwd && t0.abs() < 1e-15 && (t1 - math::FRAC_PI_2).abs() < 1e-15);
        let ((t0, t1), fwd) = arc_between(&c, a, b, Vec3::new(-0.7, -0.7, 0.0)).unwrap();
        assert!(!fwd && (t1 - t0 - 1.5 * math::PI).abs() < 1e-12);
    }

    #[test]
    fn nearly_parallel_lines_meet_accurately() {
        // Two lines through (10, 3, 6) at 1e-4 rad from each other, given by points 10 mm
        // away (W6 review round 6: the normal equations lost ~1e-6 mm here).
        let p = Vec3::new(10.0, 3.0, 6.0);
        let d1 = Vec3::new(1.0, 0.0, 0.0);
        let d2 = Vec3::new(1.0, 1e-4, 0.0).normalize().unwrap();
        let (x, y) = line_line(p - d1 * 10.0, d1, p + d2 * 10.0, d2).unwrap();
        assert!((x - p).norm() < 1e-11, "{:e}", (x - p).norm());
        assert!((y - p).norm() < 1e-11, "{:e}", (y - p).norm());
        // Skew lines: the closest points, on both lines, with their connector perpendicular
        // to both.
        let (x, y) = line_line(
            Vec3::new(0.0, 0.0, 0.0),
            d1,
            Vec3::new(5.0, -2.0, 1.0),
            Vec3::new(0.0, 1.0, 0.0),
        )
        .unwrap();
        assert!((x - Vec3::new(5.0, 0.0, 0.0)).norm() < 1e-14);
        assert!((y - Vec3::new(5.0, 0.0, 1.0)).norm() < 1e-14);
        assert!(line_line(p, d1, p + Vec3::unit_y(), d1).is_none());
    }

    #[test]
    fn three_planes_meet_at_a_corner() {
        let p = three_planes(
            [Vec3::unit_x(), Vec3::unit_y(), Vec3::new(1.0, 1.0, 1.0)],
            [1.0, 2.0, 6.0],
        )
        .unwrap();
        assert!((p - Vec3::new(1.0, 2.0, 3.0)).norm() < 1e-14);
        assert!(three_planes([Vec3::unit_x(), Vec3::unit_x(), Vec3::unit_z()], [0.0; 3]).is_none());
    }
}
