/**
 * aicad desktop shell (Electron main process); packaged for Alpha 0 as PartZero.app (docs/ALPHA-0-PLAN.md W1).
 *
 * - Renderer: sandboxed, context-isolated, no Node; talks to us only through the typed preload
 *   bridge (`preload.cts` ↔ `ipc.ts`).
 * - Content: the built `@aicad/app` served from `app://aicad/` with COOP/COEP (cross-origin
 *   isolation for SharedArrayBuffer / WASM threads) and a strict CSP; in dev, the Vite server
 *   (`AICAD_DEV_URL`, loopback only, same headers from vite.config.ts).
 * - Native menu → command layer; window state and recent files persist in userData.
 * - Documents (windows.ts, ipc/files.ts, recovery.ts): one document per window, several windows, `.partzero` files
 *   opened from the Finder (`open-file`) or the command line, atomic saves, the Save / Don't Save / Cancel prompt on
 *   close and quit, and autosave snapshots offered for recovery after a crash.
 * - Packaged builds ignore every `AICAD_*` override (env.ts), have no DevTools and no renderer
 *   automation API, and refuse to start with a debugger switch such as `--remote-debugging-port`
 *   (debug-switches.ts); child processes get allowlisted environments.
 * - A bundled build (`scripts/bundle.mjs`) carries `build-info.json` next to this file: the product name (and with it
 *   the profile folder `~/Library/Application Support/<name>` and the log folder `~/Library/Logs/<name>`), the commit
 *   and the edition's flags (API keys, the MCP shim). It writes `main.log` and `agent.log` there.
 * - `--self-test` (self-test.ts): start hidden on a throwaway profile, check the bundle, print a JSON report, exit.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, safeStorage, screen, session, shell, utilityProcess } from "electron";
import type { AgentEvent, AgentOpsRequest, AppInfo, MenuCommandMessage } from "@aicad/app/bridge";
import type { WorkerHandle } from "./agent/host.js";
import { applyDevDockIcon } from "./app-icon.js";
import type { Cipher } from "./agent/keys.js";
import { parseWorkerMessage, PROTOCOL_VERSION, scrubKeyLike } from "./agent/protocol.js";
import { setupAgent, workspaceMcpServerDir, type AgentSetup } from "./agent/setup.js";
import { DEV_BUILD_INFO, loginShellProviders, mcpShimExecutable, readBuildInfo, type BuildInfo } from "./build-info.js";
import { bundledMcpShimPath } from "./bundle-paths.js";
import { debugSwitchRefusal, forbiddenDebugSwitches } from "./debug-switches.js";
import { agentWorkerEnv, cliChildHostEnv, cliDetectEnv, readDevOverrides, resolveWebRoot, withLoginNames } from "./env.js";
import { canonicalPath, documentPathsFromArgv, documentStatePath, PathGrants, RecentFiles, ThumbnailCache, type FaultHook } from "./files.js";
import { findRepoRoot, forgeInfo, forgeSelfCheck, locateForgeBinary } from "./forge-cli.js";
import { registerIpc } from "./ipc.js";
import { registerFileIpc } from "./ipc/files.js";
import { RecoveryStore } from "./recovery.js";
import { DocumentWindows, type CloseAnswer } from "./windows.js";
import { formatConsoleArgs, logFor, RotatingLog, type LogLevel } from "./log-file.js";
import { buildMenuTemplate } from "./menu.js";
import { agentConventionsLine, ProfileStore } from "./profiles.js";
import { APP_ENTRY_URL, isTrustedFrameUrl } from "./protocol-core.js";
import { registerAppScheme, serveApp } from "./protocol.js";
import {
  abortedSelfTestReport,
  claudeCodeCheck,
  describeRenderer,
  detectBambuStudio,
  RENDERER_PROBE,
  rendererReady,
  reportPaths,
  SELF_TEST_EXIT,
  SELF_TEST_IR,
  SELF_TEST_SCHEMA,
  SELF_TEST_SWITCH,
  SELF_TEST_TIMEOUT_MS,
  selfTestVerdict,
  type RendererSnapshot,
  type SelfTestReport,
} from "./self-test.js";
import { defaultSlicerSystem, type SlicerSystem } from "./slicer.js";
import { userFolders } from "./user-folders.js";
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
/** `--self-test`: a hidden, read-only run that prints a report and exits (self-test.ts). */
const selfTest = process.argv.slice(1).includes(SELF_TEST_SWITCH);

/** The bundle's `build-info.json` (development: none, today's behavior); an invalid one stops the app at startup. */
let buildInfo: BuildInfo = DEV_BUILD_INFO;
let buildInfoError: string | null = null;
try {
  buildInfo = readBuildInfo(here);
} catch (e) {
  buildInfoError = e instanceof Error ? e.message : String(e);
}
const productName = buildInfo.productName;

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

const grants = new PathGrants();
let recent: RecentFiles;
let agent: AgentSetup | null = null;
/** Every document window (one document each). Created in `start()`. */
let windows: DocumentWindows<BrowserWindow>;
/** The window whose agent run is current (agent events go there); null: the current window. */
let agentContentsId: number | null = null;
/** The recovery store (autosaves); null until the app is ready, and in a `--self-test` run. */
let recovery: RecoveryStore | null = null;
/** Documents the OS asked to open before the app was ready (`open-file`, argv). */
const pendingOsOpens: string[] = [];
let appReady = false;
/**
 * Test-only (unpackaged runs), set through Playwright's `app.evaluate`: `globalThis.__pzFaults` (a Set of fault
 * points) makes the next save fail at that point, once (FULL-MODELING-PLAN C7); `globalThis.__pzHold` holds the next
 * save at `point` (setting `reached`) until the test resolves `release`.
 */
const faultHook: FaultHook | undefined = isDev
  ? (point) => {
      const g = globalThis as { __pzFaults?: Set<string>; __pzHold?: { point: string; reached: boolean; release: Promise<void> } | undefined };
      if (g.__pzFaults?.has(point)) {
        g.__pzFaults.delete(point);
        throw new Error(`simulated failure at ${point}`);
      }
      const hold = g.__pzHold;
      if (hold?.point !== point) return;
      g.__pzHold = undefined;
      hold.reached = true;
      return hold.release;
    }
  : undefined;
/** The throwaway profile of a `--self-test` run (removed before it exits). */
let selfTestProfile: string | null = null;
/** The real profile a `--self-test` run reports (it only reads its `agent-settings.json`). */
let selfTestRealProfile = "";
/** A `--self-test` run printed its report (exactly one is printed). */
let selfTestFinished = false;
/** Fires {@link SELF_TEST_TIMEOUT_MS} after a `--self-test` run started. */
let selfTestWatchdog: NodeJS.Timeout | null = null;

/** Electron `safeStorage` (OS keychain) as the key store's cipher. */
const safeStorageCipher: Cipher = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plain) => safeStorage.encryptString(plain),
  decryptString: (encrypted) => safeStorage.decryptString(encrypted),
  backend: () =>
    process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : process.platform === "darwin" ? "macOS Keychain" : "Windows DPAPI",
  // On macOS the availability check itself reads (or creates) the "<app> Safe Storage" keychain item (keys.ts).
  probeMayPrompt: process.platform === "darwin",
};

/**
 * A bundled build's log files (log-file.ts): every console line of this process goes to `main.log`, the agent's
 * (`[aicad-agent] …`: the worker's output and the agent host's log) to `agent.log`, scrubbed of key-like strings.
 * Development runs log to the console only; an isolated test profile logs into `<profile>/logs`.
 */
function installLogFiles(dir: string): void {
  const logs = { main: new RotatingLog(join(dir, "main.log")), agent: new RotatingLog(join(dir, "agent.log")) };
  const levels: Array<[keyof Pick<Console, "log" | "info" | "warn" | "error">, LogLevel]> = [
    ["log", "info"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ];
  for (const [method, level] of levels) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]): void => {
      original(...args);
      const line = formatConsoleArgs(args);
      logs[logFor(line)].write(level, line);
    };
  }
  console.log(`[aicad] ${productName} ${buildInfo.version} (${buildInfo.edition}, ${buildInfo.commit ?? "no commit"}${buildInfo.dirty ? ", dirty" : ""}) starting; Electron ${process.versions.electron}, ${process.platform} ${process.arch}`);
}

/** Fork the agent utility process (see agent/worker.ts for why it is not the main process). */
function spawnAgentWorker(): WorkerHandle {
  const child = utilityProcess.fork(join(here, "agent", "worker.js"), [], {
    serviceName: "aicad-agent",
    // USER/LOGNAME filled when the app was started without them: the worker's CLI children inherit them.
    env: agentWorkerEnv(withLoginNames(process.env)),
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

/** Agent events go to the window that started the run (one agent host serves every window). */
function sendAgentEvent(event: AgentEvent): void {
  const target = (agentContentsId !== null ? windows.windowOf(agentContentsId) : null) ?? windows.current();
  if (target && !target.isDestroyed()) target.webContents.send("agent:event", event);
}

/** The live operator's ops go to the window that started the run, and only there (it holds the document). */
function sendAgentOps(request: AgentOpsRequest): void {
  const target = agentContentsId !== null ? windows.windowOf(agentContentsId) : null;
  if (target && !target.isDestroyed()) target.webContents.send("agent:ops", request);
}

function sendMenuCommand(message: MenuCommandMessage): void {
  windows.sendCommand(message);
}

/** The unsaved-changes prompt on close and quit. */
async function askToSave(win: BrowserWindow, title: string): Promise<CloseAnswer> {
  const r = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Save", "Don't Save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    message: `Do you want to save the changes you made to “${title}”?`,
    detail: "Your changes will be lost if you don't save them.",
  });
  return r.response === 0 ? "save" : r.response === 1 ? "discard" : "cancel";
}

/** A document the OS asked to open: granted like a document chosen in the open dialog, then opened in a window. */
function openFromOs(path: string): void {
  try {
    grants.grantOpened(path);
  } catch {
    return;
  }
  if (!appReady) {
    if (!pendingOsOpens.includes(path)) pendingOsOpens.push(path);
    return;
  }
  windows.openFromOs(path);
}

function rebuildMenu(): void {
  const template = buildMenuTemplate({
    send: sendMenuCommand,
    recentFiles: recent.list(),
    platform: process.platform,
    appName: productName,
    isDev,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (process.platform === "darwin") {
    app.clearRecentDocuments();
    for (const p of recent.list()) app.addRecentDocument(p);
  }
}

/**
 * Create a document window (the `create` of {@link DocumentWindows}). The first window takes the saved bounds; later
 * ones cascade from the current window (`bounds`).
 */
function createWindow(options: { hidden?: boolean; bounds?: { x: number; y: number; width: number; height: number } | null } = {}): BrowserWindow {
  const stateFile = join(app.getPath("userData"), "window-state.json");
  const workAreas = screen.getAllDisplays().map((d) => d.workArea);
  const saved = loadWindowState(stateFile, workAreas);
  const b = options.bounds ?? null;
  const win = new BrowserWindow({
    ...(b ? { x: b.x, y: b.y } : saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    width: b?.width ?? saved.width,
    height: b?.height ?? saved.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: productName,
    backgroundColor: "#141619",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 13 } } : {}),
    // A hidden self-test window must not be throttled like a background one while it loads and evaluates.
    webPreferences: { ...mainWindowWebPreferences(join(here, "preload.cjs"), isDev), ...(options.hidden ? { backgroundThrottling: false } : {}) },
  });
  if (saved.maximized && !options.hidden && !b) win.maximize();
  if (!options.hidden) win.once("ready-to-show", () => win.show());

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
  if (!options.hidden) {
    win.on("resize", persistSoon);
    win.on("move", persistSoon);
    win.on("maximize", persistSoon);
    win.on("unmaximize", persistSoon);
  }

  win.on("close", (event) => {
    clearTimeout(timer);
    if (options.hidden) return;
    saveWindowState(stateFile, snapshot());
    // Unsaved changes: Save / Don't Save / Cancel (windows.ts); the window closes itself once answered.
    if (!windows.onClose(win)) event.preventDefault();
  });
  win.on("focus", () => windows.focused(win));
  const contentsId = win.webContents.id;
  win.on("closed", () => {
    windows.closed(win);
    // The agent's runs belong to the window that started them.
    if (agentContentsId === contentsId) {
      agentContentsId = null;
      agent?.host.stopAll();
    }
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
    if (agentContentsId === contentsId) agent?.host.stopAll();
    console.error(`[aicad] renderer process gone: ${details.reason} (exit code ${details.exitCode})`);
    // Crash recovery inside the session: reload the window and offer its last autosave.
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    const id = windows.recoveryIdOf(win);
    const snapshot = id ? (recovery?.get(id) ?? null) : null;
    if (windows.rendererGone(win, snapshot)) win.webContents.reload();
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
    build: { edition: buildInfo.edition, commit: buildInfo.commit, dirty: buildInfo.dirty, builtAt: buildInfo.builtAt },
  };
}

/** The MCP shim a bundled build ships (`bundle/mcp/stdio.mjs`), else development's workspace package (setup.ts). */
const mcpShimPath = bundledMcpShimPath(here);

function start(): void {
  app.setName(productName);
  // The profile folder follows the product name (PartZero: ~/Library/Application Support/PartZero), set explicitly
  // rather than left to Electron's startup default, which is taken from package.json before `setName` runs.
  const profile = overrides.userDataDir ?? join(app.getPath("appData"), productName);
  if (selfTest) {
    // A throwaway profile: the real one may be in use by a running instance, and a self-test must not change it. Its
    // Settings files (a Claude Code path set there, lockdown blocks; the printer profile and a Bambu Studio path set in
    // Settings > Printing) are copied, so detection sees what the app sees.
    selfTestRealProfile = profile;
    selfTestProfile = mkdtempSync(join(tmpdir(), "partzero-self-test-"));
    for (const name of ["agent-settings.json", "machine-profiles.json"]) {
      const settings = join(profile, name);
      if (existsSync(settings)) copyFileSync(settings, join(selfTestProfile, name));
    }
    app.setPath("userData", selfTestProfile);
  } else {
    app.setPath("userData", profile);
  }
  if (!selfTest && buildInfo.edition !== "dev") {
    // ~/Library/Logs/<productName> (an isolated test profile: <profile>/logs). Development logs to the console only.
    app.setAppLogsPath(overrides.userDataDir ? join(overrides.userDataDir, "logs") : undefined);
    installLogFiles(app.getPath("logs"));
  }
  registerAppScheme();

  if (!selfTest && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  windows = new DocumentWindows<BrowserWindow>({
    create: (o) => createWindow({ hidden: o.hidden, bounds: o.bounds }),
    productName,
    platform: process.platform,
    askToSave,
    skipClosePrompt: overrides.skipClosePrompt,
    discardRecovery: (id) => recovery?.discard(id) ?? Promise.resolve(),
    canonicalPath,
    setRepresented: (win, path, dirty) => {
      if (process.platform !== "darwin") return;
      win.setDocumentEdited(dirty);
      // ipc.ts already dropped an ungranted path; checked again because this is the sink.
      win.setRepresentedFilename(documentStatePath(path, grants) ?? "");
    },
    requestQuit: () => setImmediate(() => app.quit()),
    workArea: (bounds) => screen.getDisplayMatching(bounds).workArea,
    log: (m) => console.warn(`[aicad] ${m}`),
  });
  // A second launch (Windows, Linux: double-clicking a document) hands its documents to this instance.
  app.on("second-instance", (_event, argv, cwd) => {
    const docs = documentPathsFromArgv(argv.slice(1), cwd);
    for (const p of docs) openFromOs(p);
    if (docs.length > 0 || !appReady) return;
    const cur = windows.current();
    if (cur) {
      if (cur.isMinimized()) cur.restore();
      cur.focus();
    } else {
      windows.open();
    }
  });
  // macOS: a document double-clicked in the Finder or dropped on the Dock icon (may arrive before `ready`).
  app.on("open-file", (event, path) => {
    event.preventDefault();
    openFromOs(path);
  });
  if (!selfTest) for (const p of documentPathsFromArgv(process.argv.slice(app.isPackaged ? 1 : 2))) openFromOs(p);
  app.on("before-quit", () => {
    windows.quitting = true;
  });

  void app.whenReady().then(() => {
    if (selfTest) app.dock?.hide();
    else applyDevDockIcon(app, here);
    // The self-test's watchdog fired before the app got ready: its report is out and the app is exiting.
    if (selfTestFinished) return;
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
    const repoRoot = app.isPackaged ? null : findRepoRoot(app.getAppPath());
    // The MCP shim for CLI agents runs as `ELECTRON_RUN_AS_NODE=1 <app> <shim>`: always in development; in a packaged
    // build only when its edition keeps the runAsNode fuse on for it (build-info.ts, decision D1).
    const shimExe = mcpShimExecutable(buildInfo, app.isPackaged, app.getPath("exe"));
    agent = setupAgent({
      userData: app.getPath("userData"),
      env: process.env,
      isPackaged: app.isPackaged,
      repoRoot,
      forgeBin,
      cipher: safeStorageCipher,
      spawnWorker: spawnAgentWorker,
      send: sendAgentEvent,
      sendOps: sendAgentOps,
      log: (level, message) => console[level === "info" ? "log" : level](`[aicad-agent] ${message}`),
      detectEnv: cliDetectEnv(withLoginNames(process.env)),
      // An isolated test profile never sees the user's real CLIs or local Ollama unless the test opts in (env.ts).
      cliDirs: overrides.cliDirs,
      // The login-shell lookup runs the user's shell startup files with this app held responsible by macOS privacy
      // controls: the Alpha 0 build runs it for Claude Code only (build-info.ts `flags.loginShell`).
      loginShellProviders: loginShellProviders(buildInfo),
      detectLocalModels: overrides.detectLocalModels && !selfTest,
      // CLI login locations and proxy/CA settings go to CLI children only, never into the worker's own environment.
      cliChildEnv: cliChildHostEnv(process.env),
      // Test profiles run `auto` as completion unless the test opts into runtime mode (env.ts).
      cliAutoMode: overrides.cliAutoMode,
      exePath: shimExe,
      mcpShimPath,
      apiKeys: buildInfo.flags.apiKeys,
    });
    // The printer profile behind "Open in Bambu Studio" also sets every agent run's defaults (ALPHA-0-PLAN W5):
    // FDM, and the machine, material and clearance line, read at each start.
    const printProfiles = new ProfileStore(join(app.getPath("userData"), "machine-profiles.json"), (m) => console.warn(`[aicad] ${m}`));
    agent.host.setRunDefaults(() => ({ process: "fdm", conventions: agentConventionsLine(printProfiles.printer(), printProfiles.material()) }));
    // A test profile searches only its own folders and never launches the user's real Bambu Studio (env.ts).
    const printSlicer = defaultSlicerSystem({ searchDirs: overrides.slicerDirs, openBin: overrides.openBin });
    if (!selfTest) {
      // Warm the provider detection (CLI versions, lockdown, logins, Ollama; no model call) in the background, so
      // Settings and the first run do not wait for it.
      const warm = setTimeout(() => void agent?.host.settingsView().catch((e: unknown) => console.warn(`[aicad-agent] provider detection failed: ${e instanceof Error ? e.message : String(e)}`)), 1500);
      warm.unref();
    }
    registerIpc({
      agent,
      // "Open in Bambu Studio" (print-handoff.ts): prints go to ~/PartZero/Prints (ALPHA-0-PLAN D4), created on first
      // export (user-folders.ts), never at startup.
      print: {
        forgeBin,
        printsDir: overrides.printsDir ?? userFolders(app.getPath("home")).prints,
        appVersion: app.getVersion(),
        profiles: printProfiles,
        slicer: printSlicer,
        revealInFolder: (path) => shell.showItemInFolder(path),
      },
      // Dialogs belong to the current window.
      window: () => windows.current(),
      isTrustedSender,
      grants,
      recent,
      forgeBin,
      appInfo: () => appInfo(forgeBin),
      onRecentChanged: () => rebuildMenu(),
      onDocState: (state, senderId) => windows.setDocState(senderId, state),
      onAgentStart: (senderId) => {
        agentContentsId = senderId;
      },
      isAgentWindow: (senderId) => agentContentsId === senderId,
    });

    // Documents: autosaves and what a crash left behind, thumbnails for the recent grid, the window protocol.
    recovery = new RecoveryStore(join(app.getPath("userData"), "Recovery"));
    const session0 = selfTest ? { uncleanExit: false, entries: [] } : recovery.beginSession();
    if (session0.uncleanExit) console.warn(`[aicad] the previous session did not quit cleanly; ${session0.entries.length} unsaved document(s) to recover`);
    registerFileIpc({
      isTrustedSender,
      grants,
      recent,
      thumbnails: new ThumbnailCache(join(app.getPath("userData"), "Thumbnails")),
      recovery,
      onRecentChanged: () => rebuildMenu(),
      ...(faultHook ? { fault: faultHook } : {}),
      windows: {
        takeStartup: (id) => windows.takeStartup(id),
        openDocument: (id, path, allowHere) => windows.openDocument(id, path, allowHere),
        newWindow: (command) => void windows.open(command ? { command } : {}),
        close: (id) => windows.windowOf(id)?.close(),
        setDocInfo: (id, info) => windows.setDocInfo(id, info),
        saveFinished: (id, requestId, saved) => windows.saveFinished(id, requestId, saved),
        liveRecoveryIds: () => windows.liveRecoveryIds(),
      },
    });

    rebuildMenu();
    if (selfTest) {
      const win = windows.open({}, { hidden: true });
      runSelfTest(win, forgeBin, { mcpShimPath, mcpServerDir: mcpShimPath ? null : workspaceMcpServerDir(repoRoot), exePath: shimExe, workspaceRoot: agent.workspaceRoot }, { system: printSlicer, customPath: printProfiles.read().slicerPath }).catch((e: unknown) =>
        abortSelfTest(`the self-test failed: ${message(e)}`, SELF_TEST_EXIT.failed),
      );
      return;
    }

    // The first window offers what the last session left unsaved; documents the OS asked for open in windows of
    // their own (the first one in the first window).
    appReady = true;
    const [first, ...more] = pendingOsOpens.splice(0);
    windows.open({ open: first ?? null, recovery: session0.entries, uncleanExit: session0.uncleanExit });
    for (const p of more) windows.open({ open: p });

    app.on("activate", () => {
      if (windows.count() === 0) windows.open();
    });
  });

  app.on("will-quit", () => {
    agent?.host.dispose();
    // Every window closed (saved or discarded): a clean end of the session.
    if (!selfTest) recovery?.endSession();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

// ─── --self-test ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * The hidden window loads the app and evaluates its starting document with the renderer's engine (any starting
 * document: today a v0 block, empty once W2 lands; `rendererReady`).
 */
async function probeRenderer(win: BrowserWindow, timeoutMs: number): Promise<SelfTestReport["renderer"]> {
  const t0 = Date.now();
  let last: RendererSnapshot | null = null;
  let error: string | null = null;
  while (Date.now() - t0 < timeoutMs) {
    if (win.isDestroyed()) {
      error = "the window closed";
      break;
    }
    try {
      last = (await win.webContents.executeJavaScript(RENDERER_PROBE, true)) as RendererSnapshot;
      error = null;
    } catch (e) {
      error = message(e);
    }
    if (rendererReady(last)) return { ok: true, detail: `evaluated: ${describeRenderer(last)}`, ms: Date.now() - t0, snapshot: last };
    await sleep(250);
  }
  return { ok: false, detail: error ?? `the starting document was not evaluated within ${timeoutMs / 1000} s; last seen: ${describeRenderer(last)}`, ms: null, snapshot: last };
}

/** What the worker's self-test gets: the MCP shim and server, and what a CLI run gets to run the shim with. */
interface WorkerProbeOptions {
  mcpShimPath: string | null;
  mcpServerDir: string | null;
  exePath: string | null;
  workspaceRoot: string | null;
}

/** A fresh agent worker starts, then checks its bundle (agent/self-test.ts) and answers. */
function probeWorker(o: WorkerProbeOptions, timeoutMs: number): Promise<SelfTestReport["worker"]> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let readyMs: number | null = null;
    let done = false;
    let w: WorkerHandle | null = null;
    const finish = (r: SelfTestReport["worker"]): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      w?.kill();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: readyMs === null ? `the worker did not start within ${timeoutMs / 1000} s` : `no answer within ${timeoutMs / 1000} s`, readyMs, report: null }), timeoutMs);
    try {
      w = spawnAgentWorker();
    } catch (e) {
      finish({ ok: false, detail: `could not start the worker: ${message(e)}`, readyMs: null, report: null });
      return;
    }
    w.onExit((code) => finish({ ok: false, detail: `the worker exited (code ${code})`, readyMs, report: null }));
    w.onMessage((raw) => {
      const m = parseWorkerMessage(raw);
      if (m?.type === "ready") {
        readyMs = Date.now() - t0;
        w?.postMessage({ type: "selftest", v: PROTOCOL_VERSION, ...o });
      } else if (m?.type === "selftest") {
        finish({ ok: true, detail: `ready in ${readyMs ?? "?"} ms`, readyMs, report: m.report });
      }
    });
  });
}

/** The app half of the report (the same in a finished and an aborted report). */
function selfTestAppInfo(): SelfTestReport["app"] {
  return {
    name: app.getName(),
    version: app.getVersion(),
    edition: buildInfo.edition,
    commit: buildInfo.commit,
    dirty: buildInfo.dirty,
    builtAt: buildInfo.builtAt,
    packaged: app.isPackaged,
    flags: buildInfo.flags,
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
}

function selfTestPaths(): SelfTestReport["paths"] {
  const logs = overrides.userDataDir ? join(overrides.userDataDir, "logs") : join(app.getPath("home"), "Library", "Logs", productName);
  return reportPaths({ profile: selfTestRealProfile, logs });
}

async function runSelfTest(win: BrowserWindow, forgeBin: string, worker: WorkerProbeOptions, slicerLookup: { system: SlicerSystem; customPath: string | null }): Promise<void> {
  const setup = agent!;
  const [renderer, workerCheck, forgeCli, claudeCode, slicer] = await Promise.all([
    probeRenderer(win, 120_000),
    probeWorker(worker, 120_000),
    forgeSelfCheck(forgeBin, JSON.stringify(SELF_TEST_IR)).catch((e: unknown) => ({ ok: false, path: forgeBin, version: null, detail: message(e), v0: null, v1: null })),
    setup.host.settingsView().then(
      (view) => claudeCodeCheck(view),
      (e: unknown) => claudeCodeCheck(null, `detection failed: ${message(e)}`),
    ),
    // The same detection as Open in Bambu Studio (slicer.ts), with the path set in Settings > Printing.
    detectBambuStudio(slicerLookup).catch((e: unknown) => ({ found: false, name: "Bambu Studio" as const, path: null, bundleId: null, version: null, reason: `detection failed: ${message(e)}` })),
  ]);
  const body: Omit<SelfTestReport, "ok" | "failures" | "warnings" | "schema"> = {
    app: selfTestAppInfo(),
    paths: selfTestPaths(),
    forgeCli,
    worker: workerCheck,
    renderer,
    claudeCode,
    slicer,
  };
  const verdict = selfTestVerdict(body);
  finishSelfTest({ schema: SELF_TEST_SCHEMA, ...verdict, ...body }, verdict.ok ? SELF_TEST_EXIT.ok : SELF_TEST_EXIT.failed);
}

/** The self-test could not finish (it threw, or the watchdog fired): a failing report instead of a hidden app that never exits. */
function abortSelfTest(reason: string, code: number): void {
  let paths: SelfTestReport["paths"];
  try {
    paths = selfTestPaths();
  } catch {
    paths = { profile: selfTestRealProfile, logs: "", prints: "", reports: "" };
  }
  finishSelfTest(abortedSelfTestReport(reason, selfTestAppInfo(), paths), code);
}

/**
 * Print the report (stdout carries nothing else) and exit, exactly once. Stops the agent host, closes the hidden
 * window and removes the throwaway profile. If stdout cannot be flushed (a reader that stopped reading), it exits
 * anyway after 5 s.
 */
function finishSelfTest(report: SelfTestReport, code: number): void {
  if (selfTestFinished) return;
  selfTestFinished = true;
  if (selfTestWatchdog !== null) clearTimeout(selfTestWatchdog);
  try {
    agent?.host.dispose();
  } catch {
    // exiting anyway
  }
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy();
  let exited = false;
  const exit = (): void => {
    if (exited) return;
    exited = true;
    if (selfTestProfile !== null) removeAfterExit(selfTestProfile);
    app.exit(code);
  };
  setTimeout(exit, 5_000);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, exit);
}

/**
 * Remove the throwaway profile once this process is gone: Chromium writes into its profile while it shuts down
 * (`Local State`, session storage), after any code of ours could delete it, and a helper process that was still
 * starting (an early watchdog exit) can create it again just after. A detached `/bin/sh` waits for this pid to exit,
 * removes the folder, and removes it once more 2 s later; the path travels as an argument, never inside the script text.
 */
function removeAfterExit(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  if (process.platform === "win32") return;
  try {
    const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; rm -rf -- "$2"; sleep 2; rm -rf -- "$2"';
    spawn("/bin/sh", ["-c", script, "partzero-self-test-cleanup", String(process.pid), dir], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // best effort: the folder is in the per-user temp dir, which macOS cleans up
  }
}

if (buildInfoError !== null) {
  console.error(`[aicad] refusing to start: ${buildInfoError}`);
  app.exit(1);
} else if (refusedSwitches.length > 0) {
  // Before any window, IPC handler, agent or protocol exists.
  console.error(`[aicad] ${debugSwitchRefusal(refusedSwitches)}`);
  app.exit(1);
} else {
  if (selfTest) {
    // stdout carries the report only.
    console.log = (...args: unknown[]): void => console.error(...args);
    console.info = console.log;
    // Whatever hangs (the app never gets ready, a probe that ignores its timeout), the run ends with a report.
    const limit = overrides.selfTestTimeoutMs ?? SELF_TEST_TIMEOUT_MS;
    selfTestWatchdog = setTimeout(() => abortSelfTest(`the self-test did not finish within ${limit / 1000} s`, SELF_TEST_EXIT.timedOut), limit);
  }
  start();
}
