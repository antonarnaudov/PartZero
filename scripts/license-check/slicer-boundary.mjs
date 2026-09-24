#!/usr/bin/env node
// Slicer boundary gate (ADR 0016 §3 and its follow-up; ALPHA-0-PLAN W5; docs/SLICER-HANDOFF.md).
//
//   node scripts/license-check/slicer-boundary.mjs [--root DIR] [--build DIR]...
//
// PartZero hands files to the slicer the user installed; it never bundles, links or embeds one,
// and never copies a slicer's bundled printer, process or filament profiles. Today's slicers are
// AGPL-3.0 and their profile libraries come with them, so shipping either would put AGPL code or
// data in a PartZero artifact. The JS and Rust licence gates catch a *linked* library through its
// package metadata; they do not catch a binary, a vendored source tree or data files. This gate
// fails (exit 1) when the repository (tracked and untracked, not ignored) or a build tree given
// with `--build` (walked in full, e.g. `packages/desktop/release/mac-arm64/PartZero.app`)
// contains:
//   * a slicer application: an `.app` bundle, executable or AppImage named after Bambu Studio,
//     OrcaSlicer, PrusaSlicer, SuperSlicer, Slic3r or Cura;
//   * libslic3r: a `libslic3r` directory, or a library or WASM module named after (lib)slic3r;
//   * a slicer's profile library: a `profiles/BBL/` (or another vendor library) directory tree,
//     a PrusaSlicer vendor bundle (`PrusaResearch.ini`), or a JSON file shaped like a slicer
//     system preset (`"from": "system"` with `inherits`, `setting_id` or `instantiation`).
// Only files are judged: prose that mentions a slicer, and running the user's slicer as a
// separate process, are fine.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set([".git", "node_modules", "target", ".venv", ".turbo", "__pycache__"]);
const SLICERS = ["bambustudio", "bambu-studio", "bambu studio", "orcaslicer", "orca-slicer", "prusaslicer", "prusa-slicer", "superslicer", "slic3r", "cura", "ultimaker-cura", "ultimaker cura"];
const APP_RE = new RegExp(`^(?:${SLICERS.map((s) => s.replace(/[-\s]/g, "[-\\s_]?")).join("|")})\\.app$`, "i");
const EXE_RE = new RegExp(`^(?:${SLICERS.map((s) => s.replace(/[-\s]/g, "[-\\s_]?")).join("|")})(?:[-_.][\\w.+-]*)?(?:\\.exe|\\.appimage)?$`, "i");
const LIB_RE = /(?:^|[-_.])(?:lib)?slic3r(?:[-_.][\w.-]*)?\.(?:a|so(?:\.\d+)*|dylib|dll|lib|wasm|node)$/i;
const VENDOR_PROFILE_DIRS = ["BBL", "OrcaFilamentLibrary", "PrusaResearch", "Creality", "Anycubic", "Elegoo", "Prusa", "Voron"];
const PRESET_KINDS = new Set(["machine", "machine_model", "process", "filament"]);

/** Files of `root`: git's view of the repository, or a full walk of a non-git tree. */
function listFiles(root, { git }) {
  if (git) {
    try {
      const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 1 << 28,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.split("\0").filter(Boolean).filter((f) => existsSync(join(root, f)));
    } catch {
      // Not a git checkout: walk it.
    }
  }
  const files = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(join(root, d), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (git && SKIP_DIRS.has(e.name)) continue;
        walk(rel);
      } else files.push(rel);
    }
  };
  walk("");
  return files;
}

/** Whether a JSON text is shaped like a slicer's system preset. */
function isSystemPreset(text) {
  if (!/"from"\s*:\s*"system"/i.test(text)) return false;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const from = typeof v.from === "string" ? v.from.toLowerCase() : "";
  const shaped = "inherits" in v || "setting_id" in v || "instantiation" in v || (typeof v.type === "string" && PRESET_KINDS.has(v.type));
  return from === "system" && shaped;
}

/** Violations of one tree: `{ file, reason }`, sorted by file. */
export function scan(root, { git = true } = {}) {
  const out = [];
  const seenApps = new Set();
  for (const rel of listFiles(root, { git })) {
    const parts = rel.split("/");
    const name = parts[parts.length - 1];
    const app = parts.findIndex((p) => APP_RE.test(p));
    if (app >= 0) {
      const bundle = parts.slice(0, app + 1).join("/");
      if (!seenApps.has(bundle)) out.push({ file: bundle, reason: "a slicer application bundle" });
      seenApps.add(bundle);
      continue;
    }
    if (parts.some((p) => /^libslic3r$/i.test(p))) {
      out.push({ file: rel, reason: "libslic3r source (a slicer engine)" });
      continue;
    }
    if (LIB_RE.test(name)) {
      out.push({ file: rel, reason: "a slic3r library or module" });
      continue;
    }
    if (EXE_RE.test(name) && !/\.(?:md|txt|json|ts|tsx|js|mjs|cjs|rs|py|toml|ya?ml|html|css|svg|png|jpe?g)$/i.test(name)) {
      out.push({ file: rel, reason: "a slicer executable (or a file named after one)" });
      continue;
    }
    const profileDir = parts.findIndex((p, i) => /^profiles$/i.test(p) && VENDOR_PROFILE_DIRS.includes(parts[i + 1] ?? ""));
    if (profileDir >= 0 && parts.length > profileDir + 2) {
      out.push({ file: rel, reason: "a slicer's vendor profile library" });
      continue;
    }
    if (/^PrusaResearch\.ini$/i.test(name)) {
      out.push({ file: rel, reason: "a PrusaSlicer vendor profile bundle" });
      continue;
    }
    if (/\.json$/i.test(name)) {
      let text;
      try {
        if (statSync(join(root, rel)).size > 4 * 1024 * 1024) continue;
        text = readFileSync(join(root, rel), "utf8");
      } catch {
        continue;
      }
      if (isSystemPreset(text)) out.push({ file: rel, reason: "a slicer system preset (copied profile data)" });
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** The repository (git view) plus every build tree (full walk). */
export function check(root, builds = []) {
  const found = scan(root, { git: true }).map((v) => ({ ...v, tree: "repository" }));
  for (const b of builds) found.push(...scan(b, { git: false }).map((v) => ({ ...v, tree: b })));
  return found;
}

function main() {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const builds = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = resolve(argv[++i] ?? ".");
    else if (argv[i] === "--build") builds.push(resolve(argv[++i] ?? "."));
    else {
      console.error(`usage: ${basename(process.argv[1] ?? "slicer-boundary.mjs")} [--root DIR] [--build DIR]...`);
      process.exit(2);
    }
  }
  for (const b of builds) {
    if (!existsSync(b)) {
      console.error(`slicer-boundary: build tree ${b} does not exist`);
      process.exit(2);
    }
  }
  const found = check(root, builds);
  if (found.length === 0) {
    console.log(`slicer-boundary: no slicer binary, engine or profile library in the repository${builds.length ? ` or ${builds.length} build tree(s)` : ""} (ADR 0016 §3)`);
    return;
  }
  for (const v of found) console.error(`slicer-boundary: ${v.tree === "repository" ? "" : `${v.tree}: `}${v.file}: ${v.reason}`);
  console.error(`slicer-boundary: ${found.length} violation(s). PartZero launches the user's own slicer and never ships one or its profiles (ADR 0016 §3, docs/SLICER-HANDOFF.md).`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
