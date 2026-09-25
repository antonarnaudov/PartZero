/**
 * The live operator end to end, offline: Electron + the agent utility process + @aicad/agent's
 * live operator with the gateway's SCRIPTED transport (no network, no keys; the script operates the
 * op tools, it writes no code) + the real engine on both sides.
 *
 * "A 40 mm cube with a 10 mm hole through the top and 2 mm fillets on the vertical edges" on a new
 * document: the plan and every step appear in the chat one line at a time while the features land
 * one by one in the timeline and the viewport; the finished turn is one undo step; Keep makes it
 * yours. Stop keeps what was built. At "Ask each step" the run waits after every step: Keep goes
 * on, Undo step takes the step back.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { appDir } from "./app-dir.js";
import { screenshotPath } from "./screenshots.js";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(desktopRoot, "e2e", "fixtures", "live-cube.script.json");
const PROMPT = "a 40 mm cube with a 10 mm hole through the top and 2 mm fillets on the vertical edges";
/** A fresh, empty model for the next test (in this window: `file.new` would open a new one over a changed document). */
const BLANK = JSON.stringify({ schema: "aicad.ir/1", meta: { name: "untitled" }, parts: [{ id: "p1", name: "part", features: [] }] });

interface Result {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
}

interface Summary {
  format: string;
  features: Array<{ id: string; name: string; type: string; status: string | null; author: string }>;
  bodies: Array<{ name: string; triangles: number }>;
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
}

type AW = { __aicad: { execute(cmd: unknown): Promise<Result>; idle(): Promise<Summary> } };

let app: ElectronApplication;
let page: Page;
let userData: string;
const pageErrors: string[] = [];

function offlineEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$/.test(k)) env[k] = v;
  return { ...env, AICAD_AGENT_DOTENV: "off", AICAD_SKIP_CLOSE_PROMPT: "1", ...extra };
}

async function exec(id: string, args: Record<string, unknown> = {}): Promise<Result> {
  return page.evaluate(([i, a]) => (window as unknown as AW).__aicad.execute({ id: i, args: a }), [id, args] as const);
}

async function summary(): Promise<Summary> {
  return page.evaluate(async () => JSON.parse(JSON.stringify(await (window as unknown as AW).__aicad.idle())) as Summary);
}

const row = (name: string) => page.locator(`[data-testid="timeline-feature"][data-feature="${name}"]`);

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "aicad-e2e-operator-"));
  app = await electron.launch({
    args: [appDir, "--use-mock-keychain"],
    env: offlineEnv({ AICAD_USER_DATA_DIR: userData, AICAD_AGENT_TRANSPORT: "scripted", AICAD_AGENT_SCRIPT: script }),
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  // "Discard unsaved changes?" when a test starts a new document over the last one's part.
  page.on("dialog", (d) => void d.accept());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1480, height: 920 }));
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as Partial<AW>).__aicad, undefined, { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as AW).__aicad.idle());
});

test.afterAll(async () => {
  await app?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

async function send(text: string): Promise<void> {
  await page.getByLabel("Message").fill(text);
  await page.getByLabel("Message").press("Enter");
}

test("the agent builds the cube live: plan, narrated steps, features landing one by one; one undo step; Keep", async () => {
  expect(await summary()).toMatchObject({ format: "ir-v1", features: [], bodies: [] });
  await expect(page.getByTestId("agent-autonomy")).toHaveValue("review");
  await send(PROMPT);
  const card = page.getByTestId("agent-run").last();
  await expect(card).toHaveAttribute("data-status", "running");
  // The plan first, then each step appears in the chat as its feature lands in the timeline, while the run goes on.
  await expect(card.getByTestId("agent-plan").locator("li")).toHaveCount(6);
  const steps = card.getByTestId("agent-step");
  await expect(steps.nth(1)).toHaveText(/Sketch the 40 mm base square on XY/);
  await expect(row("base")).toBeVisible();
  await expect(row("base")).toHaveAttribute("data-author", "agent");
  const mid = await summary();
  expect(mid.features.length).toBeLessThan(4);
  expect(await card.getAttribute("data-status")).toBe("running");
  await expect(steps.nth(2)).toHaveText(/Extrude it into a 40 mm cube/);
  await expect(row("cube")).toBeVisible();
  await expect(page.getByTestId("viewport")).toHaveAttribute("data-extent-z", "40.00");
  await expect(steps.nth(3)).toHaveText(/Round the four vertical edges \(2 mm\)/);
  await expect(row("rounds")).toBeVisible();
  await expect(steps.nth(4)).toHaveText(/Drill the Ø10 bore through the top/);
  // Done: the headline, the summary, Keep / Undo turn; the model is the part that was asked for.
  await expect(card).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(card.getByTestId("agent-headline")).toHaveText("Built — 5 steps");
  await expect(card.getByTestId("agent-result")).toContainText("Ø10 mm bore");
  await expect(card.getByTestId("agent-turn")).toBeVisible();
  const done = await summary();
  expect(done.features.map((f) => [f.name, f.type, f.status, f.author])).toEqual([
    ["base", "sketch", "ok", "agent"],
    ["cube", "extrude", "ok", "agent"],
    ["rounds", "fillet", "ok", "agent"],
    ["bore", "hole", "ok", "agent"],
  ]);
  expect(done.bodies).toHaveLength(1);
  expect(done.bbox?.min.map((x) => Math.round(x))).toEqual([-20, -20, 0]);
  expect(done.bbox?.max.map((x) => Math.round(x))).toEqual([20, 20, 40]);
  await page.screenshot({ path: screenshotPath("agent-live.png", "AICAD_E2E_AGENT_LIVE_SCREENSHOT") });
  // The whole turn is one undo step, and redo brings it back.
  expect((await exec("edit.undo")).ok).toBe(true);
  expect((await summary()).features).toEqual([]);
  expect((await exec("edit.redo")).ok).toBe(true);
  expect((await summary()).features).toHaveLength(4);
  // Keep: the features become yours (the AI marks go).
  await card.getByTestId("agent-keep").click();
  await expect(card.getByTestId("agent-resolution")).toContainText("Kept");
  await expect(row("cube")).toHaveAttribute("data-author", "user");
  expect(pageErrors).toEqual([]);
});

test("Stop keeps everything built so far, as one undo step", async () => {
  expect((await exec("ir.load", { document: BLANK })).ok).toBe(true);
  await expect.poll(async () => (await summary()).features.length).toBe(0);
  await send(PROMPT);
  const card = page.getByTestId("agent-run").last();
  await expect(row("cube")).toBeVisible({ timeout: 30_000 });
  await card.getByTestId("agent-stop").click();
  await expect(card).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(card.getByTestId("agent-headline")).toHaveText(/^Stopped — \d steps kept$/);
  const s = await summary();
  const kept = s.features.map((f) => f.name);
  expect(kept.slice(0, 2)).toEqual(["base", "cube"]);
  expect(s.features.every((f) => f.author === "agent")).toBe(true);
  expect((await exec("edit.undo")).ok).toBe(true);
  expect((await summary()).features).toEqual([]);
});

test("Ask each step: the run waits after every step; Keep goes on, Undo step takes it back", async () => {
  expect((await exec("ir.load", { document: BLANK })).ok).toBe(true);
  await expect.poll(async () => (await summary()).features.length).toBe(0);
  await page.getByTestId("agent-autonomy").selectOption("ask");
  await expect(page.getByTestId("agent-autonomy")).toHaveValue("ask");
  await send(PROMPT);
  const card = page.getByTestId("agent-run").last();
  const review = card.getByTestId("agent-step-review");
  // Step 1 (the size parameter): keep it.
  await expect(review).toContainText("Add the 40 mm size parameter");
  await expect(card.getByTestId("agent-headline")).toHaveText("Keep this step?");
  await review.getByTestId("agent-step-keep").click();
  // Step 2 (the sketch) landed and waits: undo it.
  await expect(review).toContainText("Sketch the 40 mm base square on XY");
  await expect(row("base")).toBeVisible();
  await review.getByTestId("agent-step-undo").click();
  await expect(row("base")).toHaveCount(0);
  await expect(card.locator('[data-testid="agent-step"][data-state="undone"]')).toHaveCount(1);
  // The rest of the script needs the sketch (its later steps are refused): stop it if it still runs; what was kept stays.
  await card
    .getByTestId("agent-stop")
    .click({ timeout: 3000 })
    .catch(() => undefined);
  await expect(card).toHaveAttribute("data-status", /done|failed/, { timeout: 30_000 });
  expect((await summary()).features).toEqual([]);
  await page.getByTestId("agent-autonomy").selectOption("review");
  expect(pageErrors).toEqual([]);
});
