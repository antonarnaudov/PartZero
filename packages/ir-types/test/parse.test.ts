import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FeatureSchema,
  IR_DEFAULTS,
  IR_SCHEMA,
  IrParseError,
  LINEAR_TOLERANCE,
  METRICS_SCHEMA,
  parseEvalReport,
  parseIrDocument,
  safeParseIrDocument,
  type IrDocument,
} from "../src/index.js";
import { REPO_ROOT } from "../scripts/generate.js";

const corpusDir = join(REPO_ROOT, "corpus/programs");
const corpus = readdirSync(corpusDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

const minimal = (): IrDocument => ({
  schema: IR_SCHEMA,
  parts: [
    {
      id: "p1",
      name: "part",
      features: [
        {
          type: "sketch",
          id: "s1",
          name: "base",
          plane: "XY",
          curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 5 }],
        },
        { type: "extrude", id: "e1", name: "puck", sketch: "base", distance: 2 },
      ],
    },
  ],
});

describe("constants", () => {
  it("mirror forge-ir lib.rs", () => {
    expect(IR_SCHEMA).toBe("aicad.ir/0");
    expect(METRICS_SCHEMA).toBe("aicad.metrics/0");
    expect(LINEAR_TOLERANCE).toBe(1e-6);
  });

  it("expose the schema defaults", () => {
    expect(IR_DEFAULTS.ExtrudeFeature).toEqual({ direction: "normal", op: "new_body", regions: "all", suppressed: false });
    expect(IR_DEFAULTS.IrDocument.units).toEqual({ angle: "deg", length: "mm" });
  });
});

describe("parseIrDocument", () => {
  it("has corpus programs to check", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of corpus) {
    it(`accepts corpus/programs/${file} losslessly`, () => {
      const text = readFileSync(join(corpusDir, file), "utf8");
      const raw: unknown = JSON.parse(text);
      expect(parseIrDocument(raw)).toStrictEqual(raw);
      expect(parseIrDocument(text)).toStrictEqual(raw);
    });
  }

  it("does not fill in defaults", () => {
    const doc = parseIrDocument(minimal());
    expect(doc).not.toHaveProperty("units");
    expect(doc).not.toHaveProperty("meta");
    expect(doc.parts[0]!.features[1]).not.toHaveProperty("direction");
  });

  it("rejects unknown top-level and feature fields (serde deny_unknown_fields)", () => {
    expect(() => parseIrDocument({ ...minimal(), bogus: 1 })).toThrow(IrParseError);
    const doc = minimal() as unknown as { parts: { features: Record<string, unknown>[] }[] };
    doc.parts[0]!.features[1]!["depth"] = 3;
    const r = safeParseIrDocument(doc);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.path).toBe("/parts/0/features/1");
  });

  it("rejects wrong types with a JSON-pointer path", () => {
    const doc = minimal() as unknown as { parts: { features: Record<string, unknown>[] }[] };
    doc.parts[0]!.features[1]!["distance"] = "8";
    const r = safeParseIrDocument(doc);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path)).toContain("/parts/0/features/1/distance");
  });

  it("rejects wrong tuple arity and unknown enum values", () => {
    const doc = minimal() as unknown as { parts: { features: Record<string, unknown>[] }[] };
    doc.parts[0]!.features[0]!["plane"] = "XW";
    expect(safeParseIrDocument(doc).success).toBe(false);
    const doc2 = minimal() as unknown as { parts: { features: { curves?: Record<string, unknown>[] }[] }[] };
    doc2.parts[0]!.features[0]!.curves![0]!["center"] = [0, 0, 0];
    expect(safeParseIrDocument(doc2).success).toBe(false);
  });

  it("accepts frames and every sweep direction", () => {
    for (const direction of ["normal", "reverse", "symmetric"] as const) {
      expect(
        FeatureSchema.safeParse({ type: "extrude", id: "e", name: "e", sketch: "s", distance: 1, direction }).success,
      ).toBe(true);
    }
    const sketch = {
      type: "sketch",
      id: "s",
      name: "s",
      plane: { origin: [0, 0, 1], normal: [0, 0, 1], x_dir: [1, 0, 0] },
      curves: [],
    };
    expect(FeatureSchema.safeParse(sketch).success).toBe(true);
  });
});

describe("parseEvalReport", () => {
  it("accepts a well-formed report and rejects a malformed one", () => {
    const report = {
      schema: METRICS_SCHEMA,
      engine: "forge 0.0.1",
      document: "extrude_box",
      status: "ok",
      features: [
        {
          part: "part",
          feature: "base",
          type: "sketch",
          status: "ok",
          regions: [{ area: 4000, loops: 1, outer_curves: ["bottom", "left", "right", "top"] }],
        },
        {
          part: "part",
          feature: "plate",
          type: "extrude",
          status: "ok",
          error: null,
          bodies: [
            {
              volume: 32000,
              area: 10080,
              centroid: [0, 0, 4],
              bbox_min: [-40, -25, 0],
              bbox_max: [40, 25, 8],
              faces: 6,
              edges: 12,
              face_types: { plane: 6 },
              edge_types: { line: 12 },
              valid: true,
            },
          ],
        },
      ],
    };
    expect(parseEvalReport(report)).toStrictEqual(report);
    expect(() => parseEvalReport({ ...report, status: "maybe" })).toThrow(IrParseError);
  });
});
