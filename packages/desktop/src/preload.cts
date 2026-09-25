/**
 * Preload (sandboxed, CommonJS): exposes exactly the typed `AicadBridge` as `window.aicad`.
 * Only type imports from `@aicad/app/bridge` — a sandboxed preload can require nothing but
 * `electron`.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AgentEvent,
  AicadBridge,
  FilesEvent as FileEvent,
  IpcChannel,
  IpcContract,
  IpcEventContract,
  IpcSendChannel,
  IpcSendContract,
  MenuCommandMessage,
} from "@aicad/app/bridge";

function invoke<C extends IpcChannel>(channel: C, ...args: IpcContract[C]["args"]): Promise<IpcContract[C]["result"]> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcContract[C]["result"]>;
}

function send<C extends IpcSendChannel>(channel: C, ...args: IpcSendContract[C]): void {
  ipcRenderer.send(channel, ...args);
}

const MENU_COMMAND: keyof IpcEventContract = "menu:command";
const AGENT_EVENT: keyof IpcEventContract = "agent:event";
const FILES_EVENT: keyof IpcEventContract = "files:event";

const bridge: AicadBridge = {
  platform: process.platform,
  appInfo: () => invoke("app:info"),
  showOpenDialog: (options) => invoke("dialog:open", options),
  showSaveDialog: (options) => invoke("dialog:save", options),
  readTextFile: (path) => invoke("fs:readText", path),
  writeFile: (path, data) => invoke("fs:write", path, data),
  recentFiles: () => invoke("recent:list"),
  clearRecentFiles: () => invoke("recent:clear"),
  forge: {
    info: () => invoke("forge:info"),
    eval: (request) => invoke("forge:eval", request),
    export: (request) => invoke("forge:export", request),
  },
  setDocumentState: (state) => send("doc:state", state),
  onMenuCommand(listener) {
    const handler = (_event: IpcRendererEvent, message: MenuCommandMessage): void => listener(message);
    ipcRenderer.on(MENU_COMMAND, handler);
    return () => {
      ipcRenderer.removeListener(MENU_COMMAND, handler);
    };
  },
  agent: {
    start: (request) => invoke("agent:start", request),
    answer: (request) => invoke("agent:answer", request),
    stop: (request) => invoke("agent:stop", request),
    onEvent(listener) {
      const handler = (_event: IpcRendererEvent, e: AgentEvent): void => listener(e);
      ipcRenderer.on(AGENT_EVENT, handler);
      return () => {
        ipcRenderer.removeListener(AGENT_EVENT, handler);
      };
    },
  },
  settings: {
    get: () => invoke("settings:get"),
    update: (update) => invoke("settings:update", update),
    setApiKey: (request) => invoke("settings:setApiKey", request),
    clearApiKey: (request) => invoke("settings:clearApiKey", request),
    probeProviders: (request) => invoke("settings:probeProviders", request),
  },
  print: {
    profile: () => invoke("print:profile"),
    detectSlicer: () => invoke("slicer:detect"),
    setSlicerPath: (path) => invoke("slicer:setPath", path),
    openInSlicer: (request) => invoke("slicer:open", request),
    reveal: (path) => invoke("print:reveal", path),
  },
  // Documents and files (packages/desktop/src/ipc/files.ts).
  files: {
    readBytes: (path) => invoke("files:readBytes", path),
    writeDocument: (request) => invoke("files:writeDocument", request),
    recent: () => invoke("files:recent"),
    thumbnail: (path) => invoke("files:thumbnail", path),
    recovery: {
      list: () => invoke("recovery:list"),
      write: (request) => invoke("recovery:write", request),
      read: (id) => invoke("recovery:read", id),
      discard: (id) => invoke("recovery:discard", id),
    },
    window: {
      startup: () => invoke("window:startup"),
      openDocument: (path, options) => invoke("window:openDocument", path, options),
      newWindow: (options) => invoke("window:new", options ?? {}),
      close: () => invoke("window:close"),
      setDocInfo: (info) => send("window:docInfo", info),
      saveFinished: (requestId, saved) => send("window:saveFinished", requestId, saved),
    },
    onEvent(listener) {
      const handler = (_event: IpcRendererEvent, e: FileEvent): void => listener(e);
      ipcRenderer.on(FILES_EVENT, handler);
      return () => {
        ipcRenderer.removeListener(FILES_EVENT, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld("aicad", bridge);
