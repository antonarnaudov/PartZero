/**
 * The op agent's read-only tools on the real Forge engine: semantic references resolved on the
 * live document (find_entities), entities listed with verified named queries (list_entities),
 * measurements, the Forge check, the step check every committed change carries, narration notes,
 * and op-worded repair hints on refusals.
 */
import { blankDocument, MemoryOpsHost, parseDoc } from "@aicad/model-ops";
import { beforeAll, describe, expect, it } from "vitest";
import { namedQueriesOfKey, faceQueryOfKey } from "../src/ops-query.js";
import { OPS_PLAYBOOK, opsRepairHint } from "../src/ops-playbooks.js";
import { opsRegistry, type OpsToolContext } from "../src/ops.js";
import { forgeEngine, HAS_WASM } from "./forge-engine.js";

const it_ = HAS_WASM ? it : it.skip;
const j = (v: unknown): string => JSON.stringify(v);

beforeAll(async () => {
  if (HAS_WASM) await forgeEngine();
}, 60_000);

async function cube(): Promise<{ host: MemoryOpsHost; call: (name: string, input: Record<string, unknown>) => Promise<{ text: string; isError?: boolean; data?: Record<string, unknown> }> }> {
  const host = await MemoryOpsHost.open({ engine: await forgeEngine(), document: blankDocument("cube"), origin: "agent" });
  const ctx: OpsToolContext = { ops: host };
  const registry = opsRegistry();
  const call = (name: string, input: Record<string, unknown>) => registry.execute({ name, input }, ctx) as Promise<{ text: string; isError?: boolean; data?: Record<string, unknown> }>;
  await call("add_feature", { feature_json: j({ type: "sketch", id: "base", name: "base", plane: "XY", curves: [{ kind: "rect", id: "outline", center: [0, 0], w: 40, h: 40 }] }) });
  await call("add_feature", { feature_json: j({ type: "extrude", id: "cube", name: "cube", sketch: "base", distance: 40 }) });
  return { host, call };
}

describe("named queries from provenance keys", () => {
  it("synthesizes the source a face key names", () => {
    expect(faceQueryOfKey("e1/cap:end@outline.bottom")).toEqual({ op: "cap", feature: "e1", end: "end" });
    expect(faceQueryOfKey("e1/side:outline.left")).toEqual({ op: "side", feature: "e1", curve: "outline.left" });
    expect(faceQueryOfKey("h1/wall@c")).toEqual({ op: "hole_face", feature: "h1", at: "c", part: "wall" });
    expect(faceQueryOfKey("f1/blend:{e1/edge:{a|b}}")).toBeNull();
  });

  it("gives an edge its junction query and the between of its faces", () => {
    const qs = namedQueriesOfKey("edge", "e1/edge:{e1/side:outline.bottom|e1/side:outline.left}@outline.bottom.start");
    expect(qs[0]).toEqual({ op: "edge_at", feature: "e1", curve: "outline.bottom", end: "start" });
    expect(qs[1]).toEqual({ op: "between", a: { op: "side", feature: "e1", curve: "outline.bottom" }, b: { op: "side", feature: "e1", curve: "outline.left" } });
    expect(namedQueriesOfKey("body", "e1/body:outline.bottom")[0]).toEqual({ op: "body", feature: "e1" });
  });
});

describe("finding entities by semantic references", () => {
  it_("resolves a Ref on the live model: the four vertical edges of the cube, with their probes", async () => {
    const { call } = await cube();
    const r = await call("find_entities", { ref_json: j({ kind: "edge", q: { op: "filter", where: { parallel: "Z" }, of: { op: "edges", of: { op: "sides", feature: "cube" } } } }) });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/^4 edges \(card "some" or 4 fits; "one" would fail: REF_AMBIGUOUS\)/);
    expect(r.text).toContain("edge through [-20, -20, 20]");
    expect(r.data?.["count"]).toBe(4);
  });

  it_("says when a card would fail, and explains an invalid query with the op-worded hint", async () => {
    const { call } = await cube();
    let r = await call("find_entities", { ref_json: j({ kind: "face", q: { op: "cap", feature: "cube", end: "end" }, card: "one" }) });
    expect(r.text).toMatch(/^unique/);
    r = await call("find_entities", { ref_json: j({ kind: "edge", q: { op: "filter", where: { normal: "+Z" }, of: { op: "edges", of: { op: "bodies" } } } }) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("QUERY_INVALID");
    expect(r.text).toContain("/q/where");
    expect(r.text).toContain("fix: The query is not well-formed");
    r = await call("find_entities", { ref_json: j({ op: "bodies" }) });
    expect(r.text).toMatch(/needs kind/);
  });

  it_("evaluates at a point of the timeline (after)", async () => {
    const { call } = await cube();
    await call("add_feature", { feature_json: j({ type: "fillet", id: "rounds", name: "rounds", r: 2, edges: { kind: "edge", q: { op: "filter", where: { parallel: "Z" }, of: { op: "edges", of: { op: "sides", feature: "cube" } } } } }) });
    const before = await call("find_entities", { ref_json: j({ kind: "face", q: { op: "faces", of: { op: "bodies" } } }), after: "cube" });
    const after = await call("find_entities", { ref_json: j({ kind: "face", q: { op: "faces", of: { op: "bodies" } } }) });
    expect(before.data?.["count"]).toBe(6);
    expect(after.data?.["count"]).toBe(10);
  });

  it_("lists entities nearest to a point with verified named refs", async () => {
    const { call } = await cube();
    const r = await call("list_entities", { kind: "face", near: [0, 0, 40], limit: 2 });
    expect(r.isError, r.text).toBeFalsy();
    const lines = r.text.split("\n");
    expect(lines[0]).toMatch(/^6 faces, nearest to \[0, 0, 40\] first:/);
    expect(lines[1]).toContain("cube/cap:end");
    expect(lines[2]).toContain('ref: {"kind":"face","q":{"op":"cap","feature":"cube","end":"end"}}');
    const e = await call("list_entities", { kind: "edge", of: "cube", near: [20, 20, 20], limit: 1 });
    expect(e.text).toMatch(/ref: \{"kind":"edge","q":\{"op":"edge_at","feature":"cube","curve":"outline\.\w+","end":"(start|end)"\}\}/);
  });
});

describe("measure, check and the step check", () => {
  it_("every committed change carries Forge's check of the whole model and the narration note", async () => {
    const { call } = await cube();
    const r = await call("add_feature", {
      feature_json: j({ type: "hole", id: "bore", name: "bore", on: { face: { kind: "face", q: { op: "cap", feature: "cube", end: "end" } } }, at: { list: [{ id: "c", at: [0, 0] }] }, d: 10, depth: "through" }),
      note: "Drill the Ø10 bore through the top",
    });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/Check: ✓ 3 features ok · 1 body valid, 40×40×40 mm, V 60858\.4\d* mm³/);
    expect(r.data).toMatchObject({ kind: "ops_commit", note: "Drill the Ø10 bore through the top", features: ["bore"], checkOk: true });
    const m = await call("measure", { feature: "bore" });
    expect(m.text).toContain("hole c: Ø10 through");
    const c = await call("check_model", {});
    expect(c.text.split("\n")[0]).toMatch(/^✓ 3 features ok · 1 body valid/);
    expect(c.data).toMatchObject({ kind: "check", ok: true });
  });

  it_("a refusal carries the op-worded fix and the engine's numbers", async () => {
    const { call, host } = await cube();
    const before = await host.document();
    const r = await call("add_feature", { feature_json: j({ type: "fillet", id: "big", name: "big", r: 30, edges: { kind: "edge", q: { op: "filter", where: { parallel: "Z" }, of: { op: "edges", of: { op: "sides", feature: "cube" } } } } }), note: "Round the corners" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Refused (COMMAND_FEATURE_FAILS)");
    expect(r.text).toContain("fix: The feature you added or edited would not build");
    expect(r.text).toMatch(/largest value that builds: max_feasible_r = \d/);
    expect(r.data).toMatchObject({ kind: "ops_refused", code: "COMMAND_FEATURE_FAILS", inner: "FILLET_RADIUS_TOO_LARGE", note: "Round the corners" });
    expect(await host.document()).toBe(before);
    expect(parseDoc(before).parts[0]!.features).toHaveLength(2);
  });
});

describe("the op playbooks", () => {
  it("cover every command-layer refusal code", () => {
    const codes = [
      "COMMAND_FEATURE_FAILS",
      "COMMAND_PARAM_FAILS",
      "COMMAND_NEW_FAILURES",
      "COMMAND_HAS_DEPENDENTS",
      "COMMAND_PARAM_IN_USE",
      "COMMAND_PARAM_FAILED",
      "COMMAND_ILLEGAL_ORDER",
      "COMMAND_UNKNOWN_FEATURE",
      "COMMAND_UNKNOWN_PARAM",
      "COMMAND_UNKNOWN_PART",
      "COMMAND_WRONG_PART",
      "COMMAND_BAD_PATH",
      "COMMAND_BAD_VALUE",
      "COMMAND_BAD_JSON",
      "COMMAND_FIXED_FIELD",
      "COMMAND_HOST_ONLY",
      "COMMAND_AUTHOR_HOST_ONLY",
      "COMMAND_NOT_EXACT",
      "COMMAND_CANDIDATE_CHANGED",
      "COMMAND_UPGRADE_UNCONFIRMED",
      "unapproved_user_change",
      "IR_GROUP_OPEN",
      "IR_GROUP_CLOSED",
      "IR_TRANSACTION_CLOSED",
      "IR_DOCUMENT_CHANGED",
      "IR_NO_DOCUMENT",
      "IR_UNAVAILABLE",
      "IR_PARSE_ERROR",
    ];
    for (const c of codes) expect(OPS_PLAYBOOK[c], c).toBeTruthy();
  });

  it("never tell the op agent to write code", () => {
    for (const [code, text] of Object.entries(OPS_PLAYBOOK)) {
      expect(text, code).not.toMatch(/apply_cadscript|CadScript|param\(|\.one\(\)|patch/i);
    }
  });

  it("add the inner code's hint and the feasible values", () => {
    const lines = opsRepairHint({ code: "COMMAND_FEATURE_FAILS", details: { code: "SHELL_THICKNESS_TOO_LARGE", details: { max_feasible_thickness: 3.2 } } });
    expect(lines[0]).toBe(OPS_PLAYBOOK["COMMAND_FEATURE_FAILS"]);
    expect(lines[1]).toBe(OPS_PLAYBOOK["SHELL_THICKNESS_TOO_LARGE"]);
    expect(lines).toContain("largest value that builds: max_feasible_thickness = 3.2");
    expect(opsRepairHint({ code: "SOMETHING_NEW" })).toHaveLength(1);
  });
});
