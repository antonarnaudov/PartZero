import { IR_SCHEMA, type IrDocument } from "@aicad/ir-types";
import { describe, expect, it } from "vitest";
import { CadScriptPrintError, compile, formatNumber, print } from "../src/index.js";
import { HEADER } from "./helpers.js";

function doc(features: IrDocument["parts"][number]["features"], extra: Partial<IrDocument> = {}): IrDocument {
  return { schema: IR_SCHEMA, ...extra, parts: [{ id: "p1", name: "part", features }] };
}

describe("formatNumber", () => {
  it("uses JS shortest round-trip text, with -0 printed as 0", () => {
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber(0.1 + 0.2)).toBe("0.30000000000000004");
    expect(formatNumber(1e21)).toBe("1e+21");
    expect(formatNumber(-2.5e-7)).toBe("-2.5e-7");
    expect(formatNumber(5e-324)).toBe("5e-324");
    expect(() => formatNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("round-trips awkward numbers through compile", () => {
    for (const n of [0.1 + 0.2, 1e21, 1.7976931348623157e308, 5e-324, -1e-7, 123456789.123456789, -0]) {
      const ir = doc([{ type: "sketch", id: "s", name: "s", plane: "XY", curves: [{ kind: "line", id: "a", start: [n, 1], end: [2, 3] }] }]);
      const back = compile(print(ir), { base: ir }).ir!;
      const x = (back.parts[0]!.features[0] as { curves: { start: number[] }[] }).curves[0]!.start[0]!;
      expect(Object.is(x, n === 0 ? 0 : n)).toBe(true);
    }
  });
});

describe("print", () => {
  it("prints frames, suppressed flags, quoted curve ids and non-default directions", () => {
    const ir = doc([
      {
        type: "sketch",
        id: "s",
        name: "lid",
        suppressed: true,
        plane: { origin: [0, 0, 10], normal: [0, 0, 1], x_dir: [1, 0, 0] },
        curves: [
          { kind: "circle", id: "hole-1", center: [0, 0], radius: 2.75 },
          { kind: "arc", id: 'q"\\', start: [1, 0], end: [0, 1], center: [0, 0], ccw: true },
        ],
      },
      { type: "extrude", id: "e", name: "cap", sketch: "lid", distance: 2, direction: "reverse", suppressed: true },
      { type: "revolve", id: "r", name: "spin", sketch: "lid", axis: { origin: [0, 0], direction: [0, 1] }, angle: 90, direction: "normal" },
    ]);
    expect(print(ir)).toBe(
      `${HEADER}
part("part");
const lid = sketch(frame({ origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  "hole-1": circle({ center: [0, 0], radius: 2.75 }),
  "q\\"\\\\": arc({ start: [1, 0], end: [0, 1], center: [0, 0], ccw: true }),
}, { suppressed: true });
const cap = extrude(lid, { distance: 2, direction: "reverse", suppressed: true });
const spin = revolve(lid, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 90 });
`,
    );
    expect(compile(print(ir), { base: ir }).ir).toStrictEqual(ir);
  });

  it("escapes strings (quotes, control characters, lone surrogates, U+2028)", () => {
    const name = 'a "quoted"\n\\ \u0000 \ud800   name';
    const ir: IrDocument = { schema: IR_SCHEMA, meta: { name }, parts: [{ id: "p", name, features: [] }] };
    const r = compile(print(ir), { base: ir });
    expect(r.ir).toStrictEqual(ir);
  });

  it("omits empty metadata and separates parts with blank lines", () => {
    const ir: IrDocument = {
      schema: IR_SCHEMA,
      meta: {},
      parts: [
        { id: "a", name: "a", features: [] },
        { id: "b", name: "b", features: [] },
      ],
    };
    expect(print(ir)).toBe(`${HEADER}\npart("a");\n\npart("b");\n`);
    // `meta: {}` is kept because the base had it.
    expect(compile(print(ir), { base: ir }).ir).toStrictEqual(ir);
    expect(compile(print(ir)).ir).not.toHaveProperty("meta");
  });

  it("keeps explicit default-valued fields from the base (e.g. forge-ir's to_json output)", () => {
    const ir = doc(
      [
        { type: "sketch", id: "s", name: "s", suppressed: false, plane: "YZ", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 1 }] },
        { type: "extrude", id: "e", name: "e", suppressed: false, sketch: "s", regions: "all", distance: 1, direction: "normal", op: "new_body" },
      ],
      { meta: { name: "", description: "" }, units: { length: "mm", angle: "deg" } },
    );
    expect(print(ir)).toBe(`${HEADER}\npart("part");\nconst s = sketch(YZ, {\n  c: circle({ center: [0, 0], radius: 1 }),\n});\nconst e = extrude(s, { distance: 1 });\n`);
    expect(compile(print(ir), { base: ir }).ir).toStrictEqual(ir);
  });

  it("re-emits comments when given the compile result's comment map", () => {
    const source = `${HEADER}\npart("part");\n// A comment on the sketch.\nconst s = sketch(XY, {\n  c: circle({ center: [0, 0], radius: 1 }),\n});\n`;
    const r = compile(source);
    expect(r.comments).toEqual({ f_s: "// A comment on the sketch." });
    expect(print(r.ir!, { comments: r.comments })).toBe(source);
  });

  it("refuses IR that has no CadScript spelling", () => {
    const bad = doc([
      { type: "sketch", id: "s", name: "class", plane: "XY", curves: [] },
      { type: "extrude", id: "e", name: "my-plate", sketch: "class", distance: Number.POSITIVE_INFINITY },
    ]);
    expect(() => print(bad)).toThrow(CadScriptPrintError);
    try {
      print(bad);
    } catch (e) {
      expect((e as CadScriptPrintError).problems).toHaveLength(4);
    }
  });
});

describe("identity", () => {
  const base = compile(
    `${HEADER}\npart("part");\nconst a = sketch(XY, { c: circle({ center: [0, 0], radius: 1 }) });\nconst b = extrude(a, { distance: 1 });\n`,
  ).ir!;

  it("keeps ids by name and gives new features fresh ids that avoid every base id", () => {
    const r = compile(
      `${HEADER}\npart("part");\nconst a = sketch(XY, { c: circle({ center: [0, 0], radius: 2 }) });\nconst x = extrude(a, { distance: 1 });\nconst b = extrude(a, { distance: 1 });\n`,
      { base },
    );
    expect(r.ir!.parts[0]!.features.map((f) => f.id)).toEqual(["f_a", "f_x", "f_b"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("treats a type change as a new feature (with a non-colliding id)", () => {
    const r = compile(
      `${HEADER}\npart("part");\nconst a = sketch(XY, { c: circle({ center: [0, 0], radius: 1 }) });\nconst b = revolve(a, { axis: { origin: [5, 0], direction: [0, 1] }, angle: 90 });\n`,
      { base },
    );
    expect(r.ir!.parts[0]!.features.map((f) => f.id)).toEqual(["f_a", "f_b_2"]);
  });

  it("detects a part rename by position", () => {
    const r = compile(
      `${HEADER}\npart("renamed");\nconst a = sketch(XY, { c: circle({ center: [0, 0], radius: 1 }) });\nconst b = extrude(a, { distance: 1 });\n`,
      { base },
    );
    expect(r.ir!.parts[0]!.id).toBe("p_part");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["CS_RENAME_DETECTED"]);
  });

  it("does not guess when more than one feature changed name", () => {
    const r = compile(
      `${HEADER}\npart("part");\nconst a2 = sketch(XY, { c: circle({ center: [0, 0], radius: 1 }) });\nconst b2 = extrude(a2, { distance: 1 });\n`,
      { base },
    );
    expect(r.ir!.parts[0]!.features.map((f) => f.id)).toEqual(["f_a2", "f_b2"]);
    expect(r.diagnostics).toEqual([]);
  });
});
