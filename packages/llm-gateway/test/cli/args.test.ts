import { describe, expect, it } from "vitest";
import { envelopeSchema, neutralizeAtPaths } from "../../src/cli/envelope.js";
import type { McpAttachment } from "../../src/cli/mcp.js";
import { OpencodeProvider } from "../../src/cli/opencode.js";
import type { CliBinary, CliCommand, CliInvocation, CliProvider } from "../../src/cli/provider.js";
import { CLI_PROVIDERS } from "../../src/cli/registry.js";
import type { CliWorkspace } from "../../src/cli/workspace.js";
import type { ToolDef } from "../../src/types.js";
import { fakeBinary } from "./helpers.js";

const TICKET = "f".repeat(64);
const PROMPT = "<transcript-0a1b2c3d>\nSECRET-DESIGN-TEXT import '@aicad/std'\n</transcript-0a1b2c3d>";
const classify: ToolDef = { name: "classify", description: "Classify.", inputSchema: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"], additionalProperties: false } };
const ws: CliWorkspace = { dir: "/ws/w", tmp: "/ws/w/.tmp", socketDir: "/s/ab12cd34", write: () => "", dispose: async () => {} };

const BIN: Record<string, CliBinary> = {
  "claude-cli": fakeBinary("claude-cli", "2.1.260", ["claude-2.1.260.txt"]),
  "gemini-cli": fakeBinary("gemini-cli", "0.49.0", ["gemini-0.49.0.txt"]),
  "codex-cli": fakeBinary("codex-cli", "0.156.1", ["codex-exec-0.156.1.synthetic.txt"]),
  opencode: fakeBinary("opencode", "1.17.10", ["opencode-run-1.17.10.txt"]),
  "cursor-agent": fakeBinary("cursor-agent", "2026.1.28", ["cursor-agent-2026.01.28.txt"]),
};

function mcp(tools: string[]): McpAttachment {
  return { serverName: "cad", command: "/app/electron", args: ["/app/mcp/stdio.js"], env: { AICAD_MCP_BRIDGE: "/s/ab12cd34/b.sock", ELECTRON_RUN_AS_NODE: "1" }, ticketEnv: "AICAD_MCP_TICKET", toolNames: tools, callTimeoutMs: 900_000 };
}

function inv(provider: CliProvider, over: Partial<CliInvocation> = {}): CliInvocation {
  const withMcp = over.mcp !== undefined && over.mcp !== null;
  return {
    runId: "3b241101-e2bb-4255-8caf-4136c566a962",
    mode: "completion",
    binary: BIN[provider.id]!,
    workspace: ws,
    model: "haiku",
    effort: null,
    systemPrompt: "You are the designer. Costs ${HOME} nothing.",
    prompt: PROMPT,
    images: [],
    structured: null,
    mcp: null,
    resume: null,
    limits: { maxTurns: 3, wallMs: 180_000, stallMs: 120_000 },
    env: { PATH: "/usr/bin", HOME: "/home/u", TMPDIR: "/ws/w/.tmp", ...(withMcp ? { AICAD_MCP_TICKET: TICKET } : {}) },
    ...over,
  };
}

/** Invariants for every provider and mode (§13.1): no ticket in argv or files, no prompt in argv (Cursor excepted), files 0400. */
function invariants(provider: CliProvider, cmd: CliCommand): void {
  const argv = JSON.stringify(cmd.args);
  expect(argv).not.toContain(TICKET);
  for (const f of cmd.files) {
    expect(f.content).not.toContain(TICKET);
    expect(f.mode).toBe(0o400);
  }
  if (provider.id !== "cursor-agent") expect(argv).not.toContain("SECRET-DESIGN-TEXT");
  for (const banned of ["--bare", "--safe-mode", "--dangerously-skip-permissions", "--yolo", "--force", "--approve-mcps", "--printenv", "--api-key", "--full-auto"]) expect(cmd.args).not.toContain(banned);
  expect(cmd.cwd).toBe(ws.dir);
  expect(cmd.file).toBe(inv(provider).binary.realPath);
}

const arg = (cmd: CliCommand, flag: string): string | undefined => cmd.args[cmd.args.indexOf(flag) + 1];

describe("Claude Code buildArgs (§4.2)", () => {
  const claude = CLI_PROVIDERS.get("claude-cli")!;

  it("completion + json-schema: full lockdown flag set, prompt on stdin, empty strict MCP config", () => {
    const schema = envelopeSchema([classify], "plain");
    const cmd = claude.buildArgs(inv(claude, { structured: { via: "json-schema", schema } }));
    invariants(claude, cmd);
    expect(cmd.args.slice(0, 6)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--input-format", "text"]);
    expect(cmd.args).toContain("--model=haiku");
    expect(cmd.args).not.toContain("--model");
    expect(cmd.args).toEqual(expect.arrayContaining(["--restricted", "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence"]));
    expect(arg(cmd, "--tools")).toBe("");
    expect(arg(cmd, "--permission-mode")).toBe("dontAsk");
    expect(arg(cmd, "--max-turns")).toBe("3");
    expect(arg(cmd, "--settings")).toBe("/ws/w/claude-settings.json");
    expect(arg(cmd, "--mcp-config")).toBe("/ws/w/mcp.json");
    expect(arg(cmd, "--system-prompt-file")).toBe("/ws/w/system.md");
    expect(JSON.parse(arg(cmd, "--json-schema")!)).toEqual(schema);
    expect(cmd.args).not.toContain("--allowedTools");
    expect(cmd.stdin).toEqual({ kind: "text", text: PROMPT });
    expect(Object.fromEntries(cmd.files.map((f) => [f.path, f.content]))).toEqual({
      "claude-settings.json": '{"disableAllHooks":true,"autoMemoryEnabled":false}',
      "mcp.json": '{"mcpServers":{}}',
      "system.md": "You are the designer. Costs ${HOME} nothing.",
    });
    expect(cmd.env).toMatchObject({ DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" });
    expect(cmd.env["MCP_TOOL_TIMEOUT"]).toBeUndefined();
  });

  it("runtime: stream-json input kept open, allowedTools mcp__cad, MCP server without the ticket, long tool timeout", () => {
    const cmd = claude.buildArgs(inv(claude, { mode: "runtime", mcp: mcp(["apply_cadscript", "get_code"]), limits: { maxTurns: 42, wallMs: 1_200_000, stallMs: 180_000, maxBudgetUsd: 0.5 } }));
    invariants(claude, cmd);
    expect(arg(cmd, "--input-format")).toBe("stream-json");
    expect(arg(cmd, "--allowedTools")).toBe("mcp__cad");
    expect(arg(cmd, "--max-turns")).toBe("42");
    expect(arg(cmd, "--max-budget-usd")).toBe("0.5000");
    expect(cmd.env["MCP_TOOL_TIMEOUT"]).toBe("900000");
    expect(cmd.env["AICAD_MCP_TICKET"]).toBe(TICKET);
    const config = JSON.parse(cmd.files.find((f) => f.path === "mcp.json")!.content) as { mcpServers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }> };
    expect(Object.keys(config.mcpServers)).toEqual(["cad"]);
    expect(config.mcpServers["cad"]).toEqual({ type: "stdio", command: "/app/electron", args: ["/app/mcp/stdio.js"], env: { AICAD_MCP_BRIDGE: "/s/ab12cd34/b.sock", ELECTRON_RUN_AS_NODE: "1" } });
    expect(cmd.stdin.kind).toBe("stream-json");
    const first = JSON.parse(cmd.stdin.kind === "stream-json" ? cmd.stdin.first : "{}");
    expect(first).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: PROMPT }] } });
  });

  it("images switch completion input to one stream-json user message with image blocks first", () => {
    const cmd = claude.buildArgs(inv(claude, { images: [{ mediaType: "image/png", data: "AAAA" }] }));
    expect(arg(cmd, "--input-format")).toBe("stream-json");
    const line = cmd.stdin.kind === "text" ? cmd.stdin.text.trim() : "";
    expect(JSON.parse(line).message.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: PROMPT }]);
  });

  it("never resumes", () => {
    expect(() => claude.buildArgs(inv(claude, { resume: { sessionId: "abc" } }))).toThrow(/never resume/);
  });
});

describe("Gemini CLI buildArgs (§4.3)", () => {
  const gemini = CLI_PROVIDERS.get("gemini-cli")!;

  it("completion + mcp-submit: only mcp_cad_submit_turn, deny-all policy + allow cad, trusted workspace settings", () => {
    const cmd = gemini.buildArgs(inv(gemini, { model: "pro", mcp: mcp(["submit_turn"]) }));
    invariants(gemini, cmd);
    expect(cmd.args).toEqual([
      "-p",
      "Follow the instructions in the message above.",
      "-o",
      "stream-json",
      "--model=pro",
      // No extension loads (their hooks, context files, MCP servers); `=` form, followed by a flag.
      "--extensions=none",
      "--approval-mode",
      "default",
      "--skip-trust",
      "--policy",
      "/ws/w/policy.toml",
      "--allowed-mcp-server-names",
      "cad",
      // Starts with a letter: Gemini's parseInt index fallback can never match it (§4.3 cleanup).
      "--session-id=db241101-e2bb-4255-8caf-4136c566a962",
    ]);
    const settings = JSON.parse(cmd.files.find((f) => f.path === ".gemini/settings.json")!.content);
    expect(settings).toMatchObject({
      tools: { core: ["mcp_cad_submit_turn"] },
      mcp: { allowed: ["cad"] },
      mcpServers: { cad: { trust: true, timeout: 900000, includeTools: ["submit_turn"], env: { AICAD_MCP_TICKET: "$AICAD_MCP_TICKET", AICAD_MCP_BRIDGE: "/s/ab12cd34/b.sock" } } },
      advanced: { ignoreLocalEnv: true },
      // User hooks are arbitrary commands that would receive the prompt and the design (T2): off.
      hooksConfig: { enabled: false },
      // Per run and unguessable: a context file planted in a parent folder cannot match it.
      context: { fileName: ["AICAD_NO_CONTEXT_3b241101e2bb42558caf4136c566a962.md"] },
      model: { maxSessionTurns: 3 },
      billing: { overageStrategy: "never" },
    });
    const policy = cmd.files.find((f) => f.path === "policy.toml")!.content;
    expect(policy).toContain('toolName = "*"\ndecision = "deny"');
    expect(policy).toContain('mcpName = "cad"');
    expect(cmd.files.find((f) => f.path === "system.md")!.content).toBe("You are the designer. Costs $​{HOME} nothing.");
    expect(cmd.env).toMatchObject({ GEMINI_CLI_TRUST_WORKSPACE: "true", GEMINI_SYSTEM_MD: "/ws/w/system.md", NO_BROWSER: "true", AICAD_MCP_TICKET: TICKET });
    // Every '@' is neutralized on stdin, in every mode (Gemini expands @path anywhere, code fences included).
    expect(cmd.stdin).toEqual({ kind: "text", text: neutralizeAtPaths(PROMPT) });
    expect(cmd.stdin.kind === "text" ? cmd.stdin.text : "").toContain("@\u200daicad/std");
  });

  it("runtime prompts are neutralized too, including @paths inside code fences", () => {
    const fenced = "```cadscript\nimport { box } from '@aicad/std';\n// @/etc/passwd\n```";
    const cmd = gemini.buildArgs(inv(gemini, { mode: "runtime", prompt: fenced, mcp: mcp(["get_code"]) }));
    const text = cmd.stdin.kind === "text" ? cmd.stdin.text : "";
    expect(text).not.toMatch(/@(?!\u200d)/);
    expect(text).toContain("@\u200d/etc/passwd");
  });

  it("text-json completion disables every tool; resume uses --resume=<id>", () => {
    const cmd = gemini.buildArgs(inv(gemini, { resume: { sessionId: "sess-1" } }));
    const settings = JSON.parse(cmd.files.find((f) => f.path === ".gemini/settings.json")!.content);
    expect(settings.tools.core).toEqual([]);
    expect(settings.mcpServers).toBeUndefined();
    expect(cmd.files.find((f) => f.path === "policy.toml")!.content).not.toContain("allow");
    expect(cmd.args).toContain("--resume=sess-1");
    expect(cmd.args.some((a) => a.startsWith("--session-id"))).toBe(false);
  });
});

describe("Codex CLI buildArgs (§4.4)", () => {
  const codex = CLI_PROVIDERS.get("codex-cli")!;

  it("completion: ephemeral, read-only sandbox, built-ins off via -c, output schema file, prompt on stdin via '-'", () => {
    const schema = envelopeSchema([classify], "openai-strict");
    const cmd = codex.buildArgs(inv(codex, { model: "gpt-6-sol", effort: "high", structured: { via: "json-schema", schema } }));
    invariants(codex, cmd);
    expect(cmd.args).toEqual([
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "-C",
      "/ws/w",
      "-s",
      "read-only",
      "--model=gpt-6-sol",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      "features.shell_tool=false",
      "-c",
      'web_search="disabled"',
      "-c",
      "features.multi_agent=false",
      "-c",
      "tools.view_image=false",
      "-c",
      'model_instructions_file="/ws/w/system.md"',
      "--output-schema",
      "/ws/w/envelope.schema.json",
      "--json",
      "-",
    ]);
    expect(JSON.parse(cmd.files.find((f) => f.path === "envelope.schema.json")!.content)).toEqual(schema);
  });

  it("runtime: not ephemeral, MCP server via -c with the ticket forwarded by name only; resume keeps flags before `resume`", () => {
    const cmd = codex.buildArgs(inv(codex, { mode: "runtime", mcp: mcp(["get_code", "apply_cadscript"]), resume: { sessionId: "0199a213-81c0" } }));
    invariants(codex, cmd);
    expect(cmd.args).not.toContain("--ephemeral");
    expect(cmd.args).toEqual(
      expect.arrayContaining([
        'mcp_servers.cad.command="/app/electron"',
        'mcp_servers.cad.args=["/app/mcp/stdio.js"]',
        'mcp_servers.cad.env.AICAD_MCP_BRIDGE="/s/ab12cd34/b.sock"',
        'mcp_servers.cad.env_vars=["AICAD_MCP_TICKET"]',
        "mcp_servers.cad.required=true",
        'mcp_servers.cad.default_tools_approval_mode="approve"',
        'mcp_servers.cad.enabled_tools=["get_code","apply_cadscript"]',
        "mcp_servers.cad.tool_timeout_sec=900",
      ]),
    );
    expect(cmd.args.slice(-4)).toEqual(["resume", "0199a213-81c0", "--json", "-"]);
    expect(cmd.args.indexOf("-s")).toBeLessThan(cmd.args.indexOf("resume"));
    expect(cmd.args.indexOf("-C")).toBeLessThan(cmd.args.indexOf("resume"));
  });
});

describe("opencode buildArgs (§4.5)", () => {
  it("deny-all permission + the scoped cad tools, user MCP servers disabled, config only in the environment", () => {
    const oc = new OpencodeProvider();
    oc.setUserMcpServers(BIN["opencode"]!.realPath, ["supabase", "stripe", "bad name!", "cad"]);
    const cmd = oc.buildArgs(inv(oc, { model: "openrouter/qwen3-coder", effort: "high", mcp: mcp(["submit_turn"]) }));
    invariants(oc, cmd);
    expect(cmd.args).toEqual(["run", "--format", "json", "--agent", "aicad", "--title", "aicad", "--model=openrouter/qwen3-coder", "--variant=high", "--pure", "--print-logs", "--log-level", "ERROR", "Follow the instructions in the message below."]);
    const config = JSON.parse(cmd.env["OPENCODE_CONFIG_CONTENT"]!);
    expect(config.permission).toEqual({ "*": "deny", cad_submit_turn: "allow" });
    expect(config.agent.aicad).toEqual({ mode: "primary", prompt: "{file:/ws/w/system.md}", permission: { "*": "deny", cad_submit_turn: "allow" } });
    expect(config.mcp).toEqual({
      supabase: { enabled: false },
      stripe: { enabled: false },
      cad: { type: "local", command: ["/app/electron", "/app/mcp/stdio.js"], environment: { AICAD_MCP_BRIDGE: "/s/ab12cd34/b.sock", ELECTRON_RUN_AS_NODE: "1", AICAD_MCP_TICKET: "{env:AICAD_MCP_TICKET}" }, enabled: true, timeout: 20000 },
    });
    expect(config).toMatchObject({ autoupdate: false, share: "disabled" });
    // Project config (opencode.json, .opencode/, AGENTS.md in the cwd or ANY parent) is never loaded (§5.4).
    expect(cmd.env).toMatchObject({ OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", AICAD_MCP_TICKET: TICKET });
    expect(cmd.files.map((f) => f.path)).toEqual(["system.md"]);
  });

  it("images go after the message with -f", () => {
    const oc = new OpencodeProvider();
    const cmd = oc.buildArgs(inv(oc, { images: [{ mediaType: "image/png", data: "AAAA" }] }));
    expect(cmd.args.slice(-3)).toEqual(["Follow the instructions in the message below.", "-f", "/ws/w/img-1.png"]);
    expect(cmd.files.find((f) => f.path === "img-1.png")).toMatchObject({ encoding: "base64", content: "AAAA" });
  });
});

describe("Cursor Agent buildArgs (§4.6, blocked)", () => {
  const cursor = CLI_PROVIDERS.get("cursor-agent")!;

  it("prompt on argv (the one exception), workspace-only config, sandbox on, never the dangerous flags", () => {
    const cmd = cursor.buildArgs(inv(cursor, { model: null, mcp: mcp(["get_code"]) }));
    invariants(cursor, cmd);
    expect(cmd.args).toEqual(["-p", "--output-format", "stream-json", "--workspace", "/ws/w", "--trust", "--sandbox", "enabled", PROMPT]);
    expect(cmd.stdin).toEqual({ kind: "ignore" });
    expect(JSON.parse(cmd.files.find((f) => f.path === ".cursor/cli.json")!.content).permissions.deny).toEqual(["Shell(*)", "Read(**)", "Write(**)", "WebFetch(*)"]);
    expect(cmd.files.find((f) => f.path === ".cursor/mcp.json")!.content).toContain("${env:AICAD_MCP_TICKET}");
  });

  it("refuses prompts over 96 KiB", () => {
    expect(() => cursor.buildArgs(inv(cursor, { prompt: "x".repeat(97 * 1024) }))).toThrow(/96|98304/);
  });
});
