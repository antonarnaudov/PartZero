/**
 * Sketch mode end to end in the desktop app (plan §2.7, §5.1): real mouse and keyboard on the
 * sketch overlay — plane picker, rectangle from the origin, dimensions (a number and a new
 * parameter), fully constrained colouring, a circle dragged by its centre, a conflicting dimension
 * made driven, mouse wheel / trackpad / pinch navigation, and Finish putting the sketch in the
 * open CadScript document: a timeline row, extruded from the Finish offer into a body, reopened
 * from the timeline with its constraints. Then the XZ plane, undo/redo, trim, Esc unwinding,
 * Cancel, and a conflicting sketch repaired with one click.
 *
 * Positions come from `window.__pzSketch.client(u, v)` (sketch mm → page pixels); every gesture
 * is a real `page.mouse` / `page.keyboard` event, except the trackpad and pinch traces, which are
 * `WheelEvent`s dispatched on the sketch canvas (Playwright's wheel is a notched mouse wheel).
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
    __pzSketch?: {
      state(): SketchState & { mode: string; sketchName: string; notice: { text: string } | null };
      client(u: number, v: number): [number, number];
      finished(): Array<Record<string, unknown>>;
      mode: { begin(o: unknown): Promise<boolean> };
    };
  }
}

interface DocView {
  features: Array<{ name: string; type: string; status: string | null }>;
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
}

/** The document once compile and evaluation settled (`window.__aicad`, declared in smoke.e2e.ts). */
async function docView(): Promise<DocView> {
  return page.evaluate(async () => {
    const s = (await window.__aicad!.idle()) as unknown as DocView;
    return JSON.parse(JSON.stringify({ features: s.features, bbox: s.bbox })) as DocView;
  });
}

const row = (name: string) => page.locator(`[data-testid="timeline-feature"][data-feature="${name}"]`);

/** Dispatch a trace of wheel events on the sketch canvas (a trackpad or a pinch), 16 ms apart. */
async function wheelTrace(trace: Array<{ deltaX?: number; deltaY: number; ctrlKey?: boolean; shiftKey?: boolean }>): Promise<void> {
  const [x, y] = await at(0, 0);
  await page.evaluate(
    async ([events, cx, cy]) => {
      const el = document.querySelector("[data-testid=sketch-canvas]")!;
      for (const e of events) {
        el.dispatchEvent(new WheelEvent("wheel", { deltaX: e.deltaX ?? 0, deltaY: e.deltaY, deltaMode: 0, ctrlKey: !!e.ctrlKey, shiftKey: !!e.shiftKey, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 16));
      }
    },
    [trace, x, y] as const,
  );
}

/** Open a new sketch on a named plane from the toolbar. */
async function newSketch(plane: "XY" | "XZ" | "YZ"): Promise<void> {
  await page.getByTestId("tool-sketch.new").click();
  await page.getByTestId(`sketch-plane-${plane}`).click();
  await expect.poll(async () => (await sk()).phase).toBe("active");
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
  await page.getByTestId("tool-sketch.new").click();
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

test("zooms with a mouse wheel and a pinch, and pans with two fingers (FD3)", async () => {
  const before = (await sk()).view.scale;
  const [x, y] = await at(25, 15);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await sk()).view.scale).toBeGreaterThan(before);
  // A two-finger scroll (fractional deltas, horizontal jitter) pans without zooming; the sketch
  // moves like page content.
  const scale = (await sk()).view.scale;
  const [ax, ay] = await at(0, 0);
  await wheelTrace([{ deltaY: 2.5 }, { deltaX: 0.5, deltaY: 6 }, { deltaY: 12.5 }, { deltaY: 9 }]);
  await expect.poll(async () => (await at(0, 0))[1]).toBeCloseTo(ay - 30, 3);
  expect((await at(0, 0))[0]).toBeCloseTo(ax - 0.5, 3);
  expect((await sk()).view.scale).toBe(scale);
  // Shift + two fingers pans too; a pinch (ctrl + wheel) zooms in.
  await wheelTrace([{ deltaY: 3.5, shiftKey: true }]);
  await expect.poll(async () => (await at(0, 0))[1]).toBeCloseTo(ay - 33.5, 3);
  await wheelTrace([{ deltaY: -4.5, ctrlKey: true }, { deltaY: -3.25, ctrlKey: true }]);
  await expect.poll(async () => (await sk()).view.scale).toBeGreaterThan(scale);
  await page.keyboard.press("f"); // fit again for the next gestures
  expect(navigations.length).toBeLessThanOrEqual(1);
});

let startFeatures: string[] = [];

test("finishes into the document: a timeline row for the new sketch", async () => {
  startFeatures = (await docView()).features.map((f) => f.name);
  expect(startFeatures).not.toContain("sketch1");
  await page.screenshot({ path: screenshotPath("sketch-mode.png", "AICAD_E2E_SKETCH_SCREENSHOT") });
  await page.getByTestId("sketch-finish").click();
  await expect(page.getByTestId("sketch-mode")).toBeHidden();
  const results = await page.evaluate(() => window.__pzSketch!.finished());
  expect(results).toHaveLength(1);
  const f = results[0] as { mode: string; feature: { type: string; name: string; plane: string; curves: unknown[]; constraints: unknown[] }; params: Array<{ name: string }>; check: { ok: boolean; regions: number } };
  expect(f.mode).toBe("new");
  expect(f.feature.type).toBe("sketch");
  expect(f.feature.name).toBe("sketch1");
  expect(f.feature.plane).toBe("XY");
  expect(f.feature.curves).toHaveLength(5);
  expect(f.check.ok).toBe(true);
  expect(f.check.regions).toBe(1);
  expect(f.params.map((p) => p.name)).toEqual(["height"]);
  // In the model: the timeline shows it, evaluated, and it is selected.
  await expect(row("sketch1")).toHaveAttribute("data-status", "ok");
  await expect(row("sketch1")).toHaveClass(/selected/);
  const doc = await docView();
  expect(doc.features.map((x) => x.name)).toEqual([...startFeatures, "sketch1"]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((e) => /sketch/i.test(e))).toEqual([]);
});

test("extrudes the finished sketch from the Finish offer into a body", async () => {
  await expect(page.getByTestId("sketch-extrude-offer")).toBeVisible();
  await page.getByTestId("sketch-extrude-distance").fill("12");
  await page.getByTestId("sketch-extrude-run").click();
  await expect(page.getByTestId("sketch-extrude-offer")).toBeHidden();
  await expect(row("extrude1")).toHaveAttribute("data-status", "ok");
  const doc = await docView();
  expect(doc.features.map((x) => x.name)).toEqual([...startFeatures, "sketch1", "extrude1"]);
  // The 50 × 30 plate from the origin, 12 high: the model's box reaches it.
  expect(doc.bbox!.max[0]).toBeCloseTo(50, 6);
  expect(doc.bbox!.max[1]).toBeCloseTo(30, 6);
  expect(doc.bbox!.max[2]).toBeCloseTo(12, 6);
  // ⌘Z in the app takes the extrude back out, ⇧⌘Z puts it back.
  await page.evaluate(() => window.__aicad!.execute({ id: "edit.undo" }));
  await expect(row("extrude1")).toHaveCount(0);
  await page.evaluate(() => window.__aicad!.execute({ id: "edit.redo" }));
  await expect(row("extrude1")).toHaveAttribute("data-status", "ok");
});

test("reopens the sketch from the timeline with its constraints, and Cancel changes nothing", async () => {
  await row("sketch1").dblclick();
  await expect(page.getByTestId("sketch-mode")).toBeVisible();
  await expect.poll(async () => (await sk()).phase).toBe("active");
  const s = await page.evaluate(() => {
    const x = window.__pzSketch!.state();
    return JSON.parse(JSON.stringify({ mode: x.mode, name: x.sketchName, constraints: x.snapshot!.constraints })) as { mode: string; name: string; constraints: Array<{ expr?: string; measured?: number }> };
  });
  expect(s.mode).toBe("edit");
  expect(s.name).toBe("sketch1");
  expect(s.constraints.find((c) => c.expr === "height")!.measured).toBeCloseTo(30, 6);
  await page.getByTestId("sketch-cancel").click();
  await expect(page.getByTestId("sketch-mode")).toBeHidden();
  expect((await docView()).features.map((x) => x.name)).toEqual([...startFeatures, "sketch1", "extrude1"]);
  expect(await page.evaluate(() => window.__pzSketch!.finished().length)).toBe(1);
});

test("sketches on XZ, with undo and redo inside the sketch", async () => {
  await newSketch("XZ");
  await expect(page.getByTestId("sketch-mode")).toContainText("XZ plane");
  await page.keyboard.press("c");
  await click(0, 20);
  await click(8, 20);
  await page.keyboard.press("l");
  await click(-30, 0);
  await click(-10, 0);
  await page.keyboard.press("Escape");
  expect((await sk()).snapshot!.curves.map((c) => c.kind).sort()).toEqual(["circle", "line"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await sk()).snapshot!.curves.map((c) => c.kind)).toEqual(["circle"]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => (await sk()).snapshot!.curves.length).toBe(2);
  await page.getByTestId("sketch-undo").click();
  await expect.poll(async () => (await sk()).snapshot!.curves.map((c) => c.kind)).toEqual(["circle"]);
  await page.getByTestId("sketch-finish").click();
  await expect(page.getByTestId("sketch-mode")).toBeHidden();
  await expect(row("sketch2")).toHaveAttribute("data-status", "ok");
  const f = (await page.evaluate(() => window.__pzSketch!.finished()))[1] as { feature: { name: string; plane: string } };
  expect(f.feature).toMatchObject({ name: "sketch2", plane: "XZ" });
  await page.getByTestId("sketch-extrude-close").click();
  await expect(page.getByTestId("sketch-extrude-offer")).toBeHidden();
});

test("trims with the mouse, unwinds with Esc, and cancels", async () => {
  await newSketch("YZ");
  await page.keyboard.press("l");
  await page.keyboard.down("Alt"); // no snapping: two free lines
  await click(-20, 0);
  await click(20, 0);
  await page.keyboard.press("Escape");
  await click(0, -20);
  await click(0, 20);
  await page.keyboard.up("Alt");
  await page.keyboard.press("Escape"); // ends the chain
  await expect.poll(async () => (await sk()).tool).toBe("line");
  await page.keyboard.press("Escape"); // leaves the tool
  await expect.poll(async () => (await sk()).tool).toBe("select");
  await page.keyboard.press("t");
  await click(12, 0);
  const h = (await sk()).snapshot!.curves.find((c) => c.kind === "line" && c.start![1] === 0 && c.end![1] === 0)!;
  expect(Math.max(h.start![0], h.end![0])).toBeCloseTo(0, 6);
  // Esc: trim → select; Esc with nothing selected finishes, which an open sketch refuses.
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await sk()).tool).toBe("select");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sketch-notice")).toContainText("would fail");
  await expect(page.getByTestId("sketch-mode")).toBeVisible();
  await page.getByTestId("sketch-cancel").click();
  await expect(page.getByTestId("sketch-mode")).toBeHidden();
  expect(await page.evaluate(() => window.__pzSketch!.finished().length)).toBe(2);
  expect((await docView()).features.map((x) => x.name)).not.toContain("sketch3");
});

test("repairs a conflicting sketch with one click in the inspector", async () => {
  // A conflicting constrained sketch, as an agent's sketch_edit could leave one.
  await page.evaluate(() =>
    window.__pzSketch!.mode.begin({
      plane: { ref: "XY", frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] }, label: "XY plane" },
      id: "probe",
      name: "probe",
      sketch: {
        type: "sketch",
        id: "probe",
        name: "probe",
        plane: "XY",
        curves: [{ kind: "line", id: "l", start: [0, 0], end: [10, 0] }],
        constraints: [
          { type: "fix", id: "pin", entity: "l.start" },
          { type: "horizontal", id: "h", line: "l" },
          { type: "distance", id: "d1", a: "l.start", b: "l.end", value: 10 },
          { type: "distance", id: "d2", a: "l.start", b: "l.end", value: 12 },
        ],
      },
    }),
  );
  await expect(page.getByTestId("sketch-conflicts")).toBeVisible();
  await expect(page.getByTestId("sketch-status")).toHaveText(/Conflict/);
  await page.getByTestId("sketch-remove-d2").click();
  await expect(page.getByTestId("sketch-conflicts")).toBeHidden();
  await expect(page.getByTestId("sketch-status")).toHaveText(/Fully constrained/);
  const s = await sk();
  expect(s.snapshot!.constraints.map((c) => c.id)).not.toContain("d2");
  await page.getByTestId("sketch-cancel").click();
  await expect(page.getByTestId("sketch-mode")).toBeHidden();
  expect(pageErrors).toEqual([]);
});
