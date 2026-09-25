/**
 * Manipulator handles (FULL-MODELING-PLAN §2.6): the gizmo core tools build on. A tool describes
 * its handles as {@link HandleSpec}s bound to its input fields; the viewport draws them (a DOM/SVG
 * overlay from the camera, as the plan decides) and reports drags as values, already snapped and
 * clamped. The tool turns the final value into its op (`setField` / `setParam`) — handles never
 * edit the document themselves.
 *
 * | Kind | Drives | Drag math |
 * |---|---|---|
 * | `linear` | a distance along `axis` (translate arrow; section/datum offset) | pointer ray ↔ axis line |
 * | `pushPull` | a face's distance along its normal (extrude depth, offset) | as `linear`, drawn as a thick arrow on the face |
 * | `rotate` | an angle about `axis` (revolve, rotate) | pointer ray ∩ the ring's plane, angle from `ref` |
 * | `radius` | a radius from `origin` along `axis` (fillet, hole size) | pointer ray ↔ the radial line |
 */
import type { Vec3 } from "../view-camera";

export const HANDLE_KINDS = ["linear", "pushPull", "rotate", "radius"] as const;
export type HandleKind = (typeof HANDLE_KINDS)[number];

export interface HandleSpec {
  /** Unique within one `show` call; tools use the input field path (`distance`, `r`). */
  id: string;
  kind: HandleKind;
  /** Anchor (mm): where value 0 is (linear/pushPull/radius), or the ring centre (rotate). */
  origin: Vec3;
  /** Unit direction (linear/pushPull/radius) or rotation axis (rotate). */
  axis: Vec3;
  /** Rotate only: the direction of angle 0, perpendicular to `axis`. */
  ref?: Vec3;
  /** Current value: mm (linear/pushPull/radius) or degrees (rotate). */
  value: number;
  /** Feasible range; drags clamp to it and say why they stopped. */
  min?: number;
  max?: number;
  /** Why the range ends, e.g. "the wall would vanish" (shown when a drag clamps). */
  limitReason?: string;
  /** Snap increment (default 1 mm / 15°) and with Shift (default 0.5 mm / 1°). */
  step?: number;
  fineStep?: number;
  label?: string;
  /** Ring radius for `rotate` handles, or arrow length for the others (mm); defaults scale with the view. */
  size?: number;
}

export type HandlePhase = "start" | "drag" | "end" | "cancel";

export interface HandleChange {
  id: string;
  value: number;
  phase: HandlePhase;
  /** Set when the value was clamped to `min`/`max`. */
  clamped?: "min" | "max";
}

export interface HandleListener {
  (change: HandleChange): void;
}

/** The unit of a handle's value. */
export function handleUnit(kind: HandleKind): "mm" | "°" {
  return kind === "rotate" ? "°" : "mm";
}
