/**
 * Display modes, per-body visibility and colour: what the viewport draws, independent of the
 * document (never undoable, never in the IR).
 *
 * | Mode | Faces | Edges | Notes |
 * |---|---|---|---|
 * | `shaded` | shaded | none | silhouettes off too |
 * | `shadedEdges` | shaded | B-rep edges + silhouettes | the default |
 * | `wireframe` | none | every edge, hidden ones too | only edges can be picked |
 * | `hiddenLine` | flat, background colour (occluding) | visible edges + silhouettes | needs forge-render display modes |
 * | `xray` | semi-transparent | every edge shows through | needs forge-render display modes |
 *
 * `wireframe` is emulated when the renderer lacks native display modes: the bodies are sent
 * without triangles, so only their exact edge polylines are drawn (and picked).
 */
import type { RenderBody } from "../engine/types";

export const DISPLAY_MODES = ["shaded", "shadedEdges", "wireframe", "hiddenLine", "xray"] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

export const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  shaded: "Shaded",
  shadedEdges: "Shaded with Edges",
  wireframe: "Wireframe",
  hiddenLine: "Hidden Line",
  xray: "X-ray",
};

/** Modes a renderer without native display modes can still show (by emulation or options). */
export const EMULATED_MODES: readonly DisplayMode[] = ["shaded", "shadedEdges", "wireframe"];

export type Rgb = [number, number, number];

export interface BodyDisplay {
  visible: boolean;
  /** sRGB 0..1, or null for the default body colour. */
  color: Rgb | null;
}

export const DEFAULT_BODY_DISPLAY: BodyDisplay = { visible: true, color: null };

/** Body colour swatches (sRGB hex), chosen to read well on both themes and match common filaments. */
export const BODY_SWATCHES: ReadonlyArray<{ name: string; hex: string }> = [
  { name: "Default", hex: "" },
  { name: "White", hex: "#eceae4" },
  { name: "Black", hex: "#3a3c40" },
  { name: "Gray", hex: "#8e939a" },
  { name: "Red", hex: "#d4524a" },
  { name: "Orange", hex: "#ec8a3a" },
  { name: "Yellow", hex: "#e8c64a" },
  { name: "Green", hex: "#5aa865" },
  { name: "Teal", hex: "#3fa7a0" },
  { name: "Blue", hex: "#4a82d4" },
  { name: "Purple", hex: "#8a63c8" },
  { name: "Pink", hex: "#df7fb0" },
];

/** `#rrggbb` → sRGB 0..1, or null. */
export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(c: Rgb): string {
  const h = (x: number): string => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

export interface DisplayInput {
  bodies: readonly RenderBody[];
  states: ReadonlyMap<string, BodyDisplay>;
  mode: DisplayMode;
  /** Modes the renderer draws natively (else emulated where possible). */
  nativeModes: readonly DisplayMode[];
}

/** The bodies to hand to the renderer: hidden bodies removed, colours applied, wireframe emulated. */
export function displayBodies(i: DisplayInput): RenderBody[] {
  const emulateWire = i.mode === "wireframe" && !i.nativeModes.includes("wireframe");
  const out: RenderBody[] = [];
  for (const b of i.bodies) {
    const s = i.states.get(b.name);
    if (s && !s.visible) continue;
    let body = b;
    if (s?.color && !b.color) body = { ...body, color: s.color };
    if (emulateWire) body = { ...body, indices: new Uint32Array(0), faceRanges: [] };
    out.push(body);
  }
  return out;
}

/** Renderer edge flags for a mode (the existing `setOptions` keys). */
export function edgeFlags(mode: DisplayMode): { edges: boolean; silhouettes: boolean } {
  return mode === "shaded" ? { edges: false, silhouettes: false } : { edges: true, silhouettes: true };
}

/** The mode the renderer can actually show for a requested one (unavailable modes fall back). */
export function effectiveMode(mode: DisplayMode, nativeModes: readonly DisplayMode[]): DisplayMode {
  if (nativeModes.includes(mode) || EMULATED_MODES.includes(mode)) return mode;
  return "shadedEdges";
}

export function modeAvailable(mode: DisplayMode, nativeModes: readonly DisplayMode[]): boolean {
  return nativeModes.includes(mode) || EMULATED_MODES.includes(mode);
}
