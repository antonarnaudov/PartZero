/**
 * The CadScript v1 surface against SPEC-v1's own examples (§2.9, §3.3, §3.4, §5.10, §5.11, §6):
 * each CadScript snippet compiles to the JSON the SPEC gives for it, and prints back.
 */
import { describe, expect, it } from "vitest";
import { analyzeV1, compileV1 } from "../../src/v1/compile.js";
import type { Expr } from "../../src/v1/expr.js";
import { parseExpr, printExpr } from "../../src/v1/expr.js";
import { printV1, Printer } from "../../src/v1/print.js";
import { applyIrEditV1 } from "../../src/v1/splice.js";
import { BUILTINS_V1 } from "../../src/v1/syntax.js";
import { typecheckV1 } from "../../src/v1/typecheck.js";

const IMPORT = `import { ${BUILTINS_V1.join(", ")} } from "@aicad/std";\n`;

/** The SPEC's examples, one document (names adapted so that they coexist). */
const SPEC = `${IMPORT}
const width = param(80, { min: 20, max: 300, note: "outer width" });
const depth = param(50);
const wall = param(2);
const inner = param(width - 2 * wall);
const holes = param(4, { unit: "count", min: 1 });
const tilt = param(15, { unit: "deg" });
const withLid = param(true);

part("plate");
const base = sketch(XY, { outline: rect({ center: [0, 0], w: width, h: depth, r: 4 }) });
const slab = extrude(base, { distance: 8 });
const bossSk = sketch(slab.cap("end"), { ring: circle({ center: [0, 0], radius: 11 }), p1: point([4, 0]), p2: point([-4, 0]) });
const boss = extrude(bossSk, { distance: 12, op: "join", targets: slab });
const pocketSk = sketch(XY, { cut: circle({ center: [20, 0], radius: 3 }) });
const pocket = extrude(pocketSk, { distance: 3, direction: "reverse", op: "cut", targets: "all" });
const corners = fillet(slab.sides().edges().parallel(Z), { r: 4 });
const rootRing = fillet(edgesBetween(boss.side("ring"), slab.cap("end")), { r: 2 });
const topFace = tag(slab.faces().planes().max("+Z").one());
const dEdge = tag(slab.edgeAt("outline.left", "end"));
const mounts = hole(slab.cap("end"), { at: grid({ nx: 2, ny: 2, dx: width - 12, dy: depth - 12 }), size: "M5", depth: "through", cbore: "iso4762" });
const bolts = hole(boss.cap("end"), { at: boltCircle({ n: 4, d: 50 }), size: "M4", fit: "close", depth: "through" });
const pilots = hole(slab.cap("end"), { at: { a: [15.5, 15.5], b: [-15.5, 15.5] }, d: 3.4, depth: { blind: 6 } });
const inserts = hole(boss.cap("end"), { at: bossSk.points("p1", "p2"), size: "M3", insert: "std" });
const topEdge = chamfer(boss.cap("end").edges(), { d: 2 });
const mid = datumPlane({ midplane: [slab.side("outline.left"), slab.side("outline.right")] });
const tilted = datumPlane({ from: XY, axis: X, angle: 30 });
const above = datumPlane({ offset: slab.cap("end"), distance: 10 });
const ringAxis = datumAxis({ cylinder: boss.side("ring") });
const hinge = datumAxis({ planes: [XZ, mid] });
const bossRow = linearPattern([boss, inserts], { dir: X, count: holes, spacing: 20 });
const slots = circularPattern([pocket], { axis: Z, count: 6 });
const otherArm = mirror([boss], { plane: YZ });
const copies = linearPattern(slab.body(), { dir: X, count: 4, spacing: 15 });
const mountFace = tag(slab.body().faces().planes().normal("-Z").one());
const lidInserts = hole(mountFace, { at: { a: [10, 10], b: [-10, 10] }, size: "M3", insert: "std" });
const hollow = shell(slab, { open: slab.cap("end"), thickness: 2 });
const tapered = draft(slab.sides(), { neutral: XY, angle: 2, suppressed: !withLid });
const merged = boolean("join", { targets: slab, tools: boss });
`;

const r = compileV1(SPEC);
const byName = (name: string): Record<string, unknown> => {
  const f = r.ir!.parts[0]!.features.find((x) => x.name === name);
  if (!f) throw new Error(name);
  const { id: _id, name: _name, ...rest } = f as unknown as Record<string, unknown>;
  return rest;
};

describe("SPEC-v1 examples", () => {
  it("compile without errors and type-check", () => {
    expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    expect(typecheckV1(SPEC)).toEqual([]);
  });

  it("§2.9: parameters, unit inference and derived values", () => {
    expect(r.ir!.params).toStrictEqual([
      { name: "width", unit: "mm", value: 80, min: 20, max: 300, note: "outer width" },
      { name: "depth", unit: "mm", value: 50 },
      { name: "wall", unit: "mm", value: 2 },
      { name: "inner", unit: "mm", value: "width - 2 * wall" },
      { name: "holes", unit: "count", value: 4, min: 1 },
      { name: "tilt", unit: "deg", value: 15 },
      { name: "withLid", unit: "bool", value: true },
    ]);
  });

  it("§2.10: a rect driven by parameters", () => {
    expect(byName("base")).toStrictEqual({
      type: "sketch",
      plane: "XY",
      curves: [{ kind: "rect", id: "outline", center: [0, 0], w: "width", h: "depth", r: 4 }],
    });
  });

  it("§6.2: join with a handle as targets, cut with targets: all", () => {
    expect(byName("boss")).toStrictEqual({
      type: "extrude",
      sketch: "f_bossSk",
      distance: 12,
      op: "join",
      targets: { kind: "body", q: { op: "body", feature: "f_slab" } },
    });
    expect(byName("pocket")).toStrictEqual({ type: "extrude", sketch: "f_pocketSk", distance: 3, direction: "reverse", op: "cut", targets: "all" });
    expect(byName("bossSk")["plane"]).toStrictEqual({ face: { kind: "face", q: { op: "cap", feature: "f_slab", end: "end" } } });
  });

  it("§5.11: fillet and query examples", () => {
    expect(byName("corners")).toStrictEqual({
      type: "fillet",
      edges: { kind: "edge", q: { op: "filter", of: { op: "edges", of: { op: "sides", feature: "f_slab" } }, where: { parallel: "Z" } } },
      r: 4,
    });
    expect(byName("rootRing")["edges"]).toStrictEqual({
      kind: "edge",
      q: { op: "between", a: { op: "side", feature: "f_boss", curve: "ring" }, b: { op: "cap", feature: "f_slab", end: "end" } },
    });
    expect(byName("topFace")["target"]).toStrictEqual({
      kind: "face",
      q: { op: "extreme", of: { op: "filter", of: { op: "created", feature: "f_slab" }, where: { type: "plane" } }, dir: "+Z", which: "max" },
      card: "one",
    });
    expect(byName("dEdge")["target"]).toStrictEqual({ kind: "edge", q: { op: "edge_at", feature: "f_slab", curve: "outline.left", end: "end" } });
  });

  it("§6.5: hole examples", () => {
    expect(byName("mounts")).toStrictEqual({
      type: "hole",
      on: { face: { kind: "face", q: { op: "cap", feature: "f_slab", end: "end" } } },
      at: { grid: { nx: 2, ny: 2, dx: "width - 12", dy: "depth - 12" } },
      size: "M5",
      depth: "through",
      cbore: "iso4762",
    });
    expect(byName("bolts")["at"]).toStrictEqual({ circle: { n: 4, d: 50 } });
    expect(byName("bolts")["fit"]).toBe("close");
    expect(byName("pilots")).toMatchObject({ at: { list: [{ id: "a", at: [15.5, 15.5] }, { id: "b", at: [-15.5, 15.5] }] }, d: 3.4, depth: { blind: 6 } });
    expect(byName("inserts")).toMatchObject({ at: { points: { sketch: "f_bossSk", ids: ["p1", "p2"] } }, size: "M3", insert: "std" });
  });

  it("§6.7, §6.8, §6.9, §6.4: chamfer, shell, draft, boolean", () => {
    expect(byName("topEdge")).toStrictEqual({ type: "chamfer", edges: { kind: "edge", q: { op: "edges", of: { op: "cap", feature: "f_boss", end: "end" } } }, d: 2 });
    expect(byName("hollow")).toStrictEqual({
      type: "shell",
      body: { kind: "body", q: { op: "body", feature: "f_slab" } },
      open: { kind: "face", q: { op: "cap", feature: "f_slab", end: "end" } },
      thickness: 2,
    });
    expect(byName("tapered")).toStrictEqual({ type: "draft", suppressed: "!withLid", faces: { kind: "face", q: { op: "sides", feature: "f_slab" } }, neutral: "XY", angle: 2 });
    expect(byName("merged")).toStrictEqual({
      type: "boolean",
      op: "join",
      targets: { kind: "body", q: { op: "body", feature: "f_slab" } },
      tools: { kind: "body", q: { op: "body", feature: "f_boss" } },
    });
  });

  it("§3.3, §3.4: datums", () => {
    expect(byName("mid")).toStrictEqual({
      type: "datum_plane",
      mode: "midplane",
      a: { face: { kind: "face", q: { op: "side", feature: "f_slab", curve: "outline.left" } } },
      b: { face: { kind: "face", q: { op: "side", feature: "f_slab", curve: "outline.right" } } },
    });
    expect(byName("tilted")).toStrictEqual({ type: "datum_plane", mode: "angle", from: "XY", axis: "X", angle: 30 });
    expect(byName("above")).toStrictEqual({ type: "datum_plane", mode: "offset", from: { face: { kind: "face", q: { op: "cap", feature: "f_slab", end: "end" } } }, distance: 10 });
    expect(byName("ringAxis")).toStrictEqual({ type: "datum_axis", mode: "cylinder", face: { kind: "face", q: { op: "side", feature: "f_boss", curve: "ring" } } });
    expect(byName("hinge")).toStrictEqual({ type: "datum_axis", mode: "planes", a: "XZ", b: { datum: "f_mid" } });
  });

  it("§6.10: patterns (feature seeds, body seeds)", () => {
    expect(byName("bossRow")).toStrictEqual({ type: "pattern", seed: { features: ["f_boss", "f_inserts"] }, layout: { linear: { dir: "X", count: "holes", spacing: 20 } } });
    expect(byName("slots")).toStrictEqual({ type: "pattern", seed: { features: ["f_pocket"] }, layout: { circular: { axis: "Z", count: 6 } } });
    expect(byName("otherArm")).toStrictEqual({ type: "pattern", seed: { features: ["f_boss"] }, layout: { mirror: { plane: "YZ" } } });
    expect(byName("copies")).toStrictEqual({
      type: "pattern",
      seed: { bodies: { kind: "body", q: { op: "body", feature: "f_slab" } } },
      layout: { linear: { dir: "X", count: 4, spacing: 15 } },
    });
  });

  it("§6.12: a tag is a query handle", () => {
    expect(byName("lidInserts")["on"]).toStrictEqual({ face: { kind: "face", q: { op: "tagged", feature: "f_mountFace" } } });
  });

  it("prints back to a fixed point", () => {
    const printed = printV1(r.ir!);
    const again = compileV1(printed, { base: r.ir! });
    expect(again.ir).toStrictEqual(r.ir);
    expect(printV1(again.ir!)).toBe(printed);
  });
});

describe("expressions in TypeScript form (SPEC-v1 §2.9)", () => {
  const ts = (text: string): string => {
    const p = parseExpr(text);
    if (!p.ok) throw new Error(text);
    return new Printer({ schema: "aicad.ir/1", parts: [] } as never).expr(p.ast);
  };

  it.each([
    ["--3", "-(-3)"],
    ["-(a ^ 2)", "-(a ** 2)"],
    ["(-a) ^ 2", "(-a) ** 2"],
    ["a ^ -1", "a ** -1"],
    ["a ^ b ^ c", "a ** b ** c"],
    ["(a ^ b) ^ c", "(a ** b) ** c"],
    ["a == b", "a === b"],
    ["a != b", "a !== b"],
    ["12 mm + 0.25 in", "mm(12) + inch(0.25)"],
    ["2 cm * 30 deg", "cm(2) * deg(30)"],
    ["-3 mm", "-mm(3)"],
    ["!(a > 1)", "!(a > 1)"],
    ["!!lid", "!!lid"],
    ["c ? a : b ? d : e", "c ? a : b ? d : e"],
    ["(c ? a : b) ? d : e", "(c ? a : b) ? d : e"],
    ["a - -b", "a - -b"],
    ["(a < b) == c", "(a < b) === c"],
    ["1e21 + 1e-7", "1e+21 + 1e-7"],
  ])("%s prints as %s and compiles back", (irText, tsText) => {
    expect(ts(irText)).toBe(tsText);
    const src = `${IMPORT}\nconst a = param(1);\nconst b = param(2);\nconst c = param(true);\nconst d = param(3);\nconst e = param(4);\nconst lid = param(false);\npart("p");\nconst s = sketch(XY, { k: circle({ center: [0, 0], radius: ${tsText} }) });\n`;
    // The lowered document (unit/type errors at this length field do not matter here).
    const a = analyzeV1(src);
    expect(a.result.diagnostics.filter((d) => d.code.startsWith("CS_"))).toEqual([]);
    const got = (a.doc.parts[0]!.features[0] as unknown as { curves: { radius: unknown }[] }).curves[0]!.radius;
    const canonical = parseExpr(irText);
    if (!canonical.ok) throw new Error(irText);
    expect(got).toBe(printExpr(canonical.ast));
  });

  it("a bare literal is a JSON number, never folded further; unit literals and expressions are strings", () => {
    const src = `${IMPORT}\nconst w = param(8);\npart("p");\nconst s = sketch(XY, { a: line([-2.5, -0], [2 * 3, mm(12)]), b: line([-(3), w], [- -w * 1, 1]) });\n`;
    const out = compileV1(src);
    const curves = (out.ir!.parts[0]!.features[0] as unknown as { curves: { start: unknown; end: unknown }[] }).curves;
    expect(curves[0]!.start).toStrictEqual([-2.5, -0]); // -0 keeps its sign (JSON -0.0)
    expect(printV1(out.ir!)).toContain("a: line([-2.5, -0], [2 * 3, mm(12)])");
    expect(curves[0]!.end).toStrictEqual(["2 * 3", "12 mm"]);
    expect(curves[1]!.start).toStrictEqual([-3, "w"]);
    expect(curves[1]!.end).toStrictEqual(["--w * 1", 1]);
    expect(printV1(out.ir!)).toContain("b: line([-3, w], [-(-w) * 1, 1])");
  });

  it("unit inference of param(expr) and explicit units round-trip", () => {
    const src = `${IMPORT}\nconst w = param(80);\nconst t = param(15, { unit: "deg" });\nconst n = param(4, { unit: "count" });\nconst half = param(w / 2);\nconst ang = param(t * 2);\nconst ratio = param(n - 1);\nconst big = param(n - 1, { unit: "count" });\nconst flag = param(w > 10);\npart("p");\nconst s = sketch(XY, { c: circle({ center: [0, 0], radius: half }) });\n`;
    const out = compileV1(src);
    expect(out.ir!.params!.map((p) => [p.name, p.unit])).toStrictEqual([
      ["w", "mm"],
      ["t", "deg"],
      ["n", "count"],
      ["half", "mm"],
      ["ang", "deg"],
      ["ratio", "ratio"],
      ["big", "count"],
      ["flag", "bool"],
    ]);
    expect(printV1(out.ir!)).toContain("const big = param(n - 1, { unit: \"count\" });");
    expect(printV1(out.ir!)).toContain("const ratio = param(n - 1);");
  });
});

describe("query surface", () => {
  it("faceOf/body/edgesBetween free functions compile to the same AST as the methods (printed as methods)", () => {
    const src = `${IMPORT}\npart("p");\nconst base = sketch(XY, { o: rect({ center: [0, 0], w: 10, h: 10 }) });\nconst slab = extrude(base, { distance: 2 });\nconst a = tag(faceOf(slab, "o.left"));\nconst b = tag(body(slab, "o.bottom"));\nconst c = tag(bodies().faces().largest().any());\n`;
    const out = compileV1(src);
    expect(out.ok).toBe(true);
    const printed = printV1(out.ir!);
    expect(printed).toContain('tag(slab.side("o.left"))');
    expect(printed).toContain('tag(slab.body("o.bottom"))');
    expect(printed).toContain("tag(bodies().faces().largest().any())");
  });

  it("every card and every hole face method", () => {
    const src = `${IMPORT}\npart("p");\nconst base = sketch(XY, { o: rect({ center: [0, 0], w: 10, h: 10 }) });\nconst slab = extrude(base, { distance: 2 });\nconst h = hole(slab.cap("end"), { at: { m: [0, 0] }, d: 3, depth: { blind: 1 } });\nconst t1 = tag(h.wall("m").and(h.tip("m"), h.floor("m"), h.cboreWall("m"), h.cboreFloor("m"), h.csink("m")).exactly(6));\nconst t2 = tag(slab.sides().edges().convex().some());\n`;
    const out = compileV1(src);
    expect(out.ok).toBe(true);
    const t1 = out.ir!.parts[0]!.features[3] as unknown as { target: { q: { of: { part: string }[] }; card: unknown } };
    expect(t1.target.q.of.map((q) => q.part)).toEqual(["wall", "tip", "floor", "cbore_wall", "cbore_floor", "csink"]);
    expect(t1.target.card).toBe(6);
  });

  it("a count in the middle of a chain is an error", () => {
    const src = `${IMPORT}\npart("p");\nconst base = sketch(XY, { o: rect({ center: [0, 0], w: 10, h: 10 }) });\nconst slab = extrude(base, { distance: 2 });\nconst f = fillet(slab.sides().one().edges(), { r: 1 });\n`;
    const out = compileV1(src);
    expect(out.diagnostics.map((d) => d.code)).toContain("CS_BAD_ARGUMENT");
  });

  it("polygon's centre defaults to [0, 0] and prints back without it", () => {
    const src = `${IMPORT}\npart("p");\nconst hexSk = sketch(XY, { hex: polygon({ n: 6, acrossFlats: 5.5 }) });\n`;
    const out = compileV1(src);
    expect(out.ir!.parts[0]!.features[0]).toMatchObject({ curves: [{ kind: "polygon", id: "hex", center: [0, 0], n: 6, across_flats: 5.5 }] });
    expect(printV1(out.ir!)).toContain("hex: polygon({ n: 6, acrossFlats: 5.5 }),");
  });
});

describe("SPEC-v1 snippets, verbatim", () => {
  /** §5.11, the four statements exactly as the SPEC writes them, over features that define the handles. */
  const S511 = `const corners  = fillet(slab.sides().edges().parallel(Z), { r: 4 });
const rootRing = fillet(edgesBetween(boss.side("ring"), slab.cap("end")), { r: 2 });
const topFace  = slab.faces().planes().max("+Z").one();
const dEdge    = coupler.edgeAt("bow", "end");            // one of the two edges of a "D"
`;
  const PRELUDE = `${IMPORT}
part("p");
const base = sketch(XY, { outline: rect({ center: [0, 0], w: 80, h: 50 }) });
const slab = extrude(base, { distance: 8 });
const bossSk = sketch(slab.cap("end"), { ring: circle({ center: [0, 0], radius: 11 }) });
const boss = extrude(bossSk, { distance: 12, op: "join", targets: slab });
const dSk = sketch(XY, { bow: arc({ start: [0, -5], end: [0, 5], center: [0, 0], ccw: true }), chord: line([0, 5], [0, -5]) });
const coupler = extrude(dSk, { distance: 4 });
`;
  const USES = `const above = datumPlane({ offset: topFace, distance: 5 });
const dRound = fillet(dEdge, { r: 1 });
const topPlane = slab.faces().planes().max("+Z");
const ring = fillet(dEdge.and(topPlane.edges()), { r: 0.5 });
`;
  const INLINE = `const above = datumPlane({ offset: slab.faces().planes().max("+Z").one(), distance: 5 });
const dRound = fillet(coupler.edgeAt("bow", "end"), { r: 1 });
const ring = fillet(coupler.edgeAt("bow", "end").and(slab.faces().planes().max("+Z").edges()), { r: 0.5 });
`;

  it("§5.11: plain query consts are aliases: they compile, type-check and add nothing to the IR", () => {
    const src = PRELUDE + S511;
    const r = compileV1(src);
    expect(r.diagnostics.filter((d) => d.severity !== "info").map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    expect(typecheckV1(src)).toEqual([]);
    const features = r.ir!.parts[0]!.features;
    expect(features.map((f) => f.name)).toEqual(["base", "slab", "bossSk", "boss", "dSk", "coupler", "corners", "rootRing"]);
    const id = (n: string): string => features.find((f) => f.name === n)!.id;
    // the SPEC's JSON for the two fillets (ids are this document's)
    expect(features[6]).toMatchObject({ type: "fillet", name: "corners", r: 4, edges: { kind: "edge", q: { op: "filter", where: { parallel: "Z" }, of: { op: "edges", of: { op: "sides", feature: id("slab") } } } } });
    expect(features[7]).toMatchObject({
      type: "fillet",
      name: "rootRing",
      r: 2,
      edges: { kind: "edge", q: { op: "between", a: { op: "side", feature: id("boss"), curve: "ring" }, b: { op: "cap", feature: id("slab"), end: "end" } } },
    });
  });

  it("§5.11: a use of an alias is the query written in place (the printer writes it inline)", () => {
    const aliased = compileV1(PRELUDE + S511 + USES);
    const inline = compileV1(PRELUDE + S511 + INLINE);
    expect(aliased.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(typecheckV1(PRELUDE + S511 + USES)).toEqual([]);
    expect(aliased.ir).toStrictEqual(inline.ir);
    expect(aliased.ir!.parts[0]!.features.find((f) => f.name === "above")).toMatchObject({
      from: { face: { kind: "face", q: { op: "extreme", dir: "+Z", which: "max", of: { op: "filter", where: { type: "plane" } } } } },
    });
    const printed = printV1(aliased.ir!);
    expect(printed).not.toContain("topFace");
    expect(printed).toContain('const dRound = fillet(coupler.edgeAt("bow", "end"), { r: 1 });');
    expect(compileV1(printed, { base: aliased.ir! }).ir).toStrictEqual(aliased.ir);
    // an edit splice keeps the aliasing statements verbatim
    const next = structuredClone(aliased.ir!);
    (next.parts[0]!.features.find((f) => f.name === "corners") as { r: unknown }).r = 5;
    const spliced = applyIrEditV1(PRELUDE + S511 + USES, aliased.ir!, next);
    expect(spliced).toContain(S511.split("\n")[2]!);
    expect(spliced).toContain("const dRound = fillet(dEdge, { r: 1 });");
    expect(compileV1(spliced, { base: next }).ir).toStrictEqual(next);
  });

  it("alias rules: counts, misuse, order, names, and repeated problems reported once", () => {
    const errs = (body: string): string[] => compileV1(PRELUDE + body).diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`);
    expect(errs(`${S511}const f = fillet(topFace.edges(), { r: 1 });`)).toEqual(["CS_BAD_ARGUMENT: `topFace` ends with a count (.one()), so it is a whole reference"]);
    expect(errs(`${S511}const f = datumPlane({ offset: topFace.one(), distance: 1 });`)).toEqual(["CS_BAD_ARGUMENT: `topFace` already ends with a count"]);
    expect(errs(`${S511}const e = extrude(base, { distance: dEdge });`)).toEqual(["CS_BAD_ARGUMENT: `dEdge` is a query, not a value"]);
    expect(errs(`${S511}const e = extrude(dEdge, { distance: 1 });`)).toEqual(["CS_UNRESOLVED_SKETCH: `dEdge` is a query, not a sketch"]);
    expect(errs(`${S511}const row = linearPattern([dEdge], { dir: X, count: 2, spacing: 5 });`)).toEqual(["CS_BAD_ARGUMENT: `dEdge` is a query, not a feature"]);
    expect(errs(`const early = later.cap("end");\nconst later = extrude(base, { distance: 1 });`)).toEqual(["CS_USED_BEFORE_DECLARED: `later` is used before it is declared"]);
    expect(errs(`const early = edgesBetween(slab.cap("end"), later.side("outline.left"));\nconst later = extrude(base, { distance: 1 });\nconst f = fillet(early, { r: 1 });`)).toEqual([
      "CS_USED_BEFORE_DECLARED: `later` is used before it is declared",
    ]);
    expect(errs(`const slab = slab.cap("end");`)[0]).toMatch(/^CS_DUPLICATE_NAME/);
    expect(errs(`const Z2 = slab.cap("end");\nconst X = slab.cap("end");`)).toEqual(["CS_RESERVED_NAME: `X` is a reserved word or @aicad/std builtin and cannot name a query"]);
    // an unused alias adds nothing to the IR, but is checked at its declaration
    expect(errs(`const unused = slab.cap("end").edges().faces();`)).toEqual([]);
    expect(compileV1(`${PRELUDE}const unused = slab.cap("end").edges().faces();`).ir).toStrictEqual(compileV1(PRELUDE).ir);
  });

  it("an unused alias is checked at its declaration: front-end and static query errors, at the alias", () => {
    const at = (body: string): string[] => {
      const src = PRELUDE + body;
      return compileV1(src)
        .diagnostics.filter((d) => d.severity === "error")
        .map((d) => {
          const lines = src.split("\n");
          const off = (p: { line: number; col: number }): number => lines.slice(0, p.line - 1).reduce((n, l) => n + l.length + 1, 0) + p.col - 1;
          return `${d.code} ${src.slice(off(d.span.start), off(d.span.end))}`;
        });
    };
    // the reviewer's probes: an unknown side curve (static check) and an unknown cap end (front end)
    expect(at(`const t = slab.side("nosuch");`)).toEqual(['QUERY_UNKNOWN_CURVE "nosuch"']);
    expect(at(`const t = slab.cap("bogus");`)).toEqual(['CS_BAD_ARGUMENT "bogus"']);
    // the same alias, used: the same report, once
    expect(at(`const t = slab.side("nosuch");\nconst f = fillet(t.edges(), { r: 1 });`)).toEqual(['QUERY_UNKNOWN_CURVE "nosuch"']);
    // an alias used only by an unused alias is checked through it (once)
    expect(at(`const a = slab.side("nosuch");\nconst b = a.edges();`)).toEqual(['QUERY_UNKNOWN_CURVE "nosuch"']);
    // an unknown method, a kind error inside the query
    expect(at(`const t = slab.caps("end");`)).toEqual(["CS_UNKNOWN_METHOD caps"]);
    expect(at(`const t = slab.cap("end").edges().edges();`).map((x) => x.split(" ")[0])).toEqual(["QUERY_INVALID"]);
    // a builtin the alias needs must be imported, used or not
    const noZ = compileV1(PRELUDE.replace(/\bZ, /, "").replace(/, Z\b/, "") + `const t = slab.sides().edges().parallel(Z);`);
    expect(noZ.diagnostics.map((d) => d.code)).toContain("CS_NOT_IMPORTED");
  });

  it("an alias on a name that is not a feature is reported at that name, as in a feature statement", () => {
    const first = (body: string): { code: string; message: string; text: string } => {
      const src = PRELUDE + body;
      const d = compileV1(src).diagnostics.find((x) => x.severity === "error")!;
      const lines = src.split("\n");
      const off = (p: { line: number; col: number }): number => lines.slice(0, p.line - 1).reduce((n, l) => n + l.length + 1, 0) + p.col - 1;
      return { code: d.code, message: d.message, text: src.slice(off(d.span.start), off(d.span.end)) };
    };
    expect(first(`const t = zz.cap("end");`)).toEqual({ code: "UNRESOLVED_FEATURE", message: "`zz` is not a feature declared above", text: "zz" });
    expect(first(`const f = fillet(zz.cap("end").edges(), { r: 1 });`)).toMatchObject({ code: "UNRESOLVED_FEATURE", text: "zz" });
    expect(first(`const w = param(3);\nconst t = w.edges();`)).toEqual({ code: "CS_BAD_ARGUMENT", message: "`w` is a parameter, not a feature", text: "w" });
    // uses of such an alias do not cascade
    const r = compileV1(`${PRELUDE}const t = zz.cap("end");\nconst f = fillet(t.edges(), { r: 1 });`);
    expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toEqual(["UNRESOLVED_FEATURE"]);
    // not a query chain at all: still "must be a parameter, a feature or a query"
    expect(first(`const t = Math.sqrt(2);`).code).toBe("CS_EXPR_UNSUPPORTED");
  });

  it("an alias's own problem is reported once, however often it is used", () => {
    const r = compileV1(`${PRELUDE}const bad = slab.caps("end");\nconst f = fillet(bad.edges(), { r: 1 });\nconst g = fillet(bad.edges(), { r: 2 });\n`);
    expect(r.diagnostics.filter((d) => d.code === "CS_UNKNOWN_METHOD").length).toBe(1);
  });

  it("aliases of aliases expand at most 256 times per statement (CS_TOO_COMPLEX, never exponential work)", () => {
    const chain = Array.from({ length: 12 }, (_, i) => (i === 0 ? 'const a0 = slab.cap("end");' : `const a${i} = a${i - 1}.and(a${i - 1});`)).join("\n");
    const r = compileV1(`${PRELUDE}${chain}\nconst t = tag(a11);\n`);
    expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toEqual(["CS_TOO_COMPLEX"]);
    const small = compileV1(`${PRELUDE}${chain.split("\n").slice(0, 7).join("\n")}\nconst t = tag(a6);\n`);
    expect(small.ok).toBe(true);
    // unused aliases are checked at their declaration, within the same bound: a11 would expand to
    // 2048 queries wherever it is used (reported once; a7…a10 are checked through it)
    const unused = compileV1(`${PRELUDE}${chain}\nconst t = tag(a6);\n`);
    expect(unused.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toEqual(["CS_TOO_COMPLEX"]);
  });

  it("§4.1: polygon({ n: 6, across_flats: 5.5 }) is the same curve as acrossFlats; printed as acrossFlats", () => {
    const spec = `${IMPORT}\npart("p");\nconst standoff = sketch(XY, { hex: polygon({ n: 6, across_flats: 5.5 }) });\n`;
    const r = compileV1(spec);
    expect(r.ok).toBe(true);
    expect(typecheckV1(spec)).toEqual([]);
    expect(r.ir).toStrictEqual(compileV1(spec.replace("across_flats", "acrossFlats")).ir);
    expect(printV1(r.ir!)).toContain("hex: polygon({ n: 6, acrossFlats: 5.5 }),");
    const both = compileV1(spec.replace("across_flats: 5.5", "acrossFlats: 5.5, across_flats: 5.5"));
    expect(both.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual(["CS_BAD_ARGUMENT: `across_flats` and `acrossFlats` are the same option"]);
  });

  it("§2.10: the SPEC's source compiles to the SPEC's JSON; its canonical print differs only in the import header and layout", () => {
    const src = `import { param, part, sketch, rect, extrude, XY } from "@aicad/std";

const width = param(80);
const depth = param(50);
const thick = param(8, { min: 2 });

part("plate");
const base = sketch(XY, { outline: rect({ center: [0, 0], w: width, h: depth, r: 4 }) });
const slab = extrude(base, { distance: thick });
`;
    const r = compileV1(src);
    expect(r.ok).toBe(true);
    expect(typecheckV1(src)).toEqual([]);
    expect(r.ir).toMatchObject({
      schema: "aicad.ir/1",
      params: [
        { name: "width", unit: "mm", value: 80 },
        { name: "depth", unit: "mm", value: 50 },
        { name: "thick", unit: "mm", value: 8, min: 2 },
      ],
      parts: [
        {
          name: "plate",
          features: [
            { type: "sketch", name: "base", plane: "XY", curves: [{ kind: "rect", id: "outline", center: [0, 0], w: "width", h: "depth", r: 4 }] },
            { type: "extrude", name: "slab", distance: "thick" },
          ],
        },
      ],
    });
    // print(compile(src)) is canonical CadScript: the stable import header (every v0 builtin plus
    // the v1 builtins in use) and one curve per line. It is a fixed point, and the statements
    // below the header carry the same text up to layout.
    const printed = printV1(r.ir!);
    expect(printV1(compileV1(printed).ir!)).toBe(printed);
    const flat = (t: string): string => t.split("\n").slice(1).join(" ").replace(/\s+/g, " ").replace(/, \}/g, " }").trim();
    expect(flat(printed)).toBe(flat(src));
  });
});

void (null as unknown as Expr);
