/**
 * What a CLI run leaves behind, keyless and offline (docs/CLI-PROVIDERS.md §5.8, §12): Electron + the agent utility
 * process + FAKE `claude` binaries (no API key, no network, no real CLI, no login).
 *
 * - A used-up plan: Settings and the stopped run show the reset of the window that ran out (the 5-hour one), not the
 *   latest window's (the 7-day one resets days later, as in the recorded real Claude Code output).
 * - Quitting while a runtime phase is inside Claude Code's own loop: the CLI and its MCP server are killed, and the
 *   phase's workspace (its system prompt, attachments, the CLI's temp files) and broker socket folder are gone once
 *   the app has exited, not left for the 24-hour sweep.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { appDir } from "./app-dir.js";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(desktopRoot, "..", "..");
const FAKE = join(repo, "packages", "agent", "test", "fake-cli", "fake-claude.mjs");
const QUOTA_FAKE = join(desktopRoot, "test", "fixtures", "fake-claude-quota.mjs");
const HELP = join(desktopRoot, "e2e", "fixtures", "fake-cli", "claude-2.1.260-help.txt");
/** The 7-day window of the quota fake resets this much later than the used-up 5-hour one (`SEVEN_DAY_LATER_S`). */
const SEVEN_DAY_LATER_S = 226_200;

interface AW {
  __aicad: {
    execute(cmd: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;
    agent(): { lastRun: { result: { status: string; stopReason: string } | null } | null };
  };
}

function keylessEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /(API_?KEY|TOKEN|SECRET)/i.test(k) || /^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|CLAUDE_CODE|CODEX|CURSOR)_/.test(k) || k.startsWith("AICAD_")) continue;
    env[k] = v;
  }
  const appDist = process.env["AICAD_APP_DIST"];
  return { ...env, AICAD_AGENT_DOTENV: "off", AICAD_SKIP_CLOSE_PROMPT: "1", ...(appDist ? { AICAD_APP_DIST: appDist } : {}), ...extra };
}

const TRIAGE = [{ text: "", tool_calls: [{ name: "classify", arguments: { kind: "quick_edit", complexity: "T1", needs_clarification: false, reason: "one dimension of the open plate changes" } }] }];

let root: string;
let userData: string;
let binDir: string;
let rec: string;
let app: ElectronApplication | null = null;
let page: Page;
const pageErrors: string[] = [];

function jsonl<T>(name: string): T[] {
  const f = join(rec, name);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

/** Point `claude` at a fake (the app sees a changed binary and detects it again). */
function installClaude(script: string): void {
  writeFileSync(join(binDir, "claude"), `#!${process.execPath}\n${script}\n`);
  chmodSync(join(binDir, "claude"), 0o755);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const execute = (cmd: unknown) => page.evaluate((c) => (window as unknown as AW).__aicad.execute(c), cmd);

test.skip(process.platform === "win32", "the fake CLIs are POSIX scripts");
test.skip(!existsSync(FAKE) || !existsSync(join(repo, "packages", "mcp-server", "dist", "stdio.js")), "needs the agent's fake CLI and a built @aicad/mcp-server");

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "aicad-e2e-quit-"));
  binDir = join(root, "bin");
  rec = join(root, "rec");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(rec, { recursive: true });
  userData = join(root, "ud");
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, "agent-settings.json"), JSON.stringify({ v: 1, models: {}, budgetUsd: 1, compatBaseUrl: null, ollamaBaseUrl: "http://127.0.0.1:9", cliMode: "completion" }));
  app = await electron.launch({ args: [appDir, "--use-mock-keychain"], env: keylessEnv({ AICAD_USER_DATA_DIR: userData, AICAD_CLI_DIRS: binDir }) });
  page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await expect(page.getByTestId("app-shell")).toBeVisible();
  // The quit cleanup is surface-independent; the fake CLI scripts the CadScript designer, so the proposal path runs here.
  expect((await execute({ id: "agent.setSurface", args: { surface: "code" } })).ok).toBe(true);
  expect((await execute({ id: "file.newFromTemplate", args: { templateId: "t1-nema17-plate" } })).ok).toBe(true);
});

test.afterAll(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("a used-up plan shows the reset of the window that ran out, not the latest one", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 7200;
  const fiveHour = new Date(resetsAt * 1000).toISOString();
  const sevenDay = new Date((resetsAt + SEVEN_DAY_LATER_S) * 1000).toISOString();
  installClaude(`import(${JSON.stringify(pathToFileURL(QUOTA_FAKE).href)}).then((m) => m.main(${JSON.stringify({ help: HELP, resetsAt })}));`);
  await page.getByLabel("Message").fill("Make the plate 2 mm thicker");
  await page.getByLabel("Message").press("Enter");
  const card = page.getByTestId("agent-run").last();
  await expect(card.getByTestId("agent-headline")).toHaveText("Stopped: plan usage limit reached", { timeout: 60_000 });
  await expect(card.getByTestId("agent-result")).toContainText(fiveHour);
  await expect(card.getByTestId("agent-result")).not.toContainText(sevenDay);
  expect((await page.evaluate(() => (window as unknown as AW).__aicad.agent())).lastRun?.result).toMatchObject({ status: "failed", stopReason: "model_error" });
  expect((await execute({ id: "settings.open" })).ok).toBe(true);
  const dialog = page.getByTestId("settings-dialog");
  await expect(dialog).toContainText(`Claude Code: the plan's usage limit was reached at the last run (resets ${fiveHour}).`);
  await expect(dialog).not.toContainText(sevenDay);
  await page.keyboard.press("Escape");
  expect(pageErrors).toEqual([]);
});

test("quitting during a runtime phase kills the CLI and leaves no workspace behind", async () => {
  // Claude Code whose BUILD phase says one thing and then never finishes (it would run until the phase's time limit).
  const scenario = join(root, "scenario.json");
  writeFileSync(scenario, JSON.stringify({ completion: { triage: TRIAGE }, runtime: { build: { turns: [[{ text: "Looking at the plate outline." }, { hang: true }]] } }, recordDir: rec }));
  installClaude(`import(${JSON.stringify(pathToFileURL(FAKE).href)}).then((m) => m.main(${JSON.stringify(scenario)}));`);
  expect((await execute({ id: "settings.setCliMode", args: { mode: "runtime" } })).ok).toBe(true);
  await page.getByLabel("Message").fill("Make the plate 2 mm thicker");
  await page.getByLabel("Message").press("Enter");

  // The BUILD process is up, with the CAD MCP server connected, inside its own loop.
  await expect.poll(() => jsonl<{ phase: string }>("phases.jsonl").filter((p) => p.phase === "build").length, { timeout: 60_000 }).toBe(1);
  const phase = jsonl<{ phase: string; pid: number; mcpPid: number | null }>("phases.jsonl").find((p) => p.phase === "build")!;
  const inv = jsonl<{ mode: string; pid: number; cwd: string }>("invocations.jsonl").find((i) => i.mode === "runtime" && i.pid === phase.pid)!;
  const holder = dirname(inv.cwd);
  const workRoot = dirname(holder);
  expect(existsSync(inv.cwd)).toBe(true);
  expect(readdirSync(join(workRoot, "s")).length).toBeGreaterThan(0); // the broker's socket folder
  expect(alive(phase.pid)).toBe(true);
  expect(pageErrors).toEqual([]);

  const closing = app!;
  app = null;
  await closing.close(); // quit mid-phase: `will-quit` → AgentHost.dispose

  expect(existsSync(holder)).toBe(false);
  expect(existsSync(workRoot) ? readdirSync(workRoot).filter((n) => /^[0-9a-f]{8,16}$/.test(n)) : []).toEqual([]);
  expect(existsSync(join(workRoot, "s")) ? readdirSync(join(workRoot, "s")) : []).toEqual([]);
  await expect.poll(() => alive(phase.pid), { timeout: 10_000 }).toBe(false);
  if (phase.mcpPid !== null) await expect.poll(() => alive(phase.mcpPid!), { timeout: 10_000 }).toBe(false);
});
