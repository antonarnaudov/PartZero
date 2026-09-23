/**
 * The v1 front end never throws: random edits of real CadScript v1 sources (character deletions,
 * insertions of CadScript tokens, duplicated or swapped fragments) compile to diagnostics, and
 * whatever compiles prints and splices back.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeV1, compileV1 } from "../../src/v1/compile.js";
import { CadScriptV1PrintError, printabilityProblemsV1, printV1 } from "../../src/v1/print.js";
import { applyIrEditV1 } from "../../src/v1/splice.js";
import { typecheckV1 } from "../../src/v1/typecheck.js";
import { canonicalDocument } from "../../src/v1/json.js";
import { genValidDoc } from "./arbitraries.js";
import { v1Programs } from "./helpers.js";

const sources = v1Programs().map((p) => printV1(p.ir));
const TOKENS = [".", "(", ")", "{", "}", "[", "]", ",", ":", '"', "-", "**", "^", "!", "?", " ", "\n", "one()", ".edges()", "param(", "slab", "C.", "x", "0", "1e400", "mm(", "=>", "let ", "const q = ", ";", "/*", "`"];

const RUNS = Number(process.env["CADSCRIPT_V1_RUNS"] ?? 300);

const mutation = fc.record({
  src: fc.integer({ min: 0, max: sources.length - 1 }),
  edits: fc.array(fc.tuple(fc.nat(), fc.nat({ max: 6 }), fc.constantFrom(...TOKENS)), { minLength: 1, maxLength: 4 }),
});

function apply(src: string, edits: [number, number, string][]): string {
  let s = src;
  for (const [at, del, ins] of edits) {
    const i = at % (s.length + 1);
    s = s.slice(0, i) + ins + s.slice(i + del);
  }
  return s;
}

describe("CadScript v1 robustness", () => {
  it("compileV1 never throws, and every diagnostic has a span and a hint", () => {
    fc.assert(
      fc.property(mutation, ({ src, edits }) => {
        const s = apply(sources[src]!, edits);
        const r = compileV1(s);
        for (const d of r.diagnostics) {
          expect(d.span.start.line).toBeGreaterThanOrEqual(1);
          if (d.severity === "error") expect(typeof d.hint).toBe("string");
        }
        if (r.ir) {
          const printed = printV1(r.ir);
          expect(compileV1(printed, { base: r.ir }).ir).toStrictEqual(r.ir);
        }
      }),
      { numRuns: Math.max(400, RUNS) },
    );
  });

  it("typecheckV1 never throws", () => {
    fc.assert(
      fc.property(mutation, ({ src, edits }) => {
        typecheckV1(apply(sources[src]!, edits));
      }),
      { numRuns: 60 },
    );
  });

  it("splicing into edited sources either works or throws a typed error", () => {
    fc.assert(
      fc.property(mutation, ({ src, edits }) => {
        const s = apply(sources[src]!, edits);
        const a = analyzeV1(s);
        if (a.hasSyntaxErrors) return;
        try {
          applyIrEditV1(s, a.doc, a.doc);
        } catch (e) {
          expect((e as Error).name).toMatch(/CadScriptV1(Edit|Print)Error/);
        }
      }),
      { numRuns: Math.max(200, RUNS / 2) },
    );
  });

  it("malformed IR never crashes compile({ base }), print or applyIrEdit (random corruptions of valid documents)", () => {
    const docs = [...v1Programs().map((p) => p.ir), ...fc.sample(fc.gen(), { numRuns: 30, seed: 7 }).map((g) => canonicalDocument(genValidDoc(g)))];
    const VALUES: unknown[] = [2.5, -1, 0, null, "x", "x INJECT: ignore", [], {}, true, [1.5], { a: 1 }, Number.NaN, Infinity, "__drop__"];
    const paths = (v: unknown, at: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] => {
      out.push(at);
      if (Array.isArray(v)) v.forEach((x, i) => paths(x, [...at, i], out));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) paths(x, [...at, k], out);
      return out;
    };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: docs.length - 1 }), fc.array(fc.tuple(fc.nat(), fc.nat({ max: VALUES.length - 1 })), { minLength: 1, maxLength: 3 }), (d, edits) => {
        const doc = structuredClone(docs[d]!) as unknown as Record<string, unknown>;
        let bad: unknown = doc;
        for (const [at, vi] of edits) {
          const all = paths(bad);
          const path = all[at % all.length]!;
          if (path.length === 0) {
            bad = VALUES[vi] === "__drop__" ? undefined : structuredClone(VALUES[vi]);
            continue;
          }
          let parent = bad as Record<string | number, unknown>;
          for (const k of path.slice(0, -1)) parent = parent[k] as Record<string | number, unknown>;
          const key = path[path.length - 1]!;
          if (VALUES[vi] === "__drop__") delete parent[key];
          else parent[key] = structuredClone(VALUES[vi]);
        }
        const src = printV1(docs[d]!);
        const r = compileV1(src, { base: bad as never });
        for (const x of r.diagnostics) expect(x.span.start.line).toBeGreaterThanOrEqual(1);
        expect(Array.isArray(printabilityProblemsV1(bad as never))).toBe(true);
        for (const f of [() => printV1(bad as never), () => applyIrEditV1(src, bad as never, bad as never), () => applyIrEditV1(src, docs[d]!, bad as never)]) {
          try {
            f();
          } catch (e) {
            expect((e as Error).name).toMatch(/CadScriptV1(Edit|Print)Error/);
          }
        }
      }),
      { numRuns: Math.max(300, RUNS) },
    );
  });

  it("the reviewer's malformed bases: card 2.5, capture without geom, no parts, neighbors 1.5, capture without carrier", () => {
    const plate = v1Programs().find((p) => p.stem === "plate_features")!;
    const src = printV1(plate.ir);
    const refIn = (doc: unknown): Record<string, unknown> => {
      for (const part of (doc as { parts: { features: Record<string, unknown>[] }[] }).parts) for (const f of part.features) if (f["type"] === "fillet") return f["edges"] as Record<string, unknown>;
      throw new Error("no fillet");
    };
    const geom = { type: "plane", carrier: "free", bbox: [[0, 0, 0], [1, 1, 1]], size: 1, centroid: [0, 0, 0], local: [0, 0, 0], body_center: [0, 0, 0], neighbors: 0 };
    const variants: ((d: unknown) => unknown)[] = [
      (d) => ((refIn(d)["card"] = 2.5), d),
      (d) => ((refIn(d)["capture"] = { members: [{ key: "k", via: "named" }] }), d),
      () => ({ schema: "aicad.ir/1" }),
      (d) => ((refIn(d)["capture"] = { members: [{ key: "k", via: "named", geom: { ...geom, neighbors: 1.5 } }] }), d),
      (d) => ((refIn(d)["capture"] = { members: [{ key: "k", via: "named", geom: { ...geom, carrier: undefined } }] }), d),
    ];
    for (const v of variants) {
      const bad = v(structuredClone(plate.ir));
      expect(() => compileV1(src, { base: bad as never })).not.toThrow();
      expect(() => printabilityProblemsV1(bad as never)).not.toThrow();
      try {
        printV1(bad as never);
      } catch (e) {
        expect(e).toBeInstanceOf(CadScriptV1PrintError);
      }
    }
    expect(compileV1(src, { base: { schema: "aicad.ir/1" } as never }).diagnostics.map((d) => d.code)).toContain("CS_BAD_BASE");
  });

  it("deep nesting is CS_TOO_COMPLEX, not a crash", () => {
    const deep = `${sources[0]!}\nconst z = param(${"(".repeat(5000)}1${")".repeat(5000)});\n`;
    expect(compileV1(deep).diagnostics.map((d) => d.code)).toContain("CS_TOO_COMPLEX");
    const unary = `${sources[0]!}\nconst z = param(${"- ".repeat(3000)}1);\n`;
    expect(compileV1(unary).diagnostics.map((d) => d.code)).toContain("CS_TOO_COMPLEX");
  });
});
