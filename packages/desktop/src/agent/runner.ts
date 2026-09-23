/**
 * The agent host logic that runs inside the agent utility process (`worker.ts` wires it to
 * `process.parentPort`). Kept free of Electron so it is unit-testable in plain Node.
 *
 * One run at a time: `start` builds an {@link LLMGateway} (live SDK transports with the keys from
 * the main process, or the offline scripted / replay transports), picks the engine, runs
 * `@aicad/agent` in interactive mode and streams {@link AgentEvent}s back:
 *
 *   trace state → `phase` · tool call → `tool` (summarized) · model call → `llm` + `cost`
 *   apply/rollback → `draft` (CadScript snapshot) · ask_user / budget checkpoint → `question`
 *   end → `result` (proposal, summary, assumptions, known issues, cost) or `error`
 *
 * Every string that leaves this module is scrubbed of the run's API keys.
 */
import { readFileSync } from "node:fs";
import type { AgentEvent, AgentEventBody, AgentModelInfo, AgentQuestion, AgentRoleId, AgentRunResult, ProviderId } from "@aicad/app/bridge";
import { Agent, ScriptedTransport, type AgentResult, type ScriptTurn, type Scripts, type TraceEvent } from "@aicad/agent";
import type { UserQuestion } from "@aicad/agent-tools";
import {
  AnthropicSdkTransport,
  GatewayError,
  GoogleSdkTransport,
  LLMGateway,
  OpenAISdkTransport,
  ReplayTransport,
  type Fixture,
  type ProviderTransport,
  type TransportCall,
} from "@aicad/llm-gateway";
import { createAgentEngine, type AgentEngine } from "./engine.js";
import { composePrompt, PROTOCOL_VERSION, type HostToWorker, type WorkerRunConfig, type WorkerToHost } from "./protocol.js";
import { routingFor } from "./settings.js";

export interface RunnerDeps {
  post(message: WorkerToHost): void;
  /** Engine factory (tests inject a fake; default: forge-web in Node → Forge CLI). */
  createEngine?(forgeBin: string): Promise<AgentEngine>;
  now?(): number;
}

// ─── Transports ────────────────────────────────────────────────────────────────────────────

/** A provider with no key: fails every call with an actionable message (the main process pre-checks, this is defence in depth). */
class MissingKeyTransport implements ProviderTransport {
  readonly #provider: string;
  constructor(provider: string) {
    this.#provider = provider;
  }
  #fail(): never {
    throw new GatewayError("auth", `No API key configured for ${this.#provider}. Add one in Settings.`);
  }
  send(): Promise<unknown> {
    this.#fail();
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<unknown> {
    this.#fail();
  }
}

/** OpenAI-compatible servers: one SDK client per base URL (the Settings override, else the profile's). */
class CompatTransport implements ProviderTransport {
  readonly #clients = new Map<string, OpenAISdkTransport>();
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string | null;
  constructor(apiKey: string | undefined, baseUrl: string | null) {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
  }
  #client(call: TransportCall): OpenAISdkTransport {
    const baseURL = this.#baseUrl ?? call.endpoint;
    if (!baseURL) throw new GatewayError("invalid_request", "No base URL for the OpenAI-compatible endpoint: set one in Settings.");
    let c = this.#clients.get(baseURL);
    if (!c) {
      c = new OpenAISdkTransport({ apiKey: this.#apiKey ?? "not-needed", baseURL }, "openai-compat");
      this.#clients.set(baseURL, c);
    }
    return c;
  }
  send(call: TransportCall): Promise<unknown> {
    return this.#client(call).send(call);
  }
  stream(call: TransportCall): AsyncIterable<unknown> {
    return this.#client(call).stream(call);
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
  });
}

/** Waits `ms` before each call (scripted demos: makes live progress visible; Stop can interrupt it). */
class PacedTransport implements ProviderTransport {
  readonly #inner: ProviderTransport;
  readonly #ms: number;
  constructor(inner: ProviderTransport, ms: number) {
    this.#inner = inner;
    this.#ms = ms;
  }
  async send(call: TransportCall): Promise<unknown> {
    await sleep(this.#ms, call.signal);
    return this.#inner.send(call);
  }
  async *stream(call: TransportCall): AsyncIterable<unknown> {
    await sleep(this.#ms, call.signal);
    yield* this.#inner.stream(call);
  }
}

/** A scripted-transport file: `{ paceMs?, triage?: ScriptTurn[], spec_writer?: …, designer?: … }` (JSON). */
export function parseScriptFile(text: string): { scripts: Scripts; paceMs: number } {
  const j = JSON.parse(text) as Record<string, unknown>;
  if (typeof j !== "object" || j === null) throw new Error("script file must be a JSON object");
  const scripts: Scripts = {};
  for (const role of ["triage", "spec_writer", "designer"] as const) {
    const turns = j[role];
    if (turns === undefined) continue;
    if (!Array.isArray(turns)) throw new Error(`script.${role} must be an array of turns`);
    scripts[role] = turns.map((t, i) => {
      if (typeof t !== "object" || t === null) throw new Error(`script.${role}[${i}] must be an object`);
      const turn = t as ScriptTurn;
      if (turn.tools !== undefined && !Array.isArray(turn.tools)) throw new Error(`script.${role}[${i}].tools must be an array`);
      return turn;
    });
  }
  const pace = j["paceMs"];
  return { scripts, paceMs: typeof pace === "number" && pace > 0 ? Math.min(pace, 10_000) : 0 };
}

interface BuiltGateway {
  gateway: LLMGateway;
  note?: string;
}

export function buildGateway(config: WorkerRunConfig, secrets: Partial<Record<ProviderId, string>>): BuiltGateway {
  const t = config.transport;
  if (t.kind === "scripted") {
    const { scripts, paceMs } = parseScriptFile(readFileSync(t.scriptPath, "utf8"));
    const scripted = new ScriptedTransport(scripts);
    return {
      gateway: new LLMGateway({ transports: { anthropic: paceMs > 0 ? new PacedTransport(scripted, paceMs) : scripted }, onRoutingWarning: () => undefined }),
      note: "scripted transport (offline): model settings are ignored, no API calls are made",
    };
  }
  if (t.kind === "replay") {
    const fixtures = JSON.parse(readFileSync(t.fixturesPath, "utf8")) as Fixture[];
    if (!Array.isArray(fixtures)) throw new Error("replay fixtures file must be a JSON array of fixtures");
    return {
      gateway: new LLMGateway({ transports: { anthropic: new ReplayTransport(fixtures, { match: "sequential" }) }, onRoutingWarning: () => undefined }),
      note: "replay transport (offline): recorded responses, no API calls are made",
    };
  }
  const k = secrets;
  return {
    gateway: new LLMGateway({
      config: { routing: routingFor(config.models) },
      transports: {
        anthropic: k.anthropic ? new AnthropicSdkTransport({ apiKey: k.anthropic }) : new MissingKeyTransport("Anthropic"),
        openai: k.openai ? new OpenAISdkTransport({ apiKey: k.openai }, "openai") : new MissingKeyTransport("OpenAI"),
        google: k.google ? new GoogleSdkTransport({ apiKey: k.google }) : new MissingKeyTransport("Google Gemini"),
        "openai-compat": new CompatTransport(k["openai-compat"], config.compatBaseUrl),
      },
      onRoutingWarning: () => undefined,
    }),
  };
}

// ─── Trace → protocol events ───────────────────────────────────────────────────────────────

/** Map an orchestrator trace event to protocol event bodies (without cost; see the run). */
export function traceToEvents(e: TraceEvent): AgentEventBody[] {
  switch (e.type) {
    case "state": {
      const i = e.text.indexOf(": ");
      return [{ type: "phase", phase: e.state, detail: i >= 0 ? e.text.slice(i + 2) : "" }];
    }
    case "tool": {
      const m = /^(\S+) (ok|ERROR): ([\s\S]*)$/.exec(e.text);
      return m ? [{ type: "tool", name: m[1]!, ok: m[2] === "ok", summary: m[3]!.slice(0, 400) }] : [{ type: "note", text: e.text.slice(0, 400) }];
    }
    case "llm": {
      const m = /^(\S+) (\S+) \$([\d.]+) ([\s\S]*)$/.exec(e.text);
      return m ? [{ type: "llm", role: m[1]!, model: m[2]!, costUsd: Number(m[3]), summary: m[4]!.slice(0, 300) }] : [{ type: "note", text: e.text.slice(0, 300) }];
    }
    case "note":
    case "stop":
      return [{ type: "note", text: e.text.slice(0, 600) }];
  }
}

/** Scrub every secret from all strings of a value (deep). */
export function redact<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  const scrub = (s: string): string => secrets.reduce((acc, k) => (k.length >= 8 ? acc.split(k).join("[redacted]") : acc), s);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export function toRunResult(r: AgentResult, baseSource: string, budgetUsd: number): AgentRunResult {
  const proposedSource = r.status === "answered" || r.cadscript === "" ? baseSource : r.cadscript;
  const passed = r.tests?.filter((t) => t.pass).length;
  const out: AgentRunResult = {
    status: r.status,
    stopReason: r.stopReason,
    message: r.message,
    baseSource,
    proposedSource,
    changed: proposedSource !== baseSource,
    verified: r.verified,
    summary: r.proposal?.summary ?? r.message,
    assumptions: r.proposal?.assumptions ?? [],
    knownIssues: r.proposal?.known_issues ?? [],
    costUsd: r.costUsd,
    budgetUsd,
    latencyMs: r.latencyMs,
    turns: r.turns,
  };
  if (r.answer !== undefined) out.answer = r.answer;
  if (r.tests && r.tests.length > 0) out.tests = { passed: passed ?? 0, total: r.tests.length };
  return out;
}

// ─── One run ───────────────────────────────────────────────────────────────────────────────

class Run {
  readonly id: string;
  readonly controller = new AbortController();
  #seq = 0;
  #questions = 0;
  #pending: { questionId: string; questions: readonly UserQuestion[]; resolve: (answers: string[]) => void } | null = null;
  readonly #t0: number;
  readonly #deps: RunnerDeps;
  readonly #secrets: string[];
  #done = false;

  constructor(id: string, deps: RunnerDeps, secrets: readonly string[]) {
    this.id = id;
    this.#deps = deps;
    this.#secrets = [...secrets];
    this.#t0 = this.#now();
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  get done(): boolean {
    return this.#done;
  }

  emit(body: AgentEventBody): void {
    if (this.#done) return;
    const event = redact({ v: PROTOCOL_VERSION, runId: this.id, seq: ++this.#seq, t: Math.round(this.#now() - this.#t0), ...body } as AgentEvent, this.#secrets);
    if (body.type === "result" || body.type === "error") this.#done = true;
    this.#deps.post({ type: "event", v: PROTOCOL_VERSION, event });
  }

  ask(kind: "clarify" | "budget", questions: readonly UserQuestion[]): Promise<string[]> {
    const questionId = `q${++this.#questions}`;
    const qs: AgentQuestion[] = questions.map((q) => ({ id: q.id, question: q.question, default: q.default, ...(q.options && q.options.length > 0 ? { options: q.options } : {}) }));
    this.emit({ type: "question", questionId, kind, questions: qs });
    return new Promise((resolve) => {
      if (this.controller.signal.aborted) return resolve(questions.map((q) => q.default));
      this.#pending = { questionId, questions, resolve };
    });
  }

  answer(questionId: string, answers: readonly string[]): boolean {
    const p = this.#pending;
    if (!p || p.questionId !== questionId) return false;
    this.#pending = null;
    const full = p.questions.map((q, i) => (answers[i]?.trim() ? answers[i]!.trim() : q.default));
    this.emit({ type: "answered", questionId, answers: full });
    p.resolve(full);
    return true;
  }

  stop(): void {
    this.controller.abort();
    const p = this.#pending;
    if (p) {
      this.#pending = null;
      p.resolve(p.questions.map((q) => q.default));
    }
  }
}

export class AgentRunner {
  readonly #deps: RunnerDeps;
  #run: Run | null = null;

  constructor(deps: RunnerDeps) {
    this.#deps = deps;
  }

  get busy(): boolean {
    return this.#run !== null && !this.#run.done;
  }

  handle(message: HostToWorker): void {
    switch (message.type) {
      case "start":
        void this.#start(message);
        return;
      case "answer":
        if (this.#run?.id === message.runId) this.#run.answer(message.questionId, message.answers);
        return;
      case "stop":
        if (this.#run?.id === message.runId) this.#run.stop();
        return;
    }
  }

  /** Resolves when the current run (if any) has finished. */
  async #start(msg: Extract<HostToWorker, { type: "start" }>): Promise<void> {
    const secretValues = Object.values(msg.secrets).filter((s): s is string => typeof s === "string" && s.length > 0);
    const run = new Run(msg.runId, this.#deps, secretValues);
    if (this.busy) {
      run.emit({ type: "error", code: "BUSY", message: "Another agent run is in progress." });
      return;
    }
    this.#run = run;
    const { request, config } = msg;
    try {
      const { gateway, note } = buildGateway(config, msg.secrets);
      const engine = await (this.#deps.createEngine ?? createAgentEngine)(config.forgeBin);
      const models: Partial<Record<AgentRoleId, AgentModelInfo>> = {};
      for (const role of ["designer", "spec_writer", "triage", "judge"] as const) {
        const id = gateway.router.resolve(role).model;
        const p = gateway.profile(id);
        models[role] = { id, name: p.displayName, provider: p.provider };
      }
      const budgetUsd = request.settings?.budgetUsd ?? config.budgetUsd;
      run.emit({ type: "started", models, budgetUsd, transport: config.transport.kind, engine: engine.label });
      if (note) run.emit({ type: "note", text: note });
      let lastCost = -1;
      const emitCost = (): void => {
        const spent = gateway.totalCostUsd;
        if (spent !== lastCost) {
          lastCost = spent;
          run.emit({ type: "cost", spentUsd: spent, budgetUsd });
        }
      };
      emitCost();
      const agent = new Agent({
        gateway,
        engine: engine.engine,
        budgetUsd,
        mode: "interactive",
        askUser: (qs) => run.ask("clarify", qs),
        signal: run.controller.signal,
        taskId: `app-${msg.runId}`,
        hooks: {
          onEvent: (e) => {
            for (const body of traceToEvents(e)) run.emit(body);
            if (e.type === "llm") emitCost();
          },
          onDraft: (d) => run.emit({ type: "draft", source: d.source, applyIndex: d.applyIndex, verified: d.verified, reason: d.reason }),
          onBudgetCheckpoint: async ({ spentUsd, capUsd }) => {
            const [a] = await run.ask("budget", [
              {
                id: "continue",
                question: `The task has spent $${spentUsd.toFixed(2)} of its $${capUsd.toFixed(2)} budget (80 %). Continue up to the cap?`,
                options: ["Continue", "Stop here"],
                default: "Stop here",
              },
            ]);
            return a === "Continue";
          },
        },
      });
      const result = await agent.run({
        prompt: composePrompt(request.prompt, request.selection),
        context: request.source.trim() ? request.source : undefined,
        name: request.documentName || "document",
        process: request.process,
      });
      emitCost();
      run.emit({ type: "result", result: toRunResult(result, request.source, budgetUsd) });
    } catch (e) {
      run.emit({ type: "error", code: e instanceof GatewayError ? `GATEWAY_${e.code.toUpperCase()}` : "RUN_FAILED", message: e instanceof Error ? e.message : String(e) });
    }
  }
}
