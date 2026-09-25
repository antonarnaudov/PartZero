/**
 * The PartZero shell end to end (FULL-MODELING-PLAN §2.5 layout, ALPHA-0-PLAN W2 first run), on the built app with a
 * fresh profile, a fake Claude Code (`fake-cli.ts`: no network, no key) and a fake Bambu Studio `.app`:
 *
 * - Branding: the page title, the toolbar, About and the welcome screen say PartZero; no "aicad" in the UI chrome.
 * - First run: a new document is empty and the welcome screen shows New, Open, Recent, the five starter parts,
 *   Claude Code's status (ready, then log-in-needed with Re-check), the printer and Bambu Studio, and the build.
 * - The tool ribbon comes from the tool registry: groups, shortcuts, disabled reasons, the group menu.
 * - The property panel framework: a tool registered at run time opens a panel with typed fields (a number with
 *   units and expressions, a selection input with its count, a choice, a toggle), live preview, inline errors with
 *   the feasible range and a one-click fix, OK as one undoable transaction (the tool's ops, applied to the document
 *   as it is at OK time), Cancel leaving nothing behind. A slow preview never outlives its panel, OK waits for the
 *   check of the values it commits, an edit made while the panel is open is kept, and an open inspect panel
 *   follows undo.
 * - Keyboard: tool shortcuts, Esc and Enter, Space repeats the last tool, ⌘K and ⌘⇧P open the palette (which
 *   lists tools), `?` opens the shortcuts map; the mode (model/sketch) decides which tools show.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { appDir } from "./app-dir.js";
import { makeFakeClaude, type FakeClaude } from "./fake-cli.js";
import { screenshotPath } from "./screenshots.js";

let app: ElectronApplication;
let page: Page;
let root: string;
let fake: FakeClaude;
const pageErrors: string[] = [];
const mod = process.platform === "darwin" ? "Meta" : "Control";

test.skip(process.platform === "win32", "the fake CLI is a POSIX script");

/** The environment without any provider key or CLI token: this suite must never reach a real model. */
function keylessEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /(API_?KEY|TOKEN|SECRET)/i.test(k) || /^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|CLAUDE_CODE|CODEX|CURSOR)_/.test(k) || k.startsWith("AICAD_")) continue;
    env[k] = v;
  }
  return { ...env, AICAD_AGENT_DOTENV: "off", AICAD_SKIP_CLOSE_PROMPT: "1", ...extra };
}

interface Automation {
  execute(cmd: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;
  idle(): Promise<{ features: Array<{ name: string; status: string | null }>; bodies: unknown[]; dirty: boolean }>;
}

/** What a test tool's `activate` uses of the tool context (packages/app/src/tools/framework/types.ts). */
interface TestToolContext {
  services: {
    doc: { getState(): { model: { ir: unknown } | null; source: string }; idle(): Promise<unknown> };
    engines: { active: { evaluate(irJson: string): Promise<{ report: { features: unknown[] }; bodies: unknown[] }> } };
  };
  document: { feature(idOrName: string): { id: string; json: Record<string, unknown> } | null };
  openPanel(spec: unknown): unknown;
}

type PanelValues = Record<string, unknown>;

interface TestTool {
  id: string;
  label: string;
  group: string;
  icon: string;
  shortcut?: string;
  modes?: string[];
  activate(ctx: TestToolContext): unknown;
}

/** The shell's automation hook (packages/app/src/ui/shell/install.ts), as this suite uses it. */
interface ShellHook {
  registerTool(def: TestTool): () => void;
  setMode(mode: "model" | "sketch"): void;
  /** Runs app and shell commands (`help.welcome` is a shell command until the integrator merges them). */
  execute(cmd: { id: string; args?: unknown }): Promise<unknown>;
}

/** `window` with the automation hooks of a development run (cast: other suites type `__aicad` their own way). */
interface PW {
  __aicad: Automation;
  __partzero: ShellHook;
}

/** The demo thickness tool leaves its context here, so a test can read the source as the tool sees it. */
interface TestWindow extends PW {
  __pzThicknessCtx?: TestToolContext;
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pz-e2e-shell-"));
  fake = makeFakeClaude(join(root, "fake"), { loggedIn: true });
  const userData = join(root, "profile");
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, "agent-settings.json"), JSON.stringify({ v: 1, models: {}, budgetUsd: 1, compatBaseUrl: null, ollamaBaseUrl: "http://127.0.0.1:9" }));
  const apps = join(root, "Applications");
  const fakeSlicer = join(apps, "BambuStudio.app");
  mkdirSync(join(fakeSlicer, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(fakeSlicer, "Contents", "Info.plist"),
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
});

test.afterAll(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("first run: an empty part under the PartZero welcome screen with the agent, printer and build status", async () => {
  expect(await page.title()).toBe("PartZero");
  await expect(page.getByTestId("brand")).toHaveText("PartZero");
  const welcome = page.getByTestId("welcome");
  await expect(welcome).toBeVisible();
  await expect(welcome.getByRole("heading", { name: "PartZero" })).toBeVisible();
  // The new document is empty (no starter block).
  const doc = await page.evaluate(() => (window as unknown as PW).__aicad.idle());
  expect(doc.features).toEqual([]);
  expect(doc.bodies).toEqual([]);
  // Five starter chips, the two with ready-made examples say why they cannot open in an IR v0 app.
  await expect(welcome.getByTestId("welcome-starter")).toHaveCount(5);
  await expect(welcome.locator('[data-starter="p5-electronics-box"]')).toContainText("Electronics box with a lid");
  await expect(welcome.getByTestId("starter-ask")).toHaveCount(5);
  // The fake Claude Code 2.1.260, logged in on a Max plan.
  const provider = welcome.getByTestId("welcome-provider");
  await expect(provider).toContainText("Using Claude Code (your plan) · ready", { timeout: 30_000 });
  await expect(provider).toContainText("Claude Code 2.1.260");
  await expect(provider).toContainText("Max plan");
  await expect(provider).toHaveAttribute("data-tone", "ok");
  const printer = welcome.getByTestId("welcome-printer");
  await expect(printer).toContainText("Printer: Bambu Lab P2S · 0.4 mm · PLA");
  await expect(printer).toContainText("Bambu Studio 02.06.00.51");
  await expect(welcome.getByTestId("welcome-build")).toContainText(/PartZero v\d+\.\d+\.\d+/);
  await page.screenshot({ path: screenshotPath("shell-welcome.png", "PZ_E2E_WELCOME_SCREENSHOT") });
});

test("no 'aicad' in the window's chrome", async () => {
  const chrome = await page.evaluate(() => {
    const parts = [".titlebar", ".ribbon", ".statusbar", ".welcome", ".dock-left"].map((s) => document.querySelector(s)?.textContent ?? "");
    return parts.join("\n");
  });
  expect(chrome).not.toMatch(/aicad/i);
  await page.evaluate(() => (window as unknown as PW).__aicad.execute({ id: "help.about" }));
  const about = page.getByRole("dialog", { name: "About PartZero" });
  await expect(about).toBeVisible();
  await expect(about).toContainText("PartZero");
  await expect(about).toContainText("Claude Code");
  await expect(about).toContainText("v2.1.260");
  const aboutText = (await about.textContent()) ?? "";
  expect(aboutText.replace(/@aicad\/app build/g, "")).not.toMatch(/\baicad\b/i);
  await page.keyboard.press("Escape");
  await expect(about).toBeHidden();
});

test("the welcome screen: log-in-needed with Re-check, close, Help → Welcome, Esc", async () => {
  fake.setLoggedIn(false);
  const welcome = page.getByTestId("welcome");
  // Ask for a fresh probe through the command layer (as the Re-check button does).
  await page.evaluate(() => (window as unknown as PW).__aicad.execute({ id: "settings.probeProviders", args: { providers: ["claude-cli"] } }));
  const provider = welcome.getByTestId("welcome-provider");
  await expect(provider).toContainText("Claude Code needs a login");
  await expect(provider).toContainText("claude auth login");
  fake.setLoggedIn(true);
  await provider.getByTestId("welcome-recheck").click();
  await expect(provider).toContainText("Using Claude Code (your plan) · ready");

  await welcome.getByTestId("welcome-close").click();
  await expect(welcome).toBeHidden();
  await page.keyboard.press(`${mod}+K`);
  await page.keyboard.type("welcome");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("welcome")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("welcome")).toBeHidden();
  // File → New brings it back for the next blank document.
  await page.evaluate(() => (window as unknown as PW).__aicad.execute({ id: "file.new" }));
  await expect(page.getByTestId("welcome")).toBeVisible();
});

test("the ribbon is built from the tool registry: groups, labels, shortcuts and disabled reasons", async () => {
  const ribbon = page.getByTestId("ribbon");
  const inspect = ribbon.getByTestId("group-inspect");
  await expect(inspect).toBeVisible();
  const props = inspect.getByTestId("tool-inspect.bodyProperties");
  await expect(props).toHaveAttribute("aria-disabled", "true");
  await expect(props).toHaveAttribute("title", /There are no bodies yet/);
  await inspect.getByTestId("group-label-inspect").click();
  const menu = page.getByTestId("group-menu-inspect");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([/Properties\s*⇧I/, /Printer fit/]);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  // A tool registered at run time appears in its group, in toolbar order.
  await page.evaluate(() =>
    (window as unknown as PW).__partzero.registerTool({ id: "test.hello", label: "Hello", group: "create", icon: "box", shortcut: "Shift+H", activate: () => undefined }),
  );
  await expect(ribbon.getByTestId("group-create")).toBeVisible();
  const groups = await ribbon.locator(".rb-group").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(groups).toEqual(["group-sketch", "group-create", "group-inspect"]);
});

test("inspect tools: Forge's exact body properties and the printer fit, in the property panel", async () => {
  await page.evaluate(() => (window as unknown as PW).__aicad.execute({ id: "file.newFromTemplate", args: { templateId: "t1-nema17-plate" } }));
  await page.evaluate(() => (window as unknown as PW).__aicad.idle());
  await expect(page.getByTestId("welcome")).toBeHidden();
  const props = page.getByTestId("tool-inspect.bodyProperties");
  await expect(props).toHaveAttribute("aria-disabled", "false");
  await props.click();
  const panel = page.getByTestId("property-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("dock-tab-properties")).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByTestId("panel-summary")).toContainText("10417.7");
  await expect(panel.getByTestId("panel-summary")).toContainText("50 × 50 × 5 mm");
  await expect(panel.getByTestId("panel-summary")).toContainText("Valid solid");
  await expect(page.getByTestId("status-tool")).toContainText("Body properties");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  // No code view by default: with the panel closed the side column is the assistant's.
  await expect(page.getByTestId("dock-tab-properties")).toHaveCount(0);
  await expect(page.getByTestId("dock-tab-code")).toHaveCount(0);

  await page.getByTestId("tool-inspect.printerFit").click();
  await expect(panel.getByTestId("panel-summary")).toContainText("Bambu Lab P2S");
  await expect(panel.getByTestId("panel-summary")).toContainText("236 × 236 × 256 mm");
  await expect(panel.getByTestId("panel-summary")).toContainText("Yes · room left 186 / 186 / 251 mm");
  await page.getByTestId("panel-ok").click();
  await expect(panel).toBeHidden();
});

test("a property panel: typed fields, units and expressions, feasible range, preview, OK as one undo step", async () => {
  // A demo tool registered at run time, built only on the public contract (tools/framework/types.ts):
  // its preview evaluates the part as it is now with the new thickness, and OK commits one `setField`
  // op, which the shell applies to the document as it is at OK time (one transaction). 7 mm previews
  // slowly, for the checks below.
  await page.evaluate(() => {
    type Ir = { parts: Array<{ features: Array<{ type: string; name: string; distance?: number }> }> };
    (window as unknown as PW).__partzero.registerTool({
      id: "test.thickness",
      label: "Thickness",
      group: "modify",
      icon: "pushPull",
      shortcut: "Shift+T",
      activate: (ctx) => {
        (window as unknown as TestWindow).__pzThicknessCtx = ctx;
        const plate = ctx.document.feature("plate");
        if (!plate) throw new Error("no extrude to edit");
        // Built from the document as it is when called (never a copy taken here).
        const withDistance = (d: number): Ir => {
          const next = structuredClone(ctx.services.doc.getState().model!.ir) as Ir;
          next.parts[0]!.features.find((f) => f.name === "plate")!.distance = d;
          return next;
        };
        return {
          title: "Plate thickness",
          description: "Sets the extrude distance.",
          fields: [
            { kind: "selection", key: "face", label: "Face", accepts: ["face"], min: 0 },
            { kind: "number", key: "d", label: "Thickness", quantity: "length", min: 0, minExclusive: true, max: 20, default: String(plate.json["distance"]) },
            { kind: "choice", key: "side", label: "Direction", options: [{ value: "up", label: "Up" }, { value: "down", label: "Down" }] },
            { kind: "toggle", key: "keep", label: "Keep holes", default: true },
            {
              kind: "choice",
              key: "material",
              label: "Material",
              options: ["PLA", "PETG", "ABS", "PLA-CF", "PETG-CF"].map((m) => ({ value: m.toLowerCase(), label: m })),
            },
          ],
          previewDelayMs: 30,
          preview: async (values: PanelValues) => {
            const d = (values["d"] as { value: number | null }).value;
            if (d === null) return { ok: true };
            if (d > 12) return { ok: false, errors: [{ field: "d", code: "PLATE_TOO_THICK", message: "Thicker than the screws are long.", feasible: { min: 0.5, max: 12 } }] };
            if (d === 7) await new Promise((r) => setTimeout(r, 1500));
            await ctx.services.doc.idle();
            const r = await ctx.services.engines.active.evaluate(JSON.stringify(withDistance(d)));
            const vol = (r.report.features as Array<{ bodies?: Array<{ volume: number }> }>).flatMap((f) => f.bodies ?? []).reduce((s, b) => s + b.volume, 0);
            return { ok: true, summary: [{ label: "Volume", value: `${vol.toFixed(2)} mm³` }], bodies: r.bodies };
          },
          toOps: (values: PanelValues) => [{ op: "setField", feature: plate.id, path: "/distance", value: (values["d"] as { value: number }).value }],
          label: (values: PanelValues) => `Plate ${(values["d"] as { text: string }).text} mm`,
        };
      },
    });
  });
  // Select the top face first: the selection input takes it (selection-first).
  const canvas = page.locator(".viewport-canvas");
  await page.evaluate(() => (window as unknown as PW).__aicad.execute({ id: "selection.selectEntity", args: { body: "plate/plate", face: "plate/cap:end", reveal: false } }));
  await page.keyboard.press("Shift+T");
  const panel = page.getByTestId("property-panel");
  await expect(panel).toHaveAttribute("data-tool", "test.thickness");
  await expect(panel.getByTestId("selection-count-face")).toHaveText("1 face");
  await expect(panel.getByTestId("panel-summary")).toContainText(/Volume\s*10417\.75 mm³/);
  const input = panel.getByTestId("input-d");
  await expect(input).toBeFocused();

  // Units convert; an unknown parameter is named; a bound is explained with the feasible range and a fix.
  await input.fill("0.25 in");
  await expect(panel.locator(".pp-resolved")).toHaveText("= 6.35 mm");
  await input.fill("wall*2");
  await expect(panel.getByTestId("field-error-d")).toContainText("No parameter named “wall”");
  await expect(panel.getByTestId("panel-ok")).toBeDisabled();
  await input.fill("25");
  await expect(panel.getByTestId("field-error-d")).toContainText("Must be at most 20 mm");
  await input.fill("15");
  await expect(panel.getByTestId("field-error-d")).toContainText("Thicker than the screws are long. Builds with 0.5 mm – 12 mm.");
  await expect(panel).toHaveAttribute("data-state", "invalid");
  await panel.getByTestId("use-feasible-d").click();
  await expect(input).toHaveValue("12");
  await expect(panel).toHaveAttribute("data-state", "ready");
  await expect(panel.getByTestId("panel-summary")).toContainText(/Volume\s*25002\.6\d mm³/);
  // The live preview is drawn in the viewport, tinted, instead of the document.
  const viewport = page.getByTestId("viewport");
  await expect(viewport).toHaveAttribute("data-shown", "tool-preview");
  await expect(viewport).toHaveAttribute("data-extent-z", "12.00");
  // Arrow keys step the value; other field kinds.
  await input.press("ArrowDown");
  await expect(input).toHaveValue("11");
  await panel.getByTestId("choice-side-down").click();
  await expect(panel.getByTestId("choice-side-down")).toHaveAttribute("aria-checked", "true");
  await panel.getByTestId("toggle-keep").click();
  await expect(panel.getByTestId("toggle-keep")).toHaveAttribute("aria-checked", "false");
  await panel.getByTestId("input-material").selectOption("petg");
  await expect(panel.getByTestId("input-material")).toHaveValue("petg");
  await page.screenshot({ path: screenshotPath("shell-property-panel.png", "PZ_E2E_PANEL_SCREENSHOT") });

  // Cancel leaves the document untouched, and the viewport shows it again.
  await input.press("Escape");
  await expect(panel).toBeHidden();
  await expect(viewport).toHaveAttribute("data-shown", "current");
  await expect(viewport).toHaveAttribute("data-extent-z", "5.00");
  let s = await page.evaluate(() => (window as unknown as PW).__aicad.idle());
  expect(s.dirty).toBe(false);

  // Space repeats the last tool; Enter from a field is OK: one transaction, one undo step.
  await canvas.click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press("Space");
  await expect(panel).toBeVisible();
  await panel.getByTestId("input-d").fill("8");
  await expect(panel).toHaveAttribute("data-state", "ready");
  await panel.getByTestId("input-d").press("Enter");
  await expect(panel).toBeHidden();
  await expect(page.locator('[data-testid="timeline-feature"][data-feature="plate"] .tl-summary')).toContainText("8 mm");
  s = await page.evaluate(() => (window as unknown as PW).__aicad.idle());
  expect(s.dirty).toBe(true);
  await page.keyboard.press(`${mod}+Z`);
  await expect(page.locator('[data-testid="timeline-feature"][data-feature="plate"] .tl-summary')).toContainText("5 mm");
});

test("a slow preview never outlives its panel, and OK waits for the check of the values it commits", async () => {
  const panel = page.getByTestId("property-panel");
  const viewport = page.getByTestId("viewport");
  const summary = page.locator('[data-testid="timeline-feature"][data-feature="plate"] .tl-summary');
  await page.getByTestId("tool-test.thickness").click();
  await expect(panel).toHaveAttribute("data-state", "ready");
  await expect(viewport).toHaveAttribute("data-shown", "tool-preview");
  // Esc while the (slow) 7 mm preview runs: the viewport shows the document again, and the late preview is dropped.
  await panel.getByTestId("input-d").fill("7");
  await expect(panel).toHaveAttribute("data-state", "previewing");
  await expect(viewport).toHaveAttribute("data-preview-stale", "true");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(viewport).toHaveAttribute("data-shown", "current");
  await page.waitForTimeout(2000);
  await expect(viewport).toHaveAttribute("data-shown", "current");
  await expect(viewport).toHaveAttribute("data-extent-z", "5.00");

  // Enter while the 7 mm check runs: the panel waits for it, then commits 7 mm.
  await page.getByTestId("tool-test.thickness").click();
  await expect(panel).toHaveAttribute("data-state", "ready");
  await panel.getByTestId("input-d").fill("7");
  await panel.getByTestId("input-d").press("Enter");
  await expect(panel).toHaveAttribute("data-pending-commit", "true");
  await expect(panel.getByTestId("panel-state")).toHaveText("Checking, then applying…");
  await expect(summary).toContainText("5 mm");
  await expect(panel).toBeHidden({ timeout: 10_000 });
  await expect(summary).toContainText("7 mm");
  await page.keyboard.press(`${mod}+Z`);
  await expect(summary).toContainText("5 mm");
});

test("an edit made while a panel is open is kept by OK, and an open inspect panel follows undo", async () => {
  const panel = page.getByTestId("property-panel");
  const summary = page.locator('[data-testid="timeline-feature"][data-feature="plate"] .tl-summary');
  const source = (): Promise<string> => page.evaluate(() => (window as unknown as TestWindow).__pzThicknessCtx!.services.doc.getState().source);
  await page.getByTestId("tool-test.thickness").click();
  await panel.getByTestId("input-d").fill("8");
  await expect(panel).toHaveAttribute("data-state", "ready");
  // Meanwhile the model changes, as another command or the agent would: a smaller pilot hole (an op on
  // the IR v1 model, which is the document).
  const edited = await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    const doc = JSON.parse(w.__pzThicknessCtx!.services.doc.getState().source) as { parts: Array<{ features: Array<{ id: string; curves?: Array<{ id: string }> }> }> };
    const sketch = doc.parts[0]!.features.find((f) => f.curves?.some((c) => c.id === "pilot"))!;
    const i = sketch.curves!.findIndex((c) => c.id === "pilot");
    return w.__aicad.execute({ id: "ir.setField", args: { feature: sketch.id, path: `/curves/${i}/radius`, value: 10 } });
  });
  expect(edited.ok).toBe(true);
  // The panel checks again against the changed part; OK then changes only the thickness.
  await expect(panel).toHaveAttribute("data-state", "ready");
  await panel.getByTestId("input-d").press("Enter");
  await expect(panel).toBeHidden();
  await expect(summary).toContainText("8 mm");
  const after = await source();
  expect(after).toMatch(/"id": "pilot",[^}]*"radius": 10(\.0)?\b/);
  expect(after).toMatch(/"distance": 8(\.0)?\b/);

  // Body properties stays open across an undo and shows the part as it is now.
  await page.getByTestId("tool-inspect.bodyProperties").click();
  const props = panel.getByTestId("panel-summary");
  await expect(props).toContainText("50 × 50 × 8 mm");
  await page.evaluate(() => (window as unknown as PW).__aicad.execute({ id: "edit.undo" }));
  await expect(props).toContainText("50 × 50 × 5 mm");
  // 5 × (50² − π·10² − 4·π·1.7²) mm³: the 10 mm pilot is still there.
  await expect(props).toContainText("10747.6");
  await expect(panel).toHaveAttribute("data-tool", "inspect.bodyProperties");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await page.evaluate(() => (window as unknown as PW).__aicad.execute({ id: "edit.undo" }));
  expect(await source()).toMatch(/"id": "pilot",[^}]*"radius": 11(\.0)?\b/);
});

test("keyboard: ⌘K and ⌘⇧P list tools, `?` opens the shortcuts map, the mode picks the tools", async () => {
  await page.keyboard.press(`${mod}+Shift+P`);
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await page.keyboard.type("printer fit");
  await expect(palette.locator('.pal-item[data-key="tool:inspect.printerFit"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("property-panel")).toHaveAttribute("data-tool", "inspect.printerFit");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("property-panel")).toBeHidden();

  await page.keyboard.press("Shift+?");
  const map = page.getByTestId("shortcuts-dialog");
  await expect(map).toBeVisible();
  await expect(map.getByTestId("shortcuts-tools-inspect")).toContainText("Properties");
  await expect(map.getByTestId("shortcuts-tools-inspect")).toContainText("⇧I");
  await expect(map.getByTestId("shortcuts-view")).toContainText("Command Palette");
  await expect(map.getByTestId("shortcuts-panel")).toContainText("OK: apply the change and close");
  await expect(map.getByTestId("shortcuts-navigation")).toContainText("Orbit");
  await page.keyboard.press("Escape");
  await expect(map).toBeHidden();

  // Sketch mode: only sketch tools (and their keys) are offered.
  await page.evaluate(() => {
    (window as unknown as PW).__partzero.registerTool({ id: "test.line", label: "Line", group: "sketch", icon: "line", shortcut: "L", modes: ["sketch"], activate: (ctx) => void ctx.openPanel({ title: "Line", readOnly: true, fields: [] }) });
    (window as unknown as PW).__partzero.setMode("sketch");
  });
  await expect(page.getByTestId("mode-badge")).toBeVisible();
  await expect(page.getByTestId("group-inspect")).toBeHidden();
  await expect(page.getByTestId("status-mode")).toHaveText("Sketch");
  await page.keyboard.press("l");
  await expect(page.getByTestId("property-panel")).toHaveAttribute("data-tool", "test.line");
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window as unknown as PW).__partzero.setMode("model"));
  await expect(page.getByTestId("group-inspect")).toBeVisible();
  await page.keyboard.press("l");
  await expect(page.getByTestId("property-panel")).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test("the light theme: welcome and a tool panel (review screenshots)", async () => {
  await page.evaluate(() => (window as unknown as PW).__aicad.execute({ id: "view.setTheme", args: { theme: "light" } }));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.evaluate(() => (window as unknown as PW).__aicad.execute({ id: "file.newFromTemplate", args: { templateId: "t1-nema17-plate" } }));
  await page.evaluate(() => (window as unknown as PW).__aicad.idle());
  await page.getByTestId("tool-inspect.bodyProperties").click();
  await expect(page.getByTestId("panel-summary")).toBeVisible();
  await page.screenshot({ path: screenshotPath("shell-panel-light.png", "PZ_E2E_PANEL_LIGHT_SCREENSHOT") });
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window as unknown as PW).__partzero.execute({ id: "help.welcome" }));
  await expect(page.getByTestId("welcome")).toBeVisible();
  await page.screenshot({ path: screenshotPath("shell-welcome-light.png", "PZ_E2E_WELCOME_LIGHT_SCREENSHOT") });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("welcome")).toBeHidden();
  await page.evaluate(() => (window as unknown as PW).__aicad.execute({ id: "view.setTheme", args: { theme: "dark" } }));
});

test("a starter chip sends its prompt to the design agent", async () => {
  await page.evaluate(() => (window as unknown as PW).__aicad.execute({ id: "file.new" }));
  const welcome = page.getByTestId("welcome");
  await expect(welcome).toBeVisible();
  const prompt = await page.evaluate(() => (document.querySelector('[data-starter="p4-knob"] [data-testid="starter-ask"]') as HTMLElement).title);
  expect(prompt).toContain("D-shaft");
  // No live run: stop the fake agent as soon as it starts.
  await welcome.locator('[data-starter="p4-knob"]').getByTestId("starter-ask").click();
  await expect(page.locator(".msg-user").last()).toContainText("A knob for a potentiometer with a 6 mm D-shaft");
  await page.evaluate(() => (window as unknown as PW).__aicad.execute({ id: "agent.stop" }));
});
