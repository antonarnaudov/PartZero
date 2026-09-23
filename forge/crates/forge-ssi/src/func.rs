//! Scalar-generic functions and parameter maps shared by all algorithms.
//!
//! Everything that is certified is written once over [`Scalar`] and evaluated with
//! `f64` (search), [`Interval`] (exclusion / certification) and [`Dual`] (derivatives,
//! nested for second derivatives).

use forge_core::geom::{Curve3, SpindlePatch, Surface};
use forge_core::math;
use forge_core::scalar::{Dual, Interval, Scalar};
use forge_core::{Frame, Point2, Point3, Vec3};

/// A real function of one variable, evaluable over any [`Scalar`].
pub(crate) trait Fn1 {
    fn eval<S: Scalar>(&self, t: S) -> S;
}

/// A real function of two variables, evaluable over any [`Scalar`].
pub(crate) trait Fn2 {
    fn eval<S: Scalar>(&self, u: S, v: S) -> S;
}

/// Value and derivative enclosures of `f` over `[a, b]`, and the tightest value
/// enclosure available (natural extension ∩ mean-value form).
pub(crate) fn enclose1<F: Fn1>(f: &F, a: f64, b: f64) -> (Interval, Interval) {
    let i = Interval::new(a, b);
    let d = f.eval(Dual::variable(i));
    let m = 0.5 * a + 0.5 * b;
    let fm = f.eval(Interval::point(m));
    let mv = fm + d.d * (i - Interval::point(m));
    let v = d.v.intersect(mv);
    // Rounding can make the two enclosures disjoint only if one is wrong; keep the
    // natural one in that (impossible) case rather than returning EMPTY.
    (if v.is_empty() { d.v } else { v }, d.d)
}

/// `f(x)` and `f'(x)` in `f64`.
pub(crate) fn val_der1<F: Fn1>(f: &F, x: f64) -> (f64, f64) {
    let d = f.eval(Dual::variable(x));
    (d.v, d.d)
}

/// Local coordinates of `p` in an `f64` frame (any scalar type).
#[inline]
pub(crate) fn to_local<S: Scalar>(frame: &Frame, p: Vec3<S>) -> Vec3<S> {
    let d = p - frame.origin().lift::<S>();
    Vec3::new(
        d.dot(frame.x().lift()),
        d.dot(frame.y().lift()),
        d.dot(frame.z().lift()),
    )
}

/// The angle of `(x, y)` in `(r − π, r + π]` (up to rounding of the rotation by `r`).
#[inline]
pub(crate) fn angle_near<S: Scalar>(x: S, y: S, r: f64) -> S {
    let (s, c) = math::sin_cos(r);
    let (s, c) = (S::from_f64(s), S::from_f64(c));
    let xr = x * c + y * s;
    let yr = y * c - x * s;
    S::from_f64(r) + yr.atan2(xr)
}

/// Parameters `(u, v)` of a point on (or near) an analytic surface, by the closed-form
/// inverse of its parametrization. Periodic parameters are returned in
/// `(ref − π, ref + π]` (`u_ref`, `v_ref`), so a caller can keep them continuous.
///
/// On a cone the nappe is chosen from the sign of `R + z·tan α` (opposite nappe:
/// `u + π`), on a spindle-torus inner sheet likewise. Interval inputs straddling the
/// apex / axis get the full angular range.
pub(crate) fn uv_of<S: Scalar>(surf: &Surface, p: Vec3<S>, u_ref: f64, v_ref: f64) -> (S, S) {
    match surf {
        Surface::Plane(s) => {
            let l = to_local(s.frame(), p);
            (l.x, l.y)
        }
        Surface::Cylinder(s) => {
            let l = to_local(s.frame(), p);
            (angle_near(l.x, l.y, u_ref), l.z)
        }
        Surface::Cone(c) => {
            let l = to_local(c.frame(), p);
            let (sa, ca) = math::sin_cos(c.half_angle());
            let rh = S::from_f64(c.radius()) + l.z * S::from_f64(sa / ca);
            let u = if rh < S::zero() {
                angle_near(-l.x, -l.y, u_ref)
            } else if rh > S::zero() || rh == S::from_f64(rh.to_f64()) {
                angle_near(l.x, l.y, u_ref)
            } else {
                // An enclosure straddling the apex: every angle is possible.
                // `rh / |rh|` is the whole line for such an enclosure, so its arctangent
                // doubled covers [−π, π].
                S::from_f64(u_ref) + (rh / rh.abs()).atan() * S::from_f64(2.0)
            };
            (u, l.z)
        }
        Surface::Sphere(s) => {
            let l = to_local(s.frame(), p);
            let rho = (l.x.square() + l.y.square()).sqrt();
            (angle_near(l.x, l.y, u_ref), l.z.atan2(rho))
        }
        Surface::Torus(t) => {
            let l = to_local(t.frame(), p);
            let rho = (l.x.square() + l.y.square()).sqrt();
            let big = S::from_f64(t.major());
            if t.spindle_patch() == Some(SpindlePatch::Inner) {
                (
                    angle_near(-l.x, -l.y, u_ref),
                    angle_near(-rho - big, l.z, v_ref),
                )
            } else {
                (
                    angle_near(l.x, l.y, u_ref),
                    angle_near(rho - big, l.z, v_ref),
                )
            }
        }
        Surface::BSpline(_) => (S::from_f64(f64::NAN), S::from_f64(f64::NAN)),
    }
}

/// Parameters of an `f64` point with periodic outputs near `(u_ref, v_ref)`.
pub(crate) fn uv_near(surf: &Surface, p: Point3, u_ref: f64, v_ref: f64) -> Point2 {
    let (u, v) = uv_of(surf, p, u_ref, v_ref);
    Point2::new(u, v)
}

/// The centre of a parameter range (reference angle for periodic parameters).
#[inline]
pub(crate) fn mid(r: (f64, f64)) -> f64 {
    0.5 * r.0 + 0.5 * r.1
}

/// Distance form of an analytic surface (panics on B-splines, which callers reject).
#[inline]
pub(crate) fn dist<S: Scalar>(surf: &Surface, p: Vec3<S>) -> S {
    surf.distance_form(p)
        .unwrap_or_else(|| S::from_f64(f64::NAN))
}

/// The distance form of a surface along a curve: `t ↦ d_S(C(t))`.
pub(crate) struct CurveDist<'a> {
    pub curve: &'a Curve3,
    pub surf: &'a Surface,
}

impl Fn1 for CurveDist<'_> {
    fn eval<S: Scalar>(&self, t: S) -> S {
        dist(self.surf, self.curve.eval(t))
    }
}

/// Solve `J·x = rhs` in the least-squares sense for the 3×2 Jacobian `J = [a b]`.
/// Returns `None` if `J` is (numerically) rank-deficient.
pub(crate) fn solve_jacobian(a: Vec3, b: Vec3, rhs: Vec3) -> Option<(f64, f64)> {
    let (aa, ab, bb) = (a.dot(a), a.dot(b), b.dot(b));
    let (ar, br) = (a.dot(rhs), b.dot(rhs));
    let det = aa * bb - ab * ab;
    let scale = aa.max(bb).max(1e-300);
    // Rank-deficient (or NaN) Jacobian.
    if det.is_nan() || det <= 1e-24 * scale * scale {
        return None;
    }
    Some(((ar * bb - br * ab) / det, (br * aa - ar * ab) / det))
}

/// Parameter tolerance equivalent to a 3D distance `d` at `(u, v)` (per parameter).
pub(crate) fn param_slack(surf: &Surface, uv: Point2, d: f64) -> [f64; 2] {
    let [_, su, sv] = surf.derivs1(uv.x, uv.y);
    let f = |n: f64| if n > 1e-12 { d / n } else { math::PI };
    [f(su.norm()), f(sv.norm())]
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::geom::{Cone, Cylinder, Plane, Sphere, Torus};

    fn frame() -> Frame {
        Frame::from_normal_x(
            Vec3::new(1.0, -2.0, 0.5),
            Vec3::new(0.2, -0.3, 1.0),
            Vec3::new(1.0, 0.4, 0.0),
        )
        .expect("frame")
    }

    #[test]
    fn inverse_maps_round_trip_on_every_analytic_surface() {
        let f = frame();
        let surfaces: Vec<Surface> = vec![
            Plane::new(f).into(),
            Cylinder::new(f, 2.0).expect("c").into(),
            Cone::new(f, 1.0, 0.5).expect("k").into(),
            Sphere::new(f, 3.0).expect("s").into(),
            Torus::new(f, 5.0, 1.5).expect("t").into(),
            Torus::spindle(f, 1.0, 2.0, SpindlePatch::Inner)
                .expect("si")
                .into(),
            Torus::spindle(f, 1.0, 2.0, SpindlePatch::Outer)
                .expect("so")
                .into(),
        ];
        for s in &surfaces {
            let ((u0, u1), (v0, v1)) = s.domain();
            let (v0, v1) = if v0.is_finite() {
                (v0, v1)
            } else {
                (-4.0, 4.0)
            };
            let (u0, u1) = if u0.is_finite() {
                (u0, u1)
            } else {
                (-4.0, 4.0)
            };
            for i in 0..7 {
                for j in 1..6 {
                    let u = u0 + (u1 - u0) * (i as f64 + 0.25) / 7.0;
                    let v = v0 + (v1 - v0) * j as f64 / 6.0;
                    let p = s.eval(u, v);
                    let uv = uv_near(s, p, u, v);
                    assert!(
                        s.eval(uv.x, uv.y).distance(p) < 1e-11,
                        "{} ({u}, {v}) -> {uv:?}",
                        s.kind_name()
                    );
                    if s.periodicity().0.is_some() {
                        assert!((uv.x - u).abs() < 1e-9, "{} u", s.kind_name());
                    }
                    let pi: Vec3<Interval> = p.lift();
                    let (ui, vi) = uv_of(s, pi, u, v);
                    assert!(ui.contains(uv.x) && vi.contains(uv.y), "{}", s.kind_name());
                }
            }
        }
    }

    #[test]
    fn angle_near_stays_in_the_reference_window() {
        for r in [-7.0, -1.0, 0.0, 2.0, 9.0] {
            for k in 0..16 {
                let a = k as f64 * 0.4;
                let (s, c) = math::sin_cos(a);
                let x = angle_near(c, s, r);
                assert!(x > r - math::PI - 1e-12 && x <= r + math::PI + 1e-12);
                assert!(math::sin(x - a).abs() < 1e-12 && math::cos(x - a) > 0.0);
            }
        }
    }

    #[test]
    fn jacobian_solve_recovers_components() {
        let (a, b) = (Vec3::new(1.0, 0.0, 0.5), Vec3::new(0.0, 2.0, 0.1));
        let (x, y) = solve_jacobian(a, b, a * 0.3 + b * -1.2).expect("regular");
        assert!((x - 0.3).abs() < 1e-14 && (y + 1.2).abs() < 1e-14);
        assert!(solve_jacobian(a, a * 2.0, a).is_none());
    }
}
