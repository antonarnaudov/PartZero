/**
 * The modify and pattern tools in the desktop app, driven like a person drives them: toolbar
 * buttons, real mouse clicks on edges and faces in the viewport, typed values, dragged handles, the
 * timeline (feature seeds, double-click to re-edit) and OK. Each tool commits ONE catalogue op, and
 * the agent's op host builds the same feature from the same JSON.
 *
 * The part: a 40 × 20 × 10 block (`e1`) with a 4 × 4 pocket 3 deep at x = 10 (`e2`), seen in the iso
 * view (from +X, −Y, +Z: the top, the front y = −10 and the right x = 20 face the camera).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { appDir } from "./app-dir.js";
import { screenshotPath } from "./screenshots.js";

type Vec3 = [number, number, number];

interface Result {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string; detail?: { code: string } };
}

interface FeatureJson {
  id: string;
  name: string;
  type: string;
  author?: string;
  [k: string]: unknown;
}

type AW = {
  __aicad: {
    execute(cmd: unknown): Promise<Result>;
    idle(): Promise<unknown>;
    ops: { document(): Promise<string>; apply(ops: unknown[], options?: { label?: string }): Promise<unknown> };
  };
  __pzView: {
    projectPage(p: Vec3): { x: number; y: number } | null;
    setAnimationMs(ms: number): void;
    camera(): unknown;
    selection(): { items: Array<{ kind: string; key?: string }> };
    topology(): Array<{ body: string; faces: string[]; edges: string[] }>;
    handles(): Array<{ id: string; value: number; max?: number; origin: Vec3; axis: Vec3 }>;
    pickAt(x: number, y: number): Promise<{ kind: string; key?: string } | null>;
  };
};

let app: ElectronApplication;
let page: Page;
let userData: string;
const pageErrors: string[] = [];

const T = 10;
const BLOCK = JSON.stringify({
  schema: "aicad.ir/1",
  meta: { name: "block" },
  params: [],
  parts: [
    {
      id: "p1",
      name: "part",
      features: [
        { type: "sketch", id: "s1", name: "outline", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: 40, h: 20 }] },
        { type: "extrude", id: "e1", name: "block", sketch: "s1", distance: T },
        { type: "sketch", id: "s2", name: "pocket_sketch", plane: { origin: [0, 0, T], normal: [0, 0, 1], x_dir: [1, 0, 0] }, curves: [{ kind: "rect", id: "p", center: [10, 0], w: 4, h: 4 }] },
        { type: "extrude", id: "e2", name: "pocket", sketch: "s2", distance: 3, direction: "reverse", op: "cut", targets: "all" },
      ],
    },
  ],
});

/** The block's top front edge (y = −10, z = 10) and its front-right vertical edge. */
const TOP_FRONT: Vec3 = [-6, -10, T];
const RIGHT_VERTICAL: Vec3 = [20, -10, T / 2];
const FRONT_FACE: Vec3 = [-8, -10, T / 2];

async function exec(id: string, args: Record<string, unknown> = {}): Promise<Result> {
  return page.evaluate(([i, a]) => (window as unknown as AW).__aicad.execute({ id: i, args: a }), [id, args] as const);
}

async function features(): Promise<FeatureJson[]> {
  const r = await exec("ir.state", { document: true });
  const d = JSON.parse((r.value as { document: string }).document) as { parts: Array<{ features: FeatureJson[] }> };
  return d.parts[0]!.features;
}

async function feasibleLog(): Promise<Array<{ field: string; max?: number; reason?: string; error?: string }>> {
  return page.evaluate(() => (window as unknown as { __partzero: { panel(): { feasible?: Array<{ field: string; max?: number }> } | null } }).__partzero.panel()?.feasible ?? []);
}

const row = (id: string) => page.locator(`[data-testid="timeline-feature"][data-feature-id="${id}"]`);
const panel = () => page.getByTestId("property-panel");

async function load(doc = BLOCK): Promise<void> {
  if (await panel().isVisible()) await page.getByTestId("panel-cancel").click();
  const r = await exec("ir.load", { document: doc });
  expect(r.ok, r.error?.message).toBe(true);
  await page.evaluate(() => (window as unknown as AW).__aicad.idle());
  await expect(row("e2")).toHaveAttribute("data-status", "ok");
  await page.waitForFunction(() => (window as unknown as AW).__pzView.topology().some((b) => b.faces.some((f) => f.startsWith("e2/"))));
  expect((await exec("view.setView", { view: "iso" })).ok).toBe(true);
  await exec("view.fit");
}

async function at(p: Vec3): Promise<{ x: number; y: number }> {
  const q = await page.evaluate((w) => (window as unknown as AW).__pzView.projectPage(w), p);
  if (!q) throw new Error(`${p.join(",")} is behind the camera`);
  return q;
}

async function clickAt(p: Vec3): Promise<void> {
  const q = await at(p);
  await page.mouse.move(q.x, q.y);
  await page.mouse.click(q.x, q.y);
}

async function startTool(id: string): Promise<void> {
  await page.getByTestId(`tool-${id}`).click();
  await expect(panel()).toBeVisible();
}

async function fill(key: string, text: string): Promise<void> {
  const input = page.getByTestId(`input-${key}`);
  await input.fill(text);
}

async function ready(): Promise<void> {
  await expect(panel()).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
}

async function ok(): Promise<void> {
  await ready();
  await page.getByTestId("panel-ok").click();
  await expect(panel()).toBeHidden();
  await page.evaluate(() => (window as unknown as AW).__aicad.idle());
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "aicad-feature-tools-e2e-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$/.test(k)) env[k] = v;
  app = await electron.launch({
    args: [appDir, "--use-mock-keychain"],
    env: { ...env, AICAD_USER_DATA_DIR: userData, AICAD_SKIP_CLOSE_PROMPT: "1", AICAD_AGENT_DOTENV: "off" },
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1480, height: 920 });
  });
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as Partial<AW>).__aicad && !!(window as unknown as Partial<AW>).__pzView, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => (window as unknown as AW).__pzView.camera() !== null, undefined, { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as AW).__pzView.setAnimationMs(0));
});

test.afterAll(async () => {
  await app?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

test("Fillet: click an edge, type a radius, drag the handle (it stops at Forge's largest radius), OK → one undoable fillet", async () => {
  await load();
  await startTool("feature.fillet");
  await clickAt(TOP_FRONT);
  await expect(page.getByTestId("selection-count-edges")).toHaveText("1 edge");
  await fill("r", "2");
  await ready();
  await expect(page.getByTestId("panel-summary")).toContainText("Edges");
  // The radius knob sits on the picked edge; dragged far out it stops at the feasible maximum.
  await expect(page.getByTestId("handle-r")).toBeVisible();
  const g = (await page.getByTestId("handle-r").boundingBox())!;
  const h = (await page.evaluate(() => (window as unknown as AW).__pzView.handles()))[0]!;
  const far = await at([h.origin[0] + h.axis[0] * 60, h.origin[1] + h.axis[1] * 60, h.origin[2] + h.axis[2] * 60]);
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(far.x, far.y, { steps: 12 });
  // Forge's feasible range was asked at drag start: past ≈ 8 mm the blend runs into the pocket
  // (Forge cannot build that yet), so the largest radius that builds is found by bisection…
  await expect.poll(async () => (await feasibleLog()).at(-1)?.max ?? null, { timeout: 15_000 }).not.toBeNull();
  const max = (await feasibleLog()).at(-1)!.max!;
  expect(max).toBeGreaterThan(7);
  expect(max).toBeLessThanOrEqual(8.001);
  // …and the handle stops there, saying why.
  await expect(page.getByTestId("handle-value")).toContainText("max", { timeout: 15_000 });
  await page.mouse.up();
  await expect(page.getByTestId("input-r")).toHaveValue(String(max));
  await fill("r", "3");
  const before = (await features()).length;
  await ok();
  const fs = await features();
  expect(fs).toHaveLength(before + 1);
  const f = fs.at(-1)!;
  expect(f).toMatchObject({ id: "fillet1", type: "fillet", r: 3, edges: { kind: "edge" } });
  expect((f["edges"] as { capture?: unknown }).capture).toBeTruthy();
  await expect(row("fillet1")).toHaveAttribute("data-status", "ok");
  await expect(row("fillet1")).toHaveAttribute("data-author", "user");
  await page.screenshot({ path: screenshotPath("feature-tools-fillet.png", "AICAD_E2E_FILLET_SCREENSHOT") });
  // One undo step.
  expect((await exec("edit.undo")).ok).toBe(true);
  await expect(row("fillet1")).toHaveCount(0);
  expect((await exec("edit.redo")).ok).toBe(true);
  await expect(row("fillet1")).toHaveAttribute("data-status", "ok");
});

test("Fillet: too large is shown on the field with the largest that builds; Use applies it; double-click re-edits", async () => {
  await row("fillet1").dblclick();
  await expect(panel()).toBeVisible();
  await expect(panel()).toContainText("Edit fillet1");
  await expect(page.getByTestId("selection-count-edges")).toHaveText("1 edge");
  await fill("r", "25");
  await expect(page.getByTestId("field-error-r")).toContainText("Builds with", { timeout: 30_000 });
  await page.getByTestId("use-feasible-r").click();
  const used = Number(await page.getByTestId("input-r").inputValue());
  expect(used).toBeGreaterThan(7);
  expect(used).toBeLessThanOrEqual(8.001);
  await ok();
  expect((await features()).find((f) => f.id === "fillet1")?.["r"]).toBe(used);
  await expect(row("fillet1")).toHaveAttribute("data-status", "ok");
});

test("Fillet: the agent's op host builds the same fillet from the same JSON (marked as the agent's)", async () => {
  const mine = (await features()).find((f) => f.id === "fillet1")!;
  expect((await exec("edit.undo")).ok).toBe(true);
  expect((await exec("edit.undo")).ok).toBe(true);
  await expect(row("fillet1")).toHaveCount(0);
  await page.evaluate((f) => (window as unknown as AW).__aicad.ops.apply([{ op: "addFeature", feature: { type: "fillet", r: f["r"], edges: f["edges"] } }]), mine);
  await page.evaluate(() => (window as unknown as AW).__aicad.idle());
  const agents = (await features()).find((f) => f.id === "fillet1")!;
  expect({ ...agents, author: undefined, r: undefined }).toEqual({ ...mine, author: undefined, r: undefined });
  expect(agents.author).toBe("agent");
  await expect(row("fillet1")).toHaveAttribute("data-author", "agent");
});

test("Chamfer: two distances, the first measured on a picked face", async () => {
  await load();
  await startTool("feature.chamfer");
  await clickAt(RIGHT_VERTICAL);
  await expect(page.getByTestId("selection-count-edges")).toHaveText("1 edge");
  await page.getByTestId("choice-form-two").click();
  await fill("d", "2");
  await fill("d2", "4");
  // Pick the face the first distance is measured on: the front.
  await page.getByTestId("selection-side").click();
  await clickAt([10, -10, 4]);
  await expect(page.getByTestId("selection-count-side")).toHaveText("1 face");
  await ok();
  expect((await features()).at(-1)).toMatchObject({ type: "chamfer", d: 2, d2: 4, side: { kind: "face" }, edges: { kind: "edge" } });
  await expect(row("chamfer1")).toHaveAttribute("data-status", "ok");
});

test("Shell: remove the front face, 2 mm walls; too thick is refused on the field", async () => {
  await load();
  await startTool("feature.shell");
  await clickAt(FRONT_FACE);
  await expect(page.getByTestId("selection-count-open")).toHaveText("1 face");
  await fill("thickness", "12");
  // The pocket's floor meets the bottom wall first: Forge's largest wall is 3.499 mm.
  await expect(page.getByTestId("field-error-thickness")).toContainText("Builds with", { timeout: 30_000 });
  await expect(page.getByTestId("use-feasible-thickness")).toHaveText("Use 3.499 mm");
  await fill("thickness", "2");
  await ready();
  await expect(page.getByTestId("handle-thickness")).toBeVisible();
  await expect(page.getByTestId("panel-summary")).toContainText("Opened faces");
  await ok();
  expect((await features()).at(-1)).toMatchObject({ type: "shell", thickness: 2, open: { kind: "face" }, body: { kind: "body" } });
  await expect(row("shell1")).toHaveAttribute("data-status", "ok");
  await page.screenshot({ path: screenshotPath("feature-tools-shell.png", "AICAD_E2E_SHELL_SCREENSHOT") });
});

test("Draft: the top is refused on Walls; the front and right walls taper 4° about XY with an angle handle; double-click re-edits", async () => {
  await load();
  await startTool("feature.draft");
  await expect(page.getByTestId("selection-count-neutral")).toHaveText("1 plane");
  // The top is not square to the pull direction (+Z from the XY neutral plane).
  await clickAt([-4, 4, T]);
  await expect(page.getByTestId("field-error-faces")).toContainText("cannot be drafted", { timeout: 30_000 });
  await clickAt([-4, 4, T]);
  await clickAt(FRONT_FACE);
  await clickAt([20, 4, T / 2]);
  await expect(page.getByTestId("selection-count-faces")).toHaveText("2 faces");
  await fill("angle", "4");
  await ready();
  await expect(page.getByTestId("handle-angle")).toBeVisible();
  await expect(page.getByTestId("panel-summary")).toContainText("Walls");
  await ok();
  const f = (await features()).at(-1)!;
  expect(f).toMatchObject({ type: "draft", neutral: "XY", angle: 4, faces: { kind: "face" } });
  await expect(row("draft1")).toHaveAttribute("data-status", "ok");
  await page.screenshot({ path: screenshotPath("feature-tools-draft.png", "AICAD_E2E_DRAFT_SCREENSHOT") });
  await row("draft1").dblclick();
  await expect(panel()).toContainText("Edit draft1");
  await expect(page.getByTestId("selection-count-faces")).toHaveText("2 faces");
  await fill("angle", "6");
  await ok();
  expect((await features()).at(-1)).toMatchObject({ type: "draft", angle: 6, faces: f["faces"] });
  await expect(row("draft1")).toHaveAttribute("data-status", "ok");
});

test("Linear pattern: the pocket picked in the timeline, 3 along −X, 8 mm apart", async () => {
  await load();
  await startTool("pattern.linear");
  await row("e2").click();
  await expect(page.getByTestId("selection-count-features")).toHaveText("1 feature");
  await fill("count", "3");
  await fill("spacing", "-8");
  await ready();
  await expect(page.getByTestId("panel-summary")).toContainText("Copies");
  await expect(page.getByTestId("handle-spacing")).toBeVisible();
  await ok();
  expect((await features()).at(-1)).toMatchObject({ type: "pattern", seed: { features: ["e2"] }, layout: { linear: { dir: "X", count: 3, spacing: -8 } } });
  await expect(row("pattern1")).toHaveAttribute("data-status", "ok");
  // The copies are pockets in the top: the viewport shows their faces.
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as AW).__pzView.topology())).flatMap((b) => b.faces).filter((f) => f.startsWith("pattern1/")).length).toBeGreaterThanOrEqual(5);
});

test("Circular pattern: the block copied around Z, 4 over 360°; double-click re-edits it as a circular pattern", async () => {
  await load();
  await startTool("pattern.circular");
  await page.getByTestId("choice-seedKind-bodies").click();
  await clickAt([15, -10, 5]);
  await expect(page.getByTestId("selection-count-bodies")).toHaveText("1 body");
  await fill("count", "4");
  await ok();
  expect((await features()).at(-1)).toMatchObject({ type: "pattern", seed: { bodies: { kind: "body" } }, layout: { circular: { axis: "Z", count: 4 } } });
  await expect(row("pattern1")).toHaveAttribute("data-status", "ok");
  await row("pattern1").dblclick();
  await expect(panel()).toContainText("Edit pattern1");
  await expect(page.getByTestId("field-axis")).toBeVisible();
  await fill("count", "3");
  await ok();
  expect((await features()).at(-1)).toMatchObject({ layout: { circular: { count: 3 } } });
});

test("Mirror: the pocket across the YZ plane; a feature Forge cannot repeat is refused on the field", async () => {
  await load();
  await startTool("pattern.mirror");
  await row("s1").click();
  await expect(page.getByTestId("field-error-features")).toContainText("Only extrudes", { timeout: 30_000 });
  await row("s1").click();
  await row("e2").click();
  await expect(page.getByTestId("selection-count-features")).toHaveText("1 feature");
  await ok();
  expect((await features()).at(-1)).toMatchObject({ type: "pattern", seed: { features: ["e2"] }, layout: { mirror: { plane: "YZ" } } });
  await expect(row("pattern1")).toHaveAttribute("data-status", "ok");
  expect(pageErrors).toEqual([]);
});
