/**
 * The viewport's tessellation (the owner's rule, 2026-09-25: circles look round at normal zoom).
 *
 * Forge's own default (0.05 mm, 0.35 rad ≈ 20°) cuts a hole into 18 visible facets. The viewport
 * asks for less than half a device pixel of chordal error when the part is zoomed in 2× from the
 * fitted view, and for at most 10° between facet normals, so every full circle has at least 36
 * segments however small it is. The chordal tolerance moves in fixed steps, so resizing the window
 * or small edits don't re-tessellate the part; a step change does (one re-evaluation).
 *
 * Measured on this Mac (forge-web in Node, median of 12, 2026-09-25): the 25-feature R25 bench part
 * evaluates in 46 ms at Forge's default, 73–75 ms at 0.01–0.05 mm and 10°, and 136 ms at the print
 * tolerances (0.01 mm, 5°). The two starter examples cost the same at every setting (24 ms, 60 ms).
 * Files and the printer keep {@link PRINT_TESSELLATION}.
 */
import type { TessellationOptions } from "../engine/types";

/** At most 10° between neighbouring facet normals: a full circle has at least 36 segments. */
export const DISPLAY_ANGULAR_DEFLECTION = Math.PI / 18;

/** Chordal tolerances the viewport uses (mm), coarsest first. */
export const DISPLAY_CHORDAL_STEPS: readonly number[] = Object.freeze([0.05, 0.035, 0.025, 0.018, 0.0125, 0.01]);

/**
 * Before the viewport knows the part's size: the finest step, which is what typical maker parts
 * (20–150 mm on a laptop screen) get anyway.
 */
export const DEFAULT_DISPLAY_TESSELLATION: Readonly<Required<TessellationOptions>> = Object.freeze({
  chordalDeflection: 0.01,
  angularDeflection: DISPLAY_ANGULAR_DEFLECTION,
});

/** How far past a step's bounds the target must move before the step changes (resize jitter, bbox drift). */
const HYSTERESIS = 0.15;

/**
 * The display tolerances for a part whose bounding sphere is `sizeMm` across, drawn in a viewport
 * whose short side is `viewportPx` CSS pixels at `dpr` device pixels per CSS pixel. `current` (the
 * chordal step in use) is kept while the target stays near its bounds.
 */
export function displayTessellation(sizeMm: number, viewportPx: number, dpr = 1, current?: number): Required<TessellationOptions> {
  if (!(sizeMm > 0) || !(viewportPx > 0) || !Number.isFinite(sizeMm) || !Number.isFinite(viewportPx)) return { ...DEFAULT_DISPLAY_TESSELLATION };
  const steps = DISPLAY_CHORDAL_STEPS;
  const pxPerMm = (viewportPx * Math.max(1, dpr || 1)) / sizeMm; // device pixels per mm in the fitted view
  const target = 0.5 / (2 * pxPerMm); // half a device pixel, zoomed in 2×
  const finest = steps[steps.length - 1]!;
  const step = steps.find((s) => s <= target) ?? finest;
  if (current !== undefined && current !== step) {
    const i = steps.indexOf(current);
    const coarser = i > 0 ? steps[i - 1]! : Number.POSITIVE_INFINITY;
    const lower = i === steps.length - 1 ? 0 : current * (1 - HYSTERESIS);
    if (i >= 0 && target >= lower && target < coarser * (1 + HYSTERESIS)) return { chordalDeflection: current, angularDeflection: DISPLAY_ANGULAR_DEFLECTION };
  }
  return { chordalDeflection: step, angularDeflection: DISPLAY_ANGULAR_DEFLECTION };
}

/** Segments a full circle gets at an angular tolerance (what Forge's curve sampler guarantees at least). */
export function minCircleSegments(angularDeflection: number): number {
  return Math.ceil((2 * Math.PI) / angularDeflection - 1e-9);
}

export function sameTessellation(a: TessellationOptions | null | undefined, b: TessellationOptions | null | undefined): boolean {
  return (a?.chordalDeflection ?? null) === (b?.chordalDeflection ?? null) && (a?.angularDeflection ?? null) === (b?.angularDeflection ?? null);
}
