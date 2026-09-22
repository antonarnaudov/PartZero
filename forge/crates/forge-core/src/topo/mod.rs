//! Half-edge boundary representation with native provenance.
//!
//! # Data model
//! A [`Body`] owns all its entities in [arenas](crate::arena) and addresses them by typed
//! generational ids ([`FaceId`], [`EdgeId`], …). There are no pointer graphs: references
//! are ids, and every forward reference has a back-reference maintained by the
//! [`BodyBuilder`].
//!
//! ```text
//! Body ─▶ Shell* ─▶ Face* ─▶ Loop* (first = outer) ─▶ Coedge* (ordered, closed)
//!                     │                                  │ edge, forward, pcurve
//!                  Surface                               ▼
//!                                   Edge (Curve3, t_range, start/end vertex, coedges)
//!                                                        ▼
//!                                                     Vertex (point)
//! ```
//!
//! # Mandatory modelling decisions
//! - **No seam edges.** Periodic surfaces are handled natively in the face's parameter
//!   domain. A cylinder side face is bounded by its two circles only.
//! - **Ring edges** (closed curves with no vertices) are allowed, e.g. the circles of an
//!   extruded cylinder. A ring loop is a single coedge on a ring edge.
//! - **Singularities are not edges.** Cone apexes and sphere poles are singular points
//!   of the surface, not degenerate edges; a full-revolution cone face is bounded only by
//!   its base ring, and a full sphere face has no loops at all.
//! - Consequently the metrics' edge count needs no seam/degenerate filtering.
//!
//! # Ownership of geometry
//! Faces own their [`Surface`](crate::geom::Surface) and edges own their
//! [`Curve3`](crate::geom::Curve3) directly (no separate geometry arena): bodies stay
//! self-contained and trivially cloneable, and there are no dangling geometry ids. If
//! sharing becomes important (large B-spline data), the heavy variants can hold an `Arc`
//! internally without changing this API.
//!
//! # Identity
//! Ids are process-local and body-local. Anything persisted uses
//! [`Provenance::name`], which every face, edge and vertex carries.
//!
//! # Checking
//! [`validate`] reports structured [`TopoIssue`]s with stable codes; see its docs for
//! the full list of checks and [`euler_summary`] for the Euler–Poincaré adaptation to
//! ring edges. [`samples`] contains hand-built reference bodies.

mod builder;
mod entities;
mod provenance;
pub mod samples;
mod validate;

pub use builder::{BodyBuilder, TopoError};
pub use entities::{
    Body, Coedge, CoedgeId, Edge, EdgeId, Face, FaceId, Loop, LoopId, Shell, ShellId, TopoCounts,
    Vertex, VertexId,
};
pub use provenance::{Provenance, RESERVED_NAME_CHARS, Role};
pub use validate::{
    EntityRef, EulerSummary, IssueCode, Severity, TopoIssue, ValidateOptions, euler_summary,
    has_errors, validate, validate_with,
};
