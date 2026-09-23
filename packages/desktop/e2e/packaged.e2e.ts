/**
 * What a packaged build takes away (phase 0 audit L8, L13), checked on an unpackaged run with
 * `AICAD_SIMULATE_PACKAGED=1`, which applies the same rules (see src/env.ts): no DevTools (not even
 * programmatically), no Reload / Toggle Developer Tools menu items, no `window.__aicad` automation
 * API, so nothing pasted into a console can drive the privileged bridge through it, and no start at
 * all with a debugger switch such as `--remote-debugging-port` (src/debug-switches.ts).
 *
 * Playwright itself attaches through `--inspect` and `--remote-debugging-port`, so the run it
 * launches sets `AICAD_ALLOW_DEBUGGER=1` (unpackaged only); the debugger-switch tests launch the
 * app without Playwright.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The environment of the e2e runner without provider keys. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$/.test(k)) env[k] = v;
  return env;
}

let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "aicad-e2e-packaged-"));
  app = await electron.launch({
    args: [desktopRoot, "--use-mock-keychain"],
    env: {
      ...baseEnv(),
      AICAD_USER_DATA_DIR: userData,
      AICAD_SKIP_CLOSE_PROMPT: "1",
      AICAD_AGENT_DOTENV: "off",
      AICAD_SIMULATE_PACKAGED: "1",
      AICAD_ALLOW_DEBUGGER: "1", // Playwright's own --inspect / --remote-debugging-port
    },
  });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

test("a packaged-mode run has no automation API, no DevTools and no developer menu items", async () => {
  await expect(page.getByTestId("app-shell")).toBeVisible();
  expect(page.url()).toBe("app://aicad/index.html");
  expect(await page.evaluate(() => typeof (window as unknown as { __aicad?: unknown }).__aicad)).toBe("undefined");
  const devTools = await app.evaluate(async ({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents;
    wc.openDevTools({ mode: "detach" });
    await new Promise((r) => setTimeout(r, 500));
    return wc.isDevToolsOpened();
  });
  expect(devTools).toBe(false);
  const roles = await app.evaluate(({ Menu }) => {
    const out: string[] = [];
    const walk = (items: Electron.MenuItem[]): void => {
      for (const i of items) {
        if (i.role) out.push(String(i.role).toLowerCase());
        if (i.submenu) walk(i.submenu.items);
      }
    };
    walk(Menu.getApplicationMenu()?.items ?? []);
    return out;
  });
  expect(roles).not.toContain("toggledevtools");
  expect(roles).not.toContain("reload");
  // The app itself still works.
  await expect(page.getByTestId("engine-label")).toBeVisible();
});

// ─── Debugger switches (launched without Playwright) ──────────────────────────────────────────

const electronBinary = createRequire(import.meta.url)("electron") as unknown as string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

interface Launched {
  child: ChildProcess;
  userData: string;
  stderr: () => string;
  exit: Promise<number | null>;
}

/** Stop the app (if still running) and delete its profile. */
async function stop(l: Launched): Promise<void> {
  l.child.kill();
  await l.exit;
  rmSync(l.userData, { recursive: true, force: true });
}

/** The app in packaged mode, started directly (no Playwright switches), with `args` and `env` added. */
function launchPackagedMode(args: string[], env: Record<string, string> = {}): Launched {
  const userData = mkdtempSync(join(tmpdir(), "aicad-e2e-switches-"));
  const child = spawn(electronBinary, [desktopRoot, "--use-mock-keychain", ...args], {
    env: { ...baseEnv(), AICAD_USER_DATA_DIR: userData, AICAD_SKIP_CLOSE_PROMPT: "1", AICAD_AGENT_DOTENV: "off", AICAD_SIMULATE_PACKAGED: "1", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, userData, stderr: () => stderr, exit };
}

/** The DevTools-protocol targets on `port`, or null while nothing answers. */
async function devToolsTargets(port: number): Promise<string[] | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
    return ((await r.json()) as Array<{ url: string }>).map((t) => t.url);
  } catch {
    return null;
  }
}

/** Chromium's `SingletonLock` (a symlink to `host-pid`, dangling by design) in the profile: the app got past startup checks to requestSingleInstanceLock. */
function hasSingletonLock(userData: string): boolean {
  try {
    return lstatSync(join(userData, "SingletonLock")).isSymbolicLink();
  } catch {
    return false;
  }
}

const exited = (l: Launched, ms: number): Promise<number | null | "running"> => Promise.race([l.exit, new Promise<"running">((r) => setTimeout(() => r("running"), ms))]);

test("packaged mode refuses to start with --remote-debugging-port: no app page is ever reachable over CDP", async () => {
  const port = await freePort();
  const l = launchPackagedMode([`--remote-debugging-port=${port}`]);
  try {
    const seen: string[] = [];
    const deadline = Date.now() + 20_000;
    let code: number | null | "running" = "running";
    while (code === "running" && Date.now() < deadline) {
      seen.push(...((await devToolsTargets(port)) ?? []));
      code = await exited(l, 250);
    }
    expect(seen.filter((u) => u.startsWith("app://")), "app pages exposed over CDP").toEqual([]);
    expect(code, `still running after 20 s; stderr:\n${l.stderr()}`).toBe(1);
    expect(l.stderr()).toContain("[aicad] refusing to start: --remote-debugging-port");
    expect(hasSingletonLock(l.userData), "got as far as the single-instance lock").toBe(false);
  } finally {
    await stop(l);
  }
});

test("the probe works: with AICAD_ALLOW_DEBUGGER=1 (unpackaged only) the app page is on CDP", async () => {
  const port = await freePort();
  const l = launchPackagedMode([`--remote-debugging-port=${port}`], { AICAD_ALLOW_DEBUGGER: "1" });
  try {
    await expect.poll(async () => (await devToolsTargets(port)) ?? [], { timeout: 60_000 }).toContain("app://aicad/index.html");
  } finally {
    await stop(l);
  }
});

test("packaged mode without debugger switches starts (no switch Electron adds by itself is refused)", async () => {
  test.skip(process.platform === "win32", "the single-instance lock file is POSIX-only");
  const l = launchPackagedMode([]);
  try {
    await expect.poll(() => hasSingletonLock(l.userData), { timeout: 60_000 }).toBe(true);
    expect(await exited(l, 2_000)).toBe("running");
    expect(l.stderr()).not.toContain("refusing to start");
  } finally {
    await stop(l);
  }
});
