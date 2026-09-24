import { describe, expect, it } from "vitest";
import { designRegistry, DesignSession } from "@aicad/agent-tools";
import { sessionToolHandler } from "../src/host/session-handler.js";
import { disc, StubEngine } from "./helpers/stub-engine.js";

const call = (seq: number, name: string, args: Record<string, unknown> = {}) => ({ seq, name, args, toolUseId: `toolu_${seq}` });

describe("sessionToolHandler", () => {
  it("runs the registry on the session and closes after a successful propose only", async () => {
    const session = await DesignSession.open({ engine: new StubEngine(), source: disc(5, 5) });
    const seen: string[] = [];
    const h = sessionToolHandler({ session, registry: designRegistry(), onResult: (c, out) => seen.push(`${c.name}:${out.data?.kind ?? "-"}`) });
    const bad = await h(call(1, "propose", { summary: 3 }));
    expect(bad.isError).toBe(true);
    expect(bad.close).toBeUndefined();
    const ok = await h(call(2, "propose", { summary: "Disc.", assumptions: [], known_issues: [] }));
    expect(ok).toEqual({ text: "Proposal recorded (model verified).", isError: false, close: "proposed" });
    expect(seen).toEqual(["propose:bad_input", "propose:propose"]);
  });

  it("closes the spec phase on submit_spec and reports the user's wait for ask_user", async () => {
    const session = await DesignSession.open({ engine: new StubEngine() });
    const h = sessionToolHandler({
      session,
      registry: designRegistry(),
      askUser: async (qs) => {
        await new Promise((r) => setTimeout(r, 30));
        return qs.map(() => "10 mm");
      },
    });
    const asked = await h(call(1, "ask_user", { questions: [{ id: "q1", question: "How thick?", default: "5 mm" }] }));
    expect(asked.text).toBe("q1: How thick?\n  answer: 10 mm");
    expect(asked.userWaitMs).toBeGreaterThanOrEqual(25);
    const tests = await h(call(2, "set_spec_tests", { tests: [{ id: "one_body", description: "R1: one body", check: "body_count", eq: 1 }] }));
    expect(tests.isError, tests.text).toBe(false);
    const spec = await h(call(3, "submit_spec", { summary: "A disc.", requirements: [{ id: "R1", text: "one body" }], assumptions: [], key_dimensions: [] }));
    expect(spec.isError, spec.text).toBe(false);
    expect(spec.close).toBe("spec_submitted");
  });

  it("question mode refuses edits", async () => {
    const session = await DesignSession.open({ engine: new StubEngine(), source: disc(5, 5) });
    const h = sessionToolHandler({ session, registry: designRegistry(), readOnly: true });
    const r = await h(call(1, "apply_cadscript", { source: disc(1, 1) }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not available in question mode/);
    expect(session.applies).toBe(0);
  });
});
