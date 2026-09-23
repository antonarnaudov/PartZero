//! # forge-ir — the Feature-Graph IR (v0)
//!
//! The IR is the single source of truth for a design. Forge (Rust), the TypeScript app
//! (via the generated JSON Schema), and the OCCT oracle (`oracle/`) all implement
//! **exactly** the semantics documented in `SPEC.md` next to this crate.
//!
//! v0 scope (Forge milestone F0): sketches made of lines / arcs / circles on a plane,
//! and `extrude` / `revolve` features that each create new bodies. Expressions,
//! constraints, booleans and references to faces arrive in later schema versions.
//!
//! IR v1 (`aicad.ir/1`: parameters, expressions, constrained and compound sketches, datums,
//! references, booleans, holes, blends, patterns) lives in [`v1`], next to v0, with its own
//! normative draft `SPEC-v1-DRAFT.md`. [`VersionedDocument`] loads either version.

mod doc;
mod metrics;
pub mod v1;
mod validate;

pub use doc::*;
pub use metrics::*;
pub use validate::{ValidationError, validate};

/// Schema identifier written into every IR document.
pub const IR_SCHEMA: &str = "aicad.ir/0";
/// Schema identifier written into every evaluation report.
pub const METRICS_SCHEMA: &str = "aicad.metrics/0";

/// Linear tolerance of the IR semantics, in mm. Two sketch points closer than this are
/// the same point; lengths at or below it are degenerate. Part of the normative spec.
pub const LINEAR_TOLERANCE: f64 = 1e-6;

/// Names a feature may not have: ECMAScript/TypeScript reserved words, globals CadScript
/// refuses to shadow, and the CadScript v0 builtins. Mirrored by `@aicad/cadscript`
/// (a TS test reads `schema/ir-v0.constants.json`, written by the `dump_schema` example).
#[rustfmt::skip]
pub const RESERVED_NAMES: &[&str] = &[
    // ECMAScript reserved words
    "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
    "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in",
    "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
    "typeof", "var", "void", "while", "with",
    // strict mode / module code
    "implements", "interface", "let", "package", "private", "protected", "public", "static",
    "yield", "await", "arguments", "eval",
    // globals that must not be shadowed
    "undefined", "NaN", "Infinity", "globalThis",
    // CadScript v0 builtins
    "doc", "part", "sketch", "line", "arc", "circle", "extrude", "revolve", "frame", "XY", "XZ",
    "YZ",
];

/// Parse and validate an IR document from JSON text.
pub fn from_json(text: &str) -> Result<Document, IrError> {
    let doc: Document = serde_json::from_str(text).map_err(IrError::Parse)?;
    validate(&doc).map_err(IrError::Invalid)?;
    Ok(doc)
}

/// Serialize a document to canonical (stable, pretty) JSON.
pub fn to_json(doc: &Document) -> String {
    serde_json::to_string_pretty(doc).expect("IR documents are always serializable")
}

/// JSON Schema for [`Document`] (consumed by the TS codegen and the oracle).
pub fn document_schema() -> serde_json::Value {
    serde_json::to_value(schemars::schema_for!(Document)).expect("schema serializes")
}

/// JSON Schema for [`EvalReport`].
pub fn report_schema() -> serde_json::Value {
    serde_json::to_value(schemars::schema_for!(EvalReport)).expect("schema serializes")
}

/// An IR document of either schema version.
#[derive(Debug, Clone, PartialEq)]
pub enum VersionedDocument {
    /// `aicad.ir/0`, validated with the v0 rules.
    V0(Document),
    /// `aicad.ir/1`, validated with the v1 rules.
    V1(v1::Document),
}

impl VersionedDocument {
    /// Parse and validate a document of either version, dispatching on `schema`. A v0 document
    /// is rejected with exactly the v0 codes and paths (SPEC-v1 §9.1); an unknown schema is
    /// `UNSUPPORTED_SCHEMA` at `/schema`.
    pub fn from_json(text: &str) -> Result<Self, v1::LoadError> {
        Self::from_json_with(text, &v1::ValidateOptions::default())
    }

    /// [`VersionedDocument::from_json`] with v1 validation options.
    pub fn from_json_with(
        text: &str,
        opts: &v1::ValidateOptions<'_>,
    ) -> Result<Self, v1::LoadError> {
        // Dispatch on `schema`. v0 keeps serde_json's parser (bit-for-bit v0 behavior); v1 is
        // read with the correctly rounded reader of `v1::json` (SPEC-v1 §0.4).
        let value: serde_json::Value =
            serde_json::from_str(text).map_err(|e| v1::LoadError::Parse {
                path: None,
                message: e.to_string(),
            })?;
        let schema = value
            .get("schema")
            .and_then(|s| s.as_str())
            .map(str::to_owned);
        match schema.as_deref() {
            Some(IR_SCHEMA) => {
                let doc: Document =
                    serde_json::from_str(text).map_err(|e| v1::LoadError::Parse {
                        path: None,
                        message: e.to_string(),
                    })?;
                validate(&doc).map_err(|errs| {
                    v1::LoadError::Invalid(
                        errs.into_iter().map(v1::ValidationError::from).collect(),
                    )
                })?;
                Ok(VersionedDocument::V0(doc))
            }
            Some(v1::IR_SCHEMA) => {
                let exact = v1::json::parse(text).map_err(|e| v1::LoadError::Parse {
                    path: None,
                    message: e.to_string(),
                })?;
                v1::load_v1_value(exact, opts).map(VersionedDocument::V1)
            }
            other => Err(v1::LoadError::Invalid(vec![v1::ValidationError::new(
                "UNSUPPORTED_SCHEMA",
                "/schema",
                format!(
                    "expected {IR_SCHEMA:?} or {:?}, got {}",
                    v1::IR_SCHEMA,
                    other
                        .map(|s| format!("{s:?}"))
                        .unwrap_or_else(|| "no schema string".into())
                ),
                serde_json::json!({ "found": other, "supported": [IR_SCHEMA, v1::IR_SCHEMA] }),
            )])),
        }
    }

    /// The document as v1: a v0 document is migrated (SPEC-v1 §9.1); v1 is returned unchanged.
    pub fn into_v1(self) -> v1::Document {
        match self {
            VersionedDocument::V0(d) => v1::migrate_v0_to_v1(&d),
            VersionedDocument::V1(d) => d,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum IrError {
    #[error("IR parse error: {0}")]
    Parse(serde_json::Error),
    #[error("IR validation failed: {}", .0.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("; "))]
    Invalid(Vec<ValidationError>),
}
