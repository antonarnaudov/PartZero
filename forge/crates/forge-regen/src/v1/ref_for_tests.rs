//! `refFor`: picks by render name, key, point and body origin; kind conversion; split pieces;
//! blend faces (queries narrowed by `extreme`); refusals; and the property that every face and
//! edge of a model gets a reference that a feature resolves to exactly it.

use forge_ir::v1::metrics::{Origin, Status};
use forge_ir::v1::{Document, EntityKind};
use forge_refs::{Entity, EntityId, Scope};
use serde_json::{Value, json};

use super::{Pick, RefFor, RefForError, ref_for};
use crate::v1::part::PartEval;

fn doc_of(features: Value) -> Document {
    let text = json!({
        "schema": "aicad.ir/1",
        "meta": { "name": "t" },
        "params": [],
        "parts": [{ "id": "p1", "name": "part", "features": features }]
    })
    .to_string();
    crate::v1::load(&text).expect("loads").doc
}

fn slab(w: f64, h: f64, d: f64) -> Vec<Value> {
    vec![
        json!({ "type": "sketch", "id": "s1", "name": "outline", "plane": "XY",
                "curves": [{ "kind": "rect", "id": "r", "center": [0, 0], "w": w, "h": h }] }),
        json!({ "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": d }),
    ]
}

/// Every entity of `kind` at the end of part 0: `(name, key, probe point)`.
fn entities(doc: &Document, kind: EntityKind) -> Vec<(Option<String>, String, [f64; 3], Origin)> {
    let pv = forge_params::evaluate(doc);
    let n = doc.parts[0].features.len();
    PartEval::new(doc, 0, &pv).scope_at(n, |s: &Scope<'_>| {
        s.entities(kind)
            .into_iter()
            .map(|e: Entity| {
                let body = s.body(e);
                let name = match e.id {
                    EntityId::Face(f) => body.face(f).map(|x| x.provenance.name()),
                    EntityId::Edge(x) => body.edge(x).map(|x| x.provenance.name()),
                    _ => None,
                };
                let p = s.probe(e).expect("probe").point;
                (
                    name,
                    s.key(e).to_string(),
                    [p[0], p[1], p[2]],
                    s.origin(e.body).clone(),
                )
            })
            .collect()
    })
}

fn pick(kind: EntityKind, name: Option<&str>, point: Option<[f64; 3]>) -> Pick {
    Pick {
        kind,
        name: name.map(str::to_string),
        key: None,
        point,
        body: None,
    }
}

/// The document with `feature` appended, evaluated: that feature's report entry status.
fn builds_with(doc: &Document, feature: Value) -> (Status, Value) {
    let mut v = serde_json::to_value(doc).unwrap();
    v["parts"][0]["features"]
        .as_array_mut()
        .unwrap()
        .push(feature);
    let text = v.to_string();
    let (r, ev) = crate::v1::evaluate_text(&text, "t", "t");
    assert!(ev.is_some(), "rejected: {:?}", r.error);
    let last = r.features.last().unwrap();
    (last.status, serde_json::to_value(last).unwrap())
}

fn member_keys(r: &RefFor) -> Vec<String> {
    r.members.iter().map(|m| m.key.clone()).collect()
}

#[test]
fn an_edge_picked_by_its_render_name_gets_a_captured_ref_a_fillet_resolves_to_exactly_it() {
    let d = doc_of(Value::Array(slab(40.0, 20.0, 5.0)));
    let edges = entities(&d, EntityKind::Edge);
    let (name, key, p, _) = edges
        .iter()
        .find(|(n, ..)| n.as_deref() == Some("e1/edge:{e1/cap:end|e1/side:r.top}"))
        .expect("the top edge")
        .clone();
    let r = ref_for(
        &d,
        0,
        2,
        EntityKind::Edge,
        &[pick(EntityKind::Edge, name.as_deref(), Some(p))],
        None,
    )
    .expect("a ref");
    assert_eq!(member_keys(&r), vec![key.clone()]);
    assert!(r.r.capture.is_some(), "the ref carries a capture");
    let (status, entry) = builds_with(
        &d,
        json!({ "type": "fillet", "id": "f1", "name": "f1", "r": 1, "edges": serde_json::to_value(&r.r).unwrap() }),
    );
    assert_eq!(status, Status::Ok, "{entry}");
    let members = &entry["refs"][0]["members"];
    assert_eq!(members.as_array().unwrap().len(), 1);
    assert_eq!(members[0]["key"], json!(key));
    assert_eq!(entry["refs"][0]["status"], json!("exact"));
}

#[test]
fn picked_faces_become_their_boundary_edges_and_a_picked_key_works_like_a_name() {
    let d = doc_of(Value::Array(slab(40.0, 20.0, 5.0)));
    let faces = entities(&d, EntityKind::Face);
    let (_, key, p, _) = faces
        .iter()
        .find(|(n, ..)| n.as_deref() == Some("e1/cap:end"))
        .unwrap()
        .clone();
    let by_key = Pick {
        kind: EntityKind::Face,
        name: None,
        key: Some(key),
        point: Some(p),
        body: None,
    };
    let r = ref_for(&d, 0, 2, EntityKind::Edge, &[by_key], None).expect("a ref");
    assert_eq!(r.members.len(), 4, "the cap's four edges");
    assert!(matches!(r.r.q, forge_ir::v1::Query::Edges { .. }));
    let (status, entry) = builds_with(
        &d,
        json!({ "type": "chamfer", "id": "c1", "name": "c1", "d": 1, "edges": serde_json::to_value(&r.r).unwrap() }),
    );
    assert_eq!(status, Status::Ok, "{entry}");
}

#[test]
fn several_edges_are_one_union_ref_and_a_body_is_picked_by_its_origin() {
    let d = doc_of(Value::Array(slab(40.0, 20.0, 5.0)));
    let edges = entities(&d, EntityKind::Edge);
    let vertical: Vec<Pick> = edges
        .iter()
        .filter(|(n, ..)| n.as_deref().is_some_and(|n| !n.contains("cap:")))
        .map(|(n, _, p, _)| pick(EntityKind::Edge, n.as_deref(), Some(*p)))
        .collect();
    assert_eq!(vertical.len(), 4);
    let r = ref_for(&d, 0, 2, EntityKind::Edge, &vertical, None).expect("a ref");
    assert_eq!(r.members.len(), 4);
    assert!(matches!(r.r.q, forge_ir::v1::Query::Union { .. }));
    let body = Pick {
        kind: EntityKind::Body,
        name: None,
        key: None,
        point: None,
        body: Some(Origin {
            feature: "e1".into(),
            member: "r.bottom".into(),
            instance: None,
        }),
    };
    let b = ref_for(&d, 0, 2, EntityKind::Body, &[body], None).expect("a body ref");
    assert_eq!(member_keys(&b), vec!["e1/body:r.bottom".to_string()]);
    let top = edges
        .iter()
        .find(|(n, ..)| n.as_deref() == Some("e1/cap:end"))
        .map(|x| x.2);
    assert!(top.is_none(), "faces are not edges");
}

#[test]
fn a_blend_face_of_a_fillet_gets_an_exact_ref() {
    let mut fs = slab(40.0, 20.0, 5.0);
    fs.push(
        json!({ "type": "fillet", "id": "f1", "name": "round", "r": 2,
        "edges": { "kind": "edge", "q": { "op": "filter", "where": { "parallel": "Z" },
                   "of": { "op": "edges", "of": { "op": "sides", "feature": "e1" } } } } }),
    );
    let d = doc_of(Value::Array(fs));
    let faces = entities(&d, EntityKind::Face);
    let blends: Vec<_> = faces
        .iter()
        .filter(|(n, ..)| n.as_deref().is_some_and(|n| n.starts_with("f1/blend")))
        .collect();
    assert_eq!(blends.len(), 4);
    for (name, key, p, _) in blends {
        let r = ref_for(
            &d,
            0,
            3,
            EntityKind::Face,
            &[pick(EntityKind::Face, name.as_deref(), Some(*p))],
            None,
        )
        .expect("a ref");
        assert_eq!(member_keys(&r), vec![key.clone()]);
    }
}

#[test]
fn split_pieces_that_share_a_name_are_told_apart_by_the_picked_point() {
    // A slot cut through the middle of the slab's top splits nothing, but a cut across the
    // whole width splits the long sides into two pieces each.
    let mut fs = slab(40.0, 20.0, 10.0);
    fs.push(
        json!({ "type": "sketch", "id": "s2", "name": "slot", "plane": "XY",
                    "curves": [{ "kind": "rect", "id": "c", "center": [0, 0], "w": 4, "h": 30 }] }),
    );
    fs.push(
        json!({ "type": "extrude", "id": "e2", "name": "cutter", "sketch": "s2", "distance": 10,
                    "op": "cut", "targets": "all" }),
    );
    let d = doc_of(Value::Array(fs));
    let faces = entities(&d, EntityKind::Face);
    let tops: Vec<_> = faces
        .iter()
        .filter(|(n, ..)| n.as_deref().is_some_and(|n| n.starts_with("e1/cap:end")))
        .collect();
    assert!(tops.len() >= 2, "the cap is split: {tops:?}");
    let mut seen = Vec::new();
    for (name, _, p, _) in &tops {
        let r = ref_for(
            &d,
            0,
            4,
            EntityKind::Face,
            &[pick(EntityKind::Face, name.as_deref(), Some(*p))],
            None,
        )
        .expect("a ref");
        assert_eq!(r.members.len(), 1, "one piece");
        let probe = r.members[0].probe.point;
        seen.push([probe[0], probe[1], probe[2]]);
    }
    seen.sort_by(|a, b| a.partial_cmp(b).unwrap());
    seen.dedup();
    assert_eq!(seen.len(), tops.len(), "each pick designates its own piece");
}

#[test]
fn refusals_say_which_pick_and_why() {
    let d = doc_of(Value::Array(slab(40.0, 20.0, 5.0)));
    let err: RefForError = ref_for(
        &d,
        0,
        2,
        EntityKind::Edge,
        &[pick(EntityKind::Edge, Some("e9/edge:{x|y}"), None)],
        None,
    )
    .unwrap_err();
    assert_eq!(err.code, "COMMAND_PICK_NOT_FOUND");
    assert_eq!(err.details["pick"], json!(0));
    let err = ref_for(&d, 0, 2, EntityKind::Edge, &[], None).unwrap_err();
    assert_eq!(err.code, "COMMAND_INVALID_ARGUMENT");
    let err = ref_for(
        &d,
        0,
        2,
        EntityKind::Face,
        &[pick(
            EntityKind::Edge,
            Some("e1/edge:{e1/cap:end|e1/side:r.top}"),
            None,
        )],
        None,
    )
    .unwrap_err();
    assert_eq!(
        err.code, "COMMAND_INVALID_ARGUMENT",
        "an edge is not a face"
    );
    // Before the extrude (at 1) there is no body: the pick is not found.
    let err = ref_for(
        &d,
        0,
        1,
        EntityKind::Edge,
        &[pick(
            EntityKind::Edge,
            Some("e1/edge:{e1/cap:end|e1/side:r.top}"),
            None,
        )],
        None,
    )
    .unwrap_err();
    assert_eq!(err.code, "COMMAND_PICK_NOT_FOUND");
}

#[test]
fn a_vertex_is_picked_by_its_point() {
    let d = doc_of(Value::Array(slab(40.0, 20.0, 5.0)));
    let r = ref_for(
        &d,
        0,
        2,
        EntityKind::Vertex,
        &[pick(EntityKind::Vertex, None, Some([20.0, 10.0, 5.0]))],
        None,
    )
    .expect("a ref");
    assert_eq!(r.members.len(), 1);
    let p = r.members[0].probe.point;
    assert!((p[0] - 20.0).abs() < 1e-9 && (p[1] - 10.0).abs() < 1e-9 && (p[2] - 5.0).abs() < 1e-9);
}

mod props {
    use proptest::prelude::*;

    use super::*;

    proptest! {
        #![proptest_config(ProptestConfig { cases: 12, ..ProptestConfig::default() })]

        /// Every face and every edge of a slab with a pocket, picked by name and probe point,
        /// gets a reference that a feature at the end of the part resolves to exactly it.
        #[test]
        fn every_face_and_edge_gets_an_exact_ref(
            w in 20.0f64..80.0, h in 20.0f64..60.0, d in 3.0f64..20.0,
            pw in 0.2f64..0.6, ph in 0.2f64..0.6, depth in 0.2f64..0.8,
        ) {
            let mut fs = slab(w, h, d);
            fs.push(json!({ "type": "sketch", "id": "s2", "name": "pocket", "plane": { "origin": [0, 0, d], "normal": [0, 0, 1], "x_dir": [1, 0, 0] },
                            "curves": [{ "kind": "rect", "id": "c", "center": [0, 0], "w": w * pw, "h": h * ph }] }));
            fs.push(json!({ "type": "extrude", "id": "e2", "name": "cut", "sketch": "s2",
                            "distance": d * depth, "direction": "reverse", "op": "cut", "targets": "all" }));
            let doc = doc_of(Value::Array(fs));
            for kind in [EntityKind::Face, EntityKind::Edge] {
                for (name, key, p, _) in entities(&doc, kind) {
                    let r = ref_for(&doc, 0, 4, kind, &[pick(kind, name.as_deref(), Some(p))], None);
                    let r = r.map_err(|e| TestCaseError::fail(format!("{name:?}: {e}")))?;
                    prop_assert_eq!(member_keys(&r), vec![key.clone()], "{:?}", name);
                }
            }
        }
    }
}
