//! forge-params: parameters in documents (§2.8), evaluation exactness (§2.7), invariants and
//! property tests (IR-V1 plan, W1 acceptance).

#![allow(clippy::float_cmp)] // exact comparisons are the point

use forge_ir::v1::expr::{self, Env, Expr, ExprScope, canonical, format_number, parse, typecheck};
use forge_ir::v1::metrics::ParamOut;
use forge_ir::v1::{self, FieldType, ParamUnit};
use forge_params::{EvalErrorKind, Value, eval, eval_at, evaluate};
use proptest::prelude::*;
use serde_json::{Value as Json, json};

fn doc(v: Json) -> v1::Document {
    serde_json::from_value(v).unwrap()
}

fn one_part(params: Json, part_params: Json, distance: Json) -> v1::Document {
    doc(json!({ "schema": "aicad.ir/1", "params": params, "parts": [
        { "id": "p1", "name": "plate", "params": part_params, "features": [
            { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
                { "kind": "rect", "id": "o", "center": [0, 0], "w": 80, "h": 50 } ] },
            { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": distance } ] }
    ] }))
}

fn num(text: &str) -> f64 {
    eval(&parse(text).unwrap(), &|_| None)
        .unwrap()
        .as_num()
        .unwrap()
}

fn code(text: &str) -> &'static str {
    eval(&parse(text).unwrap(), &|_| None).unwrap_err().code
}

// ---- exactness (IR-V1 plan W1 acceptance) -----------------------------------------------------

const C30: f64 = 0.8660254037844386;
const H: f64 = std::f64::consts::FRAC_1_SQRT_2;

/// (sin, cos) of the 16 table angles, correctly rounded.
fn table(deg: i64) -> (f64, f64) {
    match deg.rem_euclid(360) {
        0 => (0.0, 1.0),
        30 => (0.5, C30),
        45 => (H, H),
        60 => (C30, 0.5),
        90 => (1.0, 0.0),
        120 => (C30, -0.5),
        135 => (H, -H),
        150 => (0.5, -C30),
        180 => (0.0, -1.0),
        210 => (-0.5, -C30),
        225 => (-H, -H),
        240 => (-C30, -0.5),
        270 => (-1.0, 0.0),
        300 => (-C30, 0.5),
        315 => (-H, H),
        330 => (-0.5, C30),
        d => unreachable!("{d}"),
    }
}

#[test]
fn degree_trig_is_exact_at_multiples_of_30_and_45() {
    let mut n = 0;
    for k in -48i64..=48 {
        for step in [30, 45] {
            let d = k * step;
            let (s, c) = table(d);
            assert_eq!(num(&format!("sin({d})")).to_bits(), s.to_bits(), "sin({d})");
            assert_eq!(num(&format!("cos({d})")).to_bits(), c.to_bits(), "cos({d})");
            // Degrees with a unit, and negated forms, give the same bits.
            assert_eq!(num(&format!("sin({d} deg)")).to_bits(), s.to_bits());
            if c == 0.0 {
                assert_eq!(code(&format!("tan({d})")), "EXPR_DOMAIN", "tan({d})");
            } else {
                let t = num(&format!("tan({d})"));
                // sin / cos, with -0 replaced by +0 (§2.7 rule 8).
                let want = if s / c == 0.0 { 0.0 } else { s / c };
                assert_eq!(t.to_bits(), want.to_bits(), "tan({d})");
                if step == 45 && s != 0.0 {
                    assert_eq!(t.abs(), 1.0, "tan({d})");
                }
            }
            n += 1;
        }
    }
    assert_eq!(n, 2 * 97);
}

#[test]
fn inverse_trig_returns_the_tabulated_values_exactly() {
    for (t, v) in [
        ("asin(0)", 0.0),
        ("asin(0.5)", 30.0),
        ("asin(-0.5)", -30.0),
        ("asin(1)", 90.0),
        ("asin(-1)", -90.0),
        ("acos(1)", 0.0),
        ("acos(0.5)", 60.0),
        ("acos(0)", 90.0),
        ("acos(-0.5)", 120.0),
        ("acos(-1)", 180.0),
        ("atan(0)", 0.0),
        ("atan(1)", 45.0),
        ("atan(-1)", -45.0),
        ("asin(sin(30))", 30.0),
        ("acos(cos(60))", 60.0),
        ("atan(tan(45))", 45.0),
    ] {
        assert_eq!(num(t).to_bits(), f64::to_bits(v), "{t}");
    }
    for y in [-7.5f64, -1.0, 0.0, 2.0, 1e-300] {
        for x in [-7.5f64, -1.0, 0.0, 2.0, 1e-300] {
            let t = format!("atan2({}, {})", fmt_signed(y), fmt_signed(x));
            if y == 0.0 && x == 0.0 {
                assert_eq!(code(&t), "EXPR_DOMAIN");
                continue;
            }
            let r = num(&t);
            assert!(r > -180.0 && r <= 180.0, "{t} = {r}");
            if y == 0.0 || x == 0.0 || y.abs() == x.abs() {
                assert_eq!(r.fract(), 0.0, "{t} = {r} is exact");
            }
        }
    }
}

fn fmt_signed(x: f64) -> String {
    if x < 0.0 {
        format!("-{}", format_number(-x))
    } else {
        format_number(x)
    }
}

#[test]
fn unit_literals_convert_with_one_multiplication() {
    for v in [0.0, 1.0, 2.54, 0.25, 12.5, 1e-3, 7.0 / 3.0, 1e300] {
        let t = format_number(v);
        assert_eq!(num(&format!("{t} mm")).to_bits(), v.to_bits());
        assert_eq!(num(&format!("{t} deg")).to_bits(), v.to_bits());
        let cm = v * 10.0;
        let inch = v * 25.4;
        if cm.is_finite() {
            assert_eq!(num(&format!("{t} cm")).to_bits(), cm.to_bits(), "{t} cm");
        }
        if inch.is_finite() {
            assert_eq!(num(&format!("{t} in")).to_bits(), inch.to_bits(), "{t} in");
        }
    }
    assert_eq!(code("1e308 in"), "EXPR_DOMAIN");
}

#[test]
fn ieee_operations_are_exact_and_domain_errors_are_coded() {
    assert_eq!(num("0.1 + 0.2").to_bits(), (0.1f64 + 0.2).to_bits());
    assert_eq!(num("-7 % 3"), -1.0);
    assert_eq!(num("7 % -3"), 1.0);
    assert_eq!(num("5.5 % 1.25"), 0.5);
    assert_eq!(num("round(2.5)"), 3.0);
    assert_eq!(num("round(-2.5)"), -3.0);
    assert_eq!(num("round(0.49999999999999994)"), 0.0);
    assert_eq!(num("sqrt(2)").to_bits(), 2f64.sqrt().to_bits());
    assert_eq!(num("min(3, 1, 2)"), 1.0);
    assert_eq!(num("max(0, -0)").to_bits(), 0);
    assert_eq!(num("clamp(5, 10, 50)"), 10.0);
    assert_eq!(num("1.1 ^ 20").to_bits(), 6.727499949325609f64.to_bits());
    for t in [
        "1 / 0",
        "0 / 0",
        "5 % 0",
        "sqrt(-1)",
        "tan(90)",
        "tan(-270)",
        "asin(2)",
        "acos(-1.5)",
        "atan2(0, 0)",
        "0 ^ -1",
        "(-8) ^ 0.5",
        "10 ^ 400",
        "2 ^ 1024",
        "clamp(1, 3, 2)",
        "1.7976931348623157e308 * 2",
        "-1.7976931348623157e308 - 1e300",
        "0 ^ -100",
    ] {
        assert_eq!(code(t), "EXPR_DOMAIN", "{t}");
    }
}

// ---- documents (§2.8) ------------------------------------------------------------------------

#[test]
fn parameters_evaluate_in_dependency_order_and_report() {
    let d = one_part(
        json!([
            { "name": "inner", "unit": "mm", "value": "width - 2 * wall" },
            { "name": "width", "unit": "mm", "value": 80, "min": 20, "max": 300 },
            { "name": "wall", "unit": "mm", "value": 2 },
            { "name": "holes", "unit": "count", "value": 4, "min": 1 },
            { "name": "tilt", "unit": "deg", "value": 15 },
            { "name": "with_lid", "unit": "bool", "value": true },
            { "name": "no_lid", "unit": "bool", "value": "!with_lid" },
            { "name": "zeroish", "unit": "mm", "value": "0 * -1" }
        ]),
        json!([{ "name": "margin", "unit": "mm", "value": "min(inner, 50) / 8" }]),
        json!("margin + wall"),
    );
    v1::validate_with(&d, &expr::options()).unwrap();
    let pv = evaluate(&d);
    assert!(pv.all_ok());
    let v = |n: &str| {
        pv.lookup(ExprScope::Part(0), n)
            .unwrap()
            .result
            .clone()
            .unwrap()
    };
    assert_eq!(v("inner"), Value::Num(76.0));
    assert_eq!(v("margin"), Value::Num(6.25));
    assert_eq!(v("no_lid"), Value::Bool(false));
    assert_eq!(v("zeroish").as_num().unwrap().to_bits(), 0);
    let report = pv.report();
    let names: Vec<(&str, &str)> = report
        .iter()
        .map(|r| (r.name.as_str(), r.scope.as_str()))
        .collect();
    assert_eq!(
        names,
        [
            ("inner", "doc"),
            ("width", "doc"),
            ("wall", "doc"),
            ("holes", "doc"),
            ("tilt", "doc"),
            ("with_lid", "doc"),
            ("no_lid", "doc"),
            ("zeroish", "doc"),
            ("margin", "plate")
        ]
    );
    assert_eq!(report[0].value, Some(ParamOut::Num(76.0)));
    assert_eq!(report[6].value, Some(ParamOut::Bool(false)));
    assert!(report.iter().all(|r| r.error.is_none()));
    let j = serde_json::to_value(&report[3]).unwrap();
    assert_eq!(
        j,
        json!({ "name": "holes", "scope": "doc", "unit": "count", "value": 4.0 })
    );
    // Feature fields.
    let v1::Feature::Extrude(e) = &d.parts[0].features[1] else {
        unreachable!()
    };
    assert_eq!(
        pv.scalar(0, e.distance.as_ref().unwrap(), FieldType::Length)
            .unwrap(),
        8.25
    );
    assert!(pv.feature_failure(&d, 0, 1).is_none());
    assert!(
        pv.boolean(0, &v1::BoolScalar::Expr("no_lid || tilt > 10 deg".into()))
            .unwrap()
    );
    // Evaluation order: dependencies first, declaration order among the ready ones.
    let order: Vec<String> = pv
        .order()
        .iter()
        .map(|id| id.get(&d).unwrap().name.clone())
        .collect();
    assert_eq!(
        order,
        [
            "width", "wall", "inner", "holes", "tilt", "with_lid", "no_lid", "zeroish", "margin"
        ]
    );
}

#[test]
fn failures_propagate_as_param_failed_with_the_root_cause() {
    let d = one_part(
        json!([
            { "name": "zero", "unit": "mm", "value": 0 },
            { "name": "a", "unit": "mm", "value": "1 mm / zero * 1 mm" },
            { "name": "b", "unit": "mm", "value": "a * 2" },
            { "name": "c", "unit": "mm", "value": "b + 1" },
            { "name": "d", "unit": "mm", "value": 5, "max": "a" },
            { "name": "e", "unit": "mm", "value": "5", "min": "10" },
            { "name": "f", "unit": "mm", "value": "e" },
            { "name": "g", "unit": "count", "value": "7 / 2" },
            { "name": "h", "unit": "count", "value": "g + 1" },
            { "name": "ok", "unit": "mm", "value": "zero + 1" }
        ]),
        json!([]),
        json!("c"),
    );
    v1::validate_with(&d, &expr::options()).unwrap();
    let pv = evaluate(&d);
    let err = |n: &str| {
        pv.lookup(ExprScope::Document, n)
            .unwrap()
            .result
            .clone()
            .unwrap_err()
    };
    assert_eq!(err("a").code, "EXPR_DOMAIN");
    assert_eq!(err("a").details["subexpr"], json!("1 mm / zero"));
    for n in ["b", "c", "d"] {
        let e = err(n);
        assert_eq!(e.code, "PARAM_FAILED", "{n}");
        assert_eq!(
            Json::Object(e.details),
            json!({ "param": "a", "code": "EXPR_DOMAIN" }),
            "{n}"
        );
    }
    let e = err("e");
    assert_eq!(e.code, "PARAM_OUT_OF_RANGE");
    assert_eq!(
        Json::Object(e.details),
        json!({ "name": "e", "value": 5.0, "min": 10.0, "max": null })
    );
    assert_eq!(
        Json::Object(err("f").details),
        json!({ "param": "e", "code": "PARAM_OUT_OF_RANGE" })
    );
    assert_eq!(err("g").code, "EXPR_NOT_INTEGER");
    assert_eq!(
        Json::Object(err("h").details),
        json!({ "param": "g", "code": "EXPR_NOT_INTEGER" })
    );
    assert!(pv.lookup(ExprScope::Document, "ok").unwrap().result.is_ok());
    assert!(!pv.all_ok());
    // The feature that uses a failed parameter fails with PARAM_FAILED before it runs.
    let f = pv.feature_failure(&d, 0, 1).unwrap();
    assert_eq!(
        (f.code, Json::Object(f.details.clone())),
        (
            "PARAM_FAILED",
            json!({ "param": "a", "code": "EXPR_DOMAIN" })
        )
    );
    let v1::Feature::Extrude(x) = &d.parts[0].features[1] else {
        unreachable!()
    };
    assert_eq!(
        pv.scalar(0, x.distance.as_ref().unwrap(), FieldType::Length)
            .unwrap_err()
            .code,
        "PARAM_FAILED"
    );
    // Report: a failed parameter has an error and no value.
    let r = &pv.report()[1];
    assert!(r.value.is_none());
    assert_eq!(r.error.as_ref().unwrap().code, "EXPR_DOMAIN");
}

#[test]
fn feature_expressions_fail_with_domain_and_integrality_errors() {
    let d = one_part(
        json!([{ "name": "t", "unit": "mm", "value": 8 }]),
        json!([]),
        json!("t - 10"),
    );
    let pv = evaluate(&d);
    // The range check itself is the feature's (INVALID_DISTANCE, §0.5 rule 2); the value is -2.
    let v1::Feature::Extrude(x) = &d.parts[0].features[1] else {
        unreachable!()
    };
    assert_eq!(
        pv.scalar(0, x.distance.as_ref().unwrap(), FieldType::Length)
            .unwrap(),
        -2.0
    );
    assert_eq!(
        pv.eval_expr(ExprScope::Part(0), "t / (t / t - 1)", FieldType::Length)
            .unwrap_err()
            .code,
        "EXPR_DOMAIN"
    );
    assert_eq!(
        pv.eval_expr(ExprScope::Part(0), "t / 3", FieldType::Count)
            .unwrap_err()
            .code,
        "EXPR_UNIT_MISMATCH"
    );
    assert_eq!(
        pv.eval_expr(ExprScope::Part(0), "7 / 2", FieldType::Count)
            .unwrap_err()
            .code,
        "EXPR_NOT_INTEGER"
    );
    assert_eq!(
        pv.eval_expr(ExprScope::Part(0), "2 ^ 31", FieldType::Count)
            .unwrap(),
        Value::Num(2147483648.0)
    );
    // A literal is returned exactly as stored (v0 behaviour, bit for bit).
    assert_eq!(
        pv.scalar(0, &v1::Scalar::Num(-0.0), FieldType::Length)
            .unwrap()
            .to_bits(),
        (-0.0f64).to_bits()
    );
}

#[test]
fn evaluation_of_a_rejected_cyclic_document_fails_loudly() {
    let d = one_part(
        json!([
            { "name": "a", "unit": "mm", "value": "b + 1" },
            { "name": "b", "unit": "mm", "value": "a" },
            { "name": "c", "unit": "mm", "value": "b" },
            { "name": "d", "unit": "mm", "value": 1 }
        ]),
        json!([]),
        json!(8),
    );
    assert!(v1::validate_with(&d, &expr::options()).is_err());
    let pv = evaluate(&d);
    let r = |n: &str| pv.lookup(ExprScope::Document, n).unwrap().result.clone();
    assert_eq!(r("a").unwrap_err().code, "PARAM_CYCLE");
    assert_eq!(r("b").unwrap_err().code, "PARAM_CYCLE");
    assert_eq!(
        Json::Object(r("c").unwrap_err().details),
        json!({ "param": "b", "code": "PARAM_CYCLE" })
    );
    assert_eq!(r("d").unwrap(), Value::Num(1.0));
}

#[test]
fn unvalidated_documents_never_yield_guessed_values() {
    let d = one_part(
        json!([
            { "name": "a", "unit": "mm", "value": "width" },
            { "name": "b", "unit": "mm", "value": "3 deg" },
            { "name": "c", "unit": "bool", "value": 1 },
            { "name": "e", "unit": "count", "value": 2.5 },
            { "name": "f", "unit": "mm", "value": "1 +" }
        ]),
        json!([]),
        json!(8),
    );
    let pv = evaluate(&d);
    let code = |n: &str| {
        pv.lookup(ExprScope::Document, n)
            .unwrap()
            .result
            .clone()
            .unwrap_err()
            .code
    };
    assert_eq!(code("a"), "EXPR_UNKNOWN_NAME");
    assert_eq!(code("b"), "EXPR_UNIT_MISMATCH");
    assert_eq!(code("c"), "EXPR_TYPE_MISMATCH");
    assert_eq!(code("e"), "EXPR_NOT_INTEGER");
    assert_eq!(code("f"), "EXPR_SYNTAX");
}

/// Choices the SPEC leaves open, pinned (each flagged in the W1 report).
#[test]
fn open_spec_choices_are_pinned() {
    // §2.7 rules 3 and 7: the reciprocal of an overflowed `a ^ |b|` is a finite ±0 → 0, not
    // EXPR_DOMAIN (the W7a oracle agrees); a zero `a ^ |b|` is ±∞ → EXPR_DOMAIN.
    assert_eq!(num("1e300 ^ -2").to_bits(), 0);
    assert_eq!(num("(-1e300) ^ -3").to_bits(), 0);
    assert_eq!(code("0 ^ -2"), "EXPR_DOMAIN");
    assert_eq!(code("1e-300 ^ -2"), "EXPR_DOMAIN");
    assert_eq!(code("1e300 ^ 2"), "EXPR_DOMAIN");
    // §2.8: bounds are dependency edges, so a bound cycle blocks both parameters (the document
    // is rejected with PARAM_CYCLE; evaluating it anyway never guesses).
    let d = one_part(
        json!([
            { "name": "a", "unit": "mm", "value": 10, "max": "b" },
            { "name": "b", "unit": "mm", "value": "a * 2" },
            { "name": "c", "unit": "mm", "value": "b" }
        ]),
        json!([]),
        json!(8),
    );
    assert!(v1::validate(&d).is_err());
    let pv = evaluate(&d);
    let r = |n: &str| pv.lookup(ExprScope::Document, n).unwrap().result.clone();
    assert_eq!(r("a").unwrap_err().code, "PARAM_CYCLE");
    assert_eq!(r("b").unwrap_err().code, "PARAM_CYCLE");
    assert_eq!(
        Json::Object(r("c").unwrap_err().details),
        json!({ "param": "b", "code": "PARAM_CYCLE" })
    );
    // §2.1 "bounds of the same type": a count's expression bound must be an exact integer; a
    // bound that fails fails the parameter, and the message names the bound.
    let d = one_part(
        json!([
            { "name": "width", "unit": "mm", "value": 80 },
            { "name": "holes", "unit": "count", "value": 4, "min": "width / 30 mm" },
            { "name": "rows", "unit": "count", "value": 4, "min": "width / 40 mm", "max": "width / 10 mm" }
        ]),
        json!([]),
        json!(8),
    );
    v1::validate(&d).unwrap();
    let pv = evaluate(&d);
    let r = |n: &str| pv.lookup(ExprScope::Document, n).unwrap().result.clone();
    let f = r("holes").unwrap_err();
    assert_eq!(f.code, "EXPR_NOT_INTEGER");
    assert!(f.message.starts_with("bound `min`: "), "{}", f.message);
    assert_eq!(
        Json::Object(f.details),
        json!({ "expr": "width / 30 mm", "value": 2.6666666666666665 })
    );
    assert_eq!(r("rows").unwrap(), Value::Num(4.0));
    // §2.7 rule 8 applies to results: an expression's -0 is +0, a literal is kept as stored.
    let neg0 = v1::Scalar::Expr("-0".into());
    assert_eq!(pv.scalar(0, &neg0, FieldType::Length).unwrap().to_bits(), 0);
    let neg0 = v1::Scalar::Expr("0 * -1 mm".into());
    assert_eq!(pv.scalar(0, &neg0, FieldType::Length).unwrap().to_bits(), 0);
    assert_eq!(
        pv.scalar(0, &v1::Scalar::Num(-0.0), FieldType::Length)
            .unwrap()
            .to_bits(),
        (-0.0f64).to_bits()
    );
}

/// Stack safety of evaluation: the deepest trees the limits allow (a 4096-byte flat chain is
/// ~2048 levels high) evaluate on a 1 MiB stack (the wasm32 default) in a debug build.
#[test]
fn the_deepest_accepted_trees_evaluate_on_a_one_mebibyte_stack() {
    std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(|| {
            let d = one_part(
                json!([
                    { "name": "w", "unit": "mm", "value": 2 },
                    { "name": "on", "unit": "bool", "value": true }
                ]),
                json!([]),
                json!(8),
            );
            let pv = evaluate(&d);
            let at = |t: &str, f: FieldType| {
                assert!(t.len() <= 4096, "{}", t.len());
                pv.eval_expr(ExprScope::Part(0), t, f)
                    .unwrap_or_else(|e| panic!("{e}"))
            };
            let flat = vec!["1"; 2048].join("+");
            assert_eq!(at(&flat, FieldType::Ratio), Value::Num(2048.0));
            assert_eq!(
                at(&vec!["w"; 2000].join("+"), FieldType::Length),
                Value::Num(4000.0)
            );
            assert_eq!(
                at(&vec!["on"; 1000].join("&&"), FieldType::Bool),
                Value::Bool(true)
            );
            let short = format!("{}||on", vec!["w<1"; 800].join("||"));
            assert_eq!(at(&short, FieldType::Bool), Value::Bool(true));
            let mut t = String::from("1");
            for _ in 0..31 {
                t = format!("{}-({t})", "1+".repeat(60));
            }
            assert_eq!(at(&t, FieldType::Ratio), Value::Num(59.0));
            let inner = format!(
                "{}{}{}",
                "(".repeat(64),
                vec!["1"; 1980].join("*"),
                ")".repeat(64)
            );
            assert_eq!(at(&inner, FieldType::Ratio), Value::Num(1.0));
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn the_v1_programs_evaluate() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../corpus/v1/programs");
    let mut n = 0;
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        let text = std::fs::read_to_string(&p).unwrap();
        let d = v1::from_json_with(&text, &expr::options())
            .unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        let pv = evaluate(&d);
        assert!(pv.all_ok(), "{}: {:?}", p.display(), pv.report());
        for (pi, part) in d.parts.iter().enumerate() {
            for fi in 0..part.features.len() {
                assert!(pv.feature_failure(&d, pi, fi).is_none());
            }
            for s in expr::expr_sites(&d)
                .iter()
                .filter(|s| s.scope == ExprScope::Part(pi))
            {
                pv.eval_expr(s.scope, s.text, s.field)
                    .unwrap_or_else(|e| panic!("{}: {}: {e}", p.display(), s.path));
            }
        }
        n += 1;
    }
    assert!(n >= 5);
}

// ---- properties -------------------------------------------------------------------------------

const PARAMS: &[(&str, ParamUnit, f64)] = &[
    ("width", ParamUnit::Mm, 80.0),
    ("depth", ParamUnit::Mm, 50.0),
    ("wall", ParamUnit::Mm, 2.0),
    ("zero", ParamUnit::Mm, 0.0),
    ("neg", ParamUnit::Mm, -3.0),
    ("holes", ParamUnit::Count, 4.0),
    ("tilt", ParamUnit::Deg, 15.0),
    ("half", ParamUnit::Ratio, 0.5),
    ("third", ParamUnit::Ratio, 0.3333333333333333),
];

fn prop_env() -> Env {
    let mut e = Env::new();
    for (n, u, _) in PARAMS {
        e.add_param(n, *u);
    }
    e.add_param("lid", ParamUnit::Bool);
    e.add_param("off", ParamUnit::Bool);
    e
}

fn prop_lookup(name: &str) -> Option<Value> {
    match name {
        "lid" => Some(Value::Bool(true)),
        "off" => Some(Value::Bool(false)),
        _ => PARAMS
            .iter()
            .find(|(n, _, _)| *n == name)
            .map(|(_, _, v)| Value::Num(*v)),
    }
}

fn leaf() -> impl Strategy<Value = Expr> {
    prop_oneof![
        prop::sample::select(vec![
            0.0, 0.5, 1.0, 2.0, 3.0, 30.0, 45.0, 90.0, 1e-9, 7.25, 1e300
        ])
        .prop_map(Expr::num),
        prop::sample::select(vec![
            "width", "depth", "wall", "zero", "neg", "holes", "tilt", "half", "third", "lid",
            "off", "PI"
        ])
        .prop_map(Expr::ident),
        any::<bool>().prop_map(Expr::Bool),
        (
            prop::sample::select(vec![1.0, 2.5, 30.0]),
            prop::sample::select(expr::Unit::ALL.to_vec())
        )
            .prop_map(|(value, u)| Expr::Num {
                value,
                unit: Some(u)
            }),
    ]
}

/// Random trees over the fixture environment; most do not type-check, which is the point:
/// the ones that do must never fail evaluation for a type reason.
fn arb_tree() -> impl Strategy<Value = Expr> {
    leaf().prop_recursive(5, 48, 3, |inner| {
        prop_oneof![
            (
                prop::sample::select(vec![expr::UnaryOp::Neg, expr::UnaryOp::Not]),
                inner.clone()
            )
                .prop_map(|(op, e)| Expr::unary(op, e)),
            (
                prop::sample::select(expr::BinaryOp::ALL.to_vec()),
                inner.clone(),
                inner.clone()
            )
                .prop_map(|(op, a, b)| Expr::binary(op, a, b)),
            (inner.clone(), inner.clone(), inner.clone()).prop_map(|(c, a, b)| Expr::cond(c, a, b)),
            (
                prop::sample::select(expr::FUNCTIONS.iter().map(|(n, _)| *n).collect::<Vec<_>>()),
                prop::collection::vec(inner, 1..4)
            )
                .prop_map(|(n, a)| Expr::call(n, a)),
        ]
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4000))]

    /// The type checker never accepts an expression the evaluator then fails on for a *type*
    /// reason; evaluation is deterministic; results are never -0 and always finite.
    #[test]
    fn well_typed_expressions_evaluate_or_fail_with_a_domain_code(e in arb_tree()) {
        let env = prop_env();
        let Ok(ty) = typecheck(&e, &env) else { return Ok(()) };
        let field = match ty {
            expr::Type::Bool => FieldType::Bool,
            expr::Type::Real(d) if d == expr::Dim::LENGTH => FieldType::Length,
            expr::Type::Real(d) if d == expr::Dim::ANGLE => FieldType::Angle,
            _ => FieldType::Ratio,
        };
        let r1 = eval_at(&e, &prop_lookup, field);
        let r2 = eval_at(&e, &prop_lookup, field);
        prop_assert_eq!(&r1, &r2);
        match r1 {
            Ok(Value::Num(x)) => {
                prop_assert!(x.is_finite());
                prop_assert!(!(x == 0.0 && x.is_sign_negative()), "{}", canonical(&e));
            }
            Ok(Value::Bool(_)) => prop_assert_eq!(field, FieldType::Bool),
            Err(err) => prop_assert!(
                matches!(err.kind, EvalErrorKind::Domain | EvalErrorKind::NotInteger),
                "{}: {:?}", canonical(&e), err
            ),
        }
        // Printing and re-parsing never changes the value.
        let again = parse(&canonical(&e)).unwrap();
        prop_assert_eq!(eval_at(&again, &prop_lookup, field), eval_at(&e, &prop_lookup, field));
    }

    /// Evaluation does not depend on declaration order (only on names and values).
    #[test]
    fn parameter_values_do_not_depend_on_declaration_order(perm in Just((0..6usize).collect::<Vec<_>>()).prop_shuffle()) {
        let ps = [
            json!({ "name": "a", "unit": "mm", "value": "b * 2 + c" }),
            json!({ "name": "b", "unit": "mm", "value": 3.5 }),
            json!({ "name": "c", "unit": "mm", "value": "hypot(b, 4)" }),
            json!({ "name": "d", "unit": "deg", "value": "atan2(b, c)" }),
            json!({ "name": "e", "unit": "ratio", "value": "sin(d) ^ 2 + cos(d) ^ 2" }),
            json!({ "name": "f", "unit": "count", "value": "round(a / b)", "min": 1 }),
        ];
        let shuffled: Vec<Json> = perm.iter().map(|&i| ps[i].clone()).collect();
        let base = evaluate(&one_part(json!(ps.to_vec()), json!([]), json!(8)));
        let other = evaluate(&one_part(json!(shuffled), json!([]), json!(8)));
        for n in ["a", "b", "c", "d", "e", "f"] {
            let x = base.lookup(ExprScope::Document, n).unwrap().result.clone().unwrap();
            let y = other.lookup(ExprScope::Document, n).unwrap().result.clone().unwrap();
            prop_assert_eq!(x.as_num().unwrap().to_bits(), y.as_num().unwrap().to_bits(), "{}", n);
        }
    }
}

// ---- cross-target determinism --------------------------------------------------------------

/// A fixed, seeded corpus of well-typed expressions (own generator: independent of proptest's
/// RNG), evaluated, and hashed. The hash is pinned: it must be the same on macOS, Linux,
/// Windows and wasm32 (IR-V1 plan W1 acceptance, "cross-target").
#[test]
fn seeded_corpus_hash_is_pinned() {
    let mut rng = Rng(0x5eed_0001);
    let env = prop_env();
    let mut hash = 0xcbf29ce484222325_u64;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    };
    let (mut ok, mut failed) = (0, 0);
    for _ in 0..3000 {
        let text = gen_length(&mut rng, 3);
        let e = parse(&text).unwrap_or_else(|err| panic!("{text}: {err:?}"));
        let t = typecheck(&e, &env).unwrap_or_else(|err| panic!("{text}: {err}"));
        assert_eq!(t, expr::Type::LENGTH, "{text}");
        feed(canonical(&e).as_bytes());
        match eval_at(&e, &prop_lookup, FieldType::Length) {
            Ok(v) => {
                feed(&v.as_num().unwrap().to_bits().to_le_bytes());
                ok += 1;
            }
            Err(err) => {
                assert_eq!(err.kind, EvalErrorKind::Domain, "{text}");
                feed(err.code.as_bytes());
                failed += 1;
            }
        }
    }
    assert!(ok > 1000, "{ok} ok, {failed} failed");
    assert_eq!(
        hash, PINNED_HASH,
        "seeded corpus hash changed: {hash:#018x} ({ok} ok, {failed} failed)"
    );
}

/// Computed on aarch64-apple-darwin; every target must reproduce it.
const PINNED_HASH: u64 = 0xae96_e698_c678_5096;

struct Rng(u64);

impl Rng {
    fn next(&mut self, n: u64) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 33) % n) as usize
    }
}

/// A random expression of type length (mm), built from typed productions.
fn gen_length(r: &mut Rng, depth: u32) -> String {
    if depth == 0 {
        return [
            "width", "depth", "wall", "neg", "12 mm", "0.25 in", "2 cm", "zero",
        ][r.next(8)]
        .into();
    }
    let d = depth - 1;
    match r.next(12) {
        0 => format!("({} + {})", gen_length(r, d), gen_length(r, d)),
        1 => format!("({} - ({}))", gen_length(r, d), gen_length(r, d)),
        2 => format!("(({}) * ({}))", gen_length(r, d), gen_ratio(r, d)),
        3 => format!("(({}) / ({}))", gen_length(r, d), gen_ratio(r, d)),
        4 => format!("(hypot({}, {}))", gen_length(r, d), gen_length(r, d)),
        5 => format!("(sqrt(({}) * ({})))", gen_length(r, d), gen_length(r, d)),
        6 => format!("(({}) * sin({}))", gen_length(r, d), gen_angle(r, d)),
        7 => format!(
            "(min({}, {}, {}))",
            gen_length(r, d),
            gen_length(r, d),
            gen_length(r, d)
        ),
        8 => format!("(({}) % ({}))", gen_length(r, d), gen_length(r, d)),
        9 => format!("(round({}))", gen_length(r, d)),
        10 => format!(
            "({} > {} ? {} : {})",
            gen_length(r, d),
            gen_length(r, d),
            gen_length(r, d),
            gen_length(r, d)
        ),
        _ => format!("(abs({}) ^ 1)", gen_length(r, d)),
    }
}

fn gen_ratio(r: &mut Rng, depth: u32) -> String {
    if depth == 0 {
        return ["half", "third", "holes", "3", "0.1", "PI"][r.next(6)].into();
    }
    let d = depth - 1;
    match r.next(6) {
        0 => format!("(({}) / ({}))", gen_length(r, d), gen_length(r, d)),
        1 => format!("(cos({}))", gen_angle(r, d)),
        2 => format!("(tan({}))", gen_angle(r, d)),
        3 => format!("(({}) ^ 2)", gen_ratio(r, d)),
        4 => format!("(({}) ^ half)", gen_ratio(r, d)),
        _ => format!("(({}) * ({}))", gen_ratio(r, d), gen_ratio(r, d)),
    }
}

fn gen_angle(r: &mut Rng, depth: u32) -> String {
    if depth == 0 {
        return ["tilt", "30 deg", "1 deg", "37.5", "-90"][r.next(5)].into();
    }
    let d = depth - 1;
    match r.next(6) {
        0 => format!("(atan2({}, {}))", gen_length(r, d), gen_length(r, d)),
        1 => format!("(asin(({}) / 2))", gen_ratio(r, d)),
        2 => format!("(acos(half * ({})))", gen_ratio(r, d)),
        3 => format!("(atan({}))", gen_ratio(r, d)),
        4 => format!("(({}) * 3 + tilt)", gen_angle(r, d)),
        _ => format!("({} - {})", gen_angle(r, d), gen_angle(r, d)),
    }
}

// ---- canonical numbers against an independent shortest-digit printer -----------------------

/// (digits, n) with value = 0.digits × 10^n, digits without trailing zeros.
fn decompose(s: &str) -> (String, i64) {
    let s = s.trim_start_matches('-');
    let (mant, exp) = match s.split_once(['e', 'E']) {
        Some((m, e)) => (m, e.trim_start_matches('+').parse::<i64>().unwrap()),
        None => (s, 0),
    };
    let (int, frac) = mant.split_once('.').unwrap_or((mant, ""));
    let all = format!("{int}{frac}");
    let lead = all.len() - all.trim_start_matches('0').len();
    let digits = all
        .trim_start_matches('0')
        .trim_end_matches('0')
        .to_string();
    (digits, exp + int.len() as i64 - lead as i64)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20000))]

    /// `format_number` picks the same shortest digits as serde_json's float printer (an
    /// independent shortest round-trip implementation), in ECMAScript layout.
    #[test]
    fn canonical_number_digits_match_an_independent_printer(bits in any::<u64>()) {
        let x = f64::from_bits(bits);
        prop_assume!(x.is_finite() && x != 0.0);
        let ours = format_number(x);
        let theirs = serde_json::to_string(&x).unwrap();
        prop_assert_eq!(decompose(&ours), decompose(&theirs), "{} vs {}", ours, theirs);
        prop_assert_eq!(ours.parse::<f64>().unwrap(), x);
    }
}
