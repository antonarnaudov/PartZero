/**
 * The one command layer end to end on the IR v1 model (FULL-MODELING-PLAN §2.1–§2.3): a new
 * document → a rectangle sketched with the real mouse and keys → Finish puts it in the timeline →
 * an extrude by command (`ir.addFeature`) makes a body → undo / redo → Save As `.partzero` →
 * reopened from disk → the identical model. Along the way: the code view is hidden by default
 * (View ▸ Show Code shows it read-only), the timeline marks the agent's features and edits a feature
 * in its property panel, and the live op host commits as the agent.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { appDir } from "./app-dir.js";
import { readPartZero } from "./partzero-files.js";
import { screenshotPath } from "./screenshots.js";

interface Result {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string; detail?: { code: string } };
}

interface Summary {
  format: string;
  name: string;
  path: string | null;
  dirty: boolean;
  rollback: string | null;
  features: Array<{ id: string; name: string; type: string; status: string | null; author: string }>;
  bodies: Array<{ name: string; triangles: number }>;
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
}

type AW = {
  __aicad: {
    execute(cmd: unknown): Promise<Result>;
    idle(): Promise<Summary>;
    ops: { document(): Promise<string>; apply(ops: unknown[], options?: { label?: string }): Promise<unknown> };
  };
  __pzSketch: { state(): { phase: string; tool: string }; client(u: number, v: number): [number, number] };
};

let app: ElectronApplication;
let page: Page;
let userData: string;
let work: string;
const pageErrors: string[] = [];

async function exec(id: string, args: Record<string, unknown> = {}): Promise<Result> {
  return page.evaluate(([i, a]) => (window as unknown as AW).__aicad.execute({ id: i, args: a }), [id, args] as const);
}

async function summary(): Promise<Summary> {
  return page.evaluate(async () => JSON.parse(JSON.stringify(await (window as unknown as AW).__aicad.idle())) as Summary);
}

async function modelText(): Promise<string> {
  const r = await exec("ir.state", { document: true });
  return (r.value as { document: string }).document;
}

const row = (name: string) => page.locator(`[data-testid="timeline-feature"][data-feature="${name}"]`);

async function at(u: number, v: number): Promise<[number, number]> {
  return page.evaluate(([x, y]) => (window as unknown as AW).__pzSketch.client(x!, y!), [u, v]);
}

async function click(u: number, v: number): Promise<void> {
  const [x, y] = await at(u, v);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "aicad-v1-e2e-"));
  work = mkdtempSync(join(tmpdir(), "aicad-v1-files-"));
  await launchApp();
});

async function launchApp(): Promise<void> {
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
  await page.waitForFunction(() => !!(window as unknown as Partial<AW>).__aicad, undefined, { timeout: 60_000 });
  await page.waitForFunction(
    () => (window as unknown as { __aicad: { describe(): Array<{ id: string }> } }).__aicad.describe().some((c) => c.id === "file.status"),
    undefined,
    { timeout: 60_000 },
  );
  await page.evaluate(() => (window as unknown as AW).__aicad.idle());
}

test.afterAll(async () => {
  await app?.close();
  for (const d of [userData, work]) if (d) rmSync(d, { recursive: true, force: true });
});

test("a new document is an empty IR v1 model, and the code view is hidden until View ▸ Show Code", async () => {
  const s = await summary();
  expect(s).toMatchObject({ format: "ir-v1", dirty: false, features: [], bodies: [] });
  await expect(page.getByTestId("dock-tab-code")).toHaveCount(0);
  await expect(page.locator(".monaco-editor")).toBeHidden();
  expect(await exec("view.toggleCode")).toMatchObject({ ok: true, value: { visible: true } });
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await expect(page.getByText("CadScript · read-only")).toBeVisible();
  expect(await exec("view.toggleCode")).toMatchObject({ ok: true, value: { visible: false } });
  await expect(page.locator(".monaco-editor")).toBeHidden();
});

test("a rectangle sketched with the mouse lands in the timeline on Finish", async () => {
  await page.getByTestId("tool-sketch.new").click();
  await page.getByTestId("sketch-plane-XY").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as AW).__pzSketch.state().phase)).toBe("active");
  await page.keyboard.press("r");
  await expect.poll(() => page.evaluate(() => (window as unknown as AW).__pzSketch.state().tool)).toBe("rect2");
  await click(0.2, 0.2);
  await click(40, 25);
  await page.getByTestId("sketch-finish").click();
  await expect(page.getByTestId("sketch-mode")).toBeHidden();
  await expect(row("sketch1")).toHaveAttribute("data-status", "ok");
  await expect(row("sketch1")).toHaveAttribute("data-type", "sketch");
  const s = await summary();
  expect(s.features.map((f) => [f.id, f.type, f.status, f.author])).toEqual([["sketch1", "sketch", "ok", "user"]]);
  expect(s.dirty).toBe(true);
});

test("an extrude by command makes a body; undo and redo step it back and forth", async () => {
  const r = await exec("ir.addFeature", { feature: { type: "extrude", sketch: "sketch1", distance: 8 } });
  expect(r.ok, r.error?.message).toBe(true);
  await expect(row("extrude1")).toHaveAttribute("data-status", "ok");
  let s = await summary();
  expect(s.bodies.map((b) => b.name)).toEqual(["part/extrude1"]);
  expect(s.bbox?.max[2]).toBeCloseTo(8, 6);
  expect(s.bbox?.max[0]).toBeCloseTo(40, 6);
  await page.screenshot({ path: screenshotPath("v1-model.png", "AICAD_E2E_V1_SCREENSHOT") });

  expect(await exec("edit.undo")).toMatchObject({ ok: true, value: { undone: true } });
  await expect(row("extrude1")).toHaveCount(0);
  s = await summary();
  expect(s.bodies).toEqual([]);
  expect(await exec("edit.redo")).toMatchObject({ ok: true, value: { redone: true } });
  await expect(row("extrude1")).toHaveAttribute("data-status", "ok");
  s = await summary();
  expect(s.bodies).toHaveLength(1);
});

test("the timeline edits a feature in its property panel (double-click) as one undo step", async () => {
  await row("extrude1").dblclick();
  await expect(page.getByTestId("property-panel")).toBeVisible();
  const distance = page.getByTestId("input-distance");
  await expect(distance).toBeVisible();
  await distance.fill("12");
  await expect(page.getByTestId("panel-ok")).toBeEnabled();
  await page.getByTestId("panel-ok").click();
  await expect(page.getByTestId("property-panel")).toBeHidden();
  await expect.poll(async () => (await summary()).bbox?.max[2]).toBeCloseTo(12, 6);
  expect(await exec("edit.undo")).toMatchObject({ ok: true, value: { undone: true } });
  await expect.poll(async () => (await summary()).bbox?.max[2]).toBeCloseTo(8, 6);
});

test("the agent's op host commits live and its feature is marked", async () => {
  // Recolouring your extrude is a change to your work: refused without your approval (ADR 0015).
  const recolour = await page.evaluate(() =>
    (window as unknown as AW).__aicad.ops.apply([{ op: "setAppearance", feature: "extrude1", color: "#e0552b" }, { op: "addParam", name: "boss_h", unit: "mm", value: 3 }]).then(
      () => null,
      (e: { code?: string }) => e.code ?? "?",
    ),
  );
  expect(recolour).toBe("unapproved_user_change");
  // A new parameter of its own is fine.
  await page.evaluate(() => (window as unknown as AW).__aicad.ops.apply([{ op: "addParam", name: "boss_h", unit: "mm", value: 3 }], { label: "Agent: a parameter" }));
  let s = await summary();
  expect(s.features.map((f) => f.author)).toEqual(["user", "user"]);
  // A feature the agent adds shows at once, marked, and Keep makes it yours.
  await page.evaluate(() =>
    (window as unknown as AW).__aicad.ops.apply([{ op: "addFeature", feature: { type: "extrude", name: "lip", sketch: "sketch1", distance: 2, direction: "reverse", op: "join", targets: "all" } }], {
      label: "Agent: a lip",
    }),
  );
  await expect(row("lip")).toHaveAttribute("data-author", "agent");
  await expect(row("lip").getByTestId("timeline-agent-badge")).toBeVisible();
  await expect(page.getByTestId("timeline-keep-all")).toBeVisible();
  s = await summary();
  expect(s.features.map((f) => [f.name, f.author])).toEqual([
    ["sketch1", "user"],
    ["extrude1", "user"],
    ["lip", "agent"],
  ]);
  expect(s.bbox?.min[2]).toBeCloseTo(-2, 6);
  expect(await exec("edit.undo")).toMatchObject({ ok: true, value: { undone: true, label: "Agent: a lip" } });
  await expect(row("lip")).toHaveCount(0);
  // The agent may not change your extrude without your approval (ADR 0015).
  const refused = await page.evaluate(() =>
    (window as unknown as AW).__aicad.ops.apply([{ op: "setField", feature: "extrude1", path: "/distance", value: 20 }]).then(
      () => null,
      (e: { code?: string }) => e.code ?? "?",
    ),
  );
  expect(refused).toBe("unapproved_user_change");
  expect(await exec("edit.undo")).toMatchObject({ ok: true, value: { undone: true, label: "Agent: a parameter" } });
});

test("Save As writes a .partzero with the v1 model; reopened from disk it is identical", async () => {
  const before = await modelText();
  const beforeSummary = await summary();
  const file = join(work, "plate.partzero");
  // Paths are the user's choice: answer the Save dialog in the main process.
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (() => Promise.resolve({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, file);
  const saved = await exec("file.saveAs");
  expect(saved.ok, saved.error?.message).toBe(true);
  expect((await summary()).dirty).toBe(false);
  const pz = readPartZero(readFileSync(file));
  expect(pz.manifest.document.irSchema).toBe("aicad.ir/1");
  expect(pz.files.get("document.json")!.toString("utf8")).toBe(before);
  expect(pz.code).toBeNull();
  // The agent's parameter was undone, so nothing but the model and the view state.
  expect(pz.manifest.view.rollbackMarker).toBeNull();

  // Quit, launch the app again and open the file from disk: the identical model.
  await app.close();
  await launchApp();
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
  }, file);
  const opened = await exec("file.open");
  expect(opened.ok, opened.error?.message).toBe(true);
  await expect.poll(async () => (await summary()).path).toBe(file);
  expect(await modelText()).toBe(before);
  const after = await summary();
  expect(after).toMatchObject({ format: "ir-v1", dirty: false, path: file, name: "plate" });
  expect(after.features).toEqual(beforeSummary.features);
  expect(after.bodies.map((b) => b.name)).toEqual(beforeSummary.bodies.map((b) => b.name));
  expect(after.bbox).toEqual(beforeSummary.bbox);
  await expect(row("extrude1")).toHaveAttribute("data-status", "ok");
  // Undo history starts fresh with the opened file; an edit makes it dirty and undo returns to the saved model.
  expect((await exec("ir.setSuppressed", { feature: "extrude1", suppressed: true })).ok).toBe(true);
  expect((await summary()).dirty).toBe(true);
  expect(await exec("edit.undo")).toMatchObject({ ok: true, value: { undone: true } });
  expect(await modelText()).toBe(before);
  expect((await summary()).dirty).toBe(false);
  expect(pageErrors).toEqual([]);
});
