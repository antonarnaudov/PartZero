//! Scalar fields (SPEC-v1 §2.2): a literal number, or an expression string.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A numeric field value (SPEC-v1 §2.2 [D-7]): a JSON **number** is a literal in the field's
/// unit (mm or degrees); a JSON **string** is an expression (§2.3) in canonical form (§2.4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Scalar {
    /// A literal in the field's unit.
    Num(f64),
    /// An expression (SPEC-v1 §2.3), e.g. `"width - 2 * wall"`.
    Expr(String),
}

impl Scalar {
    /// The literal value, if this is a literal.
    pub fn literal(&self) -> Option<f64> {
        match self {
            Scalar::Num(v) => Some(*v),
            Scalar::Expr(_) => None,
        }
    }
    /// The expression text, if this is an expression.
    pub fn expr(&self) -> Option<&str> {
        match self {
            Scalar::Num(_) => None,
            Scalar::Expr(e) => Some(e),
        }
    }
    /// `true` for a literal equal to `v` (`-0 == 0`). Used for canonical default omission.
    #[allow(clippy::float_cmp)] // exact on purpose: canonical defaults are exact literals
    pub fn is_literal(&self, v: f64) -> bool {
        matches!(self, Scalar::Num(x) if *x == v)
    }
    pub(crate) fn is_zero(&self) -> bool {
        self.is_literal(0.0)
    }
}

impl From<f64> for Scalar {
    fn from(v: f64) -> Self {
        Scalar::Num(v)
    }
}

impl From<&str> for Scalar {
    fn from(v: &str) -> Self {
        Scalar::Expr(v.to_string())
    }
}

/// A boolean field that accepts expressions (SPEC-v1 §2.2, [W0-3]): a JSON boolean, or an
/// expression string of type Bool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum BoolScalar {
    /// A literal.
    Bool(bool),
    /// An expression of type Bool, e.g. `"!with_lid"`.
    Expr(String),
}

impl BoolScalar {
    /// The literal value, if this is a literal.
    pub fn literal(&self) -> Option<bool> {
        match self {
            BoolScalar::Bool(b) => Some(*b),
            BoolScalar::Expr(_) => None,
        }
    }
    pub(crate) fn is_false(&self) -> bool {
        matches!(self, BoolScalar::Bool(false))
    }
    pub(crate) fn is_true(&self) -> bool {
        matches!(self, BoolScalar::Bool(true))
    }
    pub(crate) fn r#false() -> Self {
        BoolScalar::Bool(false)
    }
    pub(crate) fn r#true() -> Self {
        BoolScalar::Bool(true)
    }
}

impl Default for BoolScalar {
    fn default() -> Self {
        BoolScalar::Bool(false)
    }
}

impl From<bool> for BoolScalar {
    fn from(b: bool) -> Self {
        BoolScalar::Bool(b)
    }
}

/// A 2D point or vector of Scalars, in sketch (u, v) coordinates.
pub type SP2 = [Scalar; 2];
/// A 3D point or vector of Scalars, in model coordinates.
pub type SP3 = [Scalar; 3];

/// The declared type of a Scalar field (SPEC-v1 §2.2): fixes the use-site type of an expression
/// (§2.5) and which literal range checks apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    /// Millimetres: Real(1, 0).
    Length,
    /// Degrees: Real(0, 1).
    Angle,
    /// Dimensionless real: Real(0, 0). Also the components of direction vectors ([W0-4]).
    Ratio,
    /// Dimensionless exact integer, `|v| ≤ 2^31` (§2.7 rule 9).
    Count,
    /// Bool.
    Bool,
}

impl FieldType {
    /// The unit spelling used in `EXPR_UNIT_MISMATCH` details (§7.5).
    pub fn unit_name(self) -> &'static str {
        match self {
            FieldType::Length => "mm",
            FieldType::Angle => "deg",
            FieldType::Ratio | FieldType::Count => "1",
            FieldType::Bool => "bool",
        }
    }
}

pub(crate) fn zero2() -> SP2 {
    [Scalar::Num(0.0), Scalar::Num(0.0)]
}

pub(crate) fn is_zero2(p: &SP2) -> bool {
    p[0].is_zero() && p[1].is_zero()
}
