import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyIrEdit, compile, print, validateIr } from "../src/index.js";
import { irDocument, irEdit } from "./arbitraries.js";

const RUNS = { numRuns: Number(process.env["CADSCRIPT_FC_RUNS"] ?? 300) };

describe("property: random valid IR v0 documents", () => {
  it("are valid according to the validate.rs mirror (generator sanity)", () => {
    fc.assert(
      fc.property(irDocument, (ir) => {
        expect(validateIr(ir)).toEqual([]);
      }),
      RUNS,
    );
  });

  it("round-trip: compile(print(ir), { base: ir }).ir deep-equals ir", () => {
    fc.assert(
      fc.property(irDocument, (ir) => {
        const r = compile(print(ir), { base: ir });
        expect(r.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
        expect(r.ir).toStrictEqual(ir);
      }),
      RUNS,
    );
  });

  it("print is a fixed point: print(compile(print(ir)).ir) === print(ir)", () => {
    fc.assert(
      fc.property(irDocument, (ir) => {
        const source = print(ir);
        const r = compile(source);
        expect(r.ok).toBe(true);
        expect(print(r.ir!)).toBe(source);
      }),
      RUNS,
    );
  });

  it("compiling without a base is deterministic and yields unique ids", () => {
    fc.assert(
      fc.property(irDocument, (ir) => {
        const source = print(ir);
        const a = compile(source).ir!;
        expect(compile(source).ir).toStrictEqual(a);
        const partIds = a.parts.map((p) => p.id);
        expect(new Set(partIds).size).toBe(partIds.length);
        const featureIds = a.parts.flatMap((p) => p.features.map((f) => f.id));
        expect(new Set(featureIds).size).toBe(featureIds.length);
      }),
      RUNS,
    );
  });
});

describe("property: applyIrEdit", () => {
  it("splicing an edit into canonical source gives the canonical print of the new IR", () => {
    fc.assert(
      fc.property(irEdit, ({ before, after }) => {
        expect(applyIrEdit(print(before), before, after)).toBe(print(after));
      }),
      RUNS,
    );
  });

  it("keeps comments on every feature that the edit does not delete", () => {
    fc.assert(
      fc.property(irEdit, ({ before, after }) => {
        // Annotate every feature statement of the canonical source with a comment naming its id.
        const lines = print(before).split("\n");
        const annotated: string[] = [];
        const ids = before.parts.flatMap((p) => p.features.map((f) => ({ part: p.id, id: f.id, name: f.name })));
        let k = 0;
        for (const line of lines) {
          const m = /^const (\w+) = /.exec(line);
          if (m) annotated.push(`// keep:${k++}`);
          annotated.push(line);
        }
        const out = applyIrEdit(annotated.join("\n"), before, after);
        const survivors = new Set(after.parts.flatMap((p) => p.features.map((f) => `${p.id}\u0000${f.id}`)));
        ids.forEach((f, i) => {
          if (survivors.has(`${f.part}\u0000${f.id}`)) expect(out).toContain(`// keep:${i}\n`);
          else expect(out).not.toContain(`// keep:${i}\n`);
        });
        const r = compile(out, { base: after });
        if (validateIr(after).length === 0) expect(r.ir).toStrictEqual(after);
      }),
      RUNS,
    );
  });
});
