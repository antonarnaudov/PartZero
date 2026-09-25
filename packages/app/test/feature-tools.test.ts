/**
 * The modify and pattern tools (Fillet, Chamfer, Shell, Linear/Circular Pattern, Mirror) on the real
 * Forge engine, headless: picks → Refs by Forge's refFor, the live checked preview (tinted bodies,
 * summaries, errors on their field with the feasible range), handles bound to fields that clamp to
 * the feasible range at drag start, OK as ONE catalogue op (the same `addFeature` the agent sends),
 * and re-editing a feature from the timeline.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { IrOp } from "@aicad/model-ops";
import { DocStore } from "../src/doc/doc-store";
import { forgeWebCommandEngine, type ForgeWebCommandModule, type IrCommandEngine } from "../src/doc/v1/command-engine";
import { IrDocStore } from "../src/doc/v1/ir-doc-store";
import { EngineManager } from "../src/engine/engine-manager";
import type { EvalResult, ForgeEngine, MeshFormat, RenderBody } from "../src/engine/types";
import { InlineCadScriptService } from "../src/cadscript/inline-service";
import { registerModifyTools } from "../src/tools/builtin/modify";
import { registerPatternTools } from "../src/tools/builtin/pattern";
import { registerFeatureTools } from "../src/tools/builtin/features";
import { createShellCommandRegistry } from "../src/tools/commands";
import { PanelHandles } from "../src/tools/framework/handles";
import { staticSelectionPort } from "../src/tools/framework/ports";
import type { PanelSession } from "../src/tools/framework/session";
import type { HandlesPort, PanelHandleSpec, SelectionItem } from "../src/tools/framework/types";
import { ToolRegistry } from "../src/tools/registry";
import { attachShell, Shell } from "../src/tools/shell";
import { viewportRuntime } from "../src/viewport/runtime";
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

/** A 40 × 20 × 5 slab (`e1`) with a 4 × 4 pocket 2 deep at x = 10 (`e2`). */
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
        { type: "sketch", id: "s2", name: "pocket_sketch", plane: { origin: [0, 0, 5], normal: [0, 0, 1], x_dir: [1, 0, 0] }, curves: [{ kind: "rect", id: "p", center: [10, 0], w: 4, h: 4 }] },
        { type: "extrude", id: "e2", name: "pocket", sketch: "s2", distance: 2, direction: "reverse", op: "cut", targets: "all" },
      ],
    },
  ],
});

class FakeHandles implements HandlesPort {
  shown: PanelHandleSpec[] = [];
  listener: ((c: { id: string; value: number; phase: "start" | "drag" | "end" | "cancel" }) => void) | null = null;
  updates: Array<{ id: string; patch: Partial<PanelHandleSpec> }> = [];
  drag = false;
  show(h: readonly PanelHandleSpec[], l: FakeHandles["listener"]): () => void {
    this.shown = [...h];
    this.listener = l;
    return () => {
      if (this.listener === l) {
        this.shown = [];
        this.listener = null;
      }
    };
  }
  update(id: string, patch: Partial<PanelHandleSpec>): void {
    this.updates.push({ id, patch });
    this.shown = this.shown.map((s) => (s.id === id ? { ...s, ...patch } : s));
  }
  dragging(): boolean {
    return this.drag;
  }
}

interface Rig extends Harness {
  shell: Shell;
  ir: IrDocStore;
  doc: DocStore;
  selection: ReturnType<typeof staticSelectionPort>;
  handles: FakeHandles;
}

async function rig(document = PLATE): Promise<Rig> {
  const h = await makeHarness();
  const nodeEngine = new NodeForgeEngine();
  const engines = new EngineManager({ "forge-web": () => Promise.resolve(nodeEngine) });
  await engines.select("forge-web");
  const ir = new IrDocStore({ engine: () => engine });
  const doc = new DocStore({ cadscript: new InlineCadScriptService(), engine: () => nodeEngine, ir, debounceMs: 0 });
  h.services.engines = engines;
  h.services.doc = doc;
  h.services.ir = ir;
  doc.load({ path: null, name: "plate", format: "ir-v1", source: document });
  await doc.idle();
  // The viewport topology the handles read (the React host does this from the document's bodies).
  viewportRuntime(h.services).setSceneBodies(doc.getState().bodies);
  const tools = new ToolRegistry({ flags: () => true });
  registerFeatureTools(tools);
  registerModifyTools(tools);
  registerPatternTools(tools);
  const selection = staticSelectionPort([]);
  const handles = new FakeHandles();
  const shell = new Shell({ services: h.services, commands: h.commands, shellCommands: createShellCommandRegistry(() => h.services), tools, ports: { selection, handles } });
  attachShell(h.services, shell);
  return { ...h, shell, ir, doc, selection, handles };
}

function bodies(r: Rig): readonly RenderBody[] {
  return r.doc.getState().bodies;
}

/** A displayed edge or face as the viewport would hand it to a tool: render name, body, a point on it. */
function entity(r: Rig, kind: "edge" | "face", name: string): SelectionItem {
  const b = bodies(r).find((x) => (kind === "edge" ? x.edges.some((e) => e.edge === name) : x.faceRanges.some((f) => f.face === name)));
  if (!b) throw new Error(`no ${kind} ${name}`);
  let point: [number, number, number];
  if (kind === "edge") {
    const e = b.edges.find((x) => x.edge === name)!;
    const n = e.points.length / 3;
    const i = Math.floor(n / 2);
    point = [e.points[i * 3]!, e.points[i * 3 + 1]!, e.points[i * 3 + 2]!];
  } else {
    const f = b.faceRanges.find((x) => x.face === name)!;
    const t = f.start;
    const vs = [0, 1, 2].map((k) => b.indices[t * 3 + k]!);
    point = [0, 1, 2].map((c) => vs.reduce((s, v) => s + b.positions[v * 3 + c]!, 0) / 3) as [number, number, number];
  }
  return { kind, part: "p1", key: name, body: b.name, point };
}

function body(r: Rig, index = 0): SelectionItem {
  return { kind: "body", part: "p1", body: bodies(r)[index]!.name };
}

async function openTool(r: Rig, id: string, items: SelectionItem[] = []): Promise<PanelSession> {
  r.selection.set(items);
  const s = await r.shell.startTool(id, "test");
  expect(s.started, s.reason).toBe(true);
  const p = r.shell.getState().panel!;
  await p.settled();
  return p;
}

async function commit(r: Rig, p: PanelSession): Promise<void> {
  await p.settled();
  const out = await p.commit("ui");
  expect(out.ok, JSON.stringify(out)).toBe(true);
  await r.doc.idle();
  viewportRuntime(r.services).setSceneBodies(r.doc.getState().bodies);
}

function features(r: Rig): Array<Record<string, unknown>> {
  return (JSON.parse(r.ir.document!) as { parts: Array<{ features: Array<Record<string, unknown>> }> }).parts[0]!.features;
}

function reportOf(r: Rig): { features: Array<{ feature_id: string; status: string; refs?: Array<{ field: string; members: Array<{ key: string }> }>; pattern?: { instances: number } }>; parts: Array<{ bodies: Array<{ volume: number }> }> } {
  return r.doc.getState().report as never;
}

const TOP = "e1/edge:{e1/cap:end|e1/side:r.top}";
const VERTICAL = "e1/edge:{e1/side:r.left|e1/side:r.top}";

describe("Fillet", () => {
  it_("previews the picked edge (tinted, summarized), commits ONE addFeature with a captured Ref — the op the agent sends", async () => {
    const r = await rig();
    const p = await openTool(r, "feature.fillet", [entity(r, "edge", TOP)]);
    p.set("r", "2 mm");
    await p.settled();
    const st = p.getState();
    expect(st.state).toBe("ready");
    expect(st.summary.find((x) => x.label === "Edges")?.value).toBe("1");
    expect(r.shell.getState().previewBodies?.some((b) => b.color !== undefined)).toBe(true);
    const before = r.ir.getState().revision;
    await commit(r, p);
    expect(r.ir.getState().revision).toBe(before + 1);
    const f = features(r).at(-1)!;
    expect(f).toMatchObject({ type: "fillet", id: "fillet1", r: 2, edges: { kind: "edge" } });
    expect((f["edges"] as { capture?: unknown }).capture).toBeTruthy();
    expect(reportOf(r).features.find((x) => x.feature_id === "fillet1")?.status).toBe("ok");
    // The agent's add_feature with the same JSON is the same transaction kind: it builds the same way.
    const agentOp: IrOp = { op: "addFeature", feature: { type: "fillet", r: 2, edges: f["edges"] } as { type: string } };
    r.ir.undo();
    await r.doc.idle();
    const a = await r.commands.execute({ id: "ir.apply", args: { ops: [agentOp] } }, { source: "agent" });
    expect(a.ok).toBe(true);
    await r.doc.idle();
    const g = features(r).at(-1)!;
    expect({ ...g, author: undefined }).toEqual({ ...f, author: undefined });
    expect(g["author"]).toBe("agent");
  });

  it_("shows a too-large radius on its field with the largest that builds; Use fixes it", async () => {
    const r = await rig();
    const p = await openTool(r, "feature.fillet", [entity(r, "edge", VERTICAL)]);
    p.set("r", "50");
    await p.settled();
    const f = p.getState().fields.find((x) => x.key === "r")!;
    expect(p.getState().state).toBe("invalid");
    expect(f.remoteError).toMatchObject({ code: "FILLET_RADIUS_TOO_LARGE", feasible: { max: 19.999 } });
    p.set("r", "19.999");
    await p.settled();
    expect(p.getState().state).toBe("ready");
  });

  it_("a radius whose blend runs into the pocket lands on Radius with the largest that builds (Forge's capability gap, bisected)", async () => {
    const r = await rig(PLATE.replace('"value":5,"min":1', '"value":10,"min":1').replace('"origin":[0,0,5]', '"origin":[0,0,10]'));
    const p = await openTool(r, "feature.fillet", [entity(r, "edge", "e1/edge:{e1/cap:end|e1/side:r.bottom}")]);
    p.set("r", "9");
    await p.settled();
    const f = p.getState().fields.find((x) => x.key === "r")!;
    expect(f.remoteError?.code).toBe("FILLET_FAILED");
    const max = f.remoteError?.feasible?.max ?? 0;
    expect(max).toBeGreaterThan(7);
    expect(max).toBeLessThanOrEqual(8.001);
    p.set("r", String(max));
    await commit(r, p);
    expect(features(r).at(-1)).toMatchObject({ type: "fillet", r: max });
  });

  it_("takes a face for all its edges, and the tangent chain can be turned off", async () => {
    const r = await rig();
    const p = await openTool(r, "feature.fillet", [entity(r, "face", "e1/cap:start")]);
    p.set("r", "1");
    p.set("tangent_chain", false);
    await commit(r, p);
    const f = features(r).at(-1)!;
    expect(f["tangent_chain"]).toBe(false);
    expect(reportOf(r).features.find((x) => x.feature_id === "fillet1")?.refs?.[0]?.members).toHaveLength(4);
  });

  it_("puts a radius handle on the edge that drives the field and clamps to the feasible range at drag start", async () => {
    const r = await rig();
    const p = await openTool(r, "feature.fillet", [entity(r, "edge", VERTICAL)]);
    const ph = r.shell.panelHandles as PanelHandles;
    await ph.settled();
    const h = r.handles.shown[0]!;
    expect(h).toMatchObject({ id: "r", kind: "radius", value: 2 });
    // At the vertical edge x = -20, y = 10: the outward bisector points to −X/+Y.
    expect(h.origin[0]).toBeCloseTo(-20);
    expect(h.origin[1]).toBeCloseTo(10);
    expect(h.axis[0]).toBeLessThan(0);
    expect(h.axis[1]).toBeGreaterThan(0);
    r.handles.drag = true;
    r.handles.listener!({ id: "r", value: 2, phase: "start" });
    await expect.poll(() => r.handles.updates.find((u) => u.id === "r")?.patch.max).toBe(19.999);
    r.handles.listener!({ id: "r", value: 4.5, phase: "drag" });
    expect((p.getState().fields.find((x) => x.key === "r")!.value as { text: string }).text).toBe("4.5");
    r.handles.listener!({ id: "r", value: 4.5, phase: "cancel" });
    expect((p.getState().fields.find((x) => x.key === "r")!.value as { text: string }).text).toBe("2 mm");
    r.handles.drag = false;
  });

  it_("re-edits from the timeline: the edges stay, a new radius is one updateFeature", async () => {
    const r = await rig();
    const p = await openTool(r, "feature.fillet", [entity(r, "edge", TOP)]);
    await commit(r, p);
    const edgesBefore = features(r).at(-1)!["edges"];
    const e = await r.shell.editFeature("fillet1", "test");
    expect(e).toMatchObject({ started: true, tool: "feature.fillet" });
    const q = r.shell.getState().panel!;
    const edges = q.getState().fields.find((x) => x.key === "edges")!.value as SelectionItem[];
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ kind: "edge", refMember: true });
    q.set("r", "3");
    await commit(r, q);
    const f = features(r).at(-1)!;
    expect(f["r"]).toBe(3);
    expect(f["edges"]).toEqual(edgesBefore);
    expect(r.ir.getState().history.undoLabel).toBe("Edit fillet1");
  });
});

describe("Chamfer", () => {
  it_("equal distance, then two distances measured on a picked face", async () => {
    const r = await rig();
    const p = await openTool(r, "feature.chamfer", [entity(r, "edge", TOP)]);
    p.set("d", "1.5");
    await commit(r, p);
    expect(features(r).at(-1)).toMatchObject({ type: "chamfer", d: 1.5 });
    const q = await openTool(r, "feature.chamfer", [entity(r, "edge", "e1/edge:{e1/cap:end|e1/side:r.bottom}")]);
    q.set("form", "two");
    q.set("d", "1");
    q.set("d2", "2");
    q.set("side", [entity(r, "face", "e1/cap:end")]);
    await commit(r, q);
    const f = features(r).at(-1)!;
    expect(f).toMatchObject({ type: "chamfer", d: 1, d2: 2, side: { kind: "face" } });
    expect(reportOf(r).features.find((x) => x.feature_id === "chamfer2")?.status).toBe("ok");
  });

  it_("a too-large distance lands on Distance with the feasible maximum", async () => {
    const r = await rig();
    const p = await openTool(r, "feature.chamfer", [entity(r, "edge", TOP)]);
    p.set("d", "30");
    await p.settled();
    expect(p.getState().fields.find((x) => x.key === "d")!.remoteError).toMatchObject({ code: "CHAMFER_DISTANCE_TOO_LARGE" });
  });
});

describe("Shell", () => {
  it_("opens the picked face with an inward wall; too thick shows the largest that builds", async () => {
    const r = await rig();
    const p = await openTool(r, "feature.shell", [entity(r, "face", "e1/cap:start")]);
    p.set("thickness", "1");
    await p.settled();
    expect(p.getState().state).toBe("ready");
    expect(p.getState().summary.find((x) => x.label === "Opened faces")?.value).toBe("1");
    p.set("thickness", "6");
    await p.settled();
    const t = p.getState().fields.find((x) => x.key === "thickness")!;
    expect(t.remoteError?.code).toBe("SHELL_THICKNESS_TOO_LARGE");
    expect(t.remoteError?.feasible?.max).toBeGreaterThan(0.5);
    p.set("thickness", "1");
    await commit(r, p);
    expect(features(r).at(-1)).toMatchObject({ type: "shell", thickness: 1, body: { kind: "body" }, open: { kind: "face" } });
    expect(reportOf(r).features.find((x) => x.feature_id === "shell1")?.status).toBe("ok");
  });

  it_("with no face picked shells the only body closed (an inner void)", async () => {
    const r = await rig();
    const p = await openTool(r, "feature.shell", [body(r)]);
    p.set("thickness", "1");
    await p.settled();
    expect(p.getState().summary.find((x) => x.label === "Opened faces")?.value).toBe("none (inner void)");
    await commit(r, p);
    expect(features(r).at(-1)!["open"]).toBeUndefined();
  });
});

describe("Patterns", () => {
  it_("linear: the pocket three times along X — one addFeature with the feature seed", async () => {
    const r = await rig();
    const p = await openTool(r, "pattern.linear", [{ kind: "feature", feature: "e2", label: "pocket" }]);
    p.set("count", "3");
    p.set("spacing", "-8 mm");
    await p.settled();
    expect(p.getState().summary.find((x) => x.label === "Copies")?.value).toBe("2");
    await commit(r, p);
    expect(features(r).at(-1)).toMatchObject({ type: "pattern", seed: { features: ["e2"] }, layout: { linear: { dir: "X", count: 3, spacing: -8 } } });
    const vol = reportOf(r).parts[0]!.bodies[0]!.volume;
    expect(vol).toBeCloseTo(40 * 20 * 5 - 3 * 4 * 4 * 2, 3);
  });

  it_("linear from a face the feature made, two directions", async () => {
    const r = await rig();
    const p = await openTool(r, "pattern.linear", [entity(r, "face", "e2/side:p.left")]);
    p.set("count", "2");
    p.set("spacing", "-6");
    p.set("second", true);
    p.set("count2", "2");
    p.set("spacing2", "5");
    await commit(r, p);
    expect(features(r).at(-1)).toMatchObject({ seed: { features: ["e2"] }, layout: { linear: { dir: "X", dir2: "Y", count2: 2, spacing2: 5 } } });
    expect(reportOf(r).features.at(-1)?.pattern?.instances).toBe(3);
  });

  it_("circular: a body copied around Z; re-editing it from the timeline opens the circular panel", async () => {
    const r = await rig();
    const p = await openTool(r, "pattern.circular", [body(r)]);
    expect((p.values()["seedKind"] as string)).toBe("bodies");
    p.set("count", "4");
    p.set("angle", "90");
    await commit(r, p);
    expect(features(r).at(-1)).toMatchObject({ type: "pattern", seed: { bodies: { kind: "body" } }, layout: { circular: { axis: "Z", count: 4, angle: 90 } } });
    expect(reportOf(r).parts[0]!.bodies).toHaveLength(4);
    const e = await r.shell.editFeature("pattern1", "test");
    expect(e.tool).toBe("pattern.linear");
    const q = r.shell.getState().panel!;
    expect(q.getState().title).toBe("Edit pattern1");
    expect(q.getState().fields.some((f) => f.key === "axis")).toBe(true);
    q.set("count", "3");
    await commit(r, q);
    expect(features(r).at(-1)).toMatchObject({ layout: { circular: { count: 3, angle: 90 } } });
    expect(reportOf(r).parts[0]!.bodies).toHaveLength(3);
  });

  it_("mirror: the pocket across YZ; an unsupported seed is refused on its field", async () => {
    const r = await rig();
    const p = await openTool(r, "pattern.mirror", [{ kind: "feature", feature: "e2", label: "pocket" }]);
    await commit(r, p);
    expect(features(r).at(-1)).toMatchObject({ type: "pattern", layout: { mirror: { plane: "YZ" } } });
    expect(reportOf(r).parts[0]!.bodies[0]!.volume).toBeCloseTo(40 * 20 * 5 - 2 * 4 * 4 * 2, 3);
    const q = await openTool(r, "pattern.mirror", [{ kind: "feature", feature: "s1", label: "outline" }]);
    await q.settled();
    expect(q.getState().fields.find((f) => f.key === "features")!.remoteError?.code).toBe("PATTERN_SEED_UNSUPPORTED");
  });

  it_("mirror of a body across a picked planar face joins the copy", async () => {
    const r = await rig();
    const p = await openTool(r, "pattern.mirror", [body(r)]);
    p.set("plane", [entity(r, "face", "e1/side:r.right")]);
    p.set("result", "join");
    await commit(r, p);
    const f = features(r).at(-1)!;
    expect(f).toMatchObject({ op: "join", targets: "all", layout: { mirror: { plane: { face: { kind: "face" } } } } });
    expect(reportOf(r).parts[0]!.bodies).toHaveLength(1);
    expect(reportOf(r).parts[0]!.bodies[0]!.volume).toBeCloseTo(2 * (40 * 20 * 5 - 4 * 4 * 2), 3);
  });
});
