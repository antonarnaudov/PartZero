//! The I9 query-typing fixtures (`corpus/v1/conformance/queries/typing.json`, 134 cases) run
//! through forge-refs' static checker: every `expect` case type-checks to its kind and every
//! `errors` case yields exactly its `{code, path}` multiset (paths relative to the Ref). The
//! same cases are also run through document validation, so the two checkers cannot drift.

use std::path::Path;

use forge_ir::v1::{self, EntityKind, LoadError, Ref};
use forge_refs::{FeatureTable, RefField, check_ref, static_kind};
use serde_json::{Value, json};

fn fixture() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../corpus/v1/conformance/queries/typing.json");
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    v1::json::parse(&text).expect("fixture JSON")
}

fn kind(s: &str) -> EntityKind {
    serde_json::from_value(json!(s)).expect("kind")
}

fn pairs(v: &[(String, String)]) -> Vec<(String, String)> {
    let mut v = v.to_vec();
    v.sort();
    v
}

#[test]
fn query_typing_fixtures_pass_through_forge_refs() {
    let f = fixture();
    let ctx = &f["context"];
    let base: v1::Document = serde_json::from_value(ctx.clone()).expect("context");
    let part = &base.parts[0];
    let table = FeatureTable::from_part(part, part.features.len());
    let cases = f["cases"].as_array().expect("cases");
    assert_eq!(
        cases.len(),
        134,
        "the frozen fixture has 134 cases (append-only)"
    );
    let (mut ok, mut rejected) = (0, 0);
    for c in cases {
        let id = c["id"].as_str().expect("id");
        let r: Ref = serde_json::from_value(json!({ "kind": c["kind"], "q": c["q"] }))
            .unwrap_or_else(|e| panic!("{id}: {e}"));
        let got = check_ref(&r, &RefField::ANY_SOME, &table);
        match (c.get("expect"), c.get("errors")) {
            (Some(k), None) => {
                let k = kind(k.as_str().expect("kind"));
                assert_eq!(got.as_ref().ok(), Some(&k), "{id}: {got:?}");
                assert_eq!(static_kind(&r.q, &table).ok(), Some(k), "{id}");
                ok += 1;
            }
            (None, Some(errs)) => {
                let want: Vec<(String, String)> = errs
                    .as_array()
                    .expect("errors")
                    .iter()
                    .map(|e| {
                        (
                            e["code"].as_str().expect("code").to_string(),
                            e["path"].as_str().expect("path").to_string(),
                        )
                    })
                    .collect();
                let got: Vec<(String, String)> = got
                    .expect_err(id)
                    .iter()
                    .map(|e| (e.code.to_string(), e.path.clone()))
                    .collect();
                assert_eq!(pairs(&got), pairs(&want), "{id}");
                rejected += 1;
            }
            _ => panic!("{id}: needs `expect` or `errors`"),
        }
    }
    assert_eq!(ok + rejected, 134);
}

/// forge-refs and document validation agree on every case (same codes, same paths once the
/// Ref's pointer is prefixed).
#[test]
fn forge_refs_typing_agrees_with_document_validation() {
    let f = fixture();
    let ctx = &f["context"];
    let n = ctx["parts"][0]["features"]
        .as_array()
        .expect("features")
        .len();
    let prefix = format!("/parts/0/features/{n}/target");
    let base: v1::Document = serde_json::from_value(ctx.clone()).expect("context");
    let table = FeatureTable::from_part(&base.parts[0], n);
    for c in f["cases"].as_array().expect("cases") {
        let id = c["id"].as_str().expect("id");
        let mut doc = ctx.clone();
        doc["parts"][0]["features"]
            .as_array_mut()
            .expect("features")
            .push(json!({ "type": "tag", "id": "tq", "name": "tq",
                          "target": { "kind": c["kind"], "q": c["q"] } }));
        let text = serde_json::to_string(&doc).expect("json");
        let from_validation: Vec<(String, String)> =
            match forge_ir::VersionedDocument::from_json(&text) {
                Ok(_) => Vec::new(),
                Err(LoadError::Invalid(errs)) => errs
                    .iter()
                    .map(|e| (e.code.to_string(), e.path.clone()))
                    .collect(),
                Err(e) => panic!("{id}: {e}"),
            };
        let r: Ref =
            serde_json::from_value(json!({ "kind": c["kind"], "q": c["q"] })).expect("ref");
        let from_refs: Vec<(String, String)> = match check_ref(&r, &RefField::ANY_SOME, &table) {
            Ok(_) => Vec::new(),
            Err(errs) => errs
                .iter()
                .map(|e| (e.code.to_string(), format!("{prefix}{}", e.path)))
                .collect(),
        };
        assert_eq!(pairs(&from_refs), pairs(&from_validation), "{id}");
    }
}
