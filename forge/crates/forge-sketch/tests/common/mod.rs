//! Shared helpers for the forge-sketch tests.

#![allow(dead_code)]

use std::collections::BTreeMap;

use forge_core::linalg::Frame;
use forge_ir::v1::{Feature, SketchCurve, SketchFeature};
use forge_sketch::{ResolvedValues, SketchError, SketchResult, evaluate_sketch};
use serde_json::Value;

/// The repository root (`forge/crates/forge-sketch/../../..`).
pub fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root")
}

/// A v1 sketch feature from JSON text (a sketch feature object).
pub fn sketch(json: Value) -> SketchFeature {
    serde_json::from_value(json).expect("valid sketch feature JSON")
}

/// The first sketch feature of a v1 corpus program, and the document's parameter values
/// (literal document parameters only).
pub fn program_sketch(rel: &str) -> (SketchFeature, BTreeMap<String, f64>) {
    let text = std::fs::read_to_string(repo_root().join(rel)).expect("program");
    let doc = forge_ir::v1::from_json(&text).expect("valid v1 program");
    let params = doc
        .params
        .iter()
        .filter_map(|p| match &p.value {
            forge_ir::v1::ParamValue::Num(v) => Some((p.name.clone(), *v)),
            _ => None,
        })
        .collect();
    let s = doc.parts[0]
        .features
        .iter()
        .find_map(|f| match f {
            Feature::Sketch(s) => Some(s.clone()),
            _ => None,
        })
        .expect("a sketch");
    (s, params)
}

/// Evaluate with a map of parameter values (sites that are one parameter name).
pub fn eval_params(
    s: &SketchFeature,
    params: &BTreeMap<String, f64>,
) -> Result<SketchResult, SketchError> {
    let v = ResolvedValues::from_params(s, params);
    evaluate_sketch(s, &v, &Frame::world())
}

/// Evaluate a sketch without expressions.
pub fn eval(s: &SketchFeature) -> Result<SketchResult, SketchError> {
    evaluate_sketch(s, &ResolvedValues::new(), &Frame::world())
}

/// Detail keys the SPEC documents as optional, per code (SPEC-v1 §7.5): `EXPR_SYNTAX`'s
/// `expr` is present only when the text lexes ([W0-12]). No other code the sketch pipeline
/// raises has an optional key.
const OPTIONAL_KEYS: &[(&str, &str)] = &[("EXPR_SYNTAX", "expr")];

/// Every error and warning must carry exactly the catalogue's detail keys for its code
/// (SPEC-v1 §7.5): every listed key present (except documented optional ones), no other key.
/// The engine's own `FORGE_` codes have no catalogue entry.
pub fn assert_catalogue_details(code: &str, details: &serde_json::Map<String, Value>) {
    if code.starts_with("FORGE_") {
        return;
    }
    let info = forge_ir::v1::codes::info(code).unwrap_or_else(|| panic!("{code} not in catalogue"));
    for key in details.keys() {
        assert!(
            info.details.contains(&key.as_str()),
            "{code}: detail key {key:?} not in the catalogue's {:?}",
            info.details
        );
    }
    for key in info.details {
        assert!(
            details.contains_key(*key) || OPTIONAL_KEYS.contains(&(code, *key)),
            "{code}: catalogue key {key:?} missing from {details:?}"
        );
    }
}

/// The error's report object must follow the catalogue.
pub fn assert_error_conforms(e: &SketchError) {
    let r = e.to_report_error();
    assert_eq!(r.code, e.code());
    assert!(!r.message.is_empty());
    assert_catalogue_details(&r.code, &r.details);
}

/// Every warning must follow the catalogue.
pub fn assert_warnings_conform(r: &SketchResult) {
    for w in &r.warnings {
        assert_catalogue_details(&w.code, &w.details);
        let info = forge_ir::v1::codes::info(&w.code).expect("catalogued");
        let sev = match w.severity {
            forge_ir::v1::metrics::Severity::Info => "I",
            forge_ir::v1::metrics::Severity::Warning => "W",
        };
        assert_eq!(info.stage, sev, "{}", w.code);
    }
}

/// The region-stage codes of v0 §3 (forge-ops).
pub const REGION_CODES: [&str; 5] = [
    "SKETCH_OPEN_LOOP",
    "SKETCH_BRANCHING",
    "SKETCH_CURVES_CROSS",
    "SKETCH_DEGENERATE_LOOP",
    "SKETCH_NO_REGIONS",
];

/// Every curve as construction geometry (for sketches whose profile is not a set of loops:
/// the solve is exercised, the region stage is skipped).
pub fn all_construction(s: &SketchFeature) -> SketchFeature {
    let mut s = s.clone();
    for c in &mut s.curves {
        match c {
            SketchCurve::Line { construction, .. }
            | SketchCurve::Arc { construction, .. }
            | SketchCurve::Circle { construction, .. }
            | SketchCurve::Point { construction, .. }
            | SketchCurve::Rect { construction, .. }
            | SketchCurve::Slot { construction, .. }
            | SketchCurve::Polygon { construction, .. } => *construction = true,
        }
    }
    s
}
