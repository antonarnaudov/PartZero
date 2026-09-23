//! Interval arithmetic with emulated outward rounding.

use core::cmp::Ordering;
use core::ops::{Add, AddAssign, Div, DivAssign, Mul, MulAssign, Neg, Sub, SubAssign};

use super::Scalar;
use crate::math;

/// Number of ulps by which results of libm functions are widened. libm (musl) documents
/// errors below 1 ulp for the functions used here; 2 ulps leaves a safety margin.
const LIBM_ULPS: u32 = 2;

/// A closed interval `[lo, hi]` of real numbers, used for certified enclosures.
///
/// # Guarantee
/// Every operation returns an interval that contains the exact real result of the
/// operation applied to any real numbers inside the operand intervals. Rounding is made
/// outward by computing each bound in round-to-nearest and then stepping one ulp
/// outward with [`f64::next_down`] / [`f64::next_up`] (round-to-nearest errs by at most
/// half an ulp, so this is always conservative). Results of libm functions are widened by
/// 2 ulps.
///
/// # Special values
/// - Bounds may be infinite (`lo = −∞` and/or `hi = +∞`).
/// - [`Interval::EMPTY`] (both bounds NaN) is the result of a domain error, e.g. the
///   square root of a strictly negative interval. Empty inputs propagate.
/// - Division by an interval that contains 0 returns [`Interval::ENTIRE`]; use
///   [`Interval::checked_div`] to detect it instead.
///
/// # Comparisons
/// `a < b` is true only if it holds for **every** pair of points (`a.hi < b.lo`).
/// `a == b` means *identical bounds*; `partial_cmp` returns `Equal` only then, and
/// `None` for overlapping, non-identical intervals.
/// `to_f64` returns the midpoint.
#[derive(Clone, Copy, Debug)]
pub struct Interval {
    lo: f64,
    hi: f64,
}

#[inline]
fn down(x: f64) -> f64 {
    x.next_down()
}

#[inline]
fn up(x: f64) -> f64 {
    x.next_up()
}

fn down_n(mut x: f64, n: u32) -> f64 {
    for _ in 0..n {
        x = x.next_down();
    }
    x
}

fn up_n(mut x: f64, n: u32) -> f64 {
    for _ in 0..n {
        x = x.next_up();
    }
    x
}

/// Smallest of four bounds, folded left to right with [`math::min`] (deterministic ±0,
/// NaN corners ignored).
#[inline]
fn min4(x: [f64; 4]) -> f64 {
    math::min(math::min(math::min(x[0], x[1]), x[2]), x[3])
}

/// Largest of four bounds, folded left to right with [`math::max`].
#[inline]
fn max4(x: [f64; 4]) -> f64 {
    math::max(math::max(math::max(x[0], x[1]), x[2]), x[3])
}

/// Product of two bounds with the interval-arithmetic convention `0 · ∞ = 0`.
#[inline]
fn mul_bound(a: f64, b: f64) -> f64 {
    if a == 0.0 || b == 0.0 { 0.0 } else { a * b }
}

/// Conservatively decide whether `[lo, hi]` may contain a point `offset + k·period` for
/// some integer `k`. Returns `false` only when that is certain.
fn may_contain_lattice_point(lo: f64, hi: f64, offset: f64, period: f64) -> bool {
    let t_lo = (lo - offset) / period;
    let t_hi = (hi - offset) / period;
    if !t_lo.is_finite() || !t_hi.is_finite() {
        return true;
    }
    // Generous slack covering the error of π's f64 approximation and of the division.
    let slack_lo = 1e-9 * (1.0 + t_lo.abs());
    let slack_hi = 1e-9 * (1.0 + t_hi.abs());
    (t_lo - slack_lo).ceil() <= (t_hi + slack_hi).floor()
}

impl Interval {
    /// The empty interval (result of a domain error). Both bounds are NaN.
    pub const EMPTY: Interval = Interval {
        lo: f64::NAN,
        hi: f64::NAN,
    };
    /// The whole real line `[−∞, +∞]`.
    pub const ENTIRE: Interval = Interval {
        lo: f64::NEG_INFINITY,
        hi: f64::INFINITY,
    };

    /// `[lo, hi]`.
    ///
    /// # Panics
    /// If `lo > hi` or a bound is NaN. Use [`Interval::hull`] for unordered bounds.
    pub fn new(lo: f64, hi: f64) -> Self {
        assert!(
            lo <= hi,
            "Interval::new requires lo <= hi (got [{lo}, {hi}])"
        );
        Self { lo, hi }
    }

    /// The degenerate interval `[x, x]` (exact: `x` is a real number).
    #[inline]
    pub fn point(x: f64) -> Self {
        if x.is_nan() {
            Self::EMPTY
        } else {
            Self { lo: x, hi: x }
        }
    }

    /// The smallest interval containing both numbers (NaN-free inputs).
    pub fn hull(a: f64, b: f64) -> Self {
        if a.is_nan() || b.is_nan() {
            return Self::EMPTY;
        }
        Self {
            lo: math::min(a, b),
            hi: math::max(a, b),
        }
    }

    /// Build from possibly-NaN bounds produced by `∞ − ∞`: a NaN lower bound becomes
    /// `−∞` and a NaN upper bound `+∞` (conservative).
    #[inline]
    fn from_bounds(lo: f64, hi: f64) -> Self {
        let lo = if lo.is_nan() { f64::NEG_INFINITY } else { lo };
        let hi = if hi.is_nan() { f64::INFINITY } else { hi };
        Self { lo, hi }
    }

    /// Lower bound.
    #[inline]
    pub fn lo(self) -> f64 {
        self.lo
    }
    /// Upper bound.
    #[inline]
    pub fn hi(self) -> f64 {
        self.hi
    }
    /// `true` for [`Interval::EMPTY`].
    #[inline]
    pub fn is_empty(self) -> bool {
        self.lo.is_nan() || self.hi.is_nan()
    }
    /// `true` for a degenerate interval `[x, x]` with finite `x`.
    #[inline]
    pub fn is_point(self) -> bool {
        self.hi - self.lo == 0.0
    }
    /// Width `hi − lo` (rounded up), `NaN` for the empty interval.
    pub fn width(self) -> f64 {
        up(self.hi - self.lo)
    }
    /// Midpoint (finite whenever possible; `0` for the entire line).
    pub fn mid(self) -> f64 {
        if self.is_empty() {
            return f64::NAN;
        }
        match (self.lo.is_finite(), self.hi.is_finite()) {
            (true, true) => 0.5 * self.lo + 0.5 * self.hi,
            (true, false) => self.lo,
            (false, true) => self.hi,
            (false, false) => 0.0,
        }
    }
    /// Magnitude: the largest `|x|` in the interval.
    pub fn mag(self) -> f64 {
        math::max(self.lo.abs(), self.hi.abs())
    }
    /// `true` if the real number `x` lies in the interval.
    #[inline]
    pub fn contains(self, x: f64) -> bool {
        self.lo <= x && x <= self.hi
    }
    /// `true` if `other ⊆ self`.
    pub fn contains_interval(self, other: Interval) -> bool {
        self.lo <= other.lo && other.hi <= self.hi
    }
    /// `true` if 0 lies in the interval.
    #[inline]
    pub fn contains_zero(self) -> bool {
        self.contains(0.0)
    }
    /// Intersection (empty if disjoint).
    pub fn intersect(self, other: Interval) -> Interval {
        let lo = math::max(self.lo, other.lo);
        let hi = math::min(self.hi, other.hi);
        if self.is_empty() || other.is_empty() || lo > hi {
            Self::EMPTY
        } else {
            Self { lo, hi }
        }
    }
    /// Convex hull of two intervals.
    pub fn union_hull(self, other: Interval) -> Interval {
        if self.is_empty() {
            return other;
        }
        if other.is_empty() {
            return self;
        }
        Self {
            lo: math::min(self.lo, other.lo),
            hi: math::max(self.hi, other.hi),
        }
    }
    /// `true` if every point of `self` is `<` every point of `other`.
    #[inline]
    pub fn certainly_lt(self, other: Interval) -> bool {
        self.hi < other.lo
    }
    /// `true` if every point of `self` is `>` every point of `other`.
    #[inline]
    pub fn certainly_gt(self, other: Interval) -> bool {
        self.lo > other.hi
    }
    /// Division that reports a zero-containing divisor instead of returning
    /// [`Interval::ENTIRE`].
    pub fn checked_div(self, other: Interval) -> Option<Interval> {
        if other.contains_zero() || other.is_empty() {
            None
        } else {
            Some(self / other)
        }
    }

    /// Widen the result of a monotone libm evaluation.
    #[inline]
    fn libm_hull(a: f64, b: f64) -> Self {
        Self::from_bounds(
            down_n(math::min(a, b), LIBM_ULPS),
            up_n(math::max(a, b), LIBM_ULPS),
        )
    }

    /// `true` if the width is `>= w` (or NaN/infinite).
    fn at_least_as_wide_as(self, w: f64) -> bool {
        let d = self.hi - self.lo;
        d.is_nan() || d >= w
    }

    fn clamp_to(self, lo: f64, hi: f64) -> Self {
        Self {
            lo: math::max(self.lo, lo),
            hi: math::min(self.hi, hi),
        }
    }
}

/// Upper bound of π (π lies in `[PI, next_up(PI)]` because the `f64` PI is below π).
fn pi_hi() -> f64 {
    up(math::PI)
}

impl PartialEq for Interval {
    fn eq(&self, other: &Self) -> bool {
        self.lo == other.lo && self.hi == other.hi
    }
}

impl PartialOrd for Interval {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        if self == other {
            Some(Ordering::Equal)
        } else if self.hi < other.lo {
            Some(Ordering::Less)
        } else if self.lo > other.hi {
            Some(Ordering::Greater)
        } else {
            None
        }
    }
}

impl Add for Interval {
    type Output = Self;
    fn add(self, o: Self) -> Self {
        if self.is_empty() || o.is_empty() {
            return Self::EMPTY;
        }
        Self::from_bounds(down(self.lo + o.lo), up(self.hi + o.hi))
    }
}

impl Sub for Interval {
    type Output = Self;
    fn sub(self, o: Self) -> Self {
        if self.is_empty() || o.is_empty() {
            return Self::EMPTY;
        }
        Self::from_bounds(down(self.lo - o.hi), up(self.hi - o.lo))
    }
}

impl Mul for Interval {
    type Output = Self;
    fn mul(self, o: Self) -> Self {
        if self.is_empty() || o.is_empty() {
            return Self::EMPTY;
        }
        let p = [
            mul_bound(self.lo, o.lo),
            mul_bound(self.lo, o.hi),
            mul_bound(self.hi, o.lo),
            mul_bound(self.hi, o.hi),
        ];
        let (lo, hi) = (min4(p), max4(p));
        Self::from_bounds(down(lo), up(hi))
    }
}

impl Div for Interval {
    type Output = Self;
    fn div(self, o: Self) -> Self {
        if self.is_empty() || o.is_empty() {
            return Self::EMPTY;
        }
        if o.contains_zero() {
            return Self::ENTIRE;
        }
        // `math::min`/`max` ignore NaN corners (∞/∞); the remaining corners bound the set.
        let q = [
            self.lo / o.lo,
            self.lo / o.hi,
            self.hi / o.lo,
            self.hi / o.hi,
        ];
        let (lo, hi) = (min4(q), max4(q));
        Self::from_bounds(down(lo), up(hi))
    }
}

impl Neg for Interval {
    type Output = Self;
    #[inline]
    fn neg(self) -> Self {
        Self {
            lo: -self.hi,
            hi: -self.lo,
        }
    }
}

macro_rules! interval_assign {
    ($tr:ident, $f:ident, $op:tt) => {
        impl $tr for Interval {
            #[inline]
            fn $f(&mut self, o: Self) {
                *self = *self $op o;
            }
        }
    };
}
interval_assign!(AddAssign, add_assign, +);
interval_assign!(SubAssign, sub_assign, -);
interval_assign!(MulAssign, mul_assign, *);
interval_assign!(DivAssign, div_assign, /);

impl Scalar for Interval {
    #[inline]
    fn from_f64(x: f64) -> Self {
        Self::point(x)
    }
    #[inline]
    fn to_f64(self) -> f64 {
        self.mid()
    }
    fn pi() -> Self {
        Self {
            lo: math::PI,
            hi: pi_hi(),
        }
    }
    fn tau() -> Self {
        Self {
            lo: math::TAU,
            hi: up(math::TAU),
        }
    }
    fn frac_pi_2() -> Self {
        Self {
            lo: math::FRAC_PI_2,
            hi: up(math::FRAC_PI_2),
        }
    }
    fn abs(self) -> Self {
        if self.is_empty() {
            Self::EMPTY
        } else if self.lo >= 0.0 {
            self
        } else if self.hi <= 0.0 {
            -self
        } else {
            Self {
                lo: 0.0,
                hi: math::max(-self.lo, self.hi),
            }
        }
    }
    fn sqrt(self) -> Self {
        if self.is_empty() || self.hi < 0.0 {
            return Self::EMPTY;
        }
        let lo = if self.lo <= 0.0 {
            0.0
        } else {
            math::max(down(self.lo.sqrt()), 0.0)
        };
        Self {
            lo,
            hi: up(self.hi.sqrt()),
        }
    }
    fn square(self) -> Self {
        if self.is_empty() {
            return Self::EMPTY;
        }
        let (a, b) = (self.lo * self.lo, self.hi * self.hi);
        if self.lo >= 0.0 {
            Self {
                lo: math::max(down(a), 0.0),
                hi: up(b),
            }
        } else if self.hi <= 0.0 {
            Self {
                lo: math::max(down(b), 0.0),
                hi: up(a),
            }
        } else {
            Self {
                lo: 0.0,
                hi: up(math::max(a, b)),
            }
        }
    }
    fn powf(self, e: Self) -> Self {
        if self.is_empty() || e.is_empty() {
            return Self::EMPTY;
        }
        if self.lo > 0.0 {
            return (e * self.ln()).exp();
        }
        // Integral point exponent: well defined for negative bases.
        if e.is_point() && e.lo.fract() == 0.0 && e.lo.abs() < 2_147_483_648.0 {
            return self.powi(e.lo as i32);
        }
        if self.hi < 0.0 {
            return Self::EMPTY;
        }
        if e.lo > 0.0 {
            // x ∈ [0, h]: the minimum is 0, the maximum is at x = h.
            let top = (e * Self::point(self.hi).ln()).exp();
            if top.is_empty() {
                return Self {
                    lo: 0.0,
                    hi: f64::INFINITY,
                };
            }
            return Self {
                lo: 0.0,
                hi: math::max(top.hi, 0.0),
            };
        }
        Self::ENTIRE
    }
    fn sin(self) -> Self {
        if self.is_empty() {
            return Self::EMPTY;
        }
        if self.at_least_as_wide_as(math::TAU) {
            return Self::new(-1.0, 1.0);
        }
        let mut r = Self::libm_hull(math::sin(self.lo), math::sin(self.hi));
        if may_contain_lattice_point(self.lo, self.hi, math::FRAC_PI_2, math::TAU) {
            r.hi = 1.0;
        }
        if may_contain_lattice_point(self.lo, self.hi, -math::FRAC_PI_2, math::TAU) {
            r.lo = -1.0;
        }
        r.clamp_to(-1.0, 1.0)
    }
    fn cos(self) -> Self {
        if self.is_empty() {
            return Self::EMPTY;
        }
        if self.at_least_as_wide_as(math::TAU) {
            return Self::new(-1.0, 1.0);
        }
        let mut r = Self::libm_hull(math::cos(self.lo), math::cos(self.hi));
        if may_contain_lattice_point(self.lo, self.hi, 0.0, math::TAU) {
            r.hi = 1.0;
        }
        if may_contain_lattice_point(self.lo, self.hi, math::PI, math::TAU) {
            r.lo = -1.0;
        }
        r.clamp_to(-1.0, 1.0)
    }
    fn tan(self) -> Self {
        if self.is_empty() {
            return Self::EMPTY;
        }
        if self.at_least_as_wide_as(math::PI)
            || may_contain_lattice_point(self.lo, self.hi, math::FRAC_PI_2, math::PI)
        {
            return Self::ENTIRE;
        }
        Self::libm_hull(math::tan(self.lo), math::tan(self.hi))
    }
    fn asin(self) -> Self {
        let x = self.intersect(Self { lo: -1.0, hi: 1.0 });
        if x.is_empty() {
            return Self::EMPTY;
        }
        let h = up(math::FRAC_PI_2);
        Self::libm_hull(math::asin(x.lo), math::asin(x.hi)).clamp_to(-h, h)
    }
    fn acos(self) -> Self {
        let x = self.intersect(Self { lo: -1.0, hi: 1.0 });
        if x.is_empty() {
            return Self::EMPTY;
        }
        Self::libm_hull(math::acos(x.hi), math::acos(x.lo)).clamp_to(0.0, pi_hi())
    }
    fn atan(self) -> Self {
        if self.is_empty() {
            return Self::EMPTY;
        }
        let h = up(math::FRAC_PI_2);
        Self::libm_hull(math::atan(self.lo), math::atan(self.hi)).clamp_to(-h, h)
    }
    fn atan2(self, x: Self) -> Self {
        let y = self;
        if y.is_empty() || x.is_empty() {
            return Self::EMPTY;
        }
        let p = pi_hi();
        // Box touching the branch cut (negative x axis) or the origin: full range.
        if x.lo <= 0.0 && y.contains_zero() {
            return Self { lo: -p, hi: p };
        }
        // Otherwise atan2 is continuous on the box and its extremes are at corners.
        let c = [
            math::atan2(y.lo, x.lo),
            math::atan2(y.lo, x.hi),
            math::atan2(y.hi, x.lo),
            math::atan2(y.hi, x.hi),
        ];
        let (lo, hi) = (min4(c), max4(c));
        Self::libm_hull(lo, hi).clamp_to(-p, p)
    }
    fn exp(self) -> Self {
        if self.is_empty() {
            return Self::EMPTY;
        }
        let r = Self::libm_hull(math::exp(self.lo), math::exp(self.hi));
        Self {
            lo: math::max(r.lo, 0.0),
            hi: r.hi,
        }
    }
    fn ln(self) -> Self {
        if self.is_empty() || self.hi <= 0.0 {
            return Self::EMPTY;
        }
        let lo = if self.lo <= 0.0 {
            f64::NEG_INFINITY
        } else {
            down_n(math::ln(self.lo), LIBM_ULPS)
        };
        Self {
            lo,
            hi: up_n(math::ln(self.hi), LIBM_ULPS),
        }
    }
    fn min(self, other: Self) -> Self {
        if self.is_empty() || other.is_empty() {
            return Self::EMPTY;
        }
        Self {
            lo: math::min(self.lo, other.lo),
            hi: math::min(self.hi, other.hi),
        }
    }
    fn max(self, other: Self) -> Self {
        if self.is_empty() || other.is_empty() {
            return Self::EMPTY;
        }
        Self {
            lo: math::max(self.lo, other.lo),
            hi: math::max(self.hi, other.hi),
        }
    }
    fn is_finite(self) -> bool {
        self.lo.is_finite() && self.hi.is_finite()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_enclosure_contains_true_pi() {
        // π = 3.14159265358979323846…; the f64 PI is 3.141592653589793115997…
        let p = Interval::pi();
        assert!(p.lo() < p.hi());
        assert!(p.contains(math::PI));
    }

    #[test]
    fn division_by_zero_containing_interval_is_entire() {
        let a = Interval::new(1.0, 2.0);
        let b = Interval::new(-1.0, 1.0);
        assert!((a / b).lo().is_infinite() && (a / b).hi().is_infinite());
        assert!(a.checked_div(b).is_none());
        assert!(a.checked_div(Interval::new(2.0, 4.0)).is_some());
    }

    #[test]
    fn domain_errors_are_empty_and_propagate() {
        let neg = Interval::new(-3.0, -1.0);
        assert!(neg.sqrt().is_empty());
        assert!((neg.sqrt() + Interval::point(1.0)).is_empty());
        assert!(Interval::new(2.0, 3.0).acos().is_empty());
        assert!(neg.ln().is_empty());
    }

    #[test]
    fn square_of_zero_containing_interval_is_nonnegative() {
        let s = Interval::new(-2.0, 1.0).square();
        assert!(s.lo() >= 0.0 && s.contains(4.0));
    }

    #[test]
    fn sin_includes_interior_extrema() {
        let s = Interval::new(1.0, 2.0).sin(); // contains π/2
        assert!(s.hi() >= 1.0);
        let c = Interval::new(3.0, 3.5).cos(); // contains π
        assert!(c.lo() <= -1.0);
        let wide = Interval::new(0.0, 100.0).sin();
        assert!(wide.contains(-1.0) && wide.contains(1.0));
    }

    #[test]
    fn atan2_across_branch_cut_is_full_range() {
        let r = Interval::new(-1.0, 1.0).atan2(Interval::new(-2.0, -1.0));
        assert!(r.contains(math::PI) && r.contains(-math::PI));
        let q = Interval::new(1.0, 2.0).atan2(Interval::new(1.0, 2.0));
        assert!(q.contains(math::FRAC_PI_4) && q.lo() > 0.0 && q.hi() < math::FRAC_PI_2);
    }

    #[test]
    fn certain_comparisons() {
        let a = Interval::new(0.0, 1.0);
        let b = Interval::new(2.0, 3.0);
        let c = Interval::new(0.5, 2.5);
        assert!(a < b);
        assert!(b > a);
        assert!(a.partial_cmp(&c).is_none());
        assert!(a == Interval::new(0.0, 1.0));
    }
}
