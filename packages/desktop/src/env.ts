/**
 * Environment hygiene for the desktop shell (electron-free, unit-tested).
 *
 * - {@link childProcessEnv}: child processes (the agent utility process, the Forge CLI) get an
 *   environment built from an allowlist, never the main process's environment minus a denylist.
 *   A denylist cannot know every variable that redirects traffic or carries a secret
 *   (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `AWS_ACCESS_KEY_ID`, `NODE_OPTIONS`, …).
 * - {@link readDevOverrides}: the `AICAD_*` development and test overrides. A packaged build
 *   ignores every one of them, so an environment variable (e.g. `launchctl setenv`) cannot point
 *   the signed app at another web root, another binary or a remote dev server.
 * - {@link parseDevServerUrl}: a dev server is accepted only on loopback (`localhost`, `127.0.0.1`,
 *   `[::1]`); its exact origin is what {@link isTrustedFrameUrl} (protocol-core.ts) trusts.
 */
import { join, resolve } from "node:path";

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

/** The agent utility process: no keys (they arrive per run, in memory), no base-URL or Node overrides. */
export function agentWorkerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return childProcessEnv(env);
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
}

const NO_OVERRIDES: DevOverrides = { devServer: null, userDataDir: null, appDist: null, skipClosePrompt: false, simulatePackaged: false, allowDebugger: false };

/** Every `AICAD_*` variable read by the main process for development and tests. */
export const DEV_OVERRIDE_VARIABLES = ["AICAD_DEV_URL", "AICAD_USER_DATA_DIR", "AICAD_APP_DIST", "AICAD_SKIP_CLOSE_PROMPT", "AICAD_SIMULATE_PACKAGED", "AICAD_ALLOW_DEBUGGER", "AICAD_BIN", "AICAD_AGENT_TRANSPORT", "AICAD_AGENT_SCRIPT", "AICAD_AGENT_FIXTURES", "AICAD_AGENT_DOTENV"] as const;

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
  };
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
