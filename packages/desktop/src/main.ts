/**
 * aicad desktop shell (Electron main process); packaged for Alpha 0 as PartZero.app (docs/ALPHA-0-PLAN.md W1).
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
import type { AgentEvent, AppInfo, DocumentStateMessage, MenuCommandMessage } from "@aicad/app/bridge";
import type { WorkerHandle } from "./agent/host.js";
import type { Cipher } from "./agent/keys.js";
import { parseWorkerMessage, PROTOCOL_VERSION, scrubKeyLike } from "./agent/protocol.js";
import { setupAgent, workspaceMcpServerDir, type AgentSetup } from "./agent/setup.js";
import { DEV_BUILD_INFO, mcpShimExecutable, readBuildInfo, type BuildInfo } from "./build-info.js";
import { bundledMcpShimPath } from "./bundle-paths.js";
import { debugSwitchRefusal, forbiddenDebugSwitches } from "./debug-switches.js";
import { agentWorkerEnv, cliChildHostEnv, cliDetectEnv, readDevOverrides, resolveWebRoot } from "./env.js";
import { documentStatePath, PathGrants, RecentFiles } from "./files.js";
import { findRepoRoot, forgeInfo, forgeSelfCheck, locateForgeBinary } from "./forge-cli.js";
import { registerIpc } from "./ipc.js";
import { formatConsoleArgs, logFor, RotatingLog, type LogLevel } from "./log-file.js";
import { buildMenuTemplate } from "./menu.js";
import { APP_ENTRY_URL, isTrustedFrameUrl } from "./protocol-core.js";
import { registerAppScheme, serveApp } from "./protocol.js";
import {
  claudeCodeCheck,
  detectBambuStudio,
  RENDERER_PROBE,
  rendererReady,
  reportPaths,
  SELF_TEST_IR,
  SELF_TEST_SCHEMA,
  SELF_TEST_SWITCH,
  selfTestVerdict,
  type RendererSnapshot,
  type SelfTestReport,
} from "./self-test.js";
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

let mainWindow: BrowserWindow | null = null;
let docState: DocumentStateMessage = { title: "untitled", path: null, dirty: false };
const grants = new PathGrants();
let recent: RecentFiles;
let agent: AgentSetup | null = null;
/** The throwaway profile of a `--self-test` run (removed before it exits). */
let selfTestProfile: string | null = null;

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
    appName: productName,
    isDev,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (process.platform === "darwin") {
    app.clearRecentDocuments();
    for (const p of recent.list()) app.addRecentDocument(p);
  }
}

function createWindow(options: { hidden?: boolean } = {}): BrowserWindow {
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
    title: productName,
    backgroundColor: "#141619",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 13 } } : {}),
    // A hidden self-test window must not be throttled like a background one while it loads and evaluates.
    webPreferences: { ...mainWindowWebPreferences(join(here, "preload.cjs"), isDev), ...(options.hidden ? { backgroundThrottling: false } : {}) },
  });
  if (saved.maximized && !options.hidden) win.maximize();
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
    // Settings file (a Claude Code path set there, lockdown blocks) is copied, so detection sees what the app sees.
    selfTestProfile = mkdtempSync(join(tmpdir(), "partzero-self-test-"));
    const settings = join(profile, "agent-settings.json");
    if (existsSync(settings)) copyFileSync(settings, join(selfTestProfile, "agent-settings.json"));
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
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    if (selfTest) app.dock?.hide();
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
    agent = setupAgent({
      userData: app.getPath("userData"),
      env: process.env,
      isPackaged: app.isPackaged,
      repoRoot,
      forgeBin,
      cipher: safeStorageCipher,
      spawnWorker: spawnAgentWorker,
      send: sendAgentEvent,
      log: (level, message) => console[level === "info" ? "log" : level](`[aicad-agent] ${message}`),
      detectEnv: cliDetectEnv(process.env),
      // An isolated test profile never sees the user's real CLIs or local Ollama unless the test opts in (env.ts).
      cliDirs: overrides.cliDirs,
      detectLocalModels: overrides.detectLocalModels && !selfTest,
      // CLI login locations and proxy/CA settings go to CLI children only, never into the worker's own environment.
      cliChildEnv: cliChildHostEnv(process.env),
      // Test profiles run `auto` as completion unless the test opts into runtime mode (env.ts).
      cliAutoMode: overrides.cliAutoMode,
      // The MCP shim for CLI agents runs as `ELECTRON_RUN_AS_NODE=1 <app> <shim>`: always in development; in a
      // packaged build only when its edition keeps the runAsNode fuse on for it (build-info.ts, decision D1).
      exePath: mcpShimExecutable(buildInfo, app.isPackaged, app.getPath("exe")),
      mcpShimPath,
      apiKeys: buildInfo.flags.apiKeys,
    });
    if (!selfTest) {
      // Warm the provider detection (CLI versions, lockdown, logins, Ollama; no model call) in the background, so
      // Settings and the first run do not wait for it.
      const warm = setTimeout(() => void agent?.host.settingsView().catch((e: unknown) => console.warn(`[aicad-agent] provider detection failed: ${e instanceof Error ? e.message : String(e)}`)), 1500);
      warm.unref();
    }
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
        mainWindow.setTitle(`${state.title}${state.dirty ? " •" : ""} — ${productName}`);
        if (process.platform === "darwin") {
          mainWindow.setDocumentEdited(state.dirty);
          // ipc.ts already dropped an ungranted path; checked again because this is the sink.
          mainWindow.setRepresentedFilename(documentStatePath(state.path, grants) ?? "");
        }
      },
    });

    rebuildMenu();
    mainWindow = createWindow({ hidden: selfTest });
    if (selfTest) {
      void runSelfTest(mainWindow, forgeBin, mcpShimPath, mcpShimPath ? null : workspaceMcpServerDir(repoRoot), profile);
      return;
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on("will-quit", () => agent?.host.dispose());

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

// ─── --self-test ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** The hidden window loads the app and evaluates its starting document (a v0 block) with the renderer's engine. */
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
    if (rendererReady(last)) {
      return { ok: true, detail: `${last.url}: ${last.engine ?? "?"} evaluated the starting document (${last.features.length} features ok, ${last.bodies}, 0 problems)`, ms: Date.now() - t0, snapshot: last };
    }
    await sleep(250);
  }
  return { ok: false, detail: error ?? `the starting document was not evaluated within ${timeoutMs / 1000} s`, ms: null, snapshot: last };
}

/** A fresh agent worker starts, then checks its bundle (agent/self-test.ts) and answers. */
function probeWorker(shimPath: string | null, mcpServerDir: string | null, timeoutMs: number): Promise<SelfTestReport["worker"]> {
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
        w?.postMessage({ type: "selftest", v: PROTOCOL_VERSION, mcpShimPath: shimPath, mcpServerDir });
      } else if (m?.type === "selftest") {
        finish({ ok: true, detail: `ready in ${readyMs ?? "?"} ms`, readyMs, report: m.report });
      }
    });
  });
}

async function runSelfTest(win: BrowserWindow, forgeBin: string, shimPath: string | null, mcpServerDir: string | null, profile: string): Promise<void> {
  const setup = agent!;
  const [renderer, worker, forgeCli, claudeCode, slicer] = await Promise.all([
    probeRenderer(win, 120_000),
    probeWorker(shimPath, mcpServerDir, 120_000),
    forgeSelfCheck(forgeBin, JSON.stringify(SELF_TEST_IR)).catch((e: unknown) => ({ ok: false, path: forgeBin, version: null, detail: message(e), v0: null, v1: null })),
    setup.host.settingsView().then(
      (view) => claudeCodeCheck(view),
      (e: unknown) => claudeCodeCheck(null, `detection failed: ${message(e)}`),
    ),
    detectBambuStudio().catch(() => ({ found: false, name: "Bambu Studio" as const, path: null, bundleId: null, version: null })),
  ]);
  const body: Omit<SelfTestReport, "ok" | "failures" | "warnings" | "schema"> = {
    app: {
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
    },
    paths: reportPaths({ profile, logs: overrides.userDataDir ? join(overrides.userDataDir, "logs") : join(app.getPath("home"), "Library", "Logs", productName) }),
    forgeCli,
    worker,
    renderer,
    claudeCode,
    slicer,
  };
  const verdict = selfTestVerdict(body);
  const report: SelfTestReport = { schema: SELF_TEST_SCHEMA, ...verdict, ...body };
  setup.host.dispose();
  if (!win.isDestroyed()) win.destroy();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => {
    if (selfTestProfile !== null) removeAfterExit(selfTestProfile);
    app.exit(verdict.ok ? 0 : 1);
  });
}

/**
 * Remove the throwaway profile once this process is gone: Chromium writes into its profile while it shuts down
 * (`Local State`, session storage), after any code of ours could delete it. A detached `/bin/sh` waits for this pid to
 * exit, then removes the folder; the path travels as an argument, never inside the script text.
 */
function removeAfterExit(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  if (process.platform === "win32") return;
  try {
    const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; rm -rf -- "$2"';
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
  }
  start();
}
