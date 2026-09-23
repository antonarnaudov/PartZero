//! Structured tessellation errors.

use thiserror::Error;

use crate::cdt::CdtError;

/// Why tessellation failed. Every variant has a stable [`MeshError::code`] and names the
/// entity involved by its **provenance name** (ids never leave the kernel).
#[derive(Clone, Debug, PartialEq, Error)]
pub enum MeshError {
    /// A tessellation parameter is out of range.
    #[error("invalid tessellation parameter {what} = {value} (expected {expected})")]
    InvalidParams {
        /// Parameter name.
        what: &'static str,
        /// The rejected value.
        value: f64,
        /// What is accepted.
        expected: &'static str,
    },
    /// The body references a missing entity (stale id); run `forge_core::validate`.
    #[error("body is structurally invalid: {detail}")]
    InvalidBody {
        /// What is wrong.
        detail: String,
    },
    /// A loop does not close in the face's parameter space (inconsistent pcurves or a
    /// winding that does not match the surface's periodicity).
    #[error("loop {loop_index} of face {face} does not close in parameter space (gap {gap:e})")]
    LoopNotClosed {
        /// Face provenance name.
        face: String,
        /// Index of the loop in the face.
        loop_index: usize,
        /// Parameter-space gap.
        gap: f64,
    },
    /// The face's loops do not describe a supported region of its surface (e.g. no or
    /// several outer loops, loops winding more than once around a periodic direction).
    #[error("face {face}: unsupported boundary configuration: {reason}")]
    InvalidLoops {
        /// Face provenance name.
        face: String,
        /// Explanation.
        reason: String,
    },
    /// The face would be unbounded (e.g. a cylinder face bounded by a single ring).
    #[error("face {face} is unbounded on its {surface} surface")]
    UnboundedFace {
        /// Face provenance name.
        face: String,
        /// Surface kind.
        surface: &'static str,
    },
    /// No internal cut could be placed to unwrap a periodic face domain.
    #[error("face {face}: could not place a tessellation cut across its periodic domain")]
    PeriodicCutNotFound {
        /// Face provenance name.
        face: String,
    },
    /// The face's parameter-space boundary could not be triangulated (self-touching or
    /// crossing loops, duplicate boundary points, …).
    #[error("face {face}: triangulation failed: {source}")]
    Triangulation {
        /// Face provenance name.
        face: String,
        /// The underlying CDT error (with its own code).
        source: CdtError,
    },
    /// A boundary point lies exactly on another boundary segment of the same face
    /// (loops touch in parameter space).
    #[error("face {face}: loops touch in parameter space")]
    BoundaryTouch {
        /// Face provenance name.
        face: String,
    },
    /// Refinement did not reach the requested deflection within the point budget.
    #[error(
        "face {face}: refinement stopped after {points} points with estimated deviation {deviation:e} (requested {requested:e})"
    )]
    RefinementLimit {
        /// Face provenance name.
        face: String,
        /// Points inserted.
        points: usize,
        /// Worst estimated deviation still present.
        deviation: f64,
        /// Requested chordal deflection.
        requested: f64,
    },
    /// Edge discretization did not converge within the sample budget.
    #[error("edge {edge}: discretization did not converge after {samples} samples")]
    EdgeRefinementLimit {
        /// Edge provenance name.
        edge: String,
        /// Samples produced.
        samples: usize,
    },
    /// A non-finite value reached the output.
    #[error("non-finite value produced for {entity}")]
    NonFinite {
        /// Entity name.
        entity: String,
    },
    /// An internal invariant of the mesher failed (a bug; reported instead of emitting a
    /// wrong mesh).
    #[error("face {face}: internal tessellation invariant failed: {detail}")]
    Internal {
        /// Face provenance name.
        face: String,
        /// What failed.
        detail: &'static str,
    },
}

impl MeshError {
    /// Stable machine-readable code.
    pub fn code(&self) -> &'static str {
        match self {
            MeshError::InvalidParams { .. } => "MESH_INVALID_PARAMS",
            MeshError::InvalidBody { .. } => "MESH_INVALID_BODY",
            MeshError::LoopNotClosed { .. } => "MESH_LOOP_NOT_CLOSED",
            MeshError::InvalidLoops { .. } => "MESH_INVALID_LOOPS",
            MeshError::UnboundedFace { .. } => "MESH_UNBOUNDED_FACE",
            MeshError::PeriodicCutNotFound { .. } => "MESH_PERIODIC_CUT_NOT_FOUND",
            MeshError::Triangulation { .. } => "MESH_TRIANGULATION",
            MeshError::BoundaryTouch { .. } => "MESH_BOUNDARY_TOUCH",
            MeshError::RefinementLimit { .. } => "MESH_REFINEMENT_LIMIT",
            MeshError::EdgeRefinementLimit { .. } => "MESH_EDGE_REFINEMENT_LIMIT",
            MeshError::NonFinite { .. } => "MESH_NON_FINITE",
            MeshError::Internal { .. } => "MESH_INTERNAL",
        }
    }
}
