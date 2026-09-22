//! B-spline basis functions (The NURBS Book, algorithms A2.1–A2.3), generic over
//! [`Scalar`] in the parameter.

use crate::geom::error::NurbsError;
use crate::scalar::Scalar;

/// Validate a knot vector for `n_ctrl` control points of degree `p`.
pub(crate) fn validate_knots(knots: &[f64], p: usize, n_ctrl: usize) -> Result<(), NurbsError> {
    if p < 1 {
        return Err(NurbsError::InvalidDegree { degree: p });
    }
    if n_ctrl < p + 1 {
        return Err(NurbsError::TooFewControlPoints {
            min: p + 1,
            got: n_ctrl,
        });
    }
    let expected = n_ctrl + p + 1;
    if knots.len() != expected {
        return Err(NurbsError::KnotCountMismatch {
            expected,
            got: knots.len(),
        });
    }
    if knots.iter().any(|k| !k.is_finite()) {
        return Err(NurbsError::NonFinite { what: "knots" });
    }
    if let Some(i) = (1..knots.len()).find(|&i| knots[i] < knots[i - 1]) {
        return Err(NurbsError::KnotsDecreasing { index: i });
    }
    let (a, b) = (knots[p], knots[n_ctrl]);
    if a >= b {
        return Err(NurbsError::EmptyDomain);
    }
    let mut i = 0;
    while i < knots.len() {
        let v = knots[i];
        let mut j = i;
        while j < knots.len() && knots[j] <= v {
            j += 1;
        }
        let m = j - i;
        let max = if v > a && v < b { p } else { p + 1 };
        if m > max {
            return Err(NurbsError::KnotMultiplicity {
                value: v,
                multiplicity: m,
                max,
            });
        }
        i = j;
    }
    Ok(())
}

/// Multiplicity of the value `u` in the knot vector.
#[allow(clippy::float_cmp)] // Multiplicity is defined by exact knot equality.
pub(crate) fn multiplicity(knots: &[f64], u: f64) -> usize {
    knots.iter().filter(|&&k| k == u).count()
}

/// Knot span index `i` with `knots[i] <= u < knots[i+1]` (A2.1); `u` is clamped to the
/// domain and the domain end maps to the last non-empty span.
pub(crate) fn find_span(knots: &[f64], p: usize, n_ctrl: usize, u: f64) -> usize {
    let n = n_ctrl - 1;
    if u >= knots[n + 1] {
        return n;
    }
    if u <= knots[p] {
        return p;
    }
    let (mut low, mut high) = (p, n + 1);
    let mut mid = (low + high) / 2;
    while u < knots[mid] || u >= knots[mid + 1] {
        if u < knots[mid] {
            high = mid;
        } else {
            low = mid;
        }
        mid = (low + high) / 2;
    }
    mid
}

/// The `p + 1` non-zero basis functions `N_{span−p..=span, p}(u)` (A2.2).
pub(crate) fn basis_funs<S: Scalar>(knots: &[f64], span: usize, u: S, p: usize) -> Vec<S> {
    let mut n = vec![S::zero(); p + 1];
    let mut left = vec![S::zero(); p + 1];
    let mut right = vec![S::zero(); p + 1];
    n[0] = S::one();
    for j in 1..=p {
        left[j] = u - S::from_f64(knots[span + 1 - j]);
        right[j] = S::from_f64(knots[span + j]) - u;
        let mut saved = S::zero();
        for r in 0..j {
            let temp = n[r] / (right[r + 1] + left[j - r]);
            n[r] = saved + right[r + 1] * temp;
            saved = left[j - r] * temp;
        }
        n[j] = saved;
    }
    n
}

/// Basis functions and their derivatives up to order `nd` (A2.3): `ders[k][j]` is the
/// `k`-th derivative of `N_{span−p+j, p}` at `u`. Orders above `p` are zero.
pub(crate) fn ders_basis_funs<S: Scalar>(
    knots: &[f64],
    span: usize,
    u: S,
    p: usize,
    nd: usize,
) -> Vec<Vec<S>> {
    let z = S::zero();
    let mut ders = vec![vec![z; p + 1]; nd + 1];
    let mut ndu = vec![vec![z; p + 1]; p + 1];
    let mut left = vec![z; p + 1];
    let mut right = vec![z; p + 1];
    ndu[0][0] = S::one();
    for j in 1..=p {
        left[j] = u - S::from_f64(knots[span + 1 - j]);
        right[j] = S::from_f64(knots[span + j]) - u;
        let mut saved = z;
        for r in 0..j {
            // Lower triangle: knot differences.
            ndu[j][r] = right[r + 1] + left[j - r];
            let temp = ndu[r][j - 1] / ndu[j][r];
            // Upper triangle: basis functions.
            ndu[r][j] = saved + right[r + 1] * temp;
            saved = left[j - r] * temp;
        }
        ndu[j][j] = saved;
    }
    for j in 0..=p {
        ders[0][j] = ndu[j][p];
    }
    let n = nd.min(p);
    let pi = p as isize;
    let mut a = vec![vec![z; p + 1]; 2];
    for r in 0..=p {
        let ri = r as isize;
        let (mut s1, mut s2) = (0usize, 1usize);
        a[0][0] = S::one();
        for k in 1..=n {
            let ki = k as isize;
            let mut d = z;
            let rk = ri - ki;
            let pk = (pi - ki) as usize;
            if ri >= ki {
                let rk = rk as usize;
                a[s2][0] = a[s1][0] / ndu[pk + 1][rk];
                d = a[s2][0] * ndu[rk][pk];
            }
            let j1 = if rk >= -1 { 1usize } else { (-rk) as usize };
            let j2 = if ri - 1 <= pk as isize { k - 1 } else { p - r };
            for j in j1..=j2 {
                let idx = (rk + j as isize) as usize;
                a[s2][j] = (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][idx];
                d += a[s2][j] * ndu[idx][pk];
            }
            if ri <= pk as isize {
                a[s2][k] = -a[s1][k - 1] / ndu[pk + 1][r];
                d += a[s2][k] * ndu[r][pk];
            }
            ders[k][r] = d;
            core::mem::swap(&mut s1, &mut s2);
        }
    }
    let mut factor = p as f64;
    for (k, row) in ders.iter_mut().enumerate().take(n + 1).skip(1) {
        let f = S::from_f64(factor);
        for v in row.iter_mut() {
            *v *= f;
        }
        factor *= (p - k) as f64;
    }
    ders
}

/// Binomial coefficient as `f64` (small arguments only).
pub(crate) fn binomial(n: usize, k: usize) -> f64 {
    let mut r = 1.0;
    for i in 0..k {
        r = r * (n - i) as f64 / (i + 1) as f64;
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOTS: [f64; 11] = [0.0, 0.0, 0.0, 1.0, 2.0, 3.0, 4.0, 4.0, 5.0, 5.0, 5.0];

    #[test]
    fn nurbs_book_example_2_3() {
        // The NURBS Book Ex. 2.3: p = 2, u = 5/2 → span 4, N = (1/8, 6/8, 1/8).
        let span = find_span(&KNOTS, 2, 8, 2.5);
        assert_eq!(span, 4);
        let n = basis_funs(&KNOTS, span, 2.5, 2);
        for (a, b) in n.iter().zip([0.125, 0.75, 0.125]) {
            assert!((a - b).abs() < 1e-15);
        }
    }

    #[test]
    fn derivative_row_matches_finite_difference_and_sums_to_zero() {
        let span = find_span(&KNOTS, 2, 8, 2.5);
        let d = ders_basis_funs(&KNOTS, span, 2.5, 2, 2);
        let h = 1e-6;
        let np = basis_funs(&KNOTS, span, 2.5 + h, 2);
        let nm = basis_funs(&KNOTS, span, 2.5 - h, 2);
        for j in 0..3 {
            let fd = (np[j] - nm[j]) / (2.0 * h);
            assert!((d[1][j] - fd).abs() < 1e-8);
        }
        assert!(d[1].iter().sum::<f64>().abs() < 1e-14);
        assert!(d[2].iter().sum::<f64>().abs() < 1e-13);
    }

    #[test]
    fn validation_catches_bad_knots() {
        assert!(validate_knots(&KNOTS, 2, 8).is_ok());
        assert_eq!(
            validate_knots(&KNOTS, 2, 7).unwrap_err().code(),
            "NURBS_KNOT_COUNT_MISMATCH"
        );
        let bad = [0.0, 0.0, 0.0, 2.0, 1.0, 3.0, 4.0, 4.0, 5.0, 5.0, 5.0];
        assert_eq!(
            validate_knots(&bad, 2, 8).unwrap_err().code(),
            "NURBS_KNOTS_DECREASING"
        );
        let mult = [0.0, 0.0, 0.0, 2.0, 2.0, 2.0, 4.0, 4.0, 5.0, 5.0, 5.0];
        assert_eq!(
            validate_knots(&mult, 2, 8).unwrap_err().code(),
            "NURBS_KNOT_MULTIPLICITY"
        );
    }

    #[test]
    fn find_span_at_domain_end() {
        assert_eq!(find_span(&KNOTS, 2, 8, 5.0), 7);
        assert_eq!(find_span(&KNOTS, 2, 8, 0.0), 2);
        assert_eq!(multiplicity(&KNOTS, 4.0), 2);
    }
}
