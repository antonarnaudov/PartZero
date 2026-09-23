//! Closed-form candidate roots of low-degree polynomials and trigonometric polynomials.
//!
//! These produce **candidates** quickly; callers certify every candidate with interval
//! Newton on the geometric distance function and certify the complement root-free (see
//! [`crate::roots1d`]), so rounding in the closed forms can never lose or invent a root.
//!
//! - Degree ≤ 2: the numerically stable quadratic formula (no cancellation).
//! - Degree 3–8: real roots on a bounded interval by recursive derivative isolation:
//!   the roots of `p'` split the interval into monotone pieces, each holding at most one
//!   root, found by safeguarded Newton–bisection. No deflation, no companion matrix;
//!   near-double roots appear as critical points with tiny `|p|`.
//! - Trigonometric polynomials `Σ aₖ cos kt + bₖ sin kt` (a line or conic composed with a
//!   quadric or torus) via the half-angle substitution `τ = tan((t − c)/2)` on two charts
//!   (`c = 0` and `c = π`, `τ ∈ [−1, 1]` each), which keeps every polynomial on a bounded
//!   interval.

use forge_core::math;

/// Evaluate `Σ c[i]·x^i` (Horner).
pub(crate) fn eval(c: &[f64], x: f64) -> f64 {
    c.iter().rev().fold(0.0, |acc, &ci| acc * x + ci)
}

/// A bound on the rounding error scale of [`eval`] at `x`: `Σ |c[i]|·|x|^i`.
fn eval_scale(c: &[f64], x: f64) -> f64 {
    let ax = x.abs();
    c.iter().rev().fold(0.0, |acc, &ci| acc * ax + ci.abs())
}

fn derivative(c: &[f64]) -> Vec<f64> {
    c.iter()
        .enumerate()
        .skip(1)
        .map(|(i, &ci)| ci * i as f64)
        .collect()
}

/// Drop negligible leading coefficients (relative to the largest).
fn trim(c: &[f64]) -> &[f64] {
    let big = c.iter().fold(0.0f64, |m, x| m.max(x.abs()));
    let mut n = c.len();
    while n > 0 && c[n - 1].abs() <= 1e-14 * big {
        n -= 1;
    }
    &c[..n]
}

/// Candidate real roots of `Σ c[i]·x^i` in `[lo, hi]`, sorted, including critical points
/// where `|p|` is at rounding level (double-root candidates).
pub(crate) fn real_roots(c: &[f64], lo: f64, hi: f64) -> Vec<f64> {
    let c = trim(c);
    let mut out = match c.len() {
        0 | 1 => Vec::new(),
        2 => vec![-c[0] / c[1]],
        3 => quadratic(c[2], c[1], c[0]),
        _ => {
            let crit = real_roots(&derivative(c), lo, hi);
            let mut pts = Vec::with_capacity(crit.len() + 2);
            pts.push(lo);
            pts.extend(crit.iter().copied().filter(|&x| x > lo && x < hi));
            pts.push(hi);
            let mut r = Vec::new();
            for w in pts.windows(2) {
                let (a, b) = (w[0], w[1]);
                let (fa, fb) = (eval(c, a), eval(c, b));
                if fa == 0.0 {
                    r.push(a);
                } else if fa * fb < 0.0 {
                    r.push(bisect(c, a, b, fa));
                }
            }
            if eval(c, hi) == 0.0 {
                r.push(hi);
            }
            // Double-root candidates: critical points with |p| at rounding level.
            for &x in &crit {
                if eval(c, x).abs() <= 64.0 * f64::EPSILON * eval_scale(c, x) {
                    r.push(x);
                }
            }
            r
        }
    };
    out.retain(|x| x.is_finite() && *x >= lo && *x <= hi);
    out.sort_by(f64::total_cmp);
    out.dedup();
    out
}

/// Real roots of `a x² + b x + c` (stable formula); a double-root candidate when the
/// discriminant is at rounding level.
pub(crate) fn quadratic(a: f64, b: f64, c: f64) -> Vec<f64> {
    if a == 0.0 {
        return if b != 0.0 { vec![-c / b] } else { Vec::new() };
    }
    let disc = b * b - 4.0 * a * c;
    let scale = (b * b).max((4.0 * a * c).abs());
    if disc < 0.0 {
        if -disc <= 64.0 * f64::EPSILON * scale {
            return vec![-b / (2.0 * a)];
        }
        return Vec::new();
    }
    let s = disc.sqrt();
    let q = -0.5 * (b + if b >= 0.0 { s } else { -s });
    let mut r = Vec::with_capacity(2);
    if q != 0.0 {
        r.push(q / a);
        r.push(c / q);
    } else {
        r.push(0.0);
    }
    r.sort_by(f64::total_cmp);
    r
}

fn bisect(c: &[f64], mut a: f64, mut b: f64, fa: f64) -> f64 {
    let sa = fa > 0.0;
    let dc = derivative(c);
    let mut x = 0.5 * a + 0.5 * b;
    for _ in 0..200 {
        let fx = eval(c, x);
        if fx == 0.0 {
            return x;
        }
        if (fx > 0.0) == sa {
            a = x;
        } else {
            b = x;
        }
        let d = eval(&dc, x);
        let n = x - fx / d;
        let next = if d != 0.0 && n > a && n < b {
            n
        } else {
            0.5 * a + 0.5 * b
        };
        if crate::clip::same(next, x)
            || b - a <= 2.0 * f64::EPSILON * x.abs().max(f64::MIN_POSITIVE)
        {
            return next;
        }
        x = next;
    }
    x
}

/// Chebyshev nodes on `[−1, 1]`.
pub(crate) fn cheb_nodes(n: usize) -> Vec<f64> {
    (0..n)
        .map(|k| math::cos(math::PI * (2 * k + 1) as f64 / (2 * n) as f64))
        .collect()
}

/// Monomial coefficients of the interpolating polynomial through `(x[i], y[i])`
/// (Newton divided differences, then expansion).
pub(crate) fn interpolate(x: &[f64], y: &[f64]) -> Vec<f64> {
    let n = x.len();
    let mut dd = y.to_vec();
    for j in 1..n {
        for i in (j..n).rev() {
            dd[i] = (dd[i] - dd[i - 1]) / (x[i] - x[i - j]);
        }
    }
    // Expand Newton form: p = dd[n-1]; p = p·(t − x[i]) + dd[i] for i = n-2..0.
    let mut c = vec![0.0; n];
    c[0] = dd[n - 1];
    for (deg, i) in (0..n - 1).rev().enumerate() {
        // c ← c·(t − x[i]) + dd[i]  (c currently has degree `deg`)
        let mut next = vec![0.0; n];
        for k in 0..=deg {
            next[k + 1] += c[k];
            next[k] -= c[k] * x[i];
        }
        next[0] += dd[i];
        c = next;
    }
    c
}

/// Candidate roots of a function known to be a polynomial of degree `<= deg` on
/// `[lo, hi]` (e.g. an algebraic surface form along a line), from `deg + 1` Chebyshev
/// samples.
pub(crate) fn poly_fn_roots(f: impl Fn(f64) -> f64, deg: usize, lo: f64, hi: f64) -> Vec<f64> {
    let nodes = cheb_nodes(deg + 1);
    let (c, h) = (0.5 * lo + 0.5 * hi, 0.5 * (hi - lo));
    let ys: Vec<f64> = nodes.iter().map(|&s| f(c + h * s)).collect();
    let coef = interpolate(&nodes, &ys);
    real_roots(&coef, -1.0, 1.0)
        .into_iter()
        .map(|s| c + h * s)
        .collect()
}

/// Candidate roots in `[0, 2π)` of a function known to be a trigonometric polynomial of
/// degree `<= deg` in `t` (e.g. an algebraic surface form along a circle or ellipse).
pub(crate) fn trig_fn_roots(f: impl Fn(f64) -> f64, deg: usize) -> Vec<f64> {
    let n = 2 * deg + 1;
    let nodes = cheb_nodes(n);
    let mut out = Vec::new();
    for centre in [0.0, math::PI] {
        let ys: Vec<f64> = nodes
            .iter()
            .map(|&tau| {
                let t = centre + 2.0 * math::atan(tau);
                let w = 1.0 + tau * tau;
                f(t) * math::powi(w, deg as i32)
            })
            .collect();
        let coef = interpolate(&nodes, &ys);
        for tau in real_roots(&coef, -1.0, 1.0) {
            out.push(math::wrap_angle(centre + 2.0 * math::atan(tau), 0.0));
        }
    }
    out.sort_by(f64::total_cmp);
    out.dedup_by(|b, a| (*b - *a).abs() <= 1e-15);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quadratic_is_cancellation_free() {
        let r = quadratic(1.0, -1e8, 1.0);
        assert_eq!(r.len(), 2);
        assert!((r[0] - 1e-8).abs() < 1e-22);
        assert!((r[1] - 1e8).abs() < 1e-6);
        assert_eq!(quadratic(1.0, -2.0, 1.0), vec![1.0, 1.0]);
        assert!(quadratic(1.0, 0.0, 1.0).is_empty());
    }

    #[test]
    fn quartic_real_roots_on_interval() {
        // (x − 1)(x + 0.5)(x − 2.5)(x + 3) = x⁴ − 5.75x² ... expanded numerically
        let roots = [1.0, -0.5, 2.5, -3.0];
        let mut c = vec![1.0];
        for r in roots {
            let mut n = vec![0.0; c.len() + 1];
            for (i, &ci) in c.iter().enumerate() {
                n[i + 1] += ci;
                n[i] -= ci * r;
            }
            c = n;
        }
        let found = real_roots(&c, -4.0, 4.0);
        let mut expect = roots.to_vec();
        expect.sort_by(f64::total_cmp);
        assert_eq!(found.len(), 4, "{found:?}");
        for (a, b) in found.iter().zip(expect) {
            assert!((a - b).abs() < 1e-12);
        }
        // Restricted interval.
        assert_eq!(real_roots(&c, 0.0, 2.0).len(), 1);
    }

    #[test]
    fn double_root_candidate_is_reported() {
        // (x − 1)²(x + 2)(x − 3)
        let roots = [1.0, 1.0, -2.0, 3.0];
        let mut c = vec![1.0];
        for r in roots {
            let mut n = vec![0.0; c.len() + 1];
            for (i, &ci) in c.iter().enumerate() {
                n[i + 1] += ci;
                n[i] -= ci * r;
            }
            c = n;
        }
        let found = real_roots(&c, -5.0, 5.0);
        assert!(found.iter().any(|x| (x - 1.0).abs() < 1e-7), "{found:?}");
    }

    #[test]
    fn interpolation_recovers_coefficients() {
        let c = [0.5, -1.0, 2.0, 0.25];
        let x = cheb_nodes(4);
        let y: Vec<f64> = x.iter().map(|&t| eval(&c, t)).collect();
        let got = interpolate(&x, &y);
        for (a, b) in got.iter().zip(c) {
            assert!((a - b).abs() < 1e-13);
        }
    }

    #[test]
    fn trig_roots_of_shifted_cosine() {
        // cos(t) − 0.3 : roots ±acos(0.3)
        let r = trig_fn_roots(|t| math::cos(t) - 0.3, 1);
        let a = math::acos(0.3);
        assert_eq!(r.len(), 2, "{r:?}");
        assert!((r[0] - a).abs() < 1e-12 && (r[1] - (math::TAU - a)).abs() < 1e-12);
        // Degree-2 trig polynomial with 4 roots: cos(2t) − 0.1
        let r = trig_fn_roots(|t| math::cos(2.0 * t) - 0.1, 2);
        assert_eq!(r.len(), 4, "{r:?}");
    }
}
