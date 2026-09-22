import { describe, expect, it } from "vitest";
import { compile, print, typecheck } from "../src/index.js";
import { corpusPrograms } from "./helpers.js";

const programs = corpusPrograms();

describe("corpus round-trip", () => {
  it("has the 8 corpus programs", () => {
    expect(programs.length).toBeGreaterThanOrEqual(8);
  });

  for (const { stem, ir } of programs) {
    describe(stem, () => {
      const source = print(ir);

      it("compile(print(ir), { base: ir }).ir deep-equals ir", () => {
        const r = compile(source, { base: ir });
        expect(r.diagnostics).toEqual([]);
        expect(r.ir).toStrictEqual(ir);
      });

      it("print(compile(src).ir) === src for the printed source", () => {
        const r = compile(source);
        expect(r.ok).toBe(true);
        expect(print(r.ir!)).toBe(source);
      });

      it("assigns deterministic ids without a base", () => {
        const a = compile(source).ir!;
        const b = compile(source).ir!;
        expect(a).toStrictEqual(b);
        expect(a.parts[0]!.id).toBe(`p_${ir.parts[0]!.name}`);
        for (const f of a.parts[0]!.features) expect(f.id).toBe(`f_${f.name}`);
      });

      it("maps every feature and curve to a span", () => {
        const r = compile(source, { base: ir });
        for (const part of ir.parts) {
          expect(r.partSpans[part.id]).toBeDefined();
          for (const f of part.features) {
            expect(r.spans[f.id]).toBeDefined();
            if (f.type === "sketch") {
              for (const c of f.curves) expect(r.curveSpans[f.id]![c.id]).toBeDefined();
            }
          }
        }
      });

      it("type-checks against @aicad/std", () => {
        expect(typecheck(source)).toEqual([]);
      });
    });
  }
});
