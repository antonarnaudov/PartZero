/**
 * Round trips (IR-V1 plan W8 acceptance): `compileV1(printV1(ir), { base: ir }).ir` deep-equals
 * `ir` for every canonical v1 program and every migrated corpus/MakerBench document; the printer
 * is a fixed point; printed programs type-check against `@aicad/std` v1.
 */
import { describe, expect, it } from "vitest";
import { compile as compileV0, print as printV0 } from "../../src/index.js";
import { compileV1 } from "../../src/v1/compile.js";
import { join } from "node:path";
import type { v1 } from "@aicad/ir-types";
import { analyzeV1 } from "../../src/v1/compile.js";
import { parseExpr } from "../../src/v1/expr.js";
import { canonicalDocument, toJson } from "../../src/v1/json.js";
import { scalarOf } from "../../src/v1/lower-expr.js";
import { migrateV0ToV1 } from "../../src/v1/migrate.js";
import { printV1 } from "../../src/v1/print.js";
import { typecheckV1 } from "../../src/v1/typecheck.js";
import { corpusPrograms } from "../helpers.js";
import { CONFORMANCE, migrationPairs, readJson, v1Programs } from "./helpers.js";

const errorsOf = (r: { diagnostics: { severity: string; code: string; message: string }[] }): string[] =>
  r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`);

describe("v1 programs round-trip", () => {
  for (const p of v1Programs()) {
    describe(p.stem, () => {
      const source = printV1(p.ir);

      it("compileV1(printV1(ir), { base: ir }).ir deep-equals ir", () => {
        const r = compileV1(source, { base: p.ir });
        expect(errorsOf(r)).toEqual([]);
        expect(r.ir).toStrictEqual(p.ir);
      });

      it("the printer is a fixed point", () => {
        const r = compileV1(source);
        expect(errorsOf(r)).toEqual([]);
        expect(printV1(r.ir!)).toBe(source);
      });

      it("type-checks against @aicad/std v1", () => {
        expect(typecheckV1(source)).toEqual([]);
      });
    });
  }
});

describe("migrated documents round-trip (programs, MakerBench references, renames)", () => {
  for (const pair of migrationPairs()) {
    it(`${pair.group}/${pair.stem}`, () => {
      const source = printV1(pair.v1);
      const r = compileV1(source, { base: pair.v1 });
      expect(errorsOf(r)).toEqual([]);
      expect(r.ir).toStrictEqual(pair.v1);
      expect(printV1(r.ir!)).toBe(source);
      // printing a v0 document prints its migration
      expect(printV1(pair.v0)).toBe(source);
    });
  }
});

describe("v0 sources are v1 sources (automatic upgrade, SPEC-v1 §9.1)", () => {
  for (const { stem, ir } of corpusPrograms()) {
    it(`corpus/programs/${stem}: v1 compile of the v0 print = migration of the v0 compile`, () => {
      const source = printV0(ir);
      const v0 = compileV0(source);
      const r = compileV1(source);
      expect(errorsOf(r)).toEqual([]);
      expect(r.ir).toStrictEqual(migrateV0ToV1(v0.ir!));
      expect(printV1(r.ir!)).toBe(source);
      expect(compileV1(source, { base: ir }).ir).toStrictEqual(canonicalDocument(migrateV0ToV1(ir)));
    });
  }
});

describe("-0 and every accepted expression of the conformance fixture round-trip", () => {
  const cases = readJson(join(CONFORMANCE, "expressions/cases.json")) as {
    params: { name: string; unit: string; value: number | boolean }[];
    cases: { id: string; text: string; canonical?: string; type?: string }[];
  };
  const UNIT: Record<string, string> = { flex: "mm", bool: "bool", "1": "ratio", mm: "mm", deg: "deg" };
  const part = { id: "p1", name: "p", features: [{ type: "sketch", id: "s1", name: "base", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 5 }] }] };

  it("every canonical text (e034 `-0` included) as a parameter value: the lowered document is the document, bit for bit", () => {
    const accepted = cases.cases.filter((c) => c.canonical !== undefined);
    expect(accepted.length).toBeGreaterThan(280);
    expect(accepted.some((c) => c.id === "e034" && c.canonical === "-0")).toBe(true);
    for (const c of accepted) {
      const parsed = parseExpr(c.canonical!);
      if (!parsed.ok) throw new Error(`${c.id} does not parse`);
      const s = parsed.ast.k === "bool" ? { kind: "bool" as const, value: parsed.ast.v } : scalarOf(parsed.ast);
      const value = s.kind === "expr" ? s.text : s.value;
      const doc = { schema: "aicad.ir/1", params: [...cases.params, { name: "x", unit: UNIT[c.type ?? "flex"] ?? "mm", value }], parts: [part] } as unknown as v1.IrDocument;
      const a = analyzeV1(printV1(doc), { base: doc });
      expect(a.result.diagnostics.filter((d) => d.code.startsWith("CS_") && d.severity === "error").map((d) => `${d.code}: ${d.message}`), c.id).toEqual([]);
      expect(toJson(a.doc), c.id).toBe(toJson(doc));
      expect(a.doc, c.id).toStrictEqual(canonicalDocument(doc));
    }
  });

  it("-0.0 (solved write-back produces it) keeps its sign: coordinates, parameters, polygon centres", () => {
    const doc = {
      schema: "aicad.ir/1",
      params: [{ name: "z", unit: "mm", value: -0 }],
      parts: [
        {
          id: "p1",
          name: "p",
          features: [
            {
              type: "sketch",
              id: "s1",
              name: "base",
              plane: "XY",
              curves: [
                { kind: "circle", id: "c", center: [-0, 0], radius: 5 },
                { kind: "line", id: "l", start: [-0, -0], end: [10, -0] },
                { kind: "polygon", id: "h", center: [-0, 0], n: 6, circumradius: 3 },
                { kind: "rect", id: "r", center: [20, 20], w: 4, h: 4, r: -0 },
              ],
            },
          ],
        },
      ],
    } as unknown as v1.IrDocument;
    const json = toJson(doc);
    expect(json).toContain('"value": -0.0');
    expect(json).toContain('"center": [\n                -0.0,');
    expect(json).not.toMatch(/"r": -0\.0/); // a default: omitted, as Rust's `is_literal(0.0)` (-0 == 0)
    const src = printV1(doc);
    expect(src).toContain("const z = param(-0);");
    expect(src).toContain("c: circle({ center: [-0, 0], radius: 5 }),");
    expect(src).toContain("h: polygon({ center: [-0, 0], n: 6, circumradius: 3 }),");
    const r = compileV1(src, { base: doc });
    expect(errorsOf(r)).toEqual([]);
    expect(toJson(r.ir!)).toBe(json);
    expect(r.ir).toStrictEqual(canonicalDocument(doc));
    expect(Object.is((r.ir!.params![0] as { value: number }).value, -0)).toBe(true);
    // `param(-0)` and `[-0, 0]` in source compile to -0
    const direct = compileV1(`import { part, sketch, circle, XY, param } from "@aicad/std";\nconst z = param(-0);\npart("p");\nconst s = sketch(XY, { c: circle({ center: [-0, 0], radius: 1 }) });\n`);
    expect(Object.is(direct.ir!.params![0]!.value, -0)).toBe(true);
    expect(toJson(direct.ir!)).toContain("-0.0");
  });
});

