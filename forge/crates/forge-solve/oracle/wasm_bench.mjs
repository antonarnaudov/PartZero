// Run a forge-solve example compiled for wasm32-wasip1 in Node's built-in WASI host
// (V8's WebAssembly engine, the same one Electron/Chrome use). No wasm-bindgen, no
// `unsafe` exports: the example is an ordinary Rust `main` that times itself with
// std::time::Instant (WASI clock_time_get → Node's high-resolution clock).
//
//   cargo build -p forge-solve --release --example bench --target wasm32-wasip1
//   node crates/forge-solve/oracle/wasm_bench.mjs target/wasm32-wasip1/release/examples/bench.wasm [frames]
import fs from "node:fs";
import { WASI } from "node:wasi";
import process from "node:process";

const [wasmPath, ...rest] = process.argv.slice(2);
if (!wasmPath) throw new Error("usage: wasm_bench.mjs <bench.wasm> [args…]");
const wasi = new WASI({ version: "preview1", args: ["bench", ...rest], env: {}, returnOnExit: true });
const module = await WebAssembly.compile(fs.readFileSync(wasmPath));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
const t0 = performance.now();
const code = wasi.start(instance);
console.error(`node ${process.version}, wasm total ${(performance.now() - t0).toFixed(0)} ms, exit ${code}`);
