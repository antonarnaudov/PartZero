// Smoke test of the built package in Node: WASM evaluation, result shapes, export.
// Run after `pnpm build` (uses dist/ and pkg/).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { evaluate, exportMesh, exportStep, init, engineVersion, transferables } from "../dist/index.js";
import { benchDocument } from "../demo/bench-doc.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = join(here, "../../../corpus/programs");
await init(readFileSync(join(here, "../pkg/forge_wasm_bg.wasm")));

function checkBody(b) {
  assert.equal(typeof b.name, "string");
  assert.ok(b.positions instanceof Float32Array && b.normals instanceof Float32Array);
  assert.ok(b.indices instanceof Uint32Array);
  assert.equal(b.positions.length, b.normals.length);
  assert.equal(b.positions.length % 3, 0);
  assert.equal(b.indices.length % 3, 0);
  const nv = b.positions.length / 3;
  for (const i of b.indices) assert.ok(i < nv);
  // Face ranges tile the triangles in order.
  let next = 0;
  for (const f of b.faceRanges) {
    assert.equal(typeof f.face, "string");
    assert.equal(f.start, next);
    next += f.count;
  }
  assert.equal(next, b.indices.length / 3);
  // Edges may be empty: a full torus is one loopless face (ADR 0012).
  for (const e of b.edges) {
    assert.equal(typeof e.edge, "string");
    assert.ok(e.points instanceof Float32Array && e.points.length >= 6 && e.points.length % 3 === 0);
  }
}

test("engine version", () => {
  assert.match(engineVersion(), /^forge /);
});

test("every corpus program evaluates and tessellates", () => {
  for (const f of readdirSync(corpus).filter((f) => f.endsWith(".json"))) {
    const r = evaluate(readFileSync(join(corpus, f), "utf8"));
    assert.equal(r.report.schema, "aicad.metrics/0");
    assert.equal(r.report.status, "ok", f);
    assert.ok(r.bodies.length > 0, f);
    assert.deepEqual(r.meshErrors, []);
    r.bodies.forEach(checkBody);
    assert.ok(r.timings.totalMs >= 0);
  }
});

test("the box has named caps and sides", () => {
  const r = evaluate(readFileSync(join(corpus, "extrude_box.json"), "utf8"));
  const b = r.bodies[0];
  assert.equal(b.name, "part/plate");
  assert.deepEqual(
    b.faceRanges.map((f) => f.face).sort(),
    ["plate/cap:end", "plate/cap:start", "plate/side:bottom", "plate/side:left", "plate/side:right", "plate/side:top"],
  );
  assert.equal(b.edges.length, 12);
});

test("results are deterministic and objects work as input", () => {
  const doc = benchDocument(6);
  const a = evaluate(doc);
  const b = evaluate(JSON.stringify(doc));
  assert.equal(a.bodies.length, b.bodies.length);
  for (let i = 0; i < a.bodies.length; i++) {
    assert.deepEqual(a.bodies[i].positions, b.bodies[i].positions);
    assert.deepEqual(a.bodies[i].indices, b.bodies[i].indices);
  }
  assert.equal(a.report.features.length, 25);
  assert.equal(a.report.status, "ok", JSON.stringify(a.report.features.filter((f) => f.status !== "ok")));
  assert.ok(transferables(a).length >= a.bodies.length * 3);
});

test("rejected documents produce an error report, not an exception", () => {
  const r = evaluate("{ not json");
  assert.equal(r.report.status, "error");
  assert.equal(r.report.error.code, "IR_PARSE_ERROR");
  assert.deepEqual(r.bodies, []);
});

test("bad tessellation options throw a coded error", () => {
  assert.throws(() => evaluate(benchDocument(), { chordalDeflection: 0 }), (e) => e.code === "MESH_INVALID_PARAMS");
});

test("exportMesh writes 3MF, STL and OBJ", () => {
  const ir = readFileSync(join(corpus, "extrude_box.json"), "utf8");
  const stl = exportMesh(ir, "stl");
  assert.equal(stl.length, 84 + 12 * 50);
  assert.equal(new TextDecoder().decode(exportMesh(ir, "obj").slice(0, 14)), "# forge-io OBJ");
  const tmf = exportMesh(ir, "3mf");
  assert.equal(tmf[0], 0x50);
  assert.equal(tmf[1], 0x4b);
  assert.throws(() => exportMesh(ir, "step"), (e) => e.code === "EXPORT_FORMAT");
});

test("exportStep writes forge-io's STEP (AP214 by default, AP242 on request)", () => {
  const ir = readFileSync(join(corpus, "extrude_box.json"), "utf8");
  const text = (bytes) => new TextDecoder().decode(bytes);
  const ap214 = text(exportStep(ir, { productName: "box" }));
  assert.match(ap214, /^ISO-10303-21;/);
  assert.match(ap214, /AUTOMOTIVE_DESIGN/);
  assert.match(ap214, /MANIFOLD_SOLID_BREP\(/);
  assert.equal(text(exportStep(ir, { productName: "box" })), ap214, "deterministic bytes");
  assert.doesNotMatch(text(exportStep(ir, { schema: "ap242" })), /AUTOMOTIVE_DESIGN/);
  assert.throws(() => exportStep(ir, { schema: "ap999" }), (e) => e.code === "STEP_INVALID_OPTIONS");
});
