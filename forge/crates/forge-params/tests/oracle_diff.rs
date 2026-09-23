//! Differential run against an independent expression oracle (IR-V1 plan, W1 acceptance
//! "Oracle agreement"). The oracle dumps its results in the format of
//! `corpus/v1/conformance/expressions/cases.json` (`params` + `cases` with `text`, `field`,
//! then `canonical`, `type`, `value`/`bits`/`tolerance_rel` or `error: { code, stage }`, and
//! `unstable` when a one-ulp change of a libm result changes the outcome), and this test
//! compares Forge case by case: identical codes, canonical text and types; exact values bit for
//! bit; libm-dependent reals within `PARAM_VALUE_REL` (1e-12, SPEC §8.2) or the dump's measured
//! `tolerance_rel`; for `unstable` cases only the static part.
//!
//! The dump comes from the W7a oracle (`oracle/src/aicad_oracle/v1/expr.py`) through
//! `oracle/oracle_dump.py` in this crate (an oracle directory, per the license boundary; seeded, reproducible):
//!
//! ```sh
//! cd oracle && .venv/bin/python ../forge/crates/forge-params/oracle/oracle_dump.py \
//!     --random 80000 --seed 1 > "$TMPDIR/w1_oracle.json"
//! cd ../forge && W1_ORACLE_CASES="$TMPDIR/w1_oracle.json" \
//!     cargo test -p forge-params --test oracle_diff -- --ignored --nocapture
//! ```

#![allow(clippy::float_cmp)] // exact comparisons are the point

use std::collections::BTreeMap;

use forge_ir::v1::expr::{self, ExprScope, canonical, check_use_site, parse, typecheck};
use forge_ir::v1::{self, FieldType, PARAM_VALUE_REL};
use forge_params::{Value, evaluate};
use serde_json::json;

#[test]
#[ignore = "needs an oracle dump: W1_ORACLE_CASES=<cases.json>"]
fn forge_agrees_with_the_oracle() {
    let path = std::env::var("W1_ORACLE_CASES").expect("W1_ORACLE_CASES");
    let f = v1::json::parse(&std::fs::read_to_string(path).unwrap()).unwrap();
    let d: v1::Document =
        serde_json::from_value(json!({ "schema": "aicad.ir/1", "params": f["params"],
        "parts": [{ "id": "p1", "name": "part", "features": [
            { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
                { "kind": "rect", "id": "o", "center": [0, 0], "w": 80, "h": 50 } ] }] }] }))
        .unwrap();
    let pv = evaluate(&d);
    assert!(pv.all_ok(), "the environment must evaluate");
    let env = expr::Env::for_scope(&d, ExprScope::Document);
    let mut diffs: BTreeMap<String, (usize, Vec<String>)> = BTreeMap::new();
    let mut n_unstable = 0usize;
    let cases = f["cases"].as_array().unwrap();
    for c in cases {
        let text = c["text"].as_str().unwrap();
        let field: FieldType = serde_json::from_value(c["field"].clone()).unwrap();
        let want_code = c["error"]["code"].as_str();
        // A one-ulp change of a libm result changes the oracle's outcome (a pole, an
        // integrality or comparison decision, extreme conditioning): only the static part
        // (canonical text, type, acceptance) is comparable.
        let unstable = c["unstable"] == json!(true);
        let mut note = |kind: String, example: String| {
            let e = diffs.entry(kind).or_default();
            e.0 += 1;
            if e.1.len() < 5 {
                e.1.push(example);
            }
        };
        let ast = parse(text);
        if let (Ok(ast), Some(want)) = (&ast, c["canonical"].as_str())
            && canonical(ast) != want
        {
            note(
                "canonical".into(),
                format!("{text:?}: {} vs {want}", canonical(ast)),
            );
        }
        let got = ast.map_err(|_| "EXPR_SYNTAX").and_then(|ast| {
            let t = typecheck(&ast, &env).map_err(|e| e.code)?;
            if let Some(want) = c["type"].as_str()
                && t.notation() != want
            {
                note(
                    "type".into(),
                    format!("{text:?}: {} vs {want}", t.notation()),
                );
            }
            check_use_site(&ast, t, field).map_err(|e| e.code)?;
            if unstable {
                // Statically accepted, like the oracle; the outcome depends on the libm.
                return Ok(Value::Bool(true));
            }
            pv.eval_expr(ExprScope::Document, text, field)
                .map_err(|e| e.code)
        });
        if unstable {
            n_unstable += 1;
            if let Err(g) = got {
                note(
                    format!("code {g} vs a static accept (unstable)"),
                    text.into(),
                );
            }
            continue;
        }
        match (got, want_code) {
            (Err(g), Some(w)) if g == w => {}
            (Err(g), w) => note(format!("code {g} vs {w:?}"), text.into()),
            (Ok(_), Some(w)) => note(format!("value vs {w}"), text.into()),
            (Ok(Value::Bool(b)), None) => {
                if json!(b) != c["value"] {
                    note("bool".into(), text.into());
                }
            }
            (Ok(Value::Num(x)), None) => {
                let want = c["value"].as_f64().unwrap();
                match c["bits"].as_str() {
                    Some(bits) => {
                        let b = u64::from_str_radix(bits.trim_start_matches("0x"), 16).unwrap();
                        if x.to_bits() != b {
                            note("bits".into(), format!("{text:?}: {x:e} vs {want:e}"));
                        }
                    }
                    None => {
                        // Purely relative: the plan's 1e-12, or the dump's `tolerance_rel`
                        // when the expression amplifies one-ulp libm differences more (the
                        // dump measures that by perturbing the oracle's libm results); a floor
                        // only so that two zeros compare equal.
                        let rel = c["tolerance_rel"]
                            .as_f64()
                            .unwrap_or(PARAM_VALUE_REL)
                            .max(PARAM_VALUE_REL);
                        let scale = x.abs().max(want.abs()).max(f64::MIN_POSITIVE);
                        if (x - want).abs() > rel * scale {
                            note("real".into(), format!("{text:?}: {x:e} vs {want:e}"));
                        }
                    }
                }
            }
        }
    }
    let report: Vec<String> = diffs
        .iter()
        .map(|(k, (n, ex))| format!("{k}: {n}\n    {}", ex.join("\n    ")))
        .collect();
    eprintln!(
        "{} cases ({n_unstable} libm-unstable: static part only), {} kinds of difference",
        cases.len(),
        diffs.len()
    );
    assert!(diffs.is_empty(), "{}", report.join("\n"));
}
