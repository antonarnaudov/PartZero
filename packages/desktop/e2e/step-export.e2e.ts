/**
 * STEP export end to end in the running desktop app (IO stream): the renderer calls
 * `window.aicad.forge.exportStep` (the channel the export dialog's hook, `@aicad/app`
 * `io/step-export.ts`, uses), the main process runs the bundled `aicad export --format step`, and
 * the bytes and the `aicad.export/1` summary come back. The file is then written through the
 * normal save grant (`fs:write` after a save dialog) — here to a temp path granted by a stubbed
 * dialog — and read back as STEP.
 *
 * The last test runs the user's path: File ▸ Export ▸ STEP… (the `file.exportStep` command,
 * `@aicad/app` `io/step-export-command.ts`) on an IR v1 document. The command layer belongs to the
 * IR v1 Phase C work, so until the integrator registers the command (one entry in `commands.ts`,
 * one menu line) that test is skipped and says so; nothing else changes when it lands.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { ForgeStepExportRequest, ForgeStepExportResponse } from "@aicad/app/bridge";
import { appDir, desktopRoot } from "./app-dir.js";

const repo = join(desktopRoot, "..", "..");
const program = (name: string): string => readFileSync(join(repo, "corpus", "programs", name), "utf8");
const V1_PROGRAM = join(repo, "corpus", "v1", "programs", "params_plate.json");

/** `window.__aicad` as this suite uses it. */
interface Automation {
  execute(cmd: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;
  describe(): Promise<Array<{ id: string }>> | Array<{ id: string }>;
  idle(): Promise<unknown>;
}

interface StepApi {
  exportStep?(r: ForgeStepExportRequest): Promise<ForgeStepExportResponse>;
}

let app: ElectronApplication;
let page: Page;
let root: string;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "aicad-e2e-step-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$/.test(k)) env[k] = v;
  app = await electron.launch({
    args: [appDir, "--use-mock-keychain"],
    env: { ...env, AICAD_USER_DATA_DIR: join(root, "profile"), AICAD_SKIP_CLOSE_PROMPT: "1", AICAD_AGENT_DOTENV: "off" },
  });
  page = await app.firstWindow();
  await expect(page.getByTestId("app-shell")).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the renderer exports a STEP file through the bundled Forge CLI and writes it", async () => {
  const irJson = program("revolve_cone_sphere.json");
  const res = await page.evaluate(
    async (req) => {
      const forge = (window as unknown as { aicad: { forge: StepApi } }).aicad.forge;
      if (typeof forge.exportStep !== "function") return { missing: true } as const;
      const r = await forge.exportStep(req);
      return {
        missing: false,
        exitCode: r.exitCode,
        stderr: r.stderr,
        error: r.error ?? null,
        head: r.data ? new TextDecoder().decode(r.data.slice(0, 64)) : null,
        text: r.data ? new TextDecoder().decode(r.data) : "",
        summary: r.summary as { format: string; bodies: Array<{ name: string; step: { seamEdges: number } }> },
      } as const;
    },
    { irJson, productName: "cone and sphere", schema: "ap214" as const },
  );
  expect(res.missing).toBe(false);
  if (res.missing) return;
  expect(res.error, res.stderr).toBeNull();
  expect(res.exitCode, res.stderr).toBe(0);
  expect(res.head).toMatch(/^ISO-10303-21;/);
  expect(res.text).toContain("PRODUCT('cone and sphere','cone and sphere'");
  expect(res.text).toContain("SPHERICAL_SURFACE");
  expect(res.text).toContain("CONICAL_SURFACE");
  expect(res.summary.format).toBe("step");
  expect(res.summary.bodies).toHaveLength(1);
  expect(res.summary.bodies[0]?.step.seamEdges).toBe(2);

  // The user's save dialog grants the path; the renderer writes the bytes there.
  const target = join(root, "cone-sphere.step");
  await app.evaluate(({ dialog }, path) => {
    (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = () =>
      Promise.resolve({ canceled: false, filePath: path });
  }, target);
  await page.evaluate(
    async ({ req, path }) => {
      const aicad = (window as unknown as {
        aicad: {
          forge: StepApi;
          showSaveDialog(o: unknown): Promise<string | null>;
          writeFile(p: string, d: Uint8Array): Promise<void>;
        };
      }).aicad;
      const picked = await aicad.showSaveDialog({ title: "Export STEP", defaultPath: "cone-sphere.step" });
      if (picked !== path) throw new Error(`dialog returned ${String(picked)}`);
      const r = await aicad.forge.exportStep?.(req);
      if (!r?.data) throw new Error("no STEP bytes");
      await aicad.writeFile(picked, r.data);
    },
    { req: { irJson, productName: "cone and sphere" }, path: target },
  );
  const written = readFileSync(target, "utf8");
  expect(written).toBe(res.text);
});

test("a malformed request is refused by the main process", async () => {
  const message = await page.evaluate(async () => {
    const forge = (window as unknown as { aicad: { forge: StepApi } }).aicad.forge;
    try {
      await forge.exportStep?.({ irJson: "{}", schema: "ap203" as never });
      return "accepted";
    } catch (e) {
      return String(e);
    }
  });
  expect(message).toContain("invalid STEP schema");
});

test("an IR v1 document exports through the same channel", async () => {
  const irJson = readFileSync(V1_PROGRAM, "utf8");
  expect(JSON.parse(irJson).schema).toBe("aicad.ir/1");
  const res = await page.evaluate(async (req) => {
    const forge = (window as unknown as { aicad: { forge: StepApi } }).aicad.forge;
    const r = await forge.exportStep?.(req);
    return r
      ? {
          exitCode: r.exitCode,
          stderr: r.stderr,
          text: r.data ? new TextDecoder().decode(r.data) : "",
          summary: r.summary as { bodies: Array<{ forge: { volume: number }; step: { solids: number } }> },
        }
      : null;
  }, { irJson, productName: "params plate" });
  expect(res, "the channel is missing").not.toBeNull();
  if (!res) return;
  expect(res.exitCode, res.stderr).toBe(0);
  expect(res.text).toMatch(/^ISO-10303-21;/);
  expect(res.text).toContain("MANIFOLD_SOLID_BREP(");
  expect(res.summary.bodies.length).toBeGreaterThan(0);
  expect(res.summary.bodies.every((b) => b.forge.volume > 0 && b.step.solids === 1)).toBe(true);
});

test("File > Export > STEP… exports the open IR v1 document", async () => {
  const hasCommand = await page.evaluate(async () => {
    const a = (window as unknown as { __aicad?: Automation }).__aicad;
    return !!a && (await a.describe()).some((c) => c.id === "file.exportStep");
  });
  test.skip(
    !hasCommand,
    "file.exportStep is not registered yet: the Phase C integrator adds it to commands.ts (io/step-export-command.ts)",
  );
  // Open it the user's way: the open dialog (stubbed to pick it) grants the read.
  await app.evaluate(({ dialog }, path) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [path] });
  }, V1_PROGRAM);
  const opened = await page.evaluate(() =>
    (window as unknown as { __aicad: Automation }).__aicad.execute({ id: "file.open" }),
  );
  expect(opened.ok, opened.error?.message).toBe(true);
  await page.evaluate(() => (window as unknown as { __aicad: Automation }).__aicad.idle());

  const target = join(root, "params-plate.step");
  await app.evaluate(({ dialog }, path) => {
    (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = () =>
      Promise.resolve({ canceled: false, filePath: path });
  }, target);
  const clicked = await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("file.exportStep");
    item?.click();
    return !!item;
  });
  expect(clicked, "the File ▸ Export submenu has no STEP… item (menu.ts)").toBe(true);
  await expect(page.getByText(/Exported params-plate\.step/)).toBeVisible();
  const written = readFileSync(target, "utf8");
  expect(written).toMatch(/^ISO-10303-21;/);
  expect(written).toContain("MANIFOLD_SOLID_BREP(");
});
