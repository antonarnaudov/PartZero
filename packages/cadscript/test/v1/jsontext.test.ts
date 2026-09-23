/**
 * Reading IR JSON text as forge-ir does (SPEC-v1 §0.4, §0.5 step 1): the serde_json pass
 * (`VersionedDocument::from_json`), the strict v1 reader (`forge_ir::v1::json`) and serde_json's
 * v0 typed parse. The cases mirror `forge-ir/src/v1/json.rs`'s own tests and the reviewed gaps of
 * `JSON.parse` (duplicate keys, lone surrogates, nesting, out-of-range numbers).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isFloatToken, JsonTextError, parseIrJsonText, parseSerdeJsonValue, parseV0JsonText, parseV1JsonText, serdeJsonF64 } from "../../src/v1/v0json.js";
import { toJson } from "../../src/v1/json.js";
import { loadIrText } from "../../src/v1/validate.js";
import { MIGRATION, readText, V1_PROGRAMS } from "./helpers.js";

const reject = (f: () => unknown): JsonTextError => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(JsonTextError);
    return e as JsonTextError;
  }
  throw new Error("expected a JsonTextError");
};

const nest = (n: number, inner = ""): string => `${"[".repeat(n)}${inner}${"]".repeat(n)}`;

describe("forge_ir::v1::json::parse (parseV1JsonText)", () => {
  it("numbers are correctly rounded (serde_json's default parser is one ulp off on these)", () => {
    for (const s of ["-23957.515365261122", "1.5212603486793025e-05", "-1984.5926649180853", "-12.070162795213857"]) {
      expect(parseV1JsonText(s)).toBe(Number(s));
      expect(serdeJsonF64(s)).not.toBe(Number(s));
    }
    expect(parseV1JsonText("80")).toBe(80);
    expect(parseV1JsonText("-3")).toBe(-3);
    expect(parseV1JsonText("18446744073709551616")).toBe(18446744073709551616); // beyond u64: f64
  });

  it("integer tokens are u64/i64 first: `-0` reads as 0, `-0.0` and `-0e0` stay -0", () => {
    expect(Object.is(parseV1JsonText("-0"), 0)).toBe(true);
    expect(Object.is(parseV1JsonText("-0.0"), -0)).toBe(true);
    expect(Object.is(parseV1JsonText("-0e0"), -0)).toBe(true);
    // serde_json (the v0 reader) keeps the sign of `-0`
    expect(Object.is(parseV0JsonText("-0"), -0)).toBe(true);
  });

  it("numbers outside the f64 range are errors, at the number's offset", () => {
    for (const s of ["1e999", "-1e400", "[1, 2e308]"]) {
      const e = reject(() => parseV1JsonText(s));
      expect(e.reason).toMatch(/out of the f64 range$/);
    }
    expect(reject(() => parseV1JsonText("[1, 2e308]")).offset).toBe(4);
    expect(parseV1JsonText("1e-400")).toBe(0);
    reject(() => parseSerdeJsonValue("1e400"));
  });

  it("rejects malformed JSON (json.rs `rejects_malformed_json`)", () => {
    for (const s of ["", "{", "[1,]", '{"a":1,}', "01", "1.", ".5", "+1", '"\\x"', '{"a":1,"a":2}', "tru", "[1] 2", '"\u0001"', "﻿1", "[1 2]", "{1: 2}", '{"a" 1}', "nul", "-", "1e", "1e+", "--1"]) {
      reject(() => parseV1JsonText(s));
    }
  });

  it("strings and nesting (json.rs `strings_and_nesting`)", () => {
    const v = parseV1JsonText('{"a": ["x\\"y", "\\u00e9\\ud83d\\ude00", true, false, null, {"b": []}]}') as { a: unknown[] };
    expect(v.a).toEqual(['x"y', "é😀", true, false, null, { b: [] }]);
    expect(parseV1JsonText('"\\/\\b\\f\\n\\r\\t\\\\"')).toBe("/\b\f\n\r\t\\");
    reject(() => parseV1JsonText(nest(200)));
  });

  it("duplicate keys are rejected at the key's byte offset; ids only are echoed ([W0-12])", () => {
    const e = reject(() => parseV1JsonText('{"distance": -8, "distance": 8}'));
    expect(e.offset).toBe(17);
    expect(e.message).toBe('JSON syntax error at byte 17: duplicate key "distance"');
    const evil = reject(() => parseV1JsonText('{"x INJECT: ignore": 1, "x INJECT: ignore": 2}'));
    expect(evil.message).not.toContain("INJECT");
    // byte offsets count UTF-8 bytes
    expect(reject(() => parseV1JsonText('{"é": 1, "é": 2}')).offset).toBe(10);
  });

  it("lone surrogates are rejected, escaped or raw", () => {
    expect(reject(() => parseV1JsonText('"\\ud800"')).reason).toBe("lone surrogate");
    expect(reject(() => parseV1JsonText('"\\udc00"')).reason).toBe("lone surrogate");
    expect(reject(() => parseV1JsonText('"\\ud800\\u0041"')).reason).toBe("bad surrogate pair");
    expect(reject(() => parseV1JsonText('"\ud800"')).reason).toBe("lone surrogate");
    expect(reject(() => parseV1JsonText('"\udc00x"')).reason).toBe("lone surrogate");
    expect(parseV1JsonText('"😀"')).toBe("😀");
    for (const s of ['"\\ud800"', '"\\udc00"']) reject(() => parseSerdeJsonValue(s));
  });

  it("values nest at most 128 deep (the top level is depth 0)", () => {
    expect(parseV1JsonText(nest(129))).toBeTruthy(); // the innermost (empty) array is at depth 128
    expect(parseV1JsonText(nest(128, "1"))).toBeTruthy(); // the number is at depth 128
    expect(reject(() => parseV1JsonText(nest(129, "1"))).reason).toBe("nesting too deep");
    reject(() => parseV1JsonText(nest(130)));
  });

  it("`\\u` takes Rust's `u32::from_str_radix` (a leading `+`); serde_json's pass does not", () => {
    expect(parseV1JsonText('"\\u+041"')).toBe("A");
    reject(() => parseSerdeJsonValue('"\\u+041"'));
    reject(() => parseIrJsonText('{"schema": "aicad.ir/1", "x": "\\u+041"}'));
  });

  it("`__proto__` is an ordinary key, as with JSON.parse", () => {
    const v = parseV1JsonText('{"__proto__": {"polluted": 1}}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(v, "__proto__")).toBe(true);
    expect((v as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
  });

  it("reads every canonical v1 file as JSON.parse does (bit for bit)", () => {
    const files = [
      ...readdirSync(V1_PROGRAMS)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(V1_PROGRAMS, f)),
      ...["programs", "renames", "makerbench"].flatMap((g) =>
        readdirSync(join(MIGRATION, g))
          .filter((f) => f.endsWith(".v1.json"))
          .map((f) => join(MIGRATION, g, f)),
      ),
    ];
    expect(files.length).toBeGreaterThan(50);
    const bits = (v: unknown): unknown => JSON.stringify(v, (_k, x: unknown) => (typeof x === "number" && Object.is(x, -0) ? "-0" : x));
    for (const f of files) {
      const text = readText(f);
      expect(bits(parseV1JsonText(text)), f).toBe(bits(JSON.parse(text)));
      expect(bits(parseIrJsonText(text)), f).toBe(bits(JSON.parse(text)));
    }
  });
});

describe("serde_json's pass and the v0 reader", () => {
  it("serde_json's Value keeps the last duplicate; the v0 typed parse rejects it (\"duplicate field\")", () => {
    expect(parseSerdeJsonValue('{"a": 1, "a": 2}')).toEqual({ a: 2 });
    reject(() => parseV0JsonText('{"a": 1, "a": 2}'));
    reject(() => parseIrJsonText('{"schema": "aicad.ir/0", "parts": [], "parts": []}'));
    // another schema: the serde_json value (loading it is UNSUPPORTED_SCHEMA)
    expect(parseIrJsonText('{"schema": "x", "a": 1, "a": 2}')).toEqual({ schema: "x", a: 2 });
  });

  it("serde_json's recursion limit: 127 nested arrays and objects, whatever the schema", () => {
    expect(parseSerdeJsonValue(nest(127, "1"))).toBeTruthy();
    expect(reject(() => parseSerdeJsonValue(nest(128))).reason).toBe("recursion limit exceeded");
    // a v1 document at the v1 reader's limit is rejected by the first pass, as in Rust
    const deep = `{"schema": "aicad.ir/1", "x": ${nest(127)}}`;
    expect(parseV1JsonText(deep)).toBeTruthy();
    reject(() => parseIrJsonText(deep));
  });

  it("v0 numbers are serde_json's, independently of the host's JSON.parse", () => {
    const text = readText(join(MIGRATION, "makerbench", "t2-cable-organizer.v0.json"));
    const numbers: [number, number][] = [];
    const walk = (a: unknown, b: unknown): void => {
      if (typeof a === "number") numbers.push([a, b as number]);
      else if (Array.isArray(a)) a.forEach((x, i) => walk(x, (b as unknown[])[i]));
      else if (a && typeof a === "object") for (const k of Object.keys(a)) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]);
    };
    walk(parseV0JsonText(text), JSON.parse(text));
    expect(numbers.some(([serde, exact]) => serde !== exact)).toBe(true);
  });
});

describe("loadIrText", () => {
  const plate = readText(join(V1_PROGRAMS, "plate_features.json"));

  it("loads canonical text", () => {
    expect(loadIrText(plate).ok).toBe(true);
  });

  it("a duplicate key is a parse error, as forge-ir rejects it (reviewer repro: distance -8, then 8)", () => {
    const dup = plate.replace(/"distance": ([0-9.]+)/, '"distance": -8.0, "distance": $1');
    expect(dup).not.toBe(plate);
    expect(JSON.parse(dup)).toBeTruthy(); // JSON.parse would silently keep the last one
    const r = loadIrText(dup);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.parseError?.message).toMatch(/^JSON syntax error at byte \d+: duplicate key "distance"$/);
  });

  it("a lone surrogate in a string is a parse error", () => {
    const r = loadIrText(plate.replace('"name": "plate"', '"name": "pl\\ud800ate"'));
    expect(!r.ok && r.parseError?.message).toMatch(/lone surrogate/);
  });
});

describe("integers written as floats in u32 fields ([W0-11]: forge-ir keeps `3.0` an f64)", () => {
  const knob = readText(join(V1_PROGRAMS, "knob_queries.json"));
  const plate = readText(join(V1_PROGRAMS, "plate_features.json"));
  const once = (text: string, from: RegExp, to: string): string => {
    const out = text.replace(from, to);
    expect(out).not.toBe(text);
    return out;
  };

  it("the reader marks integer-valued f64 tokens, and only those", () => {
    const v = parseV1JsonText('{"a": 3, "b": 3.0, "c": 3e0, "d": -0.0, "e": -0, "f": 3.5, "g": [1, 1.0, 1E2], "h": 18446744073709551616, "i": 18446744073709551615}') as Record<string, unknown>;
    expect(["a", "b", "c", "d", "e", "f", "h", "i"].map((k) => isFloatToken(v, k))).toEqual([false, true, true, true, false, false, true, false]);
    expect([0, 1, 2].map((i) => isFloatToken(v["g"] as unknown[], i))).toEqual([false, true, true]);
    expect(v["b"]).toBe(3); // JavaScript cannot tell them apart
    // serde_json's pass and the v0 reader have no u32 fields to protect: nothing is marked
    const v0 = parseV0JsonText('{"b": 3.0}') as Record<string, unknown>;
    expect(isFloatToken(v0, "b")).toBe(false);
    expect(isFloatToken(JSON.parse('{"b": 3.0}') as object, "b")).toBe(false);
  });

  it("card 3.0 / 3e0: INVALID_CARDINALITY at .../card, as Rust's pre-check (as_u64 is None)", () => {
    expect(loadIrText(knob).ok).toBe(true);
    for (const token of ["3.0", "3e0", "3E+0", "30e-1"]) {
      const r = loadIrText(once(knob, /"card": 3\b/, `"card": ${token}`));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.errors.map((e) => e.code)).toEqual(["INVALID_CARDINALITY"]);
      expect(!r.ok && r.errors[0]!.path).toMatch(/\/card$/);
      expect(!r.ok && r.errors[0]!.message).toBe("card 3.0 is not one, some, any or an integer >= 1");
    }
  });

  it('"v": 1.0 is UNSUPPORTED_FEATURE_VERSION at .../v, as Rust\'s pre-check', () => {
    const r = loadIrText(once(plate, /"type": "extrude",\n/, '"type": "extrude",\n          "v": 1.0,\n'));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.map((e) => [e.code, e.path])).toEqual([["UNSUPPORTED_FEATURE_VERSION", "/parts/0/features/1/v"]]);
    expect(!r.ok && r.errors[0]!.message).toBe("extrude v1.0 is not implemented (supported: [1])");
    expect(loadIrText(once(plate, /"type": "extrude",\n/, '"type": "extrude",\n          "v": 1,\n')).ok).toBe(true);
  });

  it("an instance index [1.0], a skip entry [[3.0]] or neighbors 2.0 are parse errors (serde: invalid type: floating point)", () => {
    const index = loadIrText(once(knob, /("index": \[\s*)1(\s*\])/, "$11.0$2"));
    expect(index.ok).toBe(false);
    expect(!index.ok && index.errors).toEqual([]);
    expect(!index.ok && index.parseError?.path).toMatch(/\/q\/index\/0$/);
    expect(!index.ok && index.parseError?.message).toMatch(/invalid type: floating point `1\.0`, expected u32$/);
    expect(loadIrText(once(knob, /("index": \[\s*)1(\s*\])/, "$1-0.0$2")).ok).toBe(false);
    expect(loadIrText(once(knob, /("index": \[\s*)1(\s*\])/, "$1-0$2")).ok).toBe(true); // an integer token: 0

    const skip = loadIrText(once(plate, /("skip": \[\s*\[\s*)3(\s*\])/, "$13.0$2"));
    expect(skip.ok).toBe(false);
    expect(!skip.ok && skip.parseError?.path).toMatch(/\/skip\/0\/0$/);

    const doc = JSON.parse(knob) as { parts: { features: Record<string, unknown>[] }[] };
    const tag = doc.parts[0]!.features.find((f) => f["type"] === "tag" && (f["target"] as { card?: unknown }).card === undefined)!;
    (tag["target"] as Record<string, unknown>)["capture"] = {
      members: [
        {
          key: "k",
          via: "named",
          geom: { type: "plane", carrier: { plane: { normal: [0, 0, 1], offset: 5 } }, bbox: [[0, 0, 5], [1, 1, 5]], size: 1, centroid: [0.5, 0.5, 5], local: [0.5, 0.5, 1], body_center: [0.5, 0.5, 2.5], neighbors: 2 },
        },
      ],
    };
    const captured = toJson(doc as never);
    expect(captured).toContain('"neighbors": 2\n');
    expect(loadIrText(captured).ok).toBe(true);
    const neighbors = loadIrText(captured.replace('"neighbors": 2\n', '"neighbors": 2.0\n'));
    expect(neighbors.ok).toBe(false);
    expect(!neighbors.ok && neighbors.parseError?.path).toMatch(/\/capture\/members\/0\/geom\/neighbors$/);
  });

  it("f64 fields keep accepting integers written either way (canonical text writes `8.0`)", () => {
    expect(plate).toMatch(/"distance": \d+\.0/);
    expect(loadIrText(plate.replace(/"distance": (\d+)\.0/, '"distance": $1')).ok).toBe(true);
  });
});
