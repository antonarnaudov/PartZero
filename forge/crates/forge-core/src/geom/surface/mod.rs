//! Surfaces: the geometry carried by faces.

mod analytic;
pub mod implicit;

pub use analytic::{Cone, Cylinder, Plane, Sphere, SpindlePatch, Torus};

use super::nurbs::NurbsSurface;
use crate::linalg::{Point3, Transform, Vec3};
use crate::math;
use crate::scalar::Scalar;

/// A surface point with its partial derivatives up to order 2.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurfaceDerivs<S: Scalar = f64> {
    /// `S(u, v)`.
    pub p: Vec3<S>,
    /// `∂S/∂u`.
    pub du: Vec3<S>,
    /// `∂S/∂v`.
    pub dv: Vec3<S>,
    /// `∂²S/∂u²`.
    pub duu: Vec3<S>,
    /// `∂²S/∂u∂v`.
    pub duv: Vec3<S>,
    /// `∂²S/∂v²`.
    pub dvv: Vec3<S>,
}

/// Relative size of `|S_u × S_v|` against `max(|S_u|, |S_v|)²` below which a B-spline
/// normal is treated as degenerate and the limit normal is used instead. This catches
/// both parallel derivatives and one derivative that is negligible next to the other
/// (a collapsed row whose `S_u` is pure rounding noise). `1e-8 ≈ √ε` balances the
/// rounding error of the direct formula against the `O(h)` error of the limit formula.
/// Not a topological decision: it only selects the formula for the normal.
pub const BSPLINE_NORMAL_DEGENERACY: f64 = 1e-8;

/// A surface.
///
/// | Variant | `u` | `v` | Periodicity `(u, v)` | Singularities |
/// |---|---|---|---|---|
/// | [`Plane`] | local x | local y | — | — |
/// | [`Cylinder`] | angle about z from x | height along z | (2π, —) | — |
/// | [`Cone`] | angle about z from x | height along z | (2π, —) | apex `v = −R/tan α` |
/// | [`Sphere`] | longitude | latitude `∈ [−π/2, π/2]` | (2π, —) | poles `v = ±π/2` |
/// | [`Torus`] | angle about z | angle around the tube | (2π, 2π); spindle patch (2π, —) | horn torus centre; spindle patch ends `v = ±v_s` |
/// | [`NurbsSurface`] | knot parameter | knot parameter | — | where `S_u × S_v = 0` |
///
/// The normal is always `normalize(S_u × S_v)` (or its limit at singular points). A
/// face's outward normal is the surface normal when `Face::sense` is true.
///
/// **Seams do not exist in Forge**: periodic parameters are handled natively in the face
/// parameter domain, and singular points (apex, poles) are not edges.
#[derive(Clone, Debug, PartialEq)]
pub enum Surface {
    /// Plane.
    Plane(Plane),
    /// Circular cylinder.
    Cylinder(Cylinder),
    /// Circular cone.
    Cone(Cone),
    /// Sphere.
    Sphere(Sphere),
    /// Torus.
    Torus(Torus),
    /// (Rational) B-spline surface.
    BSpline(NurbsSurface),
}

macro_rules! impl_from_surface {
    ($($t:ident),*) => {$(
        impl From<$t> for Surface {
            fn from(s: $t) -> Self {
                Surface::$t(s)
            }
        }
    )*};
}
impl_from_surface!(Plane, Cylinder, Cone, Sphere, Torus);

impl From<NurbsSurface> for Surface {
    fn from(s: NurbsSurface) -> Self {
        Surface::BSpline(s)
    }
}

impl Surface {
    /// Point at `(u, v)`.
    pub fn eval<S: Scalar>(&self, u: S, v: S) -> Vec3<S> {
        match self {
            Surface::Plane(s) => s.eval(u, v),
            Surface::Cylinder(s) => s.eval(u, v),
            Surface::Cone(s) => s.eval(u, v),
            Surface::Sphere(s) => s.eval(u, v),
            Surface::Torus(s) => s.eval(u, v),
            Surface::BSpline(s) => s.eval(u, v),
        }
    }
    /// Point and all partial derivatives up to order 2.
    pub fn derivs2<S: Scalar>(&self, u: S, v: S) -> SurfaceDerivs<S> {
        match self {
            Surface::Plane(s) => s.derivs2(u, v),
            Surface::Cylinder(s) => s.derivs2(u, v),
            Surface::Cone(s) => s.derivs2(u, v),
            Surface::Sphere(s) => s.derivs2(u, v),
            Surface::Torus(s) => s.derivs2(u, v),
            Surface::BSpline(s) => {
                let d = s.derivs(u, v, 2);
                SurfaceDerivs {
                    p: d[0][0],
                    du: d[1][0],
                    dv: d[0][1],
                    duu: d[2][0],
                    duv: d[1][1],
                    dvv: d[0][2],
                }
            }
        }
    }
    /// `(S, S_u, S_v)`.
    pub fn derivs1<S: Scalar>(&self, u: S, v: S) -> [Vec3<S>; 3] {
        match self {
            Surface::BSpline(s) => {
                let d = s.derivs(u, v, 1);
                [d[0][0], d[1][0], d[0][1]]
            }
            _ => {
                let d = self.derivs2(u, v);
                [d.p, d.du, d.dv]
            }
        }
    }
    /// `∂S/∂u`.
    pub fn du<S: Scalar>(&self, u: S, v: S) -> Vec3<S> {
        self.derivs1(u, v)[1]
    }
    /// `∂S/∂v`.
    pub fn dv<S: Scalar>(&self, u: S, v: S) -> Vec3<S> {
        self.derivs1(u, v)[2]
    }
    /// Unit normal `normalize(S_u × S_v)`.
    ///
    /// Analytic surfaces use closed forms that are also correct at their singular points
    /// (cone apex, sphere poles) and always return `Some`. For B-splines, where
    /// `S_u × S_v` degenerates (e.g. a collapsed row of control points), the limit normal
    /// is taken from the mixed derivative (`S_uv × S_v` or `S_u × S_uv`, approached from
    /// inside the domain); `None` if that also vanishes.
    pub fn normal<S: Scalar>(&self, u: S, v: S) -> Option<Vec3<S>> {
        match self {
            Surface::Plane(s) => Some(s.normal(u, v)),
            Surface::Cylinder(s) => Some(s.normal(u, v)),
            Surface::Cone(s) => Some(s.normal(u, v)),
            Surface::Sphere(s) => Some(s.normal(u, v)),
            Surface::Torus(s) => Some(s.normal(u, v)),
            Surface::BSpline(s) => bspline_normal(s, u, v),
        }
    }
    /// Closest point on the surface: `(u, v, distance)`.
    ///
    /// Closed form for every analytic type (periodic parameters are returned in
    /// `[0, 2π)`, the sphere latitude in `[−π/2, π/2]`; the cone considers both nappes).
    /// B-splines use grid seeding and damped Newton (see [`NurbsSurface::project`]).
    pub fn project(&self, p: Point3) -> (f64, f64, f64) {
        match self {
            Surface::Plane(s) => s.project(p),
            Surface::Cylinder(s) => s.project(p),
            Surface::Cone(s) => s.project(p),
            Surface::Sphere(s) => s.project(p),
            Surface::Torus(s) => s.project(p),
            Surface::BSpline(s) => s.project(p),
        }
    }
    /// Periods in `(u, v)`; `None` for a non-periodic direction.
    pub fn periodicity(&self) -> (Option<f64>, Option<f64>) {
        match self {
            Surface::Plane(_) | Surface::BSpline(_) => (None, None),
            Surface::Cylinder(_) | Surface::Cone(_) | Surface::Sphere(_) => (Some(math::TAU), None),
            Surface::Torus(t) if t.spindle_patch().is_some() => (Some(math::TAU), None),
            Surface::Torus(_) => (Some(math::TAU), Some(math::TAU)),
        }
    }
    /// Natural parameter ranges `((u0, u1), (v0, v1))`; infinite for unbounded
    /// directions, `[0, 2π)` for periodic ones, the sheet's `v` range for a spindle-torus
    /// patch ([`Torus::spindle_v_range`]).
    pub fn domain(&self) -> ((f64, f64), (f64, f64)) {
        let inf = (f64::NEG_INFINITY, f64::INFINITY);
        let per = (0.0, math::TAU);
        match self {
            Surface::Plane(_) => (inf, inf),
            Surface::Cylinder(_) | Surface::Cone(_) => (per, inf),
            Surface::Sphere(_) => (per, (-math::FRAC_PI_2, math::FRAC_PI_2)),
            Surface::Torus(t) => (per, t.spindle_v_range().unwrap_or(per)),
            Surface::BSpline(s) => s.domain(),
        }
    }
    /// `true` if the surface is closed in every direction and bounded, so a face may
    /// cover it entirely without any loop (sphere, torus, a whole spindle-torus patch).
    pub fn is_closed_without_boundary(&self) -> bool {
        matches!(self, Surface::Sphere(_) | Surface::Torus(_))
    }
    /// Canonical type name used by the metrics spec: `"plane"`, `"cylinder"`, `"cone"`,
    /// `"sphere"`, `"torus"` or `"bspline"`.
    pub fn kind_name(&self) -> &'static str {
        match self {
            Surface::Plane(_) => "plane",
            Surface::Cylinder(_) => "cylinder",
            Surface::Cone(_) => "cone",
            Surface::Sphere(_) => "sphere",
            Surface::Torus(_) => "torus",
            Surface::BSpline(_) => "bspline",
        }
    }
    /// The surface moved by a rigid transform (parametrization preserved).
    pub fn transform(&self, t: &Transform) -> Surface {
        match self {
            Surface::Plane(s) => Surface::Plane(s.transformed(t)),
            Surface::Cylinder(s) => Surface::Cylinder(s.transformed(t)),
            Surface::Cone(s) => Surface::Cone(s.transformed(t)),
            Surface::Sphere(s) => Surface::Sphere(s.transformed(t)),
            Surface::Torus(s) => Surface::Torus(s.transformed(t)),
            Surface::BSpline(s) => Surface::BSpline(s.transformed(t)),
        }
    }
}

fn bspline_normal<S: Scalar>(s: &NurbsSurface, u: S, v: S) -> Option<Vec3<S>> {
    let d = s.derivs(u, v, 2);
    let (su, sv, suv) = (d[1][0], d[0][1], d[1][1]);
    let n = su.cross(sv);
    let big = su.norm().to_f64().max(sv.norm().to_f64());
    if n.norm().to_f64() > BSPLINE_NORMAL_DEGENERACY * big * big {
        return n.normalize();
    }
    let ((_, u1), (_, v1)) = s.domain();
    let limit = if su.norm().to_f64() <= sv.norm().to_f64() {
        // S_u vanishes (collapsed u-row): S_u(u, v + h) ≈ h·S_uv.
        let n = suv.cross(sv);
        if v.to_f64() >= v1 { -n } else { n }
    } else {
        // S_v vanishes: S_v(u + h, v) ≈ h·S_uv.
        let n = su.cross(suv);
        if u.to_f64() >= u1 { -n } else { n }
    };
    limit.normalize()
}
