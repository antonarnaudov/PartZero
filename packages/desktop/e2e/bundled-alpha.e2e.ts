/**
 * The Alpha 0 bundle (docs/ALPHA-0-PLAN.md W1, G2a pattern): `scripts/bundle.mjs --edition alpha-local` — the exact
 * main process, preload, agent worker and MCP shim PartZero.app packages — launched by the development Electron in
 * packaged mode (`AICAD_SIMULATE_PACKAGED=1`; Playwright cannot attach to the packaged app itself), keyless and
 * offline, with a FAKE Claude Code (fake-cli.ts) standing in for the real one.
 *
 * - The app is PartZero: its name, window title and log files (`main.log`, `agent.log`) come from the bundle's build
 *   info; the renderer loads app://, cross-origin isolated, and Forge evaluates the starting document (any shape).
 * - Settings: Claude Code detected and used by default, and no API-key entry anywhere.
 * - Open in Bambu Studio (W5) in the bundle: the checked, centred 3MF lands in the profile's Prints folder and is handed
 *   to a FAKE Bambu Studio through a fake `open` (the test never launches the real one).
 * - `--self-test` on the bundle: every check passes, with the bundled prompts and the bundled MCP shim run end to end,
 *   and it finds Bambu Studio the way Open in Bambu Studio does.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { desktopRoot } from "./app-dir.js";
import type { SelfTestReport } from "../src/self-test.js";
import { makeFakeClaude, type FakeClaude } from "./fake-cli.js";

const bundleDir = join(desktopRoot, "test-results", "bundle-alpha-local");
const appDist = join(desktopRoot, "..", "app", "dist", "web");
const electronBinary = createRequire(import.meta.url)("electron") as unknown as string;

function keylessEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /(API_?KEY|TOKEN|SECRET)/i.test(k) || /^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|CLAUDE_CODE|CODEX|CURSOR)_/.test(k) || k.startsWith("AICAD_")) continue;
    env[k] = v;
  }
  return { ...env, AICAD_AGENT_DOTENV: "off", AICAD_SKIP_CLOSE_PROMPT: "1", AICAD_APP_DIST: appDist, ...extra };
}

/** A fresh profile whose Ollama probe points at a closed port (a local Ollama must not change the result). */
function profile(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent-settings.json"), JSON.stringify({ v: 1, models: {}, budgetUsd: 1, compatBaseUrl: null, ollamaBaseUrl: "http://127.0.0.1:9" }));
  return dir;
}

/** A fake BambuStudio.app (only its Info.plist) in `<root>/Applications`, and an `open` that records its arguments. */
function fakeSlicer(dir: string): { apps: string; app: string; openBin: string; openLog: string } {
  const apps = join(dir, "Applications");
  const app = join(apps, "BambuStudio.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>CFBundleIdentifier</key>\n  <string>com.bambulab.bambu-studio</string>\n  <key>CFBundleShortVersionString</key>\n  <string>02.06.00.51</string>\n</dict>\n</plist>\n',
  );
  const openLog = join(dir, "open-args.txt");
  const openBin = join(dir, "fake-open");
  writeFileSync(openBin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${openLog}"\nexit 0\n`);
  chmodSync(openBin, 0o755);
  return { apps, app, openBin, openLog };
}

let root: string;
let fake: FakeClaude;
let slicer: ReturnType<typeof fakeSlicer>;
let userData: string;
let app: ElectronApplication;
let page: Page;
const pageErrors: string[] = [];

test.skip(process.platform === "win32", "the fake CLI is a POSIX script");

test.beforeAll(async () => {
  const b = spawnSync(process.execPath, ["scripts/bundle.mjs", "--edition", "alpha-local", "--out", bundleDir], { cwd: desktopRoot, encoding: "utf8" });
  expect(b.status, b.stderr).toBe(0);
  root = mkdtempSync(join(tmpdir(), "aicad-e2e-alpha-"));
  fake = makeFakeClaude(join(root, "fake"));
  slicer = fakeSlicer(join(root, "slicer"));
  userData = profile(root, "user-data");
  app = await electron.launch({
    args: [bundleDir, "--use-mock-keychain"],
    env: keylessEnv({
      AICAD_USER_DATA_DIR: userData,
      AICAD_CLI_DIRS: fake.binDir,
      AICAD_SIMULATE_PACKAGED: "1",
      AICAD_ALLOW_DEBUGGER: "1",
      AICAD_SLICER_DIRS: slicer.apps,
      AICAD_OPEN_BIN: slicer.openBin,
    }),
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.message));
});

test.afterAll(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the bundle runs as PartZero: renderer on app://, Forge evaluates the starting document, logs written", async () => {
  await expect(page.getByTestId("app-shell")).toBeVisible();
  expect(page.url()).toBe("app://aicad/index.html");
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => typeof (window as unknown as { __aicad?: unknown }).__aicad)).toBe("undefined");
  await expect(page.getByTestId("engine-label")).toHaveText(/forge-web · wasm/);
  // Forge evaluated the starting document, whatever it is (a block today, empty once W2 lands): "Up to date" needs an
  // evaluation with status ok, not only a compile.
  await expect(page.getByTestId("doc-status")).toHaveText(/^Up to date/);
  await expect(page.getByTestId("problems-count")).toHaveText("0");
  const features = page.getByTestId("timeline-feature");
  const count = await features.count();
  for (const f of await features.all()) await expect(f).toHaveAttribute("data-status", "ok");
  await expect(page.getByTestId("body-count")).toHaveText(count === 0 ? "0 bodies" : /^[1-9]\d* bod(y|ies)$/);

  const info = await app.evaluate(({ app: a, BrowserWindow }) => ({ name: a.getName(), userData: a.getPath("userData"), logs: a.getPath("logs"), title: BrowserWindow.getAllWindows()[0]?.getTitle() }));
  expect(info.name).toBe("PartZero");
  expect(info.userData).toBe(userData);
  expect(realpathSync(info.logs)).toBe(realpathSync(join(userData, "logs")));
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle())).toMatch(/ — PartZero$/);
  const mainLog = join(userData, "logs", "main.log");
  expect(existsSync(mainLog)).toBe(true);
  expect(readFileSync(mainLog, "utf8")).toMatch(/PartZero 0\.0\.1 \(alpha-local, [0-9a-f]+/);
  expect(pageErrors).toEqual([]);
});

test("Settings: Claude Code detected and used by default, and no API-key entry", async () => {
  await page.getByRole("banner").getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByTestId("settings-dialog");
  await expect(dialog).toBeVisible();
  const claude = dialog.locator('[data-testid="settings-cli"][data-provider="claude-cli"]');
  await expect(claude).toHaveAttribute("data-support", "ready");
  await expect(claude).toHaveAttribute("data-auth", "logged_in");
  await expect(claude).toContainText("2.1.260");
  await expect(dialog.getByTestId("settings-auto-default")).toContainText("Using Claude Code (detected)");
  await expect(dialog.getByTestId("settings-keys")).toHaveCount(0);
  await expect(dialog.getByTestId("settings-key")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Open in Bambu Studio in the bundle: the checked, centred 3MF and its receipt in Prints, handed to Bambu Studio", async () => {
  await page.getByRole("button", { name: "New from template" }).click();
  await page.getByLabel("Search templates").fill("nema 17");
  await page.locator('[data-template="t1-nema17-plate"]').click();
  await expect(page.getByTestId("problems-count")).toHaveText("0");
  await page.getByTestId("open-in-slicer").click();
  const toast = page.getByTestId("toasts").locator(".toast").last();
  await expect(toast).toContainText(/Sent t1-nema17-plate-[0-9a-f]{8}\.3mf to Bambu Studio\./);
  const prints = join(userData, "Prints");
  const threeMf = readdirSync(prints).find((f) => f.endsWith(".3mf"))!;
  const receipt = JSON.parse(readFileSync(join(prints, threeMf.replace(/\.3mf$/, ".receipt.json")), "utf8"));
  expect(receipt).toMatchObject({ schema: "partzero.receipt/1", app: { name: "PartZero" }, printer: { id: "builtin:bambu-p2s-0.4" }, checks: { report: "ok", valid: true, watertight: true, bodies: 1 } });
  expect((receipt.bbox.onBed.min[0] + receipt.bbox.onBed.max[0]) / 2).toBeCloseTo(128, 6);
  expect((receipt.bbox.onBed.min[1] + receipt.bbox.onBed.max[1]) / 2).toBeCloseTo(128, 6);
  expect(receipt.bbox.onBed.min[2]).toBe(0);
  expect(readFileSync(slicer.openLog, "utf8").split("\n").filter(Boolean)).toEqual(["-a", slicer.app, join(prints, threeMf)]);
});

test("--self-test on the bundle passes: aicad, worker (CadScript, forge-web v0/v1, prompts, MCP shim), renderer, Claude Code", () => {
  const r = spawnSync(electronBinary, [bundleDir, "--self-test"], {
    encoding: "utf8",
    timeout: 180_000,
    env: keylessEnv({ AICAD_USER_DATA_DIR: profile(root, "self-test-real-profile"), AICAD_CLI_DIRS: fake.binDir, AICAD_SIMULATE_PACKAGED: "1", AICAD_SLICER_DIRS: slicer.apps }),
  });
  let report: SelfTestReport;
  try {
    report = JSON.parse(r.stdout) as SelfTestReport;
  } catch {
    throw new Error(`no JSON report (exit ${r.status}); stderr:\n${r.stderr}`);
  }
  expect(report.failures, JSON.stringify(report, null, 2)).toEqual([]);
  expect(r.status).toBe(0);
  expect(report.ok).toBe(true);
  expect(report.app).toMatchObject({ name: "PartZero", edition: "alpha-local", flags: { apiKeys: false, mcpShim: true } });
  expect(report.forgeCli).toMatchObject({ ok: true, v0: { schema: "aicad.metrics/0", status: "ok" }, v1: { schema: "aicad.metrics/1", status: "ok" } });
  const w = report.worker.report!;
  expect(w.engine.wasm).toBe(join(bundleDir, "agent", "forge_wasm_bg.wasm"));
  expect(w.prompts.dir).toBe(join(bundleDir, "prompts"));
  expect(w.mcp.shim).toBe(join(bundleDir, "mcp", "stdio.mjs"));
  // The shim ran end to end as a CLI starts it (the Electron binary as Node) and reached the broker with its ticket.
  expect(w.mcp, w.mcp.detail).toMatchObject({ ok: true, exe: expect.any(String) });
  expect(w.mcp.detail).toMatch(/^the shim \(ELECTRON_RUN_AS_NODE=1 Electron stdio\.mjs\) answered initialize, tools\/list and tools\/call through the broker/);
  expect([w.cadscript.ok, w.v0.ok, w.v1.ok, w.cliRuntime.ok]).toEqual([true, true, true, true]);
  expect(report.renderer).toMatchObject({ ok: true, snapshot: { url: "app://aicad/index.html", crossOriginIsolated: true, engine: "forge-web · wasm", problems: "0", status: expect.stringMatching(/^Up to date/) } });
  expect(report.claudeCode).toMatchObject({ ok: true, version: "2.1.260", auth: "logged_in", autoDefault: "Claude Code" });
  // The same detection as Open in Bambu Studio (slicer.ts), in the test profile's own folders only.
  expect(report.slicer).toMatchObject({ found: true, path: slicer.app, version: "02.06.00.51", source: "applications" });
});

test("--self-test that cannot finish in time still prints a failing report and exits (watchdog)", () => {
  const r = spawnSync(electronBinary, [bundleDir, "--self-test"], {
    encoding: "utf8",
    timeout: 60_000,
    env: keylessEnv({ AICAD_USER_DATA_DIR: profile(root, "self-test-watchdog"), AICAD_CLI_DIRS: fake.binDir, AICAD_SIMULATE_PACKAGED: "1", AICAD_SELF_TEST_TIMEOUT_MS: "1" }),
  });
  expect(r.status, r.stderr).toBe(2);
  const report = JSON.parse(r.stdout) as SelfTestReport;
  expect(report).toMatchObject({ ok: false, failures: ["the self-test did not finish within 0.001 s"], app: { name: "PartZero", edition: "alpha-local" } });
  expect(report.worker.detail).toBe("not finished: the self-test did not finish within 0.001 s");
});
