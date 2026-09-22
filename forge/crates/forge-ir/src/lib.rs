//! # forge-ir — the Feature-Graph IR (v0)
//!
//! The IR is the single source of truth for a design. Forge (Rust), the TypeScript app
//! (via the generated JSON Schema), and the OCCT oracle (`oracle/`) all implement
//! **exactly** the semantics documented in `SPEC.md` next to this crate.
//!
//! v0 scope (Forge milestone F0): sketches made of lines / arcs / circles on a plane,
//! and `extrude` / `revolve` features that each create new bodies. Expressions,
//! constraints, booleans and references to faces arrive in later schema versions.

mod doc;
mod metrics;
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

#[derive(Debug, thiserror::Error)]
pub enum IrError {
    #[error("IR parse error: {0}")]
    Parse(serde_json::Error),
    #[error("IR validation failed: {}", .0.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("; "))]
    Invalid(Vec<ValidationError>),
}
