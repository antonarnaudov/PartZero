//! Provenance keys (SPEC-v1 §5.2): feature ids, cap members, junction qualifiers, escaping,
//! display names, and the key invariant (complete, unique within a body).
// Expected values are exact on purpose (closed forms, bit-exact frames).
#![allow(clippy::float_cmp)]

mod common;

use std::collections::BTreeSet;

use common::{d_shape, half_cone, plate};
use forge_ir::v1::EntityKind;
use forge_refs::Scope;

fn keys(scope: &Scope<'_>, kind: EntityKind) -> BTreeSet<String> {
    scope
        .entities(kind)
        .into_iter()
        .map(|e| scope.key(e).to_string())
        .collect()
}

#[test]
fn plate_keys_follow_the_naming_conventions() {
    let m = plate();
    let s = m.scope();
    assert!(s.key_problems().is_empty(), "{:?}", s.key_problems());
    let faces = keys(&s, EntityKind::Face);
    let want: BTreeSet<String> = [
        "e1/cap:start@bottom",
        "e1/cap:end@bottom",
        "e1/side:bottom",
        "e1/side:right",
        "e1/side:top",
        "e1/side:left",
        "e1/side:ring",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    assert_eq!(faces, want);
    let edges = keys(&s, EntityKind::Edge);
    assert!(edges.contains("e1/edge:{e1/cap:end@bottom|e1/side:bottom}"));
    assert!(edges.contains("e1/edge:{e1/cap:start@bottom|e1/side:ring}"));
    // Side–side junction edges carry the smallest curve end of their sketch vertex.
    assert!(edges.contains("e1/edge:{e1/side:bottom|e1/side:right}@bottom.end"));
    assert!(edges.contains("e1/edge:{e1/side:bottom|e1/side:left}@bottom.start"));
    assert!(edges.contains("e1/edge:{e1/side:left|e1/side:top}@left.start"));
    assert!(edges.iter().all(|k| !k.contains('#')));
    let bodies = keys(&s, EntityKind::Body);
    assert_eq!(bodies, BTreeSet::from(["e1/body:bottom".to_string()]));
}

#[test]
fn d_profile_junctions_are_told_apart_by_qualifier_not_index() {
    let m = d_shape();
    let s = m.scope();
    assert!(s.key_problems().is_empty(), "{:?}", s.key_problems());
    let edges = keys(&s, EntityKind::Edge);
    // The two vertical edges between side:bow and side:flat (a v0 `#0`/`#1` family).
    assert!(edges.contains("e2/edge:{e2/side:bow|e2/side:flat}@bow.start"));
    assert!(edges.contains("e2/edge:{e2/side:bow|e2/side:flat}@bow.end"));
    let verts = keys(&s, EntityKind::Vertex);
    assert_eq!(verts.len(), 4, "{verts:?}");
    assert!(
        verts
            .iter()
            .all(|k| k.ends_with("@bow.start") || k.ends_with("@bow.end"))
    );
}

#[test]
fn revolve_end_caps_carry_the_member() {
    let m = half_cone();
    let s = m.scope();
    assert!(s.key_problems().is_empty(), "{:?}", s.key_problems());
    let faces = keys(&s, EntityKind::Face);
    assert!(faces.contains("r1/endcap:start@a"), "{faces:?}");
    assert!(faces.contains("r1/endcap:end@a"), "{faces:?}");
    assert!(faces.contains("r1/side:b"), "{faces:?}");
}

#[test]
fn display_names_use_feature_names_and_drop_unneeded_qualifiers() {
    let m = d_shape();
    let s = m.scope();
    let names: BTreeSet<String> = s
        .entities(EntityKind::Edge)
        .into_iter()
        .map(|e| s.display_name(e))
        .collect();
    // Unique without qualifiers: dropped; the D's two junction edges keep theirs.
    assert!(
        names.contains("dee/edge:{dee/cap:end|dee/side:flat}"),
        "{names:?}"
    );
    assert!(
        names.contains("dee/edge:{dee/side:bow|dee/side:flat}@bow.start"),
        "{names:?}"
    );
    assert!(names.iter().all(|n| !n.contains("e2/")), "{names:?}");
}

/// Caps keep their member `@m` when their body's origin is another feature's (a join, §6.0.3):
/// derived from the sweep's only region; a multi-region sweep joined into another body cannot
/// be derived and is a key problem (forge-ops must stamp the qualifier, W4) — never a key that
/// silently changed.
#[test]
fn caps_of_a_joined_sweep_keep_their_member() {
    let joined = forge_refs::Origin {
        feature: "e0".into(),
        member: "base".into(),
        instance: None,
    };
    let with_target = |m: &common::Model| {
        let mut t = forge_refs::FeatureTable::new();
        t.push(forge_refs::FeatureInfo::new("e0", "target", "extrude"));
        for f in m.table.iter() {
            t.push(f.clone());
        }
        t
    };
    // One region: derived.
    let m = plate();
    let s = forge_refs::ScopeBuilder::new(with_target(&m))
        .body(&m.bodies[0].0, joined.clone())
        .build();
    assert!(s.key_problems().is_empty(), "{:?}", s.key_problems());
    assert!(keys(&s, EntityKind::Face).contains("e1/cap:end@bottom"));
    // Two regions joined into one target: not derivable, reported.
    let two = common::eval(&common::doc(
        &common::squares(&[0.0, 10.0], 4.0),
        &common::e1(2.0),
    ));
    let s = forge_refs::ScopeBuilder::new(with_target(&two))
        .body(&two.bodies[0].0, joined)
        .build();
    let problems = s.key_problems();
    assert!(
        problems
            .iter()
            .any(|p| p.key == "e1/cap:end" && p.problem.contains("member")),
        "{problems:?}"
    );
}

/// The key invariant still catches what is not a split: a "D" whose junctions are unknown
/// (no `@c.end`: each side–side junction edge is reported incomplete, and the two junction
/// edges — on different carriers — and their vertices share keys), and a cap key stamped on
/// both ends (two faces on different planes sharing `e1/cap:end@bottom`).
#[test]
fn the_key_invariant_flags_unqualified_junctions_and_duplicate_caps() {
    // A "D" without junction data.
    let m = d_shape();
    let mut t = m.table.clone();
    for r in &mut t.get_mut("e2").expect("e2").regions {
        r.junctions.clear();
    }
    let s = m.scope_with(t);
    let problems = s.key_problems();
    let junction = "e2/edge:{e2/side:bow|e2/side:flat}";
    assert!(
        problems
            .iter()
            .any(|p| p.key == junction && p.problem.contains("without a junction qualifier")),
        "{problems:?}"
    );
    assert!(
        problems
            .iter()
            .any(|p| p.key == junction && p.problem.contains("2 edges")),
        "{problems:?}"
    );
    assert!(
        problems.iter().any(|p| p.problem.contains("2 vertices")),
        "{problems:?}"
    );
    // A cap stamped on both ends.
    let m = plate();
    let body = common::reprovenance(&m.bodies[0].0, |p| {
        let mut q = common::rename_in(p, "e1/cap:start", "e1/cap:end");
        if q.role == forge_core::topo::Role::CapStart {
            q.role = forge_core::topo::Role::CapEnd;
        }
        q
    });
    let s = forge_refs::ScopeBuilder::new(m.table.clone())
        .body(&body, m.bodies[0].1.clone())
        .build();
    let problems = s.key_problems();
    assert!(
        problems.iter().any(|p| p.key == "e1/cap:end@bottom"
            && p.problem.contains("2 faces")
            && p.problem.contains("different carriers")),
        "{problems:?}"
    );
}

/// Vertices sharing a key: an intersection vertex of a body operation (sources of two or more
/// features, `G/vertex:{…}`, which §5.2 does not qualify: a tool crossing an edge twice gives
/// two of them one key) is no key problem; two vertices of one feature sharing a key are.
#[test]
fn shared_vertex_keys_are_problems_unless_intersection_vertices() {
    let m = plate();
    // The two vertices at (20, −10, z) stamped with the same sources (the cap:start face).
    let both = |other_feature: bool| {
        common::reprovenance(&m.bodies[0].0, |p| {
            let mut q = if other_feature {
                // The right side face belongs to another feature `g1` (a tool's face).
                common::rename_in(p, "e1/side:right", "g1/side:right")
            } else {
                p.clone()
            };
            if other_feature
                && p.role == forge_core::topo::Role::Side
                && p.sources.iter().any(|s| s == "right")
            {
                q.feature = "g1".into();
            }
            if p.role == forge_core::topo::Role::VertexAt
                && p.sources.iter().any(|s| s == "e1/side:bottom")
                && p.sources.iter().any(|s| s == "e1/side:right")
            {
                let right = if other_feature {
                    "g1/side:right"
                } else {
                    "e1/side:right"
                };
                q.sources = ["e1/side:bottom", right, "e1/cap:start"]
                    .into_iter()
                    .map(String::from)
                    .collect();
            }
            q
        })
    };
    for other_feature in [false, true] {
        let body = both(other_feature);
        let s = forge_refs::ScopeBuilder::new(m.table.clone())
            .body(&body, m.bodies[0].1.clone())
            .build();
        let shared: Vec<String> = s
            .entities(EntityKind::Vertex)
            .into_iter()
            .map(|e| s.key(e).to_string())
            .filter(|k| k.contains("side:right") && k.contains("side:bottom"))
            .collect();
        assert_eq!(shared.len(), 2, "{shared:?}");
        assert_eq!(shared[0], shared[1], "the two vertices share the key");
        let problems = s.key_problems();
        let flagged = problems
            .iter()
            .any(|p| p.key == shared[0] && p.problem.contains("2 vertices"));
        assert_eq!(flagged, !other_feature, "{other_feature}: {problems:?}");
    }
}
