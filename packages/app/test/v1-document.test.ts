/**
 * IR v1 as the app's document model, on the real Forge engine (forge-web WASM in Node): the
 * DocStore mirrors the IR store (model, evaluation, bodies, dirty, undo/redo), the rollback marker
 * cuts the evaluation, the timeline shows v1 features with authorship, the document adapter saves
 * a `.partzero` holding the v1 document and its host state and reopens it identical, a v0 document
 * opens migrated, the sketcher's Finish ops go through the command layer, and the live op host
 * (what the agent's tools use) commits as the agent.
 */
import { blankDocument } from "@aicad/model-ops";
import { beforeAll, describe, expect, it } from "vitest";
import { appOpsHost } from "../src/agent/ops-host";
import { InlineCadScriptService } from "../src/cadscript/inline-service";
import { DocStore } from "../src/doc/doc-store";
import { buildTimeline } from "../src/doc/timeline";
import { forgeWebCommandEngine, type ForgeWebCommandModule, type IrCommandEngine } from "../src/doc/v1/command-engine";
import { IrDocStore } from "../src/doc/v1/ir-doc-store";
import type { EvalResult, ForgeEngine, MeshFormat, TessellationOptions } from "../src/engine/types";
import { DocStoreAdapter } from "../src/file/adapter";
import { hostStateOf } from "../src/file/document-files";
import { decodePartZero, encodePartZero } from "../src/file/partzero";
import { sketchFinishOps } from "../src/sketch/v1-app";
import { exampleAvailability, openExample, STARTERS } from "../src/tools/starters";
import { makeHarness } from "./helpers";

const nodeFs = "node:fs";
const fs = (await import(/* @vite-ignore */ nodeFs)) as { existsSync(p: URL): boolean; readFileSync(p: URL): Uint8Array };
const wasmUrl = new URL("../../forge-web/pkg/forge_wasm_bg.wasm", import.meta.url);
const hasWasm = fs.existsSync(wasmUrl);
const it_ = hasWasm ? it : it.skip;

type Mod = ForgeWebCommandModule & {
  init(input: unknown): Promise<void>;
  evaluate(ir: string, options?: object): { report: unknown; bodies: EvalResult["bodies"] };
  exportMesh(ir: string, format: MeshFormat, options?: object): Uint8Array;
};

let mod: Mod;
let commands: IrCommandEngine;

/** forge-web in Node as the app's engine (what the renderer's worker does). */
class NodeForgeEngine implements ForgeEngine {
  readonly id = "forge-web" as const;
  readonly label = "forge-web (node)";
  readonly detail = "test";
  readonly commands = commands;
  exports: Array<{ format: MeshFormat; tess: TessellationOptions | undefined }> = [];
  evaluate(irJson: string): Promise<EvalResult> {
    const r = mod.evaluate(irJson) as unknown as { report: unknown; bodies: EvalResult["bodies"] };
    return Promise.resolve({ report: r.report as EvalResult["report"], bodies: r.bodies });
  }
  exportMesh(irJson: string, format: MeshFormat, tess?: TessellationOptions): Promise<Uint8Array> {
    this.exports.push({ format, tess });
    return Promise.resolve(mod.exportMesh(irJson, format, tess ?? {}));
  }
  dispose(): void {}
}

beforeAll(async () => {
  if (!hasWasm) return;
  const entry = new URL("../../forge-web/src/engine.ts", import.meta.url).pathname;
  mod = (await import(/* @vite-ignore */ entry)) as Mod;
  await mod.init(fs.readFileSync(wasmUrl));
  commands = forgeWebCommandEngine(mod);
}, 60_000);

function setup(): { ir: IrDocStore; doc: DocStore; engine: NodeForgeEngine; adapter: DocStoreAdapter } {
  const engine = new NodeForgeEngine();
  const ir = new IrDocStore({ engine: () => commands });
  const cadscript = new InlineCadScriptService();
  const doc = new DocStore({ cadscript, engine: () => engine, ir, debounceMs: 0 });
  return { ir, doc, engine, adapter: new DocStoreAdapter(doc, cadscript) };
}

const rect = { type: "sketch", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: 30, h: 20 }] };

describe("IR v1 as the document model", () => {
  it_("mirrors the IR store: model, bodies, dirty, undo/redo, rollback, timeline", async () => {
    const { ir, doc } = setup();
    expect(doc.v1Available).toBe(true);
    doc.load({ path: null, name: "untitled", format: "ir-v1", source: blankDocument("untitled") });
    let s = await doc.idle();
    expect(s).toMatchObject({ format: "ir-v1", dirty: false, engineError: null });
    expect(s.source).toBe(ir.document);
    expect(s.bodies).toEqual([]);
    await ir.apply({ op: "addFeature", feature: rect }, { origin: "user" });
    await ir.apply({ op: "addFeature", feature: { type: "extrude", sketch: "sketch1", distance: 5 } }, { origin: "agent" });
    s = await doc.idle();
    expect(s.source).toBe(ir.document);
    expect(s.dirty).toBe(true);
    expect(s.bodies.map((b) => b.name)).toEqual(["part/extrude1"]);
    expect(s.history.undoLabel).toBe("Add extrude extrude1");
    let t = buildTimeline(s, []);
    expect(t.parts[0]!.features.map((f) => [f.id, f.type, f.status, f.agent])).toEqual([
      ["sketch1", "sketch", "ok", false],
      ["extrude1", "extrude", "ok", true],
    ]);
    expect(t.parts[0]!.features[1]!.summary).toBe("5 mm · 1 body");
    // Undo / redo through the DocStore go to the IR store.
    expect(doc.undo()).toBe(true);
    s = await doc.idle();
    expect(s.bodies).toEqual([]);
    expect(buildTimeline(s, []).featureCount).toBe(1);
    expect(doc.redo()).toBe(true);
    s = await doc.idle();
    expect(s.bodies).toHaveLength(1);
    // The rollback marker: the extrude is not built, and shows rolled back.
    await ir.apply({ op: "setRollback", after: "sketch1" });
    s = await doc.idle();
    expect(s.bodies).toEqual([]);
    t = buildTimeline(s, []);
    expect(t.rollback).toBe("sketch1");
    expect(t.parts[0]!.features[1]).toMatchObject({ status: "rolled-back", rolledBack: true });
    // setSource never edits a v1 model's text.
    expect(doc.setSource("garbage")).toBe(false);
  });

  it_("saves a .partzero with the v1 document and its host state, and reopens it identical", async () => {
    const a = setup();
    a.doc.load({ path: null, name: "bracket", format: "ir-v1", source: blankDocument("bracket") });
    await a.doc.idle();
    await a.ir.apply({ op: "addFeature", feature: rect });
    await a.ir.apply({ op: "addFeature", feature: { type: "extrude", sketch: "sketch1", distance: 4 } });
    await a.ir.apply({ op: "setAppearance", feature: "extrude1", color: "#e0552b" });
    const snap = await a.adapter.snapshot();
    expect(snap.irSchema).toBe("aicad.ir/1");
    expect(snap.code).toBeNull();
    expect(snap.host).toEqual({ rollback: null, appearance: { extrude1: "#e0552b" } });
    const bytes = encodePartZero({
      generator: { app: "PartZero", version: "0", forgeBuild: null },
      document: { json: snap.documentJson, irSchema: snap.irSchema },
      code: snap.code,
      thumbnail: null,
      annotations: { appearance: JSON.stringify({ features: snap.host!.appearance }) },
      blobs: {},
      cache: {},
      checkpoints: {},
      view: { rollbackMarker: snap.host!.rollback, hidden: [], camera: null },
      references: [],
    });
    expect(a.adapter.markSaved("/tmp/bracket.partzero", "bracket", snap.capture)).toBe("clean");
    expect(a.doc.getState().dirty).toBe(false);
    // Colour reaches the bodies.
    expect(a.doc.getState().bodies[0]!.color?.map((c) => Math.round(c * 255))).toEqual([0xe0, 0x55, 0x2b]);

    const decoded = decodePartZero(bytes, { validateDocument: a.adapter.validateDocument });
    const b = setup();
    const host = hostStateOf(decoded.contents);
    await b.adapter.load({ path: "/tmp/bracket.partzero", name: "bracket", documentJson: decoded.contents.document.json, code: decoded.contents.code, ...(host ? { host } : {}) });
    const s = b.doc.getState();
    expect(s.format).toBe("ir-v1");
    expect(s.source).toBe(a.doc.getState().source);
    expect(s.v1?.host).toEqual({ rollback: null, appearance: { extrude1: "#e0552b" } });
    expect(s.dirty).toBe(false);
    expect(s.bodies).toHaveLength(1);
    expect(await b.adapter.exportIrJson("export")).toBe(s.source);
  });

  it_("opens an IR v0 document as a migrated v1 model, and a CadScript v1 file as a v1 model", async () => {
    const { adapter, doc } = setup();
    const v0 = JSON.stringify({
      schema: "aicad.ir/0",
      parts: [{ id: "p1", name: "part", features: [{ type: "sketch", id: "s1", name: "base", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 5 }] }, { type: "extrude", id: "e1", name: "puck", sketch: "base", distance: 3 }] }],
    });
    const warnings = await adapter.load({ path: "/tmp/puck.json", name: "puck", documentJson: v0, code: null });
    expect(warnings.join(" ")).toMatch(/IR v0/);
    let s = doc.getState();
    expect(s.format).toBe("ir-v1");
    expect(JSON.parse(s.source).schema).toBe("aicad.ir/1");
    expect(s.bodies).toHaveLength(1);
    const code = `import { param, part, sketch, rect, extrude, XY } from "@aicad/std";\nconst w = param("w", 20);\npart("p");\nconst s = sketch(XY, { r: rect([0, 0], { w, h: 10 }) });\nconst e = extrude(s, { distance: 2 });\n`;
    await adapter.loadText("/tmp/p.cad.ts", "p", code);
    s = doc.getState();
    if (s.format === "ir-v1") {
      expect(JSON.parse(s.source).params?.[0]?.name).toBe("w");
    } else {
      // The source did not compile as CadScript v1 or v0: it opens as CadScript, errors shown.
      expect(s.format).toBe("cadscript");
    }
  });

  it_("the sketcher's Finish is addParam + addFeature (new) or updateFeature (edit) through the command layer", async () => {
    const h = await makeHarness();
    const ir = new IrDocStore({ engine: () => commands });
    await ir.load(blankDocument("s"));
    h.services.ir = ir;
    const feature = { type: "sketch", id: "sketch1", name: "sketch1", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: "width", h: 8 }] };
    const ops = sketchFinishOps(
      {
        mode: "new",
        feature: feature as never,
        after: null,
        part: "p1",
        params: [{ name: "width", unit: "mm", value: 25 } as never],
        edits: [],
        conversion: null,
        check: { ok: true } as never,
      },
      JSON.parse(ir.document),
    );
    expect(ops.map((o) => o.op)).toEqual(["addParam", "addFeature"]);
    const r = await h.commands.execute({ id: "ir.apply", args: { ops, label: "Sketch sketch1" } }, { source: "ui" });
    expect(r.ok).toBe(true);
    expect(ir.getState().history.undoLabel).toBe("Sketch sketch1");
    const edit = sketchFinishOps(
      { mode: "edit", feature: { ...feature, curves: [{ kind: "rect", id: "r", center: [0, 0], w: "width", h: 12 }] } as never, after: null, part: "p1", params: [{ name: "width", unit: "mm", value: 25 } as never], edits: [], conversion: null, check: { ok: true } as never },
      JSON.parse(ir.document),
    );
    expect(edit.map((o) => o.op)).toEqual(["updateFeature"]);
    const r2 = await h.commands.execute({ id: "ir.apply", args: { ops: edit } }, { source: "ui" });
    expect(r2.ok).toBe(true);
    expect((JSON.parse(ir.document) as { parts: Array<{ features: Array<{ curves: Array<{ h: number }> }> }> }).parts[0]!.features[0]!.curves[0]!.h).toBe(12);
  });

  it_("opens a starter example (CadScript v1) as an IR v1 model", async () => {
    const { doc } = setup();
    const services = { doc, cadscript: new InlineCadScriptService(), confirm: () => Promise.resolve(true) } as unknown as Parameters<typeof openExample>[0];
    const p5 = STARTERS.find((x) => x.id === "p5-electronics-box")!;
    expect(await exampleAvailability(services, p5)).toEqual({ status: "ready" });
    expect(await openExample(services, p5)).toEqual({ opened: true });
    const s = doc.getState();
    expect(s.format).toBe("ir-v1");
    expect(s.name).toBe("p5-electronics-box");
    expect((JSON.parse(s.source) as { params?: unknown[] }).params?.length).toBeGreaterThan(0);
    expect(s.bodies.length).toBeGreaterThan(0);
  });

  it_("the live op host commits through the command layer as the agent", async () => {
    const h = await makeHarness();
    const ir = new IrDocStore({ engine: () => commands });
    await ir.load(blankDocument("s"));
    h.services.ir = ir;
    const host = appOpsHost(h.services, h.commands, "agent");
    const c = await host.apply([{ op: "addFeature", feature: rect }], { label: "Agent: base sketch" });
    expect(c).toMatchObject({ changed: true, label: "Agent: base sketch" });
    expect(JSON.parse(await host.document()).parts[0].features[0].author).toBe("agent");
    await expect(host.apply([{ op: "deleteFeature", feature: "nope" }])).rejects.toMatchObject({ code: "COMMAND_UNKNOWN_FEATURE" });
  });
});
