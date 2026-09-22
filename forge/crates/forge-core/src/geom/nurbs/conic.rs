//! Exact rational quadratic NURBS for circular and elliptical arcs (The NURBS Book A7.1).

use super::curve::{NurbsCurve2, NurbsCurve3};
use crate::geom::error::{GeomError, check_positive};
use crate::linalg::{Frame, Point2, Vec2};
use crate::math;

/// Control net of a unit-circle arc: points (local coordinates), weights, knots.
struct ArcNet {
    points: Vec<[f64; 2]>,
    weights: Vec<f64>,
    knots: Vec<f64>,
}

/// Control points (unit circle, local coordinates), weights and knots of the arc from
/// angle `a0` to `a1` (radians, CCW, `0 < a1 − a0 <= 2π`).
///
/// The arc is split into `ceil(sweep / 90°)` equal segments; each segment is a rational
/// quadratic Bézier with middle weight `cos(Δ/2)`. Knots are spread over `[a0, a1]` so
/// the curve's domain equals the angular range (the parametrization in between differs
/// from the angle, but end points and segment joints coincide with the circle's).
fn unit_arc(a0: f64, a1: f64) -> Result<ArcNet, GeomError> {
    if !(a0.is_finite() && a1.is_finite()) {
        return Err(GeomError::NonFinite { what: "arc angles" });
    }
    let sweep = a1 - a0;
    if !(sweep > 0.0 && sweep <= math::TAU * (1.0 + 4.0 * f64::EPSILON)) {
        return Err(GeomError::InvalidParameter {
            what: "arc sweep",
            value: sweep,
            expected: "in (0, 2π]",
        });
    }
    let narcs = if sweep <= math::FRAC_PI_2 {
        1
    } else if sweep <= math::PI {
        2
    } else if sweep <= 1.5 * math::PI {
        3
    } else {
        4
    };
    let dtheta = sweep / narcs as f64;
    let w1 = math::cos(0.5 * dtheta);
    let mut pts = Vec::with_capacity(2 * narcs + 1);
    let mut weights = Vec::with_capacity(2 * narcs + 1);
    let (s0, c0) = math::sin_cos(a0);
    pts.push([c0, s0]);
    weights.push(1.0);
    for i in 1..=narcs {
        let angle = if i == narcs {
            a1
        } else {
            a0 + dtheta * i as f64
        };
        let mid = a0 + dtheta * (i as f64 - 0.5);
        let (sm, cm) = math::sin_cos(mid);
        // Tangent intersection of the segment end points, at distance 1/cos(Δ/2).
        pts.push([cm / w1, sm / w1]);
        weights.push(w1);
        let (s, c) = math::sin_cos(angle);
        pts.push([c, s]);
        weights.push(1.0);
    }
    let mut knots = vec![a0; 3];
    for i in 1..narcs {
        let k = a0 + dtheta * i as f64;
        knots.push(k);
        knots.push(k);
    }
    knots.extend([a1; 3]);
    Ok(ArcNet {
        points: pts,
        weights,
        knots,
    })
}

impl NurbsCurve2 {
    /// The circular arc of `radius` about `center` from angle `a0` to `a1` (radians,
    /// counter-clockwise, `0 < a1 − a0 <= 2π`) as an exact rational quadratic NURBS.
    /// The domain is `[a0, a1]`.
    pub fn circle_arc(center: Point2, radius: f64, a0: f64, a1: f64) -> Result<Self, GeomError> {
        Self::ellipse_arc(center, Vec2::unit_x(), radius, radius, a0, a1)
    }
    /// The elliptical arc `center + rx·cos t·x_dir + ry·sin t·perp(x_dir)` for
    /// `t ∈ [a0, a1]` as an exact rational quadratic NURBS (the affine image of the unit
    /// circle arc). `x_dir` need not be unit length.
    pub fn ellipse_arc(
        center: Point2,
        x_dir: Vec2,
        rx: f64,
        ry: f64,
        a0: f64,
        a1: f64,
    ) -> Result<Self, GeomError> {
        check_positive("rx", rx)?;
        check_positive("ry", ry)?;
        let xd = x_dir
            .normalize()
            .ok_or(GeomError::DegenerateDirection { what: "x_dir" })?;
        let yd = xd.perp();
        let ArcNet {
            points: pts,
            weights: w,
            knots,
        } = unit_arc(a0, a1)?;
        let ctrl = pts
            .iter()
            .map(|p| (center + xd * (rx * p[0]) + yd * (ry * p[1])).to_array())
            .collect();
        Ok(Self::new(2, knots, ctrl, Some(w))?)
    }
}

impl NurbsCurve3 {
    /// The circular arc `frame.origin + r·(cos t·frame.x + sin t·frame.y)` for
    /// `t ∈ [a0, a1]` (`0 < a1 − a0 <= 2π`) as an exact rational quadratic NURBS with
    /// domain `[a0, a1]`.
    pub fn circle_arc(frame: &Frame, radius: f64, a0: f64, a1: f64) -> Result<Self, GeomError> {
        Self::ellipse_arc(frame, radius, radius, a0, a1)
    }
    /// The elliptical arc `frame.origin + rx·cos t·frame.x + ry·sin t·frame.y` for
    /// `t ∈ [a0, a1]` as an exact rational quadratic NURBS with domain `[a0, a1]`.
    pub fn ellipse_arc(
        frame: &Frame,
        rx: f64,
        ry: f64,
        a0: f64,
        a1: f64,
    ) -> Result<Self, GeomError> {
        check_positive("rx", rx)?;
        check_positive("ry", ry)?;
        let ArcNet {
            points: pts,
            weights: w,
            knots,
        } = unit_arc(a0, a1)?;
        let ctrl = pts
            .iter()
            .map(|p| {
                frame
                    .to_world_point(crate::linalg::Vec3::new(rx * p[0], ry * p[1], 0.0))
                    .to_array()
            })
            .collect();
        Ok(Self::new(2, knots, ctrl, Some(w))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linalg::Vec3;

    #[test]
    fn full_circle_points_lie_on_circle() {
        let f = Frame::from_normal_x(
            Vec3::new(1.0, -2.0, 3.0),
            Vec3::new(1.0, 1.0, 1.0),
            Vec3::new(1.0, 0.0, -1.0),
        )
        .expect("frame");
        let c = NurbsCurve3::circle_arc(&f, 7.5, 0.0, math::TAU).expect("arc");
        assert_eq!(c.control_points().len(), 9);
        for i in 0..=200 {
            let t = math::TAU * i as f64 / 200.0;
            let p = f.to_local_point(c.eval(t));
            assert!(
                (p.truncate().norm() - 7.5).abs() < 1e-12 && p.z.abs() < 1e-12,
                "t = {t}"
            );
        }
        assert!(c.is_closed(1e-12));
        assert!((c.arc_length(0.0, math::TAU) - math::TAU * 7.5).abs() < 1e-10);
    }

    #[test]
    fn arc_end_points_match_angles() {
        let c = NurbsCurve2::circle_arc(Vec2::new(1.0, 1.0), 2.0, 0.3, 2.9).expect("arc");
        let (s, co) = math::sin_cos(2.9);
        assert!(
            c.eval(2.9)
                .distance(Vec2::new(1.0 + 2.0 * co, 1.0 + 2.0 * s))
                < 1e-14
        );
        assert_eq!(c.domain(), (0.3, 2.9));
    }

    #[test]
    fn ellipse_arc_points_satisfy_implicit_equation() {
        let c = NurbsCurve2::ellipse_arc(Vec2::zero(), Vec2::new(0.0, 2.0), 5.0, 2.0, -1.0, 4.0)
            .expect("arc");
        for i in 0..=50 {
            let (a, b) = c.domain();
            let p = c.eval(a + (b - a) * i as f64 / 50.0);
            // x_dir = +Y, so the major axis (5) is along Y and the minor (2) along −X.
            let (a, b) = (p.y / 5.0, p.x / 2.0);
            let e = a * a + b * b - 1.0;
            assert!(e.abs() < 1e-12);
        }
    }

    #[test]
    fn invalid_sweeps_are_rejected() {
        assert!(NurbsCurve2::circle_arc(Vec2::zero(), 1.0, 1.0, 1.0).is_err());
        assert!(NurbsCurve2::circle_arc(Vec2::zero(), 1.0, 0.0, 7.0).is_err());
        assert!(NurbsCurve2::circle_arc(Vec2::zero(), -1.0, 0.0, 1.0).is_err());
    }
}
