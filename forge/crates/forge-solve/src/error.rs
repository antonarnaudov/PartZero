//! Structured input errors. Every variant has a stable machine-readable [`SketchError::code`]
//! and carries the ids involved, so an agent can repair the input without parsing prose.
//!
//! Solver *outcomes* (under/over-constrained, conflicts, non-convergence) are not errors:
//! they are reported in [`crate::SolveResult`].

use serde::Serialize;

/// An invalid sketch or request.
#[derive(Clone, Debug, PartialEq, thiserror::Error, Serialize)]
#[serde(tag = "variant", rename_all = "snake_case")]
pub enum SketchError {
    /// An id is empty.
    #[error("empty id at {what} #{index}")]
    EmptyId {
        /// `"entity"` or `"constraint"`.
        what: &'static str,
        /// Position in the list.
        index: usize,
    },
    /// Two entities/constraints share an id.
    #[error("duplicate id `{id}`")]
    DuplicateId {
        /// The id.
        id: String,
    },
    /// A reference to an id that does not exist.
    #[error("`{owner}` references unknown entity `{reference}`")]
    UnknownReference {
        /// The referencing entity or constraint.
        owner: String,
        /// The missing id.
        reference: String,
    },
    /// A reference to an entity of the wrong type.
    #[error("`{owner}` expects {expected} for `{reference}`, found {found}")]
    WrongEntityType {
        /// The referencing entity or constraint.
        owner: String,
        /// The referenced id.
        reference: String,
        /// What was expected (e.g. `"point"`, `"line"`, `"circle or arc"`).
        expected: &'static str,
        /// What was found.
        found: &'static str,
    },
    /// A value is NaN or infinite.
    #[error("`{id}`: non-finite {field}")]
    NonFinite {
        /// The entity or constraint.
        id: String,
        /// The field name.
        field: &'static str,
    },
    /// A degenerate entity (line with identical point references, arc whose start or end
    /// is its center, non-positive circle radius).
    #[error("`{id}` is degenerate: {reason}")]
    DegenerateEntity {
        /// The entity.
        id: String,
        /// Why.
        reason: &'static str,
    },
    /// A dimension value outside its domain (distance, radius, diameter must be > 0).
    #[error("`{id}`: invalid dimension value {value}: {reason}")]
    InvalidDimension {
        /// The constraint.
        id: String,
        /// The value.
        value: f64,
        /// Why.
        reason: &'static str,
    },
    /// `driving: false` on a constraint that is not a dimension.
    #[error("`{id}`: only dimensions can be non-driving")]
    NotADimension {
        /// The constraint.
        id: String,
    },
    /// A combination of argument types the constraint does not support.
    #[error("`{id}`: unsupported {kind} between {a} and {b}")]
    UnsupportedCombination {
        /// The constraint.
        id: String,
        /// The constraint type.
        kind: &'static str,
        /// First argument's entity type.
        a: &'static str,
        /// Second argument's entity type.
        b: &'static str,
    },
    /// A constraint references the same entity twice where two distinct ones are needed.
    #[error("`{id}` references `{reference}` twice")]
    SelfReference {
        /// The constraint.
        id: String,
        /// The repeated entity id.
        reference: String,
    },
    /// A drag request names something that is not a point of the sketch.
    #[error("cannot drag `{id}`: {reason}")]
    InvalidDrag {
        /// The requested point id.
        id: String,
        /// Why.
        reason: &'static str,
    },
    /// A [`crate::SolveOptions`] value outside its domain (e.g. a circuit tolerance that is
    /// not finite or not in (0, 1)); nothing is solved.
    #[error("invalid option `{option}` = {value}: {reason}")]
    InvalidOption {
        /// The option (field of `SolveOptions`).
        option: &'static str,
        /// The value given.
        value: f64,
        /// Why it is rejected.
        reason: &'static str,
    },
    /// Malformed JSON.
    #[error("invalid JSON: {message}")]
    Json {
        /// The parser message.
        message: String,
    },
}

impl SketchError {
    /// Stable machine-readable code.
    pub fn code(&self) -> &'static str {
        match self {
            SketchError::EmptyId { .. } => "SKETCH_EMPTY_ID",
            SketchError::DuplicateId { .. } => "SKETCH_DUPLICATE_ID",
            SketchError::UnknownReference { .. } => "SKETCH_UNKNOWN_REFERENCE",
            SketchError::WrongEntityType { .. } => "SKETCH_WRONG_ENTITY_TYPE",
            SketchError::NonFinite { .. } => "SKETCH_NON_FINITE",
            SketchError::DegenerateEntity { .. } => "SKETCH_DEGENERATE_ENTITY",
            SketchError::InvalidDimension { .. } => "SKETCH_INVALID_DIMENSION",
            SketchError::NotADimension { .. } => "SKETCH_NOT_A_DIMENSION",
            SketchError::UnsupportedCombination { .. } => "SKETCH_UNSUPPORTED_COMBINATION",
            SketchError::SelfReference { .. } => "SKETCH_SELF_REFERENCE",
            SketchError::InvalidDrag { .. } => "SKETCH_INVALID_DRAG",
            SketchError::InvalidOption { .. } => "SKETCH_INVALID_OPTION",
            SketchError::Json { .. } => "SKETCH_JSON",
        }
    }
}
