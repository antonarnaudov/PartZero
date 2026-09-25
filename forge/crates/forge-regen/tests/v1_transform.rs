//! `transform` (SPEC-v1 §6.13, amendment set F): moving bodies keeps their identity (origin and
//! keys — a later hole on the moved cap still resolves), copies are new bodies of the transform
//! (origin instance `[1]`, keys `T/copy:{K}@1`) that later features can name, rotations use
//! exact degrees, and values are range-checked. The motion is checked as a property: volume,
//! area and face counts are kept, and the centroid and box move exactly as the motion says.

// Exact comparisons on purpose: translations by whole millimetres and rotations by exact
// degrees (§2.7) must land on exact coordinates.
#![allow(clippy::float_cmp)]

use forge_ir::v1::metrics::{BodyChange, EvalReport, FeatureReport, Status};
use forge_regen::v1;
use serde_json::{Value, json};

fn doc(features: Value) -> String {
    json!({
        "schema": "aicad.ir/1",
        "meta": { "name": "t" },
        "params": [{ "name": "a", "unit": "deg", "value": 90 }],
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
    let (again, _) = v1::evaluate_text(text, "forge test", "t");
    assert_eq!(
        serde_json::to_string(&r).unwrap(),
        serde_json::to_string(&again).unwrap(),
        "evaluation is not deterministic"
    );
    r
}

fn rejected(text: &str) -> String {
    let (r, ev) = v1::evaluate_text(text, "forge test", "t");
    assert!(ev.is_none(), "expected a rejection");
    r.error.expect("a rejection carries its error").code
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

fn close3(a: [f64; 3], b: [f64; 3]) -> bool {
    (0..3).all(|k| close(a[k], b[k]))
}

/// A 20 × 10 × 5 slab `e1` (sketch `s1`, centred on the origin).
fn slab() -> Vec<Value> {
    vec![
        json!({ "type": "sketch", "id": "s1", "name": "base", "plane": "XY",
                "curves": [{ "kind": "rect", "id": "r", "center": [0, 0], "w": 20, "h": 10 }] }),
        json!({ "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 5 }),
    ]
}

fn body_ref(feature: &str) -> Value {
    json!({ "kind": "body", "q": { "op": "body", "feature": feature } })
}

#[test]
fn a_move_translates_the_body_and_keeps_its_origin_and_keys() {
    let mut f = slab();
    f.push(json!({ "type": "transform", "id": "t1", "name": "move", "bodies": body_ref("e1"), "translate": [30, 0, 2] }));
    // A later hole on the moved end cap: the cap kept its key, so the named query resolves.
    f.push(json!({ "type": "hole", "id": "h1", "name": "bore",
        "on": { "face": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } } },
        "at": { "list": [{ "id": "a", "at": [30, 0] }] }, "d": 3, "depth": "through" }));
    let r = run(&doc(Value::Array(f)));
    assert_eq!(r.status, Status::Ok, "{:?}", r.features);
    let t = feature(&r, "t1");
    let b = &t.bodies[0];
    assert_eq!(b.change, Some(BodyChange::Modified));
    assert_eq!(b.origin.feature, "e1");
    assert!(close(b.volume, 20.0 * 10.0 * 5.0));
    assert!(close3(b.bbox_min, [20.0, -5.0, 2.0]), "{:?}", b.bbox_min);
    assert!(close3(b.bbox_max, [40.0, 5.0, 7.0]), "{:?}", b.bbox_max);
    let hole = feature(&r, "h1");
    assert_eq!(hole.holes[0].center, [30.0, 0.0, 7.0]);
    assert_eq!(r.parts[0].bodies.len(), 1);
}

/// §5.2 rule 3 after a move: the junction edges of a rounded outline (a straight side meeting a
/// corner arc) keep their junction qualifier, although the key computation finds it from the
/// sketch's junction points, where the moved edges no longer are.
#[test]
fn a_moved_body_keeps_its_junction_edge_keys() {
    let features = |moved: bool| {
        let mut f = vec![
            json!({ "type": "sketch", "id": "s1", "name": "base", "plane": "XY",
                    "curves": [{ "kind": "rect", "id": "r", "center": [0, 0], "w": 40, "h": 20, "r": 3 }] }),
            json!({ "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 6 }),
        ];
        if moved {
            f.push(
                json!({ "type": "transform", "id": "t1", "name": "m", "bodies": body_ref("e1"),
                           "rotate": { "axis": "Z", "angle": 30 }, "translate": [12.5, -3, 2] }),
            );
        }
        doc(Value::Array(f))
    };
    let problems = |text: &str| {
        let l = v1::load(text).unwrap();
        let (_, problems) = v1::evaluate_with_key_check(&l.doc);
        problems
            .into_iter()
            .filter(|p| !p.ends_with("is not a face of the body"))
            .collect::<Vec<_>>()
    };
    assert_eq!(problems(&features(false)), Vec::<String>::new());
    assert_eq!(problems(&features(true)), Vec::<String>::new());
}

#[test]
fn a_rotation_is_exact_in_degrees_and_happens_before_the_translation() {
    let mut f = slab();
    // 90° about Z (a parameter), then 100 along X: the slab stands 10 wide in X, 20 in Y.
    f.push(
        json!({ "type": "transform", "id": "t1", "name": "turn", "bodies": body_ref("e1"),
        "rotate": { "axis": "Z", "angle": "a" }, "translate": [100, 0, 0] }),
    );
    let r = run(&doc(Value::Array(f)));
    let b = &r.parts[0].bodies[0];
    assert_eq!(b.bbox_min, [95.0, -10.0, 0.0]);
    assert_eq!(b.bbox_max, [105.0, 10.0, 5.0]);
    // About an axis line off the origin (an edge of the slab): the rotation pivots on it.
    let mut g = slab();
    g.push(json!({ "type": "transform", "id": "t1", "name": "flip", "bodies": body_ref("e1"),
        "rotate": { "axis": { "line": { "origin": [10, 0, 0], "direction": [0, 1, 0] } }, "angle": 180 } }));
    let r = run(&doc(Value::Array(g)));
    let b = &r.parts[0].bodies[0];
    assert!(close3(b.bbox_min, [10.0, -5.0, -5.0]), "{:?}", b.bbox_min);
    assert!(close3(b.bbox_max, [30.0, 5.0, 0.0]), "{:?}", b.bbox_max);
}

#[test]
fn a_copy_adds_a_body_of_the_transform_that_later_features_name() {
    let mut f = slab();
    f.push(
        json!({ "type": "transform", "id": "t1", "name": "twin", "bodies": body_ref("e1"),
        "translate": [0, 10, 0], "copy": true }),
    );
    // The copy is a body of t1 (its origin), joined back to the slab by a later boolean, and
    // its faces carry `t1/copy:{…}@1` keys that `created` finds.
    f.push(json!({ "type": "tag", "id": "g1", "name": "copyFaces",
        "target": { "kind": "face", "q": { "op": "created", "feature": "t1" } } }));
    f.push(
        json!({ "type": "boolean", "id": "b1", "name": "merge", "op": "join",
        "targets": body_ref("e1"), "tools": body_ref("t1") }),
    );
    let r = run(&doc(Value::Array(f)));
    assert_eq!(
        r.status,
        Status::Ok,
        "{:?}",
        r.features
            .iter()
            .map(|f| (&f.feature_id, &f.error))
            .collect::<Vec<_>>()
    );
    let t = feature(&r, "t1");
    let c = &t.bodies[0];
    assert_eq!(c.change, Some(BodyChange::Created));
    assert_eq!(c.origin.feature, "t1");
    assert_eq!(c.origin.member, "r.bottom");
    assert_eq!(c.origin.instance, Some(vec![1]));
    assert!(close3(c.centroid, [0.0, 10.0, 2.5]));
    let tag = feature(&r, "g1");
    let members = &tag.refs[0].members;
    assert_eq!(members.len(), 6);
    assert!(
        members.iter().all(|m| m.key.starts_with("t1/copy:{")),
        "{:?}",
        members.iter().map(|m| &m.key).collect::<Vec<_>>()
    );
    // Joined: the two slabs share the face y = 5, one body of volume 2 × 1000.
    assert_eq!(r.parts[0].bodies.len(), 1);
    assert!(close(r.parts[0].bodies[0].volume, 2000.0));
}

#[test]
fn values_are_range_checked_as_literals_and_as_expressions() {
    let mut f = slab();
    f.push(
        json!({ "type": "transform", "id": "t1", "name": "bad", "bodies": body_ref("e1"),
        "rotate": { "axis": "Z", "angle": 400 } }),
    );
    assert_eq!(rejected(&doc(Value::Array(f))), "INVALID_ANGLE");
    let mut g = slab();
    g.push(
        json!({ "type": "transform", "id": "t1", "name": "bad", "bodies": body_ref("e1"),
        "rotate": { "axis": "Z", "angle": "a * 5" } }),
    );
    let r = run(&doc(Value::Array(g)));
    assert_eq!(
        feature(&r, "t1").error.as_ref().unwrap().code,
        "INVALID_ANGLE"
    );
    // A failed transform passes its input through (§7.1): the slab is where it was.
    assert_eq!(r.parts[0].bodies[0].bbox_min, [-10.0, -5.0, 0.0]);
    // Bodies must be bodies.
    let mut h = slab();
    h.push(json!({ "type": "transform", "id": "t1", "name": "bad",
        "bodies": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } }, "translate": [1, 0, 0] }));
    assert_eq!(rejected(&doc(Value::Array(h))), "REF_KIND_MISMATCH");
}

#[test]
fn canonical_form_drops_the_zero_translation_and_a_false_copy() {
    let mut f = slab();
    f.push(
        json!({ "type": "transform", "id": "t1", "name": "turn", "bodies": body_ref("e1"),
        "translate": [0, 0, 0], "copy": false, "rotate": { "axis": "X", "angle": 90 } }),
    );
    let text = doc(Value::Array(f));
    let mut d: forge_ir::v1::Document = serde_json::from_str(&text).expect("parses");
    forge_ir::v1::canonicalize(&mut d);
    let v: Value = serde_json::to_value(&d).unwrap();
    let t = &v["parts"][0]["features"][2];
    assert!(t.get("translate").is_none(), "{t}");
    assert!(t.get("copy").is_none(), "{t}");
    assert_eq!(t["bodies"]["q"]["op"], "body");
}

mod props {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig { cases: 16, ..ProptestConfig::default() })]

        /// A rigid motion keeps volume, area and topology, and moves the centroid exactly.
        #[test]
        fn a_motion_keeps_the_body_and_moves_its_centroid(
            tx in -50.0f64..50.0, ty in -50.0f64..50.0, tz in -50.0f64..50.0,
            angle in -360.0f64..360.0, axis in 0usize..3,
        ) {
            let (tx, ty, tz, angle) = ((tx * 8.0).round() / 8.0, (ty * 8.0).round() / 8.0, (tz * 8.0).round() / 8.0, angle.round());
            let axes = ["X", "Y", "Z"];
            let mut f = slab();
            f.push(json!({ "type": "transform", "id": "t1", "name": "m", "bodies": body_ref("e1"),
                "rotate": { "axis": axes[axis], "angle": angle }, "translate": [tx, ty, tz] }));
            let r = run(&doc(Value::Array(f)));
            prop_assert_eq!(r.status, Status::Ok);
            let b = &r.parts[0].bodies[0];
            prop_assert!(close(b.volume, 1000.0));
            prop_assert!(close(b.area, 2.0 * (200.0 + 100.0 + 50.0)));
            prop_assert_eq!(b.faces, 6);
            // The slab's centroid (0, 0, 2.5) rotated about the axis through the origin, then shifted.
            let (s, c) = (angle.to_radians().sin(), angle.to_radians().cos());
            let p = [0.0, 0.0, 2.5];
            let rot = match axis {
                0 => [p[0], c * p[1] - s * p[2], s * p[1] + c * p[2]],
                1 => [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]],
                _ => [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]],
            };
            let want = [rot[0] + tx, rot[1] + ty, rot[2] + tz];
            for k in 0..3 {
                prop_assert!((b.centroid[k] - want[k]).abs() < 1e-7, "{:?} vs {:?}", b.centroid, want);
            }
        }
    }
}
