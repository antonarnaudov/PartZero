/**
 * Electron hardening (phase 0 audit L8–L14): packaged builds ignore dev overrides, trusted origins
 * are exact, child processes get allowlisted environments and official API endpoints, compat base
 * URLs need https off loopback, DevTools are off when packaged, and file grants are split, tied to
 * real paths and revocable.
 */
import { chmodSync, existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ForgeCliEngine } from "@aicad/evals";
import { afterEach, describe, expect, it } from "vitest";
import { baseUrlProblem, parseBaseUrl, parseSettingsUpdate } from "../src/agent/protocol.js";
import { liveTransports, OFFICIAL_BASE_URLS } from "../src/agent/runner.js";
import { SettingsStore } from "../src/agent/settings.js";
import { transportFromEnv } from "../src/agent/setup.js";
import { DEBUG_SWITCHES, debugSwitchRefusal, forbiddenDebugSwitches } from "../src/debug-switches.js";
import { agentWorkerEnv, CHILD_ENV_ALLOWLIST, cliDetectEnv, forgeCliEnv, parseDevServerUrl, readDevOverrides, resolveWebRoot, withLoginNames } from "../src/env.js";
import { canonicalPath, documentStatePath, PathGrants, RecentFiles } from "../src/files.js";
import { forgeEval, locateForgeBinary } from "../src/forge-cli.js";
import { buildMenuTemplate } from "../src/menu.js";
import { isTrustedFrameUrl } from "../src/protocol-core.js";
import { mainWindowWebPreferences } from "../src/web-preferences.js";
import { tempDirs } from "./temp-dirs.js";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const thisFile = fileURLToPath(import.meta.url);
const tmp = tempDirs("aicad-hardening-test-");

/** Set environment variables for one test; restored in afterEach. */
const savedEnv = new Map<string, string | undefined>();
function setEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
    process.env[k] = v;
  }
}
afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
});

/** Secrets and redirectors a child process must never inherit. */
const HOSTILE_ENV = {
  ANTHROPIC_API_KEY: "sk-ant-canary-0000000000",
  OPENAI_API_KEY_2: "sk-canary-2-0000000000",
  AWS_ACCESS_KEY_ID: "AKIACANARY000000",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:9/evil",
  OPENAI_BASE_URL: "http://127.0.0.1:9/evil",
  GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:9/evil",
  NODE_OPTIONS: "--require /tmp/evil.js",
  ELECTRON_RUN_AS_NODE: "1",
};

describe("L10: packaged builds ignore dev and test overrides", () => {
  const env = {
    AICAD_DEV_URL: "http://localhost:5173/",
    AICAD_USER_DATA_DIR: "/tmp/profile",
    AICAD_APP_DIST: "/tmp/web",
    AICAD_SKIP_CLOSE_PROMPT: "1",
    AICAD_BIN: "/tmp/aicad",
    AICAD_AGENT_TRANSPORT: "scripted",
    AICAD_AGENT_SCRIPT: thisFile,
    AICAD_CLI_DIRS: "/tmp/fake-cli-bin",
  };

  it("reads no AICAD_* override when packaged, and says so", () => {
    const warnings: string[] = [];
    expect(readDevOverrides({ ...env, AICAD_ALLOW_DEBUGGER: "1" }, true, (m) => warnings.push(m))).toEqual({ devServer: null, userDataDir: null, appDist: null, skipClosePrompt: false, simulatePackaged: false, allowDebugger: false, cliDirs: null, detectLocalModels: true, cliAutoMode: "runtime" });
    expect(warnings).toEqual(
      expect.arrayContaining(["AICAD_DEV_URL is ignored in packaged builds", "AICAD_BIN is ignored in packaged builds", "AICAD_APP_DIST is ignored in packaged builds", "AICAD_ALLOW_DEBUGGER is ignored in packaged builds", "AICAD_CLI_DIRS is ignored in packaged builds"]),
    );
    expect(locateForgeBinary({ env, isPackaged: true, resourcesPath: "/App/Resources", appPath: "/" })).toBe(join("/App/Resources", "bin", process.platform === "win32" ? "aicad.exe" : "aicad"));
    expect(transportFromEnv(env, () => undefined, true)).toEqual({ kind: "live" });
    expect(resolveWebRoot({ isPackaged: true, appPath: "/App/Resources/app.asar", appDistOverride: "/tmp/web", workspaceWebRoot: () => "/ws" })).toBe(join("/App/Resources/app.asar", "app-web"));
  });

  it("honours them unpackaged, with the dev server on loopback only", () => {
    const o = readDevOverrides(env, false);
    expect(o).toMatchObject({ devServer: { url: "http://localhost:5173/", origin: "http://localhost:5173" }, userDataDir: resolve("/tmp/profile"), appDist: resolve("/tmp/web"), skipClosePrompt: true, cliDirs: [resolve("/tmp/fake-cli-bin")], detectLocalModels: false });
    // An isolated test profile never finds the user's real CLIs (or probes a local Ollama) unless the test opts in.
    // It also runs the `auto` CLI mode as single calls, unless the test opts into the agent runtime.
    expect(readDevOverrides({ AICAD_USER_DATA_DIR: "/tmp/profile" }, false)).toMatchObject({ cliDirs: [], detectLocalModels: false, cliAutoMode: "completion" });
    expect(readDevOverrides({ AICAD_USER_DATA_DIR: "/tmp/profile", AICAD_CLI_AUTO: "runtime" }, false)).toMatchObject({ cliAutoMode: "runtime" });
    expect(readDevOverrides({}, false)).toMatchObject({ cliDirs: null, detectLocalModels: true, cliAutoMode: "runtime" });
    expect(readDevOverrides({ AICAD_CLI_AUTO: "completion" }, true).cliAutoMode).toBe("runtime"); // packaged: ignored
    expect(locateForgeBinary({ env, isPackaged: false, resourcesPath: "", appPath: "/" })).toBe(resolve("/tmp/aicad"));
    expect(transportFromEnv(env, () => undefined, false)).toEqual({ kind: "scripted", scriptPath: thisFile });
    expect(resolveWebRoot({ isPackaged: false, appPath: "/x", appDistOverride: null, workspaceWebRoot: () => "/ws" })).toBe("/ws");
    for (const ok of ["http://127.0.0.1:5173/", "http://[::1]:4173/", "https://localhost/"]) expect(parseDevServerUrl(ok)).not.toBeNull();
    for (const bad of ["https://evil.example/", "http://localhost:5173@evil.com/", "http://localhost.evil.com:5173/", "http://127.0.0.1.nip.io/", "file:///tmp/index.html", "http://user:pw@localhost:5173/", "nonsense"]) {
      expect(parseDevServerUrl(bad), bad).toBeNull();
    }
    const warnings: string[] = [];
    expect(readDevOverrides({ AICAD_DEV_URL: "https://evil.example/" }, false, (m) => warnings.push(m)).devServer).toBeNull();
    expect(warnings[0]).toMatch(/not a loopback/);
  });

  it("trusts exactly app://aicad and the dev server's origin, never a prefix match", () => {
    const dev = "http://localhost:5173";
    expect(isTrustedFrameUrl("app://aicad/index.html", null)).toBe(true);
    expect(isTrustedFrameUrl("app://aicad/assets/x.js?y#z", dev)).toBe(true);
    expect(isTrustedFrameUrl("http://localhost:5173/src/main.tsx", dev)).toBe(true);
    for (const bad of [
      "http://localhost:5173@evil.com/",
      "http://localhost:5173.evil.com/",
      "http://localhost:51730/",
      "https://localhost:5173/",
      "http://127.0.0.1:5173/",
      "app://aicad.evil/index.html",
      "app://evil/index.html",
      "app://user@aicad/index.html",
      "app://aicad:8080/index.html",
      "file:///index.html",
      "",
      "garbage",
    ]) {
      expect(isTrustedFrameUrl(bad, dev), bad).toBe(false);
    }
    expect(isTrustedFrameUrl("http://localhost:5173/", null)).toBe(false);
    expect(isTrustedFrameUrl(undefined, dev)).toBe(false);
  });
});

describe("L9/L11: child processes get allowlisted environments", () => {
  it("drops keys, base-URL redirects and Node/Electron switches", () => {
    const env = { PATH: "/bin", HOME: "/h", TMPDIR: "/t", LANG: "C", SystemRoot: "C:\\Windows", RUST_BACKTRACE: "1", AICAD_BIN: "/x", ...HOSTILE_ENV };
    expect(agentWorkerEnv(env)).toEqual({ PATH: "/bin", HOME: "/h", TMPDIR: "/t", LANG: "C", SystemRoot: "C:\\Windows" });
    expect(forgeCliEnv(env)).toEqual({ PATH: "/bin", HOME: "/h", TMPDIR: "/t", LANG: "C", SystemRoot: "C:\\Windows", RUST_BACKTRACE: "1" });
  });

  it("fills USER and LOGNAME from the account when the app was started without them (CLI login probes need USER)", () => {
    const me = (): string => "maker";
    // Started without either (a launcher that sets only HOME and PATH): both come from the account, and reach the
    // worker (whose CLI children inherit them) and the detection probes.
    const bare = withLoginNames({ PATH: "/usr/bin:/bin", HOME: "/Users/maker" }, me, "darwin");
    expect(agentWorkerEnv(bare)).toEqual({ PATH: "/usr/bin:/bin", HOME: "/Users/maker", USER: "maker", LOGNAME: "maker" });
    expect(cliDetectEnv(bare)).toMatchObject({ USER: "maker", LOGNAME: "maker" });
    // A value that is set wins, and fills the other one.
    expect(withLoginNames({ USER: "anna" }, me, "darwin")).toEqual({ USER: "anna", LOGNAME: "anna" });
    expect(withLoginNames({ LOGNAME: "anna" }, me, "linux")).toEqual({ USER: "anna", LOGNAME: "anna" });
    const both = { USER: "a", LOGNAME: "b" };
    expect(withLoginNames(both, me, "darwin")).toBe(both);
    // No account name, or Windows (USERNAME): unchanged.
    expect(withLoginNames({ HOME: "/h" }, () => null, "darwin")).toEqual({ HOME: "/h" });
    expect(withLoginNames({ HOME: "C:\\Users\\m" }, me, "win32")).toEqual({ HOME: "C:\\Users\\m" });
    // The real account (this machine): some non-empty name.
    expect(withLoginNames({}, undefined, "darwin")["USER"]).toMatch(/^.+$/);
  });

  /** A fake `aicad` that dumps its environment to `dump` and prints `stdout`. */
  function envDumpingBinary(stdout: string): { bin: string; dump: string } {
    const dir = tmp();
    const dump = join(dir, "env.txt");
    const bin = join(dir, "aicad");
    writeFileSync(bin, `#!/bin/sh\nenv > '${dump}'\nprintf '%s' '${stdout}'\n`);
    chmodSync(bin, 0o755);
    return { bin, dump };
  }

  it.skipIf(process.platform === "win32")("the desktop's Forge CLI spawn sees no provider key", async () => {
    setEnv(HOSTILE_ENV);
    const { bin, dump } = envDumpingBinary("{}");
    const r = await forgeEval(bin, { irJson: '{"x":1}', meshes: false });
    expect(r.evalExitCode).toBe(0);
    const seen = readFileSync(dump, "utf8");
    for (const [k, v] of Object.entries(HOSTILE_ENV)) {
      expect(seen, k).not.toContain(`${k}=`);
      if (v.length > 8) expect(seen, k).not.toContain(v);
    }
    expect(seen).toMatch(/^PATH=/m);
  });

  it("@aicad/evals uses the same allowlist for the Forge CLI (its source, not a stale dist)", async () => {
    const engineSource = join(desktopRoot, "..", "evals", "src", "engine.ts");
    const { FORGE_CLI_ENV_ALLOWLIST } = (await import(engineSource)) as { FORGE_CLI_ENV_ALLOWLIST: readonly string[] };
    expect([...FORGE_CLI_ENV_ALLOWLIST].sort()).toEqual([...CHILD_ENV_ALLOWLIST, "RUST_BACKTRACE"].sort());
  });

  it.skipIf(process.platform === "win32")("@aicad/evals ForgeCliEngine (the agent's fallback engine) sees no provider key", async () => {
    setEnv(HOSTILE_ENV);
    const { bin, dump } = envDumpingBinary("not a report");
    const engine = new ForgeCliEngine({ bin });
    await expect(engine.evaluate({} as never)).rejects.toMatchObject({ code: "ENGINE_BAD_OUTPUT" });
    const seen = readFileSync(dump, "utf8");
    for (const k of Object.keys(HOSTILE_ENV)) expect(seen, k).not.toContain(`${k}=`);
    expect(seen).toMatch(/^PATH=/m);
  });
});

describe("L9: provider SDKs are pinned to the official endpoints", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("ignores ANTHROPIC_BASE_URL / OPENAI_BASE_URL / GOOGLE_GEMINI_BASE_URL", async () => {
    setEnv(HOSTILE_ENV);
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "stubbed", code: 400, status: "INVALID_ARGUMENT" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const t = liveTransports({ anthropic: "sk-ant-test-00000000", openai: "sk-test-00000000", google: "AIza-test-00000000" }, null);
    await expect(t.anthropic.send({ provider: "anthropic", operation: "anthropic.messages.create", payload: { model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "x" }] } })).rejects.toBeTruthy();
    await expect(t.openai.send({ provider: "openai", operation: "openai.responses.create", payload: { model: "gpt-6-luna", input: "x" } })).rejects.toBeTruthy();
    await expect(t.google.send({ provider: "google", operation: "google.models.generateContent", payload: { model: "gemini-3.5-flash-lite", contents: "x" } })).rejects.toBeTruthy();
    expect(urls).toHaveLength(3);
    expect(urls[0]!.startsWith(`${OFFICIAL_BASE_URLS.anthropic}/v1/messages`)).toBe(true);
    expect(urls[1]!.startsWith(`${OFFICIAL_BASE_URLS.openai}/responses`)).toBe(true);
    expect(urls[2]!.startsWith(OFFICIAL_BASE_URLS.google)).toBe(true);
    for (const u of urls) expect(u).not.toContain("127.0.0.1");
  });
});

describe("L12: cleartext http only for loopback base URLs", () => {
  it("accepts https anywhere and http on localhost, 127.0.0.0/8 and [::1] only", () => {
    for (const ok of ["https://api.remote-llm.example/v1", "http://localhost:11434/v1", "http://127.0.0.1:8000/v1", "http://127.8.9.10/v1", "http://[::1]:8000/v1"]) {
      expect(baseUrlProblem(ok), ok).toBeNull();
      expect(parseBaseUrl(`${ok}/`)).toBe(ok);
    }
    for (const bad of ["http://api.remote-llm.example/v1", "http://localhost.evil.com/v1", "http://127.0.0.1.evil.com/v1", "http://10.0.0.5:8000/v1", "http://[::2]/v1", "http://0.0.0.0:8000/v1"]) {
      expect(() => parseSettingsUpdate({ v: 1, compatBaseUrl: bad }), bad).toThrow(/must use https:\/\//);
    }
  });

  it("drops a cleartext remote URL from a hand-edited settings file", () => {
    const file = join(tmp(), "agent-settings.json");
    writeFileSync(file, JSON.stringify({ v: 1, models: {}, budgetUsd: 1, compatBaseUrl: "http://api.remote-llm.example/v1" }));
    expect(new SettingsStore(file).get().compatBaseUrl).toBeNull();
    writeFileSync(file, JSON.stringify({ v: 1, models: {}, budgetUsd: 1, compatBaseUrl: "http://localhost:11434/v1" }));
    expect(new SettingsStore(file).get().compatBaseUrl).toBe("http://localhost:11434/v1");
  });

  it("refuses a cleartext remote endpoint at call time too (Settings or profile)", async () => {
    const call = { provider: "openai-compat" as const, operation: "openai-compat.chat.completions.create" as const, payload: { model: "m", messages: [] } };
    await expect(liveTransports({ "openai-compat": "k-000000000" }, "http://api.remote-llm.example/v1")["openai-compat"].send(call)).rejects.toThrow(/must use https/);
    await expect(liveTransports({}, null)["openai-compat"].send({ ...call, endpoint: "http://api.remote-llm.example/v1" })).rejects.toThrow(/must use https/);
  });
});

describe("L13: no DevTools in packaged builds", () => {
  it("turns DevTools off in webPreferences and drops the menu items", () => {
    expect(mainWindowWebPreferences("/p.cjs", false)).toMatchObject({ devTools: false, sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(mainWindowWebPreferences("/p.cjs", true).devTools).toBe(true);
    const roles = (isDev: boolean): unknown[] => {
      const out: unknown[] = [];
      const walk = (list: unknown): void => {
        if (!Array.isArray(list)) return;
        for (const it of list as Array<Record<string, unknown>>) {
          if (it["role"]) out.push(it["role"]);
          walk(it["submenu"]);
        }
      };
      for (const platform of ["darwin", "win32", "linux"] as const) walk(buildMenuTemplate({ send: () => undefined, recentFiles: [], platform, appName: "aicad", isDev }));
      return out;
    };
    expect(roles(false)).not.toContain("toggleDevTools");
    expect(roles(false)).not.toContain("reload");
    expect(roles(true)).toContain("toggleDevTools");
  });

  it("an unpackaged run can simulate the packaged behavior for e2e", () => {
    expect(readDevOverrides({ AICAD_SIMULATE_PACKAGED: "1" }, false).simulatePackaged).toBe(true);
    expect(readDevOverrides({ AICAD_SIMULATE_PACKAGED: "1" }, true).simulatePackaged).toBe(false);
    expect(readDevOverrides({ AICAD_ALLOW_DEBUGGER: "1" }, false).allowDebugger).toBe(true);
    expect(readDevOverrides({ AICAD_ALLOW_DEBUGGER: "1" }, true).allowDebugger).toBe(false);
  });
});

describe("L8/L13: packaged builds refuse debugger switches", () => {
  /** Chromium's parser stand-in: the switch names given. */
  const has = (...names: string[]) => (s: string) => names.includes(s);

  it("finds every DevTools-protocol, inspector and V8-flag switch", () => {
    expect(DEBUG_SWITCHES).toEqual(expect.arrayContaining(["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "js-flags"]));
    for (const s of DEBUG_SWITCHES) {
      expect(forbiddenDebugSwitches(has(s)), s).toEqual([s]);
      expect(forbiddenDebugSwitches(has(), [`--${s}`]), s).toEqual([s]);
      expect(forbiddenDebugSwitches(has(), [`--${s}=9229`]), s).toEqual([s]);
    }
    // Playwright's launch arguments, in the order the list reports them.
    expect(forbiddenDebugSwitches(has(), ["/app", "--inspect=0", "--remote-debugging-port=0"])).toEqual(["remote-debugging-port", "inspect"]);
    expect(forbiddenDebugSwitches(has(), ["-REMOTE-DEBUGGING-PORT=9337"])).toEqual(["remote-debugging-port"]);
    expect(forbiddenDebugSwitches(has("js-flags"), ["--inspect-brk"])).toEqual(["inspect-brk", "js-flags"]);
    expect(debugSwitchRefusal(["remote-debugging-port", "inspect"])).toMatch(/^refusing to start: --remote-debugging-port, --inspect /);
  });

  it("lets ordinary arguments through", () => {
    expect(forbiddenDebugSwitches(has(), [])).toEqual([]);
    expect(forbiddenDebugSwitches(has(), ["/Applications/aicad.app", "--use-mock-keychain", "--lang=en", "--inspector-theme", "--remote-debugging"])).toEqual([]);
    // Chromium stops parsing switches at `--`: what follows is an argument.
    expect(forbiddenDebugSwitches(has(), ["--", "--inspect"])).toEqual([]);
  });
});

describe("L14: file grants are split, tied to real paths and revocable", () => {
  it("an open dialog grants read (and write only for documents); a save dialog grants write", () => {
    const g = new PathGrants();
    const dir = tmp();
    const mesh = join(dir, "part.stl");
    const doc = join(dir, "part.cad.ts");
    const exportTarget = join(dir, "out.3mf");
    writeFileSync(mesh, "solid x");
    writeFileSync(doc, "export default 1;");
    g.grantOpened(mesh);
    expect(() => g.check(mesh, "read")).not.toThrow();
    expect(() => g.check(mesh, "write")).toThrow(/access denied/);
    g.grantOpened(doc);
    expect(() => g.check(doc, "write")).not.toThrow(); // Save writes an opened document back in place.
    g.grantSaveTarget(exportTarget);
    expect(() => g.check(exportTarget, "write")).not.toThrow();
    expect(() => g.check(exportTarget, "read")).toThrow(/access denied/);
  });

  it("a granted file swapped for a symlink loses its grant", () => {
    const g = new PathGrants();
    const dir = tmp();
    const doc = join(dir, "a.cad.ts");
    const secret = join(dir, "secret.txt");
    writeFileSync(doc, "export default 1;");
    writeFileSync(secret, "do not touch");
    g.grantOpened(doc);
    unlinkSync(doc);
    symlinkSync(secret, doc);
    expect(() => g.check(doc, "write")).toThrow(/access denied/);
    expect(() => g.check(doc, "read")).toThrow(/access denied/);
    // A path reached through a symlinked directory is the same file.
    const alias = join(tmp(), "alias");
    symlinkSync(dir, alias);
    g.grantOpened(join(dir, "b.cad.ts"));
    expect(() => g.check(join(alias, "b.cad.ts"), "read")).not.toThrow();
  });

  it("Clear Recent revokes the grants restored from the recent list, not this session's dialogs", () => {
    const g = new PathGrants();
    const dir = tmp();
    const old = join(dir, "old.cad.ts");
    const current = join(dir, "current.cad.ts");
    const mesh = join(dir, "mesh.stl");
    expect(g.grantRecent(old, canonicalPath(old))).toBe(true);
    expect(g.grantRecent(mesh, canonicalPath(mesh))).toBe(false); // not a document: never restored
    g.grantOpened(current);
    g.grantRecent(current, canonicalPath(current));
    expect(g.has(old, "write")).toBe(true);
    expect(g.has(mesh, "read")).toBe(false);
    g.revokeRecent();
    expect(() => g.check(old, "read")).toThrow(/access denied/);
    expect(() => g.check(current, "write")).not.toThrow();
  });

  it("a recent document swapped for a symlink between sessions does not get its grant back", () => {
    const dir = tmp();
    const listFile = join(dir, "recent-files.json");
    const doc = join(dir, "model.cad.ts");
    const other = join(dir, "other.cad.ts");
    const secret = join(dir, "secret.txt");
    writeFileSync(doc, "export default 1;");
    writeFileSync(other, "export default 2;");
    writeFileSync(secret, "do not touch");
    // Session 1: both documents were opened (ipc.ts records the canonical path it checked).
    const s1 = new PathGrants();
    const recent1 = new RecentFiles(listFile);
    for (const p of [other, doc]) recent1.add(p, s1.check(s1.grantOpened(p), "read"));

    // Between sessions: model.cad.ts becomes a symlink to a file the user never chose.
    unlinkSync(doc);
    symlinkSync(secret, doc);

    // Session 2: restore from the persisted list.
    const s2 = new PathGrants();
    const restored = new RecentFiles(listFile).entries().map((e) => [e.path, s2.grantRecent(e.path, e.real)]);
    expect(restored).toEqual([
      [doc, false],
      [other, true],
    ]);
    expect(s2.has(secret, "read")).toBe(false);
    expect(s2.has(secret, "write")).toBe(false);
    expect(() => s2.check(doc, "read")).toThrow(/access denied/);
    expect(() => s2.check(other, "write")).not.toThrow();
    // An entry from an older list (no canonical path recorded) is restored only if no symlink is involved.
    expect(new PathGrants().grantRecent(doc, null)).toBe(false);
    expect(new PathGrants().grantRecent(canonicalPath(other), null)).toBe(true);
  });

  it("doc:state may only name a granted path", () => {
    const g = new PathGrants();
    const dir = tmp();
    const doc = join(dir, "a.cad.ts");
    expect(documentStatePath("/etc/passwd", g)).toBeNull();
    expect(documentStatePath(42, g)).toBeNull();
    expect(documentStatePath(doc, g)).toBeNull();
    g.grantOpened(doc);
    expect(documentStatePath(doc, g)).toBe(doc);
  });
});

describe("L8: packaging hardening (electron-builder config)", () => {
  const require = createRequire(import.meta.url);
  const config = require(join(desktopRoot, "electron-builder.config.cjs")) as {
    electronFuses?: Record<string, boolean>;
    files: Array<string | { from: string; to: string; filter?: string[] }>;
    extraResources: Array<{ from: string; to: string; filter?: string[] }>;
    mac: { entitlements?: string; entitlementsInherit?: string; hardenedRuntime?: boolean };
    asar: boolean;
  };

  it("flips the Electron fuses", () => {
    expect(config.electronFuses).toEqual({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      enableCookieEncryption: true,
      grantFileProtocolExtraPrivileges: false,
      loadBrowserProcessSpecificV8Snapshot: false,
    });
    expect(config.asar).toBe(true);
  });

  it("signs with explicit entitlements that keep library validation", () => {
    expect(config.mac.hardenedRuntime).toBe(true);
    for (const f of [config.mac.entitlements, config.mac.entitlementsInherit]) {
      expect(f).toBeDefined();
      const plist = readFileSync(join(desktopRoot, f!), "utf8").replace(/<!--[\s\S]*?-->/g, "");
      // Exactly JIT: no disable-library-validation, dyld variables, unsigned memory or get-task-allow.
      expect([...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual(["com.apple.security.cs.allow-jit"]);
    }
  });

  it("puts the web app inside the integrity-checked asar, not in loose resources", () => {
    expect(config.files).toContainEqual(expect.objectContaining({ from: "../app/dist/web", to: "app-web" }));
    expect(config.extraResources.some((r) => r.to === "app-web")).toBe(false);
  });

  it("ships the MPL-2.0 text and the third-party notices (L15, L18, M11)", () => {
    const res = (to: string) => config.extraResources.find((r) => r.to === to);
    expect(res("LICENSE.txt")?.from).toBe("../../LICENSE-MPL-2.0");
    expect(res("THIRD_PARTY_NOTICES.txt")?.from).toBe("../app/dist/web/THIRD_PARTY_NOTICES.txt");
    expect(res("bin/THIRD_PARTY_LICENSES.txt")?.from).toBe("build/generated/aicad-THIRD_PARTY_LICENSES.txt");
    expect(existsSync(join(desktopRoot, "../../LICENSE-MPL-2.0"))).toBe(true);
  });
});
