/**
 * LIVE agent e2e: a real model run through the desktop app ("make the plate 2 mm thicker" on the
 * NEMA 17 template). It costs money (≈ $0.05–0.50), so it only runs when BOTH are set:
 *
 *   AICAD_LIVE_E2E=1  and a provider key: ANTHROPIC_API_KEY | OPENAI_API_KEY | GEMINI_API_KEY
 *
 *   AICAD_LIVE_E2E=1 ANTHROPIC_API_KEY=… pnpm --filter @aicad/desktop test:e2e -- agent-live
 *
 * The key reaches the app the development way (environment → main process → agent process); it is
 * never typed into the UI or written to disk here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const provider = process.env["ANTHROPIC_API_KEY"] ? "anthropic" : process.env["OPENAI_API_KEY"] ? "openai" : process.env["GEMINI_API_KEY"] ? "google" : null;
const DESIGNER: Record<string, string | null> = { anthropic: null, openai: "gpt-6-sol", google: "gemini-3.1-pro-preview" };

interface AW {
  __aicad: {
    execute(cmd: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;
    idle(): Promise<{ bbox: { max: number[] } | null; problems: unknown[] }>;
    agent(): { lastRun: { status: string; result: { status: string; changed: boolean } | null; spentUsd: number } | null; review: { changes: Array<{ key: string; kind: string }>; variantSource: string } | null };
  };
}

test.skip(process.env["AICAD_LIVE_E2E"] !== "1" || provider === null, "live agent e2e: set AICAD_LIVE_E2E=1 and a provider API key");
test.setTimeout(600_000);

let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "aicad-e2e-live-"));
  app = await electron.launch({
    args: [desktopRoot, "--use-mock-keychain"],
    env: { ...(process.env as Record<string, string>), AICAD_USER_DATA_DIR: userData, AICAD_SKIP_CLOSE_PROMPT: "1", AICAD_AGENT_TRANSPORT: "live" },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId("app-shell")).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

test("a real model makes the NEMA 17 plate 2 mm thicker; accept and undo", async () => {
  const designer = DESIGNER[provider!];
  if (designer) await page.evaluate((m) => (window as unknown as AW).__aicad.execute({ id: "settings.setModel", args: { role: "designer", model: m } }), designer);
  await page.evaluate(() => (window as unknown as AW).__aicad.execute({ id: "settings.setBudget", args: { usd: 1 } }));
  await page.evaluate(() => (window as unknown as AW).__aicad.execute({ id: "file.newFromTemplate", args: { templateId: "t1-nema17-plate" } }));
  await page.evaluate(() => (window as unknown as AW).__aicad.idle());

  await page.getByLabel("Message").fill("Make the plate 2 mm thicker (keep the bottom face where it is)");
  await page.getByLabel("Message").press("Enter");
  const card = page.getByTestId("agent-run");
  await expect(card).toBeVisible();

  // Answer any clarifying question with its defaults until the run ends.
  const deadline = Date.now() + 540_000;
  for (;;) {
    const status = await card.getAttribute("data-status");
    if (status === "done" || status === "failed") break;
    if (await card.getByTestId("agent-question").isVisible()) await card.getByRole("button", { name: "Use defaults" }).click();
    if (Date.now() > deadline) throw new Error("live run did not finish in time");
    await page.waitForTimeout(1000);
  }
  const a = await page.evaluate(() => (window as unknown as AW).__aicad.agent());
  test.info().annotations.push({ type: "cost", description: `$${a.lastRun?.spentUsd.toFixed(4)}` });
  expect(a.lastRun?.result).toMatchObject({ status: "proposed", changed: true });
  await expect(page.getByTestId("proposal-view")).toHaveAttribute("data-status", "ready");
  expect(a.review?.changes.some((c) => c.key === "plate/plate" && c.kind === "modified")).toBe(true);

  await page.getByTestId("proposal-accept").click();
  const after = await page.evaluate(() => (window as unknown as AW).__aicad.idle());
  expect(after.bbox?.max[2]).toBeCloseTo(7, 2);
  await page.evaluate(() => (window as unknown as AW).__aicad.execute({ id: "edit.undo" }));
  expect((await page.evaluate(() => (window as unknown as AW).__aicad.idle())).bbox?.max[2]).toBeCloseTo(5, 2);
});
