import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emptyUsage, type Usage } from "../types.js";
import { authResult, BaseCliProvider, lastLine, type ExitInfo } from "./base.js";
import type { CliEvent, CliResultEvent } from "./events.js";
import { cliImageFileName, neutralizeAtPaths } from "./envelope.js";
import { choiceCheck, evaluateLockdown } from "./lockdown.js";
import { count, parseJsonObject, rec, safeModel, safeSessionId, splitPrefixed, str } from "./parse.js";
import { runCommand } from "./process.js";
import type { CliAuthStatus, CliBinary, CliCapabilities, CliCommand, CliFailure, CliInvocation, LockdownReport, ParseContext } from "./provider.js";

/**
 * Gemini CLI (`gemini -p`), docs/CLI-PROVIDERS.md §4.3. Verified offline on 0.49.0 (research pass): `tools.core`
 * filters built-in and MCP tools, a deny-all policy plus `--approval-mode default` drops write/shell tools, workspace
 * settings load only with GEMINI_CLI_TRUST_WORKSPACE=true, GEMINI_SYSTEM_MD replaces the system prompt,
 * `hooksConfig.enabled: false` and `--extensions=none` keep the user's hooks and every extension out (review round 2).
 * Gemini has no JSON-schema output, so the envelope comes back through our `submit_turn` MCP tool.
 */

const GEMINI_RESIDUAL_RISKS = [
  "The CLI runs as you with full OS permissions; the lockdown depends on Gemini CLI honoring its settings and policy.",
  "Prompts and the design are sent to Google under your Gemini plan's terms.",
  "GEMINI.md user memory and a <session_context> folder listing still reach the model (the workspace is empty).",
  "Your hooks (hooksConfig.enabled: false) and extensions (--extensions=none: their hooks, context files, MCP servers, skills and agents) are off in every run (verified on 0.49.0); the session cleanup command loads no extension and fires no hook. System settings (/etc/gemini-cli) are the admin's policy and still apply.",
  "A workspace tools.core wins over a user-level tools.core on 0.49.0 (verified); later versions may merge differently, and the deny-all policy is the second layer. Runtime tripwires only DETECT a built-in tool call after the model made it (the kill races its execution); they cannot prevent it, and Gemini does not report its tool list up front. A call to a name that is not a known built-in waits for Gemini's own 'not registered' answer; a newer built-in not yet on the app's list is caught only after it ran.",
  "@path expansion: every '@' in the prompt (code fences included) gets a zero-width joiner, which the app removes again from what the model sends back.",
  "Auto model routing and quota fallback can switch models silently; the actual models are recorded with a warning.",
  "Session cleanup is best effort: if it fails, prompts and design text stay in Gemini's own session files (~/.gemini/tmp) until Gemini's retention removes them.",
  "Every run leaves a project entry (the workspace path only, no prompt text) in ~/.gemini/projects.json, two small ~/.gemini/tmp|history/aicad-run-<n>/ folders and an empty projects.json.*.tmp file; Gemini never removes them, so they grow by about 0.5 KB per run.",
];

/**
 * Gemini CLI's built-in tool names (0.49.0 bundle: every `*_TOOL_NAME`, the legacy alias and the built-in agents, plus
 * names of earlier releases). A call to one of them always trips the lockdown (§5.6 amendment 2).
 */
export const GEMINI_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  "activate_skill",
  "ask_user",
  "browser_agent",
  "cli_help",
  "codebase_investigator",
  "complete_task",
  "delegate_to_agent",
  "enter_plan_mode",
  "exit_plan_mode",
  "generalist",
  "get_internal_docs",
  "glob",
  "google_web_search",
  "grep_search",
  "invoke_agent",
  "list_directory",
  "list_mcp_resources",
  "read_file",
  "read_many_files",
  "read_mcp_resource",
  "replace",
  "run_shell_command",
  "save_memory",
  "search_file_content",
  "take_snapshot",
  "tracker_add_dependency",
  "tracker_create_task",
  "tracker_get_task",
  "tracker_list_tasks",
  "tracker_update_task",
  "tracker_visualize",
  "update_topic",
  "web_fetch",
  "write_file",
  "write_todos",
]);

/** The fixed `-p` text; Gemini appends it to the prompt read from stdin. */
export const GEMINI_P_TEXT = "Follow the instructions in the message above.";

export class GeminiCliProvider extends BaseCliProvider {
  readonly id = "gemini-cli" as const;
  readonly agent = "gemini" as const;
  readonly label = "Gemini CLI";
  readonly binaryNames = ["gemini"];
  readonly minVersion = "0.49.0";
  readonly verifiedRange = { from: "0.49.0", to: "0.49.x" };
  readonly loginHint = "Run `gemini` in a terminal and choose Login with Google";
  readonly capabilities: CliCapabilities = {
    modes: ["completion", "runtime"],
    envelopeVia: "mcp-submit",
    promptVia: "stdin",
    systemPromptVia: "env-file",
    mcpConfigVia: "workspace-settings",
    multiTurn: "resume",
    images: "at-path",
    toolListInInit: false,
    reportsTokens: true,
    reportsCostUsd: false,
    reportsPlanUsage: false,
    maxTurnsControl: "setting",
    maxToolCallMs: 900_000,
    sessionCleanup: "delete-command",
  };

  qualifiedToolName(tool: string): string {
    return `mcp_cad_${tool}`;
  }

  /** §5.6 amendment 2: calls to these trip at once; another unknown name waits for Gemini's `tool_not_registered`. */
  protected override builtinToolNames(): ReadonlySet<string> {
    return GEMINI_BUILTIN_TOOLS;
  }

  lockdown(binary: CliBinary): LockdownReport {
    return evaluateLockdown(binary, {
      minVersion: this.minVersion,
      verifiedRange: this.verifiedRange,
      // Long forms: values are passed as `--flag=value` so they can never be read as flags.
      requiredFlags: [
        ["-p", "--prompt"],
        ["-o", "--output-format"],
        "--model",
        "--approval-mode",
        "--policy",
        "--allowed-mcp-server-names",
        "--extensions",
        "--session-id",
        "--skip-trust",
        "--resume",
        "--delete-session",
      ],
      extraChecks: [choiceCheck(binary, "--output-format", "stream-json"), choiceCheck(binary, "--approval-mode", "default")],
      residualRisks: GEMINI_RESIDUAL_RISKS,
    });
  }

  /**
   * Settings-field probe: reads ONLY `security.auth.selectedType` from `~/.gemini/settings.json` and checks whether
   * `~/.gemini/oauth_creds.json` exists. The credentials file is never opened.
   */
  async authStatus(_binary: CliBinary, env: Readonly<Record<string, string>>): Promise<CliAuthStatus> {
    const base = env["GEMINI_CLI_HOME"] ?? env["HOME"] ?? homedir();
    const dir = join(base, ".gemini");
    let selected: string | null = null;
    try {
      const settings = parseJsonObject(readFileSync(join(dir, "settings.json"), "utf8"));
      selected = str(rec(rec(settings?.["security"])["auth"])["selectedType"]);
    } catch {
      selected = null;
    }
    const credsPresent = existsSync(join(dir, "oauth_creds.json"));
    if (selected === null) return authResult({ state: "logged_out", method: null, plan: null, billing: "subscription", probe: "settings-field", detail: "Gemini CLI has no login configured" });
    if (selected === "oauth-personal") {
      return credsPresent
        ? authResult({ state: "logged_in", method: "oauth-personal", plan: null, billing: "subscription", probe: "settings-field", detail: "logged in with Google" })
        : authResult({ state: "unknown", method: "oauth-personal", plan: null, billing: "subscription", probe: "settings-field", detail: "Google login selected; the credentials may be in the keychain" });
    }
    const method = /^[\w-]{1,32}$/.test(selected) ? selected : "other";
    return authResult({
      state: "unknown",
      method,
      plan: null,
      billing: "metered",
      probe: "settings-field",
      detail: "API-key / Vertex auth is not forwarded to CLIs; use the Google API provider instead",
    });
  }

  buildArgs(inv: CliInvocation): CliCommand {
    const ws = inv.workspace.dir;
    const toolNames = inv.mcp?.toolNames ?? [];
    const settings: Record<string, unknown> = {
      tools: { core: toolNames.map((t) => this.qualifiedToolName(t)) },
      mcp: { allowed: ["cad"] },
      advanced: { ignoreLocalEnv: true },
      // Hooks are arbitrary shell commands that receive the prompt, the design and tool arguments; the default is on and
      // user-level hooks load in every run (verified on 0.49.0 with the real binary). Extensions are off by --extensions.
      hooksConfig: { enabled: false },
      // A per-run, unguessable context file name: no GEMINI.md, and nothing planted in a parent folder matches (§5.4).
      context: { fileName: [geminiContextFileName(inv.runId)] },
      general: { maxAttempts: 3 },
      model: { maxSessionTurns: Math.max(1, Math.floor(inv.limits.maxTurns)) },
      billing: { overageStrategy: "never" },
    };
    if (inv.mcp !== null) {
      settings["mcpServers"] = {
        cad: {
          command: inv.mcp.command,
          args: [...inv.mcp.args],
          env: { ...inv.mcp.env, AICAD_MCP_TICKET: "$AICAD_MCP_TICKET" },
          trust: true,
          timeout: 900_000,
          includeTools: [...toolNames],
        },
      };
    }
    const policy = ['[[rule]]', 'toolName = "*"', 'decision = "deny"', "priority = 100", ""];
    if (inv.mcp !== null) policy.push("[[rule]]", 'mcpName = "cad"', 'toolName = "*"', 'decision = "allow"', "priority = 500", "");
    const files: Array<CliCommand["files"][number]> = [
      { path: ".gemini/settings.json", content: JSON.stringify(settings, null, 2), mode: 0o400 },
      { path: "policy.toml", content: policy.join("\n"), mode: 0o400 },
      // Gemini substitutes ${...} placeholders in GEMINI_SYSTEM_MD files (§15 G3): break every "${".
      { path: "system.md", content: inv.systemPrompt.replace(/\$\{/g, "$\u200b{"), mode: 0o400 },
    ];
    const refs: string[] = [];
    inv.images.forEach((img, k) => {
      // Fixed extension map; any other media type refuses the invocation (never used as text).
      const name = cliImageFileName(k + 1, img.mediaType);
      files.push({ path: name, content: img.data, mode: 0o400, encoding: "base64" });
      refs.push(`@${name}`);
    });
    const args = ["-p", refs.length > 0 ? `${GEMINI_P_TEXT} ${refs.join(" ")}` : GEMINI_P_TEXT, "-o", "stream-json"];
    if (inv.model !== null) args.push(`--model=${inv.model}`);
    // No extension loads: no extension hooks, context files, MCP servers, skills or agents (`=` form: never read as more values).
    args.push("--extensions=none", "--approval-mode", "default", "--skip-trust", "--policy", join(ws, "policy.toml"), "--allowed-mcp-server-names", "cad");
    if (inv.resume !== null) args.push(`--resume=${inv.resume.sessionId}`);
    else args.push(`--session-id=${geminiSessionId(inv.runId)}`);
    return {
      file: inv.binary.realPath,
      args,
      cwd: ws,
      env: { ...inv.env, GEMINI_CLI_TRUST_WORKSPACE: "true", GEMINI_SYSTEM_MD: join(ws, "system.md"), NO_BROWSER: "true" },
      // Gemini expands `@path` anywhere in the headless prompt, code fences included (§4.3, §15 G2): every '@' is
      // neutralized, in every mode. Idempotent, so the adapter's own pass does not double it.
      stdin: { kind: "text", text: neutralizeAtPaths(inv.prompt) },
      files,
    };
  }

  async *parseEvents(lines: AsyncIterable<string>, _ctx: ParseContext): AsyncGenerator<CliEvent> {
    let inTurn = false;
    let turns = 0;
    let sessionId: string | null = null;
    let model: string | null = null;
    let sawResult = false;
    let lastError: CliFailure | null = null;
    // Assistant text since the last tool activity: the result's text (Gemini's result event carries none).
    let finalTexts: string[] = [];
    const endTurn = function* (stop: "tool_use" | "end_turn"): Generator<CliEvent> {
      if (!inTurn) return;
      inTurn = false;
      turns += 1;
      yield { type: "turn", messageId: null, model, usage: null, stopReason: stop };
    };
    for await (const line of lines) {
      const o = parseJsonObject(line);
      if (o === null) continue;
      switch (o["type"]) {
        case "init":
          sessionId = safeSessionId(o["session_id"]);
          model = safeModel(o["model"]);
          yield { type: "init", sessionId, model, version: null, tools: null, mcpServers: null };
          break;
        case "message":
          if (o["role"] !== "assistant" || typeof o["content"] !== "string") break;
          inTurn = true;
          finalTexts.push(o["content"]);
          yield { type: "text", messageId: null, text: o["content"], delta: o["delta"] === true };
          break;
        case "tool_use": {
          yield* endTurn("tool_use");
          finalTexts = [];
          const name = str(o["tool_name"]) ?? "?";
          const { server, tool } = splitPrefixed(name, "mcp_cad_", "cad");
          yield { type: "tool_call", callId: str(o["tool_id"]) ?? `gemini_${turns}`, qualifiedName: name, server, tool, input: o["parameters"] };
          break;
        }
        case "tool_result": {
          const callId = str(o["tool_id"]);
          if (callId === null) break;
          const err = rec(o["error"]);
          finalTexts = [];
          const isError = o["status"] === "error";
          const text = str(o["output"]) ?? str(err["message"]) ?? "";
          // Gemini's own refusal of a name it has no tool for (scheduler `tool_not_registered`, real binary 0.49.0).
          yield isError && err["type"] === "tool_not_registered" ? { type: "tool_result", callId, isError, text, unavailable: true } : { type: "tool_result", callId, isError, text };
          break;
        }
        case "error": {
          const message = (str(o["message"]) ?? "error").slice(0, 500);
          if (o["severity"] === "error") {
            const f = geminiFailureFromText(message);
            if (f !== null) lastError = f;
            yield /retry|429|RESOURCE_EXHAUSTED|quota/i.test(message) ? { type: "retry", attempt: null, message } : { type: "warning", message };
          } else yield { type: "warning", message };
          break;
        }
        case "result": {
          yield* endTurn("end_turn");
          sawResult = true;
          yield geminiResult(o, sessionId, turns, lastError, finalTexts.join(""));
          break;
        }
        default:
          break;
      }
    }
    yield* endTurn("end_turn");
    if (!sawResult && lastError !== null) {
      yield { type: "result", ok: false, subtype: "error", text: finalTexts.join(""), sessionId, turns, usage: null, costUsd: null, models: model === null ? [] : [model], failure: lastError };
    }
  }

  protected override classifyExit(info: ExitInfo): CliFailure | null {
    switch (info.code) {
      case 41:
        return { code: "not_logged_in", message: `Gemini CLI is not logged in. ${this.loginHint}.` };
      case 42:
      case 52:
        return { code: "unsupported", message: `Gemini CLI rejected the invocation (exit ${info.code}): ${lastLine(info.stderrTail)}` };
      case 53:
        return { code: "max_turns", message: "Gemini CLI hit model.maxSessionTurns" };
      case 55:
        return { code: "unsupported", message: "Gemini CLI did not apply the workspace trust (exit 55)" };
      case 130:
        return { code: "cancelled", message: "Gemini CLI was interrupted" };
      default:
        break;
    }
    if (info.result !== null) {
      if (info.result.failure !== null) return info.result.failure;
      if (!info.result.ok) return { code: "bad_output", message: "Gemini CLI reported status 'error'" };
      return info.code === 0 || info.code === null ? null : { code: "crashed", message: `Gemini CLI exited with ${info.code}` };
    }
    return geminiFailureFromText(info.stderrTail) ?? super.classifyExit(info);
  }

  /**
   * `gemini --delete-session=<id>`, run in the invocation's OWN workspace directory (the transport cleans up before it
   * disposes the workspace). Verified on 0.49.0 (§15 G4, real-binary replay): Gemini keys sessions by the full project
   * path (a new path with the same basename gets a new slug, `aicad-run-1`, ...), so a fresh directory would not find
   * the session. Only an id the CLI itself reported (init/result) is deleted, never a guess, and only an id that cannot
   * parse as a number: Gemini falls back to `parseInt(id)` as a 1-based INDEX when no session has that id, which would
   * delete an unrelated session. Our runs start with a letter-first UUID ({@link geminiSessionId}) for that reason. `--list-sessions` is
   * not used to confirm: it refreshes auth and may generate session summaries (a model call). Skipped when `--help`
   * does not list `--delete-session`. Best effort: the run's result never depends on it.
   */
  async cleanup(inv: CliInvocation, sessionId: string | null): Promise<void> {
    const id = safeSessionId(sessionId);
    if (id === null || !Number.isNaN(Number.parseInt(id, 10)) || !inv.binary.help.flags.has("--delete-session")) return;
    const env: Record<string, string> = { ...inv.env, NO_BROWSER: "true" };
    delete env["AICAD_MCP_TICKET"];
    // No GEMINI_CLI_TRUST_WORKSPACE: the workspace settings (and its MCP server) are not loaded for this command, so
    // user settings and extensions would be; --extensions=none keeps every extension out (no hook fired here, verified).
    await runCommand(inv.binary.realPath, ["--extensions=none", `--delete-session=${id}`], { cwd: inv.workspace.dir, env, timeoutMs: 15_000, maxBytes: 16_384 });
  }
}

/**
 * The session id a new Gemini run starts with: the run's UUID with its first hex digit mapped to a letter
 * (`3b24...` -> `db24...`), still a UUID. It can never parse as a number, so Gemini's `--delete-session` / `--resume`
 * index fallback (`parseInt`) cannot pick another session; and its first 8 characters carry no "-" (Gemini 0.49 names
 * the session file after them and refuses to delete otherwise, verified with the real binary). A non-UUID run id is
 * hashed into one.
 */
export function geminiSessionId(runId: string): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)
    ? runId.toLowerCase()
    : (() => {
        const h = createHash("sha256").update(runId).digest("hex");
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
      })();
  const first = uuid[0] ?? "a";
  return /[0-9]/.test(first) ? `${"abcdefabcd"[Number(first)]}${uuid.slice(1)}` : uuid;
}

/** Per-run context file name (`context.fileName`): unguessable, so no file in a parent folder is picked up. */
export function geminiContextFileName(runId: string): string {
  return `AICAD_NO_CONTEXT_${runId.replace(/[^A-Za-z0-9]/g, "").slice(0, 32)}.md`;
}

export function geminiFailureFromText(text: string): CliFailure | null {
  if (/TerminalQuotaError|quota exceeded for quota metric|daily limit/i.test(text)) return { code: "quota_exhausted", message: "the Gemini quota is used up" };
  if (/RetryableQuotaError|\b429\b|RESOURCE_EXHAUSTED|rate limit/i.test(text)) return { code: "rate_limited", message: "Gemini is rate limiting requests", retryAfterMs: 30_000 };
  if (/please (log ?in|authenticate)|not authenticated|auth(entication)? (required|failed)|GEMINI_API_KEY environment variable not found/i.test(text)) {
    return { code: "not_logged_in", message: "Gemini CLI is not logged in" };
  }
  if (/exceeds the maximum number of tokens|context window|input token count/i.test(text)) return { code: "context_overflow", message: "the prompt does not fit the model's context window" };
  return null;
}

function geminiResult(o: Record<string, unknown>, sessionId: string | null, turns: number, lastError: CliFailure | null, text: string): CliResultEvent {
  const stats = rec(o["stats"]);
  const models = Object.keys(rec(stats["models"]))
    .map((m) => safeModel(m))
    .filter((m): m is string => m !== null)
    .slice(0, 16);
  let usage: Usage | null = null;
  if (Object.keys(stats).length > 0) {
    usage = emptyUsage();
    const cached = count(stats["cached"]) ?? 0;
    const input = count(stats["input"]) ?? Math.max(0, (count(stats["input_tokens"]) ?? 0) - cached);
    usage.inputTokens = input;
    usage.cacheReadTokens = cached;
    // stats.output_tokens is `candidates` only; thinking tokens are the rest of total_tokens (billed as output).
    const candidates = count(stats["output_tokens"]) ?? 0;
    const total = count(stats["total_tokens"]);
    const prompt = count(stats["input_tokens"]);
    const thoughts = total !== null && prompt !== null ? Math.max(0, total - prompt - candidates) : 0;
    usage.outputTokens = candidates + thoughts;
    usage.reasoningTokens = thoughts;
  }
  const status = str(o["status"]);
  const error = rec(o["error"]);
  let failure: CliFailure | null = null;
  if (status !== "success") {
    const type = str(error["type"]) ?? "";
    const message = str(error["message"]) ?? "";
    failure = geminiFailureFromText(`${type} ${message}`) ?? lastError ?? { code: "bad_output", message: `Gemini CLI reported an error${message ? `: ${message.slice(0, 200)}` : ""}` };
  }
  return { type: "result", ok: failure === null, subtype: status ?? "unknown", text, sessionId, turns, usage, costUsd: null, models, failure };
}
