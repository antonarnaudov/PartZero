/**
 * The op tools (generated from the model-ops catalogue) on an in-memory document and the real Forge
 * engine: every catalogue op but the host-only ones is a tool; the schemas are strict; an agent
 * builds a part by operating the tools (sketch → extrude → parameter → edit), reads the model, and
 * is refused — with the reason — where the command layer refuses.
 */
import { existsSync, readFileSync } from "node:fs";
import { forgeWebCommandEngine, HOST_ONLY_OPS, MemoryOpsHost, OP_CATALOGUE, blankDocument, parseDoc, type ForgeWebCommandModule, type IrCommandEngine } from "@aicad/model-ops";
import { beforeAll, describe, expect, it } from "vitest";
import { OPS_READ_TOOLS, OPS_TOOLS, opsRegistry, type OpsToolContext } from "../src/ops.js";

const wasmUrl = new URL("../../forge-web/pkg/forge_wasm_bg.wasm", import.meta.url);
const hasWasm = existsSync(wasmUrl);
if (!hasWasm && process.env["CI"]) throw new Error("agent-tools ops: packages/forge-web/pkg is not built");
const it_ = hasWasm ? it : it.skip;

let engine: IrCommandEngine;
beforeAll(async () => {
  if (!hasWasm) return;
  const entry = new URL("../../forge-web/src/engine.ts", import.meta.url).pathname;
  const mod = (await import(/* @vite-ignore */ entry)) as ForgeWebCommandModule & { init(input: unknown): Promise<void> };
  await mod.init(readFileSync(wasmUrl));
  engine = forgeWebCommandEngine(mod);
}, 60_000);

describe("the op tools", () => {
  it("are generated for every catalogue op except the host-only ones (snapshot of the tool list)", () => {
    const registry = opsRegistry();
    const names = registry.names();
    for (const o of OP_CATALOGUE) {
      if (HOST_ONLY_OPS.has(o.op)) {
        expect(o.tool, `${o.op} is host-only`).toBeUndefined();
        continue;
      }
      expect(o.tool, `${o.op} has a tool or is on the host-only list`).toBeDefined();
      expect(names).toContain(o.tool);
    }
    expect(names).toEqual([...OPS_TOOLS]);
    expect(names).toEqual([
      "accept_ref_candidate",
      "accept_ref_proposal",
      "add_feature",
      "add_param",
      "apply_ops",
      "capture_ref",
      "delete_feature",
      "delete_param",
      "feasible_range",
      "feature_dependents",
      "get_feature",
      "get_model",
      "move_feature",
      "param_uses",
      "ref_for",
      "rename_curve",
      "rename_feature",
      "rename_param",
      "set_appearance",
      "set_field",
      "set_param",
      "set_rollback",
      "set_suppressed",
      "update_feature",
      "upgrade_feature",
      "write_back_solution",
    ]);
    for (const n of OPS_READ_TOOLS) expect(registry.get(n)?.readOnly).toBe(true);
  });

  it("have strict schemas: every object closed, JSON values as text", () => {
    const registry = opsRegistry();
    const add = registry.schema("add_feature") as { properties: Record<string, unknown>; additionalProperties: boolean; required: string[] };
    expect(add.additionalProperties).toBe(false);
    expect(Object.keys(add.properties).sort()).toEqual(["ack", "after", "feature_json", "part"]);
    expect(add.required).toContain("feature_json");
    const set = registry.schema("set_field") as { properties: Record<string, unknown> };
    expect(Object.keys(set.properties).sort()).toEqual(["ack", "feature", "path", "remove", "value_json"]);
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (o["type"] === "object") expect(o["additionalProperties"]).toBe(false);
      for (const v of Object.values(o)) walk(v);
    };
    for (const n of registry.names()) walk(registry.schema(n));
  });
});

describe("an agent operating the tools", () => {
  async function session(): Promise<{ ctx: OpsToolContext; host: MemoryOpsHost; call: (name: string, input: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }> }> {
    const host = await MemoryOpsHost.open({ engine, document: blankDocument("bracket"), origin: "agent" });
    const ctx: OpsToolContext = { ops: host };
    const registry = opsRegistry();
    return { ctx, host, call: (name, input) => registry.execute({ name, input }, ctx) };
  }

  it_("builds a plate: sketch, extrude, a parameter driving the thickness; reads it back", async () => {
    const { host, call } = await session();
    const sketch = { type: "sketch", name: "outline", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: 60, h: 40 }] };
    let r = await call("add_feature", { feature_json: JSON.stringify(sketch) });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/Done: Add sketch outline/);
    r = await call("apply_ops", {
      ops_json: JSON.stringify([
        { op: "addParam", name: "thick", unit: "mm", value: 6 },
        { op: "addFeature", feature: { type: "extrude", name: "plate", sketch: "sketch1", distance: "thick" } },
      ]),
      label: "Plate",
    });
    expect(r.isError, r.text).toBeFalsy();
    r = await call("set_param", { name: "thick", value: 8 });
    expect(r.isError, r.text).toBeFalsy();
    r = await call("get_model", {});
    expect(r.text).toContain("thick (mm) = 8");
    expect(r.text).toMatch(/extrude1 plate \[extrude\] ok \(agent-made\)/);
    expect(r.text).toContain("volume 19200.00");
    const doc = parseDoc(await host.document());
    expect(doc.parts[0]!.features.map((f) => [f.id, f["author"]])).toEqual([
      ["sketch1", "agent"],
      ["extrude1", "agent"],
    ]);
    r = await call("set_field", { feature: "plate", path: "/distance", value_json: '{"expr": "thick * 2"}' });
    expect(r.isError, r.text).toBeFalsy();
    r = await call("get_feature", { feature: "plate" });
    expect(r.text).toContain('"distance": "thick * 2"');
  });

  it_("is refused with the command layer's reason, and nothing changes", async () => {
    const { host, call } = await session();
    await call("add_feature", { feature_json: JSON.stringify({ type: "sketch", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 5 }] }) });
    await call("add_feature", { feature_json: JSON.stringify({ type: "extrude", sketch: "sketch1", distance: 3 }) });
    const before = await host.document();
    let r = await call("delete_feature", { feature: "sketch1" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/COMMAND_HAS_DEPENDENTS/);
    expect(r.text).toContain("extrude1");
    r = await call("add_feature", { feature_json: JSON.stringify({ type: "extrude", sketch: "nope", distance: 3 }) });
    expect(r.text).toMatch(/Refused \(UNRESOLVED_SKETCH\)/);
    r = await call("add_feature", { feature_json: "{not json" });
    expect(r.text).toMatch(/COMMAND_BAD_JSON/);
    r = await call("apply_ops", { ops_json: JSON.stringify([{ op: "setAuthor", features: ["sketch1"], author: "user" }]) });
    expect(r.text).toMatch(/user's to do/);
    r = await call("feature_dependents", { feature: "sketch1" });
    expect(r.text).toContain("extrude1");
    expect(await host.document()).toBe(before);
    const ro = await opsRegistry().execute({ name: "set_param", input: { name: "x", value: 1 } }, { ops: host, readOnly: true });
    expect(ro.isError).toBe(true);
  });

  it_("chains the manual tools' queries: ref_for a picked edge, feasible_range, then a fillet, a shell and a mirror", async () => {
    const { host, call } = await session();
    await call("add_feature", { feature_json: JSON.stringify({ type: "sketch", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: 40, h: 20 }] }) });
    await call("add_feature", { feature_json: JSON.stringify({ type: "extrude", sketch: "sketch1", distance: 10 }) });
    // The user's selection chip: an edge by its render name and the point where it was picked.
    let r = await call("ref_for", { kind: "edge", picks: [{ kind: "edge", name: "extrude1/edge:{extrude1/cap:end|extrude1/side:r.top}", point: [3, 10, 10] }] });
    expect(r.isError, r.text).toBeFalsy();
    const ref = JSON.parse(/^ref: (.*)$/m.exec(r.text)![1]!) as Record<string, unknown>;
    expect(ref["capture"]).toBeTruthy();
    r = await call("feasible_range", { candidate_json: JSON.stringify({ type: "fillet", r: 1, edges: ref }) });
    expect(r.text).toMatch(/r of .*≤ 9\.999 mm/);
    r = await call("add_feature", { feature_json: JSON.stringify({ type: "fillet", r: 3, edges: ref }) });
    expect(r.isError, r.text).toBeFalsy();
    r = await call("feasible_range", { feature: "fillet1" });
    expect(r.text).toMatch(/≤ 9\.999 mm/);
    // A shell with the bottom open, picked by face name; then the body mirrored as a new body.
    r = await call("ref_for", { kind: "face", picks: [{ kind: "face", name: "extrude1/cap:start" }] });
    const open = JSON.parse(/^ref: (.*)$/m.exec(r.text)![1]!) as Record<string, unknown>;
    r = await call("ref_for", { kind: "body", picks: [{ kind: "body", body: { feature: "extrude1", member: "r.bottom" } }] });
    const body = JSON.parse(/^ref: (.*)$/m.exec(r.text)![1]!) as Record<string, unknown>;
    r = await call("add_feature", { feature_json: JSON.stringify({ type: "shell", body, open, thickness: 1.5 }) });
    expect(r.isError, r.text).toBeFalsy();
    r = await call("add_feature", { feature_json: JSON.stringify({ type: "pattern", seed: { bodies: body }, layout: { mirror: { plane: { origin: [25, 0, 0], normal: [1, 0, 0], x_dir: [0, 1, 0] } } } }) });
    expect(r.isError, r.text).toBeFalsy();
    const rep = await host.report();
    expect(rep.features.map((f) => [f.feature_id, f.status])).toEqual([
      ["sketch1", "ok"],
      ["extrude1", "ok"],
      ["fillet1", "ok"],
      ["shell1", "ok"],
      ["pattern1", "ok"],
    ]);
    expect(rep.parts[0]!.bodies).toHaveLength(2);
    r = await call("ref_for", { kind: "edge", picks: [{ kind: "edge", name: "nope/edge:{a|b}" }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/COMMAND_PICK_NOT_FOUND/);
  });
});
