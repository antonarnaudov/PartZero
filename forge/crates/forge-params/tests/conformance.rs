//! The I9 expression suite (`corpus/v1/conformance/expressions/cases.json`), all four steps:
//! parse, canonical text, static type and use-site check (stage R), and evaluation (value bit
//! patterns, or `tolerance_rel` for libm results, or the stage-E code). The fixture values were
//! computed by an independent Python reference implementation: this is the oracle comparison
//! for the evaluator.

#![allow(clippy::float_cmp)] // exact comparisons are the point

use std::path::Path;

use forge_ir::v1::expr::{self, ExprScope, canonical, check_use_site, parse, typecheck};
use forge_ir::v1::{self, FieldType};
use forge_params::{Value, evaluate};
use serde_json::{Value as Json, json};

fn fixture() -> Json {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../corpus/v1/conformance/expressions/cases.json");
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    v1::json::parse(&text).expect("fixture JSON")
}

static PART: std::sync::LazyLock<Json> = std::sync::LazyLock::new(|| {
    json!({ "id": "p1", "name": "part", "features": [
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
            { "kind": "rect", "id": "o", "center": [0, 0], "w": 80, "h": 50 } ] } ] })
});

/// The fixture's environment as a document (all literal document parameters).
fn env_document(f: &Json) -> v1::Document {
    let d = json!({ "schema": "aicad.ir/1", "params": f["params"], "parts": [PART.clone()] });
    let doc: v1::Document = serde_json::from_value(d).unwrap();
    v1::validate_with(&doc, &expr::options()).unwrap_or_else(|e| panic!("environment: {e:?}"));
    doc
}

#[derive(Default, Debug)]
struct Tally {
    total: usize,
    exact: usize,
    tolerance: usize,
    bools: usize,
    rejected: usize,
    eval_errors: usize,
}

/// SPEC-v1 §9.4 / W0's `v1_conformance::expression_fixtures_parse_type_and_evaluate`, all four
/// steps (forge-ir's test of the same name runs steps 1–3: it cannot depend on this crate).
#[test]
fn expression_fixtures_parse_type_and_evaluate() {
    let f = fixture();
    let doc = env_document(&f);
    let values = evaluate(&doc);
    assert!(values.all_ok());
    let env = expr::Env::for_scope(&doc, ExprScope::Document);
    let cases = f["cases"].as_array().unwrap();
    let mut t = Tally::default();
    for c in cases {
        let id = c["id"].as_str().unwrap();
        let text = c["text"].as_str().unwrap();
        let field: FieldType = serde_json::from_value(c["field"].clone()).unwrap();
        let err = c.get("error");
        let code = err.map(|e| e["code"].as_str().unwrap());
        let stage_r = err.is_some_and(|e| e["stage"] == json!("R"));
        t.total += 1;

        // 1. parse
        let ast = match parse(text) {
            Ok(a) => a,
            Err(se) => {
                assert_eq!(
                    code,
                    Some("EXPR_SYNTAX"),
                    "{id}: unexpected syntax error {se:?}"
                );
                assert!(stage_r, "{id}");
                assert_eq!(se.to_error(text).code, "EXPR_SYNTAX");
                t.rejected += 1;
                continue;
            }
        };
        assert_ne!(code, Some("EXPR_SYNTAX"), "{id}: {text:?} parsed");

        // 2. canonical text, a fixed point of parse + print
        if let Some(want) = c.get("canonical") {
            let got = canonical(&ast);
            assert_eq!(got, want.as_str().unwrap(), "{id}: canonical of {text:?}");
            assert_eq!(parse(&got).unwrap(), ast, "{id}: parse(canonical)");
        }

        // 3. static type, then the use-site check
        let ty = match typecheck(&ast, &env) {
            Ok(ty) => ty,
            Err(e) => {
                assert!(stage_r, "{id}: unexpected {e}");
                assert_eq!(Some(e.code), code, "{id}: {e}");
                t.rejected += 1;
                continue;
            }
        };
        if let Some(want) = c.get("type") {
            assert_eq!(
                ty.notation(),
                want.as_str().unwrap(),
                "{id}: type of {text:?}"
            );
        }
        let use_site = check_use_site(&ast, ty, field);
        if stage_r {
            let e = use_site.expect_err(id);
            assert_eq!(Some(e.code), code, "{id}: {e}");
            t.rejected += 1;
            continue;
        }
        use_site.unwrap_or_else(|e| panic!("{id}: {e}"));

        // 4. evaluation
        let got = values.eval_expr(ExprScope::Document, text, field);
        match (got, err) {
            (Err(e), Some(want)) => {
                assert_eq!(e.code, want["code"].as_str().unwrap(), "{id}: {e}");
                assert_eq!(want["stage"], json!("E"), "{id}");
                t.eval_errors += 1;
            }
            (Err(e), None) => panic!("{id}: {text:?} failed: {e}"),
            (Ok(v), Some(want)) => panic!("{id}: {text:?} = {v:?}, expected {want}"),
            (Ok(Value::Bool(b)), None) => {
                assert_eq!(json!(b), c["value"], "{id}");
                t.bools += 1;
            }
            (Ok(Value::Num(x)), None) => {
                let want = c["value"].as_f64().unwrap();
                if let Some(bits) = c.get("bits") {
                    let bits =
                        u64::from_str_radix(bits.as_str().unwrap().trim_start_matches("0x"), 16)
                            .unwrap();
                    assert_eq!(
                        x.to_bits(),
                        bits,
                        "{id}: {text:?} = {x:e}, expected {want:e}"
                    );
                    t.exact += 1;
                } else {
                    let rel = c["tolerance_rel"]
                        .as_f64()
                        .unwrap_or_else(|| panic!("{id}: no bits, no tolerance"));
                    assert!(
                        (x - want).abs() <= rel * want.abs().max(f64::MIN_POSITIVE),
                        "{id}: {text:?} = {x:e}, expected {want:e} ± {rel}"
                    );
                    t.tolerance += 1;
                }
                // Never -0 (§2.7 rule 8).
                assert!(!(x == 0.0 && x.is_sign_negative()), "{id}");
            }
        }
    }
    assert_eq!(t.total, cases.len());
    assert!(t.total >= 376, "{t:?}");
    assert_eq!(
        t.exact + t.tolerance + t.bools + t.rejected + t.eval_errors,
        t.total,
        "{t:?}"
    );
    eprintln!("expression fixtures: {t:?}");
}

/// The fixture's type/value cases, evaluated as the value of a derived parameter of the
/// matching unit: the same results through the document path (§2.8).
#[test]
fn fixtures_as_derived_parameters() {
    let f = fixture();
    let mut n = 0;
    for c in f["cases"].as_array().unwrap() {
        if c.get("error").is_some() {
            continue;
        }
        let unit = match c["field"].as_str().unwrap() {
            "length" => "mm",
            "angle" => "deg",
            "ratio" => "ratio",
            "bool" => "bool",
            _ => "count",
        };
        let mut params = f["params"].as_array().unwrap().clone();
        params.push(json!({ "name": "derived_", "unit": unit, "value": c["text"] }));
        let d: v1::Document = serde_json::from_value(
            json!({ "schema": "aicad.ir/1", "params": params, "parts": [PART.clone()] }),
        )
        .unwrap();
        v1::validate_with(&d, &expr::options()).unwrap_or_else(|e| panic!("{}: {e:?}", c["id"]));
        let pv = evaluate(&d);
        let e = pv.lookup(ExprScope::Document, "derived_").unwrap();
        let v = e
            .result
            .clone()
            .unwrap_or_else(|f| panic!("{}: {f}", c["id"]));
        if let Value::Bool(b) = v {
            assert_eq!(json!(b), c["value"], "{}", c["id"]);
            n += 1;
            continue;
        }
        let x = v.as_num().unwrap();
        let want = c["value"].as_f64().unwrap();
        if c.get("bits").is_some() {
            assert_eq!(x.to_bits(), want.to_bits(), "{}", c["id"]);
        } else {
            assert!((x - want).abs() <= 1e-15 * want.abs(), "{}", c["id"]);
        }
        n += 1;
    }
    assert!(n >= 200, "{n}");
}
