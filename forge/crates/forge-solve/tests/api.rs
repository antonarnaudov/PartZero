//! Public API and JSON boundary: request/response shapes, structured error codes, drag.

use forge_solve::{
    Constraint, ConstraintState, DragResponse, Entity, Sketch, SketchError, SolveOptions,
    SolveResult, SolveStatus, Solver, c, drag_json, solve, solve_json,
};
use serde_json::{Value, json};

fn segment() -> Sketch {
    Sketch {
        entities: vec![
            Entity::point("a", 0.0, 0.0),
            Entity::point("b", 9.0, 1.0),
            Entity::line("ab", "a", "b"),
        ],
        constraints: vec![
            Constraint::new("fa", c::fix("a")),
            Constraint::new("h", c::horizontal("ab")),
            Constraint::new("len", c::distance("a", "b", 10.0)),
        ],
    }
}

#[test]
fn json_solve_round_trips_through_the_public_types() {
    let req = json!({
        "sketch": {
            "entities": [
                {"id": "a", "type": "point", "x": 0, "y": 0},
                {"id": "b", "type": "point", "x": 9, "y": 1},
                {"id": "ab", "type": "line", "p1": "a", "p2": "b", "construction": true},
                {"id": "o", "type": "point", "x": 20, "y": 0, "fixed": true},
                {"id": "circ", "type": "circle", "center": "o", "radius": 2.5}
            ],
            "constraints": [
                {"id": "fa", "type": "fix", "entity": "a"},
                {"id": "h", "type": "horizontal", "line": "ab"},
                {"id": "len", "type": "distance", "a": "a", "b": "b", "value": 10},
                {"id": "ref", "type": "distance", "a": "b", "b": "o", "value": 1, "driving": false},
                {"id": "r", "type": "diameter", "curve": "circ", "value": 6}
            ]
        },
        "options": {"tolerance": 1e-11}
    });
    let out: Value = serde_json::from_str(&solve_json(&req.to_string())).expect("json");
    assert_eq!(out["status"], "fully_constrained", "{out}");
    assert_eq!(out["ok"], true);
    assert_eq!(out["dof"], 0);
    let refc = out["constraints"]
        .as_array()
        .expect("constraints")
        .iter()
        .find(|c| c["id"] == "ref")
        .expect("ref")
        .clone();
    assert_eq!(refc["state"], "reference");
    assert!((refc["measured"].as_f64().expect("measured") - 10.0).abs() < 1e-9);
    // The response deserializes into the public result type and re-serializes identically.
    let typed: SolveResult = serde_json::from_value(out.clone()).expect("typed");
    assert_eq!(serde_json::to_value(&typed).expect("value"), out);
    // Inputs round-trip through the model types (construction flag, reference dimension).
    let sketch: Sketch = serde_json::from_value(req["sketch"].clone()).expect("sketch");
    assert!(sketch.entities[2].construction && sketch.entities[3].fixed);
    assert!(!sketch.constraints[3].driving);
    assert_eq!(
        serde_json::to_value(&sketch).expect("value")["entities"][2]["construction"],
        true
    );
}

fn error_code(input: &str) -> String {
    let v: Value = serde_json::from_str(&solve_json(input)).expect("json");
    v["error"]["code"].as_str().unwrap_or("<none>").to_owned()
}

#[test]
fn invalid_input_yields_structured_error_codes() {
    let base = |extra_entities: Value, constraints: Value| {
        let mut entities = vec![
            json!({"id": "a", "type": "point", "x": 0, "y": 0}),
            json!({"id": "b", "type": "point", "x": 1, "y": 0}),
            json!({"id": "l", "type": "line", "p1": "a", "p2": "b"}),
        ];
        entities.extend(extra_entities.as_array().cloned().unwrap_or_default());
        json!({"sketch": {"entities": entities, "constraints": constraints}}).to_string()
    };
    assert_eq!(error_code("{not json"), "SKETCH_JSON");
    assert_eq!(
        error_code(&base(
            json!([{"id": "a", "type": "point", "x": 0, "y": 0}]),
            json!([])
        )),
        "SKETCH_DUPLICATE_ID"
    );
    assert_eq!(
        error_code(&base(
            json!([]),
            json!([{"id": "k", "type": "horizontal", "line": "nope"}])
        )),
        "SKETCH_UNKNOWN_REFERENCE"
    );
    assert_eq!(
        error_code(&base(
            json!([]),
            json!([{"id": "k", "type": "horizontal", "line": "a"}])
        )),
        "SKETCH_WRONG_ENTITY_TYPE"
    );
    assert_eq!(
        error_code(&base(
            json!([{"id": "z", "type": "line", "p1": "a", "p2": "a"}]),
            json!([])
        )),
        "SKETCH_DEGENERATE_ENTITY"
    );
    assert_eq!(
        error_code(&base(
            json!([{"id": "c", "type": "circle", "center": "a", "radius": 0}]),
            json!([])
        )),
        "SKETCH_DEGENERATE_ENTITY"
    );
    assert_eq!(
        error_code(&base(
            json!([]),
            json!([{"id": "k", "type": "distance", "a": "a", "b": "b", "value": -1}])
        )),
        "SKETCH_INVALID_DIMENSION"
    );
    assert_eq!(
        error_code(&base(
            json!([]),
            json!([{"id": "k", "type": "horizontal", "line": "l", "driving": false}])
        )),
        "SKETCH_NOT_A_DIMENSION"
    );
    assert_eq!(
        error_code(&base(
            json!([{"id": "m", "type": "line", "p1": "b", "p2": "a"}]),
            json!([{"id": "k", "type": "tangent", "a": "l", "b": "m"}])
        )),
        "SKETCH_UNSUPPORTED_COMBINATION"
    );
    assert_eq!(
        error_code(&base(
            json!([]),
            json!([{"id": "k", "type": "coincident", "a": "a", "b": "a"}])
        )),
        "SKETCH_SELF_REFERENCE"
    );
    assert_eq!(
        error_code(&base(
            json!([]),
            json!([{"id": "", "type": "horizontal", "line": "l"}])
        )),
        "SKETCH_EMPTY_ID"
    );
    // A nested reference to a non-point is caught while validating entities (no panic).
    assert_eq!(
        error_code(&base(
            json!([{"id": "bad", "type": "line", "p1": "l", "p2": "a"}]),
            json!([])
        )),
        "SKETCH_WRONG_ENTITY_TYPE"
    );
    // Error envelopes carry the message and the structured details.
    let v: Value = serde_json::from_str(&solve_json(&base(
        json!([]),
        json!([{"id": "k", "type": "horizontal", "line": "nope"}]),
    )))
    .expect("json");
    assert_eq!(v["error"]["details"]["owner"], "k");
    assert_eq!(v["error"]["details"]["reference"], "nope");
    assert!(
        v["error"]["message"]
            .as_str()
            .expect("message")
            .contains("nope")
    );
}

#[test]
fn rust_api_errors_match_json_codes() {
    let mut s = segment();
    s.constraints.push(Constraint::new("h", c::vertical("ab")));
    let e = solve(&s, &SolveOptions::default()).expect_err("duplicate id");
    assert_eq!(e, SketchError::DuplicateId { id: "h".into() });
    assert_eq!(e.code(), "SKETCH_DUPLICATE_ID");
}

#[test]
fn drag_follows_the_cursor_where_free_and_holds_where_constrained() {
    let mut s = segment();
    s.entities.push(Entity::point("free", 3.0, 3.0));
    let mut solver = Solver::new(&s, &SolveOptions::default()).expect("valid");
    let r = solver.solve();
    assert_eq!((r.status, r.dof), (SolveStatus::UnderConstrained, 2));
    // A completely free point jumps to the cursor.
    let f = solver.drag("free", [5.0, -2.0]).expect("drag");
    assert!(f.converged && f.target_error == 0.0);
    let bits = |p: Option<[f64; 2]>| p.map(|p| p.map(f64::to_bits));
    assert_eq!(bits(solver.point("free")), bits(Some([5.0, -2.0])));
    // b is fully determined: it snaps back and reports how far the cursor is.
    let f = solver.drag("b", [12.0, 4.0]).expect("drag");
    assert!(f.converged);
    let b = solver.point("b").expect("b");
    assert!((b[0] - 10.0).abs() < 1e-9 && b[1].abs() < 1e-9, "{b:?}");
    assert!((f.target_error - (4.0f64 * 4.0 + 2.0 * 2.0).sqrt()).abs() < 1e-9);
    // Errors: unknown id, not a point, fixed point.
    assert_eq!(
        solver.drag("nope", [0.0, 0.0]).expect_err("unknown").code(),
        "SKETCH_INVALID_DRAG"
    );
    assert_eq!(
        solver.drag("ab", [0.0, 0.0]).expect_err("line").code(),
        "SKETCH_INVALID_DRAG"
    );
    let mut s2 = segment();
    s2.entities[0].fixed = true;
    let mut solver2 = Solver::new(&s2, &SolveOptions::default()).expect("valid");
    assert_eq!(
        solver2.drag("a", [1.0, 1.0]).expect_err("fixed").code(),
        "SKETCH_INVALID_DRAG"
    );
}

#[test]
fn dragging_an_under_constrained_rectangle_resizes_it_minimally() {
    // Axis-aligned rectangle with a fixed corner: dragging the opposite corner changes
    // width and height; the fixed corner stays; all constraints keep holding.
    let mut s = Sketch::default();
    for (id, x, y) in [
        ("p0", 0.0, 0.0),
        ("p1", 10.0, 0.0),
        ("p2", 10.0, 5.0),
        ("p3", 0.0, 5.0),
    ] {
        s.entities.push(Entity::point(id, x, y));
    }
    for (i, (a, b)) in [("p0", "p1"), ("p1", "p2"), ("p2", "p3"), ("p3", "p0")]
        .into_iter()
        .enumerate()
    {
        s.entities.push(Entity::line(format!("L{i}"), a, b));
    }
    for (id, k) in [
        ("h0", c::horizontal("L0")),
        ("v1", c::vertical("L1")),
        ("h2", c::horizontal("L2")),
        ("v3", c::vertical("L3")),
        ("fix", c::fix("p0")),
    ] {
        s.constraints.push(Constraint::new(id, k));
    }
    let mut solver = Solver::new(&s, &SolveOptions::default()).expect("valid");
    assert_eq!(solver.solve().dof, 2);
    for t in [[12.0, 6.0], [14.0, 7.0], [8.0, 3.0]] {
        let f = solver.drag("p2", t).expect("drag");
        assert!(f.converged);
        assert!(f.target_error < 1e-5, "{}", f.target_error);
        let p2 = solver.point("p2").expect("p2");
        let p0 = solver.point("p0").expect("p0");
        assert_eq!(p0.map(f64::to_bits), [0.0f64, 0.0].map(f64::to_bits));
        assert!((solver.point("p1").expect("p1")[0] - p2[0]).abs() < 1e-9);
        assert!((solver.point("p3").expect("p3")[1] - p2[1]).abs() < 1e-9);
        assert!(f.moved.iter().any(|m| m.id == "p1") && f.moved.iter().all(|m| m.id != "p0"));
    }
}

#[test]
fn drag_json_runs_frames_and_returns_the_final_sketch() {
    let req = json!({
        "sketch": serde_json::to_value(segment()).expect("value"),
        "point": "b",
        "targets": [[11.0, 0.5], [9.0, -0.5]]
    });
    let out = drag_json(&req.to_string());
    let resp: DragResponse = serde_json::from_str(&out).expect("drag response");
    assert_eq!(resp.frames.len(), 2);
    assert!(resp.frames.iter().all(|f| f.converged));
    let err: Value = serde_json::from_str(&drag_json(&json!({"sketch": serde_json::to_value(segment()).expect("v"), "point": "zz", "targets": [[0, 0]]}).to_string())).expect("json");
    assert_eq!(err["error"]["code"], "SKETCH_INVALID_DRAG");
}

#[test]
fn constraint_states_cover_the_whole_lifecycle() {
    let mut s = segment();
    s.constraints
        .push(Constraint::new("dup", c::distance("b", "a", 10.0)));
    s.constraints
        .push(Constraint::new("meas", c::distance("a", "b", 3.0)).reference());
    let r = solve(&s, &SolveOptions::default()).expect("valid");
    let state = |id: &str| r.constraints.iter().find(|c| c.id == id).expect("c").state;
    assert_eq!(state("len"), ConstraintState::Satisfied);
    assert_eq!(state("dup"), ConstraintState::Redundant);
    assert_eq!(state("meas"), ConstraintState::Reference);
    assert_eq!(r.redundant[0].implied_by, ["len"]);
}
