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
      "combine",
      "datum_axis",
      "datum_plane",
      "delete_feature",
      "delete_param",
      "extrude",
      "feature_dependents",
      "get_feature",
      "get_model",
      "hole",
      "move_feature",
      "param_uses",
      "push_pull",
      "rename_curve",
      "rename_feature",
      "rename_param",
      "revolve",
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

  it_("operates the hand tools: extrude, hole, push/pull and a datum plane, chained, each one undoable step", async () => {
    const { host, call } = await session();
    await call("add_feature", { feature_json: JSON.stringify({ type: "sketch", name: "outline", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: 60, h: 40 }] }) });
    let r = await call("extrude", { sketch: "outline", distance: 6 });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/Done: Extrude outline .*feature extrude1/);
    r = await call("hole", { face: "extrude1/cap:end", at: [{ u: 20, v: 10 }, { u: -20, v: -10 }], size: "M4", kind: "countersink" });
    expect(r.isError, r.text).toBeFalsy();
    r = await call("push_pull", { face: "extrude1/cap:end", offset: 2 });
    expect(r.isError, r.text).toBeFalsy();
    r = await call("datum_plane", { from: "extrude1/cap:end", distance: 5 });
    expect(r.isError, r.text).toBeFalsy();
    const doc = parseDoc(await host.document());
    expect(doc.parts[0]!.features.map((f) => [f.id, f["author"]])).toEqual([
      ["sketch1", "agent"],
      ["extrude1", "agent"],
      ["hole1", "agent"],
      ["datum_plane1", "agent"],
    ]);
    expect(doc.parts[0]!.features[1]!["distance"]).toBe(8);
    expect(doc.parts[0]!.features[2]).toMatchObject({ size: "M4", csink: "iso10642", depth: "through" });
    // A refusal names the field and the reason; nothing changes.
    const before = await host.document();
    r = await call("hole", { face: "extrude1/side:r.left", at: [{ u: 99, v: 0 }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Refused \(COMMAND_FEATURE_FAILS\)/);
    r = await call("push_pull", { face: "extrude1/side:r.left", offset: 1 });
    expect(r.text).toMatch(/MODEL_NO_DRIVER.*sketch/);
    expect(await host.document()).toBe(before);
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
});
