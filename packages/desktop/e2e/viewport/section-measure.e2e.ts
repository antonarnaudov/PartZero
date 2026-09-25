/**
 * Section view (menu, panel, slider, typed offset, drag handle, flip, from a face, remove; the
 * cap is drawn and picked) and the Measure panel (exact values from the B-rep: distance between
 * parallel faces, hole diameter, face area with the holes subtracted, vertex distances, angles).
 */
import { expect, test } from "@playwright/test";
import { at, clickWorld, drag, launch, openPlate, pixels, selection, view, type Launched } from "./harness.js";

let L: Launched;

test.beforeAll(async () => {
  L = await launch();
  await openPlate(L.page);
});

test.afterAll(async () => {
  await L?.close();
});

interface Section {
  base: string;
  origin: [number, number, number];
  normal: [number, number, number];
  offset: number;
  flipped: boolean;
}

const section = async (): Promise<Section | null> => (await L.page.evaluate(() => window.__pzView!.view().section)) as Section | null;

test("section: from the menu, move it with the slider, the field and the handle, flip, remove", async () => {
  const { page } = L;
  // forge-render draws hatched caps; the placeholder shows the inside through the cut.
  const caps = (await page.getByTestId("viewport").getAttribute("data-renderer")) === "forge-web";
  const mid = await at(page, [8, -12, 2.5]);
  const midInside = await at(page, [12.5, -10, 2.5]);
  const before = await pixels(page);
  await page.getByTestId("section-menu").click();
  await page.locator('[data-section="XY"]').click();
  await expect(page.getByTestId("section-panel")).toBeVisible();
  let s = (await section())!;
  expect(s.base).toBe("XY");
  // Through the model's centre (z = 2.5), removing the half towards the camera (+Z from iso).
  expect(s.offset).toBeCloseTo(2.5, 6);
  expect(s.normal).toEqual([0, 0, 1]);
  // The top half is removed: the cut shows the (reddish) section cap at mid-height.
  const cap = (await pixels(page)).at(mid.x, mid.y);
  if (caps) expect(cap[0]).toBeGreaterThan(cap[2] + 20);
  else expect(Math.max(...cap.map((v, i) => Math.abs(v - before.at(mid.x, mid.y)[i]!)))).toBeGreaterThan(8);
  // Typed offset.
  await page.getByTestId("section-offset").fill("1");
  await expect.poll(async () => (await section())!.offset).toBe(1);
  // Drag the plane's handle up by ~2 mm (real pointer events on its grip).
  const grip = page.getByTestId("handle-section");
  await expect(grip).toBeVisible();
  const g = (await grip.boundingBox())!;
  const from = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
  const up = await at(page, [0, 0, 3]);
  const base = await at(page, [0, 0, 1]);
  await drag(page, from, { x: from.x + (up.x - base.x), y: from.y + (up.y - base.y) });
  await expect.poll(async () => (await section())!.offset).toBeCloseTo(3, 6);
  await expect(page.getByTestId("section-offset")).toHaveValue("3");
  // Flip keeps the other half.
  await page.getByTestId("section-flip").click();
  expect((await section())!.flipped).toBe(true);
  // From a selected planar face.
  await page.getByTestId("section-close").click();
  expect(await section()).toBeNull();
  await clickWorld(page, [25, 0, 2.5]);
  await expect.poll(async () => (await selection(page)).items[0]?.key).toBe("plate/side:right");
  await view(page, { id: "view.section", args: { base: "face", offset: -12.5 } });
  s = (await section())!;
  expect(s.base).toBe("face");
  expect(s.normal[0]).toBeCloseTo(1, 6);
  // The cut at x = 12.5 shows a cap: the pixel just behind the old right face changes colour.
  const img = await pixels(page);
  const c = img.at(midInside.x, midInside.y);
  if (caps) expect(c[0]).toBeGreaterThan(c[2] + 20);
  else expect(Math.max(...c.map((v, i) => Math.abs(v - before.at(midInside.x, midInside.y)[i]!)))).toBeGreaterThan(8);
  await page.keyboard.press("Escape");
  await view(page, { id: "view.clearSection" });
  await expect(page.getByTestId("section-panel")).toHaveCount(0);
  await expect(page.getByTestId("handle-section")).toHaveCount(0);
});

test("measure: exact distance, diameter, area, vertex deltas and angle between selections", async () => {
  const { page } = L;
  await view(page, { id: "view.setView", args: { view: "iso" } });
  await page.locator(".viewport-canvas").focus();
  await page.keyboard.press("i");
  const panel = page.getByTestId("measure-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Select a vertex, edge, face or body");
  // forge-web's render mesh (per-face vertices with exact normals) proves planes, cylinders and
  // straight edges; the Forge CLI engine's OBJ (shared vertices, averaged normals) cannot, so the
  // same values are flagged approximate there (the fallback build).
  const proven = (await page.evaluate(() => window.__aicad!.idle())).engine === "forge-web";
  const approx = proven ? "" : "≈ ";
  // The top face: exact area with the five holes subtracted.
  await clickWorld(page, [0, 18, 5]);
  const area = 2500 - Math.PI * 121 - 4 * Math.PI * 1.7 * 1.7;
  const num = async (id: string): Promise<number> => Number.parseFloat(((await page.getByTestId(id).textContent()) ?? "").replace("≈", ""));
  await expect(page.getByTestId("measure-area")).toHaveText(proven ? /^\d+(\.\d+)? mm²$/ : /^≈ \d+(\.\d+)? mm²$/);
  expect(Math.abs((await num("measure-area")) - area)).toBeLessThan(0.01);
  await expect(panel.locator('tr[data-measure="area"]')).toHaveAttribute("data-exact", String(proven));
  // Shift-click the right side face: 90° and a dimension line.
  await clickWorld(page, [25, 0, 2.5], ["Shift"]);
  await expect(page.getByTestId("measure-angle")).toHaveText(`${approx}90°`);
  // The far wall of an M3 hole: exact 3.4 mm diameter.
  const a = Math.PI * 0.75;
  await clickWorld(page, [15.5 + 1.7 * Math.cos(a), 15.5 + 1.7 * Math.sin(a), 4]);
  await expect(page.getByTestId("measure-diameter")).toHaveText(`${approx}3.4 mm`);
  await expect(panel.locator('tr[data-measure="diameter"]')).toHaveAttribute("data-exact", String(proven));
  // Two vertices: distance and deltas.
  await view(page, { id: "selection.filterOnly", args: { kind: "vertex" } });
  const v1 = await at(page, [25, 25, 5]);
  await page.mouse.click(v1.x + 2, v1.y + 2);
  const v2 = await at(page, [-25, -25, 5]);
  await page.keyboard.down("Shift");
  await page.mouse.click(v2.x + 2, v2.y - 2);
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await selection(page)).items.length).toBe(2);
  await expect(page.getByTestId("measure-distance")).toHaveText(`${Number(Math.hypot(50, 50).toFixed(3))} mm`);
  await expect(page.getByTestId("measure-dx")).toHaveText("50 mm");
  await expect(page.getByTestId("measure-dimension")).toHaveCount(1);
  // The agent reads the same numbers through the command.
  const r = await view(page, { id: "measure.selection" });
  expect(r).toMatchObject({ ok: true, value: { result: { title: "Vertex ↔ Vertex" } } });
  await view(page, { id: "selection.filterAll" });
  // Parallel faces: top and bottom are 5 mm apart (the bottom face picked from below).
  await view(page, { id: "selection.set", args: { items: [{ kind: "face", body: "plate/plate", key: "plate/cap:end" }, { kind: "face", body: "plate/plate", key: "plate/cap:start" }] } });
  await expect(page.getByTestId("measure-distance")).toHaveText(`${approx}5 mm`);
  await page.keyboard.press("i");
  await expect(panel).toHaveCount(0);
  expect(L.pageErrors).toEqual([]);
});
