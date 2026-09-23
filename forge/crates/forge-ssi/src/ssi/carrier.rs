//! Exact intersection carriers and their conversion to output curves.
//!
//! A *carrier* is an exact, unbounded or closed curve lying on both surfaces (a line, a
//! circle, an ellipse, or a parabola/hyperbola from a plane–cone section). Carriers are
//! clipped to the parameter boxes, split at surface singularities and crossings, and
//! turned into [`Curve3`]s with pcurves.

use forge_core::geom::{
    Circle3, Curve2, Curve3, Ellipse2, Ellipse3, Line2, Line3, NurbsCurve2, NurbsCurve3, Surface,
};
use forge_core::math;
use forge_core::scalar::{Dual, Scalar};
use forge_core::{Frame, Point2, Point3, Vec2, Vec3};

use crate::clip::ParamCurve;
use crate::error::SsiError;
use crate::func::{Fn1, solve_jacobian, uv_near};
use crate::roots1d::refine_bracketed;
use crate::ssi::fit::{Node, NodeSource, Reference3, uv_second};

/// A plane section of a cone that is a parabola or hyperbola, parametrized by the angle
/// `θ` of the cone generator through the point: `P(θ) = apex + λ(θ)·w(θ)` with
/// `w(θ) = tan α·e_r(θ) + z` and `λ(θ) = (d − n·apex)/(n·w(θ))`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ConeSection {
    /// Cone frame.
    pub frame: Frame,
    /// Apex (world).
    pub apex: Point3,
    /// `tan α`.
    pub ta: f64,
    /// Plane normal (world, unit).
    pub n: Vec3,
    /// `d − n·apex` (non-zero).
    pub num: f64,
}

impl ConeSection {
    fn w<S: Scalar>(&self, th: S) -> Vec3<S> {
        let (s, c) = th.sin_cos();
        let ta = S::from_f64(self.ta);
        self.frame.eval_vector(Vec3::new(ta * c, ta * s, S::one()))
    }
    /// `n·w(θ)` in closed form: `A·cos(θ − θn) + n3`; returns `(A, θn, n3)`.
    pub fn nw_form(&self) -> (f64, f64, f64) {
        let l = self.frame.to_local_vector(self.n);
        let a = self.ta * math::hypot(l.x, l.y);
        (a, math::atan2(l.y, l.x), l.z)
    }
    /// Parameter intervals where the section is within distance `r_max` of the apex
    /// (away from the poles `n·w = 0`).
    pub fn ranges(&self, r_max: f64) -> Vec<(f64, f64)> {
        let (a, th_n, n3) = self.nw_form();
        let ca = 1.0 / (1.0 + self.ta * self.ta).sqrt();
        // |λ|·|w| <= r_max  ⟺  |n·w| >= |num| / (r_max·cos α)
        let kappa = self.num.abs() / (r_max * ca);
        let mut out = Vec::new();
        if a <= 0.0 {
            if n3.abs() >= kappa {
                out.push((0.0, math::TAU));
            }
            return out;
        }
        let c1 = (kappa - n3) / a; // cos φ >= c1  (n·w >= κ)
        let c2 = (-kappa - n3) / a; // cos φ <= c2  (n·w <= −κ)
        if c1 <= -1.0 {
            out.push((th_n - math::PI, th_n + math::PI));
        } else if c1 < 1.0 {
            let h = math::acos(c1);
            out.push((th_n - h, th_n + h));
        }
        if c2 >= 1.0 {
            out.push((th_n - math::PI, th_n + math::PI));
        } else if c2 > -1.0 {
            let h = math::acos(c2);
            out.push((th_n + h, th_n + math::TAU - h));
        }
        out
    }
}

impl ParamCurve for ConeSection {
    fn point<S: Scalar>(&self, th: S) -> Vec3<S> {
        let w = self.w(th);
        let lam = S::from_f64(self.num) / w.dot(self.n.lift());
        self.apex.lift::<S>() + w * lam
    }
}

/// An exact intersection carrier.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Carrier {
    /// A straight line (unbounded).
    Line(Line3),
    /// A circle.
    Circle(Circle3),
    /// An ellipse.
    Ellipse(Ellipse3),
    /// A parabola or hyperbola (plane–cone), by generator angle.
    Section(ConeSection),
}

impl ParamCurve for Carrier {
    fn point<S: Scalar>(&self, t: S) -> Vec3<S> {
        match self {
            Carrier::Line(l) => l.eval(t),
            Carrier::Circle(c) => c.eval(t),
            Carrier::Ellipse(e) => e.eval(t),
            Carrier::Section(s) => s.point(t),
        }
    }
}

impl Carrier {
    /// The parameter of the carrier point nearest to `p` and the distance.
    pub fn project(&self, p: Point3) -> (f64, f64) {
        match self {
            Carrier::Line(l) => l.project(p),
            Carrier::Circle(c) => c.project(p),
            Carrier::Ellipse(e) => e.project(p),
            Carrier::Section(s) => {
                // Sample the generator angle, refine by golden-section free Newton on
                // the squared distance.
                let mut best = (0.0, f64::INFINITY);
                for i in 0..720 {
                    let th = math::TAU * i as f64 / 720.0;
                    let d = s.point(th).distance(p);
                    if d < best.1 {
                        best = (th, d);
                    }
                }
                best
            }
        }
    }
}

/// The output curve for a clipped carrier piece `[t0, t1]`: the exact [`Curve3`] and its
/// parameter range (the carrier's own parameter, except for cone sections, which become
/// exact rational quadratic B-splines with domain `[0, segments]`).
pub(crate) fn output_curve(
    c: &Carrier,
    t0: f64,
    t1: f64,
) -> Result<(Curve3, (f64, f64)), SsiError> {
    match c {
        Carrier::Line(l) => Ok((Curve3::Line(*l), (t0, t1))),
        Carrier::Circle(ci) => Ok((Curve3::Circle(*ci), (t0, t1))),
        Carrier::Ellipse(e) => Ok((Curve3::Ellipse(*e), (t0, t1))),
        Carrier::Section(s) => {
            let n = conic_nurbs(s, t0, t1)?;
            let d = n.domain();
            Ok((Curve3::BSpline(n), d))
        }
    }
}

/// Signed area of `p` relative to the line `m → p1` in the plane with normal `n`.
struct ShoulderFn<'a> {
    s: &'a ConeSection,
    m: Point3,
    dir: Vec3,
}
impl Fn1 for ShoulderFn<'_> {
    fn eval<S: Scalar>(&self, th: S) -> S {
        let q = self.s.point(th) - self.m.lift();
        q.cross(self.dir.lift()).dot(self.s.n.lift())
    }
}

/// The exact rational quadratic B-spline of a cone section arc `θ ∈ [θ0, θ1]`.
///
/// The arc is split until every piece turns by at most 60°; each piece is the rational
/// quadratic Bézier with end points `P(θa)`, `P(θb)`, middle control point at the
/// intersection of the end tangents, and the middle weight fixed by the curve's own
/// shoulder point (where the segment from the chord midpoint to the tangent intersection
/// meets the conic). Five conditions determine a conic, so the Bézier *is* the section.
fn conic_nurbs(s: &ConeSection, t0: f64, t1: f64) -> Result<NurbsCurve3, SsiError> {
    let bad = |p: Point3| SsiError::NotConverged {
        stage: "conic arc construction",
        point: p.to_array(),
        residual: f64::INFINITY,
        iterations: 0,
    };
    let tangent = |th: f64| {
        let p = s.point(Dual::variable(th));
        Vec3::new(p.x.d, p.y.d, p.z.d)
    };
    let mut k = 2usize;
    let breaks: Vec<f64> = loop {
        let b: Vec<f64> = (0..=k)
            .map(|i| {
                if i == k {
                    t1
                } else {
                    t0 + (t1 - t0) * i as f64 / k as f64
                }
            })
            .collect();
        let ok = b.windows(2).all(|w| {
            let (ta, tb) = (tangent(w[0]), tangent(w[1]));
            match (ta.normalize(), tb.normalize()) {
                (Some(x), Some(y)) => x.dot(y) >= 0.5,
                _ => false,
            }
        });
        if ok || k >= 4096 {
            break b;
        }
        k *= 2;
    };
    let mut ctrl: Vec<[f64; 3]> = Vec::new();
    let mut weights = Vec::new();
    let mut knots = vec![0.0; 3];
    for (i, w) in breaks.windows(2).enumerate() {
        let (ta, tb) = (w[0], w[1]);
        let (p0, p2) = (s.point(ta), s.point(tb));
        let (d0, d2) = (tangent(ta), tangent(tb));
        // p0 + a·d0 = p2 + b·d2 (least squares, coplanar lines).
        let (a, _) = solve_jacobian(d0, -d2, p2 - p0).ok_or_else(|| bad(p0))?;
        let p1 = p0 + d0 * a;
        let m = p0 * 0.5 + p2 * 0.5;
        let f = ShoulderFn { s, m, dir: p1 - m };
        let fa = f.eval(ta);
        if !(fa != 0.0 && fa.signum() != f.eval(tb).signum()) {
            return Err(bad(m));
        }
        let th_s = refine_bracketed(&f, ta, tb, if fa > 0.0 { 1 } else { -1 });
        let sh = s.point(th_s);
        let wgt = sh.distance(m) / p1.distance(sh);
        if !(wgt.is_finite() && wgt > 0.0) {
            return Err(bad(sh));
        }
        if i == 0 {
            ctrl.push(p0.to_array());
            weights.push(1.0);
        }
        ctrl.push(p1.to_array());
        weights.push(wgt);
        ctrl.push(p2.to_array());
        weights.push(1.0);
        let kn = (i + 1) as f64;
        if i + 2 < breaks.len() {
            knots.extend([kn, kn]);
        } else {
            knots.extend([kn; 3]);
        }
    }
    NurbsCurve3::new(2, knots, ctrl, Some(weights)).map_err(|_| bad(s.apex))
}

/// An exact pcurve for a curve on a surface, when one exists in the `Curve2` types with
/// the **same parameter**:
/// - on a plane: lines → `Line2`, circles/ellipses counter-clockwise in the plane →
///   `Ellipse2`, rational B-splines → the affine image `NurbsCurve2`;
/// - on any analytic surface: pcurves that are affine in `t` (iso-parameter lines:
///   cylinder rulings and sections, cone generators and parallels, sphere latitudes and
///   meridian arcs, torus parallels and meridians) → `Line2` (unit speed) or a degree-1
///   `NurbsCurve2`.
///
/// Returns `None` otherwise (the caller fits one). Every pcurve is verified afterwards.
pub(crate) fn exact_pcurve(
    curve: &Curve3,
    range: (f64, f64),
    surf: &Surface,
    uv0: Point2,
) -> Option<Curve2> {
    if let Surface::Plane(pl) = surf {
        let f = pl.frame();
        let to2 = |p: Point3| {
            let l = f.to_local_point(p);
            Point2::new(l.x, l.y)
        };
        let vec2 = |v: Vec3| {
            let l = f.to_local_vector(v);
            Vec2::new(l.x, l.y)
        };
        match curve {
            Curve3::Line(l) => {
                return Line2::new(to2(l.origin()), vec2(l.dir()))
                    .ok()
                    .map(Curve2::Line);
            }
            Curve3::Circle(c) if c.frame().z().dot(f.z()) > 1.0 - 1e-12 => {
                return Ellipse2::new(
                    to2(c.frame().origin()),
                    vec2(c.frame().x()),
                    c.radius(),
                    c.radius(),
                )
                .ok()
                .map(Curve2::Ellipse);
            }
            Curve3::Ellipse(e) if e.frame().z().dot(f.z()) > 1.0 - 1e-12 => {
                return Ellipse2::new(to2(e.frame().origin()), vec2(e.frame().x()), e.rx(), e.ry())
                    .ok()
                    .map(Curve2::Ellipse);
            }
            Curve3::BSpline(n) => {
                let ctrl: Vec<[f64; 2]> = n
                    .control_points()
                    .iter()
                    .map(|c| to2(Vec3::from(*c)).to_array())
                    .collect();
                return NurbsCurve2::new(
                    n.degree(),
                    n.knots().to_vec(),
                    ctrl,
                    n.weights().map(<[f64]>::to_vec),
                )
                .ok()
                .map(Curve2::BSpline);
            }
            _ => {}
        }
    }
    affine_pcurve(curve, range, surf, uv0)
}

/// Detect a pcurve that is affine in `t` and build it exactly.
fn affine_pcurve(
    curve: &Curve3,
    (t0, t1): (f64, f64),
    surf: &Surface,
    uv0: Point2,
) -> Option<Curve2> {
    let n = 12;
    let mut uvs = Vec::with_capacity(n + 1);
    let mut prev = uv0;
    for i in 0..=n {
        let t = t0 + (t1 - t0) * i as f64 / n as f64;
        let uv = uv_near(surf, curve.eval(t), prev.x, prev.y);
        if !uv.is_finite() {
            return None;
        }
        uvs.push(uv);
        prev = uv;
    }
    let (a, b) = (uvs[0], uvs[n]);
    let slope = (b - a) / (t1 - t0);
    let scale = 1.0 + a.x.abs().max(a.y.abs()).max(b.x.abs()).max(b.y.abs());
    for (i, uv) in uvs.iter().enumerate() {
        let t = t0 + (t1 - t0) * i as f64 / n as f64;
        let lin = a + slope * (t - t0);
        if lin.distance(*uv) > 1e-11 * scale {
            return None;
        }
    }
    let speed = slope.norm();
    if (speed - 1.0).abs() <= 1e-14 {
        let origin = a - slope * t0;
        Line2::new(origin, slope).ok().map(Curve2::Line)
    } else {
        NurbsCurve2::new(
            1,
            vec![t0, t0, t1, t1],
            vec![a.to_array(), b.to_array()],
            None,
        )
        .ok()
        .map(Curve2::BSpline)
    }
}

/// Node source for fitting pcurves of an exact 3D curve.
pub(crate) struct ExactNodes<'a> {
    pub curve: &'a Curve3,
    pub surfs: [&'a Surface; 2],
}

impl ExactNodes<'_> {
    /// The node at `t`, with periodic parameters continued from `prev` (`None`: from the
    /// supplied references).
    pub fn node(&self, t: f64, refs: [Point2; 2]) -> Node {
        let [p, d, dd] = self.curve.derivs2(t);
        let mut uv = [Point2::zero(); 2];
        let mut duv = [Vec2::zero(); 2];
        let mut dduv = [Vec2::zero(); 2];
        for k in 0..2 {
            uv[k] = uv_near(self.surfs[k], p, refs[k].x, refs[k].y);
            match uv_derivative(self.surfs[k], uv[k], d) {
                Some(g) => {
                    duv[k] = g;
                    dduv[k] = uv_second(self.surfs[k], uv[k], g, dd).unwrap_or(Vec2::zero());
                }
                None => {
                    let (g1, g2) = self.fd_uv(t, k, uv[k]);
                    duv[k] = g1;
                    dduv[k] = g2;
                }
            }
        }
        Node {
            t,
            p,
            d,
            dd,
            uv,
            duv,
            dduv,
        }
    }
    /// One-sided finite differences of the parameters (at a parametric singularity):
    /// first and second derivative.
    fn fd_uv(&self, t: f64, k: usize, uv: Point2) -> (Vec2, Vec2) {
        let h = 1e-4 * (1.0 + t.abs());
        let q1 = uv_near(self.surfs[k], self.curve.eval(t + h), uv.x, uv.y);
        let q2 = uv_near(self.surfs[k], self.curve.eval(t + 2.0 * h), q1.x, q1.y);
        let d1 = (q1 - uv) / h;
        let d2 = (q2 - q1 * 2.0 + uv) / (h * h);
        (d1 - d2 * (0.5 * h), d2)
    }
}

impl NodeSource for ExactNodes<'_> {
    fn node_at(&self, lo: &Node, _hi: &Node, t: f64) -> Result<Node, SsiError> {
        Ok(self.node(t, lo.uv))
    }
}

impl Reference3 for Curve3 {
    fn point(&self, _a: &Node, _b: &Node, t: f64) -> Point3 {
        self.eval(t)
    }
}

/// `d(u, v)/dt` for a curve with tangent `d` through `(u, v)`; `None` at parametric
/// singularities.
pub(crate) fn uv_derivative(surf: &Surface, uv: Point2, d: Vec3) -> Option<Vec2> {
    let [_, su, sv] = surf.derivs1(uv.x, uv.y);
    let big = su.norm().max(sv.norm());
    if !(su.norm() > 1e-9 * big && sv.norm() > 1e-9 * big) {
        return None;
    }
    solve_jacobian(su, sv, d).map(|(a, b)| Vec2::new(a, b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::geom::{Cone, Cylinder, Plane};

    #[test]
    fn cone_section_hyperbola_arc_is_exact() {
        let cone = Cone::new(Frame::world(), 1.0, 0.6).expect("k");
        // A plane parallel to the axis at x = 0.4 (hyperbola, both nappes).
        let n = Vec3::unit_x();
        let s = ConeSection {
            frame: *cone.frame(),
            apex: cone.apex(),
            ta: math::tan(0.6),
            n,
            num: 0.4 - n.dot(cone.apex()),
        };
        let ranges = s.ranges(20.0);
        assert_eq!(ranges.len(), 2, "{ranges:?}");
        let (a, b) = ranges[0];
        let (a, b) = (a + 0.1 * (b - a), b - 0.1 * (b - a));
        let c = conic_nurbs(&s, a, b).expect("nurbs");
        let cs: Surface = cone.into();
        let pl: Surface = Plane::from_point_normal(Vec3::new(0.4, 0.0, 0.0), n)
            .expect("p")
            .into();
        let (d0, d1) = c.domain();
        for i in 0..=200 {
            let t = d0 + (d1 - d0) * i as f64 / 200.0;
            let p = c.eval(t);
            assert!(cs.distance_form(p).expect("d").abs() < 1e-11, "cone {t}");
            assert!(pl.distance_form(p).expect("d").abs() < 1e-11, "plane {t}");
        }
        assert!(c.eval(d0).distance(s.point(a)) < 1e-12);
        assert!(c.eval(d1).distance(s.point(b)) < 1e-12);
    }

    #[test]
    fn iso_line_pcurves_are_detected_exactly() {
        let cyl: Surface = Cylinder::new(Frame::world(), 2.0).expect("c").into();
        let f = Frame::from_normal(Vec3::new(0.0, 0.0, 1.5), Vec3::unit_z()).expect("f");
        let circle: Curve3 = Circle3::new(f, 2.0).expect("c").into();
        let pc =
            exact_pcurve(&circle, (0.0, math::TAU), &cyl, Point2::new(0.0, 1.5)).expect("affine");
        assert_eq!(pc.kind_name(), "line");
        for i in 0..10 {
            let t = i as f64 * 0.6;
            let uv = pc.eval(t);
            assert!(cyl.eval(uv.x, uv.y).distance(circle.eval(t)) < 1e-13);
        }
    }
}
