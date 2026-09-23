//! Cross-target determinism check: print the fingerprint of the fixed SSI batch.
//!
//! Native:
//! ```text
//! cargo run --release -p forge-ssi --example ssi_fingerprint
//! ```
//! wasm32 (WASI, run under Node's `node:wasi`):
//! ```text
//! cargo build --release -p forge-ssi --example ssi_fingerprint --target wasm32-wasip1
//! node crates/forge-ssi/wasm/run_fingerprint.mjs \
//!     target/wasm32-wasip1/release/examples/ssi_fingerprint.wasm
//! ```
//! The two outputs must be identical; `tests/determinism_golden.rs` pins the value.

use forge_ssi::corpus::{FINGERPRINT_PAIRS, FINGERPRINT_SEED, batch_fingerprint};

fn main() {
    let fp = batch_fingerprint(FINGERPRINT_SEED, FINGERPRINT_PAIRS);
    println!("forge-ssi fingerprint {fp:#018x}");
}
