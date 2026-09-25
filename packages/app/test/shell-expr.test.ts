import { describe, expect, it } from "vitest";
import { checkNumberText, clampToRange, formatQuantity, stepNumberText } from "../src/tools/framework/expr";
import type { NumberFieldSpec, ParamInfo } from "../src/tools/framework/types";

const length: NumberFieldSpec = { kind: "number", key: "r", label: "Radius", quantity: "length", min: 0, minExclusive: true, max: 50 };
const angle: NumberFieldSpec = { kind: "number", key: "a", label: "Angle", quantity: "angle", min: 0, max: 360 };
const count: NumberFieldSpec = { kind: "number", key: "n", label: "Count", quantity: "count", min: 1 };
const params: ParamInfo[] = [
  { name: "wall", unit: "mm", value: 2 },
  { name: "width", unit: "mm", value: 80 },
  { name: "tilt", unit: "deg", value: 15 },
  { name: "holes", unit: "count", value: 4 },
  { name: "later", unit: "mm", value: null },
];

describe("number fields accept what the IR accepts", () => {
  it("takes a plain number as base units", () => {
    const r = checkNumberText("12.5", length, params);
    expect(r.error).toBeNull();
    expect(r.value).toMatchObject({ value: 12.5, expression: false, canonical: "12.5" });
    expect(r.resolved).toBeNull();
  });

  it("converts length units to millimetres and shows the resolved value", () => {
    const r = checkNumberText("0.5 in", length, params);
    expect(r.error).toBeNull();
    expect(r.value.value).toBeCloseTo(12.7, 12);
    expect(r.value.expression).toBe(false);
    expect(r.resolved).toBe("= 12.7 mm");
    expect(checkNumberText("1.5 cm", length, params).value.value).toBe(15);
  });

  it("accepts ° as degrees in an angle field", () => {
    const r = checkNumberText("30°", angle, params);
    expect(r.error).toBeNull();
    expect(r.value.value).toBe(30);
  });

  it("evaluates parameter expressions and keeps them as canonical IR text", () => {
    const r = checkNumberText("wall*2", length, params);
    expect(r.error).toBeNull();
    expect(r.value).toMatchObject({ value: 4, expression: true, canonical: "wall * 2" });
    expect(r.resolved).toBe("= 4 mm");
  });

  it("evaluates degree trigonometry exactly at table angles", () => {
    const r = checkNumberText("width * sin(30)", length, params);
    expect(r.value.value).toBe(40);
  });

  it("names the unknown parameter and suggests similar ones", () => {
    const r = checkNumberText("wal * 2", length, params);
    expect(r.error?.code).toBe("EXPR_UNKNOWN_NAME");
    expect(r.error?.message).toContain("“wal”");
    expect(r.error?.message).toContain("“wall”");
  });

  it("refuses a unit mismatch (an angle in a length field)", () => {
    const r = checkNumberText("tilt", length, params);
    expect(r.error?.code).toBe("EXPR_UNIT_MISMATCH");
    expect(r.error?.message).toMatch(/length/);
  });

  it("reports syntax errors without throwing", () => {
    expect(checkNumberText("2 +", length, params).error?.code).toBe("EXPR_SYNTAX");
    expect(checkNumberText("12 $", length, params).error?.code).toBe("EXPR_SYNTAX");
  });

  it("checks bounds and carries the feasible range", () => {
    const r = checkNumberText("60", length, params);
    expect(r.error).toMatchObject({ code: "OUT_OF_RANGE", feasible: { min: 0, max: 50 } });
    expect(r.error?.message).toBe("Must be at most 50 mm.");
    expect(checkNumberText("0", length, params).error?.message).toBe("Must be more than 0 mm.");
  });

  it("requires whole numbers in count fields", () => {
    expect(checkNumberText("2.5", count, params).error?.code).toBe("EXPR_NOT_INTEGER");
    expect(checkNumberText("holes - 1", count, params).value.value).toBe(3);
  });

  it("flags domain errors like division by zero", () => {
    expect(checkNumberText("wall / 0", length, params).error?.code).toBe("EXPR_DOMAIN");
  });

  it("leaves the value to Forge when a parameter is not evaluated yet", () => {
    const r = checkNumberText("later + 1", length, params);
    expect(r.error).toBeNull();
    expect(r.value.value).toBeNull();
    expect(r.value.canonical).toBe("later + 1");
  });

  it("refuses expressions where a field allows only numbers", () => {
    expect(checkNumberText("wall", { ...length, expressions: false }, params).error?.code).toBe("EXPR_NOT_ALLOWED");
    expect(checkNumberText("3", { ...length, expressions: false }, params).error).toBeNull();
  });

  it("asks for a value when empty, unless optional", () => {
    expect(checkNumberText("  ", length, params).error?.code).toBe("REQUIRED");
    expect(checkNumberText("", { ...length, optional: true }, params).error).toBeNull();
  });
});

describe("number helpers", () => {
  it("steps plain numbers and keeps their unit", () => {
    expect(stepNumberText("12", 1)).toBe("13");
    expect(stepNumberText("2.5 mm", 0.1)).toBe("2.6 mm");
    expect(stepNumberText("30°", -10)).toBe("20°");
    expect(stepNumberText("wall * 2", 1)).toBeNull();
  });

  it("clamps into a feasible range and formats quantities", () => {
    expect(clampToRange(5, { max: 3.41 })).toBe(3.41);
    expect(clampToRange(-1, { min: 0.2, max: 3 })).toBe(0.2);
    expect(formatQuantity(3.4100001, "length")).toBe("3.41 mm");
    expect(formatQuantity(45, "angle")).toBe("45°");
    expect(formatQuantity(-0, "count")).toBe("0");
  });
});
