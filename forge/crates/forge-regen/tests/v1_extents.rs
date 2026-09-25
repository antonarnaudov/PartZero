//! Extrude extents (SPEC-v1 §6.2, amendment set F): `"through_all"` cuts through every target
//! (the result equals a cut by any distance that passes the target), one way or symmetric;
//! `{ "up_to": PlaneRef }` ends on a parallel plane — a face, a datum plane, an origin plane —
//! and follows it when it moves; the rules are rejections, the geometry checks evaluation errors.

use forge_ir::v1::metrics::{EvalReport, FeatureReport, Status};
use forge_regen::v1;
use serde_json::{Value, json};

fn doc(features: Value) -> String {
    json!({
        "schema": "aicad.ir/1",
        "meta": { "name": "t" },
        "params": [{ "name": "lift", "unit": "mm", "value": 12 }],
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
    r
}

fn rejected(text: &str) -> (String, String) {
    let (r, ev) = v1::evaluate_text(text, "forge test", "t");
    assert!(ev.is_none(), "expected a rejection");
    let e = r.error.expect("error");
    (e.code, e.message)
}

fn feature<'a>(r: &'a EvalReport, id: &str) -> &'a FeatureReport {
    r.features
        .iter()
        .find(|f| f.feature_id == id)
        .unwrap_or_else(|| panic!("no entry for {id}"))
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0)
}

const PI: f64 = std::f64::consts::PI;

/// A 40 × 20 × 5 plate `e1` and a circle of radius 3 sketched on its top cap (`s2`).
fn plate_and_circle() -> Vec<Value> {
    vec![
        json!({ "type": "sketch", "id": "s1", "name": "base", "plane": "XY",
                "curves": [{ "kind": "rect", "id": "r", "center": [0, 0], "w": 40, "h": 20 }] }),
        json!({ "type": "extrude", "id": "e1", "name": "plate", "sketch": "s1", "distance": 5 }),
        json!({ "type": "sketch", "id": "s2", "name": "boreSk",
                "plane": { "face": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } } },
                "curves": [{ "kind": "circle", "id": "c", "center": [8, 0], "radius": 3 }] }),
    ]
}

#[test]
fn through_all_cuts_through_the_plate_as_a_deep_enough_distance_does() {
    let mut f = plate_and_circle();
    f.push(json!({ "type": "extrude", "id": "e2", "name": "bore", "sketch": "s2", "extent": "through_all",
                   "direction": "reverse", "op": "cut", "targets": "all" }));
    let r = run(&doc(Value::Array(f.clone())));
    assert_eq!(r.status, Status::Ok, "{:?}", feature(&r, "e2").error);
    let v = r.parts[0].bodies[0].volume;
    assert!(close(v, 40.0 * 20.0 * 5.0 - PI * 9.0 * 5.0), "{v}");
    // The same result as a cut by an explicit, deep enough distance.
    let mut g = plate_and_circle();
    g.push(
        json!({ "type": "extrude", "id": "e2", "name": "bore", "sketch": "s2", "distance": 50,
                   "direction": "reverse", "op": "cut", "targets": "all" }),
    );
    let s = run(&doc(Value::Array(g)));
    assert_eq!(
        serde_json::to_value(&r.parts).unwrap(),
        serde_json::to_value(&s.parts).unwrap()
    );
    // Pointing away from the plate, it meets nothing.
    f[3]["direction"] = json!("normal");
    let r = run(&doc(Value::Array(f)));
    assert_eq!(
        feature(&r, "e2").error.as_ref().unwrap().code,
        "BOOLEAN_NO_INTERSECTION"
    );
}

#[test]
fn a_symmetric_through_all_from_a_mid_plane_cuts_both_ways() {
    let mut f = plate_and_circle();
    f.push(json!({ "type": "datum_plane", "id": "d1", "name": "mid", "mode": "offset", "from": "XY", "distance": 2.5 }));
    f.push(json!({ "type": "sketch", "id": "s3", "name": "slotSk", "plane": { "datum": "d1" },
                   "curves": [{ "kind": "rect", "id": "q", "center": [-10, 0], "w": 4, "h": 30 }] }));
    f.push(json!({ "type": "extrude", "id": "e3", "name": "slot", "sketch": "s3", "extent": "through_all",
                   "direction": "symmetric", "op": "cut", "targets": "all" }));
    let r = run(&doc(Value::Array(f)));
    assert_eq!(r.status, Status::Ok, "{:?}", feature(&r, "e3").error);
    // The 4 mm slot crosses the whole 20 mm width: two bodies of 40×20×5 minus 4×20×5 in total.
    let total: f64 = r.parts[0].bodies.iter().map(|b| b.volume).sum();
    assert_eq!(r.parts[0].bodies.len(), 2);
    assert!(close(total, 36.0 * 20.0 * 5.0), "{total}");
}

#[test]
fn up_to_ends_on_a_parallel_plane_and_follows_it() {
    let mut f = plate_and_circle();
    f.push(json!({ "type": "datum_plane", "id": "d1", "name": "roof", "mode": "offset", "from": "XY", "distance": "lift" }));
    f.push(json!({ "type": "extrude", "id": "e2", "name": "boss", "sketch": "s2", "extent": { "up_to": { "datum": "d1" } },
                   "op": "join", "targets": "all" }));
    let r = run(&doc(Value::Array(f.clone())));
    assert_eq!(r.status, Status::Ok, "{:?}", feature(&r, "e2").error);
    let b = &r.parts[0].bodies[0];
    assert!(close(b.bbox_max[2], 12.0));
    assert!(close(b.volume, 40.0 * 20.0 * 5.0 + PI * 9.0 * 7.0));
    // Up to a face: the plate's own bottom (from the top cap, reverse) is a through hole.
    let mut g = plate_and_circle();
    g.push(json!({ "type": "extrude", "id": "e2", "name": "bore", "sketch": "s2", "direction": "reverse",
                   "extent": { "up_to": { "face": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "start" } } } },
                   "op": "cut", "targets": "all" }));
    let r = run(&doc(Value::Array(g)));
    assert_eq!(r.status, Status::Ok, "{:?}", feature(&r, "e2").error);
    assert!(close(
        r.parts[0].bodies[0].volume,
        40.0 * 20.0 * 5.0 - PI * 9.0 * 5.0
    ));
    assert_eq!(feature(&r, "e2").refs[0].field, "/extent/up_to/face");
}

#[test]
fn an_up_to_plane_at_an_angle_or_behind_fails_with_its_code() {
    let mut f = plate_and_circle();
    f.push(json!({ "type": "extrude", "id": "e2", "name": "boss", "sketch": "s2", "extent": { "up_to": "XZ" } }));
    let r = run(&doc(Value::Array(f)));
    let e = feature(&r, "e2").error.as_ref().unwrap();
    assert_eq!(e.code, "EXTRUDE_UP_TO_NOT_PARALLEL");
    assert!(close(e.details["angle"].as_f64().unwrap(), 90.0));
    let mut g = plate_and_circle();
    g.push(json!({ "type": "extrude", "id": "e2", "name": "boss", "sketch": "s2", "extent": { "up_to": "XY" } }));
    let r = run(&doc(Value::Array(g)));
    let e = feature(&r, "e2").error.as_ref().unwrap();
    assert_eq!(e.code, "EXTRUDE_UP_TO_BEHIND");
    assert!(close(e.details["distance"].as_f64().unwrap(), -5.0));
}

#[test]
fn the_extent_rules_are_rejections() {
    let base = plate_and_circle();
    let with = |extra: Value| {
        let mut f = base.clone();
        let mut e = json!({ "type": "extrude", "id": "e2", "name": "x", "sketch": "s2" });
        for (k, v) in extra.as_object().unwrap() {
            e[k] = v.clone();
        }
        f.push(e);
        doc(Value::Array(f))
    };
    assert_eq!(rejected(&with(json!({}))).0, "EXTRUDE_EXTENT_CONFLICT");
    assert_eq!(
        rejected(&with(
            json!({ "distance": 3, "extent": "through_all", "op": "cut", "targets": "all" })
        ))
        .0,
        "EXTRUDE_EXTENT_CONFLICT"
    );
    assert_eq!(
        rejected(&with(json!({ "extent": "through_all" }))).0,
        "EXTRUDE_EXTENT_CONFLICT"
    );
    assert_eq!(
        rejected(&with(
            json!({ "extent": "through_all", "op": "join", "targets": "all" })
        ))
        .0,
        "EXTRUDE_EXTENT_CONFLICT"
    );
    assert_eq!(
        rejected(&with(
            json!({ "extent": { "up_to": "XY" }, "direction": "symmetric" })
        ))
        .0,
        "EXTRUDE_EXTENT_CONFLICT"
    );
    assert_eq!(
        rejected(&with(json!({ "extent": { "up_to": { "datum": "nope" } } }))).0,
        "UNRESOLVED_FEATURE"
    );
}
