import { join } from "node:path";
import { emptyUsage, type StopReason, type Usage } from "../types.js";
import { authResult, BaseCliProvider, type ExitInfo } from "./base.js";
import type { CliEvent } from "./events.js";
import { cliImageFileName } from "./envelope.js";
import { choiceCheck, evaluateLockdown } from "./lockdown.js";
import { addUsage, count, parseJsonObject, rec, safeModel, safeSessionId, splitPrefixed, str } from "./parse.js";
import { runCommand, stripAnsi } from "./process.js";
import type { CliAuthStatus, CliBinary, CliCapabilities, CliCommand, CliFailure, CliInvocation, DiscoveredModel, LockdownReport, ParseContext } from "./provider.js";

/**
 * opencode (`opencode run --format json`), docs/CLI-PROVIDERS.md §4.5. Verified with a mock provider on 1.17.x: a
 * `permission` deny removes tools from the model's list, the agent prompt replaces the base prompt, our tools show as
 * `cad_<tool>`, and 429s are retried silently (the stall timer and `--print-logs` catch that). The per-run config is
 * passed in OPENCODE_CONFIG_CONTENT and never written to disk.
 */

const OPENCODE_RESIDUAL_RISKS = [
  "No OS sandbox; the lockdown is opencode's permission engine (deny-all, verified). Runtime tripwires only DETECT a built-in tool call, and opencode reports a tool call only once it is pending, running or finished: they cannot prevent it, and opencode does not report its tool list up front. A call to a name that is not a known built-in waits for opencode's own 'unavailable tool' answer; a newer built-in not yet on the app's list is caught only after it ran.",
  "Your own opencode plugins may run in-process unless --pure is available.",
  "Project config (opencode.json, .opencode/ agents, commands, plugins and MCP servers, AGENTS.md) is never loaded: OPENCODE_DISABLE_PROJECT_CONFIG=1 on every run and probe, and the workspace lives in a folder whose parents only you (or root) can write.",
  "Your global MCP servers are disabled per run by name; a server added after detection is still denied by permission rules.",
  "Your global instructions still reach the model: ~/.config/opencode/AGENTS.md and the files (or URLs, which opencode fetches) listed in `instructions` of your global opencode.json. opencode has no switch to turn them off for one run, and a per-run `instructions` list is added to yours, not used instead (verified on 1.17.10). ~/.claude/CLAUDE.md is not loaded.",
  "Free (Zen) models have their own data terms.",
  "Claude Pro/Max logins cannot be used through opencode (the vendor forbids it).",
  "Session cleanup (`opencode session delete`) is best effort: if it fails, the session stays in opencode's own storage.",
];

/**
 * Env for every opencode process (runs, probes, cleanup). OPENCODE_DISABLE_PROJECT_CONFIG stops opencode from
 * reading opencode.json / .opencode/ / AGENTS.md from the cwd and every folder above it (without a git repo it walks
 * up to "/", so a file planted in a shared parent could start processes): verified on 1.17.10 (§5.4).
 */
const OPENCODE_ENV: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
};

/**
 * opencode 1.17.10 built-in tool ids (from the binary). A call to one of them always trips the lockdown (§5.6
 * amendment 2). `invalid` is left out: it is where opencode routes a call to a name it does not have.
 */
export const OPENCODE_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  "apply_patch",
  "bash",
  "batch",
  "codesearch",
  "edit",
  "glob",
  "grep",
  "list",
  "lsp",
  "multiedit",
  "patch",
  "plan_enter",
  "plan_exit",
  "question",
  "read",
  "skill",
  "task",
  "todoread",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
]);

/** opencode's text for a call to a tool it does not have (AI SDK `NoSuchToolError`, also after its `invalid` repair). */
const OPENCODE_UNAVAILABLE_TOOL = /^Model tried to call unavailable tool '[^']*'/;

/** The fixed message argument; opencode appends the stdin prompt after it. */
export const OPENCODE_MESSAGE = "Follow the instructions in the message below.";

export class OpencodeProvider extends BaseCliProvider {
  readonly id = "opencode" as const;
  readonly agent = "opencode" as const;
  readonly label = "opencode";
  readonly binaryNames = ["opencode"];
  readonly minVersion = "1.17.10";
  readonly verifiedRange = { from: "1.17.10", to: "1.17.x" };
  readonly loginHint = "Run `opencode auth login` in a terminal";
  readonly capabilities: CliCapabilities = {
    modes: ["completion", "runtime"],
    envelopeVia: "mcp-submit",
    promptVia: "stdin",
    systemPromptVia: "agent-config",
    mcpConfigVia: "env-json",
    multiTurn: "resume",
    images: "file-flag",
    toolListInInit: false,
    reportsTokens: true,
    reportsCostUsd: true,
    reportsPlanUsage: false,
    maxTurnsControl: "none",
    // The MCP call timeout is not configurable yet (§15 O2), so `ask_user` stays out of the runtime scope.
    maxToolCallMs: 20_000,
    sessionCleanup: "delete-command",
  };
  protected override readonly helpCommands: ReadonlyArray<readonly string[]> = [["run", "--help"]];
  /** User MCP server names per binary (from `opencode mcp list` at detection), disabled on every run. */
  readonly #userServers = new Map<string, string[]>();

  protected override probeExtraEnv(): Record<string, string> {
    return { ...OPENCODE_ENV, OPENCODE_DISABLE_MODELS_FETCH: "1" };
  }

  qualifiedToolName(tool: string): string {
    return `cad_${tool}`;
  }

  /** §5.6 amendment 2: calls to these trip at once; another unknown name waits for opencode's "unavailable tool" error. */
  protected override builtinToolNames(): ReadonlySet<string> {
    return OPENCODE_BUILTIN_TOOLS;
  }

  lockdown(binary: CliBinary): LockdownReport {
    return evaluateLockdown(binary, {
      minVersion: this.minVersion,
      verifiedRange: this.verifiedRange,
      // Long forms: values are passed as `--flag=value` so they can never be read as flags.
      requiredFlags: ["--format", "--agent", "--title", "--model", "--session", "--print-logs", "--log-level"],
      extraChecks: [choiceCheck(binary, "--format", "json")],
      residualRisks: OPENCODE_RESIDUAL_RISKS,
    });
  }

  /** Known user MCP server names for a binary (tests and hosts may also set them). */
  setUserMcpServers(realPath: string, names: readonly string[]): void {
    this.#userServers.set(realPath, names.filter((n) => /^[\w.-]{1,64}$/.test(n) && n !== "cad"));
  }

  /** `--pure` on management commands too (probes and cleanup), when this opencode lists it: no user plugin runs. */
  #pure(binary: CliBinary): string[] {
    return binary.help.flags.has("--pure") ? ["--pure"] : [];
  }

  protected override async afterDetect(binary: CliBinary, env: Readonly<Record<string, string>>): Promise<void> {
    const r = await this.probe(binary, env, ["mcp", "list", ...this.#pure(binary)]);
    if (r.code === 0) this.setUserMcpServers(binary.realPath, parseMcpList(r.stdout));
  }

  /** `opencode models` (no fetch): any provider other than the free `opencode` (Zen) one means a real login. */
  async authStatus(binary: CliBinary, env: Readonly<Record<string, string>>): Promise<CliAuthStatus> {
    const r = await this.probe(binary, env, ["models", ...this.#pure(binary)]);
    if (r.code !== 0) return authResult({ state: "unknown", method: null, plan: null, billing: "subscription", probe: "command", detail: r.timedOut ? "auth probe timed out" : "could not list models" });
    const providers = new Set(
      stripAnsi(r.stdout)
        .split("\n")
        .map((l) => /^([\w.-]+)\/\S+$/.exec(l.trim())?.[1])
        .filter((p): p is string => p !== undefined),
    );
    if (providers.size === 0) return authResult({ state: "logged_out", method: null, plan: null, billing: "subscription", probe: "command", detail: "opencode has no models configured" });
    const onlyZen = [...providers].every((p) => p === "opencode");
    return authResult({
      state: "logged_in",
      method: onlyZen ? "zen" : "providers",
      plan: onlyZen ? "free models only" : null,
      billing: "subscription",
      probe: "command",
      detail: onlyZen ? "only opencode's free models are available; they have their own data terms" : `${providers.size} provider(s) configured`,
    });
  }

  buildArgs(inv: CliInvocation): CliCommand {
    const ws = inv.workspace.dir;
    const permission: Record<string, string> = { "*": "deny" };
    for (const t of inv.mcp?.toolNames ?? []) permission[this.qualifiedToolName(t)] = "allow";
    const mcp: Record<string, unknown> = {};
    for (const name of this.#userServers.get(inv.binary.realPath) ?? []) mcp[name] = { enabled: false };
    if (inv.mcp !== null) {
      mcp["cad"] = {
        type: "local",
        command: [inv.mcp.command, ...inv.mcp.args],
        environment: { ...inv.mcp.env, AICAD_MCP_TICKET: "{env:AICAD_MCP_TICKET}" },
        enabled: true,
        timeout: 20_000,
      };
    }
    const config = {
      autoupdate: false,
      share: "disabled",
      permission,
      agent: { aicad: { mode: "primary", prompt: `{file:${join(ws, "system.md")}}`, permission } },
      mcp,
    };
    const files: Array<CliCommand["files"][number]> = [{ path: "system.md", content: inv.systemPrompt, mode: 0o400 }];
    const args = ["run", "--format", "json", "--agent", "aicad", "--title", "aicad"];
    if (inv.model !== null) args.push(`--model=${inv.model}`);
    const warnings: string[] = [];
    if (inv.effort !== null) {
      // Optional flag, not part of the lockdown: passed only when this opencode lists it.
      if (inv.binary.help.flags.has("--variant")) args.push(`--variant=${inv.effort}`);
      else warnings.push(`this opencode does not list --variant; the reasoning effort '${inv.effort}' is not applied (the model's default is used)`);
    }
    if (inv.resume !== null) args.push(`--session=${inv.resume.sessionId}`);
    if (inv.binary.help.flags.has("--pure")) args.push("--pure");
    args.push("--print-logs", "--log-level", "ERROR", OPENCODE_MESSAGE);
    inv.images.forEach((img, k) => {
      // Fixed extension map; any other media type refuses the invocation (never used as text).
      const name = cliImageFileName(k + 1, img.mediaType);
      files.push({ path: name, content: img.data, mode: 0o400, encoding: "base64" });
      // `-f` is an array option: it must come after the message.
      args.push("-f", join(ws, name));
    });
    return {
      file: inv.binary.realPath,
      args,
      cwd: ws,
      env: { ...inv.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), ...OPENCODE_ENV },
      stdin: { kind: "text", text: inv.prompt },
      files,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async *parseEvents(lines: AsyncIterable<string>, _ctx: ParseContext): AsyncGenerator<CliEvent> {
    let sessionId: string | null = null;
    let usage: Usage | null = null;
    let cost = 0;
    let steps = 0;
    let lastReason: string | null = null;
    let stepTexts: string[] = [];
    let finalText = "";
    let failure: CliFailure | null = null;
    let initSent = false;
    const models = new Set<string>();
    const calls = new Set<string>();
    const finished = new Set<string>();
    for await (const line of lines) {
      const o = parseJsonObject(line);
      if (o === null) continue;
      const sid = safeSessionId(o["sessionID"]);
      if (sid !== null && sessionId === null) sessionId = sid;
      if (!initSent && sessionId !== null) {
        initSent = true;
        yield { type: "init", sessionId, model: null, version: null, tools: null, mcpServers: null };
      }
      const part = rec(o["part"]);
      switch (o["type"]) {
        case "step_start":
          stepTexts = [];
          break;
        case "text": {
          const text = str(part["text"]);
          if (text === null) break;
          stepTexts.push(text);
          yield { type: "text", messageId: str(part["messageID"]), text, delta: false };
          break;
        }
        case "tool_use": {
          // The call is reported at its FIRST sighting (pending/running when opencode sends those, else on
          // completion), so a tripwire kill comes as early as the stream allows; the result follows at completion.
          const state = rec(part["state"]);
          const status = str(state["status"]);
          const name = str(part["tool"]) ?? "?";
          const callId = str(part["callID"]) ?? str(part["id"]) ?? `call_${steps}_${calls.size}`;
          if (!calls.has(callId)) {
            calls.add(callId);
            const { server, tool } = splitPrefixed(name, "cad_", "cad");
            yield { type: "tool_call", callId, qualifiedName: name, server, tool, input: state["input"] };
          }
          if ((status === "completed" || status === "error") && !finished.has(callId)) {
            finished.add(callId);
            const isError = status === "error";
            const text = (str(state["output"]) ?? str(state["error"]) ?? "").slice(0, 65_536);
            // opencode's own refusal of a name it has no tool for (AI SDK NoSuchToolError; real binary 1.17.10).
            const unavailable = isError && OPENCODE_UNAVAILABLE_TOOL.test(str(state["error"]) ?? "");
            yield unavailable ? { type: "tool_result", callId, isError, text, unavailable: true } : { type: "tool_result", callId, isError, text };
          }
          break;
        }
        case "step_finish": {
          steps += 1;
          lastReason = str(part["reason"]);
          const u = opencodeUsage(part["tokens"]);
          usage = addUsage(usage, u);
          cost += count(part["cost"]) ?? 0;
          const model = safeModel(part["modelID"]) ?? safeModel(rec(part["model"])["modelID"]);
          if (model !== null) models.add(model);
          finalText = stepTexts.join("");
          // A later step that finished with `stop` recovered from earlier errors (opencode retries 429s itself);
          // those stay as warnings (§4.5: exit 1 after a final stop step is a success with a warning).
          if (lastReason === "stop" || lastReason === "length" || lastReason === "content-filter") failure = null;
          yield { type: "turn", messageId: str(part["messageID"]), model, usage: u, stopReason: mapReason(lastReason) };
          break;
        }
        case "error": {
          const err = rec(o["error"]);
          const name = str(err["name"]) ?? "Error";
          const data = rec(err["data"]);
          const message = (str(data["message"]) ?? str(err["message"]) ?? name).slice(0, 500);
          const status = count(data["statusCode"]);
          if (name === "ContextOverflowError") {
            yield { type: "warning", message: "opencode compacted the context after an overflow" };
            break;
          }
          if (name === "APIError" && status === 401) failure = { code: "not_logged_in", message: "opencode's provider rejected the login (401)" };
          else if (status === 429 || /rate.?limit|quota|429/i.test(message)) failure = { code: "rate_limited", message: "the model provider is rate limiting opencode", retryAfterMs: 30_000 };
          else failure ??= { code: "unknown", message: `${name}: ${message}` };
          yield { type: "warning", message: `${name}: ${message}` };
          break;
        }
        default:
          break;
      }
    }
    // A final step cut off at the output limit is a (truncated) reply, not a missing result: its turn says max_tokens.
    if (lastReason === "length") yield { type: "warning", message: "the model hit its output limit; the reply is cut off" };
    if (lastReason === "content-filter") yield { type: "refusal", message: "the model provider filtered the reply (finish reason content-filter)" };
    // opencode has no result event: the process exit is the result. An error AFTER the last stop step still counts.
    const completed = lastReason === "stop" || lastReason === "length" || lastReason === "content-filter";
    const ok = completed && (failure === null || failure.code === "unknown");
    yield {
      type: "result",
      ok,
      subtype: "exit",
      text: finalText,
      sessionId,
      turns: steps,
      usage: usage ?? (steps > 0 ? emptyUsage() : null),
      costUsd: cost > 0 ? cost : null,
      models: [...models],
      failure: ok ? null : failure,
    };
  }

  protected override classifyExit(info: ExitInfo): CliFailure | null {
    // opencode exits 1 after any recovered error: a final `stop` step is still a success (§4.5).
    if (info.result?.ok === true) return null;
    if (info.result?.failure != null) return info.result.failure;
    if (/AI_APICallError/.test(info.stderrTail) && /429|quota|rate.?limit/i.test(info.stderrTail)) return { code: "rate_limited", message: "the model provider is rate limiting opencode", retryAfterMs: 30_000 };
    if (info.result !== null && info.result.turns === 0 && info.code === 0) return { code: "bad_output", message: "opencode produced no model output" };
    return super.classifyExit({ ...info, result: null });
  }

  async cleanup(inv: CliInvocation, sessionId: string | null): Promise<void> {
    const id = safeSessionId(sessionId);
    if (id === null) return;
    const env: Record<string, string> = { ...inv.env, ...OPENCODE_ENV };
    delete env["AICAD_MCP_TICKET"];
    await runCommand(inv.binary.realPath, ["session", "delete", id, ...this.#pure(inv.binary)], { cwd: inv.workspace.dir, env, timeoutMs: 10_000, maxBytes: 16_384 });
  }

  /** `opencode models --verbose`: tool-capable models only; billing `metered` when models.dev lists a cost. */
  async listModels(binary: CliBinary, env: Readonly<Record<string, string>>): Promise<DiscoveredModel[]> {
    const r = await this.probe(binary, env, ["models", "--verbose", ...this.#pure(binary)], { timeoutMs: 15_000 });
    if (r.code !== 0) return [];
    return parseOpencodeModels(stripAnsi(r.stdout));
  }
}

function mapReason(reason: string | null): StopReason | null {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool-calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content-filter":
      return "refusal";
    default:
      return null;
  }
}

function opencodeUsage(v: unknown): Usage | null {
  const t = rec(v);
  if (Object.keys(t).length === 0) return null;
  const u = emptyUsage();
  const reasoning = count(t["reasoning"]) ?? 0;
  u.inputTokens = count(t["input"]) ?? 0;
  u.outputTokens = (count(t["output"]) ?? 0) + reasoning;
  u.reasoningTokens = reasoning;
  u.cacheReadTokens = count(rec(t["cache"])["read"]) ?? 0;
  u.cacheWriteTokens = count(rec(t["cache"])["write"]) ?? 0;
  return u;
}

/**
 * Server names from `opencode mcp list` (1.17.10 shape, recorded in test/cli/fixtures/opencode/mcp-list-*): one
 * `●  <status glyph> <name> <status>` line per server, detail lines under a `│` rail, a `┌` header, a `└` footer, and
 * `▲  No MCP servers configured` / `└  Add servers with: ...` when there are none. Only the per-server lines count;
 * anything else (help text, a changed layout) yields no name rather than a bogus one.
 */
export function parseMcpList(text: string): string[] {
  const names: string[] = [];
  for (const raw of stripAnsi(text).split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("\u25cf")) continue;
    const m = /^\u25cf\s+(?:[^\x20-\x7e]\s+)?([A-Za-z0-9][\w.-]{0,63})\s+[a-z][\w -]*$/.exec(line);
    if (m?.[1] === undefined) continue;
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names.slice(0, 64);
}

/**
 * `opencode models --verbose` output: a `provider/model` line, optionally followed by a JSON object with the models.dev
 * metadata. Only models with tool calling are returned.
 */
export function parseOpencodeModels(text: string): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const id = (lines[i] ?? "").trim();
    if (!/^[\w.-]+\/[\w.:@/-]+$/.test(id)) continue;
    let meta: Record<string, unknown> = {};
    if ((lines[i + 1] ?? "").trim().startsWith("{")) {
      let depth = 0;
      const buf: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] ?? "";
        buf.push(l);
        for (const ch of l) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
        if (depth <= 0) {
          i = j;
          break;
        }
      }
      meta = parseJsonObject(buf.join("\n")) ?? {};
    }
    const caps = rec(meta["capabilities"]);
    const tools = Object.keys(meta).length === 0 ? true : meta["tool_call"] === true || caps["toolcall"] === true;
    if (!tools) continue;
    const [provider = "", ...rest] = id.split("/");
    // Claude plans cannot be used through opencode (vendor terms): never route opencode profiles to Anthropic.
    if (provider === "anthropic") continue;
    const modelArg = safeModel(id);
    if (modelArg === null) continue;
    const cost = rec(meta["cost"]);
    const paid = (count(cost["input"]) ?? 0) > 0 || (count(cost["output"]) ?? 0) > 0;
    const vision = Array.isArray(rec(caps["input"])["image"]) ? true : rec(caps["input"])["image"] === true || (Array.isArray(rec(meta["modalities"])["input"]) && (rec(meta["modalities"])["input"] as unknown[]).includes("image"));
    out.push({
      modelArg,
      displayName: (str(meta["name"]) ?? rest.join("/")).slice(0, 80),
      vendor: provider,
      family: rest.join("/").replace(/[-:](\d{6,8}|latest)$/, ""),
      tools: true,
      vision,
      contextWindow: count(rec(meta["limit"])["context"]),
      billing: paid ? "metered" : "subscription",
    });
  }
  return out.slice(0, 200);
}
