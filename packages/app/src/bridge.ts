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
 * The print handoff (`slicer:open`) writes only into `~/PartZero/Prints`, a name the main process
 * chooses, and launches only an app whose bundle id is Bambu Studio's (ADR 0016).
 * The design agent runs in a utility process behind the main process; API keys stay there (see
 * `agent-protocol.ts`).
 */
import type {
  AgentAnswerRequest,
  AgentBridge,
  AgentEvent,
  AgentSettingsView,
  AgentStartRequest,
  AgentStartResponse,
  AgentStopRequest,
  ClearApiKeyRequest,
  ProbeProvidersRequest,
  SetApiKeyRequest,
  SettingsBridge,
  SettingsUpdate,
} from "./agent-protocol.js";
import type { FilesBridge, FilesEventContract, FilesIpcContract, FilesSendContract } from "./file/bridge-types.js";

export type * from "./agent-protocol.js";
export type * from "./file/bridge-types.js";

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
  /**
   * The build identity of a bundled build (`packages/desktop/src/build-info.ts`): edition, commit, whether the tree was
   * dirty, and when it was bundled. Development runs report edition `dev` and no commit. Optional for older shells.
   */
  build?: { edition: string; commit: string | null; dirty: boolean; builtAt: string | null };
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

/** STEP application protocol of an export (`aicad export --step-schema`). */
export type StepSchema = "ap214" | "ap242";

/** The exact B-rep of the evaluated bodies as STEP (`aicad export --format step`, forge-io's writer). */
export interface ForgeStepExportRequest {
  irJson: string;
  /** Default `ap214` (the most widely read). */
  schema?: StepSchema;
  /** The STEP product name other CAD tools show as the part name (default: `part`). */
  productName?: string;
  /** Export the bodies that evaluated even when some features failed. */
  allowPartial?: boolean;
}

export interface ForgeStepExportResponse {
  /** The STEP bytes (exit 0 only). */
  data: Uint8Array | null;
  /** The `aicad.export/1` summary (per body: Forge's metrics and what the writer produced; the `error` on a refusal). */
  summary: unknown;
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
  /** Chordal deviation, mm (`aicad export --deflection`; default the CLI's). */
  deflection?: number;
  /** Angle between neighbouring facet normals, radians (`--angular`). */
  angular?: number;
}

// ─── Printing: machine profile and the slicer handoff (ALPHA-0-PLAN W5, ADR 0016) ──────────

/** A printer as the export sees it (a built-in profile in Alpha 0). */
export interface PrinterProfileView {
  /** e.g. `builtin:bambu-p2s-0.4`. */
  id: string;
  version: number;
  /** e.g. `Bambu Lab P2S`. */
  name: string;
  /** Bed width (X), depth (Y) and maximum print height (Z), mm. */
  bed: { x: number; y: number; z: number };
  /** Room kept free on each side of the bed in X and Y, mm. */
  bedMargin: number;
  /** Nozzle diameter, mm. */
  nozzle: number;
  /** Fields not yet checked on the owner's machine (they come from the public spec sheet). */
  unverified: string[];
}

/** A material's design defaults (diametral clearances for vertical holes, mm). */
export interface MaterialProfileView {
  /** e.g. `builtin:pla`. */
  id: string;
  version: number;
  /** e.g. `PLA`. */
  name: string;
  clearances: { press: number; slip: number; running: number; pressMetal: number };
  /** Where the clearances come from: `default` until the Fit Lab measures them. */
  clearanceSource: "default" | "fitlab";
  /** Thinnest wall worth printing, mm. */
  minWall: number;
  /** Steepest overhang that prints without supports, degrees from vertical. */
  maxOverhangDeg: number;
}

/** `print:profile`: the active printer and material, and where prints go. */
export interface PrintProfileView {
  printer: PrinterProfileView;
  material: MaterialProfileView;
  /** e.g. `Bambu Lab P2S · 0.4 mm · PLA` (the welcome card's line). */
  summary: string;
  /** `~/PartZero/Prints`, absolute. */
  printsDir: string;
  /** One line for the design agent's conventions: machine, material, clearances, limits. */
  agentConventions: string;
}

/** The user's installed slicer, as `slicer:detect` finds it (Bambu Studio only in Alpha 0). */
export interface SlicerInfo {
  found: boolean;
  /** `Bambu Studio`. */
  name: string;
  bundleId: string;
  /** The `.app` bundle when found (or the path set in Settings when that is missing). */
  path: string | null;
  /** `CFBundleShortVersionString`, e.g. `02.06.00.51`. */
  version: string | null;
  /** How it was found. */
  source: "settings" | "applications" | "user-applications" | "launch-services" | null;
  /** The path set in Settings, if any (it overrides the search). */
  customPath: string | null;
  /** Why it was not found, in plain words. */
  reason?: string;
  /** What to do about it. */
  fix?: string;
}

/** `slicer:open`: export the current design for the active printer and open it in the slicer. */
export interface OpenInSlicerRequest {
  /** The compiled IR of the document (JSON). */
  irJson: string;
  /** The document name (the file is `<name>-<hash8>.3mf`). */
  docName: string;
}

/** Something about a print the slicer may treat differently from the model (it is still written). */
export interface PrintWarning {
  /** e.g. `EXPORT_BODY_FLOATING`: a body starts above the bed, and the slicer drops it onto the plate. */
  code: string;
  message: string;
  details?: unknown;
}

export type OpenInSlicerRefusal =
  /** Larger than the bed less its margin, or over an exclusion zone. */
  | "EXPORT_BED_FIT"
  /** Forge's check did not pass (an error, or a body that is not a valid solid). */
  | "EXPORT_NOT_VALID"
  /** A body's mesh is not watertight (a Forge problem, not the design's). */
  | "EXPORT_NOT_WATERTIGHT"
  /** Bodies stacked above each other: the slicer would drop them into each other. */
  | "EXPORT_BODIES_OVERLAP"
  /** The export failed, or Forge's record of it is missing or inconsistent. */
  | "EXPORT_FAILED"
  /** The `aicad` binary is older than the app (rebuild it). */
  | "FORGE_OUTDATED"
  | "FORGE_UNAVAILABLE";

export type OpenInSlicerResult =
  /**
   * Written to `~/PartZero/Prints` and handed to the slicer by the OS (`open` succeeded; whether
   * the slicer then loaded it is not observable). `alreadyRunning`: the slicer was running before,
   * so it may open the file in a new window (null: not known).
   */
  | { status: "opened"; file: string; receipt: string; slicer: SlicerInfo; bodies: number; bytes: number; alreadyRunning: boolean | null; warnings: PrintWarning[] }
  /** Written, but not opened: no slicer, or its launch failed. `message` says why, `fix` what to do. */
  | { status: "exported"; file: string; receipt: string; slicer: SlicerInfo; bodies: number; bytes: number; warnings: PrintWarning[]; message: string; fix?: string }
  /** Nothing written: the design is not checked, does not fit the printer, or would print wrong. */
  | { status: "refused"; code: OpenInSlicerRefusal; message: string; details?: unknown };

/** `window.aicad.print`: printer profile, slicer detection and the handoff. */
export interface PrintBridge {
  profile(): Promise<PrintProfileView>;
  detectSlicer(): Promise<SlicerInfo>;
  /** Point at a Bambu Studio `.app` elsewhere, or `null` to search the usual places again. */
  setSlicerPath(path: string | null): Promise<SlicerInfo>;
  openInSlicer(request: OpenInSlicerRequest): Promise<OpenInSlicerResult>;
  /** Show a file in `~/PartZero/Prints` in Finder (other paths are refused). */
  reveal(path: string): Promise<void>;
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
    /** STEP export (optional: an older shell has none). */
    exportStep?(request: ForgeStepExportRequest): Promise<ForgeStepExportResponse>;
  };
  setDocumentState(state: DocumentStateMessage): void;
  /** Subscribe to native menu commands; returns an unsubscribe function. */
  onMenuCommand(listener: (message: MenuCommandMessage) => void): () => void;
  /** The design agent (runs in a utility process; see `agent-protocol.ts`). */
  agent: AgentBridge;
  /** Agent settings: models, budget and API keys (keys are write-only from here). */
  settings: SettingsBridge;
  /** Printer profile and the slicer handoff (optional: an older shell has none). */
  print?: PrintBridge;
  /** Documents and files: binary reads, atomic saves, recovery, windows (optional: an older shell has none). */
  files?: FilesBridge;
}

/** Every `ipcRenderer.invoke` channel with its argument tuple and result. */
export interface IpcContract extends FilesIpcContract {
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
  "forge:exportStep": { args: [ForgeStepExportRequest]; result: ForgeStepExportResponse };
  "agent:start": { args: [AgentStartRequest]; result: AgentStartResponse };
  "agent:answer": { args: [AgentAnswerRequest]; result: { ok: boolean } };
  "agent:stop": { args: [AgentStopRequest]; result: { ok: boolean } };
  "settings:get": { args: []; result: AgentSettingsView };
  "settings:update": { args: [SettingsUpdate]; result: AgentSettingsView };
  "settings:setApiKey": { args: [SetApiKeyRequest]; result: AgentSettingsView };
  "settings:clearApiKey": { args: [ClearApiKeyRequest]; result: AgentSettingsView };
  "settings:probeProviders": { args: [ProbeProvidersRequest]; result: AgentSettingsView };
  "print:profile": { args: []; result: PrintProfileView };
  "print:reveal": { args: [path: string]; result: void };
  "slicer:detect": { args: []; result: SlicerInfo };
  "slicer:setPath": { args: [path: string | null]; result: SlicerInfo };
  "slicer:open": { args: [OpenInSlicerRequest]; result: OpenInSlicerResult };
}

export type IpcChannel = keyof IpcContract;

/** One-way renderer → main messages (`ipcRenderer.send`). */
export interface IpcSendContract extends FilesSendContract {
  "doc:state": [DocumentStateMessage];
}

export type IpcSendChannel = keyof IpcSendContract;

/** Main → renderer events (`webContents.send`). */
export interface IpcEventContract extends FilesEventContract {
  "menu:command": [MenuCommandMessage];
  "agent:event": [AgentEvent];
}

export type IpcEventChannel = keyof IpcEventContract;
