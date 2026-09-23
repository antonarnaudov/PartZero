import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@aicad/app/bridge";
import { SMALL_MODEL_BY_PROVIDER as AGENT_SMALL_MODELS } from "@aicad/agent";
import { describe, expect, it } from "vitest";
import { AgentHost, type WorkerHandle } from "../src/agent/host.js";
import { KeyResolver, KeyStore, keysFromVariables, last4, parseDotenv, sanitizedEnv, type Cipher } from "../src/agent/keys.js";
import {
  composePrompt,
  parseAnswerRequest,
  parseSetApiKey,
  parseSettingsUpdate,
  parseStartRequest,
  parseWorkerMessage,
  scrubKeyLike,
  type HostToWorker,
  type WorkerToHost,
} from "../src/agent/protocol.js";
import { AgentRunner, parseScriptFile, redact, traceToEvents } from "../src/agent/runner.js";
import { buildSettingsView, effectiveModels, profileRegistry, providersForRun, SettingsStore, SMALL_MODEL_BY_PROVIDER, type StoredSettings } from "../src/agent/settings.js";
import { dotenvKeys, transportFromEnv } from "../src/agent/setup.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "aicad-agent-test-"));
const START = { v: 1, prompt: "Make the plate 2 mm thicker", source: "part('p');", documentName: "plate", selection: [] };

/** A reversible stand-in for safeStorage that makes ciphertext obviously not the plaintext. */
function fakeCipher(options: { available?: boolean; backend?: string } = {}): Cipher {
  return {
    isEncryptionAvailable: () => options.available ?? true,
    backend: () => options.backend ?? "test keychain",
    encryptString: (s) => Buffer.from(`enc:${Buffer.from(s, "utf8").reverse().toString("base64")}`),
    decryptString: (b) => {
      const t = b.toString("utf8");
      if (!t.startsWith("enc:")) throw new Error("bad ciphertext");
      return Buffer.from(t.slice(4), "base64").reverse().toString("utf8");
    },
  };
}

describe("agent protocol: renderer requests are validated", () => {
  it("accepts a well-formed start request and drops unknown fields", () => {
    const r = parseStartRequest({ ...START, selection: [{ kind: "face", ref: "plate/cap:end", label: "plate/cap:end", description: "top", extra: 1 }], settings: { budgetUsd: 0.5 }, apiKey: "x" });
    expect(r).toEqual({ ...START, selection: [{ kind: "face", ref: "plate/cap:end", label: "plate/cap:end", description: "top" }], settings: { budgetUsd: 0.5 } });
    expect(r).not.toHaveProperty("apiKey");
  });

  it("rejects wrong versions, empty prompts, bad selections and budgets", () => {
    expect(() => parseStartRequest({ ...START, v: 2 })).toThrow(/unsupported protocol version 2/);
    expect(() => parseStartRequest({ ...START, prompt: "   " })).toThrow(/prompt is empty/);
    expect(() => parseStartRequest({ ...START, selection: [{ kind: "vertex", ref: "a", label: "a" }] })).toThrow(/selection\[0\]\.kind/);
    expect(() => parseStartRequest({ ...START, selection: Array.from({ length: 33 }, () => ({ kind: "face", ref: "a", label: "a" })) })).toThrow(/at most 32/);
    expect(() => parseStartRequest({ ...START, settings: { budgetUsd: 1000 } })).toThrow(/between 0.01 and 100/);
    expect(() => parseStartRequest("start")).toThrow(/must be an object/);
    expect(() => parseAnswerRequest({ v: 1, runId: "r 1", questionId: "q1", answers: ["a"] })).toThrow(/runId has invalid characters/);
    expect(parseAnswerRequest({ v: 1, runId: "run-1", questionId: "q1", answers: ["Up"] }).answers).toEqual(["Up"]);
  });

  it("validates keys without ever echoing them in errors", () => {
    expect(parseSetApiKey({ v: 1, provider: "openai", key: "  sk-test-abcdefgh  " })).toEqual({ v: 1, provider: "openai", key: "sk-test-abcdefgh" });
    for (const key of ["short", "sk with spaces 12345", "sk-\u0000-control-1234"]) {
      try {
        parseSetApiKey({ v: 1, provider: "openai", key });
        throw new Error("accepted");
      } catch (e) {
        expect((e as Error).message).not.toContain(key.trim());
      }
    }
    expect(() => parseSetApiKey({ v: 1, provider: "mistral", key: "abcdefghijk" })).toThrow(/provider must be one of/);
  });

  it("validates settings updates", () => {
    expect(parseSettingsUpdate({ v: 1, models: { designer: "gpt-6-sol", judge: null }, budgetUsd: 2, compatBaseUrl: "http://localhost:11434/v1/" })).toEqual({
      v: 1,
      models: { designer: "gpt-6-sol", judge: null },
      budgetUsd: 2,
      compatBaseUrl: "http://localhost:11434/v1",
    });
    expect(() => parseSettingsUpdate({ v: 1, models: { advisor: "x" } })).toThrow(/models role/);
    expect(() => parseSettingsUpdate({ v: 1, compatBaseUrl: "https://user:pw@example.com/v1" })).toThrow(/must not contain credentials/);
    expect(() => parseSettingsUpdate({ v: 1, compatBaseUrl: "file:///etc/passwd" })).toThrow(/http\(s\)/);
  });

  it("composes the selection into semantic context and parses worker messages", () => {
    const p = composePrompt("make this thicker", [
      { kind: "feature", ref: "0193-uuid", label: "plate", description: "extrude `plate` of sketch `outline`, 5 mm" },
      { kind: "face", ref: "plate/cap:end", label: "plate/cap:end", description: "the end cap of extrude `plate`" },
    ]);
    expect(p).toBe(
      [
        "make this thicker",
        "",
        "<selection>",
        'The user selected these entities in the app (resolve "this", "it", "here" against them; face and edge names are Forge provenance names):',
        "- feature `plate` — extrude `plate` of sketch `outline`, 5 mm",
        "- face `plate/cap:end` — the end cap of extrude `plate`",
        "</selection>",
      ].join("\n"),
    );
    expect(composePrompt(" hi ", [])).toBe("hi");
    expect(parseWorkerMessage({ v: 1, type: "event", event: { v: 1, runId: "r", seq: 1, t: 0, type: "note", text: "x" } })).toMatchObject({ type: "event" });
    expect(parseWorkerMessage({ v: 2, type: "ready" })).toBeNull();
    expect(parseWorkerMessage({ v: 1, type: "event", event: { runId: "r" } })).toBeNull();
    expect(scrubKeyLike("401: Incorrect API key sk-proj-abcdefghijklmnop and AIzaSyA1234567890abcdef")).toBe("401: Incorrect API key sk-pr…[redacted] and AIza…[redacted]");
  });
});

describe("API keys: encrypted store, env and .env", () => {
  it("stores only ciphertext (mode 0600) and decrypts in the main process", () => {
    const file = join(tmp(), "agent-keys.json");
    const store = new KeyStore(file, fakeCipher());
    const key = "sk-ant-api03-verysecretvalue-9f2c";
    store.set("anthropic", key);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(key);
    expect(text).not.toContain("verysecretvalue");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(text).keys.anthropic).toMatchObject({ last4: "9f2c" });
    // A fresh store (next app start) reads it back.
    const again = new KeyStore(file, fakeCipher());
    expect(again.has("anthropic")).toBe(true);
    expect(again.get("anthropic")).toBe(key);
    again.clear("anthropic");
    expect(new KeyStore(file, fakeCipher()).has("anthropic")).toBe(false);
  });

  it("refuses to store keys without real OS encryption", () => {
    const dir = tmp();
    expect(() => new KeyStore(join(dir, "a.json"), fakeCipher({ available: false })).set("openai", "sk-abcdefghijklmnop")).toThrow(/not available/);
    const linux = new KeyStore(join(dir, "b.json"), fakeCipher({ backend: "basic_text" }));
    expect(linux.secureStorage().available).toBe(false);
    expect(() => linux.set("openai", "sk-abcdefghijklmnop")).toThrow(/No OS keyring/);
    expect(existsSync(join(dir, "b.json"))).toBe(false);
  });

  it("survives a corrupted file and an undecryptable key", () => {
    const dir = tmp();
    writeFileSync(join(dir, "k.json"), "{not json");
    expect(new KeyStore(join(dir, "k.json"), fakeCipher()).has("anthropic")).toBe(false);
    writeFileSync(join(dir, "k2.json"), JSON.stringify({ v: 1, keys: { anthropic: { ciphertext: Buffer.from("garbage").toString("base64"), last4: "abcd" } } }));
    const store = new KeyStore(join(dir, "k2.json"), fakeCipher());
    const r = new KeyResolver(store, { anthropic: "sk-from-env-0000000000001111" });
    expect(r.resolve("anthropic")).toMatchObject({ source: "env", key: "sk-from-env-0000000000001111" });
  });

  it("resolves keychain → environment → .env, showing only the last 4 of long keys", () => {
    const store = new KeyStore(join(tmp(), "k.json"), fakeCipher());
    const dotenv = keysFromVariables(parseDotenv('# dev keys\nexport ANTHROPIC_API_KEY="sk-dotenv-aaaaaaaaaaaa2222"\nGEMINI_API_KEY=AIza-dotenv-bbbbbbbb3333 # comment\nOPENAI_API_KEY=\n'));
    const env = keysFromVariables({ ANTHROPIC_API_KEY: "sk-env-cccccccccccccc4444", GOOGLE_API_KEY: "short" });
    const r = new KeyResolver(store, env, dotenv);
    expect(r.status("anthropic")).toEqual({ source: "env", last4: "4444" });
    expect(r.status("google")).toEqual({ source: "env", last4: null }); // too short to show anything
    expect(r.status("openai")).toEqual({ source: null, last4: null });
    store.set("anthropic", "sk-keychain-dddddddddddd5555");
    expect(r.resolve("anthropic")).toEqual({ key: "sk-keychain-dddddddddddd5555", source: "keychain", last4: "5555" });
    expect(last4("sk-123")).toBeNull();
  });

  it("gives the agent process an environment without secrets", () => {
    const env = sanitizedEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b", GITHUB_TOKEN: "c", AWS_SECRET: "d", AICAD_BIN: "/x" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", AICAD_BIN: "/x" });
  });

  it("reads .env only in development, and only when not disabled", () => {
    const root = tmp();
    writeFileSync(join(root, ".env"), "OPENAI_API_KEY=sk-dev-eeeeeeeeeeee6666\n");
    expect(dotenvKeys({}, root, false)).toEqual({ openai: "sk-dev-eeeeeeeeeeee6666" });
    expect(dotenvKeys({}, root, true)).toEqual({});
    expect(dotenvKeys({ AICAD_AGENT_DOTENV: "off" }, root, false)).toEqual({});
    expect(transportFromEnv({ AICAD_AGENT_TRANSPORT: "scripted", AICAD_AGENT_SCRIPT: join(root, ".env") })).toEqual({ kind: "scripted", scriptPath: join(root, ".env") });
    const warnings: string[] = [];
    expect(transportFromEnv({ AICAD_AGENT_TRANSPORT: "scripted" }, (m) => warnings.push(m))).toEqual({ kind: "live" });
    expect(warnings[0]).toMatch(/AICAD_AGENT_SCRIPT/);
  });
});

describe("agent settings", () => {
  const registry = profileRegistry();
  const stored = (models: StoredSettings["models"] = {}): StoredSettings => ({ v: 1, models, budgetUsd: 1, compatBaseUrl: null });

  it("follows the designer's provider for unset roles (one key per run)", () => {
    expect(effectiveModels(stored(), registry)).toEqual({ designer: "claude-opus-5-5", spec_writer: "claude-opus-5-5", triage: "claude-haiku-4-5", judge: "claude-fable-5-1" });
    const openai = effectiveModels(stored({ designer: "gpt-6-sol" }), registry);
    expect(openai).toMatchObject({ designer: "gpt-6-sol", spec_writer: "gpt-6-sol", triage: "gpt-6-luna" });
    expect(providersForRun(openai, registry)).toEqual(["openai"]);
    expect(effectiveModels(stored({ designer: "no-such-model" }), registry).designer).toBe("claude-opus-5-5");
    expect(SMALL_MODEL_BY_PROVIDER).toEqual(AGENT_SMALL_MODELS);
  });

  it("persists updates, refuses unknown models and reports routing warnings", () => {
    const s = new SettingsStore(join(tmp(), "settings.json"));
    expect(s.get().budgetUsd).toBe(1);
    s.update({ v: 1, models: { judge: "claude-opus-5-5" }, budgetUsd: 3 }, registry);
    expect(new SettingsStore(s.file).get()).toMatchObject({ budgetUsd: 3, models: { judge: "claude-opus-5-5" } });
    expect(() => s.update({ v: 1, models: { designer: "gpt-99" } }, registry)).toThrow(/unknown model profile/);
    const store = new KeyStore(join(tmp(), "k.json"), fakeCipher());
    store.set("anthropic", "sk-ant-secret-value-123456789");
    const view = buildSettingsView(s.get(), new KeyResolver(store), "live", registry);
    expect(JSON.stringify(view)).not.toContain("secret-value");
    expect(view.providers.find((p) => p.id === "anthropic")).toMatchObject({ configured: true, source: "keychain", last4: "6789" });
    expect(view.warnings.join(" ")).toMatch(/judge/i); // judge from the designer's family
    expect(view.profiles.length).toBeGreaterThan(5);
  });
});

// ─── Host (main process) with a fake utility process ──────────────────────────────────────

class FakeWorker implements WorkerHandle {
  sent: HostToWorker[] = [];
  killed = false;
  #onMessage: ((m: unknown) => void) | null = null;
  #onExit: ((code: number) => void) | null = null;
  postMessage(m: HostToWorker): void {
    this.sent.push(m);
  }
  kill(): void {
    this.killed = true;
  }
  onMessage(l: (m: unknown) => void): void {
    this.#onMessage = l;
  }
  onExit(l: (code: number) => void): void {
    this.#onExit = l;
  }
  reply(m: WorkerToHost): void {
    this.#onMessage?.(m);
  }
  exit(code: number): void {
    this.#onExit?.(code);
  }
}

function host(options: { keys?: Record<string, string>; transport?: "live" | "scripted"; stopGraceMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const events: AgentEvent[] = [];
  const store = new KeyStore(join(tmp(), "k.json"), fakeCipher());
  const h = new AgentHost({
    spawnWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    keys: new KeyResolver(store, options.keys ?? {}),
    settings: new SettingsStore(join(tmp(), "s.json")),
    transport: options.transport === "scripted" ? { kind: "scripted", scriptPath: "/x.json" } : { kind: "live" },
    forgeBin: "/bin/aicad",
    send: (e) => events.push(e),
    stopGraceMs: options.stopGraceMs ?? 50,
    newRunId: () => `run-${workers.length}-${events.length}`,
  });
  return { h, workers, events, store };
}

describe("agent host (main process)", () => {
  it("refuses a live run without keys, naming the provider, roles and env var", () => {
    const { h, workers } = host();
    const r = h.start(START);
    expect(r).toEqual({
      ok: false,
      code: "NO_API_KEY",
      message: "No API key for Anthropic (designer: Claude Opus 5.5, spec_writer: Claude Opus 5.5, triage: Claude Haiku 4.5) — add it in Settings or set ANTHROPIC_API_KEY.",
    });
    expect(workers).toHaveLength(0);
    expect(h.start({ ...START, v: 9 })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("starts a run with only the keys it needs, forwards events, answers and stops", () => {
    const { h, workers, events } = host({ keys: { anthropic: "sk-ant-aaaaaaaaaaaaaaaa1111", openai: "sk-openai-bbbbbbbbbbbb2222" } });
    const r = h.start(START);
    expect(r).toMatchObject({ ok: true });
    const runId = (r as { runId: string }).runId;
    const start = workers[0]!.sent[0] as Extract<HostToWorker, { type: "start" }>;
    expect(start).toMatchObject({ type: "start", runId, request: START, config: { budgetUsd: 1, models: { designer: "claude-opus-5-5" }, forgeBin: "/bin/aicad" } });
    expect(start.secrets).toEqual({ anthropic: "sk-ant-aaaaaaaaaaaaaaaa1111" }); // not the OpenAI key
    expect(h.start(START)).toMatchObject({ ok: false, code: "BUSY" });

    workers[0]!.reply({ type: "event", v: 1, event: { v: 1, runId, seq: 1, t: 5, type: "phase", phase: "TRIAGE", detail: "" } });
    workers[0]!.reply({ type: "event", v: 1, event: { v: 1, runId: "other", seq: 1, t: 5, type: "note", text: "stray" } });
    expect(events.map((e) => e.type)).toEqual(["phase"]);
    expect(h.answer({ v: 1, runId, questionId: "q1", answers: ["Up"] })).toEqual({ ok: true });
    expect(workers[0]!.sent[1]).toEqual({ type: "answer", v: 1, runId, questionId: "q1", answers: ["Up"] });
    expect(h.stop({ v: 1, runId })).toEqual({ ok: true });
    expect(workers[0]!.sent[2]).toEqual({ type: "stop", v: 1, runId });
    workers[0]!.reply({ type: "event", v: 1, event: { v: 1, runId, seq: 2, t: 9, type: "result", result: {} as never } });
    expect(h.activeRunId).toBeNull();
    // The worker is reused for the next run.
    expect(h.start(START)).toMatchObject({ ok: true });
    expect(workers).toHaveLength(1);
  });

  it("reports a crashed agent process as a terminal error event and forks a new one next time", () => {
    const { h, workers, events } = host({ transport: "scripted" });
    const r = h.start(START) as { ok: true; runId: string };
    expect((workers[0]!.sent[0] as { secrets: object }).secrets).toEqual({}); // scripted: no keys needed or sent
    workers[0]!.reply({ type: "event", v: 1, event: { v: 1, runId: r.runId, seq: 4, t: 5, type: "note", text: "…" } });
    workers[0]!.exit(134);
    expect(events.at(-1)).toMatchObject({ runId: r.runId, seq: 5, type: "error", code: "WORKER_EXITED" });
    expect(h.activeRunId).toBeNull();
    expect(h.start(START)).toMatchObject({ ok: true });
    expect(workers).toHaveLength(2);
  });

  it("kills a process that does not wind down after Stop", async () => {
    const { h, workers, events } = host({ transport: "scripted", stopGraceMs: 20 });
    const r = h.start(START) as { ok: true; runId: string };
    h.stop({ v: 1, runId: r.runId });
    await new Promise((res) => setTimeout(res, 60));
    expect(workers[0]!.killed).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "STOP_TIMEOUT" });
    expect(h.activeRunId).toBeNull();
  });
});

// ─── Runner (agent utility process) with the scripted transport ───────────────────────────

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const NEMA = readFileSync(join(repo, "corpus", "makerbench", "t1-nema17-plate.cad.ts"), "utf8");
const SCRIPT = join(repo, "packages", "desktop", "e2e", "fixtures", "nema17-thicker.script.json");
const wasm = join(repo, "packages", "forge-web", "pkg", "forge_wasm_bg.wasm");

function runner() {
  const events: AgentEvent[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const listeners: Array<(e: AgentEvent) => void> = [];
  const r = new AgentRunner({
    post: (m) => {
      if (m.type !== "event") return;
      events.push(m.event);
      for (const l of listeners) l(m.event);
      if (m.event.type === "result" || m.event.type === "error") resolveDone();
    },
  });
  const waitFor = (type: AgentEvent["type"]): Promise<AgentEvent> =>
    new Promise((res) => {
      const hit = events.find((e) => e.type === type);
      if (hit) return res(hit);
      listeners.push((e) => e.type === type && res(e));
    });
  return { r, events, done, waitFor };
}

const startMsg = (runId: string): Extract<HostToWorker, { type: "start" }> => ({
  type: "start",
  v: 1,
  runId,
  request: { v: 1, prompt: "Make the plate 2 mm thicker", source: NEMA, documentName: "t1-nema17-plate", selection: [{ kind: "face", ref: "plate/cap:end", label: "plate/cap:end" }] },
  config: {
    models: { designer: "claude-opus-5-5", spec_writer: "claude-opus-5-5", triage: "claude-haiku-4-5", judge: "claude-fable-5-1" },
    budgetUsd: 1,
    compatBaseUrl: null,
    transport: { kind: "scripted", scriptPath: SCRIPT },
    forgeBin: "/nonexistent/aicad",
  },
  secrets: {},
});

describe("agent runner (utility process logic)", () => {
  it("parses script files and maps trace events", () => {
    const { scripts, paceMs } = parseScriptFile(readFileSync(SCRIPT, "utf8"));
    expect(paceMs).toBe(120);
    expect(scripts.designer).toHaveLength(3);
    expect(() => parseScriptFile('{"designer": 3}')).toThrow(/array of turns/);
    expect(traceToEvents({ t: 1, state: "BUILD", type: "tool", text: "apply_cadscript ok: apply #1: OK" })).toEqual([{ type: "tool", name: "apply_cadscript", ok: true, summary: "apply #1: OK" }]);
    expect(traceToEvents({ t: 1, state: "REPAIR", type: "state", text: "REPAIR: 1/2" })).toEqual([{ type: "phase", phase: "REPAIR", detail: "1/2" }]);
    expect(traceToEvents({ t: 1, state: "TRIAGE", type: "llm", text: "triage claude-haiku-4-5 $0.0012 in 400+0c out 60 tool_use → classify" })[0]).toMatchObject({ type: "llm", role: "triage", costUsd: 0.0012 });
    expect(redact({ a: ["x sk-SECRET-123456 y"], b: { c: "sk-SECRET-123456" } }, ["sk-SECRET-123456"])).toEqual({ a: ["x [redacted] y"], b: { c: "[redacted]" } });
  });

  it.skipIf(!existsSync(wasm))("runs 'make the plate 2 mm thicker' end to end: question → answer → draft → proposal", async () => {
    const { r, events, done, waitFor } = runner();
    r.handle(startMsg("run-a"));
    const q = (await waitFor("question")) as Extract<AgentEvent, { type: "question" }>;
    expect(q.questions[0]).toMatchObject({ id: "q1", default: "Up (+Z), keep the bottom face on the build plate" });
    r.handle({ type: "answer", v: 1, runId: "run-a", questionId: q.questionId, answers: [""] });
    await done;
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("started");
    expect(types).toEqual(expect.arrayContaining(["phase", "llm", "cost", "question", "answered", "tool", "draft", "result"]));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const started = events[0] as Extract<AgentEvent, { type: "started" }>;
    expect(started).toMatchObject({ transport: "scripted", budgetUsd: 1, engine: expect.stringMatching(/forge-web .*wasm, node/) });
    const draft = events.find((e) => e.type === "draft") as Extract<AgentEvent, { type: "draft" }>;
    expect(draft).toMatchObject({ applyIndex: 1, verified: true, reason: "apply" });
    expect(draft.source).toContain("distance: 7");
    const res = (events.at(-1) as Extract<AgentEvent, { type: "result" }>).result;
    expect(res).toMatchObject({ status: "proposed", stopReason: "proposed", changed: true, verified: true, baseSource: NEMA, turns: 3 });
    expect(res.proposedSource).toBe(NEMA.replace("distance: 5", "distance: 7"));
    expect(res.assumptions).toHaveLength(2);
    expect(res.costUsd).toBeGreaterThan(0);
    const phases = events.flatMap((e) => (e.type === "phase" ? [e.phase] : []));
    expect(phases).toEqual(["TRIAGE", "BUILD", "PROPOSE", "DONE"]);
    const answered = events.find((e) => e.type === "answered") as Extract<AgentEvent, { type: "answered" }>;
    expect(answered.answers).toEqual(["Up (+Z), keep the bottom face on the build plate"]);
  });

  it.skipIf(!existsSync(wasm))("Stop while waiting for an answer ends the run as cancelled with the document unchanged", async () => {
    const { r, events, done, waitFor } = runner();
    r.handle(startMsg("run-b"));
    await waitFor("question");
    r.handle({ type: "stop", v: 1, runId: "run-b" });
    await done;
    const res = (events.at(-1) as Extract<AgentEvent, { type: "result" }>).result;
    expect(res).toMatchObject({ status: "stopped", stopReason: "cancelled", changed: false, proposedSource: NEMA });
    expect(events.some((e) => e.type === "draft")).toBe(false);
  });

  it("a missing script is a terminal error, not a hang", async () => {
    const { r, events, done } = runner();
    r.handle({ ...startMsg("run-c"), config: { ...startMsg("run-c").config, transport: { kind: "scripted", scriptPath: "/nonexistent.json" } } });
    await done;
    expect(events.at(-1)).toMatchObject({ type: "error", code: "RUN_FAILED", message: expect.stringMatching(/ENOENT/) });
  });
});
