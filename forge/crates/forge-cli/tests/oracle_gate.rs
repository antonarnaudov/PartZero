//! The integration's oracle gate, tracked explicitly (CLAUDE.md principle 2, SPEC-v1 §8.4):
//! runs `oracle diff` (OCCT, `uv` environment of `oracle/`) against this `aicad` and checks the
//! result against `forge-regen/tests/v1_oracle_known_differences.json`.
//!
//! ```text
//! cargo test -p forge-cli --test oracle_gate -- --ignored --nocapture
//! AICAD_ORACLE_GATE_DIRS=/tmp/gen41:/tmp/gen42 cargo test -p forge-cli --test oracle_gate -- --ignored --nocapture
//! AICAD_ORACLE_GATE_DIRS=/tmp/g5.md:/tmp/g11.md cargo test -p forge-cli --test oracle_gate -- --ignored --nocapture
//! ```
//!
//! (`AICAD_ORACLE_GATE_DIRS` entries ending in `.md` are existing `oracle diff --report` files.)
//!
//! - **Regression programs** (`forge-regen/tests/v1_programs`): every program not listed in the
//!   manifest is `MATCH`; every listed one has exactly its class (so fixing the cause — in Forge,
//!   the oracle or the SPEC — makes this test fail until the entry is removed), and every
//!   `POTENTIAL_SILENT_WRONG` difference of a program of a known family has that family's
//!   signature.
//! - **Generated corpora** (`AICAD_ORACLE_GATE_DIRS`, e.g. the output of `oracle gen --ir v1`):
//!   prints the class counts, and fails on any `POTENTIAL_SILENT_WRONG` difference outside the
//!   manifest's families. The W4/F1 gate itself (0 `POTENTIAL_SILENT_WRONG`, ≥ 99.5 % `MATCH`)
//!   is met only when the families are empty too; this test reports, it does not waive.
//!
//! Ignored by default: it needs `uv` and the oracle's OCCT wheels.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

fn repo(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../../{rel}"))
}

fn manifest() -> serde_json::Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../forge-regen/tests/v1_oracle_known_differences.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("manifest")).expect("JSON")
}

/// One `oracle diff` run: class per program, and the difference lines of each program.
struct Diff {
    classes: BTreeMap<String, String>,
    differences: BTreeMap<String, Vec<(String, String)>>,
}

fn oracle_diff(target: &Path) -> Diff {
    let report = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "oracle_gate_{}.md",
        target.file_name().unwrap().to_string_lossy()
    ));
    let out = Command::new("uv")
        .current_dir(repo("oracle"))
        .args(["run", "oracle", "diff"])
        .arg(target)
        .arg("--forge-bin")
        .arg(env!("CARGO_BIN_EXE_aicad"))
        .arg("--report")
        .arg(&report)
        .output()
        .expect("run `uv run oracle diff` (is uv installed?)");
    let md = std::fs::read_to_string(&report).unwrap_or_else(|e| {
        panic!(
            "no oracle report ({e}); stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        )
    });
    parse_report(&md, &report)
}

/// Classes and difference rows of an `oracle diff --report` Markdown report.
fn parse_report(md: &str, report: &Path) -> Diff {
    // Summary table rows: | `program` | reference | oracle | ref | **CLASS** or CLASS | …
    let mut classes = BTreeMap::new();
    for line in md.lines() {
        let cells: Vec<&str> = line.split('|').map(str::trim).collect();
        if cells.len() >= 6 && cells[1].starts_with('`') && cells[1].ends_with('`') {
            let name = cells[1].trim_matches('`').to_string();
            let class = cells[5].trim_matches('*').to_string();
            classes.insert(name, class);
        }
    }
    // Detail sections: ### `program` — CLASS, then - `CLASS` path: detail
    let mut differences: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    let mut current: Option<String> = None;
    for line in md.lines() {
        if let Some(rest) = line.strip_prefix("### `") {
            current = rest.split('`').next().map(str::to_string);
        } else if let (Some(p), Some(rest)) = (&current, line.strip_prefix("- `")) {
            let mut it = rest.splitn(2, '`');
            let class = it.next().unwrap_or_default().to_string();
            let detail = it.next().unwrap_or_default().trim().to_string();
            differences
                .entry(p.clone())
                .or_default()
                .push((class, detail));
        }
    }
    assert!(!classes.is_empty(), "could not parse {}", report.display());
    Diff {
        classes,
        differences,
    }
}

/// `forge=N oracle=M` at the end of a count row (`edges`, `faces`).
fn count_row(detail: &str, what: &str) -> Option<(i64, i64)> {
    let pat = format!(": {what} forge=");
    let i = detail.find(&pat)?;
    let rest = &detail[i + pat.len()..];
    let (a, b) = rest.split_once(" oracle=")?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

/// The per-type difference (oracle − Forge, non-zero only) of a histogram row (`edge_types`,
/// `face_types`), from the report's Python-dict rendering.
fn type_row(detail: &str, what: &str) -> Option<BTreeMap<String, i64>> {
    let pat = format!(": {what} forge=");
    let i = detail.find(&pat)?;
    let rest = &detail[i + pat.len()..];
    let (a, b) = rest.split_once(" oracle=")?;
    let parse = |s: &str| -> Option<BTreeMap<String, i64>> {
        let body = s.trim().strip_prefix('{')?.strip_suffix('}')?;
        body.split(',')
            .filter(|kv| !kv.trim().is_empty())
            .map(|kv| {
                let (k, v) = kv.split_once(':')?;
                Some((
                    k.trim().trim_matches('\'').to_string(),
                    v.trim().parse().ok()?,
                ))
            })
            .collect()
    };
    let (fa, fb) = (parse(a)?, parse(b)?);
    let keys: std::collections::BTreeSet<&String> = fa.keys().chain(fb.keys()).collect();
    Some(
        keys.into_iter()
            .map(|k| {
                let d = fb.get(k).copied().unwrap_or(0) - fa.get(k).copied().unwrap_or(0);
                (k.clone(), d)
            })
            .filter(|(_, d)| *d != 0)
            .collect(),
    )
}

/// `oracle-seam-split-arcs`: the oracle has 1 or 2 more edges, or only conic types differ and
/// the oracle has 1 or 2 more of each.
fn seam_split_arcs(detail: &str) -> bool {
    if let Some((a, b)) = count_row(detail, "edges") {
        return (1..=2).contains(&(b - a));
    }
    type_row(detail, "edge_types").is_some_and(|d| {
        !d.is_empty()
            && d.iter()
                .all(|(k, v)| matches!(k.as_str(), "circle" | "ellipse") && (1..=2).contains(v))
    })
}

/// `oracle-seam-split-faces`: the oracle has exactly 1 more face, or only periodic face types
/// differ and the oracle has 1 more of each.
fn seam_split_faces(detail: &str) -> bool {
    if let Some((a, b)) = count_row(detail, "faces") {
        return b - a == 1;
    }
    type_row(detail, "face_types").is_some_and(|d| {
        !d.is_empty()
            && d.iter().all(|(k, v)| {
                matches!(k.as_str(), "cylinder" | "cone" | "sphere" | "torus") && *v == 1
            })
    })
}

/// `oracle-seam-edge-dropped`: Forge has exactly 1 more edge, all of it one more `line`.
fn seam_edge_dropped(detail: &str) -> bool {
    if let Some((a, b)) = count_row(detail, "edges") {
        return a - b == 1;
    }
    type_row(detail, "edge_types").is_some_and(|d| d.len() == 1 && d.get("line") == Some(&-1))
}

fn family_matches(family: &str, detail: &str) -> bool {
    match family {
        "oracle-seam-split-arcs" => seam_split_arcs(detail),
        "oracle-seam-split-faces" => seam_split_faces(detail) || seam_split_arcs(detail),
        "oracle-seam-edge-dropped" => seam_edge_dropped(detail),
        other => panic!("unknown family {other}: add its signature here"),
    }
}

#[test]
#[ignore = "needs uv and the oracle's OCCT environment"]
fn regression_programs_match_the_oracle_except_the_tracked_differences() {
    let m = manifest();
    let known: BTreeMap<String, &serde_json::Value> = m["programs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| (k["program"].as_str().unwrap().to_string(), k))
        .collect();
    let d = oracle_diff(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../forge-regen/tests/v1_programs"),
    );
    let mut problems = Vec::new();
    for (program, class) in &d.classes {
        match known.get(program) {
            None if class != "MATCH" => {
                problems.push(format!("{program}: {class}, not in the manifest"));
            }
            None => {}
            Some(k) => {
                if k["class"].as_str() != Some(class.as_str()) {
                    problems.push(format!(
                        "{program}: {class}, the manifest says {} (update or remove the entry)",
                        k["class"]
                    ));
                }
                if let Some(family) = k["family"].as_str() {
                    for (c, detail) in d.differences.get(program).into_iter().flatten() {
                        if c == "POTENTIAL_SILENT_WRONG" && !family_matches(family, detail) {
                            problems.push(format!("{program}: not {family}: {detail}"));
                        }
                    }
                }
            }
        }
    }
    for program in known.keys() {
        if !d.classes.contains_key(program) {
            problems.push(format!("{program}: listed but not diffed"));
        }
    }
    println!("{:#?}", d.classes);
    assert!(problems.is_empty(), "{problems:#?}");
}

#[test]
#[ignore = "needs uv, the oracle's OCCT environment and AICAD_ORACLE_GATE_DIRS"]
fn generated_corpora_have_no_potential_silent_wrong_outside_the_tracked_families() {
    let Ok(dirs) = std::env::var("AICAD_ORACLE_GATE_DIRS") else {
        eprintln!("AICAD_ORACLE_GATE_DIRS is not set; nothing to check");
        return;
    };
    let m = manifest();
    let families: Vec<String> = m["families"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["family"].as_str().unwrap().to_string())
        .collect();
    let diagnosed: Vec<String> = m["generated"]["programs"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|p| p["program"].as_str().unwrap().to_string())
                .collect()
        })
        .unwrap_or_default();
    let mut unexplained = Vec::new();
    // `AICAD_ORACLE_GATE_REPORTS` entries are existing `oracle diff --report` files (diff once,
    // classify here); the others are program directories, diffed now.
    for dir in dirs.split(':').filter(|s| !s.is_empty()) {
        let d = if dir.ends_with(".md") {
            let md = std::fs::read_to_string(dir).unwrap_or_else(|e| panic!("{dir}: {e}"));
            parse_report(&md, Path::new(dir))
        } else {
            oracle_diff(Path::new(dir))
        };
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        let mut by_family: BTreeMap<&str, usize> = BTreeMap::new();
        for (program, class) in &d.classes {
            *counts.entry(class.as_str()).or_default() += 1;
            if class != "POTENTIAL_SILENT_WRONG" {
                continue;
            }
            let rows: Vec<&(String, String)> = d
                .differences
                .get(program)
                .into_iter()
                .flatten()
                .filter(|(c, _)| c == "POTENTIAL_SILENT_WRONG")
                .collect();
            if diagnosed.contains(program) {
                *by_family
                    .entry("diagnosed (manifest `generated`)")
                    .or_default() += 1;
                continue;
            }
            // Every row must have some family's signature; the program counts for the first
            // family that explains all of its rows, else for "several".
            if rows.is_empty()
                || !rows
                    .iter()
                    .all(|(_, x)| families.iter().any(|f| family_matches(f, x)))
            {
                unexplained.push(format!("{dir}/{program}: {rows:?}"));
                continue;
            }
            let one = families
                .iter()
                .find(|f| rows.iter().all(|(_, x)| family_matches(f, x)))
                .map_or("several", String::as_str);
            *by_family.entry(one).or_default() += 1;
        }
        let total = d.classes.len().max(1);
        let matched = counts.get("MATCH").copied().unwrap_or(0);
        println!(
            "{dir}: {counts:?}; MATCH {:.2} %; POTENTIAL_SILENT_WRONG by tracked family {by_family:?}",
            100.0 * matched as f64 / total as f64
        );
    }
    assert!(
        unexplained.is_empty(),
        "POTENTIAL_SILENT_WRONG outside the tracked families:\n{unexplained:#?}"
    );
}

#[test]
fn the_seam_family_signatures_accept_only_their_differences() {
    let arcs = "features[3] part/e2#e2(extrude).bodies[0] origin={'feature': 'e1'}";
    assert!(seam_split_arcs(&format!(
        "{arcs}: edges forge=18 oracle=20"
    )));
    assert!(seam_split_arcs(
        "parts[part].bodies[0] origin={'feature': 'e1', 'member': 'c'}: edge_types forge={'circle': 3, 'line': 10} oracle={'circle': 4, 'line': 10}"
    ));
    assert!(seam_split_arcs(
        "x: edge_types forge={'circle': 6, 'ellipse': 4, 'line': 26} oracle={'circle': 6, 'ellipse': 6, 'line': 26}"
    ));
    assert!(!seam_split_arcs("x: edges forge=20 oracle=18"));
    assert!(!seam_split_arcs("x: edges forge=10 oracle=13"));
    assert!(!seam_split_arcs(
        "x: edge_types forge={'circle': 3, 'line': 10} oracle={'circle': 4, 'line': 11}"
    ));
    assert!(!seam_split_arcs(
        "x: edge_types forge={'circle': 4, 'line': 10} oracle={'circle': 3, 'line': 10}"
    ));
    assert!(!seam_split_arcs(
        "x: edge_types forge={'bspline': 6, 'circle': 16} oracle={'bspline': 4, 'circle': 19}"
    ));
    assert!(!seam_split_arcs("x: faces forge=7 oracle=8"));
    assert!(!seam_split_arcs("x: volume forge=1 oracle=2"));
    assert!(seam_split_faces("x: faces forge=14 oracle=15"));
    assert!(seam_split_faces(
        "x: face_types forge={'cylinder': 6, 'plane': 8} oracle={'cylinder': 7, 'plane': 8}"
    ));
    assert!(!seam_split_faces("x: faces forge=11 oracle=8"));
    assert!(!seam_split_faces(
        "x: face_types forge={'cylinder': 2, 'plane': 9} oracle={'cylinder': 2, 'plane': 6}"
    ));
    assert!(seam_edge_dropped("x: edges forge=31 oracle=30"));
    assert!(seam_edge_dropped(
        "x: edge_types forge={'circle': 6, 'line': 25} oracle={'circle': 6, 'line': 24}"
    ));
    assert!(!seam_edge_dropped("x: edges forge=24 oracle=12"));
    assert!(!seam_edge_dropped(
        "x: edge_types forge={'circle': 5, 'line': 19} oracle={'circle': 4, 'line': 12}"
    ));
    // Every family named in the manifest has a signature here.
    for f in manifest()["families"].as_array().unwrap() {
        let _ = family_matches(f["family"].as_str().unwrap(), "x: faces forge=1 oracle=1");
    }
}
