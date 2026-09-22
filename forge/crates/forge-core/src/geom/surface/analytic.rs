//! Analytic surfaces: plane, cylinder, cone, sphere, torus.
//!
//! Every surface is positioned by a [`Frame`]; formulas below are in frame-local
//! coordinates, with `e_r(u) = (cos u, sin u, 0)` and `e_u(u) = (−sin u, cos u, 0)`.
//! The surface normal is always `normalize(S_u × S_v)`; closed forms are used so the
//! normal is exact and defined at parametric singularities (see each type).

use super::SurfaceDerivs;
use crate::geom::error::{GeomError, check_positive};
use crate::linalg::{Frame, Point3, Transform, Vec3};
use crate::math;
use crate::scalar::Scalar;

/// Local polar decomposition: `(ρ, φ)` with `φ ∈ [0, 2π)`, `φ = 0` on the axis.
fn polar(l: Vec3) -> (f64, f64) {
    let rho = math::hypot(l.x, l.y);
    let phi = if rho > 0.0 {
        math::wrap_angle(math::atan2(l.y, l.x), 0.0)
    } else {
        0.0
    };
    (rho, phi)
}

fn derivs_from_local<S: Scalar>(f: &Frame, l: [Vec3<S>; 6]) -> SurfaceDerivs<S> {
    SurfaceDerivs {
        p: f.eval_point(l[0]),
        du: f.eval_vector(l[1]),
        dv: f.eval_vector(l[2]),
        duu: f.eval_vector(l[3]),
        duv: f.eval_vector(l[4]),
        dvv: f.eval_vector(l[5]),
    }
}

// ---------------------------------------------------------------------------------------

/// A plane: `S(u, v) = o + u·x + v·y`; `(u, v)` are the frame's local x/y coordinates.
/// Normal `z`. Not periodic, no singularities.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plane {
    frame: Frame,
}

impl Plane {
    /// The plane of `frame` (normal = `frame.z`).
    pub fn new(frame: Frame) -> Self {
        Self { frame }
    }
    /// The plane through `origin` with the given `normal` and a deterministic x axis.
    pub fn from_point_normal(origin: Point3, normal: Vec3) -> Result<Self, GeomError> {
        let frame = Frame::from_normal(origin, normal).ok_or(GeomError::DegenerateDirection {
            what: "plane normal",
        })?;
        Ok(Self { frame })
    }
    /// Frame.
    pub fn frame(&self) -> &Frame {
        &self.frame
    }
    /// Point at `(u, v)`.
    pub fn eval<S: Scalar>(&self, u: S, v: S) -> Vec3<S> {
        self.frame.eval_point(Vec3::new(u, v, S::zero()))
    }
    /// Point and derivatives up to order 2.
    pub fn derivs2<S: Scalar>(&self, u: S, v: S) -> SurfaceDerivs<S> {
        let z = Vec3::zero();
        derivs_from_local(
            &self.frame,
            [
                Vec3::new(u, v, S::zero()),
                Vec3::unit_x(),
                Vec3::unit_y(),
                z,
                z,
                z,
            ],
        )
    }
    /// Unit normal (`frame.z`).
    pub fn normal<S: Scalar>(&self, _u: S, _v: S) -> Vec3<S> {
        self.frame.z().lift()
    }
    /// Closest point `(u, v, distance)`.
    pub fn project(&self, p: Point3) -> (f64, f64, f64) {
        let l = self.frame.to_local_point(p);
        (l.x, l.y, l.z.abs())
    }
    /// Signed distance of `p` along the normal.
    pub fn signed_distance(&self, p: Point3) -> f64 {
        (p - self.frame.origin()).dot(self.frame.z())
    }
    /// The plane moved by a rigid transform.
    pub fn transformed(&self, t: &Transform) -> Self {
        Self {
            frame: self.frame.transformed(t),
        }
    }
}

// ---------------------------------------------------------------------------------------

/// A circular cylinder: `S(u, v) = o + r·e_r(u) + v·z`.
///
/// `u` is the angle about `frame.z` from `frame.x` (period 2π); `v` is the height along
/// `frame.z`. The normal `e_r(u)` points away from the axis. No singularities.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cylinder {
    frame: Frame,
    radius: f64,
}

impl Cylinder {
    /// A cylinder; `radius` must be finite and positive.
    pub fn new(frame: Frame, radius: f64) -> Result<Self, GeomError> {
        Ok(Self {
            frame,
            radius: check_positive("radius", radius)?,
        })
    }
    /// Frame (axis = z).
    pub fn frame(&self) -> &Frame {
        &self.frame
    }
    /// Radius.
    pub fn radius(&self) -> f64 {
        self.radius
    }
    /// Point at `(u, v)`.
    pub fn eval<S: Scalar>(&self, u: S, v: S) -> Vec3<S> {
        let (s, c) = u.sin_cos();
        let r = S::from_f64(self.radius);
        self.frame.eval_point(Vec3::new(r * c, r * s, v))
    }
    /// Point and derivatives up to order 2.
    pub fn derivs2<S: Scalar>(&self, u: S, v: S) -> SurfaceDerivs<S> {
        let (s, c) = u.sin_cos();
        let r = S::from_f64(self.radius);
        let z = S::zero();
        derivs_from_local(
            &self.frame,
            [
                Vec3::new(r * c, r * s, v),
                Vec3::new(-r * s, r * c, z),
                Vec3::unit_z(),
                Vec3::new(-r * c, -r * s, z),
                Vec3::zero(),
                Vec3::zero(),
            ],
        )
    }
    /// Unit normal `e_r(u)`.
    pub fn normal<S: Scalar>(&self, u: S, _v: S) -> Vec3<S> {
        let (s, c) = u.sin_cos();
        self.frame.eval_vector(Vec3::new(c, s, S::zero()))
    }
    /// Closest point `(u, v, distance)`, `u ∈ [0, 2π)`; `u = 0` for points on the axis.
    pub fn project(&self, p: Point3) -> (f64, f64, f64) {
        let l = self.frame.to_local_point(p);
        let (rho, phi) = polar(l);
        (phi, l.z, (rho - self.radius).abs())
    }
    /// The cylinder moved by a rigid transform.
    pub fn transformed(&self, t: &Transform) -> Self {
        Self {
            frame: self.frame.transformed(t),
            radius: self.radius,
        }
    }
}

// ---------------------------------------------------------------------------------------

/// A circular cone: `S(u, v) = o + (R + v·tan α)·e_r(u) + v·z`.
///
/// # Parametrization
/// - `u`: angle about `frame.z` from `frame.x` (period 2π), as for the cylinder.
/// - `v`: **height along the axis** `frame.z` (not the slant length). This matches the
///   cylinder's `v` (a cone with α → 0 degenerates to the cylinder parametrization) and
///   STEP's `conical_surface`, so planar sections perpendicular to the axis are
///   iso-`v` lines.
/// - `R = radius` is the radius of the section `v = 0` (may be 0: the origin is then the
///   apex), `α = half_angle ∈ (0, π/2)`; the cone widens towards `+z`.
///
/// # Apex
/// The apex is at `v_apex = −R / tan α` (see [`Cone::apex`]). It is a **surface
/// singularity**, not an edge: a full-revolution cone face is bounded only by its base
/// ring. The formula is also defined for `v < v_apex`, where it traces the opposite nappe
/// (`r(v) < 0`); faces use one nappe. `S_u = 0` at the apex; [`Cone::normal`] returns the
/// limit from the primary nappe, `cos α·e_r(u) − sin α·z`, which depends on `u` only (the
/// normal is constant along each generator). On the opposite nappe the parametric normal
/// `S_u × S_v` flips, and so does [`Cone::normal`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cone {
    frame: Frame,
    radius: f64,
    half_angle: f64,
    sin_a: f64,
    cos_a: f64,
    tan_a: f64,
}

impl Cone {
    /// A cone; `radius >= 0` (finite) and `half_angle ∈ (0, π/2)` radians.
    pub fn new(frame: Frame, radius: f64, half_angle: f64) -> Result<Self, GeomError> {
        if !(radius.is_finite() && radius >= 0.0) {
            return Err(GeomError::InvalidParameter {
                what: "cone radius",
                value: radius,
                expected: "finite and >= 0",
            });
        }
        if !(half_angle > 0.0 && half_angle < math::FRAC_PI_2) {
            return Err(GeomError::InvalidParameter {
                what: "cone half_angle",
                value: half_angle,
                expected: "in (0, π/2) radians",
            });
        }
        let (sin_a, cos_a) = math::sin_cos(half_angle);
        Ok(Self {
            frame,
            radius,
            half_angle,
            sin_a,
            cos_a,
            tan_a: sin_a / cos_a,
        })
    }
    /// Frame (axis = z, pointing towards the widening side).
    pub fn frame(&self) -> &Frame {
        &self.frame
    }
    /// Radius of the section `v = 0`.
    pub fn radius(&self) -> f64 {
        self.radius
    }
    /// Half angle α (radians).
    pub fn half_angle(&self) -> f64 {
        self.half_angle
    }
    /// Axial parameter of the apex, `−R / tan α`.
    pub fn apex_v(&self) -> f64 {
        -self.radius / self.tan_a
    }
    /// The apex point.
    pub fn apex(&self) -> Point3 {
        self.frame
            .to_world_point(Vec3::new(0.0, 0.0, self.apex_v()))
    }
    /// Section radius `r(v) = R + v·tan α` (negative on the opposite nappe).
    pub fn radius_at<S: Scalar>(&self, v: S) -> S {
        S::from_f64(self.radius) + v * S::from_f64(self.tan_a)
    }
    /// Point at `(u, v)`.
    pub fn eval<S: Scalar>(&self, u: S, v: S) -> Vec3<S> {
        let (s, c) = u.sin_cos();
        let r = self.radius_at(v);
        self.frame.eval_point(Vec3::new(r * c, r * s, v))
    }
    /// Point and derivatives up to order 2.
    pub fn derivs2<S: Scalar>(&self, u: S, v: S) -> SurfaceDerivs<S> {
        let (s, c) = u.sin_cos();
        let r = self.radius_at(v);
        let t = S::from_f64(self.tan_a);
        let z = S::zero();
        derivs_from_local(
            &self.frame,
            [
                Vec3::new(r * c, r * s, v),
                Vec3::new(-r * s, r * c, z),
                Vec3::new(t * c, t * s, S::one()),
                Vec3::new(-r * c, -r * s, z),
                Vec3::new(-t * s, t * c, z),
                Vec3::zero(),
            ],
        )
    }
    /// Unit normal (see the type docs for the apex and the opposite nappe).
    pub fn normal<S: Scalar>(&self, u: S, v: S) -> Vec3<S> {
        let (s, c) = u.sin_cos();
        let (sa, ca) = (S::from_f64(self.sin_a), S::from_f64(self.cos_a));
        let n = self.frame.eval_vector(Vec3::new(ca * c, ca * s, -sa));
        if self.radius_at(v) < S::zero() { -n } else { n }
    }
    /// Closest point `(u, v, distance)` on the full double cone, `u ∈ [0, 2π)`.
    ///
    /// In the half-plane through the axis containing `p` (local polar `(ρ, φ)`, height
    /// `h`), the nearest generator is on this side (`u = φ`) when `ρ·r(h) >= 0` and on the
    /// opposite side (`u = φ + π`, the other nappe) otherwise; the foot point is the
    /// orthogonal projection onto that generator line. Points on the axis get `u = 0`.
    pub fn project(&self, p: Point3) -> (f64, f64, f64) {
        let l = self.frame.to_local_point(p);
        let (rho, phi) = polar(l);
        let (h, t, c2) = (l.z, self.tan_a, self.cos_a * self.cos_a);
        let rh = self.radius + h * t;
        if rho * rh >= 0.0 {
            let v = c2 * (h + t * (rho - self.radius));
            (phi, v, (rho - rh).abs() * self.cos_a)
        } else {
            let v = c2 * (h - t * (self.radius + rho));
            (
                math::wrap_angle(phi + math::PI, 0.0),
                v,
                (rho + rh).abs() * self.cos_a,
            )
        }
    }
    /// The cone moved by a rigid transform.
    pub fn transformed(&self, t: &Transform) -> Self {
        Self {
            frame: self.frame.transformed(t),
            ..*self
        }
    }
}

// ---------------------------------------------------------------------------------------

/// A sphere: `S(u, v) = o + r·(cos v·e_r(u) + sin v·z)`.
///
/// `u` is the longitude about `frame.z` from `frame.x` (period 2π); `v ∈ [−π/2, π/2]` is
/// the latitude. The poles `v = ±π/2` are **surface singularities** (`S_u = 0`), not
/// edges; [`Sphere::normal`] is the closed form `cos v·e_r(u) + sin v·z`, which equals
/// `±z` at the poles for every `u`. A full sphere face has no loops at all.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sphere {
    frame: Frame,
    radius: f64,
}

impl Sphere {
    /// A sphere; `radius` must be finite and positive.
    pub fn new(frame: Frame, radius: f64) -> Result<Self, GeomError> {
        Ok(Self {
            frame,
            radius: check_positive("radius", radius)?,
        })
    }
    /// Frame (centre = origin, poles along ±z).
    pub fn frame(&self) -> &Frame {
        &self.frame
    }
    /// Radius.
    pub fn radius(&self) -> f64 {
        self.radius
    }
    /// Point at `(u, v)`.
    pub fn eval<S: Scalar>(&self, u: S, v: S) -> Vec3<S> {
        let (su, cu) = u.sin_cos();
        let (sv, cv) = v.sin_cos();
        let r = S::from_f64(self.radius);
        self.frame
            .eval_point(Vec3::new(r * cv * cu, r * cv * su, r * sv))
    }
    /// Point and derivatives up to order 2.
    pub fn derivs2<S: Scalar>(&self, u: S, v: S) -> SurfaceDerivs<S> {
        let (su, cu) = u.sin_cos();
        let (sv, cv) = v.sin_cos();
        let r = S::from_f64(self.radius);
        let z = S::zero();
        let p = Vec3::new(r * cv * cu, r * cv * su, r * sv);
        derivs_from_local(
            &self.frame,
            [
                p,
                Vec3::new(-r * cv * su, r * cv * cu, z),
                Vec3::new(-r * sv * cu, -r * sv * su, r * cv),
                Vec3::new(-r * cv * cu, -r * cv * su, z),
                Vec3::new(r * sv * su, -r * sv * cu, z),
                -p,
            ],
        )
    }
    /// Unit outward normal `cos v·e_r(u) + sin v·z` (defined at the poles).
    pub fn normal<S: Scalar>(&self, u: S, v: S) -> Vec3<S> {
        let (su, cu) = u.sin_cos();
        let (sv, cv) = v.sin_cos();
        self.frame.eval_vector(Vec3::new(cv * cu, cv * su, sv))
    }
    /// Closest point `(u, v, distance)`, `u ∈ [0, 2π)`, `v ∈ [−π/2, π/2]`. On the axis
    /// `u = 0`; at the centre `(0, 0)`.
    pub fn project(&self, p: Point3) -> (f64, f64, f64) {
        let l = self.frame.to_local_point(p);
        let (rho, phi) = polar(l);
        let v = if rho > 0.0 || l.z != 0.0 {
            math::atan2(l.z, rho)
        } else {
            0.0
        };
        (phi, v, (l.norm() - self.radius).abs())
    }
    /// The sphere moved by a rigid transform.
    pub fn transformed(&self, t: &Transform) -> Self {
        Self {
            frame: self.frame.transformed(t),
            radius: self.radius,
        }
    }
}

// ---------------------------------------------------------------------------------------

/// A torus: `S(u, v) = o + (R + r·cos v)·e_r(u) + r·sin v·z`.
///
/// `u` is the angle about the axis `frame.z` from `frame.x`; `v` is the angle around the
/// tube, measured from the outer equator towards `+z`. Both have period 2π. `R = major`,
/// `r = minor`, with `0 < r <= R` (ring torus; `r = R` is the horn torus whose tube
/// touches the axis at a singular point). The normal `cos v·e_r(u) + sin v·z` points out
/// of the tube.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Torus {
    frame: Frame,
    major: f64,
    minor: f64,
}

impl Torus {
    /// A torus; `0 < minor <= major`, both finite.
    pub fn new(frame: Frame, major: f64, minor: f64) -> Result<Self, GeomError> {
        let major = check_positive("torus major radius", major)?;
        let minor = check_positive("torus minor radius", minor)?;
        if minor > major {
            return Err(GeomError::InvalidParameter {
                what: "torus minor radius",
                value: minor,
                expected: "<= major radius (spindle tori are not supported)",
            });
        }
        Ok(Self {
            frame,
            major,
            minor,
        })
    }
    /// Frame (axis = z).
    pub fn frame(&self) -> &Frame {
        &self.frame
    }
    /// Major radius `R` (axis to tube centre).
    pub fn major(&self) -> f64 {
        self.major
    }
    /// Minor radius `r` (tube radius).
    pub fn minor(&self) -> f64 {
        self.minor
    }
    /// Point at `(u, v)`.
    pub fn eval<S: Scalar>(&self, u: S, v: S) -> Vec3<S> {
        let (su, cu) = u.sin_cos();
        let (sv, cv) = v.sin_cos();
        let r = S::from_f64(self.minor);
        let rho = S::from_f64(self.major) + r * cv;
        self.frame.eval_point(Vec3::new(rho * cu, rho * su, r * sv))
    }
    /// Point and derivatives up to order 2.
    pub fn derivs2<S: Scalar>(&self, u: S, v: S) -> SurfaceDerivs<S> {
        let (su, cu) = u.sin_cos();
        let (sv, cv) = v.sin_cos();
        let r = S::from_f64(self.minor);
        let rho = S::from_f64(self.major) + r * cv;
        let z = S::zero();
        derivs_from_local(
            &self.frame,
            [
                Vec3::new(rho * cu, rho * su, r * sv),
                Vec3::new(-rho * su, rho * cu, z),
                Vec3::new(-r * sv * cu, -r * sv * su, r * cv),
                Vec3::new(-rho * cu, -rho * su, z),
                Vec3::new(r * sv * su, -r * sv * cu, z),
                Vec3::new(-r * cv * cu, -r * cv * su, -r * sv),
            ],
        )
    }
    /// Unit normal `cos v·e_r(u) + sin v·z`.
    pub fn normal<S: Scalar>(&self, u: S, v: S) -> Vec3<S> {
        let (su, cu) = u.sin_cos();
        let (sv, cv) = v.sin_cos();
        self.frame.eval_vector(Vec3::new(cv * cu, cv * su, sv))
    }
    /// Closest point `(u, v, distance)`, `u, v ∈ [0, 2π)`. Points on the axis get `u = 0`;
    /// points on the tube's centre circle get `v = 0`.
    pub fn project(&self, p: Point3) -> (f64, f64, f64) {
        let l = self.frame.to_local_point(p);
        let (rho, phi) = polar(l);
        let (dx, dz) = (rho - self.major, l.z);
        let v = if dx != 0.0 || dz != 0.0 {
            math::wrap_angle(math::atan2(dz, dx), 0.0)
        } else {
            0.0
        };
        (phi, v, (math::hypot(dx, dz) - self.minor).abs())
    }
    /// The torus moved by a rigid transform.
    pub fn transformed(&self, t: &Transform) -> Self {
        Self {
            frame: self.frame.transformed(t),
            ..*self
        }
    }
}
