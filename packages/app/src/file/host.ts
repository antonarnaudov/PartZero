/**
 * What the document layer needs from the platform ({@link FileHost}): dialogs, binary reads, atomic document saves,
 * exports, the recent list with thumbnails, the recovery store and the window protocol.
 *
 * - {@link ElectronFileHost}: the desktop bridge (`window.aicad`, with its `files` section when the shell has one;
 *   an older shell without it still opens and saves text documents).
 * - {@link BrowserFileHost}: the web build: a file input for opening (bytes kept in memory under a `browser:` path),
 *   downloads for saving; no recovery store, no windows.
 */
import type {
  AicadBridge,
  FilesBridge,
  FilesEvent,
  OpenDialogOptions,
  RecentDocument,
  SaveDialogOptions,
  WriteDocumentResult,
} from "../bridge";
import type { AppHost } from "../host/host";

export interface FileHost {
  readonly kind: "electron" | "browser" | "memory";
  pickOpen(options: OpenDialogOptions): Promise<string | null>;
  pickSave(options: SaveDialogOptions): Promise<string | null>;
  readBytes(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  /** Save a document (atomically, with a `.bak`, where the host can). */
  writeDocument(path: string, data: Uint8Array | string, thumbnail: Uint8Array | null): Promise<WriteDocumentResult>;
  /** Write an export (a mesh, a STEP file). */
  writeExport(path: string, data: Uint8Array | string): Promise<void>;
  recent(): Promise<RecentDocument[]>;
  clearRecent(): Promise<void>;
  thumbnail(path: string): Promise<Uint8Array | null>;
  /** The recovery store (desktop only). */
  readonly recovery: FilesBridge["recovery"] | null;
  /** Several windows (desktop only). */
  readonly windows: FilesBridge["window"] | null;
  onEvent(listener: (e: FilesEvent) => void): () => void;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

export class ElectronFileHost implements FileHost {
  readonly kind = "electron" as const;
  readonly recovery: FilesBridge["recovery"] | null;
  readonly windows: FilesBridge["window"] | null;
  private readonly bridge: AicadBridge;
  private readonly files: FilesBridge | null;

  constructor(bridge: AicadBridge) {
    this.bridge = bridge;
    this.files = bridge.files ?? null;
    this.recovery = this.files?.recovery ?? null;
    this.windows = this.files?.window ?? null;
  }

  pickOpen(options: OpenDialogOptions): Promise<string | null> {
    return this.bridge.showOpenDialog(options);
  }

  pickSave(options: SaveDialogOptions): Promise<string | null> {
    return this.bridge.showSaveDialog(options);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    if (this.files) return this.files.readBytes(path);
    throw new Error("this version of the desktop shell cannot read binary documents; update the app");
  }

  async readText(path: string): Promise<string> {
    return this.bridge.readTextFile(path);
  }

  async writeDocument(path: string, data: Uint8Array | string, thumbnail: Uint8Array | null): Promise<WriteDocumentResult> {
    if (this.files) return this.files.writeDocument({ path, data, thumbnail });
    await this.bridge.writeFile(path, data);
    return { bytes: typeof data === "string" ? data.length : data.byteLength, backup: null };
  }

  writeExport(path: string, data: Uint8Array | string): Promise<void> {
    return this.bridge.writeFile(path, data);
  }

  async recent(): Promise<RecentDocument[]> {
    if (this.files) return this.files.recent();
    const paths = await this.bridge.recentFiles();
    return paths.map((p) => ({ path: p, name: baseName(p), exists: true, modifiedMs: null, hasThumbnail: false }));
  }

  clearRecent(): Promise<void> {
    return this.bridge.clearRecentFiles();
  }

  async thumbnail(path: string): Promise<Uint8Array | null> {
    return this.files ? this.files.thumbnail(path) : null;
  }

  onEvent(listener: (e: FilesEvent) => void): () => void {
    return this.files ? this.files.onEvent(listener) : () => undefined;
  }
}

/** The web build: opens through a file input (bytes kept in memory), saves and exports as downloads. */
export class BrowserFileHost implements FileHost {
  readonly kind = "browser" as const;
  readonly recovery = null;
  readonly windows = null;
  private readonly files = new Map<string, Uint8Array>();
  private readonly app: AppHost;

  constructor(app: AppHost) {
    this.app = app;
  }

  pickOpen(options: OpenDialogOptions): Promise<string | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      const exts = options.filters?.flatMap((f) => f.extensions.map((e) => `.${e}`)) ?? [];
      if (exts.length) input.accept = exts.join(",");
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        void file.arrayBuffer().then((buf) => {
          const path = `browser:${file.name}`;
          this.files.set(path, new Uint8Array(buf));
          resolve(path);
        });
      });
      input.addEventListener("cancel", () => resolve(null));
      input.click();
    });
  }

  pickSave(options: SaveDialogOptions): Promise<string | null> {
    return this.app.pickSavePath(options);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const b = this.files.get(path);
    if (!b) throw new Error(`not available in the browser: ${path}`);
    return b;
  }

  async readText(path: string): Promise<string> {
    return utf8.decode(await this.readBytes(path));
  }

  async writeDocument(path: string, data: Uint8Array | string): Promise<WriteDocumentResult> {
    await this.app.writeFile(path, data);
    return { bytes: typeof data === "string" ? data.length : data.byteLength, backup: null };
  }

  writeExport(path: string, data: Uint8Array | string): Promise<void> {
    return this.app.writeFile(path, data);
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

  onEvent(): () => void {
    return () => undefined;
  }
}

/** The host for this app: the desktop bridge when present, else the browser. */
export function createFileHost(app: AppHost): FileHost {
  const bridge = typeof window !== "undefined" ? window.aicad : undefined;
  return bridge ? new ElectronFileHost(bridge) : new BrowserFileHost(app);
}
