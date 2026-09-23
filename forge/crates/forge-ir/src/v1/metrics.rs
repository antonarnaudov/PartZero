//! The evaluation report `aicad.metrics/1` (SPEC-v1 §7, interface I5).
//!
//! Emitted by Forge (`aicad eval`) and the oracle for the same document, diffed per §8.2.
//! Deterministic: same document, same bytes, on every target.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::features::HoleSize;
use super::refs::{EntityKind, Query, Ref, Via};
use super::sketch::LiteralCurve;
use crate::P3;

fn is_false(b: &bool) -> bool {
    !*b
}

/// The whole report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EvalReport {
    /// Must equal [`super::METRICS_SCHEMA`].
    pub schema: String,
    /// Engine identifier, e.g. `forge 0.1.0` or `occt 7.8.1 (build123d 0.9)`.
    pub engine: String,
    /// Document name (`meta.name`, or the file stem).
    pub document: String,
    /// `ok` iff every parameter and every feature is ok (warnings never change it).
    pub status: Status,
    /// Set when the document was rejected (CLI exit 2): the first rejection, with every
    /// rejection in `details.errors` (`[{ code, path, message, details }]`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ReportError>,
    /// Present when the input was an `aicad.ir/0` document whose migration rewrote ids or
    /// names ([W0-12]): region `outer_curves`, feature names and ids in this report use the new
    /// values; `renames[].from` is untrusted data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration: Option<super::migrate::MigrationReport>,
    /// Every parameter (document ones first, then per part, in declaration order).
    #[serde(default)]
    pub params: Vec<ParamReport>,
    /// One entry per non-suppressed feature, in timeline order over all parts.
    pub features: Vec<FeatureReport>,
    /// The final bodies of each part (§6.0.5), in part order.
    #[serde(default)]
    pub parts: Vec<PartReport>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    Error,
}

/// A machine-readable error (§7.4): a stable code, a message for people, and structured
/// `details` whose keys are listed per code in the catalogue (`ERROR_CODES` in
/// `ir-v1.constants.json`). Details never contain arena ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReportError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: serde_json::Map<String, serde_json::Value>,
}

/// A warning or info (§7.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Warning {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    #[serde(default)]
    pub details: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Expected, informational (never blocks).
    Info,
    /// Probably unintended but well-defined (the agent's L1 check explains it).
    Warning,
}

/// A parameter's evaluated value or error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ParamReport {
    pub name: String,
    /// `"doc"` for document parameters, else the part's name.
    pub scope: String,
    pub unit: super::params::ParamUnit,
    /// Absent when the parameter failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<ParamOut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ReportError>,
}

/// An evaluated parameter value (`-0` is reported as `0`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ParamOut {
    Bool(bool),
    Num(f64),
}

/// One feature's result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeatureReport {
    /// Part name.
    pub part: String,
    /// Feature name.
    pub feature: String,
    pub feature_id: String,
    #[serde(rename = "type")]
    pub feature_type: String,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ReportError>,
    /// In the order raised.
    #[serde(default)]
    pub warnings: Vec<Warning>,
    /// Sketches: the regions found, in canonical region order (v0 §4.1).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub regions: Vec<crate::RegionMetrics>,
    /// Sketches: the solve block (§4.4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sketch: Option<SketchReport>,
    /// Datum features: the evaluated frame or axis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub datum: Option<DatumReport>,
    /// Body features: the bodies created or modified, in canonical order (§6.0.5).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bodies: Vec<BodyReport>,
    /// Body features: the origins of consumed bodies.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed: Vec<Origin>,
    /// Features with Ref fields: one entry per Ref-valued field, in field order (§5.8).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<RefReport>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub holes: Vec<HoleReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fillet: Option<BlendReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chamfer: Option<BlendReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<ShellReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<PatternReport>,
}

// ---- sketches -------------------------------------------------------------------------------

/// Sketch mode (§4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SketchMode {
    Explicit,
    Constrained,
}

/// forge-solve's overall status (`SolveStatus`), same spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SolveStatus {
    UnderConstrained,
    FullyConstrained,
    OverConstrainedRedundant,
    Conflict,
    FailedToConverge,
}

/// The sketch block (§4.4): what the regions were built from, and the solver's verdict.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SketchReport {
    pub mode: SketchMode,
    /// Constrained mode only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<SolveStatus>,
    /// Constrained mode only: remaining degrees of freedom.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dof: Option<u32>,
    /// The literal geometry the regions were built from: compound curves expanded into their
    /// members, expressions evaluated, constrained sketches solved (arcs mapped back through
    /// the `ccw` rule). The oracle replays this for constrained sketches (§8.1).
    pub solved: Vec<LiteralCurve>,
    /// Dimension constraints, in constraint order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dimensions: Vec<DimensionReport>,
}

/// A dimension's evaluated and measured values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DimensionReport {
    pub id: String,
    pub driving: bool,
    /// The evaluated `value` (driving dimensions only), mm or degrees.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    /// Measured at the solution, mm or degrees.
    pub measured: f64,
}

// ---- datums and bodies ------------------------------------------------------------------------

/// An evaluated datum.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum DatumReport {
    Plane(DatumFrame),
    Axis(DatumLine),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DatumFrame {
    pub origin: P3,
    pub x: P3,
    pub y: P3,
    pub normal: P3,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DatumLine {
    pub origin: P3,
    pub direction: P3,
}

/// A body's identity (§5.2 rule 4): the feature that created it and the byte-wise smallest
/// curve id of its region's outer loop at creation; pattern copies add their instance.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Origin {
    pub feature: String,
    pub member: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 2))]
    pub instance: Option<Vec<u32>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BodyChange {
    Created,
    Modified,
}

/// Body metrics: v0 §5 plus `origin`, `change` and `shells`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BodyReport {
    pub origin: Origin,
    /// Feature entries only (absent in `parts[].bodies`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change: Option<BodyChange>,
    /// mm³, exact geometry.
    pub volume: f64,
    /// mm², exact geometry.
    pub area: f64,
    pub centroid: P3,
    pub bbox_min: P3,
    pub bbox_max: P3,
    pub faces: u32,
    /// Excluding seam edges.
    pub edges: u32,
    /// Closed shells (2 for a body with an internal void).
    pub shells: u32,
    pub face_types: BTreeMap<String, u32>,
    pub edge_types: BTreeMap<String, u32>,
    /// The engine's own validity check.
    pub valid: bool,
}

/// The final state of one part.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PartReport {
    /// Part name.
    pub part: String,
    pub part_id: String,
    /// In canonical order (§5.4).
    pub bodies: Vec<BodyReport>,
}

// ---- references (§5.8) -----------------------------------------------------------------------

/// A probe (§7.6): locates an entity without persisting it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Probe {
    pub kind: EntityKind,
    pub point: P3,
    /// Faces: the outward normal at `point`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normal: Option<P3>,
}

/// A reference's outcome (§5.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RefStatus {
    /// Exact resolution; no report entries.
    Exact,
    /// Used, with warnings or infos only.
    Accepted,
    /// The feature fails with the reference's code.
    Failed,
}

/// A resolved member's outcome (§5.7 steps 3–4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemberStatus {
    Exact,
    Merged,
    NeighborhoodChanged,
    KindChanged,
    Split,
    Repaired,
}

/// Why a named member did not resolve (§5.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum UnresolvedReason {
    NameNotFound,
    FacesNoLongerMeet,
    Split,
    SplitPiece,
    Tie,
    NoPlausibleMatch,
    FeatureSuppressed,
}

/// Why a candidate is offered (§5.7 step 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CandidateReason {
    /// Geometry-identical (confidence `IDENTICAL_MATCH_CONFIDENCE`).
    Identical,
    /// A piece of a split target.
    SplitPiece,
    /// Best fingerprint score ≥ `MIN_PLAUSIBLE`.
    Plausible,
    /// Within `TIE_MARGIN` of the best.
    Tie,
}

/// One member of a resolved reference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RefMember {
    /// Provenance key (never containing `#index`).
    pub key: String,
    /// Display name (feature ids replaced by names; `#k` display indices allowed here only).
    pub name: String,
    pub via: Via,
    pub status: MemberStatus,
    pub probe: Probe,
}

/// A candidate for an unresolved member.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub key: String,
    pub name: String,
    pub confidence: f64,
    pub reason: CandidateReason,
    pub probe: Probe,
    /// A synthesised query that selects exactly this candidate (SHOULD).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<Query>,
}

/// A named member that did not resolve, with up to `MAX_CANDIDATES` candidates, best first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Unresolved {
    pub key: String,
    pub name: String,
    pub reason: UnresolvedReason,
    pub candidates: Vec<Candidate>,
}

/// The report entry of one Ref-valued field (§5.8).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RefReport {
    /// JSON pointer of the field relative to the feature, e.g. `/edges`, `/on/face`.
    pub field: String,
    pub status: RefStatus,
    /// The failing code (`REF_*`, `DEPENDENCY_FAILED`) when `status` is `failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// The resolved set, in canonical order.
    pub members: Vec<RefMember>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unresolved: Vec<Unresolved>,
    /// Broad members added since the capture (`REF_SET_CHANGED`), keys.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added: Vec<String>,
    /// Broad members removed since the capture, keys.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed: Vec<String>,
    /// For `REF_REPAIRED` / `REF_SET_CHANGED`: the rewritten reference (query and fresh
    /// capture) that `acceptRefProposal` applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal: Option<Ref>,
}

// ---- per-feature summaries --------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HoleKind {
    Simple,
    Counterbore,
    Countersink,
    Insert,
}

/// One hole instance (§6.5), in position order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HoleReport {
    /// Position id.
    pub at: String,
    pub center: P3,
    /// The drilling direction `d`.
    pub axis: P3,
    /// Hole diameter.
    pub d: f64,
    /// Depth to the shoulder, or `null` for a through hole.
    #[schemars(schema_with = "nullable_number", required)]
    pub depth: Option<f64>,
    pub kind: HoleKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<HoleSize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cbore: Option<CboreOut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub csink: Option<CsinkOut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insert: Option<CboreOut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<ThreadOut>,
}

fn nullable_number(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    // `type: [..]` (not `anyOf`) marks a field that is nullable on purpose: the v1 schema
    // post-processing strips `null` alternatives from every `anyOf` (see `super::strip_nulls`).
    schemars::json_schema!({ "type": ["number", "null"], "format": "double" })
}

/// Counterbore or insert dimensions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CboreOut {
    pub d: f64,
    pub depth: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CsinkOut {
    pub d: f64,
    /// Included angle, degrees.
    pub angle: f64,
}

/// A cosmetic thread (no geometry).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ThreadOut {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<HoleSize>,
    pub pitch: f64,
    /// Thread depth, or `null` for the full (through) depth.
    #[schemars(schema_with = "nullable_number", required)]
    pub depth: Option<f64>,
}

/// Fillet and chamfer summary (§6.6, §6.7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BlendReport {
    /// Keys of the blended edges (the reference's members, then `chain_added`).
    pub edges: Vec<String>,
    /// Keys added by tangent-chain expansion (not part of the reference).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chain_added: Vec<String>,
    /// Keys of the blend and corner faces created.
    pub faces_created: Vec<String>,
}

/// Shell summary (§6.8).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ShellReport {
    /// Keys of the opened (removed) faces.
    pub removed_faces: Vec<String>,
    /// A closed shell (no open face) made an internal void.
    #[serde(default, skip_serializing_if = "is_false")]
    pub closed_void: bool,
}

/// Pattern summary (§6.10).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PatternReport {
    /// Non-seed instances the layout defines, minus `skip`.
    pub instances: u32,
    /// Instances skipped with `PATTERN_INSTANCE_SKIPPED`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped: Vec<Vec<u32>>,
}
