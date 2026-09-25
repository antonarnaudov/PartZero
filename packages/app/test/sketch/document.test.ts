/**
 * A new sketch sees the document: its parameters in dimensions, and a free id and name.
 */
import { describe, expect, it } from "vitest";
import type { v1 } from "@aicad/ir-types";
import { MemorySink } from "../../src/sketch/commit";
import { EMPTY_CONTEXT } from "../../src/sketch/context";
import { SketchMode } from "../../src/sketch/controller";
import { namedFrame } from "../../src/sketch/frames";
import { newSketchOptions, type SketchDocContext } from "../../src/sketch/integration";
import { namesIn, nextSketchName } from "../../src/sketch/names";
import { PlaneView } from "../../src/sketch/view";
import type { P2 } from "../../src/sketch/geom";
import { engines } from "./harness";

const DOC = {
  schema: "aicad.ir/1",
  params: [{ name: "width", unit: "mm", value: 12 }],
  parts: [
    {
      id: "p",
      name: "plate",
      params: [{ name: "sketch2", unit: "mm", value: 1 }],
      features: [{ type: "sketch", id: "sketch1", name: "base", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 5 }] }],
    },
  ],
} as unknown as v1.IrDocument;

const XY = { ref: "XY" as const, frame: namedFrame("XY"), label: "XY" };

async function newSketch(doc: SketchDocContext | null): Promise<{ mode: SketchMode; sink: MemorySink; click: (p: P2) => void }> {
  const sink = new MemorySink();
  const mode = new SketchMode(engines, sink);
  mode.setViewport(1000, 800);
  expect(await mode.begin(newSketchOptions(XY, EMPTY_CONTEXT, doc))).toBe(true);
  const click = (p: P2): void => {
    const px = new PlaneView(mode.getState().view).toScreen(p);
    const e = { px, button: 0, shift: false, alt: true, ctrl: false, meta: false, clicks: 1 };
    mode.pointerMove(e);
    mode.pointerDown(e);
    mode.pointerUp(e);
  };
  return { mode, sink, click };
}

describe("new sketches and the document", () => {
  it("lists every id and name the document uses", () => {
    expect(namesIn(DOC).sort()).toEqual(["base", "p", "plate", "sketch1", "sketch2", "width"]);
    expect(namesIn(null)).toEqual([]);
    expect(nextSketchName([])).toBe("sketch1");
    expect(nextSketchName(["sketch1", "sketch3"])).toBe("sketch2");
  });

  it("gives a new sketch the first free id and name, against the document and the taken names", async () => {
    const a = await newSketch({ document: DOC, part: "p", after: "sketch1", taken: [] });
    expect(a.mode.getState().sketchId).toBe("sketch3");
    expect(a.mode.getState().sketchName).toBe("sketch3");
    const b = await newSketch({ document: null, part: null, after: null, taken: ["sketch1", "f_sketch1", "sketch2"] });
    expect(b.mode.getState().sketchId).toBe("sketch3");
    const c = await newSketch(null);
    expect(c.mode.getState().sketchId).toBe("sketch1");

    // Finishing carries the id, name, part and insertion point.
    a.mode.setTool("circleCenter");
    a.click([0, 0]);
    a.click([4, 0]);
    const f = await a.mode.finish();
    expect(f).not.toBeNull();
    expect(f!.feature.id).toBe("sketch3");
    expect(f!.feature.name).toBe("sketch3");
    expect(f!.part).toBe("p");
    expect(f!.after).toBe("sketch1");
  });

  it("lets a new sketch's dimensions use the document's parameters, and refuses to redefine them", async () => {
    const { mode, click } = await newSketch({ document: DOC, part: "p", after: null, taken: [] });
    mode.setTool("line");
    click([0, 0]);
    click([10, 3]);
    mode.key({ key: "Escape", mod: false, shift: false, alt: false, editable: false });
    mode.setTool("dimension");
    click([5, 1.5]);
    click([5, -5]);
    mode.setDimText("width");
    expect(mode.commitDimension()).toBe(true);
    const dim = mode.getState().snapshot!.constraints.find((c) => c.type === "distance")!;
    expect(dim.expr).toBe("width");
    expect(dim.measured).toBeCloseTo(12, 9);

    // `width = 20` would define a second `width`; `base = 5` would clash with a feature name.
    for (const text of ["width = 20", "base = 5", "sketch2 = 5"]) {
      mode.editDimension(dim.id);
      mode.setDimText(text);
      expect(mode.commitDimension(), text).toBe(false);
      expect(mode.getState().dimEdit?.error, text).toMatch(/exists|feature has this name/);
      mode.cancelDimension();
    }
    const f = await mode.finish({ force: true });
    expect(f!.params).toEqual([]);
    expect(f!.feature.constraints!.some((c) => c.type === "distance" && c.value === "width")).toBe(true);
  });
});
