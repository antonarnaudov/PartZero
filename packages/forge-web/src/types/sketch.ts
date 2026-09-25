/**
 * Types of the interactive sketch session (`@aicad/forge-web/sketch`, plan contract C5). They
 * mirror `forge_sketch::session` (forge/crates/forge-sketch/src/session.rs) field for field;
 * the Rust side is the definition, these are its JSON shapes.
 */
import type { v1 } from "@aicad/ir-types";

/** A 2D point in sketch coordinates (mm). */
export type P2 = [number, number];

/** A curve with literal geometry (the session's working form, SPEC-v1 §4.4 `solved`). */
export type LiteralCurve =
  | { kind: "line"; id: string; start: P2; end: P2; construction?: boolean }
  | { kind: "arc"; id: string; start: P2; end: P2; center: P2; ccw: boolean; construction?: boolean }
  | { kind: "circle"; id: string; center: P2; radius: number; construction?: boolean }
  | { kind: "point"; id: string; at: P2; construction?: boolean };

/** One edit of a sketch: the command layer's `sketchEdit` vocabulary (plan §2.2). */
export type SketchEdit =
  | { op: "addCurve"; curve: LiteralCurve }
  | { op: "removeCurve"; id: string }
  | { op: "replaceCurve"; curve: LiteralCurve }
  | { op: "setConstruction"; id: string; construction: boolean }
  | { op: "addConstraint"; constraint: v1.Constraint }
  | { op: "removeConstraint"; id: string }
  | { op: "setDimension"; id: string; value?: v1.Scalar; driving?: boolean }
  | { op: "moveTo"; point: string; to: P2 };

export interface ApplyOptions {
  /** Commit even when a solved sketch becomes conflicting. */
  allowConflict?: boolean;
  /** Commit constraints implied by others. */
  allowRedundant?: boolean;
  /** Drop the batch's constraints that turn out redundant (auto-constraints of a gesture). */
  dropRedundant?: boolean;
}

export interface SessionError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  path?: string;
}

export type SolveStatus = "under_constrained" | "fully_constrained" | "over_constrained_redundant" | "conflict" | "failed_to_converge";

export type ConstraintState = "satisfied" | "redundant" | "partially_redundant" | "conflicting" | "unsatisfied" | "reference";

export interface PointDof {
  dof: number;
  freeDirection?: P2;
}

export interface EntityDof {
  id: string;
  kind: "line" | "arc" | "circle" | "point";
  /** The curve's own DOF: point 0–2, line 0–4, circle 0–3, arc 0–5. */
  dof: number;
  /** `at` (point), `start`/`end` (line, arc), `center` (arc, circle). */
  points: Partial<Record<"at" | "start" | "end" | "center", PointDof>>;
  radiusFree?: boolean;
}

export interface ConstraintInfo {
  id: string;
  type: v1.Constraint["type"];
  state?: ConstraintState;
  driving?: boolean;
  value?: number;
  expr?: string;
  measured?: number;
}

export interface ConflictInfo {
  constraints: string[];
  suggestedRemoval: string;
  verifiedMinimal: boolean;
  explanation: string;
}

export interface RedundancyInfo {
  constraint: string;
  partial: boolean;
  impliedBy: string[];
  explanation: string;
}

export interface LoopEdge {
  id: string;
  reversed: boolean;
}

export interface RegionInfo {
  area: number;
  outer: LoopEdge[];
  holes: LoopEdge[][];
}

export interface ProfileInfo {
  regions: RegionInfo[];
  error?: SessionError;
}

export interface SketchSnapshot {
  revision: number;
  sketch: string;
  /** Solved geometry when `ok`; otherwise the welded stored guess (draw it greyed out). */
  curves: LiteralCurve[];
  ok: boolean;
  status?: SolveStatus;
  dof?: number;
  error?: SessionError;
  entities: EntityDof[];
  constraints: ConstraintInfo[];
  conflicts: ConflictInfo[];
  redundant: RedundancyInfo[];
  /** Weld groups, representative first. */
  welds: string[][];
  profile: ProfileInfo;
  explanation: string;
  canUndo: boolean;
  canRedo: boolean;
}

export type ApplyResult =
  | { ok: true; snapshot: SketchSnapshot }
  | { ok: false; error: SessionError; candidate?: SketchSnapshot | null };

export interface DragSpec {
  /** A point reference (`p`, `l.start`, `a.center`) or a curve id (moves the whole curve). */
  target: string;
  /** Where the pointer grabbed it (sketch coordinates). */
  grab: P2;
  /** `"rim"` on a circle: drag its radius. */
  mode?: "rim";
}

export interface DragFrame {
  converged: boolean;
  curves: LiteralCurve[];
  targetError: number;
}

export type DragResult = { ok: true; frame: DragFrame } | { ok: false; error: SessionError };

export type ValueResult = { ok: true; value: number } | { ok: false; error: SessionError };

export interface FinishResult {
  /** The IR v1 sketch feature, canonical JSON. */
  feature: v1.SketchFeature;
  /** Evaluates (regions included) and validates. */
  ok: boolean;
  error?: SessionError;
  regions: number;
  status?: SolveStatus;
  dof?: number;
  warnings: Array<{ code: string; severity: string; message: string }>;
  validation: SessionError[];
  /** Every committed edit since load (the `sketchEdit` op's list). */
  edits: SketchEdit[];
  /** Parameters defined during the session: `addParam` them before the feature. */
  params: v1.Parameter[];
  /** Set when loading converted an explicit sketch (`convertSketch`): member ids that became
   * curve ids (rewrite later references), and what could not stay parametric. */
  conversion?: { renames: Array<[string, string]>; notes: string[] };
}

export interface SketchLoadRequest {
  sketch: v1.SketchFeature | Omit<v1.SketchFeature, "type">;
  /** The IR v1 document whose parameters the sketch's expressions use. */
  document?: v1.IrDocument;
  /** Part id (default: the first part). */
  part?: string;
  /** Convert an explicit sketch with compound curves or expressions (default true). */
  convert?: boolean;
}
