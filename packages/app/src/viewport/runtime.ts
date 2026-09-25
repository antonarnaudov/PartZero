/**
 * `ViewportRuntime`: the viewport's brain, shared by the React host, the `view.*` / `selection.*` /
 * `measure.*` commands, the keyboard shortcuts and the test hook. It owns the view, selection,
 * measure and manipulator stores, holds the renderer adapter, keeps the scene topology of the
 * displayed bodies, and implements camera moves (animated standard views, fit, zoom to selection,
 * look-at), picking with the kind filter, box selection, highlights and the section plane.
 *
 * One runtime per `AppServices` ({@link viewportRuntime}); it outlives the React component, so
 * commands work (and fail with a clear reason) even before the viewport is mounted.
 */
import type { AppServices } from "../services";
import { facesOfFeature, findFeature } from "../doc/provenance";
import type { RenderBody } from "../engine/types";
import { MeasureStore } from "../measure/store";
import { boxModeOf, boxSelect, type Rect } from "../selection/box-select";
import { pickItem, type PickContext } from "../selection/picking";
import { SelectionStore } from "../selection/store";
import { buildTopology, faceTriangles, type SceneTopology } from "../selection/topology";
import { isEntity, type BoxMode, type SelectionItem } from "../selection/types";
import type { HighlightRef, ViewportAdapter } from "./adapter";
import { displayBodies, effectiveMode, type DisplayMode } from "./display";
import { faceGeom } from "../measure/geometry";
import { ManipulatorHost } from "./manipulators/host";
import {
  anglesLookingAlong,
  basis,
  cameraFrame,
  easeInOut,
  fitSphere,
  lerpCamera,
  scale,
  sphereFromBox,
  standardViewOf,
  viewAngles,
  type CameraFrame,
  type CameraState,
  type Projection,
  type ScreenPoint,
  type StandardView,
  type Vec3,
} from "./view-camera";
import { sectionPlane, ViewStore, PRINCIPAL, type SectionBase, type SectionState, type ViewState } from "./view-store";

/** Duration of animated camera moves (ms); 0 disables animation (tests, reduced motion). */
export const DEFAULT_ANIMATION_MS = 280;

export type RunAppCommand = (cmd: { id: string; args?: Record<string, unknown> }) => void;

const runtimes = new WeakMap<AppServices, ViewportRuntime>();

/** The runtime of an app (created on first use). */
export function viewportRuntime(app: AppServices): ViewportRuntime {
  let r = runtimes.get(app);
  if (!r) {
    r = new ViewportRuntime(app);
    runtimes.set(app, r);
  }
  return r;
}

export class ViewportRuntime {
  readonly app: AppServices;
  readonly view: ViewStore;
  readonly selection = new SelectionStore();
  readonly measure = new MeasureStore();
  readonly manipulators = new ManipulatorHost();
  adapter: ViewportAdapter | null = null;
  topo: SceneTopology = buildTopology([]);
  /** Bodies of the scene as the document (or the proposal preview) has them, before display. */
  private sceneBodies: readonly RenderBody[] = [];
  private animation: { raf: number } | null = null;
  private readonly frameListeners = new Set<() => void>();
  private detachFrame: (() => void) | null = null;
  private runCommand: RunAppCommand | null = null;
  private readonly unsubs: Array<() => void> = [];
  animationMs = DEFAULT_ANIMATION_MS;
  /** Monotonic count of camera changes (overlays re-render on it). */
  cameraRevision = 0;

  constructor(app: AppServices, options: { persist?: boolean } = {}) {
    this.app = app;
    this.view = new ViewStore(options);
    try {
      if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) this.animationMs = 0;
    } catch {
      // no matchMedia (tests)
    }
    // Highlights follow the selection and hover.
    this.unsubs.push(this.selection.subscribe(() => this.syncHighlights()));
    // Display state changes re-send the bodies (colour, visibility, wireframe emulation).
    let lastView = this.view.getState();
    this.unsubs.push(
      this.view.subscribe(() => {
        const s = this.view.getState();
        if (s.bodies !== lastView.bodies || s.display !== lastView.display) this.pushBodies();
        if (s.display !== lastView.display || s.grid !== lastView.grid || s.axes !== lastView.axes) this.applyDisplay();
        if (s.section !== lastView.section) this.applySection();
        if (s.projection !== lastView.projection) this.adapter?.setProjection(s.projection);
        lastView = s;
      }),
    );
    // The legacy single selection (timeline, code, Escape) drives the selection model.
    let lastDocSel = app.doc.getState().selection;
    this.unsubs.push(
      app.doc.subscribe(() => {
        const sel = app.doc.getState().selection;
        if (sel === lastDocSel) return;
        lastDocSel = sel;
        if (sel.origin === "viewport") return;
        // Esc during a handle drag cancels the drag (C10's Esc layering), not the selection.
        if (!sel.featureId && !sel.entity) {
          if (!this.manipulators.dragging) this.selection.clear();
        }
        else if (sel.featureId && !sel.entity) {
          const loc = findFeature(app.doc.getState().model?.ir, sel.featureId);
          this.selection.set(loc?.feature.type === "sketch" ? [{ kind: "sketch", feature: loc.feature.name }] : []);
        }
        this.syncHighlights();
      }),
    );
  }

  /** How UI-originated app commands run (`selection.selectEntity` keeps the timeline/code in sync). */
  setCommandRunner(run: RunAppCommand | null): void {
    this.runCommand = run;
  }

  // ─── Adapter ────────────────────────────────────────────────────────────────────────────

  attach(adapter: ViewportAdapter): () => void {
    this.adapter = adapter;
    this.detachFrame = adapter.onFrame(() => this.emitFrame());
    adapter.setProjection(this.view.getState().projection);
    this.applyDisplay();
    this.pushBodies(true);
    this.applySection();
    this.syncHighlights();
    return () => {
      if (this.adapter !== adapter) return;
      this.stopAnimation();
      this.detachFrame?.();
      this.detachFrame = null;
      this.adapter = null;
    };
  }

  onFrame(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  private emitFrame(): void {
    this.cameraRevision++;
    for (const l of [...this.frameListeners]) l();
  }

  /** The camera frame for overlays (CSS pixels), or null without a renderer. */
  frame(): CameraFrame | null {
    const a = this.adapter;
    if (!a) return null;
    const { width, height } = a.size();
    return cameraFrame(a.camera(), width, height);
  }

  /** Project a world point to canvas CSS pixels (tests: `__pzView.project`). */
  project(p: Vec3): ScreenPoint | null {
    return this.frame()?.project(p) ?? null;
  }

  // ─── Scene ──────────────────────────────────────────────────────────────────────────────

  /** The bodies to show (the document's, or a proposal preview's). */
  setSceneBodies(bodies: readonly RenderBody[]): void {
    if (bodies === this.sceneBodies) return;
    this.sceneBodies = bodies;
    this.topo = buildTopology(bodies);
    this.pushBodies();
    this.selection.resolve(this.topo);
    this.syncHighlights();
  }

  get bodies(): readonly RenderBody[] {
    return this.sceneBodies;
  }

  /**
   * Hand the displayed bodies to the renderer — only when what it would receive changed: a new
   * upload bumps forge-render's scene generation and drops picks in flight (a click's pick
   * during a display-mode switch would otherwise read as "nothing").
   */
  private pushBodies(force = false): void {
    const a = this.adapter;
    if (!a) return;
    const v = this.view.getState();
    const native = a.capabilities().nativeModes;
    const emulatedWire = v.display === "wireframe" && !native.includes("wireframe");
    const key = { bodies: this.sceneBodies, states: v.bodies, emulatedWire, adapter: a };
    const last = this.pushed;
    if (!force && last && last.bodies === key.bodies && last.states === key.states && last.emulatedWire === key.emulatedWire && last.adapter === key.adapter) return;
    this.pushed = key;
    a.setBodies(displayBodies({ bodies: this.sceneBodies, states: new Map(Object.entries(v.bodies)), mode: v.display, nativeModes: native }));
    this.syncHighlights();
  }

  private pushed: { bodies: readonly RenderBody[]; states: ViewState["bodies"]; emulatedWire: boolean; adapter: ViewportAdapter } | null = null;

  private applyDisplay(): void {
    const a = this.adapter;
    if (!a) return;
    const v = this.view.getState();
    a.setDisplay({ mode: effectiveMode(v.display, a.capabilities().nativeModes), grid: v.grid, axes: v.axes });
  }

  /** The display mode actually drawn (unavailable ones fall back to shaded with edges). */
  effectiveDisplay(): DisplayMode {
    const a = this.adapter;
    const mode = this.view.getState().display;
    return a ? effectiveMode(mode, a.capabilities().nativeModes) : mode;
  }

  // ─── Highlights ─────────────────────────────────────────────────────────────────────────

  private highlightOf(it: SelectionItem): HighlightRef[] {
    if (it.kind === "face") return [{ body: it.body, face: it.key }];
    if (it.kind === "edge") return [{ body: it.body, edge: it.key }];
    if (it.kind === "body") return [...(this.topo.bodies.get(it.body)?.faces.keys() ?? [])].map((face) => ({ body: it.body, face }));
    return [];
  }

  syncHighlights(): void {
    const a = this.adapter;
    if (!a) return;
    const s = this.selection.getState();
    let refs = s.items.flatMap((it) => this.highlightOf(it));
    if (s.items.length === 0) {
      const docSel = this.app.doc.getState().selection;
      if (docSel.featureId && !docSel.entity) {
        const loc = findFeature(this.app.doc.getState().model?.ir, docSel.featureId);
        refs = loc ? facesOfFeature(this.sceneBodies, loc.feature.name).map((p) => ({ body: p.body, ...(p.face ? { face: p.face } : {}) })) : [];
      }
    }
    a.setSelection(refs);
    const h = s.hover;
    a.setHover(h && h.kind !== "body" ? (this.highlightOf(h)[0] ?? null) : h ? { body: h.body } : null);
  }

  // ─── Camera ─────────────────────────────────────────────────────────────────────────────

  private stopAnimation(): void {
    if (this.animation) cancelAnimationFrame(this.animation.raf);
    this.animation = null;
  }

  /** Move the camera to `to`, animated unless animations are off. Resolves when done. */
  animateTo(to: CameraState): Promise<void> {
    const a = this.adapter;
    if (!a) return Promise.resolve();
    this.stopAnimation();
    const from = a.camera();
    if (this.animationMs <= 0 || typeof requestAnimationFrame !== "function") {
      a.setCamera(to);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = (): void => {
        if (this.adapter !== a) return resolve();
        const t = Math.min(1, (performance.now() - t0) / this.animationMs);
        a.setCamera(lerpCamera(from, to, easeInOut(t)));
        if (t < 1) this.animation = { raf: requestAnimationFrame(step) };
        else {
          this.animation = null;
          resolve();
        }
      };
      this.animation = { raf: requestAnimationFrame(step) };
    });
  }

  private sceneSphere(): { center: Vec3; radius: number } | null {
    const hidden = this.view.hiddenBodies();
    let min: Vec3 | null = null;
    let max: Vec3 | null = null;
    for (const b of this.topo.bodies.values()) {
      if (hidden.has(b.name) || !b.bbox) continue;
      min = min ? [Math.min(min[0], b.bbox.min[0]), Math.min(min[1], b.bbox.min[1]), Math.min(min[2], b.bbox.min[2])] : [...b.bbox.min];
      max = max ? [Math.max(max[0], b.bbox.max[0]), Math.max(max[1], b.bbox.max[1]), Math.max(max[2], b.bbox.max[2])] : [...b.bbox.max];
    }
    return min && max ? sphereFromBox(min, max) : null;
  }

  private aspect(): number {
    const s = this.adapter?.size() ?? { width: 1, height: 1 };
    return s.width / Math.max(1, s.height);
  }

  /** Standard view (animated), fitted to the visible scene. */
  async setStandardView(v: StandardView): Promise<void> {
    const a = this.adapter;
    if (!a) throw new Error("the viewport is not ready");
    const [yaw, pitch] = viewAngles(v);
    const sphere = this.sceneSphere();
    const base = { ...a.camera(), yaw, pitch };
    await this.animateTo(sphere ? fitSphere(base, sphere, this.aspect()) : base);
    this.view.setView(v);
  }

  /** Orient to look along `dir` (view cube edges and corners), fitted. */
  async lookAlong(dir: Vec3): Promise<void> {
    const a = this.adapter;
    if (!a) throw new Error("the viewport is not ready");
    const cur = a.camera();
    const [yaw, pitch] = anglesLookingAlong(dir, cur.yaw);
    const sphere = this.sceneSphere();
    const base = { ...cur, yaw, pitch };
    await this.animateTo(sphere ? fitSphere(base, sphere, this.aspect()) : base);
    this.view.setView(standardViewOf({ yaw, pitch }, 1e-6));
  }

  async fit(): Promise<void> {
    const a = this.adapter;
    if (!a) throw new Error("the viewport is not ready");
    const sphere = this.sceneSphere();
    if (!sphere) return;
    await this.animateTo(fitSphere(a.camera(), sphere, this.aspect()));
  }

  /** The world points of the selection (for zoom to selection). */
  private selectionPoints(items: readonly SelectionItem[]): Vec3[] {
    const pts: Vec3[] = [];
    for (const it of items) {
      if (it.kind === "body") {
        const bb = this.topo.bodies.get(it.body)?.bbox;
        if (bb) pts.push(bb.min, bb.max);
        continue;
      }
      if (!isEntity(it)) continue;
      const b = this.topo.bodies.get(it.body);
      if (!b) continue;
      if (it.kind === "vertex") {
        const v = b.vertices.get(it.key);
        if (v) pts.push(v.point);
      } else if (it.kind === "edge") {
        const e = b.edges.get(it.key);
        if (e) for (let i = 0; i + 2 < e.points.length; i += 3) pts.push([e.points[i]!, e.points[i + 1]!, e.points[i + 2]!]);
      } else {
        for (const t of faceTriangles(b, it.key)) pts.push(...t);
      }
    }
    return pts;
  }

  /** Frame the selection (or everything when nothing is selected). */
  async zoomToSelection(): Promise<void> {
    const a = this.adapter;
    if (!a) throw new Error("the viewport is not ready");
    const pts = this.selectionPoints(this.selection.items);
    if (pts.length === 0) return this.fit();
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p[k]!);
      max[k] = Math.max(max[k]!, p[k]!);
    }
    // A single vertex gets a sensible neighbourhood (5 % of the scene).
    const scene = this.sceneSphere();
    const sphere = sphereFromBox(min, max, (scene?.radius ?? 10) * 0.05);
    await this.animateTo(fitSphere(a.camera(), sphere, this.aspect()));
  }

  /**
   * Look straight at the primary planar face (or along a cylinder's axis / an edge's circle
   * normal), fitted to it. Throws with a reason when the primary item has no direction.
   */
  async normalTo(): Promise<void> {
    const a = this.adapter;
    if (!a) throw new Error("the viewport is not ready");
    const it = this.selection.primary;
    if (!it || it.kind !== "face") throw new Error("select a planar face to look at");
    const b = this.topo.bodies.get(it.body);
    const g = b ? faceGeom(b, it.key) : null;
    if (!g || (g.type !== "plane" && g.type !== "cylinder")) throw new Error("the selected face is not planar or cylindrical");
    // Look into the face: along −normal (from outside), or along the axis.
    const dir: Vec3 = g.type === "plane" ? scale(g.normal, -1) : g.axis;
    const cur = a.camera();
    const [yaw, pitch] = anglesLookingAlong(dir, cur.yaw);
    const pts = this.selectionPoints([it]);
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p[k]!);
      max[k] = Math.max(max[k]!, p[k]!);
    }
    await this.animateTo(fitSphere({ ...cur, yaw, pitch }, sphereFromBox(min, max), this.aspect()));
    this.view.setView(standardViewOf({ yaw, pitch }, 1e-6));
  }

  setProjection(p: Projection): void {
    this.view.setProjection(p);
    this.adapter?.setProjection(p);
  }

  /** Called by navigation after a user orbit (the standard-view marker no longer applies). */
  noteOrbit(): void {
    if (this.view.getState().view !== null) this.view.setView(null);
  }

  // ─── Picking and selection ──────────────────────────────────────────────────────────────

  private pickContext(): PickContext | null {
    const a = this.adapter;
    const frame = this.frame();
    if (!a || !frame) return null;
    const sec = this.view.getState().section;
    const plane = sec ? sectionPlane(sec) : null;
    return {
      pick: (x, y) => a.pick(x, y),
      frame,
      topo: this.topo,
      filter: this.selection.getState().filter,
      hidden: this.view.hiddenBodies(),
      clip: plane ? { normal: plane.normal, offset: plane.normal[0] * plane.origin[0] + plane.normal[1] * plane.origin[1] + plane.normal[2] * plane.origin[2] } : null,
    };
  }

  /** The item under canvas pixel (x, y), honouring the filter. */
  async pickAt(x: number, y: number): Promise<SelectionItem | null> {
    const ctx = this.pickContext();
    if (!ctx) return null;
    return pickItem(ctx, x, y);
  }

  async hoverAt(x: number, y: number): Promise<SelectionItem | null> {
    const it = await this.pickAt(x, y).catch(() => null);
    this.selection.setHover(it);
    return it;
  }

  /** A click: replace the selection, or toggle the item with `additive` (Shift/⌘). */
  async clickAt(x: number, y: number, additive: boolean): Promise<SelectionItem | null> {
    const it = await this.pickAt(x, y);
    if (!it) {
      if (!additive) this.selectItems([]);
      return null;
    }
    if (additive) {
      this.selection.toggle(it);
      this.syncDocSelection();
    } else this.selectItems([it]);
    return it;
  }

  /** Box selection over a canvas rectangle; `mode` defaults from the drag direction. */
  boxSelect(rect: Rect, options: { mode?: BoxMode; additive?: boolean; includeHidden?: boolean } = {}): SelectionItem[] {
    const frame = this.frame();
    if (!frame) return [];
    const mode = options.mode ?? boxModeOf(rect.x0, rect.x1);
    const items = boxSelect({
      frame,
      topo: this.topo,
      filter: this.selection.getState().filter,
      rect,
      mode,
      hidden: this.view.hiddenBodies(),
      ...(options.includeHidden ? { includeHidden: true } : {}),
    });
    if (options.additive) this.selection.add(items);
    else this.selection.set(items);
    this.syncDocSelection();
    return items;
  }

  /** Replace the selection (and mirror the primary into the document selection). */
  selectItems(items: readonly SelectionItem[]): void {
    this.selection.set(items);
    this.syncDocSelection();
  }

  /** Mirror the primary model item into the legacy document selection (timeline, code, chat chips). */
  syncDocSelection(): void {
    const p = this.selection.primary;
    const run = this.runCommand;
    if (!run) return;
    if (!p) {
      if (this.app.doc.getState().selection.entity || this.app.doc.getState().selection.featureId) run({ id: "selection.clear" });
      return;
    }
    if (p.kind === "face") run({ id: "selection.selectEntity", args: { body: p.body, face: p.key } });
    else if (p.kind === "edge") run({ id: "selection.selectEntity", args: { body: p.body, edge: p.key } });
    else if (p.kind === "vertex" || p.kind === "body") run({ id: "selection.selectEntity", args: { body: p.body } });
    else if (p.kind === "sketch" || p.kind === "datum") run({ id: "selection.selectFeature", args: { feature: p.feature, origin: "viewport" } });
  }

  // ─── Section ────────────────────────────────────────────────────────────────────────────

  private applySection(): void {
    const s = this.view.getState().section;
    this.adapter?.setSection(s ? sectionPlane(s) : null);
  }

  /** Start a section from a principal plane (through the scene centre) or from the primary planar face. */
  sectionFrom(base: SectionBase): SectionState {
    let state: SectionState;
    if (base === "face") {
      const it = this.selection.primary;
      if (!it || it.kind !== "face") throw new Error("select a planar face to section from");
      const b = this.topo.bodies.get(it.body);
      const g = b ? faceGeom(b, it.key) : null;
      if (!g || g.type !== "plane") throw new Error("the selected face is not planar");
      // Cut just inside the face: the material behind it shows.
      state = { base, origin: g.point, normal: g.normal, offset: 0, flipped: false, face: { body: it.body, face: it.key } };
    } else {
      // Remove the half facing the camera, so the cut (and its cap) faces the viewer.
      const back = this.adapter ? basis(this.adapter.camera()).back : ([0, -1, 1] as Vec3);
      const p = PRINCIPAL[base];
      const n: Vec3 = p[0] * back[0] + p[1] * back[1] + p[2] * back[2] < 0 ? scale(p, -1) : p;
      const c = this.sceneSphere()?.center ?? [0, 0, 0];
      state = { base, origin: [0, 0, 0], normal: n, offset: n[0] * c[0] + n[1] * c[1] + n[2] * c[2], flipped: false };
    }
    this.view.setSection(state);
    return state;
  }

  /** The offset range that keeps the plane within the scene (for the slider and the handle). */
  sectionRange(): { min: number; max: number } {
    const s = this.view.getState().section;
    const sphere = this.sceneSphere();
    if (!s || !sphere) return { min: -100, max: 100 };
    const n = s.normal;
    const c = (sphere.center[0] - s.origin[0]) * n[0] + (sphere.center[1] - s.origin[1]) * n[1] + (sphere.center[2] - s.origin[2]) * n[2];
    return { min: c - sphere.radius, max: c + sphere.radius };
  }

  dispose(): void {
    this.stopAnimation();
    for (const u of this.unsubs) u();
  }
}
