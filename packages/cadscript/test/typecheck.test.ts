import { describe, expect, it } from "vitest";
import { STD_DTS, typecheck } from "../src/index.js";
import { stdLibDiagnostics } from "../src/typecheck.js";
import { src } from "./helpers.js";

const BOX = `part("part");
const base = sketch(XY, {
  bottom: line([0, 0], [10, 0]),
  right: line([10, 0], [10, 10]),
  top: line([10, 10], [0, 10]),
  left: line([0, 10], [0, 0]),
});
`;

describe("typecheck", () => {
  it("the @aicad/std declarations themselves are error-free", () => {
    expect(stdLibDiagnostics()).toEqual([]);
    expect(STD_DTS).toContain("export declare function extrude(");
  });

  it("accepts a well-typed file", () => {
    expect(typecheck(src(`${BOX}const plate = extrude(base, { distance: 8, direction: "symmetric" });\n`))).toEqual([]);
  });

  it("catches a wrong argument type (string distance)", () => {
    const diags = typecheck(src(`${BOX}const plate = extrude(base, { distance: "8" });\n`));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      code: "TS2322",
      severity: "error",
      message: "Type 'string' is not assignable to type 'number'.",
      span: { start: { line: 10, col: 31 }, end: { line: 10, col: 39 } },
    });
  });

  it("catches passing a non-sketch feature and bad enum values", () => {
    const diags = typecheck(
      src(`${BOX}const plate = extrude(base, { distance: 8 });\nconst again = extrude(plate, { distance: 1 });\nconst up = extrude(base, { distance: 1, direction: "up" });\n`),
    );
    expect(diags.map((d) => d.code)).toEqual(["TS2345", "TS2322"]);
    expect(diags[0]!.message).toContain("'Extrude' is not assignable to parameter of type 'Sketch'");
  });

  it("catches wrong tuple lengths, misspelled builtins and missing imports", () => {
    const codes = typecheck(
      `import { part, sketch, XY } from "@aicad/std";\n\npart("p");\nconst s = sketch(XY, { a: line([0, 0], [1, 1]) });\nconst t = sketch(XY, { a: cirle({ center: [0, 0, 0], radius: 1 }) });\n`,
    ).map((d) => d.code);
    expect(codes).toEqual(["TS2304", "TS2304"]);
    const tuple = typecheck(src(`part("p");\nconst s = sketch(XY, { a: circle({ center: [0, 0, 0], radius: 1 }) });\n`));
    expect(tuple.map((d) => d.code)).toEqual(["TS2322"]);
  });

  it("reports unresolved modules", () => {
    expect(typecheck(`import { part } from "@aicad/stdlib";\npart("p");\n`).map((d) => d.code)).toEqual(["TS2307"]);
  });
});
