/**
 * "Open in Bambu Studio" end to end (ALPHA-0-PLAN W5; G2a a3/a8 with a fake `open`): the toolbar
 * button checks the part with Forge, writes `<doc>-<hash8>.3mf` and its receipt into the prints
 * folder of the test profile, and runs `open -a <BambuStudio.app> <file>`. A wrong Bambu Studio
 * path in Settings falls back to a plain export with Show in Finder.
 *
 * The test profile never sees the real Bambu Studio or `~/PartZero/Prints` (env.ts): the slicer is
 * a fake `.app` in a temp folder (`AICAD_SLICER_DIRS`) and `open` is a script that records its
 * arguments (`AICAD_OPEN_BIN`). macOS only, like the handoff.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PrintProfileView, SlicerInfo } from "@aicad/app/bridge";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test.skip(process.platform !== "darwin", "the Bambu Studio handoff is macOS-only in Alpha 0");

let app: ElectronApplication;
let page: Page;
let root: string;
let userData: string;
let fakeApp: string;
let openLog: string;

interface PrintApi {
  profile(): Promise<PrintProfileView>;
  detectSlicer(): Promise<SlicerInfo>;
  setSlicerPath(path: string | null): Promise<SlicerInfo>;
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "aicad-e2e-print-"));
  userData = join(root, "profile");
  const apps = join(root, "Applications");
  fakeApp = join(apps, "BambuStudio.app");
  mkdirSync(join(fakeApp, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(fakeApp, "Contents", "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>CFBundleIdentifier</key>\n  <string>com.bambulab.bambu-studio</string>\n  <key>CFBundleShortVersionString</key>\n  <string>02.06.00.51</string>\n</dict>\n</plist>\n',
  );
  openLog = join(root, "open-args.txt");
  const openBin = join(root, "fake-open");
  writeFileSync(openBin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${openLog}"\nexit 0\n`);
  chmodSync(openBin, 0o755);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$/.test(k)) env[k] = v;
  app = await electron.launch({
    args: [desktopRoot, "--use-mock-keychain"],
    env: { ...env, AICAD_USER_DATA_DIR: userData, AICAD_SKIP_CLOSE_PROMPT: "1", AICAD_AGENT_DOTENV: "off", AICAD_SLICER_DIRS: apps, AICAD_OPEN_BIN: openBin },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1480, height: 920 }));
});

test.afterAll(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the shell reports the built-in P2S profile and finds the (fake) Bambu Studio", async () => {
  const profile = await page.evaluate(() => (window as unknown as { aicad: { print: PrintApi } }).aicad.print.profile());
  expect(profile.summary).toBe("Bambu Lab P2S · 0.4 mm · PLA");
  expect(profile.printer.bed).toEqual({ x: 256, y: 256, z: 256 });
  expect(profile.printsDir).toBe(join(userData, "Prints"));
  const slicer = await page.evaluate(() => (window as unknown as { aicad: { print: PrintApi } }).aicad.print.detectSlicer());
  expect(slicer).toMatchObject({ found: true, path: fakeApp, version: "02.06.00.51", source: "applications" });
});

test("Open in Bambu Studio saves the checked, centred 3MF with its receipt and opens it", async () => {
  await page.getByRole("button", { name: "New from template" }).click();
  await page.getByLabel("Search templates").fill("nema 17");
  await page.locator('[data-template="t1-nema17-plate"]').click();
  await expect(page.getByTestId("problems-count")).toHaveText("0");

  await page.getByTestId("open-in-slicer").click();
  const toast = page.getByTestId("toasts").locator(".toast").last();
  await expect(toast).toContainText(/Opened t1-nema17-plate-[0-9a-f]{8}\.3mf in Bambu Studio/);
  await expect(toast.getByRole("button", { name: "Show in Finder" })).toBeVisible();

  const prints = join(userData, "Prints");
  const files = readdirSync(prints).sort();
  expect(files).toHaveLength(2);
  const [threeMf, receipt] = [files.find((f) => f.endsWith(".3mf"))!, files.find((f) => f.endsWith(".receipt.json"))!];
  expect(threeMf).toMatch(/^t1-nema17-plate-[0-9a-f]{8}\.3mf$/);
  expect(readFileSync(join(prints, threeMf)).subarray(0, 2).toString("latin1")).toBe("PK");
  const r = JSON.parse(readFileSync(join(prints, receipt), "utf8"));
  expect(r).toMatchObject({ schema: "partzero.receipt/1", file: threeMf, printer: { id: "builtin:bambu-p2s-0.4" }, material: { id: "builtin:pla" }, checks: { report: "ok", valid: true, watertight: true, bodies: 1 } });
  expect((r.bbox.onBed.min[0] + r.bbox.onBed.max[0]) / 2).toBeCloseTo(128, 6);
  expect((r.bbox.onBed.min[1] + r.bbox.onBed.max[1]) / 2).toBeCloseTo(128, 6);
  expect(r.bbox.onBed.min[2]).toBe(0);
  // The launcher ran `open -a <app> <file>` (no shell), with the file in the prints folder.
  expect(readFileSync(openLog, "utf8").split("\n").filter(Boolean)).toEqual(["-a", fakeApp, join(prints, threeMf)]);
});

test("a wrong Bambu Studio path falls back to a plain export with Show in Finder (a8)", async () => {
  rmSync(openLog, { force: true });
  const missing = join(root, "Nowhere", "BambuStudio.app");
  const set = await page.evaluate((p) => (window as unknown as { aicad: { print: PrintApi } }).aicad.print.setSlicerPath(p), missing);
  expect(set).toMatchObject({ found: false, customPath: missing });
  await page.getByTestId("open-in-slicer").click();
  const toast = page.getByTestId("toasts").locator(".toast").last();
  await expect(toast).toContainText(`Saved to ${join(userData, "Prints")}. Bambu Studio isn't at ${missing}`);
  await expect(toast.getByRole("button", { name: "Show in Finder" })).toBeVisible();
  expect(existsSync(openLog)).toBe(false); // nothing launched
  // Clearing the path searches again.
  const cleared = await page.evaluate(() => (window as unknown as { aicad: { print: PrintApi } }).aicad.print.setSlicerPath(null));
  expect(cleared).toMatchObject({ found: true, path: fakeApp, customPath: null });
});

test("Settings → Printing shows the profile and the Bambu Studio in use, and takes a path", async () => {
  await page.getByTestId("toolbar").getByRole("button", { name: "Settings" }).click();
  const section = page.getByTestId("settings-printing");
  await expect(section).toContainText("Bambu Lab P2S · 0.4 mm · PLA");
  await expect(section).toContainText("parts must fit 236 × 236 mm");
  await expect(section).toContainText("not yet checked on your printer");
  const row = page.getByTestId("settings-slicer");
  await expect(row).toHaveAttribute("data-found", "true");
  await expect(row).toContainText("02.06.00.51");
  await expect(row).toContainText(fakeApp);
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: join(desktopRoot, "test-results", "settings-printing.png") });
  // A path that isn't there: "not found", with the fix.
  await row.getByRole("button", { name: "Change…" }).click();
  const missing = join(root, "Elsewhere", "BambuStudio.app");
  await row.getByLabel("Bambu Studio path").fill(missing);
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row).toHaveAttribute("data-found", "false");
  await expect(row).toContainText(`Bambu Studio isn't at ${missing}`);
  await row.getByRole("button", { name: "Change…" }).click();
  await row.getByRole("button", { name: "Use automatic" }).click();
  await expect(row).toHaveAttribute("data-found", "true");
  await page.keyboard.press("Escape");
});
