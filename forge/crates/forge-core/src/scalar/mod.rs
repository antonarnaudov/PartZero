//! The [`Scalar`] abstraction that all of Forge's numeric algorithms are written against.
//!
//! Writing geometry once, generically over `S: Scalar`, lets the same code run on:
//! - [`f64`]: the production path.
//! - [`Interval`]: certified enclosures (every result interval contains the exact
//!   real-number result of the same expression evaluated on any point inputs).
//! - [`Dual`]: forward-mode automatic differentiation (value + one derivative).
//! - later, an exact `Rational` type (for oracle checks of rational-only algorithms).
//!
//! # Rules for generic code
//! - Only use the operations of this trait (never `f64` methods through `to_f64`) for
//!   anything that should be certified or differentiated.
//! - `to_f64` is for *discrete decisions that are not topology decisions* (picking a
//!   knot span, choosing an iteration seed). It is approximate for non-`f64` scalars.
//! - Real constants (π) come from [`Scalar::pi`], never from `S::from_f64(PI)`: an
//!   interval needs an enclosure of π, not of its `f64` rounding.
//! - Comparisons (`PartialOrd`) are "certain" comparisons for intervals (see
//!   [`Interval`]) and compare values only for duals.
//!
//! Transcendental functions of `f64` use [`crate::math`] (libm), so results are
//! bit-identical on every target. Exact scalar types may not support transcendentals;
//! such implementations will document how they approximate or reject them.

mod dual;
mod interval;

pub use dual::Dual;
pub use interval::Interval;

use core::fmt::Debug;
use core::ops::{Add, AddAssign, Div, DivAssign, Mul, MulAssign, Neg, Sub, SubAssign};

use crate::math;

/// A real-number-like field element used by every generic Forge algorithm.
///
/// See the [module docs](self) for the rules generic code must follow.
pub trait Scalar:
    Copy
    + Debug
    + PartialEq
    + PartialOrd
    + Add<Output = Self>
    + Sub<Output = Self>
    + Mul<Output = Self>
    + Div<Output = Self>
    + Neg<Output = Self>
    + AddAssign
    + SubAssign
    + MulAssign
    + DivAssign
    + 'static
{
    /// Inject an `f64`. The value is taken as the exact real number the `f64` represents.
    fn from_f64(x: f64) -> Self;
    /// Approximate this scalar by an `f64` (the value itself for `f64`, the midpoint of an
    /// interval, the value part of a dual number).
    fn to_f64(self) -> f64;

    /// Additive identity.
    #[inline]
    fn zero() -> Self {
        Self::from_f64(0.0)
    }
    /// Multiplicative identity.
    #[inline]
    fn one() -> Self {
        Self::from_f64(1.0)
    }
    /// The constant π (an enclosure of π for interval types).
    fn pi() -> Self;
    /// The constant 2π.
    #[inline]
    fn tau() -> Self {
        Self::pi() * Self::from_f64(2.0)
    }
    /// The constant π/2.
    #[inline]
    fn frac_pi_2() -> Self {
        Self::pi() / Self::from_f64(2.0)
    }

    /// Absolute value.
    fn abs(self) -> Self;
    /// Square root (NaN / empty for negative input).
    fn sqrt(self) -> Self;
    /// `self * self`; interval types return a tighter enclosure than `x * x`.
    #[inline]
    fn square(self) -> Self {
        self * self
    }
    /// `1 / self`.
    #[inline]
    fn recip(self) -> Self {
        Self::one() / self
    }
    /// Integer power by binary exponentiation (portable, fixed operation sequence).
    fn powi(self, n: i32) -> Self {
        let mut base = self;
        let mut e = n.unsigned_abs();
        let mut acc = Self::one();
        while e > 0 {
            if e & 1 == 1 {
                acc *= base;
            }
            base = base.square();
            e >>= 1;
        }
        if n < 0 { acc.recip() } else { acc }
    }
    /// `self` raised to a real power.
    fn powf(self, e: Self) -> Self;
    /// `sqrt(self² + other²)`.
    #[inline]
    fn hypot(self, other: Self) -> Self {
        (self.square() + other.square()).sqrt()
    }

    /// Sine (radians).
    fn sin(self) -> Self;
    /// Cosine (radians).
    fn cos(self) -> Self;
    /// `(sin, cos)`.
    #[inline]
    fn sin_cos(self) -> (Self, Self) {
        (self.sin(), self.cos())
    }
    /// Tangent (radians).
    fn tan(self) -> Self;
    /// Arcsine.
    fn asin(self) -> Self;
    /// Arccosine.
    fn acos(self) -> Self;
    /// Arctangent.
    fn atan(self) -> Self;
    /// Four-quadrant arctangent of `self / x` (`self` is y).
    fn atan2(self, x: Self) -> Self;
    /// Natural exponential.
    fn exp(self) -> Self;
    /// Natural logarithm.
    fn ln(self) -> Self;

    /// Minimum (for intervals: the enclosure of the pointwise minimum).
    fn min(self, other: Self) -> Self;
    /// Maximum (for intervals: the enclosure of the pointwise maximum).
    fn max(self, other: Self) -> Self;
    /// `true` if the scalar holds no NaN or infinity.
    fn is_finite(self) -> bool;
}

impl Scalar for f64 {
    #[inline]
    fn from_f64(x: f64) -> Self {
        x
    }
    #[inline]
    fn to_f64(self) -> f64 {
        self
    }
    #[inline]
    fn zero() -> Self {
        0.0
    }
    #[inline]
    fn one() -> Self {
        1.0
    }
    #[inline]
    fn pi() -> Self {
        math::PI
    }
    #[inline]
    fn tau() -> Self {
        math::TAU
    }
    #[inline]
    fn frac_pi_2() -> Self {
        math::FRAC_PI_2
    }
    #[inline]
    fn abs(self) -> Self {
        f64::abs(self)
    }
    #[inline]
    fn sqrt(self) -> Self {
        f64::sqrt(self)
    }
    #[inline]
    fn powi(self, n: i32) -> Self {
        math::powi(self, n)
    }
    #[inline]
    fn powf(self, e: Self) -> Self {
        math::powf(self, e)
    }
    #[inline]
    fn hypot(self, other: Self) -> Self {
        math::hypot(self, other)
    }
    #[inline]
    fn sin(self) -> Self {
        math::sin(self)
    }
    #[inline]
    fn cos(self) -> Self {
        math::cos(self)
    }
    #[inline]
    fn sin_cos(self) -> (Self, Self) {
        math::sin_cos(self)
    }
    #[inline]
    fn tan(self) -> Self {
        math::tan(self)
    }
    #[inline]
    fn asin(self) -> Self {
        math::asin(self)
    }
    #[inline]
    fn acos(self) -> Self {
        math::acos(self)
    }
    #[inline]
    fn atan(self) -> Self {
        math::atan(self)
    }
    #[inline]
    fn atan2(self, x: Self) -> Self {
        math::atan2(self, x)
    }
    #[inline]
    fn exp(self) -> Self {
        math::exp(self)
    }
    #[inline]
    fn ln(self) -> Self {
        math::ln(self)
    }
    #[inline]
    fn min(self, other: Self) -> Self {
        f64::min(self, other)
    }
    #[inline]
    fn max(self, other: Self) -> Self {
        f64::max(self, other)
    }
    #[inline]
    fn is_finite(self) -> bool {
        f64::is_finite(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generic_poly<S: Scalar>(x: S) -> S {
        // 3x² − 2x + 1
        S::from_f64(3.0) * x.square() - S::from_f64(2.0) * x + S::one()
    }

    #[test]
    fn f64_scalar_evaluates_generic_code() {
        assert!((generic_poly(2.0) - 9.0).abs() < 1e-15);
        assert!((f64::pi() - math::PI).abs() == 0.0);
        assert!((Scalar::powi(2.0, -3) - 0.125).abs() == 0.0);
        assert!((Scalar::hypot(3.0, 4.0) - 5.0).abs() < 1e-15);
    }

    #[test]
    fn default_powi_matches_math_powi() {
        // Dual uses the default implementation; compare its value part.
        let d = Dual::<f64>::variable(1.5).powi(7);
        assert!((d.v - math::powi(1.5, 7)).abs() < 1e-12);
    }
}
