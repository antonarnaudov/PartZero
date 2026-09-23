//! Write the generated oracle corpus and forge-solve's answers as JSON lines.
//!
//! ```text
//! cargo run -p forge-solve --release --example oracle_corpus -- <out_dir> [count] [seed]
//! node crates/forge-solve/oracle/planegcs_oracle.mjs <out_dir>
//! ```
//!
//! `corpus.jsonl`: one [`forge_solve::generate::Generated`] per line.
//! `forge.jsonl`: forge-solve's status, DOF, redundant constraints and minimal
//! conflicting sets per sketch, with both rank backends (QRCP and Jacobi SVD).

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use forge_solve::generate::corpus;
use forge_solve::{RankMethod, SolveOptions, solve};
use serde_json::json;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = PathBuf::from(
        args.get(1)
            .map_or("target/forge-solve-oracle", String::as_str),
    );
    let count: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1000);
    let seed: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(2026);
    fs::create_dir_all(&out).expect("create output directory");
    let sketches = corpus(seed, count);
    let mut corpus_file = fs::File::create(out.join("corpus.jsonl")).expect("corpus.jsonl");
    let mut forge_file = fs::File::create(out.join("forge.jsonl")).expect("forge.jsonl");
    let svd = SolveOptions {
        rank_method: RankMethod::Svd,
        ..SolveOptions::default()
    };
    let mut total_us = 0u128;
    for g in &sketches {
        writeln!(
            corpus_file,
            "{}",
            serde_json::to_string(g).expect("serialize")
        )
        .expect("write");
        let t0 = Instant::now();
        let r = solve(&g.sketch, &SolveOptions::default()).expect("generated sketches are valid");
        let us = t0.elapsed().as_micros();
        total_us += us;
        let rs = solve(&g.sketch, &svd).expect("valid");
        let line = json!({
            "name": g.name,
            "family": g.family,
            "intent": g.intent,
            "expected_dof": g.expected_dof,
            "expected_conflict": g.expected_conflict,
            "status": r.status,
            "ok": r.ok,
            "dof": r.dof,
            "max_residual": r.max_residual,
            "redundant": r.redundant.iter().map(|x| &x.constraint).collect::<Vec<_>>(),
            "redundant_partial": r.redundant.iter().filter(|x| x.partial).map(|x| &x.constraint).collect::<Vec<_>>(),
            "conflicts": r.conflicts.iter().map(|x| &x.constraints).collect::<Vec<_>>(),
            "conflicts_verified_minimal": r.conflicts.iter().map(|x| x.verified_minimal).collect::<Vec<_>>(),
            "svd_status": rs.status,
            "svd_dof": rs.dof,
            "svd_redundant": rs.redundant.iter().map(|x| &x.constraint).collect::<Vec<_>>(),
            "svd_conflicts": rs.conflicts.iter().map(|x| &x.constraints).collect::<Vec<_>>(),
            "micros": us,
        });
        writeln!(forge_file, "{line}").expect("write");
    }
    eprintln!(
        "wrote {} sketches to {} (forge-solve total {:.1} ms, mean {:.1} µs)",
        sketches.len(),
        out.display(),
        total_us as f64 / 1000.0,
        total_us as f64 / sketches.len().max(1) as f64
    );
}
