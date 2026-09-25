/**
 * The create and construct tools end to end in the desktop app (FULL-MODELING-PLAN §5.1): each tool
 * opens from the toolbar or its key, prefills from the selection, previews live (the panel's check
 * and the viewport's handles), takes a typed value and a real mouse drag of its handle, commits ONE
 * transaction (undo restores the bytes, redo the next), re-edits its feature from the timeline,
 * shows errors on the right field without committing, and runs the same command (`model.*`) the
 * agent's tools run. Picks that carry geometry are followed by typed values (determinism rules).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { appDir } from "./app-dir.js";
import { screenshotPath } from "./screenshots.js";

type V3 = [number, number, number];

interface Result {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
}

interface PanelInfo {
  toolId: string | null;
  title: string;
  state: string;
  values: Record<string, unknown>;
  fieldErrors: Record<string, string>;
  errors: Array<{ code?: string; message: string }>;
  summary: Array<{ label: string; value: string }>;
}

type AW = {
  __aicad: { execute(cmd: unknown): Promise<Result>; idle(): Promise<unknown> };
  __partzero: { panel(): PanelInfo | null; startTool(id: string): Promise<{ started: boolean; reason?: string }> };
  __pzView: {
    execute(cmd: unknown): Promise<Result>;
    projectPage(p: V3): { x: number; y: number } | null;
    handles(): Array<{ id: string; value: number; origin: V3; axis: V3; kind: string }>;
    setAnimationMs(ms: number): void;
    camera(): unknown;
    selection(): { items: Array<{ kind: string; key?: string; body?: string; point?: V3 }> };
  };
};

let app: ElectronApplication;
let page: Page;
let userData: string;
const pageErrors: string[] = [];

async function exec(id: string, args: Record<string, unknown> = {}): Promise<Result> {
  return page.evaluate(([i, a]) => (window as unknown as AW).__aicad.execute({ id: i, args: a }), [id, args] as const);
}

async function view(id: string, args: Record<string, unknown> = {}): Promise<Result> {
  return page.evaluate(([i, a]) => (window as unknown as AW).__pzView.execute({ id: i, args: a }), [id, args] as const);
}

async function model(): Promise<{ parts: Array<{ features: Array<Record<string, unknown>> }>; params?: Array<Record<string, unknown>> }> {
  const r = await exec("ir.state", { document: true });
  return JSON.parse((r.value as { document: string }).document) as { parts: Array<{ features: Array<Record<string, unknown>> }> };
}

async function text(): Promise<string> {
  return ((await exec("ir.state", { document: true })).value as { document: string }).document;
}

async function feature(id: string): Promise<Record<string, unknown> | undefined> {
  return (await model()).parts.flatMap((p) => p.features).find((f) => f["id"] === id);
}

async function panel(): Promise<PanelInfo | null> {
  return page.evaluate(() => (window as unknown as AW).__partzero.panel());
}

async function ready(): Promise<PanelInfo> {
  await expect.poll(async () => (await panel())?.state, { timeout: 20_000 }).toBe("ready");
  return (await panel())!;
}

async function handles() {
  return page.evaluate(() => (window as unknown as AW).__pzView.handles());
}

async function project(p: V3): Promise<{ x: number; y: number }> {
  const q = await page.evaluate((w) => (window as unknown as AW).__pzView.projectPage(w), p);
  if (!q) throw new Error(`${p.join(",")} is behind the camera`);
  return q;
}

/** Two animation frames: the renderer has drawn the current camera and bodies (picking reads that frame). */
async function frames(): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** Click a world point with real mouse events, once the viewport pre-highlights what is under it. */
async function clickWorld(p: V3, expectKey?: string): Promise<void> {
  await frames();
  const q = await project(p);
  await page.mouse.move(q.x - 3, q.y - 3);
  await page.mouse.move(q.x, q.y);
  if (expectKey) {
    await expect
      .poll(async () => {
        await page.mouse.move(q.x + 1, q.y);
        await page.mouse.move(q.x, q.y);
        return (await page.evaluate(() => (window as unknown as { __pzView: { selection(): { hover: { key?: string } | null } } }).__pzView.selection().hover))?.key;
      })
      .toBe(expectKey);
  }
  await page.mouse.click(q.x, q.y);
}

const row = (name: string) => page.locator(`[data-testid="timeline-feature"][data-feature="${name}"]`);

async function idle(): Promise<void> {
  await page.evaluate(() => (window as unknown as AW).__aicad.idle());
}

async function setSelection(items: unknown[]): Promise<void> {
  const r = await view("selection.set", { items });
  expect(r.ok, r.error?.message).toBe(true);
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "aicad-create-e2e-"));
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
  await page.waitForFunction(() => !!(window as unknown as Partial<AW>).__aicad && !!(window as unknown as Partial<AW>).__pzView && !!(window as unknown as Partial<AW>).__partzero, undefined, { timeout: 60_000 });
  await page.waitForFunction(
    () => (window as unknown as { __aicad: { describe(): Array<{ id: string }> } }).__aicad.describe().some((c) => c.id === "model.extrude"),
    undefined,
    { timeout: 60_000 },
  );
  await page.evaluate(() => (window as unknown as AW).__pzView.setAnimationMs(0));
  await idle();
  // A 60 × 40 outline on XY, drawn by command (the sketcher has its own suite).
  const r = await exec("ir.addFeature", { feature: { type: "sketch", name: "outline", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: 60, h: 40 }] } });
  expect(r.ok, r.error?.message).toBe(true);
  await expect(row("outline")).toHaveAttribute("data-status", "ok");
});

test.afterAll(async () => {
  await app?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

test("Extrude (E): prefilled from the selected sketch; a typed value and a drag of its arrow preview; OK is one undo step", async () => {
  await row("outline").click();
  await page.keyboard.press("e");
  await expect(page.getByTestId("property-panel")).toBeVisible();
  let p = await ready();
  expect(p).toMatchObject({ toolId: "feature.extrude", title: "Extrude" });
  expect(p.values["sketch"]).toBe("sketch1");
  await page.getByTestId("input-distance").fill("8");
  p = await ready();
  expect(p.summary[0]?.label).toBe("1 new body");
  await expect.poll(async () => (await handles()).map((h) => [h.id, h.value])).toEqual([["distance", 8]]);
  await view("view.setView", { view: "iso" });
  await view("view.fit");
  await page.screenshot({ path: screenshotPath("create-extrude-panel.png", "AICAD_E2E_CREATE_SCREENSHOT") });
  // Drag the arrow's grip up with real mouse events: the distance follows the pointer.
  const h = (await handles())[0]!;
  const tip = h.origin.map((x, i) => x + h.axis[i]! * h.value) as V3;
  const from = await project(tip);
  const to = await project(tip.map((x, i) => x + h.axis[i]! * 6) as V3);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
  await page.mouse.up();
  await expect.poll(async () => Number(((await panel())!.values["distance"] as { text: string }).text)).toBeGreaterThan(11);
  // Then an exact typed value (the determinism rule), and Enter = OK.
  await page.getByTestId("input-distance").fill("10");
  await ready();
  const before = await text();
  await page.getByTestId("input-distance").press("Enter");
  await expect(page.getByTestId("property-panel")).toBeHidden();
  await expect(row("extrude1")).toHaveAttribute("data-status", "ok");
  expect(await feature("extrude1")).toMatchObject({ type: "extrude", sketch: "sketch1", distance: 10 });
  await expect.poll(async () => (await handles()).length).toBe(0);
  const after = await text();
  expect((await exec("edit.undo")).ok).toBe(true);
  expect(await text()).toBe(before);
  expect((await exec("edit.redo")).ok).toBe(true);
  expect(await text()).toBe(after);
});

/** Look at the whole model from the iso corner, fitted (so projected picks land on the faces). */
async function isoFit(): Promise<void> {
  await view("view.setView", { view: "iso" });
  await view("view.fit");
}

test("Hole (H): a click on the top face places it there; typed (u, v), size and counterbore; an off-face position errors on its field", async () => {
  await isoFit();
  await clickWorld([-15, 10, 10], "extrude1/cap:end");
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as AW).__pzView.selection())).items.map((i) => [i.kind, i.key])).toEqual([["face", "extrude1/cap:end"]]);
  await page.keyboard.press("h");
  let p = await ready();
  expect(p).toMatchObject({ toolId: "feature.hole", values: { placement: "click", size: "M3", kind: "simple" } });
  expect(p.summary).toEqual(expect.arrayContaining([{ label: "Holes", value: "1" }]));
  // Exact position: typed in the face's plane (u, v), then an ISO M4 counterbore.
  await page.getByTestId("input-placement").selectOption("uv");
  await page.getByTestId("input-u").fill("500");
  await page.getByTestId("input-v").fill("10");
  await expect(page.getByTestId("field-error-placement")).toContainText("off the placement face");
  expect((await panel())!.state).toBe("invalid");
  await page.getByTestId("input-u").fill("-15");
  await page.getByTestId("input-size").selectOption("M4");
  await page.getByTestId("input-kind").selectOption("counterbore");
  p = await ready();
  expect(p.summary).toEqual(expect.arrayContaining([{ label: "Diameter", value: "4.50 mm (M4)" }]));
  await page.screenshot({ path: screenshotPath("create-hole-panel.png", "AICAD_E2E_CREATE_SCREENSHOT") });
  const before = await text();
  await page.getByTestId("panel-ok").click();
  await expect(page.getByTestId("property-panel")).toBeHidden();
  await expect(row("hole1")).toHaveAttribute("data-status", "ok");
  expect(await feature("hole1")).toMatchObject({
    on: { face: { kind: "face", q: { op: "cap", feature: "extrude1", end: "end" } } },
    at: { list: [{ id: "p1", at: [-15, 10] }] },
    size: "M4",
    cbore: "iso4762",
    depth: "through",
  });
  expect((await exec("edit.undo")).ok).toBe(true);
  expect(await text()).toBe(before);
  expect((await exec("edit.redo")).ok).toBe(true);
});

test("Hole: re-edited from the timeline (double-click) in the same panel; OK changes it in place", async () => {
  await row("hole1").dblclick();
  const p = await ready();
  expect(p).toMatchObject({ toolId: "feature.hole", title: "Edit hole1", values: { placement: "uv", size: "M4", kind: "counterbore" } });
  await page.getByTestId("input-size").selectOption("M5");
  await page.getByTestId("input-kind").selectOption("countersink");
  await expect(page.getByTestId("selection-face")).toContainText("End cap of extrude1");
  await ready();
  await page.getByTestId("panel-ok").click();
  await expect(page.getByTestId("property-panel")).toBeHidden();
  const f = await feature("hole1");
  expect(f).toMatchObject({ size: "M5", csink: "iso10642", at: { list: [{ id: "p1", at: [-15, 10] }] } });
  expect(f?.["cbore"]).toBeUndefined();
  const state = (await exec("ir.state")).value as { history: { undoLabel: string } };
  expect(state.history.undoLabel).toBe("Edit hole1");
});

test("Push/Pull (Q): the top face's arrow is dragged, then a typed offset; the extrude's distance follows", async () => {
  await isoFit();
  await clickWorld([10, -10, 10], "extrude1/cap:end");
  await page.keyboard.press("q");
  let p = await ready();
  expect(p.toolId).toBe("feature.pushPull");
  expect(p.summary[0]).toEqual({ label: "Drives", value: "extrude1 · distance" });
  const h = (await handles())[0]!;
  expect(h.kind).toBe("pushPull");
  expect(h.axis[2]).toBeCloseTo(1, 6);
  const from = await project(h.origin);
  const to = await project([h.origin[0], h.origin[1], h.origin[2] + 4]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
  await page.mouse.up();
  await expect.poll(async () => Number(((await panel())!.values["offset"] as { text: string }).text)).toBeGreaterThan(1);
  await page.getByTestId("input-offset").fill("2");
  p = await ready();
  expect(p.summary).toEqual(expect.arrayContaining([{ label: "Value", value: "10 → 12 mm" }]));
  await page.getByTestId("panel-ok").click();
  await expect(page.getByTestId("property-panel")).toBeHidden();
  expect((await feature("extrude1"))?.["distance"]).toBe(12);
});

test("Revolve: the profile's construction line is the axis; an angle ring previews; OK makes the ring body", async () => {
  const r = await exec("ir.addFeature", {
    feature: {
      type: "sketch",
      name: "ringProfile",
      plane: "XZ",
      curves: [
        { kind: "rect", id: "p", corner: [45, 0], w: 5, h: 8 },
        { kind: "line", id: "ax", start: [0, 0], end: [0, 10], construction: true },
      ],
    },
  });
  expect(r.ok, r.error?.message).toBe(true);
  await row("ringProfile").click();
  await page.getByTestId("tool-feature.revolve").click();
  await ready();
  expect((await panel())!.values).toMatchObject({ sketch: "sketch2", axis: "sketch2:ax" });
  await expect.poll(async () => (await handles()).map((h) => [h.id, h.kind, h.value])).toEqual([["angle", "rotate", 360]]);
  await page.getByTestId("input-angle").fill("270");
  await ready();
  await page.getByTestId("panel-ok").click();
  await expect(page.getByTestId("property-panel")).toBeHidden();
  await expect(row("revolve1")).toHaveAttribute("data-status", "ok");
  expect(await feature("revolve1")).toMatchObject({ sketch: "sketch2", axis: { origin: [0, 0], direction: [0, 1] }, angle: 270 });
});

test("Plane and Axis (Construct): an offset plane from the picked face; an axis along a picked edge", async () => {
  await isoFit();
  await clickWorld([15, 12, 12], "extrude1/cap:end");
  await page.getByTestId("tool-construct.plane").click();
  let p = await ready();
  expect(p.values["mode"]).toBe("offset");
  await page.getByTestId("input-distance").fill("5");
  p = await ready();
  expect(p.summary).toEqual(expect.arrayContaining([{ label: "Origin", value: "(0.00, 0.00, 17.00)" }]));
  await expect.poll(async () => (await handles()).map((h) => [h.id, h.value])).toEqual([["distance", 5]]);
  await page.getByTestId("panel-ok").click();
  await expect(row("datum_plane1")).toHaveAttribute("data-status", "ok");
  expect(await feature("datum_plane1")).toMatchObject({ mode: "offset", from: { face: { q: { op: "cap", feature: "extrude1", end: "end" } } }, distance: 5 });

  await setSelection([{ kind: "edge", body: "part/extrude1", key: "extrude1/edge:{extrude1/cap:end|extrude1/side:r.top}" }]);
  await page.getByTestId("tool-construct.axis").click();
  p = await ready();
  expect(p.values["mode"]).toBe("edge");
  expect(p.summary).toEqual(expect.arrayContaining([{ label: "Direction", value: "(1.00, 0.00, 0.00)" }]));
  await page.getByTestId("panel-ok").click();
  await expect(row("datum_axis1")).toHaveAttribute("data-status", "ok");
  expect(await feature("datum_axis1")).toMatchObject({ mode: "edge", edge: { q: { op: "between" } } });
});

test("Combine: the plate picked by a face, then the tool body; a cut through both", async () => {
  // A peg as a new body, by the Extrude tool's own command (what the agent calls too).
  expect((await exec("ir.addFeature", { feature: { type: "sketch", name: "pegSk", plane: "XY", curves: [{ kind: "circle", id: "c", center: [20, 0], radius: 4 }] } })).ok).toBe(true);
  const made = await exec("model.extrude", { sketch: "pegSk", distance: 30 });
  expect(made.ok, made.error?.message).toBe(true);
  expect(made.value).toMatchObject({ feature: "extrude2" });
  await idle();
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __pzView: { topology(): Array<{ body: string }> } }).__pzView.topology())).map((b) => b.body).sort()).toEqual(["part/extrude1", "part/extrude2", "part/revolve1"]);
  await isoFit();
  await clickWorld([-20, -15, 12], "extrude1/cap:end");
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as AW).__pzView.selection())).items.map((i) => [i.kind, i.key])).toEqual([["face", "extrude1/cap:end"]]);
  await page.getByTestId("tool-feature.combine").click();
  await expect.poll(async () => ((await panel())?.values["targets"] as unknown[] | undefined)?.length).toBe(1);
  await page.getByTestId("choice-operation-cut").click();
  // The tools input picks next: click it, then the peg's top.
  await page.getByTestId("selection-tools").click();
  await clickWorld([20, 0, 30], "extrude2/cap:end");
  await expect.poll(async () => ((await panel())?.values["tools"] as Array<{ key: string }> | undefined)?.map((i) => i.key)).toEqual(["extrude2/cap:end"]);
  const p = await ready();
  await page.screenshot({ path: screenshotPath("create-combine-panel.png", "AICAD_E2E_CREATE_SCREENSHOT") });
  expect(p.summary[0]).toEqual({ label: "Result", value: "1 body" });
  await page.getByTestId("panel-ok").click();
  await expect(row("boolean1")).toHaveAttribute("data-status", "ok");
  expect(await feature("boolean1")).toMatchObject({ op: "cut", targets: { q: { op: "body", feature: "extrude1" } }, tools: { q: { op: "body", feature: "extrude2" } } });
  expect(pageErrors).toEqual([]);
});
