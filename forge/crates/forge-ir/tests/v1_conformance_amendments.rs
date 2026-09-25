//! The I9 fixtures of the Phase B contract amendments (SPEC-v1 §11.1, [W0-19] … [W0-54]) that
//! need an evaluation, run through Forge's evaluator of record (forge-regen, a dev-dependency):
//! - `expressions/parameters.json`: parameter and field outcomes ([W0-20] string literals,
//!   [W0-23] exponent overflow, [W0-24] `-0`, [W0-25] bounds, [W0-27] `PARAM_FAILED`,
//!   [W0-46] the `expr`/`subexpr` details are canonical text);
//! - `booleans/identity.json`: body-operation identity ([W0-39] `modified`, [W0-40] `removed`,
//!   [W0-41] contacts, degenerate pieces and the smallest cut, [R-3] coincidence first, [W0-48]
//!   one measure for contacts and meets, [W0-53] regions wider than *tol* are volume; the
//!   per-tool failure row of the §6.0.3 table);
//! - `booleans/section-types.json`: section edge types ([W0-43] pair list, [W0-51] the plane–cone
//!   test, [W0-52] each engine's own curve within *tol* of the conic);
//! - `references/probes.json`: member probes ([W0-50] edge normals, [W0-54] none at a cusp).
//!
//! The expression and validation amendments ([W0-19] … [W0-26], [W0-45] … [W0-47]) are
//! appended to `expressions/cases.json` and `invalid/documents.json` and run by
//! `v1_conformance.rs` (and by forge-params' own conformance test for the values); [W0-24]'s
//! literal feature fields by the `migration/literals` pair of `v1_conformance.rs`.
//!
//! A ruling that changed an engine's behaviour is pending until that engine implements it: the
//! `FORGE_PENDING_*` lists name the cases Forge does not follow yet **with the outcome Forge
//! produces today**, in the fixture's own format. The tests assert that a pending case still
//! differs from the fixture and still gives exactly that recorded outcome, so a regression that
//! breaks a pending case differently is caught, and an id must leave its list (by the workstream
//! that aligns Forge) as soon as Forge passes it. Fixtures are append-only (SPEC-v1 §9.4).

use std::collections::BTreeSet;
use std::path::Path;

use forge_ir::v1;
use serde_json::Value;

fn fixture(rel: &str) -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../corpus/v1/conformance")
        .join(rel);
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    v1::json::parse(&text).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

/// The `aicad.metrics/1` report of a fixture document (which must load: every case is valid).
fn evaluate(id: &str, doc: &Value) -> Value {
    let text = serde_json::to_string(doc).unwrap();
    let (report, ev) = forge_regen::v1::evaluate_text(&text, "forge conformance", id);
    assert!(ev.is_some(), "{id}: rejected: {:?}", report.error);
    serde_json::to_value(&report).unwrap()
}

fn feature<'a>(report: &'a Value, id: &str) -> Option<&'a Value> {
    report["features"]
        .as_array()?
        .iter()
        .find(|f| f["feature_id"] == id)
}

/// A case Forge does not follow yet: why, and the outcome Forge's report has today, as JSON in
/// the fixture's own format (`{ "params", "features" }` for parameters, the `expect` object for
/// booleans, section types and probes).
struct Pending {
    id: &'static str,
    why: &'static str,
    forge_now: &'static str,
}

fn pending<'a>(list: &'a [Pending], id: &str) -> Option<&'a Pending> {
    list.iter().find(|p| p.id == id)
}

/// Checks one case against its fixture and, when pending, against Forge's recorded outcome.
fn judge(
    id: &str,
    list: &[Pending],
    list_name: &str,
    problems: impl Fn(&Value) -> Vec<String>,
    want: &Value,
    failures: &mut Vec<String>,
) {
    let problems_vs_fixture = problems(want);
    match (problems_vs_fixture.is_empty(), pending(list, id)) {
        (true, None) => {}
        (false, None) => failures.push(format!("{id}: {problems_vs_fixture:?}")),
        (true, Some(_)) => failures.push(format!(
            "{id}: Forge now follows the ruling: remove it from {list_name}"
        )),
        (false, Some(p)) => {
            let now: Value = serde_json::from_str(p.forge_now)
                .unwrap_or_else(|e| panic!("{id}: {list_name} forge_now: {e}"));
            let drift = problems(&now);
            if drift.is_empty() {
                eprintln!("pending ({}) {id}: {problems_vs_fixture:?}", p.why);
            } else {
                failures.push(format!(
                    "{id}: pending, but Forge's outcome is no longer the recorded one: {drift:?}"
                ));
            }
        }
    }
}

/// `want` ⊆ `got` for the keys `want` lists (numbers compared as binary64, bit for bit). A
/// `null` in the fixture means the key is **absent** (§9.4): a present `null` does not match it.
fn details_mismatch(got: &Value, want: &Value) -> Option<String> {
    let want = want.as_object()?;
    for (k, w) in want {
        let g = got.get(k);
        let same = match (g, w) {
            (None, Value::Null) => true,
            (Some(_), Value::Null) | (None, _) => false,
            (Some(g), w) => match (g.as_f64(), w.as_f64()) {
                (Some(a), Some(b)) => a.to_bits() == b.to_bits(),
                _ => g == w,
            },
        };
        if !same {
            let g = g.map_or_else(|| "absent".to_owned(), Value::to_string);
            return Some(format!("details.{k}: {g} != {w}"));
        }
    }
    None
}

/// An `error` entry of a report against the fixture's `{ code, details? }`.
fn error_mismatch(got: &Value, want: &Value) -> Option<String> {
    if got["code"] != want["code"] {
        return Some(format!("code {} != {}", got["code"], want["code"]));
    }
    details_mismatch(&got["details"], &want["details"])
}

// ---- expressions/parameters.json ----------------------------------------------------------------

/// Cases of `expressions/parameters.json` Forge does not follow yet (none).
const FORGE_PENDING_PARAMETERS: &[Pending] = &[];

/// A report against a case's `{ "params", "features" }` expectations.
fn parameter_problems(r: &Value, want: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(params) = want["params"].as_object() {
        for (name, want) in params {
            let Some(got) = r["params"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["name"] == name.as_str())
            else {
                out.push(format!("{name}: not reported"));
                continue;
            };
            if let Some(w) = want.get("error") {
                match got.get("error") {
                    Some(g) => {
                        if let Some(m) = error_mismatch(g, w) {
                            out.push(format!("{name}: {m}"));
                        }
                    }
                    None => out.push(format!("{name}: ok ({}), expected {w}", got["value"])),
                }
            } else {
                let bits = want["bits"].as_str().unwrap().trim_start_matches("0x");
                let bits = u64::from_str_radix(bits, 16).unwrap();
                match got["value"].as_f64() {
                    Some(x) if x.to_bits() == bits => {}
                    _ => out.push(format!("{name}: {got}, expected bits {bits:#018x}")),
                }
            }
        }
    }
    if let Some(features) = want["features"].as_object() {
        for (fid, want) in features {
            let Some(got) = feature(r, fid) else {
                out.push(format!("{fid}: no feature entry"));
                continue;
            };
            if got["status"] != want["status"] {
                out.push(format!(
                    "{fid}: status {} != {}",
                    got["status"], want["status"]
                ));
            } else if let Some(w) = want.get("error")
                && let Some(m) = error_mismatch(&got["error"], w)
            {
                out.push(format!("{fid}: {m}"));
            }
        }
    }
    out
}

/// SPEC-v1 [W0-20], [W0-23], [W0-24], [W0-25], [W0-27].
#[test]
fn parameter_evaluation_fixtures() {
    let f = fixture("expressions/parameters.json");
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() >= 6);
    let mut failures = Vec::new();
    for c in cases {
        let id = c["id"].as_str().unwrap();
        let r = evaluate(id, &c["document"]);
        let want = serde_json::json!({ "params": c["params"], "features": c["features"] });
        judge(
            id,
            FORGE_PENDING_PARAMETERS,
            "FORGE_PENDING_PARAMETERS",
            |w| parameter_problems(&r, w),
            &want,
            &mut failures,
        );
    }
    for p in FORGE_PENDING_PARAMETERS {
        assert!(
            cases.iter().any(|c| c["id"] == p.id),
            "FORGE_PENDING_PARAMETERS names an unknown case {}",
            p.id
        );
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// SPEC-v1 [W0-45]: a fixture compares only the detail keys the §7.5 catalogue
/// (`ERROR_CODES`) defines for the code, so no engine has to copy another's extra details.
#[test]
fn fixture_details_keys_are_in_the_catalogue() {
    let f = fixture("expressions/parameters.json");
    let mut errors: Vec<(String, &Value)> = Vec::new();
    for c in f["cases"].as_array().unwrap() {
        let id = c["id"].as_str().unwrap();
        for section in ["params", "features"] {
            for (name, want) in c[section].as_object().into_iter().flatten() {
                if let Some(e) = want.get("error") {
                    errors.push((format!("{id}: {section}.{name}"), e));
                }
            }
        }
    }
    assert!(!errors.is_empty());
    for (at, e) in errors {
        let code = e["code"].as_str().unwrap();
        let info = v1::codes::info(code).unwrap_or_else(|| panic!("{at}: unknown code {code}"));
        for k in e["details"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(k, _)| k)
        {
            assert!(
                info.details.contains(&k.as_str()),
                "{at}: {code} detail `{k}` is not in the catalogue ({:?})",
                info.details
            );
        }
    }
}

// ---- booleans/identity.json ---------------------------------------------------------------------

/// The oracle-computable semantic warning codes of SPEC-v1 §8.2 (the only ones the fixture
/// constrains; engine-prefixed notes such as `FORGE_BOOLEAN_NO_CHANGE` are not compared).
const SEMANTIC_WARNINGS: [&str; 5] = [
    "BOOLEAN_SPLIT",
    "BOOLEAN_BODY_CONSUMED",
    "HOLE_BREAKS_THROUGH",
    "PATTERN_INSTANCE_SKIPPED",
    "SHELL_CLOSED_VOID",
];

/// Cases of `booleans/identity.json` Forge does not follow yet (W4 / forge-regen aligns), with
/// the outcome Forge produces today.
const FORGE_PENDING_BOOLEANS: &[Pending] = &[
    Pending {
        id: "join-identical-tool-modifies-its-target",
        why: "[W0-39]: Forge leaves an unchanged join target untouched (FORGE_BOOLEAN_NO_CHANGE)",
        forge_now: r#"{"e2": {"status": "ok", "bodies": [], "removed": [], "warnings": []}}"#,
    },
    Pending {
        id: "join-tool-inside-its-target-modifies-it",
        why: "[W0-39]: as above, for tools inside or flush with the target",
        forge_now: r#"{"e2": {"status": "ok", "bodies": [], "removed": [], "warnings": []},
                       "e3": {"status": "ok", "bodies": [], "removed": [], "warnings": []}}"#,
    },
    Pending {
        id: "consumed-piece-with-a-surviving-sibling-removes-nothing",
        why: "[W0-40]: Forge lists a consumed piece's origin although its sibling survives",
        forge_now: r#"{"e3": {"status": "ok", "bodies": [],
                              "removed": [{"feature": "e1", "member": "r.bottom"}],
                              "warnings": ["BOOLEAN_BODY_CONSUMED"]}}"#,
    },
    Pending {
        id: "a-target-edge-within-tolerance-of-a-cut-face-is-a-contact",
        why: "[W0-41] (1): Forge snaps aligned faces only, and cuts a target edge 8e-7 mm inside \
              an oblique tool face (a sub-tolerance chamfer face) instead of treating it as a contact",
        forge_now: r#"{"e2": {"status": "ok",
                              "bodies": [{"origin": {"feature": "e1", "member": "a.bottom"},
                                          "change": "modified"}],
                              "removed": [], "warnings": []}}"#,
    },
    Pending {
        id: "an-embedded-join-tool-1.5e-6-thin-modifies-its-target",
        why: "[W0-39] with [W0-48]: as `join-tool-inside-its-target-modifies-it`, Forge leaves \
              the unchanged target untouched (FORGE_BOOLEAN_NO_CHANGE)",
        forge_now: r#"{"e2": {"status": "ok", "bodies": [], "removed": [], "warnings": []}}"#,
    },
    Pending {
        id: "a-target-vertex-1.2e-6-inside-a-tool-face-is-cut",
        why: "[W0-48]: Forge fails the cut of a target corner 1.2e-6 mm inside an oblique tool \
              face (an explicit failure, never a wrong body; W4)",
        forge_now: r#"{"e2": {"status": "error", "code": "FORGE_BOOLEAN_INCONSISTENT"}}"#,
    },
    Pending {
        id: "a-through-pin-1.5e-6-square-cuts-a-hole",
        why: "[W0-48]: Forge fails a through-hole whose walls are 1.5e-6 mm apart (an explicit \
              failure, never a wrong body; W4)",
        forge_now: r#"{"e2": {"status": "error", "code": "FORGE_BOOLEAN_INCONSISTENT"}}"#,
    },
    Pending {
        id: "a-cut-tool-covering-a-1.5e-6-fin-exactly-removes-it",
        why: "[W0-53]: Forge fails a cut whose tool covers a 1.5e-6 mm fin of the target on both \
              sides (an explicit failure, never a wrong body; W4)",
        forge_now: r#"{"e2": {"status": "error", "code": "FORGE_BOOLEAN_NEAR_COINCIDENT"}}"#,
    },
];

fn sorted_json(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = v
        .as_array()
        .map(|a| a.iter().map(Value::to_string).collect())
        .unwrap_or_default();
    out.sort();
    out
}

/// A report against a case's `expect` object.
fn boolean_problems(r: &Value, expect: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for (fid, want) in expect.as_object().unwrap() {
        let Some(got) = feature(r, fid) else {
            out.push(format!("{fid}: no feature entry"));
            continue;
        };
        if got["status"] != want["status"] {
            out.push(format!(
                "{fid}: status {} != {} ({})",
                got["status"], want["status"], got["error"]
            ));
            continue;
        }
        if want["status"] == "error" {
            if got["error"]["code"] != want["code"] {
                out.push(format!(
                    "{fid}: code {} != {}",
                    got["error"]["code"], want["code"]
                ));
            }
            continue;
        }
        let bodies = |v: &Value| -> Vec<String> {
            let mut b: Vec<String> = v
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|b| format!("{} {}", b["origin"], b["change"]))
                        .collect()
                })
                .unwrap_or_default();
            b.sort();
            b
        };
        if bodies(&got["bodies"]) != bodies(&want["bodies"]) {
            out.push(format!(
                "{fid}: bodies {:?} != {:?}",
                bodies(&got["bodies"]),
                bodies(&want["bodies"])
            ));
        }
        if sorted_json(&got["removed"]) != sorted_json(&want["removed"]) {
            out.push(format!(
                "{fid}: removed {} != {}",
                got["removed"], want["removed"]
            ));
        }
        let codes: BTreeSet<&str> = got["warnings"]
            .as_array()
            .map(|w| {
                w.iter()
                    .filter_map(|w| w["code"].as_str())
                    .filter(|c| SEMANTIC_WARNINGS.contains(c))
                    .collect()
            })
            .unwrap_or_default();
        let want_codes: BTreeSet<&str> = want["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w.as_str().unwrap())
            .collect();
        if codes != want_codes {
            out.push(format!("{fid}: warnings {codes:?} != {want_codes:?}"));
        }
    }
    out
}

/// SPEC-v1 [W0-39], [W0-40], [W0-41] ([R-3] coincidence first), [W0-48], [W0-53] and the §6.0.3
/// table.
#[test]
fn boolean_identity_fixtures() {
    let f = fixture("booleans/identity.json");
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() >= 33);
    let mut ids = BTreeSet::new();
    let mut failures = Vec::new();
    for c in cases {
        let id = c["id"].as_str().unwrap();
        assert!(ids.insert(id), "duplicate case id {id}");
        let r = evaluate(id, &c["document"]);
        judge(
            id,
            FORGE_PENDING_BOOLEANS,
            "FORGE_PENDING_BOOLEANS",
            |w| boolean_problems(&r, w),
            &c["expect"],
            &mut failures,
        );
    }
    for p in FORGE_PENDING_BOOLEANS {
        assert!(
            ids.contains(p.id),
            "FORGE_PENDING_BOOLEANS names an unknown case {}",
            p.id
        );
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// The indices of the `n_want` expected entries left unmatched by a maximum matching to distinct
/// returned entries (`n_got`) under `fits` (Kuhn's augmenting paths): a multiset comparison in
/// which one returned entry never satisfies two expected ones.
fn unmatched(n_want: usize, n_got: usize, fits: impl Fn(usize, usize) -> bool) -> Vec<usize> {
    fn augment(
        w: usize,
        fits: &dyn Fn(usize, usize) -> bool,
        owner: &mut [Option<usize>],
        seen: &mut [bool],
    ) -> bool {
        for g in 0..owner.len() {
            if seen[g] || !fits(w, g) {
                continue;
            }
            seen[g] = true;
            let free = match owner[g] {
                None => true,
                Some(o) => augment(o, fits, owner, seen),
            };
            if free {
                owner[g] = Some(w);
                return true;
            }
        }
        false
    }
    let mut owner = vec![None; n_got];
    (0..n_want)
        .filter(|&w| !augment(w, &fits, &mut owner, &mut vec![false; n_got]))
        .collect()
}

// ---- booleans/section-types.json ----------------------------------------------------------------

/// Cases of `booleans/section-types.json` Forge does not follow yet (none: forge-ssi already types
/// the near-miss sections `bspline`; W4 must keep [W0-52]'s check (b) when it types sections by
/// the pair list of [W0-43], or `crossing-cylinders-8e-7-…` and `a-sphere-0.9e-6-…` break).
const FORGE_PENDING_SECTIONS: &[Pending] = &[];

/// A report against a case's `expect` object: `status` (and `code`), then each listed
/// `edge_types` count summed over the feature entry's bodies (types not listed are not compared).
fn section_problems(r: &Value, expect: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for (fid, want) in expect.as_object().unwrap() {
        let Some(got) = feature(r, fid) else {
            out.push(format!("{fid}: no feature entry"));
            continue;
        };
        if got["status"] != want["status"] {
            out.push(format!(
                "{fid}: status {} != {} ({})",
                got["status"], want["status"], got["error"]
            ));
            continue;
        }
        if want["status"] == "error" {
            if got["error"]["code"] != want["code"] {
                out.push(format!(
                    "{fid}: code {} != {}",
                    got["error"]["code"], want["code"]
                ));
            }
            continue;
        }
        for (ty, n) in want["edge_types"].as_object().unwrap() {
            let have: u64 = got["bodies"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|b| b["edge_types"][ty].as_u64().unwrap_or(0))
                .sum();
            if Some(have) != n.as_u64() {
                out.push(format!("{fid}: edge_types.{ty} {have} != {n}"));
            }
        }
    }
    out
}

/// SPEC-v1 §8.3 rule 3: [W0-43] the pair list, [W0-51] the plane–cone test, [W0-52] each
/// engine's own curve within *tol* of the conic (a near-miss pair is not a conic).
#[test]
fn section_type_fixtures() {
    let f = fixture("booleans/section-types.json");
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() >= 8);
    let mut ids = BTreeSet::new();
    let mut failures = Vec::new();
    for c in cases {
        let id = c["id"].as_str().unwrap();
        assert!(ids.insert(id), "duplicate case id {id}");
        let r = evaluate(id, &c["document"]);
        judge(
            id,
            FORGE_PENDING_SECTIONS,
            "FORGE_PENDING_SECTIONS",
            |w| section_problems(&r, w),
            &c["expect"],
            &mut failures,
        );
    }
    for p in FORGE_PENDING_SECTIONS {
        assert!(
            ids.contains(p.id),
            "FORGE_PENDING_SECTIONS names an unknown case {}",
            p.id
        );
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

// ---- references/probes.json ---------------------------------------------------------------------

/// Cases of `references/probes.json` Forge does not follow yet, with its probes today.
const FORGE_PENDING_PROBES: &[Pending] = &[Pending {
    id: "edge-probes-carry-the-normalized-sum-of-their-face-normals",
    why: "[W0-50]: forge-refs `probe::edge_probe` emits no `normal` yet (W3)",
    forge_now: r#"{"t1": {"/target": [
        {"kind": "edge", "point": [0, 0, 2], "normal": null},
        {"kind": "edge", "point": [10, 0, 2], "normal": null},
        {"kind": "edge", "point": [10, 5, 2], "normal": null}]}}"#,
}];

/// Probe points (mm) and unit normals are compared per component within this.
const PROBE_TOLERANCE: f64 = 1e-9;

fn close3(got: &Value, want: &Value) -> bool {
    match (got.as_array(), want.as_array()) {
        (Some(g), Some(w)) if g.len() == 3 && w.len() == 3 => g.iter().zip(w).all(|(g, w)| {
            matches!((g.as_f64(), w.as_f64()), (Some(g), Some(w)) if (g - w).abs() <= PROBE_TOLERANCE)
        }),
        _ => false,
    }
}

/// A member probe against a fixture probe; a fixture `normal: null` means the probe has none
/// (the key absent or `null`: the metrics schema allows both for probes).
fn probe_fits(got: &Value, want: &Value) -> bool {
    got["kind"] == want["kind"]
        && close3(&got["point"], &want["point"])
        && match &want["normal"] {
            Value::Null => got["normal"].is_null(),
            w => close3(&got["normal"], w),
        }
}

/// A report against a case's `expect` object: per feature id and Ref field, the members' probes
/// as a multiset.
fn probe_problems(r: &Value, expect: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for (fid, fields) in expect.as_object().unwrap() {
        let Some(got) = feature(r, fid) else {
            out.push(format!("{fid}: no feature entry"));
            continue;
        };
        for (field, want) in fields.as_object().unwrap() {
            let Some(entry) = got["refs"]
                .as_array()
                .and_then(|a| a.iter().find(|x| x["field"] == field.as_str()))
            else {
                out.push(format!("{fid} {field}: no refs entry"));
                continue;
            };
            let probes: Vec<&Value> = entry["members"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| &m["probe"])
                .collect();
            let want = want.as_array().unwrap();
            if probes.len() != want.len() {
                out.push(format!(
                    "{fid} {field}: {} members, expected {}",
                    probes.len(),
                    want.len()
                ));
                continue;
            }
            let missing = unmatched(want.len(), probes.len(), |w, g| {
                probe_fits(probes[g], &want[w])
            });
            if !missing.is_empty() {
                let missing: Vec<&Value> = missing.iter().map(|&i| &want[i]).collect();
                out.push(format!(
                    "{fid} {field}: no member probe for {missing:?}; got {probes:?}"
                ));
            }
        }
    }
    out
}

/// SPEC-v1 §7.6, §8.1: [W0-50] an edge probe's `normal` is the normalized sum of its faces'
/// outward normals; [W0-54] a cusp edge's probe has none.
#[test]
fn reference_probe_fixtures() {
    let f = fixture("references/probes.json");
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() >= 2);
    let mut ids = BTreeSet::new();
    let mut failures = Vec::new();
    for c in cases {
        let id = c["id"].as_str().unwrap();
        assert!(ids.insert(id), "duplicate case id {id}");
        let r = evaluate(id, &c["document"]);
        judge(
            id,
            FORGE_PENDING_PROBES,
            "FORGE_PENDING_PROBES",
            |w| probe_problems(&r, w),
            &c["expect"],
            &mut failures,
        );
    }
    for p in FORGE_PENDING_PROBES {
        assert!(
            ids.contains(p.id),
            "FORGE_PENDING_PROBES names an unknown case {}",
            p.id
        );
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn unmatched_is_a_multiset_match() {
    // One returned entry never satisfies two expected ones.
    assert_eq!(unmatched(2, 1, |_, _| true), vec![1]);
    // An augmenting path re-assigns: want 0 fits both, want 1 only got 0.
    assert!(unmatched(2, 2, |w, g| w == 0 || g == 0).is_empty());
    assert_eq!(unmatched(1, 0, |_, _| true), vec![0]);
}
