//! The I9 conformance suite (`corpus/v1/conformance/`) as far as W0 can check it: v1 example
//! programs, migration pairs, invalid documents, query typing, compound-curve expansions and
//! hole tool dimensions. Expression fixtures belong to W1 (see `expression_fixtures_*`).
//!
//! Fixtures are append-only after the freeze: a failing case is a bug in the code, or a SPEC
//! change that needs a new case, never an edit of an old one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use forge_ir::v1::{self, LoadError, ValidationError};
use serde_json::{Value, json};

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../corpus/v1")
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// Fixture JSON, numbers correctly rounded (serde_json's default parser is not).
fn fixture(rel: &str) -> Value {
    v1::json::parse(&read(&corpus().join(rel))).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

fn files(rel: &str, suffix: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(corpus().join(rel))
        .unwrap_or_else(|e| panic!("{rel}: {e}"))
        .map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().ends_with(suffix))
        .collect();
    v.sort();
    v
}

/// Load any IR text through the v0/v1 dispatch (SPEC-v1 §0.2 rule 4).
fn load(text: &str) -> Result<v1::Document, LoadError> {
    forge_ir::VersionedDocument::from_json(text).map(forge_ir::VersionedDocument::into_v1)
}

fn code_paths(errs: &[ValidationError]) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = errs
        .iter()
        .map(|e| (e.code.to_string(), e.path.clone()))
        .collect();
    v.sort();
    v
}

fn expected_code_paths(v: &Value) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["code"].as_str().unwrap().to_string(),
                e["path"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    out.sort();
    out
}

// ---- programs -----------------------------------------------------------------------------------

#[test]
fn v1_programs_validate_and_are_canonical() {
    let progs = files("programs", ".json");
    assert!(progs.len() >= 5, "expected v1 programs");
    for p in progs {
        let text = read(&p);
        let doc = v1::from_json(&text).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        let canon = v1::to_json(&doc);
        assert_eq!(
            canon.trim_end(),
            text.trim_end(),
            "{} is not in canonical form",
            p.display()
        );
        let again = v1::from_json(&canon).unwrap();
        assert_eq!(doc, again, "{} did not round-trip", p.display());
    }
}

#[test]
fn canonical_json_omits_context_dependent_defaults() {
    let text = read(&corpus().join("programs/plate_features.json"));
    let mut doc = v1::from_json(&text).unwrap();
    // Write the defaults explicitly; canonical JSON must drop them again.
    let v1::Feature::Fillet(f) = &mut doc.parts[0].features[10] else {
        panic!("feature 10 is the corners fillet")
    };
    f.edges.card = Some(v1::Cardinality::SOME);
    f.tangent_chain = v1::BoolScalar::Bool(true);
    f.v = 1;
    let canon = v1::to_json(&doc);
    assert_eq!(canon.trim_end(), text.trim_end());
    // A non-default card is kept.
    let v1::Feature::Fillet(f) = &mut doc.parts[0].features[10] else {
        unreachable!()
    };
    f.edges.card = Some(v1::Cardinality::ANY);
    assert!(v1::to_json(&doc).contains("\"card\": \"any\""));
}

// ---- migration --------------------------------------------------------------------------------

fn migration_pairs() -> Vec<(PathBuf, PathBuf)> {
    [
        "conformance/migration/programs",
        "conformance/migration/makerbench",
        "conformance/migration/renames",
    ]
    .iter()
    .flat_map(|d| files(d, ".v0.json"))
    .map(|v0| {
        let v1p = PathBuf::from(v0.to_string_lossy().replace(".v0.json", ".v1.json"));
        (v0, v1p)
    })
    .collect()
}

#[test]
fn migration_pairs_match_byte_for_byte() {
    let pairs = migration_pairs();
    assert!(
        pairs.len() >= 8 + 61,
        "8 corpus programs + every MakerBench reference, got {}",
        pairs.len()
    );
    for (v0p, v1p) in pairs {
        let v0 =
            forge_ir::from_json(&read(&v0p)).unwrap_or_else(|e| panic!("{}: {e}", v0p.display()));
        let (m, report) = v1::migrate_v0_to_v1_report(&v0);
        let expected = read(&v1p);
        assert_eq!(
            v1::to_json(&m).trim_end(),
            expected.trim_end(),
            "{}",
            v1p.display()
        );
        assert_eq!(v1::from_json(&expected).unwrap(), m, "{}", v1p.display());
        // The migrated document is a valid v1 document, and migration is idempotent.
        v1::validate(&m).unwrap_or_else(|e| panic!("{}: {e:?}", v1p.display()));
        assert_eq!(load(&v1::to_json(&m)).unwrap(), m);
        assert_eq!(
            load(&read(&v0p)).unwrap(),
            m,
            "v0 text through the dispatch"
        );
        // Renames: exactly those of the fixture (none for the corpus and MakerBench).
        let renames_p = PathBuf::from(v0p.to_string_lossy().replace(".v0.json", ".renames.json"));
        let want = if renames_p.exists() {
            fixture(renames_p.strip_prefix(corpus()).unwrap().to_str().unwrap())
        } else {
            json!({ "renames": [] })
        };
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            want,
            "{}",
            v0p.display()
        );
        if report.renames.is_empty() {
            assert_eq!(
                v1::downgrade_to_v0(&m).unwrap(),
                v0,
                "{}: compatibility path",
                v0p.display()
            );
        }
    }
}

#[test]
fn migration_renames_never_leave_an_invalid_id() {
    for v0p in files("conformance/migration/renames", ".v0.json") {
        let v0 = forge_ir::from_json(&read(&v0p)).unwrap();
        let (m, report) = v1::migrate_v0_to_v1_report(&v0);
        v1::validate(&m).unwrap_or_else(|e| panic!("{}: {e:?}", v0p.display()));
        for r in &report.renames {
            assert!(v1::ids::is_id(&r.to), "{r:?}");
            assert!(
                !v1::ids::is_id(&r.from),
                "{r:?}: only invalid ids are renamed"
            );
        }
    }
}

// ---- invalid documents ------------------------------------------------------------------------

#[test]
fn invalid_documents_are_rejected_with_the_expected_codes_and_paths() {
    let f = fixture("conformance/invalid/documents.json");
    let cases = f["cases"].as_array().unwrap();
    let mut checked = 0;
    let mut w1 = 0;
    for c in cases {
        let id = c["id"].as_str().unwrap();
        let text = serde_json::to_string(&c["document"]).unwrap();
        let result = load(&text);
        if c["parse_error"] == json!(true) {
            assert!(
                matches!(result, Err(LoadError::Parse { .. })),
                "{id}: expected a parse error, got {result:?}"
            );
            checked += 1;
            continue;
        }
        let requires_expr = c["requires"]
            .as_array()
            .is_some_and(|r| r.contains(&json!("expr")));
        let got = match &result {
            Ok(_) => Vec::new(),
            Err(LoadError::Invalid(errs)) => code_paths(errs),
            Err(e) => panic!("{id}: unexpected parse error {e}"),
        };
        if requires_expr {
            // TODO(W1): run these with W1's ExprValidator plugged into ValidateOptions and
            // require an exact match. Without it, W0 must accept them structurally.
            assert!(
                got.is_empty(),
                "{id}: W0 alone should accept it structurally, got {got:?}"
            );
            w1 += 1;
            continue;
        }
        assert_eq!(got, expected_code_paths(&c["expected"]), "{id}");
        checked += 1;
    }
    assert!(
        checked >= 150 && w1 >= 10,
        "checked {checked}, W1 cases {w1}"
    );
}

#[test]
fn every_rejection_code_has_a_fixture() {
    let f = fixture("conformance/invalid/documents.json");
    let mut covered: std::collections::BTreeSet<String> = f["cases"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|c| c["expected"].as_array().cloned().unwrap_or_default())
        .map(|e| e["code"].as_str().unwrap().to_string())
        .collect();
    covered.insert("NON_FINITE".into()); // not expressible in JSON text; programmatic documents only
    for c in v1::codes::CATALOGUE {
        if c.stage.contains('R') && c.since != "v1.1" {
            assert!(
                covered.contains(c.code),
                "no invalid-document fixture for {}",
                c.code
            );
        }
    }
}

#[test]
fn every_code_the_validator_returns_is_in_the_catalogue() {
    let f = fixture("conformance/invalid/documents.json");
    for c in f["cases"].as_array().unwrap() {
        let text = serde_json::to_string(&c["document"]).unwrap();
        if let Err(LoadError::Invalid(errs)) = load(&text) {
            for e in errs {
                let info = v1::codes::info(e.code)
                    .unwrap_or_else(|| panic!("{} not in the catalogue", e.code));
                assert!(
                    info.stage.contains('R'),
                    "{} is returned by validation but is stage {}",
                    e.code,
                    info.stage
                );
                assert!(
                    e.details.is_object(),
                    "{}: details must be an object",
                    e.code
                );
            }
        }
    }
}

#[test]
fn rejected_ids_are_never_echoed() {
    let f = fixture("conformance/invalid/documents.json");
    for c in f["cases"].as_array().unwrap() {
        let text = serde_json::to_string(&c["document"]).unwrap();
        if let Err(LoadError::Invalid(errs)) = load(&text) {
            for e in errs {
                let shown = format!("{} {}", e.message, e.details);
                for needle in ["SYSTEM", "IGNORE", "drop everything", "\n"] {
                    assert!(
                        !shown.contains(needle),
                        "{}: {} echoes {needle:?}: {shown}",
                        c["id"],
                        e.code
                    );
                }
            }
        }
    }
}

// ---- query typing -----------------------------------------------------------------------------

#[test]
fn query_typing_cases() {
    let f = fixture("conformance/queries/typing.json");
    let ctx = &f["context"];
    let n_features = ctx["parts"][0]["features"].as_array().unwrap().len();
    let prefix = format!("/parts/0/features/{n_features}/target");
    let base: v1::Document = serde_json::from_value(ctx.clone()).unwrap();
    v1::validate(&base).unwrap_or_else(|e| panic!("context: {e:?}"));
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() >= 100);
    for c in cases {
        let id = c["id"].as_str().unwrap();
        let mut doc = ctx.clone();
        doc["parts"][0]["features"].as_array_mut().unwrap().push(json!({
            "type": "tag", "id": "tq", "name": "tq", "target": { "kind": c["kind"], "q": c["q"] }
        }));
        let text = serde_json::to_string(&doc).unwrap();
        let got = match load(&text) {
            Ok(_) => Vec::new(),
            Err(LoadError::Invalid(errs)) => code_paths(&errs),
            Err(e) => panic!("{id}: {e}"),
        };
        let want: Vec<(String, String)> = match c.get("errors") {
            None => Vec::new(),
            Some(errs) => {
                let mut v: Vec<(String, String)> = expected_code_paths(errs)
                    .into_iter()
                    .map(|(code, p)| (code, format!("{prefix}{p}")))
                    .collect();
                v.sort();
                v
            }
        };
        assert_eq!(got, want, "{id}");
    }
}

// ---- compound curves ----------------------------------------------------------------------------

fn member_close(got: &Value, want: &Value, tol: Option<f64>, id: &str) {
    match (got, want) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            match tol {
                None => assert_eq!(a.to_bits(), b.to_bits(), "{id}: {a} vs {b} (bit-exact)"),
                Some(t) => assert!((a - b).abs() <= t, "{id}: {a} vs {b} (tolerance {t})"),
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{id}");
            a.iter()
                .zip(b)
                .for_each(|(x, y)| member_close(x, y, tol, id));
        }
        (Value::Object(a), Value::Object(b)) => {
            let ka: Vec<_> = a.keys().collect();
            let kb: Vec<_> = b.keys().collect();
            assert_eq!(ka, kb, "{id}");
            for k in a.keys() {
                member_close(&a[k], &b[k], tol, id);
            }
        }
        (a, b) => assert_eq!(a, b, "{id}"),
    }
}

#[test]
fn compound_curve_expansions() {
    let f = fixture("conformance/compound/expansions.json");
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() >= 40);
    for c in cases {
        let id = c["id"].as_str().unwrap();
        let curve: v1::SketchCurve =
            serde_json::from_value(c["curve"].clone()).unwrap_or_else(|e| panic!("{id}: {e}"));
        let result = v1::validate::expand_literal(&curve).expect("all fields literal");
        match (result, c.get("error")) {
            (Ok(members), None) => {
                let got = serde_json::to_value(&members).unwrap();
                let tol = (c["exact"] == json!(false)).then(|| c["tolerance"].as_f64().unwrap());
                member_close(&got, &c["members"], tol, id);
            }
            (Err(e), Some(want)) => {
                assert_eq!(e.code, want["code"].as_str().unwrap(), "{id}");
                assert_eq!(e.field, want["field"].as_str().unwrap(), "{id}");
            }
            (r, want) => panic!("{id}: got {r:?}, expected {want:?}"),
        }
    }
}

// ---- holes ------------------------------------------------------------------------------------

#[test]
fn hole_tool_dimensions() {
    let f = fixture("conformance/holes/tools.json");
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() >= 50);
    for c in cases {
        let id = c["id"].as_str().unwrap();
        let mut h = c["hole"].clone();
        let o = h.as_object_mut().unwrap();
        o.insert("type".into(), json!("hole"));
        o.insert("id".into(), json!("h1"));
        o.insert("name".into(), json!("holes"));
        o.insert("on".into(), json!({ "face": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } } }));
        o.insert(
            "at".into(),
            json!({ "list": [{ "id": "a", "at": [0, 0] }] }),
        );
        let doc = json!({ "schema": "aicad.ir/1", "parts": [{ "id": "p1", "name": "part", "features": [
            { "type": "sketch", "id": "s1", "name": "base", "plane": "XY",
              "curves": [{ "kind": "rect", "id": "o", "center": [0, 0], "w": 40, "h": 40 }] },
            { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 20 },
            h ] }] });
        let result = load(&serde_json::to_string(&doc).unwrap());
        if let Some(code) = c.get("error") {
            let Err(LoadError::Invalid(errs)) = result else {
                panic!("{id}: expected {code}, got {result:?}")
            };
            assert!(
                errs.iter().any(|e| e.code == code.as_str().unwrap()),
                "{id}: {errs:?}"
            );
            continue;
        }
        let doc = result.unwrap_or_else(|e| panic!("{id}: {e}"));
        let v1::Feature::Hole(hole) = &doc.parts[0].features[2] else {
            unreachable!()
        };
        let t = v1::holes::tool_dims(hole).unwrap_or_else(|| panic!("{id}: no tool"));
        let want = &c["expected"];
        let eq = |a: f64, b: &Value| {
            assert_eq!(
                a.to_bits(),
                b.as_f64().unwrap().to_bits(),
                "{id}: {a} vs {b}"
            )
        };
        eq(t.d, &want["d"]);
        assert_eq!(serde_json::to_value(t.kind).unwrap(), want["kind"], "{id}");
        if let Some(d) = want.get("depth") {
            eq(t.insert_depth.unwrap(), d);
        }
        for (field, got) in [
            ("cbore", t.cbore),
            ("csink", t.csink),
            ("insert", t.insert_depth.map(|dp| (t.d, dp))),
        ] {
            match (want.get(field), got) {
                (None, None) => {}
                (Some(w), Some((a, b))) => {
                    eq(a, &w["d"]);
                    eq(
                        b,
                        if field == "csink" {
                            &w["angle"]
                        } else {
                            &w["depth"]
                        },
                    );
                }
                (w, g) => panic!("{id}: {field} {w:?} vs {g:?}"),
            }
        }
        match (want.get("thread"), t.thread_pitch) {
            (None, None) => {}
            (Some(w), Some(p)) => eq(p, &w["pitch"]),
            (w, g) => panic!("{id}: thread {w:?} vs {g:?}"),
        }
    }
}

// ---- expressions (W1) -------------------------------------------------------------------------

#[test]
fn expression_fixtures_are_well_formed() {
    let f = fixture("conformance/expressions/cases.json");
    let env = f["params"].as_array().unwrap();
    assert!(!env.is_empty());
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() >= 150, "{} expression cases", cases.len());
    let mut ids = std::collections::BTreeSet::new();
    for c in cases {
        let id = c["id"].as_str().unwrap();
        assert!(ids.insert(id), "duplicate case id {id}");
        assert!(c["text"].is_string(), "{id}");
        let field = c["field"].as_str().unwrap();
        assert!(
            ["length", "angle", "ratio", "count", "bool"].contains(&field),
            "{id}: {field}"
        );
        match c.get("error") {
            Some(e) => {
                let code = e["code"].as_str().unwrap();
                let info =
                    v1::codes::info(code).unwrap_or_else(|| panic!("{id}: unknown code {code}"));
                assert!(
                    info.code.starts_with("EXPR_") || info.code.starts_with("PARAM_"),
                    "{id}: {code}"
                );
            }
            None => {
                assert!(c["canonical"].is_string() && c["type"].is_string(), "{id}");
                if let Some(bits) = c.get("bits") {
                    let b =
                        u64::from_str_radix(bits.as_str().unwrap().trim_start_matches("0x"), 16)
                            .unwrap();
                    let v = c["value"].clone();
                    if let Some(x) = v.as_f64() {
                        assert_eq!(x.to_bits(), b, "{id}: value and bits disagree");
                    }
                } else if c.get("value").is_some_and(|v| v.is_number()) {
                    assert!(
                        c["tolerance_rel"].is_number(),
                        "{id}: a real value without bits needs a tolerance"
                    );
                }
            }
        }
    }
}

#[test]
#[ignore = "TODO(W1): needs forge_ir::expr::{parse, canonical, typecheck} and forge_regen::params::evaluate"]
fn expression_fixtures_parse_type_and_evaluate() {
    // TODO(W1): for every case of conformance/expressions/cases.json:
    //   1. parse(text) with the `params` environment in scope (§2.8);
    //   2. canonical(ast) == case.canonical, and parse(canonical) == ast;
    //   3. typecheck gives case.type ("mm", "deg", "1", "mm^2", "flex", "bool", …) and the use-site
    //      check at case.field passes (or fails with case.error.code, stage R);
    //   4. evaluate gives case.value with bits == case.bits (or within tolerance_rel), or fails with
    //      case.error.code at stage E.
    unimplemented!("W1");
}

// ---- constraint vocabulary --------------------------------------------------------------------

#[test]
fn constraints_lower_to_forge_solve_with_the_same_vocabulary() {
    let text = read(&corpus().join("programs/constrained_plate.json"));
    let doc = v1::from_json(&text).unwrap();
    let v1::Feature::Sketch(s) = &doc.parts[0].features[0] else {
        unreachable!()
    };
    let all = [
        json!({ "id": "a", "type": "coincident", "a": "p", "b": "q" }),
        json!({ "id": "b", "type": "horizontal", "line": "l" }),
        json!({ "id": "c", "type": "vertical", "line": "l" }),
        json!({ "id": "d", "type": "parallel", "a": "l", "b": "m" }),
        json!({ "id": "e", "type": "perpendicular", "a": "l", "b": "m" }),
        json!({ "id": "f", "type": "tangent", "a": "l", "b": "c", "internal": true }),
        json!({ "id": "g", "type": "equal", "a": "l", "b": "m" }),
        json!({ "id": "h", "type": "distance", "a": "p", "b": "l", "value": 3.5 }),
        json!({ "id": "i", "type": "angle", "a": "l", "b": "m", "value": 30, "driving": false }),
        json!({ "id": "j", "type": "radius", "curve": "c", "value": 2 }),
        json!({ "id": "k", "type": "diameter", "curve": "c", "value": 4 }),
        json!({ "id": "l2", "type": "point_on_line", "point": "p", "line": "l" }),
        json!({ "id": "m2", "type": "point_on_circle", "point": "p", "curve": "c" }),
        json!({ "id": "n", "type": "midpoint", "point": "p", "line": "l" }),
        json!({ "id": "o", "type": "symmetric", "a": "p", "b": "q", "line": "l" }),
        json!({ "id": "p2", "type": "fix", "entity": "p", "x": 1, "y": 2 }),
    ];
    assert_eq!(all.len(), v1::CONSTRAINT_TYPES.len());
    for (j, t) in all.iter().zip(v1::CONSTRAINT_TYPES) {
        let ir: v1::Constraint = serde_json::from_value(j.clone()).unwrap();
        assert_eq!(ir.type_name(), t);
        // With literal values the IR constraint IS a forge-solve constraint (same JSON).
        let mut literal = j.clone();
        if literal["driving"] == json!(false) {
            // forge-solve requires a value field even on reference dimensions; the IR forbids it.
            literal["value"] = json!(0.0);
        }
        let solve: forge_solve::Constraint =
            serde_json::from_value(literal).unwrap_or_else(|e| panic!("{t}: {e}"));
        assert_eq!(solve.kind.type_name(), t);
        let args: Vec<&str> = ir.arguments().into_iter().map(|(_, id)| id).collect();
        assert_eq!(args, solve.kind.references(), "{t}: argument order");
        assert_eq!(ir.dimension().is_some(), solve.kind.is_dimension(), "{t}");
    }
    assert!(!s.constraints.is_empty());
}

// ---- misc ---------------------------------------------------------------------------------------

#[test]
fn v0_documents_load_through_the_v1_entry_point() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../corpus/programs");
    let mut n = 0;
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        let text = read(&p);
        let doc = v1::from_json(&text).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        assert_eq!(doc.schema, "aicad.ir/1");
        n += 1;
    }
    assert!(n >= 8);
    // Unknown schema.
    let err = v1::from_json(r#"{"schema":"aicad.ir/9","parts":[]}"#).unwrap_err();
    assert_eq!(
        code_paths(err.errors()),
        vec![("UNSUPPORTED_SCHEMA".into(), "/schema".into())]
    );
}

#[test]
fn engines_without_draft_reject_it() {
    let text = read(&corpus().join("programs/shell_box.json"));
    let hook_free = v1::ValidateOptions {
        unsupported_features: &["draft"],
        ..Default::default()
    };
    let err = v1::from_json_with(&text, &hook_free).unwrap_err();
    assert_eq!(
        code_paths(err.errors()),
        vec![(
            "UNSUPPORTED_FEATURE".into(),
            "/parts/0/features/3/type".into()
        )]
    );
}

#[test]
fn expression_sites_carry_field_types() {
    let text = read(&corpus().join("programs/plate_features.json"));
    let doc = v1::from_json(&text).unwrap();
    let sites: BTreeMap<String, v1::FieldType> = v1::expr::expr_sites(&doc)
        .into_iter()
        .map(|s| (s.path, s.field))
        .collect();
    assert_eq!(sites["/parts/0/params/0/value"], v1::FieldType::Length);
    assert_eq!(
        sites["/parts/0/features/0/curves/0/w"],
        v1::FieldType::Length
    );
    assert_eq!(sites["/parts/0/features/1/distance"], v1::FieldType::Length);
    assert_eq!(
        sites["/parts/0/features/5/at/grid/dx"],
        v1::FieldType::Length
    );
    assert_eq!(
        sites["/parts/0/features/13/layout/linear/count"],
        v1::FieldType::Count
    );
    let shell = v1::from_json(&read(&corpus().join("programs/shell_box.json"))).unwrap();
    let sites: BTreeMap<String, v1::FieldType> = v1::expr::expr_sites(&shell)
        .into_iter()
        .map(|s| (s.path, s.field))
        .collect();
    assert_eq!(sites["/parts/0/features/3/suppressed"], v1::FieldType::Bool);
    assert_eq!(sites["/parts/0/features/13/angle"], v1::FieldType::Angle);
}

/// W1's hook is called with every site and its errors are returned.
#[test]
fn expression_hook_is_called() {
    struct Reject;
    impl v1::expr::ExprValidator for Reject {
        fn validate_expressions(
            &self,
            _: &v1::Document,
            sites: &[v1::expr::ExprSite<'_>],
        ) -> Vec<ValidationError> {
            sites
                .iter()
                .map(|s| {
                    ValidationError::new(
                        "EXPR_UNKNOWN_NAME",
                        &s.path,
                        "test",
                        json!({ "name": s.text }),
                    )
                })
                .collect()
        }
    }
    let text = read(&corpus().join("programs/params_plate.json"));
    let opts = v1::ValidateOptions {
        expr: Some(&Reject),
        ..Default::default()
    };
    let err = v1::from_json_with(&text, &opts).unwrap_err();
    assert_eq!(err.errors().len(), 3, "{err}");
}
