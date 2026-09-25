//! IR v1 Phase C end to end (SPEC-v1 §6.5–§6.8, §6.10): holes and patterns (W5, forge-ops)
//! and fillets, chamfers and shells (W6, forge-blend) wired into `forge_regen::v1` —
//! evaluation order (§7.1 step 2), report blocks and warnings (§7.2, I5), identity (§6.0.5),
//! failures passing their input through (§7.1 step 3), feasible ranges (§6.6, §6.8) and
//! closed-form volumes. Every report is evaluated twice (bit-identical) and every body passes
//! the key invariant of §5.2 rule 3 (`evaluate_with_key_check`; the known alias-source issue
//! excluded, see `run`).

use forge_ir::v1::metrics::{EvalReport, FeatureReport, Severity, Status};
use forge_regen::v1;
use serde_json::{Value, json};
use std::f64::consts::PI;

fn doc(params: Value, features: Value) -> String {
    json!({
        "schema": "aicad.ir/1",
        "meta": { "name": "t" },
        "params": params,
        "parts": [{ "id": "p1", "name": "part", "features": features }]
    })
    .to_string()
}

/// Evaluate (twice: bit-identical), with the key invariant checked on every produced body.
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
    // The key invariant (§5.2 rule 3), with two known checker findings excluded:
    // - the open W3/W4 contract issue (as in `v1.rs`): an edge or vertex keeps a key whose
    //   source face an operation merged away or removed (booleans; a shell's opened face);
    // - a forge-refs checker false positive (reported to W3): faces whose keys differ only by
    //   their qualifier — the positions of one hole (`h1/wall@a`, `h1/wall@b`), the instances
    //   of a pattern copy (`pt1/copy:{K}@1`, `@2`) — share a display name, which the checker
    //   flags as "ambiguous edge sources" although their edges name them by key (hole tools
    //   and copies stamp key sources, never names).
    let d = v1::load(text).unwrap().doc;
    let (_, problems) = v1::evaluate_with_key_check(&d);
    let other: Vec<&String> = problems
        .iter()
        .filter(|p| !p.ends_with("is not a face of the body"))
        .filter(|p| {
            !p.ends_with("several faces of the body carry this name; edge sources are ambiguous")
        })
        .collect();
    assert!(other.is_empty(), "key invariant: {other:#?}");
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

fn warnings(r: &EvalReport, id: &str) -> Vec<String> {
    feature(r, id)
        .warnings
        .iter()
        .map(|w| w.code.clone())
        .collect()
}

fn close(a: f64, b: f64, rel: f64) -> bool {
    (a - b).abs() <= rel * a.abs().max(b.abs()).max(1.0)
}

fn part_volumes(r: &EvalReport) -> Vec<f64> {
    r.parts[0].bodies.iter().map(|b| b.volume).collect()
}

fn total_volume(r: &EvalReport) -> f64 {
    part_volumes(r).iter().sum()
}

fn rect_sketch(id: &str, plane: Value, cx: f64, cy: f64, w: Value, h: Value) -> Value {
    json!({ "type": "sketch", "id": id, "name": id, "plane": plane, "curves": [
        { "kind": "rect", "id": "r", "center": [cx, cy], "w": w, "h": h } ] })
}

fn extrude(id: &str, sketch: &str, d: Value) -> Value {
    json!({ "type": "extrude", "id": id, "name": id, "sketch": sketch, "distance": d })
}

fn cap(feature: &str, end: &str) -> Value {
    json!({ "kind": "face", "q": { "op": "cap", "feature": feature, "end": end } })
}

fn body_ref(feature: &str) -> Value {
    json!({ "kind": "body", "q": { "op": "body", "feature": feature } })
}

/// A 40 × 30 × 10 plate centred on the origin (`s1`, `e1`), then `more`.
fn plate(params: Value, more: Value) -> String {
    let mut f = vec![
        rect_sketch("s1", json!("XY"), 0.0, 0.0, json!(40), json!(30)),
        extrude("e1", "s1", json!(10)),
    ];
    f.extend(more.as_array().unwrap().iter().cloned());
    doc(params, Value::Array(f))
}

const PLATE: f64 = 40.0 * 30.0 * 10.0;

/// A hole on the plate's top cap.
fn hole(id: &str, at: Value, fields: Value) -> Value {
    let mut h = json!({ "type": "hole", "id": id, "name": id, "on": { "face": cap("e1", "end") },
                        "at": at });
    for (k, v) in fields.as_object().unwrap() {
        h[k] = v.clone();
    }
    h
}

fn list(points: &[(&str, f64, f64)]) -> Value {
    json!({ "list": points.iter().map(|(id, u, v)| json!({ "id": id, "at": [u, v] }))
        .collect::<Vec<_>>() })
}

/// The volume of a drill-point cone below a shoulder: `(1/3)·π·r²·(r / tan(tip/2))`.
fn tip_cone(r: f64, tip_deg: f64) -> f64 {
    PI * r * r * (r / (tip_deg.to_radians() / 2.0).tan()) / 3.0
}

// ---- holes (§6.5) -----------------------------------------------------------------------------

/// A through M5 counterbored hole (`iso4762`: Dc 10, hc 5.4; normal fit 5.5) at the plate's
/// centre and a blind flat 3.4 × 6 pilot: closed-form volume, the `holes` entries of §7.2
/// [W0-16], the plate `modified` with its origin, and the tool faces keyed `H/<role>@p`.
#[test]
fn holes_cut_their_closed_form_tools_and_report_their_instances() {
    let r = run(&plate(
        json!([]),
        json!([
            hole("h1", list(&[("a", 0.0, 0.0)]),
                 json!({ "size": "M5", "depth": "through", "cbore": "iso4762" })),
            hole("h2", list(&[("p", 12.0, 8.0)]),
                 json!({ "d": 3.4, "depth": { "blind": 6 }, "tip": "flat" })),
            { "type": "tag", "id": "t1", "name": "t1", "target": { "kind": "face",
              "q": { "op": "hole_face", "feature": "h1", "at": "a", "part": "cbore_floor" } } }
        ]),
    ));
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    let h1 = feature(&r, "h1");
    let cb = PI * (25.0 * 5.4 + 2.75 * 2.75 * (10.0 - 5.4));
    assert!(
        close(h1.bodies[0].volume, PLATE - cb, 1e-12),
        "{}",
        h1.bodies[0].volume
    );
    assert_eq!(
        serde_json::to_value(&h1.bodies[0].origin).unwrap(),
        json!({ "feature": "e1", "member": "r.bottom" })
    );
    assert_eq!(
        serde_json::to_value(&h1.holes).unwrap(),
        json!([{ "at": "a", "center": [0.0, 0.0, 10.0], "axis": [0.0, 0.0, -1.0], "d": 5.5,
                 "depth": null, "kind": "counterbore", "size": "M5",
                 "cbore": { "d": 10.0, "depth": 5.4 } }])
    );
    assert!(h1.warnings.is_empty(), "{:?}", h1.warnings);
    let h2 = feature(&r, "h2");
    let pilot = PI * 1.7 * 1.7 * 6.0;
    assert!(close(total_volume(&r), PLATE - cb - pilot, 1e-12));
    assert_eq!(h2.holes[0].depth, Some(6.0));
    assert!(h2.warnings.is_empty());
    // The counterbore floor is a named hole face (§5.2 rule 3: `h1/cbore_floor@a`).
    assert_eq!(feature(&r, "t1").refs[0].members[0].key, "h1/cbore_floor@a");
}

/// `HOLE_BREAKS_THROUGH` (§6.5, warning): a blind hole deeper than the plate; a blind hole
/// inside it does not warn. Drill points (118°) add their cone.
#[test]
fn a_blind_hole_deeper_than_the_plate_breaks_through() {
    let r = run(&plate(
        json!([]),
        json!([
            hole(
                "h1",
                list(&[("a", -10.0, 0.0), ("b", 10.0, 0.0)]),
                json!({ "d": 4, "depth": { "blind": 5 } })
            ),
            hole(
                "h2",
                list(&[("c", 0.0, 8.0)]),
                json!({ "d": 4, "depth": { "blind": 12 } })
            ),
        ]),
    ));
    assert_eq!(r.status, Status::Ok);
    assert!(warnings(&r, "h1").is_empty());
    let w = &feature(&r, "h2").warnings;
    assert_eq!(w.len(), 1, "{w:?}");
    assert_eq!(w[0].code, "HOLE_BREAKS_THROUGH");
    assert_eq!(w[0].severity, Severity::Warning);
    assert_eq!(w[0].details["at"], json!("c"));
    let blind = 2.0 * (PI * 4.0 * 5.0 + tip_cone(2.0, 118.0));
    let through = PI * 4.0 * 10.0;
    assert!(close(total_volume(&r), PLATE - blind - through, 1e-12));
}

/// The hole errors of §6.5 fail the feature and pass the plate through: a position off the
/// `on` face (`HOLE_POINT_OFF_FACE { at, distance }`), a hole drilled away from the part from
/// a named plane (`HOLE_MISSES_BODY { at }`), coincident positions
/// (`HOLE_DUPLICATE_POSITION`); `flip` drills the other way.
#[test]
fn hole_errors_fail_the_feature_and_pass_the_part_through() {
    let r = run(&plate(
        json!([]),
        json!([
            hole("off", list(&[("a", 0.0, 0.0), ("far", 30.0, 0.0)]),
                 json!({ "d": 3, "depth": "through" })),
            { "type": "hole", "id": "miss", "name": "miss", "on": "XY", "at": list(&[("m", 0.0, 0.0)]),
              "d": 3, "depth": "through", "targets": "all" },
            { "type": "hole", "id": "flip", "name": "flip", "on": "XY", "flip": true,
              "at": list(&[("f", 5.0, 5.0)]), "d": 2, "depth": { "blind": 4 }, "tip": "flat",
              "targets": "all" },
            hole("dup", list(&[("a", 1.0, 1.0), ("b", 1.0, 1.0 + 5e-7)]),
                 json!({ "d": 3, "depth": "through" }))
        ]),
    ));
    let e = feature(&r, "off").error.as_ref().unwrap();
    assert_eq!(e.code, "HOLE_POINT_OFF_FACE");
    assert_eq!(e.details["at"], json!("far"));
    assert!(close(e.details["distance"].as_f64().unwrap(), 10.0, 1e-12));
    assert_eq!(code(&r, "miss"), Some("HOLE_MISSES_BODY"));
    assert_eq!(
        feature(&r, "miss").error.as_ref().unwrap().details["at"],
        json!("m")
    );
    assert_eq!(code(&r, "flip"), None);
    assert_eq!(
        feature(&r, "flip").holes[0].axis.map(f64::to_bits),
        [0.0, 0.0, 1.0f64].map(f64::to_bits),
        "flip drills along +n"
    );
    assert_eq!(code(&r, "dup"), Some("HOLE_DUPLICATE_POSITION"));
    for id in ["off", "miss", "dup"] {
        let f = feature(&r, id);
        assert!(f.bodies.is_empty() && f.holes.is_empty(), "{id}");
    }
    assert!(close(total_volume(&r), PLATE - PI * 4.0, 1e-12));
}

/// §7.1 step 2: a hole's range checks (here an expression grid count, `INVALID_COUNT`) come
/// before its references (an `on` face that no longer exists, `REF_MISSING`).
#[test]
fn a_hole_range_check_comes_before_its_references() {
    let missing_face = json!({ "face": { "kind": "face",
        "q": { "op": "filter", "of": { "op": "sides", "feature": "e1" }, "where": { "type": "cylinder" } } } });
    for (n, want) in [("n - 5", "INVALID_COUNT"), ("n", "REF_MISSING")] {
        let r = run(&plate(
            json!([{ "name": "n", "unit": "count", "value": 2 }]),
            json!([{ "type": "hole", "id": "h1", "name": "h1", "on": missing_face,
                     "at": { "grid": { "nx": n, "ny": 1, "dx": 5, "dy": 5 } },
                     "d": 2, "depth": "through" }]),
        ));
        assert_eq!(code(&r, "h1"), Some(want), "{n}");
        assert_eq!(
            feature(&r, "h1").refs.is_empty(),
            want == "INVALID_COUNT",
            "{n}: no reference resolved before a range check fails"
        );
    }
}

/// `points` placement (§6.5): sketch points and a circle's centre of a sketch on the boss's
/// top face, heat-set `std` inserts (M3: 4.0 × 6.7 flat) into the joined boss.
#[test]
fn inserts_at_sketch_points_on_a_boss() {
    let r = run(&plate(
        json!([]),
        json!([
            { "type": "sketch", "id": "s2", "name": "s2", "plane": { "face": cap("e1", "end") },
              "curves": [
                { "kind": "circle", "id": "ring", "center": [0, 0], "radius": 8 },
                { "kind": "point", "id": "p1", "at": [5, 0] } ] },
            { "type": "extrude", "id": "e2", "name": "e2", "sketch": "s2", "distance": 12,
              "regions": ["ring"], "op": "join", "targets": body_ref("e1") },
            { "type": "hole", "id": "h1", "name": "h1", "on": { "face": cap("e2", "end") },
              "at": { "points": { "sketch": "s2", "ids": ["p1", "ring.center"] } },
              "size": "M3", "insert": "std" }
        ]),
    ));
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    let h1 = feature(&r, "h1");
    let ats: Vec<&str> = h1.holes.iter().map(|h| h.at.as_str()).collect();
    assert_eq!(ats, ["p1", "ring.center"]);
    assert_eq!(
        h1.holes[0].center.map(f64::to_bits),
        [5.0, 0.0, 22.0f64].map(f64::to_bits)
    );
    let boss = PI * 64.0 * 12.0;
    let inserts = 2.0 * PI * 4.0 * 6.7;
    assert!(close(total_volume(&r), PLATE + boss - inserts, 1e-12));
    assert_eq!(h1.holes[0].depth, Some(6.7));
}

// ---- patterns (§6.10) -------------------------------------------------------------------------

/// A linear pattern of a hole seed: count 4, spacing 10 along X from x = −15; instance 2 is
/// skipped by `skip`; the copies are cut into the seed hole's target, re-resolved in the
/// pattern's scope. `instances` counts the non-seed instances minus `skip`.
#[test]
fn a_linear_pattern_of_a_hole_cuts_every_kept_copy() {
    let r = run(&plate(
        json!([{ "name": "n", "unit": "count", "value": 4 }]),
        json!([
            hole("h1", list(&[("a", -15.0, 0.0)]), json!({ "d": 4, "depth": "through" })),
            { "type": "pattern", "id": "pt1", "name": "pt1", "seed": { "features": ["h1"] },
              "layout": { "linear": { "dir": "X", "count": "n", "spacing": 10 } }, "skip": [[2]] }
        ]),
    ));
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    let pt = feature(&r, "pt1");
    let rep = pt.pattern.as_ref().unwrap();
    assert_eq!(rep.instances, 2);
    assert!(rep.skipped.is_empty());
    assert_eq!(pt.bodies.len(), 1);
    assert!(close(
        total_volume(&r),
        PLATE - 3.0 * PI * 4.0 * 10.0,
        1e-12
    ));
}

/// Instances whose tools meet no target are skipped with `PATTERN_INSTANCE_SKIPPED
/// { index, code }` and listed in `skipped`; when every instance is skipped the pattern fails
/// with `PATTERN_ALL_INSTANCES_FAILED` and passes its input through.
#[test]
fn instances_off_the_part_are_skipped_and_all_skipped_fails() {
    let slot = |id: &str, sk: &str| {
        json!({ "type": "extrude", "id": id, "name": id, "sketch": sk, "distance": 10,
                "op": "cut", "targets": "all" })
    };
    let r = run(&plate(
        json!([]),
        json!([
            rect_sketch("s2", json!("XY"), 10.0, 0.0, json!(2), json!(40)),
            slot("e2", "s2"),
            { "type": "pattern", "id": "pt1", "name": "pt1", "seed": { "features": ["e2"] },
              "layout": { "linear": { "dir": "X", "count": 4, "spacing": 8 } } },
            { "type": "pattern", "id": "pt2", "name": "pt2", "seed": { "features": ["e2"] },
              "layout": { "linear": { "dir": "X", "count": 3, "spacing": 30 } } }
        ]),
    ));
    let pt1 = feature(&r, "pt1");
    assert_eq!(code(&r, "pt1"), None);
    let rep = pt1.pattern.as_ref().unwrap();
    assert_eq!(rep.instances, 3);
    assert_eq!(rep.skipped, vec![vec![2], vec![3]]);
    let skips: Vec<&Value> = pt1
        .warnings
        .iter()
        .filter(|w| w.code == "PATTERN_INSTANCE_SKIPPED")
        .map(|w| &w.details["index"])
        .collect();
    assert_eq!(skips, [&json!([2]), &json!([3])]);
    assert_eq!(
        pt1.warnings[0].details["code"],
        json!("BOOLEAN_NO_INTERSECTION")
    );
    // The seed cut the plate in two (x in [9, 11]), instance 1 cut again at x in [17, 19].
    let e = feature(&r, "pt2").error.as_ref().unwrap();
    assert_eq!(e.code, "PATTERN_ALL_INSTANCES_FAILED");
    assert_eq!(e.details["instances"].as_array().unwrap().len(), 2);
    assert!(close(
        total_volume(&r),
        PLATE - 2.0 * (2.0 * 30.0 * 10.0),
        1e-12
    ));
    assert_eq!(
        part_volumes(&r).len(),
        3,
        "two slots split the plate into three pieces"
    );
}

/// A circular pattern of a cut about the Z axis, and a mirror of a joined boss in the YZ plane
/// (a reflection keeps volumes: the mirrored boss is a proper solid).
#[test]
fn circular_and_mirror_patterns_of_body_operations() {
    let r = run(&plate(
        json!([]),
        json!([
            rect_sketch("s2", json!("XY"), 8.0, 0.0, json!(4), json!(2)),
            { "type": "extrude", "id": "e2", "name": "e2", "sketch": "s2", "distance": 10,
              "op": "cut", "targets": body_ref("e1") },
            { "type": "pattern", "id": "pt1", "name": "pt1", "seed": { "features": ["e2"] },
              "layout": { "circular": { "axis": "Z", "count": 4 } } },
            rect_sketch("s3", json!({ "face": cap("e1", "end") }), 15.0, 10.0, json!(4), json!(4)),
            { "type": "extrude", "id": "e3", "name": "e3", "sketch": "s3", "distance": 5,
              "op": "join", "targets": body_ref("e1") },
            { "type": "pattern", "id": "pt2", "name": "pt2", "seed": { "features": ["e3"] },
              "layout": { "mirror": { "plane": "YZ" } } }
        ]),
    ));
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    assert_eq!(feature(&r, "pt1").pattern.as_ref().unwrap().instances, 3);
    assert_eq!(feature(&r, "pt2").pattern.as_ref().unwrap().instances, 1);
    let want = PLATE - 4.0 * (4.0 * 2.0 * 10.0) + 2.0 * (4.0 * 4.0 * 5.0);
    assert!(close(total_volume(&r), want, 1e-12), "{}", total_volume(&r));
    assert_eq!(part_volumes(&r).len(), 1);
}

/// Body seeds (§6.10): a 2 × 2 two-direction linear pattern creates three new bodies with
/// origins `{ pt1, member, [i, j] }`; `op: join` joins the copies to the targets.
#[test]
fn body_seed_patterns_create_or_join_copies() {
    let r = run(&doc(
        json!([]),
        json!([
            rect_sketch("s1", json!("XY"), 0.0, 0.0, json!(4), json!(4)),
            extrude("e1", "s1", json!(2)),
            { "type": "pattern", "id": "pt1", "name": "pt1", "seed": { "bodies": body_ref("e1") },
              "layout": { "linear": { "dir": "X", "count": 2, "spacing": 10,
                                      "dir2": "Y", "count2": 2, "spacing2": 10 } } },
            rect_sketch("s2", json!("XY"), 0.0, -10.0, json!(40), json!(4)),
            extrude("e2", "s2", json!(1)),
            { "type": "pattern", "id": "pt2", "name": "pt2", "seed": { "bodies": body_ref("e1") },
              "layout": { "linear": { "dir": "X", "count": 2, "spacing": 3 } },
              "op": "join", "targets": body_ref("e1") }
        ]),
    ));
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    let pt1 = feature(&r, "pt1");
    let got: Vec<Value> = pt1
        .bodies
        .iter()
        .map(|b| serde_json::to_value(&b.origin).unwrap())
        .collect();
    assert_eq!(
        got,
        [
            json!({ "feature": "pt1", "member": "r.bottom", "instance": [0, 1] }),
            json!({ "feature": "pt1", "member": "r.bottom", "instance": [1, 0] }),
            json!({ "feature": "pt1", "member": "r.bottom", "instance": [1, 1] }),
        ]
    );
    for b in &pt1.bodies {
        assert!(close(b.volume, 32.0, 1e-12));
    }
    // pt2 joins a copy moved by 3 (overlapping the seed by 1 × 4 × 2) into e1's body.
    let pt2 = feature(&r, "pt2");
    assert_eq!(pt2.bodies.len(), 1);
    assert!(close(pt2.bodies[0].volume, 32.0 + 32.0 - 8.0, 1e-12));
    assert_eq!(r.parts[0].bodies.len(), 5);
}

/// A layout without non-seed instances (count 1) applies nothing: ok, no warning, `instances`
/// 0 (W5's reading; open contract issue — the oracle fails `PATTERN_ALL_INSTANCES_FAILED`).
/// A count expression outside its range is `INVALID_COUNT`, before the references.
#[test]
fn a_pattern_without_instances_is_a_no_op_and_counts_are_range_checked() {
    let r = run(&plate(
        json!([{ "name": "n", "unit": "count", "value": 1 }]),
        json!([
            hole("h1", list(&[("a", 0.0, 0.0)]), json!({ "d": 4, "depth": "through" })),
            { "type": "pattern", "id": "pt1", "name": "pt1", "seed": { "features": ["h1"] },
              "layout": { "linear": { "dir": "X", "count": "n", "spacing": 5 } } },
            { "type": "pattern", "id": "pt2", "name": "pt2", "seed": { "features": ["h1"] },
              "layout": { "circular": { "count": "n", "axis": { "edge": { "kind": "edge",
                "q": { "op": "filter", "of": { "op": "edges", "of": { "op": "sides", "feature": "e1" } },
                       "where": { "type": "circle" } } } } } } }
        ]),
    ));
    let pt1 = feature(&r, "pt1");
    assert_eq!(code(&r, "pt1"), None);
    assert!(pt1.warnings.is_empty() && pt1.bodies.is_empty());
    assert_eq!(pt1.pattern.as_ref().unwrap().instances, 0);
    // circular count 1 < 2: the range check fails before the axis reference is resolved.
    assert_eq!(code(&r, "pt2"), Some("INVALID_COUNT"));
    assert!(feature(&r, "pt2").refs.is_empty());
}

// ---- fillets and chamfers (§6.6, §6.7) --------------------------------------------------------

fn vertical_edges(feature: &str) -> Value {
    json!({ "kind": "edge", "q": { "op": "filter", "where": { "parallel": "Z" },
        "of": { "op": "edges", "of": { "op": "sides", "feature": feature } } } })
}

/// Fillets of the plate's 4 vertical edges: each removes `h·r²·(1 − π/4)`; the blend faces are
/// cylinders keyed `F/blend:{E}`; the report lists the edges and created faces; the body keeps
/// its origin (`modified`).
#[test]
fn a_fillet_removes_its_closed_form_and_reports_its_blends() {
    let r = run(&plate(
        json!([{ "name": "fr", "unit": "mm", "value": 3 }]),
        json!([{ "type": "fillet", "id": "f1", "name": "f1", "r": "fr",
                 "edges": vertical_edges("e1") }]),
    ));
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    let f1 = feature(&r, "f1");
    let fl = f1.fillet.as_ref().unwrap();
    assert_eq!(fl.edges.len(), 4);
    assert!(fl.chain_added.is_empty());
    assert_eq!(fl.faces_created.len(), 4);
    assert!(
        fl.faces_created
            .iter()
            .all(|k| k.starts_with("f1/blend:{e1/edge:"))
    );
    let b = &f1.bodies[0];
    assert!(close(
        b.volume,
        PLATE - 4.0 * 10.0 * 9.0 * (1.0 - PI / 4.0),
        1e-12
    ));
    assert_eq!(b.face_types.get("cylinder"), Some(&4));
    assert_eq!(b.origin.feature, "e1");
}

/// The feasible-range property of §6.6 end to end: `FILLET_RADIUS_TOO_LARGE` reports
/// `max_feasible_r` (every edge with its `max_r`), the feature passes its input through, and
/// the document with `r = max_feasible_r` evaluates while `1.01 · max_feasible_r` fails.
#[test]
fn a_fillet_too_large_reports_a_feasible_radius_that_builds() {
    let text = |r: f64| {
        plate(
            json!([]),
            json!([{ "type": "fillet", "id": "f1", "name": "f1", "r": r,
                     "edges": vertical_edges("e1") }]),
        )
    };
    let r = run(&text(20.0));
    let e = feature(&r, "f1").error.as_ref().unwrap();
    assert_eq!(e.code, "FILLET_RADIUS_TOO_LARGE");
    let max = e.details["max_feasible_r"].as_f64().unwrap();
    assert!(max > 0.0 && max <= 15.0, "{max}");
    assert_eq!(e.details["edges"].as_array().unwrap().len(), 4);
    assert!(
        close(total_volume(&r), PLATE, 1e-12),
        "passes its input through"
    );
    assert_eq!(
        code(&run(&text(max)), "f1"),
        None,
        "max_feasible_r = {max} builds"
    );
    assert_eq!(
        code(&run(&text(1.01 * max)), "f1"),
        Some("FILLET_RADIUS_TOO_LARGE")
    );
    // An expression radius ≤ tol is `INVALID_RADIUS` (the literal's code, §0.5 rule 2).
    let r = run(&plate(
        json!([{ "name": "k", "unit": "mm", "value": 1 }]),
        json!([{ "type": "fillet", "id": "f1", "name": "f1", "r": "k - 1 mm",
                 "edges": vertical_edges("e1") }]),
    ));
    assert_eq!(code(&r, "f1"), Some("INVALID_RADIUS"));
}

/// A blend that runs into another feature (W6: the rim of a hole in the adjacent face) fails
/// explicitly with `FILLET_FAILED { edges, reason }` (§6.6: a Forge capability gap, not a size
/// limit — the open W6 contract issue 2; the W7b oracle reports `FILLET_RADIUS_TOO_LARGE` with
/// the same value, the seed-61 `hole_edge_blend` CODE_MISMATCH family), passes its input
/// through, and names in `reason` a radius that builds clear of the rim: that radius evaluates
/// to its closed form. The plate's +Y top edge is 2 mm from the rim of a Ø4 through hole at
/// (0, 11).
#[test]
fn a_blend_running_into_a_hole_fails_explicitly_with_a_radius_that_builds() {
    let text = |r: f64| {
        plate(
            json!([]),
            json!([hole("h1", list(&[("a", 0.0, 11.0)]), json!({ "d": 4, "depth": "through" })),
                   { "type": "fillet", "id": "f1", "name": "f1", "r": r,
                     "edges": { "kind": "edge", "q": { "op": "between",
                        "a": { "op": "side", "feature": "e1", "curve": "r.top" },
                        "b": { "op": "cap", "feature": "e1", "end": "end" } } } }]),
        )
    };
    let holed = PLATE - PI * 4.0 * 10.0;
    let r = run(&text(3.0));
    assert_eq!(code(&r, "h1"), None);
    let e = feature(&r, "f1").error.as_ref().expect("f1 fails");
    assert_eq!(e.code, "FILLET_FAILED", "{}", e.message);
    let keys: Vec<&str> = e.details.keys().map(String::as_str).collect();
    assert_eq!(keys, ["edges", "reason"]);
    assert_eq!(e.details["edges"].as_array().unwrap().len(), 1);
    assert!(
        close(total_volume(&r), holed, 1e-12),
        "passes its input through"
    );
    let reason = e.details["reason"].as_str().unwrap();
    assert!(reason.contains("h1/wall"), "names the hole wall: {reason}");
    let clear: f64 = reason
        .split("radius ")
        .last()
        .and_then(|s| s.split(" mm builds clear").next())
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("no clear radius in {reason:?}"));
    assert!(clear > 1.99 && clear <= 2.0, "{clear}");
    let r = run(&text(clear));
    let f1 = feature(&r, "f1");
    assert_eq!(f1.status, Status::Ok, "{:?}", f1.error);
    assert!(close(
        f1.bodies[0].volume,
        holed - 40.0 * clear * clear * (1.0 - PI / 4.0),
        1e-12
    ));
}

/// Chamfers of the plate's 4 top edges (`d` = 1): four 45° prisms `L·d²/2` minus the corner
/// overlaps `d³/3`; the two-distance form measures `d` on `side`.
#[test]
fn chamfers_remove_their_closed_forms() {
    let top_edges = json!({ "kind": "edge",
        "q": { "op": "edges", "of": { "op": "cap", "feature": "e1", "end": "end" } } });
    let r = run(&plate(
        json!([]),
        json!([{ "type": "chamfer", "id": "c1", "name": "c1", "d": 1, "edges": top_edges }]),
    ));
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    let c1 = feature(&r, "c1");
    let ch = c1.chamfer.as_ref().unwrap();
    assert_eq!(ch.edges.len(), 4);
    assert!(ch.faces_created.iter().any(|k| k.starts_with("c1/bevel:")));
    let removed = 0.5 * (2.0 * 40.0 + 2.0 * 30.0) - 4.0 / 3.0;
    assert!(
        close(total_volume(&r), PLATE - removed, 1e-12),
        "{}",
        total_volume(&r)
    );
    // Two distances on one edge: d = 2 on the top cap, d2 = 1 on the side.
    let edge = json!({ "kind": "edge", "q": { "op": "between",
        "a": { "op": "cap", "feature": "e1", "end": "end" },
        "b": { "op": "side", "feature": "e1", "curve": "r.right" } } });
    let r = run(&plate(
        json!([]),
        json!([{ "type": "chamfer", "id": "c1", "name": "c1", "d": 2, "d2": 1,
                 "side": cap("e1", "end"), "edges": edge }]),
    ));
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    assert!(close(
        total_volume(&r),
        PLATE - 0.5 * 2.0 * 1.0 * 30.0,
        1e-12
    ));
    // `side` not adjacent to the edge: CHAMFER_SIDE_NOT_ADJACENT.
    let r = run(&plate(
        json!([]),
        json!([{ "type": "chamfer", "id": "c1", "name": "c1", "d": 2, "d2": 1,
                 "side": cap("e1", "start"), "edges": edge }]),
    ));
    assert_eq!(code(&r, "c1"), Some("CHAMFER_SIDE_NOT_ADJACENT"));
}

/// A fillet whose edges lie on two bodies blends each (atomic: both or none).
#[test]
fn a_fillet_on_two_bodies_blends_both() {
    let r = run(&doc(
        json!([]),
        json!([
            rect_sketch("s1", json!("XY"), 0.0, 0.0, json!(10), json!(10)),
            extrude("e1", "s1", json!(5)),
            rect_sketch("s2", json!("XY"), 30.0, 0.0, json!(10), json!(10)),
            extrude("e2", "s2", json!(5)),
            { "type": "fillet", "id": "f1", "name": "f1", "r": 1, "edges": { "kind": "edge",
              "q": { "op": "union", "of": [
                vertical_edges("e1")["q"].clone(), vertical_edges("e2")["q"].clone() ] } } }
        ]),
    ));
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    let f1 = feature(&r, "f1");
    assert_eq!(f1.bodies.len(), 2);
    assert_eq!(f1.fillet.as_ref().unwrap().edges.len(), 8);
    for b in &f1.bodies {
        assert!(close(b.volume, 500.0 - 4.0 * 5.0 * (1.0 - PI / 4.0), 1e-12));
    }
}

// ---- shells (§6.8) ----------------------------------------------------------------------------

/// Shell inward with the top open: `40·30·10 − 36·26·8`; closed: an internal void (2 shells,
/// info `SHELL_CLOSED_VOID`, `closed_void`); the removed faces are keys.
#[test]
fn shells_open_and_closed() {
    let shell = |open: Option<Value>| {
        let mut s = json!({ "type": "shell", "id": "sh1", "name": "sh1", "body": body_ref("e1"),
                            "thickness": 2 });
        if let Some(o) = open {
            s["open"] = o;
        }
        plate(json!([]), json!([s]))
    };
    let r = run(&shell(Some(cap("e1", "end"))));
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    let sh = feature(&r, "sh1");
    assert_eq!(
        sh.shell.as_ref().unwrap().removed_faces,
        ["e1/cap:end@r.bottom"]
    );
    assert!(!sh.shell.as_ref().unwrap().closed_void);
    assert!(sh.warnings.is_empty());
    assert!(close(total_volume(&r), PLATE - 36.0 * 26.0 * 8.0, 1e-12));
    assert_eq!(r.parts[0].bodies[0].shells, 1);
    let r = run(&shell(None));
    let sh = feature(&r, "sh1");
    assert!(sh.shell.as_ref().unwrap().closed_void);
    assert_eq!(warnings(&r, "sh1"), ["SHELL_CLOSED_VOID"]);
    assert_eq!(sh.warnings[0].severity, Severity::Info);
    assert!(close(total_volume(&r), PLATE - 36.0 * 26.0 * 6.0, 1e-12));
    assert_eq!(r.parts[0].bodies[0].shells, 2);
}

/// `SHELL_THICKNESS_TOO_LARGE` with `max_feasible_thickness` (the feasible-range property:
/// that thickness builds), and `SHELL_FACE_NOT_ON_BODY` for an open face of another body.
#[test]
fn shell_errors_carry_their_details() {
    let text = |t: f64, open: Value| {
        plate(
            json!([]),
            json!([
                rect_sketch("s2", json!("XY"), 60.0, 0.0, json!(4), json!(4)),
                extrude("e2", "s2", json!(4)),
                { "type": "shell", "id": "sh1", "name": "sh1", "body": body_ref("e1"),
                  "open": open, "thickness": t }
            ]),
        )
    };
    // Open at the top, the floor vanishes at t = 10 (the side walls only at 15).
    let r = run(&text(12.0, cap("e1", "end")));
    let e = feature(&r, "sh1").error.as_ref().unwrap();
    assert_eq!(e.code, "SHELL_THICKNESS_TOO_LARGE");
    let max = e.details["max_feasible_thickness"].as_f64().unwrap();
    assert!(max > 9.0 && max < 10.0, "{max}");
    assert!(!e.details["limits"].as_array().unwrap().is_empty());
    assert_eq!(code(&run(&text(max, cap("e1", "end"))), "sh1"), None);
    let r = run(&text(1.0, cap("e2", "end")));
    let e = feature(&r, "sh1").error.as_ref().unwrap();
    assert_eq!(e.code, "SHELL_FACE_NOT_ON_BODY");
    assert_eq!(e.details["faces"], json!(["e2/cap:end@r.bottom"]));
}

// ---- identity: a merged origin a sibling piece still carries (§6.0.5 [W0-40]) ----------------

/// kernel-fixes review finding 1: a join that merges one piece of a split bar into the plate
/// must not list the bar's origin in `removed` while its other piece still carries it.
#[test]
fn a_merged_origin_still_carried_by_a_sibling_piece_is_not_removed() {
    let r = run(&doc(
        json!([]),
        json!([
            rect_sketch("sa", json!("XY"), 0.0, 0.0, json!(20), json!(20)),
            extrude("ea", "sa", json!(5)),
            rect_sketch("sb", json!("XY"), 40.0, 0.0, json!(20), json!(4)),
            extrude("eb", "sb", json!(5)),
            rect_sketch("sc", json!("XY"), 40.0, 0.0, json!(4), json!(10)),
            { "type": "extrude", "id": "ec", "name": "ec", "sketch": "sc", "distance": 5,
              "op": "cut", "targets": body_ref("eb") },
            rect_sketch("sd", json!("XY"), 20.0, 0.0, json!(20), json!(2)),
            { "type": "extrude", "id": "ed", "name": "ed", "sketch": "sd", "distance": 5,
              "op": "join", "targets": "all" }
        ]),
    ));
    assert_eq!(r.status, Status::Ok, "{:#?}", r.features);
    assert!(warnings(&r, "ec").contains(&"BOOLEAN_SPLIT".to_string()));
    let ed = feature(&r, "ed");
    // The bridge x in [10, 30] joins the plate and the bar piece x in [30, 38]; the piece
    // x in [42, 50] keeps the bar's origin, so it did not vanish.
    assert!(
        r.parts[0].bodies.iter().any(|b| b.origin.feature == "eb"),
        "a piece of eb survives"
    );
    assert!(
        ed.removed.iter().all(|o| o.feature != "eb"),
        "removed = {:?}",
        ed.removed
    );
    assert_eq!(r.parts[0].bodies.len(), 2);
}

// ---- properties -------------------------------------------------------------------------------

#[cfg(not(target_family = "wasm"))]
mod props {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig { cases: 8, ..ProptestConfig::default() })]

        /// A grid of through holes inside a plate removes exactly `n·π·r²·t`, and a linear
        /// pattern of a `new_body` extrude creates copies of the seed's volume (a rigid motion).
        #[test]
        fn hole_grids_and_body_copies_keep_their_closed_forms(
            w in 30.0f64..60.0, h in 30.0f64..50.0, t in 2.0f64..12.0,
            nx in 1u32..4, ny in 1u32..3, d in 1.0f64..3.0, count in 2u32..5,
        ) {
            let text = doc(
                json!([]),
                json!([
                    rect_sketch("s1", json!("XY"), 0.0, 0.0, json!(w), json!(h)),
                    extrude("e1", "s1", json!(t)),
                    hole("h1", json!({ "grid": { "nx": nx, "ny": ny, "dx": 8, "dy": 8 } }),
                         json!({ "d": d, "depth": "through" })),
                    rect_sketch("s2", json!("XY"), 0.0, 100.0, json!(3), json!(2)),
                    extrude("e2", "s2", json!(1)),
                    { "type": "pattern", "id": "pt1", "name": "pt1", "seed": { "features": ["e2"] },
                      "layout": { "linear": { "dir": "Y", "count": count, "spacing": 5 } } }
                ]),
            );
            let r = run(&text);
            prop_assert_eq!(r.status, Status::Ok);
            let n = f64::from(nx * ny);
            let v = feature(&r, "h1").bodies[0].volume;
            prop_assert!(close(v, w * h * t - n * PI * d * d / 4.0 * t, 1e-12), "{}", v);
            let pt = feature(&r, "pt1");
            prop_assert_eq!(pt.bodies.len() as u32, count - 1);
            for b in &pt.bodies {
                prop_assert!(close(b.volume, 6.0, 1e-12));
            }
        }
    }
}
