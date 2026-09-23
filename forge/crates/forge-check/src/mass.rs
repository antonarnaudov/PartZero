//! Mass properties on the exact geometry (no tessellation).
//!
//! # Formulation
//! With `n = S_u × S_v` and `s = ±1` the face sense, the divergence theorem gives
//! (relative to a reference point `c`, `P = S − c`):
//! - area `A = Σ_f ∬ |n| du dv`,
//! - volume `V = Σ_f ∬ (s/3)·P·n du dv`,
//! - first moments `M = Σ_f ∬ (s/4)·P·(P·n) du dv` (from `div(x_i·P) = 4·x_i`),
//!
//! and the centroid is `c + M/V`. Each face integral `∬_D g du dv` over the trimmed
//! domain `D` is turned into a boundary integral over the lifted pcurve loops with
//! Green's theorem, in the form that is valid on the face's periodic domain:
//! - **v-form** `∬ g = −∮ P du`, `P(u, v) = ∫_{v*}^{v} g(u, τ) dτ`, used when loops wrap
//!   around the periodic `u` direction (or nothing wraps): `P` is periodic in `u`, so no
//!   seam is needed. If the domain extends from its boundary to a singular line (cone
//!   apex, sphere pole, spindle-torus axis point) `v*` is placed on that line, where
//!   the surface collapses and the missing boundary contributes nothing.
//! - **u-form** `∬ g = ∮ Q dv`, `Q = ∫_{u*}^{u} g(s, v) ds`, when loops wrap around a
//!   periodic `v` (a partial torus from a revolved circle).
//! - **Loop-less faces** (whole sphere, torus or spindle patch) integrate the full
//!   parameter rectangle directly.
//!
//! The boundary orientation is the pcurve orientation times `σ` (see `domain`).
//!
//! # Quadrature
//! Composite 16-point Gauss–Legendre, exact for polynomials of degree ≤ 31. Angular
//! coordinates and angle-parametrized pcurves are split into panels of at most π/8
//! (trigonometric integrands of low frequency then converge to rounding level); linear
//! coordinates of planes, cylinders and cones enter polynomially (degree ≤ 3) and need
//! one panel. B-spline pcurves are integrated per knot span. The result is accurate to
//! ~1e-14 relative on analytic faces.

use std::sync::OnceLock;

use forge_core::geom::Surface;
use forge_core::geom::quadrature::gauss_legendre;
use forge_core::linalg::{Point3, Vec2};
use forge_core::math;

use crate::CheckError;
use crate::domain::{FaceDomain, singular_v};

/// Maximum panel width (radians) for angular coordinates.
pub const ANGULAR_PANEL: f64 = math::PI / 8.0;

/// Integrated quantities `[area, volume, Mx, My, Mz]`.
pub(crate) type Q5 = [f64; 5];

fn rule() -> &'static [(f64, f64)] {
    static RULE: OnceLock<Vec<(f64, f64)>> = OnceLock::new();
    RULE.get_or_init(|| gauss_legendre(16))
}

fn add(a: &mut Q5, b: Q5, w: f64) {
    for i in 0..5 {
        a[i] += w * b[i];
    }
}

/// Which parameters of a surface are angles (they need panels of at most π/8).
fn angular(surface: &Surface) -> (bool, bool) {
    match surface {
        Surface::Plane(_) | Surface::BSpline(_) => (false, false),
        Surface::Cylinder(_) | Surface::Cone(_) => (true, false),
        Surface::Sphere(_) | Surface::Torus(_) => (true, true),
    }
}

fn panels(delta: f64, is_angle: bool) -> usize {
    if is_angle {
        ((delta.abs() / ANGULAR_PANEL).ceil() as usize).max(1)
    } else {
        1
    }
}

/// Integrand at `(u, v)`.
fn density(surface: &Surface, sense: f64, c: Point3, u: f64, v: f64) -> Q5 {
    let [p, su, sv] = surface.derivs1(u, v);
    let n = su.cross(sv);
    let q = p - c;
    let qn = q.dot(n);
    let m = 0.25 * sense * qn;
    [n.norm(), sense * qn / 3.0, m * q.x, m * q.y, m * q.z]
}

/// `∫_{a}^{b} f(x) dx` of a vector integrand on `n` equal panels.
fn integrate(mut f: impl FnMut(f64) -> Q5, a: f64, b: f64, n: usize) -> Q5 {
    let mut out = [0.0; 5];
    if a.to_bits() == b.to_bits() {
        return out;
    }
    let h = (b - a) / n as f64;
    for k in 0..n {
        let lo = a + h * k as f64;
        let hi = if k + 1 == n { b } else { lo + h };
        let (mid, half) = (0.5 * (lo + hi), 0.5 * (hi - lo));
        for &(x, w) in rule() {
            add(&mut out, f(mid + half * x), w * half);
        }
    }
    out
}

/// The integrals of one face.
pub(crate) fn face_integrals(
    dom: &FaceDomain<'_>,
    sense: f64,
    c: Point3,
) -> Result<Q5, CheckError> {
    let s = dom.surface;
    if matches!(s, Surface::BSpline(_)) {
        return Err(CheckError::Unsupported {
            what: "mass properties of B-spline faces",
        });
    }
    let (ang_u, ang_v) = angular(s);
    if dom.is_loopless() {
        let ((u0, u1), (v0, v1)) = s.domain();
        let nu = panels(u1 - u0, ang_u);
        let nv = panels(v1 - v0, ang_v);
        return Ok(integrate(
            |u| integrate(|v| density(s, sense, c, u, v), v0, v1, nv),
            u0,
            u1,
            nu,
        ));
    }
    let (pu, pv) = s.periodicity();
    let use_u_form = pv.is_some() && dom.wraps_v() && !dom.wraps_u();
    if pu.is_some() && dom.wraps_u() && dom.wraps_v() {
        return Err(CheckError::Unsupported {
            what: "faces whose loops wrap around both periodic directions",
        });
    }
    let first = dom
        .pieces()
        .next()
        .map(|p| p.start())
        .unwrap_or(Vec2::zero());
    let mut total = [0.0; 5];
    if use_u_form {
        if dom.winding_v() != 0 {
            return Err(CheckError::UnboundedDomain {
                face: String::new(),
            });
        }
        let u_star = first.x;
        for piece in dom.pieces() {
            for (a, b) in piece.spans() {
                let (ua, _) = piece.eval(a);
                let (ub, _) = piece.eval(b);
                let n = outer_panels(piece.angular_parameter(), a, b, ua, ub, ang_u, ang_v);
                let q = integrate(
                    |t| {
                        let (uv, d) = piece.eval(t);
                        let inner = integrate(
                            |x| density(s, sense, c, x, uv.y),
                            u_star,
                            uv.x,
                            panels(uv.x - u_star, ang_u),
                        );
                        let mut o = [0.0; 5];
                        add(&mut o, inner, d.y);
                        o
                    },
                    a,
                    b,
                    n,
                );
                add(&mut total, q, dom.sigma);
            }
        }
        return Ok(total);
    }
    // v-form.
    let w = dom.winding_u();
    let v_star = if w == 0 {
        first.y
    } else {
        let (lo, hi) = dom.v_extent();
        let eps = 1e-9 * (1.0 + lo.abs().max(hi.abs()));
        let sing = singular_v(s);
        let pick = if w > 0 {
            sing.iter()
                .copied()
                .filter(|x| *x >= hi - eps)
                .reduce(f64::min)
        } else {
            sing.iter()
                .copied()
                .filter(|x| *x <= lo + eps)
                .reduce(f64::max)
        };
        pick.ok_or(CheckError::UnboundedDomain {
            face: String::new(),
        })?
    };
    for piece in dom.pieces() {
        for (a, b) in piece.spans() {
            let (ua, _) = piece.eval(a);
            let (ub, _) = piece.eval(b);
            let n = outer_panels(piece.angular_parameter(), a, b, ua, ub, ang_u, ang_v);
            let q = integrate(
                |t| {
                    let (uv, d) = piece.eval(t);
                    let inner = integrate(
                        |y| density(s, sense, c, uv.x, y),
                        v_star,
                        uv.y,
                        panels(uv.y - v_star, ang_v),
                    );
                    let mut o = [0.0; 5];
                    add(&mut o, inner, d.x);
                    o
                },
                a,
                b,
                n,
            );
            add(&mut total, q, -dom.sigma);
        }
    }
    Ok(total)
}

fn outer_panels(
    angular_param: bool,
    a: f64,
    b: f64,
    ua: Vec2,
    ub: Vec2,
    ang_u: bool,
    ang_v: bool,
) -> usize {
    let by_param = panels(b - a, angular_param);
    let by_u = panels(ub.x - ua.x, ang_u);
    let by_v = panels(ub.y - ua.y, ang_v);
    by_param.max(by_u).max(by_v)
}
