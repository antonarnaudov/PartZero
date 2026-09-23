//! Bit-level determinism guard for forge-solve.
//!
//! Two FNV-1a fingerprints over the exact output bits of the solver, compared with
//! constants recorded on the reference platform:
//!
//! * **drag benchmark** — the computation of `examples/bench.rs` (the spike 04 harness that
//!   also runs as wasm32-wasip1 under Node): the full solve result JSON of the 60- and
//!   200-entity benchmark sketches (fully and under-constrained) and the final point
//!   coordinates after 600 drag frames each. Its value is the hash published in
//!   `docs/spikes/04-sketch-solver.md` (native aarch64 == wasm32);
//! * **oracle corpus** — the solve result JSON (status, DOF, redundancy, minimal conflict
//!   sets, solved geometry) of every sketch of `generate::corpus(2026, 1000)`, the corpus
//!   the PlaneGCS / SolveSpace comparisons of spike 04 ran on, with both rank backends.
//!
//! **If this test fails on a new platform or toolchain, results are not bit-identical
//! across targets.** Investigate (a platform intrinsic, FMA contraction, a HashMap
//! iteration, …) before touching a constant. Update a constant only for an intentional
//! algorithm change, and say so in the commit message.

use forge_solve::generate::{benchmark, corpus};
use forge_solve::{Geometry, RankMethod, SolveOptions, Solver, solve};

/// FNV-1a, 64 bit.
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }

    fn bytes(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 ^= u64::from(b);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }

    fn f(&mut self, x: f64) {
        self.bytes(&x.to_bits().to_le_bytes());
    }
}

/// Drag frames per benchmark sketch, as in `examples/bench.rs` (its default).
const BENCH_FRAMES: usize = 600;

/// The fingerprint `examples/bench.rs` prints as "determinism hash" (without the timing).
fn bench_fingerprint() -> u64 {
    let opts = SolveOptions::default();
    let mut h = Fnv::new();
    for &size in &[60usize, 200] {
        for &fully in &[true, false] {
            let sketch = benchmark(size, fully);
            let r = Solver::new(&sketch, &opts)
                .expect("valid benchmark sketch")
                .solve();
            h.bytes(serde_json::to_string(&r).expect("json").as_bytes());

            // Drag a hole centre (fully) or an outline vertex (under) around a 1.5 mm circle.
            let mut solver = Solver::new(&sketch, &opts).expect("valid benchmark sketch");
            solver.solve();
            let target = if fully { "hc0" } else { "v5" };
            let start = solver.point(target).expect("drag point");
            for f in 0..BENCH_FRAMES {
                let a = forge_core::math::TAU * f as f64 / BENCH_FRAMES as f64;
                let (s, c) = forge_core::math::sin_cos(a);
                let t = [start[0] + 1.5 * (c - 1.0), start[1] + 1.5 * s];
                solver.drag(target, t).expect("drag");
            }
            for e in solver.sketch().entities {
                if let Geometry::Point { x, y } = e.geometry {
                    h.f(x);
                    h.f(y);
                }
            }
        }
    }
    h.0
}

/// Seed and size of the spike 04 oracle corpus (`examples/oracle_corpus.rs` defaults).
const CORPUS_SEED: u64 = 2026;
const CORPUS_COUNT: usize = 1000;

fn corpus_fingerprint() -> u64 {
    let qrcp = SolveOptions::default();
    let svd = SolveOptions {
        rank_method: RankMethod::Svd,
        ..SolveOptions::default()
    };
    let mut h = Fnv::new();
    for g in corpus(CORPUS_SEED, CORPUS_COUNT) {
        h.bytes(g.name.as_bytes());
        for opts in [&qrcp, &svd] {
            let r = solve(&g.sketch, opts).expect("generated sketches are valid");
            h.bytes(serde_json::to_string(&r).expect("json").as_bytes());
        }
    }
    h.0
}

/// Published in docs/spikes/04-sketch-solver.md ("Determinism" row): recorded on
/// aarch64-apple-darwin and wasm32-wasip1 (Rust 1.92). Re-verified 2026-09-23 with
/// `cargo run -p forge-solve --release --example bench`.
const GOLDEN_BENCH: u64 = 0x39ec_20a9_9e9b_8750;

/// Recorded on aarch64-apple-darwin (Rust 1.92), 2026-09-23. Must be identical on every
/// target.
const GOLDEN_CORPUS: u64 = 0xcb9c_920e_4dca_8483;

#[test]
fn drag_benchmark_is_bit_identical_to_the_reference_platform() {
    let fp = bench_fingerprint();
    assert_eq!(
        fp,
        bench_fingerprint(),
        "not even deterministic within one process"
    );
    assert_eq!(
        fp, GOLDEN_BENCH,
        "bench fingerprint {fp:#018x} differs from the reference {GOLDEN_BENCH:#018x}"
    );
}

#[test]
fn oracle_corpus_diagnostics_are_bit_identical_to_the_reference_platform() {
    let fp = corpus_fingerprint();
    assert_eq!(
        fp,
        corpus_fingerprint(),
        "not even deterministic within one process"
    );
    assert_eq!(
        fp, GOLDEN_CORPUS,
        "corpus fingerprint {fp:#018x} differs from the reference {GOLDEN_CORPUS:#018x}"
    );
}
