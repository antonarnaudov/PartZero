/**
 * `ViewStore`: viewport state that is not part of the document and never undoable: display mode,
 * grid/axes/origin toggles, per-body visibility and colour, the section plane, the projection and
 * the last standard view. Commands (`view.*`) change it; the viewport host renders it.
 */
import { Store } from "../store";
import { DEFAULT_BODY_DISPLAY, type BodyDisplay, type DisplayMode, type Rgb } from "./display";
import { add, normalize, scale, type Projection, type StandardView, type Vec3 } from "./view-camera";

export type SectionBase = "XY" | "XZ" | "YZ" | "face";

export interface SectionState {
  base: SectionBase;
  /** A point of the base plane (mm). */
  origin: Vec3;
  /** Unit normal of the base plane (for a face: its outward normal). */
  normal: Vec3;
  /** Offset of the cut along `normal` from `origin` (mm). */
  offset: number;
  /** Keep the other half. */
  flipped: boolean;
  /** The face it was made from (`base: "face"`). */
  face?: { body: string; face: string };
}

export interface ViewState {
  display: DisplayMode;
  grid: boolean;
  /** The corner axes gizmo drawn by the renderer. */
  axes: boolean;
  /** Origin planes, axes and point (overlay). */
  origin: boolean;
  viewCube: boolean;
  /** Per-body display state (bodies not listed use the default: visible, default colour). */
  bodies: Readonly<Record<string, BodyDisplay>>;
  section: SectionState | null;
  projection: Projection;
  /** The standard view the camera was last set to (cleared by orbiting). */
  view: StandardView | null;
}

const PREFS_KEY = "aicad.view";

interface Prefs {
  display?: DisplayMode;
  grid?: boolean;
  axes?: boolean;
  origin?: boolean;
  viewCube?: boolean;
  projection?: Projection;
}

function readPrefs(): Prefs {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) ?? "null") as Prefs | null;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writePrefs(p: Prefs): void {
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Storage unavailable: preferences are per session.
  }
}

export const PRINCIPAL: Record<Exclude<SectionBase, "face">, Vec3> = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };

/** The renderer's section plane for a section state: the removed half-space is where the normal points. */
export function sectionPlane(s: SectionState): { origin: Vec3; normal: Vec3 } {
  const n = normalize(s.normal);
  const origin = add(s.origin, scale(n, s.offset));
  return { origin, normal: s.flipped ? scale(n, -1) : n };
}

export class ViewStore extends Store<ViewState> {
  constructor(options: { persist?: boolean } = {}) {
    const p = options.persist === false ? {} : readPrefs();
    super({
      display: p.display ?? "shadedEdges",
      grid: p.grid ?? true,
      axes: p.axes ?? true,
      origin: p.origin ?? false,
      viewCube: p.viewCube ?? true,
      bodies: {},
      section: null,
      projection: p.projection ?? "perspective",
      view: "iso",
    });
    this.persist = options.persist !== false;
  }

  private readonly persist: boolean;

  private savePrefs(): void {
    if (!this.persist) return;
    const s = this.getState();
    writePrefs({ display: s.display, grid: s.grid, axes: s.axes, origin: s.origin, viewCube: s.viewCube, projection: s.projection });
  }

  setDisplay(display: DisplayMode): void {
    this.setState({ display });
    this.savePrefs();
  }

  setToggle(key: "grid" | "axes" | "origin" | "viewCube", on: boolean): void {
    this.setState({ [key]: on } as Partial<ViewState>);
    this.savePrefs();
  }

  setProjection(projection: Projection): void {
    this.setState({ projection });
    this.savePrefs();
  }

  setView(view: StandardView | null): void {
    this.setState({ view });
  }

  body(name: string): BodyDisplay {
    return this.getState().bodies[name] ?? DEFAULT_BODY_DISPLAY;
  }

  setBody(name: string, patch: Partial<BodyDisplay>): BodyDisplay {
    const next = { ...this.body(name), ...patch };
    this.setState((s) => ({ bodies: { ...s.bodies, [name]: next } }));
    return next;
  }

  setBodyColor(name: string, color: Rgb | null): void {
    this.setBody(name, { color });
  }

  /** Show only `names` (isolate); every other known body is hidden. */
  isolate(names: readonly string[], all: readonly string[]): void {
    const keep = new Set(names);
    const bodies: Record<string, BodyDisplay> = { ...this.getState().bodies };
    for (const n of all) bodies[n] = { ...(bodies[n] ?? DEFAULT_BODY_DISPLAY), visible: keep.has(n) };
    this.setState({ bodies });
  }

  showAll(): void {
    const bodies: Record<string, BodyDisplay> = {};
    for (const [n, b] of Object.entries(this.getState().bodies)) bodies[n] = { ...b, visible: true };
    this.setState({ bodies });
  }

  hiddenBodies(): Set<string> {
    return new Set(Object.entries(this.getState().bodies).filter(([, b]) => !b.visible).map(([n]) => n));
  }

  setSection(section: SectionState | null): void {
    this.setState({ section });
  }

  patchSection(patch: Partial<SectionState>): SectionState | null {
    const cur = this.getState().section;
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.setState({ section: next });
    return next;
  }
}
