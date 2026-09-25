//! # IR v1 (`aicad.ir/1`) — the frozen W0 contract (interfaces I1, I5)
//!
//! Normative semantics: `SPEC-v1-DRAFT.md` next to this crate (rules `[D-n]`, W0 resolutions
//! `[W0-n]`). v0 (`crate::Document`, `aicad.ir/0`) stays untouched; v1 engines accept v0
//! documents by migrating them ([`migrate_v0_to_v1`], [`from_json`]).
//!
//! | Module | Contents |
//! |---|---|
//! | [`scalar`] | `Scalar = number \| string`, `BoolScalar`, field types |
//! | [`params`] | parameters |
//! | [`sketch`] | curves (incl. compound `rect`/`slot`/`polygon`), constraints (forge-solve vocabulary) |
//! | [`planes`] | `PlaneRef`, `AxisRef`, `PointRef`, `Dir` |
//! | [`refs`] | `Ref`, the query AST, predicates, captures |
//! | [`features`] | one struct per feature type |
//! | [`metrics`] | the `aicad.metrics/1` report (I5) |
//! | [`expr`] | the hook where W1's parser/type checker plugs into validation |
//! | [`compound`], [`degtrig`], [`holes`] | normative compound-curve expansion, degree trig, `HOLE_SIZES` |
//! | [`codes`] | the error-code catalogue of SPEC §7.5 |

pub mod canonical;
pub mod codes;
pub mod compound;
pub mod degtrig;
pub mod expr;
pub mod features;
pub mod holes;
pub mod ids;
pub mod json;
pub mod metrics;
pub mod migrate;
pub mod params;
pub mod planes;
mod precheck;
pub mod refs;
pub mod scalar;
pub mod sketch;
pub mod validate;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub use canonical::canonicalize;
pub use features::*;
pub use migrate::{
    IdRename, MigrationReport, NotV0Surface, RenameKind, downgrade_to_v0, migrate_v0_to_v1,
    migrate_v0_to_v1_report,
};
pub use params::*;
pub use planes::*;
pub use refs::*;
pub use scalar::*;
pub use sketch::*;
pub use validate::{ValidateOptions, ValidationError, validate, validate_with};

use crate::{Meta, Units};

/// Schema identifier of every v1 IR document.
pub const IR_SCHEMA: &str = "aicad.ir/1";
/// Schema identifier of every v1 evaluation report.
pub const METRICS_SCHEMA: &str = "aicad.metrics/1";

// ---- tolerances (SPEC-v1 §1) ----------------------------------------------------------------

/// Coincidence, degeneracy and point-on-entity tolerance, mm (v0).
pub const LINEAR_TOLERANCE: f64 = 1e-6;
/// Surface/curve classification and frame perpendicularity, rad (v0).
pub const ANGULAR_TOLERANCE: f64 = 1e-9;
/// Query predicates `normal`, `parallel`, `perpendicular`, `convex`/`concave`, rad.
pub const QUERY_ANGLE_TOLERANCE: f64 = 1e-6;
/// Tangent-chain propagation of fillets and chamfers, rad.
pub const TANGENT_CHAIN_TOLERANCE: f64 = 1e-6;
/// Relative tie tolerance of `largest` / `smallest`.
pub const QUERY_SIZE_TIE_REL: f64 = 1e-9;
/// A driving constraint holds (forge-solve `SolveOptions::tolerance`), mm.
pub const SOLVE_TOLERANCE: f64 = 1e-10;
/// The oracle's independent constraint check of a replayed solution, mm.
pub const SOLVE_CHECK_TOLERANCE: f64 = 1e-9;
/// A non-exact reference resolution may be used without confirmation at or above this.
pub const AUTO_ACCEPT_CONFIDENCE: f64 = 0.95;
/// Confidence of a geometry-identical match.
pub const IDENTICAL_MATCH_CONFIDENCE: f64 = 0.99;
/// Cap for every other non-exact match.
pub const MAX_DISAMBIGUATION_CONFIDENCE: f64 = 0.9;
/// Candidates below this are not offered.
pub const MIN_PLAUSIBLE: f64 = 0.35;
/// Candidates within this fraction of the best are a tie.
pub const TIE_MARGIN: f64 = 0.1;
/// Candidates listed per unresolved member.
pub const MAX_CANDIDATES: u32 = 6;
/// Diff tolerance for real-valued parameters (relative).
pub const PARAM_VALUE_REL: f64 = 1e-12;
/// Maximum expression length in bytes (§2.3; `EXPR_SYNTAX` beyond).
pub const MAX_EXPR_BYTES: usize = 4096;
/// Maximum expression nesting depth (§2.3; `EXPR_SYNTAX` beyond).
pub const MAX_EXPR_DEPTH: u32 = 64;
/// Largest magnitude of a `count` value (§2.7 rule 9).
pub const MAX_COUNT_MAGNITUDE: f64 = 2147483648.0;

/// The names v1 adds to [`crate::RESERVED_NAMES`] (SPEC-v1 §9.3): the CadScript v1 builtins.
#[rustfmt::skip]
pub const RESERVED_NAMES_V1_BUILTINS: &[&str] = &[
    "param", "measure", "point", "rect", "slot", "polygon", "hole", "grid", "boltCircle",
    "fillet", "chamfer", "shell", "draft", "boolean", "linearPattern", "circularPattern",
    "mirror", "datumPlane", "datumAxis", "tag", "edgesBetween", "faceOf", "body", "bodies",
    "min", "max", "abs", "sqrt", "floor", "ceil", "round", "clamp", "hypot", "sin", "cos", "tan",
    "asin", "acos", "atan", "atan2", "PI", "mm", "cm", "inch", "deg", "X", "Y", "Z", "C",
    // Amendment set F (feature tools).
    "transform",
];

/// The full v1 `RESERVED_NAMES` list: v0's list followed by [`RESERVED_NAMES_V1_BUILTINS`].
/// IR validation applies it to **parameter** names; feature names are checked against the v0
/// list only, so that migrated v0 documents stay valid ([W0-2]).
pub fn reserved_names() -> Vec<&'static str> {
    crate::RESERVED_NAMES
        .iter()
        .chain(RESERVED_NAMES_V1_BUILTINS)
        .copied()
        .collect()
}

// ---- document ---------------------------------------------------------------------------------

/// An IR v1 document (`aicad.ir/1`): the single source of truth for a design.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Document {
    /// Must equal [`IR_SCHEMA`].
    pub schema: String,
    #[serde(default, skip_serializing_if = "Meta::is_empty")]
    #[schemars(extend("default" = {}))]
    pub meta: Meta,
    #[serde(default, skip_serializing_if = "Units::is_default")]
    #[schemars(extend("default" = { "length": "mm", "angle": "deg" }))]
    pub units: Units,
    /// Document-level parameters (§2.1), in declaration order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(extend("default" = []))]
    pub params: Vec<Parameter>,
    pub parts: Vec<PartStudio>,
}

/// An ordered feature timeline that produces a set of bodies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PartStudio {
    pub id: String,
    pub name: String,
    /// Part-level parameters (§2.1), in declaration order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(extend("default" = []))]
    pub params: Vec<Parameter>,
    pub features: Vec<Feature>,
}

// ---- loading and printing ---------------------------------------------------------------------

/// Why a document could not be loaded.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum LoadError {
    /// Not JSON, or not the shape of the schema (unknown field, wrong JSON type, `null`, …).
    /// `path` is known for the raw pre-checks (e.g. `null` values), not for serde errors.
    #[error("IR parse error{}: {message}", path.as_ref().map(|p| format!(" at {p}")).unwrap_or_default())]
    Parse {
        path: Option<String>,
        message: String,
    },
    /// Rejected with coded problems (SPEC-v1 §0.5 rule 1), every problem found.
    #[error("IR validation failed: {}", .0.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("; "))]
    Invalid(Vec<ValidationError>),
}

impl LoadError {
    /// The coded problems (empty for parse errors).
    pub fn errors(&self) -> &[ValidationError] {
        match self {
            LoadError::Invalid(e) => e,
            LoadError::Parse { .. } => &[],
        }
    }
}

/// Parse and validate an IR document of **either** version (SPEC-v1 §0.2 rule 4): an
/// `aicad.ir/0` document is validated with the v0 rules (same codes and paths) and migrated
/// (§9.1); an `aicad.ir/1` document goes through the rejection pipeline of §0.5 ([W0-1]):
/// raw pre-checks → typed parse → [`validate`].
pub fn from_json(text: &str) -> Result<Document, LoadError> {
    from_json_with(text, &ValidateOptions::default())
}

/// [`from_json`] with explicit validation options (engine capabilities, the W1 expression hook).
pub fn from_json_with(text: &str, opts: &ValidateOptions<'_>) -> Result<Document, LoadError> {
    match crate::VersionedDocument::from_json_with(text, opts)? {
        crate::VersionedDocument::V0(d) => Ok(migrate_v0_to_v1(&d)),
        crate::VersionedDocument::V1(d) => Ok(d),
    }
}

pub(crate) fn load_v1_value(
    value: serde_json::Value,
    opts: &ValidateOptions<'_>,
) -> Result<Document, LoadError> {
    let pre = precheck::precheck(&value);
    if let Some(p) = pre.parse {
        return Err(p);
    }
    if !pre.errors.is_empty() {
        return Err(LoadError::Invalid(pre.errors));
    }
    let doc: Document = serde_json::from_value(value).map_err(|e| LoadError::Parse {
        path: None,
        message: e.to_string(),
    })?;
    validate_with(&doc, opts).map_err(LoadError::Invalid)?;
    Ok(doc)
}

/// Serialize a document to canonical JSON (§0.4): stable, pretty, every stated default omitted
/// (including a Ref `card` equal to its field's default).
pub fn to_json(doc: &Document) -> String {
    let mut d = doc.clone();
    canonicalize(&mut d);
    serde_json::to_string_pretty(&d).expect("IR documents are always serializable")
}

/// IR v1 fields are never nullable: an absent optional field is omitted, never `null`. schemars
/// renders `Option<T>` as `anyOf: [T, {type: null}]`; this collapses every such `anyOf` to `T`
/// (keeping sibling keywords such as `description` and `default`). Fields that are nullable on
/// purpose use `type: [..., "null"]` and are left alone.
fn strip_nulls(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(o) => {
            if let Some(serde_json::Value::Array(alts)) = o.get("anyOf") {
                let null = serde_json::json!({ "type": "null" });
                if alts.len() == 2 && alts.contains(&null) {
                    let other = alts
                        .iter()
                        .find(|a| **a != null)
                        .cloned()
                        .expect("two alternatives");
                    o.remove("anyOf");
                    if let serde_json::Value::Object(inner) = other {
                        for (k, x) in inner {
                            o.entry(k).or_insert(x);
                        }
                    }
                }
            }
            o.values_mut().for_each(strip_nulls);
        }
        serde_json::Value::Array(a) => a.iter_mut().for_each(strip_nulls),
        _ => {}
    }
}

fn schema_of<T: JsonSchema>() -> serde_json::Value {
    let mut v = serde_json::to_value(schemars::schema_for!(T)).expect("schema serializes");
    strip_nulls(&mut v);
    v
}

/// JSON Schema of [`Document`] (`schema/ir-v1.schema.json`).
pub fn document_schema() -> serde_json::Value {
    schema_of::<Document>()
}

/// JSON Schema of [`metrics::EvalReport`] (`schema/metrics-v1.schema.json`).
pub fn report_schema() -> serde_json::Value {
    schema_of::<metrics::EvalReport>()
}

/// The contents of `schema/ir-v1.constants.json`: schema ids, tolerances, reserved names, the
/// feature and constraint vocabularies, the error-code catalogue and `HOLE_SIZES`.
pub fn constants_json() -> serde_json::Value {
    serde_json::json!({
        "IR_SCHEMA": IR_SCHEMA,
        "METRICS_SCHEMA": METRICS_SCHEMA,
        "LINEAR_TOLERANCE": LINEAR_TOLERANCE,
        "ANGULAR_TOLERANCE": ANGULAR_TOLERANCE,
        "QUERY_ANGLE_TOLERANCE": QUERY_ANGLE_TOLERANCE,
        "TANGENT_CHAIN_TOLERANCE": TANGENT_CHAIN_TOLERANCE,
        "QUERY_SIZE_TIE_REL": QUERY_SIZE_TIE_REL,
        "SOLVE_TOLERANCE": SOLVE_TOLERANCE,
        "SOLVE_CHECK_TOLERANCE": SOLVE_CHECK_TOLERANCE,
        "AUTO_ACCEPT_CONFIDENCE": AUTO_ACCEPT_CONFIDENCE,
        "IDENTICAL_MATCH_CONFIDENCE": IDENTICAL_MATCH_CONFIDENCE,
        "MAX_DISAMBIGUATION_CONFIDENCE": MAX_DISAMBIGUATION_CONFIDENCE,
        "MIN_PLAUSIBLE": MIN_PLAUSIBLE,
        "TIE_MARGIN": TIE_MARGIN,
        "MAX_CANDIDATES": MAX_CANDIDATES,
        "PARAM_VALUE_REL": PARAM_VALUE_REL,
        "MAX_EXPR_BYTES": MAX_EXPR_BYTES,
        "MAX_EXPR_DEPTH": MAX_EXPR_DEPTH,
        "MAX_COUNT_MAGNITUDE": MAX_COUNT_MAGNITUDE,
        "ID_PATTERN": ids::ID_PATTERN,
        "MAX_ID_LEN": ids::MAX_ID_LEN,
        "MAX_REF_SEGMENTS": ids::MAX_REF_SEGMENTS,
        "RESERVED_NAMES": reserved_names(),
        "RESERVED_NAMES_V0": crate::RESERVED_NAMES,
        "RESERVED_NAMES_V1_BUILTINS": RESERVED_NAMES_V1_BUILTINS,
        "FEATURE_TYPES": FEATURE_TYPES,
        "FEATURE_VERSIONS": FEATURE_TYPES.iter().map(|t| (t.to_string(), serde_json::json!(defined_versions(t)))).collect::<serde_json::Map<_, _>>(),
        "CONSTRAINT_TYPES": CONSTRAINT_TYPES,
        "DIMENSION_TYPES": DIMENSION_TYPES,
        "PARAM_UNITS": ParamUnit::ALL,
        "ERROR_CODES": codes::catalogue_json(),
        "HOLE_SIZES": holes::hole_sizes_json(),
    })
}
