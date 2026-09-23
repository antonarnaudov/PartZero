// Run the forge-ssi fingerprint example compiled for wasm32-wasip1 under Node's WASI and
// print its output (the fingerprint line), for comparison with the native run.
//
//   cargo build --release -p forge-ssi --example ssi_fingerprint --target wasm32-wasip1
//   node crates/forge-ssi/wasm/run_fingerprint.mjs \
//       target/wasm32-wasip1/release/examples/ssi_fingerprint.wasm
//
// Test tooling only.
import { readFile } from "node:fs/promises";
import { WASI } from "node:wasi";
import { argv, exit } from "node:process";

const path = argv[2];
if (!path) {
  console.error("usage: node run_fingerprint.mjs <ssi_fingerprint.wasm>");
  exit(2);
}
const wasi = new WASI({ version: "preview1", args: ["ssi_fingerprint"], env: {} });
const module = await WebAssembly.compile(await readFile(path));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
const t0 = performance.now();
const code = wasi.start(instance);
console.error(`(wasm run took ${(performance.now() - t0).toFixed(0)} ms, exit ${code ?? 0})`);
