//! Smoke and differential test on the migrated fixtures (`corpus/v1/conformance/migration`):
//! every sketch of every migrated v1 document (MakerBench, the v0 programs, the rename cases)
//! evaluates through [`forge_sketch::evaluate_sketch`], and its regions equal what forge-ops
//! computes on the v0 original — same count, loop counts, areas (bit for bit: migration copies
//! the coordinates) and names (v0 curve k is v1 curve k: migration keeps the order and only
//! renames invalid ids) — or both fail with the same code.

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use common::*;
use forge_core::Tolerance;

/// The `*.v1.json` files of `dir`, sorted.
fn v1_files(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("fixture dir")
        .map(|e| e.expect("entry").path())
        .filter(|p| p.to_string_lossy().ends_with(".v1.json"))
        .collect();
    out.sort();
    out
}

#[test]
fn every_migrated_sketch_evaluates_to_the_v0_regions() {
    let root = repo_root().join("corpus/v1/conformance/migration");
    let (mut docs, mut sketches, mut regions, mut failures) = (0, 0, 0, 0);
    for dir in ["makerbench", "programs", "renames"] {
        for v1_path in v1_files(&root.join(dir)) {
            let name = v1_path.file_name().unwrap().to_string_lossy().to_string();
            let v1 = forge_ir::v1::from_json(&std::fs::read_to_string(&v1_path).unwrap())
                .unwrap_or_else(|e| panic!("{name}: {e:?}"));
            let v0_path = PathBuf::from(v1_path.to_string_lossy().replace(".v1.json", ".v0.json"));
            let v0 = forge_ir::from_json(&std::fs::read_to_string(&v0_path).unwrap())
                .unwrap_or_else(|e| panic!("{name} (v0): {e:?}"));
            // Literal document parameters (sites that are one parameter name resolve to them).
            let params: BTreeMap<String, f64> = v1
                .params
                .iter()
                .filter_map(|p| match &p.value {
                    forge_ir::v1::ParamValue::Num(v) => Some((p.name.clone(), *v)),
                    _ => None,
                })
                .collect();
            let v0_sketches: Vec<&forge_ir::SketchFeature> = v0
                .parts
                .iter()
                .flat_map(|p| &p.features)
                .filter_map(|f| match f {
                    forge_ir::Feature::Sketch(s) => Some(s),
                    _ => None,
                })
                .collect();
            let v1_sketches: Vec<&forge_ir::v1::SketchFeature> = v1
                .parts
                .iter()
                .flat_map(|p| &p.features)
                .filter_map(|f| match f {
                    forge_ir::v1::Feature::Sketch(s) => Some(s),
                    _ => None,
                })
                .collect();
            assert_eq!(v0_sketches.len(), v1_sketches.len(), "{name}: sketch count");
            docs += 1;
            for (a, b) in v0_sketches.into_iter().zip(v1_sketches) {
                sketches += 1;
                let label = format!("{name}: sketch {}", b.id);
                // Migration keeps the curves in order and renames invalid ids (the fixture's
                // `.renames.json`): v0 curve k is v1 curve k.
                assert_eq!(a.curves.len(), b.curves.len(), "{label}: curve count");
                let renames: BTreeMap<&str, &str> = a
                    .curves
                    .iter()
                    .zip(&b.curves)
                    .map(|(x, y)| (x.id(), y.id()))
                    .collect();
                let want = forge_ops::regions(a, &Tolerance::IR_DEFAULT);
                let got = eval_params(b, &params);
                match (want, got) {
                    (Ok(want), Ok(got)) => {
                        assert_warnings_conform(&got);
                        assert!(got.warnings.is_empty(), "{label}: {:?}", got.warnings);
                        // (sorted outer-curve names, area bits, loops) per region; sorted,
                        // since canonical order breaks ties (equal areas) by name, and a
                        // rename can swap two such regions.
                        let mut got: Vec<(Vec<String>, u64, usize)> = got
                            .region_metrics()
                            .into_iter()
                            .map(|g| {
                                let mut names = g.outer_curves;
                                names.sort();
                                (names, g.area.to_bits(), g.loops as usize)
                            })
                            .collect();
                        let mut want: Vec<(Vec<String>, u64, usize)> = want
                            .iter()
                            .map(|w| {
                                let mut names: Vec<String> = w
                                    .outer_curves
                                    .iter()
                                    .map(|id| renames[id.as_str()].to_string())
                                    .collect();
                                names.sort();
                                (names, (w.area + 0.0).to_bits(), w.loop_count())
                            })
                            .collect();
                        got.sort();
                        want.sort();
                        assert_eq!(got, want, "{label}");
                        regions += got.len();
                    }
                    (Err(want), Err(got)) => {
                        assert_error_conforms(&got);
                        assert_eq!(got.code(), want.code(), "{label}");
                        failures += 1;
                    }
                    (want, got) => panic!(
                        "{label}: v0 {}, v1 {}",
                        want.map_or_else(|e| e.code().to_string(), |_| "ok".into()),
                        got.map_or_else(|e| e.code().to_string(), |_| "ok".into())
                    ),
                }
            }
        }
    }
    eprintln!(
        "migration: {docs} documents, {sketches} sketches, {regions} regions equal to v0, {failures} failing identically"
    );
    assert!(docs >= 70, "{docs}");
    assert!(sketches >= 70, "{sketches}");
}
