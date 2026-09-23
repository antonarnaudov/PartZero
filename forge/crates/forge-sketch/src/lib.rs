//! # forge-sketch — IR v1 sketch evaluation (workstream W2)
//!
//! Evaluates one `aicad.ir/1` sketch feature (SPEC-v1 §4) into the regions forge-ops
//! consumes, the report's `sketch` block — which is also the replay trace (interface I6) the
//! oracle checks instead of solving (SPEC-v1 §8.1) — and the sketch's warnings.
//!
//! ```text
//! explicit    (no constraints)  Scalars ─ValueSource─► literal curves ─compound::expand─► members
//! constrained (constraints)     stored guess ─weld─► forge-solve ─map back─► solved curves
//!                                                      │ status, DOF, redundancy, conflicts
//!                  literal curves ─(non-construction lines/arcs/circles)─► forge_ops::regions
//! ```
//!
//! Entry point: [`evaluate_sketch`]. Expressions are **not** evaluated here: the caller
//! (forge-regen, with W1's evaluator) resolves every expression site of the sketch and passes
//! the values in ([`ResolvedValues`], or any [`ValueSource`]).
//!
//! ## Guarantees
//! - **No stale fallback** (SPEC-v1 §4.4 rule 6): a sketch whose solve fails returns an error
//!   without regions or a solution. The error's diagnosis ([`SolveDiagnosis`]) does hold the
//!   welded stored guess (`solver_input`) — for display only (rule 6: greyed out); nothing
//!   builds geometry for later features from it (see [`SketchError`]).
//! - **Verified solutions**: every successful solve is re-checked by [`check`], independent
//!   code written from SPEC-v1 §4.3 — the §8.1 check (every driving constraint to
//!   `SOLVE_CHECK_TOLERANCE`, welded ends bit-identical, arc rules;
//!   [`SolveFailure::ReplayCheck`]) — plus Forge's own geometric-error cap, **not in SPEC-v1**:
//!   no angular condition is off by more than *tol* (mm) at the solved size unless the pinned
//!   tolerance already permits that at the stored guess's size
//!   ([`check::check_solution_capped`], [`SolveFailure::GeometricCap`]; it never rejects a
//!   solution that is no larger than its guess, so never a rule-4 fixed point). A failed
//!   check fails the sketch (`SKETCH_SOLVE_FAILED`, `clusters` = the solver cluster of the
//!   violated constraint) instead of returning silently wrong geometry.
//! - **Fixed point** (§4.4 rule 4), stated on the **welded** guess ([`welded_guess`]) — the
//!   stored geometry with every welded end at its representative's stored coordinates, which
//!   is what the solver starts from: when it satisfies every driving constraint to
//!   `SOLVE_TOLERANCE` (and its arcs their arc rule), the solution is bit-identical to it. A
//!   guess whose welded ends are within *tol* but not bit-equal is therefore not a fixed point
//!   as written: the aliases move to their representative and the solver may move the rest
//!   (up to *tol*).
//! - **Write-back** ([`write_back`]) replaces the literal coordinates with the solved ones,
//!   exactly as SPEC-v1 §4.4 rule 9 states (so it writes what the TS `writeBackSolution`
//!   writes). When the solution does not change the welding (no ends newly within *tol*), the
//!   written document is its own welded guess: the next evaluation is bit-identical and
//!   write-back is idempotent. When the solve joined ends the stored geometry did not weld (a
//!   `coincident` between separate ends, solved to ~1e-10), the next evaluation welds them:
//!   the `coincident` becomes redundant (status and warnings change), and the solve may move
//!   geometry by ~1e-10 — SPEC-v1 §4.4 rules 4 and 9 contradict §4.3's welding there
//!   (reported as a contract issue; see `tests/acceptance.rs`). One more write-back reaches
//!   the fixed point.
//! - **Flip check** (§4.4 rule 8) compares signed areas that do not depend on the sketch's
//!   position: the stored guess is measured along the solved loop with its gaps closed by
//!   straight chords (a loop the guess leaves open, closed only by `coincident` constraints).
//! - **Deterministic**: no hash-order iteration, forge-solve's options pinned for `v: 1`
//!   ([`solve_options_v1`]), transcendentals through `forge_core::math`.
//! - **Bounded**: at most [`MAX_SKETCH_CURVES`] curves after expansion (`FORGE_LIMIT_EXCEEDED`);
//!   the welding (here and in [`check`]) is at most quadratic in the number of curve ends.
//!
//! ## Constraints between welded ends ([W0-9])
//!
//! forge-solve rejects a constraint that names one solver point twice, so the lowering decides
//! these itself (SPEC-v1 §4.3 asks for "redundant"; the details below are Forge's, and W7 must
//! use the same):
//! - `coincident(a, b)`: not passed to forge-solve; a `redundant` entry
//!   `{ constraint, partial: false, implied_by: [] }` (welding implies it);
//! - driving `distance(a, b)`: not passed to forge-solve; a conflict set
//!   `{ constraints: [id], suggested_removal: id, verified_minimal: true }`, listed after
//!   forge-solve's sets; a reference one measures 0;
//! - `symmetric(a, b, line)`: lowered to `point_on_line(a, line)` (same id); a partial
//!   `redundant` entry with `implied_by: []`, or — when forge-solve finds that
//!   `point_on_line` redundant too — forge-solve's single entry (not partial, its
//!   `implied_by`).
//!
//! The redundant list is in constraint order; the status is raised to `conflict` by a decided
//! conflict and to `over_constrained_redundant` by a decided redundancy (unless forge-solve
//! already reports `conflict` or `failed_to_converge`).

pub mod check;
mod diagnosis;
mod error;
mod geometry;
pub mod lift;
mod lower;
mod regions;
mod values;
mod weld;

use std::collections::BTreeMap;

use forge_core::linalg::Frame;
use forge_ir::P2;
use forge_ir::v1::metrics::{DimensionReport, Severity, SketchMode, SketchReport, Warning};
use forge_ir::v1::{Constraint, FieldType, LiteralCurve, Scalar, SketchFeature};
use forge_ops::Region;
use forge_solve::{RankMethod, SolveOptions, SolveStatus, Solver};
use serde_json::{Value, json};

pub use diagnosis::{
    ConflictSet, FailedCluster, RedundantConstraint, SolveDiagnosis, WeldGroup, ir_status,
};
pub use error::{SketchError, SolveFailure, UNMEASURABLE_RESIDUAL};
pub use geometry::{MAX_POLYGON_SIDES, MAX_SKETCH_CURVES};
pub use lower::ConstraintValues;
pub use regions::{RegionNotFound, select_regions};
pub use values::{OwnedSite, ResolvedValues, SiteRef, ValueError, ValueSource, sketch_expr_sites};

use crate::geometry::{evaluate_explicit, scalar, stored_geometry, structural_check};
use crate::lower::{Decided, lower};
use crate::weld::Welding;

/// The sketch behavior versions this crate implements (SPEC-v1 §0.2).
pub const SUPPORTED_VERSIONS: [u32; 1] = [1];

/// The forge-solve options pinned for sketch `v: 1` (SPEC-v1 §4.4 rule 3):
/// `SolveOptions::default()` of forge-solve 0.0.1, spelled out field by field so that a later
/// change of forge-solve's defaults cannot change a v1 result (a test asserts they still
/// agree, and that `tolerance` is `SOLVE_TOLERANCE`). The drag fields are unused by sketch
/// evaluation.
pub fn solve_options_v1() -> SolveOptions {
    SolveOptions {
        tolerance: forge_ir::v1::SOLVE_TOLERANCE,
        max_iterations: 200,
        rank_tolerance: 1e-8,
        conflict_rank_tolerance: 1e-6,
        circuit_pivot_tolerance: 1e-8 / 10.0,
        circuit_support_tolerance: 1e-8,
        dof_tolerance: 1e-7,
        rank_method: RankMethod::Qrcp,
        max_conflicts: 8,
        drag_weight: 1e6,
        drag_max_iterations: 50,
    }
}

/// A successfully evaluated sketch.
#[derive(Debug, Clone, PartialEq)]
pub struct SketchResult {
    /// Explicit or constrained (SPEC-v1 §4.2).
    pub mode: SketchMode,
    /// The sketch plane's frame (as given by the caller).
    pub frame: Frame,
    /// The regions, in canonical order (v0 §3), in sketch coordinates.
    pub regions: Vec<Region>,
    /// The v0 curves the regions were built from (non-construction lines, arcs, circles and
    /// compound members, in sketch order); `LoopCurve::sketch_index` indexes this list.
    pub profile: Vec<forge_ir::SketchCurve>,
    /// Warnings and infos in the order raised (SPEC-v1 §7.3).
    pub warnings: Vec<Warning>,
    /// The report's `sketch` block and the oracle's replay trace (I6): `solved` is the literal
    /// geometry the regions came from.
    pub trace: SketchReport,
    /// Constrained sketches: the solver's diagnosis.
    pub solve_report: Option<SolveDiagnosis>,
}

impl SketchResult {
    /// The report's region entries (v0 §4.1): area (−0 printed as 0), loop count, name.
    pub fn region_metrics(&self) -> Vec<forge_ir::RegionMetrics> {
        self.regions
            .iter()
            .map(|r| forge_ir::RegionMetrics {
                area: r.area + 0.0,
                loops: r.loop_count() as u32,
                outer_curves: r.outer_curves.clone(),
            })
            .collect()
    }

    /// A sketch point of the evaluated geometry, in sketch coordinates: a `point` curve, or a
    /// derived point `<curve>.start` / `.end` / `.center` (compound members included, e.g.
    /// `outline.c_br.center`). Hole placement (`at.points`, SPEC-v1 §6.5) reads these.
    pub fn point(&self, id: &str) -> Option<P2> {
        let curves = &self.trace.solved;
        if let Some(LiteralCurve::Point { at, .. }) = curves.iter().find(|c| c.id() == id) {
            return Some(*at);
        }
        let (curve, which) = id.rsplit_once('.')?;
        match (curves.iter().find(|c| c.id() == curve)?, which) {
            (LiteralCurve::Line { start, .. } | LiteralCurve::Arc { start, .. }, "start") => {
                Some(*start)
            }
            (LiteralCurve::Line { end, .. } | LiteralCurve::Arc { end, .. }, "end") => Some(*end),
            (LiteralCurve::Arc { center, .. } | LiteralCurve::Circle { center, .. }, "center") => {
                Some(*center)
            }
            _ => None,
        }
    }

    /// The regions a body feature selects (SPEC-v1 §4.5).
    pub fn select_regions(
        &self,
        selection: &forge_ir::v1::RegionSelection,
    ) -> Result<Vec<&Region>, RegionNotFound> {
        select_regions(&self.regions, selection)
    }
}

/// Evaluate a v1 sketch feature (SPEC-v1 §4.1–§4.5).
///
/// - `values` supplies the value of every expression site ([`sketch_expr_sites`]); a literal
///   field is used as-is.
/// - `plane_frame` is the sketch plane's evaluated frame (a named plane, an explicit frame, a
///   face frame or a datum, resolved by the caller, SPEC-v1 §3.1); it is carried into the
///   result for the body features.
///
/// The checks run in this order and the first failure decides the error:
/// - explicit mode: every Scalar of every curve (curve order, field order), then per curve in
///   curve order its structural check or compound expansion and the curve limit (see
///   `geometry::evaluate_explicit`);
/// - constrained mode: per curve its literal fields (`SKETCH_MIXED_MODE`, `NON_FINITE`),
///   `DEGENERATE_CURVE` and the curve limit; the constraint values in constraint order
///   (`SKETCH_INVALID_DIMENSION`); the welding (`DEGENERATE_CURVE` for a curve whose ends weld
///   together); the solve (`SKETCH_CONSTRAINT_CONFLICT`, `SKETCH_SOLVE_FAILED`); the
///   independent check of the solution (`SKETCH_SOLVE_FAILED`); the solved curves'
///   `DEGENERATE_CURVE`;
/// - then the region stages of v0 §3 on the literal geometry.
///
/// The caller decides `PARAM_FAILED`, suppression and the plane before calling (SPEC-v1
/// §7.1). A sketch without profile curves (only points and construction geometry) succeeds
/// with **zero regions**: a consumer must treat "no regions" explicitly.
pub fn evaluate_sketch(
    sketch: &SketchFeature,
    values: &dyn ValueSource,
    plane_frame: &Frame,
) -> Result<SketchResult, SketchError> {
    // Validation rejects undefined versions; an engine that lacks one must not guess (§0.2).
    if !SUPPORTED_VERSIONS.contains(&sketch.v) {
        return Err(SketchError::UnsupportedVersion { v: sketch.v });
    }
    if sketch.constraints.is_empty() {
        evaluate_explicit_sketch(sketch, values, plane_frame)
    } else {
        evaluate_constrained_sketch(sketch, values, plane_frame)
    }
}

fn evaluate_explicit_sketch(
    sketch: &SketchFeature,
    values: &dyn ValueSource,
    frame: &Frame,
) -> Result<SketchResult, SketchError> {
    let curves = evaluate_explicit(sketch, values)?;
    let profile = regions::profile_curves(&curves);
    let regions = regions::regions_of(&sketch.id, &profile)?;
    Ok(SketchResult {
        mode: SketchMode::Explicit,
        frame: *frame,
        regions,
        profile,
        warnings: Vec::new(),
        trace: SketchReport {
            mode: SketchMode::Explicit,
            status: None,
            dof: None,
            solved: curves,
            dimensions: Vec::new(),
        },
        solve_report: None,
    })
}

/// Evaluate the constraint Scalars (dimension values, `fix` targets) in constraint order and
/// apply SPEC-v1 §4.4 rule 1.
pub fn constraint_values(
    sketch: &SketchFeature,
    values: &dyn ValueSource,
) -> Result<Vec<ConstraintValues>, SketchError> {
    let mut out = Vec::with_capacity(sketch.constraints.len());
    for (k, con) in sketch.constraints.iter().enumerate() {
        let kp = format!("/constraints/{k}");
        let mut cv = ConstraintValues::default();
        match con {
            Constraint::Distance { value, driving, .. }
            | Constraint::Radius { value, driving, .. }
            | Constraint::Diameter { value, driving, .. } => {
                if let (Some(v), true) = (value, *driving) {
                    let path = format!("{kp}/value");
                    let x = scalar(values, path.clone(), v, FieldType::Length)?;
                    if x <= 0.0 {
                        return Err(SketchError::InvalidDimension {
                            constraint: con.id().to_string(),
                            path,
                            value: x,
                        });
                    }
                    cv.value = Some(x);
                }
            }
            Constraint::Angle { value, driving, .. } => {
                if let (Some(v), true) = (value, *driving) {
                    cv.value = Some(scalar(values, format!("{kp}/value"), v, FieldType::Angle)?);
                }
            }
            Constraint::Fix { x, y, .. } => {
                let target = |name: &str, v: &Option<Scalar>| -> Result<Option<f64>, SketchError> {
                    v.as_ref()
                        .map(|v| scalar(values, format!("{kp}/{name}"), v, FieldType::Length))
                        .transpose()
                };
                cv.x = target("x", x)?;
                cv.y = target("y", y)?;
            }
            _ => {}
        }
        out.push(cv);
    }
    Ok(out)
}

fn warning(code: &str, severity: Severity, message: String, details: Value) -> Warning {
    Warning {
        code: code.to_string(),
        severity,
        message,
        details: match details {
            Value::Object(m) => m,
            _ => serde_json::Map::new(),
        },
    }
}

fn evaluate_constrained_sketch(
    sketch: &SketchFeature,
    values: &dyn ValueSource,
    frame: &Frame,
) -> Result<SketchResult, SketchError> {
    // 1. The stored guess (literal geometry only) and the constraint values.
    let stored = stored_geometry(sketch)?;
    let cvals = constraint_values(sketch, values)?;

    // 2. Welding; a curve whose two ends weld together is degenerate for the solver.
    let welding = Welding::compute(&stored);
    if let Some(&ci) = welding.collapsed_curves().first() {
        return Err(SketchError::DegenerateCurve {
            curve: stored[ci].id().to_string(),
            path: format!("/curves/{ci}"),
            reason: "its ends weld into one point",
        });
    }

    // 3. Lower and solve with the options pinned for sketch v1 (SPEC-v1 §4.4 rule 3).
    let lowered = lower(&stored, &sketch.constraints, &cvals, &welding);
    let options = solve_options_v1();
    let mut solver = Solver::new(&lowered.sketch, &options).map_err(SketchError::Solver)?;
    let result = solver.solve();
    let solved_sketch = solver.sketch();

    // 4. Merge the diagnoses the lowering decided itself.
    let mut diag = diagnose(
        sketch,
        &lowered,
        &welding,
        result,
        lowered.sketch.clone(),
        options.max_conflicts,
    );
    diag.welds = welding.groups();

    // 5. Status mapping (SPEC-v1 §4.4 rule 5).
    match diag.status {
        SolveStatus::Conflict => {
            return Err(SketchError::Conflict {
                conflicts: diag.conflicts.clone(),
                diagnosis: Box::new(diag),
            });
        }
        SolveStatus::FailedToConverge => {
            let clusters: Vec<FailedCluster> = diag
                .solver
                .clusters
                .iter()
                .filter(|c| !c.status.is_solved())
                .map(|c| FailedCluster {
                    entities: c.entities.clone(),
                    constraints: c.constraints.clone(),
                })
                .collect();
            // forge-solve's `ClusterReport::max_residual` skips a NaN residual; re-measure each
            // failed cluster NaN-aware, so that an unmeasurable residual is reported as
            // `UNMEASURABLE_RESIDUAL`, never as a small number.
            let max_residual = failed_max_residual(
                diag.solver
                    .clusters
                    .iter()
                    .filter(|c| !c.status.is_solved())
                    .map(|c| solver.cluster_max_residual(c.index).unwrap_or(f64::NAN)),
            );
            return Err(SketchError::SolveFailed {
                reason: SolveFailure::NotConverged,
                max_residual,
                clusters,
                verification: None,
                diagnosis: Box::new(diag),
            });
        }
        _ if !diag.solver.ok => {
            // Defensive: a "solved" status must come with every constraint satisfied.
            return Err(SketchError::SolveFailed {
                reason: SolveFailure::SolverInconsistent,
                max_residual: diag.solver.max_residual,
                clusters: Vec::new(),
                verification: Some("solver status".into()),
                diagnosis: Box::new(diag),
            });
        }
        _ => {}
    }

    // 6. Map the solution back to IR curves (§4.4 rule 7): aliases take the representative's
    //    coordinates, arcs map back through the ccw rule (their ids never change).
    let mut points: BTreeMap<&str, P2> = BTreeMap::new();
    let mut radii: BTreeMap<&str, f64> = BTreeMap::new();
    for e in &solved_sketch.entities {
        match &e.geometry {
            forge_solve::Geometry::Point { x, y } => {
                points.insert(&e.id, [*x, *y]);
            }
            forge_solve::Geometry::Circle { radius, .. } => {
                radii.insert(&e.id, *radius);
            }
            _ => {}
        }
    }
    let point = |id: &str| -> P2 { points[welding.resolve(id)] };
    let radius = |id: &str| -> f64 { radii[id] };
    let solved: Vec<LiteralCurve> = stored
        .iter()
        .map(|c| match c {
            LiteralCurve::Point {
                id, construction, ..
            } => LiteralCurve::Point {
                id: id.clone(),
                at: point(id),
                construction: *construction,
            },
            LiteralCurve::Line {
                id, construction, ..
            } => LiteralCurve::Line {
                id: id.clone(),
                start: point(&format!("{id}.start")),
                end: point(&format!("{id}.end")),
                construction: *construction,
            },
            LiteralCurve::Arc {
                id,
                ccw,
                construction,
                ..
            } => LiteralCurve::Arc {
                id: id.clone(),
                start: point(&format!("{id}.start")),
                end: point(&format!("{id}.end")),
                center: point(&format!("{id}.center")),
                ccw: *ccw,
                construction: *construction,
            },
            LiteralCurve::Circle {
                id, construction, ..
            } => LiteralCurve::Circle {
                id: id.clone(),
                center: point(&format!("{id}.center")),
                radius: radius(id),
                construction: *construction,
            },
        })
        .collect();

    // 7. Independent verification of the solution (never return a silently wrong one): the
    //    §8.1 check plus Forge's geometric-error cap.
    if let Err(v) = check::check_solution_capped(&stored, &sketch.constraints, &cvals, &solved) {
        return Err(SketchError::SolveFailed {
            reason: if v.geometric_cap {
                SolveFailure::GeometricCap
            } else {
                SolveFailure::ReplayCheck
            },
            max_residual: v.amount,
            clusters: violation_clusters(&v.subject, &diag),
            verification: Some(v.what),
            diagnosis: Box::new(diag),
        });
    }

    // 8. DEGENERATE_CURVE on the solved values (a solution may collapse a curve).
    for (ci, c) in solved.iter().enumerate() {
        structural_check(c, &format!("/curves/{ci}"), false)?;
    }

    // 9. Regions of the solved geometry, then the flip check (§4.4 rule 8).
    let profile = regions::profile_curves(&solved);
    let regions = regions::regions_of(&sketch.id, &profile)?;
    let flipped = regions::flipped_loops(&regions, &stored, &solved);

    // 10. Report block and warnings.
    let dimensions = dimension_reports(sketch, &cvals, &diag, &lowered.decided);
    let mut warnings = Vec::new();
    match diag.status {
        SolveStatus::UnderConstrained => {
            let entities: Vec<Value> = diag
                .solver
                .entities
                .iter()
                .filter(|e| e.dof > 0)
                .map(|e| json!({ "id": e.id, "dof": e.dof }))
                .collect();
            warnings.push(warning(
                "SKETCH_UNDER_CONSTRAINED",
                Severity::Info,
                format!(
                    "the sketch has {} remaining degree(s) of freedom over {} entities",
                    diag.dof,
                    entities.len()
                ),
                json!({ "dof": diag.dof, "entities": entities }),
            ));
        }
        SolveStatus::OverConstrainedRedundant => {
            let list: Vec<String> = diag
                .redundant
                .iter()
                .map(|r| {
                    if r.implied_by.is_empty() {
                        format!("{} (implied by welding)", r.constraint)
                    } else {
                        format!("{} (implied by {})", r.constraint, r.implied_by.join(", "))
                    }
                })
                .collect();
            warnings.push(warning(
                "SKETCH_REDUNDANT_CONSTRAINTS",
                Severity::Warning,
                format!("redundant constraints: {}", list.join("; ")),
                json!({
                    "redundant": diag
                        .redundant
                        .iter()
                        .map(|r| json!({ "constraint": r.constraint, "implied_by": r.implied_by }))
                        .collect::<Vec<_>>()
                }),
            ));
        }
        _ => {}
    }
    for curves in flipped {
        warnings.push(warning(
            "SKETCH_LOOP_FLIPPED",
            Severity::Warning,
            format!(
                "the loop ({}) changed orientation: the solver jumped to a mirrored configuration",
                curves.join(", ")
            ),
            json!({ "curves": curves }),
        ));
    }
    Ok(SketchResult {
        mode: SketchMode::Constrained,
        frame: *frame,
        regions,
        profile,
        warnings,
        trace: SketchReport {
            mode: SketchMode::Constrained,
            status: Some(ir_status(diag.status)),
            dof: Some(u32::try_from(diag.dof).unwrap_or(u32::MAX)),
            solved,
            dimensions,
        },
        solve_report: Some(diag),
    })
}

/// `SKETCH_SOLVE_FAILED.max_residual` over the failed clusters' residuals: their maximum, NaN
/// when any is NaN (`f64::max` would drop it and report a number); 0 for none.
fn failed_max_residual(residuals: impl IntoIterator<Item = f64>) -> f64 {
    residuals.into_iter().fold(0.0, |acc: f64, r: f64| {
        if acc.is_nan() || r.is_nan() {
            f64::NAN
        } else {
            acc.max(r)
        }
    })
}

/// The solver clusters a failed independent check points at (`SKETCH_SOLVE_FAILED.clusters`):
/// the cluster(s) holding the violated constraint, arc or welded point; when forge-solve has
/// no cluster for it (nothing left to solve), the constraint and its entities alone.
fn violation_clusters(subject: &check::Subject, diag: &SolveDiagnosis) -> Vec<FailedCluster> {
    use check::Subject as S;
    let pick = |keep: &dyn Fn(&[String], &[String]) -> bool| -> Vec<FailedCluster> {
        diag.solver
            .clusters
            .iter()
            .filter(|c| keep(&c.entities, &c.constraints))
            .map(|c| FailedCluster {
                entities: c.entities.clone(),
                constraints: c.constraints.clone(),
            })
            .collect()
    };
    let or = |found: Vec<FailedCluster>, entities: Vec<String>, constraints: Vec<String>| {
        if found.is_empty() {
            vec![FailedCluster {
                entities,
                constraints,
            }]
        } else {
            found
        }
    };
    match subject {
        S::Constraint { id } => {
            let entities = diag
                .solver_input
                .constraints
                .iter()
                .find(|c| &c.id == id)
                .map(|c| {
                    c.kind
                        .references()
                        .into_iter()
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            or(
                pick(&|_, cons| cons.contains(id)),
                entities,
                vec![id.clone()],
            )
        }
        S::ArcRule { arc } => or(
            pick(&|ents, _| ents.contains(arc)),
            vec![arc.clone()],
            Vec::new(),
        ),
        S::Weld { representative, .. } => or(
            pick(&|ents, _| ents.contains(representative)),
            vec![representative.clone()],
            Vec::new(),
        ),
        S::Curves | S::Values | S::Dimension { .. } => Vec::new(),
    }
}

/// forge-solve's result lifted to IR ids and merged with the lowering's own decisions. The
/// merged conflict list keeps forge-solve's sets first and is capped at `max_conflicts` (the
/// pinned `SolveOptions::max_conflicts`, SPEC-v1 §4.4 rule 3), like forge-solve's own list.
fn diagnose(
    sketch: &SketchFeature,
    lowered: &lower::Lowered,
    welding: &Welding,
    result: forge_solve::SolveResult,
    solver_input: forge_solve::Sketch,
    max_conflicts: usize,
) -> SolveDiagnosis {
    let mut redundant: Vec<(usize, RedundantConstraint)> = Vec::new();
    let mut conflicts: Vec<ConflictSet> = result
        .conflicts
        .iter()
        .map(|c| ConflictSet {
            constraints: c.constraints.clone(),
            suggested_removal: c.suggested_removal.clone(),
            verified_minimal: c.verified_minimal,
            explanation: c.explanation.clone(),
        })
        .collect();
    let index_of = |id: &str| {
        sketch
            .constraints
            .iter()
            .position(|c| c.id() == id)
            .unwrap_or(usize::MAX)
    };
    for r in &result.redundant {
        redundant.push((
            index_of(&r.constraint),
            RedundantConstraint {
                constraint: r.constraint.clone(),
                partial: r.partial,
                implied_by: r.implied_by.clone(),
                explanation: r.explanation.clone(),
            },
        ));
    }
    let mut any_conflict = false;
    let mut any_redundant = false;
    for (k, d) in lowered.decided.iter().enumerate() {
        let id = sketch.constraints[k].id().to_string();
        match d {
            None | Some(Decided::ReferenceDistance) => {}
            Some(Decided::Coincident { a, b }) => {
                any_redundant = true;
                redundant.push((
                    k,
                    RedundantConstraint {
                        constraint: id.clone(),
                        partial: false,
                        implied_by: Vec::new(),
                        explanation: format!(
                            "`{id}` is implied by welding: {a} and {b} coincide in the stored geometry and are one solver point ({})",
                            welding.resolve(a)
                        ),
                    },
                ));
            }
            Some(Decided::Symmetric { a, b }) => {
                any_redundant = true;
                let welded = format!(
                    "{a} and {b} are welded into one point, so only \"the point lies on the line\" remains"
                );
                if let Some((_, r)) = redundant.iter_mut().find(|(_, r)| r.constraint == id) {
                    // forge-solve found the remaining `point_on_line` redundant as well: the
                    // whole constraint is implied; one entry, forge-solve's `implied_by`.
                    r.explanation = format!("`{id}`: {welded}, and {}", r.explanation);
                } else {
                    redundant.push((
                        k,
                        RedundantConstraint {
                            constraint: id.clone(),
                            partial: true,
                            implied_by: Vec::new(),
                            explanation: format!("`{id}`: {welded}"),
                        },
                    ));
                }
            }
            Some(Decided::DrivingDistance { a, b, value }) => {
                any_conflict = true;
                conflicts.push(ConflictSet {
                    constraints: vec![id.clone()],
                    suggested_removal: id.clone(),
                    verified_minimal: true,
                    explanation: format!(
                        "`{id}` asks for {value} mm between {a} and {b}, which are welded into one point (they coincide in the stored geometry)"
                    ),
                });
            }
        }
    }
    // Stable: forge-solve lists redundancies in constraint order; merge by constraint index.
    redundant.sort_by_key(|(k, _)| *k);
    // The pinned bound on reported conflict sets holds for the merged list too.
    conflicts.truncate(max_conflicts);
    let status = if any_conflict {
        SolveStatus::Conflict
    } else if matches!(
        result.status,
        SolveStatus::Conflict | SolveStatus::FailedToConverge
    ) {
        result.status
    } else if any_redundant {
        SolveStatus::OverConstrainedRedundant
    } else {
        result.status
    };
    SolveDiagnosis {
        status,
        dof: result.dof,
        redundant: redundant.into_iter().map(|(_, r)| r).collect(),
        conflicts,
        welds: Vec::new(),
        solver_input,
        solver: result,
    }
}

/// `sketch.dimensions` (SPEC-v1 §4.4): every dimension constraint in constraint order, with its
/// evaluated value (driving only) and its value measured at the solution.
fn dimension_reports(
    sketch: &SketchFeature,
    cvals: &[ConstraintValues],
    diag: &SolveDiagnosis,
    decided: &[Option<Decided>],
) -> Vec<DimensionReport> {
    sketch
        .constraints
        .iter()
        .zip(cvals)
        .zip(decided)
        .filter_map(|((con, cv), d)| {
            let (_, driving) = con.dimension()?;
            let measured = match d {
                Some(Decided::ReferenceDistance) => 0.0,
                _ => diag
                    .solver
                    .constraints
                    .iter()
                    .find(|c| c.id == con.id())
                    .and_then(|c| c.measured)
                    .unwrap_or(f64::NAN),
            };
            Some(DimensionReport {
                id: con.id().to_string(),
                driving,
                value: if driving { cv.value } else { None },
                measured,
            })
        })
        .collect()
}

/// `writeBackSolution` for one sketch (SPEC-v1 §0.6, §4.4 rule 9): the constrained sketch with
/// its literal coordinates replaced by the solved ones (`result.trace.solved`), exactly as
/// the SPEC states it — nothing else changes. Ends welded in the stored geometry are
/// bit-identical in every solution already. Ends the solve only brought within *tol* of each
/// other (e.g. a `coincident` between separate ends, solved to ~1e-10) are written as solved;
/// the next evaluation welds them (see the crate docs, "Write-back"). `None` for an explicit
/// sketch (nothing is written back) or when `result` is not this sketch's evaluation.
pub fn write_back(sketch: &SketchFeature, result: &SketchResult) -> Option<SketchFeature> {
    if result.mode != SketchMode::Constrained
        || sketch.constraints.is_empty()
        || result.trace.solved.len() != sketch.curves.len()
    {
        return None;
    }
    use forge_ir::v1::SketchCurve as C;
    let s2 = |p: P2| [Scalar::Num(p[0]), Scalar::Num(p[1])];
    let mut out = sketch.clone();
    for (c, lc) in out.curves.iter_mut().zip(&result.trace.solved) {
        if c.id() != lc.id() {
            return None;
        }
        match (c, lc) {
            (
                C::Line {
                    start: ws, end: we, ..
                },
                LiteralCurve::Line { start, end, .. },
            ) => {
                *ws = s2(*start);
                *we = s2(*end);
            }
            (
                C::Arc {
                    start: ws,
                    end: we,
                    center: wm,
                    ..
                },
                LiteralCurve::Arc {
                    start,
                    end,
                    center: m,
                    ..
                },
            ) => {
                *ws = s2(*start);
                *we = s2(*end);
                *wm = s2(*m);
            }
            (
                C::Circle { center, radius, .. },
                LiteralCurve::Circle {
                    center: m,
                    radius: r,
                    ..
                },
            ) => {
                *center = s2(*m);
                *radius = Scalar::Num(*r);
            }
            (C::Point { at, .. }, LiteralCurve::Point { at: a, .. }) => *at = s2(*a),
            _ => return None,
        }
    }
    Some(out)
}

/// The **welded guess** of a constrained sketch's stored geometry (SPEC-v1 §4.3): the curves
/// with every welded line/arc end at its group representative's stored coordinates — the
/// geometry forge-solve starts from. SPEC-v1 §4.4 rule 4 (fixed point) holds on it: when it
/// satisfies every driving constraint to `SOLVE_TOLERANCE` (and its arcs the arc rule), the
/// solution is bit-identical to it. UIs can draw it for a sketch whose solve failed (§4.4
/// rule 6: greyed out, never fed to later features).
pub fn welded_guess(stored: &[LiteralCurve]) -> Vec<LiteralCurve> {
    let welding = Welding::compute(stored);
    // Every end's representative's stored position (its own for a representative).
    let rep_point: BTreeMap<&str, P2> = welding
        .ends
        .iter()
        .zip(&welding.rep)
        .map(|(e, &r)| (e.id.as_str(), welding.ends[r].point))
        .collect();
    let at = |id: &str, which: &str, p: P2| -> P2 {
        rep_point
            .get(format!("{id}.{which}").as_str())
            .copied()
            .unwrap_or(p)
    };
    stored
        .iter()
        .map(|c| match c.clone() {
            LiteralCurve::Line {
                id,
                start,
                end,
                construction,
            } => LiteralCurve::Line {
                start: at(&id, "start", start),
                end: at(&id, "end", end),
                id,
                construction,
            },
            LiteralCurve::Arc {
                id,
                start,
                end,
                center,
                ccw,
                construction,
            } => LiteralCurve::Arc {
                start: at(&id, "start", start),
                end: at(&id, "end", end),
                id,
                center,
                ccw,
                construction,
            },
            other => other,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::float_cmp)] // exact maxima of exact inputs
    fn a_nan_failed_cluster_residual_is_not_folded_away() {
        // Review: `.fold(0.0, f64::max)` drops NaN, so a failed cluster whose residual is not a
        // number was reported with max_residual 0 (or another cluster's value).
        assert_eq!([0.0, f64::NAN].into_iter().fold(0.0, f64::max), 0.0);
        assert_eq!(failed_max_residual([]), 0.0);
        assert_eq!(failed_max_residual([1e-3, 2e-3, 5e-4]), 2e-3);
        assert_eq!(failed_max_residual([f64::INFINITY, 1.0]), f64::INFINITY);
        for rs in [
            vec![f64::NAN],
            vec![0.0, f64::NAN],
            vec![f64::NAN, 5.0],
            vec![1.0, f64::NAN, 2.0],
        ] {
            let r = failed_max_residual(rs.iter().copied());
            assert!(r.is_nan(), "{rs:?}: {r}");
        }
    }
}
