/**
 * IR mutations used by {@link MutantSolver} to test the scorer: each one models a typical agent
 * mistake, and the hidden tests of every applicable task must catch it.
 *
 * - `scale`: every length ×1.1 (wrong units or a misread dimension).
 * - `drop_hole`: one hole left out (the smallest hole circle of the first sketch that has holes).
 * - `hole_size`: the smallest hole circles of each sketch ×1.1 in diameter (wrong clearance).
 */
import type { IrDocument, SketchCurve, SketchFeature } from "@aicad/ir-types";
import { holeCircles } from "./ir-geom.js";

export const MUTATIONS = ["scale", "drop_hole", "hole_size"] as const;
export type MutationKind = (typeof MUTATIONS)[number];

export function isMutationKind(s: string): s is MutationKind {
  return (MUTATIONS as readonly string[]).includes(s);
}

const SCALE = 1.1;

function scaleCurve(c: SketchCurve, k: number): SketchCurve {
  const s = (p: [number, number]): [number, number] => [p[0] * k, p[1] * k];
  switch (c.kind) {
    case "line":
      return { ...c, start: s(c.start), end: s(c.end) };
    case "arc":
      return { ...c, start: s(c.start), end: s(c.end), center: s(c.center) };
    case "circle":
      return { ...c, center: s(c.center), radius: c.radius * k };
  }
}

function scaleDoc(ir: IrDocument, k: number): IrDocument {
  const out = structuredClone(ir);
  for (const part of out.parts) {
    part.features = part.features.map((f) => {
      switch (f.type) {
        case "sketch": {
          const plane =
            typeof f.plane === "string"
              ? f.plane
              : { ...f.plane, origin: [f.plane.origin[0] * k, f.plane.origin[1] * k, f.plane.origin[2] * k] as [number, number, number] };
          return { ...f, plane, curves: f.curves.map((c) => scaleCurve(c, k)) };
        }
        case "extrude":
          return { ...f, distance: f.distance * k };
        case "revolve":
          return { ...f, axis: { ...f.axis, origin: [f.axis.origin[0] * k, f.axis.origin[1] * k] } };
      }
    });
  }
  return out;
}

/** Ids of the smallest hole circles of a sketch (all circles tied for the smallest radius). */
function smallestHoles(sketch: SketchFeature): string[] {
  const holes = holeCircles(sketch);
  if (holes.length === 0) return [];
  const rMin = Math.min(...holes.map((c) => c.radius));
  return holes.filter((c) => c.radius <= rMin + 1e-9).map((c) => c.id);
}

function sketchesOf(ir: IrDocument): SketchFeature[] {
  return ir.parts.flatMap((p) => p.features.filter((f): f is SketchFeature => f.type === "sketch" && !f.suppressed));
}

/** Apply a mutation; returns null when it does not apply to this document (e.g. there are no holes). */
export function mutateIr(ir: IrDocument, kind: MutationKind): IrDocument | null {
  switch (kind) {
    case "scale":
      return scaleDoc(ir, SCALE);
    case "drop_hole": {
      const out = structuredClone(ir);
      for (const s of sketchesOf(out)) {
        const [victim] = smallestHoles(s);
        if (victim !== undefined) {
          s.curves = s.curves.filter((c) => c.id !== victim);
          return out;
        }
      }
      return null;
    }
    case "hole_size": {
      const out = structuredClone(ir);
      let changed = false;
      for (const s of sketchesOf(out)) {
        const ids = new Set(smallestHoles(s));
        s.curves = s.curves.map((c) => {
          if (c.kind !== "circle" || !ids.has(c.id)) return c;
          changed = true;
          return { ...c, radius: c.radius * SCALE };
        });
      }
      return changed ? out : null;
    }
  }
}
