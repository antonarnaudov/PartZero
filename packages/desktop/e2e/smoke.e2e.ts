/**
 * Smoke test of the desktop app: launch Electron (production mode: built app over app://),
 * create a document from a MakerBench template through the UI, check the timeline and that there
 * are zero problems, export 3MF through the command layer, and save a screenshot.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotPath = process.env["AICAD_E2E_SCREENSHOT"] ?? join(desktopRoot, "..", "..", "docs", "spikes", "assets", "app-shell.png");
/** `fallback`: the app was built without forge-web (see scripts/e2e-fallback.mjs). */
const expectFallback = process.env["AICAD_E2E_EXPECT"] === "fallback";

interface Summary {
  name: string;
  dirty: boolean;
  engine: string;
  reportStatus: string | null;
  features: Array<{ name: string; type: string; status: string | null }>;
  bodies: Array<{ name: string; faces: string[]; triangles: number; edges: number }>;
  problems: Array<{ code: string; severity: string; message: string }>;
  selection: { feature: string | null; entity: { body: string; face?: string; edge?: string } | null };
}

interface Automation {
  execute(cmd: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;
  idle(): Promise<Summary>;
  summary(): Summary;
}

declare global {
  interface Window {
    __aicad?: Automation;
  }
}

let app: ElectronApplication;
let page: Page;
let userData: string;
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
const ENGINE_LABEL = /forge-web · wasm|Forge CLI · native/;

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "aicad-e2e-"));
  // No provider keys reach this suite (the chat message below must never start a paid run).
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$/.test(k)) env[k] = v;
  app = await electron.launch({
    args: [desktopRoot, "--use-mock-keychain"],
    env: { ...env, AICAD_USER_DATA_DIR: userData, AICAD_SKIP_CLOSE_PROMPT: "1", AICAD_AGENT_DOTENV: "off", AICAD_AGENT_TRANSPORT: "live" },
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("crash", () => pageErrors.push("renderer crashed"));
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setBounds({ x: 40, y: 40, width: 1480, height: 920 });
  });
});

test.afterAll(async () => {
  await app?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

test("launches the shell with a sandboxed, cross-origin-isolated renderer", async () => {
  await expect(page.getByTestId("app-shell")).toBeVisible();
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe("undefined");
  expect(await page.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe("undefined");
  expect(page.url()).toBe("app://aicad/index.html");
  // forge-web (WASM) when it is built, else the native Forge CLI.
  await expect(page.getByTestId("engine-label")).toHaveText(expectFallback ? /Forge CLI · native/ : ENGINE_LABEL);
  if (expectFallback) await expect(page.locator(".vp-chip")).toHaveText(/Placeholder · Canvas 2D/);
});

test("creates a document from a MakerBench template: timeline, zero problems, bodies", async () => {
  await page.getByRole("button", { name: "New from template" }).click();
  const dialog = page.getByTestId("template-dialog");
  await expect(dialog).toBeVisible();
  await page.getByLabel("Search templates").fill("nema 17");
  await page.locator('[data-template="t1-nema17-plate"]').click();
  await expect(dialog).toBeHidden();

  const features = page.getByTestId("timeline-feature");
  await expect(features).toHaveCount(2);
  await expect(page.locator('[data-testid="timeline-feature"][data-feature="outline"]')).toHaveAttribute("data-status", "ok");
  await expect(page.locator('[data-testid="timeline-feature"][data-feature="plate"]')).toHaveAttribute("data-status", "ok");
  await expect(page.getByTestId("problems-count")).toHaveText("0");
  await expect(page.getByTestId("body-count")).toHaveText("1 body");
  await expect(page.getByTestId("doc-title")).toContainText("t1-nema17-plate");

  const summary = await page.evaluate(() => window.__aicad!.idle());
  expect(["forge-web", "forge-cli"]).toContain(summary.engine);
  expect(summary.reportStatus).toBe("ok");
  expect(summary.problems).toEqual([]);
  expect(summary.features.map((f) => `${f.name}:${f.status}`)).toEqual(["outline:ok", "plate:ok"]);
  expect(summary.bodies).toHaveLength(1);
  expect(summary.bodies[0]!.faces).toHaveLength(11);
  expect(summary.bodies[0]!.edges).toBe(22);
});

test("both engines agree on the template (when forge-web is present)", async () => {
  const first = await page.evaluate(() => window.__aicad!.idle());
  const shape = (s: Summary): unknown => ({
    status: s.reportStatus,
    features: s.features,
    bodies: s.bodies.map((b) => ({ name: b.name, faces: [...b.faces].sort(), edges: b.edges })),
  });
  if (first.engine === "forge-web") {
    const r = await page.evaluate(() => window.__aicad!.execute({ id: "engine.select", args: { engine: "forge-cli" } }));
    expect(r).toMatchObject({ ok: true, value: { engine: "forge-cli" } });
    const viaCli = await page.evaluate(() => window.__aicad!.idle());
    expect(viaCli.engine).toBe("forge-cli");
    expect(shape(viaCli)).toEqual(shape(first));
    await page.evaluate(() => window.__aicad!.execute({ id: "engine.select", args: { engine: "auto" } }));
    expect((await page.evaluate(() => window.__aicad!.idle())).engine).toBe("forge-web");
  } else {
    test.info().annotations.push({ type: "note", description: "forge-web not available; CLI engine only" });
  }
});

test("picking a face in the viewport selects its feature and reveals it in code", async () => {
  const canvas = page.locator(".viewport-canvas");
  const box = (await canvas.boundingBox())!;
  // Iso view of the fitted plate: this point is on the top face between the pilot hole and an M3 hole.
  await page.mouse.click(box.x + box.width * 0.66, box.y + box.height * 0.43);
  await expect(page.locator('[data-testid="timeline-feature"][data-feature="plate"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cad-selected-feature").first()).toBeAttached();
  const { selection } = await page.evaluate(() => window.__aicad!.summary());
  expect(selection).toEqual({ feature: "plate", entity: { body: "plate/plate", face: "plate/cap:end" } });
  // The chat composer carries the selection as context chips.
  await expect(page.locator(".compose-chips .chip")).toHaveCount(2);
});

test("exports 3MF through the command layer", async () => {
  const out = join(userData, "t1-nema17-plate.3mf");
  // Answer the native save dialog (the command asks for the path like it does for the user).
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (() => Promise.resolve({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
  }, out);
  const r = await page.evaluate(() => window.__aicad!.execute({ id: "file.exportMesh", args: { format: "3mf" } }));
  expect(r).toMatchObject({ ok: true, value: { exported: true, path: out, format: "3mf" } });
  const bytes = readFileSync(out);
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  expect(statSync(out).size).toBeGreaterThan(1000);
  // Writing anywhere else is refused: paths must come from a dialog.
  const denied = await page.evaluate(() => window.__aicad!.execute({ id: "file.exportMesh", args: { format: "stl", path: "/tmp/aicad-not-granted.stl" } }));
  expect(denied).toMatchObject({ ok: false, error: { code: "FAILED" } });
  expect(denied.error?.message).toMatch(/access denied/);
});

test("keyboard-first: command palette, and ⌘Z in the editor undoes through the document history", async () => {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+K`);
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await page.keyboard.type("view top");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page.locator(".vp-btn.active")).toHaveText("Top");
  await page.locator(".vp-btn", { hasText: /^Iso$/ }).click();

  // Type into Monaco: the edit becomes a DocStore transaction and recompiles.
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type("\n// checked by e2e");
  await expect(page.getByTestId("doc-title").locator(".dirty-dot")).toBeVisible();
  expect(await page.evaluate(() => window.__aicad!.summary().dirty)).toBe(true);
  await page.keyboard.press(`${mod}+Z`);
  await expect(page.getByTestId("doc-title").locator(".dirty-dot")).toHaveCount(0);
  const s = await page.evaluate(() => window.__aicad!.idle());
  expect(s.problems).toEqual([]);
});

test("native menu items run commands", async () => {
  await expect(page.getByTestId("problems-count")).toBeVisible();
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("view.toggleProblems")?.click());
  await expect(page.getByTestId("problems-count")).toBeHidden();
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("view.toggleProblems")?.click());
  await expect(page.getByTestId("problems-count")).toBeVisible();
});

test("About → Licenses: the MPL-2.0 text, the source notice and the third-party notices ship with the app", async () => {
  await page.evaluate(() => window.__aicad!.execute({ id: "help.about" }));
  const about = page.getByRole("dialog", { name: "About aicad" });
  await expect(about.getByTestId("about-source")).toContainText("Source code:");
  await about.getByTestId("about-notices").click();
  const text = about.getByTestId("license-text");
  await expect(text).toContainText("THIRD-PARTY SOFTWARE NOTICES: aicad web app");
  // npm packages in the bundle and workers, with notices the minifier strips (React headers,
  // DOMPurify vendored inside Monaco, Monaco's and TypeScript's own third-party notice files).
  for (const s of ["monaco-editor 0.56", "react-dom", "scheduler", "typescript", "zod", "Meta Platforms", "@license DOMPurify", "markedjs NOTICES", "ThirdPartyNoticeText.txt"]) {
    await expect(text).toContainText(s);
  }
  // The Rust crates compiled into the bundled Forge WASM module.
  if (!expectFallback) await expect(text).toContainText("forge_wasm_bg.wasm (@aicad/forge-web)");
  await about.getByTestId("about-back").click();
  await about.getByTestId("about-license").click();
  await expect(about.getByTestId("license-text")).toContainText("Mozilla Public License Version 2.0");
  await page.keyboard.press("Escape");
  await expect(about).toBeHidden();
});

test("screenshot of the main window", async () => {
  await page.getByLabel("Message").fill("Make the plate 1 mm thicker and add a chamfer on the top edges");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg-user")).toHaveCount(1);
  // Without keys the run is refused up front, with a way to fix it.
  await expect(page.locator(".msg-error")).toContainText("No API key for Anthropic");
  await expect(page.locator(".msg-error").getByRole("button", { name: "Open Settings" })).toBeVisible();
  await page.locator(".toast").evaluateAll((els) => els.forEach((e) => e.remove()));
  await page.mouse.move(5, 300);
  await page.waitForTimeout(300);
  const renderer = await page.locator(".vp-chip").textContent();
  const frameMs = await page.locator(".viewport-canvas").getAttribute("data-frame-ms");
  test.info().annotations.push({ type: "viewport", description: `${renderer ?? "?"}${frameMs ? ` (last frame ${frameMs} ms)` : ""}` });
  await page.screenshot({ path: screenshotPath });
  expect(statSync(screenshotPath).size).toBeGreaterThan(10_000);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((m) => /Content Security Policy|Refused to/i.test(m))).toEqual([]);
});
