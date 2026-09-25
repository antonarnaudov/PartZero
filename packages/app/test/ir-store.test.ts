/**
 * The IR v1 store as the app's document of record (FULL-MODELING-PLAN §2.1–§2.3) on the real
 * Forge engine: the catalogue's commands (generated from `@aicad/model-ops`), undo groups, the host
 * state recorded with the document, change events, authorship by caller, and the "N features will
 * newly fail — Apply anyway?" flow of a user gesture.
 */
import { OP_CATALOGUE } from "@aicad/model-ops";
import { beforeAll, describe, expect, it } from "vitest";
import { forgeWebCommandEngine, missingCommandMembers, type ForgeWebCommandModule, type IrCommandEngine } from "../src/doc/v1/command-engine";
import { IrDocStore, type IrDocChange } from "../src/doc/v1/ir-doc-store";
import { makeHarness } from "./helpers";

const nodeFs = "node:fs";
const fs = (await import(/* @vite-ignore */ nodeFs)) as { existsSync(p: URL): boolean; readFileSync(p: URL): Uint8Array };
const wasmUrl = new URL("../../forge-web/pkg/forge_wasm_bg.wasm", import.meta.url);
const hasWasm = fs.existsSync(wasmUrl);
const it_ = hasWasm ? it : it.skip;

let engine: IrCommandEngine;
beforeAll(async () => {
  if (!hasWasm) return;
  const entry = new URL("../../forge-web/src/engine.ts", import.meta.url).pathname;
  const mod = (await import(/* @vite-ignore */ entry)) as ForgeWebCommandModule & { init(input: unknown): Promise<void> };
  await mod.init(fs.readFileSync(wasmUrl));
  expect(missingCommandMembers(mod)).toEqual([]);
  engine = forgeWebCommandEngine(mod);
}, 60_000);

const BLANK = JSON.stringify({ schema: "aicad.ir/1", meta: { name: "t" }, parts: [{ id: "p1", name: "part", features: [] }] });
const rect = { type: "sketch", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: 40, h: 20 }] };

async function newStore(): Promise<IrDocStore> {
  const s = new IrDocStore({ engine: () => engine });
  await s.load(BLANK);
  return s;
}

function featureIds(s: IrDocStore): string[] {
  return (JSON.parse(s.document) as { parts: Array<{ features: Array<{ id: string }> }> }).parts[0]!.features.map((f) => f.id);
}

describe("IrDocStore v2", () => {
  it_("groups: steps are live and locally undoable; seal makes one undo step; abort restores", async () => {
    const s = await newStore();
    const base = s.document;
    const events: IrDocChange["kind"][] = [];
    s.onDidChange((e) => events.push(e.kind));
    await s.openGroup({ label: "Agent: make a plate", origin: "agent" });
    await s.apply({ op: "addFeature", feature: rect }, { origin: "agent" });
    await s.apply({ op: "addFeature", feature: { type: "extrude", sketch: "sketch1", distance: 5 } }, { origin: "agent" });
    expect(featureIds(s)).toEqual(["sketch1", "extrude1"]);
    expect(s.getState().group).toMatchObject({ label: "Agent: make a plate", steps: 2 });
    // Inside the group, undo steps back one transaction.
    expect(s.undo()).toBe(true);
    expect(featureIds(s)).toEqual(["sketch1"]);
    expect(s.redo()).toBe(true);
    const sealed = await s.sealGroup();
    expect(sealed).toEqual({ changed: true, steps: 2 });
    expect(s.getState().history.undoLabel).toBe("Agent: make a plate");
    expect(s.undo()).toBe(true);
    expect(s.document).toBe(base);
    expect(s.getState().history.canUndo).toBe(false);
    expect(s.redo()).toBe(true);
    expect(featureIds(s)).toEqual(["sketch1", "extrude1"]);
    // Abort restores the document from before the group.
    const before = s.document;
    await s.openGroup({ label: "try", origin: "user" });
    await s.apply({ op: "setField", feature: "extrude1", path: "/distance", value: 9 });
    await expect(s.openGroup({ label: "nested", origin: "user" })).rejects.toMatchObject({ code: "IR_GROUP_OPEN" });
    await s.abortGroup();
    expect(s.document).toBe(before);
    expect(events).toEqual(["group-open", "commit", "commit", "undo", "redo", "group-seal", "undo", "redo", "group-open", "commit", "group-abort"]);
  });

  it_("records the rollback marker and appearance with the document (undo restores both)", async () => {
    const s = await newStore();
    await s.apply({ op: "addFeature", feature: rect });
    await s.apply({ op: "addFeature", feature: { type: "extrude", sketch: "sketch1", distance: 5 } });
    await s.apply({ op: "setRollback", after: "sketch1" });
    expect(s.marker).toBe("sketch1");
    await s.apply({ op: "addFeature", feature: { type: "extrude", sketch: "sketch1", distance: 2, op: "new_body" } });
    expect(featureIds(s)).toEqual(["sketch1", "extrude2", "extrude1"]);
    expect(s.marker).toBe("extrude2");
    await s.apply({ op: "setAppearance", feature: "extrude1", color: "#FF8800" });
    expect(s.getState().host.appearance).toEqual({ extrude1: "#ff8800" });
    expect(s.undo() && s.undo()).toBe(true);
    expect(s.getState().host).toEqual({ rollback: "sketch1", appearance: {} });
    expect(s.undo()).toBe(true);
    expect(s.marker).toBeNull();
  });

  it_("the catalogue's commands: every op is a command; the caller decides authorship; host-only ops refuse agents", async () => {
    const h = await makeHarness();
    h.services.ir = await newStore();
    const ids = new Set(h.commands.describe().map((c) => c.id));
    for (const o of OP_CATALOGUE) expect(ids.has(`ir.${o.op}`), o.op).toBe(true);
    const s = await h.commands.execute({ id: "ir.addFeature", args: { feature: rect } }, { source: "palette" });
    expect(s.ok).toBe(true);
    const e = await h.commands.execute({ id: "ir.addFeature", args: { feature: { type: "extrude", sketch: "sketch1", distance: 4 } } }, { source: "agent" });
    expect(e.ok).toBe(true);
    const doc = JSON.parse(h.services.ir.document) as { parts: Array<{ features: Array<{ id: string; author?: string }> }> };
    expect(doc.parts[0]!.features.map((f) => [f.id, f.author ?? null])).toEqual([
      ["sketch1", null],
      ["extrude1", "agent"],
    ]);
    const keep = await h.commands.execute({ id: "ir.setAuthor", args: { features: ["extrude1"], author: "user" } }, { source: "agent" });
    expect(!keep.ok && keep.error.detail?.code).toBe("COMMAND_HOST_ONLY");
    const deps = await h.commands.execute({ id: "ir.dependents", args: { feature: "sketch1" } }, { source: "agent" });
    expect(deps.ok && deps.value.dependents.map((d) => d.id)).toEqual(["extrude1"]);
    const del = await h.commands.execute({ id: "ir.deleteFeature", args: { feature: "sketch1" } }, { source: "palette" });
    expect(!del.ok && del.error.detail?.code).toBe("COMMAND_HAS_DEPENDENTS");
  });

  it_("a user gesture that makes features newly fail asks, and applies acknowledged on yes", async () => {
    const h = await makeHarness();
    h.services.ir = await newStore();
    await h.commands.execute({ id: "ir.addFeature", args: { feature: rect } }, { source: "palette" });
    await h.commands.execute({ id: "ir.addFeature", args: { feature: { type: "extrude", sketch: "sketch1", distance: 4 } } }, { source: "palette" });
    h.confirmAnswer.value = false;
    const no = await h.commands.execute({ id: "ir.setSuppressed", args: { feature: "sketch1", suppressed: true } }, { source: "ui" });
    expect(!no.ok && no.error.detail?.code).toBe("COMMAND_NEW_FAILURES");
    h.confirmAnswer.value = true;
    const yes = await h.commands.execute({ id: "ir.setSuppressed", args: { feature: "sketch1", suppressed: true } }, { source: "ui" });
    expect(yes.ok && yes.value.newFailures?.map((f) => f.id)).toEqual(["extrude1"]);
    // Programmatic callers are never asked: they pass `ack`.
    const agent = await h.commands.execute({ id: "ir.setSuppressed", args: { feature: "sketch1", suppressed: false } }, { source: "test" });
    expect(agent.ok).toBe(true);
  });
});
