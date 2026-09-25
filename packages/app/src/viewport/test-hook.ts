/**
 * `window.__pzView`: the viewport's test and debugging surface (a slice of contract C7's
 * `__pzTest`), installed only where `window.__aicad` is (a dev build or an unpackaged desktop
 * run). The e2e specs drive the app with **real** pointer events at points projected through it,
 * and read state only through it.
 */
import type { AppCommandRegistry } from "../commands/commands";
import type { CommandResult } from "../commands/registry";
import { labelOf } from "../selection/labels";
import type { SelectionItem } from "../selection/types";
import type { AppServices } from "../services";
import type { HandleChange, HandleSpec } from "./manipulators/types";
import { routedExecute } from "./registry";
import { viewportRuntime } from "./runtime";
import type { CameraState, Vec3 } from "./view-camera";

export interface ViewTestApi {
  execute(cmd: unknown): Promise<CommandResult<unknown>>;
  /** Canvas-relative CSS px of a world point (null behind the eye). */
  project(p: Vec3): { x: number; y: number; depth: number } | null;
  /** Page (client) CSS px of a world point, for `page.mouse`. */
  projectPage(p: Vec3): { x: number; y: number } | null;
  camera(): CameraState | null;
  selection(): { items: Array<SelectionItem & { label: string }>; hover: SelectionItem | null; filter: Record<string, boolean>; revision: number };
  topology(): Array<{ body: string; faces: string[]; edges: string[]; vertices: Array<{ key: string; point: Vec3 }> }>;
  view(): unknown;
  /** Turn camera animations off (0) for deterministic tests. */
  setAnimationMs(ms: number): void;
  /** Show handles through the manipulator API (what a tool does); returns nothing, changes go to `handleLog()`. */
  showHandles(handles: HandleSpec[]): void;
  hideHandles(): void;
  handleLog(): HandleChange[];
  handles(): HandleSpec[];
  pickAt(x: number, y: number): Promise<SelectionItem | null>;
  frames(): number;
}

declare global {
  interface Window {
    __pzView?: ViewTestApi;
  }
}

export function installViewTestHook(app: AppServices, appCommands: AppCommandRegistry): () => void {
  const rt = viewportRuntime(app);
  let off: (() => void) | null = null;
  const api: ViewTestApi = {
    execute: (cmd) => routedExecute(app, appCommands, cmd, "test"),
    project: (p) => rt.project(p),
    projectPage(p) {
      const s = rt.project(p);
      const c = rt.adapter?.canvas.getBoundingClientRect();
      return s && c ? { x: c.left + s.x, y: c.top + s.y } : null;
    },
    camera: () => rt.adapter?.camera() ?? null,
    selection() {
      const s = rt.selection.getState();
      const ir = app.doc.getState().model?.ir;
      return { items: s.items.map((it) => ({ ...it, label: labelOf(it, ir) })), hover: s.hover, filter: { ...s.filter }, revision: s.revision };
    },
    topology: () =>
      [...rt.topo.bodies.values()].map((b) => ({
        body: b.name,
        faces: [...b.faces.keys()],
        edges: [...b.edges.keys()],
        vertices: [...b.vertices.values()].map((v) => ({ key: v.key, point: v.point })),
      })),
    view: () => ({ ...rt.view.getState(), drawn: rt.effectiveDisplay(), cameraRevision: rt.cameraRevision, nativeModes: rt.adapter?.capabilities().nativeModes ?? [] }),
    setAnimationMs(ms) {
      rt.animationMs = Math.max(0, ms);
    },
    showHandles(handles) {
      off?.();
      off = rt.manipulators.show(handles, () => undefined);
    },
    hideHandles() {
      off?.();
      off = null;
    },
    handleLog: () => [...rt.manipulators.log],
    handles: () => [...rt.manipulators.getState().handles],
    pickAt: (x, y) => rt.pickAt(x, y),
    frames: () => rt.cameraRevision,
  };
  window.__pzView = api;
  return () => {
    off?.();
    if (window.__pzView === api) delete window.__pzView;
  };
}
