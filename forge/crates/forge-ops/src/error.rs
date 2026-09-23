//! Structured operation errors.

use forge_core::geom::GeomError;
use forge_core::topo::TopoError;
use thiserror::Error;

/// Which end of a sketch curve.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CurveEnd {
    /// The curve's `start`.
    Start,
    /// The curve's `end`.
    End,
}

impl CurveEnd {
    /// `"start"` or `"end"` (the IR field names).
    pub fn as_str(self) -> &'static str {
        match self {
            CurveEnd::Start => "start",
            CurveEnd::End => "end",
        }
    }
}

impl std::fmt::Display for CurveEnd {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A modeling operation failed. Every variant has a stable machine-readable
/// [`OpError::code`]; semantic codes are the ones defined by the IR SPEC (`SKETCH_*`,
/// `REVOLVE_CROSSES_AXIS`, `DEPENDENCY_FAILED`, `INVALID_RESULT`, …), internal failures
/// use the `FORGE_` prefix. The fields carry the entities involved (curve ids, points,
/// feasible ranges) so the agent can build repair hints.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum OpError {
    /// SPEC §3.1 stage 1: a curve end coincides with no other curve end.
    #[error("the {end} of curve {curve:?} at ({}, {}) meets no other curve end", point[0], point[1])]
    SketchOpenLoop {
        /// Curve id.
        curve: String,
        /// Which end.
        end: CurveEnd,
        /// The end point (sketch coordinates).
        point: [f64; 2],
    },
    /// SPEC §3.1 stage 1: a curve end coincides with two or more other curve ends.
    #[error(
        "the {end} of curve {curve:?} at ({}, {}) meets {} other curve ends ({}); exactly one is required",
        point[0], point[1], partners.len(), partners.join(", ")
    )]
    SketchBranching {
        /// Curve id.
        curve: String,
        /// Which end.
        end: CurveEnd,
        /// The end point (sketch coordinates).
        point: [f64; 2],
        /// Ids of the curves whose ends coincide with it (`"id:start"` / `"id:end"`).
        partners: Vec<String>,
    },
    /// SPEC §3.1 stage 2: two curves meet other than at a shared endpoint.
    #[error("curves {first:?} and {second:?} {}", match point {
        Some(p) => format!("meet at ({}, {}), not at a shared endpoint", p[0], p[1]),
        None => "overlap along a stretch longer than the tolerance".to_string(),
    })]
    SketchCurvesCross {
        /// The earlier curve (sketch order).
        first: String,
        /// The later curve.
        second: String,
        /// Where they meet (`None` for an overlap).
        point: Option<[f64; 2]>,
    },
    /// SPEC §3.1 stage 3: a loop encloses (almost) no area.
    #[error("loop ({}) encloses zero area ({area:e} mm²)", curves.join(", "))]
    SketchDegenerateLoop {
        /// Curve ids of the loop, in loop order.
        curves: Vec<String>,
        /// The enclosed area.
        area: f64,
    },
    /// SPEC §3.1 stage 4: the sketch yields no region.
    #[error("the sketch yields no regions")]
    SketchNoRegions,
    /// SPEC §4: the feature references a suppressed sketch.
    #[error("sketch {sketch:?} is suppressed")]
    SketchSuppressed {
        /// Name of the sketch feature.
        sketch: String,
    },
    /// SPEC §4 [R-1]: the feature references a sketch that failed.
    #[error("sketch {sketch:?} failed with {code}: {message}")]
    DependencyFailed {
        /// Name of the failed sketch feature.
        sketch: String,
        /// The sketch's error code.
        code: String,
        /// The sketch's error message.
        message: String,
    },
    /// The feature references a sketch that does not exist (structurally invalid input;
    /// `forge_ir::validate` rejects such documents).
    #[error("sketch {sketch:?} is not an earlier sketch of this part studio")]
    UnresolvedSketch {
        /// The referenced name.
        sketch: String,
    },
    /// SPEC §4.3 [R-7]: a region has points strictly on both sides of the revolve axis.
    #[error(
        "region {outer_curves:?} has points on both sides of the revolve axis (signed distance range [{min}, {max}] mm, tolerance {tolerance} mm)"
    )]
    RevolveCrossesAxis {
        /// The region's name (sorted outer curve ids).
        outer_curves: Vec<String>,
        /// Smallest signed distance from the axis (negative = right of the axis).
        min: f64,
        /// Largest signed distance from the axis.
        max: f64,
        /// The tolerance band around the axis.
        tolerance: f64,
    },
    /// A numeric input is outside its valid range (structurally invalid input).
    #[error("invalid {what} = {value}: must be {expected}")]
    InvalidParameter {
        /// Parameter name.
        what: &'static str,
        /// The rejected value.
        value: f64,
        /// Human-readable valid range.
        expected: &'static str,
    },
    /// The sketch plane frame is degenerate.
    #[error("invalid sketch plane: {reason}")]
    InvalidPlane {
        /// Why.
        reason: String,
    },
    /// A sketch curve id cannot be used in provenance names (it contains one of
    /// `forge_core::topo::RESERVED_NAME_CHARS`).
    #[error(
        "curve id {curve:?} contains a character reserved by provenance names (one of / : {{ }} | + #)"
    )]
    InvalidCurveId {
        /// The offending id.
        curve: String,
    },
    /// SPEC §4 [R-12]: the produced body failed Forge's validity check.
    #[error("the produced body is invalid: {}", issues.join("; "))]
    InvalidResult {
        /// The validation findings (`[CODE] entity: message`).
        issues: Vec<String>,
    },
    /// An internal geometry construction failed (a Forge bug, never a user error).
    #[error("internal geometry error ({code}): {0}", code = .0.code())]
    Geometry(#[from] GeomError),
    /// An internal topology construction failed (a Forge bug, never a user error).
    #[error("internal topology error ({code}): {0}", code = .0.code())]
    Topology(#[from] TopoError),
    /// Any other internal failure.
    #[error("internal error: {0}")]
    Internal(String),
}

impl OpError {
    /// Stable machine-readable code. Semantic codes follow the IR SPEC; internal failures
    /// are engine-prefixed (`FORGE_INTERNAL`) as SPEC §4 [R-12] requires.
    pub fn code(&self) -> &'static str {
        match self {
            OpError::SketchOpenLoop { .. } => "SKETCH_OPEN_LOOP",
            OpError::SketchBranching { .. } => "SKETCH_BRANCHING",
            OpError::SketchCurvesCross { .. } => "SKETCH_CURVES_CROSS",
            OpError::SketchDegenerateLoop { .. } => "SKETCH_DEGENERATE_LOOP",
            OpError::SketchNoRegions => "SKETCH_NO_REGIONS",
            OpError::SketchSuppressed { .. } => "SKETCH_SUPPRESSED",
            OpError::DependencyFailed { .. } => "DEPENDENCY_FAILED",
            OpError::UnresolvedSketch { .. } => "UNRESOLVED_SKETCH",
            OpError::RevolveCrossesAxis { .. } => "REVOLVE_CROSSES_AXIS",
            OpError::InvalidParameter { .. } => "INVALID_PARAMETER",
            OpError::InvalidPlane { .. } => "INVALID_PLANE",
            OpError::InvalidCurveId { .. } => "FORGE_INVALID_CURVE_ID",
            OpError::InvalidResult { .. } => "INVALID_RESULT",
            OpError::Geometry(_) | OpError::Topology(_) | OpError::Internal(_) => "FORGE_INTERNAL",
        }
    }
}
