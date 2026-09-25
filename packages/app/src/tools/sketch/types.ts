/**
 * The sketch tool contract: a tool turns pointer gestures (in sketch coordinates, already
 * snapped through {@link ToolApi.snap}) into **one** edit batch per gesture, committed through
 * {@link ToolApi.commit} (plan §2.7 step 4: a gesture becomes one `sketchEdit`).
 */
import type { v1 } from "@aicad/ir-types";
import type { ApplyOptions, ApplyResult, SketchEdit, SketchSnapshot } from "../../sketch/engine-types";
import type { SketchSel } from "../../sketch/constraints";
import type { DimProposal } from "../../sketch/dimension";
import type { LiteralCurve, P2 } from "../../sketch/geom";
import type { IdAllocator } from "../../sketch/ids";
import type { Guide, SnapResult } from "../../sketch/snap";

export type ToolId =
  | "select"
  | "line"
  | "rect2"
  | "rectCenter"
  | "circleCenter"
  | "circle2"
  | "circle3"
  | "arc3"
  | "arcTangent"
  | "arcCenter"
  | "slot"
  | "polygon"
  | "point"
  | "dimension"
  | "trim"
  | "extend"
  | "offset"
  | "mirror"
  | "fillet"
  | "chamfer";

export interface PointerIn {
  /** CSS pixels relative to the overlay. */
  px: P2;
  button: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  /** 2 on a double click. */
  clicks: number;
}

export interface SnapOptions {
  anchor?: P2 | null;
  tangent?: { curve: string; dir: P2 } | null;
  excludeRefs?: ReadonlySet<string>;
  excludeCurves?: ReadonlySet<string>;
}

export interface ToolPreview {
  /** Rubber-band geometry (not committed). */
  curves: LiteralCurve[];
  snap: SnapResult | null;
  guides: Guide[];
  labels: Array<{ at: P2; text: string }>;
  /** Curves to highlight (trim piece, fillet corner, mirror axis). */
  highlight: string[];
  /** Points to mark (cut points, corners). */
  marks: P2[];
  box?: { from: P2; to: P2; crossing: boolean } | null;
}

export const EMPTY_PREVIEW: ToolPreview = { curves: [], snap: null, guides: [], labels: [], highlight: [], marks: [], box: null };

export interface ToolApi {
  curves(): readonly LiteralCurve[];
  feature(): v1.SketchFeature;
  snapshot(): SketchSnapshot;
  /** Snap tolerance in mm. */
  tol(): number;
  mmPerPx(): number;
  snap(p: P2, e: PointerIn, o?: SnapOptions): SnapResult;
  hitCurve(p: P2): LiteralCurve | null;
  hitPoint(p: P2): { ref: string; point: P2 } | null;
  ids(): IdAllocator;
  /** New curves are construction geometry. */
  construction(): boolean;
  /**
   * Commit a gesture: `core` edits with the `auto` constraints its snaps inferred. Newly
   * redundant auto-constraints are dropped; if the auto-constraints conflict, the core is
   * committed alone. Returns the result (a failure was already reported to the user).
   */
  commit(core: SketchEdit[], auto?: SketchEdit[], opts?: ApplyOptions): ApplyResult;
  notify(kind: "info" | "warning" | "error", text: string): void;
  selection(): SketchSel[];
  setSelection(sel: SketchSel[]): void;
  /** Open the inline dimension editor for a new dimension placed at `at`. */
  openDimension(p: DimProposal, at: P2): void;
  /** Drag the geometry (select tool). */
  dragBegin(target: string, grab: P2, mode?: "rim"): boolean;
  dragTo(p: P2): void;
  dragEnd(): void;
  dragCancel(): void;
}

export interface SketchTool {
  readonly id: ToolId;
  /** The status-bar hint for the current step. */
  hint(): string;
  down(p: P2, e: PointerIn, api: ToolApi): void;
  move(p: P2, e: PointerIn, api: ToolApi): void;
  up(p: P2, e: PointerIn, api: ToolApi): void;
  /** Esc: clear the partial gesture (true), or nothing to clear (false: leave the tool). */
  escape(api: ToolApi): boolean;
  /** Enter: finish a chain (true when consumed). */
  enter?(api: ToolApi): boolean;
  preview(): ToolPreview;
  /** A number typed while drawing (length, diameter, sides, radius…), with its raw text. */
  typed?(value: number, raw: string, api: ToolApi): boolean;
  /** What a typed number means now (`Length`, `Diameter`, …), or null when typing does nothing. */
  typedLabel?(): string | null;
}
