/**
 * Documents and files in the main process: atomic saves with a `.bak` (and the C7 fault points), capped reads,
 * documents on the command line, the thumbnail cache, the recovery store, the window manager's policy (placement,
 * the Save / Don't Save / Cancel prompt, quitting, windowless menu commands), the menu, and the file IPC.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStateMessage } from "@aicad/app/bridge";
import { backupPath, canonicalPath, documentPathsFromArgv, isDocumentPath, PathGrants, readFileCapped, RecentFiles, ThumbnailCache, writeFileAtomic } from "../src/files.js";
import { buildMenuTemplate } from "../src/menu.js";
import { RecoveryStore } from "../src/recovery.js";
import { cascadeBounds, DocumentWindows, type CloseAnswer, type WindowLike } from "../src/windows.js";
import { tempDirs } from "./temp-dirs.js";

const tmp = tempDirs("aicad-docs-test-");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("atomic document saves", () => {
  it("replaces the file, keeps the previous version as .bak, and keeps the file mode", async () => {
    const dir = tmp();
    const file = join(dir, "plate.partzero");
    expect(await writeFileAtomic(file, "v1", { backup: true })).toEqual({ bytes: 2, backup: null });
    if (process.platform !== "win32") chmodSync(file, 0o600);
    const r = await writeFileAtomic(file, new Uint8Array([1, 2, 3]), { backup: true });
    expect(r).toEqual({ bytes: 3, backup: backupPath(file) });
    expect([...readFileSync(file)]).toEqual([1, 2, 3]);
    expect(readFileSync(backupPath(file), "utf8")).toBe("v1");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    // No temp files are left behind.
    expect(readdirSync(dir).sort()).toEqual(["plate.partzero", "plate.partzero.bak"]);
  });

  it("an interrupted save leaves the old file intact and no temp file (C7 fault points)", async () => {
    const dir = tmp();
    const file = join(dir, "part.partzero");
    writeFileSync(file, "the good version");
    for (const point of ["save:afterTempWrite", "save:beforeRename"] as const) {
      const fault = (p: string): void => {
        if (p === point) throw new Error(`crash at ${p}`);
      };
      await expect(writeFileAtomic(file, "a torn version", { backup: true, fault })).rejects.toThrow(`crash at ${point}`);
      expect(readFileSync(file, "utf8")).toBe("the good version");
      expect(readdirSync(dir).filter((n) => n.endsWith(".tmp") || n.includes(".tmp."))).toEqual([]);
    }
  });

  it("writes through a symlink's target, leaving the link in place", async () => {
    if (process.platform === "win32") return;
    const dir = tmp();
    const real = join(dir, "real.partzero");
    const link = join(dir, "link.partzero");
    writeFileSync(real, "old");
    symlinkSync(real, link);
    await writeFileAtomic(canonicalPath(link), "new");
    expect(readFileSync(real, "utf8")).toBe("new");
    expect(readFileSync(link, "utf8")).toBe("new");
  });

  it("reads with a size cap checked before reading", async () => {
    const dir = tmp();
    const file = join(dir, "big.stl");
    writeFileSync(file, new Uint8Array(2048));
    expect((await readFileCapped(file)).length).toBe(2048);
    await expect(readFileCapped(file, 1000)).rejects.toThrow(/too large/);
    await expect(readFileCapped(dir)).rejects.toThrow(/not a file/);
  });

  it("recognises documents, and documents named on the command line", () => {
    expect(isDocumentPath("/x/plate.partzero")).toBe(true);
    expect(isDocumentPath("/x/plate.PARTZERO")).toBe(true);
    expect(isDocumentPath("/x/plate.stl")).toBe(false);
    const dir = tmp();
    const doc = join(dir, "a.partzero");
    writeFileSync(doc, "x");
    mkdirSync(join(dir, "folder.partzero"));
    expect(documentPathsFromArgv(["--inspect=0", ".", "a.partzero", doc, "missing.partzero", "folder.partzero", "notes.txt"], dir)).toEqual([doc]);
  });

  it("keeps PNG thumbnails per document path, and nothing else", async () => {
    const dir = tmp();
    const cache = new ThumbnailCache(join(dir, "Thumbnails"));
    const doc = join(dir, "a.partzero");
    await cache.put(doc, PNG);
    expect(cache.has(doc)).toBe(true);
    expect(await cache.get(doc)).toEqual(PNG);
    expect(await cache.get(join(dir, "other.partzero"))).toBeNull();
    await expect(cache.put(doc, new Uint8Array([1, 2, 3]))).rejects.toThrow(/invalid thumbnail/);
  });
});

describe("recovery store", () => {
  it("detects an unclean exit and lists what it left, newest first", async () => {
    const dir = join(tmp(), "Recovery");
    let t = 1000;
    const a = new RecoveryStore(dir, () => t);
    expect(a.beginSession()).toEqual({ uncleanExit: false, entries: [] });
    await a.write({ id: "aaaaaaaa-1", title: "plate", path: "/w/plate.partzero", data: new Uint8Array([1]) });
    t = 2000;
    await a.write({ id: "bbbbbbbb-2", title: "untitled", path: null, data: new Uint8Array([2, 2]) });
    // A crash: no endSession. The next launch sees the marker and both snapshots.
    const b = new RecoveryStore(dir, () => 3000);
    const s = b.beginSession();
    expect(s.uncleanExit).toBe(true);
    expect(s.entries.map((e) => [e.id, e.title, e.path, e.bytes])).toEqual([
      ["bbbbbbbb-2", "untitled", null, 2],
      ["aaaaaaaa-1", "plate", "/w/plate.partzero", 1],
    ]);
    expect([...(await b.read("aaaaaaaa-1"))]).toEqual([1]);
    await b.discard("aaaaaaaa-1");
    expect(b.list().map((e) => e.id)).toEqual(["bbbbbbbb-2"]);
    b.endSession();
    expect(new RecoveryStore(dir).beginSession().uncleanExit).toBe(false);
  });

  it("refuses bad ids and skips incomplete or damaged pairs", async () => {
    const dir = join(tmp(), "Recovery");
    const store = new RecoveryStore(dir);
    await expect(store.write({ id: "../../etc", title: "x", path: null, data: new Uint8Array(1) })).rejects.toThrow(/invalid recovery id/);
    await expect(store.read("../x")).rejects.toThrow(/invalid/);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cccccccc.json"), JSON.stringify({ id: "cccccccc", title: "no snapshot", savedAt: 1 }));
    writeFileSync(join(dir, "dddddddd.json"), "{broken");
    writeFileSync(join(dir, "dddddddd.partzero"), "x");
    expect(store.list()).toEqual([]);
  });
});

// ─── The window manager ──────────────────────────────────────────────────────────────────────

class FakeWindow implements WindowLike {
  static next = 1;
  readonly id = FakeWindow.next++;
  readonly sent: Array<[string, unknown]> = [];
  readonly webContents = { id: this.id + 1000, send: (channel: string, ...args: unknown[]) => void this.sent.push([channel, args[0]]), isDestroyed: () => this.destroyed };
  destroyed = false;
  title = "";
  focusCount = 0;
  closeRequests = 0;
  constructor(readonly bounds: { x: number; y: number; width: number; height: number } | null) {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMinimized(): boolean {
    return false;
  }
  isVisible(): boolean {
    return true;
  }
  restore(): void {}
  focus(): void {
    this.focusCount++;
  }
  close(): void {
    this.closeRequests++;
    manager.lastClose?.(this);
  }
  setTitle(t: string): void {
    this.title = t;
  }
  getNormalBounds(): { x: number; y: number; width: number; height: number } {
    return this.bounds ?? { x: 100, y: 100, width: 1200, height: 800 };
  }
}

const manager: { lastClose?: (w: FakeWindow) => void } = {};

function setup(options: { answer?: CloseAnswer; skip?: boolean } = {}) {
  const created: FakeWindow[] = [];
  const discarded: string[] = [];
  const quits: number[] = [];
  const answers: string[] = [];
  const windows = new DocumentWindows<FakeWindow>({
    create: ({ bounds }) => {
      const w = new FakeWindow(bounds);
      created.push(w);
      return w;
    },
    productName: "PartZero",
    platform: "darwin",
    askToSave: (_w, title) => {
      answers.push(title);
      return Promise.resolve(options.answer ?? "cancel");
    },
    skipClosePrompt: options.skip ?? false,
    discardRecovery: (id) => {
      discarded.push(id);
      return Promise.resolve();
    },
    canonicalPath: (p) => p.toLowerCase(),
    requestQuit: () => quits.push(1),
  });
  // A close that the manager allows really closes the fake window (as Electron would).
  manager.lastClose = (w) => {
    if (windows.onClose(w)) {
      w.destroyed = true;
      windows.closed(w);
    }
  };
  const state = (w: FakeWindow, s: Partial<DocumentStateMessage>, pristine = false, recoveryId = `rec-${w.id}-xxxx`): void => {
    windows.setDocState(w.webContents.id, { title: "untitled", path: null, dirty: false, ...s });
    windows.setDocInfo(w.webContents.id, { pristine, recoveryId });
  };
  return { windows, created, discarded, quits, answers, state };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("document windows", () => {
  beforeEach(() => {
    FakeWindow.next = 1;
  });

  it("hands each window its startup once", () => {
    const { windows } = setup();
    const w = windows.open({ open: "/w/a.partzero" }) as FakeWindow;
    expect(windows.takeStartup(w.webContents.id)).toMatchObject({ windowId: w.id, open: "/w/a.partzero", command: null, recovery: [] });
    expect(windows.takeStartup(w.webContents.id)).toMatchObject({ open: null });
    expect(() => windows.takeStartup(9999)).toThrow(/unknown window/);
  });

  it("opens a document in the window that has it, here when allowed, else in a new window", () => {
    const { windows, created, state } = setup();
    const a = windows.open() as FakeWindow;
    state(a, { title: "plate", path: "/W/Plate.partzero" });
    expect(windows.openDocument(a.webContents.id, "/w/plate.partzero", true)).toBe("existing");
    expect(a.focusCount).toBe(1);
    expect(windows.openDocument(a.webContents.id, "/w/other.partzero", true)).toBe("here");
    expect(created).toHaveLength(1);
    expect(windows.openDocument(a.webContents.id, "/w/other.partzero", false)).toBe("new");
    expect(created).toHaveLength(2);
    expect(windows.takeStartup(created[1]!.webContents.id).open).toBe("/w/other.partzero");
    // New windows cascade from the current one.
    expect(created[1]!.bounds).toEqual({ x: 126, y: 126, width: 1200, height: 800 });
  });

  it("sends a Finder double-click to a pristine window, else a new one", () => {
    const { windows, created, state } = setup();
    const a = windows.open() as FakeWindow;
    windows.takeStartup(a.webContents.id);
    state(a, {}, true);
    windows.openFromOs("/w/x.partzero");
    expect(a.sent).toEqual([["files:event", { type: "open", path: "/w/x.partzero" }]]);
    state(a, { title: "x", path: "/w/x.partzero" }, false);
    windows.openFromOs("/w/y.partzero");
    expect(created).toHaveLength(2);
  });

  it("routes menu commands to the current window, and opens a window for them when there is none", () => {
    const { windows, created } = setup();
    windows.sendCommand({ id: "file.open" });
    expect(created).toHaveLength(1);
    expect(windows.takeStartup(created[0]!.webContents.id).command).toEqual({ id: "file.open" });
    windows.sendCommand({ id: "view.fit" });
    expect(created[0]!.sent).toEqual([["menu:command", { id: "view.fit" }]]);
    created[0]!.destroyed = true;
    windows.closed(created[0]!);
    windows.sendCommand({ id: "view.fit" }); // needs a window: dropped
    expect(created).toHaveLength(1);
    windows.sendCommand({ id: "file.new" });
    expect(created).toHaveLength(2);
    expect(windows.takeStartup(created[1]!.webContents.id).command).toBeNull();
  });

  it("closes a clean window at once and discards its autosave", () => {
    const { windows, discarded, answers, state } = setup();
    const a = windows.open() as FakeWindow;
    state(a, { title: "plate", dirty: false });
    a.close();
    expect(a.destroyed).toBe(true);
    expect(answers).toEqual([]);
    expect(discarded).toEqual([`rec-${a.id}-xxxx`]);
  });

  it("Cancel keeps a dirty window open (and its autosave); Don't Save closes it and discards the autosave", async () => {
    const cancel = setup({ answer: "cancel" });
    const a = cancel.windows.open() as FakeWindow;
    cancel.state(a, { title: "plate", dirty: true });
    a.close();
    await flush();
    expect(cancel.answers).toEqual(["plate"]);
    expect(a.destroyed).toBe(false);
    expect(cancel.discarded).toEqual([]);

    const discard = setup({ answer: "discard" });
    const b = discard.windows.open() as FakeWindow;
    discard.state(b, { title: "plate", dirty: true });
    b.close();
    await flush();
    await flush();
    expect(b.destroyed).toBe(true);
    expect(discard.discarded).toEqual([`rec-${b.id}-xxxx`]);
  });

  it("Save asks the window to save and closes it only when the save succeeded", async () => {
    const { windows, state } = setup({ answer: "save" });
    const a = windows.open() as FakeWindow;
    state(a, { title: "plate", dirty: true });
    a.close();
    await flush();
    const [, event] = a.sent.find(([c]) => c === "files:event")!;
    const requestId = (event as { requestId: string }).requestId;
    expect(event).toEqual({ type: "saveBeforeClose", requestId });
    windows.saveFinished(a.webContents.id, requestId, false); // e.g. the Save As dialog was cancelled
    await flush();
    expect(a.destroyed).toBe(false);
    a.sent.length = 0;
    a.close();
    await flush();
    const second = (a.sent.find(([c]) => c === "files:event")![1] as { requestId: string }).requestId;
    state(a, { title: "plate", dirty: false });
    windows.saveFinished(a.webContents.id, second, true);
    await flush();
    await flush();
    expect(a.destroyed).toBe(true);
  });

  it("a quit continues after each answered prompt and stops at Cancel", async () => {
    const { windows, quits, state } = setup({ answer: "discard" });
    const a = windows.open() as FakeWindow;
    state(a, { title: "a", dirty: true });
    windows.quitting = true;
    a.close();
    await flush();
    await flush();
    expect(a.destroyed).toBe(true);
    expect(quits).toEqual([1]);

    const c = setup({ answer: "cancel" });
    const b = c.windows.open() as FakeWindow;
    c.state(b, { title: "b", dirty: true });
    c.windows.quitting = true;
    b.close();
    await flush();
    expect(c.windows.quitting).toBe(false);
    expect(c.quits).toEqual([]);
  });

  it("skips the prompt when told to (tests), and knows the live recovery ids", () => {
    const { windows, answers, state } = setup({ skip: true });
    const a = windows.open() as FakeWindow;
    state(a, { title: "a", dirty: true }, false, "live-0001");
    expect([...windows.liveRecoveryIds()]).toEqual(["live-0001"]);
    a.close();
    expect(a.destroyed).toBe(true);
    expect(answers).toEqual([]);
    expect(windows.count()).toBe(0);
  });

  it("titles the window with the document and a dirty marker", () => {
    const { windows, state } = setup();
    const a = windows.open() as FakeWindow;
    state(a, { title: "plate", dirty: true });
    expect(a.title).toBe("plate • — PartZero");
  });

  it("cascades within the work area", () => {
    expect(cascadeBounds({ x: 10, y: 10, width: 100, height: 100 }, { x: 0, y: 0, width: 1000, height: 1000 })).toEqual({ x: 36, y: 36, width: 100, height: 100 });
    expect(cascadeBounds({ x: 890, y: 10, width: 100, height: 100 }, { x: 0, y: 0, width: 1000, height: 1000 })).toEqual({ x: 26, y: 26, width: 100, height: 100 });
  });
});

describe("native menu (documents)", () => {
  it("has the document commands, and Open Recent lists .partzero files", () => {
    const sent: unknown[] = [];
    const template = buildMenuTemplate({ send: (m) => sent.push(m), recentFiles: ["/w/plate.partzero"], platform: "darwin", appName: "PartZero", isDev: false });
    const items: Array<Record<string, unknown>> = [];
    const walk = (list: unknown): void => {
      if (!Array.isArray(list)) return;
      for (const it of list as Array<Record<string, unknown>>) {
        items.push(it);
        walk(it["submenu"]);
      }
    };
    walk(template);
    for (const id of ["file.new", "file.open", "file.close", "file.save", "file.saveAs", "file.revert", "file.recover", "file.importReference", "file.export", "file.showRecent", "file.clearRecent", "edit.undo", "edit.redo"]) {
      expect(items.some((i) => i["id"] === id), id).toBe(true);
    }
    expect(items.find((i) => i["id"] === "file.export")!["accelerator"]).toBe("CmdOrCtrl+E");
    expect(items.find((i) => i["id"] === "file.close")!["accelerator"]).toBe("CmdOrCtrl+W");
    (items.find((i) => i["label"] === "plate.partzero")!["click"] as () => void)();
    expect(sent).toEqual([{ id: "file.openRecent", args: { path: "/w/plate.partzero" } }]);
    // File, Edit, Agent, View, Window and Help (plus the app menu on macOS).
    expect(template.map((m) => m.label ?? m.role)).toEqual(["PartZero", "&File", "&Edit", "&Agent", "&View", "window", "help"]);
  });
});

describe("file association (packaged apps)", () => {
  interface Assoc {
    fileAssociations: Array<{ ext: string; name: string; role: string; mimeType: string }>;
    mac: { extendInfo: { UTExportedTypeDeclarations: Array<{ UTTypeIdentifier: string; UTTypeConformsTo: string[]; UTTypeTagSpecification: Record<string, string[]> }> } };
    appId: string;
    productName: string;
  }
  const require = createRequire(import.meta.url);
  const root = fileURLToPath(new URL("..", import.meta.url));
  it("both builder configs register .partzero as the app's own document type", () => {
    for (const name of ["electron-builder.config.cjs", "electron-builder.alpha-local.cjs"]) {
      const c = require(join(root, name)) as Assoc;
      expect(c.fileAssociations).toEqual([expect.objectContaining({ ext: "partzero", role: "Editor", mimeType: "application/vnd.partzero+zip", name: `${c.productName} Document` })]);
      const [uti] = c.mac.extendInfo.UTExportedTypeDeclarations;
      expect(uti!.UTTypeIdentifier).toBe(`${c.appId}.document`);
      expect(uti!.UTTypeTagSpecification["public.filename-extension"]).toEqual(["partzero"]);
      // Not a zip archive as far as the Finder is concerned: double-click opens the app, not Archive Utility.
      expect(uti!.UTTypeConformsTo).not.toContain("public.zip-archive");
    }
  });
});

// ─── The file IPC ────────────────────────────────────────────────────────────────────────────

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(), listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => ipc.handlers.set(channel, fn),
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => ipc.listeners.set(channel, fn),
  },
}));
const { registerFileIpc } = await import("../src/ipc/files.js");

describe("file IPC", () => {
  const fromApp = { senderFrame: { url: "app://aicad/index.html" }, sender: { id: 7 } };
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => ipc.handlers.get(channel)!(fromApp, ...args);

  function start() {
    ipc.handlers.clear();
    ipc.listeners.clear();
    const dir = tmp();
    const grants = new PathGrants();
    const recent = new RecentFiles(join(dir, "recent.json"));
    const recovery = new RecoveryStore(join(dir, "Recovery"));
    const thumbnails = new ThumbnailCache(join(dir, "Thumbnails"));
    const calls: string[] = [];
    registerFileIpc({
      isTrustedSender: (url) => url === "app://aicad/index.html",
      grants,
      recent,
      thumbnails,
      recovery,
      onRecentChanged: () => calls.push("recent"),
      windows: {
        takeStartup: (id) => ({ windowId: id, open: null, command: null, recovery: [], uncleanExit: false }),
        openDocument: (_id, _path, allowHere) => (allowHere ? "here" : "new"),
        newWindow: (c) => void calls.push(`new:${c?.id ?? ""}`),
        close: (id) => void calls.push(`close:${id}`),
        setDocInfo: (id, info) => void calls.push(`info:${id}:${info.pristine}:${info.recoveryId}`),
        saveFinished: (id, r, s) => void calls.push(`saved:${id}:${r}:${s}`),
        liveRecoveryIds: () => new Set(["live-0001"]),
      },
    });
    return { dir, grants, recent, recovery, thumbnails, calls };
  }

  it("writes documents atomically only where granted, records them as recent, and keeps their thumbnail", async () => {
    const { dir, grants, recent, thumbnails, calls } = start();
    const doc = join(dir, "plate.partzero");
    await expect(invoke("files:writeDocument", { path: doc, data: new Uint8Array([1]) })).rejects.toThrow(/access denied/);
    grants.grantSaveTarget(doc);
    await invoke("files:writeDocument", { path: doc, data: new Uint8Array([1]), thumbnail: PNG });
    const r = (await invoke("files:writeDocument", { path: doc, data: new Uint8Array([2]) })) as { backup: string };
    expect(r.backup).toBe(backupPath(canonicalPath(doc)));
    expect([...readFileSync(doc)]).toEqual([2]);
    expect(recent.list()).toEqual([doc]);
    expect(calls).toContain("recent");
    expect(thumbnails.has(doc)).toBe(true);
    const listed = (await invoke("files:recent")) as Array<{ path: string; hasThumbnail: boolean; exists: boolean }>;
    expect(listed).toEqual([expect.objectContaining({ path: doc, exists: true, hasThumbnail: true })]);
    expect(await invoke("files:thumbnail", doc)).toEqual(PNG);
    expect(await invoke("files:thumbnail", join(dir, "not-recent.partzero"))).toBeNull();
    // Exports do not go through this channel.
    const stl = join(dir, "part.stl");
    grants.grantSaveTarget(stl);
    await expect(invoke("files:writeDocument", { path: stl, data: new Uint8Array([1]) })).rejects.toThrow(/only documents/);
  });

  it("reads bytes only where granted", async () => {
    const { dir, grants } = start();
    const mesh = join(dir, "bracket.stl");
    writeFileSync(mesh, new Uint8Array([9, 9]));
    await expect(invoke("files:readBytes", mesh)).rejects.toThrow(/access denied/);
    grants.grantOpened(mesh);
    expect([...((await invoke("files:readBytes", mesh)) as Uint8Array)]).toEqual([9, 9]);
  });

  it("records a snapshot's path only while it is writable, and grants it again on restore", async () => {
    const { dir, grants, recovery } = start();
    const doc = join(dir, "plate.partzero");
    await invoke("recovery:write", { id: "aaaaaaaa-1", title: "plate", path: doc, data: new Uint8Array([1]) });
    expect(recovery.get("aaaaaaaa-1")!.path).toBeNull();
    grants.grantSaveTarget(doc);
    await invoke("recovery:write", { id: "bbbbbbbb-1", title: "plate", path: doc, data: new Uint8Array([2]) });
    expect(recovery.get("bbbbbbbb-1")!.path).toBe(doc);
    // A new session: no grants, but restoring the snapshot re-grants its own document.
    const fresh = new PathGrants();
    expect(fresh.has(doc, "write")).toBe(false);
    ipc.handlers.clear();
    registerFileIpc({
      isTrustedSender: () => true,
      grants: fresh,
      recent: new RecentFiles(join(dir, "r2.json")),
      thumbnails: new ThumbnailCache(join(dir, "T2")),
      recovery,
      onRecentChanged: () => undefined,
      windows: { takeStartup: () => { throw new Error("unused"); }, openDocument: () => "new", newWindow: () => undefined, close: () => undefined, setDocInfo: () => undefined, saveFinished: () => undefined, liveRecoveryIds: () => new Set() },
    });
    expect([...((await invoke("recovery:read", "bbbbbbbb-1")) as Uint8Array)]).toEqual([2]);
    expect(fresh.has(doc, "write")).toBe(true);
    await invoke("recovery:discard", "bbbbbbbb-1");
    await expect(invoke("recovery:read", "bbbbbbbb-1")).rejects.toThrow(/no longer available/);
    await expect(invoke("recovery:write", { id: "../x", title: "", path: null, data: new Uint8Array(1) })).rejects.toThrow(/invalid recovery id/);
  });

  it("does not offer the autosaves of live windows", async () => {
    const { recovery } = start();
    await recovery.write({ id: "live-0001", title: "mine", path: null, data: new Uint8Array(1) });
    await recovery.write({ id: "dead-0001", title: "left over", path: null, data: new Uint8Array(1) });
    expect(((await invoke("recovery:list")) as Array<{ id: string }>).map((e) => e.id)).toEqual(["dead-0001"]);
  });

  it("speaks the window protocol, refusing ungranted paths and malformed messages", async () => {
    const { dir, grants, calls } = start();
    const doc = join(dir, "a.partzero");
    writeFileSync(doc, "x");
    await expect(invoke("window:openDocument", doc, { allowHere: true })).rejects.toThrow(/access denied/);
    grants.grantOpened(doc);
    expect(await invoke("window:openDocument", doc, { allowHere: true })).toEqual({ placement: "here" });
    expect(await invoke("window:openDocument", doc, {})).toEqual({ placement: "new" });
    await invoke("window:new", { command: { id: "file.open" } });
    await expect(invoke("window:new", { command: { id: "rm -rf" } })).rejects.toThrow(/invalid command/);
    await invoke("window:close");
    ipc.listeners.get("window:docInfo")!(fromApp, { pristine: true, recoveryId: "abcdefgh-1" });
    ipc.listeners.get("window:docInfo")!(fromApp, { pristine: true, recoveryId: "../bad" });
    ipc.listeners.get("window:saveFinished")!(fromApp, "save-1", true);
    ipc.listeners.get("window:saveFinished")!({ senderFrame: { url: "https://evil.example" }, sender: { id: 7 } }, "save-2", true);
    expect(calls).toEqual(["new:file.open", "close:7", "info:7:true:abcdefgh-1", "saved:7:save-1:true"]);
    expect(existsSync(doc)).toBe(true);
  });
});
