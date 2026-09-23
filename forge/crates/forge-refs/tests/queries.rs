//! One test per query operation and per predicate (SPEC-v1 §5.3), plus named/broad tracking,
//! canonical order (§5.4), feature status gates (§5.7 step 1) and static rejections.
// Expected values are exact on purpose (closed forms, bit-exact frames).
#![allow(clippy::float_cmp)]

mod common;

use common::{Model, d_shape, half_cone, l_shape, plate, reprovenance, stadium};
use forge_core::topo::{Provenance, Role};
use forge_ir::v1::{EntityKind, Query, Via};
use forge_refs::{
    Entity, FeatureInfo, FeatureStatus, FeatureTable, QuerySet, Scope, ScopeBuilder, eval_query,
};
use serde_json::json;

fn q(v: serde_json::Value) -> Query {
    serde_json::from_value(v).expect("query")
}

fn run(s: &Scope<'_>, v: serde_json::Value) -> QuerySet {
    eval_query(&q(v), s).unwrap_or_else(|e| panic!("{e}"))
}

fn keys(s: &Scope<'_>, set: &QuerySet) -> Vec<String> {
    set.members
        .iter()
        .map(|m| s.key(m.entity).to_string())
        .collect()
}

fn points(s: &Scope<'_>, set: &QuerySet) -> Vec<[f64; 3]> {
    set.members
        .iter()
        .map(|m| s.props(m.entity).expect("props").centroid)
        .collect()
}

fn one_key(s: &Scope<'_>, v: serde_json::Value) -> String {
    let set = run(s, v);
    assert_eq!(set.members.len(), 1, "{:?}", keys(s, &set));
    s.key(set.members[0].entity).to_string()
}

// ---- named sources -------------------------------------------------------------------------

#[test]
fn body_selects_by_origin_and_member() {
    let m = plate();
    let s = m.scope();
    assert_eq!(
        one_key(&s, json!({ "op": "body", "feature": "e1" })),
        "e1/body:bottom"
    );
    // `member`: any curve of the origin region's outer loop.
    assert_eq!(
        one_key(
            &s,
            json!({ "op": "body", "feature": "e1", "member": "top" })
        ),
        "e1/body:bottom"
    );
    // The hole is not in the outer loop.
    assert!(
        run(
            &s,
            json!({ "op": "body", "feature": "e1", "member": "ring" })
        )
        .members
        .is_empty()
    );
    let set = run(&s, json!({ "op": "body", "feature": "e1" }));
    assert_eq!(set.kind, EntityKind::Body);
    assert_eq!(set.members[0].via, Via::Named);
}

#[test]
fn bodies_selects_every_body_broadly() {
    let (a, b) = (plate(), d_shape());
    let s = ScopeBuilder::new(merged_table(&[&a, &b]))
        .body(&a.bodies[0].0, a.bodies[0].1.clone())
        .body(&b.bodies[0].0, b.bodies[0].1.clone())
        .build();
    let set = run(&s, json!({ "op": "bodies" }));
    assert_eq!(keys(&s, &set), ["e1/body:bottom", "e2/body:bow"]);
    assert!(set.members.iter().all(|m| m.via == Via::Broad));
}

fn merged_table(models: &[&Model]) -> FeatureTable {
    let mut t = FeatureTable::new();
    for m in models {
        for f in m.table.iter() {
            t.push(f.clone());
        }
    }
    t
}

#[test]
fn cap_selects_the_extrude_caps_with_member_qualifiers() {
    let m = plate();
    let s = m.scope();
    assert_eq!(
        one_key(&s, json!({ "op": "cap", "feature": "e1", "end": "end" })),
        "e1/cap:end@bottom"
    );
    assert_eq!(
        one_key(
            &s,
            json!({ "op": "cap", "feature": "e1", "end": "start", "member": "left" })
        ),
        "e1/cap:start@bottom"
    );
    let set = run(&s, json!({ "op": "cap", "feature": "e1", "end": "end" }));
    assert_eq!(points(&s, &set)[0][2], 5.0, "the end cap is at the far end");
}

#[test]
fn endcap_selects_revolve_end_caps() {
    let m = half_cone();
    let s = m.scope();
    assert_eq!(
        one_key(
            &s,
            json!({ "op": "endcap", "feature": "r1", "end": "start" })
        ),
        "r1/endcap:start@a"
    );
    // The start cap lies on the profile plane (XZ, y = 0) on the +X side.
    let set = run(
        &s,
        json!({ "op": "endcap", "feature": "r1", "end": "start" }),
    );
    let c = points(&s, &set)[0];
    assert!(c[0] > 0.0 && c[1].abs() < 1e-12, "{c:?}");
}

#[test]
fn side_selects_the_face_of_a_curve() {
    let m = plate();
    let s = m.scope();
    assert_eq!(
        one_key(
            &s,
            json!({ "op": "side", "feature": "e1", "curve": "ring" })
        ),
        "e1/side:ring"
    );
    let set = run(
        &s,
        json!({ "op": "side", "feature": "e1", "curve": "bottom" }),
    );
    assert_eq!(set.members[0].via, Via::Named);
    assert_eq!(points(&s, &set)[0][1], -10.0);
}

#[test]
fn sides_selects_every_side_face_broadly() {
    let m = plate();
    let s = m.scope();
    let set = run(&s, json!({ "op": "sides", "feature": "e1" }));
    assert_eq!(set.members.len(), 5);
    assert!(set.members.iter().all(|m| m.via == Via::Broad));
    let with_member = run(
        &s,
        json!({ "op": "sides", "feature": "e1", "member": "right" }),
    );
    assert_eq!(with_member.members.len(), 5);
}

#[test]
fn edge_at_selects_the_junction_edge_of_a_curve_end() {
    let m = d_shape();
    let s = m.scope();
    // flat runs (3,-4) → (3,4): its end is the junction with bow.start at (3, 4).
    let set = run(
        &s,
        json!({ "op": "edge_at", "feature": "e2", "curve": "flat", "end": "end" }),
    );
    assert_eq!(
        keys(&s, &set),
        ["e2/edge:{e2/side:bow|e2/side:flat}@bow.start"]
    );
    let c = points(&s, &set)[0];
    assert!(
        (c[0] - 3.0).abs() < 1e-12 && (c[1] - 4.0).abs() < 1e-12,
        "{c:?}"
    );
    let other = run(
        &s,
        json!({ "op": "edge_at", "feature": "e2", "curve": "bow", "end": "end" }),
    );
    let c = points(&s, &other)[0];
    assert!((c[1] + 4.0).abs() < 1e-12, "{c:?}");
    assert_eq!(set.members[0].via, Via::Named);
}

#[test]
fn between_selects_edges_of_two_face_sets() {
    let m = plate();
    let s = m.scope();
    let set = run(
        &s,
        json!({ "op": "between", "a": { "op": "side", "feature": "e1", "curve": "ring" },
                "b": { "op": "cap", "feature": "e1", "end": "end" } }),
    );
    assert_eq!(keys(&s, &set), ["e1/edge:{e1/cap:end@bottom|e1/side:ring}"]);
    assert_eq!(set.members[0].via, Via::Named);
    // A broad side makes the members broad.
    let broad = run(
        &s,
        json!({ "op": "between", "a": { "op": "sides", "feature": "e1" },
                "b": { "op": "cap", "feature": "e1", "end": "end" } }),
    );
    assert_eq!(broad.members.len(), 5);
    assert!(broad.members.iter().all(|m| m.via == Via::Broad));
}

/// Hole faces are keyed `H/<part>@<position>` (W5 stamps them; simulated here).
#[test]
fn hole_face_selects_by_position_and_part() {
    let m = plate();
    let body = reprovenance(&m.bodies[0].0, |p| {
        if p.role == Role::Side && p.sources.iter().any(|x| x == "ring") {
            Provenance::new("h1", Role::Other("wall".into())).with_qualifier("m")
        } else {
            p.clone()
        }
    });
    let mut t = m.table.clone();
    t.push(FeatureInfo::new("h1", "bore", "hole"));
    let s = ScopeBuilder::new(t)
        .body(&body, m.bodies[0].1.clone())
        .build();
    assert_eq!(
        one_key(
            &s,
            json!({ "op": "hole_face", "feature": "h1", "at": "m", "part": "wall" })
        ),
        "h1/wall@m"
    );
    assert!(
        run(
            &s,
            json!({ "op": "hole_face", "feature": "h1", "at": "gone", "part": "wall" })
        )
        .members
        .is_empty()
    );
}

#[test]
fn created_selects_every_face_of_a_feature() {
    let m = plate();
    let s = m.scope();
    assert_eq!(
        run(&s, json!({ "op": "created", "feature": "e1" }))
            .members
            .len(),
        7
    );
    assert_eq!(
        run(
            &s,
            json!({ "op": "created", "feature": "e1", "role": "side" })
        )
        .members
        .len(),
        5
    );
    assert_eq!(
        run(
            &s,
            json!({ "op": "created", "feature": "e1", "role": "cap" })
        )
        .members
        .len(),
        2
    );
}

/// Pattern copies are keyed `P/copy:{K}@i` (W5; simulated here).
#[test]
fn instance_selects_the_faces_of_a_pattern_instance() {
    let m = d_shape();
    let copy = reprovenance(&m.bodies[0].0, |p| {
        Provenance::new("pt1", Role::Other("copy".into()))
            .with_sources([p.name()])
            .with_qualifier("1")
    });
    let mut t = m.table.clone();
    t.push(FeatureInfo::new("pt1", "row", "pattern"));
    let s = ScopeBuilder::new(t)
        .body(&m.bodies[0].0, m.bodies[0].1.clone())
        .body(
            &copy,
            forge_refs::Origin {
                feature: "pt1".into(),
                member: "bow".into(),
                instance: Some(vec![1]),
            },
        )
        .build();
    let set = run(
        &s,
        json!({ "op": "instance", "feature": "pt1", "index": [1] }),
    );
    assert_eq!(set.members.len(), 4, "two caps and two sides");
    assert!(set.members.iter().all(|m| m.entity.body == 1));
    assert!(
        run(
            &s,
            json!({ "op": "instance", "feature": "pt1", "index": [2] })
        )
        .members
        .is_empty()
    );
}

#[test]
fn tagged_reevaluates_the_tag_query_in_the_current_scope() {
    let m = plate();
    let mut t = m.table.clone();
    let mut tag = FeatureInfo::new("t1", "sideEdges", "tag");
    tag.tag = Some(common::r(json!({ "kind": "edge",
        "q": { "op": "filter", "where": { "parallel": "Z" },
               "of": { "op": "edges", "of": { "op": "sides", "feature": "e1" } } } })));
    t.push(tag.clone());
    let s = m.scope_with(t.clone());
    let set = run(&s, json!({ "op": "tagged", "feature": "t1" }));
    assert_eq!(set.members.len(), 4);
    // A suppressed tag is DEPENDENCY_SUPPRESSED.
    t.get_mut("t1").expect("tag").status = FeatureStatus::Suppressed;
    let s = m.scope_with(t);
    let err =
        eval_query(&q(json!({ "op": "tagged", "feature": "t1" })), &s).expect_err("suppressed");
    assert_eq!(err.code(), "DEPENDENCY_SUPPRESSED");
}

// ---- navigation ------------------------------------------------------------------------------

#[test]
fn faces_navigates_from_bodies_edges_and_vertices() {
    let m = plate();
    let s = m.scope();
    assert_eq!(
        run(
            &s,
            json!({ "op": "faces", "of": { "op": "body", "feature": "e1" } })
        )
        .members
        .len(),
        7
    );
    let e = json!({ "op": "edge_at", "feature": "e1", "curve": "bottom", "end": "end" });
    let set = run(&s, json!({ "op": "faces", "of": e }));
    assert_eq!(keys(&s, &set), ["e1/side:bottom", "e1/side:right"]);
    assert!(
        set.members.iter().all(|m| m.via == Via::Broad),
        "navigation clears named-ness"
    );
    let v = json!({ "op": "vertices", "of": e });
    assert_eq!(run(&s, json!({ "op": "faces", "of": v })).members.len(), 4);
}

#[test]
fn edges_navigates_from_bodies_faces_and_vertices() {
    let m = plate();
    let s = m.scope();
    assert_eq!(
        run(
            &s,
            json!({ "op": "edges", "of": { "op": "body", "feature": "e1" } })
        )
        .members
        .len(),
        14
    );
    let cap = json!({ "op": "cap", "feature": "e1", "end": "end" });
    assert_eq!(
        run(&s, json!({ "op": "edges", "of": cap })).members.len(),
        5
    );
    let v = json!({ "op": "extreme", "which": "max", "dir": [1, 1, 1],
                    "of": { "op": "vertices", "of": { "op": "body", "feature": "e1" } } });
    assert_eq!(run(&s, json!({ "op": "edges", "of": v })).members.len(), 3);
}

#[test]
fn vertices_navigates_from_bodies_faces_and_edges() {
    let m = plate();
    let s = m.scope();
    assert_eq!(
        run(
            &s,
            json!({ "op": "vertices", "of": { "op": "body", "feature": "e1" } })
        )
        .members
        .len(),
        8
    );
    let cap = json!({ "op": "cap", "feature": "e1", "end": "end" });
    assert_eq!(
        run(&s, json!({ "op": "vertices", "of": cap }))
            .members
            .len(),
        4
    );
    let ring = json!({ "op": "side", "feature": "e1", "curve": "ring" });
    assert_eq!(
        run(&s, json!({ "op": "vertices", "of": ring }))
            .members
            .len(),
        0,
        "ring edges have no vertices"
    );
}

#[test]
fn owner_navigates_to_bodies() {
    let m = plate();
    let s = m.scope();
    let set = run(
        &s,
        json!({ "op": "owner", "of": { "op": "cap", "feature": "e1", "end": "end" } }),
    );
    assert_eq!(keys(&s, &set), ["e1/body:bottom"]);
    assert_eq!(set.members[0].via, Via::Broad);
}

// ---- set algebra -------------------------------------------------------------------------------

#[test]
fn union_intersect_minus_keep_named_ness_per_member() {
    let m = plate();
    let s = m.scope();
    let top = json!({ "op": "cap", "feature": "e1", "end": "end" });
    let sides = json!({ "op": "sides", "feature": "e1" });
    let u = run(&s, json!({ "op": "union", "of": [top, sides] }));
    assert_eq!(u.members.len(), 6);
    let named: Vec<String> = u
        .members
        .iter()
        .filter(|m| m.via == Via::Named)
        .map(|m| s.key(m.entity).to_string())
        .collect();
    assert_eq!(named, ["e1/cap:end@bottom"]);
    let ring = json!({ "op": "side", "feature": "e1", "curve": "ring" });
    let i = run(&s, json!({ "op": "intersect", "of": [sides, ring] }));
    assert_eq!(keys(&s, &i), ["e1/side:ring"]);
    assert_eq!(i.members[0].via, Via::Named, "named in one operand");
    let mi = run(&s, json!({ "op": "minus", "a": sides, "b": ring }));
    assert_eq!(mi.members.len(), 4);
    assert!(!keys(&s, &mi).contains(&"e1/side:ring".to_string()));
}

// ---- filters and picks -----------------------------------------------------------------------------

fn filter(s: &Scope<'_>, of: serde_json::Value, pred: serde_json::Value) -> Vec<String> {
    keys(
        s,
        &run(s, json!({ "op": "filter", "of": of, "where": pred })),
    )
}

fn faces_e1() -> serde_json::Value {
    json!({ "op": "faces", "of": { "op": "body", "feature": "e1" } })
}

fn edges_e1() -> serde_json::Value {
    json!({ "op": "edges", "of": { "op": "body", "feature": "e1" } })
}

#[test]
fn filter_type() {
    let m = plate();
    let s = m.scope();
    assert_eq!(filter(&s, faces_e1(), json!({ "type": "plane" })).len(), 6);
    assert_eq!(
        filter(&s, faces_e1(), json!({ "type": "cylinder" })),
        ["e1/side:ring"]
    );
    assert_eq!(filter(&s, edges_e1(), json!({ "type": "circle" })).len(), 2);
    assert_eq!(filter(&s, edges_e1(), json!({ "type": "line" })).len(), 12);
    assert!(filter(&s, faces_e1(), json!({ "type": "torus" })).is_empty());
}

#[test]
fn filter_normal_is_signed() {
    let m = plate();
    let s = m.scope();
    assert_eq!(
        filter(&s, faces_e1(), json!({ "normal": "+Z" })),
        ["e1/cap:end@bottom"]
    );
    assert_eq!(
        filter(&s, faces_e1(), json!({ "normal": "-Z" })),
        ["e1/cap:start@bottom"]
    );
    // Unsigned names mean +.
    assert_eq!(
        filter(&s, faces_e1(), json!({ "normal": "Y" })),
        ["e1/side:top"]
    );
    assert_eq!(
        filter(&s, faces_e1(), json!({ "normal": [0, -2, 0] })),
        ["e1/side:bottom"]
    );
}

#[test]
fn filter_parallel() {
    let m = plate();
    let s = m.scope();
    assert_eq!(filter(&s, edges_e1(), json!({ "parallel": "Z" })).len(), 4);
    // Faces: planes whose normal is perpendicular, cylinders whose axis is parallel.
    assert_eq!(filter(&s, faces_e1(), json!({ "parallel": "-Z" })).len(), 5);
    assert_eq!(
        filter(&s, edges_e1(), json!({ "parallel": [1, 0, 0] })).len(),
        4
    );
}

#[test]
fn filter_perpendicular() {
    let m = plate();
    let s = m.scope();
    // Lines perpendicular to Z (8) and circles whose normal is parallel to Z (2).
    assert_eq!(
        filter(&s, edges_e1(), json!({ "perpendicular": "Z" })).len(),
        10
    );
    assert_eq!(
        filter(&s, faces_e1(), json!({ "perpendicular": "Z" })).len(),
        2
    );
}

#[test]
fn filter_convex_concave_smooth() {
    let m = plate();
    let s = m.scope();
    assert_eq!(filter(&s, edges_e1(), json!({ "convex": true })).len(), 14);
    assert!(filter(&s, edges_e1(), json!({ "concave": true })).is_empty());
    let l = l_shape();
    let s = l.scope();
    let edges = json!({ "op": "edges", "of": { "op": "body", "feature": "e3" } });
    let concave = filter(&s, edges.clone(), json!({ "concave": true }));
    assert_eq!(concave, ["e3/edge:{e3/side:l3|e3/side:l4}@l3.end"]);
    assert_eq!(filter(&s, edges, json!({ "convex": true })).len(), 17);
    let st = stadium();
    let s = st.scope();
    let edges = json!({ "op": "edges", "of": { "op": "body", "feature": "e4" } });
    let smooth = filter(&s, edges, json!({ "smooth": true }));
    assert_eq!(smooth.len(), 4, "{smooth:?}");
    assert!(smooth.iter().all(|k| k.contains("side:a")), "{smooth:?}");
}

#[test]
fn filter_radius() {
    let m = plate();
    let s = m.scope();
    assert_eq!(
        filter(&s, faces_e1(), json!({ "radius": { "eq": 3 } })),
        ["e1/side:ring"]
    );
    assert_eq!(
        filter(&s, edges_e1(), json!({ "radius": { "min": 2, "max": 3 } })).len(),
        2
    );
    assert!(filter(&s, edges_e1(), json!({ "radius": { "max": 2.5 } })).is_empty());
    assert!(filter(&s, faces_e1(), json!({ "radius": { "eq": 3.1 } })).is_empty());
}

#[test]
fn extreme_keeps_members_within_tolerance_of_the_max() {
    let m = plate();
    let s = m.scope();
    let set = run(
        &s,
        json!({ "op": "extreme", "of": faces_e1(), "dir": "+Z", "which": "max" }),
    );
    assert_eq!(keys(&s, &set), ["e1/cap:end@bottom"]);
    let set = run(
        &s,
        json!({ "op": "extreme", "of": faces_e1(), "dir": "Z", "which": "min" }),
    );
    assert_eq!(keys(&s, &set), ["e1/cap:start@bottom"]);
    let v = json!({ "op": "vertices", "of": { "op": "body", "feature": "e1" } });
    let set = run(
        &s,
        json!({ "op": "extreme", "of": v, "dir": "+X", "which": "max" }),
    );
    assert_eq!(set.members.len(), 4, "a tie keeps all four");
}

#[test]
fn largest_and_smallest_pick_by_exact_size_with_ties() {
    let m = plate();
    let s = m.scope();
    let set = run(&s, json!({ "op": "largest", "of": faces_e1() }));
    assert_eq!(keys(&s, &set), ["e1/cap:end@bottom", "e1/cap:start@bottom"]);
    let set = run(&s, json!({ "op": "smallest", "of": edges_e1() }));
    assert_eq!(set.members.len(), 4, "the vertical edges (5 mm)");
    let set = run(&s, json!({ "op": "largest", "of": edges_e1() }));
    assert_eq!(set.members.len(), 4, "the 40 mm edges");
}

// ---- status gates, rejections, order ------------------------------------------------------

#[test]
fn a_named_source_of_a_failed_feature_is_dependency_failed() {
    let m = plate();
    let mut t = m.table.clone();
    t.get_mut("e1").expect("e1").status = FeatureStatus::Failed {
        code: "INVALID_RESULT".into(),
        message: "boom".into(),
    };
    let s = m.scope_with(t);
    let err = eval_query(
        &q(json!({ "op": "side", "feature": "e1", "curve": "top" })),
        &s,
    )
    .expect_err("failed feature");
    assert_eq!(err.code(), "DEPENDENCY_FAILED");
    assert_eq!(err.details()["code"], "INVALID_RESULT");
    // Every source naming the feature by id is gated (§7.5 "any feature referenced by id"),
    // broad ones too: never an empty set that a card `any` would accept silently.
    for broad in [
        json!({ "op": "sides", "feature": "e1" }),
        json!({ "op": "created", "feature": "e1" }),
        json!({ "op": "edges", "of": { "op": "sides", "feature": "e1", "member": "top" } }),
    ] {
        let err = eval_query(&q(broad.clone()), &s).expect_err("failed feature");
        assert_eq!(err.code(), "DEPENDENCY_FAILED", "{broad}");
    }
    let mut t = m.table.clone();
    t.push(FeatureInfo::new("pt1", "row", "pattern"));
    t.get_mut("pt1").expect("pt1").status = FeatureStatus::Failed {
        code: "INVALID_COUNT".into(),
        message: "n".into(),
    };
    let s = m.scope_with(t);
    let err = eval_query(
        &q(json!({ "op": "instance", "feature": "pt1", "index": [1] })),
        &s,
    )
    .expect_err("failed pattern");
    assert_eq!(err.code(), "DEPENDENCY_FAILED");
}

#[test]
fn a_named_source_of_a_suppressed_feature_yields_nothing() {
    let m = plate();
    let mut t = m.table.clone();
    t.get_mut("e1").expect("e1").status = FeatureStatus::Suppressed;
    let s = ScopeBuilder::new(t).build();
    let set = run(&s, json!({ "op": "side", "feature": "e1", "curve": "top" }));
    assert!(set.members.is_empty());
    assert!(set.suppressed.contains("e1"));
    // Broad sources of it too, with the same reason.
    for broad in [
        json!({ "op": "sides", "feature": "e1" }),
        json!({ "op": "created", "feature": "e1" }),
    ] {
        let set = run(&s, broad);
        assert!(set.members.is_empty());
        assert!(set.suppressed.contains("e1"));
    }
}

/// `sides { feature, member }` selects by the sweep's regions, not by the body's origin: a
/// join gives the result body the target's origin (§6.0.3) while the faces keep their keys.
#[test]
fn sides_with_a_member_follow_the_regions_not_the_body_origin() {
    let m = plate();
    let joined = forge_refs::Origin {
        feature: "e0".into(),
        member: "base".into(),
        instance: None,
    };
    let mut t = FeatureTable::new();
    t.push(FeatureInfo::new("e0", "target", "extrude"));
    for f in m.table.iter() {
        t.push(f.clone());
    }
    let s = ScopeBuilder::new(t).body(&m.bodies[0].0, joined).build();
    let with_member = run(
        &s,
        json!({ "op": "sides", "feature": "e1", "member": "right" }),
    );
    assert_eq!(with_member.members.len(), 5, "outer loop and hole sides");
    let all = run(&s, json!({ "op": "sides", "feature": "e1" }));
    assert_eq!(all.entities(), with_member.entities());
    // Set algebra over them is exact: nothing of region `right` is left.
    let rest = run(
        &s,
        json!({ "op": "minus", "a": { "op": "sides", "feature": "e1" },
                "b": { "op": "sides", "feature": "e1", "member": "right" } }),
    );
    assert!(rest.members.is_empty());
}

/// Two regions of one sketch: each member's sides are its own loop's faces.
#[test]
fn sides_with_a_member_select_one_region_of_several() {
    let m = common::eval(&common::doc(
        &common::squares(&[0.0, 10.0], 4.0),
        &common::e1(2.0),
    ));
    let s = m.scope();
    let a = run(
        &s,
        json!({ "op": "sides", "feature": "e1", "member": "a1" }),
    );
    assert_eq!(a.members.len(), 4);
    let keys_a = keys(&s, &a);
    assert!(
        keys_a.iter().all(|k| k.starts_with("e1/side:a")),
        "{keys_a:?}"
    );
    // The same with the body's origin moved elsewhere (a join): unchanged.
    let mut t = FeatureTable::new();
    t.push(FeatureInfo::new("e0", "target", "extrude"));
    for f in m.table.iter() {
        t.push(f.clone());
    }
    let mut b = ScopeBuilder::new(t);
    for (body, _) in &m.bodies {
        b = b.body(
            body,
            forge_refs::Origin {
                feature: "e0".into(),
                member: "x".into(),
                instance: None,
            },
        );
    }
    let s2 = b.build();
    let a2 = run(
        &s2,
        json!({ "op": "sides", "feature": "e1", "member": "a1" }),
    );
    assert_eq!(keys(&s2, &a2), keys_a);
}

/// A tag feature without a target (a malformed table) is a static rejection, never a panic.
#[test]
fn a_tag_without_a_target_is_rejected_not_a_panic() {
    let m = plate();
    let mut t = m.table.clone();
    t.push(FeatureInfo::new("t1", "empty", "tag"));
    let s = m.scope_with(t);
    let err =
        eval_query(&q(json!({ "op": "tagged", "feature": "t1" })), &s).expect_err("no target");
    assert_eq!(err.code(), "QUERY_INVALID");
}

#[test]
fn ill_typed_queries_are_rejected_before_evaluation() {
    let m = half_cone();
    let s = m.scope();
    let err = eval_query(
        &q(json!({ "op": "cap", "feature": "r1", "end": "end" })),
        &s,
    )
    .expect_err("cap of a revolve");
    assert_eq!(err.code(), "QUERY_INVALID");
    let err = eval_query(
        &q(json!({ "op": "side", "feature": "r1", "curve": "zz" })),
        &s,
    )
    .expect_err("unknown curve");
    assert_eq!(err.code(), "QUERY_UNKNOWN_CURVE");
}

#[test]
fn results_are_in_canonical_key_order() {
    let m = plate();
    let s = m.scope();
    let set = run(&s, faces_e1());
    let k = keys(&s, &set);
    let mut sorted = k.clone();
    sorted.sort();
    assert_eq!(k, sorted);
    // Same query, fresh scope: same order (determinism).
    let s2 = m.scope();
    assert_eq!(keys(&s2, &run(&s2, faces_e1())), k);
    let _: Vec<Entity> = set.entities();
}
