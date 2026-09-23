//! Normative degree trigonometry (SPEC-v1 §2.7 rule 4), shared by the expression evaluator
//! (W1), compound-curve expansion ([`super::compound`]) and hole placement.
//!
//! Bit-identical on every target: the only transcendental is `libm::sincos`, the function
//! `forge_core::math::sin_cos` wraps.

/// `π/180` rounded to the nearest f64 (`0.017453292519943295`).
pub const DEG_TO_RAD: f64 = 0.017453292519943295;

/// `(sin, cos)` of the exact table angles of §2.7 rule 4.3 (correctly rounded values).
const TABLE: [(f64, f64, f64); 4] = [
    (0.0, 0.0, 1.0),
    (30.0, 0.5, 0.8660254037844386),
    (
        45.0,
        std::f64::consts::FRAC_1_SQRT_2,
        std::f64::consts::FRAC_1_SQRT_2,
    ),
    (60.0, 0.8660254037844386, 0.5),
];

/// `(sin x, cos x)` for `x` in degrees, per §2.7 rule 4. Returns `None` for a non-finite `x`
/// (`EXPR_DOMAIN`). Results are never `-0`.
pub fn sin_cos_deg(x: f64) -> Option<(f64, f64)> {
    if !x.is_finite() {
        return None;
    }
    // 1. r = x rem_euclid 360. rem_euclid is exact except that a tiny negative x rounds
    //    `r + 360` up to exactly 360; that is the same angle as 0 ([W0-5]).
    let mut r = x.rem_euclid(360.0);
    if r >= 360.0 {
        r = 0.0;
    }
    // 2. q = the largest integer in {0, 1, 2, 3} with 90·q ≤ r; s = r − 90·q (exact).
    let q = if r >= 270.0 {
        3
    } else if r >= 180.0 {
        2
    } else if r >= 90.0 {
        1
    } else {
        0
    };
    let s = r - 90.0 * f64::from(q);
    // 3. Exact table, else libm.
    // Exact comparison on purpose: the table holds exactly representable angles.
    #[allow(clippy::float_cmp)]
    let (ss, cs) = match TABLE.iter().find(|(a, _, _)| *a == s) {
        Some(&(_, sv, cv)) => (sv, cv),
        None => libm::sincos(s * DEG_TO_RAD),
    };
    // 4. Rotate by the quadrant exactly.
    let (sn, cn) = match q {
        0 => (ss, cs),
        1 => (cs, -ss),
        2 => (-ss, -cs),
        _ => (-cs, ss),
    };
    Some((no_neg_zero(sn), no_neg_zero(cn)))
}

/// `sin x`, degrees.
pub fn sin_deg(x: f64) -> Option<f64> {
    sin_cos_deg(x).map(|(s, _)| s)
}

/// `cos x`, degrees.
pub fn cos_deg(x: f64) -> Option<f64> {
    sin_cos_deg(x).map(|(_, c)| c)
}

/// `tan x = sin x / cos x`, degrees; `None` when `cos x == 0` (`EXPR_DOMAIN`).
pub fn tan_deg(x: f64) -> Option<f64> {
    let (s, c) = sin_cos_deg(x)?;
    if c == 0.0 {
        None
    } else {
        Some(no_neg_zero(s / c))
    }
}

/// §2.7 rule 8: `-0` is replaced by `+0`.
pub fn no_neg_zero(v: f64) -> f64 {
    if v == 0.0 { 0.0 } else { v }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn right_angles_and_table_angles_are_exact() {
        for k in -48i32..=48 {
            let x = 30.0 * f64::from(k);
            let (s, c) = sin_cos_deg(x).unwrap();
            let r = x.rem_euclid(360.0);
            let expect = |deg: f64| -> (f64, f64) {
                match deg as i32 {
                    0 => (0.0, 1.0),
                    30 => (0.5, 0.8660254037844386),
                    60 => (0.8660254037844386, 0.5),
                    90 => (1.0, 0.0),
                    120 => (0.8660254037844386, -0.5),
                    150 => (0.5, -0.8660254037844386),
                    180 => (0.0, -1.0),
                    210 => (-0.5, -0.8660254037844386),
                    240 => (-0.8660254037844386, -0.5),
                    270 => (-1.0, 0.0),
                    300 => (-0.8660254037844386, 0.5),
                    330 => (-0.5, 0.8660254037844386),
                    _ => unreachable!(),
                }
            };
            let (es, ec) = expect(r);
            assert_eq!(
                (s.to_bits(), c.to_bits()),
                (es.to_bits(), ec.to_bits()),
                "{x}"
            );
        }
        assert_eq!(tan_deg(45.0), Some(1.0));
        assert_eq!(tan_deg(-45.0), Some(-1.0));
        assert_eq!(tan_deg(90.0), None);
        assert_eq!(tan_deg(270.0), None);
    }

    #[test]
    fn tiny_negative_angles_reduce_to_zero_not_360() {
        let (s, c) = sin_cos_deg(-1e-20).unwrap();
        assert_eq!((s, c), (0.0, 1.0));
        assert!(sin_cos_deg(f64::NAN).is_none());
        assert!(sin_cos_deg(f64::INFINITY).is_none());
    }

    #[test]
    fn never_returns_negative_zero() {
        for x in [0.0, -0.0, 180.0, -180.0, 360.0, -360.0, 90.0, -90.0] {
            let (s, c) = sin_cos_deg(x).unwrap();
            assert!(!(s == 0.0 && s.is_sign_negative()), "{x}");
            assert!(!(c == 0.0 && c.is_sign_negative()), "{x}");
        }
    }
}
