// The sketch session over WASM (`@aicad/forge-web/sketch`), in Node: typed results, drags at
// interactive rates, finish → IR v1 feature. Run after `pnpm build` (uses dist/ and pkg-sketch/).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SketchSession, SketchSessionError, initSketchSync, sketchVersion } from "../dist/sketch.js";

const here = dirname(fileURLToPath(import.meta.url));
initSketchSync(readFileSync(join(here, "../pkg-sketch/forge_sketch_wasm_bg.wasm")));

const rect = (x, y, w, h) => [
  { op: "addCurve", curve: { kind: "line", id: "bottom", start: [x, y], end: [x + w, y] } },
  { op: "addCurve", curve: { kind: "line", id: "right", start: [x + w, y], end: [x + w, y + h] } },
  { op: "addCurve", curve: { kind: "line", id: "top", start: [x + w, y + h], end: [x, y + h] } },
  { op: "addCurve", curve: { kind: "line", id: "left", start: [x, y + h], end: [x, y] } },
  { op: "addConstraint", constraint: { id: "h1", type: "horizontal", line: "bottom" } },
  { op: "addConstraint", constraint: { id: "h2", type: "horizontal", line: "top" } },
  { op: "addConstraint", constraint: { id: "v1", type: "vertical", line: "left" } },
  { op: "addConstraint", constraint: { id: "v2", type: "vertical", line: "right" } },
];

test("the sketch module's crates are a subset of forge-wasm's, so the app's notices cover it", () => {
  const rows = (file) => {
    const text = readFileSync(join(here, file), "utf8");
    const table = text.slice(text.indexOf("-----")).split("\n").slice(1);
    const out = [];
    for (const line of table) {
      if (!line.trim()) break;
      const [name, version] = line.split(/\s{2,}/);
      out.push(`${name} ${version}`);
    }
    return out;
  };
  const sketch = rows("../pkg-sketch/THIRD_PARTY_LICENSES.txt");
  const main = new Set(rows("../pkg/THIRD_PARTY_LICENSES.txt"));
  assert.ok(sketch.length > 5);
  assert.deepEqual(sketch.filter((c) => !main.has(c)), []);
});

test("a rectangle sketch goes from blue to fully constrained and finishes as an IR v1 feature", () => {
  assert.match(sketchVersion(), /^\d+\.\d+\.\d+/);
  const s = SketchSession.create({ id: "sketch1", name: "base", plane: "XY" });
  let r = s.apply(rect(0, 0, 30, 20));
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.status, "under_constrained");
  assert.equal(r.snapshot.dof, 4);
  r = s.apply([
    { op: "addConstraint", constraint: { id: "w", type: "distance", a: "bottom.start", b: "bottom.end", value: 40 } },
    { op: "addConstraint", constraint: { id: "h", type: "distance", a: "left.start", b: "left.end", value: 25 } },
    { op: "addConstraint", constraint: { id: "pin", type: "fix", entity: "bottom.start", x: 0, y: 0 } },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.status, "fully_constrained");
  assert.ok(r.snapshot.entities.every((e) => e.dof === 0));
  const fin = s.finish();
  assert.equal(fin.ok, true, JSON.stringify(fin.error));
  assert.equal(fin.feature.type, "sketch");
  assert.equal(fin.feature.constraints.length, 7);
  assert.equal(fin.regions, 1);
  assert.equal(fin.edits.length, 11);
  s.dispose();
  assert.throws(() => s.snapshot(), /disposed/);
});

test("a conflicting dimension is refused with its minimal set; make-driven measures instead", () => {
  const s = SketchSession.create({ id: "s", name: "s", plane: "XZ" });
  s.apply(rect(0, 0, 30, 20));
  s.apply([{ op: "addConstraint", constraint: { id: "w", type: "distance", a: "bottom.start", b: "bottom.end", value: 40 } }]);
  const r = s.apply([{ op: "addConstraint", constraint: { id: "w2", type: "distance", a: "top.start", b: "top.end", value: 50 } }]);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "SKETCH_CONSTRAINT_CONFLICT");
  assert.equal(r.candidate.conflicts[0].suggestedRemoval, "w2");
  const d = s.apply([{ op: "addConstraint", constraint: { id: "w2", type: "distance", a: "top.start", b: "top.end", driving: false } }]);
  assert.equal(d.ok, true);
  const w2 = d.snapshot.constraints.find((c) => c.id === "w2");
  assert.equal(w2.state, "reference");
  assert.ok(Math.abs(w2.measured - 40) < 1e-9);
  s.dispose();
});

test("drag frames run at interactive rates on a 60-curve sketch", () => {
  const s = SketchSession.create({ id: "s", name: "s", plane: "XY" });
  const edits = [];
  for (let k = 0; k < 15; k++) {
    const x = k * 50;
    for (const e of rect(x, 0, 30, 20)) {
      const c = structuredClone(e);
      if (c.curve) {
        c.curve.id = `${c.curve.id}_${k}`;
      } else {
        c.constraint.id = `${c.constraint.id}_${k}`;
        c.constraint.line = `${c.constraint.line}_${k}`;
      }
      edits.push(c);
    }
  }
  const r = s.apply(edits);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.snapshot.curves.length, 60);
  const b = s.dragBegin({ target: "right_7.end", grab: [380, 20] });
  assert.equal(b.ok, true);
  const times = [];
  for (let i = 1; i <= 60; i++) {
    const t0 = performance.now();
    const f = s.dragTo(380 + i * 0.2, 20 + i * 0.1);
    times.push(performance.now() - t0);
    assert.equal(f.ok, true);
    assert.equal(f.frame.converged, true);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  // Plan §2.7: ≤ 4 ms per solve; the frame here includes JSON both ways.
  assert.ok(p95 < 16, `p95 drag frame ${p95.toFixed(2)} ms`);
  const end = s.dragEnd();
  assert.equal(end.ok, true);
  s.dispose();
});

test("expressions use the document's parameters; bad loads throw a coded error", () => {
  const document = { schema: "aicad.ir/1", params: [{ name: "width", unit: "mm", value: 12 }], parts: [{ id: "p", name: "p", features: [] }] };
  const s = SketchSession.create({ id: "s", name: "s", plane: "YZ", document });
  assert.deepEqual(s.evalExpression("width * 2"), { ok: true, value: 24 });
  const bad = s.evalExpression("width *");
  assert.equal(bad.ok, false);
  assert.match(bad.error.code, /^EXPR_/);
  assert.deepEqual(s.defineParam("depth", "mm", "width + 3"), { ok: true, value: 15 });
  assert.equal(s.finish().params[0].name, "depth");
  s.dispose();
  const rect = { id: "s", name: "s", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: "width", h: 5 }] };
  assert.throws(
    () => SketchSession.load({ sketch: rect, convert: false }),
    (e) => e instanceof SketchSessionError && e.code === "SESSION_NEEDS_CONVERSION",
  );
  // By default an explicit sketch converts: members become curves, sizes dimensions.
  const conv = SketchSession.load({ sketch: rect, document });
  const snap = conv.snapshot();
  assert.equal(snap.status, "fully_constrained");
  assert.ok(snap.constraints.some((c) => c.expr === "width"));
  const fin = conv.finish();
  assert.equal(fin.ok, true);
  assert.deepEqual(fin.conversion.renames[0], ["r.bottom", "r_bottom"]);
  conv.dispose();
});
