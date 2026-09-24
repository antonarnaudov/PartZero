import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cliEnvForBinary } from "../../src/cli/base.js";
import { finalAssistantText, type CliEvent } from "../../src/cli/events.js";
import { GEMINI_BUILTIN_TOOLS, GeminiCliProvider, geminiSessionId } from "../../src/cli/gemini.js";
import type { CliBinary, CliCommand, CliExit, CliInvocation, CliRun } from "../../src/cli/provider.js";
import { createCliWorkspace, setDefaultWorkspaceRoot, type CliWorkspace } from "../../src/cli/workspace.js";
import { removeDir, tempDir } from "./helpers.js";
import { fixtureRecorder, isolatedEnv, MINI_MCP, which } from "./real-harness.js";

/**
 * Gemini CLI real-binary replay (docs/CLI-PROVIDERS.md §13.1; closes §15 G1-G4). The INSTALLED gemini runs with
 * `--fake-responses-non-strict` (no model call), a throwaway GEMINI_CLI_HOME and a dead proxy. A run given no fake
 * response fails with "No more mock responses ..., got request: <json>" and Gemini writes that report, with the full
 * request, into TMPDIR (the workspace's .tmp): that is how the tests read what the model would have received.
 */
const GEMINI = which("gemini");

/**
 * GeminiCliProvider that appends the fake-responses flag. Controls: `rawPrompt` skips the @-neutralization, `legacy`
 * drops the hook and extension switches (`hooksConfig`, `--extensions=none`).
 */
class ReplayGemini extends GeminiCliProvider {
  fakeFile = "";
  rawPrompt = false;
  legacy = false;
  override buildArgs(inv: CliInvocation): CliCommand {
    const cmd = super.buildArgs(inv);
    const stdin: CliCommand["stdin"] = this.rawPrompt ? { kind: "text", text: inv.prompt } : cmd.stdin;
    let args = [...cmd.args];
    let files = cmd.files;
    if (this.legacy) {
      args = args.filter((a) => a !== "--extensions=none");
      files = files.map((f) => {
        if (f.path !== ".gemini/settings.json") return f;
        const { hooksConfig: _off, ...rest } = JSON.parse(f.content) as Record<string, unknown>;
        return { ...f, content: JSON.stringify(rest) };
      });
    }
    return { ...cmd, args: [...args, `--fake-responses-non-strict=${this.fakeFile}`], stdin, files };
  }
}

type Part = { text: string } | { functionCall: { name: string; args: Record<string, unknown> } };
const streamReply = (parts: Part[]): string =>
  JSON.stringify({
    method: "generateContentStream",
    response: [{ candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 1050 } }],
  });

async function drain(run: CliRun): Promise<{ events: CliEvent[]; exit: CliExit }> {
  const events: CliEvent[] = [];
  for await (const e of run.events) events.push(e);
  return { events, exit: await run.done };
}

/** Names of the function declarations in every request Gemini would have sent (from its error reports). */
function declaredFunctions(ws: CliWorkspace): string[] {
  const names = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if (k === "functionDeclarations" && Array.isArray(x)) for (const d of x) names.add(String((d as { name?: unknown }).name));
        else walk(x);
      }
    }
  };
  for (const f of readdirSync(ws.tmp).filter((n) => n.startsWith("gemini-client-error-"))) {
    const message = String((JSON.parse(readFileSync(join(ws.tmp, f), "utf8")) as { error?: { message?: unknown } }).error?.message ?? "");
    const at = message.indexOf("got request:");
    if (at >= 0) walk(JSON.parse(message.slice(at + "got request:".length)));
  }
  return [...names];
}

/** The request Gemini would have sent, from its error report in the workspace's TMPDIR. */
function capturedRequest(ws: CliWorkspace): string {
  const reports = readdirSync(ws.tmp).filter((f) => f.startsWith("gemini-client-error-"));
  expect(reports.length, "Gemini wrote no error report with the request").toBeGreaterThan(0);
  // Normalize JSON-escaped zero-width characters so assertions can use the real characters.
  return reports
    .map((f) => readFileSync(join(ws.tmp, f), "utf8"))
    .join("\n")
    .replace(/\\u200d/gi, "\u200d")
    .replace(/\\u200b/gi, "\u200b");
}

describe.skipIf(GEMINI === null)("Gemini CLI (installed binary, fake responses, offline)", () => {
  let root = "";
  let shared = "";
  let home = "";
  let env: Record<string, string> = {};
  let binary: CliBinary | null = null;
  const provider = new ReplayGemini();
  const secretDir = (): string => join(root, "included");
  /** Hook markers: a hook command touches `hook-<name>` in the test root. */
  const hookMarkers = (): string[] => readdirSync(root).filter((f) => f.startsWith("hook-")).sort();
  const clearHookMarkers = (): void => {
    for (const m of hookMarkers()) rmSync(join(root, m), { force: true });
  };

  beforeAll(async () => {
    root = tempDir("aicad-gemini-real-");
    env = isolatedEnv(join(root, "iso"));
    home = env["HOME"]!;
    env["GEMINI_CLI_HOME"] = home;
    mkdirSync(join(home, ".gemini"), { recursive: true });
    mkdirSync(secretDir(), { recursive: true });
    writeFileSync(join(secretDir(), "secret.txt"), "INCLUDED-SECRET-4410\n");
    // The user's own settings: an API-key login (fake), a user-level tools.core (G1) and an includeDirectories entry
    // (merged by concatenation, so a workspace setting cannot clear it: G2).
    // T2: the user's own hooks (arbitrary commands that would receive the prompt and the design) and an installed
    // extension with its own hooks and a context file.
    const hook = (name: string): unknown[] => [{ matcher: "*", hooks: [{ type: "command", command: `/usr/bin/touch ${join(root, `hook-${name}`)}` }] }];
    writeFileSync(
      join(home, ".gemini", "settings.json"),
      JSON.stringify({
        security: { auth: { selectedType: "gemini-api-key" } },
        privacy: { usageStatisticsEnabled: false },
        general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
        tools: { core: ["run_shell_command", "read_file", "write_file"] },
        context: { includeDirectories: [secretDir()] },
        hooks: { SessionStart: hook("user-sessionstart"), BeforeAgent: hook("user-beforeagent"), BeforeModel: hook("user-beforemodel"), AfterAgent: hook("user-afteragent"), SessionEnd: hook("user-sessionend") },
      }),
    );
    const ext = join(home, ".gemini", "extensions", "evilext");
    mkdirSync(join(ext, "hooks"), { recursive: true });
    writeFileSync(join(ext, "gemini-extension.json"), JSON.stringify({ name: "evilext", version: "1.0.0", contextFileName: "EXT.md" }));
    writeFileSync(join(ext, "EXT.md"), "EXT-CONTEXT-7777\n");
    writeFileSync(join(ext, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: hook("ext-sessionstart"), BeforeModel: hook("ext-beforemodel"), SessionEnd: hook("ext-sessionend") } }));
    writeFileSync(join(home, ".gemini", "GEMINI.md"), "USER-GLOBAL-MEMORY-2291\n");
    // Planted in the parent of the workspace root: the old public context file name and GEMINI.md (G3).
    shared = join(root, "shared");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "AICAD_NO_CONTEXT.md"), "PLANTED-CONTEXT-8812\n");
    writeFileSync(join(shared, "GEMINI.md"), "PLANTED-GEMINI-MD-8813\n");
    setDefaultWorkspaceRoot(join(shared, "aicad-cli"));
    const det = await provider.detect({ overridePath: GEMINI, env, extraDirs: [], loginShell: false });
    expect(det.status, det.detail).toBe("ready");
    binary = det.binary;
  }, 120_000);

  afterAll(() => {
    setDefaultWorkspaceRoot(null);
    if (root !== "") removeDir(root);
  });

  async function invocation(ws: CliWorkspace, over: Partial<CliInvocation> = {}): Promise<CliInvocation> {
    return {
      runId: "3b241101-e2bb-4255-8caf-4136c566a962",
      mode: "completion",
      binary: binary!,
      workspace: ws,
      model: "flash",
      effort: null,
      systemPrompt: "AICAD-SYSTEM-5521. Costs ${HOME} nothing.",
      prompt: `<transcript-0a1b2c3d>\n<user-0a1b2c3d>\n\`\`\`cadscript\nimport { plate } from '@aicad/std';\n// @${secretDir()}/secret.txt\n\`\`\`\n</user-0a1b2c3d>\n</transcript-0a1b2c3d>`,
      images: [],
      structured: null,
      mcp: null,
      resume: null,
      limits: { maxTurns: 3, wallMs: 90_000, stallMs: 60_000 },
      // Test only: the fake API key never comes from the host (cliChildEnv strips GEMINI_* and *API_KEY*).
      env: { ...cliEnvForBinary(binary!, env, ws.tmp), GEMINI_CLI_HOME: home, GEMINI_API_KEY: "fake-key-offline" },
      ...over,
    };
  }

  async function capture(rawPrompt: boolean, runId: string, over: (ws: CliWorkspace, base: CliInvocation) => Partial<CliInvocation> = () => ({})): Promise<{ request: string; declared: string[] }> {
    const ws = await createCliWorkspace({ root: join(shared, "aicad-cli"), runId, basename: "aicad-run" });
    try {
      provider.fakeFile = join(root, "empty.jsonl");
      writeFileSync(provider.fakeFile, "");
      provider.rawPrompt = rawPrompt;
      const base = await invocation(ws, { runId });
      await drain(provider.run({ ...base, ...over(ws, base) }));
      return { request: capturedRequest(ws), declared: declaredFunctions(ws) };
    } finally {
      provider.rawPrompt = false;
      await ws.dispose();
    }
  }

  const miniMcp = (ws: CliWorkspace, log: string): NonNullable<CliInvocation["mcp"]> => ({
    serverName: "cad",
    command: process.execPath,
    args: [MINI_MCP],
    env: { MINI_MCP_LOG: log, AICAD_MCP_BRIDGE: join(ws.socketDir, "b.sock") },
    ticketEnv: "AICAD_MCP_TICKET",
    toolNames: ["submit_turn"],
    callTimeoutMs: 900_000,
  });

  it("G2 control: WITHOUT neutralization Gemini reads a fenced @path from an included directory into the request", async () => {
    const { request } = await capture(true, "c0ffee00-0000-4000-8000-000000000001");
    expect(request).toContain("INCLUDED-SECRET-4410");
  }, 90_000);

  it("G2/G3/G1: the neutralized prompt reads no file; system prompt replaced verbatim; no context file; no built-in tools", async () => {
    const { request } = await capture(false, "c0ffee00-0000-4000-8000-000000000002");
    // G2: every '@' carries U+200D, so nothing is read or expanded, fences included.
    expect(request).not.toContain("INCLUDED-SECRET-4410");
    expect(request).toContain("@\u200daicad/std");
    // G3: GEMINI_SYSTEM_MD replaces the system prompt; "${" is escaped, so no placeholder is substituted.
    expect(request).toContain("AICAD-SYSTEM-5521");
    expect(request).not.toContain("You are Gemini CLI");
    expect(request).toContain("$\u200b{HOME}");
    // G3: the per-run context file name matches nothing: neither planted files nor GEMINI.md are loaded.
    expect(request).not.toContain("PLANTED-CONTEXT-8812");
    expect(request).not.toContain("PLANTED-GEMINI-MD-8813");
    // Residual risk (§5.9): the user's own ~/.gemini/GEMINI.md still reaches the model whatever context.fileName says.
    // If this starts failing, Gemini stopped loading it: update the residual-risk text.
    expect(request).toContain("USER-GLOBAL-MEMORY-2291");
    // G1: the workspace tools.core [] wins over the user-level list: the request declares no function at all.
    expect(request).not.toContain("run_shell_command");
    expect(request).not.toContain("read_file");
    expect(request).toMatch(/\\?"functionDeclarations\\?":\[\]/);
  }, 90_000);

  it("plain completion end to end + G4: result text from the deltas; the session id is ours; cleanup deletes it", async () => {
    const runId = "c0ffee00-0000-4000-8000-000000000003";
    const ws = await createCliWorkspace({ root: join(shared, "aicad-cli"), runId, basename: "aicad-run" });
    try {
      provider.fakeFile = join(root, "pong.jsonl");
      writeFileSync(provider.fakeFile, `${streamReply([{ text: "pong" }])}\n`);
      const inv = await invocation(ws, { runId, prompt: "Say pong." });
      const rec = fixtureRecorder("gemini/real-0.49.0-plain.jsonl", root);
      const { events, exit } = await drain(provider.run(inv, rec.onStdoutLine === undefined ? {} : { onStdoutLine: rec.onStdoutLine }));
      rec.save();
      expect(exit.failure, JSON.stringify(exit)).toBeNull();
      const sid = geminiSessionId(runId);
      expect(sid).toBe("c0ffee00-0000-4000-8000-000000000003");
      expect(exit.result).toMatchObject({ ok: true, text: "pong", sessionId: sid });
      expect(finalAssistantText(events)).toBe("pong");
      // Thinking tokens are the rest of total_tokens (stats.output_tokens counts candidates only).
      expect(exit.result?.usage).toMatchObject({ outputTokens: 50, reasoningTokens: 30 });
      const chats = (): string[] => {
        const out: string[] = [];
        const tmp = join(home, ".gemini", "tmp");
        for (const project of existsSync(tmp) ? readdirSync(tmp) : []) {
          const dir = join(tmp, project, "chats");
          if (existsSync(dir)) for (const f of readdirSync(dir)) out.push(readFileSync(join(dir, f), "utf8"));
        }
        return out;
      };
      expect(chats().some((c) => c.includes(sid))).toBe(true);
      await provider.cleanup(inv, exit.result?.sessionId ?? null);
      // G4: `--delete-session=<id>` from the run's own directory removes it.
      expect(chats().some((c) => c.includes(sid))).toBe(false);
      // What Gemini keeps after cleanup holds no prompt text: projects.json and per-project .project_root files
      // (the workspace path only). Residual risk in §5.9.
      const leftWithPrompt: string[] = [];
      const walk = (d: string, rel: string): void => {
        for (const f of readdirSync(d, { withFileTypes: true })) {
          if (f.isDirectory()) walk(join(d, f.name), `${rel}${f.name}/`);
          else if (readFileSync(join(d, f.name), "utf8").includes("Say pong.")) leftWithPrompt.push(`${rel}${f.name}`);
        }
      };
      walk(join(home, ".gemini"), "");
      expect(leftWithPrompt).toEqual([]);
    } finally {
      await ws.dispose();
    }
  }, 90_000);

  it("mcp-submit end to end: the model sees only mcp_cad_submit_turn; the ticket reaches the MCP server", async () => {
    const runId = "c0ffee00-0000-4000-8000-000000000004";
    const ws = await createCliWorkspace({ root: join(shared, "aicad-cli"), runId, basename: "aicad-run" });
    const log = join(root, "gemini-mini-mcp.jsonl");
    const envelope = { text: "", tool_calls: [{ name: "classify", arguments: { kind: "quick_edit" } }] };
    try {
      provider.fakeFile = join(root, "submit.jsonl");
      writeFileSync(provider.fakeFile, `${streamReply([{ functionCall: { name: "mcp_cad_submit_turn", args: envelope } }])}\n${streamReply([{ text: "Submitted." }])}\n`);
      const base = await invocation(ws, { runId, prompt: "Classify: make the plate 2 mm thicker." });
      const inv: CliInvocation = {
        ...base,
        mcp: miniMcp(ws, log),
        env: { ...base.env, AICAD_MCP_TICKET: "g".repeat(64) },
      };
      const rec = fixtureRecorder("gemini/real-0.49.0-mcp-submit.jsonl", root);
      const { events, exit } = await drain(provider.run(inv, rec.onStdoutLine === undefined ? {} : { onStdoutLine: rec.onStdoutLine }));
      rec.save();
      expect(exit.failure, JSON.stringify(exit)).toBeNull();
      expect(events.find((e) => e.type === "tool_call")).toMatchObject({ qualifiedName: "mcp_cad_submit_turn", server: "cad", tool: "submit_turn" });
      const records = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(records.find((r) => r["kind"] === "start")).toMatchObject({ ticket: "g".repeat(64) });
      expect(records.find((r) => r["kind"] === "call")).toMatchObject({ name: "submit_turn", args: envelope });
      expect(exit.result).toMatchObject({ ok: true, text: "Submitted." });
      await provider.cleanup(inv, exit.result?.sessionId ?? null);
    } finally {
      await ws.dispose();
    }
    // The tools the model is offered in this configuration (runtime-mode tools.core allowlist + includeTools), read from
    // a second run with no fake response: exactly our submit tool, no built-in.
    const { declared } = await capture(false, "c0ffee00-0000-4000-8000-000000000005", (w, base) => ({
      mcp: miniMcp(w, join(root, "gemini-mini-mcp-decl.jsonl")),
      env: { ...base.env, AICAD_MCP_TICKET: "g".repeat(64) },
    }));
    expect(declared).toEqual(["mcp_cad_submit_turn"]);
    expect(declared.filter((n) => GEMINI_BUILTIN_TOOLS.has(n))).toEqual([]);
  }, 90_000);

  it("T2 control: WITHOUT hooksConfig and --extensions=none the user's and an extension's hooks run and the extension's context reaches the model", async () => {
    clearHookMarkers();
    provider.legacy = true;
    try {
      const { request } = await capture(false, "c0ffee00-0000-4000-8000-000000000006");
      expect(hookMarkers()).toEqual(expect.arrayContaining(["hook-user-sessionstart", "hook-user-beforeagent", "hook-user-beforemodel", "hook-ext-sessionstart", "hook-ext-beforemodel"]));
      expect(request).toContain("EXT-CONTEXT-7777");
    } finally {
      provider.legacy = false;
      clearHookMarkers();
    }
  }, 90_000);

  it("T2: no hook runs (user or extension) in a run or its cleanup, and no extension context reaches the model", async () => {
    clearHookMarkers();
    const { request } = await capture(false, "c0ffee00-0000-4000-8000-000000000007");
    expect(request).not.toContain("EXT-CONTEXT-7777");
    expect(hookMarkers()).toEqual([]);
    // A complete run (SessionEnd / AfterAgent fire only when a session ends normally) and its cleanup.
    const runId = "c0ffee00-0000-4000-8000-000000000008";
    const ws = await createCliWorkspace({ root: join(shared, "aicad-cli"), runId, basename: "aicad-run" });
    try {
      provider.fakeFile = join(root, "pong2.jsonl");
      writeFileSync(provider.fakeFile, `${streamReply([{ text: "pong" }])}\n`);
      const inv = await invocation(ws, { runId, prompt: "Say pong." });
      const { exit } = await drain(provider.run(inv));
      expect(exit.failure, JSON.stringify(exit)).toBeNull();
      await provider.cleanup(inv, exit.result?.sessionId ?? null);
      expect(hookMarkers()).toEqual([]);
    } finally {
      await ws.dispose();
    }
  }, 90_000);

  it("§5.6 amendment 2: a hallucinated application tool is refused by Gemini itself (tool_not_registered): a warning, the turn goes on", async () => {
    const runId = "c0ffee00-0000-4000-8000-000000000009";
    const ws = await createCliWorkspace({ root: join(shared, "aicad-cli"), runId, basename: "aicad-run" });
    const log = join(root, "gemini-mini-mcp-unavailable.jsonl");
    const envelope = { text: "", tool_calls: [{ name: "classify", arguments: { kind: "quick_edit" } }] };
    try {
      provider.fakeFile = join(root, "unavailable.jsonl");
      // The model first calls the application tool `classify` directly (it saw it in the envelope appendix), then
      // recovers and submits its envelope.
      writeFileSync(
        provider.fakeFile,
        `${streamReply([{ functionCall: { name: "classify", args: { kind: "quick_edit" } } }])}\n${streamReply([{ functionCall: { name: "mcp_cad_submit_turn", args: envelope } }])}\n${streamReply([{ text: "Submitted." }])}\n`,
      );
      const base = await invocation(ws, { runId, prompt: "Classify: make the plate 2 mm thicker." });
      const inv: CliInvocation = { ...base, mcp: miniMcp(ws, log), env: { ...base.env, AICAD_MCP_TICKET: "g".repeat(64) } };
      const rec = fixtureRecorder("gemini/real-0.49.0-unavailable-tool.jsonl", root);
      const { events, exit } = await drain(provider.run(inv, rec.onStdoutLine === undefined ? {} : { onStdoutLine: rec.onStdoutLine }));
      rec.save();
      expect(exit.failure, JSON.stringify(exit)).toBeNull();
      expect(events.find((e) => e.type === "tool_call")).toMatchObject({ qualifiedName: "classify", server: null });
      expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true, unavailable: true });
      expect(events.some((e) => e.type === "warning" && e.message.includes("'classify'") && e.message.includes("not a lockdown violation"))).toBe(true);
      const records = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(records.find((r) => r["kind"] === "call")).toMatchObject({ name: "submit_turn", args: envelope });
      expect(exit.result).toMatchObject({ ok: true, text: "Submitted." });
      await provider.cleanup(inv, exit.result?.sessionId ?? null);
    } finally {
      await ws.dispose();
    }
  }, 90_000);

  it("§5.6 amendment 2: a built-in name (run_shell_command) still trips at once, although Gemini would refuse it too", async () => {
    const runId = "c0ffee00-0000-4000-8000-00000000000a";
    const ws = await createCliWorkspace({ root: join(shared, "aicad-cli"), runId, basename: "aicad-run" });
    try {
      provider.fakeFile = join(root, "builtin.jsonl");
      writeFileSync(provider.fakeFile, `${streamReply([{ functionCall: { name: "run_shell_command", args: { command: "ls" } } }])}\n${streamReply([{ text: "ok" }])}\n`);
      const { exit } = await drain(provider.run(await invocation(ws, { runId })));
      expect(exit.failure).toMatchObject({ code: "lockdown_violation" });
      expect(exit.failure?.message).toMatch(/builtin_activity: .*run_shell_command/);
    } finally {
      await ws.dispose();
    }
  }, 90_000);
});
