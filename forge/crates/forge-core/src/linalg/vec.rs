//! 2D and 3D vectors generic over [`Scalar`].

use core::ops::{Add, AddAssign, Div, Mul, MulAssign, Neg, Sub, SubAssign};

use crate::scalar::Scalar;

/// A 2D vector (or point, see [`Point2`]) with components of type `S`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vec2<S: Scalar = f64> {
    /// First component (`u` in parameter space).
    pub x: S,
    /// Second component (`v` in parameter space).
    pub y: S,
}

/// A 3D vector (or point, see [`Point3`]) with components of type `S`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vec3<S: Scalar = f64> {
    /// X component.
    pub x: S,
    /// Y component.
    pub y: S,
    /// Z component.
    pub z: S,
}

/// A 2D point. An alias of [`Vec2`]; see the [`linalg`](crate::linalg) module docs for
/// why points and vectors share one type.
pub type Point2<S = f64> = Vec2<S>;
/// A 3D point. An alias of [`Vec3`]; see the [`linalg`](crate::linalg) module docs for
/// why points and vectors share one type.
pub type Point3<S = f64> = Vec3<S>;

// ---------------------------------------------------------------------------------------
// Vec2
// ---------------------------------------------------------------------------------------

impl<S: Scalar> Vec2<S> {
    /// `(x, y)`.
    #[inline]
    pub fn new(x: S, y: S) -> Self {
        Self { x, y }
    }
    /// The zero vector / origin.
    #[inline]
    pub fn zero() -> Self {
        Self::new(S::zero(), S::zero())
    }
    /// Unit vector along +x.
    #[inline]
    pub fn unit_x() -> Self {
        Self::new(S::one(), S::zero())
    }
    /// Unit vector along +y.
    #[inline]
    pub fn unit_y() -> Self {
        Self::new(S::zero(), S::one())
    }
    /// Dot product.
    #[inline]
    pub fn dot(self, o: Self) -> S {
        self.x * o.x + self.y * o.y
    }
    /// 2D cross product (z component of the 3D cross product): `x·o.y − y·o.x`.
    ///
    /// Not a robust orientation test; use [`crate::predicates::orient2d`] for decisions.
    #[inline]
    pub fn perp_dot(self, o: Self) -> S {
        self.x * o.y - self.y * o.x
    }
    /// The vector rotated by +90° (`(−y, x)`).
    #[inline]
    pub fn perp(self) -> Self {
        Self::new(-self.y, self.x)
    }
    /// Squared Euclidean norm.
    #[inline]
    pub fn norm_squared(self) -> S {
        self.x.square() + self.y.square()
    }
    /// Euclidean norm.
    #[inline]
    pub fn norm(self) -> S {
        self.norm_squared().sqrt()
    }
    /// Distance between two points.
    #[inline]
    pub fn distance(self, o: Self) -> S {
        (self - o).norm()
    }
    /// The unit vector in this direction, or `None` for a zero or non-finite vector.
    pub fn normalize(self) -> Option<Self> {
        let n = self.norm();
        if n > S::zero() && n.is_finite() {
            return Some(self / n);
        }
        // Rescue underflow/overflow of the squared norm by pre-scaling.
        let m = self.x.abs().max(self.y.abs());
        if m > S::zero() && m.is_finite() {
            let s = self / m;
            let n = s.norm();
            if n > S::zero() && n.is_finite() {
                return Some(s / n);
            }
        }
        None
    }
    /// Linear interpolation `self + (o − self)·t`.
    #[inline]
    pub fn lerp(self, o: Self, t: S) -> Self {
        self + (o - self) * t
    }
    /// `true` if all components are finite.
    #[inline]
    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
    /// Convert the components to another scalar type through `f64`.
    #[inline]
    pub fn cast<T: Scalar>(self) -> Vec2<T> {
        Vec2::new(T::from_f64(self.x.to_f64()), T::from_f64(self.y.to_f64()))
    }
    /// Extend to 3D with the given z.
    #[inline]
    pub fn extend(self, z: S) -> Vec3<S> {
        Vec3::new(self.x, self.y, z)
    }
}

impl Vec2<f64> {
    /// Lift an `f64` vector into any scalar type (exact injection).
    #[inline]
    pub fn lift<T: Scalar>(self) -> Vec2<T> {
        Vec2::new(T::from_f64(self.x), T::from_f64(self.y))
    }
    /// Components as an array.
    #[inline]
    pub fn to_array(self) -> [f64; 2] {
        [self.x, self.y]
    }
}

impl From<[f64; 2]> for Vec2<f64> {
    #[inline]
    fn from(a: [f64; 2]) -> Self {
        Self::new(a[0], a[1])
    }
}

impl From<Vec2<f64>> for [f64; 2] {
    #[inline]
    fn from(v: Vec2<f64>) -> Self {
        [v.x, v.y]
    }
}

impl<S: Scalar> Add for Vec2<S> {
    type Output = Self;
    #[inline]
    fn add(self, o: Self) -> Self {
        Self::new(self.x + o.x, self.y + o.y)
    }
}
impl<S: Scalar> Sub for Vec2<S> {
    type Output = Self;
    #[inline]
    fn sub(self, o: Self) -> Self {
        Self::new(self.x - o.x, self.y - o.y)
    }
}
impl<S: Scalar> Neg for Vec2<S> {
    type Output = Self;
    #[inline]
    fn neg(self) -> Self {
        Self::new(-self.x, -self.y)
    }
}
impl<S: Scalar> Mul<S> for Vec2<S> {
    type Output = Self;
    #[inline]
    fn mul(self, s: S) -> Self {
        Self::new(self.x * s, self.y * s)
    }
}
impl Mul<Vec2<f64>> for f64 {
    type Output = Vec2<f64>;
    #[inline]
    fn mul(self, v: Vec2<f64>) -> Vec2<f64> {
        v * self
    }
}
impl<S: Scalar> Div<S> for Vec2<S> {
    type Output = Self;
    #[inline]
    fn div(self, s: S) -> Self {
        Self::new(self.x / s, self.y / s)
    }
}
impl<S: Scalar> AddAssign for Vec2<S> {
    #[inline]
    fn add_assign(&mut self, o: Self) {
        *self = *self + o;
    }
}
impl<S: Scalar> SubAssign for Vec2<S> {
    #[inline]
    fn sub_assign(&mut self, o: Self) {
        *self = *self - o;
    }
}
impl<S: Scalar> MulAssign<S> for Vec2<S> {
    #[inline]
    fn mul_assign(&mut self, s: S) {
        *self = *self * s;
    }
}

// ---------------------------------------------------------------------------------------
// Vec3
// ---------------------------------------------------------------------------------------

impl<S: Scalar> Vec3<S> {
    /// `(x, y, z)`.
    #[inline]
    pub fn new(x: S, y: S, z: S) -> Self {
        Self { x, y, z }
    }
    /// The zero vector / origin.
    #[inline]
    pub fn zero() -> Self {
        Self::new(S::zero(), S::zero(), S::zero())
    }
    /// Unit vector along +X.
    #[inline]
    pub fn unit_x() -> Self {
        Self::new(S::one(), S::zero(), S::zero())
    }
    /// Unit vector along +Y.
    #[inline]
    pub fn unit_y() -> Self {
        Self::new(S::zero(), S::one(), S::zero())
    }
    /// Unit vector along +Z.
    #[inline]
    pub fn unit_z() -> Self {
        Self::new(S::zero(), S::zero(), S::one())
    }
    /// Dot product.
    #[inline]
    pub fn dot(self, o: Self) -> S {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    /// Cross product (right-handed).
    #[inline]
    pub fn cross(self, o: Self) -> Self {
        Self::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }
    /// Squared Euclidean norm.
    #[inline]
    pub fn norm_squared(self) -> S {
        self.x.square() + self.y.square() + self.z.square()
    }
    /// Euclidean norm.
    #[inline]
    pub fn norm(self) -> S {
        self.norm_squared().sqrt()
    }
    /// Distance between two points.
    #[inline]
    pub fn distance(self, o: Self) -> S {
        (self - o).norm()
    }
    /// Squared distance between two points.
    #[inline]
    pub fn distance_squared(self, o: Self) -> S {
        (self - o).norm_squared()
    }
    /// The unit vector in this direction, or `None` for a zero or non-finite vector.
    ///
    /// Vectors whose squared norm under- or overflows are rescued by pre-scaling, so any
    /// finite non-zero vector normalizes.
    pub fn normalize(self) -> Option<Self> {
        let n = self.norm();
        if n > S::zero() && n.is_finite() {
            return Some(self / n);
        }
        let m = self.max_abs_component();
        if m > S::zero() && m.is_finite() {
            let s = self / m;
            let n = s.norm();
            if n > S::zero() && n.is_finite() {
                return Some(s / n);
            }
        }
        None
    }
    /// Largest absolute component.
    #[inline]
    pub fn max_abs_component(self) -> S {
        self.x.abs().max(self.y.abs()).max(self.z.abs())
    }
    /// Component-wise minimum.
    #[inline]
    pub fn min_components(self, o: Self) -> Self {
        Self::new(self.x.min(o.x), self.y.min(o.y), self.z.min(o.z))
    }
    /// Component-wise maximum.
    #[inline]
    pub fn max_components(self, o: Self) -> Self {
        Self::new(self.x.max(o.x), self.y.max(o.y), self.z.max(o.z))
    }
    /// Linear interpolation `self + (o − self)·t`.
    #[inline]
    pub fn lerp(self, o: Self, t: S) -> Self {
        self + (o - self) * t
    }
    /// `true` if all components are finite.
    #[inline]
    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite()
    }
    /// A unit vector perpendicular to `self` (which should be non-zero), chosen
    /// deterministically: `self` is crossed with the world axis of its smallest absolute
    /// component. Returns `None` for a zero vector.
    pub fn any_perpendicular(self) -> Option<Self> {
        let (ax, ay, az) = (self.x.abs(), self.y.abs(), self.z.abs());
        let axis = if ax <= ay && ax <= az {
            Self::unit_x()
        } else if ay <= az {
            Self::unit_y()
        } else {
            Self::unit_z()
        };
        self.cross(axis).normalize()
    }
    /// Convert the components to another scalar type through `f64`.
    #[inline]
    pub fn cast<T: Scalar>(self) -> Vec3<T> {
        Vec3::new(
            T::from_f64(self.x.to_f64()),
            T::from_f64(self.y.to_f64()),
            T::from_f64(self.z.to_f64()),
        )
    }
    /// Drop the z component.
    #[inline]
    pub fn truncate(self) -> Vec2<S> {
        Vec2::new(self.x, self.y)
    }
}

impl Vec3<f64> {
    /// Lift an `f64` vector into any scalar type (exact injection).
    #[inline]
    pub fn lift<T: Scalar>(self) -> Vec3<T> {
        Vec3::new(
            T::from_f64(self.x),
            T::from_f64(self.y),
            T::from_f64(self.z),
        )
    }
    /// Components as an array (the IR's `P3`).
    #[inline]
    pub fn to_array(self) -> [f64; 3] {
        [self.x, self.y, self.z]
    }
}

impl From<[f64; 3]> for Vec3<f64> {
    #[inline]
    fn from(a: [f64; 3]) -> Self {
        Self::new(a[0], a[1], a[2])
    }
}

impl From<Vec3<f64>> for [f64; 3] {
    #[inline]
    fn from(v: Vec3<f64>) -> Self {
        [v.x, v.y, v.z]
    }
}

impl<S: Scalar> Add for Vec3<S> {
    type Output = Self;
    #[inline]
    fn add(self, o: Self) -> Self {
        Self::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}
impl<S: Scalar> Sub for Vec3<S> {
    type Output = Self;
    #[inline]
    fn sub(self, o: Self) -> Self {
        Self::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}
impl<S: Scalar> Neg for Vec3<S> {
    type Output = Self;
    #[inline]
    fn neg(self) -> Self {
        Self::new(-self.x, -self.y, -self.z)
    }
}
impl<S: Scalar> Mul<S> for Vec3<S> {
    type Output = Self;
    #[inline]
    fn mul(self, s: S) -> Self {
        Self::new(self.x * s, self.y * s, self.z * s)
    }
}
impl Mul<Vec3<f64>> for f64 {
    type Output = Vec3<f64>;
    #[inline]
    fn mul(self, v: Vec3<f64>) -> Vec3<f64> {
        v * self
    }
}
impl<S: Scalar> Div<S> for Vec3<S> {
    type Output = Self;
    #[inline]
    fn div(self, s: S) -> Self {
        Self::new(self.x / s, self.y / s, self.z / s)
    }
}
impl<S: Scalar> AddAssign for Vec3<S> {
    #[inline]
    fn add_assign(&mut self, o: Self) {
        *self = *self + o;
    }
}
impl<S: Scalar> SubAssign for Vec3<S> {
    #[inline]
    fn sub_assign(&mut self, o: Self) {
        *self = *self - o;
    }
}
impl<S: Scalar> MulAssign<S> for Vec3<S> {
    #[inline]
    fn mul_assign(&mut self, s: S) {
        *self = *self * s;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scalar::Interval;

    #[test]
    fn cross_is_right_handed() {
        let z = Vec3::<f64>::unit_x().cross(Vec3::unit_y());
        assert_eq!(z, Vec3::unit_z());
    }

    #[test]
    fn normalize_rejects_zero_and_rescues_tiny() {
        assert!(Vec3::<f64>::zero().normalize().is_none());
        assert!(Vec3::new(f64::NAN, 0.0, 0.0).normalize().is_none());
        let tiny = Vec3::new(1e-200, -1e-200, 0.0)
            .normalize()
            .expect("tiny normalizes");
        assert!((tiny.norm() - 1.0).abs() < 1e-15);
        let huge = Vec3::new(1e200, 1e200, 1e200)
            .normalize()
            .expect("huge normalizes");
        assert!((huge.norm() - 1.0).abs() < 1e-15);
        assert!(Vec2::<f64>::zero().normalize().is_none());
    }

    #[test]
    fn any_perpendicular_is_unit_and_orthogonal() {
        for v in [
            Vec3::new(0.0, 0.0, 1.0),
            Vec3::new(1.0, 2.0, 3.0),
            Vec3::new(-5.0, 0.1, 0.0),
        ] {
            let p = v.any_perpendicular().expect("non-zero");
            assert!(p.dot(v).abs() < 1e-14 && (p.norm() - 1.0).abs() < 1e-15);
        }
    }

    #[test]
    fn interval_norm_encloses_f64_norm() {
        let v = Vec3::new(0.1, 0.2, 0.3);
        let vi: Vec3<Interval> = v.lift();
        assert!(vi.norm().contains(v.norm()));
    }

    #[test]
    fn array_round_trip() {
        let v: Vec3 = [1.0, 2.0, 3.0].into();
        let a: [f64; 3] = v.into();
        assert_eq!(a.map(f64::to_bits), [1.0f64, 2.0, 3.0].map(f64::to_bits));
    }
}
