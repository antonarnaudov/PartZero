//! Holes applied to bodies (SPEC §6.5): closed-form volumes of every kind, placement forms,
//! the `holes` report, identity and keys, and the error and warning codes
//! (`HOLE_POINT_OFF_FACE`, `HOLE_DUPLICATE_POSITION`, `HOLE_UP_TO_MISSED`,
//! `HOLE_MISSES_BODY`, `HOLE_BREAKS_THROUGH`).

// Exact comparisons on purpose: golden values and exact placements.
#![allow(clippy::float_cmp)]

use std::f64::consts::PI;

use forge_core::linalg::{Frame, Vec3};
use forge_core::topo::{Body, FaceId, Role, Severity, parse_key};
use forge_ir::v1::metrics::{BodyChange, Origin};
use forge_ir::v1::{HoleFeature, HolePlacement};
use forge_ir::{Frame as IrFrame, PlaneSpec, SketchCurve, SweepDirection};
use forge_ops::boolean::OpBody;
use forge_ops::boolean::corpus::{Operand, Sweep};
use forge_ops::hole::{
    HoleError, HoleErrorDetails, HoleOutcome, HolePos, HoleSite, HoleSpec, MAX_HOLE_POSITIONS,
    apply_hole, hole_positions, hole_spec, literal_hole, up_to_depth,
};
use serde_json::{Value, json};

fn rect(x0: f64, y0: f64, w: f64, h: f64) -> Vec<SketchCurve> {
    let l = |id: &str, a: [f64; 2], b: [f64; 2]| SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    };
    vec![
        l("b", [x0, y0], [x0 + w, y0]),
        l("r", [x0 + w, y0], [x0 + w, y0 + h]),
        l("t", [x0 + w, y0 + h], [x0, y0 + h]),
        l("l", [x0, y0 + h], [x0, y0]),
    ]
}

/// An axis-aligned box `lo + [0, size]`, extruded along +Z from `z = lo[2]`.
fn aabox(feature: &str, lo: [f64; 3], size: [f64; 3]) -> Body {
    Operand {
        feature: feature.into(),
        sketch: forge_ir::SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane: PlaneSpec::Frame(IrFrame {
                origin: [0.0, 0.0, lo[2]],
                normal: [0.0, 0.0, 1.0],
                x_dir: [1.0, 0.0, 0.0],
            }),
            curves: rect(lo[0], lo[1], size[0], size[1]),
        },
        sweep: Sweep::Extrude {
            distance: size[2],
            direction: SweepDirection::Normal,
        },
    }
    .build()
    .expect("box")
}

fn ob(body: Body, feature: &str) -> OpBody {
    OpBody {
        body,
        origin: Origin {
            feature: feature.into(),
            member: "b".into(),
            instance: None,
        },
        timeline: 0,
    }
}

fn cap_end(b: &Body) -> FaceId {
    b.faces()
        .iter()
        .find(|(_, f)| f.provenance.role == Role::CapEnd)
        .map(|(id, _)| id)
        .expect("end cap")
}

fn cap_start(b: &Body) -> FaceId {
    b.faces()
        .iter()
        .find(|(_, f)| f.provenance.role == Role::CapStart)
        .map(|(id, _)| id)
        .expect("start cap")
}

fn hole(fields: Value) -> HoleFeature {
    let mut v = json!({ "id": "h1", "name": "holes", "on": "XY" });
    for (k, x) in fields.as_object().expect("object") {
        v[k] = x.clone();
    }
    serde_json::from_value(v).expect("hole feature")
}

fn prepared(fields: Value, frame: &Frame) -> (HoleSpec, Vec<HolePos>) {
    let lit = literal_hole(&hole(fields), |s, _, _| s.literal().ok_or(())).expect("literals");
    let spec = hole_spec(&lit).expect("spec");
    let pos = hole_positions(&lit.at, frame, &[]).expect("positions");
    (spec, pos)
}

/// The top face frame of a plate of thickness `t` (outward normal +Z, §3.1 frame of XY).
fn top(t: f64) -> Frame {
    Frame::world().with_origin(Vec3::new(0.0, 0.0, t))
}

/// Holes on the top cap of a 60 × 40 × `t` plate centred on the origin.
fn on_plate(fields: Value, t: f64) -> Result<(HoleOutcome, f64), HoleError> {
    let plate = aabox("e1", [-30.0, -20.0, 0.0], [60.0, 40.0, t]);
    let frame = top(t);
    let (spec, pos) = prepared(fields, &frame);
    let face = cap_end(&plate);
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: Some((&plate, face)),
        up_to: None,
        timeline: 1,
        scope_scale: None,
    };
    let targets = [ob(plate.clone(), "e1")];
    apply_hole(&spec, &pos, &site, &targets).map(|o| (o, 60.0 * 40.0 * t))
}

fn only_body(o: &HoleOutcome) -> &Body {
    assert_eq!(o.op.bodies.len(), 1, "one result body");
    &o.op.bodies[0].body
}

fn volume(b: &Body) -> f64 {
    let issues = forge_check::validate(b);
    assert!(
        issues.iter().all(|i| i.severity != Severity::Error),
        "invalid: {issues:?}"
    );
    forge_check::mass_properties(b).expect("mass").volume
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * b.abs().max(1.0)
}

#[test]
fn through_grid_removes_four_cylinders_and_reports_each_position() {
    let (o, v0) = on_plate(
        json!({ "at": { "grid": { "nx": 2, "ny": 2, "dx": 40, "dy": 20 } }, "size": "M5", "depth": "through" }),
        8.0,
    )
    .expect("holes");
    let b = only_body(&o);
    let r: f64 = 5.5 / 2.0;
    assert!(close(volume(b), v0 - 4.0 * PI * r * r * 8.0));
    let rb = &o.op.bodies[0];
    assert_eq!(
        (rb.origin.feature.as_str(), rb.change),
        ("e1", BodyChange::Modified)
    );
    let ids: Vec<&str> = o.holes.iter().map(|h| h.at.as_str()).collect();
    assert_eq!(ids, ["g0_0", "g0_1", "g1_0", "g1_1"]);
    let h = &o.holes[0];
    assert_eq!(
        (h.center, h.axis, h.d, h.depth),
        ([-20.0, -10.0, 8.0], [0.0, 0.0, -1.0], 5.5, None)
    );
    assert!(o.notes.is_empty());
    // Every wall survives with its key; the tools carry their positions as members.
    let walls: Vec<String> = b
        .faces()
        .iter()
        .map(|(_, f)| f.provenance.key())
        .filter(|k| k.starts_with("h1/wall@"))
        .collect();
    assert_eq!(walls.len(), 4, "{walls:?}");
    assert_eq!(o.tools.len(), 4);
    assert_eq!(o.tools[3].origin.member, "g1_1");
    let m = forge_check::body_metrics(b).expect("metrics");
    assert_eq!(
        (m.faces, m.face_types.get("cylinder").copied()),
        (10, Some(4))
    );
}

#[test]
fn every_kind_removes_its_closed_form_volume() {
    let t = 12.0;
    let r = |d: f64| d / 2.0;
    let cases: Vec<(Value, f64)> = vec![
        // Blind with a 118° tip.
        (json!({ "d": 4, "depth": { "blind": 6 } }), {
            let h_tip = r(4.0) / 59f64.to_radians().tan();
            PI * 4.0 * (6.0 + h_tip / 3.0)
        }),
        // Blind flat.
        (
            json!({ "d": 4, "depth": { "blind": 6 }, "tip": "flat" }),
            PI * 4.0 * 6.0,
        ),
        // ISO 4762 counterbore, through: M4 → D 4.5, cbore 8.0 × 4.4.
        (
            json!({ "size": "M4", "depth": "through", "cbore": "iso4762" }),
            { PI * 16.0 * 4.4 + PI * r(4.5).powi(2) * (t - 4.4) },
        ),
        // ISO 10642 countersink, through: M4 → D 4.5, Dk 9.18, 90°.
        (
            json!({ "size": "M4", "depth": "through", "csink": "iso10642" }),
            {
                let (rk, rr) = (r(9.18), r(4.5));
                let hk = rk - rr;
                PI * hk * (rk * rk + rk * rr + rr * rr) / 3.0 + PI * rr * rr * (t - hk)
            },
        ),
        // Heat-set insert M3: bore 4.0, depth 6.7, flat.
        (json!({ "size": "M3", "insert": "std" }), PI * 4.0 * 6.7),
        // Tapped blind hole (thread is cosmetic: tap drill 2.5).
        (
            json!({ "size": "M3", "depth": { "blind": 6 }, "thread": true }),
            {
                let h_tip = r(2.5) / 59f64.to_radians().tan();
                PI * r(2.5).powi(2) * (6.0 + h_tip / 3.0)
            },
        ),
    ];
    for (fields, removed) in cases {
        let mut f = fields.clone();
        f["at"] = json!({ "list": [{ "id": "p", "at": [5, -3] }] });
        let (o, v0) = on_plate(f, t).unwrap_or_else(|e| panic!("{fields}: {e}"));
        let v = volume(only_body(&o));
        assert!(close(v, v0 - removed), "{fields}: {v} vs {}", v0 - removed);
        assert!(o.notes.is_empty(), "{fields}: {:?}", o.notes);
    }
}

#[test]
fn report_carries_presets_threads_and_depths() {
    let (o, _) = on_plate(
        json!({ "at": { "list": [{ "id": "t", "at": [0, 0] }] }, "size": "M3", "depth": { "blind": 6 },
                "thread": { "depth": 5 } }),
        10.0,
    )
    .expect("tapped");
    let h = &o.holes[0];
    assert_eq!((h.d, h.depth), (2.5, Some(6.0)));
    let th = h.thread.as_ref().expect("thread");
    assert_eq!((th.pitch, th.depth), (0.5, Some(5.0)));
    let (o, _) = on_plate(
        json!({ "at": { "list": [{ "id": "i", "at": [0, 0] }] }, "size": "M4", "insert": "std" }),
        12.0,
    )
    .expect("insert");
    let h = &o.holes[0];
    let ins = h.insert.as_ref().expect("insert");
    assert_eq!((h.d, h.depth, ins.d, ins.depth), (5.6, Some(9.1), 5.6, 9.1));
    let (o, _) = on_plate(
        json!({ "at": { "list": [{ "id": "c", "at": [0, 0] }] }, "size": "M5", "depth": "through", "cbore": "iso4762" }),
        12.0,
    )
    .expect("cbore");
    let c = o.holes[0].cbore.as_ref().expect("cbore");
    assert_eq!(
        (c.d, c.depth, o.holes[0].size.map(|s| s.as_str())),
        (10.0, 5.4, Some("M5"))
    );
}

#[test]
fn bolt_circle_positions_use_exact_degree_angles() {
    let frame = top(8.0);
    let (_, pos) = prepared(
        json!({ "at": { "circle": { "n": 4, "d": 20, "start": 90 } }, "d": 3, "depth": "through" }),
        &frame,
    );
    let pts: Vec<[f64; 3]> = pos.iter().map(|p| p.point.to_array()).collect();
    assert_eq!(
        pts,
        [
            [0.0, 10.0, 8.0],
            [-10.0, 0.0, 8.0],
            [0.0, -10.0, 8.0],
            [10.0, 0.0, 8.0]
        ]
    );
    let ids: Vec<&str> = pos.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, ["c0", "c1", "c2", "c3"]);
}

/// W4 regression of the fourth review (fixed case `w4_bolt_circle_12`): twelve Ø3 blind holes
/// on a Ø6 bolt circle. Tools `i` and `i + 2` are 3 = D apart and touch along a vertical line
/// at radius 3·cos 30° ≈ 2.598, which tool `i + 1` (centre at radius 3, 0.402 away) covers, so
/// the result is manifold; W4 fails the cut with `BOOLEAN_NON_MANIFOLD` near (2.25, −1.299, 4)
/// (it tests the tangency without the other tools). An explicit error, never a wrong body.
/// Owner: W4; un-ignore when fixed.
#[test]
#[ignore = "W4: BOOLEAN_NON_MANIFOLD for a tangency another tool covers (dense bolt circle)"]
fn w4_a_dense_bolt_circle_is_manifold() {
    let (o, _) = on_plate(
        json!({ "at": { "circle": { "n": 12, "d": 6.0 } }, "d": 3.0, "depth": { "blind": 4.0 } }),
        8.0,
    )
    .expect("a manifold result");
    assert!(volume(only_body(&o)) > 0.0);
}

#[test]
fn sketch_points_are_projected_onto_the_placement_plane() {
    let frame = top(8.0);
    let lit = literal_hole(
        &hole(json!({ "at": { "points": { "sketch": "s2", "ids": ["p1", "p2"] } }, "d": 3, "depth": "through" })),
        |s, _, _| s.literal().ok_or(()),
    )
    .expect("literals");
    assert!(matches!(lit.at, HolePlacement::Points(_)));
    let pts = [
        ("p1".to_string(), Vec3::new(4.0, 1.0, 20.0)),
        ("p2".to_string(), Vec3::new(-4.0, 1.0, -3.0)),
    ];
    let pos = hole_positions(&lit.at, &frame, &pts).expect("positions");
    assert_eq!(pos[0].point.to_array(), [4.0, 1.0, 8.0]);
    assert_eq!((pos[1].uv.x, pos[1].uv.y), (-4.0, 1.0));
}

#[test]
fn off_face_positions_fail_with_their_distance() {
    let e = on_plate(
        json!({ "at": { "list": [{ "id": "in", "at": [0, 0] }, { "id": "out", "at": [33, 0] }] },
                "d": 3, "depth": "through" }),
        8.0,
    )
    .expect_err("off face");
    assert_eq!(e.code(), "HOLE_POINT_OFF_FACE");
    let HoleError::PointOffFace { at, distance } = e else {
        panic!("{e}")
    };
    assert_eq!(at, "out");
    assert!((distance - 3.0).abs() < 1e-9, "{distance}");
    // On the boundary within tol is on the face.
    let ok = on_plate(
        json!({ "at": { "list": [{ "id": "edge", "at": [29.9999995, 0] }] }, "d": 3, "depth": { "blind": 2 } }),
        8.0,
    );
    assert!(!matches!(ok, Err(HoleError::PointOffFace { .. })), "{ok:?}");
}

#[test]
fn duplicate_positions_fail_with_the_later_id() {
    let frame = top(8.0);
    let lit = literal_hole(
        &hole(json!({ "at": { "list": [{ "id": "a", "at": [1, 1] }, { "id": "b", "at": [1.0000005, 1] }] },
                      "d": 3, "depth": "through" })),
        |s, _, _| s.literal().ok_or(()),
    )
    .expect("literals");
    let e = hole_positions(&lit.at, &frame, &[]).expect_err("duplicate");
    assert_eq!(
        (e.code(), e.details()),
        (
            "HOLE_DUPLICATE_POSITION",
            forge_ops::hole::HoleErrorDetails::At { at: "b".into() }
        )
    );
}

#[test]
fn flipped_holes_drilling_away_from_the_body_miss_it() {
    let plate = aabox("e1", [-30.0, -20.0, 0.0], [60.0, 40.0, 8.0]);
    let frame = top(8.0);
    let (spec, pos) = prepared(
        json!({ "at": { "list": [{ "id": "a", "at": [0, 0] }, { "id": "b", "at": [5, 0] }] }, "d": 3, "depth": "through" }),
        &frame,
    );
    let site = HoleSite {
        frame: &frame,
        flip: true,
        on_face: Some((&plate, cap_end(&plate))),
        up_to: None,
        timeline: 1,
        scope_scale: None,
    };
    let e = apply_hole(&spec, &pos, &site, &[ob(plate.clone(), "e1")]).expect_err("misses");
    assert_eq!(
        (e.code(), e.details()),
        (
            "HOLE_MISSES_BODY",
            forge_ops::hole::HoleErrorDetails::At { at: "a".into() }
        )
    );
}

#[test]
fn one_position_off_the_body_on_a_datum_plane_is_named() {
    // `on` a datum plane (no face check): position `far` misses, `near` cuts.
    let plate = aabox("e1", [-30.0, -20.0, 0.0], [60.0, 40.0, 8.0]);
    let frame = top(8.0);
    let (spec, pos) = prepared(
        json!({ "at": { "list": [{ "id": "near", "at": [0, 0] }, { "id": "far", "at": [50, 0] }] }, "d": 3, "depth": "through" }),
        &frame,
    );
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: None,
        up_to: None,
        timeline: 1,
        scope_scale: None,
    };
    let e = apply_hole(&spec, &pos, &site, &[ob(plate, "e1")]).expect_err("misses");
    assert_eq!(
        e.details(),
        forge_ops::hole::HoleErrorDetails::At { at: "far".into() }
    );
}

#[test]
fn up_to_holes_stop_at_the_face_and_report_the_depth() {
    let plate = aabox("e1", [-30.0, -20.0, 0.0], [60.0, 40.0, 8.0]);
    // A step under the plate's footprint whose top is at z = 3 (not a target).
    let step = aabox("e2", [-10.0, -10.0, -5.0], [20.0, 20.0, 8.0]);
    let frame = top(8.0);
    let (spec, pos) = prepared(
        json!({ "at": { "list": [{ "id": "a", "at": [2, 2] }] }, "d": 4,
                "depth": { "up_to": { "kind": "face", "q": { "op": "cap", "feature": "e2", "end": "end" } } } }),
        &frame,
    );
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: Some((&plate, cap_end(&plate))),
        up_to: Some((&step, cap_end(&step))),
        timeline: 2,
        scope_scale: None,
    };
    let o = apply_hole(&spec, &pos, &site, &[ob(plate.clone(), "e1")]).expect("up to");
    assert_eq!(o.holes[0].depth, Some(5.0));
    assert!(close(
        volume(only_body(&o)),
        60.0 * 40.0 * 8.0 - PI * 4.0 * 5.0
    ));
    // A position whose axis misses the step's top face.
    let (spec, pos) = prepared(
        json!({ "at": { "list": [{ "id": "b", "at": [20, 2] }] }, "d": 4,
                "depth": { "up_to": { "kind": "face", "q": { "op": "cap", "feature": "e2", "end": "end" } } } }),
        &frame,
    );
    let e = apply_hole(&spec, &pos, &site, &[ob(plate.clone(), "e1")]).expect_err("missed");
    assert_eq!(
        (e.code(), e.details()),
        (
            "HOLE_UP_TO_MISSED",
            forge_ops::hole::HoleErrorDetails::At { at: "b".into() }
        )
    );
    // The placement face itself is never the up-to face (depth ≥ tol).
    let site = HoleSite {
        up_to: Some((&plate, cap_end(&plate))),
        ..site
    };
    let e = apply_hole(&spec, &pos, &site, &[ob(plate.clone(), "e1")]).expect_err("missed");
    assert_eq!(e.code(), "HOLE_UP_TO_MISSED");
    // Up to the plate's own bottom face: a flat-bottomed hole through the plate.
    let site = HoleSite {
        up_to: Some((&plate, cap_start(&plate))),
        ..site
    };
    let o = apply_hole(&spec, &pos, &site, &[ob(plate.clone(), "e1")]).expect("to the bottom");
    assert_eq!(o.holes[0].depth, Some(8.0));
    // Forge's reading of SPEC §6.5 ("then as blind with a flat floor"): the floor lies on the
    // face the author chose, so `up_to` holes never warn. The W7b oracle warns here (its
    // floor lies within tol of a target face): open W5 contract question; the W5 differential
    // classifies the disagreement `OPEN_CONTRACT`. Change this assertion with the ruling.
    assert!(o.notes.is_empty(), "up_to holes never warn");
}

#[test]
fn blind_holes_deeper_than_the_plate_break_through() {
    let (o, v0) = on_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [0, 0] }, { "id": "b", "at": [10, 0] }] },
                "d": 3, "depth": { "blind": 7.5 } }),
        6.0,
    )
    .expect("holes");
    let at: Vec<&str> = o
        .notes
        .iter()
        .map(|n| match n {
            forge_ops::hole::HoleNote::BreaksThrough { at } => at.as_str(),
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    assert_eq!(at, ["a", "b"]);
    assert_eq!(o.notes[0].code(), "HOLE_BREAKS_THROUGH");
    // Through the plate: two plain cylinders.
    assert!(close(volume(only_body(&o)), v0 - 2.0 * PI * 2.25 * 6.0));
    // Exactly to the bottom (flat floor on the far face) breaks through too.
    let (o, _) = on_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [0, 0] }] }, "d": 3, "depth": { "blind": 8 }, "tip": "flat" }),
        8.0,
    )
    .expect("to the bottom exactly");
    assert_eq!(
        o.notes,
        vec![forge_ops::hole::HoleNote::BreaksThrough { at: "a".into() }]
    );
    // A 5 mm hole in the 8 mm plate stays inside.
    let (o, _) = on_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [0, 0] }] }, "d": 3, "depth": { "blind": 5 } }),
        8.0,
    )
    .expect("inside");
    assert!(o.notes.is_empty());
}

#[test]
fn breakthrough_is_decided_per_position() {
    // A plate 8 thick with a pocket from below under x > 0 (4 mm of material left there).
    let plate = aabox("e1", [-30.0, -20.0, 0.0], [60.0, 40.0, 8.0]);
    let pocket = aabox("e2", [0.0, -10.0, -1.0], [20.0, 20.0, 5.0]);
    let stepped = forge_ops::boolean::apply_body_op(
        forge_ops::boolean::BodyOp::Cut,
        &[ob(plate, "e1")],
        &[ob(pocket, "e2")],
        "c1",
    )
    .expect("pocket")
    .bodies
    .remove(0)
    .body;
    let frame = top(8.0);
    let (spec, pos) = prepared(
        json!({ "at": { "list": [{ "id": "solid", "at": [-10, 0] }, { "id": "over", "at": [10, 0] }] },
                "d": 3, "depth": { "blind": 5 } }),
        &frame,
    );
    let face = stepped
        .faces()
        .iter()
        .find(|(_, f)| f.provenance.role == Role::CapEnd && f.provenance.feature == "e1")
        .map(|(id, _)| id)
        .expect("top");
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: Some((&stepped, face)),
        up_to: None,
        timeline: 2,
        scope_scale: None,
    };
    let o = apply_hole(&spec, &pos, &site, &[ob(stepped.clone(), "e1")]).expect("holes");
    assert_eq!(
        o.notes,
        vec![forge_ops::hole::HoleNote::BreaksThrough { at: "over".into() }]
    );
}

#[test]
fn overlapping_blind_holes_merge_floors_without_breaking_through() {
    let (o, v0) = on_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [0, 0] }, { "id": "b", "at": [3, 0] }] },
                "d": 5, "depth": { "blind": 4 }, "tip": "flat" }),
        8.0,
    )
    .expect("holes");
    assert!(o.notes.is_empty(), "{:?}", o.notes);
    let b = only_body(&o);
    // The two floors are one face (same plane, same orientation); b's floor is an alias.
    let floors: Vec<String> = b
        .faces()
        .iter()
        .map(|(_, f)| f.provenance.key())
        .filter(|k| k.contains("/floor@"))
        .collect();
    assert_eq!(floors, ["h1/floor@a"]);
    assert!(
        o.op.aliases
            .iter()
            .any(|(m, s)| m == "h1/floor@b" && s == "h1/floor@a")
    );
    // Volume: two disks of radius 2.5 at distance 3 (lens overlap), 4 deep.
    let (r, d): (f64, f64) = (2.5, 3.0);
    let lens = 2.0 * r * r * (d / (2.0 * r)).acos() - 0.5 * d * (4.0 * r * r - d * d).sqrt();
    let removed = (2.0 * PI * r * r - lens) * 4.0;
    assert!(close(volume(b), v0 - removed));
}

#[test]
fn keys_name_every_surviving_hole_face_by_position() {
    let (o, _) = on_plate(
        json!({ "at": { "list": [{ "id": "p", "at": [0, 0] }] }, "size": "M4", "depth": { "blind": 8 }, "cbore": "iso4762" }),
        12.0,
    )
    .expect("cbore");
    let b = only_body(&o);
    let mut hole_faces: Vec<String> = b
        .faces()
        .iter()
        .map(|(_, f)| f.provenance.key())
        .filter(|k| k.starts_with("h1/"))
        .collect();
    hole_faces.sort();
    assert_eq!(
        hole_faces,
        [
            "h1/cbore_floor@p",
            "h1/cbore_wall@p",
            "h1/tip@p",
            "h1/wall@p"
        ]
    );
    for (_, e) in b.edges().iter() {
        let k = e.provenance.key();
        let p = parse_key(&k).expect("edge key");
        assert!(p.feature == "h1" || p.feature == "e1", "{k}");
    }
}

#[test]
fn results_are_deterministic() {
    let run = || {
        let (o, _) = on_plate(
            json!({ "at": { "circle": { "n": 5, "d": 24, "start": 18 } }, "size": "M3", "depth": { "blind": 5 }, "csink": "iso10642" }),
            8.0,
        )
        .expect("holes");
        let m = forge_check::body_metrics(only_body(&o)).expect("metrics");
        (
            m.volume.to_bits(),
            m.area.to_bits(),
            m.faces,
            m.edges,
            format!("{:?}", o.holes),
        )
    };
    assert_eq!(run(), run());
}

#[test]
fn non_planar_faces_are_rejected_with_their_surface_type() {
    let plate = aabox("e1", [-30.0, -20.0, 0.0], [60.0, 40.0, 8.0]);
    let boss = Operand {
        feature: "e2".into(),
        sketch: forge_ir::SketchFeature {
            id: "s_e2".into(),
            name: "s_e2".into(),
            suppressed: false,
            plane: PlaneSpec::Frame(IrFrame {
                origin: [0.0, 0.0, -5.0],
                normal: [0.0, 0.0, 1.0],
                x_dir: [1.0, 0.0, 0.0],
            }),
            curves: vec![SketchCurve::Circle {
                id: "c".into(),
                center: [0.0, 0.0],
                radius: 5.0,
            }],
        },
        sweep: Sweep::Extrude {
            distance: 3.0,
            direction: SweepDirection::Normal,
        },
    }
    .build()
    .expect("boss");
    let side = boss
        .faces()
        .iter()
        .find(|(_, f)| f.surface.kind_name() == "cylinder")
        .map(|(id, _)| id)
        .expect("side");
    let e = forge_ops::hole::planar_face_distance(&boss, side, Vec3::new(5.0, 0.0, -4.0))
        .expect_err("cylinder");
    assert_eq!(
        (e.code(), e.details()),
        (
            "PLANE_NOT_PLANAR",
            forge_ops::hole::HoleErrorDetails::Surface {
                surface: "cylinder".into()
            }
        )
    );
    let frame = top(8.0);
    let (spec, pos) = prepared(
        json!({ "at": { "list": [{ "id": "a", "at": [0, 0] }] }, "d": 2,
                "depth": { "up_to": { "kind": "face", "q": { "op": "sides", "feature": "e2" } } } }),
        &frame,
    );
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: Some((&plate, cap_end(&plate))),
        up_to: Some((&boss, side)),
        timeline: 3,
        scope_scale: None,
    };
    let e = apply_hole(&spec, &pos, &site, &[ob(plate.clone(), "e1")]).expect_err("unsupported");
    assert_eq!(e.code(), "FORGE_HOLE_UP_TO_UNSUPPORTED");
}

#[test]
fn faces_with_holes_classify_points_in_the_holes_as_off_the_face() {
    // After a through hole, a later hole centred in it is off the face (distance to the rim).
    let (o, _) = on_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [0, 0] }] }, "d": 10, "depth": "through" }),
        8.0,
    )
    .expect("hole");
    let b = only_body(&o).clone();
    let face = b
        .faces()
        .iter()
        .find(|(_, f)| f.provenance.role == Role::CapEnd)
        .map(|(id, _)| id)
        .expect("top");
    let d = forge_ops::hole::planar_face_distance(&b, face, Vec3::new(1.0, 0.0, 8.0)).expect("d");
    assert!((d - 4.0).abs() < 1e-9, "{d}");
    let d = forge_ops::hole::planar_face_distance(&b, face, Vec3::new(10.0, 3.0, 8.0)).expect("d");
    assert_eq!(d, 0.0);
    let d = forge_ops::hole::planar_face_distance(&b, face, Vec3::new(-40.0, 0.0, 8.0)).expect("d");
    assert!((d - 10.0).abs() < 1e-9, "{d}");
}

mod props {
    use super::*;
    use forge_ops::hole::tool_volume;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig { cases: 16, ..ProptestConfig::default() })]

        /// Disjoint holes fully inside a plate remove exactly their closed-form volumes; a
        /// blind hole reports breaking through exactly when its bottom reaches the far face.
        #[test]
        fn disjoint_holes_remove_their_closed_form_volumes(
            t in 3.0f64..12.0,
            d in 1.0f64..4.0,
            n in 1usize..4,
            kind in 0usize..4,
            frac in 0.2f64..1.6,
            seed_x in -20.0f64..-15.0,
        ) {
            let depth = (frac * t * 64.0).round() / 64.0;
            let fields = match kind {
                0 => json!({ "d": d, "depth": "through" }),
                1 => json!({ "d": d, "depth": { "blind": depth } }),
                2 => json!({ "d": d, "depth": { "blind": depth }, "tip": "flat" }),
                _ => json!({ "d": d, "depth": "through", "cbore": { "d": d + 2.0, "depth": 0.4 * t } }),
            };
            let list: Vec<Value> = (0..n)
                .map(|k| json!({ "id": format!("p{k}"), "at": [seed_x + 12.0 * k as f64, 3.0] }))
                .collect();
            let mut f = fields.clone();
            f["at"] = json!({ "list": list });
            let (o, v0) = on_plate(f, t).expect("holes");
            let frame = top(t);
            let (spec, _) = prepared({ let mut g = fields.clone(); g["at"] = json!({ "list": [{ "id": "a", "at": [0, 0] }] }); g }, &frame);
            let tip_h = match spec.tip {
                forge_ops::hole::Tip::Angle(a) => 0.5 * d / (0.5 * a).to_radians().tan(),
                forge_ops::hole::Tip::Flat => 0.0,
            };
            let blind = kind == 1 || kind == 2;
            let inside = !blind || depth + tip_h < t - 1e-3;
            prop_assume!(!blind || inside || depth > t + 1e-3);
            let b = only_body(&o);
            if inside {
                let removed = if blind { tool_volume(&spec, depth, false) } else { tool_volume(&spec, t, true) };
                prop_assert!(close(volume(b), v0 - n as f64 * removed), "{} vs {}", volume(b), v0 - n as f64 * removed);
                prop_assert!(o.notes.is_empty());
            } else {
                // Through the plate: a cylinder of the plate's thickness each.
                prop_assert!(close(volume(b), v0 - n as f64 * PI * 0.25 * d * d * t));
                prop_assert_eq!(o.notes.len(), n);
            }
        }
    }
}

#[test]
fn up_to_depths_above_the_counterbore_floor_are_invalid() {
    let plate = aabox("e1", [-30.0, -20.0, 0.0], [60.0, 40.0, 4.0]);
    let frame = top(4.0);
    // M6 ISO 4762 counterbore: 6.4 deep, deeper than the 4 mm plate.
    let (spec, pos) = prepared(
        json!({ "at": { "list": [{ "id": "a", "at": [0, 0] }] }, "size": "M6", "cbore": "iso4762",
                "depth": { "up_to": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "start" } } } }),
        &frame,
    );
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: Some((&plate, cap_end(&plate))),
        up_to: Some((&plate, cap_start(&plate))),
        timeline: 1,
        scope_scale: None,
    };
    let e = apply_hole(&spec, &pos, &site, &[ob(plate.clone(), "e1")]).expect_err("too shallow");
    assert_eq!(e.code(), "INVALID_VALUE");
    let HoleErrorDetails::Range {
        field,
        value,
        expected,
    } = e.details()
    else {
        panic!("{e}")
    };
    // Reported like the blind-hole check (and the W7b oracle): at the head's field (a preset:
    // `/cbore`) with the counterbore depth, bounded by the 4 mm up-to depth less tol.
    assert_eq!((field.as_str(), value), ("/cbore", 6.4));
    assert!(expected.starts_with("< 3.999999 mm"), "{expected}");
    assert!(expected.contains("at a"), "{expected}");
}

/// A wedge under the plate `[-30, 30] × [-20, 20] × [0, 20]` whose slanted face `slope` rises
/// from z = 5 at x = −20 to z = 15 at x = 20 (`z = 10 + x/4`), for `up_to` depths that differ
/// per position; returns the wedge and its slanted face.
fn slanted_up_to() -> (Body, FaceId) {
    let l = |id: &str, a: [f64; 2], b: [f64; 2]| SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    };
    let wedge = Operand {
        feature: "e2".into(),
        sketch: forge_ir::SketchFeature {
            id: "s_e2".into(),
            name: "s_e2".into(),
            suppressed: false,
            // The XZ plane at y = 25 (local x = X, y = Z), extruded along −Y.
            plane: PlaneSpec::Frame(IrFrame {
                origin: [0.0, 25.0, 0.0],
                normal: [0.0, -1.0, 0.0],
                x_dir: [1.0, 0.0, 0.0],
            }),
            curves: vec![
                l("b", [-20.0, 0.0], [20.0, 0.0]),
                l("r", [20.0, 0.0], [20.0, 15.0]),
                l("slope", [20.0, 15.0], [-20.0, 5.0]),
                l("l", [-20.0, 5.0], [-20.0, 0.0]),
            ],
        },
        sweep: Sweep::Extrude {
            distance: 50.0,
            direction: SweepDirection::Normal,
        },
    }
    .build()
    .expect("wedge");
    let slope = wedge
        .faces()
        .iter()
        .find(|(_, f)| {
            f.provenance.role == Role::Side
                && f.provenance.sources.first().map(String::as_str) == Some("slope")
        })
        .map(|(id, _)| id)
        .expect("slope");
    (wedge, slope)
}

/// The order of checks (module docs, the order the W7b oracle follows): every `up_to` miss
/// before the head check, the head check against the **shallowest** position, and the
/// positions' misses before the combined cut's own failures.
#[test]
fn up_to_misses_come_before_the_head_check_which_the_shallowest_position_decides() {
    let plate = aabox("e1", [-30.0, -20.0, 0.0], [60.0, 40.0, 20.0]);
    let (wedge, slope) = slanted_up_to();
    let frame = top(20.0);
    let run = |list: Value| {
        let (spec, pos) = prepared(
            json!({ "at": { "list": list }, "d": 3, "cbore": { "d": 8, "depth": 8 },
                    "depth": { "up_to": { "kind": "face", "q": { "op": "cap", "feature": "e2", "end": "end" } } } }),
            &frame,
        );
        let site = HoleSite {
            frame: &frame,
            flip: false,
            on_face: Some((&plate, cap_end(&plate))),
            up_to: Some((&wedge, slope)),
            timeline: 2,
            scope_scale: None,
        };
        apply_hole(&spec, &pos, &site, &[ob(plate.clone(), "e1")])
    };
    // p1 (x = 10): up to z = 12.5, 7.5 deep; p2 (x = 16): z = 14, 6 deep — both shallower than
    // the 8 mm counterbore; p2 is the shallowest and decides, though p1 comes first.
    let e = run(json!([{ "id": "p1", "at": [10, 0] }, { "id": "p2", "at": [16, 0] }]))
        .expect_err("head below the floor");
    let HoleErrorDetails::Range {
        field,
        value,
        expected,
    } = e.details()
    else {
        panic!("{e}")
    };
    assert_eq!(
        (e.code(), field.as_str(), value),
        ("INVALID_VALUE", "/cbore/depth", 8.0)
    );
    assert!(expected.starts_with("< 5.999999 mm"), "{expected}");
    assert!(expected.contains("at p2"), "{expected}");
    // p3 (x = 25) is past the wedge: its miss is reported before p1's head check.
    let e = run(json!([{ "id": "p1", "at": [10, 0] }, { "id": "p3", "at": [25, 0] }]))
        .expect_err("missed");
    assert_eq!(
        (e.code(), e.details()),
        (
            "HOLE_UP_TO_MISSED",
            HoleErrorDetails::At { at: "p3".into() }
        )
    );
    // Deep enough everywhere (x = −12: z = 7, 13 deep): the hole is cut.
    let o = run(json!([{ "id": "p4", "at": [-12, 0] }])).expect("deep enough");
    assert_eq!(o.holes[0].depth, Some(13.0));
}

#[test]
fn a_missing_position_is_reported_before_the_cuts_own_failure() {
    // On a datum plane (no face check): `t` is tangent to the plate's side face x = 30 (the
    // cut alone is non-manifold), `far` misses the plate.
    let plate = aabox("e1", [-30.0, -20.0, 0.0], [60.0, 40.0, 8.0]);
    let frame = top(8.0);
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: None,
        up_to: None,
        timeline: 1,
        scope_scale: None,
    };
    let run = |list: Value| {
        let (spec, pos) = prepared(
            json!({ "at": { "list": list }, "d": 3, "depth": "through" }),
            &frame,
        );
        apply_hole(&spec, &pos, &site, &[ob(plate.clone(), "e1")])
    };
    let e = run(json!([{ "id": "t", "at": [28.5, 0] }])).expect_err("tangent");
    assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD");
    let e = run(json!([{ "id": "t", "at": [28.5, 0] }, { "id": "far", "at": [50, 0] }]))
        .expect_err("misses");
    assert_eq!(
        (e.code(), e.details()),
        (
            "HOLE_MISSES_BODY",
            HoleErrorDetails::At { at: "far".into() }
        )
    );
}

/// Position ids are unique within the hole (SPEC §6.5 [W0-10], `DUPLICATE_ID`): re-checked
/// for documents that bypassed validation, before positions are compared (two tools with one
/// id would share their face keys, and the key-based miss test could count one for the
/// other).
#[test]
fn duplicate_position_ids_are_rejected_with_their_path() {
    let frame = top(8.0);
    let lit = literal_hole(
        &hole(
            json!({ "at": { "list": [{ "id": "a", "at": [0, 0] }, { "id": "b", "at": [5, 0] },
                                        { "id": "a", "at": [10, 0] }] },
                      "d": 3, "depth": "through" }),
        ),
        |s, _, _| s.literal().ok_or(()),
    )
    .expect("literals");
    let e = hole_positions(&lit.at, &frame, &[]).expect_err("duplicate id");
    assert_eq!(
        (
            e.code(),
            serde_json::to_value(e.details()).expect("details")
        ),
        ("DUPLICATE_ID", json!({ "id": "a" }))
    );
    assert!(matches!(&e, HoleError::DuplicateId { field, .. } if field == "/at/list/2/id"));
    // Sketch points named twice (checked before the coincident positions).
    let lit = literal_hole(
        &hole(
            json!({ "at": { "points": { "sketch": "s1", "ids": ["p", "p"] } }, "d": 3,
                      "depth": "through" }),
        ),
        |s, _, _| s.literal().ok_or(()),
    )
    .expect("literals");
    let pts = [
        (
            "p".to_string(),
            forge_core::linalg::Point3::new(1.0, 2.0, 8.0),
        ),
        (
            "p".to_string(),
            forge_core::linalg::Point3::new(1.0, 2.0, 8.0),
        ),
    ];
    let e = hole_positions(&lit.at, &frame, &pts).expect_err("duplicate id");
    assert!(
        matches!(&e, HoleError::DuplicateId { field, id } if field == "/at/points/ids/1" && id == "p"),
        "{e:?}"
    );
}

/// An explicit cosmetic thread deeper than the blind (or up-to) hole is kept as given in the
/// report (SPEC §6.5 bounds it only by tol) and flagged with the engine-prefixed warning
/// `FORGE_HOLE_THREAD_DEEPER_THAN_HOLE` (W5 contract issue).
#[test]
fn a_thread_deeper_than_its_hole_is_reported_as_given_and_warned() {
    let (o, _) = on_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [0, 0] }, { "id": "b", "at": [10, 0] }] },
                "size": "M3", "fit": "tap", "depth": { "blind": 4 }, "thread": { "depth": 50 } }),
        8.0,
    )
    .expect("hole");
    assert_eq!(o.holes[0].thread.as_ref().and_then(|t| t.depth), Some(50.0));
    let notes: Vec<(&str, Value)> = o
        .notes
        .iter()
        .map(|n| (n.code(), serde_json::to_value(n).expect("json")))
        .collect();
    assert_eq!(
        notes,
        [
            (
                "FORGE_HOLE_THREAD_DEEPER_THAN_HOLE",
                json!({ "at": "a", "depth": 50.0, "hole_depth": 4.0 })
            ),
            (
                "FORGE_HOLE_THREAD_DEEPER_THAN_HOLE",
                json!({ "at": "b", "depth": 50.0, "hole_depth": 4.0 })
            ),
        ]
    );
    // Within the hole, or a through hole: no warning.
    let (o, _) = on_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [0, 0] }] }, "size": "M3", "depth": { "blind": 4 }, "thread": { "depth": 4 } }),
        8.0,
    )
    .expect("hole");
    assert!(o.notes.is_empty(), "{:?}", o.notes);
    let (o, _) = on_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [0, 0] }] }, "size": "M3", "depth": "through", "thread": { "depth": 50 } }),
        8.0,
    )
    .expect("hole");
    assert!(o.notes.is_empty(), "{:?}", o.notes);
}

/// A hole placed on a datum plane inside its target keeps the tool's top disc: the face
/// `H/top@p`, a role SPEC §5.2's hole row does not list (W5 contract issue: the table needs
/// `top`, and `end` for pattern copies). This pins the key Forge gives it until the Contract
/// stage rules.
#[test]
fn a_hole_on_a_plane_inside_its_target_keeps_its_top_face_keyed_top() {
    let plate = aabox("e1", [-30.0, -20.0, 0.0], [60.0, 40.0, 8.0]);
    let frame = top(4.0);
    let (spec, pos) = prepared(
        json!({ "at": { "list": [{ "id": "p", "at": [0, 0] }] }, "d": 3, "depth": { "blind": 2 } }),
        &frame,
    );
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: None,
        up_to: None,
        timeline: 1,
        scope_scale: None,
    };
    let o = apply_hole(&spec, &pos, &site, &[ob(plate, "e1")]).expect("an internal void");
    let keys: Vec<String> = only_body(&o)
        .faces()
        .iter()
        .map(|(_, f)| f.provenance.key())
        .filter(|k| k.starts_with("h1/"))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    assert_eq!(keys, ["h1/tip@p", "h1/top@p", "h1/wall@p"]);
}

/// `up_to` decides hits without an angular cut-off: an axis exactly parallel to the face's
/// plane never hits it, a nearly parallel one (within `ANGULAR_TOLERANCE` of it) hits the
/// plane where the face test says, on the face or off it.
#[test]
fn up_to_axes_parallel_to_the_face_miss_and_nearly_parallel_ones_hit() {
    let block = aabox("e1", [0.0, 0.0, 0.0], [60.0, 40.0, 8.0]);
    // The side face at x = 0 (outward normal −X).
    let side = block
        .faces()
        .iter()
        .find(|(_, f)| {
            f.provenance.role == Role::Side
                && f.provenance.sources.first().map(String::as_str) == Some("l")
        })
        .map(|(id, _)| id)
        .expect("side l");
    let down = -Vec3::unit_z();
    // Exactly parallel, 1e-8 mm off the plane: no hit.
    assert_eq!(
        up_to_depth(&block, side, Vec3::new(1e-8, 20.0, 8.0), down).expect("ok"),
        None
    );
    // 1e-9 rad towards the plane (= ANGULAR_TOLERANCE), 5e-9 mm off it: the ray meets the
    // plane 5 mm down, inside the face.
    let a = 1e-9_f64;
    let d = Vec3::new(-a.sin(), 0.0, -a.cos());
    let h = up_to_depth(&block, side, Vec3::new(5e-9, 20.0, 8.0), d)
        .expect("ok")
        .expect("hit");
    assert!((h - 5.0).abs() < 1e-6, "{h}");
    // 1e-13 rad, 1e-3 mm off: the plane is reached 1e10 mm away, off the face.
    let a = 1e-13_f64;
    let d = Vec3::new(-a.sin(), 0.0, -a.cos());
    assert_eq!(
        up_to_depth(&block, side, Vec3::new(1e-3, 20.0, 8.0), d).expect("ok"),
        None
    );
}

/// Position counts are bounded before any position is computed, and positions that
/// overflow are `INVALID_VALUE` at the field that overflowed, not "inf mm off the face".
#[test]
fn position_limits_and_overflows_are_structured_errors() {
    let frame = top(8.0);
    let positions = |at: Value| {
        let h = hole(json!({ "d": 3, "depth": "through", "at": at }));
        let lit = literal_hole(&h, |s, _, _| s.literal().ok_or(())).expect("literals");
        hole_positions(&lit.at, &frame, &[])
    };
    let e = positions(
        json!({ "grid": { "nx": 2147483648u64, "ny": 2147483648u64, "dx": 1, "dy": 1 } }),
    )
    .expect_err("too many");
    assert_eq!(e.code(), "FORGE_HOLE_TOO_MANY_POSITIONS");
    let HoleErrorDetails::Limit { field, max, .. } = e.details() else {
        panic!("{e}")
    };
    assert_eq!(
        (field.as_str(), max),
        ("/at/grid", MAX_HOLE_POSITIONS as f64)
    );
    assert_eq!(
        positions(json!({ "circle": { "n": 10001, "d": 50 } }))
            .expect_err("too many")
            .code(),
        "FORGE_HOLE_TOO_MANY_POSITIONS"
    );
    // The limit itself is allowed.
    assert_eq!(
        positions(json!({ "grid": { "nx": 100, "ny": 100, "dx": 1, "dy": 1 } }))
            .expect("ok")
            .len(),
        MAX_HOLE_POSITIONS
    );
    let e = positions(json!({ "grid": { "nx": 5, "ny": 1, "dx": 1e308, "dy": 0 } }))
        .expect_err("overflow");
    assert_eq!(e.code(), "INVALID_VALUE");
    let HoleErrorDetails::Range { field, value, .. } = e.details() else {
        panic!("{e}")
    };
    assert_eq!((field.as_str(), value), ("/at/grid/dx", 1e308));
    let e = positions(
        json!({ "grid": { "nx": 1, "ny": 3, "dx": 0, "dy": -1.5e308, "center": [0, 1e308] } }),
    )
    .expect_err("overflow");
    assert!(e.to_string().contains("/at/grid/dy"), "{e}");
    let e = positions(json!({ "list": [{ "id": "a", "at": [1.7e308, 0] }] }));
    // Finite in (u, v) but the frame origin is at z = 8: still finite, so fine.
    assert!(e.is_ok());
}

/// Review 5, the tol band at the far face of a 10 mm plate (the differential's fixed cases
/// `tip_band_*` and `floor_band_*`): an M3 hole whose drill-point apex, or whose flat floor,
/// ends `below` under the far face (negative: above it). Wherever the bottom is within tol of
/// the face ([R-3]: on it) Forge fails explicitly — never a body that treats the bottom and
/// the face as distinct without a warning; 1.5e-6 mm away the bottom and the face are
/// distinct: a body, which warns iff the bottom is below the face.
#[test]
fn a_bottom_within_tol_of_the_far_face_never_gives_a_silent_body() {
    let tip = 1.7 / 59f64.to_radians().tan();
    for (flat, drop) in [(false, tip), (true, 0.0)] {
        let run = |below: f64| {
            let mut f = json!({ "at": { "list": [{ "id": "a", "at": [0.0, 0.0] }] }, "size": "M3",
                                "depth": { "blind": 10.0 - drop + below } });
            if flat {
                f["tip"] = json!("flat");
            }
            on_plate(f, 10.0)
        };
        for below in [-0.9e-6, -0.5e-6, 0.0, 0.5e-6, 0.9e-6] {
            match run(below) {
                Err(e) => assert!(
                    e.code() == "BOOLEAN_NON_MANIFOLD" || e.code().starts_with("FORGE_BOOLEAN_"),
                    "flat {flat}, {below:e}: {e}"
                ),
                // A floor on the far face opens the hole: a through hole that warns.
                Ok((o, _)) => {
                    let codes: Vec<&str> = o.notes.iter().map(|n| n.code()).collect();
                    assert!(
                        flat && codes == ["HOLE_BREAKS_THROUGH"],
                        "flat {flat}, {below:e}: a body with {codes:?}"
                    );
                }
            }
        }
        let (o, _) = run(-1.5e-6).expect("a 1.5e-6 mm web under the bottom");
        assert!(o.notes.is_empty(), "flat {flat}: {:?}", o.notes);
        if let Ok((o, _)) = run(1.5e-6) {
            let codes: Vec<&str> = o.notes.iter().map(|n| n.code()).collect();
            assert_eq!(codes, ["HOLE_BREAKS_THROUGH"], "flat {flat}");
        }
    }
}

/// The W4 part of `a_bottom_within_tol_of_the_far_face_never_gives_a_silent_body`: by [R-3] a
/// drill-point apex within tol of the far face lies on it, so every such hole fails like the
/// exact case, with `BOOLEAN_NON_MANIFOLD` at the apex (kind `vertex`). Today an apex 0.5e-6
/// or 0.9e-6 mm **below** the face is `FORGE_BOOLEAN_INCONSISTENT` (explicit; the W5 guard only
/// sees results W4 returns). Owner: W4 ([R-3] for a tool vertex against a target face);
/// un-ignore when fixed. (If the Contract stage rules a touching tip `HOLE_BREAKS_THROUGH`
/// instead, as the W7b oracle reads it, change this test and the guard's apex test.)
#[test]
#[ignore = "W4: an apex within tol under the far face is FORGE_BOOLEAN_INCONSISTENT, not a vertex contact"]
fn w4_a_drill_point_just_through_the_far_face() {
    let tip = 1.7 / 59f64.to_radians().tan();
    for below in [0.5e-6, 0.9e-6] {
        let e = on_plate(
            json!({ "at": { "list": [{ "id": "a", "at": [0.0, 0.0] }] }, "size": "M3",
                    "depth": { "blind": 10.0 - tip + below } }),
            10.0,
        )
        .expect_err("the apex touches the far face");
        assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD", "{below:e}: {e}");
        let d = serde_json::to_value(e.details()).expect("details");
        assert_eq!(d["probe"]["kind"], "vertex", "{below:e}: {d}");
    }
}
