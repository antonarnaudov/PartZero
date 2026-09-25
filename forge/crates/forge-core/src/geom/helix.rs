//! Helical and spiral curves: the edges of modelled screw threads.
//!
//! - [`Helix3`]: `C(t) = o + ρ(t)·e_r(t) + p·t·z`, `ρ(t) = r + a·t`, in a frame
//!   (`e_r(t) = cos t·x + sin t·y`). With `a = 0` it is a circular helix (a thread flank
//!   meeting a cylinder), with `p = 0` an Archimedean spiral in a plane perpendicular to
//!   the axis (a thread flank meeting an end plane), otherwise a conical helix. The
//!   parameter `t` is the **angle** about the frame's `z` axis.
//! - [`Spiral2`]: the image of an Archimedean spiral in a plane's `(u, v)` space (the
//!   pcurve of a planar [`Helix3`] on a plane face).
//!
//! The parameter is not periodic: one edge may wind many turns. The curves are valid
//! where `ρ(t) > 0` ([`Helix3::domain`]).

use super::error::GeomError;
use super::quadrature;
use crate::linalg::{Frame, Point2, Point3, Transform, Vec2, Vec3};
use crate::math;
use crate::scalar::Scalar;

/// Samples per turn when seeding the closest-point search (see [`Helix3::project`]).
const PROJECT_SAMPLES_PER_TURN: usize = 16;
/// Newton iterations of the closest-point search.
const PROJECT_NEWTON_STEPS: usize = 40;

fn check_finite(what: &'static str, v: f64) -> Result<f64, GeomError> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(GeomError::NonFinite { what })
    }
}

/// The open parameter interval on which `r + a·t > 0`.
fn positive_radius_domain(r: f64, a: f64) -> (f64, f64) {
    if a > 0.0 {
        (-r / a, f64::INFINITY)
    } else if a < 0.0 {
        (f64::NEG_INFINITY, -r / a)
    } else {
        (f64::NEG_INFINITY, f64::INFINITY)
    }
}

/// Minimize a smooth `d(t)` (with `d'` and `d''` given by `f`) over `[lo, hi]` by
/// sampling and safeguarded Newton on `d'`. Returns `(t, d(t))`. Deterministic: fixed
/// sample grid, fixed iteration count, ties to the smaller `t`.
fn minimize_1d(
    f: &impl Fn(f64) -> (f64, f64, f64),
    lo: f64,
    hi: f64,
    samples: usize,
) -> (f64, f64) {
    let n = samples.max(2);
    let mut best = (lo, f(lo).0);
    let mut best_k = 0usize;
    let ts: Vec<f64> = (0..=n)
        .map(|k| {
            if k == n {
                hi
            } else {
                lo + (hi - lo) * (k as f64 / n as f64)
            }
        })
        .collect();
    for (k, &t) in ts.iter().enumerate() {
        let d = f(t).0;
        if d < best.1 {
            best = (t, d);
            best_k = k;
        }
    }
    // Bracket around the best sample.
    let mut a = ts[best_k.saturating_sub(1)];
    let mut b = ts[(best_k + 1).min(n)];
    let mut t = best.0;
    for _ in 0..PROJECT_NEWTON_STEPS {
        let (_, g, h) = f(t);
        if g == 0.0 {
            break;
        }
        // Keep the bracket on the side where the derivative changes sign.
        if g > 0.0 {
            b = t;
        } else {
            a = t;
        }
        let mut next = if h > 0.0 { t - g / h } else { f64::NAN };
        if !(next > a && next < b) {
            next = 0.5 * (a + b);
        }
        if next.to_bits() == t.to_bits() {
            break;
        }
        t = next;
    }
    let d = f(t).0;
    if d < best.1 { (t, d) } else { best }
}

// ---------------------------------------------------------------------------------------

/// A helix whose radius may vary linearly with the angle:
/// `C(t) = o + (r + a·t)·(cos t·x + sin t·y) + p·t·z` in `frame`.
///
/// - `radius` `r`: the radius at `t = 0` (any finite value; the curve is used where the
///   radius is positive, see [`Helix3::domain`]);
/// - `radius_rate` `a = dρ/dt` (mm per radian);
/// - `rise` `p = dz/dt` (mm per radian; the lead is `2π·p`). `p > 0` in a right-handed
///   frame is a **right-hand** helix.
///
/// At least one of `a` and `p` is non-zero (otherwise the curve is a circle: use
/// [`super::Circle3`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Helix3 {
    frame: Frame,
    radius: f64,
    radius_rate: f64,
    rise: f64,
}

impl Helix3 {
    /// A helix or spiral (see the type docs). Errors: non-finite data, `a = p = 0`
    /// (a circle), `a = 0` with `r <= 0` (empty domain).
    pub fn new(frame: Frame, radius: f64, radius_rate: f64, rise: f64) -> Result<Self, GeomError> {
        let radius = check_finite("helix radius", radius)?;
        let radius_rate = check_finite("helix radius rate", radius_rate)?;
        let rise = check_finite("helix rise", rise)?;
        if radius_rate == 0.0 && rise == 0.0 {
            return Err(GeomError::InvalidParameter {
                what: "helix radius rate and rise",
                value: 0.0,
                expected: "not both zero (a circle is a Circle3)",
            });
        }
        if radius_rate == 0.0 && radius <= 0.0 {
            return Err(GeomError::InvalidParameter {
                what: "helix radius",
                value: radius,
                expected: "> 0 when the radius rate is 0",
            });
        }
        Ok(Self {
            frame,
            radius,
            radius_rate,
            rise,
        })
    }
    /// Frame (axis = `z`, `t = 0` towards `x`).
    pub fn frame(&self) -> &Frame {
        &self.frame
    }
    /// Radius at `t = 0`.
    pub fn radius(&self) -> f64 {
        self.radius
    }
    /// `dρ/dt`.
    pub fn radius_rate(&self) -> f64 {
        self.radius_rate
    }
    /// `dz/dt` (mm per radian).
    pub fn rise(&self) -> f64 {
        self.rise
    }
    /// Radius at `t`.
    pub fn radius_at(&self, t: f64) -> f64 {
        self.radius + self.radius_rate * t
    }
    /// The open interval where the radius is positive.
    pub fn domain(&self) -> (f64, f64) {
        positive_radius_domain(self.radius, self.radius_rate)
    }
    /// `[C(t), C'(t), C''(t)]`.
    pub fn derivs2<S: Scalar>(&self, t: S) -> [Vec3<S>; 3] {
        let (s, c) = t.sin_cos();
        let a = S::from_f64(self.radius_rate);
        let p = S::from_f64(self.rise);
        let rho = S::from_f64(self.radius) + a * t;
        let z = S::zero();
        let er = Vec3::new(c, s, z);
        let eu = Vec3::new(-s, c, z);
        let ez = Vec3::new(z, z, S::one());
        [
            self.frame.eval_point(er * rho + ez * (p * t)),
            self.frame.eval_vector(er * a + eu * rho + ez * p),
            self.frame.eval_vector(eu * (a + a) - er * rho),
        ]
    }
    /// Point at `t`.
    pub fn eval<S: Scalar>(&self, t: S) -> Vec3<S> {
        let (s, c) = t.sin_cos();
        let rho = S::from_f64(self.radius) + S::from_f64(self.radius_rate) * t;
        self.frame
            .eval_point(Vec3::new(rho * c, rho * s, S::from_f64(self.rise) * t))
    }
    /// Closest point `(t, distance)` over the curve's domain.
    ///
    /// `|C(t) − P|² ≥ (ρ(t) − ρ_P)² + (p·t − z_P)²` (a convex quadratic in `t`), so only the
    /// turns where that bound is below the best distance found can hold the minimum. Turns
    /// are searched outwards from the bound's minimum; in each, the distance is sampled
    /// ([`PROJECT_SAMPLES_PER_TURN`]) and polished by safeguarded Newton. Deterministic.
    pub fn project(&self, p: Point3) -> (f64, f64) {
        let l = self.frame.to_local_point(p);
        let (a, pr, r) = (self.radius_rate, self.rise, self.radius);
        let rho_p = math::hypot(l.x, l.y);
        let phi = if rho_p > 0.0 {
            math::atan2(l.y, l.x)
        } else {
            0.0
        };
        let (dlo, dhi) = self.domain();
        // Keep a margin off an open domain end, where the radius vanishes.
        let dlo = if dlo.is_finite() {
            dlo + 1e-12 * (1.0 + dlo.abs())
        } else {
            dlo
        };
        let dhi = if dhi.is_finite() {
            dhi - 1e-12 * (1.0 + dhi.abs())
        } else {
            dhi
        };
        let dist2 = |t: f64| -> (f64, f64, f64) {
            let [c, d1, d2] = self.derivs2(t);
            let e = c - p;
            (e.norm_squared(), e.dot(d1), d1.norm_squared() + e.dot(d2))
        };
        // Lower bound q(t) = (a t + r − ρ_P)² + (p t − z_P)², minimized at t*.
        let den = a * a + pr * pr;
        let t_star = (a * (rho_p - r) + pr * l.z) / den;
        let q_min_on = |lo: f64, hi: f64| -> f64 {
            let t = t_star.clamp(lo, hi);
            let x = a * t + r - rho_p;
            let y = pr * t - l.z;
            x * x + y * y
        };
        let tau = math::TAU;
        let m0 = ((t_star - phi) / tau).round();
        let mut best = (f64::NAN, f64::INFINITY);
        // Search turn m (interval [φ + 2π(m − ½), φ + 2π(m + ½)]) if it can improve.
        let visit = |m: f64, best: &mut (f64, f64)| -> bool {
            let lo = (phi + tau * (m - 0.5)).max(dlo);
            let hi = (phi + tau * (m + 0.5)).min(dhi);
            if lo.partial_cmp(&hi) != Some(std::cmp::Ordering::Less) {
                return false;
            }
            if q_min_on(lo, hi) > best.1 {
                return false;
            }
            let (t, d) = minimize_1d(&dist2, lo, hi, PROJECT_SAMPLES_PER_TURN);
            if d < best.1 {
                *best = (t, d);
            }
            true
        };
        visit(m0, &mut best);
        // Outwards in both directions while the bound allows an improvement. The bound is
        // convex, so once a turn is excluded every farther turn is too.
        for dir in [-1.0f64, 1.0] {
            let mut k = 1.0;
            loop {
                let m = m0 + dir * k;
                let lo = phi + tau * (m - 0.5);
                let hi = phi + tau * (m + 0.5);
                if hi <= dlo || lo >= dhi {
                    break;
                }
                if !visit(m, &mut best) && q_min_on(lo.max(dlo), hi.min(dhi)) > best.1 {
                    break;
                }
                k += 1.0;
                if k > 1e6 {
                    break;
                }
            }
        }
        if !best.0.is_finite() {
            // Only possible for a point whose search window missed the domain entirely.
            let t = t_star.clamp(dlo.max(-1e300), dhi.min(1e300));
            return (t, self.eval(t).distance(p));
        }
        (best.0, best.1.max(0.0).sqrt())
    }
    /// Length between `t0` and `t1` (order-insensitive): exact for circular helices
    /// (`a = 0`), composite 16-point Gauss–Legendre on pieces of at most π/8 otherwise.
    pub fn arc_length(&self, t0: f64, t1: f64) -> f64 {
        let span = (t1 - t0).abs();
        if self.radius_rate == 0.0 {
            return math::hypot(self.radius, self.rise) * span;
        }
        let (lo, hi) = if t0 <= t1 { (t0, t1) } else { (t1, t0) };
        let pieces = ((span / (math::PI / 8.0)).ceil() as usize).max(1);
        quadrature::integrate(|t| self.derivs2(t)[1].norm(), lo, hi, pieces)
    }
    /// The curve moved by a rigid transform.
    pub fn transformed(&self, t: &Transform) -> Self {
        Self {
            frame: self.frame.transformed(t),
            ..*self
        }
    }
}

// ---------------------------------------------------------------------------------------

/// A 2D Archimedean spiral: `C(t) = c + (r + a·t)·(cos t·X + σ·sin t·Y)`, `X` a unit
/// direction, `Y = perp(X)` (`X` turned by +90°), `σ = +1` (counter-clockwise) or `−1`.
///
/// The pcurve of a planar [`Helix3`] (rise 0) on a plane face: projecting the 3D spiral into
/// a plane's `(u, v)` frame gives this form, `σ = −1` when the plane's normal is opposite to
/// the helix axis. `a ≠ 0` (a circle is a [`super::Circle2`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spiral2 {
    center: Point2,
    x_dir: Vec2,
    ccw: bool,
    radius: f64,
    radius_rate: f64,
}

impl Spiral2 {
    /// A spiral; `x_dir` is normalized; `radius_rate ≠ 0`.
    pub fn new(
        center: Point2,
        x_dir: Vec2,
        ccw: bool,
        radius: f64,
        radius_rate: f64,
    ) -> Result<Self, GeomError> {
        if !center.is_finite() {
            return Err(GeomError::NonFinite {
                what: "spiral center",
            });
        }
        let x_dir = x_dir.normalize().ok_or(GeomError::DegenerateDirection {
            what: "spiral x_dir",
        })?;
        let radius = check_finite("spiral radius", radius)?;
        let radius_rate = check_finite("spiral radius rate", radius_rate)?;
        if radius_rate == 0.0 {
            return Err(GeomError::InvalidParameter {
                what: "spiral radius rate",
                value: 0.0,
                expected: "≠ 0 (a circle is a Circle2)",
            });
        }
        Ok(Self {
            center,
            x_dir,
            ccw,
            radius,
            radius_rate,
        })
    }
    /// The pcurve of the planar spiral `helix` (rise 0) in the `(u, v)` space of the plane
    /// with frame `plane` (the helix axis must be parallel to the plane normal).
    pub fn from_planar_helix(helix: &Helix3, plane: &Frame) -> Result<Self, GeomError> {
        let hf = helix.frame();
        let o = plane.to_local_point(hf.origin());
        let x = plane.to_local_vector(hf.x());
        let y = plane.to_local_vector(hf.y());
        let x2 = Vec2::new(x.x, x.y);
        let ccw = x2.perp().dot(Vec2::new(y.x, y.y)) > 0.0;
        Self::new(
            Vec2::new(o.x, o.y),
            x2,
            ccw,
            helix.radius(),
            helix.radius_rate(),
        )
    }
    /// Centre.
    pub fn center(&self) -> Point2 {
        self.center
    }
    /// Unit direction of `t = 0`.
    pub fn x_dir(&self) -> Vec2 {
        self.x_dir
    }
    /// `true` if `t` turns counter-clockwise.
    pub fn is_ccw(&self) -> bool {
        self.ccw
    }
    /// Radius at `t = 0`.
    pub fn radius(&self) -> f64 {
        self.radius
    }
    /// `dρ/dt`.
    pub fn radius_rate(&self) -> f64 {
        self.radius_rate
    }
    /// The open interval where the radius is positive.
    pub fn domain(&self) -> (f64, f64) {
        positive_radius_domain(self.radius, self.radius_rate)
    }
    fn axes<S: Scalar>(&self) -> (Vec2<S>, Vec2<S>) {
        let x = self.x_dir.lift::<S>();
        let y = if self.ccw {
            self.x_dir.perp().lift::<S>()
        } else {
            -self.x_dir.perp().lift::<S>()
        };
        (x, y)
    }
    /// `[C(t), C'(t), C''(t)]`.
    pub fn derivs2<S: Scalar>(&self, t: S) -> [Vec2<S>; 3] {
        let (s, c) = t.sin_cos();
        let (x, y) = self.axes::<S>();
        let a = S::from_f64(self.radius_rate);
        let rho = S::from_f64(self.radius) + a * t;
        let er = x * c + y * s;
        let eu = y * c - x * s;
        [
            self.center.lift::<S>() + er * rho,
            er * a + eu * rho,
            eu * (a + a) - er * rho,
        ]
    }
    /// Point at `t`.
    pub fn eval<S: Scalar>(&self, t: S) -> Vec2<S> {
        self.derivs2(t)[0]
    }
    /// Closest point `(t, distance)` over the domain (the method of [`Helix3::project`]).
    pub fn project(&self, p: Point2) -> (f64, f64) {
        // A planar spiral is a Helix3 with rise 0 in a (possibly mirrored) frame: map the
        // point into the spiral's own coordinates and reuse the 3D search.
        let (x, y) = self.axes::<f64>();
        let d = p - self.center;
        let l = Vec3::new(d.dot(x), d.dot(y), 0.0);
        let helix = Helix3 {
            frame: Frame::world(),
            radius: self.radius,
            radius_rate: self.radius_rate,
            rise: 0.0,
        };
        helix.project(l)
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
    fn helix_derivatives_match_finite_differences() {
        for h in [
            Helix3::new(tilted(), 3.0, 0.0, 0.2).unwrap(),
            Helix3::new(tilted(), 3.0, -0.35, 0.0).unwrap(),
            Helix3::new(tilted(), 2.0, 0.1, -0.3).unwrap(),
        ] {
            for &t in &[-2.0, -0.3, 0.0, 0.7, 4.0] {
                let e = 1e-6;
                let [_, d1, d2] = h.derivs2(t);
                let fd1 = (h.eval(t + e) - h.eval(t - e)) * (0.5 / e);
                let fd2 = (h.derivs2(t + e)[1] - h.derivs2(t - e)[1]) * (0.5 / e);
                assert!(d1.distance(fd1) < 1e-8, "{h:?} {t}");
                assert!(d2.distance(fd2) < 1e-8, "{h:?} {t}");
            }
        }
    }

    #[test]
    fn right_hand_helix_advances_along_z_counter_clockwise() {
        let h = Helix3::new(Frame::world(), 2.0, 0.0, 1.0).unwrap();
        let p = h.eval(math::FRAC_PI_2);
        assert!(p.distance(Vec3::new(0.0, 2.0, math::FRAC_PI_2)) < 1e-15);
    }

    #[test]
    fn helix_projection_finds_points_on_the_curve_across_turns() {
        let h = Helix3::new(tilted(), 3.0, 0.0, 0.2).unwrap();
        for &t in &[-30.0, -1.0, 0.0, 2.5, 17.0, 60.0] {
            let p = h.eval(t);
            let (tp, d) = h.project(p);
            assert!(d < 1e-12, "{t}: {d}");
            assert!((tp - t).abs() < 1e-9, "{t} vs {tp}");
            // Off the curve along the principal normal: the distance is the offset.
            let [_, d1, d2] = h.derivs2(t);
            let n = (d2 - d1 * (d2.dot(d1) / d1.norm_squared()))
                .normalize()
                .unwrap();
            let q = p - n * 0.05;
            let (tq, dq) = h.project(q);
            assert!((dq - 0.05).abs() < 1e-9, "{t}: {dq}");
            assert!((tq - t).abs() < 1e-6, "{t} vs {tq}");
        }
    }

    #[test]
    fn helix_projection_of_an_axis_point() {
        // On the axis every turn is at the radius; the nearest point is at the same height.
        let h = Helix3::new(Frame::world(), 1.0, 0.0, 0.5).unwrap();
        let (t, d) = h.project(Vec3::new(0.0, 0.0, 3.0));
        assert!((t - 6.0).abs() < 1e-9, "{t}");
        assert!((d - 1.0).abs() < 1e-12);
    }

    #[test]
    fn spiral_projection_and_domain() {
        let h = Helix3::new(tilted(), 10.0, -0.5, 0.0).unwrap();
        assert_eq!(h.domain(), (f64::NEG_INFINITY, 20.0));
        for &t in &[-8.0, 0.0, 3.0, 12.0] {
            let p = h.eval(t);
            let (tp, d) = h.project(p);
            assert!(d < 1e-12 && (tp - t).abs() < 1e-9, "{t}: {tp} {d}");
        }
    }

    #[test]
    fn helix_arc_length() {
        let h = Helix3::new(tilted(), 3.0, 0.0, 0.2).unwrap();
        let l = h.arc_length(0.0, 10.0);
        assert!((l - 10.0 * math::hypot(3.0, 0.2)).abs() < 1e-12);
        let s = Helix3::new(tilted(), 3.0, 0.1, 0.2).unwrap();
        // Fine polyline as the reference.
        let n = 20000;
        let mut acc = 0.0;
        for i in 0..n {
            let a = 10.0 * i as f64 / n as f64;
            let b = 10.0 * (i + 1) as f64 / n as f64;
            acc += s.eval(a).distance(s.eval(b));
        }
        assert!((s.arc_length(0.0, 10.0) - acc).abs() < 1e-6);
    }

    #[test]
    fn rejects_circles_and_empty_domains() {
        assert!(Helix3::new(Frame::world(), 1.0, 0.0, 0.0).is_err());
        assert!(Helix3::new(Frame::world(), -1.0, 0.0, 0.3).is_err());
        assert!(Spiral2::new(Vec2::zero(), Vec2::unit_x(), true, 1.0, 0.0).is_err());
    }

    #[test]
    fn planar_helix_pcurve_matches_in_a_mirrored_plane() {
        let f = tilted().with_origin(Vec3::new(0.5, -1.0, 2.0));
        let h = Helix3::new(f, 4.0, -0.3, 0.0).unwrap();
        // A plane through the spiral with the opposite normal and another x axis.
        let plane =
            Frame::from_normal_x(f.origin() + f.x() * 0.7, -f.z(), f.y() + f.x() * 0.4).unwrap();
        let s = Spiral2::from_planar_helix(&h, &plane).unwrap();
        assert!(!s.is_ccw());
        for &t in &[-1.0, 0.0, 2.0, 7.5] {
            let p3 = plane.to_local_point(h.eval(t));
            assert!(p3.z.abs() < 1e-12);
            let q = s.eval(t);
            assert!(Vec2::new(p3.x, p3.y).distance(q) < 1e-12, "{t}");
            let (tp, d) = s.project(q);
            assert!(d < 1e-12 && (tp - t).abs() < 1e-9);
        }
    }
}
