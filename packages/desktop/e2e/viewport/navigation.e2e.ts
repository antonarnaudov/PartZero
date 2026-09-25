/**
 * Navigation: the view cube (faces, edges/corners, Home), Shift+1…7 standard views, zoom to fit
 * and to selection, look-at (N), projection, and orbit/pan/zoom with a mouse **and** a trackpad at
 * the same time (FD3).
 */
import { expect, test } from "@playwright/test";
import { at, camera, canvasBox, clickWorld, drag, launch, openPlate, selection, view, wheel, type Launched } from "./harness.js";

let L: Launched;

test.beforeAll(async () => {
  L = await launch();
  await openPlate(L.page);
});

test.afterAll(async () => {
  await L?.close();
});

const near = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) <= tol;

test("the view cube turns to faces, corners and Home", async () => {
  const { page } = L;
  const cube = page.getByTestId("view-cube");
  await expect(cube).toBeVisible();
  // Iso shows the top, front and right faces.
  await expect(cube.locator("[data-face]")).toHaveCount(3);
  await cube.locator('[data-cube="front"]').click();
  await expect.poll(async () => (await page.evaluate(() => window.__pzView!.view().view))).toBe("front");
  let c = await camera(page);
  expect(near(c.yaw, 0) && near(c.pitch, 0)).toBe(true);
  // From the front, the cube shows only its front face; click its top-right corner cell.
  await expect(cube.locator("[data-face]")).toHaveCount(1);
  await cube.locator('[data-dir="1,-1,1"]').first().click();
  c = await camera(page);
  expect(c.yaw).toBeCloseTo(Math.PI / 4, 6);
  expect(c.pitch).toBeCloseTo(Math.atan(1 / Math.SQRT2), 6);
  await cube.locator('[data-cube="top"]').click();
  await expect.poll(async () => (await camera(page)).pitch).toBeCloseTo(Math.PI / 2, 6);
  await page.getByTestId("view-cube-home").click();
  await expect.poll(async () => page.evaluate(() => window.__pzView!.view().view)).toBe("iso");
});

test("Shift+1…7 give the seven standard views, and the toolbar marks them", async () => {
  const { page } = L;
  await page.locator(".viewport-canvas").click({ position: { x: 5, y: 5 } });
  const expected: Array<[string, string]> = [
    ["Shift+1", "front"],
    ["Shift+2", "back"],
    ["Shift+3", "left"],
    ["Shift+4", "right"],
    ["Shift+5", "top"],
    ["Shift+6", "bottom"],
    ["Shift+7", "iso"],
  ];
  for (const [key, v] of expected) {
    await page.keyboard.press(key);
    await expect.poll(async () => page.evaluate(() => window.__pzView!.view().view)).toBe(v);
  }
  await expect(page.locator('.vp-btn[data-view="iso"]')).toHaveClass(/active/);
});

test("mouse: right-drag orbits, middle-drag pans, wheel zooms towards the cursor", async () => {
  const { page } = L;
  const b = await canvasBox(page);
  const mid = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const c0 = await camera(page);
  await drag(page, mid, { x: mid.x + 120, y: mid.y + 30 }, "right");
  const c1 = await camera(page);
  expect(Math.abs(c1.yaw - c0.yaw)).toBeGreaterThan(0.5);
  expect(c1.pitch).not.toBeCloseTo(c0.pitch, 3);
  // Orbiting leaves the standard view.
  expect(await page.evaluate(() => window.__pzView!.view().view)).toBeNull();
  await drag(page, mid, { x: mid.x + 80, y: mid.y - 40 }, "middle");
  const c2 = await camera(page);
  expect(Math.hypot(c2.target[0] - c1.target[0], c2.target[1] - c1.target[1], c2.target[2] - c1.target[2])).toBeGreaterThan(1);
  expect(c2.yaw).toBeCloseTo(c1.yaw, 9);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await camera(page)).distance).toBeLessThan(c2.distance * 0.9);
  // Shift+right-drag pans too.
  const c3 = await camera(page);
  await page.keyboard.down("Shift");
  await drag(page, mid, { x: mid.x - 60, y: mid.y }, "right");
  await page.keyboard.up("Shift");
  const c4 = await camera(page);
  expect(c4.yaw).toBeCloseTo(c3.yaw, 9);
  expect(Math.hypot(c4.target[0] - c3.target[0], c4.target[1] - c3.target[1])).toBeGreaterThan(1);
});

test("trackpad: two-finger scroll orbits, Shift+scroll pans, pinch zooms", async () => {
  const { page } = L;
  await view(page, { id: "view.home" });
  const c0 = await camera(page);
  // Pixel-mode wheel events with a horizontal component and fractional deltas (a Mac trackpad).
  for (let i = 0; i < 10; i++) await wheel(page, { deltaX: 6.5, deltaY: 1.25 });
  const c1 = await camera(page);
  expect(Math.abs(c1.yaw - c0.yaw)).toBeGreaterThan(0.3);
  expect(c1.distance).toBeCloseTo(c0.distance, 6);
  await page.waitForTimeout(250);
  for (let i = 0; i < 10; i++) await wheel(page, { deltaX: 4.5, deltaY: -3.5, shiftKey: true });
  const c2 = await camera(page);
  expect(c2.yaw).toBeCloseTo(c1.yaw, 9);
  expect(Math.hypot(c2.target[0] - c1.target[0], c2.target[1] - c1.target[1], c2.target[2] - c1.target[2])).toBeGreaterThan(1);
  await page.waitForTimeout(250);
  for (let i = 0; i < 10; i++) await wheel(page, { deltaY: -4, ctrlKey: true });
  const c3 = await camera(page);
  expect(c3.distance).toBeLessThan(c2.distance * 0.8);
  expect(c3.yaw).toBeCloseTo(c2.yaw, 9);
  // A notched mouse wheel (line mode) zooms, it does not orbit.
  await page.waitForTimeout(250);
  await wheel(page, { deltaY: 3, deltaMode: 1 });
  const c4 = await camera(page);
  expect(c4.distance).toBeGreaterThan(c3.distance);
  expect(c4.yaw).toBeCloseTo(c3.yaw, 9);
});

test("zoom to fit, zoom to selection, and look at a face", async () => {
  const { page } = L;
  await view(page, { id: "view.home" });
  const fitted = await camera(page);
  // The far side of the M3 hole wall (its inner normal faces the iso eye), 1 mm below the top.
  const a = Math.PI * 0.75;
  await clickWorld(page, [15.5 + 1.7 * Math.cos(a), 15.5 + 1.7 * Math.sin(a), 4]);
  await expect.poll(async () => (await selection(page)).items[0]?.key).toBe("plate/side:m3_a");
  await page.keyboard.press("Shift+Z");
  await expect.poll(async () => (await camera(page)).distance).toBeLessThan(fitted.distance / 4);
  await page.keyboard.press("f");
  await expect.poll(async () => (await camera(page)).distance).toBeCloseTo(fitted.distance, 3);
  // Look at the right side face (+X): the camera looks along −X.
  await clickWorld(page, [25, 0, 2.5]);
  await expect.poll(async () => (await selection(page)).items[0]?.key).toBe("plate/side:right");
  await page.keyboard.press("n");
  await expect.poll(async () => page.evaluate(() => window.__pzView!.view().view)).toBe("right");
  const c = await camera(page);
  expect(c.yaw).toBeCloseTo(Math.PI / 2, 6);
  expect(c.pitch).toBeCloseTo(0, 6);
});

test("projection toggles between perspective and orthographic", async () => {
  const { page } = L;
  const btn = page.getByTestId("vp-projection");
  const before = (await camera(page)).projection;
  await btn.click();
  await expect.poll(async () => (await camera(page)).projection).not.toBe(before);
  await expect(btn).toHaveText(before === "perspective" ? "Ortho" : "Persp");
  await page.keyboard.press("p");
  await expect.poll(async () => (await camera(page)).projection).toBe(before);
  expect(L.pageErrors).toEqual([]);
  void at;
});
