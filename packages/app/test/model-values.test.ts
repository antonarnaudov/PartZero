/**
 * Every model value in one list (the Parameters panel): which fields of the corpus plate are
 * dimensions, their units and JSON pointers (each one a `setField` the engine accepts), the
 * engine's own evaluation of expression values, and promote-to-parameter names.
 */
import { applyOp } from "@aicad/model-ops";
import { beforeAll, describe, expect, it } from "vitest";
import { forgeWebCommandEngine, type ForgeWebCommandModule, type IrCommandEngine } from "../src/doc/v1/command-engine";
import { featureValues, modelValues, suggestParamName, withScratchParams } from "../src/doc/v1/model-values";

const nodeFs = "node:fs";
const fs = (await import(/* @vite-ignore */ nodeFs)) as { existsSync(p: URL): boolean; readFileSync(p: URL, enc?: string): Uint8Array & string };
const wasmUrl = new URL("../../forge-web/pkg/forge_wasm_bg.wasm", import.meta.url);
const hasWasm = fs.existsSync(wasmUrl);
const it_ = hasWasm ? it : it.skip;
const PLATE = fs.readFileSync(new URL("../../../corpus/v1/programs/plate_features.json", import.meta.url), "utf8");

let engine: IrCommandEngine;
beforeAll(async () => {
  if (!hasWasm) return;
  const entry = new URL("../../forge-web/src/engine.ts", import.meta.url).pathname;
  const mod = (await import(/* @vite-ignore */ entry)) as ForgeWebCommandModule & { init(input: unknown): Promise<void> };
  await mod.init(fs.readFileSync(wasmUrl));
  engine = forgeWebCommandEngine(mod);
}, 60_000);

describe("featureValues", () => {
  it("lists a sketch's compound sizes and driving dimensions, not its coordinates", () => {
    const v = featureValues({
      type: "sketch",
      curves: [
        { kind: "rect", id: "outline", center: [0, 0], w: "width", h: 50, r: 4 },
        { kind: "circle", id: "hole", center: [10, 0], radius: 3 },
        { kind: "line", id: "l", start: [0, 0], end: [5, 0] },
      ],
      constraints: [
        { type: "distance", id: "d1", a: "l.start", b: "l.end", value: 5 },
        { type: "angle", id: "a1", a: "l", b: "m", value: 30 },
        { type: "distance", id: "ref", a: "l.start", b: "l.end", value: 5, driving: false },
        { type: "horizontal", line: "l" },
      ],
    });
    expect(v.map((x) => [x.path, x.label, x.unit, x.value])).toEqual([
      ["/curves/0/w", "rect outline · width", "mm", "width"],
      ["/curves/0/h", "rect outline · height", "mm", 50],
      ["/curves/0/r", "rect outline · radius", "mm", 4],
      ["/curves/1/radius", "circle hole · radius", "mm", 3],
      ["/constraints/0/value", "distance d1", "mm", 5],
      ["/constraints/1/value", "angle a1", "deg", 30],
    ]);
  });

  it("lists feature fields with units, skipping references, keywords and ids", () => {
    expect(featureValues({ type: "extrude", sketch: "s1", distance: "thick", op: "join", targets: "all" }).map((x) => [x.path, x.unit, x.value])).toEqual([["/distance", "mm", "thick"]]);
    expect(featureValues({ type: "hole", size: "M5", depth: { blind: 6 }, tip: 118, on: { face: { kind: "face", q: { op: "cap", feature: "e1" } } } }).map((x) => [x.path, x.label, x.unit])).toEqual([
      ["/depth/blind", "depth", "mm"],
      ["/tip", "tip angle", "deg"],
    ]);
    expect(featureValues({ type: "hole", size: "M3", depth: "through" })).toEqual([]);
    expect(featureValues({ type: "pattern", seed: { features: ["h1"] }, layout: { linear: { dir: "+X", count: 3, spacing: "pitch" } } }).map((x) => [x.path, x.label, x.unit])).toEqual([
      ["/layout/linear/count", "linear · count", "count"],
      ["/layout/linear/spacing", "linear · spacing", "mm"],
    ]);
    expect(featureValues({ type: "fillet", edges: { kind: "edge", q: { op: "edges" } }, r: 2 }).map((x) => x.label)).toEqual(["radius"]);
  });
});

describe("suggestParamName", () => {
  it("names a value after its feature and field, and never reuses a name", () => {
    expect(suggestParamName({ featureName: "slab", label: "distance" }, new Set())).toBe("slab_distance");
    expect(suggestParamName({ featureName: "base", label: "rect outline · width" }, new Set(["base_width"]))).toBe("base_width_2");
    expect(suggestParamName({ featureName: "2nd", label: "radius" }, new Set())).toBe("p_2nd_radius");
  });
});

describe("the corpus plate", () => {
  it_("every listed value is a field setField accepts, and the engine evaluates the expressions", async () => {
    const doc = (await engine.canonicalize(PLATE)).document;
    const values = modelValues(JSON.parse(doc) as never);
    expect(values.length).toBeGreaterThan(15);
    expect(values.find((v) => v.featureName === "slab")).toMatchObject({ path: "/distance", unit: "mm", value: "thick", isExpression: true });
    expect(values.find((v) => v.featureName === "rootRing")).toMatchObject({ path: "/r", unit: "mm", value: 2 });
    // Writing each value back unchanged is a no-op the engine accepts at that path.
    for (const v of values) {
      const r = await applyOp(engine, doc, { op: "setField", feature: v.feature, path: v.path, value: v.isExpression ? { expr: v.value } : v.value });
      expect([v.key, r.document]).toEqual([v.key, doc]);
    }
    // Expressions evaluate through scratch parameters in the feature's part.
    const scratch = withScratchParams(doc, values)!;
    const reports = await engine.params(scratch.text);
    const slab = values.find((v) => v.featureName === "slab")!;
    const p = reports.find((r) => r.name === scratch.names.get(slab.key));
    expect(p?.value).toBe(8);
  }, 60_000);
});
