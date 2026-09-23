/**
 * Read-only geometry helpers over the Feature-Graph IR (`aicad.ir/0`): plane frames (SPEC §2),
 * sketch curves in model space, hole detection by loop containment, and IR diffs for edit tasks.
 */
import type { CircleSketchCurve, Feature, IrDocument, PlaneSpec, SketchCurve, SketchFeature } from "@aicad/ir-types";

export type V2 = readonly [number, number];
export type V3 = readonly [number, number, number];

export interface PlaneFrame {
  origin: V3;
  x: V3;
  y: V3;
  normal: V3;
}

function norm3(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross3(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** SPEC §2: XY = (+X, +Y, +Z), XZ = (+X, +Z, −Y), YZ = (+Y, +Z, +X); frames use y = normal × x. */
export function planeFrame(plane: PlaneSpec): PlaneFrame {
  if (plane === "XY") return { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };
  if (plane === "XZ") return { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], normal: [0, -1, 0] };
  if (plane === "YZ") return { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], normal: [1, 0, 0] };
  const normal = norm3(plane.normal);
  const x = norm3(plane.x_dir);
  return { origin: plane.origin, x, y: cross3(normal, x), normal };
}

/** Sketch point (u, v) → model point `origin + u·x + v·y`. */
export function toModel(f: PlaneFrame, p: V2): V3 {
  return [
    f.origin[0] + p[0] * f.x[0] + p[1] * f.y[0],
    f.origin[1] + p[0] * f.x[1] + p[1] * f.y[1],
    f.origin[2] + p[0] * f.x[2] + p[1] * f.y[2],
  ];
}

export interface SketchInfo {
  part: string;
  sketch: SketchFeature;
  frame: PlaneFrame;
}

/** Non-suppressed sketches in timeline order. */
export function sketchesOf(ir: IrDocument): SketchInfo[] {
  const out: SketchInfo[] = [];
  for (const part of ir.parts) {
    for (const f of part.features) {
      if (f.type === "sketch" && !f.suppressed) out.push({ part: part.name, sketch: f, frame: planeFrame(f.plane) });
    }
  }
  return out;
}

/** Diameter of an arc or circle (undefined for lines). */
export function curveDiameter(c: SketchCurve): number | undefined {
  if (c.kind === "circle") return 2 * c.radius;
  if (c.kind === "arc") return 2 * Math.hypot(c.start[0] - c.center[0], c.start[1] - c.center[1]);
  return undefined;
}

export interface CircleInfo {
  part: string;
  sketch: string;
  id: string;
  diameter: number;
  /** Centre in sketch coordinates. */
  center2: V2;
  /** Centre in model coordinates. */
  center3: V3;
  /** Unit direction of the hole axis (the sketch normal). */
  axis: V3;
}

/** Every circle of every non-suppressed sketch. */
export function circlesOf(ir: IrDocument): CircleInfo[] {
  const out: CircleInfo[] = [];
  for (const s of sketchesOf(ir)) {
    for (const c of s.sketch.curves) {
      if (c.kind !== "circle") continue;
      out.push({
        part: s.part,
        sketch: s.sketch.name,
        id: c.id,
        diameter: 2 * c.radius,
        center2: c.center,
        center3: toModel(s.frame, c.center),
        axis: s.frame.normal,
      });
    }
  }
  return out;
}

/** Polyline approximation of a line or arc (arcs: 32 segments), for point-in-loop tests. */
function segmentsOf(c: SketchCurve): [V2, V2][] {
  if (c.kind === "line") return [[c.start, c.end]];
  if (c.kind === "circle") return [];
  const r = Math.hypot(c.start[0] - c.center[0], c.start[1] - c.center[1]);
  const a0 = Math.atan2(c.start[1] - c.center[1], c.start[0] - c.center[0]);
  const a1 = Math.atan2(c.end[1] - c.center[1], c.end[0] - c.center[0]);
  let sweep = a1 - a0;
  if (c.ccw) {
    while (sweep <= 0) sweep += 2 * Math.PI;
  } else {
    while (sweep >= 0) sweep -= 2 * Math.PI;
  }
  const n = 32;
  const pts: V2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push(i === 0 ? c.start : i === n ? c.end : [c.center[0] + r * Math.cos(a), c.center[1] + r * Math.sin(a)]);
  }
  const segs: [V2, V2][] = [];
  for (let i = 0; i < n; i++) segs.push([pts[i]!, pts[i + 1]!]);
  return segs;
}

/**
 * Number of the sketch's other loops that contain point `p`: ray casting over every line/arc
 * (closed loops, so the crossing parity sums per loop) plus circle containment.
 */
function containmentDepth(sketch: SketchFeature, p: V2, exceptId: string): number {
  let crossings = 0;
  let depth = 0;
  for (const c of sketch.curves) {
    if (c.id === exceptId) continue;
    if (c.kind === "circle") {
      if (Math.hypot(p[0] - c.center[0], p[1] - c.center[1]) < c.radius) depth++;
      continue;
    }
    for (const [a, b] of segmentsOf(c)) {
      if (a[1] > p[1] !== b[1] > p[1]) {
        const x = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
        if (x > p[0]) crossings++;
      }
    }
  }
  // Each line/arc loop around p contributes an odd number of crossings; parity is what matters.
  return depth + (crossings % 2);
}

/**
 * Circles that are holes: they lie inside an odd number of the sketch's other loops (SPEC §3.2:
 * a loop at odd depth is a hole of the region around it). Curves never cross in a valid sketch,
 * so a circle is inside a loop exactly when any point *on* it is (its centre would not do:
 * the centre of a washer's rim lies inside the bore).
 */
export function holeCircles(sketch: SketchFeature): CircleSketchCurve[] {
  return sketch.curves.filter(
    (c): c is CircleSketchCurve =>
      c.kind === "circle" && containmentDepth(sketch, [c.center[0] + c.radius, c.center[1]], c.id) % 2 === 1,
  );
}

// ─── IR diffs (T4 edit tasks) ──────────────────────────────────────────────────────────────

const FEATURE_DEFAULTS: Record<string, unknown> = { suppressed: false, direction: "normal", op: "new_body", regions: "all" };

function numbersClose(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => numbersClose(x, b[i]));
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return (
      ka.length === kb.length &&
      ka.every((k, i) => k === kb[i] && numbersClose((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return a === b;
}

/** A feature without identity (`id`, `name`) or curves, with defaults filled in. */
function featureShape(f: Feature): Record<string, unknown> {
  const out: Record<string, unknown> = { ...FEATURE_DEFAULTS };
  for (const [k, v] of Object.entries(f)) {
    if (k === "id" || k === "name" || k === "curves") continue;
    out[k] = v;
  }
  if (f.type === "sketch") {
    delete out.direction;
    delete out.op;
    delete out.regions;
  }
  return out;
}

function featuresByName(ir: IrDocument): Map<string, Feature> {
  const m = new Map<string, Feature>();
  for (const part of ir.parts) for (const f of part.features) m.set(f.name, f);
  return m;
}

export interface IrChange {
  what: "added" | "removed" | "modified";
  /** `sketch.curve` for curves, the feature name for features. */
  path: string;
}

/**
 * Sketch curves that differ between `before` and `after`, matched by sketch name + curve id:
 * added, removed, or with different geometry. A renamed sketch counts as all-removed + all-added.
 */
export function curveChanges(before: IrDocument, after: IrDocument): IrChange[] {
  const out: IrChange[] = [];
  const a = featuresByName(before);
  const b = featuresByName(after);
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const name of names) {
    const fa = a.get(name);
    const fb = b.get(name);
    const ca = new Map((fa?.type === "sketch" ? fa.curves : []).map((c) => [c.id, c] as const));
    const cb = new Map((fb?.type === "sketch" ? fb.curves : []).map((c) => [c.id, c] as const));
    for (const id of [...new Set([...ca.keys(), ...cb.keys()])].sort()) {
      const x = ca.get(id);
      const y = cb.get(id);
      const path = `${name}.${id}`;
      if (!x) out.push({ what: "added", path });
      else if (!y) out.push({ what: "removed", path });
      else if (!numbersClose(x, y)) out.push({ what: "modified", path });
    }
  }
  return out;
}

/**
 * Features (by name) that were added, removed, or changed in anything but their curves:
 * type, plane, sketch reference, distance, direction, axis, angle, suppression.
 */
export function featureChanges(before: IrDocument, after: IrDocument): IrChange[] {
  const out: IrChange[] = [];
  const a = featuresByName(before);
  const b = featuresByName(after);
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const fa = a.get(name);
    const fb = b.get(name);
    if (!fa) out.push({ what: "added", path: name });
    else if (!fb) out.push({ what: "removed", path: name });
    else if (!numbersClose(featureShape(fa), featureShape(fb))) out.push({ what: "modified", path: name });
  }
  return out;
}

/** All feature names, sorted. */
export function featureNames(ir: IrDocument): string[] {
  return ir.parts.flatMap((p) => p.features.map((f) => f.name)).sort();
}
