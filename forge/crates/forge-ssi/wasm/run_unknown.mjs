// Run the `ssi_fingerprint_check` example compiled for wasm32-unknown-unknown under Node.
// The module has no imports; its exported C `main` returns the process exit code
// (0 = fingerprint equals the golden value).
//
//   cargo build --release -p forge-ssi --example ssi_fingerprint_check --target wasm32-unknown-unknown
//   node crates/forge-ssi/wasm/run_unknown.mjs \
//       target/wasm32-unknown-unknown/release/examples/ssi_fingerprint_check.wasm
//
// Test tooling only.
import { readFile } from "node:fs/promises";
import { argv, exit } from "node:process";

const path = argv[2];
if (!path) {
  console.error("usage: node run_unknown.mjs <ssi_fingerprint_check.wasm>");
  exit(2);
}
const module = await WebAssembly.compile(await readFile(path));
const imports = WebAssembly.Module.imports(module);
if (imports.length > 0) {
  console.error("unexpected imports:", imports);
  exit(2);
}
const instance = await WebAssembly.instantiate(module, {});
const main = instance.exports.main ?? instance.exports.__main_void;
const t0 = performance.now();
const code = main.length >= 2 ? main(0, 0) : main();
console.log(
  `wasm32-unknown-unknown: fingerprint ${code === 0 ? "MATCHES" : "DIFFERS FROM"} the golden value ` +
    `(exit ${code}, ${(performance.now() - t0).toFixed(0)} ms)`,
);
exit(code === 0 ? 0 : 1);
