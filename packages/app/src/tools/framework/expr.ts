/**
 * Number fields: what the user types (`12`, `12 mm`, `0.5 in`, `30°`, `wall * 2`) → a checked
 * {@link NumberValue}.
 *
 * Parsing, the canonical text and the unit check are CadScript v1's own (`parseExpr`,
 * `checkAtField`, `printExpr`: the SPEC-v1 §2.3–§2.5 port that the I9 conformance suite checks), so
 * a field accepts exactly what the IR accepts. The **value** computed here is a display hint and a
 * quick range check only: SPEC-v1 §2.7 makes Forge the evaluator of record, so a tool writes the
 * canonical expression (or the literal) and the preview/commit asks Forge.
 */
import { v1 } from "@aicad/cadscript";
import type { FieldError, NumberFieldSpec, NumberValue, ParamInfo, Quantity } from "./types";

type Expr = v1.Expr;

/** The unit a quantity is shown in. */
export function unitLabel(q: Quantity): string {
  return q === "length" ? "mm" : q === "angle" ? "°" : "";
}

const FIELD_TYPE: Record<Quantity, v1.FieldType> = { length: "length", angle: "angle", count: "count", ratio: "ratio" };

/** `12.5`, `0.1`, `3.4142`: at most 4 decimals, no trailing zeros, no `-0`. */
export function formatNumber(v: number, decimals = 4): string {
  if (!Number.isFinite(v)) return String(v);
  const fixed = v.toFixed(decimals);
  const s = fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
  return s === "-0" ? "0" : s;
}

/** A value with its unit, e.g. `3.41 mm`, `30°`, `4`. */
export function formatQuantity(v: number, q: Quantity, decimals = 4): string {
  const n = formatNumber(v, decimals);
  return q === "length" ? `${n} mm` : q === "angle" ? `${n}°` : n;
}

/** Friendlier spellings the IR grammar does not have: `30°` → `30 deg`, `1"` stays an error. */
function normalizeText(text: string): string {
  return text.replace(/°/g, " deg").replace(/\s+/g, " ").trim();
}

function isLiteral(e: Expr): boolean {
  return e.k === "num" || (e.k === "un" && e.op === "-" && e.e.k === "num");
}

class EvalFail extends Error {}

const DEG = Math.PI / 180;

/** Degree trig as SPEC-v1 §2.7 rule 4 describes it (exact at multiples of 30° and 45°). */
function sinCosDeg(x: number): [number, number] {
  let r = ((x % 360) + 360) % 360;
  if (r === 360) r = 0;
  const q = r >= 270 ? 3 : r >= 180 ? 2 : r >= 90 ? 1 : 0;
  const s = r - 90 * q;
  const table: Record<number, [number, number]> = { 0: [0, 1], 30: [0.5, 0.8660254037844386], 45: [0.7071067811865476, 0.7071067811865476], 60: [0.8660254037844386, 0.5] };
  const [sn, cs] = table[s] ?? [Math.sin(s * DEG), Math.cos(s * DEG)];
  switch (q) {
    case 0:
      return [sn, cs];
    case 1:
      return [cs, -sn];
    case 2:
      return [-sn, -cs];
    default:
      return [-cs, sn];
  }
}

function finite(v: number, what: string): number {
  if (!Number.isFinite(v)) throw new EvalFail(`${what} is not a finite number`);
  return v === 0 ? 0 : v;
}

/**
 * Evaluate a checked expression. Returns null when it names a parameter whose value is not known
 * here (not evaluated yet); throws {@link EvalFail} for domain errors (÷0, √−1, …).
 */
function evaluate(e: Expr, lookup: (name: string) => number | boolean | null): number | boolean | null {
  const num = (x: Expr): number | null => {
    const v = evaluate(x, lookup);
    return v === null ? null : typeof v === "boolean" ? (v ? 1 : 0) : v;
  };
  switch (e.k) {
    case "num":
      return e.unit === "cm" ? e.v * 10 : e.unit === "in" ? e.v * 25.4 : e.v;
    case "bool":
      return e.v;
    case "name":
      if (e.name === "PI") return Math.PI;
      return lookup(e.name);
    case "un": {
      const v = evaluate(e.e, lookup);
      if (v === null) return null;
      return e.op === "!" ? !v : finite(-(v as number), "the result");
    }
    case "cond": {
      const c = evaluate(e.c, lookup);
      if (c === null) return null;
      return evaluate(c ? e.t : e.f, lookup);
    }
    case "bin": {
      if (e.op === "&&" || e.op === "||") {
        const l = evaluate(e.l, lookup);
        if (l === null) return null;
        if (e.op === "&&" ? !l : l) return l;
        return evaluate(e.r, lookup);
      }
      const a = num(e.l);
      const b = num(e.r);
      if (a === null || b === null) return null;
      switch (e.op) {
        case "+":
          return finite(a + b, "the sum");
        case "-":
          return finite(a - b, "the difference");
        case "*":
          return finite(a * b, "the product");
        case "/":
          if (b === 0) throw new EvalFail("division by zero");
          return finite(a / b, "the quotient");
        case "%":
          if (b === 0) throw new EvalFail("remainder by zero");
          return finite(a % b, "the remainder");
        case "^":
          if (a < 0 && !Number.isInteger(b)) throw new EvalFail("a negative number to a fractional power");
          if (a === 0 && b < 0) throw new EvalFail("zero to a negative power");
          return finite(a ** b, "the power");
        case "<":
          return a < b;
        case "<=":
          return a <= b;
        case ">":
          return a > b;
        case ">=":
          return a >= b;
        case "==":
          return a === b;
        case "!=":
          return a !== b;
      }
      return null;
    }
    case "call": {
      const args = e.args.map(num);
      if (args.some((a) => a === null)) return null;
      const v = args as number[];
      const [x = 0, y = 0, z = 0] = v;
      switch (e.fn) {
        case "min":
          return Math.min(...v);
        case "max":
          return Math.max(...v);
        case "abs":
          return Math.abs(x);
        case "sqrt":
          if (x < 0) throw new EvalFail("the square root of a negative number");
          return Math.sqrt(x);
        case "floor":
          return Math.floor(x);
        case "ceil":
          return Math.ceil(x);
        case "round":
          return Math.round(x);
        case "clamp":
          return Math.min(Math.max(x, y), z);
        case "hypot":
          return Math.hypot(x, y);
        case "sin":
          return sinCosDeg(x)[0];
        case "cos":
          return sinCosDeg(x)[1];
        case "tan": {
          const [s, c] = sinCosDeg(x);
          if (c === 0) throw new EvalFail("tan of an odd multiple of 90°");
          return s / c;
        }
        case "asin":
          if (x < -1 || x > 1) throw new EvalFail("asin outside [-1, 1]");
          return Math.asin(x) / DEG;
        case "acos":
          if (x < -1 || x > 1) throw new EvalFail("acos outside [-1, 1]");
          return Math.acos(x) / DEG;
        case "atan":
          return Math.atan(x) / DEG;
        case "atan2":
          return Math.atan2(x, y) / DEG;
      }
      return null;
    }
  }
}

export interface NumberCheck {
  value: NumberValue;
  /** The first problem with the text, or null. */
  error: FieldError | null;
  /** `= 12.7 mm` when the text is not already the plain value; null otherwise. */
  resolved: string | null;
}

/**
 * Check what was typed into a number field against its spec and the document's parameters.
 * Never throws.
 */
export function checkNumberText(text: string, spec: NumberFieldSpec, params: readonly ParamInfo[]): NumberCheck {
  const empty: NumberValue = { text, value: null, expression: false, canonical: null };
  const fail = (code: string, message: string, feasible?: FieldError["feasible"]): NumberCheck => ({
    value: empty,
    error: { field: spec.key, code, message, ...(feasible ? { feasible } : {}) },
    resolved: null,
  });
  const norm = normalizeText(text);
  if (norm === "") {
    return spec.optional ? { value: empty, error: null, resolved: null } : fail("REQUIRED", `Enter ${spec.label.toLowerCase()}.`);
  }
  const parsed = v1.parseExpr(norm);
  if (!parsed.ok) return fail("EXPR_SYNTAX", `Not a number or expression (${parsed.problem.message}).`);
  const ast = parsed.ast;
  const literal = isLiteral(ast);
  if (spec.expressions === false && !literal) return fail("EXPR_NOT_ALLOWED", "Type a number here (expressions are not allowed in this field).");
  const byName = new Map(params.map((p) => [p.name, p]));
  const env: v1.TypeEnv = {
    lookup: (name) => {
      const p = byName.get(name);
      return p ? { kind: "param", unit: p.unit } : { kind: "unknown" };
    },
    names: () => params.map((p) => p.name),
  };
  const checked = v1.checkAtField(ast, FIELD_TYPE[spec.quantity], env);
  if (!checked.ok) {
    const p = checked.problem;
    if (p.code === "EXPR_UNKNOWN_NAME") {
      const similar = Array.isArray(p.details["similar"]) ? (p.details["similar"] as string[]) : [];
      const name = String(p.details["name"] ?? "");
      return fail(p.code, `No parameter named “${name}”.${similar.length ? ` Did you mean ${similar.map((s) => `“${s}”`).join(", ")}?` : ""}`);
    }
    if (p.code === "EXPR_UNIT_MISMATCH") {
      const want = spec.quantity === "length" ? "a length (mm, cm, in)" : spec.quantity === "angle" ? "an angle (deg)" : "a plain number";
      return fail(p.code, `Needs ${want}: ${p.message}.`);
    }
    return fail(p.code, `${p.message}.`);
  }
  const canonical = v1.printExpr(ast);
  let value: number | null;
  try {
    const v = evaluate(ast, (name) => byName.get(name)?.value ?? null);
    value = typeof v === "boolean" ? null : v;
  } catch (e) {
    return fail("EXPR_DOMAIN", `Cannot evaluate: ${e instanceof Error ? e.message : String(e)}.`);
  }
  const result: NumberValue = { text, value, expression: !literal, canonical };
  if (value !== null) {
    if (spec.quantity === "count" && !Number.isInteger(value)) {
      return { value: result, error: { field: spec.key, code: "EXPR_NOT_INTEGER", message: `Needs a whole number (this is ${formatNumber(value)}).` }, resolved: null };
    }
    const tooLow = spec.min !== undefined && (spec.minExclusive ? value <= spec.min : value < spec.min);
    const tooHigh = spec.max !== undefined && value > spec.max;
    if (tooLow || tooHigh) {
      const feasible = { ...(spec.min !== undefined ? { min: spec.min } : {}), ...(spec.max !== undefined ? { max: spec.max } : {}) };
      const bound = tooLow
        ? `${spec.minExclusive ? "more than" : "at least"} ${formatQuantity(spec.min!, spec.quantity)}`
        : `at most ${formatQuantity(spec.max!, spec.quantity)}`;
      return { value: result, error: { field: spec.key, code: "OUT_OF_RANGE", message: `Must be ${bound}.`, feasible }, resolved: null };
    }
  }
  const plain = value !== null && normalizeText(text) === formatNumber(value);
  const resolved = value === null ? (literal ? null : "= ? (evaluated by Forge)") : plain ? null : `= ${formatQuantity(value, spec.quantity)}`;
  return { value: result, error: null, resolved };
}

/** The value nearest to `v` inside a feasible range (for "Use 3.41 mm"). */
export function clampToRange(v: number, range: { min?: number; max?: number }): number {
  let out = v;
  if (range.min !== undefined && out < range.min) out = range.min;
  if (range.max !== undefined && out > range.max) out = range.max;
  return out;
}

/** Step a plain number by `delta` (arrow keys); expressions are left alone (returns null). */
export function stepNumberText(text: string, delta: number): string | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(mm|cm|in|deg|°)?\s*$/.exec(text);
  if (!m) return null;
  const decimals = Math.max((m[1]!.split(".")[1] ?? "").length, (String(delta).split(".")[1] ?? "").length);
  const next = Number(m[1]) + delta;
  const unit = m[2] ? (m[2] === "°" ? "°" : ` ${m[2]}`) : "";
  return `${formatNumber(next, Math.min(decimals, 6))}${unit}`;
}
