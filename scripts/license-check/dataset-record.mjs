#!/usr/bin/env node
// Dataset-record gate (LICENSING.md "Test datasets", ADR 0001; audit finding L19).
//
//   node scripts/license-check/dataset-record.mjs [--root DIR]
//
// The license record of every external dataset is the tracked `corpus/EXTERNAL_SOURCES.md`.
// It used to be `corpus/external/SOURCES.md`, inside the git-ignored download directory, so
// it could never be committed. Fails (exit 1) when
//   * `corpus/EXTERNAL_SOURCES.md` is missing, or has lost its dataset table;
//   * a Markdown file still points to the old `corpus/external/SOURCES.md`. ADRs and audit
//     reports are exempt: they record history, including the move itself.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RECORD = "corpus/EXTERNAL_SOURCES.md";
const OLD = /corpus\/external\/SOURCES\.md/;
const HISTORY = [/^docs\/adr\//, /^docs\/audits\//];
const SKIP_DIRS = new Set([".git", "node_modules", "target", ".venv", "dist", ".turbo", "__pycache__"]);

function listMarkdown(root) {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter((f) => f && existsSync(join(root, f)));
  } catch {
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
        const rel = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(rel);
        } else if (rel.endsWith(".md")) files.push(rel);
      }
    };
    walk("");
    return files;
  }
}

export function check(root) {
  root = resolve(root);
  const violations = [];
  const record = join(root, RECORD);
  if (!existsSync(record)) {
    violations.push({ file: RECORD, problem: "missing: every external dataset's license must be recorded here before first use (LICENSING.md)" });
  } else if (!/^\|\s*Dataset\s*\|.*\|\s*License/m.test(readFileSync(record, "utf8"))) {
    violations.push({ file: RECORD, problem: "has no dataset table (| Dataset | … | License … |)" });
  }
  for (const rel of listMarkdown(root)) {
    if (HISTORY.some((re) => re.test(rel))) continue;
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    lines.forEach((l, i) => {
      if (OLD.test(l)) violations.push({ file: `${rel}:${i + 1}`, problem: `points to the old, git-ignored corpus/external/SOURCES.md; the record is ${RECORD}` });
    });
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
    console.error(`dataset-record: ${v.length} violation(s):`);
    for (const x of v) console.error(`  ${x.file}: ${x.problem}`);
    process.exitCode = 1;
  } else {
    console.log(`dataset-record: OK (${RECORD} is the tracked dataset record)`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
