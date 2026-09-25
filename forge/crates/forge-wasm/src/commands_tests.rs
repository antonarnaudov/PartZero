//! Tests of the command-layer entry points ([`super`]): each op's effect, its inverse (applying
//! the op's inverse restores the canonical document byte for byte), idempotence where the plan
//! requires it, every refusal code, and the `renameCurve` property over generated documents
//! (IR-V1 plan W9 acceptance).

#[cfg(not(target_family = "wasm"))]
use proptest::prelude::*;
use serde_json::{Value, json};

use super::*;
use crate::engine;

// ---- helpers ------------------------------------------------------------------------------------

fn repo(rel: &str) -> String {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// The canonical text of a document (the form every op returns).
fn canon(text: &str) -> String {
    forge_ir::v1::to_json(&load(text).expect("loads")) + "\n"
}

fn report(text: &str) -> EvalReport {
    evaluate(&load(text).expect("loads"))
}

fn entry<'r>(rep: &'r EvalReport, feature: &str, field: &str) -> &'r RefReport {
    ref_entry(rep, feature, field).unwrap_or_else(|e| panic!("{feature}{field}: {e:?}"))
}

/// Every reference of the report, `(feature id, field, status)`.
fn statuses(rep: &EvalReport) -> Vec<(String, String, RefStatus)> {
    rep.features
        .iter()
        .flat_map(|f| {
            f.refs
                .iter()
                .map(|r| (f.feature_id.clone(), r.field.clone(), r.status))
        })
        .collect()
}

fn capture_all(mut text: String) -> String {
    let rep = report(&text);
    for (f, field, status) in statuses(&rep) {
        assert_ne!(status, RefStatus::Failed, "{f}{field} fails before capture");
        text = capture_ref(&text, &f, &field)
            .unwrap_or_else(|e| panic!("capture {f}{field}: {e:?}"))
            .document;
    }
    text
}

fn doc(features: Value) -> String {
    json!({
        "schema": "aicad.ir/1",
        "meta": { "name": "t" },
        "params": [
            { "name": "w", "unit": "mm", "value": 40 },
            { "name": "t", "unit": "mm", "value": 6, "min": 1 }
        ],
        "parts": [{ "id": "p1", "name": "part", "features": features }]
    })
    .to_string()
}

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> Value {
    json!({ "kind": "line", "id": id, "start": a, "end": b })
}

fn tag(id: &str, kind: &str, q: Value, card: Value) -> Value {
    json!({ "type": "tag", "id": id, "name": id, "target": { "kind": kind, "q": q, "card": card } })
}

/// A square plate `s1`/`e1` (curves bottom, right, top, left) with tags on its entities.
fn plate() -> String {
    doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
            line("bottom", [-20.0, -10.0], [20.0, -10.0]),
            line("right", [20.0, -10.0], [20.0, 10.0]),
            line("top", [20.0, 10.0], [-20.0, 10.0]),
            line("left", [-20.0, 10.0], [-20.0, -10.0])
        ]},
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": "t" },
        tag("t_side", "face", json!({ "op": "side", "feature": "e1", "curve": "top" }), json!("one")),
        tag("t_cap", "face", json!({ "op": "cap", "feature": "e1", "end": "end" }), json!("one")),
        tag("t_edge", "edge", json!({ "op": "edge_at", "feature": "e1", "curve": "right", "end": "end" }), json!("one")),
        tag("t_between", "edge", json!({ "op": "between",
            "a": { "op": "side", "feature": "e1", "curve": "left" },
            "b": { "op": "cap", "feature": "e1", "end": "start" } }), json!("one")),
        tag("t_body", "body", json!({ "op": "body", "feature": "e1", "member": "top" }), json!("one")),
        tag("t_vertical", "edge", json!({ "op": "filter", "where": { "parallel": "Z" },
            "of": { "op": "edges", "of": { "op": "sides", "feature": "e1" } } }), json!("some"))
    ]))
}

fn code(r: Result<Edited, Rejection>) -> String {
    match r {
        Ok(e) => panic!("expected a refusal, got {}", e.result),
        Err(e) => e.code,
    }
}

// ---- setParam -------------------------------------------------------------------------------------

#[test]
fn set_param_stores_literals_and_canonical_expressions_and_reports_values() {
    let text = repo("corpus/v1/programs/params_plate.json");
    let e = set_param(&text, "thick", &json!(10)).expect("ok");
    assert!(e.changed);
    assert_eq!(e.result["previous"], json!(8.0));
    // The value as stored in the canonical document (a JSON number: `10.0`).
    assert_eq!(e.result["value"], json!(10.0));
    let thick = e.result["params"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "thick")
        .unwrap();
    assert_eq!(thick["value"], json!(10.0));
    // An expression is stored in canonical form; a plain literal string as a JSON literal.
    let e = set_param(&text, "thick", &json!("width/10-0")).expect("ok");
    assert_eq!(e.result["value"], json!("width / 10 - 0"));
    let e = set_param(&text, "thick", &json!("8.50")).expect("ok");
    assert_eq!(e.result["value"], json!(8.5));
    let e = set_param(&text, "width", &json!("-0")).expect("ok");
    assert_eq!(e.result["value"], json!(0.0));
    // …which is then range-checked as a literal (min 2): refused, never stored.
    let r = set_param(&text, "thick", &json!("1"));
    assert_eq!(code(r), "PARAM_OUT_OF_RANGE");
    // The inverse (the previous value) restores the canonical document byte for byte.
    let e = set_param(&text, "width", &json!("depth * 2")).expect("ok");
    let back = set_param(&e.document, "width", &e.result["previous"]).expect("ok");
    assert_eq!(back.document, canon(&text));
    // Setting the same value again changes nothing (idempotent).
    let again = set_param(&e.document, "width", &json!("depth*2")).expect("ok");
    assert!(!again.changed);
    assert_eq!(again.document, e.document);
}

#[test]
fn set_param_refuses_invalid_values_with_the_documents_rejection() {
    let text = repo("corpus/v1/programs/params_plate.json");
    assert_eq!(
        code(set_param(&text, "nope", &json!(1))),
        "COMMAND_UNKNOWN_PARAM"
    );
    assert_eq!(
        code(set_param(&text, "thick", &json!(null))),
        "COMMAND_INVALID_ARGUMENT"
    );
    assert_eq!(
        code(set_param(&text, "thick", &json!([1]))),
        "COMMAND_INVALID_ARGUMENT"
    );
    assert_eq!(
        code(set_param(&text, "thick", &json!("nope * 2"))),
        "EXPR_UNKNOWN_NAME"
    );
    assert_eq!(
        code(set_param(&text, "thick", &json!("3 deg"))),
        "EXPR_UNIT_MISMATCH"
    );
    assert_eq!(
        code(set_param(&text, "thick", &json!("2 +"))),
        "EXPR_SYNTAX"
    );
    assert_eq!(
        code(set_param(&text, "thick", &json!(true))),
        "EXPR_TYPE_MISMATCH"
    );
    let r = set_param(&text, "width", &json!("thick + width"));
    let e = r.expect_err("a cycle");
    assert_eq!(e.code, "PARAM_CYCLE");
    assert_eq!(e.errors[0]["path"], "/params/0/value");
    // An invalid name is never echoed.
    let e = set_param(&text, "a b\n{", &json!(1)).expect_err("unknown");
    assert!(!e.message.contains("a b"), "{}", e.message);
    assert_eq!(e.details["name"], Value::Null);
}

// ---- renameFeature --------------------------------------------------------------------------------

#[test]
fn rename_feature_changes_the_name_only_and_is_undone_by_its_inverse() {
    let text = capture_all(plate());
    let e = rename_feature(&text, "e1", "plate").expect("ok");
    assert!(e.changed);
    assert_eq!(e.result["previous"], "slab");
    // References use ids: every reference still resolves exactly, the geometry is unchanged.
    let (a, b) = (report(&text), report(&e.document));
    assert_eq!(statuses(&a), statuses(&b));
    assert_eq!(a.parts, b.parts);
    let back = rename_feature(&e.document, "e1", "slab").expect("ok");
    assert_eq!(back.document, canon(&text));
    assert!(!rename_feature(&text, "e1", "slab").unwrap().changed);
    assert_eq!(code(rename_feature(&text, "e1", "base")), "DUPLICATE_NAME");
    assert_eq!(code(rename_feature(&text, "e1", "t")), "DUPLICATE_NAME");
    assert_eq!(code(rename_feature(&text, "e1", "1x")), "INVALID_NAME");
    assert_eq!(
        code(rename_feature(&text, "nope", "x")),
        "COMMAND_UNKNOWN_FEATURE"
    );
}

// ---- upgradeFeature -------------------------------------------------------------------------------

#[test]
fn upgrade_feature_to_the_current_version_is_a_no_op_and_unknown_versions_are_refused() {
    let text = plate();
    let e = upgrade_feature(&text, "e1", None).expect("ok");
    assert!(!e.changed);
    assert_eq!(e.result["from"], 1);
    assert_eq!(e.result["to"], 1);
    assert_eq!(e.result["diff"], json!([]));
    // v2 is not defined by the contract: the engine's rejection, at the feature's `v`.
    let r = upgrade_feature(&text, "e1", Some(2)).expect_err("undefined");
    assert_eq!(r.code, "UNSUPPORTED_FEATURE_VERSION");
    assert_eq!(r.errors[0]["path"], "/parts/0/features/1/v");
    assert_eq!(
        code(upgrade_feature(&text, "e1", Some(0))),
        "COMMAND_NOT_AN_UPGRADE"
    );
    assert_eq!(
        code(upgrade_feature(&text, "zz", None)),
        "COMMAND_UNKNOWN_FEATURE"
    );
}

#[test]
fn report_diff_lists_changed_feature_entries() {
    let a = report(&plate());
    let b = report(&set_param(&plate(), "t", &json!(7)).unwrap().document);
    let d = report_diff(&a, &b);
    let ids: Vec<&str> = d.iter().filter_map(|x| x["feature_id"].as_str()).collect();
    assert!(ids.contains(&"e1"), "{ids:?}");
    assert!(!ids.contains(&"s1"), "the sketch did not change: {ids:?}");
    assert!(report_diff(&a, &a).is_empty());
}

// ---- captureRef -----------------------------------------------------------------------------------

#[test]
fn capture_ref_records_the_current_resolution_and_is_idempotent() {
    let text = plate();
    let e = capture_ref(&text, "t_edge", "/target").expect("ok");
    assert!(e.changed);
    assert_eq!(e.result["previous"], Value::Null);
    let members = e.result["capture"]["members"].as_array().unwrap();
    assert_eq!(members.len(), 1);
    let key = members[0]["key"].as_str().unwrap();
    assert_eq!(key, "e1/edge:{e1/side:right|e1/side:top}@right.end");
    assert_eq!(members[0]["via"], "named");
    assert_eq!(members[0]["faces"], json!(["e1/side:right", "e1/side:top"]));
    // The captured document resolves the reference exactly, to the captured member.
    let rep = report(&e.document);
    let r = entry(&rep, "t_edge", "/target");
    assert_eq!(r.status, RefStatus::Exact);
    assert_eq!(r.members[0].key, key);
    // Idempotent: capturing again changes nothing.
    let again = capture_ref(&e.document, "t_edge", "/target").expect("ok");
    assert!(!again.changed);
    assert_eq!(again.document, e.document);
    // Everything else of the report is unchanged.
    let before = report(&text);
    assert_eq!(before.parts, rep.parts);
    // Broad sets capture every member, `via: broad`.
    let e = capture_ref(&text, "t_vertical", "/target").expect("ok");
    let ms = e.result["capture"]["members"].as_array().unwrap();
    assert_eq!(ms.len(), 4);
    assert!(ms.iter().all(|m| m["via"] == "broad"));
}

#[test]
fn capture_ref_of_an_empty_any_set_captures_no_members() {
    let text = doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
            { "kind": "circle", "id": "c", "center": [0, 0], "radius": 5 } ] },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 3 },
        tag("t_ref", "face", json!({ "op": "filter", "where": { "type": "cone" },
            "of": { "op": "faces", "of": { "op": "body", "feature": "e1" } } }), json!("any"))
    ]));
    let e = capture_ref(&text, "t_ref", "/target").expect("ok");
    assert_eq!(e.result["capture"], json!({ "members": [] }));
    let rep = report(&e.document);
    assert_eq!(entry(&rep, "t_ref", "/target").status, RefStatus::Exact);
}

#[test]
fn capture_ref_refuses_references_it_cannot_capture() {
    let text = plate();
    // A failing reference (card one on four edges): repair it first; candidates are listed.
    let amb = doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
            line("bottom", [-20.0, -10.0], [20.0, -10.0]),
            line("right", [20.0, -10.0], [20.0, 10.0]),
            line("top", [20.0, 10.0], [-20.0, 10.0]),
            line("left", [-20.0, 10.0], [-20.0, -10.0]) ] },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 5 },
        tag("t_ref", "edge", json!({ "op": "edges", "of": { "op": "side", "feature": "e1", "curve": "top" } }), json!("one"))
    ]));
    let e = capture_ref(&amb, "t_ref", "/target").expect_err("fails");
    assert_eq!(e.code, "COMMAND_REF_FAILED");
    assert_eq!(e.details["code"], "REF_AMBIGUOUS");
    assert_eq!(
        e.details["unresolved"][0]["candidates"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    assert_eq!(
        code(capture_ref(&text, "e1", "/sketch")),
        "COMMAND_NOT_A_REF"
    );
    assert_eq!(
        code(capture_ref(&text, "t_edge", "target")),
        "COMMAND_INVALID_ARGUMENT"
    );
    assert_eq!(
        code(capture_ref(&text, "t_edge", "/nope")),
        "COMMAND_NOT_A_REF"
    );
    assert_eq!(
        code(capture_ref(&text, "zz", "/target")),
        "COMMAND_UNKNOWN_FEATURE"
    );
    // A suppressed feature has no report entry.
    let suppressed = text.replace(
        r#""id":"t_side","name":"t_side""#,
        r#""id":"t_side","name":"t_side","suppressed":true"#,
    );
    assert_ne!(suppressed, text);
    let e = capture_ref(&suppressed, "t_side", "/target").expect_err("suppressed");
    assert_eq!(e.code, "COMMAND_NO_REF_REPORT");
    assert_eq!(e.details["reason"], "suppressed");
    // A feature that fails before its references are resolved.
    let failing = text.replace(r#""distance":"t""#, r#""distance":"t - 10""#);
    assert_ne!(failing, text);
    let with_ref = doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
            line("bottom", [-20.0, -10.0], [20.0, -10.0]),
            line("right", [20.0, -10.0], [20.0, 10.0]),
            line("top", [20.0, 10.0], [-20.0, 10.0]),
            line("left", [-20.0, 10.0], [-20.0, -10.0]) ] },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 5 },
        { "type": "extrude", "id": "e2", "name": "cut", "sketch": "s1", "distance": "t - 10",
          "op": "cut", "targets": { "kind": "body", "q": { "op": "body", "feature": "e1" } } }
    ]));
    let e = capture_ref(&with_ref, "e2", "/targets").expect_err("failed");
    assert_eq!(e.code, "COMMAND_NO_REF_REPORT");
    assert_eq!(e.details["reason"], "failed");
    assert_eq!(e.details["code"], "INVALID_DISTANCE");
}

// ---- acceptRefProposal ----------------------------------------------------------------------------

/// A plate whose sketch gains a fifth side after `t_vertical` was captured: the broad set
/// changed (`REF_SET_CHANGED`, with a proposal).
fn plate_with_notch(captured: &str) -> String {
    let mut v: Value = forge_ir::v1::json::parse(captured).unwrap();
    v["parts"][0]["features"][0]["curves"] = json!([
        line("bottom", [-20.0, -10.0], [20.0, -10.0]),
        line("right", [20.0, -10.0], [20.0, 10.0]),
        line("top", [20.0, 10.0], [0.0, 10.0]),
        line("notch", [0.0, 10.0], [-20.0, 5.0]),
        line("left", [-20.0, 5.0], [-20.0, -10.0])
    ]);
    v.to_string()
}

#[test]
fn accept_ref_proposal_applies_the_set_change_and_the_reference_is_exact_again() {
    let captured = capture_all(plate());
    let changed = plate_with_notch(&captured);
    let rep = report(&changed);
    let r = entry(&rep, "t_vertical", "/target");
    assert_eq!(r.status, RefStatus::Accepted);
    assert!(r.proposal.is_some());
    // Four vertical edges became five: the one at the old top-left corner is gone, two are new.
    assert_eq!(
        (r.added.len(), r.removed.len()),
        (2, 1),
        "{:?} {:?}",
        r.added,
        r.removed
    );
    let e = accept_ref_proposal(&changed, "t_vertical", "/target").expect("ok");
    assert_eq!(e.result["code"], "REF_SET_CHANGED");
    let rep2 = report(&e.document);
    let r2 = entry(&rep2, "t_vertical", "/target");
    assert_eq!(r2.status, RefStatus::Exact);
    assert_eq!(r2.members.len(), 5);
    // The previous Ref is returned for the inverse, and nothing else changed.
    let mut undo: Value = forge_ir::v1::json::parse(&e.document).unwrap();
    let (pi, fi) = feature_index(&load(&e.document).unwrap(), "t_vertical").unwrap();
    undo["parts"][pi]["features"][fi]["target"] = e.result["previous"].clone();
    assert_eq!(canon(&undo.to_string()), canon(&changed));
    // Without a proposal the op is refused.
    let e = accept_ref_proposal(&captured, "t_vertical", "/target").expect_err("exact");
    assert_eq!(e.code, "COMMAND_NO_PROPOSAL");
    assert_eq!(e.details["status"], "exact");
}

/// Rename sketch curve `old` of `text` to `new` by hand — the sketch's id and the query fields
/// naming it, **not** the capture keys (what an editor without renameCurve would do).
fn rename_by_hand(text: &str, old: &str, new: &str) -> String {
    fn walk(v: &mut Value, old: &str, new: &str) {
        match v {
            Value::Object(o) => {
                for (k, x) in o.iter_mut() {
                    if k == "capture" {
                        continue;
                    }
                    if (k == "id" || k == "curve") && *x == json!(old) {
                        *x = json!(new);
                    } else {
                        walk(x, old, new);
                    }
                }
            }
            Value::Array(a) => a.iter_mut().for_each(|x| walk(x, old, new)),
            _ => {}
        }
    }
    let mut v: Value = forge_ir::v1::json::parse(text).unwrap();
    walk(&mut v, old, new);
    v.to_string()
}

/// A junction edge captured under `@right.end`; then curve `right` is renamed by hand, so the
/// captured key is gone and the resolver repairs the member geometrically (`REF_REPAIRED`,
/// with a proposal). renameCurve would have rewritten the capture instead.
#[test]
fn accept_ref_proposal_applies_a_geometric_repair() {
    let captured = capture_all(plate());
    let moved = rename_by_hand(&captured, "right", "a_right");
    let rep = report(&moved);
    let r = entry(&rep, "t_edge", "/target");
    assert_ne!(r.status, RefStatus::Failed, "{r:?}");
    assert!(r.proposal.is_some(), "{r:?}");
    let e = accept_ref_proposal(&moved, "t_edge", "/target").expect("ok");
    assert_eq!(e.result["code"], "REF_REPAIRED");
    let rep2 = report(&e.document);
    assert_eq!(entry(&rep2, "t_edge", "/target").status, RefStatus::Exact);
    // renameCurve keeps the reference exact without any repair.
    let direct = rename_curve(&captured, "s1", "right", "a_right").expect("ok");
    let rep3 = report(&direct.document);
    assert_eq!(entry(&rep3, "t_edge", "/target").status, RefStatus::Exact);
}

// ---- acceptRefCandidate ---------------------------------------------------------------------------

fn ambiguous() -> String {
    doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
            line("bottom", [-20.0, -10.0], [20.0, -10.0]),
            line("right", [20.0, -10.0], [20.0, 10.0]),
            line("top", [20.0, 10.0], [-20.0, 10.0]),
            line("left", [-20.0, 10.0], [-20.0, -10.0]) ] },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 5 },
        tag("t_ref", "edge", json!({ "op": "edges", "of": { "op": "side", "feature": "e1", "curve": "top" } }), json!("one"))
    ]))
}

#[test]
fn accept_ref_candidate_replaces_the_query_and_captures_exactly_the_candidate() {
    let text = ambiguous();
    let rep = report(&text);
    let r = entry(&rep, "t_ref", "/target");
    assert_eq!(r.code.as_deref(), Some("REF_AMBIGUOUS"));
    let cands = &r.unresolved[0].candidates;
    assert_eq!(r.unresolved[0].key, "");
    for (i, c) in cands.iter().enumerate() {
        assert!(c.query.is_some(), "candidate {i} has a query");
        let e = accept_ref_candidate(&text, "t_ref", "/target", "", &c.key, None, None)
            .unwrap_or_else(|e| panic!("candidate {i}: {e:?}"));
        let rep2 = report(&e.document);
        let r2 = entry(&rep2, "t_ref", "/target");
        assert_eq!(r2.status, RefStatus::Exact);
        assert_eq!(r2.members.len(), 1);
        assert_eq!(r2.members[0].key, c.key);
        assert_eq!(r2.members[0].probe, c.probe);
        assert_eq!(
            e.result["ref"]["capture"]["members"][0]["key"],
            json!(c.key)
        );
        // The previous Ref restores the document.
        let mut undo: Value = forge_ir::v1::json::parse(&e.document).unwrap();
        undo["parts"][0]["features"][2]["target"] = e.result["previous"].clone();
        assert_eq!(canon(&undo.to_string()), canon(&text));
    }
}

#[test]
fn accept_ref_candidate_refuses_unknown_ambiguous_and_partial_choices() {
    let text = ambiguous();
    let rep = report(&text);
    let c0 = entry(&rep, "t_ref", "/target").unresolved[0].candidates[0].clone();
    assert_eq!(
        code(accept_ref_candidate(
            &text,
            "t_ref",
            "/target",
            "e1/side:top",
            &c0.key,
            None,
            None
        )),
        "COMMAND_UNKNOWN_MEMBER"
    );
    assert_eq!(
        code(accept_ref_candidate(
            &text,
            "t_ref",
            "/target",
            "",
            "e1/side:nope",
            None,
            None
        )),
        "COMMAND_UNKNOWN_CANDIDATE"
    );
    assert_eq!(
        code(accept_ref_candidate(
            &text,
            "t_ref",
            "/target",
            "",
            &c0.key,
            Some(3),
            None
        )),
        "COMMAND_UNKNOWN_CANDIDATE"
    );
    assert!(accept_ref_candidate(&text, "t_ref", "/target", "", &c0.key, Some(0), None).is_ok());
    // A reference with another member: accepting a candidate for one member would drop it.
    let text = doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
            line("bottom", [-20.0, -10.0], [20.0, -10.0]),
            line("right", [20.0, -10.0], [20.0, 10.0]),
            line("top", [20.0, 10.0], [-20.0, 10.0]),
            line("left", [-20.0, 10.0], [-20.0, -10.0]) ] },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 5 },
        tag("t_ref", "edge", json!({ "op": "union", "of": [
            { "op": "edge_at", "feature": "e1", "curve": "right", "end": "end" },
            { "op": "edge_at", "feature": "e1", "curve": "left", "end": "end" } ] }), json!("some"))
    ]));
    let captured = capture_all(text);
    // `right` renamed by hand and moved: its junction edge is neither found nor identical.
    let moved = rename_by_hand(&captured, "right", "a_right")
        .replace("[20.0,-10.0]", "[20.25,-10.0]")
        .replace("[20.0,10.0]", "[20.25,10.0]");
    let rep = report(&moved);
    let r = entry(&rep, "t_ref", "/target");
    assert_eq!(r.status, RefStatus::Failed, "{r:?}");
    let u = &r.unresolved[0];
    assert!(!u.candidates.is_empty(), "{r:?}");
    let e = accept_ref_candidate(
        &moved,
        "t_ref",
        "/target",
        &u.key,
        &u.candidates[0].key,
        Some(0),
        None,
    )
    .expect_err("partial");
    assert_eq!(e.code, "COMMAND_CANDIDATE_PARTIAL", "{e:?}");
    let others = e.details["members"].as_array().unwrap();
    assert!(
        others
            .iter()
            .any(|k| k.as_str().unwrap().contains("side:left")),
        "{e:?}"
    );
}

// ---- renameCurve ----------------------------------------------------------------------------------

#[test]
fn rename_curve_rewrites_queries_captures_and_constraints_and_keeps_references_exact() {
    let text = capture_all(plate());
    for (old, new) in [
        ("top", "a_top"),
        ("right", "zz"),
        ("left", "bottom2"),
        ("bottom", "a"),
    ] {
        let e = rename_curve(&text, "s1", old, new).unwrap_or_else(|e| panic!("{old}: {e:?}"));
        assert!(e.changed);
        let rep = report(&e.document);
        for (f, field, s) in statuses(&rep) {
            assert_eq!(s, RefStatus::Exact, "{old} → {new}: {f}{field}");
        }
        // No trace of the old id in any query, region or capture key.
        let v: Value = forge_ir::v1::json::parse(&e.document).unwrap();
        let s = v.to_string();
        assert!(!s.contains(&format!("side:{old}")), "{old}: {s}");
        assert!(!s.contains(&format!("\"curve\":\"{old}\"")), "{old}: {s}");
        // Renaming back restores the document byte for byte (the inverse op).
        let back = rename_curve(&e.document, "s1", new, old).expect("back");
        assert_eq!(back.document, canon(&text), "{old} → {new} → {old}");
    }
    let e = rename_curve(&text, "s1", "top", "a_top").unwrap();
    assert!(e.result["rewritten"]["capture_keys"].as_u64().unwrap() >= 5);
    assert_eq!(e.result["rewritten"]["curves"], 1);
    assert!(!rename_curve(&text, "s1", "top", "top").unwrap().changed);
}

#[test]
fn rename_curve_refuses_unknown_and_invalid_ids() {
    let text = plate();
    assert_eq!(
        code(rename_curve(&text, "s9", "top", "x")),
        "COMMAND_UNKNOWN_FEATURE"
    );
    assert_eq!(
        code(rename_curve(&text, "e1", "top", "x")),
        "COMMAND_UNKNOWN_SKETCH"
    );
    assert_eq!(
        code(rename_curve(&text, "s1", "nope", "x")),
        "COMMAND_UNKNOWN_CURVE"
    );
    assert_eq!(
        code(rename_curve(&text, "s1", "top", "right")),
        "DUPLICATE_ID"
    );
    assert_eq!(code(rename_curve(&text, "s1", "top", "a.b")), "INVALID_ID");
    let e = rename_curve(&text, "s1", "top", "x y").expect_err("invalid");
    assert_eq!(e.code, "INVALID_ID");
    assert!(!e.message.contains("x y"));
}

#[test]
fn rename_curve_follows_compound_members_and_constraint_arguments() {
    // A compound rect: its members are named `outline.<member>`.
    let text = capture_all(doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
            { "kind": "rect", "id": "outline", "center": [0, 0], "w": "w", "h": 20, "r": 3 } ] },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "regions": ["outline.top"], "distance": "t" },
        tag("t1", "face", json!({ "op": "side", "feature": "e1", "curve": "outline.c_tr" }), json!("one")),
        tag("t2", "edge", json!({ "op": "edge_at", "feature": "e1", "curve": "outline.top", "end": "start" }), json!("one")),
        tag("t3", "face", json!({ "op": "cap", "feature": "e1", "end": "end", "member": "outline.bottom" }), json!("one"))
    ])));
    let e = rename_curve(&text, "s1", "outline", "frame").expect("ok");
    let s = e.document.clone();
    assert!(
        s.contains("\"frame.c_tr\"") && s.contains("\"frame.top\""),
        "{s}"
    );
    assert!(!s.contains("outline"), "{s}");
    let rep = report(&e.document);
    assert!(statuses(&rep).iter().all(|x| x.2 == RefStatus::Exact));
    assert_eq!(
        rename_curve(&e.document, "s1", "frame", "outline")
            .unwrap()
            .document,
        canon(&text)
    );
    // A constrained sketch: constraint arguments (`bottom.start`) follow, and write-back stays
    // idempotent on the renamed document.
    let text = repo("corpus/v1/programs/constrained_plate.json");
    let e = rename_curve(&text, "s1", "bottom", "base_line").expect("ok");
    assert!(e.document.contains("\"base_line.start\""));
    assert!(e.document.contains("\"base_line\""));
    assert_eq!(e.result["rewritten"]["constraints"], 3);
    assert_eq!(e.result["rewritten"]["regions"], 1);
    let wb = engine::write_back(&e.document, None).expect("ok");
    assert_eq!(
        engine::write_back(&wb.document, None).unwrap().document,
        wb.document
    );
    let e = rename_curve(&text, "s1", "diag", "d2").expect("construction curves too");
    assert!(e.document.contains("\"d2.start\""));
}

// ---- transactions: write-back + capture as one step --------------------------------------------

#[test]
fn write_back_and_capture_are_idempotent_at_the_op_level() {
    let text = repo("corpus/v1/programs/constrained_plate.json");
    let mut v: Value = forge_ir::v1::json::parse(&text).unwrap();
    v["parts"][0]["features"].as_array_mut().unwrap().push(tag(
        "t_ref",
        "face",
        json!({ "op": "side", "feature": "e1", "curve": "top" }),
        json!("one"),
    ));
    let text = v.to_string();
    let a = engine::write_back(&text, None).unwrap().document;
    let b = capture_ref(&a, "t_ref", "/target").unwrap().document;
    // Each op again is a no-op; so is the pair.
    assert_eq!(engine::write_back(&b, None).unwrap().document, b);
    assert!(!capture_ref(&b, "t_ref", "/target").unwrap().changed);
}

// ---- the renameCurve property -----------------------------------------------------------------------

const NAMES: [&str; 16] = [
    "a", "b", "bottom", "c_1", "edge", "l0", "left", "m", "q9", "right", "rim", "s", "top", "x",
    "y_", "zz",
];

/// The base profile of a generated part (sketch `s1`).
#[derive(Clone, Debug)]
enum Profile {
    /// A regular polygon of lines on XY; `constrained`: coincident ends and driving side lengths.
    Polygon {
        names: Vec<String>,
        c: [f64; 2],
        rad: f64,
        rot: f64,
        constrained: bool,
    },
    /// A `rect` compound on XY (members `<id>.bottom`, …; corners when `r > 0`).
    Rect {
        name: String,
        w: f64,
        h: f64,
        r: f64,
    },
    /// A "D" on XY: a line and an arc.
    D { line: String, arc: String, r: f64 },
    /// A polygon on XZ, revolved 270° (end caps `endcap`).
    Revolved {
        names: Vec<String>,
        c: [f64; 2],
        rad: f64,
        rot: f64,
    },
}

/// A body operation after the base extrude: a small box through the base at one of its
/// corners, cutting a notch or joining a bump (sketch `s3`, curves `ta`…`td`, extrude `e3`).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Tool {
    Cut,
    Join,
}

/// A generated document (see [`gen_doc`]).
#[derive(Clone, Debug)]
struct Spec {
    profile: Profile,
    distance: f64,
    /// Extruded profiles only.
    tool: Option<Tool>,
    /// A boss sketched on the end cap (`s2`/`e2`: its plane Ref's capture keys carry the cap's
    /// body member, `e1/cap:end@m`). Extruded profiles only.
    boss: bool,
    /// Two through holes on the points of sketch `s4` (on the end cap), `h1`. Extruded only.
    holes: Option<Vec<String>>,
    /// A linear pattern `pt` of `e1` (two new bodies). Extruded only.
    pattern: bool,
    /// Which profile member each tag names.
    picks: Vec<usize>,
    end_start: bool,
}

/// The id generated for curve `id` of sketch `sketch` (the renaming oracle's hook).
type Rn<'a> = &'a dyn Fn(&str, &str) -> String;

/// Multiples of 1/8 in `[lo, hi)`: exact, so the documents stay readable.
#[cfg(not(target_family = "wasm"))]
fn eighths(lo: f64, hi: f64) -> impl Strategy<Value = f64> {
    ((lo * 8.0) as i64..(hi * 8.0) as i64).prop_map(|k| k as f64 / 8.0)
}

/// `n` distinct ids from [`NAMES`], in random order.
#[cfg(not(target_family = "wasm"))]
fn names(n: usize) -> impl Strategy<Value = Vec<String>> {
    proptest::sample::subsequence(NAMES.to_vec(), n)
        .prop_shuffle()
        .prop_map(|v| v.into_iter().map(String::from).collect())
}

#[cfg(not(target_family = "wasm"))]
fn profile() -> impl Strategy<Value = Profile> {
    prop_oneof![
        (3usize..7)
            .prop_flat_map(|n| (
                names(n),
                eighths(-5.0, 5.0),
                eighths(-5.0, 5.0),
                eighths(6.0, 12.0),
                eighths(0.0, 45.0),
                any::<bool>()
            ))
            .prop_map(|(names, cx, cy, rad, rot, constrained)| Profile::Polygon {
                names,
                c: [cx, cy],
                rad,
                rot,
                constrained
            }),
        (
            names(1),
            eighths(10.0, 40.0),
            eighths(10.0, 30.0),
            eighths(0.0, 4.0)
        )
            .prop_map(|(n, w, h, r)| Profile::Rect {
                name: n[0].clone(),
                w,
                h,
                r
            }),
        (names(2), eighths(5.0, 15.0)).prop_map(|(n, r)| Profile::D {
            line: n[0].clone(),
            arc: n[1].clone(),
            r
        }),
        (3usize..7)
            .prop_flat_map(|n| (
                names(n),
                eighths(20.0, 30.0),
                eighths(-5.0, 5.0),
                eighths(6.0, 12.0),
                eighths(0.0, 45.0)
            ))
            .prop_map(|(names, cx, cy, rad, rot)| Profile::Revolved {
                names,
                c: [cx, cy],
                rad,
                rot
            }),
    ]
}

#[cfg(not(target_family = "wasm"))]
fn spec() -> impl Strategy<Value = Spec> {
    (
        profile(),
        eighths(2.0, 9.0),
        proptest::option::of(prop_oneof![Just(Tool::Cut), Just(Tool::Join)]),
        any::<bool>(),
        proptest::option::of(names(2)),
        any::<bool>(),
        proptest::collection::vec(0usize..64, 8),
        any::<bool>(),
    )
        .prop_map(
            |(profile, distance, tool, boss, holes, pattern, picks, end_start)| {
                let extruded = !matches!(profile, Profile::Revolved { .. });
                Spec {
                    profile,
                    distance,
                    tool: tool.filter(|_| extruded),
                    boss: boss && extruded,
                    holes: holes.filter(|_| extruded),
                    pattern: pattern && extruded,
                    picks,
                    end_start,
                }
            },
        )
}

/// The vertices of a regular polygon.
fn polygon(c: [f64; 2], rad: f64, rot: f64, n: usize) -> Vec<[f64; 2]> {
    let rot = rot.to_radians();
    (0..n)
        .map(|k| {
            let a = rot + std::f64::consts::TAU * k as f64 / n as f64;
            [c[0] + rad * a.cos(), c[1] + rad * a.sin()]
        })
        .collect()
}

/// The generated document of `spec`: a part (see [`Profile`]) extruded or revolved, with the
/// optional tool, boss, holes and pattern, and tags on every kind of entity (faces, junction
/// and intersection edges, vertices, bodies by member, hole faces, pattern copies). Every id of
/// a sketch curve goes through `rn`, so the same spec with a renaming `rn` is the document an
/// author would have written with the new name — the independent oracle of the renameCurve
/// property. Returns the document and the `(sketch, curve)` pairs the property renames.
fn gen_doc(spec: &Spec, rn: Rn) -> (String, Vec<(String, String)>) {
    let s1 = |id: &str| rn("s1", id);
    let mut curves = Vec::new();
    let mut constraints = Vec::new();
    let declared: Vec<String>;
    let members: Vec<String>;
    let (center, corner, plane): ([f64; 2], [f64; 2], &str);
    match &spec.profile {
        Profile::Polygon {
            names,
            c,
            rad,
            rot,
            constrained,
        } => {
            let n = names.len();
            let pts = polygon(*c, *rad, *rot, n);
            for k in 0..n {
                curves.push(line(&s1(&names[k]), pts[k], pts[(k + 1) % n]));
            }
            if *constrained {
                for k in 0..n {
                    let (a, b) = (s1(&names[k]), s1(&names[(k + 1) % n]));
                    let (p, q) = (pts[k], pts[(k + 1) % n]);
                    let len = ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt();
                    constraints.push(json!({ "type": "coincident", "id": format!("k{k}"),
                        "a": format!("{a}.end"), "b": format!("{b}.start") }));
                    constraints.push(json!({ "type": "distance", "id": format!("d{k}"),
                        "a": format!("{a}.start"), "b": format!("{a}.end"), "value": len }));
                }
            }
            declared = names.clone();
            members = names.iter().map(|x| s1(x)).collect();
            (center, corner, plane) = (*c, pts[0], "XY");
        }
        Profile::Revolved { names, c, rad, rot } => {
            let n = names.len();
            let pts = polygon(*c, *rad, *rot, n);
            for k in 0..n {
                curves.push(line(&s1(&names[k]), pts[k], pts[(k + 1) % n]));
            }
            declared = names.clone();
            members = names.iter().map(|x| s1(x)).collect();
            (center, corner, plane) = (*c, pts[0], "XZ");
        }
        Profile::Rect { name, w, h, r } => {
            curves.push(json!({ "kind": "rect", "id": s1(name), "center": [0, 0],
                "w": w, "h": h, "r": r }));
            declared = vec![name.clone()];
            let corners = *r > 0.0;
            members = [
                "bottom", "c_br", "right", "c_tr", "top", "c_tl", "left", "c_bl",
            ]
            .iter()
            .filter(|m| corners || !m.starts_with("c_"))
            .map(|m| format!("{}.{m}", s1(name)))
            .collect();
            (center, corner, plane) = ([0.0, 0.0], [w / 2.0, 0.0], "XY");
        }
        Profile::D { line: l, arc, r } => {
            curves.push(line(&s1(l), [-r, 0.0], [*r, 0.0]));
            curves.push(json!({ "kind": "arc", "id": s1(arc), "start": [r, 0.0],
                "end": [-r, 0.0], "center": [0, 0], "ccw": true }));
            declared = vec![l.clone(), arc.clone()];
            members = vec![s1(l), s1(arc)];
            (center, corner, plane) = ([0.0, r / 2.0], [*r, 0.0], "XY");
        }
    }
    let revolve = plane == "XZ";
    let mut renamed: Vec<(String, String)> = declared
        .iter()
        .map(|c| ("s1".to_string(), c.clone()))
        .collect();
    let mut sketch = json!({ "type": "sketch", "id": "s1", "name": "base", "plane": plane,
        "curves": curves });
    if !constraints.is_empty() {
        sketch["constraints"] = Value::Array(constraints);
    }
    let mut features = vec![sketch];
    let cap_end = || {
        json!({ "face": { "kind": "face",
        "q": { "op": "cap", "feature": "e1", "end": "end" } } })
    };
    if revolve {
        features.push(
            json!({ "type": "revolve", "id": "e1", "name": "body1", "sketch": "s1",
            "axis": { "origin": [0, 0], "direction": [0, 1] }, "angle": 270 }),
        );
    } else {
        features.push(
            json!({ "type": "extrude", "id": "e1", "name": "body1", "sketch": "s1",
            "distance": spec.distance }),
        );
    }
    let pick = |i: usize| members[spec.picks[i] % members.len()].clone();
    if let Some(tool) = spec.tool {
        let ids: Vec<String> = ["ta", "tb", "tc", "td"]
            .iter()
            .map(|t| rn("s3", t))
            .collect();
        let h = 1.5;
        features.push(
            json!({ "type": "sketch", "id": "s3", "name": "tool_sk", "plane": "XY",
            "curves": rect([ids[0].as_str(), ids[1].as_str(), ids[2].as_str(), ids[3].as_str()],
                           corner[0] - h, corner[1] - h, corner[0] + h, corner[1] + h) }),
        );
        // Symmetric and taller than the base: no face of the tool is coplanar with a cap.
        features.push(
            json!({ "type": "extrude", "id": "e3", "name": "tool", "sketch": "s3",
            "distance": 2.0 * (spec.distance + 2.0), "direction": "symmetric",
            "op": if tool == Tool::Cut { "cut" } else { "join" },
            "targets": { "kind": "body", "q": { "op": "body", "feature": "e1" } } }),
        );
        renamed.push((
            "s3".into(),
            ["ta", "tb", "tc", "td"][spec.picks[6] % 4].into(),
        ));
    }
    if spec.boss {
        features.push(json!({ "type": "sketch", "id": "s2", "name": "boss_sk",
            "plane": cap_end(),
            "curves": [{ "kind": "circle", "id": "k", "center": center, "radius": 1 }] }));
        features.push(json!({ "type": "extrude", "id": "e2", "name": "boss",
            "sketch": "s2", "distance": 2 }));
    }
    let mut tags = Vec::new();
    if let Some(points) = &spec.holes {
        let at: [[f64; 2]; 2] = match &spec.profile {
            Profile::Polygon { rad, .. } => [
                [center[0], center[1] + 0.35 * rad],
                [center[0], center[1] - 0.35 * rad],
            ],
            Profile::Rect { h, .. } => [[0.0, h / 4.0], [0.0, -h / 4.0]],
            Profile::D { r, .. } => [[-0.4 * r, 0.25 * r], [0.4 * r, 0.25 * r]],
            Profile::Revolved { .. } => unreachable!("holes on extruded profiles only"),
        };
        let ids: Vec<String> = points.iter().map(|p| rn("s4", p)).collect();
        features.push(
            json!({ "type": "sketch", "id": "s4", "name": "marks", "plane": cap_end(),
            "curves": [{ "kind": "point", "id": ids[0], "at": at[0] },
                       { "kind": "point", "id": ids[1], "at": at[1] }] }),
        );
        features.push(
            json!({ "type": "hole", "id": "h1", "name": "holes", "on": cap_end(),
            "at": { "points": { "sketch": "s4", "ids": ids } }, "d": 1, "depth": "through" }),
        );
        tags.push(tag(
            "t_wall",
            "face",
            json!({ "op": "hole_face", "feature": "h1", "at": ids[0], "part": "wall" }),
            json!("one"),
        ));
        tags.push(tag(
            "t_rims",
            "edge",
            json!({ "op": "edges", "of": { "op": "hole_face", "feature": "h1",
                "at": ids[1], "part": "wall" } }),
            json!("some"),
        ));
        renamed.extend(points.iter().map(|p| ("s4".to_string(), p.clone())));
    }
    if spec.pattern {
        features.push(json!({ "type": "pattern", "id": "pt", "name": "row",
            "seed": { "features": ["e1"] },
            "layout": { "linear": { "dir": "X", "count": 2, "spacing": 60 } } }));
        tags.push(tag(
            "t_row",
            "body",
            json!({ "op": "body", "feature": "pt" }),
            json!("some"),
        ));
        tags.push(tag(
            "t_copy",
            "face",
            json!({ "op": "filter", "where": { "normal": "+Z" },
                "of": { "op": "instance", "feature": "pt", "index": [1] } }),
            json!("some"),
        ));
    }
    if spec.tool.is_some() {
        tags.push(tag(
            "t_tool",
            "face",
            json!({ "op": "created", "feature": "e3" }),
            json!("some"),
        ));
    }
    let (cap, end_a, end_b) = if revolve {
        ("endcap", "start", "end")
    } else {
        ("cap", "start", "end")
    };
    tags.extend([
        tag(
            "t_side",
            "face",
            json!({ "op": "side", "feature": "e1", "curve": pick(0) }),
            json!("some"),
        ),
        tag(
            "t_cap",
            "face",
            json!({ "op": cap, "feature": "e1", "end": end_b, "member": pick(1) }),
            json!("any"),
        ),
        tag(
            "t_body",
            "body",
            json!({ "op": "body", "feature": "e1", "member": pick(2) }),
            json!("any"),
        ),
        tag(
            "t_between",
            "edge",
            json!({ "op": "between",
                "a": { "op": "side", "feature": "e1", "curve": pick(3) },
                "b": { "op": cap, "feature": "e1", "end": end_a } }),
            json!("any"),
        ),
        tag(
            "t_sides",
            "edge",
            json!({ "op": "edges", "of": { "op": "sides", "feature": "e1" } }),
            json!("some"),
        ),
        tag(
            "t_vertices",
            "vertex",
            json!({ "op": "vertices", "of": { "op": "side", "feature": "e1", "curve": pick(4) } }),
            json!("any"),
        ),
        tag("t_bodies", "body", json!({ "op": "bodies" }), json!("some")),
        tag(
            "t_edge_at",
            "edge",
            json!({ "op": "edge_at", "feature": "e1", "curve": pick(5),
                "end": if spec.end_start { "start" } else { "end" } }),
            json!("any"),
        ),
    ]);
    features.extend(tags);
    (doc(Value::Array(features)), renamed)
}

/// Drop the features whose references fail on this shape (e.g. a `between` of faces that do
/// not meet), and the features consuming a dropped sketch; then capture every reference with
/// the resolver's own capture, in one evaluation: every Ref gets an empty capture, so its whole
/// current result is "added since the capture" and its `proposal` carries the fresh capture
/// (forge-refs' `capture`, §5.8). Independent of the command layer's code (neither
/// `captureRef` nor `renameCurve` is involved), and canonical text.
fn prepare(text: &str, failing: &[String]) -> String {
    let mut v: Value = forge_ir::v1::json::parse(text).unwrap();
    v["parts"][0]["features"]
        .as_array_mut()
        .unwrap()
        .retain(|f| {
            !failing.iter().any(|id| {
                f["id"] == json!(id)
                    || f["sketch"] == json!(id)
                    || f["at"]["points"]["sketch"] == json!(id)
            })
        });
    let refs = statuses(&report(&v.to_string()));
    let pointer = |v: &Value, f: &str, field: &str| {
        let fi = v["parts"][0]["features"]
            .as_array()
            .unwrap()
            .iter()
            .position(|x| x["id"] == json!(f))
            .unwrap();
        format!("/parts/0/features/{fi}{field}")
    };
    for (f, field, _) in &refs {
        let ptr = pointer(&v, f, field);
        v.pointer_mut(&ptr).unwrap()["capture"] = json!({ "members": [] });
    }
    let rep = report(&v.to_string());
    for (f, field, _) in &refs {
        let e = entry(&rep, f, field);
        assert_ne!(e.status, RefStatus::Failed, "{f}{field}");
        let capture = match &e.proposal {
            Some(p) => serde_json::to_value(p.capture.as_ref().unwrap()).unwrap(),
            None => {
                assert!(e.members.is_empty(), "{f}{field}: {e:?}");
                json!({ "members": [] })
            }
        };
        let ptr = pointer(&v, f, field);
        v.pointer_mut(&ptr).unwrap()["capture"] = capture;
    }
    canon(&v.to_string())
}

/// The first difference between two documents: everything exact but the numbers of capture
/// fingerprints (`geom`: centroids, boxes, sizes), which may differ at rounding level where the
/// kernel's accumulation order follows ids (a renamed hole point reorders its faces).
fn document_difference(a: &Value, b: &Value, in_capture: bool, path: &str) -> Option<String> {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            let close = (x - y).abs() <= 1e-9 * x.abs().max(y.abs()).max(1.0);
            (x.to_bits() != y.to_bits() && !(in_capture && close)).then(|| path.to_string())
        }
        (Value::Array(xs), Value::Array(ys)) if xs.len() == ys.len() => {
            xs.iter().zip(ys).enumerate().find_map(|(i, (x, y))| {
                document_difference(x, y, in_capture, &format!("{path}/{i}"))
            })
        }
        (Value::Object(xs), Value::Object(ys))
            if xs.len() == ys.len() && xs.keys().all(|k| ys.contains_key(k)) =>
        {
            xs.iter().find_map(|(k, x)| {
                document_difference(
                    x,
                    &ys[k],
                    in_capture || k == "capture",
                    &format!("{path}/{k}"),
                )
            })
        }
        _ => (a != b).then(|| path.to_string()),
    }
}

/// Counts of what the checked specs covered.
#[derive(Default, Debug)]
struct Coverage {
    renames: usize,
    constrained: usize,
    boss: usize,
    cut: usize,
    join: usize,
    holes: usize,
    point_renames: usize,
    pattern: usize,
}

/// IR-V1 plan W9: "on random documents, renaming any curve leaves every reference `exact` and
/// the report identical except display names" — for one generated document: every curve of
/// the base sketch, every hole point and one tool curve, each renamed.
///
/// The oracle is independent of the op: the same spec generated with the new name (the
/// document an author would have written), captured by the resolver, must be the op's result
/// — queries, regions, hole points, constraint arguments, every capture key (body members,
/// junction qualifiers and pattern copies as the engine computes them) and the canonical member
/// order — byte for byte except the capture fingerprints' numbers at rounding level
/// ([`document_difference`]); the op itself checks the report ([`verify_rename`]). Renaming back
/// restores the document byte for byte.
fn check_rename_property(spec: &Spec, cov: &mut Coverage) {
    let (text0, curves) = gen_doc(spec, &|_, id| id.to_string());
    let rep = report(&text0);
    let failing: Vec<String> = statuses(&rep)
        .into_iter()
        .filter(|s| s.2 == RefStatus::Failed)
        .map(|s| s.0)
        .collect();
    let text = prepare(&text0, &failing);
    let has = |id: &str| text.contains(&format!("\"id\": \"{id}\""));
    cov.constrained += usize::from(text.contains("\"constraints\""));
    cov.boss += usize::from(has("e2"));
    cov.cut += usize::from(has("e3") && text.contains("\"op\": \"cut\""));
    cov.join += usize::from(has("e3") && text.contains("\"op\": \"join\""));
    cov.holes += usize::from(has("h1"));
    cov.pattern += usize::from(has("pt"));
    for (k, (sketch, old)) in curves.iter().enumerate() {
        if !has(sketch) {
            continue;
        }
        let fresh = format!("n{}_{old}", spec.picks[7] + k);
        let e = rename_curve(&text, sketch, old, &fresh)
            .unwrap_or_else(|e| panic!("{sketch}: {old} → {fresh}: {e:?}\n{text}"));
        assert_eq!(
            e.result["unverified"],
            json!([]),
            "{sketch}: {old} → {fresh}"
        );
        let rep = report(&e.document);
        for (f, field, s) in statuses(&rep) {
            assert_eq!(s, RefStatus::Exact, "{sketch}: {old} → {fresh}: {f}{field}");
        }
        let rn = |s: &str, id: &str| {
            if s == sketch && id == old {
                fresh.clone()
            } else {
                id.to_string()
            }
        };
        let oracle = prepare(&gen_doc(spec, &rn).0, &failing);
        let parse = |t: &str| forge_ir::v1::json::parse(t).unwrap();
        if let Some(at) = document_difference(&parse(&e.document), &parse(&oracle), false, "") {
            panic!(
                "{sketch}: {old} → {fresh}: the op's document differs from the document generated \
                 with the new name at {at}\nop: {}\noracle: {oracle}",
                e.document
            );
        }
        let back = rename_curve(&e.document, sketch, &fresh, old).expect("back");
        assert_eq!(back.document, text, "{sketch}: {old} → {fresh} → {old}");
        cov.renames += 1;
        cov.point_renames += usize::from(sketch == "s4");
    }
}

/// The renameCurve property on generated documents (proptest, shrinking a failure to a minimal
/// spec). Documents with booleans, holes and patterns evaluate slowly in debug builds, so a
/// debug run checks 3 cases and a release run 32 (`PROPTEST_CASES` overrides both, e.g. for a
/// soak run); [`renaming_curves_of_covering_documents`] covers every generator branch
/// deterministically.
#[cfg(not(target_family = "wasm"))]
#[test]
fn renaming_any_curve_of_random_documents_keeps_every_reference_exact() {
    let cases = std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(if cfg!(debug_assertions) { 3 } else { 32 });
    let config = proptest::test_runner::Config {
        cases,
        // Next to this file, like the workspace's other `*.proptest-regressions`.
        failure_persistence: Some(Box::new(
            proptest::test_runner::FileFailurePersistence::WithSource("proptest-regressions"),
        )),
        ..proptest::test_runner::Config::default()
    };
    proptest::proptest!(config, |(spec in spec())| {
        let mut cov = Coverage::default();
        check_rename_property(&spec, &mut cov);
    });
}

/// The property on fixed specs covering every generator branch (a constrained polygon, a rect
/// with and without corners, a "D", a revolve; cut and join tools; a boss; holes whose points
/// are renamed; a pattern), so each is checked on every run whatever the random cases draw.
#[test]
fn renaming_curves_of_covering_documents() {
    let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let specs = [
        // The first case the property found (commands_tests.proptest-regressions): hole points
        // with ids of base-sketch curves (`a`, `x`); the verification renamed every sketch's
        // curve ids in its report, not only the renamed sketch's.
        Spec {
            profile: Profile::Polygon {
                names: ids(&["a", "s", "x"]),
                c: [0.0, 0.0],
                rad: 6.0,
                rot: 0.0,
                constrained: false,
            },
            distance: 2.0,
            tool: None,
            boss: false,
            holes: Some(ids(&["a", "x"])),
            pattern: false,
            picks: vec![0; 8],
            end_start: false,
        },
        Spec {
            profile: Profile::Polygon {
                names: ids(&["top", "a", "rim", "x"]),
                c: [1.0, -2.0],
                rad: 9.0,
                rot: 20.0,
                constrained: true,
            },
            distance: 5.0,
            tool: Some(Tool::Cut),
            boss: true,
            holes: Some(ids(&["m", "b"])),
            pattern: true,
            picks: vec![0, 1, 2, 3, 0, 1, 2, 7],
            end_start: true,
        },
        Spec {
            profile: Profile::Rect {
                name: "edge".into(),
                w: 30.0,
                h: 16.0,
                r: 2.5,
            },
            distance: 4.0,
            tool: Some(Tool::Join),
            boss: false,
            holes: Some(ids(&["zz", "a"])),
            pattern: false,
            picks: vec![1, 2, 3, 4, 5, 6, 1, 3],
            end_start: false,
        },
        Spec {
            profile: Profile::Rect {
                name: "s".into(),
                w: 20.0,
                h: 12.0,
                r: 0.0,
            },
            distance: 3.0,
            tool: None,
            boss: true,
            holes: None,
            pattern: true,
            picks: vec![0, 3, 1, 2, 0, 1, 2, 0],
            end_start: true,
        },
        Spec {
            profile: Profile::D {
                line: "left".into(),
                arc: "c_1".into(),
                r: 9.0,
            },
            distance: 6.0,
            tool: Some(Tool::Cut),
            boss: true,
            holes: Some(ids(&["q9", "y_"])),
            pattern: true,
            picks: vec![0, 1, 1, 0, 1, 0, 2, 11],
            end_start: false,
        },
        Spec {
            profile: Profile::Revolved {
                names: ids(&["b", "l0", "zz"]),
                c: [24.0, 1.0],
                rad: 8.0,
                rot: 10.0,
            },
            distance: 4.0,
            tool: None,
            boss: false,
            holes: None,
            pattern: false,
            picks: vec![0, 1, 2, 0, 1, 2, 0, 5],
            end_start: true,
        },
    ];
    let mut cov = Coverage::default();
    for spec in &specs {
        check_rename_property(spec, &mut cov);
    }
    assert!(cov.renames >= 20, "{cov:?}");
    assert!(
        cov.constrained >= 1
            && cov.boss >= 2
            && cov.cut >= 2
            && cov.join >= 1
            && cov.holes >= 3
            && cov.point_renames >= 6
            && cov.pattern >= 3,
        "{cov:?}"
    );
}

#[test]
fn provenance_keys_round_trip_through_the_port() {
    for k in [
        "e1/side:top",
        "e1/cap:end@bottom",
        "e1/edge:{e1/cap:end@bottom|e1/side:bottom}",
        "e1/edge:{e1/side:a|e1/side:b}@a.end",
        "e1/vertex:{e1/edge:{e1/cap:end@a|e1/side:a}|e1/edge:{e1/side:a|e1/side:b}@a.end}@a.end",
        "p1/copy:{e1/side:a}@1.2",
        "h1/wall@c",
        "e1/body:outline.bottom",
        "x/side:a+b",
        "f%2Fx/side:a%40b",
    ] {
        let p = keys::parse(k).unwrap_or_else(|| panic!("{k}"));
        assert_eq!(p.render(), k);
    }
    for bad in [
        "nokey",
        "/side:a",
        "e1/",
        "e1/side:a#1",
        "e1/edge:{a|",
        "e1/side:a@",
    ] {
        assert!(keys::parse(bad).is_none(), "{bad}");
    }
}

// ---- W9 review 2 ----------------------------------------------------------------------------------

/// Lines of an axis-aligned rectangle `[x0, x1] × [y0, y1]`, counter-clockwise from the bottom.
fn rect(ids: [&str; 4], x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<Value> {
    vec![
        line(ids[0], [x0, y0], [x1, y0]),
        line(ids[1], [x1, y0], [x1, y1]),
        line(ids[2], [x1, y1], [x0, y1]),
        line(ids[3], [x0, y1], [x0, y0]),
    ]
}

/// Two plates (tops `t1`, `t2`) and a far one (scale ≈ 1000 mm) extruded together; a tag on
/// both tops, captured; then a cut removes the face of `t1`.
fn two_tops_cut() -> String {
    let mut curves = rect(["a_b", "a_r", "t1", "a_l"], 0.0, 0.0, 10.0, 10.0);
    curves.extend(rect(["b_b", "b_r", "t2", "b_l"], 20.0, 0.0, 30.0, 10.0));
    curves.extend(rect(
        ["c_b", "c_r", "c_t", "c_l"],
        990.0,
        990.0,
        1000.0,
        1000.0,
    ));
    let text = doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": curves },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 5 },
        tag("t_tops", "face", json!({ "op": "union", "of": [
            { "op": "side", "feature": "e1", "curve": "t1" },
            { "op": "side", "feature": "e1", "curve": "t2" } ] }), json!("some"))
    ]));
    let captured = capture_all(text);
    let mut v: Value = forge_ir::v1::json::parse(&captured).unwrap();
    let fs = v["parts"][0]["features"].as_array_mut().unwrap();
    fs.insert(
        2,
        json!({ "type": "sketch", "id": "s2", "name": "cutter", "plane": "XY",
        "curves": rect(["cb", "cr", "ct", "cl"], -1.0, 8.0, 11.0, 12.0) }),
    );
    fs.insert(
        3,
        json!({ "type": "extrude", "id": "e2", "name": "cut", "sketch": "s2",
        "distance": 5, "op": "cut",
        "targets": { "kind": "body", "q": { "op": "bodies" } } }),
    );
    v.to_string()
}

/// Review finding: forge-refs lists a member that another captured key accounts for as a
/// (lower-ranked) candidate of the lost member; that does not make it part of what the chosen
/// candidate replaces. Accepting `e2/side:cb` for the lost `t1` would replace the whole union by
/// a one-face query and silently drop `t2`.
#[test]
fn accept_ref_candidate_refuses_a_candidate_that_would_drop_another_member() {
    let text = two_tops_cut();
    let rep = report(&text);
    let r = entry(&rep, "t_tops", "/target");
    assert_eq!(r.code.as_deref(), Some("REF_UNCERTAIN"), "{r:?}");
    let kept: Vec<&str> = r.members.iter().map(|m| m.key.as_str()).collect();
    assert_eq!(kept, ["e1/side:t2"]);
    let u = &r.unresolved[0];
    assert_eq!(u.key, "e1/side:t1");
    let cands: Vec<&str> = u.candidates.iter().map(|c| c.key.as_str()).collect();
    assert!(
        cands.contains(&"e2/side:cb") && cands.contains(&"e1/side:t2"),
        "{cands:?}"
    );
    let e = accept_ref_candidate(
        &text,
        "t_tops",
        "/target",
        "e1/side:t1",
        "e2/side:cb",
        None,
        None,
    )
    .expect_err("t2 would be dropped");
    assert_eq!(e.code, "COMMAND_CANDIDATE_PARTIAL", "{e:?}");
    assert_eq!(e.details["members"], json!(["e1/side:t2"]));
    assert_eq!(e.details["unresolved"], json!([]));
    // Accepting the member itself for the lost face drops nothing: the reference is `t2`.
    let e = accept_ref_candidate(
        &text,
        "t_tops",
        "/target",
        "e1/side:t1",
        "e1/side:t2",
        None,
        None,
    )
    .expect("nothing is dropped");
    let r2 = report(&e.document);
    let kept: Vec<&str> = entry(&r2, "t_tops", "/target")
        .members
        .iter()
        .map(|m| m.key.as_str())
        .collect();
    assert_eq!(kept, ["e1/side:t2"]);
}

/// The plate of [`plate`] with a bool parameter `off` suppressing its sketch, and tags whose
/// captures need recomputed body members and junction qualifiers.
fn suppressible_plate() -> String {
    let mut v: Value = forge_ir::v1::json::parse(&doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "suppressed": "off",
          "curves": rect(["bottom", "right", "top", "left"], -20.0, -10.0, 20.0, 10.0) },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": "t" },
        tag("t_body", "body", json!({ "op": "body", "feature": "e1", "member": "top" }), json!("one")),
        tag("t_cap", "face", json!({ "op": "cap", "feature": "e1", "end": "end" }), json!("one")),
        tag("t_edge", "edge", json!({ "op": "edge_at", "feature": "e1", "curve": "right", "end": "start" }), json!("one"))
    ])))
    .unwrap();
    v["params"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "name": "off", "unit": "bool", "value": false }));
    capture_all(v.to_string())
}

/// Review finding: a suppressed sketch has no report entry, so its regions and junctions were
/// unknown and the ids were substituted (`e1/body:zz` instead of `e1/body:left`); every
/// reference then resolved only through the geometric fallback once unsuppressed.
#[test]
fn rename_curve_of_a_suppressed_sketch_writes_the_keys_of_its_evaluation() {
    let captured = suppressible_plate();
    let off = set_param(&captured, "off", &json!(true)).unwrap().document;
    let rep = report(&off);
    assert!(feature_entry(&rep, "s1").is_none(), "s1 is suppressed");
    for (old, new) in [("bottom", "zz"), ("right", "a"), ("top", "b0")] {
        let e = rename_curve(&off, "s1", old, new).unwrap_or_else(|e| panic!("{old}: {e:?}"));
        // The same bytes as renaming while unsuppressed, then suppressing.
        let expected = rename_curve(&captured, "s1", old, new).unwrap().document;
        let expected = set_param(&expected, "off", &json!(true)).unwrap().document;
        assert_eq!(e.document, expected, "{old} → {new}");
        // Unsuppressed again, every reference is exact (never `REF_REPAIRED`).
        let on = set_param(&e.document, "off", &json!(false))
            .unwrap()
            .document;
        let rep = report(&on);
        for (f, field, s) in statuses(&rep) {
            assert_eq!(s, RefStatus::Exact, "{old} → {new}: {f}{field}");
        }
        for f in &rep.features {
            assert!(
                f.warnings.iter().all(|w| w.code != "REF_REPAIRED"),
                "{old}: {f:?}"
            );
        }
    }
    let e = rename_curve(&off, "s1", "bottom", "zz").unwrap();
    assert!(e.document.contains("\"e1/body:left\""), "{}", e.document);
    assert!(!e.document.contains("\"e1/body:zz\""));
}

/// A sketch that fails even unsuppressed has no regions or solution: a rename whose capture
/// keys need them is refused, one that needs none is applied.
#[test]
fn rename_curve_of_a_failed_sketch_is_refused_when_keys_need_its_evaluation() {
    let mut v: Value =
        forge_ir::v1::json::parse(&repo("corpus/v1/programs/constrained_plate.json")).unwrap();
    let fs = v["parts"][0]["features"].as_array_mut().unwrap();
    fs.push(tag(
        "t_side",
        "face",
        json!({ "op": "side", "feature": "e1", "curve": "top" }),
        json!("one"),
    ));
    fs.push(tag(
        "t_cap",
        "face",
        json!({ "op": "cap", "feature": "e1", "end": "end" }),
        json!("one"),
    ));
    fs.push(tag(
        "t_edge",
        "edge",
        json!({ "op": "edge_at", "feature": "e1", "curve": "top", "end": "end" }),
        json!("one"),
    ));
    let captured = capture_all(v.to_string());
    // A second width constraint that contradicts the first: the sketch fails.
    let conflict = |text: &str| {
        let mut v: Value = forge_ir::v1::json::parse(text).unwrap();
        v["parts"][0]["features"][0]["constraints"]
            .as_array_mut()
            .unwrap()
            .push(
                json!({ "type": "distance", "id": "w2", "a": "top.start", "b": "top.end",
                          "value": "width + 1" }),
            );
        v.to_string()
    };
    let failing = conflict(&captured);
    let rep = report(&failing);
    let s1 = feature_entry(&rep, "s1").unwrap();
    assert_eq!(
        s1.error.as_ref().map(|e| e.code.as_str()),
        Some("SKETCH_CONSTRAINT_CONFLICT")
    );
    let e = rename_curve(&failing, "s1", "top", "a_top").expect_err("keys need the regions");
    assert_eq!(e.code, "COMMAND_NOT_EXACT");
    assert!(
        e.details["reason"]
            .as_str()
            .unwrap()
            .starts_with("sketch not evaluated"),
        "{e:?}"
    );
    assert_eq!(e.details["sketch_status"], "failed");
    assert_eq!(e.details["code"], "SKETCH_CONSTRAINT_CONFLICT");
    assert!(e.details["keys"].as_u64().unwrap() >= 2, "{e:?}");
    // Side keys name the curve itself: nothing to recompute.
    let mut v: Value =
        forge_ir::v1::json::parse(&repo("corpus/v1/programs/constrained_plate.json")).unwrap();
    v["parts"][0]["features"].as_array_mut().unwrap().push(tag(
        "t_side",
        "face",
        json!({ "op": "side", "feature": "e1", "curve": "top" }),
        json!("one"),
    ));
    let captured = capture_all(v.to_string());
    let e = rename_curve(&conflict(&captured), "s1", "top", "a_top").expect("side keys only");
    assert!(e.document.contains("\"e1/side:a_top\""));
    // The rewritten key could not be checked: `e1` fails with its sketch, so `t_side` resolves
    // nothing. It is listed (W9 review 4).
    assert_eq!(
        e.result["unverified"],
        json!([{ "feature": "t_side", "field": "/target", "reason": "failed",
                 "code": "DEPENDENCY_FAILED" }])
    );
    // …and it is the rename of the working sketch, with the conflict added.
    let direct = rename_curve(&captured, "s1", "top", "a_top")
        .unwrap()
        .document;
    let fixed: Value = forge_ir::v1::json::parse(&e.document).unwrap();
    let mut direct_v: Value = forge_ir::v1::json::parse(&conflict(&direct)).unwrap();
    // The conflict's own arguments were renamed with the curve.
    direct_v["parts"][0]["features"][0]["constraints"][9]["a"] = json!("a_top.start");
    direct_v["parts"][0]["features"][0]["constraints"][9]["b"] = json!("a_top.end");
    assert_eq!(canon(&fixed.to_string()), canon(&direct_v.to_string()));
}

/// Review finding: renamed capture keys must be put back in canonical member order (§5.4,
/// §5.6), or the stored capture differs from what `captureRef` writes for the same state.
#[test]
fn rename_curve_keeps_captures_in_canonical_order() {
    let mut s2 = rect(["b", "r", "t", "l"], -5.0, -3.0, 5.0, 3.0);
    s2.truncate(4);
    let text = capture_all(doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY",
          "curves": rect(["bottom", "right", "top", "left"], -20.0, -10.0, 20.0, 10.0) },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 4 },
        { "type": "sketch", "id": "s2", "name": "boss_sk", "plane": "XY", "curves": s2 },
        { "type": "extrude", "id": "e2", "name": "boss", "sketch": "s2", "distance": 10 },
        tag("t_ring", "face", json!({ "op": "sides", "feature": "e2" }), json!("some")),
        tag("t_ring_edges", "edge", json!({ "op": "edges", "of": { "op": "sides", "feature": "e2" } }), json!("some"))
    ])));
    // Faces and edges: by key.
    let e = rename_curve(&text, "s2", "r", "a").expect("ok");
    let v: Value = forge_ir::v1::json::parse(&e.document).unwrap();
    for f in [4, 5] {
        let keys: Vec<String> = v["parts"][0]["features"][f]["target"]["capture"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["key"].as_str().unwrap().to_string())
            .collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "feature {f}");
    }
    for t in ["t_ring", "t_ring_edges"] {
        let again = capture_ref(&e.document, t, "/target").unwrap();
        assert!(!again.changed, "{t}: the renamed capture is the fresh one");
    }
    // Bodies: by origin (timeline, then member). Renaming `a1` makes `x2` the member of the
    // first plate, which then sorts after `b1`.
    let mut curves = rect(["a1", "x2", "x3", "x4"], 0.0, 0.0, 10.0, 10.0);
    curves.extend(rect(["b1", "b2", "b3", "b4"], 20.0, 0.0, 30.0, 10.0));
    let text = capture_all(doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": curves },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 4 },
        tag("t_bodies", "body", json!({ "op": "body", "feature": "e1" }), json!("some"))
    ])));
    let e = rename_curve(&text, "s1", "a1", "z1").expect("ok");
    let v: Value = forge_ir::v1::json::parse(&e.document).unwrap();
    let keys: Vec<&str> = v["parts"][0]["features"][2]["target"]["capture"]["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, ["e1/body:b1", "e1/body:x2"]);
    assert!(
        !capture_ref(&e.document, "t_bodies", "/target")
            .unwrap()
            .changed
    );
    assert_eq!(
        rename_curve(&e.document, "s1", "z1", "a1")
            .unwrap()
            .document,
        text
    );
}

/// Hole points (§5.9: hole `points`, `hole_face.at`, `H/<role>@p` keys) are rewritten by the
/// same walk; checked here on plate_features without evaluation (the verified op on it:
/// [`rename_curve_of_plate_features_hole_points_is_verified`]).
#[test]
fn rename_curve_rewrites_hole_points_hole_faces_and_hole_keys() {
    let text = repo("corpus/v1/programs/plate_features.json");
    let doc = load_as(&text, Needs::Ir).unwrap();
    let mut v = to_value(&doc);
    // A tag on the hole's wall at p1, with a capture as the resolver would write it.
    v["parts"][0]["features"]
        .as_array_mut()
        .unwrap()
        .push(json!({
        "type": "tag", "id": "t_wall", "name": "t_wall", "target": { "kind": "face",
          "q": { "op": "hole_face", "feature": "h2", "at": "p1", "part": "wall" },
          "capture": { "members": [
            { "key": "h2/wall@p1", "via": "named", "geom": { "type": "cylinder",
              "carrier": "free", "bbox": [[0, 0, 0], [1, 1, 1]], "size": 1, "centroid": [0, 0, 0],
              "local": [0, 0, 0], "body_center": [0, 0, 0], "neighbors": 0 } } ] } } }));
    let doc = load_value_as(&v, Needs::Ir).unwrap();
    let (pi, fi) = feature_index(&doc, "s2").unwrap();
    let mut r = Renamer::new(&doc, pi, "s2", "p1", "q1");
    assert!(r.holes.contains("h2"), "{:?}", r.holes);
    r.rewrite(&doc, &mut v, pi, fi);
    assert_eq!(r.unmapped.get(), 0, "hole keys need no evaluation");
    let s = v.to_string();
    let h2 = &v["parts"][0]["features"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == "h2")
        .unwrap()["at"]["points"]["ids"];
    assert_eq!(*h2, json!(["q1", "p2"]));
    assert!(s.contains("\"h2/wall@q1\""), "{s}");
    assert!(s.contains("\"at\":\"q1\""), "{s}");
    assert!(
        !s.contains("@p1") && !s.contains("\"at\":\"p1\"") && !s.contains("\"id\":\"p1\",\"kind\""),
        "{s}"
    );
    assert_eq!(r.counts.get("points"), Some(&1));
    assert_eq!(r.counts.get("capture_keys"), Some(&1));
    assert_eq!(
        r.rewritten_refs,
        [("t_wall".to_string(), "/target".to_string())]
    );
}

/// A plate with two holes on the points `p1`, `p2` of sketch `s2` (on its top cap), and tags on
/// a hole wall, every face the hole created, the plate's body and its top cap.
fn plate_with_holes() -> String {
    doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY",
          "curves": rect(["bottom", "right", "top", "left"], -20.0, -10.0, 20.0, 10.0) },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": "t" },
        { "type": "sketch", "id": "s2", "name": "marks",
          "plane": { "face": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } } },
          "curves": [ { "kind": "point", "id": "p1", "at": [-8.0, 2.0] },
                      { "kind": "point", "id": "p2", "at": [8.0, -2.0] } ] },
        { "type": "hole", "id": "h1", "name": "holes",
          "on": { "face": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } } },
          "at": { "points": { "sketch": "s2", "ids": ["p1", "p2"] } }, "d": 3, "depth": "through" },
        tag("t_wall", "face", json!({ "op": "hole_face", "feature": "h1", "at": "p1", "part": "wall" }), json!("one")),
        tag("t_made", "face", json!({ "op": "created", "feature": "h1" }), json!("some")),
        tag("t_top", "face", json!({ "op": "cap", "feature": "e1", "end": "end" }), json!("one")),
        tag("t_body", "body", json!({ "op": "body", "feature": "e1" }), json!("one")),
        tag("t_rims", "edge", json!({ "op": "edges", "of": { "op": "hole_face", "feature": "h1",
            "at": "p2", "part": "wall" } }), json!("some"))
    ]))
}

/// Review finding (W9 review 4): once holes evaluate, renaming a hole's point must be the
/// verified op §5.9 describes — every reference exact, the report the same up to the rename,
/// and renaming back restoring the bytes — on a document whose captures name the points.
#[test]
fn rename_curve_of_hole_points_is_verified_and_undone_by_its_inverse() {
    let text = capture_all(plate_with_holes());
    assert!(text.contains("\"h1/wall@p1\""), "{text}");
    for (old, new) in [("p1", "q1"), ("p2", "a0"), ("p1", "zz")] {
        let e = rename_curve(&text, "s2", old, new).unwrap_or_else(|e| panic!("{old}: {e:?}"));
        assert!(e.changed);
        assert_eq!(e.result["rewritten"]["points"], 1, "{old}");
        assert_eq!(e.result["unverified"], json!([]), "{old}");
        let rep = report(&e.document);
        for (f, field, st) in statuses(&rep) {
            assert_eq!(st, RefStatus::Exact, "{old} → {new}: {f}{field}");
        }
        assert!(e.document.contains(&format!("\"h1/wall@{new}\"")), "{old}");
        assert!(!e.document.contains(&format!("@{old}\"")), "{old}");
        let hole = feature_entry(&rep, "h1").unwrap();
        assert!(
            hole.holes.iter().any(|h| h.at == new),
            "{old}: {:?}",
            hole.holes
        );
        let back = rename_curve(&e.document, "s2", new, old).expect("back");
        assert_eq!(back.document, text, "{old} → {new} → {old}");
    }
}

/// The reviewer's case: plate_features' `h2` sits on points `p1`, `p2` of `s2`, and renaming
/// `p1` changes the order in which Forge accumulates the body metrics of `h2` and the features
/// after it (the x of `h2`'s body centroid moves from -9.139450506135777e-16 to
/// -9.135312199363697e-16, and three more centroids by about 4e-19): a bit-for-bit
/// verification refused every such rename (`COMMAND_NOT_EXACT`). The float metrics are now
/// compared within SPEC-v1 §8.2's tolerances. Release only: plate_features takes minutes per
/// evaluation in debug builds.
#[cfg_attr(
    debug_assertions,
    ignore = "plate_features evaluates in minutes in debug builds"
)]
#[test]
fn rename_curve_of_plate_features_hole_points_is_verified() {
    let text = engine::canonicalize(&repo("corpus/v1/programs/plate_features.json"))
        .unwrap()
        .document;
    let e = rename_curve(&text, "s2", "p1", "q1").unwrap_or_else(|e| panic!("{e:?}"));
    assert!(e.document.contains("\"q1\""));
    let rep = report(&e.document);
    assert!(statuses(&rep).iter().all(|x| x.2 != RefStatus::Failed));
    assert_eq!(
        rename_curve(&e.document, "s2", "q1", "p1")
            .unwrap()
            .document,
        text
    );
}

/// The pure IR edits need no evaluation: a document Forge does not evaluate (a `draft`, the
/// optional type Forge rejects with `UNSUPPORTED_FEATURE`, SPEC-v1 §6.9) is edited, and its
/// parameter values are reported; the evaluated ops are refused on it with the engine's
/// capability check. (It used plate_features while Forge rejected holes and patterns.)
#[test]
fn pure_ir_edits_accept_documents_forge_does_not_evaluate() {
    let mut v: Value = forge_ir::v1::json::parse(&plate()).unwrap();
    v["parts"][0]["features"].as_array_mut().unwrap().push(
        json!({ "type": "draft", "id": "d1", "name": "taper",
            "faces": { "kind": "face", "q": { "op": "sides", "feature": "e1" } },
            "neutral": "XY", "angle": 2 }),
    );
    let text = v.to_string();
    assert_eq!(
        code(capture_ref(&text, "t_side", "/target")),
        "UNSUPPORTED_FEATURE"
    );
    let e = rename_feature(&text, "d1", "taper2").expect("renameFeature");
    assert!(e.changed);
    let back = rename_feature(&e.document, "d1", "taper").unwrap();
    assert_eq!(back.document, engine::canonicalize(&text).unwrap().document);
    let e = set_param(&text, "w", &json!("t*8")).expect("setParam");
    assert_eq!(e.result["value"], "t * 8");
    let w = e.result["params"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "w")
        .unwrap();
    assert_eq!(w["value"], json!(48.0));
    assert_eq!(
        code(set_param(&text, "t", &json!(0.5))),
        "PARAM_OUT_OF_RANGE"
    );
    for r in [
        rename_curve(&text, "s1", "top", "a_top"),
        accept_ref_proposal(&text, "t_side", "/target"),
        upgrade_feature(&text, "e1", None),
    ] {
        assert_eq!(code(r), "UNSUPPORTED_FEATURE");
    }
    assert_eq!(
        engine::write_back(&text, None).unwrap_err().code,
        "UNSUPPORTED_FEATURE"
    );
}

/// Review finding: the DocStore must store canonical expressions (§2.4), and every op returns
/// canonical text, so the setParam inverse restores the same bytes.
#[test]
fn ops_read_and_write_canonical_expressions() {
    let mut v: Value =
        forge_ir::v1::json::parse(&repo("corpus/v1/programs/params_plate.json")).unwrap();
    v["params"][1]["value"] = json!("width/10");
    let text = v.to_string();
    let canonical = engine::canonicalize(&text).unwrap().document;
    assert!(canonical.contains("\"width / 10\""));
    // An op on the non-canonical text returns canonical text.
    let e = set_param(&text, "width", &json!(100)).unwrap();
    assert!(e.document.contains("\"width / 10\"") && !e.document.contains("width/10"));
    let e = rename_feature(&text, "e1", "plate").unwrap();
    assert!(e.document.contains("\"width / 10\""));
    // The inverse of setParam restores the canonical document byte for byte.
    let e = set_param(&canonical, "depth", &json!(7)).unwrap();
    assert_eq!(e.result["previous"], "width / 10");
    let back = set_param(&e.document, "depth", &e.result["previous"]).unwrap();
    assert_eq!(back.document, canonical);
    // Nothing changes on a canonical document that an op leaves alone.
    assert!(!rename_feature(&canonical, "e1", "slab").unwrap().changed);
    assert_eq!(
        rename_feature(&canonical, "e1", "slab").unwrap().document,
        canonical
    );
}

// ---- W9 review 3 ----------------------------------------------------------------------------------

/// Two squares `a1..a4`, `b1..b4` extruded by `e1`; `t_any` (card any) on the side of `b3` and
/// `t_mix` (card some) on the sides of `b3` and `a3`, both captured; then `e1` extrudes square
/// `a` only, so the captured `b3` face is gone.
fn squares_with_a_lost_face() -> String {
    let mut curves = rect(["a1", "a2", "a3", "a4"], 0.0, 0.0, 10.0, 10.0);
    curves.extend(rect(["b1", "b2", "b3", "b4"], 20.0, 0.0, 30.0, 10.0));
    let captured = capture_all(doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": curves },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 5 },
        tag("t_any", "face", json!({ "op": "side", "feature": "e1", "curve": "b3" }), json!("any")),
        tag("t_mix", "face", json!({ "op": "union", "of": [
            { "op": "side", "feature": "e1", "curve": "b3" },
            { "op": "side", "feature": "e1", "curve": "a3" } ] }), json!("some"))
    ])));
    let mut v: Value = forge_ir::v1::json::parse(&captured).unwrap();
    v["parts"][0]["features"][1]["regions"] = json!(["a1"]);
    v.to_string()
}

/// Review finding: captureRef read the reference with an empty capture only, so a captured card
/// `any` / `some` reference whose named member is now `REF_MISSING` passed (the query alone
/// resolves) and was re-captured without that member — a silent re-bind (§5.7: a repair is an
/// explicit edit). The document's own entry decides, and its failure is refused.
#[test]
fn capture_ref_refuses_a_captured_reference_whose_member_went_missing() {
    let text = squares_with_a_lost_face();
    let rep = report(&text);
    for (t, kept) in [("t_any", vec![]), ("t_mix", vec!["e1/side:a3"])] {
        let r = entry(&rep, t, "/target");
        assert_eq!(r.status, RefStatus::Failed, "{t}: {r:?}");
        assert_eq!(r.code.as_deref(), Some("REF_MISSING"), "{t}");
        let e = capture_ref(&text, t, "/target").expect_err("fails");
        assert_eq!(e.code, "COMMAND_REF_FAILED", "{t}: {e:?}");
        // The document's own entry: its code, members and captured unresolved key.
        assert_eq!(e.details["code"], "REF_MISSING", "{t}");
        assert_eq!(e.details["unresolved"][0]["key"], "e1/side:b3", "{t}");
        let members: Vec<&str> = e.details["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["key"].as_str().unwrap())
            .collect();
        assert_eq!(members, kept, "{t}");
        assert!(e.message.contains("REF_MISSING"), "{}", e.message);
    }
}

/// A plate `e1` with `t1` = its `top` side (card one), captured; then a through-cut `e2` splits
/// the plate in two, and the `top` face with it (`REF_SPLIT`).
fn plate_split_through() -> String {
    let captured = capture_all(doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY",
          "curves": rect(["bottom", "right", "top", "left"], -20.0, -10.0, 20.0, 10.0) },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": "t" },
        tag("t1", "face", json!({ "op": "side", "feature": "e1", "curve": "top" }), json!("one"))
    ])));
    let mut v: Value = forge_ir::v1::json::parse(&captured).unwrap();
    let fs = v["parts"][0]["features"].as_array_mut().unwrap();
    fs.insert(
        2,
        json!({ "type": "sketch", "id": "s2", "name": "cutter", "plane": "XY",
                "curves": rect(["cb", "cr", "ct", "cl"], -2.0, -15.0, 2.0, 15.0) }),
    );
    fs.insert(
        3,
        json!({ "type": "extrude", "id": "e2", "name": "cut", "sketch": "s2", "distance": 10,
                "op": "cut", "targets": { "kind": "body", "q": { "op": "bodies" } } }),
    );
    v.to_string()
}

/// Review finding: the refusal was built from the empty-capture evaluation (`REF_AMBIGUOUS`,
/// unresolved key `""`), so feeding its details to acceptRefCandidate failed. It now carries
/// the document's own entry (`REF_SPLIT`, key `e1/side:top`), and its details repair the
/// reference as they are.
#[test]
fn capture_ref_refusal_details_repair_the_reference_with_accept_ref_candidate() {
    let text = plate_split_through();
    let rep = report(&text);
    let r = entry(&rep, "t1", "/target");
    assert_eq!(r.code.as_deref(), Some("REF_SPLIT"), "{r:?}");
    let e = capture_ref(&text, "t1", "/target").expect_err("split");
    assert_eq!(e.code, "COMMAND_REF_FAILED");
    assert_eq!(e.details["code"], "REF_SPLIT", "{e:?}");
    assert!(e.message.contains("REF_SPLIT"), "{}", e.message);
    let u = &e.details["unresolved"][0];
    let member = u["key"].as_str().unwrap();
    assert_eq!(member, "e1/side:top");
    let cands = u["candidates"].as_array().unwrap();
    assert!(cands.len() >= 2, "{cands:?}");
    // Every candidate of the refusal is accepted as given (pieces share the key: by index).
    for (i, c) in cands.iter().enumerate() {
        let key = c["key"].as_str().unwrap();
        let fixed = accept_ref_candidate(&text, "t1", "/target", member, key, Some(i), None)
            .unwrap_or_else(|e| panic!("candidate {i}: {e:?}"));
        let rep2 = report(&fixed.document);
        let r2 = entry(&rep2, "t1", "/target");
        assert_eq!(r2.status, RefStatus::Exact, "candidate {i}");
        assert_eq!(
            serde_json::to_value(&r2.members[0].probe).unwrap(),
            c["probe"],
            "candidate {i}"
        );
        // …after which captureRef is a no-op.
        let again = capture_ref(&fixed.document, "t1", "/target").expect("capturable");
        assert!(!again.changed, "candidate {i}");
    }
}

/// Review finding: a member found only by the geometric fallback is not in the query's result;
/// captureRef must not rewrite the capture around it. The proposal is the repair.
#[test]
fn capture_ref_refuses_a_member_repaired_by_the_geometric_fallback() {
    let captured = capture_all(plate());
    let moved = rename_by_hand(&captured, "right", "a_right");
    let rep = report(&moved);
    let r = entry(&rep, "t_edge", "/target");
    assert!(
        r.members.iter().any(|m| m.status == MemberStatus::Repaired),
        "{r:?}"
    );
    let e = capture_ref(&moved, "t_edge", "/target").expect_err("repaired");
    assert_eq!(e.code, "COMMAND_REF_REPAIRED", "{e:?}");
    assert_eq!(e.details["code"], "REF_REPAIRED");
    assert_eq!(e.details["proposal"], true);
    assert_eq!(e.details["repaired"].as_array().unwrap().len(), 1);
    // The proposal repairs it; then the reference is capturable and already captured.
    let fixed = accept_ref_proposal(&moved, "t_edge", "/target").expect("proposal");
    assert!(
        !capture_ref(&fixed.document, "t_edge", "/target")
            .unwrap()
            .changed
    );
}

/// Review finding: the capture's check only compared the written capture with itself. It now
/// compares the members `(key, probe)` with the reference's resolution before the op, so a
/// capture can neither drop a member nor pick up another entity under the same key ([W0-33]: a
/// second section branch must not widen a captured selection). Forge's resolver today returns
/// the same set with and without a capture wherever a reference is capturable, so the guard is
/// exercised on report entries directly.
#[test]
fn a_capture_must_keep_the_current_members_key_and_probe() {
    let rep = report(&plate());
    let cur = entry(&rep, "t_vertical", "/target").clone();
    assert_eq!(cur.members.len(), 4);
    let check = |a: &RefReport, b: &RefReport| {
        check_same_members("captureRef", "t_vertical", "/target", "the query", a, b)
    };
    assert!(check(&cur, &cur).is_ok());
    // Order does not matter (a multiset).
    let mut reordered = cur.clone();
    reordered.members.reverse();
    assert!(check(&cur, &reordered).is_ok());
    // A dropped member.
    let mut narrowed = cur.clone();
    narrowed.members.pop();
    let e = check(&cur, &narrowed).expect_err("narrowed");
    assert_eq!(e.code, "COMMAND_NOT_EXACT");
    assert_eq!(e.details["op"], "captureRef");
    assert_eq!(e.details["members"].as_array().unwrap().len(), 4);
    assert_eq!(e.details["found"].as_array().unwrap().len(), 3);
    // A widened selection (the query takes an entity the capture excluded).
    assert_eq!(code_of(check(&narrowed, &cur)), "COMMAND_NOT_EXACT");
    // The same key on another entity (split pieces and section branches share keys).
    let mut elsewhere = cur.clone();
    elsewhere.members[0].probe.point[0] += 1.0;
    assert_eq!(code_of(check(&cur, &elsewhere)), "COMMAND_NOT_EXACT");
}

fn code_of(r: Result<(), Rejection>) -> String {
    r.expect_err("refused").code
}

/// Review finding: §9.3 names renameFeature as the fix for a feature name that is a v1 builtin
/// (`CS_RESERVED_NAME`); IR validation only checks the v0 list ([W0-2]), so the op must check
/// the full v1 list itself.
#[test]
fn rename_feature_never_writes_a_v1_reserved_name() {
    let text = plate();
    for name in ["X", "hole", "fillet", "PI", "sin", "tag"] {
        let e = rename_feature(&text, "e1", name).expect_err(name);
        assert_eq!(e.code, "RESERVED_NAME", "{name}");
        assert_eq!(e.errors[0]["path"], "/parts/0/features/1/name", "{name}");
        assert_eq!(e.errors[0]["details"]["name"], name, "{name}");
    }
    // v0's list is still the document's own rejection.
    assert_eq!(
        code(rename_feature(&text, "e1", "extrude")),
        "RESERVED_NAME"
    );
    // A (migrated) feature already named with a v1 builtin is valid IR: it keeps its name…
    let mut v: Value = forge_ir::v1::json::parse(&text).unwrap();
    v["parts"][0]["features"][1]["name"] = json!("hole");
    let named = v.to_string();
    let same = rename_feature(&named, "e1", "hole").expect("keeping the name");
    assert!(!same.changed);
    // …and is renamed away from it (the §9.3 repair), which its inverse undoes byte for byte.
    let e = rename_feature(&named, "e1", "slab2").expect("renamed away");
    assert!(e.changed);
    assert_eq!(e.result["previous"], "hole");
}

/// A plate `e1` (curves bottom, right, top, left: its member is `bottom`) patterned by `pt` in
/// a row of three new bodies, with tags on the copies (all, by member, a copy's top cap) and
/// on the seed.
fn patterned_plate() -> String {
    doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY",
          "curves": rect(["bottom", "right", "top", "left"], 0.0, 0.0, 10.0, 6.0) },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 4 },
        { "type": "pattern", "id": "pt", "name": "row", "seed": { "features": ["e1"] },
          "layout": { "linear": { "dir": "X", "count": 3, "spacing": 20 } } },
        tag("t_row", "body", json!({ "op": "body", "feature": "pt" }), json!("some")),
        tag("t_row_m", "body", json!({ "op": "body", "feature": "pt", "member": "bottom" }), json!("some")),
        tag("t_slab", "body", json!({ "op": "body", "feature": "e1", "member": "top" }), json!("one")),
        tag("t_copy_top", "face", json!({ "op": "filter", "where": { "normal": "+Z" },
            "of": { "op": "instance", "feature": "pt", "index": [1] } }), json!("one"))
    ]))
}

/// Review finding: patterns now evaluate, so renames meet them. A copy's origin is `{ pattern,
/// the seed's member, instance }` (§5.2 rule 4, §6.10): its `P/body:m@i` keys follow the
/// rename. A `body` query naming the pattern with a `member` reads two ways (§5.3: a curve of
/// the seed's outer loop; forge-refs: the copies' origin member); where they agree the member is
/// rewritten and verified, where they differ the rename is refused until W0 rules.
#[test]
fn rename_curve_rewrites_pattern_copies_and_refuses_a_pattern_member_read_two_ways() {
    let text = capture_all(patterned_plate());
    assert!(text.contains("\"pt/body:bottom@1\""), "{text}");
    // `bottom` stays the smallest id: both readings give `a_bottom`.
    for (old, new, member) in [("bottom", "a_bottom", "a_bottom"), ("left", "zz", "bottom")] {
        let e = rename_curve(&text, "s1", old, new).unwrap_or_else(|e| panic!("{old}: {e:?}"));
        let rep = report(&e.document);
        for (f, field, st) in statuses(&rep) {
            assert_eq!(st, RefStatus::Exact, "{old} → {new}: {f}{field}");
        }
        assert!(
            e.document.contains(&format!("\"pt/body:{member}@2\"")),
            "{old}"
        );
        let v: Value = forge_ir::v1::json::parse(&e.document).unwrap();
        assert_eq!(
            v["parts"][0]["features"][4]["target"]["q"]["member"],
            member
        );
        assert_eq!(
            rename_curve(&e.document, "s1", new, old).unwrap().document,
            text,
            "{old} → {new} → {old}"
        );
    }
    // `top` → `a_top` makes `a_top` the copies' member: `bottom` is still a curve of the seed's
    // outer loop, but no longer the origin member.
    let e = rename_curve(&text, "s1", "top", "a_top").expect_err("two readings");
    assert_eq!(e.code, "COMMAND_NOT_EXACT");
    assert_eq!(
        e.details["patterns"],
        json!([{ "pattern": "pt", "member": "bottom", "as_curve": "bottom", "as_origin": "a_top" }])
    );
    // Without the member query the same rename is applied: the copies' keys follow.
    let mut v: Value = forge_ir::v1::json::parse(&text).unwrap();
    v["parts"][0]["features"].as_array_mut().unwrap().remove(4);
    let text = canon(&v.to_string());
    let e = rename_curve(&text, "s1", "top", "a_top").expect("no member query");
    assert!(e.document.contains("\"pt/body:a_top@1\""), "{}", e.document);
    assert!(!e.document.contains("pt/body:bottom"));
    let rep = report(&e.document);
    assert!(statuses(&rep).iter().all(|x| x.2 == RefStatus::Exact));
    assert_eq!(
        rename_curve(&e.document, "s1", "a_top", "top")
            .unwrap()
            .document,
        text
    );
}

/// A body-seeded pattern copies the bodies its seed reference resolves: it follows a rename of
/// their sketch only when they are that sketch's (read from the report).
#[test]
fn rename_curve_follows_body_seeded_patterns_of_the_sketchs_bodies_only() {
    let other = rect(["o1", "o2", "o3", "o4"], 0.0, 20.0, 5.0, 25.0);
    let text = capture_all(doc(json!([
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY",
          "curves": rect(["bottom", "right", "top", "left"], 0.0, 0.0, 10.0, 6.0) },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 4 },
        { "type": "sketch", "id": "s9", "name": "other", "plane": "XY", "curves": other },
        { "type": "extrude", "id": "e9", "name": "block", "sketch": "s9", "distance": 4 },
        { "type": "pattern", "id": "p_ours", "name": "copies",
          "seed": { "bodies": { "kind": "body", "q": { "op": "body", "feature": "e1" }, "card": "some" } },
          "layout": { "linear": { "dir": "X", "count": 2, "spacing": 20 } } },
        { "type": "pattern", "id": "p_other", "name": "others",
          "seed": { "bodies": { "kind": "body", "q": { "op": "body", "feature": "e9" }, "card": "some" } },
          "layout": { "linear": { "dir": "Y", "count": 2, "spacing": 20 } } },
        tag("t_all", "body", json!({ "op": "bodies" }), json!("some"))
    ])));
    let e = rename_curve(&text, "s1", "bottom", "a_bottom").unwrap_or_else(|e| panic!("{e:?}"));
    assert!(
        e.document.contains("\"p_ours/body:a_bottom@1\""),
        "{}",
        e.document
    );
    assert!(
        e.document.contains("\"p_other/body:o1@1\""),
        "{}",
        e.document
    );
    let rep = report(&e.document);
    assert!(statuses(&rep).iter().all(|x| x.2 == RefStatus::Exact));
}

/// A reference that resolves with warnings only is capturable, and its capture is exactly its
/// current resolution: for a broad set that changed (`REF_SET_CHANGED`), the same document as
/// accepting its proposal.
#[test]
fn capture_ref_of_a_changed_broad_set_records_the_current_set() {
    let changed = plate_with_notch(&capture_all(plate()));
    let rep = report(&changed);
    let r = entry(&rep, "t_vertical", "/target");
    assert_eq!(r.status, RefStatus::Accepted);
    let e = capture_ref(&changed, "t_vertical", "/target").expect("capturable");
    assert!(e.changed);
    let rep2 = report(&e.document);
    let r2 = entry(&rep2, "t_vertical", "/target");
    assert_eq!(r2.status, RefStatus::Exact);
    assert_eq!(member_set(r2), member_set(r));
    let proposal = accept_ref_proposal(&changed, "t_vertical", "/target").unwrap();
    assert_eq!(e.document, proposal.document);
}

// ---- W9 review 4 ----------------------------------------------------------------------------------

/// Review finding: a rename rewrote capture keys of references the engine did not resolve (their
/// feature fails upstream: `DEPENDENCY_FAILED`, nothing to compare) and claimed every reference
/// verified. They are now listed in `result.unverified`; the keys are still the ones the engine
/// produces once the feature evaluates again.
#[test]
fn rename_curve_lists_the_captures_it_could_not_verify() {
    let captured = capture_all(plate());
    let failing = set_param(&captured, "t", &json!("w - 50"))
        .unwrap()
        .document;
    let rep = report(&failing);
    assert!(
        statuses(&rep).iter().all(|x| x.2 == RefStatus::Failed),
        "{rep:?}"
    );
    let e = rename_curve(&failing, "s1", "bottom", "z").expect("renamed");
    let listed: Vec<&str> = e.result["unverified"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| {
            assert_eq!(u["reason"], "failed", "{u}");
            assert_eq!(u["code"], "DEPENDENCY_FAILED", "{u}");
            u["feature"].as_str().unwrap()
        })
        .collect();
    // Every reference whose keys name the member `bottom` or its junctions; `t_side` (`top`)
    // and `t_edge` (`@right.end`) keep their keys and are not listed.
    assert_eq!(listed, ["t_cap", "t_between", "t_body", "t_vertical"]);
    // Once the parameter is fixed every reference is exact, and the document is the rename of
    // the healthy one.
    let fixed = set_param(&e.document, "t", &json!(6)).unwrap().document;
    assert!(
        statuses(&report(&fixed))
            .iter()
            .all(|x| x.2 == RefStatus::Exact)
    );
    let healthy = rename_curve(&captured, "s1", "bottom", "z").unwrap();
    assert_eq!(healthy.result["unverified"], json!([]));
    assert_eq!(fixed, healthy.document);
}

/// Review finding: the DocStore writes back solved geometry before a repair, so a
/// `candidateIndex` read from the report of the document before could name another split piece
/// in the document the op runs on. The probe the caller read identifies the piece: a candidate
/// that is not that entity any more is refused (`COMMAND_CANDIDATE_CHANGED`).
#[test]
fn accept_ref_candidate_checks_the_probe_the_caller_read() {
    let text = plate_split_through();
    let rep = report(&text);
    let u = entry(&rep, "t1", "/target").unresolved[0].clone();
    let pieces: Vec<(usize, &forge_ir::v1::metrics::Candidate)> = u
        .candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| c.key == "e1/side:top")
        .collect();
    assert!(pieces.len() >= 2, "{u:?}");
    let (i0, c0) = pieces[0];
    let (i1, c1) = pieces[1];
    // The probe alone picks the piece among those sharing the key (no index needed)…
    for (i, c) in [(i0, c0), (i1, c1)] {
        let e = accept_ref_candidate(&text, "t1", "/target", &u.key, &c.key, None, Some(&c.probe))
            .unwrap_or_else(|e| panic!("piece {i}: {e:?}"));
        let by_index =
            accept_ref_candidate(&text, "t1", "/target", &u.key, &c.key, Some(i), None).unwrap();
        assert_eq!(e.document, by_index.document, "piece {i}");
        let rep2 = report(&e.document);
        assert_eq!(entry(&rep2, "t1", "/target").members[0].probe, c.probe);
    }
    // …and moved by less than the match radius (a write-back moves geometry by ≤ tol).
    let mut near = c1.probe.clone();
    near.point[0] += 2.0 * forge_ir::v1::LINEAR_TOLERANCE;
    assert!(
        accept_ref_candidate(
            &text,
            "t1",
            "/target",
            &u.key,
            &c1.key,
            Some(i1),
            Some(&near)
        )
        .is_ok()
    );
    // An index that names another piece than the probe: refused, with both locations.
    let e = accept_ref_candidate(
        &text,
        "t1",
        "/target",
        &u.key,
        &c0.key,
        Some(i0),
        Some(&c1.probe),
    )
    .expect_err("another piece");
    assert_eq!(e.code, "COMMAND_CANDIDATE_CHANGED", "{e:?}");
    assert_eq!(e.details["reason"], "probe");
    assert_eq!(e.details["index"], i0);
    assert_eq!(
        e.details["expected"],
        serde_json::to_value(&c1.probe).unwrap()
    );
    assert_eq!(e.details["found"], json!([c0.probe]));
    // A probe no candidate is at any more.
    let mut gone = c0.probe.clone();
    gone.point[1] += 1.0;
    let e = accept_ref_candidate(&text, "t1", "/target", &u.key, &c0.key, None, Some(&gone))
        .expect_err("moved");
    assert_eq!(e.code, "COMMAND_CANDIDATE_CHANGED");
    assert_eq!(e.details["found"].as_array().unwrap().len(), pieces.len());
    // Another kind, or the opposite side, is not the entity either.
    let mut flipped = c0.probe.clone();
    if let Some(n) = flipped.normal.as_mut() {
        *n = [-n[0], -n[1], -n[2]];
        assert_eq!(
            code(accept_ref_candidate(
                &text,
                "t1",
                "/target",
                &u.key,
                &c0.key,
                Some(i0),
                Some(&flipped)
            )),
            "COMMAND_CANDIDATE_CHANGED"
        );
    }
}

/// Review finding: every transaction's automatic write-back evaluated the whole model, even
/// with nothing to write. It evaluates nothing without a constrained sketch, and otherwise only
/// what the solves depend on; the result is the whole-document write-back's.
#[test]
fn write_back_evaluates_only_what_the_solves_depend_on() {
    // No constrained sketch: nothing to write, one pass, and a requested explicit sketch is
    // listed as forge-regen lists it.
    let plain = plate();
    let wb = engine::write_back(&plain, None).unwrap();
    assert!(!wb.changed && wb.written.is_empty() && wb.skipped.is_empty());
    assert_eq!(wb.passes, 1);
    assert_eq!(wb.document, canon(&plain));
    let wb = engine::write_back(&plain, Some(&["s1".to_string()])).unwrap();
    assert_eq!(
        wb.skipped,
        [json!({ "sketch": "s1", "reason": "explicit" })]
    );
    let e = engine::write_back(&plain, Some(&["e1".to_string()])).unwrap_err();
    assert_eq!(e.code, "WRITE_BACK_UNKNOWN_SKETCH");
    // A constrained sketch followed by other features (a downstream sketch on its cap, an
    // extrude, tags): the prefix write-back equals forge-regen's on the whole document, pass for
    // pass, and a requested explicit sketch after the prefix is listed.
    let mut v: Value =
        forge_ir::v1::json::parse(&repo("corpus/v1/programs/constrained_plate.json")).unwrap();
    v["parts"][0]["features"][0]["curves"][0]["end"] = json!([40.5, -25.0]);
    v["parts"][0]["features"][0]["curves"][1]["start"] = json!([40.5, -25.0]);
    let fs = v["parts"][0]["features"].as_array_mut().unwrap();
    fs.push(json!({ "type": "sketch", "id": "s9", "name": "boss_sk",
        "plane": { "face": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } } },
        "curves": [{ "kind": "circle", "id": "k", "center": [0, 0], "radius": 3 }] }));
    fs.push(
        json!({ "type": "extrude", "id": "e9", "name": "boss", "sketch": "s9", "distance": 2 }),
    );
    fs.push(tag(
        "t_top",
        "face",
        json!({ "op": "cap", "feature": "e9", "end": "end" }),
        json!("one"),
    ));
    let text = canon(&v.to_string());
    let whole = forge_regen::v1::write_back(&load(&text).unwrap(), None).unwrap();
    let wb = engine::write_back(&text, None).unwrap();
    assert!(wb.changed);
    assert_eq!(wb.written, ["s1"]);
    assert_eq!(wb.passes, 2);
    assert_eq!(wb.document, canonical(&whole.doc));
    let wb2 = engine::write_back(&text, Some(&["s1".to_string(), "s9".to_string()])).unwrap();
    assert_eq!(wb2.document, wb.document);
    assert_eq!(
        wb2.skipped,
        [json!({ "sketch": "s9", "reason": "explicit" })]
    );
}

/// The ops that write one reference evaluate the model only through its feature
/// (`evaluate_through`); that feature's entry must be the whole document's, bit for bit.
#[test]
fn a_feature_evaluated_through_itself_reports_as_in_the_whole_document() {
    let mut constrained: Value =
        forge_ir::v1::json::parse(&repo("corpus/v1/programs/constrained_plate.json")).unwrap();
    constrained["parts"][0]["features"]
        .as_array_mut()
        .unwrap()
        .push(tag(
            "t",
            "face",
            json!({ "op": "side", "feature": "e1", "curve": "top" }),
            json!("one"),
        ));
    for text in [
        capture_all(plate_with_holes()),
        capture_all(patterned_plate()),
        plate_split_through(),
        two_tops_cut(),
        constrained.to_string(),
    ] {
        let doc = load(&text).unwrap();
        let full = evaluate(&doc);
        for f in &full.features {
            let through = evaluate_through(&doc, &f.feature_id);
            assert_eq!(through.features.last(), Some(f), "{}", f.feature_id);
        }
    }
}

// ---- refFor -------------------------------------------------------------------------------------

fn ref_code(r: Result<Value, Rejection>) -> String {
    match r {
        Ok(v) => panic!("expected a refusal, got {v}"),
        Err(e) => e.code,
    }
}

#[test]
fn ref_for_builds_a_captured_ref_a_fillet_added_after_the_marker_resolves_exactly() {
    let text = plate();
    let pick = json!({ "kind": "edge", "picks": [
        { "kind": "edge", "name": "e1/edge:{e1/cap:end|e1/side:top}", "point": [0.0, 10.0, 6.0] }
    ] });
    // After the extrude (where the app's rollback marker would be): the tags are not built yet.
    let r = ref_for(&text, "p1", Some("e1"), &pick).expect("a ref");
    assert_eq!(r["members"].as_array().unwrap().len(), 1);
    let key = r["members"][0]["key"].as_str().unwrap().to_string();
    assert!(r["ref"]["capture"].is_object(), "{r}");
    // By part name and at the end of the part (after the tags, which make no geometry): the same.
    let at_end = ref_for(&text, "part", None, &pick).expect("a ref");
    assert_eq!(at_end["members"][0]["key"].as_str(), Some(key.as_str()));
    // The ref in a fillet: the engine resolves it to exactly that edge.
    let mut v: Value = serde_json::from_str(&text).unwrap();
    v["parts"][0]["features"]
        .as_array_mut()
        .unwrap()
        .push(json!({
        "type": "fillet", "id": "f1", "name": "f1", "r": 1, "edges": r["ref"].clone() }));
    let rep = report(&v.to_string());
    let e = entry(&rep, "f1", "/edges");
    assert_eq!(e.status, RefStatus::Exact);
    assert_eq!(
        e.members.iter().map(|m| m.key.as_str()).collect::<Vec<_>>(),
        vec![key.as_str()]
    );
}

#[test]
fn ref_for_refuses_unknown_parts_features_and_malformed_requests() {
    let text = plate();
    let ok = json!({ "kind": "face", "picks": [{ "kind": "face", "name": "e1/cap:end" }] });
    assert_eq!(
        ref_code(ref_for(&text, "p9", None, &ok)),
        "COMMAND_UNKNOWN_PART"
    );
    assert_eq!(
        ref_code(ref_for(&text, "p1", Some("nope"), &ok)),
        "COMMAND_UNKNOWN_FEATURE"
    );
    assert_eq!(
        ref_code(ref_for(
            &text,
            "p1",
            None,
            &json!({ "kind": "wire", "picks": [] })
        )),
        "COMMAND_INVALID_ARGUMENT"
    );
    assert_eq!(
        ref_code(ref_for(&text, "p1", None, &json!({ "kind": "face" }))),
        "COMMAND_INVALID_ARGUMENT"
    );
    let bad_name = json!({ "kind": "face", "picks": [{ "kind": "face", "name": "<script>" }] });
    assert_eq!(
        ref_code(ref_for(&text, "p1", None, &bad_name)),
        "COMMAND_INVALID_ARGUMENT"
    );
    let bad_point = json!({ "kind": "face", "picks": [{ "kind": "face", "name": "e1/cap:end", "point": [0, "x", 0] }] });
    assert_eq!(
        ref_code(ref_for(&text, "p1", None, &bad_point)),
        "COMMAND_INVALID_ARGUMENT"
    );
    // Before the extrude (after the sketch) nothing is there to pick.
    assert_eq!(
        ref_code(ref_for(&text, "p1", Some("s1"), &ok)),
        "COMMAND_PICK_NOT_FOUND"
    );
    let body = json!({ "kind": "body", "picks": [{ "kind": "body", "body": { "feature": "e1", "member": "bottom" } }] });
    let b = ref_for(&text, "p1", Some("e1"), &body).expect("a body ref");
    assert_eq!(b["members"][0]["key"], json!("e1/body:bottom"));
}
