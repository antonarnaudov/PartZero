/**
 * The live operator (operator.ts) with scripted models on the real Forge engine and an in-memory
 * document: the agent builds a part by operating the command layer's op tools — plan, sketch,
 * feature, verified step by step, narrated live — and never writes code; Stop keeps what was built;
 * refusals are repaired from their hints; the autonomy dial's per-step review undoes a step; the
 * user's work changes only with their approval; the wall clock and the refusal caps stop the run;
 * a question is answered read-only; runtime mode drives the same path through the broker handler.
 */
import { parseDoc, type MemoryOpsHost } from "@aicad/model-ops";
import { beforeAll, describe, expect, it } from "vitest";
import { Agent, ScriptedTransport, scriptedGateway, type AgentOptions, type ApprovalRequest, type OperatorStep, type ScriptedCall, type ScriptStep, type ScriptTurn } from "../src/index.js";
import { CLI_TEST_PROFILES, FakeRuntime, type FakeMessage } from "./fake-runtime.js";
import { forgeEngine, HAS_WASM, memoryHost } from "./forge-ops.js";
import { fakeClock } from "./helpers.js";

const it_ = HAS_WASM ? it : it.skip;
const j = (v: unknown): string => JSON.stringify(v);

beforeAll(async () => {
  if (HAS_WASM) await forgeEngine();
}, 60_000);

const call = (name: string, input: Record<string, unknown>, text?: string): ScriptTurn => ({ ...(text ? { text } : {}), tools: [{ name, input }] });
const addFeature = (feature: object, note: string): ScriptTurn => call("add_feature", { feature_json: j(feature), note });

const VERTICAL_EDGES = { kind: "edge", q: { op: "filter", where: { parallel: "Z" }, of: { op: "edges", of: { op: "sides", feature: "cube" } } } };
const SKETCH = { type: "sketch", id: "base", name: "base", plane: "XY", curves: [{ kind: "rect", id: "outline", center: [0, 0], w: "size", h: "size" }] };
const CUBE = { type: "extrude", id: "cube", name: "cube", sketch: "base", distance: "size" };
const FILLET = (r: number) => ({ type: "fillet", id: "rounds", name: "rounds", r, edges: VERTICAL_EDGES });
const BORE = { type: "hole", id: "bore", name: "bore", on: { face: { kind: "face", q: { op: "cap", feature: "cube", end: "end" } } }, at: { list: [{ id: "c", at: [0, 0] }] }, d: 10, depth: "through" };

/** The cube with a bore and filleted vertical edges, as a designer would operate it. */
function cubeScript(extra: { beforeFillet?: ScriptStep[] } = {}): ScriptStep[] {
  return [
    call("plan", { steps: ["Add a size parameter", "Sketch the base square", "Extrude it to a cube", "Round the vertical edges", "Drill the bore", "Check"] }, "Planning."),
    call("add_param", { name: "size", unit: "mm", value: 40, min: 10, note: "Add the 40 mm size parameter" }),
    addFeature(SKETCH, "Sketch the 40 mm base square on XY"),
    addFeature(CUBE, "Extrude it to a 40 mm cube"),
    call("find_entities", { ref_json: j(VERTICAL_EDGES) }),
    ...(extra.beforeFillet ?? []),
    addFeature(FILLET(2), "Round the four vertical edges (2 mm)"),
    addFeature(BORE, "Drill the Ø10 bore through the top"),
    call("check_model", {}),
    call("finish", { summary: "A 40 mm cube with a Ø10 through bore and 2 mm vertical fillets.", assumptions: ["bore centred on the top face"], known_issues: [] }),
  ];
}

async function setup(designer: ScriptStep[], options: Partial<AgentOptions> = {}, host?: MemoryOpsHost) {
  const ops = host ?? (await memoryHost());
  const transport = new ScriptedTransport({ designer });
  const gateway = scriptedGateway(transport, { profiles: CLI_TEST_PROFILES });
  const steps: OperatorStep[] = [];
  const plans: string[][] = [];
  const agent = new Agent({
    gateway,
    engine: undefined as never,
    now: fakeClock(),
    ops,
    ...options,
    hooks: { onStep: (s) => steps.push({ ...s }), onPlan: (p) => plans.push([...p]), ...options.hooks },
  });
  return { agent, transport, ops, steps, plans };
}

describe("the live operator", () => {
  it_("builds the part by operating the tools, step by step, narrated and checked by Forge", async () => {
    const { agent, transport, ops, steps, plans } = await setup(cubeScript());
    const r = await agent.run({ prompt: "a 40 mm cube with a 10 mm hole through the top and 2 mm fillets on the vertical edges", name: "cube" });
    expect(r.status, r.message).toBe("proposed");
    expect(r.surface).toBe("ops");
    expect(r.verified).toBe(true);
    expect(r.cadscript).toBe("");
    expect(plans).toEqual([["Add a size parameter", "Sketch the base square", "Extrude it to a cube", "Round the vertical edges", "Drill the bore", "Check"]]);
    expect(steps.map((s) => [s.index, s.ok, s.note])).toEqual([
      [1, true, "Add the 40 mm size parameter"],
      [2, true, "Sketch the 40 mm base square on XY"],
      [3, true, "Extrude it to a 40 mm cube"],
      [4, true, "Round the four vertical edges (2 mm)"],
      [5, true, "Drill the Ø10 bore through the top"],
    ]);
    expect(steps[2]!.check).toMatch(/^✓ 2 features ok · 1 body valid, 40×40×40 mm/);
    expect(steps[4]).toMatchObject({ label: "Add hole bore", features: ["bore"], checkOk: true });
    // The model: every feature built, authored by the agent, the bore and fillets there.
    const doc = parseDoc(await ops.document());
    expect(doc.parts[0]!.features.map((f) => [f.id, f.type, f["author"]])).toEqual([
      ["base", "sketch", "agent"],
      ["cube", "extrude", "agent"],
      ["rounds", "fillet", "agent"],
      ["bore", "hole", "agent"],
    ]);
    const body = (await ops.report()).parts![0]!.bodies[0]!;
    expect(body.volume).toBeCloseTo(40 ** 3 - Math.PI * 25 * 40 - 4 * (4 - Math.PI) * 40, 1);
    expect(r.document).toBe(await ops.document());
    // The designer never saw or wrote code: its tools are the op tools, and every result carries Forge's check.
    const first = transport.calls[0]!;
    const tools = ((first.payload["tools"] as Array<{ name: string }>) ?? []).map((t) => t.name);
    expect(tools).toContain("add_feature");
    expect(tools).toContain("find_entities");
    expect(tools).toContain("request_approval");
    expect(tools).not.toContain("apply_cadscript");
    expect(tools).not.toContain("write_back_solution");
    expect(first.allText).toContain("You never write code");
    expect(first.allText).toContain("# Feature reference (IR v1 JSON for add_feature / set_field)");
    expect(first.allText).toMatch(/<open_model nonce="[0-9a-f]{16}">/);
    const afterFind = transport.calls[5]!.toolResults[0]!.content;
    expect(afterFind).toMatch(/^4 edges/);
    expect(transport.calls[6]!.toolResults[0]!.content).toMatch(/Check: ✓ 3 features ok/);
    expect(r.trace.states).toEqual(["TRIAGE", "BUILD", "PROPOSE", "DONE"]);
  });

  it_("Stop keeps everything built so far", async () => {
    const controller = new AbortController();
    const script = cubeScript();
    // After the extrude committed, the user presses Stop while the next turn is being generated.
    script[4] = () => {
      controller.abort();
      return call("find_entities", { ref_json: j(VERTICAL_EDGES) });
    };
    const { agent, ops, steps } = await setup(script, { signal: controller.signal });
    const r = await agent.run({ prompt: "a cube with a bore and fillets", name: "cube" });
    expect(r.status).toBe("stopped");
    expect(r.stopReason).toBe("cancelled");
    expect(steps.filter((s) => s.ok).map((s) => s.index)).toEqual([1, 2, 3]);
    expect(parseDoc(await ops.document()).parts[0]!.features.map((f) => f.id)).toEqual(["base", "cube"]);
    expect(r.proposal?.summary).toMatch(/^Stopped \(cancelled\) after 3 steps; what was built stays/);
    expect(r.document).toBe(await ops.document());
  });

  it_("a refused step changes nothing and is repaired from its hint (the engine's largest radius)", async () => {
    const seen: ScriptedCall[] = [];
    const { agent, steps } = await setup(
      cubeScript({
        beforeFillet: [
          addFeature(FILLET(30), "Round the vertical edges (30 mm)"),
          (c) => {
            seen.push(c);
            return call("get_model", {});
          },
        ],
      }),
    );
    const r = await agent.run({ prompt: "a cube with big rounds", name: "cube" });
    expect(r.status, r.message).toBe("proposed");
    const refused = steps.find((s) => !s.ok)!;
    expect(refused).toMatchObject({ ok: false, index: 3, tool: "add_feature", note: "Round the vertical edges (30 mm)", code: "COMMAND_FEATURE_FAILS/FILLET_RADIUS_TOO_LARGE" });
    const text = seen[0]!.toolResults[0]!.content;
    expect(text).toContain("Refused (COMMAND_FEATURE_FAILS)");
    expect(text).toMatch(/largest value that builds: max_feasible_r = \d/);
    expect(r.trace.states).toContain("REPAIR");
    expect(r.trace.failedApplies).toBe(1);
  });

  it_("the same refusal three times in a row stops the run; what was built stays", async () => {
    const literal = { ...SKETCH, curves: [{ kind: "rect", id: "outline", center: [0, 0], w: 40, h: 40 }] };
    const { agent, ops, steps } = await setup([
      addFeature(literal, "Sketch"),
      addFeature({ ...CUBE, sketch: "nope", distance: 40 }, "Extrude"),
      addFeature({ ...CUBE, sketch: "nope", distance: 40 }, "Extrude"),
      (c) => {
        expect(c.userText).toContain("The same refusal twice in a row");
        return addFeature({ ...CUBE, sketch: "nope", distance: 40 }, "Extrude");
      },
    ]);
    const r = await agent.run({ prompt: "a cube", name: "cube" });
    expect(r.stopReason).toBe("same_error");
    expect(r.status).toBe("stopped");
    expect(steps.map((s) => s.ok)).toEqual([true, false, false, false]);
    // The sketch step stays.
    expect(parseDoc(await ops.document()).parts[0]!.features.map((f) => f.id)).toEqual(["base"]);
  });

  it_("Ask at each step: the user undoes a step, the agent sees it and builds it differently", async () => {
    const reviewed: number[] = [];
    let seen: ScriptedCall | undefined;
    const script: ScriptStep[] = [
      call("add_param", { name: "size", unit: "mm", value: 40, note: "Add size" }),
      addFeature(SKETCH, "Sketch the base"),
      addFeature({ ...CUBE, distance: 10 }, "Extrude 10 mm"),
      (c) => {
        seen = c;
        return addFeature(CUBE, "Extrude to the full 40 mm");
      },
      call("finish", { summary: "A 40 mm cube.", assumptions: [], known_issues: [] }),
    ];
    const { agent, ops, steps } = await setup(script, {
      autonomy: "ask",
      mode: "interactive",
      hooks: {
        reviewStep: async (s) => {
          reviewed.push(s.index);
          return s.note === "Extrude 10 mm" ? "undo" : "keep";
        },
      },
    });
    const r = await agent.run({ prompt: "a 40 mm cube", name: "cube" });
    expect(r.status, r.message).toBe("proposed");
    expect(reviewed).toEqual([1, 2, 3, 3]);
    expect(steps.find((s) => s.undone)).toMatchObject({ index: 3, note: "Extrude 10 mm", undone: true });
    expect(seen!.toolResults[0]!.content).toContain("The user UNDID this step");
    const f = parseDoc(await ops.document()).parts[0]!.features;
    expect(f.map((x) => [x.id, x["distance"]])).toEqual([
      ["base", undefined],
      ["cube", "size"],
    ]);
  });

  it_("the user's work changes only with their approval (request_approval → the host grants → the call lands)", async () => {
    const userDoc = j({
      schema: "aicad.ir/1",
      meta: { name: "plate" },
      params: [{ name: "thick", unit: "mm", value: 5 }],
      parts: [
        {
          id: "p1",
          name: "part",
          features: [
            { type: "sketch", id: "s1", name: "s1", plane: "XY", curves: [{ kind: "rect", id: "o", center: [0, 0], w: 60, h: 40 }] },
            { type: "extrude", id: "plate", name: "plate", sketch: "s1", distance: "thick" },
          ],
        },
      ],
    });
    const host = await memoryHost({ document: userDoc });
    const requests: ApprovalRequest[] = [];
    let refusal = "";
    const script: ScriptStep[] = [
      call("set_param", { name: "thick", value: 8, note: "Make the plate 8 mm thick" }),
      (c) => {
        refusal = c.toolResults[0]!.content;
        return call("request_approval", { params: ["thick"], reason: "Set the plate thickness to 8 mm as you asked" });
      },
      (c) => {
        expect(c.toolResults[0]!.content).toContain("The user allowed it");
        return call("set_param", { name: "thick", value: 8, note: "Make the plate 8 mm thick" });
      },
      call("finish", { summary: "The plate is 8 mm thick.", assumptions: [], known_issues: [] }),
    ];
    const { agent, steps } = await setup(
      script,
      {
        mode: "interactive",
        hooks: {
          requestApproval: async (req) => {
            requests.push(req);
            host.grant({ params: req.params, features: req.features });
            return true;
          },
        },
      },
      host,
    );
    const r = await agent.run({ prompt: "make it 8 mm thick", name: "plate" });
    expect(r.status, r.message).toBe("proposed");
    expect(refusal).toContain("unapproved_user_change");
    expect(refusal).toContain("fix: This would change the user's own work");
    expect(requests).toEqual([{ features: [], params: ["thick"], rollback: false, reason: "Set the plate thickness to 8 mm as you asked" }]);
    expect(steps.map((s) => s.ok)).toEqual([false, true]);
    const d = parseDoc(await host.document());
    expect(d.params?.[0]?.["value"]).toBe(8);
    expect(d.parts[0]!.features.map((f) => f["author"])).toEqual([undefined, undefined]);
  });

  it_("without an approval hook (headless) the request is declined and the user's work is untouched", async () => {
    const host = await memoryHost({ document: j({ schema: "aicad.ir/1", meta: { name: "p" }, params: [{ name: "thick", unit: "mm", value: 5 }], parts: [{ id: "p1", name: "part", features: [] }] }) });
    const { agent } = await setup(
      [
        call("set_param", { name: "thick", value: 8 }),
        call("request_approval", { params: ["thick"], reason: "thicker" }),
        (c) => {
          expect(c.toolResults[0]!.content).toContain("did not allow");
          return call("finish", { summary: "Left the thickness as it is.", assumptions: [], known_issues: ["thick not changed: not approved"] });
        },
      ],
      {},
      host,
    );
    const r = await agent.run({ prompt: "thicker", name: "p" });
    expect(parseDoc(await host.document()).params?.[0]?.["value"]).toBe(5);
    expect(r.status).toBe("proposed");
  });

  it_("the wall-clock cap stops the run and keeps the steps", async () => {
    const { agent, ops, steps } = await setup(cubeScript(), { limits: { maxWallMs: 400 } });
    const r = await agent.run({ prompt: "cube", name: "cube" });
    expect(r.stopReason).toBe("wall_time");
    expect(steps.length).toBeGreaterThan(0);
    expect(parseDoc(await ops.document()).parts[0]!.features.length).toBe(steps.filter((s) => s.ok && s.tool === "add_feature").length);
  });

  it_("a question is answered with the read-only tools (kind ask): nothing changes", async () => {
    const host = await memoryHost();
    const before = await host.document();
    const { agent, transport } = await setup([call("get_model", {}), call("finish", { summary: "The model is empty: no features yet.", assumptions: [], known_issues: [] })], { kind: "ask" }, host);
    const r = await agent.run({ prompt: "what is in the model?", name: "p" });
    expect(r.status).toBe("answered");
    expect(r.answer).toBe("The model is empty: no features yet.");
    const tools = ((transport.calls[0]!.payload["tools"] as Array<{ name: string }>) ?? []).map((t) => t.name);
    expect(tools).not.toContain("add_feature");
    expect(tools).toContain("find_entities");
    expect(await host.document()).toBe(before);
  });

  it_("finish is refused once while a feature fails, then recorded with the failure as a known issue", async () => {
    const literal = { ...SKETCH, curves: [{ kind: "rect", id: "outline", center: [0, 0], w: 40, h: 40 }] };
    let rejected = "";
    const { agent } = await setup([
      addFeature(literal, "Sketch"),
      addFeature({ ...CUBE, distance: 40 }, "Extrude"),
      addFeature(FILLET(2), "Round"),
      // Its own fillet newly fails: the agent may acknowledge that (ack), never a user's feature.
      call("set_field", { feature: "base", path: "/curves/0/w", value_json: "3", ack: ["rounds"], note: "Make it 3 mm wide" }),
      call("finish", { summary: "done", assumptions: [], known_issues: [] }),
      (c) => {
        rejected = c.toolResults[0]!.content;
        return call("finish", { summary: "done", assumptions: [], known_issues: [] });
      },
    ]);
    const r = await agent.run({ prompt: "a thin bar", name: "d" });
    expect(rejected).toContain("Not finished: the model does not check clean");
    expect(rejected).toContain("rounds");
    expect(r.status).toBe("proposed");
    expect(r.verified).toBe(false);
    expect(r.proposal?.known_issues).toContain("rounds (rounds) fails: FILLET_RADIUS_TOO_LARGE");
  });
});

describe("the live operator in agent-runtime mode (a CLI runs the loop through the broker)", () => {
  it_("every broker call runs the same path: steps land, the finish closes the broker", async () => {
    const turn = (name: string, input: Record<string, unknown>): FakeMessage => ({ calls: [{ name, input }] });
    const rt = new FakeRuntime({
      BUILD: {
        turns: [
          [
            turn("plan", { steps: ["Sketch", "Extrude", "Fillet"] }),
            turn("add_param", { name: "size", unit: "mm", value: 40, note: "Add size" }),
            turn("add_feature", { feature_json: j(SKETCH), note: "Sketch the base" }),
            turn("add_feature", { feature_json: j(CUBE), note: "Extrude the cube" }),
            turn("add_feature", { feature_json: j(FILLET(2)), note: "Round the vertical edges" }),
            turn("finish", { summary: "Cube with rounds.", assumptions: [], known_issues: [] }),
            turn("get_model", {}),
          ],
        ],
      },
    });
    const ops = await memoryHost();
    const transport = new ScriptedTransport({});
    const gateway = scriptedGateway(transport, { profiles: CLI_TEST_PROFILES });
    const steps: OperatorStep[] = [];
    const agent = new Agent({ gateway, engine: undefined as never, now: fakeClock(), models: { designer: "claude-cli:opus" }, runtime: rt, ops, hooks: { onStep: (s) => steps.push(s) } });
    const r = await agent.run({ prompt: "cube with rounds", name: "cube" });
    expect(r.status, r.message).toBe("proposed");
    expect(rt.specs[0]!.scope).toBe("ops");
    expect(rt.specs[0]!.tools.map((t) => t.name)).toContain("add_feature");
    expect(rt.specs[0]!.tools.find((t) => t.name === "find_entities")?.readOnly).toBe(true);
    expect(steps.map((s) => s.note)).toEqual(["Add size", "Sketch the base", "Extrude the cube", "Round the vertical edges"]);
    // The finish closed the broker: the call after it did not reach the handler.
    expect(rt.calls.at(-1)).toMatchObject({ name: "get_model", handled: false });
    expect(rt.calls.find((c) => c.name === "finish")?.result.close).toBe("proposed");
    expect(r.mode).toBe("cli-runtime");
    expect(parseDoc(await ops.document()).parts[0]!.features.map((f) => f.id)).toEqual(["base", "cube", "rounds"]);
  });
});
