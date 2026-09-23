//! Implicit forms of the analytic surfaces, generic over [`Scalar`].
//!
//! Intersection and classification algorithms need a surface as the zero set of a function
//! `F: ℝ³ → ℝ` in addition to its parametrization. Two forms are provided per analytic
//! surface, both written once over [`Scalar`] so they evaluate as `f64`, as certified
//! [`Interval`](crate::scalar::Interval) enclosures and with [`Dual`](crate::scalar::Dual)
//! derivatives:
//!
//! | Surface | Distance form `d(p)` (local coordinates, `ρ = √(x² + y²)`) | Algebraic form `q(p)` | Degree |
//! |---|---|---|---|
//! | [`Plane`] | `z` | `z` | 1 |
//! | [`Cylinder`] | `ρ − r` | `x² + y² − r²` | 2 |
//! | [`Cone`] | `(ρ − |R + z·tan α|)·cos α` | `x² + y² − (R + z·tan α)²` | 2 |
//! | [`Sphere`] | `√(x² + y² + z²) − r` | `x² + y² + z² − r²` | 2 |
//! | [`Torus`] (ring, horn, spindle outer sheet) | `√((ρ − R)² + z²) − r` | `(x² + y² + z² + R² − r²)² − 4R²(x² + y²)` | 4 |
//! | [`Torus`] (spindle inner sheet) | `√((ρ + R)² + z²) − r` | same quartic | 4 |
//!
//! # The distance form
//! `d` is the **signed distance along a known foot point**: for every `p`, `|d(p)|` is the
//! distance from `p` to one specific point of the surface (the radial projection onto the
//! cylinder, sphere or tube circle; the orthogonal projection onto the cone generator in
//! the meridian plane of `p`). Hence
//!
//! - `dist(p, S) <= |d(p)|` everywhere (an *upper distance bound*): certifying `|d| <= ε`
//!   over a set certifies that the set lies within `ε` of the surface;
//! - `|d(p)| = dist(p, S)` near the surface (away from the axis / centre), and `|∇d| = 1`
//!   there, so `d` measures geometric error in millimetres.
//!
//! Zero sets: the cone form vanishes on **both nappes** (a face uses one; parameter domains
//! select it). For a spindle torus ([`Torus::spindle`]) the form vanishes exactly on the
//! patch's own sheet (the outer "apple" or the inner "lemon"). `d` is not differentiable
//! on the axis (`ρ = 0`), at a sphere centre and (cone) on the apex plane; the only
//! surface points among those are the cone apex and the axis points of horn and spindle
//! tori, which are surface singularities anyway.
//!
//! # The algebraic form
//! `q` is the defining polynomial (degree 1, 2 or 4 in the coordinates). Composed with a
//! line or conic it yields a polynomial or trigonometric polynomial, which closed-form
//! intersection code exploits. Its zero set is the whole algebraic surface: the double
//! cone and **both** sheets of a spindle torus. `q` is not scaled like a distance.

use super::{Cone, Cylinder, Plane, Sphere, SpindlePatch, Surface, Torus};
use crate::linalg::{Frame, Vec3};
use crate::math;
use crate::scalar::Scalar;

/// Local coordinates of `p` in `frame` (any scalar type; the frame is `f64`).
#[inline]
pub(crate) fn to_local<S: Scalar>(frame: &Frame, p: Vec3<S>) -> Vec3<S> {
    let d = p - frame.origin().lift::<S>();
    Vec3::new(
        d.dot(frame.x().lift()),
        d.dot(frame.y().lift()),
        d.dot(frame.z().lift()),
    )
}

/// `(sin α, cos α, tan α)` computed exactly as [`Cone::new`] does (bit-identical).
fn cone_trig(c: &Cone) -> (f64, f64, f64) {
    let (s, co) = math::sin_cos(c.half_angle());
    (s, co, s / co)
}

impl Plane {
    /// Distance form: the signed distance `(p − o)·z` (exact everywhere).
    pub fn distance_form<S: Scalar>(&self, p: Vec3<S>) -> S {
        to_local(self.frame(), p).z
    }
    /// Algebraic form (degree 1), identical to the distance form.
    pub fn algebraic_form<S: Scalar>(&self, p: Vec3<S>) -> S {
        self.distance_form(p)
    }
    /// Gradient of the distance form: the unit normal.
    pub fn distance_form_grad<S: Scalar>(&self, _p: Vec3<S>) -> Vec3<S> {
        self.frame().z().lift()
    }
}

impl Cylinder {
    /// Distance form `ρ − r` (exact signed distance; positive outside).
    pub fn distance_form<S: Scalar>(&self, p: Vec3<S>) -> S {
        let l = to_local(self.frame(), p);
        (l.x.square() + l.y.square()).sqrt() - S::from_f64(self.radius())
    }
    /// Algebraic form `x² + y² − r²` (degree 2).
    pub fn algebraic_form<S: Scalar>(&self, p: Vec3<S>) -> S {
        let l = to_local(self.frame(), p);
        l.x.square() + l.y.square() - S::from_f64(self.radius() * self.radius())
    }
    /// Gradient of the distance form: the unit radial direction (undefined on the axis).
    pub fn distance_form_grad<S: Scalar>(&self, p: Vec3<S>) -> Vec3<S> {
        let l = to_local(self.frame(), p);
        let rho = (l.x.square() + l.y.square()).sqrt();
        self.frame()
            .eval_vector(Vec3::new(l.x / rho, l.y / rho, S::zero()))
    }
}

impl Cone {
    /// Distance form `(ρ − |R + z·tan α|)·cos α` (vanishes on both nappes).
    ///
    /// `|·|` is evaluated as `√(·²)`, so forward-mode derivatives over an enclosure that
    /// straddles the apex plane are conservative (unbounded) instead of silently taking
    /// one branch.
    pub fn distance_form<S: Scalar>(&self, p: Vec3<S>) -> S {
        let (_, ca, ta) = cone_trig(self);
        let l = to_local(self.frame(), p);
        let rho = (l.x.square() + l.y.square()).sqrt();
        let rh = S::from_f64(self.radius()) + l.z * S::from_f64(ta);
        (rho - rh.square().sqrt()) * S::from_f64(ca)
    }
    /// Algebraic form `x² + y² − (R + z·tan α)²` (degree 2, the double cone).
    pub fn algebraic_form<S: Scalar>(&self, p: Vec3<S>) -> S {
        let (_, _, ta) = cone_trig(self);
        let l = to_local(self.frame(), p);
        let rh = S::from_f64(self.radius()) + l.z * S::from_f64(ta);
        l.x.square() + l.y.square() - rh.square()
    }
    /// Gradient of the distance form (undefined on the axis; on the apex plane the
    /// primary-nappe limit is used).
    pub fn distance_form_grad<S: Scalar>(&self, p: Vec3<S>) -> Vec3<S> {
        let (sa, ca, ta) = cone_trig(self);
        let l = to_local(self.frame(), p);
        let rho = (l.x.square() + l.y.square()).sqrt();
        let rh = S::from_f64(self.radius()) + l.z * S::from_f64(ta);
        let gz = if rh == S::zero() {
            S::from_f64(-sa)
        } else {
            -(rh * S::from_f64(sa)) / rh.abs()
        };
        let c = S::from_f64(ca);
        self.frame()
            .eval_vector(Vec3::new(c * l.x / rho, c * l.y / rho, gz))
    }
}

impl Sphere {
    /// Distance form `|p − c| − r` (exact signed distance; positive outside).
    pub fn distance_form<S: Scalar>(&self, p: Vec3<S>) -> S {
        let l = to_local(self.frame(), p);
        l.norm() - S::from_f64(self.radius())
    }
    /// Algebraic form `|p − c|² − r²` (degree 2).
    pub fn algebraic_form<S: Scalar>(&self, p: Vec3<S>) -> S {
        let l = to_local(self.frame(), p);
        l.norm_squared() - S::from_f64(self.radius() * self.radius())
    }
    /// Gradient of the distance form: the unit radial direction (undefined at the centre).
    pub fn distance_form_grad<S: Scalar>(&self, p: Vec3<S>) -> Vec3<S> {
        let l = to_local(self.frame(), p);
        let n = l.norm();
        self.frame().eval_vector(l / n)
    }
}

impl Torus {
    /// The signed radial offset of the tube circle this form measures from: `−R` (the
    /// tube circle on the far side of the axis) for the inner sheet of a spindle torus,
    /// `+R` otherwise.
    fn tube_offset(&self) -> f64 {
        if self.spindle_patch() == Some(SpindlePatch::Inner) {
            -self.major()
        } else {
            self.major()
        }
    }
    /// Distance form `√((ρ − R)² + z²) − r` (`ρ + R` for the inner sheet of a spindle
    /// torus): the signed distance to the tube around the centre circle.
    pub fn distance_form<S: Scalar>(&self, p: Vec3<S>) -> S {
        let l = to_local(self.frame(), p);
        let rho = (l.x.square() + l.y.square()).sqrt();
        let q = rho - S::from_f64(self.tube_offset());
        (q.square() + l.z.square()).sqrt() - S::from_f64(self.minor())
    }
    /// Algebraic form `(|p|² + R² − r²)² − 4R²(x² + y²)` (degree 4, both sheets of a
    /// spindle torus).
    pub fn algebraic_form<S: Scalar>(&self, p: Vec3<S>) -> S {
        let l = to_local(self.frame(), p);
        let (big, small) = (self.major(), self.minor());
        let k = S::from_f64(big * big - small * small);
        (l.norm_squared() + k).square()
            - S::from_f64(4.0 * big * big) * (l.x.square() + l.y.square())
    }
    /// Gradient of the distance form (undefined on the axis and on the centre circle).
    pub fn distance_form_grad<S: Scalar>(&self, p: Vec3<S>) -> Vec3<S> {
        let l = to_local(self.frame(), p);
        let rho = (l.x.square() + l.y.square()).sqrt();
        let q = rho - S::from_f64(self.tube_offset());
        let s = (q.square() + l.z.square()).sqrt();
        let a = q / s / rho;
        self.frame()
            .eval_vector(Vec3::new(a * l.x, a * l.y, l.z / s))
    }
}

impl Surface {
    /// The distance form `d(p)` of an analytic surface (see the [module docs](self)):
    /// `dist(p, S) <= |d(p)|` everywhere, with equality near the surface. `None` for
    /// B-spline surfaces.
    pub fn distance_form<S: Scalar>(&self, p: Vec3<S>) -> Option<S> {
        Some(match self {
            Surface::Plane(s) => s.distance_form(p),
            Surface::Cylinder(s) => s.distance_form(p),
            Surface::Cone(s) => s.distance_form(p),
            Surface::Sphere(s) => s.distance_form(p),
            Surface::Torus(s) => s.distance_form(p),
            Surface::BSpline(_) => return None,
        })
    }
    /// Gradient of the distance form (unit length near the surface). `None` for B-spline
    /// surfaces.
    pub fn distance_form_grad<S: Scalar>(&self, p: Vec3<S>) -> Option<Vec3<S>> {
        Some(match self {
            Surface::Plane(s) => s.distance_form_grad(p),
            Surface::Cylinder(s) => s.distance_form_grad(p),
            Surface::Cone(s) => s.distance_form_grad(p),
            Surface::Sphere(s) => s.distance_form_grad(p),
            Surface::Torus(s) => s.distance_form_grad(p),
            Surface::BSpline(_) => return None,
        })
    }
    /// The algebraic form `q(p)` (defining polynomial). `None` for B-spline surfaces.
    pub fn algebraic_form<S: Scalar>(&self, p: Vec3<S>) -> Option<S> {
        Some(match self {
            Surface::Plane(s) => s.algebraic_form(p),
            Surface::Cylinder(s) => s.algebraic_form(p),
            Surface::Cone(s) => s.algebraic_form(p),
            Surface::Sphere(s) => s.algebraic_form(p),
            Surface::Torus(s) => s.algebraic_form(p),
            Surface::BSpline(_) => return None,
        })
    }
    /// Degree of the algebraic form: 1 (plane), 2 (quadrics), 4 (torus); `None` for
    /// B-spline surfaces.
    pub fn algebraic_degree(&self) -> Option<u32> {
        match self {
            Surface::Plane(_) => Some(1),
            Surface::Cylinder(_) | Surface::Cone(_) | Surface::Sphere(_) => Some(2),
            Surface::Torus(_) => Some(4),
            Surface::BSpline(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scalar::{Dual, Interval};

    fn tilted() -> Frame {
        Frame::from_normal_x(
            Vec3::new(0.5, -1.0, 2.0),
            Vec3::new(0.3, 0.4, 1.0),
            Vec3::new(1.0, -0.2, 0.1),
        )
        .expect("frame")
    }

    fn surfaces() -> Vec<Surface> {
        let f = tilted();
        vec![
            Plane::new(f).into(),
            Cylinder::new(f, 2.0).expect("c").into(),
            Cone::new(f, 1.5, 0.6).expect("k").into(),
            Sphere::new(f, 3.0).expect("s").into(),
            Torus::new(f, 4.0, 1.25).expect("t").into(),
            Torus::new(f, 2.0, 2.0).expect("horn").into(),
            Torus::spindle(f, 1.0, 2.0, SpindlePatch::Outer)
                .expect("so")
                .into(),
            Torus::spindle(f, 1.0, 2.0, SpindlePatch::Inner)
                .expect("si")
                .into(),
        ]
    }

    fn params(s: &Surface) -> Vec<(f64, f64)> {
        let ((u0, u1), (v0, v1)) = s.domain();
        let (v0, v1) = if v0.is_finite() {
            (v0, v1)
        } else {
            (-3.0, 3.0)
        };
        let (u0, u1) = if u0.is_finite() {
            (u0, u1)
        } else {
            (-3.0, 3.0)
        };
        let mut out = Vec::new();
        for i in 0..9 {
            for j in 0..9 {
                let u = u0 + (u1 - u0) * (i as f64 + 0.3) / 9.0;
                let v = v0 + (v1 - v0) * (j as f64 + 0.4) / 9.0;
                out.push((u, v));
            }
        }
        out
    }

    #[test]
    fn both_forms_vanish_on_surface_points() {
        for s in surfaces() {
            for (u, v) in params(&s) {
                let p = s.eval(u, v);
                let d = s.distance_form(p).expect("analytic");
                let q = s.algebraic_form(p).expect("analytic");
                assert!(d.abs() < 1e-12, "{} d = {d} at ({u}, {v})", s.kind_name());
                assert!(q.abs() < 1e-10, "{} q = {q} at ({u}, {v})", s.kind_name());
            }
        }
    }

    #[test]
    fn distance_form_bounds_the_true_distance_and_matches_it_near_the_surface() {
        for s in surfaces() {
            for (u, v) in params(&s) {
                let Some(n) = s.normal(u, v) else { continue };
                for off in [-0.05, 0.02, 0.3] {
                    let p = s.eval(u, v) + n * off;
                    let d = s.distance_form(p).expect("analytic").abs();
                    // The foot point along the normal is at distance |off|.
                    assert!(d <= off.abs() + 1e-12, "{}: {d} > {off}", s.kind_name());
                    // Away from singularities the form is the exact distance.
                    let (_, _, true_d) = s.project(p);
                    assert!(true_d <= d + 1e-12, "{}: bound violated", s.kind_name());
                }
            }
        }
    }

    #[test]
    fn interval_forms_enclose_point_values() {
        for s in surfaces() {
            for (u, v) in params(&s).into_iter().step_by(7) {
                let p = s.eval(u, v) + Vec3::new(0.01, -0.02, 0.03);
                let pi: Vec3<Interval> = p.lift();
                let d = s.distance_form(p).expect("d");
                let di = s.distance_form(pi).expect("d");
                assert!(di.contains(d), "{}", s.kind_name());
                let q = s.algebraic_form(p).expect("q");
                assert!(s.algebraic_form(pi).expect("q").contains(q));
            }
        }
    }

    #[test]
    fn gradient_matches_forward_mode_derivatives() {
        for s in surfaces() {
            for (u, v) in params(&s).into_iter().step_by(5) {
                let p = s.eval(u, v) + Vec3::new(0.013, 0.021, -0.017);
                let g = s.distance_form_grad(p).expect("grad");
                for (k, e) in [Vec3::unit_x(), Vec3::unit_y(), Vec3::unit_z()]
                    .into_iter()
                    .enumerate()
                {
                    let pd = Vec3::new(
                        Dual::new(p.x, e.x),
                        Dual::new(p.y, e.y),
                        Dual::new(p.z, e.z),
                    );
                    let dd = s.distance_form(pd).expect("d").d;
                    let gk = [g.x, g.y, g.z][k];
                    assert!((dd - gk).abs() < 1e-9, "{} axis {k}", s.kind_name());
                }
            }
        }
    }

    #[test]
    fn algebraic_degrees() {
        let d: Vec<_> = surfaces()
            .iter()
            .map(|s| s.algebraic_degree().expect("analytic"))
            .collect();
        assert_eq!(d, vec![1, 2, 2, 2, 4, 4, 4, 4]);
    }
}
