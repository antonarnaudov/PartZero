// Run a forge-refs test binary compiled for wasm32-wasip1 under Node's WASI (no wasmtime
// needed), passing libtest arguments through. The golden test compiles its golden file in,
// so it needs no preopened directory; tests that read the corpus need `--dir <repo root>`
// (preopened at the same absolute path, so `CARGO_MANIFEST_DIR`-relative paths resolve).
//
//   cargo test -p forge-refs --release --target wasm32-wasip1 --test golden --no-run
//   node crates/forge-refs/wasm/run_wasi_test.mjs \
//       target/wasm32-wasip1/release/deps/golden-<hash>.wasm --nocapture
//   node crates/forge-refs/wasm/run_wasi_test.mjs --dir "$(git rev-parse --show-toplevel)" \
//       target/wasm32-wasip1/release/deps/geometry-<hash>.wasm
//
// Node 22's WASI `fd_readdir` never ends a directory listing (Rust's `read_dir` loops), so
// `geometry`'s corpus test (`corpus_probes_keys_and_self_references`, which lists the corpus
// directories) hangs here: skip it (`--skip corpus_probes`) or use wasmtime
// (`CARGO_TARGET_WASM32_WASIP1_RUNNER="wasmtime --dir=<repo root>"`).
//
// Exits with the test binary's exit code. Test tooling only.
import { readFile } from "node:fs/promises";
import { WASI } from "node:wasi";
import { argv, exit } from "node:process";

const args = argv.slice(2);
const preopens = {};
while (args[0] === "--dir") {
  args.shift();
  const dir = args.shift();
  if (!dir) {
    console.error("--dir needs a path");
    exit(2);
  }
  preopens[dir] = dir;
}
const [path, ...rest] = args;
if (!path) {
  console.error("usage: node run_wasi_test.mjs [--dir <path>]… <test.wasm> [libtest args…]");
  exit(2);
}
const wasi = new WASI({
  version: "preview1",
  args: ["test", ...rest],
  env: { RUST_BACKTRACE: "0" },
  preopens,
  returnOnExit: true,
});
const module = await WebAssembly.compile(await readFile(path));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
const t0 = performance.now();
const code = wasi.start(instance) ?? 0;
console.error(`(wasm run took ${(performance.now() - t0).toFixed(0)} ms, exit ${code})`);
exit(code);
