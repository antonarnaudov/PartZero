//! `aicad eval` and `aicad export` on IR v1 documents (SPEC-v1 §7.2): the `aicad.metrics/1`
//! report, exit codes 0 / 1 / 2, `--report-version v1` for v0 input, final-body export.

use std::path::PathBuf;
use std::process::Command;

fn aicad() -> Command {
    Command::new(env!("CARGO_BIN_EXE_aicad"))
}

fn v1_program(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../../corpus/v1/programs/{name}.json"))
}

fn v0_program(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../../corpus/programs/{name}.json"))
}

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
    std::fs::create_dir_all(&dir).expect("tmp dir");
    dir.join(name)
}

fn report(out: &std::process::Output) -> forge_ir::v1::metrics::EvalReport {
    let v = forge_ir::v1::json::parse(&String::from_utf8_lossy(&out.stdout)).expect("JSON report");
    serde_json::from_value(v).expect("an aicad.metrics/1 report")
}

#[test]
fn eval_of_a_v1_document_prints_the_v1_report_and_exits_zero() {
    let out = aicad()
        .arg("eval")
        .arg(v1_program("params_plate"))
        .output()
        .expect("run aicad");
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let r = report(&out);
    assert_eq!(r.schema, "aicad.metrics/1");
    assert_eq!(r.document, "params_plate");
    assert_eq!(r.params.len(), 3);
    assert_eq!(r.parts.len(), 1);
    assert_eq!(r.parts[0].bodies.len(), 1);
    assert_eq!(r.parts[0].bodies[0].origin.feature, "e1");
}

fn regression_program(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../forge-regen/tests/v1_programs/{name}.json"))
}

#[test]
fn a_v1_report_with_failed_features_exits_one_and_still_prints_the_report() {
    let out = aicad()
        .arg("eval")
        .arg(regression_program("failures_pass_through"))
        .output()
        .expect("run aicad");
    assert_eq!(out.status.code(), Some(1));
    let r = report(&out);
    assert_eq!(serde_json::to_value(r.status).unwrap(), "error");
    let failed: Vec<(&str, &str)> = r
        .features
        .iter()
        .filter_map(|f| {
            f.error
                .as_ref()
                .map(|e| (f.feature_id.as_str(), e.code.as_str()))
        })
        .collect();
    assert_eq!(
        failed,
        [
            ("e1", "INVALID_DISTANCE"),
            ("t1", "REF_CARDINALITY"),
            ("e3", "BOOLEAN_NO_INTERSECTION")
        ]
    );
    // The features around them still evaluate.
    assert!(
        r.features
            .iter()
            .any(|f| f.feature_id == "e2" && f.error.is_none())
    );
    assert_eq!(r.parts[0].bodies.len(), 2);
}

/// Since Phase C Forge implements every mandatory type (SPEC-v1 §0.2 rule 3): `plate_features`
/// (holes of every kind and placement, fillets, a chamfer, linear / mirror / circular
/// patterns) evaluates. Exit 1: four of its features fail by the program's own content, as in
/// the OCCT oracle — `h3`'s position `a` lies in `h1`'s counterbore (`HOLE_POINT_OFF_FACE`),
/// `h4` drills out of the part (`flip` on the bottom cap: `HOLE_MISSES_BODY`), `f1` selects the
/// smooth edges of the rounded outline (`FILLET_EDGE_UNSUPPORTED`), and `pt2` mirrors `h3`
/// (`DEPENDENCY_FAILED`). Nothing is rejected, and no engine-internal code appears.
#[test]
fn plate_features_evaluates_its_holes_blends_and_patterns() {
    let out = aicad()
        .arg("eval")
        .arg(v1_program("plate_features"))
        .output()
        .expect("run aicad");
    assert_eq!(
        out.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let r = report(&out);
    assert!(r.error.is_none());
    let failed: Vec<(&str, &str)> = r
        .features
        .iter()
        .filter_map(|f| {
            f.error
                .as_ref()
                .map(|e| (f.feature_id.as_str(), e.code.as_str()))
        })
        .collect();
    assert_eq!(
        failed,
        [
            ("h3", "HOLE_POINT_OFF_FACE"),
            ("h4", "HOLE_MISSES_BODY"),
            ("f1", "FILLET_EDGE_UNSUPPORTED"),
            ("pt2", "DEPENDENCY_FAILED"),
        ]
    );
    let f = |id: &str| r.features.iter().find(|f| f.feature_id == id).unwrap();
    let ats: Vec<&str> = f("h1").holes.iter().map(|h| h.at.as_str()).collect();
    assert_eq!(ats, ["g0_0", "g0_1", "g1_0", "g1_1"]);
    assert_eq!(f("pt1").pattern.as_ref().unwrap().skipped, vec![vec![3]]);
    assert_eq!(f("pt3").pattern.as_ref().unwrap().instances, 4);
    assert_eq!(f("c1").chamfer.as_ref().unwrap().edges.len(), 3);
    assert_eq!(r.parts[0].bodies.len(), 1);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!stderr.contains("UNSUPPORTED"), "{stderr}");
}

#[test]
fn a_rejected_v1_document_exits_two_with_every_problem() {
    let path = scratch("rejected_v1.json");
    std::fs::write(
        &path,
        r#"{"schema":"aicad.ir/1","meta":{"name":"bad"},"params":[
            {"name":"a","unit":"mm","value":"nope"}],
            "parts":[{"id":"p","name":"p","features":[
            {"type":"extrude","id":"e","name":"e","sketch":"missing","distance":1}]}]}"#,
    )
    .expect("write");
    let out = aicad().arg("eval").arg(&path).output().expect("run");
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("EXPR_UNKNOWN_NAME"), "{stderr}");
    let r = report(&out);
    assert_eq!(r.document, "bad");
    let e = r.error.expect("document error");
    assert!(e.details["errors"].as_array().unwrap().len() >= 2);
    assert!(r.features.is_empty());
}

#[test]
fn report_version_v1_migrates_a_v0_document() {
    let v0 = aicad()
        .arg("eval")
        .arg(v0_program("extrude_two_regions"))
        .output()
        .expect("run");
    let v0: serde_json::Value = serde_json::from_slice(&v0.stdout).expect("JSON");
    assert_eq!(v0["schema"], "aicad.metrics/0");
    let out = aicad()
        .arg("eval")
        .arg(v0_program("extrude_two_regions"))
        .args(["--report-version", "v1"])
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(0));
    let r = report(&out);
    assert_eq!(r.schema, "aicad.metrics/1");
    assert!(r.migration.is_none());
    let mut a: Vec<u64> = v0["features"][1]["bodies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["volume"].as_f64().unwrap().to_bits())
        .collect();
    let mut b: Vec<u64> = r.features[1]
        .bodies
        .iter()
        .map(|b| b.volume.to_bits())
        .collect();
    a.sort_unstable();
    b.sort_unstable();
    assert_eq!(a, b);
}

#[test]
fn text_format_of_a_v1_report() {
    let out = aicad()
        .arg("eval")
        .arg(v1_program("constrained_plate"))
        .args(["--format", "text"])
        .output()
        .expect("run");
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        text.contains("constrained_plate — ok") && text.contains("aicad.metrics/1"),
        "{text}"
    );
    assert!(text.contains("part plate (1 bodies)"), "{text}");
}

#[test]
fn export_of_a_v1_document_writes_the_final_bodies() {
    let path = scratch("v1_plate.3mf");
    let out = aicad()
        .arg("export")
        .arg(v1_program("params_plate"))
        .arg("--out")
        .arg(&path)
        .output()
        .expect("run");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let model = forge_io::read_3mf(&std::fs::read(&path).expect("written")).expect("3MF");
    let names: Vec<_> = model
        .objects
        .iter()
        .filter_map(|o| o.name.clone())
        .collect();
    assert_eq!(names, ["plate/slab"]);

    // Failed features block the export unless --allow-partial.
    let out = aicad()
        .arg("export")
        .arg(regression_program("failures_pass_through"))
        .arg("--out")
        .arg(scratch("partial.stl"))
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("REF_CARDINALITY"));
    let out = aicad()
        .arg("export")
        .arg(regression_program("failures_pass_through"))
        .arg("--out")
        .arg(scratch("partial.stl"))
        .arg("--allow-partial")
        .output()
        .expect("run");
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    // A document Forge rejects (§0.2 rule 3: `shell_box`'s optional `draft`) is never
    // exported, even partially.
    let out = aicad()
        .arg("export")
        .arg(v1_program("shell_box"))
        .arg("--out")
        .arg(scratch("rejected.stl"))
        .arg("--allow-partial")
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("UNSUPPORTED_FEATURE"));
}

// ---- the rejection pipeline through `aicad eval` (SPEC-v1 §0.5 rule 4, I9) ----------------------

fn repo(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../../{rel}"))
}

fn eval_text(name: &str, text: &str, extra: &[&str]) -> std::process::Output {
    let path = scratch(&format!("{name}.json"));
    std::fs::write(&path, text).expect("write");
    aicad()
        .arg("eval")
        .arg(&path)
        .args(extra)
        .output()
        .expect("run aicad")
}

/// The sorted `{code, path}` pairs of a rejected report's `error.details.errors`.
fn rejected_pairs(v: &serde_json::Value) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = v["error"]["details"]["errors"]
        .as_array()
        .unwrap_or_else(|| panic!("no details.errors in {v}"))
        .iter()
        .map(|e| {
            (
                e["code"].as_str().unwrap().to_string(),
                e["path"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    pairs.sort();
    pairs
}

/// Every I9 invalid-document fixture through the CLI's default mode: the exact `{code, path}`
/// multiset, exit 2, an `aicad.metrics/1` rejected report (v0 documents: their v0 codes, in the
/// v0 report by default and with paths under `--report-version v1`). Forge rejects the optional
/// `draft` (§6.9), so a fixture document with a draft feature also expects `UNSUPPORTED_FEATURE`
/// at that feature's `/type`, and (§0.2 rule 3) one with a `hole`, `fillet`, `chamfer`, `shell`
/// or `pattern` also expects `UNSUPPORTED_FEATURE_VERSION` at its `/v`; the fixtures are
/// written for an engine that implements every type.
#[test]
fn every_invalid_document_fixture_is_rejected_by_aicad_eval_with_its_codes_and_paths() {
    let text = std::fs::read_to_string(repo("corpus/v1/conformance/invalid/documents.json"))
        .expect("the I9 fixtures");
    let fixtures: serde_json::Value = serde_json::from_str(&text).expect("JSON");
    let cases = fixtures["cases"].as_array().expect("cases");
    assert!(cases.len() >= 190, "{}", cases.len());
    let (mut rejected, mut valid, mut drafts, mut unimplemented) = (0, 0, 0, 0);
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let doc = &case["document"];
        let doc_text = serde_json::to_string(doc).unwrap();
        let out = eval_text(&format!("fixture_{id}"), &doc_text, &[]);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let report: serde_json::Value = serde_json::from_str(&stdout)
            .unwrap_or_else(|e| panic!("{id}: stdout is not a JSON report ({e}): {stdout}"));
        if case["parse_error"] == serde_json::json!(true) {
            assert_eq!(out.status.code(), Some(2), "{id}");
            assert_eq!(report["schema"], "aicad.metrics/1", "{id}");
            assert_eq!(report["error"]["code"], "IR_PARSE_ERROR", "{id}");
            rejected += 1;
            continue;
        }
        let mut want: Vec<(String, String)> = case["expected"]
            .as_array()
            .unwrap_or_else(|| panic!("{id}: no expected"))
            .iter()
            .map(|e| {
                (
                    e["code"].as_str().unwrap().to_string(),
                    e["path"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        for (pi, part) in doc["parts"].as_array().into_iter().flatten().enumerate() {
            for (fi, f) in part["features"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
            {
                if f["type"] == "draft" {
                    drafts += 1;
                    want.push((
                        "UNSUPPORTED_FEATURE".into(),
                        format!("/parts/{pi}/features/{fi}/type"),
                    ));
                }
                // §0.2 rule 3: a type Forge does not implement yet, at a defined `v`.
                let vpath = format!("/parts/{pi}/features/{fi}/v");
                if doc["schema"] == "aicad.ir/1"
                    && f["type"]
                        .as_str()
                        .is_some_and(|t| forge_regen::v1::UNIMPLEMENTED_FEATURE_TYPES.contains(&t))
                    && f.get("v").is_none_or(|v| v.as_u64() == Some(1))
                    && !want.iter().any(|(_, p)| *p == vpath)
                {
                    unimplemented += 1;
                    want.push(("UNSUPPORTED_FEATURE_VERSION".into(), vpath));
                }
            }
        }
        want.sort();
        let v0 = doc["schema"] == "aicad.ir/0";
        if want.is_empty() {
            // Edge cases next to a rule: valid, so evaluated (exit 0 or 1), never rejected.
            assert_ne!(out.status.code(), Some(2), "{id}: {}", report["error"]);
            assert!(report["error"].is_null(), "{id}");
            valid += 1;
            continue;
        }
        rejected += 1;
        assert_eq!(out.status.code(), Some(2), "{id}");
        if v0 {
            // Default mode keeps the v0 report (its `error` has no per-problem paths).
            assert_eq!(report["schema"], "aicad.metrics/0", "{id}");
            let code = report["error"]["code"].as_str().unwrap().to_string();
            assert!(want.iter().any(|(c, _)| *c == code), "{id}: {code}");
            let out = eval_text(
                &format!("fixture_{id}_v1"),
                &doc_text,
                &["--report-version", "v1"],
            );
            assert_eq!(out.status.code(), Some(2), "{id}");
            let report: serde_json::Value = serde_json::from_slice(&out.stdout).expect("JSON");
            assert_eq!(report["schema"], "aicad.metrics/1", "{id}");
            assert_eq!(rejected_pairs(&report), want, "{id}");
        } else {
            assert_eq!(report["schema"], "aicad.metrics/1", "{id}");
            assert_eq!(rejected_pairs(&report), want, "{id}");
            assert!(report["features"].as_array().unwrap().is_empty(), "{id}");
        }
    }
    // Since Phase C no mandatory type is unimplemented, so no fixture expects
    // `UNSUPPORTED_FEATURE_VERSION` for its type (the fixtures that did now evaluate or keep
    // their own rejections).
    assert!(
        rejected >= 200
            && valid >= 1
            && drafts >= 1
            && (unimplemented >= 10 || forge_regen::v1::UNIMPLEMENTED_FEATURE_TYPES.is_empty()),
        "{rejected} {valid} {drafts} {unimplemented}"
    );
}

/// SPEC-v1 §0.5 rule 4 step 2: only `aicad.ir/0` takes the v0 path; any other schema, a missing
/// one, or text that is not JSON is answered by the v1 pipeline in an `aicad.metrics/1` report.
#[test]
fn unknown_or_missing_schemas_are_unsupported_schema_in_a_v1_report() {
    for (name, text) in [
        ("schema_v2", r#"{"schema":"aicad.ir/2","parts":[]}"#),
        ("schema_missing", r#"{"parts":[]}"#),
        ("schema_not_string", r#"{"schema":1,"parts":[]}"#),
        (
            "schema_v2_v1_shapes",
            r#"{"schema":"aicad.ir/2","parts":[{"id":"p1","name":"part","features":[
              {"type":"sketch","id":"s1","name":"base","plane":"XY","curves":[
                {"kind":"rect","id":"outline","center":[0,0],"w":80,"h":50}]}]}]}"#,
        ),
    ] {
        let out = eval_text(name, text, &[]);
        assert_eq!(out.status.code(), Some(2), "{name}");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("UNSUPPORTED_SCHEMA"),
            "{name}"
        );
        let r = report(&out);
        assert_eq!(r.schema, "aicad.metrics/1", "{name}");
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(
            rejected_pairs(&v),
            vec![("UNSUPPORTED_SCHEMA".to_string(), "/schema".to_string())],
            "{name}"
        );
        // The same answer from `export` (exit 2, nothing written).
        let dest = scratch(&format!("{name}.stl"));
        let _ = std::fs::remove_file(&dest);
        let out = aicad()
            .arg("export")
            .arg(scratch(&format!("{name}.json")))
            .arg("--out")
            .arg(&dest)
            .output()
            .expect("run");
        assert_eq!(out.status.code(), Some(2), "{name}");
        assert!(!dest.exists(), "{name}");
    }
    let out = eval_text("not_json", "{ not json", &[]);
    assert_eq!(out.status.code(), Some(2));
    let r = report(&out);
    assert_eq!(r.schema, "aicad.metrics/1");
    assert_eq!(r.error.unwrap().code, "IR_PARSE_ERROR");
}

/// SPEC-v1 §6.9, §7.5: Forge does not implement the optional `draft`, so a document using it
/// is rejected (exit 2, `UNSUPPORTED_FEATURE` at the draft's `/type`), not evaluated.
#[test]
fn a_document_with_a_draft_is_rejected_by_eval_and_export() {
    let out = aicad()
        .arg("eval")
        .arg(v1_program("shell_box"))
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("UNSUPPORTED_FEATURE at /parts/0/features/3/type"),
        "{stderr}"
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    // The draft only: the shell, fillet, chamfer and patterns are implemented since Phase C.
    assert_eq!(
        rejected_pairs(&v),
        vec![(
            "UNSUPPORTED_FEATURE".to_string(),
            "/parts/0/features/3/type".to_string(),
        )]
    );
    let r = report(&out);
    assert!(r.features.is_empty() && r.parts.is_empty());
    let out = aicad()
        .arg("export")
        .arg(v1_program("shell_box"))
        .arg("--out")
        .arg(scratch("shell_box.stl"))
        .arg("--allow-partial")
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(2));
}
