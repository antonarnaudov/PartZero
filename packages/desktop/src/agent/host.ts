/**
 * `AgentHost`: the main-process side of the in-app agent.
 *
 * - Validates renderer requests (`protocol.ts`), resolves settings and keys, and starts runs in the
 *   agent utility process (forked lazily, re-forked after a crash).
 * - Forwards the worker's event stream to the renderer, unchanged except for crash/timeout events it
 *   synthesizes itself.
 * - Keys: resolved here (keychain → env → `.env`) only for the providers a run needs, posted to the
 *   worker in the `start` message, and never sent anywhere else.
 */
import type { AgentAnswerRequest, AgentEvent, AgentEventBody, AgentSettingsView, AgentStartResponse, AgentStopRequest, ProviderId } from "@aicad/app/bridge";
import type { ProfileRegistry } from "@aicad/llm-gateway";
import { providerInfo, type KeyResolver } from "./keys.js";
import {
  isTerminalEvent,
  parseAnswerRequest,
  parseStartRequest,
  parseStopRequest,
  parseWorkerMessage,
  PROTOCOL_VERSION,
  ProtocolError,
  scrubKeyLike,
  type HostToWorker,
  type TransportConfig,
} from "./protocol.js";
import { buildSettingsView, effectiveModels, profileRegistry, providersForRun, type SettingsStore } from "./settings.js";

/** The utility process as the host sees it (Electron `UtilityProcess`, or a fake in tests). */
export interface WorkerHandle {
  postMessage(message: HostToWorker): void;
  kill(): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
}

export interface AgentHostDeps {
  spawnWorker(): WorkerHandle;
  keys: KeyResolver;
  settings: SettingsStore;
  transport: TransportConfig;
  forgeBin: string;
  /** Deliver an event to the renderer. */
  send(event: AgentEvent): void;
  log?(level: "info" | "warn" | "error", message: string): void;
  /** How long a stopped run may take to wind down before the process is killed (default 8 s). */
  stopGraceMs?: number;
  newRunId?(): string;
  now?(): number;
}

interface ActiveRun {
  runId: string;
  startedAt: number;
  lastSeq: number;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

let counter = 0;

export class AgentHost {
  readonly #deps: AgentHostDeps;
  readonly #registry: ProfileRegistry = profileRegistry();
  #worker: WorkerHandle | null = null;
  #run: ActiveRun | null = null;

  constructor(deps: AgentHostDeps) {
    this.#deps = deps;
  }

  get activeRunId(): string | null {
    return this.#run?.runId ?? null;
  }

  settingsView(): AgentSettingsView {
    return buildSettingsView(this.#deps.settings.get(), this.#deps.keys, this.#deps.transport.kind, this.#registry);
  }

  get registry(): ProfileRegistry {
    return this.#registry;
  }

  start(raw: unknown): AgentStartResponse {
    let request;
    try {
      request = parseStartRequest(raw);
    } catch (e) {
      return { ok: false, code: "INVALID_REQUEST", message: e instanceof ProtocolError ? e.message : "invalid request" };
    }
    if (this.#run) return { ok: false, code: "BUSY", message: "The agent is already working on a request. Stop it first." };

    const stored = this.#deps.settings.get();
    const models = effectiveModels(stored, this.#registry);
    const secrets: Partial<Record<ProviderId, string>> = {};
    if (this.#deps.transport.kind === "live") {
      const missing: string[] = [];
      const needed = providersForRun(models, this.#registry);
      for (const provider of needed) {
        const info = providerInfo(provider);
        const k = this.#deps.keys.resolve(provider);
        if (k.key) secrets[provider] = k.key;
        else if (info.keyRequired) {
          const roles = (["designer", "spec_writer", "triage"] as const).filter((r) => this.#registry.get(models[r]).provider === provider);
          missing.push(`${info.label} (${roles.map((r) => `${r}: ${this.#registry.get(models[r]).displayName}`).join(", ")}) — add it in Settings or set ${info.envVars[0]}`);
        }
      }
      if (missing.length > 0) return { ok: false, code: "NO_API_KEY", message: `No API key for ${missing.join("; ")}.` };
    }

    let worker: WorkerHandle;
    try {
      worker = this.#ensureWorker();
    } catch (e) {
      return { ok: false, code: "UNAVAILABLE", message: `Could not start the agent process: ${e instanceof Error ? e.message : String(e)}` };
    }
    const runId = this.#deps.newRunId?.() ?? `run-${Date.now().toString(36)}-${(++counter).toString(36)}`;
    this.#run = { runId, startedAt: this.#now(), lastSeq: 0, stopTimer: null };
    worker.postMessage({
      type: "start",
      v: PROTOCOL_VERSION,
      runId,
      request,
      config: {
        models,
        budgetUsd: request.settings?.budgetUsd ?? stored.budgetUsd,
        compatBaseUrl: stored.compatBaseUrl,
        transport: this.#deps.transport,
        forgeBin: this.#deps.forgeBin,
      },
      secrets,
    });
    return { ok: true, runId };
  }

  answer(raw: unknown): { ok: boolean } {
    const req: AgentAnswerRequest = parseAnswerRequest(raw);
    if (!this.#run || this.#run.runId !== req.runId || !this.#worker) return { ok: false };
    this.#worker.postMessage({ type: "answer", v: PROTOCOL_VERSION, runId: req.runId, questionId: req.questionId, answers: req.answers });
    return { ok: true };
  }

  stop(raw: unknown): { ok: boolean } {
    const req: AgentStopRequest = parseStopRequest(raw);
    return this.#stopRun(req.runId);
  }

  /** Stop whatever runs (window closed, renderer crashed, app quitting). */
  stopAll(): void {
    if (this.#run) this.#stopRun(this.#run.runId);
  }

  dispose(): void {
    const w = this.#worker;
    this.#worker = null;
    if (this.#run?.stopTimer) clearTimeout(this.#run.stopTimer);
    this.#run = null;
    w?.kill();
  }

  #stopRun(runId: string): { ok: boolean } {
    const run = this.#run;
    if (!run || run.runId !== runId || !this.#worker) return { ok: false };
    this.#worker.postMessage({ type: "stop", v: PROTOCOL_VERSION, runId });
    if (!run.stopTimer) {
      run.stopTimer = setTimeout(() => {
        if (this.#run !== run) return;
        // The run did not wind down (e.g. stuck in a long synchronous evaluation): kill the process.
        this.#emit(run, { type: "error", code: "STOP_TIMEOUT", message: "Stopped: the agent process did not wind down in time and was terminated. Your document is unchanged." });
        const w = this.#worker;
        this.#worker = null;
        w?.kill();
      }, this.#deps.stopGraceMs ?? 8000);
    }
    return { ok: true };
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #ensureWorker(): WorkerHandle {
    if (this.#worker) return this.#worker;
    const w = this.#deps.spawnWorker();
    this.#worker = w;
    w.onMessage((raw) => this.#onWorkerMessage(w, raw));
    w.onExit((code) => {
      if (this.#worker === w) this.#worker = null;
      const run = this.#run;
      if (run) this.#emit(run, { type: "error", code: "WORKER_EXITED", message: `The agent process exited unexpectedly (code ${code}). Your document is unchanged.` });
    });
    return w;
  }

  #onWorkerMessage(w: WorkerHandle, raw: unknown): void {
    if (w !== this.#worker) return;
    const m = parseWorkerMessage(raw);
    if (!m) return;
    if (m.type === "log") {
      this.#deps.log?.(m.level, scrubKeyLike(m.message));
      return;
    }
    if (m.type !== "event") return;
    const run = this.#run;
    if (!run || m.event.runId !== run.runId) return;
    run.lastSeq = Math.max(run.lastSeq, m.event.seq);
    this.#deps.send(m.event);
    if (isTerminalEvent(m.event)) this.#finish(run);
  }

  /** Emit a host-originated event (continues the run's sequence) and end the run if terminal. */
  #emit(run: ActiveRun, body: AgentEventBody): void {
    const event = { v: PROTOCOL_VERSION, runId: run.runId, seq: ++run.lastSeq, t: Math.round(this.#now() - run.startedAt), ...body } as AgentEvent;
    this.#deps.send(event);
    if (isTerminalEvent(event)) this.#finish(run);
  }

  #finish(run: ActiveRun): void {
    if (run.stopTimer) clearTimeout(run.stopTimer);
    if (this.#run === run) this.#run = null;
  }
}
