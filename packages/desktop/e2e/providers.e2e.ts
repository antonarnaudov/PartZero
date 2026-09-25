/**
 * Providers end to end, keyless and offline (ADR 0014): Electron + the agent utility process + the gateway's CLI
 * transport + a FAKE `claude` (fake-cli.ts) that stands in for Claude Code 2.1.260. No API key, no network, no real
 * CLI and no login are needed, so CI can run it; `AICAD_CLI_DIRS` makes detection look only at the fake's folder.
 *
 * - Settings: Claude Code detected (version, verified lockdown, "Logged in · Max plan"), the other CLIs "Not
 *   installed", local models, API keys optional, and the defaults taken from Claude Code ("Using Claude Code
 *   (detected)").
 * - A run on the NEMA 17 template with no key: progress, the question card, "≈ $… plan usage", the proposal, accept.
 *   Every model call was one locked-down CLI invocation (checked from what the fake recorded).
 * - A logged-out CLI: the run is refused with the login command and "Open Settings"; Re-check picks up the login.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { makeFakeClaude, type FakeClaude } from "./fake-cli.js";
import { appDir } from "./app-dir.js";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Review screenshots (gitignored). */
const artifacts = join(desktopRoot, "test-results");

interface Summary {
  bbox: { min: number[]; max: number[] } | null;
  problems: unknown[];
}

interface AgentSummary {
  activeRunId: string | null;
  lastRun: { status: string; phases: string[]; spentUsd: number; result: { status: string; stopReason: string; changed: boolean } | null; error: string | null } | null;
}

/** `window.__aicad` as this suite uses it. */
interface AW {
  __aicad: {
    execute(cmd: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;
    idle(): Promise<Summary>;
    agent(): AgentSummary;
  };
}

/** The environment without any provider key or CLI token: this suite must never reach a real model. */
function keylessEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /(API_?KEY|TOKEN|SECRET)/i.test(k) || /^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|CLAUDE_CODE|CODEX|CURSOR)_/.test(k) || k.startsWith("AICAD_")) continue;
    env[k] = v;
  }
  return { ...env, AICAD_AGENT_DOTENV: "off", AICAD_SKIP_CLOSE_PROMPT: "1", ...extra };
}

let app: ElectronApplication;
let page: Page;
let root: string;
let fake: FakeClaude;
const pageErrors: string[] = [];

test.skip(process.platform === "win32", "the fake CLI is a POSIX script");

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "aicad-e2e-providers-"));
  fake = makeFakeClaude(join(root, "fake"), { delayMs: 120 });
  const userData = join(root, "user-data");
  mkdirSync(userData, { recursive: true });
  // A local Ollama on this machine must not change the result: point the probe at a closed loopback port.
  writeFileSync(join(userData, "agent-settings.json"), JSON.stringify({ v: 1, models: {}, budgetUsd: 1, compatBaseUrl: null, ollamaBaseUrl: "http://127.0.0.1:9" }));
  app = await electron.launch({
    args: [appDir, "--use-mock-keychain"],
    env: keylessEnv({ AICAD_USER_DATA_DIR: userData, AICAD_CLI_DIRS: fake.binDir }),
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1480, height: 920 }));
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem("aicad.layout", JSON.stringify({ left: 230, right: 560, chat: 330, problems: 60 }));
  });
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const execute = (cmd: unknown) => page.evaluate((c) => (window as unknown as AW).__aicad.execute(c), cmd);
const summary = (): Promise<Summary> => page.evaluate(() => (window as unknown as AW).__aicad.idle());
const agent = (): Promise<AgentSummary> => page.evaluate(() => (window as unknown as AW).__aicad.agent());

test("Settings shows the detected Claude Code, the other CLIs, local models and optional keys", async () => {
  expect((await execute({ id: "settings.open" })).ok).toBe(true);
  const dialog = page.getByTestId("settings-dialog");
  await expect(dialog).toBeVisible();
  const claude = dialog.locator('[data-testid="settings-cli"][data-provider="claude-cli"]');
  await expect(claude).toHaveAttribute("data-support", "ready");
  await expect(claude).toHaveAttribute("data-auth", "logged_in");
  await expect(claude.getByTestId("settings-cli-badge")).toHaveText("Ready");
  await expect(claude).toContainText("2.1.260");
  await expect(claude.getByTestId("settings-cli-login")).toHaveText("Logged in · Max plan");
  // The login probe's account details never reach the renderer.
  expect(await page.evaluate(() => document.documentElement.outerHTML.includes("fixture@example.invalid"))).toBe(false);
  for (const id of ["gemini-cli", "codex-cli", "opencode", "cursor-agent"]) {
    await expect(dialog.locator(`[data-testid="settings-cli"][data-provider="${id}"] [data-testid="settings-cli-badge"]`)).toHaveText("Not installed");
  }
  await expect(dialog.getByTestId("settings-cli-group")).toContainText("the app never sees your login");
  await expect(dialog.getByTestId("settings-cli-group")).toContainText("Prompts and your design are sent to the tool's vendor under your plan's terms.");
  await expect(dialog.getByTestId("settings-auto-default")).toContainText("Using Claude Code (detected)");
  await expect(dialog.locator('[data-testid="settings-model"][data-role="designer"]')).toHaveAttribute("data-model", "claude-cli:opus");
  await expect(dialog.locator('[data-testid="settings-model"][data-role="triage"]')).toHaveAttribute("data-model", "claude-cli:haiku");
  await expect(dialog.getByTestId("settings-local")).toContainText("Not running");
  await expect(dialog.locator('[data-testid="settings-key"][data-provider="anthropic"] [data-testid="settings-key-status"]')).toHaveText("Not set (optional)");
  // The model pickers offer every kind; unavailable ones are disabled with the reason.
  const designer = dialog.getByLabel("Designer model");
  await expect(designer.locator('option[value="claude-cli:sonnet"]')).not.toHaveAttribute("disabled");
  await expect(designer.locator('option[value="gemini-cli:pro"]')).toHaveAttribute("disabled", "");
  await expect(designer.locator('option[value="gemini-cli:pro"]')).toContainText("Gemini CLI is not installed");
  await expect(designer.locator('option[value="claude-opus-5-5"]')).toContainText("no Anthropic API key");
  await page.screenshot({ path: join(artifacts, "providers-settings.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("runs a design task on Claude Code with no API key: plan usage, proposal, accept", async () => {
  expect((await execute({ id: "file.newFromTemplate", args: { templateId: "t1-nema17-plate" } })).ok).toBe(true);
  expect((await summary()).bbox?.max[2]).toBeCloseTo(5, 3);
  await page.getByLabel("Message").fill("Make the plate 2 mm thicker");
  await page.getByLabel("Message").press("Enter");

  const card = page.getByTestId("agent-run").last();
  await expect(card).toBeVisible();
  const question = card.getByTestId("agent-question");
  await expect(question).toBeVisible({ timeout: 60_000 });
  await expect(question).toContainText("Which way should the extra 2 mm go?");
  // Subscription runs show notional plan usage, not a bill, and the plan windows the CLI reported.
  const cost = card.getByTestId("agent-cost");
  await expect(cost).toHaveAttribute("data-notional", "yes");
  await expect(cost).toContainText("plan usage");
  await expect(card.getByTestId("agent-plan-note")).toContainText("(API list price; not billed)");
  await expect(card.getByTestId("agent-plan-usage")).toContainText("5-hour 17 %");
  await expect(card).toContainText("Claude Opus (Claude Code, your plan)");
  await question.getByTestId("agent-answer").click();

  await expect(card.getByTestId("agent-headline")).toHaveText("Proposal ready", { timeout: 60_000 });
  await expect(page.locator('[data-testid="proposal-view"] [data-change="plate/plate"]')).toContainText("distance 5 → 7 mm");
  await page.screenshot({ path: join(artifacts, "providers-run.png") });
  const a = await agent();
  expect(a.lastRun?.result).toMatchObject({ status: "proposed", stopReason: "proposed", changed: true });
  expect(a.lastRun?.phases).toEqual(["TRIAGE", "BUILD", "PROPOSE", "DONE"]);

  await page.getByTestId("proposal-view").getByTestId("proposal-accept").click();
  await expect(card.getByTestId("agent-resolution")).toContainText("Applied");
  expect((await summary()).bbox?.max[2]).toBeCloseTo(7, 3);

  // Every model call was one fresh, locked-down Claude Code invocation, with no key in its environment.
  const calls = fake.calls();
  expect(calls.map((c) => `${c.role}#${c.turn}`)).toEqual(["triage#0", "designer#0", "designer#1", "designer#2"]);
  for (const c of calls) {
    expect(c.argv).toEqual(expect.arrayContaining(["-p", "--restricted", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]));
    expect(c.argv[c.argv.indexOf("--tools") + 1]).toBe("");
    expect(c.promptInArgv).toBe(false);
    expect(c.cwdMode).toBe(0o700);
    expect(c.env.filter((k) => /API_?KEY|TOKEN|SECRET|^ANTHROPIC_|^OPENAI_|^ELECTRON_RUN_AS_NODE$/.test(k))).toEqual([]);
  }

  // The plan usage is kept for Settings.
  await execute({ id: "settings.open" });
  await expect(page.locator('[data-testid="settings-cli"][data-provider="claude-cli"] [data-testid="settings-plan-usage"]')).toContainText("5-hour");
  await page.keyboard.press("Escape");
  expect(pageErrors).toEqual([]);
});

test("a logged-out Claude Code refuses the run with the login command; Re-check picks up the login", async () => {
  fake.setLoggedIn(false);
  expect((await execute({ id: "settings.probeProviders", args: { providers: ["claude-cli"] } })).ok).toBe(true);
  await page.getByLabel("Message").fill("Make it 1 mm thinner");
  await page.getByLabel("Message").press("Enter");
  const refusal = page.locator(".msg-system.msg-error").last();
  await expect(refusal).toContainText("Claude Code is installed but not logged in");
  await expect(refusal).toContainText("Run `claude auth login` in a terminal, then press Re-check.");
  const callsBefore = fake.calls().length;
  await refusal.getByRole("button", { name: "Open Settings" }).click();
  const dialog = page.getByTestId("settings-dialog");
  const claude = dialog.locator('[data-testid="settings-cli"][data-provider="claude-cli"]');
  await expect(claude.getByTestId("settings-cli-badge")).toHaveText("Log in needed");
  await expect(dialog.getByTestId("settings-auto-default")).toHaveAttribute("data-state", "login");
  await page.screenshot({ path: join(artifacts, "providers-login-needed.png") });

  fake.setLoggedIn(true);
  await claude.getByRole("button", { name: "Re-check" }).click();
  await expect(claude.getByTestId("settings-cli-badge")).toHaveText("Ready");
  await expect(dialog.getByTestId("settings-auto-default")).toHaveAttribute("data-state", "ready");
  await page.keyboard.press("Escape");
  expect(fake.calls().length).toBe(callsBefore); // the refused run never reached the CLI
  expect((await agent()).activeRunId).toBeNull();
  expect(pageErrors).toEqual([]);
});
