/**
 * The design agent end to end, offline: Electron + the agent utility process + @aicad/agent with the
 * gateway's SCRIPTED transport (no network, no keys) + the real engine (forge-web WASM in Node for
 * the agent, forge-web or the Forge CLI in the renderer).
 *
 * "Make the plate 2 mm thicker" on the NEMA 17 template, with the top face selected: live progress
 * and cost, a clarifying question card, the proposal diff and ghost preview, accept → document and
 * viewport update as one transaction → undo reverts it. Then Stop while the agent waits for an
 * answer, and the API-key settings (encrypted at rest, never readable by the renderer).
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(desktopRoot, "e2e", "fixtures", "nema17-thicker.script.json");
const screenshotPath = process.env["AICAD_E2E_AGENT_SCREENSHOT"] ?? join(desktopRoot, "..", "..", "docs", "spikes", "assets", "agent-proposal.png");
/** Extra review screenshots (gitignored). */
const artifacts = join(desktopRoot, "test-results");

interface Summary {
  dirty: boolean;
  features: Array<{ name: string; status: string | null }>;
  problems: unknown[];
  bbox: { min: number[]; max: number[] } | null;
}

interface AgentSummary {
  activeRunId: string | null;
  lastRun: { status: string; phases: string[]; spentUsd: number; budgetUsd: number; result: { status: string; stopReason: string; changed: boolean } | null } | null;
  review: { status: string; changes: Array<{ key: string; kind: string; summary: string }>; accepted: string[]; variantSource: string; previewEnabled: boolean; preview: string; resolution: string | null } | null;
}

/** `window.__aicad` as this suite uses it (smoke.e2e.ts declares its own view of the global). */
interface AW {
  __aicad: {
    execute(cmd: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;
    idle(): Promise<Summary>;
    agent(): AgentSummary;
  };
}

/** The environment without any provider keys: this suite must never reach a real API. */
function offlineEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$/.test(k)) env[k] = v;
  return { ...env, AICAD_AGENT_DOTENV: "off", AICAD_SKIP_CLOSE_PROMPT: "1", ...extra };
}

let app: ElectronApplication;
let page: Page;
let userData: string;
const pageErrors: string[] = [];

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "aicad-e2e-agent-"));
  app = await electron.launch({
    // --use-mock-keychain: safeStorage uses a mock OS keychain (no keychain prompt on macOS test runs).
    args: [desktopRoot, "--use-mock-keychain"],
    env: offlineEnv({ AICAD_USER_DATA_DIR: userData, AICAD_AGENT_TRANSPORT: "scripted", AICAD_AGENT_SCRIPT: script }),
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1480, height: 920 }));
  await expect(page.getByTestId("app-shell")).toBeVisible();
  // Room for the run card and the diff.
  await page.evaluate(() => {
    localStorage.setItem("aicad.layout", JSON.stringify({ left: 230, right: 560, chat: 330, problems: 60 }));
  });
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
});

const summary = (): Promise<Summary> => page.evaluate(() => (window as unknown as AW).__aicad.idle());
const agent = (): Promise<AgentSummary> => page.evaluate(() => (window as unknown as AW).__aicad.agent());

test("runs the agent on the NEMA 17 template: progress, question, proposal diff, preview, accept, undo", async () => {
  const r = await page.evaluate(() => (window as unknown as AW).__aicad.execute({ id: "file.newFromTemplate", args: { templateId: "t1-nema17-plate" } }));
  expect(r.ok).toBe(true);
  const before = await summary();
  expect(before.bbox?.max[2]).toBeCloseTo(5, 3);
  await expect(page.getByTestId("viewport")).toHaveAttribute("data-extent-z", "5.00");

  // Select the top face: it travels with the message as semantic context.
  await page.evaluate(() => (window as unknown as AW).__aicad.execute({ id: "selection.selectEntity", args: { body: "plate/plate", face: "plate/cap:end", reveal: false } }));
  await expect(page.locator(".compose-chips .chip")).toHaveCount(2);
  await expect(page.getByTestId("agent-state")).toContainText("ready");

  await page.getByLabel("Message").fill("Make the plate 2 mm thicker");
  await page.getByLabel("Message").press("Enter");

  const card = page.getByTestId("agent-run");
  await expect(card).toBeVisible();
  await expect(page.locator(".msg-user")).toContainText("Make the plate 2 mm thicker");
  // Live progress: the checklist advances and the cost meter moves.
  const progress = card.getByTestId("agent-progress");
  await expect(progress.locator('[data-step="understand"]')).toHaveAttribute("data-state", "done");
  await expect(progress.locator('[data-step="build"]')).toHaveAttribute("data-state", "active");

  // The clarifying question arrives as a multiple-choice card with the default picked.
  const question = card.getByTestId("agent-question");
  await expect(question).toBeVisible();
  await expect(card.getByTestId("agent-headline")).toHaveText("Waiting for your answer");
  await expect(question).toContainText("Which way should the extra 2 mm go?");
  await expect(question.locator('.option[aria-checked="true"]')).toContainText("Up (+Z)");
  await expect(card.getByTestId("agent-cost")).toContainText("/ $1.00");
  await page.screenshot({ path: join(artifacts, "agent-question.png") });
  expect((await agent()).lastRun?.spentUsd).toBeGreaterThan(0);
  await question.getByTestId("agent-answer").click();
  await expect(question).toBeHidden();

  // The proposal: diff, one modified feature, dependency-free, previewed in the viewport.
  await expect(card.getByTestId("agent-headline")).toHaveText("Proposal ready", { timeout: 60_000 });
  const view = page.getByTestId("proposal-view");
  await expect(view).toHaveAttribute("data-status", "ready");
  const change = view.locator('[data-change="plate/plate"]');
  await expect(change).toHaveAttribute("data-kind", "modified");
  await expect(change).toContainText("distance 5 → 7 mm");
  const diff = page.getByTestId("proposal-diff");
  await expect(diff).toHaveAttribute("data-line-changes", "1");
  await expect(diff).toContainText("distance: 5"); // the removed line, shown inline in the diff
  await expect(page.locator('[data-testid="timeline-feature"][data-feature="plate"]')).toHaveAttribute("data-draft", "modified");
  await expect(card.locator(".assumption-chip")).toHaveCount(2);
  for (const step of ["understand", "build", "propose"]) await expect(card.locator(`[data-step="${step}"]`)).toHaveAttribute("data-state", "done");

  const viewport = page.getByTestId("viewport");
  await expect(viewport).toHaveAttribute("data-shown", "proposal");
  await expect(viewport).toHaveAttribute("data-extent-z", "7.00");
  // The document itself is untouched until accepted.
  expect((await summary()).bbox?.max[2]).toBeCloseTo(5, 3);
  const a = await agent();
  expect(a.lastRun?.result).toMatchObject({ status: "proposed", stopReason: "proposed", changed: true });
  expect(a.lastRun?.phases).toEqual(["TRIAGE", "BUILD", "PROPOSE", "DONE"]);
  expect(a.review?.changes).toEqual([{ key: "plate/plate", kind: "modified", summary: "distance 5 → 7 mm" }]);
  expect(a.review?.variantSource).toContain("const plate = extrude(outline, { distance: 7 });");

  await page.locator(".toast").evaluateAll((els) => els.forEach((e) => e.remove()));
  await page.mouse.move(5, 300);
  await page.waitForTimeout(300);
  await page.screenshot({ path: screenshotPath });

  // Toggle the preview off and on: the viewport switches between the document and the proposal.
  await page.getByTestId("proposal-preview-chip").getByRole("button", { name: "Show current" }).click();
  await expect(viewport).toHaveAttribute("data-shown", "current");
  await expect(viewport).toHaveAttribute("data-extent-z", "5.00");
  await page.getByTestId("proposal-preview-chip").getByRole("button", { name: "Preview proposal" }).click();
  await expect(viewport).toHaveAttribute("data-shown", "proposal");

  // Accept: one transaction through the command layer; document and viewport update.
  await view.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("proposal-tab")).toBeVisible();
  await expect(card.getByTestId("agent-resolution")).toContainText("Applied");
  const after = await summary();
  expect(after.bbox?.max[2]).toBeCloseTo(7, 3);
  expect(after.problems).toEqual([]);
  expect(after.dirty).toBe(true);
  await expect(viewport).toHaveAttribute("data-shown", "current");
  await expect(viewport).toHaveAttribute("data-extent-z", "7.00");
  await expect(page.locator('[data-testid="timeline-feature"][data-feature="plate"] .tl-summary')).toContainText("7 mm");

  // Undo reverts the whole agent change in one step.
  const undo = await page.evaluate(() => (window as unknown as AW).__aicad.execute({ id: "edit.undo" }));
  expect(undo).toMatchObject({ ok: true, value: { undone: true, label: "Agent: Make the plate 2 mm thicker" } });
  const reverted = await summary();
  expect(reverted.bbox?.max[2]).toBeCloseTo(5, 3);
  expect(reverted.dirty).toBe(false);
  await expect(viewport).toHaveAttribute("data-extent-z", "5.00");
  expect(pageErrors).toEqual([]);
});

test("Stop ends a run while it waits for an answer; the document stays unchanged", async () => {
  await page.evaluate(() => (window as unknown as AW).__aicad.execute({ id: "file.newFromTemplate", args: { templateId: "t1-nema17-plate" } }));
  await summary();
  await page.getByLabel("Message").fill("Make it 2 mm thicker again");
  await page.getByLabel("Message").press("Enter");
  const card = page.getByTestId("agent-run").last();
  await expect(card.getByTestId("agent-question")).toBeVisible();
  await card.getByTestId("agent-stop").click();
  await expect(card.getByTestId("agent-headline")).toHaveText("Stopped");
  await expect(card).toHaveAttribute("data-status", "done");
  const a = await agent();
  expect(a.activeRunId).toBeNull();
  expect(a.lastRun?.result).toMatchObject({ status: "stopped", stopReason: "cancelled", changed: false });
  expect((await summary()).bbox?.max[2]).toBeCloseTo(5, 3);
  await expect(page.getByTestId("agent-state")).toContainText("ready");
});

test("API keys: saved encrypted, shown only as the last 4 characters, removable", async () => {
  const fake = "sk-e2e-test-not-a-real-key-7d3f";
  await page.getByRole("button", { name: "Settings" }).first().click();
  const dialog = page.getByTestId("settings-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("settings-transport")).toContainText("Scripted transport");
  const row = dialog.locator('[data-testid="settings-key"][data-provider="openai"]');
  await expect(row).toHaveAttribute("data-configured", "no");
  await row.getByLabel("OpenAI API key").fill(fake);
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row).toHaveAttribute("data-configured", "yes");
  await expect(row.getByTestId("settings-key-status")).toContainText("…7d3f");
  await expect(row.getByTestId("settings-key-status")).toContainText("OS keychain");
  await page.screenshot({ path: join(artifacts, "agent-settings.png") });

  // Never readable by the renderer, and never stored in plaintext.
  expect(await page.evaluate((k) => document.documentElement.outerHTML.includes(k), fake)).toBe(false);
  const settingsView = await page.evaluate(() => (window as unknown as { aicad: { settings: { get(): Promise<unknown> } } }).aicad.settings.get());
  expect(JSON.stringify(settingsView)).not.toContain(fake);
  const file = join(userData, "agent-keys.json");
  expect(existsSync(file)).toBe(true);
  const stored = readFileSync(file, "utf8");
  expect(stored).not.toContain(fake);
  expect(JSON.parse(stored).keys.openai.ciphertext.length).toBeGreaterThan(16);
  // …but the main process can decrypt it (what a run would use).
  const roundTrip = await app.evaluate(({ safeStorage }, path) => {
    const fs = process.getBuiltinModule("node:fs");
    const j = JSON.parse(fs.readFileSync(path, "utf8")) as { keys: { openai: { ciphertext: string } } };
    return safeStorage.decryptString(Buffer.from(j.keys.openai.ciphertext, "base64"));
  }, file);
  expect(roundTrip).toBe(fake);

  // Models and budget.
  await dialog.getByLabel("Budget per task (USD)").fill("2.5");
  await dialog.getByLabel("Budget per task (USD)").blur();
  await expect.poll(async () => JSON.parse(readFileSync(join(userData, "agent-settings.json"), "utf8")).budgetUsd).toBe(2.5);

  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row).toHaveAttribute("data-configured", "no");
  expect(JSON.parse(readFileSync(file, "utf8")).keys.openai).toBeUndefined();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(pageErrors).toEqual([]);
});
