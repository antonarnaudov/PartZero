/**
 * aicad desktop shell (Electron main process).
 *
 * - Renderer: sandboxed, context-isolated, no Node; talks to us only through the typed preload
 *   bridge (`preload.cts` ↔ `ipc.ts`).
 * - Content: the built `@aicad/app` served from `app://aicad/` with COOP/COEP (cross-origin
 *   isolation for SharedArrayBuffer / WASM threads) and a strict CSP; in dev, the Vite server
 *   (`AICAD_DEV_URL`, same headers from vite.config.ts).
 * - Native menu → command layer; window state and recent files persist in userData.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, safeStorage, screen, session, shell, utilityProcess } from "electron";
import type { AgentEvent, AppInfo, DocumentStateMessage, MenuCommandMessage } from "@aicad/app/bridge";
import type { WorkerHandle } from "./agent/host.js";
import { sanitizedEnv, type Cipher } from "./agent/keys.js";
import { scrubKeyLike } from "./agent/protocol.js";
import { setupAgent, type AgentSetup } from "./agent/setup.js";
import { PathGrants, RecentFiles } from "./files.js";
import { findRepoRoot, forgeInfo, locateForgeBinary } from "./forge-cli.js";
import { registerIpc } from "./ipc.js";
import { buildMenuTemplate } from "./menu.js";
import { APP_ENTRY_URL, APP_ORIGIN } from "./protocol-core.js";
import { registerAppScheme, serveApp } from "./protocol.js";
import { loadWindowState, MIN_SIZE, saveWindowState, type WindowState } from "./window-state.js";

const here = dirname(fileURLToPath(import.meta.url));
const devUrl = process.env["AICAD_DEV_URL"];
const isDev = !app.isPackaged;

if (process.env["AICAD_USER_DATA_DIR"]) app.setPath("userData", process.env["AICAD_USER_DATA_DIR"]);
app.setName("aicad");
registerAppScheme();

/** The built web app: packaged resources, `$AICAD_APP_DIST`, or `@aicad/app/dist/web` in the workspace. */
function resolveWebRoot(): string {
  const override = process.env["AICAD_APP_DIST"];
  if (override) return override;
  if (app.isPackaged) return join(process.resourcesPath, "app-web");
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@aicad/app/package.json")), "dist", "web");
}

function isTrustedSender(frameUrl: string | undefined): boolean {
  if (!frameUrl) return false;
  if (frameUrl.startsWith(`${APP_ORIGIN}/`)) return true;
  return !!devUrl && frameUrl.startsWith(devUrl);
}

let mainWindow: BrowserWindow | null = null;
let docState: DocumentStateMessage = { title: "untitled", path: null, dirty: false };
const grants = new PathGrants();
let recent: RecentFiles;
let agent: AgentSetup | null = null;

/** Electron `safeStorage` (OS keychain) as the key store's cipher. */
const safeStorageCipher: Cipher = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plain) => safeStorage.encryptString(plain),
  decryptString: (encrypted) => safeStorage.decryptString(encrypted),
  backend: () =>
    process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : process.platform === "darwin" ? "macOS Keychain" : "Windows DPAPI",
};

/** Fork the agent utility process (see agent/worker.ts for why it is not the main process). */
function spawnAgentWorker(): WorkerHandle {
  const child = utilityProcess.fork(join(here, "agent", "worker.js"), [], {
    serviceName: "aicad-agent",
    env: sanitizedEnv(process.env),
    stdio: "pipe",
  });
  const forward = (stream: NodeJS.ReadableStream | null, level: "log" | "error"): void => {
    stream?.on("data", (d: Buffer) => {
      for (const line of d.toString("utf8").split("\n")) if (line.trim()) console[level](`[aicad-agent] ${scrubKeyLike(line)}`);
    });
  };
  forward(child.stdout, "log");
  forward(child.stderr, "error");
  return {
    postMessage: (m) => child.postMessage(m),
    kill: () => child.kill(),
    onMessage: (l) => child.on("message", l),
    onExit: (l) => child.on("exit", l),
  };
}

function sendAgentEvent(event: AgentEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("agent:event", event);
}

function sendMenuCommand(message: MenuCommandMessage): void {
  mainWindow?.webContents.send("menu:command", message);
}

function rebuildMenu(): void {
  const template = buildMenuTemplate({
    send: sendMenuCommand,
    recentFiles: recent.list(),
    platform: process.platform,
    appName: "aicad",
    isDev,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (process.platform === "darwin") {
    app.clearRecentDocuments();
    for (const p of recent.list()) app.addRecentDocument(p);
  }
}

function createWindow(): BrowserWindow {
  const stateFile = join(app.getPath("userData"), "window-state.json");
  const workAreas = screen.getAllDisplays().map((d) => d.workArea);
  const saved = loadWindowState(stateFile, workAreas);
  const win = new BrowserWindow({
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    width: saved.width,
    height: saved.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: "aicad",
    backgroundColor: "#141619",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 13 } } : {}),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  if (saved.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());

  // Persist bounds (debounced) and on close.
  let timer: NodeJS.Timeout | undefined;
  const snapshot = (): WindowState => {
    const b = win.getNormalBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
  };
  const persistSoon = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => saveWindowState(stateFile, snapshot()), 400);
  };
  win.on("resize", persistSoon);
  win.on("move", persistSoon);
  win.on("maximize", persistSoon);
  win.on("unmaximize", persistSoon);

  win.on("close", (event) => {
    clearTimeout(timer);
    saveWindowState(stateFile, snapshot());
    if (docState.dirty && !process.env["AICAD_SKIP_CLOSE_PROMPT"]) {
      const choice = dialog.showMessageBoxSync(win, {
        type: "warning",
        buttons: ["Discard Changes", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: `Discard unsaved changes to “${docState.title}”?`,
        detail: "Your changes will be lost if you close the window.",
      });
      if (choice !== 0) event.preventDefault();
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    agent?.host.stopAll();
  });

  // No new windows, no navigation away from the app; external links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedSender(url)) event.preventDefault();
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    agent?.host.stopAll();
    console.error(`[aicad] renderer process gone: ${details.reason} (exit code ${details.exitCode})`);
  });
  win.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`[aicad] failed to load ${url}: ${description} (${code})`);
  });

  void win.loadURL(devUrl ?? APP_ENTRY_URL);
  return win;
}

async function appInfo(forgeBin: string): Promise<AppInfo> {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    isDev,
    forgeCli: await forgeInfo(forgeBin),
  };
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    // Deny every permission request (camera, notifications, …): the app needs none.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    serveApp(resolveWebRoot());
    recent = new RecentFiles(join(app.getPath("userData"), "recent-files.json"));
    for (const p of recent.list()) grants.grant(p);

    const forgeBin = locateForgeBinary({ env: process.env, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
    agent = setupAgent({
      userData: app.getPath("userData"),
      env: process.env,
      isPackaged: app.isPackaged,
      repoRoot: app.isPackaged ? null : findRepoRoot(app.getAppPath()),
      forgeBin,
      cipher: safeStorageCipher,
      spawnWorker: spawnAgentWorker,
      send: sendAgentEvent,
      log: (level, message) => console[level === "info" ? "log" : level](`[aicad-agent] ${message}`),
    });
    registerIpc({
      agent,
      window: () => mainWindow,
      isTrustedSender,
      grants,
      recent,
      forgeBin,
      appInfo: () => appInfo(forgeBin),
      onRecentChanged: () => {
        for (const p of recent.list()) grants.grant(p);
        rebuildMenu();
      },
      onDocState: (state) => {
        docState = state;
        if (!mainWindow) return;
        mainWindow.setTitle(`${state.title}${state.dirty ? " •" : ""} — aicad`);
        if (process.platform === "darwin") {
          mainWindow.setDocumentEdited(state.dirty);
          mainWindow.setRepresentedFilename(state.path ?? "");
        }
      },
    });

    rebuildMenu();
    mainWindow = createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on("will-quit", () => agent?.host.dispose());

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
