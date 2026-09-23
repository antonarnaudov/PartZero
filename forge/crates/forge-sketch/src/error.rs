//! Structured sketch evaluation errors (SPEC-v1 §4, §7.4, §7.5).
//!
//! Every variant has a stable catalogue [`SketchError::code`], structured
//! [`SketchError::details`] with the keys the catalogue lists for that code, and (where a field
//! is at fault) the feature-relative JSON pointer of that field ([`SketchError::path`]).
//! [`SketchError::to_report_error`] builds the `error` object of the sketch's report entry.
//!
//! A failed sketch has **no geometry a consumer may use** (SPEC-v1 §4.4 rule 6, "no stale
//! fallback"): no error carries regions, profile curves or a solution. The solver's diagnosis
//! travels along for UIs and agents ([`SolveDiagnosis`], on `SKETCH_CONSTRAINT_CONFLICT` and
//! `SKETCH_SOLVE_FAILED`), and it **does** hold coordinates: `solver_input` is the welded
//! stored guess as forge-solve received it (the stale geometry itself), and `solver`'s
//! `measured` values are taken on the geometry forge-solve returned. They are diagnostic data
//! for display only — rule 6 allows a UI to draw the stored geometry greyed out — and must
//! never be fed to a later feature: an integrator fails the sketch's consumers with
//! `DEPENDENCY_FAILED` and builds nothing from a diagnosis. ([`crate::welded_guess`] gives
//! the same greyed-out geometry as IR curves.)

use forge_ir::v1::compound::CompoundError;
use forge_ir::v1::metrics::ReportError;
use forge_ops::OpError;
use serde_json::{Map, Value, json};

use crate::diagnosis::{ConflictSet, FailedCluster, SolveDiagnosis};
use crate::values::ValueError;

/// Why a sketch could not be evaluated.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum SketchError {
    /// A sketch behavior version this engine does not implement
    /// (`UNSUPPORTED_FEATURE_VERSION`, SPEC-v1 §0.2 rule 3; validation rejects it first).
    #[error(
        "sketch v{v} is not supported (supported: {:?})",
        crate::SUPPORTED_VERSIONS
    )]
    UnsupportedVersion {
        /// The requested version.
        v: u32,
    },
    /// The expression at `path` failed to evaluate (W1's error, passed through unchanged:
    /// `EXPR_DOMAIN`, `EXPR_NOT_INTEGER`, `PARAM_FAILED`, …).
    #[error("{path}: {}", error.message)]
    Value {
        /// Feature-relative JSON pointer of the field.
        path: String,
        /// The evaluation error.
        error: ValueError,
    },
    /// No value was provided for the expression at `path`: the caller did not resolve every
    /// site of [`crate::sketch_expr_sites`]. An integration bug (`FORGE_INTERNAL`); the
    /// sketch fails instead of guessing.
    #[error("no value was provided for the expression at {path}")]
    MissingValue {
        /// Feature-relative JSON pointer of the field.
        path: String,
    },
    /// A computed value is NaN or infinite (`NON_FINITE`).
    #[error("{path}: non-finite value")]
    NonFinite {
        /// Feature-relative JSON pointer of the field.
        path: String,
    },
    /// A curve is degenerate (`DEGENERATE_CURVE`, SPEC-v1 §4.2): a zero-length line, a
    /// zero-radius or closed arc, a zero-radius circle; for constrained sketches also a curve
    /// whose ends weld into one solver point, or a solved curve that collapsed.
    #[error("curve {curve:?} is degenerate: {reason}")]
    DegenerateCurve {
        /// The curve id.
        curve: String,
        /// Feature-relative JSON pointer of the curve.
        path: String,
        /// Why.
        reason: &'static str,
    },
    /// An explicit arc whose computed ends are at different distances from its centre
    /// (`INCONSISTENT_ARC`, SPEC-v1 §4.2).
    #[error("arc {curve:?}: |start−center| = {r_start} but |end−center| = {r_end}")]
    InconsistentArc {
        /// The curve id.
        curve: String,
        /// Feature-relative JSON pointer of the curve.
        path: String,
        /// `|start − center|`.
        r_start: f64,
        /// `|end − center|`.
        r_end: f64,
    },
    /// A compound curve's evaluated size is invalid (`INVALID_VALUE`, `INVALID_COUNT`, or
    /// `EXPR_NOT_INTEGER` for a polygon's `n`; SPEC-v1 §4.1).
    #[error("compound curve {curve:?}: {error}")]
    Compound {
        /// The compound curve id.
        curve: String,
        /// Feature-relative JSON pointer of the offending field.
        path: String,
        /// The expression text of that field, when it is an expression.
        expr: Option<String>,
        /// The expansion error.
        error: Box<CompoundError>,
    },
    /// An engine limit (`FORGE_LIMIT_EXCEEDED`): a polygon with more than
    /// [`crate::MAX_POLYGON_SIDES`] sides (`field: "n"`), or a sketch with more than
    /// [`crate::MAX_SKETCH_CURVES`] curves after compound expansion (`field: "curves"`, `curve`
    /// the curve that crossed the limit). The SPEC sets no bound; expanding up to 2^31
    /// members would exhaust memory and the region stage is quadratic, so Forge fails loudly.
    #[error("{field} = {value} exceeds the engine limit {limit} of curve {curve:?}")]
    LimitExceeded {
        /// The curve id.
        curve: String,
        /// Feature-relative JSON pointer of the field.
        path: String,
        /// The field.
        field: &'static str,
        /// Its value.
        value: f64,
        /// The limit.
        limit: f64,
    },
    /// Expressions or compound curves in a constrained sketch (`SKETCH_MIXED_MODE`; rejected
    /// by validation, re-checked defensively).
    #[error("sketch {sketch:?} mixes constraints with {what} at {path}")]
    MixedMode {
        /// The sketch id.
        sketch: String,
        /// Feature-relative JSON pointer of the offending field or curve.
        path: String,
        /// `"an expression"` or `"a compound curve"`.
        what: &'static str,
    },
    /// A driving `distance`, `radius` or `diameter` whose value is ≤ 0
    /// (`SKETCH_INVALID_DIMENSION`, SPEC-v1 §4.4 rule 1).
    #[error("dimension {constraint:?} must be > 0, got {value}")]
    InvalidDimension {
        /// The constraint id.
        constraint: String,
        /// Feature-relative JSON pointer of its `value`.
        path: String,
        /// The evaluated value.
        value: f64,
    },
    /// forge-solve rejected the lowered sketch (its structural codes, SPEC-v1 §4.3; validation
    /// rejects these documents, so this is defensive).
    #[error("{0}")]
    Solver(forge_solve::SketchError),
    /// The constraints contradict each other (`SKETCH_CONSTRAINT_CONFLICT`, SPEC-v1 §4.4).
    #[error("{}", conflict_message(conflicts))]
    Conflict {
        /// Minimal conflicting sets.
        conflicts: Vec<ConflictSet>,
        /// The full diagnosis.
        diagnosis: Box<SolveDiagnosis>,
    },
    /// The solver did not reach a solution (`SKETCH_SOLVE_FAILED`, SPEC-v1 §4.4), or its
    /// solution failed the independent check ([`crate::check`]); [`SolveFailure`] says which.
    #[error("{}", failed_message(*reason, *max_residual, clusters, verification.as_ref()))]
    SolveFailed {
        /// Why. The report's details (`max_residual`, `clusters`) do not say; W7/W9 classify
        /// by this ([`SolveFailure::as_str`]).
        reason: SolveFailure,
        /// Largest residual over the failed clusters (or the independent check's worst
        /// violation), mm. May be infinite or NaN here (a residual that cannot be measured);
        /// the report's `max_residual` detail is always a number: [`UNMEASURABLE_RESIDUAL`]
        /// then.
        max_residual: f64,
        /// The clusters that failed.
        clusters: Vec<FailedCluster>,
        /// Set when the solver reported success but the independent check failed: the
        /// constraint (or `"arc rule"` / `"weld"`) with the worst violation.
        verification: Option<String>,
        /// The full diagnosis.
        diagnosis: Box<SolveDiagnosis>,
    },
    /// A region-stage error of v0 §3 on the (evaluated or solved) geometry
    /// (`SKETCH_OPEN_LOOP`, `SKETCH_BRANCHING`, `SKETCH_CURVES_CROSS`,
    /// `SKETCH_DEGENERATE_LOOP`, `SKETCH_NO_REGIONS`), from forge-ops.
    #[error("{0}")]
    Regions(OpError),
}

fn conflict_message(conflicts: &[ConflictSet]) -> String {
    let sets: Vec<String> = conflicts
        .iter()
        .map(|c| {
            format!(
                "{{{}}} (suggested removal: {})",
                c.constraints.join(", "),
                c.suggested_removal
            )
        })
        .collect();
    format!("conflicting constraints: {}", sets.join("; "))
}

/// Why a sketch failed with `SKETCH_SOLVE_FAILED`. SPEC-v1 §4.4 rule 5 raises the code only for
/// forge-solve's `failed_to_converge`; the other reasons are Forge's guards against returning
/// a solution it cannot vouch for (never silently wrong geometry), and the report's details
/// (`max_residual`, `clusters`) are the same for all of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SolveFailure {
    /// forge-solve reported `failed_to_converge` (SPEC-v1 §4.4 rule 5).
    NotConverged,
    /// forge-solve reported a solved status without every driving constraint within its
    /// tolerance (defensive; forge-solve never does).
    SolverInconsistent,
    /// forge-solve reported success, but the solution fails the independent check of
    /// SPEC-v1 §8.1 — the check the oracle applies on replay ([`crate::check::check_solution`]).
    ReplayCheck,
    /// Forge's own engine guard, **not in SPEC-v1** (a contract issue): the solution passes the
    /// §8.1 check, but the solve grew the geometry so far beyond its stored guess that an
    /// angular condition deviates by more than *tol* at the solved size
    /// ([`crate::check::check_solution_capped`]). forge-solve's status was
    /// `fully_constrained`, `under_constrained` or `over_constrained_redundant`, which
    /// SPEC-v1 §4.4 rule 5 maps to ok.
    GeometricCap,
}

impl SolveFailure {
    /// A stable name: `not_converged`, `solver_inconsistent`, `replay_check`,
    /// `geometric_cap`.
    pub fn as_str(self) -> &'static str {
        match self {
            SolveFailure::NotConverged => "not_converged",
            SolveFailure::SolverInconsistent => "solver_inconsistent",
            SolveFailure::ReplayCheck => "replay_check",
            SolveFailure::GeometricCap => "geometric_cap",
        }
    }
}

fn failed_message(
    reason: SolveFailure,
    max_residual: f64,
    clusters: &[FailedCluster],
    verification: Option<&String>,
) -> String {
    match (reason, verification) {
        (SolveFailure::GeometricCap, Some(what)) => format!(
            "the solution failed Forge's geometric-error guard: {what}; off by {max_residual:e} mm"
        ),
        (_, Some(what)) => format!(
            "the solution failed the independent constraint check: {what} is violated by {max_residual:e} mm"
        ),
        (_, None) => format!(
            "the solver did not converge ({} cluster(s), max residual {max_residual:e} mm)",
            clusters.len()
        ),
    }
}

/// The `max_residual` detail of `SKETCH_SOLVE_FAILED` for a residual that is not a finite
/// number (NaN or infinite: a residual the solver or the independent check could not measure,
/// or a trace that does not match the sketch): `f64::MAX`. JSON has no infinity, and
/// `serde_json` would print `null`, so the catalogue's numeric detail would not be a number.
pub const UNMEASURABLE_RESIDUAL: f64 = f64::MAX;

/// `max_residual` as reported: itself when finite, else [`UNMEASURABLE_RESIDUAL`].
fn finite_residual(r: f64) -> f64 {
    if r.is_finite() {
        r
    } else {
        UNMEASURABLE_RESIDUAL
    }
}

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

impl SketchError {
    /// The stable machine-readable code (SPEC-v1 §7.5; engine limits are `FORGE_`-prefixed).
    pub fn code(&self) -> &str {
        match self {
            SketchError::UnsupportedVersion { .. } => "UNSUPPORTED_FEATURE_VERSION",
            SketchError::Value { error, .. } => &error.code,
            SketchError::MissingValue { .. } => "FORGE_INTERNAL",
            SketchError::NonFinite { .. } => "NON_FINITE",
            SketchError::DegenerateCurve { .. } => "DEGENERATE_CURVE",
            SketchError::InconsistentArc { .. } => "INCONSISTENT_ARC",
            SketchError::Compound { error, .. } => error.code,
            SketchError::LimitExceeded { .. } => "FORGE_LIMIT_EXCEEDED",
            SketchError::MixedMode { .. } => "SKETCH_MIXED_MODE",
            SketchError::InvalidDimension { .. } => "SKETCH_INVALID_DIMENSION",
            SketchError::Solver(e) => match e {
                forge_solve::SketchError::DegenerateEntity { .. } => "DEGENERATE_CURVE",
                forge_solve::SketchError::NonFinite { .. } => "NON_FINITE",
                other => other.code(),
            },
            SketchError::Conflict { .. } => "SKETCH_CONSTRAINT_CONFLICT",
            SketchError::SolveFailed { .. } => "SKETCH_SOLVE_FAILED",
            SketchError::Regions(e) => e.code(),
        }
    }

    /// Feature-relative JSON pointer of the field at fault, when there is one.
    pub fn path(&self) -> Option<&str> {
        match self {
            SketchError::Value { path, .. }
            | SketchError::MissingValue { path }
            | SketchError::NonFinite { path }
            | SketchError::DegenerateCurve { path, .. }
            | SketchError::InconsistentArc { path, .. }
            | SketchError::Compound { path, .. }
            | SketchError::LimitExceeded { path, .. }
            | SketchError::MixedMode { path, .. }
            | SketchError::InvalidDimension { path, .. } => Some(path),
            // The feature's `v` field (the fixture's path for this code).
            SketchError::UnsupportedVersion { .. } => Some("/v"),
            _ => None,
        }
    }

    /// The solver's diagnosis, for errors raised after a solve.
    pub fn diagnosis(&self) -> Option<&SolveDiagnosis> {
        match self {
            SketchError::Conflict { diagnosis, .. }
            | SketchError::SolveFailed { diagnosis, .. } => Some(diagnosis),
            _ => None,
        }
    }

    /// Structured details with the keys the catalogue lists for [`SketchError::code`].
    pub fn details(&self) -> Map<String, Value> {
        match self {
            SketchError::UnsupportedVersion { v } => obj(json!({
                "type": "sketch",
                "v": v,
                "supported": crate::SUPPORTED_VERSIONS,
            })),
            SketchError::Value { error, .. } => error.details.clone(),
            SketchError::MissingValue { path } => {
                obj(json!({ "path": path, "reason": "unresolved-expression" }))
            }
            SketchError::NonFinite { path } => obj(json!({ "field": path })),
            SketchError::DegenerateCurve { curve, reason, .. } => {
                obj(json!({ "curve": curve, "reason": reason }))
            }
            SketchError::InconsistentArc {
                curve,
                r_start,
                r_end,
                ..
            } => obj(json!({ "curve": curve, "r_start": r_start, "r_end": r_end })),
            SketchError::Compound { expr, error, .. } => {
                let value = if error.value.is_finite() {
                    json!(error.value)
                } else {
                    Value::Null
                };
                // Exactly the catalogue's keys, as validation reports the same codes on
                // literals (the curve is in the message and in `path()`).
                if error.code == "EXPR_NOT_INTEGER" {
                    // `expr`: the expression text; for a literal (only reachable without
                    // validation) the value itself, as validation reports it.
                    let expr = expr.as_ref().map_or_else(|| value.clone(), |e| json!(e));
                    obj(json!({ "expr": expr, "value": value }))
                } else {
                    obj(json!({
                        "field": error.field,
                        "value": value,
                        "expected": error.expected,
                    }))
                }
            }
            SketchError::LimitExceeded {
                curve,
                field,
                value,
                limit,
                ..
            } => obj(json!({ "curve": curve, "field": field, "value": value, "limit": limit })),
            SketchError::MixedMode { sketch, path, .. } => {
                obj(json!({ "sketch": sketch, "path": path }))
            }
            SketchError::InvalidDimension {
                constraint, value, ..
            } => obj(json!({ "constraint": constraint, "value": value })),
            SketchError::Solver(e) => match e {
                forge_solve::SketchError::DegenerateEntity { id, reason } => {
                    obj(json!({ "curve": id, "reason": reason }))
                }
                forge_solve::SketchError::NonFinite { id, field } => {
                    obj(json!({ "field": format!("{id}.{field}") }))
                }
                other => {
                    let mut m = obj(serde_json::to_value(other).unwrap_or(Value::Null));
                    m.remove("variant");
                    m
                }
            },
            SketchError::Conflict { conflicts, .. } => obj(json!({
                "conflicts": conflicts
                    .iter()
                    .map(|c| json!({
                        "constraints": c.constraints,
                        "suggested_removal": c.suggested_removal,
                        "verified_minimal": c.verified_minimal,
                    }))
                    .collect::<Vec<_>>()
            })),
            SketchError::SolveFailed {
                max_residual,
                clusters,
                ..
            } => obj(json!({
                "max_residual": finite_residual(*max_residual),
                "clusters": clusters
                    .iter()
                    .map(|c| json!({ "entities": c.entities, "constraints": c.constraints }))
                    .collect::<Vec<_>>()
            })),
            SketchError::Regions(e) => op_error_details(e),
        }
    }

    /// The report `error` object (`{ code, message, details }`, SPEC-v1 §7.4).
    pub fn to_report_error(&self) -> ReportError {
        ReportError {
            code: self.code().to_string(),
            message: self.to_string(),
            details: self.details(),
        }
    }
}

/// Details of a forge-ops region-stage error, keyed as the catalogue lists them.
pub(crate) fn op_error_details(e: &OpError) -> Map<String, Value> {
    match e {
        OpError::SketchOpenLoop { curve, end, point } => {
            obj(json!({ "curve": curve, "end": end.as_str(), "point": point }))
        }
        OpError::SketchBranching {
            curve,
            end,
            point,
            partners,
        } => obj(json!({
            "curve": curve,
            "end": end.as_str(),
            "point": point,
            "partners": partners,
        })),
        OpError::SketchCurvesCross {
            first,
            second,
            point,
        } => obj(json!({ "first": first, "second": second, "point": point })),
        OpError::SketchDegenerateLoop { curves, area } => {
            obj(json!({ "curves": curves, "area": area }))
        }
        _ => Map::new(),
    }
}
