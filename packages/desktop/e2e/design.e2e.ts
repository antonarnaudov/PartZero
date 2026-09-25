/**
 * The design pass (the owner's "pro-grade visual design", 2026-09-25), checked on the built app and
 * captured for review: every key screen in the dark and the light theme is saved to
 * `<worktree>/test-results/design/` (git-ignored). A fresh profile, a fake Claude Code (no network,
 * no key) and a fake Bambu Studio `.app`, as in shell.e2e.ts.
 *
 * What is checked, beyond the screenshots:
 * - **No code in the default UI:** no code tab, no Monaco editor, on the welcome screen, a model, a
 *   tool panel and in sketch mode.
 * - **Themes:** both themes set their tokens; body text on panels reads at 4.5:1 or better.
 * - **Toolbar like Fusion:** the title bar's Solid / Sketch tabs switch the ribbon; the Solid ribbon
 *   is grouped (Sketch, Create, Inspect captions); every ribbon tool draws a PartZero icon; while a
 *   sketch is open the Sketch tab holds the sketcher's tools, constraints and Finish Sketch.
 * - **Panels:** a tool's property panel floats over the viewport's top left; the left dock has
 *   Timeline, Browser and Parameters tabs; the assistant's column stays narrow (the viewport is
 *   the widest region).
 * - **Welcome:** five starter cards, each with a thumbnail; the ready-made ones show Forge's render.
 * - **Open in Bambu Studio** offers 3MF (print-ready) or STEP (exact geometry).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { appDir, desktopRoot } from "./app-dir.js";
import { makeFakeClaude, type FakeClaude } from "./fake-cli.js";

let app: ElectronApplication;
let page: Page;
let root: string;
let fake: FakeClaude;
const pageErrors: string[] = [];
/** `<worktree>/test-results/design/` (outside Playwright's own output folder, which each run empties). */
const designDir = join(desktopRoot, "..", "..", "test-results", "design");

test.skip(process.platform === "win32", "the fake CLI is a POSIX script");

type AW = { __aicad: { execute(cmd: unknown): Promise<{ ok: boolean }>; idle(): Promise<{ bodies: unknown[] }> } };

function keylessEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /(API_?KEY|TOKEN|SECRET)/i.test(k) || /^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|CLAUDE_CODE|CODEX|CURSOR)_/.test(k) || k.startsWith("AICAD_")) continue;
    env[k] = v;
  }
  return { ...env, AICAD_AGENT_DOTENV: "off", AICAD_SKIP_CLOSE_PROMPT: "1", ...extra };
}

const exec = (id: string, args: Record<string, unknown> = {}) => page.evaluate(([i, a]) => (window as unknown as AW).__aicad.execute({ id: i, args: a }), [id, args] as const);
const idle = () => page.evaluate(() => (window as unknown as AW).__aicad.idle());
const shot = async (name: string): Promise<void> => {
  await page.waitForTimeout(250); // let transitions settle
  await page.screenshot({ path: join(designDir, `${name}.png`) });
};
const theme = async (t: "dark" | "light"): Promise<void> => {
  await exec("view.setTheme", { theme: t });
  await expect(page.locator("html")).toHaveAttribute("data-theme", t);
};

/** No code anywhere in the window (the owner's rule: "we are not OpenSCAD"). */
async function expectNoCode(): Promise<void> {
  await expect(page.getByTestId("dock-tab-code")).toHaveCount(0);
  await expect(page.locator(".monaco-editor:visible")).toHaveCount(0);
}

/** WCAG contrast of the computed text colour on the computed background of two elements. */
async function contrast(textSel: string, bgSel: string): Promise<number> {
  return page.evaluate(
    ([t, b]) => {
      const rgb = (s: string): number[] => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = (c: number[]): number => {
        const [r, g, bl] = c.map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
      };
      const fg = rgb(getComputedStyle(document.querySelector(t!)!).color);
      const bg = rgb(getComputedStyle(document.querySelector(b!)!).backgroundColor);
      const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    },
    [textSel, bgSel],
  );
}

test.beforeAll(async () => {
  mkdirSync(designDir, { recursive: true });
  root = mkdtempSync(join(tmpdir(), "pz-e2e-design-"));
  fake = makeFakeClaude(join(root, "fake"), { loggedIn: true });
  const userData = join(root, "profile");
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, "agent-settings.json"), JSON.stringify({ v: 1, models: {}, budgetUsd: 1, compatBaseUrl: null, ollamaBaseUrl: "http://127.0.0.1:9" }));
  const apps = join(root, "Applications");
  const slicer = join(apps, "BambuStudio.app");
  mkdirSync(join(slicer, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(slicer, "Contents", "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>CFBundleIdentifier</key>\n  <string>com.bambulab.bambu-studio</string>\n  <key>CFBundleShortVersionString</key>\n  <string>02.06.00.51</string>\n</dict>\n</plist>\n',
  );
  app = await electron.launch({
    args: [appDir, "--use-mock-keychain"],
    env: keylessEnv({ AICAD_USER_DATA_DIR: userData, AICAD_CLI_DIRS: fake.binDir, AICAD_SLICER_DIRS: apps }),
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1480, height: 920 }));
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as Partial<AW>).__aicad, undefined, { timeout: 60_000 });
});

test.afterAll(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the welcome screen: five starter cards with thumbnails, Forge's render for the ready-made ones", async () => {
  const welcome = page.getByTestId("welcome");
  await expect(welcome).toBeVisible();
  await expect(welcome.getByTestId("welcome-provider")).toContainText("ready", { timeout: 30_000 });
  const cards = welcome.getByTestId("welcome-starter");
  await expect(cards).toHaveCount(5);
  for (let i = 0; i < 5; i++) await expect(cards.nth(i).locator(".wl-thumb svg.starter-art, .wl-thumb canvas.wl-render")).toHaveCount(1);
  // The two starters with ready-made examples (phone stand, electronics box) show Forge's picture.
  for (const id of ["p2-phone-stand", "p5-electronics-box"]) {
    await expect(welcome.locator(`[data-starter="${id}"] [data-testid="starter-render"]`)).toBeVisible({ timeout: 30_000 });
  }
  // The render has pixels (not a blank canvas).
  const painted = await welcome.locator('[data-starter="p5-electronics-box"] canvas').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
    return n / (c.width * c.height);
  });
  expect(painted).toBeGreaterThan(0.05);
  await expectNoCode();
  await theme("dark");
  await shot("01-welcome-dark");
  await theme("light");
  await shot("02-welcome-light");
  await theme("dark");
});

test("an empty document: the timeline's empty state, one Problems row, the Solid ribbon", async () => {
  await page.getByTestId("welcome-close").click();
  await expect(page.getByTestId("welcome")).toBeHidden();
  await expect(page.getByTestId("timeline-empty")).toBeVisible();
  await expect(page.getByTestId("problems-count")).toHaveText("0");
  const bottom = await page.locator(".bottom").boundingBox();
  expect(bottom!.height).toBeLessThanOrEqual(32);
  await expect(page.getByTestId("ws-tab-solid")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("ribbon")).toHaveAttribute("data-workspace", "solid");
  await expectNoCode();
  await shot("03-empty-dark");
});

test("a model: grouped ribbon with our icons, the timeline, the assistant stays narrow (dark and light)", async () => {
  await page.evaluate(() => (window as unknown as { __partzero: { execute(c: unknown): Promise<unknown> } }).__partzero.execute({ id: "help.welcome" }));
  await page.locator('[data-starter="p5-electronics-box"] [data-testid="starter-open"]').click();
  await idle();
  if (await page.getByTestId("welcome").isVisible()) await page.getByTestId("welcome-close").click();
  await expect(page.locator('[data-testid="timeline-feature"]')).toHaveCount(10);
  // Grouped like Fusion's SOLID tab, each group captioned; every tool draws a PartZero icon.
  const groups = await page.locator('[data-testid="ribbon"] .rb-group').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(groups.slice(0, 3)).toEqual(["group-sketch", "group-create", "group-inspect"]);
  const tools = page.locator('[data-testid="ribbon"] [data-testid^="tool-"]');
  expect(await tools.count()).toBeGreaterThanOrEqual(4);
  expect(await tools.evaluateAll((els) => els.every((e) => e.querySelector("svg.pz-icon") !== null))).toBe(true);
  // The viewport is the widest region; the assistant's column is under 30% of the window.
  const win = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const center = (await page.locator(".col-center").boundingBox())!;
  const right = (await page.locator(".col-right").boundingBox())!;
  expect(right.width / win.width).toBeLessThan(0.3);
  expect(center.width).toBeGreaterThan(right.width * 2);
  // Readable text on the panels, in both themes.
  expect(await contrast(".tl-name", ".col-left")).toBeGreaterThanOrEqual(4.5);
  await expectNoCode();
  await shot("04-model-dark");
  await theme("light");
  expect(await contrast(".tl-name", ".col-left")).toBeGreaterThanOrEqual(4.5);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".col-left")!).backgroundColor)).toBe("rgb(255, 255, 255)");
  await shot("05-model-light");
  await theme("dark");
});

test("a tool's property panel floats over the viewport's top left", async () => {
  await page.keyboard.press("e");
  const panel = page.getByTestId("property-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("floating-panel")).toBeVisible();
  const p = (await panel.boundingBox())!;
  const c = (await page.locator(".col-center").boundingBox())!;
  expect(p.x).toBeGreaterThanOrEqual(c.x);
  expect(p.x - c.x).toBeLessThan(40);
  expect(p.y).toBeGreaterThanOrEqual(c.y);
  expect(p.x + p.width).toBeLessThan(c.x + c.width / 2);
  await expect(page.getByTestId("dock-tab-properties")).toHaveCount(0);
  await expectNoCode();
  await shot("06-tool-panel-dark");
  await theme("light");
  await shot("07-tool-panel-light");
  await theme("dark");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("the left dock: Timeline, Browser (origin, bodies, sketches) and Parameters", async () => {
  await page.getByTestId("dock-tab-browser").click();
  await expect(page.getByTestId("browser-panel")).toBeVisible();
  await expect(page.getByTestId("browser-body")).toHaveCount(2);
  await expect(page.getByTestId("browser-sketch")).toHaveCount(5);
  await page.getByTestId("browser-origin-XY").click();
  await expect(page.getByTestId("browser-origin-XY")).toHaveAttribute("aria-selected", "true");
  await shot("08-browser-dark");
  await page.getByTestId("dock-tab-parameters").click();
  await expect(page.getByTestId("params-panel")).toBeVisible();
  await expect(page.getByTestId("params-panel").locator("tr")).toHaveCount(12);
  await shot("09-parameters-dark");
  await page.getByTestId("dock-tab-timeline").click();
});

test("Open in Bambu Studio offers 3MF (print-ready) or STEP (exact geometry)", async () => {
  await page.getByTestId("open-in-slicer-menu").click();
  const menu = page.getByTestId("open-in-slicer-choices");
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("slicer-format-3mf")).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByTestId("slicer-format-step")).toContainText("exact geometry");
  await shot("10-slicer-choice-dark");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("the Sketch tab: the sketcher's tools, constraints and Finish Sketch in the ribbon", async () => {
  await page.getByTestId("ws-tab-sketch").click();
  await expect(page.getByTestId("ribbon")).toHaveAttribute("data-workspace", "sketch");
  await expect(page.getByTestId("ribbon-create-sketch")).toBeVisible();
  await shot("11-sketch-tab-dark");
  await page.getByTestId("ribbon-create-sketch").click();
  await page.getByTestId("sketch-plane-XY").click();
  await expect(page.getByTestId("sketch-mode")).toBeVisible();
  const ribbon = page.getByTestId("ribbon");
  await expect(ribbon.getByTestId("sketch-palette")).toBeVisible();
  await expect(ribbon.getByTestId("sketch-constraints")).toBeVisible();
  await expect(ribbon.getByTestId("sketch-finish")).toBeVisible();
  await expect(page.getByTestId("ws-tab-solid")).toHaveAttribute("aria-disabled", "true");
  // The constraints sit inside the ribbon, not over the viewport.
  const rb = (await ribbon.boundingBox())!;
  const cons = (await ribbon.getByTestId("sketch-constraints").boundingBox())!;
  expect(cons.y + cons.height).toBeLessThanOrEqual(rb.y + rb.height + 1);
  expect(await ribbon.locator("[data-testid^='sketch-tool-'], [data-testid^='sketch-constrain-']").evaluateAll((els) => els.every((e) => e.querySelector("svg.pz-icon") !== null))).toBe(true);
  await page.keyboard.press("r");
  await expectNoCode();
  await shot("12-sketch-dark");
  await theme("light");
  await shot("13-sketch-light");
  await theme("dark");
  await page.getByTestId("sketch-cancel").click();
  await expect(page.getByTestId("sketch-mode")).toBeHidden();
  await expect(page.getByTestId("ribbon")).toHaveAttribute("data-workspace", "solid");
});

test("the command palette and the assistant's suggestions (light)", async () => {
  await theme("light");
  await expect(page.getByTestId("chat-suggestions")).toBeVisible();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.type("bambu");
  await shot("14-palette-light");
  await page.keyboard.press("Escape");
  await theme("dark");
  expect(pageErrors).toEqual([]);
});
