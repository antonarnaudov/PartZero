//! Rigid transformations.

use super::{Frame, Mat3, Point3, Vec3};
use crate::math;
use crate::scalar::Scalar;

/// A rigid motion `x ↦ R·x + t` (rotation `R`, translation `t`), with no scaling or
/// reflection.
///
/// The fields are private so the rotation stays a proper rotation: build transforms with
/// the constructors, [`Transform::compose`] and [`Transform::inverse`]. Points and
/// vectors are transformed by different methods: [`Transform::transform_point`] applies
/// the translation, [`Transform::transform_vector`] does not.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform<S: Scalar = f64> {
    rotation: Mat3<S>,
    translation: Vec3<S>,
}

impl<S: Scalar> Transform<S> {
    /// The identity motion.
    pub fn identity() -> Self {
        Self {
            rotation: Mat3::identity(),
            translation: Vec3::zero(),
        }
    }
    /// A pure translation by `t`.
    pub fn translation(t: Vec3<S>) -> Self {
        Self {
            rotation: Mat3::identity(),
            translation: t,
        }
    }
    /// Rotation by `angle` radians (right-hand rule) about the line through `origin`
    /// with direction `axis` (Rodrigues' formula). `None` if `axis` is zero.
    pub fn rotation_about_axis(origin: Point3<S>, axis: Vec3<S>, angle: S) -> Option<Self> {
        let r = Mat3::rotation(axis, angle)?;
        Some(Self::rotation_about_point(r, origin))
    }
    /// The motion `x ↦ R·(x − p) + p`.
    fn rotation_about_point(r: Mat3<S>, p: Point3<S>) -> Self {
        Self {
            rotation: r,
            translation: p - r.mul_vec(p),
        }
    }
    /// Build from a rotation matrix and a translation, checking that the matrix is a
    /// proper rotation within `tol` (max deviation of `RᵀR` from `I`, and `det > 0`).
    pub fn try_from_parts(rotation: Mat3<S>, translation: Vec3<S>, tol: f64) -> Option<Self> {
        let err = rotation.orthonormality_error().to_f64();
        let det = rotation.determinant().to_f64();
        if err <= tol && det > 0.0 && translation.is_finite() {
            Some(Self {
                rotation,
                translation,
            })
        } else {
            None
        }
    }
    /// The motion that maps frame-local coordinates to world coordinates.
    pub fn from_frame(frame: &Frame<S>) -> Self {
        Self {
            rotation: Mat3::from_cols(frame.x(), frame.y(), frame.z()),
            translation: frame.origin(),
        }
    }
    /// The rotation part.
    #[inline]
    pub fn rotation(&self) -> &Mat3<S> {
        &self.rotation
    }
    /// The translation part.
    #[inline]
    pub fn translation_part(&self) -> Vec3<S> {
        self.translation
    }
    /// `self ∘ other`: apply `other` first, then `self`.
    pub fn compose(&self, other: &Self) -> Self {
        Self {
            rotation: self.rotation.mul_mat(&other.rotation),
            translation: self.rotation.mul_vec(other.translation) + self.translation,
        }
    }
    /// `next ∘ self`: apply `self` first, then `next`.
    pub fn then(&self, next: &Self) -> Self {
        next.compose(self)
    }
    /// The inverse motion (`Rᵀ`, `−Rᵀ·t`), exact up to rounding because `R` is
    /// orthogonal.
    pub fn inverse(&self) -> Self {
        let rt = self.rotation.transpose();
        Self {
            rotation: rt,
            translation: -rt.mul_vec(self.translation),
        }
    }
    /// Apply to a point (rotation and translation).
    #[inline]
    pub fn transform_point(&self, p: Point3<S>) -> Point3<S> {
        self.rotation.mul_vec(p) + self.translation
    }
    /// Apply to a free vector or direction (rotation only).
    #[inline]
    pub fn transform_vector(&self, v: Vec3<S>) -> Vec3<S> {
        self.rotation.mul_vec(v)
    }
    /// Convert to another scalar type through `f64`.
    pub fn cast<T: Scalar>(&self) -> Transform<T> {
        Transform {
            rotation: self.rotation.cast(),
            translation: self.translation.cast(),
        }
    }
}

impl Transform<f64> {
    /// Rotation by `degrees` about the line through `origin` with direction `axis`.
    /// Multiples of 90° produce exact matrices (entries exactly 0 and ±1 for axis-aligned
    /// axes) thanks to [`math::sin_cos_deg`].
    pub fn rotation_about_axis_deg(origin: Point3, axis: Vec3, degrees: f64) -> Option<Self> {
        let k = axis.normalize()?;
        let (s, c) = math::sin_cos_deg(degrees);
        Some(Self::rotation_about_point(
            Mat3::rotation_from_sin_cos(k, s, c),
            origin,
        ))
    }
}

impl<S: Scalar> Default for Transform<S> {
    fn default() -> Self {
        Self::identity()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_about_offset_axis_keeps_axis_points_fixed() {
        let o = Vec3::new(1.0, 2.0, 3.0);
        let t = Transform::rotation_about_axis(o, Vec3::new(1.0, 1.0, 0.0), 0.7).expect("axis");
        let on_axis = o + Vec3::new(2.0, 2.0, 0.0);
        assert!(t.transform_point(on_axis).distance(on_axis) < 1e-14);
    }

    #[test]
    fn inverse_undoes_and_compose_orders_correctly() {
        let a = Transform::rotation_about_axis(Vec3::zero(), Vec3::unit_z(), 0.3).expect("axis");
        let b = Transform::translation(Vec3::new(5.0, 0.0, 0.0));
        let p = Vec3::new(1.0, -2.0, 0.5);
        let ab = a.compose(&b); // b first
        assert!(
            ab.transform_point(p)
                .distance(a.transform_point(b.transform_point(p)))
                < 1e-14
        );
        assert!(
            b.then(&a)
                .transform_point(p)
                .distance(ab.transform_point(p))
                < 1e-14
        );
        assert!(
            ab.inverse()
                .transform_point(ab.transform_point(p))
                .distance(p)
                < 1e-14
        );
    }

    #[test]
    fn degree_rotation_is_exact_at_right_angles() {
        let t =
            Transform::rotation_about_axis_deg(Vec3::zero(), Vec3::unit_z(), 90.0).expect("axis");
        let v = t.transform_vector(Vec3::unit_x());
        assert!((v.x).abs() == 0.0 && (v.y - 1.0).abs() == 0.0 && v.z.abs() == 0.0);
    }

    #[test]
    fn try_from_parts_rejects_scaling_and_reflection() {
        assert!(Transform::try_from_parts(Mat3::scale(2.0), Vec3::zero(), 1e-12).is_none());
        assert!(Transform::try_from_parts(Mat3::scale(-1.0), Vec3::zero(), 1e-12).is_none());
        assert!(Transform::try_from_parts(Mat3::<f64>::identity(), Vec3::zero(), 1e-12).is_some());
    }
}
