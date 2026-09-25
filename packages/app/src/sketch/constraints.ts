/**
 * Constraints from a selection (the sketch palette's constraint buttons): which kinds apply to
 * the selected curves and points, and the IR constraints each one adds.
 *
 * | Button | Selection | Adds |
 * |---|---|---|
 * | Coincident | two points · a point and a curve | `coincident` · `point_on_line` / `point_on_circle` |
 * | Horizontal / Vertical | lines · two points | `horizontal`/`vertical` per line · a construction-free `distance`-less alignment is not in the IR, so two points need a line |
 * | Parallel / Perpendicular | two lines | `parallel` / `perpendicular` |
 * | Tangent | a line and an arc/circle · two arcs/circles | `tangent` |
 * | Equal | two or more lines · two or more arcs/circles | `equal` (chained to the first) |
 * | Concentric | two or more arcs/circles | `coincident` of the centres |
 * | Midpoint | a point and a line | `midpoint` |
 * | Symmetric | two points and a line · two curves of one kind and a line | `symmetric` (per matching point) |
 * | Fix | points · curves | `fix` (points at their current position) |
 * | On curve | a point and a curve | `point_on_line` / `point_on_circle` |
 */
import type { v1 } from "@aicad/ir-types";
import { curvePoint, type LiteralCurve, type P2 } from "./geom";
import type { IdAllocator } from "./ids";

export type SketchSel = { kind: "curve"; id: string } | { kind: "point"; ref: string } | { kind: "constraint"; id: string };

export type ConstraintKind =
  | "coincident"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "tangent"
  | "equal"
  | "concentric"
  | "midpoint"
  | "symmetric"
  | "fix"
  | "onCurve";

export const CONSTRAINT_KINDS: ReadonlyArray<{ kind: ConstraintKind; label: string; glyph: string; key?: string }> = [
  { kind: "coincident", label: "Coincident", glyph: "●" },
  { kind: "horizontal", label: "Horizontal", glyph: "H", key: "h" },
  { kind: "vertical", label: "Vertical", glyph: "V", key: "v" },
  { kind: "parallel", label: "Parallel", glyph: "∥" },
  { kind: "perpendicular", label: "Perpendicular", glyph: "⊥" },
  { kind: "tangent", label: "Tangent", glyph: "T" },
  { kind: "equal", label: "Equal", glyph: "=" },
  { kind: "concentric", label: "Concentric", glyph: "◎" },
  { kind: "midpoint", label: "Midpoint", glyph: "M" },
  { kind: "symmetric", label: "Symmetric", glyph: "⋈" },
  { kind: "fix", label: "Fix", glyph: "⚓", key: "f" },
  { kind: "onCurve", label: "On curve", glyph: "⌒" },
];

/** A curve by id. */
export function findCurve(curves: readonly LiteralCurve[], id: string): LiteralCurve | undefined {
  return curves.find((c) => c.id === id);
}

/** Split a point reference into curve id and point name (`l1.end` → [`l1`, `end`], `p` → [`p`, `at`]). */
export function splitRef(ref: string): [string, string] {
  const i = ref.lastIndexOf(".");
  return i < 0 ? [ref, "at"] : [ref.slice(0, i), ref.slice(i + 1)];
}

/** The position of a point reference in the snapshot. */
export function refPoint(curves: readonly LiteralCurve[], ref: string): P2 | null {
  const [id, which] = splitRef(ref);
  const c = findCurve(curves, id);
  return c ? curvePoint(c, which) : null;
}

interface Classified {
  points: string[];
  lines: string[];
  rounds: string[];
  others: LiteralCurve[];
}

function classify(sel: readonly SketchSel[], curves: readonly LiteralCurve[]): Classified {
  const out: Classified = { points: [], lines: [], rounds: [], others: [] };
  for (const s of sel) {
    if (s.kind === "point") out.points.push(s.ref);
    else if (s.kind === "curve") {
      const c = findCurve(curves, s.id);
      if (!c) continue;
      if (c.kind === "point") out.points.push(c.id);
      else if (c.kind === "line") out.lines.push(c.id);
      else out.rounds.push(c.id);
    }
  }
  return out;
}

function onCurve(point: string, curve: string, curves: readonly LiteralCurve[], id: string): v1.Constraint {
  const c = findCurve(curves, curve);
  return c && c.kind !== "line" ? { type: "point_on_circle", id, point, curve } : { type: "point_on_line", id, point, line: curve };
}

export type ConstraintPlan = { ok: true; constraints: v1.Constraint[] } | { ok: false; reason: string };

/** The constraints a palette button adds for the selection. */
export function constraintsFor(kind: ConstraintKind, sel: readonly SketchSel[], curves: readonly LiteralCurve[], ids: IdAllocator): ConstraintPlan {
  const k = classify(sel, curves);
  const ok = (constraints: v1.Constraint[]): ConstraintPlan => ({ ok: true, constraints });
  const no = (reason: string): ConstraintPlan => ({ ok: false, reason });
  const nCurves = k.lines.length + k.rounds.length;
  switch (kind) {
    case "coincident":
      if (k.points.length === 2 && nCurves === 0) return ok([{ type: "coincident", id: ids.next("co"), a: k.points[0]!, b: k.points[1]! }]);
      if (k.points.length === 1 && nCurves === 1) return ok([onCurve(k.points[0]!, (k.lines[0] ?? k.rounds[0])!, curves, ids.next("on"))]);
      return no("Select two points, or a point and a curve.");
    case "onCurve":
      if (k.points.length >= 1 && nCurves === 1) return ok(k.points.map((p) => onCurve(p, (k.lines[0] ?? k.rounds[0])!, curves, ids.next("on"))));
      return no("Select points and one curve.");
    case "horizontal":
    case "vertical":
      if (k.lines.length >= 1 && k.points.length === 0 && k.rounds.length === 0)
        return ok(k.lines.map((line) => ({ type: kind, id: ids.next(kind === "horizontal" ? "h" : "v"), line }) as v1.Constraint));
      return no("Select one or more lines.");
    case "parallel":
    case "perpendicular":
      if (k.lines.length === 2 && k.points.length === 0 && k.rounds.length === 0)
        return ok([{ type: kind, id: ids.next(kind === "parallel" ? "par" : "perp"), a: k.lines[0]!, b: k.lines[1]! } as v1.Constraint]);
      if (kind === "parallel" && k.lines.length > 2 && k.points.length === 0 && k.rounds.length === 0)
        return ok(k.lines.slice(1).map((b) => ({ type: "parallel", id: ids.next("par"), a: k.lines[0]!, b }) as v1.Constraint));
      return no("Select two lines.");
    case "tangent":
      if (k.points.length === 0 && nCurves === 2 && k.rounds.length >= 1) {
        const [a, b] = [...k.lines, ...k.rounds] as [string, string];
        return ok([{ type: "tangent", id: ids.next("tan"), a, b }]);
      }
      return no("Select a line and an arc or circle, or two arcs/circles.");
    case "equal":
      if (k.points.length === 0 && k.lines.length >= 2 && k.rounds.length === 0)
        return ok(k.lines.slice(1).map((b) => ({ type: "equal", id: ids.next("eq"), a: k.lines[0]!, b }) as v1.Constraint));
      if (k.points.length === 0 && k.rounds.length >= 2 && k.lines.length === 0)
        return ok(k.rounds.slice(1).map((b) => ({ type: "equal", id: ids.next("eq"), a: k.rounds[0]!, b }) as v1.Constraint));
      return no("Select two or more lines, or two or more arcs/circles.");
    case "concentric":
      if (k.points.length === 0 && k.lines.length === 0 && k.rounds.length >= 2)
        return ok(k.rounds.slice(1).map((b) => ({ type: "coincident", id: ids.next("con"), a: `${k.rounds[0]}.center`, b: `${b}.center` }) as v1.Constraint));
      return no("Select two or more arcs/circles.");
    case "midpoint":
      if (k.points.length === 1 && k.lines.length === 1 && k.rounds.length === 0)
        return ok([{ type: "midpoint", id: ids.next("mp"), point: k.points[0]!, line: k.lines[0]! }]);
      return no("Select a point and a line.");
    case "symmetric": {
      // The mirror line is the last selected line.
      const lineSel = [...sel].reverse().find((s) => s.kind === "curve" && k.lines.includes(s.id));
      if (!lineSel || lineSel.kind !== "curve") return no("Select two points (or two matching curves) and the mirror line last.");
      const mirror = lineSel.id;
      const rest = sel.filter((s) => s !== lineSel);
      const r = classify(rest, curves);
      if (r.points.length === 2 && r.lines.length === 0 && r.rounds.length === 0)
        return ok([{ type: "symmetric", id: ids.next("sym"), a: r.points[0]!, b: r.points[1]!, line: mirror }]);
      if (r.points.length === 0 && r.lines.length === 2 && r.rounds.length === 0) {
        const [a, b] = r.lines as [string, string];
        return ok([
          { type: "symmetric", id: ids.next("sym"), a: `${a}.start`, b: `${b}.start`, line: mirror },
          { type: "symmetric", id: ids.next("sym"), a: `${a}.end`, b: `${b}.end`, line: mirror },
        ]);
      }
      if (r.points.length === 0 && r.lines.length === 0 && r.rounds.length === 2) {
        const [a, b] = r.rounds as [string, string];
        return ok([
          { type: "symmetric", id: ids.next("sym"), a: `${a}.center`, b: `${b}.center`, line: mirror },
          { type: "equal", id: ids.next("eq"), a, b },
        ]);
      }
      return no("Select two points (or two matching curves) and the mirror line last.");
    }
    case "fix": {
      if (sel.length === 0) return no("Select points or curves to fix.");
      const out: v1.Constraint[] = [];
      for (const p of k.points) {
        const at = refPoint(curves, p);
        out.push(at ? { type: "fix", id: ids.next("fx"), entity: p, x: at[0], y: at[1] } : { type: "fix", id: ids.next("fx"), entity: p });
      }
      for (const c of [...k.lines, ...k.rounds]) {
        const curve = findCurve(curves, c);
        if (curve?.kind === "arc") {
          for (const which of ["start", "end", "center"]) {
            const at = curvePoint(curve, which)!;
            out.push({ type: "fix", id: ids.next("fx"), entity: `${c}.${which}`, x: at[0], y: at[1] });
          }
        } else {
          out.push({ type: "fix", id: ids.next("fx"), entity: c });
        }
      }
      return out.length ? ok(out) : no("Select points or curves to fix.");
    }
  }
}

/** The constraint kinds that apply to a selection (to enable palette buttons). */
export function applicableKinds(sel: readonly SketchSel[], curves: readonly LiteralCurve[]): ConstraintKind[] {
  const probe = new (class {
    next(p: string): string {
      return `${p}_probe`;
    }
    has(): boolean {
      return false;
    }
  })() as unknown as IdAllocator;
  return CONSTRAINT_KINDS.map((c) => c.kind).filter((kind) => constraintsFor(kind, sel, curves, probe).ok);
}
