//! Gauss–Legendre quadrature (deterministic nodes computed at first use).

use std::sync::OnceLock;

use crate::math;

/// Number of nodes of the default rule (exact for polynomials of degree ≤ 31).
pub const DEFAULT_ORDER: usize = 16;

/// Nodes and weights of the `n`-point Gauss–Legendre rule on `[-1, 1]`, in increasing
/// node order.
///
/// Nodes are the roots of the Legendre polynomial `P_n`, found by Newton's method from
/// the classical Chebyshev-like initial guesses; only IEEE arithmetic and
/// [`math::cos`] are used, so the table is bit-identical on every target.
pub fn gauss_legendre(n: usize) -> Vec<(f64, f64)> {
    assert!(n >= 1, "Gauss–Legendre rule needs n >= 1");
    let nf = n as f64;
    let mut out = vec![(0.0, 0.0); n];
    for i in 0..n.div_ceil(2) {
        let mut x = math::cos(math::PI * (i as f64 + 0.75) / (nf + 0.5));
        let mut dp = 1.0;
        for _ in 0..100 {
            // Legendre recurrence: P_{k} = ((2k−1) x P_{k−1} − (k−1) P_{k−2}) / k
            let (mut p0, mut p1) = (1.0, x);
            for k in 2..=n {
                let kf = k as f64;
                let p2 = ((2.0 * kf - 1.0) * x * p1 - (kf - 1.0) * p0) / kf;
                p0 = p1;
                p1 = p2;
            }
            let pn = if n == 1 { x } else { p1 };
            let pn1 = if n == 1 { 1.0 } else { p0 };
            dp = nf * (x * pn - pn1) / (x * x - 1.0);
            let dx = pn / dp;
            x -= dx;
            if dx.abs() <= 1e-16 {
                break;
            }
        }
        let w = 2.0 / ((1.0 - x * x) * dp * dp);
        out[i] = (-x, w);
        out[n - 1 - i] = (x, w);
    }
    if n % 2 == 1 {
        out[n / 2].0 = 0.0;
    }
    out
}

fn default_rule() -> &'static [(f64, f64)] {
    static RULE: OnceLock<Vec<(f64, f64)>> = OnceLock::new();
    RULE.get_or_init(|| gauss_legendre(DEFAULT_ORDER))
}

/// Integrate `f` over `[a, b]` with the default rule on `pieces` equal sub-intervals.
pub fn integrate(f: impl Fn(f64) -> f64, a: f64, b: f64, pieces: usize) -> f64 {
    let rule = default_rule();
    let pieces = pieces.max(1);
    let h = (b - a) / pieces as f64;
    let mut total = 0.0;
    for k in 0..pieces {
        let lo = a + h * k as f64;
        let hi = if k + 1 == pieces { b } else { lo + h };
        let (mid, half) = (0.5 * (lo + hi), 0.5 * (hi - lo));
        let mut s = 0.0;
        for &(x, w) in rule {
            s += w * f(mid + half * x);
        }
        total += s * half;
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_sum_to_two_and_rule_is_exact_for_polynomials() {
        for n in [1, 2, 3, 5, 16] {
            let r = gauss_legendre(n);
            let sum: f64 = r.iter().map(|&(_, w)| w).sum();
            assert!((sum - 2.0).abs() < 1e-14, "n = {n}: {sum}");
            // ∫_{-1}^{1} x^(2n−2) dx = 2/(2n−1)
            let k = 2 * n as i32 - 2;
            let q: f64 = r.iter().map(|&(x, w)| w * math::powi(x, k)).sum();
            assert!((q - 2.0 / (2.0 * n as f64 - 1.0)).abs() < 1e-13, "n = {n}");
        }
    }

    #[test]
    fn integrates_smooth_functions() {
        let v = integrate(math::sin, 0.0, math::PI, 2);
        assert!((v - 2.0).abs() < 1e-14);
    }
}
