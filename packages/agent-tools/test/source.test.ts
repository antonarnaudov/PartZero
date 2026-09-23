import { describe, expect, it } from "vitest";
import { findFeature, featureConstNames, locateStatements, patchSource, PatchError } from "../src/index.js";
import { SCENARIOS } from "./scenarios.js";

const src = SCENARIOS.plate_ok;

describe("locateStatements", () => {
  it("classifies statements and attaches the comment directly above a feature", () => {
    const kinds = locateStatements(src).statements.map((s) => `${s.kind}${s.name ? `:${s.name}` : ""}`);
    expect(kinds).toEqual(["import", "doc", "part:plate", "feature:base", "feature:slab"]);
    const base = findFeature(src, "base")!;
    expect(src.slice(base.attachedStart, base.start)).toMatch(/^\/\/ The outline/);
    expect(base.callee).toBe("sketch");
    expect(base.line).toBe(7);
  });

  it("works on files that do not compile", () => {
    expect(featureConstNames("const a = sketch(XY, {});\nconst b = extrude(a, { distance: 8 * 2 });\n")).toEqual(["a", "b"]);
  });
});

describe("patchSource", () => {
  it("replaces a feature in place, keeping its comment and every other byte", () => {
    const { source, notes } = patchSource(src, [{ feature: "slab", code: "const slab = extrude(base, { distance: 10 });" }]);
    expect(source).toBe(src.replace("distance: 8", "distance: 10"));
    expect(notes).toEqual(["slab: replaced (lines 13–13)"]);
  });

  it("inserts new features after a given one or at the end, and deletes with the attached comment", () => {
    const ins = patchSource(src, [
      { feature: "ring", code: "const ring = sketch(XY, { c: circle({ center: [0, 0], radius: 5 }) });", after: "base" },
      { feature: "boss", code: "const boss = extrude(ring, { distance: 3 });" },
    ]).source;
    expect(featureConstNames(ins)).toEqual(["base", "ring", "slab", "boss"]);
    const del = patchSource(src, [{ feature: "base", code: "" }]).source;
    expect(del).not.toMatch(/The outline|const base/);
    expect(featureConstNames(del)).toEqual(["slab"]);
  });

  it("explains unknown targets", () => {
    expect(() => patchSource(src, [{ feature: "nope", code: "" }])).toThrow(PatchError);
    expect(() => patchSource(src, [{ feature: "x", code: "const x = 1;", after: "nope" }])).toThrow(/features: base, slab/);
  });
});
