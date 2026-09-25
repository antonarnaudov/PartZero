/**
 * IPC for documents and files (`FilesIpcContract` in `@aicad/app/bridge`): binary reads, atomic document saves with
 * a `.bak`, the recent-documents grid, the recovery store and the window protocol. Like ipc.ts: every argument is
 * validated, the sender must be our own app frame, and paths go through {@link PathGrants}.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { FilesIpcContract, MenuCommandMessage, OpenPlacement, RecoveryEntry, WindowDocInfo, WindowStartup } from "@aicad/app/bridge";
import { describeRecent, isDocumentPath, readFileCapped, writeFileAtomic, type FaultHook, type PathGrants, type RecentFiles, type ThumbnailCache } from "../files.js";
import { isRecoveryId, type RecoveryStore } from "../recovery.js";

/** What the window manager offers the file IPC (see windows.ts). */
export interface FileWindowsApi {
  takeStartup(webContentsId: number): WindowStartup;
  openDocument(webContentsId: number, path: string, allowHere: boolean): OpenPlacement;
  newWindow(command: MenuCommandMessage | null): void;
  close(webContentsId: number): void;
  setDocInfo(webContentsId: number, info: WindowDocInfo): void;
  saveFinished(webContentsId: number, requestId: string, saved: boolean): void;
  liveRecoveryIds(): Set<string>;
}

export interface FileIpcDeps {
  isTrustedSender: (frameUrl: string | undefined) => boolean;
  grants: PathGrants;
  recent: RecentFiles;
  thumbnails: ThumbnailCache;
  recovery: RecoveryStore;
  windows: FileWindowsApi;
  /** The recent list changed (rebuild the menu). */
  onRecentChanged: () => void;
  /** Unpackaged runs only: the save fault points (FULL-MODELING-PLAN C7). */
  fault?: FaultHook;
}

type Channel = keyof FilesIpcContract;
type Handler<C extends Channel> = (event: IpcMainInvokeEvent, ...args: FilesIpcContract[C]["args"]) => Promise<FilesIpcContract[C]["result"]> | FilesIpcContract[C]["result"];

function str(v: unknown, what: string, max = 4096): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new Error(`invalid ${what}`);
  return v;
}

function bytesOf(v: unknown, what: string): Uint8Array {
  if (v instanceof Uint8Array) return v;
  throw new Error(`invalid ${what}`);
}

function command(v: unknown): MenuCommandMessage | null {
  if (v === undefined || v === null) return null;
  const o = v as { id?: unknown; args?: unknown };
  if (typeof o.id !== "string" || !/^[a-z]+\.[A-Za-z]+$/.test(o.id)) throw new Error("invalid command");
  return o.args === undefined ? { id: o.id } : { id: o.id, args: o.args };
}

export function registerFileIpc(deps: FileIpcDeps): void {
  const handle = <C extends Channel>(channel: C, handler: Handler<C>): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!deps.isTrustedSender(event.senderFrame?.url)) throw new Error(`untrusted sender for ${channel}`);
      return handler(event, ...(args as FilesIpcContract[C]["args"]));
    });
  };
  const on = (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (!deps.isTrustedSender(event.senderFrame?.url)) return;
      try {
        listener(event, ...args);
      } catch {
        // a malformed one-way message is dropped
      }
    });
  };

  // A document read or written is the one the user works on: top of the recent list, access kept after Clear Recent.
  const usedDocument = (path: string, real: string): void => {
    if (!isDocumentPath(path)) return;
    deps.grants.keepForSession(real);
    deps.recent.add(path, real);
    deps.onRecentChanged();
  };

  handle("files:readBytes", async (_e, path) => {
    const real = deps.grants.check(path, "read");
    const data = await readFileCapped(real);
    usedDocument(path, real);
    return data;
  });

  handle("files:writeDocument", async (_e, request) => {
    const r = (typeof request === "object" && request !== null ? request : {}) as Partial<{ path: unknown; data: unknown; thumbnail: unknown }>;
    const path = str(r.path, "path");
    const real = deps.grants.check(path, "write");
    if (!isDocumentPath(path)) throw new Error("only documents (.partzero, .cad.ts, .json) are saved this way");
    const data = typeof r.data === "string" ? r.data : bytesOf(r.data, "data");
    const result = await writeFileAtomic(real, data, { backup: true, ...(deps.fault ? { fault: deps.fault } : {}) });
    if (r.thumbnail instanceof Uint8Array) await deps.thumbnails.put(real, r.thumbnail).catch(() => undefined);
    usedDocument(path, real);
    return result;
  });

  handle("files:recent", () => describeRecent(deps.recent.list(), deps.thumbnails));

  handle("files:thumbnail", async (_e, path) => {
    const p = str(path, "path");
    // Only documents in the recent list (their names are already known to the renderer).
    if (!deps.recent.list().includes(p)) return null;
    return deps.thumbnails.get(p);
  });

  // ─── Recovery ───────────────────────────────────────────────────────────────────────────
  const offered = (): RecoveryEntry[] => {
    const live = deps.windows.liveRecoveryIds();
    return deps.recovery.list().filter((e) => !live.has(e.id));
  };

  handle("recovery:list", () => offered());

  handle("recovery:write", async (_e, request) => {
    const r = (typeof request === "object" && request !== null ? request : {}) as Partial<{ id: unknown; title: unknown; path: unknown; data: unknown }>;
    if (!isRecoveryId(r.id)) throw new Error("invalid recovery id");
    const title = typeof r.title === "string" ? r.title.slice(0, 200) : "untitled";
    // Record the document's path only if this session may write it: restoring grants it again.
    const path = typeof r.path === "string" && deps.grants.has(r.path, "write") ? r.path : null;
    await deps.recovery.write({ id: r.id, title, path, data: bytesOf(r.data, "data") });
  });

  handle("recovery:read", async (_e, id) => {
    if (!isRecoveryId(id)) throw new Error("invalid recovery id");
    const meta = deps.recovery.get(id);
    if (!meta) throw new Error("that recovered document is no longer available");
    // The snapshot's own document (recorded only while writable, see recovery:write) may be saved to again.
    if (meta.path) deps.grants.grant(meta.path, ["read", "write"], "session");
    return deps.recovery.read(id);
  });

  handle("recovery:discard", async (_e, id) => {
    if (!isRecoveryId(id)) throw new Error("invalid recovery id");
    await deps.recovery.discard(id);
  });

  // ─── Windows ────────────────────────────────────────────────────────────────────────────
  handle("window:startup", (e) => deps.windows.takeStartup(e.sender.id));

  handle("window:openDocument", (e, path, options) => {
    const p = str(path, "path");
    // Only a path the user chose (or double-clicked) can be opened in another window.
    deps.grants.check(p, "read");
    const allowHere = (options as { allowHere?: unknown } | undefined)?.allowHere === true;
    return { placement: deps.windows.openDocument(e.sender.id, p, allowHere) };
  });

  handle("window:new", (_e, options) => {
    deps.windows.newWindow(command((options as { command?: unknown } | undefined)?.command));
  });

  handle("window:close", (e) => deps.windows.close(e.sender.id));

  on("window:docInfo", (e, info) => {
    const i = (typeof info === "object" && info !== null ? info : {}) as Partial<WindowDocInfo>;
    if (typeof i.pristine !== "boolean" || !isRecoveryId(i.recoveryId)) return;
    deps.windows.setDocInfo(e.sender.id, { pristine: i.pristine, recoveryId: i.recoveryId });
  });

  on("window:saveFinished", (e, requestId, saved) => {
    if (typeof requestId !== "string" || requestId.length > 64) return;
    deps.windows.saveFinished(e.sender.id, requestId, saved === true);
  });
}
