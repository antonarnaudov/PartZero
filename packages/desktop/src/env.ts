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
