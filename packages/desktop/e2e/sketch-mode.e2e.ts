/**
 * Sketch mode end to end in the desktop app (plan §2.7, §5.1): real mouse and keyboard on the
 * sketch overlay — plane picker, rectangle from the origin, dimensions (a number and a new
 * parameter), fully constrained colouring, a circle dragged by its centre, a conflicting dimension
 * made driven, wheel zoom, and Finish handing an IR v1 sketch feature to the commit sink.
 *
 * Positions come from `window.__pzSketch.client(u, v)` (sketch mm → page pixels); every gesture
 * is a real `page.mouse` / `page.keyboard` event.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { appDir } from "./app-dir.js";
import { screenshotPath } from "./screenshots.js";

let app: ElectronApplication;
let page: Page;
let userData: string;
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
const navigations: string[] = [];

interface SketchState {
  phase: string;
  tool: string;
  view: { scale: number };
  snapshot: {
    ok: boolean;
    status?: string;
    dof?: number;
    curves: Array<{ kind: string; id: string; center?: [number, number]; start?: [number, number]; end?: [number, number] }>;
    constraints: Array<{ id: string; type: string; driving?: boolean; value?: number; expr?: string; measured?: number; state?: string }>;
    profile: { regions: unknown[] };
  } | null;
  dimEdit: { error: string | null; conflict: boolean } | null;
}

declare global {
  interface Window {
    __pzSketch?: { state(): SketchState; client(u: number, v: number): [number, number]; finished(): Array<Record<string, unknown>> };
  }
}

async function sk(): Promise<SketchState> {
  return page.evaluate(() => {
    const s = window.__pzSketch!.state();
    return JSON.parse(JSON.stringify({ phase: s.phase, tool: s.tool, view: s.view, snapshot: s.snapshot, dimEdit: s.dimEdit })) as SketchState;
  });
}

async function at(u: number, v: number): Promise<[number, number]> {
  return page.evaluate(([x, y]) => window.__pzSketch!.client(x!, y!), [u, v]);
}

async function click(u: number, v: number): Promise<void> {
  const [x, y] = await at(u, v);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "aicad-sketch-e2e-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$/.test(k)) env[k] = v;
  app = await electron.launch({
    args: [appDir, "--use-mock-keychain"],
    env: { ...env, AICAD_USER_DATA_DIR: userData, AICAD_SKIP_CLOSE_PROMPT: "1", AICAD_AGENT_DOTENV: "off" },
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("crash", () => pageErrors.push("renderer crashed"));
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navigations.push(f.url());
  });
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1480, height: 920 });
  });
  await expect(page.getByTestId("app-shell")).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

test("opens sketch mode on the XY plane from the toolbar", async () => {
  await page.getByTestId("toolbar-sketch").click();
  await expect(page.getByTestId("sketch-plane-picker")).toBeVisible();
  await page.getByTestId("sketch-plane-XY").click();
  await expect(page.getByTestId("sketch-mode")).toBeVisible();
  await expect.poll(async () => (await sk()).phase).toBe("active");
  await expect(page.getByTestId("sketch-status")).toHaveText(/Empty sketch/);
});

test("draws a rectangle from the origin and dimensions it until it is fully constrained", async () => {
  await page.keyboard.press("r");
  await expect.poll(async () => (await sk()).tool).toBe("rect2");
  await click(0.2, 0.2); // the origin snap pins the corner
  await click(40, 25);
  let s = await sk();
  expect(s.snapshot!.curves.filter((c) => c.kind === "line")).toHaveLength(4);
  expect(s.snapshot!.dof).toBe(2);
  await expect(page.getByTestId("sketch-status")).toHaveText(/2 DOF left/);
  await expect(page.locator('[data-dof="free"]')).toHaveCount(4);

  // Width: dimension the bottom edge, type a number.
  await page.keyboard.press("d");
  await click(20, 0);
  await click(20, -8);
  await expect(page.getByTestId("sketch-dim-input")).toBeVisible();
  await page.getByTestId("sketch-dim-input").fill("50");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sketch-dim-input")).toBeHidden();
  // Height: dimension the right edge (now at x = 50) with a new parameter.
  await click(50, 12);
  await click(62, 12);
  await page.getByTestId("sketch-dim-input").fill("height = 30");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sketch-dim-input")).toBeHidden();

  s = await sk();
  expect(s.snapshot!.status).toBe("fully_constrained");
  await expect(page.getByTestId("sketch-status")).toHaveText(/Fully constrained/);
  await expect(page.locator('[data-dof="fixed"]')).toHaveCount(4);
  const h = s.snapshot!.constraints.find((c) => c.expr === "height")!;
  expect(h.measured).toBeCloseTo(30, 6);
});

test("drags a circle by its centre and resolves a conflicting dimension by making it driven", async () => {
  await page.keyboard.press("c");
  await click(25, 15);
  await click(30, 15);
  let s = await sk();
  const circle = s.snapshot!.curves.find((c) => c.kind === "circle")!;
  expect(circle.center).toEqual([25, 15]);

  // Select tool, then drag the centre with the mouse.
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await sk()).tool).toBe("select");
  const [x0, y0] = await at(25, 15);
  const [x1, y1] = await at(15, 10);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(x0 + ((x1 - x0) * k) / 8, y0 + ((y1 - y0) * k) / 8);
  await page.mouse.up();
  s = await sk();
  const moved = s.snapshot!.curves.find((c) => c.id === circle.id)!;
  expect(moved.center![0]).toBeCloseTo(15, 1);
  expect(moved.center![1]).toBeCloseTo(10, 1);

  // The top edge is already 50 long: a 40 conflicts.
  await page.keyboard.press("d");
  await click(20, 30);
  await click(20, 38);
  await page.getByTestId("sketch-dim-input").fill("40");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sketch-dim-error")).toBeVisible();
  await page.getByTestId("sketch-make-driven").click();
  await expect(page.getByTestId("sketch-dim-input")).toBeHidden();
  s = await sk();
  const driven = s.snapshot!.constraints.find((c) => c.driving === false)!;
  expect(driven.measured).toBeCloseTo(50, 6);
  expect(s.snapshot!.ok).toBe(true);
});

test("zooms with the wheel (mouse) and pans with a shift-scroll (trackpad)", async () => {
  const before = (await sk()).view.scale;
  const [x, y] = await at(25, 15);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await sk()).view.scale).toBeGreaterThan(before);
  // Shift + scroll pans (FD3: Shift + two-finger pan); the sketch moves with the fingers.
  const [, ay] = await at(0, 0);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 60);
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await at(0, 0))[1]).toBeCloseTo(ay - 60, 3);
  expect(navigations.length).toBeLessThanOrEqual(1);
});

test("finishes into an IR v1 sketch feature with its new parameter", async () => {
  await page.screenshot({ path: screenshotPath("sketch-mode.png", "AICAD_E2E_SKETCH_SCREENSHOT") });
  await page.getByTestId("sketch-finish").click();
  await expect(page.getByTestId("sketch-mode")).toBeHidden();
  const results = await page.evaluate(() => window.__pzSketch!.finished());
  expect(results).toHaveLength(1);
  const f = results[0] as { mode: string; feature: { type: string; plane: string; curves: unknown[]; constraints: unknown[] }; params: Array<{ name: string }>; check: { ok: boolean; regions: number } };
  expect(f.mode).toBe("new");
  expect(f.feature.type).toBe("sketch");
  expect(f.feature.plane).toBe("XY");
  expect(f.feature.curves).toHaveLength(5);
  expect(f.check.ok).toBe(true);
  expect(f.check.regions).toBe(1);
  expect(f.params.map((p) => p.name)).toEqual(["height"]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((e) => /sketch/i.test(e))).toEqual([]);
});
