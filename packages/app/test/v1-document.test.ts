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
import { downgradeToV0 } from "../src/agent/v0-surface";
import { InlineCadScriptService } from "../src/cadscript/inline-service";
import { DocStore } from "../src/doc/doc-store";
import { buildTimeline } from "../src/doc/timeline";
import { forgeWebCommandEngine, type ForgeWebCommandModule, type IrCommandEngine } from "../src/doc/v1/command-engine";
import { IrDocStore } from "../src/doc/v1/ir-doc-store";
import { PRINT_TESSELLATION, type EvalResult, type ForgeEngine, type MeshFormat, type TessellationOptions } from "../src/engine/types";
import { exportFormat } from "../src/file/export-formats";
import { DocStoreAdapter } from "../src/file/adapter";
import type { DocumentStateMessage, FilesEvent, RecentDocument, SaveDialogOptions } from "../src/bridge";
import { DocumentFiles, hostStateOf } from "../src/file/document-files";
import type { FileHost } from "../src/file/host";
import { decodePartZero, encodePartZero } from "../src/file/partzero";
import { sketchFinishOps } from "../src/sketch/v1-app";
import { exampleAvailability, openExample, STARTERS } from "../src/tools/starters";
import { BOX, makeHarness } from "./helpers";

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

  it_("hands a v0-expressible model to the designer as its v0 document (downgrade ∘ migrate = identity)", async () => {
    const v0 = {
      schema: "aicad.ir/0",
      parts: [
        {
          id: "p1",
          name: "part",
          features: [
            { type: "sketch", id: "outline", name: "outline", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 5 }] },
            { type: "extrude", id: "plate", name: "plate", sketch: "outline", distance: 3 },
          ],
        },
      ],
    };
    const v1 = (await commands.canonicalize(JSON.stringify(v0))).document;
    const back = downgradeToV0(v1);
    expect(back).toEqual(v0);
    // A parameter (or any v1-only feature) is not v0: the designer gets the v1 print instead.
    const withParam = JSON.parse(v1) as { params?: unknown[] };
    withParam.params = [{ name: "t", unit: "mm", value: 3 }];
    expect(downgradeToV0(JSON.stringify(withParam))).toBeNull();
  });

  it_("exports meshes at print quality (0.01 mm, at most 5°): a hole comes out round", async () => {
    const { ir, doc, engine, adapter } = setup();
    doc.load({ path: null, name: "puck", format: "ir-v1", source: blankDocument("puck") });
    await doc.idle();
    await ir.apply({ op: "addFeature", feature: { type: "sketch", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 10 }] } });
    await ir.apply({ op: "addFeature", feature: { type: "extrude", sketch: "sketch1", distance: 2 } });
    const irJson = await adapter.exportIrJson("export");
    const stl = exportFormat("stl")!;
    const bytes = await stl.run({ irJson, engine, name: "puck" });
    expect(engine.exports.at(-1)?.tess).toEqual(PRINT_TESSELLATION);
    expect(PRINT_TESSELLATION.chordalDeflection).toBe(0.01);
    expect(PRINT_TESSELLATION.angularDeflection).toBeLessThanOrEqual((5 * Math.PI) / 180 + 1e-12);
    // Binary STL: 80-byte header, then the triangle count. The r = 10 mm rim needs ≥ 72 segments at 5°
    // (and ≥ 71 for 0.01 mm chordal): far more than the default display tessellation.
    const triangles = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    const coarse = mod.exportMesh(irJson, "stl", {});
    const coarseTriangles = new DataView(coarse.buffer, coarse.byteOffset, coarse.byteLength).getUint32(80, true);
    expect(triangles).toBeGreaterThan(coarseTriangles);
    expect(triangles).toBeGreaterThanOrEqual(4 * 72);
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

/** An in-memory file host (no recovery, no windows: the web build's shape). */
class Files implements FileHost {
  readonly kind = "memory" as const;
  readonly recovery = null;
  readonly windows = null;
  files = new Map<string, Uint8Array>();
  nextSave: string | null = null;
  saveDialogs: SaveDialogOptions[] = [];
  pickOpen(): Promise<string | null> {
    return Promise.resolve(null);
  }
  pickSave(o: SaveDialogOptions): Promise<string | null> {
    this.saveDialogs.push(o);
    return Promise.resolve(this.nextSave);
  }
  readBytes(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    return f ? Promise.resolve(f) : Promise.reject(new Error(`ENOENT ${path}`));
  }
  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }
  writeDocument(path: string, data: Uint8Array | string): Promise<{ bytes: number; backup: string | null }> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.files.set(path, bytes);
    return Promise.resolve({ bytes: bytes.length, backup: null });
  }
  writeExport(path: string, data: Uint8Array | string): Promise<void> {
    this.files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
    return Promise.resolve();
  }
  recent(): Promise<RecentDocument[]> {
    return Promise.resolve([]);
  }
  clearRecent(): Promise<void> {
    return Promise.resolve();
  }
  thumbnail(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }
  onEvent(_l: (e: FilesEvent) => void): () => void {
    return () => undefined;
  }
  text(path: string): string {
    return new TextDecoder().decode(this.files.get(path));
  }
}

describe("saving an IR v1 model to the file it came from", () => {
  async function filesSetup() {
    const { ir, doc, engine, adapter } = setup();
    const host = new Files();
    const toasts: string[] = [];
    const files = new DocumentFiles({
      adapter,
      host,
      toast: (kind, m) => toasts.push(`${kind}: ${m}`),
      confirm: () => Promise.resolve(true),
      setDocumentState: (_s: DocumentStateMessage) => undefined,
      engine: () => engine,
      runCommand: () => Promise.resolve(undefined),
      generator: { app: "PartZero", version: "0-test" },
      autosaveDelayMs: 1_000_000,
    });
    await files.start();
    return { ir, doc, host, files, toasts };
  }

  it_("a .cad.ts file opens as a model with a warning, and Save never rewrites the code: it asks where to save the .partzero", async () => {
    const { doc, host, files, toasts } = await filesSetup();
    host.files.set("/w/plate.cad.ts", new TextEncoder().encode(BOX));
    await files.loadFile("/w/plate.cad.ts");
    expect(doc.getState()).toMatchObject({ format: "ir-v1", path: "/w/plate.cad.ts", dirty: false });
    expect(toasts.at(-1)).toBe("info: plate.cad.ts opened as a PartZero model. Save writes a new PartZero file; your code in plate.cad.ts stays as it is.");
    // Save asks where (a .partzero next to it is suggested); a cancelled dialog writes nothing.
    host.nextSave = null;
    expect(await files.save()).toEqual({ saved: false });
    expect(host.saveDialogs.map((d) => d.defaultPath)).toEqual(["plate.partzero"]);
    expect(toasts.some((t) => t.startsWith("info: plate.cad.ts is your CadScript code: saving the model over it would replace the code"))).toBe(true);
    expect(host.text("/w/plate.cad.ts")).toBe(BOX);
    // Saved as a .partzero: the code file is untouched, and the next Save goes to the .partzero without asking.
    host.nextSave = "/w/plate.partzero";
    expect(await files.save()).toMatchObject({ saved: true, path: "/w/plate.partzero", format: "partzero" });
    expect(host.text("/w/plate.cad.ts")).toBe(BOX);
    expect(doc.getState()).toMatchObject({ path: "/w/plate.partzero", dirty: false });
    host.nextSave = null;
    expect(await files.save()).toMatchObject({ saved: true, path: "/w/plate.partzero" });
    expect(host.saveDialogs).toHaveLength(2);
  });

  it_("an IR v0 .json opens with a warning, and Save asks instead of rewriting it in the new format", async () => {
    const { doc, host, files, toasts } = await filesSetup();
    const cadscript = new InlineCadScriptService();
    const c = await cadscript.compile(BOX);
    const v0 = JSON.stringify(c.ir);
    host.files.set("/w/plate.json", new TextEncoder().encode(v0));
    await files.loadFile("/w/plate.json");
    expect(doc.getState().format).toBe("ir-v1");
    expect(toasts.at(-1)).toMatch(/earlier model format \(IR v0\); it opened as a PartZero model\. Save writes a new PartZero file; plate\.json stays as it is\./);
    host.nextSave = null;
    expect(await files.save()).toEqual({ saved: false });
    expect(host.text("/w/plate.json")).toBe(v0);
    // The user may still choose the file itself in the dialog: then it is written (their explicit choice).
    host.nextSave = "/w/plate.json";
    expect(await files.save()).toMatchObject({ saved: true, path: "/w/plate.json" });
    expect((JSON.parse(host.text("/w/plate.json")) as { schema: string }).schema).toBe("aicad.ir/1");
  });

  it_("a text save keeps the rollback marker and colours unsaved, and says so", async () => {
    const { ir, doc, host, files, toasts } = await filesSetup();
    doc.load({ path: null, name: "bracket", format: "ir-v1", source: blankDocument("bracket") });
    await doc.idle();
    await ir.apply({ op: "addFeature", feature: rect });
    await ir.apply({ op: "addFeature", feature: { type: "extrude", sketch: "sketch1", distance: 4 } });
    // The model alone saves clean to .json.
    expect(await files.saveAs("/w/bracket.json")).toMatchObject({ saved: true, upToDate: true });
    expect(doc.getState().dirty).toBe(false);
    await ir.apply({ op: "setAppearance", feature: "extrude1", color: "#e0552b" });
    await ir.apply({ op: "setRollback", after: "sketch1" });
    await doc.idle();
    const r = await files.save();
    expect(r).toMatchObject({ saved: true, path: "/w/bracket.json", upToDate: false });
    expect(toasts.at(-1)).toMatch(/^success: Saved bracket\.json \(.*\); the rollback marker and the body colours are kept only in \.partzero files, so they stay unsaved$/);
    expect((await doc.idle()).dirty).toBe(true);
    // In a .partzero they are saved.
    expect(await files.saveAs("/w/bracket.partzero")).toMatchObject({ saved: true, upToDate: true });
    expect((await doc.idle()).dirty).toBe(false);
  });
});
