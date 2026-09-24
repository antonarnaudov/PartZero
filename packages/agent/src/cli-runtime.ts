/**
 * `CliAgentRuntime`: agent-runtime mode over a locked-down CLI agent (docs/CLI-PROVIDERS.md §3.3,
 * §8.3; ADR 0014). Node only (`@aicad/agent/cli-runtime`): it spawns processes through
 * `@aicad/llm-gateway/cli`. Browser and server builds never import this module.
 *
 * One `runPhase()` = one phase of one run, fully isolated: its own workspace, MCP broker, ticket and
 * CLI process (no `--resume` across phases). The CLI's own loop calls only our CAD tools; every call
 * reaches `spec.handleToolCall` (the orchestrator's `#execute` path) through the broker. The driver
 * enforces the stop rules on three levels (§3.3): the broker refuses calls after a stop; the turn
 * limit (the CLI's own, plus our count from the event stream); wall-clock and stall timers that kill
 * the whole process group. Every error path still yields a {@link RuntimePhaseOutcome}; `runPhase`
 * throws only for programmer errors (an unknown provider).
 *
 * Resume-style CLIs (Gemini, Codex, opencode: `multiTurn: "resume"`) continue a phase with a new
 * process on the same session. Each of those processes gets a broker and ticket of its own, opened
 * after the previous process exited, its tool calls drained and its broker disposed: a broker takes
 * one connection at a time and a bounded number in its life, and the previous shim may still be
 * connected while the next CLI starts. The phase's call limit carries over from broker to broker.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve as resolvePath, sep } from "node:path";
import { computeCostUsd, emptyUsage, type AssistantContentBlock, type CliProviderId, type Message, type ModelProfile, type PlanUsage, type StopReason, type ToolResultBlock, type Usage, type UserContentBlock } from "@aicad/llm-gateway";
import {
  binaryRefusal,
  CLI_PROVIDERS,
  cliEnvForBinary,
  createCliWorkspace,
  DEFAULT_BROKER_LIMITS,
  neutralizeAtPaths,
  restoreAtPaths,
  type BrokerLimits,
  type CliBinary,
  type CliEvent,
  type CliFailure,
  type CliInvocation,
  type CliMcpHost,
  type CliMcpSession,
  type CliProvider,
  type CliResultEvent,
  type CliRun,
  type CliWorkspace,
  type LockdownReport,
  type McpToolCall,
  type McpToolResult,
} from "@aicad/llm-gateway/cli";
import { CLI_QUESTION_WAIT_MS, RUNTIME_VERIFIED_PROVIDERS, runtimeAppendix, type AgentRuntime, type RuntimeCallControl, type RuntimeEndedBy, type RuntimePhase, type RuntimePhaseOutcome, type RuntimePhaseSpec, type RuntimeTurnRecord } from "./runtime.js";

export interface CliAgentRuntimeOptions {
  /** Default `CLI_PROVIDERS`. */
  providers?: ReadonlyMap<CliProviderId, CliProvider>;
  /** The host's detection cache (re-stat happens before every spawn). */
  binary(provider: CliProviderId): Promise<CliBinary>;
  /** Host base environment for `cliChildEnv` (allowlisted again per CLI). */
  env(): Readonly<Record<string, string>>;
  /** `createMcpHost({ shim })` from `@aicad/mcp-server` (the desktop app builds its own shim). */
  mcpHost: CliMcpHost;
  workspaceRoot?: string;
  /** Debugging only: keep workspaces (they never contain the ticket). */
  keepWorkspaces?: boolean;
  clock?: () => number;
  /** (additive) Broker grace after a close before the process group is killed. Default 5 s. */
  closeGraceMs?: number;
  /** (additive) Broker limits for every phase (tests, hosts with tighter limits). */
  brokerLimits?: Partial<BrokerLimits>;
  /** (additive) Every raw stdout line of every phase (fixture recording). Untrusted data. */
  onStdoutLine?(line: string): void;
  /**
   * (additive) The CLIs this runtime drives in agent-runtime mode. Default {@link RUNTIME_VERIFIED_PROVIDERS}: the
   * CLIs whose real runtime streams are recorded and replayed through this driver in the tests. The others run in
   * completion mode (`cliMode: "auto"`) until their fixtures exist; list them here to opt in (fixture recording).
   */
  runtimeProviders?: readonly CliProviderId[];
}

export { RUNTIME_VERIFIED_PROVIDERS };

/** How long `runPhase` waits for tool handlers still running after the CLI ended (e.g. a slow engine call). */
const HANDLER_DRAIN_MS = 30_000;
const MAX_WARNINGS = 20;
const DEFAULT_CLOSE_GRACE_MS = 5_000;
/** macOS `sun_path` limit; Claude falls back to /tmp when its messaging socket path is longer. */
const MAX_SOCKET_PATH_BYTES = 103;
/**
 * Output-token estimate for a turn from what it emitted (text, tool names and inputs). Claude's stream-json
 * carries only the message_start usage snapshot (1–4 output tokens); thinking is not in the stream at all. Three
 * characters per token is on the high side for prose and about right for code and JSON (the gate must not be late).
 */
const CHARS_PER_OUTPUT_TOKEN = 3;
/** While the user is being waited for, the wall clock is kept this far ahead of the wait, re-extended every tick. */
const WALL_HOLD_LEAD_MS = 1_000;
const WALL_HOLD_TICK_MS = 250;

export class CliAgentRuntime implements AgentRuntime {
  readonly kind = "cli" as const;
  readonly #o: CliAgentRuntimeOptions;
  readonly #providers: ReadonlyMap<CliProviderId, CliProvider>;
  readonly #enabled: ReadonlySet<CliProviderId>;

  constructor(options: CliAgentRuntimeOptions) {
    this.#o = options;
    this.#providers = options.providers ?? CLI_PROVIDERS;
    this.#enabled = new Set(options.runtimeProviders ?? RUNTIME_VERIFIED_PROVIDERS);
  }

  /** Runtime mode is possible for this profile: the profile and the provider both list it, and the CLI is enabled here (lockdown is checked at start). */
  supports(profile: ModelProfile, phase: RuntimePhase): boolean {
    return this.unsupportedReason(profile, phase) === undefined;
  }

  unsupportedReason(profile: ModelProfile, _phase: RuntimePhase): string | undefined {
    if (profile.cli === undefined || !profile.cli.modes.includes("runtime")) return `${profile.id} does not support runtime mode`;
    const id = profile.provider as CliProviderId;
    const provider = this.#providers.get(id);
    if (provider === undefined || !provider.capabilities.modes.includes("runtime")) return `the ${id} provider has no runtime mode`;
    if (!this.#enabled.has(id)) return `runtime mode for ${provider.label} is not verified yet (no recorded runtime session); use completion mode`;
    return undefined;
  }

  async runPhase(spec: RuntimePhaseSpec): Promise<RuntimePhaseOutcome> {
    const provider = this.#providers.get(spec.profile.provider as CliProviderId);
    if (provider === undefined || spec.profile.cli === undefined) throw new Error(`CliAgentRuntime: ${spec.profile.id} is not a CLI profile this runtime knows`);
    return new PhaseDriver(this.#o, provider, spec).run();
  }
}

type Item = { kind: "user"; text: string } | { kind: "assistant"; blocks: AssistantContentBlock[]; calls: Array<{ id: string; name: string }> };
type BrokerLog = ReturnType<CliMcpSession["log"]>;

/** Accounting of one CLI process: per-turn estimates, then the CLI's own totals once a `result` reports them. */
interface ProcessTally {
  turns: number;
  turnUsage: Usage;
  sawTurnUsage: boolean;
  /** Sum of the per-turn estimates. */
  turnCost: number;
  /** Corrections already reported through `onCostCorrection`. */
  corrected: number;
  /** Cumulative for the process (the last result's value). */
  resultUsage: Usage | null;
  resultCost: number | null;
}

function newTally(): ProcessTally {
  return { turns: 0, turnUsage: emptyUsage(), sawTurnUsage: false, turnCost: 0, corrected: 0, resultUsage: null, resultCost: null };
}

/** One phase: workspace → broker → CLI process(es) → outcome. */
class PhaseDriver {
  readonly #o: CliAgentRuntimeOptions;
  readonly #provider: CliProvider;
  readonly #spec: RuntimePhaseSpec;
  readonly #now: () => number;
  readonly #gemini: boolean;

  #version = "unknown";
  #lockdown: LockdownReport["level"] = "none";
  #binary: CliBinary | null = null;
  #tools: RuntimePhaseSpec["tools"] = [];
  #session: CliMcpSession | null = null;
  /** Bumped when a broker is replaced: callbacks of a disposed broker are ignored. */
  #generation = 0;
  /** Logs of the brokers already disposed (resume-style CLIs: one broker per process). */
  readonly #logs: BrokerLog[] = [];
  #workspace: CliWorkspace | null = null;
  #run: CliRun | null = null;
  #processes = 0;
  #endedBy: RuntimeEndedBy | null = null;
  #closeReason: string | null = null;
  #failure: CliFailure | null = null;
  #grace: ReturnType<typeof setTimeout> | null = null;
  #t0 = 0;
  #userWaitMs = 0;
  readonly #inFlight = new Set<Promise<unknown>>();

  #turns = 0;
  #toolCalls = 0;
  #turnCalls: string[] = [];
  /** Characters the current turn emitted (text, tool names and inputs): its output-token estimate. */
  #turnChars = 0;
  #lastTurnAt = 0;
  #lastStop: StopReason | null = null;
  #proc: ProcessTally = newTally();
  /** Settled per process: the CLI's totals where it reported them, else the per-turn estimates. */
  readonly #usage: Usage = emptyUsage();
  #sawUsage = false;
  #costUsd = 0;
  #costCounted = false;
  #costAllProvider = true;
  /** Sum of the per-turn estimates of the whole phase (what the trace's per-turn records add up to). */
  #estimate = 0;
  #sessionId: string | null = null;
  readonly #models = new Set<string>();
  #plan: PlanUsage | null = null;
  readonly #warnings: string[] = [];
  #finalText = "";

  readonly #items: Item[] = [];
  #blocks: AssistantContentBlock[] = [];
  #calls: Array<{ id: string; name: string }> = [];
  readonly #echo = new Map<string, { text: string; isError: boolean }>();

  constructor(options: CliAgentRuntimeOptions, provider: CliProvider, spec: RuntimePhaseSpec) {
    this.#o = options;
    this.#provider = provider;
    this.#spec = spec;
    this.#now = options.clock ?? Date.now;
    this.#gemini = provider.agent === "gemini";
  }

  async run(): Promise<RuntimePhaseOutcome> {
    const spec = this.#spec;
    this.#t0 = this.#now();
    this.#lastTurnAt = this.#t0;
    this.#items.push({ kind: "user", text: spec.prompt });
    let inv: CliInvocation | null = null;
    try {
      if (spec.signal?.aborted === true) return this.#early("cancelled", { code: "cancelled", message: "cancelled before start" });
      let binary: CliBinary;
      try {
        binary = await this.#o.binary(this.#provider.id);
      } catch (e) {
        return this.#early("cli_error", { code: "not_installed", message: `${this.#provider.label} is not available: ${(e as Error).message}` });
      }
      this.#binary = binary;
      this.#version = binary.version;
      // Same refusal as the transport: wrong provider, changed binary, version, lockdown not enforceable (§5.5).
      const refused = binaryRefusal(this.#provider, binary);
      if (refused !== null) return this.#early("cli_error", refused);
      this.#lockdown = this.#provider.lockdown(binary).level;

      this.#workspace = await createCliWorkspace({
        runId: randomUUID(),
        ...(this.#o.workspaceRoot === undefined ? {} : { root: this.#o.workspaceRoot }),
        ...(this.#o.keepWorkspaces === true ? { keep: true } : {}),
        ...(this.#gemini ? { basename: "aicad-run" } : {}),
      });
      this.#tools = this.#scopeTools();
      try {
        this.#session = await this.#o.mcpHost.open(this.#openRequest());
      } catch (e) {
        return this.#early("cli_error", { code: "crashed", message: `the CAD MCP broker could not be started: ${(e as Error).message}` });
      }
      const cli = spec.profile.cli!;
      const effort = spec.choice.effort === undefined ? null : (cli.effortArg?.[spec.choice.effort] ?? null);
      const example = this.#tools.find((t) => t.name === "apply_cadscript")?.name ?? this.#tools[0]?.name ?? "apply_cadscript";
      inv = {
        runId: randomUUID(),
        mode: "runtime",
        binary,
        workspace: this.#workspace,
        model: cli.modelArg,
        effort,
        systemPrompt: `${spec.system}\n\n${runtimeAppendix((t) => this.#provider.qualifiedToolName(t), example)}`,
        prompt: this.#promptText(spec.prompt),
        images: [],
        structured: null,
        mcp: this.#session.attachment,
        resume: null,
        limits: { ...spec.limits },
        env: this.#cliEnv(this.#session),
      };
      let next: CliInvocation | null = inv;
      while (next !== null) {
        inv = next;
        next = await this.#process(next);
      }
    } finally {
      if (this.#grace !== null) clearTimeout(this.#grace);
      await this.#drain();
      if (inv !== null && this.#provider.cleanup !== undefined) await this.#provider.cleanup(inv, this.#sessionId).catch(() => undefined);
      if (this.#session !== null) {
        this.#logs.push(this.#session.log());
        await this.#session.dispose().catch(() => undefined);
      }
      await this.#workspace?.dispose().catch(() => undefined);
    }
    return this.#outcome();
  }

  // ── Setup ──

  /** The scope's tools; `ask_user` leaves the design scope when the CLI's MCP call timeout cannot hold the question wait (§3.3). */
  #scopeTools(): RuntimePhaseSpec["tools"] {
    const spec = this.#spec;
    if (spec.scope !== "design") return spec.tools;
    if (this.#provider.capabilities.maxToolCallMs > CLI_QUESTION_WAIT_MS + 30_000) return spec.tools;
    if (!spec.tools.some((t) => t.name === "ask_user")) return spec.tools;
    this.#warn(`ask_user is not offered: ${this.#provider.label}'s MCP call timeout is shorter than the question wait`);
    return spec.tools.filter((t) => t.name !== "ask_user");
  }

  /** A broker for the current process. `extra` narrows the limits (the calls left in the phase). */
  #openRequest(extra: Partial<BrokerLimits> = {}): Parameters<CliMcpHost["open"]>[0] {
    const spec = this.#spec;
    const generation = this.#generation;
    const current = (): boolean => generation === this.#generation;
    const limits: Partial<BrokerLimits> = { ...this.#o.brokerLimits, ...(this.#o.closeGraceMs === undefined ? {} : { closeGraceMs: this.#o.closeGraceMs }), ...extra };
    // The broker passes `control` as a second argument and reads `orchTag` / `mayWaitForUser` (additive in
    // @aicad/mcp-server); the gateway's frozen CliMcpHost type does not list them, so the request is widened here.
    const request: Parameters<CliMcpHost["open"]>[0] & { orchTag?: string; mayWaitForUser?: boolean } = {
      dir: this.#workspace!.socketDir,
      scope: spec.scope,
      tools: this.#tools,
      instructions: "CAD tools for this task. They are the only tools available; results come from the real CAD engine.",
      handler: ((call: McpToolCall, control?: RuntimeCallControl) => this.#handle(call, control)) as (call: McpToolCall) => Promise<McpToolResult>,
      onClose: (reason: string) => {
        if (current()) this.#onBrokerClose(reason);
      },
      onViolation: (v: { kind: string; detail: string }) => {
        if (current()) this.#onViolation(v);
      },
      ...(Object.keys(limits).length === 0 ? {} : { limits }),
      ...(spec.orchTag === undefined ? {} : { orchTag: spec.orchTag }),
      ...(spec.mayWaitForUser === true ? { mayWaitForUser: true } : {}),
    };
    return request;
  }

  /** The CLI's environment: allowlisted host env, the workspace temp dir and this broker's ticket (never logged). */
  #cliEnv(session: CliMcpSession): Record<string, string> {
    return cliEnvForBinary(this.#binary!, this.#o.env(), this.#workspace!.tmp, { AICAD_MCP_TICKET: session.ticket, ...this.#providerEnv(this.#workspace!) });
  }

  /** Provider extras (non-secret). Claude: its own temp root (messaging socket) inside a private, short workspace dir. */
  #providerEnv(ws: CliWorkspace): Record<string, string> {
    if (this.#provider.agent !== "claude") return {};
    for (const dir of [ws.socketDir, ws.tmp]) {
      if (Buffer.byteLength(`${dir}/cc-socks/4294967295.sock`, "utf8") <= MAX_SOCKET_PATH_BYTES) return { CLAUDE_CODE_TMPDIR: dir };
    }
    return { CLAUDE_CODE_TMPDIR: ws.tmp };
  }

  #promptText(text: string): string {
    return this.#gemini ? neutralizeAtPaths(text) : text;
  }

  // ── Broker callbacks ──

  async #handle(call: McpToolCall, control?: RuntimeCallControl): Promise<McpToolResult> {
    const run = this.#run;
    run?.brokerBusy?.(true);
    const args = this.#gemini ? restoreAtPaths(call.args) : call.args;
    // §3.3: the wall clock does not count time spent waiting for the user. It is held for the whole wait (the
    // gateway checks it while the call is in flight), not extended afterwards.
    const hold = new WallHold(run);
    const wrapped: RuntimeCallControl = {
      userWait: <T>(wait: Promise<T>): Promise<T> => {
        hold.begin();
        return (control ? control.userWait(wait) : Promise.resolve(wait)).finally(() => hold.end());
      },
    };
    const p = this.#spec.handleToolCall({ seq: call.seq, name: call.name, input: args, toolUseId: call.toolUseId }, wrapped);
    this.#inFlight.add(p);
    try {
      const r = await p;
      const reported = typeof r.userWaitMs === "number" && Number.isFinite(r.userWaitMs) && r.userWaitMs > 0 ? r.userWaitMs : 0;
      this.#userWaitMs += Math.max(reported, hold.waitedMs);
      // A wait the handler measured without the control was not held in step: extend for it now.
      if (reported > hold.waitedMs) run?.extendWall?.(reported - hold.waitedMs);
      return r;
    } catch (e) {
      // A handler that throws is a host bug: stop the phase rather than let the model continue on unknown state.
      this.#warn(`the tool handler failed on ${call.name}: ${(e as Error).message}`);
      return { text: `${call.name} failed in the CAD host. The task has ended; reply with one short line.`, isError: true, close: "internal_error" };
    } finally {
      hold.release();
      this.#inFlight.delete(p);
      run?.brokerBusy?.(false);
    }
  }

  #onBrokerClose(reason: string): void {
    this.#closeReason ??= reason;
    this.#decide("closed");
    this.#armGrace();
  }

  #onViolation(v: { kind: string; detail: string }): void {
    if (v.kind === "after_close_limit") {
      this.#warn(`the CLI kept calling tools after the task ended (${v.detail})`);
      this.#kill();
      return;
    }
    this.#warn(`broker: ${v.kind}: ${v.detail}`);
  }

  // ── Process loop ──

  /** Run one CLI process; returns the next invocation when the phase continues through `resume`. */
  async #process(inv: CliInvocation): Promise<CliInvocation | null> {
    const spec = this.#spec;
    this.#processes += 1;
    const run = this.#provider.run(inv, {
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      ...(this.#o.onStdoutLine === undefined ? {} : { onStdoutLine: this.#o.onStdoutLine }),
    });
    this.#run = run;
    let resumeWith: string | null = null;
    for await (const e of run.events) {
      switch (e.type) {
        case "init":
          this.#sessionId ??= e.sessionId;
          if (e.model !== null) this.#models.add(e.model);
          break;
        case "text":
          this.#onText(e.text, e.delta);
          break;
        case "tool_call":
          this.#onToolCall(e);
          break;
        case "tool_result":
          this.#echo.set(e.callId, { text: e.text, isError: e.isError });
          break;
        case "turn":
          this.#onTurn(e);
          break;
        case "plan_usage":
          this.#onPlan(e.usage);
          break;
        case "warning":
          this.#warn(e.message);
          break;
        case "refusal":
          this.#decide("refusal");
          this.#kill();
          break;
        case "result": {
          this.#flush();
          if (e.sessionId !== null) this.#sessionId ??= e.sessionId;
          for (const m of e.models) this.#models.add(m);
          this.#onResult(e);
          const text = e.text.length > 0 ? e.text : this.#lastText();
          this.#finalText = this.#gemini ? restoreAtPaths(text) : text;
          if (!e.ok) {
            this.#failure ??= e.failure ?? { code: "unknown", message: `the CLI reported an error (${e.subtype})` };
            this.#decide(this.#failure.code === "max_turns" ? "max_turns" : "cli_error");
            this.#finish(run);
            break;
          }
          if (this.#endedBy !== null || this.#session?.state !== "open") {
            this.#finish(run);
            break;
          }
          let decision: Awaited<ReturnType<RuntimePhaseSpec["onTurnEnd"]>>;
          try {
            decision = await spec.onTurnEnd({ finalText: this.#finalText, turns: this.#turns, stopReason: resultStopReason(e) ?? this.#lastStop });
          } catch (err) {
            this.#warn(`onTurnEnd failed: ${(err as Error).message}`);
            decision = { action: "finish" };
          }
          if (this.#endedBy !== null || decision.action === "finish") {
            this.#decide("cli_end");
            this.#session?.close("finished");
            this.#finish(run);
            break;
          }
          this.#items.push({ kind: "user", text: decision.message });
          const multi = this.#provider.capabilities.multiTurn;
          if (multi === "stdin-stream") {
            try {
              run.send({ text: this.#promptText(decision.message) });
            } catch (err) {
              this.#warn(`cannot continue the CLI turn: ${(err as Error).message}`);
              this.#decide("cli_end");
              this.#finish(run);
            }
          } else if (multi === "resume" && this.#sessionId !== null) {
            resumeWith = decision.message;
          } else {
            this.#decide("cli_end");
            this.#finish(run);
          }
          break;
        }
        default:
          break;
      }
    }
    const exit = await run.done;
    this.#closeProcess();
    if (exit.failure?.code === "lockdown_violation") {
      // Security first: a violation overrides every other ending.
      this.#endedBy = "lockdown_violation";
      this.#failure = exit.failure;
      return null;
    }
    if (resumeWith !== null && this.#endedBy === null && spec.signal?.aborted !== true && exit.failure === null) {
      const next = await this.#resume(inv, resumeWith);
      if (next !== null) return next;
    }
    if (this.#endedBy === null) {
      if (spec.signal?.aborted === true || exit.reason === "cancelled") this.#endedBy = "cancelled";
      else if (exit.reason === "timeout") this.#endedBy = "timeout";
      else if (exit.reason === "stalled") this.#endedBy = "stalled";
      else if (exit.failure !== null) this.#endedBy = exit.failure.code === "max_turns" ? "max_turns" : "cli_error";
      else this.#endedBy = "cli_end";
    }
    if (this.#endedBy !== "closed" && this.#endedBy !== "cli_end") this.#failure ??= exit.failure;
    return null;
  }

  /**
   * The next process of a resume-style CLI, on the same session and workspace, with a broker of its own: the
   * previous process's tool calls finish first (one handler at a time), and its broker is disposed, so its shim
   * can neither hold the new broker's only connection slot nor use its ticket. Null ends the phase (the ending
   * is decided here).
   */
  async #resume(inv: CliInvocation, message: string): Promise<CliInvocation | null> {
    const spec = this.#spec;
    // Every process takes at least one model turn: more processes than the turn limit is a CLI that ends its turns empty.
    if (this.#processes >= Math.max(1, spec.limits.maxTurns)) {
      this.#decide("max_turns");
      return null;
    }
    if (!(await this.#drain())) {
      this.#warn("a CAD tool call was still running after the CLI process ended; the phase ends");
      this.#failure ??= { code: "crashed", message: "a CAD tool call outlived the CLI process" };
      this.#decide("cli_error");
      return null;
    }
    const prev = this.#session;
    this.#session = null;
    this.#generation += 1;
    if (prev !== null) {
      this.#logs.push(prev.log());
      await prev.dispose().catch(() => undefined);
    }
    // The call limit is the phase's: what earlier brokers answered counts against the next one.
    const used = this.#logs.reduce((n, l) => n + l.length, 0);
    const maxCalls = (this.#o.brokerLimits?.maxCalls ?? DEFAULT_BROKER_LIMITS.maxCalls) - used;
    if (maxCalls <= 0) {
      this.#closeReason ??= "call_limit";
      this.#decide("closed");
      return null;
    }
    // The resumed process runs in the SAME workspace (Gemini keys sessions by path), and the workspace refuses to
    // overwrite files: remove the previous invocation's config files first (the provider writes them again).
    await this.#clearFiles(inv);
    try {
      this.#session = await this.#o.mcpHost.open(this.#openRequest({ maxCalls }));
    } catch (e) {
      this.#failure ??= { code: "crashed", message: `the CAD MCP broker could not be started: ${(e as Error).message}` };
      this.#decide("cli_error");
      return null;
    }
    if (spec.signal?.aborted === true) return null;
    const elapsed = this.#now() - this.#t0;
    const wallMs = Math.max(1_000, spec.limits.wallMs + this.#userWaitMs - elapsed);
    return {
      ...inv,
      runId: randomUUID(),
      prompt: this.#promptText(message),
      resume: { sessionId: this.#sessionId! },
      limits: { ...inv.limits, wallMs },
      mcp: this.#session.attachment,
      env: this.#cliEnv(this.#session),
    };
  }

  async #clearFiles(inv: CliInvocation): Promise<void> {
    let files: readonly { path: string }[] = [];
    try {
      files = this.#provider.buildArgs(inv).files; // pure: the same files `run()` wrote
    } catch {
      return;
    }
    for (const f of files) {
      const target = resolvePath(inv.workspace.dir, f.path);
      if (target.startsWith(`${inv.workspace.dir}${sep}`)) await rm(target, { force: true }).catch(() => undefined);
    }
  }

  #onText(text: string, delta: boolean): void {
    this.#turnChars += text.length;
    const last = this.#blocks[this.#blocks.length - 1];
    if (delta && last !== undefined && last.type === "text") last.text += text;
    else this.#blocks.push({ type: "text", text });
  }

  #onToolCall(e: Extract<CliEvent, { type: "tool_call" }>): void {
    this.#toolCalls += 1;
    this.#turnCalls.push(e.tool);
    const input = e.input !== null && typeof e.input === "object" && !Array.isArray(e.input) ? (e.input as Record<string, unknown>) : {};
    this.#turnChars += e.tool.length + jsonLength(input);
    this.#blocks.push({ type: "tool_use", id: e.callId, name: e.tool, input: this.#gemini ? restoreAtPaths(input) : input });
    this.#calls.push({ id: e.callId, name: e.tool });
  }

  #onTurn(e: Extract<CliEvent, { type: "turn" }>): void {
    this.#flush();
    const now = this.#now();
    const visible = Math.ceil(this.#turnChars / CHARS_PER_OUTPUT_TOKEN);
    this.#turnChars = 0;
    let usage = e.usage;
    let cost = 0;
    const p = this.#proc;
    if (usage !== null) {
      // Claude's stream carries the message_start snapshot (1–4 output tokens): the estimate counts what the turn emitted.
      if (visible > usage.outputTokens) usage = { ...usage, outputTokens: visible };
      p.sawTurnUsage = true;
      accumulate(p.turnUsage, usage);
      cost = computeCostUsd(this.#spec.profile, usage);
      if (!Number.isFinite(cost) || cost < 0) cost = 0;
    }
    if (e.model !== null) this.#models.add(e.model);
    p.turns += 1;
    p.turnCost += cost;
    this.#estimate += cost;
    this.#turns += 1;
    this.#lastStop = e.stopReason;
    const record: RuntimeTurnRecord = {
      model: e.model ?? this.#spec.profile.id,
      usage,
      costUsd: cost,
      toolCalls: this.#turnCalls,
      stopReason: e.stopReason,
      latencyMs: Math.max(0, Math.round(now - this.#lastTurnAt)),
    };
    this.#turnCalls = [];
    this.#lastTurnAt = now;
    try {
      this.#spec.onModelTurn(record);
    } catch {
      // an observer must not break the phase
    }
    if (this.#turns >= this.#spec.limits.maxTurns && this.#session?.state === "open") {
      this.#decide("max_turns");
      this.#session.close("max_turns");
    }
  }

  /**
   * A `result` reports the process's totals so far: cumulative within one process (Claude's `modelUsage` and
   * `total_cost_usd` grow across the results of a stdin-stream process), so the last value wins. A result smaller
   * than the one before cannot be cumulative; it is added instead. The difference to the per-turn estimates goes to
   * the orchestrator's 80 % gate at once.
   */
  #onResult(e: CliResultEvent): void {
    const p = this.#proc;
    if (e.usage !== null) p.resultUsage = p.resultUsage === null || covers(e.usage, p.resultUsage) ? { ...e.usage } : addUsage(p.resultUsage, e.usage);
    if (e.costUsd !== null && Number.isFinite(e.costUsd) && e.costUsd >= 0) p.resultCost = p.resultCost === null || e.costUsd >= p.resultCost ? e.costUsd : p.resultCost + e.costUsd;
    const known = p.resultCost ?? (p.resultUsage === null ? null : this.#profileCost(p.resultUsage));
    if (known === null) return;
    const delta = known - (p.turnCost + p.corrected);
    if (!Number.isFinite(delta) || Math.abs(delta) < 1e-9) return;
    p.corrected += delta;
    try {
      this.#spec.onCostCorrection?.(delta);
    } catch {
      // an observer must not break the phase
    }
  }

  /** The process ended: settle its usage and cost (the CLI's totals where it reported them). */
  #closeProcess(): void {
    const p = this.#proc;
    this.#proc = newTally();
    const usage = p.resultUsage ?? (p.sawTurnUsage ? p.turnUsage : null);
    if (usage !== null) {
      accumulate(this.#usage, usage);
      this.#sawUsage = true;
    }
    if (p.turns === 0 && p.resultCost === null && p.resultUsage === null) return;
    this.#costCounted = true;
    if (p.resultCost !== null) {
      this.#costUsd += p.resultCost;
      return;
    }
    this.#costAllProvider = false;
    this.#costUsd += p.resultUsage !== null ? this.#profileCost(p.resultUsage) : p.turnCost;
  }

  #profileCost(usage: Usage): number {
    const c = computeCostUsd(this.#spec.profile, usage);
    return Number.isFinite(c) && c > 0 ? c : 0;
  }

  #onPlan(usage: PlanUsage): void {
    this.#plan = usage;
    try {
      this.#spec.onPlanUsage?.(usage);
    } catch {
      // an observer must not break the phase
    }
    if (usage.status === "rejected") {
      // §12: a live rejection ends the run with quota_exhausted and the reset time.
      const resets = usage.windows.map((w) => w.resetsAt).filter((r): r is string => r !== null).sort().at(-1);
      this.#failure ??= { code: "quota_exhausted", message: "the plan's usage limit is reached", ...(resets === undefined ? {} : { resetsAt: resets }) };
      this.#decide("cli_error");
      this.#kill();
    }
  }

  /** The text blocks of the last assistant message that has any, joined (when the result carries none). */
  #lastText(): string {
    for (let i = this.#items.length - 1; i >= 0; i--) {
      const it = this.#items[i]!;
      if (it.kind !== "assistant") continue;
      const texts = it.blocks.flatMap((b) => (b.type === "text" ? [b.text] : []));
      if (texts.length > 0 && it.calls.length === 0) return texts.join("");
      if (it.calls.length > 0) return "";
    }
    return "";
  }

  #flush(): void {
    if (this.#blocks.length === 0) return;
    this.#items.push({ kind: "assistant", blocks: this.#blocks, calls: this.#calls });
    this.#blocks = [];
    this.#calls = [];
  }

  /** The first ending wins (lockdown violations override later, in `#process`). */
  #decide(endedBy: RuntimeEndedBy): void {
    this.#endedBy ??= endedBy;
  }

  #armGrace(): void {
    if (this.#grace !== null) return;
    const ms = this.#o.closeGraceMs ?? this.#o.brokerLimits?.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.#grace = setTimeout(() => this.#kill(), ms);
    (this.#grace as { unref?: () => void }).unref?.();
  }

  /** End the CLI's input (it exits after the current turn), then kill the group once the grace has passed. */
  #finish(run: CliRun): void {
    try {
      run.closeInput();
    } catch {
      // already closed
    }
    this.#armGrace();
  }

  #kill(): void {
    const run = this.#run;
    if (run !== null) void this.#provider.cancel(run, "stop").catch(() => undefined);
  }

  #warn(message: string): void {
    if (this.#warnings.length < MAX_WARNINGS && !this.#warnings.includes(message)) this.#warnings.push(message);
  }

  /**
   * Handlers still running after the CLI ended (a slow engine call) must finish before the orchestrator reads its
   * state, or before another process may call tools. False when one is still running after `HANDLER_DRAIN_MS`.
   */
  async #drain(): Promise<boolean> {
    if (this.#inFlight.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), HANDLER_DRAIN_MS);
    });
    const all = Promise.allSettled([...this.#inFlight]).then(() => true as const);
    const settled = await Promise.race([all, bound]);
    clearTimeout(timer);
    return settled;
  }

  // ── Outcome ──

  #early(endedBy: RuntimeEndedBy, failure: CliFailure): RuntimePhaseOutcome {
    this.#endedBy = endedBy;
    this.#failure = failure;
    return this.#outcome();
  }

  #outcome(): RuntimePhaseOutcome {
    this.#flush();
    const spec = this.#spec;
    const provided = this.#costCounted && this.#costAllProvider;
    const costUsd = this.#costUsd;
    const modelsUsed = [...this.#models];
    this.#familyCheck(modelsUsed);
    const outcome: RuntimePhaseOutcome = {
      endedBy: this.#endedBy ?? "cli_end",
      closeReason: this.#closeReason,
      finalText: this.#finalText,
      turns: this.#turns,
      toolCalls: this.#toolCalls,
      usage: this.#sawUsage ? this.#usage : emptyUsage(),
      costUsd: Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0,
      costSource: provided ? "provider" : this.#costCounted ? "profile" : "none",
      billing: spec.profile.billing,
      sessionId: this.#sessionId,
      modelsUsed,
      planUsage: this.#plan,
      failure: this.#failure,
      transcript: this.#transcript(),
      cli: { provider: this.#provider.id, version: this.#version, lockdown: this.#lockdown },
    };
    if (this.#warnings.length > 0) outcome.warnings = [...this.#warnings];
    return outcome;
  }

  /** The CLI may run another model than the profile's alias (auto routing, quota fallback): say so. */
  #familyCheck(models: readonly string[]): void {
    if (models.length === 0) return;
    const key = this.#spec.profile.family.replace(/^(claude|gemini|cursor)-/, "").toLowerCase();
    if (key === "auto" || models.some((m) => m.toLowerCase().includes(key))) return;
    this.#warn(`${this.#spec.profile.id}: the CLI ran ${models.map((m) => `'${m}'`).join(", ")}, outside the profile's family '${this.#spec.profile.family}'`);
  }

  /**
   * The phase as `Message[]`: user prompt and nudges, assistant turns rebuilt from the stream, and tool
   * results from the brokers' logs (what the model actually received), matched to the calls in order.
   * Each broker numbers its own calls: the logs are ordered per broker, brokers in process order.
   */
  #transcript(): Message[] {
    const byName = new Map<string, Array<{ text: string; isError: boolean }>>();
    for (const log of this.#logs) {
      for (const entry of [...log].sort((a, b) => a.seq - b.seq)) {
        const list = byName.get(entry.name) ?? [];
        list.push({ text: entry.text, isError: entry.isError });
        byName.set(entry.name, list);
      }
    }
    const out: Message[] = [];
    const pushUser = (content: UserContentBlock[]): void => {
      const last = out[out.length - 1];
      if (last !== undefined && last.role === "user") last.content.push(...content);
      else out.push({ role: "user", content });
    };
    for (const item of this.#items) {
      if (item.kind === "user") {
        pushUser([{ type: "text", text: item.text }]);
        continue;
      }
      out.push({ role: "assistant", content: item.blocks });
      if (item.calls.length === 0) continue;
      const results: ToolResultBlock[] = item.calls.map((c) => {
        const fromBroker = byName.get(c.name)?.shift();
        const echo = this.#echo.get(c.id);
        const r = fromBroker ?? (echo ? { text: `[as reported by the CLI] ${echo.text}`, isError: echo.isError } : { text: "(no result: the call did not reach the CAD host)", isError: true });
        return { type: "tool_result", toolUseId: c.id, toolName: c.name, content: r.text, ...(r.isError ? { isError: true } : {}) };
      });
      pushUser(results);
    }
    return out;
  }
}

/**
 * Holds a CLI process's wall clock while one tool call waits for the user: the deadline is kept
 * {@link WALL_HOLD_LEAD_MS} ahead of the wait, re-extended every {@link WALL_HOLD_TICK_MS}, so the gateway's
 * ticker never sees it pass mid-answer. Overlapping waits count once. The wall grows by at most the lead
 * beyond the time actually waited. Real time: the gateway's wall clock is `Date.now`.
 */
class WallHold {
  readonly #run: CliRun | null;
  #pending = 0;
  #start = 0;
  #extended = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #waited = 0;

  constructor(run: CliRun | null) {
    this.#run = run;
  }

  /** Time spent waiting (all waits of the call). */
  get waitedMs(): number {
    return this.#waited + (this.#pending > 0 ? Date.now() - this.#start : 0);
  }

  begin(): void {
    if (this.#pending++ > 0) return;
    this.#start = Date.now();
    this.#extended = 0;
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), WALL_HOLD_TICK_MS);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  end(): void {
    if (this.#pending === 0 || --this.#pending > 0) return;
    this.#stop();
    const waited = Date.now() - this.#start;
    this.#waited += waited;
    if (waited > this.#extended) this.#extend(waited - this.#extended);
  }

  /** The call finished: a wait the handler left pending no longer holds the clock. */
  release(): void {
    if (this.#pending > 0) {
      this.#pending = 1;
      this.end();
    }
  }

  #tick(): void {
    const target = Date.now() - this.#start + WALL_HOLD_LEAD_MS;
    if (target <= this.#extended) return;
    this.#extend(target - this.#extended);
    this.#extended = target;
  }

  #extend(ms: number): void {
    try {
      this.#run?.extendWall?.(ms);
    } catch {
      // the process has ended
    }
  }

  #stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }
}

/** A later usage that is at least the earlier one in every field (a cumulative total). */
function covers(later: Usage, earlier: Usage): boolean {
  return (
    later.inputTokens >= earlier.inputTokens &&
    later.outputTokens >= earlier.outputTokens &&
    later.cacheReadTokens >= earlier.cacheReadTokens &&
    later.cacheWriteTokens >= earlier.cacheWriteTokens &&
    later.cacheWrite1hTokens >= earlier.cacheWrite1hTokens &&
    later.reasoningTokens >= earlier.reasoningTokens
  );
}

const STOP_REASONS: ReadonlySet<string> = new Set<StopReason>(["end_turn", "tool_use", "max_tokens", "refusal", "pause", "error"]);

/**
 * The stop reason a CLI's `result` carries, when its parser provides one (additive `stopReason` on the result
 * event; Claude's stream-json has the real one only there, its `assistant` events say null). Null otherwise.
 */
function resultStopReason(e: CliResultEvent): StopReason | null {
  const v = (e as CliResultEvent & { stopReason?: unknown }).stopReason;
  return typeof v === "string" && STOP_REASONS.has(v) ? (v as StopReason) : null;
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function accumulate(into: Usage, u: Usage): void {
  into.inputTokens += u.inputTokens;
  into.outputTokens += u.outputTokens;
  into.cacheReadTokens += u.cacheReadTokens;
  into.cacheWriteTokens += u.cacheWriteTokens;
  into.cacheWrite1hTokens += u.cacheWrite1hTokens;
  into.reasoningTokens += u.reasoningTokens;
}

function addUsage(a: Usage | null, b: Usage): Usage {
  const out = a === null ? emptyUsage() : { ...a };
  accumulate(out, b);
  return out;
}

// ── Host helpers ──

export interface CliBinaryResolverOptions {
  /** Settings → CLI path, per provider. */
  overrides?: Partial<Record<CliProviderId, string>>;
  env: Readonly<Record<string, string>>;
  providers?: ReadonlyMap<CliProviderId, CliProvider>;
  /** Last resort `$SHELL -ilc 'command -v …'` (desktop hosts). Default false. */
  loginShell?: boolean;
}

/**
 * A detection cache for headless hosts (the agent CLI, evals, live tests): `detect()` once per
 * provider (no model call), then the same `CliBinary` until `refresh()`. Rejects with the detection
 * detail when the CLI is not ready (not installed, unsupported version, lockdown blocked).
 */
export function cliBinaryResolver(options: CliBinaryResolverOptions): { binary(provider: CliProviderId): Promise<CliBinary>; refresh(): void } {
  const providers = options.providers ?? CLI_PROVIDERS;
  let cache = new Map<CliProviderId, Promise<CliBinary>>();
  const detect = async (id: CliProviderId): Promise<CliBinary> => {
    const provider = providers.get(id);
    if (provider === undefined) throw new Error(`unknown CLI provider ${id}`);
    const d = await provider.detect({ overridePath: options.overrides?.[id] ?? null, env: options.env, extraDirs: [], loginShell: options.loginShell === true });
    if (d.status !== "ready" || d.binary === null) throw new Error(`${provider.label}: ${d.status} (${d.detail})`);
    return d.binary;
  };
  return {
    binary(id) {
      let p = cache.get(id);
      if (p === undefined) {
        p = detect(id);
        cache.set(id, p);
        p.catch(() => cache.delete(id));
      }
      return p;
    },
    refresh() {
      cache = new Map();
    },
  };
}
