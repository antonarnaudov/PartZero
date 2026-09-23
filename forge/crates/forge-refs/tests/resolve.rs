//! Reference resolution (SPEC-v1 §5.7): one test per row of the step-3 and step-4 tables and
//! per step-5 outcome, with the report entry (§5.8), warnings and error details checked
//! against the catalogue (`forge_ir::v1::codes`).
// Expected values are exact on purpose (closed forms, bit-exact frames).
#![allow(clippy::float_cmp)]

mod common;

use common::{
    Model, OUTLINE, OUTLINE_ZB, RING, dee, doc, e1, eval, plate, r, rename_in, reprovenance,
    share_junctions,
};
use forge_core::topo::Role;
use forge_ir::v1::metrics::{CandidateReason, MemberStatus, RefStatus, Severity, UnresolvedReason};
use forge_ir::v1::{AUTO_ACCEPT_CONFIDENCE, IDENTICAL_MATCH_CONFIDENCE, Ref, codes};
use forge_refs::{
    FeatureStatus, FieldSpec, Resolution, Scope, ScopeBuilder, capture, eval_query, resolve,
    resolve_with,
};
use serde_json::{Value, json};

/// Resolve `r` in `scope` (fresh, no capture), assert it is exact, and return `r` with the
/// capture the command layer would write.
fn captured(r: &Ref, scope: &Scope<'_>) -> Ref {
    let res = resolve(r, scope);
    assert_eq!(res.status, RefStatus::Exact, "{:?}", res.error);
    let mut out = r.clone();
    out.capture = Some(capture(&res.members, scope).expect("capture"));
    out
}

/// Every error and warning carries exactly the catalogue's detail keys; no candidate other
/// than a used geometry-identical repair reaches the auto-accept confidence.
fn check_contract(res: &Resolution) {
    let keys = |code: &str, d: &serde_json::Map<String, Value>| {
        let info = codes::info(code).unwrap_or_else(|| panic!("{code} not in the catalogue"));
        let mut want: Vec<&str> = info.details.to_vec();
        want.sort();
        let mut got: Vec<&str> = d.keys().map(String::as_str).collect();
        got.sort();
        assert_eq!(got, want, "{code} details");
    };
    if let Some(e) = &res.error {
        keys(&e.code, &e.details);
        assert_eq!(res.report.code.as_deref(), Some(e.code.as_str()));
        assert!(res.members.is_empty(), "a failed reference uses nothing");
        assert!(!e.message.contains("  "), "{:?}", e.message);
    }
    for w in &res.warnings {
        keys(&w.code, &w.details);
        assert!(!w.message.contains("  "), "{:?}", w.message);
        // A repair never maps a key onto an entity that still carries it.
        if w.code == "REF_REPAIRED" {
            assert_ne!(w.details["key"], w.details["into"], "{w:?}");
        }
    }
    for u in &res.report.unresolved {
        assert!(u.candidates.len() <= 6);
        for c in &u.candidates {
            assert!(
                c.confidence < AUTO_ACCEPT_CONFIDENCE || c.reason == CandidateReason::Identical,
                "{c:?}"
            );
        }
    }
}

fn run(r: &Ref, scope: &Scope<'_>) -> Resolution {
    let res = resolve(r, scope);
    check_contract(&res);
    res
}

fn side(c: &str) -> Ref {
    r(json!({ "kind": "face", "q": { "op": "side", "feature": "e1", "curve": c } }))
}

fn cap_end() -> Ref {
    r(json!({ "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } }))
}

// ---- step 1–2 ----------------------------------------------------------------------------

#[test]
fn without_a_capture_the_query_result_is_used_exactly() {
    let m = plate();
    let s = m.scope();
    let res = run(&side("ring"), &s);
    assert_eq!(res.status, RefStatus::Exact);
    assert_eq!(res.members.len(), 1);
    assert_eq!(res.report.members[0].key, "e1/side:ring");
    assert_eq!(res.report.members[0].name, "slab/side:ring");
    assert!(res.warnings.is_empty());
    let p = &res.report.members[0].probe;
    assert!(p.normal.is_some());
}

#[test]
fn a_failed_dependency_fails_the_reference() {
    let m = plate();
    let mut t = m.table.clone();
    t.get_mut("e1").expect("e1").status = FeatureStatus::Failed {
        code: "INVALID_DISTANCE".into(),
        message: "d".into(),
    };
    let s = m.scope_with(t);
    let res = run(&side("ring"), &s);
    assert_eq!(res.code(), Some("DEPENDENCY_FAILED"));
    assert_eq!(res.status, RefStatus::Failed);
}

// ---- step 3 ---------------------------------------------------------------------------------

#[test]
fn step3_same_key_type_and_neighbours_is_exact() {
    let m = plate();
    let s = m.scope();
    let rc = captured(&side("bottom"), &s);
    let res = run(&rc, &s);
    assert_eq!(res.status, RefStatus::Exact);
    assert_eq!(res.report.members[0].status, MemberStatus::Exact);
    // A dimension edit keeps the key: still exact.
    let m2 = eval(&doc(&format!("{OUTLINE}{RING}"), &e1(9.0)));
    let res = run(&rc, &m2.scope());
    assert_eq!(res.status, RefStatus::Exact);
}

#[test]
fn step3_found_through_an_alias_is_merged() {
    let m = plate();
    let rc = captured(&side("right"), &m.scope());
    // As if a same-domain merge had renamed the face: its old key is an alias of the new one.
    let body = reprovenance(&m.bodies[0].0, |p| {
        let mut q = rename_in(p, "e1/side:right", "e1/side:rightm");
        if q.role == Role::Side && q.sources.iter().any(|x| x == "right") {
            q.sources = ["rightm".to_string()].into_iter().collect();
        }
        q
    });
    let s = ScopeBuilder::new(m.table.clone())
        .body(&body, m.bodies[0].1.clone())
        .alias("e1/side:right", "e1/side:rightm")
        .build();
    let res = run(&rc, &s);
    assert_eq!(res.status, RefStatus::Accepted);
    assert_eq!(res.report.members[0].status, MemberStatus::Merged);
    assert_eq!(res.report.members[0].key, "e1/side:rightm");
    assert_eq!(res.warnings[0].code, "REF_MERGED");
    assert_eq!(res.warnings[0].severity, Severity::Info);
}

#[test]
fn step3_fewer_same_carrier_neighbours_is_a_neighbourhood_change() {
    // Captured while `bottom` had a collinear neighbour.
    let split = r#"
        { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [0, -10] },
        { "kind": "line", "id": "bottom2", "start": [0, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let a = eval(&doc(split, &e1(5.0)));
    let rc = captured(&side("bottom"), &a.scope());
    assert_eq!(
        rc.capture.as_ref().expect("cap").members[0].geom.neighbors,
        1
    );
    let b = eval(&doc(OUTLINE, &e1(5.0)));
    let res = run(&rc, &b.scope());
    assert_eq!(res.status, RefStatus::Accepted);
    assert_eq!(
        res.report.members[0].status,
        MemberStatus::NeighborhoodChanged
    );
    assert_eq!(res.warnings[0].code, "REF_NEIGHBORHOOD_CHANGED");
    assert_eq!(res.warnings[0].severity, Severity::Warning);
}

#[test]
fn step3_a_type_change_is_used_with_a_warning_and_fails_a_plane_field() {
    let a = plate();
    let rc = captured(&side("right"), &a.scope());
    let bulged = r#"
        { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [20, -10] },
        { "kind": "arc", "id": "right", "start": [20, -10], "end": [20, 10], "center": [15, 0], "ccw": true },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let b = eval(&doc(bulged, &e1(5.0)));
    let s = b.scope();
    let res = run(&rc, &s);
    assert_eq!(res.status, RefStatus::Accepted);
    assert_eq!(res.report.members[0].status, MemberStatus::KindChanged);
    let w = &res.warnings[0];
    assert_eq!(w.code, "REF_KIND_CHANGED");
    assert_eq!(w.details["was"], "plane");
    assert_eq!(w.details["now"], "cylinder");
    // A face-frame field needs a plane: PLANE_NOT_PLANAR (naming recommendation 4).
    let plane: forge_ir::v1::PlaneRef =
        serde_json::from_value(json!({ "face": serde_json::to_value(&rc).expect("ref") }))
            .expect("plane ref");
    let ev = forge_refs::plane_frame(&plane, &s, "/plane");
    assert_eq!(
        ev.result.expect_err("not planar").code(),
        "PLANE_NOT_PLANAR"
    );
    assert_eq!(ev.refs.len(), 1);
    assert_eq!(ev.refs[0].report.field, "/plane/face");
}

/// Pieces of a split share the key (§5.2 rule 3; simulated as W4 would stamp them).
fn shared_key_split() -> Model {
    let split = r#"
        { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [0, -10] },
        { "kind": "line", "id": "bottom2", "start": [0, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let mut m = eval(&doc(split, &e1(5.0)));
    let body = reprovenance(&m.bodies[0].0, |p| {
        let mut q = rename_in(p, "e1/side:bottom2", "e1/side:bottom");
        if q.role == Role::Side && q.sources.iter().any(|x| x == "bottom2") {
            q.sources = ["bottom".to_string()].into_iter().collect();
        }
        q
    });
    m.bodies[0].0 = body;
    share_junctions(&mut m.table, "e1", "bottom2", "bottom");
    m
}

#[test]
fn step3_a_split_with_card_one_fails_with_the_pieces_as_candidates() {
    let rc = captured(&side("bottom"), &plate().scope());
    let b = shared_key_split();
    let s = b.scope();
    let res = run(&rc, &s);
    assert_eq!(res.code(), Some("REF_SPLIT"));
    let u = &res.report.unresolved[0];
    assert_eq!(u.key, "e1/side:bottom");
    assert_eq!(u.reason, UnresolvedReason::Split);
    assert_eq!(u.candidates.len(), 2);
    assert!(
        u.candidates
            .iter()
            .all(|c| c.reason == CandidateReason::SplitPiece)
    );
    // Display indices tell the pieces apart; the synthesized queries select each one.
    assert!(u.candidates[0].name.ends_with("#0") || u.candidates[0].name.ends_with("#1"));
    for c in &u.candidates {
        let q = c.query.as_ref().expect("a query selecting the candidate");
        let set = eval_query(q, &s).expect("evaluates");
        assert_eq!(set.members.len(), 1);
        assert_eq!(s.probe(set.members[0].entity).expect("probe"), c.probe);
    }
}

#[test]
fn step3_a_split_with_card_some_takes_every_piece() {
    let mut rc = captured(&side("bottom"), &plate().scope());
    rc.card = Some(forge_ir::v1::Cardinality::SOME);
    let b = shared_key_split();
    let res = run(&rc, &b.scope());
    assert_eq!(res.status, RefStatus::Accepted);
    assert_eq!(res.members.len(), 2);
    assert!(res.members.iter().all(|m| m.status == MemberStatus::Split));
    assert_eq!(res.warnings[0].code, "REF_SPLIT_ACCEPTED");
    let pieces = res.warnings[0].details["pieces"]
        .as_array()
        .expect("pieces");
    assert_eq!(pieces.len(), 2);
    // §5.4: the pieces are listed in canonical order, like the reference's members.
    let names: Vec<&str> = pieces.iter().filter_map(|p| p["name"].as_str()).collect();
    let members: Vec<&str> = res.report.members.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(names, members);
    assert!(
        names[0].ends_with("#0") && names[1].ends_with("#1"),
        "{names:?}"
    );
}

#[test]
fn step3_one_hit_with_more_neighbours_is_a_split() {
    let rc = captured(&side("bottom"), &plate().scope());
    let split = r#"
        { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [0, -10] },
        { "kind": "line", "id": "bottom2", "start": [0, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let b = eval(&doc(split, &e1(5.0)));
    let res = run(&rc, &b.scope());
    assert_eq!(res.code(), Some("REF_SPLIT"));
    let c = &res.report.unresolved[0].candidates;
    assert_eq!(c.len(), 2);
    assert_eq!(c[0].key, "e1/side:bottom", "the name-anchored piece first");
    assert_eq!(c[1].key, "e1/side:bottom2");
}

// ---- step 4 ----------------------------------------------------------------------------------

#[test]
fn step4_a_unique_geometry_identical_candidate_is_repaired_and_used() {
    let rc = captured(&cap_end(), &plate().scope());
    // `bottom` renamed: the body member (and so the cap key) becomes `left`.
    let b = eval(&doc(&format!("{OUTLINE_ZB}{RING}"), &e1(5.0)));
    let s = b.scope();
    let res = run(&rc, &s);
    assert_eq!(res.status, RefStatus::Accepted);
    assert_eq!(res.members.len(), 1);
    assert_eq!(res.report.members[0].status, MemberStatus::Repaired);
    assert_eq!(res.report.members[0].key, "e1/cap:end@left");
    let w = &res.warnings[0];
    assert_eq!(w.code, "REF_REPAIRED");
    assert!(w.message.contains(&IDENTICAL_MATCH_CONFIDENCE.to_string()));
    let p = res.report.proposal.as_ref().expect("proposal");
    let fresh = resolve(p, &s);
    assert_eq!(
        fresh.status,
        RefStatus::Exact,
        "the proposal resolves exactly"
    );
    assert_eq!(fresh.entities(), res.entities());
}

#[test]
fn step4_several_geometry_identical_candidates_are_ambiguous() {
    let rc = captured(&cap_end(), &plate().scope());
    // Two coincident bodies of the feature (as two pieces would be), both re-keyed.
    let b = eval(&doc(&format!("{OUTLINE_ZB}{RING}"), &e1(5.0)));
    let (body, origin) = &b.bodies[0];
    let twin = forge_refs::Origin {
        member: "right".into(),
        ..origin.clone()
    };
    let s = ScopeBuilder::new(b.table.clone())
        .body(body, origin.clone())
        .body(body, twin)
        .build();
    let res = run(&rc, &s);
    assert_eq!(res.code(), Some("REF_AMBIGUOUS"));
    let u = &res.report.unresolved[0];
    assert_eq!(u.reason, UnresolvedReason::Tie);
    assert_eq!(u.candidates.len(), 2);
    assert!(
        u.candidates
            .iter()
            .all(|c| c.reason == CandidateReason::Identical)
    );
}

/// §5.7 step 4 row 2: an own-feature geometry-identical entity never wins over a coincident
/// one of another feature — both are geometry-identical, so the reference is `REF_AMBIGUOUS`
/// (own entity first) and nothing is used. And the fallback never uses another feature's
/// entity: coincident geometry of another feature is a different entity (a tray's walls sit
/// on its suppressed floor).
#[test]
fn step4_an_own_and_a_foreign_identical_entity_are_ambiguous() {
    let rc = captured(&cap_end(), &plate().scope());
    let twin = format!(
        "{}, {}",
        e1(5.0),
        r#"{ "type": "extrude", "id": "e5", "name": "twin", "sketch": "base", "distance": 5 }"#
    );
    let b = eval(&doc(&format!("{OUTLINE_ZB}{RING}"), &twin));
    let res = run(&rc, &b.scope());
    assert_eq!(res.code(), Some("REF_AMBIGUOUS"), "{:?}", res.members);
    assert!(res.members.is_empty());
    assert!(res.warnings.iter().all(|w| w.code != "REF_REPAIRED"));
    let u = &res.report.unresolved[0];
    assert_eq!(u.reason, UnresolvedReason::Tie);
    let keys: Vec<&str> = u.candidates.iter().map(|c| c.key.as_str()).collect();
    assert_eq!(
        keys,
        ["e1/cap:end@left", "e5/cap:end@left"],
        "own entity first"
    );
    assert!(
        u.candidates
            .iter()
            .all(|c| c.reason == CandidateReason::Identical && c.confidence == 0.0)
    );
    // Without the twin, e1's own identical cap is repaired and used.
    let only_e1 = ScopeBuilder::new(b.table.clone())
        .body(&b.bodies[0].0, b.bodies[0].1.clone())
        .build();
    let res = run(&rc, &only_e1);
    assert_eq!(res.status, RefStatus::Accepted);
    assert_eq!(res.report.members[0].key, "e1/cap:end@left");
    assert_eq!(res.report.members[0].status, MemberStatus::Repaired);
    let mut t = b.table.clone();
    t.get_mut("e1").expect("e1").status = FeatureStatus::Suppressed;
    let only_twin = ScopeBuilder::new(t)
        .body(&b.bodies[1].0, b.bodies[1].1.clone())
        .build();
    let res = run(&rc, &only_twin);
    assert_eq!(res.code(), Some("REF_MISSING"), "not e5's identical cap");
    assert_eq!(
        res.report.unresolved[0].reason,
        UnresolvedReason::FeatureSuppressed
    );
}

/// A query naming a curve the sketch no longer has is rejected statically
/// (`QUERY_UNKNOWN_CURVE`), and the capture still yields repair candidates.
#[test]
fn a_rejected_query_still_lists_candidates_from_its_capture() {
    let a = plate();
    let rc = captured(&side("bottom"), &a.scope());
    let split = r#"
        { "kind": "line", "id": "b_a", "start": [-20, -10], "end": [0, -10] },
        { "kind": "line", "id": "b_b", "start": [0, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let b = eval(&doc(split, &e1(5.0)));
    let res = run(&rc, &b.scope());
    assert_eq!(res.code(), Some("QUERY_UNKNOWN_CURVE"));
    let u = &res.report.unresolved[0];
    assert_eq!(u.reason, UnresolvedReason::Split);
    assert_eq!(u.candidates.len(), 2);
    // A renamed hole: the identical face is the candidate (not used).
    let rc = captured(&side("ring"), &a.scope());
    let ring2 = r#", { "kind": "circle", "id": "ring2", "center": [10, 0], "radius": 3 }"#;
    let b = eval(&doc(&format!("{OUTLINE}{ring2}"), &e1(5.0)));
    let res = run(&rc, &b.scope());
    assert_eq!(res.code(), Some("QUERY_UNKNOWN_CURVE"));
    assert!(res.members.is_empty());
    let c = &res.report.unresolved[0].candidates[0];
    assert_eq!(
        (c.key.as_str(), c.reason),
        ("e1/side:ring2", CandidateReason::Identical)
    );
    assert_eq!(c.confidence, IDENTICAL_MATCH_CONFIDENCE);
}

#[test]
fn step4_an_edge_whose_faces_no_longer_meet_is_missing() {
    let e = r(json!({ "kind": "edge", "q": { "op": "between",
        "a": { "op": "side", "feature": "e1", "curve": "bottom" },
        "b": { "op": "side", "feature": "e1", "curve": "right" } } }));
    let rc = captured(&e, &plate().scope());
    assert!(
        rc.capture.as_ref().expect("capture").members[0]
            .faces
            .is_some()
    );
    let rounded = r#"
        { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [18, -10] },
        { "kind": "arc", "id": "c_br", "start": [18, -10], "end": [20, -8], "center": [18, -8], "ccw": true },
        { "kind": "line", "id": "right", "start": [20, -8], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let b = eval(&doc(rounded, &e1(5.0)));
    let res = run(&rc, &b.scope());
    assert_eq!(res.code(), Some("REF_MISSING"));
    assert_eq!(
        res.report.unresolved[0].reason,
        UnresolvedReason::FacesNoLongerMeet
    );
}

#[test]
fn step4_several_pieces_on_the_captured_carrier_are_a_split() {
    let rc = captured(&cap_end(), &plate().scope());
    // The plate cut in two (a 1 mm gap): two bodies, two caps with new member keys.
    let halves = r#"
        { "kind": "line", "id": "b1", "start": [-20, -10], "end": [-0.5, -10] },
        { "kind": "line", "id": "m1", "start": [-0.5, -10], "end": [-0.5, 10] },
        { "kind": "line", "id": "t1", "start": [-0.5, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] },
        { "kind": "line", "id": "b2", "start": [0.5, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "t2", "start": [20, 10], "end": [0.5, 10] },
        { "kind": "line", "id": "m2", "start": [0.5, 10], "end": [0.5, -10] }"#;
    let b = eval(&doc(halves, &e1(5.0)));
    assert_eq!(b.bodies.len(), 2);
    let res = run(&rc, &b.scope());
    assert_eq!(res.code(), Some("REF_SPLIT"));
    let u = &res.report.unresolved[0];
    assert_eq!(u.reason, UnresolvedReason::Split);
    assert_eq!(u.candidates.len(), 2);
    assert!(
        u.candidates
            .iter()
            .all(|c| c.reason == CandidateReason::SplitPiece)
    );
}

#[test]
fn step4_one_piece_on_the_captured_carrier_is_uncertain_at_0_7() {
    let rc = captured(&cap_end(), &plate().scope());
    let shorter = r#"
        { "kind": "line", "id": "zbottom", "start": [-20, -10], "end": [10, -10] },
        { "kind": "line", "id": "right", "start": [10, -10], "end": [10, 10] },
        { "kind": "line", "id": "top", "start": [10, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let b = eval(&doc(shorter, &e1(5.0)));
    let res = run(&rc, &b.scope());
    assert_eq!(res.code(), Some("REF_UNCERTAIN"));
    let u = &res.report.unresolved[0];
    assert_eq!(u.reason, UnresolvedReason::NameNotFound);
    assert_eq!(u.candidates[0].confidence, 0.7);
    assert_eq!(u.candidates[0].reason, CandidateReason::SplitPiece);
    assert_eq!(u.candidates[0].key, "e1/cap:end@left");
}

#[test]
fn step4_a_unique_plausible_candidate_is_uncertain_below_0_9() {
    let rc = captured(&cap_end(), &plate().scope());
    let b = eval(&doc(&format!("{OUTLINE_ZB}{RING}"), &e1(5.5)));
    let res = run(&rc, &b.scope());
    assert_eq!(res.code(), Some("REF_UNCERTAIN"));
    let c = &res.report.unresolved[0].candidates[0];
    assert_eq!(c.reason, CandidateReason::Plausible);
    assert!(
        c.confidence >= forge_ir::v1::MIN_PLAUSIBLE && c.confidence <= 0.9,
        "{c:?}"
    );
    assert_eq!(c.key, "e1/cap:end@left");
}

#[test]
fn step4_a_tie_is_ambiguous() {
    let rc = captured(&cap_end(), &plate().scope());
    // Two bodies of the feature, one 0.5 mm taller and one 0.5 mm lower than captured.
    let hi = eval(&doc(&format!("{OUTLINE_ZB}{RING}"), &e1(5.5)));
    let lo = eval(&doc(&format!("{OUTLINE_ZB}{RING}"), &e1(4.5)));
    let lo_origin = forge_refs::Origin {
        member: "right".into(),
        ..lo.bodies[0].1.clone()
    };
    let s = ScopeBuilder::new(hi.table.clone())
        .body(&hi.bodies[0].0, hi.bodies[0].1.clone())
        .body(&lo.bodies[0].0, lo_origin)
        .build();
    let res = run(&rc, &s);
    assert_eq!(res.code(), Some("REF_AMBIGUOUS"));
    let u = &res.report.unresolved[0];
    assert_eq!(u.reason, UnresolvedReason::Tie);
    assert_eq!(u.candidates.len(), 2);
}

#[test]
fn step4_nothing_plausible_is_missing() {
    let rc = captured(&cap_end(), &plate().scope());
    let b = eval(&doc(&format!("{OUTLINE_ZB}{RING}"), &e1(50.0)));
    let res = run(&rc, &b.scope());
    assert_eq!(res.code(), Some("REF_MISSING"));
    assert_eq!(
        res.report.unresolved[0].reason,
        UnresolvedReason::NoPlausibleMatch
    );
}

#[test]
fn step4_a_suppressed_feature_is_missing_with_its_reason() {
    let a = plate();
    let rc = captured(&side("ring"), &a.scope());
    let mut t = a.table.clone();
    t.get_mut("e1").expect("e1").status = FeatureStatus::Suppressed;
    let s = ScopeBuilder::new(t).build();
    let res = run(&rc, &s);
    assert_eq!(res.code(), Some("REF_MISSING"));
    assert_eq!(
        res.report.unresolved[0].reason,
        UnresolvedReason::FeatureSuppressed
    );
    assert_eq!(res.report.unresolved[0].name, "slab/side:ring");
}

// ---- step 5 ----------------------------------------------------------------------------------

#[test]
fn step5_a_changed_broad_set_is_used_with_a_warning_and_proposal() {
    let sides =
        r(json!({ "kind": "face", "card": "some", "q": { "op": "sides", "feature": "e1" } }));
    let rc = captured(&sides, &plate().scope());
    let ring2 = r#", { "kind": "circle", "id": "ring2", "center": [-10, 0], "radius": 2 }"#;
    let b = eval(&doc(&format!("{OUTLINE}{RING}{ring2}"), &e1(5.0)));
    let s = b.scope();
    let res = run(&rc, &s);
    assert_eq!(res.status, RefStatus::Accepted);
    assert_eq!(res.members.len(), 6, "the query's current result is used");
    assert_eq!(res.report.added, ["e1/side:ring2"]);
    assert!(res.report.removed.is_empty());
    assert_eq!(res.warnings[0].code, "REF_SET_CHANGED");
    let p = res.report.proposal.as_ref().expect("proposal");
    assert_eq!(p.q, sides.q, "the query is the intent");
    assert_eq!(resolve(p, &s).status, RefStatus::Exact);
}

#[test]
fn step5_cardinality_violations() {
    let m = plate();
    let s = m.scope();
    let planes = |card: Value| {
        r(
            json!({ "kind": "face", "card": card, "q": { "op": "filter", "where": { "type": "plane" },
            "of": { "op": "faces", "of": { "op": "body", "feature": "e1" } } } }),
        )
    };
    let none = |card: Value| {
        r(
            json!({ "kind": "face", "card": card, "q": { "op": "filter", "where": { "radius": { "eq": 7 } },
            "of": { "op": "faces", "of": { "op": "body", "feature": "e1" } } } }),
        )
    };
    assert_eq!(run(&none(json!("one")), &s).code(), Some("REF_MISSING"));
    assert_eq!(run(&none(json!("some")), &s).code(), Some("REF_MISSING"));
    assert_eq!(run(&none(json!("any")), &s).status, RefStatus::Exact);
    let amb = run(&planes(json!("one")), &s);
    assert_eq!(amb.code(), Some("REF_AMBIGUOUS"));
    let u = &amb.report.unresolved[0];
    assert_eq!(u.candidates.len(), 6);
    for c in &u.candidates {
        let q = c.query.as_ref().expect("synthesized query");
        let set = eval_query(q, &s).expect("evaluates");
        assert_eq!(set.members.len(), 1, "{q:?}");
        assert_eq!(s.key(set.members[0].entity), c.key);
    }
    let n = run(&planes(json!(3)), &s);
    assert_eq!(n.code(), Some("REF_CARDINALITY"));
    let e = n.error.as_ref().expect("error");
    assert_eq!(e.details["expected"], 3);
    assert_eq!(e.details["found"], 6);
    assert_eq!(run(&planes(json!(6)), &s).status, RefStatus::Exact);
}

#[test]
fn the_field_default_cardinality_applies_when_card_is_omitted() {
    let m = plate();
    let s = m.scope();
    let planes = r(
        json!({ "kind": "face", "q": { "op": "filter", "where": { "type": "plane" },
        "of": { "op": "faces", "of": { "op": "body", "feature": "e1" } } } }),
    );
    assert_eq!(resolve(&planes, &s).code(), Some("REF_AMBIGUOUS"));
    let some = resolve_with(
        &planes,
        &s,
        &FieldSpec {
            field: "/faces".into(),
            card: forge_ir::v1::Cardinality::SOME,
        },
    );
    assert_eq!(some.status, RefStatus::Exact);
    assert_eq!(some.report.field, "/faces");
}

/// A reversed curve swaps the junction qualifiers of a "D": the captured key now designates
/// the other junction edge. The capture's geometry is identical to that sibling, so the
/// reference fails loudly instead of rebinding (the SPEC's step 3 alone would say exact).
/// Only junction qualifiers get this check (see the `stay_exact` tests below).
#[test]
fn step3_a_qualifier_swap_within_a_junction_family_is_ambiguous() {
    let d = |bow: &str| {
        eval(&format!(
            r#"{{ "schema": "aicad.ir/0", "parts": [{{ "id": "p1", "name": "part", "features": [
  {{ "type": "sketch", "id": "s2", "name": "dsk", "plane": "XY", "curves": [
    {{ "kind": "line", "id": "flat", "start": [3, -4], "end": [3, 4] }}, {bow} ] }},
  {{ "type": "extrude", "id": "e2", "name": "dee", "sketch": "dsk", "distance": 4 }} ] }}] }}"#
        ))
    };
    let a = d(
        r#"{ "kind": "arc", "id": "bow", "start": [3, 4], "end": [3, -4], "center": [0, 0], "ccw": true }"#,
    );
    let e = r(
        json!({ "kind": "edge", "q": { "op": "edge_at", "feature": "e2", "curve": "bow", "end": "end" } }),
    );
    let rc = captured(&e, &a.scope());
    let p0 = resolve(&rc, &a.scope()).report.members[0].probe.point;
    assert_eq!((p0[0], p0[1]), (3.0, -4.0));
    // Same geometry, the arc reversed.
    let b = d(
        r#"{ "kind": "arc", "id": "bow", "start": [3, -4], "end": [3, 4], "center": [0, 0], "ccw": false }"#,
    );
    let res = run(&rc, &b.scope());
    assert_eq!(res.code(), Some("REF_AMBIGUOUS"));
    let c = &res.report.unresolved[0].candidates;
    assert_eq!(c.len(), 2);
    // The edge at the captured place (geometry-identical) first, then the one the captured
    // key now designates.
    assert_eq!(c[0].reason, CandidateReason::Identical);
    assert_eq!((c[0].probe.point[0], c[0].probe.point[1]), (3.0, -4.0));
    assert_eq!(
        c[1].key,
        rc.capture.as_ref().expect("capture").members[0].key,
        "then the name-anchored edge"
    );
}

/// The "D" moved by exactly the gap between its two junctions: the sibling junction edge
/// lands on the captured place, but the body moved, so this is no reversal and the captured
/// key's edge is exact (§5.7 step 3).
#[test]
fn step3_a_d_moved_by_its_junction_gap_stays_exact() {
    let d = |dy: f64| {
        eval(&format!(
            r#"{{ "schema": "aicad.ir/0", "parts": [{{ "id": "p1", "name": "part", "features": [
  {{ "type": "sketch", "id": "s2", "name": "dsk", "plane": "XY", "curves": [
    {{ "kind": "line", "id": "flat", "start": [3, {a}], "end": [3, {b}] }},
    {{ "kind": "arc", "id": "bow", "start": [3, {b}], "end": [3, {a}], "center": [0, {dy}], "ccw": true }} ] }},
  {{ "type": "extrude", "id": "e2", "name": "dee", "sketch": "dsk", "distance": 4 }} ] }}] }}"#,
            a = dy - 4.0,
            b = dy + 4.0,
        ))
    };
    let e = r(
        json!({ "kind": "edge", "q": { "op": "edge_at", "feature": "e2", "curve": "bow", "end": "end" } }),
    );
    let a = d(0.0);
    let rc = captured(&e, &a.scope());
    let b = d(-8.0);
    let sb = b.scope();
    let res = run(&rc, &sb);
    assert_eq!(res.status, RefStatus::Exact, "{:?}", res.error);
    let p = res.report.members[0].probe.point;
    assert_eq!((p[0], p[1]), (3.0, -12.0), "bow's end moved with the loop");
}

/// `renameCurve` (§5.9): queries and capture keys are rewritten, members and junction
/// qualifiers recomputed, so every reference resolves exactly after the rename.
#[test]
fn rename_curve_keeps_references_exact() {
    let a = plate();
    let sa = a.scope();
    let refs = [
        cap_end(),
        side("bottom"),
        r(
            json!({ "kind": "edge", "q": { "op": "edge_at", "feature": "e1", "curve": "right", "end": "start" } }),
        ),
        r(json!({ "kind": "vertex", "q": { "op": "vertices", "of":
            { "op": "edge_at", "feature": "e1", "curve": "bottom", "end": "start" } }, "card": 2 })),
        r(json!({ "kind": "body", "q": { "op": "body", "feature": "e1", "member": "bottom" } })),
    ];
    let captured: Vec<Ref> = refs.iter().map(|x| captured(x, &sa)).collect();
    let b = eval(&doc(&format!("{OUTLINE_ZB}{RING}"), &e1(5.0)));
    let sb = b.scope();
    let rn = forge_refs::CurveRename::new(&a.table, ["e1".to_string()], "bottom", "zbottom");
    for (before, rf) in refs.iter().zip(&captured) {
        let renamed = rn.apply(rf);
        let res = run(&renamed, &sb);
        assert_eq!(
            res.status,
            RefStatus::Exact,
            "{:?}: {:?}",
            before.q,
            res.error
        );
        let a_res = resolve(rf, &sa);
        let key_a: Vec<String> = a_res.members.iter().map(|m| rn.key(&m.key)).collect();
        let key_b: Vec<String> = res.members.iter().map(|m| m.key.clone()).collect();
        assert_eq!(key_a, key_b, "the rewritten keys are the new keys");
    }
    // The junction qualifier moved from `bottom.end` to `right.start`.
    assert_eq!(
        rn.key("e1/edge:{e1/side:bottom|e1/side:right}@bottom.end"),
        "e1/edge:{e1/side:right|e1/side:zbottom}@right.start"
    );
    assert_eq!(rn.key("e1/cap:end@bottom"), "e1/cap:end@left");
    assert_eq!(rn.key("e1/body:bottom"), "e1/body:left");
}

#[test]
fn reports_are_deterministic() {
    let rc = captured(&cap_end(), &plate().scope());
    let json_of = || {
        let b = eval(&doc(&format!("{OUTLINE_ZB}{RING}"), &e1(5.5)));
        let res = resolve(&rc, &b.scope());
        serde_json::to_string(&res.report).expect("json")
    };
    assert_eq!(json_of(), json_of());
}

// ---- split pieces: integer cards, re-captures ----------------------------------------------

/// The plate with `bottom` cut into three collinear pieces that share its key (§5.2 rule 3).
fn three_piece_split(d: f64) -> Model {
    let split = r#"
        { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [-5, -10] },
        { "kind": "line", "id": "bottom2", "start": [-5, -10], "end": [5, -10] },
        { "kind": "line", "id": "bottom3", "start": [5, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let mut m = eval(&doc(split, &e1(d)));
    let body = reprovenance(&m.bodies[0].0, |p| {
        let mut q = rename_in(p, "e1/side:bottom2", "e1/side:bottom");
        q = rename_in(&q, "e1/side:bottom3", "e1/side:bottom");
        if q.role == Role::Side && q.sources.iter().any(|x| x == "bottom2" || x == "bottom3") {
            q.sources = ["bottom".to_string()].into_iter().collect();
        }
        q
    });
    m.bodies[0].0 = body;
    share_junctions(&mut m.table, "e1", "bottom2", "bottom");
    share_junctions(&mut m.table, "e1", "bottom3", "bottom");
    m
}

/// `union(side(e1, bottom), side(e1, top))`, `card: some`.
fn bottom_and_top() -> Ref {
    r(
        json!({ "kind": "face", "card": "some", "q": { "op": "union", "of": [
        { "op": "side", "feature": "e1", "curve": "bottom" },
        { "op": "side", "feature": "e1", "curve": "top" } ] } }),
    )
}

/// §5.7 step 3: an integer card that the pieces break (the set without the split's extra
/// pieces has `n` members) fails with `REF_SPLIT`, the pieces as candidates (name-anchored
/// first, then by size); the "all are used" info is not kept.
#[test]
fn step3_an_integer_card_the_pieces_break_is_a_split() {
    let mut rc = captured(&bottom_and_top(), &plate().scope());
    rc.card = Some(forge_ir::v1::Cardinality::Exactly(2));
    let b = three_piece_split(5.0);
    let s = b.scope();
    let res = run(&rc, &s);
    assert_eq!(res.code(), Some("REF_SPLIT"));
    assert!(res.members.is_empty());
    assert!(
        res.warnings.iter().all(|w| w.code != "REF_SPLIT_ACCEPTED"),
        "{:?}",
        res.warnings
    );
    let u = &res.report.unresolved;
    assert_eq!(u.len(), 1);
    assert_eq!(u[0].key, "e1/side:bottom");
    assert_eq!(u[0].reason, UnresolvedReason::Split);
    let c = &u[0].candidates;
    assert_eq!(c.len(), 3);
    assert!(c.iter().all(|c| c.reason == CandidateReason::SplitPiece));
    // After the name-anchored piece (the best match of the capture), by size.
    let size = |c: &forge_ir::v1::metrics::Candidate| {
        let e = s
            .with_key(&c.key)
            .iter()
            .copied()
            .find(|e| s.probe(*e).is_ok_and(|p| p == c.probe))
            .expect("the candidate's piece");
        s.props(e).expect("props").size
    };
    assert!(size(&c[1]) >= size(&c[2]));
    for c in c {
        let q = c.query.as_ref().expect("a query selecting the piece");
        assert_eq!(eval_query(q, &s).expect("evaluates").members.len(), 1);
    }
    // The count that matches takes every piece.
    rc.card = Some(forge_ir::v1::Cardinality::Exactly(4));
    let ok = run(&rc, &s);
    assert_eq!(ok.status, RefStatus::Accepted);
    assert_eq!(ok.members.len(), 4);
    assert_eq!(ok.warnings.len(), 1, "one info per key");
    assert_eq!(ok.warnings[0].code, "REF_SPLIT_ACCEPTED");
}

/// §5.7 step 5: a count the split did not cause is `REF_CARDINALITY` `{ field, expected,
/// found }`, also when a split was accepted — here the card was wrong before the split (one
/// captured member, card 2 or 3), so the set without the extra pieces does not match it
/// either.
#[test]
fn step5_a_count_mismatch_the_split_did_not_cause_is_a_cardinality_error() {
    let b = three_piece_split(5.0);
    let s = b.scope();
    for (q, k, found) in [(side("bottom"), 2, 3), (bottom_and_top(), 3, 4)] {
        let mut rc = captured(&q, &plate().scope());
        rc.card = Some(forge_ir::v1::Cardinality::Exactly(k));
        let res = run(&rc, &s);
        assert_eq!(res.code(), Some("REF_CARDINALITY"), "{:?}", res.report);
        let d = &res.error.as_ref().expect("error").details;
        assert_eq!(d["expected"], json!(k));
        assert_eq!(d["found"], json!(found));
        assert!(res.report.unresolved.is_empty(), "{:?}", res.report);
        assert!(res.members.is_empty());
        assert!(res.warnings.iter().all(|w| w.code != "REF_SPLIT_ACCEPTED"));
    }
}

/// An accepted split, re-captured (`captureRef`), is exact from then on — also after a
/// dimension edit; a further split is reported once per key; pieces merging back fail loudly.
#[test]
fn step3_an_accepted_split_recaptured_is_exact() {
    let mut rc = captured(&side("bottom"), &plate().scope());
    rc.card = Some(forge_ir::v1::Cardinality::SOME);
    let b = shared_key_split();
    let sb = b.scope();
    let first = run(&rc, &sb);
    assert_eq!(first.status, RefStatus::Accepted);
    // captureRef.
    let mut rc2 = rc.clone();
    rc2.capture = Some(capture(&first.members, &sb).expect("capture"));
    assert_eq!(rc2.capture.as_ref().expect("capture").members.len(), 2);
    let again = run(&rc2, &sb);
    assert_eq!(again.status, RefStatus::Exact, "{:?}", again.warnings);
    assert!(again.warnings.is_empty());
    assert_eq!(again.entities(), first.entities());
    assert!(
        again
            .members
            .iter()
            .all(|m| m.status == MemberStatus::Exact)
    );
    // A dimension edit moves both pieces: still exact, one-to-one.
    let taller = shared_key_split_at(7.0);
    let st = taller.scope();
    let edited = run(&rc2, &st);
    assert_eq!(edited.status, RefStatus::Exact, "{:?}", edited.error);
    assert_eq!(edited.members.len(), 2);
    // A third piece: one REF_SPLIT_ACCEPTED for the key.
    let three = three_piece_split(5.0);
    let s3 = three.scope();
    let more = run(&rc2, &s3);
    assert_eq!(more.status, RefStatus::Accepted);
    assert_eq!(more.members.len(), 3);
    let infos: Vec<&str> = more.warnings.iter().map(|w| w.code.as_str()).collect();
    assert_eq!(infos, ["REF_SPLIT_ACCEPTED"]);
    // The pieces merged back into one face: one captured piece matches it, the other has no
    // counterpart — never silently accepted.
    let merged = plate();
    let back = run(&rc2, &merged.scope());
    assert_eq!(back.status, RefStatus::Failed, "{:?}", back.report);
}

fn shared_key_split_at(d: f64) -> Model {
    let split = r#"
        { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [0, -10] },
        { "kind": "line", "id": "bottom2", "start": [0, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let mut m = eval(&doc(split, &e1(d)));
    let body = reprovenance(&m.bodies[0].0, |p| {
        let mut q = rename_in(p, "e1/side:bottom2", "e1/side:bottom");
        if q.role == Role::Side && q.sources.iter().any(|x| x == "bottom2") {
            q.sources = ["bottom".to_string()].into_iter().collect();
        }
        q
    });
    m.bodies[0].0 = body;
    share_junctions(&mut m.table, "e1", "bottom2", "bottom");
    m
}

// ---- qualified families: only junctions are checked for swaps -----------------------------

/// A multi-region sketch shifted by its region pitch puts region `a`'s cap where region `b`'s
/// was: `cap { member: b1 }` is still exactly `b`'s cap (§5.7 step 3: one key hit, same type
/// and neighbours).
#[test]
fn step3_a_region_shift_by_its_pitch_stays_exact() {
    let cap_b = r(
        json!({ "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end", "member": "b1" } }),
    );
    let body_b =
        r(json!({ "kind": "body", "q": { "op": "body", "feature": "e1", "member": "b1" } }));
    let base = eval(&doc(&common::squares(&[0.0, 10.0, 20.0], 4.0), &e1(2.0)));
    let shifted = eval(&doc(&common::squares(&[10.0, 20.0, 30.0], 4.0), &e1(2.0)));
    let (sa, sb) = (base.scope(), shifted.scope());
    for q in [cap_b, body_b] {
        let rc = captured(&q, &sa);
        let res = run(&rc, &sb);
        assert_eq!(res.status, RefStatus::Exact, "{:?}: {:?}", q.q, res.error);
        let p = res.report.members[0].probe.point;
        assert!(
            p[0] > 20.0 && p[0] < 24.0,
            "region b moved to x = 20..24: {p:?}"
        );
    }
}

/// Pattern copies (`@i` bodies) under a spacing edit: copy `@1` lands where `@2` was (×0.5)
/// or `@2` where `@1`… (×2); every copy stays exact.
#[test]
fn step3_pattern_spacing_edits_stay_exact() {
    let square = |x: f64| eval(&doc(&common::squares(&[x], 4.0), &e1(2.0)));
    let copies =
        |spacing: f64| -> Vec<Model> { (0..3).map(|i| square(spacing * i as f64)).collect() };
    fn scope_of(ms: &[Model]) -> Scope<'_> {
        let mut t = ms[0].table.clone();
        t.push(forge_refs::FeatureInfo::new("pt1", "row", "pattern"));
        let mut b = ScopeBuilder::new(t).body(&ms[0].bodies[0].0, ms[0].bodies[0].1.clone());
        for (i, m) in ms.iter().enumerate().skip(1) {
            b = b.body(
                &m.bodies[0].0,
                forge_refs::Origin {
                    feature: "pt1".into(),
                    member: "a1".into(),
                    instance: Some(vec![i as u32]),
                },
            );
        }
        b.build()
    }
    let bodies =
        r(json!({ "kind": "body", "card": "some", "q": { "op": "body", "feature": "pt1" } }));
    let base = copies(20.0);
    let sbase = scope_of(&base);
    let rc = captured(&bodies, &sbase);
    assert_eq!(rc.capture.as_ref().expect("capture").members.len(), 2);
    for spacing in [10.0, 40.0] {
        let edited = copies(spacing);
        let s = scope_of(&edited);
        let res = run(&rc, &s);
        assert_eq!(
            res.status,
            RefStatus::Exact,
            "spacing {spacing}: {:?}",
            res.error
        );
        assert_eq!(
            res.report
                .members
                .iter()
                .map(|m| m.key.as_str())
                .collect::<Vec<_>>(),
            ["pt1/body:a1@1", "pt1/body:a1@2"]
        );
        let x1 = res.report.members[0].probe.point[0];
        assert!(
            x1 >= spacing && x1 <= spacing + 4.0,
            "{spacing}: copy @1 at {x1}"
        );
    }
}

/// Hole faces (`H/wall@p`) under a grid-spacing edit: `@p2` lands where `@p1` was; `@p1`
/// stays exact.
#[test]
fn step3_hole_spacing_edits_stay_exact() {
    let holes = |spacing: f64| {
        let rings: String = (0..3)
            .map(|k| {
                format!(
                    r#", {{ "kind": "circle", "id": "p{k}", "center": [{}, 0], "radius": 2 }}"#,
                    -10.0 + spacing * f64::from(k)
                )
            })
            .collect();
        let m = eval(&doc(&format!("{OUTLINE}{rings}"), &e1(5.0)));
        let body = reprovenance(&m.bodies[0].0, |p| {
            match p.sources.iter().find(|x| x.starts_with('p')) {
                Some(pk) if p.role == Role::Side => {
                    forge_core::topo::Provenance::new("h1", Role::Other("wall".into()))
                        .with_qualifier(pk.clone())
                }
                _ => p.clone(),
            }
        });
        (m, body)
    };
    let wall = r(
        json!({ "kind": "face", "q": { "op": "hole_face", "feature": "h1", "at": "p1", "part": "wall" } }),
    );
    fn scope_of<'a>(m: &Model, body: &'a forge_core::topo::Body) -> Scope<'a> {
        let mut t = m.table.clone();
        t.push(forge_refs::FeatureInfo::new("h1", "bores", "hole"));
        ScopeBuilder::new(t)
            .body(body, m.bodies[0].1.clone())
            .build()
    }
    let (a, ab) = holes(10.0);
    let sa = scope_of(&a, &ab);
    let rc = captured(&wall, &sa);
    let (b, bb) = holes(5.0);
    let sb = scope_of(&b, &bb);
    let res = run(&rc, &sb);
    assert_eq!(res.status, RefStatus::Exact, "{:?}", res.error);
    assert_eq!(res.report.members[0].key, "h1/wall@p1");
    let x = res.report.members[0].probe.point[0];
    assert!((x - -5.0).abs() <= 2.0 + 1e-9, "p1 moved to x = -5: {x}");
}

// ---- aliases -------------------------------------------------------------------------------

/// Alias chains are closed, nested keys are normalised through them, and a captured edge next
/// to a merged face is found through the alias (merged), not by geometry.
#[test]
fn aliases_chain_and_reach_nested_keys() {
    let m = plate();
    let e = r(json!({ "kind": "edge", "q": { "op": "between",
        "a": { "op": "cap", "feature": "e1", "end": "end" },
        "b": { "op": "side", "feature": "e1", "curve": "right" } } }));
    let rc = captured(&e, &m.scope());
    let body = reprovenance(&m.bodies[0].0, |p| {
        let mut q = rename_in(p, "e1/side:right", "e1/side:rightz");
        if q.role == Role::Side && q.sources.iter().any(|x| x == "right") {
            q.sources = ["rightz".to_string()].into_iter().collect();
        }
        q
    });
    let s = ScopeBuilder::new(m.table.clone())
        .body(&body, m.bodies[0].1.clone())
        .alias("e1/side:right", "e1/side:rightm")
        .alias("e1/side:rightm", "e1/side:rightz")
        .build();
    assert_eq!(s.alias_target("e1/side:right"), Some("e1/side:rightz"));
    assert_eq!(
        s.normalize_key("e1/edge:{e1/cap:end@bottom|e1/side:right}"),
        "e1/edge:{e1/cap:end@bottom|e1/side:rightz}"
    );
    let res = run(&rc, &s);
    assert_eq!(res.status, RefStatus::Accepted, "{:?}", res.error);
    assert_eq!(res.report.members[0].status, MemberStatus::Merged);
    assert_eq!(res.warnings[0].code, "REF_MERGED");
    // Re-captured after the merge: exact.
    let mut rc2 = rc.clone();
    rc2.capture = Some(capture(&res.members, &s).expect("capture"));
    assert_eq!(run(&rc2, &s).status, RefStatus::Exact);
}

/// §5.7 step 3 table: a member found through an alias whose neighbours decreased reports
/// both rows (merged, neighbourhood changed).
#[test]
fn step3_merged_with_fewer_neighbours_reports_both() {
    let split = r#"
        { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [0, -10] },
        { "kind": "line", "id": "bottom2", "start": [0, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let a = eval(&doc(split, &e1(5.0)));
    let rc = captured(&side("bottom"), &a.scope());
    let b = eval(&doc(OUTLINE, &e1(5.0)));
    let body = reprovenance(&b.bodies[0].0, |p| {
        let mut q = rename_in(p, "e1/side:bottom", "e1/side:bottom0");
        if q.role == Role::Side && q.sources.iter().any(|x| x == "bottom") {
            q.sources = ["bottom0".to_string()].into_iter().collect();
        }
        q
    });
    let s = ScopeBuilder::new(b.table.clone())
        .body(&body, b.bodies[0].1.clone())
        .alias("e1/side:bottom", "e1/side:bottom0")
        .build();
    let res = run(&rc, &s);
    assert_eq!(res.status, RefStatus::Accepted);
    let codes: Vec<&str> = res.warnings.iter().map(|w| w.code.as_str()).collect();
    assert_eq!(codes, ["REF_MERGED", "REF_NEIGHBORHOOD_CHANGED"]);
    assert_eq!(
        res.report.members[0].status,
        MemberStatus::NeighborhoodChanged
    );
}

/// The faces-no-longer-meet row resolves the captured face keys through aliases: the
/// corner between `bottom` and `right` is rounded, and `right` was merged into `rightz`.
#[test]
fn step4_faces_no_longer_meet_through_an_alias() {
    let e = r(json!({ "kind": "edge", "q": { "op": "between",
        "a": { "op": "side", "feature": "e1", "curve": "bottom" },
        "b": { "op": "side", "feature": "e1", "curve": "right" } } }));
    let rc = captured(&e, &plate().scope());
    let rounded = r#"
        { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [18, -10] },
        { "kind": "arc", "id": "c_br", "start": [18, -10], "end": [20, -8], "center": [18, -8], "ccw": true },
        { "kind": "line", "id": "right", "start": [20, -8], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let b = eval(&doc(rounded, &e1(5.0)));
    let body = reprovenance(&b.bodies[0].0, |p| {
        let mut q = rename_in(p, "e1/side:right", "e1/side:rightz");
        if q.role == Role::Side && q.sources.iter().any(|x| x == "right") {
            q.sources = ["rightz".to_string()].into_iter().collect();
        }
        q
    });
    let s = ScopeBuilder::new(b.table.clone())
        .body(&body, b.bodies[0].1.clone())
        .alias("e1/side:right", "e1/side:rightz")
        .build();
    let res = run(&rc, &s);
    assert_eq!(res.code(), Some("REF_MISSING"), "{:?}", res.report);
    assert_eq!(
        res.report.unresolved[0].reason,
        UnresolvedReason::FacesNoLongerMeet
    );
}

// ---- fallback beyond the member's feature -----------------------------------------------------

/// An edge a later operation re-keyed (`G/edge:{…}`) is geometry-identical but of another
/// feature: listed as a candidate below the auto-accept confidence, never used.
#[test]
fn step4_identical_entities_of_other_features_are_candidates_only() {
    let m = plate();
    let e = r(json!({ "kind": "edge", "q": { "op": "between",
        "a": { "op": "side", "feature": "e1", "curve": "ring" },
        "b": { "op": "cap", "feature": "e1", "end": "end" } } }));
    let rc = captured(&e, &m.scope());
    let body = reprovenance(&m.bodies[0].0, |p| {
        if p.role == Role::EdgeBetween
            && p.sources.iter().any(|x| x.contains("side:ring"))
            && p.sources.iter().any(|x| x.contains("cap:end"))
        {
            let mut q = p.clone();
            q.feature = "g1".into();
            q
        } else {
            p.clone()
        }
    });
    let mut t = m.table.clone();
    t.push(forge_refs::FeatureInfo::new("g1", "cut", "boolean"));
    let s = ScopeBuilder::new(t)
        .body(&body, m.bodies[0].1.clone())
        .build();
    let res = run(&rc, &s);
    assert_eq!(res.code(), Some("REF_UNCERTAIN"), "{:?}", res.report);
    let c = &res.report.unresolved[0].candidates[0];
    assert!(c.key.starts_with("g1/edge:"), "{}", c.key);
    assert_eq!(c.reason, CandidateReason::Identical);
    assert!(c.confidence < AUTO_ACCEPT_CONFIDENCE);
    assert!(res.members.is_empty());
}

// ---- reporting ---------------------------------------------------------------------------------

/// Without a capture, a named source of a suppressed feature fails `REF_MISSING` with the
/// step-1 reason `feature-suppressed` naming the feature.
#[test]
fn a_suppressed_source_without_a_capture_reports_its_reason() {
    let a = plate();
    let mut t = a.table.clone();
    t.get_mut("e1").expect("e1").status = FeatureStatus::Suppressed;
    let s = ScopeBuilder::new(t).build();
    let res = run(&side("ring"), &s);
    assert_eq!(res.code(), Some("REF_MISSING"));
    let u = &res.report.unresolved;
    assert_eq!(u.len(), 1);
    assert_eq!(u[0].reason, UnresolvedReason::FeatureSuppressed);
    assert_eq!(u[0].name, "slab");
    assert!(u[0].candidates.is_empty());
}

/// Error pointers are relative to the feature (`<field>/q/…`), e.g. a negative radius bound.
#[test]
fn evaluation_errors_carry_feature_pointers() {
    let m = plate();
    let hook = |t: &str| (t == "neg").then_some(-1.0);
    let s = ScopeBuilder::new(m.table.clone())
        .body(&m.bodies[0].0, m.bodies[0].1.clone())
        .scalars(&hook)
        .build();
    let q = r(
        json!({ "kind": "face", "card": "any", "q": { "op": "filter", "where": { "radius": { "eq": "neg" } },
        "of": { "op": "sides", "feature": "e1" } } }),
    );
    let err = eval_query(&q.q, &s).expect_err("negative bound");
    assert_eq!(err.code(), "INVALID_VALUE");
    assert_eq!(err.details()["field"], "/where/radius/eq");
    let res = resolve_with(
        &q,
        &s,
        &FieldSpec {
            field: "/faces".into(),
            card: forge_ir::v1::Cardinality::SOME,
        },
    );
    check_contract(&res);
    let e = res.error.as_ref().expect("error");
    assert_eq!(e.code, "INVALID_VALUE");
    assert_eq!(e.details["field"], "/faces/q/where/radius/eq");
}

/// `tagged` passes the tag's own resolution through: a repaired tag is reported (info and
/// member status) on the reference that uses it; a failed tag fails it with the tag's code
/// and candidates, not `DEPENDENCY_FAILED`.
#[test]
fn a_tagged_source_passes_the_tag_resolution_through() {
    let a = plate();
    let tag_target = captured(&cap_end(), &a.scope());
    let with_tag = |m: &Model| {
        let mut t = m.table.clone();
        let mut tag = forge_refs::FeatureInfo::new("t1", "top", "tag");
        tag.tag = Some(tag_target.clone());
        t.push(tag);
        t
    };
    let tagged = r(json!({ "kind": "face", "q": { "op": "tagged", "feature": "t1" } }));
    let spec = FieldSpec::one("/plane/face");
    // Repaired (the body member was renamed).
    let b = eval(&doc(&format!("{OUTLINE_ZB}{RING}"), &e1(5.0)));
    let s = b.scope_with(with_tag(&b));
    let res = resolve_with(&tagged, &s, &spec);
    check_contract(&res);
    assert_eq!(res.status, RefStatus::Accepted, "{:?}", res.error);
    assert_eq!(res.warnings[0].code, "REF_REPAIRED");
    assert_eq!(res.warnings[0].details["field"], "/plane/face");
    assert_eq!(res.report.members[0].status, MemberStatus::Repaired);
    // Uncertain in this scope: the tag's code and candidates.
    let c = eval(&doc(&format!("{OUTLINE_ZB}{RING}"), &e1(5.5)));
    let s = c.scope_with(with_tag(&c));
    let res = resolve_with(&tagged, &s, &spec);
    check_contract(&res);
    assert_eq!(res.code(), Some("REF_UNCERTAIN"));
    assert_eq!(
        res.report.unresolved[0].candidates[0].key,
        "e1/cap:end@left"
    );
    let e = res.error.as_ref().expect("error");
    assert_eq!(e.details["field"], "/plane/face");
}

/// A reported entity always has a real probe: an entity whose probe cannot be computed is left
/// out with `FORGE_PROBE_FAILED`, and a reference that would use it fails.
#[test]
fn a_failed_probe_is_never_reported_as_a_point() {
    let m = plate();
    let body = common::rebuild(
        &m.bodies[0].0,
        |p| p.clone(),
        |p| !(p.role == Role::Side && p.sources.iter().any(|x| x == "ring")),
    );
    let s = ScopeBuilder::new(m.table.clone())
        .body(&body, m.bodies[0].1.clone())
        .build();
    let ring = s.with_key("e1/side:ring")[0];
    assert!(s.probe(ring).is_err(), "no domain, no probe");
    // Used: the reference fails with the probe's (engine) code.
    let res = resolve(&side("ring"), &s);
    let e = res.error.as_ref().expect("fails");
    assert!(e.code.starts_with("FORGE_"), "{}", e.code);
    assert!(res.members.is_empty());
    assert!(res.report.members.is_empty(), "no made-up probe");
    assert!(res.warnings.iter().any(|w| w.code == "FORGE_PROBE_FAILED"));
    // Every side face (card some): fails too, the four others reported with probes.
    let sides =
        r(json!({ "kind": "face", "card": "some", "q": { "op": "sides", "feature": "e1" } }));
    let res = resolve(&sides, &s);
    assert!(res.code().is_some_and(|c| c.starts_with("FORGE_")));
    assert_eq!(res.report.members.len(), 4);
    // As a candidate (card one over the five sides): left out of the candidates.
    let one = r(json!({ "kind": "face", "q": { "op": "sides", "feature": "e1" } }));
    let res = resolve(&one, &s);
    assert_eq!(res.code(), Some("REF_AMBIGUOUS"));
    let cands = &res.report.unresolved[0].candidates;
    assert_eq!(cands.len(), 4);
    assert!(cands.iter().all(|c| c.key != "e1/side:ring"));
    assert!(
        res.warnings
            .iter()
            .any(|w| w.code == "FORGE_PROBE_FAILED" && w.details["key"] == "e1/side:ring")
    );
}

/// §7.6: a body's probe is the probe of its smallest-key face; among split pieces sharing
/// that key, the first in canonical order (by probe point), whatever the arena order.
#[test]
fn a_body_probe_takes_the_canonical_first_piece_of_its_smallest_key() {
    let lower = r#"{ "kind": "line", "id": "bottom", "start": [-20, -10], "end": [0, -10] }"#;
    let upper = r#"{ "kind": "line", "id": "bottom2", "start": [0, -10], "end": [20, -10] }"#;
    let rest = r#"
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    // The two pieces in both sketch (and so arena) orders.
    for curves in [
        format!("{lower}, {upper}, {rest}"),
        format!("{upper}, {rest}, {lower}"),
    ] {
        let m = eval(&doc(&curves, &e1(5.0)));
        // Both bottom pieces re-keyed `e1/a` (the smallest key of the body).
        let body = reprovenance(&m.bodies[0].0, |p| {
            if p.role == Role::Side && p.sources.iter().any(|x| x == "bottom" || x == "bottom2") {
                forge_core::topo::Provenance::new("e1", Role::Other("a".into()))
            } else {
                p.clone()
            }
        });
        let s = ScopeBuilder::new(m.table.clone())
            .body(&body, m.bodies[0].1.clone())
            .build();
        let pieces = s.canonical(s.with_key("e1/a").to_vec());
        assert_eq!(pieces.len(), 2);
        let body_probe = s.probe(Scope::body_entity(0)).expect("probe");
        let first = s.probe(pieces[0]).expect("probe");
        assert_eq!(body_probe.point, first.point);
        assert!(
            first.point[0] < 0.0,
            "the piece with the smaller x: {first:?}"
        );
    }
}

// ---- stale captures, dropped keys, collisions (review round 2) ----------------------------

fn bow_end() -> Ref {
    r(
        json!({ "kind": "edge", "q": { "op": "edge_at", "feature": "e2", "curve": "bow", "end": "end" } }),
    )
}

/// Captures are not refreshed on exact commits (§0.6): a reversal after earlier edits that
/// changed the body's box (a distance edit, a move by exactly the junction gap, both) is
/// still recognised against the old capture; the same edits without the reversal stay exact.
#[test]
fn step3_a_junction_swap_against_a_stale_capture_is_ambiguous() {
    let rc = captured(&bow_end(), &dee(4.0, 0.0, false).scope());
    let key = rc.capture.as_ref().expect("capture").members[0].key.clone();
    // (distance, move): the earlier edits, each an exact commit that leaves the capture as is.
    for (dist, dy) in [
        (5.0, 0.0),
        (4.0, -8.0),
        (5.0, -8.0),
        (4.0, 8.0),
        (3.0, -3.0),
    ] {
        // Without the reversal: exact, the bow's end moved with the loop.
        let res = run(&rc, &dee(dist, dy, false).scope());
        assert_eq!(res.status, RefStatus::Exact, "{dist} {dy}: {:?}", res.error);
        let p = res.report.members[0].probe.point;
        assert_eq!(p, [3.0, dy - 4.0, dist / 2.0], "{dist} {dy}");
        // Then the arc reversed: the name moved to the other junction. Never rebound.
        let res = run(&rc, &dee(dist, dy, true).scope());
        assert_eq!(
            res.code(),
            Some("REF_AMBIGUOUS"),
            "{dist} {dy}: {:?}",
            res.members
        );
        let c = &res.report.unresolved[0].candidates;
        assert_eq!(c.len(), 2);
        // The junction at the captured place (moved with the loop) first, then the one the
        // name now designates.
        assert_eq!(c[0].probe.point, [3.0, dy - 4.0, dist / 2.0], "{dist} {dy}");
        assert_eq!(c[1].key, key);
        assert_eq!(c[1].probe.point, [3.0, dy + 4.0, dist / 2.0], "{dist} {dy}");
        assert!(c.iter().all(|x| x.confidence == 0.0));
        // `identical` only when it is: a distance edit changed the edge's length.
        let identical = dist == 4.0 && dy == 0.0;
        assert_eq!(c[0].reason == CandidateReason::Identical, identical);
    }
}

/// §5.7 step 5, the query is the intent: a captured named key the scope still carries but the
/// query's own pick dropped is removed (`REF_SET_CHANGED`), and the pick's new answer used —
/// never "repaired" back into the entity that still carries the key.
#[test]
fn step3_a_key_the_query_itself_dropped_is_removed_not_repaired() {
    let q = json!({ "op": "extreme", "dir": "+X", "which": "max", "of": { "op": "union", "of": [
        { "op": "side", "feature": "e1", "curve": "a2" },
        { "op": "side", "feature": "e1", "curve": "b2" } ] } });
    // Square `a` at x = 10, square `b` at x = 0: `a2` (x = 14) is the rightmost side.
    let base = eval(&doc(&common::squares(&[10.0, 0.0], 4.0), &e1(5.0)));
    // `b` moved to x = 40; `a` unchanged: `b2` (x = 44) is now the rightmost.
    let moved = eval(&doc(&common::squares(&[10.0, 40.0], 4.0), &e1(5.0)));
    let s = moved.scope();
    for card in [None, Some(forge_ir::v1::Cardinality::SOME)] {
        let mut rf = r(json!({ "kind": "face", "q": q }));
        rf.card = card;
        let rc = captured(&rf, &base.scope());
        assert_eq!(
            rc.capture.as_ref().expect("capture").members[0].key,
            "e1/side:a2"
        );
        let res = run(&rc, &s);
        assert_eq!(res.status, RefStatus::Accepted, "{card:?}: {:?}", res.error);
        let keys: Vec<&str> = res.report.members.iter().map(|m| m.key.as_str()).collect();
        assert_eq!(keys, ["e1/side:b2"], "{card:?}");
        assert_eq!(res.report.members[0].status, MemberStatus::Exact);
        assert!(res.warnings.iter().all(|w| w.code != "REF_REPAIRED"));
        let w = res
            .warnings
            .iter()
            .find(|w| w.code == "REF_SET_CHANGED")
            .expect("REF_SET_CHANGED");
        assert_eq!(w.details["removed"], json!(["e1/side:a2"]));
        assert_eq!(w.details["added"], json!(["e1/side:b2"]));
        assert_eq!(res.report.removed, ["e1/side:a2"]);
        // The proposal (same query, fresh capture) resolves exactly to the same set.
        let p = res.report.proposal.as_ref().expect("proposal");
        let fresh = resolve(p, &s);
        assert_eq!(fresh.status, RefStatus::Exact);
        assert_eq!(fresh.entities(), res.entities());
    }
    // Unchanged: still exact.
    let rc = captured(&r(json!({ "kind": "face", "q": q })), &base.scope());
    assert_eq!(run(&rc, &base.scope()).status, RefStatus::Exact);
}

/// Step 4 never takes an entity whose key another captured member designates in the step-1
/// result, whatever the byte order of the keys: two captured members never collapse into
/// one entity (keys permuted by re-provenance, both ways round).
#[test]
fn step4_never_repairs_onto_an_entity_another_captured_key_designates() {
    let m = plate();
    let mut q = r(json!({ "kind": "face", "q": { "op": "union", "of": [
        { "op": "side", "feature": "e1", "curve": "right" },
        { "op": "side", "feature": "e1", "curve": "top" } ] } }));
    q.card = Some(forge_ir::v1::Cardinality::SOME);
    let rc = captured(&q, &m.scope());
    for (right_to, top_to) in [("top", "zzz"), ("aaa", "right")] {
        let body = reprovenance(&m.bodies[0].0, |p| {
            let side = |c: &str| p.role == Role::Side && p.sources.iter().any(|x| x == c);
            let (from, to) = if side("right") {
                ("right", right_to)
            } else if side("top") {
                ("top", top_to)
            } else {
                return p.clone();
            };
            let mut n = rename_in(p, &format!("e1/side:{from}"), &format!("e1/side:{to}"));
            n.sources = [to.to_string()].into_iter().collect();
            n
        });
        let s = ScopeBuilder::new(m.table.clone())
            .body(&body, m.bodies[0].1.clone())
            .build();
        let res = run(&rc, &s);
        assert_eq!(
            res.status,
            RefStatus::Failed,
            "{right_to}: {:?}",
            res.members
        );
        assert!(res.warnings.iter().all(|w| w.code != "REF_REPAIRED"));
    }
}

/// More same-carrier neighbours around a geometry-identical member (a collinear segment added
/// next to an unchanged face) is no split: exact. When the member changed too and no new
/// piece lies inside the captured box, the box cannot delimit the split (a capture that
/// predates other edits looks the same): `REF_SPLIT`, whatever the card — never used.
#[test]
fn step3_a_new_neighbour_outside_the_captured_box_is_no_split() {
    let square = r#"
        { "kind": "line", "id": "bottom", "start": [0, 0], "end": [10, 0] },
        { "kind": "line", "id": "right", "start": [10, 0], "end": [10, 10] },
        { "kind": "line", "id": "top", "start": [10, 10], "end": [0, 10] },
        { "kind": "line", "id": "left", "start": [0, 10], "end": [0, 0] }"#;
    let longer = |b: f64| {
        format!(
            r#"
        {{ "kind": "line", "id": "bottom", "start": [0, 0], "end": [{b}, 0] }},
        {{ "kind": "line", "id": "more", "start": [{b}, 0], "end": [15, 0] }},
        {{ "kind": "line", "id": "right", "start": [15, 0], "end": [15, 10] }},
        {{ "kind": "line", "id": "top", "start": [15, 10], "end": [0, 10] }},
        {{ "kind": "line", "id": "left", "start": [0, 10], "end": [0, 0] }}"#
        )
    };
    let a = eval(&doc(square, &e1(5.0)));
    let unchanged = eval(&doc(&longer(10.0), &e1(5.0)));
    let shorter = eval(&doc(&longer(8.0), &e1(5.0)));
    for card in [None, Some(forge_ir::v1::Cardinality::SOME)] {
        let mut rf = side("bottom");
        rf.card = card;
        let rc = captured(&rf, &a.scope());
        assert_eq!(
            rc.capture.as_ref().expect("cap").members[0].geom.neighbors,
            0
        );
        // `bottom` untouched, a collinear `more` added next to it: exact.
        let s = unchanged.scope();
        let e = s.with_key("e1/side:bottom")[0];
        assert_eq!(s.neighbors(e), 1);
        let res = run(&rc, &s);
        assert_eq!(res.status, RefStatus::Exact, "{card:?}: {:?}", res.report);
        assert_eq!(res.entities(), [e]);
        // `bottom` shortened, `more` reaching past its old end: loud, both as candidates
        // (the name-anchored piece first).
        let s = shorter.scope();
        let res = run(&rc, &s);
        assert_eq!(res.code(), Some("REF_SPLIT"), "{card:?}: {:?}", res.members);
        let keys: Vec<&str> = res.report.unresolved[0]
            .candidates
            .iter()
            .map(|c| c.key.as_str())
            .collect();
        assert_eq!(keys, ["e1/side:bottom", "e1/side:more"]);
        assert!(res.warnings.iter().all(|w| w.code != "REF_SPLIT_ACCEPTED"));
    }
}

/// A split after an edit that moved the captured box (§0.6: the capture predates the edit):
/// the pieces lie outside the stale box, so the split is loud whatever the card, never a
/// silent use of the name-anchored piece alone (found by harness family (g)).
#[test]
fn step3_a_split_against_a_stale_capture_is_never_used() {
    let rc_of = |card| {
        let mut rf = side("bottom");
        rf.card = card;
        captured(&rf, &plate().scope())
    };
    // First edit: distance 5 → 8 (exact, the capture is not refreshed); then `bottom`
    // split, keeping its id on one piece.
    let split = r#"
        { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [0, -10] },
        { "kind": "line", "id": "bottom_s", "start": [0, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let after_distance = eval(&doc(&format!("{OUTLINE}{RING}"), &e1(8.0)));
    let both = eval(&doc(&format!("{split}{RING}"), &e1(8.0)));
    for card in [None, Some(forge_ir::v1::Cardinality::SOME)] {
        let rc = rc_of(card);
        assert_eq!(run(&rc, &after_distance.scope()).status, RefStatus::Exact);
        let res = run(&rc, &both.scope());
        assert_eq!(res.code(), Some("REF_SPLIT"), "{card:?}: {:?}", res.members);
        let keys: Vec<&str> = res.report.unresolved[0]
            .candidates
            .iter()
            .map(|c| c.key.as_str())
            .collect();
        assert_eq!(keys, ["e1/side:bottom", "e1/side:bottom_s"]);
    }
}

/// A tag's query may only name earlier tags (§6.12): a cycle of tags that are both before the
/// consumer, or a tag naming itself, fails with `UNRESOLVED_FEATURE` instead of recursing
/// without end; a chain of earlier tags resolves.
#[test]
fn tag_cycles_and_forward_tags_fail_instead_of_recursing() {
    let a = plate();
    let tagged = |t: &str| r(json!({ "kind": "face", "q": { "op": "tagged", "feature": t } }));
    let tag = |id: &str, target: Ref| {
        let mut f = forge_refs::FeatureInfo::new(id, id, "tag");
        f.tag = Some(target);
        f
    };
    let mut t = a.table.clone();
    t.push(tag("t0", cap_end()));
    t.push(tag("t1", tagged("t2")));
    t.push(tag("t2", tagged("t1")));
    t.push(tag("t3", tagged("t3")));
    t.push(tag("t4", tagged("t0")));
    let s = a.scope_with(t);
    for id in ["t1", "t2", "t3"] {
        let res = run(&tagged(id), &s);
        assert_eq!(res.code(), Some("UNRESOLVED_FEATURE"), "{id}");
    }
    let res = run(&tagged("t4"), &s);
    assert_eq!(res.status, RefStatus::Exact, "{:?}", res.error);
    assert_eq!(res.report.members[0].key, "e1/cap:end@bottom");
}

// ---- split pieces: the key invariant, picks, slivers ----------------------------------------

/// §5.2 rule 3: split pieces share their key and are no key problem — the invariant
/// forge-regen asserts after every operation holds on correct splits (the pieces of a face,
/// and the pieces of its edges with the caps: each group on one carrier). A pair of faces
/// sharing a key on different carriers still is one (see also `tests/keys.rs`).
#[test]
fn split_pieces_sharing_a_key_are_no_key_problem() {
    for m in [
        common::notched(-5.0, 5.0, 0.0),
        shared_key_split(),
        shared_key_split_at(7.0),
    ] {
        let s = m.scope();
        assert!(s.key_problems().is_empty(), "{:?}", s.key_problems());
        let pieces = s
            .with_key("e1/side:bottom")
            .iter()
            .filter(|e| e.kind() == forge_ir::v1::EntityKind::Face)
            .count();
        assert!(pieces >= 2, "the key is shared");
        let edges = s
            .with_key("e1/edge:{e1/cap:end@bottom|e1/side:bottom}")
            .len();
        assert_eq!(
            edges, pieces,
            "each piece has its own cap edge, sharing the key"
        );
    }
    // The same pieces moved off one carrier (the right piece lifted to y = −9): a problem.
    let m = common::notched(-5.0, 5.0, 1.0);
    let problems = m.scope().key_problems();
    assert!(
        problems.iter().any(|p| p.key == "e1/side:bottom"
            && p.problem.contains("2 faces")
            && p.problem.contains("different carriers")),
        "{problems:?}"
    );
}

/// `extreme { +X, max, side(e1, bottom) }`.
fn plus_x_bottom() -> Ref {
    r(
        json!({ "kind": "face", "q": { "op": "extreme", "dir": "+X", "which": "max",
        "of": { "op": "side", "feature": "e1", "curve": "bottom" } } }),
    )
}

/// §5.7 step 3 with the query as the intent: a pick over a member split into pieces that
/// share its key keeps choosing. The piece the pick dropped is never brought back as a piece
/// of the split: `card: some` uses the picked piece only (`REF_SPLIT_ACCEPTED` says the query
/// selected it), `card: one` fails `REF_SPLIT` with the picked piece as the only candidate.
#[test]
fn step3_a_pick_over_a_shared_key_split_uses_only_the_picked_piece() {
    let b = shared_key_split();
    let s = b.scope();
    let picked = eval_query(&plus_x_bottom().q, &s).expect("evaluates");
    assert_eq!(picked.members.len(), 1);
    let right = picked.members[0].entity;
    let right_probe = s.probe(right).expect("probe");
    assert!(right_probe.point[0] > 0.0, "{right_probe:?}");
    // card: some.
    let mut rf = plus_x_bottom();
    rf.card = Some(forge_ir::v1::Cardinality::SOME);
    let rc = captured(&rf, &plate().scope());
    let res = run(&rc, &s);
    assert_eq!(res.status, RefStatus::Accepted, "{:?}", res.error);
    assert_eq!(res.entities(), [right]);
    assert_eq!(res.report.members[0].status, MemberStatus::Split);
    assert_eq!(res.report.members[0].probe, right_probe);
    let w = res
        .warnings
        .iter()
        .find(|w| w.code == "REF_SPLIT_ACCEPTED")
        .expect("REF_SPLIT_ACCEPTED");
    assert_eq!(w.details["pieces"].as_array().expect("pieces").len(), 1);
    assert!(w.message.contains("split into 2 pieces"), "{}", w.message);
    assert!(
        w.message.contains("the 1 the query selects"),
        "{}",
        w.message
    );
    // card: one.
    let rc = captured(&plus_x_bottom(), &plate().scope());
    let res = run(&rc, &s);
    assert_eq!(res.code(), Some("REF_SPLIT"), "{:?}", res.members);
    let c = &res.report.unresolved[0].candidates;
    assert_eq!(c.len(), 1, "{c:?}");
    assert_eq!(c[0].probe, right_probe);
}

/// The plate with `bottom` cut into three collinear pieces: `bottom` (−20..−5) and `bottom2`
/// (−5..5) share the key `e1/side:bottom`, `bottom3` (5..20) keeps a new key.
fn mixed_split() -> Model {
    let split = r#"
        { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [-5, -10] },
        { "kind": "line", "id": "bottom2", "start": [-5, -10], "end": [5, -10] },
        { "kind": "line", "id": "bottom3", "start": [5, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let mut m = eval(&doc(split, &e1(5.0)));
    common::share_side_key(&mut m, "bottom2", "bottom");
    m
}

/// A pick that chose among pieces sharing the key never saw the pieces with new keys: which
/// of those it would keep is unknown, so the split is loud whatever the card (`REF_SPLIT`, the
/// picked piece and the new-key piece as candidates; the piece the pick dropped is none).
#[test]
fn step3_a_pick_over_a_split_with_new_key_pieces_is_loud() {
    let m = mixed_split();
    let s = m.scope();
    let picked = eval_query(&plus_x_bottom().q, &s).expect("evaluates");
    assert_eq!(picked.members.len(), 1);
    let middle = s.probe(picked.members[0].entity).expect("probe");
    for card in [None, Some(forge_ir::v1::Cardinality::SOME)] {
        let mut rf = plus_x_bottom();
        rf.card = card;
        let rc = captured(&rf, &plate().scope());
        let res = run(&rc, &s);
        assert_eq!(res.code(), Some("REF_SPLIT"), "{card:?}: {:?}", res.members);
        let c = &res.report.unresolved[0].candidates;
        let keys: Vec<&str> = c.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(keys, ["e1/side:bottom", "e1/side:bottom3"], "{card:?}");
        assert_eq!(c[0].probe, middle, "the picked piece first");
        assert!(res.warnings.iter().all(|w| w.code != "REF_SPLIT_ACCEPTED"));
    }
}

/// A geometry-identical member is still split by a sliver piece inside its captured box: the
/// comparison's tolerances (box padding `1e-4·s`, size ratio 0.999) do not prove that nothing
/// of the captured entity lies elsewhere. `REF_SPLIT` with card one, every piece with card
/// some — never the anchor alone.
#[test]
fn step3_a_sliver_piece_inside_the_captured_box_is_a_split() {
    let sliver = r#"
        { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [19.996, -10] },
        { "kind": "line", "id": "more", "start": [19.996, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let m = eval(&doc(&format!("{sliver}{RING}"), &e1(5.0)));
    let s = m.scope();
    let rc = captured(&side("bottom"), &plate().scope());
    // Precondition: `bottom` is geometry-identical to its capture within the tolerances.
    let e = s.with_key("e1/side:bottom")[0];
    let geom = &rc.capture.as_ref().expect("capture").members[0].geom;
    let f = s.fingerprint(e).expect("fingerprint");
    assert!(forge_refs::geom::compare(geom, &f, s.scale()).identical);
    assert_eq!((geom.neighbors, s.neighbors(e)), (0, 1));
    let res = run(&rc, &s);
    assert_eq!(res.code(), Some("REF_SPLIT"), "{:?}", res.members);
    let keys: Vec<&str> = res.report.unresolved[0]
        .candidates
        .iter()
        .map(|c| c.key.as_str())
        .collect();
    assert_eq!(keys, ["e1/side:bottom", "e1/side:more"]);
    let mut rf = side("bottom");
    rf.card = Some(forge_ir::v1::Cardinality::SOME);
    let rc = captured(&rf, &plate().scope());
    let res = run(&rc, &s);
    assert_eq!(res.status, RefStatus::Accepted, "{:?}", res.error);
    let mut keys: Vec<&str> = res.members.iter().map(|m| m.key.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["e1/side:bottom", "e1/side:more"]);
    assert!(res.members.iter().all(|m| m.status == MemberStatus::Split));
}

/// A captured key that does not parse (a hand-edited or mis-migrated capture) names no
/// feature: its geometry-identical match is a candidate only (`REF_UNCERTAIN` at
/// `MAX_DISAMBIGUATION_CONFIDENCE`), never used — the own-feature rule of step 4 cannot hold.
#[test]
fn step4_an_unparsable_captured_key_is_never_repaired() {
    let m = plate();
    let s = m.scope();
    let mut rc = captured(&side("bottom"), &s);
    let bad = "not a key";
    assert!(forge_core::topo::parse_key(bad).is_err());
    rc.capture.as_mut().expect("capture").members[0].key = bad.into();
    let res = run(&rc, &s);
    assert_eq!(res.code(), Some("REF_UNCERTAIN"), "{:?}", res.members);
    assert!(res.warnings.iter().all(|w| w.code != "REF_REPAIRED"));
    let c = &res.report.unresolved[0].candidates;
    assert_eq!(c[0].key, "e1/side:bottom");
    assert_eq!(c[0].reason, CandidateReason::Identical);
    assert_eq!(c[0].confidence, forge_ir::v1::MAX_DISAMBIGUATION_CONFIDENCE);
}

/// Step 4's split pieces never include an entity another captured key designates in the
/// step-1 result, and such an entity is never ranked before a free candidate: captured
/// `bottom` (−20..0) is gone, and on its carrier inside its box lie `p` (−20..−10, free) and
/// `bottom2` (−10..0, designated by the other captured key). One free piece: `REF_UNCERTAIN`
/// with `p` first (0.7), not a `REF_SPLIT` naming `bottom2` as a piece of `bottom`.
#[test]
fn step4_pieces_exclude_entities_another_captured_key_designates() {
    let before = r#"
        { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [0, -10] },
        { "kind": "line", "id": "bottom2", "start": [0, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let after = r#"
        { "kind": "line", "id": "p", "start": [-20, -10], "end": [-10, -10] },
        { "kind": "line", "id": "bottom2", "start": [-10, -10], "end": [0, -10] },
        { "kind": "line", "id": "q", "start": [0, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let a = eval(&doc(before, &e1(5.0)));
    let b = eval(&doc(after, &e1(5.0)));
    let rf = r(
        json!({ "kind": "face", "card": "some", "q": { "op": "union", "of": [
        { "op": "side", "feature": "e1", "curve": "bottom" },
        { "op": "side", "feature": "e1", "curve": "bottom2" } ] } }),
    );
    let rc = captured(&rf, &a.scope());
    // `bottom` is still a profile curve for the query's static check (its key is gone).
    let mut t = b.table.clone();
    t.get_mut("e1")
        .and_then(|f| f.profile.as_mut())
        .expect("profile")
        .curves
        .insert("bottom".into(), forge_refs::CurveClass::Line);
    let s = b.scope_with(t);
    let res = run(&rc, &s);
    assert_eq!(res.status, RefStatus::Failed);
    let u = res
        .report
        .unresolved
        .iter()
        .find(|u| u.key == "e1/side:bottom")
        .expect("bottom unresolved");
    assert_eq!(u.reason, UnresolvedReason::NameNotFound, "{u:?}");
    assert_eq!(u.candidates[0].key, "e1/side:p");
    assert_eq!(u.candidates[0].reason, CandidateReason::SplitPiece);
    assert_eq!(u.candidates[0].confidence, 0.7);
    assert!(
        u.candidates
            .iter()
            .all(|c| !(c.key == "e1/side:bottom2" && c.reason == CandidateReason::SplitPiece)),
        "{:?}",
        u.candidates
    );
}

/// A pick that dropped a captured member which was then split into pieces with new keys chose
/// without those pieces (they are no members of its named sources): loud (`REF_SPLIT`, the
/// pieces as candidates, whatever the card), never the pick's answer over the incomplete
/// source — here `left`, where the pick over every piece would answer `bottom1` (harness
/// family (i) found three such silent-wrong picks once split sources were scored).
#[test]
fn step3_a_pick_that_dropped_a_split_member_is_loud() {
    let q = json!({ "op": "largest", "of": { "op": "union", "of": [
        { "op": "side", "feature": "e1", "curve": "bottom" },
        { "op": "side", "feature": "e1", "curve": "left" } ] } });
    let base = common::split_bottom(&[], false);
    let m = common::split_bottom(&[-10.0], false);
    let s = m.scope();
    for card in [None, Some(forge_ir::v1::Cardinality::SOME)] {
        let mut rf = r(json!({ "kind": "face", "q": q }));
        rf.card = card;
        let rc = captured(&rf, &base.scope());
        assert_eq!(
            rc.capture.as_ref().expect("capture").members[0].key,
            "e1/side:bottom"
        );
        let now = eval_query(&rf.q, &s).expect("evaluates");
        assert_eq!(s.key(now.members[0].entity), "e1/side:left");
        let res = run(&rc, &s);
        assert_eq!(res.code(), Some("REF_SPLIT"), "{card:?}: {:?}", res.members);
        let keys: Vec<&str> = res.report.unresolved[0]
            .candidates
            .iter()
            .map(|c| c.key.as_str())
            .collect();
        assert_eq!(keys, ["e1/side:bottom", "e1/side:bottom1"], "{card:?}");
    }
}

/// A member still in the result of a query that chooses (here a filter) and split into pieces
/// with new keys: the filter never saw those pieces, so the split is loud whatever the card;
/// the same member under a query that only names it takes every piece with `card: some`
/// (§5.7 step 3).
#[test]
fn step3_a_split_under_a_choosing_query_is_loud_under_a_naming_query_accepted() {
    let filtered = r(
        json!({ "kind": "face", "card": "some", "q": { "op": "filter",
        "of": { "op": "side", "feature": "e1", "curve": "bottom" }, "where": { "type": "plane" } } }),
    );
    let named = side_bottom_some();
    let base = common::split_bottom(&[], false);
    let m = common::split_bottom(&[0.0], false);
    let s = m.scope();
    let res = run(&captured(&filtered, &base.scope()), &s);
    assert_eq!(res.code(), Some("REF_SPLIT"), "{:?}", res.members);
    assert_eq!(res.report.unresolved[0].candidates.len(), 2);
    let res = run(&captured(&named, &base.scope()), &s);
    assert_eq!(res.status, RefStatus::Accepted, "{:?}", res.error);
    assert_eq!(res.members.len(), 2);
}

fn side_bottom_some() -> Ref {
    let mut rf = side("bottom");
    rf.card = Some(forge_ir::v1::Cardinality::SOME);
    rf
}
