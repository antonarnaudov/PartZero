import { IR_SCHEMA, type IrDocument } from "@aicad/ir-types";
import { describe, expect, it } from "vitest";
import { compile, DIAGNOSTIC_CODES, formatDiagnostic, spanForIrPath, validateIr, type Diagnostic, type DiagnosticCode } from "../src/index.js";
import { src } from "./helpers.js";

const BOX = `part("part");
const base = sketch(XY, {
  bottom: line([0, 0], [10, 0]),
  right: line([10, 0], [10, 10]),
  top: line([10, 10], [0, 10]),
  left: line([0, 10], [0, 0]),
});
`;

function diagnosticsOf(source: string, base?: IrDocument): Diagnostic[] {
  return compile(source, { base }).diagnostics;
}

/** Expect exactly one diagnostic with `code` and return it. */
function one(diags: Diagnostic[], code: string): Diagnostic {
  const found = diags.filter((d) => d.code === code);
  expect(found, `${code} in ${JSON.stringify(diags, null, 1)}`).toHaveLength(1);
  return found[0]!;
}

function irWith(features: IrDocument["parts"][number]["features"]): IrDocument {
  return { schema: IR_SCHEMA, parts: [{ id: "p1", name: "part", features }] };
}

/**
 * One test per diagnostic code; `every diagnostic code has a test` below checks completeness.
 * Each case returns the diagnostic it expects so shared assertions can run on it.
 */
const cases: Record<DiagnosticCode, () => Diagnostic | void> = {
  CS_SYNTAX: () => {
    const d = one(diagnosticsOf(src(`${BOX}const plate = extrude(base, { distance: 8 };\n`)), "CS_SYNTAX");
    expect(d.span.start.line).toBe(10);
    return d;
  },
  CS_BAD_IMPORT: () => {
    const d = one(diagnosticsOf(`import { part } from "three";\n`), "CS_BAD_IMPORT");
    expect(d.message).toContain("@aicad/std");
    expect(one(diagnosticsOf(`import * as std from "@aicad/std";\n`), "CS_BAD_IMPORT").message).toContain("namespace");
    expect(one(diagnosticsOf(`import { part as p } from "@aicad/std";\n`), "CS_BAD_IMPORT").message).toContain("renaming");
    return d;
  },
  CS_NOT_IMPORTED: () => {
    const d = one(diagnosticsOf(`import { part, sketch, XY } from "@aicad/std";\n\n${BOX}`), "CS_NOT_IMPORTED");
    expect(d.message).toContain("`line`");
    expect(d.hint).toContain('import { part, sketch, XY, line } from "@aicad/std"');
    return d;
  },
  CS_UNKNOWN_BUILTIN: () => {
    const d = one(diagnosticsOf(src(`part("part");\nconst r = rect({ center: [0, 0], w: 10, h: 5 });\n`)), "CS_UNKNOWN_BUILTIN");
    expect(d.hint).toContain("four line()s");
    const curve = one(diagnosticsOf(src(`part("part");\nconst s = sketch(XY, { a: polyline([0, 0]) });\n`)), "CS_UNKNOWN_BUILTIN");
    expect(curve.message).toContain("polyline()");
    const notFeature = one(diagnosticsOf(src(`part("part");\nconst l = line([0, 0], [1, 1]);\n`)), "CS_UNKNOWN_BUILTIN");
    expect(notFeature.hint).toContain("curves go inside a sketch");
    return d;
  },
  CS_STATEMENT_UNSUPPORTED: () => {
    const d = one(diagnosticsOf(src(`${BOX}let plate = extrude(base, { distance: 8 });\n`)), "CS_STATEMENT_UNSUPPORTED");
    expect(d.hint).toContain("const");
    expect(one(diagnosticsOf(src(`${BOX}for (let i = 0; i < 3; i++) {}\n`)), "CS_STATEMENT_UNSUPPORTED").message).toContain("loops");
    expect(one(diagnosticsOf(src(`${BOX}if (true) {}\n`)), "CS_STATEMENT_UNSUPPORTED").message).toContain("conditionals");
    expect(one(diagnosticsOf(src(`${BOX}function f() {}\n`)), "CS_STATEMENT_UNSUPPORTED").message).toContain("functions");
    expect(one(diagnosticsOf(src(`${BOX}var x = 1;\n`)), "CS_STATEMENT_UNSUPPORTED").message).toContain("let`/`var");
    expect(one(diagnosticsOf(src(`${BOX}extrude(base, { distance: 8 });\n`)), "CS_STATEMENT_UNSUPPORTED").message).toContain("assigned to a const");
    return d;
  },
  CS_EXPR_UNSUPPORTED: () => {
    const d = one(diagnosticsOf(src(`${BOX}const plate = extrude(base, { distance: 4 * 2 });\n`)), "CS_EXPR_UNSUPPORTED");
    expect(d.message).toContain("arithmetic");
    expect(d.hint).toBe("expressions and param() arrive in CadScript v1; use a numeric literal: 8");
    expect(d.span).toEqual({ start: { line: 10, col: 41 }, end: { line: 10, col: 46 } });
    const variable = diagnosticsOf(src(`${BOX}const t = 8;\nconst plate = extrude(base, { distance: t });\n`));
    expect(variable.filter((x) => x.code === "CS_EXPR_UNSUPPORTED").map((x) => x.hint)).toEqual([
      "named values arrive with param() in CadScript v1; inline 8 where `t` is used",
      "named values and param() arrive in CadScript v1; inline the literal 8",
    ]);
    const template = one(diagnosticsOf(src("doc({ name: `box` });\n")), "CS_EXPR_UNSUPPORTED");
    expect(template.message).toContain("template strings");
    const spread = one(diagnosticsOf(src(`part("part");\nconst s = sketch(XY, { a: line(...[[0, 0], [1, 1]]) });\n`)), "CS_EXPR_UNSUPPORTED");
    expect(spread.message).toContain("spreads");
    const call = one(diagnosticsOf(src(`${BOX}const plate = extrude(base, { distance: Math.sqrt(64) });\n`)), "CS_EXPR_UNSUPPORTED");
    expect(call.message).toContain("function calls");
    const cast = one(diagnosticsOf(src(`${BOX}const plate = extrude(base, { distance: 8 }) as unknown;\n`)), "CS_EXPR_UNSUPPORTED");
    expect(cast.message).toBe("type assertions are not supported in `const plate`");
    const arrow = one(diagnosticsOf(src(`${BOX}const make = () => extrude(base, { distance: 8 });\n`)), "CS_EXPR_UNSUPPORTED");
    expect(arrow.message).toBe("functions are not supported in `const make`");
    return d;
  },
  CS_BAD_ARGUMENT: () => {
    const d = one(diagnosticsOf(src(`${BOX}const plate = extrude(base, { distance: "8" });\n`)), "CS_BAD_ARGUMENT");
    expect(d.message).toBe("distance must be a number (mm), got a string");
    expect(d.hint).toBe("remove the quotes: 8");
    const unknown = one(diagnosticsOf(src(`${BOX}const plate = extrude(base, { distnce: 8 });\n`)).filter((x) => x.message.includes("unknown")), "CS_BAD_ARGUMENT");
    expect(unknown.message).toBe("unknown property `distnce` in extrude options");
    expect(unknown.hint).toBe("did you mean `distance`?");
    const depth = one(diagnosticsOf(src(`${BOX}const plate = extrude(base, { distance: 8, depth: 2 });\n`)), "CS_BAD_ARGUMENT");
    expect(depth.hint).toBe("use `distance` (mm)");
    const missing = one(diagnosticsOf(src(`${BOX}const plate = extrude(base, { direction: "reverse" });\n`)), "CS_BAD_ARGUMENT");
    expect(missing.message).toContain("missing `distance`");
    const arity = one(diagnosticsOf(src(`part("part");\nconst s = sketch(XY, { a: line([0, 0, 0], [1, 1]) });\n`)), "CS_BAD_ARGUMENT");
    expect(arity.message).toContain("must have 2 numbers [u, v], got 3");
    const dir = one(diagnosticsOf(src(`${BOX}const plate = extrude(base, { distance: 8, direction: "revers" });\n`)), "CS_BAD_ARGUMENT");
    expect(dir.hint).toBe('did you mean "reverse"?');
    const units = one(diagnosticsOf(src(`doc({ name: "x", units: "inch" });\n${BOX}`)), "CS_BAD_ARGUMENT");
    expect(units.hint).toContain("millimetres and degrees");
    return d;
  },
  CS_DOC_MISPLACED: () => {
    const d = one(diagnosticsOf(src(`${BOX}doc({ name: "late" });\n`)), "CS_DOC_MISPLACED");
    expect(d.hint).toContain("directly below the import");
    expect(one(diagnosticsOf(src(`doc({ name: "a" });\ndoc({ name: "b" });\n${BOX}`)), "CS_DOC_MISPLACED").message).toContain("only once");
    return d;
  },
  CS_MISSING_PART: () => {
    const d = one(diagnosticsOf(src(`const base = sketch(XY, { c: circle({ center: [0, 0], radius: 1 }) });\n`)), "CS_MISSING_PART");
    expect(d.hint).toContain('part("part");');
    return d;
  },
  CS_DUPLICATE_NAME: () => {
    const d = one(diagnosticsOf(src(`${BOX}const base = extrude(base, { distance: 8 });\n`)), "CS_DUPLICATE_NAME");
    expect(d.message).toBe("`base` is already declared on line 4");
    // Feature names are unique across parts too (they share one module scope).
    const crossPart = diagnosticsOf(src(`${BOX}\npart("other");\nconst base = sketch(XZ, { c: circle({ center: [0, 0], radius: 1 }) });\n`));
    one(crossPart, "CS_DUPLICATE_NAME");
    return d;
  },
  CS_RESERVED_NAME: () => {
    const d = one(diagnosticsOf(src(`part("part");\nconst frame = sketch(XY, { c: circle({ center: [0, 0], radius: 1 }) });\n`)), "CS_RESERVED_NAME");
    expect(d.message).toContain("`frame` is reserved");
    return d;
  },
  CS_UNRESOLVED_SKETCH: () => {
    const d = one(diagnosticsOf(src(`${BOX}const plate = extrude(bsae, { distance: 8 });\n`)), "CS_UNRESOLVED_SKETCH");
    expect(d.hint).toBe("did you mean `base`?");
    const forward = one(
      diagnosticsOf(src(`part("part");\nconst plate = extrude(base, { distance: 8 });\n${BOX.slice('part("part");\n'.length)}`)),
      "CS_UNRESOLVED_SKETCH",
    );
    expect(forward.message).toBe("`base` is used before it is declared");
    const notSketch = one(
      diagnosticsOf(src(`${BOX}const plate = extrude(base, { distance: 8 });\nconst again = extrude(plate, { distance: 1 });\n`)),
      "CS_UNRESOLVED_SKETCH",
    );
    expect(notSketch.message).toBe("`plate` is an extrude, not a sketch");
    expect(notSketch.hint).toBe("pass the sketch it was made from: `base`");
    const otherPart = one(diagnosticsOf(src(`${BOX}\npart("other");\nconst plate = extrude(base, { distance: 8 });\n`)), "CS_UNRESOLVED_SKETCH");
    expect(otherPart.message).toBe("`base` belongs to another part");
    return d;
  },
  CS_RENAME_DETECTED: () => {
    const base = compile(src(`${BOX}const plate = extrude(base, { distance: 8 });\n`)).ir!;
    const r = compile(src(`${BOX}const slab = extrude(base, { distance: 8 });\n`), { base });
    const d = one(r.diagnostics, "CS_RENAME_DETECTED");
    expect(d.severity).toBe("info");
    expect(r.ok).toBe(true);
    expect(r.ir!.parts[0]!.features[1]!.id).toBe(base.parts[0]!.features[1]!.id);
    return d;
  },
  UNSUPPORTED_SCHEMA: () => {
    const errs = validateIr({ schema: "aicad.ir/9", parts: [{ id: "p", name: "p", features: [] }] });
    expect(errs).toEqual([{ code: "UNSUPPORTED_SCHEMA", path: "/schema", message: 'expected "aicad.ir/0", got "aicad.ir/9"' }]);
  },
  NO_PARTS: () => {
    const d = one(diagnosticsOf(src(`doc({ name: "empty" });\n`)), "NO_PARTS");
    expect(d.irPath).toBe("/parts");
    return d;
  },
  DUPLICATE_ID: () => {
    const d = one(diagnosticsOf(src(`part("part");\nconst s = sketch(XY, {\n  c: circle({ center: [0, 0], radius: 1 }),\n  c: circle({ center: [5, 0], radius: 1 }),\n});\n`)), "DUPLICATE_ID");
    expect(d.irPath).toBe("/parts/0/features/0/curves/1/id");
    expect(d.span.start).toEqual({ line: 6, col: 3 });
    const ir = irWith([
      { type: "sketch", id: "x", name: "a", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 1 }] },
      { type: "extrude", id: "x", name: "b", sketch: "a", distance: 1 },
    ]);
    expect(validateIr(ir).map((e) => e.code)).toEqual(["DUPLICATE_ID"]);
    return d;
  },
  DUPLICATE_NAME: () => {
    const d = one(diagnosticsOf(src(`${BOX}\npart("part");\n`)), "DUPLICATE_NAME");
    expect(d.irPath).toBe("/parts/1/name");
    expect(d.span.start).toEqual({ line: 11, col: 6 });
    return d;
  },
  INVALID_NAME: () => {
    const d = one(diagnosticsOf(src(`${BOX}const $plate = extrude(base, { distance: 8 });\n`)), "INVALID_NAME");
    expect(d.span).toEqual({ start: { line: 10, col: 7 }, end: { line: 10, col: 13 } });
    return d;
  },
  RESERVED_NAME: () => {
    // The compiler already rejects reserved consts (CS_RESERVED_NAME); an IR coming from
    // elsewhere is caught by the forge-ir mirror.
    const ir = irWith([
      { type: "sketch", id: "f1", name: "extrude", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 1 }] },
    ]);
    expect(validateIr(ir).map((e) => e.code)).toEqual(["RESERVED_NAME"]);
  },
  UNRESOLVED_SKETCH: () => {
    // Mirrors forge-ir's `rejects_forward_references_and_bad_values` test.
    const ir = irWith([
      { type: "extrude", id: "f1", name: "early", sketch: "base", distance: -1 },
      { type: "sketch", id: "f2", name: "base", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 0 }] },
    ]);
    expect(validateIr(ir).map((e) => e.code)).toEqual(["UNRESOLVED_SKETCH", "INVALID_DISTANCE", "DEGENERATE_CURVE"]);
  },
  INVALID_DISTANCE: () => {
    const d = one(diagnosticsOf(src(`${BOX}const plate = extrude(base, { distance: -8 });\n`)), "INVALID_DISTANCE");
    expect(d.span).toEqual({ start: { line: 10, col: 41 }, end: { line: 10, col: 43 } });
    expect(d.hint).toContain('direction: "reverse"');
    return d;
  },
  INVALID_ANGLE: () => {
    const d = one(
      diagnosticsOf(src(`${BOX}const spun = revolve(base, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 400 });\n`)),
      "INVALID_ANGLE",
    );
    expect(d.irPath).toBe("/parts/0/features/1/angle");
    return d;
  },
  INVALID_AXIS: () =>
    one(diagnosticsOf(src(`${BOX}const spun = revolve(base, { axis: { origin: [0, 0], direction: [0, 0] }, angle: 90 });\n`)), "INVALID_AXIS"),
  INVALID_PLANE: () => {
    const d = one(
      diagnosticsOf(src(`part("part");\nconst s = sketch(frame({ origin: [0, 0, 0], normal: [0, 0, 1], xDir: [0, 1, 1] }), { c: circle({ center: [0, 0], radius: 1 }) });\n`)),
      "INVALID_PLANE",
    );
    expect(d.message).toContain("perpendicular");
    return d;
  },
  EMPTY_SKETCH: () => one(diagnosticsOf(src(`part("part");\nconst s = sketch(XY, {});\n`)), "EMPTY_SKETCH"),
  NON_FINITE: () => one(diagnosticsOf(src(`part("part");\nconst s = sketch(XY, { a: line([1e999, 0], [0, 0]) });\n`)), "NON_FINITE"),
  DEGENERATE_CURVE: () => {
    const d = one(diagnosticsOf(src(`part("part");\nconst s = sketch(XY, { a: line([1, 1], [1, 1]) });\n`)), "DEGENERATE_CURVE");
    expect(d.span.start).toEqual({ line: 4, col: 24 });
    return d;
  },
  INCONSISTENT_ARC: () =>
    one(diagnosticsOf(src(`part("part");\nconst s = sketch(XY, { a: arc({ start: [1, 0], end: [0, 2], center: [0, 0], ccw: true }) });\n`)), "INCONSISTENT_ARC"),
};

describe("diagnostics", () => {
  it("every diagnostic code has a test", () => {
    expect(Object.keys(cases).sort()).toEqual(Object.keys(DIAGNOSTIC_CODES).sort());
  });

  for (const [code, run] of Object.entries(cases)) {
    it(code, () => {
      const d = run();
      if (d) {
        expect(d.severity).toBe(DIAGNOSTIC_CODES[code as DiagnosticCode].severity);
        expect(d.span.start.line).toBeGreaterThan(0);
        expect(d.span.start.col).toBeGreaterThan(0);
      }
    });
  }

  it("reports every problem in one pass without cascading", () => {
    const r = compile(
      src(`${BOX}const plate = extrude(base, { distance: 0 });\nconst spun = revolve(base, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 0 });\nconst bad = extrude(base, { distance: "x" });\n`),
    );
    expect(r.ok).toBe(false);
    expect(r.ir).toBeNull();
    expect(r.diagnostics.map((d) => d.code)).toEqual(["INVALID_DISTANCE", "INVALID_ANGLE", "CS_BAD_ARGUMENT"]);
  });

  it("does not cascade from a broken sketch to the features that use it", () => {
    const r = compile(src(`part("part");\nconst base = sketch(XY, { a: line([0, 0], [w, 0]) });\nconst plate = extrude(base, { distance: 8 });\n`));
    expect(r.diagnostics.map((d) => d.code)).toEqual(["CS_EXPR_UNSUPPORTED"]);
  });

  it("maps IR paths to spans, falling back to the enclosing element", () => {
    const r = compile(src(`${BOX}const plate = extrude(base, { distance: 8 });\n`));
    expect(spanForIrPath(r, "/parts/0/features/1/distance")).toEqual({ start: { line: 10, col: 41 }, end: { line: 10, col: 42 } });
    expect(spanForIrPath(r, "/parts/0/features/1/does/not/exist")).toEqual(r.spans["f_plate"]);
    expect(spanForIrPath(r, "/parts/0/features/0/curves/2")).toEqual(r.curveSpans["f_base"]!["top"]);
  });

  it("formats diagnostics for humans", () => {
    const d = one(diagnosticsOf(src(`${BOX}const plate = extrude(base, { distance: "8" });\n`)), "CS_BAD_ARGUMENT");
    expect(formatDiagnostic(d, "box.cad.ts")).toBe(
      "box.cad.ts:10:41 - error CS_BAD_ARGUMENT: distance must be a number (mm), got a string\n    hint: remove the quotes: 8",
    );
  });
});
