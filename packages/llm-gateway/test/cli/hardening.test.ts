import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_CLI_PROFILES, BUILTIN_LOCAL_PROFILES, BUILTIN_PROFILES, profileFromDiscovery, smallModelForProfile } from "../../src/builtin-profiles.js";
import { CliAdapter, type CliTurnOutcome } from "../../src/cli/adapter.js";
import { cliEnvForBinary } from "../../src/cli/base.js";
import { finalAssistantText, type CliEvent, type CliResultEvent } from "../../src/cli/events.js";
import { tripwire } from "../../src/cli/lockdown.js";
import { ollamaContextCheck } from "../../src/cli/ollama.js";
import { parseMcpList } from "../../src/cli/opencode.js";
import { safeArgWord, safeModel, safeSessionId } from "../../src/cli/parse.js";
import type { CliBinary, CliExit, CliInvocation, CliLimits, CliProvider, CliRun } from "../../src/cli/provider.js";
import { CLI_PROVIDERS } from "../../src/cli/registry.js";
import { createCliWorkspace, createProbeDir, defaultWorkspaceRoot, setDefaultWorkspaceRoot, unsafeAncestor, type CliWorkspace } from "../../src/cli/workspace.js";
import { LLMGateway } from "../../src/gateway.js";
import { modelProfileSchema, profileKind, type ModelProfile } from "../../src/profile.js";
import { ReplayTransport } from "../../src/transport/transport.js";
import type { ChatRequest, CliProviderId } from "../../src/types.js";
import { binaryFor, fixturePath, linesOf, makeFakeCli, parseFixture, removeDir, tempDir, type FakeScenario } from "./helpers.js";

/** Review fixes (docs/CLI-PROVIDERS.md §16, 2026-09-24 review): each block names the finding it pins down. */

const claude = CLI_PROVIDERS.get("claude-cli")!;
const gemini = CLI_PROVIDERS.get("gemini-cli")!;
const codex = CLI_PROVIDERS.get("codex-cli")!;
const opencode = CLI_PROVIDERS.get("opencode")!;
const cursor = CLI_PROVIDERS.get("cursor-agent")!;

const lastResult = (events: CliEvent[]): CliResultEvent => {
  const r = events.filter((e): e is CliResultEvent => e.type === "result").at(-1);
  if (r === undefined) throw new Error("no result event");
  return r;
};

async function parseLines(provider: CliProvider, lines: string[]): Promise<CliEvent[]> {
  const out: CliEvent[] = [];
  for await (const e of provider.parseEvents(linesOf(lines.join("\n")), { mode: "completion", allowed: new Set(), serverName: "cad" })) out.push(e);
  return out;
}

async function drain(run: CliRun): Promise<{ events: CliEvent[]; exit: CliExit }> {
  const events: CliEvent[] = [];
  for await (const e of run.events) events.push(e);
  return { events, exit: await run.done };
}

const opencodeProfile = profileFromDiscovery("opencode", { modelArg: "mock/m1", displayName: "M1", vendor: "mock", family: "m1", tools: true, vision: false, contextWindow: null, billing: "subscription" });
const profiles: ModelProfile[] = [...BUILTIN_PROFILES, ...BUILTIN_CLI_PROFILES, opencodeProfile];

/** Replay a CliTurnOutcome through LLMGateway + CliAdapter for `provider`. */
async function chatOutcome(provider: CliProviderId, events: CliEvent[], request: ChatRequest): Promise<Awaited<ReturnType<LLMGateway["chat"]>>> {
  const outcome: CliTurnOutcome = { provider, version: "x", events, exit: { code: 0, signal: null, reason: "exited" }, envelope: null, envelopeSource: null, failure: null, durationMs: 1 };
  const replay = new ReplayTransport([{ provider, operation: "cli.turn", mode: "send", request: {}, response: outcome }]);
  const gw = new LLMGateway({ profiles, adapters: { [provider]: new CliAdapter(CLI_PROVIDERS.get(provider)!, { randomHex: (n) => "ab".repeat(n) }) }, transports: { [provider]: replay } });
  return gw.chat(request);
}
const plain = (model: string): ChatRequest => ({ model, tools: [], messages: [{ role: "user", content: [{ type: "text", text: "Say hi." }] }] });

describe("plain completions (no tools) return the final text for every CLI (review: Gemini returned empty content)", () => {
  it("Gemini: the reviewer's repro (init, two deltas, result) now yields 'Hello'", async () => {
    const events = await parseLines(gemini, [
      '{"type":"init","session_id":"c0ffee00-0000-4000-8000-000000000010","model":"gemini-3.5-flash"}',
      '{"type":"message","role":"assistant","content":"Hel","delta":true}',
      '{"type":"message","role":"assistant","content":"lo","delta":true}',
      '{"type":"result","status":"success","stats":{"total_tokens":130,"input_tokens":100,"output_tokens":10,"cached":0,"input":100,"models":{"gemini-3.5-flash":{}}}}',
    ]);
    expect(events.map((e) => e.type)).toEqual(["init", "text", "text", "turn", "result"]);
    expect(lastResult(events).text).toBe("Hello");
    expect(finalAssistantText(events)).toBe("Hello");
    const r = await chatOutcome("gemini-cli", events, plain("gemini-cli:flash"));
    expect(r.message.content).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("Gemini: recorded from the real 0.49.0 binary (fake responses), thinking tokens derived from total_tokens", async () => {
    const events = await parseFixture(gemini, "gemini/real-0.49.0-plain.jsonl");
    expect(lastResult(events)).toMatchObject({ ok: true, text: "pong", sessionId: "c0ffee00-0000-4000-8000-000000000003", models: ["gemini-3.5-flash"] });
    expect(lastResult(events).usage).toMatchObject({ inputTokens: 1000, outputTokens: 50, reasoningTokens: 30 });
    expect((await chatOutcome("gemini-cli", events, plain("gemini-cli:flash"))).message.content).toEqual([{ type: "text", text: "pong" }]);
  });

  it("opencode: recorded from the real 1.17.10 binary (mock provider)", async () => {
    const events = await parseFixture(opencode, "opencode/real-1.17.10-plain.jsonl");
    expect(lastResult(events)).toMatchObject({ ok: true, text: "pong" });
    expect((await chatOutcome("opencode", events, plain("opencode:mock/m1"))).message.content).toEqual([{ type: "text", text: "pong" }]);
  });

  it("Codex: agent_message text", async () => {
    const events = await parseFixture(codex, "codex/plain.jsonl");
    expect((await chatOutcome("codex-cli", events, plain("codex-cli:gpt-6-sol"))).message.content).toEqual([{ type: "text", text: "Hi there" }]);
  });

  it("Gemini text is restored after neutralization ('@' + U+200D -> '@')", async () => {
    const events = await parseLines(gemini, ['{"type":"init","session_id":"c0ffee00-0000-4000-8000-000000000011"}', '{"type":"message","role":"assistant","content":"use @\\u200daicad/std","delta":true}', '{"type":"result","status":"success","stats":{}}']);
    expect((await chatOutcome("gemini-cli", events, plain("gemini-cli:flash"))).message.content).toEqual([{ type: "text", text: "use @aicad/std" }]);
  });
});

describe("real-binary fixtures parse into the expected tool calls", () => {
  it("opencode mcp-submit (1.17.10): cad_submit_turn call + result, final text", async () => {
    const events = await parseFixture(opencode, "opencode/real-1.17.10-mcp-submit.jsonl");
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ qualifiedName: "cad_submit_turn", server: "cad", tool: "submit_turn", input: { text: "", tool_calls: [{ name: "classify", arguments: { kind: "quick_edit" } }] } });
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
    expect(lastResult(events)).toMatchObject({ ok: true, text: "Submitted.", turns: 2 });
  });

  it("Gemini mcp-submit (0.49.0): mcp_cad_submit_turn call + result, final text after the tool", async () => {
    const events = await parseFixture(gemini, "gemini/real-0.49.0-mcp-submit.jsonl");
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ qualifiedName: "mcp_cad_submit_turn", server: "cad", tool: "submit_turn" });
    expect(lastResult(events)).toMatchObject({ ok: true, text: "Submitted." });
  });
});

describe("Codex tripwire is an allowlist (review: unknown item types were ignored)", () => {
  it("todo_list is allowed; an unknown item type becomes built-in activity and trips the lockdown", async () => {
    const events = await parseFixture(codex, "codex/unknown-item.jsonl");
    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls).toEqual([{ type: "tool_call", callId: "item_1", qualifiedName: "image_generation", server: null, tool: "image_generation", input: null }]);
    expect(tripwire(calls[0]!, { allowed: new Set(), structuredToolName: null, expectMcp: "none" })).toMatchObject({ kind: "builtin_activity" });
  });
});

describe("opencode: early tripwire, recovered errors (review)", () => {
  it("a built-in tool is reported at its first sighting (pending), once, and trips before it completes", async () => {
    const events = await parseFixture(opencode, "opencode/running-builtin.jsonl");
    const kinds = events.map((e) => e.type);
    expect(kinds.filter((k) => k === "tool_call")).toHaveLength(1);
    expect(kinds.indexOf("tool_call")).toBeLessThan(kinds.indexOf("tool_result"));
    const call = events.find((e) => e.type === "tool_call")!;
    expect(tripwire(call, { allowed: new Set(["cad_submit_turn"]), structuredToolName: null, expectMcp: "cad" })).toMatchObject({ kind: "builtin_activity" });
  });

  it("a 429 retried by opencode, then a final stop step: success, the error kept as a warning", async () => {
    const events = await parseFixture(opencode, "opencode/recovered-429.jsonl");
    expect(lastResult(events)).toMatchObject({ ok: true, failure: null, text: "Submitted." });
    expect(events.some((e) => e.type === "warning" && /429|Rate limit/i.test(e.message))).toBe(true);
  });

  it("mcp list parsing skips the 1.17.10 summary line", () => {
    expect(parseMcpList("●  ✓ usersrv connected\n└  1 server(s)\n")).toEqual(["usersrv"]);
  });
});

describe("Claude side calls on another model (review: wrong providerModel, warning on every call)", () => {
  it("models are ranked by output tokens; the profile-family model is reported; no warning when one matches", async () => {
    const events = await parseFixture(claude, "claude/side-calls-result.jsonl");
    expect(lastResult(events).models).toEqual(["claude-opus-5-5", "claude-haiku-4-5-20251001"]);
    const opus = await chatOutcome("claude-cli", events, plain("claude-cli:opus"));
    expect(opus.providerModel).toBe("claude-opus-5-5");
    expect(opus.warnings.join(" ")).not.toMatch(/outside the profile's family/);
    const sonnet = await chatOutcome("claude-cli", events, plain("claude-cli:sonnet"));
    expect(sonnet.warnings.filter((w) => /outside the profile's family/.test(w))).toHaveLength(1);
  });
});

describe("argv values can never be read as flags (review)", () => {
  it("safeModel / safeSessionId / safeArgWord reject a leading '-'", () => {
    for (const bad of ["--yolo", "-m", "-"]) {
      expect(safeModel(bad)).toBeNull();
      expect(safeSessionId(bad)).toBeNull();
      expect(safeArgWord(bad)).toBeNull();
    }
    expect(safeModel("openrouter/qwen3-coder:free")).toBe("openrouter/qwen3-coder:free");
    expect(safeSessionId("ses_8a1b-2c")).toBe("ses_8a1b-2c");
    expect(safeArgWord("xhigh")).toBe("xhigh");
  });

  it("profiles with a flag-like cli.modelArg or effortArg are rejected", () => {
    const base = BUILTIN_CLI_PROFILES.find((p) => p.id === "claude-cli:opus")!;
    expect(modelProfileSchema.safeParse({ ...base, cli: { ...base.cli!, modelArg: "--yolo" } }).success).toBe(false);
    expect(modelProfileSchema.safeParse({ ...base, cli: { ...base.cli!, effortArg: { high: "--dangerously-skip-permissions" } } }).success).toBe(false);
    expect(modelProfileSchema.safeParse(base).success).toBe(true);
  });
});

describe("BaseCliProvider.run() re-checks the lockdown itself (review: only CliTransport did)", () => {
  let dir: string | null = null;
  let ws: CliWorkspace | null = null;
  afterEach(async () => {
    await ws?.dispose();
    ws = null;
    if (dir !== null) removeDir(dir);
    dir = null;
  });

  async function setup(provider: CliProvider, name: string, version: string, help: string, scenario: FakeScenario = {}): Promise<{ inv: CliInvocation; record: string; binary: CliBinary }> {
    dir = tempDir();
    const record = join(dir, "rec.json");
    const path = makeFakeCli(dir, name, { version, help: fixturePath(`help/${help}`), fixture: fixturePath("claude/completion-plain.jsonl"), record, ...scenario });
    const binary = binaryFor(provider.id, path, version.split(" ")[0]!, [help]);
    ws = await createCliWorkspace({ root: join(dir, "aicad-cli"), runId: "t" });
    const limits: CliLimits = { maxTurns: 3, wallMs: 20_000, stallMs: 10_000 };
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
      limits,
      env: cliEnvForBinary(binary, { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir }, ws.tmp),
    };
    return { inv, record, binary };
  }

  it("a blocked binary (Cursor: lockdown none) is refused without spawning", async () => {
    const { inv, record } = await setup(cursor, "cursor-agent", "2026.01.28", "cursor-agent-2026.01.28.txt");
    const { exit } = await drain(cursor.run(inv));
    expect(exit).toMatchObject({ reason: "spawn_failed", failure: { code: "unsupported" } });
    expect(exit.failure?.message).toMatch(/lockdown cannot be enforced/);
    expect(existsSync(record)).toBe(false);
  });

  it("a changed binary, a version below the minimum, and flag-like values are refused", async () => {
    const { inv, record } = await setup(claude, "claude", "2.1.260 (Claude Code)", "claude-2.1.260.txt");
    const cases: Array<[Partial<CliInvocation>, RegExp]> = [
      [{ binary: { ...inv.binary, stat: { size: 1, mtimeMs: 1 } } }, /changed since detection/],
      [{ binary: { ...inv.binary, version: "2.1.100" } }, /needs Claude Code >= 2\.1\.260/],
      [{ model: "--dangerously-skip-permissions" }, /model argument/],
      [{ effort: "-x" }, /effort argument/],
    ];
    for (const [over, message] of cases) {
      const { exit } = await drain(claude.run({ ...inv, ...over }));
      expect(exit.reason).toBe("spawn_failed");
      expect(exit.failure?.message).toMatch(message);
    }
    expect(existsSync(record)).toBe(false);
    // The unchanged invocation still runs.
    expect((await drain(claude.run(inv))).exit.failure).toBeNull();
  });

  it("cancel(run, 'lockdown') from the host carries lockdown_violation (§5.6)", async () => {
    const { inv } = await setup(claude, "claude", "2.1.260 (Claude Code)", "claude-2.1.260.txt", { mode: "hang" });
    const run = claude.run(inv);
    for await (const _ of run.events) break;
    const exit = await claude.cancel(run, "lockdown");
    expect(exit).toMatchObject({ reason: "killed", failure: { code: "lockdown_violation" } });
  });

  it("brokerBusy pauses the stall timer while a broker call is open, and restarts it when the call ends (§5.8)", async () => {
    const { inv } = await setup(claude, "claude", "2.1.260 (Claude Code)", "claude-2.1.260.txt", { mode: "stall" });
    const run = claude.run({ ...inv, limits: { maxTurns: 3, wallMs: 20_000, stallMs: 300 } });
    run.brokerBusy?.(true);
    const early = await Promise.race([run.done.then(() => "done"), new Promise((r) => setTimeout(() => r("running"), 1_200))]);
    expect(early).toBe("running");
    const ended = Date.now();
    run.brokerBusy?.(false);
    const { exit } = await drain(run);
    expect(exit).toMatchObject({ reason: "stalled", failure: { code: "stalled" } });
    expect(Date.now() - ended).toBeGreaterThanOrEqual(250);
  });
});

describe("session cleanup only runs verified commands on ids the CLI reported (review)", () => {
  let dirs: string[] = [];
  let ws: CliWorkspace | null = null;
  afterEach(() => {
    ws = null;
    for (const d of dirs) removeDir(d);
    dirs = [];
  });

  async function cleanupWith(provider: CliProvider, name: string, version: string, help: string[], sessionId: string | null, edit: (b: CliBinary) => CliBinary = (b) => b, mode: "completion" | "runtime" = "completion"): Promise<{ argv: string[]; cwd: string } | null> {
    const dir = tempDir();
    dirs.push(dir);
    const record = join(dir, "rec.json");
    const path = makeFakeCli(dir, name, { version, record });
    const binary = edit(binaryFor(provider.id, path, version, help));
    ws = await createCliWorkspace({ root: join(dir, "aicad-cli"), runId: "t", basename: "aicad-run" });
    const inv = { runId: "7c3e0000-0000-4000-8000-000000000000", mode, binary, workspace: ws, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir, AICAD_MCP_TICKET: "x".repeat(64) } } as unknown as CliInvocation;
    await provider.cleanup!(inv, sessionId);
    return existsSync(`${record}.cleanup`) ? (JSON.parse(readFileSync(`${record}.cleanup`, "utf8")) as { argv: string[]; cwd: string }) : null;
  }

  it("Gemini: never a guessed id, never one that parses as a number, only when --help lists --delete-session", async () => {
    expect(await cleanupWith(gemini, "gemini", "0.49.0", ["gemini-0.49.0.txt"], null)).toBeNull();
    expect(await cleanupWith(gemini, "gemini", "0.49.0", ["gemini-0.49.0.txt"], "7c3e0000-0000-4000-8000-000000000000")).toBeNull();
    const noFlag = (b: CliBinary): CliBinary => ({ ...b, help: { ...b.help, flags: new Set([...b.help.flags].filter((f) => f !== "--delete-session")) } });
    expect(await cleanupWith(gemini, "gemini", "0.49.0", ["gemini-0.49.0.txt"], "c0ffee00-0000-4000-8000-000000000000", noFlag)).toBeNull();
    const ok = await cleanupWith(gemini, "gemini", "0.49.0", ["gemini-0.49.0.txt"], "c0ffee00-0000-4000-8000-000000000000");
    expect(ok?.argv).toEqual(["--extensions=none", "--delete-session=c0ffee00-0000-4000-8000-000000000000"]);
    expect(ok?.cwd).toBe(ws!.dir);
  });

  it("Codex: runtime sessions only, and only when `codex --help` lists a delete command", async () => {
    const help = ["codex-exec-0.156.1.synthetic.txt"];
    const withDelete = (b: CliBinary): CliBinary => ({ ...b, help: { ...b.help, subcommands: new Set([...b.help.subcommands, "delete"]) } });
    expect(await cleanupWith(codex, "codex", "0.156.1", help, "0199a213-81c0", (b) => b, "runtime")).toBeNull();
    expect(await cleanupWith(codex, "codex", "0.156.1", help, "0199a213-81c0", withDelete, "completion")).toBeNull();
    expect((await cleanupWith(codex, "codex", "0.156.1", help, "0199a213-81c0", withDelete, "runtime"))?.argv).toEqual(["delete", "0199a213-81c0"]);
  });
});

describe("workspace and probe root never sit under a folder other users can write (review, §5.4)", () => {
  const saved = { TMPDIR: process.env["TMPDIR"], XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"] };
  let dir: string | null = null;
  afterEach(() => {
    setDefaultWorkspaceRoot(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (dir !== null) removeDir(dir);
    dir = null;
  });

  it.skipIf(process.platform === "win32")("unsafeAncestor finds a group/other-writable parent", () => {
    dir = tempDir();
    const shared = join(dir, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    expect(unsafeAncestor(join(shared, "aicad-cli", "x"))).toBe(shared);
    chmodSync(shared, 0o700);
    expect(unsafeAncestor(join(shared, "aicad-cli"))).toBe(unsafeAncestor(dirname(shared)));
  });

  it.skipIf(process.platform === "win32")("a world-writable TMPDIR (Linux /tmp) is not used for the default root", () => {
    dir = tempDir();
    const shared = join(dir, "tmp");
    mkdirSync(shared);
    chmodSync(shared, 0o1777);
    process.env["TMPDIR"] = shared;
    delete process.env["XDG_RUNTIME_DIR"];
    const root = defaultWorkspaceRoot();
    expect(root.startsWith(shared)).toBe(false);
    expect(root.endsWith("aicad-cli")).toBe(true);
  });

  it("the host can pin the root (app userData); probe dirs are private and live under it", () => {
    dir = tempDir();
    expect(() => setDefaultWorkspaceRoot("relative/path")).toThrow(/absolute/);
    setDefaultWorkspaceRoot(join(dir, "cli-work"));
    expect(defaultWorkspaceRoot()).toBe(join(dir, "cli-work"));
    const probe = createProbeDir();
    expect(dirname(probe)).toBe(join(dir, "cli-work"));
    if (process.platform !== "win32") expect(statSync(probe).mode & 0o777).toBe(0o700);
  });

  it("opencode probes run with OPENCODE_DISABLE_PROJECT_CONFIG=1 and --pure, in a dir under the root", async () => {
    dir = tempDir();
    const record = join(dir, "rec.json");
    const path = makeFakeCli(dir, "opencode", { version: "1.17.10", help: fixturePath("help/opencode-run-1.17.10.txt"), record });
    setDefaultWorkspaceRoot(join(dir, "aicad-cli"));
    const det = await opencode.detect({ overridePath: path, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir }, extraDirs: [], loginShell: false });
    expect(det.status).toBe("ready");
    const rec = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; env: Record<string, string>; cwd: string };
    expect(rec.argv).toEqual(["mcp", "list", "--pure"]);
    expect(rec.env["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe("1");
    expect(rec.cwd.startsWith(join(dir, "aicad-cli"))).toBe(true);
  });
});

describe("local profiles (review: routed as openai-compat, num_ctx unchecked)", () => {
  const local = BUILTIN_LOCAL_PROFILES[0]!;
  const fetchPs = (models: unknown[]) => async () => ({ ok: true, status: 200, json: async () => ({ models }) });

  it("profileKind and smallModelForProfile treat ollama:* profiles as local", () => {
    expect(local.provider).toBe("openai-compat");
    expect(profileKind(local)).toBe("local");
    expect(profileKind(BUILTIN_PROFILES[0]!)).toBe("api");
    expect(profileKind(BUILTIN_CLI_PROFILES[0]!)).toBe("cli");
    expect(smallModelForProfile(local)).toBeNull();
  });

  it("ollamaContextCheck warns when the loaded context is below local.numCtx; unknown when not loaded", async () => {
    const low = await ollamaContextCheck(local, { fetch: fetchPs([{ name: local.local!.tag, context_length: 4096 }]) });
    expect(low).toMatchObject({ ok: false, loadedContext: 4096, required: local.local!.numCtx });
    expect(low.warning).toMatch(/OLLAMA_CONTEXT_LENGTH/);
    expect(await ollamaContextCheck(local, { fetch: fetchPs([{ name: local.local!.tag, context_length: 65_536 }]) })).toMatchObject({ ok: true, warning: null });
    expect(await ollamaContextCheck(local, { fetch: fetchPs([]) })).toMatchObject({ ok: null, warning: null });
    expect(await ollamaContextCheck(local, { fetch: async () => Promise.reject(new Error("refused")) })).toMatchObject({ ok: null });
  });
});
