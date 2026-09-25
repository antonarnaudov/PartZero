/**
 * Shared set-up for the viewport specs: launch the desktop app (as smoke.e2e.ts does), open the
 * NEMA 17 plate template (50×50×5, pilot r 11, four M3 holes r 1.7 at ±15.5), turn camera
 * animations off, and drive the canvas with **real** mouse events at points projected through
 * `window.__pzView` (the viewport's slice of contract C7's test API).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { appDir } from "../app-dir.js";

export type Vec3 = [number, number, number];

export interface Item {
  kind: string;
  body?: string;
  key?: string;
  point?: Vec3;
  id?: string;
  feature?: string;
  label?: string;
}

interface CommandResultLike {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
}

interface ViewApi {
  execute(cmd: unknown): Promise<CommandResultLike>;
  project(p: Vec3): { x: number; y: number; depth: number } | null;
  projectPage(p: Vec3): { x: number; y: number } | null;
  camera(): { target: Vec3; distance: number; yaw: number; pitch: number; fovY: number; projection: string } | null;
  selection(): { items: Item[]; hover: Item | null; filter: Record<string, boolean>; revision: number };
  topology(): Array<{ body: string; faces: string[]; edges: string[]; vertices: Array<{ key: string; point: Vec3 }> }>;
  view(): { display: string; drawn: string; grid: boolean; origin: boolean; section: unknown; view: string | null; nativeModes: string[]; bodies: Record<string, { visible: boolean; color: Vec3 | null }> };
  setAnimationMs(ms: number): void;
  showHandles(h: unknown[]): void;
  hideHandles(): void;
  handleLog(): Array<{ id: string; value: number; phase: string; clamped?: string }>;
  handles(): Array<{ id: string; value: number }>;
  pickAt(x: number, y: number): Promise<Item | null>;
  frames(): number;
}

declare global {
  interface Window {
    __pzView?: ViewApi;
    __aicad?: { execute(cmd: unknown): Promise<CommandResultLike>; idle(): Promise<{ bodies: Array<{ name: string }>; engine: string }> };
  }
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  close(): Promise<void>;
  pageErrors: string[];
}

export const PLATE = "plate/plate";

export async function launch(): Promise<Launched> {
  const userData = mkdtempSync(join(tmpdir(), "aicad-vp-e2e-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$/.test(k)) env[k] = v;
  const app = await electron.launch({
    args: [appDir, "--use-mock-keychain"],
    env: { ...env, AICAD_USER_DATA_DIR: userData, AICAD_SKIP_CLOSE_PROMPT: "1", AICAD_AGENT_DOTENV: "off" },
  });
  const page = await app.firstWindow();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("crash", () => pageErrors.push("renderer crashed"));
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1480, height: 920 });
  });
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.waitForFunction(() => !!window.__pzView && !!window.__aicad);
  await page.evaluate(() => window.__pzView!.setAnimationMs(0));
  return {
    app,
    page,
    pageErrors,
    async close() {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

/** Open the NEMA 17 plate and wait until it is displayed and fitted in the iso view. */
export async function openPlate(page: Page): Promise<void> {
  const r = await page.evaluate(() => window.__aicad!.execute({ id: "file.newFromTemplate", args: { templateId: "t1-nema17-plate" } }));
  expect(r.ok).toBe(true);
  await page.waitForFunction(() => window.__pzView!.topology().some((b) => b.body === "plate/plate" && b.faces.length === 11));
  // The renderer starts asynchronously (WASM + GPU device): wait until it is attached.
  await page.waitForFunction(() => window.__pzView!.camera() !== null);
  expect((await view(page, { id: "view.setView", args: { view: "iso" } })).ok).toBe(true);
}

export async function view(page: Page, cmd: { id: string; args?: Record<string, unknown> }): Promise<CommandResultLike> {
  return page.evaluate((c) => window.__pzView!.execute(c), cmd);
}

export async function selection(page: Page): Promise<{ items: Item[]; hover: Item | null; filter: Record<string, boolean> }> {
  return page.evaluate(() => window.__pzView!.selection());
}

/** Page coordinates of a world point (for `page.mouse`). */
export async function at(page: Page, p: Vec3): Promise<{ x: number; y: number }> {
  const q = await page.evaluate((w) => window.__pzView!.projectPage(w), p);
  if (!q) throw new Error(`${p.join(",")} is behind the camera`);
  return q;
}

export async function clickWorld(page: Page, p: Vec3, modifiers: Array<"Shift" | "Meta" | "Alt"> = []): Promise<void> {
  const q = await at(page, p);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(q.x, q.y);
  for (const m of modifiers) await page.keyboard.up(m);
}

/** A mouse drag with real events: press, move in steps, release. */
export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, button: "left" | "right" | "middle" = "left", steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await page.mouse.up({ button });
}

export async function canvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await page.locator(".viewport-canvas").boundingBox();
  if (!b) throw new Error("no canvas");
  return b;
}

export async function camera(page: Page) {
  return page.evaluate(() => window.__pzView!.camera()!);
}

/** An RGBA screenshot of the page, decoded (for checking what the renderer actually drew). */
export interface Pixels {
  width: number;
  height: number;
  /** Device pixels per CSS pixel. */
  scale: number;
  rgba: Uint8Array;
  at(x: number, y: number): [number, number, number];
}

/** Decode an 8-bit RGBA/RGB PNG (no interlace) — enough for Chromium screenshots. */
export function decodePng(buf: Buffer): { width: number; height: number; rgba: Uint8Array } {
  let o = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("latin1", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9]!;
      if (data[8] !== 8 || data[12] !== 0) throw new Error("unsupported PNG");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v = line[i]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = cur[x * bpp]!;
      out[(y * width + x) * 4 + 1] = cur[x * bpp + 1]!;
      out[(y * width + x) * 4 + 2] = cur[x * bpp + 2]!;
      out[(y * width + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3]! : 255;
    }
    prev.set(cur);
  }
  return { width, height, rgba: out };
}

/** Screenshot the page and read pixels at page CSS coordinates. */
export async function pixels(page: Page): Promise<Pixels> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  const png = await page.screenshot({ animations: "disabled" });
  const img = decodePng(png);
  const cssWidth = await page.evaluate(() => window.innerWidth);
  const scale = img.width / cssWidth;
  return {
    ...img,
    scale,
    at(x, y) {
      const px = Math.min(img.width - 1, Math.max(0, Math.round(x * scale)));
      const py = Math.min(img.height - 1, Math.max(0, Math.round(y * scale)));
      const i = (py * img.width + px) * 4;
      return [img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!];
    },
  };
}

/** Dispatch a synthetic wheel event on the canvas (pixel mode unless given). */
export async function wheel(page: Page, e: { deltaX?: number; deltaY?: number; deltaMode?: number; ctrlKey?: boolean; shiftKey?: boolean }, where?: { x: number; y: number }): Promise<void> {
  await page.evaluate(
    ({ e, where }) => {
      const c = document.querySelector(".viewport-canvas") as HTMLCanvasElement;
      const r = c.getBoundingClientRect();
      const x = where?.x ?? r.left + r.width / 2;
      const y = where?.y ?? r.top + r.height / 2;
      c.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaX: e.deltaX ?? 0, deltaY: e.deltaY ?? 0, deltaMode: e.deltaMode ?? 0, ctrlKey: !!e.ctrlKey, shiftKey: !!e.shiftKey }));
    },
    { e, where },
  );
}
