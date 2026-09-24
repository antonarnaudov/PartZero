/**
 * A real Claude Code session, replayed offline (docs/CLI-PROVIDERS.md §13.1). The stream was recorded
 * from the live agent-runtime smoke (S2: claude-cli:haiku made the NEMA 17 plate 2 mm thicker through
 * our MCP server) with the Forge reports it needed. The fake binary re-emits the recorded stream but
 * performs every recorded tool call for real, through the shim, the broker and `AgentRun`, so the
 * parser, the driver, the ladder, the REPAIR note and the PROPOSE gate all run on real CLI output.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureEngine, type FixtureFile } from "@aicad/evals";
import { LLMGateway } from "@aicad/llm-gateway";
import { Agent } from "../src/index.js";
import { FakeClaude, skipRealBroker } from "./cli-harness.js";
import { CLI_TEST_PROFILES } from "./fake-runtime.js";
import { fakeClock } from "./helpers.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/cli/claude/${name}`, import.meta.url));
const NEMA = readFileSync(fileURLToPath(new URL("../../../corpus/makerbench/t1-nema17-plate.cad.ts", import.meta.url)), "utf8");

let fake: FakeClaude | undefined;
afterEach(() => {
  fake?.dispose();
  fake = undefined;
});

describe.skipIf(skipRealBroker())("recorded Claude Code 2.1.260 runtime session (NEMA 17 plate, 2 mm thicker)", () => {
  it("replays to the same verified proposal: REPAIR after a wrong expectation, a rejected unverified propose, then acceptance", async () => {
    fake = new FakeClaude({ runtime: { build: { replay: fixture("runtime-build-2.1.260.jsonl") } } });
    const engine = new FixtureEngine([JSON.parse(readFileSync(fixture("runtime-build-2.1.260.engine.json"), "utf8")) as FixtureFile]);
    const gateway = new LLMGateway({ profiles: CLI_TEST_PROFILES });
    const agent = new Agent({ gateway, engine, now: fakeClock(), models: { designer: "claude-cli:haiku" }, runtime: fake.runtime(), kind: "quick_edit", cliMode: "runtime", budgetUsd: 0.25 });
    const r = await agent.run({ prompt: "Make the plate 2 mm thicker.", context: NEMA, name: "nema17_plate" });

    expect(r.status, r.message).toBe("proposed");
    expect(r.cadscript).toBe(NEMA.replace("extrude(outline, { distance: 5 })", "extrude(outline, { distance: 7 })"));
    expect(r.verified).toBe(true);
    expect(r.trace).toMatchObject({ applies: 2, failedApplies: 1, repairs: 1, llmCalls: 7 });
    expect(r.trace.states).toEqual(["TRIAGE", "BUILD", "REPAIR", "BUILD", "PROPOSE", "DONE"]);

    const calls = fake.calls();
    expect(calls.map((c) => [c.name, c.isError])).toEqual([
      ["apply_cadscript", true],
      ["measure", false],
      ["run_tests", false],
      ["propose", true],
      ["apply_cadscript", false],
      ["propose", false],
    ]);
    expect(calls[0]!.text).toMatch(/^apply #1: FAILED at L2 \(expectations\)/);
    expect(calls[0]!.text).toMatch(/\[orchestrator [0-9a-f]{16}\] REPAIR 1\/2/);
    expect(calls[3]!.text).toMatch(/Not accepted: the current model fails verification/);
    expect(calls[5]!.text).toMatch(/Proposal accepted\. The task is complete\.$/);

    // Settled from the CLI's own total (cumulative per process); estimates from the per-message usage.
    const external = gateway.ledger.filter((e) => e.source === "external");
    expect(external).toHaveLength(1);
    expect(external[0]!.costUsd).toBeCloseTo(0.0418477, 7);
    expect(r.planUsage).toMatchObject({ provider: "claude-cli", status: "allowed" });
    expect(r.events.some((e) => /designer CLI phase \(claude-cli 2\.1\.260, lockdown verified\): \$0\.0418 notional \(your plan\) \[provider\].*7 turns, 6 tool calls, ended by closed \(proposed\)/.test(e.text))).toBe(true);
    // Usage settles to the result's totals (modelUsage, every model call of the process), not to the per-message
    // start-of-message snapshots (1–2 output tokens each in this stream).
    expect(r.trace).toMatchObject({ inputTokens: 1941, outputTokens: 1915, cacheReadTokens: 62597, cacheWriteTokens: 12036 });
    // The per-turn estimates count the output each turn emitted (thinking is not in the stream), so the gate is not
    // late: before, the note said "estimated $0.0304" (27 % low) with 8 output tokens in all.
    const estimated = Number(/estimated \$([0-9.]+)/.exec(r.events.find((e) => e.text.startsWith("designer CLI phase"))!.text)![1]);
    // What is still missing is thinking (987 of the 1915 output tokens; Claude streams no thinking content, only
    // `system/thinking_tokens` estimates the parser does not read yet) and side calls. Each `result` reconciles it
    // for the 80 % gate (see the nudge test below); the settled charge is the CLI's own total.
    expect(estimated).toBeGreaterThan(0.0304);
    expect(estimated).toBeGreaterThan(0.75 * 0.0418477);
    expect(estimated).toBeLessThan(0.0418477);
    // The transcript holds the broker's answers, with the thinking blocks dropped.
    const blocks = r.conversations.designer!.flatMap((m): Array<{ type: string }> => m.content);
    expect(blocks.filter((b) => b.type === "tool_use")).toHaveLength(6);
    expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(6);
    expect(blocks.some((b) => b.type === "reasoning")).toBe(false);
  });

  it("the recorded nudge: a turn end without a tool call is continued in the same process over stdin (§15 A1)", async () => {
    fake = new FakeClaude({ runtime: { build: { replay: fixture("runtime-nudge-2.1.260.jsonl") } } });
    const engine = new FixtureEngine([JSON.parse(readFileSync(fixture("runtime-build-2.1.260.engine.json"), "utf8")) as FixtureFile]);
    const gateway = new LLMGateway({ profiles: CLI_TEST_PROFILES });
    // The 80 % gate observed through an interactive checkpoint that fires at the first tool call.
    const spent: number[] = [];
    const agent = new Agent({
      gateway,
      engine,
      now: fakeClock(),
      models: { designer: "claude-cli:haiku" },
      runtime: fake.runtime(),
      kind: "quick_edit",
      cliMode: "runtime",
      budgetUsd: 0.25,
      mode: "interactive",
      askUser: () => [],
      limits: { budgetStopFraction: 0.0001 },
      hooks: {
        onBudgetCheckpoint: (info) => {
          spent.push(info.spentUsd);
          return true;
        },
      },
    });
    const r = await agent.run({ prompt: "Do not change anything and do not call any tool. Reply with one short sentence that describes the plate.", context: NEMA, name: "nema17_plate" });

    expect(r.status, r.message).toBe("proposed");
    expect(r.cadscript).toBe(NEMA);
    // The first result (turn 1, $0.0076737 cumulative) corrected the per-turn estimate before the propose call.
    expect(spent).toHaveLength(1);
    expect(spent[0]).toBeCloseTo(0.0076737, 7);
    // Two results in one stdin-stream process: modelUsage is cumulative (228 → 628 output tokens), so the last one
    // is the process total, not their sum (856).
    expect(r.trace).toMatchObject({ inputTokens: 1940, outputTokens: 628, cacheReadTokens: 25404, cacheWriteTokens: 2743 });
    const external = gateway.ledger.filter((e) => e.source === "external");
    expect(external).toHaveLength(1);
    expect(external[0]!.costUsd).toBeCloseTo(0.0131064, 7);
    const turns = fake.turns();
    expect(turns).toHaveLength(2);
    expect(turns[1]!.user).toMatch(/^\[orchestrator [0-9a-f]{16}\] No tool call in your last turn\. Continue with apply_cadscript, or call propose if the model is done\.$/);
    expect(fake.invocations()).toHaveLength(1);
    expect(fake.calls().map((c) => [c.name, c.isError])).toEqual([["propose", false]]);
    const designer = r.conversations.designer!;
    expect(designer.filter((m) => m.role === "user" && m.content.some((b) => b.type === "text" && b.text.includes("No tool call in your last turn")))).toHaveLength(1);
  });
});
