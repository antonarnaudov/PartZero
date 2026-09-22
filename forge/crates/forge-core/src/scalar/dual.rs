//! Forward-mode dual numbers.

use core::cmp::Ordering;
use core::ops::{Add, AddAssign, Div, DivAssign, Mul, MulAssign, Neg, Sub, SubAssign};

use super::Scalar;

/// A dual number `v + d·ε` with `ε² = 0`: a value and its derivative with respect to one
/// chosen input.
///
/// Evaluating any generic `f: S -> S` at `Dual::variable(x)` yields `(f(x), f'(x))`.
/// The inner type is itself a [`Scalar`], so `Dual<Dual<f64>>` gives second derivatives
/// and `Dual<Interval>` gives certified derivative enclosures.
///
/// # Comparisons
/// `==`, `<`, `min`, `max` compare **values only** (the derivative does not take part),
/// so branches in generic code follow the same path as the plain `f64` evaluation.
///
/// # Non-differentiable points
/// `abs` at 0 returns derivative `+d` (the right derivative); `sqrt` at 0 has an infinite
/// derivative; `min`/`max` pick one operand entirely.
#[derive(Clone, Copy, Debug)]
pub struct Dual<S: Scalar = f64> {
    /// Value part.
    pub v: S,
    /// Derivative part.
    pub d: S,
}

impl<S: Scalar> Dual<S> {
    /// Build a dual number from value and derivative.
    #[inline]
    pub fn new(v: S, d: S) -> Self {
        Self { v, d }
    }
    /// A constant (derivative 0).
    #[inline]
    pub fn constant(v: S) -> Self {
        Self { v, d: S::zero() }
    }
    /// The independent variable (derivative 1).
    #[inline]
    pub fn variable(v: S) -> Self {
        Self { v, d: S::one() }
    }
    /// Apply the chain rule: given `f(v)` and `f'(v)`, return `f(self)`.
    #[inline]
    fn chain(self, fv: S, dfv: S) -> Self {
        Self {
            v: fv,
            d: self.d * dfv,
        }
    }
}

impl<S: Scalar> PartialEq for Dual<S> {
    #[inline]
    fn eq(&self, other: &Self) -> bool {
        self.v == other.v
    }
}

impl<S: Scalar> PartialOrd for Dual<S> {
    #[inline]
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        self.v.partial_cmp(&other.v)
    }
}

impl<S: Scalar> Add for Dual<S> {
    type Output = Self;
    #[inline]
    fn add(self, o: Self) -> Self {
        Self {
            v: self.v + o.v,
            d: self.d + o.d,
        }
    }
}

impl<S: Scalar> Sub for Dual<S> {
    type Output = Self;
    #[inline]
    fn sub(self, o: Self) -> Self {
        Self {
            v: self.v - o.v,
            d: self.d - o.d,
        }
    }
}

impl<S: Scalar> Mul for Dual<S> {
    type Output = Self;
    #[inline]
    fn mul(self, o: Self) -> Self {
        Self {
            v: self.v * o.v,
            d: self.d * o.v + self.v * o.d,
        }
    }
}

impl<S: Scalar> Div for Dual<S> {
    type Output = Self;
    #[inline]
    fn div(self, o: Self) -> Self {
        let q = self.v / o.v;
        Self {
            v: q,
            d: (self.d - q * o.d) / o.v,
        }
    }
}

impl<S: Scalar> Neg for Dual<S> {
    type Output = Self;
    #[inline]
    fn neg(self) -> Self {
        Self {
            v: -self.v,
            d: -self.d,
        }
    }
}

macro_rules! dual_assign {
    ($tr:ident, $f:ident, $op:tt) => {
        impl<S: Scalar> $tr for Dual<S> {
            #[inline]
            fn $f(&mut self, o: Self) {
                *self = *self $op o;
            }
        }
    };
}
dual_assign!(AddAssign, add_assign, +);
dual_assign!(SubAssign, sub_assign, -);
dual_assign!(MulAssign, mul_assign, *);
dual_assign!(DivAssign, div_assign, /);

impl<S: Scalar> Scalar for Dual<S> {
    #[inline]
    fn from_f64(x: f64) -> Self {
        Self::constant(S::from_f64(x))
    }
    #[inline]
    fn to_f64(self) -> f64 {
        self.v.to_f64()
    }
    #[inline]
    fn pi() -> Self {
        Self::constant(S::pi())
    }
    fn abs(self) -> Self {
        if self.v < S::zero() { -self } else { self }
    }
    fn sqrt(self) -> Self {
        let r = self.v.sqrt();
        self.chain(r, (S::from_f64(2.0) * r).recip())
    }
    fn square(self) -> Self {
        Self {
            v: self.v.square(),
            d: S::from_f64(2.0) * self.v * self.d,
        }
    }
    fn powf(self, e: Self) -> Self {
        let val = self.v.powf(e.v);
        if e.d == S::zero() {
            // d/dx x^c = c·x^(c−1): valid for x ≤ 0 with integral c, unlike the log form.
            let dv = e.v * self.v.powf(e.v - S::one());
            return Self {
                v: val,
                d: self.d * dv,
            };
        }
        Self {
            v: val,
            d: val * (e.d * self.v.ln() + e.v * self.d / self.v),
        }
    }
    fn hypot(self, other: Self) -> Self {
        let h = self.v.hypot(other.v);
        Self {
            v: h,
            d: (self.v * self.d + other.v * other.d) / h,
        }
    }
    fn sin(self) -> Self {
        let (s, c) = self.v.sin_cos();
        self.chain(s, c)
    }
    fn cos(self) -> Self {
        let (s, c) = self.v.sin_cos();
        self.chain(c, -s)
    }
    fn sin_cos(self) -> (Self, Self) {
        let (s, c) = self.v.sin_cos();
        (self.chain(s, c), self.chain(c, -s))
    }
    fn tan(self) -> Self {
        let t = self.v.tan();
        self.chain(t, S::one() + t.square())
    }
    fn asin(self) -> Self {
        self.chain(self.v.asin(), (S::one() - self.v.square()).sqrt().recip())
    }
    fn acos(self) -> Self {
        self.chain(self.v.acos(), -(S::one() - self.v.square()).sqrt().recip())
    }
    fn atan(self) -> Self {
        self.chain(self.v.atan(), (S::one() + self.v.square()).recip())
    }
    fn atan2(self, x: Self) -> Self {
        let y = self;
        let r2 = x.v.square() + y.v.square();
        Self {
            v: y.v.atan2(x.v),
            d: (x.v * y.d - y.v * x.d) / r2,
        }
    }
    fn exp(self) -> Self {
        let e = self.v.exp();
        self.chain(e, e)
    }
    fn ln(self) -> Self {
        self.chain(self.v.ln(), self.v.recip())
    }
    fn min(self, other: Self) -> Self {
        if other.v < self.v { other } else { self }
    }
    fn max(self, other: Self) -> Self {
        if other.v > self.v { other } else { self }
    }
    fn is_finite(self) -> bool {
        self.v.is_finite() && self.d.is_finite()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * (1.0 + a.abs().max(b.abs()))
    }

    #[test]
    fn product_and_quotient_rules() {
        let x = Dual::variable(3.0);
        let f = x * x * x / (x + Dual::constant(1.0)); // x³/(x+1)
        // f' = (3x²(x+1) − x³)/(x+1)² = (81·4 − 27... ) evaluate numerically:
        let expected = (3.0 * 9.0 * 4.0 - 27.0) / 16.0;
        assert!(close(f.v, 27.0 / 4.0, 1e-15));
        assert!(close(f.d, expected, 1e-15));
    }

    #[test]
    fn nested_duals_give_second_derivatives() {
        // f(x) = sin(x)·x ⇒ f'' = 2cos x − x sin x
        let x0 = 0.7;
        let x = Dual::new(Dual::variable(x0), Dual::constant(1.0));
        let f = x.sin() * x;
        let expected = 2.0 * crate::math::cos(x0) - x0 * crate::math::sin(x0);
        assert!(close(f.d.d, expected, 1e-14));
    }

    #[test]
    fn powf_with_constant_exponent_handles_negative_base() {
        let x = Dual::variable(-2.0);
        let f = x.powf(Dual::constant(3.0));
        assert!(close(f.v, -8.0, 1e-15));
        assert!(close(f.d, 12.0, 1e-14));
    }

    #[test]
    fn comparisons_use_value_only() {
        assert!(Dual::new(1.0, 5.0) == Dual::new(1.0, -5.0));
        assert!(Dual::new(1.0, 5.0) < Dual::new(2.0, -5.0));
    }
}
