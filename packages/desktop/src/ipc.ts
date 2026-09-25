/**
 * IPC handlers for the preload bridge. Every channel of `IpcContract` (see `@aicad/app/bridge`)
 * is implemented here; arguments are validated, the sender must be our own app frame, and file
 * access goes through {@link PathGrants}.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dialog, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type {
  AppInfo,
  DocumentStateMessage,
  FileFilter,
  ForgeEvalRequest,
  ForgeExportRequest,
  IpcChannel,
  IpcContract,
  OpenDialogOptions,
  OpenInSlicerRequest,
  SaveDialogOptions,
} from "@aicad/app/bridge";
import type { AgentSetup } from "./agent/setup.js";
import { parseClearApiKey, parseSetApiKey } from "./agent/protocol.js";
import { documentStatePath, isDocumentPath, type PathGrants, type RecentFiles } from "./files.js";
import { forgeEval, forgeExport, forgeInfo, MESH_FORMATS } from "./forge-cli.js";
import { currentSlicer, openPrintInSlicer, type PrintHandoffDeps } from "./print-handoff.js";
import { checkSlicerPath, profileView } from "./profiles.js";
import { isInside } from "./slicer.js";
import { handleStepExport } from "./step-export.js";

/** Printing: the profile library, the prints folder and the slicer handoff (print-handoff.ts). */
export interface PrintIpcDeps extends PrintHandoffDeps {
  /** Show a file in the OS file manager (`shell.showItemInFolder`). */
  revealInFolder: (path: string) => void;
}

export interface IpcDeps {
  window: () => BrowserWindow | null;
  isTrustedSender: (frameUrl: string | undefined) => boolean;
  grants: PathGrants;
  recent: RecentFiles;
  forgeBin: string;
  appInfo: () => Promise<AppInfo>;
  onRecentChanged: () => void;
  /** `senderId`: the `webContents` id of the window the document is in (one document per window). */
  onDocState: (state: DocumentStateMessage, senderId: number) => void;
  /** A window started an agent run: its events go to that window (windows.ts). */
  onAgentStart?: (senderId: number) => void;
  /** The in-app design agent (host, keys, settings). */
  agent: AgentSetup;
  /** Printer profile and "Open in Bambu Studio" (absent: the channels are not registered). */
  print?: PrintIpcDeps;
}

type Handler<C extends IpcChannel> = (
  event: IpcMainInvokeEvent,
  ...args: IpcContract[C]["args"]
) => Promise<IpcContract[C]["result"]> | IpcContract[C]["result"];

const MAX_WRITE_BYTES = 512 * 1024 * 1024;

function str(v: unknown, what: string, max = 4096): string {
  if (typeof v !== "string" || v.length > max) throw new Error(`invalid ${what}`);
  return v;
}

function filters(v: unknown): FileFilter[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 20) throw new Error("invalid filters");
  return v.map((f: unknown) => {
    const o = f as { name?: unknown; extensions?: unknown };
    if (!Array.isArray(o.extensions)) throw new Error("invalid filter");
    return { name: str(o.name, "filter name", 200), extensions: o.extensions.map((e) => str(e, "extension", 20)) };
  });
}

function dialogOptions(v: unknown): { title?: string; defaultPath?: string; filters?: FileFilter[] } {
  const o = (typeof v === "object" && v !== null ? v : {}) as OpenDialogOptions & SaveDialogOptions;
  const out: { title?: string; defaultPath?: string; filters?: FileFilter[] } = {};
  if (o.title !== undefined) out.title = str(o.title, "title", 200);
  if (o.defaultPath !== undefined) out.defaultPath = str(o.defaultPath, "defaultPath");
  const f = filters(o.filters);
  if (f) out.filters = f;
  return out;
}

export function registerIpc(deps: IpcDeps): void {
  const handle = <C extends IpcChannel>(channel: C, handler: Handler<C>): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!deps.isTrustedSender(event.senderFrame?.url)) throw new Error(`untrusted sender for ${channel}`);
      return handler(event, ...(args as IpcContract[C]["args"]));
    });
  };

  handle("app:info", () => deps.appInfo());

  handle("dialog:open", async (_e, options) => {
    const win = deps.window();
    const o = dialogOptions(options);
    const opts = { ...o, properties: ["openFile" as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const p = r.canceled ? undefined : r.filePaths[0];
    return p ? deps.grants.grantOpened(p) : null;
  });

  handle("dialog:save", async (_e, options) => {
    const win = deps.window();
    const o = { ...dialogOptions(options), properties: ["createDirectory" as const, "showOverwriteConfirmation" as const] };
    const r = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o);
    return !r.canceled && r.filePath ? deps.grants.grantSaveTarget(r.filePath) : null;
  });

  // A document read or written here is the one the user works on in this session: it goes to the
  // top of the recent list (with its canonical path, see files.ts) and keeps its access when the
  // recent list is cleared, so Save still works after Clear Recent.
  const usedDocument = (path: string, real: string): void => {
    if (!isDocumentPath(path)) return;
    deps.grants.keepForSession(real);
    deps.recent.add(path, real);
    deps.onRecentChanged();
  };

  handle("fs:readText", async (_e, path) => {
    const real = deps.grants.check(path, "read");
    const text = await readFile(real, "utf8");
    usedDocument(path as string, real);
    return text;
  });

  handle("fs:write", async (_e, path, data) => {
    const real = deps.grants.check(path, "write");
    if (typeof data === "string") {
      if (data.length > MAX_WRITE_BYTES) throw new Error("file too large");
      await writeFile(real, data, "utf8");
    } else if (data instanceof Uint8Array) {
      if (data.byteLength > MAX_WRITE_BYTES) throw new Error("file too large");
      await writeFile(real, data);
    } else {
      throw new Error("invalid data");
    }
    usedDocument(path as string, real);
  });

  handle("recent:list", () => deps.recent.list());

  handle("recent:clear", () => {
    deps.recent.clear();
    // Forget the files, not just their names: grants restored from the list go too (except for the
    // documents opened or saved in this session).
    deps.grants.revokeRecent();
    deps.onRecentChanged();
  });

  handle("forge:info", () => forgeInfo(deps.forgeBin));

  handle("forge:eval", async (_e, req) => {
    const r = (typeof req === "object" && req !== null ? req : {}) as ForgeEvalRequest;
    const info = await forgeInfo(deps.forgeBin);
    if (!info.available) return { reportJson: null, objText: null, evalExitCode: null, exportExitCode: null, stderr: "", ms: 0, error: info.detail };
    const request: ForgeEvalRequest = { irJson: str(r.irJson, "IR", 32 * 1024 * 1024) };
    if (r.meshes !== undefined) request.meshes = r.meshes === true;
    if (typeof r.deflection === "number") request.deflection = r.deflection;
    return forgeEval(deps.forgeBin, request);
  });

  handle("forge:exportStep", (_e, req) => handleStepExport(deps.forgeBin, req));

  handle("forge:export", async (_e, req) => {
    const r = (typeof req === "object" && req !== null ? req : {}) as ForgeExportRequest;
    if (!MESH_FORMATS.includes(r.format)) throw new Error("invalid mesh format");
    const info = await forgeInfo(deps.forgeBin);
    if (!info.available) return { data: null, exitCode: null, stderr: "", error: info.detail };
    return forgeExport(deps.forgeBin, { irJson: str(r.irJson, "IR", 32 * 1024 * 1024), format: r.format, allowPartial: r.allowPartial === true });
  });

  // ─── Design agent ─────────────────────────────────────────────────────────────────────────
  // Requests are validated by the host (protocol.ts). Keys go in (setApiKey) but never come back:
  // every settings handler returns the redacted view. CLI agents are only detected (version,
  // lockdown, login state): their credentials are never read.
  const { host, keys } = deps.agent;
  handle("agent:start", (e, req) => {
    deps.onAgentStart?.(e.sender.id);
    return host.start(req);
  });
  handle("agent:answer", (_e, req) => host.answer(req));
  handle("agent:stop", (_e, req) => host.stop(req));
  handle("settings:get", () => host.settingsView());
  handle("settings:update", (_e, req) => host.updateSettings(req));
  handle("settings:setApiKey", (_e, req) => {
    const { provider, key } = parseSetApiKey(req);
    keys.store.set(provider, key);
    return host.settingsView();
  });
  handle("settings:clearApiKey", (_e, req) => {
    keys.store.clear(parseClearApiKey(req).provider);
    return host.settingsView();
  });
  handle("settings:probeProviders", (_e, req) => host.probeProviders(req));

  // ─── Printing (ALPHA-0-PLAN W5, ADR 0016) ─────────────────────────────────────────────────
  // The renderer sends the compiled IR and the document name; the main process picks the file
  // name, writes only into the prints folder and launches only Bambu Studio (slicer.ts).
  const print = deps.print;
  if (print) {
    handle("print:profile", () => profileView(print.profiles.printer(), print.profiles.material(), print.printsDir));
    handle("slicer:detect", () => currentSlicer(print));
    handle("slicer:setPath", (_e, path) => {
      print.profiles.update({ slicerPath: checkSlicerPath(path) });
      return currentSlicer(print);
    });
    handle("slicer:open", (_e, req) => {
      const r = (typeof req === "object" && req !== null ? req : {}) as Partial<OpenInSlicerRequest>;
      return openPrintInSlicer(print, { irJson: str(r.irJson, "IR", 32 * 1024 * 1024), docName: str(r.docName ?? "", "document name", 200) });
    });
    handle("print:reveal", (_e, path) => {
      const p = str(path, "path");
      if (!isInside(print.printsDir, p)) throw new Error(`only files in ${print.printsDir} can be shown`);
      print.revealInFolder(p);
    });
  }

  ipcMain.on("doc:state", (event: IpcMainEvent, state: unknown) => {
    if (!deps.isTrustedSender(event.senderFrame?.url)) return;
    const s = (typeof state === "object" && state !== null ? state : {}) as Partial<DocumentStateMessage>;
    if (typeof s.title !== "string" || typeof s.dirty !== "boolean") return;
    // Only a path the user granted may become the window's represented file.
    deps.onDocState({ title: s.title.slice(0, 200), path: documentStatePath(s.path, deps.grants), dirty: s.dirty }, event.sender.id);
  });
}
