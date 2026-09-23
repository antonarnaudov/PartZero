/**
 * The contract between the app (renderer) and a native host shell, i.e. `@aicad/desktop`.
 *
 * The desktop preload exposes an {@link AicadBridge} as `window.aicad` through `contextBridge`, and
 * the main process implements every {@link IpcContract} channel. This file is **types only**:
 * the sandboxed preload can only `require("electron")`, so it imports these types and nothing
 * else. `@aicad/desktop` consumes the emitted declarations via `@aicad/app/bridge`.
 *
 * Security model: the renderer never gets general file-system access. Paths become readable or
 * writable only after the user picked them in a native dialog (or earlier did so: recent files),
 * and the Forge CLI is exposed as two fixed operations whose temp files the main process owns.
 */

export type MeshFormat = "3mf" | "stl" | "obj";

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  title?: string;
  filters?: FileFilter[];
  defaultPath?: string;
}

export interface SaveDialogOptions {
  title?: string;
  filters?: FileFilter[];
  /** Suggested file name or full path. */
  defaultPath?: string;
}

export interface ForgeCliInfo {
  available: boolean;
  /** Resolved binary path (even when missing). */
  path: string;
  /** Human-readable status, including how to fix a missing binary. */
  detail: string;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  /** True when running unpackaged (`pnpm dev` / `pnpm start`). */
  isDev: boolean;
  forgeCli: ForgeCliInfo;
}

/** Result of `aicad eval` (+ an OBJ export for display meshes). */
export interface ForgeEvalResponse {
  /** `aicad.metrics/0` JSON printed by `aicad eval`, or null when it produced none. */
  reportJson: string | null;
  /** OBJ text of every body that evaluated (`aicad export --allow-partial`), or null. */
  objText: string | null;
  evalExitCode: number | null;
  exportExitCode: number | null;
  /** Combined stderr of both runs (diagnostics, trimmed). */
  stderr: string;
  /** Wall time of the whole call in the main process, ms. */
  ms: number;
  /** Set when the CLI could not run at all (missing binary, timeout, …). */
  error?: string;
}

export interface ForgeExportResponse {
  data: Uint8Array | null;
  exitCode: number | null;
  stderr: string;
  error?: string;
}

export interface ForgeEvalRequest {
  irJson: string;
  /** Also export an OBJ for display (default true). */
  meshes?: boolean;
  /** Chordal deviation for display meshes, mm (default 0.05). */
  deflection?: number;
}

export interface ForgeExportRequest {
  irJson: string;
  format: MeshFormat;
  /** Export the bodies that evaluated even when some features failed. */
  allowPartial?: boolean;
}

/** A command request sent by the native menu. `id` is a command-layer id, e.g. `file.open`. */
export interface MenuCommandMessage {
  id: string;
  args?: unknown;
}

/** The renderer tells the shell about the open document (window title, dirty dot, close prompt). */
export interface DocumentStateMessage {
  title: string;
  path: string | null;
  dirty: boolean;
}

/** `window.aicad` in the renderer. */
export interface AicadBridge {
  /** `process.platform` of the host (`darwin`, `win32`, `linux`). */
  readonly platform: string;
  appInfo(): Promise<AppInfo>;
  showOpenDialog(options: OpenDialogOptions): Promise<string | null>;
  showSaveDialog(options: SaveDialogOptions): Promise<string | null>;
  /** Read a UTF-8 file the user granted (dialog or recent file). */
  readTextFile(path: string): Promise<string>;
  /** Write a file the user granted (save dialog or recent file). */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  recentFiles(): Promise<string[]>;
  clearRecentFiles(): Promise<void>;
  forge: {
    info(): Promise<ForgeCliInfo>;
    eval(request: ForgeEvalRequest): Promise<ForgeEvalResponse>;
    export(request: ForgeExportRequest): Promise<ForgeExportResponse>;
  };
  setDocumentState(state: DocumentStateMessage): void;
  /** Subscribe to native menu commands; returns an unsubscribe function. */
  onMenuCommand(listener: (message: MenuCommandMessage) => void): () => void;
}

/** Every `ipcRenderer.invoke` channel with its argument tuple and result. */
export interface IpcContract {
  "app:info": { args: []; result: AppInfo };
  "dialog:open": { args: [OpenDialogOptions]; result: string | null };
  "dialog:save": { args: [SaveDialogOptions]; result: string | null };
  "fs:readText": { args: [path: string]; result: string };
  "fs:write": { args: [path: string, data: string | Uint8Array]; result: void };
  "recent:list": { args: []; result: string[] };
  "recent:clear": { args: []; result: void };
  "forge:info": { args: []; result: ForgeCliInfo };
  "forge:eval": { args: [ForgeEvalRequest]; result: ForgeEvalResponse };
  "forge:export": { args: [ForgeExportRequest]; result: ForgeExportResponse };
}

export type IpcChannel = keyof IpcContract;

/** One-way renderer → main messages (`ipcRenderer.send`). */
export interface IpcSendContract {
  "doc:state": [DocumentStateMessage];
}

export type IpcSendChannel = keyof IpcSendContract;

/** Main → renderer events (`webContents.send`). */
export interface IpcEventContract {
  "menu:command": [MenuCommandMessage];
}

export type IpcEventChannel = keyof IpcEventContract;
