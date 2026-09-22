//! 3×3 matrices.

use core::ops::Mul;

use super::Vec3;
use crate::scalar::Scalar;

/// A 3×3 matrix stored as three rows. `m · v` is `(rows[0]·v, rows[1]·v, rows[2]·v)`.
///
/// For a rotation matrix the **columns** are the images of the world axes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat3<S: Scalar = f64> {
    /// The rows of the matrix.
    pub rows: [Vec3<S>; 3],
}

impl<S: Scalar> Mat3<S> {
    /// Build from rows.
    #[inline]
    pub fn from_rows(r0: Vec3<S>, r1: Vec3<S>, r2: Vec3<S>) -> Self {
        Self { rows: [r0, r1, r2] }
    }
    /// Build from columns.
    #[inline]
    pub fn from_cols(c0: Vec3<S>, c1: Vec3<S>, c2: Vec3<S>) -> Self {
        Self::from_rows(c0, c1, c2).transpose()
    }
    /// The identity matrix.
    pub fn identity() -> Self {
        Self::from_rows(Vec3::unit_x(), Vec3::unit_y(), Vec3::unit_z())
    }
    /// The zero matrix.
    pub fn zero() -> Self {
        Self::from_rows(Vec3::zero(), Vec3::zero(), Vec3::zero())
    }
    /// Uniform scaling `s·I`.
    pub fn scale(s: S) -> Self {
        let z = S::zero();
        Self::from_rows(Vec3::new(s, z, z), Vec3::new(z, s, z), Vec3::new(z, z, s))
    }
    /// The skew-symmetric matrix `[k]×` with `[k]× v = k × v`.
    pub fn cross_matrix(k: Vec3<S>) -> Self {
        let z = S::zero();
        Self::from_rows(
            Vec3::new(z, -k.z, k.y),
            Vec3::new(k.z, z, -k.x),
            Vec3::new(-k.y, k.x, z),
        )
    }
    /// The outer product `a bᵀ`.
    pub fn outer(a: Vec3<S>, b: Vec3<S>) -> Self {
        Self::from_rows(b * a.x, b * a.y, b * a.z)
    }
    /// Rotation by `angle` (radians, right-hand rule) about the axis direction `axis`
    /// (need not be unit), by Rodrigues' formula
    /// `R = cos θ·I + sin θ·[k]× + (1 − cos θ)·k kᵀ`.
    ///
    /// Returns `None` if `axis` is zero or not finite.
    pub fn rotation(axis: Vec3<S>, angle: S) -> Option<Self> {
        let k = axis.normalize()?;
        let (s, c) = angle.sin_cos();
        Some(Self::rotation_from_sin_cos(k, s, c))
    }
    /// Rodrigues' rotation about the **unit** axis `k` given `sin θ` and `cos θ`
    /// (use with [`crate::math::sin_cos_deg`] for exact right angles).
    pub fn rotation_from_sin_cos(k: Vec3<S>, sin: S, cos: S) -> Self {
        Self::scale(cos) + Self::cross_matrix(k) * sin + Self::outer(k, k) * (S::one() - cos)
    }
    /// Element at `(row, col)`.
    ///
    /// # Panics
    /// If `row` or `col` ≥ 3.
    pub fn get(&self, row: usize, col: usize) -> S {
        let r = self.rows[row];
        match col {
            0 => r.x,
            1 => r.y,
            2 => r.z,
            _ => panic!("Mat3 column index {col} out of range"),
        }
    }
    /// Column `i` (0..3).
    ///
    /// # Panics
    /// If `i` ≥ 3.
    pub fn col(&self, i: usize) -> Vec3<S> {
        Vec3::new(self.get(0, i), self.get(1, i), self.get(2, i))
    }
    /// Transpose.
    pub fn transpose(&self) -> Self {
        let [a, b, c] = self.rows;
        Self::from_rows(
            Vec3::new(a.x, b.x, c.x),
            Vec3::new(a.y, b.y, c.y),
            Vec3::new(a.z, b.z, c.z),
        )
    }
    /// Determinant (not robust; use [`crate::predicates::orient3d`] for sign decisions).
    pub fn determinant(&self) -> S {
        let [a, b, c] = self.rows;
        a.dot(b.cross(c))
    }
    /// Inverse by the adjugate, or `None` if the determinant is zero or non-finite.
    pub fn inverse(&self) -> Option<Self> {
        let [a, b, c] = self.rows;
        let det = a.dot(b.cross(c));
        if det == S::zero() || !det.is_finite() {
            return None;
        }
        // Columns of the inverse are the cross products of the rows divided by det.
        let inv = Self::from_cols(b.cross(c), c.cross(a), a.cross(b));
        Some(inv * (S::one() / det))
    }
    /// Matrix–vector product.
    #[inline]
    pub fn mul_vec(&self, v: Vec3<S>) -> Vec3<S> {
        Vec3::new(
            self.rows[0].dot(v),
            self.rows[1].dot(v),
            self.rows[2].dot(v),
        )
    }
    /// Matrix–matrix product `self · o`.
    pub fn mul_mat(&self, o: &Self) -> Self {
        let t = o.transpose();
        let row = |r: Vec3<S>| Vec3::new(r.dot(t.rows[0]), r.dot(t.rows[1]), r.dot(t.rows[2]));
        Self::from_rows(row(self.rows[0]), row(self.rows[1]), row(self.rows[2]))
    }
    /// Largest absolute deviation of `selfᵀ·self` from the identity (0 for an exact
    /// orthogonal matrix).
    pub fn orthonormality_error(&self) -> S {
        let p = self.transpose().mul_mat(self);
        let mut e = S::zero();
        for r in 0..3 {
            for c in 0..3 {
                let target = if r == c { S::one() } else { S::zero() };
                e = e.max((p.get(r, c) - target).abs());
            }
        }
        e
    }
    /// Convert the entries to another scalar type through `f64`.
    pub fn cast<T: Scalar>(&self) -> Mat3<T> {
        Mat3::from_rows(
            self.rows[0].cast(),
            self.rows[1].cast(),
            self.rows[2].cast(),
        )
    }
}

impl<S: Scalar> core::ops::Add for Mat3<S> {
    type Output = Self;
    fn add(self, o: Self) -> Self {
        Self::from_rows(
            self.rows[0] + o.rows[0],
            self.rows[1] + o.rows[1],
            self.rows[2] + o.rows[2],
        )
    }
}

impl<S: Scalar> Mul<S> for Mat3<S> {
    type Output = Self;
    fn mul(self, s: S) -> Self {
        Self::from_rows(self.rows[0] * s, self.rows[1] * s, self.rows[2] * s)
    }
}

impl<S: Scalar> Mul<Vec3<S>> for Mat3<S> {
    type Output = Vec3<S>;
    #[inline]
    fn mul(self, v: Vec3<S>) -> Vec3<S> {
        self.mul_vec(v)
    }
}

impl<S: Scalar> Mul for Mat3<S> {
    type Output = Self;
    fn mul(self, o: Self) -> Self {
        self.mul_mat(&o)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math;

    #[test]
    fn rotation_about_z_by_quarter_turn() {
        let r = Mat3::rotation(Vec3::unit_z(), math::FRAC_PI_2).expect("axis");
        let v = r * Vec3::unit_x();
        assert!((v - Vec3::unit_y()).norm() < 1e-15);
        assert!(r.orthonormality_error() < 1e-15);
        assert!((r.determinant() - 1.0).abs() < 1e-15);
    }

    #[test]
    fn inverse_times_matrix_is_identity() {
        let m = Mat3::from_rows(
            Vec3::new(2.0, 1.0, 0.0),
            Vec3::new(0.5, 3.0, 1.0),
            Vec3::new(0.0, -1.0, 4.0),
        );
        let p = m.inverse().expect("invertible") * m;
        for r in 0..3 {
            for c in 0..3 {
                let t = if r == c { 1.0 } else { 0.0 };
                assert!((p.get(r, c) - t).abs() < 1e-14);
            }
        }
        assert!(Mat3::<f64>::zero().inverse().is_none());
    }

    #[test]
    fn rotation_rejects_zero_axis() {
        assert!(Mat3::rotation(Vec3::<f64>::zero(), 1.0).is_none());
    }
}
