//! Sketch plane frames (SPEC §2).

use forge_core::linalg::{Frame, Point2, Point3, Vec3};
use forge_ir::PlaneSpec;

use crate::error::OpError;

/// The orthonormal frame of a sketch plane: `x`, `y` span the sketch, `z` is the normal.
///
/// Uses the axes of [`PlaneSpec::resolve`] exactly (named planes, or an explicit frame
/// with `x` re-orthogonalised against the normal [R-14]).
pub fn sketch_frame(plane: &PlaneSpec) -> Result<Frame, OpError> {
    let (o, x, y, n) = plane.resolve();
    let (o, x, y, n) = (Vec3::from(o), Vec3::from(x), Vec3::from(y), Vec3::from(n));
    if let Some(f) = Frame::try_from_axes(o, x, y, n, 1e-12) {
        return Ok(f);
    }
    Frame::from_normal_x(o, n, x).ok_or_else(|| OpError::InvalidPlane {
        reason: format!("degenerate frame (normal {n:?}, x {x:?})"),
    })
}

/// A sketch point `(u, v)` lifted `z` along the plane normal.
pub(crate) fn lift(frame: &Frame, p: Point2, z: f64) -> Point3 {
    frame.to_world_point(Vec3::new(p.x, p.y, z))
}
