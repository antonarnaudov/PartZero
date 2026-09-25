//! IR v1 evaluation (SPEC-v1 §7.1) end to end: parameters and expressions (W1), explicit and
//! constrained sketches (W2), plane/body references, datums and tags (W3), and body
//! operations (W4) wired by `forge_regen::v1`. Volumes are checked against closed forms.

use forge_ir::v1::metrics::{EvalReport, FeatureReport, Severity, Status};
use forge_regen::v1;
use serde_json::{Value, json};

fn doc(params: Value, features: Value) -> String {
    json!({
        "schema": "aicad.ir/1",
        "meta": { "name": "t" },
        "params": params,
        "parts": [{ "id": "p1", "name": "part", "features": features }]
    })
    .to_string()
}

fn run(text: &str) -> EvalReport {
    let (r, ev) = v1::evaluate_text(text, "forge test", "t");
    assert!(
        ev.is_some(),
        "rejected: {:?}",
        r.error.as_ref().map(|e| (&e.code, &e.message, &e.details))
    );
    // Determinism: a second evaluation gives the same bytes.
    let (again, _) = v1::evaluate_text(text, "forge test", "t");
    assert_eq!(
        serde_json::to_string(&r).unwrap(),
        serde_json::to_string(&again).unwrap(),
        "evaluation is not deterministic"
    );
    r
}

fn feature<'a>(r: &'a EvalReport, id: &str) -> &'a FeatureReport {
    r.features
        .iter()
        .find(|f| f.feature_id == id)
        .unwrap_or_else(|| panic!("no entry for {id}"))
}

fn code<'a>(r: &'a EvalReport, id: &str) -> Option<&'a str> {
    feature(r, id).error.as_ref().map(|e| e.code.as_str())
}

fn close(a: f64, b: f64, rel: f64) -> bool {
    (a - b).abs() <= rel * a.abs().max(b.abs()).max(1.0)
}

fn part_volumes(r: &EvalReport) -> Vec<f64> {
    r.parts[0].bodies.iter().map(|b| b.volume).collect()
}

fn rect_sketch(id: &str, plane: Value, cx: Value, cy: Value, w: Value, h: Value) -> Value {
    json!({ "type": "sketch", "id": id, "name": id, "plane": plane, "curves": [
        { "kind": "rect", "id": "r", "center": [cx, cy], "w": w, "h": h } ] })
}

fn extrude(id: &str, sketch: &str, d: Value) -> Value {
    json!({ "type": "extrude", "id": id, "name": id, "sketch": sketch, "distance": d })
}

fn body_ref(feature: &str) -> Value {
    json!({ "kind": "body", "q": { "op": "body", "feature": feature } })
}

// ---- parameters and expressions (§2) -----------------------------------------------------------

#[test]
fn parameters_drive_fields_and_are_reported() {
    let r = run(&doc(
        json!([
            { "name": "w", "unit": "mm", "value": 40 },
            { "name": "h", "unit": "mm", "value": "w / 2" },
            { "name": "t", "unit": "mm", "value": "2 cm - 5" }
        ]),
        json!([
            rect_sketch(
                "s1",
                json!("XY"),
                json!(0),
                json!(0),
                json!("w"),
                json!("h")
            ),
            extrude("e1", "s1", json!("t"))
        ]),
    ));
    assert_eq!(r.status, Status::Ok);
    assert_eq!(r.schema, "aicad.metrics/1");
    let vals: Vec<_> = r
        .params
        .iter()
        .map(|p| serde_json::to_value(&p.value).unwrap())
        .collect();
    assert_eq!(vals, vec![json!(40.0), json!(20.0), json!(15.0)]);
    let b = &feature(&r, "e1").bodies[0];
    assert!(close(b.volume, 40.0 * 20.0 * 15.0, 1e-12), "{}", b.volume);
    assert_eq!(b.origin.feature, "e1");
    assert_eq!(b.origin.member, "r.bottom");
    assert_eq!(b.faces, 6);
    assert_eq!(b.shells, 1);
    // The sketch block: explicit mode, members expanded.
    let sk = feature(&r, "s1").sketch.as_ref().expect("sketch block");
    assert_eq!(sk.solved.len(), 4);
    assert_eq!(r.parts[0].bodies.len(), 1);
    assert!(r.parts[0].bodies[0].change.is_none());
}

#[test]
fn an_expression_range_check_fails_the_feature_with_the_literal_code() {
    // SPEC-v1 §0.5 rule 2's example: distance "t - 10" with t = 8.
    let r = run(&doc(
        json!([{ "name": "t", "unit": "mm", "value": 8 }]),
        json!([
            rect_sketch("s1", json!("XY"), json!(0), json!(0), json!(10), json!(10)),
            extrude("e1", "s1", json!("t - 10")),
            extrude("e2", "s1", json!("t"))
        ]),
    ));
    assert_eq!(r.status, Status::Error);
    let e = feature(&r, "e1").error.as_ref().unwrap();
    assert_eq!(e.code, "INVALID_DISTANCE");
    assert_eq!(e.details["value"], json!(-2.0));
    // The failed feature passes its input through; later features still run.
    assert_eq!(code(&r, "e2"), None);
    let v = part_volumes(&r);
    assert!(v.len() == 1 && close(v[0], 800.0, 1e-12), "{v:?}");
}

#[test]
fn a_failed_parameter_fails_every_user_with_param_failed() {
    let r = run(&doc(
        json!([
            { "name": "z", "unit": "ratio", "value": 0 },
            { "name": "a", "unit": "mm", "value": "10 mm / z" },
            { "name": "b", "unit": "mm", "value": "a + 1" }
        ]),
        json!([
            rect_sketch("s1", json!("XY"), json!(0), json!(0), json!(10), json!(10)),
            extrude("e1", "s1", json!("b")),
            extrude("e2", "s1", json!(3))
        ]),
    ));
    assert_eq!(r.params[1].error.as_ref().unwrap().code, "EXPR_DOMAIN");
    assert_eq!(r.params[2].error.as_ref().unwrap().code, "PARAM_FAILED");
    let e = feature(&r, "e1").error.as_ref().unwrap();
    assert_eq!(e.code, "PARAM_FAILED");
    assert_eq!(e.details["param"], json!("a"));
    assert_eq!(code(&r, "e2"), None);
}

#[test]
fn suppression_by_expression_skips_the_feature_and_its_consumers_fail() {
    let r = run(&doc(
        json!([{ "name": "lid", "unit": "bool", "value": false }]),
        json!([
            {
                "type": "sketch", "id": "s1", "name": "s1", "plane": "XY", "suppressed": "!lid",
                "curves": [{ "kind": "circle", "id": "c", "center": [0, 0], "radius": 5 }]
            },
            extrude("e1", "s1", json!(2))
        ]),
    ));
    assert!(r.features.iter().all(|f| f.feature_id != "s1"));
    let e = feature(&r, "e1").error.as_ref().unwrap();
    assert_eq!(e.code, "SKETCH_SUPPRESSED");
    assert_eq!(e.details["sketch"], json!("s1"));
    assert!(r.parts[0].bodies.is_empty());
}

// ---- sketches (§4) ------------------------------------------------------------------------------

#[test]
fn a_constrained_sketch_is_solved_and_reported() {
    let text = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../corpus/v1/programs/constrained_plate.json"),
    )
    .unwrap();
    let r = run(&text);
    assert_eq!(r.status, Status::Ok);
    let sk = feature(&r, "s1").sketch.as_ref().unwrap();
    assert_eq!(
        serde_json::to_value(sk.status).unwrap(),
        json!("fully_constrained")
    );
    assert_eq!(sk.dof, Some(0));
    assert!(!sk.dimensions.is_empty());
    let b = &feature(&r, "e1").bodies[0];
    assert!(close(b.volume, 80.0 * 50.0 * 6.0, 1e-12), "{}", b.volume);
}

#[test]
fn a_solve_conflict_fails_the_sketch_and_its_consumers_without_stale_geometry() {
    let r = run(&doc(
        json!([]),
        json!([
            { "type": "sketch", "id": "s1", "name": "s1", "plane": "XY", "curves": [
                { "kind": "line", "id": "a", "start": [0, 0], "end": [10, 0] },
                { "kind": "line", "id": "b", "start": [10, 0], "end": [10, 10] },
                { "kind": "line", "id": "c", "start": [10, 10], "end": [0, 0] } ],
              "constraints": [
                { "id": "d1", "type": "distance", "a": "a.start", "b": "a.end", "value": 10 },
                { "id": "d2", "type": "distance", "a": "a.start", "b": "a.end", "value": 20 } ] },
            extrude("e1", "s1", json!(1))
        ]),
    ));
    assert_eq!(code(&r, "s1"), Some("SKETCH_CONSTRAINT_CONFLICT"));
    assert!(feature(&r, "s1").sketch.is_none());
    assert_eq!(code(&r, "e1"), Some("DEPENDENCY_FAILED"));
    assert!(r.parts[0].bodies.is_empty());
}

#[test]
fn regions_are_selected_by_member_curve() {
    let r = run(&doc(
        json!([]),
        json!([
            { "type": "sketch", "id": "s1", "name": "s1", "plane": "XY", "curves": [
                { "kind": "circle", "id": "big", "center": [0, 0], "radius": 10 },
                { "kind": "circle", "id": "small", "center": [30, 0], "radius": 2 } ] },
            { "type": "extrude", "id": "e1", "name": "e1", "sketch": "s1", "distance": 1,
              "regions": ["small"] }
        ]),
    ));
    let b = &feature(&r, "e1").bodies;
    assert_eq!(b.len(), 1);
    assert_eq!(b[0].origin.member, "small");
    assert!(close(b[0].volume, std::f64::consts::PI * 4.0, 1e-12));
    // The other region is not built.
    assert_eq!(r.parts[0].bodies.len(), 1);
}

// ---- references, planes, datums, tags (§3, §5) ---------------------------------------------------

#[test]
fn a_sketch_on_a_face_follows_the_face_and_joins_its_target() {
    let r = run(&doc(
        json!([{ "name": "t", "unit": "mm", "value": 8 }]),
        json!([
            rect_sketch("s1", json!("XY"), json!(0), json!(0), json!(80), json!(50)),
            extrude("e1", "s1", json!("t")),
            { "type": "sketch", "id": "s2", "name": "s2",
              "plane": { "face": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } } },
              "curves": [{ "kind": "circle", "id": "ring", "center": [0, 0], "radius": 11 }] },
            { "type": "extrude", "id": "e2", "name": "e2", "sketch": "s2", "distance": 12,
              "op": "join", "targets": body_ref("e1") }
        ]),
    ));
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    let s2 = feature(&r, "s2");
    assert_eq!(s2.refs.len(), 1);
    assert_eq!(s2.refs[0].field, "/plane/face");
    assert_eq!(s2.refs[0].members[0].key, "e1/cap:end@r.bottom");
    let e2 = feature(&r, "e2");
    assert_eq!(e2.refs[0].field, "/targets");
    assert_eq!(e2.bodies.len(), 1);
    let b = &e2.bodies[0];
    // The join keeps the target's origin and reports it modified.
    assert_eq!(b.origin.feature, "e1");
    assert_eq!(serde_json::to_value(b.change).unwrap(), json!("modified"));
    let expect = 80.0 * 50.0 * 8.0 + std::f64::consts::PI * 121.0 * 12.0;
    assert!(close(b.volume, expect, 1e-9), "{} vs {expect}", b.volume);
    assert!(close(b.bbox_max[2], 20.0, 0.0));
    assert_eq!(r.parts[0].bodies.len(), 1);
}

#[test]
fn datum_planes_and_axes_are_evaluated_and_usable_as_sketch_planes() {
    let r = run(&doc(
        json!([{ "name": "lift", "unit": "mm", "value": 10 }]),
        json!([
            { "type": "datum_plane", "id": "d1", "name": "d1", "mode": "offset", "from": "XY",
              "distance": "lift" },
            rect_sketch("s1", json!({ "datum": "d1" }), json!(0), json!(0), json!(4), json!(4)),
            extrude("e1", "s1", json!(2)),
            { "type": "datum_axis", "id": "a1", "name": "a1", "mode": "planes", "a": "XZ", "b": "YZ" }
        ]),
    ));
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    let d = serde_json::to_value(feature(&r, "d1").datum.as_ref().unwrap()).unwrap();
    assert_eq!(d["origin"], json!([0.0, 0.0, 10.0]));
    assert_eq!(d["normal"], json!([0.0, 0.0, 1.0]));
    let b = &r.parts[0].bodies[0];
    assert!(close(b.bbox_min[2], 10.0, 0.0) && close(b.bbox_max[2], 12.0, 0.0));
    let a = serde_json::to_value(feature(&r, "a1").datum.as_ref().unwrap()).unwrap();
    assert_eq!(a["direction"], json!([0.0, 0.0, 1.0]));
}

#[test]
fn a_failed_datum_fails_its_consumers_with_dependency_failed() {
    let r = run(&doc(
        json!([]),
        json!([
            { "type": "datum_plane", "id": "d1", "name": "d1", "mode": "midplane", "a": "XY", "b": "XZ" },
            rect_sketch("s1", json!({ "datum": "d1" }), json!(0), json!(0), json!(4), json!(4))
        ]),
    ));
    assert_eq!(code(&r, "d1"), Some("DATUM_DEGENERATE"));
    let e = feature(&r, "s1").error.as_ref().unwrap();
    assert_eq!(e.code, "DEPENDENCY_FAILED");
    assert_eq!(e.details["feature"], json!("d1"));
}

#[test]
fn tags_resolve_their_target_and_report_it() {
    let r = run(&doc(
        json!([]),
        json!([
            rect_sketch("s1", json!("XY"), json!(0), json!(0), json!(10), json!(20)),
            extrude("e1", "s1", json!(5)),
            { "type": "tag", "id": "t1", "name": "t1", "target": { "kind": "face",
              "q": { "op": "filter", "of": { "op": "sides", "feature": "e1" },
                     "where": { "normal": "+X" } } } },
            { "type": "tag", "id": "t2", "name": "t2", "target": { "kind": "face",
              "q": { "op": "filter", "of": { "op": "sides", "feature": "e1" },
                     "where": { "type": "cylinder" } } } }
        ]),
    ));
    let t1 = feature(&r, "t1");
    assert_eq!(t1.status, Status::Ok);
    assert_eq!(t1.refs[0].members.len(), 1);
    assert_eq!(t1.refs[0].members[0].key, "e1/side:r.right");
    let p = &t1.refs[0].members[0].probe;
    assert!(close(p.point[0], 5.0, 0.0));
    assert_eq!(p.normal, Some([1.0, 0.0, 0.0]));
    // An empty `some` set fails with REF_MISSING and passes the input through.
    assert_eq!(code(&r, "t2"), Some("REF_MISSING"));
    assert_eq!(r.parts[0].bodies.len(), 1);
}

// ---- body operations (§6.0.3–§6.0.5, §6.4) --------------------------------------------------------

/// Box A [0,10]×[0,10]×[0,10] and box B [5,15]×[5,15]×[5,15] (overlap 125).
fn two_boxes() -> Vec<Value> {
    vec![
        rect_sketch("sa", json!("XY"), json!(5), json!(5), json!(10), json!(10)),
        extrude("ea", "sa", json!(10)),
        rect_sketch(
            "sb",
            json!({ "origin": [0, 0, 5], "normal": [0, 0, 1], "x_dir": [1, 0, 0] }),
            json!(10),
            json!(10),
            json!(10),
            json!(10),
        ),
    ]
}

#[test]
fn join_cut_and_intersect_match_the_closed_forms() {
    for (op, expect) in [("join", 1875.0), ("cut", 875.0), ("intersect", 125.0)] {
        let mut f = two_boxes();
        f.push(
            json!({ "type": "extrude", "id": "eb", "name": "eb", "sketch": "sb",
                       "distance": 10, "op": op, "targets": "all" }),
        );
        let r = run(&doc(json!([]), Value::Array(f)));
        assert_eq!(r.status, Status::Ok, "{op}: {:#?}", feature(&r, "eb"));
        let v = part_volumes(&r);
        assert_eq!(v.len(), 1, "{op}");
        assert!(close(v[0], expect, 1e-12), "{op}: {} vs {expect}", v[0]);
        let b = &feature(&r, "eb").bodies[0];
        assert_eq!(b.origin.feature, "ea", "{op}");
        assert!(b.valid);
    }
}

#[test]
fn a_standalone_boolean_consumes_its_tools_unless_kept() {
    for (keep, bodies) in [(false, 1), (true, 2)] {
        let mut f = two_boxes();
        f.push(extrude("eb", "sb", json!(10)));
        f.push(
            json!({ "type": "boolean", "id": "b1", "name": "b1", "op": "cut",
                       "targets": body_ref("ea"), "tools": body_ref("eb"), "keep_tools": keep }),
        );
        let r = run(&doc(json!([]), Value::Array(f)));
        assert_eq!(r.status, Status::Ok, "{:#?}", feature(&r, "b1"));
        let b1 = feature(&r, "b1");
        assert_eq!(b1.refs.len(), 2);
        assert!(close(b1.bodies[0].volume, 875.0, 1e-12));
        assert_eq!(r.parts[0].bodies.len(), bodies, "keep_tools {keep}");
    }
}

#[test]
fn a_body_in_both_sets_is_tool_is_target() {
    let mut f = two_boxes();
    f.push(json!({ "type": "boolean", "id": "b1", "name": "b1", "op": "join",
                   "targets": body_ref("ea"), "tools": { "kind": "body", "q": { "op": "bodies" } } }));
    let r = run(&doc(json!([]), Value::Array(f)));
    assert_eq!(code(&r, "b1"), Some("BOOLEAN_TOOL_IS_TARGET"));
    assert_eq!(r.parts[0].bodies.len(), 1);
}

#[test]
fn a_detached_join_is_no_intersection_and_passes_the_input_through() {
    let r = run(&doc(
        json!([]),
        json!([
            rect_sketch("sa", json!("XY"), json!(0), json!(0), json!(10), json!(10)),
            extrude("ea", "sa", json!(5)),
            rect_sketch("sb", json!("XY"), json!(50), json!(0), json!(10), json!(10)),
            { "type": "extrude", "id": "eb", "name": "eb", "sketch": "sb", "distance": 5,
              "op": "join", "targets": "all" }
        ]),
    ));
    let e = feature(&r, "eb").error.as_ref().unwrap();
    assert_eq!(e.code, "BOOLEAN_NO_INTERSECTION");
    assert!(close(
        e.details["min_distance"].as_f64().unwrap(),
        40.0,
        1e-9
    ));
    let v = part_volumes(&r);
    assert!(v.len() == 1 && close(v[0], 500.0, 1e-12), "{v:?}");
}

#[test]
fn a_split_target_keeps_its_origin_and_an_untouched_piece_survives_a_later_cut() {
    // A 40×10×10 bar cut through by a 4-wide slot at x = 0: two pieces, one origin.
    let r = run(&doc(
        json!([]),
        json!([
            rect_sketch("sa", json!("XY"), json!(0), json!(0), json!(40), json!(10)),
            extrude("ea", "sa", json!(10)),
            rect_sketch("sb", json!("XY"), json!(0), json!(0), json!(4), json!(20)),
            { "type": "extrude", "id": "eb", "name": "eb", "sketch": "sb", "distance": 10,
              "op": "cut", "targets": "all" },
            // A pocket in the +X piece only.
            rect_sketch("sc", json!("XY"), json!(12), json!(0), json!(2), json!(2)),
            { "type": "extrude", "id": "ec", "name": "ec", "sketch": "sc", "distance": 10,
              "op": "cut", "targets": "all" }
        ]),
    ));
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    let eb = feature(&r, "eb");
    assert_eq!(eb.bodies.len(), 2);
    assert!(eb.bodies.iter().all(|b| b.origin.feature == "ea"));
    let w: Vec<_> = eb
        .warnings
        .iter()
        .map(|w| (w.code.as_str(), w.severity))
        .collect();
    assert_eq!(w, vec![("BOOLEAN_SPLIT", Severity::Info)]);
    // The pocket modifies one piece; the other is untouched and still in the part.
    let ec = feature(&r, "ec");
    assert_eq!(ec.bodies.len(), 1);
    assert!(close(ec.bodies[0].volume, 18.0 * 100.0 - 40.0, 1e-12));
    let v = part_volumes(&r);
    assert_eq!(v.len(), 2);
    let total: f64 = v.iter().sum();
    assert!(close(total, 36.0 * 100.0 - 40.0, 1e-12), "{v:?}");
    // Canonical order: pieces of one origin by centroid (−X piece first).
    let c: Vec<f64> = r.parts[0].bodies.iter().map(|b| b.centroid[0]).collect();
    assert!(c[0] < c[1], "{c:?}");
}

#[test]
fn a_consumed_target_is_removed_with_a_warning() {
    let r = run(&doc(
        json!([]),
        json!([
            rect_sketch("sa", json!("XY"), json!(0), json!(0), json!(4), json!(4)),
            extrude("ea", "sa", json!(4)),
            rect_sketch("sb", json!("XY"), json!(0), json!(0), json!(10), json!(10)),
            { "type": "extrude", "id": "eb", "name": "eb", "sketch": "sb", "distance": 10,
              "op": "cut", "targets": body_ref("ea") }
        ]),
    ));
    let eb = feature(&r, "eb");
    assert_eq!(eb.status, Status::Ok, "{eb:#?}");
    assert!(eb.bodies.is_empty());
    assert_eq!(eb.removed.len(), 1);
    assert_eq!(eb.removed[0].feature, "ea");
    assert_eq!(eb.warnings[0].code, "BOOLEAN_BODY_CONSUMED");
    assert!(r.parts[0].bodies.is_empty());
}

#[test]
fn a_join_merging_two_targets_reports_the_other_as_removed() {
    let r = run(&doc(
        json!([]),
        json!([
            rect_sketch("sa", json!("XY"), json!(-10), json!(0), json!(10), json!(10)),
            extrude("ea", "sa", json!(5)),
            rect_sketch("sb", json!("XY"), json!(10), json!(0), json!(10), json!(10)),
            extrude("eb", "sb", json!(5)),
            rect_sketch("sc", json!("XY"), json!(0), json!(0), json!(14), json!(4)),
            { "type": "extrude", "id": "ec", "name": "ec", "sketch": "sc", "distance": 5,
              "op": "join", "targets": "all" }
        ]),
    ));
    let ec = feature(&r, "ec");
    assert_eq!(ec.status, Status::Ok, "{ec:#?}");
    assert_eq!(ec.bodies.len(), 1);
    assert_eq!(ec.bodies[0].origin.feature, "ea");
    assert_eq!(ec.removed.len(), 1);
    assert_eq!(ec.removed[0].feature, "eb");
    // The bridge (x ∈ [−7, 7]) adds its 10 mm between the plates: 2·500 + 10·4·5.
    assert!(
        close(ec.bodies[0].volume, 1200.0, 1e-12),
        "{}",
        ec.bodies[0].volume
    );
    assert_eq!(r.parts[0].bodies.len(), 1);
}

#[test]
fn a_failed_reference_fails_the_feature_with_its_code() {
    let mut f = two_boxes();
    f.push(json!({ "type": "extrude", "id": "eb", "name": "eb", "sketch": "sb", "distance": 10,
                   "op": "cut", "targets": { "kind": "body", "q": { "op": "bodies" }, "card": 2 } }));
    let r = run(&doc(json!([]), Value::Array(f)));
    let eb = feature(&r, "eb");
    assert_eq!(eb.error.as_ref().unwrap().code, "REF_CARDINALITY");
    assert_eq!(
        serde_json::to_value(eb.refs[0].status).unwrap(),
        json!("failed")
    );
    let v = part_volumes(&r);
    assert!(v.len() == 1 && close(v[0], 1000.0, 1e-12), "{v:?}");
}

// ---- unsupported features, documents -------------------------------------------------------------

fn fillet_doc() -> String {
    doc(
        json!([]),
        json!([
            rect_sketch("s1", json!("XY"), json!(0), json!(0), json!(20), json!(20)),
            extrude("e1", "s1", json!(5)),
            { "type": "fillet", "id": "f1", "name": "f1", "r": 1,
              "edges": { "kind": "edge", "q": { "op": "edges", "of": { "op": "body", "feature": "e1" } } } },
            { "type": "tag", "id": "t1", "name": "t1", "target": { "kind": "face",
              "q": { "op": "created", "feature": "f1" }, "card": "any" } },
            extrude("e2", "s1", json!(1))
        ]),
    )
}

/// `{ code, path }` of every problem of a rejected report.
fn problems(r: &EvalReport) -> Vec<(String, String)> {
    r.error.as_ref().map_or_else(Vec::new, |e| {
        e.details["errors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| {
                (
                    x["code"].as_str().unwrap().to_string(),
                    x["path"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    })
}

/// SPEC-v1 §0.2 rule 3 since Phase C: Forge implements every mandatory feature type
/// (`hole`, `pattern`: W5; `fillet`, `chamfer`, `shell`: W6), so a document using them loads
/// and evaluates (the pre-Phase C `UNSUPPORTED_FEATURE_VERSION` rejection is gone; only the
/// optional `draft` is still rejected, see below). The fillet of every edge of a box is the
/// rounded box of Steiner's formula (normative sphere corners, §6.6), and the tag of the
/// fillet's `created` faces sees its 12 blends and 8 corners.
#[test]
fn documents_with_the_phase_c_feature_types_load_and_evaluate() {
    assert!(v1::UNIMPLEMENTED_FEATURE_TYPES.is_empty());
    assert!(v1::load(&fillet_doc()).is_ok());
    let r = run(&fillet_doc());
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    let f1 = feature(&r, "f1");
    let fl = f1.fillet.as_ref().expect("fillet block");
    assert_eq!(fl.edges.len(), 12);
    assert_eq!(fl.faces_created.len(), 20);
    assert_eq!(f1.bodies.len(), 1);
    assert_eq!(
        serde_json::to_value(f1.bodies[0].change).unwrap(),
        json!("modified")
    );
    // Steiner: an 18 x 18 x 3 core grown by r = 1.
    let (x, y, z, rr) = (18.0_f64, 18.0_f64, 3.0_f64, 1.0_f64);
    let pi = std::f64::consts::PI;
    let want = x * y * z
        + 2.0 * (x * y + y * z + z * x) * rr
        + pi * (x + y + z) * rr * rr
        + 4.0 / 3.0 * pi * rr.powi(3);
    assert!(
        close(f1.bodies[0].volume, want, 1e-9),
        "{}",
        f1.bodies[0].volume
    );
    assert_eq!(f1.bodies[0].face_types.get("sphere"), Some(&8));
    // The tag of the fillet's created faces (`any`): 12 cylinders and 8 sphere corners.
    let t1 = feature(&r, "t1");
    assert_eq!(t1.refs[0].members.len(), 20);
    // The rest of the timeline runs on the filleted body.
    assert_eq!(code(&r, "e2"), None);
    assert_eq!(part_volumes(&r).len(), 2);
    // A document built without `load` evaluates the same (only `draft` is unsupported).
    let d = forge_ir::v1::from_json(&fillet_doc()).expect("valid IR v1");
    let direct = v1::report(&v1::evaluate(&d), "forge test", "t", None);
    assert_eq!(
        serde_json::to_string(&direct).unwrap(),
        serde_json::to_string(&r).unwrap()
    );
}

/// The implemented, unimplemented and rejected (optional) types partition the v1 feature types.
#[test]
fn feature_types_are_partitioned_into_implemented_unimplemented_and_rejected() {
    let mut all: Vec<&str> = v1::SUPPORTED_FEATURE_TYPES
        .iter()
        .chain(&v1::UNIMPLEMENTED_FEATURE_TYPES)
        .chain(&v1::REJECTED_FEATURE_TYPES)
        .copied()
        .collect();
    let n = all.len();
    all.sort_unstable();
    all.dedup();
    assert_eq!(all.len(), n, "overlap");
    let mut want = forge_ir::v1::FEATURE_TYPES.to_vec();
    want.sort_unstable();
    assert_eq!(all, want);
}

/// Every canonical v1 example program (`corpus/v1/programs`): a program that uses an
/// unimplemented type is rejected with exactly one `UNSUPPORTED_FEATURE_VERSION` per such
/// feature (none since Phase C), and every other program evaluates (`knob_queries` and
/// `plate_features` since Phase C, `shell_box` with its draft since the draft).
#[test]
fn corpus_programs_with_unimplemented_types_list_every_one() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../corpus/v1/programs");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    let mut rejected = 0;
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap();
        let raw: Value = serde_json::from_str(&text).unwrap();
        let mut want: Vec<(String, String)> = Vec::new();
        for (pi, p) in raw["parts"].as_array().unwrap().iter().enumerate() {
            for (fi, x) in p["features"].as_array().unwrap().iter().enumerate() {
                let ty = x["type"].as_str().unwrap();
                if v1::UNIMPLEMENTED_FEATURE_TYPES.contains(&ty) {
                    want.push((
                        "UNSUPPORTED_FEATURE_VERSION".into(),
                        format!("/parts/{pi}/features/{fi}/v"),
                    ));
                } else if v1::REJECTED_FEATURE_TYPES.contains(&ty) {
                    want.push((
                        "UNSUPPORTED_FEATURE".into(),
                        format!("/parts/{pi}/features/{fi}/type"),
                    ));
                }
            }
        }
        let (r, ev) = v1::evaluate_text(&text, "forge test", "t");
        let mut got = problems(&r);
        got.sort();
        want.sort();
        assert_eq!(got, want, "{}", f.display());
        assert_eq!(ev.is_none(), !want.is_empty(), "{}", f.display());
        rejected += usize::from(!want.is_empty());
    }
    assert_eq!(rejected, 0, "every corpus program evaluates");
}

#[test]
fn v0_documents_load_through_the_migration() {
    let v0 = r#"{"schema":"aicad.ir/0","meta":{"name":"m"},"parts":[{"id":"p1","name":"p",
        "features":[{"type":"sketch","id":"s1","name":"base","plane":"XY","curves":[
        {"kind":"circle","id":"c","center":[0,0],"radius":2}]},
        {"type":"extrude","id":"e1","name":"disc","sketch":"base","distance":3}]}]}"#;
    let l = v1::load(v0).expect("v0 loads");
    assert!(l.migration.as_ref().unwrap().renames.is_empty());
    let (r, _) = v1::evaluate_text(v0, "forge test", "m");
    assert_eq!(r.schema, "aicad.metrics/1");
    assert!(r.migration.is_none());
    assert_eq!(r.features[1].feature, "disc");
    assert_eq!(r.features[1].bodies[0].origin.feature, "e1");
    assert!(close(
        r.features[1].bodies[0].volume,
        std::f64::consts::PI * 12.0,
        1e-12
    ));
}

#[test]
fn rejected_documents_get_a_v1_report_listing_every_problem() {
    let (r, ev) = v1::evaluate_text(
        &doc(
            json!([{ "name": "a", "unit": "mm", "value": "nope + 1" }]),
            json!([extrude("e1", "missing", json!(1))]),
        ),
        "forge test",
        "t",
    );
    assert!(ev.is_none());
    assert_eq!(r.status, Status::Error);
    let e = r.error.as_ref().unwrap();
    let errors = e.details["errors"].as_array().unwrap();
    assert!(errors.len() >= 2, "{errors:?}");
    assert!(errors.iter().any(|x| x["code"] == "EXPR_UNKNOWN_NAME"));
    assert!(r.features.is_empty() && r.parts.is_empty());
    let (r, ev) = v1::evaluate_text("{ nope", "forge test", "t");
    assert!(ev.is_none());
    assert_eq!(r.error.unwrap().code, "IR_PARSE_ERROR");
}

#[test]
fn the_report_validates_against_the_frozen_metrics_schema_types() {
    // Round trip through the frozen I5 types (deny_unknown_fields everywhere).
    let text = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../corpus/v1/programs/plate_features.json"),
    )
    .unwrap();
    let (r, _) = v1::evaluate_text(&text, "forge test", "t");
    let s = serde_json::to_string(&r).unwrap();
    // Read with the correctly rounded v1 reader (serde_json's own parser is off by one ulp on
    // some 17-digit decimals, SPEC-v1 [W0-11]).
    let value = forge_ir::v1::json::parse(&s).expect("JSON");
    let back: EvalReport = serde_json::from_value(value).expect("a valid aicad.metrics/1 report");
    assert_eq!(serde_json::to_string(&back).unwrap(), s);
}

// ---- properties ---------------------------------------------------------------------------------

#[cfg(not(target_family = "wasm"))]
mod props {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig { cases: 12, ..ProptestConfig::default() })]

        /// SPEC-v1 §6.0.3: `vol(A ∪ B) + vol(A ∩ B) = vol A + vol B` and
        /// `vol(A − B) + vol(A ∩ B) = vol A` for axis-aligned boxes placed at random, through
        /// the whole pipeline (parameters, sketches on explicit frames, booleans, metrics).
        #[test]
        fn boolean_volume_identities_hold_end_to_end(
            (ax, ay, aw, ah, ad) in (-5i32..5, -5i32..5, 2i32..12, 2i32..12, 2i32..9),
            (bx, by, bz, bw, bh, bd) in (-5i32..5, -5i32..5, -3i32..6, 2i32..12, 2i32..12, 2i32..9),
        ) {
            let f = |x: i32| f64::from(x) + 0.25;
            let va = f(aw) * f(ah) * f(ad);
            let vb = f(bw) * f(bh) * f(bd);
            let mut vols = std::collections::BTreeMap::new();
            for op in ["join", "cut", "intersect"] {
                let r = run(&doc(json!([]), json!([
                    rect_sketch("sa", json!("XY"), json!(f(ax)), json!(f(ay)), json!(f(aw)), json!(f(ah))),
                    extrude("ea", "sa", json!(f(ad))),
                    rect_sketch("sb", json!({ "origin": [0, 0, f(bz)], "normal": [0, 0, 1], "x_dir": [1, 0, 0] }),
                                json!(f(bx)), json!(f(by)), json!(f(bw)), json!(f(bh))),
                    { "type": "extrude", "id": "eb", "name": "eb", "sketch": "sb", "distance": f(bd),
                      "op": op, "targets": "all" }
                ])));
                let eb = feature(&r, "eb");
                // Loud failures are allowed (no intersection, empty intersection, touching
                // boxes); a returned body is never wrong.
                if eb.status == Status::Ok {
                    prop_assert!(r.parts[0].bodies.iter().all(|b| b.valid));
                    vols.insert(op, part_volumes(&r).iter().sum::<f64>());
                }
            }
            let tol = 1e-9 * (va + vb);
            if let (Some(j), Some(i)) = (vols.get("join"), vols.get("intersect")) {
                prop_assert!((j + i - va - vb).abs() <= tol, "join {j} + inter {i} vs {}", va + vb);
            }
            if let (Some(c), Some(i)) = (vols.get("cut"), vols.get("intersect")) {
                prop_assert!((c + i - va).abs() <= tol, "cut {c} + inter {i} vs {va}");
            }
        }

        /// Parameters drive geometry exactly: the plate's volume is `w·h·t` for any values.
        #[test]
        fn parameter_values_drive_the_geometry(w in 1.0f64..200.0, h in 1.0f64..200.0, t in 0.5f64..50.0) {
            let r = run(&doc(
                json!([
                    { "name": "w", "unit": "mm", "value": w },
                    { "name": "h", "unit": "mm", "value": h },
                    { "name": "t", "unit": "mm", "value": t }
                ]),
                json!([
                    rect_sketch("s1", json!("XY"), json!(0), json!(0), json!("w"), json!("h")),
                    extrude("e1", "s1", json!("t"))
                ]),
            ));
            prop_assert_eq!(r.status, Status::Ok);
            let v = part_volumes(&r)[0];
            prop_assert!(close(v, w * h * t, 1e-12), "{v} vs {}", w * h * t);
        }
    }
}

// ---- invariants -----------------------------------------------------------------------------------

/// SPEC-v1 §5.2 rule 3: after every sweep the part's keys are complete and unique (forge-refs'
/// invariant checker), for every committed v0 program evaluated through its migration and the
/// v1 programs without body operations.
#[test]
fn the_key_invariant_holds_after_every_sweep() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../corpus");
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(root.join("programs"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.push(root.join("v1/programs/params_plate.json"));
    files.push(root.join("v1/programs/constrained_plate.json"));
    files.push(root.join("v1/programs/knob_queries.json"));
    files.sort();
    let mut checked = 0;
    for f in files {
        // Through `from_json` (no engine capability check). Since Phase C `knob_queries`' hole
        // and body pattern evaluate too, so their tool faces and copies are checked as well.
        let d = forge_ir::v1::from_json(&std::fs::read_to_string(&f).unwrap()).expect("valid IR");
        let (ev, problems) = v1::evaluate_with_key_check(&d);
        assert!(
            problems.is_empty(),
            "{}: key problems {problems:#?}",
            f.display()
        );
        checked += ev.parts.iter().map(|p| p.bodies.len()).sum::<usize>();
    }
    assert!(checked >= 10, "{checked}");
}

/// The key invariant after body operations: reported for the record (SPEC-v1 §5.2 rule 3 and
/// the W3/W4 contract issue on alias sources), and never a reason to fail the feature.
#[test]
fn key_problems_after_booleans_are_diagnostics_not_failures() {
    let mut f = two_boxes();
    f.push(
        json!({ "type": "extrude", "id": "eb", "name": "eb", "sketch": "sb", "distance": 10,
                   "op": "join", "targets": "all" }),
    );
    let l = v1::load(&doc(json!([]), Value::Array(f))).unwrap();
    let (ev, problems) = v1::evaluate_with_key_check(&l.doc);
    assert!(ev.is_ok());
    eprintln!("key problems after a join: {problems:#?}");
}

// ---- oracle comparison cases ---------------------------------------------------------------------

/// The integration's oracle cases (`tests/v1_programs/*.json`, diffed with `oracle diff
/// forge/crates/forge-regen/tests/v1_programs --forge-bin …`): every program evaluates, only
/// the documented failures fail, every body is valid, and the key invariant holds.
///
/// The programs the oracle does not classify `MATCH` are tracked, with their diagnosis and
/// owner, in `tests/v1_oracle_known_differences.json` (checked against a live oracle by
/// `forge-cli`'s ignored `oracle_gate` test); this test checks that every program listed there
/// exists.
#[test]
fn the_oracle_comparison_programs_evaluate_as_documented() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/v1_programs");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    assert!(files.len() >= 22, "{}", files.len());
    let known: Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/v1_oracle_known_differences.json"),
        )
        .unwrap(),
    )
    .unwrap();
    for k in known["programs"].as_array().unwrap() {
        let name = k["program"].as_str().unwrap();
        assert!(
            files.iter().any(|f| f.file_stem().unwrap() == name),
            "known difference {name} has no program"
        );
    }
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap();
        let r = run(&text);
        let name = f.file_stem().unwrap().to_string_lossy().into_owned();
        let failed: Vec<(&str, &str)> = r
            .features
            .iter()
            .filter_map(|x| {
                x.error
                    .as_ref()
                    .map(|e| (x.feature_id.as_str(), e.code.as_str()))
            })
            .collect();
        let expected: &[(&str, &str)] = match name.as_str() {
            "failures_pass_through" => &[
                ("e1", "INVALID_DISTANCE"),
                ("t1", "REF_CARDINALITY"),
                ("e3", "BOOLEAN_NO_INTERSECTION"),
            ],
            "errors_tag_dependencies" => &[
                ("t1", "REF_MISSING"),
                ("e2", "DEPENDENCY_FAILED"),
                ("e3", "DEPENDENCY_SUPPRESSED"),
                ("e4", "DEPENDENCY_FAILED"),
                ("e5", "INVALID_DISTANCE"),
                ("s3", "DEPENDENCY_FAILED"),
            ],
            "errors_expressions" => &[
                ("e1", "PARAM_FAILED"),
                ("r1", "INVALID_ANGLE"),
                ("s2", "INVALID_VALUE"),
                ("s3", "SKETCH_INVALID_DIMENSION"),
                ("s4", "EXPR_NOT_INTEGER"),
            ],
            "errors_dependencies" => &[
                ("e0", "SKETCH_SUPPRESSED"),
                ("s1", "SKETCH_OPEN_LOOP"),
                ("e1", "DEPENDENCY_FAILED"),
                ("d1", "DATUM_DEGENERATE"),
                ("s3", "DEPENDENCY_FAILED"),
                ("t1", "DEPENDENCY_FAILED"),
                ("t2", "REF_MISSING"),
                ("t3", "REF_CARDINALITY"),
            ],
            "errors_geometry" => &[
                ("s2", "PLANE_NOT_PLANAR"),
                ("a1", "AXIS_REF_UNSUPPORTED"),
                ("e3", "BOOLEAN_EMPTY_RESULT"),
                ("b1", "BOOLEAN_TOOL_IS_TARGET"),
                ("e4", "BOOLEAN_NO_INTERSECTION"),
            ],
            // A cap is not square to the pull direction (§6.9).
            "draft_walls" => &[("d4", "DRAFT_FACE_UNSUPPORTED")],
            _ => &[],
        };
        assert_eq!(failed, expected, "{name}");
        assert!(
            r.parts.iter().flat_map(|p| &p.bodies).all(|b| b.valid),
            "{name}"
        );
        // The key invariant (§5.2 rule 3). Known open contract issue (W3/W4 CONTRACT ISSUES):
        // after a same-domain merge, edges keep the merged-away face key as a source (an alias
        // of the surviving face) and forge-refs' checker reports it; every other problem fails.
        let l = v1::load(&text).unwrap();
        let (_, problems) = v1::evaluate_with_key_check(&l.doc);
        // Second known contract issue (W0/W3/W4): the pocket walls of
        // `torus_pocket_spiric_edges` meet the torus and the inner cylinder along two disjoint
        // curves each, and both edges get the one key `G/edge:{A|B}` of §5.2 rule 3; forge-refs'
        // checker only accepts a shared key for split pieces of one carrier.
        // Third, a forge-refs checker false positive (reported to W3; the same exclusion as in
        // `v1_phase_c.rs`): the faces of one hole's positions (`h6/wall@1`, `h6/wall@2`, …) or
        // of one pattern's instances differ only by their qualifier and share a display name
        // (`h6/wall`), which the checker flags as ambiguous edge sources although the tools and
        // copies stamp their edge sources by key (an edge naming a source that is not a face
        // would be its own finding). Excluded only for the names of hole and pattern features.
        let raw: Value = serde_json::from_str(&text).unwrap();
        let multi: Vec<String> = raw["parts"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|p| p["features"].as_array().unwrap())
            .filter(|x| matches!(x["type"].as_str(), Some("hole" | "pattern")))
            .map(|x| format!(": {}/", x["id"].as_str().unwrap()))
            .collect();
        let other: Vec<&String> = problems
            .iter()
            .filter(|p| !p.ends_with("is not a face of the body"))
            .filter(|p| {
                !(name == "torus_pocket_spiric_edges"
                    && p.ends_with("share the key on different carriers (not split pieces)"))
            })
            .filter(|p| {
                !(p.ends_with(
                    "several faces of the body carry this name; edge sources are ambiguous",
                ) && multi.iter().any(|m| p.contains(m.as_str())))
            })
            .collect();
        assert!(other.is_empty(), "{name}: {other:#?}");
    }
}

/// §5.7–§5.8: a captured member whose key no longer exists falls back geometrically; the
/// report carries the resolution (member statuses, probes, warnings) or, when the match is not
/// geometry-identical, the failure with ranked candidates, each with a probe and a query.
#[test]
fn captured_references_repair_or_fail_with_candidates() {
    let capture = |size: f64, hw: f64| {
        json!({ "members": [{ "key": "e1/side:gone", "via": "named", "geom": {
            "type": "plane", "carrier": { "plane": { "normal": [0, 1, 0], "offset": 5 } },
            "bbox": [[-hw, 5, 0], [hw, 5, 5]], "size": size, "centroid": [0, 5, 2.5],
            "local": [0.5, 1, 0.5], "body_center": [0, 0, 2.5], "neighbors": 0 } }] })
    };
    let with = |cap: Value| {
        doc(
            json!([]),
            json!([
                rect_sketch("s1", json!("XY"), json!(0), json!(0), json!(20), json!(10)),
                extrude("e1", "s1", json!(5)),
                { "type": "tag", "id": "t1", "name": "t1", "target": { "kind": "face",
                  "q": { "op": "filter", "of": { "op": "sides", "feature": "e1" },
                         "where": { "normal": "+Y" } },
                  "capture": cap } }
            ]),
        )
    };
    // Geometry-identical: repaired and used (REF_REPAIRED, with a proposal).
    let r = run(&with(capture(100.0, 10.0)));
    let t1 = feature(&r, "t1");
    assert_eq!(t1.status, Status::Ok);
    let codes: Vec<&str> = t1.warnings.iter().map(|w| w.code.as_str()).collect();
    assert!(codes.contains(&"REF_REPAIRED"), "{codes:?}");
    assert_eq!(t1.refs[0].members.len(), 1);
    assert_eq!(t1.refs[0].members[0].key, "e1/side:r.top");
    // Resized (the face was 18 mm wide): not identical, so the feature fails with candidates.
    let r = run(&with(capture(90.0, 9.0)));
    let t1 = feature(&r, "t1");
    assert_eq!(t1.status, Status::Error);
    let e = t1.error.as_ref().unwrap();
    assert!(e.code.starts_with("REF_"), "{}", e.code);
    let unresolved = &t1.refs[0].unresolved;
    assert!(!unresolved.is_empty());
    let c = &unresolved[0].candidates[0];
    assert_eq!(c.key, "e1/side:r.top");
    assert!(
        c.query.is_some(),
        "a synthesized query selects the candidate"
    );
    assert!(close(c.probe.point[1], 5.0, 0.0));
}

// ---- the optional `draft` (§6.9) ------------------------------------------------------------------

fn draft_doc(angle: Value) -> String {
    draft_doc_with(angle, json!("XY"), json!({}))
}

fn draft_doc_with(angle: Value, neutral: Value, extra: Value) -> String {
    let mut d = json!({ "type": "draft", "id": "d1", "name": "d1",
        "faces": { "kind": "face", "q": { "op": "sides", "feature": "e1" } },
        "neutral": neutral, "angle": angle });
    for (k, v) in extra.as_object().unwrap() {
        d[k] = v.clone();
    }
    doc(
        json!([{ "name": "a", "unit": "deg", "value": 3 }]),
        json!([
            rect_sketch("s1", json!("XY"), json!(0), json!(0), json!(20), json!(20)),
            extrude("e1", "s1", json!(10)),
            d
        ]),
    )
}

/// `code, path` of every rejection listed in a rejected report.
fn rejections(r: &EvalReport) -> Vec<(String, String)> {
    let e = r.error.as_ref().expect("a rejected document");
    let mut v: Vec<(String, String)> = e.details["errors"]
        .as_array()
        .expect("details.errors")
        .iter()
        .map(|x| {
            (
                x["code"].as_str().unwrap().to_string(),
                x["path"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    v.sort();
    v
}

/// A 20 × 20 × 10 box drafted all round by `a` degrees about its base: `A·h − P·k·h²/2 +
/// 4·k²·h³/3` with `k = tan(a)` (mitred right corners).
fn drafted_box_volume(a: f64) -> f64 {
    let (s, c) = forge_core::math::sin_cos_deg(a);
    let k = s / c;
    400.0 * 10.0 - 80.0 * k * 100.0 / 2.0 + 4.0 * k * k * 1000.0 / 3.0
}

#[test]
fn a_draft_tapers_the_walls_about_its_neutral_plane() {
    let r = run(&draft_doc(json!(3)));
    assert_eq!(code(&r, "d1"), None, "{:#?}", feature(&r, "d1").error);
    assert!(close(part_volumes(&r)[0], drafted_box_volume(3.0), 1e-11));
    let e = feature(&r, "d1");
    assert_eq!(e.bodies.len(), 1);
    assert_eq!(
        serde_json::to_value(e.bodies[0].change).unwrap(),
        json!("modified")
    );
    assert_eq!(e.bodies[0].faces, 6);
    // A parameter expression drives the angle; the reference resolves every side exactly.
    let r = run(&draft_doc(json!("a * 2")));
    assert!(close(part_volumes(&r)[0], drafted_box_volume(6.0), 1e-11));
    assert_eq!(feature(&r, "d1").refs.len(), 1);
    // The neutral plane at the top keeps the top outline (the walls grow outward below);
    // pulling the other way about the base does the same.
    let top = json!({ "origin": [0, 0, 10], "normal": [0, 0, 1], "x_dir": [1, 0, 0] });
    let r = run(&draft_doc_with(json!(3), top, json!({})));
    let (s, c) = forge_core::math::sin_cos_deg(3.0);
    let k = s / c;
    let grown = 4000.0 + 80.0 * k * 100.0 / 2.0 + 4.0 * k * k * 1000.0 / 3.0;
    assert!(close(part_volumes(&r)[0], grown, 1e-11));
    let r = run(&draft_doc_with(
        json!(3),
        json!("XY"),
        json!({ "pull": "reverse" }),
    ));
    assert!(close(part_volumes(&r)[0], grown, 1e-11));
}

#[test]
fn draft_failures_are_explicit() {
    // A literal angle out of (0, 45) is a rejection; an expression one fails the feature.
    let (r, ev) = v1::evaluate_text(&draft_doc(json!(50)), "forge test", "t");
    assert!(ev.is_none());
    assert_eq!(
        rejections(&r),
        vec![(
            "INVALID_VALUE".to_string(),
            "/parts/0/features/2/angle".to_string()
        )]
    );
    let r = run(&draft_doc(json!("a * 20")));
    assert_eq!(code(&r, "d1"), Some("INVALID_VALUE"));
    assert!(
        close(part_volumes(&r)[0], 4000.0, 1e-12),
        "passes its input through"
    );
    // The caps are not walls of this pull direction.
    let caps =
        json!({ "faces": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } } });
    let r = run(&draft_doc_with(json!(3), json!("XY"), caps));
    assert_eq!(code(&r, "d1"), Some("DRAFT_FACE_UNSUPPORTED"));
    // Walls next to a round corner are not drafted (draft before filleting).
    let text = doc(
        json!([]),
        json!([
            rect_sketch("s1", json!("XY"), json!(0), json!(0), json!(20), json!(20)),
            extrude("e1", "s1", json!(10)),
            { "type": "fillet", "id": "f1", "name": "f1", "r": 2,
              "edges": { "kind": "edge", "q": { "op": "filter", "where": { "parallel": "Z" },
                         "of": { "op": "edges", "of": { "op": "sides", "feature": "e1" } } } } },
            { "type": "draft", "id": "d1", "name": "d1",
              "faces": { "kind": "face", "q": { "op": "filter", "where": { "type": "plane" },
                         "of": { "op": "sides", "feature": "e1" } } },
              "neutral": "XY", "angle": 3 }
        ]),
    );
    let r = run(&text);
    assert_eq!(code(&r, "d1"), Some("DRAFT_FAILED"));
    assert!(
        feature(&r, "d1")
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("curved"),
        "{:?}",
        feature(&r, "d1").error
    );
}

/// §5.2: drafted entities keep their keys. A side–side junction edge's `@c.end` qualifier is
/// derived from the sketch junction its carrier passes through; about a neutral plane off the
/// sketch plane the tilted edge no longer does, so the draft carries the input's qualifier over:
/// the key invariant holds, and a tag on a vertical edge still resolves to it after the draft.
#[test]
fn a_draft_off_the_sketch_plane_keeps_the_junction_edge_keys() {
    let mid = json!({ "origin": [0, 0, 6], "normal": [0, 0, 1], "x_dir": [1, 0, 0] });
    for neutral in [json!("XY"), mid] {
        let text = draft_doc_with(json!(4), neutral.clone(), json!({}));
        let l = v1::load(&text).unwrap();
        let (ev, problems) = v1::evaluate_with_key_check(&l.doc);
        assert!(ev.is_ok(), "{neutral}");
        assert!(problems.is_empty(), "{neutral}: {problems:#?}");
        // A tag after the draft on the edge between the bottom and right sides (by its faces).
        let mut v: Value = serde_json::from_str(&text).unwrap();
        v["parts"][0]["features"]
            .as_array_mut()
            .unwrap()
            .push(json!(
                { "type": "tag", "id": "t1", "name": "t1", "target": { "kind": "edge", "q": {
                    "op": "between", "a": { "op": "side", "feature": "e1", "curve": "r.bottom" },
                    "b": { "op": "side", "feature": "e1", "curve": "r.right" } }, "card": "one" } }
            ));
        let r = run(&v.to_string());
        assert_eq!(
            code(&r, "t1"),
            None,
            "{neutral}: {:#?}",
            feature(&r, "t1").error
        );
        let key = &feature(&r, "t1").refs[0].members[0].key;
        assert!(
            key.contains('@'),
            "{neutral}: the junction qualifier is kept: {key}"
        );
    }
}

/// A document built without `load` evaluates the draft the same way (`load` rejects nothing
/// for it any more: [`v1::REJECTED_FEATURE_TYPES`] is empty).
#[test]
fn a_draft_evaluates_the_same_through_load_or_not() {
    assert!(v1::REJECTED_FEATURE_TYPES.is_empty());
    assert!(v1::SUPPORTED_FEATURE_TYPES.contains(&"draft"));
    let d = forge_ir::v1::from_json(&draft_doc(json!(3))).expect("valid IR v1");
    let direct = v1::report(&v1::evaluate(&d), "forge test", "t", None);
    let r = run(&draft_doc(json!(3)));
    assert_eq!(
        serde_json::to_string(&direct).unwrap(),
        serde_json::to_string(&r).unwrap()
    );
    // The committed conformance program with a draft evaluates. Its draft takes every side of
    // a rounded box, whose round corners are not planar: SPEC-v1 §6.9 drafts planar faces only
    // (the oracle says the same), so the draft fails and passes the shelled box through.
    let text = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../corpus/v1/programs/shell_box.json"),
    )
    .unwrap();
    let r = run(&text);
    assert_eq!(code(&r, "dr1"), Some("DRAFT_FACE_UNSUPPORTED"));
    assert_eq!(code(&r, "sh1"), None);
}

// ---- §7.1 step 2: tags (and seeds) are dependencies by id -----------------------------------------

/// p = 5; t1 fails (REF_MISSING), t2 is suppressed, t3 is ok. An extrude whose targets name the
/// tag and whose distance `p - 10` fails its range check.
fn tag_dependency_doc(tag: &str, distance: &str) -> String {
    doc(
        json!([{ "name": "p", "unit": "mm", "value": 5 },
               { "name": "bad", "unit": "mm", "value": "sqrt((p - 10) * 1 mm)" }]),
        json!([
            rect_sketch("s1", json!("XY"), json!(0), json!(0), json!(20), json!(20)),
            extrude("e1", "s1", json!(10)),
            { "type": "tag", "id": "t1", "name": "t1", "target": { "kind": "face",
              "q": { "op": "filter", "of": { "op": "sides", "feature": "e1" }, "where": { "type": "cylinder" } } } },
            { "type": "tag", "id": "t2", "name": "t2", "suppressed": true, "target": { "kind": "face",
              "q": { "op": "filter", "of": { "op": "sides", "feature": "e1" }, "where": { "normal": "+X" } } } },
            { "type": "tag", "id": "t3", "name": "t3", "target": { "kind": "face",
              "q": { "op": "filter", "of": { "op": "sides", "feature": "e1" }, "where": { "normal": "+X" } } } },
            rect_sketch("s2", json!("XY"), json!(0), json!(0), json!(4), json!(4)),
            { "type": "extrude", "id": "e2", "name": "e2", "sketch": "s2", "distance": distance,
              "op": "cut", "targets": { "kind": "body",
                "q": { "op": "owner", "of": { "op": "tagged", "feature": tag } } } }
        ]),
    )
}

#[test]
fn a_failed_or_suppressed_tag_decides_the_code_before_range_checks() {
    // Every combination of the tag's state and the distance's outcome (§7.1 step 2 order:
    // PARAM_FAILED → dependencies by id → field expressions and range checks).
    for (tag, distance, want) in [
        ("t1", "p - 10", Some("DEPENDENCY_FAILED")),
        ("t2", "p - 10", Some("DEPENDENCY_SUPPRESSED")),
        ("t3", "p - 10", Some("INVALID_DISTANCE")),
        ("t1", "p", Some("DEPENDENCY_FAILED")),
        ("t2", "p", Some("DEPENDENCY_SUPPRESSED")),
        ("t3", "p", None),
        ("t1", "bad", Some("PARAM_FAILED")),
        ("t2", "bad", Some("PARAM_FAILED")),
        ("t3", "bad", Some("PARAM_FAILED")),
    ] {
        let r = run(&tag_dependency_doc(tag, distance));
        assert_eq!(code(&r, "e2"), want, "{tag}, {distance}");
        if let Some(e) = &feature(&r, "e2").error {
            match e.code.as_str() {
                "DEPENDENCY_FAILED" => {
                    assert_eq!(e.details["feature"], json!("t1"));
                    assert_eq!(e.details["code"], json!("REF_MISSING"));
                    assert!(e.details["message"].is_string());
                }
                "DEPENDENCY_SUPPRESSED" => assert_eq!(e.details["feature"], json!("t2")),
                _ => {}
            }
            // Nothing past the failing check ran: no reference was resolved.
            if e.code.starts_with("DEPENDENCY_") {
                assert!(feature(&r, "e2").refs.is_empty());
            }
        }
    }
}

#[test]
fn a_tag_in_a_sketch_plane_or_a_datum_is_a_dependency_by_id() {
    let r = run(&doc(
        json!([]),
        json!([
            rect_sketch("s1", json!("XY"), json!(0), json!(0), json!(20), json!(20)),
            extrude("e1", "s1", json!(10)),
            { "type": "tag", "id": "t1", "name": "t1", "target": { "kind": "face",
              "q": { "op": "filter", "of": { "op": "sides", "feature": "e1" }, "where": { "type": "cylinder" } } } },
            rect_sketch("s2", json!({ "face": { "kind": "face", "q": { "op": "tagged", "feature": "t1" } } }),
                        json!(0), json!(0), json!(2), json!(2)),
            { "type": "datum_plane", "id": "d1", "name": "d1", "mode": "offset",
              "from": { "face": { "kind": "face", "q": { "op": "tagged", "feature": "t1" } } },
              "distance": 3 }
        ]),
    ));
    for id in ["s2", "d1"] {
        let e = feature(&r, id).error.as_ref().unwrap();
        assert_eq!(e.code, "DEPENDENCY_FAILED", "{id}");
        assert_eq!(e.details["feature"], json!("t1"), "{id}");
    }
}

/// A pattern's seeds are dependencies by id too (§7.1 step 2): a failed seed decides the code
/// (`DEPENDENCY_FAILED` naming it) before anything of the pattern is evaluated; a pattern of a
/// good `new_body` seed creates one body per non-seed instance (origin `{ pattern, member,
/// instance }`, §5.2 rule 4).
#[test]
fn a_failed_pattern_seed_is_dependency_failed() {
    let text = doc(
        json!([]),
        json!([
            rect_sketch("s1", json!("XY"), json!(0), json!(0), json!(20), json!(20)),
            extrude("e1", "s1", json!(10)),
            rect_sketch("s2", json!("XY"), json!(0), json!(0), json!(2), json!(2)),
            extrude("e2", "s2", json!("0 mm")),
            extrude("e3", "s2", json!(1)),
            { "type": "pattern", "id": "pt1", "name": "pt1", "seed": { "features": ["e3", "e2"] },
              "layout": { "linear": { "dir": "+X", "count": 3, "spacing": 5 } } },
            { "type": "pattern", "id": "pt2", "name": "pt2", "seed": { "features": ["e3"] },
              "layout": { "linear": { "dir": "+X", "count": 3, "spacing": 5 } } }
        ]),
    );
    assert!(v1::load(&text).is_ok());
    let r = run(&text);
    assert_eq!(code(&r, "e2"), Some("INVALID_DISTANCE"));
    let e = feature(&r, "pt1").error.as_ref().unwrap();
    assert_eq!(e.code, "DEPENDENCY_FAILED");
    assert_eq!(e.details["feature"], json!("e2"));
    let pt2 = feature(&r, "pt2");
    assert_eq!(code(&r, "pt2"), None);
    assert_eq!(pt2.pattern.as_ref().unwrap().instances, 2);
    let got: Vec<(String, Option<Vec<u32>>, f64)> = pt2
        .bodies
        .iter()
        .map(|b| {
            (
                b.origin.feature.clone(),
                b.origin.instance.clone(),
                b.volume,
            )
        })
        .collect();
    assert_eq!(got.len(), 2, "{got:?}");
    for (k, (f, i, v)) in got.iter().enumerate() {
        assert_eq!(f, "pt2");
        assert_eq!(i.as_deref(), Some(&[k as u32 + 1][..]));
        assert!(close(*v, 4.0, 1e-12), "{v}");
    }
}

// ---- body operations that change nothing, re-joined split pieces, seams ------------------------------

fn program(name: &str) -> String {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(format!("tests/v1_programs/{name}.json")),
    )
    .unwrap()
}

/// [W0-39] (SPEC-v1 §6.0.3, §6.0.5): a join whose tools lie inside (or equal) the target
/// **acts on** it — the target is listed as `modified` (geometry unchanged), nothing is
/// removed, and no `FORGE_BOOLEAN_NO_CHANGE` note is raised (that note is for targets a join
/// or cut does not act on). The pre-ruling outcome (no body listed, the note) changed with
/// W4's [W0-39] alignment; `v1_golden_hash.rs` records the update.
#[test]
fn a_join_whose_tools_lie_inside_the_target_modifies_it() {
    for (name, ids) in [
        ("join_nested_tool", &["e2", "e3"][..]),
        ("join_identical_tool", &["e2"][..]),
    ] {
        let r = run(&program(name));
        assert_eq!(r.status, Status::Ok, "{name}");
        for id in ids {
            let f = feature(&r, id);
            assert_eq!(f.bodies.len(), 1, "{name}/{id}");
            let b = &f.bodies[0];
            assert_eq!(
                serde_json::to_value(b.change).unwrap(),
                json!("modified"),
                "{name}/{id}"
            );
            assert_eq!(
                serde_json::to_value(&b.origin).unwrap(),
                json!({ "feature": "e1", "member": "r.bottom" })
            );
            assert!(close(b.volume, 4000.0, 1e-12), "{name}/{id}: {}", b.volume);
            assert!(f.removed.is_empty(), "{name}/{id}");
            assert!(
                f.warnings.iter().all(|w| w.code != v1::NO_CHANGE_CODE),
                "{name}/{id}: {:?}",
                f.warnings
            );
        }
        let v = part_volumes(&r);
        assert!(v.len() == 1 && close(v[0], 4000.0, 1e-12), "{name}: {v:?}");
        let b = &r.parts[0].bodies[0];
        assert_eq!((b.faces, b.edges), (6, 12), "{name}");
    }
    // A join that changes its target has no such note either.
    let r = run(&program("boxes_join"));
    assert!(
        r.features
            .iter()
            .all(|f| f.warnings.iter().all(|w| w.code != v1::NO_CHANGE_CODE))
    );
}

/// A join that re-merges the two pieces of one split body: one body of that origin, and no
/// origin is `removed` (the absorbed piece has the survivor's origin). Closed forms: the bar
/// 40·10·10 − the slot 4·10·10 + the bridge between the pieces 4·4·10 = 3760; the H-shaped
/// result has 14 faces and 36 edges.
#[test]
fn a_join_of_split_pieces_is_one_body_and_removes_no_origin() {
    let r = run(&program("join_rejoins_split_pieces"));
    assert_eq!(r.status, Status::Ok);
    let e2 = feature(&r, "e2");
    assert_eq!(e2.bodies.len(), 2);
    assert_eq!(e2.warnings[0].code, "BOOLEAN_SPLIT");
    let e3 = feature(&r, "e3");
    assert_eq!(e3.refs[0].members.len(), 2);
    assert_eq!(e3.bodies.len(), 1);
    assert!(e3.removed.is_empty(), "{:?}", e3.removed);
    let b = &e3.bodies[0];
    assert_eq!(
        (b.origin.feature.as_str(), b.origin.member.as_str()),
        ("e1", "r.bottom")
    );
    assert!(close(b.volume, 3760.0, 1e-12), "{}", b.volume);
    assert_eq!((b.faces, b.edges, b.shells), (14, 36, 1));
    assert_eq!(b.face_types.get("plane"), Some(&14));
    assert_eq!(b.edge_types.get("line"), Some(&36));
    assert_eq!(r.parts[0].bodies.len(), 1);
}

/// A boss over the edge of a through hole: the hole's top circle and the boss's bottom circle
/// cut each other into two arcs; the seam-free topology (SPEC-v1 §6.0.4, v0 seam rule) is 10
/// faces (8 planes: the plate's 6, the boss top, the boss bottom over the hole; 2 cylinders)
/// and 18 edges (12 lines; circles: hole bottom, boss top, 2 + 2 arcs). The oracle must re-merge
/// OCCT's seam-split arcs to agree (§8.3 rule 1). Volume 40·40·10 − 9π·10 + 9π·5.
#[test]
fn a_boss_over_a_hole_edge_has_the_seam_free_topology() {
    let r = run(&program("seam_boss_over_hole"));
    assert_eq!(r.status, Status::Ok);
    let b = &feature(&r, "e2").bodies[0];
    assert_eq!((b.faces, b.edges, b.shells), (10, 18, 1));
    assert_eq!(b.face_types.get("plane"), Some(&8));
    assert_eq!(b.face_types.get("cylinder"), Some(&2));
    assert_eq!(b.edge_types.get("line"), Some(&12));
    assert_eq!(b.edge_types.get("circle"), Some(&6));
    let want = 16000.0 - 45.0 * std::f64::consts::PI;
    assert!(close(b.volume, want, 1e-12), "{} vs {want}", b.volume);
    assert!(b.valid);
}

/// A join whose tool reaches only one of its targets (`targets: "all"`): that target is
/// modified (10·10·10 + 4·4·3 = 1048; the boss adds 4 side faces and a top, 11 faces and 24
/// edges), the other stays as it was — in neither `bodies` nor `removed` (§6.0.5, as the oracle
/// reports it) — and the no-change note names it, although not every target was left alone.
/// A cut that misses one of its targets is reported the same way.
#[test]
fn targets_left_unchanged_are_named_by_the_no_change_note_even_when_others_change() {
    let r = run(&program("join_partial_targets"));
    assert_eq!(r.status, Status::Ok);
    let e3 = feature(&r, "e3");
    assert_eq!(e3.bodies.len(), 1);
    let b = &e3.bodies[0];
    assert_eq!(
        (b.origin.feature.as_str(), b.origin.member.as_str()),
        ("e1", "a.bottom")
    );
    assert!(close(b.volume, 1048.0, 1e-12), "{}", b.volume);
    assert_eq!((b.faces, b.edges, b.shells), (11, 24, 1));
    assert!(e3.removed.is_empty());
    let notes: Vec<_> = e3
        .warnings
        .iter()
        .filter(|w| w.code == v1::NO_CHANGE_CODE)
        .collect();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].severity, Severity::Info);
    assert_eq!(notes[0].details["op"], json!("join"));
    assert_eq!(
        notes[0].details["targets"],
        json!([{ "feature": "e2", "member": "b.bottom" }])
    );
    assert!(
        notes[0].message.contains("1 of its 2"),
        "{}",
        notes[0].message
    );
    // Both boxes are in the part: the modified one and the untouched one.
    let v = part_volumes(&r);
    assert!(
        v.len() == 2 && close(v[0], 1048.0, 1e-12) && close(v[1], 1000.0, 1e-12),
        "{v:?}"
    );

    let r = run(&doc(
        json!([]),
        json!([
            rect_sketch("s1", json!("XY"), json!(0), json!(0), json!(10), json!(10)),
            extrude("e1", "s1", json!(10)),
            rect_sketch("s2", json!("XY"), json!(30), json!(0), json!(10), json!(10)),
            extrude("e2", "s2", json!(10)),
            rect_sketch("s3", json!("XY"), json!(0), json!(0), json!(4), json!(4)),
            { "type": "extrude", "id": "e3", "name": "e3", "sketch": "s3", "distance": 3,
              "op": "cut", "targets": "all" }
        ]),
    ));
    let e3 = feature(&r, "e3");
    assert_eq!(e3.bodies.len(), 1);
    assert_eq!(e3.bodies[0].origin.feature, "e1");
    assert!(close(e3.bodies[0].volume, 1000.0 - 48.0, 1e-12));
    let note = e3
        .warnings
        .iter()
        .find(|w| w.code == v1::NO_CHANGE_CODE)
        .unwrap();
    assert_eq!(note.details["op"], json!("cut"));
    assert_eq!(
        note.details["targets"],
        json!([{ "feature": "e2", "member": "r.bottom" }])
    );
}

/// An intersect whose tool contains its target: the target is its own intersection, reported
/// `modified` (SPEC-v1 §6.0.3 intersects every target), with no no-change note — the case the
/// review suspected shared the unchanged-target path does not (oracle `MATCH`).
#[test]
fn an_intersect_whose_tool_contains_the_target_lists_it_as_modified() {
    let r = run(&program("intersect_target_inside_tool"));
    assert_eq!(r.status, Status::Ok);
    let e2 = feature(&r, "e2");
    assert_eq!(e2.bodies.len(), 1);
    let b = &e2.bodies[0];
    assert_eq!(b.origin.feature, "e1");
    assert_eq!(serde_json::to_value(b.change).unwrap(), json!("modified"));
    assert!(close(b.volume, 64.0, 1e-12), "{}", b.volume);
    assert_eq!((b.faces, b.edges), (6, 12));
    assert!(e2.removed.is_empty());
    assert!(e2.warnings.iter().all(|w| w.code != v1::NO_CHANGE_CODE));
}

/// A blind notch cut into the bottom rim of a disk (the generated-corpus case
/// `gen1_s41_00138` in closed form): 7 faces (6 planes, 1 cylinder), 13 edges (10 lines;
/// circles: top, bottom rim arc, notch arc), volume `500π − 2(2√96 + 100·asin 0.2 − 24)` (the
/// notch's cross-section under the arc, 2 mm high). The oracle splits the bottom rim arc at
/// OCCT's cylinder seam and must re-merge it (§8.3 rule 1).
#[test]
fn a_notch_in_a_disk_rim_has_the_seam_free_topology() {
    let r = run(&program("seam_notch_in_disk"));
    assert_eq!(r.status, Status::Ok);
    let b = &feature(&r, "e2").bodies[0];
    assert_eq!((b.faces, b.edges, b.shells), (7, 13, 1));
    assert_eq!(b.face_types.get("plane"), Some(&6));
    assert_eq!(b.face_types.get("cylinder"), Some(&1));
    assert_eq!(b.edge_types.get("line"), Some(&10));
    assert_eq!(b.edge_types.get("circle"), Some(&3));
    let notch = 2.0 * (2.0 * 96f64.sqrt() + 100.0 * 0.2f64.asin() - 24.0);
    let want = 500.0 * std::f64::consts::PI - notch;
    assert!(close(b.volume, want, 1e-12), "{} vs {want}", b.volume);
    assert!(b.valid);
}

fn body_of<'a>(
    r: &'a EvalReport,
    feature_id: &str,
    origin: &str,
) -> &'a forge_ir::v1::metrics::BodyReport {
    feature(r, feature_id)
        .bodies
        .iter()
        .find(|b| b.origin.feature == origin)
        .unwrap_or_else(|| panic!("{feature_id}: no body of origin {origin}"))
}

/// `(faces, edges, face types, edge types)` of a body.
type Topology = (u32, u32, Vec<(String, u32)>, Vec<(String, u32)>);

fn topology(b: &forge_ir::v1::metrics::BodyReport) -> Topology {
    (
        b.faces,
        b.edges,
        b.face_types.iter().map(|(k, v)| (k.clone(), *v)).collect(),
        b.edge_types.iter().map(|(k, v)| (k.clone(), *v)).collect(),
    )
}

fn counts(v: &[(&str, u32)]) -> Vec<(String, u32)> {
    v.iter().map(|(k, n)| ((*k).to_string(), *n)).collect()
}

/// A through notch into the wall of a through hole (the wall keeps one cylinder face across
/// the +x seam angle): 10 faces (9 planes, 1 cylinder), 24 edges (12 plate lines, 3 + 3 notch
/// outline lines on the caps, 4 vertical lines; the hole's 2 rim arcs). Volume
/// `16000 − 250π − 10·(14 − √24 − 25·asin 0.2)`. (Oracle `MATCH`.)
#[test]
fn a_notch_in_a_hole_wall_keeps_one_wall_face() {
    let r = run(&program("seam_notch_in_hole_wall"));
    let b = body_of(&r, "e2", "e1");
    assert_eq!(
        topology(b),
        (
            10,
            24,
            counts(&[("cylinder", 1), ("plane", 9)]),
            counts(&[("circle", 2), ("line", 22)])
        )
    );
    let notch = 14.0 - 24f64.sqrt() - 25.0 * 0.2f64.asin();
    let want = 16000.0 - 250.0 * std::f64::consts::PI - 10.0 * notch;
    assert!(close(b.volume, want, 1e-12), "{} vs {want}", b.volume);
}

/// A through notch whose wall `y = 0` meets the hole wall along `x = 5, y = 0` — a real edge
/// between two faces, on the line where OCCT puts the cylinder's seam: 10 faces, 24 edges (22
/// lines: 12 plate, 3 + 3 notch outline, 2 at the notch's outer corners, 2 where its walls meet
/// the hole wall; 2 rim arcs). Volume `16000 − 250π − 10·(15 − (6 + 12.5·asin 0.6 − 9))`.
#[test]
fn an_edge_on_the_seam_line_of_a_hole_is_a_real_edge() {
    let r = run(&program("seam_edge_on_hole_seam"));
    let b = body_of(&r, "e2", "e1");
    assert_eq!(
        topology(b),
        (
            10,
            24,
            counts(&[("cylinder", 1), ("plane", 9)]),
            counts(&[("circle", 2), ("line", 22)])
        )
    );
    let in_disk = 6.0 + 12.5 * 0.6f64.asin() - 9.0;
    let want = 16000.0 - 250.0 * std::f64::consts::PI - 10.0 * (15.0 - in_disk);
    assert!(close(b.volume, want, 1e-11), "{} vs {want}", b.volume);
}

/// A cut whose tool reaches a plate's bottom edge by 0.0005 mm (a 0.0005 × 0.01 × 0.01 notch,
/// 5e-8 mm³ — every dimension far above `LINEAR_TOLERANCE`) is a real cut: the plate is
/// modified (6 + 4 faces; 24 edges: the split bottom edge, 3 + 3 outline lines, 5 notch
/// edges), and the box's 2 × 2 × 0.01 pocket is cut too (11 faces, 24 edges).
#[test]
fn a_sliver_cut_above_tolerance_is_cut() {
    let r = run(&program("tiny_sliver_cut"));
    let plate = body_of(&r, "e3", "e1");
    assert_eq!(
        topology(plate),
        (10, 24, counts(&[("plane", 10)]), counts(&[("line", 24)]))
    );
    assert!(
        close(16000.0 - plate.volume, 0.0005 * 0.01 * 0.01, 1e-6),
        "{}",
        plate.volume
    );
    let bx = body_of(&r, "e3", "e2");
    assert_eq!(
        topology(bx),
        (11, 24, counts(&[("plane", 11)]), counts(&[("line", 24)]))
    );
    assert!(close(bx.volume, 1000.0 - 0.04, 1e-12), "{}", bx.volume);
    assert!(
        feature(&r, "e3")
            .warnings
            .iter()
            .all(|w| w.code != v1::NO_CHANGE_CODE)
    );
}

/// The pocket's side walls (vertical planes that miss the ring's axis) cut the inner fillet
/// torus in spiric sections, which are not conics: 6 `bspline` edges; its floor and top
/// (planes perpendicular to the axis) cut the torus and the inner cylinder in circles.
#[test]
fn a_pocket_through_a_torus_reports_its_spiric_edges_as_bsplines() {
    let r = run(&program("torus_pocket_spiric_edges"));
    let b = body_of(&r, "e2", "r1");
    assert_eq!(
        topology(b),
        (
            21,
            46,
            counts(&[("cylinder", 2), ("plane", 15), ("torus", 4)]),
            counts(&[("bspline", 6), ("circle", 16), ("line", 24)])
        )
    );
}

/// A through pocket whose corner pokes out of the centre hole notches the hole wall; the wall
/// stays one cylinder face (6 cylinders: 4 rounded corners, h0, hc).
#[test]
fn a_notched_hole_wall_stays_one_face() {
    let r = run(&program("seam_split_hole_wall_face"));
    let b = body_of(&r, "e2", "e1");
    assert_eq!(b.face_types.get("cylinder"), Some(&6));
    assert_eq!((b.faces, b.edges), (14, 35));
}

// ---- command layer: parameters and writeBackSolution (SPEC-v1 §0.6) ----------------------------------

#[test]
fn the_params_block_is_the_evaluations_without_evaluating_features() {
    let text = doc(
        json!([{ "name": "w", "unit": "mm", "value": 20 },
               { "name": "h", "unit": "mm", "value": "w / 2" },
               { "name": "bad", "unit": "mm", "value": "sqrt(0 - w * 1mm)" }]),
        json!([
            rect_sketch(
                "s1",
                json!("XY"),
                json!(0),
                json!(0),
                json!("w"),
                json!("h")
            ),
            extrude("e1", "s1", json!(1))
        ]),
    );
    let l = v1::load(&text).unwrap();
    let p = v1::params(&l.doc);
    let r = run(&text);
    assert_eq!(p, r.params);
    assert_eq!(p.len(), 3);
    assert!(p[2].error.is_some());
}

fn constrained_rect_doc(w: f64, h: f64, guess: f64) -> String {
    doc(
        json!([{ "name": "w", "unit": "mm", "value": w }]),
        json!([
            { "type": "sketch", "id": "s1", "name": "s1", "plane": "XY", "curves": [
                { "kind": "line", "id": "a", "start": [0, 0], "end": [guess, 0.5] },
                { "kind": "line", "id": "b", "start": [guess, 0.5], "end": [guess, guess] },
                { "kind": "line", "id": "c", "start": [guess, guess], "end": [0.5, guess] },
                { "kind": "line", "id": "d", "start": [0.5, guess], "end": [0, 0] } ],
              "constraints": [
                { "id": "fx", "type": "fix", "entity": "a.start", "x": 0, "y": 0 },
                { "id": "ha", "type": "horizontal", "line": "a" },
                { "id": "hc", "type": "horizontal", "line": "c" },
                { "id": "vb", "type": "vertical", "line": "b" },
                { "id": "vd", "type": "vertical", "line": "d" },
                { "id": "dw", "type": "distance", "a": "a.start", "b": "a.end", "value": "w" },
                { "id": "dh", "type": "distance", "a": "b.start", "b": "b.end", "value": h } ] },
            extrude("e1", "s1", json!(2)),
            rect_sketch("s2", json!("XY"), json!(100), json!(0), json!(4), json!(4))
        ]),
    )
}

/// `writeBackSolution` (§0.6): the solved coordinates replace the stored ones, nothing else
/// changes, the evaluation of the written document is the same, and the op is idempotent.
#[test]
fn write_back_stores_the_solution_and_is_idempotent() {
    let text = constrained_rect_doc(30.0, 12.0, 9.0);
    let l = v1::load(&text).unwrap();
    let before = run(&text);
    assert_eq!(before.status, Status::Ok, "{before:?}");
    let wb = v1::write_back(&l.doc, None).unwrap();
    assert_eq!(wb.written, ["s1"]);
    assert!(wb.skipped.is_empty(), "{:?}", wb.skipped);
    // Only the constrained sketch changed, and only its curves.
    assert_ne!(wb.doc, l.doc);
    let (forge_ir::v1::Feature::Sketch(a), forge_ir::v1::Feature::Sketch(b)) =
        (&l.doc.parts[0].features[0], &wb.doc.parts[0].features[0])
    else {
        panic!("sketch expected");
    };
    assert_eq!(a.constraints, b.constraints);
    assert_ne!(a.curves, b.curves);
    for i in 1..l.doc.parts[0].features.len() {
        assert_eq!(l.doc.parts[0].features[i], wb.doc.parts[0].features[i]);
    }
    // The stored geometry is the solution (the rectangle's far corner is (30, 12)).
    let text2 = forge_ir::v1::to_json(&wb.doc);
    assert!(text2.contains("30.0") && text2.contains("12.0"), "{text2}");
    let after = run(&text2);
    assert_eq!(
        serde_json::to_value(&before.features).unwrap(),
        serde_json::to_value(&after.features).unwrap()
    );
    assert_eq!(before.parts, after.parts);
    // Idempotent: writing back the written document changes nothing.
    let again = v1::write_back(&wb.doc, None).unwrap();
    assert_eq!(again.doc, wb.doc);
    // The written document is canonical and round-trips.
    assert_eq!(v1::load(&text2).unwrap().doc, wb.doc);
}

#[test]
fn write_back_selects_sketches_and_reports_what_it_could_not_write() {
    let text = constrained_rect_doc(30.0, 12.0, 9.0);
    let d = v1::load(&text).unwrap().doc;
    // An explicit sketch has nothing to write back.
    let wb = v1::write_back(&d, Some(&["s2".to_string()])).unwrap();
    assert!(wb.written.is_empty());
    assert_eq!(wb.doc, d);
    assert_eq!(
        wb.skipped[0].to_json(),
        json!({ "sketch": "s2", "reason": "explicit" })
    );
    // Unknown ids write nothing (the whole op fails), and are not echoed when invalid.
    let e = v1::write_back(&d, Some(&["s1".to_string(), "e1".to_string()])).unwrap_err();
    assert_eq!(e.code, "WRITE_BACK_UNKNOWN_SKETCH");
    let e = v1::write_back(&d, Some(&["<script>".to_string()])).unwrap_err();
    assert!(!e.message.contains("<script>"), "{e}");
    // A sketch whose evaluation fails (its dimension `w` evaluates to -30) keeps its stored
    // geometry.
    let d = v1::load(&constrained_rect_doc(-30.0, 12.0, 9.0))
        .unwrap()
        .doc;
    let wb = v1::write_back(&d, None).unwrap();
    assert!(wb.written.is_empty());
    assert_eq!(wb.doc, d);
    assert_eq!(wb.skipped[0].sketch, "s1");
    assert_eq!(wb.skipped[0].reason, "failed");
    assert!(wb.skipped[0].code.is_some());
    // A suppressed sketch is not written.
    let sup = text.replace(
        r#""name":"s1","plane""#,
        r#""name":"s1","suppressed":true,"plane""#,
    );
    assert_ne!(sup, text);
    let d = forge_ir::v1::from_json(&sup).unwrap();
    let wb = v1::write_back(&d, None).unwrap();
    assert_eq!(
        wb.skipped[0].to_json(),
        json!({ "sketch": "s1", "reason": "suppressed" })
    );
}

#[cfg(not(target_family = "wasm"))]
mod write_back_props {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig { cases: 48, ..ProptestConfig::default() })]

        /// For random dimensions and start guesses: the written document evaluates to the
        /// same report, and writing back again is the identity (the op-level fixed point).
        #[test]
        fn write_back_is_a_fixed_point(w in 1.0f64..200.0, h in 1.0f64..200.0, g in 0.5f64..50.0) {
            let text = constrained_rect_doc(w, h, g);
            let d = v1::load(&text).unwrap().doc;
            let before = v1::report(&v1::evaluate(&d), "t", "t", None);
            prop_assume!(before.status == Status::Ok);
            let wb = v1::write_back(&d, None).unwrap();
            prop_assert_eq!(&wb.written, &["s1".to_string()]);
            let after = v1::report(&v1::evaluate(&wb.doc), "t", "t", None);
            prop_assert_eq!(&before.parts, &after.parts);
            prop_assert_eq!(
                serde_json::to_value(&before.features).unwrap(),
                serde_json::to_value(&after.features).unwrap()
            );
            prop_assert_eq!(v1::write_back(&wb.doc, None).unwrap().doc, wb.doc);
        }
    }
}

// ---- property: dependency order through arbitrary queries ------------------------------------------

#[cfg(not(target_family = "wasm"))]
mod dependency_props {
    use super::*;
    use proptest::prelude::*;

    /// A face query over e1 and the tags t_ok (ok), t_fail (REF_MISSING), t_sup (suppressed),
    /// with the tags it names in depth-first operand order.
    fn face_query() -> impl Strategy<Value = (Value, Vec<&'static str>)> {
        let leaf = prop_oneof![
            Just((
                json!({ "op": "cap", "feature": "e1", "end": "end" }),
                vec![]
            )),
            Just((json!({ "op": "sides", "feature": "e1" }), vec![])),
            Just((json!({ "op": "tagged", "feature": "t_ok" }), vec!["t_ok"])),
            Just((
                json!({ "op": "tagged", "feature": "t_fail" }),
                vec!["t_fail"]
            )),
            Just((json!({ "op": "tagged", "feature": "t_sup" }), vec!["t_sup"])),
        ];
        leaf.prop_recursive(3, 12, 3, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 2..4).prop_map(|v| {
                    let tags = v.iter().flat_map(|(_, t)| t.clone()).collect();
                    (json!({ "op": "union", "of": v.into_iter().map(|(q, _)| q).collect::<Vec<_>>() }), tags)
                }),
                (inner.clone(), inner).prop_map(|((a, ta), (b, tb))| {
                    let tags = ta.into_iter().chain(tb).collect();
                    (json!({ "op": "minus", "a": a, "b": b }), tags)
                }),
            ]
        })
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 24, ..ProptestConfig::default() })]

        /// §7.1 step 2: the first failed or suppressed tag named anywhere in the targets (in
        /// depth-first operand order) decides the code, before the distance's range check; with
        /// no such tag the range check fails the feature.
        #[test]
        fn the_first_bad_tag_in_any_query_decides_the_code((q, tags) in face_query()) {
            let text = doc(
                json!([{ "name": "p", "unit": "mm", "value": 5 }]),
                json!([
                    rect_sketch("s1", json!("XY"), json!(0), json!(0), json!(20), json!(20)),
                    extrude("e1", "s1", json!(10)),
                    { "type": "tag", "id": "t_ok", "name": "t_ok", "target": { "kind": "face",
                      "q": { "op": "filter", "of": { "op": "sides", "feature": "e1" }, "where": { "normal": "+X" } } } },
                    { "type": "tag", "id": "t_fail", "name": "t_fail", "target": { "kind": "face",
                      "q": { "op": "filter", "of": { "op": "sides", "feature": "e1" }, "where": { "type": "cylinder" } } } },
                    { "type": "tag", "id": "t_sup", "name": "t_sup", "suppressed": true, "target": { "kind": "face",
                      "q": { "op": "cap", "feature": "e1", "end": "end" } } },
                    rect_sketch("s2", json!("XY"), json!(0), json!(0), json!(4), json!(4)),
                    { "type": "extrude", "id": "e2", "name": "e2", "sketch": "s2", "distance": "p - 10",
                      "op": "cut", "targets": { "kind": "body", "q": { "op": "owner", "of": q } } }
                ]),
            );
            let r = run(&text);
            let e = feature(&r, "e2").error.clone().expect("e2 fails");
            let (want, feature_id) = match tags.iter().find(|t| **t != "t_ok") {
                Some(&"t_fail") => ("DEPENDENCY_FAILED", Some("t_fail")),
                Some(&"t_sup") => ("DEPENDENCY_SUPPRESSED", Some("t_sup")),
                _ => ("INVALID_DISTANCE", None),
            };
            prop_assert_eq!(e.code.as_str(), want, "{:?}", tags);
            if let Some(id) = feature_id {
                prop_assert_eq!(&e.details["feature"], &json!(id));
            }
            // A failed feature passes its input through.
            prop_assert!(close(part_volumes(&r)[0], 4000.0, 1e-12));
        }
    }
}
