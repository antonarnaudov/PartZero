//! Bit-level determinism guard for the booleans.
//!
//! Hashes the exact bit patterns of the results of a fixed batch of corpus cases
//! (`forge_ops::boolean::corpus::batch_fingerprint`: result geometry and topology, report
//! fields, error codes and measured values) and compares them with the constant recorded
//! on the reference platform, and the same for a fixed batch of chained operations
//! (`chain_fingerprint`: operations on Forge's own results). The same test binary runs on
//! `wasm32-wasip1` under Node's WASI and on `wasm32-unknown-unknown` under Node
//! (`crates/forge-ssi/wasm/run_libtest_unknown.mjs`: the default harness links there; a
//! failed test traps), and is meant for an x86_64 CI runner (not checked on the reference
//! machine, which has no Rosetta; see `docs/spikes/03-ssi.md`, "Review round 4").
//!
//! **If this fails on a new platform or toolchain, boolean results are not bit-identical
//! across targets.** Investigate (a platform intrinsic, FMA contraction, a HashMap
//! iteration, …) before touching the constant; update it only for an intentional algorithm
//! change (in forge-ops, forge-ssi or forge-core geometry), and say so.

use forge_ops::boolean::corpus::{
    CHAIN_FINGERPRINT, FINGERPRINT_CASES, FINGERPRINT_SEED, GOLDEN_CHAIN_FINGERPRINT,
    GOLDEN_FINGERPRINT, batch_fingerprint, chain_fingerprint,
};

#[test]
fn boolean_results_are_bit_identical_to_the_reference_platform() {
    let fp = batch_fingerprint(FINGERPRINT_SEED, FINGERPRINT_CASES);
    assert_eq!(
        fp,
        batch_fingerprint(FINGERPRINT_SEED, FINGERPRINT_CASES),
        "not even deterministic within one process"
    );
    println!("boolean fingerprint {fp:#018x}");
    assert_eq!(
        fp, GOLDEN_FINGERPRINT,
        "fingerprint {fp:#018x} differs from the reference {GOLDEN_FINGERPRINT:#018x}"
    );
}

/// The same guard on chained operations (review round 3): every step's join, cut and
/// intersect of a Forge result with a new tool (`corpus::run_chains`), so the topology
/// Forge's own results carry (loops through a vertex twice, vertices at poles, mirrored
/// conics) is covered too.
#[test]
fn chained_results_are_bit_identical_to_the_reference_platform() {
    let (seed, chains, steps) = CHAIN_FINGERPRINT;
    let fp = chain_fingerprint(seed, chains, steps);
    println!("chained boolean fingerprint {fp:#018x}");
    assert_eq!(
        fp, GOLDEN_CHAIN_FINGERPRINT,
        "fingerprint {fp:#018x} differs from the reference {GOLDEN_CHAIN_FINGERPRINT:#018x}"
    );
}
