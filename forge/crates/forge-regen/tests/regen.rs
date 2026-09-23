//! Document evaluation (SPEC §4) and reports (SPEC §5): corpus metrics against closed
//! forms, determinism, the SPEC §6 comparison with the oracle's golden reports, and the
//! dependency / suppression / failure semantics.

use std::path::{Path, PathBuf};

use forge_core::math::PI;
use forge_ir::{BodyMetrics, EvalReport, FeatureReport, Status};
use forge_regen::{engine_id, evaluate, report};

fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../corpus")
}

fn program_names() -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(corpus_dir().join("programs"))
        .expect("corpus/programs")
        .filter_map(|e| {
            let p = e.ok()?.path();
            if p.extension()? != "json" {
                return None;
            }
            Some(p.file_stem()?.to_string_lossy().into_owned())
        })
        .collect();
    v.sort();
    v
}

fn eval_text(text: &str, name: &str) -> EvalReport {
    let doc = forge_ir::from_json(text).expect("valid IR");
    let ev = evaluate(&doc);
    report(&doc, &ev, &engine_id(), name)
}

fn eval_program(name: &str) -> EvalReport {
    let text = std::fs::read_to_string(corpus_dir().join(format!("programs/{name}.json")))
        .expect("program");
    eval_text(&text, name)
}

fn body(r: &EvalReport, feature: usize, i: usize) -> &BodyMetrics {
    &r.features[feature].bodies[i]
}

fn close(a: f64, b: f64, rel: f64) -> bool {
    (a - b).abs() <= rel * b.abs().max(1.0)
}

#[test]
fn corpus_reports_match_closed_forms() {
    let exact: &[(&str, &[f64])] = &[
        ("extrude_box", &[32000.0]),
        (
            "extrude_plate_with_holes",
            &[100.0 * 60.0 * 5.0 - 4.0 * PI * 2.75 * 2.75 * 5.0],
        ),
        (
            "extrude_slot_symmetric_xz",
            &[(40.0 * 12.0 + PI * 36.0) * 10.0],
        ),
        (
            "extrude_two_regions",
            &[PI * 64.0 * 3.0, PI * (400.0 - 144.0) * 3.0],
        ),
        (
            "revolve_cone_sphere",
            &[PI * 100.0 * 20.0 / 3.0 + 2.0 / 3.0 * PI * 1000.0],
        ),
        (
            "revolve_partial_ring",
            &[PI / 4.0 * (32.0 * 32.0 - 20.0 * 20.0) * 6.0],
        ),
        ("revolve_solid_cylinder", &[PI * 100.0 * 30.0]),
        ("revolve_torus", &[2.0 * PI * PI * 15.0 * 16.0]),
    ];
    for (name, volumes) in exact {
        let r = eval_program(name);
        assert_eq!(r.status, Status::Ok, "{name}");
        assert_eq!(r.features.len(), 2);
        let bodies = &r.features[1].bodies;
        assert_eq!(bodies.len(), volumes.len(), "{name}");
        for (b, v) in bodies.iter().zip(volumes.iter()) {
            assert!(close(b.volume, *v, 1e-12), "{name}: {} vs {v}", b.volume);
            assert!(b.valid);
        }
    }
    // Spot checks of the other fields.
    let r = eval_program("revolve_cone_sphere");
    let b = body(&r, 1, 0);
    assert_eq!((b.faces, b.edges), (2, 1));
    assert!(close(b.centroid[2], 0.625, 1e-12));
    assert!((b.bbox_max[2] - 20.0).abs() == 0.0);
    let r = eval_program("extrude_plate_with_holes");
    assert_eq!(r.features[0].regions[0].loops, 5);
}

#[test]
fn reports_are_byte_identical_across_runs() {
    for name in program_names() {
        let a = serde_json::to_string_pretty(&eval_program(&name)).expect("json");
        let b = serde_json::to_string_pretty(&eval_program(&name)).expect("json");
        assert_eq!(a, b, "{name}");
        // Canonical re-serialization of the document does not change the report.
        let text = std::fs::read_to_string(corpus_dir().join(format!("programs/{name}.json")))
            .expect("program");
        let doc = forge_ir::from_json(&text).expect("valid");
        let c = serde_json::to_string_pretty(&eval_text(&forge_ir::to_json(&doc), &name))
            .expect("json");
        assert_eq!(a, c, "{name}");
    }
}

// ---- SPEC §6 comparison against the oracle's golden reports ------------------------------

fn semantic(code: &str) -> bool {
    !(code.starts_with("FORGE_") || code.starts_with("OCCT_") || code.starts_with("ORACLE_"))
}

fn rel_or_abs(a: f64, b: f64, floor: f64) -> bool {
    (a - b).abs() <= (1e-6 * a.abs().max(b.abs())).max(floor)
}

fn diag(b: &BodyMetrics) -> f64 {
    (0..3)
        .map(|i| (b.bbox_max[i] - b.bbox_min[i]).powi(2))
        .sum::<f64>()
        .sqrt()
}

fn compare_features(a: &FeatureReport, b: &FeatureReport, out: &mut Vec<String>) {
    let at = format!("{}/{}", a.part, a.feature);
    if (&a.part, &a.feature, &a.feature_type) != (&b.part, &b.feature, &b.feature_type) {
        out.push(format!("{at}: feature identity differs"));
        return;
    }
    if a.status != b.status {
        out.push(format!("{at}: status {:?} vs {:?}", a.status, b.status));
        return;
    }
    if let (Some(ea), Some(eb)) = (&a.error, &b.error) {
        if semantic(&ea.code) && semantic(&eb.code) && ea.code != eb.code {
            out.push(format!("{at}: code {} vs {}", ea.code, eb.code));
        }
        return;
    }
    if a.regions.len() != b.regions.len() {
        out.push(format!("{at}: region count"));
    }
    for (x, y) in a.regions.iter().zip(&b.regions) {
        if x.loops != y.loops
            || x.outer_curves != y.outer_curves
            || !rel_or_abs(x.area, y.area, 1e-9)
        {
            out.push(format!("{at}: region {:?} vs {:?}", x, y));
        }
    }
    if a.bodies.len() != b.bodies.len() {
        out.push(format!("{at}: body count"));
    }
    for (x, y) in a.bodies.iter().zip(&b.bodies) {
        let s = diag(x).max(diag(y)).max(1.0);
        let nz = |h: &std::collections::BTreeMap<String, u32>| {
            h.iter()
                .filter(|(_, v)| **v != 0)
                .map(|(k, v)| (k.clone(), *v))
                .collect::<Vec<_>>()
        };
        if (x.faces, x.edges) != (y.faces, y.edges)
            || nz(&x.face_types) != nz(&y.face_types)
            || nz(&x.edge_types) != nz(&y.edge_types)
        {
            out.push(format!("{at}: topology {x:?} vs {y:?}"));
        }
        if !rel_or_abs(x.volume, y.volume, 1e-9 * s * s * s) {
            out.push(format!("{at}: volume {} vs {}", x.volume, y.volume));
        }
        if !rel_or_abs(x.area, y.area, 1e-9 * s * s) {
            out.push(format!("{at}: area {} vs {}", x.area, y.area));
        }
        for (what, p, q) in [
            ("centroid", x.centroid, y.centroid),
            ("bbox_min", x.bbox_min, y.bbox_min),
            ("bbox_max", x.bbox_max, y.bbox_max),
        ] {
            if (0..3).any(|i| (p[i] - q[i]).abs() > 1e-6 * s) {
                out.push(format!("{at}: {what} {p:?} vs {q:?}"));
            }
        }
    }
}

/// Why a golden comparison could not run. Outside CI a missing `corpus/golden` is only a
/// skip (a partial checkout); in CI (`CI` set, as on every hosted runner) it fails, and a
/// missing or unparseable golden report always fails: the comparison must never pass
/// having compared nothing (audit M6).
fn golden_dir_or_skip() -> Option<PathBuf> {
    let golden = corpus_dir().join("golden");
    if golden.is_dir() {
        return Some(golden);
    }
    assert!(
        std::env::var_os("CI").is_none(),
        "corpus/golden is missing under CI: the SPEC §6 golden comparison cannot run"
    );
    eprintln!("corpus/golden is absent; skipping the golden comparison (not CI)");
    None
}

/// Compare Forge's report of every program in `names` with `golden/<name>.metrics.json`.
/// Returns how many were compared and the problems; a missing or unparseable golden
/// report is a problem, never a skip.
fn golden_problems(names: &[String], golden: &Path) -> (usize, Vec<String>) {
    let mut compared = 0;
    let mut problems = Vec::new();
    for name in names {
        let path = golden.join(format!("{name}.metrics.json"));
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => {
                problems.push(format!("{name}: no golden report {} ({e})", path.display()));
                continue;
            }
        };
        let g: EvalReport = match serde_json::from_str(&text) {
            Ok(g) => g,
            Err(e) => {
                problems.push(format!(
                    "{name}: {} is not an aicad.metrics/0 report ({e})",
                    path.display()
                ));
                continue;
            }
        };
        let f = eval_program(name);
        compared += 1;
        if f.status != g.status {
            problems.push(format!(
                "{name}: document status {:?} vs {:?}",
                f.status, g.status
            ));
        }
        if f.features.len() != g.features.len() {
            problems.push(format!("{name}: feature count"));
        }
        let mut out = Vec::new();
        for (a, b) in f.features.iter().zip(&g.features) {
            compare_features(a, b, &mut out);
        }
        problems.extend(out.into_iter().map(|p| format!("{name}: {p}")));
    }
    (compared, problems)
}

#[test]
fn reports_match_the_oracle_golden_reports_per_spec_6() {
    let Some(golden) = golden_dir_or_skip() else {
        return;
    };
    let names = program_names();
    assert!(!names.is_empty(), "corpus/programs is empty");
    let (compared, problems) = golden_problems(&names, &golden);
    eprintln!("compared {compared} golden reports");
    assert!(problems.is_empty(), "{problems:#?}");
    assert_eq!(
        compared,
        names.len(),
        "every corpus program must be compared with its golden report"
    );
}

#[test]
fn missing_or_unparseable_golden_reports_are_problems_not_skips() {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("regen-golden-m6");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let names: Vec<String> = ["extrude_box", "extrude_plate_with_holes", "revolve_torus"]
        .map(String::from)
        .to_vec();
    // A good golden (Forge's own report), a truncated one, and none for revolve_torus.
    let good = serde_json::to_string_pretty(&eval_program("extrude_box")).expect("json");
    std::fs::write(dir.join("extrude_box.metrics.json"), &good).expect("write");
    std::fs::write(
        dir.join("extrude_plate_with_holes.metrics.json"),
        &good[..good.len() / 2],
    )
    .expect("write");
    let (compared, problems) = golden_problems(&names, &dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(compared, 1);
    assert_eq!(problems.len(), 2, "{problems:#?}");
    assert!(problems[0].contains("is not an aicad.metrics/0 report"));
    assert!(problems[1].contains("no golden report"));
}

// ---- evaluation semantics ------------------------------------------------------------------

const SEMANTICS_DOC: &str = r#"{
  "schema": "aicad.ir/0",
  "meta": { "name": "semantics" },
  "parts": [
    { "id": "p1", "name": "part one", "features": [
      { "type": "sketch", "id": "s1", "name": "good", "plane": "XY", "curves": [
        { "kind": "circle", "id": "c", "center": [10, 0], "radius": 2 },
        { "kind": "circle", "id": "d", "center": [-10, 0], "radius": 2 } ] },
      { "type": "sketch", "id": "s2", "name": "hidden", "plane": "XY", "suppressed": true,
        "curves": [ { "kind": "circle", "id": "c", "center": [0, 0], "radius": 1 } ] },
      { "type": "sketch", "id": "s3", "name": "broken", "plane": "XY", "curves": [
        { "kind": "line", "id": "l", "start": [0, 0], "end": [1, 0] } ] },
      { "type": "extrude", "id": "e1", "name": "ok_extrude", "sketch": "good", "distance": 2 },
      { "type": "extrude", "id": "e2", "name": "from_hidden", "sketch": "hidden", "distance": 2 },
      { "type": "extrude", "id": "e3", "name": "from_broken", "sketch": "broken", "distance": 2 },
      { "type": "extrude", "id": "e4", "name": "skipped", "sketch": "good", "distance": 2,
        "suppressed": true },
      { "type": "revolve", "id": "r1", "name": "sides", "sketch": "good",
        "axis": { "origin": [0, 0], "direction": [0, 1] }, "angle": 90 },
      { "type": "revolve", "id": "r2", "name": "crossing", "sketch": "good",
        "axis": { "origin": [10, 0], "direction": [0, 1] }, "angle": 90 },
      { "type": "extrude", "id": "e5", "name": "after_errors", "sketch": "good",
        "distance": 1, "direction": "symmetric" }
    ] }
  ]
}"#;

#[test]
fn dependency_suppression_and_failures_follow_spec_4() {
    let r = eval_text(SEMANTICS_DOC, "semantics");
    assert_eq!(r.status, Status::Error);
    let rows: Vec<(&str, &str, Option<&str>, usize)> = r
        .features
        .iter()
        .map(|f| {
            (
                f.part.as_str(),
                f.feature.as_str(),
                f.error.as_ref().map(|e| e.code.as_str()),
                f.bodies.len() + f.regions.len(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            ("part one", "good", None, 2),
            ("part one", "broken", Some("SKETCH_OPEN_LOOP"), 0),
            ("part one", "ok_extrude", None, 2),
            ("part one", "from_hidden", Some("SKETCH_SUPPRESSED"), 0),
            ("part one", "from_broken", Some("DEPENDENCY_FAILED"), 0),
            // Regions on opposite sides of the axis are fine [R-7].
            ("part one", "sides", None, 2),
            // One region crossing the axis fails the whole feature, no bodies.
            ("part one", "crossing", Some("REVOLVE_CROSSES_AXIS"), 0),
            ("part one", "after_errors", None, 2),
        ]
    );
    let dep = r.features[4].error.as_ref().expect("error");
    assert!(dep.message.contains("broken") && dep.message.contains("SKETCH_OPEN_LOOP"));
    // Region order is canonical (by outer curve ids): "c" before "d".
    assert_eq!(r.features[0].regions[0].outer_curves, vec!["c".to_string()]);
    let sym = &r.features[7].bodies[0];
    assert!((sym.bbox_min[2] + 0.5).abs() < 1e-15 && (sym.bbox_max[2] - 0.5).abs() < 1e-15);
}
