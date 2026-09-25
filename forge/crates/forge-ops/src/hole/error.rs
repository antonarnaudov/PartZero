//! Structured hole errors and warnings (SPEC §6.5, §7.4, §7.5).
//!
//! Semantic failures use the SPEC codes with exactly the detail keys of the `ERROR_CODES`
//! catalogue: `HOLE_POINT_OFF_FACE { at, distance }`, `HOLE_DUPLICATE_POSITION { at }`,
//! `HOLE_UP_TO_MISSED { at }`, `HOLE_MISSES_BODY { at }`, the warning
//! `HOLE_BREAKS_THROUGH { at }`, the range codes `INVALID_VALUE` / `INVALID_COUNT`
//! `{ field, value, expected }` (evaluation errors when an expression produced the value;
//! validation rejects literals) and, for documents that bypassed validation, the rejection
//! codes `HOLE_SIZE_REQUIRED`, `HOLE_DEPTH_REQUIRED` and `HOLE_OPTIONS_CONFLICT`
//! `{ field, allowed }`, and `DUPLICATE_ID { id }` (a position id used twice; the variant
//! also carries the field path, `/at/list/<k>/id` or `/at/points/ids/<k>`, for the error's
//! `path` — the catalogue's details are `id` only). A failure of the cut that is not a miss keeps the boolean's code
//! and details. Engine-internal failures use the `FORGE_HOLE_` prefix and never come with a
//! body (`FORGE_HOLE_TOO_MANY_POSITIONS { field, value, max }`: the engine's position limit).

use serde::Serialize;
use thiserror::Error;

use crate::boolean::{BooleanError, BooleanErrorDetails};

/// A warning raised by a hole (SPEC §7.3).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum HoleNote {
    /// `HOLE_BREAKS_THROUGH` (warning): the bottom of a blind hole at `at` is not inside
    /// the material.
    BreaksThrough {
        /// The position id.
        at: String,
    },
    /// `FORGE_HOLE_THREAD_DEEPER_THAN_HOLE` (warning, engine-prefixed: SPEC §6.5 bounds the
    /// thread `depth` only by tol): an explicit cosmetic thread depth exceeds the depth of the
    /// blind or up-to hole at `at`. The report keeps the thread depth as given.
    ThreadDeeperThanHole {
        /// The position id.
        at: String,
        /// The thread depth (mm).
        depth: f64,
        /// The hole's depth at that position (mm, to the shoulder).
        hole_depth: f64,
    },
}

impl HoleNote {
    /// Stable code.
    pub fn code(&self) -> &'static str {
        match self {
            HoleNote::BreaksThrough { .. } => "HOLE_BREAKS_THROUGH",
            HoleNote::ThreadDeeperThanHole { .. } => "FORGE_HOLE_THREAD_DEEPER_THAN_HOLE",
        }
    }
    /// `"warning"`.
    pub fn severity(&self) -> &'static str {
        "warning"
    }
}

/// A hole feature failed.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum HoleError {
    /// A position is not on the `on` face (`HOLE_POINT_OFF_FACE`).
    #[error("hole position {at:?} is {distance:e} mm off the placement face")]
    PointOffFace {
        /// The position id.
        at: String,
        /// Its distance to the face (mm).
        distance: f64,
    },
    /// Two positions are within the tolerance of each other (`HOLE_DUPLICATE_POSITION`).
    #[error("hole position {at:?} coincides with an earlier position")]
    DuplicatePosition {
        /// The later position's id.
        at: String,
    },
    /// Two positions share an id (`DUPLICATE_ID`, SPEC §6.5 [W0-10]; a rejection re-checked
    /// for documents that bypassed validation).
    #[error("hole position id {id:?} is used twice ({field})")]
    DuplicateId {
        /// The later occurrence's field path (`/at/list/<k>/id`, `/at/points/ids/<k>`).
        field: String,
        /// The id.
        id: String,
    },
    /// The axis of an `up_to` hole does not reach the face (`HOLE_UP_TO_MISSED`).
    #[error("the axis of hole {at:?} does not reach the up-to face")]
    UpToMissed {
        /// The position id.
        at: String,
    },
    /// A position's tool meets no target (`HOLE_MISSES_BODY`).
    #[error("hole {at:?} does not meet any target body")]
    MissesBody {
        /// The position id.
        at: String,
    },
    /// A value outside its range (`INVALID_VALUE`).
    #[error("{field} = {value} is invalid: must be {expected}")]
    InvalidValue {
        /// Field path relative to the feature (`/cbore/depth`).
        field: String,
        /// The value.
        value: f64,
        /// The valid range (with the numeric bound where one applies).
        expected: String,
    },
    /// A count outside its range (`INVALID_COUNT`).
    #[error("{field} = {value} is not a valid count: must be {expected}")]
    InvalidCount {
        /// Field path relative to the feature.
        field: String,
        /// The value.
        value: f64,
        /// The valid range (with the numeric bound where one applies).
        expected: String,
    },
    /// Neither `d` nor `size` (`HOLE_SIZE_REQUIRED`).
    #[error("a hole needs `d` or `size`")]
    SizeRequired {
        /// `/size`.
        field: String,
        /// The sizes.
        allowed: Vec<String>,
    },
    /// No `depth` and no `insert` (`HOLE_DEPTH_REQUIRED`).
    #[error("a hole needs `depth` (or `insert`)")]
    DepthRequired {
        /// `/depth`.
        field: String,
        /// The forms.
        allowed: Vec<String>,
    },
    /// Options that do not go together, or a preset without a verified table value
    /// (`HOLE_OPTIONS_CONFLICT`).
    #[error("hole option {field} conflicts: allowed {}", allowed.join(", "))]
    OptionsConflict {
        /// The field.
        field: String,
        /// What is allowed there (for a preset: the sizes that have it).
        allowed: Vec<String>,
    },
    /// The cut failed for a reason other than a miss.
    #[error(transparent)]
    Boolean(#[from] BooleanError),
    /// An `up_to` face this version cannot intersect (`FORGE_HOLE_UP_TO_UNSUPPORTED`).
    #[error("up-to faces of type {surface} are not supported yet")]
    UpToUnsupported {
        /// The face's surface type.
        surface: String,
    },
    /// The `on` face is not planar (`PLANE_NOT_PLANAR`, SPEC §3.1).
    #[error("the placement face is a {surface}, not a plane")]
    NotPlanar {
        /// The face's surface type.
        surface: String,
    },
    /// A tool body could not be built (`FORGE_HOLE_TOOL`).
    #[error("hole tool {at:?} could not be built: {reason}")]
    Tool {
        /// The position id.
        at: String,
        /// Why (the underlying code and message).
        reason: String,
    },
    /// More positions than this engine builds (`FORGE_HOLE_TOO_MANY_POSITIONS`).
    #[error("{field} asks for {value} hole positions; at most {max} are supported")]
    TooManyPositions {
        /// The placement field (`/at/grid`, `/at/circle/n`, `/at/list`, `/at/points/ids`).
        field: String,
        /// The number of positions asked for.
        value: f64,
        /// The most positions supported (`MAX_HOLE_POSITIONS`).
        max: f64,
    },
    /// Any other internal failure (`FORGE_HOLE_INTERNAL`).
    #[error("internal hole error: {0}")]
    Internal(String),
}

/// The `details` of a [`HoleError`] (SPEC §7.4), keys as in the catalogue.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum HoleErrorDetails {
    /// `HOLE_POINT_OFF_FACE`.
    OffFace {
        /// The position id.
        at: String,
        /// Distance (mm).
        distance: f64,
    },
    /// `HOLE_DUPLICATE_POSITION`, `HOLE_UP_TO_MISSED`, `HOLE_MISSES_BODY`.
    At {
        /// The position id.
        at: String,
    },
    /// `DUPLICATE_ID`.
    Id {
        /// The id used twice.
        id: String,
    },
    /// `INVALID_VALUE`, `INVALID_COUNT`.
    Range {
        /// Field path.
        field: String,
        /// The value.
        value: f64,
        /// The valid range (with the numeric bound where one applies).
        expected: String,
    },
    /// `HOLE_SIZE_REQUIRED`, `HOLE_DEPTH_REQUIRED`, `HOLE_OPTIONS_CONFLICT`.
    Allowed {
        /// The field.
        field: String,
        /// What is allowed.
        allowed: Vec<String>,
    },
    /// A boolean failure's own details.
    Boolean(BooleanErrorDetails),
    /// `FORGE_HOLE_UP_TO_UNSUPPORTED`, `PLANE_NOT_PLANAR`.
    Surface {
        /// The surface type.
        surface: String,
    },
    /// `FORGE_HOLE_TOOL`.
    Tool {
        /// The position id.
        at: String,
        /// Why.
        reason: String,
    },
    /// `FORGE_HOLE_TOO_MANY_POSITIONS`.
    Limit {
        /// The placement field.
        field: String,
        /// The number of positions asked for.
        value: f64,
        /// The most positions supported.
        max: f64,
    },
    /// `FORGE_HOLE_INTERNAL`.
    Internal {
        /// What failed.
        detail: String,
    },
}

impl HoleError {
    /// Stable machine-readable code.
    pub fn code(&self) -> &'static str {
        match self {
            HoleError::PointOffFace { .. } => "HOLE_POINT_OFF_FACE",
            HoleError::DuplicatePosition { .. } => "HOLE_DUPLICATE_POSITION",
            HoleError::DuplicateId { .. } => "DUPLICATE_ID",
            HoleError::UpToMissed { .. } => "HOLE_UP_TO_MISSED",
            HoleError::MissesBody { .. } => "HOLE_MISSES_BODY",
            HoleError::InvalidValue { .. } => "INVALID_VALUE",
            HoleError::InvalidCount { .. } => "INVALID_COUNT",
            HoleError::SizeRequired { .. } => "HOLE_SIZE_REQUIRED",
            HoleError::DepthRequired { .. } => "HOLE_DEPTH_REQUIRED",
            HoleError::OptionsConflict { .. } => "HOLE_OPTIONS_CONFLICT",
            HoleError::Boolean(e) => e.code(),
            HoleError::UpToUnsupported { .. } => "FORGE_HOLE_UP_TO_UNSUPPORTED",
            HoleError::NotPlanar { .. } => "PLANE_NOT_PLANAR",
            HoleError::Tool { .. } => "FORGE_HOLE_TOOL",
            HoleError::TooManyPositions { .. } => "FORGE_HOLE_TOO_MANY_POSITIONS",
            HoleError::Internal(_) => "FORGE_HOLE_INTERNAL",
        }
    }

    /// The structured `details` (SPEC §7.4).
    pub fn details(&self) -> HoleErrorDetails {
        match self {
            HoleError::PointOffFace { at, distance } => HoleErrorDetails::OffFace {
                at: at.clone(),
                distance: *distance,
            },
            HoleError::DuplicatePosition { at }
            | HoleError::UpToMissed { at }
            | HoleError::MissesBody { at } => HoleErrorDetails::At { at: at.clone() },
            HoleError::DuplicateId { id, .. } => HoleErrorDetails::Id { id: id.clone() },
            HoleError::InvalidValue {
                field,
                value,
                expected,
            }
            | HoleError::InvalidCount {
                field,
                value,
                expected,
            } => HoleErrorDetails::Range {
                field: field.clone(),
                value: *value,
                expected: expected.clone(),
            },
            HoleError::SizeRequired { field, allowed }
            | HoleError::DepthRequired { field, allowed }
            | HoleError::OptionsConflict { field, allowed } => HoleErrorDetails::Allowed {
                field: field.clone(),
                allowed: allowed.clone(),
            },
            HoleError::Boolean(e) => HoleErrorDetails::Boolean(e.details()),
            HoleError::UpToUnsupported { surface } | HoleError::NotPlanar { surface } => {
                HoleErrorDetails::Surface {
                    surface: surface.clone(),
                }
            }
            HoleError::Tool { at, reason } => HoleErrorDetails::Tool {
                at: at.clone(),
                reason: reason.clone(),
            },
            HoleError::TooManyPositions { field, value, max } => HoleErrorDetails::Limit {
                field: field.clone(),
                value: *value,
                max: *max,
            },
            HoleError::Internal(detail) => HoleErrorDetails::Internal {
                detail: detail.clone(),
            },
        }
    }

    pub(crate) fn internal(what: impl Into<String>) -> Self {
        HoleError::Internal(what.into())
    }
}
