//! Modelled threads through IR v1 evaluation (SPEC-v1 §6.5 `thread.modeled`, §6.13 `thread`):
//! the corpus program `threads.json` against the closed forms of its grooves, the report fields,
//! cosmetic threads, and the structured refusals.

use std::f64::consts::PI;

use forge_ir::v1::metrics::{EvalReport, FeatureReport, Status};
use forge_regen::v1;
use serde_json::{Value, json};

const THREADS: &str = include_str!("../../../../corpus/v1/programs/threads.json");

fn run(text: &str) -> EvalReport {
    let (r, ev) = v1::evaluate_text(text, "forge test", "t");
    assert!(ev.is_some(), "rejected: {:?}", r.error);
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

/// `(2π/P)·∫ r·w(r) dr` over the nut groove from the crest radius `rc` to the root `D/2`
/// (`w(r) = P/8 + 2·(D/2 − r)·tan 30°`): the groove volume per mm of thread.
fn nut_groove_per_mm(d: f64, p: f64, rc: f64) -> f64 {
    let (rr, t) = (0.5 * d, 1.0 / 3f64.sqrt());
    // ∫ r·(a + 2t(rr − r)) dr with a = P/8, exactly.
    let f = |r: f64| (p / 8.0 + 2.0 * t * rr) * r * r / 2.0 - 2.0 * t * r * r * r / 3.0;
    2.0 * PI / p * (f(rr) - f(rc))
}

fn doc(features: Value) -> String {
    json!({
        "schema": "aicad.ir/1",
        "meta": { "name": "t" },
        "parts": [{ "id": "p1", "name": "part", "features": features }]
    })
    .to_string()
}

fn plate_features(thick: f64) -> Vec<Value> {
    vec![
        json!({ "type": "sketch", "id": "s1", "name": "s1", "plane": "XY", "curves": [
            { "kind": "rect", "id": "r", "center": [0, 0], "w": 40, "h": 30 } ] }),
        json!({ "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": thick }),
    ]
}

fn top() -> Value {
    json!({ "face": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } } })
}

#[test]
fn the_corpus_threads_match_their_closed_forms() {
    let r = run(THREADS);
    for f in &r.features {
        assert_eq!(f.status, Status::Ok, "{}: {:?}", f.feature, f.error);
    }
    // h1: a 1/2-20 UNF through hole bored at the basic minor diameter, threaded through the plate.
    let h1 = feature(&r, "h1");
    let hole = &h1.holes[0];
    let minor = 12.7 - 1.25 * 1.27 * 3f64.sqrt() / 2.0;
    assert!((hole.d - minor).abs() < 1e-12, "{}", hole.d);
    let t = hole.thread.as_ref().expect("thread");
    assert_eq!(t.standard.as_deref(), Some("1/2-20 UNF"));
    assert_eq!(t.major, Some(12.7));
    assert!(t.modeled);
    let rc = 0.5 * minor;
    let want = 60.0 * 30.0 * 10.0 - PI * rc * rc * 10.0 - 10.0 * nut_groove_per_mm(12.7, 1.27, rc);
    let got = h1.bodies[0].volume;
    assert!(
        (got - want).abs() <= 1e-9 * want,
        "h1 volume {got} vs {want}"
    );
    assert_eq!(h1.bodies[0].face_types.get("helicoid"), Some(&2));
    // th1: an M8 bolt thread over 10 of the boss's 12 mm.
    let th1 = feature(&r, "th1");
    let rep = th1.thread.as_ref().expect("thread report");
    assert_eq!(rep.kind, "external");
    assert_eq!(rep.standard.as_deref(), Some("M8"));
    assert!((rep.length - 10.0).abs() < 1e-12 && rep.modeled && rep.starts == 1);
    assert!((rep.minor - (8.0 - 1.25 * 1.25 * 3f64.sqrt() / 2.0)).abs() < 1e-12);
    let body = &r.parts[0].bodies[0];
    assert!(body.valid);
    assert_eq!(body.face_types.get("helicoid"), Some(&6));
}

#[test]
fn a_cosmetic_thread_feature_changes_no_geometry() {
    let mut f = plate_features(8.0);
    f.push(
        json!({ "type": "hole", "id": "h1", "name": "h1", "on": top(),
        "at": { "list": [{ "id": "a", "at": [0, 0] }] }, "d": 6.8, "depth": "through" }),
    );
    let before = run(&doc(Value::Array(f.clone())));
    f.push(json!({ "type": "thread", "id": "t1", "name": "t1",
        "face": { "kind": "face", "q": { "op": "hole_face", "feature": "h1", "at": "a", "part": "wall" } },
        "standard": "M8", "modeled": false }));
    let after = run(&doc(Value::Array(f)));
    let t = feature(&after, "t1").thread.as_ref().expect("report");
    assert!(!t.modeled);
    assert_eq!(t.kind, "internal");
    // Bit-identical: the cosmetic thread does not touch the body.
    assert_eq!(
        before.parts[0].bodies[0].volume.to_bits(),
        after.parts[0].bodies[0].volume.to_bits()
    );
}

#[test]
fn thread_refusals_are_structured_feature_errors() {
    // An M8 thread in a 5 mm bore: the crest is outside the form.
    let mut f = plate_features(8.0);
    f.push(
        json!({ "type": "hole", "id": "h1", "name": "h1", "on": top(),
        "at": { "list": [{ "id": "a", "at": [0, 0] }] }, "d": 5, "depth": "through",
        "thread": { "standard": "M8", "modeled": true } }),
    );
    let r = run(&doc(Value::Array(f)));
    let e = feature(&r, "h1").error.as_ref().expect("error");
    assert_eq!(e.code, "THREAD_DIAMETER_MISMATCH");
    assert_eq!(e.details["kind"], "internal");
    assert!(e.details["min_d"].as_f64().unwrap() > 5.0);
    // A thread longer than its face.
    let mut f = plate_features(8.0);
    f.push(
        json!({ "type": "hole", "id": "h1", "name": "h1", "on": top(),
        "at": { "list": [{ "id": "a", "at": [0, 0] }] }, "d": 6.8, "depth": "through" }),
    );
    f.push(json!({ "type": "thread", "id": "t1", "name": "t1",
        "face": { "kind": "face", "q": { "op": "hole_face", "feature": "h1", "at": "a", "part": "wall" } },
        "standard": "M8", "length": 9 }));
    let r = run(&doc(Value::Array(f)));
    let e = feature(&r, "t1").error.as_ref().expect("error");
    assert_eq!(e.code, "THREAD_LENGTH_OUT_OF_RANGE");
    assert_eq!(e.details["face_end"], 8.0);
}

#[test]
fn a_pattern_of_a_modelled_thread_hole_is_refused() {
    let mut f = plate_features(8.0);
    f.push(
        json!({ "type": "hole", "id": "h1", "name": "h1", "on": top(),
        "at": { "list": [{ "id": "a", "at": [-10, 0] }] }, "size": "M8", "depth": "through",
        "thread": { "modeled": true } }),
    );
    f.push(
        json!({ "type": "pattern", "id": "pt", "name": "pt", "seed": { "features": ["h1"] },
        "layout": { "linear": { "dir": "X", "count": 2, "spacing": 20 } } }),
    );
    let r = run(&doc(Value::Array(f)));
    assert_eq!(feature(&r, "h1").status, Status::Ok);
    let e = feature(&r, "pt").error.as_ref().expect("error");
    assert_eq!(e.code, "FORGE_PATTERN_MODELED_THREAD");
}
