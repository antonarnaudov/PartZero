/** Edit splicing for CadScript v1: untouched statements (and comments) stay verbatim. */
import { describe, expect, it } from "vitest";
import { compileV1 } from "../../src/v1/compile.js";
import { canonicalDocument } from "../../src/v1/json.js";
import { printV1 } from "../../src/v1/print.js";
import { applyIrEditCheckedV1, applyIrEditV1, CadScriptV1EditError } from "../../src/v1/splice.js";

const SOURCE = `import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ, param, rect, fillet, Z } from "@aicad/std";

doc({ name: "plate" });

// Outer size.
const width  = param(80,   { min: 20 });   // odd spacing is kept
const thick = param(8);

part("plate");
// The base outline.
const base = sketch(XY, {
  outline: rect({ center: [0, 0], w: width, h: 50, r: 4 }),   // rounded
});
const slab = extrude(base, { distance: thick });
`;

const compiled = compileV1(SOURCE);
const ir = compiled.ir!;

function edit(mutate: (d: typeof ir) => void): { out: string; next: typeof ir } {
  const next = structuredClone(ir);
  mutate(next);
  const out = applyIrEditV1(SOURCE, ir, next);
  expect(compileV1(out, { base: next }).ir).toStrictEqual(canonicalDocument(next));
  return { out, next };
}

describe("applyIrEditV1", () => {
  it("compiles the hand-formatted source", () => {
    expect(compiled.ok).toBe(true);
  });

  it("a parameter edit re-prints only that statement", () => {
    const { out } = edit((d) => {
      d.params![1]!.value = 10;
    });
    expect(out).toContain("const width  = param(80,   { min: 20 });   // odd spacing is kept");
    expect(out).toContain("const thick = param(10);");
    expect(out).toContain("  outline: rect({ center: [0, 0], w: width, h: 50, r: 4 }),   // rounded");
  });

  it("an expression edit prints canonical TypeScript", () => {
    const { out } = edit((d) => {
      (d.parts[0]!.features[1] as { distance: unknown }).distance = "thick * 2 ^ 2 / 10";
    });
    expect(out).toContain("const slab = extrude(base, { distance: thick * 2 ** 2 / 10 });");
  });

  it("adding a feature inserts it after its predecessor and extends the import", () => {
    const { out } = edit((d) => {
      d.parts[0]!.features.push({
        type: "fillet",
        id: "f_round",
        name: "roundEdges",
        edges: { kind: "edge", q: { op: "filter", of: { op: "edges", of: { op: "sides", feature: "f_slab" } }, where: { parallel: "Z" } } },
        r: 2,
      } as never);
      d.params!.push({ name: "gap", unit: "mm", value: 1 });
    });
    expect(out).toContain("const slab = extrude(base, { distance: thick });\nconst roundEdges = fillet(slab.sides().edges().parallel(Z), { r: 2 });");
    expect(out).toContain("const thick = param(8);\nconst gap = param(1);");
    expect(out.split("\n")[0]).toContain("fillet");
  });

  it("removing a feature takes its attached comment along", () => {
    const { out } = edit((d) => {
      d.parts[0]!.features.splice(1, 1);
    });
    expect(out).not.toContain("extrude(base");
    expect(out).toContain("// The base outline.");
  });

  it("new imports are added once, in canonical order", () => {
    const { out } = edit((d) => {
      d.parts[0]!.features.push({ type: "tag", id: "f_t", name: "t", target: { kind: "body", q: { op: "bodies" } } } as never);
    });
    expect(out.split("\n")[0]).toBe('import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ, param, rect, fillet, tag, bodies, Z } from "@aicad/std";');
  });

  it("an edit that renames a feature keeps the statement position and ids", () => {
    const { out, next } = edit((d) => {
      d.parts[0]!.features[1]!.name = "plateBody";
    });
    expect(out).toContain("const plateBody = extrude(base, { distance: thick });");
    expect(compileV1(out, { base: next }).ir!.parts[0]!.features[1]!.id).toBe(ir.parts[0]!.features[1]!.id);
  });

  it("a no-op edit leaves the source untouched", () => {
    const out = applyIrEditV1(SOURCE, ir, ir);
    expect(out).toBe(SOURCE);
    expect(printV1(ir)).not.toBe(SOURCE);
  });

  it("refuses source with syntax errors", () => {
    expect(() => applyIrEditV1("const = ;", ir, ir)).toThrow(CadScriptV1EditError);
    expect(() => applyIrEditCheckedV1("const = ;", ir, ir)).toThrow(CadScriptV1EditError);
  });

  it("applyIrEditCheckedV1 says whether the result was verified: false only for source with front-end errors (best effort)", () => {
    const next = structuredClone(ir);
    next.params![1]!.value = 10;
    expect(applyIrEditCheckedV1(SOURCE, ir, next)).toEqual({ source: applyIrEditV1(SOURCE, ir, next), verified: true });
    // a front-end error (no IR path): nothing to compare with; the result keeps the error, so it
    // never compiles cleanly into a wrong document
    const broken = `${SOURCE}const bad = frobnicate(1);\n`;
    expect(compileV1(broken, { base: ir }).diagnostics.some((d) => d.severity === "error" && d.irPath === undefined)).toBe(true);
    const r = applyIrEditCheckedV1(broken, ir, next);
    expect(r.verified).toBe(false);
    expect(r.source).toContain("const thick = param(10);");
    expect(r.source).toContain("const bad = frobnicate(1);");
    expect(compileV1(r.source, { base: next }).ok).toBe(false);
    expect(applyIrEditV1(broken, ir, next)).toBe(r.source);
  });
});

describe("applyIrEditV1 from a v0 base", () => {
  it("accepts v0 documents as old and new IR (through their migration)", async () => {
    const { compile, print } = await import("../../src/index.js");
    const v0src = print(compile(`import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ } from "@aicad/std";\n\npart("p");\nconst base = sketch(XY, { c: circle({ center: [0, 0], radius: 5 }) });\nconst puck = extrude(base, { distance: 3 });\n`).ir!);
    const v0 = compile(v0src).ir!;
    const next = structuredClone(v0);
    (next.parts[0]!.features[1] as { distance: number }).distance = 4;
    const out = applyIrEditV1(v0src, v0, next);
    expect(out).toContain("const puck = extrude(base, { distance: 4 });");
    expect(out).toContain("const base = sketch(XY, {");
  });
});

describe("applyIrEditV1 and query aliases (SPEC-v1 §5.11: aliases add nothing to the IR)", () => {
  const ALIASED = `import { part, sketch, rect, extrude, fillet, chamfer, tag, XY, Z } from "@aicad/std";

part("p");
const s = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 10 }) });
const e = extrude(s,{distance:5});
// the top face
const top = e.cap("end");
const rim   = top.edges();
const f = fillet(rim,{r:1});
const t = tag(top);
`;
  const base = compileV1(ALIASED);
  const ir0 = base.ir!;

  function editAliased(mutate: (d: typeof ir0) => void, source = ALIASED, from = ir0): { out: string; next: typeof ir0 } {
    const next = structuredClone(from);
    mutate(next);
    const out = applyIrEditV1(source, from, next);
    const r = compileV1(out, { base: next });
    expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    expect(r.ir).toStrictEqual(canonicalDocument(next));
    return { out, next };
  }
  const feature = (d: typeof ir0, name: string): Record<string, unknown> => d.parts[0]!.features.find((f) => f.name === name) as unknown as Record<string, unknown>;

  it("compiles", () => {
    expect(base.diagnostics).toEqual([]);
  });

  it("the reviewer's repro: renaming the extrude rewrites the alias in place; its users keep their text", () => {
    const { out } = editAliased((d) => {
      feature(d, "e")["name"] = "slab";
    });
    expect(out).toContain("const slab = extrude(s,{distance:5});");
    expect(out).toContain('// the top face\nconst top = slab.cap("end");');
    expect(out).toContain("const rim   = top.edges();\nconst f = fillet(rim,{r:1});\nconst t = tag(top);");
    expect(out).not.toMatch(/\be\.cap/);
  });

  it("the reviewer's repro, minimal: extrude renamed, the fillet uses the alias", () => {
    const src = `import { part, sketch, rect, extrude, fillet, XY } from "@aicad/std";\n\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 10 }) });\nconst e = extrude(s,{distance:5}); const top = e.cap("end"); const f = fillet(top.edges(),{r:1});\n`;
    const ir = compileV1(src).ir!;
    const next = structuredClone(ir);
    next.parts[0]!.features[1]!.name = "slab";
    const out = applyIrEditV1(src, ir, next);
    expect(out).toContain('const slab = extrude(s,{distance:5}); const top = slab.cap("end"); const f = fillet(top.edges(),{r:1});');
    expect(compileV1(out, { base: next }).ir).toStrictEqual(canonicalDocument(next));
  });

  it("deleting what an alias names deletes the alias (and aliases built on it), with its comment", () => {
    const { out } = editAliased((d) => {
      d.parts[0]!.features = d.parts[0]!.features.filter((f) => f.name === "s");
    });
    expect(out).not.toContain("top");
    expect(out).not.toContain("rim");
    expect(out).not.toContain("// the top face");
    expect(out).toContain("const s = sketch(XY,");
  });

  it("deleting the only users of an alias deletes it; an alias still used stays verbatim", () => {
    const { out } = editAliased((d) => {
      d.parts[0]!.features = d.parts[0]!.features.filter((f) => f.name !== "f");
    });
    expect(out).not.toContain("rim"); // used only by the fillet
    expect(out).toContain('// the top face\nconst top = e.cap("end");'); // still used by the tag
    expect(out).toContain("const t = tag(top);");
  });

  it("a field-only edit of a statement that uses an alias re-prints it with the alias written back", () => {
    const { out } = editAliased((d) => {
      feature(d, "f")["r"] = 2;
    });
    expect(out).toContain('// the top face\nconst top = e.cap("end");\nconst rim   = top.edges();\nconst f = fillet(rim, { r: 2 });\nconst t = tag(top);');
    // with a rename too: the alias's query is printed with the new names
    const both = editAliased((d) => {
      feature(d, "f")["r"] = 2;
      feature(d, "e")["name"] = "slab";
    });
    expect(both.out).toContain('const top = slab.cap("end");\nconst rim   = top.edges();\nconst f = fillet(rim, { r: 2 });');
  });

  it("when the edit changes the query an alias stands for, the statement is re-printed inline and the unused alias goes", () => {
    const { out } = editAliased((d) => {
      const f = feature(d, "f");
      f["edges"] = { kind: "edge", q: { op: "edges", of: { op: "cap", feature: feature(d, "e")["id"], end: "start" } } };
    });
    expect(out).toContain('const f = fillet(e.cap("start").edges(), { r: 1 });');
    expect(out).not.toContain("rim");
    expect(out).toContain('const top = e.cap("end");\n'); // the tag still uses it
  });

  it("a field-only edit elsewhere keeps every alias and every statement that uses one verbatim", () => {
    const { out } = editAliased((d) => {
      feature(d, "e")["distance"] = 6;
    });
    expect(out).toContain("const e = extrude(s, { distance: 6 });");
    expect(out).toContain('const top = e.cap("end");\nconst rim   = top.edges();\nconst f = fillet(rim,{r:1});\nconst t = tag(top);');
  });

  it("a new feature named like an alias: the alias is inlined into its users and deleted", () => {
    const { out } = editAliased((d) => {
      d.parts[0]!.features.push({ type: "chamfer", id: "f_rim", name: "rim", edges: { kind: "edge", q: { op: "edges", of: { op: "sides", feature: feature(d, "e")["id"] } } }, d: 0.5 } as never);
    });
    expect(out).not.toContain("const rim   = top.edges();");
    expect(out).toContain('const f = fillet(e.cap("end").edges(), { r: 1 });');
    expect(out).toContain("const rim = chamfer(e.sides().edges(), { d: 0.5 });");
  });

  it("renames and deletions together, and a swap of two names", () => {
    const { out } = editAliased((d) => {
      feature(d, "e")["name"] = "slab";
      d.parts[0]!.features = d.parts[0]!.features.filter((f) => f.name !== "t");
    });
    expect(out).toContain('const top = slab.cap("end");');
    expect(out).toContain("const f = fillet(rim,{r:1});");
    expect(out).not.toContain("tag(");
    const src2 = `import { part, sketch, rect, extrude, fillet, XY } from "@aicad/std";\n\npart("p");\nconst a = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 10 }) });\nconst b = extrude(a, { distance: 5 });\nconst c = extrude(a, { distance: 7 });\nconst q = b.cap("end").edges();\nconst f = fillet(q, { r: 1 });\n`;
    const ir2 = compileV1(src2).ir!;
    const swapped = editAliased(
      (d) => {
        d.parts[0]!.features[1]!.name = "c";
        d.parts[0]!.features[2]!.name = "b";
      },
      src2,
      ir2,
    );
    expect(swapped.out).toContain("const c = extrude(a, { distance: 5 });\nconst b = extrude(a, { distance: 7 });\nconst q = c.cap(\"end\").edges();\nconst f = fillet(q, { r: 1 });");
  });

  it("moving a feature an alias names deletes the alias; a moved statement that used an alias is re-printed", () => {
    const src = `import { part, sketch, rect, extrude, fillet, XY } from "@aicad/std";\n\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 10 }) });\nconst e = extrude(s, { distance: 5 });\nconst g = extrude(s, { distance: 9 });\nconst top = e.cap("end");\nconst f = fillet(top.edges(), { r: 1 });\n`;
    const ir = compileV1(src).ir!;
    const { out } = editAliased(
      (d) => {
        const fs = d.parts[0]!.features;
        [fs[1], fs[2]] = [fs[2]!, fs[1]!]; // g before e
      },
      src,
      ir,
    );
    expect(out).toContain('fillet(e.cap("end").edges(), { r: 1 })');
  });

  it("an alias the source never used stays (unless stale); an unused alias of a deleted feature goes", () => {
    const src = ALIASED.replace("const t = tag(top);\n", "const t = tag(top);\nconst spare = e.sides();\n");
    const ir = compileV1(src).ir!;
    const kept = editAliased((d) => {
      feature(d, "f")["r"] = 3;
    }, src, ir);
    expect(kept.out).toContain("const spare = e.sides();");
    const gone = editAliased((d) => {
      d.parts[0]!.features = d.parts[0]!.features.filter((f) => f.name === "s");
    }, src, ir);
    expect(gone.out).not.toContain("spare");
  });

  it("a renamed feature's statement keeps its layout and comments (rename in place)", () => {
    const { out } = edit((d) => {
      d.parts[0]!.features[0]!.name = "outline2";
    });
    expect(out).toContain("const outline2 = sketch(XY, {\n  outline: rect({ center: [0, 0], w: width, h: 50, r: 4 }),   // rounded\n});");
    expect(out).toContain("const slab = extrude(outline2, { distance: thick });");
  });

  it("postcondition: when the first splice does not compile to the new IR, every alias is inlined", () => {
    // An unused alias on `e`, and an edit that makes `e` a datum plane: `e.cap("end")` no longer
    // compiles. The alias is not stale by name, so the first splice keeps it; the check catches it.
    const src = ALIASED.replace("const t = tag(top);\n", "const t = tag(top);\nconst spare = e.cap(\"end\").edges();\n");
    const users = `import { part, sketch, rect, extrude, datumPlane, XY } from "@aicad/std";\n\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 10 }) });\nconst e = extrude(s, { distance: 5 });\nconst spare = e.cap("end").edges();\n`;
    for (const source of [users, src.split("const top")[0]! + 'const spare = e.cap("end").edges();\n']) {
      const ir = compileV1(source).ir!;
      const next = structuredClone(ir);
      const i = next.parts[0]!.features.findIndex((f) => f.name === "e");
      next.parts[0]!.features[i] = { type: "datum_plane", id: next.parts[0]!.features[i]!.id, name: "e", mode: "offset", from: "XY", distance: 5 } as never;
      const out = applyIrEditV1(source, ir, next);
      expect(out).not.toContain("spare");
      expect(out).toContain('const e = datumPlane({ offset: XY, distance: 5 });');
      expect(compileV1(out, { base: next }).ir).toStrictEqual(canonicalDocument(next));
    }
  });

  it("postcondition: an edit no source can express throws CadScriptV1EditError (never returns source that does not compile to it)", () => {
    // The new IR's fillet names a feature declared after it: its print uses `g` before `const g`.
    const src = `import { part, sketch, rect, extrude, fillet, XY } from "@aicad/std";\n\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 10 }) });\nconst g = extrude(s, { distance: 5 });\nconst f = fillet(g.sides().edges(), { r: 1 });\n`;
    const ir = compileV1(src).ir!;
    const next = structuredClone(ir);
    const fs = next.parts[0]!.features;
    [fs[1], fs[2]] = [fs[2]!, fs[1]!];
    let thrown: unknown;
    try {
      applyIrEditV1(src, ir, next);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CadScriptV1EditError);
    expect((thrown as CadScriptV1EditError).diagnostics.map((d) => d.code)).toContain("CS_USED_BEFORE_DECLARED");
  });
});
