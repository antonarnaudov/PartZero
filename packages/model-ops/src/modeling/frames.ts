/**
 * Plane frames as the engine computes them (SPEC-v1 §3.1), so tools can turn a picked world point
 * into the (u, v) coordinates a feature stores, and place handles in 3D:
 * - the origin planes `XY`, `XZ`, `YZ` (v0 §2);
 * - a **face frame**: outward normal `n`; origin = the world origin projected onto the plane; `x` =
 *   the world axis with the smallest `|n · axis|` (ties X, Y, Z), projected and normalised; `y = n × x`;
 * - a datum plane's evaluated frame (the report's `datum` block);
 * - a sketch's frame: its plane's, read from the document and the report (a face plane's probe gives
 *   the face's normal and a point on it).
 */
import type { DocJson } from "../doc.js";
import { featureOf, type ReportLike } from "./keys.js";

export type V3 = [number, number, number];

export interface Frame {
  origin: V3;
  x: V3;
  y: V3;
  normal: V3;
}

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s + 0, a[1] * s + 0, a[2] * s + 0];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1] + 0, a[2] * b[0] - a[0] * b[2] + 0, a[0] * b[1] - a[1] * b[0] + 0];
export const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export function unit(a: V3): V3 | null {
  const l = norm(a);
  return l > 1e-12 && Number.isFinite(l) ? scale(a, 1 / l) : null;
}

/** The origin planes' frames (v0 §2): XY (x +X, n +Z), XZ (x +X, y +Z, n −Y), YZ (x +Y, y +Z, n +X). */
export const NAMED_FRAMES: Readonly<Record<"XY" | "XZ" | "YZ", Frame>> = {
  XY: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] },
  XZ: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], normal: [0, -1, 0] },
  YZ: { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], normal: [1, 0, 0] },
};

const ANGULAR_TOLERANCE = 1e-9;

/** The face frame (SPEC-v1 §3.1) of a plane with outward normal `n` through `point`. */
export function faceFrame(normal: V3, point: V3): Frame | null {
  const n = unit(normal);
  if (!n) return null;
  const origin = sub([0, 0, 0], scale(n, dot(sub([0, 0, 0], point), n)));
  const axes: V3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const d = axes.map((a) => Math.abs(dot(n, a)));
  const min = Math.min(...d);
  const pick = d.findIndex((v) => v <= min + ANGULAR_TOLERANCE);
  const a = axes[pick]!;
  const x = unit(sub(a, scale(n, dot(a, n))));
  if (!x) return null;
  return { origin, x, y: cross(n, x), normal: n };
}

/** World point → (u, v) in a frame. */
export function toUv(f: Frame, p: V3): [number, number] {
  const d = sub(p, f.origin);
  return [dot(d, f.x), dot(d, f.y)];
}

/** (u, v) in a frame → world point. */
export function fromUv(f: Frame, uv: readonly [number, number]): V3 {
  return add(f.origin, add(scale(f.x, uv[0]), scale(f.y, uv[1])));
}

/** Round to a tidy decimal (picked coordinates carry float noise): 1e-6 mm. */
export function tidy(v: number, digits = 6): number {
  const r = Number(v.toFixed(digits));
  return Object.is(r, -0) ? 0 : r;
}

type ReportFeature = NonNullable<ReportLike["features"]>[number];

function reportFeature(report: ReportLike | null, id: string): ReportFeature | null {
  return report?.features?.find((f) => f.feature_id === id) ?? null;
}

/** The evaluated frame of a datum plane (the report's `datum` block). */
export function datumFrame(report: ReportLike | null, id: string): Frame | null {
  const d = reportFeature(report, id)?.["datum"] as { origin?: V3; x?: V3; y?: V3; normal?: V3 } | undefined;
  if (!d?.origin || !d.x || !d.y || !d.normal) return null;
  return { origin: d.origin, x: d.x, y: d.y, normal: d.normal };
}

/** The probe (point, normal) of a feature's resolved face reference at `field` (`/plane/face`, `/on/face`). */
export function refProbe(report: ReportLike | null, id: string, field: string): { point: V3; normal?: V3 } | null {
  const refs = reportFeature(report, id)?.["refs"] as Array<{ field: string; members?: Array<{ probe?: { point?: V3; normal?: V3 } }> }> | undefined;
  const probe = refs?.find((r) => r.field === field)?.members?.[0]?.probe;
  if (!probe?.point) return null;
  return { point: probe.point, ...(probe.normal ? { normal: probe.normal } : {}) };
}

function numberVec(v: unknown): V3 | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === "number")) return null;
  return [v[0], v[1], v[2]] as V3;
}

/**
 * The frame of a PlaneRef as written in feature `id` at `field` (`/plane`, `/on`, `/from`), with the
 * report of the current document: named planes, explicit literal frames, face planes (from the
 * resolved probe) and datum planes. Null when it cannot be known without evaluating (an unresolved
 * face, an expression-valued frame).
 */
export function planeFrame(doc: DocJson, report: ReportLike | null, plane: unknown, owner?: { id: string; field: string }): Frame | null {
  if (plane === "XY" || plane === "XZ" || plane === "YZ") return NAMED_FRAMES[plane];
  if (typeof plane !== "object" || plane === null) return null;
  const p = plane as Record<string, unknown>;
  if (typeof p["datum"] === "string") {
    const f = featureOf(doc, p["datum"]);
    return f ? datumFrame(report, f.id) : null;
  }
  if (p["face"] !== undefined) {
    if (!owner) return null;
    const probe = refProbe(report, owner.id, `${owner.field}/face`);
    if (!probe?.normal) return null;
    return faceFrame(probe.normal, probe.point);
  }
  const origin = numberVec(p["origin"]);
  const normal = numberVec(p["normal"]);
  const xDir = numberVec(p["x_dir"]);
  if (origin && normal && xDir) {
    const n = unit(normal);
    const x = unit(xDir);
    if (!n || !x) return null;
    return { origin, x, y: cross(n, x), normal: n };
  }
  return null;
}

/** A sketch's frame (its `plane`), or null when unknown. */
export function sketchFrame(doc: DocJson, report: ReportLike | null, sketchId: string): Frame | null {
  const f = featureOf(doc, sketchId);
  if (!f || f.type !== "sketch") return null;
  return planeFrame(doc, report, f["plane"], { id: f.id, field: "/plane" });
}

/** One solved sketch curve as the report lists it (`sketch.solved`: compound members expanded, literal). */
export interface SolvedCurve {
  kind: string;
  id: string;
  start?: [number, number];
  end?: [number, number];
  center?: [number, number];
  radius?: number;
  at?: [number, number];
  construction?: boolean;
}

/** A sketch's solved curves (null when the sketch did not evaluate). */
export function solvedCurves(report: ReportLike | null, sketchId: string): SolvedCurve[] | null {
  const s = reportFeature(report, sketchId)?.["sketch"] as { solved?: SolvedCurve[] } | undefined;
  return Array.isArray(s?.solved) ? s.solved : null;
}

/** The hole instances of a hole feature in the report (`at`, `center`, `axis`, `d`). */
export function holeInstances(report: ReportLike | null, holeId: string): Array<{ at: string; center: V3; axis: V3; d: number }> {
  const h = reportFeature(report, holeId)?.["holes"];
  return Array.isArray(h) ? (h as Array<{ at: string; center: V3; axis: V3; d: number }>) : [];
}

/** The hole position nearest to a world point (distance to its axis line), for a hole face picked in the viewport. */
export function nearestHolePosition(report: ReportLike | null, holeId: string, point: V3 | undefined): string | null {
  const inst = holeInstances(report, holeId);
  if (inst.length === 0) return null;
  if (inst.length === 1 || !point) return inst[0]!.at;
  let best: { at: string; d: number } | null = null;
  for (const h of inst) {
    const a = unit(h.axis) ?? [0, 0, 1];
    const r = sub(point, h.center);
    const off = norm(sub(r, scale(a, dot(r, a))));
    if (!best || off < best.d) best = { at: h.at, d: off };
  }
  return best!.at;
}

/**
 * For a hole face named without its position (`h1/wall`, as the render mesh names it): the hole's
 * position when it has exactly one. With several, the name must carry `@<position>` (the app adds it
 * from the pick point with {@link nearestHolePosition}).
 */
export function singleHoleResolver(report: ReportLike | null): (holeId: string) => string | null {
  return (holeId) => {
    const inst = holeInstances(report, holeId);
    return inst.length === 1 ? inst[0]!.at : null;
  };
}
