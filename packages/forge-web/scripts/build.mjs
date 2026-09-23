#!/usr/bin/env node
// Build the forge-wasm crate for the web and generate the JS glue into ./pkg.
//
//   node scripts/build.mjs [--debug] [--skip-if-present] [--allow-stale]
//
// --allow-stale: if cargo fails but pkg/ exists (e.g. another crate of the workspace is
// mid-edit), keep the existing pkg/ and exit 0 with a warning.
//
// 1. cargo build -p forge-wasm --target wasm32-unknown-unknown --release
// 2. wasm-bindgen --target web --out-dir pkg --out-name forge_wasm <wasm>
// 3. wasm-opt -O3 (only if `wasm-opt` is on PATH; optional)
// 4. print raw and gzip sizes (also written to pkg/sizes.json)
//
// Tooling: `wasm-bindgen` must be the exact version of the `wasm-bindgen` crate
// (pinned in forge/crates/forge-wasm/Cargo.toml):
//   cargo install wasm-bindgen-cli --version 0.2.128 --locked
//
// Env: FORGE_DIR (default ../../forge) — the Cargo workspace; CARGO_TARGET_DIR is honoured.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const forgeDir = resolve(process.env.FORGE_DIR ?? join(pkgRoot, "../../forge"));
const outDir = join(pkgRoot, "pkg");
const args = new Set(process.argv.slice(2));
const release = !args.has("--debug");
const WASM_BINDGEN_VERSION = "0.2.128";

if (args.has("--skip-if-present") && existsSync(join(outDir, "forge_wasm_bg.wasm"))) {
  console.log("forge-web: pkg/ present, skipping the wasm build");
  process.exit(0);
}

function run(cmd, argv, opts = {}) {
  console.log(`$ ${cmd} ${argv.join(" ")}`);
  const r = spawnSync(cmd, argv, { stdio: "inherit", ...opts });
  if (r.error || r.status !== 0) {
    if (r.error) console.error(`forge-web: cannot run ${cmd}: ${r.error.message}`);
    if (args.has("--allow-stale") && existsSync(join(outDir, "forge_wasm_bg.wasm"))) {
      console.warn("forge-web: build failed; keeping the existing pkg/ (--allow-stale)");
      process.exit(0);
    }
    process.exit(r.status ?? 1);
  }
}

function version(cmd) {
  try {
    return execFileSync(cmd, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const wb = version("wasm-bindgen");
if (!wb) {
  console.error(
    `forge-web: wasm-bindgen not found. Install it with:\n  cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked`,
  );
  process.exit(1);
}
if (!wb.includes(WASM_BINDGEN_VERSION)) {
  console.error(`forge-web: need wasm-bindgen ${WASM_BINDGEN_VERSION}, found "${wb}"`);
  process.exit(1);
}

const cargoArgs = ["build", "-p", "forge-wasm", "--target", "wasm32-unknown-unknown"];
if (release) cargoArgs.push("--release");
// Link-time optimisation shrinks the module a lot; only for this invocation.
const env = { ...process.env };
if (release) {
  env.CARGO_PROFILE_RELEASE_LTO ??= "fat";
  env.CARGO_PROFILE_RELEASE_PANIC ??= "abort";
}
run("cargo", cargoArgs, { cwd: forgeDir, env });

const targetDir = resolve(forgeDir, process.env.CARGO_TARGET_DIR ?? "target");
const wasm = join(targetDir, "wasm32-unknown-unknown", release ? "release" : "debug", "forge_wasm.wasm");
mkdirSync(outDir, { recursive: true });
const bindgenArgs = ["--target", "web", "--out-dir", outDir, "--out-name", "forge_wasm"];
// Function names are only useful for profiling; they are ~15% of the module.
if (release) bindgenArgs.push("--remove-name-section");
run("wasm-bindgen", [...bindgenArgs, wasm]);

const bg = join(outDir, "forge_wasm_bg.wasm");
if (release && version("wasm-opt")) {
  run("wasm-opt", ["-O3", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext", bg, "-o", bg]);
} else if (release) {
  console.log("forge-web: wasm-opt not found; skipping (optional)");
}

const sizes = {};
for (const f of ["forge_wasm_bg.wasm", "forge_wasm.js"]) {
  const p = join(outDir, f);
  const raw = statSync(p).size;
  const gz = gzipSync(readFileSync(p), { level: 9 }).length;
  sizes[f] = { raw, gzip: gz };
  console.log(`forge-web: ${f}: ${(raw / 1024).toFixed(1)} KiB raw, ${(gz / 1024).toFixed(1)} KiB gzip`);
}
writeFileSync(join(outDir, "sizes.json"), JSON.stringify(sizes, null, 2) + "\n");
