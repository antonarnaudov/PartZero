/**
 * aicad desktop shell (Electron main process).
 *
 * - Renderer: sandboxed, context-isolated, no Node; talks to us only through the typed preload
 *   bridge (`preload.cts` ↔ `ipc.ts`).
 * - Content: the built `@aicad/app` served from `app://aicad/` with COOP/COEP (cross-origin
 *   isolation for SharedArrayBuffer / WASM threads) and a strict CSP; in dev, the Vite server
 *   (`AICAD_DEV_URL`, loopback only, same headers from vite.config.ts).
 * - Native menu → command layer; window state and recent files persist in userData.
 * - Packaged builds ignore every `AICAD_*` override (env.ts), have no DevTools and no renderer
 *   automation API, and refuse to start with a debugger switch such as `--remote-debugging-port`
 *   (debug-switches.ts); child processes get allowlisted environments.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, safeStorage, screen, session, shell, utilityProcess } from "electron";
import type { AgentEvent, AppInfo, DocumentStateMessage, MenuCommandMessage } from "@aicad/app/bridge";
import type { WorkerHandle } from "./agent/host.js";
import type { Cipher } from "./agent/keys.js";
import { scrubKeyLike } from "./agent/protocol.js";
import { setupAgent, type AgentSetup } from "./agent/setup.js";
import { debugSwitchRefusal, forbiddenDebugSwitches } from "./debug-switches.js";
import { agentWorkerEnv, readDevOverrides, resolveWebRoot } from "./env.js";
import { documentStatePath, PathGrants, RecentFiles } from "./files.js";
import { findRepoRoot, forgeInfo, locateForgeBinary } from "./forge-cli.js";
import { registerIpc } from "./ipc.js";
import { buildMenuTemplate } from "./menu.js";
import { APP_ENTRY_URL, isTrustedFrameUrl } from "./protocol-core.js";
import { registerAppScheme, serveApp } from "./protocol.js";
import { mainWindowWebPreferences } from "./web-preferences.js";
import { loadWindowState, MIN_SIZE, saveWindowState, type WindowState } from "./window-state.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Development and test overrides; a packaged build reads none of them. */
const overrides = readDevOverrides(process.env, app.isPackaged, (m) => console.warn(`[aicad] ${m}`));
/**
 * Unpackaged run: DevTools, Reload and `window.__aicad` (e2e automation). A packaged build has
 * none of them, and neither has an unpackaged run with `AICAD_SIMULATE_PACKAGED=1`.
 */
const isDev = !app.isPackaged && !overrides.simulatePackaged;
const devOrigin = overrides.devServer?.origin ?? null;
/**
 * Debugger switches present on the command line. A packaged build (or a simulated one) refuses to
 * start with any of them; see debug-switches.ts. `AICAD_ALLOW_DEBUGGER=1` (unpackaged only) lets
 * Playwright attach to a simulated packaged run.
 */
const refusedSwitches = isDev || overrides.allowDebugger ? [] : forbiddenDebugSwitches((s) => app.commandLine.hasSwitch(s), process.argv.slice(1));

function webRoot(): string {
  return resolveWebRoot({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    appDistOverride: overrides.appDist,
    workspaceWebRoot: () => join(dirname(createRequire(import.meta.url).resolve("@aicad/app/package.json")), "dist", "web"),
  });
}

function isTrustedSender(frameUrl: string | undefined): boolean {
  return isTrustedFrameUrl(frameUrl, devOrigin);
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
    env: agentWorkerEnv(process.env),
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
    webPreferences: mainWindowWebPreferences(join(here, "preload.cjs"), isDev),
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
    if (docState.dirty && !overrides.skipClosePrompt) {
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

  void win.loadURL(overrides.devServer?.url ?? APP_ENTRY_URL);
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

function start(): void {
  if (overrides.userDataDir) app.setPath("userData", overrides.userDataDir);
  app.setName("aicad");
  registerAppScheme();

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
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

    serveApp(webRoot());
    recent = new RecentFiles(join(app.getPath("userData"), "recent-files.json"));
    // Documents the user opened or saved in earlier sessions (revoked by Clear Recent), unless the
    // path now resolves to another file than the one recorded (e.g. swapped for a symlink).
    for (const e of recent.entries()) {
      if (!grants.grantRecent(e.path, e.real)) console.warn(`[aicad] recent document ${e.path} no longer resolves to the file that was opened; not restoring its access`);
    }

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
      onRecentChanged: () => rebuildMenu(),
      onDocState: (state) => {
        docState = state;
        if (!mainWindow) return;
        mainWindow.setTitle(`${state.title}${state.dirty ? " •" : ""} — aicad`);
        if (process.platform === "darwin") {
          mainWindow.setDocumentEdited(state.dirty);
          // ipc.ts already dropped an ungranted path; checked again because this is the sink.
          mainWindow.setRepresentedFilename(documentStatePath(state.path, grants) ?? "");
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

if (refusedSwitches.length > 0) {
  // Before any window, IPC handler, agent or protocol exists.
  console.error(`[aicad] ${debugSwitchRefusal(refusedSwitches)}`);
  app.exit(1);
} else {
  start();
}
