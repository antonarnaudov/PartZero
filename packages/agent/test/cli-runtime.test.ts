/**
 * End to end, offline (docs/CLI-PROVIDERS.md §13.1 "Fake CLI" scenarios): the real
 * `ClaudeCliProvider` (detect, buildArgs, spawn, parser, tripwires, timers), `CliAgentRuntime`, the
 * real MCP host (broker + the built `aicad-mcp` shim) and the real `AgentRun`, with a fake `claude`
 * binary that makes real MCP calls. Also completion mode through `LLMGateway` + `CliAdapter` +
 * `CliTransport` against the same binary.
 */
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_CLI_PROFILES, LLMGateway } from "@aicad/llm-gateway";
import { ClaudeCliProvider, cliGatewayParts, type CliCapabilities, type CliCommand, type CliEvent, type CliInvocation, type CliProvider, type ParseContext } from "@aicad/llm-gateway/cli";
import { CliAgentRuntime, RUNTIME_VERIFIED_PROVIDERS } from "../src/cli-runtime.js";
import { Agent, resolvePhaseMode, RuntimeUnsupportedError, type AgentOptions, type AgentResult } from "../src/index.js";
import { FakeClaude, isAlive, skipRealBroker, until, type FakeClaudeScenario, type FakeMsg } from "./cli-harness.js";
import { CLI_TEST_PROFILES } from "./fake-runtime.js";
import { fakeClock, fixtureEngine } from "./helpers.js";
import { PLATE_OK, PLATE_OPEN, PLATE_THICK, SLAB_10, WASHER } from "./scenarios.js";
import { WASHER_REQS, WASHER_TESTS } from "./scripts.js";

let fake: FakeClaude | undefined;
afterEach(() => {
  fake?.dispose();
  fake = undefined;
});

const apply = (args: Record<string, unknown>, extra: Partial<FakeMsg> = {}): FakeMsg => ({ calls: [{ name: "apply_cadscript", args }], ...extra });
const propose = (summary: string): FakeMsg => ({ calls: [{ name: "propose", args: { summary, assumptions: [], known_issues: [] } }] });
const PLATE = { prompt: "Make the plate 10 mm thick.", context: PLATE_OK, name: "plate" };

async function runAgent(scenario: FakeClaudeScenario, options: Partial<AgentOptions> = {}, request = PLATE): Promise<{ r: AgentResult; gateway: LLMGateway; fake: FakeClaude }> {
  fake = new FakeClaude(scenario);
  const gateway = new LLMGateway({ profiles: CLI_TEST_PROFILES });
  const agent = new Agent({ gateway, engine: fixtureEngine(), now: fakeClock(), models: { designer: "claude-cli:haiku" }, runtime: fake.runtime(), kind: "quick_edit", ...options });
  const r = await agent.run(request);
  return { r, gateway, fake };
}

describe.skipIf(skipRealBroker())("CliAgentRuntime + fake Claude Code + real broker and shim", () => {
  it("the proposal is accepted through the broker, which closes; the CLI exits; nothing is left behind", async () => {
    const { r, gateway, fake } = await runAgent({ runtime: { build: { turns: [[apply({ patches: [SLAB_10] }), propose("Plate is now 10 mm thick."), { text: "Done." }]] } } });
    expect(r.status, r.message).toBe("proposed");
    expect(r.cadscript).toBe(PLATE_THICK);

    // The invocation: runtime flags, lockdown flags, no prompt or ticket in argv, allowlisted env.
    const [inv] = fake.invocations();
    expect(inv!.mode).toBe("runtime");
    const argv = inv!.argv;
    for (const f of ["-p", "--restricted", "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence"]) expect(argv).toContain(f);
    expect(argv.slice(argv.indexOf("--input-format"), argv.indexOf("--input-format") + 2)).toEqual(["--input-format", "stream-json"]);
    expect(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(argv.slice(argv.indexOf("--allowedTools"), argv.indexOf("--allowedTools") + 2)).toEqual(["--allowedTools", "mcp__cad"]);
    expect(argv.slice(argv.indexOf("--max-turns"), argv.indexOf("--max-turns") + 2)).toEqual(["--max-turns", "42"]);
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("1.5000");
    expect(argv).toContain("--model=haiku");
    expect(argv.join(" ")).not.toContain("Make the plate");
    expect(inv!.hasTicket).toBe(true);
    expect(inv!.envNames).not.toContain("ANTHROPIC_API_KEY");
    expect(inv!.envNames).not.toContain("CI");
    expect(inv!.envNames).toContain("MCP_TOOL_TIMEOUT");
    expect(inv!.claudeTmp).not.toBeNull();
    expect(inv!.claudeTmp!.startsWith(fake.dir)).toBe(true);
    expect(inv!.tmpdir!.startsWith(fake.dir)).toBe(true);
    // System prompt = designer prompt + reference + the runtime appendix with Claude's tool names.
    expect(inv!.system).toContain("You are the designer");
    expect(inv!.system).toContain("`mcp__cad__apply_cadscript`");

    // Real MCP calls through the shim and the broker, into AgentRun's #execute.
    const [phase] = fake.phases();
    expect(phase!.tools).toEqual(["apply_cadscript", "ask_user", "checkpoint", "get_code", "ir_summary", "measure", "propose", "rollback", "run_tests"]);
    const calls = fake.calls();
    expect(calls.map((c) => c.name)).toEqual(["apply_cadscript", "propose"]);
    expect(calls[0]!.text).toMatch(/^apply #1: OK/);
    expect(calls[1]!.text).toMatch(/\[orchestrator [0-9a-f]{16}\] Proposal accepted\. The task is complete\.$/);

    // Processes gone, workspace and socket dir removed.
    expect(await until(() => !isAlive(phase!.pid) && !isAlive(phase!.mcpPid))).toBe(true);
    expect(fake.leftoverWorkspaces()).toEqual([]);

    // Accounting: per-turn estimates (claude-cli:haiku notional pricing), the CLI-reported total settled once.
    const runtimeCalls = r.trace.llmCalls;
    expect(runtimeCalls).toBe(3);
    const external = gateway.ledger.filter((e) => e.source === "external");
    expect(external).toHaveLength(1);
    // The fake reports cumulative list-price cost: 3 messages × (1000 in, 100 out) at $1/$5 per MTok.
    expect(external[0]!.costUsd).toBeCloseTo(0.0045, 8);
    expect(r.costUsd).toBeCloseTo(0.0045, 8);
    expect(r.billing).toBe("subscription");
    expect(r.events.some((e) => e.type === "note" && /designer CLI phase \(claude-cli 2\.1\.260, lockdown verified\).*\[provider\]/.test(e.text))).toBe(true);

    // The transcript's tool results come from the broker's log.
    const designer = r.conversations.designer!;
    const results = designer.flatMap((m) => (m.role === "user" ? m.content.filter((b) => b.type === "tool_result") : []));
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ toolName: "propose" });
  });

  it("same_error closes the broker, calls after the close are refused, and the process group is killed", async () => {
    const t0 = Date.now();
    const { r, fake } = await runAgent({
      runtime: {
        build: {
          turns: [[apply({ source: PLATE_OPEN }), apply({ source: PLATE_OPEN }), { calls: [{ name: "get_code" }, { name: "get_code" }, { name: "get_code" }] }, { hang: true }]],
        },
      },
    });
    expect(r.stopReason).toBe("same_error");
    expect(r.cadscript).toBe(PLATE_OK);
    const calls = fake.calls();
    expect(calls[1]!.text).toContain("The same error occurred twice in a row; the task stops here.");
    // After the close: the broker's own text with the run's tag, never the handler.
    expect(calls.slice(2).every((c) => c.isError && /^\[orchestrator [0-9a-f]{16}\] The task has ended \(same_error\)/.test(c.text))).toBe(true);
    const [phase] = fake.phases();
    expect(await until(() => !isAlive(phase!.pid) && !isAlive(phase!.mcpPid))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(r.trace.applies).toBe(2);
  });

  it("nudges go to the running CLI over stdin (stream-json); after them the implicit proposal is accepted", async () => {
    const { r, fake } = await runAgent({
      runtime: { build: { turns: [[apply({ patches: [SLAB_10] }), { text: "The plate is 10 mm now." }], [{ text: "Done." }], [{ text: "Finished: 10 mm plate." }]] } },
    });
    expect(r.status, r.message).toBe("proposed");
    expect(r.cadscript).toBe(PLATE_THICK);
    expect(r.proposal!.summary).toBe("Finished: 10 mm plate.");
    const turns = fake.turns();
    expect(turns).toHaveLength(3);
    expect(turns[0]!.user).toContain("<request>\nMake the plate 10 mm thick.\n</request>");
    expect(turns[1]!.user).toMatch(/^\[orchestrator [0-9a-f]{16}\] No tool call in your last turn/);
    expect(turns[2]!.user).toMatch(/No tool call in your last turn/);
    // One process for the whole phase (multi-turn through stdin, not resume).
    expect(fake.invocations()).toHaveLength(1);
    const designer = r.conversations.designer!;
    expect(designer.filter((m) => m.role === "user" && m.content.some((b) => b.type === "text" && b.text.includes("No tool call")))).toHaveLength(2);
  });

  it("cancel: the AbortSignal kills the whole process group and the run stops as cancelled", async () => {
    const controller = new AbortController();
    const scenario: FakeClaudeScenario = { runtime: { build: { turns: [[apply({ patches: [SLAB_10] }), { sleepMs: 60_000 }]] } } };
    fake = new FakeClaude(scenario);
    const f = fake;
    const gateway = new LLMGateway({ profiles: CLI_TEST_PROFILES });
    const agent = new Agent({ gateway, engine: fixtureEngine(), now: fakeClock(), models: { designer: "claude-cli:haiku" }, runtime: f.runtime(), kind: "quick_edit", signal: controller.signal });
    const running = agent.run(PLATE);
    expect(await until(() => f.calls().length === 1, 20_000)).toBe(true);
    controller.abort();
    const r = await running;
    expect(r.stopReason).toBe("cancelled");
    expect(r.cadscript).toBe(PLATE_THICK); // the best verified state
    const [phase] = f.phases();
    expect(await until(() => !isAlive(phase!.pid) && !isAlive(phase!.mcpPid))).toBe(true);
    expect(f.leftoverWorkspaces()).toEqual([]);
  });

  it("the budget gate stops the run from inside a tool call (the estimate of the running phase counts)", async () => {
    // claude-cli:opus notional pricing is $4/MTok input: 250k tokens ≈ $1 against a $1 cap.
    const { r, fake } = await runAgent(
      { runtime: { build: { turns: [[apply({ patches: [SLAB_10] }, { usage: { input: 250_000, output: 50 } }), { calls: [{ name: "run_tests" }] }, propose("never")]] } } },
      { models: { designer: "claude-cli:opus" }, budgetUsd: 1 },
    );
    expect(r.stopReason).toBe("budget");
    const calls = fake.calls();
    expect(calls[0]!.text).toMatch(/^apply #1: OK/);
    expect(calls[1]!.text).toMatch(/Not executed: the task has ended \(budget\)/);
  });

  it("a tripwire fires when the CLI exposes a tool outside ours (init.tools has Bash): lockdown_violation", async () => {
    const { r, fake } = await runAgent({ runtime: { build: { extraTools: ["Bash"], turns: [[{ sleepMs: 3_000 }, apply({ patches: [SLAB_10] })]] } } });
    expect(r.status).toBe("failed");
    expect(r.stopReason).toBe("lockdown_violation");
    expect(r.message).toContain("Bash");
    expect(fake.calls()).toHaveLength(0);
    expect(r.cadscript).toBe(PLATE_OK);
    const [phase] = fake.phases();
    expect(await until(() => !isAlive(phase!.pid) && !isAlive(phase!.mcpPid))).toBe(true);
  });

  it("plan usage from rate_limit_event reaches the hook and the result", async () => {
    const seen: string[] = [];
    const { r } = await runAgent(
      {
        runtime: {
          build: {
            planUsage: { status: "allowed", resetsAt: 1790000000, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 12, resetsAt: 1790000000 } } },
            turns: [[apply({ patches: [SLAB_10] }), propose("ok")]],
          },
        },
      },
      { hooks: { onPlanUsage: (u) => seen.push(u.status) } },
    );
    expect(r.status, r.message).toBe("proposed");
    expect(seen).toEqual(["allowed"]);
    expect(r.planUsage).toMatchObject({ provider: "claude-cli", status: "allowed", windows: [{ id: "five_hour", utilization: 0.12 }] });
  });

  it("SPEC and BUILD run in separate processes with separate brokers; the spec writer sees only its own scope", async () => {
    const { r, fake } = await runAgent(
      {
        runtime: {
          spec: {
            turns: [
              [
                { text: "Tests first.", calls: [{ name: "set_spec_tests", args: { tests: WASHER_TESTS } }] },
                { calls: [{ name: "submit_spec", args: { summary: "An M3 washer.", requirements: WASHER_REQS, assumptions: [], key_dimensions: [] } }] },
                { text: "Submitted." },
              ],
            ],
          },
          build: { turns: [[apply({ source: WASHER }), propose("An M3 washer.")]] },
        },
      },
      { kind: "design" },
      { prompt: "Can you make me a washer for M3 screws? 3.2 mm hole, 7 mm outside diameter, 1 mm thick.", context: undefined as unknown as string, name: "t1-m3-washer" },
    );
    expect(r.status, r.message).toBe("proposed");
    expect(r.tests!.every((t) => t.pass)).toBe(true);
    const phases = fake.phases();
    expect(phases.map((p) => p.phase)).toEqual(["spec", "build"]);
    expect(phases[0]!.tools).toEqual(["set_spec_tests", "submit_spec"]);
    expect(phases[0]!.pid).not.toBe(phases[1]!.pid);
    const [specInv, buildInv] = fake.invocations();
    expect(specInv!.cwd).not.toBe(buildInv!.cwd);
    expect(specInv!.system).not.toContain("You are the designer");
    expect(specInv!.system).toContain("`mcp__cad__set_spec_tests`");
    expect(specInv!.argv[specInv!.argv.indexOf("--max-turns") + 1]).toBe("10");
    // Isolation: the spec writer's first message never carries the designer's orchestrator tag.
    const turns = fake.turns();
    const designerTag = /\[orchestrator ([0-9a-f]{16})\]/.exec(turns.find((t) => t.phase === "build")!.user)![1];
    expect(turns.find((t) => t.phase === "spec")!.user).not.toContain(designerTag);
    expect(r.trace.costByRole.spec_writer).toBeGreaterThan(0);
  });
});

/** Claude's dialect, but continued like Gemini/Codex/opencode: one process per turn, `--resume <session>`. */
class ResumingClaude extends ClaudeCliProvider {
  override readonly capabilities: CliCapabilities = { ...new ClaudeCliProvider().capabilities, multiTurn: "resume" };
  readonly cleaned: Array<string | null> = [];
  override buildArgs(inv: CliInvocation): CliCommand {
    const cmd = super.buildArgs({ ...inv, resume: null });
    return inv.resume === null ? cmd : { ...cmd, args: [...cmd.args, "--resume", inv.resume.sessionId] };
  }
  async cleanup(_inv: CliInvocation, sessionId: string | null): Promise<void> {
    this.cleaned.push(sessionId);
  }
}

/**
 * Claude with the result's `stop_reason` on the result event: the additive gateway field the runtime reads
 * (`CliResultEvent.stopReason`). Claude's `assistant` events always say null; only the result has the real one.
 */
class ResultStopClaude extends ClaudeCliProvider {
  override async *parseEvents(lines: AsyncIterable<string>, ctx: ParseContext): AsyncGenerator<CliEvent> {
    const stops: string[] = [];
    const tapped = (async function* (): AsyncGenerator<string> {
      for await (const line of lines) {
        try {
          const o = JSON.parse(line) as { type?: unknown; stop_reason?: unknown };
          if (o.type === "result" && typeof o.stop_reason === "string") stops.push(o.stop_reason);
        } catch {
          // not JSON: the parser reports it
        }
        yield line;
      }
    })();
    for await (const e of super.parseEvents(tapped, ctx)) yield e.type === "result" ? ({ ...e, stopReason: stops.shift() ?? null } as CliEvent) : e;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Claude with an MCP call timeout too short for a question (like opencode today, §15 O2). */
class ShortCallClaude extends ClaudeCliProvider {
  override readonly capabilities: CliCapabilities = { ...new ClaudeCliProvider().capabilities, maxToolCallMs: 120_000 };
}

describe.skipIf(skipRealBroker())("CliAgentRuntime: provider capabilities", () => {
  it("resume-style CLIs: a nudge starts a new process on the same session and broker; costs add up per process; cleanup runs", async () => {
    const provider = new ResumingClaude();
    fake = new FakeClaude({
      runtime: { build: { exitAfterTurn: true, turns: [[apply({ patches: [SLAB_10] }), { text: "The plate is 10 mm now." }], [propose("Plate is now 10 mm thick.")]] } },
    });
    const gateway = new LLMGateway({ profiles: CLI_TEST_PROFILES });
    const runtime = fake.runtime({ providers: new Map<"claude-cli", CliProvider>([["claude-cli", provider]]) });
    const agent = new Agent({ gateway, engine: fixtureEngine(), now: fakeClock(), models: { designer: "claude-cli:haiku" }, runtime, kind: "quick_edit" });
    const r = await agent.run(PLATE);
    expect(r.status, r.message).toBe("proposed");
    expect(r.cadscript).toBe(PLATE_THICK);
    const invs = fake.invocations();
    expect(invs).toHaveLength(2);
    expect(invs[0]!.cwd).toBe(invs[1]!.cwd); // same workspace (Gemini keys sessions by path)
    expect(fake.resumes()).toEqual([{ phase: "build", sessionId: "00000000-0000-4000-8000-00000000fa4e", pid: invs[1]!.pid }]);
    expect(fake.turns().map((t) => t.index)).toEqual([0, 1]);
    expect(fake.turns()[1]!.user).toMatch(/No tool call in your last turn/);
    expect(fake.calls().map((c) => c.name)).toEqual(["apply_cadscript", "propose"]);
    // Two processes, each reporting its own total: 2 × 1000 in + 2 × 100 out, then 1000 + 100 (at $1/$5 per MTok).
    const external = gateway.ledger.filter((e) => e.source === "external");
    expect(external).toHaveLength(1);
    expect(external[0]!.costUsd).toBeCloseTo(0.003 + 0.0015, 8);
    expect(provider.cleaned).toEqual(["00000000-0000-4000-8000-00000000fa4e"]);
  });

  it("ask_user leaves the design scope when the CLI's MCP call timeout cannot hold the question wait", async () => {
    fake = new FakeClaude({ runtime: { build: { turns: [[apply({ patches: [SLAB_10] }), propose("ok")]] } } });
    const gateway = new LLMGateway({ profiles: CLI_TEST_PROFILES });
    const runtime = fake.runtime({ providers: new Map<"claude-cli", CliProvider>([["claude-cli", new ShortCallClaude()]]) });
    const agent = new Agent({ gateway, engine: fixtureEngine(), now: fakeClock(), models: { designer: "claude-cli:haiku" }, runtime, kind: "quick_edit" });
    const r = await agent.run(PLATE);
    expect(r.status, r.message).toBe("proposed");
    expect(fake.phases()[0]!.tools).not.toContain("ask_user");
    expect(fake.phases()[0]!.tools).toContain("apply_cadscript");
    expect(r.events.some((e) => e.type === "note" && e.text.includes("ask_user is not offered"))).toBe(true);
  });
});

describe.skipIf(skipRealBroker())("CliAgentRuntime: user waits, resumed processes, stop reasons", () => {
  it("ask_user: the wall clock is held while the user answers (answer after 4 s, BUILD wall 2.5 s)", async () => {
    const t0 = Date.now();
    const { r, fake } = await runAgent(
      {
        runtime: {
          build: {
            turns: [[{ calls: [{ name: "ask_user", args: { questions: [{ id: "q1", question: "Keep the mounting holes?", default: "yes" }] } }] }, apply({ patches: [SLAB_10] }), propose("Plate is now 10 mm thick.")]],
          },
        },
      },
      {
        mode: "interactive",
        askUser: async (qs) => {
          await sleep(4_000);
          return qs.map(() => "yes, keep them");
        },
        cliLimits: { BUILD: { wallMs: 2_500 } },
      },
    );
    expect(r.status, r.message).toBe("proposed");
    expect(Date.now() - t0).toBeGreaterThan(4_000);
    const calls = fake.calls();
    expect(calls.map((c) => c.name)).toEqual(["ask_user", "apply_cadscript", "propose"]);
    expect(calls[0]!.text).toContain("answer: yes, keep them");
    expect(r.clarifications).toEqual([expect.objectContaining({ answer: "yes, keep them" })]);
  });

  it("the interactive budget checkpoint: the wall clock is held while the user decides (4 s, BUILD wall 2.5 s)", async () => {
    const seen: number[] = [];
    const { r, fake } = await runAgent(
      // claude-cli:opus notional pricing is $4/MTok input: 210k tokens ≈ $0.84, over 80 % of a $1 cap.
      { runtime: { build: { turns: [[apply({ patches: [SLAB_10] }, { usage: { input: 210_000, output: 50 } }), { calls: [{ name: "run_tests" }] }, propose("Plate is now 10 mm thick.")]] } } },
      {
        models: { designer: "claude-cli:opus" },
        budgetUsd: 1,
        mode: "interactive",
        askUser: () => [],
        hooks: {
          onBudgetCheckpoint: async (info) => {
            seen.push(info.spentUsd);
            await sleep(4_000);
            return true;
          },
        },
        cliLimits: { BUILD: { wallMs: 2_500 } },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(0.8);
    expect(r.status, r.message).toBe("proposed");
    expect(fake.calls().map((c) => c.name)).toEqual(["apply_cadscript", "run_tests", "propose"]);
  });

  it("resume-style CLIs: 5 processes in one phase, tool calls alternating with text-only turn ends; each process has its own broker", async () => {
    const provider = new ResumingClaude();
    fake = new FakeClaude({
      runtime: {
        build: {
          exitAfterTurn: true,
          turns: [
            [apply({ patches: [SLAB_10] }), { text: "The plate is thicker." }],
            [{ calls: [{ name: "get_code" }] }, { text: "I read the code." }],
            [{ calls: [{ name: "ir_summary" }] }, { text: "I read the IR." }],
            [{ calls: [{ name: "get_code" }] }, { text: "Still 10 mm." }],
            [propose("Plate is now 10 mm thick.")],
          ],
        },
      },
    });
    const gateway = new LLMGateway({ profiles: CLI_TEST_PROFILES });
    const runtime = fake.runtime({ providers: new Map<"claude-cli", CliProvider>([["claude-cli", provider]]) });
    const agent = new Agent({ gateway, engine: fixtureEngine(), now: fakeClock(), models: { designer: "claude-cli:haiku" }, runtime, kind: "quick_edit" });
    const r = await agent.run(PLATE);
    expect(r.status, r.message).toBe("proposed");
    expect(r.cadscript).toBe(PLATE_THICK);

    const invs = fake.invocations();
    expect(invs).toHaveLength(5);
    expect(new Set(invs.map((i) => i.pid)).size).toBe(5);
    expect(invs.every((i) => i.hasTicket && i.cwd === invs[0]!.cwd)).toBe(true);
    expect(fake.resumes()).toHaveLength(4);
    // Every process's MCP server connected (a refused shim would list no tools and trip mcp_not_connected).
    const phases = fake.phases();
    expect(phases).toHaveLength(5);
    expect(phases.every((p) => p.tools.includes("apply_cadscript"))).toBe(true);
    expect(fake.calls().map((c) => [c.name, c.isError])).toEqual([
      ["apply_cadscript", false],
      ["get_code", false],
      ["ir_summary", false],
      ["get_code", false],
      ["propose", false],
    ]);
    expect(fake.turns().slice(1).every((t) => /No tool call in your last turn/.test(t.user))).toBe(true);
    // The transcript's results come from five brokers' logs, in process order.
    const results = r.conversations.designer!.flatMap((m) => (m.role === "user" ? m.content.filter((b) => b.type === "tool_result") : []));
    expect(results.map((b) => (b.type === "tool_result" ? b.content : ""))).toEqual(fake.calls().map((c) => c.text));
    // One charge: the five processes' own totals (turn k of the scripted chain reports its process's messages).
    expect(gateway.ledger.filter((e) => e.source === "external")).toHaveLength(1);
    for (const p of phases) expect(await until(() => !isAlive(p.pid) && !isAlive(p.mcpPid))).toBe(true);
    expect(fake.leftoverWorkspaces()).toEqual([]);
    expect(provider.cleaned).toEqual(["00000000-0000-4000-8000-00000000fa4e"]);
  });

  it("resume-style CLIs: the phase's call limit carries over from broker to broker", async () => {
    fake = new FakeClaude({
      runtime: {
        build: {
          exitAfterTurn: true,
          turns: [
            [apply({ patches: [SLAB_10] }), { text: "Thicker." }],
            [{ calls: [{ name: "get_code" }] }, { text: "Read it." }],
            [{ calls: [{ name: "ir_summary" }] }, { text: "Read it again." }],
            [propose("never reached")],
          ],
        },
      },
    });
    const gateway = new LLMGateway({ profiles: CLI_TEST_PROFILES });
    const runtime = fake.runtime({ providers: new Map<"claude-cli", CliProvider>([["claude-cli", new ResumingClaude()]]), brokerLimits: { maxCalls: 3 } });
    const agent = new Agent({ gateway, engine: fixtureEngine(), now: fakeClock(), models: { designer: "claude-cli:haiku" }, runtime, kind: "quick_edit" });
    const r = await agent.run(PLATE);
    expect(r.stopReason).toBe("max_turns");
    expect(r.message).toMatch(/call limit/);
    expect(fake.invocations()).toHaveLength(3);
    expect(fake.calls().map((c) => c.name)).toEqual(["apply_cadscript", "get_code", "ir_summary"]);
    expect(r.cadscript).toBe(PLATE_THICK); // the best verified state
  });

  it("max_tokens on the CLI's result picks the 'smaller steps' nudge", async () => {
    fake = new FakeClaude({ runtime: { build: { resultStop: ["max_tokens"], turns: [[apply({ patches: [SLAB_10] }), { text: "Next I will" }], [propose("Plate is now 10 mm thick.")]] } } });
    const gateway = new LLMGateway({ profiles: CLI_TEST_PROFILES });
    const runtime = fake.runtime({ providers: new Map<"claude-cli", CliProvider>([["claude-cli", new ResultStopClaude()]]) });
    const agent = new Agent({ gateway, engine: fixtureEngine(), now: fakeClock(), models: { designer: "claude-cli:haiku" }, runtime, kind: "quick_edit" });
    const r = await agent.run(PLATE);
    expect(r.status, r.message).toBe("proposed");
    expect(fake.turns()[1]!.user).toMatch(/^\[orchestrator [0-9a-f]{16}\] Your reply hit the output limit\./);
  });
});

describe("CliAgentRuntime: runtime mode only for CLIs with a recorded runtime session", () => {
  const profile = (id: string) => BUILTIN_CLI_PROFILES.find((p) => p.id === id)!;
  const runtime = (runtimeProviders?: Array<"gemini-cli" | "claude-cli">) =>
    new CliAgentRuntime({ binary: () => Promise.reject(new Error("unused")), env: () => ({}), mcpHost: { open: () => Promise.reject(new Error("unused")) }, ...(runtimeProviders ? { runtimeProviders } : {}) });
  const gemini = BUILTIN_CLI_PROFILES.find((p) => p.provider === "gemini-cli" && p.cli?.modes.includes("runtime"))!;

  it("Claude Code by default; Gemini CLI (and Codex, opencode) run single calls until their fixtures exist", () => {
    expect(RUNTIME_VERIFIED_PROVIDERS).toEqual(["claude-cli"]);
    expect(gemini).toBeDefined();
    expect(runtime().supports(profile("claude-cli:opus"), "BUILD")).toBe(true);
    expect(runtime().supports(gemini, "BUILD")).toBe(false);
    expect(resolvePhaseMode(gemini, "BUILD", { runtime: runtime() })).toBe("completion");
    expect(() => resolvePhaseMode(gemini, "BUILD", { runtime: runtime(), cliMode: "runtime" })).toThrow(RuntimeUnsupportedError);
    expect(() => resolvePhaseMode(gemini, "BUILD", { runtime: runtime(), cliMode: "runtime" })).toThrow(/not verified yet/);
  });

  it("a host (fixture recording) opts a CLI in", () => {
    expect(runtime(["claude-cli", "gemini-cli"]).supports(gemini, "BUILD")).toBe(true);
  });
});

describe("completion mode through the gateway (CliAdapter + CliTransport + the same fake binary)", () => {
  it("triage and a designer loop run as stateless CLI calls; the orchestrator executes the tools", async () => {
    fake = new FakeClaude({
      completion: {
        triage: [{ text: "", tool_calls: [{ name: "classify", arguments: { kind: "quick_edit", complexity: "T1", needs_clarification: false, reason: "a small change" } }] }],
        designer: [
          { text: "Thicken the slab.", tool_calls: [{ name: "apply_cadscript", arguments: { patches: [SLAB_10] } }] },
          { text: "", tool_calls: [{ name: "propose", arguments: { summary: "Plate is now 10 mm thick.", assumptions: [], known_issues: [] } }] },
        ],
      },
    });
    const f = fake;
    const parts = cliGatewayParts({ providers: ["claude-cli"], binary: () => f.binary(), env: () => f.env, workspaceRoot: `${f.dir}/ws` });
    const gateway = new LLMGateway({ profiles: CLI_TEST_PROFILES, adapters: parts.adapters, transports: parts.transports });
    const agent = new Agent({ gateway, engine: fixtureEngine(), now: fakeClock(), models: { designer: "claude-cli:sonnet" } });
    const r = await agent.run(PLATE);

    expect(r.status, r.message).toBe("proposed");
    expect(r.cadscript).toBe(PLATE_THICK);
    expect(r.models.triage.model).toBe("claude-cli:haiku"); // the gateway's small-model table
    expect(r.triage).toMatchObject({ kind: "quick_edit", source: "model" });
    const modes = new Set(r.events.filter((e) => e.type === "llm").map((e) => /\[(cli-completion)/.exec(e.text)?.[1]));
    expect([...modes]).toEqual(["cli-completion"]);
    const completions = f.completions();
    expect(completions.map((c) => c.role)).toEqual(["triage", "designer", "designer"]);
    // Stateless: the second designer call carries the whole transcript, with the tool result the orchestrator produced.
    expect(completions[2]!.stdin).toMatch(/apply #1: OK/);
    const invs = f.invocations();
    expect(invs.every((i) => i.mode === "completion" && !i.hasTicket)).toBe(true);
    expect(invs.every((i) => i.argv[i.argv.indexOf("--max-turns") + 1] === "3")).toBe(true);
    expect(r.billing).toBe("subscription");
    expect(f.leftoverWorkspaces()).toEqual([]);
  });
});
