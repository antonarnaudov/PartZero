#!/usr/bin/env node
// JS license gate (CLAUDE.md principle 5, LICENSING.md, ADR 0001; audit findings M10/L16).
//
//   node scripts/license-check/js-licenses.mjs [--root DIR] [--json OUT.json]
//
// Walks the *production* dependency closure of every package of the pnpm workspace, through
// node_modules exactly as Node resolves it (after `pnpm install --frozen-lockfile`):
// `dependencies` and `optionalDependencies`, workspace packages transitively, plus the
// development dependencies that are nevertheless shipped (policy.mjs,
// SHIPPED_DEV_DEPENDENCIES). Fails (exit 1) when
//   * a third-party package's license expression is not allowed (e.g. any GPL/LGPL/AGPL),
//     missing, or unparsable (unless LICENSE_OVERRIDES records a hand-checked license);
//   * a required dependency cannot be resolved (its license could not be checked);
//   * one of our own packages declares a license other than the one LICENSING.md assigns
//     to its path (policy.mjs, OWN_LICENSES);
//   * an oracle library (policy.mjs, ORACLE_LIBRARIES), or any package that lives in a
//     directory named `oracle`, is anywhere in the closure, whatever its license: nothing
//     that ships may pull in oracle tooling, directly, transitively or through a `file:` link
//     (ADR 0000; oracle-boundary.mjs checks the sources and manifests themselves).
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { LICENSE_OVERRIDES, ORACLE_LIBRARIES, SHIPPED_DEV_DEPENDENCIES, expectedOwnLicense, inOracleDir } from "./policy.mjs";
import { evaluate, manifestLicense } from "./spdx.mjs";

function args(argv) {
  const out = { root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."), json: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") out.root = resolve(argv[++i]);
    else if (argv[i] === "--json") out.json = resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

/** Workspace package directories from pnpm-workspace.yaml (`dir/*` and plain `dir` globs). */
export function workspaceDirs(root) {
  const file = join(root, "pnpm-workspace.yaml");
  const globs = [];
  let inPackages = false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) inPackages = true;
    else if (/^\S/.test(line)) inPackages = false;
    else if (inPackages) {
      const m = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
      if (m) globs.push(m[1]);
    }
  }
  const dirs = [];
  for (const g of globs) {
    if (g.startsWith("!")) continue;
    if (g.endsWith("/*")) {
      const base = join(root, g.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const d of readdirSync(base).sort()) {
        if (existsSync(join(base, d, "package.json"))) dirs.push(join(base, d));
      }
    } else if (!/[*?]/.test(g)) {
      if (existsSync(join(root, g, "package.json"))) dirs.push(join(root, g));
    } else {
      throw new Error(`pnpm-workspace.yaml: unsupported glob ${g}`);
    }
  }
  return dirs;
}

/** Node's node_modules lookup of `name` starting at `fromDir` (ignores `exports`). */
function resolvePackageDir(fromDir, name) {
  let d = fromDir;
  for (;;) {
    if (!d.endsWith(`${sep}node_modules`)) {
      const cand = join(d, "node_modules", name);
      if (existsSync(join(cand, "package.json"))) return realpathSync(cand);
    }
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const ORACLE_JS = new Map(ORACLE_LIBRARIES.flatMap((l) => l.js.map((n) => [n, l.lib])));

export function check(root) {
  const rootReal = realpathSync(root);
  const workspace = new Map(); // realpath → name
  for (const d of workspaceDirs(rootReal)) workspace.set(realpathSync(d), readJson(join(d, "package.json")).name);

  const violations = [];
  const packages = new Map(); // key → { name, version, license, workspace }
  const seen = new Set();

  function visit(dir, chain, leaf) {
    const key = realpathSync(dir);
    if (seen.has(key)) return;
    seen.add(key);
    const pkg = readJson(join(key, "package.json"));
    const id = `${pkg.name}@${pkg.version ?? "0.0.0"}`;
    const via = [...chain, id];
    const isWorkspace = workspace.has(key);
    const declared = manifestLicense(pkg);
    const relKey = relative(rootReal, key).split(sep).join("/");
    if (ORACLE_JS.has(pkg.name)) {
      violations.push({ package: id, chain: via, problem: `is the oracle library ${ORACLE_JS.get(pkg.name)} (ADR 0000): it must never be in a shipped package's dependency closure` });
    } else if (!relKey.startsWith("..") && !relKey.split("/").includes("node_modules") && inOracleDir(`${relKey}/package.json`)) {
      violations.push({ package: id, chain: via, problem: `lives in an oracle directory (${relKey}/; ADR 0000): oracle tooling must never be in a shipped package's dependency closure` });
    }
    if (isWorkspace) {
      const rel = relative(rootReal, key).split(sep).join("/");
      const want = expectedOwnLicense(rel);
      if (declared !== want) {
        violations.push({ package: id, chain: via, problem: `${rel}/package.json declares ${JSON.stringify(declared)}, LICENSING.md assigns ${want}` });
      }
    } else {
      const override = LICENSE_OVERRIDES[id];
      const lic = override?.license ?? declared;
      if (!lic) violations.push({ package: id, chain: via, problem: "no license field (check it by hand and add a LICENSE_OVERRIDES entry)" });
      else {
        const r = evaluate(lic);
        if (!r.ok) violations.push({ package: id, chain: via, problem: r.reason });
      }
    }
    packages.set(key, { name: pkg.name, version: pkg.version, license: declared, workspace: isWorkspace });
    if (leaf) return;

    const deps = [
      ...Object.keys(pkg.dependencies ?? {}).map((n) => ({ name: n, optional: false })),
      ...Object.keys(pkg.optionalDependencies ?? {}).map((n) => ({ name: n, optional: true })),
      ...(isWorkspace ? (SHIPPED_DEV_DEPENDENCIES[pkg.name] ?? []).map((d) => ({ ...d, optional: false })) : []),
    ];
    for (const d of deps) {
      const target = resolvePackageDir(key, d.name);
      if (!target) {
        if (!d.optional) violations.push({ package: `${d.name}`, chain: [...via, d.name], problem: "not installed: cannot check its license (run `pnpm install --frozen-lockfile` first)" });
        continue;
      }
      visit(target, via, d.leaf === true);
    }
  }

  for (const d of workspace.keys()) visit(d, [], false);
  return { violations, packages: [...packages.values()] };
}

function main() {
  const a = args(process.argv.slice(2));
  const { violations, packages } = check(a.root);
  const third = packages.filter((p) => !p.workspace);
  const byLicense = {};
  for (const p of third) byLicense[p.license ?? "(none)"] = (byLicense[p.license ?? "(none)"] ?? 0) + 1;
  console.log(`js-licenses: ${packages.length - third.length} workspace packages, ${third.length} shipped third-party packages`);
  for (const [l, n] of Object.entries(byLicense).sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(4)}  ${l}`);
  if (a.json) writeFileSync(a.json, JSON.stringify({ violations, packages }, null, 2) + "\n");
  if (violations.length) {
    console.error(`\njs-licenses: ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.package}: ${v.problem}\n    via ${v.chain.join(" → ")}`);
    process.exitCode = 1;
  } else {
    console.log("js-licenses: OK");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

