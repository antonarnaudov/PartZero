/**
 * The sketcher's integration points (see docs/fm/sketcher.md for the exact wiring):
 *
 * - {@link faceSource}: the viewport/selection stream registers a function that returns the
 *   selected planar face (its IR `{ face: Ref }` plane, outward normal and a point on it). Until
 *   then the plane picker offers the origin planes only.
 * - {@link documentSource}: the document layer registers the open document as a new sketch sees
 *   it (parameters, part, insertion point, taken names), so dimensions can use the document's
 *   parameters and every new sketch gets a free id and name.
 * - {@link SKETCH_COMMANDS}: the `sketch.*` app commands the integrator registers in
 *   `commands/sketch.ts` (ids, titles, keys, what they call).
 * - `sketchMode.setSink(...)` (controller): route finished sketches into the command layer.
 * - {@link exposeSketchTestHooks}: `window.__pzSketch` for e2e (dev builds, or
 *   `AICAD_ALLOW_DEBUGGER=1`), in the spirit of contract C7's `window.__pzTest`.
 */
import type { v1 } from "@aicad/ir-types";
import type { ContextGeometry } from "./context";
import type { BeginOptions, SketchMode, SketchModeState, SketchPlaneChoice } from "./controller";
import type { V3 } from "./frames";
import type { P2 } from "./geom";
import { PlaneView } from "./view";

export interface SelectedFace {
  /** The IR plane reference, e.g. `{ face: { query: …, capture: … } }` from `refFor`. */
  ref: v1.PlaneRef;
  /** Outward unit normal (world). */
  normal: V3;
  /** A point on the face (world). */
  point: V3;
  /** For people: `plate · top face`. */
  label: string;
}

/** Set by the viewport stream (C4/C2): the currently selected planar face, if any. */
export const faceSource: { current: (() => Promise<SelectedFace | null>) | null } = { current: null };

/** Where a new sketch goes, and what its dimensions may use. */
export interface SketchDocContext {
  /** The IR v1 document whose parameters dimensions use (null: a document without parameters, IR v0). */
  document: v1.IrDocument | null;
  /** The part the sketch goes into (null: the first part). */
  part: string | null;
  /** Insert after this feature (null: at the end of the part's timeline). */
  after: string | null;
  /** Ids and names the document already uses beyond `document`'s: the new sketch avoids them. */
  taken: readonly string[];
}

/**
 * Set by the document layer: the open document as a new sketch sees it. Today the CadScript
 * bridge (`sketch/v0-bridge.ts`) sets it from the v0 DocStore; after Phase C the integrator sets
 * it from `services.ir` (the v1 document, the selected part, the rollback marker).
 */
export const documentSource: { current: (() => SketchDocContext | null) | null } = { current: null };

/**
 * Set by the document layer: open the document's sketch `idOrName` in sketch mode (the timeline's
 * double-click). Returns false when it is not a sketch the sketcher can open.
 */
export const editSketchSource: { current: ((idOrName: string) => boolean) | null } = { current: null };

/** Open a sketch of the document for editing (timeline double-click). */
export function editSketchFeature(idOrName: string): boolean {
  return editSketchSource.current?.(idOrName) ?? false;
}

/**
 * Set by the document layer: extrude a finished sketch (the Finish follow-up, until the feature
 * tools' extrude exists). Null hides the offer.
 */
export const quickExtrudeSource: {
  current: ((sketch: string, distance: number, direction: "normal" | "reverse" | "symmetric") => Promise<{ ok: true; note?: string; warning?: string } | { ok: false; message: string }>) | null;
} = { current: null };

/** The `begin` options for a new sketch on `plane`: the document's parameters, part and names. */
export function newSketchOptions(plane: SketchPlaneChoice, context: ContextGeometry, doc: SketchDocContext | null): BeginOptions {
  return {
    plane,
    context,
    ...(doc?.document ? { document: doc.document } : {}),
    ...(doc?.part ? { part: doc.part } : {}),
    after: doc?.after ?? null,
    taken: doc?.taken ?? [],
  };
}

/** The `sketch.*` commands for the command layer (plan §2.1 rule 5: UI-state commands). */
export const SKETCH_COMMANDS = [
  { id: "sketch.new", title: "New sketch", keys: ["Shift+S"], run: (m: SketchMode) => m.requestNew() },
  { id: "sketch.finish", title: "Finish sketch", keys: [] as string[], run: (m: SketchMode) => void m.finish() },
  { id: "sketch.cancel", title: "Cancel sketch", keys: [] as string[], run: (m: SketchMode) => m.cancel() },
] as const;

export interface SketchTestHooks {
  state(): SketchModeState;
  /** Client (page) coordinates of a sketch point, for real mouse events. */
  client(u: number, v: number): P2;
  /** Sketch coordinates of a client point. */
  sketch(x: number, y: number): P2;
  /** Every sketch finished in this window (whichever sink took it). */
  finished(): unknown[];
  mode: SketchMode;
}

declare global {
  interface Window {
    __pzSketch?: SketchTestHooks;
  }
}

/**
 * Install `window.__pzSketch` where automation is allowed: a dev build, or when the shell installed
 * `window.__aicad` (an unpackaged run; bootstrap's `automationAllowed`). Never in a packaged build.
 */
export function exposeSketchTestHooks(mode: SketchMode): () => void {
  if (typeof window === "undefined") return () => {};
  const dev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
  if (!dev && !("__aicad" in window)) return () => {};
  const canvas = (): Element | null => document.querySelector("[data-testid=sketch-canvas]");
  const hooks: SketchTestHooks = {
    state: () => mode.getState(),
    client(u, v) {
      const r = canvas()?.getBoundingClientRect();
      const p = new PlaneView(mode.getState().view).toScreen([u, v]);
      return [p[0] + (r?.left ?? 0), p[1] + (r?.top ?? 0)];
    },
    sketch(x, y) {
      const r = canvas()?.getBoundingClientRect();
      return new PlaneView(mode.getState().view).toSketch([x - (r?.left ?? 0), y - (r?.top ?? 0)]);
    },
    finished: () => mode.finishedLog.map((r) => JSON.parse(JSON.stringify(r)) as unknown),
    mode,
  };
  window.__pzSketch = hooks;
  return () => {
    if (window.__pzSketch === hooks) delete window.__pzSketch;
  };
}
