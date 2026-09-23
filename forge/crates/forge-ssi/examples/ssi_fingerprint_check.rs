//! Determinism check for targets without stdout (`wasm32-unknown-unknown`): exit code 0
//! if the fixed-batch fingerprint equals the golden value recorded on the reference
//! platform, 1 otherwise. Run under Node with `wasm/run_unknown.mjs`.

use std::process::ExitCode;

use forge_ssi::corpus::{
    FINGERPRINT_PAIRS, FINGERPRINT_SEED, GOLDEN_FINGERPRINT, batch_fingerprint,
};

fn main() -> ExitCode {
    if batch_fingerprint(FINGERPRINT_SEED, FINGERPRINT_PAIRS) == GOLDEN_FINGERPRINT {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
