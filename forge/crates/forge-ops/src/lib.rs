//! # forge-ops — Forge modeling operations
//!
//! F0 scope (IR v0, `forge-ir/SPEC.md`):
//! - [`regions`]: planar sketch regions with the staged sketch checks (SPEC §3);
//! - [`extrude`]: a region swept along the sketch normal (SPEC §4.2, §4.4);
//! - [`revolve`]: a region swept about an in-plane axis (SPEC §4.3, §4.4).
//!
//! Every operation returns either a body that passed `forge_core::topo::validate` or a
//! structured [`OpError`] with a stable [`OpError::code`]. Bodies are seam-free
//! (ADR 0012): periodic faces are bounded by ring edges, cone apexes and sphere poles
//! are surface singularities. Every face, edge and vertex carries provenance; edges are
//! named after the two faces they join, vertices after the faces around them.
//!
//! # Tolerances
//! - Coincidence and degeneracy use the IR's `LINEAR_TOLERANCE` inclusively ([R-3]).
//! - Classification of revolve profile lines (parallel / perpendicular to the axis)
//!   uses the angular tolerance [`revolve::ANGULAR_TOLERANCE`] (1e-9 rad).
//! - Vertex tolerances grow only where the sketch data requires it (curve ends that meet
//!   within tolerance, arc ends off their carrier circle), explicitly, per vertex.

mod error;
mod extrude;
mod plan;
mod plane;
pub mod revolve;
pub mod sketch;

pub use error::{CurveEnd, OpError};
pub use extrude::extrude;
pub use plane::sketch_frame;
pub use revolve::{AxisSide, check_revolve_profile, revolve};
pub use sketch::{Junction, Loop, LoopCurve, LoopCurveGeom, Region, regions};
