//! Right-handed orthonormal frames.

use super::{Point3, Transform, Vec3};
use crate::scalar::Scalar;

/// A right-handed orthonormal coordinate frame: an origin and unit axes `x`, `y`, `z`
/// with `z = x × y`.
///
/// Frames position every analytic curve and surface. The fields are private so the
/// orthonormality invariant cannot be broken; construct frames with
/// [`Frame::from_normal_x`], [`Frame::from_normal`] or [`Frame::world`], and move them
/// with [`Frame::transformed`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame<S: Scalar = f64> {
    origin: Point3<S>,
    x: Vec3<S>,
    y: Vec3<S>,
    z: Vec3<S>,
}

impl<S: Scalar> Frame<S> {
    /// The world frame (origin 0, axes X, Y, Z).
    pub fn world() -> Self {
        Self {
            origin: Vec3::zero(),
            x: Vec3::unit_x(),
            y: Vec3::unit_y(),
            z: Vec3::unit_z(),
        }
    }
    /// A frame with `z` along `normal` and `x` along the part of `x_dir` perpendicular to
    /// `normal` (Gram–Schmidt); `y = z × x`. Neither input needs to be unit length.
    ///
    /// Returns `None` if `normal` is zero or `x_dir` is parallel to it.
    pub fn from_normal_x(origin: Point3<S>, normal: Vec3<S>, x_dir: Vec3<S>) -> Option<Self> {
        let z = normal.normalize()?;
        let x = (x_dir - z * x_dir.dot(z)).normalize()?;
        let y = z.cross(x);
        Some(Self { origin, x, y, z })
    }
    /// A frame with `z` along `normal` and a deterministic `x` axis
    /// ([`Vec3::any_perpendicular`]). `None` if `normal` is zero.
    pub fn from_normal(origin: Point3<S>, normal: Vec3<S>) -> Option<Self> {
        let z = normal.normalize()?;
        let x = z.any_perpendicular()?;
        Some(Self {
            origin,
            x,
            y: z.cross(x),
            z,
        })
    }
    /// Build from explicit axes, checking that they are orthonormal and right-handed
    /// within `tol` (absolute, on dot products and norms).
    pub fn try_from_axes(
        origin: Point3<S>,
        x: Vec3<S>,
        y: Vec3<S>,
        z: Vec3<S>,
        tol: f64,
    ) -> Option<Self> {
        let checks = [
            x.dot(x).to_f64() - 1.0,
            y.dot(y).to_f64() - 1.0,
            z.dot(z).to_f64() - 1.0,
            x.dot(y).to_f64(),
            y.dot(z).to_f64(),
            z.dot(x).to_f64(),
            (x.cross(y) - z).norm().to_f64(),
        ];
        if checks.iter().all(|c| c.abs() <= tol) && origin.is_finite() {
            Some(Self { origin, x, y, z })
        } else {
            None
        }
    }
    /// Origin.
    #[inline]
    pub fn origin(&self) -> Point3<S> {
        self.origin
    }
    /// Unit x axis.
    #[inline]
    pub fn x(&self) -> Vec3<S> {
        self.x
    }
    /// Unit y axis.
    #[inline]
    pub fn y(&self) -> Vec3<S> {
        self.y
    }
    /// Unit z axis (the frame normal).
    #[inline]
    pub fn z(&self) -> Vec3<S> {
        self.z
    }
    /// The same axes at a different origin.
    pub fn with_origin(&self, origin: Point3<S>) -> Self {
        Self { origin, ..*self }
    }
    /// The frame turned upside down (rotated 180° about its x axis): `(x, −y, −z)`.
    pub fn reversed(&self) -> Self {
        Self {
            origin: self.origin,
            x: self.x,
            y: -self.y,
            z: -self.z,
        }
    }
    /// Local coordinates → world point: `origin + x·l.x + y·l.y + z·l.z`.
    #[inline]
    pub fn to_world_point(&self, l: Vec3<S>) -> Point3<S> {
        self.origin + self.to_world_vector(l)
    }
    /// Local components → world vector: `x·l.x + y·l.y + z·l.z`.
    #[inline]
    pub fn to_world_vector(&self, l: Vec3<S>) -> Vec3<S> {
        self.x * l.x + self.y * l.y + self.z * l.z
    }
    /// World point → local coordinates.
    #[inline]
    pub fn to_local_point(&self, p: Point3<S>) -> Vec3<S> {
        self.to_local_vector(p - self.origin)
    }
    /// World vector → local components.
    #[inline]
    pub fn to_local_vector(&self, v: Vec3<S>) -> Vec3<S> {
        Vec3::new(v.dot(self.x), v.dot(self.y), v.dot(self.z))
    }
    /// The frame moved by a rigid transform.
    pub fn transformed(&self, t: &Transform<S>) -> Self {
        Self {
            origin: t.transform_point(self.origin),
            x: t.transform_vector(self.x),
            y: t.transform_vector(self.y),
            z: t.transform_vector(self.z),
        }
    }
    /// The rigid motion mapping local coordinates to world coordinates.
    pub fn to_transform(&self) -> Transform<S> {
        Transform::from_frame(self)
    }
    /// Convert to another scalar type through `f64`.
    pub fn cast<T: Scalar>(&self) -> Frame<T> {
        Frame {
            origin: self.origin.cast(),
            x: self.x.cast(),
            y: self.y.cast(),
            z: self.z.cast(),
        }
    }
}

impl Frame<f64> {
    /// Local coordinates (any scalar type) → world point, lifting this `f64` frame.
    #[inline]
    pub fn eval_point<T: Scalar>(&self, l: Vec3<T>) -> Point3<T> {
        self.origin.lift::<T>() + self.eval_vector(l)
    }
    /// Local components (any scalar type) → world vector, lifting this `f64` frame.
    #[inline]
    pub fn eval_vector<T: Scalar>(&self, l: Vec3<T>) -> Vec3<T> {
        self.x.lift::<T>() * l.x + self.y.lift::<T>() * l.y + self.z.lift::<T>() * l.z
    }
}

impl<S: Scalar> Default for Frame<S> {
    fn default() -> Self {
        Self::world()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_normal_x_is_orthonormal_right_handed() {
        let f = Frame::from_normal_x(
            Vec3::new(1.0, 2.0, 3.0),
            Vec3::new(0.0, 0.0, 2.0),
            Vec3::new(1.0, 1.0, 0.5),
        )
        .expect("valid");
        assert!(Frame::try_from_axes(f.origin(), f.x(), f.y(), f.z(), 1e-15).is_some());
        assert!((f.z() - Vec3::unit_z()).norm() == 0.0);
    }

    #[test]
    fn local_world_round_trip() {
        let f = Frame::from_normal(Vec3::new(-1.0, 0.5, 2.0), Vec3::new(1.0, -2.0, 0.3))
            .expect("valid");
        let p = Vec3::new(3.0, 4.0, -5.0);
        assert!(f.to_world_point(f.to_local_point(p)).distance(p) < 1e-14);
        let t = f.to_transform();
        assert!(
            t.transform_point(Vec3::new(1.0, 2.0, 3.0))
                .distance(f.to_world_point(Vec3::new(1.0, 2.0, 3.0)))
                < 1e-14
        );
    }

    #[test]
    fn degenerate_inputs_are_rejected() {
        assert!(Frame::from_normal_x(Vec3::<f64>::zero(), Vec3::zero(), Vec3::unit_x()).is_none());
        assert!(
            Frame::from_normal_x(
                Vec3::<f64>::zero(),
                Vec3::unit_z(),
                Vec3::new(0.0, 0.0, 5.0)
            )
            .is_none()
        );
        assert!(Frame::<f64>::from_normal(Vec3::zero(), Vec3::zero()).is_none());
    }

    #[test]
    fn reversed_frame_stays_right_handed() {
        let f = Frame::<f64>::world().reversed();
        assert!((f.x().cross(f.y()) - f.z()).norm() == 0.0);
    }
}
