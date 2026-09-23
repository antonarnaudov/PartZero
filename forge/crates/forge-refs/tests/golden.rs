//! Determinism across runs **and targets** (W3 acceptance): the `refs` report entries of a
//! fixed set of resolutions (members with probes, unresolved members with candidates, probes
//! and synthesized queries, warnings, errors) are compared byte for byte with a checked-in
//! golden file. The text is written with sorted object keys and serde_json's shortest
//! round-trip numbers, so it does not depend on serde_json's map feature; native and wasm CI
//! both run this test against the same file (compiled in with `include_str!`, so the wasm run
//! needs no preopened directory):
//!
//! ```text
//! cargo test -p forge-refs --test golden
//! cargo test -p forge-refs --release --target wasm32-wasip1 --test golden --no-run
//! node crates/forge-refs/wasm/run_wasi_test.mjs target/wasm32-wasip1/release/deps/golden-<hash>.wasm --nocapture
//! ```
//!
//! (or `CARGO_TARGET_WASM32_WASIP1_RUNNER=wasmtime cargo test … --target wasm32-wasip1`).
//! Regenerate (after an intended change, reviewed in the diff) with
//! `FORGE_UPDATE_GOLDEN=1 cargo test -p forge-refs --test golden`.

mod common;

use std::fmt::Write as _;

use common::{
    OUTLINE, OUTLINE_ZB, RING, d_shape, doc, e1, eval, half_cone, l_shape, plate, r, stadium,
};
use forge_ir::v1::metrics::RefStatus;
use forge_ir::v1::{Cardinality, Ref};
use forge_refs::{FieldSpec, Resolution, Scope, capture, resolve, resolve_with};
use serde_json::{Value, json};

const GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/golden/refs_reports.json"
);

/// The golden file as compiled (the comparison never reads the filesystem).
const GOLDEN_TEXT: &str = include_str!("golden/refs_reports.json");

/// JSON with object keys sorted, two-space indentation, numbers as serde_json prints them.
fn canon(v: &Value, indent: usize, out: &mut String) {
    let pad = "  ".repeat(indent);
    match v {
        Value::Object(m) if !m.is_empty() => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push_str("{\n");
            for (i, k) in keys.iter().enumerate() {
                let _ = write!(out, "{pad}  {}: ", Value::String((*k).clone()));
                canon(&m[*k], indent + 1, out);
                out.push_str(if i + 1 < keys.len() { ",\n" } else { "\n" });
            }
            let _ = write!(out, "{pad}}}");
        }
        Value::Array(a) if !a.is_empty() => {
            out.push_str("[\n");
            for (i, x) in a.iter().enumerate() {
                let _ = write!(out, "{pad}  ");
                canon(x, indent + 1, out);
                out.push_str(if i + 1 < a.len() { ",\n" } else { "\n" });
            }
            let _ = write!(out, "{pad}]");
        }
        other => out.push_str(&other.to_string()),
    }
}

fn captured(r: &Ref, scope: &Scope<'_>) -> Ref {
    let res = resolve(r, scope);
    assert_eq!(res.status, RefStatus::Exact, "{:?}", res.error);
    let mut out = r.clone();
    out.capture = Some(capture(&res.members, scope).expect("capture"));
    out
}

fn entry(name: &str, res: &Resolution) -> Value {
    json!({
        "name": name,
        "report": serde_json::to_value(&res.report).expect("report"),
        "warnings": serde_json::to_value(&res.warnings).expect("warnings"),
        "error": serde_json::to_value(&res.error).expect("error"),
    })
}

fn side(c: &str) -> Ref {
    r(json!({ "kind": "face", "q": { "op": "side", "feature": "e1", "curve": c } }))
}

fn cap_end() -> Ref {
    r(json!({ "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } }))
}

fn planes(card: Value) -> Ref {
    r(
        json!({ "kind": "face", "card": card, "q": { "op": "filter", "where": { "type": "plane" },
        "of": { "op": "faces", "of": { "op": "body", "feature": "e1" } } } }),
    )
}

fn split_bottom() -> common::Model {
    let split = r#"
        { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [0, -10] },
        { "kind": "line", "id": "bottom2", "start": [0, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let mut m = eval(&doc(split, &e1(5.0)));
    let body = common::reprovenance(&m.bodies[0].0, |p| {
        let mut q = common::rename_in(p, "e1/side:bottom2", "e1/side:bottom");
        if q.role == forge_core::topo::Role::Side && q.sources.iter().any(|x| x == "bottom2") {
            q.sources = ["bottom".to_string()].into_iter().collect();
        }
        q
    });
    m.bodies[0].0 = body;
    m
}

/// Every scenario's report entry, in a fixed order.
fn entries() -> Vec<Value> {
    let mut out = Vec::new();
    let a = plate();
    let sa = a.scope();
    let field = |f: &str, card: Cardinality| FieldSpec {
        field: f.into(),
        card,
    };
    // Exact, no capture: members with probes.
    out.push(entry(
        "exact-side",
        &resolve_with(&side("ring"), &sa, &field("/face", Cardinality::ONE)),
    ));
    out.push(entry(
        "exact-planes-some",
        &resolve_with(
            &planes(json!("some")),
            &sa,
            &field("/faces", Cardinality::SOME),
        ),
    ));
    // Repaired / uncertain / missing (step 4).
    let cap = captured(&cap_end(), &sa);
    let zb = eval(&doc(&format!("{OUTLINE_ZB}{RING}"), &e1(5.0)));
    out.push(entry("repaired-cap", &resolve(&cap, &zb.scope())));
    let zb55 = eval(&doc(&format!("{OUTLINE_ZB}{RING}"), &e1(5.5)));
    out.push(entry("uncertain-cap", &resolve(&cap, &zb55.scope())));
    let far = eval(&doc(&format!("{OUTLINE_ZB}{RING}"), &e1(50.0)));
    out.push(entry("missing-cap", &resolve(&cap, &far.scope())));
    // Cardinality: ambiguous (candidates with synthesized queries), cardinality.
    out.push(entry(
        "ambiguous-planes",
        &resolve(&planes(json!("one")), &sa),
    ));
    out.push(entry(
        "cardinality-planes",
        &resolve(&planes(json!(3)), &sa),
    ));
    // Splits.
    let sb = captured(&side("bottom"), &sa);
    let sp = split_bottom();
    out.push(entry("split-one", &resolve(&sb, &sp.scope())));
    let mut some = sb.clone();
    some.card = Some(Cardinality::SOME);
    out.push(entry("split-accepted", &resolve(&some, &sp.scope())));
    // Set changed with a proposal.
    let sides =
        r(json!({ "kind": "face", "card": "some", "q": { "op": "sides", "feature": "e1" } }));
    let sides_c = captured(&sides, &sa);
    let ring2 = r#", { "kind": "circle", "id": "ring2", "center": [-10, 0], "radius": 2 }"#;
    let more = eval(&doc(&format!("{OUTLINE}{RING}{ring2}"), &e1(5.0)));
    out.push(entry("set-changed", &resolve(&sides_c, &more.scope())));
    // A rejected query with capture candidates.
    let renamed = r#"
        { "kind": "line", "id": "b_a", "start": [-20, -10], "end": [0, -10] },
        { "kind": "line", "id": "b_b", "start": [0, -10], "end": [20, -10] },
        { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
        { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
        { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;
    let rn = eval(&doc(renamed, &e1(5.0)));
    out.push(entry("rejected-unknown-curve", &resolve(&sb, &rn.scope())));
    // Junction edges (a "D"), a revolve, smooth and concave edges.
    let d = d_shape();
    let sd = d.scope();
    let junction = r(
        json!({ "kind": "edge", "q": { "op": "edge_at", "feature": "e2", "curve": "bow", "end": "end" } }),
    );
    out.push(entry("junction-edge", &resolve(&junction, &sd)));
    let reversed = eval(
        r#"{ "schema": "aicad.ir/0", "parts": [{ "id": "p1", "name": "part", "features": [
  { "type": "sketch", "id": "s2", "name": "dsk", "plane": "XY", "curves": [
    { "kind": "line", "id": "flat", "start": [3, -4], "end": [3, 4] },
    { "kind": "arc", "id": "bow", "start": [3, -4], "end": [3, 4], "center": [0, 0], "ccw": false } ] },
  { "type": "extrude", "id": "e2", "name": "dee", "sketch": "dsk", "distance": 4 } ] }] }"#,
    );
    out.push(entry(
        "junction-swap",
        &resolve(&captured(&junction, &sd), &reversed.scope()),
    ));
    // Merged: the right side re-keyed, its old key an alias.
    let right = captured(&side("right"), &sa);
    let body = common::reprovenance(&a.bodies[0].0, |p| {
        let mut q = common::rename_in(p, "e1/side:right", "e1/side:rightm");
        if q.role == forge_core::topo::Role::Side && q.sources.iter().any(|x| x == "right") {
            q.sources = ["rightm".to_string()].into_iter().collect();
        }
        q
    });
    let merged = forge_refs::ScopeBuilder::new(a.table.clone())
        .body(&body, a.bodies[0].1.clone())
        .alias("e1/side:right", "e1/side:rightm")
        .build();
    out.push(entry("merged", &resolve(&right, &merged)));
    let cone = half_cone();
    let sc = cone.scope();
    let endcap =
        r(json!({ "kind": "face", "q": { "op": "endcap", "feature": "r1", "end": "end" } }));
    out.push(entry("revolve-endcap", &resolve(&endcap, &sc)));
    let bodies = r(json!({ "kind": "body", "q": { "op": "bodies" } }));
    out.push(entry("revolve-body", &resolve(&bodies, &sc)));
    let st = stadium();
    let smooth = r(
        json!({ "kind": "edge", "card": "some", "q": { "op": "filter", "where": { "smooth": true },
        "of": { "op": "edges", "of": { "op": "body", "feature": "e4" } } } }),
    );
    out.push(entry("smooth-edges", &resolve(&smooth, &st.scope())));
    let l = l_shape();
    let concave = r(
        json!({ "kind": "edge", "q": { "op": "filter", "where": { "concave": true },
        "of": { "op": "edges", "of": { "op": "body", "feature": "e3" } } } }),
    );
    out.push(entry("concave-edge", &resolve(&concave, &l.scope())));
    let vertices = r(
        json!({ "kind": "vertex", "card": 2, "q": { "op": "vertices",
        "of": { "op": "edge_at", "feature": "e3", "curve": "l4", "end": "start" } } }),
    );
    out.push(entry("junction-vertices", &resolve(&vertices, &l.scope())));
    out
}

fn text() -> String {
    let mut s = String::new();
    canon(&Value::Array(entries()), 0, &mut s);
    s.push('\n');
    s
}

#[test]
fn refs_report_entries_match_the_golden_file_byte_for_byte() {
    let now = text();
    assert_eq!(now, text(), "two runs in one process differ");
    if std::env::var_os("FORGE_UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden"))
            .expect("golden dir");
        std::fs::write(GOLDEN, &now).expect("write golden");
        return;
    }
    // Compiled in, so a wasm32-wasip1 run needs no filesystem access (no preopened dirs).
    let golden = GOLDEN_TEXT;
    // One line to compare runs across targets at a glance (`--nocapture`).
    println!(
        "refs golden: {} bytes, fnv1a64 {:016x}",
        now.len(),
        now.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
        })
    );
    if golden != now {
        let line = golden
            .lines()
            .zip(now.lines())
            .position(|(a, b)| a != b)
            .unwrap_or(golden.lines().count().min(now.lines().count()));
        panic!(
            "refs report entries differ from the golden file at line {}:\n  golden: {:?}\n  now:    {:?}",
            line + 1,
            golden.lines().nth(line),
            now.lines().nth(line)
        );
    }
}
