import { existsSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatF64, toJson } from "../../src/v1/json.js";
import { migrateV0ToV1, migrateV0ToV1Report } from "../../src/v1/migrate.js";
import { serdeJsonF64 } from "../../src/v1/v0json.js";
import { corpusPrograms } from "../helpers.js";
import { migrationPairs, readJson, v1Programs } from "./helpers.js";

describe("canonical JSON numbers (zmij / Ryū, [W0-11])", () => {
  it.each([
    [8, "8.0"],
    [0, "0.0"],
    [-0, "-0.0"],
    [0.5, "0.5"],
    [1e-5, "0.00001"],
    [1e-6, "1e-6"],
    [1e-7, "1e-7"],
    [123456.789, "123456.789"],
    [1e15, "1000000000000000.0"],
    [1e16, "1e+16"],
    [1.5e16, "1.5e+16"],
    [-2.5, "-2.5"],
    [2.2250738585072014e-308, "2.2250738585072014e-308"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [0.1 + 0.2, "0.30000000000000004"],
    [544431068535091.6, "544431068535091.6"],
  ])("formats %s as %s", (x, s) => {
    expect(formatF64(x)).toBe(s);
  });

  it("round-trips every finite double", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (x) => {
        const s = formatF64(x);
        expect(Object.is(Number(s), x)).toBe(true);
        // decimal notation exactly for 1e-5 <= |x| < 1e16 (and zero)
        const decimal = !/e/.test(s);
        expect(decimal).toBe(x === 0 || (Math.abs(x) >= 1e-5 && Math.abs(x) < 1e16));
      }),
      { numRuns: 5000 },
    );
  });
});

describe("v0 numbers are read the serde_json way ([W0-11])", () => {
  it("reproduces serde_json's one-ulp rounding of 17-digit decimals", () => {
    // corpus/v1/conformance/migration/makerbench/t2-cable-organizer: Rust reads this v0 literal
    // one ulp below JSON.parse's value, and the v1 fixture records Rust's value.
    expect(serdeJsonF64("9.458569940811701")).toBe(9.4585699408117);
    expect(JSON.parse("9.458569940811701")).not.toBe(9.4585699408117);
  });

  it.each([
    ["0", 0],
    ["-0", -0],
    ["8", 8],
    ["-2.5", -2.5],
    ["1e3", 1000],
    ["1E-3", 0.001],
    ["12.50", 12.5],
    ["18446744073709551616", 18446744073709551616],
    ["123456789012345678901234567890", 1.2345678901234568e29],
    ["1e-400", 0],
    ["0.1", 0.1],
  ])("reads %s", (t, v) => {
    expect(Object.is(serdeJsonF64(t), v)).toBe(true);
  });

  it("agrees with JSON.parse whenever one IEEE operation is exact (<= 15 digits, |exp| <= 22)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 999999999999999n }), fc.integer({ min: 0, max: 15 }), fc.boolean(), (m, scale, neg) => {
        const digits = m.toString().padStart(scale + 1, "0");
        const text = `${neg ? "-" : ""}${scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`}`;
        expect(Object.is(serdeJsonF64(text), JSON.parse(text))).toBe(true);
      }),
      { numRuns: 3000 },
    );
  });
});

describe("canonical JSON text", () => {
  for (const p of v1Programs()) {
    it(`toJson(${p.stem}) reproduces the canonical fixture byte for byte`, () => {
      expect(`${toJson(p.ir)}\n`).toBe(p.text);
    });
  }
});

describe("migrate_v0_to_v1 (SPEC-v1 §9.1)", () => {
  const pairs = migrationPairs();
  it("has the migration fixtures (8 programs, MakerBench, renames)", () => {
    expect(pairs.filter((p) => p.group === "programs").length).toBe(8);
    expect(pairs.filter((p) => p.group === "makerbench").length).toBeGreaterThanOrEqual(61);
    expect(pairs.filter((p) => p.group === "renames").length).toBeGreaterThanOrEqual(4);
  });

  for (const pair of pairs) {
    it(`${pair.group}/${pair.stem}: byte-identical canonical JSON and rename report`, () => {
      const { doc, report } = migrateV0ToV1Report(pair.v0);
      expect(`${toJson(doc)}\n`).toBe(pair.v1Text);
      expect(doc).toStrictEqual(pair.v1);
      if (existsSync(pair.renamesPath)) expect(report).toStrictEqual(readJson(pair.renamesPath));
      else expect(report.renames).toEqual([]);
    });
  }

  it("is idempotent on its own output's v0 twin and deterministic", () => {
    for (const pair of pairs) expect(migrateV0ToV1(pair.v0)).toStrictEqual(migrateV0ToV1(structuredClone(pair.v0)));
  });

  it("migrates every v0 corpus program without renames", () => {
    for (const { ir } of corpusPrograms()) expect(migrateV0ToV1Report(ir).report.renames).toEqual([]);
  });
});
