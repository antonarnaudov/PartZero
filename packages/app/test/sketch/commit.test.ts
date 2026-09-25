/**
 * The ops a finished sketch becomes for the IR v1 store (C1 part 1 shapes, plan §2.2).
 */
import { describe, expect, it } from "vitest";
import type { v1 } from "@aicad/ir-types";
import { sketchFinishToOps, type SketchFinish } from "../../src/sketch/commit";

const feature = { type: "sketch", id: "sketch2", name: "sketch2", plane: "XY", curves: [{ kind: "circle", id: "c1", center: [0, 0], radius: 4 }], constraints: [{ type: "radius", id: "r1", curve: "c1", value: "r" }] } as unknown as v1.SketchFeature;
const base: SketchFinish = {
  mode: "new",
  feature,
  after: "sketch1",
  part: "p",
  params: [{ name: "r", unit: "mm", value: 4 } as v1.Parameter],
  edits: [],
  conversion: null,
  check: { ok: true, regions: 1, warnings: [], validation: [] },
};

describe("sketchFinishToOps", () => {
  it("adds the session's parameters, then the feature after its predecessor in its part", () => {
    expect(sketchFinishToOps(base)).toEqual([
      { op: "addParam", name: "r", unit: "mm", value: 4 },
      { op: "addFeature", part: "p", after: "sketch1", feature },
    ]);
  });

  it("replaces an edited sketch's curves and constraints", () => {
    expect(sketchFinishToOps({ ...base, mode: "edit", params: [] })).toEqual([
      { op: "setField", feature: "sketch2", path: "/curves", value: feature.curves },
      { op: "setField", feature: "sketch2", path: "/constraints", value: feature.constraints },
    ]);
  });
});
