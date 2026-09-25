/**
 * The documents-and-files part of the host bridge (types only, like `bridge.ts`, which re-exports this file: the
 * sandboxed preload imports nothing else). The desktop main process implements every channel in
 * `packages/desktop/src/ipc/files.ts`; the renderer reaches them through `window.aicad.files` (`FilesBridge`).
 *
 * Security model (unchanged from `bridge.ts`): a path is readable or writable only after the user chose it in a
 * native dialog, opened it from the recent list, or double-clicked it in the Finder. The recovery store and the
 * thumbnail cache live in the app's profile and are addressed by id, never by path.
 */
import type { MenuCommandMessage } from "../bridge.js";

/** A recent document, as the main process lists it (most recent first). */
export interface RecentDocument {
  path: string;
  /** The file name. */
  name: string;
  /** Whether the file is still there. */
  exists: boolean;
  /** Last modification, ms since the epoch (null: missing). */
  modifiedMs: number | null;
  /** Whether a thumbnail was saved with it (`files:thumbnail`). */
  hasThumbnail: boolean;
}

export interface WriteDocumentRequest {
  path: string;
  data: Uint8Array | string;
  /** A PNG for the recent-files grid, kept in the profile (keyed by the path). */
  thumbnail?: Uint8Array | null;
}

export interface WriteDocumentResult {
  bytes: number;
  /** The previous version of the file, kept as `<file>.bak` (null: there was none). */
  backup: string | null;
}

/** An unsaved document the recovery store holds (autosaved while it had changes). */
export interface RecoveryEntry {
  id: string;
  /** The document's name as the window showed it. */
  title: string;
  /** The document's own file, when it had one the user may write. */
  path: string | null;
  /** When the snapshot was written, ms since the epoch. */
  savedAt: number;
  bytes: number;
}

export interface RecoveryWriteRequest {
  /** The window's recovery id (`[a-z0-9-]`, 8–64 characters). */
  id: string;
  title: string;
  path: string | null;
  /** The document as a `.partzero` file. */
  data: Uint8Array;
}

/** What a window does when it starts. */
export interface WindowStartup {
  windowId: number;
  /** A document to open in this window (Finder double-click, argv, Open in a new window). */
  open: string | null;
  /** A menu command to run once the window is ready (sent while no window existed). */
  command: MenuCommandMessage | null;
  /**
   * Documents a crash or a force quit left in the recovery store. Only the first window of a launch gets them, and
   * only when the previous run did not quit cleanly or left snapshots behind.
   */
  recovery: RecoveryEntry[];
  /** The previous run ended without a clean quit (the session marker was still there). */
  uncleanExit: boolean;
}

/** Where `window:openDocument` opened a document. */
export type OpenPlacement = "existing" | "here" | "new";

/** Window facts the main process needs beyond the title and the dirty flag (`doc:state`). */
export interface WindowDocInfo {
  /** Untitled and unchanged: opening a document may replace it instead of opening a new window. */
  pristine: boolean;
  /** The window's recovery id (its autosaves), so closing without saving discards them. */
  recoveryId: string;
}

/** Main → renderer. */
export type FilesEvent =
  /** Open `path` in this window (it was pristine, e.g. a Finder double-click). */
  | { type: "open"; path: string }
  /** The close prompt was answered "Save": save, then report with `window:saveFinished`. */
  | { type: "saveBeforeClose"; requestId: string };

export interface FilesBridge {
  /** Read a granted file's bytes (at most 512 MiB). */
  readBytes(path: string): Promise<Uint8Array>;
  /** Write a document atomically (temp file, fsync, rename; the old version kept as `.bak`). */
  writeDocument(request: WriteDocumentRequest): Promise<WriteDocumentResult>;
  recent(): Promise<RecentDocument[]>;
  thumbnail(path: string): Promise<Uint8Array | null>;
  recovery: {
    list(): Promise<RecoveryEntry[]>;
    write(request: RecoveryWriteRequest): Promise<void>;
    read(id: string): Promise<Uint8Array>;
    discard(id: string): Promise<void>;
  };
  window: {
    startup(): Promise<WindowStartup>;
    /** Focus the window that has `path` open; else open it here when `allowHere`; else in a new window. */
    openDocument(path: string, options: { allowHere: boolean }): Promise<{ placement: OpenPlacement }>;
    /** A new window with an untitled document (and optionally a command to run in it). */
    newWindow(options?: { command?: MenuCommandMessage }): Promise<void>;
    /** Close this window (the unsaved-changes prompt applies). */
    close(): Promise<void>;
    setDocInfo(info: WindowDocInfo): void;
    saveFinished(requestId: string, saved: boolean): void;
  };
  onEvent(listener: (e: FilesEvent) => void): () => void;
}

/** The `invoke` channels (merged into `IpcContract`). */
export interface FilesIpcContract {
  "files:readBytes": { args: [path: string]; result: Uint8Array };
  "files:writeDocument": { args: [WriteDocumentRequest]; result: WriteDocumentResult };
  "files:recent": { args: []; result: RecentDocument[] };
  "files:thumbnail": { args: [path: string]; result: Uint8Array | null };
  "recovery:list": { args: []; result: RecoveryEntry[] };
  "recovery:write": { args: [RecoveryWriteRequest]; result: void };
  "recovery:read": { args: [id: string]; result: Uint8Array };
  "recovery:discard": { args: [id: string]; result: void };
  "window:startup": { args: []; result: WindowStartup };
  "window:openDocument": { args: [path: string, options: { allowHere: boolean }]; result: { placement: OpenPlacement } };
  "window:new": { args: [options: { command?: MenuCommandMessage }]; result: void };
  "window:close": { args: []; result: void };
}

/** The `send` channels (merged into `IpcSendContract`). */
export interface FilesSendContract {
  "window:docInfo": [WindowDocInfo];
  "window:saveFinished": [requestId: string, saved: boolean];
}

/** Main → renderer events (merged into `IpcEventContract`). */
export interface FilesEventContract {
  "files:event": [FilesEvent];
}
