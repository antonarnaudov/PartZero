//! The error-code catalogue of SPEC-v1 §7.5 [D-53] (plus the v0 codes v1 keeps), as data.
//!
//! Emitted into `schema/ir-v1.constants.json` as `ERROR_CODES`, so that the agent playbooks
//! (W10), the oracle (W7) and CadScript (W8) read one list. Every code that
//! [`super::validate`] can return is in the catalogue with a stage containing `R` (a test
//! enforces it).

/// One catalogue entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodeInfo {
    /// The stable code.
    pub code: &'static str,
    /// `R` rejected (exit 2); `E` evaluation error; `R/E` rejected when every input is literal,
    /// evaluation error when an expression is involved (§0.5); `W` warning; `I` info.
    pub stage: &'static str,
    /// The SPEC section that defines it.
    pub section: &'static str,
    /// The keys of `details`.
    pub details: &'static [&'static str],
    /// `v0` (kept from IR v0), `v1`, or `v1.1` (deferred: measured parameters).
    pub since: &'static str,
}

const fn c(
    code: &'static str,
    stage: &'static str,
    section: &'static str,
    details: &'static [&'static str],
    since: &'static str,
) -> CodeInfo {
    CodeInfo {
        code,
        stage,
        section,
        details,
        since,
    }
}

/// The catalogue, grouped as in SPEC-v1 §7.5.
#[rustfmt::skip]
pub const CATALOGUE: &[CodeInfo] = &[
    // ---- v0 codes kept by v1 --------------------------------------------------------------
    c("UNSUPPORTED_SCHEMA", "R", "§0.2", &["found", "supported"], "v0"),
    c("NO_PARTS", "R", "v0 §0", &[], "v0"),
    c("DUPLICATE_ID", "R", "§0.3", &["id"], "v0"),
    c("DUPLICATE_NAME", "R", "§0.3", &["name"], "v0"),
    c("INVALID_NAME", "R", "§0.3", &["path", "reason", "length"], "v0"),
    c("RESERVED_NAME", "R", "§0.3", &["name"], "v0"),
    c("UNRESOLVED_SKETCH", "R", "§6.2", &["sketch"], "v0"),
    c("EMPTY_SKETCH", "R", "v0 §3", &["sketch"], "v0"),
    c("NON_FINITE", "R", "v0 §3", &["field"], "v0"),
    c("DEGENERATE_CURVE", "R/E", "§4.2", &["curve", "reason"], "v0"),
    c("INCONSISTENT_ARC", "R/E", "§4.2", &["curve", "r_start", "r_end"], "v0"),
    c("INVALID_DISTANCE", "R/E", "§6.2", &["field", "value", "expected"], "v0"),
    c("INVALID_ANGLE", "R/E", "§6.3", &["field", "value", "expected"], "v0"),
    c("INVALID_AXIS", "R/E", "§6.3", &["field", "value", "expected"], "v0"),
    c("INVALID_PLANE", "R/E", "§3.1", &["field", "reason"], "v0"),
    c("SKETCH_OPEN_LOOP", "E", "v0 §3", &["curve", "end", "point"], "v0"),
    c("SKETCH_BRANCHING", "E", "v0 §3", &["curve", "end", "point", "partners"], "v0"),
    c("SKETCH_CURVES_CROSS", "E", "v0 §3, §4.4", &["first", "second", "point"], "v0"),
    c("SKETCH_DEGENERATE_LOOP", "E", "v0 §3", &["curves", "area"], "v0"),
    c("SKETCH_NO_REGIONS", "E", "v0 §3", &[], "v0"),
    c("SKETCH_SUPPRESSED", "E", "§7.1", &["sketch"], "v0"),
    c("REVOLVE_CROSSES_AXIS", "E", "v0 §4.3", &["outer_curves", "min", "max", "tolerance"], "v0"),
    c("INVALID_RESULT", "E", "§7.1", &["issues"], "v0"),
    // ---- v1 rejections ------------------------------------------------------------------------
    c("UNSUPPORTED_FEATURE", "R", "§0.2", &["type", "supported"], "v1"),
    c("UNSUPPORTED_FEATURE_VERSION", "R", "§0.2", &["type", "v", "supported"], "v1"),
    c("INVALID_ID", "R", "§0.3", &["path", "reason", "length"], "v1"),
    c("UNRESOLVED_FEATURE", "R", "§0.3", &["id", "field", "expected"], "v1"),
    c("EXPR_SYNTAX", "R", "§2.3", &["offset", "expected", "length", "expr"], "v1"),
    c("EXPR_UNKNOWN_NAME", "R", "§2.8", &["name", "is_feature", "similar"], "v1"),
    c("EXPR_UNKNOWN_FUNCTION", "R", "§2.6", &["name", "similar"], "v1"),
    c("EXPR_ARITY", "R", "§2.6", &["name", "expected", "found"], "v1"),
    c("EXPR_UNIT_MISMATCH", "R", "§2.5", &["expr", "subexpr", "expected", "found"], "v1"),
    c("EXPR_TYPE_MISMATCH", "R", "§2.5", &["expr", "subexpr", "expected", "found"], "v1"),
    c("EXPR_SCOPE", "R", "§2.8", &["name", "part"], "v1"),
    c("PARAM_INVALID", "R", "§2.1", &["name", "reason", "allowed"], "v1"),
    c("PARAM_CYCLE", "R", "§2.8", &["cycle"], "v1"),
    c("SKETCH_MIXED_MODE", "R", "§4.2", &["sketch", "path"], "v1"),
    c("CONSTRAINT_VALUE_ON_REFERENCE", "R", "§4.3", &["constraint"], "v1"),
    c("CONSTRAINT_VALUE_REQUIRED", "R", "§4.3", &["constraint"], "v1"),
    c("SKETCH_UNKNOWN_REFERENCE", "R", "§4.3", &["owner", "reference"], "v1"),
    c("SKETCH_WRONG_ENTITY_TYPE", "R", "§4.3", &["owner", "reference", "expected", "found"], "v1"),
    c("SKETCH_NOT_A_DIMENSION", "R", "§4.3", &["id"], "v1"),
    c("SKETCH_UNSUPPORTED_COMBINATION", "R", "§4.3", &["id", "kind", "a", "b"], "v1"),
    c("SKETCH_SELF_REFERENCE", "R", "§4.3", &["id", "reference"], "v1"),
    c("CURVE_OPTIONS_CONFLICT", "R", "§4.1", &["curve", "fields"], "v1"),
    c("REF_KIND_MISMATCH", "R", "§5.1", &["field", "expected", "found"], "v1"),
    c("QUERY_INVALID", "R", "§5.4", &["path", "expected", "found"], "v1"),
    c("QUERY_UNKNOWN_CURVE", "R", "§5.3", &["feature", "curve", "similar"], "v1"),
    c("INVALID_CARDINALITY", "R", "§5.5", &["field", "allowed"], "v1"),
    c("BOOLEAN_TARGETS_REQUIRED", "R", "§6.0.2", &["feature"], "v1"),
    c("HOLE_SIZE_UNKNOWN", "R", "§6.5", &["field", "allowed"], "v1"),
    c("HOLE_SIZE_REQUIRED", "R", "§6.5", &["field", "allowed"], "v1"),
    c("HOLE_OPTIONS_CONFLICT", "R", "§6.5", &["field", "allowed"], "v1"),
    c("HOLE_DEPTH_REQUIRED", "R", "§6.5", &["field", "allowed"], "v1"),
    c("CHAMFER_OPTIONS_CONFLICT", "R", "§6.7", &["fields"], "v1"),
    c("PATTERN_SEED_UNSUPPORTED", "R", "§6.10", &["seed", "type"], "v1"),
    c("PATTERN_OPTIONS_CONFLICT", "R", "§6.10", &["fields"], "v1"),
    c("DATUM_OPTIONS_CONFLICT", "R", "§3.3, §3.4", &["mode", "fields"], "v1"),
    // ---- range checks: rejected on literals, evaluation errors on expressions (§0.5) ----------
    c("INVALID_RADIUS", "R/E", "§6.6", &["field", "value", "expected"], "v1"),
    c("INVALID_COUNT", "R/E", "§2.7", &["field", "value", "expected"], "v1"),
    c("INVALID_VALUE", "R/E", "§0.5", &["field", "value", "expected"], "v1"),
    c("EXPR_NOT_INTEGER", "R/E", "§2.7", &["expr", "value"], "v1"),
    c("PARAM_OUT_OF_RANGE", "R/E", "§2.1", &["name", "value", "min", "max"], "v1"),
    c("SKETCH_INVALID_DIMENSION", "R/E", "§4.4", &["constraint", "value"], "v1"),
    // ---- evaluation errors ------------------------------------------------------------------
    c("EXPR_DOMAIN", "E", "§2.7", &["expr", "subexpr", "operands"], "v1"),
    c("PARAM_FAILED", "E", "§2.8", &["param", "code"], "v1"),
    c("DEPENDENCY_FAILED", "E", "§5.7, §7.1", &["feature", "code", "message"], "v1"),
    c("DEPENDENCY_SUPPRESSED", "E", "§7.1", &["feature"], "v1"),
    c("PLANE_NOT_PLANAR", "E", "§3.1", &["surface"], "v1"),
    c("PLANE_DEGENERATE", "E", "§3.1", &["x_dir"], "v1"),
    c("AXIS_REF_UNSUPPORTED", "E", "§3.2", &["type"], "v1"),
    c("DATUM_DEGENERATE", "E", "§3.3, §3.4", &["reason", "angle_deg"], "v1"),
    c("REGION_NOT_FOUND", "E", "§4.5", &["curve"], "v1"),
    c("SKETCH_CONSTRAINT_CONFLICT", "E", "§4.4", &["conflicts"], "v1"),
    c("SKETCH_SOLVE_FAILED", "E", "§4.4", &["max_residual", "clusters"], "v1"),
    c("REF_MISSING", "E", "§5.5, §5.7", &["field", "unresolved"], "v1"),
    c("REF_AMBIGUOUS", "E", "§5.5, §5.7", &["field", "unresolved"], "v1"),
    c("REF_SPLIT", "E", "§5.7", &["field", "unresolved"], "v1"),
    c("REF_UNCERTAIN", "E", "§5.7", &["field", "unresolved"], "v1"),
    c("REF_CARDINALITY", "E", "§5.5", &["field", "expected", "found"], "v1"),
    c("BOOLEAN_NO_INTERSECTION", "E", "§6.0.3", &["tool", "min_distance"], "v1"),
    c("BOOLEAN_EMPTY_RESULT", "E", "§6.0.3", &["targets"], "v1"),
    c("BOOLEAN_NON_MANIFOLD", "E", "§6.0.3", &["probe"], "v1"),
    c("BOOLEAN_TOOL_IS_TARGET", "E", "§6.4", &["origin"], "v1"),
    c("HOLE_POINT_OFF_FACE", "E", "§6.5", &["at", "distance"], "v1"),
    c("HOLE_DUPLICATE_POSITION", "E", "§6.5", &["at"], "v1"),
    c("HOLE_UP_TO_MISSED", "E", "§6.5", &["at"], "v1"),
    c("HOLE_MISSES_BODY", "E", "§6.5", &["at"], "v1"),
    c("FILLET_RADIUS_TOO_LARGE", "E", "§6.6", &["r", "max_feasible_r", "edges"], "v1"),
    c("FILLET_EDGE_UNSUPPORTED", "E", "§6.6", &["edges"], "v1"),
    c("FILLET_FAILED", "E", "§6.6", &["edges", "reason"], "v1"),
    c("CHAMFER_DISTANCE_TOO_LARGE", "E", "§6.7", &["d", "max_feasible_d", "edges"], "v1"),
    c("CHAMFER_EDGE_UNSUPPORTED", "E", "§6.7", &["edges"], "v1"),
    c("CHAMFER_SIDE_NOT_ADJACENT", "E", "§6.7", &["edges"], "v1"),
    c("CHAMFER_FAILED", "E", "§6.7", &["edges", "reason"], "v1"),
    c("SHELL_THICKNESS_TOO_LARGE", "E", "§6.8", &["thickness", "max_feasible_thickness", "limits"], "v1"),
    c("SHELL_FACE_NOT_ON_BODY", "E", "§6.8", &["faces"], "v1"),
    c("SHELL_FAILED", "E", "§6.8", &["reason"], "v1"),
    c("DRAFT_FACE_UNSUPPORTED", "E", "§6.9", &["faces"], "v1"),
    c("DRAFT_FAILED", "E", "§6.9", &["faces"], "v1"),
    c("PATTERN_ALL_INSTANCES_FAILED", "E", "§6.10", &["instances"], "v1"),
    // ---- warnings and infos -----------------------------------------------------------------
    c("SKETCH_UNDER_CONSTRAINED", "I", "§4.4", &["dof", "entities"], "v1"),
    c("SKETCH_REDUNDANT_CONSTRAINTS", "W", "§4.4", &["redundant"], "v1"),
    c("SKETCH_LOOP_FLIPPED", "W", "§4.4", &["curves"], "v1"),
    c("REF_REPAIRED", "I", "§5.7", &["field", "key", "into", "proposal"], "v1"),
    c("REF_MERGED", "I", "§5.7", &["field", "key", "into"], "v1"),
    c("REF_SPLIT_ACCEPTED", "I", "§5.7", &["field", "key", "pieces"], "v1"),
    c("REF_SET_CHANGED", "W", "§5.7", &["field", "added", "removed", "proposal"], "v1"),
    c("REF_KIND_CHANGED", "W", "§5.7", &["field", "key", "was", "now"], "v1"),
    c("REF_NEIGHBORHOOD_CHANGED", "W", "§5.7", &["field", "key", "was", "now"], "v1"),
    c("BOOLEAN_SPLIT", "I", "§6.0.3", &["origin", "pieces"], "v1"),
    c("BOOLEAN_BODY_CONSUMED", "W", "§6.0.3", &["origin"], "v1"),
    c("HOLE_BREAKS_THROUGH", "W", "§6.5", &["at"], "v1"),
    c("PATTERN_INSTANCE_SKIPPED", "W", "§6.10", &["index", "code"], "v1"),
    c("SHELL_CLOSED_VOID", "I", "§6.8", &[], "v1"),
    // ---- deferred to IR v1.1 (measured parameters, ADR 0013 decision 5) -------------------------
    c("MEASURE_NOT_REFERENCE", "R", "§2.1", &["name", "sketch", "constraint"], "v1.1"),
    c("MEASURE_UNIT_MISMATCH", "R", "§2.1", &["name", "sketch", "constraint"], "v1.1"),
    c("MEASURE_FORWARD", "R", "§2.8", &["name", "sketch", "constraint"], "v1.1"),
];

/// Look up a code.
pub fn info(code: &str) -> Option<&'static CodeInfo> {
    CATALOGUE.iter().find(|c| c.code == code)
}

/// The catalogue as `{ CODE: { stage, section, details, since } }` (sorted by code).
pub fn catalogue_json() -> serde_json::Value {
    let map: std::collections::BTreeMap<&str, serde_json::Value> = CATALOGUE
        .iter()
        .map(|c| {
            (
                c.code,
                serde_json::json!({
                    "stage": c.stage,
                    "section": c.section,
                    "details": c.details,
                    "since": c.since,
                }),
            )
        })
        .collect();
    serde_json::to_value(map).expect("catalogue serializes")
}
