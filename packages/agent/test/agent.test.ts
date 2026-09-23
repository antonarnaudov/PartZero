import { describe, expect, it } from "vitest";
import { Agent, ScriptedTransport, scriptedGateway, type AgentOptions, type ScriptedCall, type Scripts } from "../src/index.js";
import { fakeClock, fixtureEngine } from "./helpers.js";
import {
  GASKET,
  GASKET_OPEN,
  GASKET_OUTLINE_FIX,
  PLATE_BRANCH,
  PLATE_HOLE_CROSS,
  PLATE_OK,
  PLATE_OPEN,
  PLATE_THICK,
  SLAB_10,
  WASHER,
  WASHER_NO_BORE,
} from "./scenarios.js";
import { apply, GASKET_REQS, GASKET_TESTS, propose, specTurns, triage, WASHER_REQS, WASHER_TESTS } from "./scripts.js";

const GASKET_PROMPT =
  "Gasket for a junction box lid, laser cut from 1.5 mm rubber sheet. Outside 90 x 70 mm, 8 mm wide all round (so the opening is 74 x 54), with an M3 clearance hole (3.4 mm) in each corner, centred in the 8 mm band.";
const WASHER_PROMPT = "Can you make me a washer for M3 screws? 3.2 mm hole, 7 mm outside diameter, 1 mm thick.";

function setup(scripts: Scripts, options: Partial<AgentOptions> = {}) {
  const transport = new ScriptedTransport(scripts);
  const gateway = scriptedGateway(transport);
  const agent = new Agent({ gateway, engine: fixtureEngine(), now: fakeClock(), ...options });
  return { transport, gateway, agent };
}

const designerCalls = (t: ScriptedTransport) => t.calls.filter((c) => c.role === "designer");

describe("design loop: mistake → playbook hint → fix → spec tests pass → propose", () => {
  it("repairs an open loop from the computed hint and proposes a verified gasket", async () => {
    const seen: ScriptedCall[] = [];
    const { transport, gateway, agent } = setup({
      triage: [triage("design")],
      spec_writer: specTurns(GASKET_TESTS, GASKET_REQS),
      designer: [
        apply({ source: GASKET_OPEN, expect: [{ feature: "gasket", bodies: 1 }], note: "whole gasket" }, "Outline, opening and four holes in one sketch; extrude 1.5 mm."),
        (call) => {
          seen.push(call);
          return apply({ patches: [GASKET_OUTLINE_FIX] }, "Close the loop at the top-right corner.");
        },
        (call) => {
          seen.push(call);
          return propose("A 90 x 70 x 1.5 mm gasket with a 74 x 54 opening and four 3.4 mm holes on an 82 x 62 mm pattern.", ["corner holes 3.4 mm (M3 clearance)"]);
        },
      ],
    });
    const r = await agent.run({ prompt: GASKET_PROMPT, name: "t1-rect-gasket", process: "laser" });

    // The broken apply's result carried the kernel error with a concrete, computed fix…
    const broken = seen[0]!.toolResults[0]!;
    expect(broken.isError).toBe(true);
    expect(broken.content).toMatch(/^apply #1: FAILED at L1 \(kernel\)/);
    expect(broken.content).toContain("✗ outline (sketch) SKETCH_OPEN_LOOP: the end of curve 'o_right' at (45, 35) meets no other curve end");
    expect(broken.content).toContain("fix: 'o_right'.end (45, 35) has no partner; the nearest curve end is 'o_top'.start (45, 36), 1 mm away");
    expect(broken.content).toContain("set 'o_top'.start to [45, 35]");
    // Orchestrator notes carry the run's nonce, so text from the user's file cannot pass for one.
    expect(seen[0]!.userText).toMatch(/^\[orchestrator [0-9a-f]{16}\] REPAIR 1\/2/);
    // …and the fix verified with every spec test passing.
    expect(seen[1]!.toolResults[0]!.content).toMatch(/^apply #2: OK \(L0–L2 pass; spec tests 5\/5\)/);

    expect(r.status, r.message).toBe("proposed");
    expect(r.cadscript).toBe(GASKET);
    expect(r.verified).toBe(true);
    expect(r.tests!.every((t) => t.pass)).toBe(true);
    expect(r.spec!.tests.map((t) => t.id)).toEqual(GASKET_TESTS.map((t) => t.id));
    expect(r.proposal).toMatchObject({ assumptions: ["corner holes 3.4 mm (M3 clearance)"], known_issues: [] });
    expect(r.trace.states).toEqual(["TRIAGE", "SPEC", "BUILD", "REPAIR", "BUILD", "PROPOSE", "DONE"]);
    expect(r.trace).toMatchObject({ applies: 2, failedApplies: 1, repairs: 1, replans: 0, turns: 3, llmCalls: 6 });
    expect(transport.remaining()).toEqual({ triage: 0, spec_writer: 0, designer: 0 });
    expect(gateway.ledger).toHaveLength(6);
  });
});

describe("stop rules", () => {
  it("stops when the same error comes back twice, and hands back the last verified state", async () => {
    const { transport, agent } = setup(
      { designer: [apply({ source: PLATE_OPEN }), apply({ source: PLATE_OPEN }, "Try again."), propose("never reached")] },
      { kind: "quick_edit" },
    );
    const r = await agent.run({ prompt: "Make the plate 10 mm thick.", context: PLATE_OK, name: "plate" });
    expect(r.status).toBe("stopped");
    expect(r.stopReason).toBe("same_error");
    expect(r.message).toMatch(/the same error twice in a row: SKETCH_OPEN_LOOP@base/);
    expect(r.cadscript).toBe(PLATE_OK);
    expect(r.verified).toBe(true);
    expect(r.proposal!.summary).toMatch(/^Stopped \(same_error\)/);
    expect(designerCalls(transport)).toHaveLength(2);
    expect(transport.remaining().designer).toBe(1);
  });

  it("REPAIR ×2 then ROLLBACK + REPLAN, then succeeds", async () => {
    const seen: ScriptedCall[] = [];
    const { agent } = setup(
      {
        designer: [
          apply({ source: PLATE_OPEN }),
          apply({ source: PLATE_HOLE_CROSS }),
          apply({ source: PLATE_BRANCH }),
          (call) => {
            seen.push(call);
            return apply({ patches: [SLAB_10] }, "Different approach: only change the extrude.");
          },
          propose("Plate is now 10 mm thick."),
        ],
      },
      { kind: "quick_edit" },
    );
    const r = await agent.run({ prompt: "Make the plate 10 mm thick.", context: PLATE_OK, name: "plate" });
    const note = seen[0]!.userText;
    expect(note).toMatch(/^\[orchestrator [0-9a-f]{16}\] 2 repairs failed, so the design was rolled back to cp1 "start"\. REPLAN/);
    expect(note).toContain("slab: extrude base 8 mm → 1 body");
    expect(r.status, r.message).toBe("proposed");
    expect(r.cadscript).toBe(PLATE_THICK);
    expect(r.trace).toMatchObject({ repairs: 2, replans: 1, failedApplies: 3, applies: 4 });
    expect(r.trace.states).toEqual(["TRIAGE", "BUILD", "REPAIR", "REPLAN", "BUILD", "PROPOSE", "DONE"]);
  });

  it("stops when the replan fails too (repairs exhausted) and returns the best verified state", async () => {
    const { agent } = setup(
      {
        designer: [
          apply({ source: PLATE_OPEN }),
          apply({ source: PLATE_HOLE_CROSS }),
          apply({ source: PLATE_BRANCH }),
          apply({ source: PLATE_OPEN }),
          apply({ source: PLATE_HOLE_CROSS }),
          apply({ source: PLATE_BRANCH }),
        ],
      },
      { kind: "quick_edit" },
    );
    const r = await agent.run({ prompt: "Make the plate 10 mm thick.", context: PLATE_OK, name: "plate" });
    expect(r.stopReason).toBe("repairs_exhausted");
    expect(r.message).toMatch(/2 repairs and 1 replan failed; last error: SKETCH_BRANCHING@base/);
    expect(r.cadscript).toBe(PLATE_OK);
    expect(r.trace).toMatchObject({ repairs: 4, replans: 1, failedApplies: 6 });
  });

  it("stops at 80 % of the budget before the next call", async () => {
    const big = { input: 1500, output: 5000 }; // $0.106 per Opus 5.5 call
    const { transport, agent } = setup(
      { designer: [{ ...apply({ patches: [SLAB_10] }), usage: big }, { ...apply({ source: PLATE_OK }), usage: big }, propose("never reached")] },
      { kind: "quick_edit", budgetUsd: 0.25 },
    );
    const r = await agent.run({ prompt: "Make the plate 10 mm thick.", context: PLATE_OK, name: "plate" });
    expect(r.stopReason).toBe("budget");
    expect(r.message).toMatch(/^spent \$0\.212\d of the \$0\.25 cap \(≥ 80%\)$/);
    expect(designerCalls(transport)).toHaveLength(2);
    expect(r.costUsd).toBeCloseTo(0.212, 6);
    expect(r.costUsd).toBeLessThanOrEqual(0.25);
  });

  it("refuses a call whose projected cost does not fit the hard cap (never sent)", async () => {
    const { transport, agent } = setup({ designer: [apply({ patches: [SLAB_10] })] }, { kind: "quick_edit", budgetUsd: 0.05 });
    const r = await agent.run({ prompt: "Make the plate 10 mm thick.", context: PLATE_OK, name: "plate" });
    expect(r.stopReason).toBe("budget");
    expect(r.message).toMatch(/would exceed the \$0\.0500 budget/);
    expect(transport.calls).toHaveLength(0);
    expect(r.costUsd).toBe(0);
  });

  it("stops on a refusal and never retries around it", async () => {
    const { transport, agent } = setup({ designer: [{ stop: "refusal", refusal: { category: "cyber", explanation: "declined" } }] }, { kind: "quick_edit" });
    const r = await agent.run({ prompt: "Make the plate 10 mm thick.", context: PLATE_OK, name: "plate" });
    expect(r.stopReason).toBe("refusal");
    expect(r.message).toBe("designer refused (cyber): declined; not retried");
    expect(designerCalls(transport)).toHaveLength(1);
  });

  it("stops after repeated turns without a tool call while the model does not verify", async () => {
    const { agent } = setup({ designer: [apply({ source: PLATE_OPEN }), { text: "Thinking…" }, { text: "Still thinking…" }, { text: "Hmm." }] }, { kind: "quick_edit" });
    const r = await agent.run({ prompt: "Make the plate 10 mm thick.", context: PLATE_OK, name: "plate" });
    expect(r.stopReason).toBe("no_progress");
    expect(r.cadscript).toBe(PLATE_OK);
  });
});

describe("PROPOSE gate", () => {
  it("sends a proposal back while spec tests fail (REFINE), then accepts it with the failing tests acknowledged by id", async () => {
    const seen: ScriptedCall[] = [];
    const { agent } = setup({
      triage: [triage("design")],
      spec_writer: specTurns(WASHER_TESTS, WASHER_REQS),
      designer: [
        apply({ source: WASHER_NO_BORE }),
        propose("A washer."),
        (call) => {
          seen.push(call);
          return propose("A washer without the hole.", [], ["bore and volume: the hole is missing on purpose"], ["bore", "volume"]);
        },
      ],
    });
    const r = await agent.run({ prompt: WASHER_PROMPT, name: "washer" });
    const refine = seen[0]!.toolResults[0]!;
    expect(refine.isError).toBe(true);
    expect(refine.content).toMatch(/^\[orchestrator [0-9a-f]{16}\] Not accepted \(REFINE 1\/2\): 2 of 5 spec tests fail:/);
    expect(refine.content).toMatch(/✗ volume: ≈ 30.44 ±1% — actual 38.48\d* \(outside by 7.7\d*\)/);
    expect(r.status).toBe("proposed");
    expect(r.trace.refines).toBe(1);
    // The designer's explanation, plus every failing test on record.
    expect(r.proposal!.known_issues[0]).toBe("bore and volume: the hole is missing on purpose");
    expect(r.proposal!.known_issues.slice(1).map((k) => k.split(":")[0])).toEqual(["spec test bore fails", "spec test volume fails"]);
  });

  it("does not accept an unverified model; a second propose hands back the last verified checkpoint", async () => {
    const { agent } = setup(
      { designer: [apply({ patches: [SLAB_10] }), apply({ source: PLATE_OPEN }), propose("done"), propose("done anyway")] },
      { kind: "quick_edit" },
    );
    const r = await agent.run({ prompt: "Make the plate 10 mm thick.", context: PLATE_OK, name: "plate" });
    expect(r.status).toBe("proposed");
    expect(r.cadscript).toBe(PLATE_THICK);
    expect(r.proposal!.known_issues[0]).toMatch(/the proposal is the last verified state \(cp2 "auto: apply #1"\)/);
  });

  it("runs the L5 visual-judge hook when plugged in (off by default)", async () => {
    const verdicts = [{ pass: false, findings: ["hole looks off-centre"] }, { pass: true, findings: [] }];
    const judged: string[] = [];
    const { agent } = setup(
      { triage: [triage("design")], spec_writer: specTurns(WASHER_TESTS, WASHER_REQS), designer: [apply({ source: WASHER }), propose("A washer."), propose("A washer, re-checked.")] },
      { hooks: { visualJudge: async ({ source }) => (judged.push(source), verdicts.shift()!) } },
    );
    const r = await agent.run({ prompt: WASHER_PROMPT, name: "washer" });
    expect(judged).toHaveLength(2);
    expect(r.status).toBe("proposed");
    expect(r.proposal!.summary).toBe("A washer, re-checked.");
  });
});

describe("spec writer isolation and the cached prefix", () => {
  it("the spec writer runs in a fresh conversation that never contains designer messages", async () => {
    const SECRET = "DESIGNER-ONLY-7731";
    const { transport, agent } = setup(
      {
        triage: [triage("design", true)],
        designer: [
          { text: `${SECRET}: the screw size changes the hole.`, tools: [{ name: "ask_user", input: { questions: [{ id: "q1", question: "Which screw size?", options: ["M3", "M4"], default: "M3" }] } }] },
          apply({ source: WASHER }),
          propose("An M3 washer."),
        ],
        spec_writer: specTurns(WASHER_TESTS, WASHER_REQS),
      },
      { recordedDefaults: "M3 screws, 7 mm washer." },
    );
    const r = await agent.run({ prompt: "Make me a washer.", name: "washer" });
    expect(r.status, r.message).toBe("proposed");
    expect(r.clarifications).toEqual([{ question: "Which screw size?", answer: expect.stringContaining("Recorded defaults for this request: M3 screws, 7 mm washer.") }]);

    const order = transport.calls.map((c) => c.role);
    expect(order).toEqual(["triage", "designer", "spec_writer", "spec_writer", "designer", "designer"]);
    const spec = transport.calls.filter((c) => c.role === "spec_writer");
    expect((spec[0]!.payload["messages"] as unknown[]).length).toBe(1);
    for (const c of spec) {
      expect(c.allText).not.toContain(SECRET);
      expect(c.allText).not.toContain("You are the designer");
      expect(c.allText).not.toContain("apply_cadscript");
      expect((c.payload["tools"] as { name: string }[]).map((t) => t.name)).toEqual(["set_spec_tests", "submit_spec"]);
      expect(c.allText).toContain("Make me a washer.");
      expect(c.allText).toContain("Recorded defaults for this request: M3 screws");
    }
    // The build conversation starts fresh too: it gets the answers and the frozen tests, not the clarify turn.
    const build = designerCalls(transport)[1]!;
    expect((build.payload["messages"] as unknown[]).length).toBe(1);
    expect(build.allText).not.toContain(SECRET);
    expect(build.allText).toMatch(/<spec_tests nonce="[0-9a-f]{16}">/);
    expect(build.allText).toContain("- volume — R1+R2: π/4·(7² − 3.2²)·1 ≈ 30.44 mm³ [volume ≈ 30.44 ±1%]");
  });

  it("keeps tools (sorted) and the system prompt byte-identical across turns and across the clarify/build conversations", async () => {
    const run = async () => {
      const { transport, agent } = setup({
        triage: [triage("design", true)],
        designer: [{ text: "NO QUESTIONS" }, apply({ source: WASHER }), propose("A washer.")],
        spec_writer: specTurns(WASHER_TESTS, WASHER_REQS),
      });
      await agent.run({ prompt: WASHER_PROMPT, name: "washer" });
      return designerCalls(transport);
    };
    const calls = await run();
    const prefix = (c: ScriptedCall) => JSON.stringify({ tools: c.payload["tools"], system: c.payload["system"] });
    expect(new Set(calls.map(prefix)).size).toBe(1);
    const names = (calls[0]!.payload["tools"] as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["apply_cadscript", "ask_user", "checkpoint", "get_code", "ir_summary", "measure", "propose", "rollback", "run_tests"]);
    const system = calls[0]!.payload["system"] as { text: string; cache_control?: unknown }[];
    expect(system[0]!.text).toMatch(/^You are the designer/);
    expect(system[1]!.text).toMatch(/^# CadScript v0 reference/);
    expect(system[system.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
    // A second run sends the same first request, byte for byte.
    const again = await run();
    expect(JSON.stringify(again[1]!.payload)).toBe(JSON.stringify(calls[1]!.payload));
  });
});

describe("cost accounting", () => {
  it("reports the task's cost from the gateway ledger, per role, priced from the model profiles", async () => {
    const { gateway, agent } = setup({
      triage: [triage("design")],
      spec_writer: specTurns(WASHER_TESTS, WASHER_REQS),
      designer: [apply({ source: WASHER }), propose("A washer.")],
    });
    const r = await agent.run({ prompt: WASHER_PROMPT, name: "washer" });
    const ledger = gateway.ledger.filter((e) => e.taskId === "agent-washer");
    expect(ledger).toHaveLength(5);
    const sum = ledger.reduce((s, e) => s + e.costUsd, 0);
    expect(r.costUsd).toBeCloseTo(sum, 12);
    expect(r.trace.costUsd).toBeCloseTo(sum, 12);
    // Haiku 4.5 triage: 400 in × $1 + 60 out × $5 per MTok; Opus 5.5 turns: 1500 × $4 + 300 × $20.
    expect(r.trace.costByRole.triage).toBeCloseTo((400 * 1 + 60 * 5) / 1e6, 12);
    expect(r.trace.costByRole.spec_writer).toBeCloseTo((2 * (1500 * 4 + 300 * 20)) / 1e6, 12);
    expect(r.trace.costByRole.designer).toBeCloseTo((2 * (1500 * 4 + 300 * 20)) / 1e6, 12);
    expect(r.models).toMatchObject({ triage: { model: "claude-haiku-4-5" }, designer: { model: "claude-opus-5-5", effort: "medium" }, spec_writer: { model: "claude-opus-5-5", effort: "high" } });
    expect(r.latencyMs).toBeGreaterThan(0);
  });
});

describe("ask mode", () => {
  it("answers a question with read-only tools and never changes the design", async () => {
    const { agent } = setup({
      triage: [triage("ask")],
      designer: [
        { tools: [{ name: "measure", input: { feature: "slab" } }, { name: "apply_cadscript", input: { source: PLATE_THICK } }] },
        (call) => {
          expect(call.toolResults[0]!.content).toContain("volume 32000 mm³");
          expect(call.toolResults[1]!.content).toMatch(/not available in question mode/);
          return { text: "The plate is 8 mm thick and weighs 32 cm³ of material." };
        },
      ],
    });
    const r = await agent.run({ prompt: "How thick is the plate?", context: PLATE_OK, name: "plate" });
    expect(r.status, r.message).toBe("answered");
    expect(r.answer).toBe("The plate is 8 mm thick and weighs 32 cm³ of material.");
    expect(r.cadscript).toBe(PLATE_OK);
  });
});

describe("interactive hooks: drafts and Stop", () => {
  it("reports a draft after every apply and stops with `cancelled` when aborted while the user is asked", async () => {
    const controller = new AbortController();
    const drafts: Array<{ source: string; applyIndex: number; verified: boolean; reason: string }> = [];
    const asked: string[] = [];
    const { transport, agent } = setup(
      {
        designer: [
          apply({ patches: [SLAB_10] }, "Thicken the slab."),
          { tools: [{ name: "ask_user", input: { questions: [{ id: "q1", question: "Keep the bottom face fixed?", options: ["yes", "no"], default: "yes" }] } }] },
          propose("never reached"),
        ],
      },
      {
        kind: "quick_edit",
        mode: "interactive",
        signal: controller.signal,
        askUser: (qs) => {
          asked.push(...qs.map((q) => q.question));
          controller.abort(); // the user pressed Stop while the question was open
          return qs.map((q) => q.default);
        },
        hooks: { onDraft: (d) => drafts.push(d) },
      },
    );
    const r = await agent.run({ prompt: "Make the plate 10 mm thick.", context: PLATE_OK, name: "plate" });
    expect(asked).toEqual(["Keep the bottom face fixed?"]);
    expect(r.status).toBe("stopped");
    expect(r.stopReason).toBe("cancelled");
    expect(r.message).toBe("stopped by the user");
    expect(drafts).toEqual([{ source: PLATE_THICK, applyIndex: 1, verified: true, reason: "apply" }]);
    // The best verified state is handed back, like any other stop.
    expect(r.cadscript).toBe(PLATE_THICK);
    expect(transport.remaining().designer).toBe(1);
  });

  it("an already-aborted signal stops before any model call is made", async () => {
    const controller = new AbortController();
    controller.abort();
    const { gateway, agent } = setup({ designer: [propose("never")] }, { kind: "quick_edit", signal: controller.signal });
    const r = await agent.run({ prompt: "Make the plate 10 mm thick.", context: PLATE_OK, name: "plate" });
    expect(r).toMatchObject({ status: "stopped", stopReason: "cancelled", cadscript: PLATE_OK });
    expect(gateway.ledger).toHaveLength(0);
  });
});
