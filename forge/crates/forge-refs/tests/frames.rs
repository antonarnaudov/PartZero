//! Plane references and face frames (SPEC-v1 §3.1), axis references (§3.2), `datum_plane`
//! (§3.3) and `datum_axis` (§3.4).
// Expected values are exact on purpose (closed forms, bit-exact frames).
#![allow(clippy::float_cmp)]

mod common;

use common::{half_cone, plate};
use forge_ir::v1::{AxisRef, Feature, PlaneRef, PointRef};
use forge_refs::{
    AxisLine, DatumValue, FeatureInfo, FeatureStatus, PlaneFrame, Scope, axis, datum_axis,
    datum_plane, plane_frame, point,
};
use serde_json::{Value, json};

fn plane(v: Value) -> PlaneRef {
    serde_json::from_value(v).expect("plane ref")
}

fn face(q: Value) -> Value {
    json!({ "face": { "kind": "face", "q": q } })
}

fn frame(s: &Scope<'_>, v: Value) -> PlaneFrame {
    let ev = plane_frame(&plane(v), s, "/plane");
    ev.result.unwrap_or_else(|e| panic!("{e}"))
}

fn close(a: [f64; 3], b: [f64; 3]) -> bool {
    (0..3).all(|i| (a[i] - b[i]).abs() <= 1e-12)
}

#[test]
fn face_frames_follow_the_spec_table() {
    let m = plate();
    let s = m.scope();
    let side = |c: &str| face(json!({ "op": "side", "feature": "e1", "curve": c }));
    let cap = |e: &str| face(json!({ "op": "cap", "feature": "e1", "end": e }));
    // Outward normal → (x, y), SPEC §3.1 table.
    let rows = [
        (
            cap("end"),
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 5.0],
        ),
        (
            cap("start"),
            [0.0, 0.0, -1.0],
            [1.0, 0.0, 0.0],
            [0.0, -1.0, 0.0],
            [0.0, 0.0, 0.0],
        ),
        (
            side("bottom"),
            [0.0, -1.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, -10.0, 0.0],
        ),
        (
            side("top"),
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, -1.0],
            [0.0, 10.0, 0.0],
        ),
        (
            side("right"),
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [20.0, 0.0, 0.0],
        ),
        (
            side("left"),
            [-1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, -1.0],
            [-20.0, 0.0, 0.0],
        ),
    ];
    for (pr, n, x, y, o) in rows {
        let f = frame(&s, pr.clone());
        assert!(close(f.normal, n), "{pr}: {f:?}");
        assert!(close(f.x, x), "{pr}: {f:?}");
        assert!(close(f.y, y), "{pr}: {f:?}");
        assert!(close(f.origin, o), "{pr}: {f:?}");
    }
    // The top cap's frame is the XY frame shifted to the cap.
    let xy = frame(&s, json!("XY"));
    let top = frame(&s, cap("end"));
    assert_eq!((xy.x, xy.y, xy.normal), (top.x, top.y, top.normal));
}

#[test]
fn face_frame_origin_and_x_dir_are_projected() {
    let m = plate();
    let s = m.scope();
    let mut v = face(json!({ "op": "cap", "feature": "e1", "end": "end" }));
    v["origin"] = json!([3, 4, 100]);
    v["x_dir"] = json!([1, 1, 7]);
    let f = frame(&s, v);
    assert!(close(f.origin, [3.0, 4.0, 5.0]), "{f:?}");
    let h = std::f64::consts::FRAC_1_SQRT_2;
    assert!(close(f.x, [h, h, 0.0]), "{f:?}");
    // An x_dir along the normal projects to nothing.
    let mut v = face(json!({ "op": "side", "feature": "e1", "curve": "bottom" }));
    v["x_dir"] = json!([0, 3, 0]);
    let ev = plane_frame(&plane(v), &s, "/plane");
    assert_eq!(
        ev.result.expect_err("degenerate").code(),
        "PLANE_DEGENERATE"
    );
}

#[test]
fn a_failed_face_reference_fails_the_plane_with_its_code() {
    let m = plate();
    let s = m.scope();
    let v = face(json!({ "op": "filter", "where": { "type": "plane" },
                         "of": { "op": "faces", "of": { "op": "body", "feature": "e1" } } }));
    let ev = plane_frame(&plane(v), &s, "/plane");
    assert_eq!(ev.result.expect_err("ambiguous").code(), "REF_AMBIGUOUS");
    assert_eq!(ev.refs[0].report.field, "/plane/face");
}

#[test]
fn named_explicit_and_datum_planes() {
    let m = plate();
    let mut t = m.table.clone();
    let mut d = FeatureInfo::new("dp1", "above", "datum_plane");
    d.datum = Some(DatumValue::Plane(PlaneFrame {
        origin: [0.0, 0.0, 3.0],
        x: [1.0, 0.0, 0.0],
        y: [0.0, 1.0, 0.0],
        normal: [0.0, 0.0, 1.0],
    }));
    t.push(d);
    let s = m.scope_with(t.clone());
    let xz = frame(&s, json!("XZ"));
    assert_eq!(
        (xz.x, xz.y, xz.normal),
        ([1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0])
    );
    let f = frame(
        &s,
        json!({ "origin": [1, 2, 3], "normal": [0, 0, 2], "x_dir": [0, 3, 0] }),
    );
    assert_eq!(
        (f.x, f.y, f.normal),
        ([0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0])
    );
    assert_eq!(frame(&s, json!({ "datum": "dp1" })).origin, [0.0, 0.0, 3.0]);
    t.get_mut("dp1").expect("dp1").status = FeatureStatus::Suppressed;
    let s = m.scope_with(t.clone());
    let e = plane_frame(&plane(json!({ "datum": "dp1" })), &s, "/plane")
        .result
        .expect_err("suppressed");
    assert_eq!(e.code(), "DEPENDENCY_SUPPRESSED");
    t.get_mut("dp1").expect("dp1").status = FeatureStatus::Failed {
        code: "DATUM_DEGENERATE".into(),
        message: "x".into(),
    };
    let s = m.scope_with(t);
    let e = plane_frame(&plane(json!({ "datum": "dp1" })), &s, "/plane")
        .result
        .expect_err("failed");
    assert_eq!(e.code(), "DEPENDENCY_FAILED");
}

fn ax(s: &Scope<'_>, v: Value) -> Result<AxisLine, forge_refs::RefError> {
    let a: AxisRef = serde_json::from_value(v).expect("axis ref");
    axis(&a, s, "/axis").result
}

#[test]
fn axis_references() {
    let m = plate();
    let s = m.scope();
    assert_eq!(ax(&s, json!("Y")).expect("Y").direction, [0.0, 1.0, 0.0]);
    // A vertical line edge: the point closest to the world origin, sign-canonical +Z.
    let e = ax(
        &s,
        json!({ "edge": { "kind": "edge",
        "q": { "op": "edge_at", "feature": "e1", "curve": "bottom", "end": "end" } } }),
    )
    .expect("edge axis");
    assert_eq!(e.origin, [20.0, -10.0, 0.0]);
    assert_eq!(e.direction, [0.0, 0.0, 1.0]);
    // A circular edge: its centre and normal; a cylinder: its axis.
    let c = ax(
        &s,
        json!({ "edge": { "kind": "edge", "q": { "op": "between",
        "a": { "op": "side", "feature": "e1", "curve": "ring" },
        "b": { "op": "cap", "feature": "e1", "end": "end" } } } }),
    )
    .expect("circle axis");
    assert_eq!(c.origin, [10.0, 0.0, 5.0]);
    assert_eq!(c.direction, [0.0, 0.0, 1.0]);
    let y = ax(
        &s,
        json!({ "cylinder": { "kind": "face",
        "q": { "op": "side", "feature": "e1", "curve": "ring" } }, "flip": true }),
    )
    .expect("cylinder axis");
    assert_eq!(y.origin, [10.0, 0.0, 0.0]);
    assert_eq!(y.direction, [0.0, 0.0, -1.0], "flip reverses");
    let bad = ax(
        &s,
        json!({ "cylinder": { "kind": "face",
        "q": { "op": "side", "feature": "e1", "curve": "top" } } }),
    );
    assert_eq!(bad.expect_err("plane").code(), "AXIS_REF_UNSUPPORTED");
    let l = ax(
        &s,
        json!({ "line": { "origin": [1, 2, 3], "direction": [0, -2, 0] } }),
    )
    .expect("line");
    assert_eq!(
        l.direction,
        [0.0, -1.0, 0.0],
        "explicit lines keep their sign"
    );
    // A cone's axis.
    let cone = half_cone();
    let cs = cone.scope();
    let k = ax(
        &cs,
        json!({ "cylinder": { "kind": "face",
        "q": { "op": "side", "feature": "r1", "curve": "b" } } }),
    )
    .expect("cone axis");
    assert!(
        close(k.origin, [0.0; 3]) && close(k.direction, [0.0, 0.0, 1.0]),
        "{k:?}"
    );
}

#[test]
fn point_references() {
    let m = plate();
    let s = m.scope();
    let p: PointRef = serde_json::from_value(json!({ "vertex": { "kind": "vertex",
        "q": { "op": "extreme", "dir": [1, 1, 1], "which": "max",
               "of": { "op": "vertices", "of": { "op": "body", "feature": "e1" } } } } }))
    .expect("point ref");
    assert_eq!(
        point(&p, &s, "/p").result.expect("vertex"),
        [20.0, 10.0, 5.0]
    );
}

fn feature(v: Value) -> Feature {
    serde_json::from_value(v).expect("feature")
}

fn dplane(s: &Scope<'_>, v: Value) -> Result<PlaneFrame, forge_refs::RefError> {
    let Feature::DatumPlane(d) = feature(v) else {
        panic!("datum_plane")
    };
    datum_plane(&d, s, "").result
}

#[test]
fn datum_plane_modes() {
    let m = plate();
    let s = m.scope();
    let base = json!({ "type": "datum_plane", "id": "d1", "name": "d" });
    let with = |extra: Value| {
        let mut v = base.clone();
        for (k, x) in extra.as_object().expect("obj") {
            v[k] = x.clone();
        }
        v
    };
    let off = dplane(
        &s,
        with(json!({ "mode": "offset", "from": "XY", "distance": -3 })),
    )
    .expect("offset");
    assert_eq!(off.origin, [0.0, 0.0, -3.0]);
    let ang = dplane(
        &s,
        with(json!({ "mode": "angle", "from": "XY", "axis": "X", "angle": 30 })),
    )
    .expect("angle");
    assert!(
        close(ang.normal, [0.0, -0.5, 0.8660254037844386]),
        "{ang:?}"
    );
    let bad = dplane(
        &s,
        with(json!({ "mode": "angle", "from": "XY", "axis": "Z", "angle": 30 })),
    );
    assert_eq!(
        bad.expect_err("axis not in the plane").code(),
        "DATUM_DEGENERATE"
    );
    let side = |c: &str| face(json!({ "op": "side", "feature": "e1", "curve": c }));
    let mid = dplane(
        &s,
        with(json!({ "mode": "midplane", "a": side("left"), "b": side("right") })),
    )
    .expect("midplane");
    assert!(
        close(mid.origin, [0.0; 3]) && close(mid.normal, [-1.0, 0.0, 0.0]),
        "{mid:?}"
    );
    let skew = dplane(
        &s,
        with(json!({ "mode": "midplane", "a": side("left"), "b": side("top") })),
    );
    assert_eq!(skew.expect_err("not parallel").code(), "DATUM_DEGENERATE");
    let thr = dplane(
        &s,
        with(json!({ "mode": "through", "points": [[0, 0, 0], [1, 0, 0], [0, 1, 0]] })),
    )
    .expect("through");
    assert_eq!(
        (thr.x, thr.y, thr.normal),
        ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0])
    );
    let col = dplane(
        &s,
        with(json!({ "mode": "through", "points": [[0, 0, 0], [1, 0, 0], [2, 0, 0]] })),
    );
    assert_eq!(col.expect_err("collinear").code(), "DATUM_DEGENERATE");
    let fr = dplane(&s, with(json!({ "mode": "frame", "origin": [0, 0, 1], "normal": [1, 0, 0], "x_dir": [0, 0, 1] })))
        .expect("frame");
    assert_eq!(fr.y, [0.0, -1.0, 0.0]);
}

#[test]
fn datum_axis_modes() {
    let m = plate();
    let s = m.scope();
    let da = |v: Value| {
        let mut f = json!({ "type": "datum_axis", "id": "a1", "name": "a" });
        for (k, x) in v.as_object().expect("obj") {
            f[k] = x.clone();
        }
        let Feature::DatumAxis(d) = feature(f) else {
            panic!("datum_axis")
        };
        datum_axis(&d, &s, "").result
    };
    let planes = da(json!({ "mode": "planes", "a": "XY", "b": "XZ" })).expect("planes");
    assert_eq!(
        (planes.origin, planes.direction),
        ([0.0; 3], [1.0, 0.0, 0.0])
    );
    let off = da(json!({ "mode": "planes",
        "a": { "origin": [0, 0, 2], "normal": [0, 0, 1], "x_dir": [1, 0, 0] },
        "b": { "origin": [0, 3, 0], "normal": [0, 1, 0], "x_dir": [1, 0, 0] } }))
    .expect("offset planes");
    assert!(close(off.origin, [0.0, 3.0, 2.0]), "{off:?}");
    let par = da(json!({ "mode": "planes", "a": "XY",
        "b": { "origin": [0, 0, 2], "normal": [0, 0, -1], "x_dir": [1, 0, 0] } }));
    assert_eq!(par.expect_err("parallel").code(), "DATUM_DEGENERATE");
    let pts = da(json!({ "mode": "points", "points": [[1, 1, 1], [1, 1, 4]], "flip": true }))
        .expect("points");
    assert_eq!(
        (pts.origin, pts.direction),
        ([1.0, 1.0, 1.0], [0.0, 0.0, -1.0])
    );
    let same = da(json!({ "mode": "points", "points": [[1, 1, 1], [1, 1, 1]] }));
    assert_eq!(same.expect_err("coincident").code(), "DATUM_DEGENERATE");
    let cyl = da(json!({ "mode": "cylinder", "face": { "kind": "face",
        "q": { "op": "side", "feature": "e1", "curve": "ring" } } }))
    .expect("cylinder");
    assert_eq!(cyl.origin, [10.0, 0.0, 0.0]);
}

/// `DATUM_DEGENERATE` details always carry the angle (never `null`, §7.5 details
/// `reason`, `angle_deg`).
#[test]
fn datum_degenerate_details_carry_the_angle() {
    let m = plate();
    let s = m.scope();
    let check = |e: forge_refs::RefError, want: f64| {
        assert_eq!(e.code(), "DATUM_DEGENERATE");
        let d = e.details();
        let mut keys: Vec<&str> = d.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["angle_deg", "reason"]);
        let a = d["angle_deg"].as_f64().expect("a number");
        assert!((a - want).abs() <= 1e-9, "{a} != {want}");
    };
    let col = dplane(
        &s,
        json!({ "type": "datum_plane", "id": "d1", "name": "d", "mode": "through",
                "points": [[0, 0, 0], [1, 0, 0], [-2, 0, 0]] }),
    );
    check(col.expect_err("collinear"), 180.0);
    let same = dplane(
        &s,
        json!({ "type": "datum_plane", "id": "d1", "name": "d", "mode": "through",
                "points": [[0, 0, 0], [0, 0, 0], [1, 2, 0]] }),
    );
    check(same.expect_err("coincident"), 0.0);
    let Feature::DatumAxis(d) = feature(json!({ "type": "datum_axis", "id": "a1", "name": "a",
        "mode": "points", "points": [[1, 1, 1], [1, 1, 1]] }))
    else {
        panic!("datum_axis")
    };
    check(datum_axis(&d, &s, "").result.expect_err("coincident"), 0.0);
    let skew = dplane(
        &s,
        json!({ "type": "datum_plane", "id": "d1", "name": "d", "mode": "angle",
                "from": "XY", "axis": "Z", "angle": 30 }),
    );
    check(skew.expect_err("axis along the normal"), 90.0);
}

/// [W0-8]: an explicit frame whose normal and x direction are not perpendicular is
/// `INVALID_PLANE` also when its vectors come from expressions (validation only sees
/// literals); a perpendicular expression-driven frame is fine.
#[test]
fn an_expression_driven_frame_must_be_perpendicular() {
    let m = plate();
    let hook = |t: &str| match t {
        "tilt" => Some(0.5),
        "flat" => Some(0.0),
        _ => None,
    };
    let s = forge_refs::ScopeBuilder::new(m.table.clone())
        .body(&m.bodies[0].0, m.bodies[0].1.clone())
        .scalars(&hook)
        .build();
    let fr = |x: &str| {
        dplane(
            &s,
            json!({ "type": "datum_plane", "id": "d1", "name": "d", "mode": "frame",
                    "origin": [0, 0, 0], "normal": [0, 0, 1], "x_dir": [1, 0, x] }),
        )
    };
    let e = fr("tilt").expect_err("not perpendicular");
    assert_eq!(e.code(), "INVALID_PLANE");
    assert_eq!(
        e.details()["reason"],
        "normal and x_dir are not perpendicular"
    );
    assert_eq!(fr("flat").expect("perpendicular").x, [1.0, 0.0, 0.0]);
    // A PlaneRef frame too.
    let bad = plane_frame(
        &plane(json!({ "origin": [0, 0, 0], "normal": [0, 0, 1], "x_dir": [1, 0, "tilt"] })),
        &s,
        "/plane",
    );
    assert_eq!(
        bad.result.expect_err("not perpendicular").code(),
        "INVALID_PLANE"
    );
}

/// §3.1 step 3 ties: when the two smallest `|n·axis|` differ only by rounding, they are ties
/// and the first axis (X, then Y, then Z) wins, whatever the sketch's scale or placement (the
/// frame never flips between edits).
#[test]
fn tied_axis_components_take_the_first_axis_whatever_the_rounding() {
    let cases: [([f64; 3], [f64; 3], [f64; 3]); 6] = [
        // normal, x_dir of the sketch plane, expected x of the cap's face frame (unnormalised).
        ([1.0, 1.0, 1.0], [1.0, -1.0, 0.0], [2.0, -1.0, -1.0]),
        ([3.0, 3.0, 3.0], [1.0, -1.0, 0.0], [2.0, -1.0, -1.0]),
        ([0.1, 0.1, 0.1], [0.0, 1.0, -1.0], [2.0, -1.0, -1.0]),
        ([1.0, 1.0, 2.0], [1.0, -1.0, 0.0], [5.0, -1.0, -2.0]),
        ([0.3, 0.3, 0.6], [1.0, -1.0, 0.0], [5.0, -1.0, -2.0]),
        ([2.0, 1.0, 1.0], [0.0, 1.0, -1.0], [-2.0, 5.0, -1.0]),
    ];
    for (n, xd, want) in cases {
        for (size, at) in [(3.0, 0.0), (7.3, 1.7), (0.4, -12.25)] {
            let m = common::eval(&format!(
                r#"{{ "schema": "aicad.ir/0", "parts": [{{ "id": "p1", "name": "part", "features": [
  {{ "type": "sketch", "id": "s1", "name": "base",
     "plane": {{ "origin": [{at}, {at}, 0], "normal": {n:?}, "x_dir": {xd:?} }}, "curves": [
    {{ "kind": "line", "id": "a", "start": [0, 0], "end": [{size}, 0] }},
    {{ "kind": "line", "id": "b", "start": [{size}, 0], "end": [{size}, {size}] }},
    {{ "kind": "line", "id": "c", "start": [{size}, {size}], "end": [0, {size}] }},
    {{ "kind": "line", "id": "d", "start": [0, {size}], "end": [0, 0] }} ] }},
  {{ "type": "extrude", "id": "e1", "name": "tilted", "sketch": "base", "distance": 1 }} ] }}] }}"#
            ));
            let s = m.scope();
            let f = frame(
                &s,
                face(json!({ "op": "cap", "feature": "e1", "end": "end" })),
            );
            let len = (want[0] * want[0] + want[1] * want[1] + want[2] * want[2]).sqrt();
            let w = want.map(|c| c / len);
            assert!(
                (0..3).all(|i| (f.x[i] - w[i]).abs() <= 1e-9),
                "{n:?} {size} {at}: {f:?}, want x {w:?}"
            );
        }
    }
}
