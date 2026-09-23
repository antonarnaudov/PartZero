/**
 * CadScript v1's nesting limits against IR v1's (review of W8a): every expression IR v1 accepts
 * (nesting up to `MAX_EXPR_DEPTH`) prints and compiles back, at the boundary and in the deepest
 * statement positions; query nesting, which IR v1 does not bound, is accepted up to forge-ir's
 * IR JSON nesting bound (`MAX_JSON_NESTING`, tighter than the v1 syntax limits for queries) and
 * reported by `printabilityProblemsV1` and `compileV1` beyond it; and the deepest accepted input still
 * compiles and type-checks with 40% of the free stack (host independence, as v0).
 */
import { describe, expect, it } from "vitest";
import type { v1 } from "@aicad/ir-types";
import { LIMITS_V1, MAX_BRACKET_DEPTH_V1, MAX_FLOW_STEPS, MAX_SYNTAX_DEPTH_V1 } from "../../src/complexity.js";
import { main } from "../../src/cli-main.js";
import { typecheck as typecheckV0 } from "../../src/typecheck.js";
import { compileV1 } from "../../src/v1/compile.js";
import { MAX_EXPR_DEPTH, parseExpr, printExpr, type Expr } from "../../src/v1/expr.js";
import { canonicalDocument, jsonNesting, MAX_JSON_NESTING, toJson } from "../../src/v1/json.js";
import { CadScriptV1PrintError, printabilityProblemsV1, printV1 } from "../../src/v1/print.js";
import { typecheckV1 } from "../../src/v1/typecheck.js";
import { loadIrText, validateV1 } from "../../src/v1/validate.js";

const w: Expr = { k: "name", name: "w" };
const flag: Expr = { k: "name", name: "flag" };
const one: Expr = { k: "num", v: 1 };

/** Length-typed expression families, `n` levels of one kind of nesting each. */
const FAMILIES: Record<string, (n: number) => Expr> = {
  "unary minus": (n) => {
    let e: Expr = w;
    for (let i = 0; i < n; i++) e = { k: "un", op: "-", e };
    return e;
  },
  "calls": (n) => {
    let e: Expr = w;
    for (let i = 0; i < n; i++) e = { k: "call", fn: "min", args: [e, one] };
    return e;
  },
  "calls over a unit literal (mm(12) at the leaf)": (n) => {
    let e: Expr = { k: "num", v: 12, unit: "mm" };
    for (let i = 0; i < n; i++) e = { k: "call", fn: "max", args: [w, e] };
    return e;
  },
  "?: in the condition (parenthesised)": (n) => {
    let c: Expr = flag;
    for (let i = 0; i < n - 1; i++) c = { k: "cond", c, t: flag, f: flag };
    return { k: "cond", c, t: w, f: w };
  },
  "?: in the else branch": (n) => {
    let e: Expr = w;
    for (let i = 0; i < n; i++) e = { k: "cond", c: flag, t: w, f: e };
    return e;
  },
  "?: in the then branch": (n) => {
    let e: Expr = w;
    for (let i = 0; i < n; i++) e = { k: "cond", c: flag, t: e, f: w };
    return e;
  },
  "^ exponents (right-associative)": (n) => {
    let e: Expr = one;
    for (let i = 0; i < n; i++) e = { k: "bin", op: "^", l: one, r: e };
    return { k: "bin", op: "*", l: w, r: e };
  },
  "^ bases (parenthesised)": (n) => {
    let e: Expr = one;
    for (let i = 0; i < n; i++) e = { k: "bin", op: "^", l: e, r: one };
    return { k: "bin", op: "*", l: w, r: e };
  },
  "-(… ^ …) (unary minus over a power)": (n) => {
    let e: Expr = one;
    for (let i = 0; i < n; i++) e = i % 2 === 0 ? { k: "un", op: "-", e } : { k: "bin", op: "^", l: one, r: e };
    return { k: "bin", op: "*", l: w, r: e };
  },
  "parenthesised right operands": (n) => {
    let e: Expr = w;
    for (let i = 0; i < n; i++) e = { k: "bin", op: "-", l: w, r: e };
    return e;
  },
};

/** The largest `n` whose canonical text parses (IR v1 accepts it), and that text. */
function boundary(build: (n: number) => Expr): { n: number; text: string } {
  let n = 1;
  while (parseExpr(printExpr(build(n + 1))).ok) n++;
  return { n, text: printExpr(build(n)) };
}

/** A document using `e` in the deepest statement positions of the printer. */
function docWith(e: string): v1.IrDocument {
  return {
    schema: "aicad.ir/1",
    params: [
      { name: "w", unit: "mm", value: 10 },
      { name: "flag", unit: "bool", value: true },
      { name: "deep", unit: "mm", value: e },
    ],
    parts: [
      {
        id: "p1",
        name: "p",
        features: [
          { type: "sketch", id: "s1", name: "base", plane: "XY", curves: [{ kind: "rect", id: "outline", center: [e, 0], w: 80, h: 50 }] },
          { type: "extrude", id: "e1", name: "slab", sketch: "s1", distance: 8 },
          {
            type: "hole",
            id: "h1",
            name: "mounts",
            on: { face: { kind: "face", q: { op: "cap", feature: "e1", end: "end" } }, origin: [e, 0, 0] },
            at: { grid: { nx: 2, ny: 2, dx: 20, dy: 20, center: [e, 1] } },
            d: 3,
            depth: "through",
          },
          { type: "datum_plane", id: "d1", name: "tilted", mode: "angle", from: "XY", axis: { line: { origin: [e, 0, 0], direction: [1, 0, 0] } }, angle: 30 },
          { type: "fillet", id: "f1", name: "corners", edges: { kind: "edge", q: { op: "filter", of: { op: "edges", of: { op: "sides", feature: "e1" } }, where: { radius: { min: e } } } }, r: 1 },
        ],
      },
    ],
  } as unknown as v1.IrDocument;
}

function roundTrips(doc: v1.IrDocument): void {
  expect(validateV1(doc).map((e) => `${e.code} ${e.path}`)).toEqual([]);
  expect(printabilityProblemsV1(doc)).toEqual([]);
  const src = printV1(doc);
  const r = compileV1(src, { base: doc });
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  expect(r.ir).toStrictEqual(canonicalDocument(doc));
  expect(toJson(r.ir!)).toBe(toJson(doc));
  expect(printV1(r.ir!)).toBe(src);
  expect(typecheckV1(src)).toEqual([]);
}

describe("every expression depth IR v1 accepts prints and compiles back", () => {
  for (const [name, build] of Object.entries(FAMILIES)) {
    it(`${name}: at MAX_EXPR_DEPTH and one below, in the deepest statement positions`, () => {
      const { n, text } = boundary(build);
      // the family reaches the IR's depth limit exactly
      const over = parseExpr(printExpr(build(n + 1)));
      expect(over.ok).toBe(false);
      if (!over.ok) expect(over.problem.message).toBe(`expression nested more than ${MAX_EXPR_DEPTH} levels deep`);
      roundTrips(docWith(text));
      roundTrips(docWith(printExpr(build(n - 1))));
    });
  }

  it("the reviewer's probes: 40 nested min(…, 1), 40 unary minuses (printed -(-(…)))", () => {
    roundTrips(docWith(printExpr(FAMILIES["calls"]!(40))));
    const minus = printExpr(FAMILIES["unary minus"]!(40));
    expect(minus).toBe(`${"-".repeat(40)}w`);
    roundTrips(docWith(minus));
    expect(printV1(docWith(minus))).toContain(`${"-(".repeat(39)}-w${")".repeat(39)}`);
  });
});

/** A document whose tag targets `q` (a face query over `slab`). */
function tagDoc(q: unknown): v1.IrDocument {
  return {
    schema: "aicad.ir/1",
    parts: [
      {
        id: "p1",
        name: "p",
        features: [
          { type: "sketch", id: "s1", name: "base", plane: "XY", curves: [{ kind: "rect", id: "outline", center: [0, 0], w: 80, h: 50 }] },
          { type: "extrude", id: "e1", name: "slab", sketch: "s1", distance: 8 },
          { type: "tag", id: "t1", name: "top", target: { kind: "face", q } },
        ],
      },
    ],
  } as unknown as v1.IrDocument;
}

const cap = (end: string): unknown => ({ op: "cap", feature: "e1", end });
/** Unions nested in the argument: `slab.cap("start").and(slab.cap("start").and(…))`. */
const unionArgs = (n: number): unknown => {
  let q = cap("end");
  for (let i = 0; i < n; i++) q = { op: "union", of: [cap("start"), q] };
  return q;
};
/** A filter chain: `slab.cap("end").planes().planes()…`. */
const filterChain = (n: number): unknown => {
  let q = cap("end");
  for (let i = 0; i < n; i++) q = { op: "filter", of: q, where: { type: "plane" } };
  return q;
};

describe("query nesting (unbounded in IR v1; forge-ir reads IR JSON at most 127 deep)", () => {
  // tag(5) target(6) q(7): a chain of n ops over cap() is 7 + n deep, n nested unions 7 + 2n.
  it("the deepest loadable queries round-trip: 60 unions nested in arguments, 120-link chains", () => {
    roundTrips(tagDoc(unionArgs(40)));
    roundTrips(tagDoc(unionArgs(60)));
    roundTrips(tagDoc(filterChain(100)));
    roundTrips(tagDoc(filterChain(120)));
    for (const doc of [tagDoc(unionArgs(60)), tagDoc(filterChain(120))]) {
      expect(jsonNesting(doc).depth).toBe(MAX_JSON_NESTING);
      expect(loadIrText(toJson(doc)).ok).toBe(true);
    }
  });

  it("MAX_JSON_NESTING is forge-ir's reader bound: one level more is a JSON syntax error", () => {
    expect(jsonNesting(tagDoc(filterChain(121))).depth).toBe(MAX_JSON_NESTING + 1);
    for (const doc of [tagDoc(unionArgs(61)), tagDoc(filterChain(121))]) {
      expect(validateV1(doc)).toEqual([]); // valid IR, in memory
      expect(jsonNesting(doc).depth).toBeGreaterThan(MAX_JSON_NESTING);
      const r = loadIrText(toJson(doc));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.parseError?.message).toMatch(/recursion limit exceeded/);
    }
  });

  it("beyond forge-ir's JSON bound (and CadScript's limits), the document is reported as not printable, never silently mis-printed", () => {
    for (const q of [unionArgs(61), filterChain(121), unionArgs(MAX_BRACKET_DEPTH_V1), filterChain(MAX_SYNTAX_DEPTH_V1)]) {
      const doc = tagDoc(q);
      expect(validateV1(doc)).toEqual([]); // valid IR
      const problems = printabilityProblemsV1(doc);
      expect(problems.length).toBe(1);
      expect(problems[0]).toMatchObject({ code: "CS_TOO_COMPLEX", path: "/parts/0/features/2", partId: "p1", featureId: "t1" });
      expect(problems[0]!.message).toMatch(/^the feature "top" nests \d+ arrays and objects deep in IR JSON, deeper than forge-ir reads \(127\); IR v1 does not bound query nesting: split the query with tag\(\)$/);
      expect(() => printV1(doc)).toThrow(CadScriptV1PrintError);
    }
  });

  it("the printability check is exact: the deepest printable query compiles, one more level does not", () => {
    let n = 40;
    while (printabilityProblemsV1(tagDoc(unionArgs(n + 1))).length === 0) n++;
    expect(n).toBe(60);
    roundTrips(tagDoc(unionArgs(n)));
    const tooDeep = printV1(tagDoc(unionArgs(n)))
      .replace("const top = tag(", 'const top = tag(slab.cap("start").and(')
      .replace(/\);\n$/, "));\n");
    expect(compileV1(tooDeep).diagnostics.map((d) => d.code)).toContain("CS_TOO_COMPLEX");
  });

  it("compile reports CS_TOO_COMPLEX where the IR would nest deeper than forge-ir reads (120 ops ok, 121 not)", () => {
    const HEAD = `import { part, sketch, extrude, tag, rect, XY } from "@aicad/std";\n\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 10, h: 10 }) });\nconst e = extrude(s, { distance: 5 });\n`;
    const chain = (n: number): string => `e.cap("end")${Array.from({ length: n }, (_, i) => (i % 2 === 0 ? ".edges()" : ".faces()")).join("")}`;
    const ok = compileV1(`${HEAD}const t = tag(${chain(120)});\n`);
    expect(ok.diagnostics).toEqual([]);
    expect(loadIrText(toJson(ok.ir!)).ok).toBe(true);
    for (const n of [121, 122, 124]) {
      const source = `${HEAD}const t = tag(${chain(n)});\n`;
      const r = compileV1(source);
      expect(r.ok).toBe(false);
      expect(r.diagnostics.map((d) => [d.code, d.severity, d.message])).toEqual([
        ["CS_TOO_COMPLEX", "error", `this feature's IR nests ${7 + n} arrays and objects deep; forge-ir reads IR JSON at most 127 deep`],
      ]);
      const d = r.diagnostics[0]!;
      expect(d.irPath).toMatch(/^\/parts\/0\/features\/2\/target\//);
      expect(d.span.start).toEqual({ line: 6, col: 15 }); // the whole query of tag()
    }
    // captures carried from a base count too: a capture nests 6 levels below its Ref
    expect(jsonNesting({ kind: "face", q: {}, capture: { members: [{ key: "k", via: "named", geom: { bbox: [[0, 0, 0], [1, 1, 1]] } }] } }).depth).toBe(1 + 6);
  });
});

// ─── The stack budget of the v1 limits (as test/robustness.test.ts for v0) ───────────────────

let reached = 0;
function descend<T>(depth: number, stop: number, f: () => T): T {
  reached = depth;
  return depth >= stop ? f() : descend(depth + 1, stop, f);
}

function freeFrames(): number {
  let frames = 0;
  for (let i = 0; i < 3; i++) {
    try {
      descend(0, 2 ** 30 - 1, () => 0);
    } catch {
      frames = reached;
    }
  }
  return frames;
}

function withFreeStack<T>(fraction: number, f: () => T): T {
  return descend(0, Math.floor(freeFrames() * (1 - fraction)), f);
}

describe("v1 limits and the stack", () => {
  it("the deepest accepted inputs compile and type-check with 40% of the free stack", () => {
    const b = MAX_BRACKET_DEPTH_V1;
    const s = MAX_SYNTAX_DEPTH_V1 - 6; // CadScript forms: one level each
    const t = MAX_SYNTAX_DEPTH_V1 / 2 - 6; // everything else counts two
    const sources = [
      `const a = ${"{ a: ".repeat(t)}1${" }".repeat(t)};`, // two syntax levels per bracket (object, property)
      `const a = ${"[".repeat(b)}1${"]".repeat(b)};`,
      `const a = ${"min(".repeat(b)}1${", 1)".repeat(b)};`,
      `const a = ${"- ".repeat(s)}1;`,
      `const a = ${"!".repeat(s)}1;`,
      `const a = b${"()".repeat(s)};`,
      `const a = b${".c".repeat(s)};`,
      `const a = ${"1 ? 1 : ".repeat(s)}1;`,
      `const a = ${Array<string>(s).fill("2").join(" ** ")};`,
      `const a = ${"new ".repeat(t)}X;`,
      `const a = ${"x => ".repeat(t)}1;`,
      `let a: ${"A<".repeat(t)}B${">".repeat(t)};`,
      `let a: ${"() => ".repeat(t)}1;`,
    ];
    const full = sources.map((source) => [compileV1(source).diagnostics, typecheckV1(source)]);
    full.forEach(([c, tc], i) => expect([...c!, ...tc!].filter((d) => d.code === "CS_TOO_COMPLEX").map((d) => d.message), sources[i]!.slice(0, 30)).toEqual([]));
    const reduced = withFreeStack(0.4, () => sources.map((source) => [compileV1(source).diagnostics, typecheckV1(source)]));
    expect(reduced).toEqual(full);
  });

  it("one level more is CS_TOO_COMPLEX (brackets; CadScript forms; other syntax at half the depth)", () => {
    const b = MAX_BRACKET_DEPTH_V1 + 1;
    const tooComplex = (src: string): string[] => compileV1(src).diagnostics.filter((d) => d.code === "CS_TOO_COMPLEX").map((d) => d.message);
    expect(tooComplex(`const a = ${"[".repeat(b)}1${"]".repeat(b)};`)).toEqual([`brackets are nested more than ${MAX_BRACKET_DEPTH_V1} levels deep`]);
    expect(tooComplex(`const a = ${"- ".repeat(MAX_SYNTAX_DEPTH_V1)}1;`)).toEqual([`code is nested more than ${MAX_SYNTAX_DEPTH_V1} levels deep`]);
    expect(tooComplex(`const a = ${"new ".repeat(MAX_SYNTAX_DEPTH_V1 / 2)}X;`)).toEqual([`code is nested more than ${MAX_SYNTAX_DEPTH_V1} levels deep`]);
    expect(LIMITS_V1.brackets).toBe(MAX_BRACKET_DEPTH_V1);
  });
});

describe("type-checker work limits are warnings in v1: `check` agrees with `compile`", () => {
  // Flow steps: the part() statement, the sketch and extrude consts, and one per tag const.
  const file = (tags: number): string =>
    `import { part, sketch, extrude, tag, rect, XY } from "@aicad/std";\n\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 10, h: 10 }) });\nconst e = extrude(s, { distance: 5 });\n${Array.from({ length: tags }, (_, i) => `const t${i} = tag(e.cap("end"));`).join("\n")}\n`;

  it(`at MAX_FLOW_STEPS (${MAX_FLOW_STEPS}) the file is type-checked; one step more is a CS_TOO_COMPLEX warning, not an error`, () => {
    const at = file(MAX_FLOW_STEPS - 3);
    expect(compileV1(at).ok).toBe(true);
    expect(typecheckV1(at)).toEqual([]);
    const over = file(MAX_FLOW_STEPS - 2);
    expect(compileV1(over).ok).toBe(true);
    const d = typecheckV1(over);
    expect(d.map((x) => [x.code, x.severity])).toEqual([["CS_TOO_COMPLEX", "warning"]]);
    expect(d[0]!.message).toMatch(/^not type-checked: the file has more than 2048 declarations/);
  });

  it("the reviewer's probe: 2100 tag statements compile, print, and pass `cadscript check` (with the warning)", () => {
    const r = compileV1(file(2100));
    expect(r.ok).toBe(true);
    // the printer writes such files; `check` must not fail what compile and print accept
    const printed = printV1(r.ir!);
    expect(compileV1(printed, { base: r.ir! }).ir).toStrictEqual(r.ir);
    let stderr = "";
    const code = main(["check", "big.cad.ts"], {
      readFile: () => printed,
      writeFile: () => undefined,
      stdout: () => undefined,
      stderr: (t) => {
        stderr += t;
      },
    });
    expect(stderr).toContain("warning CS_TOO_COMPLEX: not type-checked");
    expect(stderr).toContain("big.cad.ts: ok");
    expect(code).toBe(0);
  });

  it("v0 keeps them errors (unchanged legacy behaviour)", () => {
    expect(typecheckV0(file(2100).replace(/, tag, rect/, ", rect")).some((d) => d.code === "CS_TOO_COMPLEX" && d.severity === "error")).toBe(true);
  });
});
