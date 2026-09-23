//! The W0 migration gate (IR-V1 plan §4 W0, SPEC-v1 §9.1).
//!
//! Every v0 program — the 8 corpus programs, every MakerBench reference and context compiled to
//! IR (`corpus/v1/conformance/migration/makerbench`), and the generated seeds in
//! `corpus/generated/s*/` when present (they are not committed) — must:
//! 1. migrate to a valid v1 document with no id rewrites;
//! 2. re-serialize stably (`to_json ∘ from_json` is the identity on canonical text);
//! 3. come back unchanged through the v0 compatibility path (`downgrade_to_v0(migrate(d)) == d`);
//! 4. evaluate to a bit-identical report through that path.
//!
//! forge-regen cannot evaluate v1 documents yet (W1–W3), so point 4 evaluates the downgraded
//! document; with point 3 this is the strongest metric statement available before the v1
//! evaluator exists. W1–W3 must re-run this gate with `forge_regen` evaluating the migrated
//! v1 document directly and comparing its `aicad.metrics/1` report field by field (SPEC-v1 §9.1
//! "Metric preservation").

use std::path::{Path, PathBuf};

use forge_ir::v1;

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

fn generated_programs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    let Ok(rd) = std::fs::read_dir(repo().join("corpus/generated")) else {
        return v;
    };
    let mut seeds: Vec<PathBuf> = rd
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_dir())
        .collect();
    seeds.sort();
    for s in seeds {
        v.extend(jsons(&s, |n| {
            n.starts_with("gen_") && n.ends_with(".json") && !n.ends_with(".stats.json")
        }));
    }
    v
}

/// Points 1–3; returns the v0 document.
fn check_structure(path: &Path) -> forge_ir::Document {
    let text = std::fs::read_to_string(path).unwrap();
    let v0 = forge_ir::from_json(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let (m, report) = v1::migrate_v0_to_v1_report(&v0);
    assert!(
        report.renames.is_empty(),
        "{}: unexpected id rewrites {:?}",
        path.display(),
        report.renames
    );
    v1::validate(&m).unwrap_or_else(|e| panic!("{}: {e:?}", path.display()));
    let s = v1::to_json(&m);
    let back = v1::from_json(&s).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(back, m, "{}: v1 round trip", path.display());
    assert_eq!(
        v1::to_json(&back),
        s,
        "{}: re-serialization is not stable",
        path.display()
    );
    assert_eq!(
        v1::migrate_v0_to_v1(&v0),
        m,
        "{}: migration is deterministic",
        path.display()
    );
    let down = v1::downgrade_to_v0(&m).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(down, v0, "{}: compatibility path", path.display());
    v0
}

/// Point 4.
fn check_metrics(path: &Path, v0: &forge_ir::Document) {
    let m = v1::migrate_v0_to_v1(v0);
    let down = v1::downgrade_to_v0(&m).unwrap();
    let name = path.file_stem().unwrap().to_string_lossy();
    let engine = forge_regen::engine_id();
    let r0 = forge_regen::report(v0, &forge_regen::evaluate(v0), &engine, &name);
    let r1 = forge_regen::report(&down, &forge_regen::evaluate(&down), &engine, &name);
    assert_eq!(
        serde_json::to_string(&r0).unwrap(),
        serde_json::to_string(&r1).unwrap(),
        "{}: report changed",
        path.display()
    );
}

#[test]
fn committed_v0_programs_pass_the_migration_gate() {
    let progs = committed_programs();
    assert!(progs.len() >= 8 + 61, "{} programs", progs.len());
    for p in &progs {
        let v0 = check_structure(p);
        check_metrics(p, &v0);
    }
}

#[test]
fn generated_v0_programs_migrate_and_reserialize_stably() {
    let progs = generated_programs();
    if progs.is_empty() {
        eprintln!("corpus/generated is absent (not committed): skipped");
        return;
    }
    for (i, p) in progs.iter().enumerate() {
        let v0 = check_structure(p);
        // Evaluating 6,000 programs is slow in debug builds; sample here, all in the ignored
        // test below (run it with --release).
        if i % 97 == 0 {
            check_metrics(p, &v0);
        }
    }
    eprintln!("{} generated programs checked", progs.len());
}

#[test]
#[ignore = "slow in debug: cargo test -p forge-ir --release --test v1_migration_gate -- --ignored"]
fn generated_v0_programs_keep_identical_reports() {
    let progs = generated_programs();
    for p in &progs {
        let v0 = check_structure(p);
        check_metrics(p, &v0);
    }
    eprintln!("{} generated programs evaluated", progs.len());
}
