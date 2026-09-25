//! The interactive sketch session (forge_sketch::session, contract C5): edits, the
//! conflict/redundancy policy, write-back to a fixed point, welding normalization, drags,
//! expressions and parameters, undo/redo, and `finish` against the evaluation of record.

// Exact values of exact inputs (a pinned corner, literal parameters) are compared exactly.
#![allow(clippy::float_cmp)]

use forge_core::linalg::Frame;
use forge_ir::v1::{Feature, LiteralCurve, ParamUnit, SketchFeature};
use forge_sketch::session::{
    ApplyOptions, DragSpec, LoadRequest, SketchEdit, SketchSession, Snapshot,
};
use forge_sketch::{ResolvedValues, evaluate_sketch};
use forge_solve::{ConstraintState, SolveStatus};
use proptest::prelude::*;
use serde_json::{Value, json};

fn session() -> SketchSession {
    load(
        json!({ "id": "s1", "name": "base", "plane": "XY", "curves": [] }),
        None,
    )
}

fn load(sketch: Value, document: Option<Value>) -> SketchSession {
    SketchSession::load(LoadRequest {
        sketch,
        document,
        part: None,
        convert: None,
    })
    .expect("loads")
}

fn edits(v: Value) -> Vec<SketchEdit> {
    serde_json::from_value(v).expect("edits parse")
}

fn apply(s: &mut SketchSession, v: Value) -> Snapshot {
    s.apply(&edits(v), ApplyOptions::default())
        .unwrap_or_else(|r| panic!("rejected: {:?}", r.error))
        .clone()
}

/// Four lines of a w × h rectangle with its lower-left corner at (x, y), ends welded.
fn rect_edits(x: f64, y: f64, w: f64, h: f64) -> Value {
    let (x1, y1) = (x + w, y + h);
    json!([
        { "op": "addCurve", "curve": { "kind": "line", "id": "bottom", "start": [x, y], "end": [x1, y] } },
        { "op": "addCurve", "curve": { "kind": "line", "id": "right", "start": [x1, y], "end": [x1, y1] } },
        { "op": "addCurve", "curve": { "kind": "line", "id": "top", "start": [x1, y1], "end": [x, y1] } },
        { "op": "addCurve", "curve": { "kind": "line", "id": "left", "start": [x, y1], "end": [x, y] } },
        { "op": "addConstraint", "constraint": { "id": "h1", "type": "horizontal", "line": "bottom" } },
        { "op": "addConstraint", "constraint": { "id": "h2", "type": "horizontal", "line": "top" } },
        { "op": "addConstraint", "constraint": { "id": "v1", "type": "vertical", "line": "left" } },
        { "op": "addConstraint", "constraint": { "id": "v2", "type": "vertical", "line": "right" } }
    ])
}

fn line(snap: &Snapshot, id: &str) -> ([f64; 2], [f64; 2]) {
    snap.curves
        .iter()
        .find_map(|c| match c {
            LiteralCurve::Line {
                id: i, start, end, ..
            } if i == id => Some((*start, *end)),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no line {id}"))
}

fn dof(snap: &Snapshot, id: &str) -> usize {
    snap.entities
        .iter()
        .find(|e| e.id == id)
        .expect("entity")
        .dof
}

fn state(snap: &Snapshot, id: &str) -> Option<ConstraintState> {
    snap.constraints
        .iter()
        .find(|c| c.id == id)
        .and_then(|c| c.state)
}

fn feature_of(v: &Value) -> SketchFeature {
    match serde_json::from_value::<Feature>(v.clone()).expect("a feature") {
        Feature::Sketch(s) => s,
        other => panic!("not a sketch: {}", other.type_name()),
    }
}

#[test]
fn a_rectangle_becomes_fully_constrained_with_two_dimensions_and_a_fix() {
    let mut s = session();
    let snap = apply(&mut s, rect_edits(0.0, 0.0, 30.0, 20.0));
    assert!(snap.ok);
    assert_eq!(snap.status, Some(SolveStatus::UnderConstrained));
    assert_eq!(snap.dof, Some(4), "position (2) + width + height");
    assert_eq!(snap.welds.len(), 4, "four welded corners");
    assert_eq!(snap.profile.regions.len(), 1);
    assert!((snap.profile.regions[0].area - 600.0).abs() < 1e-9);

    let snap = apply(
        &mut s,
        json!([
            { "op": "addConstraint", "constraint": { "id": "w", "type": "distance", "a": "bottom.start", "b": "bottom.end", "value": 40 } },
            { "op": "addConstraint", "constraint": { "id": "h", "type": "distance", "a": "right.start", "b": "right.end", "value": 25 } }
        ]),
    );
    assert_eq!(snap.dof, Some(2));
    let (a, b) = line(&snap, "bottom");
    assert!(
        ((b[0] - a[0]).abs() - 40.0).abs() < 1e-9,
        "the width follows its dimension"
    );
    let w = snap.constraints.iter().find(|c| c.id == "w").unwrap();
    assert_eq!((w.driving, w.value), (Some(true), Some(40.0)));
    assert!((w.measured.unwrap() - 40.0).abs() < 1e-9);

    let snap = apply(
        &mut s,
        json!([{ "op": "addConstraint", "constraint": { "id": "pin", "type": "fix", "entity": "bottom.start", "x": 0, "y": 0 } }]),
    );
    assert_eq!(snap.status, Some(SolveStatus::FullyConstrained));
    assert_eq!(snap.dof, Some(0));
    for id in ["bottom", "right", "top", "left"] {
        assert_eq!(dof(&snap, id), 0, "{id} is fully constrained");
    }
    assert_eq!(state(&snap, "pin"), Some(ConstraintState::Satisfied));
}

#[test]
fn per_entity_dof_names_the_points_of_each_curve() {
    let mut s = session();
    let snap = apply(
        &mut s,
        json!([
            { "op": "addCurve", "curve": { "kind": "arc", "id": "a", "start": [10, 0], "end": [0, 10], "center": [0, 0], "ccw": true } },
            { "op": "addCurve", "curve": { "kind": "circle", "id": "c", "center": [30, 0], "radius": 5 } },
            { "op": "addCurve", "curve": { "kind": "point", "id": "p", "at": [5, 5] } },
            { "op": "addConstraint", "constraint": { "id": "fc", "type": "fix", "entity": "a.center" } }
        ]),
    );
    let arc = snap.entities.iter().find(|e| e.id == "a").unwrap();
    assert_eq!(arc.kind, "arc");
    assert_eq!(arc.points["center"].dof, 0);
    assert_eq!(arc.points["start"].dof, 2);
    assert_eq!(arc.dof, 3, "radius + two angles");
    let circle = snap.entities.iter().find(|e| e.id == "c").unwrap();
    assert_eq!((circle.dof, circle.radius_free), (3, Some(true)));
    assert_eq!(
        snap.entities.iter().find(|e| e.id == "p").unwrap().points["at"].dof,
        2
    );
}

#[test]
fn a_conflicting_dimension_is_rejected_with_the_minimal_set_and_the_session_is_unchanged() {
    let mut s = session();
    apply(&mut s, rect_edits(0.0, 0.0, 30.0, 20.0));
    apply(
        &mut s,
        json!([{ "op": "addConstraint", "constraint": { "id": "w", "type": "distance", "a": "bottom.start", "b": "bottom.end", "value": 40 } }]),
    );
    let before = s.sketch().clone();
    let rev = s.snapshot().revision;
    let conflicting = edits(json!([
        { "op": "addConstraint", "constraint": { "id": "w2", "type": "distance", "a": "top.start", "b": "top.end", "value": 50 } }
    ]));
    let r = s
        .apply(&conflicting, ApplyOptions::default())
        .expect_err("conflict");
    assert_eq!(r.error.code, "SKETCH_CONSTRAINT_CONFLICT");
    let cand = r.candidate.expect("the candidate's diagnosis");
    assert_eq!(cand.conflicts.len(), 1);
    assert_eq!(cand.conflicts[0].suggested_removal, "w2");
    assert!(cand.conflicts[0].constraints.contains(&"w".to_string()));
    assert_eq!(*s.sketch(), before);
    assert_eq!(s.snapshot().revision, rev);

    // "Make driven": the same dimension as a reference measures 40.
    let snap = apply(
        &mut s,
        json!([{ "op": "addConstraint", "constraint": { "id": "w2", "type": "distance", "a": "top.start", "b": "top.end", "driving": false } }]),
    );
    let w2 = snap.constraints.iter().find(|c| c.id == "w2").unwrap();
    assert_eq!(w2.driving, Some(false));
    assert!((w2.measured.unwrap() - 40.0).abs() < 1e-9);
    assert_eq!(w2.state, Some(ConstraintState::Reference));

    // Allowing the conflict commits it; the geometry stays as it was (never solved wrong).
    let mut s2 = session();
    apply(&mut s2, rect_edits(0.0, 0.0, 30.0, 20.0));
    apply(
        &mut s2,
        json!([{ "op": "addConstraint", "constraint": { "id": "w", "type": "distance", "a": "bottom.start", "b": "bottom.end", "value": 40 } }]),
    );
    let snap = s2
        .apply(
            &conflicting,
            ApplyOptions {
                allow_conflict: true,
                ..Default::default()
            },
        )
        .expect("allowed")
        .clone();
    assert!(!snap.ok);
    assert_eq!(
        snap.error.as_ref().unwrap().code,
        "SKETCH_CONSTRAINT_CONFLICT"
    );
    assert_eq!(state(&snap, "w2"), Some(ConstraintState::Conflicting));
    assert!(
        s2.finish().error.is_some(),
        "a conflicting sketch does not finish ok"
    );
    // Removing the suggested constraint repairs it.
    let snap = apply(&mut s2, json!([{ "op": "removeConstraint", "id": "w2" }]));
    assert!(snap.ok);
}

#[test]
fn redundant_constraints_are_rejected_or_dropped() {
    let mut s = session();
    apply(&mut s, rect_edits(0.0, 0.0, 30.0, 20.0));
    let again = edits(json!([
        { "op": "addConstraint", "constraint": { "id": "par", "type": "parallel", "a": "bottom", "b": "top" } }
    ]));
    let r = s
        .apply(&again, ApplyOptions::default())
        .expect_err("redundant");
    assert_eq!(r.error.code, "SESSION_REDUNDANT");
    let snap = s
        .apply(
            &again,
            ApplyOptions {
                drop_redundant: true,
                ..Default::default()
            },
        )
        .unwrap()
        .clone();
    assert!(snap.constraints.iter().all(|c| c.id != "par"), "dropped");
    let snap = s
        .apply(
            &again,
            ApplyOptions {
                allow_redundant: true,
                ..Default::default()
            },
        )
        .unwrap()
        .clone();
    assert_eq!(snap.status, Some(SolveStatus::OverConstrainedRedundant));
    assert!(matches!(
        state(&snap, "par"),
        Some(ConstraintState::Redundant | ConstraintState::PartiallyRedundant)
    ));
}

#[test]
fn structural_errors_reject_the_whole_batch() {
    let mut s = session();
    apply(&mut s, rect_edits(0.0, 0.0, 30.0, 20.0));
    let before = s.sketch().clone();
    for (bad, code) in [
        (
            json!([{ "op": "addConstraint", "constraint": { "id": "k", "type": "horizontal", "line": "nope" } }]),
            "SKETCH_UNKNOWN_REFERENCE",
        ),
        (
            json!([{ "op": "addConstraint", "constraint": { "id": "k", "type": "distance", "a": "bottom.start", "b": "top.end", "value": -3 } }]),
            "SKETCH_INVALID_DIMENSION",
        ),
        (
            json!([{ "op": "addCurve", "curve": { "kind": "line", "id": "bottom", "start": [0, 0], "end": [1, 1] } }]),
            "DUPLICATE_ID",
        ),
        (
            json!([{ "op": "addCurve", "curve": { "kind": "line", "id": "z", "start": [5, 5], "end": [5, 5] } }]),
            "DEGENERATE_CURVE",
        ),
        (
            json!([{ "op": "addCurve", "curve": { "kind": "rect", "id": "r", "center": [0, 0], "w": 4, "h": 4 } }]),
            "SESSION_NOT_LITERAL",
        ),
        (
            json!([{ "op": "addConstraint", "constraint": { "id": "k", "type": "distance", "a": "bottom.start", "b": "top.end", "value": "nope * 2" } }]),
            "EXPR_UNKNOWN_NAME",
        ),
        (
            json!([
                { "op": "addCurve", "curve": { "kind": "point", "id": "ok_point", "at": [1, 1] } },
                { "op": "removeCurve", "id": "missing" }
            ]),
            "SESSION_UNKNOWN_ID",
        ),
    ] {
        let r = s
            .apply(&edits(bad), ApplyOptions::default())
            .expect_err(code);
        assert_eq!(r.error.code, code, "{:?}", r.error);
        assert_eq!(*s.sketch(), before, "{code}: nothing was committed");
    }
}

#[test]
fn a_coincident_between_ends_becomes_a_weld_and_is_dropped() {
    let mut s = session();
    let snap = apply(
        &mut s,
        json!([
            { "op": "addCurve", "curve": { "kind": "line", "id": "l1", "start": [0, 0], "end": [10, 0] } },
            { "op": "addCurve", "curve": { "kind": "line", "id": "l2", "start": [12, 3], "end": [20, 10] } },
            { "op": "addConstraint", "constraint": { "id": "join", "type": "coincident", "a": "l1.end", "b": "l2.start" } }
        ]),
    );
    assert!(snap.ok);
    assert!(
        snap.constraints.iter().all(|c| c.id != "join"),
        "the coincident was dropped"
    );
    assert_eq!(
        snap.welds,
        vec![vec!["l1.end".to_string(), "l2.start".to_string()]]
    );
    let (_, e1) = line(&snap, "l1");
    let (s2, _) = line(&snap, "l2");
    assert_eq!(
        e1.map(f64::to_bits),
        s2.map(f64::to_bits),
        "bit-identical ends"
    );
    assert!(snap.redundant.is_empty());
}

#[test]
fn removing_a_curve_removes_the_constraints_on_it() {
    let mut s = session();
    apply(&mut s, rect_edits(0.0, 0.0, 30.0, 20.0));
    apply(
        &mut s,
        json!([{ "op": "addConstraint", "constraint": { "id": "w", "type": "distance", "a": "bottom.start", "b": "bottom.end", "value": 40 } }]),
    );
    let snap = apply(&mut s, json!([{ "op": "removeCurve", "id": "bottom" }]));
    let ids: Vec<&str> = snap.constraints.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["h2", "v1", "v2"]);
    assert!(
        snap.profile.error.is_some(),
        "an open profile is reported, not fatal"
    );
    assert_eq!(
        snap.profile.error.as_ref().unwrap().code,
        "SKETCH_OPEN_LOOP"
    );
}

#[test]
fn dragging_follows_the_pointer_within_the_constraints() {
    let mut s = session();
    apply(&mut s, rect_edits(0.0, 0.0, 30.0, 20.0));
    apply(
        &mut s,
        json!([
            { "op": "addConstraint", "constraint": { "id": "pin", "type": "fix", "entity": "bottom.start", "x": 0, "y": 0 } }
        ]),
    );
    // The opposite corner is free in both directions: it follows exactly.
    s.drag_begin(&DragSpec {
        target: "right.end".into(),
        grab: [30.0, 20.0],
        mode: None,
    })
    .unwrap();
    let mut last = None;
    for k in 1..=10 {
        let t = k as f64 / 10.0;
        let f = s.drag_to([30.0 + 10.0 * t, 20.0 + 5.0 * t]).unwrap();
        assert!(f.converged);
        assert!(f.target_error < 1e-4, "frame {k}: {}", f.target_error);
        last = Some(f);
    }
    let f = last.unwrap();
    let bottom = f
        .curves
        .iter()
        .find_map(|c| match c {
            LiteralCurve::Line { id, start, end, .. } if id == "bottom" => Some((*start, *end)),
            _ => None,
        })
        .unwrap();
    assert!(
        (bottom.1[0] - 40.0).abs() < 1e-6,
        "the bottom edge stretched with it"
    );
    assert_eq!(bottom.0, [0.0, 0.0], "the pinned corner stayed");
    let snap = s.drag_end().unwrap().clone();
    assert!(snap.ok);
    assert!(snap.can_undo);
    let (_, e) = line(&snap, "right");
    assert!((e[0] - 40.0).abs() < 1e-6 && (e[1] - 25.0).abs() < 1e-6);
    assert!(
        s.edits()
            .iter()
            .any(|e| matches!(e, SketchEdit::ReplaceCurve { .. })),
        "a drag is logged as replaceCurve edits"
    );

    // The pinned corner cannot follow.
    s.drag_begin(&DragSpec {
        target: "bottom.start".into(),
        grab: [0.0, 0.0],
        mode: None,
    })
    .unwrap();
    let f = s.drag_to([5.0, 5.0]).unwrap();
    assert!(f.target_error > 1.0);
    s.drag_cancel();
}

#[test]
fn dragging_a_line_body_translates_it_and_move_to_matches_a_drag() {
    let mut s = session();
    apply(
        &mut s,
        json!([
            { "op": "addCurve", "curve": { "kind": "line", "id": "l", "start": [0, 0], "end": [10, 0] } },
            { "op": "addConstraint", "constraint": { "id": "len", "type": "distance", "a": "l.start", "b": "l.end", "value": 10 } },
            { "op": "addConstraint", "constraint": { "id": "h", "type": "horizontal", "line": "l" } }
        ]),
    );
    s.drag_begin(&DragSpec {
        target: "l".into(),
        grab: [5.0, 0.0],
        mode: None,
    })
    .unwrap();
    s.drag_to([7.0, 3.0]).unwrap();
    let snap = s.drag_end().unwrap().clone();
    let (a, b) = line(&snap, "l");
    assert!(
        (a[0] - 2.0).abs() < 1e-6 && (a[1] - 3.0).abs() < 1e-6,
        "{a:?}"
    );
    assert!(
        (b[0] - 12.0).abs() < 1e-6 && (b[1] - 3.0).abs() < 1e-6,
        "{b:?}"
    );

    let snap = apply(
        &mut s,
        json!([{ "op": "moveTo", "point": "l.end", "to": [20, 3] }]),
    );
    let (a, b) = line(&snap, "l");
    assert!(((b[0] - a[0]) - 10.0).abs() < 1e-9, "the length holds");
    assert!((b[0] - 20.0).abs() < 1e-6, "the end reached its target");
}

#[test]
fn a_circle_rim_drag_changes_a_free_radius_only() {
    let mut s = session();
    apply(
        &mut s,
        json!([{ "op": "addCurve", "curve": { "kind": "circle", "id": "c", "center": [0, 0], "radius": 5 } }]),
    );
    let snap = apply(
        &mut s,
        json!([{ "op": "moveTo", "point": "c", "to": [8, 0] }]),
    );
    let r = snap
        .curves
        .iter()
        .find_map(|c| match c {
            LiteralCurve::Circle { radius, .. } => Some(*radius),
            _ => None,
        })
        .unwrap();
    assert!((r - 8.0).abs() < 1e-9, "{r}");
    apply(
        &mut s,
        json!([{ "op": "addConstraint", "constraint": { "id": "d", "type": "diameter", "curve": "c", "value": 10 } }]),
    );
    s.drag_begin(&DragSpec {
        target: "c".into(),
        grab: [5.0, 0.0],
        mode: Some("rim".into()),
    })
    .unwrap();
    let f = s.drag_to([9.0, 0.0]).unwrap();
    assert!(!f.converged, "the diameter holds the rim");
    s.drag_cancel();
}

#[test]
fn dimensions_take_expressions_and_parameters_from_the_document() {
    let doc = json!({
        "schema": "aicad.ir/1",
        "params": [{ "name": "width", "unit": "mm", "value": 12 }],
        "parts": [{ "id": "p", "name": "p", "features": [] }]
    });
    let mut s = load(
        json!({ "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [] }),
        Some(doc),
    );
    apply(
        &mut s,
        json!([
            { "op": "addCurve", "curve": { "kind": "line", "id": "l", "start": [0, 0], "end": [10, 0] } },
            { "op": "addConstraint", "constraint": { "id": "len", "type": "distance", "a": "l.start", "b": "l.end", "value": "width * 2" } }
        ]),
    );
    let c = s
        .snapshot()
        .constraints
        .iter()
        .find(|c| c.id == "len")
        .unwrap()
        .clone();
    assert_eq!(c.expr.as_deref(), Some("width * 2"));
    assert_eq!(c.value, Some(24.0));
    assert!((c.measured.unwrap() - 24.0).abs() < 1e-9);
    assert_eq!(
        s.eval_expression("width + 1", forge_ir::v1::FieldType::Length)
            .unwrap(),
        13.0
    );
    let err = s
        .eval_expression("width +", forge_ir::v1::FieldType::Length)
        .unwrap_err();
    assert!(err.code.starts_with("EXPR_"), "{err:?}");

    // A parameter typed into a dimension (`depth = 7`) is defined and used.
    assert_eq!(s.define_param("depth", ParamUnit::Mm, "7").unwrap(), 7.0);
    assert_eq!(
        s.define_param("depth", ParamUnit::Mm, "8")
            .unwrap_err()
            .code,
        "DUPLICATE_NAME"
    );
    apply(
        &mut s,
        json!([{ "op": "setDimension", "id": "len", "value": "depth" }]),
    );
    let c = s
        .snapshot()
        .constraints
        .iter()
        .find(|c| c.id == "len")
        .unwrap()
        .clone();
    assert!((c.measured.unwrap() - 7.0).abs() < 1e-9);
    let fin = s.finish();
    assert_eq!(fin.params.len(), 1);
    assert_eq!(fin.params[0].name, "depth");
    assert!(fin.validation.is_empty(), "{:?}", fin.validation);
}

#[test]
fn driving_and_driven_toggle_keeps_the_measured_value() {
    let mut s = session();
    apply(
        &mut s,
        json!([
            { "op": "addCurve", "curve": { "kind": "line", "id": "l", "start": [0, 0], "end": [10, 0] } },
            { "op": "addConstraint", "constraint": { "id": "len", "type": "distance", "a": "l.start", "b": "l.end", "value": 15 } }
        ]),
    );
    let snap = apply(
        &mut s,
        json!([{ "op": "setDimension", "id": "len", "driving": false }]),
    );
    let c = snap.constraints.iter().find(|c| c.id == "len").unwrap();
    assert_eq!((c.driving, c.value), (Some(false), None));
    assert!((c.measured.unwrap() - 15.0).abs() < 1e-9);
    let snap = apply(
        &mut s,
        json!([{ "op": "setDimension", "id": "len", "driving": true }]),
    );
    let c = snap.constraints.iter().find(|c| c.id == "len").unwrap();
    assert_eq!(c.driving, Some(true));
    assert!((c.value.unwrap() - 15.0).abs() < 1e-9);
}

#[test]
fn undo_and_redo_restore_the_sketch_and_the_edit_log() {
    let mut s = session();
    apply(&mut s, rect_edits(0.0, 0.0, 30.0, 20.0));
    let one = s.sketch().clone();
    apply(
        &mut s,
        json!([{ "op": "addConstraint", "constraint": { "id": "w", "type": "distance", "a": "bottom.start", "b": "bottom.end", "value": 40 } }]),
    );
    let two = s.sketch().clone();
    assert_eq!(s.edits().len(), 9);
    assert!(s.undo());
    assert_eq!(*s.sketch(), one);
    assert_eq!(s.edits().len(), 8);
    assert!(s.snapshot().can_redo);
    assert!(s.redo());
    assert_eq!(*s.sketch(), two);
    assert_eq!(s.edits().len(), 9);
    assert!(s.undo() && s.undo());
    assert!(!s.undo(), "nothing left");
    assert!(s.sketch().curves.is_empty());
}

#[test]
fn finish_gives_a_valid_feature_that_evaluates_to_the_same_geometry() {
    let mut s = session();
    apply(&mut s, rect_edits(3.0, 4.0, 30.0, 20.0));
    apply(
        &mut s,
        json!([
            { "op": "addConstraint", "constraint": { "id": "w", "type": "distance", "a": "bottom.start", "b": "bottom.end", "value": 42.5 } },
            { "op": "addConstraint", "constraint": { "id": "h", "type": "distance", "a": "left.start", "b": "left.end", "value": 17.25 } },
            { "op": "addConstraint", "constraint": { "id": "pin", "type": "fix", "entity": "bottom.start", "x": 0, "y": 0 } },
            { "op": "addCurve", "curve": { "kind": "circle", "id": "hole", "center": [20, 8], "radius": 3 } },
            { "op": "addConstraint", "constraint": { "id": "hd", "type": "diameter", "curve": "hole", "value": 6 } }
        ]),
    );
    let fin = s.finish();
    assert!(fin.ok, "{:?} {:?}", fin.error, fin.validation);
    assert_eq!(fin.regions, 1, "a plate with a hole is one region");
    assert_eq!(fin.feature["type"], "sketch");
    assert_eq!(fin.feature["id"], "s1");
    assert!(
        fin.warnings
            .iter()
            .any(|w| w["code"] == "SKETCH_UNDER_CONSTRAINED")
    );

    // The finished feature is a fixed point of the evaluation of record.
    let f = feature_of(&fin.feature);
    let r = evaluate_sketch(&f, &ResolvedValues::new(), &Frame::world()).unwrap();
    let snap = s.snapshot();
    assert_eq!(r.trace.solved, snap.curves, "bit-identical");
    let stored: Vec<LiteralCurve> = f
        .curves
        .iter()
        .map(
            |c| match serde_json::to_value(c).and_then(serde_json::from_value) {
                Ok(lc) => lc,
                Err(e) => panic!("literal: {e}"),
            },
        )
        .collect();
    assert_eq!(stored, r.trace.solved, "the stored guess is the solution");

    // Reloading the finished feature shows the same sketch.
    let again = load(fin.feature.clone(), None);
    assert_eq!(again.snapshot().curves, snap.curves);
    assert_eq!(again.snapshot().dof, snap.dof);
}

#[test]
fn loading_a_compound_sketch_converts_it_unless_refused() {
    let rect = json!({ "id": "s", "name": "s", "plane": "XY", "curves": [
        { "kind": "rect", "id": "r", "center": [0, 0], "w": 10, "h": 5 }
    ] });
    let s = SketchSession::load(LoadRequest {
        sketch: rect.clone(),
        document: None,
        part: None,
        convert: None,
    })
    .unwrap();
    assert_eq!(s.snapshot().curves.len(), 4);
    let r = SketchSession::load(LoadRequest {
        sketch: rect,
        document: None,
        part: None,
        convert: Some(false),
    });
    assert_eq!(r.unwrap_err().code, "SESSION_NEEDS_CONVERSION");
    let r = SketchSession::load(LoadRequest {
        sketch: json!({ "type": "extrude", "id": "e" }),
        document: None,
        part: None,
        convert: None,
    });
    assert_eq!(r.unwrap_err().code, "SESSION_NOT_A_SKETCH");
}

#[test]
fn preview_solves_without_committing() {
    let mut s = session();
    apply(&mut s, rect_edits(0.0, 0.0, 30.0, 20.0));
    let before = s.sketch().clone();
    let p = s
        .preview(
            &edits(json!([
                { "op": "addConstraint", "constraint": { "id": "w", "type": "distance", "a": "bottom.start", "b": "bottom.end", "value": 50 } }
            ])),
            ApplyOptions::default(),
        )
        .unwrap();
    let (a, b) = line(&p, "bottom");
    assert!(((b[0] - a[0]).abs() - 50.0).abs() < 1e-9);
    assert_eq!(*s.sketch(), before);
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 48, ..ProptestConfig::default() })]

    /// Whatever rectangle is drawn and however it is dimensioned, the committed sketch is a
    /// fixed point of the evaluation of record and its dimensions hold.
    #[test]
    fn committed_rectangles_are_fixed_points(
        x in -100.0f64..100.0, y in -100.0f64..100.0,
        w in 1.0f64..80.0, h in 1.0f64..80.0,
        dw in 1.0f64..120.0, dh in 1.0f64..120.0,
    ) {
        let mut s = session();
        apply(&mut s, rect_edits(x, y, w, h));
        let snap = apply(&mut s, json!([
            { "op": "addConstraint", "constraint": { "id": "w", "type": "distance", "a": "bottom.start", "b": "bottom.end", "value": dw } },
            { "op": "addConstraint", "constraint": { "id": "h", "type": "distance", "a": "left.start", "b": "left.end", "value": dh } }
        ]));
        prop_assert!(snap.ok);
        let (a, b) = line(&snap, "bottom");
        prop_assert!(((b[0] - a[0]).abs() - dw).abs() < 1e-7);
        let fin = s.finish();
        prop_assert!(fin.ok, "{:?}", fin.error);
        let f = feature_of(&fin.feature);
        let r = evaluate_sketch(&f, &ResolvedValues::new(), &Frame::world()).unwrap();
        prop_assert_eq!(&r.trace.solved, &snap.curves);
    }
}
