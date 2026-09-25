import { describe, expect, it } from "vitest";
import type { metricsV1 } from "@aicad/ir-types";
import { classifyDifferencesV1, reportDifferencesV1 } from "../src/v1/diff.js";
import { bodyV1, compileV1Ok, featureV1, reportV1 } from "./helpers.js";

const HOLE: metricsV1.HoleReport = { at: "a", center: [0, 0, 10], axis: [0, 0, -1], d: 3.4, depth: null, kind: "counterbore", size: "M3", cbore: { d: 6.5, depth: 3.4 } };

function base(): metricsV1.EvalReport {
  return structuredClone(reportV1(
    [
      featureV1({ type: "extrude", feature: "e", feature_id: "f_e" }),
      featureV1({ type: "fillet", feature: "f", feature_id: "f_f", fillet: { edges: ["k1", "k2"], faces_created: ["b1", "b2"] } }),
      featureV1({ type: "hole", feature: "h", feature_id: "f_h", holes: [HOLE], refs: [{ field: "/on/face", status: "exact", members: [] }] }),
      featureV1({ type: "pattern", feature: "p", feature_id: "f_p", pattern: { instances: 3, skipped: [[2]] } }),
    ],
    { bodies: [bodyV1({ min: [-50, -30, 0], max: [50, 30, 10] })], params: [{ name: "w", scope: "doc", unit: "mm", value: 100 }] },
  ));
}

describe("the MakerBench v1 differential", () => {
  it("finds nothing between a report and itself (numbers within the §8.2 tolerances)", () => {
    const b = base();
    b.parts![0]!.bodies[0]!.volume *= 1 + 1e-9;
    b.features[2]!.holes![0]!.d += 1e-9; // abs ≤ 1e-9·s, s = the part's diagonal (~117)
    expect(reportDifferencesV1(base(), b)).toEqual([]);
  });

  it("catches what the v1 checks read: extra features, warnings, hole presets and sides, patterns, blends, parameters, bodies", () => {
    const b = base();
    b.features.push(featureV1({ type: "chamfer", feature: "extra", feature_id: "f_x" }));
    b.features[1] = { ...b.features[1]!, fillet: { edges: ["k1", "k3"], faces_created: ["b1", "b2", "b3"] }, warnings: [{ code: "REF_SET_CHANGED", severity: "warning", message: "x" }] };
    b.features[2] = { ...b.features[2]!, holes: [{ ...HOLE, cbore: { d: 6.5, depth: 3.0 }, center: [0, 0, 0], axis: [0, 0, 1] }] };
    b.features[3] = { ...b.features[3]!, pattern: { instances: 3 } };
    b.params = [{ name: "w", scope: "doc", unit: "mm", value: 101 }];
    b.parts![0]!.bodies[0]!.face_types = { plane: 5, cylinder: 1 };
    const d = reportDifferencesV1(base(), b).join("\n");
    expect(d).toMatch(/features: 4 vs 5/);
    expect(d).toMatch(/feature 1 f: warnings: \[\] vs \["REF_SET_CHANGED"\]/);
    expect(d).toMatch(/feature 1 f: fillet edges: \["k1","k2"\] vs \["k1","k3"\]/);
    expect(d).toMatch(/feature 1 f: fillet faces created: 2 vs 3/);
    expect(d).toMatch(/hole a: cbore depth: 3.4 vs 3/);
    expect(d).toMatch(/hole a: centre: \[0,0,10\] vs \[0,0,0\]/);
    expect(d).toMatch(/hole a: axis: \[0,0,-1\] vs \[0,0,1\]/);
    expect(d).toMatch(/feature 3 p: pattern: \[3,\[\[2\]\]\] vs \[3,\[\]\]/);
    expect(d).toMatch(/parameter doc\/w: 100 vs 101/);
    expect(d).toMatch(/part part body f1\/outline.bottom: face types/);
  });

  it("compares what §8.2 makes exact: body origins, removed bodies, blend edge keys; hole d and depth to 1e-9·s", () => {
    const b = base();
    b.parts![0]!.bodies[0]!.origin = { feature: "f1", member: "outline.left" };
    b.features[0] = { ...b.features[0]!, removed: [{ feature: "f0", member: "o.bottom" }] };
    b.features[1] = { ...b.features[1]!, fillet: { edges: ["k2", "k9"], faces_created: ["b1", "b2"] } };
    b.features[2]!.holes![0]!.d += 1e-6;
    const d = reportDifferencesV1(base(), b).join("\n");
    expect(d).toMatch(/part part body 0: origin f1\/outline.bottom has no match in the second report/);
    expect(d).toMatch(/part part: body with origin f1\/outline.left has no match in the first report/);
    expect(d).toMatch(/feature 0 e: removed: \[\] vs \["f0\/o.bottom"\]/);
    expect(d).toMatch(/feature 1 f: fillet edges: \["k1","k2"\] vs \["k2","k9"\]/);
    expect(d).toMatch(/hole a: d: 3.4 vs 3.40000\d+ \(allowed ±1.1[0-9]e-7\)/);
  });

  it("matches bodies by origin, then by nearest centroid, whatever order the engines list them in", () => {
    const piece = (x: number, member = "o.bottom") => bodyV1({ origin: { feature: "f_e", member }, min: [x, 0, 0], max: [x + 10, 10, 10] });
    const a = base();
    const b = base();
    a.parts![0]!.bodies = [piece(0), piece(20), piece(40, "c")];
    b.parts![0]!.bodies = [piece(40, "c"), piece(20), piece(0)];
    expect(reportDifferencesV1(a, b)).toEqual([]);
    b.parts![0]!.bodies = [piece(40, "c"), piece(20), piece(1)];
    expect(reportDifferencesV1(a, b).join("\n")).toMatch(/part part body f_e\/o.bottom: volume|part part body f_e\/o.bottom: centroid/);
  });

  it("matches concentric pieces of one origin (the same centroid up to rounding) by volume", () => {
    // The spoked wheel's lighten cut leaves a rim and a hub of one origin, both centred on the
    // axis: the engines list them in either order and their centroids differ only by rounding.
    const ring = (volume: number, c: [number, number, number], half: number) =>
      bodyV1({ origin: { feature: "f_wheel", member: "tire" }, volume, centroid: c, min: [-half, -half, 0], max: [half, half, 10] });
    const a = base();
    const b = base();
    a.parts![0]!.bodies = [ring(23122.12, [1e-14, -1.1e-14, 5], 50), ring(6157.52, [-3.5e-15, 4e-16, 5], 14)];
    b.parts![0]!.bodies = [ring(6157.52, [1.3e-15, -3.6e-16, 5], 14), ring(23122.12, [2.2e-14, 1.4e-14, 5], 50)];
    expect(reportDifferencesV1(a, b)).toEqual([]);
    // A real difference between the pieces still shows.
    b.parts![0]!.bodies[0]!.volume = 6100;
    expect(reportDifferencesV1(a, b).join("\n")).toMatch(/volume: 6157.52 vs 6100/);
  });

  it("compares a rejected document's error code (two rejections for different reasons differ)", () => {
    const rejected = (code: string): metricsV1.EvalReport => ({ ...reportV1([], { status: "error" }), parts: [], error: { code, message: code } });
    expect(classifyDifferencesV1(rejected("SCHEMA_INVALID"), rejected("SCHEMA_INVALID"))).toEqual({ differences: [], openContract: [] });
    expect(classifyDifferencesV1(rejected("SCHEMA_INVALID"), rejected("UNRESOLVED_FEATURE")).differences).toEqual(['document error: "SCHEMA_INVALID" vs "UNRESOLVED_FEATURE"']);
    // A rejection against an evaluated document: the status and the code both differ.
    expect(reportDifferencesV1(base(), rejected("SCHEMA_INVALID")).join("\n")).toMatch(/document error: null vs "SCHEMA_INVALID"/);
  });

  it("does not compare chain_added (§8.2: independent-refs mode only)", () => {
    const b = base();
    b.features[1] = { ...b.features[1]!, fillet: { edges: ["k1", "k2"], chain_added: ["k2"], faces_created: ["b1", "b2"] } };
    expect(reportDifferencesV1(base(), b)).toEqual([]);
  });

  it("leaves out an engine's info about itself (ORACLE_REPLAYED), not its internal warnings", () => {
    const b = base();
    b.features[0] = { ...b.features[0]!, warnings: [{ code: "ORACLE_REPLAYED", severity: "info", message: "replayed" }] };
    expect(reportDifferencesV1(base(), b)).toEqual([]);
    b.features[0] = { ...b.features[0]!, warnings: [{ code: "ORACLE_REF_DIFFERS", severity: "warning", message: "x" }] };
    expect(reportDifferencesV1(base(), b)).toEqual(['feature 0 e: warnings: [] vs ["ORACLE_REF_DIFFERS"]']);
  });

  it("sets the open break-through question of up_to holes apart, and only for up_to holes", () => {
    const doc = compileV1Ok(`import { doc, part, sketch, extrude, rect, hole, XY } from "@aicad/std";
part("part");
const sk = sketch(XY, { o: rect({ center: [0, 0], w: 40, h: 40 }) });
const e = extrude(sk, { distance: 10 });
const up = hole(e.cap("start"), { at: { a: [0, 0] }, d: 3, depth: { upTo: e.cap("end") } });
const blind = hole(e.cap("end"), { at: { b: [10, 0] }, d: 3, depth: { blind: 12 } });
`);
    const report = (warn: boolean) =>
      reportV1([
        featureV1({ type: "sketch", feature: "sk", feature_id: "f_sk" }),
        featureV1({ type: "extrude", feature: "e", feature_id: "f_e" }),
        featureV1({ type: "hole", feature: "up", feature_id: "f_up", warnings: warn ? [{ code: "HOLE_BREAKS_THROUGH", severity: "warning", message: "x" }] : [] }),
        featureV1({ type: "hole", feature: "blind", feature_id: "f_blind", warnings: warn ? [{ code: "HOLE_BREAKS_THROUGH", severity: "warning", message: "x" }] : [] }),
      ]);
    const c = classifyDifferencesV1(report(true), report(false), { doc });
    expect(c.openContract).toEqual(["feature 2 up: CODE_MISMATCH pending a contract ruling: HOLE_BREAKS_THROUGH on an up_to hole (SPEC §6.5 silent; oracle warns, Forge does not)"]);
    expect(c.differences).toEqual(['feature 3 blind: warnings: ["HOLE_BREAKS_THROUGH"] vs []']);
    // Without the document nothing is set apart.
    expect(classifyDifferencesV1(report(true), report(false)).openContract).toEqual([]);
  });
});
