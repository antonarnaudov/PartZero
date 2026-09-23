/**
 * The TypeScript port of the IR v1 expression language against the I9 conformance suite
 * (`corpus/v1/conformance/expressions/cases.json`): parse, canonical text, static type and
 * rejection codes. (Values are Forge's: CadScript never evaluates, SPEC-v1 §2.7.)
 */
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkAtField,
  exprEquals,
  formatType,
  MAX_EXPR_DEPTH,
  parseExpr,
  printExpr,
  typeOf,
  type Expr,
  type FieldType,
  type ParamUnit,
  type TypeEnv,
} from "../../src/v1/expr.js";
import { CONFORMANCE, readJson } from "./helpers.js";

interface Case {
  id: string;
  text: string;
  field: FieldType;
  canonical?: string;
  type?: string;
  error?: { code: string; stage: "R" | "E" };
}

const suite = readJson(join(CONFORMANCE, "expressions/cases.json")) as {
  params: { name: string; unit: ParamUnit }[];
  cases: Case[];
};

export const envOf = (params: { name: string; unit: ParamUnit }[]): TypeEnv => ({
  lookup: (name) => {
    const p = params.find((x) => x.name === name);
    return p ? { kind: "param", unit: p.unit } : { kind: "unknown" };
  },
  names: () => params.map((p) => p.name),
});

const env = envOf(suite.params);

describe("expression conformance (I9, SPEC-v1 §2.3–§2.6)", () => {
  it("has the suite", () => {
    expect(suite.cases.length).toBeGreaterThanOrEqual(150);
  });

  for (const c of suite.cases) {
    const label = `${c.id}: ${JSON.stringify(c.text.length > 60 ? `${c.text.slice(0, 60)}…` : c.text)} at ${c.field}`;
    it(label, () => {
      const parsed = parseExpr(c.text);
      if (c.error?.code === "EXPR_SYNTAX") {
        expect(parsed.ok).toBe(false);
        return;
      }
      if (!parsed.ok) throw new Error(`unexpected syntax error: ${parsed.problem.message}`);
      if (c.canonical !== undefined) {
        expect(printExpr(parsed.ast)).toBe(c.canonical);
        // canonical is a fixed point of parse + print
        const again = parseExpr(c.canonical);
        expect(again.ok && exprEquals(again.ast, parsed.ast)).toBe(true);
      }
      const checked = checkAtField(parsed.ast, c.field, env);
      if (c.error?.stage === "R") {
        expect(checked.ok).toBe(false);
        if (!checked.ok) expect(checked.problem.code).toBe(c.error.code);
        return;
      }
      if (!checked.ok) throw new Error(`unexpected ${checked.problem.code}: ${checked.problem.message}`);
      if (c.type !== undefined) expect(formatType(checked.type)).toBe(c.type);
    });
  }
});

describe("expression details and limits", () => {
  it("reports EXPR_UNIT_MISMATCH with expected/found in type notation", () => {
    const r = parseExpr("width + holes");
    if (!r.ok) throw new Error("parse");
    const c = checkAtField(r.ast, "length", env);
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.problem.code).toBe("EXPR_UNIT_MISMATCH");
    expect(c.problem.details).toMatchObject({ expr: "width + holes", subexpr: "holes", expected: "mm", found: "1" });
    expect(printExpr(c.problem.node)).toBe("holes");
  });

  it("points at the offending sub-expression of a use-site mismatch", () => {
    const r = parseExpr("sin(tilt)");
    if (!r.ok) throw new Error("parse");
    const c = checkAtField(r.ast, "length", env);
    expect(!c.ok && c.problem.details).toMatchObject({ expected: "mm", found: "1", subexpr: "sin(tilt)" });
  });

  it("marks feature names used as values (is_feature)", () => {
    const r = parseExpr("base + 1");
    if (!r.ok) throw new Error("parse");
    const c = typeOf(r.ast, { lookup: (n) => (n === "base" ? { kind: "feature" } : { kind: "unknown" }), names: () => [] });
    expect(!c.ok && c.problem).toMatchObject({ code: "EXPR_UNKNOWN_NAME", details: { name: "base", is_feature: true } });
  });

  it("reports another part's parameter as EXPR_SCOPE", () => {
    const r = parseExpr("a * 2");
    if (!r.ok) throw new Error("parse");
    const c = typeOf(r.ast, { lookup: () => ({ kind: "other-part", part: "lid" }), names: () => [] });
    expect(!c.ok && c.problem).toMatchObject({ code: "EXPR_SCOPE", details: { name: "a", part: "lid" } });
  });

  it("accepts nesting up to MAX_EXPR_DEPTH and rejects deeper", () => {
    const nest = (n: number): string => `${"(".repeat(n)}1${")".repeat(n)}`;
    expect(parseExpr(nest(MAX_EXPR_DEPTH)).ok).toBe(true);
    expect(parseExpr(nest(MAX_EXPR_DEPTH + 1)).ok).toBe(false);
    expect(parseExpr(`${"-".repeat(MAX_EXPR_DEPTH)}1`).ok).toBe(true);
    expect(parseExpr(`${"-".repeat(MAX_EXPR_DEPTH + 1)}1`).ok).toBe(false);
    // binary chains are loops, not nesting
    expect(parseExpr(Array.from({ length: 500 }, () => "1").join(" + ")).ok).toBe(true);
  });

  it("gives EXPR_SYNTAX details: byte offset, and `lexes` only for well-lexed text", () => {
    const a = parseExpr("width +");
    expect(!a.ok && a.problem).toMatchObject({ offset: 7, lexes: true });
    const b = parseExpr("a # b");
    expect(!b.ok && b.problem).toMatchObject({ offset: 2, lexes: false });
    const c = parseExpr("é + #");
    expect(!c.ok && c.problem.offset).toBe(0);
  });
});

// ─── Properties ──────────────────────────────────────────────────────────────────────────────

const names = ["width", "depth", "holes", "tilt", "half", "lid", "off"];

/** Random ASTs over the full grammar (not necessarily well typed). */
export const exprArb: fc.Arbitrary<Expr> = fc.letrec<{ e: Expr }>((tie) => ({
  e: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.oneof(
      fc.double({ min: 0, max: 1e6, noNaN: true }).map((v): Expr => ({ k: "num", v: Object.is(v, -0) ? 0 : v })),
      fc.constantFrom(0, 1, 2, 0.5, 30, 1e21, 1e-7, 12.25).map((v): Expr => ({ k: "num", v })),
      fc.tuple(fc.constantFrom(1, 2.5, 12), fc.constantFrom("mm", "cm", "in", "deg" as const)).map(([v, unit]): Expr => ({ k: "num", v, unit })),
      fc.boolean().map((v): Expr => ({ k: "bool", v })),
      fc.constantFrom(...names, "PI").map((name): Expr => ({ k: "name", name })),
    ),
    fc.tuple(fc.constantFrom("-", "!" as const), tie("e")).map(([op, e]): Expr => ({ k: "un", op, e })),
    fc
      .tuple(fc.constantFrom("+", "-", "*", "/", "%", "^", "<", "<=", ">", ">=", "==", "!=", "&&", "||" as const), tie("e"), tie("e"))
      .map(([op, l, r]): Expr => ({ k: "bin", op, l, r })),
    fc.tuple(tie("e"), tie("e"), tie("e")).map(([c, t, f]): Expr => ({ k: "cond", c, t, f })),
    fc
      .tuple(fc.constantFrom("min", "max", "sin", "atan2", "clamp", "foo"), fc.array(tie("e"), { minLength: 0, maxLength: 3 }))
      .map(([fn, args]): Expr => ({ k: "call", fn, args })),
  ),
})).e;

describe("expression properties", () => {
  it("parse(canonical(ast)) == ast, and canonical is idempotent", () => {
    fc.assert(
      fc.property(exprArb, (ast) => {
        const text = printExpr(ast);
        const r = parseExpr(text);
        if (!r.ok) {
          // only the nesting limit may reject a printable AST
          expect(r.problem.message).toMatch(/nested|longer/);
          return;
        }
        expect(exprEquals(r.ast, ast)).toBe(true);
        expect(printExpr(r.ast)).toBe(text);
      }),
      { numRuns: 3000 },
    );
  });

  it("the type checker is deterministic and total", () => {
    fc.assert(
      fc.property(exprArb, fc.constantFrom<FieldType>("length", "angle", "ratio", "count", "bool"), (ast, field) => {
        const a = checkAtField(ast, field, env);
        const b = checkAtField(ast, field, env);
        expect(a.ok).toBe(b.ok);
        if (!a.ok && !b.ok) expect(a.problem.code).toBe(b.problem.code);
      }),
      { numRuns: 2000 },
    );
  });
});
