/**
 * The app's sketch mode (one per window) over the sketch-session WASM, loaded lazily through
 * `virtual:aicad/forge-web-sketch` on the first sketch.
 *
 * Keyboard: sketch mode owns the keys while it is active. Its handler is registered on `window`
 * (capture) when this module loads — before the app's command keymap (`ui/keyboard.ts`) — so
 * Escape, ⌘Z and the tool letters reach the sketch instead of the document. When C10's input
 * router lands, this becomes one entry of the router (docs/fm/sketcher.md).
 */
import { available, load, source } from "virtual:aicad/forge-web-sketch";
import { SketchMode, type SketchEngine, type SketchEngineFactory } from "./controller";
import type { SketchLoadRequest } from "./engine-types";

interface SketchModule {
  initSketch(): Promise<void>;
  SketchSession: { load(req: SketchLoadRequest): SketchEngine };
}

function isSketchModule(m: unknown): m is SketchModule {
  const x = m as Partial<SketchModule> | null;
  return !!x && typeof x.initSketch === "function" && typeof x.SketchSession === "function" && typeof (x.SketchSession as { load?: unknown }).load === "function";
}

let mod: SketchModule | null = null;

export const wasmSketchEngines: SketchEngineFactory = {
  async ready() {
    if (mod) return;
    if (!available) throw new Error(`not bundled (${source})`);
    const m: unknown = await load();
    if (!isSketchModule(m)) throw new Error("@aicad/forge-web/sketch does not match the sketch contract");
    await m.initSketch();
    mod = m;
  },
  load(req) {
    if (!mod) throw new Error("the sketch engine is not loaded");
    return mod.SketchSession.load(req);
  },
};

/** The window's sketch mode. */
export const sketchMode = new SketchMode(wasmSketchEngines);

function editableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.closest(".monaco-editor") !== null;
}

/** Install the sketch keyboard handler (idempotent). */
export function installSketchKeys(target: Window = window): () => void {
  const isMac = /Mac/.test(typeof navigator === "undefined" ? "" : navigator.userAgent);
  const down = (e: KeyboardEvent): void => {
    const phase = sketchMode.getState().phase;
    if (phase !== "active" && phase !== "choosePlane") return;
    if (e.isComposing) return;
    const consumed = sketchMode.key({ key: e.key, mod: isMac ? e.metaKey : e.ctrlKey, shift: e.shiftKey, alt: e.altKey, editable: editableTarget(e.target) });
    if (consumed) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  const up = (e: KeyboardEvent): void => sketchMode.keyUp(e.key);
  target.addEventListener("keydown", down, true);
  target.addEventListener("keyup", up, true);
  return () => {
    target.removeEventListener("keydown", down, true);
    target.removeEventListener("keyup", up, true);
  };
}

if (typeof window !== "undefined") installSketchKeys();
