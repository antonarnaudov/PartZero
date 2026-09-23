//! Structured boolean errors (SPEC §6.0.3, §7.4, §7.5).
//!
//! Semantic failures use the SPEC codes (`BOOLEAN_NO_INTERSECTION`,
//! `BOOLEAN_EMPTY_RESULT`, `BOOLEAN_NON_MANIFOLD`, `BOOLEAN_TOOL_IS_TARGET`) with exactly the
//! detail keys of the `ERROR_CODES` catalogue. Engine-internal failures keep the `FORGE_`
//! prefix (SPEC §7.5, v0 [R-12]) and carry the diagnostics an agent or a developer needs:
//! the SSI code and point, the entity (by provenance name, never by arena id) and the
//! measured value against its limit. No failure is ever turned into a silently wrong body.

use forge_ir::v1::EntityKind;
use forge_ir::v1::metrics::{Origin, Probe};
use serde::Serialize;
use thiserror::Error;

/// A boolean body operation failed.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum BooleanError {
    /// A join or cut tool neither overlaps nor shares a face of positive area with any
    /// target (join), or meets no target's interior (cut).
    #[error(
        "tool {} does not meet any target (minimum distance {min_distance:e} mm)",
        origin_name(tool)
    )]
    NoIntersection {
        /// The tool's origin.
        tool: Origin,
        /// Smallest distance between the tool and the targets (mm): exactly 0 when they
        /// touch (known from the intersection). Otherwise an **upper bound** (deviation from
        /// a certified minimum, SPEC §6.0.3 says "min_distance"): the closest pair among
        /// vertices, edge samples and face-grid samples of each body and their closest points
        /// on the other, refined by alternating closest points (a local minimum, exact for
        /// the usual closest features: vertex, edge or face against face, edge or vertex).
        min_distance: f64,
    },
    /// Every target of an `intersect` became empty.
    #[error("the intersection is empty for every target")]
    EmptyResult {
        /// The targets' origins.
        targets: Vec<Origin>,
    },
    /// The result touches itself only along an edge or at a vertex.
    #[error("the result is non-manifold near ({}, {}, {})", probe.point[0], probe.point[1], probe.point[2])]
    NonManifold {
        /// Where: an edge or vertex probe of the contact, with `normal: None`. Deviation from
        /// SPEC §7.6 (whose probes locate entities of a *result*; this result is not
        /// built): an edge probe is the middle of the parameter range of the edge piece
        /// used four times, or of the contact curve (a section piece or an edge lying in
        /// the other operand's face) when two join components touch; a vertex probe is the
        /// vertex position (a fan split at a vertex, shells sharing a vertex) or the
        /// tangent contact point. Every probe lies on the contact within the tolerance.
        probe: Probe,
    },
    /// A body is both a target and a tool.
    #[error("body {} is both a target and a tool", origin_name(origin))]
    ToolIsTarget {
        /// Its origin.
        origin: Origin,
    },
    /// Surface–surface or curve–surface intersection failed (`FORGE_BOOLEAN_SSI`).
    #[error("intersection of {what} failed: {ssi_code} ({message})")]
    Ssi {
        /// The SSI error code (`SSI_TANGENT_UNRESOLVED`, …).
        ssi_code: &'static str,
        /// The SSI message (contains the point and measured values).
        message: String,
        /// Which entities (provenance names).
        what: String,
        /// Where it failed and the measured value against its limit (boxed: keeps the
        /// error small).
        diag: Box<SsiDiagnostics>,
    },
    /// Two faces of the operands are near-coincident in a way the boolean does not resolve
    /// (`FORGE_BOOLEAN_NEAR_COINCIDENT`, `near`): SPEC [R-3] makes faces within 1e-6 mm
    /// coincident and the boolean snaps operand B onto A by a translation of at most that;
    /// this error remains when no translation does it (faces within the tolerance that
    /// differ in radius or angle, conflicting conditions), and for a failure that follows
    /// from distinct faces the boolean cannot separate (closer than `limit` = 1e-5 mm over
    /// their whole overlap, including faces crossing at a tiny angle). `offset` is the
    /// largest separation measured over the overlap; `reason` says which case it is. Move
    /// one face by at least `limit`, or make them coincide exactly.
    #[error(
        "near-coincident faces {entities}: {reason}; separation up to {offset:e} mm (faces at most 1e-6 mm apart are coincident, at least {limit:e} mm apart distinct)"
    )]
    NearCoincident {
        /// The two entities (provenance names).
        entities: String,
        /// Largest separation measured over their overlap (mm).
        offset: f64,
        /// Separation from which the boolean resolves distinct geometry reliably (mm).
        limit: f64,
        /// A point where they are that close.
        point: [f64; 3],
        /// Which case: not snappable, conflicting, or not separable (with the failed
        /// check's code), and the angle when the faces cross.
        reason: String,
    },
    /// An operand list is empty (`FORGE_BOOLEAN_NO_OPERANDS`): a `targets` or `tools`
    /// reference with cardinality `any` resolved to no body. SPEC §6.0.3 does not define
    /// the operation then; it is reported instead of guessed.
    #[error("the boolean has no {role}")]
    NoOperands {
        /// `"targets"` or `"tools"`.
        role: &'static str,
    },
    /// The configuration is outside what the boolean supports yet
    /// (`FORGE_BOOLEAN_UNSUPPORTED`), e.g. B-spline or horn-torus surfaces.
    #[error("unsupported boolean input: {what} ({entity})")]
    Unsupported {
        /// What is unsupported.
        what: &'static str,
        /// The entity (provenance name).
        entity: String,
    },
    /// An internal consistency check failed (`FORGE_BOOLEAN_INCONSISTENT`): the
    /// intersection graph, the face arrangement or the classification contradicts
    /// itself. Reported instead of a possibly wrong body.
    #[error("boolean consistency check failed: {detail} ({entity})")]
    Inconsistent {
        /// Which check.
        detail: String,
        /// The entity (provenance name) or point involved.
        entity: String,
    },
    /// The assembled result failed Forge's validity checks
    /// (`FORGE_BOOLEAN_INVALID_RESULT`).
    #[error("boolean result is invalid: {}", issues.join("; "))]
    InvalidResult {
        /// The issues, entities named by provenance.
        issues: Vec<String>,
    },
}

/// Where an intersection failed and by how much.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SsiDiagnostics {
    /// Where it failed (3D), when the SSI error has a point.
    pub point: Option<[f64; 3]>,
    /// The measured quantity (gap, residual, achieved fit error; mm), when it has one.
    pub measured: Option<f64>,
    /// The limit the measured quantity was compared against (mm), when it has one.
    pub limit: Option<f64>,
}

fn origin_name(o: &Origin) -> String {
    match &o.instance {
        Some(i) => format!(
            "{}/{}@{}",
            o.feature,
            o.member,
            i.iter().map(u32::to_string).collect::<Vec<_>>().join(".")
        ),
        None => format!("{}/{}", o.feature, o.member),
    }
}

/// The `details` object of a [`BooleanError`] (SPEC §7.4): exactly the keys of the
/// `ERROR_CODES` catalogue for the semantic codes, diagnostics for the `FORGE_` ones.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum BooleanErrorDetails {
    /// `BOOLEAN_NO_INTERSECTION`.
    NoIntersection {
        /// The tool's origin.
        tool: Origin,
        /// mm.
        min_distance: f64,
    },
    /// `BOOLEAN_EMPTY_RESULT`.
    EmptyResult {
        /// The targets' origins.
        targets: Vec<Origin>,
    },
    /// `BOOLEAN_NON_MANIFOLD`.
    NonManifold {
        /// Where.
        probe: Probe,
    },
    /// `BOOLEAN_TOOL_IS_TARGET`.
    ToolIsTarget {
        /// The body's origin.
        origin: Origin,
    },
    /// `FORGE_BOOLEAN_SSI`.
    Ssi {
        /// The SSI code.
        ssi_code: &'static str,
        /// Entities.
        what: String,
        /// The SSI message.
        message: String,
        /// Where (3D), if known.
        point: Option<[f64; 3]>,
        /// Measured value (mm), if any.
        measured: Option<f64>,
        /// Its limit (mm), if any.
        limit: Option<f64>,
    },
    /// `FORGE_BOOLEAN_NEAR_COINCIDENT`.
    NearCoincident {
        /// Entities.
        entities: String,
        /// Largest separation over the overlap (mm).
        offset: f64,
        /// mm.
        limit: f64,
        /// Where.
        point: [f64; 3],
        /// Which case.
        reason: String,
    },
    /// `FORGE_BOOLEAN_NO_OPERANDS`.
    NoOperands {
        /// `"targets"` or `"tools"`.
        role: &'static str,
    },
    /// `FORGE_BOOLEAN_UNSUPPORTED`, `FORGE_BOOLEAN_INCONSISTENT`.
    Internal {
        /// What failed.
        detail: String,
        /// Entity.
        entity: String,
    },
    /// `FORGE_BOOLEAN_INVALID_RESULT`.
    InvalidResult {
        /// Issues.
        issues: Vec<String>,
    },
}

impl BooleanError {
    /// Stable machine-readable code.
    pub fn code(&self) -> &'static str {
        match self {
            BooleanError::NoIntersection { .. } => "BOOLEAN_NO_INTERSECTION",
            BooleanError::EmptyResult { .. } => "BOOLEAN_EMPTY_RESULT",
            BooleanError::NonManifold { .. } => "BOOLEAN_NON_MANIFOLD",
            BooleanError::ToolIsTarget { .. } => "BOOLEAN_TOOL_IS_TARGET",
            BooleanError::Ssi { .. } => "FORGE_BOOLEAN_SSI",
            BooleanError::NearCoincident { .. } => "FORGE_BOOLEAN_NEAR_COINCIDENT",
            BooleanError::NoOperands { .. } => "FORGE_BOOLEAN_NO_OPERANDS",
            BooleanError::Unsupported { .. } => "FORGE_BOOLEAN_UNSUPPORTED",
            BooleanError::Inconsistent { .. } => "FORGE_BOOLEAN_INCONSISTENT",
            BooleanError::InvalidResult { .. } => "FORGE_BOOLEAN_INVALID_RESULT",
        }
    }

    /// The structured `details` (SPEC §7.4).
    pub fn details(&self) -> BooleanErrorDetails {
        match self {
            BooleanError::NoIntersection { tool, min_distance } => {
                BooleanErrorDetails::NoIntersection {
                    tool: tool.clone(),
                    min_distance: *min_distance,
                }
            }
            BooleanError::EmptyResult { targets } => BooleanErrorDetails::EmptyResult {
                targets: targets.clone(),
            },
            BooleanError::NonManifold { probe } => BooleanErrorDetails::NonManifold {
                probe: probe.clone(),
            },
            BooleanError::ToolIsTarget { origin } => BooleanErrorDetails::ToolIsTarget {
                origin: origin.clone(),
            },
            BooleanError::Ssi {
                ssi_code,
                what,
                message,
                diag,
            } => BooleanErrorDetails::Ssi {
                ssi_code,
                what: what.clone(),
                message: message.clone(),
                point: diag.point,
                measured: diag.measured,
                limit: diag.limit,
            },
            BooleanError::NearCoincident {
                entities,
                offset,
                limit,
                point,
                reason,
            } => BooleanErrorDetails::NearCoincident {
                entities: entities.clone(),
                offset: *offset,
                limit: *limit,
                point: *point,
                reason: reason.clone(),
            },
            BooleanError::NoOperands { role } => BooleanErrorDetails::NoOperands { role },
            BooleanError::Unsupported { what, entity } => BooleanErrorDetails::Internal {
                detail: (*what).to_string(),
                entity: entity.clone(),
            },
            BooleanError::Inconsistent { detail, entity } => BooleanErrorDetails::Internal {
                detail: detail.clone(),
                entity: entity.clone(),
            },
            BooleanError::InvalidResult { issues } => BooleanErrorDetails::InvalidResult {
                issues: issues.clone(),
            },
        }
    }

    /// `true` for the semantic (SPEC) codes, `false` for engine-internal failures.
    pub fn is_semantic(&self) -> bool {
        self.code().starts_with("BOOLEAN_")
    }

    pub(crate) fn inconsistent(detail: impl Into<String>, entity: impl Into<String>) -> Self {
        BooleanError::Inconsistent {
            detail: detail.into(),
            entity: entity.into(),
        }
    }

    pub(crate) fn ssi(e: &forge_ssi::SsiError, what: impl Into<String>) -> Self {
        use forge_ssi::SsiError as S;
        let (point, measured, limit) = match e {
            S::TangentUnresolved { point, gap, .. } => (Some(*point), Some(*gap), None),
            S::NotConverged {
                point, residual, ..
            } => (Some(*point), Some(*residual), None),
            S::FitFailed {
                achieved, required, ..
            } => (None, Some(*achieved), Some(*required)),
            S::Inconsistent { point, .. } => (Some(*point), None, None),
            S::InvalidDomain { lo, hi, .. } => (None, Some(hi - lo), None),
            S::InvalidTolerance { value, .. } => (None, Some(*value), None),
            S::BudgetExceeded { limit, .. } => (None, None, Some(*limit as f64)),
            S::Unsupported { .. } => (None, None, None),
        };
        BooleanError::Ssi {
            ssi_code: e.code(),
            message: e.to_string(),
            what: what.into(),
            diag: Box::new(SsiDiagnostics {
                point,
                measured,
                limit,
            }),
        }
    }

    pub(crate) fn non_manifold(kind: EntityKind, point: [f64; 3]) -> Self {
        BooleanError::NonManifold {
            probe: Probe {
                kind,
                point,
                normal: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin() -> Origin {
        Origin {
            feature: "e2".into(),
            member: "c".into(),
            instance: None,
        }
    }

    #[test]
    fn semantic_details_have_exactly_the_catalogue_keys() {
        let cases: Vec<(BooleanError, &[&str])> = vec![
            (
                BooleanError::NoIntersection {
                    tool: origin(),
                    min_distance: 2.5,
                },
                &["min_distance", "tool"],
            ),
            (
                BooleanError::EmptyResult {
                    targets: vec![origin()],
                },
                &["targets"],
            ),
            (
                BooleanError::non_manifold(EntityKind::Edge, [1.0, 2.0, 3.0]),
                &["probe"],
            ),
            (BooleanError::ToolIsTarget { origin: origin() }, &["origin"]),
        ];
        for (e, keys) in cases {
            let v = serde_json::to_value(e.details()).expect("serialize");
            let mut got: Vec<String> = v.as_object().expect("object").keys().cloned().collect();
            got.sort();
            assert_eq!(got, keys.to_vec(), "{}", e.code());
            let entry = forge_ir::v1::codes::info(e.code()).expect("code in catalogue");
            let mut want: Vec<String> = entry.details.iter().map(|s| s.to_string()).collect();
            want.sort();
            assert_eq!(got, want, "{} details vs ERROR_CODES", e.code());
            assert!(e.is_semantic());
        }
    }

    #[test]
    fn internal_codes_are_forge_prefixed() {
        let e = BooleanError::inconsistent("edge used 3 times", "e1/edge:{a|b}");
        assert_eq!(e.code(), "FORGE_BOOLEAN_INCONSISTENT");
        assert!(!e.is_semantic());
        assert!(e.to_string().contains("edge used 3 times"));
        let e = BooleanError::NoOperands { role: "tools" };
        assert_eq!(e.code(), "FORGE_BOOLEAN_NO_OPERANDS");
        assert!(!e.is_semantic());
        let v = serde_json::to_value(e.details()).expect("serialize");
        assert_eq!(v["role"], "tools");
    }

    /// The SSI details carry the point and the measured value against its limit, not only
    /// the code.
    #[test]
    fn ssi_details_carry_point_and_measured_values() {
        let e = BooleanError::ssi(
            &forge_ssi::SsiError::TangentUnresolved {
                point: [1.0, 2.0, 3.0],
                uv_a: [0.0; 2],
                uv_b: [0.0; 2],
                gap: 2e-8,
                extent: 1e-3,
                branch_ends: 2,
            },
            "face a × face b",
        );
        assert_eq!(e.code(), "FORGE_BOOLEAN_SSI");
        let v = serde_json::to_value(e.details()).expect("serialize");
        assert_eq!(v["ssi_code"], "SSI_TANGENT_UNRESOLVED");
        assert_eq!(v["point"], serde_json::json!([1.0, 2.0, 3.0]));
        assert_eq!(v["measured"], 2e-8);
        assert!(v["message"].as_str().expect("message").contains("gap"));
        let e = BooleanError::ssi(
            &forge_ssi::SsiError::FitFailed {
                what: "3d curve",
                achieved: 3e-7,
                required: 1e-7,
                spans: 64,
            },
            "x",
        );
        let v = serde_json::to_value(e.details()).expect("serialize");
        assert_eq!(
            (v["measured"].as_f64(), v["limit"].as_f64()),
            (Some(3e-7), Some(1e-7))
        );
        let e = BooleanError::NearCoincident {
            entities: "a/cap:end × b/cap:end".into(),
            offset: 1e-7,
            limit: 1e-5,
            point: [0.0; 3],
            reason: "test".into(),
        };
        assert_eq!(e.code(), "FORGE_BOOLEAN_NEAR_COINCIDENT");
        let v = serde_json::to_value(e.details()).expect("serialize");
        assert_eq!(v["offset"], 1e-7);
    }
}
