//! `aicad export --format step`: the exact B-rep of the final bodies through forge-io's STEP
//! writer, the `--summary` record the oracle's `step-check` reads, and the refusals.

use std::path::PathBuf;
use std::process::Command;

fn aicad() -> Command {
    Command::new(env!("CARGO_BIN_EXE_aicad"))
}

fn corpus(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../../corpus/{rel}"))
}

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("cli_step");
    std::fs::create_dir_all(&dir).expect("tmp dir");
    let p = dir.join(name);
    let _ = std::fs::remove_file(&p);
    p
}

fn export(doc: &PathBuf, out: &PathBuf, extra: &[&str]) -> std::process::Output {
    aicad()
        .arg("export")
        .arg(doc)
        .arg("--out")
        .arg(out)
        .args(extra)
        .output()
        .expect("run aicad")
}

#[test]
fn a_step_extension_writes_a_verified_step_file_and_the_summary() {
    let out = scratch("plate.step");
    let summary = scratch("plate.summary.json");
    let o = export(
        &corpus("programs/extrude_plate_with_holes.json"),
        &out,
        &["--summary", summary.to_str().expect("utf8")],
    );
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let bytes = std::fs::read(&out).expect("written");
    let s = forge_io::verify_step(&bytes).expect("verifies");
    assert_eq!(s.solids.len(), 1);
    assert_eq!(s.solids[0].faces, 10);
    assert_eq!(s.solids[0].seam_edges, 4, "one seam per hole wall");
    let text = String::from_utf8(bytes).expect("ascii");
    assert!(
        text.contains("PRODUCT('plate','plate'"),
        "the output stem is the product name"
    );
    let j: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&summary).expect("summary")).expect("JSON");
    assert_eq!(j["schema"], "aicad.export/1");
    assert_eq!(j["format"], "step");
    assert_eq!(j["stepSchema"], "ap214");
    let b = &j["bodies"][0];
    assert_eq!(b["forge"]["faces"], 10);
    assert_eq!(b["step"]["faces"], 10);
    assert_eq!(b["step"]["seamEdges"], 4);
    let forge_edges = b["forge"]["edges"].as_u64().expect("edges");
    let step_edges = b["step"]["edges"].as_u64().expect("edges");
    let seams = b["step"]["seamEdges"].as_u64().expect("seams");
    let splits = b["step"]["splitPieces"].as_u64().expect("splits");
    assert_eq!(step_edges - seams - splits, forge_edges);
    assert!(j["error"].is_null());
}

#[test]
fn format_step_title_and_ap242_are_honoured_and_output_is_deterministic() {
    // The same file name in two folders (FILE_NAME carries the name, not the path).
    let a = scratch("torus.txt");
    let b_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("cli_step_again");
    std::fs::create_dir_all(&b_dir).expect("tmp dir");
    let b = b_dir.join("torus.txt");
    let args = [
        "--format",
        "step",
        "--step-schema",
        "ap242",
        "--title",
        "Tor 'ü'",
    ];
    for out in [&a, &b] {
        let o = export(&corpus("programs/revolve_torus.json"), out, &args);
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    }
    let (ta, tb) = (std::fs::read(&a).expect("a"), std::fs::read(&b).expect("b"));
    assert_eq!(ta, tb, "deterministic bytes");
    let text = String::from_utf8(ta).expect("ascii");
    assert!(text.contains("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF"));
    assert!(text.contains("PRODUCT('Tor ''\\X2\\00FC\\X0\\''"));
    assert!(text.contains("TOROIDAL_SURFACE"));
}

#[test]
fn v1_documents_export_their_final_bodies() {
    let out = scratch("params_plate.stp");
    let o = export(&corpus("v1/programs/params_plate.json"), &out, &[]);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let s = forge_io::verify_step(&std::fs::read(&out).expect("written")).expect("verifies");
    assert!(!s.solids.is_empty());
    assert!(!s.solids[0].name.is_empty());
}

#[test]
fn a_bed_is_refused_for_step() {
    let out = scratch("bed.step");
    let o = export(
        &corpus("programs/extrude_box.json"),
        &out,
        &["--bed", "256,256,256"],
    );
    assert_eq!(o.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&o.stderr).contains("--bed applies to 3MF only"));
    assert!(!out.exists());
}

#[test]
fn failed_features_write_nothing_without_allow_partial() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("cli_step");
    std::fs::create_dir_all(&dir).expect("tmp dir");
    let doc = dir.join("broken.json");
    // A v0 extrude of a sketch that does not exist.
    let mut v: serde_json::Value =
        serde_json::from_slice(&std::fs::read(corpus("programs/extrude_box.json")).expect("box"))
            .expect("JSON");
    let features = v["parts"][0]["features"].as_array_mut().expect("features");
    let extrude = features
        .iter_mut()
        .find(|f| f["type"] == "extrude")
        .expect("an extrude");
    extrude["sketch"] = serde_json::Value::String("missing".into());
    std::fs::write(&doc, serde_json::to_vec(&v).expect("json")).expect("write doc");
    let out = scratch("broken.step");
    let o = export(&doc, &out, &[]);
    assert!(!o.status.success());
    assert!(!out.exists(), "no file for a failed document");
}
