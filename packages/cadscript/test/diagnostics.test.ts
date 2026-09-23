import { IR_SCHEMA, type IrDocument } from "@aicad/ir-types";
import { describe, expect, it } from "vitest";
import { COMPILE_AS_V1 } from "../src/syntax.js";
import {
  compile,
  DIAGNOSTIC_CODES,
  formatDiagnostic,
  MAX_FLOW_STEPS,
  spanForIrPath,
  typecheck,
  validateIr,
  type Diagnostic,
  type DiagnosticCode,
} from "../src/index.js";
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
    // `const x;` parses (TypeScript flags TS1155 only in its checker) but must not vanish silently.
    const r = compile(src(`${BOX}const x;\nconst plate = extrude(x, { distance: 8 });\n`));
    expect(r.ok).toBe(false);
    expect(r.ir).toBeNull();
    const noInit = one(r.diagnostics, "CS_SYNTAX");
    expect(noInit.message).toBe("`const x` has no value: 'const' declarations must be initialized");
    expect(noInit.span).toEqual({ start: { line: 10, col: 7 }, end: { line: 10, col: 8 } });
    expect(r.diagnostics.map((x) => x.code)).toEqual(["CS_SYNTAX"]); // no cascade into `plate`
    return d;
  },
  CS_TOO_COMPLEX: () => {
    // Deep brackets are rejected on tokens, before the parser could overflow the stack.
    const r = compile(src(`${BOX}const plate = extrude(base, { distance: ${"(".repeat(5000)}8${")".repeat(5000)} });\n`));
    expect(r.ok).toBe(false);
    const d = one(r.diagnostics, "CS_TOO_COMPLEX");
    expect(r.diagnostics).toHaveLength(1);
    expect(d.message).toBe("brackets are nested more than 32 levels deep");
    // extrude( and { are levels 1–2: the 31st paren is level 33.
    expect(d.span).toEqual({ start: { line: 10, col: 41 + 30 }, end: { line: 10, col: 42 + 30 } });
    expect(d.hint).toContain("unbalanced brackets");
    // typecheck() also stops at the checker's work limits, e.g. MAX_FLOW_STEPS, where tsc's time
    // grows with the square of the statement count. part() and `base` are steps 1–2, so the 2047th
    // extrude is step 2049. compile() has no such limit.
    const extrudes = (n: number) => src(`${BOX}${Array.from({ length: n }, (_, i) => `const e${i} = extrude(base, { distance: 1 });\n`).join("")}`);
    expect(typecheck(extrudes(MAX_FLOW_STEPS - 2))).toEqual([]);
    const many = extrudes(MAX_FLOW_STEPS - 1);
    expect(compile(many).diagnostics).toEqual([]);
    const [work, ...rest] = typecheck(many);
    expect(rest).toEqual([]);
    expect(work).toMatchObject({ code: "CS_TOO_COMPLEX", severity: "error" });
    expect(work!.message).toBe("not type-checked: the file has more than 2048 declarations, assignments and statements");
    expect(work!.span).toEqual({ start: { line: 2056, col: 7 }, end: { line: 2056, col: 45 } });
    expect(work!.hint).toContain("look for a line or fragment repeated by mistake");
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
    expect(d.hint).toBe(`rect() is CadScript v1: ${COMPILE_AS_V1}`);
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
    // The folded literal comes first (the concrete repair in a v0 session: agent-tools passes the
    // hint to the model as its "fix:" line), then the pointer at v1 (the CLI's default).
    expect(d.hint).toBe(`use a numeric literal: 8; or keep the expression and ${COMPILE_AS_V1}`);
    const hintOf = (arg: string) =>
      one(diagnosticsOf(src(`${BOX}const plate = extrude(base, { distance: ${arg} });\n`)), "CS_EXPR_UNSUPPORTED").hint;
    expect(hintOf("(8)")).toBe(`use a numeric literal: 8; or keep the expression and ${COMPILE_AS_V1}`);
    expect(hintOf("+8")).toBe(`use a numeric literal: 8; or keep the expression and ${COMPILE_AS_V1}`);
    expect(hintOf("-(-8)")).toBe(`use a numeric literal: 8; or keep the expression and ${COMPILE_AS_V1}`);
    expect(hintOf("10 / 4")).toBe(`use a numeric literal: 2.5; or keep the expression and ${COMPILE_AS_V1}`);
    // no finite fold (division by zero, a non-numeric operand): only the v1 pointer
    expect(hintOf("1 / 0")).toBe(`expressions and param() are CadScript v1: ${COMPILE_AS_V1}`);
    expect(hintOf("(8 + t)")).toBe(`expressions and param() are CadScript v1: ${COMPILE_AS_V1}`);
    expect(d.span).toEqual({ start: { line: 10, col: 41 }, end: { line: 10, col: 46 } });
    const variable = diagnosticsOf(src(`${BOX}const t = 8;\nconst plate = extrude(base, { distance: t });\n`));
    expect(variable.filter((x) => x.code === "CS_EXPR_UNSUPPORTED").map((x) => x.hint)).toEqual([
      `inline 8 where \`t\` is used; or make it a parameter (const t = param(8)) and ${COMPILE_AS_V1}`,
      `inline the literal 8; or keep \`t\` as a param() const and ${COMPILE_AS_V1}`,
    ]);
    // not a number: no parameter suggestion at the const; the v1 pointer alone at the use
    const nonNumeric = diagnosticsOf(src(`${BOX}const t = "8";\nconst plate = extrude(base, { distance: t });\n`));
    expect(nonNumeric.filter((x) => x.code === "CS_EXPR_UNSUPPORTED").map((x) => x.hint)).toEqual([
      `inline "8" where \`t\` is used`,
      `named values are param() consts of CadScript v1: ${COMPILE_AS_V1}`,
    ]);
    const flag = diagnosticsOf(src(`${BOX}const on = true;\n`)).find((x) => x.code === "CS_EXPR_UNSUPPORTED");
    expect(flag?.hint).toBe(`inline true where \`on\` is used; or make it a parameter (const on = param(true)) and ${COMPILE_AS_V1}`);
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
  it("INVALID_NAME: empty part name (SPEC §0 R-15, mirrors forge-ir)", () => {
    const ir = { ...irWith([]), parts: [{ id: "p", name: "", features: [] }] };
    expect(validateIr(ir).map((e) => [e.code, e.path])).toEqual([["INVALID_NAME", "/parts/0/name"]]);
  });

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
