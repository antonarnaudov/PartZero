/**
 * The create and construct tools (`src/tools/create`) on the real Forge engine: each panel prefills
 * from the selection, previews live (the changed bodies tinted, manipulator handles placed from the
 * previewed geometry), maps engine errors onto the field they belong to, commits ONE transaction,
 * re-edits an existing feature from the timeline — and commits exactly what the tool's command
 * (`model.*`) and the agent's tool commit for the same arguments (the same-command rule).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { InlineCadScriptService } from "../src/cadscript/inline-service";
import { DocStore } from "../src/doc/doc-store";
import { forgeWebCommandEngine, type ForgeWebCommandModule, type IrCommandEngine } from "../src/doc/v1/command-engine";
import { IrDocStore } from "../src/doc/v1/ir-doc-store";
import { EngineManager } from "../src/engine/engine-manager";
import type { EvalResult, ForgeEngine, MeshFormat } from "../src/engine/types";
import { CREATE_TOOLS } from "../src/tools/create";
import { PREVIEW_TINT } from "../src/tools/create/kit";
import { staticSelectionPort } from "../src/tools/framework/ports";
import type { PanelSession } from "../src/tools/framework/session";
import type { HandlesPort, PanelHandle, SelectionItem } from "../src/tools/framework/types";
import { ToolRegistry } from "../src/tools/registry";
import { Shell } from "../src/tools/shell";
import { registerFeatureTools } from "../src/tools/builtin/features";
import { makeHarness, type Harness } from "./helpers";

const nodeFs = "node:fs";
const fs = (await import(/* @vite-ignore */ nodeFs)) as { existsSync(p: URL): boolean; readFileSync(p: URL): Uint8Array };
const wasmUrl = new URL("../../forge-web/pkg/forge_wasm_bg.wasm", import.meta.url);
const hasWasm = fs.existsSync(wasmUrl);
const it_ = hasWasm ? it : it.skip;

type Mod = ForgeWebCommandModule & {
  init(input: unknown): Promise<void>;
  evaluate(ir: string, options?: object): { report: unknown; bodies: EvalResult["bodies"] };
  exportMesh(ir: string, format: MeshFormat, options?: object): Uint8Array;
};

let mod: Mod;
let engine: IrCommandEngine;
beforeAll(async () => {
  if (!hasWasm) return;
  const entry = new URL("../../forge-web/src/engine.ts", import.meta.url).pathname;
  mod = (await import(/* @vite-ignore */ entry)) as Mod;
  await mod.init(fs.readFileSync(wasmUrl));
  engine = forgeWebCommandEngine(mod);
}, 60_000);

class NodeForgeEngine implements ForgeEngine {
  readonly id = "forge-web" as const;
  readonly label = "forge-web (node)";
  readonly detail = "test";
  get commands(): IrCommandEngine {
    return engine;
  }
  evaluate(irJson: string): Promise<EvalResult> {
    const r = mod.evaluate(irJson) as unknown as { report: unknown; bodies: EvalResult["bodies"] };
    return Promise.resolve({ report: r.report as EvalResult["report"], bodies: r.bodies });
  }
  exportMesh(irJson: string, format: MeshFormat): Promise<Uint8Array> {
    return Promise.resolve(mod.exportMesh(irJson, format, {}));
  }
  dispose(): void {}
}

/** A plate (`t` = 5; s1 40 × 20 on XY; e1 by t) and a boss sketch on its top face. */
const PLATE = JSON.stringify({
  schema: "aicad.ir/1",
  meta: { name: "plate" },
  params: [{ name: "t", unit: "mm", value: 5, min: 1 }],
  parts: [
    {
      id: "p1",
      name: "part",
      features: [
        { type: "sketch", id: "s1", name: "outline", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: 40, h: 20 }] },
        { type: "extrude", id: "e1", name: "slab", sketch: "s1", distance: "t" },
        { type: "sketch", id: "s2", name: "bossSk", plane: { face: { kind: "face", q: { op: "cap", feature: "e1", end: "end" } } }, curves: [{ kind: "circle", id: "c", center: [8, 0], radius: 3 }] },
        {
          type: "sketch",
          id: "s3",
          name: "ringSk",
          plane: "XZ",
          curves: [
            { kind: "rect", id: "p", corner: [30, 0], w: 4, h: 6 },
            { kind: "line", id: "ax", start: [0, 0], end: [0, 10], construction: true },
          ],
        },
      ],
    },
  ],
});

interface H extends Harness {
  ir: IrDocStore;
  doc: DocStore;
  shell: Shell;
  selection: ReturnType<typeof staticSelectionPort>;
  shown: PanelHandle[][];
}

async function harness(document = PLATE): Promise<H> {
  const h = await makeHarness();
  const ir = new IrDocStore({ engine: () => engine });
  const nodeEngine = new NodeForgeEngine();
  const engines = new EngineManager({ "forge-web": () => Promise.resolve(nodeEngine) });
  await engines.select("auto");
  h.services.engines = engines;
  const doc = new DocStore({ cadscript: new InlineCadScriptService(), engine: () => nodeEngine, ir, debounceMs: 0 });
  h.services.doc = doc;
  h.services.ir = ir;
  doc.load({ path: null, name: "plate", format: "ir-v1", source: document });
  await doc.idle();
  const tools = new ToolRegistry();
  registerFeatureTools(tools);
  const selection = staticSelectionPort([]);
  const shown: PanelHandle[][] = [];
  const handles: HandlesPort = { show: (hs) => void shown.push([...hs]), clear: () => void shown.push([]) };
  const shell = new Shell({ services: h.services, commands: h.commands, tools, ports: { selection, handles } });
  return { ...h, ir, doc, shell, selection, shown };
}

async function settle(p: PanelSession): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await p.settled();
    await new Promise((r) => setTimeout(r, 5));
    const s = p.getState().state;
    if (s !== "previewing") return;
  }
}

async function open(h: H, id: string, args: Record<string, unknown> = {}): Promise<PanelSession> {
  const r = await h.shell.startTool(id, "test", args);
  expect(r.started, r.reason).toBe(true);
  const p = h.shell.getState().panel!;
  await settle(p);
  return p;
}

function features(h: H): Array<Record<string, unknown>> {
  return (JSON.parse(h.ir.document) as { parts: Array<{ features: Array<Record<string, unknown>> }> }).parts.flatMap((p) => p.features);
}

function feature(h: H, id: string): Record<string, unknown> {
  return features(h).find((f) => f["id"] === id)!;
}

const face = (key: string, point?: [number, number, number]): SelectionItem => ({ kind: "face", part: "part", key, body: "part/slab", ...(point ? { point } : {}) });

describe("the create tools", () => {
  it("are registered once each, in the create, modify and construct groups, with the shortcuts E, H and Q", () => {
    const tools = new ToolRegistry();
    registerFeatureTools(tools);
    expect(tools.list().map((t) => t.id)).toEqual(CREATE_TOOLS.map((t) => t.id).sort((a, b) => tools.list().findIndex((x) => x.id === a) - tools.list().findIndex((x) => x.id === b)));
    expect(new Set(tools.list().map((t) => t.group))).toEqual(new Set(["create", "modify", "construct"]));
    const keys = tools.keymap("model");
    expect(keys.get("e")).toBe("feature.extrude");
    expect(keys.get("h")).toBe("feature.hole");
    expect(keys.get("q")).toBe("feature.pushPull");
  });

  it_("Extrude: previews the body tinted with a distance arrow; a drag of the arrow sets the distance; OK is one step", async () => {
    const h = await harness();
    h.selection.set([{ kind: "feature", feature: "bossSk" }]);
    const p = await open(h, "feature.extrude");
    expect(p.values()["sketch"]).toBe("s2");
    p.set("distance", "6");
    p.set("operation", "join");
    await settle(p);
    expect(p.getState().state).toBe("ready");
    const preview = h.shell.getState().previewBodies!;
    expect(preview.some((b) => JSON.stringify(b.color) === JSON.stringify(PREVIEW_TINT))).toBe(true);
    const arrow = p.getState().handles.find((x) => x.id === "distance")!;
    expect(arrow).toMatchObject({ field: "distance", kind: "pushPull", value: 6 });
    expect(arrow.origin[2]).toBeCloseTo(5, 6);
    expect(arrow.origin[0]).toBeCloseTo(8, 6);
    expect(arrow.axis).toEqual([0, 0, 1]);
    expect(h.shown.at(-1)?.[0]?.id).toBe("distance");
    // The viewport drags the arrow: the field follows, and the preview with it.
    p.handleChanged("distance", 9, "drag");
    p.handleChanged("distance", 9, "end");
    expect((p.values()["distance"] as { text: string }).text).toBe("9");
    await settle(p);
    const before = h.ir.getState().history.undoLabel;
    const r = await p.commit("test");
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(feature(h, "extrude1")).toMatchObject({ sketch: "s2", distance: 9, op: "join", targets: "all" });
    expect(h.ir.getState().history.undoLabel).toBe("Extrude bossSk");
    expect(before).not.toBe("Extrude bossSk");
    expect(h.shown.at(-1)).toEqual([]);
  });

  it_("Extrude: a symmetric extrude's arrow shows half the distance; re-editing from the timeline commits updateFeature", async () => {
    const h = await harness();
    let p = await open(h, "feature.extrude", { sketch: "s2", distance: "4", direction: "symmetric" });
    const arrow = p.getState().handles[0]!;
    expect(arrow.value).toBe(2);
    p.handleChanged("distance", 3, "end");
    expect((p.values()["distance"] as { text: string }).text).toBe("6");
    await settle(p);
    expect((await p.commit("test")).ok).toBe(true);
    await h.doc.idle();
    const r = await h.shell.editFeature("extrude1", "test");
    expect(r).toMatchObject({ started: true, tool: "feature.extrude" });
    p = h.shell.getState().panel!;
    await settle(p);
    expect(p.values()).toMatchObject({ sketch: "s2", direction: "symmetric", name: "extrude1" });
    p.set("distance", "t * 2");
    await settle(p);
    expect((await p.commit("test")).ok).toBe(true);
    expect(feature(h, "extrude1")).toMatchObject({ distance: "t * 2", direction: "symmetric" });
    expect(h.ir.getState().history.undoLabel).toBe("Edit extrude1");
  });

  it_("Extrude: a value the field refuses stays local; a join that meets no body shows the engine's error on its field; nothing is committed", async () => {
    const h = await harness();
    const p = await open(h, "feature.extrude", { sketch: "s1", distance: "t - 5" });
    expect(p.getState().state).toBe("collecting");
    expect(p.getState().fields.find((x) => x.key === "distance")!.error?.message).toMatch(/more than 0/);
    p.set("sketch", "s3");
    p.set("distance", "5");
    p.set("operation", "join");
    await settle(p);
    expect(p.getState().state).toBe("invalid");
    expect(p.getState().fields.find((x) => x.key === "operation")!.remoteError?.code).toBe("BOOLEAN_NO_INTERSECTION");
    const before = h.ir.document;
    expect((await p.commit("test")).ok).toBe(false);
    expect(h.ir.document).toBe(before);
  });

  it_("Extrude: through all needs a cut and has no arrow; up to a plane follows the plane; re-editing keeps the extent", async () => {
    const withRoof = JSON.parse(PLATE) as { parts: Array<{ features: unknown[] }> };
    withRoof.parts[0]!.features.push({ type: "datum_plane", id: "d1", name: "roof", mode: "offset", from: "XY", distance: 12 });
    const h = await harness(JSON.stringify(withRoof));
    let p = await open(h, "feature.extrude", { sketch: "s2", extent: "through_all", direction: "reverse" });
    // A new body cannot go "through all": the operation field says so, and nothing previews.
    expect(p.getState().fields.find((f) => f.key === "operation")!.remoteError?.code).toBe("EXTENT_NEEDS_CUT");
    p.set("operation", "cut");
    await settle(p);
    expect(p.getState().state).toBe("ready");
    expect(p.getState().handles).toEqual([]);
    expect(p.getState().fields.find((f) => f.key === "distance")!.visible).toBe(false);
    expect((await p.commit("test")).ok).toBe(true);
    expect(feature(h, "extrude1")).toMatchObject({ extent: "through_all", op: "cut", targets: "all", direction: "reverse" });
    expect(feature(h, "extrude1")["distance"]).toBeUndefined();
    await h.doc.idle();
    let report = await h.ir.report();
    expect(report.parts![0]!.bodies[0]!.volume).toBeCloseTo(40 * 20 * 5 - Math.PI * 9 * 5, 6);

    // Up to the datum plane 12 above XY: the outline, joined, now ends on it (the plate grows to it).
    p = await open(h, "feature.extrude", { sketch: "s1", extent: "up_to", operation: "join" });
    expect(p.getState().state).not.toBe("ready");
    p.set("upTo", [{ kind: "datum", feature: "d1", label: "roof" }]);
    await settle(p);
    expect(p.getState().state).toBe("ready");
    expect((await p.commit("test")).ok).toBe(true);
    expect(feature(h, "extrude2")).toMatchObject({ extent: { up_to: { datum: "d1" } }, op: "join" });
    await h.doc.idle();
    report = await h.ir.report();
    expect(report.parts![0]!.bodies[0]!.bbox_max[2]).toBeCloseTo(12, 9);

    // Re-editing from the timeline shows the extent and the plane.
    const r = await h.shell.editFeature("extrude2", "test");
    expect(r).toMatchObject({ started: true, tool: "feature.extrude" });
    p = h.shell.getState().panel!;
    await settle(p);
    expect(p.values()).toMatchObject({ extent: "up_to", operation: "join" });
    expect((p.values()["upTo"] as SelectionItem[])[0]).toMatchObject({ kind: "datum", feature: "d1" });
  });

  it_("Revolve: offers the sketch's construction line as the axis, previews with an angle ring, and commits", async () => {
    const h = await harness();
    h.selection.set([{ kind: "feature", feature: "ringSk" }]);
    const p = await open(h, "feature.revolve");
    expect(p.values()).toMatchObject({ sketch: "s3", axis: "s3:ax" });
    p.set("angle", "180");
    await settle(p);
    expect(p.getState().state).toBe("ready");
    const ring = p.getState().handles[0]!;
    expect(ring).toMatchObject({ id: "angle", kind: "rotate", value: 180 });
    expect(ring.axis[2]).toBeCloseTo(1, 9);
    expect((await p.commit("test")).ok).toBe(true);
    expect(feature(h, "revolve1")).toMatchObject({ sketch: "s3", axis: { origin: [0, 0], direction: [0, 1] }, angle: 180 });
    const report = await h.ir.report();
    const body = report.parts!.flatMap((x) => x.bodies).find((b) => b.origin.feature === "revolve1")!;
    expect(body.volume).toBeCloseTo((Math.PI * (34 * 34 - 30 * 30) * 6) / 2, 3);
  });

  it_("Hole: drills where the face was clicked, previews the holes' summary, and a blind hole gets a depth arrow", async () => {
    const h = await harness();
    h.selection.set([face("e1/cap:end", [-10, 4, 5])]);
    const p = await open(h, "feature.hole");
    expect(p.getState().fields.find((f) => f.key === "face")!.value).toHaveLength(1);
    p.set("size", "M4");
    p.set("kind", "counterbore");
    p.set("extent", "blind");
    p.set("depth", "3");
    await settle(p);
    // The counterbore (4.4 mm deep for M4) must be shallower than the hole: on the depth field.
    expect(p.getState().fields.find((f) => f.key === "depth")!.remoteError?.code).toBe("INVALID_VALUE");
    p.set("depth", "4.8");
    await settle(p);
    expect(p.getState().state, JSON.stringify(p.getState().errors)).toBe("ready");
    expect(p.getState().summary).toEqual(expect.arrayContaining([{ label: "Holes", value: "1" }]));
    const arrow = p.getState().handles.find((x) => x.id === "depth")!;
    expect(arrow.origin).toEqual([-10, 4, 5]);
    expect(arrow.axis).toEqual([0, 0, -1]);
    expect((await p.commit("test")).ok).toBe(true);
    expect(feature(h, "hole1")).toMatchObject({
      on: { face: { kind: "face", q: { op: "cap", feature: "e1", end: "end" } } },
      at: { list: [{ id: "p1", at: [-10, 4] }] },
      size: "M4",
      cbore: "iso4762",
      depth: { blind: 4.8 },
    });
  });

  it_("Hole: a position off the face lands on the placement field; re-editing keeps its position", async () => {
    const h = await harness();
    h.selection.set([face("e1/cap:end")]);
    let p = await open(h, "feature.hole", { placement: "uv", u: "30", v: "0" });
    expect(p.getState().state).toBe("invalid");
    expect(p.getState().fields.find((f) => f.key === "placement")!.remoteError?.code).toBe("HOLE_POINT_OFF_FACE");
    p.set("u", "12");
    await settle(p);
    expect(p.getState().state).toBe("ready");
    expect((await p.commit("test")).ok).toBe(true);
    await h.doc.idle();
    await h.shell.editFeature("hole1", "test");
    p = h.shell.getState().panel!;
    await settle(p);
    expect(p.values()).toMatchObject({ placement: "uv", size: "M3" });
    p.set("size", "M5");
    await settle(p);
    expect((await p.commit("test")).ok).toBe(true);
    expect(feature(h, "hole1")).toMatchObject({ size: "M5", at: { list: [{ id: "p1", at: [12, 0] }] } });
  });

  it_("Plane: an offset from a face, with its offset arrow; Axis: along an edge", async () => {
    const h = await harness();
    h.selection.set([face("e1/cap:end")]);
    let p = await open(h, "construct.plane", { distance: "7" });
    expect(p.getState().state).toBe("ready");
    const arrow = p.getState().handles[0]!;
    expect(arrow).toMatchObject({ id: "distance", kind: "linear", value: 7, axis: [0, 0, 1] });
    expect(arrow.origin[2]).toBeCloseTo(5, 9);
    expect(p.getState().summary.find((r) => r.label === "Origin")?.value).toBe("(0.00, 0.00, 12.00)");
    expect((await p.commit("test")).ok).toBe(true);
    expect(feature(h, "datum_plane1")).toMatchObject({ mode: "offset", from: { face: { kind: "face", q: { op: "cap", feature: "e1", end: "end" } } }, distance: 7 });
    h.selection.set([{ kind: "edge", part: "part", key: "e1/edge:{e1/cap:end|e1/side:r.top}", body: "part/slab" }]);
    p = await open(h, "construct.axis");
    expect(p.values()["mode"]).toBe("edge");
    expect((await p.commit("test")).ok).toBe(true);
    expect(feature(h, "datum_axis1")).toMatchObject({ mode: "edge", edge: { kind: "edge", q: { op: "between" } } });
  });

  it_("Combine: bodies picked by a face each; a body in both lists is refused on the tools field", async () => {
    const two = JSON.parse(PLATE) as { parts: Array<{ features: unknown[] }> };
    two.parts[0]!.features.push({ type: "extrude", id: "e2", name: "peg", sketch: "s2", distance: 8, direction: "reverse" });
    const h = await harness(JSON.stringify(two));
    const peg: SelectionItem = { kind: "face", part: "part", key: "e2/side:c", body: "part/peg" };
    h.selection.set([face("e1/cap:start")]);
    const p = await open(h, "feature.combine", { operation: "cut" });
    p.set("tools", [face("e1/side:r.left")]);
    await settle(p);
    expect(p.getState().fields.find((f) => f.key === "tools")!.remoteError?.code).toBe("BOOLEAN_TOOL_IS_TARGET");
    p.set("tools", [peg]);
    await settle(p);
    expect(p.getState().state, JSON.stringify([p.getState().errors, p.getState().fields.map((f) => f.remoteError)])).toBe("ready");
    expect((await p.commit("test")).ok).toBe(true);
    expect(feature(h, "boolean1")).toMatchObject({ op: "cut", targets: { kind: "body", q: { op: "body", feature: "e1" } }, tools: { kind: "body", q: { op: "body", feature: "e2" } } });
  });

  it_("Push/Pull: the slab's top cap drives the parameter t; a side face says what to edit instead", async () => {
    const h = await harness();
    h.selection.set([face("e1/cap:end")]);
    const p = await open(h, "feature.pushPull", { offset: "2" });
    expect(p.getState().state).toBe("ready");
    expect(p.getState().summary).toEqual([
      { label: "Drives", value: "slab · distance" },
      { label: "Parameter", value: "t" },
      { label: "Value", value: "t → 7 mm" },
    ]);
    const arrow = p.getState().handles[0]!;
    expect(arrow, JSON.stringify(h.doc.getState().bodies.map((b) => [b.name, b.faceRanges.map((f) => f.face)]))).toMatchObject({ kind: "pushPull", value: 2 });
    expect(arrow.axis[2]).toBeCloseTo(1, 6);
    expect((await p.commit("test")).ok).toBe(true);
    expect((JSON.parse(h.ir.document) as { params: Array<{ value: unknown }> }).params[0]!.value).toBe(7);
    h.selection.set([face("e1/side:r.left")]);
    const q = await open(h, "feature.pushPull", { offset: "1" });
    expect(q.getState().fields.find((f) => f.key === "face")!.remoteError?.code).toBe("MODEL_NO_DRIVER");
  });
});

describe("Move/Copy (transform)", () => {
  it_("moves the picked body with its arrows and a rotate ring; Copy adds a body; re-edit keeps its bodies", async () => {
    const h = await harness();
    h.selection.set([face("e1/cap:end")]);
    const p = await open(h, "feature.move", { dx: "30" });
    expect(p.getState().state, JSON.stringify(p.getState().errors)).toBe("ready");
    const hs = p.getState().handles;
    expect(hs.map((x) => [x.id, x.kind, x.value])).toEqual([
      ["dx", "linear", 30],
      ["dy", "linear", 0],
      ["dz", "linear", 0],
    ]);
    expect(hs[0]!.origin).toEqual([0, 0, 2.5]);
    p.handleChanged("dz", 4, "end");
    p.set("axis", "Z");
    p.set("angle", "90");
    await settle(p);
    expect(p.getState().handles.find((x) => x.id === "angle")).toMatchObject({ kind: "rotate", axis: [0, 0, 1], value: 90 });
    expect((await p.commit("test")).ok).toBe(true);
    expect(feature(h, "transform1")).toMatchObject({ type: "transform", bodies: { kind: "body", q: { op: "body", feature: "e1" } }, translate: [30, 0, 4], rotate: { axis: "Z", angle: 90 } });
    const report = await h.ir.report();
    const slab = report.parts![0]!.bodies.find((b) => b.origin.feature === "e1")!;
    expect(slab.bbox_min).toEqual([20, -20, 4]);
    await h.doc.idle();
    await h.shell.editFeature("transform1", "test");
    const q = h.shell.getState().panel!;
    await settle(q);
    expect(q.values()).toMatchObject({ axis: "Z", copy: false });
    q.set("copy", true);
    await settle(q);
    expect((await q.commit("test")).ok).toBe(true);
    expect(feature(h, "transform1")).toMatchObject({ copy: true });
    expect((await h.ir.report()).parts![0]!.bodies).toHaveLength(2);
  });
});

describe("the same command from the panel, the app command and the agent", () => {
  it_("a hole made in the panel, by model.hole and by the agent's hole tool is the same document", async () => {
    const args = { face: "e1/cap:end", at: [{ u: 5, v: -3 }], size: "M3", kind: "countersink", depth: "through" };
    // 1. The panel.
    const a = await harness();
    a.selection.set([face("e1/cap:end")]);
    const p = await open(a, "feature.hole", { placement: "uv", u: "5", v: "-3", kind: "countersink" });
    expect((await p.commit("test")).ok).toBe(true);
    // 2. The app command (palette, menu, automation).
    const b = await harness();
    const r = await b.commands.executeUnknown({ id: "model.hole", args }, { source: "test" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    // 3. The agent's tool, through the live op host.
    const c = await harness();
    const { appOpsHost } = await import("../src/agent/ops-host");
    const { holeModelingTool, runModelingTool } = await import("@aicad/model-ops");
    await runModelingTool(holeModelingTool, args, appOpsHost(c.services, c.commands));
    // Byte for byte, but for the agent's authorship mark (ADR 0015).
    const strip = (d: string) => d.replace(/,\n\s*"author": "agent"/g, "");
    expect(a.ir.document).toBe(b.ir.document);
    expect(strip(c.ir.document)).toBe(a.ir.document);
    expect(feature(c, "hole1")["author"]).toBe("agent");
  });
});
