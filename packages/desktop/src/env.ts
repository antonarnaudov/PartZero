/**
 * Environment hygiene for the desktop shell (electron-free, unit-tested).
 *
 * - {@link childProcessEnv}: child processes (the agent utility process, the Forge CLI) get an
 *   environment built from an allowlist, never the main process's environment minus a denylist.
 *   A denylist cannot know every variable that redirects traffic or carries a secret
 *   (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `AWS_ACCESS_KEY_ID`, `NODE_OPTIONS`, …).
 *   CLI agents additionally get their login locations and proxy settings ({@link cliChildHostEnv}), passed
 *   per run so that they never enter the agent utility process's own environment.
 * - {@link readDevOverrides}: the `AICAD_*` development and test overrides. A packaged build
 *   ignores every one of them, so an environment variable (e.g. `launchctl setenv`) cannot point
 *   the signed app at another web root, another binary or a remote dev server.
 * - {@link parseDevServerUrl}: a dev server is accepted only on loopback (`localhost`, `127.0.0.1`,
 *   `[::1]`); its exact origin is what {@link isTrustedFrameUrl} (protocol-core.ts) trusts.
 */
import { userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { CLI_ENV_LOCATION, CLI_ENV_NETWORK } from "@aicad/llm-gateway/cli";

/**
 * Variables a child process may inherit. Paths, locale and the Windows essentials only: without
 * `SystemRoot` sockets and crypto fail in Windows child processes.
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "TZ",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
];

/**
 * The environment for a child process: only {@link CHILD_ENV_ALLOWLIST} plus `extra` names
 * (case-insensitive, because Windows variable names are).
 */
export function childProcessEnv(env: NodeJS.ProcessEnv, extra: readonly string[] = []): Record<string, string> {
  const allow = new Set([...CHILD_ENV_ALLOWLIST, ...extra].map((k) => k.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && allow.has(k.toUpperCase())) out[k] = v;
  }
  return out;
}

/**
 * The agent utility process: the plain allowlist. No keys (they arrive per run, in memory), no base-URL or Node
 * overrides, and neither the CLI login locations nor the proxy and CA settings: that process holds the run's API keys
 * and makes the SDK calls, so `NODE_EXTRA_CA_CERTS` (which Electron honors in packaged builds too) or a proxy set in
 * the app's environment (e.g. `launchctl setenv`) must not reach it. CLI children get those through
 * {@link cliChildHostEnv} instead.
 */
export function agentWorkerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return childProcessEnv(env);
}

/**
 * What CLI children may inherit from the host beyond the worker's own environment: where CLI agents keep their own
 * logins (`XDG_*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`: locations, never credentials) and the proxy
 * and CA settings a CLI needs behind a corporate proxy (docs/CLI-PROVIDERS.md §5.3). Sent to the worker in the
 * `start` message (`WorkerCliConfig.childEnv`), used only for CLI children; the gateway allowlists again per CLI.
 */
export function cliChildHostEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const allow = new Set([...CLI_ENV_LOCATION, ...CLI_ENV_NETWORK].map((k) => k.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && allow.has(k.toUpperCase())) out[k] = v;
  }
  return out;
}

/** The account's login name, or null (`os.userInfo()` throws when the user database has no entry). */
function accountName(): string | null {
  try {
    const name = userInfo().username;
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * `env` with `USER` and `LOGNAME` filled from the account (`os.userInfo()`) when the app was started without them.
 * launchd normally sets both for a GUI app, but not every launcher does, and CLI agents depend on them: without `USER`,
 * `claude auth status` exits 1 (read as "not logged in") for a user who is logged in (observed with Claude Code
 * 2.1.260). Like the `SHELL` fallback (llm-gateway `loginShellPath`). POSIX only; a value that is set is never changed.
 */
export function withLoginNames(env: NodeJS.ProcessEnv, username: () => string | null = accountName, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform === "win32" || (env["USER"] && env["LOGNAME"])) return env;
  const name = env["USER"] || env["LOGNAME"] || username();
  if (!name) return env;
  return { ...env, USER: env["USER"] || name, LOGNAME: env["LOGNAME"] || name };
}

/** CLI detection probes in the main process: the allowlist, the CLI locations and proxies, and `SHELL` for the login-shell lookup. */
export function cliDetectEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return childProcessEnv(env, [...CLI_ENV_LOCATION, ...CLI_ENV_NETWORK, "SHELL"]);
}

/** The Forge CLI (`aicad`): the same, plus `RUST_BACKTRACE` so panics stay diagnosable. */
export function forgeCliEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return childProcessEnv(env, ["RUST_BACKTRACE"]);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A development server URL (`AICAD_DEV_URL`): `http(s)://localhost|127.0.0.1|[::1][:port]/…`
 * without credentials. Returns the URL to load and its exact origin, or null.
 */
export function parseDevServerUrl(raw: string | undefined): { url: string; origin: string } | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (!LOOPBACK_HOSTS.has(u.hostname)) return null;
  return { url: u.href, origin: u.origin };
}

export interface DevOverrides {
  /** `AICAD_DEV_URL`: the Vite dev server (loopback only). */
  devServer: { url: string; origin: string } | null;
  /** `AICAD_USER_DATA_DIR`: an isolated profile (e2e runs). */
  userDataDir: string | null;
  /** `AICAD_APP_DIST`: another built web app. */
  appDist: string | null;
  /** `AICAD_SKIP_CLOSE_PROMPT`: close without the unsaved-changes prompt (e2e runs). */
  skipClosePrompt: boolean;
  /**
   * `AICAD_SIMULATE_PACKAGED=1`: an unpackaged run that turns DevTools, the reload/DevTools menu
   * items and the renderer automation API off exactly as a packaged build does, so e2e tests can
   * check the packaged behavior. It only ever removes capabilities.
   */
  simulatePackaged: boolean;
  /**
   * `AICAD_ALLOW_DEBUGGER=1`: with `AICAD_SIMULATE_PACKAGED=1`, still start when a debugger switch
   * is present (debug-switches.ts). Playwright attaches through `--inspect` and
   * `--remote-debugging-port`, so the packaged-mode e2e tests need it; a packaged build never does.
   */
  allowDebugger: boolean;
  /**
   * `AICAD_CLI_DIRS` (path-list): look for CLI agents only in these directories (no PATH, no known install
   * directories, no login shell). The keyless e2e points it at a fake `claude`, so a test never runs a real CLI.
   * With an isolated profile (`AICAD_USER_DATA_DIR`, i.e. a test run) and no `AICAD_CLI_DIRS`, it is `[]`: the user's
   * real, logged-in CLIs are never found, so no test can spend their plan by accident.
   */
  cliDirs: string[] | null;
  /**
   * Probe the default local Ollama URL. False with an isolated profile (a test run): then only an Ollama URL set
   * explicitly in that profile's settings is probed.
   */
  detectLocalModels: boolean;
  /**
   * What the CLI mode setting `auto` means for runs (`completion` and `runtime` settings are always honored).
   * `runtime` (the normal case: the CLI's own agent loop when available, docs/CLI-PROVIDERS.md §3.4). With an isolated
   * profile (a test run) it is `completion` unless `AICAD_CLI_AUTO=runtime`: a test that wants runtime mode says so,
   * so a fake CLI that only answers single calls is never driven through the MCP runtime by accident.
   */
  cliAutoMode: "runtime" | "completion";
  /**
   * `AICAD_SELF_TEST_TIMEOUT_MS`: the `--self-test` watchdog's limit (self-test.ts `SELF_TEST_TIMEOUT_MS` otherwise), so
   * the e2e suite can check that a self-test that does not finish still prints a report and exits.
   */
  selfTestTimeoutMs: number | null;
  /**
   * `AICAD_PRINTS_DIR`: where "Open in Bambu Studio" saves prints instead of `~/PartZero/Prints`. With an isolated
   * profile and no `AICAD_PRINTS_DIR`, `<profile>/Prints`: a test run never writes into the user's real prints folder.
   */
  printsDir: string | null;
  /**
   * `AICAD_SLICER_DIRS` (path-list): look for `BambuStudio.app` only in these folders (no `/Applications`, no
   * LaunchServices). With an isolated profile and none given, `[]`: a test run never launches the user's real slicer.
   */
  slicerDirs: string[] | null;
  /** `AICAD_OPEN_BIN`: the `open` executable the slicer launch uses (a fake in tests) instead of `/usr/bin/open`. */
  openBin: string | null;
}

const NO_OVERRIDES: DevOverrides = {
  devServer: null,
  userDataDir: null,
  appDist: null,
  skipClosePrompt: false,
  simulatePackaged: false,
  allowDebugger: false,
  cliDirs: null,
  detectLocalModels: true,
  cliAutoMode: "runtime",
  selfTestTimeoutMs: null,
  printsDir: null,
  slicerDirs: null,
  openBin: null,
};

/** Every `AICAD_*` variable read by the main process for development and tests. */
export const DEV_OVERRIDE_VARIABLES = [
  "AICAD_DEV_URL",
  "AICAD_USER_DATA_DIR",
  "AICAD_APP_DIST",
  "AICAD_SKIP_CLOSE_PROMPT",
  "AICAD_SIMULATE_PACKAGED",
  "AICAD_ALLOW_DEBUGGER",
  "AICAD_BIN",
  "AICAD_AGENT_TRANSPORT",
  "AICAD_AGENT_SCRIPT",
  "AICAD_AGENT_FIXTURES",
  "AICAD_AGENT_DOTENV",
  "AICAD_CLI_DIRS",
  "AICAD_CLI_AUTO",
  "AICAD_SELF_TEST_TIMEOUT_MS",
  "AICAD_PRINTS_DIR",
  "AICAD_SLICER_DIRS",
  "AICAD_OPEN_BIN",
] as const;

/**
 * The development and test overrides, or none at all in a packaged build (with a warning per
 * variable that is set, so a stray variable is visible in the log instead of silently obeyed).
 */
export function readDevOverrides(env: NodeJS.ProcessEnv, isPackaged: boolean, warn: (message: string) => void = () => undefined): DevOverrides {
  if (isPackaged) {
    for (const name of DEV_OVERRIDE_VARIABLES) if (env[name]) warn(`${name} is ignored in packaged builds`);
    return NO_OVERRIDES;
  }
  const rawDevUrl = env["AICAD_DEV_URL"];
  const devServer = parseDevServerUrl(rawDevUrl);
  if (rawDevUrl && !devServer) warn(`AICAD_DEV_URL=${rawDevUrl} is not a loopback http(s) URL (localhost, 127.0.0.1, [::1]); ignoring it`);
  const path = (name: string): string | null => (env[name] ? resolve(env[name]) : null);
  return {
    devServer,
    userDataDir: path("AICAD_USER_DATA_DIR"),
    appDist: path("AICAD_APP_DIST"),
    skipClosePrompt: !!env["AICAD_SKIP_CLOSE_PROMPT"],
    simulatePackaged: env["AICAD_SIMULATE_PACKAGED"] === "1",
    allowDebugger: env["AICAD_ALLOW_DEBUGGER"] === "1",
    cliDirs: env["AICAD_CLI_DIRS"] ? env["AICAD_CLI_DIRS"].split(delimiter).filter((d) => d.length > 0).map((d) => resolve(d)) : env["AICAD_USER_DATA_DIR"] ? [] : null,
    detectLocalModels: !env["AICAD_USER_DATA_DIR"],
    cliAutoMode: cliAutoMode(env, warn),
    selfTestTimeoutMs: /^[1-9]\d{0,6}$/.test(env["AICAD_SELF_TEST_TIMEOUT_MS"] ?? "") ? Number(env["AICAD_SELF_TEST_TIMEOUT_MS"]) : null,
    printsDir: path("AICAD_PRINTS_DIR") ?? (env["AICAD_USER_DATA_DIR"] ? join(resolve(env["AICAD_USER_DATA_DIR"]), "Prints") : null),
    slicerDirs: env["AICAD_SLICER_DIRS"]
      ? env["AICAD_SLICER_DIRS"].split(delimiter).filter((d) => d.length > 0).map((d) => resolve(d))
      : env["AICAD_USER_DATA_DIR"]
        ? []
        : null,
    openBin: path("AICAD_OPEN_BIN"),
  };
}

function cliAutoMode(env: NodeJS.ProcessEnv, warn: (message: string) => void): DevOverrides["cliAutoMode"] {
  const raw = env["AICAD_CLI_AUTO"];
  if (raw === "runtime" || raw === "completion") return raw;
  if (raw) warn(`AICAD_CLI_AUTO=${raw} is not "runtime" or "completion"; ignoring it`);
  return env["AICAD_USER_DATA_DIR"] ? "completion" : "runtime";
}

/**
 * The built web app to serve from `app://aicad/`. Packaged: `app-web` inside `app.asar` (covered by
 * the embedded asar integrity check, unlike loose files in `resources/`). Unpackaged:
 * `$AICAD_APP_DIST` (already filtered by {@link readDevOverrides}), else the workspace build.
 */
export function resolveWebRoot(o: { isPackaged: boolean; appPath: string; appDistOverride: string | null; workspaceWebRoot: () => string }): string {
  if (o.isPackaged) return join(o.appPath, "app-web");
  return o.appDistOverride ?? o.workspaceWebRoot();
}
