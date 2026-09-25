//! Picks must belong to the body operated on (review of W6): face and edge ids are per-body
//! arena indices, so an id of another body — or one the body does not have — must fail
//! explicitly, naming the pick by its key, never shell or blend the entity of this body that
//! happens to have the same index.

mod common;

use common::*;
use forge_blend::{
    BlendOptions, ChamferSpec, Pick, ShellDirection, ShellOptions, chamfer, fillet, shell,
};
use forge_core::topo::{EdgeId, FaceId};

fn no_placeholder_keys(d: &serde_json::Map<String, serde_json::Value>) {
    let text = serde_json::Value::Object(d.clone()).to_string();
    assert!(!text.contains("\"?\""), "{text}");
}

#[test]
fn an_open_face_of_another_body_is_not_on_the_body() {
    let cube = aabox("e1", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    let other = aabox("e9", [50.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    // Several faces of the other body: their ids exist in the cube too (same arena indices).
    for p in [[55.0, 10.0, 30.0], [55.0, 0.0, 15.0], [60.0, 10.0, 15.0]] {
        let f = face_near(&other, p);
        assert!(cube.face(f).is_some(), "the id is also a face of the cube");
        let pick = forge_blend::pick_faces(&other, 1, &[f]).remove(0);
        let err = shell(
            &cube,
            std::slice::from_ref(&pick),
            1.0,
            ShellDirection::Inward,
            &ShellOptions::new("sh1"),
        )
        .expect_err("foreign face");
        assert_eq!(err.code(), "SHELL_FACE_NOT_ON_BODY", "{err}");
        let d = err.details();
        assert_eq!(d["faces"][0], pick.key.as_str());
        no_placeholder_keys(&d);
    }
}

#[test]
fn an_open_face_id_the_body_does_not_have_is_not_on_the_body() {
    let cube = aabox("e1", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    let pick = Pick::new(0, FaceId::from_raw_parts(999, 0), "x1/cap:end");
    let err = shell(
        &cube,
        &[pick],
        1.0,
        ShellDirection::Inward,
        &ShellOptions::new("sh1"),
    )
    .expect_err("unknown face");
    assert_eq!(err.code(), "SHELL_FACE_NOT_ON_BODY", "{err}");
    let d = err.details();
    assert_eq!(d["faces"][0], "x1/cap:end");
    no_placeholder_keys(&d);
}

#[test]
fn an_edge_of_another_body_is_never_blended() {
    let cube = aabox("e1", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    let other = aabox("e9", [50.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let e = edge_near(&other, [55.0, 0.0, 30.0]);
    assert!(cube.edge(e).is_some(), "the id is also an edge of the cube");
    let pick = forge_blend::pick_edges(&other, 1, &[e]).remove(0);
    let err = fillet(
        &cube,
        std::slice::from_ref(&pick),
        1.0,
        &BlendOptions::new("f1"),
    )
    .expect_err("foreign");
    assert_eq!(err.code(), "FILLET_FAILED", "{err}");
    let d = err.details();
    assert_eq!(d["edges"][0]["key"], pick.key.as_str());
    assert!(err.to_string().contains("body #1"), "{err}");
    no_placeholder_keys(&d);
    let err = chamfer(
        &cube,
        &[pick],
        &ChamferSpec::Equal { d: 1.0 },
        &BlendOptions::new("c1"),
    )
    .expect_err("foreign");
    assert_eq!(err.code(), "CHAMFER_FAILED", "{err}");
}

#[test]
fn an_edge_id_the_body_does_not_have_is_named_by_its_key() {
    let cube = aabox("e1", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    let pick = Pick::new(
        0,
        EdgeId::from_raw_parts(999, 0),
        "x1/edge:{x1/cap:end|x1/side:b}",
    );
    let err = fillet(&cube, &[pick], 1.0, &BlendOptions::new("f1")).expect_err("unknown");
    assert_eq!(err.code(), "FILLET_FAILED", "{err}");
    let d = err.details();
    assert_eq!(d["edges"][0]["key"], "x1/edge:{x1/cap:end|x1/side:b}");
    no_placeholder_keys(&d);
}

#[test]
fn a_chamfer_side_of_another_body_is_not_adjacent() {
    let cube = aabox("e1", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    let other = aabox("e9", [50.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    let e = edge_near(&cube, [5.0, 0.0, 10.0]);
    // The other body's top face has the same index as the cube's top face.
    let side =
        forge_blend::pick_faces(&other, 1, &[face_near(&other, [55.0, 5.0, 10.0])]).remove(0);
    assert!(cube.face(side.id).is_some());
    let err = chamfer(
        &cube,
        &es(&cube, &[e]),
        &ChamferSpec::TwoDistances {
            d: 1.0,
            d2: 2.0,
            side,
        },
        &BlendOptions::new("c1"),
    )
    .expect_err("foreign side");
    assert_eq!(err.code(), "CHAMFER_SIDE_NOT_ADJACENT", "{err}");
    no_placeholder_keys(&err.details());
}

#[test]
fn picks_of_the_body_under_another_index_follow_the_options() {
    // The body's own picks under the index the options name are accepted.
    let cube = aabox("e1", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    let e = edge_near(&cube, [5.0, 0.0, 10.0]);
    let picks = forge_blend::pick_edges(&cube, 7, &[e]);
    let mut o = BlendOptions::new("f1");
    o.body = 7;
    fillet(&cube, &picks, 1.0, &o).expect("own edge");
    let err = fillet(&cube, &picks, 1.0, &BlendOptions::new("f1")).expect_err("index 0");
    assert_eq!(err.code(), "FILLET_FAILED");
}
