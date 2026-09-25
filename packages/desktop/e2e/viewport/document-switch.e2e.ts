/**
 * Opening another document starts from a clean view: the previous model's hidden bodies, body
 * colours, section plane, selection and Measure panel do not carry over (they are keyed by body
 * name, and the section offset was computed from the old model's centre). Display preferences
 * (mode, grid, projection) are the user's and stay.
 */
import { expect, test } from "@playwright/test";
import { at, clickWorld, launch, openPlate, PLATE, pixels, selection, view, type Launched } from "./harness.js";

let L: Launched;

test.beforeAll(async () => {
  L = await launch();
  await openPlate(L.page);
});

test.afterAll(async () => {
  await L?.close();
});

const diff = (a: [number, number, number], b: [number, number, number]): number => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

test("another document opens with every body visible, no section, no selection, Measure closed", async () => {
  const { page } = L;
  await view(page, { id: "view.setToggle", args: { toggle: "grid", on: false } });
  const top = await at(page, [0, 18, 5]);
  const shown = await pixels(page);

  // Dirty every piece of per-document view state.
  await clickWorld(page, [0, 18, 5]);
  await expect.poll(async () => (await selection(page)).items[0]?.key).toBe("plate/cap:end");
  expect((await view(page, { id: "measure.toggle" })).ok).toBe(true);
  await expect(page.getByTestId("measure-panel")).toBeVisible();
  expect((await view(page, { id: "view.setBodyColor", args: { body: PLATE, color: "#d4524a" } })).ok).toBe(true);
  expect((await view(page, { id: "view.section", args: { base: "XZ" } })).ok).toBe(true);
  await expect(page.getByTestId("section-panel")).toBeVisible();
  expect((await view(page, { id: "view.setBodyVisible", args: { body: PLATE, visible: false } })).ok).toBe(true);
  // The plate is gone from the canvas: keep that frame (background only) to compare against.
  let hidden = await pixels(page);
  await expect.poll(async () => {
    hidden = await pixels(page);
    return diff(hidden.at(top.x, top.y), shown.at(top.x, top.y));
  }).toBeGreaterThan(20);
  expect((await view(page, { id: "view.setDisplayMode", args: { mode: "shaded" } })).ok).toBe(true);

  // The same template again: same body names, so anything keyed by name would carry over.
  await openPlate(page);
  const v = await page.evaluate(() => window.__pzView!.view());
  expect(v.bodies[PLATE]?.visible ?? true).toBe(true);
  expect(v.bodies[PLATE]?.color ?? null).toBeNull();
  expect(v.section).toBeNull();
  expect(v.display).toBe("shaded");
  expect(v.grid).toBe(false);
  await expect(page.getByTestId("section-panel")).toHaveCount(0);
  await expect(page.getByTestId("handle-section")).toHaveCount(0);
  await expect(page.getByTestId("measure-panel")).toHaveCount(0);
  expect((await selection(page)).items).toEqual([]);
  // The plate is drawn again: its top face is no longer the empty background.
  const top2 = await at(page, [0, 18, 5]);
  await expect.poll(async () => diff((await pixels(page)).at(top2.x, top2.y), hidden.at(top2.x, top2.y))).toBeGreaterThan(20);

  // An unrelated part: a section set on the plate does not follow it either.
  expect((await view(page, { id: "view.section", args: { base: "XZ" } })).ok).toBe(true);
  const r = await page.evaluate(() => window.__aicad!.execute({ id: "file.newFromTemplate", args: { templateId: "t1-cable-clip" } }));
  expect(r.ok).toBe(true);
  await page.waitForFunction(() => window.__pzView!.topology().length > 0 && !window.__pzView!.topology().some((t) => t.body === "plate/plate"));
  expect(await page.evaluate(() => window.__pzView!.view().section)).toBeNull();
  await expect(page.getByTestId("section-panel")).toHaveCount(0);
  expect(L.pageErrors).toEqual([]);
});
