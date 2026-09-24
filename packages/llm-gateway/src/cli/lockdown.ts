import { compareVersions, versionInRange } from "./detect.js";
import type { CliEvent } from "./events.js";
import type { CliBinary, LockdownCheck, LockdownReport } from "./provider.js";

/**
 * Lockdown evaluation (§5.5) and runtime tripwires (§5.6), both frozen. Lockdown is decided from the binary's version
 * and `--help`; tripwires check the event stream at runtime and kill the run on anything outside our tools that the CLI
 * could run (amendment 2: a call to a name the CLI does not have is a warning, see {@link TripwireMonitor}).
 */

export interface TripwireContext {
  /** Qualified names of the phase's tools (+ submit_turn when used). */
  allowed: ReadonlySet<string>;
  /** "StructuredOutput" for Claude json-schema. */
  structuredToolName: string | null;
  expectMcp: "none" | "cad";
  /**
   * (additive, §5.6 amendment 2) The tool list the CLI reported at `init`, once that list passed the init check
   * (Claude). It is authoritative: the CLI cannot run a name outside it, so a call to such a name is a hallucination
   * the CLI answers with an error, not a lockdown violation. {@link TripwireMonitor} sets it.
   */
  reportedTools?: ReadonlySet<string> | null;
  /**
   * (additive, §5.6 amendment 2) For CLIs whose parser marks a refused unknown-tool call (`tool_result.unavailable`:
   * Gemini, opencode): the CLI's own built-in tool names. A call to one of them always trips at once. A call to any
   * other out-of-scope name (no server, or our `cad` server) waits for its result: refused as unavailable = a warning,
   * anything else = a violation. Null or absent: every out-of-scope call trips at once (fail closed: Codex, Cursor).
   */
  builtinTools?: ReadonlySet<string> | null;
}

export interface LockdownViolation {
  kind: "unexpected_tool" | "unexpected_mcp_server" | "mcp_not_connected" | "builtin_activity";
  detail: string;
}

type ToolCallEvent = Extract<CliEvent, { type: "tool_call" }>;

/**
 * §5.6 amendment 2: the CLI cannot run this call, because its init tool list (authoritative once checked) does not
 * contain the name. Only for CLIs that report their tool list up front (Claude).
 */
export function isUnofferedToolCall(event: ToolCallEvent, ctx: TripwireContext): boolean {
  return !ctx.allowed.has(event.qualifiedName) && ctx.reportedTools != null && !ctx.reportedTools.has(event.qualifiedName);
}

/** The pure per-event check (§5.6). A call the CLI provably cannot run ({@link isUnofferedToolCall}) is not a violation. */
export function tripwire(event: CliEvent, ctx: TripwireContext): LockdownViolation | null {
  if (event.type === "init") {
    if (event.tools !== null) {
      for (const t of event.tools) {
        if (!ctx.allowed.has(t) && t !== ctx.structuredToolName) return { kind: "unexpected_tool", detail: `the CLI exposes tool '${t}' to the model` };
      }
    }
    if (event.mcpServers !== null) {
      if (ctx.expectMcp === "none" && event.mcpServers.length > 0) {
        return { kind: "unexpected_mcp_server", detail: `MCP servers started: ${event.mcpServers.map((s) => s.name).join(", ")}` };
      }
      if (ctx.expectMcp === "cad") {
        const other = event.mcpServers.find((s) => s.name !== "cad");
        if (other !== undefined) return { kind: "unexpected_mcp_server", detail: `MCP server '${other.name}' started` };
        const cad = event.mcpServers.find((s) => s.name === "cad");
        if (cad === undefined || cad.status !== "connected") return { kind: "mcp_not_connected", detail: `MCP server 'cad' is ${cad?.status ?? "missing"}` };
      }
    }
    return null;
  }
  if (event.type === "tool_call") {
    if (ctx.allowed.has(event.qualifiedName)) return null;
    if (isUnofferedToolCall(event, ctx)) return null;
    return callViolation(event);
  }
  return null;
}

/** A model-chosen name as it appears in failure and warning text: printable ASCII, at most 128 characters. */
function shown(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "?").slice(0, 128);
}

function callViolation(event: ToolCallEvent, suffix = ""): LockdownViolation {
  if (event.server !== null && event.server !== "cad") return { kind: "unexpected_mcp_server", detail: `call to MCP server '${shown(event.server)}' (${shown(event.tool)})${suffix}` };
  if (event.server === null) return { kind: "builtin_activity", detail: `built-in tool activity: ${shown(event.qualifiedName)}${suffix}` };
  return { kind: "unexpected_tool", detail: `call to '${shown(event.qualifiedName)}', which is not in scope${suffix}` };
}

/** What {@link TripwireMonitor.observe} decided for one event. */
export interface TripwireStep {
  /** Kill the run with `lockdown_violation`. */
  violation: LockdownViolation | null;
  /** Emitted as `warning` events after the observed event. */
  warnings: string[];
}

/**
 * The runtime tripwire over a whole event stream (§5.6 with amendment 2). Stateful: it records the init tool list and
 * holds the calls that wait for their result. `BaseCliProvider.run()` feeds it every event in order and calls
 * {@link finish} when the stream ends.
 *
 * A model that calls a tool by a name the CLI does not have (it saw the application tools listed in the envelope
 * appendix and called `classify` directly, or text in the design told it to) cannot run anything: the CLI answers
 * with an error and the model can retry. That is a warning, never a violation, so it can neither fail the turn nor get
 * the binary blocked. Names that are real built-ins still trip at once.
 */
export class TripwireMonitor {
  readonly #ctx: TripwireContext;
  readonly #held = new Map<string, ToolCallEvent>();

  constructor(ctx: TripwireContext) {
    this.#ctx = { ...ctx };
  }

  observe(event: CliEvent): TripwireStep {
    const ok: TripwireStep = { violation: null, warnings: [] };
    switch (event.type) {
      case "init": {
        const violation = tripwire(event, this.#ctx);
        if (violation === null && event.tools !== null) this.#ctx.reportedTools = new Set(event.tools);
        return { violation, warnings: [] };
      }
      case "tool_call": {
        const ctx = this.#ctx;
        if (ctx.allowed.has(event.qualifiedName)) return ok;
        if (isUnofferedToolCall(event, ctx)) {
          return { violation: null, warnings: [`the model called '${shown(event.qualifiedName)}', which this CLI does not offer; the CLI refuses the call (not a lockdown violation)`] };
        }
        const builtins = ctx.builtinTools;
        if (builtins != null && (event.server === null || event.server === "cad") && !builtins.has(event.qualifiedName) && !builtins.has(event.tool)) {
          this.#held.set(event.callId, event);
          return ok;
        }
        return { violation: tripwire(event, ctx), warnings: [] };
      }
      case "tool_result": {
        const held = this.#held.get(event.callId);
        if (held === undefined) return ok;
        this.#held.delete(event.callId);
        if (event.isError && event.unavailable === true) {
          return { violation: null, warnings: [`the model called '${shown(held.qualifiedName)}', which this CLI does not have; the CLI refused the call (not a lockdown violation)`] };
        }
        return { violation: callViolation(held, " (the CLI reported it as run)"), warnings: [] };
      }
      case "result":
        return { violation: this.finish(), warnings: [] };
      default:
        return ok;
    }
  }

  /** Fail closed: a held call the CLI never answered as unavailable is a violation. */
  finish(): LockdownViolation | null {
    const first = this.#held.values().next();
    if (first.done === true) return null;
    this.#held.clear();
    return callViolation(first.value, " (the CLI never reported it as unavailable)");
  }
}

/** Inputs a provider's `lockdown()` hands to {@link evaluateLockdown}. */
export interface LockdownSpec {
  minVersion: string;
  verifiedRange: { from: string; to: string } | null;
  /** Flags `--help` must list (any spelling in a group counts: `["-o", "--output-format"]`). */
  requiredFlags: ReadonlyArray<string | readonly string[]>;
  /** Extra checks computed by the provider (choices, subcommands, config mechanisms). */
  extraChecks?: readonly LockdownCheck[];
  /** A reason to refuse every version (Cursor today). */
  blockedReason?: string | null;
  residualRisks: readonly string[];
}

/**
 * Levels: `verified` = inside the verified range and every check passes; `static` = at or above the minimum, outside
 * the verified range, every check passes (tripwires carry the rest); `none` = refused.
 */
export function evaluateLockdown(binary: CliBinary, spec: LockdownSpec): LockdownReport {
  const checks: LockdownCheck[] = [];
  const versionOk = compareVersions(binary.version, spec.minVersion) >= 0;
  checks.push({ id: "version", ok: versionOk, detail: versionOk ? `version ${binary.version} >= ${spec.minVersion}` : `needs >= ${spec.minVersion}, found ${binary.version}` });
  for (const req of spec.requiredFlags) {
    const names = typeof req === "string" ? [req] : req;
    const ok = names.some((n) => binary.help.flags.has(n));
    checks.push({ id: `flag:${names[names.length - 1] ?? "?"}`, ok, detail: ok ? `--help lists ${names.join("/")}` : `--help does not list ${names.join("/")}` });
  }
  for (const c of spec.extraChecks ?? []) checks.push(c);
  if (spec.blockedReason != null) checks.push({ id: "blocked", ok: false, detail: spec.blockedReason });
  const allOk = checks.every((c) => c.ok);
  const level: LockdownReport["level"] = !allOk ? "none" : versionInRange(binary.version, spec.verifiedRange) ? "verified" : "static";
  return { ok: level !== "none", level, checks, residualRisks: [...spec.residualRisks] };
}

/** `--flag` lists `value` among its `(choices: ...)`. */
export function choiceCheck(binary: CliBinary, flag: string, value: string): LockdownCheck {
  const values = binary.help.choices?.get(flag);
  const ok = values !== undefined && values.includes(value);
  return { id: `choice:${flag}=${value}`, ok, detail: ok ? `${flag} accepts ${value}` : `${flag} does not list '${value}' among its choices` };
}
