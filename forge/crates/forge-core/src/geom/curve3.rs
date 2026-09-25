//! 3D curves: the geometry of edges.

use super::ellipse_proj;
use super::error::{GeomError, check_positive};
use super::helix::Helix3;
use super::nurbs::NurbsCurve3;
use super::quadrature;
use crate::linalg::{Frame, Point3, Transform, Vec3};
use crate::math;
use crate::scalar::Scalar;

fn check_point3(what: &'static str, p: Point3) -> Result<Point3, GeomError> {
    if p.is_finite() {
        Ok(p)
    } else {
        Err(GeomError::NonFinite { what })
    }
}

/// An unbounded line `C(t) = origin + t·dir`, `dir` unit length (so `t` is the signed
/// distance from `origin`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Line3 {
    origin: Point3,
    dir: Vec3,
}

impl Line3 {
    /// A line through `origin` along `dir` (normalized; must be non-zero).
    pub fn new(origin: Point3, dir: Vec3) -> Result<Self, GeomError> {
        let origin = check_point3("line origin", origin)?;
        let dir = dir.normalize().ok_or(GeomError::DegenerateDirection {
            what: "line direction",
        })?;
        Ok(Self { origin, dir })
    }
    /// The line through `a` (at `t = 0`) and `b` (at `t = |b − a|`).
    pub fn through(a: Point3, b: Point3) -> Result<Self, GeomError> {
        Self::new(a, b - a)
    }
    /// Point at `t = 0`.
    pub fn origin(&self) -> Point3 {
        self.origin
    }
    /// Unit direction.
    pub fn dir(&self) -> Vec3 {
        self.dir
    }
    /// Point at `t`.
    pub fn eval<S: Scalar>(&self, t: S) -> Vec3<S> {
        self.origin.lift::<S>() + self.dir.lift::<S>() * t
    }
    /// `[C(t), C'(t), C''(t)]`.
    pub fn derivs2<S: Scalar>(&self, t: S) -> [Vec3<S>; 3] {
        [self.eval(t), self.dir.lift(), Vec3::zero()]
    }
    /// Closest point `(t, distance)`.
    pub fn project(&self, p: Point3) -> (f64, f64) {
        let t = (p - self.origin).dot(self.dir);
        (t, self.eval(t).distance(p))
    }
}

/// A circle `C(t) = o + r·(cos t·x + sin t·y)` in the `xy` plane of `frame`.
///
/// `t` is the angle from `frame.x`, counter-clockwise about `frame.z` (right-hand rule);
/// period 2π.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Circle3 {
    frame: Frame,
    radius: f64,
}

impl Circle3 {
    /// A circle; `radius` must be finite and positive.
    pub fn new(frame: Frame, radius: f64) -> Result<Self, GeomError> {
        Ok(Self {
            frame,
            radius: check_positive("radius", radius)?,
        })
    }
    /// Frame (centre = origin, axis = z).
    pub fn frame(&self) -> &Frame {
        &self.frame
    }
    /// Radius.
    pub fn radius(&self) -> f64 {
        self.radius
    }
    /// `[C(t), C'(t), C''(t)]`.
    pub fn derivs2<S: Scalar>(&self, t: S) -> [Vec3<S>; 3] {
        let (s, c) = t.sin_cos();
        let r = S::from_f64(self.radius);
        let z = S::zero();
        let radial = Vec3::new(r * c, r * s, z);
        [
            self.frame.eval_point(radial),
            self.frame.eval_vector(Vec3::new(-r * s, r * c, z)),
            self.frame.eval_vector(-radial),
        ]
    }
    /// Point at `t`.
    pub fn eval<S: Scalar>(&self, t: S) -> Vec3<S> {
        let (s, c) = t.sin_cos();
        let r = S::from_f64(self.radius);
        self.frame.eval_point(Vec3::new(r * c, r * s, S::zero()))
    }
    /// Closest point `(t, distance)`, `t ∈ [0, 2π)`. Points on the axis are equidistant
    /// from the whole circle; `t = 0` is returned.
    pub fn project(&self, p: Point3) -> (f64, f64) {
        let l = self.frame.to_local_point(p);
        let (t, d2) = ellipse_proj::closest_param(self.radius, self.radius, l.x, l.y);
        (t, math::hypot(d2, l.z))
    }
    /// The arc `[a0, a1]` (or the full circle for `(0, 2π)`) as an exact rational NURBS.
    pub fn to_nurbs(&self, a0: f64, a1: f64) -> Result<NurbsCurve3, GeomError> {
        NurbsCurve3::circle_arc(&self.frame, self.radius, a0, a1)
    }
}

/// An ellipse `C(t) = o + rx·cos t·x + ry·sin t·y` in the `xy` plane of `frame`.
///
/// `t` is the eccentric angle from `frame.x`, counter-clockwise about `frame.z`; period
/// 2π. `rx` need not be the major radius.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ellipse3 {
    frame: Frame,
    rx: f64,
    ry: f64,
}

impl Ellipse3 {
    /// An ellipse; radii must be finite and positive.
    pub fn new(frame: Frame, rx: f64, ry: f64) -> Result<Self, GeomError> {
        Ok(Self {
            frame,
            rx: check_positive("rx", rx)?,
            ry: check_positive("ry", ry)?,
        })
    }
    /// Frame (centre = origin).
    pub fn frame(&self) -> &Frame {
        &self.frame
    }
    /// Radius along `frame.x`.
    pub fn rx(&self) -> f64 {
        self.rx
    }
    /// Radius along `frame.y`.
    pub fn ry(&self) -> f64 {
        self.ry
    }
    /// `[C(t), C'(t), C''(t)]`.
    pub fn derivs2<S: Scalar>(&self, t: S) -> [Vec3<S>; 3] {
        let (s, c) = t.sin_cos();
        let (rx, ry, z) = (S::from_f64(self.rx), S::from_f64(self.ry), S::zero());
        let local = Vec3::new(rx * c, ry * s, z);
        [
            self.frame.eval_point(local),
            self.frame.eval_vector(Vec3::new(-rx * s, ry * c, z)),
            self.frame.eval_vector(-local),
        ]
    }
    /// Point at `t`.
    pub fn eval<S: Scalar>(&self, t: S) -> Vec3<S> {
        self.derivs2(t)[0]
    }
    /// Closest point `(t, distance)`, `t ∈ [0, 2π)` (Eberly's robust method in the
    /// ellipse plane).
    pub fn project(&self, p: Point3) -> (f64, f64) {
        let l = self.frame.to_local_point(p);
        let (t, d2) = ellipse_proj::closest_param(self.rx, self.ry, l.x, l.y);
        (t, math::hypot(d2, l.z))
    }
    /// The arc `[a0, a1]` as an exact rational NURBS.
    pub fn to_nurbs(&self, a0: f64, a1: f64) -> Result<NurbsCurve3, GeomError> {
        NurbsCurve3::ellipse_arc(&self.frame, self.rx, self.ry, a0, a1)
    }
}

/// A 3D curve: the geometry carried by an edge.
///
/// | Variant | Parameter `t` | Period |
/// |---|---|---|
/// | [`Line3`] | signed distance from `origin` along the unit `dir` | — |
/// | [`Circle3`] | angle from `frame.x`, CCW about `frame.z` | 2π |
/// | [`Ellipse3`] | eccentric angle from `frame.x`, CCW about `frame.z` | 2π |
/// | [`Helix3`] | angle about `frame.z` from `frame.x` (unwrapped) | — |
/// | [`NurbsCurve3`] | knot parameter in its domain | — |
///
/// All evaluation methods are generic over [`Scalar`]: evaluate with
/// [`Dual`](crate::scalar::Dual) for derivatives or [`Interval`](crate::scalar::Interval)
/// for enclosures.
#[derive(Clone, Debug, PartialEq)]
pub enum Curve3 {
    /// Straight line.
    Line(Line3),
    /// Circle.
    Circle(Circle3),
    /// Ellipse.
    Ellipse(Ellipse3),
    /// Helix or planar spiral (a screw-thread edge).
    Helix(Helix3),
    /// (Rational) B-spline.
    BSpline(NurbsCurve3),
}

impl From<Line3> for Curve3 {
    fn from(c: Line3) -> Self {
        Curve3::Line(c)
    }
}
impl From<Circle3> for Curve3 {
    fn from(c: Circle3) -> Self {
        Curve3::Circle(c)
    }
}
impl From<Ellipse3> for Curve3 {
    fn from(c: Ellipse3) -> Self {
        Curve3::Ellipse(c)
    }
}
impl From<Helix3> for Curve3 {
    fn from(c: Helix3) -> Self {
        Curve3::Helix(c)
    }
}
impl From<NurbsCurve3> for Curve3 {
    fn from(c: NurbsCurve3) -> Self {
        Curve3::BSpline(c)
    }
}

impl Curve3 {
    /// Point at `t`.
    pub fn eval<S: Scalar>(&self, t: S) -> Vec3<S> {
        match self {
            Curve3::Line(c) => c.eval(t),
            Curve3::Circle(c) => c.eval(t),
            Curve3::Ellipse(c) => c.eval(t),
            Curve3::Helix(c) => c.eval(t),
            Curve3::BSpline(c) => c.eval(t),
        }
    }
    /// `[C(t), C'(t), C''(t)]`.
    pub fn derivs2<S: Scalar>(&self, t: S) -> [Vec3<S>; 3] {
        match self {
            Curve3::Line(c) => c.derivs2(t),
            Curve3::Circle(c) => c.derivs2(t),
            Curve3::Ellipse(c) => c.derivs2(t),
            Curve3::Helix(c) => c.derivs2(t),
            Curve3::BSpline(c) => c.derivs2(t),
        }
    }
    /// First derivative `C'(t)`.
    pub fn d1<S: Scalar>(&self, t: S) -> Vec3<S> {
        self.derivs2(t)[1]
    }
    /// Second derivative `C''(t)`.
    pub fn d2<S: Scalar>(&self, t: S) -> Vec3<S> {
        self.derivs2(t)[2]
    }
    /// Closest point `(t, distance)` over the curve's whole parameter range (periodic
    /// curves: `t ∈ [0, 2π)`). Analytic for lines and circles, Eberly's bisection for
    /// ellipses, bounded turn search + Newton for helices ([`Helix3::project`]), sampling +
    /// damped Newton for B-splines.
    pub fn project(&self, p: Point3) -> (f64, f64) {
        match self {
            Curve3::Line(c) => c.project(p),
            Curve3::Circle(c) => c.project(p),
            Curve3::Ellipse(c) => c.project(p),
            Curve3::Helix(c) => c.project(p),
            Curve3::BSpline(c) => c.project(p),
        }
    }
    /// `true` for circles and ellipses.
    pub fn is_periodic(&self) -> bool {
        self.period().is_some()
    }
    /// The period: 2π for circles and ellipses, `None` otherwise.
    pub fn period(&self) -> Option<f64> {
        match self {
            Curve3::Circle(_) | Curve3::Ellipse(_) => Some(math::TAU),
            Curve3::Line(_) | Curve3::Helix(_) | Curve3::BSpline(_) => None,
        }
    }
    /// Natural parameter range: `(−∞, ∞)` for lines, `[0, 2π)` for periodic curves, the
    /// positive-radius interval for helices, the knot domain for B-splines.
    pub fn domain(&self) -> (f64, f64) {
        match self {
            Curve3::Line(_) => (f64::NEG_INFINITY, f64::INFINITY),
            Curve3::Circle(_) | Curve3::Ellipse(_) => (0.0, math::TAU),
            Curve3::Helix(c) => c.domain(),
            Curve3::BSpline(c) => c.domain(),
        }
    }
    /// Length of the curve between `t0` and `t1` (order-insensitive). Exact for lines and
    /// circles and circular helices; composite 16-point Gauss–Legendre for ellipses and
    /// spirals (pieces of at most π/8) and B-splines (per knot span).
    pub fn arc_length(&self, t0: f64, t1: f64) -> f64 {
        let span = (t1 - t0).abs();
        match self {
            Curve3::Line(_) => span,
            Curve3::Circle(c) => c.radius * span,
            Curve3::Ellipse(e) => {
                let pieces = ((span / (math::PI / 8.0)).ceil() as usize).max(1);
                let (lo, hi) = if t0 <= t1 { (t0, t1) } else { (t1, t0) };
                quadrature::integrate(|t| e.derivs2(t)[1].norm(), lo, hi, pieces)
            }
            Curve3::Helix(c) => c.arc_length(t0, t1),
            Curve3::BSpline(c) => c.arc_length(t0, t1),
        }
    }
    /// Canonical type name used by the metrics spec: `"line"`, `"circle"`, `"ellipse"`,
    /// `"helix"` or `"bspline"`.
    pub fn kind_name(&self) -> &'static str {
        match self {
            Curve3::Line(_) => "line",
            Curve3::Circle(_) => "circle",
            Curve3::Ellipse(_) => "ellipse",
            Curve3::Helix(_) => "helix",
            Curve3::BSpline(_) => "bspline",
        }
    }
    /// The curve moved by a rigid transform (parametrization preserved).
    pub fn transform(&self, t: &Transform) -> Curve3 {
        match self {
            Curve3::Line(c) => Curve3::Line(Line3 {
                origin: t.transform_point(c.origin),
                dir: t.transform_vector(c.dir),
            }),
            Curve3::Circle(c) => Curve3::Circle(Circle3 {
                frame: c.frame.transformed(t),
                radius: c.radius,
            }),
            Curve3::Ellipse(c) => Curve3::Ellipse(Ellipse3 {
                frame: c.frame.transformed(t),
                rx: c.rx,
                ry: c.ry,
            }),
            Curve3::Helix(c) => Curve3::Helix(c.transformed(t)),
            Curve3::BSpline(c) => Curve3::BSpline(c.transformed(t)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tilted() -> Frame {
        Frame::from_normal_x(
            Vec3::new(1.0, 2.0, -1.0),
            Vec3::new(0.3, -0.2, 1.0),
            Vec3::new(1.0, 1.0, 0.0),
        )
        .expect("frame")
    }

    #[test]
    fn circle_parametrization_convention() {
        let c = Circle3::new(Frame::world(), 2.0).expect("circle");
        assert!(c.eval(math::FRAC_PI_2).distance(Vec3::new(0.0, 2.0, 0.0)) < 1e-15);
        let (t, d) = c.project(Vec3::new(-3.0, 0.0, 4.0));
        assert!((t - math::PI).abs() < 1e-15 && (d - math::hypot(1.0, 4.0)).abs() < 1e-15);
    }

    #[test]
    fn arc_lengths() {
        let l: Curve3 = Line3::through(Vec3::zero(), Vec3::new(1.0, 2.0, 2.0))
            .expect("line")
            .into();
        assert!((l.arc_length(0.0, 3.0) - 3.0).abs() == 0.0);
        let c: Curve3 = Circle3::new(tilted(), 2.0).expect("c").into();
        assert!((c.arc_length(0.0, math::PI) - 2.0 * math::PI).abs() < 1e-15);
        // Ellipse with equal radii must match the circle.
        let e: Curve3 = Ellipse3::new(tilted(), 2.0, 2.0).expect("e").into();
        assert!((e.arc_length(0.5, 5.0) - 2.0 * 4.5).abs() < 1e-12);
        // Ramanujan's approximation is accurate to ~1e-10 relative for a = 3, b = 2.
        let e: Curve3 = Ellipse3::new(tilted(), 3.0, 2.0).expect("e").into();
        let (a, b) = (3.0f64, 2.0f64);
        let h = ((a - b) / (a + b)) * ((a - b) / (a + b));
        let ram = math::PI * (a + b) * (1.0 + 3.0 * h / (10.0 + (4.0 - 3.0 * h).sqrt()));
        assert!((e.arc_length(0.0, math::TAU) - ram).abs() < 1e-6);
    }

    #[test]
    fn transformed_circle_moves_its_points() {
        let c: Curve3 = Circle3::new(tilted(), 1.5).expect("c").into();
        let t =
            Transform::rotation_about_axis(Vec3::new(1.0, 0.0, 0.0), Vec3::new(0.0, 1.0, 1.0), 0.8)
                .expect("t");
        let ct = c.transform(&t);
        for i in 0..8 {
            let s = i as f64;
            assert!(ct.eval(s).distance(t.transform_point(c.eval(s))) < 1e-14);
        }
    }
}
