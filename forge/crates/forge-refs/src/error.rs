//! Structured errors of reference evaluation (SPEC-v1 §7.4): every error has a stable code
//! from the catalogue (`forge_ir::v1::codes`) and a `details` object with exactly the keys the
//! catalogue lists for that code. Engine-internal failures use the `FORGE_` prefix (v0 R-12).

use serde_json::{Map, Value, json};

/// Why a query, plane, axis or point could not be evaluated. Reference *resolution* outcomes
/// (`REF_*`) are not errors of this type: they are [`crate::Resolution`]s.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum RefError {
    /// A named source refers to a feature that failed in this evaluation (§5.7 step 1).
    #[error("feature {feature:?} failed ({code}): {message}")]
    DependencyFailed {
        /// Feature id.
        feature: String,
        /// Its error code.
        code: String,
        /// Its error message.
        message: String,
    },
    /// A datum, tag or seed referenced by id is suppressed (§7.1).
    #[error("feature {feature:?} is suppressed")]
    DependencySuppressed {
        /// Feature id.
        feature: String,
    },
    /// A query id that is not an earlier feature of the right kind (defence in depth: the
    /// document validation rejects these).
    #[error("{id:?} is not an earlier {expected} feature")]
    UnresolvedFeature {
        /// The id.
        id: String,
        /// JSON pointer of the field.
        field: String,
        /// What was expected.
        expected: String,
    },
    /// A statically ill-typed query (defence in depth, §5.4).
    #[error("invalid query at {path}: expected {expected}, found {found}")]
    QueryInvalid {
        /// JSON pointer of the node.
        path: String,
        /// Expected.
        expected: String,
        /// Found.
        found: String,
    },
    /// A range check on an evaluated value (§0.5 rule 2).
    #[error("{field} = {value}: must be {expected}")]
    InvalidValue {
        /// Field pointer.
        field: String,
        /// The value.
        value: Value,
        /// The expected range.
        expected: String,
    },
    /// An explicit axis with a zero direction.
    #[error("{field}: the axis direction must be non-zero")]
    InvalidAxis {
        /// Field pointer.
        field: String,
        /// The value.
        value: Value,
    },
    /// An explicit frame that is degenerate (zero or parallel vectors).
    #[error("{field}: degenerate frame ({reason})")]
    InvalidPlane {
        /// Field pointer.
        field: String,
        /// Why.
        reason: String,
    },
    /// The face of a face frame is not planar (§3.1).
    #[error("the face of a plane reference is a {surface}, not a plane")]
    PlaneNotPlanar {
        /// Its surface type.
        surface: String,
    },
    /// A face frame's x direction projects to (almost) nothing (§3.1).
    #[error("the x direction of a face frame is (almost) parallel to its normal")]
    PlaneDegenerate {
        /// The x direction that was projected.
        x_dir: [f64; 3],
    },
    /// An axis reference to an edge that is neither a line nor a circle, or a face that is
    /// not a cylinder or cone (§3.2).
    #[error("an axis cannot be taken from a {kind}")]
    AxisRefUnsupported {
        /// The entity's type.
        kind: String,
    },
    /// A datum's inputs are degenerate (§3.3, §3.4).
    #[error("degenerate datum: {reason}")]
    DatumDegenerate {
        /// Why.
        reason: String,
        /// The angle that made it degenerate, in degrees: between the axis and the plane
        /// (`angle` mode), between the normals (`midplane`, `planes`), between `p1 − p0` and
        /// `p2 − p0` (`through`: 0 or 180 for collinear points, 0 for coincident ones), 0 for
        /// coincident axis points.
        angle_deg: f64,
    },
    /// An expression-valued field could not be evaluated here (no evaluator hook was given,
    /// or the hook failed): an engine-internal failure.
    #[error("expression {path} could not be evaluated")]
    ExprUnavailable {
        /// Field pointer.
        path: String,
    },
    /// A static rejection found before evaluation (an unvalidated query: `QUERY_INVALID`,
    /// `QUERY_UNKNOWN_CURVE`, `REF_KIND_MISMATCH`, …; see [`crate::typing`]).
    #[error("{message}")]
    Rejected {
        /// Catalogue code.
        code: &'static str,
        /// JSON pointer.
        path: String,
        /// Message.
        message: String,
        /// Catalogue details.
        details: Value,
    },
    /// A reference nested in a plane, axis, point or direction failed (its resolution's
    /// code: `REF_*`, `DEPENDENCY_FAILED`, …).
    #[error("{message}")]
    Reference {
        /// The failed reference's code.
        code: String,
        /// Its message.
        message: String,
        /// Its details.
        details: Map<String, Value>,
    },
    /// A `tagged` source whose tag reference fails in the current scope (§6.12): the tag's
    /// own resolution outcome (`REF_*` with its unresolved members and candidates, or
    /// `DEPENDENCY_FAILED`), passed through to the reference that uses the tag.
    #[error("tag {feature:?}: {message}")]
    TagFailed {
        /// The tag feature's id.
        feature: String,
        /// The tag reference's failing code.
        code: String,
        /// Its message.
        message: String,
        /// Its details (the catalogue's keys for `code`).
        details: Map<String, Value>,
        /// Its unresolved members, with their candidates.
        unresolved: Vec<forge_ir::v1::metrics::Unresolved>,
    },
    /// Exact geometry of an entity could not be computed (forge-check failure).
    #[error("{code}: {message}")]
    Geometry {
        /// `FORGE_*` code.
        code: String,
        /// Message (entities named by key).
        message: String,
    },
}

impl RefError {
    /// The stable code.
    pub fn code(&self) -> &str {
        match self {
            RefError::DependencyFailed { .. } => "DEPENDENCY_FAILED",
            RefError::DependencySuppressed { .. } => "DEPENDENCY_SUPPRESSED",
            RefError::UnresolvedFeature { .. } => "UNRESOLVED_FEATURE",
            RefError::QueryInvalid { .. } => "QUERY_INVALID",
            RefError::InvalidValue { .. } => "INVALID_VALUE",
            RefError::InvalidAxis { .. } => "INVALID_AXIS",
            RefError::InvalidPlane { .. } => "INVALID_PLANE",
            RefError::PlaneNotPlanar { .. } => "PLANE_NOT_PLANAR",
            RefError::PlaneDegenerate { .. } => "PLANE_DEGENERATE",
            RefError::AxisRefUnsupported { .. } => "AXIS_REF_UNSUPPORTED",
            RefError::DatumDegenerate { .. } => "DATUM_DEGENERATE",
            RefError::ExprUnavailable { .. } => "FORGE_EXPR_UNAVAILABLE",
            RefError::Rejected { code, .. } => code,
            RefError::Reference { code, .. } => code,
            RefError::TagFailed { code, .. } => code,
            RefError::Geometry { code, .. } => code,
        }
    }

    /// The `details` object (keys per the catalogue).
    pub fn details(&self) -> Map<String, Value> {
        let v = match self {
            RefError::DependencyFailed {
                feature,
                code,
                message,
            } => json!({ "feature": feature, "code": code, "message": message }),
            RefError::DependencySuppressed { feature } => json!({ "feature": feature }),
            RefError::UnresolvedFeature {
                id,
                field,
                expected,
            } => json!({ "id": id, "field": field, "expected": expected }),
            RefError::QueryInvalid {
                path,
                expected,
                found,
            } => json!({ "path": path, "expected": expected, "found": found }),
            RefError::InvalidValue {
                field,
                value,
                expected,
            } => json!({ "field": field, "value": value, "expected": expected }),
            RefError::InvalidAxis { field, value } => {
                json!({ "field": field, "value": value, "expected": "a non-zero direction" })
            }
            RefError::InvalidPlane { field, reason } => json!({ "field": field, "reason": reason }),
            RefError::PlaneNotPlanar { surface } => json!({ "surface": surface }),
            RefError::PlaneDegenerate { x_dir } => json!({ "x_dir": x_dir }),
            RefError::AxisRefUnsupported { kind } => json!({ "type": kind }),
            RefError::DatumDegenerate { reason, angle_deg } => {
                json!({ "reason": reason, "angle_deg": angle_deg })
            }
            RefError::ExprUnavailable { path } => json!({ "path": path }),
            RefError::Rejected { details, .. } => details.clone(),
            RefError::Reference { details, .. } | RefError::TagFailed { details, .. } => {
                Value::Object(details.clone())
            }
            RefError::Geometry { message, .. } => json!({ "message": message }),
        };
        match v {
            Value::Object(m) => m,
            _ => Map::new(),
        }
    }

    /// As an I5 report error.
    pub fn to_report(&self) -> forge_ir::v1::metrics::ReportError {
        forge_ir::v1::metrics::ReportError {
            code: self.code().to_string(),
            message: self.to_string(),
            details: self.details(),
        }
    }
}

impl From<forge_check::CheckError> for RefError {
    fn from(e: forge_check::CheckError) -> Self {
        RefError::Geometry {
            code: e.code().to_string(),
            message: e.to_string(),
        }
    }
}

impl From<crate::typing::TypeError> for RefError {
    fn from(e: crate::typing::TypeError) -> Self {
        RefError::Rejected {
            code: e.code,
            path: e.path,
            message: e.message,
            details: e.details,
        }
    }
}
