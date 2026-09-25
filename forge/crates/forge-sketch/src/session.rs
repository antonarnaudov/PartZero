//! # The interactive sketch session (contract C5 of `docs/FULL-MODELING-PLAN.md` §3.4)
//!
//! The sketcher's working copy of **one** IR v1 sketch feature. The IR stays the truth: a
//! session is loaded from a sketch (and the document whose parameters its expressions use),
//! edited with [`SketchEdit`]s — the vocabulary of the command layer's `sketchEdit` op (plan
//! §2.2) — and [`SketchSession::finish`]ed into an IR v1 sketch feature that the command layer
//! commits (`addFeature` for a new sketch, `sketchEdit`/`setField` for an existing one).
//!
//! ```text
//!   load(sketch, document?) ──► SketchFeature (literal geometry) ──► solve_constrained ──► Snapshot
//!        apply([edits]) ─┘  candidate ─► solve ─► policy (conflict / redundancy) ─► write-back ─► commit
//!   dragBegin/dragTo/dragEnd ─► forge-solve Solver::drag frames ─► commit (ReplaceCurve edits)
//!   finish() ─► canonical feature JSON + evaluate_sketch (the evaluation of record) + IR validation
//! ```
//!
//! ## Guarantees
//! - **One evaluation path.** Every snapshot comes from [`crate::solve_constrained`], the same
//!   code (and order of checks) [`crate::evaluate_sketch`] runs; `finish` runs `evaluate_sketch`
//!   itself. What the sketcher shows is what the model evaluates.
//! - **Committed geometry is solved geometry.** A committed edit writes the solution back
//!   (SPEC-v1 §4.4 rule 9), so the stored guess of the finished feature is a fixed point
//!   (rule 4): evaluating it again gives bit-identical geometry (tested).
//! - **Never silently wrong.** An edit batch that makes the sketch invalid (a degenerate curve, a
//!   dimension ≤ 0, an unknown reference, an expression that does not evaluate) is rejected
//!   whole, with the structured error, and the session is unchanged. A batch that turns a
//!   solved sketch into a conflicting one is rejected too unless the caller allows it
//!   ([`ApplyOptions::allow_conflict`]); the rejection carries the candidate's diagnosis
//!   (minimal conflicting sets, suggested removal) so the UI can offer "make driven?".
//! - **Welding is canonical.** A `coincident` between two line/arc ends is solved, written back,
//!   and then dropped, because the ends now weld (SPEC-v1 §4.3, §4.6: "writers SHOULD omit
//!   it"); joining ends therefore never leaves redundant constraints behind.
//! - **Deterministic**: no hash-ordered iteration; forge-solve's options pinned for `v: 1`.

use std::collections::{BTreeMap, BTreeSet};

use forge_core::linalg::Frame;
use forge_ir::P2;
use forge_ir::v1::{
    Constraint, Document, Feature, FieldType, LiteralCurve, ParamUnit, ParamValue, Parameter,
    PlaneRef, Scalar, SketchCurve, SketchFeature, ids,
};
use forge_params::ParamValues;
use forge_solve::{ConstraintState, SolveStatus, Solver};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::diagnosis::SolveDiagnosis;
use crate::geometry::stored_geometry;
use crate::lower::lower;
use crate::values::{SiteRef, ValueError};
use crate::weld::Welding;
use crate::{
    SketchError, constraint_values, evaluate_sketch, regions, solve_constrained, solve_options_v1,
    welded_guess,
};

// ─── Public data ─────────────────────────────────────────────────────────────────────────────

/// One edit of a sketch: the vocabulary of the command layer's `sketchEdit` op (plan §2.2).
///
/// Curves are **literal** (`line`, `arc`, `circle`, `point` with numbers only): the sketcher
/// works in constrained mode (SPEC-v1 §4.2), where parametric sizes are dimensions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum SketchEdit {
    /// Add a curve (its id must be new).
    AddCurve {
        /// The curve.
        curve: SketchCurve,
    },
    /// Remove a curve, and every constraint that references it or one of its points.
    RemoveCurve {
        /// The curve id.
        id: String,
    },
    /// Replace a curve's geometry (same id, same kind); its constraints stay.
    ReplaceCurve {
        /// The curve.
        curve: SketchCurve,
    },
    /// Toggle construction geometry.
    SetConstruction {
        /// The curve id.
        id: String,
        /// The new flag.
        construction: bool,
    },
    /// Add a constraint or dimension (its id must be new).
    AddConstraint {
        /// The constraint.
        constraint: Constraint,
    },
    /// Remove a constraint or dimension.
    RemoveConstraint {
        /// The constraint id.
        id: String,
    },
    /// Change a dimension's value (a number or an expression) or make it driving/driven.
    /// `driving: true` without a value drives it at its measured value.
    SetDimension {
        /// The dimension's constraint id.
        id: String,
        /// The new value.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<Scalar>,
        /// Driving (`true`) or reference (`false`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        driving: Option<bool>,
    },
    /// The end of a drag: move a point (`p`, `l.start`, `a.center`, …) towards `to` as far as
    /// the constraints allow, moving everything else as little as possible; a circle id moves
    /// its rim (the radius follows `|to − center|` when it is free).
    MoveTo {
        /// A point reference, or a circle id.
        point: String,
        /// Target in sketch coordinates (mm).
        to: P2,
    },
}

/// How [`SketchSession::apply`] treats a batch that over-constrains the sketch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApplyOptions {
    /// Commit even when a solved sketch becomes conflicting (the conflict is then shown and
    /// the feature fails until it is fixed). Default: reject.
    pub allow_conflict: bool,
    /// Commit constraints that are implied by others. Default: reject (`SESSION_REDUNDANT`).
    pub allow_redundant: bool,
    /// Silently drop the constraints of the batch that turn out redundant (auto-constraints of
    /// a drawing gesture). Wins over `allow_redundant`.
    pub drop_redundant: bool,
}

/// A structured session error: a stable `code`, a message, and details keyed per code.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SessionError {
    /// `SESSION_*` codes for the session's own checks; otherwise a sketch or IR code of the
    /// SPEC-v1 catalogue (`SKETCH_CONSTRAINT_CONFLICT`, `DEGENERATE_CURVE`, …).
    pub code: String,
    /// For people.
    pub message: String,
    /// Structured details.
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub details: Map<String, Value>,
    /// Feature-relative JSON pointer of the field at fault, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl SessionError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            details: Map::new(),
            path: None,
        }
    }

    fn with(mut self, details: Value) -> Self {
        if let Value::Object(m) = details {
            self.details = m;
        }
        self
    }

    fn at(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    fn from_sketch(e: &SketchError) -> Self {
        Self {
            code: e.code().to_string(),
            message: e.to_string(),
            details: e.details(),
            path: e.path().map(str::to_string),
        }
    }
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SessionError {}

/// A rejected edit batch: the error, and the candidate's snapshot when it was solved (for a
/// conflict: the minimal conflicting sets and the suggested removal).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Rejection {
    /// Why.
    pub error: SessionError,
    /// What the sketch would have been (not committed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<Box<Snapshot>>,
}

impl From<SessionError> for Rejection {
    fn from(error: SessionError) -> Self {
        Self {
            error,
            candidate: None,
        }
    }
}

/// The remaining degrees of freedom of one point of a curve.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PointDof {
    /// 0 (fixed), 1 or 2.
    pub dof: usize,
    /// For one DOF: the unit direction the point can move in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_direction: Option<[f64; 2]>,
}

/// The remaining degrees of freedom of one IR curve and its points.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityDof {
    /// The curve id.
    pub id: String,
    /// `line`, `arc`, `circle` or `point`.
    pub kind: &'static str,
    /// The curve's own DOF (shape and position): point 0–2, line 0–4, circle 0–3, arc 0–5.
    pub dof: usize,
    /// Per point: `at` (point), `start`/`end` (line, arc), `center` (arc, circle).
    pub points: BTreeMap<&'static str, PointDof>,
    /// Circles: the radius can still change.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius_free: Option<bool>,
}

/// A constraint or dimension as the UI shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintInfo {
    /// The constraint id.
    pub id: String,
    /// The IR `type`.
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// Its state after solving (absent when the sketch could not be solved at all).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<ConstraintState>,
    /// Dimensions: driving (`true`) or reference.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driving: Option<bool>,
    /// Driving dimensions: the evaluated value (mm or degrees).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    /// Driving dimensions whose value is an expression: its text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expr: Option<String>,
    /// Dimensions: the value measured on the shown geometry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measured: Option<f64>,
}

/// A minimal set of conflicting constraints.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    /// The constraints, in sketch order.
    pub constraints: Vec<String>,
    /// The default repair: the most recently added member.
    pub suggested_removal: String,
    /// Every one-smaller subset was proven solvable.
    pub verified_minimal: bool,
    /// Why, naming ids.
    pub explanation: String,
}

/// A redundant constraint and what implies it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedundancyInfo {
    /// The redundant constraint.
    pub constraint: String,
    /// Only some of its equations are implied.
    pub partial: bool,
    /// The earlier constraints that imply it (empty: welding does).
    pub implied_by: Vec<String>,
    /// Why.
    pub explanation: String,
}

/// One curve of a region loop, in traversal order.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoopEdge {
    /// The curve id.
    pub id: String,
    /// The loop runs the curve from its `end` to its `start`.
    pub reversed: bool,
}

/// A closed region of the profile (SPEC-v1 §4.5).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RegionInfo {
    /// Area (mm²).
    pub area: f64,
    /// Outer loop, counter-clockwise.
    pub outer: Vec<LoopEdge>,
    /// Holes, clockwise.
    pub holes: Vec<Vec<LoopEdge>>,
}

/// The profile of the shown geometry: its regions, or why the region stage fails (an open
/// loop while drawing is normal; the feature fails with that code if it is finished so).
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct ProfileInfo {
    /// Regions in canonical order.
    pub regions: Vec<RegionInfo>,
    /// The region-stage error (`SKETCH_OPEN_LOOP`, `SKETCH_CURVES_CROSS`, …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SessionError>,
}

/// Everything the sketcher draws and reports after a solve.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Increments on every committed change (edits, drags, undo, redo).
    pub revision: u64,
    /// The sketch feature id.
    pub sketch: String,
    /// The geometry to draw: solved when `ok`, otherwise the welded stored guess, which the UI
    /// draws greyed out (SPEC-v1 §4.4 rule 6).
    pub curves: Vec<LiteralCurve>,
    /// The constraints solved and the solution passed the independent check.
    pub ok: bool,
    /// forge-solve's status (`under_constrained`, `fully_constrained`,
    /// `over_constrained_redundant`, `conflict`, `failed_to_converge`); absent when the sketch
    /// could not be solved at all (a structural error).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<SolveStatus>,
    /// Remaining degrees of freedom.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dof: Option<usize>,
    /// Why the sketch is not ok.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SessionError>,
    /// Per curve.
    pub entities: Vec<EntityDof>,
    /// Per constraint, in sketch order.
    pub constraints: Vec<ConstraintInfo>,
    /// Minimal conflicting sets.
    pub conflicts: Vec<ConflictInfo>,
    /// Redundant constraints.
    pub redundant: Vec<RedundancyInfo>,
    /// Weld groups (ends joined into one point), representative first.
    pub welds: Vec<Vec<String>>,
    /// Regions of the solved geometry.
    pub profile: ProfileInfo,
    /// A one-paragraph summary from the solver.
    pub explanation: String,
    /// Undo is possible.
    pub can_undo: bool,
    /// Redo is possible.
    pub can_redo: bool,
}

/// One interactive drag frame.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragFrame {
    /// The frame was solved (otherwise the geometry stayed where it was).
    pub converged: bool,
    /// The geometry after the frame.
    pub curves: Vec<LiteralCurve>,
    /// How far the grabbed point is from the cursor (mm): 0 when it can follow.
    pub target_error: f64,
}

/// What [`SketchSession::drag_begin`] grabs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragSpec {
    /// A point reference (`p`, `l.start`, `a.center`, …) or a curve id (the whole curve).
    pub target: String,
    /// Where the pointer grabbed it (sketch coordinates).
    pub grab: P2,
    /// `"rim"` on a circle: drag its radius. Otherwise the whole curve moves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

/// The result of [`SketchSession::finish`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishResult {
    /// The IR v1 sketch feature, canonical JSON (with `"type": "sketch"`).
    pub feature: Value,
    /// The feature evaluates (region stages included) and validates.
    pub ok: bool,
    /// Why it would fail at evaluation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SessionError>,
    /// Number of regions.
    pub regions: usize,
    /// Solve status (constrained sketches).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<SolveStatus>,
    /// Remaining DOF (constrained sketches).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dof: Option<usize>,
    /// Warnings and infos of the evaluation (`SKETCH_UNDER_CONSTRAINED`, …).
    pub warnings: Vec<Value>,
    /// IR validation problems of the feature (feature-relative paths).
    pub validation: Vec<SessionError>,
    /// Every committed edit since load, in order (the `sketchEdit` op's list).
    pub edits: Vec<SketchEdit>,
    /// Parameters defined during the session (the command layer adds them first).
    pub params: Vec<Parameter>,
    /// Set when loading converted an explicit sketch (`convertSketch`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversion: Option<ConversionInfo>,
}

/// What [`SketchSession::load`] takes.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadRequest {
    /// The sketch feature (with or without `"type": "sketch"`).
    pub sketch: Value,
    /// The IR v1 document whose parameters the sketch's expressions use (optional).
    #[serde(default)]
    pub document: Option<Value>,
    /// The part (id) the sketch belongs to; default: the first part.
    #[serde(default)]
    pub part: Option<String>,
    /// Convert an explicit sketch with compound curves or expressions to constrained mode
    /// (`convertSketch`, [`crate::convert`]); default `true`. `false` refuses such a sketch
    /// with `SESSION_NEEDS_CONVERSION`.
    #[serde(default)]
    pub convert: Option<bool>,
}

/// What loading converted (`convertSketch`): member ids that became curve ids, and notes.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct ConversionInfo {
    /// `[member id, curve id]` pairs (`outline.bottom` → `outline_bottom`): the command layer
    /// rewrites later references to them.
    pub renames: Vec<(String, String)>,
    /// What could not be kept parametric.
    pub notes: Vec<String>,
}

// ─── Parameter environment ───────────────────────────────────────────────────────────────────

/// The document parameters that expressions of the sketch see (SPEC-v1 §2.8).
#[derive(Debug, Clone)]
struct Env {
    doc: Document,
    part: usize,
    pv: ParamValues,
    new_params: Vec<Parameter>,
}

impl Env {
    fn new(document: Option<Value>, part: Option<&str>) -> Result<Self, SessionError> {
        let doc: Document = match document {
            Some(v) => serde_json::from_value(v).map_err(|e| {
                SessionError::new(
                    "SESSION_BAD_DOCUMENT",
                    format!("the document is not an IR v1 document: {e}"),
                )
            })?,
            None => empty_document(),
        };
        if doc.parts.is_empty() {
            return Err(SessionError::new(
                "SESSION_BAD_DOCUMENT",
                "the document has no part",
            ));
        }
        let part = match part {
            None => 0,
            Some(id) => doc.parts.iter().position(|p| p.id == id).ok_or_else(|| {
                SessionError::new("SESSION_UNKNOWN_PART", "the document has no such part")
                    .with(json!({ "part": shown(id) }))
            })?,
        };
        let pv = forge_params::evaluate(&doc);
        Ok(Self {
            doc,
            part,
            pv,
            new_params: Vec::new(),
        })
    }

    fn eval(&self, text: &str, field: FieldType) -> Result<f64, ValueError> {
        self.pv
            .scalar(self.part, &Scalar::Expr(text.to_string()), field)
            .map_err(|f| ValueError {
                code: f.code.to_string(),
                message: f.message,
                details: f.details,
            })
    }
}

fn empty_document() -> Document {
    serde_json::from_value(json!({
        "schema": forge_ir::v1::IR_SCHEMA,
        "parts": [{ "id": "part", "name": "part", "features": [] }],
    }))
    .expect("the empty document is valid")
}

/// An id for messages: itself when it matches the id grammar, else a placeholder (never echo
/// strings that fail the grammar, SPEC-v1 §0.3).
fn shown(id: &str) -> String {
    ids::shown(id)
}

// ─── The session ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct UndoEntry {
    sketch: SketchFeature,
    log: Vec<SketchEdit>,
}

/// An interactive editing session of one sketch (see the module docs).
#[derive(Debug, Clone)]
pub struct SketchSession {
    sketch: SketchFeature,
    env: Env,
    current: Snapshot,
    revision: u64,
    log: Vec<SketchEdit>,
    undo: Vec<UndoEntry>,
    redo: Vec<UndoEntry>,
    drag: Option<DragState>,
    conversion: Option<ConversionInfo>,
}

impl SketchSession {
    /// Load a sketch (and the document its expressions use).
    ///
    /// The sketch must have literal geometry (constrained mode, or an explicit sketch of
    /// lines, arcs, circles and points with numbers only). A sketch with compound curves or
    /// expression coordinates needs `convertSketch` first (`SESSION_NEEDS_CONVERSION`).
    pub fn load(req: LoadRequest) -> Result<Self, SessionError> {
        let env = Env::new(req.document, req.part.as_deref())?;
        let mut sketch = parse_sketch(req.sketch)?;
        let mut conversion = None;
        if req.convert.unwrap_or(true) && crate::convert::needs_conversion(&sketch) {
            let vs = |site: &SiteRef<'_>| env.eval(site.text, site.field);
            let ev = |t: &str, f: FieldType| env.eval(t, f).ok();
            let c = crate::convert::convert_to_constrained(&sketch, &vs, &ev)
                .map_err(|e| SessionError::from_sketch(&e))?;
            sketch = c.sketch;
            conversion = Some(ConversionInfo {
                renames: c.renames,
                notes: c.notes,
            });
        }
        for (ci, c) in sketch.curves.iter().enumerate() {
            literal_curve(c).map_err(|e| {
                SessionError::new(
                    "SESSION_NEEDS_CONVERSION",
                    format!(
                        "curve {} is not literal ({}): convert the sketch to constrained mode first",
                        shown(c.id()),
                        e.message
                    ),
                )
                .at(format!("/curves/{ci}"))
            })?;
        }
        let mut s = Self {
            current: placeholder_snapshot(&sketch.id),
            sketch,
            env,
            revision: 0,
            log: Vec::new(),
            undo: Vec::new(),
            redo: Vec::new(),
            drag: None,
            conversion,
        };
        s.current = s.snapshot_of(&s.sketch);
        Ok(s)
    }

    /// A new, empty sketch on `plane`.
    pub fn create(
        id: &str,
        name: &str,
        plane: PlaneRef,
        document: Option<Value>,
        part: Option<String>,
    ) -> Result<Self, SessionError> {
        let sketch = json!({ "id": id, "name": name, "plane": plane, "curves": [] });
        Self::load(LoadRequest {
            sketch,
            document,
            part,
            convert: None,
        })
    }

    /// The current snapshot.
    pub fn snapshot(&self) -> &Snapshot {
        &self.current
    }

    /// The current sketch feature (literal geometry, as committed).
    pub fn sketch(&self) -> &SketchFeature {
        &self.sketch
    }

    /// Every committed edit since load.
    pub fn edits(&self) -> &[SketchEdit] {
        &self.log
    }

    /// Apply an edit batch atomically (see the module docs for the policy).
    pub fn apply(
        &mut self,
        edits: &[SketchEdit],
        opts: ApplyOptions,
    ) -> Result<&Snapshot, Rejection> {
        if self.drag.is_some() {
            return Err(SessionError::new(
                "SESSION_DRAG_ACTIVE",
                "finish or cancel the drag first",
            )
            .into());
        }
        let mut candidate = self.sketch.clone();
        for (k, e) in edits.iter().enumerate() {
            self.apply_edit(&mut candidate, e)
                .map_err(|err| err.with_edit(k))?;
        }
        self.commit(candidate, edits.to_vec(), opts)?;
        Ok(&self.current)
    }

    /// Solve an edit batch without committing it: the tentative result (a rubber band with its
    /// constraints, a dimension before OK).
    pub fn preview(&self, edits: &[SketchEdit], opts: ApplyOptions) -> Result<Snapshot, Rejection> {
        let mut copy = self.clone();
        copy.drag = None;
        copy.apply(edits, opts).cloned()
    }

    /// Undo the last committed change.
    pub fn undo(&mut self) -> bool {
        let Some(prev) = self.undo.pop() else {
            return false;
        };
        self.drag = None;
        let now = UndoEntry {
            sketch: std::mem::replace(&mut self.sketch, prev.sketch),
            log: std::mem::replace(&mut self.log, prev.log),
        };
        self.redo.push(now);
        self.bump();
        true
    }

    /// Redo the last undone change.
    pub fn redo(&mut self) -> bool {
        let Some(next) = self.redo.pop() else {
            return false;
        };
        self.drag = None;
        let now = UndoEntry {
            sketch: std::mem::replace(&mut self.sketch, next.sketch),
            log: std::mem::replace(&mut self.log, next.log),
        };
        self.undo.push(now);
        self.bump();
        true
    }

    /// Evaluate an expression (a dimension being typed) in the sketch's scope: its value in mm
    /// (`length`) or degrees (`angle`), or the evaluator's coded error.
    pub fn eval_expression(&self, text: &str, field: FieldType) -> Result<f64, SessionError> {
        self.env.eval(text, field).map_err(|e| SessionError {
            code: e.code,
            message: e.message,
            details: e.details,
            path: None,
        })
    }

    /// Define a document parameter during the session (`width = 40` typed into a dimension):
    /// checked, evaluated, and returned by [`SketchSession::finish`] for the command layer's
    /// `addParam`. Returns its value.
    pub fn define_param(
        &mut self,
        name: &str,
        unit: ParamUnit,
        value: &str,
    ) -> Result<f64, SessionError> {
        if ids::check_id(name).is_err() {
            return Err(SessionError::new(
                "SESSION_INVALID_ID",
                "a parameter name is a letter or `_` followed by letters, digits or `_`",
            ));
        }
        if forge_ir::v1::reserved_names().contains(&name) {
            return Err(SessionError::new("RESERVED_NAME", "this name is reserved")
                .with(json!({ "name": name })));
        }
        let taken = self.env.doc.params.iter().any(|p| p.name == name)
            || self.env.doc.parts[self.env.part]
                .params
                .iter()
                .any(|p| p.name == name);
        if taken {
            return Err(
                SessionError::new("DUPLICATE_NAME", "a parameter with this name exists")
                    .with(json!({ "name": name })),
            );
        }
        let param = Parameter {
            name: name.to_string(),
            unit,
            value: match value.trim().parse::<f64>() {
                Ok(x) if x.is_finite() => ParamValue::Num(x),
                _ => ParamValue::Expr(value.to_string()),
            },
            min: None,
            max: None,
            note: String::new(),
        };
        let mut doc = self.env.doc.clone();
        doc.params.push(param.clone());
        let pv = forge_params::evaluate(&doc);
        let entry = pv
            .lookup(forge_ir::v1::expr::ExprScope::Document, name)
            .ok_or_else(|| SessionError::new("FORGE_INTERNAL", "the new parameter is missing"))?;
        let v = match &entry.result {
            Ok(v) => v
                .as_num()
                .ok_or_else(|| SessionError::new("EXPR_TYPE", "the parameter is not a number"))?,
            Err(f) => {
                return Err(SessionError {
                    code: f.code.to_string(),
                    message: f.message.clone(),
                    details: f.details.clone(),
                    path: None,
                });
            }
        };
        self.env.doc = doc;
        self.env.pv = pv;
        self.env.new_params.push(param);
        Ok(v)
    }

    // ── Drags ────────────────────────────────────────────────────────────────────────────

    /// Grab a point, a curve or a circle's rim. The sketch must be solved.
    pub fn drag_begin(&mut self, spec: &DragSpec) -> Result<(), SessionError> {
        self.drag = None;
        let ctx = DragCtx::new(&self.sketch, &self.env)?;
        let kind = ctx.kind_of(&self.sketch, spec)?;
        self.drag = Some(DragState {
            ctx,
            kind,
            grab: spec.grab,
            target: spec.target.clone(),
            moved: false,
        });
        Ok(())
    }

    /// One drag frame towards `to` (sketch coordinates).
    pub fn drag_to(&mut self, to: P2) -> Result<DragFrame, SessionError> {
        let Some(d) = self.drag.as_mut() else {
            return Err(SessionError::new("SESSION_NO_DRAG", "no drag is active"));
        };
        if !(to[0].is_finite() && to[1].is_finite()) {
            return Err(SessionError::new(
                "NON_FINITE",
                "the drag target is not finite",
            ));
        }
        let (converged, target_error) = d.frame(to)?;
        d.moved = true;
        Ok(DragFrame {
            converged,
            curves: d.ctx.curves(),
            target_error,
        })
    }

    /// Commit the drag (one undo step; logged as `replaceCurve` edits of the moved curves).
    pub fn drag_end(&mut self) -> Result<&Snapshot, Rejection> {
        let Some(d) = self.drag.take() else {
            return Err(SessionError::new("SESSION_NO_DRAG", "no drag is active").into());
        };
        if !d.moved {
            return Ok(&self.current);
        }
        let solved = d.ctx.curves();
        let mut candidate = self.sketch.clone();
        let mut edits = Vec::new();
        for (c, lc) in candidate.curves.iter_mut().zip(&solved) {
            let next = sketch_curve(lc);
            if *c != next {
                *c = next.clone();
                edits.push(SketchEdit::ReplaceCurve { curve: next });
            }
        }
        if edits.is_empty() {
            return Ok(&self.current);
        }
        self.commit(candidate, edits, ApplyOptions::default())?;
        Ok(&self.current)
    }

    /// Abandon the drag: nothing changes.
    pub fn drag_cancel(&mut self) {
        self.drag = None;
    }

    /// The target of the active drag.
    pub fn drag_target(&self) -> Option<&str> {
        self.drag.as_ref().map(|d| d.target.as_str())
    }

    // ── Finish ───────────────────────────────────────────────────────────────────────────

    /// The finished feature: canonical IR v1 JSON, evaluated with [`evaluate_sketch`] (the
    /// evaluation of record) and validated as IR.
    pub fn finish(&self) -> FinishResult {
        let feature = canonical_feature(&self.sketch, &self.env);
        let vs = |site: &SiteRef<'_>| self.env.eval(site.text, site.field);
        let eval = evaluate_sketch(&self.sketch, &vs, &Frame::world());
        let validation = validate_feature(&self.sketch, &self.env);
        let (ok, error, regions, status, dof, warnings) = match &eval {
            Ok(r) => (
                validation.is_empty(),
                None,
                r.regions.len(),
                r.solve_report.as_ref().map(|d| d.status),
                r.solve_report.as_ref().map(|d| d.dof),
                r.warnings
                    .iter()
                    .map(
                        |w| json!({ "code": w.code, "severity": w.severity, "message": w.message }),
                    )
                    .collect(),
            ),
            Err(e) => (
                false,
                Some(SessionError::from_sketch(e)),
                0,
                e.diagnosis().map(|d| d.status),
                e.diagnosis().map(|d| d.dof),
                Vec::new(),
            ),
        };
        FinishResult {
            feature,
            ok,
            error,
            regions,
            status,
            dof,
            warnings,
            validation,
            edits: self.log.clone(),
            params: self.env.new_params.clone(),
            conversion: self.conversion.clone(),
        }
    }

    /// What loading converted, when it did.
    pub fn conversion(&self) -> Option<&ConversionInfo> {
        self.conversion.as_ref()
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────

    fn bump(&mut self) {
        self.revision += 1;
        self.current = self.snapshot_of(&self.sketch);
    }

    fn commit(
        &mut self,
        mut candidate: SketchFeature,
        edits: Vec<SketchEdit>,
        opts: ApplyOptions,
    ) -> Result<(), Rejection> {
        let prev_ok = self.current.ok;
        let prev_redundant: BTreeSet<String> = self
            .current
            .redundant
            .iter()
            .map(|r| r.constraint.clone())
            .collect();
        let mut snap = self.snapshot_of(&candidate);

        // New redundancies: reject, allow, or drop them (auto-constraints of a gesture).
        for _ in 0..8 {
            let new: Vec<String> = snap
                .redundant
                .iter()
                .map(|r| r.constraint.clone())
                .filter(|c| !prev_redundant.contains(c))
                .collect();
            if new.is_empty() || !snap.ok {
                break;
            }
            if opts.drop_redundant {
                candidate
                    .constraints
                    .retain(|c| !new.iter().any(|n| n == c.id()));
                snap = self.snapshot_of(&candidate);
                continue;
            }
            if opts.allow_redundant {
                break;
            }
            let why: Vec<String> = snap
                .redundant
                .iter()
                .filter(|r| new.contains(&r.constraint))
                .map(|r| r.explanation.clone())
                .collect();
            return Err(Rejection {
                error: SessionError::new(
                    "SESSION_REDUNDANT",
                    format!("already implied: {}", why.join("; ")),
                )
                .with(json!({ "constraints": new })),
                candidate: Some(Box::new(snap)),
            });
        }

        if let Some(err) = &snap.error {
            let conflict_like = matches!(
                err.code.as_str(),
                "SKETCH_CONSTRAINT_CONFLICT" | "SKETCH_SOLVE_FAILED"
            );
            if !conflict_like || (prev_ok && !opts.allow_conflict) {
                return Err(Rejection {
                    error: err.clone(),
                    candidate: Some(Box::new(snap)),
                });
            }
        }

        // Write the solution back (SPEC-v1 §4.4 rule 9), then drop `coincident`s between ends
        // that now weld (§4.6) and solve again: the committed guess is a fixed point.
        if snap.ok {
            for (c, lc) in candidate.curves.iter_mut().zip(&snap.curves) {
                *c = sketch_curve(lc);
            }
            if normalize_welds(&mut candidate) {
                let again = self.snapshot_of(&candidate);
                if !again.ok {
                    return Err(Rejection {
                        error: again.error.clone().unwrap_or_else(|| {
                            SessionError::new("FORGE_INTERNAL", "welding broke the solution")
                        }),
                        candidate: Some(Box::new(again)),
                    });
                }
                for (c, lc) in candidate.curves.iter_mut().zip(&again.curves) {
                    *c = sketch_curve(lc);
                }
            }
        }

        self.undo.push(UndoEntry {
            sketch: std::mem::replace(&mut self.sketch, candidate),
            log: self.log.clone(),
        });
        self.redo.clear();
        self.log.extend(edits);
        self.bump();
        Ok(())
    }

    fn apply_edit(&self, s: &mut SketchFeature, e: &SketchEdit) -> Result<(), SessionError> {
        match e {
            SketchEdit::AddCurve { curve } => {
                literal_curve(curve)?;
                check_new_id(s, curve.id())?;
                s.curves.push(curve.clone());
            }
            SketchEdit::RemoveCurve { id } => {
                let i = curve_index(s, id)?;
                s.curves.remove(i);
                s.constraints.retain(|c| !references_curve(c, id));
            }
            SketchEdit::ReplaceCurve { curve } => {
                literal_curve(curve)?;
                let i = curve_index(s, curve.id())?;
                if s.curves[i].kind() != curve.kind() {
                    return Err(SessionError::new(
                        "SESSION_KIND_CHANGE",
                        "replaceCurve keeps the curve's kind",
                    )
                    .with(json!({ "curve": shown(curve.id()), "kind": s.curves[i].kind(), "new": curve.kind() })));
                }
                s.curves[i] = curve.clone();
            }
            SketchEdit::SetConstruction { id, construction } => {
                let i = curve_index(s, id)?;
                set_construction(&mut s.curves[i], *construction);
            }
            SketchEdit::AddConstraint { constraint } => {
                check_new_id(s, constraint.id())?;
                if let Some((value, driving)) = constraint.dimension() {
                    if driving && value.is_none() {
                        return Err(SessionError::new(
                            "CONSTRAINT_VALUE_REQUIRED",
                            "a driving dimension needs a value",
                        )
                        .with(json!({ "constraint": shown(constraint.id()) })));
                    }
                    if !driving && value.is_some() {
                        return Err(SessionError::new(
                            "CONSTRAINT_VALUE_ON_REFERENCE",
                            "a reference dimension has no value",
                        )
                        .with(json!({ "constraint": shown(constraint.id()) })));
                    }
                }
                s.constraints.push(constraint.clone());
            }
            SketchEdit::RemoveConstraint { id } => {
                let i = constraint_index(s, id)?;
                s.constraints.remove(i);
            }
            SketchEdit::SetDimension { id, value, driving } => {
                let i = constraint_index(s, id)?;
                let measured = self
                    .current
                    .constraints
                    .iter()
                    .find(|c| &c.id == id)
                    .and_then(|c| c.measured);
                set_dimension(&mut s.constraints[i], value.clone(), *driving, measured)?;
            }
            SketchEdit::MoveTo { point, to } => {
                if !(to[0].is_finite() && to[1].is_finite()) {
                    return Err(SessionError::new("NON_FINITE", "the target is not finite"));
                }
                let mut ctx = DragCtx::new(s, &self.env)?;
                // A circle id moves its rim (the radius), as the MoveTo docs say.
                let rim = s
                    .curves
                    .iter()
                    .any(|c| c.id() == point && matches!(c, SketchCurve::Circle { .. }));
                let spec = DragSpec {
                    target: point.clone(),
                    grab: ctx.anchor(s, point).unwrap_or(*to),
                    mode: rim.then(|| "rim".to_string()),
                };
                let kind = ctx.kind_of(s, &spec)?;
                let mut state = DragState {
                    ctx,
                    kind,
                    grab: spec.grab,
                    target: point.clone(),
                    moved: false,
                };
                // Walk there in a few frames, as a drag would (large jumps can leave the
                // basin of the current configuration).
                const STEPS: usize = 8;
                for k in 1..=STEPS {
                    let t = k as f64 / STEPS as f64;
                    let p = [
                        spec.grab[0] + (to[0] - spec.grab[0]) * t,
                        spec.grab[1] + (to[1] - spec.grab[1]) * t,
                    ];
                    state.frame(p)?;
                }
                ctx = state.ctx;
                for (c, lc) in s.curves.iter_mut().zip(ctx.curves()) {
                    *c = sketch_curve(&lc);
                }
            }
        }
        Ok(())
    }

    /// Solve `sketch` and describe it.
    fn snapshot_of(&self, sketch: &SketchFeature) -> Snapshot {
        let vs = |site: &SiteRef<'_>| self.env.eval(site.text, site.field);
        let mut snap = placeholder_snapshot(&sketch.id);
        snap.revision = self.revision;
        snap.can_undo = !self.undo.is_empty();
        snap.can_redo = !self.redo.is_empty();
        let cvals = constraint_values(sketch, &vs).ok();
        match solve_constrained(sketch, &vs) {
            Ok(cs) => {
                let diag = &cs.diagnosis;
                snap.ok = true;
                snap.status = Some(diag.status);
                snap.dof = Some(diag.dof);
                snap.entities = entity_dofs(&cs.stored, diag);
                snap.constraints = constraint_infos(sketch, Some(&cs.values), Some(diag));
                for d in &cs.dimensions {
                    if let Some(ci) = snap.constraints.iter_mut().find(|c| c.id == d.id) {
                        ci.measured = Some(d.measured).filter(|m| m.is_finite());
                    }
                }
                snap.redundant = redundancies(diag);
                snap.welds = diag.welds.iter().map(|w| w.members.clone()).collect();
                snap.explanation = diag.solver.explanation.clone();
                snap.profile = profile_of(&sketch.id, &cs.solved);
                snap.curves = cs.solved;
            }
            Err(e) => {
                snap.error = Some(SessionError::from_sketch(&e));
                let stored = stored_geometry(sketch).ok();
                snap.curves = stored.as_deref().map(welded_guess).unwrap_or_default();
                if let Some(diag) = e.diagnosis() {
                    snap.status = Some(diag.status);
                    snap.dof = Some(diag.dof);
                    if let Some(stored) = &stored {
                        snap.entities = entity_dofs(stored, diag);
                    }
                    snap.redundant = redundancies(diag);
                    snap.conflicts = diag
                        .conflicts
                        .iter()
                        .map(|c| ConflictInfo {
                            constraints: c.constraints.clone(),
                            suggested_removal: c.suggested_removal.clone(),
                            verified_minimal: c.verified_minimal,
                            explanation: c.explanation.clone(),
                        })
                        .collect();
                    snap.welds = diag.welds.iter().map(|w| w.members.clone()).collect();
                    snap.explanation = diag.solver.explanation.clone();
                }
                snap.constraints = constraint_infos(sketch, cvals.as_deref(), e.diagnosis());
                if let Some(diag) = e.diagnosis() {
                    for ci in &mut snap.constraints {
                        if ci.driving.is_some()
                            && let Some(r) = diag.solver.constraints.iter().find(|r| r.id == ci.id)
                        {
                            ci.measured = r.measured.filter(|m| m.is_finite());
                        }
                    }
                }
            }
        }
        snap
    }
}

trait WithEdit {
    fn with_edit(self, k: usize) -> Rejection;
}

impl WithEdit for SessionError {
    fn with_edit(mut self, k: usize) -> Rejection {
        self.details.insert("edit".into(), json!(k));
        self.into()
    }
}

fn placeholder_snapshot(sketch: &str) -> Snapshot {
    Snapshot {
        revision: 0,
        sketch: sketch.to_string(),
        curves: Vec::new(),
        ok: false,
        status: None,
        dof: None,
        error: None,
        entities: Vec::new(),
        constraints: Vec::new(),
        conflicts: Vec::new(),
        redundant: Vec::new(),
        welds: Vec::new(),
        profile: ProfileInfo::default(),
        explanation: String::new(),
        can_undo: false,
        can_redo: false,
    }
}

// ─── Drags ───────────────────────────────────────────────────────────────────────────────────

/// A forge-solve solver on the lowered sketch, at a solution.
#[derive(Debug, Clone)]
struct DragCtx {
    stored: Vec<LiteralCurve>,
    welding: Welding,
    lowered: forge_solve::Sketch,
    solver: Solver,
}

#[derive(Debug, Clone)]
enum DragKind {
    /// Translate these solver points by the pointer's motion (their start positions).
    Points(Vec<(String, P2)>),
    /// A circle's radius follows the pointer.
    Rim { circle: String, center: String },
}

#[derive(Debug, Clone)]
struct DragState {
    ctx: DragCtx,
    kind: DragKind,
    grab: P2,
    target: String,
    moved: bool,
}

impl DragState {
    /// One frame: returns (converged, distance of the grabbed point to the target).
    fn frame(&mut self, to: P2) -> Result<(bool, f64), SessionError> {
        let delta = [to[0] - self.grab[0], to[1] - self.grab[1]];
        match &self.kind {
            DragKind::Points(points) => {
                let mut converged = true;
                let mut err = 0.0f64;
                for (id, p0) in points {
                    let target = [p0[0] + delta[0], p0[1] + delta[1]];
                    match self.ctx.solver.drag(id, target) {
                        Ok(r) => {
                            converged &= r.converged;
                            err = err.max(r.target_error);
                        }
                        // A point every constraint pins (or a fixed entity): it stays.
                        Err(_) => {
                            let at = self.ctx.solver.point(id).unwrap_or(*p0);
                            err = err.max(forge_core::math::hypot(
                                at[0] - target[0],
                                at[1] - target[1],
                            ));
                        }
                    }
                }
                Ok((converged, err))
            }
            DragKind::Rim { circle, center } => {
                let c = self.ctx.solver.point(center).unwrap_or([0.0, 0.0]);
                let r = forge_core::math::hypot(to[0] - c[0], to[1] - c[1]);
                if !(r.is_finite() && r > forge_ir::v1::LINEAR_TOLERANCE) {
                    return Ok((false, r));
                }
                let mut sk = self.ctx.solver.sketch();
                if let Some(e) = sk.entities.iter_mut().find(|e| &e.id == circle)
                    && let forge_solve::Geometry::Circle { radius, .. } = &mut e.geometry
                {
                    *radius = r;
                }
                sk.constraints.push(forge_solve::Constraint::new(
                    "__session_drag_radius",
                    forge_solve::c::radius(circle, r),
                ));
                let Ok(mut solver) = Solver::new(&sk, &solve_options_v1()) else {
                    return Ok((false, r));
                };
                let res = solver.solve();
                if !res.status.is_solved() {
                    return Ok((false, r));
                }
                // Keep the geometry, not the temporary constraint.
                let mut plain = solver.sketch();
                plain.constraints = self.ctx.lowered.constraints.clone();
                let Ok(mut s2) = Solver::new(&plain, &solve_options_v1()) else {
                    return Ok((false, r));
                };
                let _ = s2.solve();
                self.ctx.solver = s2;
                Ok((true, 0.0))
            }
        }
    }
}

impl DragCtx {
    fn new(s: &SketchFeature, env: &Env) -> Result<Self, SessionError> {
        let vs = |site: &SiteRef<'_>| env.eval(site.text, site.field);
        let stored = stored_geometry(s).map_err(|e| SessionError::from_sketch(&e))?;
        let cvals = constraint_values(s, &vs).map_err(|e| SessionError::from_sketch(&e))?;
        let welding = Welding::compute(&stored);
        if let Some(&ci) = welding.collapsed_curves().first() {
            return Err(SessionError::new(
                "DEGENERATE_CURVE",
                "a curve's ends weld into one point",
            )
            .with(json!({ "curve": stored[ci].id() })));
        }
        let lowered = lower(&stored, &s.constraints, &cvals, &welding);
        let mut solver = Solver::new(&lowered.sketch, &solve_options_v1())
            .map_err(|e| SessionError::from_sketch(&SketchError::Solver(e)))?;
        let r = solver.solve();
        if !r.status.is_solved() {
            return Err(SessionError::new(
                "SESSION_UNSOLVED",
                "the sketch does not solve: fix the conflict before dragging",
            ));
        }
        Ok(Self {
            stored,
            welding,
            lowered: lowered.sketch,
            solver,
        })
    }

    fn solver_id<'a>(&'a self, ir: &'a str) -> &'a str {
        self.welding.resolve(ir)
    }

    /// The current position of an IR point reference, or of a circle's rim nearest `grab`.
    fn anchor(&self, s: &SketchFeature, target: &str) -> Option<P2> {
        if let Some(c) = s.curves.iter().find(|c| c.id() == target)
            && let SketchCurve::Circle { .. } = c
        {
            // A circle target (MoveTo): the rim point on +u.
            let center = self.solver.point(&format!("{target}.center"))?;
            let r = self
                .solver
                .sketch()
                .entities
                .iter()
                .find_map(|e| match &e.geometry {
                    forge_solve::Geometry::Circle { radius, .. } if e.id == target => Some(*radius),
                    _ => None,
                })?;
            return Some([center[0] + r, center[1]]);
        }
        self.solver.point(self.solver_id(target))
    }

    fn kind_of(&self, s: &SketchFeature, spec: &DragSpec) -> Result<DragKind, SessionError> {
        let t = spec.target.as_str();
        let unknown = || {
            SessionError::new("SESSION_UNKNOWN_ID", "nothing to drag with this id")
                .with(json!({ "target": shown(t) }))
        };
        if let Some(curve) = s.curves.iter().find(|c| c.id() == t) {
            let pts: Vec<String> = match curve {
                SketchCurve::Point { .. } => vec![t.to_string()],
                SketchCurve::Line { .. } => vec![format!("{t}.start"), format!("{t}.end")],
                SketchCurve::Arc { .. } => vec![
                    format!("{t}.center"),
                    format!("{t}.start"),
                    format!("{t}.end"),
                ],
                SketchCurve::Circle { .. } => {
                    if spec.mode.as_deref() == Some("rim") {
                        return Ok(DragKind::Rim {
                            circle: t.to_string(),
                            center: format!("{t}.center"),
                        });
                    }
                    vec![format!("{t}.center")]
                }
                _ => return Err(unknown()),
            };
            let mut out = Vec::new();
            for p in pts {
                let sid = self.solver_id(&p).to_string();
                let at = self.solver.point(&sid).ok_or_else(unknown)?;
                if !out.iter().any(|(q, _): &(String, P2)| *q == sid) {
                    out.push((sid, at));
                }
            }
            return Ok(DragKind::Points(out));
        }
        // A derived point `<curve>.<start|end|center>`.
        let (curve, which) = t.rsplit_once('.').ok_or_else(unknown)?;
        let ok = s.curves.iter().any(|c| {
            c.id() == curve
                && matches!(
                    (c, which),
                    (
                        SketchCurve::Line { .. } | SketchCurve::Arc { .. },
                        "start" | "end"
                    ) | (
                        SketchCurve::Arc { .. } | SketchCurve::Circle { .. },
                        "center"
                    )
                )
        });
        if !ok {
            return Err(unknown());
        }
        let sid = self.solver_id(t).to_string();
        let at = self.solver.point(&sid).ok_or_else(unknown)?;
        Ok(DragKind::Points(vec![(sid, at)]))
    }

    /// The current geometry, curve for curve (aliases at their representative).
    fn curves(&self) -> Vec<LiteralCurve> {
        let sk = self.solver.sketch();
        let mut points: BTreeMap<&str, P2> = BTreeMap::new();
        let mut radii: BTreeMap<&str, f64> = BTreeMap::new();
        for e in &sk.entities {
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
        let point = |id: &str| -> P2 {
            points
                .get(self.welding.resolve(id))
                .copied()
                .unwrap_or([f64::NAN, f64::NAN])
        };
        self.stored
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
                    radius: radii.get(id.as_str()).copied().unwrap_or(f64::NAN),
                    construction: *construction,
                },
            })
            .collect()
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────

fn parse_sketch(v: Value) -> Result<SketchFeature, SessionError> {
    let mut v = v;
    if let Value::Object(m) = &mut v {
        match m.get("type") {
            Some(Value::String(t)) if t == "sketch" => {
                m.remove("type");
            }
            Some(_) => {
                return Err(SessionError::new(
                    "SESSION_NOT_A_SKETCH",
                    "the feature is not a sketch",
                ));
            }
            None => {}
        }
    }
    serde_json::from_value(v).map_err(|e| {
        SessionError::new(
            "SESSION_BAD_SKETCH",
            format!("not an IR v1 sketch feature: {e}"),
        )
    })
}

/// A curve the session can hold: `line`, `arc`, `circle` or `point` with finite numbers only.
fn literal_curve(c: &SketchCurve) -> Result<(), SessionError> {
    let num = |s: &Scalar| matches!(s, Scalar::Num(x) if x.is_finite());
    let p2 = |p: &forge_ir::v1::SP2| num(&p[0]) && num(&p[1]);
    let ok = match c {
        SketchCurve::Line { start, end, .. } => p2(start) && p2(end),
        SketchCurve::Arc {
            start, end, center, ..
        } => p2(start) && p2(end) && p2(center),
        SketchCurve::Circle { center, radius, .. } => p2(center) && num(radius),
        SketchCurve::Point { at, .. } => p2(at),
        SketchCurve::Rect { .. } | SketchCurve::Slot { .. } | SketchCurve::Polygon { .. } => {
            return Err(SessionError::new(
                "SESSION_NOT_LITERAL",
                "compound curves (rect, slot, polygon) are expanded to lines and arcs in the sketcher",
            )
            .with(json!({ "curve": shown(c.id()), "kind": c.kind() })));
        }
    };
    if ok {
        Ok(())
    } else {
        Err(SessionError::new(
            "SESSION_NOT_LITERAL",
            "curve coordinates must be finite numbers (parametric sizes are dimensions)",
        )
        .with(json!({ "curve": shown(c.id()) })))
    }
}

fn check_new_id(s: &SketchFeature, id: &str) -> Result<(), SessionError> {
    if ids::check_id(id).is_err() {
        return Err(SessionError::new(
            "SESSION_INVALID_ID",
            "an id is a letter or `_` followed by letters, digits or `_` (at most 64 bytes)",
        ));
    }
    if s.curves.iter().any(|c| c.id() == id) || s.constraints.iter().any(|c| c.id() == id) {
        return Err(
            SessionError::new("DUPLICATE_ID", "the id is already used in this sketch")
                .with(json!({ "id": id })),
        );
    }
    Ok(())
}

fn curve_index(s: &SketchFeature, id: &str) -> Result<usize, SessionError> {
    s.curves.iter().position(|c| c.id() == id).ok_or_else(|| {
        SessionError::new("SESSION_UNKNOWN_ID", "no curve with this id")
            .with(json!({ "curve": shown(id) }))
    })
}

fn constraint_index(s: &SketchFeature, id: &str) -> Result<usize, SessionError> {
    s.constraints
        .iter()
        .position(|c| c.id() == id)
        .ok_or_else(|| {
            SessionError::new("SESSION_UNKNOWN_ID", "no constraint with this id")
                .with(json!({ "constraint": shown(id) }))
        })
}

/// A constraint names the curve or one of its derived points.
fn references_curve(c: &Constraint, curve: &str) -> bool {
    c.arguments().iter().any(|(_, arg)| {
        *arg == curve
            || arg
                .strip_prefix(curve)
                .is_some_and(|rest| rest.starts_with('.'))
    })
}

fn set_construction(c: &mut SketchCurve, flag: bool) {
    match c {
        SketchCurve::Line { construction, .. }
        | SketchCurve::Arc { construction, .. }
        | SketchCurve::Circle { construction, .. }
        | SketchCurve::Point { construction, .. }
        | SketchCurve::Rect { construction, .. }
        | SketchCurve::Slot { construction, .. }
        | SketchCurve::Polygon { construction, .. } => *construction = flag,
    }
}

fn set_dimension(
    c: &mut Constraint,
    new_value: Option<Scalar>,
    new_driving: Option<bool>,
    measured: Option<f64>,
) -> Result<(), SessionError> {
    let id = c.id().to_string();
    let (value, driving) = match c {
        Constraint::Distance { value, driving, .. }
        | Constraint::Angle { value, driving, .. }
        | Constraint::Radius { value, driving, .. }
        | Constraint::Diameter { value, driving, .. } => (value, driving),
        _ => {
            return Err(SessionError::new(
                "SKETCH_NOT_A_DIMENSION",
                "only distance, angle, radius and diameter have a value",
            )
            .with(json!({ "constraint": shown(&id) })));
        }
    };
    let drive = new_driving.unwrap_or(if new_value.is_some() { true } else { *driving });
    if !drive {
        if new_value.is_some() {
            return Err(SessionError::new(
                "CONSTRAINT_VALUE_ON_REFERENCE",
                "a reference dimension has no value",
            )
            .with(json!({ "constraint": shown(&id) })));
        }
        *driving = false;
        *value = None;
        return Ok(());
    }
    let v = match new_value {
        Some(v) => v,
        None => match (value.clone(), measured) {
            (Some(v), _) => v,
            (None, Some(m)) => Scalar::Num(m),
            (None, None) => {
                return Err(SessionError::new(
                    "CONSTRAINT_VALUE_REQUIRED",
                    "the dimension has no measured value to drive at",
                )
                .with(json!({ "constraint": shown(&id) })));
            }
        },
    };
    if let Scalar::Num(x) = &v
        && !x.is_finite()
    {
        return Err(SessionError::new("NON_FINITE", "the value is not finite"));
    }
    *driving = true;
    *value = Some(v);
    Ok(())
}

/// A literal curve as an IR curve (numbers only).
pub fn sketch_curve(lc: &LiteralCurve) -> SketchCurve {
    let n = |x: f64| Scalar::Num(x + 0.0);
    let p = |q: P2| [n(q[0]), n(q[1])];
    match lc {
        LiteralCurve::Line {
            id,
            start,
            end,
            construction,
        } => SketchCurve::Line {
            id: id.clone(),
            start: p(*start),
            end: p(*end),
            construction: *construction,
        },
        LiteralCurve::Arc {
            id,
            start,
            end,
            center,
            ccw,
            construction,
        } => SketchCurve::Arc {
            id: id.clone(),
            start: p(*start),
            end: p(*end),
            center: p(*center),
            ccw: *ccw,
            construction: *construction,
        },
        LiteralCurve::Circle {
            id,
            center,
            radius,
            construction,
        } => SketchCurve::Circle {
            id: id.clone(),
            center: p(*center),
            radius: n(*radius),
            construction: *construction,
        },
        LiteralCurve::Point {
            id,
            at,
            construction,
        } => SketchCurve::Point {
            id: id.clone(),
            at: p(*at),
            construction: *construction,
        },
    }
}

/// Drop `coincident` constraints between line/arc ends that weld in the (written-back)
/// geometry. Returns whether anything was dropped.
fn normalize_welds(s: &mut SketchFeature) -> bool {
    let Ok(stored) = stored_geometry(s) else {
        return false;
    };
    let w = Welding::compute(&stored);
    let before = s.constraints.len();
    s.constraints.retain(|c| match c {
        Constraint::Coincident { a, b, .. } => !(a != b && w.resolve(a) == w.resolve(b)),
        _ => true,
    });
    s.constraints.len() != before
}

fn entity_dofs(stored: &[LiteralCurve], diag: &SolveDiagnosis) -> Vec<EntityDof> {
    let welding = Welding::compute(stored);
    let by_id: BTreeMap<&str, &forge_solve::EntityReport> = diag
        .solver
        .entities
        .iter()
        .map(|e| (e.id.as_str(), e))
        .collect();
    let pd = |ir: &str| -> PointDof {
        match by_id.get(welding.resolve(ir)) {
            Some(e) => PointDof {
                dof: e.dof,
                free_direction: e.free_direction,
            },
            None => PointDof {
                dof: 0,
                free_direction: None,
            },
        }
    };
    let own = |id: &str| by_id.get(id).map_or(0, |e| e.dof);
    stored
        .iter()
        .map(|c| {
            let id = c.id().to_string();
            let mut points = BTreeMap::new();
            let (kind, radius_free) = match c {
                LiteralCurve::Point { .. } => {
                    points.insert("at", pd(&id));
                    ("point", None)
                }
                LiteralCurve::Line { .. } => {
                    points.insert("start", pd(&format!("{id}.start")));
                    points.insert("end", pd(&format!("{id}.end")));
                    ("line", None)
                }
                LiteralCurve::Arc { .. } => {
                    points.insert("start", pd(&format!("{id}.start")));
                    points.insert("end", pd(&format!("{id}.end")));
                    points.insert("center", pd(&format!("{id}.center")));
                    ("arc", None)
                }
                LiteralCurve::Circle { .. } => {
                    points.insert("center", pd(&format!("{id}.center")));
                    ("circle", by_id.get(id.as_str()).and_then(|e| e.radius_free))
                }
            };
            EntityDof {
                dof: own(&id),
                id,
                kind,
                points,
                radius_free,
            }
        })
        .collect()
}

fn constraint_infos(
    sketch: &SketchFeature,
    values: Option<&[crate::ConstraintValues]>,
    diag: Option<&SolveDiagnosis>,
) -> Vec<ConstraintInfo> {
    sketch
        .constraints
        .iter()
        .enumerate()
        .map(|(k, c)| {
            let id = c.id().to_string();
            let mut state = diag.and_then(|d| {
                d.solver
                    .constraints
                    .iter()
                    .find(|r| r.id == id)
                    .map(|r| r.state)
            });
            if state.is_none()
                && let Some(d) = diag
            {
                if d.conflicts.iter().any(|s| s.constraints.contains(&id)) {
                    state = Some(ConstraintState::Conflicting);
                } else if let Some(r) = d.redundant.iter().find(|r| r.constraint == id) {
                    state = Some(if r.partial {
                        ConstraintState::PartiallyRedundant
                    } else {
                        ConstraintState::Redundant
                    });
                }
            }
            let (driving, value, expr) = match c.dimension() {
                Some((v, driving)) => (
                    Some(driving),
                    values.and_then(|vs| vs.get(k)).and_then(|cv| cv.value),
                    v.and_then(|v| v.expr().map(str::to_string)),
                ),
                None => (None, None, None),
            };
            ConstraintInfo {
                id,
                kind: c.type_name(),
                state,
                driving,
                value,
                expr,
                measured: None,
            }
        })
        .collect()
}

fn redundancies(diag: &SolveDiagnosis) -> Vec<RedundancyInfo> {
    diag.redundant
        .iter()
        .map(|r| RedundancyInfo {
            constraint: r.constraint.clone(),
            partial: r.partial,
            implied_by: r.implied_by.clone(),
            explanation: r.explanation.clone(),
        })
        .collect()
}

fn profile_of(sketch_id: &str, solved: &[LiteralCurve]) -> ProfileInfo {
    let profile = regions::profile_curves(solved);
    match regions::regions_of(sketch_id, &profile) {
        Ok(rs) => ProfileInfo {
            regions: rs
                .iter()
                .map(|r| {
                    let edges = |lp: &forge_ops::Loop| -> Vec<LoopEdge> {
                        lp.curves
                            .iter()
                            .map(|c| LoopEdge {
                                id: c.id.clone(),
                                reversed: c.reversed,
                            })
                            .collect()
                    };
                    RegionInfo {
                        area: r.area + 0.0,
                        outer: edges(&r.outer),
                        holes: r.holes.iter().map(edges).collect(),
                    }
                })
                .collect(),
            error: None,
        },
        Err(e) => ProfileInfo {
            regions: Vec::new(),
            error: Some(SessionError::from_sketch(&e)),
        },
    }
}

/// The feature as canonical IR v1 JSON (`"type": "sketch"` first).
fn canonical_feature(sketch: &SketchFeature, env: &Env) -> Value {
    let mut doc = env.doc.clone();
    doc.parts = vec![forge_ir::v1::PartStudio {
        id: "part".into(),
        name: "part".into(),
        params: Vec::new(),
        features: vec![Feature::Sketch(sketch.clone())],
    }];
    let text = forge_ir::v1::to_json(&doc);
    // Correctly rounded numbers (serde_json's own parser is up to an ulp off, [W0-11]).
    forge_ir::v1::json::parse(&text)
        .ok()
        .and_then(|v| v.pointer("/parts/0/features/0").cloned())
        .unwrap_or(Value::Null)
}

/// IR validation of the feature inside a minimal document with the session's parameters. A
/// sketch on a face or a datum is validated on `XY` (its plane reference is the command
/// layer's to check against the real document).
fn validate_feature(sketch: &SketchFeature, env: &Env) -> Vec<SessionError> {
    let mut s = sketch.clone();
    if matches!(s.plane, PlaneRef::Face(_) | PlaneRef::Datum(_)) {
        s.plane = serde_json::from_value(json!("XY")).expect("XY is a plane");
    }
    let mut doc = env.doc.clone();
    let part = &env.doc.parts[env.part];
    doc.parts = vec![forge_ir::v1::PartStudio {
        id: part.id.clone(),
        name: part.name.clone(),
        params: part.params.clone(),
        features: vec![Feature::Sketch(s)],
    }];
    let text = match serde_json::to_string(&doc) {
        Ok(t) => t,
        Err(e) => return vec![SessionError::new("FORGE_INTERNAL", e.to_string())],
    };
    match forge_ir::v1::from_json_with(&text, &forge_ir::v1::expr::options()) {
        Ok(_) => Vec::new(),
        Err(e) => {
            if e.errors().is_empty() {
                return vec![SessionError::new("IR_PARSE", e.to_string())];
            }
            e.errors()
                .iter()
                .map(|v| {
                    let path = v
                        .path
                        .strip_prefix("/parts/0/features/0")
                        .unwrap_or(&v.path)
                        .to_string();
                    SessionError {
                        code: v.code.to_string(),
                        message: v.message.clone(),
                        details: match &v.details {
                            Value::Object(m) => m.clone(),
                            _ => Map::new(),
                        },
                        path: Some(path),
                    }
                })
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_curve_matches_the_curve_and_its_derived_points_only() {
        let c: Constraint = serde_json::from_value(json!({
            "id": "k", "type": "coincident", "a": "l1.end", "b": "l10.start"
        }))
        .unwrap();
        assert!(references_curve(&c, "l1"));
        assert!(references_curve(&c, "l10"));
        assert!(!references_curve(&c, "l"));
        assert!(!references_curve(&c, "l2"));
    }

    #[test]
    fn edits_round_trip_through_their_json_shape() {
        let edits = json!([
            { "op": "addCurve", "curve": { "kind": "line", "id": "l1", "start": [0, 0], "end": [10, 0] } },
            { "op": "addConstraint", "constraint": { "id": "h1", "type": "horizontal", "line": "l1" } },
            { "op": "setDimension", "id": "d1", "value": "width * 2" },
            { "op": "setDimension", "id": "d1", "driving": false },
            { "op": "moveTo", "point": "l1.end", "to": [5, 5] },
            { "op": "setConstruction", "id": "l1", "construction": true },
            { "op": "removeConstraint", "id": "h1" },
            { "op": "replaceCurve", "curve": { "kind": "point", "id": "p", "at": [1, 2] } },
            { "op": "removeCurve", "id": "l1" }
        ]);
        let parsed: Vec<SketchEdit> = serde_json::from_value(edits.clone()).unwrap();
        assert_eq!(parsed.len(), 9);
        let back = serde_json::to_value(&parsed).unwrap();
        let again: Vec<SketchEdit> = serde_json::from_value(back).unwrap();
        assert_eq!(parsed, again);
    }
}
