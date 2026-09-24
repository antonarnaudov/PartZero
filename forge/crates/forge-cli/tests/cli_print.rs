//! `aicad export` for a printer (ALPHA-0-PLAN W5): `--bed` centring and the bed-fit check
//! (exit 4, `EXPORT_BED_FIT`), 3MF metadata and the `--summary` record.

// Exact placement (z-min = 0, integer bed positions) is the property under test here.
#![allow(clippy::float_cmp)]

use std::path::PathBuf;
use std::process::Command;

fn aicad() -> Command {
    Command::new(env!("CARGO_BIN_EXE_aicad"))
}

fn corpus(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../../corpus/{rel}"))
}

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("cli_print");
    std::fs::create_dir_all(&dir).expect("tmp dir");
    let p = dir.join(name);
    let _ = std::fs::remove_file(&p);
    p
}

fn read_json(path: &PathBuf) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(path).expect("summary written")).expect("JSON")
}

/// The P2S profile's bed with print tessellation, as the desktop handoff runs it.
fn print_export(
    doc: &PathBuf,
    out: &PathBuf,
    summary: &PathBuf,
    bed: &str,
) -> std::process::Output {
    aicad()
        .arg("export")
        .arg(doc)
        .arg("--out")
        .arg(out)
        .args(["--deflection", "0.01", "--angular", "0.1", "--bed", bed])
        .args(["--title", "Two pucks", "--application", "PartZero 0.0.1"])
        .arg("--summary")
        .arg(summary)
        .output()
        .expect("run aicad")
}

#[test]
fn bed_export_centres_the_bodies_and_records_a_summary() {
    let out = scratch("pucks.3mf");
    let summary = scratch("pucks.summary.json");
    let r = print_export(
        &corpus("programs/extrude_two_regions.json"),
        &out,
        &summary,
        "256,256,256",
    );
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    let bytes = std::fs::read(&out).expect("written");
    forge_io::validate_3mf(&bytes).expect("valid 3MF");
    let model = forge_io::read_3mf(&bytes).expect("3MF");
    // The two bodies (modelled from z = −3 to 0, off-centre) are centred as one build.
    let b = model.build_bounds().expect("bounds").expect("some");
    assert!(((b.min[0] + b.max[0]) / 2.0 - 128.0).abs() < 1e-9, "{b:?}");
    assert!(((b.min[1] + b.max[1]) / 2.0 - 128.0).abs() < 1e-9, "{b:?}");
    assert_eq!(b.min[2], 0.0);
    assert_eq!(model.objects.len(), 2);
    assert!(
        model
            .metadata
            .contains(&("Application".into(), "PartZero 0.0.1".into()))
    );
    assert!(
        model
            .metadata
            .contains(&("Title".into(), "Two pucks".into()))
    );

    let s = read_json(&summary);
    assert_eq!(s["schema"], "aicad.export/1");
    assert_eq!(s["status"], "ok");
    assert_eq!(s["format"], "3mf");
    assert_eq!(s["watertight"], true);
    assert_eq!(s["bodies"].as_array().expect("bodies").len(), 2);
    assert_eq!(s["tessellation"]["deflection"], 0.01);
    assert_eq!(s["bed"]["size"], serde_json::json!([256.0, 256.0, 256.0]));
    assert_eq!(s["bed"]["margin"], 10.0);
    assert_eq!(s["bytes"], bytes.len());
    // The recorded translation is the one in the file.
    let t: Vec<f64> = s["placement"]["translation"]
        .as_array()
        .expect("translation")
        .iter()
        .map(|v| v.as_f64().expect("number"))
        .collect();
    assert_eq!(model.items[0].matrix().expect("matrix")[9..].to_vec(), t);
    assert_eq!(s["placement"]["bbox"]["min"][2], 0.0);
}

#[test]
fn bed_export_of_a_v1_document_is_centred_and_byte_deterministic() {
    let doc = corpus("v1/programs/params_plate.json");
    let (a, b) = (scratch("plate_a.3mf"), scratch("plate_b.3mf"));
    for out in [&a, &b] {
        let r = print_export(&doc, out, &scratch("plate.summary.json"), "256,256,256");
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    }
    let bytes = std::fs::read(&a).expect("a");
    assert_eq!(bytes, std::fs::read(&b).expect("b"));
    let bounds = forge_io::read_3mf(&bytes)
        .expect("3MF")
        .build_bounds()
        .expect("bounds")
        .expect("some");
    // The 80 × 50 × 8 plate lands on 88..168 × 103..153 × 0..8.
    assert_eq!(bounds.min, [88.0, 103.0, 0.0]);
    assert_eq!(bounds.max, [168.0, 153.0, 8.0]);
}

#[test]
fn a_part_larger_than_the_bed_exits_4_with_export_bed_fit_and_writes_nothing() {
    let out = scratch("too_big.3mf");
    let summary = scratch("too_big.summary.json");
    // The plate is 100 × 60 × 5 mm; a 100 × 100 bed less 10 mm per side takes 80 × 80.
    let r = print_export(
        &corpus("programs/extrude_plate_with_holes.json"),
        &out,
        &summary,
        "100,100,100",
    );
    assert_eq!(
        r.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&r.stderr)
    );
    assert!(!out.exists(), "nothing is written");
    let stderr = String::from_utf8_lossy(&r.stderr);
    assert!(stderr.contains("EXPORT_BED_FIT"), "{stderr}");
    assert!(stderr.contains("20 mm too large in X"), "{stderr}");
    let s = read_json(&summary);
    assert_eq!(s["status"], "error");
    assert_eq!(s["error"]["code"], "EXPORT_BED_FIT");
    assert_eq!(s["error"]["details"]["overflows"][0]["axis"], "x");
    assert_eq!(s["error"]["details"]["overflows"][0]["excess"], 20.0);
    assert_eq!(
        s["error"]["details"]["usable"],
        serde_json::json!([80.0, 80.0, 100.0])
    );
    assert!(s["placement"].is_null());
    assert!(s["bytes"].is_null());
}

#[test]
fn an_exclusion_zone_and_a_custom_margin_are_honoured() {
    let doc = corpus("programs/extrude_plate_with_holes.json");
    let out = scratch("excl.3mf");
    // 100 × 60 plate on a 140 × 100 bed with a 20 mm margin: fits exactly in X.
    let ok = aicad()
        .arg("export")
        .arg(&doc)
        .arg("--out")
        .arg(&out)
        .args(["--bed", "140,100,50", "--bed-margin", "20"])
        .output()
        .expect("run");
    assert!(
        ok.status.success(),
        "{}",
        String::from_utf8_lossy(&ok.stderr)
    );
    // Its footprint (20..120 × 20..80) covers a zone in the front-left corner.
    let blocked = aicad()
        .arg("export")
        .arg(&doc)
        .arg("--out")
        .arg(scratch("excl_blocked.3mf"))
        .args([
            "--bed",
            "140,100,50",
            "--bed-margin",
            "20",
            "--bed-exclude",
            "0,0,25,25",
        ])
        .output()
        .expect("run");
    assert_eq!(blocked.status.code(), Some(4));
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("exclusion zone 0"));
}

#[test]
fn printer_options_need_3mf_and_bed_options_need_a_bed() {
    let doc = corpus("programs/extrude_box.json");
    let stl = aicad()
        .arg("export")
        .arg(&doc)
        .arg("--out")
        .arg(scratch("box.stl"))
        .args(["--bed", "256,256,256"])
        .output()
        .expect("run");
    assert_eq!(stl.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&stl.stderr).contains("3MF only"));
    let margin_alone = aicad()
        .arg("export")
        .arg(&doc)
        .arg("--out")
        .arg(scratch("box.3mf"))
        .args(["--bed-margin", "5"])
        .output()
        .expect("run");
    assert!(!margin_alone.status.success());
    let bad_bed = aicad()
        .arg("export")
        .arg(&doc)
        .arg("--out")
        .arg(scratch("box2.3mf"))
        .args(["--bed", "256,256"])
        .output()
        .expect("run");
    assert!(!bad_bed.status.success());
}

#[test]
fn a_multi_body_stl_points_to_3mf() {
    let r = aicad()
        .arg("export")
        .arg(corpus("programs/extrude_two_regions.json"))
        .arg("--out")
        .arg(scratch("pucks.stl"))
        .output()
        .expect("run");
    assert!(r.status.success());
    assert!(String::from_utf8_lossy(&r.stderr).contains("export 3MF to keep them apart"));
}
