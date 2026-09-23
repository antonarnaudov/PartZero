/**
 * Robustness: no source text, however deeply nested or malformed, makes compile(), typecheck(),
 * print() or applyIrEdit() throw anything but their documented errors (audit 2026-09-23 L20, L21).
 */
import { isDeepStrictEqual } from "node:util";
import fc from "fast-check";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@aicad/ir-types";
import { MAX_BRACKET_DEPTH, MAX_CHECKED_DEPTH, MAX_FLOW_STEPS, MAX_OVERLOADS, MAX_SYNTAX_DEPTH, tooComplexDiagnostic } from "../src/complexity.js";
import {
  applyIrEdit,
  CadScriptEditError,
  CadScriptPrintError,
  compile,
  DIAGNOSTIC_CODES,
  print,
  typecheck,
  validateIr,
  type CompileResult,
  type Diagnostic,
} from "../src/index.js";
import { irDocument, irEdit } from "./arbitraries.js";
import { HEADER } from "./helpers.js";

/**
 * fast-check settings: a fixed seed, so every run checks the same cases and a failure reproduces.
 * Explore others with `CADSCRIPT_FC_SEED=<n>` (and more of them with `CADSCRIPT_FC_RUNS=<n>`).
 */
const RUNS = { numRuns: Number(process.env["CADSCRIPT_FC_RUNS"] ?? 300), seed: Number(process.env["CADSCRIPT_FC_SEED"] ?? 20260923) };

// The audit repro (`r1-compile.mjs`): a part with one sketch, then the probe statement on line 4.
const HEAD = `${HEADER}part("p");\n`;
const SK = "const s = sketch(XY, { c: circle({ center: [0, 0], radius: 5 }) });\n";

const codes = (ds: readonly Diagnostic[]): string[] => ds.map((d) => d.code);
const sum = (n: number): string => Array<string>(n).fill("1").join(" + ");
const tooComplex = (ds: readonly Diagnostic[]): Diagnostic[] => ds.filter((d) => d.code === "CS_TOO_COMPLEX");
/** Messages of the stack-overflow fallback (check 3 in complexity.ts). */
const OVERFLOW = /^code is nested too deeply to (parse|compile|type-check) \(the call stack ran out\)$/;

// ─── A smaller stack, in process ─────────────────────────────────────────────────────────────

let reached = 0;
function descend<T>(depth: number, stop: number, f: () => T): T {
  reached = depth;
  return depth >= stop ? f() : descend(depth + 1, stop, f);
}

/**
 * The currently free stack, in `descend` frames. Measured three times so that the last pass runs
 * the same optimized code as a descent that follows (`stop` stays a small integer, so no deopt).
 */
function freeFrames(): number {
  let frames = 0;
  for (let i = 0; i < 3; i++) {
    try {
      descend(0, 2 ** 30 - 1, () => 0);
    } catch {
      frames = reached; // the stack overflow is the measurement
    }
  }
  return frames;
}

/** Run `f` with about `fraction` (≥ 0.05) of the currently free stack left, by recursing first. */
function withFreeStack<T>(fraction: number, f: () => T): T {
  return descend(0, Math.floor(freeFrames() * (1 - fraction)), f);
}

/**
 * A `- - … 1` chain that overflows the TypeScript parser on this host, whatever its stack size:
 * the parser spends at least two frames per `-`, each no smaller than an eighth of a `descend`
 * frame, so eight `-` per free `descend` frame need several times the whole stack.
 */
function parserOverflowingUnary(): string {
  return `${"- ".repeat(Math.max(50000, 8 * freeFrames()))}1`;
}

// ─── The audit repro, as tests ───────────────────────────────────────────────────────────────

describe("L21: `const x;`", () => {
  it("is a CS_SYNTAX error, not silently dropped", () => {
    const r = compile(`${HEAD}${SK}const x;\n`);
    expect(r.ok).toBe(false);
    expect(r.ir).toBeNull();
    expect(r.diagnostics.map((d) => [d.code, d.span.start.line, d.span.start.col])).toEqual([["CS_SYNTAX", 4, 7]]);
    // tsc agrees it is an error (TS1155 is a grammar check, reported only by the checker).
    expect(codes(typecheck(`${HEAD}${SK}const x;\n`))).toContain("TS1155");
  });

  it("covers annotated and exported forms; `declare const` is reported once, for `declare`", () => {
    expect(codes(compile(`${HEAD}${SK}const x: number;\n`).diagnostics)).toEqual(["CS_SYNTAX", "CS_STATEMENT_UNSUPPORTED"]);
    expect(codes(compile(`${HEAD}${SK}export const x;\n`).diagnostics)).toEqual(["CS_STATEMENT_UNSUPPORTED", "CS_SYNTAX"]);
    expect(compile(`${HEAD}${SK}declare const x;\n`).diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["CS_STATEMENT_UNSUPPORTED", "`declare` is not supported on features"],
    ]);
  });
});

describe("L20: deep nesting gives a diagnostic, never a RangeError", () => {
  for (const n of [1000, 5000, 20000, 100000]) {
    it(`left-deep arithmetic, ${n} terms: CS_EXPR_UNSUPPORTED with the folded value`, () => {
      const r = compile(`${HEAD}${SK}const w = ${sum(n)};\n`);
      expect(r.diagnostics.map((d) => [d.code, d.hint])).toEqual([
        ["CS_EXPR_UNSUPPORTED", `named values arrive with param() in CadScript v1; inline ${n} where \`w\` is used`],
      ]);
    });
  }

  it("left-deep arithmetic in an argument (literalHint → fold), 50000 terms", () => {
    const r = compile(`${HEAD}${SK}const e = extrude(s, { distance: ${sum(50000)} });\n`);
    expect(r.diagnostics.map((d) => [d.code, d.message, d.hint])).toEqual([
      ["CS_EXPR_UNSUPPORTED", "arithmetic is not supported in distance", "expressions and param() arrive in CadScript v1; use a numeric literal: 50000"],
    ]);
    // tsc accepts long chains too, but in quadratic time: typecheck() checks them up to
    // MAX_CHECKED_DEPTH (see "type-checker work limits" below).
    expect(typecheck(`${HEAD}${SK}const e = extrude(s, { distance: ${sum(400)} });\n`)).toEqual([]);
    expect(codes(typecheck(`${HEAD}${SK}const e = extrude(s, { distance: ${sum(50000)} });\n`))).toEqual(["CS_TOO_COMPLEX"]);
  });

  for (const n of [2000, 10000]) {
    it(`${n} nested parentheses / arrays: CS_TOO_COMPLEX from compile() and typecheck()`, () => {
      const parens = `${HEAD}${SK}const e = extrude(s, { distance: ${"(".repeat(n)}1${")".repeat(n)} });\n`;
      const arrays = `${HEAD}const s2 = sketch(XY, { a: line(${"[".repeat(n)}0${"]".repeat(n)}, [1, 0]) });\n`;
      for (const source of [parens, arrays]) {
        const r = compile(source);
        expect(r.ok).toBe(false);
        expect(r.ir).toBeNull();
        expect(codes(r.diagnostics)).toEqual(["CS_TOO_COMPLEX"]);
        expect(r.diagnostics[0]!.message).toBe(`brackets are nested more than ${MAX_BRACKET_DEPTH} levels deep`);
        expect(typecheck(source)).toEqual(r.diagnostics);
      }
    });
  }

  it("applyIrEdit refuses too deeply nested source with a CadScriptEditError", () => {
    const base = compile(`${HEAD}${SK}`).ir!;
    const source = `${HEAD}${SK}const e = extrude(s, { distance: ${"(".repeat(3000)}1${")".repeat(3000)} });\n`;
    let err: unknown;
    try {
      applyIrEdit(source, base, base);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CadScriptEditError);
    expect((err as CadScriptEditError).message).toBe("cannot splice an edit into source that is nested too deeply");
    expect(codes((err as CadScriptEditError).diagnostics)).toEqual(["CS_TOO_COMPLEX"]);
  });
});

// ─── Check 1: brackets, on tokens ────────────────────────────────────────────────────────────

describe("bracket nesting limit", () => {
  const nest = (open: string, close: string, n: number): string => `const a = ${open.repeat(n)}1${close.repeat(n)};\n`;
  // [what, opener, closer, offset of the bracket token within the opener]
  const shapes: [string, string, string, number][] = [
    ["parentheses", "(", ")", 0],
    ["arrays", "[", "]", 0],
    ["objects", "{ a: ", " }", 0],
    ["calls", "f(", ")", 1],
    ["template substitutions", "`${", "}`", 0], // the TemplateHead token starts at the backtick
  ];
  for (const [what, open, close, offset] of shapes) {
    it(`${what}: ${MAX_BRACKET_DEPTH} levels pass, ${MAX_BRACKET_DEPTH + 1} are CS_TOO_COMPLEX at the extra bracket`, () => {
      expect(tooComplex(compile(nest(open, close, MAX_BRACKET_DEPTH)).diagnostics)).toEqual([]);
      const over = nest(open, close, MAX_BRACKET_DEPTH + 1);
      const [d, ...rest] = compile(over).diagnostics;
      expect(rest).toEqual([]);
      expect(d!.code).toBe("CS_TOO_COMPLEX");
      expect(d!.span.start).toEqual({ line: 1, col: "const a = ".length + open.length * MAX_BRACKET_DEPTH + offset + 1 });
    });
  }

  it("does not count brackets in strings, comments, template text or regular expressions", () => {
    const deep = "(".repeat(1000);
    for (const inner of [JSON.stringify(deep), `/* ${deep} */ 1`, `\`${deep}\``, `/${"\\(".repeat(1000)}/`, `\`${deep}\${ { a: [1] } }${deep}\``]) {
      const source = `${HEAD}const a = ${inner};\n// ${deep}\n`;
      expect(tooComplex(compile(source).diagnostics), inner.slice(0, 20)).toEqual([]);
      expect(tooComplex(typecheck(source))).toEqual([]);
    }
  });

  it("reads `/` after an operand as division, not as the start of a regular expression", () => {
    const deep = `${"(".repeat(MAX_BRACKET_DEPTH + 1)}1${")".repeat(MAX_BRACKET_DEPTH + 1)}`;
    for (const left of ["b", "b.c", "(b)", "b[0]", "1", '"s"', "this", "b++"]) {
      expect(codes(compile(`const a = ${left} / ${deep} / 2;\n`).diagnostics), left).toEqual(["CS_TOO_COMPLEX"]);
    }
  });

  it("counts unclosed brackets (the parser recurses into them all the same)", () => {
    expect(codes(compile(`const a = ${"(".repeat(MAX_BRACKET_DEPTH + 1)}1;\n`).diagnostics)).toEqual(["CS_TOO_COMPLEX"]);
    const unclosed = codes(compile(`const a = ${"(".repeat(MAX_BRACKET_DEPTH)}1;\n`).diagnostics);
    expect(unclosed.length).toBeGreaterThan(0);
    expect(new Set(unclosed)).toEqual(new Set(["CS_SYNTAX"]));
  });

  it("does not accumulate across siblings: a 2000-curve sketch compiles", () => {
    const curves = Array.from({ length: 2000 }, (_, i) => `  c${i}: circle({ center: [${i * 10}, 0], radius: 1 }),`).join("\n");
    const r = compile(`${HEAD}const s = sketch(XY, {\n${curves}\n});\nconst e = extrude(s, { distance: 1 });\n`);
    expect(r.diagnostics).toEqual([]);
    expect(r.ir!.parts[0]!.features[0]!.type === "sketch" && r.ir!.parts[0]!.features[0]!.curves).toHaveLength(2000);
  });
});

// ─── Check 2: syntax-tree depth ──────────────────────────────────────────────────────────────

describe("syntax nesting limit", () => {
  // SourceFile 0 → VariableStatement 1 → VariableDeclarationList 2 → VariableDeclaration 3 →
  // the initializer is at depth 4, so `n` prefix operators put the literal at depth 4 + n.
  const unary = (n: number): string => `const a = ${"- ".repeat(n)}1;\n`;
  const atLimit = MAX_SYNTAX_DEPTH - 4;

  it(`accepts a tree ${MAX_SYNTAX_DEPTH} deep and reports the first deeper node`, () => {
    for (const fn of [(s: string) => compile(s).diagnostics, typecheck]) {
      expect(tooComplex(fn(unary(atLimit)))).toEqual([]);
      const over = fn(unary(atLimit + 1));
      expect(over.map((d) => [d.code, d.message, d.span])).toEqual([
        ["CS_TOO_COMPLEX", `code is nested more than ${MAX_SYNTAX_DEPTH} levels deep`, { start: { line: 1, col: 11 + 2 * (atLimit + 1) }, end: { line: 1, col: 12 + 2 * (atLimit + 1) } }],
      ]);
    }
  });

  it("limits nesting without brackets: member and call chains, `**`, conditionals, `new`", () => {
    for (const source of [
      `const a = b${".c".repeat(3 * MAX_SYNTAX_DEPTH)};`,
      `const a = b${"()".repeat(3 * MAX_SYNTAX_DEPTH)};`,
      `const a = ${Array<string>(3 * MAX_SYNTAX_DEPTH).fill("2").join(" ** ")};`,
      `const a = ${"1 ? 1 : ".repeat(3 * MAX_SYNTAX_DEPTH)}1;`,
      `const a = ${"new ".repeat(3 * MAX_SYNTAX_DEPTH)}X;`,
      `${"if (1) ".repeat(3 * MAX_SYNTAX_DEPTH)};`,
    ]) {
      expect(codes(compile(source).diagnostics), source.slice(0, 20)).toEqual(["CS_TOO_COMPLEX"]);
      expect(codes(typecheck(source))).toEqual(["CS_TOO_COMPLEX"]);
    }
  });

  it("does not count left-associative chains (the parser, checker and fold walk them iteratively)", () => {
    for (const op of ["+", "-", "*", "/", "%", "<", "===", "&&", "??", "|"]) {
      const source = `const a = ${Array<string>(20000).fill("1").join(` ${op} `)};\n`;
      expect(tooComplex(compile(source).diagnostics), op).toEqual([]);
    }
  });
});

// ─── Positions ───────────────────────────────────────────────────────────────────────────────

describe("CS_TOO_COMPLEX positions", () => {
  it("use TypeScript's line breaks (LF, CR, CRLF, U+2028, U+2029) and UTF-16 columns", () => {
    const text = fc.array(fc.constantFrom("a", " ", "\n", "\r", "\r\n", "\u2028", "\u2029", "é", "😀"), { maxLength: 40 }).map((p) => p.join(""));
    fc.assert(
      fc.property(text, fc.nat(), fc.nat(), (source, i, j) => {
        const [start, end] = [i % (source.length + 1), j % (source.length + 1)].sort((a, b) => a - b) as [number, number];
        const sf = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest);
        const at = (p: number) => {
          const lc = sf.getLineAndCharacterOfPosition(p);
          return { line: lc.line + 1, col: lc.character + 1 };
        };
        expect(tooComplexDiagnostic(source, { start, end, message: "m" }).span).toEqual({ start: at(start), end: at(end) });
      }),
      RUNS,
    );
  });
});

// ─── Check 3: a stack overflow is caught, and leaves no parser state behind ──────────────────

describe("stack overflow fallback", () => {
  it("the deepest accepted inputs compile and type-check with 40% of the free stack", () => {
    // Real CadScript nests ~12 levels; these sit exactly at the limits. On Node's default stack
    // (vitest's forks pool) the costliest (nested generic types in the checker) needs about a
    // third of the stack, so a host with a much smaller stack than Node's still never falls back
    // to the host-dependent overflow path for accepted input. (The fraction is of this process's
    // stack, so the test needs at least Node's default, as every vitest pool has: about 1 MB on
    // the main thread for forks, 4 MB workers for threads; with `--stack-size=400` it fails.)
    const b = MAX_BRACKET_DEPTH;
    const s = MAX_SYNTAX_DEPTH - 5;
    const sources = [
      `const a = ${"{ a: ".repeat(b)}1${" }".repeat(b)};`,
      `const a = ${"[".repeat(b)}1${"]".repeat(b)};`,
      `const a = ${"- ".repeat(s)}1;`,
      `const a = b${"()".repeat(s)};`,
      `const a = ${"new ".repeat(s)}X;`,
      `const a = ${"x => ".repeat(s)}1;`,
      `let a: ${"A<".repeat(s)}B${">".repeat(s)};`,
      `let a: ${"() => ".repeat(s)}1;`,
    ];
    const full = sources.map((source) => [compile(source).diagnostics, typecheck(source)]);
    for (const [c, t] of full) expect([...c!, ...t!].filter((d) => d.code === "CS_TOO_COMPLEX")).toEqual([]);
    const reduced = withFreeStack(0.4, () => sources.map((source) => [compile(source).diagnostics, typecheck(source)]));
    expect(reduced).toEqual(full);
  });

  it("turns an overflow into CS_TOO_COMPLEX at every stack size, never a throw", () => {
    // Only host-independent facts are asserted here. Which catch fires at a given fraction (the
    // parser's, the checker's, the outermost one, or none) depends on the host's stack size and
    // the engine's frame sizes: a worker thread's default stack is four times the main thread's.
    // Each catch is tested on its own, independently of the stack, by the tests that follow.
    const sources = {
      trivial: "const a = 1;",
      // Past the syntax limit: the parser overflows before check 2 can run, or on a host with a
      // large stack check 2 reports it; either way CS_TOO_COMPLEX.
      deepUnary: `const a = ${"- ".repeat(20000)}1;`,
      // Within the limits, and heavy for the checker.
      callChain: `const a = b${"()".repeat(MAX_SYNTAX_DEPTH - 5)};`,
    };
    const trivialFull = [compile(sources.trivial).diagnostics, typecheck(sources.trivial)];
    const tooDeep = `code is nested more than ${MAX_SYNTAX_DEPTH} levels deep`;
    for (const fraction of [0.4, 0.2, 0.15, 0.1, 0.05]) {
      const outcomes = withFreeStack(fraction, () =>
        Object.values(sources).map((source) => {
          try {
            return [compile(source).diagnostics, typecheck(source)];
          } catch (e) {
            return e; // (formatting `e` here could overflow again)
          }
        }),
      );
      const [trivial, deep, calls] = outcomes.map((o) => {
        expect(Array.isArray(o), `${fraction}: ${String(o)}`).toBe(true);
        return o as Diagnostic[][];
      });
      for (const d of [...trivial!, ...calls!].flat().filter((x) => x.code === "CS_TOO_COMPLEX")) {
        expect(d.message).toMatch(OVERFLOW); // within the limits: only an overflow rejects them
        expect(d.span).toEqual({ start: { line: 1, col: 1 }, end: { line: 1, col: 1 } });
      }
      for (const ds of deep!) {
        expect(codes(ds)).toEqual(["CS_TOO_COMPLEX"]); // the deep chain, always
        expect(OVERFLOW.test(ds[0]!.message) || ds[0]!.message === tooDeep, ds[0]!.message).toBe(true);
      }
      if (fraction >= 0.15) expect(trivial).toEqual(trivialFull); // enough stack for real work
    }
  });

  it("the outermost catch turns only a stack overflow into CS_TOO_COMPLEX", () => {
    // Simulated: an overflow anywhere in lowering (here, reading `base` while assigning ids).
    const throwing = (error: Error): IrDocument =>
      new Proxy({} as IrDocument, {
        get: () => {
          throw error;
        },
      });
    const source = `${HEAD}${SK}`;
    const r = compile(source, { base: throwing(new RangeError("Maximum call stack size exceeded")) });
    expect(r.diagnostics.map((d) => [d.code, d.message])).toEqual([["CS_TOO_COMPLEX", "code is nested too deeply to compile (the call stack ran out)"]]);
    expect(r.ok).toBe(false);
    // Any other error is a bug and must surface.
    expect(() => compile(source, { base: throwing(new TypeError("boom")) })).toThrow("boom");
    expect(() => compile(source, { base: throwing(new RangeError("Invalid array length")) })).toThrow("Invalid array length");
  });

  it("typecheck()'s catch turns only a stack overflow into CS_TOO_COMPLEX", () => {
    // Simulated, like the test above: a real overflow in the checker needs a caller that left
    // little stack, and how little depends on the host. Here the source throws on first use.
    const throwing = (error: Error): string =>
      ({
        get length(): number {
          throw error;
        },
      }) as unknown as string;
    const overflow = [["CS_TOO_COMPLEX", "code is nested too deeply to type-check (the call stack ran out)", { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } }]];
    const project = (ds: Diagnostic[]) => ds.map((d) => [d.code, d.message, d.span]);
    expect(project(typecheck(throwing(new RangeError("Maximum call stack size exceeded"))))).toEqual(overflow); // V8, JavaScriptCore
    const spiderMonkey = Object.assign(new Error("too much recursion"), { name: "InternalError" });
    expect(project(typecheck(throwing(spiderMonkey)))).toEqual(overflow);
    // Any other error is a bug and must surface.
    expect(() => typecheck(throwing(new TypeError("boom")))).toThrow("boom");
    expect(() => typecheck(throwing(new RangeError("Invalid array length")))).toThrow("Invalid array length");
  });

  // `(a)` at offset 10 is first tried as an arrow function's parameter list and cached as "not an
  // arrow" at that offset; the unary chain then overflows the parser midway (on any host: it is
  // sized to the stack), before the parser's own state reset. `probe` has an arrow function at
  // that same offset.
  const poison = `const q = (a) + 1;\nconst w = ${parserOverflowingUnary()};\n`;
  const probe = "const q = (a) => 1;\n";
  const parseErrors = (source: string): unknown[] =>
    (ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true) as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics;

  it("resets the TypeScript parser before parsing: an overflow in other code cannot leak into compile()", () => {
    const fresh = compile(probe).diagnostics;
    expect(fresh.map((d) => d.message)).toContain("functions are not supported in `const q`");
    expect(codes(fresh)).not.toContain("CS_SYNTAX");
    const other = withFreeStack(0.15, () => {
      try {
        return parseErrors(poison); // some other TypeScript user, unguarded
      } catch (e) {
        return e;
      }
    });
    expect(other).toBeInstanceOf(RangeError);
    expect(compile(probe).diagnostics).toEqual(fresh);
  });

  it("resets the TypeScript parser after its own overflow: other TypeScript users are unaffected", () => {
    expect(parseErrors(probe)).toEqual([]);
    const poisoned = withFreeStack(0.15, () => compile(poison).diagnostics);
    expect(poisoned.map((d) => d.message)).toEqual(["code is nested too deeply to parse (the call stack ran out)"]);
    expect(parseErrors(probe)).toEqual([]);
  });
});

// ─── typecheck(): tsc's rule for syntax errors, and the checker's work limits ────────────────

describe("typecheck() of a file with syntax errors", () => {
  it("reports only the syntax errors, as tsc does", () => {
    const typeError = `${HEAD}${SK}const e = extrude(s, { distance: "8" });\n`;
    expect(codes(typecheck(typeError))).toEqual(["TS2322"]);
    const both = `${typeError}const f = extrude(s, { distance: 8 };\n`;
    expect(typecheck(both).map((d) => [d.code, d.span.start.line])).toEqual([["TS1005", 5]]);
  });

  it("the property-test hang: a fragment repeated inside a sketch's object literal", () => {
    // With 8000 repetitions this took over 10 minutes: tsc recovered methods named `doc` and
    // printed their k-overload type once per method (300 took about a second; the scaling test
    // below checks the growth). compile() always took milliseconds.
    for (const n of [300, 8000]) {
      const source = `${HEAD}const s = sketch(XY, {\n  a: circle({ center: [0, 0], radius: 5 }),\n  t${"doc({ name: 1 });".repeat(n)}_D9: circle({ center: [2, 0], radius: 3 }),\n});\n`;
      const ds = typecheck(source);
      expect(ds).toHaveLength(3 * n); // identifier, `:` and `,` expected, per repetition
      expect(ds.filter((d) => !/^TS1\d{3}$/.test(d.code) || d.span.start.line !== 5)).toEqual([]);
    }
  });
});

describe("type-checker work limits", () => {
  const skipped = (ds: readonly Diagnostic[]) => ds.map((d) => [d.code, d.severity, d.message, d.span]);
  const at = (line: number, col: number, endCol: number) => ({ start: { line, col }, end: { line, col: endCol } });

  it(`depth: ${MAX_CHECKED_DEPTH} levels are checked, counting left operands; one more is CS_TOO_COMPLEX`, () => {
    // SourceFile 0 → VariableStatement 1 → VariableDeclarationList 2 → VariableDeclaration 3 →
    // the chain's n - 1 binary expressions → the first `1` at depth n + 3.
    expect(typecheck(`const a = ${sum(MAX_CHECKED_DEPTH - 3)};\n`)).toEqual([]);
    expect(skipped(typecheck(`const a = ${sum(MAX_CHECKED_DEPTH - 2)};\n`))).toEqual([
      ["CS_TOO_COMPLEX", "error", `not type-checked: code is nested more than ${MAX_CHECKED_DEPTH} levels deep, counting each operator of a chain like 1 + 2 + 3`, at(1, 11, 12)],
    ]);
    // compile() is not limited by it (it folds chains iteratively).
    expect(codes(compile(`const a = ${sum(MAX_CHECKED_DEPTH - 2)};\n`).diagnostics)).not.toContain("CS_TOO_COMPLEX");
  });

  it(`overloads: ${MAX_OVERLOADS} declarations of one name in one place are checked; one more is CS_TOO_COMPLEX`, () => {
    const methods = (n: number) => `const o = { ${"m() {}, ".repeat(n)}};\n`;
    expect(codes(typecheck(methods(MAX_OVERLOADS)))).not.toContain("CS_TOO_COMPLEX");
    const start = "const o = { ".length + "m() {}, ".length * MAX_OVERLOADS + 1;
    expect(skipped(typecheck(methods(MAX_OVERLOADS + 1)))).toEqual([
      ["CS_TOO_COMPLEX", "error", `not type-checked: more than ${MAX_OVERLOADS} declarations of \`m\` in one scope, type or object literal`, at(1, start, start + 6)],
    ]);
    // Each kind that merges into overloads; the message names what repeats.
    const over = MAX_OVERLOADS + 1;
    for (const [source, what] of [
      ["declare function f(): void;\n".repeat(over), "declarations of `f`"],
      ["interface I { m(): void }\n".repeat(over), "declarations of `I`"],
      ["namespace N {}\n".repeat(over), "declarations of `N`"],
      [`interface I { ${"m(): void; ".repeat(over)}}`, "declarations of `m`"],
      [`class C { ${"m(): void; ".repeat(over)}m() {} }`, "declarations of `m`"],
      [`type F = { ${"(): void; ".repeat(over)}};`, "call signatures"],
      [`type F = { ${"new (): F; ".repeat(over)}};`, "construct signatures"],
      [`declare class C { ${"constructor(); ".repeat(over)}}`, "constructors"],
    ]) {
      expect(typecheck(source!).map((d) => d.message)).toEqual([`not type-checked: more than ${MAX_OVERLOADS} ${what} in one scope, type or object literal`]);
    }
    // Different names, or different places, do not add up.
    expect(codes(typecheck(`const o = { ${Array.from({ length: 100 }, (_, i) => `m${i}() {}`).join(", ")} };\n`))).toEqual([]);
    expect(codes(typecheck(Array.from({ length: 100 }, (_, i) => `const o${i} = { m() {} };\n`).join("")))).toEqual([]);
  });

  it(`flow steps: ${MAX_FLOW_STEPS} declarations, assignments and statements are checked; one more is CS_TOO_COMPLEX`, () => {
    // (The limit on a whole file: diagnostics.test.ts, CS_TOO_COMPLEX.) Declarators and
    // assignments inside one statement count too: tsc walks back over each of them.
    const assignments = (n: number) => `let x = 0;\nconst a = [${"x = 1, ".repeat(n)}];\n`; // 2 + n steps
    expect(typecheck(assignments(MAX_FLOW_STEPS - 2))).toEqual([]);
    const start = "const a = [".length + "x = 1, ".length * (MAX_FLOW_STEPS - 2) + 1;
    expect(skipped(typecheck(assignments(MAX_FLOW_STEPS - 1)))).toEqual([
      ["CS_TOO_COMPLEX", "error", `not type-checked: the file has more than ${MAX_FLOW_STEPS} declarations, assignments and statements`, at(2, start, start + 5)],
    ]);
    const declarators = (n: number) => `let ${Array.from({ length: n }, (_, i) => `v${i} = 0`).join(", ")};\n`;
    expect(typecheck(declarators(MAX_FLOW_STEPS))).toEqual([]);
    expect(codes(typecheck(declarators(MAX_FLOW_STEPS + 1)))).toEqual(["CS_TOO_COMPLEX"]);
    const increments = (n: number) => `let x = 0;\n${"x++;\n".repeat(n)}`; // 1 + 2n steps
    expect(typecheck(increments(MAX_FLOW_STEPS / 2 - 1))).toEqual([]);
    expect(codes(typecheck(increments(MAX_FLOW_STEPS / 2)))).toEqual(["CS_TOO_COMPLEX"]);
  });

  it("are applied after the nesting limits and tsc's syntax rule", () => {
    const deep = `const a = ${"(".repeat(MAX_BRACKET_DEPTH + 1)}1${")".repeat(MAX_BRACKET_DEPTH + 1)};\n${"x++;\n".repeat(MAX_FLOW_STEPS)}`;
    expect(codes(typecheck(deep))).toEqual(["CS_TOO_COMPLEX"]);
    expect(codes(typecheck(`${"x++;\n".repeat(MAX_FLOW_STEPS)}const a = ;\n`))).toEqual(["TS1109"]);
  });
});

// ─── Linear time on huge (malformed) files ───────────────────────────────────────────────────

/**
 * The fastest of three interleaved timings of `run` on `small` and on `large`, so a pause (GC, a
 * busy machine) must hit all three large runs to matter. A run shorter than 20 ms is repeated
 * until 20 ms have passed and timed on average, so timer resolution and jitter do not count.
 */
function timings(run: (source: string) => void, small: string, large: string): [number, number] {
  const time = (source: string): number => {
    const t0 = performance.now();
    let [t, runs] = [t0, 0];
    do {
      run(source);
      runs++;
      t = performance.now();
    } while (t - t0 < 20);
    return (t - t0) / runs;
  };
  let [tSmall, tLarge] = [Infinity, Infinity];
  for (let i = 0; i < 3; i++) {
    tSmall = Math.min(tSmall, time(small));
    tLarge = Math.min(tLarge, time(large));
  }
  return [tSmall, tLarge];
}

describe("scaling", () => {
  it("fresh ids follow the first-free-suffix rule (p_a, p_a_2, …), also around base ids", () => {
    const names = ["a", "a_2", "a", "a", "a-2", "b", "a"];
    const source = `${HEADER}${names.map((n) => `part(${JSON.stringify(n)});`).join("\n")}\n`;
    expect(Object.keys(compile(source).partSpans)).toEqual(["p_a", "p_a_2", "p_a_3", "p_a_4", "p_a_2_2", "p_b", "p_a_5"]);
    const base: IrDocument = { schema: "aicad.ir/0", parts: [{ id: "p_a_3", name: "zz1", features: [] }, { id: "p_a", name: "zz2", features: [] }] };
    expect(Object.keys(compile(source, { base }).partSpans)).toEqual(["p_a_2", "p_a_2_2", "p_a_4", "p_a_5", "p_a_2_3", "p_b", "p_a_6"]);
  });

  it("compiles same-named parts, doc() calls and broken features in linear time", () => {
    // Each of these was quadratic (well over 5 s for 30000 lines of one kind): the fresh-id
    // search restarting at `_2`, the doc() placement check re-filtering all statements, the
    // broken-feature filter scanning every broken feature per validation error.
    //
    // Machine-independent: no absolute time, only how the time grows. Four times the lines take
    // about 4× as long in linear time and 16× in quadratic time; the bound is the geometric mean,
    // 8× (time growing as n^1.5); see timings() for the measurement.
    for (const line of [`part("q");`, `doc({ name: "d" });`, `const e$ = extrude(s, { distance: "8" });`]) {
      const [small, large] = [5000, 20000].map((n) => `${HEAD}${SK}${Array.from({ length: n }, (_, i) => line.replace("$", String(i))).join("\n")}\n`);
      const [tSmall, tLarge] = timings((source) => expect(compile(source).ok).toBe(false), small!, large!);
      expect(tLarge / tSmall, `${line}: ${tSmall.toFixed(0)} ms → ${tLarge.toFixed(0)} ms`).toBeLessThan(8);
    }
  });

  // The TypeScript checker takes time growing with the square of the input along several
  // dimensions (see "type-checker work" in complexity.ts). Each case was quadratic in typecheck():
  // 4× the input took 10–18× the time, and the first was a 10-minute hang in the property test
  // below (8000 repetitions). Same yardstick as compile() above: under 8× the time for 4× the input.
  const typecheckCases: { what: string; source: (n: number) => string; n: number; expected: (ds: Diagnostic[]) => void }[] = [
    {
      // Error recovery parses the fragments as methods named `doc`, and tsc printed the
      // k-overload type of `doc` once per method.
      what: "a fragment repeated inside a sketch's object literal (syntax errors)",
      source: (n) => `${HEAD}const s = sketch(XY, {\n  a: circle({ center: [0, 0], radius: 5 }),\n  t${"doc({ name: 1 });".repeat(n)}_D9: circle({ center: [2, 0], radius: 3 }),\n});\n`,
      n: 150,
      expected: (ds) => expect(ds.every((d) => /^TS1\d{3}$/.test(d.code))).toBe(true),
    },
    {
      what: "same-named methods in an object literal (valid syntax)",
      source: (n) => `${HEAD}const s = sketch(XY, {\n${"  doc(a) { return 1; },\n".repeat(n)}});\n`,
      n: 150,
      expected: (ds) => expect(codes(ds)).toEqual(["CS_TOO_COMPLEX"]),
    },
    {
      what: "overloads × calls",
      source: (n) => `${HEAD}${"declare function f(a: number): void;\n".repeat(n)}${'f("x");\n'.repeat(n)}`,
      n: 200,
      expected: (ds) => expect(codes(ds)).toEqual(["CS_TOO_COMPLEX"]),
    },
    {
      what: "a long operator chain",
      source: (n) => `${HEAD}const a = ${sum(n)};\n`,
      n: 2000,
      expected: (ds) => expect(codes(ds)).toEqual(["CS_TOO_COMPLEX"]),
    },
    {
      // Valid CadScript: every reference walks back over all earlier declarations (tsc's
      // control-flow analysis).
      what: "thousands of statements",
      source: (n) => `${HEAD}${SK}${Array.from({ length: n }, (_, i) => `const e${i} = extrude(s, { distance: 1 });`).join("\n")}\n`,
      n: 2500,
      expected: (ds) => expect(codes(ds)).toEqual(["CS_TOO_COMPLEX"]),
    },
  ];
  for (const { what, source, n, expected } of typecheckCases) {
    // (A generous timeout: before the fix each of these took up to 20 s to fail.)
    it(`type-checks ${what} in linear time`, { timeout: 120_000 }, () => {
      const [small, large] = [source(n), source(4 * n)];
      const [tSmall, tLarge] = timings((s) => typecheck(s), small, large);
      expect(tLarge / tSmall, `${tSmall.toFixed(0)} ms → ${tLarge.toFixed(0)} ms`).toBeLessThan(8);
      expected(typecheck(small));
      expected(typecheck(large));
    });
  }
});

// ─── Property: malformed and deeply nested input never throws ────────────────────────────────

const FRAGMENTS = [
  "(", ")", "[", "]", "{", "}", "`", "${", "/", "//", "/*", "*/", '"', "'", "\\", ",", ";", ":", "?", "=>", "- ", "!", "**", "+", ".", "<", ">",
  "const x;", "const ", "let ", "if (1) ", "new ", "typeof ", "a", "1", "1e999", "-0", "0x1F", "08", "\n", "\r\n", "\u2028", " ", "\u0000", "😀",
  'part("q");', "sketch(", "extrude(", "circle({ center: [0, 0], radius: 1 })", 'import { part } from "@aicad/std";', "doc({ name: 1 });",
];

/**
 * How many times a fragment is repeated: mostly a few, sometimes around the limits, rarely far
 * beyond (thousands of `- ` overflow the parser: the stack-overflow path). Not more: tsc checks
 * long operator chains in quadratic time.
 */
const repeat = fc.oneof(
  { weight: 12, arbitrary: fc.integer({ min: 1, max: 4 }) },
  { weight: 3, arbitrary: fc.integer({ min: MAX_BRACKET_DEPTH - 2, max: MAX_BRACKET_DEPTH + 2 }) },
  { weight: 3, arbitrary: fc.integer({ min: MAX_SYNTAX_DEPTH - 6, max: MAX_SYNTAX_DEPTH + 2 }) },
  { weight: 1, arbitrary: fc.constantFrom(2000, 8000) },
);

type SourceMutation = (s: string) => string;
const at = (s: string, n: number): number => n % (s.length + 1);

/** Ways to nest a numeric literal `n` k levels deep; all but the last keep the syntax valid. */
const NESTINGS: ((n: string, k: number) => string)[] = [
  (n, k) => `${"(".repeat(k)}${n}${")".repeat(k)}`,
  (n, k) => `${"[".repeat(k)}${n}${"]".repeat(k)}`,
  (n, k) => `${"{ a: ".repeat(k)}${n}${" }".repeat(k)}`,
  (n, k) => `${"f(".repeat(k)}${n}${")".repeat(k)}`,
  (n, k) => `${"`${".repeat(k)}${n}${"}`".repeat(k)}`,
  (n, k) => `${"- ".repeat(k)}${n}`,
  (n, k) => `${"!".repeat(k)}${n}`,
  (n, k) => `${"1 + ".repeat(k)}${n}`,
  (n, k) => `${"2 ** ".repeat(k)}${n}`,
  (n, k) => `${"1 ? 1 : ".repeat(k)}${n}`,
  (n, k) => `b${".c".repeat(k)}`,
  (n, k) => `b${"()".repeat(k)}`,
  (n, k) => `${"x => ".repeat(k)}${n}`,
  (n, k) => `${"(".repeat(k)}${n}`,
];

const LINES = ["const x;", "const y: number;", "let z = 1;", 'part("q");', 'doc({ name: "d" });', "if (1) {}", "declare const w;", "export {};", ";"];

const sourceMutation: fc.Arbitrary<SourceMutation> = fc.oneof(
  // Nest the i-th number literal (valid syntax, deep structure: every nesting check and path).
  {
    weight: 4,
    arbitrary: fc.tuple(fc.nat(), fc.nat({ max: NESTINGS.length - 1 }), repeat).map(([i, w, k]): SourceMutation => (s) => {
      const nums = [...s.matchAll(/(?<![\w.])\d+(\.\d+)?(e-?\d+)?/g)];
      const m = nums[i % Math.max(1, nums.length)];
      return m ? s.slice(0, m.index) + NESTINGS[w]!(m[0], k) + s.slice(m.index + m[0].length) : s;
    }),
  },
  // Insert, duplicate or delete whole lines (the rest keeps parsing).
  {
    weight: 2,
    arbitrary: fc.tuple(fc.nat(), fc.nat(), fc.constantFrom(...LINES)).map(([i, op, text]): SourceMutation => (s) => {
      const lines = s.split("\n");
      const j = i % lines.length;
      if (op % 3 === 0) lines.splice(j, 0, text);
      else if (op % 3 === 1) lines.splice(j, 0, lines[j]!);
      else lines.splice(j, 1);
      return lines.join("\n");
    }),
  },
  // Insert a (repeated) arbitrary fragment: token soup.
  { weight: 2, arbitrary: fc.tuple(fc.nat(), fc.constantFrom(...FRAGMENTS), repeat).map(([p, f, k]): SourceMutation => (s) => s.slice(0, at(s, p)) + f.repeat(k) + s.slice(at(s, p))) },
  // Delete or duplicate a slice; truncate.
  {
    weight: 1,
    arbitrary: fc.tuple(fc.nat(), fc.nat(), fc.nat({ max: 2 })).map(([p, q, op]): SourceMutation => (s) => {
      const [i, j] = [at(s, p), at(s, q)].sort((a, b) => a - b) as [number, number];
      return op === 0 ? s.slice(0, j) + s.slice(i) : op === 1 ? s.slice(0, i) + s.slice(j) : s.slice(0, i);
    }),
  },
);

const malformedSource: fc.Arbitrary<{ ir: IrDocument; source: string }> = fc
  .tuple(irDocument, fc.array(sourceMutation, { minLength: 1, maxLength: 3 }))
  .map(([ir, muts]) => ({ ir, source: muts.reduce((s, m) => m(s), print(ir)) }));

/** The result is internally consistent: `ok` iff no error, `ir` iff ok, every span on a real position. */
function expectWellFormed(r: CompileResult, source: string): void {
  const lines = source.split(/\r\n|[\n\r\u2028\u2029]/).length;
  expect(r.ok).toBe(!r.diagnostics.some((d) => d.severity === "error"));
  expect(r.ir === null).toBe(!r.ok);
  if (r.ir) expect(validateIr(r.ir)).toEqual([]);
  for (const d of r.diagnostics) {
    expect(d.code.startsWith("TS") || Object.prototype.hasOwnProperty.call(DIAGNOSTIC_CODES, d.code), d.code).toBe(true);
    expect(d.span.start.line).toBeGreaterThanOrEqual(1);
    expect(d.span.start.line).toBeLessThanOrEqual(lines);
    expect(d.span.start.col).toBeGreaterThanOrEqual(1);
  }
}

/** Only the documented errors may escape `f`. */
function documentedOnly<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch (e) {
    if (e instanceof CadScriptEditError || e instanceof CadScriptPrintError) return undefined;
    throw e;
  }
}

describe("property: malformed or deeply nested source never throws", () => {
  it("compile(), typecheck(), print() and applyIrEdit() return or throw only their documented errors", () => {
    fc.assert(
      fc.property(malformedSource, irEdit, ({ ir, source }, edit) => {
        const r = compile(source, { base: ir });
        expectWellFormed(r, source);
        // Deterministic, even after an overflow. (Not toStrictEqual: a curve id "constructor" is an
        // own key of `curveSpans`, which toStrictEqual mistakes for the object's class.)
        expect(isDeepStrictEqual(compile(source, { base: ir }), r)).toBe(true);
        for (const d of typecheck(source)) expect(/^TS\d+$/.test(d.code) || d.code === "CS_TOO_COMPLEX", d.code).toBe(true);
        if (r.ir) {
          const printed = print(r.ir);
          expect(compile(printed, { base: r.ir }).ir).toStrictEqual(r.ir);
        }
        // Splice an unrelated edit into the malformed source, against both IRs.
        for (const [before, after] of [[ir, edit.after], [r.ir ?? ir, ir], [edit.before, edit.after]] as const) {
          const out = documentedOnly(() => applyIrEdit(source, before, after));
          if (out !== undefined) expectWellFormed(compile(out, { base: after }), out);
        }
      }),
      { ...RUNS, numRuns: Math.max(20, Math.floor(RUNS.numRuns / 3)) },
    );
  });

  it("print() of malformed IR returns compilable source or throws CadScriptPrintError", () => {
    const weird = fc.oneof(
      fc.constantFrom("", "part", "const", "__proto__", "(".repeat(5000), "`${", "\u2028", "a b", "😀", "x".repeat(10000)),
      fc.string({ unit: "binary", maxLength: 8 }),
    );
    const number = fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -0, 1e308, -1e-320, 0);
    const malformedIr = fc.tuple(irDocument, weird, weird, number, fc.nat()).map(([ir, name, other, n, k]) => {
      const doc = structuredClone(ir);
      const part = doc.parts[k % doc.parts.length]!;
      const f = part.features[k % Math.max(1, part.features.length)];
      switch (k % 5) {
        case 0:
          part.name = name;
          break;
        case 1:
          if (f) f.name = name;
          break;
        case 2:
          if (f && f.type !== "sketch") f.sketch = name;
          break;
        case 3:
          if (f?.type === "extrude") f.distance = n;
          else if (f?.type === "revolve") f.angle = n;
          else if (f?.type === "sketch" && f.curves[0]?.kind === "circle") f.curves[0].radius = n;
          break;
        default:
          doc.meta = { name, description: other };
      }
      return doc;
    });
    fc.assert(
      fc.property(malformedIr, (ir) => {
        const source = documentedOnly(() => print(ir));
        if (source !== undefined) expectWellFormed(compile(source, { base: ir }), source);
      }),
      RUNS,
    );
  });
});
