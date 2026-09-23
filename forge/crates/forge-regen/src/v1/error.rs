//! The structured error of a failed v1 feature (SPEC-v1 §7.4): a catalogue code, a message for
//! people and a `details` object. Every workstream's error type converts into it; messages pass
//! [`scrub_arena_ids`] (arena ids never leave the process).

use forge_check::CheckError;
use forge_core::topo::scrub_arena_ids;
use forge_ir::v1::metrics::ReportError;
use forge_ops::{BooleanError, OpError};
use forge_params::Failure;
use forge_refs::RefError;
use forge_sketch::{RegionNotFound, SketchError};
use serde_json::{Map, Value, json};

/// Why a feature failed: `code`, `message`, `details` (SPEC-v1 §7.4).
#[derive(Clone, Debug, PartialEq)]
pub struct FeatureError {
    /// A code of the catalogue (`forge_ir::v1::codes`), or an engine-internal `FORGE_*` code.
    pub code: String,
    /// For people (arena ids scrubbed).
    pub message: String,
    /// Structured details (keys per code in the catalogue; never arena ids).
    pub details: Map<String, Value>,
}

impl FeatureError {
    /// An error with the given code, message and details (a non-object `details` is dropped).
    pub fn new(code: impl Into<String>, message: impl AsRef<str>, details: Value) -> Self {
        FeatureError {
            code: code.into(),
            message: scrub_arena_ids(message.as_ref()),
            details: match details {
                Value::Object(m) => m,
                _ => Map::new(),
            },
        }
    }

    /// The report form.
    pub fn to_report(&self) -> ReportError {
        ReportError {
            code: self.code.clone(),
            message: self.message.clone(),
            details: self.details.clone(),
        }
    }
}

impl std::fmt::Display for FeatureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for FeatureError {}

impl From<Failure> for FeatureError {
    fn from(e: Failure) -> Self {
        FeatureError::new(e.code, &e.message, Value::Object(e.details))
    }
}

impl From<SketchError> for FeatureError {
    fn from(e: SketchError) -> Self {
        let r = e.to_report_error();
        FeatureError::new(r.code, &r.message, Value::Object(r.details))
    }
}

impl From<RefError> for FeatureError {
    fn from(e: RefError) -> Self {
        FeatureError::new(e.code(), e.to_string(), Value::Object(e.details()))
    }
}

impl From<RegionNotFound> for FeatureError {
    fn from(e: RegionNotFound) -> Self {
        FeatureError::new(e.code(), e.to_string(), Value::Object(e.details()))
    }
}

impl From<BooleanError> for FeatureError {
    fn from(e: BooleanError) -> Self {
        let details = serde_json::to_value(e.details()).unwrap_or(Value::Null);
        FeatureError::new(e.code(), e.to_string(), details)
    }
}

impl From<CheckError> for FeatureError {
    fn from(e: CheckError) -> Self {
        FeatureError::new(e.code(), e.to_string(), json!({}))
    }
}

impl From<OpError> for FeatureError {
    fn from(e: OpError) -> Self {
        let details = op_details(&e);
        FeatureError::new(e.code(), e.to_string(), details)
    }
}

/// The details of a forge-ops error (SPEC-v1 §7.4): the fields of the variant.
fn op_details(e: &OpError) -> Value {
    match e {
        OpError::SketchOpenLoop { curve, end, point } => {
            json!({ "curve": curve, "end": end.to_string(), "point": point })
        }
        OpError::SketchBranching {
            curve,
            end,
            point,
            partners,
        } => {
            json!({ "curve": curve, "end": end.to_string(), "point": point, "partners": partners })
        }
        OpError::SketchCurvesCross {
            first,
            second,
            point,
        } => json!({ "first": first, "second": second, "point": point }),
        OpError::SketchDegenerateLoop { curves, area } => {
            json!({ "curves": curves, "area": area })
        }
        OpError::SketchSuppressed { sketch } => json!({ "sketch": sketch }),
        OpError::DependencyFailed {
            sketch,
            code,
            message,
        } => json!({ "feature": sketch, "code": code, "message": scrub_arena_ids(message) }),
        OpError::RevolveCrossesAxis {
            outer_curves,
            min,
            max,
            tolerance,
        } => {
            json!({ "outer_curves": outer_curves, "min": min, "max": max, "tolerance": tolerance })
        }
        OpError::InvalidParameter {
            what,
            value,
            expected,
        } => json!({ "field": what, "value": finite(*value), "expected": expected }),
        OpError::InvalidPlane { reason } => json!({ "reason": reason }),
        OpError::InvalidCurveId { curve } => json!({ "curve": curve }),
        OpError::InvalidResult { issues } => {
            json!({ "issues": issues.iter().map(|i| scrub_arena_ids(i)).collect::<Vec<_>>() })
        }
        _ => json!({}),
    }
}

/// A number for JSON details (`null` when not finite: JSON has no NaN or infinity).
pub(crate) fn finite(x: f64) -> Value {
    if x.is_finite() {
        json!(x + 0.0)
    } else {
        Value::Null
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_scrubbed_of_arena_ids() {
        let e = FeatureError::new("X", "edge Edge#3v0 is bad", json!({ "a": 1 }));
        assert!(!e.message.contains("#3v0"), "{}", e.message);
        assert_eq!(e.details.get("a"), Some(&json!(1)));
        assert_eq!(e.to_report().code, "X");
    }

    #[test]
    fn non_object_details_are_dropped() {
        let e = FeatureError::new("X", "m", json!([1, 2]));
        assert!(e.details.is_empty());
    }

    #[test]
    fn op_errors_keep_their_code_and_fields() {
        let e: FeatureError = OpError::SketchDegenerateLoop {
            curves: vec!["a".into(), "b".into()],
            area: 1e-13,
        }
        .into();
        assert_eq!(e.code, "SKETCH_DEGENERATE_LOOP");
        assert_eq!(e.details.get("curves"), Some(&json!(["a", "b"])));
        let e: FeatureError = OpError::InvalidParameter {
            what: "extrude distance",
            value: f64::NAN,
            expected: "> 0",
        }
        .into();
        assert_eq!(e.details.get("value"), Some(&Value::Null));
    }
}
