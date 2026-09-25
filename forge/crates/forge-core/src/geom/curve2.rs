//! 2D curves: sketch geometry and pcurves in a face's `(u, v)` parameter space.

use super::ellipse_proj;
use super::error::{GeomError, check_positive};
use super::helix::Spiral2;
use super::nurbs::NurbsCurve2;
use crate::linalg::{Point2, Vec2};
use crate::math;
use crate::scalar::Scalar;

fn check_point2(what: &'static str, p: Point2) -> Result<Point2, GeomError> {
    if p.is_finite() {
        Ok(p)
    } else {
        Err(GeomError::NonFinite { what })
    }
}

/// An unbounded 2D line `C(t) = origin + t·dir`.
///
/// `dir` is unit length, so `t` is the signed distance from `origin` along `dir`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Line2 {
    origin: Point2,
    dir: Vec2,
}

impl Line2 {
    /// A line through `origin` along `dir` (normalized; must be non-zero).
    pub fn new(origin: Point2, dir: Vec2) -> Result<Self, GeomError> {
        let origin = check_point2("line origin", origin)?;
        let dir = dir.normalize().ok_or(GeomError::DegenerateDirection {
            what: "line direction",
        })?;
        Ok(Self { origin, dir })
    }
    /// The line through `a` (at `t = 0`) and `b` (at `t = |b − a|`).
    pub fn through(a: Point2, b: Point2) -> Result<Self, GeomError> {
        Self::new(a, b - a)
    }
    /// Point at `t = 0`.
    pub fn origin(&self) -> Point2 {
        self.origin
    }
    /// Unit direction.
    pub fn dir(&self) -> Vec2 {
        self.dir
    }
    /// Point at `t`.
    pub fn eval<S: Scalar>(&self, t: S) -> Vec2<S> {
        self.origin.lift::<S>() + self.dir.lift::<S>() * t
    }
    /// `[C(t), C'(t), C''(t)]`.
    pub fn derivs2<S: Scalar>(&self, t: S) -> [Vec2<S>; 3] {
        [self.eval(t), self.dir.lift(), Vec2::zero()]
    }
    /// Closest point `(t, distance)`.
    pub fn project(&self, p: Point2) -> (f64, f64) {
        let t = (p - self.origin).dot(self.dir);
        (t, self.eval(t).distance(p))
    }
}

/// A 2D circle `C(t) = center + radius·(cos t, sin t)`.
///
/// `t` is the angle from the +u axis, counter-clockwise; period 2π.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Circle2 {
    center: Point2,
    radius: f64,
}

impl Circle2 {
    /// A circle; `radius` must be finite and positive.
    pub fn new(center: Point2, radius: f64) -> Result<Self, GeomError> {
        Ok(Self {
            center: check_point2("circle center", center)?,
            radius: check_positive("radius", radius)?,
        })
    }
    /// Centre.
    pub fn center(&self) -> Point2 {
        self.center
    }
    /// Radius.
    pub fn radius(&self) -> f64 {
        self.radius
    }
    /// Point at `t`.
    pub fn eval<S: Scalar>(&self, t: S) -> Vec2<S> {
        let (s, c) = t.sin_cos();
        let r = S::from_f64(self.radius);
        self.center.lift::<S>() + Vec2::new(c, s) * r
    }
    /// `[C(t), C'(t), C''(t)]`.
    pub fn derivs2<S: Scalar>(&self, t: S) -> [Vec2<S>; 3] {
        let (s, c) = t.sin_cos();
        let r = S::from_f64(self.radius);
        let radial = Vec2::new(c, s) * r;
        [
            self.center.lift::<S>() + radial,
            Vec2::new(-s, c) * r,
            -radial,
        ]
    }
    /// Closest point `(t, distance)` with `t ∈ [0, 2π)` (`t = 0` at the centre).
    pub fn project(&self, p: Point2) -> (f64, f64) {
        let d = p - self.center;
        ellipse_proj::closest_param(self.radius, self.radius, d.x, d.y)
    }
}

/// A 2D ellipse `C(t) = center + rx·cos t·x_dir + ry·sin t·perp(x_dir)`, where
/// `perp` rotates by +90°. Period 2π; `rx` need not be the major radius.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ellipse2 {
    center: Point2,
    x_dir: Vec2,
    rx: f64,
    ry: f64,
}

impl Ellipse2 {
    /// An ellipse; radii must be finite and positive, `x_dir` non-zero (normalized).
    pub fn new(center: Point2, x_dir: Vec2, rx: f64, ry: f64) -> Result<Self, GeomError> {
        Ok(Self {
            center: check_point2("ellipse center", center)?,
            x_dir: x_dir.normalize().ok_or(GeomError::DegenerateDirection {
                what: "ellipse x_dir",
            })?,
            rx: check_positive("rx", rx)?,
            ry: check_positive("ry", ry)?,
        })
    }
    /// Centre.
    pub fn center(&self) -> Point2 {
        self.center
    }
    /// Unit direction of the `rx` axis.
    pub fn x_dir(&self) -> Vec2 {
        self.x_dir
    }
    /// Radius along `x_dir`.
    pub fn rx(&self) -> f64 {
        self.rx
    }
    /// Radius along `perp(x_dir)`.
    pub fn ry(&self) -> f64 {
        self.ry
    }
    /// `[C(t), C'(t), C''(t)]`.
    pub fn derivs2<S: Scalar>(&self, t: S) -> [Vec2<S>; 3] {
        let (s, c) = t.sin_cos();
        let (rx, ry) = (S::from_f64(self.rx), S::from_f64(self.ry));
        let x = self.x_dir.lift::<S>();
        let y = self.x_dir.perp().lift::<S>();
        let p = x * (rx * c) + y * (ry * s);
        [
            self.center.lift::<S>() + p,
            x * (-rx * s) + y * (ry * c),
            -p,
        ]
    }
    /// Point at `t`.
    pub fn eval<S: Scalar>(&self, t: S) -> Vec2<S> {
        self.derivs2(t)[0]
    }
    /// Closest point `(t, distance)` with `t ∈ [0, 2π)`.
    pub fn project(&self, p: Point2) -> (f64, f64) {
        let d = p - self.center;
        ellipse_proj::closest_param(
            self.rx,
            self.ry,
            d.dot(self.x_dir),
            d.dot(self.x_dir.perp()),
        )
    }
}

/// A 2D curve. Used for sketch geometry and for pcurves (the image of an edge in a
/// face's `(u, v)` parameter space; a pcurve shares its edge's parameter, see
/// [`crate::topo::Coedge`]).
#[derive(Clone, Debug, PartialEq)]
pub enum Curve2 {
    /// Straight line.
    Line(Line2),
    /// Circle.
    Circle(Circle2),
    /// Ellipse.
    Ellipse(Ellipse2),
    /// Archimedean spiral (the pcurve of a planar thread edge on a plane).
    Spiral(Spiral2),
    /// (Rational) B-spline.
    BSpline(NurbsCurve2),
}

impl From<Line2> for Curve2 {
    fn from(c: Line2) -> Self {
        Curve2::Line(c)
    }
}
impl From<Circle2> for Curve2 {
    fn from(c: Circle2) -> Self {
        Curve2::Circle(c)
    }
}
impl From<Ellipse2> for Curve2 {
    fn from(c: Ellipse2) -> Self {
        Curve2::Ellipse(c)
    }
}
impl From<Spiral2> for Curve2 {
    fn from(c: Spiral2) -> Self {
        Curve2::Spiral(c)
    }
}
impl From<NurbsCurve2> for Curve2 {
    fn from(c: NurbsCurve2) -> Self {
        Curve2::BSpline(c)
    }
}

impl Curve2 {
    /// `[C(t), C'(t), C''(t)]`.
    pub fn derivs2<S: Scalar>(&self, t: S) -> [Vec2<S>; 3] {
        match self {
            Curve2::Line(c) => c.derivs2(t),
            Curve2::Circle(c) => c.derivs2(t),
            Curve2::Ellipse(c) => c.derivs2(t),
            Curve2::Spiral(c) => c.derivs2(t),
            Curve2::BSpline(c) => c.derivs2(t),
        }
    }
    /// Point at `t`.
    pub fn eval<S: Scalar>(&self, t: S) -> Vec2<S> {
        match self {
            Curve2::Line(c) => c.eval(t),
            Curve2::Circle(c) => c.eval(t),
            Curve2::Ellipse(c) => c.eval(t),
            Curve2::Spiral(c) => c.eval(t),
            Curve2::BSpline(c) => c.eval(t),
        }
    }
    /// First derivative.
    pub fn d1<S: Scalar>(&self, t: S) -> Vec2<S> {
        self.derivs2(t)[1]
    }
    /// Second derivative.
    pub fn d2<S: Scalar>(&self, t: S) -> Vec2<S> {
        self.derivs2(t)[2]
    }
    /// Closest point `(t, distance)`; periodic curves return `t ∈ [0, 2π)`, B-splines a
    /// parameter in their domain.
    pub fn project(&self, p: Point2) -> (f64, f64) {
        match self {
            Curve2::Line(c) => c.project(p),
            Curve2::Circle(c) => c.project(p),
            Curve2::Ellipse(c) => c.project(p),
            Curve2::Spiral(c) => c.project(p),
            Curve2::BSpline(c) => c.project(p),
        }
    }
    /// `true` for circles and ellipses.
    pub fn is_periodic(&self) -> bool {
        self.period().is_some()
    }
    /// The period (2π for circles and ellipses).
    pub fn period(&self) -> Option<f64> {
        match self {
            Curve2::Circle(_) | Curve2::Ellipse(_) => Some(math::TAU),
            Curve2::Line(_) | Curve2::Spiral(_) | Curve2::BSpline(_) => None,
        }
    }
    /// Natural parameter range: `(−∞, ∞)` for lines, `[0, 2π)` for periodic curves, the
    /// positive-radius interval for spirals, the knot domain for B-splines.
    pub fn domain(&self) -> (f64, f64) {
        match self {
            Curve2::Line(_) => (f64::NEG_INFINITY, f64::INFINITY),
            Curve2::Circle(_) | Curve2::Ellipse(_) => (0.0, math::TAU),
            Curve2::Spiral(c) => c.domain(),
            Curve2::BSpline(c) => c.domain(),
        }
    }
    /// Canonical type name: `"line"`, `"circle"`, `"ellipse"`, `"spiral"` or `"bspline"`.
    pub fn kind_name(&self) -> &'static str {
        match self {
            Curve2::Line(_) => "line",
            Curve2::Circle(_) => "circle",
            Curve2::Ellipse(_) => "ellipse",
            Curve2::Spiral(_) => "spiral",
            Curve2::BSpline(_) => "bspline",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_parameter_is_distance() {
        let l = Line2::through(Vec2::new(1.0, 1.0), Vec2::new(4.0, 5.0)).expect("line");
        assert!(l.eval(5.0).distance(Vec2::new(4.0, 5.0)) < 1e-15);
        let (t, d) = l.project(Vec2::new(4.0, 5.0) + l.dir().perp() * 2.0);
        assert!((t - 5.0).abs() < 1e-14 && (d - 2.0).abs() < 1e-14);
        assert!(Line2::new(Vec2::zero(), Vec2::zero()).is_err());
    }

    #[test]
    fn circle_parameter_is_ccw_angle_from_u_axis() {
        let c = Circle2::new(Vec2::new(1.0, 2.0), 3.0).expect("circle");
        assert!(c.eval(math::FRAC_PI_2).distance(Vec2::new(1.0, 5.0)) < 1e-15);
        let (t, d) = c.project(Vec2::new(-5.0, 2.0));
        assert!((t - math::PI).abs() < 1e-15 && (d - 3.0).abs() < 1e-15);
    }

    #[test]
    fn ellipse_projection_round_trips() {
        let e =
            Ellipse2::new(Vec2::new(1.0, -1.0), Vec2::new(1.0, 1.0), 4.0, 1.5).expect("ellipse");
        for i in 0..16 {
            let t = math::TAU * (i as f64 + 0.25) / 16.0;
            let (tp, d) = e.project(e.eval(t));
            assert!(d < 1e-12 && (tp - t).abs() < 1e-9);
        }
    }

    #[test]
    fn kind_names_and_periods() {
        let c: Curve2 = Circle2::new(Vec2::zero(), 1.0).expect("c").into();
        assert_eq!((c.kind_name(), c.period()), ("circle", Some(math::TAU)));
        let l: Curve2 = Line2::new(Vec2::zero(), Vec2::unit_x()).expect("l").into();
        assert!(!l.is_periodic() && l.kind_name() == "line");
    }
}
