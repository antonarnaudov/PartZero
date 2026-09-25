/**
 * `ViewStore`: viewport state that is not part of the document and never undoable: display mode,
 * grid/axes/origin toggles, per-body visibility and colour, the section plane, the projection and
 * the last standard view. Commands (`view.*`) change it; the viewport host renders it.
 */
import { Store } from "../store";
import { DEFAULT_BODY_DISPLAY, type BodyDisplay, type DisplayMode, type Rgb } from "./display";
import { NAV_PRESETS, type NavPreset } from "./navigation";
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
  /** Draw every sketch's curves (the selected sketch is always drawn). */
  sketches: boolean;
  /** Per-body display state (bodies not listed use the default: visible, default colour). */
  bodies: Readonly<Record<string, BodyDisplay>>;
  section: SectionState | null;
  projection: Projection;
  /** The standard view the camera was last set to (cleared by orbiting). */
  view: StandardView | null;
  /** Settings ▸ Navigation: how wheel events are read (auto-detect, or a forced device). */
  navigation: NavPreset;
}

const PREFS_KEY = "aicad.view";

interface Prefs {
  display?: DisplayMode;
  grid?: boolean;
  axes?: boolean;
  origin?: boolean;
  viewCube?: boolean;
  sketches?: boolean;
  projection?: Projection;
  navigation?: NavPreset;
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
      sketches: p.sketches ?? false,
      bodies: {},
      section: null,
      projection: p.projection ?? "perspective",
      view: "iso",
      navigation: p.navigation && (NAV_PRESETS as readonly string[]).includes(p.navigation) ? p.navigation : "auto",
    });
    this.persist = options.persist !== false;
  }

  private readonly persist: boolean;

  private savePrefs(): void {
    if (!this.persist) return;
    const s = this.getState();
    writePrefs({ display: s.display, grid: s.grid, axes: s.axes, origin: s.origin, viewCube: s.viewCube, sketches: s.sketches, projection: s.projection, navigation: s.navigation });
  }

  setDisplay(display: DisplayMode): void {
    this.setState({ display });
    this.savePrefs();
  }

  setToggle(key: "grid" | "axes" | "origin" | "viewCube" | "sketches", on: boolean): void {
    this.setState({ [key]: on } as Partial<ViewState>);
    this.savePrefs();
  }

  setProjection(projection: Projection): void {
    this.setState({ projection });
    this.savePrefs();
  }

  setNavigation(navigation: NavPreset): void {
    this.setState({ navigation });
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

  /**
   * Another document was loaded: drop the state that belongs to the previous model (per-body
   * visibility and colour are keyed by body name, and the section plane's offset was computed
   * from the old model's centre). The preferences (display mode, toggles, projection) stay.
   */
  resetDocumentState(): void {
    const s = this.getState();
    if (Object.keys(s.bodies).length === 0 && s.section === null) return;
    this.setState({ bodies: {}, section: null });
  }

  patchSection(patch: Partial<SectionState>): SectionState | null {
    const cur = this.getState().section;
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.setState({ section: next });
    return next;
  }
}
