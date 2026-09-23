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
// 4. pkg/THIRD_PARTY_LICENSES.txt: the licenses and notices of every third-party crate in the
//    module (from `cargo metadata` and the crates' own license files; see `cargoNotices` below)
// 5. print raw and gzip sizes (also written to pkg/sizes.json)
//
// Tooling: `wasm-bindgen` must be the exact version of the `wasm-bindgen` crate
// (pinned in forge/crates/forge-wasm/Cargo.toml):
//   cargo install wasm-bindgen-cli --version 0.2.128 --locked
//
// Env: FORGE_DIR (default ../../forge) — the Cargo workspace; CARGO_TARGET_DIR is honoured.
//
// The notices generator is also exported for other artifacts built from the Forge workspace
// (packages/desktop/scripts/package-notices.mjs uses it for the `aicad` binary).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const WASM_BINDGEN_VERSION = "0.2.128";
export const WASM_TARGET = "wasm32-unknown-unknown";
export const NOTICES_FILE = "THIRD_PARTY_LICENSES.txt";

// ─── Third-party notices for Rust crates ───────────────────────────────────────────────────

/**
 * SPDX licenses accepted in shipped artifacts (LICENSING.md: no LGPL/GPL at runtime), in election
 * order: for `A OR B` the alternative with the fewest licenses, then the earliest here, is the
 * license the crate is used under in this distribution.
 */
export const RUST_LICENSE_PREFERENCE = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Zlib",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BSL-1.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Apache-2.0 WITH LLVM-exception",
  "MPL-2.0",
];

/** Parse an SPDX expression (`A OR (B AND C)`, `X WITH Y`, legacy `A/B`) into a tree. */
export function parseSpdx(expression) {
  const tokens = expression.replace(/\//g, " OR ").match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const fail = (why) => {
    throw new Error(`cannot parse license expression "${expression}": ${why}`);
  };
  const atom = () => {
    const t = tokens[i++];
    if (t === undefined) fail("unexpected end");
    if (t === "(") {
      const node = or();
      if (tokens[i++] !== ")") fail("missing )");
      return node;
    }
    if (t === ")" || t === "AND" || t === "OR" || t === "WITH") fail(`unexpected ${t}`);
    if (tokens[i] === "WITH") {
      const exception = tokens[i + 1];
      if (exception === undefined) fail("WITH without an exception");
      i += 2;
      return { id: `${t} WITH ${exception}` };
    }
    return { id: t };
  };
  const and = () => {
    const args = [atom()];
    while (tokens[i] === "AND") {
      i++;
      args.push(atom());
    }
    return args.length === 1 ? args[0] : { op: "and", args };
  };
  const or = () => {
    const args = [and()];
    while (tokens[i] === "OR") {
      i++;
      args.push(and());
    }
    return args.length === 1 ? args[0] : { op: "or", args };
  };
  const tree = or();
  if (i !== tokens.length) fail(`unexpected ${tokens[i]}`);
  return tree;
}

/** The licenses to use a crate under (see {@link RUST_LICENSE_PREFERENCE}); throws when no alternative is allowed. */
export function electLicenses(expression) {
  const rank = (id) => RUST_LICENSE_PREFERENCE.indexOf(id);
  const cost = (ids) => ids.length * 1000 + ids.reduce((s, id) => s + rank(id), 0);
  const elect = (node) => {
    if (node.id !== undefined) return rank(node.id) >= 0 ? [node.id] : null;
    const parts = node.args.map(elect);
    if (node.op === "and") return parts.includes(null) ? null : [...new Set(parts.flat())];
    const ok = parts.filter((p) => p !== null);
    return ok.length === 0 ? null : ok.reduce((best, p) => (cost(p) < cost(best) ? p : best));
  };
  const chosen = elect(parseSpdx(expression));
  if (!chosen) throw new Error(`license "${expression}" has no alternative in the allowed list (${RUST_LICENSE_PREFERENCE.join(", ")})`);
  return chosen;
}

const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)/i;
const NOTICE_FILE = /^(notice|copyright)/i;

function classifyByName(name) {
  const n = name.toLowerCase();
  if (n.includes("0bsd")) return "0BSD";
  if (n.includes("unlicense")) return "Unlicense";
  if (/(^|[-_.])mit([-_.]|$)/.test(n)) return "MIT";
  if (n.includes("apache")) return "Apache-2.0";
  if (n.includes("zlib")) return "Zlib";
  if (n.includes("bsd")) return "BSD";
  if (n.includes("unicode")) return "Unicode";
  if (n.includes("boost") || n.includes("bsl")) return "BSL-1.0";
  if (n.includes("isc")) return "ISC";
  if (n.includes("cc0")) return "CC0-1.0";
  if (n.includes("mpl")) return "MPL-2.0";
  return null;
}

function classifyByText(text) {
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(text)) return "MIT";
  if (/Apache License,?\s+Version 2\.0/i.test(text)) return "Apache-2.0";
  if (/Mozilla Public License,?\s+(Version|v\.?)\s*2\.0/i.test(text)) return "MPL-2.0";
  if (/This software is provided 'as-is', without any express or implied\s+warranty/i.test(text)) return "Zlib";
  if (/Redistribution and use in source and binary forms/i.test(text)) return "BSD";
  if (/Permission to use, copy, modify, and\/or distribute this software for any\s+purpose with or without fee is hereby granted\.\s+THE SOFTWARE/i.test(text)) return "0BSD";
  if (/Permission to use, copy, modify, and\/or distribute this software/i.test(text)) return "ISC";
  if (/UNICODE LICENSE V3|UNICODE, INC\. LICENSE AGREEMENT|Unicode Data Files/i.test(text)) return "Unicode";
  if (/This is free and unencumbered software released into the public domain/i.test(text)) return "Unlicense";
  if (/Boost Software License - Version 1\.0/i.test(text)) return "BSL-1.0";
  return null;
}

function fileMatches(fileClass, id) {
  if (fileClass === null) return false;
  if (fileClass === id) return true;
  if (fileClass === "BSD") return id === "BSD-2-Clause" || id === "BSD-3-Clause";
  if (fileClass === "Unicode") return id.startsWith("Unicode-");
  if (fileClass === "Apache-2.0") return id === "Apache-2.0 WITH LLVM-exception";
  return false;
}

const MIT_TEMPLATE = (holder) =>
  [
    "MIT License",
    "",
    `Copyright (c) ${holder}`,
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    'of this software and associated documentation files (the "Software"), to deal',
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all",
    "copies or substantial portions of the Software.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
    "SOFTWARE.",
  ].join("\n");

/**
 * The canonical text for a crate that ships no file for an elected license: MIT with the crate's
 * authors as the copyright holder, Apache-2.0 / MPL-2.0 from the repository root. Anything else
 * fails, so a missing text is a build error rather than a silent gap.
 */
function fallbackText(id, pkg, repoRoot) {
  if (id === "MIT") {
    const authors = (pkg.authors ?? []).map((a) => a.replace(/\s*<[^>]*>/, "")).filter(Boolean);
    return MIT_TEMPLATE(authors.length > 0 ? authors.join(", ") : `the ${pkg.name} authors`);
  }
  const file = id === "Apache-2.0" ? "LICENSE-APACHE-2.0" : id === "MPL-2.0" ? "LICENSE-MPL-2.0" : null;
  if (file && existsSync(join(repoRoot, file))) return readFileSync(join(repoRoot, file), "utf8");
  return null;
}

function normalizeText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Sort key that orders `1.10.0` after `1.9.0` without locale-dependent comparison. */
function versionKey(v) {
  return v.replace(/\d+/g, (d) => d.padStart(8, "0"));
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normal and build dependencies (not dev) of `rootPackage`, third-party only (registry/git sources). */
export function thirdPartyCrates(metadata, rootPackage) {
  const root = metadata.packages.find((p) => p.name === rootPackage && p.source === null);
  if (!root) throw new Error(`no workspace package named ${rootPackage} in cargo metadata`);
  const byId = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const stack = [root.id];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((k) => k.kind !== "dev")) stack.push(dep.pkg);
    }
  }
  return [...seen]
    .map((id) => byId.get(id))
    .filter((p) => p && p.source !== null)
    .sort((a, b) => cmp(a.name, b.name) || cmp(versionKey(a.version), versionKey(b.version)));
}

/**
 * THIRD_PARTY_LICENSES for an artifact built from the Forge workspace: a table of every
 * third-party crate (declared license and the license elected for this distribution), then each
 * distinct license text / notice once, with the crates it applies to. Deterministic: depends only on
 * the metadata and the crates' files (no dates, no locale).
 */
export function cargoNotices({ metadata, rootPackage, artifact, target, repoRoot }) {
  const crates = thirdPartyCrates(metadata, rootPackage);
  /** @type {Map<string, { title: string, text: string, users: string[] }>} */
  const texts = new Map();
  const addText = (title, text, user) => {
    const norm = normalizeText(text);
    const key = `${title}\u0000${norm}`;
    const entry = texts.get(key) ?? { title, text: norm, users: [] };
    if (!entry.users.includes(user)) entry.users.push(user);
    texts.set(key, entry);
  };
  const rows = [];
  const std = { name: "Rust standard library (std, core, alloc)", version: "", license: "MIT OR Apache-2.0", authors: ["The Rust Project Developers"] };
  for (const pkg of [...crates, std]) {
    if (!pkg.license) {
      throw new Error(`${pkg.name} ${pkg.version} declares no SPDX license (license_file: ${pkg.license_file ?? "none"}); review it and extend the notices generator`);
    }
    let elected;
    try {
      elected = electLicenses(pkg.license);
    } catch (e) {
      throw new Error(`${pkg.name} ${pkg.version}: ${e.message}`);
    }
    const label = pkg.version ? `${pkg.name} ${pkg.version}` : pkg.name;
    rows.push({ name: pkg.name, version: pkg.version, declared: pkg.license, elected: elected.join(" AND ") });
    const dir = pkg.manifest_path ? dirname(pkg.manifest_path) : null;
    const files = dir
      ? readdirSync(dir)
          .filter((f) => (LICENSE_FILE.test(f) || NOTICE_FILE.test(f)) && statSync(join(dir, f)).isFile())
          .sort()
          .map((f) => {
            const text = readFileSync(join(dir, f), "utf8");
            return { file: f, text, notice: NOTICE_FILE.test(f), cls: classifyByName(f) ?? classifyByText(text) };
          })
      : [];
    const licenseFiles = files.filter((f) => !f.notice);
    for (const id of elected) {
      let hits = licenseFiles.filter((f) => fileMatches(f.cls, id));
      // A single license file for a single-license crate is that license, whatever its wording.
      if (hits.length === 0 && elected.length === 1 && licenseFiles.length === 1 && licenseFiles[0].cls === null) hits = licenseFiles;
      if (hits.length > 0) {
        for (const f of hits) addText(id, f.text, `${label} (${f.file})`);
        continue;
      }
      const text = fallbackText(id, pkg, repoRoot);
      if (text === null) throw new Error(`${label} is used under ${id} but ships no ${id} text and there is no canonical fallback; add one`);
      addText(id, text, `${label} (canonical ${id} text${dir ? "; the crate ships none" : ""})`);
    }
    for (const f of files.filter((x) => x.notice)) addText("NOTICE", f.text, `${label} (${f.file})`);
  }

  const width = { name: Math.max(5, ...rows.map((r) => r.name.length)), version: Math.max(7, ...rows.map((r) => r.version.length)), declared: Math.max(16, ...rows.map((r) => r.declared.length)) };
  const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
  const rule = "=".repeat(100);
  const out = [
    `THIRD-PARTY SOFTWARE NOTICES AND LICENSES: ${artifact}`,
    rule,
    "",
    `${artifact} is part of aicad (Mozilla Public License 2.0). It is compiled from the Forge`,
    `workspace crate \`${rootPackage}\` for ${target}, which includes the third-party Rust crates`,
    "listed below (normal and build dependencies, from forge/Cargo.lock) and the Rust standard",
    "library. Each is used under the license in the last column; where a crate offers a choice",
    '("A OR B"), that is the license elected for this distribution. The license texts and notices',
    "follow the table, each once, with the crates it applies to.",
    "",
    "Generated by packages/forge-web/scripts/build.mjs (cargoNotices). Do not edit.",
    "",
    `${pad("Crate", width.name)}  ${pad("Version", width.version)}  ${pad("Declared license", width.declared)}  Used under`,
    `${"-".repeat(width.name)}  ${"-".repeat(width.version)}  ${"-".repeat(width.declared)}  ${"-".repeat(10)}`,
    ...rows.map((r) => `${pad(r.name, width.name)}  ${pad(r.version, width.version)}  ${pad(r.declared, width.declared)}  ${r.elected}`),
    "",
  ];
  let n = 0;
  for (const t of texts.values()) {
    n++;
    out.push(rule, `[${n}] ${t.title === "NOTICE" ? "Notice" : t.title}`, "Applies to:");
    for (const u of t.users) out.push(`  - ${u}`);
    out.push(rule, "", t.text, "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/**
 * `cargo metadata` for the Forge workspace, resolved for `target`. `--locked` keeps the
 * lockfile authoritative; network access is allowed so a fresh CI machine can fetch the
 * packages of crates the wasm build itself did not need (e.g. forge-cli's clap tree).
 */
export function cargoMetadata({ forgeDir, target }) {
  const json = execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", target], {
    cwd: forgeDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(json);
}

/** The host target triple of the workspace's toolchain (`rustc -vV`). */
export function hostTarget(forgeDir) {
  const v = execFileSync("rustc", ["-vV"], { cwd: forgeDir, encoding: "utf8" });
  const m = /^host: (\S+)$/m.exec(v);
  if (!m) throw new Error("cannot read the host target from `rustc -vV`");
  return m[1];
}

/** Generate and write THIRD_PARTY_LICENSES for `rootPackage`; returns the number of crates listed. */
export function writeCargoNotices({ forgeDir, rootPackage, target, artifact, out }) {
  const metadata = cargoMetadata({ forgeDir, target });
  const text = cargoNotices({ metadata, rootPackage, artifact, target, repoRoot: resolve(forgeDir, "..") });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  return thirdPartyCrates(metadata, rootPackage).length;
}

// ─── Build ─────────────────────────────────────────────────────────────────────────────────

function main() {
  const forgeDir = resolve(process.env.FORGE_DIR ?? join(pkgRoot, "../../forge"));
  const outDir = join(pkgRoot, "pkg");
  const args = new Set(process.argv.slice(2));
  const release = !args.has("--debug");
  const noticesPath = join(outDir, NOTICES_FILE);
  const writeNotices = () => {
    const n = writeCargoNotices({ forgeDir, rootPackage: "forge-wasm", target: WASM_TARGET, artifact: "forge_wasm_bg.wasm (@aicad/forge-web)", out: noticesPath });
    console.log(`forge-web: ${NOTICES_FILE}: ${n} third-party crates`);
  };
  /** An existing pkg/ without notices (built before they existed): generate them from the current lockfile. */
  const ensureNotices = () => {
    if (existsSync(noticesPath)) return;
    try {
      writeNotices();
    } catch (e) {
      console.warn(`forge-web: could not generate ${NOTICES_FILE}: ${e.message}`);
    }
  };

  if (args.has("--skip-if-present") && existsSync(join(outDir, "forge_wasm_bg.wasm"))) {
    console.log("forge-web: pkg/ present, skipping the wasm build");
    ensureNotices();
    process.exit(0);
  }

  function run(cmd, argv, opts = {}) {
    console.log(`$ ${cmd} ${argv.join(" ")}`);
    const r = spawnSync(cmd, argv, { stdio: "inherit", ...opts });
    if (r.error || r.status !== 0) {
      if (r.error) console.error(`forge-web: cannot run ${cmd}: ${r.error.message}`);
      if (args.has("--allow-stale") && existsSync(join(outDir, "forge_wasm_bg.wasm"))) {
        console.warn("forge-web: build failed; keeping the existing pkg/ (--allow-stale)");
        ensureNotices();
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

  const cargoArgs = ["build", "-p", "forge-wasm", "--target", WASM_TARGET];
  if (release) cargoArgs.push("--release");
  // Link-time optimisation shrinks the module a lot; only for this invocation.
  const env = { ...process.env };
  if (release) {
    env.CARGO_PROFILE_RELEASE_LTO ??= "fat";
    env.CARGO_PROFILE_RELEASE_PANIC ??= "abort";
  }
  run("cargo", cargoArgs, { cwd: forgeDir, env });

  const targetDir = resolve(forgeDir, process.env.CARGO_TARGET_DIR ?? "target");
  const wasm = join(targetDir, WASM_TARGET, release ? "release" : "debug", "forge_wasm.wasm");
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

  // The module ships these crates; their attribution ships with it (a failure fails the build).
  writeNotices();

  const sizes = {};
  for (const f of ["forge_wasm_bg.wasm", "forge_wasm.js"]) {
    const p = join(outDir, f);
    const raw = statSync(p).size;
    const gz = gzipSync(readFileSync(p), { level: 9 }).length;
    sizes[f] = { raw, gzip: gz };
    console.log(`forge-web: ${f}: ${(raw / 1024).toFixed(1)} KiB raw, ${(gz / 1024).toFixed(1)} KiB gzip`);
  }
  writeFileSync(join(outDir, "sizes.json"), JSON.stringify(sizes, null, 2) + "\n");
}

/**
 * Whether this module is the script node was asked to run (the notices functions are also
 * imported). Compared by real path: node resolves symlinks for `import.meta.url` but keeps
 * `process.argv[1]` as given, so a symlinked checkout or `/tmp` vs `/private/tmp` on macOS must not
 * turn the build into a silent no-op.
 */
export function isMainModule(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isMainModule()) main();
