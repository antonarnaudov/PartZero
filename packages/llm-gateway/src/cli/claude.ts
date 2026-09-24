import { homedir } from "node:os";
import { join } from "node:path";
import { emptyUsage, type PlanUsage, type PlanWindow, type StopReason, type Usage } from "../types.js";
import { authResult, BaseCliProvider, lastLine, type ExitInfo } from "./base.js";
import { commonInstallDirs } from "./detect.js";
import type { CliEvent, CliResultEvent } from "./events.js";
import { toIso } from "./failure.js";
import { choiceCheck, evaluateLockdown } from "./lockdown.js";
import { anthropicUsage, count, parseJsonObject, rec, safeModel, safeSessionId, str, textContent } from "./parse.js";
import type { CliAuthStatus, CliBinary, CliCapabilities, CliCommand, CliFailure, CliInvocation, CliUserMessage, LockdownReport, ParseContext } from "./provider.js";

/**
 * Claude Code (`claude -p`), docs/CLI-PROVIDERS.md §4.2. Verified live on 2.1.260: with the flags below the model's
 * toolset is exactly our MCP tools (+ `StructuredOutput` with `--json-schema`); plugins, skills, slash commands,
 * hooks, auto-memory and CLAUDE.md are off; the subscription login works from a minimal environment. Never pass
 * `--bare` (it disables OAuth, i.e. the user's plan) or `--safe-mode` (it drops `--mcp-config` servers).
 */

/** Texts Claude Code prints when it has no usable login (§15 A2; recorded fixtures in test/cli/fixtures/claude). */
export const CLAUDE_LOGIN_FAILURE = /not logged in|please run \/login|invalid api key|oauth token (has expired|has been revoked)|authentication_error|login required/i;

const CLAUDE_RESIDUAL_RISKS = [
  "The CLI runs as you with full OS permissions; the lockdown depends on Claude Code honoring its own flags.",
  "Prompts and the design are sent to Anthropic under your Claude plan's terms (consumer data handling differs from API zero retention).",
  "Managed (enterprise) settings still apply and could add hooks.",
  "--max-turns and --system-prompt-file are hidden flags: if a release removes them the run fails closed.",
  "Bedrock/Vertex/Foundry configured through settings.json env is not supported (restricted mode ignores it).",
];

export class ClaudeCliProvider extends BaseCliProvider {
  readonly id = "claude-cli" as const;
  readonly agent = "claude" as const;
  readonly label = "Claude Code";
  readonly binaryNames = ["claude"];
  readonly minVersion = "2.1.260";
  readonly verifiedRange = { from: "2.1.260", to: "2.1.260" };
  readonly loginHint = "Run `claude auth login` in a terminal";
  readonly capabilities: CliCapabilities = {
    modes: ["completion", "runtime"],
    envelopeVia: "json-schema",
    promptVia: "stdin",
    systemPromptVia: "file-flag",
    mcpConfigVia: "flag-file",
    multiTurn: "stdin-stream",
    images: "stream-json",
    toolListInInit: true,
    reportsTokens: true,
    reportsCostUsd: true,
    reportsPlanUsage: true,
    maxTurnsControl: "flag",
    maxToolCallMs: 900_000,
    sessionCleanup: "none-needed",
  };

  protected override probeExtraEnv(): Record<string, string> {
    return { DISABLE_AUTOUPDATER: "1" };
  }

  protected override installDirs(env: Readonly<Record<string, string>>): string[] {
    const home = env["HOME"] ?? homedir();
    return [...commonInstallDirs(env), join(home, ".claude", "local")];
  }

  qualifiedToolName(tool: string): string {
    return `mcp__cad__${tool}`;
  }

  protected override structuredToolName(inv: CliInvocation): string | null {
    return inv.structured?.via === "json-schema" ? "StructuredOutput" : null;
  }

  lockdown(binary: CliBinary): LockdownReport {
    return evaluateLockdown(binary, {
      minVersion: this.minVersion,
      verifiedRange: this.verifiedRange,
      requiredFlags: [
        ["-p", "--print"],
        "--output-format",
        "--input-format",
        "--model",
        "--tools",
        "--mcp-config",
        "--strict-mcp-config",
        "--restricted",
        "--disable-slash-commands",
        "--no-session-persistence",
        ["--allowedTools", "--allowed-tools"],
        "--permission-mode",
        "--json-schema",
        "--settings",
      ],
      extraChecks: [choiceCheck(binary, "--permission-mode", "dontAsk")],
      residualRisks: CLAUDE_RESIDUAL_RISKS,
    });
  }

  /** `claude auth status --json`: only loggedIn, authMethod, apiProvider and subscriptionType are read; the rest is dropped unseen. */
  async authStatus(binary: CliBinary, env: Readonly<Record<string, string>>): Promise<CliAuthStatus> {
    const r = await this.probe(binary, env, ["auth", "status", "--json"]);
    const o = parseJsonObject(r.stdout.trim()) ?? {};
    const loggedIn = o["loggedIn"];
    const authMethod = str(o["authMethod"]);
    const apiProvider = str(o["apiProvider"]);
    const plan = str(o["subscriptionType"]);
    const safePlan = plan !== null && /^[\w .-]{1,32}$/.test(plan) ? plan : null;
    const safeMethod = authMethod !== null && /^[\w .:-]{1,32}$/.test(authMethod) ? authMethod : null;
    if (typeof loggedIn !== "boolean") {
      return authResult({ state: "unknown", method: null, plan: null, billing: "subscription", probe: "command", detail: r.timedOut ? "auth probe timed out" : "auth probe gave no status" });
    }
    if (!loggedIn) return authResult({ state: "logged_out", method: safeMethod, plan: null, billing: "subscription", probe: "command", detail: "Claude Code is not logged in" });
    if (apiProvider !== "firstParty") {
      return authResult({
        state: "unknown",
        method: safeMethod,
        plan: null,
        billing: "metered",
        probe: "command",
        detail: "configured for Bedrock/Vertex/Foundry via settings, which the app's restricted mode ignores; see Settings -> Details",
      });
    }
    if (authMethod === "claude.ai") return authResult({ state: "logged_in", method: "claude.ai", plan: safePlan, billing: "subscription", probe: "command", detail: "logged in with a Claude plan" });
    return authResult({ state: "logged_in", method: safeMethod, plan: null, billing: "metered", probe: "command", detail: "logged in with an API key (metered)" });
  }

  buildArgs(inv: CliInvocation): CliCommand {
    const ws = inv.workspace.dir;
    const runtime = inv.mode === "runtime";
    const withImages = inv.images.length > 0;
    const streamInput = runtime || withImages;
    const mcpServers: Record<string, unknown> = {};
    if (inv.mcp !== null) {
      mcpServers["cad"] = {
        type: "stdio",
        command: inv.mcp.command,
        args: [...inv.mcp.args],
        // No ticket here: the shim inherits AICAD_MCP_TICKET from Claude's environment (V-here).
        env: { ...inv.mcp.env },
      };
    }
    const args: string[] = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      streamInput ? "stream-json" : "text",
    ];
    // `--flag=value`: a value can never be read as a flag (values are validated too, §5.7).
    if (inv.model !== null) args.push(`--model=${inv.model}`);
    const warnings: string[] = [];
    if (inv.effort !== null) {
      // Optional flag, not part of the lockdown: passed only when this Claude Code lists it.
      if (inv.binary.help.flags.has("--effort")) args.push(`--effort=${inv.effort}`);
      else warnings.push(`this Claude Code does not list --effort; the reasoning effort '${inv.effort}' is not applied (the CLI default is used)`);
    }
    args.push(
      "--restricted",
      "--disable-slash-commands",
      "--settings",
      join(ws, "claude-settings.json"),
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      join(ws, "mcp.json"),
      "--permission-mode",
      "dontAsk",
    );
    if (inv.mcp !== null) args.push("--allowedTools", "mcp__cad");
    args.push("--no-session-persistence", "--max-turns", String(Math.max(1, Math.floor(inv.limits.maxTurns))));
    if (runtime && inv.limits.maxBudgetUsd !== undefined && inv.limits.maxBudgetUsd > 0) args.push("--max-budget-usd", inv.limits.maxBudgetUsd.toFixed(4));
    args.push("--system-prompt-file", join(ws, "system.md"));
    if (inv.structured?.via === "json-schema") args.push("--json-schema", JSON.stringify(inv.structured.schema));
    if (inv.resume !== null) throw new Error("Claude Code runs never resume a session; use send() on the running process");

    const env: Record<string, string> = {
      ...inv.env,
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    };
    if (runtime) env["MCP_TOOL_TIMEOUT"] = "900000";

    const first = this.userMessageLine({ text: inv.prompt, images: inv.images });
    const stdin: CliCommand["stdin"] = runtime ? { kind: "stream-json", first } : withImages ? { kind: "text", text: `${first}\n` } : { kind: "text", text: inv.prompt };
    return {
      file: inv.binary.realPath,
      args,
      cwd: ws,
      env,
      stdin,
      files: [
        { path: "claude-settings.json", content: JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }), mode: 0o400 },
        { path: "mcp.json", content: JSON.stringify({ mcpServers }), mode: 0o400 },
        { path: "system.md", content: inv.systemPrompt, mode: 0o400 },
      ],
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /** stream-json user message (Agent SDK input shape): image blocks first, then the text. */
  protected override userMessageLine(message: CliUserMessage): string {
    const content: unknown[] = (message.images ?? []).map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } }));
    content.push({ type: "text", text: message.text });
    return JSON.stringify({ type: "user", message: { role: "user", content } });
  }

  async *parseEvents(lines: AsyncIterable<string>, _ctx: ParseContext): AsyncGenerator<CliEvent> {
    let current: { id: string | null; model: string | null; usage: Usage | null; toolUse: boolean; stop: StopReason | null } | null = null;
    const calls = new Set<string>();
    let lastPlan: PlanUsage | null = null;
    let sawResult = false;
    const flush = function* (): Generator<CliEvent> {
      if (current === null) return;
      const c = current;
      current = null;
      yield { type: "turn", messageId: c.id, model: c.model, usage: c.usage, stopReason: c.stop ?? (c.toolUse ? "tool_use" : "end_turn") };
    };
    for await (const line of lines) {
      const o = parseJsonObject(line);
      if (o === null) {
        yield { type: "warning", message: "ignored a malformed output line" };
        continue;
      }
      switch (o["type"]) {
        case "system": {
          if (o["subtype"] !== "init") break;
          const tools = Array.isArray(o["tools"]) ? o["tools"].filter((t): t is string => typeof t === "string").slice(0, 512) : null;
          const servers = Array.isArray(o["mcp_servers"])
            ? o["mcp_servers"].map((s) => ({ name: str(rec(s)["name"]) ?? "?", status: str(rec(s)["status"]) ?? "?" })).slice(0, 64)
            : null;
          yield { type: "init", sessionId: safeSessionId(o["session_id"]), model: safeModel(o["model"]), version: str(o["claude_code_version"])?.slice(0, 32) ?? null, tools, mcpServers: servers };
          break;
        }
        case "assistant": {
          const msg = rec(o["message"]);
          const id = str(msg["id"]);
          if (current !== null && current.id !== id) yield* flush();
          current ??= { id, model: safeModel(msg["model"]), usage: null, toolUse: false, stop: null };
          const usage = anthropicUsage(msg["usage"]);
          if (usage !== null) current.usage = usage;
          const stop = mapStop(msg["stop_reason"]);
          if (stop !== null) current.stop = stop;
          const content = Array.isArray(msg["content"]) ? msg["content"] : [];
          for (const raw of content) {
            const b = rec(raw);
            if (b["type"] === "text" && typeof b["text"] === "string") yield { type: "text", messageId: id, text: b["text"], delta: false };
            else if (b["type"] === "tool_use") {
              const name = str(b["name"]) ?? "?";
              const callId = str(b["id"]) ?? `call_${calls.size}`;
              if (name === "StructuredOutput") {
                yield { type: "structured", value: b["input"] };
                continue;
              }
              current.toolUse = true;
              calls.add(callId);
              const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
              yield { type: "tool_call", callId, qualifiedName: name, server: m?.[1] ?? null, tool: m?.[2] ?? name, input: b["input"] };
            }
            // thinking / redacted_thinking blocks are dropped (§3.1 rule 6).
          }
          if (current.stop === "refusal") yield { type: "refusal", message: "the model declined (stop_reason refusal)" };
          break;
        }
        case "user": {
          yield* flush();
          const msg = rec(o["message"]);
          const content = Array.isArray(msg["content"]) ? msg["content"] : [];
          for (const raw of content) {
            const b = rec(raw);
            const callId = str(b["tool_use_id"]);
            if (b["type"] !== "tool_result" || callId === null || !calls.has(callId)) continue;
            yield { type: "tool_result", callId, isError: b["is_error"] === true, text: textContent(b["content"]) };
          }
          break;
        }
        case "rate_limit_event": {
          const usage = planUsageFrom(o["rate_limit_info"]);
          if (usage !== null) {
            lastPlan = usage;
            yield { type: "plan_usage", usage };
          }
          break;
        }
        case "result": {
          yield* flush();
          sawResult = true;
          if (o["structured_output"] !== undefined && o["structured_output"] !== null) yield { type: "structured", value: o["structured_output"] };
          const result = resultFrom(o, lastPlan);
          if (str(o["stop_reason"]) === "refusal" || str(o["terminal_reason"]) === "refusal") yield { type: "refusal", message: "the model declined (stop_reason refusal)" };
          yield result;
          break;
        }
        default:
          break;
      }
    }
    yield* flush();
    if (!sawResult && lastPlan?.status === "rejected") {
      yield {
        type: "result",
        ok: false,
        subtype: "rate_limit_rejected",
        text: "",
        sessionId: null,
        turns: null,
        usage: null,
        costUsd: null,
        models: [],
        failure: quotaFailure(lastPlan),
      };
    }
  }

  protected override classifyExit(info: ExitInfo): CliFailure | null {
    if (info.result === null && CLAUDE_LOGIN_FAILURE.test(info.stderrTail)) return { code: "not_logged_in", message: `Claude Code is not logged in. ${this.loginHint}.` };
    return super.classifyExit(info);
  }
}

function mapStop(v: unknown): StopReason | null {
  switch (v) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "pause_turn":
      return "pause";
    default:
      return null;
  }
}

function utilization(v: unknown): number | null {
  const n = count(v);
  if (n === null) return null;
  return n > 1 ? Math.min(1, n / 100) : n;
}

/** `rate_limit_event.rate_limit_info` -> PlanUsage (utilization normalized to 0..1, times to ISO). */
export function planUsageFrom(raw: unknown, now: Date = new Date()): PlanUsage | null {
  const info = rec(raw);
  if (Object.keys(info).length === 0) return null;
  const s = str(info["status"]);
  const status: PlanUsage["status"] = s === "allowed" || s === "allowed_warning" || s === "rejected" ? s : "unknown";
  const windows: PlanWindow[] = [];
  const unified = rec(info["unifiedWindows"]);
  for (const [id, w] of Object.entries(unified).slice(0, 8)) {
    if (!/^[\w-]{1,32}$/.test(id)) continue;
    const r = rec(w);
    windows.push({ id, utilization: utilization(r["utilization"]), resetsAt: toIso(r["resetsAt"]) });
  }
  const type = str(info["rateLimitType"]);
  if (windows.length === 0 && type !== null && /^[\w-]{1,32}$/.test(type)) {
    windows.push({ id: type, utilization: utilization(info["utilization"]), resetsAt: toIso(info["resetsAt"]) });
  }
  const overageStatus = str(info["overageStatus"]);
  return {
    provider: "claude-cli",
    status,
    windows,
    overage: overageStatus === null ? null : { status: overageStatus.slice(0, 32), inUse: info["isUsingOverage"] === true },
    observedAt: now.toISOString(),
  };
}

function quotaFailure(plan: PlanUsage): CliFailure {
  const resets = plan.windows
    .map((w) => w.resetsAt)
    .filter((r): r is string => r !== null)
    .sort()
    .at(-1);
  const f: CliFailure = { code: "quota_exhausted", message: "the Claude plan's usage limit is reached" };
  if (resets !== undefined) f.resetsAt = resets;
  return f;
}

function resultFrom(o: Record<string, unknown>, lastPlan: PlanUsage | null): CliResultEvent {
  const subtype = str(o["subtype"]) ?? "unknown";
  const isError = o["is_error"] === true;
  const text = str(o["result"]) ?? "";
  // `modelUsage` holds the invocation totals across every model call Claude Code made (it also runs small side
  // calls: seen live, 1454 input tokens in modelUsage vs 507 in `usage`); `usage` covers only the main loop.
  // `models` lists the main model first: by output tokens, then cost (side calls on a small model do not win).
  const ranked: Array<{ model: string; out: number; cost: number }> = [];
  let totals: Usage | null = null;
  for (const [name, raw] of Object.entries(rec(o["modelUsage"])).slice(0, 16)) {
    const model = safeModel(name);
    const mu = rec(raw);
    if (model !== null) ranked.push({ model, out: count(mu["outputTokens"]) ?? 0, cost: count(mu["costUSD"]) ?? 0 });
    totals ??= emptyUsage();
    totals.inputTokens += count(mu["inputTokens"]) ?? 0;
    totals.outputTokens += count(mu["outputTokens"]) ?? 0;
    totals.cacheReadTokens += count(mu["cacheReadInputTokens"]) ?? 0;
    totals.cacheWriteTokens += count(mu["cacheCreationInputTokens"]) ?? 0;
    totals.reasoningTokens += count(mu["thinkingTokens"]) ?? 0;
  }
  const models = ranked.sort((a, b) => b.out - a.out || b.cost - a.cost).map((r) => r.model);
  let usage = totals;
  if (usage === null) {
    usage = anthropicUsage(o["usage"]);
    const thinking = count(rec(rec(o["usage"])["output_tokens_details"])["thinking_tokens"]);
    if (usage !== null && thinking !== null) usage.reasoningTokens = thinking;
  }
  const apiStatus = count(o["api_error_status"]);
  let failure: CliFailure | null = null;
  if (subtype === "error_max_turns") failure = { code: "max_turns", message: "the CLI hit --max-turns" };
  else if (subtype === "error_max_budget_usd") failure = { code: "budget", message: "the CLI hit --max-budget-usd" };
  else if (subtype === "error_max_structured_output_retries") failure = { code: "bad_output", message: "the model did not produce valid structured output" };
  else if (isError || subtype !== "success") {
    if (lastPlan?.status === "rejected") failure = quotaFailure(lastPlan);
    else if (apiStatus === 429) failure = { code: "rate_limited", message: "rate limited (HTTP 429)", retryAfterMs: 30_000 };
    else if (CLAUDE_LOGIN_FAILURE.test(text) || apiStatus === 401) failure = { code: "not_logged_in", message: `Claude Code is not logged in (${lastLine(text).slice(0, 120) || "401"})` };
    else if (/prompt is too long|context (window|length)/i.test(text)) failure = { code: "context_overflow", message: "the prompt does not fit the model's context window" };
    else if (apiStatus !== null && apiStatus >= 500) failure = { code: "crashed", message: `the model API failed (HTTP ${apiStatus})` };
    else failure = { code: "unknown", message: `the CLI reported an error (${subtype}${apiStatus === null ? "" : `, HTTP ${apiStatus}`}): ${lastLine(text).slice(0, 200)}` };
  }
  return {
    type: "result",
    ok: failure === null,
    subtype,
    text,
    sessionId: safeSessionId(o["session_id"]),
    turns: count(o["num_turns"]),
    usage,
    costUsd: count(o["total_cost_usd"]),
    models,
    failure,
  };
}
