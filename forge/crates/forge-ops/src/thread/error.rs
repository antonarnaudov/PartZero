//! Structured thread failures (stable codes, machine-readable details for repair hints).

use serde::Serialize;
use thiserror::Error;

/// A modelled thread could not be built. Nothing is ever returned instead of a thread
/// that did not pass the checks: every configuration outside the supported set is one of
/// these, naming the entity and, where there is one, the feasible range.
#[derive(Debug, Clone, PartialEq, Error, Serialize)]
/// Serializes as its details object (the variant's fields); the code is [`ThreadError::code`].
#[serde(untagged)]
pub enum ThreadError {
    /// A thread value is out of range (`pitch`, `major`, `starts`, `length`).
    #[error("{field} = {value} is invalid: expected {expected}")]
    InvalidValue {
        /// The field (a JSON pointer in the feature, or the form's field name).
        field: String,
        /// The rejected value.
        value: f64,
        /// The valid range, human-readable.
        expected: String,
    },
    /// The cylinder's diameter does not fit the thread form: an internal thread needs a bore
    /// between the form's `min_d` and its major diameter, an external one a boss between
    /// its minor diameter and `max_d` (so that both crest and root flats exist).
    #[error(
        "the {kind} thread {designation} needs a crest diameter in [{min_d}, {max_d}] mm, the face has {d} mm"
    )]
    DiameterMismatch {
        /// `internal` or `external`.
        kind: &'static str,
        /// The form, e.g. `D 12.7 × P 1.27`.
        designation: String,
        /// The face's diameter.
        d: f64,
        /// Smallest feasible crest diameter.
        min_d: f64,
        /// Largest feasible crest diameter.
        max_d: f64,
    },
    /// The face is not a threadable cylinder band: a cylinder coaxial with the thread,
    /// bounded by exactly two full circles (no slot, cross hole or break-out through it).
    #[error("face {face} cannot be threaded: {reason}")]
    FaceUnsupported {
        /// Provenance name of the face.
        face: String,
        /// Why.
        reason: String,
    },
    /// The thread runs past the cylinder face.
    #[error(
        "the thread spans [{start}, {end}] mm along its axis but face {face} spans [{face_start}, {face_end}] mm"
    )]
    LengthOutOfRange {
        /// Provenance name of the face.
        face: String,
        /// Requested start along the axis.
        start: f64,
        /// Requested end along the axis.
        end: f64,
        /// The face's start along the axis.
        face_start: f64,
        /// The face's end along the axis.
        face_end: f64,
    },
    /// A thread end lies closer to the face's boundary circle than the margin but not on
    /// it: end it on the circle (the feasible `length`) or clearly inside.
    #[error(
        "the thread ends {distance} mm from the end of face {face}; end it there or at least {margin} mm before"
    )]
    EndTooClose {
        /// Provenance name of the face.
        face: String,
        /// Distance from the thread end to the face's boundary circle.
        distance: f64,
        /// The margin.
        margin: f64,
    },
    /// The face that meets the threaded cylinder at a thread end is not supported there (a
    /// plane across the axis, or a coaxial cone on the far side, are).
    #[error("the thread cannot end on face {face}: {reason}")]
    EndUnsupported {
        /// Provenance name of the neighbouring face.
        face: String,
        /// Why.
        reason: String,
    },
    /// Another face of the body reaches into the thread's region (a wall thinner than the
    /// thread depth, a cross hole, a slot): the groove would break through it.
    #[error(
        "face {face} comes within the thread's region (radius {r_in}..{r_out} mm, axial {z_start}..{z_end} mm)"
    )]
    Interference {
        /// Provenance name of the interfering face (or, at an end, of the plane that cannot
        /// hold the groove's section).
        face: String,
        /// Inner radius of the region.
        r_in: f64,
        /// Outer radius of the region.
        r_out: f64,
        /// Axial start of the region.
        z_start: f64,
        /// Axial end of the region.
        z_end: f64,
    },
    /// An internal consistency check failed (a bug): the built body did not validate.
    #[error("internal error building the thread: {detail}")]
    Internal {
        /// What failed.
        detail: String,
    },
}

impl ThreadError {
    /// Stable machine-readable code.
    pub fn code(&self) -> &'static str {
        match self {
            ThreadError::InvalidValue { .. } => "THREAD_INVALID_VALUE",
            ThreadError::DiameterMismatch { .. } => "THREAD_DIAMETER_MISMATCH",
            ThreadError::FaceUnsupported { .. } => "THREAD_FACE_UNSUPPORTED",
            ThreadError::LengthOutOfRange { .. } => "THREAD_LENGTH_OUT_OF_RANGE",
            ThreadError::EndTooClose { .. } => "THREAD_END_TOO_CLOSE",
            ThreadError::EndUnsupported { .. } => "THREAD_END_UNSUPPORTED",
            ThreadError::Interference { .. } => "THREAD_INTERFERENCE",
            ThreadError::Internal { .. } => "FORGE_THREAD_INTERNAL",
        }
    }
    pub(crate) fn internal(detail: impl Into<String>) -> Self {
        ThreadError::Internal {
            detail: detail.into(),
        }
    }
}
