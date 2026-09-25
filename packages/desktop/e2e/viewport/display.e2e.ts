/**
 * Display: the five display modes (checked on the pixels the renderer draws), per-body colour
 * and visibility through the Bodies menu, the ground grid toggle, and the origin planes, axes
 * and point (drawn and selectable).
 *
 * forge-render draws all five modes once its display-mode bindings are wired into forge-wasm
 * (`forge-wasm/src/web/view_ext.rs`); before that, hidden line and X-ray are offered as
 * unavailable and the command refuses them, which this spec checks instead.
 */
import { expect, test } from "@playwright/test";
import { at, clickWorld, launch, openPlate, PLATE, pixels, selection, view, type Launched } from "./harness.js";

let L: Launched;

test.beforeAll(async () => {
  L = await launch();
  await openPlate(L.page);
  await view(L.page, { id: "view.setToggle", args: { toggle: "grid", on: false } });
});

test.afterAll(async () => {
  await L?.close();
});

const luma = (c: [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const diff = (a: [number, number, number], b: [number, number, number]): number => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

test("display modes change what is drawn", async () => {
  const { page } = L;
  const nativeModes = await page.evaluate(() => window.__pzView!.view().nativeModes);
  const renderer = await page.getByTestId("viewport").getAttribute("data-renderer");
  const top = await at(page, [0, 18, 5]);
  // The front side face (darker than the background when shaded) and a point of the hidden
  // bottom-back edge.
  const side = await at(page, [8, -25, 2.5]);
  const hidden = await at(page, [-10, 25, 0]);
  const b = (await page.locator(".viewport-canvas").boundingBox())!;
  const bgAt = { x: b.x + 30, y: b.y + b.height - 90 };

  await page.getByTestId("display-mode").selectOption("shadedEdges");
  const shaded = await pixels(page);
  const faceShaded = shaded.at(side.x, side.y);
  expect(diff(faceShaded, shaded.at(bgAt.x, bgAt.y))).toBeGreaterThan(25);

  await page.getByTestId("display-mode").selectOption("wireframe");
  await expect(page.getByTestId("viewport")).toHaveAttribute("data-display", "wireframe");
  expect(await page.evaluate(() => window.__pzView!.view().drawn)).toBe("wireframe");
  const wire = await pixels(page);
  // No faces: the side-face point now shows the background, and the hidden back-bottom edge is
  // drawn.
  expect(diff(wire.at(side.x, side.y), faceShaded)).toBeGreaterThan(20);
  expect(diff(wire.at(hidden.x, hidden.y), shaded.at(hidden.x, hidden.y))).toBeGreaterThan(15);
  // Wireframe picks edges only: a click on the (absent) face selects nothing.
  await page.mouse.click(side.x, side.y);
  await page.waitForTimeout(150);
  expect((await selection(page)).items).toEqual([]);

  for (const mode of ["hiddenLine", "xray"] as const) {
    if (nativeModes.includes(mode)) {
      await page.getByTestId("display-mode").selectOption(mode);
      await expect(page.getByTestId("viewport")).toHaveAttribute("data-display", mode);
      expect(await page.evaluate(() => window.__pzView!.view().drawn)).toBe(mode);
      const img = await pixels(page);
      const face = img.at(side.x, side.y);
      if (mode === "hiddenLine") {
        // Flat "paper" faces: white on forge-render, the theme's background on the placeholder.
        if (renderer === "forge-web") expect(luma(face)).toBeGreaterThan(235);
        else expect(Math.abs(luma(face) - luma(img.at(bgAt.x, bgAt.y)))).toBeLessThan(25);
      } else {
        // Translucent faces: between the shaded face and the bare background.
        expect(diff(face, faceShaded)).toBeGreaterThan(10);
        expect(diff(face, wire.at(side.x, side.y))).toBeGreaterThan(2);
      }
    } else {
      await expect(page.locator(`[data-testid="display-mode"] option[value="${mode}"]`)).toBeDisabled();
      const r = await view(page, { id: "view.setDisplayMode", args: { mode } });
      expect(r).toMatchObject({ ok: false, error: { code: "FAILED" } });
      test.info().annotations.push({ type: "note", description: `${mode}: renderer without display modes (view_ext not wired)` });
    }
  }

  await page.getByTestId("display-mode").selectOption("shaded");
  const plain = await pixels(page);
  // The visible top-front edge is no longer drawn dark.
  const edge = await at(page, [0, -25, 5]);
  expect(luma(plain.at(edge.x, edge.y - 1))).toBeGreaterThan(luma(shaded.at(edge.x, edge.y)) - 5);
  await page.getByTestId("display-mode").selectOption("shadedEdges");
  // The choice persists across restarts (a view preference).
  expect(await page.evaluate(() => localStorage.getItem("aicad.view"))).toContain("shadedEdges");
});

test("the command palette lists the viewport commands (display, section, measure)", async () => {
  const { page } = L;
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.locator(".viewport-canvas").focus();
  await page.keyboard.press(`${mod}+K`);
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await page.keyboard.type("display wireframe");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page.getByTestId("viewport")).toHaveAttribute("data-display", "wireframe");
  await page.keyboard.press(`${mod}+K`);
  await page.keyboard.type("section xz");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("section-panel")).toBeVisible();
  await view(page, { id: "view.clearSection" });
  await view(page, { id: "view.setDisplayMode", args: { mode: "shadedEdges" } });
});

test("per-body colour and visibility from the Bodies menu reach the renderer", async () => {
  const { page } = L;
  const top = await at(page, [0, 18, 5]);
  const before = (await pixels(page)).at(top.x, top.y);
  await page.getByTestId("bodies-menu").click();
  const row = page.locator(`.vp-body-row[data-body="${PLATE}"]`);
  await expect(row).toBeVisible();
  await row.locator('[data-swatch="Red"]').click();
  await expect.poll(async () => page.evaluate((b) => window.__pzView!.view().bodies[b]?.color ?? null, PLATE)).not.toBeNull();
  const red = (await pixels(page)).at(top.x, top.y);
  expect(red[0] - red[2]).toBeGreaterThan(before[0] - before[2] + 30);
  await row.getByTestId("body-visibility").click();
  await expect.poll(async () => page.evaluate((b) => window.__pzView!.view().bodies[b]?.visible, PLATE)).toBe(false);
  const hiddenPx = (await pixels(page)).at(top.x, top.y);
  expect(diff(hiddenPx, red)).toBeGreaterThan(30);
  await row.getByTestId("body-visibility").click();
  await row.locator('[data-swatch="Default"]').click();
  await page.getByTestId("bodies-menu").click();
  await expect.poll(async () => page.evaluate((b) => window.__pzView!.view().bodies[b], PLATE)).toEqual({ visible: true, color: null });
  const back = (await pixels(page)).at(top.x, top.y);
  expect(diff(back, before)).toBeLessThan(6);
});

test("grid toggle and the origin planes, axes and point (selectable)", async () => {
  const { page } = L;
  await page.getByTestId("toggle-grid").click();
  expect(await page.evaluate(() => window.__pzView!.view().grid)).toBe(true);
  await expect(page.getByTestId("toggle-grid")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("toggle-grid").click();
  expect(await page.evaluate(() => window.__pzView!.view().grid)).toBe(false);

  await expect(page.getByTestId("origin-display")).toHaveCount(0);
  await page.getByTestId("toggle-origin").click();
  await expect(page.getByTestId("origin-display")).toBeVisible();
  await page.locator('.vp-origin-label[data-origin="XZ"]').click();
  await expect.poll(async () => (await selection(page)).items).toEqual([{ kind: "origin", id: "XZ", label: "XZ plane" }]);
  await page.locator('.vp-axis-hit[data-origin="Z"]').click({ force: true, modifiers: ["Shift"] });
  await expect.poll(async () => (await selection(page)).items.map((i) => i.id)).toEqual(["XZ", "Z"]);
  await page.keyboard.press("Escape");
  await page.getByTestId("toggle-origin").click();
  await expect(page.getByTestId("origin-display")).toHaveCount(0);
  // Clicking the model still works with the overlay present.
  await clickWorld(page, [0, 18, 5]);
  await expect.poll(async () => (await selection(page)).items[0]?.key).toBe("plate/cap:end");
  expect(L.pageErrors).toEqual([]);
});
