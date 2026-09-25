/**
 * Every diagnostic code of CadScript v1 (IR-V1 plan W8 acceptance): each **R** (and R/E-on-literal)
 * code of SPEC-v1 §7.5 produced from CadScript at the right span with a hint — or, when the
 * CadScript front end makes it unreachable, the `CS_*` code that replaces it — and every new
 * `CS_*` code with a test.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { v1 as irV1 } from "@aicad/ir-types";
import { compileV1 } from "../../src/v1/compile.js";
import type { DiagnosticV1 } from "../../src/v1/context.js";
import { closestId, CS_CODES_V1, editDistance, hintForError, IR_CODES_V1 } from "../../src/v1/diagnostics.js";
import { loadIrDocument } from "../../src/v1/validate.js";
import { canonicalDocument } from "../../src/v1/json.js";
import { CadScriptV1PrintError, printabilityProblemsV1, printV1 } from "../../src/v1/print.js";
import { BUILTINS_V1 } from "../../src/v1/syntax.js";

const IMPORT = `import { ${BUILTINS_V1.join(", ")} } from "@aicad/std";\n`;
const src = (body: string): string => `${IMPORT}\n${body}`;

/** The source text a span covers. */
function spanText(source: string, d: DiagnosticV1): string {
  const lines = source.split("\n");
  const off = (line: number, col: number): number => lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col - 1;
  return source.slice(off(d.span.start.line, d.span.start.col), off(d.span.end.line, d.span.end.col));
}

/** The diagnostic with `code` (the one whose span covers `span`, when given). */
function find(source: string, code: string, span?: string): { d: DiagnosticV1; text: string } {
  const r = compileV1(source);
  const all = r.diagnostics.filter((x) => x.code === code);
  const d = (span === undefined ? undefined : all.find((x) => spanText(source, x) === span)) ?? all[0];
  if (!d) throw new Error(`no ${code} in ${JSON.stringify(r.diagnostics.map((x) => `${x.code}: ${x.message}`))}`);
  return { d, text: spanText(source, d) };
}

const PLATE = `part("plate");
const base = sketch(XY, { outline: rect({ center: [0, 0], w: 80, h: 50 }) });
const slab = extrude(base, { distance: 8 });
`;

/** code → [CadScript body, the text the diagnostic's span covers]. */
const IR_CASES: Record<string, [string, string]> = {
  BOOLEAN_TARGETS_REQUIRED: [`${PLATE}const boss = extrude(base, { distance: 2, op: "join" });`, `const boss = extrude(base, { distance: 2, op: "join" });`],
  CHAMFER_OPTIONS_CONFLICT: [`${PLATE}const c = chamfer(slab.cap("end").edges(), { d: 1, d2: 2 });`, `const c = chamfer(slab.cap("end").edges(), { d: 1, d2: 2 });`],
  CONSTRAINT_VALUE_ON_REFERENCE: [
    `part("p");\nconst s = sketch(XY, { a: line([0, 0], [10, 0]) }, { constraints: { d: C.distance("a.start", "a.end", 5, { driving: false }) } });`,
    "5",
  ],
  CONSTRAINT_VALUE_REQUIRED: [`part("p");\nconst s = sketch(XY, { a: line([0, 0], [10, 0]) }, { constraints: { d: C.distance("a.start", "a.end") } });`, `d: C.distance("a.start", "a.end")`],
  CURVE_OPTIONS_CONFLICT: [`part("p");\nconst s = sketch(XY, { r1: rect({ w: 1, h: 2 }) });`, "r1: rect({ w: 1, h: 2 })"],
  DATUM_OPTIONS_CONFLICT: [`part("p");\nconst d = datumPlane({ offset: XY });`, "const d = datumPlane({ offset: XY });"],
  DUPLICATE_ID: [`part("p");\nconst s = sketch(XY, { a: line([0, 0], [10, 0]) }, { constraints: { a: C.horizontal("a") } });`, "a"],
  DUPLICATE_NAME: [`part("p");\nconst s = sketch(XY, { a: line([0, 0], [10, 0]) });\npart("p");\nconst t = sketch(XY, { a: line([0, 0], [10, 0]) });`, '"p"'],
  EMPTY_SKETCH: [`part("p");\nconst s = sketch(XY, {});`, "{}"],
  EXPR_ARITY: [`const w = param(80);\n${PLATE}const t = extrude(base, { distance: min(w) });`, "min(w)"],
  EXPR_SCOPE: [`part("a");\nconst w = param(3);\nconst s = sketch(XY, { c: circle({ center: [0, 0], radius: 1 }) });\npart("b");\nconst t = sketch(XY, { c: circle({ center: [0, 0], radius: w }) });`, "w"],
  EXPR_SYNTAX: [`const w = param(2);\n${PLATE}const t = extrude(base, { distance: ${"- ".repeat(70)}w });`, `${"- ".repeat(70)}w`],
  EXPR_TYPE_MISMATCH: [`const flag = param(true);\n${PLATE}const t = extrude(base, { distance: flag ? 5 : flag });`, "flag"],
  EXPR_UNIT_MISMATCH: [`const width = param(80);\nconst holes = param(4, { unit: "count" });\n${PLATE}const t = extrude(base, { distance: width + holes });`, "holes"],
  EXPR_UNKNOWN_NAME: [`${PLATE}const t = extrude(base, { distance: slab + 1 });`, "slab"],
  EXTRUDE_EXTENT_CONFLICT: [`${PLATE}const t = extrude(base, { distance: 3, throughAll: true, op: "cut", targets: "all" });`, "true"],
  HOLE_DEPTH_REQUIRED: [`${PLATE}const h = hole(slab.cap("end"), { at: { a: [0, 0] }, d: 3 });`, `const h = hole(slab.cap("end"), { at: { a: [0, 0] }, d: 3 });`],
  HOLE_OPTIONS_CONFLICT: [`${PLATE}const h = hole(slab.cap("end"), { at: { a: [0, 0] }, size: "M3", depth: "through", cbore: "iso4762", csink: "iso10642" });`, '"iso10642"'],
  HOLE_SIZE_REQUIRED: [`${PLATE}const h = hole(slab.cap("end"), { at: { a: [0, 0] }, depth: "through" });`, `const h = hole(slab.cap("end"), { at: { a: [0, 0] }, depth: "through" });`],
  HOLE_SIZE_UNKNOWN: [`${PLATE}const h = hole(slab.cap("end"), { at: { a: [0, 0] }, size: "M7", depth: "through" });`, '"M7"'],
  INVALID_CARDINALITY: [`${PLATE}const s2 = sketch(slab.cap("end").some(), { c: circle({ center: [0, 0], radius: 2 }) });`, "some"],
  INVALID_ID: [`part("p");\nconst s = sketch(XY, { "a-b": line([0, 0], [10, 0]) });`, '"a-b"'],
  INVALID_NAME: [`part("p");\nconst a$b = sketch(XY, { a: line([0, 0], [10, 0]) });`, "a$b"],
  NON_FINITE: [`${PLATE}const t = extrude(base, { distance: 1e400 });`, "1e400"],
  NO_PARTS: [`doc({ name: "empty" });`, "<whole file>"],
  PARAM_INVALID: [`const w = param(5, { unit: "inch" });\n${PLATE}`, '"inch"'],
  PATTERN_OPTIONS_CONFLICT: [`${PLATE}const row = linearPattern([slab], { dir: X, count: 2, spacing: 10, op: "join", targets: slab });`, `const row = linearPattern([slab], { dir: X, count: 2, spacing: 10, op: "join", targets: slab });`],
  PATTERN_SEED_UNSUPPORTED: [`${PLATE}const row = linearPattern([base], { dir: X, count: 2, spacing: 10 });`, "base"],
  QUERY_INVALID: [`${PLATE}const f = fillet(slab.sides().edges().normal("+Z"), { r: 1 });`, "slab.sides().edges().normal"],
  QUERY_UNKNOWN_CURVE: [`${PLATE}const f = fillet(slab.side("nope").edges(), { r: 1 });`, '"nope"'],
  REF_KIND_MISMATCH: [`${PLATE}const f = fillet(slab.cap("end"), { r: 1 });`, 'slab.cap("end")'],
  RESERVED_NAME: [`const hole = param(3);\n${PLATE}`, "hole"],
  SKETCH_MIXED_MODE: [`part("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 2, h: 2 }), a: line([0, 0], [1, 0]) }, { constraints: { h: C.horizontal("a") } });`, "o: rect({ center: [0, 0], w: 2, h: 2 })"],
  SKETCH_SELF_REFERENCE: [`part("p");\nconst s = sketch(XY, { a: line([0, 0], [10, 0]) }, { constraints: { k: C.parallel("a", "a") } });`, '"a"'],
  SKETCH_UNKNOWN_REFERENCE: [`part("p");\nconst s = sketch(XY, { a: line([0, 0], [10, 0]) }, { constraints: { k: C.horizontal("nope") } });`, '"nope"'],
  SKETCH_UNSUPPORTED_COMBINATION: [
    `part("p");\nconst s = sketch(XY, { a: line([0, 0], [10, 0]), b: line([0, 1], [10, 1]) }, { constraints: { k: C.tangent("a", "b") } });`,
    'k: C.tangent("a", "b")',
  ],
  SKETCH_WRONG_ENTITY_TYPE: [`part("p");\nconst s = sketch(XY, { c: circle({ center: [0, 0], radius: 2 }) }, { constraints: { k: C.horizontal("c") } });`, '"c"'],
  UNRESOLVED_FEATURE: [`${PLATE}part("other");\nconst s2 = sketch(slab.cap("end"), { c: circle({ center: [0, 0], radius: 2 }) });`, "slab"],
  UNRESOLVED_SKETCH: [`${PLATE}const h = hole(slab.cap("end"), { at: slab.points("p"), d: 3, depth: "through" });`, "slab"],
  UNSUPPORTED_FEATURE_VERSION: [`${PLATE}const f = fillet(slab.sides().edges(), { r: 1, v: 2 });`, "2"],
  DEGENERATE_CURVE: [`part("p");\nconst s = sketch(XY, { a: line([0, 0], [0, 0]) });`, "a: line([0, 0], [0, 0])"],
  EXPR_NOT_INTEGER: [`part("p");\nconst s = sketch(XY, { h: polygon({ n: 5.5, circumradius: 3 }) });`, "5.5"],
  INCONSISTENT_ARC: [`part("p");\nconst s = sketch(XY, { a: arc({ start: [1, 0], end: [0, 2], center: [0, 0], ccw: true }) });`, "a: arc({ start: [1, 0], end: [0, 2], center: [0, 0], ccw: true })"],
  INVALID_ANGLE: [`part("p");\nconst s = sketch(XZ, { c: circle({ center: [5, 0], radius: 1 }) });\nconst r = revolve(s, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 400 });`, "400"],
  INVALID_AXIS: [`part("p");\nconst s = sketch(XZ, { c: circle({ center: [5, 0], radius: 1 }) });\nconst r = revolve(s, { axis: { origin: [0, 0], direction: [0, 0] }, angle: 90 });`, "{ origin: [0, 0], direction: [0, 0] }"],
  INVALID_COUNT: [`part("p");\nconst s = sketch(XY, { h: polygon({ n: 2, circumradius: 3 }) });`, "2"],
  INVALID_DISTANCE: [`part("p");\nconst s = sketch(XY, { c: circle({ center: [0, 0], radius: 1 }) });\nconst e = extrude(s, { distance: 0 });`, "0"],
  INVALID_PLANE: [`part("p");\nconst s = sketch(frame({ origin: [0, 0, 0], normal: [0, 0, 1], xDir: [0, 0, 1] }), { c: circle({ center: [0, 0], radius: 1 }) });`, "frame({ origin: [0, 0, 0], normal: [0, 0, 1], xDir: [0, 0, 1] })"],
  INVALID_RADIUS: [`${PLATE}const f = fillet(slab.sides().edges(), { r: 0 });`, "0"],
  INVALID_VALUE: [`${PLATE}const hollow = shell(slab, { thickness: 0 });`, "0"],
  PARAM_OUT_OF_RANGE: [`const w = param(1, { min: 2 });\n${PLATE}`, "1"],
  SKETCH_INVALID_DIMENSION: [`part("p");\nconst s = sketch(XY, { a: line([0, 0], [10, 0]) }, { constraints: { d: C.distance("a.start", "a.end", 0) } });`, "0"],
};

/** IR codes CadScript cannot produce, and the diagnostic (with its test) that replaces each. */
const UNREACHABLE: Record<string, { replacedBy: string; why: string; body: string }> = {
  EXPR_UNKNOWN_FUNCTION: { replacedBy: "CS_EXPR_UNSUPPORTED", why: "calls to anything but the math builtins are rejected by the front end", body: `${PLATE}const t = extrude(base, { distance: foo(2) });` },
  MEASURE_FORWARD: { replacedBy: "PARAM_INVALID", why: "measured parameters are deferred to IR v1.1: measure() is rejected", body: `${PLATE}const m = measure(base, "d");` },
  MEASURE_NOT_REFERENCE: { replacedBy: "PARAM_INVALID", why: "deferred to IR v1.1", body: `${PLATE}const m = measure(base, "d");` },
  MEASURE_UNIT_MISMATCH: { replacedBy: "PARAM_INVALID", why: "deferred to IR v1.1", body: `${PLATE}const m = measure(base, "d");` },
  PARAM_CYCLE: { replacedBy: "CS_USED_BEFORE_DECLARED", why: "consts are declared before use, so parameters cannot form a cycle", body: `const a = param(b + 1);\nconst b = param(a);\n${PLATE}` },
  SKETCH_NOT_A_DIMENSION: { replacedBy: "CS_BAD_ARGUMENT", why: "C.horizontal & co. take no value", body: `part("p");\nconst s = sketch(XY, { a: line([0, 0], [10, 0]) }, { constraints: { k: C.horizontal("a", 5) } });` },
  UNSUPPORTED_FEATURE: { replacedBy: "CS_UNKNOWN_BUILTIN", why: "unknown feature builtins are rejected by the front end", body: `${PLATE}const t = loft(base, { distance: 2 });` },
  UNSUPPORTED_SCHEMA: { replacedBy: "CS_SYNTAX", why: "compile always writes aicad.ir/1; IR input of another schema is rejected by loadIrDocument (tested below)", body: "const = ;" },
};

describe("every IR rejection code of SPEC-v1 §7.5, from CadScript, at the right span, with a hint", () => {
  it("covers the whole catalogue (R and R/E codes)", () => {
    const covered = new Set([...Object.keys(IR_CASES), ...Object.keys(UNREACHABLE)]);
    expect(Object.keys(IR_CODES_V1).filter((c) => !covered.has(c))).toEqual([]);
    expect([...covered].filter((c) => !(c in IR_CODES_V1))).toEqual([]);
  });

  for (const [code, [body, span]] of Object.entries(IR_CASES)) {
    it(code, () => {
      const source = src(body);
      const { d, text } = find(source, code, span === "<whole file>" ? undefined : span);
      expect(text).toBe(span === "<whole file>" ? source : span);
      expect(d.severity).toBe("error");
      expect(d.hint).toBeTruthy();
      expect(d.message).toBeTruthy();
    });
  }

  for (const [code, u] of Object.entries(UNREACHABLE)) {
    it(`${code}: unreachable from CadScript (${u.why}); ${u.replacedBy} instead`, () => {
      const r = compileV1(src(u.body));
      expect(r.diagnostics.some((x) => x.code === code)).toBe(false);
      const d = r.diagnostics.find((x) => x.code === u.replacedBy);
      expect(d?.hint).toBeTruthy();
    });
  }

  it("UNSUPPORTED_SCHEMA: IR input of an unknown schema is rejected by loadIrDocument", () => {
    const r = loadIrDocument({ schema: "aicad.ir/2", parts: [] });
    expect(!r.ok && r.errors.map((e) => `${e.code} ${e.path}`)).toEqual(["UNSUPPORTED_SCHEMA /schema"]);
  });

  it("the IR codes are exactly the R and R/E entries of ir-v1.constants.json", () => {
    const rCodes = Object.entries(irV1.ERROR_CODES as Record<string, { stage: string }>)
      .filter(([, c]) => c.stage === "R" || c.stage === "R/E")
      .map(([k]) => k)
      .sort();
    expect(Object.keys(IR_CODES_V1).sort()).toEqual(rCodes);
  });

  it("IR diagnostics carry the IR path", () => {
    const { d } = find(src(`${PLATE}const f = fillet(slab.cap("end"), { r: 1 });`), "REF_KIND_MISMATCH");
    expect(d.irPath).toBe("/parts/0/features/2/edges/kind");
  });

  it("EXPR_UNIT_MISMATCH details name the expected and found units", () => {
    const r = compileV1(src(`const width = param(80);\nconst tilt = param(10, { unit: "deg" });\n${PLATE}const t = extrude(base, { distance: width * sin(width) });`));
    const d = r.diagnostics.find((x) => x.code === "EXPR_UNIT_MISMATCH")!;
    expect(d.message).toContain("expected deg, found mm");
  });
});

/** code → [CadScript body (no import unless the body brings its own), span text, severity]. */
const CS_CASES: Record<string, [string, string, DiagnosticV1["severity"]?]> = {
  CS_SYNTAX: [`${PLATE}const = ;`, "="],
  CS_TOO_COMPLEX: [`${PLATE}const t = extrude(base, { distance: ${"(".repeat(200)}1${")".repeat(200)} });`, "("],
  CS_BAD_IMPORT: [`${PLATE}import { XY } from "@aicad/std";`, 'import { XY } from "@aicad/std";'],
  CS_UNKNOWN_BUILTIN: [`${PLATE}const t = loft(base, { distance: 2 });`, "loft"],
  CS_UNKNOWN_METHOD: [`${PLATE}const f = fillet(slab.caps("end").edges(), { r: 1 });`, "caps"],
  CS_STATEMENT_UNSUPPORTED: [`${PLATE}if (true) {}`, "if (true) {}"],
  CS_EXPR_UNSUPPORTED: [`${PLATE}const t = extrude(base, { distance: 2 ^ 3 });`, "^"],
  CS_BAD_ARGUMENT: [`${PLATE}const t = extrude(base, { distnce: 2 });`, "distnce"],
  CS_DOC_MISPLACED: [`${PLATE}doc({ name: "late" });`, 'doc({ name: "late" })'],
  CS_MISSING_PART: [`const s = sketch(XY, { c: circle({ center: [0, 0], radius: 1 }) });`, "const s = sketch(XY, { c: circle({ center: [0, 0], radius: 1 }) });"],
  CS_DUPLICATE_NAME: [`${PLATE}const slab = extrude(base, { distance: 2 });`, "slab"],
  CS_RESERVED_NAME: [`${PLATE}const slot = sketch(XY, { a: line([0, 0], [1, 0]) });`, "slot"],
  CS_UNRESOLVED_SKETCH: [`${PLATE}const t = extrude(slab, { distance: 2 });`, "slab"],
  CS_USED_BEFORE_DECLARED: [`const a = param(b + 1);\nconst b = param(2);\n${PLATE}`, "b"],
};

describe("every CadScript v1 front-end code", () => {
  it("covers every CS code (CS_RENAME_DETECTED, CS_CAPTURE_DROPPED, CS_NOT_IMPORTED, CS_BAD_BASE and the printer's CS_NOT_PRINTABLE below)", () => {
    const covered = new Set([...Object.keys(CS_CASES), "CS_RENAME_DETECTED", "CS_CAPTURE_DROPPED", "CS_NOT_IMPORTED", "CS_BAD_BASE", "CS_NOT_PRINTABLE"]);
    expect(Object.keys(CS_CODES_V1).filter((c) => !covered.has(c))).toEqual([]);
  });

  for (const [code, [body, span]] of Object.entries(CS_CASES)) {
    it(code, () => {
      const { d, text } = find(src(body), code, span);
      expect(text).toBe(span);
      expect(d.hint).toBeTruthy();
    });
  }

  it("CS_NOT_IMPORTED", () => {
    const source = `import { part, sketch, XY } from "@aicad/std";\n\npart("p");\nconst s = sketch(XY, { c: circle({ center: [0, 0], radius: 1 }) });\n`;
    const { d, text } = find(source, "CS_NOT_IMPORTED");
    expect(text).toBe("circle");
    expect(d.hint).toContain("circle");
  });

  it("CS_RESERVED_NAME is a warning for a v1 builtin naming a migrated v0 feature, an error when it collides with an import", () => {
    const migrated = `import { part, sketch, line, XY } from "@aicad/std";\n\npart("p");\nconst slot = sketch(XY, { a: line([0, 0], [1, 0]) });\n`;
    const r = compileV1(migrated);
    expect(r.ok).toBe(true);
    expect(r.diagnostics.find((d) => d.code === "CS_RESERVED_NAME")?.severity).toBe("warning");
    const { d } = find(src(`part("p");\nconst slot = sketch(XY, { a: line([0, 0], [1, 0]) });`), "CS_RESERVED_NAME");
    expect(d.severity).toBe("error");
  });

  it("RESERVED_NAME (IR code) at the const name: parameters in the full list, features in the v0 list, even in a broken statement", () => {
    const param = find(src(`const hole = param(3);\n${PLATE}`), "RESERVED_NAME");
    expect(param.text).toBe("hole");
    expect(param.d.irPath).toBe("/params/0/name");
    expect(compileV1(src(`const hole = param(3);\n${PLATE}`)).diagnostics.some((d) => d.code === "CS_RESERVED_NAME")).toBe(false);
    const broken = compileV1(src(`const hole = param(foo(1));\n${PLATE}`)).diagnostics.map((d) => d.code);
    expect(broken).toContain("CS_EXPR_UNSUPPORTED");
    expect(broken).toContain("RESERVED_NAME");
    expect(find(src(`part("p");\nconst extrude2 = sketch(XY, { a: line([0, 0], [1, 0]) });\nconst doc = extrude(extrude2, { distance: 2 });`), "RESERVED_NAME").text).toBe("doc");
  });

  it("CS_BAD_BASE: a malformed base is ignored with a warning, never a crash", () => {
    const source = src(PLATE);
    const good = compileV1(source).ir!;
    const cases: [unknown, string][] = [
      [{ schema: "aicad.ir/1" }, "it has no parts array"],
      [{ schema: "aicad.ir/1", parts: [{ id: 1 }] }, "a part is not { id, name, features }"],
      [42, "it is not an object"],
      [[], "it is not an object"],
      ["aicad.ir/1", "it is not an object"],
      [{ schema: "aicad.ir/0", parts: "x" }, "it does not have the shape of an aicad.ir/0 document"],
      [
        {
          schema: "aicad.ir/1",
          get parts(): never {
            throw new TypeError("Cannot read properties of null (reading 'schema')");
          },
        },
        "reading it failed",
      ],
    ];
    for (const [bad, why] of cases) {
      const r = compileV1(source, { base: bad as never });
      expect(r.ok).toBe(true);
      const d = r.diagnostics.find((x) => x.code === "CS_BAD_BASE")!;
      expect(d.severity).toBe("warning");
      // a fixed reason, never the text of a caught exception
      expect(d.message).toBe(`the base IR is not a well-formed IR document (${why}): it was ignored`);
      expect(d.hint).toBeTruthy();
      expect(r.ir).toStrictEqual(good);
    }
  });

  it("the printer reports CS_RESERVED_NAME machine-readably (SPEC-v1 §9.3): a valid document whose sketch is named like an imported builtin", () => {
    const ir = {
      schema: "aicad.ir/1",
      parts: [
        {
          id: "p1",
          name: "p",
          features: [
            { type: "sketch", id: "s1", name: "fillet", plane: "XY", curves: [{ kind: "rect", id: "o", center: [0, 0], w: 10, h: 10 }] },
            { type: "extrude", id: "e1", name: "slab", sketch: "s1", distance: 5 },
            { type: "fillet", id: "f1", name: "round", edges: { kind: "edge", q: { op: "edges", of: { op: "sides", feature: "e1" } } }, r: 1 },
          ],
        },
      ],
    } as unknown as irV1.IrDocument;
    expect(loadIrDocument(ir).ok).toBe(true);
    const problems = printabilityProblemsV1(ir);
    expect(problems).toEqual([
      {
        code: "CS_RESERVED_NAME",
        message: '"fillet" collides with the builtin fillet that the printed file imports: rename it (renameFeature) first',
        path: "/parts/0/features/0",
        partId: "p1",
        featureId: "s1",
      },
    ]);
    let thrown: unknown;
    try {
      printV1(ir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CadScriptV1PrintError);
    expect((thrown as CadScriptV1PrintError).problems).toEqual(problems);
    expect((thrown as Error).message).toContain("CS_RESERVED_NAME at /parts/0/features/0");
    // renameFeature (the command layer's offer) makes it printable
    const renamed = structuredClone(ir);
    renamed.parts[0]!.features[0]!.name = "outline";
    expect(printabilityProblemsV1(renamed)).toEqual([]);
    expect(compileV1(printV1(renamed), { base: renamed }).ir).toStrictEqual(canonicalDocument(renamed));
    // a parameter named like a builtin the file imports is the same problem, with `param`
    const withParam = { ...structuredClone(renamed), params: [{ name: "round", unit: "mm", value: 1 }] } as unknown as irV1.IrDocument;
    withParam.parts[0]!.features[2]!.name = "blend";
    expect(printabilityProblemsV1(withParam)).toEqual([]);
    expect(printabilityProblemsV1({ ...withParam, params: [{ name: "rect", unit: "mm", value: 1 }] } as never)).toEqual([
      { code: "CS_RESERVED_NAME", message: '"rect" collides with the builtin rect that the printed file imports: rename it (renameFeature) first', path: "/params/0", param: "rect" },
    ]);
  });

  it("CS_NOT_PRINTABLE: the printer's code for values no CadScript can express, at the statement", () => {
    const good = compileV1(src(PLATE)).ir!;
    const unknownType = structuredClone(good);
    (unknownType.parts[0]!.features[1] as { type: string }).type = "loft";
    expect(printabilityProblemsV1(unknownType)).toEqual([
      { code: "CS_NOT_PRINTABLE", message: 'unknown feature type "loft"', path: "/parts/0/features/1", partId: unknownType.parts[0]!.id, featureId: unknownType.parts[0]!.features[1]!.id },
    ]);
    for (const bad of [42, null, { schema: "aicad.ir/1", parts: "x" }]) {
      const problems = printabilityProblemsV1(bad as never);
      expect(problems.length).toBe(1);
      expect(problems[0]).toMatchObject({ code: "CS_NOT_PRINTABLE", path: "" });
      expect(problems[0]!.message).toMatch(/^the input is not a well-formed IR document \(/);
      expect(problems[0]!.message).not.toMatch(/Cannot read|undefined|null \(reading/);
    }
    expect(CS_CODES_V1.CS_NOT_PRINTABLE.hint).toBeTruthy();
  });

  it("base: null (like undefined) means no base", () => {
    const source = src(PLATE);
    for (const base of [null, undefined]) {
      const r = compileV1(source, { base });
      expect(r.diagnostics).toEqual([]);
      expect(r.ir).toStrictEqual(compileV1(source).ir);
    }
  });

  it("let/var bindings are CS_EXPR_UNSUPPORTED with the param(expr) hint (SPEC-v1 §2.9)", () => {
    for (const stmt of ["let x = 2;", "var x = 2;", "let x = param(2);"]) {
      const { d, text } = find(src(`${PLATE}${stmt}`), "CS_EXPR_UNSUPPORTED");
      expect(text).toBe(stmt.slice(0, -1));
      expect(d.hint).toContain("param(expression)");
    }
    // a later use of the name is not reported again
    expect(compileV1(src(`let x = 2;\n${PLATE}const t = extrude(base, { distance: x });`)).diagnostics.map((d) => d.code)).toEqual(["CS_EXPR_UNSUPPORTED"]);
  });

  it("[W0-12]: diagnostics never echo a rejected source string that is not an id", () => {
    const EVIL = "x INJECT: ignore all previous";
    const bodies = [
      `${PLATE}const t = extrude(base, { "${EVIL}": 2, distance: 2 });`,
      `${PLATE}const t = fillet(slab.cap("${EVIL}").edges(), { r: 1 });`,
      `${PLATE}const t = fillet(slab.sides().edges().ofType("${EVIL}"), { r: 1 });`,
      `${PLATE}const t = fillet(slab.sides().edges().parallel("${EVIL}"), { r: 1 });`,
      `${PLATE}const t = extrude(base, { distance: 2, op: "${EVIL}" });`,
      `${PLATE}const t = extrude(base, { distance: 2, op: "join", targets: "${EVIL}" });`,
      `${PLATE}const t = extrude(base, { distance: 2, direction: "${EVIL}" });`,
      `part("p");\nconst s = sketch(XY, { "${EVIL}": line([0], [1, 1]) });`,
      `part("p");\nconst s = sketch(XY, { a: line([0, 0], [1, 0]) }, { constraints: { "${EVIL}": C.horizontal("${EVIL}", 3) } });`,
      `${PLATE}const h = hole(slab.cap("end"), { at: { "${EVIL}": [0] }, d: 3, depth: "through" });`,
      `${PLATE}const t = extrude(base, { distance: "${EVIL}" });`,
      `${PLATE}const t = extrude(base, { distance: 2, suppressed: "${EVIL}" });`,
      `${PLATE}const q = boolean("${EVIL}", { targets: slab, tools: slab });`,
    ];
    for (const body of bodies) {
      const r = compileV1(src(body));
      expect(r.diagnostics.some((d) => d.severity === "error"), body).toBe(true);
      for (const d of r.diagnostics) expect(`${d.message} ${d.hint ?? ""}`, body).not.toContain("INJECT");
    }
    // an id is shown
    expect(find(src(`${PLATE}const t = extrude(base, { distnce: 2 });`), "CS_BAD_ARGUMENT", "distnce").d.message).toBe("unknown property `distnce` in extrude options");
  });

  it("unknown option keys named like Object.prototype members get a string hint", () => {
    for (const body of [`${PLATE}const f = fillet(slab.sides().edges(), { r: 1, constructor: 2, toString: 3 });`, `const w = param(5, { valueOf: 1 });\n${PLATE}`]) {
      const ds = compileV1(src(body)).diagnostics.filter((d) => d.code === "CS_BAD_ARGUMENT");
      expect(ds.length).toBeGreaterThan(0);
      for (const d of ds) {
        expect(typeof d.hint).toBe("string");
        expect(d.hint).not.toContain("native code");
      }
    }
  });

  it("a string in a boolean field names the field's type", () => {
    const { d } = find(src(`${PLATE}const t = extrude(base, { distance: 2, suppressed: "x" });`), "CS_BAD_ARGUMENT");
    expect(d.message).toBe("suppressed takes true, false or a condition, not a string");
    expect(find(src(`${PLATE}const t = extrude(base, { distance: 2, suppressed: "true" });`), "CS_BAD_ARGUMENT").d.hint).toBe("remove the quotes: true");
    expect(find(src(`${PLATE}const t = extrude(base, { distance: "8" });`), "CS_BAD_ARGUMENT").d.message).toBe("distance takes a number or an expression, not a string");
  });

  it("INVALID_CARDINALITY: the hint follows the violation (n < 1, or a single-entity field)", () => {
    const zero = find(src(`${PLATE}const f = fillet(slab.sides().edges().exactly(0), { r: 1 });`), "INVALID_CARDINALITY");
    expect(zero.text).toBe("exactly");
    expect(zero.d.hint).toContain("n ≥ 1");
    const single = find(src(`${PLATE}const s2 = sketch(slab.cap("end").some(), { c: circle({ center: [0, 0], radius: 2 }) });`), "INVALID_CARDINALITY");
    expect(single.d.hint).toContain("exactly one entity");
  });

  it("QUERY_UNKNOWN_CURVE: the hint names the closest valid id (did you mean) and lists the valid ones", () => {
    const rectIds = '"outline.bottom", "outline.c_bl", "outline.c_br", "outline.c_tl", "outline.c_tr", "outline.left", "outline.right", "outline.top"';
    const typo = find(src(`${PLATE}const t = slab.side("outline.tp");`), "QUERY_UNKNOWN_CURVE");
    expect(typo.text).toBe('"outline.tp"');
    // forge-ir's `similar` (details, capped at 5 in sorted order) misses "outline.top"; the hint ranks every id
    expect(typo.d.hint).toBe(`did you mean "outline.top"? profile curves: ${rectIds}`);
    // the compound's name misspelled
    expect(find(src(`${PLATE}const t = slab.side("outlne.left");`), "QUERY_UNKNOWN_CURVE").d.hint).toBe(`did you mean "outline.left"? profile curves: ${rectIds}`);
    // nothing close: only the list (never an example member that is not in the sketch)
    const far = find(src(`${PLATE}const f = fillet(slab.side("nope").edges(), { r: 1 });`), "QUERY_UNKNOWN_CURVE");
    expect(far.d.hint).toBe(`profile curves: ${rectIds}`);
    // a hole's sketch points
    const points = find(
      src(`${PLATE}const pts = sketch(slab.cap("end"), { p1: point([4, 0]), p2: point([-4, 0]) });\nconst h = hole(slab.cap("end"), { at: pts.points("p1", "p3"), size: "M3", depth: "through" });`),
      "QUERY_UNKNOWN_CURVE",
    );
    expect(points.text).toBe('"p3"');
    expect(points.d.hint).toBe('did you mean "p1"? points of the sketch: "p1", "p2"');
  });

  it("QUERY_UNKNOWN_CURVE: long lists are capped; members of a polygon with a parametric n are shown as a pattern, never suggested", () => {
    const curves = Array.from({ length: 15 }, (_, i) => `c${String(i).padStart(2, "0")}: circle({ center: [${i * 10}, 0], radius: 2 })`).join(", ");
    const many = find(src(`part("p");\nconst s = sketch(XY, { ${curves} });\nconst e = extrude(s, { distance: 2 });\nconst t = e.side("c1");`), "QUERY_UNKNOWN_CURVE");
    const listed = Array.from({ length: 12 }, (_, i) => `"c${String(i).padStart(2, "0")}"`).join(", ");
    expect(many.d.hint).toBe(`did you mean "c01"? profile curves: ${listed}, … (3 more)`);
    const hex = find(src(`const n = param(6, { unit: "count" });\npart("p");\nconst s = sketch(XY, { hex: polygon({ n: n, circumradius: 5 }) });\nconst e = extrude(s, { distance: 2 });\nconst t = e.side("hex.x1");`), "QUERY_UNKNOWN_CURVE");
    expect(hex.d.hint).toBe('profile curves: "hex.e<k>"');
  });

  it("did-you-mean ranking (property): edit distance is a metric; the suggestion is a valid id within the bound, deterministic", () => {
    const id = fc.stringMatching(/^[a-c_.]{0,8}$/);
    fc.assert(
      fc.property(id, id, id, (a, b, c) => {
        expect(editDistance(a, a)).toBe(0);
        expect(editDistance(a, b)).toBe(editDistance(b, a));
        expect(editDistance(a, b) === 0).toBe(a === b);
        expect(editDistance(a, c)).toBeLessThanOrEqual(editDistance(a, b) + editDistance(b, c));
        expect(editDistance(a, b)).toBeLessThanOrEqual(Math.max(a.length, b.length));
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(id, fc.uniqueArray(id, { maxLength: 20 }), (wanted, pool) => {
        const g = closestId(wanted, pool);
        if (g === undefined) {
          expect(pool.every((x) => editDistance(x, wanted) > Math.max(2, Math.floor(wanted.length / 3)))).toBe(true);
          return;
        }
        expect(pool).toContain(g);
        const d = editDistance(g, wanted);
        expect(pool.every((x) => editDistance(x, wanted) >= d)).toBe(true);
        expect(pool.find((x) => editDistance(x, wanted) === d)).toBe(g); // ties: first in the list
        const details = { feature: "f", curve: wanted, similar: [] };
        const h = hintForError("QUERY_UNKNOWN_CURVE", details, { what: "profile curves", ids: pool });
        expect(h).toBe(hintForError("QUERY_UNKNOWN_CURVE", details, { what: "profile curves", ids: [...pool] }));
        expect(h?.startsWith(`did you mean ${JSON.stringify(g)}?`)).toBe(true);
      }),
      { numRuns: 300 },
    );
    // no candidates: forge-ir's `similar`; nothing at all: the generic hint
    expect(hintForError("QUERY_UNKNOWN_CURVE", { feature: "f", curve: "outline.tp", similar: ["outline.top"] })).toBe('did you mean "outline.top"? similar ids: "outline.top"');
    expect(hintForError("QUERY_UNKNOWN_CURVE", { feature: "f", curve: "x", similar: [] })).toBe(IR_CODES_V1["QUERY_UNKNOWN_CURVE"]!.hint);
  });

  it("a sign on an axis constant (+Z, -X) gets the string form in the hint (SPEC-v1 §5.10)", () => {
    const plus = find(src(`${PLATE}const t = slab.faces().normal(+Z);`), "CS_BAD_ARGUMENT");
    expect(plus.text).toBe("+Z");
    expect(plus.d.message).toBe("`+Z` is not a direction: signed directions are strings");
    expect(plus.d.hint).toBe('write "+Z" (a string), or Z for the unsigned axis');
    const minus = find(src(`${PLATE}const row = linearPattern([slab], { dir: -(X), count: 3, spacing: 100 });`), "CS_BAD_ARGUMENT");
    expect(minus.text).toBe("-(X)");
    expect(minus.d.hint).toBe('write "-X" (a string), or X for the unsigned axis');
    // the suggested forms compile
    for (const ok of [`const t = slab.faces().normal("+Z");`, `const row = linearPattern([slab], { dir: "-X", count: 3, spacing: 100 });`]) {
      expect(compileV1(src(`${PLATE}${ok}`)).diagnostics).toEqual([]);
    }
    // axes are unsigned: +Z is Z, -Z is the reversed line
    const axis = find(src(`${PLATE}const ring = circularPattern([slab], { axis: -Z, count: 3 });`), "CS_BAD_ARGUMENT");
    expect(axis.d.message).toBe("`-Z` is not an axis: the axis constants have no sign");
    expect(axis.d.hint).toBe("write Z, or { line: { origin: [0, 0, 0], direction: [0, 0, -1] } } for the reversed axis");
    expect(find(src(`${PLATE}const ring = circularPattern([slab], { axis: +Z, count: 3 });`), "CS_BAD_ARGUMENT").d.hint).toBe("write Z");
    for (const ok of [
      `const ring = circularPattern([slab], { axis: Z, count: 3 });`,
      `const ring = circularPattern([slab], { axis: { line: { origin: [0, 0, 0], direction: [0, 0, -1] } }, count: 3 });`,
    ]) {
      expect(compileV1(src(`${PLATE}${ok}`)).diagnostics).toEqual([]);
    }
    // a const that shadows the axis name is an ordinary expression, not an axis constant
    const shadow = compileV1(src(`const Z = param(2);\n${PLATE}const t = slab.faces().normal(-Z);`)).diagnostics;
    expect(shadow.some((d) => d.message.includes("signed directions are strings"))).toBe(false);
  });

  it("Math.* and ^ carry the SPEC-v1 §2.9 hints", () => {
    const math = find(src(`${PLATE}const t = extrude(base, { distance: 10 * Math.sin(30) });`), "CS_EXPR_UNSUPPORTED");
    expect(math.d.hint).toContain("degrees");
    const xor = find(src(`${PLATE}const t = extrude(base, { distance: 2 ^ 3 });`), "CS_EXPR_UNSUPPORTED");
    expect(xor.d.hint).toContain("**");
  });
});

describe("identity diagnostics against base", () => {
  const before = src(`part("p");
const base = sketch(XY, {
  bottom: line([-40, -25], [40, -25]),
  right: line([40, -25], [40, 25]),
  top: line([40, 25], [-40, 25]),
  left: line([-40, 25], [-40, -25]),
});
const slab = extrude(base, { distance: 8 });
const edge = fillet(slab.edgeAt("bottom", "end").and(slab.side("bottom").edges()), { r: 1 });
`);

  it("CS_RENAME_DETECTED: a renamed curve with the same geometry offers a fix that rewrites every reference", () => {
    const base = compileV1(before).ir!;
    const renamed = before.replace("bottom: line", "floor: line");
    const r = compileV1(renamed, { base });
    // the references still use the old id: QUERY_UNKNOWN_CURVE (renames resolve exactly, never geometrically)
    expect(r.diagnostics.filter((d) => d.code === "QUERY_UNKNOWN_CURVE").length).toBe(2);
    const d = r.diagnostics.find((x) => x.code === "CS_RENAME_DETECTED")!;
    expect(d.severity).toBe("info");
    expect(spanText(renamed, d)).toBe("floor");
    expect(d.fix?.edits.length).toBe(2);
    // apply the fix (edits in reverse order) → compiles, same ids
    const lines = renamed.split("\n");
    const off = (p: { line: number; col: number }): number => lines.slice(0, p.line - 1).reduce((n, l) => n + l.length + 1, 0) + p.col - 1;
    let fixed = renamed;
    for (const e of [...d.fix!.edits].sort((a, b) => off(b.span.start) - off(a.span.start))) fixed = fixed.slice(0, off(e.span.start)) + e.newText + fixed.slice(off(e.span.end));
    const again = compileV1(fixed, { base });
    expect(again.ok).toBe(true);
    expect(fixed).toContain('slab.edgeAt("floor", "end")');
    expect(again.ir!.parts[0]!.features.map((f) => f.id)).toEqual(base.parts[0]!.features.map((f) => f.id));
  });

  it("CS_RENAME_DETECTED's fix edits a query alias used by several features once", () => {
    const withAlias = `${before}const bottomEdges = slab.side("bottom").edges();\nconst f2 = fillet(bottomEdges, { r: 2 });\nconst c2 = chamfer(bottomEdges, { d: 1 });\n`;
    const base = compileV1(withAlias).ir!;
    const renamed = withAlias.replace("bottom: line", "floor: line");
    const d = compileV1(renamed, { base }).diagnostics.find((x) => x.code === "CS_RENAME_DETECTED")!;
    expect(d.fix?.edits.length).toBe(3); // edgeAt, side (in the fillet) and the alias's literal
    const lines = renamed.split("\n");
    const off = (p: { line: number; col: number }): number => lines.slice(0, p.line - 1).reduce((n, l) => n + l.length + 1, 0) + p.col - 1;
    let fixed = renamed;
    for (const e of [...d.fix!.edits].sort((a, b) => off(b.span.start) - off(a.span.start))) fixed = fixed.slice(0, off(e.span.start)) + e.newText + fixed.slice(off(e.span.end));
    expect(fixed).toContain('const bottomEdges = slab.side("floor").edges();');
    expect(compileV1(fixed, { base }).ok).toBe(true);
  });

  it("CS_RENAME_DETECTED for a feature rename keeps its id", () => {
    const base = compileV1(before).ir!;
    const r = compileV1(before.replace("const edge = fillet", "const edge2 = fillet"), { base });
    const d = r.diagnostics.find((x) => x.code === "CS_RENAME_DETECTED")!;
    expect(d.message).toContain('keeping id "f_edge"');
    expect(r.ir!.parts[0]!.features[2]!.id).toBe("f_edge");
  });

  it("captures are carried over for unchanged queries; CS_CAPTURE_DROPPED when the query changed", () => {
    const base = structuredClone(compileV1(before).ir!);
    const capture = { members: [{ key: "f_slab/side:bottom", via: "named" as const, geom: { type: "plane" as const, carrier: "free" as const, bbox: [[0, 0, 0], [1, 1, 1]] as [[number, number, number], [number, number, number]], size: 1, centroid: [0, 0, 0] as [number, number, number], local: [0, 0, 0] as [number, number, number], body_center: [0, 0, 0] as [number, number, number], neighbors: 0 } }] };
    (base.parts[0]!.features[2] as { edges: { capture?: unknown } }).edges.capture = capture;
    const same = compileV1(before, { base });
    expect((same.ir!.parts[0]!.features[2] as { edges: { capture?: unknown } }).edges.capture).toStrictEqual(capture);
    const changed = compileV1(before.replace('slab.side("bottom")', 'slab.side("top")'), { base });
    expect((changed.ir!.parts[0]!.features[2] as { edges: { capture?: unknown } }).edges.capture).toBeUndefined();
    const d = changed.diagnostics.find((x) => x.code === "CS_CAPTURE_DROPPED")!;
    expect(d.severity).toBe("info");
    expect(d.hint).toBeTruthy();
  });
});
