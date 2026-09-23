//! The direct migration gate (SPEC-v1 §9.1 "Metric preservation", IR-V1 plan §4 W0): for every
//! v0 program, the `aicad.metrics/1` report of `migrate(d)` evaluated by `forge_regen::v1` has
//! the same feature list, statuses, error codes, regions and body metrics as the
//! `aicad.metrics/0` report of `d`, **bit for bit**. (The W0 gate in forge-ir checks the same
//! through the v0 compatibility path; this one runs the v1 evaluator itself.)
//!
//! Programs: the 8 corpus programs and the MakerBench references and contexts compiled to IR
//! (`corpus/v1/conformance/migration/makerbench`) always; the generated seeds
//! (`corpus/generated/s*/`, not committed) in the ignored release test
//! `generated_programs_keep_their_metrics_through_the_v1_evaluator`.

use std::path::{Path, PathBuf};

use forge_ir::BodyMetrics;
use forge_ir::v1::metrics::{BodyReport, Status as S1};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn jsons(dir: &Path, filter: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut v: Vec<PathBuf> = rd
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_file() && filter(&p.file_name().unwrap().to_string_lossy()))
        .collect();
    v.sort();
    v
}

fn committed_programs() -> Vec<PathBuf> {
    let mut v = jsons(&repo().join("corpus/programs"), |n| n.ends_with(".json"));
    v.extend(jsons(
        &repo().join("corpus/v1/conformance/migration/makerbench"),
        |n| n.ends_with(".v0.json"),
    ));
    v
}

/// A body's metrics as comparable bits (volume, area, centroid, box, counts, types, validity).
fn key0(b: &BodyMetrics) -> String {
    format!(
        "{:x} {:x} {:?} {:?} {:?} {} {} {:?} {:?} {}",
        b.volume.to_bits(),
        b.area.to_bits(),
        b.centroid.map(f64::to_bits),
        b.bbox_min.map(f64::to_bits),
        b.bbox_max.map(f64::to_bits),
        b.faces,
        b.edges,
        b.face_types,
        b.edge_types,
        b.valid
    )
}

fn key1(b: &BodyReport) -> String {
    format!(
        "{:x} {:x} {:?} {:?} {:?} {} {} {:?} {:?} {}",
        b.volume.to_bits(),
        b.area.to_bits(),
        b.centroid.map(f64::to_bits),
        b.bbox_min.map(f64::to_bits),
        b.bbox_max.map(f64::to_bits),
        b.faces,
        b.edges,
        b.face_types,
        b.edge_types,
        b.valid
    )
}

/// Every difference between the v0 report of `text` and the v1 report of its migration.
fn differences(text: &str, name: &str) -> Vec<String> {
    let doc = forge_ir::from_json(text).expect("a valid v0 program");
    let ev0 = forge_regen::evaluate(&doc);
    let r0 = forge_regen::report(&doc, &ev0, "forge", name);
    let loaded = forge_regen::v1::load(text).expect("the v0 program loads as v1");
    assert!(
        loaded
            .migration
            .as_ref()
            .is_some_and(|m| m.renames.is_empty()),
        "{name}: the migration rewrote ids"
    );
    let ev1 = forge_regen::v1::evaluate(&loaded.doc);
    let r1 = forge_regen::v1::report(&ev1, "forge", name, loaded.migration.as_ref());
    let mut out = Vec::new();
    let status0 = r0.status == forge_ir::Status::Ok;
    if status0 != (r1.status == S1::Ok) {
        out.push(format!(
            "document status v0 ok={status0}, v1 {:?}",
            r1.status
        ));
    }
    if r0.features.len() != r1.features.len() {
        out.push(format!(
            "feature count v0 {} v1 {}",
            r0.features.len(),
            r1.features.len()
        ));
        return out;
    }
    let mut v0_bodies = Vec::new();
    for (i, (a, b)) in r0.features.iter().zip(&r1.features).enumerate() {
        let at = format!("features[{i}] {}", a.feature);
        if (&a.part, &a.feature, &a.feature_type) != (&b.part, &b.feature, &b.feature_type) {
            out.push(format!(
                "{at}: identity v0 {}/{}/{} v1 {}/{}/{}",
                a.part, a.feature, a.feature_type, b.part, b.feature, b.feature_type
            ));
            continue;
        }
        if (a.status == forge_ir::Status::Ok) != (b.status == S1::Ok) {
            out.push(format!("{at}: status"));
        }
        let (ca, cb) = (
            a.error.as_ref().map(|e| e.code.clone()),
            b.error.as_ref().map(|e| e.code.clone()),
        );
        if ca != cb {
            out.push(format!("{at}: code v0 {ca:?} v1 {cb:?}"));
        }
        if a.regions.len() != b.regions.len() {
            out.push(format!("{at}: region count"));
        } else {
            for (x, y) in a.regions.iter().zip(&b.regions) {
                if x.area.to_bits() != y.area.to_bits()
                    || x.loops != y.loops
                    || x.outer_curves != y.outer_curves
                {
                    out.push(format!("{at}: region {:?} vs {:?}", x, y));
                }
            }
        }
        // v0 lists a feature's bodies in region order, v1 in canonical order (§5.4): the same
        // bodies, compared as multisets of their bit patterns.
        let mut ka: Vec<String> = a.bodies.iter().map(key0).collect();
        let mut kb: Vec<String> = b.bodies.iter().map(key1).collect();
        ka.sort();
        kb.sort();
        if ka != kb {
            out.push(format!("{at}: body metrics\n  v0 {ka:?}\n  v1 {kb:?}"));
        }
        v0_bodies.extend(ka);
    }
    // v0 bodies are never modified later: the final part state is every body produced.
    let mut parts: Vec<String> = r1
        .parts
        .iter()
        .flat_map(|p| p.bodies.iter().map(key1))
        .collect();
    parts.sort();
    v0_bodies.sort();
    if parts != v0_bodies {
        out.push("parts[].bodies differ from the bodies the features produced".into());
    }
    out
}

fn gate(programs: &[PathBuf]) -> (usize, Vec<String>) {
    let mut problems = Vec::new();
    for p in programs {
        let text = std::fs::read_to_string(p).expect("program");
        let name = p.file_stem().unwrap().to_string_lossy().into_owned();
        for d in differences(&text, &name) {
            problems.push(format!("{}: {d}", p.display()));
        }
    }
    (programs.len(), problems)
}

#[test]
fn committed_v0_programs_keep_their_metrics_through_the_v1_evaluator() {
    let programs = committed_programs();
    assert!(programs.len() >= 8 + 60, "only {} programs", programs.len());
    let (n, problems) = gate(&programs);
    assert!(
        problems.is_empty(),
        "{} of {n} programs differ:\n{}",
        problems.len(),
        problems.join("\n")
    );
}

#[test]
#[ignore = "thousands of generated programs: run with --release -- --ignored"]
fn generated_programs_keep_their_metrics_through_the_v1_evaluator() {
    let mut programs = Vec::new();
    if let Ok(rd) = std::fs::read_dir(repo().join("corpus/generated")) {
        let mut seeds: Vec<PathBuf> = rd
            .map(|e| e.unwrap().path())
            .filter(|p| p.is_dir())
            .collect();
        seeds.sort();
        for s in seeds {
            programs.extend(jsons(&s, |n| {
                n.starts_with("gen_") && n.ends_with(".json") && !n.ends_with(".stats.json")
            }));
        }
    }
    if programs.is_empty() {
        eprintln!("no generated programs under corpus/generated; nothing to check");
        return;
    }
    let (n, problems) = gate(&programs);
    eprintln!("{n} generated programs, {} differences", problems.len());
    assert!(
        problems.is_empty(),
        "{} differences:\n{}",
        problems.len(),
        problems[..problems.len().min(40)].join("\n")
    );
}
