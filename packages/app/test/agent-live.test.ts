/**
 * The live operator in the app, on the real Forge engine: a run on an IR v1 model starts on the
 * `ops` surface; the agent's ops arrive over the bridge and land one by one in the open model as
 * the agent, inside the turn's undo group; your edits wait while it works; the end of the run —
 * finished or stopped — seals the turn into one undo step (a lockdown violation discards it); Keep
 * makes its features yours; your "Allow" becomes an approval for that turn only; the agent can
 * neither answer for you nor act after its turn.
 */
import { parseDoc, type IrOp } from "@aicad/model-ops";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentEventBody, AgentOpsReply, AgentOpsRequest, AgentRunResult } from "../src/agent-protocol";
import { AgentService } from "../src/agent/agent-service";
import { InlineCadScriptService } from "../src/cadscript/inline-service";
import { DocStore } from "../src/doc/doc-store";
import { forgeWebCommandEngine, type ForgeWebCommandModule, type IrCommandEngine } from "../src/doc/v1/command-engine";
import { IrDocStore } from "../src/doc/v1/ir-doc-store";
import type { EvalResult, ForgeEngine, MeshFormat } from "../src/engine/types";
import { FakeAgentBridge, FakeSettingsBridge, makeHarness, type Harness } from "./helpers";

const nodeFs = "node:fs";
const fs = (await import(/* @vite-ignore */ nodeFs)) as { existsSync(p: URL): boolean; readFileSync(p: URL): Uint8Array };
const wasmUrl = new URL("../../forge-web/pkg/forge_wasm_bg.wasm", import.meta.url);
const hasWasm = fs.existsSync(wasmUrl);
const it_ = hasWasm ? it : it.skip;

type Mod = ForgeWebCommandModule & { init(input: unknown): Promise<void>; evaluate(ir: string, options?: object): { report: unknown; bodies: EvalResult["bodies"] }; exportMesh(ir: string, format: MeshFormat, options?: object): Uint8Array };
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

/** The desktop bridge with the ops channel: the test plays the agent process. */
class LiveBridge extends FakeAgentBridge {
  readonly #ops = new Set<(r: AgentOpsRequest) => void>();
  readonly #waiting = new Map<number, (r: AgentOpsReply) => void>();
  replies: AgentOpsReply[] = [];
  #id = 0;
  onOpsRequest(listener: (r: AgentOpsRequest) => void): () => void {
    this.#ops.add(listener);
    return () => this.#ops.delete(listener);
  }
  opsReply(reply: AgentOpsReply): Promise<{ ok: boolean }> {
    this.replies.push(reply);
    this.#waiting.get(reply.id)?.(reply);
    this.#waiting.delete(reply.id);
    return Promise.resolve({ ok: true });
  }
  /** One op call as the agent process makes it; resolves with the renderer's answer. */
  request(runId: string, method: AgentOpsRequest["method"], ops?: IrOp[]): Promise<AgentOpsReply> {
    const id = ++this.#id;
    const p = new Promise<AgentOpsReply>((resolve) => this.#waiting.set(id, resolve));
    for (const l of this.#ops) l({ v: 1, runId, id, method, ...(ops ? { ops } : {}) });
    return p;
  }
}

const BLANK = JSON.stringify({ schema: "aicad.ir/1", meta: { name: "cube" }, parts: [{ id: "p1", name: "part", features: [] }] });
/** Your plate: a parameter and two features of yours (no author mark). */
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
      ],
    },
  ],
});

const VERT = { kind: "edge", q: { op: "filter", where: { parallel: "Z" }, of: { op: "edges", of: { op: "sides", feature: "cube" } } } };
const CUBE_OPS: IrOp[][] = [
  [{ op: "addParam", name: "size", unit: "mm", value: 40 }],
  [{ op: "addFeature", feature: { type: "sketch", id: "base", name: "base", plane: "XY", curves: [{ kind: "rect", id: "outline", center: [0, 0], w: "size", h: "size" }] } }],
  [{ op: "addFeature", feature: { type: "extrude", id: "cube", name: "cube", sketch: "base", distance: "size" } }],
  [{ op: "addFeature", feature: { type: "fillet", id: "rounds", name: "rounds", r: 2, edges: VERT } }],
];

async function liveHarness(document = BLANK): Promise<Harness & { ir: IrDocStore; doc: DocStore; bridge: LiveBridge; agent: AgentService }> {
  const h = await makeHarness();
  const ir = new IrDocStore({ engine: () => engine });
  const nodeEngine = new NodeForgeEngine();
  const cadscript = new InlineCadScriptService();
  const doc = new DocStore({ cadscript, engine: () => nodeEngine, ir, debounceMs: 0 });
  const bridge = new LiveBridge();
  const settings = new FakeSettingsBridge();
  const agent = new AgentService({ agent: bridge, settings, cadscript, engine: () => nodeEngine, doc, ui: h.services.ui });
  h.services.doc = doc;
  h.services.ir = ir;
  h.services.agent = agent;
  agent.attachLive({ services: h.services, commands: h.commands });
  doc.load({ path: null, name: "cube", format: "ir-v1", source: document });
  await doc.idle();
  return { ...h, ir, doc, bridge, agent };
}

function result(extra: Partial<AgentRunResult> = {}): AgentEventBody {
  return {
    type: "result",
    result: { status: "proposed", stopReason: "proposed", message: "done", baseSource: "", proposedSource: "", changed: true, verified: true, summary: "Built.", assumptions: [], knownIssues: [], costUsd: 0.01, budgetUsd: 1, latencyMs: 1000, turns: 5, surface: "ops", steps: 4, ...extra },
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("the live operator in the app", () => {
  it_("starts on the ops surface; each op lands live in the open model as the agent; the finished turn is one undo step", async () => {
    const h = await liveHarness();
    expect(h.agent.liveAvailable).toBe(true);
    const sent = await h.commands.execute({ id: "chat.send", args: { text: "a 40 mm cube with rounded vertical edges" } }, { source: "ui" });
    expect(sent.ok).toBe(true);
    expect(h.bridge.starts[0]).toMatchObject({ surface: "ops", source: "" });
    const runId = "run-1";
    expect(h.ir.getState().group).toMatchObject({ label: "Agent: a 40 mm cube with rounded vertical edges", origin: "agent", steps: 0 });
    h.bridge.emit(runId, { type: "started", models: {}, budgetUsd: 1, transport: "scripted", engine: "forge-web", surface: "ops", autonomy: "review" });
    const revisions: number[] = [];
    for (const [i, ops] of CUBE_OPS.entries()) {
      const r = await h.bridge.request(runId, "apply", ops);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      revisions.push(h.ir.getState().revision);
      h.bridge.emit(runId, { type: "step", step: { index: i + 1, tool: "add_feature", ok: true, note: `step ${i + 1}`, label: "x" } });
      await h.doc.idle();
    }
    // Every op is its own change of the open model (the viewport and timeline follow the store), authored by the agent.
    expect(new Set(revisions).size).toBe(4);
    expect(h.ir.getState().group?.steps).toBe(4);
    const d = parseDoc(h.ir.document);
    expect(d.parts[0]!.features.map((f) => [f.id, f["author"]])).toEqual([
      ["base", "agent"],
      ["cube", "agent"],
      ["rounds", "agent"],
    ]);
    expect(h.doc.getState().source).toBe(h.ir.document);
    // The document reads back through the channel exactly.
    const read = await h.bridge.request(runId, "document");
    expect(read.ok && read.value).toBe(h.ir.document);
    // Your edit waits while the agent works.
    const yours = await h.commands.execute({ id: "ir.setParam", args: { name: "size", value: 50 } }, { source: "palette" });
    expect(!yours.ok && yours.error.detail?.code).toBe("IR_GROUP_OPEN");
    // The run ends: one undo step holds the whole turn.
    h.bridge.emit(runId, result());
    await settle();
    await h.ir.idle();
    expect(h.ir.getState().group).toBeNull();
    expect(h.ir.getState().history.undoLabel).toBe("Agent: a 40 mm cube with rounded vertical edges");
    const run = h.agent.run(runId)!;
    expect(run.steps).toHaveLength(4);
    expect(run.turn).toMatchObject({ kept: true, steps: 4, resolution: null });
    // Late ops are refused.
    const late = await h.bridge.request(runId, "apply", [{ op: "addParam", name: "late", unit: "mm", value: 1 }]);
    expect(late).toMatchObject({ ok: false, error: { code: "IR_GROUP_CLOSED" } });
    // Undo turn takes it all back in one step.
    const u = await h.commands.execute({ id: "agent.undoTurn", args: {} }, { source: "ui" });
    expect(u.ok && u.value).toEqual({ undone: true });
    expect(parseDoc(h.ir.document).parts[0]!.features).toEqual([]);
    expect(h.agent.run(runId)!.turn?.resolution).toBe("undone");
  });

  it_("Stop keeps what was built; Keep makes the turn's features yours", async () => {
    const h = await liveHarness();
    await h.agent.start({ prompt: "cube", chips: [] });
    for (const ops of CUBE_OPS.slice(0, 3)) expect((await h.bridge.request("run-1", "apply", ops)).ok).toBe(true);
    h.bridge.emit("run-1", { type: "step", step: { index: 3, tool: "add_feature", ok: true, note: "Extrude", label: "Add extrude cube", features: ["cube"] } });
    h.bridge.emit("run-1", { type: "step", step: { index: 2, tool: "add_feature", ok: true, note: "Sketch", label: "Add sketch base", features: ["base"] } });
    await h.commands.execute({ id: "agent.stop", args: {} }, { source: "ui" });
    expect(h.bridge.stops).toHaveLength(1);
    h.bridge.emit("run-1", result({ status: "stopped", stopReason: "cancelled", summary: "Stopped after 3 steps", steps: 3 }));
    await settle();
    await h.ir.idle();
    expect(h.ir.getState().group).toBeNull();
    expect(parseDoc(h.ir.document).parts[0]!.features.map((f) => f.id)).toEqual(["base", "cube"]);
    const k = await h.commands.execute({ id: "agent.keep", args: {} }, { source: "ui" });
    expect(k.ok && k.value).toEqual({ kept: 2 });
    expect(parseDoc(h.ir.document).parts[0]!.features.map((f) => f["author"])).toEqual(["user", "user"]);
    // Neither the agent nor an MCP client can keep, undo a turn or set the dial.
    for (const id of ["agent.keep", "agent.undoTurn"] as const) {
      const r = await h.commands.execute({ id, args: {} }, { source: "agent" });
      expect(!r.ok && r.error.detail?.code).toBe("COMMAND_HOST_ONLY");
    }
    const dial = await h.commands.execute({ id: "settings.setAutonomy", args: { autonomy: "auto" } }, { source: "mcp" });
    expect(!dial.ok && dial.error.detail?.code).toBe("COMMAND_HOST_ONLY");
  });

  it_("your Allow is an approval for this turn only: the agent's retried change to your work lands, nothing else of yours does", async () => {
    const h = await liveHarness(PLATE);
    await h.agent.start({ prompt: "make the plate 8 mm thick", chips: [] });
    const first = await h.bridge.request("run-1", "apply", [{ op: "setParam", name: "t", value: 8 }]);
    expect(first).toMatchObject({ ok: false, error: { code: "unapproved_user_change" } });
    h.bridge.emit("run-1", {
      type: "question",
      questionId: "q1",
      kind: "approval",
      questions: [{ id: "approval", question: "The agent asks to change your parameter t", options: ["Allow", "Don't allow"], default: "Don't allow" }],
      approval: { features: [], params: ["t"], rollback: false, reason: "make it 8 mm thick as asked" },
    });
    // The agent cannot answer for you.
    const forged = await h.commands.execute({ id: "agent.answer", args: { answers: ["Allow"] } }, { source: "agent" });
    expect(!forged.ok && forged.error.detail?.code).toBe("COMMAND_HOST_ONLY");
    const again = await h.bridge.request("run-1", "apply", [{ op: "setParam", name: "t", value: 8 }]);
    expect(again.ok).toBe(false);
    // You allow it.
    await h.commands.execute({ id: "agent.answer", args: { answers: ["Allow"] } }, { source: "ui" });
    expect(h.bridge.answers.at(-1)).toMatchObject({ questionId: "q1", answers: ["Allow"] });
    const retried = await h.bridge.request("run-1", "apply", [{ op: "setParam", name: "t", value: 8 }]);
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    // Only what you allowed: your slab stays yours to change.
    const other = await h.bridge.request("run-1", "apply", [{ op: "setField", feature: "e1", path: "/distance", value: 3 }]);
    expect(other).toMatchObject({ ok: false, error: { code: "unapproved_user_change" } });
    h.bridge.emit("run-1", result());
    await settle();
    await h.ir.idle();
    // The approval ended with the turn: a next turn needs a new one.
    await h.agent.start({ prompt: "thinner", chips: [] });
    const next = await h.bridge.request("run-2", "apply", [{ op: "setParam", name: "t", value: 6 }]);
    expect(next).toMatchObject({ ok: false, error: { code: "unapproved_user_change" } });
  });

  it_("Ask at each step: the agent's undo takes back its last step inside the turn only", async () => {
    const h = await liveHarness(PLATE);
    await h.agent.start({ prompt: "add a boss", chips: [] });
    expect((await h.bridge.request("run-1", "apply", [{ op: "addParam", name: "boss_d", unit: "mm", value: 6 }])).ok).toBe(true);
    const before = h.ir.document;
    expect((await h.bridge.request("run-1", "apply", [{ op: "addParam", name: "boss_h", unit: "mm", value: 4 }])).ok).toBe(true);
    const u = await h.bridge.request("run-1", "undo");
    expect(u).toMatchObject({ ok: true, value: true });
    expect(h.ir.document).toBe(before);
    expect(h.ir.getState().group?.steps).toBe(1);
    // Past the turn's first step, undo is refused: it would take back the user's work.
    await h.bridge.request("run-1", "undo");
    const past = await h.bridge.request("run-1", "undo");
    expect(past.ok && past.value).toBe(false);
    expect(parseDoc(h.ir.document).params?.map((p) => p["name"])).toEqual(["t"]);
  });

  it_("a lockdown violation discards the turn; a document opened over it stops the run; other runs' ops are refused", async () => {
    const h = await liveHarness();
    await h.agent.start({ prompt: "cube", chips: [] });
    expect((await h.bridge.request("run-1", "apply", CUBE_OPS[0]!)).ok).toBe(true);
    const stranger = await h.bridge.request("run-9", "apply", CUBE_OPS[0]!);
    expect(stranger).toMatchObject({ ok: false, error: { code: "IR_GROUP_CLOSED" } });
    h.bridge.emit("run-1", result({ status: "failed", stopReason: "lockdown_violation" }));
    await settle();
    await h.ir.idle();
    expect(parseDoc(h.ir.document).params ?? []).toEqual([]);
    expect(h.ir.getState().history.canUndo).toBe(false);
    // A new turn, then a document is opened over it: the run is stopped.
    await h.agent.start({ prompt: "cube again", chips: [] });
    await h.ir.load(PLATE);
    await settle();
    expect(h.bridge.stops.map((s) => s.runId)).toEqual(["run-2"]);
  });

  it_("the dial is the user's setting; a shell without the ops channel runs the proposal path", async () => {
    const h = await liveHarness();
    const r = await h.commands.execute({ id: "settings.setAutonomy", args: { autonomy: "ask" } }, { source: "ui" });
    expect(r.ok && r.value).toEqual({ autonomy: "ask" });
    const plain = await makeHarness({ agent: true });
    expect(plain.services.agent.liveAvailable).toBe(false);
  });
});
