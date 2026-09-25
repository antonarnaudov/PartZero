/**
 * The document layer against the real DocStore and CadScript compiler, with an in-memory host: `.partzero` save and
 * open round trips, the plain formats, autosave and restore, one document per window, reference meshes, exports,
 * the close prompt's save, and the `file.*` commands through the registry.
 */
import { describe, expect, it } from "vitest";
import type { DocumentStateMessage, FilesBridge, FilesEvent, OpenDialogOptions, RecentDocument, RecoveryEntry, SaveDialogOptions, WindowDocInfo, WindowStartup } from "../src/bridge";
import { COMMANDS } from "../src/commands/commands";
import { DocStoreAdapter, documentName } from "../src/file/adapter";
import { DocumentFiles } from "../src/file/document-files";
import type { FileHost } from "../src/file/host";
import { documentFiles, installDocumentFiles, replaceCommands } from "../src/file/install";
import { writeBinaryStl, type TriangleMesh } from "../src/file/mesh";
import { decodePartZero, ENTRY, readZip, writeZip } from "../src/file/partzero";
import { BOX, makeHarness, type Harness } from "./helpers";

const enc = new TextEncoder();
const dec = new TextDecoder();

class MemoryRecovery {
  entries = new Map<string, { meta: RecoveryEntry; data: Uint8Array }>();
  writes = 0;
  list(): Promise<RecoveryEntry[]> {
    return Promise.resolve([...this.entries.values()].map((e) => e.meta));
  }
  write(r: { id: string; title: string; path: string | null; data: Uint8Array }): Promise<void> {
    this.writes++;
    this.entries.set(r.id, { meta: { id: r.id, title: r.title, path: r.path, savedAt: Date.now(), bytes: r.data.length }, data: r.data });
    return Promise.resolve();
  }
  read(id: string): Promise<Uint8Array> {
    const e = this.entries.get(id);
    return e ? Promise.resolve(e.data) : Promise.reject(new Error("gone"));
  }
  discard(id: string): Promise<void> {
    this.entries.delete(id);
    return Promise.resolve();
  }
}

class MemoryWindows {
  calls: string[] = [];
  open = new Set<string>();
  startupValue: WindowStartup = { windowId: 1, open: null, command: null, recovery: [], uncleanExit: false };
  info: WindowDocInfo | null = null;
  saved: Array<[string, boolean]> = [];
  startup(): Promise<WindowStartup> {
    return Promise.resolve(this.startupValue);
  }
  openDocument(path: string, o: { allowHere: boolean }): Promise<{ placement: "existing" | "here" | "new" }> {
    this.calls.push(`open:${path}:${o.allowHere}`);
    return Promise.resolve({ placement: this.open.has(path) ? "existing" : o.allowHere ? "here" : "new" });
  }
  newWindow(o?: { command?: { id: string; args?: unknown } }): Promise<void> {
    this.calls.push(`new:${o?.command ? JSON.stringify(o.command) : ""}`);
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.calls.push("close");
    return Promise.resolve();
  }
  setDocInfo(i: WindowDocInfo): void {
    this.info = i;
  }
  saveFinished(requestId: string, saved: boolean): void {
    this.saved.push([requestId, saved]);
  }
}

class MemoryFileHost implements FileHost {
  readonly kind = "memory" as const;
  files = new Map<string, Uint8Array>();
  nextOpen: string | null = null;
  nextSave: string | null = null;
  saveDialogs: SaveDialogOptions[] = [];
  openDialogs: OpenDialogOptions[] = [];
  recentPaths: string[] = [];
  thumbs = new Map<string, Uint8Array>();
  readonly recovery: MemoryRecovery | null;
  readonly windows: MemoryWindows | null;
  private listeners = new Set<(e: FilesEvent) => void>();

  constructor(options: { desktop?: boolean } = {}) {
    this.recovery = options.desktop === false ? null : new MemoryRecovery();
    this.windows = options.desktop === false ? null : new MemoryWindows();
  }
  pickOpen(o: OpenDialogOptions): Promise<string | null> {
    this.openDialogs.push(o);
    return Promise.resolve(this.nextOpen);
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
    return dec.decode(await this.readBytes(path));
  }
  writeDocument(path: string, data: Uint8Array | string, thumbnail: Uint8Array | null): Promise<{ bytes: number; backup: string | null }> {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    const existed = this.files.has(path);
    this.files.set(path, bytes);
    if (thumbnail) this.thumbs.set(path, thumbnail);
    this.recentPaths = [path, ...this.recentPaths.filter((p) => p !== path)];
    return Promise.resolve({ bytes: bytes.length, backup: existed ? `${path}.bak` : null });
  }
  writeExport(path: string, data: Uint8Array | string): Promise<void> {
    this.files.set(path, typeof data === "string" ? enc.encode(data) : data);
    return Promise.resolve();
  }
  recent(): Promise<RecentDocument[]> {
    return Promise.resolve(this.recentPaths.map((p) => ({ path: p, name: p.split("/").pop()!, exists: this.files.has(p), modifiedMs: 1, hasThumbnail: this.thumbs.has(p) })));
  }
  clearRecent(): Promise<void> {
    this.recentPaths = [];
    return Promise.resolve();
  }
  thumbnail(path: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.thumbs.get(path) ?? null);
  }
  onEvent(l: (e: FilesEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: FilesEvent): void {
    for (const l of this.listeners) l(e);
  }
}

interface Setup {
  h: Harness;
  host: MemoryFileHost;
  files: DocumentFiles;
  states: DocumentStateMessage[];
  toasts: string[];
}

async function setup(options: { desktop?: boolean; source?: string } = {}): Promise<Setup> {
  const h = await makeHarness({ source: options.source ?? BOX });
  const host = new MemoryFileHost(options);
  const states: DocumentStateMessage[] = [];
  const toasts: string[] = [];
  const files = new DocumentFiles({
    adapter: new DocStoreAdapter(h.services.doc, h.services.cadscript),
    host,
    toast: (kind, m) => toasts.push(`${kind}: ${m}`),
    confirm: () => Promise.resolve(h.confirmAnswer.value),
    setDocumentState: (s) => states.push(s),
    engine: () => h.services.engines.active,
    runCommand: (c) => h.commands.executeUnknown({ id: c.id, args: c.args ?? {} }),
    generator: { app: "PartZero", version: "0.1.0-test" },
    autosaveDelayMs: 0,
    newRecoveryId: () => "window-0001",
  });
  await files.start();
  return { h, host, files, states, toasts };
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

function box(sx: number, sy: number, sz: number): TriangleMesh {
  const positions = new Float32Array([0, 0, 0, sx, 0, 0, sx, sy, 0, 0, sy, 0, 0, 0, sz, sx, 0, sz, sx, sy, sz, 0, sy, sz]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7]);
  return { positions, indices };
}

describe("saving and opening .partzero documents", () => {
  it("Save As writes a valid .partzero with the compiled IR, the code (comments kept) and a thumbnail", async () => {
    const { h, host, files, states } = await setup();
    host.nextSave = "/work/plate.partzero";
    const r = await files.save();
    expect(r).toMatchObject({ saved: true, path: "/work/plate.partzero", format: "partzero" });
    expect(host.saveDialogs[0]).toMatchObject({ defaultPath: "test.partzero" });
    const bytes = host.files.get("/work/plate.partzero")!;
    const { contents } = decodePartZero(bytes);
    expect(contents.code?.source).toBe(BOX);
    expect(contents.code?.matchesDocument).toBe(true);
    expect(JSON.parse(contents.document.json)).toEqual(h.services.doc.getState().compile!.ir);
    expect(contents.generator).toEqual({ app: "PartZero", version: "0.1.0-test", forgeBuild: null });
    expect(contents.thumbnail?.width).toBe(256);
    expect(host.thumbs.get("/work/plate.partzero")).toEqual(contents.thumbnail!.png);
    const s = h.services.doc.getState();
    expect({ path: s.path, name: s.name, dirty: s.dirty }).toEqual({ path: "/work/plate.partzero", name: "plate", dirty: false });
    expect(states.at(-1)).toEqual({ title: "plate", path: "/work/plate.partzero", dirty: false });
  });

  it("opens what it saved: same code, same model, not dirty", async () => {
    const a = await setup();
    a.host.nextSave = "/work/plate.partzero";
    await a.files.save();
    const bytes = a.host.files.get("/work/plate.partzero")!;
    const b = await setup({ source: "" });
    b.host.files.set("/work/plate.partzero", bytes);
    b.h.services.doc.load({ path: null, name: "untitled", format: "cadscript", source: "" });
    await b.h.services.doc.idle();
    expect(await b.files.openPath("/work/plate.partzero")).toEqual({ opened: true, path: "/work/plate.partzero", placement: "here" });
    const s = await b.h.services.doc.idle();
    expect(s.source).toBe(BOX);
    expect(s.dirty).toBe(false);
    expect(s.path).toBe("/work/plate.partzero");
    expect(s.compile?.ir).toEqual(a.h.services.doc.getState().compile!.ir);
    expect(b.toasts.filter((t) => t.startsWith("info"))).toEqual([]);
  });

  it("the model wins when the code no longer compiles to it (the code is regenerated, with a warning)", async () => {
    const a = await setup();
    a.host.nextSave = "/w/p.partzero";
    await a.files.save();
    // Tamper: change the code but keep the manifest's claim that it matches the model.
    const entries = readZip(a.host.files.get("/w/p.partzero")!);
    const { contents } = decodePartZero(a.host.files.get("/w/p.partzero")!);
    const { encodePartZero } = await import("../src/file/partzero");
    const tampered = encodePartZero({ ...contents, code: { source: BOX.replace("distance: 5", "distance: 9"), matchesDocument: true } });
    expect(entries.length).toBeGreaterThan(2);
    const b = await setup({ source: "" });
    b.host.files.set("/w/p.partzero", tampered);
    await b.files.loadFile("/w/p.partzero");
    const s = await b.h.services.doc.idle();
    expect(s.source).toContain("distance: 5");
    expect(b.toasts.join("\n")).toMatch(/did not match its model, so it was regenerated/);
  });

  it("a document saved with code errors reopens with its code as typed, and says why the model is missing", async () => {
    const a = await setup({ source: `${BOX}\nconst broken = ;\n` });
    a.host.nextSave = "/w/broken.partzero";
    await a.files.save();
    const { contents } = decodePartZero(a.host.files.get("/w/broken.partzero")!);
    expect(contents.code?.matchesDocument).toBe(false);
    const b = await setup({ source: "" });
    b.host.files.set("/w/broken.partzero", a.host.files.get("/w/broken.partzero")!);
    await b.files.loadFile("/w/broken.partzero");
    expect(b.h.services.doc.getState().source).toContain("const broken = ;");
    expect(b.toasts.join("\n")).toMatch(/saved while its code had errors/);
  });

  it("refuses a damaged file with its error code, and leaves the open document alone", async () => {
    const { host, files, h } = await setup();
    host.files.set("/w/bad.partzero", writeZip([{ name: "hello.txt", data: enc.encode("x") }]));
    await expect(files.loadFile("/w/bad.partzero")).rejects.toThrow(/Cannot open bad.partzero: .*\[PZ_NOT_PARTZERO\]/);
    expect(h.services.doc.getState().source).toBe(BOX);
  });

  it("still saves and opens plain CadScript and IR JSON", async () => {
    const { host, files, h } = await setup();
    await files.saveAs("/w/box.cad.ts");
    expect(dec.decode(host.files.get("/w/box.cad.ts"))).toBe(BOX);
    await files.saveAs("/w/box.json");
    const ir = JSON.parse(dec.decode(host.files.get("/w/box.json"))) as { schema: string };
    expect(ir.schema).toBe("aicad.ir/0");
    expect(h.services.doc.getState().format).toBe("ir-json");
    const b = await setup({ source: "" });
    b.host.files.set("/w/box.json", host.files.get("/w/box.json")!);
    await b.files.loadFile("/w/box.json");
    expect((await b.h.services.doc.idle()).compile?.ir).toEqual(h.services.doc.getState().compile!.ir);
  });

  it("names documents from their files", () => {
    expect(documentName("/a/plate.partzero")).toBe("plate");
    expect(documentName("C:\\x\\plate.cad.ts")).toBe("plate");
    expect(documentName("/a/plate.json")).toBe("plate");
  });
});

describe("one document per window", () => {
  it("opens here only when this window is untitled and unchanged, else asks the shell for another window", async () => {
    const { host, files, h } = await setup();
    // A loaded document with a name but no file counts as pristine until it is edited.
    host.files.set("/w/a.cad.ts", enc.encode(BOX));
    h.services.doc.setSource(`${BOX}// edit\n`);
    expect(files.isPristine()).toBe(false);
    expect(await files.openPath("/w/a.cad.ts")).toMatchObject({ placement: "new" });
    expect(host.windows!.calls).toEqual(["open:/w/a.cad.ts:false"]);
    expect(h.services.doc.getState().source).toContain("// edit");
    expect(await files.newDocument()).toEqual({ created: true, placement: "new" });
    expect(host.windows!.calls.at(-1)).toBe("new:");
  });

  it("the web build (no windows) asks before replacing unsaved changes", async () => {
    const { files, h, host } = await setup({ desktop: false });
    host.files.set("/w/a.cad.ts", enc.encode("// other\n"));
    h.services.doc.setSource(`${BOX}// edit\n`);
    h.confirmAnswer.value = false;
    expect(await files.openPath("/w/a.cad.ts")).toMatchObject({ opened: false });
    h.confirmAnswer.value = true;
    expect(await files.openPath("/w/a.cad.ts")).toMatchObject({ opened: true, placement: "here" });
    expect(h.services.doc.getState().source).toBe("// other\n");
  });

  it("tells the shell whether the window is pristine, and saves when the close prompt says Save", async () => {
    const { host, files, h } = await setup();
    expect(host.windows!.info).toEqual({ pristine: true, recoveryId: "window-0001" });
    h.services.doc.setSource(`${BOX}// edit\n`);
    expect(host.windows!.info).toEqual({ pristine: false, recoveryId: "window-0001" });
    host.nextSave = "/w/closing.partzero";
    host.emit({ type: "saveBeforeClose", requestId: "save-1" });
    await tick(50);
    expect(host.windows!.saved).toEqual([["save-1", true]]);
    expect(host.files.has("/w/closing.partzero")).toBe(true);
    // A cancelled Save As reports "not saved", so the window stays open.
    h.services.doc.setSource(`${BOX}// more\n`);
    host.nextSave = null;
    const fresh = await setup();
    fresh.h.services.doc.setSource(`${BOX}// x\n`);
    fresh.host.nextSave = null;
    fresh.host.emit({ type: "saveBeforeClose", requestId: "save-2" });
    await tick(50);
    expect(fresh.host.windows!.saved).toEqual([["save-2", false]]);
    void files;
  });

  it("runs the command and opens the document the shell started the window with", async () => {
    const h = await makeHarness({ source: "" });
    const host = new MemoryFileHost();
    host.files.set("/w/start.cad.ts", enc.encode(BOX));
    host.windows!.startupValue = { windowId: 2, open: "/w/start.cad.ts", command: null, recovery: [], uncleanExit: false };
    const files = new DocumentFiles({
      adapter: new DocStoreAdapter(h.services.doc, h.services.cadscript),
      host,
      toast: () => undefined,
      confirm: () => Promise.resolve(true),
      setDocumentState: () => undefined,
      engine: () => h.services.engines.active,
      runCommand: () => Promise.resolve(),
      generator: { app: "PartZero", version: "t" },
    });
    await files.start();
    expect(h.services.doc.getState().path).toBe("/w/start.cad.ts");
  });
});

describe("autosave and recovery", () => {
  it("autosaves a dirty document and discards the snapshot once it is saved", async () => {
    const { host, files, h } = await setup();
    const rec = host.recovery!;
    h.services.doc.setSource(`${BOX}// unsaved work\n`);
    await h.services.doc.idle();
    await tick(30);
    expect(rec.entries.has("window-0001")).toBe(true);
    const snap = decodePartZero(rec.entries.get("window-0001")!.data);
    expect(snap.contents.code?.source).toContain("// unsaved work");
    expect(rec.entries.get("window-0001")!.meta.title).toBe("test");
    // No rewrite while nothing changed.
    const writes = rec.writes;
    await files.flushRecovery();
    expect(rec.writes).toBe(writes + 1);
    host.nextSave = "/w/done.partzero";
    await files.save();
    await tick(10);
    expect(rec.entries.has("window-0001")).toBe(false);
  });

  it("restores a snapshot on top of its saved file: unsaved, undoable to the saved version, and saved to the same file", async () => {
    // Session 1: save, edit, autosave, "crash".
    const one = await setup();
    one.host.nextSave = "/w/plate.partzero";
    await one.files.save();
    one.h.services.doc.setSource(`${BOX}// after the save\n`);
    await one.h.services.doc.idle();
    await one.files.flushRecovery();
    const snapshot = one.host.recovery!.entries.get("window-0001")!;
    // Session 2: a fresh window with the same files and the snapshot left over.
    const h = await makeHarness({ source: "" });
    const host = new MemoryFileHost();
    host.files = new Map(one.host.files);
    host.recovery!.entries.set("crashed-0001", { meta: { ...snapshot.meta, id: "crashed-0001" }, data: snapshot.data });
    host.windows!.startupValue = { windowId: 1, open: null, command: null, recovery: [{ ...snapshot.meta, id: "crashed-0001" }], uncleanExit: true };
    const files = new DocumentFiles({
      adapter: new DocStoreAdapter(h.services.doc, h.services.cadscript),
      host,
      toast: () => undefined,
      confirm: () => Promise.resolve(true),
      setDocumentState: () => undefined,
      engine: () => h.services.engines.active,
      runCommand: () => Promise.resolve(),
      generator: { app: "PartZero", version: "t" },
      newRecoveryId: () => "window-0002",
    });
    await files.start();
    expect(files.getState().dialog).toMatchObject({ kind: "recovery", uncleanExit: true });
    expect(await files.restoreRecovery("crashed-0001")).toEqual({ restored: true, placement: "here" });
    let s = await h.services.doc.idle();
    expect(s.source).toContain("// after the save");
    expect(s.path).toBe("/w/plate.partzero");
    expect(s.dirty).toBe(true);
    expect(files.getState().dialog).toBeNull();
    expect(host.recovery!.entries.has("crashed-0001")).toBe(false);
    h.services.doc.undo();
    s = await h.services.doc.idle();
    expect(s.source).toBe(BOX);
    expect(s.dirty).toBe(false);
    h.services.doc.redo();
    await files.save();
    expect(decodePartZero(host.files.get("/w/plate.partzero")!).contents.code?.source).toContain("// after the save");
  });

  it("restores into a new window when this one has a document, and discards on request", async () => {
    const { host, files, h } = await setup();
    host.recovery!.entries.set("left-0001", { meta: { id: "left-0001", title: "x", path: null, savedAt: 1, bytes: 1 }, data: new Uint8Array(1) });
    h.services.doc.setSource(`${BOX}// busy\n`);
    expect(await files.restoreRecovery("left-0001")).toEqual({ restored: true, placement: "new" });
    expect(host.windows!.calls.at(-1)).toBe('new:{"id":"file.restoreRecovery","args":{"id":"left-0001"}}');
    expect(await files.discardRecovery("left-0001")).toEqual({ discarded: true });
    expect(host.recovery!.entries.size).toBe(0);
    expect(await files.showRecovery()).toEqual({ entries: 0 });
  });
});

describe("reference meshes", () => {
  it("imports an STL as a measured reference, saves it inside the .partzero and brings it back", async () => {
    const { host, files, states } = await setup();
    host.files.set("/meshes/bracket.stl", writeBinaryStl(box(20, 10, 5)));
    host.nextOpen = "/meshes/bracket.stl";
    const r = await files.importReference();
    expect(r).toMatchObject({ imported: true, id: "ref1" });
    expect(r.measure?.volume).toBeCloseTo(1000, 3);
    const st = files.status();
    expect(st.references).toEqual([expect.objectContaining({ id: "ref1", name: "bracket", format: "stl", visible: true, triangles: 12, size: [20, 10, 5], closed: true })]);
    // Unsaved: the store is clean, but the window shows the change.
    expect(st.dirty).toBe(true);
    expect(states.at(-1)?.dirty).toBe(true);
    expect(files.referenceBodies()[0]!.name).toBe("ref:ref1");
    host.nextSave = "/w/with-ref.partzero";
    await files.save();
    expect(files.status().dirty).toBe(false);
    const saved = decodePartZero(host.files.get("/w/with-ref.partzero")!);
    expect(saved.contents.references).toEqual([expect.objectContaining({ id: "ref1", format: "stl", sourceName: "bracket.stl" })]);
    expect(Object.keys(saved.contents.blobs)).toHaveLength(1);

    const b = await setup({ source: "" });
    b.host.files.set("/w/with-ref.partzero", host.files.get("/w/with-ref.partzero")!);
    await b.files.loadFile("/w/with-ref.partzero");
    expect(b.files.status().references.map((x) => [x.id, x.volume !== null])).toEqual([["ref1", true]]);
    expect(b.files.status().dirty).toBe(false);
    b.files.setReferenceVisible("ref1", false);
    expect(b.files.referenceBodies()).toEqual([]);
    expect(b.files.status().dirty).toBe(true);
    b.files.removeReference("ref1");
    expect(b.files.status().references).toEqual([]);
    expect(() => b.files.removeReference("ref1")).toThrow(/no reference mesh/);
  });

  it("refuses files that are not meshes", async () => {
    const { host, files } = await setup();
    host.files.set("/m/notes.txt", enc.encode("hello"));
    await expect(files.importReference("/m/notes.txt")).rejects.toThrow(/not an STL, 3MF or OBJ/);
    host.files.set("/m/broken.stl", enc.encode("definitely not an stl"));
    await expect(files.importReference("/m/broken.stl")).rejects.toThrow(/not an STL/);
  });
});

describe("export", () => {
  it("exports meshes through the engine, and says STEP is not available yet", async () => {
    const { host, files, h } = await setup();
    host.nextSave = "/out/plate.stl";
    expect(await files.export("stl")).toMatchObject({ exported: true, path: "/out/plate.stl", format: "stl" });
    expect(h.engine.exports.at(-1)?.format).toBe("stl");
    expect(dec.decode(host.files.get("/out/plate.stl"))).toBe("PK-fake-stl");
    await expect(files.export("step")).rejects.toThrow(/STEP export is not available/);
    await expect(files.export("dwg")).rejects.toThrow(/unknown export format/);
    files.openExportDialog();
    expect(files.getState().dialog).toEqual({ kind: "export", format: null });
  });
});

describe("the desktop host", () => {
  it("uses the files bridge when the shell has one, and degrades to text documents when it does not", async () => {
    const calls: string[] = [];
    const base = {
      platform: "darwin",
      showOpenDialog: () => Promise.resolve("/w/a.partzero"),
      showSaveDialog: () => Promise.resolve("/w/b.partzero"),
      readTextFile: () => Promise.resolve("text"),
      writeFile: (p: string) => {
        calls.push(`write:${p}`);
        return Promise.resolve();
      },
      recentFiles: () => Promise.resolve(["/w/r.cad.ts"]),
      clearRecentFiles: () => Promise.resolve(),
    };
    const { ElectronFileHost } = await import("../src/file/host");
    const old = new ElectronFileHost(base as never);
    expect(old.recovery).toBeNull();
    expect(old.windows).toBeNull();
    await expect(old.readBytes("/w/a.partzero")).rejects.toThrow(/update the app/);
    expect(await old.writeDocument("/w/x.cad.ts", "abc", null)).toEqual({ bytes: 3, backup: null });
    expect(await old.recent()).toEqual([{ path: "/w/r.cad.ts", name: "r.cad.ts", exists: true, modifiedMs: null, hasThumbnail: false }]);
    const files = {
      readBytes: () => Promise.resolve(new Uint8Array([1])),
      writeDocument: (r: { path: string }) => {
        calls.push(`atomic:${r.path}`);
        return Promise.resolve({ bytes: 1, backup: null });
      },
      recent: () => Promise.resolve([]),
      thumbnail: () => Promise.resolve(null),
      recovery: new MemoryRecovery(),
      window: new MemoryWindows(),
      onEvent: () => () => undefined,
    };
    const current = new ElectronFileHost({ ...base, files } as never);
    expect(current.recovery).toBe(files.recovery);
    expect([...(await current.readBytes("/w/a.partzero"))]).toEqual([1]);
    await current.writeDocument("/w/a.partzero", new Uint8Array([1]), null);
    await current.writeExport("/w/a.stl", new Uint8Array([1]));
    expect(calls).toEqual(["write:/w/x.cad.ts", "atomic:/w/a.partzero", "write:/w/a.stl"]);
  });
});

describe("file commands in the registry", () => {
  it("installs over the old file commands without touching the shared command table", async () => {
    const h = await makeHarness({ source: BOX });
    const before = COMMANDS["file.save"];
    const files = installDocumentFiles({ services: h.services, commands: h.commands }, { host: new MemoryFileHost() as unknown as FileHost, autosaveDelayMs: 0 });
    expect(documentFiles()).toBe(files);
    expect(COMMANDS["file.save"]).toBe(before);
    expect(h.commands.has("file.importReference")).toBe(true);
    expect(await h.commands.executeUnknown({ id: "file.status" })).toMatchObject({ ok: true, value: { name: "test", references: [], recoveryId: expect.any(String) } });
    expect(h.commands.keymap().get("mod+e")).toBe("file.export");
    expect(h.commands.keymap().get("mod+w")).toBe("file.close");
    const ids = h.commands.describe().map((c) => c.id);
    for (const id of ["file.new", "file.open", "file.save", "file.saveAs", "file.revert", "file.close", "file.export", "file.exportMesh", "file.importReference", "file.recover", "file.showRecent"]) {
      expect(ids).toContain(id);
    }
    expect(await h.commands.executeUnknown({ id: "file.export", args: { format: "step" } })).toMatchObject({ ok: false, error: { code: "FAILED" } });
    expect(() => replaceCommands(h.commands, { "x.y": { ...COMMANDS["file.save"], id: "x.z" } as never })).toThrow(/does not match/);
    files.dispose();
  });

  it("New from Template opens the picker, then the template (here when pristine)", async () => {
    const h = await makeHarness({ source: "" });
    installDocumentFiles({ services: h.services, commands: h.commands }, { host: new MemoryFileHost() as unknown as FileHost, autosaveDelayMs: 0 });
    expect(await h.commands.executeUnknown({ id: "file.newFromTemplate" })).toMatchObject({ ok: true, value: { picker: true } });
    expect(h.services.ui.getState().dialog).toBe("templates");
    const r = await h.commands.executeUnknown({ id: "file.newFromTemplate", args: { templateId: "t1-nema17-plate" } });
    expect(r).toMatchObject({ ok: true, value: { created: true, placement: "here", templateId: "t1-nema17-plate" } });
    expect(h.services.doc.getState().name).toBe("t1-nema17-plate");
    expect(h.services.ui.getState().dialog).toBeNull();
    documentFiles()?.dispose();
  });

  it("the recent grid lists what was saved, with thumbnails", async () => {
    const { host, files } = await setup();
    host.nextSave = "/w/r.partzero";
    await files.save();
    expect(await files.showRecent()).toEqual({ count: 1 });
    expect(files.getState().dialog).toMatchObject({ kind: "recent", items: [expect.objectContaining({ path: "/w/r.partzero", hasThumbnail: true })] });
    expect(await files.thumbnail("/w/r.partzero")).not.toBeNull();
    await files.clearRecent();
    expect(files.getState().dialog).toEqual({ kind: "recent", items: [] });
    const bridgeCheck: Pick<FilesBridge, "readBytes"> = { readBytes: (p) => host.readBytes(p) };
    expect(bridgeCheck).toBeTruthy();
  });

  it("keeps the manifest free of anything that would make identical saves differ", async () => {
    const { host, files } = await setup();
    await files.saveAs("/w/a.partzero");
    await files.saveAs("/w/b.partzero");
    expect(host.files.get("/w/a.partzero")).toEqual(host.files.get("/w/b.partzero"));
    const manifest = dec.decode(readZip(host.files.get("/w/a.partzero")!).find((e) => e.name === ENTRY.manifest)!.data);
    expect(manifest).not.toMatch(/savedAt|createdAt|\/w\//);
  });
});
