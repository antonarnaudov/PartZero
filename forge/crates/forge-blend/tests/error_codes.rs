//! The E-stage codes of SPEC §6.6–§6.8 with their `details`, asserted exactly (W6 review
//! round 5): the Forge side of the conformance fixtures proposed to the Contract stage
//! (`FILLET_RADIUS_TOO_LARGE` with `max_feasible_r` and `limit`, `FILLET_EDGE_UNSUPPORTED`,
//! `CHAMFER_DISTANCE_TOO_LARGE`, `CHAMFER_SIDE_NOT_ADJACENT`, `SHELL_THICKNESS_TOO_LARGE`,
//! `SHELL_FACE_NOT_ON_BODY`, and the info `SHELL_CLOSED_VOID`). Every value is a closed form
//! of the geometry, not a number read back from Forge.

mod common;

use common::*;
use forge_blend::{
    BlendOptions, ChamferSpec, KeyMap, Pick, ShellDirection, ShellOptions, chamfer, fillet, shell,
};
use serde_json::{Value, json};

fn key_of_face(b: &forge_core::topo::Body, p: [f64; 3]) -> String {
    KeyMap::derive(b).face(face_near(b, p)).expect("face").key
}

fn key_of_edge(b: &forge_core::topo::Body, p: [f64; 3]) -> String {
    KeyMap::derive(b).edge(edge_near(b, p)).expect("edge").key
}

/// `details` with every entity list sorted by key (the SPEC compares them as multisets).
fn details(e: &forge_blend::BlendError) -> Value {
    let mut d = Value::Object(e.details());
    for k in ["edges", "limits", "faces"] {
        if let Some(Value::Array(a)) = d.get_mut(k) {
            a.sort_by_key(|x| {
                x.get("key")
                    .and_then(Value::as_str)
                    .or_else(|| x.as_str())
                    .unwrap_or_default()
                    .to_string()
            });
        }
    }
    d
}

#[test]
fn fillet_radius_too_large_names_the_face_width_with_its_closed_form() {
    // Box 10 × 20 × 30; the two long top edges share the 10 mm top face: 2r < 10.
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let (p, q) = ([0.0, 10.0, 30.0], [10.0, 10.0, 30.0]);
    let edges = [edge_near(&b, p), edge_near(&b, q)];
    let err = fillet(&b, &es(&b, &edges), 6.0, &BlendOptions::new("f1")).expect_err("too large");
    assert_eq!(err.code(), "FILLET_RADIUS_TOO_LARGE");
    let top = key_of_face(&b, [5.0, 10.0, 30.0]);
    let mut want = [key_of_edge(&b, p), key_of_edge(&b, q)];
    want.sort();
    let edge = |k: &str| json!({ "key": k, "name": k, "max_r": 4.999, "limit": "face-width", "face": top });
    assert_eq!(
        details(&err),
        json!({ "r": 6.0, "max_feasible_r": 4.999, "edges": [edge(&want[0]), edge(&want[1])] })
    );
}

#[test]
fn fillet_edge_unsupported_names_a_smooth_edge() {
    // After a fillet, the edge between the blend and its face is smooth.
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let e = edge_near(&b, [10.0, 20.0, 15.0]);
    let b1 = fillet(&b, &es(&b, &[e]), 2.0, &BlendOptions::new("f1"))
        .expect("fillet")
        .body;
    // The contact line on the x = 10 face: y = 18.
    let smooth = edge_near(&b1, [10.0, 18.0, 15.0]);
    let key = KeyMap::derive(&b1).edge(smooth).expect("edge").key;
    let err = fillet(&b1, &es(&b1, &[smooth]), 1.0, &BlendOptions::new("f2")).expect_err("smooth");
    assert_eq!(err.code(), "FILLET_EDGE_UNSUPPORTED");
    assert_eq!(
        details(&err),
        json!({ "edges": [{ "key": key, "name": key, "reason": "smooth" }] })
    );
}

#[test]
fn chamfer_distance_too_large_has_its_closed_form() {
    // A 10 mm face between two chamfered edges: 2d < 10.
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let (p, q) = ([0.0, 10.0, 30.0], [10.0, 10.0, 30.0]);
    let edges = [edge_near(&b, p), edge_near(&b, q)];
    let err = chamfer(
        &b,
        &es(&b, &edges),
        &ChamferSpec::Equal { d: 7.0 },
        &BlendOptions::new("c1"),
    )
    .expect_err("too large");
    assert_eq!(err.code(), "CHAMFER_DISTANCE_TOO_LARGE");
    let mut want = [key_of_edge(&b, p), key_of_edge(&b, q)];
    want.sort();
    let edge = |k: &str| json!({ "key": k, "name": k, "max_d": 4.999 });
    assert_eq!(
        details(&err),
        json!({ "d": 7.0, "max_feasible_d": 4.999, "edges": [edge(&want[0]), edge(&want[1])] })
    );
}

#[test]
fn chamfer_side_not_adjacent_names_the_edge() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let e = edge_near(&b, [10.0, 20.0, 15.0]);
    let bottom = face_near(&b, [5.0, 10.0, 0.0]);
    let key = key_of_edge(&b, [10.0, 20.0, 15.0]);
    let spec = ChamferSpec::TwoDistances {
        d: 1.0,
        d2: 2.0,
        side: f1(&b, bottom),
    };
    let err = chamfer(&b, &es(&b, &[e]), &spec, &BlendOptions::new("c1")).expect_err("side");
    assert_eq!(err.code(), "CHAMFER_SIDE_NOT_ADJACENT");
    assert_eq!(
        details(&err),
        json!({ "edges": [{ "key": key, "name": key }] })
    );
}

#[test]
fn shell_thickness_too_large_has_its_closed_form() {
    // An open box 10 × 20 × 30 shelled inward: the walls 10 mm apart meet at t = 5.
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let top = face_near(&b, [5.0, 10.0, 30.0]);
    let err = shell(
        &b,
        &fs(&b, &[top]),
        6.0,
        ShellDirection::Inward,
        &ShellOptions::new("sh1"),
    )
    .expect_err("too thick");
    assert_eq!(err.code(), "SHELL_THICKNESS_TOO_LARGE");
    let d = details(&err);
    assert_eq!(d["thickness"], json!(6.0));
    assert_eq!(d["max_feasible_thickness"], json!(4.999));
    // The two walls 10 mm apart are among the limits, as gaps.
    let limits = d["limits"].as_array().expect("limits");
    for p in [[0.0, 10.0, 15.0], [10.0, 10.0, 15.0]] {
        let k = key_of_face(&b, p);
        assert!(
            limits
                .iter()
                .any(|l| l["key"] == json!(k) && l["name"] == json!(k) && l["reason"] == "gap"),
            "{k} not among {limits:?}"
        );
    }
    assert!(
        limits
            .iter()
            .all(|l| l.as_object().expect("limit").len() == 3)
    );
}

#[test]
fn shell_face_not_on_body_lists_the_faces_by_key() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let other = aabox("e2", [50.0, 0.0, 0.0], [5.0, 5.0, 5.0]);
    let f = face_near(&other, [52.5, 2.5, 5.0]);
    let k = KeyMap::derive(&other).face(f).expect("face").key;
    let err = shell(
        &b,
        &[Pick::new(1, f, k.clone())],
        1.0,
        ShellDirection::Inward,
        &ShellOptions::new("sh1"),
    )
    .expect_err("another body's face");
    assert_eq!(err.code(), "SHELL_FACE_NOT_ON_BODY");
    // Keys only: SPEC §6.8 does not define the entries' shape (a contract issue: the other
    // codes list `{ key, name }`).
    assert_eq!(details(&err), json!({ "faces": [k] }));
}

#[test]
fn a_closed_shell_reports_its_void() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let out = shell(
        &b,
        &[],
        1.0,
        ShellDirection::Inward,
        &ShellOptions::new("sh1"),
    )
    .expect("closed void");
    assert!(out.report.closed_void, "SHELL_CLOSED_VOID");
    assert!(out.report.removed_faces.is_empty());
    assert_eq!(out.body.shell_ids().len(), 2);
    assert!(rel(volume(&out.body), 6000.0 - 8.0 * 18.0 * 28.0) < 1e-12);
}

/// The fixture proposed to the Contract stage (W6 review round 6,
/// `tests/fixtures/blends-conformance-proposed.json`): every document passes the rejection
/// stage (forge-ir's loader: schema and static checks), every case expects an E-stage code of
/// §6.6–§6.8, and its feasible values are the closed forms the notes state (independent of
/// Forge: the half face widths 5 and 3.41, the inradius 10/(2√3), rounded down past the limit).
#[test]
fn the_proposed_conformance_fixture_is_well_formed() {
    let text = include_str!("fixtures/blends-conformance-proposed.json");
    let fx: Value = serde_json::from_str(text).expect("json");
    let cases = fx["cases"].as_array().expect("cases");
    assert!(cases.len() >= 9);
    let closed = |x: f64| forge_blend::round_down_mm(x - 1e-9);
    for c in cases {
        let id = c["id"].as_str().expect("id");
        let doc = serde_json::to_string(&c["document"]).expect("document");
        forge_ir::v1::from_json(&doc).unwrap_or_else(|e| panic!("{id}: rejected: {e:?}"));
        let expect = c["expect"].as_object().expect("expect");
        assert_eq!(expect.len(), 1, "{id}");
        let (_, e) = expect.iter().next().expect("one feature");
        let code = e["code"].as_str().expect("code");
        assert!(
            ["FILLET_", "CHAMFER_", "SHELL_"]
                .iter()
                .any(|p| code.starts_with(p)),
            "{id}: {code}"
        );
        let d = &e["details"];
        let want = match id {
            "fillet-radius-too-large-shared-face-width" => Some(("max_feasible_r", closed(5.0))),
            "fillet-radius-too-large-spec-example" => Some(("max_feasible_r", closed(3.41))),
            "chamfer-distance-too-large-shared-face-width" => Some(("max_feasible_d", closed(5.0))),
            "shell-thickness-too-large-parallel-walls" => {
                Some(("max_feasible_thickness", closed(5.0)))
            }
            "shell-thickness-too-large-collapsing-cavity" => {
                Some(("max_feasible_thickness", closed(10.0 / (2.0 * 3f64.sqrt()))))
            }
            _ => None,
        };
        if let Some((k, v)) = want {
            assert_eq!(
                d[k].as_f64().map(f64::to_bits),
                Some(v.to_bits()),
                "{id}: {d}"
            );
        }
        assert!(d.get("reason").is_none(), "{id}: prose is not pinned");
    }
}
