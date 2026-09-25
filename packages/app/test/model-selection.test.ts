/**
 * The tools' ports on the viewport: the selection the tools see (viewport multi-selection mapped to
 * tool items with their part and label, plus timeline features), and the viewport picking for an
 * active selection input (kind filter, toggle/replace clicks, what the input holds shown selected,
 * the filter restored after, OK clearing the picks).
 */
import { describe, expect, it } from "vitest";
import { createShellCommandRegistry } from "../src/tools/commands";
import { bindToolPicking, modelSelectionPort, toToolItem, toViewItem, viewKindsFor } from "../src/tools/model-selection";
import type { PanelSpec } from "../src/tools/framework/types";
import { ToolRegistry } from "../src/tools/registry";
import { attachShell, Shell } from "../src/tools/shell";
import { viewportRuntime } from "../src/viewport/runtime";
import { makeHarness } from "./helpers";

const DOC = JSON.stringify({
  schema: "aicad.ir/1",
  meta: { name: "plate" },
  params: [],
  parts: [
    {
      id: "p1",
      name: "part",
      features: [
        { type: "sketch", id: "s1", name: "outline", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: 40, h: 20 }] },
        { type: "extrude", id: "e1", name: "slab", sketch: "s1", distance: 5 },
      ],
    },
  ],
});

async function setup() {
  const h = await makeHarness();
  h.services.doc.load({ path: null, name: "plate", format: "ir-v1", source: DOC });
  await h.services.doc.idle();
  const shell = new Shell({ services: h.services, commands: h.commands, shellCommands: createShellCommandRegistry(() => h.services), tools: new ToolRegistry({ flags: () => true }) });
  attachShell(h.services, shell);
  shell.bindPorts({ selection: modelSelectionPort(h.services) });
  const off = bindToolPicking(shell, h.services);
  return { ...h, shell, rt: viewportRuntime(h.services), off };
}

const EDGE = { kind: "edge" as const, body: "part/slab", key: "e1/edge:{e1/cap:end|e1/side:r.top}", point: [0, 10, 5] as [number, number, number] };

const PANEL: PanelSpec = {
  title: "Pick",
  fields: [
    { key: "edges", label: "Edges", kind: "selection", accepts: ["edge", "face"], min: 1 },
    { key: "axis", label: "Axis", kind: "selection", accepts: ["origin", "edge"], min: 1, max: 1, fromSelection: false },
  ],
  initial: { axis: [{ kind: "origin", feature: "Z", label: "Z axis" }] },
  toOps: () => [],
};

describe("the tools' selection port", () => {
  it("maps viewport items to tool items with their part and label, and back", async () => {
    const h = await setup();
    const t = toToolItem(h.services, EDGE);
    expect(t).toMatchObject({ kind: "edge", part: "p1", key: EDGE.key, body: "part/slab", point: EDGE.point });
    expect((t as { label: string }).label).toMatch(/^Edge: /);
    expect(toViewItem(h.services, t)).toEqual(EDGE);
    expect(toToolItem(h.services, { kind: "origin", id: "XY" })).toMatchObject({ kind: "origin", feature: "XY" });
    expect(toToolItem(h.services, { kind: "sketch", feature: "outline" })).toMatchObject({ kind: "feature", feature: "s1", label: "outline" });
    expect(toViewItem(h.services, { kind: "edge", part: "p1", key: "k", refMember: true })).toBeNull();
    expect(viewKindsFor(["feature", "face"]).sort()).toEqual(["face", "sketch"]);
    h.off();
  });

  it("lists the viewport's items, then the timeline's feature", async () => {
    const h = await setup();
    const port = modelSelectionPort(h.services);
    let calls = 0;
    const off = port.subscribe(() => calls++);
    h.rt.selection.set([EDGE]);
    expect(port.items()).toHaveLength(1);
    h.services.doc.select({ featureId: "e1", entity: null, origin: "timeline" });
    expect(port.items().map((i) => i.kind)).toContain("feature");
    expect(calls).toBeGreaterThan(0);
    off();
    h.off();
  });
});

describe("picking for a selection input", () => {
  it("filters to the input's kinds, toggles (or replaces for one item), shows what the input holds, and restores the filter", async () => {
    const h = await setup();
    const before = { ...h.rt.selection.getState().filter };
    h.rt.selection.set([EDGE]);
    const p = h.shell.openPanel(PANEL, null);
    expect(h.rt.pickForTool).toBe("toggle");
    expect(h.rt.selection.getState().filter).toMatchObject({ edge: true, face: true, vertex: false, body: false, origin: false });
    expect(p.values()["edges"]).toHaveLength(1);
    // The axis input: one item; the viewport shows the Z axis it holds and clicks replace it.
    p.activateSelectionField("axis");
    expect(h.rt.pickForTool).toBe("replace");
    expect(h.rt.selection.getState().items).toEqual([{ kind: "origin", id: "Z" }]);
    expect(p.values()["axis"]).toEqual([{ kind: "origin", feature: "Z", label: "Z axis" }]);
    h.rt.selectItems([{ kind: "origin", id: "X" }]);
    expect((p.values()["axis"] as unknown as Array<{ feature: string }>)[0]!.feature).toBe("X");
    p.cancel();
    expect(h.rt.pickForTool).toBe(false);
    expect(h.rt.selection.getState().filter).toEqual(before);
    h.off();
  });

  it("OK clears the picks; a timeline click adds a feature while an input takes features", async () => {
    const h = await setup();
    const spec: PanelSpec = { title: "Seeds", fields: [{ key: "seeds", label: "Seeds", kind: "selection", accepts: ["feature"], min: 1 }], toOps: () => [] };
    const p = h.shell.openPanel(spec, null);
    h.services.doc.select({ featureId: "e1", entity: null, origin: "timeline" });
    expect(p.values()["seeds"]).toEqual([{ kind: "feature", feature: "e1", label: "slab" }]);
    h.rt.selection.set([EDGE]);
    await p.commit("ui");
    expect(h.rt.selection.getState().items).toEqual([]);
    expect(h.rt.pickForTool).toBe(false);
    h.off();
  });
});
