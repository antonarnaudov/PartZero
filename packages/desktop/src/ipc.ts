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
  SaveDialogOptions,
} from "@aicad/app/bridge";
import { isDocumentPath, type PathGrants, type RecentFiles } from "./files.js";
import { forgeEval, forgeExport, forgeInfo, MESH_FORMATS } from "./forge-cli.js";

export interface IpcDeps {
  window: () => BrowserWindow | null;
  isTrustedSender: (frameUrl: string | undefined) => boolean;
  grants: PathGrants;
  recent: RecentFiles;
  forgeBin: string;
  appInfo: () => Promise<AppInfo>;
  onRecentChanged: () => void;
  onDocState: (state: DocumentStateMessage) => void;
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
    return p ? deps.grants.grant(p) : null;
  });

  handle("dialog:save", async (_e, options) => {
    const win = deps.window();
    const o = { ...dialogOptions(options), properties: ["createDirectory" as const, "showOverwriteConfirmation" as const] };
    const r = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o);
    return !r.canceled && r.filePath ? deps.grants.grant(r.filePath) : null;
  });

  handle("fs:readText", async (_e, path) => {
    const p = deps.grants.check(path);
    const text = await readFile(p, "utf8");
    if (isDocumentPath(p)) {
      deps.recent.add(p);
      deps.onRecentChanged();
    }
    return text;
  });

  handle("fs:write", async (_e, path, data) => {
    const p = deps.grants.check(path);
    if (typeof data === "string") {
      if (data.length > MAX_WRITE_BYTES) throw new Error("file too large");
      await writeFile(p, data, "utf8");
    } else if (data instanceof Uint8Array) {
      if (data.byteLength > MAX_WRITE_BYTES) throw new Error("file too large");
      await writeFile(p, data);
    } else {
      throw new Error("invalid data");
    }
    if (isDocumentPath(p)) {
      deps.recent.add(p);
      deps.onRecentChanged();
    }
  });

  handle("recent:list", () => deps.recent.list());

  handle("recent:clear", () => {
    deps.recent.clear();
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

  handle("forge:export", async (_e, req) => {
    const r = (typeof req === "object" && req !== null ? req : {}) as ForgeExportRequest;
    if (!MESH_FORMATS.includes(r.format)) throw new Error("invalid mesh format");
    const info = await forgeInfo(deps.forgeBin);
    if (!info.available) return { data: null, exitCode: null, stderr: "", error: info.detail };
    return forgeExport(deps.forgeBin, { irJson: str(r.irJson, "IR", 32 * 1024 * 1024), format: r.format, allowPartial: r.allowPartial === true });
  });

  ipcMain.on("doc:state", (event: IpcMainEvent, state: unknown) => {
    if (!deps.isTrustedSender(event.senderFrame?.url)) return;
    const s = (typeof state === "object" && state !== null ? state : {}) as Partial<DocumentStateMessage>;
    if (typeof s.title !== "string" || typeof s.dirty !== "boolean") return;
    deps.onDocState({ title: s.title.slice(0, 200), path: typeof s.path === "string" ? s.path : null, dirty: s.dirty });
  });
}
