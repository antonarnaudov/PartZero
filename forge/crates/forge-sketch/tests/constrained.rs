//! Constrained sketches (SPEC-v1 §4.3–§4.5): the IR → forge-solve mapping of every constraint
//! kind (and `ccw: false` arcs), welding, dimensions bound to values, the status mapping and
//! its structured details, the flip check, the fixed point and write-back, and the rule that a
//! failed solve never yields geometry.

mod common;

use std::collections::BTreeMap;

use common::*;
use forge_core::linalg::Frame;
use forge_ir::P2;
use forge_ir::v1::metrics::{SketchMode, SolveStatus as IrStatus};
use forge_ir::v1::{Constraint, LiteralCurve, SketchFeature};
use forge_sketch::check::check_trace;
use forge_sketch::{
    ResolvedValues, SketchError, SketchResult, constraint_values, evaluate_sketch, welded_guess,
    write_back,
};
use forge_solve::{ConstraintKind as K, Geometry};
use serde_json::{Value, json};

/// SPEC-v1 §4.6 with a reference dimension (corpus/v1/programs/constrained_plate.json).
fn spec_example() -> (SketchFeature, BTreeMap<String, f64>) {
    program_sketch("corpus/v1/programs/constrained_plate.json")
}

fn with_params(s: &SketchFeature, width: f64, depth: f64) -> Result<SketchResult, SketchError> {
    let mut p = BTreeMap::new();
    p.insert("width".to_string(), width);
    p.insert("depth".to_string(), depth);
    eval_params(s, &p)
}

/// Replay-check a result the way the oracle does (SPEC-v1 §8.1).
fn replay_ok(s: &SketchFeature, r: &SketchResult, values: &ResolvedValues) {
    let stored: Vec<LiteralCurve> = s
        .curves
        .iter()
        .map(|c| {
            serde_json::from_value(serde_json::to_value(c).expect("json")).expect("literal curve")
        })
        .collect();
    let cv = constraint_values(s, values).expect("values");
    check_trace(&stored, &s.constraints, &cv, &r.trace)
        .unwrap_or_else(|v| panic!("replay check failed: {v:?}"));
}

fn line_len(r: &SketchResult, id: &str) -> f64 {
    match r.trace.solved.iter().find(|c| c.id() == id).expect("curve") {
        LiteralCurve::Line { start, end, .. } => {
            ((end[0] - start[0]).powi(2) + (end[1] - start[1]).powi(2)).sqrt()
        }
        _ => panic!("not a line"),
    }
}

#[test]
fn spec_4_6_example_is_fully_constrained_and_a_fixed_point() {
    let (s, params) = spec_example();
    let r = eval_params(&s, &params).expect("solves");
    assert_eq!(r.mode, SketchMode::Constrained);
    assert_eq!(r.trace.status, Some(IrStatus::FullyConstrained));
    assert_eq!(r.trace.dof, Some(0));
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    // The stored geometry already satisfies every constraint: the solution is bit-identical.
    let stored: Vec<LiteralCurve> = s
        .curves
        .iter()
        .map(|c| serde_json::from_value(serde_json::to_value(c).unwrap()).unwrap())
        .collect();
    assert_eq!(r.trace.solved, stored);
    assert_eq!(write_back(&s, &r).as_ref(), Some(&s));
    // Welding joined the construction diagonal's ends with the corners (§4.6).
    let d = r.solve_report.as_ref().expect("diagnosis");
    let groups: Vec<Vec<String>> = d.welds.iter().map(|g| g.members.clone()).collect();
    assert!(groups.contains(&vec![
        "bottom.start".to_string(),
        "left.end".to_string(),
        "diag.start".to_string()
    ]));
    assert_eq!(d.solver_input.entities.len(), 4 + 5 + 1); // 4 corner points, 5 lines, o
    // One region, named by its outer curves; the construction diagonal and the point are out.
    let m = r.region_metrics();
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].outer_curves, ["bottom", "left", "right", "top"]);
    assert!((m[0].area - 4000.0).abs() <= 1e-9);
    // Dimensions: driving values and measurements; the reference one is measured only.
    let dims = &r.trace.dimensions;
    assert_eq!(dims.len(), 3);
    assert_eq!(
        (dims[0].id.as_str(), dims[0].value, dims[0].measured),
        ("w", Some(80.0), 80.0)
    );
    assert_eq!((dims[1].id.as_str(), dims[1].value), ("d", Some(50.0)));
    assert_eq!(
        (dims[2].id.as_str(), dims[2].driving, dims[2].value),
        ("ref_diag", false, None)
    );
    assert!((dims[2].measured - (80f64.hypot(50.0))).abs() <= 1e-12);
    replay_ok(&s, &r, &ResolvedValues::from_params(&s, &params));
}

#[test]
fn dimensions_bound_to_parameters_drive_the_geometry() {
    let (s, _) = spec_example();
    let r = with_params(&s, 100.0, 30.0).expect("solves");
    assert_eq!(r.trace.status, Some(IrStatus::FullyConstrained));
    assert!((line_len(&r, "bottom") - 100.0).abs() <= 1e-9);
    assert!((line_len(&r, "left") - 30.0).abs() <= 1e-9);
    assert!((r.regions[0].area - 3000.0).abs() <= 1e-6);
    // Midpoint of the welded diagonal stays pinned at the origin (to the solve tolerance).
    let o = r.point("o").unwrap();
    assert!(o[0].abs() <= 1e-10 && o[1].abs() <= 1e-10, "{o:?}");
    // Welded ends are bit-identical after the solve.
    assert_eq!(r.point("bottom.start"), r.point("diag.start"));
    assert_eq!(r.point("left.end"), r.point("bottom.start"));
    let mut p = BTreeMap::new();
    p.insert("width".to_string(), 100.0);
    p.insert("depth".to_string(), 30.0);
    replay_ok(&s, &r, &ResolvedValues::from_params(&s, &p));
    // Write-back, then evaluating again, is a fixed point; write-back is idempotent.
    let wb = write_back(&s, &r).expect("constrained");
    let r2 = with_params(&wb, 100.0, 30.0).expect("solves");
    assert_eq!(r2.trace, r.trace);
    assert_eq!(r2.solve_report.as_ref().unwrap().solver.iterations, 0);
    assert_eq!(write_back(&wb, &r2).as_ref(), Some(&wb));
    assert_eq!(r2.region_metrics(), r.region_metrics());
}

#[test]
fn a_dimension_value_at_or_below_zero_fails_the_sketch() {
    let (s, _) = spec_example();
    let e = with_params(&s, -5.0, 30.0).expect_err("negative width");
    assert_eq!(e.code(), "SKETCH_INVALID_DIMENSION");
    assert_eq!(e.path(), Some("/constraints/4/value"));
    assert_eq!(e.details()["constraint"], json!("w"));
    assert_eq!(e.details()["value"], json!(-5.0));
    assert_error_conforms(&e);
    let e = with_params(&s, 80.0, 0.0).expect_err("zero depth");
    assert_eq!(e.details()["constraint"], json!("d"));
}

fn rect(extra_curves: Value, constraints: Value) -> SketchFeature {
    let mut curves = vec![
        json!({ "kind": "line", "id": "bottom", "start": [0, 0], "end": [10, 0] }),
        json!({ "kind": "line", "id": "right", "start": [10, 0], "end": [10, 5] }),
        json!({ "kind": "line", "id": "top", "start": [10, 5], "end": [0, 5] }),
        json!({ "kind": "line", "id": "left", "start": [0, 5], "end": [0, 0] }),
    ];
    curves.extend(extra_curves.as_array().cloned().unwrap_or_default());
    sketch(json!({
        "id": "s", "name": "s", "plane": "XY", "curves": curves, "constraints": constraints
    }))
}

/// The forge-solve constraint an IR constraint was lowered to.
fn lowered(r: &SketchResult, id: &str) -> Option<K> {
    r.solve_report
        .as_ref()
        .expect("constrained")
        .solver_input
        .constraints
        .iter()
        .find(|c| c.id == id)
        .map(|c| c.kind.clone())
}

#[test]
fn every_constraint_kind_maps_to_forge_solve_with_welded_ids() {
    // Extra geometry: two points, a construction circle tangent to `bottom`, a construction arc.
    let extra = json!([
        { "kind": "point", "id": "p", "at": [5, 0] },
        { "kind": "point", "id": "q", "at": [5, 5] },
        { "kind": "circle", "id": "c", "center": [5, 1], "radius": 1, "construction": true },
        { "kind": "arc", "id": "a", "start": [22, 0], "end": [20, 2], "center": [20, 0], "ccw": true, "construction": true }
    ]);
    let s = |k: &str| -> (Value, K) {
        let s = |x: &str| x.to_string();
        match k {
            "coincident" => (
                json!({ "id": "k", "type": "coincident", "a": "p", "b": "bottom.end" }),
                K::Coincident {
                    a: s("p"),
                    b: s("bottom.end"),
                },
            ),
            "horizontal" => (
                json!({ "id": "k", "type": "horizontal", "line": "top" }),
                K::Horizontal { line: s("top") },
            ),
            "vertical" => (
                json!({ "id": "k", "type": "vertical", "line": "left" }),
                K::Vertical { line: s("left") },
            ),
            "parallel" => (
                json!({ "id": "k", "type": "parallel", "a": "bottom", "b": "top" }),
                K::Parallel {
                    a: s("bottom"),
                    b: s("top"),
                },
            ),
            "perpendicular" => (
                json!({ "id": "k", "type": "perpendicular", "a": "bottom", "b": "right" }),
                K::Perpendicular {
                    a: s("bottom"),
                    b: s("right"),
                },
            ),
            "tangent" => (
                json!({ "id": "k", "type": "tangent", "a": "bottom", "b": "c" }),
                K::Tangent {
                    a: s("bottom"),
                    b: s("c"),
                    internal: None,
                },
            ),
            "equal" => (
                json!({ "id": "k", "type": "equal", "a": "bottom", "b": "top" }),
                K::Equal {
                    a: s("bottom"),
                    b: s("top"),
                },
            ),
            // `top.start` is welded to `right.end` (the representative).
            "distance" => (
                json!({ "id": "k", "type": "distance", "a": "top.start", "b": "bottom.start", "value": 11.180339887498949 }),
                K::Distance {
                    a: s("right.end"),
                    b: s("bottom.start"),
                    value: 11.180339887498949,
                },
            ),
            "angle" => (
                json!({ "id": "k", "type": "angle", "a": "bottom", "b": "right", "value": 90 }),
                K::Angle {
                    a: s("bottom"),
                    b: s("right"),
                    value: 90.0,
                },
            ),
            "radius" => (
                json!({ "id": "k", "type": "radius", "curve": "c", "value": 1 }),
                K::Radius {
                    curve: s("c"),
                    value: 1.0,
                },
            ),
            "diameter" => (
                json!({ "id": "k", "type": "diameter", "curve": "a", "value": 4 }),
                K::Diameter {
                    curve: s("a"),
                    value: 4.0,
                },
            ),
            "point_on_line" => (
                json!({ "id": "k", "type": "point_on_line", "point": "p", "line": "bottom" }),
                K::PointOnLine {
                    point: s("p"),
                    line: s("bottom"),
                },
            ),
            "point_on_circle" => (
                json!({ "id": "k", "type": "point_on_circle", "point": "q", "curve": "c" }),
                K::PointOnCircle {
                    point: s("q"),
                    curve: s("c"),
                },
            ),
            "midpoint" => (
                json!({ "id": "k", "type": "midpoint", "point": "p", "line": "bottom" }),
                K::Midpoint {
                    point: s("p"),
                    line: s("bottom"),
                },
            ),
            "symmetric" => (
                json!({ "id": "k", "type": "symmetric", "a": "bottom.start", "b": "right.start", "line": "q_line" }),
                K::Symmetric {
                    a: s("bottom.start"),
                    b: s("bottom.end"),
                    line: s("q_line"),
                },
            ),
            // `left.end` is welded to `bottom.start`.
            "fix" => (
                json!({ "id": "k", "type": "fix", "entity": "left.end", "x": 0 }),
                K::Fix {
                    entity: s("bottom.start"),
                    x: Some(0.0),
                    y: None,
                },
            ),
            other => panic!("{other}"),
        }
    };
    let mut kinds = 0;
    for kind in forge_ir::v1::CONSTRAINT_TYPES {
        let (con, expected) = s(kind);
        let mut extra = extra.clone();
        if kind == "symmetric" {
            extra
                .as_array_mut()
                .unwrap()
                .push(json!({ "kind": "line", "id": "q_line", "start": [5, -3], "end": [5, 8], "construction": true }));
        }
        let sk = rect(extra, json!([con]));
        // The IR constraint deserializes as forge-solve's model (SPEC-v1 [W0-9]).
        let ir: Constraint = serde_json::from_value(con.clone()).expect("IR constraint");
        assert_eq!(ir.type_name(), kind);
        let r = eval(&sk).unwrap_or_else(|e| panic!("{kind}: {e}"));
        assert_eq!(lowered(&r, "k"), Some(expected), "{kind}");
        // Every lowered solution passes the independent replay check.
        replay_ok(&sk, &r, &ResolvedValues::new());
        assert_warnings_conform(&r);
        kinds += 1;
    }
    assert_eq!(kinds, 16);
}

/// A clockwise arc `a2` from (20, 2) to (22, 0) around (20, 0): the same quarter circle as the
/// counter-clockwise arc from (22, 0) to (20, 2).
fn cw_arc_sketch(constraints: Value, extra: Value) -> SketchFeature {
    let mut curves = vec![
        json!({ "kind": "arc", "id": "a2", "start": [20, 2], "end": [22, 0], "center": [20, 0], "ccw": false, "construction": true }),
    ];
    curves.extend(extra.as_array().cloned().unwrap_or_default());
    sketch(
        json!({ "id": "s", "name": "s", "plane": "XY", "curves": curves, "constraints": constraints }),
    )
}

fn ccw_sweep(r: &SketchResult, id: &str) -> f64 {
    match r.trace.solved.iter().find(|c| c.id() == id).expect("arc") {
        LiteralCurve::Arc {
            start,
            end,
            center,
            ccw,
            ..
        } => {
            let a0 = (start[1] - center[1]).atan2(start[0] - center[0]);
            let a1 = (end[1] - center[1]).atan2(end[0] - center[0]);
            let tau = std::f64::consts::TAU;
            let s = if *ccw { a1 - a0 } else { a0 - a1 };
            s.rem_euclid(tau)
        }
        _ => panic!("arc"),
    }
}

#[test]
fn clockwise_arcs_map_through_the_ccw_rule() {
    // The solver arc runs counter-clockwise from the IR end to the IR start.
    let r = eval(&cw_arc_sketch(
        json!([{ "id": "k", "type": "radius", "curve": "a2", "value": 2 }]),
        json!([]),
    ))
    .expect("ok");
    let input = &r.solve_report.as_ref().unwrap().solver_input;
    let arc = input.entities.iter().find(|e| e.id == "a2").expect("arc");
    assert_eq!(
        arc.geometry,
        Geometry::Arc {
            center: "a2.center".into(),
            start: "a2.end".into(),
            end: "a2.start".into()
        }
    );
    // radius on a cw arc: solved to a new value, still the quarter arc, still `ccw: false`.
    let s = cw_arc_sketch(
        json!([
            { "id": "pin", "type": "fix", "entity": "a2.center" },
            { "id": "k", "type": "radius", "curve": "a2", "value": 3 }
        ]),
        json!([]),
    );
    let r = eval(&s).expect("ok");
    replay_ok(&s, &r, &ResolvedValues::new());
    let LiteralCurve::Arc {
        ccw, start, center, ..
    } = &r.trace.solved[0]
    else {
        panic!("arc")
    };
    assert!(!ccw);
    assert!((((start[0] - center[0]).hypot(start[1] - center[1])) - 3.0).abs() <= 1e-9);
    let sweep = ccw_sweep(&r, "a2");
    assert!(
        sweep < std::f64::consts::PI,
        "quarter arc kept, sweep {sweep}"
    );
    // tangent: a line tangent to the cw arc's circle.
    let s = cw_arc_sketch(
        json!([
            { "id": "pin", "type": "fix", "entity": "a2.center" },
            { "id": "k", "type": "tangent", "a": "t", "b": "a2" }
        ]),
        json!([{ "kind": "line", "id": "t", "start": [15, 2.5], "end": [25, 2.5], "construction": true }]),
    );
    let r = eval(&s).expect("ok");
    replay_ok(&s, &r, &ResolvedValues::new());
    assert!(!matches!(
        r.trace.solved[0],
        LiteralCurve::Arc { ccw: true, .. }
    ));
    // point_on_circle: a point pulled onto the cw arc's circle.
    let s = cw_arc_sketch(
        json!([
            { "id": "pin", "type": "fix", "entity": "a2.center" },
            { "id": "r", "type": "radius", "curve": "a2", "value": 2 },
            { "id": "k", "type": "point_on_circle", "point": "p", "curve": "a2" }
        ]),
        json!([{ "kind": "point", "id": "p", "at": [17.5, 0.2] }]),
    );
    let r = eval(&s).expect("ok");
    replay_ok(&s, &r, &ResolvedValues::new());
    let p = r.point("p").expect("p");
    assert!(((p[0] - 20.0).hypot(p[1]) - 2.0).abs() <= 1e-9);
    assert!(ccw_sweep(&r, "a2") < std::f64::consts::PI);
}

#[test]
fn an_explicit_coincident_between_welded_ends_is_redundant_not_a_self_reference() {
    let s = rect(
        json!([]),
        json!([
            { "id": "h", "type": "horizontal", "line": "bottom" },
            { "id": "c1", "type": "coincident", "a": "bottom.end", "b": "right.start" }
        ]),
    );
    let r = eval(&s).expect("ok");
    assert_eq!(r.trace.status, Some(IrStatus::OverConstrainedRedundant));
    assert_eq!(lowered(&r, "c1"), None, "left out of the solver input");
    let w = &r.warnings[0];
    assert_eq!(w.code, "SKETCH_REDUNDANT_CONSTRAINTS");
    assert_eq!(
        w.details["redundant"],
        json!([{ "constraint": "c1", "implied_by": [] }])
    );
    assert_warnings_conform(&r);
    let d = r.solve_report.as_ref().unwrap();
    assert!(!d.redundant[0].partial);
    // The DOF is the welded sketch's: 4 corners − 1 horizontal.
    assert_eq!(r.trace.dof, Some(7));
}

#[test]
fn a_driving_distance_between_welded_ends_is_a_conflict_and_yields_no_geometry() {
    let s = rect(
        json!([]),
        json!([
            { "id": "h", "type": "horizontal", "line": "bottom" },
            { "id": "d0", "type": "distance", "a": "bottom.end", "b": "right.start", "value": 2 }
        ]),
    );
    let e = eval(&s).expect_err("conflict");
    assert_eq!(e.code(), "SKETCH_CONSTRAINT_CONFLICT");
    assert_eq!(
        e.details()["conflicts"],
        json!([{ "constraints": ["d0"], "suggested_removal": "d0", "verified_minimal": true }])
    );
    assert_error_conforms(&e);
    let d = e.diagnosis().expect("diagnosis");
    assert_eq!(d.status, forge_solve::SolveStatus::Conflict);
    // A reference distance between welded ends just measures 0.
    let s = rect(
        json!([]),
        json!([
            { "id": "h", "type": "horizontal", "line": "bottom" },
            { "id": "d0", "type": "distance", "a": "bottom.end", "b": "right.start", "driving": false }
        ]),
    );
    let r = eval(&s).expect("ok");
    assert_eq!(r.trace.dimensions[0].measured.to_bits(), 0.0f64.to_bits());
    assert_eq!(r.trace.dimensions[0].value, None);
    assert_eq!(r.trace.status, Some(IrStatus::UnderConstrained));
}

#[test]
fn decided_conflict_sets_are_capped_at_the_pinned_max_conflicts() {
    // A closed 12-gon: every joint welds; a driving distance across each of its 12 joints is
    // a decided conflict set of its own. The merged list keeps the pinned bound of SPEC-v1
    // §4.4 rule 3 (at most 8 sets), in constraint order.
    let n = 12;
    let pt = |k: usize| {
        let t = std::f64::consts::TAU * (k % n) as f64 / n as f64;
        json!([10.0 * t.cos(), 10.0 * t.sin()])
    };
    let curves: Vec<Value> = (0..n)
        .map(|k| json!({ "kind": "line", "id": format!("l{k}"), "start": pt(k), "end": pt(k + 1) }))
        .collect();
    let constraints: Vec<Value> = (0..n)
        .map(|k| {
            json!({
                "id": format!("d{k}"), "type": "distance",
                "a": format!("l{k}.end"), "b": format!("l{}.start", (k + 1) % n), "value": 1
            })
        })
        .collect();
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY", "curves": curves, "constraints": constraints
    }));
    let e = eval(&s).expect_err("conflict");
    assert_eq!(e.code(), "SKETCH_CONSTRAINT_CONFLICT");
    let max = forge_sketch::solve_options_v1().max_conflicts;
    assert_eq!(max, 8);
    let sets = e.details()["conflicts"].as_array().unwrap().clone();
    assert_eq!(sets.len(), max, "capped");
    for (k, set) in sets.iter().enumerate() {
        assert_eq!(
            set["constraints"],
            json!([format!("d{k}")]),
            "constraint order"
        );
    }
    assert_eq!(e.diagnosis().unwrap().conflicts.len(), max);
    assert_error_conforms(&e);
}

#[test]
fn a_symmetric_pair_of_welded_ends_lowers_to_point_on_line_and_is_partially_redundant() {
    let s = rect(
        json!([{ "kind": "line", "id": "m", "start": [10, -3], "end": [10, 8], "construction": true }]),
        json!([{ "id": "sy", "type": "symmetric", "a": "bottom.end", "b": "right.start", "line": "m" }]),
    );
    let r = eval(&s).expect("ok");
    assert_eq!(
        lowered(&r, "sy"),
        Some(K::PointOnLine {
            point: "bottom.end".into(),
            line: "m".into()
        })
    );
    let d = r.solve_report.as_ref().unwrap();
    let red = d
        .redundant
        .iter()
        .find(|x| x.constraint == "sy")
        .expect("sy");
    assert!(red.partial);
    assert!(red.implied_by.is_empty());
    assert_eq!(r.trace.status, Some(IrStatus::OverConstrainedRedundant));
    replay_ok(&s, &r, &ResolvedValues::new());
}

#[test]
fn an_under_constrained_sketch_reports_its_dof_per_entity() {
    let s = rect(
        json!([]),
        json!([
            { "id": "h1", "type": "horizontal", "line": "bottom" },
            { "id": "h2", "type": "horizontal", "line": "top" },
            { "id": "v1", "type": "vertical", "line": "left" },
            { "id": "v2", "type": "vertical", "line": "right" }
        ]),
    );
    let r = eval(&s).expect("ok");
    assert_eq!(r.trace.status, Some(IrStatus::UnderConstrained));
    assert_eq!(r.trace.dof, Some(4));
    let w = &r.warnings[0];
    assert_eq!(w.code, "SKETCH_UNDER_CONSTRAINED");
    assert_eq!(w.severity, forge_ir::v1::metrics::Severity::Info);
    assert_eq!(w.details["dof"], json!(4));
    let ents = w.details["entities"].as_array().expect("entities");
    assert!(ents.iter().all(|e| e["dof"].as_u64().unwrap() > 0));
    assert!(ents.iter().any(|e| e["id"] == json!("bottom.start")));
    // Aliases are not solver entities: they are reported through their representative.
    assert!(!ents.iter().any(|e| e["id"] == json!("left.end")));
    assert_warnings_conform(&r);
}

#[test]
fn a_conflict_fails_with_minimal_sets_and_a_suggested_removal() {
    let s = rect(
        json!([]),
        json!([
            { "id": "h1", "type": "horizontal", "line": "bottom" },
            { "id": "h2", "type": "horizontal", "line": "top" },
            { "id": "v1", "type": "vertical", "line": "left" },
            { "id": "v2", "type": "vertical", "line": "right" },
            { "id": "w", "type": "distance", "a": "bottom.start", "b": "bottom.end", "value": 10 },
            { "id": "w2", "type": "distance", "a": "top.start", "b": "top.end", "value": 12 }
        ]),
    );
    let e = eval(&s).expect_err("conflict");
    assert!(matches!(e, SketchError::Conflict { .. }));
    let c = &e.details()["conflicts"][0];
    assert_eq!(c["suggested_removal"], json!("w2"));
    let set: Vec<&str> = c["constraints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap())
        .collect();
    assert!(set.contains(&"w") && set.contains(&"w2"), "{set:?}");
    // The sets are forge-solve's on the lowered input.
    let d = e.diagnosis().unwrap();
    let direct =
        forge_solve::solve(&d.solver_input, &forge_solve::SolveOptions::default()).unwrap();
    assert_eq!(direct.conflicts[0].constraints, d.conflicts[0].constraints);
    assert_error_conforms(&e);
}

#[test]
fn a_solve_that_does_not_converge_fails_with_its_clusters() {
    // forge-solve's pinned near-degenerate polygon (tests/properties.rs), lifted to IR.
    let g = forge_solve_family_polygon_conflict(1_455_554_950_525_772_012);
    let lifted = forge_sketch::lift::lift("s", &g, false).expect("lift");
    assert!(lifted.exact);
    let direct = forge_solve::solve(&g, &forge_solve::SolveOptions::default()).unwrap();
    assert_eq!(direct.status, forge_solve::SolveStatus::FailedToConverge);
    let e = eval(&lifted.sketch).expect_err("no stale geometry");
    assert_eq!(e.code(), "SKETCH_SOLVE_FAILED", "{e}");
    let d = e.details();
    assert!(d["max_residual"].as_f64().unwrap() > 1e-10);
    let clusters = d["clusters"].as_array().unwrap();
    assert!(!clusters.is_empty());
    assert!(clusters[0]["constraints"].as_array().unwrap().len() > 1);
    assert_error_conforms(&e);

    // A residual that cannot be measured (infinite or NaN) is reported as a number
    // (`UNMEASURABLE_RESIDUAL`), never as JSON `null`.
    let SketchError::SolveFailed {
        clusters,
        diagnosis,
        ..
    } = e
    else {
        panic!("solve failed")
    };
    for bad in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
        let e = SketchError::SolveFailed {
            reason: forge_sketch::SolveFailure::NotConverged,
            max_residual: bad,
            clusters: clusters.clone(),
            verification: Some("x".into()),
            diagnosis: diagnosis.clone(),
        };
        let report = serde_json::to_value(e.to_report_error()).expect("serializes");
        assert_eq!(
            report["details"]["max_residual"].as_f64(),
            Some(forge_sketch::UNMEASURABLE_RESIDUAL),
            "{bad}: {report}"
        );
        assert_error_conforms(&e);
    }
}

/// `generate::polygon(seed, true)` (pick 6 of forge-solve's property families).
fn forge_solve_family_polygon_conflict(seed: u64) -> forge_solve::Sketch {
    forge_solve::generate::polygon(seed, true).sketch
}

#[test]
fn a_jump_to_the_mirrored_configuration_is_flagged() {
    // A triangle stored clockwise; the fix pulls its apex across the base.
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "line", "id": "t1", "start": [0, 0], "end": [10, 0] },
            { "kind": "line", "id": "t2", "start": [10, 0], "end": [5, -2] },
            { "kind": "line", "id": "t3", "start": [5, -2], "end": [0, 0] }
        ],
        "constraints": [
            { "id": "f1", "type": "fix", "entity": "t1.start" },
            { "id": "f2", "type": "fix", "entity": "t1.end" },
            { "id": "f3", "type": "fix", "entity": "t2.end", "x": 5, "y": 5 }
        ]
    }));
    let r = eval(&s).expect("ok");
    assert_eq!(r.trace.status, Some(IrStatus::FullyConstrained));
    let w: Vec<&str> = r.warnings.iter().map(|w| w.code.as_str()).collect();
    assert_eq!(w, ["SKETCH_LOOP_FLIPPED"]);
    assert_eq!(r.warnings[0].details["curves"], json!(["t1", "t2", "t3"]));
    assert_warnings_conform(&r);
    // Not flipped when the apex stays on its side.
    let mut s2 = s.clone();
    if let Constraint::Fix { y, .. } = &mut s2.constraints[2] {
        *y = Some(forge_ir::v1::Scalar::Num(-5.0));
    }
    let r = eval(&s2).expect("ok");
    assert!(r.warnings.is_empty());
}

/// The review's sketches, translated by `off`: a triangle whose stored guess leaves the loop
/// open (t3 ends away from t1.start; a `coincident` closes it), with `fix` constraints.
fn open_guess_triangle(off: P2, mirror_jump: bool) -> SketchFeature {
    let p = |x: f64, y: f64| json!([x + off[0], y + off[1]]);
    if mirror_jump {
        // Stored clockwise (apex below the base), a 1 mm gap; the fix pulls the apex across.
        sketch(json!({
            "id": "s", "name": "s", "plane": "XY",
            "curves": [
                { "kind": "line", "id": "t1", "start": p(0.0, 0.0), "end": p(10.0, 0.0) },
                { "kind": "line", "id": "t2", "start": p(10.0, 0.0), "end": p(5.0, -2.0) },
                { "kind": "line", "id": "t3", "start": p(5.0, -2.0), "end": p(0.0, -1.0) }
            ],
            "constraints": [
                { "id": "c", "type": "coincident", "a": "t3.end", "b": "t1.start" },
                { "id": "f1", "type": "fix", "entity": "t1.start" },
                { "id": "f2", "type": "fix", "entity": "t1.end" },
                { "id": "f3", "type": "fix", "entity": "t2.end", "x": 5.0 + off[0], "y": 5.0 + off[1] }
            ]
        }))
    } else {
        // Stored counter-clockwise, t3 overshooting to (0, −1); no jump.
        sketch(json!({
            "id": "s", "name": "s", "plane": "XY",
            "curves": [
                { "kind": "line", "id": "l1", "start": p(0.0, 0.0), "end": p(10.0, 0.0) },
                { "kind": "line", "id": "l2", "start": p(10.0, 0.0), "end": p(0.0, 10.0) },
                { "kind": "line", "id": "l3", "start": p(0.0, 10.0), "end": p(0.0, -1.0) }
            ],
            "constraints": [
                { "id": "c", "type": "coincident", "a": "l3.end", "b": "l1.start" }
            ]
        }))
    }
}

const REVIEW_OFFSETS: [P2; 7] = [
    [0.0, 0.0],
    [-1000.0, 0.0],
    [1000.0, 0.0],
    [0.0, 1000.0],
    [1000.0, 1000.0],
    [-1000.0, -1000.0],
    [2.5e5, -7.5e4],
];

#[test]
fn the_flip_check_flags_a_mirror_jump_of_an_open_guess_at_every_position() {
    // Regression (review): unflagged at offset (−1000, 0) — a silently mirrored solution —
    // because the stored area of the open chain depended on the sketch's position.
    for off in REVIEW_OFFSETS {
        let r = eval(&open_guess_triangle(off, true)).expect("ok");
        assert_eq!(r.trace.status, Some(IrStatus::FullyConstrained), "{off:?}");
        let w: Vec<&str> = r.warnings.iter().map(|w| w.code.as_str()).collect();
        assert_eq!(w, ["SKETCH_LOOP_FLIPPED"], "offset {off:?}");
        assert_eq!(r.warnings[0].details["curves"], json!(["t1", "t2", "t3"]));
        assert!((r.regions[0].area - 25.0).abs() <= 1e-9, "{off:?}");
        assert_warnings_conform(&r);
    }
}

#[test]
fn the_same_sketch_at_any_position_gets_the_same_warnings() {
    // Regression (review): a spurious SKETCH_LOOP_FLIPPED at offsets (1000, 1000) and
    // (1000, 0) for a solve that does not flip. The solution is the same up to the
    // translation, so the warnings must be identical.
    for mirror_jump in [false, true] {
        let base = eval(&open_guess_triangle([0.0, 0.0], mirror_jump)).expect("ok");
        for off in REVIEW_OFFSETS {
            let r = eval(&open_guess_triangle(off, mirror_jump)).expect("ok");
            assert_eq!(r.warnings, base.warnings, "offset {off:?}");
            assert_eq!(r.trace.status, base.trace.status);
            assert!(
                (r.regions[0].area - base.regions[0].area).abs() <= 1e-6,
                "{off:?}: {} vs {}",
                r.regions[0].area,
                base.regions[0].area
            );
        }
        if !mirror_jump {
            let codes: Vec<&str> = base.warnings.iter().map(|w| w.code.as_str()).collect();
            assert_eq!(codes, ["SKETCH_UNDER_CONSTRAINED"]);
        }
    }
}

#[test]
fn a_solution_that_collapses_a_curve_is_degenerate() {
    let s = rect(
        json!([{ "kind": "line", "id": "z", "start": [0, 10], "end": [3, 10], "construction": true }]),
        json!([{ "id": "k", "type": "coincident", "a": "z.start", "b": "z.end" }]),
    );
    let e = eval(&s).expect_err("collapsed");
    assert_eq!(e.code(), "DEGENERATE_CURVE");
    assert_eq!(e.details()["curve"], json!("z"));
    assert_eq!(e.path(), Some("/curves/4"));
}

#[test]
fn ends_welded_through_a_chain_collapse_a_curve() {
    // x.start ~ y.start ~ x.end (each pair within tol, the ends of x 1.8e-6 apart).
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "line", "id": "x", "start": [0, 0], "end": [1.8e-6, 0] },
            { "kind": "line", "id": "y", "start": [0.9e-6, 0], "end": [5, 5] }
        ],
        "constraints": [{ "id": "h", "type": "horizontal", "line": "y" }]
    }));
    let e = eval(&s).expect_err("weld chain");
    assert_eq!(e.code(), "DEGENERATE_CURVE");
    assert_eq!(e.details()["reason"], json!("its ends weld into one point"));
}

#[test]
fn expressions_or_compounds_in_a_constrained_sketch_are_mixed_mode() {
    let s = rect(
        json!([{ "kind": "point", "id": "p", "at": ["x", 0] }]),
        json!([{ "id": "h", "type": "horizontal", "line": "bottom" }]),
    );
    let e = evaluate_sketch(
        &s,
        &ResolvedValues::new().with("/curves/4/at/0", 1.0),
        &Frame::world(),
    )
    .expect_err("mixed");
    assert_eq!(e.code(), "SKETCH_MIXED_MODE");
    assert_eq!(e.path(), Some("/curves/4/at/0"));
    assert_error_conforms(&e);
    let s = rect(
        json!([{ "kind": "rect", "id": "r", "center": [0, 0], "w": 1, "h": 1 }]),
        json!([{ "id": "h", "type": "horizontal", "line": "bottom" }]),
    );
    assert_eq!(eval(&s).expect_err("mixed").code(), "SKETCH_MIXED_MODE");
}

#[test]
fn fix_targets_and_angles_accept_expressions() {
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "line", "id": "a", "start": [0, 0], "end": [10, 0], "construction": true },
            { "kind": "line", "id": "b", "start": [10, 0], "end": [10, 10], "construction": true }
        ],
        "constraints": [
            { "id": "f", "type": "fix", "entity": "a.start", "x": "ox", "y": "oy" },
            { "id": "h", "type": "horizontal", "line": "a" },
            { "id": "la", "type": "distance", "a": "a.start", "b": "a.end", "value": 10 },
            { "id": "lb", "type": "distance", "a": "b.start", "b": "b.end", "value": 10 },
            { "id": "an", "type": "angle", "a": "a", "b": "b", "value": "tilt" }
        ]
    }));
    let v = ResolvedValues::new()
        .with("/constraints/0/x", 1.0)
        .with("/constraints/0/y", 2.0)
        .with("/constraints/4/value", 60.0);
    let r = evaluate_sketch(&s, &v, &Frame::world()).expect("ok");
    assert_eq!(r.trace.status, Some(IrStatus::FullyConstrained));
    let a0 = r.point("a.start").unwrap();
    assert!((a0[0] - 1.0).abs() <= 1e-10 && (a0[1] - 2.0).abs() <= 1e-10);
    let b_end = r.point("b.end").unwrap();
    assert!(
        (b_end[0] - (11.0 + 5.0)).abs() <= 1e-9 && (b_end[1] - (2.0 + 75f64.sqrt())).abs() <= 1e-9
    );
    assert_eq!(r.trace.dimensions[2].value, Some(60.0));
    assert!((r.trace.dimensions[2].measured - 60.0).abs() <= 1e-9);
    replay_ok(&s, &r, &v);
    // Construction geometry only: no regions, still a valid evaluation.
    assert!(r.regions.is_empty());
}

#[test]
fn the_replay_check_catches_tampered_traces() {
    let (s, _) = spec_example();
    let r = with_params(&s, 90.0, 40.0).expect("ok");
    let v = ResolvedValues::from_params(&s, &params_map(90.0, 40.0));
    replay_ok(&s, &r, &v);
    let stored: Vec<LiteralCurve> = s
        .curves
        .iter()
        .map(|c| serde_json::from_value(serde_json::to_value(c).unwrap()).unwrap())
        .collect();
    let cv = constraint_values(&s, &v).unwrap();
    // A solved point moved by 1e-6 (SPEC-v1 §8.1 mutation test).
    let mut t = r.trace.clone();
    if let LiteralCurve::Line { end, .. } = &mut t.solved[0] {
        end[0] += 1e-6;
    }
    let bad = check_trace(&stored, &s.constraints, &cv, &t).expect_err("tampered");
    assert!(
        bad.what.starts_with("weld") || bad.amount >= 1e-7,
        "{bad:?}"
    );
    // A dimension value that is not the evaluated one.
    let mut t = r.trace.clone();
    t.dimensions[0].value = Some(90.000001);
    assert!(check_trace(&stored, &s.constraints, &cv, &t).is_err());
    // A measured value that does not match the geometry.
    let mut t = r.trace.clone();
    t.dimensions[2].measured += 1e-6;
    assert!(check_trace(&stored, &s.constraints, &cv, &t).is_err());
}

fn params_map(w: f64, d: f64) -> BTreeMap<String, f64> {
    let mut p = BTreeMap::new();
    p.insert("width".to_string(), w);
    p.insert("depth".to_string(), d);
    p
}

#[test]
fn evaluation_is_deterministic() {
    let (s, _) = spec_example();
    let a = with_params(&s, 77.5, 33.25).expect("ok");
    let b = with_params(&s, 77.5, 33.25).expect("ok");
    assert_eq!(a, b);
    assert_eq!(
        serde_json::to_string(&a.trace).unwrap(),
        serde_json::to_string(&b.trace).unwrap()
    );
}

#[test]
fn the_pinned_v1_solve_options_are_the_spec_values_and_forge_solves_defaults() {
    // SPEC-v1 §4.4 rule 3: v1 solves with forge-solve 0.0.1's defaults. The crate spells them
    // out; if forge-solve's defaults ever change, this fails (v1 results must not change).
    let o = forge_sketch::solve_options_v1();
    assert_eq!(o, forge_solve::SolveOptions::default());
    assert_eq!(
        o.tolerance.to_bits(),
        forge_ir::v1::SOLVE_TOLERANCE.to_bits()
    );
    let bits = |x: f64| x.to_bits();
    assert_eq!(bits(o.tolerance), bits(1e-10));
    assert_eq!(o.max_iterations, 200);
    assert_eq!(bits(o.rank_tolerance), bits(1e-8));
    assert_eq!(bits(o.conflict_rank_tolerance), bits(1e-6));
    assert_eq!(bits(o.dof_tolerance), bits(1e-7));
    assert_eq!(o.max_conflicts, 8);
    assert_eq!(o.rank_method, forge_solve::RankMethod::Qrcp);
}

/// Two construction lines `a` (horizontal, fixed start) and `b` (fixed start), stored with
/// length `l0` and an angular error of `eps`, whose lengths two driving distances set to
/// `l0 · ratio`, related by `relation`.
fn grown_pair(relation: &str, l0: f64, ratio: f64, eps: f64) -> SketchFeature {
    let (b_end, extra) = match relation {
        "parallel" => (json!([l0, 1.0 + eps]), json!({})),
        "perpendicular" => (json!([eps, 1.0 + l0]), json!({})),
        _ => {
            let h = l0 / 2f64.sqrt();
            (json!([h, 1.0 + h + eps]), json!({ "value": 45 }))
        }
    };
    let mut rel = json!({ "id": "rel", "type": relation, "a": "a", "b": "b" });
    if let Some(v) = extra.get("value") {
        rel["value"] = v.clone();
    }
    let big = l0 * ratio;
    sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "line", "id": "a", "start": [0, 0], "end": [l0, 0], "construction": true },
            { "kind": "line", "id": "b", "start": [0, 1], "end": b_end, "construction": true }
        ],
        "constraints": [
            { "id": "h", "type": "horizontal", "line": "a" },
            rel,
            { "id": "fa", "type": "fix", "entity": "a.start" },
            { "id": "fb", "type": "fix", "entity": "b.start" },
            { "id": "da", "type": "distance", "a": "a.start", "b": "a.end", "value": big },
            { "id": "db", "type": "distance", "a": "b.start", "b": "b.end", "value": big }
        ]
    }))
}

#[test]
fn a_dimension_that_grows_angular_constrained_lines_far_from_the_guess_still_verifies() {
    // Regression: the independent check scaled angular residuals by the *solved* lengths while
    // forge-solve's pinned convergence test scales them by the guess's, so a valid solve that
    // grew the lines by > ~10× failed with SKETCH_SOLVE_FAILED (e.g. parallel, l0 = 1 →
    // 1000, eps = 1e-3: "violated by 9.43e-8 mm").
    let mut n = 0;
    for relation in ["parallel", "perpendicular", "angle"] {
        for (l0, ratio) in [(1.0, 1000.0), (0.1, 1000.0), (1.0, 20.0), (10.0, 100.0)] {
            for eps in [1e-4, 1e-3] {
                let s = grown_pair(relation, l0, ratio, eps);
                let r = eval(&s).unwrap_or_else(|e| {
                    panic!("{relation} l0={l0} ×{ratio} eps={eps}: {} {e}", e.code())
                });
                replay_ok(&s, &r, &ResolvedValues::new());
                for id in ["a", "b"] {
                    let len = line_len(&r, id);
                    assert!(
                        (len - l0 * ratio).abs() <= 1e-9 * len,
                        "{relation}: {id} {len}"
                    );
                }
                n += 1;
            }
        }
    }
    assert_eq!(n, 24);
}

#[test]
fn a_skewed_rectangle_driven_to_many_times_its_size_solves_and_verifies() {
    // The realistic case: a hand-drawn near-rectangle (skew eps) driven to 20–50× its size.
    for l0 in [10.0, 50.0] {
        for ratio in [20.0, 50.0] {
            for eps in [1.4e-4, 4e-4, 1.1e-3] {
                let s = sketch(json!({
                    "id": "s", "name": "s", "plane": "XY",
                    "curves": [
                        { "kind": "line", "id": "bottom", "start": [0, 0], "end": [l0, 0] },
                        { "kind": "line", "id": "right", "start": [l0, 0], "end": [l0 + eps, l0] },
                        { "kind": "line", "id": "top", "start": [l0 + eps, l0], "end": [eps, l0] },
                        { "kind": "line", "id": "left", "start": [eps, l0], "end": [0, 0] }
                    ],
                    "constraints": [
                        { "id": "h", "type": "horizontal", "line": "bottom" },
                        { "id": "p1", "type": "parallel", "a": "top", "b": "bottom" },
                        { "id": "p2", "type": "parallel", "a": "left", "b": "right" },
                        { "id": "q", "type": "perpendicular", "a": "bottom", "b": "left" },
                        { "id": "f", "type": "fix", "entity": "bottom.start" },
                        { "id": "w", "type": "distance", "a": "bottom.start", "b": "bottom.end", "value": l0 * ratio },
                        { "id": "d", "type": "distance", "a": "left.start", "b": "left.end", "value": l0 * ratio }
                    ]
                }));
                let r = eval(&s)
                    .unwrap_or_else(|e| panic!("l0={l0} ×{ratio} eps={eps}: {} {e}", e.code()));
                assert_eq!(r.trace.status, Some(IrStatus::FullyConstrained));
                replay_ok(&s, &r, &ResolvedValues::new());
                let side = l0 * ratio;
                assert!((r.regions[0].area - side * side).abs() <= 1e-9 * side * side);
            }
        }
    }
}

/// Two construction arcs meeting at (10, 0): `a1` (centre (0, 0), clockwise from (0, 10)) and
/// `a2` (centre (15, 0), counter-clockwise to (15, −5)) — tangent there, externally.
fn arcs_at_a_joint(internal: Option<bool>) -> SketchFeature {
    let mut t = json!({ "id": "t", "type": "tangent", "a": "a1", "b": "a2" });
    if let Some(i) = internal {
        t["internal"] = json!(i);
    }
    sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "arc", "id": "a1", "start": [0, 10], "end": [10, 0], "center": [0, 0], "ccw": false, "construction": true },
            { "kind": "arc", "id": "a2", "start": [10, 0], "end": [15, -5], "center": [15, 0], "ccw": true, "construction": true }
        ],
        "constraints": [t]
    }))
}

#[test]
fn internal_on_a_tangency_at_a_joint_that_the_geometry_contradicts_fails_with_an_explanation() {
    // forge-solve's tangency at a joint (shared or coincident end) constrains the tangent
    // directions only and ignores `internal`: the solve keeps the stored (external)
    // configuration, and the independent check rejects it with a specific explanation and
    // the solver cluster of the constraint (SPEC-v1 §4.3 vs forge-solve: contract issue).
    for ok in [None, Some(false)] {
        let s = arcs_at_a_joint(ok);
        let r = eval(&s).unwrap_or_else(|e| panic!("{ok:?}: {e}"));
        replay_ok(&s, &r, &ResolvedValues::new());
    }
    let e = eval(&arcs_at_a_joint(Some(true))).expect_err("internal requested");
    assert_eq!(e.code(), "SKETCH_SOLVE_FAILED");
    let msg = e.to_string();
    assert!(
        msg.contains("asks for internal tangency") && msg.contains("ignores `internal`"),
        "{msg}"
    );
    let d = e.details();
    let clusters = d["clusters"].as_array().expect("clusters");
    assert!(!clusters.is_empty(), "structured pointer to the failure");
    assert!(
        clusters
            .iter()
            .any(|c| c["constraints"].as_array().unwrap().contains(&json!("t"))),
        "{clusters:?}"
    );
    assert_error_conforms(&e);
}

#[test]
fn a_symmetric_between_welded_ends_that_forge_solve_also_finds_redundant_is_listed_once() {
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "line", "id": "l1", "start": [0, 0], "end": [5, 0], "construction": true },
            { "kind": "line", "id": "l2", "start": [5, 0], "end": [5, 5], "construction": true },
            { "kind": "line", "id": "ax", "start": [5, -1], "end": [5, 10], "construction": true }
        ],
        "constraints": [
            { "id": "v", "type": "vertical", "line": "l2" },
            { "id": "pol", "type": "point_on_line", "point": "l1.end", "line": "ax" },
            { "id": "sym", "type": "symmetric", "a": "l1.end", "b": "l2.start", "line": "ax" }
        ]
    }));
    let r = eval(&s).expect("ok");
    let w = r
        .warnings
        .iter()
        .find(|w| w.code == "SKETCH_REDUNDANT_CONSTRAINTS")
        .expect("redundant");
    assert_eq!(
        w.details["redundant"],
        json!([{ "constraint": "sym", "implied_by": ["pol"] }])
    );
    let d = r.solve_report.as_ref().unwrap();
    assert_eq!(d.redundant.len(), 1);
    assert!(!d.redundant[0].partial, "welding + pol imply all of it");
    assert!(d.redundant[0].explanation.contains("welded"));
    assert_warnings_conform(&r);
    replay_ok(&s, &r, &ResolvedValues::new());
}

fn stored_curves(s: &SketchFeature) -> Vec<LiteralCurve> {
    s.curves
        .iter()
        .map(|c| serde_json::from_value(serde_json::to_value(c).unwrap()).unwrap())
        .collect()
}

#[test]
fn welded_ends_within_tol_but_not_bit_equal_are_a_fixed_point_only_once_written_back() {
    // right.start is 5e-7 from bottom.end (welded, not bit-equal). As written every constraint
    // holds (right is vertical), but the welded guess — right.start at bottom.end — is not:
    // SPEC-v1 §4.4 rule 4 holds on the welded guess, so the solve moves geometry (≤ tol).
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "line", "id": "bottom", "start": [0, 0], "end": [10, 0] },
            { "kind": "line", "id": "right", "start": [10.0000005, 0], "end": [10.0000005, 5] },
            { "kind": "line", "id": "top", "start": [10.0000005, 5], "end": [0, 5] },
            { "kind": "line", "id": "left", "start": [0, 5], "end": [0, 0] }
        ],
        "constraints": [
            { "id": "h", "type": "horizontal", "line": "bottom" },
            { "id": "v", "type": "vertical", "line": "right" }
        ]
    }));
    let r = eval(&s).expect("ok");
    assert_ne!(
        r.trace.solved,
        stored_curves(&s),
        "not a fixed point as written"
    );
    let moved = r
        .trace
        .solved
        .iter()
        .zip(stored_curves(&s))
        .flat_map(|(a, b)| match (a, &b) {
            (
                LiteralCurve::Line { start, end, .. },
                LiteralCurve::Line {
                    start: s0, end: e0, ..
                },
            ) => vec![
                (start[0] - s0[0]).hypot(start[1] - s0[1]),
                (end[0] - e0[0]).hypot(end[1] - e0[1]),
            ],
            _ => vec![],
        })
        .fold(0.0f64, f64::max);
    assert!(moved <= 1e-6, "moves by at most tol: {moved}");
    // Written back, it is the welded guess of the next evaluation: a fixed point in one step.
    let wb = write_back(&s, &r).expect("constrained");
    let r2 = eval(&wb).expect("ok");
    assert_eq!(r2.trace.solved, stored_curves(&wb), "bit-identical");
    assert_eq!(r2.solve_report.as_ref().unwrap().solver.iterations, 0);
    assert_eq!(write_back(&wb, &r2).as_ref(), Some(&wb), "idempotent");
}

#[test]
fn write_back_writes_the_solution_literally_and_the_next_evaluation_rewelds() {
    // A coincident between two separate ends: the solve joins them to ~1e-10 (not welded in
    // the stored geometry). Write-back replaces the literal coordinates with the solved ones,
    // exactly (SPEC-v1 §4.4 rule 9) — no snapping.
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "line", "id": "a", "start": [0, 0], "end": [10, 0], "construction": true },
            { "kind": "line", "id": "b", "start": [10.3, 0.2], "end": [10, 5], "construction": true }
        ],
        "constraints": [
            { "id": "f", "type": "fix", "entity": "a" },
            { "id": "c", "type": "coincident", "a": "a.end", "b": "b.start" }
        ]
    }));
    let r = eval(&s).expect("ok");
    assert_eq!(
        r.trace.status,
        Some(IrStatus::UnderConstrained),
        "b.end is free"
    );
    let wb = write_back(&s, &r).expect("constrained");
    assert_eq!(
        stored_curves(&wb),
        r.trace.solved,
        "the solution, literally"
    );
    let pts = |c: &[LiteralCurve]| -> (P2, P2) {
        let (LiteralCurve::Line { end, .. }, LiteralCurve::Line { start, .. }) = (&c[0], &c[1])
        else {
            panic!("lines")
        };
        (*end, *start)
    };
    let (ae, bs) = pts(&stored_curves(&wb));
    assert!(
        (ae[0] - bs[0]).hypot(ae[1] - bs[1]) <= 1e-9,
        "joined by the solve"
    );
    // Its next evaluation welds them: the coincident is now redundant (status change: the
    // contract issue between §4.3 welding and §4.4 rules 4/9). Rule 4 holds on the welded
    // guess: the solution is `wb` with b.start at a.end, bit for bit.
    let r2 = eval(&wb).expect("ok");
    assert_eq!(r2.trace.status, Some(IrStatus::OverConstrainedRedundant));
    assert_eq!(r2.trace.solved, welded_guess(&stored_curves(&wb)));
    let (ae, bs) = pts(&r2.trace.solved);
    assert_eq!(ae.map(f64::to_bits), bs.map(f64::to_bits), "welded");
    // One more write-back is the fixed point: bit-identical evaluation, idempotent.
    let wb2 = write_back(&wb, &r2).expect("constrained");
    let r3 = eval(&wb2).expect("ok");
    assert_eq!(r3.trace, r2.trace);
    assert_eq!(r3.warnings, r2.warnings);
    assert_eq!(write_back(&wb2, &r3).as_ref(), Some(&wb2));

    // A driving distance ≤ tol between separate ends solves, but it writes back two ends
    // within tol: the next evaluation welds them and decides the distance as a conflict
    // (contract issue: §4.3 welding vs §4.4 rule 1, which only rejects values ≤ 0).
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "line", "id": "a", "start": [0, 0], "end": [10, 0], "construction": true },
            { "kind": "line", "id": "b", "start": [10.001, 0], "end": [10.001, 5], "construction": true }
        ],
        "constraints": [
            { "id": "f", "type": "fix", "entity": "a" },
            { "id": "d", "type": "distance", "a": "a.end", "b": "b.start", "value": 5e-7 }
        ]
    }));
    let r = eval(&s).expect("solves");
    replay_ok(&s, &r, &ResolvedValues::new());
    let wb = write_back(&s, &r).expect("constrained");
    let e = eval(&wb).expect_err("welded now");
    assert_eq!(e.code(), "SKETCH_CONSTRAINT_CONFLICT");
}

#[test]
fn a_collinear_stored_guess_never_raises_the_flip_warning() {
    // Review probe: the stored triangle is collinear (every point on y = x/3), so its computed
    // area is roundoff whose sign depended on t; every run solves to the same triangle. No
    // orientation at the tolerance scale means no SKETCH_LOOP_FLIPPED, for every t.
    for t in [0.7, 1.3, 2.9, 0.37, 0.1, 5.3, 11.1, 0.9] {
        let s = sketch(json!({
            "id": "s", "name": "s", "plane": "XY",
            "curves": [
                { "kind": "line", "id": "t1", "start": [0, 0], "end": [0.3, 0.1] },
                { "kind": "line", "id": "t2", "start": [0.3, 0.1], "end": [0.3 * t, 0.1 * t] },
                { "kind": "line", "id": "t3", "start": [0.3 * t, 0.1 * t], "end": [0, 0] }
            ],
            "constraints": [
                { "id": "f1", "type": "fix", "entity": "t1" },
                { "id": "f2", "type": "fix", "entity": "t2.end", "x": 0.3 * t, "y": 0.1 * t + 2.0 }
            ]
        }));
        let r = eval(&s).unwrap_or_else(|e| panic!("t = {t}: {e}"));
        assert_eq!(r.trace.status, Some(IrStatus::FullyConstrained), "t = {t}");
        assert_eq!(r.regions.len(), 1, "t = {t}");
        assert!(
            (r.regions[0].area - 0.3).abs() <= 1e-12,
            "t = {t}: {}",
            r.regions[0].area
        );
        assert!(r.warnings.is_empty(), "t = {t}: {:?}", r.warnings);
        replay_ok(&s, &r, &ResolvedValues::new());
    }
}

#[test]
fn a_fixed_point_with_extreme_length_ratios_passes_the_geometric_cap() {
    // Review: a 1 µm line parallel (to 2e-12 rad) to a 1 km line satisfies the pinned
    // tolerance (6.3e-11 mm at the guess scale √(1e-3 · 1e6)), so SPEC-v1 §4.4 rule 4 makes
    // it a fixed point that must evaluate ok — although the far end of the long line is
    // 2e-6 mm (2 tol) off parallel. The cap only rejects error the solve amplified by growth.
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "line", "id": "a", "start": [0, 0], "end": [0.001, 0], "construction": true },
            { "kind": "line", "id": "b", "start": [0, 10], "end": [1_000_000, 10.000002], "construction": true }
        ],
        "constraints": [ { "id": "p", "type": "parallel", "a": "a", "b": "b" } ]
    }));
    let r = eval(&s).expect("a fixed point is ok");
    assert_eq!(r.trace.solved, stored_curves(&s), "bit-identical (rule 4)");
    assert_eq!(r.solve_report.as_ref().unwrap().solver.iterations, 0);
    replay_ok(&s, &r, &ResolvedValues::new());
}

#[test]
fn a_long_adversarially_ordered_weld_chain_is_checked_in_bounded_time() {
    // Review repro: n construction lines whose starts form a chain 0.9 tol apart, listed so
    // that the old relabelling welding of the independent check needed one pass per link
    // (n = 400: 6.9 s in a debug build, ~n³). Line 0 starts at the chain's origin, line
    // k ≥ 1 at t = n − k; the far ends are isolated. The sweep welding is ~linear here.
    let n = 1000;
    let curves: Vec<Value> = (0..n)
        .map(|k| {
            let t = if k == 0 { 0 } else { n - k };
            json!({
                "kind": "line", "id": format!("l{k}"),
                "start": [t as f64 * 0.9e-6, 0.0],
                "end": [10.0 * (k + 1) as f64, 100.0],
                "construction": true
            })
        })
        .collect();
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY", "curves": curves,
        "constraints": [ { "id": "f", "type": "fix", "entity": "l0.start" } ]
    }));
    let started = std::time::Instant::now();
    let r = eval(&s).expect("ok");
    let elapsed = started.elapsed();
    assert_eq!(r.trace.status, Some(IrStatus::UnderConstrained));
    assert!(r.regions.is_empty());
    let d = r.solve_report.as_ref().expect("diagnosis");
    assert_eq!(d.welds.len(), 1, "every start welds into one point");
    assert_eq!(d.welds[0].representative, "l0.start");
    assert_eq!(d.welds[0].members.len(), n);
    replay_ok(&s, &r, &ResolvedValues::new());
    // Generous (a loaded debug build): the cubic check took minutes at this size.
    assert!(elapsed.as_secs() < 30, "{elapsed:?}");
}

#[test]
fn failed_clusters_report_the_nan_aware_residual_forge_solve_measures() {
    // `SKETCH_SOLVE_FAILED.max_residual` re-measures every failed cluster with
    // `Solver::cluster_max_residual` (NaN-propagating), which equals
    // `ClusterReport::max_residual` whenever no residual is NaN.
    let g = forge_solve::generate::polygon(1_455_554_950_525_772_012, true).sketch;
    let lifted = forge_sketch::lift::lift("s", &g, false).expect("lift");
    let e = eval(&lifted.sketch).expect_err("fails");
    let SketchError::SolveFailed {
        reason,
        max_residual,
        diagnosis,
        ..
    } = &e
    else {
        panic!("{e}")
    };
    assert_eq!(*reason, forge_sketch::SolveFailure::NotConverged);
    let failed: Vec<f64> = diagnosis
        .solver
        .clusters
        .iter()
        .filter(|c| !c.status.is_solved())
        .map(|c| c.max_residual)
        .collect();
    assert!(!failed.is_empty());
    assert_eq!(
        max_residual.to_bits(),
        failed.iter().copied().fold(0.0, f64::max).to_bits()
    );
    // The helper agrees with the report on every cluster of the lowered input; `None` past
    // the end.
    let mut solver =
        forge_solve::Solver::new(&diagnosis.solver_input, &forge_sketch::solve_options_v1())
            .expect("valid");
    let r = solver.solve();
    for c in &r.clusters {
        let m = solver.cluster_max_residual(c.index).expect("cluster");
        assert_eq!(m.to_bits(), c.max_residual.to_bits(), "cluster {}", c.index);
    }
    assert_eq!(solver.cluster_max_residual(r.clusters.len()), None);
}
