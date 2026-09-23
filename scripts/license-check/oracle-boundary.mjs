#!/usr/bin/env node
// Oracle boundary gate (CLAUDE.md principle 1, ADR 0000; audit finding M10).
//
//   node scripts/license-check/oracle-boundary.mjs [--root DIR]
//
// The oracle libraries (OCCT via OCP, build123d, PlaneGCS, SolveSpace, …; policy.mjs,
// ORACLE_LIBRARIES) are LGPL/GPL and may be *used* only from an oracle directory: the
// repository's `oracle/`, `<crate>/oracle/` beside a Rust crate's Cargo.toml such as
// `forge/crates/forge-solve/oracle/`, or another `*/oracle/` tooling directory outside every
// shipped package (policy.mjs, classifyOracleDir). This gate fails (exit 1) when
//   * a directory named `oracle` lies inside a pnpm workspace package, or inside a Rust
//     crate other than right beside its Cargo.toml: its files could ship, so it is no oracle
//     directory, and its own files are checked like any other;
//   * source code outside an oracle directory imports an oracle library (Python
//     `import`/`from`/`importlib.import_module`/`__import__`/`find_spec`, JS/TS
//     `import`/`export … from`/`require`/`require.resolve`/`import()`/`import.meta.resolve`,
//     with the specifier in quotes or a template literal);
//   * source code outside an oracle directory reaches *into* one: a relative JS/TS or Python
//     import that resolves into a directory named `oracle`, an import of a package that an
//     oracle directory defines (its package.json `name`, its Python packages), a package.json
//     `file:`/`link:` dependency or `imports` alias, a Cargo.toml `path`/`build`, a Rust
//     `#[path]`/`include!`, a tsconfig/jsconfig `extends`/`baseUrl`/`paths`/`rootDir(s)`/
//     `typeRoots`/`include`/`files`/`references`, or a path or alias in a bundler or test-runner
//     configuration (vite, vitest, webpack, rollup, esbuild, tsup, babel, jest, …) that points
//     into one, or names an oracle library;
//   * a manifest or lockfile outside an oracle directory depends on an oracle library
//     (package.json, pnpm-lock.yaml, package-lock.json, pyproject.toml, uv.lock,
//     requirements*.txt, PEP 723 `# /// script` blocks);
//   * an oracle directory is part of the pnpm or Cargo workspace (its code could ship).
// Mentions in prose, comments that are not imports, data (e.g. the `engine` string of a
// golden report) and running the oracle as a separate process are not dependencies and are
// not flagged. The Rust dependency graph is covered by cargo-deny (forge/deny.toml, [bans]),
// the transitive JS closure of every shipped package by js-licenses.mjs.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ORACLE_LIBRARIES, classifyOracleDir, outermostOracleDir } from "./policy.mjs";
import { workspaceDirs } from "./js-licenses.mjs";

const SKIP_DIRS = new Set([".git", "node_modules", "target", ".venv", "dist", ".turbo", "__pycache__", "pkg"]);
const SELF = "scripts/license-check/";

function listFiles(root) {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean).filter((f) => existsSync(join(root, f)));
  } catch {
    // Not a git checkout (e.g. a test fixture): walk the tree.
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
        const rel = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(rel);
        } else files.push(rel);
      }
    };
    walk("");
    return files;
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const pyNames = ORACLE_LIBRARIES.flatMap((l) => l.python.map((n) => [n, l.lib]));
const distNames = ORACLE_LIBRARIES.flatMap((l) => l.dist.map((n) => [n, l.lib]));
const jsNames = ORACLE_LIBRARIES.flatMap((l) => l.js.map((n) => [n, l.lib]));

// Python: `import X`, `import a, X as x`, `from X import …`, and the dynamic forms
// `importlib.import_module("X")`, `__import__("X")`, `importlib.util.find_spec("X")`.
const pyImportRe = (n) =>
  new RegExp(`^[ \\t]*(?:from[ \\t]+|import[ \\t]+(?:[\\w.]+(?:[ \\t]+as[ \\t]+\\w+)?[ \\t]*,[ \\t]*)*)${esc(n)}(?:[.\\s,]|$)|\\b(?:import_module|__import__|find_spec)\\s*\\(\\s*["']${esc(n)}(?:\\.[^"'\\n]*)?["']`, "m");
// JS/TS: where a module specifier follows. `import.meta.resolve` and `require.resolve` resolve
// a module without loading it, which is still how a bundler or a loader reaches it.
const JS_SPEC_AT = String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire(?:\.resolve)?\s*\(\s*|\bimport\.meta\.resolve\s*\(\s*)`;
// The specifier may be quoted with ' or " or be a template literal (with or without `${…}`).
const jsImportRe = (n) => new RegExp(`${JS_SPEC_AT}["'\`]${esc(n)}(?:/[^"'\`\\n]*)?["'\`]`);
const PY_IMPORT = pyNames.map(([n, lib]) => [pyImportRe(n), lib, n]);
const JS_IMPORT = jsNames.map(([n, lib]) => [jsImportRe(n), lib, n]);
// A quoted requirement string: "build123d==0.12.0", 'cadquery-ocp-novtk>=7', "slvs"
const PY_REQ = distNames.map(([n, lib]) => [new RegExp(`["']\\s*${esc(n)}\\s*(?:[<>=!~;\\[@ ]|["'])`, "i"), lib, n]);
const REQ_LINE = distNames.map(([n, lib]) => [new RegExp(`^\\s*${esc(n)}\\s*(?:[<>=!~;\\[@ ]|$)`, "im"), lib, n]);
const UV_LOCK = distNames.map(([n, lib]) => [new RegExp(`^name\\s*=\\s*"${esc(n)}"`, "im"), lib, n]);
const JS_LOCK = jsNames.map(([n, lib]) => [new RegExp(`(?:^|[\\s/'"])${esc(n)}(?:@|['":/]|$)`, "m"), lib, n]);

// Relative module specifiers and paths that can reach into another directory.
const JS_REL_SPEC = new RegExp(`${JS_SPEC_AT}["'\`](\\.{1,2}(?:/[^"'\`\\n]*)?)["'\`]`, "g");
const PY_REL_FROM = /^\s*from\s+(\.+)([\w.]*)\s+import\s+([^#\n]+)/gm;
const RS_PATH = /#\s*\[\s*path\s*=\s*"([^"]+)"\s*\]|\binclude!\s*\(\s*"([^"]+)"/g;
const TOML_PATH = /^\s*(?:[\w.-]+\s*=\s*\{[^}\n]*?\bpath\s*=\s*"([^"]+)"|(?:path|build)\s*=\s*"([^"]+)")/gm;

// Every string literal of a JS/TS/JSON file ('…', "…" or a template literal).
const STRING_LIT = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
// TypeScript/JavaScript project files: their `paths`, `baseUrl`, `include`, … steer module
// resolution and compilation.
const TSCONFIG = /^[jt]sconfig(?:\.[\w-]+)*\.json$/;
// Bundler and test-runner configurations: their aliases, roots and entry points steer what gets
// bundled or loaded.
const TOOL_CONFIG =
  /^(?:(?:vite|vitest|webpack|rollup|rolldown|rspack|esbuild|tsup|electron\.vite|electron-vite|babel|jest|next|astro|svelte|playwright)\.config(?:\.[\w-]+)*\.[cm]?[jt]s|\.babelrc(?:\.json)?|babel\.config\.json)$/;

const SCANNED =
  /(?:\.(?:py|rs|[cm]?[jt]sx?)|^package\.json|^pnpm-lock\.yaml|^package-lock\.json|^yarn\.lock|^pyproject\.toml|^uv\.lock|^poetry\.lock|^requirements.*\.txt|^Cargo\.toml|^[jt]sconfig(?:\.[\w-]+)*\.json|^\.babelrc(?:\.json)?|^babel\.config\.json)$/;

/** JSON with comments and trailing commas (tsconfig/jsconfig), or undefined. */
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      i = j < 0 ? text.length : j + 1;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return undefined;
  }
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * The scanner. `ctx` knows the repository: `oracleDirOf(target)` is the directory named
 * `oracle` that a repo-relative target path lies in or is (or undefined), and
 * `oraclePackages` lists the `{ name, dir, lang }` packages that oracle directories define.
 */
function scan(rel, text, ctx) {
  const hits = [];
  const base = rel.split("/").pop();
  const dir = posix.dirname(rel);
  const push = (rules, src = text, offset = 0) => {
    for (const [re, lib, name] of rules) {
      const m = re.exec(src);
      if (m) hits.push({ problem: `uses ${lib} (${name}) outside an oracle directory`, line: lineOf(text, offset + m.index), key: lib });
    }
  };
  // `target` is a repo-relative path a reference in this file resolves to.
  const into = (target, index, what) => {
    if (!target || target.startsWith("../") || target === "..") return; // outside the repository
    const od = ctx.oracleDirOf(target);
    if (od) hits.push({ problem: `${what} resolves into the oracle directory ${od}/: nothing outside an oracle directory may import oracle tooling`, line: lineOf(text, index), key: `into:${od}` });
  };
  const oracleNames = (lang) => ctx.oraclePackages.filter((p) => p.lang === lang);
  // A bare module specifier (or a path through node_modules/) naming an oracle library or the
  // package an oracle directory defines.
  const bare = (spec, index, what) => {
    const nm = spec.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
    const s = nm ? nm[1] : spec;
    for (const [n, lib] of jsNames) {
      if (s === n || s.startsWith(`${n}/`)) hits.push({ problem: `${what} uses ${lib} (${n}) outside an oracle directory`, line: lineOf(text, index), key: lib });
    }
    for (const p of oracleNames("js")) {
      if (s === p.name || s.startsWith(`${p.name}/`)) hits.push({ problem: `${what} names ${p.name}, the oracle tooling package in ${p.dir}/`, line: lineOf(text, index), key: `pkg:${p.name}` });
    }
  };
  const isRel = (s) => /^\.{1,2}(?:\/|$)/.test(s);
  // A string in a bundler/test-runner configuration: a relative path into an oracle directory,
  // any path with an `oracle` component (e.g. `path.resolve(__dirname, "../..", "oracle")`),
  // or an oracle library.
  const toolString = (s, index) => {
    if (isRel(s)) into(posix.normalize(posix.join(dir, s)), index, `path "${s}" in ${base}`);
    else if (s.split(/[\\/]/).includes("oracle"))
      hits.push({ problem: `path "${s}" in ${base} names an oracle directory: nothing outside an oracle directory may alias, bundle or load oracle tooling`, line: lineOf(text, index) });
    bare(s, index, `"${s}" in ${base}`);
  };

  if (/\.py$/.test(base)) {
    push(PY_IMPORT);
    const block = text.match(/^# \/\/\/ script\s*$([\s\S]*?)^# \/\/\/\s*$/m);
    if (block) push(PY_REQ, block[1], block.index);
    for (const p of oracleNames("python")) {
      const m = pyImportRe(p.name).exec(text);
      if (m) hits.push({ problem: `imports ${p.name}, the oracle tooling package in ${p.dir}/`, line: lineOf(text, m.index) });
    }
    for (const m of text.matchAll(PY_REL_FROM)) {
      let d = dir;
      for (let i = 1; i < m[1].length; i++) d = posix.dirname(d);
      const mod = m[2] ? m[2].split(".").join("/") : "";
      const targets = mod ? [posix.join(d, mod)] : m[3].replace(/[()\\]/g, "").split(",").map((n) => posix.join(d, n.trim().split(/\s+/)[0]));
      for (const t of targets) into(posix.normalize(t), m.index, `\`from ${m[1]}${m[2]} import …\``);
    }
  } else if (/\.(?:[cm]?[jt]sx?)$/.test(base)) {
    push(JS_IMPORT);
    for (const p of oracleNames("js")) {
      const m = jsImportRe(p.name).exec(text);
      if (m) hits.push({ problem: `imports ${p.name}, the oracle tooling package in ${p.dir}/`, line: lineOf(text, m.index), key: `pkg:${p.name}` });
    }
    for (const m of text.matchAll(JS_REL_SPEC)) into(posix.normalize(posix.join(dir, m[1])), m.index, `import "${m[1]}"`);
    if (TOOL_CONFIG.test(base)) for (const m of text.matchAll(STRING_LIT)) toolString(m[2], m.index);
  } else if (TOOL_CONFIG.test(base)) {
    // .babelrc, babel.config.json
    for (const m of text.matchAll(STRING_LIT)) toolString(m[2], m.index);
  } else if (TSCONFIG.test(base)) {
    const cfg = parseJsonc(text);
    const at = (v) => Math.max(0, text.indexOf(JSON.stringify(v)));
    if (!cfg || typeof cfg !== "object") {
      // Unparseable: every relative path in it.
      for (const m of text.matchAll(STRING_LIT)) if (isRel(m[2])) into(posix.normalize(posix.join(dir, m[2])), m.index, `path "${m[2]}"`);
      return hits;
    }
    const co = cfg.compilerOptions && typeof cfg.compilerOptions === "object" ? cfg.compilerOptions : {};
    const strings = (v) => [v].flat().filter((x) => typeof x === "string");
    // [value, directory it is relative to, what]
    const refs = [];
    for (const e of strings(cfg.extends)) {
      if (isRel(e) || e.startsWith("/")) refs.push([e, dir, "extends"]);
      else bare(e, at(e), `extends "${e}"`);
    }
    const baseUrl = typeof co.baseUrl === "string" ? posix.join(dir, co.baseUrl) : dir;
    for (const v of strings(co.baseUrl)) refs.push([v, dir, "compilerOptions.baseUrl"]);
    // `paths` targets are relative to baseUrl, or to this file without one (TypeScript ≥ 4.1).
    for (const [alias, targets] of Object.entries(co.paths && typeof co.paths === "object" ? co.paths : {})) {
      for (const t of strings(targets)) refs.push([t, baseUrl, `compilerOptions.paths["${alias}"]`]);
    }
    for (const k of ["rootDir", "rootDirs", "typeRoots"]) for (const v of strings(co[k])) refs.push([v, dir, `compilerOptions.${k}`]);
    for (const k of ["include", "files"]) for (const v of strings(cfg[k])) refs.push([v, dir, k]);
    for (const r of Array.isArray(cfg.references) ? cfg.references : []) for (const v of strings(r?.path)) refs.push([v, dir, "references[].path"]);
    for (const [v, from, what] of refs) {
      into(posix.normalize(posix.join(from, v)), at(v), `${what} "${v}"`);
      bare(v, at(v), `${what} "${v}"`);
    }
  } else if (/\.rs$/.test(base)) {
    for (const m of text.matchAll(RS_PATH)) {
      const spec = m[1] ?? m[2];
      into(posix.normalize(posix.join(dir, spec)), m.index, m[1] ? `#[path = "${spec}"]` : `include!("${spec}")`);
    }
  } else if (base === "Cargo.toml") {
    for (const m of text.matchAll(TOML_PATH)) {
      const spec = m[1] ?? m[2];
      into(posix.normalize(posix.join(dir, spec)), m.index, `path "${spec}"`);
    }
  } else if (base === "package.json") {
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      return hits;
    }
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundleDependencies"]) {
      const deps = pkg[field];
      const names = Array.isArray(deps) ? deps : Object.keys(deps ?? {});
      for (const [n, lib] of jsNames) {
        if (names.includes(n)) hits.push({ problem: `uses ${lib} (${n}) outside an oracle directory`, line: lineOf(text, text.indexOf(`"${n}"`)), key: lib });
      }
      for (const p of oracleNames("js")) {
        if (names.includes(p.name)) hits.push({ problem: `depends on ${p.name}, the oracle tooling package in ${p.dir}/`, line: lineOf(text, text.indexOf(`"${p.name}"`)) });
      }
      if (deps && !Array.isArray(deps)) {
        for (const [n, spec] of Object.entries(deps)) {
          const m = typeof spec === "string" && spec.match(/^(?:file|link|portal):(.+)$/);
          if (m) into(posix.normalize(posix.join(dir, m[1])), text.indexOf(`"${n}"`), `dependency ${n} (${spec})`);
        }
      }
    }
    // Subpath `imports` ("#alias": target, possibly nested under conditions).
    const targets = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(targets) : []);
    for (const [alias, spec] of Object.entries(pkg.imports && typeof pkg.imports === "object" ? pkg.imports : {})) {
      for (const t of targets(spec)) {
        const idx = Math.max(0, text.indexOf(`"${alias}"`));
        if (isRel(t)) into(posix.normalize(posix.join(dir, t)), idx, `imports["${alias}"] "${t}"`);
        else bare(t, idx, `imports["${alias}"] "${t}"`);
      }
    }
  } else if (base === "pnpm-lock.yaml" || base === "package-lock.json" || base === "yarn.lock") {
    push(JS_LOCK);
  } else if (base === "pyproject.toml") {
    push(PY_REQ);
  } else if (base === "uv.lock" || base === "poetry.lock") {
    push(UV_LOCK);
  } else if (/^requirements.*\.txt$/.test(base)) {
    push(REQ_LINE);
  }
  return hits;
}

/** Cargo workspace member directories (supports `dir/*` and plain entries). */
function cargoMembers(root, files) {
  const out = [];
  for (const t of files.filter((f) => f.endsWith("Cargo.toml"))) {
    const text = readFileSync(join(root, t), "utf8");
    const ws = text.match(/^\[workspace\][\s\S]*?^members\s*=\s*\[([\s\S]*?)\]/m);
    if (!ws) continue;
    const base = dirname(join(root, t));
    for (const m of ws[1].matchAll(/"([^"]+)"/g)) {
      const g = m[1];
      if (g.endsWith("/*")) {
        const d = join(base, g.slice(0, -2));
        if (!existsSync(d)) continue;
        for (const e of readdirSync(d)) {
          if (existsSync(join(d, e, "Cargo.toml"))) out.push(join(d, e));
        }
      } else out.push(join(base, g));
    }
  }
  return out;
}

export function check(root) {
  root = resolve(root);
  const files = listFiles(root);
  const violations = [];
  const rels = (dirs) => dirs.map((d) => relative(root, d).split(sep).join("/"));
  const read = (rel) => readFileSync(join(root, rel), "utf8");

  const packageDirs = existsSync(join(root, "pnpm-workspace.yaml")) ? rels(workspaceDirs(root)) : [];
  const crateDirs = files
    .filter((f) => /(^|\/)Cargo\.toml$/.test(f) && /^\[package\]/m.test(read(f)))
    .map((f) => posix.dirname(f))
    .map((d) => (d === "." ? "" : d));

  // Every directory named `oracle` (the outermost one on each path), and whether it is an
  // oracle directory (policy.mjs, classifyOracleDir).
  const oracleDirs = new Map();
  for (const f of files) {
    const d = outermostOracleDir(f);
    if (d !== undefined && !oracleDirs.has(d)) oracleDirs.set(d, classifyOracleDir(d, { packageDirs, crateDirs }));
  }
  for (const [d, c] of [...oracleDirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!c.ok) violations.push({ file: `${d}/`, problem: c.reason });
  }
  const allowedOracleDir = (rel) => {
    const d = outermostOracleDir(rel);
    return d !== undefined && oracleDirs.get(d)?.ok === true;
  };

  // The directory named `oracle` a referenced path lies in, or is.
  const oracleDirOf = (target) => {
    const parts = target.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== "oracle") continue;
      const d = parts.slice(0, i + 1).join("/");
      if (i < parts.length - 1 || oracleDirs.has(d) || (existsSync(join(root, d)) && statSync(join(root, d)).isDirectory())) return d;
    }
    return undefined;
  };

  // Packages that oracle directories define: package.json names, Python packages (a
  // pyproject.toml's project name, and `src/<pkg>/__init__.py`).
  const oraclePackages = [];
  for (const f of files) {
    if (!allowedOracleDir(f)) continue;
    const od = outermostOracleDir(f);
    const base = f.split("/").pop();
    if (base === "package.json") {
      try {
        const name = JSON.parse(read(f)).name;
        if (typeof name === "string" && name) oraclePackages.push({ name, dir: posix.dirname(f), lang: "js" });
      } catch {
        /* not JSON: nothing to import by name */
      }
    } else if (base === "pyproject.toml") {
      const m = read(f).match(/^\[project\][\s\S]*?^name\s*=\s*"([^"]+)"/m);
      if (m) oraclePackages.push({ name: m[1].replace(/[-.]+/g, "_").toLowerCase(), dir: posix.dirname(f), lang: "python" });
    } else if (base === "__init__.py") {
      const m = f.slice(od.length + 1).match(/^(?:.*\/)?src\/([A-Za-z_]\w*)\/__init__\.py$/);
      if (m) oraclePackages.push({ name: m[1], dir: posix.dirname(f), lang: "python" });
    }
  }
  const seenPkg = new Set();
  const ctx = {
    oracleDirOf,
    oraclePackages: oraclePackages.filter((p) => {
      const k = `${p.lang}:${p.name}`;
      if (seenPkg.has(k)) return false;
      seenPkg.add(k);
      return true;
    }),
  };

  for (const rel of files) {
    if (rel.startsWith(SELF) || allowedOracleDir(rel)) continue;
    if (!SCANNED.test(rel.split("/").pop())) continue;
    const abs = join(root, rel);
    if (statSync(abs).size > 32 << 20) continue;
    // A file inside a rejected oracle directory may refer to its own directory; that
    // directory is reported once above.
    const ownOracle = outermostOracleDir(rel);
    const seen = new Set();
    for (const h of scan(rel, read(rel), ctx)) {
      if (ownOracle && h.problem.includes(`oracle directory ${ownOracle}/:`)) continue;
      const key = `${h.line}:${h.key ?? h.problem}`;
      if (seen.has(key)) continue; // e.g. "@salusoft89/planegcs" also matches "planegcs"
      seen.add(key);
      violations.push({ file: `${rel}:${h.line}`, problem: h.problem });
    }
  }

  for (const d of packageDirs) {
    if (outermostOracleDir(`${d}/package.json`) !== undefined) violations.push({ file: `${d}/package.json`, problem: "an oracle directory is a pnpm workspace package (it could ship)" });
  }
  for (const d of rels(cargoMembers(root, files))) {
    if (outermostOracleDir(`${d}/Cargo.toml`) !== undefined) violations.push({ file: `${d}/Cargo.toml`, problem: "an oracle directory is a Cargo workspace member (it could ship)" });
  }
  return violations;
}

function main() {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  const v = check(root);
  if (v.length) {
    console.error(`oracle-boundary: ${v.length} violation(s):`);
    for (const x of v) console.error(`  ${x.file}: ${x.problem}`);
    process.exitCode = 1;
  } else {
    console.log(`oracle-boundary: OK (${ORACLE_LIBRARIES.map((l) => l.lib).join(", ")} appear only in oracle directories, and nothing outside them imports one)`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
