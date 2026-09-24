import { join } from "node:path";
import { emptyUsage, type Usage } from "../types.js";
import { authResult, BaseCliProvider, lastLine, type ExitInfo } from "./base.js";
import type { CliEvent, CliResultEvent } from "./events.js";
import { cliImageFileName } from "./envelope.js";
import { parseResetTime } from "./failure.js";
import { evaluateLockdown } from "./lockdown.js";
import { count, parseJsonObject, rec, safeModel, safeSessionId, str, textContent } from "./parse.js";
import type { CliAuthStatus, CliBinary, CliCapabilities, CliCommand, CliFailure, CliInvocation, DiscoveredModel, LockdownReport, ParseContext } from "./provider.js";
import { runCommand } from "./process.js";

/**
 * OpenAI Codex CLI (`codex exec`), docs/CLI-PROVIDERS.md §4.4. Built from Codex source and docs only (not installed
 * here), so the lockdown level stays `static` until someone with a ChatGPT plan runs the smoke. `--strict-config`
 * makes an unknown `-c` key fail the run, so a renamed lockdown key fails closed.
 */

const CODEX_RESIDUAL_RISKS = [
  "Never run by the app's maintainers: the lockdown is derived from the Codex source and relies on runtime tripwires, which only DETECT a built-in tool item after Codex reported it (the kill races its execution); they cannot prevent it, and Codex does not report its tool list up front.",
  "Whether the MCP shim runs inside the read-only Seatbelt profile (and can reach the broker socket) is unverified.",
  "model_instructions_file replaces Codex's base instructions, which may lower tool-use quality.",
  "Prompts and the design are sent to OpenAI under your ChatGPT plan's terms.",
  "Runtime sessions are deleted with `codex delete` only when this Codex lists that command; otherwise prompts and design text stay in ~/.codex/sessions until you remove them.",
];

/**
 * Item types that are NOT built-in tool activity (allowlist, fail closed): any other item type in the stream
 * (`command_execution`, `file_change`, `web_search`, `collab_tool_call`, and anything a later Codex adds or renames)
 * becomes a `builtin_activity` tool call, which the tripwire turns into a lockdown violation.
 */
const CODEX_SAFE_ITEMS = new Set(["agent_message", "reasoning", "mcp_tool_call", "todo_list", "error"]);

function toml(value: string): string {
  return JSON.stringify(value);
}

export class CodexCliProvider extends BaseCliProvider {
  readonly id = "codex-cli" as const;
  readonly agent = "codex" as const;
  readonly label = "Codex CLI";
  readonly binaryNames = ["codex"];
  readonly minVersion = "0.156.1";
  readonly verifiedRange = null;
  readonly loginHint = "Run `codex login` in a terminal";
  readonly capabilities: CliCapabilities = {
    modes: ["completion", "runtime"],
    envelopeVia: "json-schema",
    promptVia: "stdin",
    systemPromptVia: "config-key",
    mcpConfigVia: "config-overrides",
    multiTurn: "resume",
    images: "file-flag",
    toolListInInit: false,
    reportsTokens: true,
    reportsCostUsd: false,
    reportsPlanUsage: false,
    maxTurnsControl: "none",
    maxToolCallMs: 900_000,
    sessionCleanup: "delete-command",
  };
  protected override readonly helpCommands: ReadonlyArray<readonly string[]> = [["--help"], ["exec", "--help"]];

  qualifiedToolName(tool: string): string {
    return `cad__${tool}`;
  }

  lockdown(binary: CliBinary): LockdownReport {
    return evaluateLockdown(binary, {
      minVersion: this.minVersion,
      verifiedRange: this.verifiedRange,
      requiredFlags: [
        "--json",
        "--output-schema",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--strict-config",
        ["-s", "--sandbox"],
        ["-C", "--cd"],
        ["-c", "--config"],
        // Long form: the model is passed as `--model=<m>` so it can never be read as a flag.
        "--model",
        ["-i", "--image"],
      ],
      residualRisks: CODEX_RESIDUAL_RISKS,
    });
  }

  /** `codex login status`: exit 0 = logged in; the method phrase decides billing. The masked key is discarded. */
  async authStatus(binary: CliBinary, env: Readonly<Record<string, string>>): Promise<CliAuthStatus> {
    const r = await this.probe(binary, env, ["login", "status"]);
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0) {
      if (/using chatgpt/i.test(text)) return authResult({ state: "logged_in", method: "chatgpt", plan: null, billing: "subscription", probe: "command", detail: "logged in with ChatGPT" });
      if (/api key|access token/i.test(text)) return authResult({ state: "logged_in", method: "api-key", plan: null, billing: "metered", probe: "command", detail: "logged in with an API key (metered)" });
      return authResult({ state: "logged_in", method: null, plan: null, billing: "subscription", probe: "command", detail: "logged in" });
    }
    if (r.code === 1) return authResult({ state: "logged_out", method: null, plan: null, billing: "subscription", probe: "command", detail: "Codex CLI is not logged in" });
    return authResult({ state: "unknown", method: null, plan: null, billing: "subscription", probe: "command", detail: r.timedOut ? "auth probe timed out" : "auth probe failed" });
  }

  buildArgs(inv: CliInvocation): CliCommand {
    const ws = inv.workspace.dir;
    const runtime = inv.mode === "runtime";
    const files: Array<CliCommand["files"][number]> = [{ path: "system.md", content: inv.systemPrompt, mode: 0o400 }];
    const pre: string[] = ["exec"];
    if (!runtime) pre.push("--ephemeral");
    pre.push("--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--strict-config", "-C", ws, "-s", "read-only");
    if (inv.model !== null) pre.push(`--model=${inv.model}`);
    if (inv.effort !== null) pre.push("-c", `model_reasoning_effort=${toml(inv.effort)}`);
    pre.push(
      "-c",
      "features.shell_tool=false",
      "-c",
      'web_search="disabled"',
      "-c",
      "features.multi_agent=false",
      "-c",
      "tools.view_image=false",
      "-c",
      `model_instructions_file=${toml(join(ws, "system.md"))}`,
    );
    if (inv.mcp !== null) {
      pre.push(
        "-c",
        `mcp_servers.cad.command=${toml(inv.mcp.command)}`,
        "-c",
        `mcp_servers.cad.args=${JSON.stringify([...inv.mcp.args])}`,
      );
      for (const [k, v] of Object.entries(inv.mcp.env)) {
        if (/^[A-Z0-9_]{1,64}$/.test(k)) pre.push("-c", `mcp_servers.cad.env.${k}=${toml(v)}`);
      }
      pre.push(
        "-c",
        `mcp_servers.cad.env_vars=${JSON.stringify([inv.mcp.ticketEnv])}`,
        "-c",
        "mcp_servers.cad.required=true",
        "-c",
        'mcp_servers.cad.default_tools_approval_mode="approve"',
        "-c",
        `mcp_servers.cad.enabled_tools=${JSON.stringify([...inv.mcp.toolNames])}`,
        "-c",
        "mcp_servers.cad.tool_timeout_sec=900",
        "-c",
        "mcp_servers.cad.startup_timeout_sec=20",
      );
    }
    if (inv.structured?.via === "json-schema") {
      files.push({ path: "envelope.schema.json", content: JSON.stringify(inv.structured.schema), mode: 0o400 });
      pre.push("--output-schema", join(ws, "envelope.schema.json"));
    }
    let args: string[];
    if (inv.resume !== null) {
      // -s, -C and --profile must come before `resume`; images are not re-sent on a continuation.
      args = [...pre, "resume", inv.resume.sessionId, "--json", "-"];
    } else {
      const images: string[] = [];
      inv.images.forEach((img, k) => {
        // Fixed extension map; any other media type refuses the invocation (never used as text).
        const name = cliImageFileName(k + 1, img.mediaType);
        files.push({ path: name, content: img.data, mode: 0o400, encoding: "base64" });
        images.push("-i", join(ws, name));
      });
      // `-i` is greedy (#40545): the `-` prompt marker must follow it directly and the prompt goes on stdin.
      args = [...pre, "--json", ...images, "-"];
    }
    return { file: inv.binary.realPath, args, cwd: ws, env: { ...inv.env }, stdin: { kind: "text", text: inv.prompt }, files };
  }

  async *parseEvents(lines: AsyncIterable<string>, _ctx: ParseContext): AsyncGenerator<CliEvent> {
    let sessionId: string | null = null;
    let lastTotal: Usage | null = null;
    let total: Usage | null = null;
    let turns = 0;
    let lastMessage = "";
    let failure: CliFailure | null = null;
    let sawFailed = false;
    let sawCompleted = false;
    let toolInTurn = false;
    const started = new Set<string>();
    const finished = new Set<string>();
    for await (const line of lines) {
      const o = parseJsonObject(line);
      if (o === null) continue;
      const type = str(o["type"]);
      if (type === "thread.started") {
        sessionId = safeSessionId(o["thread_id"]);
        yield { type: "init", sessionId, model: null, version: null, tools: null, mcpServers: null };
      } else if (type === "turn.started") {
        toolInTurn = false;
      } else if (type === "item.started" || type === "item.updated" || type === "item.completed") {
        const item = rec(o["item"]);
        const itemType = str(item["type"]) ?? "";
        const id = str(item["id"]) ?? `item_${started.size + finished.size}`;
        if (itemType === "agent_message" && type === "item.completed") {
          const text = str(item["text"]) ?? "";
          lastMessage = text;
          yield { type: "text", messageId: id, text, delta: false };
          const parsed = parseJsonObject(text.trim());
          if (parsed !== null && "tool_calls" in parsed) yield { type: "structured", value: parsed };
        } else if (itemType === "reasoning" && type === "item.completed") {
          const text = str(item["text"]) ?? "";
          if (text.length > 0) yield { type: "reasoning", text };
        } else if (itemType === "mcp_tool_call") {
          const server = str(item["server"]) ?? "?";
          const tool = str(item["tool"]) ?? "?";
          if (!started.has(id)) {
            started.add(id);
            toolInTurn = true;
            yield { type: "tool_call", callId: id, qualifiedName: `${server}__${tool}`, server, tool, input: item["arguments"] };
          }
          const status = str(item["status"]);
          if (type === "item.completed" || status === "completed" || status === "failed") {
            if (!finished.has(id)) {
              finished.add(id);
              const err = rec(item["error"]);
              const resultText = textContent(rec(item["result"])["content"]) || str(err["message"]) || "";
              yield { type: "tool_result", callId: id, isError: status === "failed" || Object.keys(err).length > 0, text: resultText };
            }
          }
        } else if (itemType === "error") {
          yield { type: "warning", message: (str(item["message"]) ?? "error").slice(0, 500) };
        } else if (!CODEX_SAFE_ITEMS.has(itemType)) {
          // Built-in or unknown item type: fail closed on its first sighting (item.started when Codex sends one).
          if (!started.has(id)) {
            started.add(id);
            const name = /^[\w.-]{1,64}$/.test(itemType) ? itemType : "unknown_item";
            yield { type: "tool_call", callId: id, qualifiedName: name, server: null, tool: name, input: null };
          }
        }
      } else if (type === "turn.completed") {
        sawCompleted = true;
        turns += 1;
        const cumulative = codexUsage(o["usage"]);
        let delta: Usage | null = cumulative;
        if (cumulative !== null && lastTotal !== null) delta = diffUsage(cumulative, lastTotal);
        if (cumulative !== null) {
          lastTotal = cumulative;
          total = cumulative;
        }
        yield { type: "turn", messageId: null, model: null, usage: delta, stopReason: toolInTurn ? "tool_use" : "end_turn" };
      } else if (type === "turn.failed") {
        sawFailed = true;
        const message = str(rec(o["error"])["message"]) ?? "turn failed";
        failure = codexFailureFromText(message) ?? { code: "unknown", message: `Codex turn failed: ${message.slice(0, 200)}` };
        yield {
          type: "result",
          ok: false,
          subtype: "turn.failed",
          text: lastMessage,
          sessionId,
          turns,
          usage: total,
          costUsd: null,
          models: [],
          failure,
        } satisfies CliResultEvent;
      } else if (type === "error") {
        const message = (str(o["message"]) ?? "error").slice(0, 500);
        if (/reconnecting/i.test(message)) {
          const m = /(\d+)\s*\/\s*\d+/.exec(message);
          yield { type: "retry", attempt: m?.[1] === undefined ? null : Number(m[1]), message };
        } else {
          const f = codexFailureFromText(message);
          if (f !== null) failure = f;
          yield { type: "warning", message };
        }
      }
    }
    if (!sawFailed) {
      yield {
        type: "result",
        ok: sawCompleted && failure === null,
        subtype: sawCompleted ? "turn.completed" : "exit",
        text: lastMessage,
        sessionId,
        turns,
        usage: total,
        costUsd: null,
        models: [],
        failure,
      };
    }
  }

  protected override classifyExit(info: ExitInfo): CliFailure | null {
    if (info.result?.failure != null) return info.result.failure;
    const fromText = codexFailureFromText(info.stderrTail);
    if (info.code !== 0 && fromText !== null) return fromText;
    if (info.result !== null && info.result.ok) return info.code === 0 || info.code === null ? null : { code: "crashed", message: `Codex exited with ${info.code}: ${lastLine(info.stderrTail)}` };
    return super.classifyExit({ ...info, result: info.result?.ok === false && info.result.subtype === "exit" ? null : info.result });
  }

  /**
   * Runtime sessions only (completion runs are `--ephemeral`). Shape per docs (§15 X2, unverified): it runs only when
   * `codex --help` lists a `delete` command, so an unknown subcommand is never parsed as something else.
   */
  async cleanup(inv: CliInvocation, sessionId: string | null): Promise<void> {
    if (inv.mode !== "runtime") return;
    const id = safeSessionId(sessionId);
    if (id === null || !inv.binary.help.subcommands.has("delete")) return;
    const env: Record<string, string> = { ...inv.env };
    delete env["AICAD_MCP_TICKET"];
    await runCommand(inv.binary.realPath, ["delete", id], { cwd: inv.workspace.dir, env, timeoutMs: 10_000, maxBytes: 16_384 });
  }

  /** `codex debug models` (JSON when available; one slug per line otherwise). Best effort, never throws. */
  async listModels(binary: CliBinary, env: Readonly<Record<string, string>>): Promise<DiscoveredModel[]> {
    const r = await this.probe(binary, env, ["debug", "models"], { timeoutMs: 15_000 });
    if (r.code !== 0) return [];
    const out: DiscoveredModel[] = [];
    const json = (() => {
      try {
        return JSON.parse(r.stdout) as unknown;
      } catch {
        return null;
      }
    })();
    const list = Array.isArray(json) ? json : Array.isArray(rec(json)["models"]) ? (rec(json)["models"] as unknown[]) : null;
    const push = (slug: string | null, display: string | null, ctx: number | null): void => {
      const m = safeModel(slug);
      if (m === null || out.some((x) => x.modelArg === m)) return;
      out.push({ modelArg: m, displayName: display?.slice(0, 80) ?? m, vendor: "openai", family: m.startsWith("gpt-6") ? "gpt-6" : m.replace(/-[a-z]+$/, ""), tools: true, vision: true, contextWindow: ctx, billing: "subscription" });
    };
    if (list !== null) {
      for (const item of list.slice(0, 100)) {
        const i = rec(item);
        push(str(i["slug"]) ?? str(i["id"]) ?? str(i["model"]) ?? (typeof item === "string" ? item : null), str(i["display_name"]) ?? str(i["name"]), count(i["context_window"]));
      }
    } else {
      for (const l of r.stdout.split("\n").slice(0, 100)) push(l.trim().split(/\s+/)[0] ?? null, null, null);
    }
    return out;
  }
}

function codexUsage(v: unknown): Usage | null {
  const u = rec(v);
  if (Object.keys(u).length === 0) return null;
  const input = count(u["input_tokens"]) ?? 0;
  const cached = count(u["cached_input_tokens"]) ?? 0;
  const out = emptyUsage();
  out.inputTokens = Math.max(0, input - cached);
  out.cacheReadTokens = cached;
  out.outputTokens = count(u["output_tokens"]) ?? 0;
  out.reasoningTokens = count(u["reasoning_output_tokens"]) ?? 0;
  return out;
}

function diffUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    cacheReadTokens: Math.max(0, a.cacheReadTokens - b.cacheReadTokens),
    cacheWriteTokens: Math.max(0, a.cacheWriteTokens - b.cacheWriteTokens),
    cacheWrite1hTokens: Math.max(0, a.cacheWrite1hTokens - b.cacheWrite1hTokens),
    reasoningTokens: Math.max(0, a.reasoningTokens - b.reasoningTokens),
  };
}

/** Codex failure texts (§4.4). "hit your usage limit" also matches the curly-apostrophe variants. */
export function codexFailureFromText(text: string): CliFailure | null {
  if (/hit your usage limit/i.test(text)) {
    const f: CliFailure = { code: "quota_exhausted", message: "the ChatGPT plan's Codex usage limit is reached" };
    const at = parseResetTime(text);
    if (at !== undefined) f.resetsAt = at;
    return f;
  }
  if (/rate limit exceeded/i.test(text)) return { code: "rate_limited", message: "Codex is rate limited", retryAfterMs: 30_000 };
  if (/quota exceeded/i.test(text)) return { code: "quota_exhausted", message: "the Codex quota is exceeded" };
  if (/ran out of room in the model.s context window/i.test(text)) return { code: "context_overflow", message: "the prompt does not fit the model's context window" };
  if (/required MCP servers failed to initialize/i.test(text)) return { code: "crashed", message: "the CAD MCP server failed to start inside Codex" };
  if (/not logged in|please (run )?.?codex login|401 Unauthorized/i.test(text)) return { code: "not_logged_in", message: "Codex CLI is not logged in" };
  return null;
}
