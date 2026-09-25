//! Structured pattern errors and warnings (SPEC §6.10, §7.4, §7.5).
//!
//! Semantic failures use the SPEC codes with exactly the detail keys of the `ERROR_CODES`
//! catalogue (`INVALID_COUNT`, `INVALID_VALUE`, `INVALID_ANGLE`: `field`, `value`,
//! `expected`; `PATTERN_ALL_INSTANCES_FAILED`: `instances`; the warning
//! `PATTERN_INSTANCE_SKIPPED`: `index`, `code`). A failure of the body operation that is not
//! an instance miss keeps the boolean's code and details. Engine-internal failures use the
//! `FORGE_PATTERN_` prefix and never come with a body: `FORGE_PATTERN_TOO_MANY_INSTANCES
//! { field, value, max }` (the engine's instance limit), `FORGE_PATTERN_TOO_MANY_COPIES
//! { instances, seed_bodies, copies, max }` (the engine's limit on moved copies),
//! `FORGE_PATTERN_HOLE_SEED_MISMATCH { seed, at, what }` (a hole seed without its tool
//! information, or a hole tool applied as another operation), and
//! `FORGE_PATTERN_THROUGH_COPY_TOO_SHORT { index, seed, at, length, reach }` (a copied
//! through-hole tool that would leave a blind pocket). The hole diagnostics of pattern
//! instances are engine-prefixed warnings until the Contract stage rules on them:
//! `FORGE_PATTERN_HOLE_BREAKS_THROUGH`, `FORGE_PATTERN_HOLE_POSITION_MISSED` and
//! `FORGE_PATTERN_HOLE_TOP_INSIDE`, all `{ index, seed, at }`.

use serde::Serialize;
use thiserror::Error;

use crate::boolean::{BooleanError, BooleanErrorDetails};

/// A detail value: a number, or an instance index (`[i]` / `[i, j]`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum DetailValue {
    /// A number (mm, degrees or a count).
    Num(f64),
    /// An instance index.
    Index(Vec<u32>),
}

impl std::fmt::Display for DetailValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DetailValue::Num(v) => write!(f, "{v}"),
            DetailValue::Index(i) => write!(f, "{i:?}"),
        }
    }
}

/// An instance the pattern did not create because its tools meet no target.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Skipped {
    /// The instance index (`[i]` or `[i, j]`).
    pub index: Vec<u32>,
    /// The code the seed's operation raises for it alone (`BOOLEAN_NO_INTERSECTION`,
    /// `BOOLEAN_EMPTY_RESULT`, `HOLE_MISSES_BODY`).
    pub code: String,
}

/// A hole diagnostic of one copied hole position (`{ index, seed, at }`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HoleCopyNote {
    /// The instance index (`[i]` or `[i, j]`).
    pub index: Vec<u32>,
    /// The hole seed's feature id.
    pub seed: String,
    /// The seed position id.
    pub at: String,
}

/// A warning raised by a pattern (SPEC §7.3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum PatternNote {
    /// `PATTERN_INSTANCE_SKIPPED` (warning): `{ "index", "code" }`.
    InstanceSkipped(Skipped),
    /// `FORGE_PATTERN_HOLE_BREAKS_THROUGH` (warning): the copy of a blind hole position
    /// breaks through (the hole's own test, SPEC §6.5 `HOLE_BREAKS_THROUGH`).
    HoleBreaksThrough(HoleCopyNote),
    /// `FORGE_PATTERN_HOLE_POSITION_MISSED` (warning): a copied hole position meets no
    /// target while another position of the same instance does (the instance is kept).
    HolePositionMissed(HoleCopyNote),
    /// `FORGE_PATTERN_HOLE_TOP_INSIDE` (warning): the copy's top disc (`H/top@p`, at the
    /// moved placement point) survives in the result, so the copied hole is closed at its
    /// top — the moved placement point lies inside the material (a translation against the
    /// drilling direction, a tilting rotation or mirror, or a seed placed on a plane inside
    /// its target). The geometry is SPEC §6.5's tool from `P'` along `d'`; the warning says
    /// that the copy does not open onto a face (W5 contract issue with the through copies).
    HoleTopInside(HoleCopyNote),
}

impl PatternNote {
    /// Stable code.
    pub fn code(&self) -> &'static str {
        match self {
            PatternNote::InstanceSkipped(_) => "PATTERN_INSTANCE_SKIPPED",
            PatternNote::HoleBreaksThrough(_) => "FORGE_PATTERN_HOLE_BREAKS_THROUGH",
            PatternNote::HolePositionMissed(_) => "FORGE_PATTERN_HOLE_POSITION_MISSED",
            PatternNote::HoleTopInside(_) => "FORGE_PATTERN_HOLE_TOP_INSIDE",
        }
    }
    /// `"warning"`.
    pub fn severity(&self) -> &'static str {
        "warning"
    }
}

/// A pattern failed.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum PatternError {
    /// A count outside its range (`INVALID_COUNT`; rejected for literals, an evaluation
    /// error when an expression produced it).
    #[error("{field} = {value} is not a valid count: must be {expected}")]
    InvalidCount {
        /// Field path relative to the feature (`/layout/linear/count`).
        field: String,
        /// The value.
        value: f64,
        /// The valid range.
        expected: &'static str,
    },
    /// A value outside its range (`INVALID_VALUE`).
    #[error("{field} = {value} is invalid: must be {expected}")]
    InvalidValue {
        /// Field path relative to the feature.
        field: String,
        /// The value.
        value: DetailValue,
        /// The valid range.
        expected: &'static str,
    },
    /// A circular pattern angle outside `(0, 360]` (`INVALID_ANGLE`).
    #[error("{field} = {value} is not a valid angle: must be {expected}")]
    InvalidAngle {
        /// Field path relative to the feature.
        field: String,
        /// The value (degrees).
        value: f64,
        /// The valid range.
        expected: &'static str,
    },
    /// Every instance was skipped (`PATTERN_ALL_INSTANCES_FAILED`).
    #[error("every pattern instance was skipped ({} instances)", instances.len())]
    AllInstancesFailed {
        /// The skipped instances with their codes.
        instances: Vec<Skipped>,
    },
    /// The body operation failed for a reason other than an instance miss.
    #[error(transparent)]
    Boolean(#[from] BooleanError),
    /// A reflection that cannot be represented exactly (`FORGE_PATTERN_MIRROR_UNSUPPORTED`).
    #[error("cannot mirror {entity}: {what}")]
    MirrorUnsupported {
        /// The entity (provenance name).
        entity: String,
        /// Why.
        what: String,
    },
    /// A moved copy failed Forge's validity checks (`FORGE_PATTERN_INVALID_COPY`).
    #[error("pattern copy is invalid: {}", issues.join("; "))]
    InvalidCopy {
        /// The issues, entities named by provenance.
        issues: Vec<String>,
    },
    /// More instances than this engine builds (`FORGE_PATTERN_TOO_MANY_INSTANCES`).
    #[error("{field} defines {value} instances; at most {max} are supported")]
    TooManyInstances {
        /// The layout field (`/layout/linear/count`, `/layout/linear`, …).
        field: String,
        /// The number of non-seed instances the layout defines.
        value: f64,
        /// The most instances supported (`MAX_PATTERN_INSTANCES`).
        max: f64,
    },
    /// More moved copies (instances × seed bodies) than this engine builds
    /// (`FORGE_PATTERN_TOO_MANY_COPIES`), decided before any copy is built.
    #[error(
        "{instances} instances of {seed_bodies} seed bodies are {copies} copies; at most {max} \
         are supported"
    )]
    TooManyCopies {
        /// The kept instances.
        instances: f64,
        /// The seed's bodies (tools of a feature seed, bodies of a body seed).
        seed_bodies: f64,
        /// `instances · seed_bodies`.
        copies: f64,
        /// The most copies supported (`MAX_PATTERN_COPIES`).
        max: f64,
    },
    /// A hole seed handed to [`crate::pattern::apply_seed`] without the tool information its
    /// copies are checked with, or a hole tool applied as another operation
    /// (`FORGE_PATTERN_HOLE_SEED_MISMATCH`): the through and break-through checks of the
    /// copies could not run, so the pattern is refused rather than risk a pocket.
    #[error("hole seed {seed:?} position {at:?}: {what}")]
    HoleSeedMismatch {
        /// The seed body's origin feature.
        seed: String,
        /// The seed body's member (the hole position id).
        at: String,
        /// What is inconsistent.
        what: String,
    },
    /// A copied through-hole tool ends inside the pattern's targets
    /// (`FORGE_PATTERN_THROUGH_COPY_TOO_SHORT`).
    #[error(
        "instance {index:?}: the copy of through hole {seed:?} position {at:?} is {length} mm \
         long (as evaluated at the seed) and does not leave the pattern's targets, which extend \
         {reach} mm along its axis; a through hole must leave every target (SPEC §6.5), so \
         Forge does not return the blind pocket it would cut"
    )]
    ThroughCopyTooShort {
        /// The instance index.
        index: Vec<u32>,
        /// The hole seed's feature id.
        seed: String,
        /// The seed position id.
        at: String,
        /// The copied tool's length (mm).
        length: f64,
        /// How far the targets' boxes extend along the copy's axis from its top (mm): a copy
        /// longer than this would leave every target.
        reach: f64,
    },
    /// Any other internal failure (`FORGE_PATTERN_INTERNAL`).
    #[error("internal pattern error: {0}")]
    Internal(String),
}

/// The `details` of a [`PatternError`] (SPEC §7.4), keys as in the catalogue.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PatternErrorDetails {
    /// `INVALID_COUNT`, `INVALID_VALUE`, `INVALID_ANGLE`.
    Range {
        /// Field path.
        field: String,
        /// The value.
        value: DetailValue,
        /// The valid range.
        expected: &'static str,
    },
    /// `PATTERN_ALL_INSTANCES_FAILED`.
    AllFailed {
        /// The skipped instances.
        instances: Vec<Skipped>,
    },
    /// A boolean failure's own details.
    Boolean(BooleanErrorDetails),
    /// `FORGE_PATTERN_MIRROR_UNSUPPORTED`.
    Mirror {
        /// The entity.
        entity: String,
        /// Why.
        what: String,
    },
    /// `FORGE_PATTERN_INVALID_COPY`.
    Invalid {
        /// The issues.
        issues: Vec<String>,
    },
    /// `FORGE_PATTERN_TOO_MANY_INSTANCES`.
    Limit {
        /// The layout field.
        field: String,
        /// The number of instances.
        value: f64,
        /// The most supported.
        max: f64,
    },
    /// `FORGE_PATTERN_TOO_MANY_COPIES`.
    Copies {
        /// The kept instances.
        instances: f64,
        /// The seed bodies.
        seed_bodies: f64,
        /// Their product.
        copies: f64,
        /// The most supported.
        max: f64,
    },
    /// `FORGE_PATTERN_HOLE_SEED_MISMATCH`.
    HoleSeed {
        /// The seed body's origin feature.
        seed: String,
        /// Its member.
        at: String,
        /// What is inconsistent.
        what: String,
    },
    /// `FORGE_PATTERN_THROUGH_COPY_TOO_SHORT`.
    ThroughCopy {
        /// The instance index.
        index: Vec<u32>,
        /// The hole seed.
        seed: String,
        /// The seed position id.
        at: String,
        /// The copied tool's length (mm).
        length: f64,
        /// How far the targets extend along the copy's axis (mm).
        reach: f64,
    },
    /// `FORGE_PATTERN_INTERNAL`.
    Internal {
        /// What failed.
        detail: String,
    },
}

impl PatternError {
    /// Stable machine-readable code.
    pub fn code(&self) -> &'static str {
        match self {
            PatternError::InvalidCount { .. } => "INVALID_COUNT",
            PatternError::InvalidValue { .. } => "INVALID_VALUE",
            PatternError::InvalidAngle { .. } => "INVALID_ANGLE",
            PatternError::AllInstancesFailed { .. } => "PATTERN_ALL_INSTANCES_FAILED",
            PatternError::Boolean(e) => e.code(),
            PatternError::MirrorUnsupported { .. } => "FORGE_PATTERN_MIRROR_UNSUPPORTED",
            PatternError::InvalidCopy { .. } => "FORGE_PATTERN_INVALID_COPY",
            PatternError::TooManyInstances { .. } => "FORGE_PATTERN_TOO_MANY_INSTANCES",
            PatternError::TooManyCopies { .. } => "FORGE_PATTERN_TOO_MANY_COPIES",
            PatternError::HoleSeedMismatch { .. } => "FORGE_PATTERN_HOLE_SEED_MISMATCH",
            PatternError::ThroughCopyTooShort { .. } => "FORGE_PATTERN_THROUGH_COPY_TOO_SHORT",
            PatternError::Internal(_) => "FORGE_PATTERN_INTERNAL",
        }
    }

    /// The structured `details` (SPEC §7.4).
    pub fn details(&self) -> PatternErrorDetails {
        match self {
            PatternError::InvalidCount {
                field,
                value,
                expected,
            }
            | PatternError::InvalidAngle {
                field,
                value,
                expected,
            } => PatternErrorDetails::Range {
                field: field.clone(),
                value: DetailValue::Num(*value),
                expected,
            },
            PatternError::InvalidValue {
                field,
                value,
                expected,
            } => PatternErrorDetails::Range {
                field: field.clone(),
                value: value.clone(),
                expected,
            },
            PatternError::AllInstancesFailed { instances } => PatternErrorDetails::AllFailed {
                instances: instances.clone(),
            },
            PatternError::Boolean(e) => PatternErrorDetails::Boolean(e.details()),
            PatternError::MirrorUnsupported { entity, what } => PatternErrorDetails::Mirror {
                entity: entity.clone(),
                what: what.clone(),
            },
            PatternError::InvalidCopy { issues } => PatternErrorDetails::Invalid {
                issues: issues.clone(),
            },
            PatternError::TooManyInstances { field, value, max } => PatternErrorDetails::Limit {
                field: field.clone(),
                value: *value,
                max: *max,
            },
            PatternError::TooManyCopies {
                instances,
                seed_bodies,
                copies,
                max,
            } => PatternErrorDetails::Copies {
                instances: *instances,
                seed_bodies: *seed_bodies,
                copies: *copies,
                max: *max,
            },
            PatternError::HoleSeedMismatch { seed, at, what } => PatternErrorDetails::HoleSeed {
                seed: seed.clone(),
                at: at.clone(),
                what: what.clone(),
            },
            PatternError::ThroughCopyTooShort {
                index,
                seed,
                at,
                length,
                reach,
            } => PatternErrorDetails::ThroughCopy {
                index: index.clone(),
                seed: seed.clone(),
                at: at.clone(),
                length: *length,
                reach: *reach,
            },
            PatternError::Internal(detail) => PatternErrorDetails::Internal {
                detail: detail.clone(),
            },
        }
    }

    pub(crate) fn internal(what: impl Into<String>) -> Self {
        PatternError::Internal(what.into())
    }
}
