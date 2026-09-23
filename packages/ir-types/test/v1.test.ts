import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IR_SCHEMA, metricsV1, parseIrDocument as parseV0, v1 } from "../src/index.js";
import { REPO_ROOT } from "../scripts/generate.js";

const v1Dir = join(REPO_ROOT, "corpus/v1");
const jsonFiles = (dir: string, suffix: string): string[] =>
  readdirSync(join(v1Dir, dir))
    .filter((f) => f.endsWith(suffix))
    .sort()
    .map((f) => join(v1Dir, dir, f));
const read = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));

describe("v1 constants", () => {
  it("mirror forge-ir's ir-v1.constants.json", () => {
    const c = read(join(REPO_ROOT, "forge/crates/forge-ir/schema/ir-v1.constants.json")) as Record<string, unknown>;
    expect(v1.IR_SCHEMA).toBe("aicad.ir/1");
    expect(v1.METRICS_SCHEMA).toBe("aicad.metrics/1");
    expect(v1.LINEAR_TOLERANCE).toBe(c["LINEAR_TOLERANCE"]);
    expect(v1.RESERVED_NAMES).toEqual(c["RESERVED_NAMES"]);
    expect(v1.HOLE_SIZES.sizes.M3.normal.value).toBe(3.4);
    expect(v1.ERROR_CODES.INVALID_ID.stage).toBe("R");
    expect(new RegExp(v1.ID_PATTERN).test("outline")).toBe(true);
    expect(new RegExp(v1.ID_PATTERN).test("a/b")).toBe(false);
  });

  it("keep the v0 exports unchanged", () => {
    expect(IR_SCHEMA).toBe("aicad.ir/0");
    expect(v1.RESERVED_NAMES.slice(0, v1.RESERVED_NAMES_V0.length)).toEqual(v1.RESERVED_NAMES_V0);
  });
});

describe("v1.parseIrDocument", () => {
  const programs = jsonFiles("programs", ".json");
  it("has v1 programs to check", () => expect(programs.length).toBeGreaterThanOrEqual(5));
  for (const p of programs) {
    it(`accepts ${p.slice(v1Dir.length + 1)} losslessly`, () => {
      const raw = read(p);
      expect(v1.parseIrDocument(raw)).toStrictEqual(raw);
    });
  }

  const migrated = [...jsonFiles("conformance/migration/programs", ".v1.json"), ...jsonFiles("conformance/migration/makerbench", ".v1.json"), ...jsonFiles("conformance/migration/renames", ".v1.json")];
  it("accepts every migrated document, and the v0 twin with the v0 schema", () => {
    expect(migrated.length).toBeGreaterThanOrEqual(8 + 61);
    for (const p of migrated) {
      const raw = read(p);
      expect(v1.parseIrDocument(raw)).toStrictEqual(raw);
      const v0 = read(p.replace(/\.v1\.json$/, ".v0.json"));
      expect(parseV0(v0)).toStrictEqual(v0);
    }
  });

  it("parses the recursive query AST", () => {
    const doc = read(join(v1Dir, "programs/knob_queries.json")) as { parts: { features: { type: string; target?: { q: { op: string } } }[] }[] };
    const parsed = v1.parseIrDocument(doc);
    const tags = parsed.parts[0]!.features.filter((f) => f.type === "tag");
    expect(tags.length).toBeGreaterThanOrEqual(20);
  });

  it("rejects unknown fields and null (IR v1 has no nullable field)", () => {
    const base = read(join(v1Dir, "programs/params_plate.json")) as Record<string, unknown>;
    expect(() => v1.parseIrDocument({ ...base, bogus: 1 })).toThrow(v1.ParseError);
    const withNull = JSON.parse(JSON.stringify(base)) as { parts: { features: Record<string, unknown>[] }[] };
    withNull.parts[0]!.features[1]!["targets"] = null;
    expect(() => v1.parseIrDocument(withNull)).toThrow(v1.ParseError);
  });

  it("does not fill in defaults", () => {
    const doc = v1.parseIrDocument(read(join(v1Dir, "programs/params_plate.json")));
    const extrude = doc.parts[0]!.features[1]!;
    expect(extrude).not.toHaveProperty("v");
    expect(extrude).not.toHaveProperty("op");
    expect(v1.IR_DEFAULTS.ExtrudeFeature).toMatchObject({ v: 1, op: "new_body", direction: "normal", regions: "all", suppressed: false });
  });
});

describe("metricsV1", () => {
  it("parses a report with refs, candidates, a proposal and a nullable hole depth", () => {
    const report = {
      schema: "aicad.metrics/1",
      engine: "forge 0.1.0",
      document: "plate",
      status: "error",
      params: [{ name: "width", scope: "doc", unit: "mm", value: 80 }],
      features: [
        {
          part: "plate", feature: "corners", feature_id: "f1", type: "fillet", status: "error",
          error: { code: "REF_UNCERTAIN", message: "…", details: { field: "/edges" } },
          warnings: [{ code: "REF_SET_CHANGED", severity: "warning", message: "…", details: { added: [] } }],
          refs: [{
            field: "/edges", status: "failed", code: "REF_UNCERTAIN",
            members: [{ key: "e1/side:bottom", name: "slab/side:bottom", via: "named", status: "exact", probe: { kind: "face", point: [0, -25, 4], normal: [0, -1, 0] } }],
            unresolved: [{ key: "e1/side:top", name: "slab/side:top", reason: "name-not-found", candidates: [
              { key: "e1/side:top_a", name: "slab/side:top_a", confidence: 0.7, reason: "split-piece", probe: { kind: "face", point: [-20, 25, 4] },
                query: { op: "filter", where: { normal: "+Y" }, of: { op: "side", feature: "e1", curve: "top_a" } } }] }],
            proposal: { kind: "edge", q: { op: "edges", of: { op: "sides", feature: "e1" } } },
          }],
        },
        {
          part: "plate", feature: "mounts", feature_id: "h1", type: "hole", status: "ok", warnings: [],
          holes: [{ at: "g0_0", center: [0, 0, 8], axis: [0, 0, -1], d: 5.5, depth: null, kind: "counterbore", size: "M5", cbore: { d: 10, depth: 5.4 } }],
        },
      ],
      parts: [{ part: "plate", part_id: "p1", bodies: [] }],
    };
    expect(metricsV1.EvalReportSchema.parse(report)).toStrictEqual(report);
    expect(v1.parseEvalReport(JSON.stringify(report))).toStrictEqual(report);
  });
});
