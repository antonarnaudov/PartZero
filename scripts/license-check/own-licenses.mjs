#!/usr/bin/env node
// Own-license gate (LICENSING.md, ADR 0001; audit finding L16).
//
//   node scripts/license-check/own-licenses.mjs [--root DIR]
//
// Every package, crate and Python project states its license in its manifest, and that
// license must be the one LICENSING.md assigns to its path (policy.mjs, OWN_LICENSES):
// Cargo.toml `[package] license` (or `license.workspace = true` → `[workspace.package]`),
// package.json `license`, pyproject.toml `[project] license`. Fails (exit 1) on a missing or
// different license.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectedOwnLicense } from "./policy.mjs";

const SKIP_DIRS = new Set([".git", "node_modules", "target", ".venv", "dist", ".turbo", "__pycache__"]);
const MANIFEST = /(^|\/)(Cargo\.toml|package\.json|pyproject\.toml)$/;

function listManifests(root) {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter((f) => MANIFEST.test(f) && existsSync(join(root, f)));
  } catch {
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
        const rel = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(rel);
        } else if (MANIFEST.test(rel)) files.push(rel);
      }
    };
    walk("");
    return files;
  }
}

/** The body of a TOML table `[name]` (up to the next table header). */
function table(text, name) {
  const m = text.match(new RegExp(`^\\[${name.replace(/\./g, "\\.")}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m"));
  return m ? m[1] : undefined;
}

function tomlString(body, key) {
  const m = body?.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
  return m ? m[1] : undefined;
}

/** Walk up from a crate to the workspace root manifest that has `[workspace.package]`. */
function workspaceLicense(root, rel) {
  let d = dirname(join(root, rel));
  for (;;) {
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
    const t = join(d, "Cargo.toml");
    if (existsSync(t)) {
      const lic = tomlString(table(readFileSync(t, "utf8"), "workspace.package"), "license");
      if (lic) return lic;
    }
  }
}

function declared(root, rel) {
  const text = readFileSync(join(root, rel), "utf8");
  if (rel.endsWith("package.json")) {
    const pkg = JSON.parse(text);
    return { license: typeof pkg.license === "string" ? pkg.license : undefined };
  }
  if (rel.endsWith("pyproject.toml")) {
    const body = table(text, "project");
    if (!body) return { skip: true };
    return { license: tomlString(body, "license") ?? body.match(/^license\s*=\s*\{\s*text\s*=\s*"([^"]*)"/m)?.[1] };
  }
  const body = table(text, "package");
  if (!body) return { skip: true }; // a virtual workspace manifest
  if (/^license\.workspace\s*=\s*true/m.test(body) || /^license\s*=\s*\{\s*workspace\s*=\s*true/m.test(body)) {
    return { license: workspaceLicense(root, rel) };
  }
  return { license: tomlString(body, "license") };
}

export function check(root) {
  root = resolve(root);
  const violations = [];
  const checked = [];
  for (const rel of listManifests(root).sort()) {
    const d = declared(root, rel);
    if (d.skip) continue;
    const want = expectedOwnLicense(rel);
    checked.push({ manifest: rel, license: d.license });
    if (d.license !== want) {
      violations.push({ manifest: rel, problem: `declares ${JSON.stringify(d.license)}, LICENSING.md assigns ${want}` });
    }
  }
  return { violations, checked };
}

function main() {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  const { violations, checked } = check(root);
  for (const c of checked) console.log(`  ${String(c.license).padEnd(11)} ${c.manifest}`);
  if (violations.length) {
    console.error(`own-licenses: ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.manifest}: ${v.problem}`);
    process.exitCode = 1;
  } else {
    console.log(`own-licenses: OK (${checked.length} manifests match LICENSING.md)`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
