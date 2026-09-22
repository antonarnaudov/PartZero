//! Small fixed-size linear algebra, generic over [`Scalar`](crate::scalar::Scalar).
//!
//! - [`Vec2`], [`Vec3`]: vectors; [`Point2`], [`Point3`]: points.
//! - [`Mat3`]: 3×3 matrices (rows), Rodrigues rotations.
//! - [`Transform`]: rigid motions `x ↦ R·x + t`.
//! - [`Frame`]: right-handed orthonormal frames (origin + x, y, z axes).
//!
//! # Points and vectors share one type
//! [`Point3`] is a type alias of [`Vec3`] (likewise [`Point2`]/[`Vec2`]) rather than a
//! distinct newtype. Reasons:
//! - Geometry code constantly forms affine combinations of points (de Boor, Bézier,
//!   homogeneous NURBS coordinates, finite differences), which a point newtype makes
//!   noisy and would need a second set of generic operator impls over `Scalar`.
//! - The one place where the distinction really matters — translating a direction by
//!   mistake — is covered by separate, explicitly named methods:
//!   [`Transform::transform_point`] vs [`Transform::transform_vector`] and
//!   [`Frame::to_world_point`] vs [`Frame::to_world_vector`].
//! - The alias documents intent in signatures (`fn project(&self, p: Point3)`) at no cost.
//!
//! # Robustness
//! `perp_dot`, `cross` and `determinant` are plain floating-point expressions. Never use
//! their *sign* for a topological decision: use [`crate::predicates`].

mod frame;
mod mat3;
mod transform;
mod vec;

pub use frame::Frame;
pub use mat3::Mat3;
pub use transform::Transform;
pub use vec::{Point2, Point3, Vec2, Vec3};
