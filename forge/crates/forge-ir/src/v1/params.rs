//! Parameters (SPEC-v1 §2.1 [D-6]).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::scalar::{FieldType, Scalar};

/// A named, typed value. Document-level parameters live in `Document.params`, part-level ones
/// in `PartStudio.params`; order is declaration order.
///
/// Measured parameters (`measure`, §2.1) are **deferred to IR v1.1** (ADR 0013 decision 5);
/// a `measure` field is rejected with `PARAM_INVALID`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Parameter {
    /// Shares the feature-name namespace (§0.3): unique across the document, an identifier,
    /// not in `RESERVED_NAMES` (the full v1 list).
    pub name: String,
    pub unit: ParamUnit,
    /// A literal (number or boolean) or an expression string (§2.3). A parameter whose value
    /// is an expression is *derived*.
    pub value: ParamValue,
    /// Optional lower bound (literal or expression of the same type), checked after evaluation
    /// (`PARAM_OUT_OF_RANGE`). Not allowed for `bool`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<Scalar>,
    /// Optional upper bound, as `min`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<Scalar>,
    /// Free text, not semantic.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[schemars(extend("default" = ""))]
    pub note: String,
}

/// Parameter units (§2.1).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ParamUnit {
    /// Length in millimetres: Real(1, 0).
    Mm,
    /// Angle in degrees: Real(0, 1).
    Deg,
    /// Dimensionless real: Real(0, 0).
    Ratio,
    /// Dimensionless exact integer.
    Count,
    /// Boolean.
    Bool,
}

impl ParamUnit {
    /// The field type of the parameter's own expression (its use-site type, §2.5).
    pub fn field_type(self) -> FieldType {
        match self {
            ParamUnit::Mm => FieldType::Length,
            ParamUnit::Deg => FieldType::Angle,
            ParamUnit::Ratio => FieldType::Ratio,
            ParamUnit::Count => FieldType::Count,
            ParamUnit::Bool => FieldType::Bool,
        }
    }
    /// All units, in declaration order (the `allowed` list of `PARAM_INVALID`).
    pub const ALL: [&'static str; 5] = ["mm", "deg", "ratio", "count", "bool"];
}

/// A parameter value: a literal number, a literal boolean, or an expression string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ParamValue {
    Bool(bool),
    Num(f64),
    Expr(String),
}

impl ParamValue {
    /// The expression text, if the value is an expression (a *derived* parameter).
    pub fn expr(&self) -> Option<&str> {
        match self {
            ParamValue::Expr(e) => Some(e),
            _ => None,
        }
    }
}
