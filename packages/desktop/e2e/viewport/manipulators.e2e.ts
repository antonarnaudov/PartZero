/**
 * Manipulator gizmo core, driven through the API tools use (`ManipulatorHost.show`, here via
 * the test hook): translate arrow, push/pull arrow, rotate ring and radius knob, dragged with real
 * pointer events. Values snap (1 mm / 15°, Shift finer), clamp to the feasible range with the
 * reason shown, Esc snaps back, Tab types a value.
 */
import { expect, test } from "@playwright/test";
import { at, launch, openPlate, view, type Launched, type Vec3 } from "./harness.js";

let L: Launched;

test.beforeAll(async () => {
  L = await launch();
  await openPlate(L.page);
  await view(L.page, { id: "view.setView", args: { view: "front" } });
  await view(L.page, { id: "view.setProjection", args: { projection: "orthographic" } });
});

test.afterAll(async () => {
  await L?.close();
});

const log = async () => L.page.evaluate(() => window.__pzView!.handleLog());
const value = async (id: string): Promise<number | undefined> => (await L.page.evaluate(() => window.__pzView!.handles())).find((h) => h.id === id)?.value;

async function show(handles: unknown[]): Promise<void> {
  await L.page.evaluate((h) => window.__pzView!.showHandles(h), handles);
}

async function dragGrip(id: string, to: Vec3, opts: { shift?: boolean; steps?: number } = {}): Promise<void> {
  const { page } = L;
  const g = (await page.getByTestId(`handle-${id}`).boundingBox())!;
  const from = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
  const dest = await at(page, to);
  if (opts.shift) await page.keyboard.down("Shift");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = opts.steps ?? 10;
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((dest.x - from.x) * i) / steps, from.y + ((dest.y - from.y) * i) / steps);
  await page.mouse.up();
  if (opts.shift) await page.keyboard.up("Shift");
}

test("translate and push/pull arrows follow the pointer along their axis, snapped and clamped", async () => {
  await show([
    { id: "move", kind: "linear", origin: [-20, 0, 2.5], axis: [1, 0, 0], value: 0, label: "X" },
    { id: "depth", kind: "pushPull", origin: [10, 0, 5], axis: [0, 0, 1], value: 5, min: 0.5, max: 12, limitReason: "the wall would vanish" },
  ]);
  await expect(L.page.getByTestId("manipulators")).toBeVisible();
  // Drag the translate arrow's grip to x ≈ −12.3: 1 mm snapping gives 8 (from −20).
  await dragGrip("move", [-12.3, 0, 2.5]);
  expect(await value("move")).toBe(8);
  // Shift: 0.5 mm steps.
  await dragGrip("move", [-9.7, 0, 2.5], { shift: true });
  expect(await value("move")).toBe(10.5);
  // Push/pull up past the maximum: clamped at 12 with the reason.
  const g = (await L.page.getByTestId("handle-depth").boundingBox())!;
  const top = await at(L.page, [10, 0, 40]);
  await L.page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await L.page.mouse.down();
  await L.page.mouse.move(top.x, top.y, { steps: 8 });
  await expect(L.page.getByTestId("handle-value")).toContainText("max: the wall would vanish");
  await L.page.mouse.up();
  expect(await value("depth")).toBe(12);
  const changes = await log();
  expect(changes.filter((c) => c.id === "depth").map((c) => c.phase)).toEqual(expect.arrayContaining(["start", "drag", "end"]));
  expect(changes.some((c) => c.id === "depth" && c.clamped === "max")).toBe(true);
});

test("Esc during a drag snaps the handle back; Tab types an exact value", async () => {
  const { page } = L;
  await show([{ id: "d", kind: "linear", origin: [0, 0, 2.5], axis: [1, 0, 0], value: 5 }]);
  const g = (await page.getByTestId("handle-d").boundingBox())!;
  const far = await at(page, [18, 0, 2.5]);
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(far.x, far.y, { steps: 6 });
  expect(await value("d")).toBe(18);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await value("d")).toBe(5);
  expect((await log()).at(-1)).toMatchObject({ id: "d", phase: "cancel", value: 5 });
  // Tab during a drag opens a field; Enter commits the typed value.
  const g2 = (await page.getByTestId("handle-d").boundingBox())!;
  await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2);
  await page.mouse.down();
  await page.mouse.move(g2.x + g2.width / 2 + 30, g2.y + g2.height / 2, { steps: 3 });
  await page.keyboard.press("Tab");
  const input = page.getByTestId("handle-input");
  await expect(input).toBeVisible();
  await input.fill("7.25");
  await input.press("Enter");
  await page.mouse.up();
  expect(await value("d")).toBe(7.25);
  expect((await log()).at(-1)).toMatchObject({ id: "d", phase: "end", value: 7.25 });
});

test("rotate ring measures the angle around its axis; the radius knob pulls a radius", async () => {
  const { page } = L;
  // A ring about +Y (the view direction from the front is +Y): its plane faces the camera.
  await show([
    { id: "angle", kind: "rotate", origin: [0, 0, 2.5], axis: [0, -1, 0], ref: [1, 0, 0], value: 0, size: 15 },
    { id: "r", kind: "radius", origin: [15.5, 0, 15], axis: [1, 0, 0], value: 1.7, min: 0.2, max: 6 },
  ]);
  // Drag the ring's grip (at angle 0: +X) a quarter turn to +Z: 90° (15° snapping).
  await dragGrip("angle", [0.5, 0, 2.5 + 15], { steps: 16 });
  expect(await value("angle")).toBe(90);
  // Past the ±180° seam the angle keeps accumulating.
  await dragGrip("angle", [-15, 0, 2.5 - 1], { steps: 16 });
  const a = (await value("angle"))!;
  expect(a).toBeGreaterThanOrEqual(180);
  expect(a % 15).toBe(0);
  await dragGrip("r", [15.5 + 4.2, 0, 15]);
  expect(await value("r")).toBe(4);
  await dragGrip("r", [15.5 + 30, 0, 15]);
  expect(await value("r")).toBe(6);
  await page.evaluate(() => window.__pzView!.hideHandles());
  await expect(page.getByTestId("manipulators")).toHaveCount(0);
  expect(L.pageErrors).toEqual([]);
});
