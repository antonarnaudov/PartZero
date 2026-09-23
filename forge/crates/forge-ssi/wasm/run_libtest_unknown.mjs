// Run a libtest test binary compiled for wasm32-unknown-unknown under Node, e.g. the
// forge-ops boolean determinism golden (no Cargo.toml change needed: the default harness
// links on this target and the module has no imports).
//
//   cargo +1.92 test --release -p forge-ops --test boolean_golden \
//       --target wasm32-unknown-unknown --no-run
//   node crates/forge-ssi/wasm/run_libtest_unknown.mjs \
//       target/wasm32-unknown-unknown/release/deps/boolean_golden-<hash>.wasm
//
// On this target stdout is discarded and a panic aborts (a trap), so the only signal is
// how `main` ends: returning 0 means every test ran and passed; a trap means a test failed
// (the harness cannot report which). Test tooling only.
import { readFile } from "node:fs/promises";
import { argv, exit } from "node:process";

const path = argv[2];
if (!path) {
  console.error("usage: node run_libtest_unknown.mjs <test.wasm>");
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
let code;
try {
  code = main.length >= 2 ? main(0, 0) : main();
} catch (e) {
  console.log(`wasm32-unknown-unknown: a test FAILED (${e.message})`);
  exit(1);
}
console.log(
  `wasm32-unknown-unknown: ${code === 0 ? "all tests passed" : `exit ${code}`} ` +
    `(${(performance.now() - t0).toFixed(0)} ms)`,
);
exit(code === 0 ? 0 : 1);
