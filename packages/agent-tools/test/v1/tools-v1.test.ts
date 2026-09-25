/**
 * The v1 design session and tools against real Forge reports (recorded: `test/fixtures/v1-tools.json`;
 * re-record with AICAD_RECORD_FIXTURES=forge-v1): the ladder with L1 warnings, the one-step repairs
 * (set_param, accept_ref_candidate, sketch_edit), query and describe, computed compile hints, the
 * editability probe and spec tests on v1 models. accept_ref_proposal needs captured references,
 * which only the command layer writes: it runs on a scripted engine.
 */
import { afterAll, describe, expect, it } from "vitest";
import { v1 as cs } from "@aicad/cadscript";
import { v1 as irTypes, type metricsV1 } from "@aicad/ir-types";
import { EngineError } from "@aicad/evals";
import {
  acceptCandidateEdit,
  CANDIDATE_PROBE_RADIUS_MM,
  candidateResolutionProblem,
  designerRegistryV1,
  DesignSessionV1,
  editedFeatures,
  ScriptedEngineV1,
  specWriterRegistryV1,
  variations,
  type DesignToolContextV1,
  type EngineV1,
} from "../../src/v1/index.js";
import { v1TestEngine } from "./engine-fixture.js";

const fixture = v1TestEngine("v1-tools");
afterAll(() => fixture.finish());

const IMPORT = 'import { part, sketch, line, circle, extrude, XY, Z, param, rect, C, tag, hole, draft } from "@aicad/std";\n';

const PLATE = `${IMPORT}const width = param(80, { min: 20, max: 300, note: "outer width" });
const depth = param(50);
const thick = param(8, { min: 2 });

part("plate");
const base = sketch(XY, { outline: rect({ center: [0, 0], w: width, h: depth }) });
const slab = extrude(base, { distance: thick });
`;

const AMBIGUOUS = `${PLATE}const top = tag(slab.sides().one());
`;

const CONFLICT = `${IMPORT}part("p");
const s = sketch(XY, { a: line([0, 0], [10, 0]), b: line([10, 0], [10, 10]), c: line([10, 10], [0, 10]), d: line([0, 10], [0, 0]) }, {
  constraints: { h1: C.horizontal("a"), h2: C.horizontal("c"), v1: C.vertical("b"), v2: C.vertical("d"), w1: C.distance("a.start", "a.end", 10), w2: C.distance("c.start", "c.end", 12), f: C.fix("a.start") },
});
const e = extrude(s, { distance: 5 });
`;

const REDUNDANT = `${IMPORT}part("p");
const s = sketch(XY, { a: line([0, 0], [10, 0]), b: line([10, 0], [10, 10]), c: line([10, 10], [0, 10]), d: line([0, 10], [0, 0]) }, {
  constraints: { h1: C.horizontal("a"), h2: C.horizontal("c"), v1: C.vertical("b"), v2: C.vertical("d"), p1: C.parallel("a", "c"), w1: C.distance("a.start", "a.end", 10), w2: C.distance("b.start", "b.end", 10), f: C.fix("a.start") },
});
const e = extrude(s, { distance: 5 });
`;

/** A rounded rectangle whose corner radius breaks when the width shrinks by 20 %. */
const FRAGILE = `${IMPORT}const w = param(10);
part("p");
const s = sketch(XY, { o: rect({ center: [0, 0], w: w, h: 20, r: 4.5 }) });
const e = extrude(s, { distance: 2 });
`;

async function ctxFor(engine: EngineV1 = fixture.engine, source?: string): Promise<DesignToolContextV1> {
  const session = await DesignSessionV1.open({ engine, name: "design", ...(source ? { source } : {}) });
  return { session, askUser: (qs) => qs.map((q) => q.default) };
}

const registry = designerRegistryV1();
const call = (ctx: DesignToolContextV1, name: string, input: Record<string, unknown>) => registry.execute({ name, input }, ctx);

describe("v1 registry", () => {
  it("exposes the v1 designer tools and the shared spec writer tools", () => {
    expect(registry.names()).toEqual([
      "accept_ref_candidate",
      "accept_ref_proposal",
      "apply_cadscript",
      "ask_user",
      "checkpoint",
      "describe",
      "get_code",
      "ir_summary",
      "measure",
      "propose",
      "query",
      "rollback",
      "run_tests",
      "set_param",
      "sketch_edit",
    ]);
    expect(specWriterRegistryV1().names()).toEqual(["set_spec_tests", "submit_spec"]);
    for (const d of registry.defs()) expect(JSON.stringify(d.inputSchema)).toContain('"additionalProperties":false');
  });
});

describe("apply_cadscript (v1)", () => {
  it("builds a parametric plate and reports parameters, calls and final bodies", async () => {
    const ctx = await ctxFor();
    const out = await call(ctx, "apply_cadscript", { source: PLATE, expect: [{ feature: "slab", bodies: 1, bbox_size: [80, 50, 8] }] });
    expect(out.isError).toBeFalsy();
    expect(out.text).toMatch(/^apply #1: OK \(L0–L2 pass\)/);
    expect(out.text).toContain("✓ slab (extrude): 1 body (1 created): V 32000 mm³, bbox 80×50×8");
    expect(out.text).toContain("model: 1 body, total V 32000 mm³");
    const summary = (await call(ctx, "ir_summary", {})).text;
    expect(summary).toContain('width = 80 mm [20..300] "outer width"');
    expect(summary).toContain("slab: extrude(base, { distance: thick }) → 1 body (1 created)");
    expect((await call(ctx, "measure", { feature: "slab" })).text).toContain("origin slab (region outline.bottom), created");
  });

  it("gives computed hints on compile errors: operand units, and did-you-mean for parameters", async () => {
    const ctx = await ctxFor();
    const out = await call(ctx, "apply_cadscript", {
      source: `${IMPORT}const width = param(80);\nconst holes = param(4, { unit: "count" });\nconst w2 = param(width + holes);\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: widht, h: 5 }) });\n`,
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/FAILED at L0/);
    expect(out.text).toContain("`width` is a length (mm) and `holes` is a plain number (count or ratio)");
    expect(out.text).toContain("`holes` * pitch");
    expect(out.text).toContain("Did you mean width?");
  });

  it("a draft Forge evaluates now goes through the ladder like any feature (it was UNSUPPORTED_FEATURE before)", async () => {
    const ctx = await ctxFor();
    const out = await call(ctx, "apply_cadscript", { source: `${PLATE}const taper = draft(slab.sides(), { neutral: XY, angle: 2 });\n` });
    expect(out.isError, out.text).toBeFalsy();
    expect(out.text).toMatch(/^apply #1: OK/);
  });

  it("explains a draft face Forge cannot tilt (a round wall) with the planar-walls rule", async () => {
    const ctx = await ctxFor();
    const out = await call(ctx, "apply_cadscript", { source: `${PLATE}const ring = sketch(XY, { c: circle({ center: [100, 0], radius: 5 }) });\nconst post = extrude(ring, { distance: 8 });\nconst taper = draft(post.sides(), { neutral: XY, angle: 2 });\n` });
    expect(out.text).toMatch(/FAILED at L1/);
    expect(out.text).toContain("DRAFT_FACE_UNSUPPORTED");
    expect(out.text).toContain("planar faces only");
  });

  it("a hole Forge evaluates now goes through the ladder like any feature", async () => {
    const ctx = await ctxFor();
    const out = await call(ctx, "apply_cadscript", { source: `${PLATE}const bolt = hole(slab.cap("end"), { at: { a: [0, 0] }, d: 4, depth: "through" });\n`, expect: [{ feature: "bolt", holes: 1 }] });
    expect(out.isError).toBeFalsy();
    expect(out.text).toMatch(/^apply #1: OK/);
  });

  it("fails L1 on a warning of a feature it just changed until it is explained", async () => {
    const ctx = await ctxFor();
    const first = await call(ctx, "apply_cadscript", { source: REDUNDANT });
    expect(first.isError).toBe(true);
    expect(first.text).toMatch(/FAILED at L1 \(kernel\)/);
    expect(first.text).toContain("⚠ s warning SKETCH_REDUNDANT_CONSTRAINTS (on a feature you just changed)");
    expect(first.text).toContain('sketch_edit { sketch: "s", remove: ["p1"] }');
    const second = await call(ctx, "apply_cadscript", { source: REDUNDANT, accept_warnings: [{ feature: "s", code: "SKETCH_REDUNDANT_CONSTRAINTS", reason: "the parallel constraint documents intent" }] });
    expect(second.isError).toBeFalsy();
    expect(second.text).toContain("note warning SKETCH_REDUNDANT_CONSTRAINTS on s (explained)");
    expect(ctx.session.acceptedWarnings).toEqual([{ feature: "s", code: "SKETCH_REDUNDANT_CONSTRAINTS", reason: "the parallel constraint documents intent" }]);
  });

  it("an unexplained warning stays an L1 failure when the same source is re-applied or only a comment changes", async () => {
    const ctx = await ctxFor();
    expect((await call(ctx, "apply_cadscript", { source: REDUNDANT })).text).toMatch(/FAILED at L1 \(kernel\)/);
    const again = await call(ctx, "apply_cadscript", { source: REDUNDANT });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/^apply #2: FAILED at L1 \(kernel\)/);
    expect(again.text).toContain("⚠ s warning SKETCH_REDUNDANT_CONSTRAINTS (on a feature you just changed)");
    const comment = await call(ctx, "apply_cadscript", { source: `// the parallel constraint stays\n${REDUNDANT}` });
    expect(comment.text).toMatch(/^apply #3: FAILED at L1 \(kernel\)/);
    expect(ctx.session.openWarnings.map((w) => `${w.feature}:${w.code}`)).toEqual(["s:SKETCH_REDUNDANT_CONSTRAINTS"]);
  });

  it("an unrelated patch does not clear it either; explaining it does, and the state it verifies becomes the new baseline", async () => {
    // Every model: all features ok, and a warning on the sketch `base`.
    const engine = new ScriptedEngineV1((doc) => stubReport(doc, undefined, undefined, { feature: "base", code: "SKETCH_REDUNDANT_CONSTRAINTS" }));
    const ctx = await ctxFor(engine);
    expect((await call(ctx, "apply_cadscript", { source: PLATE })).text).toMatch(/FAILED at L1/);
    const unrelated = await call(ctx, "apply_cadscript", { patches: [{ feature: "top", code: 'const top = tag(slab.cap("end"));' }] });
    expect(unrelated.text).toMatch(/^apply #2: FAILED at L1/);
    expect(unrelated.text).toContain("⚠ base warning SKETCH_REDUNDANT_CONSTRAINTS");
    const explained = await call(ctx, "apply_cadscript", { patches: [], accept_warnings: [{ feature: "base", code: "SKETCH_REDUNDANT_CONSTRAINTS", reason: "intended" }] });
    expect(explained.text).toMatch(/^apply #3: OK/);
    expect(ctx.session.openWarnings).toEqual([]);
  });

  it("a curve-only edit counts as editing its sketch: a warning on the sketch fails L1 until explained, and the change lists the curve", async () => {
    // A mirrored loop is wrong geometry: SKETCH_LOOP_FLIPPED on the sketch whose curves just moved must not pass as a note.
    const engine = new ScriptedEngineV1((doc) => {
      const base = doc.parts[0]!.features.find((f) => f.name === "base") as unknown as { curves: { h: unknown }[] };
      return base.curves[0]!.h === 60 ? stubReport(doc, undefined, undefined, { feature: "base", code: "SKETCH_LOOP_FLIPPED" }) : stubReport(doc);
    });
    const ctx = await ctxFor(engine);
    expect((await call(ctx, "apply_cadscript", { source: PLATE })).text).toMatch(/^apply #1: OK/);
    const moved = await call(ctx, "apply_cadscript", { patches: [{ feature: "base", code: "const base = sketch(XY, { outline: rect({ center: [0, 0], w: width, h: 60 }) });" }] });
    expect(moved.isError).toBe(true);
    expect(moved.text).toMatch(/^apply #2: FAILED at L1 \(kernel\)/);
    expect(moved.text).toContain("changes: ~base (curves ~outline)");
    expect(moved.text).toContain("⚠ base warning SKETCH_LOOP_FLIPPED (on a feature you just changed)");
    const explained = await call(ctx, "apply_cadscript", { patches: [], accept_warnings: [{ feature: "base", code: "SKETCH_LOOP_FLIPPED", reason: "checked: the loop is meant to run clockwise" }] });
    expect(explained.text).toMatch(/^apply #3: OK/);
    // Unit: a radius change is an edit of the sketch alone.
    const src = (r: number) => `${IMPORT}part("p");\nconst s = sketch(XY, { c: circle({ center: [0, 0], radius: ${r} }) });\nconst e = extrude(s, { distance: 5 });\n`;
    const before = cs.compile(src(5)).ir!;
    expect([...editedFeatures(before, cs.compile(src(7), { base: before }).ir!)]).toEqual(["s"]);
  });

  describe("an explanation covers the warning instance it was given for", () => {
    /** Warnings the scripted engine raises: feature → [code, details]. */
    let raised: Record<string, [string, Record<string, unknown>]> = {};
    const engine = new ScriptedEngineV1((doc) => {
      const r = stubReport(doc);
      for (const f of r.features) {
        const w = raised[f.feature];
        if (w) f.warnings = [{ code: w[0], severity: "warning", message: `scripted ${w[0]}`, details: w[1] }];
      }
      return r;
    });
    const TOP = `${PLATE}const top = tag(slab.sides().some());\n`;
    const plusOne = { added: ["f_slab/side:outline.left"], removed: [] };
    const minusThree = { added: [], removed: ["f_slab/side:outline.left", "f_slab/side:outline.right", "f_slab/side:outline.bottom"] };
    const accept = [{ feature: "top", code: "REF_SET_CHANGED", reason: "the extra side is intended" }];

    it("the same code with other details is another warning: the old reason does not explain it", async () => {
      raised = { top: ["REF_SET_CHANGED", plusOne] };
      const ctx = await ctxFor(engine);
      expect((await call(ctx, "apply_cadscript", { source: TOP })).text).toMatch(/FAILED at L1/);
      expect((await call(ctx, "apply_cadscript", { patches: [], accept_warnings: accept })).text).toMatch(/^apply #2: OK/);
      expect(ctx.session.acceptedWarnings).toEqual(accept);
      // An unrelated edit, and the set now drops three sides: not the warning that was explained.
      raised = { top: ["REF_SET_CHANGED", minusThree] };
      const later = await call(ctx, "apply_cadscript", { patches: [{ feature: "depth", code: "const depth = param(55);" }] });
      expect(later.text).toMatch(/^apply #3: OK/);
      expect(later.text).toContain("note warning REF_SET_CHANGED on top: scripted REF_SET_CHANGED");
      expect(later.text).not.toContain("(explained)");
      expect(ctx.session.acceptedWarnings).toEqual([]);
      expect(ctx.session.openWarnings.map((w) => `${w.feature}:${w.code}`)).toEqual(["top:REF_SET_CHANGED"]);
    });

    it("the same instance stays explained across unrelated edits, and lapses when its feature is edited again", async () => {
      raised = { top: ["REF_SET_CHANGED", plusOne] };
      const ctx = await ctxFor(engine);
      await call(ctx, "apply_cadscript", { source: TOP, accept_warnings: accept });
      expect(ctx.session.verification.ok).toBe(true);
      expect((await call(ctx, "apply_cadscript", { patches: [{ feature: "depth", code: "const depth = param(55);" }] })).text).toContain("note warning REF_SET_CHANGED on top (explained)");
      expect(ctx.session.acceptedWarnings).toEqual(accept);
      const edited = await call(ctx, "apply_cadscript", { patches: [{ feature: "top", code: "const top = tag(slab.sides().any());" }] });
      expect(edited.text).toMatch(/^apply #3: FAILED at L1/);
      expect(edited.text).toContain("⚠ top warning REF_SET_CHANGED (on a feature you just changed)");
      expect(ctx.session.acceptedWarnings).toEqual([]);
    });

    it("an explanation given before its warning exists is not kept for later, and rollback drops the ones given after the checkpoint", async () => {
      raised = {};
      const ctx = await ctxFor(engine);
      const early = await call(ctx, "apply_cadscript", { source: TOP, accept_warnings: accept });
      expect(early.text).toMatch(/^apply #1: OK/);
      expect(early.text).toContain('note accept_warnings { feature: "top", code: "REF_SET_CHANGED" } explains nothing: the evaluated model has no such warning, so it was not recorded');
      expect(ctx.session.acceptedWarnings).toEqual([]);
      const cp = ctx.session.checkpoint("before the warning");
      raised = { top: ["REF_SET_CHANGED", plusOne] };
      expect((await call(ctx, "apply_cadscript", { patches: [{ feature: "top", code: "const top = tag(slab.sides().any());" }] })).text).toMatch(/^apply #2: FAILED at L1/);
      expect((await call(ctx, "apply_cadscript", { patches: [], accept_warnings: accept })).text).toMatch(/^apply #3: OK/);
      expect(ctx.session.acceptedWarnings).toEqual(accept);
      ctx.session.rollback(cp.id);
      expect(ctx.session.acceptedWarnings).toEqual([]);
    });

    it("one entry explains one warning: several warnings of one code on a feature each need their own, named by instance tag (review)", async () => {
      // Two pattern instances skipped on the same feature: one explanation must not cover both.
      const engine2 = new ScriptedEngineV1((doc) => {
        const r = stubReport(doc);
        const top = r.features.find((f) => f.feature === "top");
        if (top) top.warnings = [3, 5].map((i) => ({ code: "PATTERN_INSTANCE_SKIPPED", severity: "warning" as const, message: `instance [${i}] skipped`, details: { index: [i], reason: { code: "HOLE_MISSES_BODY" } } }));
        return r;
      });
      const ctx = await ctxFor(engine2);
      const first = await call(ctx, "apply_cadscript", { source: TOP });
      expect(first.text).toMatch(/^apply #1: FAILED at L1/);
      const [a, b] = ctx.session.verification.unexplained;
      expect([a!.siblings, b!.siblings]).toEqual([2, 2]);
      expect(a!.instance).toMatch(/^[0-9a-f]{8}$/);
      expect(a!.instance).not.toBe(b!.instance);
      expect(first.text).toContain(`⚠ top warning PATTERN_INSTANCE_SKIPPED [${a!.instance}] (on a feature you just changed)`);
      expect(first.text).toContain(`accept_warnings: [{ feature: "top", code: "PATTERN_INSTANCE_SKIPPED", instance: "${a!.instance}", reason: "…" }] (2 PATTERN_INSTANCE_SKIPPED warnings on top: one entry each)`);
      // An entry without an instance explains neither, and says why.
      const vague = await call(ctx, "apply_cadscript", { patches: [], accept_warnings: [{ feature: "top", code: "PATTERN_INSTANCE_SKIPPED", reason: "the edge copies are meant to fall off" }] });
      expect(vague.text).toMatch(/^apply #2: FAILED at L1/);
      expect(vague.text).toContain(`explains nothing: 2 PATTERN_INSTANCE_SKIPPED warnings on top share it: give one entry per warning, each with its instance (${a!.instance}, ${b!.instance})`);
      // One instance explained: the other still fails L1.
      const one = await call(ctx, "apply_cadscript", { patches: [], accept_warnings: [{ feature: "top", code: "PATTERN_INSTANCE_SKIPPED", instance: a!.instance, reason: "copy 3 is meant to fall off" }] });
      expect(one.text).toMatch(/^apply #3: FAILED at L1/);
      expect(ctx.session.verification.unexplained.map((w) => w.instance)).toEqual([b!.instance]);
      const wrong = await call(ctx, "apply_cadscript", { patches: [], accept_warnings: [{ feature: "top", code: "PATTERN_INSTANCE_SKIPPED", instance: "deadbeef", reason: "?" }] });
      expect(wrong.text).toContain(`explains nothing: no PATTERN_INSTANCE_SKIPPED warning on top has instance "deadbeef" (instances: ${a!.instance}, ${b!.instance})`);
      const both = await call(ctx, "apply_cadscript", {
        patches: [],
        accept_warnings: [
          { feature: "top", code: "PATTERN_INSTANCE_SKIPPED", instance: a!.instance, reason: "copy 3 is meant to fall off" },
          { feature: "top", code: "PATTERN_INSTANCE_SKIPPED", instance: b!.instance, reason: "copy 5 is meant to fall off" },
        ],
      });
      expect(both.text).toMatch(/^apply #5: OK/);
      expect(ctx.session.acceptedWarnings.map((w) => w.reason)).toEqual(["copy 3 is meant to fall off", "copy 5 is meant to fall off"]);
    });

    it("rollback to a checkpoint that failed L1 restores its baseline: a warning explained only after it counts as edited again (review)", async () => {
      raised = {};
      const ctx = await ctxFor(engine);
      expect((await call(ctx, "apply_cadscript", { source: PLATE })).text).toMatch(/^apply #1: OK/);
      const plate = ctx.session.ir;
      raised = { top: ["REF_SET_CHANGED", plusOne] };
      // Apply A adds `top`, which raises the warning: L1 fails.
      expect((await call(ctx, "apply_cadscript", { source: TOP })).text).toMatch(/^apply #2: FAILED at L1/);
      const cp = ctx.session.checkpoint("try");
      expect(cp.state.baseline).toBe(plate);
      // Re-applying A with the explanation passes: A is the verified baseline now.
      expect((await call(ctx, "apply_cadscript", { patches: [], accept_warnings: accept })).text).toMatch(/^apply #3: OK/);
      ctx.session.rollback(cp.id);
      // Back at "try" (no explanation), whose baseline is the plate without `top`: an unrelated patch must not let the warning pass.
      const unrelated = await call(ctx, "apply_cadscript", { patches: [{ feature: "depth", code: "const depth = param(55);" }] });
      expect(unrelated.text).toMatch(/^apply #4: FAILED at L1/);
      expect(unrelated.text).toContain("⚠ top warning REF_SET_CHANGED (on a feature you just changed)");
      expect(ctx.session.verification.unexplained.map((w) => `${w.feature}:${w.code}`)).toEqual(["top:REF_SET_CHANGED"]);
      // Explaining it again is what clears it.
      expect((await call(ctx, "apply_cadscript", { patches: [], accept_warnings: accept })).text).toMatch(/^apply #5: OK/);
    });
  });

  it("a feature counts as edited when a parameter it uses changed through a derived parameter", () => {
    const src = (a: number) => `${IMPORT}const a = param(${a});\nconst b = param(a * 2);\nconst c = param(7);\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: b, h: 10 }) });\nconst t = sketch(XY, { o: rect({ center: [0, 0], w: c, h: 10 }) });\n`;
    const before = cs.compile(src(10)).ir!;
    const after = cs.compile(src(12), { base: before }).ir!;
    expect([...editedFeatures(before, after)]).toEqual(["s"]);
  });

  it("a parameter named like an IR field (r, depth, distance, h, d) marks only the features whose expressions read it", () => {
    // Keys, ids, curve ids and enum strings that spell the name (r: 2, depth: "through", distance: 10, rect's h, a curve "h") are not uses.
    const src = (v: number, used = false) =>
      `import { part, sketch, extrude, XY, Z, param, rect, circle, hole, fillet, shell } from "@aicad/std";
const r = param(${v});
const depth = param(${v});
const distance = param(${v});
const h = param(${v});
const d = param(${v});
const thickness = param(${v});
const w = param(40);
part("p");
const s = sketch(XY, { o: rect({ center: [0, 0], w: w, h: 20 }), h: circle({ center: [30, 0], radius: 2 }) });
const e = extrude(s, { distance: ${used ? "distance * 5" : "10"} });
const bore = hole(e.cap("end"), { at: { a: [0, 0] }, d: 4, depth: "through" });
const round1 = fillet(e.sides().edges().parallel(Z), { r: 2 });
const hollow = shell(e, { open: e.cap("end"), thickness: 1 });
`;
    const before = cs.compile(src(1)).ir!;
    expect(before).toBeTruthy();
    const after = cs.compile(src(2), { base: before }).ir!;
    expect([...editedFeatures(before, after)]).toEqual([]);
    // A real use still counts: the extrude's IR is the same text ("distance * 5"), only the parameter changed.
    const usedBefore = cs.compile(src(1, true)).ir!;
    const usedAfter = cs.compile(src(2, true), { base: usedBefore }).ir!;
    expect(JSON.stringify(usedAfter.parts[0]!.features)).toBe(JSON.stringify(usedBefore.parts[0]!.features));
    expect([...editedFeatures(usedBefore, usedAfter)]).toEqual(["e"]);
    // Through a derived parameter's bound: w's max reads h.
    const bounded = (v: number) => src(v).replace("const w = param(40);", "const w = param(40, { max: h * 100 });");
    const b0 = cs.compile(bounded(1)).ir!;
    expect([...editedFeatures(b0, cs.compile(bounded(2), { base: b0 }).ir!)]).toEqual(["s"]);
  });
});

describe("one-step repairs", () => {
  it("set_param changes one parameter in place and re-verifies", async () => {
    const ctx = await ctxFor();
    await call(ctx, "apply_cadscript", { source: PLATE });
    const out = await call(ctx, "set_param", { name: "width", value: 100 });
    expect(out.isError).toBeFalsy();
    expect(out.text).toMatch(/^apply #2: OK/);
    expect(out.text).toContain("edit: width = 100");
    expect(out.text).toContain("changes: ~param width 80→100");
    expect(ctx.session.source).toBe(PLATE.replace("param(80,", "param(100,"));
    expect(out.text).toContain("bbox 100×50×8");
  });

  it("set_param outside the bounds is refused by the compiler with the range", async () => {
    const ctx = await ctxFor();
    await call(ctx, "apply_cadscript", { source: PLATE });
    const out = await call(ctx, "set_param", { name: "width", value: 500 });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/FAILED at L0/);
    expect(out.text).toContain("PARAM_OUT_OF_RANGE");
    const unknown = await call(ctx, "set_param", { name: "widht", value: 5 });
    expect(unknown).toMatchObject({ isError: true, text: expect.stringContaining('no parameter "widht" (parameters: width, depth, thick)') });
    // set_param repairs the rejected source: the analysis' IR is the starting point.
    const back = await call(ctx, "set_param", { name: "width", value: 120 });
    expect(back.isError).toBeFalsy();
    expect(ctx.session.source).toContain("const width = param(120, {");
  });

  it("accept_ref_candidate rewrites an ambiguous reference to the chosen candidate's query", async () => {
    // Every evaluation must come from the recording: the pre-apply check of the candidate reads a
    // real Forge report of the edited model (a fixture miss would skip the check silently).
    const misses: string[] = [];
    const engine: EngineV1 = {
      kind: fixture.engine.kind,
      availability: () => fixture.engine.availability(),
      evaluate: async (doc, o) => {
        try {
          return await fixture.engine.evaluate(doc, o);
        } catch (e) {
          misses.push(String(e));
          throw e;
        }
      },
    };
    const ctx = await ctxFor(engine);
    const failed = await call(ctx, "apply_cadscript", { source: AMBIGUOUS });
    expect(failed.text).toContain("✗ top (tag) REF_AMBIGUOUS");
    expect(failed.text).toContain('3. slab/side:outline.right — face at [40, 0, 4] facing [1, 0, 0], tie → slab.side("outline.right")');
    expect(failed.text).toContain('accept_ref_candidate { feature: "top", field: "/target", candidate: <number> }');
    const { chosen } = acceptCandidateEdit(ctx.session.ir!, ctx.session.report, "top", "/target", 3);
    const beforeRepair = ctx.session.checkpoint("before the repair");
    const fixed = await call(ctx, "accept_ref_candidate", { feature: "top", field: "/target", candidate: 3 });
    expect(fixed.isError).toBeFalsy();
    expect(misses).toEqual([]);
    // Forge's report of the accepted model designates exactly candidate 3 (key and probe).
    expect(chosen).toMatchObject({ key: "f_slab/side:outline.right", probe: { kind: "face", point: [40, 0, 4] } });
    expect(candidateResolutionProblem(ctx.session.report!, "top", "/target", chosen)).toBeUndefined();
    expect(fixed.text).toContain('top /target → candidate 3 slab/side:outline.right (slab.side("outline.right"))');
    // The declared count stays: only the query is replaced.
    expect(ctx.session.source).toContain('const top = tag(slab.side("outline.right").one());');
    expect(ctx.session.verification.ok).toBe(true);
    // SPEC-v1 §5.9 also refreshes the capture, which the aicad CLI cannot do yet: the result and the session say so (review).
    expect(ctx.session.ir!.parts[0]!.features.find((f) => f.name === "top")!).not.toHaveProperty(["target", "capture"]);
    expect(fixed.text).toContain("note: top /target now has no capture — this engine cannot capture references yet (SPEC-v1 §5.9 refreshes it)");
    expect(fixed.data).toMatchObject({ kind: "apply", uncaptured: true });
    expect(ctx.session.uncapturedRepairs).toEqual([{ feature: "top", field: "/target", dropped: false }]);
    const bad = await call(ctx, "accept_ref_candidate", { feature: "top", field: "/target", candidate: 1 });
    expect(bad).toMatchObject({ isError: true, text: expect.stringContaining("has no candidates") });
    // The entry is matched by the query's canonical content (review: key order or the compile/print
    // round trip must not lose it), and a later repair of the same field keeps a dropped capture.
    const q = (ctx.session.ir!.parts[0]!.features.find((f) => f.name === "top") as unknown as { target: { q: Record<string, unknown> } }).target.q;
    const reversed = Object.fromEntries(Object.entries(q).reverse());
    expect(Object.keys(reversed)).not.toEqual(Object.keys(q));
    ctx.session.noteCandidateRepair("top", "/target", reversed, true);
    expect(ctx.session.uncapturedRepairs).toEqual([{ feature: "top", field: "/target", dropped: true }]);
    ctx.session.noteCandidateRepair("top", "/target", { ...reversed, unused: undefined }, false);
    expect(ctx.session.uncapturedRepairs).toEqual([{ feature: "top", field: "/target", dropped: true }]);
    // A re-apply of the same source (compiled again) keeps it.
    expect((await call(ctx, "apply_cadscript", { source: ctx.session.source })).isError).toBeFalsy();
    expect(ctx.session.uncapturedRepairs).toEqual([{ feature: "top", field: "/target", dropped: true }]);
    // Rolled back past the repair, the reference is the ambiguous one again: nothing to report.
    ctx.session.rollback(beforeRepair.id);
    expect(ctx.session.uncapturedRepairs).toEqual([]);
  });

  it("accept_ref_candidate refuses to replace a multi-member reference by one candidate (it would drop the others)", async () => {
    const engine = new ScriptedEngineV1((doc) => {
      const r = stubReport(doc);
      const top = r.features.find((f) => f.feature === "top");
      if (top) {
        const member = (curve: string, x: number, y: number) => ({ key: `f_slab/side:outline.${curve}`, name: `slab/side:outline.${curve}`, via: "named" as const, status: "exact" as const, probe: { kind: "face" as const, point: [x, y, 4] as [number, number, number] } });
        const unresolved = [{ key: "f_slab/side:outline.top", name: "slab/side:outline.top", reason: "name-not-found", candidates: [{ key: "f_slab/side:outline.top_a", name: "slab/side:outline.top_a", confidence: 0.7, reason: "split-piece", probe: { kind: "face", point: [0, 25, 4] }, query: { op: "side", feature: "f_slab", curve: "outline.top" } }] }] as unknown as metricsV1.Unresolved[];
        top.status = "error";
        top.error = { code: "REF_UNCERTAIN", message: "matched only geometrically", details: { field: "/target", unresolved } };
        top.refs = [{ field: "/target", status: "failed", members: [member("left", -40, 0), member("right", 40, 0), member("bottom", 0, -25)], unresolved }];
      }
      return r;
    });
    const ctx = await ctxFor(engine);
    const failed = await call(ctx, "apply_cadscript", { source: `${PLATE}const top = tag(slab.sides().some());\n` });
    expect(failed.text).toContain("REF_UNCERTAIN");
    expect(failed.text).not.toContain("accept_ref_candidate {");
    expect(failed.text).toContain("No one-step fix");
    const before = ctx.session.source;
    const out = await call(ctx, "accept_ref_candidate", { feature: "top", field: "/target", candidate: 1 });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("would replace the whole query of top /target");
    expect(out.text).toContain("one or more (.some())");
    expect(out.text).toContain('candidate 1 alone is slab.side("outline.top")');
    expect(ctx.session.source).toBe(before);
    expect(ctx.session.applies).toBe(1);
  });

  it("accept_ref_candidate refuses when the error and the reference entry list the candidates differently", async () => {
    const cand = (curve: string, x: number, y: number) => ({ key: `f_slab/side:outline.${curve}`, name: `slab/side:outline.${curve}`, confidence: 0, reason: "tie", probe: { kind: "face", point: [x, y, 4] }, query: { op: "side", feature: "f_slab", curve: `outline.${curve}` } });
    const listed = (cs: unknown[]) => [{ key: "f_slab/side:outline.top", name: "slab/side:outline.top", reason: "tie", candidates: cs }] as unknown as metricsV1.Unresolved[];
    const engine = new ScriptedEngineV1((doc) => {
      const r = stubReport(doc);
      const top = r.features.find((f) => f.feature === "top");
      if (top) {
        top.status = "error";
        top.error = { code: "REF_AMBIGUOUS", message: "ambiguous", details: { field: "/target", unresolved: listed([cand("left", -40, 0), cand("right", 40, 0)]) } };
        top.refs = [{ field: "/target", status: "failed", members: [], unresolved: listed([cand("right", 40, 0), cand("left", -40, 0)]) }];
      }
      return r;
    });
    const ctx = await ctxFor(engine);
    const failed = await call(ctx, "apply_cadscript", { source: AMBIGUOUS });
    expect(failed.text).toContain("REF_AMBIGUOUS");
    expect(failed.text).not.toContain("accept_ref_candidate {");
    expect(failed.text).toContain("a candidate number is ambiguous");
    const before = ctx.session.source;
    const out = await call(ctx, "accept_ref_candidate", { feature: "top", field: "/target", candidate: 1 });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("top /target: the error's details list 2 candidates and the reference's report entry 2 candidates");
    expect(out.text).toContain("Nothing was applied");
    expect(ctx.session.source).toBe(before);
  });

  describe("accept_ref_candidate checks that the rewritten reference designates the chosen candidate", () => {
    // Before the edit: `slab.sides().one()` is ambiguous; candidate 1 is the right side, candidate 2
    // the second piece of a split bottom side (split pieces share their key, SPEC-v1 §5.8 RefMember).
    const cand = (key: string, name: string, point: [number, number, number], normal: [number, number, number], query: unknown) => ({ key, name, confidence: 0, reason: "tie", probe: { kind: "face", point, normal }, query });
    const unresolved = [
      {
        key: "f_slab/side:outline.top",
        name: "slab/side:outline.top",
        reason: "tie",
        candidates: [
          cand("f_slab/side:outline.right", "slab/side:outline.right", [40, 0, 4], [1, 0, 0], { op: "side", feature: "f_slab", curve: "outline.right" }),
          cand("f_slab/side:outline.bottom", "slab/side:outline.bottom#1", [20, -25, 4], [0, -1, 0], { op: "extreme", of: { op: "side", feature: "f_slab", curve: "outline.bottom" }, dir: "+X", which: "max" }),
        ],
      },
    ] as unknown as metricsV1.Unresolved[];
    /** After the edit the engine resolves `member` (a synthesis bug when it is not the candidate). */
    const engineResolving = (member: metricsV1.RefMember) =>
      new ScriptedEngineV1((doc) => {
        const r = stubReport(doc);
        const top = r.features.find((f) => f.feature === "top");
        const tagged = doc.parts[0]!.features.find((f) => f.name === "top") as unknown as { target: { q: { op: string } } } | undefined;
        if (top && tagged?.target.q.op === "sides") {
          top.status = "error";
          top.error = { code: "REF_AMBIGUOUS", message: "ambiguous", details: { field: "/target", unresolved } };
          top.refs = [{ field: "/target", status: "failed", members: [], unresolved }];
        } else if (top) top.refs = [{ field: "/target", status: "exact", members: [member] }];
        return r;
      });
    const member = (key: string, name: string, point: [number, number, number], normal: [number, number, number]): metricsV1.RefMember => ({ key, name, via: "named", status: "exact", probe: { kind: "face", point, normal } });

    it("applies it when the reference resolves exactly the candidate", async () => {
      const ctx = await ctxFor(engineResolving(member("f_slab/side:outline.right", "slab/side:outline.right", [40, 0, 4 + 1e-9], [1, 0, 0])));
      await call(ctx, "apply_cadscript", { source: AMBIGUOUS });
      const out = await call(ctx, "accept_ref_candidate", { feature: "top", field: "/target", candidate: 1 });
      expect(out.isError).toBeFalsy();
      expect(ctx.session.source).toContain('const top = tag(slab.side("outline.right").one());');
      expect(ctx.session.applies).toBe(2);
    });

    it("refuses, applying nothing, when the synthesised query selects another entity", async () => {
      const engine = engineResolving(member("f_slab/side:outline.left", "slab/side:outline.left", [-40, 0, 4], [-1, 0, 0]));
      const ctx = await ctxFor(engine);
      await call(ctx, "apply_cadscript", { source: AMBIGUOUS });
      const before = ctx.session.source;
      const out = await call(ctx, "accept_ref_candidate", { feature: "top", field: "/target", candidate: 1 });
      expect(out.isError).toBe(true);
      expect(out.data?.kind).toBe("candidate_mismatch");
      expect(out.text).toContain("accept_ref_candidate refused: the candidate's synthesised query makes top /target resolve slab/side:outline.left (face at [-40, 0, 4] facing [-1, 0, 0])");
      expect(out.text).toContain("instead of candidate 1 slab/side:outline.right (face at [40, 0, 4] facing [1, 0, 0])");
      expect(out.text).toContain("key f_slab/side:outline.left is not the candidate's f_slab/side:outline.right");
      expect(out.text).toContain("Nothing was applied");
      expect(ctx.session.source).toBe(before);
      expect(ctx.session.applies).toBe(1);
    });

    it("refuses, applying nothing, when the engine fails on the edited model (the resolution cannot be checked)", async () => {
      // The session cache keeps no engine errors: without this refusal the apply below would evaluate
      // the edit again, succeed, and keep a reference re-aimed at another entity unchecked.
      let failures = 1;
      const inner = engineResolving(member("f_slab/side:outline.left", "slab/side:outline.left", [-40, 0, 4], [-1, 0, 0]));
      const engine: EngineV1 = {
        kind: "scripted",
        availability: () => inner.availability(),
        evaluate: async (doc, o) => {
          const tagged = doc.parts[0]!.features.find((f) => f.name === "top") as unknown as { target: { q: { op: string } } } | undefined;
          if (tagged && tagged.target.q.op !== "sides" && failures-- > 0) throw new EngineError("ENGINE_TIMEOUT", "aicad eval: timed out after 5 ms");
          return inner.evaluate(doc, o);
        },
      };
      const ctx = await ctxFor(engine);
      await call(ctx, "apply_cadscript", { source: AMBIGUOUS });
      const before = ctx.session.source;
      const out = await call(ctx, "accept_ref_candidate", { feature: "top", field: "/target", candidate: 1 });
      expect(out).toMatchObject({ isError: true, data: { kind: "candidate_unchecked", code: "ENGINE_TIMEOUT" } });
      expect(out.text).toContain(
        "accept_ref_candidate refused: the engine could not evaluate the edited model (ENGINE_TIMEOUT: aicad eval: timed out after 5 ms), so it cannot be checked that top /target would designate candidate 1 slab/side:outline.right",
      );
      expect(out.text).toContain("Nothing was applied");
      expect(ctx.session.source).toBe(before);
      expect(ctx.session.applies).toBe(1);
      // The engine answers now: the check runs and refuses the entity the query really selects.
      const again = await call(ctx, "accept_ref_candidate", { feature: "top", field: "/target", candidate: 1 });
      expect(again.data?.kind).toBe("candidate_mismatch");
      expect(ctx.session.source).toBe(before);
      expect(ctx.session.applies).toBe(1);
    });

    it("tells split pieces apart by the probe: the same key elsewhere is refused", async () => {
      const ctx = await ctxFor(engineResolving(member("f_slab/side:outline.bottom", "slab/side:outline.bottom#0", [-20, -25, 4], [0, -1, 0])));
      await call(ctx, "apply_cadscript", { source: AMBIGUOUS });
      const out = await call(ctx, "accept_ref_candidate", { feature: "top", field: "/target", candidate: 2 });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("resolve slab/side:outline.bottom#0 (face at [-20, -25, 4] facing [0, -1, 0]) instead of candidate 2 slab/side:outline.bottom#1 (face at [20, -25, 4] facing [0, -1, 0]): its probe is 40 mm from the candidate's");
      expect(ctx.session.applies).toBe(1);
    });
  });

  it("candidateResolutionProblem: exactly one member, the candidate's key, kind, position (5·tol) and side", () => {
    const chosen = { index: 2, name: "e/side:o.top", query: {}, key: "f_e/side:o.top", probe: { kind: "face" as const, point: [0, 10, 2.5] as [number, number, number], normal: [0, 1, 0] as [number, number, number] } };
    const m = (key: string, point: [number, number, number], extra: Partial<metricsV1.Probe> = {}): metricsV1.RefMember => ({ key, name: key.replace("f_e", "e"), via: "named", status: "exact", probe: { kind: "face", point, normal: [0, 1, 0], ...extra } });
    const report = (members: metricsV1.RefMember[] | undefined, code?: string): metricsV1.EvalReport =>
      ({ features: [{ part: "p", feature: "t", feature_id: "f_t", type: "tag", status: "ok", warnings: [], ...(members === undefined ? {} : { refs: [{ field: "/target", status: members.length === 1 ? "exact" : "failed", members, ...(code ? { code } : {}) }] }) }] }) as unknown as metricsV1.EvalReport;
    const problem = (r: metricsV1.EvalReport) => candidateResolutionProblem(r, "t", "/target", chosen);
    expect(problem(report([m("f_e/side:o.top", [0, 10, 2.5])]))).toBeUndefined();
    expect(problem(report([m("f_e/side:o.top", [0, 10 + 4e-6, 2.5])]))).toBeUndefined();
    expect(CANDIDATE_PROBE_RADIUS_MM).toBeCloseTo(5e-6, 12);
    expect(problem(report([m("f_e/side:o.top", [0, 10 + 6e-6, 2.5])]))).toContain("its probe is 6.00e-6 mm from the candidate's");
    expect(problem(report([m("f_e/side:o.top", [0, 10, 2.5], { kind: "edge" })]))).toContain("a edge, not a face");
    expect(problem(report([m("f_e/side:o.top", [0, 10, 2.5], { normal: [0, -1, 0] })]))).toContain("it faces the other way");
    expect(problem(report([], "REF_MISSING"))).toContain("resolve nothing (REF_MISSING) instead of exactly candidate 2 e/side:o.top (face at [0, 10, 2.5] facing [0, 1, 0])");
    expect(problem(report([m("f_e/side:o.top", [0, 10, 2.5]), m("f_e/side:o.top", [5, 10, 2.5])]))).toContain("resolve 2 entities:");
    expect(problem(report(undefined))).toContain("has no refs entry for /target");
    expect(candidateResolutionProblem(report([]), "nope", "/target", chosen)).toContain("no entry for nope");
  });

  it("sketch_edit removes the suggested constraint of a conflict", async () => {
    const ctx = await ctxFor();
    const failed = await call(ctx, "apply_cadscript", { source: CONFLICT });
    expect(failed.text).toContain('sketch_edit { sketch: "s", remove: ["w2"] }');
    const fixed = await call(ctx, "sketch_edit", { sketch: "s", remove: ["w2"] });
    expect(fixed.isError).toBeFalsy();
    expect(fixed.text).toContain("edit: s: removed w2");
    expect(fixed.text).toMatch(/sketch s: ok, under_constrained, 1 DOF/);
    expect(ctx.session.source).not.toContain("w2:");
    expect(ctx.session.source).toContain('w1: C.distance("a.start", "a.end", 10)');
  });

  it("accept_ref_proposal writes the engine's proposal (query and capture) into the file", async () => {
    const proposal = { kind: "face", q: { op: "side", feature: "f_slab", curve: "outline.top" }, capture: { members: [{ key: "f_slab/side:outline.top", via: "named", geom: { type: "plane", carrier: { plane: { normal: [0, 1, 0], offset: 25 } }, bbox: [[-40, 25, 0], [40, 25, 8]], size: 640, centroid: [0, 25, 4], local: [0.5, 1, 0.5], body_center: [0, 0, 4], neighbors: 0 } }] } };
    const engine = new ScriptedEngineV1((doc) => {
      const tagged = doc.parts[0]!.features.find((f) => f.name === "top") as unknown as { target: { q: { op: string } } } | undefined;
      const set = tagged?.target.q.op === "sides";
      return stubReport(doc, set ? { code: "REF_SET_CHANGED", severity: "warning", message: "set changed", details: { field: "/target", added: ["f_slab/side:outline.top"], removed: [], proposal } } : undefined, set ? proposal : undefined);
    });
    const ctx = await ctxFor(engine);
    const first = await call(ctx, "apply_cadscript", { source: `${PLATE}const top = tag(slab.sides().some());\n`, accept_warnings: [] });
    expect(first.text).toContain("REF_SET_CHANGED");
    expect(first.text).toContain('accept_ref_proposal { feature: "top", field: "/target" }');
    const out = await call(ctx, "accept_ref_proposal", { feature: "top", field: "/target" });
    expect(out.isError).toBeFalsy();
    expect(ctx.session.source).toContain('const top = tag(slab.side("outline.top"));');
    const tag = ctx.session.ir!.parts[0]!.features.find((f) => f.name === "top") as unknown as { target: { capture?: unknown } };
    expect(tag.target.capture).toEqual(proposal.capture);
  });
});

describe("query and describe", () => {
  it("query counts what a selector matches, with names and probes, without changing the model", async () => {
    const ctx = await ctxFor();
    await call(ctx, "apply_cadscript", { source: PLATE });
    const src = ctx.session.source;
    const edges = await call(ctx, "query", { selector: "slab.sides().edges().parallel(Z)" });
    expect(edges.text).toMatch(/^slab\.sides\(\)\.edges\(\)\.parallel\(Z\): 4 entities \(not unique/);
    expect(edges.text).toContain("edge through [");
    const cap = await call(ctx, "query", { selector: 'slab.cap("end")' });
    expect(cap.text).toMatch(/: 1 entity \(unique\)/);
    expect(cap.text).toContain("slab/cap:end — face at [");
    expect(cap.text).toContain("facing [0, 0, 1]");
    const none = await call(ctx, "query", { selector: "slab.faces().cylinders()" });
    expect(none.text).toMatch(/: 0 entities \(nothing matches/);
    const one = await call(ctx, "query", { selector: "slab.sides().one()" });
    expect(one.text).toContain("declared count fails: REF_AMBIGUOUS");
    const typo = await call(ctx, "query", { selector: 'slab.side("outline.lft")' });
    expect(typo).toMatchObject({ isError: true, text: expect.stringContaining("QUERY_UNKNOWN_CURVE") });
    expect(ctx.session.source).toBe(src);
    expect(ctx.session.applies).toBe(1);
  });

  it("describe finds an entity by name or near a point", async () => {
    const ctx = await ctxFor();
    await call(ctx, "apply_cadscript", { source: PLATE });
    const byName = await call(ctx, "describe", { name: "slab/cap:end" });
    expect(byName.text).toBe("slab/cap:end (key f_slab/cap:end@outline.bottom): face at [0, 0, 8] facing [0, 0, 1]");
    const near = await call(ctx, "describe", { point: [40, 0, 4] });
    expect(near.text.split("\n")[0]).toContain("slab/side:outline.right");
  });
});

describe("editability probe and spec tests on v1", () => {
  it("varies every driving parameter ±20 % and reports the variants that break", async () => {
    const ok = await ctxFor();
    await call(ok, "apply_cadscript", { source: PLATE });
    const plate = await ok.session.editabilityProbe();
    expect(plate).toEqual({ varied: ["width", "depth", "thick"], failures: [], skipped: [], notProbed: [] });

    const fragile = await ctxFor();
    await call(fragile, "apply_cadscript", { source: FRAGILE });
    const r = await fragile.session.editabilityProbe();
    expect(r?.varied).toEqual(["w"]);
    expect(r?.failures).toHaveLength(1);
    expect(r?.failures[0]).toMatchObject({ param: "w", value: 8, code: "INVALID_VALUE", where: "s" });
    expect(r?.failures[0]!.hint).toContain("s.r = 4.5, expected in [0, 4]");
  });

  it("keeps variations inside the unit's domain: counts stay ≥ 1 (≥ 2 once ≥ 2), a full turn is not tried at 432°", () => {
    expect(variations({ value: 1, unit: "count" })).toEqual([2]);
    expect(variations({ value: 2, unit: "count" })).toEqual([3]);
    expect(variations({ value: 5, unit: "count" })).toEqual([4, 6]);
    expect(variations({ value: 360, unit: "deg" })).toEqual([288]);
    expect(variations({ value: 90, unit: "deg" })).toEqual([72, 108]);
    expect(variations({ value: 10, unit: "mm", min: 9 })).toEqual([9, 12]);
    expect(variations({ value: 0, unit: "mm" })).toEqual([]);
  });

  it("retries a variation at an expression bound the engine evaluated, and stops when the wall-time budget is spent", async () => {
    // `thick` is bounded by an expression: the engine reports PARAM_OUT_OF_RANGE with the evaluated bound.
    const source = PLATE.replace("const thick = param(8, { min: 2 });", 'const thick = param(8, { min: 2, max: width / 9 });');
    const seen: number[] = [];
    const engine = new ScriptedEngineV1((doc) => {
      const thick = doc.params!.find((p) => p.name === "thick")!.value as number;
      seen.push(thick);
      const r = stubReport(doc);
      if (thick > 80 / 9) {
        r.status = "error";
        r.params = [{ name: "thick", scope: "doc", unit: "mm", error: { code: "PARAM_OUT_OF_RANGE", message: "out of range", details: { name: "thick", value: thick, min: 2, max: 80 / 9 } } }];
      }
      return r;
    });
    const ctx = await ctxFor(engine);
    expect((await call(ctx, "apply_cadscript", { source })).text).toMatch(/^apply #1: OK/);
    const r = await ctx.session.editabilityProbe();
    expect(r?.failures).toEqual([]);
    expect(r?.notProbed).toEqual([]);
    expect(seen).toContain(9.6);
    expect(seen).toContain(80 / 9);
    const budget = await ctx.session.editabilityProbe({ timeLeftMs: () => 0 });
    expect(budget?.varied).toEqual([]);
    expect(budget?.notProbed.map((n) => n.param)).toEqual(["width", "depth", "thick"]);
    expect(budget?.notProbed[0]!.reason).toContain("wall-time budget");
  });

  it("edit task: a count compared with the starting model cannot pin the requested hole — submit_spec refuses it, an absolute count passes (review)", async () => {
    const base = await ctxFor(new ScriptedEngineV1((doc) => stubReport(doc)), PLATE);
    const ctx: DesignToolContextV1 = { ...base, request: "add a Ø5 through hole in the centre of the plate" };
    expect(ctx.session.context).toBeDefined();
    const spec = specWriterRegistryV1();
    const requirements = [{ id: "R1", text: "Ø5 through hole in the centre of the plate" }];
    const submit = () => spec.execute({ name: "submit_spec", input: { summary: "plate with a hole", requirements, assumptions: [], key_dimensions: [] } }, ctx);
    for (const t of [
      { id: "hole", description: "R1: the hole", check: "face_count", eq: "$context" },
      { id: "hole", description: "R1: the hole", check: "edge_count", approx: "$context", abs: 0 },
    ]) {
      expect((await spec.execute({ name: "set_spec_tests", input: { tests: [t] } }, ctx)).isError, JSON.stringify(t)).toBeFalsy();
      const refused = await submit();
      expect(refused, JSON.stringify(t)).toMatchObject({ isError: true, data: { kind: "spec_coverage" } });
      expect(refused.text).toContain('compares with the starting model ("$context"), which holds only while the model is unchanged');
      expect(ctx.session.testsFrozen).toBe(false);
    }
    await spec.execute({ name: "set_spec_tests", input: { tests: [{ id: "hole", description: "R1: the hole", check: "face_count", type: "cylinder", eq: 1 }] } }, ctx);
    expect((await submit()).text).toBe("Spec frozen: 1 requirement, 1 test.");
  });

  it("spec tests measure final bodies; checks v1 cannot measure are refused", async () => {
    const ctx = await ctxFor();
    const spec = specWriterRegistryV1();
    const refused = await spec.execute({ name: "set_spec_tests", input: { tests: [{ id: "holes", description: "R1: four holes", check: "curve_count", kind: "circle", eq: 4 }] } }, ctx);
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining("curve_count is not available on CadScript v1 models yet") });
    const set = await spec.execute(
      {
        name: "set_spec_tests",
        input: {
          tests: [
            { id: "valid", description: "R1: valid", check: "valid", eq: true },
            { id: "size", description: "R1: 80 x 50 x 8", check: "bbox_sorted", approx: [8, 50, 80], abs: 0.05 },
            { id: "one", description: "R1: one body", check: "body_count", eq: 1 },
          ],
        },
      },
      ctx,
    );
    expect(set.isError).toBeFalsy();
    const out = await call(ctx, "apply_cadscript", { source: PLATE });
    expect(out.text).toMatch(/^apply #1: OK \(L0–L2 pass; spec tests 3\/3\)/);
  });
});

describe("apply guards and the wall-time cap", () => {
  it("a guard that refuses the evaluated state leaves the session as it was", async () => {
    const session = await DesignSessionV1.open({ engine: new ScriptedEngineV1((doc) => stubReport(doc)), name: "design" });
    await session.apply(PLATE);
    const before = session.state;
    const out = await session.apply(PLATE.replace("param(80,", "param(90,"), { guard: (s) => (s.report ? "the check failed" : undefined) });
    expect(out.refused).toBe("the check failed");
    expect(out.after.report).not.toBeNull();
    expect(session.state).toBe(before);
    expect(session.applies).toBe(1);
  });

  it("every engine evaluation is cut at the task's remaining wall time, and none starts once it is used up", async () => {
    let left = 5000.2;
    const limits: (number | undefined)[] = [];
    const engine = new ScriptedEngineV1((doc, o) => {
      limits.push(o.timeoutMs);
      return stubReport(doc);
    });
    const session = await DesignSessionV1.open({ engine, name: "design", timeLeftMs: () => left });
    expect((await session.apply(PLATE)).after.verification.ok).toBe(true);
    expect(limits).toEqual([5001]);
    left = 0;
    const out = await session.apply(PLATE.replace("param(80,", "param(90,"));
    expect(out.after.verification.engineError).toMatchObject({ code: "ENGINE_TIMEOUT", message: "not evaluated: the task's wall-time cap is used up" });
    expect(engine.evaluations).toBe(1);
    // A cached report needs no engine time.
    expect((await session.apply(PLATE)).after.verification.ok).toBe(true);
  });
});

describe("engine failures", () => {
  it("an engine error is an L1 failure with the engine playbook", async () => {
    const engine = new ScriptedEngineV1(() => {
      throw new EngineError("ENGINE_TIMEOUT", "aicad eval: timed out after 5 ms");
    });
    const ctx = await ctxFor(engine);
    const out = await call(ctx, "apply_cadscript", { source: PLATE });
    expect(out.text).toContain("L1 kernel: engine error ENGINE_TIMEOUT");
    expect(out.text).toContain("Try a simpler variant");
    expect(out.data).toMatchObject({ kind: "apply", ok: false, engineError: "ENGINE_TIMEOUT" });
  });
});

/** A minimal valid report for `doc`: every feature ok, one box body, an optional warning on `top` (or `on.feature`). */
function stubReport(doc: irTypes.IrDocument, warning?: metricsV1.Warning, proposal?: unknown, on?: { feature: string; code: string }): metricsV1.EvalReport {
  const body: metricsV1.BodyReport = { origin: { feature: "f_slab", member: "outline.bottom" }, volume: 32000, area: 10080, centroid: [0, 0, 4], bbox_min: [-40, -25, 0], bbox_max: [40, 25, 8], faces: 6, edges: 12, shells: 1, face_types: { plane: 6 }, edge_types: { line: 12 }, valid: true };
  const features = doc.parts[0]!.features.map((f): metricsV1.FeatureReport => {
    const e: metricsV1.FeatureReport = { part: "plate", feature: f.name, feature_id: f.id, type: f.type, status: "ok", warnings: [] };
    if (f.type === "extrude") e.bodies = [{ ...body, change: "created" }];
    if (f.name === "top") {
      e.refs = [{ field: "/target", status: warning ? "accepted" : "exact", members: [{ key: "f_slab/side:outline.top", name: "slab/side:outline.top", via: "named", status: "exact", probe: { kind: "face", point: [0, 25, 4], normal: [0, 1, 0] } }], ...(proposal ? { proposal: proposal as metricsV1.Ref, added: ["f_slab/side:outline.top"] } : {}) }];
      if (warning) e.warnings = [warning];
    }
    if (on && f.name === on.feature) e.warnings = [{ code: on.code, severity: "warning", message: "scripted warning", details: {} }];
    return e;
  });
  return irTypes.parseEvalReport({ schema: irTypes.METRICS_SCHEMA, engine: "scripted", document: "design", status: "ok", features, params: [], parts: [{ part: "plate", part_id: doc.parts[0]!.id, bodies: [body] }] });
}

// Keep the compile of every source here exercised (a CadScript change that breaks one shows up as a compile error, not a fixture miss).
describe("sources compile", () => {
  it.each([["PLATE", PLATE], ["AMBIGUOUS", AMBIGUOUS], ["CONFLICT", CONFLICT], ["REDUNDANT", REDUNDANT], ["FRAGILE", FRAGILE]])("%s", (_name, source) => {
    const r = cs.compile(source);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});
