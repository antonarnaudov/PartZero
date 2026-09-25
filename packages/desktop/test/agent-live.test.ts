/**
 * The live operator across the desktop's processes: the protocol (the `ops` surface, the ops
 * channel both ways, the autonomy setting), the main process relaying ops only for the running run
 * and taking the dial from Settings, and the agent utility process running the scripted
 * "cube with a bore and fillets" by operating a document the test serves as the renderer would —
 * steps, plan and result events; Ask at each step undoes a step through the channel.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, AgentOpsReply, AgentOpsRequest } from "@aicad/app/bridge";
import { blankDocument, CommandEngineError, forgeWebCommandEngine, MemoryOpsHost, parseDoc, type ForgeWebCommandModule, type IrOp } from "@aicad/model-ops";
import { describe, expect, it } from "vitest";
import { AgentHost, type WorkerHandle } from "../src/agent/host.js";
import { KeyResolver, KeyStore, type Cipher } from "../src/agent/keys.js";
import { parseOpsReply, parseOpsRequest, parseSettingsUpdate, parseStartRequest, parseWorkerMessage, type HostToWorker, type WorkerToHost } from "../src/agent/protocol.js";
import { AgentRunner, RemoteOpsHost } from "../src/agent/runner.js";
import { SettingsStore } from "../src/agent/settings.js";
import { tempDirs } from "./temp-dirs.js";

const tmp = tempDirs("aicad-live-");
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(repo, "packages", "desktop", "e2e", "fixtures", "live-cube.script.json");
const wasm = join(repo, "packages", "forge-web", "pkg", "forge_wasm_bg.wasm");

const fakeCipher = (): Cipher => ({
  isEncryptionAvailable: () => true,
  backend: () => "test",
  encryptString: (s: string) => Buffer.from(s, "utf8"),
  decryptString: (b: Buffer) => b.toString("utf8"),
});

describe("live operator protocol", () => {
  it("parses the ops surface, the dial and the ops channel strictly", () => {
    expect(parseStartRequest({ v: 1, prompt: "cube", source: "", documentName: "d", selection: [], surface: "ops" }).surface).toBe("ops");
    expect(() => parseStartRequest({ v: 1, prompt: "cube", source: "", documentName: "d", selection: [], surface: "draft" })).toThrow(/surface must be one of/);
    expect(parseSettingsUpdate({ v: 1, autonomy: "ask" })).toEqual({ v: 1, autonomy: "ask" });
    expect(() => parseSettingsUpdate({ v: 1, autonomy: "yolo" })).toThrow(/autonomy/);
    expect(parseOpsRequest({ v: 1, runId: "r", id: 1, method: "apply", ops: [{ op: "addParam" }], options: { label: "x", ack: ["a", 3] } })).toEqual({ v: 1, runId: "r", id: 1, method: "apply", ops: [{ op: "addParam" }], options: { label: "x", ack: ["a"] } });
    expect(parseOpsRequest({ v: 1, runId: "r", id: 1, method: "apply", ops: [] })).toBeNull();
    expect(parseOpsRequest({ v: 1, runId: "r", id: 1, method: "eval" })).toBeNull();
    expect(parseWorkerMessage({ type: "ops", v: 1, request: { v: 1, runId: "r", id: 2, method: "document" } })).toEqual({ type: "ops", v: 1, request: { v: 1, runId: "r", id: 2, method: "document" } });
    expect(parseOpsReply({ v: 1, runId: "r", id: 2, ok: true, value: "doc" })).toEqual({ v: 1, runId: "r", id: 2, ok: true, value: "doc" });
    expect(parseOpsReply({ v: 1, runId: "r", id: 2, ok: false, error: { code: "unapproved_user_change", message: "no", details: { features: [] }, extra: 1 } })).toEqual({
      v: 1,
      runId: "r",
      id: 2,
      ok: false,
      error: { code: "unapproved_user_change", message: "no", details: { features: [] } },
    });
    expect(() => parseOpsReply({ v: 1, runId: "r", id: 0, ok: true })).toThrow(/positive integer/);
  });
});

class FakeWorker implements WorkerHandle {
  sent: HostToWorker[] = [];
  #onMessage: ((m: unknown) => void) | null = null;
  postMessage(m: HostToWorker): void {
    this.sent.push(m);
  }
  kill(): void {}
  onMessage(l: (m: unknown) => void): void {
    this.#onMessage = l;
  }
  onExit(): void {}
  reply(m: WorkerToHost): void {
    this.#onMessage?.(m);
  }
}

describe("the main process relays the live operator's ops", () => {
  it("to the renderer only for the running run, back to the worker only for it, and takes the dial from Settings", async () => {
    const workers: FakeWorker[] = [];
    const ops: AgentOpsRequest[] = [];
    const settings = new SettingsStore(join(tmp(), "s.json"));
    settings.update({ v: 1, autonomy: "ask" }, new Map() as never);
    const h = new AgentHost({
      spawnWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      keys: new KeyResolver(new KeyStore(join(tmp(), "k.json"), fakeCipher()), {}),
      settings,
      transport: { kind: "scripted", scriptPath: "/x.json" },
      forgeBin: "/bin/aicad",
      send: () => undefined,
      sendOps: (r) => ops.push(r),
      newRunId: () => "run-1",
    });
    const r = await h.start({ v: 1, prompt: "cube", source: "", documentName: "d", selection: [], surface: "ops" });
    expect(r).toEqual({ ok: true, runId: "run-1" });
    const start = workers[0]!.sent[0] as Extract<HostToWorker, { type: "start" }>;
    expect(start.config.autonomy).toBe("ask");
    expect(start.request.surface).toBe("ops");
    workers[0]!.reply({ type: "ops", v: 1, request: { v: 1, runId: "run-1", id: 1, method: "document" } });
    workers[0]!.reply({ type: "ops", v: 1, request: { v: 1, runId: "other", id: 1, method: "document" } });
    expect(ops).toEqual([{ v: 1, runId: "run-1", id: 1, method: "document" }]);
    expect(h.opsReply({ v: 1, runId: "run-1", id: 1, ok: true, value: "{}" })).toEqual({ ok: true });
    expect(workers[0]!.sent.at(-1)).toEqual({ type: "opsReply", v: 1, reply: { v: 1, runId: "run-1", id: 1, ok: true, value: "{}" } });
    expect(h.opsReply({ v: 1, runId: "run-2", id: 1, ok: true, value: "{}" })).toEqual({ ok: false });
    // A code-surface run gets no dial.
    const w = workers[0]!;
    w.reply({ type: "event", v: 1, event: { v: 1, runId: "run-1", seq: 1, t: 0, type: "error", code: "X", message: "x" } as AgentEvent });
    await h.start({ v: 1, prompt: "thicker", source: "part('p');", documentName: "d", selection: [] });
    expect((w.sent.at(-1) as Extract<HostToWorker, { type: "start" }>).config.autonomy).toBeUndefined();
  });
});

/** The renderer's side of the ops channel over an in-memory document (what `AgentService` does with the app's store). */
function serveOps(host: MemoryOpsHost, reply: (r: AgentOpsReply) => void, log: AgentOpsRequest[]): (req: AgentOpsRequest) => void {
  return (req) => {
    log.push(req);
    void (async () => {
      try {
        let value: unknown;
        if (req.method === "document") value = await host.document();
        else if (req.method === "hostState") value = await host.hostState();
        else if (req.method === "undo") value = host.undo();
        else value = await host.apply(req.ops as IrOp[], req.options ?? {});
        reply({ v: 1, runId: req.runId, id: req.id, ok: true, value });
      } catch (e) {
        const err = e instanceof CommandEngineError ? e.toJSON() : { code: "FAILED", message: String(e) };
        reply({ v: 1, runId: req.runId, id: req.id, ok: false, error: err });
      }
    })();
  };
}

async function liveRunner(answers: (e: Extract<AgentEvent, { type: "question" }>) => string[] = () => []) {
  const mod = (await import("@aicad/forge-web")) as unknown as ForgeWebCommandModule & { init(input: unknown): Promise<void> };
  await mod.init(readFileSync(wasm));
  const doc = await MemoryOpsHost.open({ engine: forgeWebCommandEngine(mod), document: blankDocument("cube"), origin: "agent" });
  const events: AgentEvent[] = [];
  const opsLog: AgentOpsRequest[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  // eslint-disable-next-line prefer-const
  let runner: AgentRunner;
  const serve = serveOps(doc, (reply) => runner.handle({ type: "opsReply", v: 1, reply }), opsLog);
  runner = new AgentRunner({
    post: (m) => {
      if (m.type === "ops") serve(m.request);
      if (m.type !== "event") return;
      events.push(m.event);
      if (m.event.type === "question") {
        const q = m.event;
        // The user answers later (over IPC), never inside the event delivery.
        setTimeout(() => runner.handle({ type: "answer", v: 1, runId: q.runId, questionId: q.questionId, answers: answers(q) }), 5);
      }
      if (m.event.type === "result" || m.event.type === "error") resolveDone();
    },
  });
  return { runner, events, done, doc, opsLog };
}

const start = (runId: string, autonomy?: "ask" | "review" | "auto"): Extract<HostToWorker, { type: "start" }> => ({
  type: "start",
  v: 1,
  runId,
  request: { v: 1, prompt: "a 40 mm cube with a 10 mm hole through the top and 2 mm fillets on the vertical edges", source: "", documentName: "cube", selection: [], surface: "ops" },
  config: {
    models: { designer: "claude-opus-5-5", spec_writer: "claude-opus-5-5", triage: "claude-haiku-4-5", judge: "claude-fable-5-1" },
    budgetUsd: 1,
    compatBaseUrl: null,
    transport: { kind: "scripted", scriptPath: SCRIPT },
    forgeBin: "/nonexistent/aicad",
    ...(autonomy ? { autonomy } : {}),
  },
  secrets: {},
});

describe("the agent process runs the live operator on the renderer's document", () => {
  it.skipIf(!existsSync(wasm))("the scripted cube: plan, five live steps with Forge checks, the result; the document is built through the channel", async () => {
    const { runner, events, done, doc, opsLog } = await liveRunner();
    runner.handle(start("run-live"));
    await done;
    expect(events[0]).toMatchObject({ type: "started", surface: "ops", autonomy: "review", transport: "scripted" });
    const outline = events.find((e) => e.type === "outline") as Extract<AgentEvent, { type: "outline" }>;
    expect(outline.steps).toHaveLength(6);
    const steps = events.flatMap((e) => (e.type === "step" ? [e.step] : []));
    expect(steps.map((s) => [s.index, s.ok, s.note])).toEqual([
      [1, true, "Add the 40 mm size parameter"],
      [2, true, "Sketch the 40 mm base square on XY"],
      [3, true, "Extrude it into a 40 mm cube"],
      [4, true, "Round the four vertical edges (2 mm)"],
      [5, true, "Drill the Ø10 bore through the top"],
    ]);
    expect(steps[4]!.check).toMatch(/^✓ 4 features ok · 1 body valid, 40×40×40 mm/);
    const result = (events.at(-1) as Extract<AgentEvent, { type: "result" }>).result;
    expect(result).toMatchObject({ status: "proposed", surface: "ops", steps: 5, changed: true, verified: true, baseSource: "", proposedSource: "" });
    expect(result.summary).toContain("Ø10 mm bore");
    expect(parseDoc(await doc.document()).parts[0]!.features.map((f) => f.id)).toEqual(["base", "cube", "rounds", "bore"]);
    // Every change went through the channel as an apply; reads as document requests.
    expect(opsLog.filter((r) => r.method === "apply")).toHaveLength(5);
    expect(opsLog.some((r) => r.method === "document")).toBe(true);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it.skipIf(!existsSync(wasm))("Ask at each step: every step waits for Keep or Undo; an Undo goes through the channel", async () => {
    let asked = 0;
    const { runner, events, done, doc, opsLog } = await liveRunner((q) => {
      if (q.kind !== "step") return [];
      asked++;
      return [q.step?.index === 3 && asked === 3 ? "Undo" : "Keep"];
    });
    runner.handle(start("run-ask", "ask"));
    await done;
    const questions = events.filter((e): e is Extract<AgentEvent, { type: "question" }> => e.type === "question");
    expect(questions[0]).toMatchObject({ kind: "step", step: { index: 1, note: "Add the 40 mm size parameter" }, questions: [{ id: "step", options: ["Keep", "Undo"], default: "Keep" }] });
    expect(opsLog.filter((r) => r.method === "undo")).toHaveLength(1);
    const undone = events.find((e) => e.type === "step" && e.step.undone === true) as Extract<AgentEvent, { type: "step" }>;
    expect(undone.step).toMatchObject({ index: 3, note: "Extrude it into a 40 mm cube" });
    // The script does not rebuild the extrude, so the later steps are refused (they need it) and the run stops or finishes without it.
    expect(parseDoc(await doc.document()).parts[0]!.features.map((f) => f.id)).not.toContain("cube");
  });

  it("RemoteOpsHost maps the channel's answers and failures to the OpsHost contract", async () => {
    const calls: string[] = [];
    const host = new RemoteOpsHost(async (method) => {
      calls.push(method);
      if (method === "document") return "{}";
      if (method === "hostState") return { rollback: null, appearance: { a: "#ffffff" } };
      if (method === "undo") return true;
      throw new CommandEngineError("unapproved_user_change", "refused", [], { features: [{ id: "e1" }] });
    }, null);
    expect(await host.document()).toBe("{}");
    expect(await host.hostState()).toEqual({ rollback: null, appearance: { a: "#ffffff" } });
    expect(await host.undo()).toBe(true);
    await expect(host.apply([{ op: "setParam", name: "x", value: 1 }])).rejects.toMatchObject({ code: "unapproved_user_change", details: { features: [{ id: "e1" }] } });
    expect(() => host.engine()).toThrow(/no Forge WASM engine/);
    expect(calls).toEqual(["document", "hostState", "undo", "apply"]);
  });
});
