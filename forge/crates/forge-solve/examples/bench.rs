//! Solve and drag benchmark on 60- and 200-entity single-cluster sketches.
//!
//! Native:   `cargo run -p forge-solve --release --example bench`
//! wasm:     `cargo build -p forge-solve --release --example bench --target wasm32-wasip1`
//!           `node crates/forge-solve/oracle/wasm_bench.mjs target/wasm32-wasip1/release/examples/bench.wasm`
//!
//! Prints per-size timings (full solve with diagnostics; drag frames p50/p95/max) and an
//! FNV-1a hash of every output bit, which must be identical on every target.

use std::time::Instant;

use forge_solve::generate::benchmark;
use forge_solve::{Geometry, SolveOptions, Solver};

fn fnv(h: &mut u64, bytes: &[u8]) {
    for &b in bytes {
        *h ^= u64::from(b);
        *h = h.wrapping_mul(0x0100_0000_01b3);
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let i = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[i]
}

fn main() {
    let frames: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(600);
    let opts = SolveOptions::default();
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    println!(
        "| sketch | entities | unknowns | eqs | DOF | status | solve+diag ms | drag p50 ms | drag p95 ms | drag max ms | LM iters/frame | frames ok | max residual |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for &size in &[60usize, 200] {
        for &fully in &[true, false] {
            let sketch = benchmark(size, fully);
            // Full solve + diagnostics (median of 7).
            let mut solve_ms = Vec::new();
            let mut result = None;
            for _ in 0..7 {
                let t0 = Instant::now();
                let mut s = Solver::new(&sketch, &opts).expect("valid benchmark sketch");
                let r = s.solve();
                solve_ms.push(t0.elapsed().as_secs_f64() * 1e3);
                result = Some(r);
            }
            solve_ms.sort_by(f64::total_cmp);
            let r = result.expect("solved");
            fnv(
                &mut hash,
                serde_json::to_string(&r).expect("json").as_bytes(),
            );

            // Drag: a hole center (fully) or an outline vertex (under) around a small circle.
            let mut solver = Solver::new(&sketch, &opts).expect("valid");
            solver.solve();
            let target = if fully { "hc0" } else { "v5" };
            let start = solver.point(target).expect("drag point");
            let mut times = Vec::with_capacity(frames);
            let mut ok = 0usize;
            let mut max_res = 0.0f64;
            let mut iters = 0usize;
            for f in 0..frames {
                let a = forge_core::math::TAU * f as f64 / frames as f64;
                let (s, c) = forge_core::math::sin_cos(a);
                let t = [start[0] + 1.5 * (c - 1.0), start[1] + 1.5 * s];
                let t0 = Instant::now();
                let fr = solver.drag(target, t).expect("drag");
                times.push(t0.elapsed().as_secs_f64() * 1e3);
                if fr.converged {
                    ok += 1;
                }
                iters += fr.iterations;
                max_res = max_res.max(fr.max_residual);
            }
            times.sort_by(f64::total_cmp);
            for e in solver.sketch().entities {
                if let Geometry::Point { x, y } = e.geometry {
                    fnv(&mut hash, &x.to_bits().to_le_bytes());
                    fnv(&mut hash, &y.to_bits().to_le_bytes());
                }
            }
            let (_, unknowns) = solver.parameter_count();
            let eqs: usize = r.clusters.iter().map(|c| c.equations).sum();
            println!(
                "| {} | {} | {} | {} | {} | {:?} | {:.2} | {:.3} | {:.3} | {:.3} | {:.2} | {}/{} | {:.1e} |",
                if fully { "fully" } else { "under" },
                sketch.entities.len(),
                unknowns,
                eqs,
                r.dof,
                r.status,
                percentile(&solve_ms, 0.5),
                percentile(&times, 0.5),
                percentile(&times, 0.95),
                times.last().copied().unwrap_or(0.0),
                iters as f64 / frames as f64,
                ok,
                frames,
                max_res
            );
        }
    }
    println!("\ndeterminism hash: {hash:016x}");
}
