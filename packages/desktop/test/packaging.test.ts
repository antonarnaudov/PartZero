/**
 * Packaging for Alpha 0 (docs/ALPHA-0-PLAN.md W1): the build editions and the alpha builder config, the build info a
 * bundle carries, where a bundled build finds its files, the log files, the user folders (D4), and the electron-free
 * parts of `--self-test`. The base config's own pins stay in hardening.test.ts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSettingsView, CliProviderStatus } from "@aicad/app/bridge";
import { describe, expect, it } from "vitest";
import { summarizeReport, workerSelfTest } from "../src/agent/self-test.js";
import { loadMcpServer } from "../src/agent/optional-modules.js";
import { parseWorkerMessage } from "../src/agent/protocol.js";
import { DEV_BUILD_INFO, mcpShimExecutable, parseBuildInfo, readBuildInfo, type BuildInfo } from "../src/build-info.js";
import { bundledMcpShimPath, bundledPromptsDir, bundledWasmPath, unpackedPath } from "../src/bundle-paths.js";
import { formatConsoleArgs, logFor, RotatingLog } from "../src/log-file.js";
import { claudeCodeCheck, detectBambuStudio, rendererReady, selfTestVerdict, type RendererSnapshot, type SelfTestReport } from "../src/self-test.js";
import { ensureUserFolder, userFolders } from "../src/user-folders.js";
import { tempDirs } from "./temp-dirs.js";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const repo = join(desktopRoot, "..", "..");
const require = createRequire(import.meta.url);
const tmp = tempDirs("aicad-packaging-test-");

interface BuilderConfig {
  appId: string;
  productName: string;
  files: Array<string | { from: string; to: string; filter?: string[] }>;
  extraMetadata?: Record<string, string>;
  asarUnpack?: string[];
  extraResources: Array<{ from: string; to: string }>;
  electronFuses: Record<string, boolean>;
  directories: { output: string };
  mac: { target: Array<{ target: string; arch: string[] }>; identity?: string | null; hardenedRuntime?: boolean; entitlements?: string };
}
type Edition = { productName: string; appId: string; flags: BuildInfo["flags"] };

const base = require(join(desktopRoot, "electron-builder.config.cjs")) as BuilderConfig;
const alpha = require(join(desktopRoot, "electron-builder.alpha-local.cjs")) as BuilderConfig;
const editions = require(join(desktopRoot, "editions.cjs")) as Record<string, Edition>;

describe("builder configs: the tested base and the local Alpha 0 build", () => {
  it("both package the bundle (no node_modules, no dist/), with the MCP shim unpacked and no source maps", () => {
    for (const c of [base, alpha]) {
      expect(c.files).toContain("bundle/**/*");
      expect(c.files).not.toContain("dist/**/*");
      expect(c.files).toContainEqual({ from: "../app/dist/web", to: "app-web", filter: ["**/*", "!**/*.map"] });
      expect(c.extraMetadata?.["main"]).toBe("bundle/main.js");
      expect(c.asarUnpack).toEqual(["bundle/mcp/**"]);
      expect(c.extraResources).toContainEqual({ from: "bundle/THIRD_PARTY_NOTICES.txt", to: "THIRD_PARTY_NOTICES-desktop.txt" });
    }
    // Nothing for electron-builder to copy into the app: the bundle inlines every package.
    const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it("the alpha config is PartZero (D2): arm64 .app only, ad-hoc signed, no hardened runtime or entitlements", () => {
    expect(alpha.productName).toBe("PartZero");
    expect(alpha.appId).toBe("ai.partzero.desktop");
    expect(alpha.extraMetadata?.["productName"]).toBe("PartZero");
    expect(alpha.mac).toEqual({ target: [{ target: "dir", arch: ["arm64"] }], category: "public.app-category.graphics-design", identity: "-", hardenedRuntime: false, gatekeeperAssess: false });
    expect(alpha.directories.output).toBe("release/alpha-local");
  });

  it("the alpha fuses differ from the base in exactly runAsNode on (D1) and cookie encryption off (as10)", () => {
    const { runAsNode, enableCookieEncryption, resetAdHocDarwinSignature, ...rest } = alpha.electronFuses;
    expect({ runAsNode, enableCookieEncryption, resetAdHocDarwinSignature }).toEqual({ runAsNode: true, enableCookieEncryption: false, resetAdHocDarwinSignature: true });
    const { runAsNode: _r, enableCookieEncryption: _c, ...baseRest } = base.electronFuses;
    expect(rest).toEqual(baseRest);
    expect(base.electronFuses["runAsNode"]).toBe(false);
  });

  it("each config names its app as its edition does, and runs the MCP shim only where the runAsNode fuse allows it", () => {
    for (const [config, id] of [
      [base, "default"],
      [alpha, "alpha-local"],
    ] as const) {
      const e = editions[id]!;
      expect(config.productName).toBe(e.productName);
      expect(config.appId).toBe(e.appId);
      expect(e.flags.mcpShim).toBe(config.electronFuses["runAsNode"]);
    }
    expect(editions["alpha-local"]!.flags).toEqual({ apiKeys: false, mcpShim: true });
    expect(editions["default"]!.flags).toEqual({ apiKeys: true, mcpShim: false });
  });
});

describe("build info (bundle/build-info.json)", () => {
  const valid = { edition: "alpha-local", productName: "PartZero", appId: "ai.partzero.desktop", version: "0.0.1", commit: "2487380265ab", dirty: false, builtAt: "2026-09-25T00:00:00.000Z", flags: { apiKeys: false, mcpShim: true } };

  it("parses a valid file and drops unknown fields", () => {
    expect(parseBuildInfo({ ...valid, extra: 1 })).toEqual(valid);
    expect(parseBuildInfo({ ...valid, commit: null, builtAt: null })).toMatchObject({ commit: null, builtAt: null });
  });

  it("rejects a product name that is not a plain folder name, a bad app id, commit or flags", () => {
    for (const bad of [
      { productName: "../Library" },
      { productName: "Part/Zero" },
      { appId: "PartZero" },
      { commit: "not-a-sha" },
      { flags: { apiKeys: "no", mcpShim: true } },
      { flags: undefined },
      { dirty: "yes" },
    ]) {
      expect(parseBuildInfo({ ...valid, ...bad }), JSON.stringify(bad)).toBeNull();
    }
  });

  it("no file is a development run; an invalid file stops the app instead of silently acting like development", () => {
    const dir = tmp();
    expect(readBuildInfo(dir)).toBe(DEV_BUILD_INFO);
    writeFileSync(join(dir, "build-info.json"), "{");
    expect(() => readBuildInfo(dir)).toThrow(/not JSON/);
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ ...valid, productName: "" }));
    expect(() => readBuildInfo(dir)).toThrow(/not a valid build info/);
    writeFileSync(join(dir, "build-info.json"), JSON.stringify(valid));
    expect(readBuildInfo(dir)).toEqual(valid);
  });

  it("development keeps today's behavior: aicad, API keys, and the shim only when unpackaged", () => {
    expect(DEV_BUILD_INFO).toMatchObject({ productName: "aicad", flags: { apiKeys: true, mcpShim: false } });
    expect(mcpShimExecutable(DEV_BUILD_INFO, false, "/x/Electron")).toBe("/x/Electron");
    expect(mcpShimExecutable(DEV_BUILD_INFO, true, "/x/aicad")).toBeNull();
    expect(mcpShimExecutable(parseBuildInfo(valid)!, true, "/Applications/PartZero.app/Contents/MacOS/PartZero")).toBe("/Applications/PartZero.app/Contents/MacOS/PartZero");
  });
});

describe("bundle paths", () => {
  it("maps a file inside app.asar to its unpacked copy", () => {
    const asar = ["", "Applications", "PartZero.app", "Contents", "Resources", "app.asar", "bundle", "mcp", "stdio.mjs"].join(sep);
    expect(unpackedPath(asar)).toBe(asar.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`));
    expect(unpackedPath(join(desktopRoot, "bundle", "mcp", "stdio.mjs"))).toBe(join(desktopRoot, "bundle", "mcp", "stdio.mjs"));
  });

  it("finds the bundled shim, prompts and WASM next to the code, and nothing in an unbundled dist/", () => {
    const yes = (): boolean => true;
    const no = (): boolean => false;
    const main = join("/r", "app.asar", "bundle");
    expect(bundledMcpShimPath(main, yes)).toBe(join("/r", "app.asar.unpacked", "bundle", "mcp", "stdio.mjs"));
    expect(bundledPromptsDir(join(main, "agent"), yes)).toBe(join(main, "prompts"));
    expect(bundledWasmPath(join(main, "agent"), yes)).toBe(join(main, "agent", "forge_wasm_bg.wasm"));
    expect([bundledMcpShimPath(main, no), bundledPromptsDir(main, no), bundledWasmPath(main, no)]).toEqual([null, null, null]);
    expect(bundledPromptsDir(join(desktopRoot, "dist", "agent"))).toBeNull();
  });
});

describe("log files", () => {
  it("scrubs key-like strings, prefixes time and level, and rotates by size keeping N old files", () => {
    const dir = tmp();
    const file = join(dir, "logs", "main.log");
    const log = new RotatingLog(file, { maxBytes: 200, keep: 2, now: () => new Date("2026-09-25T10:00:00Z") });
    log.write("warn", "401 from provider: sk-ant-abcdefghijklmnopqrstuvwxyz0123");
    const first = readFileSync(file, "utf8");
    expect(first).toBe("2026-09-25T10:00:00.000Z warn  401 from provider: sk-an…[redacted]\n");
    for (let i = 0; i < 12; i++) log.write("info", `line ${i} ${"x".repeat(40)}`);
    const names = readdirSync(join(dir, "logs")).sort();
    expect(names).toEqual(["main.log", "main.log.1", "main.log.2"]);
    for (const n of names) expect(statSync(join(dir, "logs", n)).size).toBeLessThanOrEqual(200);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("line 11");
  });

  it("never throws when it cannot write", () => {
    const dir = tmp();
    writeFileSync(join(dir, "blocker"), "a file where the log folder should be");
    const log = new RotatingLog(join(dir, "blocker", "main.log"));
    expect(() => log.write("error", "x")).not.toThrow();
  });

  it("routes the agent's lines to agent.log and formats console arguments", () => {
    expect(logFor("[aicad-agent] run started")).toBe("agent");
    expect(logFor("[aicad] renderer process gone")).toBe("main");
    expect(formatConsoleArgs(["a", 1, { b: 2 }])).toBe('a 1 {"b":2}');
    expect(formatConsoleArgs([new Error("boom")])).toContain("Error: boom");
  });
});

describe("user folders (D4)", () => {
  it("prints and reports live in ~/PartZero, created on first use; a symlink or file there is refused", () => {
    const home = tmp();
    const f = userFolders(home);
    expect(f).toEqual({ root: join(home, "PartZero"), prints: join(home, "PartZero", "Prints"), reports: join(home, "PartZero", "Reports") });
    expect(existsSync(f.root)).toBe(false);
    expect(ensureUserFolder(f.prints, f.root)).toBe(f.prints);
    expect(statSync(f.prints).isDirectory()).toBe(true);
    expect(ensureUserFolder(f.prints, f.root)).toBe(f.prints);
    const elsewhere = tmp();
    symlinkSync(elsewhere, f.reports);
    expect(() => ensureUserFolder(f.reports, f.root)).toThrow(/not a folder/);
    const home2 = tmp();
    writeFileSync(join(home2, "PartZero"), "a file");
    expect(() => ensureUserFolder(userFolders(home2).prints, userFolders(home2).root)).toThrow(/not a folder/);
  });
});

describe("--self-test (electron-free parts)", () => {
  const snapshot: RendererSnapshot = {
    url: "app://aicad/index.html",
    shell: true,
    crossOriginIsolated: true,
    engine: "forge-web · wasm",
    features: [
      { name: "base", status: "ok" },
      { name: "block", status: "ok" },
    ],
    bodies: "1 body",
    problems: "0",
  };

  it("the renderer is ready once the starting document evaluated in an isolated page", () => {
    expect(rendererReady(snapshot)).toBe(true);
    expect(rendererReady({ ...snapshot, features: [] })).toBe(false);
    expect(rendererReady({ ...snapshot, features: [{ name: "block", status: "error" }] })).toBe(false);
    expect(rendererReady({ ...snapshot, crossOriginIsolated: false })).toBe(false);
    expect(rendererReady({ ...snapshot, bodies: "0 bodies" })).toBe(false);
    expect(rendererReady(null)).toBe(false);
  });

  const claude = (s: Partial<CliProviderStatus>): Pick<AgentSettingsView, "cli" | "autoDefault"> => ({
    cli: [
      {
        id: "claude-cli",
        label: "Claude Code",
        installed: true,
        path: "/Users/me/.local/bin/claude",
        pathSource: "known-dir",
        version: "2.1.260",
        support: "ready",
        supportDetail: "",
        lockdownLevel: "verified",
        residualRisks: [],
        auth: "logged_in",
        plan: "max",
        billing: "subscription",
        loginHint: "Run `claude auth login` in a terminal",
        modes: ["completion", "runtime"],
        planUsage: null,
        checkedAt: null,
        ...s,
      },
    ],
    autoDefault: { provider: "claude-cli", label: "Claude Code" },
  });

  it("Claude Code passes only when found, runnable and logged in", () => {
    expect(claudeCodeCheck(claude({}))).toMatchObject({ ok: true, version: "2.1.260", lockdownLevel: "verified", autoDefault: "Claude Code" });
    expect(claudeCodeCheck(claude({})).detail).toBe("Claude Code 2.1.260 at /Users/me/.local/bin/claude (known-dir), verified lockdown, logged in (max plan)");
    expect(claudeCodeCheck(claude({ auth: "logged_out" }))).toMatchObject({ ok: false, detail: expect.stringContaining("claude auth login") });
    expect(claudeCodeCheck(claude({ installed: false, support: "not_installed", supportDetail: "not found" }))).toMatchObject({ ok: false, detail: "not installed: not found" });
    expect(claudeCodeCheck(claude({ support: "blocked", supportDetail: "Stopped after a lockdown violation" })).ok).toBe(false);
    expect(claudeCodeCheck(null, "detection failed: x")).toMatchObject({ ok: false, detail: "detection failed: x" });
  });

  it("the verdict lists every failed required check; a missing slicer and a dirty tree are warnings", () => {
    const ok = { ok: true, detail: "" };
    const body: Omit<SelfTestReport, "ok" | "failures" | "warnings" | "schema"> = {
      app: { name: "PartZero", version: "0.0.1", edition: "alpha-local", commit: "abcdef1", dirty: true, builtAt: null, packaged: true, flags: { apiKeys: false, mcpShim: true }, electron: "", chrome: "", node: "", platform: "darwin", arch: "arm64" },
      paths: { profile: "", logs: "", prints: "", reports: "" },
      forgeCli: { ok: true, path: "/x/aicad", version: "aicad 0.0.1", detail: "", v0: null, v1: null },
      worker: {
        ok: true,
        detail: "",
        readyMs: 1,
        report: {
          cadscript: ok,
          engine: { ...ok, wasm: null },
          v0: { ...ok, schema: "aicad.metrics/0", status: "ok", bodies: 1, volume: 32000 },
          v1: { ok: false, detail: "UNSUPPORTED_SCHEMA", schema: null, status: null, bodies: 0, volume: null },
          prompts: { ...ok, dir: "", ids: [] },
          mcp: { ok: false, detail: "missing", shim: null },
          cliRuntime: ok,
        },
      },
      renderer: { ok: true, detail: "", ms: 1, snapshot },
      claudeCode: claudeCodeCheck(claude({ auth: "logged_out" })),
      slicer: { found: false, name: "Bambu Studio", path: null, bundleId: null, version: null },
    };
    const v = selfTestVerdict(body);
    expect(v.ok).toBe(false);
    expect(v.failures).toEqual(["v1 evaluation (forge-web): UNSUPPORTED_SCHEMA", "CAD MCP server: missing", expect.stringMatching(/^Claude Code: installed but not logged in/)]);
    expect(v.warnings).toEqual([expect.stringMatching(/^Bambu Studio was not found/), "the build was bundled from a working tree with uncommitted changes"]);
    // A packaged build that does not run the shim only warns about it.
    const noShim = selfTestVerdict({ ...body, app: { ...body.app, flags: { apiKeys: true, mcpShim: false } } });
    expect(noShim.failures.some((f) => f.startsWith("CAD MCP"))).toBe(false);
    expect(noShim.warnings.some((w) => w.startsWith("CAD MCP"))).toBe(true);
  });

  it("finds Bambu Studio where the user installed it and reads its version and bundle id", async () => {
    const calls: string[][] = [];
    const exec = async (file: string, args: readonly string[]): Promise<{ code: number; stdout: string }> => {
      calls.push([file, ...args]);
      return { code: 0, stdout: args[1] === "CFBundleIdentifier" ? "com.bambulab.bambu-studio\n" : "02.06.00.51\n" };
    };
    const found = await detectBambuStudio({ home: "/Users/me", exists: (p) => p === join("/Users/me", "Applications", "BambuStudio.app", "Contents", "Info.plist"), exec });
    expect(found).toEqual({ found: true, name: "Bambu Studio", path: join("/Users/me", "Applications", "BambuStudio.app"), bundleId: "com.bambulab.bambu-studio", version: "02.06.00.51" });
    expect(calls[0]).toEqual(["/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", join("/Users/me", "Applications", "BambuStudio.app", "Contents", "Info.plist")]);
    expect(await detectBambuStudio({ home: "/Users/me", exists: () => false, exec })).toMatchObject({ found: false, path: null });
  });

  it("summarizes v0 (last body feature) and v1 (final part bodies) reports", () => {
    expect(summarizeReport({ schema: "aicad.metrics/0", status: "ok", features: [{}, { bodies: [{ volume: 10 }, { volume: 5 }] }] })).toEqual({ schema: "aicad.metrics/0", status: "ok", bodies: 2, volume: 15 });
    expect(summarizeReport({ schema: "aicad.metrics/1", status: "ok", parts: [{ bodies: [{ volume: 32000 }] }], features: [] })).toEqual({ schema: "aicad.metrics/1", status: "ok", bodies: 1, volume: 32000 });
    expect(summarizeReport({ schema: "aicad.metrics/1", status: "error" })).toEqual({ schema: "aicad.metrics/1", status: "error", bodies: 0, volume: null });
  });

  it("parses the worker's selftest answer", () => {
    expect(parseWorkerMessage({ v: 1, type: "selftest", report: { cadscript: { ok: true } } })).toMatchObject({ type: "selftest" });
    expect(parseWorkerMessage({ v: 1, type: "selftest", report: null })).toBeNull();
  });

  const wasmBuilt = existsSync(join(repo, "packages", "forge-web", "pkg", "forge_wasm_bg.wasm"));
  it.skipIf(!wasmBuilt || !existsSync(join(repo, "packages", "mcp-server", "dist", "stdio.js")))(
    "the worker's checks pass on the workspace build: CadScript, forge-web v0 and v1, prompts, MCP host, runtime",
    async () => {
      const r = await workerSelfTest({ mcpShimPath: null, mcpServerDir: join(repo, "packages", "mcp-server"), workerDir: join(desktopRoot, "dist", "agent") });
      expect(r.cadscript).toMatchObject({ ok: true });
      expect(r.engine.ok).toBe(true);
      expect(r.v0).toMatchObject({ ok: true, schema: "aicad.metrics/0", bodies: 1 });
      expect(r.v1).toMatchObject({ ok: true, schema: "aicad.metrics/1", bodies: 1 });
      expect(r.prompts).toMatchObject({ ok: true, dir: "(package default)" });
      expect(r.prompts.ids.map((i) => i.split("@")[0])).toEqual(["triage.v1", "spec_writer.v1", "designer.v1"]);
      expect(r.mcp).toMatchObject({ ok: true, shim: join(repo, "packages", "mcp-server", "dist", "stdio.js") });
      expect(r.cliRuntime.ok).toBe(true);
    },
    60_000,
  );
});

describe("optional modules in a bundled build", () => {
  it("a bundled shim path loads the MCP host bundled into the worker; a missing shim is no MCP server", async () => {
    const dir = tmp();
    const shim = join(dir, "mcp", "stdio.mjs");
    mkdirSync(join(dir, "mcp"));
    writeFileSync(shim, "");
    const loaded = await loadMcpServer(null, shim);
    expect(loaded?.stdio).toBe(shim);
    expect(typeof loaded?.module.createMcpHost).toBe("function");
    expect(await loadMcpServer(null, join(dir, "nope.mjs"))).toBeNull();
  });
});
