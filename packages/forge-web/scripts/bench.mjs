#!/usr/bin/env node
// Evaluate + tessellate timing of the Forge WASM build in Node (V8, same engine as
// Chromium/Electron). Run after `pnpm build`.
//
//   node scripts/bench.mjs [--runs 20] [--json out.json]
//
// Documents: corpus/programs/*.json, every corpus/makerbench/*.cad.ts compiled with
// @aicad/cadscript, and the synthetic 25-feature fixture (demo/bench-doc.js) at several
// base thicknesses (the "dimension edit").
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "@aicad/cadscript";
import { benchDocument } from "../demo/bench-doc.js";
import { evaluate, init } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const RUNS = Number(opt("--runs", "20"));

await init(readFileSync(join(here, "../pkg/forge_wasm_bg.wasm")));

const docs = [];
for (const f of readdirSync(join(root, "corpus/programs")).filter((f) => f.endsWith(".json")).sort()) {
  docs.push({ name: `programs/${f.replace(/\.json$/, "")}`, ir: readFileSync(join(root, "corpus/programs", f), "utf8") });
}
for (const f of readdirSync(join(root, "corpus/makerbench")).filter((f) => f.endsWith(".cad.ts")).sort()) {
  const r = compile(readFileSync(join(root, "corpus/makerbench", f), "utf8"), { fileName: f });
  if (r.ok && r.ir) docs.push({ name: `makerbench/${f.replace(/\.cad\.ts$/, "")}`, ir: JSON.stringify(r.ir) });
  else console.error(`skip ${f}: ${r.diagnostics.map((d) => d.message).join("; ")}`);
}
for (const t of [6, 6.5, 8]) docs.push({ name: `bench_fixture_25 (t=${t})`, ir: JSON.stringify(benchDocument(t)) });

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const p95 = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};

const rows = [];
for (const d of docs) {
  evaluate(d.ir);
  evaluate(d.ir);
  const wall = [];
  const ev = [];
  const tess = [];
  const pack = [];
  let last;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    last = evaluate(d.ir);
    wall.push(performance.now() - t0);
    ev.push(last.timings.parseMs + last.timings.evaluateMs);
    tess.push(last.timings.tessellateMs);
    pack.push(last.timings.packMs ?? 0);
  }
  const tris = last.bodies.reduce((a, b) => a + b.indices.length / 3, 0);
  const faces = last.bodies.reduce((a, b) => a + b.faceRanges.length, 0);
  const edges = last.bodies.reduce((a, b) => a + b.edges.length, 0);
  rows.push({
    doc: d.name,
    features: last.report.features.length,
    status: last.report.status,
    bodies: last.bodies.length,
    faces,
    edges,
    triangles: tris,
    evalMs: median(ev),
    tessMs: median(tess),
    packMs: median(pack),
    totalMs: median(wall),
    p95Ms: p95(wall),
  });
}

const f = (x) => x.toFixed(2);
console.log(`Forge WASM evaluate + tessellate (Node ${process.version}, ${RUNS} runs, median ms)\n`);
console.log("| document | feat | bodies | faces | edges | tris | eval | tess | pack | total | p95 |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const r of rows) {
  console.log(`| ${r.doc}${r.status === "ok" ? "" : " (ERR)"} | ${r.features} | ${r.bodies} | ${r.faces} | ${r.edges} | ${r.triangles} | ${f(r.evalMs)} | ${f(r.tessMs)} | ${f(r.packMs)} | ${f(r.totalMs)} | ${f(r.p95Ms)} |`);
}
const mb = rows.filter((r) => r.doc.startsWith("makerbench/"));
if (mb.length) {
  console.log(`\nmakerbench: ${mb.length} parts, median total ${f(median(mb.map((r) => r.totalMs)))} ms, max ${f(Math.max(...mb.map((r) => r.totalMs)))} ms`);
}
const out = opt("--json");
if (out) writeFileSync(out, JSON.stringify({ node: process.version, runs: RUNS, rows }, null, 2) + "\n");
