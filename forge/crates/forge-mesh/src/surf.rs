//! Surface-side helpers shared by edge discretization and face meshing: derived
//! tolerances, singular-point classification, periodic unwrapping, pcurve/projection
//! parameter lookup.

use forge_core::geom::{Curve2, Curve3, Surface};
use forge_core::math;
use forge_core::tolerance::IR_LINEAR_TOLERANCE;
use forge_core::{Point3, Vec3};

use crate::TessParams;

/// Safety factor applied to the chordal deflection for every **midpoint** test.
///
/// For a surface that is locally quadratic, the deviation of a flat triangle from the
/// surface is a quadratic form `α·λ₁λ₂ + β·λ₀λ₂ + γ·λ₀λ₁` in barycentric coordinates
/// that vanishes at the vertices. Its value at an edge midpoint is a quarter of the
/// corresponding coefficient and its maximum over the triangle is at most
/// `max(|α|, |β|, |γ|)/3`, i.e. at most **4/3** of the largest edge-midpoint deviation.
/// Requiring every midpoint deviation to be `≤ 0.74·δ` therefore bounds the whole
/// triangle (and every boundary chord) by `0.987·δ` under that model; the remaining
/// 1.3 % absorbs the higher-order terms (`≈ c²/(48 r²)` relative on a sphere of radius
/// `r` for chords `c`), and the centroid is additionally checked against `δ`.
pub(crate) const MIDPOINT_FACTOR: f64 = 0.74;

/// Length below which an iso-parameter line is considered collapsed to a point (a
/// surface singularity such as a sphere pole or a cone apex): the IR's linear tolerance.
pub(crate) const SINGULAR_ISOLINE_LENGTH: f64 = IR_LINEAR_TOLERANCE;

/// Largest parameter step allowed along any circle-like direction (at least four
/// samples per full turn, which also keeps projected parameters unambiguous to unwrap).
pub(crate) const MAX_ANGULAR_STEP: f64 = math::FRAC_PI_2;

/// Derived, explicit tolerances for one tessellation run.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Tol {
    /// Bound for midpoint deviations (`MIDPOINT_FACTOR · chordal_deflection`).
    pub dev_mid: f64,
    /// Bound for centroid deviations (`chordal_deflection`).
    pub dev: f64,
    /// Angular deflection (radians).
    pub ang: f64,
    /// Optional maximum edge length.
    pub len: Option<f64>,
}

impl Tol {
    pub fn new(p: &TessParams) -> Self {
        Self {
            dev_mid: MIDPOINT_FACTOR * p.chordal_deflection,
            dev: p.chordal_deflection,
            ang: p.angular_deflection_rad,
            len: p.max_edge_length,
        }
    }

    /// Largest angle step along a circle of radius `radius` meeting the chordal
    /// (midpoint), angular and edge-length limits, capped at [`MAX_ANGULAR_STEP`].
    pub fn circle_step(&self, radius: f64) -> f64 {
        let mut th = self.ang.min(MAX_ANGULAR_STEP);
        if radius > 0.0 && radius.is_finite() {
            if self.dev_mid < radius {
                th = th.min(2.0 * math::acos(1.0 - self.dev_mid / radius));
            }
            if let Some(l) = self.len
                && l < 2.0 * radius
            {
                th = th.min(2.0 * math::asin(l / (2.0 * radius)));
            }
        }
        th
    }

    /// `max(dev/dev_mid, angle/ang, length/len)`: > 1 means a midpoint test fails.
    pub fn badness(&self, dev: f64, angle: f64, length: f64) -> f64 {
        let mut b = dev / self.dev_mid;
        b = b.max(angle / self.ang);
        if let Some(l) = self.len {
            b = b.max(length / l);
        }
        b
    }
}

/// Which parameter of a surface point is irrelevant because its iso-line collapses to a
/// point (a surface singularity).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Sing {
    /// Regular point.
    No,
    /// `S_u = 0`: the whole iso-`v` line through the point is this point (sphere pole,
    /// cone apex). The `u` value is arbitrary.
    U,
    /// `S_v = 0` (collapsed B-spline column).
    V,
}

/// A face surface with its periodicity and orientation.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Surf<'a> {
    pub s: &'a Surface,
    /// Face sense (`true`: outward normal = surface normal).
    pub sense: bool,
    /// Periods in `(u, v)`.
    pub per: [Option<f64>; 2],
    /// Parameter spans used to turn `|S_u|`, `|S_v|` into iso-line lengths.
    span: [f64; 2],
}

impl<'a> Surf<'a> {
    pub fn new(s: &'a Surface, sense: bool) -> Self {
        let (pu, pv) = s.periodicity();
        let ((u0, u1), (v0, v1)) = s.domain();
        let span = |p: Option<f64>, a: f64, b: f64| {
            p.unwrap_or(if (b - a).is_finite() { b - a } else { 1.0 })
        };
        Self {
            s,
            sense,
            per: [pu, pv],
            span: [span(pu, u0, u1), span(pv, v0, v1)],
        }
    }

    #[inline]
    pub fn eval(&self, uv: [f64; 2]) -> Point3 {
        self.s.eval(uv[0], uv[1])
    }

    /// Parametric normal direction `normalize(S_u × S_v)` (limit value at singular
    /// points).
    #[inline]
    pub fn normal_param(&self, uv: [f64; 2]) -> Option<Vec3> {
        self.s.normal(uv[0], uv[1])
    }

    /// Outward normal of the face.
    #[inline]
    pub fn normal_out(&self, uv: [f64; 2]) -> Option<Vec3> {
        self.normal_param(uv)
            .map(|n| if self.sense { n } else { -n })
    }

    /// Singularity classification of a parameter point.
    pub fn sing(&self, uv: [f64; 2]) -> Sing {
        match self.s {
            Surface::Plane(_) | Surface::Cylinder(_) => Sing::No,
            _ => {
                let [_, su, sv] = self.s.derivs1(uv[0], uv[1]);
                if su.norm() * self.span[0] <= SINGULAR_ISOLINE_LENGTH {
                    Sing::U
                } else if sv.norm() * self.span[1] <= SINGULAR_ISOLINE_LENGTH {
                    Sing::V
                } else {
                    Sing::No
                }
            }
        }
    }

    /// Shift the periodic coordinates of `uv` by whole periods to be nearest `near`.
    pub fn unwrap_near(&self, mut uv: [f64; 2], near: [f64; 2]) -> [f64; 2] {
        for d in 0..2 {
            if let Some(p) = self.per[d] {
                let k = ((near[d] - uv[d]) / p).round();
                uv[d] += k * p;
            }
        }
        uv
    }

    /// Parameters of the point at `t` on an edge used by this face: the coedge's pcurve
    /// if present, otherwise the projection of the edge point onto the surface,
    /// unwrapped next to `near` (and taking the irrelevant coordinate from `near` at a
    /// singular point, i.e. the limit along the curve).
    pub fn coedge_uv(
        &self,
        pcurve: Option<&Curve2>,
        curve: &Curve3,
        t: f64,
        near: Option<[f64; 2]>,
    ) -> [f64; 2] {
        if let Some(pc) = pcurve {
            let p = pc.eval(t);
            return [p.x, p.y];
        }
        let (u, v, _) = self.s.project(curve.eval(t));
        let mut uv = [u, v];
        if let Some(n) = near {
            uv = self.unwrap_near(uv, n);
            match self.sing(uv) {
                Sing::U => uv[0] = n[0],
                Sing::V => uv[1] = n[1],
                Sing::No => {}
            }
        }
        uv
    }
}

/// Replace the irrelevant coordinate of a singular endpoint by the other endpoint's, so
/// a parameter segment ending at a singular point runs along the iso-line that reaches
/// it (a meridian into a pole, a generator into an apex).
pub(crate) fn virtual_pair(a: [f64; 2], sa: Sing, b: [f64; 2], sb: Sing) -> ([f64; 2], [f64; 2]) {
    let (mut a2, mut b2) = (a, b);
    match (sa, sb) {
        (Sing::U, Sing::No) | (Sing::U, Sing::V) => a2[0] = b[0],
        (Sing::No, Sing::U) | (Sing::V, Sing::U) => b2[0] = a[0],
        (Sing::V, Sing::No) => a2[1] = b[1],
        (Sing::No, Sing::V) => b2[1] = a[1],
        _ => {}
    }
    (a2, b2)
}

/// Angle between two directions in `[0, π]` (robust `atan2` form); 0 if either is zero.
pub(crate) fn angle_between(a: Vec3, b: Vec3) -> f64 {
    let c = a.cross(b).norm();
    let d = a.dot(b);
    if c == 0.0 && d == 0.0 {
        0.0
    } else {
        math::atan2(c, d)
    }
}

#[inline]
pub(crate) fn mid2(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])]
}
