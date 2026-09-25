/**
 * The model panels end to end with the real mouse and keys (FULL-MODELING-PLAN T0 #13, #14, #19,
 * #22): the Fusion-style timeline under the viewport (drag to reorder with validity, the rollback
 * marker, the feature menu, delete with dependents, rename, keys), the Browser (bodies, sketches,
 * origin, construction; visibility, isolate, filament colours), the Parameters panel (user
 * parameters and every model value, expressions, promote to parameter), Problems, and the one
 * Undo/Redo across all of them and sketch mode.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { appDir } from "./app-dir.js";
import { screenshotPath } from "./screenshots.js";

interface Result {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
}

interface Summary {
  format: string;
  dirty: boolean;
  rollback: string | null;
  features: Array<{ id: string; name: string; type: string; status: string | null; author: string }>;
  bodies: Array<{ name: string; triangles: number }>;
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
}

type AW = {
  __aicad: { execute(cmd: unknown): Promise<Result>; idle(): Promise<Summary> };
  __pzView: { view(): { bodies: Record<string, { visible: boolean }>; sketchVisibility: Record<string, boolean>; origin: boolean }; selection(): { items: Array<Record<string, unknown>> } };
  __pzSketch: { state(): { phase: string; tool: string; snapshot: { curves: unknown[]; canUndo: boolean } | null }; client(u: number, v: number): [number, number] };
};

let app: ElectronApplication;
let page: Page;
let userData: string;
const pageErrors: string[] = [];

async function exec(id: string, args: Record<string, unknown> = {}): Promise<Result> {
  return page.evaluate(([i, a]) => (window as unknown as AW).__aicad.execute({ id: i, args: a }), [id, args] as const);
}

async function summary(): Promise<Summary> {
  return page.evaluate(async () => JSON.parse(JSON.stringify(await (window as unknown as AW).__aicad.idle())) as Summary);
}

const names = async (): Promise<string[]> => (await summary()).features.map((f) => f.name);
const chip = (name: string): Locator => page.locator(`[data-testid="timeline-feature"][data-feature="${name}"]`);
const bodyRow = (name: string): Locator => page.locator(`[data-testid="browser-row"][data-kind="body"][data-name="${name}"]`);
const view = () => page.evaluate(() => (window as unknown as AW).__pzView.view());

async function center(l: Locator): Promise<{ x: number; y: number; left: number; right: number }> {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, left: b.x, right: b.x + b.width };
}

/** Press on `from`, move in steps to x (same row), release. */
async function dragTo(from: Locator, x: number, before?: () => Promise<void>): Promise<void> {
  const a = await center(from);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + (x > a.x ? 8 : -8), a.y, { steps: 2 });
  await page.mouse.move(x, a.y, { steps: 8 });
  if (before) await before();
  await page.mouse.up();
}

const MODEL = [
  { op: "addFeature", feature: { type: "sketch", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: 40, h: 20 }] } },
  { op: "addFeature", feature: { type: "extrude", sketch: "sketch1", distance: 8 } },
  { op: "addFeature", feature: { type: "sketch", plane: "XY", curves: [{ kind: "circle", id: "c", center: [45, 0], radius: 6 }] } },
  { op: "addFeature", feature: { type: "extrude", sketch: "sketch2", distance: 4 } },
  { op: "addFeature", feature: { type: "datum_plane", mode: "offset", from: "XY", distance: 20 } },
];
const ORDER = ["sketch1", "extrude1", "sketch2", "extrude2", "datum_plane1"];

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "aicad-panels-e2e-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$/.test(k)) env[k] = v;
  app = await electron.launch({ args: [appDir, "--use-mock-keychain"], env: { ...env, AICAD_USER_DATA_DIR: userData, AICAD_SKIP_CLOSE_PROMPT: "1", AICAD_AGENT_DOTENV: "off" } });
  page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1480, height: 920 }));
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as Partial<AW>).__aicad, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => (window as unknown as { __aicad: { describe(): Array<{ id: string }> } }).__aicad.describe().some((c) => c.id === "file.status"), undefined, { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as AW).__aicad.idle());
  const r = await exec("ir.apply", { ops: MODEL, label: "Test model" });
  expect(r.ok, r.error?.message).toBe(true);
  await expect(chip("datum_plane1")).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

test("the timeline under the viewport shows the history: icons, status, a card on hover", async () => {
  await expect(page.getByTestId("timeline")).toBeVisible();
  const chips = page.getByTestId("timeline-feature");
  await expect(chips).toHaveCount(5);
  expect(await chips.evaluateAll((els) => els.map((e) => [e.getAttribute("data-feature"), e.getAttribute("data-type"), e.getAttribute("data-status")]))).toEqual([
    ["sketch1", "sketch", "ok"],
    ["extrude1", "extrude", "ok"],
    ["sketch2", "sketch", "ok"],
    ["extrude2", "extrude", "ok"],
    ["datum_plane1", "datum_plane", "ok"],
  ]);
  // The strip sits under the viewport, across its width.
  const vp = (await page.locator(".center-stage").boundingBox())!;
  const tl = (await page.getByTestId("timeline").boundingBox())!;
  expect(tl.y).toBeGreaterThanOrEqual(vp.y + vp.height - 1);
  expect(Math.abs(tl.width - vp.width)).toBeLessThan(2);
  await expect(page.getByTestId("timeline-count")).toHaveText("5 features");
  await chip("extrude1").hover();
  const card = page.getByTestId("timeline-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("extrude1");
  await expect(card).toContainText("8 mm");
  await expect(card).toContainText("Built");
  await page.mouse.move(700, 400);
  await expect(card).toBeHidden();
  // The left dock is the Browser and Parameters: no second timeline there.
  await expect(page.getByTestId("dock-tab-browser")).toBeVisible();
  await expect(page.getByTestId("dock-tab-params")).toBeVisible();
  await expect(page.getByTestId("dock-tab-timeline")).toHaveCount(0);
});

test("dragging a chip reorders it where allowed; a forbidden place shows why and changes nothing", async () => {
  // sketch2 uses nothing: it may go first.
  const first = await center(chip("sketch1"));
  await dragTo(chip("sketch2"), first.left + 2, async () => {
    await expect(page.getByTestId("timeline-drop")).toHaveAttribute("data-valid", "true");
  });
  await expect.poll(names).toEqual(["sketch2", "sketch1", "extrude1", "extrude2", "datum_plane1"]);
  expect((await exec("edit.undo")).value).toMatchObject({ undone: true });
  await expect.poll(names).toEqual(ORDER);

  // extrude1 uses sketch1: before it is refused, with the reason, and nothing changes.
  const s1 = await center(chip("sketch1"));
  await dragTo(chip("extrude1"), s1.left + 2, async () => {
    const drop = page.getByTestId("timeline-drop");
    await expect(drop).toHaveAttribute("data-valid", "false");
    await expect(drop).toContainText("extrude1 uses sketch1: it must stay after it");
  });
  await expect(page.getByText(/extrude1 can't go there/)).toBeVisible();
  expect(await names()).toEqual(ORDER);

  // sketch1 is used by extrude1: after it is refused too; the datum may go anywhere.
  const e2 = await center(chip("extrude2"));
  await dragTo(chip("sketch1"), e2.right - 2, async () => {
    await expect(page.getByTestId("timeline-drop")).toHaveAttribute("data-valid", "false");
  });
  expect(await names()).toEqual(ORDER);
  await dragTo(chip("datum_plane1"), (await center(chip("sketch1"))).left + 2);
  await expect.poll(names).toEqual(["datum_plane1", ...ORDER.slice(0, 4)]);
  expect((await exec("edit.undo")).ok).toBe(true);
  await expect.poll(names).toEqual(ORDER);
});

test("the rollback marker drags back and forward; features after it are not built", async () => {
  const marker = page.getByTestId("timeline-marker");
  await expect(marker).toBeVisible();
  // Drop it between extrude1 and sketch2.
  const e1 = await center(chip("extrude1"));
  const s2 = await center(chip("sketch2"));
  const m = await center(marker);
  await page.mouse.move(m.x, m.y);
  await page.mouse.down();
  await page.mouse.move((e1.right + s2.left) / 2, m.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await summary()).rollback).toBe("extrude1");
  for (const n of ["sketch2", "extrude2", "datum_plane1"]) await expect(chip(n)).toHaveAttribute("data-status", "rolled-back");
  await expect(chip("extrude1")).toHaveAttribute("data-status", "ok");
  expect((await summary()).bodies.map((b) => b.name)).toEqual(["part/extrude1"]);
  await expect(page.getByTestId("timeline-rolled-pill")).toBeVisible();
  // Step forward, jump to the start, roll to the end.
  await page.getByTestId("timeline-next").click();
  await expect.poll(async () => (await summary()).rollback).toBe("sketch2");
  await page.getByTestId("timeline-first").click();
  await expect.poll(async () => (await summary()).rollback).toBe("sketch1");
  await expect.poll(async () => (await summary()).bodies.length).toBe(0);
  await page.getByTestId("timeline-roll-to-end").click();
  await expect.poll(async () => (await summary()).rollback).toBeNull();
  await expect.poll(async () => (await summary()).bodies.length).toBe(2);
  await expect(page.getByTestId("timeline-rolled-pill")).toHaveCount(0);
  // Each move of the marker is one undo step.
  expect((await exec("edit.undo")).value).toMatchObject({ undone: true });
  await expect.poll(async () => (await summary()).rollback).toBe("sketch1");
  await page.getByTestId("timeline-roll-to-end").click();
  await expect.poll(async () => (await summary()).rollback).toBeNull();
});

test("the feature menu renames, suppresses and deletes with its dependents; keys work on the strip", async () => {
  await chip("sketch1").click({ button: "right" });
  await expect(page.getByTestId("timeline-menu")).toBeVisible();
  await expect(page.getByTestId("timeline-menu-up")).toBeDisabled();
  await page.getByTestId("timeline-menu-rename").click();
  await page.getByTestId("rename-input").fill("base");
  await page.getByTestId("rename-input").press("Enter");
  await expect(chip("base")).toBeVisible();

  await chip("extrude2").click({ button: "right" });
  await page.getByTestId("timeline-menu-suppress").click();
  await expect(chip("extrude2")).toHaveAttribute("data-status", "suppressed");
  await expect.poll(async () => (await summary()).bodies.length).toBe(1);
  await chip("extrude2").click({ button: "right" });
  await expect(page.getByTestId("timeline-menu-suppress")).toHaveText(/Unsuppress/);
  await page.getByTestId("timeline-menu-suppress").click();
  await expect(chip("extrude2")).toHaveAttribute("data-status", "ok");

  // Delete a feature others are built on: the dialog lists them, and they go together.
  await chip("base").click({ button: "right" });
  await page.getByTestId("timeline-menu-delete").click();
  const dialog = page.getByTestId("delete-feature-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("delete-dependents").locator("li")).toHaveCount(1);
  await expect(page.getByTestId("delete-dependents")).toContainText("extrude1");
  await expect(page.getByTestId("delete-confirm")).toHaveText("Delete 2 features");
  await page.screenshot({ path: screenshotPath("timeline-delete-dialog.png", "AICAD_E2E_PANELS_SCREENSHOT") });
  await page.getByTestId("delete-confirm").click();
  await expect(dialog).toBeHidden();
  await expect.poll(names).toEqual(["sketch2", "extrude2", "datum_plane1"]);
  expect((await exec("edit.undo")).ok).toBe(true);
  await expect.poll(names).toEqual(["base", "extrude1", "sketch2", "extrude2", "datum_plane1"]);

  // Keys on the strip: arrows select, F2 renames, Delete deletes (nothing is built on the datum).
  await chip("sketch2").click();
  await page.keyboard.press("ArrowRight");
  await expect(chip("extrude2")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(chip("datum_plane1")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("F2");
  await page.getByTestId("rename-input").fill("lid");
  await page.getByTestId("rename-input").press("Enter");
  await expect(chip("lid")).toBeVisible();
  await chip("lid").click();
  await page.keyboard.press("Delete");
  await expect(chip("lid")).toHaveCount(0);
  await expect(page.getByText("Deleted lid")).toBeVisible();
  // Undo, step by step: the delete, the rename to lid, the unsuppress, the suppress, the rename to base.
  const labels: Array<string | null> = [];
  for (let i = 0; i < 5; i++) labels.push(((await exec("edit.undo")).value as { label: string | null }).label);
  expect(labels.length).toBe(5);
  await expect.poll(names).toEqual(ORDER);
  expect((await summary()).bodies.length).toBe(2);
});

test("the Browser: origin, bodies, sketches, construction; eye, isolate and filament colours", async () => {
  await page.getByTestId("dock-tab-browser").click();
  const browser = page.getByTestId("browser");
  await expect(browser.locator('[data-testid="browser-row"][data-kind="body"]')).toHaveCount(2);
  await expect(browser.locator('[data-testid="browser-row"][data-kind="sketch"]')).toHaveCount(2);
  await expect(browser.locator('[data-testid="browser-row"][data-kind="datum"][data-name="datum_plane1"]')).toBeVisible();

  // Hide and show a body (view state: not a model change).
  const before = (await summary()).dirty;
  await bodyRow("part/extrude2").hover();
  await bodyRow("part/extrude2").getByTestId("browser-eye").click();
  await expect.poll(async () => (await view()).bodies["part/extrude2"]?.visible).toBe(false);
  await expect(bodyRow("part/extrude2").getByTestId("browser-eye")).toHaveAttribute("aria-pressed", "false");
  await bodyRow("part/extrude2").getByTestId("browser-eye").click();
  await expect.poll(async () => (await view()).bodies["part/extrude2"]?.visible).toBe(true);
  expect((await summary()).dirty).toBe(before);

  // Isolate, then isolate again shows all.
  await bodyRow("part/extrude1").hover();
  await bodyRow("part/extrude1").getByTestId("browser-isolate").click();
  await expect.poll(async () => (await view()).bodies["part/extrude2"]?.visible).toBe(false);
  await bodyRow("part/extrude1").getByTestId("browser-isolate").click();
  await expect.poll(async () => (await view()).bodies["part/extrude2"]?.visible).toBe(true);

  // A filament colour is the document's appearance of the feature that made the body: undoable.
  await bodyRow("part/extrude1").getByTestId("browser-swatch").click();
  await expect(page.getByTestId("color-popover")).toBeVisible();
  await page.screenshot({ path: screenshotPath("browser-colours.png", "AICAD_E2E_PANELS_SCREENSHOT") });
  await page.getByTestId("color-popover").locator('[data-color="#00ae42"]').click();
  await expect(bodyRow("part/extrude1").getByTestId("browser-swatch")).toHaveAttribute("data-color", "#00ae42");
  expect(((await exec("ir.state")).value as { appearance: Record<string, string> }).appearance).toEqual({ extrude1: "#00ae42" });
  expect((await exec("edit.undo")).ok).toBe(true);
  await expect(bodyRow("part/extrude1").getByTestId("browser-swatch")).toHaveAttribute("data-color", "");

  // A sketch's own eye; the origin; selecting from the tree.
  const sk = browser.locator('[data-testid="browser-row"][data-kind="sketch"][data-name="sketch2"]');
  await sk.getByTestId("browser-eye").click();
  await expect.poll(async () => (await view()).sketchVisibility["sketch2"]).toBe(true);
  await sk.getByTestId("browser-eye").click();
  await expect.poll(async () => (await view()).sketchVisibility["sketch2"]).toBe(false);
  const origin = browser.locator('[data-testid="browser-row"][data-kind="origin-folder"]');
  await origin.getByTestId("browser-eye").click();
  await expect.poll(async () => (await view()).origin).toBe(true);
  await origin.locator(".pzb-chev").click();
  await browser.locator('[data-testid="browser-row"][data-kind="origin"][data-name="XZ"]').click();
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as AW).__pzView.selection())).items).toEqual([expect.objectContaining({ kind: "origin", id: "XZ" })]);
  await bodyRow("part/extrude2").click();
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as AW).__pzView.selection())).items).toEqual([expect.objectContaining({ kind: "body", body: "part/extrude2" })]);
  await origin.getByTestId("browser-eye").click();
});

test("Parameters: every value in one list; expressions evaluate live; promote a value to a parameter", async () => {
  await page.getByTestId("dock-tab-params").click();
  const panel = page.getByTestId("params-panel");
  // Model values: each feature's dimensions.
  const e1 = panel.locator('[data-testid="value-row"][data-key="extrude1/distance"]');
  await expect(e1.getByTestId("value-input")).toHaveValue("8");
  await expect(panel.locator('[data-testid="value-row"][data-key="sketch1/curves/0/w"]').getByTestId("value-input")).toHaveValue("40");

  // Add a parameter and use it.
  await page.getByTestId("params-add").click();
  const form = page.getByTestId("param-add-form");
  await form.getByLabel("New parameter name").fill("h");
  await form.getByLabel("New parameter value").fill("12");
  await page.getByTestId("param-add-submit").click();
  const h = panel.locator('[data-testid="param-row"][data-name="h"]');
  await expect(h.getByTestId("param-value")).toHaveValue("12");
  await e1.getByTestId("value-input").fill("h");
  await e1.getByTestId("value-input").press("Enter");
  await expect(e1.getByTestId("value-eval")).toHaveText("= 12 mm");
  await expect.poll(async () => (await summary()).bbox?.max[2]).toBeCloseTo(12, 6);
  // Edit the parameter: the model rebuilds at once.
  await h.getByTestId("param-value").fill("15");
  await h.getByTestId("param-value").press("Enter");
  await expect.poll(async () => (await summary()).bbox?.max[2]).toBeCloseTo(15, 6);
  await expect(e1.getByTestId("value-eval")).toHaveText("= 15 mm");
  // An expression with units.
  await h.getByTestId("param-value").fill("1 in");
  await h.getByTestId("param-value").press("Enter");
  await expect(h.getByTestId("param-eval")).toHaveText("= 25.4 mm");
  await expect.poll(async () => (await summary()).bbox?.max[2]).toBeCloseTo(25.4, 6);

  // Promote extrude2's distance: a new parameter it now uses, named for it, then renamed.
  const e2 = panel.locator('[data-testid="value-row"][data-key="extrude2/distance"]');
  await e2.getByTestId("value-promote").click();
  await expect(panel.locator('[data-testid="param-row"][data-name="extrude2_distance"]')).toBeVisible();
  await expect(e2.getByTestId("value-input")).toHaveValue("extrude2_distance");
  await expect(page.getByTestId("rename-input")).toBeVisible();
  await page.getByTestId("rename-input").fill("boss_h");
  await page.getByTestId("rename-input").press("Enter");
  await expect(panel.locator('[data-testid="param-row"][data-name="boss_h"]')).toBeVisible();
  await expect(e2.getByTestId("value-input")).toHaveValue("boss_h");
  await expect(e2.getByTestId("value-eval")).toHaveText("= 4 mm");

  // A parameter in use can't be deleted plainly; "keep its value" inlines it.
  await h.click({ button: "right" });
  await page.getByTestId("param-menu-delete").click();
  await expect(page.getByText(/in use|used by|uses/i).first()).toBeVisible();
  await expect(h).toBeVisible();
  await h.click({ button: "right" });
  await page.getByTestId("param-menu-inline").click();
  await expect(h).toHaveCount(0);
  await expect(e1.getByTestId("value-input")).not.toHaveValue("h");
  await expect.poll(async () => (await summary()).bbox?.max[2]).toBeCloseTo(25.4, 6);
  await page.screenshot({ path: screenshotPath("parameters.png", "AICAD_E2E_PANELS_SCREENSHOT") });
});

test("Problems: a failing feature is listed; click selects it, the filter hides it, undo clears it", async () => {
  const boss = page.getByTestId("params-panel").locator('[data-testid="param-row"][data-name="boss_h"]');
  // A zero distance makes extrude2 newly fail: the app asks, and we apply anyway.
  page.once("dialog", (d) => void d.accept());
  await boss.getByTestId("param-value").fill("0");
  await boss.getByTestId("param-value").press("Enter");
  await expect(chip("extrude2")).toHaveAttribute("data-status", "error");
  const problem = page.locator('[data-testid="problem"][data-feature="extrude2"]');
  await expect(problem).toBeVisible();
  await expect(page.getByTestId("timeline-problem-count")).toContainText("1 failed");
  await problem.click();
  await expect(chip("extrude2")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("problems-filter-error").click();
  await expect(problem).toBeHidden();
  await page.getByTestId("problems-filter-error").click();
  await expect(problem).toBeVisible();
  await page.screenshot({ path: screenshotPath("problems.png", "AICAD_E2E_PANELS_SCREENSHOT") });
  expect((await exec("edit.undo")).ok).toBe(true);
  await expect(chip("extrude2")).toHaveAttribute("data-status", "ok");
  await expect(page.getByTestId("problems-count")).toHaveText("0");
});

test("one Undo/Redo across everything: the title bar and ⌘Z / ⇧⌘Z; in sketch mode they undo sketch edits", async () => {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  // Three different kinds of edit: a rename (timeline), a colour (browser), a value (parameters).
  await chip("sketch2").click({ button: "right" });
  await page.getByTestId("timeline-menu-rename").click();
  await page.getByTestId("rename-input").fill("hub");
  await page.getByTestId("rename-input").press("Enter");
  await expect(chip("hub")).toBeVisible();
  await page.getByTestId("dock-tab-browser").click();
  await bodyRow("part/extrude1").getByTestId("browser-swatch").click();
  await page.getByTestId("color-popover").locator('[data-color="#ff6a13"]').click();
  await page.getByTestId("dock-tab-params").click();
  const e1 = page.getByTestId("params-panel").locator('[data-testid="value-row"][data-key="extrude1/distance"]');
  await e1.getByTestId("value-input").fill("10");
  await e1.getByTestId("value-input").press("Enter");
  await expect.poll(async () => (await summary()).bbox?.max[2]).toBeCloseTo(10, 6);
  await expect(page.getByTestId("tb-undo")).toHaveAttribute("title", /Undo/);

  // ⌘Z three times (focus on the timeline strip, not a text field) takes them back in order.
  await chip("hub").click();
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(async () => (await summary()).bbox?.max[2]).toBeCloseTo(25.4, 6);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(async () => ((await exec("ir.state")).value as { appearance: Record<string, string> }).appearance).toEqual({});
  await page.keyboard.press(`${mod}+z`);
  await expect(chip("sketch2")).toBeVisible();
  // The title bar's Redo brings them back.
  await page.getByTestId("tb-redo").click();
  await expect(chip("hub")).toBeVisible();
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect.poll(async () => ((await exec("ir.state")).value as { appearance: Record<string, string> }).appearance).toEqual({ extrude1: "#ff6a13" });
  await page.getByTestId("tb-redo").click();
  await expect.poll(async () => (await summary()).bbox?.max[2]).toBeCloseTo(10, 6);

  // In sketch mode the same Undo steps through the sketch's own edits.
  await page.getByTestId("tool-sketch.new").click();
  await page.getByTestId("sketch-plane-XY").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as AW).__pzSketch.state().phase)).toBe("active");
  await page.keyboard.press("r");
  await expect.poll(() => page.evaluate(() => (window as unknown as AW).__pzSketch.state().tool)).toBe("rect2");
  for (const [u, v] of [
    [4, 4],
    [30, 18],
  ] as const) {
    const [x, y] = await page.evaluate(([a, b]) => (window as unknown as AW).__pzSketch.client(a!, b!), [u, v]);
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as AW).__pzSketch.state().snapshot?.curves.length ?? 0)).toBeGreaterThan(0);
  await expect(page.getByTestId("tb-undo")).toBeEnabled();
  await expect(page.getByTestId("tb-undo")).toHaveAttribute("title", /in sketch/);
  const featuresBefore = (await summary()).features.length;
  await page.getByTestId("tb-undo").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as AW).__pzSketch.state().snapshot?.curves.length ?? 0)).toBe(0);
  expect((await summary()).features.length).toBe(featuresBefore);
  await page.getByTestId("tb-redo").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as AW).__pzSketch.state().snapshot?.curves.length ?? 0)).toBeGreaterThan(0);
  await page.getByTestId("sketch-cancel").click();
  await expect(page.getByTestId("sketch-mode")).toBeHidden();
  // Back on the model, Undo is the document's again.
  await expect(page.getByTestId("tb-undo")).not.toHaveAttribute("title", /in sketch/);
  expect(pageErrors).toEqual([]);
});
