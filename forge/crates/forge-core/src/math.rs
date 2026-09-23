//! Deterministic elementary functions.
//!
//! Every transcendental function used by Forge goes through this module. The functions
//! are thin wrappers over the pure-Rust [`libm`] crate (a port of musl's libm), so they
//! produce **bit-identical** results on macOS, Windows, Linux and `wasm32`, unlike
//! `f64::sin` & co., which call the platform C library or LLVM intrinsics.
//!
//! What is *not* routed through here, because IEEE 754 already makes it exact
//! (correctly rounded) on every target:
//! `+ - * /`, [`f64::sqrt`], [`f64::abs`], [`f64::floor`]/`ceil`/`trunc`/`round`,
//! [`f64::next_up`]/`next_down`.
//!
//! Routed through here although the IEEE result is well defined:
//! - [`min`] / [`max`] instead of [`f64::min`]/[`f64::max`]: IEEE 754-2008 `minNum`
//!   leaves the `±0` tie unspecified, and targets do resolve it differently: x86_64
//!   `minsd`/`maxsd` return an operand by position (`f64::min(0.0, -0.0)` is `+0.0`),
//!   aarch64 `fminnm`/`fmaxnm` and wasm32 order the zeros (`−0.0`). [`min`]/[`max`]
//!   specify it as `−0 < +0`, which keeps the results of the aarch64 reference platform.
//! - [`fmod`] / [`rem_euclid`] instead of `%` / [`f64::rem_euclid`]: the remainder is
//!   exact everywhere, but `%` compiles to a call into the *platform's* C `fmod` on some
//!   targets (macOS), so it goes through libm like every other library function.
//!
//! Never use `f64::mul_add`, `f64::powi` (unspecified precision, may differ between
//! targets) or `f64::sin`/`cos`/`exp`/… directly in kernel code.
//!
//! libm's default `arch` feature only substitutes hardware instructions for correctly
//! rounded operations (sqrt, fma, floor, …) on our targets, so it does not affect
//! determinism.
//!
//! # Degrees
//! The IR uses degrees. [`deg_to_rad`] and [`sin_cos_deg`] reduce the angle by exact
//! multiples of 90° first, so right angles map to the exact `f64` constants
//! (`deg_to_rad(180.0) == PI`) and `sin_cos_deg(90.0) == (1.0, 0.0)` exactly.

/// π rounded to the nearest `f64` (slightly *below* the true π).
pub const PI: f64 = core::f64::consts::PI;
/// 2π rounded to the nearest `f64` (exactly `2.0 * PI`).
pub const TAU: f64 = core::f64::consts::TAU;
/// π/2 rounded to the nearest `f64` (exactly `PI / 2.0`).
pub const FRAC_PI_2: f64 = core::f64::consts::FRAC_PI_2;
/// π/4 rounded to the nearest `f64`.
pub const FRAC_PI_4: f64 = core::f64::consts::FRAC_PI_4;

/// Sine (radians).
#[inline]
pub fn sin(x: f64) -> f64 {
    libm::sin(x)
}

/// Cosine (radians).
#[inline]
pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}

/// `(sin x, cos x)` (radians), computed with one shared argument reduction.
#[inline]
pub fn sin_cos(x: f64) -> (f64, f64) {
    libm::sincos(x)
}

/// Tangent (radians).
#[inline]
pub fn tan(x: f64) -> f64 {
    libm::tan(x)
}

/// Arcsine, result in `[-π/2, π/2]`; NaN outside `[-1, 1]`.
#[inline]
pub fn asin(x: f64) -> f64 {
    libm::asin(x)
}

/// Arccosine, result in `[0, π]`; NaN outside `[-1, 1]`.
#[inline]
pub fn acos(x: f64) -> f64 {
    libm::acos(x)
}

/// Arctangent, result in `[-π/2, π/2]`.
#[inline]
pub fn atan(x: f64) -> f64 {
    libm::atan(x)
}

/// Four-quadrant arctangent of `y / x`, result in `[-π, π]`.
#[inline]
pub fn atan2(y: f64, x: f64) -> f64 {
    libm::atan2(y, x)
}

/// Natural exponential.
#[inline]
pub fn exp(x: f64) -> f64 {
    libm::exp(x)
}

/// Natural logarithm.
#[inline]
pub fn ln(x: f64) -> f64 {
    libm::log(x)
}

/// `x` raised to the real power `y`.
#[inline]
pub fn powf(x: f64, y: f64) -> f64 {
    libm::pow(x, y)
}

/// `x` raised to an integer power by binary exponentiation (a fixed, portable sequence of
/// multiplications, unlike `f64::powi`).
pub fn powi(x: f64, n: i32) -> f64 {
    let mut base = x;
    let mut e = n.unsigned_abs();
    let mut acc = 1.0;
    while e > 0 {
        if e & 1 == 1 {
            acc *= base;
        }
        base *= base;
        e >>= 1;
    }
    if n < 0 { 1.0 / acc } else { acc }
}

/// `sqrt(x² + y²)` without undue overflow or underflow.
#[inline]
pub fn hypot(x: f64, y: f64) -> f64 {
    libm::hypot(x, y)
}

/// Cube root (defined for negative arguments).
#[inline]
pub fn cbrt(x: f64) -> f64 {
    libm::cbrt(x)
}

/// Square root. IEEE 754 correctly rounded; provided for symmetry with the other wrappers.
#[inline]
pub fn sqrt(x: f64) -> f64 {
    x.sqrt()
}

/// The smaller of two numbers, with a result that is fully specified and therefore
/// identical on every target (IEEE 754-2019 `minimumNumber`):
/// - a NaN argument is ignored: the other argument is returned (like [`f64::min`]); if
///   both are NaN, the first one is returned;
/// - `−0.0` counts as smaller than `+0.0`, whatever the argument order:
///   `min(0.0, -0.0)` and `min(-0.0, 0.0)` are both `−0.0`.
///
/// Use this instead of [`f64::min`], whose `±0` result depends on the target (see the
/// module docs). `Scalar::min` for `f64` (and so `Vec3::min_components`) is this.
#[inline]
pub fn min(a: f64, b: f64) -> f64 {
    if a < b {
        a
    } else if b < a {
        b
    } else if b.is_nan() {
        a
    } else if a.is_nan() {
        b
    } else if a.is_sign_negative() {
        // Equal values have different bits only for ±0: pick −0.
        a
    } else {
        b
    }
}

/// The larger of two numbers, with a result that is fully specified and therefore
/// identical on every target (IEEE 754-2019 `maximumNumber`):
/// - a NaN argument is ignored: the other argument is returned (like [`f64::max`]); if
///   both are NaN, the first one is returned;
/// - `+0.0` counts as larger than `−0.0`, whatever the argument order:
///   `max(0.0, -0.0)` and `max(-0.0, 0.0)` are both `+0.0`.
///
/// Use this instead of [`f64::max`] (see [`min`]).
#[inline]
pub fn max(a: f64, b: f64) -> f64 {
    if a > b {
        a
    } else if b > a {
        b
    } else if b.is_nan() {
        a
    } else if a.is_nan() {
        b
    } else if a.is_sign_positive() {
        // Equal values have different bits only for ±0: pick +0.
        a
    } else {
        b
    }
}

/// Remainder of `x / y` rounded towards zero, `x − trunc(x / y)·y`, with the sign of
/// `x`. Exact (no rounding happens). Same as `x % y`, but computed by libm rather than
/// the platform C library.
#[inline]
pub fn fmod(x: f64, y: f64) -> f64 {
    libm::fmod(x, y)
}

/// Euclidean remainder: the least non-negative `r` with `x = q·y + r` for an integer `q`.
/// Exact when [`fmod`] is non-negative; otherwise `fmod + |y|` rounds once. Same as
/// [`f64::rem_euclid`], but built on [`fmod`].
#[inline]
pub fn rem_euclid(x: f64, y: f64) -> f64 {
    let r = fmod(x, y);
    if r < 0.0 { r + y.abs() } else { r }
}

/// Reduce an angle in degrees to `(quadrant, remainder)` with
/// `deg = 90·quadrant + remainder` (up to a multiple of 360°), `quadrant ∈ 0..4` and
/// `remainder ∈ [-45, 45]`. The reduction is exact (`fmod` is exact).
fn reduce_deg(deg: f64) -> (u8, f64) {
    let r = fmod(deg, 360.0); // exact, same sign as deg
    let r = if r < 0.0 { r + 360.0 } else { r }; // may round only when |r| < 2^-44
    let mut q = 0u8;
    let mut rem = r;
    while rem > 45.0 {
        rem -= 90.0; // exact: both operands are small multiples of 2^-44 or integers
        q += 1;
    }
    (q % 4, rem)
}

/// Convert degrees to radians. Exact multiples of 90° map exactly onto multiples of the
/// `f64` constant [`FRAC_PI_2`] (so `deg_to_rad(360.0) == TAU`).
pub fn deg_to_rad(deg: f64) -> f64 {
    if !deg.is_finite() {
        return deg * (PI / 180.0);
    }
    // Split off whole quarter turns so the common angles are exact.
    let quarters = (deg / 90.0).trunc();
    let rem = deg - quarters * 90.0; // exact for |deg| < 2^53·90
    quarters * FRAC_PI_2 + rem * (PI / 180.0)
}

/// Convert radians to degrees.
pub fn rad_to_deg(rad: f64) -> f64 {
    rad * (180.0 / PI)
}

/// `(sin, cos)` of an angle in **degrees**, exact (0, ±1) at multiples of 90°.
pub fn sin_cos_deg(deg: f64) -> (f64, f64) {
    if !deg.is_finite() {
        return (f64::NAN, f64::NAN);
    }
    let (q, rem) = reduce_deg(deg);
    let (s, c) = if rem == 0.0 {
        (0.0, 1.0)
    } else {
        sin_cos(rem * (PI / 180.0))
    };
    match q {
        0 => (s, c),
        1 => (c, -s),
        2 => (-s, -c),
        _ => (-c, s),
    }
}

/// Wrap an angle (radians) into `[start, start + 2π)`.
///
/// Uses [`rem_euclid`], which is exact for a non-negative remainder; the only other
/// rounding is the final addition.
pub fn wrap_angle(angle: f64, start: f64) -> f64 {
    let w = rem_euclid(angle - start, TAU) + start;
    // rem_euclid can return exactly TAU after rounding of tiny negative inputs.
    if w >= start + TAU { start } else { w }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn degree_conversion_is_exact_at_right_angles() {
        assert_eq!(deg_to_rad(90.0).to_bits(), FRAC_PI_2.to_bits());
        assert_eq!(deg_to_rad(180.0).to_bits(), PI.to_bits());
        assert_eq!(deg_to_rad(360.0).to_bits(), TAU.to_bits());
        assert_eq!(deg_to_rad(-90.0).to_bits(), (-FRAC_PI_2).to_bits());
        assert!((deg_to_rad(45.0) - FRAC_PI_4).abs() <= 1e-16);
        assert!((rad_to_deg(PI) - 180.0).abs() <= 1e-13);
    }

    #[test]
    fn sin_cos_deg_is_exact_at_quadrants() {
        for (d, s, c) in [
            (0.0, 0.0, 1.0),
            (90.0, 1.0, 0.0),
            (180.0, 0.0, -1.0),
            (270.0, -1.0, 0.0),
            (360.0, 0.0, 1.0),
            (-90.0, -1.0, 0.0),
            (720.0, 0.0, 1.0),
        ] {
            let (ss, cc) = sin_cos_deg(d);
            // Exact equality (±0 compare equal).
            assert!((ss - s).abs() == 0.0, "sin({d}) = {ss}");
            assert!((cc - c).abs() == 0.0, "cos({d}) = {cc}");
        }
        let (s, c) = sin_cos_deg(30.0);
        assert!((s - 0.5).abs() < 1e-15 && (c - 0.75f64.sqrt()).abs() < 1e-15);
        let (s, c) = sin_cos_deg(135.0);
        assert!((s - 0.5f64.sqrt()).abs() < 1e-15 && (c + 0.5f64.sqrt()).abs() < 1e-15);
    }

    #[test]
    fn powi_matches_repeated_multiplication() {
        assert_eq!(powi(2.0, 10).to_bits(), 1024.0f64.to_bits());
        assert_eq!(powi(2.0, -2).to_bits(), 0.25f64.to_bits());
        assert_eq!(powi(3.0, 0).to_bits(), 1.0f64.to_bits());
    }

    #[test]
    fn wrap_angle_lands_in_half_open_range() {
        for a in [-10.0, -TAU, -1e-300, 0.0, 1.0, TAU, 7.0 * TAU + 0.5] {
            let w = wrap_angle(a, 0.0);
            assert!((0.0..TAU).contains(&w), "{a} -> {w}");
        }
        let w = wrap_angle(-PI, -PI);
        assert!((-PI..PI).contains(&w));
    }

    /// `f64::min`/`max` leave the ±0 tie to the target (x86_64 `minsd` returns an operand
    /// by position: `f64::min(0.0, -0.0)` is `+0.0` there, `−0.0` on aarch64); the
    /// wrappers must give the same bits for either argument order, with −0 < +0.
    #[test]
    fn min_max_resolve_signed_zero_ties_independently_of_argument_order() {
        let (p, n) = (0.0f64, -0.0f64);
        for (a, b) in [(p, n), (n, p)] {
            assert_eq!(min(a, b).to_bits(), n.to_bits(), "min({a:?}, {b:?})");
            assert_eq!(max(a, b).to_bits(), p.to_bits(), "max({a:?}, {b:?})");
        }
        assert_eq!(min(n, n).to_bits(), n.to_bits());
        assert_eq!(max(p, p).to_bits(), p.to_bits());
        // Every pair of a sample set: order-independent bits.
        let xs = [
            f64::NEG_INFINITY,
            -2.5,
            -f64::MIN_POSITIVE,
            n,
            p,
            5e-324,
            1.0,
            f64::INFINITY,
        ];
        for &a in &xs {
            for &b in &xs {
                assert_eq!(min(a, b).to_bits(), min(b, a).to_bits(), "min({a}, {b})");
                assert_eq!(max(a, b).to_bits(), max(b, a).to_bits(), "max({a}, {b})");
                // Same value as `f64::min`/`max` (they may differ only in the zero's sign).
                let same = |x: f64, y: f64| x.partial_cmp(&y) == Some(core::cmp::Ordering::Equal);
                assert!(same(min(a, b), a.min(b)) && same(max(a, b), a.max(b)));
            }
        }
    }

    #[test]
    fn min_max_ignore_nan_like_f64_min_max() {
        let nan = f64::NAN;
        let bits = f64::to_bits;
        assert_eq!(bits(min(nan, 1.5)), bits(1.5));
        assert_eq!(bits(min(1.5, nan)), bits(1.5));
        assert_eq!(bits(max(nan, -1.5)), bits(-1.5));
        assert_eq!(bits(max(-1.5, nan)), bits(-1.5));
        assert_eq!(min(nan, -0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(max(0.0, nan).to_bits(), 0.0f64.to_bits());
        assert!(min(nan, nan).is_nan() && max(nan, nan).is_nan());
    }

    #[test]
    fn fmod_and_rem_euclid_match_the_exact_operators() {
        for x in [
            -1e300, -725.5, -360.0, -359.25, -1e-300, -0.0, 0.0, 1e-300, 45.0, 359.999, 360.0,
            1e17, 7.3e22,
        ] {
            for y in [360.0, TAU, 0.1, 3.0] {
                // `%` and `rem_euclid` are exact, so libm's exact fmod must agree bit for bit.
                assert_eq!(fmod(x, y).to_bits(), (x % y).to_bits(), "fmod({x}, {y})");
                assert_eq!(
                    rem_euclid(x, y).to_bits(),
                    x.rem_euclid(y).to_bits(),
                    "rem_euclid({x}, {y})"
                );
            }
        }
        assert!(fmod(f64::INFINITY, 1.0).is_nan() && fmod(1.0, 0.0).is_nan());
    }

    #[test]
    fn wrappers_are_libm() {
        // Spot-check a few known values; exact bit patterns are libm's.
        assert!((sin(FRAC_PI_2) - 1.0).abs() < 1e-16);
        assert!((cos(PI) + 1.0).abs() < 1e-16);
        assert!((atan2(1.0, 1.0) - FRAC_PI_4).abs() < 1e-16);
        assert!((exp(ln(5.0)) - 5.0).abs() < 1e-14);
        assert!((powf(2.0, 0.5) - 2f64.sqrt()).abs() < 1e-16);
        assert!((hypot(3.0, 4.0) - 5.0).abs() < 1e-16);
        assert!((cbrt(-27.0) + 3.0).abs() < 1e-15);
        assert!((acos(-1.0) - PI).abs() < 1e-16 && (asin(1.0) - FRAC_PI_2).abs() < 1e-16);
        assert!((tan(FRAC_PI_4) - 1.0).abs() < 1e-15 && (atan(1.0) - FRAC_PI_4).abs() < 1e-16);
    }
}
