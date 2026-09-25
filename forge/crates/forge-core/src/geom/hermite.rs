//! Certified B-spline approximations of the transcendental thread geometry (helices,
//! spirals, helicoids) for exchange formats that have no such entity (STEP).
//!
//! Quintic Hermite interpolation of a smooth `f` on `[a, b]` (value, first and second
//! derivative matched at both ends) has the error bound
//! `|f(t) − H(t)| ≤ max|f⁽⁶⁾| · (t − a)³(b − t)³ / 6! ≤ max|f⁽⁶⁾| · h⁶ / 46080`, `h = b − a`.
//! The pieces are written as quintic Bézier segments of one clamped B-spline (interior
//! knots of multiplicity 5; the curve is C² since the derivatives match). A polynomial of
//! degree ≤ 5 — the linear advance along a helix's axis — is reproduced exactly.

use super::error::NurbsError;
use super::nurbs::NurbsCurve;
use crate::math;

/// Largest piece of a quintic Hermite approximation (radians of the angle parameter),
/// whatever the error bound allows: keeps the pieces short enough to follow the curve.
pub const MAX_HERMITE_PIECE: f64 = math::PI / 8.0;

/// Break points over `[t0, t1]` for an error of at most `eps` when `|f⁽⁶⁾| ≤ m6`.
pub(crate) fn hermite_breaks(t0: f64, t1: f64, m6: f64, eps: f64) -> Vec<f64> {
    let h_err = if m6 > 0.0 {
        math::powf(46080.0 * eps / m6, 1.0 / 6.0)
    } else {
        f64::INFINITY
    };
    let h = h_err.min(MAX_HERMITE_PIECE);
    let n = (((t1 - t0) / h).ceil() as usize).max(1);
    (0..=n)
        .map(|k| {
            if k == n {
                t1
            } else {
                t0 + (t1 - t0) * (k as f64 / n as f64)
            }
        })
        .collect()
}

/// The clamped degree-5 B-spline through Hermite data `f(t) = (value, first, second
/// derivative)` at `breaks` (at least two, increasing).
pub(crate) fn quintic_hermite<const D: usize>(
    breaks: &[f64],
    f: impl Fn(f64) -> [[f64; D]; 3],
) -> Result<NurbsCurve<D>, NurbsError> {
    let n = breaks.len() - 1;
    let mut knots = Vec::with_capacity(5 * n + 7);
    knots.extend(std::iter::repeat_n(breaks[0], 6));
    for &b in &breaks[1..n] {
        knots.extend(std::iter::repeat_n(b, 5));
    }
    knots.extend(std::iter::repeat_n(breaks[n], 6));
    let mut ctrl: Vec<[f64; D]> = Vec::with_capacity(5 * n + 1);
    let comb = |a: [f64; D], s: f64, b: [f64; D], t: f64, c: [f64; D]| -> [f64; D] {
        core::array::from_fn(|i| a[i] + s * b[i] + t * c[i])
    };
    for k in 0..n {
        let (a, b) = (breaks[k], breaks[k + 1]);
        let h = b - a;
        let [p0, d0, s0] = f(a);
        let [p5, d5, s5] = f(b);
        if k == 0 {
            ctrl.push(p0);
        }
        ctrl.push(comb(p0, h / 5.0, d0, 0.0, s0));
        ctrl.push(comb(p0, 2.0 * h / 5.0, d0, h * h / 20.0, s0));
        ctrl.push(comb(p5, -2.0 * h / 5.0, d5, h * h / 20.0, s5));
        ctrl.push(comb(p5, -h / 5.0, d5, 0.0, s5));
        ctrl.push(p5);
    }
    NurbsCurve::new(5, knots, ctrl, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_circle_is_approximated_within_its_bound() {
        let eps = 1e-9;
        let br = hermite_breaks(0.3, 7.0, 1.0, eps);
        let c = quintic_hermite::<2>(&br, |t| {
            let (s, co) = math::sin_cos(t);
            [[co, s], [-s, co], [-co, -s]]
        })
        .unwrap();
        let mut worst: f64 = 0.0;
        for k in 0..=20_000 {
            let t = 0.3 + 6.7 * k as f64 / 20_000.0;
            let p = c.eval_array(t);
            let (s, co) = math::sin_cos(t);
            worst = worst.max(math::hypot(p[0] - co, p[1] - s));
        }
        assert!(worst <= eps, "{worst}");
    }
}
