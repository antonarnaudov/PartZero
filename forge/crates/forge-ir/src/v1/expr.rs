//! The validation boundary for expressions (interface I2's hook into I1).
//!
//! W0 owns *where* expressions occur and what type each site has; W1 owns the language
//! (parser, canonical printer, type checker, scope and dependency analysis). [`validate_with`]
//! collects every expression site of a document with [`expr_sites`] and hands them, together
//! with the document, to an [`ExprValidator`]. W1 implements that trait in `forge-ir::expr`
//! (pure: no transcendentals) and returns the rejections of SPEC-v1 §7.5 it owns:
//! `EXPR_SYNTAX`, `EXPR_UNKNOWN_NAME`, `EXPR_UNKNOWN_FUNCTION`, `EXPR_ARITY`,
//! `EXPR_UNIT_MISMATCH`, `EXPR_TYPE_MISMATCH`, `EXPR_SCOPE`, `PARAM_CYCLE`.
//!
//! Without a validator, W0 still rejects what needs no parser: an empty expression and one
//! longer than [`super::MAX_EXPR_BYTES`] (`EXPR_SYNTAX`).
//!
//! [`validate_with`]: super::validate_with

use super::scalar::FieldType;
use super::{Document, Feature, PartStudio};

// ---- W1: the expression language (SPEC-v1 §2.3–§2.8), implemented in `expr/` ----------------
mod ast;
mod canon;
mod checker;
mod lexer;
mod parser;
mod printer;
mod types;

pub use ast::{BinaryOp, Expr, UnaryOp, Unit};
pub use canon::{CanonicalizeError, canonicalize_expressions, canonicalize_expressions_with};
pub use checker::{
    CHECKER, ExprChecker, ParamCycle, ParamGraph, ParamId, ParamScopes, options, param_expressions,
    used_params,
};
pub use parser::{SyntaxError, parse};
pub use printer::{canonical, format_number, nesting};
pub use types::{
    Arity, Binding, Dim, EXPECTED_EVEN, EXPECTED_INTEGER_LITERAL, EXPECTED_NUMBER,
    EXPECTED_REPRESENTABLE, Env, ExprError, FUNCTIONS, PI_NAME, Type, check, check_text,
    check_use_site, div_type, function_arity, mul_type, typecheck, unify,
};

/// Where an expression's identifiers are resolved (SPEC-v1 §2.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ExprScope {
    /// A document parameter: may use document parameters only.
    Document,
    /// A part parameter or a feature field of part `index`: may use document parameters and
    /// that part's parameters.
    Part(usize),
}

/// Who owns an expression site.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SiteOwner {
    /// A parameter's `value`, `min` or `max`; `part` is `None` for document parameters.
    Param { part: Option<usize>, name: String },
    /// A field of feature `index` of part `part`.
    Feature {
        part: usize,
        index: usize,
        id: String,
    },
}

/// One expression occurrence.
#[derive(Debug, Clone, PartialEq)]
pub struct ExprSite<'a> {
    /// JSON pointer of the field, e.g. `/parts/0/features/3/distance`.
    pub path: String,
    /// The stored text.
    pub text: &'a str,
    /// The field type fixing the use-site type (§2.5).
    pub field: FieldType,
    pub scope: ExprScope,
    pub owner: SiteOwner,
}

/// A literal numeric field value, with the same addressing as [`ExprSite`] (used for the
/// literal range checks of §0.5 rule 1 and by W1 to type literal parameter values).
#[derive(Debug, Clone, PartialEq)]
pub struct LiteralSite {
    pub path: String,
    pub value: f64,
    pub field: FieldType,
    pub owner: SiteOwner,
}

/// W1's validation hook. Implementations MUST be deterministic and return errors in site
/// order (then by offset within an expression); every returned code must be an `R` code of
/// the catalogue ([`super::codes`]).
pub trait ExprValidator {
    fn validate_expressions(
        &self,
        doc: &Document,
        sites: &[ExprSite<'_>],
    ) -> Vec<super::ValidationError>;
}

/// Every expression site of the document, in document order: document parameters, then per
/// part its parameters and its features (fields in declaration order).
pub fn expr_sites(doc: &Document) -> Vec<ExprSite<'_>> {
    let mut v = super::validate::Walker::default();
    v.walk_document(doc);
    v.exprs
}

/// Every literal numeric field of the document, in the same order as [`expr_sites`].
pub fn literal_sites(doc: &Document) -> Vec<LiteralSite> {
    let mut v = super::validate::Walker::default();
    v.walk_document(doc);
    v.literals
}

/// The expression sites of one feature (feature `index` of part `part_index`).
pub fn feature_sites<'a>(
    part_index: usize,
    part: &'a PartStudio,
    f: &'a Feature,
    index: usize,
) -> Vec<ExprSite<'a>> {
    let mut v = super::validate::Walker::default();
    v.walk_feature(part_index, part, f, index);
    v.exprs
}
