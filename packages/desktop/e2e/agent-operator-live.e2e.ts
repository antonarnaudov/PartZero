/**
 * LIVE: the live operator driven by a real Claude Code (agent-runtime mode, the owner's own plan)
 * in the desktop app. It spends plan usage, so it only runs when asked:
 *
 *   AICAD_LIVE_CLI_E2E=1 [AICAD_LIVE_CLI_DIR=~/.local/bin] [AICAD_LIVE_PROMPT="…"] \
 *     pnpm --filter @aicad/desktop exec playwright test -c e2e/playwright.config.ts agent-operator-live
 *
 * It records, with timestamps, every step as it appears in the chat and every feature as it appears
 * in the model (proof that the run edits live, step by step), the run's wall time, its notional cost
 * and the plan usage Claude Code reported, into `test-results/agent-operator-live.json`, plus
 * screenshots mid-run and at the end. The app never reads the CLI's credentials: Claude Code uses its
 * own login.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { appDir } from "./app-dir.js";
import { testResultsDir } from "./screenshots.js";

const PROMPT = process.env["AICAD_LIVE_PROMPT"] ?? "a 40 mm cube with a 10 mm hole through the top and 2 mm fillets on the vertical edges";
const CLI_DIR = process.env["AICAD_LIVE_CLI_DIR"] ?? join(homedir(), ".local", "bin");
const TAG = process.env["AICAD_LIVE_TAG"] ?? "run";

test.skip(process.env["AICAD_LIVE_CLI_E2E"] !== "1", "live Claude Code run: set AICAD_LIVE_CLI_E2E=1 (spends the owner's plan)");
test.setTimeout(15 * 60_000);

interface Summary {
  features: Array<{ id: string; name: string; type: string; status: string | null; author: string }>;
  bodies: Array<{ name: string; triangles: number }>;
  bbox: { min: number[]; max: number[] } | null;
  problems: unknown[];
}

type AW = { __aicad: { execute(cmd: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>; idle(): Promise<Summary>; summary(): Summary } };

let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "pz-live-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$/.test(k)) env[k] = v;
  app = await electron.launch({
    args: [appDir, "--use-mock-keychain"],
    env: { ...env, AICAD_USER_DATA_DIR: userData, AICAD_SKIP_CLOSE_PROMPT: "1", AICAD_AGENT_DOTENV: "off", AICAD_AGENT_TRANSPORT: "live", AICAD_CLI_DIRS: CLI_DIR, AICAD_CLI_AUTO: "runtime" },
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1480, height: 920 }));
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as Partial<AW>).__aicad, undefined, { timeout: 60_000 });
});

test.afterAll(async () => {
  await app?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

test("Claude Code builds the part live with the modeling tools", async () => {
  const exec = (cmd: unknown) => page.evaluate((c) => (window as unknown as AW).__aicad.execute(c), cmd);
  // Room for the task at Opus list prices (notional: not billed; the plan's own limits apply).
  expect((await exec({ id: "settings.setBudget", args: { usd: 4 } })).ok).toBe(true);
  const t0 = Date.now();
  await page.getByLabel("Message").fill(PROMPT);
  await page.getByLabel("Message").press("Enter");
  const card = page.getByTestId("agent-run").last();
  const timeline: Array<{ t: number; kind: "step" | "feature"; text: string }> = [];
  const seenSteps = new Set<string>();
  const seenFeatures = new Set<string>();
  let shot = 0;
  for (;;) {
    const status = await card.getAttribute("data-status").catch(() => null);
    const steps = await card.getByTestId("agent-step").allTextContents();
    steps.forEach((s, i) => {
      const key = `${i}:${s}`;
      if (!seenSteps.has(key)) {
        seenSteps.add(key);
        timeline.push({ t: Date.now() - t0, kind: "step", text: s });
      }
    });
    const s = await page.evaluate(() => (window as unknown as AW).__aicad.summary());
    for (const f of s.features) {
      const key = `${f.id}:${f.status}`;
      if (!seenFeatures.has(key)) {
        seenFeatures.add(key);
        timeline.push({ t: Date.now() - t0, kind: "feature", text: `${f.name} [${f.type}] ${f.status} ${f.author}` });
      }
    }
    if (shot === 0 && s.features.length >= 2 && status === "running") {
      shot++;
      await page.screenshot({ path: join(testResultsDir, `agent-operator-live-${TAG}-mid.png`) });
    }
    const q = await card.getByTestId("agent-question").count();
    if (q > 0) await card.getByRole("button", { name: /Use defaults|Answer/ }).first().click().catch(() => undefined);
    if (status === "done" || status === "failed") break;
    if (Date.now() - t0 > 14 * 60_000) break;
    await page.waitForTimeout(400);
  }
  const wallMs = Date.now() - t0;
  const final = await page.evaluate(() => (window as unknown as AW).__aicad.idle());
  await page.screenshot({ path: join(testResultsDir, `agent-operator-live-${TAG}-end.png`) });
  const headline = await card.getByTestId("agent-headline").textContent();
  const cost = await card.getByTestId("agent-cost").textContent().catch(() => null);
  const plan = await card.getByTestId("agent-plan-usage").textContent().catch(() => null);
  const result = await card.getByTestId("agent-result").textContent().catch(() => null);
  const error = await card.getByTestId("agent-error").textContent().catch(() => null);
  const activity = await card.locator(".run-log li").allTextContents();
  const report = { prompt: PROMPT, wallMs, headline, cost, plan, result, error, timeline, final, activity };
  writeFileSync(join(testResultsDir, `agent-operator-live-${TAG}.json`), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ wallMs, headline, cost, plan, features: final.features.map((f) => `${f.name}:${f.type}:${f.status}`), bbox: final.bbox }, null, 1));
  expect(final.features.length).toBeGreaterThan(0);
});
