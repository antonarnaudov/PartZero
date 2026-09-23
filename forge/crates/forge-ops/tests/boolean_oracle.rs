//! Batch writer for the OCCT boolean differential (`forge-ops/oracle/occt_boolean_diff.py`).
//!
//! ```text
//! BOOLEAN_BATCH_OUT=/tmp/b17.jsonl BOOLEAN_SEED=17 BOOLEAN_COUNT=600 \
//!   cargo test --release -p forge-ops --test boolean_oracle -- --ignored --nocapture
//! ```
//!
//! One JSON line per corpus case: the two operands as `aicad.ir/0` documents (the oracle
//! rebuilds them with its own v0 evaluator), the operation, and Forge's outcome (status,
//! code, and per body the exact metrics from forge-check). A target the operation leaves as
//! it was (`untouched`: a nested join tool) is the geometric result too, so its body is
//! listed with the result bodies (flagged `"untouched": true`); an intersect target inside
//! the tool is a `modified` result body already.

use std::io::Write;
use std::time::Instant;

use forge_ir::v1::metrics::Origin;
use forge_ops::boolean::corpus::cases;
use forge_ops::boolean::{BodyOp, OpBody, apply_body_op};
use serde_json::{Value, json};

fn ob(body: forge_core::topo::Body, feature: &str, timeline: usize) -> OpBody {
    OpBody {
        body,
        origin: Origin {
            feature: feature.into(),
            member: "m".into(),
            instance: None,
        },
        timeline,
    }
}

fn op_name(op: BodyOp) -> &'static str {
    match op {
        BodyOp::Join => "join",
        BodyOp::Cut => "cut",
        BodyOp::Intersect => "intersect",
    }
}

#[test]
#[ignore]
fn write_boolean_oracle_batch() {
    let out = std::env::var("BOOLEAN_BATCH_OUT").unwrap_or_else(|_| "boolean_batch.jsonl".into());
    let seed: u64 = std::env::var("BOOLEAN_SEED").map_or(17, |s| s.parse().expect("seed"));
    let n: usize = std::env::var("BOOLEAN_COUNT").map_or(600, |s| s.parse().expect("count"));
    let mut f = std::fs::File::create(&out).expect("create batch file");
    let mut stats = std::collections::BTreeMap::<String, usize>::new();
    for c in cases(seed, n) {
        let (a, b) = (c.a.build().expect("a"), c.b.build().expect("b"));
        let t = Instant::now();
        let r = apply_body_op(c.op, &[ob(a.clone(), "a", 0)], &[ob(b, "b", 1)], "g");
        let ms = t.elapsed().as_secs_f64() * 1e3;
        let forge: Value = match r {
            Ok(res) => {
                let untouched = (!res.untouched.is_empty()).then_some(&a);
                let bodies: Vec<Value> = res
                    .bodies
                    .iter()
                    .map(|x| (&x.body, false))
                    .chain(untouched.map(|b| (b, true)))
                    .map(|(body, untouched)| {
                        let m = forge_check::body_metrics(body);
                        let valid = forge_check::validate(body)
                            .iter()
                            .all(|i| i.severity != forge_core::topo::Severity::Error);
                        match m {
                            Ok(m) => json!({
                                "volume": m.volume, "area": m.area, "centroid": m.centroid,
                                "faces": m.faces, "edges": m.edges, "shells": body.shell_ids().len(),
                                "face_types": m.face_types, "edge_types": m.edge_types,
                                "valid": valid, "untouched": untouched,
                            }),
                            Err(e) => json!({ "metrics_error": e.to_string(), "valid": false }),
                        }
                    })
                    .collect();
                *stats.entry("ok".into()).or_default() += 1;
                json!({ "status": "ok", "bodies": bodies, "untouched": res.untouched.len(),
                        "uncertified": res.uncertified })
            }
            Err(e) => {
                *stats.entry(e.code().into()).or_default() += 1;
                json!({ "status": "error", "code": e.code(), "message": e.to_string() })
            }
        };
        let line = json!({
            "id": c.id, "family": c.family, "op": op_name(c.op), "ms": ms,
            "a": serde_json::to_value(c.a.document()).expect("doc"),
            "b": serde_json::to_value(c.b.document()).expect("doc"),
            "forge": forge,
        });
        writeln!(f, "{line}").expect("write");
    }
    eprintln!("wrote {out}: {stats:?}");
}
