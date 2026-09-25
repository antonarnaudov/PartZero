/**
 * Documents and files end to end (FULL-MODELING-PLAN §2.9, DOC): `.partzero` save and open through the real shell,
 * atomic saves with a `.bak` and an interrupted save (the C7 fault point), the recent list and grid, crash recovery
 * after a force quit, the Save / Don't Save / Cancel prompt, several windows, a Finder double-click (`open-file`),
 * reference meshes, and the export dialog.
 *
 * Every test launches the development Electron on an isolated profile. Native dialogs are answered by replacing
 * Electron's `dialog` functions in the main process, as the other suites do.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { appDir } from "./app-dir.js";
import { boxStl, readPartZero } from "./partzero-files.js";
import { testResultsDir } from "./screenshots.js";

/** A screenshot of the window for review (git-ignored `test-results/files-<name>.png`). */
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(testResultsDir, `files-${name}.png`) });
}

interface Result {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
}

interface Automation {
  execute(cmd: unknown): Promise<Result>;
  describe(): Array<{ id: string }>;
  idle(): Promise<{ name: string; path: string | null; dirty: boolean }>;
  summary(): { name: string; path: string | null; dirty: boolean };
}

/** `window.__aicad` (typed locally: the other suites declare their own shapes). */
type AW = { __aicad: Automation };

const CODE = `import { doc, part, sketch, line, extrude, XY } from "@aicad/std";

doc({ name: "plate", description: "" });

part("plate");
// A comment only the code view keeps.
const outline = sketch(XY, {
  bottom: line([-20, -10], [20, -10]),
  right: line([20, -10], [20, 10]),
  top: line([20, 10], [-20, 10]),
  left: line([-20, 10], [-20, -10]),
});
const plate = extrude(outline, { distance: 4 });
`;

/** The environment of every launch: no provider keys, no dotenv. */
function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$/.test(k)) env[k] = v;
  return { ...env, AICAD_AGENT_DOTENV: "off", ...extra };
}

async function launch(userData: string, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [appDir, "--use-mock-keychain"], env: baseEnv({ AICAD_USER_DATA_DIR: userData, ...extra }) });
  const page = await app.firstWindow();
  await ready(page);
  return { app, page };
}

async function ready(page: Page): Promise<void> {
  // `__aicad` appears before bootstrap has picked the engine and loaded the starter document, and the starter would
  // replace whatever a test sets meanwhile. The document layer (with its `file.status`) is installed after both.
  await page.waitForFunction(
    () => {
      const a = (window as unknown as Partial<AW>).__aicad;
      return !!a && a.describe().some((c) => c.id === "file.status");
    },
    undefined,
    { timeout: 60_000 },
  );
  await page.evaluate(() => (window as unknown as AW).__aicad.idle());
}

function exec(page: Page, id: string, args: Record<string, unknown> = {}): Promise<Result> {
  return page.evaluate(([i, a]) => (window as unknown as AW).__aicad.execute({ id: i, args: a }), [id, args] as const);
}

async function setCode(page: Page, source: string): Promise<void> {
  expect(await exec(page, "doc.setSource", { source })).toMatchObject({ ok: true });
  await page.evaluate(() => (window as unknown as AW).__aicad.idle());
}

/** Answer the next save dialogs with `path` (every one until replaced). */
async function answerSave(app: ElectronApplication, path: string | null): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (() => Promise.resolve(p ? { canceled: false, filePath: p } : { canceled: true, filePath: "" })) as typeof dialog.showSaveDialog;
  }, path);
}

async function answerOpen(app: ElectronApplication, path: string | null): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (() => Promise.resolve(p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
  }, path);
}

/** Answer the unsaved-changes prompt: 0 Save, 1 Don't Save, 2 Cancel. Records the prompts in `globalThis.__prompts`. */
async function answerClosePrompt(app: ElectronApplication, response: 0 | 1 | 2): Promise<void> {
  await app.evaluate(({ dialog }, r) => {
    const g = globalThis as { __prompts?: string[] };
    g.__prompts ??= [];
    dialog.showMessageBox = ((_w: unknown, o: { message: string }) => {
      g.__prompts!.push(o.message);
      return Promise.resolve({ response: r, checkboxChecked: false });
    }) as unknown as typeof dialog.showMessageBox;
  }, response);
}

function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
}

let root: string;
test.beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "aicad-files-e2e-"));
});
test.afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function freshDir(name: string): string {
  const d = join(root, name);
  rmSync(d, { recursive: true, force: true });
  return d;
}

test("Save As writes a .partzero that reopens with the same code, model and title; a second save keeps a .bak", async () => {
  const userData = freshDir("profile-roundtrip");
  const docs = mkdtempSync(join(root, "docs-"));
  const file = join(docs, "plate.partzero");
  const { app, page } = await launch(userData, { AICAD_SKIP_CLOSE_PROMPT: "1" });
  try {
    await setCode(page, CODE);
    await answerSave(app, file);
    expect(await exec(page, "file.saveAs")).toMatchObject({ ok: true, value: { saved: true, path: file, format: "partzero" } });
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    // An ordinary zip that another reader opens: manifest, canonical IR, the code with its comment.
    const pz = readPartZero(bytes);
    expect(pz.manifest).toMatchObject({ format: "partzero", formatVersion: 1, code: { matchesDocument: true }, references: [] });
    expect(pz.code).toBe(CODE);
    expect(pz.document).toMatchObject({ schema: "aicad.ir/0", parts: [{ name: "plate" }] });
    expect(Object.keys(pz.manifest.entries).sort()).toEqual([...pz.files.keys()].filter((n) => n !== "manifest.json").sort());
    await expect(page.getByTestId("doc-title")).toContainText("plate");
    await expect(page.getByTestId("doc-title")).toContainText(".partzero");
    await expect(page.getByTestId("doc-title").locator(".dirty-dot")).toHaveCount(0);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle())).toMatch(/^plate — /);

    // Edit: the dirty marker shows in the app and the window title; Save writes in place and keeps the old version.
    await setCode(page, CODE.replace("distance: 4", "distance: 6"));
    await expect(page.getByTestId("doc-title").locator(".dirty-dot")).toBeVisible();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle())).toMatch(/^plate • — /);
    expect(await exec(page, "file.save")).toMatchObject({ ok: true, value: { saved: true, path: file } });
    expect(readPartZero(readFileSync(file)).code).toContain("distance: 6");
    expect(readPartZero(readFileSync(`${file}.bak`)).code).toContain("distance: 4");
    expect(readdirSync(docs).sort()).toEqual(["plate.partzero", "plate.partzero.bak"]);
  } finally {
    await app.close();
  }

  // A new launch: Open Recent (menu and grid) lists it, and it opens exactly as saved.
  const second = await launch(userData, { AICAD_SKIP_CLOSE_PROMPT: "1" });
  try {
    const menuItem = await second.app.evaluate(({ Menu }, p) => Menu.getApplicationMenu()?.getMenuItemById(`file.openRecent:${JSON.stringify({ path: p })}`)?.label ?? null, file);
    expect(menuItem).toBe("plate.partzero");
    expect(await exec(second.page, "file.showRecent")).toMatchObject({ ok: true, value: { count: 1 } });
    const card = second.page.getByTestId("recent-card");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-path", file);
    await card.click();
    await expect(second.page.getByTestId("recent-dialog")).toBeHidden();
    await expect.poll(async () => (await second.page.evaluate(() => (window as unknown as AW).__aicad.idle())).path).toBe(file);
    const s = await second.page.evaluate(() => (window as unknown as AW).__aicad.summary());
    expect(s).toMatchObject({ name: "plate", dirty: false });
    const status = (await exec(second.page, "file.status")).value as { path: string; dirty: boolean };
    expect(status).toMatchObject({ path: file, dirty: false });
    // The code view shows the saved code, comment included.
    await expect(second.page.locator(".monaco-editor .view-lines")).toContainText("A comment only the code view keeps.");
    await expect(second.page.locator(".monaco-editor .view-lines")).toContainText("distance: 6");
    // Clear Recent empties the list and the menu.
    expect(await exec(second.page, "file.clearRecent")).toMatchObject({ ok: true });
    const after = await second.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.find((i) => i.label === "&File" || i.label === "File")?.submenu?.items.find((i) => i.label === "Open Recent")?.submenu?.items.map((i) => i.label) ?? []);
    expect(after).toEqual(["No Recent Files"]);
  } finally {
    await second.app.close();
  }
});

test("an interrupted save leaves the previous file intact (fault point save:afterTempWrite)", async () => {
  const userData = freshDir("profile-fault");
  const docs = mkdtempSync(join(root, "docs-"));
  const file = join(docs, "part.partzero");
  const { app, page } = await launch(userData, { AICAD_SKIP_CLOSE_PROMPT: "1" });
  try {
    await setCode(page, CODE);
    await answerSave(app, file);
    expect(await exec(page, "file.saveAs")).toMatchObject({ ok: true });
    const good = readFileSync(file);
    await setCode(page, CODE.replace("distance: 4", "distance: 12"));
    await app.evaluate(() => {
      (globalThis as { __pzFaults?: Set<string> }).__pzFaults = new Set(["save:afterTempWrite"]);
    });
    const r = await exec(page, "file.save");
    expect(r).toMatchObject({ ok: false, error: { code: "FAILED" } });
    expect(r.error?.message).toMatch(/simulated failure at save:afterTempWrite/);
    expect(readFileSync(file).equals(good)).toBe(true);
    expect(readdirSync(docs)).toEqual(["part.partzero"]);
    // Still unsaved; the next save succeeds.
    expect((await page.evaluate(() => (window as unknown as AW).__aicad.summary())).dirty).toBe(true);
    expect(await exec(page, "file.save")).toMatchObject({ ok: true, value: { saved: true } });
    expect(readPartZero(readFileSync(file)).code).toContain("distance: 12");
  } finally {
    await app.close();
  }
});

test("an edit made while a save is still being written stays unsaved: dirty marker, close prompt and autosave", async () => {
  const userData = freshDir("profile-save-race");
  const docs = mkdtempSync(join(root, "docs-"));
  const file = join(docs, "race.partzero");
  const { app, page } = await launch(userData);
  try {
    await setCode(page, `${CODE}// saved\n`);
    await answerSave(app, file);
    // Hold the save in the main process after the temp file is written, before it replaces the target.
    await app.evaluate(() => {
      const g = globalThis as { __pzHold?: unknown; __pzHeld?: { reached: boolean }; __pzRelease?: () => void };
      let release!: () => void;
      const hold = { point: "save:beforeRename", reached: false, release: new Promise<void>((r) => (release = r)) };
      g.__pzHold = hold;
      g.__pzHeld = hold;
      g.__pzRelease = release;
    });
    await page.evaluate(() => {
      (window as unknown as { __save?: Promise<Result> }).__save = (window as unknown as AW).__aicad.execute({ id: "file.saveAs", args: {} });
    });
    await expect.poll(() => app.evaluate(() => (globalThis as { __pzHeld?: { reached: boolean } }).__pzHeld?.reached ?? false)).toBe(true);
    await setCode(page, `${CODE}// typed during the save\n`);
    await app.evaluate(() => (globalThis as { __pzRelease?: () => void }).__pzRelease!());
    const r = await page.evaluate(() => (window as unknown as { __save: Promise<Result> }).__save);
    expect(r).toMatchObject({ ok: true, value: { saved: true, path: file, upToDate: false } });

    // The file has what the save captured; the window still has the edit, unsaved.
    expect(readPartZero(readFileSync(file)).code).toBe(`${CODE}// saved\n`);
    expect(await page.evaluate(() => (window as unknown as AW).__aicad.summary())).toMatchObject({ name: "race", path: file, dirty: true });
    await expect(page.getByTestId("doc-title")).toContainText("race");
    if (process.platform === "darwin") {
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isDocumentEdited())).toBe(true);
    }
    // The autosave keeps it.
    expect(await exec(page, "file.flushRecovery")).toMatchObject({ ok: true, value: { written: true } });
    const snapshots = readdirSync(join(userData, "Recovery")).filter((n) => n.endsWith(".partzero"));
    expect(snapshots).toHaveLength(1);
    expect(readPartZero(readFileSync(join(userData, "Recovery", snapshots[0]!))).code).toContain("// typed during the save");
    // Closing asks (Cancel keeps the window).
    await answerClosePrompt(app, 2);
    expect(await exec(page, "file.close")).toMatchObject({ ok: true });
    await expect.poll(() => app.evaluate(() => (globalThis as { __prompts?: string[] }).__prompts?.length ?? 0)).toBe(1);
    expect((await app.evaluate(() => (globalThis as { __prompts?: string[] }).__prompts))?.[0]).toMatch(/changes you made to “race”/);
    expect(await windowCount(app)).toBe(1);
  } finally {
    await answerClosePrompt(app, 1).catch(() => undefined);
    await app.close();
  }
});

test("after a force quit, the next launch offers the unsaved document and restores it", async () => {
  const userData = freshDir("profile-crash");
  const marker = `// unsaved work ${Date.now()}`;
  const first = await launch(userData);
  await setCode(first.page, `${CODE}${marker}\n`);
  expect(await exec(first.page, "file.flushRecovery")).toMatchObject({ ok: true, value: { written: true } });
  const recoveryDir = join(userData, "Recovery");
  expect(readdirSync(recoveryDir).filter((n) => n.endsWith(".partzero"))).toHaveLength(1);
  expect(existsSync(join(recoveryDir, "session.json"))).toBe(true);
  // Force quit: no close events, no clean shutdown.
  first.app.process().kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 1500));

  const { app, page } = await launch(userData);
  try {
    const dialog = page.getByTestId("recovery-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("did not quit normally");
    await expect(page.getByTestId("recovery-item")).toHaveCount(1);
    await shot(page, "recovery");
    await page.getByTestId("recovery-restore").click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as AW).__aicad.idle())).dirty).toBe(true);
    await expect(page.locator(".monaco-editor .view-lines")).toContainText(marker.slice(3));
    // The old snapshot is gone; this window's own autosave takes over.
    expect(await exec(page, "file.flushRecovery")).toMatchObject({ ok: true, value: { written: true } });
    const left = readdirSync(recoveryDir).filter((n) => n.endsWith(".partzero"));
    expect(left).toHaveLength(1);
    // Nothing else to offer (a window's own autosave is never offered).
    expect(await exec(page, "file.recover")).toMatchObject({ ok: true, value: { entries: 0 } });
    await answerClosePrompt(app, 1);
  } finally {
    await app.close();
  }
  // A clean quit ("Don't Save") leaves no snapshot and no session marker.
  expect(readdirSync(recoveryDir).filter((n) => n.endsWith(".partzero"))).toEqual([]);
  expect(existsSync(join(recoveryDir, "session.json"))).toBe(false);
});

test("a renderer crash reloads the window and offers its last autosave", async () => {
  const userData = freshDir("profile-renderer-crash");
  const marker = `// before the renderer crash ${Date.now()}`;
  const { app, page } = await launch(userData, { AICAD_SKIP_CLOSE_PROMPT: "1" });
  try {
    await setCode(page, `${CODE}${marker}\n`);
    expect(await exec(page, "file.flushRecovery")).toMatchObject({ ok: true, value: { written: true } });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer());
    // Driven through the main process: Playwright's page object does not survive a renderer crash. A script sent to the
    // dead renderer never answers, so each call gives up after 2 s (and the poll tries again).
    const inWindow = <T>(script: string): Promise<T> =>
      app.evaluate(
        ({ BrowserWindow }, s) =>
          Promise.race([BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(s), new Promise((_, reject) => setTimeout(() => reject(new Error("no answer")), 2000))]),
        script,
      ) as Promise<T>;
    await expect.poll(() => inWindow<boolean>("document.querySelector('[data-testid=\"recovery-dialog\"]') !== null").catch(() => false), { timeout: 60_000 }).toBe(true);
    await inWindow("document.querySelector('[data-testid=\"recovery-restore\"]').click()");
    await expect
      .poll(() => inWindow<string>("window.__aicad.execute({ id: 'file.status', args: {} }).then((r) => JSON.stringify(r.value))").catch(() => ""), { timeout: 30_000 })
      .toContain('"dirty":true');
    // Monaco renders spaces as no-break spaces.
    const source = await inWindow<string>("window.__aicad.idle().then(() => (document.querySelector('.monaco-editor .view-lines')?.textContent ?? '').replace(/\\u00a0/g, ' '))");
    expect(source).toContain(marker.slice(3));
  } finally {
    await app.close();
  }
});

test("closing a window with unsaved changes asks Save / Don't Save / Cancel", async () => {
  const userData = freshDir("profile-prompt");
  const docs = mkdtempSync(join(root, "docs-"));
  const { app, page } = await launch(userData);
  try {
    await setCode(page, `${CODE}// dirty\n`);
    // Cancel: the window stays.
    await answerClosePrompt(app, 2);
    expect(await exec(page, "file.close")).toMatchObject({ ok: true });
    await expect.poll(() => app.evaluate(() => (globalThis as { __prompts?: string[] }).__prompts?.length ?? 0)).toBe(1);
    expect(await windowCount(app)).toBe(1);
    const prompts = await app.evaluate(() => (globalThis as { __prompts?: string[] }).__prompts);
    expect(prompts?.[0]).toMatch(/Do you want to save the changes you made to “untitled”\?/);

    // Save: the Save As dialog, then the window closes.
    const file = join(docs, "closing.partzero");
    await answerSave(app, file);
    await answerClosePrompt(app, 0);
    const closed = app.evaluate(({ BrowserWindow }) => new Promise<boolean>((resolve) => BrowserWindow.getAllWindows()[0]!.once("closed", () => resolve(true))));
    await exec(page, "file.close").catch(() => undefined);
    expect(await closed).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(readPartZero(readFileSync(file)).code).toContain("// dirty");
    // Closing saved documents leaves no autosave behind.
    expect(readdirSync(join(userData, "Recovery")).filter((n) => n.endsWith(".partzero"))).toEqual([]);
  } finally {
    await app.close();
  }
});

test("quitting with two unsaved windows asks for each, then quits cleanly", async () => {
  const userData = freshDir("profile-quit");
  const { app, page } = await launch(userData);
  await setCode(page, `${CODE}// first window\n`);
  const next = app.waitForEvent("window");
  expect(await exec(page, "file.new")).toMatchObject({ ok: true, value: { placement: "new" } });
  const page2 = await next;
  await ready(page2);
  await setCode(page2, `${CODE}// second window\n`);
  // Answer "Don't Save", and log every prompt to a file (the app is gone when the test reads it).
  const log = join(userData, "prompts.log");
  await app.evaluate(({ dialog }, file) => {
    const fs = process.getBuiltinModule("node:fs");
    dialog.showMessageBox = ((_w: unknown, o: { message: string }) => {
      fs.appendFileSync(file, `${o.message}\n`);
      return Promise.resolve({ response: 1, checkboxChecked: false });
    }) as unknown as typeof dialog.showMessageBox;
  }, log);
  // Playwright's close() quits the app: it returns only once both prompts were answered and the app exited.
  await app.close();
  const asked = readFileSync(log, "utf8").trim().split("\n");
  expect(asked).toHaveLength(2);
  for (const m of asked) expect(m).toMatch(/Do you want to save the changes you made to “untitled”\?/);
  expect(existsSync(join(userData, "Recovery", "session.json"))).toBe(false);
  expect(readdirSync(join(userData, "Recovery")).filter((n) => n.endsWith(".partzero"))).toEqual([]);
});

test("several windows: New opens another window; opening a document that is open focuses its window; Finder double-click", async () => {
  const userData = freshDir("profile-windows");
  const docs = mkdtempSync(join(root, "docs-"));
  const file = join(docs, "shared.partzero");
  const { app, page } = await launch(userData, { AICAD_SKIP_CLOSE_PROMPT: "1" });
  try {
    await setCode(page, CODE);
    await answerSave(app, file);
    expect(await exec(page, "file.saveAs")).toMatchObject({ ok: true });
    // The window has a saved document: New opens a second window with an untitled one.
    const next = app.waitForEvent("window");
    expect(await exec(page, "file.new")).toMatchObject({ ok: true, value: { created: true, placement: "new" } });
    const page2 = await next;
    await ready(page2);
    expect(await windowCount(app)).toBe(2);
    expect(await page2.evaluate(() => (window as unknown as AW).__aicad.summary())).toMatchObject({ name: "untitled", path: null, dirty: false });
    // Opening the file that the first window has: that window comes to the front, nothing new opens.
    await answerOpen(app, file);
    expect(await exec(page2, "file.open")).toMatchObject({ ok: true, value: { opened: true, placement: "existing" } });
    expect(await windowCount(app)).toBe(2);
    expect((await page2.evaluate(() => (window as unknown as AW).__aicad.summary())).path).toBeNull();
    // Each window keeps its own document and its own title.
    const titles = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).sort());
    expect(titles[0]).toMatch(/^shared — /);
    expect(titles[1]).toMatch(/^untitled — /);

    // A .partzero double-clicked in the Finder (`open-file`) opens in the pristine second window.
    const other = join(docs, "other.partzero");
    writeFileSync(other, readFileSync(file));
    await app.evaluate(({ app: electronApp }, p) => {
      electronApp.emit("open-file", { preventDefault: () => undefined }, p);
    }, other);
    await expect.poll(async () => (await page2.evaluate(() => (window as unknown as AW).__aicad.summary())).path).toBe(other);
    expect(await windowCount(app)).toBe(2);
  } finally {
    await app.close();
  }
});

test("an STL imported as a reference is shown, measured, saved inside the .partzero and restored", async () => {
  const userData = freshDir("profile-reference");
  const docs = mkdtempSync(join(root, "docs-"));
  const stl = join(docs, "bracket.stl");
  // A closed 20 × 10 × 5 mm box.
  writeFileSync(stl, boxStl(20, 10, 5));
  const file = join(docs, "with-reference.partzero");
  const { app, page } = await launch(userData, { AICAD_SKIP_CLOSE_PROMPT: "1" });
  try {
    await answerOpen(app, stl);
    const r = await exec(page, "file.importReference");
    expect(r).toMatchObject({ ok: true, value: { imported: true, id: "ref1", measure: { triangles: 12, closed: true } } });
    expect((r.value as { measure: { volume: number } }).measure.volume).toBeCloseTo(1000, 3);
    await expect(page.getByTestId("references-panel")).toBeVisible();
    await expect(page.getByTestId("reference-item")).toHaveCount(1);
    await expect(page.getByTestId("reference-size")).toHaveText("20 × 10 × 5 mm");
    await page.locator('[data-testid="reference-item"] .pz-ref-name').click();
    await expect(page.getByTestId("reference-item")).toContainText("1,000 mm³");
    await shot(page, "reference");
    // The document now has unsaved changes (the reference), shown in the app and the window title.
    await expect(page.getByTestId("doc-title").locator(".dirty-dot")).toBeVisible();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle())).toMatch(/ • — /);
    await answerSave(app, file);
    expect(await exec(page, "file.save")).toMatchObject({ ok: true, value: { saved: true, format: "partzero" } });
    const saved = readPartZero(readFileSync(file));
    expect(saved.manifest.references).toEqual([expect.objectContaining({ id: "ref1", name: "bracket", format: "stl", visible: true })]);
    expect(saved.files.get(saved.manifest.references[0]!.blob)!.equals(readFileSync(stl))).toBe(true);
    // Hide it: the panel keeps it, the viewport does not draw it.
    await page.getByRole("button", { name: "Hide bracket" }).click();
    expect(((await exec(page, "file.status")).value as { references: Array<{ visible: boolean }> }).references[0]!.visible).toBe(false);
  } finally {
    await app.close();
  }
  const again = await launch(userData, { AICAD_SKIP_CLOSE_PROMPT: "1" });
  try {
    // The recent grid shows the saved document with its thumbnail (drawn from the reference mesh).
    expect(await exec(again.page, "file.showRecent")).toMatchObject({ ok: true, value: { count: 1 } });
    await expect(again.page.locator('[data-testid="recent-card"] img.pz-thumb-img')).toHaveCount(1);
    await shot(again.page, "recent");
    await again.page.keyboard.press("Escape");
    await expect(again.page.getByTestId("recent-dialog")).toBeHidden();
    await answerOpen(again.app, file);
    expect(await exec(again.page, "file.open")).toMatchObject({ ok: true, value: { placement: "here" } });
    await expect(again.page.getByTestId("reference-size")).toHaveText("20 × 10 × 5 mm");
    expect(((await exec(again.page, "file.status")).value as { dirty: boolean }).dirty).toBe(false);
  } finally {
    await again.app.close();
  }
});

test("the export dialog lists 3MF, STL, OBJ and a STEP placeholder", async () => {
  const userData = freshDir("profile-export");
  const { app, page } = await launch(userData, { AICAD_SKIP_CLOSE_PROMPT: "1" });
  try {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+E" : "Control+E");
    const dialog = page.getByTestId("export-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("export-format")).toHaveCount(4);
    await expect(page.locator('[data-testid="export-format"][data-format="step"]')).toContainText("Coming with Forge's own STEP writer");
    await shot(page, "export");
    await page.locator('[data-testid="export-format"][data-format="step"] input').check();
    await expect(page.getByTestId("export-run")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  } finally {
    await app.close();
  }
});
