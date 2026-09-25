import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evalCount, evalNumber, evalScalar, evalVector, paramValues, sinCosDeg, type Evaluated, type ScalarValue } from "../src/v1/expr.js";
import { reportV1 } from "./helpers.js";

const params = new Map<string, number | boolean>([
  ["width", 80],
  ["wall", 2],
  ["holes", 4],
  ["tilt", 30],
  ["lid", true],
]);

function num(text: string | number): number {
  const r = evalNumber(text, params);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

describe("evalScalar (measurement evaluator for IR v1 Scalars)", () => {
  it("passes literals through and evaluates arithmetic over parameters", () => {
    expect(num(4)).toBe(4);
    expect(num("width - 2 * wall")).toBe(76);
    expect(num("(width - 12) / (holes - 1)")).toBeCloseTo(68 / 3, 12);
    expect(num("wall ^ 3")).toBe(8);
    expect(num("-wall ^ 2")).toBe(-4);
    expect(num("width % 7")).toBe(80 % 7);
  });

  it("converts unit literals to mm and degrees", () => {
    expect(num("2 cm")).toBe(20);
    expect(num("1 in")).toBeCloseTo(25.4, 12);
    expect(num("12 mm + 3")).toBe(15);
    expect(num("30 deg")).toBe(30);
  });

  it("evaluates the SPEC functions, trigonometry in degrees", () => {
    expect(num("min(3, width, wall)")).toBe(2);
    expect(num("max(3, width, wall)")).toBe(80);
    expect(num("clamp(width, 10, 50)")).toBe(50);
    expect(num("hypot(3, 4)")).toBe(5);
    expect(num("round(2.5)")).toBe(3);
    expect(num("round(-2.5)")).toBe(-3);
    expect(num("10 * sin(tilt)")).toBeCloseTo(5, 12);
    expect(num("atan2(1, 1)")).toBeCloseTo(45, 12);
    expect(num("acos(0.5)")).toBeCloseTo(60, 12);
    expect(num("PI")).toBe(Math.PI);
  });

  it("evaluates conditionals and booleans, short-circuiting the branch not taken", () => {
    expect(num("lid ? 3 : 0")).toBe(3);
    expect(num("holes > 2 && !lid ? 1 : 2")).toBe(2);
    expect(num("false ? nosuch : 7")).toBe(7);
    expect(evalScalar("width == 80", params)).toEqual({ ok: true, value: true });
  });

  it("returns a reason instead of a number when it cannot evaluate", () => {
    for (const [text, reason] of [
      ["nosuch + 1", /no evaluated parameter named nosuch/],
      ["width / (wall - 2)", /division by zero/],
      ["sqrt(-1)", /sqrt/],
      ["frobnicate(1)", /unknown function/],
      ["width +", /cannot parse/],
      ["lid + 1", /boolean/],
    ] as const) {
      const r = evalNumber(text, params);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(reason);
    }
    expect(evalNumber("lid", params)).toMatchObject({ ok: false });
    expect(evalScalar({ not: "a scalar" }, params)).toMatchObject({ ok: false });
  });

  it("evaluates vectors component-wise", () => {
    expect(evalVector([0, "wall", "width / 2"], params)).toEqual({ ok: true, value: [0, 2, 40] });
    expect(evalVector([0, "nosuch"], params)).toMatchObject({ ok: false });
  });

  it("reads parameter values from the report: document parameters and the part's own, not failed ones", () => {
    const r = reportV1([], {
      params: [
        { name: "width", scope: "doc", unit: "mm", value: 80 },
        { name: "wall", scope: "box", unit: "mm", value: 2 },
        { name: "other", scope: "lid", unit: "mm", value: 9 },
        { name: "broken", scope: "doc", unit: "mm", error: { code: "EXPR_DOMAIN", message: "x" } },
      ],
    });
    const v = paramValues(r, "box");
    expect([...v.keys()].sort()).toEqual(["wall", "width"]);
    expect(evalNumber("broken + 1", v)).toMatchObject({ ok: false });
  });
});

/** The I9 expression conformance suite (SPEC-v1 §2.3–§2.7), shared by Rust, Python and TypeScript. */
interface ConformanceCase {
  id: string;
  text: string;
  field: "length" | "angle" | "ratio" | "count" | "bool";
  value?: number | boolean;
  bits?: string;
  tolerance_rel?: number;
  error?: { code: string; stage: "R" | "E" };
}
const SUITE = JSON.parse(readFileSync(fileURLToPath(new URL("../../../corpus/v1/conformance/expressions/cases.json", import.meta.url)), "utf8")) as {
  params: { name: string; unit: string; value: number | boolean }[];
  cases: ConformanceCase[];
};

function bitsOf(x: number): string {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  return `0x${v.getBigUint64(0).toString(16).padStart(16, "0")}`;
}

describe("the measurement evaluator against the I9 expression conformance suite", () => {
  const env = new Map<string, number | boolean>(SUITE.params.map((p) => [p.name, p.value]));
  const evalCase = (c: ConformanceCase): Evaluated<ScalarValue> => (c.field === "count" ? evalCount(c.text, env) : evalScalar(c.text, env));

  it("has the suite's cases", () => {
    expect(SUITE.cases.length).toBeGreaterThanOrEqual(700);
  });

  it("evaluates every exactly specified case bit for bit", () => {
    const bad: string[] = [];
    let n = 0;
    for (const c of SUITE.cases.filter((x) => x.bits !== undefined)) {
      n++;
      const r = evalCase(c);
      if (!r.ok) bad.push(`${c.id} ${c.text}: ${r.reason}`);
      else if (typeof r.value !== "number" || bitsOf(r.value) !== c.bits) bad.push(`${c.id} ${c.text}: ${String(r.value)} (${typeof r.value === "number" ? bitsOf(r.value) : "bool"}) vs ${c.value} (${c.bits})`);
    }
    expect(bad).toEqual([]);
    expect(n).toBeGreaterThanOrEqual(400);
  });

  it("evaluates every libm case within its tolerance, and every boolean case", () => {
    const bad: string[] = [];
    for (const c of SUITE.cases.filter((x) => x.bits === undefined && x.value !== undefined)) {
      const r = evalCase(c);
      if (!r.ok) {
        bad.push(`${c.id} ${c.text}: ${r.reason}`);
      } else if (typeof c.value === "boolean") {
        if (r.value !== c.value) bad.push(`${c.id} ${c.text}: ${String(r.value)} vs ${c.value}`);
      } else if (typeof r.value !== "number" || Math.abs(r.value - c.value!) > (c.tolerance_rel ?? 0) * Math.max(1, Math.abs(c.value!))) {
        bad.push(`${c.id} ${c.text}: ${String(r.value)} vs ${c.value} (tolerance_rel ${c.tolerance_rel})`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("fails every evaluation-stage error with its code (EXPR_DOMAIN, EXPR_NOT_INTEGER) instead of measuring", () => {
    const cases = SUITE.cases.filter((x) => x.error?.stage === "E");
    expect(cases.length).toBeGreaterThanOrEqual(50);
    expect(new Set(cases.map((c) => c.error!.code))).toEqual(new Set(["EXPR_DOMAIN", "EXPR_NOT_INTEGER"]));
    const wrong = cases
      .map((c) => [c, evalCase(c)] as const)
      .filter(([c, r]) => r.ok || r.code !== c.error!.code)
      .map(([c, r]) => `${c.id} ${c.text}: expected ${c.error!.code}, got ${r.ok ? `the value ${JSON.stringify(r.value)}` : `${r.code ?? "no code"} (${r.reason})`}`);
    expect(wrong).toEqual([]);
  });

  it("gives no evaluation code to what is not an evaluation error (the measurement's own limits)", () => {
    for (const text of ["nosuch + 1", "frobnicate(1)", "lid + 1", "width +"]) {
      const r = evalNumber(text, params);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.code, text).toBeUndefined();
    }
    expect(evalNumber("width / (wall - 2)", params)).toMatchObject({ ok: false, code: "EXPR_DOMAIN" });
    expect(evalCount("width / 3", params)).toMatchObject({ ok: false, code: "EXPR_NOT_INTEGER" });
  });

  it("never throws on the validation-stage rejections (validation keeps them from the checks)", () => {
    for (const c of SUITE.cases.filter((x) => x.error?.stage === "R")) expect(() => evalCase(c), c.id).not.toThrow();
  });

  it("reduces degrees exactly: the table angles in every quadrant, and a tiny negative angle", () => {
    expect(sinCosDeg(390)).toEqual([0.5, 0.8660254037844386]);
    expect(sinCosDeg(150)).toEqual([0.5, -0.8660254037844386]);
    expect(sinCosDeg(-90)).toEqual([-1, 0]);
    // [W0-5]: a tiny negative angle whose rem_euclid rounds up to exactly 360 is the angle 0.
    expect(sinCosDeg(-1e-20)).toEqual([0, 1]);
    expect(sinCosDeg(-1e-13)[0]).toBeLessThan(0);
    expect(evalNumber("tan(90)", env)).toMatchObject({ ok: false });
    expect(evalNumber("2 ^ -1080", env)).toEqual({ ok: true, value: 0 });
    expect(evalCount("holes / 3", env)).toMatchObject({ ok: false });
  });
});
