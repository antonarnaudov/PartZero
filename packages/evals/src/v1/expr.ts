/**
 * A **measurement** evaluator for IR v1 Scalars (SPEC-v1 §2.3–§2.7): the hidden-test DSL needs
 * the value of a feature field (a fillet radius, a shell thickness, a pattern spacing) that the
 * `aicad.metrics/1` report does not repeat. Parameters come from the engine's own report
 * (`params[].value`), so an engine's parameter evaluation is never second-guessed; only the field
 * expression itself is evaluated here.
 *
 * Forge is the evaluator of record (§2.7); this one follows its rules so a measurement cannot
 * drift from what the engines built: the exactly specified operations, `^` by binary
 * exponentiation for integer exponents (rule 3), degree trigonometry through the exact
 * quadrant reduction and table of rule 4, the exact inverse results of rule 5, `−0 → +0`
 * (rule 8) and count integrality (rule 9, {@link evalCount}). What goes through libm (non-table
 * sin/cos, the inverse functions elsewhere, `hypot`, non-integer powers) uses `Math`, which is
 * within the conformance suite's `tolerance_rel` of the reference. `test/v1-expr.test.ts` runs
 * the I9 expression conformance suite (`corpus/v1/conformance/expressions`) through it: bit for
 * bit where the suite gives `bits`, within `tolerance_rel` where it does not, and a failure for
 * every evaluation-stage error. There is no type checker here: validation (stage R) rejects
 * ill-typed documents before a check sees them. Any expression it cannot evaluate yields a
 * reason instead of a number, so a check fails loudly rather than measuring something wrong.
 */
import { v1 as cs } from "@aicad/cadscript";
import type { metricsV1 } from "@aicad/ir-types";

type Expr = cs.Expr;

export type ScalarValue = number | boolean;
/**
 * The SPEC's evaluation-stage expression codes (§2.7, stage E): what an engine reports for an
 * expression that parses and type-checks but cannot be evaluated.
 */
export type ExprErrorCode = "EXPR_DOMAIN" | "EXPR_NOT_INTEGER";
/**
 * A measured value, or why there is none. `code` is set when the reason is one of the SPEC's
 * evaluation errors (an engine fails the same expression with that code); a reason without one
 * is this evaluator's own limit (an unknown name, a wrong type: validation rejects those first).
 */
export type Evaluated<T = number> = { ok: true; value: T } | { ok: false; reason: string; code?: ExprErrorCode };

/** Parameter values visible to one part: that part's parameters over the document's. */
export type ParamValues = ReadonlyMap<string, ScalarValue>;

/**
 * The parameter values of a report as seen from part `part` (by part name): document parameters,
 * then that part's parameters (a part parameter shadows nothing in valid documents: names are
 * unique, SPEC-v1 §0.3). Failed parameters are absent.
 */
export function paramValues(report: metricsV1.EvalReport, part?: string): Map<string, ScalarValue> {
  const out = new Map<string, ScalarValue>();
  for (const p of report.params ?? []) {
    if (p.value === undefined || p.value === null) continue;
    if (p.scope === "doc" || p.scope === part) out.set(p.name, p.value as ScalarValue);
  }
  return out;
}

const UNIT_FACTOR: Record<string, number> = { mm: 1, cm: 10, in: 25.4, deg: 1 };

class EvalFail extends Error {
  constructor(
    message: string,
    readonly code?: ExprErrorCode,
  ) {
    super(message);
  }
}

/** An `EXPR_DOMAIN` failure (§2.7): the operation has no finite result for these operands. */
class DomainFail extends EvalFail {
  constructor(message: string) {
    super(message, "EXPR_DOMAIN");
  }
}

function num(v: ScalarValue, what: string): number {
  if (typeof v !== "number") throw new EvalFail(`${what} is a boolean, not a number`);
  return v;
}

function bool(v: ScalarValue, what: string): boolean {
  if (typeof v !== "boolean") throw new EvalFail(`${what} is a number, not a boolean`);
  return v;
}

function finite(x: number, what: string): number {
  if (!Number.isFinite(x)) throw new DomainFail(`${what} is not finite`);
  return x === 0 ? 0 : x; // −0 → +0 (§2.7 rule 8)
}

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  min: (a) => a.reduce((m, x) => (x < m ? x : m)),
  max: (a) => a.reduce((m, x) => (x > m ? x : m)),
  abs: ([x]) => Math.abs(x!),
  sqrt: ([x]) => {
    if (x! < 0) throw new DomainFail("sqrt of a negative number");
    return Math.sqrt(x!);
  },
  floor: ([x]) => Math.floor(x!),
  ceil: ([x]) => Math.ceil(x!),
  round: ([x]) => (x! < 0 ? -Math.round(-x!) : Math.round(x!)), // halves away from zero
  clamp: ([x, lo, hi]) => {
    if (lo! > hi!) throw new DomainFail("clamp with lo > hi");
    return Math.min(Math.max(x!, lo!), hi!);
  },
  hypot: ([a, b]) => Math.hypot(a!, b!),
  sin: ([x]) => sinCosDeg(x!)[0],
  cos: ([x]) => sinCosDeg(x!)[1],
  tan: ([x]) => {
    const [sn, cs] = sinCosDeg(x!);
    if (cs === 0) throw new DomainFail("tan where cos is 0");
    return sn / cs;
  },
  asin: ([x]) => {
    if (Math.abs(x!) > 1) throw new DomainFail("asin outside [-1, 1]");
    const exact = ASIN_EXACT.get(Math.abs(x!));
    return exact !== undefined ? Math.sign(x!) * exact : Math.asin(x!) * DEG_PER_RAD;
  },
  acos: ([x]) => {
    if (Math.abs(x!) > 1) throw new DomainFail("acos outside [-1, 1]");
    return ACOS_EXACT.get(x!) ?? Math.acos(x!) * DEG_PER_RAD;
  },
  atan: ([x]) => (x === 0 ? 0 : Math.abs(x!) === 1 ? Math.sign(x!) * 45 : Math.atan(x!) * DEG_PER_RAD),
  atan2: ([y, x]) => {
    if (y === 0 && x === 0) throw new DomainFail("atan2(0, 0)");
    if (y === 0) return x! > 0 ? 0 : 180; // atan2(±0, x < 0) = 180 (range (−180, 180])
    if (x === 0) return y! > 0 ? 90 : -90;
    if (Math.abs(y!) === Math.abs(x!)) return Math.sign(y!) * (x! > 0 ? 45 : 135);
    const d = Math.atan2(y!, x!) * DEG_PER_RAD;
    return d === -180 ? 180 : d; // [W0-22]
  },
};

/** §2.7 rule 5: the f64 nearest 180/π. */
const DEG_PER_RAD = 57.29577951308232;
/** §2.7 rule 4: the f64 nearest π/180. */
const RAD_PER_DEG = 0.017453292519943295;
/** §2.7 rule 4: (sin s, cos s) for the table angles, correctly rounded. */
const SIN_COS_TABLE = new Map<number, [number, number]>([
  [0, [0, 1]],
  [30, [0.5, 0.8660254037844386]],
  [45, [0.7071067811865476, 0.7071067811865476]],
  [60, [0.8660254037844386, 0.5]],
]);
/** §2.7 rule 5: exact asin results, by |x|. */
const ASIN_EXACT = new Map<number, number>([
  [0, 0],
  [0.5, 30],
  [1, 90],
]);
/** §2.7 rule 5: exact acos results. */
const ACOS_EXACT = new Map<number, number>([
  [1, 0],
  [0.5, 60],
  [0, 90],
  [-0.5, 120],
  [-1, 180],
]);

/**
 * `(sin x, cos x)` of `x` degrees by §2.7 rule 4: `x rem_euclid 360` (a tiny negative `x` that
 * rounds up to 360 is 0, [W0-5]), the quadrant `q` and remainder `s = r − 90·q` (both exact),
 * the table for `s ∈ {0, 30, 45, 60}` and libm otherwise, then the exact quadrant rotation.
 */
export function sinCosDeg(x: number): [number, number] {
  let r = x % 360;
  if (r < 0) r += 360;
  if (r === 360) r = 0;
  const q = r >= 270 ? 3 : r >= 180 ? 2 : r >= 90 ? 1 : 0;
  const sr = r - 90 * q;
  const [sn, cs] = SIN_COS_TABLE.get(sr) ?? [Math.sin(sr * RAD_PER_DEG), Math.cos(sr * RAD_PER_DEG)];
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

/** `a ^ b` by §2.7 rule 3: binary exponentiation for an integer `|b| ≤ 64`, libm otherwise. */
function power(a: number, b: number): number {
  if (Number.isInteger(b) && Math.abs(b) <= 64) {
    let r = 1;
    let p = a;
    let n = Math.abs(b);
    for (;;) {
      if (n % 2 === 1) r *= p;
      n = Math.floor(n / 2);
      if (n === 0) break;
      p *= p;
    }
    if (b >= 0) return r;
    if (r === 0) throw new DomainFail("a power of 0 with a negative exponent");
    return 1 / r; // an overflowed r gives ±0 → 0 ([W0-23])
  }
  if (a < 0) throw new DomainFail("a negative base with a non-integer exponent");
  if (a === 0 && b < 0) throw new DomainFail("a power of 0 with a negative exponent");
  return a ** b;
}

const ARITY: Record<string, [number, number]> = {
  min: [2, Infinity],
  max: [2, Infinity],
  abs: [1, 1],
  sqrt: [1, 1],
  floor: [1, 1],
  ceil: [1, 1],
  round: [1, 1],
  clamp: [3, 3],
  hypot: [2, 2],
  sin: [1, 1],
  cos: [1, 1],
  tan: [1, 1],
  asin: [1, 1],
  acos: [1, 1],
  atan: [1, 1],
  atan2: [2, 2],
};

function evalNode(e: Expr, params: ParamValues): ScalarValue {
  switch (e.k) {
    case "num":
      return finite(e.v * (e.unit ? UNIT_FACTOR[e.unit]! : 1), "a unit literal");
    case "bool":
      return e.v;
    case "name": {
      if (e.name === "PI") return Math.PI;
      const v = params.get(e.name);
      if (v === undefined) throw new EvalFail(`no evaluated parameter named ${e.name}`);
      return v;
    }
    case "call": {
      const fn = FUNCTIONS[e.fn];
      const arity = ARITY[e.fn];
      if (!fn || !arity) throw new EvalFail(`unknown function ${e.fn}`);
      if (e.args.length < arity[0] || e.args.length > arity[1]) throw new EvalFail(`${e.fn} takes ${arity[0]} argument(s)`);
      return finite(
        fn(e.args.map((a) => num(evalNode(a, params), `an argument of ${e.fn}`))),
        `${e.fn}(…)`,
      );
    }
    case "un": {
      const v = evalNode(e.e, params);
      return e.op === "-" ? finite(-num(v, "the operand of -"), "-x") : !bool(v, "the operand of !");
    }
    case "cond":
      return bool(evalNode(e.c, params), "a condition") ? evalNode(e.t, params) : evalNode(e.f, params);
    case "bin": {
      if (e.op === "&&") return bool(evalNode(e.l, params), "&&") && bool(evalNode(e.r, params), "&&");
      if (e.op === "||") return bool(evalNode(e.l, params), "||") || bool(evalNode(e.r, params), "||");
      const l = evalNode(e.l, params);
      const r = evalNode(e.r, params);
      if (e.op === "==") return l === r;
      if (e.op === "!=") return l !== r;
      const a = num(l, `the left operand of ${e.op}`);
      const b = num(r, `the right operand of ${e.op}`);
      switch (e.op) {
        case "+":
          return finite(a + b, "a sum");
        case "-":
          return finite(a - b, "a difference");
        case "*":
          return finite(a * b, "a product");
        case "/":
          if (b === 0) throw new DomainFail("division by zero");
          return finite(a / b, "a quotient");
        case "%":
          if (b === 0) throw new DomainFail("% by zero");
          return finite(a % b, "a remainder");
        case "^":
          return finite(power(a, b), "a power");
        case "<":
          return a < b;
        case "<=":
          return a <= b;
        case ">":
          return a > b;
        case ">=":
          return a >= b;
      }
    }
  }
  throw new EvalFail("unsupported expression");
}

/** Evaluate a Scalar field value (a literal, or an expression string) with `params`. */
export function evalScalar(v: unknown, params: ParamValues): Evaluated<ScalarValue> {
  if (typeof v === "number" || typeof v === "boolean") return { ok: true, value: v };
  if (typeof v !== "string") return { ok: false, reason: `not a scalar: ${JSON.stringify(v)}` };
  const parsed = cs.parseExpr(v);
  if (!parsed.ok) return { ok: false, reason: `cannot parse ${JSON.stringify(v)}: ${parsed.problem.message}` };
  try {
    return { ok: true, value: evalNode(parsed.ast, params) };
  } catch (e) {
    if (e instanceof EvalFail) {
      const out: Evaluated<ScalarValue> = { ok: false, reason: `cannot evaluate ${JSON.stringify(v)}: ${e.message}` };
      if (e.code) out.code = e.code;
      return out;
    }
    throw e;
  }
}

/** {@link evalScalar} for a numeric field. */
export function evalNumber(v: unknown, params: ParamValues): Evaluated {
  const r = evalScalar(v, params);
  if (!r.ok) return r;
  if (typeof r.value !== "number") return { ok: false, reason: `${JSON.stringify(v)} is a boolean, not a number` };
  return { ok: true, value: r.value };
}

/** §2.7 rule 9: the largest magnitude of a `count` value. */
const MAX_COUNT = 2 ** 31;

/** {@link evalNumber} for a `count` field: an exact integer with `|v| ≤ 2^31` (§2.7 rule 9). */
export function evalCount(v: unknown, params: ParamValues): Evaluated {
  const r = evalNumber(v, params);
  if (!r.ok) return r;
  if (!Number.isInteger(r.value) || Math.abs(r.value) > MAX_COUNT) return { ok: false, reason: `${JSON.stringify(v)} = ${r.value} is not an integer count (EXPR_NOT_INTEGER)`, code: "EXPR_NOT_INTEGER" };
  return r;
}

/** Evaluate a vector of Scalars (a P2 or P3). */
export function evalVector(v: unknown, params: ParamValues): Evaluated<number[]> {
  if (!Array.isArray(v)) return { ok: false, reason: `not a vector: ${JSON.stringify(v)}` };
  const out: number[] = [];
  for (const x of v) {
    const r = evalNumber(x, params);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return { ok: true, value: out };
}
