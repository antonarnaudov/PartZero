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

// Audit M12 (r4-tools.mjs, r10-patch-syntax.mjs, r11-patch-e2e.mjs): a patch must never delete or
// replace code beyond the feature it targets.
describe("patchSource stays inside its target", () => {
  const IMP = `import { part, sketch, circle, extrude, XY } from "@aicad/std";\n`;
  const S = "const s = sketch(XY, { c: circle({ center: [0, 0], radius: 5 }) });";
  const TAIL = "const e = extrude(s, { distance: 5 });\nconst t = sketch(XY, { d: circle({ center: [20, 0], radius: 2 }) });\nconst f = extrude(t, { distance: 3 });\n";

  it("deleting a feature keeps another statement on the same line (r4 #1)", () => {
    const src = `${IMP}part("p");\n${S}\nconst old = sketch(XY, { d: circle({ center: [20, 0], radius: 2 }) }); const e = extrude(s, { distance: 5 });\n`;
    const { source, notes } = patchSource(src, [{ feature: "old", code: "" }]);
    expect(notes).toEqual(["old: deleted"]);
    expect(featureConstNames(source)).toEqual(["s", "e"]);
    expect(source).toBe(`${IMP}part("p");\n${S}\nconst e = extrude(s, { distance: 5 });\n`);
  });

  it("deleting the second statement of a line keeps the first one and the newline", () => {
    const src = `${IMP}part("p");\n${S} const old = sketch(XY, { d: circle({ center: [20, 0], radius: 2 }) }); // old one\nconst e = extrude(s, { distance: 5 });\n`;
    const { source } = patchSource(src, [{ feature: "old", code: "" }]);
    expect(source).toBe(`${IMP}part("p");\n${S}\nconst e = extrude(s, { distance: 5 });\n`);
  });

  it("deleting a statement keeps an unclosed or multi-line block comment that follows it", () => {
    const tail = "/* notes\nconst e = extrude(s, { distance: 5 });\n";
    const src = `${IMP}part("p");\n${S}\nconst old = sketch(XY, { d: circle({ center: [20, 0], radius: 2 }) }); ${tail}`;
    expect(patchSource(src, [{ feature: "old", code: "" }]).source).toBe(`${IMP}part("p");\n${S}\n${tail}`);
  });

  it("inserting after an anchor that shares its line puts the new feature right after the anchor (r4 #2)", () => {
    const src = `${IMP}part("p");\n${S} const e = extrude(s, { distance: 5 });\n`;
    const { source } = patchSource(src, [{ feature: "t", code: "const t = sketch(XY, { d: circle({ center: [20, 0], radius: 2 }) });", after: "s" }]);
    expect(featureConstNames(source)).toEqual(["s", "t", "e"]);
  });

  it("refuses a truncated replacement that would swallow the following features (r11)", () => {
    const src = `${IMP}part("p");\n${S}\n${TAIL}`;
    const truncated = "const s = sketch(XY, { c: circle({ center: [0, 0], radius: 6 })";
    expect(() => patchSource(src, [{ feature: "s", code: truncated }])).toThrow(PatchError);
    expect(() => patchSource(src, [{ feature: "s", code: truncated }])).toThrow(/would also remove "e", "t", "f"/);
    // The complete statement is fine and touches nothing else.
    const ok = patchSource(src, [{ feature: "s", code: S.replace("radius: 5", "radius: 6") }]).source;
    expect(ok).toBe(src.replace("radius: 5 })", "radius: 6 })"));
    expect(featureConstNames(ok)).toEqual(["s", "e", "t", "f"]);
  });

  it("refuses to patch a statement that the parser stretched over others after a syntax error (r10)", () => {
    const broken: Record<string, string> = {
      "missing ) of sketch(": "const s = sketch(XY, { c: circle({ center: [0, 0], radius: 5 }) };\n",
      "missing } of curves": "const s = sketch(XY, { c: circle({ center: [0, 0], radius: 5 }) );\n",
      "missing ] in center": "const s = sketch(XY, { c: circle({ center: [0, 0, radius: 5 }) });\n",
      "unterminated call": "const s = sketch(XY, { c: circle({ center: [0, 0], radius: 5 })\n",
    };
    for (const [label, line] of Object.entries(broken)) {
      const src = `${IMP}part("p");\n${line}${TAIL}`;
      expect(locateStatements(src).syntaxErrors.length, label).toBeGreaterThan(0);
      for (const patch of [{ feature: "s", code: S }, { feature: "s", code: "" }]) {
        let result: string | undefined;
        try {
          result = patchSource(src, [patch]).source;
        } catch (e) {
          expect(e, label).toBeInstanceOf(PatchError);
          expect((e as Error).message, label).toMatch(/syntax error|would also remove/);
          continue;
        }
        // When a patch is allowed, no feature it did not target may be gone.
        const names = featureConstNames(result);
        for (const n of ["e", "t", "f"]) expect(names, `${label}: ${n}`).toContain(n);
      }
    }
    // The unterminated call is the case where recovery stretches `s` over e, t and f (lines 3–6):
    // the located features are only [s], so only the syntax-error guard can see the damage.
    const src = `${IMP}part("p");\n${broken["unterminated call"]}${TAIL}`;
    expect(featureConstNames(src)).toEqual(["s"]);
    expect(() => patchSource(src, [{ feature: "s", code: S }])).toThrow(/cannot replace "s" safely: the file has a syntax error .* runs on over e, t, f/);
    expect(() => patchSource(src, [{ feature: "s", code: "" }])).toThrow(/cannot delete "s" safely/);
    expect(() => patchSource(src, [{ feature: "n", code: "const n = extrude(s, { distance: 1 });", after: "s" }])).toThrow(/cannot insert "n" after "s" safely/);
  });

  // Review of the M12 fix: the comment in front of a statement that shares the anchor's line is that
  // statement's (design intent the compiler keeps); inserting after the anchor or deleting it keeps it.
  describe("comments in front of the next statement on the same line survive", () => {
    const f = `const a = sketch(XY, {}); /* keep b's note */ const b = extrude(a, { distance: 1 });\npart("p");\n`;

    it("insert after the anchor: the comment moves with the following statement", () => {
      const { source } = patchSource(f, [{ feature: "c", code: "const c = extrude(a, { distance: 2 });", after: "a" }]);
      expect(source).toBe(`const a = sketch(XY, {});\nconst c = extrude(a, { distance: 2 });\n/* keep b's note */ const b = extrude(a, { distance: 1 });\npart("p");\n`);
      expect(findFeature(source, "b")!.attachedStart).toBe(source.indexOf("/* keep b's note */"));
    });

    it("delete the anchor: the range ends at the statement (and its spaces), not at the next code", () => {
      expect(patchSource(f, [{ feature: "a", code: "" }]).source).toBe(`/* keep b's note */ const b = extrude(a, { distance: 1 });\npart("p");\n`);
    });

    it("a patch that would swallow a comment or a part() it does not target is refused", () => {
      const withNote = `${IMP}part("p");\n${S}\n// the end\n`;
      const unclosed = `${S.replace("radius: 5", "radius: 6")} /* todo`;
      expect(() => patchSource(withNote, [{ feature: "s", code: unclosed }])).toThrow(/would also remove the comment "\/\/ the end"/);
      const partAfter = `${IMP}${S}\npart("p");\n`;
      expect(() => patchSource(partAfter, [{ feature: "s", code: unclosed }])).toThrow(/would also remove part\("p"\)/);
      // The same edit, complete, is fine.
      expect(patchSource(withNote, [{ feature: "s", code: S.replace("radius: 5", "radius: 6") }]).source).toBe(withNote.replace("radius: 5", "radius: 6"));
    });
  });

  it("curve ids named import / export / const in a sketch are not statements, even when the file has an unrelated syntax error", () => {
    for (const kw of ["import", "export", "const", "let"]) {
      const sketchWith = (x: number) => `const a = sketch(XY, {\n  ${kw}: line([0, 0], [${x}, 0]),\n});`;
      const src = `${IMP}part("p");\n${sketchWith(1)}\nconst b = extrude(a, { distance: 1 ;\n`;
      expect(locateStatements(src).syntaxErrors.length, kw).toBeGreaterThan(0);
      const { source } = patchSource(src, [{ feature: "a", code: sketchWith(2) }]);
      expect(source, kw).toBe(src.replace(sketchWith(1), sketchWith(2)));
    }
    // A real import or export swallowed after a syntax error is still caught.
    for (const [label, line] of [
      ["import", `import { XY } from "@aicad/std";`],
      ["export", "export const t = sketch(XY, {});"],
      ["const from", "const from = sketch(XY, {});"],
    ] as const) {
      const src = `${IMP}part("p");\nconst s = sketch(XY, { c: circle({ center: [0, 0], radius: 5 })\n${line}\nconst e = extrude(s, { distance: 5 });\n`;
      expect(() => patchSource(src, [{ feature: "s", code: S }]), label).toThrow(new RegExp(`runs on over ${label === "const from" ? "from" : label}`));
    }
  });

  it("a curve id named like a keyword is not mistaken for a statement", () => {
    const src = `${IMP}part("p");\nconst s = sketch(XY, {\n  const: circle({ center: [0, 0], radius: 5 }) };\n${TAIL}`;
    // Whatever the recovery does, the result never silently loses e, t or f.
    try {
      const out = patchSource(src, [{ feature: "e", code: "const e = extrude(s, { distance: 6 });" }]).source;
      expect(featureConstNames(out)).toEqual(expect.arrayContaining(["e", "t", "f"]));
    } catch (e) {
      expect(e).toBeInstanceOf(PatchError);
    }
  });
});
