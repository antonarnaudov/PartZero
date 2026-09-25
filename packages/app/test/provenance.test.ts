import { describe, expect, it } from "vitest";
import type { EvalReport } from "@aicad/ir-types";
import { compileAndCheck } from "../src/cadscript/inline-service";
import { collectProblems } from "../src/doc/problems";
import {
  facesOfFeature,
  featureAtPosition,
  featureNameOfBody,
  featureNameOfEdge,
  featureNameOfFace,
  featureNameOfPick,
  findFeature,
} from "../src/doc/provenance";
import { buildTimeline } from "../src/doc/timeline";
import { parseObj } from "../src/engine/obj";
import { basis, cameraFrame, defaultCamera, viewAngles } from "../src/viewport/view-camera";
import nemaObj from "./fixtures/nema17-plate.obj?raw";
import twoObj from "./fixtures/two-regions.obj?raw";
import { BOX } from "./helpers";

describe("provenance names → features", () => {
  it("takes the feature from the part of a face name before the slash", () => {
    expect(featureNameOfFace("plate/cap:end")).toBe("plate");
    expect(featureNameOfFace("plate/side:bottom")).toBe("plate");
    expect(featureNameOfFace("pucks/side:ring_inner")).toBe("pucks");
    expect(featureNameOfFace("bare")).toBe("bare");
  });

  it("handles edge names (mesh-derived face pairs) and body names (`part/feature#n`)", () => {
    expect(featureNameOfEdge("plate/edge:{plate/cap:end|plate/side:pilot}")).toBe("plate");
    expect(featureNameOfEdge("boss/edge:ring")).toBe("boss");
    expect(featureNameOfBody("plate/plate")).toBe("plate");
    expect(featureNameOfBody("part/pucks#1")).toBe("pucks");
    expect(featureNameOfBody("part/my#name")).toBe("my#name");
  });

  it("prefers face, then edge, then body for picks", () => {
    expect(featureNameOfPick({ body: "part/a#0", face: "b/cap:end" })).toBe("b");
    expect(featureNameOfPick({ body: "part/a#0", edge: "c/edge:{c/cap:end|c/side:x}" })).toBe("c");
    expect(featureNameOfPick({ body: "part/a#0" })).toBe("a");
  });

  it("finds features by id first, then by name", () => {
    const ir = compileAndCheck(BOX).ir!;
    const byName = findFeature(ir, "plate")!;
    expect(byName.feature.type).toBe("extrude");
    expect(findFeature(ir, byName.feature.id)?.feature.name).toBe("plate");
    expect(findFeature(ir, "missing")).toBeNull();
    expect(findFeature(null, "plate")).toBeNull();
  });

  it("collects every face a feature generated, across bodies", () => {
    const plate = parseObj(nemaObj);
    expect(facesOfFeature(plate, "plate")).toHaveLength(11);
    expect(facesOfFeature(plate, "outline")).toHaveLength(0);
    const pucks = parseObj(twoObj);
    const faces = facesOfFeature(pucks, "pucks");
    expect(faces.filter((f) => f.body === "part/pucks#0")).toHaveLength(3);
    expect(faces.filter((f) => f.body === "part/pucks#1")).toHaveLength(4);
  });

  it("maps a cursor position to the feature statement containing it", () => {
    const out = compileAndCheck(BOX);
    const lines = BOX.split("\n");
    const outlineLine = lines.findIndex((l) => l.startsWith("const outline")) + 1;
    const plateLine = lines.findIndex((l) => l.startsWith("const plate")) + 1;
    const ids = out.ir!.parts[0]!.features.map((f) => f.id);
    expect(featureAtPosition(out.spans, { line: outlineLine + 2, col: 5 })).toBe(ids[0]);
    expect(featureAtPosition(out.spans, { line: plateLine, col: 10 })).toBe(ids[1]);
    expect(featureAtPosition(out.spans, { line: 1, col: 1 })).toBeNull();
  });
});

describe("timeline", () => {
  it("builds parts → features with status from the report and issues from problems", () => {
    const out = compileAndCheck(BOX);
    const report: EvalReport = {
      schema: "aicad.metrics/0",
      engine: "forge",
      document: "box",
      status: "error",
      features: [
        { part: "plate", feature: "outline", type: "sketch", status: "ok", regions: [{ area: 2500, loops: 1, outer_curves: ["bottom", "left", "right", "top"] }] },
        { part: "plate", feature: "plate", type: "extrude", status: "error", error: { code: "INVALID_RESULT", message: "bad" } },
      ],
    };
    const problems = collectProblems({ compile: out, model: out, report, engineError: null });
    const t = buildTimeline({ compile: out, model: out, report }, problems);
    expect(t.stale).toBe(false);
    expect(t.parts).toHaveLength(1);
    const [outline, plate] = t.parts[0]!.features;
    expect(outline).toMatchObject({ name: "outline", type: "sketch", status: "ok", summary: "XY · 4 curves · 1 region" });
    expect(plate).toMatchObject({ name: "plate", type: "extrude", status: "error" });
    expect(plate!.issues.map((i) => i.code)).toEqual(["INVALID_RESULT"]);
    expect(plate!.issues[0]!.hint).toBeTruthy();
  });

  it("shows suppressed features and marks the timeline stale while the code has errors", () => {
    const suppressed = compileAndCheck(BOX.replace("{ distance: 5 }", "{ distance: 5, suppressed: true }"));
    const broken = compileAndCheck(`${BOX}const x = extrude(nope, { distance: 1 });\n`);
    const t = buildTimeline({ compile: broken, model: suppressed, report: null }, []);
    expect(t.stale).toBe(true);
    expect(t.parts[0]!.features.map((f) => f.status)).toEqual(["pending", "suppressed"]);
    expect(t.parts[0]!.features[1]!.suppressed).toBe(true);
  });
});

describe("viewport camera", () => {
  it("standard views look where CAD users expect (Z up)", () => {
    const at = (v: Parameters<typeof viewAngles>[0]) => {
      const [yaw, pitch] = viewAngles(v);
      return cameraFrame({ ...defaultCamera(), yaw, pitch }, 800, 600);
    };
    const top = at("top");
    expect(top.forward[2]).toBeCloseTo(-1, 6);
    expect(top.basis.right).toEqual([expect.closeTo(1, 6), expect.closeTo(0, 6), 0]);
    const front = at("front");
    expect(front.forward).toEqual([expect.closeTo(0, 6), expect.closeTo(1, 6), expect.closeTo(0, 6)]);
    expect(front.basis.up[2]).toBeCloseTo(1, 6);
    expect(at("right").forward[0]).toBeCloseTo(-1, 6);
    const iso = at("iso");
    expect(iso.eye[0]).toBeGreaterThan(0);
    expect(iso.eye[1]).toBeLessThan(0);
    expect(iso.eye[2]).toBeGreaterThan(0);
    expect(basis(defaultCamera()).back[2]).toBeGreaterThan(0);
  });
});

describe("placeholder rasterizer", () => {
  it("keeps the nearest surface per pixel regardless of draw order", async () => {
    const { rasterTriangle } = await import("../src/viewport/placeholder");
    const w = 20, h = 20;
    const depth = new Float32Array(w * h).fill(-Infinity);
    const ids = new Int32Array(w * h).fill(-1);
    // Near triangle first (key = 1/z: larger is nearer), then a far one covering it: near must win.
    rasterTriangle(depth, ids, w, h, 0, 0, 1 / 10, 20, 0, 1 / 10, 0, 20, 1 / 10, 1);
    rasterTriangle(depth, ids, w, h, 0, 0, 1 / 50, 40, 0, 1 / 50, 0, 40, 1 / 50, 2);
    expect(ids[2 * w + 2]).toBe(1);
    // Outside the near triangle, the far one shows (winding does not matter).
    expect(ids[18 * w + 18]).toBe(2);
    rasterTriangle(depth, ids, w, h, 19, 19, 1, 19, 0, 1, 0, 19, 1, 3);
    expect(ids[18 * w + 18]).toBe(3);
  });
});

describe("forge-web contract adaptation", () => {
  it("normalizes forge-web picks to names only", async () => {
    const { normalizePick, isForgeWebModule } = await import("../src/engine/forge-web-contract");
    const raw = { kind: "face", body: "plate/plate", bodyIndex: 0, face: "plate/cap:end", faceIndex: 1, edge: null, edgeIndex: null, point: [0, 0, 5], pixel: [10, 10] };
    expect(normalizePick(raw)).toEqual({ body: "plate/plate", face: "plate/cap:end" });
    expect(normalizePick({ body: "b", face: null, edge: "p/edge:{a|b}" })).toEqual({ body: "b", edge: "p/edge:{a|b}" });
    expect(normalizePick(null)).toBeNull();
    class Viewport {
      static create(): Promise<unknown> {
        return Promise.resolve({});
      }
    }
    const mod = { init: () => Promise.resolve(), evaluate: () => ({}), exportMesh: () => new Uint8Array(), Viewport };
    expect(isForgeWebModule(mod)).toBe(true);
    expect(isForgeWebModule({ init: () => undefined })).toBe(false);
  });
});
