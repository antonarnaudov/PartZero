//! `aicad eval`: exit codes, JSON and text output, `--out`, rejected documents.

use std::path::PathBuf;
use std::process::Command;

fn aicad() -> Command {
    Command::new(env!("CARGO_BIN_EXE_aicad"))
}

fn program(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../../corpus/programs/{name}.json"))
}

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
    std::fs::create_dir_all(&dir).expect("tmp dir");
    dir.join(name)
}

#[test]
fn eval_prints_a_metrics_report_and_exits_zero() {
    let out = aicad()
        .args(["eval"])
        .arg(program("extrude_box"))
        .args(["--format", "json"])
        .output()
        .expect("run aicad");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("JSON report");
    assert_eq!(v["schema"], "aicad.metrics/0");
    assert_eq!(v["engine"], format!("forge {}", env!("CARGO_PKG_VERSION")));
    assert_eq!(v["document"], "extrude_box");
    assert_eq!(v["status"], "ok");
    assert_eq!(v["features"][1]["feature"], "plate");
    assert_eq!(v["features"][1]["bodies"][0]["faces"], 6);
    // The report is also a valid forge_ir::EvalReport.
    let r: forge_ir::EvalReport = serde_json::from_slice(&out.stdout).expect("typed report");
    assert_eq!(r.features.len(), 2);
}

#[test]
fn failed_features_still_exit_zero() {
    let path = scratch("open_loop.json");
    std::fs::write(
        &path,
        r#"{"schema":"aicad.ir/0","parts":[{"id":"p","name":"p","features":[
            {"type":"sketch","id":"s","name":"s","plane":"XY","curves":[
              {"kind":"line","id":"a","start":[0,0],"end":[1,0]}]},
            {"type":"extrude","id":"e","name":"e","sketch":"s","distance":1}]}]}"#,
    )
    .expect("write");
    let out = aicad().arg("eval").arg(&path).output().expect("run");
    assert_eq!(out.status.code(), Some(0));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("JSON");
    assert_eq!(v["status"], "error");
    assert_eq!(v["document"], "open_loop");
    assert_eq!(v["features"][0]["error"]["code"], "SKETCH_OPEN_LOOP");
    assert_eq!(v["features"][1]["error"]["code"], "DEPENDENCY_FAILED");
}

#[test]
fn rejected_documents_exit_two_with_diagnostics() {
    let bad_json = scratch("bad.json");
    std::fs::write(&bad_json, "{ not json").expect("write");
    let out = aicad().arg("eval").arg(&bad_json).output().expect("run");
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("IR_PARSE_ERROR"));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("JSON");
    assert_eq!(v["error"]["code"], "IR_PARSE_ERROR");

    let invalid = scratch("invalid.json");
    std::fs::write(
        &invalid,
        r#"{"schema":"aicad.ir/0","meta":{"name":"named"},"parts":[{"id":"p","name":"p","features":[
            {"type":"sketch","id":"s","name":"line","plane":"XY","curves":[
              {"kind":"circle","id":"c","center":[0,0],"radius":1}]}]}]}"#,
    )
    .expect("write");
    let out = aicad().arg("eval").arg(&invalid).output().expect("run");
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("RESERVED_NAME"));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("JSON");
    assert_eq!(v["document"], "named");
    assert_eq!(v["status"], "error");
    assert_eq!(v["error"]["code"], "RESERVED_NAME");
}

#[test]
fn out_flag_and_text_format() {
    let dest = scratch("torus.metrics.json");
    let out = aicad()
        .arg("eval")
        .arg(program("revolve_torus"))
        .arg("--out")
        .arg(&dest)
        .output()
        .expect("run");
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&dest).expect("written")).expect("JSON");
    assert_eq!(v["features"][1]["bodies"][0]["face_types"]["torus"], 1);
    let out = aicad()
        .arg("eval")
        .arg(program("revolve_torus"))
        .args(["--format", "text"])
        .output()
        .expect("run");
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        text.contains("revolve_torus — ok") && text.contains("1 faces (torus 1)"),
        "{text}"
    );
}

#[test]
fn export_writes_a_watertight_3mf_per_body() {
    let path = scratch("two_regions.3mf");
    let out = aicad()
        .args(["export"])
        .arg(program("extrude_two_regions"))
        .arg("--out")
        .arg(&path)
        .output()
        .expect("run aicad");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let bytes = std::fs::read(&path).expect("3MF written");
    let model = forge_io::read_3mf(&bytes).expect("valid 3MF");
    assert_eq!(model.unit, "millimeter");
    let names: Vec<_> = model
        .objects
        .iter()
        .filter_map(|o| o.name.clone())
        .collect();
    assert_eq!(names, ["part/pucks#0", "part/pucks#1"]);
}

#[test]
fn export_refuses_partial_results_and_infers_format() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
    let broken = dir.join("broken_open_loop.json");
    std::fs::write(
        &broken,
        r#"{ "schema": "aicad.ir/0", "parts": [{ "id": "p", "name": "part", "features": [
            { "type": "sketch", "id": "s", "name": "base", "plane": "XY", "curves": [
              { "kind": "line", "id": "a", "start": [0, 0], "end": [10, 0] },
              { "kind": "line", "id": "b", "start": [10, 0], "end": [10, 10] } ] },
            { "type": "extrude", "id": "e", "name": "plate", "sketch": "base", "distance": 2 } ] }] }"#,
    )
    .unwrap();
    let out = aicad()
        .args(["export"])
        .arg(&broken)
        .arg("--out")
        .arg(scratch("broken.stl"))
        .output()
        .expect("run aicad");
    assert_eq!(
        out.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stderr).contains("SKETCH_OPEN_LOOP"));

    let out = aicad()
        .args(["export"])
        .arg(program("extrude_box"))
        .arg("--out")
        .arg(scratch("box.unknown"))
        .output()
        .expect("run aicad");
    assert_eq!(out.status.code(), Some(3));
}
