import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_CLI_PROFILES, BUILTIN_PROFILES, profileFromDiscovery } from "../../src/builtin-profiles.js";
import { CliAdapter, type CliTurnOutcome } from "../../src/cli/adapter.js";
import { cliEnvForBinary } from "../../src/cli/base.js";
import { cliImageFileName, renderTranscript } from "../../src/cli/envelope.js";
import type { CliEvent } from "../../src/cli/events.js";
import { GEMINI_BUILTIN_TOOLS } from "../../src/cli/gemini.js";
import { TripwireMonitor, tripwire, type TripwireContext } from "../../src/cli/lockdown.js";
import { OPENCODE_BUILTIN_TOOLS, parseMcpList } from "../../src/cli/opencode.js";
import type { CliExit, CliInvocation, CliProvider, CliRun } from "../../src/cli/provider.js";
import { CLI_PROVIDERS } from "../../src/cli/registry.js";
import { cliGatewayParts } from "../../src/cli/transport.js";
import { createCliWorkspace, type CliWorkspace } from "../../src/cli/workspace.js";
import { LLMGateway } from "../../src/gateway.js";
import { ReplayTransport } from "../../src/transport/transport.js";
import type { ChatRequest, CliProviderId, Message, ToolDef } from "../../src/types.js";
import { binaryFor, fakeBinary, fixturePath, makeFakeCli, parseFixture, readFixture, removeDir, tempDir } from "./helpers.js";

/** Review round 2 (docs/CLI-PROVIDERS.md §16, 2026-09-24): each block names the finding it pins down. */

const claude = CLI_PROVIDERS.get("claude-cli")!;
const gemini = CLI_PROVIDERS.get("gemini-cli")!;
const codex = CLI_PROVIDERS.get("codex-cli")!;
const opencode = CLI_PROVIDERS.get("opencode")!;

const classify: ToolDef = {
  name: "classify",
  description: "Classify the request.",
  inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["quick_edit", "new_part", "question"] } }, required: ["kind"], additionalProperties: false },
};
const opencodeProfile = profileFromDiscovery("opencode", { modelArg: "mock/m1", displayName: "M1", vendor: "mock", family: "m1", tools: true, vision: false, contextWindow: null, billing: "subscription" });
const profiles = [...BUILTIN_PROFILES, ...BUILTIN_CLI_PROFILES, opencodeProfile];

async function drain(run: CliRun): Promise<{ events: CliEvent[]; exit: CliExit }> {
  const events: CliEvent[] = [];
  for await (const e of run.events) events.push(e);
  return { events, exit: await run.done };
}

const call = (qualifiedName: string, server: string | null, callId = "c1"): CliEvent => ({ type: "tool_call", callId, qualifiedName, server, tool: server === null ? qualifiedName : qualifiedName.split(/_|__/).at(-1)!, input: {} });
const result = (callId: string, isError: boolean, unavailable = false): CliEvent =>
  unavailable ? { type: "tool_result", callId, isError, text: "no such tool", unavailable: true } : { type: "tool_result", callId, isError, text: "x" };
const initEvent = (tools: string[] | null): CliEvent => ({ type: "init", sessionId: null, model: null, version: null, tools, mcpServers: tools === null ? null : [] });
const endResult: CliEvent = { type: "result", ok: true, subtype: "success", text: "", sessionId: null, turns: 1, usage: null, costUsd: null, models: [], failure: null };

describe("§5.6 amendment 2: a call to a tool the CLI does not have is a warning, not a lockdown violation", () => {
  it("Claude (init tool list, authoritative once checked): an unoffered name warns; without an init list it still trips", () => {
    const ctx: TripwireContext = { allowed: new Set(), structuredToolName: "StructuredOutput", expectMcp: "none" };
    const m = new TripwireMonitor(ctx);
    expect(m.observe(initEvent(["StructuredOutput"]))).toEqual({ violation: null, warnings: [] });
    for (const name of ["classify", "Bash", "mcp__cad__apply_cadscript", "mcp__github__create_issue"]) {
      const step = m.observe(call(name, null));
      expect(step.violation, name).toBeNull();
      expect(step.warnings.join(), name).toMatch(new RegExp(`'${name}'.*not a lockdown violation`));
    }
    expect(m.finish()).toBeNull();
    // The pure check agrees once it knows the reported list, and stays fail-closed without one.
    expect(tripwire(call("classify", null), { ...ctx, reportedTools: new Set(["StructuredOutput"]) })).toBeNull();
    expect(tripwire(call("classify", null), ctx)).toMatchObject({ kind: "builtin_activity" });
    // An init list that fails the check is never recorded: the init itself trips.
    const bad = new TripwireMonitor(ctx);
    expect(bad.observe(initEvent(["Bash", "StructuredOutput"])).violation).toMatchObject({ kind: "unexpected_tool" });
  });

  it("Gemini / opencode (no init list): built-ins trip at once; another name waits for the CLI's own 'unavailable' answer", () => {
    for (const builtins of [GEMINI_BUILTIN_TOOLS, OPENCODE_BUILTIN_TOOLS]) {
      const ctx: TripwireContext = { allowed: new Set(["cad_submit_turn", "mcp_cad_submit_turn"]), structuredToolName: null, expectMcp: "cad", builtinTools: builtins };
      const shell = builtins === GEMINI_BUILTIN_TOOLS ? "run_shell_command" : "bash";
      expect(new TripwireMonitor(ctx).observe(call(shell, null)).violation).toMatchObject({ kind: "builtin_activity" });
      // Refused by the CLI as unavailable: a warning.
      const ok = new TripwireMonitor(ctx);
      expect(ok.observe(call("classify", null))).toEqual({ violation: null, warnings: [] });
      const refused = ok.observe(result("c1", true, true));
      expect(refused.violation).toBeNull();
      expect(refused.warnings.join()).toMatch(/'classify'.*not a lockdown violation/);
      expect(ok.observe(endResult).violation).toBeNull();
      // Our own server with a made-up tool name, refused: a warning too.
      const own = new TripwireMonitor(ctx);
      own.observe(call("mcp_cad_delete_everything", "cad", "c2"));
      expect(own.observe(result("c2", true, true)).violation).toBeNull();
      // The CLI ran it (a success, or an error that is not "unavailable"): a violation.
      for (const r of [result("c1", false), result("c1", true)]) {
        const ran = new TripwireMonitor(ctx);
        ran.observe(call("classify", null));
        expect(ran.observe(r).violation).toMatchObject({ kind: "builtin_activity", detail: expect.stringMatching(/reported it as run/) });
      }
      // Never answered: fail closed at the result, or at the end of the stream.
      const open = new TripwireMonitor(ctx);
      open.observe(call("classify", null));
      expect(open.observe(endResult).violation).toMatchObject({ kind: "builtin_activity", detail: expect.stringMatching(/never reported it as unavailable/) });
      const eof = new TripwireMonitor(ctx);
      eof.observe(call("classify", null));
      expect(eof.finish()).toMatchObject({ kind: "builtin_activity" });
      // Another MCP server is never deferred.
      expect(new TripwireMonitor(ctx).observe(call("mcp__github__x", "github")).violation).toMatchObject({ kind: "unexpected_mcp_server" });
    }
  });

  it("Codex (no init list, no refusal marker): every out-of-scope call still trips at once", () => {
    const m = new TripwireMonitor({ allowed: new Set(["cad__get_code"]), structuredToolName: null, expectMcp: "cad", builtinTools: null });
    expect(m.observe(call("classify", null)).violation).toMatchObject({ kind: "builtin_activity" });
  });

  it("the parsers mark the CLI's own refusal: Gemini tool_not_registered, opencode 'Model tried to call unavailable tool' (real-binary fixtures)", async () => {
    const g = await parseFixture(gemini, "gemini/real-0.49.0-unavailable-tool.jsonl");
    expect(g.filter((e) => e.type === "tool_result").map((e) => (e.type === "tool_result" ? [e.isError, e.unavailable ?? false] : null))).toEqual([
      [true, true],
      [false, false],
    ]);
    const o = await parseFixture(opencode, "opencode/real-1.17.10-unavailable-tool.jsonl");
    expect(o.find((e) => e.type === "tool_result")).toMatchObject({ isError: true, unavailable: true });
    // A denied built-in is an error, but not "unavailable".
    const bash = await parseFixture(opencode, "opencode/builtin-bash.jsonl");
    expect(bash.find((e) => e.type === "tool_result")).not.toHaveProperty("unavailable");
  });
});

describe("§5.6 amendment 2 through run(): fake binaries replaying recorded streams", () => {
  let dir: string | null = null;
  let ws: CliWorkspace | null = null;
  afterEach(async () => {
    await ws?.dispose();
    ws = null;
    if (dir !== null) removeDir(dir);
    dir = null;
  });

  async function replay(provider: CliProvider, name: string, version: string, help: string, fixture: string, over: Partial<CliInvocation> = {}): Promise<{ events: CliEvent[]; exit: CliExit }> {
    dir = tempDir();
    const path = makeFakeCli(dir, name, { version, help: fixturePath(`help/${help}`), fixture: fixturePath(fixture) });
    const binary = binaryFor(provider.id, path, version.split(" ")[0]!, [help]);
    ws = await createCliWorkspace({ root: join(dir, "aicad-cli"), runId: "r2" });
    const inv: CliInvocation = {
      runId: "3b241101-e2bb-4255-8caf-4136c566a962",
      mode: "completion",
      binary,
      workspace: ws,
      model: null,
      effort: null,
      systemPrompt: "system",
      prompt: "PROMPT",
      images: [],
      structured: null,
      mcp: null,
      resume: null,
      limits: { maxTurns: 3, wallMs: 20_000, stallMs: 10_000 },
      env: cliEnvForBinary(binary, { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir }, ws.tmp),
      ...over,
    };
    return drain(provider.run(inv));
  }

  it("S1 replay (live claude 2.1.260, Haiku): init passes, the model calls `classify` directly, Claude refuses it, the envelope still arrives", async () => {
    const { events, exit } = await replay(claude, "claude", "2.1.260 (Claude Code)", "claude-2.1.260.txt", "claude/unoffered-tool-call.jsonl", {
      structured: { via: "json-schema", schema: { type: "object" } },
    });
    expect(exit.failure, JSON.stringify(exit.failure)).toBeNull();
    expect(exit.reason).toBe("exited");
    expect(events.find((e) => e.type === "init")).toMatchObject({ tools: ["StructuredOutput"] });
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ qualifiedName: "classify", server: null });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true, text: expect.stringContaining("No such tool available: classify") });
    expect(events.some((e) => e.type === "warning" && /'classify'.*not a lockdown violation/.test(e.message))).toBe(true);
    expect(events.filter((e) => e.type === "structured").at(-1)).toMatchObject({ value: { text: "", tool_calls: [{ name: "classify", arguments: { kind: "quick_edit" } }] } });
    expect(exit.result).toMatchObject({ ok: true, turns: 3 });
  });

  it("the same stream through LLMGateway: the turn succeeds with the classify call and carries the warning", async () => {
    dir = tempDir();
    const path = makeFakeCli(dir, "claude", { fixture: fixturePath("claude/unoffered-tool-call.jsonl"), help: fixturePath("help/claude-2.1.260.txt") });
    const binary = binaryFor("claude-cli", path, "2.1.260", ["claude-2.1.260.txt"]);
    const d = dir;
    const parts = cliGatewayParts({ providers: ["claude-cli"], binary: async () => binary, env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: d }), workspaceRoot: join(d, "aicad-cli") });
    const gw = new LLMGateway({ profiles, adapters: parts.adapters, transports: parts.transports });
    const r = await gw.chat({ model: "claude-cli:haiku", system: [{ type: "text", text: "Triage." }], tools: [classify], messages: [{ role: "user", content: [{ type: "text", text: "make the plate 2 mm thicker" }] }] });
    const tool = r.message.content.find((b) => b.type === "tool_use");
    expect(tool?.type === "tool_use" ? [tool.name, tool.input] : null).toEqual(["classify", { kind: "quick_edit" }]);
    expect(r.warnings.some((w) => /'classify'.*not a lockdown violation/.test(w))).toBe(true);
  });

  it("Gemini and opencode replays of the real-binary refusals end without a failure", async () => {
    const g = await replay(gemini, "gemini", "0.49.0", "gemini-0.49.0.txt", "gemini/real-0.49.0-unavailable-tool.jsonl", {
      mcp: { serverName: "cad", command: "/bin/false", args: [], env: {}, ticketEnv: "AICAD_MCP_TICKET", toolNames: ["submit_turn"], callTimeoutMs: 1_000 },
    });
    expect(g.exit.failure, JSON.stringify(g.exit.failure)).toBeNull();
    expect(g.events.some((e) => e.type === "warning" && /'classify'/.test(e.message))).toBe(true);
    await ws?.dispose();
    ws = null;
    removeDir(dir!);
    const o = await replay(opencode, "opencode", "1.17.10", "opencode-run-1.17.10.txt", "opencode/real-1.17.10-unavailable-tool.jsonl", {
      mcp: { serverName: "cad", command: "/bin/false", args: [], env: {}, ticketEnv: "AICAD_MCP_TICKET", toolNames: ["submit_turn"], callTimeoutMs: 1_000 },
    });
    expect(o.exit.failure, JSON.stringify(o.exit.failure)).toBeNull();
    expect(o.events.some((e) => e.type === "warning" && /'classify'/.test(e.message))).toBe(true);
  });

  it("a denied built-in still ends the run as lockdown_violation (opencode bash, Gemini run_shell_command)", async () => {
    const o = await replay(opencode, "opencode", "1.17.10", "opencode-run-1.17.10.txt", "opencode/builtin-bash.jsonl");
    expect(o.exit.failure).toMatchObject({ code: "lockdown_violation" });
    await ws?.dispose();
    ws = null;
    removeDir(dir!);
    const g = await replay(gemini, "gemini", "0.49.0", "gemini-0.49.0.txt", "gemini/builtin-tool.jsonl");
    expect(g.exit.failure).toMatchObject({ code: "lockdown_violation" });
  });
});

describe("image media types are checked at runtime (review: mediaType reached file names and Gemini's argv)", () => {
  const png = "iVBORw0KGgo=";
  const withImage = (mediaType: string): Message[] => [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", mediaType, data: png } } as never] }];

  it("renderTranscript keeps the four image types and drops anything else with a warning", () => {
    const ok = renderTranscript(withImage("image/jpeg"), "0a1b2c3d", { images: true });
    expect(ok.images).toEqual([{ mediaType: "image/jpeg", data: png }]);
    const bad = renderTranscript(withImage("image/png @/etc/passwd"), "0a1b2c3d", { images: true });
    expect(bad.images).toEqual([]);
    expect(bad.text).toContain("[image omitted]");
    expect(bad.warnings.join()).toMatch(/only PNG, JPEG, WebP and GIF/);
  });

  it("file names come from a fixed map; buildArgs refuses a crafted type, so run() never spawns", () => {
    expect(cliImageFileName(1, "image/jpeg")).toBe("img-1.jpg");
    expect(cliImageFileName(2, "image/webp")).toBe("img-2.webp");
    expect(() => cliImageFileName(1, "image/png @/some/path")).toThrow(/unsupported image media type/);
    for (const [p, help] of [
      [gemini, "gemini-0.49.0.txt"],
      [codex, "codex-exec-0.156.1.synthetic.txt"],
      [opencode, "opencode-run-1.17.10.txt"],
    ] as const) {
      const b = fakeBinary(p.id, p.id === "codex-cli" ? "0.156.1" : p.id === "gemini-cli" ? "0.49.0" : "1.17.10", [help]);
      const inv = invocationFor(b, { images: [{ mediaType: "image/png @/some/path" as never, data: png }] });
      expect(() => p.buildArgs(inv), p.id).toThrow(/unsupported image media type/);
      const good = p.buildArgs(invocationFor(b, { images: [{ mediaType: "image/gif", data: png }] }));
      expect(good.files.map((f) => f.path)).toContain("img-1.gif");
    }
    const g = gemini.buildArgs(invocationFor(fakeBinary("gemini-cli", "0.49.0", ["gemini-0.49.0.txt"]), { images: [{ mediaType: "image/gif", data: png }] }));
    expect(g.args[1]).toBe("Follow the instructions in the message above. @img-1.gif");
  });
});

function invocationFor(binary: CliInvocation["binary"], over: Partial<CliInvocation> = {}): CliInvocation {
  return {
    runId: "3b241101-e2bb-4255-8caf-4136c566a962",
    mode: "completion",
    binary,
    workspace: { dir: "/ws/w", tmp: "/ws/w/.tmp", socketDir: "/s/ab12cd34", write: () => "", dispose: async () => {} },
    model: null,
    effort: null,
    systemPrompt: "system",
    prompt: "PROMPT",
    images: [],
    structured: null,
    mcp: null,
    resume: null,
    limits: { maxTurns: 3, wallMs: 20_000, stallMs: 10_000 },
    env: { PATH: "/usr/bin" },
    ...over,
  };
}

describe("opencode `mcp list` parsing (review: help text became a server named 'Add')", () => {
  it("the 1.17.10 empty-list output yields no server; the recorded list yields exactly the three servers", () => {
    expect(parseMcpList(readFixture("opencode/mcp-list-1.17.10-empty.txt"))).toEqual([]);
    expect(parseMcpList(readFixture("opencode/mcp-list-1.17.10-servers.txt"))).toEqual(["usersrv", "off.srv", "remote1"]);
    // Neither help text nor a changed layout produces a name.
    expect(parseMcpList("Add servers with: opencode mcp add\nNo MCP servers configured\nUsage: opencode mcp list\n")).toEqual([]);
  });

  it("buildArgs disables only real server names", () => {
    const b = fakeBinary("opencode", "1.17.10", ["opencode-run-1.17.10.txt"], "/opt/fake/bin/opencode-mcp");
    (opencode as unknown as { setUserMcpServers(p: string, n: readonly string[]): void }).setUserMcpServers(b.realPath, parseMcpList(readFixture("opencode/mcp-list-1.17.10-empty.txt")));
    const config = JSON.parse(opencode.buildArgs(invocationFor(b)).env["OPENCODE_CONFIG_CONTENT"]!) as { mcp: Record<string, unknown> };
    expect(config.mcp).toEqual({});
  });
});

describe("truncated replies (review: plain completions always said end_turn; opencode `length` became bad_output)", () => {
  async function chat(provider: CliProviderId, model: string, events: CliEvent[], request: Partial<ChatRequest> = {}) {
    const outcome: CliTurnOutcome = { provider, version: "x", events, exit: { code: 0, signal: null, reason: "exited" }, envelope: null, envelopeSource: null, failure: null, durationMs: 1 };
    const replayT = new ReplayTransport([{ provider, operation: "cli.turn", mode: "send", request: {}, response: outcome }]);
    const gw = new LLMGateway({ profiles, adapters: { [provider]: new CliAdapter(CLI_PROVIDERS.get(provider)!, { randomHex: (n) => "ab".repeat(n) }) }, transports: { [provider]: replayT } });
    return gw.chat({ model, tools: [], messages: [{ role: "user", content: [{ type: "text", text: "Describe the part." }] }], ...request });
  }

  it("Claude: a last turn with stop_reason max_tokens makes the plain reply max_tokens", async () => {
    const events: CliEvent[] = [
      { type: "init", sessionId: "s", model: "claude-haiku-4-5", version: "2.1.260", tools: [], mcpServers: [] },
      { type: "text", messageId: "m1", text: "The plate is 2 mm thicker and the fil", delta: false },
      { type: "turn", messageId: "m1", model: "claude-haiku-4-5", usage: null, stopReason: "max_tokens" },
      { type: "result", ok: true, subtype: "success", text: "The plate is 2 mm thicker and the fil", sessionId: "s", turns: 1, usage: null, costUsd: null, models: [], failure: null },
    ];
    const r = await chat("claude-cli", "claude-cli:haiku", events);
    expect(r.stopReason).toBe("max_tokens");
    const done = await chat("claude-cli", "claude-cli:haiku", events.map((e) => (e.type === "turn" ? { ...e, stopReason: "end_turn" as const } : e)));
    expect(done.stopReason).toBe("end_turn");
  });

  it("opencode (real 1.17.10 stream): a final `length` step is a truncated reply with a warning, not bad_output", async () => {
    const events = await parseFixture(opencode, "opencode/real-1.17.10-length.jsonl");
    const res = events.find((e) => e.type === "result");
    expect(res).toMatchObject({ ok: true, failure: null, text: "The plate is 2 mm thicker and the fil" });
    expect(events.some((e) => e.type === "warning" && /output limit/.test(e.message))).toBe(true);
    const r = await chat("opencode", opencodeProfile.id, events);
    expect(r.stopReason).toBe("max_tokens");
    expect(r.message.content).toEqual([{ type: "text", text: "The plate is 2 mm thicker and the fil" }]);
  });
});

describe("optional effort flags are passed only when --help lists them (review: --effort / --variant were not lockdown-checked)", () => {
  const without = (b: CliInvocation["binary"], flag: string): CliInvocation["binary"] => ({ ...b, help: { ...b.help, flags: new Set([...b.help.flags].filter((f) => f !== flag)) } });

  it("Claude --effort and opencode --variant: listed -> passed; missing -> omitted with a warning, never refused", () => {
    const c = fakeBinary("claude-cli", "2.1.300", ["claude-2.1.260.txt"]);
    expect(claude.buildArgs(invocationFor(c, { effort: "high" })).args).toContain("--effort=high");
    const cNo = claude.buildArgs(invocationFor(without(c, "--effort"), { effort: "high" }));
    expect(cNo.args.some((a) => a.startsWith("--effort"))).toBe(false);
    expect(cNo.warnings?.join()).toMatch(/does not list --effort/);
    expect(claude.lockdown(without(c, "--effort")).ok).toBe(true);
    const o = fakeBinary("opencode", "1.18.0", ["opencode-run-1.17.10.txt"]);
    expect(opencode.buildArgs(invocationFor(o, { effort: "high" })).args).toContain("--variant=high");
    const oNo = opencode.buildArgs(invocationFor(without(o, "--variant"), { effort: "high" }));
    expect(oNo.args.some((a) => a.startsWith("--variant"))).toBe(false);
    expect(oNo.warnings?.join()).toMatch(/does not list --variant/);
    // No effort, no warning.
    expect(claude.buildArgs(invocationFor(without(c, "--effort"))).warnings).toBeUndefined();
  });

  it("run() emits the buildArgs warning as an event before the CLI's own events", async () => {
    const dir = tempDir();
    try {
      const path = makeFakeCli(dir, "claude", { fixture: fixturePath("claude/completion-plain.jsonl"), help: fixturePath("help/claude-2.1.260.txt") });
      const b = binaryFor("claude-cli", path, "2.1.260", ["claude-2.1.260.txt"]);
      const ws = await createCliWorkspace({ root: join(dir, "aicad-cli"), runId: "eff" });
      try {
        const inv: CliInvocation = { ...invocationFor(without(b, "--effort"), { effort: "high" }), workspace: ws, env: cliEnvForBinary(b, { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir }, ws.tmp) };
        const { events, exit } = await drain(claude.run(inv));
        expect(exit.failure).toBeNull();
        expect(events[0]).toMatchObject({ type: "warning", message: expect.stringMatching(/does not list --effort/) });
      } finally {
        await ws.dispose();
      }
    } finally {
      removeDir(dir);
    }
  });
});
