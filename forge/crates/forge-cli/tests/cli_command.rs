//! The command-layer verbs of `aicad` (SPEC-v1 §0.6, §9.1; W9): `migrate` against the I9
//! migration fixtures, and `solve` / `solve --write-back` (`writeBackSolution`).

use std::path::{Path, PathBuf};
use std::process::Command;

fn aicad() -> Command {
    Command::new(env!("CARGO_BIN_EXE_aicad"))
}

fn repo(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../../{rel}"))
}

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("cli_command");
    std::fs::create_dir_all(&dir).expect("tmp dir");
    dir.join(name)
}

fn files(dir: &Path, suffix: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().ends_with(suffix))
        .collect();
    v.sort();
    v
}

fn stderr(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

/// SPEC-v1 §9.1 / §9.4: `aicad migrate` prints exactly the fixture's canonical v1 text for every
/// v0 migration pair (corpus programs, MakerBench, id rewrites), writes exactly its migration
/// report, and never echoes a rewritten (untrusted) id.
#[test]
fn migrate_reproduces_every_conformance_pair_byte_for_byte() {
    let mut pairs = 0;
    let mut renamed = 0;
    for dir in ["programs", "makerbench", "renames"] {
        let dir = repo(&format!("corpus/v1/conformance/migration/{dir}"));
        for v0 in files(&dir, ".v0.json") {
            let v1 = PathBuf::from(v0.to_string_lossy().replace(".v0.json", ".v1.json"));
            let renames_fixture =
                PathBuf::from(v0.to_string_lossy().replace(".v0.json", ".renames.json"));
            let renames_out = scratch("renames.json");
            let out = aicad()
                .arg("migrate")
                .arg(&v0)
                .arg("--renames")
                .arg(&renames_out)
                .output()
                .expect("run aicad");
            assert_eq!(
                out.status.code(),
                Some(0),
                "{}: {}",
                v0.display(),
                stderr(&out)
            );
            let want = std::fs::read(&v1).expect("fixture");
            assert!(
                out.stdout == want,
                "{}: stdout differs from {}",
                v0.display(),
                v1.display()
            );
            let got: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&renames_out).unwrap()).unwrap();
            let want: serde_json::Value = if renames_fixture.exists() {
                serde_json::from_slice(&std::fs::read(&renames_fixture).unwrap()).unwrap()
            } else {
                serde_json::json!({ "renames": [] })
            };
            assert_eq!(got, want, "{}", v0.display());
            let err = stderr(&out);
            for r in want["renames"].as_array().unwrap() {
                renamed += 1;
                assert!(err.contains(r["to"].as_str().unwrap()), "{err}");
                let from = r["from"].as_str().unwrap();
                if from.len() >= 4 {
                    assert!(!err.contains(from), "echoed {from:?}: {err}");
                }
            }
            // Idempotence: migrating the migrated document returns it unchanged.
            let again = aicad().arg("migrate").arg(&v1).output().expect("run aicad");
            assert_eq!(again.status.code(), Some(0));
            assert!(
                again.stdout == std::fs::read(&v1).unwrap(),
                "{}",
                v1.display()
            );
            pairs += 1;
        }
    }
    assert!(pairs >= 8 + 61, "{pairs}");
    assert!(renamed >= 5, "{renamed}");
}

#[test]
fn migrate_writes_to_out_and_rejects_invalid_documents_with_their_codes() {
    let v0 = repo("corpus/v1/conformance/migration/programs/extrude_box.v0.json");
    let out_path = scratch("extrude_box.v1.json");
    let out = aicad()
        .arg("migrate")
        .arg(&v0)
        .arg("--out")
        .arg(&out_path)
        .output()
        .expect("run aicad");
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(out.stdout.is_empty());
    assert_eq!(
        std::fs::read(&out_path).unwrap(),
        std::fs::read(repo(
            "corpus/v1/conformance/migration/programs/extrude_box.v1.json"
        ))
        .unwrap()
    );
    // A rejected v0 document keeps its v0 codes (§9.1 "rejections are preserved"); nothing on
    // stdout.
    let bad = scratch("bad_v0.json");
    let text = std::fs::read_to_string(&v0).unwrap();
    let broken = text.replacen("\"distance\": 8", "\"distance\": -1", 1);
    assert_ne!(broken, text, "fixture changed shape");
    std::fs::write(&bad, broken).unwrap();
    let out = aicad()
        .arg("migrate")
        .arg(&bad)
        .output()
        .expect("run aicad");
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(
        stderr(&out).contains("INVALID_DISTANCE"),
        "{}",
        stderr(&out)
    );
    // Migration is independent of what this engine evaluates: a v1 document with holes and
    // patterns (which `eval` rejects, §0.2 rule 3) is printed in canonical form.
    let out = aicad()
        .arg("migrate")
        .arg(repo("corpus/v1/programs/plate_features.json"))
        .output()
        .expect("run aicad");
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    let text = String::from_utf8(out.stdout).unwrap();
    let doc = forge_ir::v1::from_json(&text).expect("valid v1");
    assert_eq!(forge_ir::v1::to_json(&doc) + "\n", text);
    // Unreadable input.
    let out = aicad()
        .arg("migrate")
        .arg(scratch("does_not_exist.json"))
        .output()
        .expect("run aicad");
    assert_eq!(out.status.code(), Some(3));
}

fn constrained() -> PathBuf {
    repo("corpus/v1/programs/constrained_plate.json")
}

#[test]
fn solve_prints_the_constrained_sketch_reports() {
    let out = aicad()
        .arg("solve")
        .arg(constrained())
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("JSON");
    let sketches = v["sketches"].as_array().unwrap();
    assert_eq!(sketches.len(), 1);
    assert_eq!(sketches[0]["feature_id"], "s1");
    assert_eq!(sketches[0]["status"], "ok");
    assert_eq!(sketches[0]["sketch"]["mode"], "constrained");
    assert_eq!(sketches[0]["sketch"]["status"], "fully_constrained");
    // Selecting an unknown sketch is a usage error; nothing is printed.
    let out = aicad()
        .arg("solve")
        .arg(constrained())
        .args(["--sketch", "nope"])
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(stderr(&out).contains("WRITE_BACK_UNKNOWN_SKETCH"));
}

/// `writeBackSolution` through the CLI: the written document evaluates to the same report, and
/// writing it back again is byte-identical (the op is idempotent).
#[test]
fn solve_write_back_stores_the_solution_idempotently() {
    let first = scratch("wb1.json");
    let out = aicad()
        .arg("solve")
        .arg(constrained())
        .args(["--write-back", "--out"])
        .arg(&first)
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(stderr(&out).contains("wrote back the solution of sketch s1"));
    let written = std::fs::read_to_string(&first).unwrap();
    let doc = forge_ir::v1::from_json(&written).expect("valid v1");
    assert_eq!(forge_ir::v1::to_json(&doc) + "\n", written, "canonical");
    let second = scratch("wb2.json");
    let out = aicad()
        .arg("solve")
        .arg(&first)
        .args(["--write-back", "--out"])
        .arg(&second)
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(std::fs::read(&second).unwrap(), written.as_bytes());
    let eval = |p: &Path| {
        let out = aicad().arg("eval").arg(p).output().expect("run");
        assert_eq!(out.status.code(), Some(0));
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        (v["features"].clone(), v["parts"].clone())
    };
    assert_eq!(eval(&constrained()), eval(&first));
}

#[test]
fn solve_exits_one_for_a_sketch_that_does_not_solve_and_leaves_it_as_it_was() {
    let path = scratch("conflict.json");
    std::fs::write(
        &path,
        r#"{"schema":"aicad.ir/1","meta":{"name":"c"},"parts":[{"id":"p","name":"p","features":[
          {"type":"sketch","id":"s1","name":"s1","plane":"XY","curves":[
            {"kind":"line","id":"a","start":[0,0],"end":[10,0]},
            {"kind":"line","id":"b","start":[10,0],"end":[10,10]},
            {"kind":"line","id":"c","start":[10,10],"end":[0,0]}],
           "constraints":[
            {"id":"d1","type":"distance","a":"a.start","b":"a.end","value":10},
            {"id":"d2","type":"distance","a":"a.start","b":"a.end","value":20}]}]}]}"#,
    )
    .unwrap();
    let out = aicad().arg("solve").arg(&path).output().expect("run");
    assert_eq!(out.status.code(), Some(1));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        v["sketches"][0]["error"]["code"],
        "SKETCH_CONSTRAINT_CONFLICT"
    );
    let out = aicad()
        .arg("solve")
        .arg(&path)
        .arg("--write-back")
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("sketch s1 not written (failed: SKETCH_CONSTRAINT_CONFLICT)"));
    let doc = forge_ir::v1::from_json(&String::from_utf8(out.stdout).unwrap()).unwrap();
    let orig = forge_ir::v1::from_json(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(doc, orig);
}
