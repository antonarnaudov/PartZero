/**
 * Agent-runtime mode in the orchestrator (docs/CLI-PROVIDERS.md §3.3, §3.4, §8.4), against an
 * in-process fake runtime: mode selection, the broker handler (the same `#execute` path, notes
 * appended to results, close on a stop), turn ends (nudges → implicit proposal), accounting
 * (unsettled estimates in the 80 % gate, one external charge per phase) and the endedBy → stop map.
 */
import { describe, expect, it } from "vitest";
import { READ_ONLY_TOOLS } from "@aicad/agent-tools";
import { BUILTIN_CLI_PROFILES, BUILTIN_PROFILES } from "@aicad/llm-gateway";
import {
  Agent,
  CLI_PHASE_LIMITS,
  resolvePhaseMode,
  RUNTIME_APPENDIX_V1,
  runtimeAppendix,
  RuntimeUnsupportedError,
  ScriptedTransport,
  scriptedGateway,
  type AgentDraft,
  type AgentOptions,
  type AgentRuntime,
  type Scripts,
} from "../src/index.js";
import { CLI_TEST_PROFILES, FakeRuntime, type FakePhase } from "./fake-runtime.js";
import { fakeClock, fixtureEngine } from "./helpers.js";
import { PLATE_OK, PLATE_OPEN, PLATE_THICK, SLAB_10, WASHER, WASHER_NO_BORE } from "./scenarios.js";
import { triage, WASHER_REQS, WASHER_TESTS } from "./scripts.js";

const profile = (id: string) => [...BUILTIN_PROFILES, ...BUILTIN_CLI_PROFILES].find((p) => p.id === id)!;
const yes: AgentRuntime = { kind: "cli", supports: () => true, runPhase: () => Promise.reject(new Error("unused")) };

describe("mode selection (§3.4)", () => {
  it("API and local profiles always use the gateway", () => {
    for (const phase of ["TRIAGE", "CLARIFY", "SPEC", "BUILD", "ASK", "JUDGE"] as const) {
      expect(resolvePhaseMode(profile("claude-opus-5-5"), phase, { runtime: yes, cliMode: "runtime" })).toBe("gateway");
    }
  });

  it("a CLI profile: single-shot phases in completion mode, tool loops in runtime mode when supported", () => {
    const p = profile("claude-cli:opus");
    expect(resolvePhaseMode(p, "TRIAGE", { runtime: yes })).toBe("completion");
    expect(resolvePhaseMode(p, "CLARIFY", { runtime: yes })).toBe("completion");
    expect(resolvePhaseMode(p, "JUDGE", { runtime: yes })).toBe("completion");
    for (const phase of ["SPEC", "BUILD", "ASK"] as const) {
      expect(resolvePhaseMode(p, phase, { runtime: yes })).toBe("runtime");
      expect(resolvePhaseMode(p, phase, {})).toBe("completion"); // no runtime injected (browser, server)
      expect(resolvePhaseMode(p, phase, { runtime: yes, cliMode: "completion" })).toBe("completion");
      expect(resolvePhaseMode(p, phase, { runtime: yes, cliMode: "runtime" })).toBe("runtime");
    }
  });

  it("cliMode runtime fails loudly when runtime mode is not possible", () => {
    expect(() => resolvePhaseMode(profile("claude-cli:opus"), "BUILD", { cliMode: "runtime" })).toThrow(RuntimeUnsupportedError);
    // gemini-cli:flash-lite lists completion only
    expect(resolvePhaseMode(profile("gemini-cli:flash-lite"), "BUILD", { runtime: yes })).toBe("completion");
    expect(() => resolvePhaseMode(profile("gemini-cli:flash-lite"), "BUILD", { runtime: yes, cliMode: "runtime" })).toThrow(/does not support runtime mode/);
    const no: AgentRuntime = { ...yes, supports: () => false };
    expect(resolvePhaseMode(profile("claude-cli:opus"), "BUILD", { runtime: no })).toBe("completion");
  });

  it("the runtime appendix is versioned and names tools the way the CLI shows them", () => {
    expect(RUNTIME_APPENDIX_V1).toContain("no shell, no file access and no web access");
    const a = runtimeAppendix((t) => `mcp__cad__${t}`);
    expect(a).toContain("`apply_cadscript`");
    expect(a).toContain("`mcp__cad__apply_cadscript`");
    expect(a).not.toContain("{{");
  });
});

function setup(runtime: FakeRuntime | undefined, options: Partial<AgentOptions> = {}, scripts: Scripts = {}) {
  const transport = new ScriptedTransport(scripts);
  const gateway = scriptedGateway(transport, { profiles: CLI_TEST_PROFILES });
  const agent = new Agent({ gateway, engine: fixtureEngine(), now: fakeClock(), models: { designer: "claude-cli:opus" }, ...(runtime ? { runtime } : {}), ...options });
  return { transport, gateway, agent };
}

const apply = (input: Record<string, unknown>) => ({ calls: [{ name: "apply_cadscript", input }] });
const propose = (summary: string) => ({ calls: [{ name: "propose", input: { summary, assumptions: [], known_issues: [] } }] });
const build = (turns: FakePhase["turns"], extra: Partial<FakePhase> = {}) => new FakeRuntime({ BUILD: { turns, ...extra } });
const PLATE = { prompt: "Make the plate 10 mm thick.", context: PLATE_OK, name: "plate" };

describe("BUILD in runtime mode: the broker handler is the orchestrator's #execute path", () => {
  it("apply → propose: the accepted proposal closes the broker; one external charge settles the phase", async () => {
    const rt = build([[apply({ patches: [SLAB_10] }), propose("Plate is now 10 mm thick."), { text: "Done." }]], { reportedCostUsd: 0.0123 });
    const { agent, gateway } = setup(rt, { kind: "quick_edit" });
    const r = await agent.run(PLATE);

    expect(r.status, r.message).toBe("proposed");
    expect(r.cadscript).toBe(PLATE_THICK);
    expect(r.verified).toBe(true);
    expect(r.billing).toBe("subscription");
    const spec = rt.specs[0]!;
    expect(spec).toMatchObject({ phase: "BUILD", role: "designer", scope: "design" });
    expect(spec.profile.id).toBe("claude-cli:opus");
    expect(spec.orchTag).toMatch(/^\[orchestrator [0-9a-f]{16}\]$/);
    expect(spec.system).toContain("You are the designer");
    expect(spec.prompt).toContain("<request>\nMake the plate 10 mm thick.\n</request>");
    expect(spec.prompt).toContain(`${spec.orchTag} This is a quick edit`);
    // The whole designer toolset, with readOnly from the registry (MCP hints, read scopes).
    expect(spec.tools.map((t) => t.name)).toEqual(["apply_cadscript", "ask_user", "checkpoint", "get_code", "ir_summary", "measure", "propose", "rollback", "run_tests"]);
    expect(spec.tools.filter((t) => t.readOnly).map((t) => t.name)).toEqual([...READ_ONLY_TOOLS].sort());
    // BUILD limit = the designer's turn limit + 2; the CLI-side budget backstop = the remaining cap.
    expect(spec.limits).toMatchObject({ maxTurns: 42, wallMs: CLI_PHASE_LIMITS.BUILD.wallMs, stallMs: CLI_PHASE_LIMITS.BUILD.stallMs, maxBudgetUsd: 1.5 });

    const [applyCall, proposeCall] = rt.calls;
    expect(applyCall!.result.text).toMatch(/^apply #1: OK/);
    expect(applyCall!.result.close).toBeUndefined();
    expect(proposeCall!.result).toMatchObject({ isError: false, close: "proposed" });
    expect(proposeCall!.result.text).toMatch(/Proposal accepted\. The task is complete\.$/);

    // Accounting: per-turn estimates in the trace, the CLI-reported total charged once.
    const llm = r.trace.llmCalls;
    expect(llm).toBe(3);
    const ledger = gateway.ledger.filter((e) => e.source === "external");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ model: "claude-cli:opus", costUsd: 0.0123, billing: "subscription" });
    expect(r.costUsd).toBeCloseTo(0.0123, 6);
    expect(r.trace.costUsd).toBeCloseTo(0.0123, 6);
    expect(r.events.filter((e) => e.type === "llm").every((e) => e.text.includes("[cli-runtime, plan]"))).toBe(true);
    expect(r.conversations.designer?.[0]).toMatchObject({ role: "user" });
    expect(r.trace.states).toEqual(["TRIAGE", "BUILD", "PROPOSE", "DONE"]);
  });

  it("REPAIR notes are appended to the tool result (a CLI cannot take a user message mid-turn)", async () => {
    const rt = build([[apply({ source: PLATE_OPEN }), apply({ source: PLATE_THICK }), propose("Plate is now 10 mm thick.")]]);
    const { agent } = setup(rt, { kind: "quick_edit" });
    const r = await agent.run(PLATE);
    const first = rt.calls[0]!.result;
    expect(first.isError).toBe(true);
    expect(first.text).toMatch(/^apply #1: FAILED at L1 \(kernel\)/);
    expect(first.text).toMatch(/\n\n\[orchestrator [0-9a-f]{16}\] REPAIR 1\/2: fix the first root-cause error/);
    expect(first.close).toBeUndefined();
    expect(r.status, r.message).toBe("proposed");
    expect(r.trace).toMatchObject({ repairs: 1, failedApplies: 1, applies: 2 });
  });

  it("same_error closes the broker; later calls never reach the handler; the verified state is handed back", async () => {
    const rt = build([[apply({ source: PLATE_OPEN }), apply({ source: PLATE_OPEN }), { calls: [{ name: "get_code", input: {} }, { name: "apply_cadscript", input: { patches: [SLAB_10] } }] }]]);
    const { agent } = setup(rt, { kind: "quick_edit" });
    const r = await agent.run(PLATE);
    expect(r.status).toBe("stopped");
    expect(r.stopReason).toBe("same_error");
    expect(r.cadscript).toBe(PLATE_OK);
    const second = rt.calls[1]!.result;
    expect(second.close).toBe("same_error");
    expect(second.text).toContain("The same error occurred twice in a row; the task stops here.");
    expect(rt.calls.slice(2).map((c) => c.handled)).toEqual([false, false]);
    expect(rt.calls[2]!.result.text).toMatch(/^\[orchestrator [0-9a-f]{16}\] The task has ended \(same_error\)/);
  });

  it("a turn end without a proposal: nudges, then the implicit-proposal gate", async () => {
    const rt = build([[apply({ patches: [SLAB_10] }), { text: "The plate is 10 mm thick now." }], [{ text: "Done." }], [{ text: "Really done." }]]);
    const { agent } = setup(rt, { kind: "quick_edit" });
    const r = await agent.run(PLATE);
    expect(rt.continuations.map((c) => c.message.replace(/^\[orchestrator [0-9a-f]{16}\] /, ""))).toEqual([
      "No tool call in your last turn. Continue with apply_cadscript, or call propose if the model is done.",
      "No tool call in your last turn. Continue with apply_cadscript, or call propose if the model is done.",
    ]);
    expect(r.status, r.message).toBe("proposed");
    expect(r.cadscript).toBe(PLATE_THICK);
    expect(r.proposal!.summary).toBe("Really done.");
    expect(r.proposal!.known_issues).toContain("The designer stopped without calling propose.");
  });

  it("no proposal and an unverified model after the nudges: no_progress", async () => {
    const rt = build([[apply({ source: PLATE_OPEN }), { text: "Hmm." }], [{ text: "…" }], [{ text: "…" }]]);
    const { agent } = setup(rt, { kind: "quick_edit" });
    const r = await agent.run(PLATE);
    expect(r.stopReason).toBe("no_progress");
    expect(r.cadscript).toBe(PLATE_OK);
  });

  it("the 80 % gate counts the running phase's unsettled estimates and closes the broker", async () => {
    // Opus notional pricing ($4/M input): 250k input tokens ≈ $1 in one model turn, over 80 % of a $1 cap.
    const rt = build([[{ ...apply({ patches: [SLAB_10] }), usage: { input: 250_000, output: 100 } }, { calls: [{ name: "run_tests", input: {} }] }, propose("never")]]);
    const { agent, gateway } = setup(rt, { kind: "quick_edit", budgetUsd: 1 });
    const r = await agent.run(PLATE);
    expect(r.stopReason).toBe("budget");
    expect(rt.calls[0]!.result.close).toBe("budget");
    expect(rt.calls[0]!.result.text).toMatch(/Not executed: the task has ended \(budget\)/);
    expect(rt.calls.slice(1).every((c) => !c.handled)).toBe(true);
    // The phase was still settled once.
    expect(gateway.ledger.filter((e) => e.source === "external")).toHaveLength(1);
  });

  it("interactive: the budget checkpoint waits for the user inside the tool call and may continue", async () => {
    let asked = 0;
    const rt = build([[{ ...apply({ patches: [SLAB_10] }), usage: { input: 200_000, output: 100 } }, propose("ok")]]);
    const { agent } = setup(rt, {
      kind: "quick_edit",
      budgetUsd: 5,
      mode: "interactive",
      askUser: () => [],
      hooks: {
        onBudgetCheckpoint: () => {
          asked++;
          return true;
        },
      },
      limits: { budgetStopFraction: 0.1 },
    });
    const r = await agent.run(PLATE);
    expect(asked).toBe(1);
    expect(rt.specs[0]!.mayWaitForUser).toBe(true);
    expect(r.status, r.message).toBe("proposed");
  });

  it("a lockdown violation voids even an accepted proposal: the starting model comes back, and later events supersede 'proposed'", async () => {
    const rt = build([[apply({ patches: [SLAB_10] }), propose("done")]], { endWith: { endedBy: "lockdown_violation", failure: { code: "lockdown_violation", message: "unexpected_tool: the CLI exposes tool 'Bash' to the model" } } });
    const drafts: AgentDraft[] = [];
    const { agent } = setup(rt, { kind: "quick_edit", hooks: { onDraft: (d) => drafts.push(d) } });
    const r = await agent.run(PLATE);
    expect(r.status).toBe("failed");
    expect(r.stopReason).toBe("lockdown_violation");
    expect(r.message).toContain("Bash");
    expect(r.message).toContain("the accepted proposal is void");
    expect(r.proposal!.summary).toMatch(/^Stopped \(lockdown_violation\)/);
    // The CLI's (verified) edit is not handed back: the starting model is.
    expect(r.cadscript).toBe(PLATE_OK);
    // The host saw `stop: proposed` during the phase; the note and the final stop come after it.
    const texts = r.events.map((e) => `${e.type} ${e.text}`);
    const proposed = texts.findIndex((t) => t.startsWith("stop proposed:"));
    const voided = texts.findIndex((t) => /^note lockdown violation: the proposal accepted earlier in this phase is void/.test(t));
    const final = texts.findIndex((t) => t.startsWith("stop lockdown_violation:"));
    expect(proposed).toBeGreaterThanOrEqual(0);
    expect(voided).toBeGreaterThan(proposed);
    expect(final).toBeGreaterThan(voided);
    expect(r.trace.stopReason).toBe("lockdown_violation");
    // The preview is reset to the starting model.
    expect(drafts.map((d) => d.reason)).toEqual(["apply", "rollback"]);
    expect(drafts.at(-1)).toMatchObject({ reason: "rollback", source: PLATE_OK });
  });

  it("a lockdown violation without a proposal also discards the CLI's verified edits", async () => {
    const rt = build([[apply({ patches: [SLAB_10] })]], { endWith: { endedBy: "lockdown_violation", failure: { code: "lockdown_violation", message: "mcp_not_connected: MCP server 'cad' is failed" } } });
    const { agent } = setup(rt, { kind: "quick_edit" });
    const r = await agent.run(PLATE);
    expect(r.stopReason).toBe("lockdown_violation");
    expect(r.message).not.toContain("is void");
    expect(r.cadscript).toBe(PLATE_OK);
    expect(r.events.some((e) => e.type === "note" && e.text.includes("rolled back to the starting model"))).toBe(true);
  });

  it("a CLI result's cost correction counts in the 80 % gate at once; the trace settles to the CLI's total", async () => {
    // Per-turn estimates are tiny; the result reports $0.90 so far (thinking, side calls): over 80 % of $1.
    const rt = build([[{ ...apply({ patches: [SLAB_10] }), correctUsd: 0.9 }, { calls: [{ name: "run_tests", input: {} }] }, propose("never")]], { reportedCostUsd: 0.92 });
    const { agent } = setup(rt, { kind: "quick_edit", budgetUsd: 1 });
    const r = await agent.run(PLATE);
    expect(r.stopReason).toBe("budget");
    expect(rt.calls[0]!.result.close).toBe("budget");
    expect(r.costUsd).toBeCloseTo(0.92, 6);
    expect(r.trace.costUsd).toBeCloseTo(0.92, 6);
    // The note's estimate is what the per-turn records add up to (the correction is not a model turn).
    const note = r.events.find((e) => e.text.startsWith("designer CLI phase"))!.text;
    expect(Number(/estimated \$([0-9.]+)/.exec(note)![1])).toBeLessThan(0.1);
  });

  it.each([
    ["refusal", undefined, "refusal"],
    ["max_turns", undefined, "max_turns"],
    ["timeout", { code: "timeout", message: "wall-clock limit of 1200 s reached" }, "model_error"],
    ["stalled", { code: "stalled", message: "no output for 180 s" }, "model_error"],
    ["cli_error", { code: "quota_exhausted", message: "the Claude plan's usage limit is reached" }, "model_error"],
    ["cli_error", { code: "budget", message: "the CLI hit --max-budget-usd" }, "budget"],
    ["cancelled", undefined, "cancelled"],
  ] as const)("endedBy %s (%o) → stop %s", async (endedBy, failure, stop) => {
    const rt = build([[apply({ patches: [SLAB_10] })]], { endWith: { endedBy, ...(failure ? { failure } : {}) } });
    const { agent } = setup(rt, { kind: "quick_edit" });
    const r = await agent.run(PLATE);
    expect(r.stopReason).toBe(stop);
    if (failure) expect(r.message).toContain(failure.code === "budget" ? "--max-budget-usd" : failure.code);
    // Whatever the ending, the best verified state is handed back.
    expect(r.verified).toBe(true);
  });

  it("cliMode runtime without an injected runtime is a clear model_error", async () => {
    const { agent } = setup(undefined, { kind: "quick_edit", cliMode: "runtime" });
    const r = await agent.run(PLATE);
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/cliMode "runtime" for BUILD: no agent runtime is available/);
  });
});

describe("SPEC and ASK in runtime mode", () => {
  const WASHER_PROMPT = "Can you make me a washer for M3 screws? 3.2 mm hole, 7 mm outside diameter, 1 mm thick.";

  it("SPEC runs in its own phase with the spec writer's nonce; submit_spec closes it; BUILD then passes the frozen tests", async () => {
    const rt = new FakeRuntime({
      SPEC: {
        turns: [
          [
            { text: "Tests first.", calls: [{ name: "set_spec_tests", input: { tests: WASHER_TESTS } }] },
            { calls: [{ name: "submit_spec", input: { summary: "An M3 washer.", requirements: WASHER_REQS, assumptions: [], key_dimensions: [] } }] },
            { text: "Submitted." },
          ],
        ],
      },
      BUILD: { turns: [[apply({ source: WASHER_NO_BORE }), apply({ source: WASHER }), propose("An M3 washer, 7 x 1 mm with a 3.2 mm hole.")]] },
    });
    const { agent } = setup(rt, { kind: "design" });
    const r = await agent.run({ prompt: WASHER_PROMPT, name: "t1-m3-washer", process: "fdm" });
    expect(r.status, r.message).toBe("proposed");
    expect(r.tests!.every((t) => t.pass)).toBe(true);
    expect(r.spec!.tests.map((t) => t.id)).toEqual(WASHER_TESTS.map((t) => t.id));

    const [spec, build] = rt.specs;
    expect(spec).toMatchObject({ phase: "SPEC", role: "spec_writer", scope: "spec" });
    expect(spec!.tools.map((t) => t.name)).toEqual(["set_spec_tests", "submit_spec"]);
    expect(spec!.system).not.toContain("You are the designer");
    // Isolation: a different nonce; the spec writer never sees the designer's tag.
    expect(spec!.orchTag).not.toBe(build!.orchTag);
    expect(spec!.prompt).not.toContain(build!.orchTag!);
    expect(spec!.limits.maxTurns).toBe(CLI_PHASE_LIMITS.SPEC.maxTurns);
    const submit = rt.calls.find((c) => c.name === "submit_spec")!;
    expect(submit.result.close).toBe("spec_submitted");
    // The designer's header carries the frozen tests.
    expect(build!.prompt).toContain("The frozen spec tests");
    expect(r.conversations.spec_writer?.length).toBeGreaterThan(1);
    expect(r.trace.costByRole.spec_writer).toBeGreaterThan(0);
  });

  it("SPEC: a lockdown violation wins over a pending budget stop (security first, as in BUILD and ASK)", async () => {
    // Opus notional pricing: 250k input tokens ≈ $1, so the budget gate stops the first call; the CLI also broke its lockdown.
    const rt = new FakeRuntime({
      SPEC: {
        turns: [[{ calls: [{ name: "set_spec_tests", input: { tests: WASHER_TESTS } }], usage: { input: 250_000, output: 100 } }]],
        endWith: { endedBy: "lockdown_violation", failure: { code: "lockdown_violation", message: "unexpected_tool: the CLI exposes tool 'Bash' to the model" } },
      },
    });
    const { agent } = setup(rt, { kind: "design", budgetUsd: 1 });
    const r = await agent.run({ prompt: WASHER_PROMPT, name: "t1-m3-washer" });
    expect(rt.calls[0]!.result.close).toBe("budget");
    expect(r.status).toBe("failed");
    expect(r.stopReason).toBe("lockdown_violation");
    expect(r.message).toMatch(/^spec writer CLI: unexpected_tool/);
    expect(r.trace.stopReason).toBe("lockdown_violation");
  });

  it("SPEC passes plan usage to the host live and reports cost corrections", async () => {
    const seen: string[] = [];
    const rt = new FakeRuntime({
      SPEC: { turns: [[{ text: "Prose only." }], [{ text: "Still prose." }]] },
      BUILD: { turns: [[apply({ source: WASHER }), propose("Washer.")]] },
    });
    const { agent } = setup(rt, { kind: "design", hooks: { onPlanUsage: (u) => seen.push(u.status) } });
    const r = await agent.run({ prompt: WASHER_PROMPT, name: "t1-m3-washer" });
    const spec = rt.specs.find((s) => s.phase === "SPEC")!;
    expect(typeof spec.onPlanUsage).toBe("function");
    expect(typeof spec.onCostCorrection).toBe("function");
    spec.onPlanUsage!({ provider: "claude-cli", status: "allowed", windows: [], overage: null, observedAt: "2026-09-24T00:00:00.000Z" });
    expect(seen).toEqual(["allowed"]);
    expect(r.status, r.message).toBe("proposed");
  });

  it("SPEC without submit_spec: one nudge, then the phase ends with no spec and BUILD runs without L3", async () => {
    const rt = new FakeRuntime({
      SPEC: { turns: [[{ text: "Here is my spec in prose." }], [{ text: "Still prose." }]] },
      BUILD: { turns: [[apply({ source: WASHER }), propose("Washer.")]] },
    });
    const { agent } = setup(rt, { kind: "design" });
    const r = await agent.run({ prompt: WASHER_PROMPT, name: "t1-m3-washer" });
    expect(rt.continuations.filter((c) => c.phase === "SPEC").map((c) => c.message)).toEqual([expect.stringMatching(/Call set_spec_tests with the tests, then submit_spec/)]);
    expect(r.status, r.message).toBe("proposed");
    expect(r.spec).toBeUndefined();
    expect(r.events.some((e) => e.text.includes("no valid spec tests; building without L3"))).toBe(true);
  });

  it("ASK runs in the read scope and the CLI's final text is the answer", async () => {
    const rt = new FakeRuntime({ ASK: { turns: [[{ calls: [{ name: "ir_summary", input: {} }] }, { text: "The plate is 8 mm thick." }]] } });
    const { agent } = setup(rt, { kind: "ask" });
    const r = await agent.run({ prompt: "How thick is the plate?", context: PLATE_OK, name: "plate" });
    expect(r.status).toBe("answered");
    expect(r.answer).toBe("The plate is 8 mm thick.");
    expect(r.cadscript).toBe(PLATE_OK);
    const spec = rt.specs[0]!;
    expect(spec).toMatchObject({ phase: "ASK", scope: "read" });
    expect(spec.tools.map((t) => t.name)).toEqual([...READ_ONLY_TOOLS].sort());
    expect(spec.tools.every((t) => t.readOnly === true)).toBe(true);
    expect(rt.calls[0]!.result.text).toMatch(/part "plate"/);
  });

  it("mixed roles: API triage through the gateway, CLI designer in runtime mode", async () => {
    const rt = build([[apply({ patches: [SLAB_10] }), propose("Plate is now 10 mm thick.")]]);
    const { agent, transport } = setup(rt, { models: { designer: "claude-cli:opus", triage: "claude-haiku-4-5" } }, { triage: [triage("quick_edit")] });
    const r = await agent.run(PLATE);
    expect(r.status, r.message).toBe("proposed");
    expect(transport.remaining().triage).toBe(0);
    expect(r.trace.states).toEqual(["TRIAGE", "BUILD", "PROPOSE", "DONE"]);
  });
});
