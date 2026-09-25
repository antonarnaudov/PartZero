#!/usr/bin/env node
// Build the sketch-session WASM module (forge/crates/forge-sketch-wasm) into ./pkg-sketch.
//
//   node scripts/build-sketch.mjs [--debug] [--skip-if-present]
//
// It is a second, small module next to pkg/ (forge-wasm): the sketcher runs it on the UI thread
// (no wgpu inside; about 0.9 MB gzipped). Folding it into forge-wasm later is a one-line
// `mod sketch_session;` (docs/fm/sketcher.md); until then the app loads both.
//
// Steps mirror scripts/build.mjs: cargo (release: LTO, panic=abort) → wasm-bindgen --target web
// → wasm-opt -O3 when present → THIRD_PARTY_LICENSES.txt (cargoNotices) → sizes.json.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { NOTICES_FILE, WASM_TARGET, isMainModule, writeCargoNotices } from "./build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const WASM_BINDGEN_VERSION = "0.2.128";
export const SKETCH_CRATE = "forge-sketch-wasm";
export const SKETCH_OUT = "pkg-sketch";
export const SKETCH_NAME = "forge_sketch_wasm";

function main() {
  const forgeDir = resolve(process.env.FORGE_DIR ?? join(pkgRoot, "../../forge"));
  const outDir = join(pkgRoot, SKETCH_OUT);
  const args = new Set(process.argv.slice(2));
  const release = !args.has("--debug");
  const noticesPath = join(outDir, NOTICES_FILE);
  const writeNotices = () => {
    const n = writeCargoNotices({ forgeDir, rootPackage: SKETCH_CRATE, target: WASM_TARGET, artifact: `${SKETCH_NAME}_bg.wasm (@aicad/forge-web/sketch)`, out: noticesPath });
    console.log(`forge-web: sketch ${NOTICES_FILE}: ${n} third-party crates`);
  };

  if (args.has("--skip-if-present") && existsSync(join(outDir, `${SKETCH_NAME}_bg.wasm`))) {
    console.log("forge-web: pkg-sketch/ present, skipping the sketch wasm build");
    if (!existsSync(noticesPath)) {
      try {
        writeNotices();
      } catch (e) {
        console.warn(`forge-web: could not generate the sketch ${NOTICES_FILE}: ${e.message}`);
      }
    }
    return;
  }

  const run = (cmd, argv, opts = {}) => {
    console.log(`$ ${cmd} ${argv.join(" ")}`);
    const r = spawnSync(cmd, argv, { stdio: "inherit", ...opts });
    if (r.error || r.status !== 0) {
      if (r.error) console.error(`forge-web: cannot run ${cmd}: ${r.error.message}`);
      process.exit(r.status ?? 1);
    }
  };
  const version = (cmd) => {
    try {
      return execFileSync(cmd, ["--version"], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };

  const wb = version("wasm-bindgen");
  if (!wb || !wb.includes(WASM_BINDGEN_VERSION)) {
    console.error(`forge-web: need wasm-bindgen ${WASM_BINDGEN_VERSION} (found ${wb ?? "none"}):\n  cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked`);
    process.exit(1);
  }

  const cargoArgs = ["build", "-p", SKETCH_CRATE, "--target", WASM_TARGET];
  if (release) cargoArgs.push("--release");
  const env = { ...process.env };
  if (release) {
    env.CARGO_PROFILE_RELEASE_LTO ??= "fat";
    env.CARGO_PROFILE_RELEASE_PANIC ??= "abort";
  }
  run("cargo", cargoArgs, { cwd: forgeDir, env });

  const targetDir = resolve(forgeDir, process.env.CARGO_TARGET_DIR ?? "target");
  const wasm = join(targetDir, WASM_TARGET, release ? "release" : "debug", `${SKETCH_NAME}.wasm`);
  mkdirSync(outDir, { recursive: true });
  const bindgenArgs = ["--target", "web", "--out-dir", outDir, "--out-name", SKETCH_NAME];
  if (release) bindgenArgs.push("--remove-name-section");
  run("wasm-bindgen", [...bindgenArgs, wasm]);

  const bg = join(outDir, `${SKETCH_NAME}_bg.wasm`);
  if (release && version("wasm-opt")) {
    run("wasm-opt", ["-O3", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext", bg, "-o", bg]);
  }

  writeNotices();

  const sizes = {};
  for (const f of [`${SKETCH_NAME}_bg.wasm`, `${SKETCH_NAME}.js`]) {
    const p = join(outDir, f);
    const raw = statSync(p).size;
    const gz = gzipSync(readFileSync(p), { level: 9 }).length;
    sizes[f] = { raw, gzip: gz };
    console.log(`forge-web: ${f}: ${(raw / 1024).toFixed(1)} KiB raw, ${(gz / 1024).toFixed(1)} KiB gzip`);
  }
  writeFileSync(join(outDir, "sizes.json"), JSON.stringify(sizes, null, 2) + "\n");
}

if (isMainModule(process.argv[1], import.meta.url)) main();
