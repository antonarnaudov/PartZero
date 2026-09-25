/**
 * What an agent (the in-app agent's tools, MCP) may and may not do to the live document, on the
 * real Forge engine (ADR 0015; the owner's "the AI operates the tools, not code"):
 * - its `ack` accepts failures of its own features only: breaking one of yours is refused;
 * - the app's live op host and the headless `MemoryOpsHost` give the same answers to the same op
 *   script (its own parameters, your features, colours, the rollback marker);
 * - an agent turn's undo group holds the agent's work only, and a load closes it;
 * - every host-only route refuses agent and MCP callers (`COMMAND_HOST_ONLY`).
 */
import { IR_SCHEMA } from "@aicad/ir-types";
import { MemoryOpsHost, type IrOp, type OpsHost } from "@aicad/model-ops";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentRunResult } from "../src/agent-protocol";
import { AgentService } from "../src/agent/agent-service";
import { appOpsHost } from "../src/agent/ops-host";
import { InlineCadScriptService } from "../src/cadscript/inline-service";
import type { CommandSource } from "../src/commands/registry";
import { DocStore } from "../src/doc/doc-store";
import { forgeWebCommandEngine, type ForgeWebCommandModule, type IrCommandEngine } from "../src/doc/v1/command-engine";
import { IrDocStore, type IrDocChange } from "../src/doc/v1/ir-doc-store";
import { namesAsIds } from "../src/doc/v1/names-as-ids";
import type { EvalResult, ForgeEngine, MeshFormat } from "../src/engine/types";
import { BOX, FakeAgentBridge, FakeSettingsBridge, makeHarness, type Harness } from "./helpers";

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

/** forge-web in Node as the app's engine. */
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

/** Your plate (`t`, s1 outline, e1 slab) with your pocket (s2, e2: a 4 mm square cut 2 mm deep at x = 10). */
const POCKETED = JSON.stringify({
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
        { type: "sketch", id: "s2", name: "pocket_sketch", plane: "XY", curves: [{ kind: "rect", id: "p", center: [10, 0], w: 4, h: 4 }] },
        { type: "extrude", id: "e2", name: "pocket", sketch: "s2", distance: 2, op: "cut", targets: { kind: "body", q: { op: "bodies" } } },
      ],
    },
  ],
});

/** An agent's sketch and through-cut after the slab: they take away what the pocket cuts. */
const THROUGH_CUT: IrOp[] = [
  { op: "addFeature", after: "e1", feature: { type: "sketch", id: "s3", name: "window_sketch", plane: "XY", curves: [{ kind: "rect", id: "w", center: [10, 0], w: 10, h: 10 }] } },
  { op: "addFeature", after: "s3", feature: { type: "extrude", id: "e3", name: "window", sketch: "s3", distance: 5, op: "cut", targets: { kind: "body", q: { op: "bodies" } } } },
];

async function liveHarness(document = POCKETED): Promise<Harness & { ir: IrDocStore }> {
  const h = await makeHarness();
  const ir = new IrDocStore({ engine: () => engine });
  await ir.load(document);
  h.services.ir = ir;
  return { ...h, ir };
}

/** A harness whose document is an IR v1 model (the DocStore mirrors the IR store). */
async function v1Harness(): Promise<Harness & { ir: IrDocStore; doc: DocStore }> {
  const h = await makeHarness();
  const ir = new IrDocStore({ engine: () => engine });
  const nodeEngine = new NodeForgeEngine();
  const doc = new DocStore({ cadscript: new InlineCadScriptService(), engine: () => nodeEngine, ir, debounceMs: 0 });
  h.services.doc = doc;
  h.services.ir = ir;
  doc.load({ path: null, name: "plate", format: "ir-v1", source: POCKETED });
  await doc.idle();
  return { ...h, ir, doc };
}

describe("an agent's acknowledgement", () => {
  it_("cannot approve breaking your feature: refused through the command layer and the live op host; your Apply anyway still works", async () => {
    const h = await liveHarness();
    const before = h.ir.document;
    for (const source of ["agent", "mcp"] as const) {
      for (const ack of [undefined, ["e2"]]) {
        const r = await h.commands.execute({ id: "ir.apply", args: { ops: THROUGH_CUT, ...(ack ? { ack } : {}) } }, { source });
        expect(r.ok).toBe(false);
        if (r.ok) continue;
        expect(r.error.detail?.code).toBe("unapproved_user_change");
        expect(r.error.detail?.details?.["features"]).toEqual([{ id: "e2", name: "pocket", change: "fails", code: "BOOLEAN_NO_INTERSECTION" }]);
      }
    }
    await expect(appOpsHost(h.services, h.commands, "agent").apply(THROUGH_CUT, { ack: ["e2"] })).rejects.toMatchObject({ code: "unapproved_user_change" });
    expect(h.ir.document).toBe(before);
    // Your gesture asks "Apply anyway?", and your yes applies it.
    h.confirmAnswer.value = true;
    const yours = await h.commands.execute({ id: "ir.apply", args: { ops: THROUGH_CUT } }, { source: "palette" });
    expect(yours.ok && yours.value.newFailures?.map((f) => f.id)).toEqual(["e2"]);
  });
});

describe("the live op host and MemoryOpsHost", () => {
  /** The same op script, one transaction per step (the live agent's tool calls). */
  const SCRIPT: IrOp[][] = [
    [{ op: "addParam", name: "w", unit: "mm", value: 4 }],
    // Its own parameter: it may change it in a later transaction.
    [{ op: "setParam", name: "w", value: 6 }],
    [{ op: "addFeature", feature: { type: "sketch", id: "s4", name: "boss_sketch", plane: "XY", curves: [{ kind: "circle", id: "b", center: [-10, 0], radius: 3 }] } }],
    [{ op: "addFeature", feature: { type: "extrude", id: "e4", name: "boss", sketch: "s4", distance: "w", op: "join", targets: "all" } }],
    // Yours: refused.
    [{ op: "setParam", name: "t", value: 9 }],
    [{ op: "setField", feature: "e1", path: "/distance", value: 8 }],
    [{ op: "setAppearance", feature: "e1", color: "#ff0000" }],
    [{ op: "moveFeature", feature: "s2", after: null }],
    [{ op: "setRollback", after: "s1" }],
    [...THROUGH_CUT],
    // Its own: fine.
    [{ op: "setAppearance", feature: "e4", color: "#00aa00" }],
    [{ op: "renameParam", old: "w", new: "boss_h" }],
    [{ op: "setParam", name: "boss_h", value: 3 }],
  ];

  async function run(host: OpsHost): Promise<Array<{ outcome: string; document: string; host: unknown }>> {
    const out: Array<{ outcome: string; document: string; host: unknown }> = [];
    for (const ops of SCRIPT) {
      let outcome: string;
      try {
        const c = await host.apply(ops);
        outcome = c.changed ? "changed" : "unchanged";
      } catch (e) {
        outcome = (e as { code?: string }).code ?? "?";
      }
      out.push({ outcome, document: await host.document(), host: await host.hostState() });
    }
    return out;
  }

  it_("give the same answers to the same op script", async () => {
    const memory = await MemoryOpsHost.open({ engine, document: POCKETED, origin: "agent" });
    const h = await liveHarness();
    const live = appOpsHost(h.services, h.commands, "agent");
    const a = await run(memory);
    const b = await run(live);
    expect(a.map((x) => x.outcome)).toEqual([
      "changed",
      "changed",
      "changed",
      "changed",
      "unapproved_user_change",
      "unapproved_user_change",
      "unapproved_user_change",
      "unapproved_user_change",
      "unapproved_user_change",
      "unapproved_user_change",
      "changed",
      "changed",
      "changed",
    ]);
    expect(b.map((x) => x.outcome)).toEqual(a.map((x) => x.outcome));
    expect(b.map((x) => x.document)).toEqual(a.map((x) => x.document));
    expect(b.map((x) => x.host)).toEqual(a.map((x) => x.host));
  });

  it_("your edit of a parameter the agent added makes it yours", async () => {
    const h = await liveHarness();
    const live = appOpsHost(h.services, h.commands, "agent");
    await live.apply([{ op: "addParam", name: "w", unit: "mm", value: 4 }]);
    expect((await h.commands.execute({ id: "ir.setParam", args: { name: "w", value: 5 } }, { source: "palette" })).ok).toBe(true);
    await expect(live.apply([{ op: "setParam", name: "w", value: 6 }])).rejects.toMatchObject({ code: "unapproved_user_change" });
  });
});

describe("an agent turn's undo group", () => {
  it_("holds the agent's work only: your edit waits (IR_GROUP_OPEN), so undo never takes it back with the turn", async () => {
    const h = await liveHarness();
    const base = h.ir.document;
    const opened = await h.commands.execute({ id: "ir.openGroup", args: { label: "Agent turn" } }, { source: "agent" });
    expect(opened.ok).toBe(true);
    const token = opened.ok ? (opened.value as { token: string }).token : "";
    const agent = await h.commands.execute({ id: "ir.apply", args: { ops: [{ op: "addParam", name: "boss_h", unit: "mm", value: 3 }], group: token } }, { source: "agent" });
    expect(agent.ok).toBe(true);
    // Your edit (and host code's) during the turn is refused, not sealed into the agent's step.
    const mine = await h.commands.execute({ id: "ir.setParam", args: { name: "t", value: "7 mm" } }, { source: "palette" });
    expect(!mine.ok && mine.error.detail?.code).toBe("IR_GROUP_OPEN");
    await expect(h.ir.apply({ op: "setParam", name: "t", value: 7 })).rejects.toMatchObject({ code: "IR_GROUP_OPEN" });
    // Another agent surface cannot slip in either, nor seal or abort the turn.
    const mcp = await h.commands.execute({ id: "ir.apply", args: { ops: [{ op: "addParam", name: "x", unit: "mm", value: 1 }] } }, { source: "mcp" });
    expect(!mcp.ok && mcp.error.detail?.code).toBe("IR_GROUP_OPEN");
    const foreignSeal = await h.commands.execute({ id: "ir.abortGroup", args: {} }, { source: "mcp" });
    expect(!foreignSeal.ok && foreignSeal.error.detail?.code).toBe("COMMAND_HOST_ONLY");
    const sealed = await h.commands.execute({ id: "ir.sealGroup", args: { group: token } }, { source: "agent" });
    expect(sealed.ok && sealed.value).toEqual({ changed: true, steps: 1 });
    // Now your edit lands as its own step; undo takes it back, and then the agent turn.
    expect((await h.commands.execute({ id: "ir.setParam", args: { name: "t", value: "7 mm" } }, { source: "palette" })).ok).toBe(true);
    expect(h.ir.getState().history.undoLabel).not.toBe("Agent turn");
    expect(h.ir.undo()).toBe(true);
    expect(h.ir.getState().history.undoLabel).toBe("Agent turn");
    expect(h.ir.undo()).toBe(true);
    expect(h.ir.document).toBe(base);
  });

  it_("a user group takes your edits and host code's, not the agent's", async () => {
    const h = await liveHarness();
    await h.ir.openGroup({ label: "Edit sketch", origin: "user" });
    await h.ir.apply({ op: "setParam", name: "t", value: 6 });
    await h.ir.apply({ op: "setParam", name: "t", value: 7 }, { origin: "user" });
    await expect(h.ir.apply({ op: "addParam", name: "x", unit: "mm", value: 1 }, { origin: "agent" })).rejects.toMatchObject({ code: "IR_GROUP_OPEN" });
    expect(await h.ir.sealGroup()).toEqual({ changed: true, steps: 2 });
  });

  it_("a load while it is open closes it (group-abort), and the turn's later ops are refused, not landed on the new document", async () => {
    const h = await liveHarness();
    const events: IrDocChange["kind"][] = [];
    h.ir.onDidChange((e) => events.push(e.kind));
    const { token } = await h.ir.openGroup({ label: "Agent turn", origin: "agent" });
    await h.ir.apply({ op: "addParam", name: "boss_h", unit: "mm", value: 3 }, { origin: "agent", group: token });
    await h.ir.load(POCKETED);
    expect(events).toEqual(["group-open", "commit", "group-abort", "load"]);
    expect(h.ir.getState().group).toBeNull();
    const opened = h.ir.document;
    await expect(h.ir.apply({ op: "addParam", name: "late", unit: "mm", value: 1 }, { origin: "agent", group: token })).rejects.toMatchObject({ code: "IR_GROUP_CLOSED" });
    const late = await appOpsHost(h.services, h.commands, "agent").apply([{ op: "addParam", name: "late", unit: "mm", value: 1 }], { group: token }).catch((e: { code?: string }) => e.code);
    expect(late).toBe("IR_GROUP_CLOSED");
    await expect(h.ir.sealGroup(token)).rejects.toMatchObject({ code: "IR_GROUP_CLOSED" });
    expect(h.ir.document).toBe(opened);
    expect(h.ir.getState().history.canUndo).toBe(false);
  });
});

describe("host-only routes", () => {
  it_("refuse agent and MCP callers on every route (COMMAND_HOST_ONLY), and leave the model as it was", async () => {
    const h = await v1Harness();
    const model = h.ir.document;
    await h.ir.apply({ op: "setParam", name: "t", value: 6 }, { origin: "user" });
    const edited = h.ir.document;
    const routes: Array<{ id: string; args: Record<string, unknown> }> = [
      { id: "ir.setAuthor", args: { features: ["e1"], author: "agent" } },
      { id: "ir.replaceDocument", args: { document: model } },
      { id: "ir.apply", args: { ops: [{ op: "replaceDocument", document: model }] } },
      { id: "ir.apply", args: { ops: [{ op: "setAuthor", features: ["e1"], author: "agent" }] } },
      { id: "doc.setSource", args: { source: BOX } },
      { id: "doc.applyIr", args: { ir: { schema: IR_SCHEMA, parts: [] } } },
      { id: "ir.load", args: { document: model } },
      { id: "ir.undo", args: {} },
      { id: "edit.undo", args: {} },
      { id: "ir.redo", args: {} },
      { id: "edit.redo", args: {} },
    ];
    for (const source of ["agent", "mcp"] as const satisfies readonly CommandSource[]) {
      for (const r of routes) {
        const res = await h.commands.execute({ id: r.id, args: r.args } as never, { source });
        expect(res.ok, `${r.id} from ${source}`).toBe(false);
        if (!res.ok) expect(res.error.detail?.code, `${r.id} from ${source}`).toBe("COMMAND_HOST_ONLY");
        expect(h.ir.document, `${r.id} from ${source}`).toBe(edited);
      }
    }
    // Inside its own open group an agent may step back its own work.
    const { token } = await h.ir.openGroup({ label: "Agent turn", origin: "agent" });
    await h.ir.apply({ op: "addParam", name: "boss_h", unit: "mm", value: 3 }, { origin: "agent", group: token });
    const own = await h.commands.execute({ id: "ir.undo", args: {} }, { source: "agent" });
    expect(own.ok && own.value.undone).toBe(true);
    await h.ir.abortGroup(token);
    // You may: a code edit (View ▸ Show Code is yours to use) and undo.
    const code = await h.commands.execute({ id: "doc.setSource", args: { source: BOX } }, { source: "ui" });
    expect(code.ok).toBe(true);
    expect(h.ir.document).not.toBe(edited);
    const undo = await h.commands.execute({ id: "edit.undo", args: {} }, { source: "keyboard" });
    expect(undo.ok && undo.value.undone).toBe(true);
    expect(h.ir.document).toBe(edited);
  });
});

describe("accepting an assistant proposal on an IR v1 model", () => {
  const MARK = "const mark = sketch(XY, {\n  rim: circle({ center: [0, 0], radius: 2 }),\n});\n";
  const BASE = `${BOX}${MARK}`;
  const BOSS = "const boss_sk = sketch(XY, {\n  rim: circle({ center: [0, 0], radius: 6 }),\n});\nconst boss = extrude(boss_sk, { distance: 12 });\n";

  async function agentHarness(): Promise<{ h: Harness; bridge: FakeAgentBridge; ir: IrDocStore }> {
    const h = await makeHarness();
    const bridge = new FakeAgentBridge();
    const ir = new IrDocStore({ engine: () => engine });
    const nodeEngine = new NodeForgeEngine();
    const cadscript = new InlineCadScriptService();
    const doc = new DocStore({ cadscript, engine: () => nodeEngine, ir, debounceMs: 0 });
    h.services.doc = doc;
    h.services.ir = ir;
    h.services.agent = new AgentService({ agent: bridge, settings: new FakeSettingsBridge(), cadscript, engine: () => nodeEngine, doc, ui: h.services.ui });
    const c = await cadscript.compile(BASE);
    if (!c.ok || !c.ir) throw new Error("the base does not compile");
    doc.load({ path: null, name: "plate", format: "ir-v1", source: JSON.stringify(namesAsIds(c.ir)) });
    await doc.idle();
    return { h, bridge, ir };
  }

  async function propose(x: { h: Harness; bridge: FakeAgentBridge }, proposedSource: string): Promise<void> {
    const r = await x.h.commands.execute({ id: "agent.run", args: { prompt: "thicker" } });
    expect(r.ok).toBe(true);
    const baseSource = x.bridge.starts[0]!.source;
    const result: AgentRunResult = {
      status: "proposed",
      stopReason: "proposed",
      message: "done",
      baseSource,
      proposedSource,
      changed: true,
      verified: true,
      summary: "Thicker.",
      assumptions: [],
      knownIssues: [],
      costUsd: 0,
      budgetUsd: 1,
      latencyMs: 1,
      turns: 1,
    };
    x.bridge.emit("run-1", { type: "result", result });
    await x.h.services.agent.waitFor((s) => s.review?.status === "ready");
  }

  it_("approves only what you accepted: a change the list did not show you (a reorder of your features) is refused", async () => {
    const x = await agentHarness();
    const before = x.ir.document;
    // The proposal thickens the plate, and also moves your mark sketch to the front.
    await propose(x, BOX.replace('part("plate");\n', `part("plate");\n${MARK}`).replace("distance: 5", "distance: 7"));
    const review = x.h.services.agent.getState().review!;
    expect(review.changes.map((c) => [c.key, c.kind])).toEqual([["plate/plate", "modified"]]);
    const r = await x.h.commands.execute({ id: "agent.accept", args: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/without their approval: mark \(moved\)/);
    expect(x.ir.document).toBe(before);
  });

  it_("a partial accept approves the accepted features only, and lands as one agent step", async () => {
    const x = await agentHarness();
    await propose(x, `${BASE.replace("distance: 5", "distance: 7")}${BOSS}`);
    const review = x.h.services.agent.getState().review!;
    expect(review.changes.map((c) => c.key)).toEqual(["plate/plate", "plate/boss_sk", "plate/boss"]);
    const r = await x.h.commands.execute({ id: "agent.acceptFeatures", args: { features: ["plate"] } });
    expect(r.ok).toBe(true);
    const doc = JSON.parse(x.ir.document) as { parts: Array<{ features: Array<{ id: string; distance?: number }> }> };
    expect(doc.parts[0]!.features.map((f) => f.id)).toEqual(["outline", "plate", "mark"]);
    expect(doc.parts[0]!.features[1]!.distance).toBe(7);
    expect(x.ir.getState().history.undoLabel).toBe("Agent: thicker");
  });
});
