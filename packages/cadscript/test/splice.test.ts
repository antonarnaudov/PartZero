import type { ExtrudeFeature, IrDocument, SketchFeature } from "@aicad/ir-types";
import { describe, expect, it } from "vitest";
import { applyIrEdit, CadScriptEditError, CadScriptPrintError, compile, print } from "../src/index.js";

/** A hand-written file with comments and deliberately odd formatting. */
const SOURCE = `// Bracket, hand-tuned. Header comments survive every edit.
import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ } from "@aicad/std";

doc({ name: "bracket" });

part("part");
// The base plate outline — keep this comment!
const base   =   sketch( XY, {
    bottom: line([0,0],[10,0]),   // odd spacing
  right: line([10, 0], [10, 10]), top: line([10,10],[0,10]),
  left: line([0, 10], [0, 0]),
} );

/* Main body. */
const plate = extrude(base, { distance: 8 }); // trailing note
const lip = extrude(base, {distance:2,direction:"reverse"});
`;

function edit(source: string, f: (ir: IrDocument) => void): { old: IrDocument; next: IrDocument; out: string } {
  const r = compile(source);
  expect(r.diagnostics).toEqual([]);
  const old = r.ir!;
  const next = structuredClone(old);
  f(next);
  return { old, next, out: applyIrEdit(source, old, next) };
}

const feature = <T>(ir: IrDocument, name: string): T => ir.parts.flatMap((p) => p.features).find((f) => f.name === name) as T;

describe("applyIrEdit", () => {
  it("re-prints only the changed statement; comments and odd formatting elsewhere are untouched", () => {
    const { next, out } = edit(SOURCE, (ir) => {
      feature<ExtrudeFeature>(ir, "plate").distance = 12;
    });
    expect(out).toBe(SOURCE.replace("const plate = extrude(base, { distance: 8 });", "const plate = extrude(base, { distance: 12 });"));
    expect(compile(out, { base: next }).ir).toStrictEqual(next);
  });

  it("re-prints a changed sketch in canonical form but keeps its leading comment and neighbours", () => {
    const { next, out } = edit(SOURCE, (ir) => {
      feature<SketchFeature>(ir, "base").curves.push({ kind: "circle", id: "hole", center: [5, 5], radius: 1.5 });
    });
    expect(out).toContain("// The base plate outline — keep this comment!\nconst base = sketch(XY, {\n  bottom: line([0, 0], [10, 0]),");
    expect(out).toContain('  hole: circle({ center: [5, 5], radius: 1.5 }),\n});\n\n/* Main body. */\nconst plate = extrude(base, { distance: 8 }); // trailing note\n');
    expect(out).toContain('const lip = extrude(base, {distance:2,direction:"reverse"});');
    expect(compile(out, { base: next }).ir).toStrictEqual(next);
  });

  it("inserts added features after their predecessor and removes deleted ones with their comments", () => {
    const { next, out } = edit(SOURCE, (ir) => {
      const feats = ir.parts[0]!.features;
      feats.splice(1, 1); // drop `plate` (and its "Main body." comment)
      feats.push({ type: "revolve", id: "r_new", name: "spun", sketch: "base", axis: { origin: [0, 0], direction: [0, 1] }, angle: 90 });
    });
    expect(out).not.toContain("Main body");
    expect(out).not.toContain("trailing note");
    expect(out).toContain('// The base plate outline — keep this comment!\nconst base   =   sketch( XY, {');
    expect(out.endsWith('const lip = extrude(base, {distance:2,direction:"reverse"});\nconst spun = revolve(base, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 90 });\n')).toBe(true);
    expect(compile(out, { base: next }).ir).toStrictEqual(next);
  });

  it("moves a feature together with its comments", () => {
    const { next, out } = edit(SOURCE, (ir) => {
      const feats = ir.parts[0]!.features;
      const [plate] = feats.splice(1, 1);
      feats.push(plate!);
    });
    expect(out).toContain('const lip = extrude(base, {distance:2,direction:"reverse"});\n/* Main body. */\nconst plate = extrude(base, { distance: 8 });\n');
    expect(compile(out, { base: next }).ir).toStrictEqual(next);
  });

  it("updates doc() and adds parts", () => {
    const { next, out } = edit(SOURCE, (ir) => {
      ir.meta = { name: "bracket", description: "v2" };
      ir.parts.push({ id: "p2", name: "lid", features: [{ type: "sketch", id: "s2", name: "lidSketch", plane: "XZ", curves: [{ kind: "circle", id: "rim", center: [0, 0], radius: 3 }] }] });
    });
    expect(out).toContain('doc({ name: "bracket", description: "v2" });');
    expect(out.endsWith('\npart("lid");\nconst lidSketch = sketch(XZ, {\n  rim: circle({ center: [0, 0], radius: 3 }),\n});\n')).toBe(true);
    expect(out.startsWith("// Bracket, hand-tuned.")).toBe(true);
    expect(compile(out, { base: next }).ir).toStrictEqual(next);
  });

  it("extends the import when the edit needs builtins the file did not import", () => {
    const source = `import { part, sketch, line, extrude, XY } from "@aicad/std";\n\npart("part");\nconst s = sketch(XY, { a: line([0, 0], [1, 0]), b: line([1, 0], [0, 0]) });\n`;
    const { next, out } = edit(source, (ir) => {
      feature<SketchFeature>(ir, "s").curves[1] = { kind: "arc", id: "b", start: [1, 0], end: [0, 0], center: [0.5, 0], ccw: true };
    });
    expect(out.split("\n")[0]).toBe('import { part, sketch, line, arc, extrude, XY } from "@aicad/std";');
    expect(compile(out, { base: next }).ir).toStrictEqual(next);
  });

  it("is the identity when nothing changed", () => {
    const { out } = edit(SOURCE, () => undefined);
    expect(out).toBe(SOURCE);
  });

  it("refuses source with syntax errors and IR that cannot be printed", () => {
    const ir = compile(SOURCE).ir!;
    expect(() => applyIrEdit(`${SOURCE}const = ;`, ir, ir)).toThrow(CadScriptEditError);
    const bad = structuredClone(ir);
    bad.parts[0]!.features[0]!.name = "not-an-identifier";
    expect(() => applyIrEdit(SOURCE, ir, bad)).toThrow(CadScriptPrintError);
  });

  it("works on the canonical print of an edited corpus-like document", () => {
    const source = print(compile(SOURCE).ir!);
    const { next, out } = edit(source, (ir) => {
      feature<ExtrudeFeature>(ir, "lip").direction = "symmetric";
    });
    expect(out).toBe(print(next));
  });
});
