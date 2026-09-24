import { emptyUsage, type Usage } from "../types.js";
import { authResult, BaseCliProvider, type ExitInfo } from "./base.js";
import type { CliEvent } from "./events.js";
import { evaluateLockdown } from "./lockdown.js";
import { count, parseJsonObject, rec, safeModel, safeSessionId, str, textContent } from "./parse.js";
import { stripAnsi } from "./process.js";
import type { CliAuthStatus, CliBinary, CliCapabilities, CliCommand, CliFailure, CliInvocation, DiscoveredModel, LockdownReport, ParseContext } from "./provider.js";

/**
 * Cursor Agent (`cursor-agent -p`), docs/CLI-PROVIDERS.md §4.6. The adapter ships BLOCKED: server-side web search has
 * no documented off switch in headless runs, whether `deny` rules hide built-in tools is unverified, and the installed
 * builds lack `--trust`. `lockdown().ok` is false on every build until a maintainer verifies one (§15 C1). The spec
 * below is implemented so it can be offline-tested and enabled by changing only `CURSOR_BLOCKED_REASON`.
 */

export const CURSOR_BLOCKED_REASON =
  "Not supported yet: Cursor Agent has no documented way to switch off its web search in headless runs, so the app cannot guarantee it only uses CAD tools.";

/** Cursor takes the prompt on argv (the one exception, §5.2 L12); larger prompts are refused. */
export const CURSOR_MAX_PROMPT_BYTES = 96 * 1024;

export class CursorAgentProvider extends BaseCliProvider {
  readonly id = "cursor-agent" as const;
  readonly agent = "cursor" as const;
  readonly label = "Cursor Agent";
  readonly binaryNames = ["cursor-agent", "agent"];
  readonly minVersion = "2026.1.28";
  readonly verifiedRange = null;
  readonly loginHint = "Run `cursor-agent login` in a terminal";
  readonly capabilities: CliCapabilities = {
    modes: [],
    envelopeVia: "text-json",
    promptVia: "argv",
    systemPromptVia: "workspace-rules",
    mcpConfigVia: "workspace-file",
    multiTurn: "resume",
    images: "none",
    toolListInInit: false,
    reportsTokens: true,
    reportsCostUsd: false,
    reportsPlanUsage: false,
    maxTurnsControl: "none",
    maxToolCallMs: 0,
    sessionCleanup: "left-behind",
  };

  qualifiedToolName(tool: string): string {
    return `cad:${tool}`;
  }

  lockdown(binary: CliBinary): LockdownReport {
    return evaluateLockdown(binary, {
      minVersion: this.minVersion,
      verifiedRange: this.verifiedRange,
      requiredFlags: [["-p", "--print"], "--output-format", "--workspace", "--trust", "--sandbox"],
      blockedReason: CURSOR_BLOCKED_REASON,
      residualRisks: ["Server-side web search, unverified tool hiding, global MCP approval."],
    });
  }

  /** `cursor-agent status` (text; exits 0 either way). The account line is never kept. */
  async authStatus(binary: CliBinary, env: Readonly<Record<string, string>>): Promise<CliAuthStatus> {
    const r = await this.probe(binary, env, ["status"]);
    const text = stripAnsi(`${r.stdout}\n${r.stderr}`);
    if (/not logged in|authentication required/i.test(text)) return authResult({ state: "logged_out", method: null, plan: null, billing: "subscription", probe: "command", detail: "Cursor Agent is not logged in" });
    if (/logged in/i.test(text)) return authResult({ state: "logged_in", method: "cursor", plan: null, billing: "subscription", probe: "command", detail: "logged in" });
    return authResult({ state: "unknown", method: null, plan: null, billing: "subscription", probe: "command", detail: "could not read the login status" });
  }

  protected override preCommands(inv: CliInvocation): Array<readonly string[]> {
    return inv.mcp === null ? [] : [["mcp", "enable", "cad"]];
  }

  buildArgs(inv: CliInvocation): CliCommand {
    const ws = inv.workspace.dir;
    if (Buffer.byteLength(inv.prompt) > CURSOR_MAX_PROMPT_BYTES) throw new Error(`the prompt exceeds ${CURSOR_MAX_PROMPT_BYTES} bytes, the argv limit for Cursor Agent`);
    if (process.platform === "win32") throw new Error("Cursor Agent is not supported on Windows (command-line length limit)");
    const files: Array<CliCommand["files"][number]> = [
      { path: ".cursor/cli.json", content: JSON.stringify({ permissions: { allow: ["Mcp(cad:*)"], deny: ["Shell(*)", "Read(**)", "Write(**)", "WebFetch(*)"] } }), mode: 0o400 },
      { path: ".cursor/rules/aicad.mdc", content: `---\nalwaysApply: true\n---\n${inv.systemPrompt}`, mode: 0o400 },
    ];
    if (inv.mcp !== null) {
      files.push({
        path: ".cursor/mcp.json",
        content: JSON.stringify({ mcpServers: { cad: { command: inv.mcp.command, args: [...inv.mcp.args], env: { ...inv.mcp.env, AICAD_MCP_TICKET: "${env:AICAD_MCP_TICKET}" } } } }),
        mode: 0o400,
      });
    }
    // Never: --force, --yolo, --approve-mcps, --printenv, --api-key, -H.
    const args = ["-p", "--output-format", "stream-json", "--workspace", ws, "--trust", "--sandbox", "enabled"];
    if (inv.model !== null) args.push(`--model=${inv.model}`);
    if (inv.resume !== null) args.push(`--resume=${inv.resume.sessionId}`);
    args.push(inv.prompt);
    return { file: inv.binary.realPath, args, cwd: ws, env: { ...inv.env }, stdin: { kind: "ignore" }, files };
  }

  async *parseEvents(lines: AsyncIterable<string>, _ctx: ParseContext): AsyncGenerator<CliEvent> {
    let sessionId: string | null = null;
    let seq = 0;
    for await (const line of lines) {
      const o = parseJsonObject(line);
      if (o === null) continue;
      const sid = safeSessionId(o["session_id"]);
      if (sid !== null) sessionId = sid;
      switch (o["type"]) {
        case "system":
          if (o["subtype"] === "init") yield { type: "init", sessionId, model: safeModel(o["model"]), version: null, tools: null, mcpServers: null };
          break;
        case "assistant": {
          const text = textContent(rec(o["message"])["content"]);
          if (text.length > 0) yield { type: "text", messageId: null, text, delta: false };
          break;
        }
        case "tool_call": {
          const call = rec(o["tool_call"]);
          const key = Object.keys(call)[0] ?? "unknown";
          const callId = str(o["call_id"]) ?? `cursor_${seq++}`;
          const body = rec(call[key]);
          if (o["subtype"] === "started") {
            if (key === "mcpToolCall") {
              const a = rec(body["args"]);
              const server = str(a["providerIdentifier"]) ?? "?";
              const tool = str(a["toolName"]) ?? str(a["name"]) ?? "?";
              yield { type: "tool_call", callId, qualifiedName: `${server}:${tool}`, server, tool, input: a["args"] };
            } else {
              yield { type: "tool_call", callId, qualifiedName: key, server: null, tool: key, input: null };
            }
          } else if (o["subtype"] === "completed") {
            const result = rec(body["result"]);
            const isError = "error" in result || "failure" in result;
            yield { type: "tool_result", callId, isError, text: textContent(rec(result["success"])["content"]) || str(rec(result["error"])["message"]) || "" };
          }
          break;
        }
        case "result": {
          const isError = o["is_error"] === true || o["subtype"] !== "success";
          const text = str(o["result"]) ?? "";
          let failure: CliFailure | null = null;
          if (isError) failure = /authentication required|not logged in/i.test(text) ? { code: "not_logged_in", message: "Cursor Agent is not logged in" } : { code: "unknown", message: `Cursor Agent reported an error: ${text.slice(0, 200)}` };
          yield { type: "result", ok: !isError, subtype: str(o["subtype"]) ?? "unknown", text, sessionId, turns: null, usage: cursorUsage(o["usage"]), costUsd: null, models: [], failure };
          break;
        }
        default:
          break;
      }
    }
  }

  protected override classifyExit(info: ExitInfo): CliFailure | null {
    if (info.result === null && /authentication required|not logged in/i.test(info.stderrTail)) return { code: "not_logged_in", message: `Cursor Agent is not logged in. ${this.loginHint}.` };
    return super.classifyExit(info);
  }

  /** `cursor-agent models`: one `slug - Display name` per line. */
  async listModels(binary: CliBinary, env: Readonly<Record<string, string>>): Promise<DiscoveredModel[]> {
    const r = await this.probe(binary, env, ["models"]);
    if (r.code !== 0) return [];
    const out: DiscoveredModel[] = [];
    for (const l of stripAnsi(r.stdout).split("\n")) {
      const m = /^\s*([\w.:/@-]+)\s+-\s+(.+)$/.exec(l);
      const slug = safeModel(m?.[1]);
      if (slug === null || m?.[2] === undefined) continue;
      out.push({ modelArg: slug, displayName: m[2].trim().slice(0, 80), vendor: "cursor", family: `cursor-${slug}`, tools: true, vision: false, contextWindow: null, billing: "subscription" });
    }
    return out.slice(0, 100);
  }
}

function cursorUsage(v: unknown): Usage | null {
  const u = rec(v);
  if (Object.keys(u).length === 0) return null;
  const out = emptyUsage();
  out.inputTokens = count(u["inputTokens"]) ?? count(u["input_tokens"]) ?? 0;
  out.outputTokens = count(u["outputTokens"]) ?? count(u["output_tokens"]) ?? 0;
  out.cacheReadTokens = count(u["cacheReadTokens"]) ?? count(u["cache_read_input_tokens"]) ?? 0;
  out.cacheWriteTokens = count(u["cacheWriteTokens"]) ?? count(u["cache_creation_input_tokens"]) ?? 0;
  return out;
}

