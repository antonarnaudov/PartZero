//! Canonical expression storage (SPEC-v1 §0.4, §2.4): what the DocStore and the CadScript
//! compiler write. `forge_ir::v1::to_json` never rewrites strings; callers that store
//! documents run [`canonicalize_expressions`] first.
//!
//! **Validity is preserved or the rewrite is refused.** Two rewrites can turn an accepted
//! document into a rejected one, because §0.5 treats literals and expressions differently:
//! 1. a plain literal written as a string becomes a JSON literal (§0.4), and literals are
//!    range-checked at load time (§0.5 rule 1) while expressions are range-checked when
//!    evaluated (rule 2): `"distance": "-5"` loads (and fails the extrude with
//!    `INVALID_DISTANCE` at evaluation) but `"distance": -5` is rejected with the same code;
//!    so are `"1e-400"` (it rounds to `0`) and a `count` of `"2.5"` (`EXPR_NOT_INTEGER`);
//! 2. the canonical text can be longer than the source (spaces around operators, `, `), and
//!    beyond 4096 bytes it is `EXPR_SYNTAX`.
//!
//! [`canonicalize_expressions_with`] therefore re-validates the rewritten document and returns
//! [`CanonicalizeError::Rejected`] (with the rejections, each naming its site) instead of a
//! document that would not load, so the command layer can refuse the op. (Whether a literal
//! written as a string should keep its evaluation-time stage is a SPEC question, flagged in the
//! W1 report.)

use serde_json::Value;

use super::ast::{Expr, UnaryOp};
use super::{canonical, expr_sites, parse};
use crate::v1::scalar::FieldType;
use crate::v1::{Document, ValidateOptions, ValidationError, validate_with};

/// Why [`canonicalize_expressions`] could not rewrite a document.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum CanonicalizeError {
    /// A site's JSON pointer did not address a value of the serialized document.
    #[error("expression site {0} is not addressable")]
    Site(String),
    /// The rewritten value no longer deserializes (a bug: every rewrite keeps the field's kind).
    #[error("rewritten document does not deserialize: {0}")]
    Shape(String),
    /// The document validates but its canonical form would not (see the module
    /// documentation): the rejections of the canonical form, each at its site's path.
    #[error("the canonical form would be rejected: {}", describe(.0))]
    Rejected(Vec<ValidationError>),
}

fn describe(errs: &[ValidationError]) -> String {
    let mut s: Vec<String> = errs.iter().take(3).map(ToString::to_string).collect();
    if errs.len() > 3 {
        s.push(format!("… {} more", errs.len() - 3));
    }
    s.join("; ")
}

/// [`canonicalize_expressions_with`] with the default validation options (the whole rejection
/// pipeline, W1's checker included).
pub fn canonicalize_expressions(doc: &Document) -> Result<Document, CanonicalizeError> {
    canonicalize_expressions_with(doc, &ValidateOptions::default())
}

/// Rewrite every expression of `doc` to its canonical form: the canonical text (§2.4), or a
/// JSON literal when the expression is a plain literal of the field's kind (`"8.0"` → `8`,
/// `"-2.5"` → `-2.5`, `"true"` → `true`; §0.4 "`\"8\"` is not canonical; `8` is"). Texts that
/// do not parse are left unchanged (validation rejects them). A literal `-0` is stored as `0`
/// (§2.7 rule 8). Idempotent.
///
/// When `doc` validates with `opts` and the rewritten document does not, the rewrite is refused
/// with [`CanonicalizeError::Rejected`]. A document that is already rejected is rewritten on a
/// best-effort basis (it stays rejected, possibly with more problems).
pub fn canonicalize_expressions_with(
    doc: &Document,
    opts: &ValidateOptions<'_>,
) -> Result<Document, CanonicalizeError> {
    let out = rewrite(doc)?;
    if let Err(errs) = validate_with(&out, opts)
        && validate_with(doc, opts).is_ok()
    {
        return Err(CanonicalizeError::Rejected(errs));
    }
    Ok(out)
}

fn rewrite(doc: &Document) -> Result<Document, CanonicalizeError> {
    let sites = expr_sites(doc);
    let mut v = serde_json::to_value(doc).map_err(|e| CanonicalizeError::Shape(e.to_string()))?;
    for s in &sites {
        let Ok(e) = parse(s.text) else { continue };
        let new = literal(&e, s.field).unwrap_or_else(|| Value::String(canonical(&e)));
        let slot = v
            .pointer_mut(&s.path)
            .ok_or_else(|| CanonicalizeError::Site(s.path.clone()))?;
        *slot = new;
    }
    serde_json::from_value(v).map_err(|e| CanonicalizeError::Shape(e.to_string()))
}

/// The JSON literal a plain literal expression is stored as, if it matches the field's kind.
fn literal(e: &Expr, field: FieldType) -> Option<Value> {
    let number = |x: f64| {
        // -0 → 0 (§2.7 rule 8); never NaN/∞ (the parser rejects them).
        let x = if x == 0.0 { 0.0 } else { x };
        serde_json::Number::from_f64(x).map(Value::Number)
    };
    match (e, field) {
        (Expr::Bool(b), FieldType::Bool) => Some(Value::Bool(*b)),
        (_, FieldType::Bool) => None,
        (Expr::Num { value, unit: None }, _) => number(*value),
        (
            Expr::Unary {
                op: UnaryOp::Neg,
                operand,
            },
            _,
        ) => match operand.as_ref() {
            Expr::Num { value, unit: None } => number(-*value),
            _ => None,
        },
        _ => None,
    }
}
