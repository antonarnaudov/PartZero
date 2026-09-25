//! Dump the boolean corpus as STEP files for the OCCT oracle:
//!
//! ```text
//! cargo run --release -p forge-io --example step_corpus -- <out-dir> [cases per seed] [seed]...
//! STEP_CHAINS=8x6 cargo run …   # also the results of 8 chained sequences of 6 operations
//! uv run python -m aicad_oracle.step_check --dir <out-dir>      # from oracle/
//! ```
//!
//! Every operand and result body is written as `<name>.step` with an `<name>.summary.json`
//! in the `aicad.export/1` form of `aicad export --format step --summary`: Forge's exact
//! metrics (forge-check) next to what the STEP writer produced.

#[path = "../tests/common/step_corpus.rs"]
mod step_corpus;

use std::path::PathBuf;

use forge_io::step::{StepBody, StepOptions, write_step};
use serde_json::json;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(dir) = args.first().map(PathBuf::from) else {
        eprintln!("usage: step_corpus <out-dir> [cases per seed] [seed]...");
        std::process::exit(2);
    };
    let n: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(200);
    let seeds: Vec<u64> = if args.len() > 2 {
        args[2..].iter().filter_map(|s| s.parse().ok()).collect()
    } else {
        vec![1, 7]
    };
    std::fs::create_dir_all(&dir).expect("create the output directory");
    let (mut written, mut refused) = (0usize, 0usize);
    let mut all = step_corpus::samples();
    for seed in seeds {
        all.extend(step_corpus::corpus(seed, n));
    }
    // Chained operations (Forge's results as operands): STEP_CHAINS=<chains>x<steps>.
    if let Some((c, k)) = std::env::var("STEP_CHAINS")
        .ok()
        .and_then(|v| {
            v.split_once('x')
                .map(|(a, b)| (a.parse().ok(), b.parse().ok()))
        })
        .and_then(|(a, b)| Some((a?, b?)))
    {
        all.extend(step_corpus::chained(2026, c, k));
    }
    {
        for b in all {
            let (volume, area, bbox_min, bbox_max) =
                match (forge_check::body_metrics(&b.body), b.known) {
                    (Ok(m), _) => (m.volume, m.area, m.bbox_min, m.bbox_max),
                    (Err(_), Some(k)) => k,
                    (Err(e), None) => panic!("{}: no metrics: {e}", b.name),
                };
            let c = b.body.counts();
            let forge = json!({
                "volume": volume,
                "area": area,
                "bboxMin": bbox_min,
                "bboxMax": bbox_max,
                "shells": c.shells,
                "faces": c.faces,
                "edges": c.edges,
                "vertices": c.vertices,
            });
            let item = StepBody {
                name: &b.name,
                body: &b.body,
                color: None,
            };
            let opts = StepOptions {
                product_name: b.name.clone(),
                file_name: format!("{}.step", b.name),
                ..StepOptions::default()
            };
            let summary = match write_step(&[item], &opts) {
                Ok((bytes, report)) => {
                    std::fs::write(dir.join(format!("{}.step", b.name)), &bytes).expect("write");
                    written += 1;
                    let s = &report.bodies[0];
                    json!({
                        "schema": "aicad.export/1",
                        "format": "step",
                        "stepSchema": report.schema.name(),
                        "bytes": report.bytes,
                        "entities": report.entities,
                        "uncertainty": report.uncertainty,
                        "bodies": [{
                            "name": b.name,
                            "forge": forge,
                            "step": {
                                "solids": s.solids,
                                "voids": s.voids,
                                "faces": s.faces,
                                "edges": s.edges,
                                "vertices": s.vertices,
                                "seamEdges": s.seam_edges,
                                "splitPieces": s.split_pieces,
                                "newVertices": s.new_vertices,
                            },
                        }],
                        "error": null,
                    })
                }
                Err(e) => {
                    refused += 1;
                    eprintln!("{}: {} {e}", b.name, e.code());
                    json!({
                        "schema": "aicad.export/1",
                        "format": "step",
                        "bodies": [{ "name": b.name, "forge": forge, "step": null }],
                        "error": { "code": e.code(), "message": e.to_string() },
                    })
                }
            };
            let text = serde_json::to_string_pretty(&summary).expect("json") + "\n";
            std::fs::write(dir.join(format!("{}.summary.json", b.name)), text).expect("write");
        }
    }
    eprintln!(
        "step_corpus: wrote {written} STEP files to {} ({refused} refused)",
        dir.display()
    );
}
