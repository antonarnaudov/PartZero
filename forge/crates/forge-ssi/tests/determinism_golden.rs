//! Bit-level determinism guard for forge-ssi.
//!
//! Hashes the exact bit patterns of the results of a fixed batch of surface–surface and
//! curve–surface intersections (`forge_ssi::corpus::batch_fingerprint`) and compares
//! them with the constant recorded on the reference platform. The same check runs as
//! wasm32 under Node (`examples/ssi_fingerprint*.rs`, `wasm/*.mjs`).
//!
//! **If this fails on a new platform or toolchain, results are not bit-identical across
//! targets.** Investigate (a platform intrinsic, FMA contraction, a HashMap iteration, …)
//! before touching the constant; update it only for an intentional algorithm change.

use forge_ssi::corpus::{
    FINGERPRINT_PAIRS, FINGERPRINT_SEED, GOLDEN_FINGERPRINT, batch_fingerprint,
};

#[test]
fn results_are_bit_identical_to_the_reference_platform() {
    let fp = batch_fingerprint(FINGERPRINT_SEED, FINGERPRINT_PAIRS);
    assert_eq!(
        fp,
        batch_fingerprint(FINGERPRINT_SEED, FINGERPRINT_PAIRS),
        "not even deterministic within one process"
    );
    assert_eq!(
        fp, GOLDEN_FINGERPRINT,
        "fingerprint {fp:#018x} differs from the reference {GOLDEN_FINGERPRINT:#018x}"
    );
}
