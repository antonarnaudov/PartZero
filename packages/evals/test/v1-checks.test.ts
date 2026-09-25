import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { metricsV1 } from "@aicad/ir-types";
import { bodiesOf, describeTest, evaluateTest, variantKey, type CheckContext, type Subject, type VariantOutcome } from "../src/checks.js";
import { subjectV1 } from "../src/pipeline.js";
import type { HiddenTest } from "../src/task.js";
import { circlesV1, curvesV1, holesV1, refChanges, v0ViewOfV1, withParams } from "../src/v1/subject.js";
import { loadCandidates } from "../src/candidates.js";
import { body, bodyV1, compileV1Ok, CORPUS_V1_DIR, corpusTasksV1, featureV1, fixtureEngineV1, reportV1, simpleReport } from "./helpers.js";

function t(p: Partial<HiddenTest> & { check: HiddenTest["check"] }): HiddenTest {
  return { id: "t", description: "a test", ...p } as HiddenTest;
}

function run(test: HiddenTest, candidate: Subject, extra: Partial<CheckContext> = {}) {
  return evaluateTest(test, { candidate, ...extra });
}

const DOC = compileV1Ok(`import { doc, part, param, sketch, extrude, rect, circle, fillet, chamfer, shell, hole, grid, linearPattern, circularPattern, mirror, XY, X, Z, YZ } from "@aicad/std";
doc({ name: "fixture" });
const r = param(3);
const pitch = param(12);
part("part");
const sk = sketch(XY, { o: rect({ center: [0, 0], w: 100, h: 60 }), c: circle({ center: [-40, -20], radius: 2 }) });
const e = extrude(sk, { distance: 10 });
const f = fillet(e.sides().edges().parallel(Z), { r: r + 1 });
const ch = chamfer(e.cap("end").edges(), { d: 0.5 });
const sh = shell(e, { open: e.cap("end"), thickness: r - 1 });
const h = hole(e.cap("end"), { at: { a: [10, 0] }, size: "M3", depth: "through", cbore: "iso4762" });
const lp = linearPattern([h], { dir: X, count: 3, spacing: pitch });
const cp = circularPattern([h], { axis: Z, count: 4 });
const mp = mirror([h], { plane: YZ });
const ep = linearPattern([e], { dir: "+Y", count: 2, spacing: 70 });
const bad = circularPattern([h], { axis: { cylinder: e.side("o.left") }, count: 3 });
`);

const HOLE: metricsV1.HoleReport = { at: "a", center: [10, 0, 10], axis: [0, 0, -1], d: 3.4, depth: null, kind: "counterbore", size: "M3", cbore: { d: 6.5, depth: 3.4 } };

function fullReport(over: { features?: metricsV1.FeatureReport[]; bodies?: metricsV1.BodyReport[] } = {}): metricsV1.EvalReport {
  const features = over.features ?? [
    featureV1({ type: "sketch", feature: "sk", feature_id: "f_sk", regions: [{ area: 1, loops: 2, outer_curves: ["o.bottom"] }], sketch: {
      mode: "explicit",
      solved: [
        { kind: "line", id: "o.bottom", start: [-50, -30], end: [50, -30] },
        { kind: "circle", id: "c", center: [-40, -20], radius: 2 },
        { kind: "point", id: "p", at: [0, 0] },
      ],
    } }),
    featureV1({ type: "extrude", feature: "e", feature_id: "f_e", bodies: [bodyV1({ change: "created" })] }),
    featureV1({ type: "fillet", feature: "f", feature_id: "f_f", fillet: { edges: ["k1", "k2", "k3", "k4"], faces_created: [] }, bodies: [bodyV1({ change: "modified" })] }),
    featureV1({ type: "chamfer", feature: "ch", feature_id: "f_ch", chamfer: { edges: ["k1", "k2"], faces_created: [] } }),
    featureV1({ type: "shell", feature: "sh", feature_id: "f_sh", shell: { removed_faces: ["top"] } }),
    featureV1({ type: "hole", feature: "h", feature_id: "f_h", holes: [HOLE], refs: [{ field: "/on/face", status: "exact", members: [] }] }),
    featureV1({ type: "pattern", feature: "lp", feature_id: "f_lp", pattern: { instances: 2 } }),
    featureV1({ type: "pattern", feature: "cp", feature_id: "f_cp", pattern: { instances: 3, skipped: [[2]] }, warnings: [{ code: "PATTERN_INSTANCE_SKIPPED", severity: "warning", message: "x" }] }),
    featureV1({ type: "pattern", feature: "mp", feature_id: "f_mp", pattern: { instances: 1 } }),
    featureV1({ type: "pattern", feature: "ep", feature_id: "f_ep", pattern: { instances: 1 } }),
    featureV1({ type: "pattern", feature: "bad", feature_id: "f_bad", pattern: { instances: 2 }, refs: [{ field: "/layout/circular/axis/cylinder", status: "accepted", members: [] }] }),
  ];
  return reportV1(features, {
    bodies: over.bodies ?? [bodyV1({ min: [-50, -30, 0], max: [50, 30, 10] })],
    params: [
      { name: "r", scope: "doc", unit: "mm", value: 3 },
      { name: "pitch", scope: "doc", unit: "mm", value: 12 },
    ],
  });
}

const S = subjectV1(fullReport(), DOC);

describe("the v0 view of an IR v1 report", () => {
  it("puts each part's final bodies on its last ok feature, never a feature's own (created or modified) bodies", () => {
    const view = v0ViewOfV1(fullReport());
    const bodies = bodiesOf(view);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.bbox_max).toEqual([50, 30, 10]);
    expect(run(t({ check: "body_count", eq: 1 }), S).pass).toBe(true);
    expect(run(t({ check: "bbox_size", approx: [100, 60, 10], abs: 1e-9 }), S).pass).toBe(true);
    expect(run(t({ check: "feature_count", type: "pattern", eq: 5 }), S).pass).toBe(true);
    expect(run(t({ check: "region_count", eq: 1 }), S).pass).toBe(true);
    expect(run(t({ check: "inner_loops", eq: 1 }), S).pass).toBe(true);
  });

  it("keeps failed features failed and the status", () => {
    const r = fullReport();
    r.features[2] = { ...r.features[2]!, status: "error", error: { code: "FILLET_RADIUS_TOO_LARGE", message: "too big", details: { max_feasible_r: 3.41 } } };
    r.status = "error";
    const view = v0ViewOfV1(r);
    expect(view.status).toBe("error");
    expect(view.features[2]).toMatchObject({ status: "error", error: { code: "FILLET_RADIUS_TOO_LARGE" } });
    expect(run(t({ check: "status", eq: "error" }), subjectV1(r, DOC)).pass).toBe(true);
    expect(run(t({ check: "blend_edges", type: "fillet", eq: 0 }), subjectV1(r, DOC)).pass).toBe(true);
  });
});

describe("hole checks on IR v1 models", () => {
  it("see hole instances, sketch circles and every pattern copy (skip and skipped instances left out)", () => {
    const holes = holesV1(S.v1!);
    const ids = holes.map((h) => h.id);
    expect(ids).toContain("sk.c");
    expect(ids).toContain("h/a");
    // linear: 2 copies; circular: count 4 → 3 instances, 1 skipped at run time → 2; mirror: 1; extrude seed: circle copy.
    expect(ids.filter((i) => i.startsWith("h/a#lp"))).toHaveLength(2);
    expect(ids.filter((i) => i.startsWith("h/a#cp"))).toHaveLength(2);
    expect(ids.filter((i) => i.startsWith("h/a#mp"))).toHaveLength(1);
    expect(ids.filter((i) => i.startsWith("sk.c#ep"))).toHaveLength(1);
    const at = (id: string) => holes.find((h) => h.id === id)!;
    expect(at("h/a#lp.1").center).toEqual([22, 0, 10]);
    expect(at("h/a#lp.2").center).toEqual([34, 0, 10]);
    expect(at("h/a#cp.1").center![0]).toBeCloseTo(0, 12);
    expect(at("h/a#cp.1").center![1]).toBeCloseTo(10, 12);
    expect(at("h/a#cp.2").center![0]).toBeCloseTo(0, 12); // index 3 (skipped index 2)
    expect(at("h/a#cp.2").center![1]).toBeCloseTo(-10, 12);
    expect(at("h/a#mp.1").center).toEqual([-10, 0, 10]);
    expect(at("h/a#mp.1").axis).toEqual([0, 0, -1]);
    expect(at("sk.c#ep.1").center).toEqual([-40, 50, 0]);
    expect(at("h/a#bad.1").center).toBeUndefined();
    expect(at("h/a#bad.1").unplaced).toMatch(/cylinder axis at \/layout\/circular\/axis has no resolved member/);
  });

  it("hole_count counts hole instances (with pattern copies) matching the filter", () => {
    expect(run(t({ check: "hole_count", eq: 8 }), S).pass).toBe(true); // 1 + 2 + 2 + 1 + 2 (unplaced copies count)
    expect(run(t({ check: "hole_count", hole: { kind: "counterbore", size: "M3", cbore_d: [6.49, 6.51], through: true }, eq: 8 }), S).pass).toBe(true);
    expect(run(t({ check: "hole_count", hole: { size: "M4" }, eq: 0 }), S).pass).toBe(true);
    expect(run(t({ check: "hole_count", hole: { through: false }, eq: 0 }), S).pass).toBe(true);
    expect(run(t({ check: "hole_count", hole: { threaded: true }, eq: 0 }), S).pass).toBe(true);
    expect(run(t({ check: "hole_count", hole: { cbore_depth: [3, 3.3] }, eq: 0 }), S).pass).toBe(true);
  });

  it("hole_positions fails with the reason when a hole of the diameter has no position", () => {
    const r = run(t({ check: "hole_positions", diameter: [3.3, 3.5], points: [[10, 0, 0]] }), S);
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/h\/a#bad\.1 .* has no position: pattern bad/);
    const circles = run(t({ check: "hole_positions", diameter: [3.9, 4.1], points: [[-40, -20, 5], [-40, 50, 5]] }), S);
    expect(circles.pass).toBe(true);
  });

  it("hole_pattern and curve_count work on placed holes and count hole instances as circles", () => {
    const r = fullReport();
    r.features = r.features.filter((f) => f.feature !== "bad");
    const s = subjectV1(r, DOC);
    const pat = run(t({ check: "hole_pattern", diameter: [3.3, 3.5], points: [[10, 0], [22, 0], [34, 0], [0, 10], [0, -10], [-10, 0]] }), s);
    expect(pat.pass).toBe(true);
    expect(run(t({ check: "curve_count", kind: "circle", diameter: [3.3, 3.5], eq: 6 }), s).pass).toBe(true);
    expect(run(t({ check: "curve_count", kind: "circle", diameter: [3.9, 4.1], eq: 2 }), s).pass).toBe(true); // sketch circle + extrude-seed copy
    expect(run(t({ check: "curve_count", kind: "line", eq: 1 }), s).pass).toBe(true); // points and construction are not curves
  });

  it("places circles of sketches on faces (probe normal, SPEC-v1 §3.1) and on datum planes (report frame)", () => {
    const doc = compileV1Ok(`import { doc, part, sketch, extrude, rect, circle, datumPlane, XY } from "@aicad/std";
part("part");
const base = sketch(XY, { o: rect({ center: [0, 0], w: 40, h: 20 }) });
const e = extrude(base, { distance: 10 });
const top = sketch(e.side("o.right"), { c: circle({ center: [3, 4], radius: 1 }) });
const topCut = extrude(top, { distance: 2, direction: "reverse", op: "cut", targets: e });
const d = datumPlane({ offset: XY, distance: 30 });
const up = sketch(d, { k: circle({ center: [1, 2], radius: 1.5 }) });
const upPeg = extrude(up, { distance: 2 });
`);
    const r = reportV1([
      featureV1({ type: "sketch", feature: "base", feature_id: "f_base" }),
      featureV1({ type: "extrude", feature: "e", feature_id: "f_e" }),
      featureV1({
        type: "sketch",
        feature: "top",
        feature_id: "f_top",
        refs: [{ field: "/plane/face", status: "exact", members: [{ key: "k", name: "n", via: "named", status: "exact", probe: { kind: "face", point: [20, 5, 7], normal: [1, 0, 0] } }] }],
        sketch: { mode: "explicit", solved: [{ kind: "circle", id: "c", center: [3, 4], radius: 1 }] },
      }),
      featureV1({ type: "extrude", feature: "topCut", feature_id: "f_topCut" }),
      featureV1({ type: "datum_plane", feature: "d", feature_id: "f_d", datum: { origin: [0, 0, 30], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] } }),
      featureV1({ type: "sketch", feature: "up", feature_id: "f_up", sketch: { mode: "explicit", solved: [{ kind: "circle", id: "k", center: [1, 2], radius: 1.5 }] } }),
      featureV1({ type: "extrude", feature: "upPeg", feature_id: "f_upPeg" }),
    ]);
    const holes = holesV1({ report: r, doc });
    // Outward normal +X: x = +Y, y = +Z, origin (20, 0, 0).
    expect(holes.find((h) => h.id === "top.c")).toMatchObject({ center: [20, 3, 4], axis: [1, 0, 0] });
    expect(holes.find((h) => h.id === "up.k")).toMatchObject({ center: [1, 2, 30], axis: [0, 0, 1] });
  });
});

describe("hole sides, placed pattern axes and double-drawn holes", () => {
  it("hole_count's dir filter reads the drilling direction of each instance (pattern copies transformed)", () => {
    // 8 counterbores; the 2 copies of the pattern about an unplaceable axis have no direction.
    expect(run(t({ check: "hole_count", hole: { kind: "counterbore", dir: "-Z" }, eq: 6 }), S).pass).toBe(true);
    expect(run(t({ check: "hole_count", hole: { dir: "+Z" }, eq: 0 }), S).pass).toBe(true);
    const r = fullReport();
    const h = r.features.find((f) => f.feature === "h")!;
    h.holes = [{ ...HOLE, center: [10, 0, 0], axis: [0, 0, 1] }];
    const flipped = subjectV1(r, DOC);
    expect(run(t({ check: "hole_count", hole: { kind: "counterbore", dir: "-Z" }, eq: 0 }), flipped).pass).toBe(true);
    expect(run(t({ check: "hole_count", hole: { kind: "counterbore", dir: "+Z" }, eq: 6 }), flipped).pass).toBe(true); // unplaced copies have no direction
  });

  it("hole_positions with entry compares where each hole opens, so a hole drilled from the wrong face fails", () => {
    const r = fullReport();
    r.features = r.features.filter((f) => f.type !== "pattern");
    const top = subjectV1(r, DOC);
    const onTop = t({ check: "hole_positions", diameter: [3.3, 3.5], entry: true, points: [[10, 0, 10]] });
    expect(run(onTop, top).pass).toBe(true);
    expect(run({ ...onTop, entry: false, points: [[10, 0, 0]] }, top).pass).toBe(true); // axis mode: anywhere on the axis
    const below = fullReport();
    below.features = below.features.filter((f) => f.type !== "pattern");
    below.features.find((f) => f.feature === "h")!.holes = [{ ...HOLE, center: [10, 0, 0], axis: [0, 0, 1] }];
    const res = run(onTop, subjectV1(below, DOC));
    expect(res.pass).toBe(false);
    expect(res.message).toMatch(/no hole opening within 0\.05 mm of \[10, 0, 10\] \(found entry points \[\[10, 0, 0\]\]\)/);
    expect(run({ ...onTop, entry: false }, subjectV1(below, DOC)).pass).toBe(true);
  });

  const AXES = compileV1Ok(`import { doc, part, sketch, extrude, rect, circle, hole, circularPattern, linearPattern, XY } from "@aicad/std";
part("part");
const sk = sketch(XY, { o: rect({ center: [0, 0], w: 100, h: 100 }), hub: circle({ center: [5, 5], radius: 6 }) });
const e = extrude(sk, { distance: 10 });
const bore = hole(e.cap("end"), { at: { axle: [5, 5] }, d: 8, depth: "through" });
const h = hole(e.cap("end"), { at: { a: [25, 5] }, d: 4, depth: "through" });
const byBore = circularPattern([h], { axis: { cylinder: bore.wall("axle") }, count: 4 });
const byHub = circularPattern([h], { axis: { cylinder: e.side("hub") }, count: 2 });
const byEdge = linearPattern([h], { dir: { edge: e.edgeAt("o.bottom", "end") }, count: 2, spacing: 3 });
`);
  const member = (key: string): metricsV1.RefMember => ({ key, name: key, via: "named", status: "exact", probe: { kind: "face", point: [0, 0, 0], normal: [1, 0, 0] } });
  function axesReport(copyKey = "f_bore/wall@axle"): metricsV1.EvalReport {
    return reportV1([
      featureV1({ type: "sketch", feature: "sk", feature_id: "f_sk", sketch: { mode: "explicit", solved: [{ kind: "line", id: "o.bottom", start: [-50, -50], end: [50, -50] }, { kind: "circle", id: "hub", center: [5, 5], radius: 6 }] } }),
      featureV1({ type: "extrude", feature: "e", feature_id: "f_e" }),
      featureV1({ type: "hole", feature: "bore", feature_id: "f_bore", holes: [{ at: "axle", center: [5, 5, 10], axis: [0, 0, -1], d: 8, depth: null, kind: "simple" }] }),
      featureV1({ type: "hole", feature: "h", feature_id: "f_h", holes: [{ at: "a", center: [25, 5, 10], axis: [0, 0, -1], d: 4, depth: null, kind: "simple" }] }),
      featureV1({ type: "pattern", feature: "byBore", feature_id: "f_byBore", pattern: { instances: 3 }, refs: [{ field: "/layout/circular/axis/cylinder", status: "exact", members: [member(copyKey)] }] }),
      featureV1({ type: "pattern", feature: "byHub", feature_id: "f_byHub", pattern: { instances: 1 }, refs: [{ field: "/layout/circular/axis/cylinder", status: "exact", members: [member("f_e/side:hub")] }] }),
      featureV1({ type: "pattern", feature: "byEdge", feature_id: "f_byEdge", pattern: { instances: 1 }, refs: [{ field: "/layout/linear/dir/edge", status: "exact", members: [member("f_e/edge:{f_e/side:o.bottom|f_e/side:o.right}@o.bottom.end")] }] }),
    ]);
  }

  it("places circular copies about a hole's bore, a swept circle, and linear copies along a junction edge", () => {
    const holes = holesV1({ report: axesReport(), doc: AXES });
    const at = (id: string) => holes.find((h) => h.id === id)!;
    // About the bore's axis (5, 5): 90° steps (the axis is sign-canonical +Z).
    expect(at("h/a#byBore.1").center![0]).toBeCloseTo(5, 12);
    expect(at("h/a#byBore.1").center![1]).toBeCloseTo(25, 12);
    expect(at("h/a#byBore.2").center![0]).toBeCloseTo(-15, 12);
    // About the hub circle's axis (5, 5): 180°.
    expect(at("h/a#byHub.1").center![0]).toBeCloseTo(-15, 12);
    // Along the junction edge swept from o.bottom's end: the sketch normal +Z (a vertical edge).
    expect(at("h/a#byEdge.1").center).toEqual([25, 5, 13]);
    const pos = t({ check: "hole_positions", diameter: [3.9, 4.1], points: [[25, 5, 0], [5, 25, 0], [-15, 5, 0], [5, -15, 0], [-15, 5, 5], [25, 5, 3]] });
    expect(run(pos, subjectV1(axesReport(), AXES)).pass).toBe(true);
  });

  it("does not place an axis taken from a pattern copy (the key names the seed), and says why", () => {
    const holes = holesV1({ report: axesReport("f_p/copy:{f_bore/wall@axle}@1"), doc: AXES });
    expect(holes.find((h) => h.id === "h/a#byBore.1")!.unplaced).toMatch(/pattern copy/);
  });

  it("counts a hole once when it is both cut from a sketch circle and drilled there, and ignores sketches nothing sweeps", () => {
    const marked = compileV1Ok(`import { doc, part, sketch, extrude, rect, circle, hole, XY } from "@aicad/std";
part("part");
const sk = sketch(XY, { o: rect({ center: [0, 0], w: 40, h: 40 }), mark: circle({ center: [10, 0], radius: 2 }) });
const e = extrude(sk, { distance: 5 });
const loose = sketch(XY, { m2: circle({ center: [-10, 0], radius: 2 }) });
const h = hole(e.cap("end"), { at: sk.points("mark.center"), d: 4, depth: "through" });
const h2 = hole(e.cap("end"), { at: loose.points("m2.center"), d: 4, depth: "through" });
`);
    const r = reportV1([
      featureV1({ type: "sketch", feature: "sk", feature_id: "f_sk", sketch: { mode: "explicit", solved: [{ kind: "circle", id: "mark", center: [10, 0], radius: 2 }] } }),
      featureV1({ type: "extrude", feature: "e", feature_id: "f_e" }),
      featureV1({ type: "sketch", feature: "loose", feature_id: "f_loose", sketch: { mode: "explicit", solved: [{ kind: "circle", id: "m2", center: [-10, 0], radius: 2 }] } }),
      featureV1({ type: "hole", feature: "h", feature_id: "f_h", holes: [{ at: "mark.center", center: [10, 0, 5], axis: [0, 0, -1], d: 4, depth: null, kind: "simple" }] }),
      featureV1({ type: "hole", feature: "h2", feature_id: "f_h2", holes: [{ at: "m2.center", center: [-10, 0, 5], axis: [0, 0, -1], d: 4, depth: null, kind: "simple" }] }),
    ]);
    const holes = holesV1({ report: r, doc: marked });
    expect(holes.map((h) => h.id)).toEqual(["h/mark.center", "h2/m2.center"]);
    expect(run(t({ check: "hole_positions", diameter: [3.9, 4.1], points: [[10, 0, 0], [-10, 0, 0]] }), subjectV1(r, marked)).pass).toBe(true);
  });
});

/**
 * Pattern axes placed from provenance keys, pinned against Forge's own geometry: each fixture pair
 * (`fixtures/v1-axes`, recorded with `aicad eval`) builds one pattern about an `{edge}` /
 * `{cylinder}` axis and about the explicit axis it must equal. Forge builds identical bodies for
 * both, so the copies holesV1 places must coincide too, and sit where a hand computation puts them.
 */
describe("pattern axes from keys, against the engine's geometry", () => {
  const AXES_DIR = fileURLToPath(new URL("../fixtures/v1-axes/", import.meta.url));
  const load = (name: string) => {
    const doc = compileV1Ok(readFileSync(`${AXES_DIR}${name}.cad.ts`, "utf8"));
    const report = JSON.parse(readFileSync(`${AXES_DIR}${name}.metrics.json`, "utf8")) as metricsV1.EvalReport;
    // The recorded report is of this source: the same features, in the same order.
    expect(report.features.map((f) => [f.feature_id, f.type]), name).toEqual(doc.parts.flatMap((p) => (p.features as unknown as { id: string; type: string }[]).map((f) => [f.id, f.type])));
    expect(report.status, name).toBe("ok");
    return { report, doc };
  };
  const copies = (name: string) => {
    const s = load(name);
    return holesV1(s)
      .filter((h) => h.id.includes("#"))
      .map((h) => {
        expect(h.unplaced, `${name} ${h.id}`).toBeUndefined();
        return h.center!;
      });
  };
  const sameBodies = (a: string, b: string) => {
    const [x, y] = [load(a).report.parts![0]!.bodies, load(b).report.parts![0]!.bodies];
    expect(x.length).toBe(y.length);
    x.forEach((bx, i) => {
      expect(bx.volume).toBeCloseTo(y[i]!.volume, 9);
      bx.centroid.forEach((c, k) => expect(c).toBeCloseTo(y[i]!.centroid[k]!, 9));
    });
  };
  const close = (got: readonly (readonly number[])[], want: readonly (readonly number[])[]) => {
    expect(got).toHaveLength(want.length);
    got.forEach((g, i) => g.forEach((c, k) => expect(c, `copy ${i} component ${k}`).toBeCloseTo(want[i]![k]!, 9)));
  };

  it("a junction edge next to an arc is the line through the vertex, not the arc's axis", () => {
    // Quarter disc: l1 (0,0)→(40,0), a1 about the origin, l2; the edge at l1's end is keyed
    // f_q/edge:{f_q/side:a1|f_q/side:l1}@a1.start, whose faces name the arc first.
    const key = load("q_edge").report.features.find((f) => f.type === "pattern")!.refs![0]!.members[0]!.key;
    expect(key).toBe("f_q/edge:{f_q/side:a1|f_q/side:l1}@a1.start");
    sameBodies("q_edge", "q_line");
    const c30 = Math.cos(Math.PI / 6);
    const want = [[40 - 10 * c30 - 5, 10 * c30 - 5, 5]]; // (30, 10) turned 30° about (40, 0)
    close(copies("q_edge"), want);
    close(copies("q_line"), want);
  });

  it("a straight cap edge is the line of its two planes (a linear pattern along a slanted side)", () => {
    expect(load("t_edge").report.features.find((f) => f.type === "pattern")!.refs![0]!.members[0]!.key).toBe("f_t/edge:{f_t/cap:end@l1|f_t/side:ls}");
    sameBodies("t_edge", "t_vec");
    const u = [20 / Math.hypot(20, 30), -30 / Math.hypot(20, 30)]; // ls reversed to sign-canonical
    const want = [[30 + 5 * u[0]!, 10 + 5 * u[1]!, 5]];
    close(copies("t_edge"), want);
    close(copies("t_vec"), want);
  });

  it("a revolve's side and junction edge turn about the revolve axis", () => {
    for (const name of ["r_cyl", "r_edge"]) sameBodies(name, "r_z");
    const want = [
      [0, 12, 10],
      [-12, 0, 10],
      [0, -12, 10],
    ];
    for (const name of ["r_cyl", "r_edge", "r_z"]) close(copies(name), want);
  });

  it("refuses what the report cannot place, with the reason", () => {
    const { report, doc } = load("t_edge");
    const r = structuredClone(report);
    // A revolve end-cap edge, a blend face and an edge between a line side and a cylinder of
    // another feature (a line or a circle: the keys cannot tell) are not placed.
    for (const key of ["f_t/blend:{f_t/edge:{f_t/cap:end@l1|f_t/side:ls}}", "f_x/edge:{f_t/side:l1|f_h/wall@a}"]) {
      r.features.find((f) => f.type === "pattern")!.refs![0]!.members[0]!.key = key;
      const c = holesV1({ report: r, doc }).find((h) => h.id.includes("#"))!;
      expect(c.center, key).toBeUndefined();
      expect(c.unplaced, key).toMatch(/cannot be placed from the report/);
    }
  });
});

describe("which circles the hole checks and curve_count see", () => {
  const SRC = `import { doc, part, sketch, extrude, rect, circle, hole, XY } from "@aicad/std";
part("part");
const sk = sketch(XY, { o: rect({ center: [0, 0], w: 60, h: 40 }), bore: circle({ center: [-20, 0], radius: 3 }) });
const e = extrude(sk, { distance: 5 });
const pinSk = sketch(XY, { pin: circle({ center: [0, 0], radius: 2.5 }) });
const pin = extrude(pinSk, { distance: 10, op: "join", targets: e });
const cutSk = sketch(XY, { ring: circle({ center: [20, 0], radius: 6 }), core: circle({ center: [20, 0], radius: 2 }) });
const cut = extrude(cutSk, { distance: 5, regions: ["ring"], op: "cut", targets: e });
const marks = sketch(XY, { m: circle({ center: [0, 12], radius: 1.5 }) });
const h = hole(e.cap("end"), { at: marks.points("m.center"), d: 3, depth: "through" });
`;
  const doc = compileV1Ok(SRC);
  const solved = (id: string, curves: metricsV1.LiteralCurve[], regions: metricsV1.RegionMetrics[]) =>
    featureV1({ type: "sketch", feature: id, feature_id: `f_${id}`, regions, sketch: { mode: "explicit", solved: curves } });
  const rect: metricsV1.LiteralCurve[] = [
    { kind: "line", id: "o.bottom", start: [-30, -20], end: [30, -20] },
    { kind: "line", id: "o.right", start: [30, -20], end: [30, 20] },
    { kind: "line", id: "o.top", start: [30, 20], end: [-30, 20] },
    { kind: "line", id: "o.left", start: [-30, 20], end: [-30, -20] },
  ];
  const report = reportV1([
    solved("sk", [...rect, { kind: "circle", id: "bore", center: [-20, 0], radius: 3 }], [{ area: 1, loops: 2, outer_curves: ["o.bottom", "o.left", "o.right", "o.top"] }]),
    featureV1({ type: "extrude", feature: "e", feature_id: "f_e" }),
    solved("pinSk", [{ kind: "circle", id: "pin", center: [0, 0], radius: 2.5 }], [{ area: 1, loops: 1, outer_curves: ["pin"] }]),
    featureV1({ type: "extrude", feature: "pin", feature_id: "f_pin" }),
    solved("cutSk", [{ kind: "circle", id: "ring", center: [20, 0], radius: 6 }, { kind: "circle", id: "core", center: [20, 0], radius: 2 }], [
      { area: 1, loops: 1, outer_curves: ["core"] },
      { area: 1, loops: 2, outer_curves: ["ring"] },
    ]),
    featureV1({ type: "extrude", feature: "cut", feature_id: "f_cut" }),
    solved("marks", [{ kind: "circle", id: "m", center: [0, 12], radius: 1.5 }], [{ area: 1, loops: 1, outer_curves: ["m"] }]),
    featureV1({ type: "hole", feature: "h", feature_id: "f_h", holes: [{ at: "m.center", center: [0, 12, 5], axis: [0, 0, -1], d: 3, depth: null, kind: "simple" }] }),
  ]);
  const S1 = { report, doc };

  it("holes: a new_body extrude's inner circle, a cut's outer circle and hole instances; never a joined pin or the core a cut leaves", () => {
    expect(holesV1(S1).map((h) => h.id).sort()).toEqual(["cutSk.ring", "h/m.center", "sk.bore"]);
    const pinAsHole = run(t({ check: "hole_positions", diameter: [4.9, 5.1], points: [[0, 0, 0]] }), subjectV1(report, doc));
    expect(pinAsHole.pass).toBe(false);
    expect(pinAsHole.message).toMatch(/found 0 circle/);
    // With circles: "all", the pin (a boss) is a circle that makes geometry.
    expect(run(t({ check: "hole_positions", circles: "all", diameter: [4.9, 5.1], points: [[0, 0, 0]] }), subjectV1(report, doc)).pass).toBe(true);
    expect(circlesV1(S1).map((h) => h.id).sort()).toEqual(["cutSk.core", "cutSk.ring", "h/m.center", "pinSk.pin", "sk.bore"]);
  });

  it("curve_count: swept circles and hole instances once each; a marker circle of an unswept sketch is not a curve", () => {
    const circles = curvesV1(S1).filter((c) => c.kind === "circle").map((c) => c.diameter);
    expect(circles.sort((a, b) => a! - b!)).toEqual([3, 4, 5, 6, 12]); // m (the hole, not its marker), core, pin, bore, ring
    expect(run(t({ check: "curve_count", kind: "circle", diameter: [2.95, 3.05], eq: 1 }), subjectV1(report, doc)).pass).toBe(true);
    expect(curvesV1(S1).filter((c) => c.kind === "line")).toHaveLength(4);
  });

  it("with a region subset, only the holes of the selected regions (the innermost region around each circle)", () => {
    // Two plates side by side, each with a Ø4 hole; the extrude takes the left one only.
    const src = `import { doc, part, sketch, extrude, rect, circle, XY } from "@aicad/std";
part("part");
const sk = sketch(XY, { a: rect({ center: [-30, 0], w: 40, h: 40 }), b: rect({ center: [30, 0], w: 40, h: 40 }), ha: circle({ center: [-30, 0], radius: 2 }), hb: circle({ center: [30, 0], radius: 2 }) });
const e = extrude(sk, { distance: 5, regions: ["a.bottom"] });
`;
    const side = (id: string, cx: number): metricsV1.LiteralCurve[] => [
      { kind: "line", id: `${id}.bottom`, start: [cx - 20, -20], end: [cx + 20, -20] },
      { kind: "line", id: `${id}.right`, start: [cx + 20, -20], end: [cx + 20, 20] },
      { kind: "line", id: `${id}.top`, start: [cx + 20, 20], end: [cx - 20, 20] },
      { kind: "line", id: `${id}.left`, start: [cx - 20, 20], end: [cx - 20, -20] },
    ];
    const outer = (id: string) => [`${id}.bottom`, `${id}.left`, `${id}.right`, `${id}.top`];
    const r = reportV1([
      solved("sk", [...side("a", -30), ...side("b", 30), { kind: "circle", id: "ha", center: [-30, 0], radius: 2 }, { kind: "circle", id: "hb", center: [30, 0], radius: 2 }], [
        { area: 1, loops: 2, outer_curves: outer("a") },
        { area: 1, loops: 2, outer_curves: outer("b") },
      ]),
      featureV1({ type: "extrude", feature: "e", feature_id: "f_e" }),
    ]);
    expect(holesV1({ report: r, doc: compileV1Ok(src) }).map((h) => h.id)).toEqual(["sk.ha"]);
  });

  it("a marker circle drawn in a swept sketch at the hole it marks counts once", () => {
    // The knob case: the Ø6 hole placed from a Ø6 circle of the knob's own (swept) sketch.
    const r = structuredClone(report);
    const sk = r.features.find((f) => f.feature === "sk")!;
    sk.sketch!.solved.push({ kind: "circle", id: "mark6", center: [20, 12], radius: 3 });
    r.features.find((f) => f.feature === "h")!.holes!.push({ at: "mark6.center", center: [20, 12, 5], axis: [0, 0, -1], d: 6, depth: null, kind: "simple" });
    const s = { report: r, doc };
    expect(curvesV1(s).filter((c) => c.kind === "circle" && c.diameter === 6)).toHaveLength(2); // bore and the drilled mark6, once
    expect(holesV1(s).filter((h) => h.diameter === 6).map((h) => h.id)).toEqual(["sk.bore", "h/mark6.center"]);
  });
});

describe("the hole census across bodies and parts", () => {
  type P3 = [number, number, number];
  const box = (feature: string, member: string, min: P3, max: P3, change?: "created" | "modified", instance?: number[]) =>
    bodyV1({ origin: instance ? { feature, member, instance } : { feature, member }, min, max, ...(change ? { change } : {}) });
  const bodyRef = (field: string, keys: string[]): metricsV1.RefReport => ({
    field,
    status: "exact",
    members: keys.map((key) => ({ key, name: key, via: "named", status: "exact", probe: { kind: "body", point: [0, 0, 0] } })),
  });
  const rectSketch = (id: string, name: string, x0: number, y0: number, w: number, h: number, extra: metricsV1.LiteralCurve[] = []) =>
    featureV1({
      type: "sketch",
      feature: name,
      feature_id: id,
      regions: [{ area: w * h, loops: 1, outer_curves: [`${name}.bottom`, `${name}.left`, `${name}.right`, `${name}.top`] }],
      sketch: {
        mode: "explicit",
        solved: [
          { kind: "line", id: `${name}.bottom`, start: [x0, y0], end: [x0 + w, y0] },
          { kind: "line", id: `${name}.right`, start: [x0 + w, y0], end: [x0 + w, y0 + h] },
          { kind: "line", id: `${name}.top`, start: [x0 + w, y0 + h], end: [x0, y0 + h] },
          { kind: "line", id: `${name}.left`, start: [x0, y0 + h], end: [x0, y0] },
          ...extra,
        ],
      },
    });
  const circleSketch = (id: string, name: string, c: string, center: [number, number], r: number) =>
    featureV1({ type: "sketch", feature: name, feature_id: id, regions: [{ area: Math.PI * r * r, loops: 1, outer_curves: [c] }], sketch: { mode: "explicit", solved: [{ kind: "circle", id: c, center, radius: r }] } });

  it("a body-seed mirror copies the hole of the body it copies (the mirrored bracket, as the oracle reported it)", async () => {
    const task = corpusTasksV1().find((x) => x.id === "t1-mirrored-bracket-arms")!;
    const c = loadCandidates(CORPUS_V1_DIR).find((x) => x.task === task.id && x.label === "body-seed-mirror")!;
    const doc = compileV1Ok(c.source);
    const report = await fixtureEngineV1().evaluateV1(doc);
    const holes = holesV1({ report, doc });
    expect(holes.map((h) => h.id)).toEqual(["armHole/h", "armHole/h#otherArm.1"]);
    expect(holes[1]).toMatchObject({ center: [-35, 0, 25], axis: [1, 0, 0], diameter: 4.5 });
    expect(holes[1]!.uncertain).toBeUndefined();
    const hidden = task.hidden_tests.find((x) => x.id === "holes")!;
    expect(run(hidden, subjectV1(report, doc)).pass).toBe(true);
  });

  // Two separate plates: a drilled at (5, 5), b with a cut circle at (25, 5); the pattern copies b only.
  const TWO = compileV1Ok(`import { doc, part, sketch, extrude, rect, circle, hole, linearPattern, XY, X } from "@aicad/std";
part("part");
const skA = sketch(XY, { a: rect({ corner: [0, 0], w: 10, h: 10 }) });
const a = extrude(skA, { distance: 5 });
const skB = sketch(XY, { b: rect({ corner: [20, 0], w: 10, h: 10 }) });
const b = extrude(skB, { distance: 5 });
const h = hole(a.cap("end"), { at: { p: [5, 5] }, d: 3, depth: "through" });
const cutSk = sketch(XY, { c: circle({ center: [25, 5], radius: 2 }) });
const cut = extrude(cutSk, { distance: 5, op: "cut", targets: b });
const copies = linearPattern(b.body(), { dir: X, count: 2, spacing: 50 });
`);
  const A = box("f_a", "a.bottom", [0, 0, 0], [10, 10, 5]);
  const B = box("f_b", "b.bottom", [20, 0, 0], [30, 10, 5]);
  const twoBodies = (seed: string[], hole: Partial<metricsV1.FeatureReport> = {}) =>
    reportV1([
      rectSketch("f_skA", "skA", 0, 0, 10, 10),
      featureV1({ type: "extrude", feature: "a", feature_id: "f_a", bodies: [{ ...A, change: "created" }] }),
      rectSketch("f_skB", "skB", 20, 0, 10, 10),
      featureV1({ type: "extrude", feature: "b", feature_id: "f_b", bodies: [{ ...B, change: "created" }] }),
      featureV1({ type: "hole", feature: "h", feature_id: "f_h", holes: [{ at: "p", center: [5, 5, 5], axis: [0, 0, -1], d: 3, depth: null, kind: "simple" }], bodies: [{ ...A, change: "modified" }], ...hole }),
      circleSketch("f_cutSk", "cutSk", "c", [25, 5], 2),
      featureV1({ type: "extrude", feature: "cut", feature_id: "f_cut", bodies: [{ ...B, change: "modified" }] }),
      featureV1({ type: "pattern", feature: "copies", feature_id: "f_copies", pattern: { instances: 1 }, refs: [bodyRef("/seed/bodies", seed)], bodies: [box("f_copies", "b.bottom", [70, 0, 0], [80, 10, 5], "created", [1])] }),
    ]);

  it("a body-seed pattern copies only the holes of the bodies it seeds", () => {
    const holes = holesV1({ report: twoBodies(["f_b/body:b.bottom"]), doc: TWO });
    expect(holes.map((h) => h.id)).toEqual(["h/p", "cutSk.c", "cutSk.c#copies.1"]);
    expect(holes[2]).toMatchObject({ center: [75, 5, 0], axis: [0, 0, 1], part: "part" });
    const both = holesV1({ report: twoBodies(["f_a/body:a.bottom", "f_b/body:b.bottom"]), doc: TWO });
    expect(both.map((h) => h.id)).toEqual(["h/p", "cutSk.c", "h/p#copies.1", "cutSk.c#copies.1"]);
    expect(both.every((h) => h.uncertain === undefined)).toBe(true);
  });

  it("a copy whose seed may lie on a body the pattern does not copy is uncertain, and every check that meets it says so", () => {
    // The hole feature reports both plates modified and its box test cannot tell them apart:
    // a hole on a or on b, and the pattern copies b only.
    const unsure = twoBodies(["f_b/body:b.bottom"], {
      holes: [{ at: "p", center: [15, 5, 5], axis: [0, 0, -1], d: 3, depth: null, kind: "simple" }],
      bodies: [box("f_a", "a.bottom", [0, 0, 0], [16, 10, 5], "modified"), box("f_b", "b.bottom", [14, 0, 0], [30, 10, 5], "modified")],
    });
    const s = subjectV1(unsure, TWO);
    const copy = holesV1(s.v1!).find((h) => h.id === "h/p#copies.1")!;
    expect(copy.uncertain).toMatch(/pattern copies copies the bodies f_b\/b.bottom, and h\/p may lie on f_a\/a.bottom or f_b\/b.bottom/);
    const count = run(t({ check: "hole_count", eq: 2 }), s);
    expect(count.pass).toBe(false);
    expect(count.message).toMatch(/hole h\/p#copies.1 \(Ø3\) may or may not exist/);
    const pos = run(t({ check: "hole_positions", diameter: [2.9, 3.1], points: [[15, 5, 0]] }), s);
    expect(pos.pass).toBe(false);
    expect(pos.message).toMatch(/may or may not exist/);
    expect(run(t({ check: "curve_count", kind: "circle", diameter: [2.9, 3.1], eq: 1 }), s).message).toMatch(/may or may not exist/);
    // A diameter the uncertain copy does not have is still measured.
    expect(run(t({ check: "hole_positions", diameter: [3.9, 4.1], points: [[25, 5, 0], [75, 5, 0]] }), s).pass).toBe(true);
    // Seeding both plates makes the copy certain.
    const sure = subjectV1({ ...unsure, features: unsure.features.map((f) => (f.feature === "copies" ? { ...f, refs: [bodyRef("/seed/bodies", ["f_a/body:a.bottom", "f_b/body:b.bottom"])] } : f)) }, TWO);
    expect(holesV1(sure.v1!).filter((h) => h.uncertain)).toEqual([]);
    expect(run(t({ check: "hole_count", eq: 2 }), sure).pass).toBe(true);
  });

  it("follows a hole into the body a join merges its body into, and drops it with a body a cut removes", () => {
    const doc = compileV1Ok(`import { doc, part, sketch, extrude, rect, hole, boolean, linearPattern, XY, X } from "@aicad/std";
part("part");
const skA = sketch(XY, { a: rect({ corner: [0, 0], w: 10, h: 10 }) });
const a = extrude(skA, { distance: 5 });
const skB = sketch(XY, { b: rect({ corner: [10, 0], w: 10, h: 10 }) });
const b = extrude(skB, { distance: 5 });
const h = hole(b.cap("end"), { at: { p: [15, 5] }, d: 3, depth: "through" });
const merged = boolean("join", { targets: a, tools: b });
const copies = linearPattern(a.body(), { dir: X, count: 2, spacing: 50 });
`);
    const AB = box("f_a", "a.bottom", [0, 0, 0], [20, 10, 5], "modified");
    const report = (op: "join" | "cut") =>
      reportV1([
        rectSketch("f_skA", "skA", 0, 0, 10, 10),
        featureV1({ type: "extrude", feature: "a", feature_id: "f_a", bodies: [box("f_a", "a.bottom", [0, 0, 0], [10, 10, 5], "created")] }),
        rectSketch("f_skB", "skB", 10, 0, 10, 10),
        featureV1({ type: "extrude", feature: "b", feature_id: "f_b", bodies: [box("f_b", "b.bottom", [10, 0, 0], [20, 10, 5], "created")] }),
        featureV1({ type: "hole", feature: "h", feature_id: "f_h", holes: [{ at: "p", center: [15, 5, 5], axis: [0, 0, -1], d: 3, depth: null, kind: "simple" }], bodies: [box("f_b", "b.bottom", [10, 0, 0], [20, 10, 5], "modified")] }),
        op === "join"
          ? featureV1({ type: "boolean", feature: "merged", feature_id: "f_merged", refs: [bodyRef("/targets", ["f_a/body:a.bottom"]), bodyRef("/tools", ["f_b/body:b.bottom"])], bodies: [AB] })
          : featureV1({ type: "boolean", feature: "merged", feature_id: "f_merged", refs: [bodyRef("/targets", ["f_a/body:a.bottom"])], removed: [{ feature: "f_b", member: "b.bottom" }], bodies: [AB] }),
        featureV1({ type: "pattern", feature: "copies", feature_id: "f_copies", pattern: { instances: 1 }, refs: [bodyRef("/seed/bodies", ["f_a/body:a.bottom"])], bodies: [box("f_copies", "a.bottom", [50, 0, 0], [70, 10, 5], "created", [1])] }),
      ]);
    // The join consumed the tool b (never listed in removed, §6.0.5): its hole is now on a.
    const joined = holesV1({ report: report("join"), doc });
    expect(joined.map((h) => h.id)).toEqual(["h/p", "h/p#copies.1"]);
    expect(joined[1]!.center).toEqual([65, 5, 5]);
    // A body the operation removes without merging it (here: listed in removed by a non-join) takes its holes away from later body seeds.
    const cutDoc = { ...doc, parts: doc.parts.map((p) => ({ ...p, features: p.features.map((f) => (f.id === "f_merged" ? ({ ...f, op: "cut" } as typeof f) : f)) })) };
    expect(holesV1({ report: report("cut"), doc: cutDoc }).map((h) => h.id)).toEqual(["h/p"]);
  });

  it("counts coaxial holes of one diameter in two parts as two, and in one part only where they overlap along the axis", () => {
    const doc = compileV1Ok(`import { doc, part, sketch, extrude, rect, circle, hole, XY } from "@aicad/std";
part("pinA");
const skA = sketch(XY, { a: rect({ center: [0, 0], w: 20, h: 20 }) });
const a = extrude(skA, { distance: 5 });
const p = hole(a.cap("end"), { at: { p: [0, 0] }, d: 5, depth: { blind: 5 } });
part("pinB");
const skB = sketch(XY, { b: rect({ center: [0, 0], w: 20, h: 20 }), c: circle({ center: [0, 0], radius: 2.5 }) });
const b = extrude(skB, { distance: 5 });
`);
    const r = reportV1([
      { ...rectSketch("f_skA", "skA", -10, -10, 20, 20), part: "pinA" },
      featureV1({ part: "pinA", type: "extrude", feature: "a", feature_id: "f_a", bodies: [box("f_a", "a.bottom", [-10, -10, 0], [10, 10, 5], "created")] }),
      featureV1({ part: "pinA", type: "hole", feature: "p", feature_id: "f_p", holes: [{ at: "p", center: [0, 0, 5], axis: [0, 0, -1], d: 5, depth: 5, kind: "simple" }] }),
      { ...rectSketch("f_skB", "skB", -10, -10, 20, 20, [{ kind: "circle", id: "c", center: [0, 0], radius: 2.5 }]), part: "pinB", regions: [{ area: 1, loops: 2, outer_curves: ["skB.bottom", "skB.left", "skB.right", "skB.top"] }] },
      featureV1({ part: "pinB", type: "extrude", feature: "b", feature_id: "f_b" }),
    ]);
    // Both parts put their plate at z 0..5 (parts are separate objects): the circle of part B lies
    // on the axis of part A's hole, inside its depth. Still two holes: the census never merges
    // across parts.
    expect(holesV1({ report: r, doc }).map((h) => `${h.part}:${h.id}`)).toEqual(["pinA:p/p", "pinB:skB.c"]);
    expect(run(t({ check: "hole_positions", diameter: [4.9, 5.1], points: [[0, 0, 0], [0, 0, 0]] }), subjectV1(r, doc)).pass).toBe(true);
    // In one part, a circle is the hole drawn twice only where its sweep overlaps the hole along the axis.
    const one = compileV1Ok(`import { doc, part, sketch, extrude, rect, circle, hole, XY } from "@aicad/std";
part("part");
const sk = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 20 }), c: circle({ center: [0, 0], radius: 2.5 }) });
const e = extrude(sk, { distance: 2 });
const h = hole(e.cap("end"), { at: { p: [0, 0] }, d: 5, depth: { blind: 3 } });
`);
    const rr = (z: number, depth: number | null) =>
      reportV1([
        { ...rectSketch("f_sk", "sk", -10, -10, 20, 20, [{ kind: "circle", id: "c", center: [0, 0], radius: 2.5 }]), regions: [{ area: 1, loops: 2, outer_curves: ["sk.bottom", "sk.left", "sk.right", "sk.top"] }] },
        featureV1({ type: "extrude", feature: "e", feature_id: "f_e", bodies: [box("f_e", "sk.bottom", [-10, -10, 0], [10, 10, 12], "created")] }),
        featureV1({ type: "hole", feature: "h", feature_id: "f_h", holes: [{ at: "p", center: [0, 0, z], axis: [0, 0, -1], d: 5, depth, kind: "simple" }] }),
      ]);
    // A blind Ø5 from z = 12 down to z = 9 and the Ø5 circle swept over z 0..2: two holes.
    expect(holesV1({ report: rr(12, 3), doc: one }).map((h) => h.id)).toEqual(["sk.c", "h/p"]);
    // The same hole drilled 11 deep reaches z = 1, inside the circle's sweep: one hole drawn twice.
    expect(holesV1({ report: rr(12, 11), doc: one }).map((h) => h.id)).toEqual(["h/p"]);
  });
});

describe("blends, shells, parameters, references and warnings", () => {
  it("blend_edges counts edges by type, and by the evaluated radius or distance", () => {
    expect(run(t({ check: "blend_edges", type: "fillet", eq: 4 }), S).pass).toBe(true);
    expect(run(t({ check: "blend_edges", type: "fillet", size: [3.99, 4.01], eq: 4 }), S).pass).toBe(true); // r + 1 with r = 3
    expect(run(t({ check: "blend_edges", type: "fillet", size: [2.99, 3.01], eq: 0 }), S).pass).toBe(true);
    expect(run(t({ check: "blend_edges", type: "chamfer", size: [0.49, 0.51], eq: 2 }), S).pass).toBe(true);
  });

  it("blend_edges fails loudly when the size cannot be evaluated", () => {
    const s = subjectV1({ ...fullReport(), params: [] }, DOC);
    const r = run(t({ check: "blend_edges", type: "fillet", size: [3.99, 4.01], eq: 4 }), s);
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/no evaluated parameter named r/);
  });

  it("shell_thickness is the thinnest successful shell; shell_open_faces sums the opened faces", () => {
    expect(run(t({ check: "shell_thickness", approx: 2, abs: 1e-12 }), S).pass).toBe(true);
    expect(run(t({ check: "shell_open_faces", eq: 1 }), S).pass).toBe(true);
    const noShell = subjectV1(fullReport({ features: [featureV1({ type: "extrude", feature: "e", feature_id: "f_e" })] }), DOC);
    expect(run(t({ check: "shell_thickness", approx: 2, abs: 1 }), noShell)).toMatchObject({ pass: false, message: "no shell feature succeeded" });
  });

  it("param_value and param_count read the report's parameters", () => {
    expect(run(t({ check: "param_value", name: "pitch", eq: 12 }), S).pass).toBe(true);
    expect(run(t({ check: "param_value", name: "nosuch", eq: 12 }), S).message).toMatch(/no parameter named nosuch/);
    expect(run(t({ check: "param_count", type: "mm", eq: 2 }), S).pass).toBe(true);
    expect(run(t({ check: "param_count", type: "count", eq: 0 }), S).pass).toBe(true);
  });

  it("ref_stability counts references not resolved exactly; warning_count counts warnings by code", () => {
    expect(run(t({ check: "ref_stability", eq: 1 }), S).pass).toBe(true);
    expect(run(t({ check: "ref_stability", type: "hole", eq: 0 }), S).pass).toBe(true);
    expect(refChanges(S.v1!, undefined)).toEqual(["bad/layout/circular/axis/cylinder is accepted"]);
    // Always by code: an unfiltered count would include engine-internal notes (ORACLE_REPLAYED).
    expect(run(t({ check: "warning_count", eq: 1 }), S)).toMatchObject({ pass: false, message: 'warning_count needs "code"' });
    expect(run(t({ check: "warning_count", code: "PATTERN_INSTANCE_SKIPPED", eq: 1 }), S).pass).toBe(true);
    expect(run(t({ check: "warning_count", code: "REF_REPAIRED", eq: 0 }), S).pass).toBe(true);
  });

  it("ref_stability on a T4 edit compares each reference with the context model: same feature, same field, same keys", () => {
    const edge = (key: string): metricsV1.RefMember => ({ key, name: key, via: "broad", status: "exact", probe: { kind: "edge", point: [0, 0, 0] } });
    const withFillet = (keys: string[] | null) => {
      const r = fullReport();
      const f = r.features.find((x) => x.feature === "f")!;
      if (keys === null) r.features = r.features.filter((x) => x !== f);
      else f.refs = [{ field: "/edges", status: "exact", members: keys.map(edge) }];
      return subjectV1(r, DOC);
    };
    const context = withFillet(["e/edge:{a|b}", "e/edge:{b|c}", "e/edge:{c|d}", "e/edge:{d|a}"]);
    const stable = t({ check: "ref_stability", type: "fillet", eq: 0 });
    // The same edges (in any order), every reference exact: stable.
    expect(run(stable, withFillet(["e/edge:{d|a}", "e/edge:{c|d}", "e/edge:{b|c}", "e/edge:{a|b}"]), { context }).pass).toBe(true);
    // Four edges again, all exact, but different ones (a fillet re-selected after the edit): unstable.
    const rebound = run(stable, withFillet(["e/edge:{a|b}", "e/edge:{b|c}", "e/floor|a", "e/floor|b"]), { context });
    expect(rebound).toMatchObject({ pass: false, actual: 1 });
    expect(rebound.message).toMatch(/unstable: f\/edges now selects 4 \(was 4: 2 added, 2 removed\)/);
    // The fillet gone, or suppressed: its reference is lost.
    expect(run(stable, withFillet(null), { context }).message).toMatch(/f\/edges is gone \(no such feature\)/);
    // Without a context (not a T4 task) only statuses count: a rebound set is still exact.
    expect(run(stable, withFillet(["e/floor|a"])).pass).toBe(true);
  });

  it("changed_params compares with the context model's parameters", () => {
    const edited = withParams(DOC, { r: 4 }).doc;
    const ctx = { context: S };
    expect(run(t({ check: "changed_params", eq: 1 }), subjectV1(fullReport(), edited), ctx).pass).toBe(true);
    expect(run(t({ check: "changed_params", eq: 0 }), S, ctx).pass).toBe(true);
    expect(run(t({ check: "changed_params", eq: 0 }), S).message).toMatch(/no IR v1 context/);
    expect(run(t({ check: "changed_features", eq: 0 }), subjectV1(fullReport(), edited), ctx).pass).toBe(true);
  });

  it("the v1 checks measure IR v1 models only", () => {
    const v0: Subject = { report: simpleReport([body()]), ir: null };
    for (const check of ["hole_count", "blend_edges", "shell_thickness", "param_value", "ref_stability"] as const) {
      const r = run(t({ check, type: "fillet", name: "x", eq: 0 }), v0);
      expect(r.pass, check).toBe(false);
      expect(r.message).toMatch(/IR v1 models only/);
    }
  });
});

describe("param tests", () => {
  const test = t({ check: "param", set: { r: 5 }, test: { check: "bbox_size", axis: "z", approx: 12, abs: 0.01 } });

  it("measure the nested test on the re-evaluated variant", () => {
    const variant = subjectV1(fullReport({ bodies: [bodyV1({ min: [0, 0, 0], max: [1, 1, 12] })] }), withParams(DOC, { r: 5 }).doc);
    const variants = new Map<string, VariantOutcome>([[variantKey({ r: 5 }), { ok: true, subject: variant }]]);
    const r = run(test, S, { variants });
    expect(r).toMatchObject({ pass: true, actual: 12, expected: "with r = 5: bbox_size ≈ 12 ±0.01" });
    expect(run({ ...test, test: { check: "bbox_size", axis: "z", approx: 10, abs: 0.01 } }, S, { variants })).toMatchObject({ pass: false, actual: 12 });
  });

  it("fail when the variant is missing, could not be evaluated, or has feature errors", () => {
    expect(run(test, S).message).toMatch(/not re-evaluated with r = 5/);
    const missing = new Map<string, VariantOutcome>([[variantKey({ r: 5 }), { ok: false, reason: "the model has no parameter named r" }]]);
    expect(run(test, S, { variants: missing }).message).toBe("the model has no parameter named r");
    const failed = fullReport();
    failed.features[2] = { ...failed.features[2]!, status: "error", error: { code: "FILLET_RADIUS_TOO_LARGE", message: "x" } };
    failed.status = "error";
    const errors = new Map<string, VariantOutcome>([[variantKey({ r: 5 }), { ok: true, subject: subjectV1(failed, DOC) }]]);
    expect(run(test, S, { variants: errors }).message).toMatch(/evaluates with errors: f FILLET_RADIUS_TOO_LARGE/);
  });

  it("variant keys ignore the order of the set", () => {
    expect(variantKey({ a: 1, b: true })).toBe(variantKey({ b: true, a: 1 }));
  });

  it("describe themselves", () => {
    expect(describeTest(test)).toBe("with r = 5: bbox_size ≈ 12 ±0.01");
  });

  it("withParams sets document and part parameters and reports missing names", () => {
    const { doc, missing } = withParams(DOC, { r: 7, nosuch: 1 });
    expect(missing).toEqual(["nosuch"]);
    expect(doc.params!.find((p) => p.name === "r")!.value).toBe(7);
    expect(DOC.params!.find((p) => p.name === "r")!.value).toBe(3);
  });
});
