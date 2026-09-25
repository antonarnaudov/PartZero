/**
 * Selection: hover pre-highlight, click / Shift-click, vertex picking, the kind filter (keys 1–5
 * and the selection bar), window and crossing box select with occlusion, Escape, and the primary
 * item mirrored into the document selection (timeline, code, chat chips).
 */
import { expect, test } from "@playwright/test";
import { at, clickWorld, drag, launch, openPlate, PLATE, selection, view, type Launched } from "./harness.js";

let L: Launched;

test.beforeAll(async () => {
  L = await launch();
  await openPlate(L.page);
});

test.afterAll(async () => {
  await L?.close();
});

const keys = async (): Promise<string[]> => (await selection(L.page)).items.map((i) => i.key ?? i.body ?? i.id ?? "");

test.beforeEach(async () => {
  await view(L.page, { id: "selection.filterAll" });
  await view(L.page, { id: "selection.set", args: { items: [] } });
  await view(L.page, { id: "view.setView", args: { view: "iso" } });
});

test("hover pre-highlights with a readable label; click selects, Shift-click adds and removes", async () => {
  const { page } = L;
  const top = await at(page, [0, 18, 5]);
  await page.mouse.move(top.x, top.y);
  await expect(page.getByTestId("viewport-hover")).toHaveText("End cap of plate");
  await expect.poll(async () => (await selection(page)).hover?.key).toBe("plate/cap:end");
  await page.mouse.click(top.x, top.y);
  await expect.poll(keys).toEqual(["plate/cap:end"]);
  await expect(page.getByTestId("selection-count")).toHaveText("1 selected");
  // The primary item reaches the document selection: timeline row and chat chips.
  await expect(page.locator('[data-testid="timeline-feature"][data-feature="plate"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".compose-chips .chip")).toHaveCount(2);
  await clickWorld(page, [25, 0, 2.5], ["Shift"]);
  await expect.poll(keys).toEqual(["plate/cap:end", "plate/side:right"]);
  // Both faces travel to the agent as chips (feature + two faces), with readable labels.
  await expect(page.locator(".compose-chips .chip")).toHaveCount(3);
  await expect(page.locator(".compose-chips")).toContainText("Side right of plate");
  await clickWorld(page, [25, 0, 2.5], ["Shift"]);
  await expect.poll(keys).toEqual(["plate/cap:end"]);
  // Clicking empty space clears; so does Escape.
  const b = (await page.locator(".viewport-canvas").boundingBox())!;
  await page.mouse.click(b.x + 20, b.y + b.height - 80);
  await expect.poll(keys).toEqual([]);
  await clickWorld(page, [0, 18, 5]);
  await expect.poll(keys).toEqual(["plate/cap:end"]);
  await page.keyboard.press("Escape");
  await expect.poll(keys).toEqual([]);
});

test("vertices: hovering near a corner offers the vertex, a click selects it at its exact point", async () => {
  const { page } = L;
  const c = await at(page, [25, 25, 5]);
  await page.mouse.move(c.x + 3, c.y + 2);
  await expect(page.getByTestId("vertex-hover")).toBeVisible();
  await expect(page.getByTestId("viewport-hover")).toHaveText("Vertex of plate (25, 25, 5)");
  await page.mouse.click(c.x + 3, c.y + 2);
  await expect.poll(async () => (await selection(page)).items[0]).toMatchObject({ kind: "vertex", body: PLATE, point: [25, 25, 5] });
  await expect(page.getByTestId("vertex-selected")).toHaveCount(1);
  // The hidden bottom-back corner is never offered.
  const hidden = await at(page, [-25, 25, 0]);
  const it = await page.evaluate(({ x, y }) => {
    const r = document.querySelector(".viewport-canvas")!.getBoundingClientRect();
    return window.__pzView!.pickAt(x - r.left, y - r.top);
  }, hidden);
  expect(it?.kind === "vertex" && it.point?.[2] === 0).toBe(false);
});

test("the kind filter: keys 1–5 solo a kind, the bar toggles kinds", async () => {
  const { page } = L;
  await page.locator(".viewport-canvas").focus();
  await page.keyboard.press("2");
  await expect.poll(async () => (await selection(page)).filter).toMatchObject({ vertex: false, edge: true, face: false, body: false });
  await expect(page.locator('[data-filter="edge"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-filter="face"]')).toHaveAttribute("aria-pressed", "false");
  // A click in the middle of the top face selects nothing with only edges allowed…
  await clickWorld(page, [0, 18, 5]);
  await page.waitForTimeout(150);
  expect(await keys()).toEqual([]);
  // …and the top-right edge when clicked on it.
  await clickWorld(page, [0, 25, 5]);
  await expect.poll(keys).toEqual(["plate/edge:{plate/cap:end|plate/side:top}"]);
  await page.keyboard.press("4");
  await clickWorld(page, [0, 18, 5]);
  await expect.poll(async () => (await selection(page)).items).toEqual([expect.objectContaining({ kind: "body", body: PLATE })]);
  await page.keyboard.press("0");
  await page.locator('[data-filter="vertex"]').click();
  await expect.poll(async () => (await selection(page)).filter.vertex).toBe(false);
  await page.locator('[data-filter="vertex"]').click();
  await expect.poll(async () => (await selection(page)).filter.vertex).toBe(true);
});

test("box select: window (left→right) takes whole visible faces, crossing (right→left) what it touches", async () => {
  const { page } = L;
  const b = (await page.locator(".viewport-canvas").boundingBox())!;
  // A window around the whole model: every face seen from iso, none of the hidden ones.
  // (Below the toolbar and above the selection bar: the box starts on the canvas.)
  await drag(page, { x: b.x + 20, y: b.y + 120 }, { x: b.x + b.width - 20, y: b.y + b.height - 50 });
  await expect.poll(async () => (await keys()).length).toBeGreaterThan(5);
  const k = await keys();
  expect(k).toContain("plate/cap:end");
  expect(k).toContain("plate/side:right");
  expect(k).not.toContain("plate/cap:start");
  expect(k).not.toContain("plate/side:left");
  // Crossing: a small box dragged right→left over the top face only.
  const p = await at(page, [0, 18, 5]);
  await drag(page, { x: p.x + 12, y: p.y - 6 }, { x: p.x - 12, y: p.y + 6 });
  await expect.poll(keys).toEqual(["plate/cap:end"]);
  // Shift adds; the box rectangle is gone after release.
  const q = await at(page, [25, -10, 2.5]);
  await page.keyboard.down("Shift");
  await drag(page, { x: q.x + 6, y: q.y - 4 }, { x: q.x - 6, y: q.y + 4 });
  await page.keyboard.up("Shift");
  await expect.poll(keys).toEqual(["plate/cap:end", "plate/side:right"]);
  await expect(page.getByTestId("box-select")).toHaveCount(0);
  // Edges only: a window around the M3 hole in the top view takes its rim.
  await page.keyboard.press("2");
  await view(page, { id: "view.setView", args: { view: "top" } });
  const c = await at(page, [15.5, 15.5, 5]);
  const r = await at(page, [15.5 + 3, 15.5, 5]);
  const half = r.x - c.x;
  await drag(page, { x: c.x - half, y: c.y - half }, { x: c.x + half, y: c.y + half });
  await expect.poll(keys).toContain("plate/edge:{plate/cap:end|plate/side:m3_a}");
  expect((await keys()).every((e) => e.endsWith("side:m3_a}"))).toBe(true);
});

test("sketches: shown on demand, picked with the sketch filter, selected in the timeline", async () => {
  const { page } = L;
  await expect(page.getByTestId("sketch-display")).toHaveCount(0);
  await page.getByTestId("show-menu").click();
  await page.getByTestId("toggle-sketches").click();
  await expect(page.getByTestId("sketch-display")).toBeVisible();
  // 4 lines + 5 circles of the outline sketch.
  await expect(page.locator(".vp-sketch")).toHaveCount(9);
  // Shown curves do not take clicks meant for the model (they are not depth-tested).
  await clickWorld(page, [0, 18, 5]);
  await expect.poll(keys).toEqual(["plate/cap:end"]);
  await page.getByTestId("show-menu").click();
  await page.getByTestId("toggle-sketches").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sketch-display")).toHaveCount(0);
  // Key 5: only sketches are selectable, so every sketch is shown to pick from.
  await page.locator(".viewport-canvas").focus();
  await page.keyboard.press("5");
  await expect(page.getByTestId("sketch-display")).toBeVisible();
  const p = await at(page, [0, -25, 0]);
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await selection(page)).items).toEqual([{ kind: "sketch", feature: "outline", label: "Sketch outline" }]);
  await expect(page.locator('[data-testid="timeline-feature"][data-feature="outline"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".vp-sketch.selected")).toHaveCount(9);
  // Model entities are not selectable with only the sketch filter on.
  await clickWorld(page, [0, 18, 5]);
  await page.waitForTimeout(150);
  expect((await selection(page)).items.map((i) => i.kind)).toEqual(["sketch"]);
  await page.keyboard.press("0");
});

test("selection.get gives the agent the items with labels; re-evaluation keeps them", async () => {
  const { page } = L;
  await clickWorld(page, [0, 18, 5]);
  await expect.poll(keys).toEqual(["plate/cap:end"]);
  await clickWorld(page, [25, 0, 2.5], ["Shift"]);
  await expect.poll(keys).toEqual(["plate/cap:end", "plate/side:right"]);
  const r = await view(page, { id: "selection.get" });
  expect(r).toMatchObject({ ok: true, value: { items: [{ kind: "face", key: "plate/cap:end", label: "End cap of plate" }, { kind: "face", key: "plate/side:right", label: "Side right of plate" }] } });
  await page.evaluate(() => window.__aicad!.execute({ id: "doc.recompute" }));
  await page.evaluate(() => window.__aicad!.idle());
  expect(await keys()).toEqual(["plate/cap:end", "plate/side:right"]);
  expect(L.pageErrors).toEqual([]);
});
