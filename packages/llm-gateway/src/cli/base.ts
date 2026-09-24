import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { CliProviderId } from "../types.js";
import { commonInstallDirs, compareVersions, nodeDirFor, normalizeVersion, parseHelp, resolveBinary, type ResolvedBinary } from "./detect.js";
import { cliChildEnv, secretValues } from "./env.js";
import type { CliEvent, CliResultEvent } from "./events.js";
import { TripwireMonitor, type TripwireContext } from "./lockdown.js";
import { safeArgWord, safeModel, safeSessionId } from "./parse.js";
import { killProcessGroup, OUTPUT_LIMITS, runCommand, spawnCli, START_TIMEOUT_MS, type CliProcess, type CommandResult } from "./process.js";
import type {
  CliAgentId,
  CliAuthStatus,
  CliBinary,
  CliCapabilities,
  CliCommand,
  CliDetection,
  CliExit,
  CliFailure,
  CliInvocation,
  CliProvider,
  CliRun,
  CliRunIO,
  CliUserMessage,
  DetectOptions,
  LockdownReport,
  ParseContext,
} from "./provider.js";
import { createProbeDir } from "./workspace.js";

/** Whether a binary is a Node script (needs `node` on the child PATH). */
export function isNodeScript(realPath: string): boolean {
  if (/\.(c|m)?js$/i.test(realPath)) return true;
  try {
    const fd = openSync(realPath, "r");
    try {
      const buf = Buffer.alloc(128);
      const n = readSync(fd, buf, 0, 128, 0);
      const head = buf.subarray(0, n).toString("latin1");
      return head.startsWith("#!") && /\bnode\b/.test(head.split("\n")[0] ?? "");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** The allowlisted child environment for a binary (adds `node`'s directory for Node-script CLIs). */
export function cliEnvForBinary(
  binary: Pick<CliBinary, "path" | "realPath">,
  parent: Readonly<Record<string, string | undefined>>,
  tmpDir: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const nodeDir = isNodeScript(binary.realPath) ? nodeDirFor(binary.path, parent as Readonly<Record<string, string>>) : undefined;
  return cliChildEnv(parent, { tmpDir, binaryDir: dirname(binary.realPath), ...(nodeDir === undefined ? {} : { nodeDir }), extra });
}

/**
 * Why `binary` must not be spawned for `provider` (§5.5), or null: wrong provider, the file changed or vanished since
 * detection (CLIs update themselves), below the minimum version, or lockdown level `none` (Cursor today). Both
 * `CliTransport` and `BaseCliProvider.run()` apply it, so a host that calls `provider.run()` directly (the runtime
 * driver) cannot skip it.
 */
export function binaryRefusal(provider: Pick<CliProvider, "id" | "label" | "minVersion" | "lockdown">, binary: CliBinary): CliFailure | null {
  if (binary.provider !== provider.id) return { code: "unsupported", message: `binary is for ${binary.provider}, not ${provider.id}` };
  try {
    const st = statSync(binary.realPath);
    if (st.size !== binary.stat.size || st.mtimeMs !== binary.stat.mtimeMs) return { code: "unsupported", message: `${binary.realPath} changed since detection (the CLI updated itself); re-check the CLI` };
  } catch {
    return { code: "not_installed", message: `${binary.realPath} is gone; re-check the CLI` };
  }
  if (compareVersions(binary.version, provider.minVersion) < 0) return { code: "unsupported", message: `needs ${provider.label} >= ${provider.minVersion}, found ${binary.version}` };
  const lock = provider.lockdown(binary);
  if (!lock.ok) return { code: "unsupported", message: `lockdown cannot be enforced: ${lock.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ")}` };
  return null;
}

/** Values that reach argv must never look like flags (§5.7): model, effort and resumed session id. */
export function invocationArgProblem(inv: Pick<CliInvocation, "model" | "effort" | "resume">): string | null {
  if (inv.model !== null && safeModel(inv.model) === null) return "the model argument is not a plain model name";
  if (inv.effort !== null && safeArgWord(inv.effort) === null) return "the effort argument is not a plain word";
  if (inv.resume !== null && safeSessionId(inv.resume.sessionId) === null) return "the session id to resume is not a plain id";
  return null;
}

/** Information a provider's failure mapping sees after the process ended normally (no timer, cancel or tripwire). */
export interface ExitInfo {
  code: number | null;
  signal: string | null;
  result: CliResultEvent | null;
  stderrTail: string;
}

const UNKNOWN_OPTION = /unknown (option|argument|flag|command)|unrecognized (option|argument)|unexpected argument|Unknown arguments?:|invalid (option|choice)/i;

type KillReason = "user" | "timeout" | "stalled" | "stop" | "lockdown";

/** Buffers every event of an invocation; each iterator replays from the start, so several readers see everything. */
class EventQueue implements AsyncIterable<CliEvent> {
  readonly #items: CliEvent[] = [];
  #waiters: Array<() => void> = [];
  #ended = false;

  push(e: CliEvent): void {
    if (this.#ended) return;
    this.#items.push(e);
    for (const w of this.#waiters.splice(0)) w();
  }

  end(): void {
    this.#ended = true;
    for (const w of this.#waiters.splice(0)) w();
  }

  [Symbol.asyncIterator](): AsyncIterator<CliEvent> {
    let index = 0;
    return {
      next: async (): Promise<IteratorResult<CliEvent>> => {
        for (;;) {
          const item = this.#items[index];
          if (item !== undefined) {
            index += 1;
            return { value: item, done: false };
          }
          if (this.#ended) return { value: undefined, done: true };
          await new Promise<void>((resolve) => this.#waiters.push(resolve));
        }
      },
    };
  }
}

/** A running invocation. `events` can be iterated by several readers; each sees every event. */
class BaseRun implements CliRun {
  readonly events: AsyncIterable<CliEvent>;
  readonly done: Promise<CliExit>;
  readonly #pid: () => number | null;
  readonly #send: (m: CliUserMessage) => void;
  readonly #close: () => void;
  readonly #kill: (reason: KillReason) => Promise<void>;
  readonly #extend: (ms: number) => void;
  readonly #busy: (on: boolean) => void;

  constructor(parts: {
    pid(): number | null;
    events: AsyncIterable<CliEvent>;
    done: Promise<CliExit>;
    send(m: CliUserMessage): void;
    close(): void;
    kill(reason: KillReason): Promise<void>;
    extend(ms: number): void;
    busy?(on: boolean): void;
  }) {
    this.#pid = parts.pid;
    this.events = parts.events;
    this.done = parts.done;
    this.#send = parts.send;
    this.#close = parts.close;
    this.#kill = parts.kill;
    this.#extend = parts.extend;
    this.#busy = parts.busy ?? (() => {});
  }

  brokerBusy(on: boolean): void {
    this.#busy(on);
  }

  get pid(): number | null {
    return this.#pid();
  }

  send(message: CliUserMessage): void {
    this.#send(message);
  }

  closeInput(): void {
    this.#close();
  }

  extendWall(ms: number): void {
    this.#extend(ms);
  }

  kill(reason: KillReason): Promise<void> {
    return this.#kill(reason);
  }
}

/**
 * Shared implementation of `run`, `cancel`, `detect` and `version` (§7.5). Concrete providers implement the dialect:
 * `buildArgs`, `parseEvents`, `authStatus`, `lockdown`, `qualifiedToolName` and the failure mapping.
 */
export abstract class BaseCliProvider implements CliProvider {
  abstract readonly id: CliProviderId;
  abstract readonly agent: CliAgentId;
  abstract readonly label: string;
  abstract readonly binaryNames: readonly string[];
  abstract readonly minVersion: string;
  abstract readonly verifiedRange: { from: string; to: string } | null;
  abstract readonly capabilities: CliCapabilities;
  abstract readonly loginHint: string;

  /** Argument lists whose help output is parsed for the lockdown checks. */
  protected readonly helpCommands: ReadonlyArray<readonly string[]> = [["--help"]];
  protected readonly versionArgs: readonly string[] = ["--version"];
  /** Non-secret env for probes (auto-update off, no browser). */
  protected probeExtraEnv(): Record<string, string> {
    return {};
  }
  /** Provider-specific install dirs, added to the common ones. */
  protected installDirs(env: Readonly<Record<string, string>>): string[] {
    return commonInstallDirs(env);
  }

  abstract authStatus(binary: CliBinary, env: Readonly<Record<string, string>>): Promise<CliAuthStatus>;
  abstract lockdown(binary: CliBinary): LockdownReport;
  abstract qualifiedToolName(tool: string): string;
  abstract buildArgs(inv: CliInvocation): CliCommand;
  abstract parseEvents(lines: AsyncIterable<string>, ctx: ParseContext): AsyncIterable<CliEvent>;

  /** Failure mapping for a normal exit (§4 tables). */
  protected classifyExit(info: ExitInfo): CliFailure | null {
    if (UNKNOWN_OPTION.test(info.stderrTail)) return { code: "unsupported", message: `the CLI rejected an option: ${lastLine(info.stderrTail)}` };
    if (info.result !== null) {
      if (info.result.failure !== null) return info.result.failure;
      if (info.result.ok) return null;
      return { code: "unknown", message: `the CLI reported an error (${info.result.subtype})` };
    }
    if (info.code === 0) return { code: "bad_output", message: "the CLI exited without a result" };
    return { code: "crashed", message: `the CLI exited with ${info.code ?? info.signal} and no result${info.stderrTail ? `: ${lastLine(info.stderrTail)}` : ""}` };
  }

  /** The structured-output tool the init tool list may contain (Claude `StructuredOutput`). */
  protected structuredToolName(_inv: CliInvocation): string | null {
    return null;
  }

  /**
   * (§5.6 amendment 2) The CLI's built-in tool names, for a provider whose parser marks refused unknown-tool calls
   * (`tool_result.unavailable`). Null (the default): every out-of-scope call trips at once.
   */
  protected builtinToolNames(): ReadonlySet<string> | null {
    return null;
  }

  /** stream-json user message line for `send()` (stdin-stream providers only). */
  protected userMessageLine(_message: CliUserMessage): string {
    throw new Error(`${this.label} does not accept follow-up messages on stdin; use resume`);
  }

  /** Commands run in the workspace before the main spawn (Cursor `mcp enable cad`). */
  protected preCommands(_inv: CliInvocation): Array<readonly string[]> {
    return [];
  }

  // ---------------------------------------------------------------------------------------------- detection

  /** Probes run in a fresh private dir under the workspace root (never a shared /tmp, §5.4). */
  protected async withProbeDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = createProbeDir();
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Run a no-model probe command in an empty temp dir with the allowlisted env. */
  protected async probe(binary: Pick<CliBinary, "path" | "realPath">, env: Readonly<Record<string, string>>, args: readonly string[], options: { timeoutMs?: number; extraEnv?: Record<string, string> } = {}): Promise<CommandResult> {
    return this.withProbeDir(async (dir) => {
      const childEnv = cliEnvForBinary(binary, env, dir, { ...this.probeExtraEnv(), ...options.extraEnv });
      return runCommand(binary.realPath, args, { cwd: dir, env: childEnv, timeoutMs: options.timeoutMs ?? 10_000, maxBytes: 256 * 1024, captureDir: dir });
    });
  }

  async version(path: string, env: Readonly<Record<string, string>>): Promise<string> {
    const realPath = realpathSync(path);
    const r = await this.probe({ path, realPath }, env, this.versionArgs);
    return normalizeVersion(firstLine(r.stdout) || firstLine(r.stderr));
  }

  /** Hook after a successful detection (opencode lists the user's MCP servers here). */
  protected async afterDetect(_binary: CliBinary, _env: Readonly<Record<string, string>>): Promise<void> {}

  async detect(options: DetectOptions): Promise<CliDetection> {
    const found: ResolvedBinary | null = await resolveBinary(this.binaryNames, { ...options, extraDirs: [...options.extraDirs, ...this.installDirs(options.env)] });
    if (found === null) {
      return { provider: this.id, status: "not_installed", binary: null, lockdown: null, detail: `${this.label} was not found (looked for ${this.binaryNames.join(", ")})` };
    }
    const v = await this.probe(found, options.env, this.versionArgs);
    const rawVersion = firstLine(v.stdout) || firstLine(v.stderr);
    if (v.code !== 0 || rawVersion.length === 0 || !/\d+\.\d+/.test(rawVersion)) {
      return {
        provider: this.id,
        status: "unsupported_version",
        binary: null,
        lockdown: null,
        detail: `${found.realPath} did not report a version${v.timedOut ? " (timed out)" : ""}`,
      };
    }
    const texts: string[] = [];
    for (const args of this.helpCommands) {
      const h = await this.probe(found, options.env, args);
      texts.push(`${h.stdout}\n${h.stderr}`);
    }
    const binary: CliBinary = {
      provider: this.id,
      path: found.path,
      realPath: found.realPath,
      source: found.source,
      version: normalizeVersion(rawVersion),
      rawVersion: rawVersion.slice(0, 200),
      help: parseHelp(texts),
      stat: found.stat,
    };
    const lockdown = this.lockdown(binary);
    if (compareVersions(binary.version, this.minVersion) < 0) {
      return { provider: this.id, status: "unsupported_version", binary, lockdown, detail: `needs ${this.label} >= ${this.minVersion}, found ${binary.version}` };
    }
    if (!lockdown.ok) {
      const failed = lockdown.checks.filter((c) => !c.ok).map((c) => c.detail);
      return { provider: this.id, status: "blocked", binary, lockdown, detail: failed.join("; ") || "lockdown cannot be enforced" };
    }
    await this.afterDetect(binary, options.env);
    return {
      provider: this.id,
      status: "ready",
      binary,
      lockdown,
      detail: lockdown.level === "verified" ? `${this.label} ${binary.version} (verified)` : `${this.label} ${binary.version} (not yet verified: relies on runtime tripwires)`,
    };
  }

  // ---------------------------------------------------------------------------------------------- run

  run(inv: CliInvocation, io: CliRunIO = {}): CliRun {
    const now = io.now ?? Date.now;
    const queue = new EventQueue();
    // Defense in depth (§5.5): the same refusal as CliTransport, plus argv-safe values, before anything is written.
    const argProblem = invocationArgProblem(inv);
    const refused = binaryRefusal(this, inv.binary) ?? (argProblem === null ? null : ({ code: "unsupported", message: argProblem } satisfies CliFailure));
    if (refused !== null) {
      queue.end();
      const exit: CliExit = { code: null, signal: null, reason: "spawn_failed", result: null, stderrTail: "", failure: refused };
      return new BaseRun({ pid: () => null, events: queue, done: Promise.resolve(exit), send: () => {}, close: () => {}, kill: async () => {}, extend: () => {} });
    }
    let cmd: CliCommand;
    try {
      cmd = this.buildArgs(inv);
      for (const f of cmd.files) inv.workspace.write(f.path, f.content, f.mode, f.encoding ?? "utf8");
    } catch (e) {
      queue.end();
      const exit: CliExit = { code: null, signal: null, reason: "spawn_failed", result: null, stderrTail: "", failure: { code: "unsupported", message: `cannot prepare the invocation: ${(e as Error).message}` } };
      return new BaseRun({ pid: () => null, events: queue, done: Promise.resolve(exit), send: () => {}, close: () => {}, kill: async () => {}, extend: () => {} });
    }
    const secrets = secretValues(cmd.env);
    const spawnOptions = { secrets, ...(io.onStderrLine === undefined ? {} : { onStderrLine: io.onStderrLine }) };
    const allowed = new Set((inv.mcp?.toolNames ?? []).map((n) => this.qualifiedToolName(n)));
    const ctx: ParseContext = { mode: inv.mode, allowed, serverName: "cad" };
    const trip: TripwireContext = { allowed, structuredToolName: this.structuredToolName(inv), expectMcp: inv.mcp === null ? "none" : "cad", builtinTools: this.builtinToolNames() };
    const monitor = new TripwireMonitor(trip);
    // (additive) Notes from buildArgs (an optional flag this binary does not list), emitted before any CLI event.
    for (const message of cmd.warnings ?? []) queue.push({ type: "warning", message });

    let proc: CliProcess | null = null;
    let failure: CliFailure | null = null;
    let reason: CliExit["reason"] = "exited";
    let result: CliResultEvent | null = null;
    let killing: Promise<void> | null = null;
    let sawLine = false;
    const t0 = now();
    let lastActivity = t0;
    let wallDeadline = t0 + inv.limits.wallMs;
    const inFlight = new Set<string>();
    // Broker calls the host reports through CliRun.brokerBusy (§5.8: the stall timer pauses while one is in flight).
    let brokerCalls = 0;
    let ticker: ReturnType<typeof setInterval> | null = null;

    const kill = (why: KillReason, message?: string): Promise<void> => {
      if (killing !== null) return killing;
      if (why === "timeout" || why === "stalled") {
        reason = why;
        failure ??= { code: why, message: message ?? (why === "timeout" ? "the CLI ran past its wall-clock limit" : "the CLI stopped producing output") };
      } else if (why === "user") {
        reason = "cancelled";
        failure ??= { code: "cancelled", message: message ?? "cancelled" };
      } else if (why === "lockdown") {
        // §5.6: a violation always carries lockdown_violation, also when the host cancels (e.g. a broker onViolation).
        reason = "killed";
        failure ??= { code: "lockdown_violation", message: message ?? "the run was stopped for a lockdown violation" };
      } else {
        reason = "killed";
      }
      const p = proc;
      killing = p === null ? Promise.resolve() : killProcessGroup(p, why === "stop");
      return killing;
    };

    const onAbort = (): void => void kill("user");
    const done = (async (): Promise<CliExit> => {
      // Pre-steps (Cursor): short, bounded, same env and cwd; a failure refuses the run.
      for (const args of this.preCommands(inv)) {
        const r = await runCommand(cmd.file, args, { cwd: cmd.cwd, env: cmd.env, timeoutMs: 20_000, maxBytes: 64 * 1024 });
        if (r.code !== 0) {
          queue.end();
          return { code: r.code, signal: r.signal, reason: "spawn_failed", result: null, stderrTail: "", failure: { code: "unsupported", message: `pre-step '${args.join(" ")}' failed` } };
        }
      }
      if (io.signal?.aborted === true || killing !== null) {
        queue.end();
        return { code: null, signal: null, reason: reason === "exited" ? "cancelled" : reason, result: null, stderrTail: "", failure: failure ?? { code: "cancelled", message: "cancelled before start" } };
      }
      const p = spawnCli({ file: cmd.file, args: cmd.args, cwd: cmd.cwd, env: cmd.env, stdin: cmd.stdin }, spawnOptions);
      proc = p;
      io.signal?.addEventListener("abort", onAbort, { once: true });
      const tick = Math.max(20, Math.min(1_000, Math.floor(Math.min(inv.limits.stallMs, inv.limits.wallMs) / 4)));
      ticker = setInterval(() => {
        const t = now();
        // The start timer never outlives the wall clock, including time added with extendWall.
        const startLimit = Math.min(START_TIMEOUT_MS, wallDeadline - t0);
        if (!sawLine && t - t0 > startLimit) void kill("timeout", `no output within ${Math.round(startLimit / 1000)} s of start`);
        else if (inFlight.size === 0 && brokerCalls === 0 && t - lastActivity > inv.limits.stallMs) void kill("stalled", `no output for ${Math.round(inv.limits.stallMs / 1000)} s`);
        else if (t > wallDeadline) void kill("timeout", `wall-clock limit of ${Math.round(inv.limits.wallMs / 1000)} s reached`);
      }, tick);
      (ticker as { unref?: () => void }).unref?.();

      const onLine = io.onStdoutLine;
      const tapped = (async function* (): AsyncGenerator<string> {
        for await (const line of p.lines) {
          sawLine = true;
          lastActivity = now();
          onLine?.(line);
          yield line;
        }
      })();
      try {
        for await (const ev of this.parseEvents(tapped, ctx)) {
          lastActivity = now();
          if (ev.type === "tool_call") inFlight.add(ev.callId);
          else if (ev.type === "tool_result") inFlight.delete(ev.callId);
          const step = monitor.observe(ev);
          if (step.violation !== null) {
            failure = { code: "lockdown_violation", message: `${step.violation.kind}: ${step.violation.detail}` };
            void kill("lockdown");
            break;
          }
          if (ev.type === "result") result = ev;
          queue.push(ev);
          for (const message of step.warnings) queue.push({ type: "warning", message });
        }
        // Fail closed: a held call (§5.6 amendment 2) that the CLI never answered as unavailable.
        const pending = killing === null ? monitor.finish() : null;
        if (pending !== null && failure === null) {
          failure = { code: "lockdown_violation", message: `${pending.kind}: ${pending.detail}` };
          void kill("lockdown");
        }
      } catch (e) {
        failure ??= { code: "bad_output", message: `cannot parse the CLI output: ${(e as Error).message}` };
        void kill("lockdown");
      }
      const ex = await p.exited;
      if (killing !== null) await killing;
      if (ticker !== null) clearInterval(ticker);
      io.signal?.removeEventListener("abort", onAbort);
      const stderrTail = p.stderrTail();
      if (ex.error !== null && p.pid === null) {
        reason = "spawn_failed";
        const missing = (ex.error as NodeJS.ErrnoException).code === "ENOENT";
        failure ??= { code: missing ? "not_installed" : "crashed", message: `cannot start ${this.label}: ${ex.error.message}` };
      }
      if (p.stats.overflow) failure ??= { code: "bad_output", message: `the CLI wrote more than ${OUTPUT_LIMITS.maxStdoutBytes} bytes` };
      else if (p.stats.droppedLines > OUTPUT_LIMITS.maxDroppedLines) failure ??= { code: "bad_output", message: `${p.stats.droppedLines} output lines exceeded ${OUTPUT_LIMITS.maxLineBytes} bytes` };
      else if (p.stats.nonJsonLines > OUTPUT_LIMITS.maxNonJsonLines) failure ??= { code: "bad_output", message: `${p.stats.nonJsonLines} non-JSON output lines` };
      if (failure === null && reason === "exited") failure = this.classifyExit({ code: ex.code, signal: ex.signal, result, stderrTail });
      queue.end();
      return { code: ex.code, signal: ex.signal, reason, result, stderrTail, failure };
    })();

    return new BaseRun({
      pid: () => proc?.pid ?? null,
      events: queue,
      done,
      send: (m) => {
        if (this.capabilities.multiTurn !== "stdin-stream") throw new Error(`${this.label} does not take follow-up messages on stdin`);
        const running: CliProcess | null = proc;
        if (running === null) throw new Error("the CLI has not started");
        running.writeLine(this.userMessageLine(m));
      },
      close: () => {
        const running: CliProcess | null = proc;
        running?.closeInput();
      },
      kill,
      extend: (ms) => {
        if (Number.isFinite(ms) && ms > 0) wallDeadline += ms;
      },
      busy: (on) => {
        if (on) brokerCalls += 1;
        else if (brokerCalls > 0) {
          brokerCalls -= 1;
          // The stall timer restarts when the call ends: the CLI was waiting on us, not silent.
          lastActivity = now();
        }
      },
    });
  }

  async cancel(run: CliRun, reason: KillReason): Promise<CliExit> {
    if (run instanceof BaseRun) await run.kill(reason);
    else run.closeInput();
    return run.done;
  }
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
}

export function lastLine(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return (lines[lines.length - 1] ?? "").trim().slice(0, 300);
}

/** Probe helper: `detected` result for an auth status. */
export function authResult(partial: Omit<CliAuthStatus, "checkedAt">): CliAuthStatus {
  return { ...partial, checkedAt: new Date().toISOString() };
}
