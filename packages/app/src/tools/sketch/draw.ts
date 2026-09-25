/**
 * Drawing tools: chained line, rectangles (2-point, centre), circles (centre, 2-point, 3-point),
 * arcs (3-point, tangent, centre), slot, polygon and point. Each click places a snapped point;
 * the last one commits the shape as one gesture with its inherent constraints (a rectangle's
 * horizontals and verticals, a slot's tangencies, a polygon's equal sides) and the snaps'
 * auto-constraints (suppressed with Alt). Press–drag–release works like two clicks.
 */
import type { v1 } from "@aicad/ir-types";
import type { SketchEdit } from "../../sketch/engine-types";
import { add, angleOf, arcThrough, circleThrough, dist, fmt, mid, norm, perp, polar, projectOnLine, scale, sub, tangentAt, tangentArc, deg, type LiteralCurve, type P2 } from "../../sketch/geom";
import type { IdAllocator } from "../../sketch/ids";
import { autoConstraintsFor, bindKinds, type SnapResult } from "../../sketch/snap";
import { EMPTY_PREVIEW, type PointerIn, type SketchTool, type ToolApi, type ToolId, type ToolPreview } from "./types";

/** A placed point: where it went and what it snapped to. */
export interface Placed {
  point: P2;
  snap: SnapResult;
  alt: boolean;
}

const lit = (p: P2): P2 => [p[0] + 0, p[1] + 0];

/** Auto-constraints binding a new point `ref` to its snap (none with Alt). */
export function bindPoint(ref: string, at: Placed, ids: IdAllocator, curves: readonly LiteralCurve[]): SketchEdit[] {
  if (at.alt) return [];
  return bindKinds(autoConstraintsFor(ref, at.snap, (p) => ids.next(p)), curves).map((constraint) => ({ op: "addConstraint", constraint }));
}

/** Direction auto-constraints for a new line from its end snap (H/V, parallel, perpendicular, tangent). */
export function bindDirection(line: string, at: Placed, ids: IdAllocator): SketchEdit[] {
  if (at.alt) return [];
  const s = at.snap;
  const out: v1.Constraint[] = [];
  if (s.hv === "h") out.push({ type: "horizontal", id: ids.next("h"), line });
  else if (s.hv === "v") out.push({ type: "vertical", id: ids.next("v"), line });
  else if (s.parallelTo) out.push({ type: "parallel", id: ids.next("par"), a: s.parallelTo, b: line });
  else if (s.perpendicularTo) out.push({ type: "perpendicular", id: ids.next("perp"), a: s.perpendicularTo, b: line });
  else if (s.tangentTo) out.push({ type: "tangent", id: ids.next("tan"), a: s.tangentTo, b: line });
  return out.map((constraint) => ({ op: "addConstraint", constraint }));
}

/** Binding of a rim/through point to a circle or arc: the snapped entity lies on it. */
function bindOnRound(round: string, at: Placed, ids: IdAllocator): SketchEdit[] {
  if (at.alt || !at.snap.ref || (at.snap.kind !== "endpoint" && at.snap.kind !== "point")) return [];
  return [{ op: "addConstraint", constraint: { type: "point_on_circle", id: ids.next("on"), point: at.snap.ref, curve: round } }];
}

function cons(construction: boolean): { construction?: true } {
  return construction ? { construction: true } : {};
}

/**
 * The shape of a multi-click tool: how many points, the rubber band for the placed points plus
 * the cursor, and the edits for the final points.
 */
interface ShapeSpec {
  id: ToolId;
  steps: string[];
  typedLabel?: (placed: readonly Placed[]) => string | null;
  build(points: readonly P2[], construction: boolean): { curves: LiteralCurve[]; labels: Array<{ at: P2; text: string }> } | null;
  commit(placed: readonly Placed[], api: ToolApi): { core: SketchEdit[]; auto: SketchEdit[] } | null;
  /** A typed value at step k (e.g. the diameter after the centre): the points it implies. */
  typed?(placed: readonly Placed[], cursor: P2, value: number): { points: P2[]; extra: SketchEdit[] } | null;
  /** Snap options for the next point (anchor for inference). */
  anchor?(placed: readonly Placed[]): P2 | null;
}

class ShapeTool implements SketchTool {
  readonly id: ToolId;
  protected placed: Placed[] = [];
  protected cursor: Placed | null = null;
  private downAt: P2 | null = null;

  constructor(private readonly spec: ShapeSpec) {
    this.id = spec.id;
  }

  hint(): string {
    return this.spec.steps[Math.min(this.placed.length, this.spec.steps.length - 1)]!;
  }

  typedLabel(): string | null {
    return this.placed.length > 0 ? (this.spec.typedLabel?.(this.placed) ?? null) : null;
  }

  private place(p: P2, e: PointerIn, api: ToolApi): Placed {
    const snap = api.snap(p, e, { anchor: this.spec.anchor?.(this.placed) ?? this.placed[this.placed.length - 1]?.point ?? null });
    return { point: snap.point, snap, alt: e.alt };
  }

  down(p: P2, e: PointerIn, api: ToolApi): void {
    if (e.button !== 0) return;
    this.downAt = e.px;
    const at = this.place(p, e, api);
    this.placed.push(at);
    this.cursor = at;
    this.maybeCommit(api);
  }

  move(p: P2, e: PointerIn, api: ToolApi): void {
    this.cursor = this.place(p, e, api);
  }

  up(p: P2, e: PointerIn, api: ToolApi): void {
    // Press–drag–release: the release is the next point.
    if (this.downAt && this.placed.length > 0 && Math.hypot(e.px[0] - this.downAt[0], e.px[1] - this.downAt[1]) > 6) {
      const at = this.place(p, e, api);
      this.placed.push(at);
      this.maybeCommit(api);
    }
    this.downAt = null;
  }

  private maybeCommit(api: ToolApi): void {
    if (this.placed.length < this.spec.steps.length) return;
    const out = this.spec.commit(this.placed, api);
    this.placed = [];
    if (!out) {
      api.notify("warning", "That shape is degenerate: nothing was added.");
      return;
    }
    api.commit(out.core, out.auto);
  }

  escape(): boolean {
    if (this.placed.length === 0) return false;
    this.placed = [];
    return true;
  }

  typed(value: number, _raw: string, api: ToolApi): boolean {
    if (!this.spec.typed || this.placed.length === 0) return false;
    const r = this.spec.typed(this.placed, this.cursor?.point ?? this.placed[this.placed.length - 1]!.point, value);
    if (!r) return false;
    const free = (point: P2): Placed => ({ point, snap: { point, kind: "free", guides: [] }, alt: false });
    const all = [...this.placed, ...r.points.map(free)];
    const out = this.spec.commit(all, api);
    this.placed = [];
    if (!out) return false;
    api.commit(out.core, [...out.auto, ...r.extra]);
    return true;
  }

  preview(): ToolPreview {
    const pts = this.placed.map((x) => x.point);
    if (this.cursor) pts.push(this.cursor.point);
    const shape = this.placed.length > 0 ? this.spec.build(pts, false) : null;
    return { ...EMPTY_PREVIEW, curves: shape?.curves ?? [], labels: shape?.labels ?? [], snap: this.cursor?.snap ?? null, guides: this.cursor?.snap.guides ?? [] };
  }
}

// ─── Line (chained polyline) ─────────────────────────────────────────────────────────────────

export class LineTool implements SketchTool {
  readonly id = "line" as const;
  private start: Placed | null = null;
  private first: Placed | null = null;
  private tangentFrom: { curve: string; dir: P2 } | null = null;
  private cursor: Placed | null = null;
  private downAt: P2 | null = null;

  hint(): string {
    return this.start ? "Click the next point · type a length · double-click or Enter to end the chain" : "Click the start point";
  }

  typedLabel(): string | null {
    return this.start ? "Length" : null;
  }

  private place(p: P2, e: PointerIn, api: ToolApi): Placed {
    const snap = api.snap(p, e, { anchor: this.start?.point ?? null, tangent: this.tangentFrom });
    return { point: snap.point, snap, alt: e.alt };
  }

  down(p: P2, e: PointerIn, api: ToolApi): void {
    if (e.button !== 0) return;
    this.downAt = e.px;
    const at = this.place(p, e, api);
    if (e.clicks >= 2) {
      this.reset();
      return;
    }
    if (!this.start) {
      this.start = at;
      this.first = at;
      this.tangentFrom = tangentAtEnd(at, api.curves());
      return;
    }
    this.segment(at, api, null);
  }

  move(p: P2, e: PointerIn, api: ToolApi): void {
    this.cursor = this.place(p, e, api);
  }

  up(p: P2, e: PointerIn, api: ToolApi): void {
    if (this.downAt && this.start && Math.hypot(e.px[0] - this.downAt[0], e.px[1] - this.downAt[1]) > 6) {
      this.segment(this.place(p, e, api), api, null);
    }
    this.downAt = null;
  }

  private segment(end: Placed, api: ToolApi, length: number | null): void {
    const start = this.start!;
    if (dist(start.point, end.point) <= api.tol() * 0.5) return;
    const ids = api.ids();
    const id = ids.next("l");
    const core: SketchEdit[] = [{ op: "addCurve", curve: { kind: "line", id, start: lit(start.point), end: lit(end.point), ...cons(api.construction()) } }];
    const auto: SketchEdit[] = [...bindPoint(`${id}.start`, start, ids, api.curves()), ...bindPoint(`${id}.end`, end, ids, api.curves()), ...bindDirection(id, end, ids)];
    if (length !== null) core.push({ op: "addConstraint", constraint: { type: "distance", id: ids.next("d"), a: `${id}.start`, b: `${id}.end`, value: length } });
    const r = api.commit(core, auto);
    if (!r.ok) return;
    // Closing the loop on the chain's first point finishes the chain.
    const closed = this.first !== null && end.snap.kind === "endpoint" && dist(end.point, this.first.point) < 1e-9;
    if (closed) {
      this.reset();
      return;
    }
    const committed = r.snapshot.curves.find((c) => c.id === id);
    const endPoint = committed && committed.kind === "line" ? committed.end : end.point;
    this.start = { point: endPoint, snap: { point: endPoint, kind: "endpoint", ref: `${id}.end`, guides: [] }, alt: false };
    this.tangentFrom = null;
  }

  enter(): boolean {
    if (!this.start) return false;
    this.reset();
    return true;
  }

  escape(): boolean {
    if (!this.start) return false;
    this.reset();
    return true;
  }

  typed(value: number, _raw: string, api: ToolApi): boolean {
    if (!this.start || !(value > 0)) return false;
    const toward = this.cursor?.point ?? add(this.start.point, [1, 0]);
    let d = norm(sub(toward, this.start.point));
    if (d[0] === 0 && d[1] === 0) d = [1, 0];
    const endPt = add(this.start.point, scale(d, value));
    const hv = this.cursor?.snap.hv;
    const snap: SnapResult = { point: endPt, kind: "free", guides: [], ...(hv ? { hv } : {}) };
    this.segment({ point: endPt, snap, alt: false }, api, value);
    return true;
  }

  private reset(): void {
    this.start = null;
    this.first = null;
    this.tangentFrom = null;
  }

  preview(): ToolPreview {
    const p: ToolPreview = { ...EMPTY_PREVIEW, snap: this.cursor?.snap ?? null, guides: this.cursor?.snap.guides ?? [] };
    if (this.start && this.cursor) {
      const a = this.start.point;
      const b = this.cursor.point;
      p.curves = [{ kind: "line", id: "__preview", start: a, end: b }];
      const ang = deg(angleOf(sub(b, a)));
      p.labels = [{ at: mid(a, b), text: `${fmt(dist(a, b), 2)} mm · ${fmt(ang < 0 ? ang + 360 : ang, 1)}°` }];
    }
    return p;
  }
}

/** The outgoing tangent at an existing line/arc end the chain starts from. */
function tangentAtEnd(at: Placed, curves: readonly LiteralCurve[]): { curve: string; dir: P2 } | null {
  const ref = at.snap.ref;
  if (at.snap.kind !== "endpoint" || !ref) return null;
  const [id, which] = [ref.slice(0, ref.lastIndexOf(".")), ref.slice(ref.lastIndexOf(".") + 1)];
  const c = curves.find((x) => x.id === id);
  if (!c) return null;
  if (c.kind === "line") return { curve: id, dir: which === "end" ? sub(c.end, c.start) : sub(c.start, c.end) };
  if (c.kind === "arc") {
    const t = tangentAt(c, which === "end" ? c.end : c.start);
    return { curve: id, dir: which === "end" ? t : scale(t, -1) };
  }
  return null;
}

// ─── Rectangles ──────────────────────────────────────────────────────────────────────────────

function rectCorners(a: P2, c: P2): [P2, P2, P2, P2] {
  return [a, [c[0], a[1]], c, [a[0], c[1]]];
}

function rectLines(ids: IdAllocator, k: [P2, P2, P2, P2], construction: boolean): { lines: LiteralCurve[]; names: string[] } {
  const names = [ids.next("l"), ids.next("l"), ids.next("l"), ids.next("l")];
  const lines: LiteralCurve[] = names.map((id, i) => ({ kind: "line", id, start: lit(k[i]!), end: lit(k[(i + 1) % 4]!), ...cons(construction) }));
  return { lines, names };
}

function hvFor(names: string[], ids: IdAllocator): SketchEdit[] {
  return [
    { op: "addConstraint", constraint: { type: "horizontal", id: ids.next("h"), line: names[0]! } },
    { op: "addConstraint", constraint: { type: "vertical", id: ids.next("v"), line: names[1]! } },
    { op: "addConstraint", constraint: { type: "horizontal", id: ids.next("h"), line: names[2]! } },
    { op: "addConstraint", constraint: { type: "vertical", id: ids.next("v"), line: names[3]! } },
  ];
}

const rectLabels = (a: P2, c: P2): Array<{ at: P2; text: string }> => [
  { at: [(a[0] + c[0]) / 2, Math.min(a[1], c[1])], text: fmt(Math.abs(c[0] - a[0]), 2) },
  { at: [Math.max(a[0], c[0]), (a[1] + c[1]) / 2], text: fmt(Math.abs(c[1] - a[1]), 2) },
];

export function rect2Tool(): SketchTool {
  return new ShapeTool({
    id: "rect2",
    steps: ["Click the first corner", "Click the opposite corner · type the width"],
    typedLabel: () => "Width",
    build([a, c]) {
      if (!a || !c) return null;
      const k = rectCorners(a, c);
      return { curves: k.map((p, i) => ({ kind: "line", id: `__r${i}`, start: p, end: k[(i + 1) % 4]! })), labels: rectLabels(a, c) };
    },
    commit([a, c], api) {
      if (!a || !c) return null;
      const tol = api.tol() * 0.5;
      if (Math.abs(c.point[0] - a.point[0]) <= tol || Math.abs(c.point[1] - a.point[1]) <= tol) return null;
      const ids = api.ids();
      const { lines, names } = rectLines(ids, rectCorners(a.point, c.point), api.construction());
      return {
        core: [...lines.map((curve): SketchEdit => ({ op: "addCurve", curve })), ...hvFor(names, ids)],
        auto: [...bindPoint(`${names[0]}.start`, a, ids, api.curves()), ...bindPoint(`${names[1]}.end`, c, ids, api.curves())],
      };
    },
    typed([a], cursor, w) {
      if (!a || !(w > 0)) return null;
      const sx = cursor[0] >= a.point[0] ? 1 : -1;
      const sy = cursor[1] >= a.point[1] ? 1 : -1;
      const h = Math.abs(cursor[1] - a.point[1]) > 1e-9 ? Math.abs(cursor[1] - a.point[1]) : w;
      return { points: [[a.point[0] + sx * w, a.point[1] + sy * h]], extra: [] };
    },
  });
}

export function rectCenterTool(): SketchTool {
  return new ShapeTool({
    id: "rectCenter",
    steps: ["Click the centre", "Click a corner"],
    build([m, c]) {
      if (!m || !c) return null;
      const a: P2 = [2 * m[0] - c[0], 2 * m[1] - c[1]];
      const k = rectCorners(a, c);
      return { curves: [...k.map((p, i): LiteralCurve => ({ kind: "line", id: `__r${i}`, start: p, end: k[(i + 1) % 4]! })), { kind: "point", id: "__c", at: m }], labels: rectLabels(a, c) };
    },
    commit([m, c], api) {
      if (!m || !c) return null;
      const tol = api.tol() * 0.5;
      if (Math.abs(c.point[0] - m.point[0]) <= tol || Math.abs(c.point[1] - m.point[1]) <= tol) return null;
      const ids = api.ids();
      const a: P2 = [2 * m.point[0] - c.point[0], 2 * m.point[1] - c.point[1]];
      const k = rectCorners(a, c.point);
      const { lines, names } = rectLines(ids, k, api.construction());
      const diag = ids.next("l");
      const center = ids.next("p");
      return {
        core: [
          ...lines.map((curve): SketchEdit => ({ op: "addCurve", curve })),
          { op: "addCurve", curve: { kind: "line", id: diag, start: lit(k[0]), end: lit(k[2]), construction: true } },
          { op: "addCurve", curve: { kind: "point", id: center, at: lit(m.point), construction: true } },
          ...hvFor(names, ids),
          { op: "addConstraint", constraint: { type: "midpoint", id: ids.next("mp"), point: center, line: diag } },
        ],
        auto: [...bindPoint(center, m, ids, api.curves()), ...bindPoint(`${names[1]}.end`, c, ids, api.curves())],
      };
    },
  });
}

// ─── Circles ─────────────────────────────────────────────────────────────────────────────────

export function circleCenterTool(): SketchTool {
  return new ShapeTool({
    id: "circleCenter",
    steps: ["Click the centre", "Click a point on the circle · type the diameter"],
    typedLabel: () => "Diameter",
    anchor: () => null,
    build([m, r]) {
      if (!m || !r) return null;
      const rad = dist(m, r);
      return { curves: [{ kind: "circle", id: "__c", center: m, radius: Math.max(rad, 1e-9) }], labels: [{ at: r, text: `⌀${fmt(2 * rad, 2)}` }] };
    },
    commit([m, r], api) {
      if (!m || !r) return null;
      const rad = dist(m.point, r.point);
      if (rad <= api.tol() * 0.5) return null;
      const ids = api.ids();
      const id = ids.next("c");
      return {
        core: [{ op: "addCurve", curve: { kind: "circle", id, center: lit(m.point), radius: rad, ...cons(api.construction()) } }],
        auto: [...bindPoint(`${id}.center`, m, ids, api.curves()), ...bindOnRound(id, r, ids)],
      };
    },
    typed([m], cursor, d) {
      if (!m || !(d > 0)) return null;
      const dir = norm(sub(cursor, m.point));
      const u: P2 = dir[0] === 0 && dir[1] === 0 ? [1, 0] : dir;
      return { points: [add(m.point, scale(u, d / 2))], extra: [] };
    },
  });
}

export function circle2Tool(): SketchTool {
  return new ShapeTool({
    id: "circle2",
    steps: ["Click one end of a diameter", "Click the other end"],
    build([a, b]) {
      if (!a || !b) return null;
      return { curves: [{ kind: "circle", id: "__c", center: mid(a, b), radius: Math.max(dist(a, b) / 2, 1e-9) }], labels: [{ at: b, text: `⌀${fmt(dist(a, b), 2)}` }] };
    },
    commit([a, b], api) {
      if (!a || !b || dist(a.point, b.point) <= api.tol()) return null;
      const ids = api.ids();
      const id = ids.next("c");
      return {
        core: [{ op: "addCurve", curve: { kind: "circle", id, center: lit(mid(a.point, b.point)), radius: dist(a.point, b.point) / 2, ...cons(api.construction()) } }],
        auto: [...bindOnRound(id, a, ids), ...bindOnRound(id, b, ids)],
      };
    },
  });
}

export function circle3Tool(): SketchTool {
  return new ShapeTool({
    id: "circle3",
    steps: ["Click the first point", "Click the second point", "Click the third point"],
    build(pts) {
      if (pts.length === 2) return { curves: [{ kind: "line", id: "__l", start: pts[0]!, end: pts[1]! }], labels: [] };
      const c = pts.length >= 3 ? circleThrough(pts[0]!, pts[1]!, pts[2]!) : null;
      return c ? { curves: [{ kind: "circle", id: "__c", center: c.center, radius: c.r }], labels: [{ at: pts[2]!, text: `⌀${fmt(2 * c.r, 2)}` }] } : null;
    },
    commit(placed, api) {
      const [a, b, c] = placed;
      if (!a || !b || !c) return null;
      const circ = circleThrough(a.point, b.point, c.point);
      if (!circ) return null;
      const ids = api.ids();
      const id = ids.next("c");
      return {
        core: [{ op: "addCurve", curve: { kind: "circle", id, center: lit(circ.center), radius: circ.r, ...cons(api.construction()) } }],
        auto: [...bindOnRound(id, a, ids), ...bindOnRound(id, b, ids), ...bindOnRound(id, c, ids)],
      };
    },
  });
}

// ─── Arcs ────────────────────────────────────────────────────────────────────────────────────

export function arc3Tool(): SketchTool {
  return new ShapeTool({
    id: "arc3",
    steps: ["Click the start", "Click the end", "Click a point on the arc"],
    build(pts) {
      if (pts.length === 2) return { curves: [{ kind: "line", id: "__l", start: pts[0]!, end: pts[1]! }], labels: [] };
      const a = pts.length >= 3 ? arcThrough(pts[0]!, pts[2]!, pts[1]!) : null;
      return a ? { curves: [{ kind: "arc", id: "__a", start: pts[0]!, end: pts[1]!, center: a.center, ccw: a.ccw }], labels: [{ at: pts[2]!, text: `R${fmt(dist(a.center, pts[0]!), 2)}` }] } : null;
    },
    commit(placed, api) {
      const [s, e, m] = placed;
      if (!s || !e || !m) return null;
      const a = arcThrough(s.point, m.point, e.point);
      if (!a || dist(s.point, e.point) <= api.tol() * 0.5) return null;
      const ids = api.ids();
      const id = ids.next("a");
      return {
        core: [{ op: "addCurve", curve: { kind: "arc", id, start: lit(s.point), end: lit(e.point), center: lit(a.center), ccw: a.ccw, ...cons(api.construction()) } }],
        auto: [...bindPoint(`${id}.start`, s, ids, api.curves()), ...bindPoint(`${id}.end`, e, ids, api.curves())],
      };
    },
  });
}

export class ArcCenterTool implements SketchTool {
  readonly id = "arcCenter" as const;
  private placed: Placed[] = [];
  private cursor: Placed | null = null;
  /** Unwrapped sweep from the start, following the pointer (sign: direction). */
  private sweep = 0;
  private lastAngle: number | null = null;

  hint(): string {
    return ["Click the centre", "Click the start (sets the radius)", "Click the end"][this.placed.length]!;
  }

  down(p: P2, e: PointerIn, api: ToolApi): void {
    if (e.button !== 0) return;
    const snap = api.snap(p, e, { anchor: this.placed[0]?.point ?? null });
    this.placed.push({ point: snap.point, snap, alt: e.alt });
    if (this.placed.length === 2) {
      this.sweep = 0;
      this.lastAngle = angleOf(sub(this.placed[1]!.point, this.placed[0]!.point));
    }
    if (this.placed.length < 3) return;
    const [m, s] = this.placed as [Placed, Placed, Placed];
    this.placed = [];
    const r = dist(m.point, s.point);
    if (r <= api.tol() * 0.5 || Math.abs(this.sweep) < 1e-3) {
      api.notify("warning", "That arc is degenerate: nothing was added.");
      return;
    }
    const a0 = angleOf(sub(s.point, m.point));
    const endPt = polar(m.point, r, a0 + this.sweep);
    const ids = api.ids();
    const id = ids.next("a");
    const ccw = this.sweep > 0;
    api.commit(
      [{ op: "addCurve", curve: { kind: "arc", id, start: lit(s.point), end: lit(endPt), center: lit(m.point), ccw, ...cons(api.construction()) } }],
      [...bindPoint(`${id}.center`, m, ids, api.curves()), ...bindPoint(`${id}.start`, s, ids, api.curves())],
    );
  }

  move(p: P2, e: PointerIn, api: ToolApi): void {
    const snap = api.snap(p, e, { anchor: this.placed[0]?.point ?? null });
    this.cursor = { point: snap.point, snap, alt: e.alt };
    if (this.placed.length === 2 && this.lastAngle !== null) {
      const a = angleOf(sub(snap.point, this.placed[0]!.point));
      let d = a - this.lastAngle;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      this.sweep = Math.max(-2 * Math.PI + 1e-3, Math.min(2 * Math.PI - 1e-3, this.sweep + d));
      this.lastAngle = a;
    }
  }

  up(): void {}

  escape(): boolean {
    if (this.placed.length === 0) return false;
    this.placed = [];
    return true;
  }

  preview(): ToolPreview {
    const p: ToolPreview = { ...EMPTY_PREVIEW, snap: this.cursor?.snap ?? null, guides: this.cursor?.snap.guides ?? [] };
    if (this.placed.length === 1 && this.cursor) {
      p.curves = [{ kind: "circle", id: "__c", center: this.placed[0]!.point, radius: Math.max(dist(this.placed[0]!.point, this.cursor.point), 1e-9), construction: true }];
    } else if (this.placed.length === 2) {
      const [m, s] = this.placed as [Placed, Placed];
      const r = dist(m.point, s.point);
      const a0 = angleOf(sub(s.point, m.point));
      if (Math.abs(this.sweep) > 1e-3) {
        p.curves = [{ kind: "arc", id: "__a", start: s.point, end: polar(m.point, r, a0 + this.sweep), center: m.point, ccw: this.sweep > 0 }];
        p.labels = [{ at: polar(m.point, r, a0 + this.sweep / 2), text: `R${fmt(r, 2)} · ${fmt(Math.abs(deg(this.sweep)), 1)}°` }];
      }
    }
    return p;
  }
}

export class ArcTangentTool implements SketchTool {
  readonly id = "arcTangent" as const;
  private start: Placed | null = null;
  private from: { curve: string; dir: P2 } | null = null;
  private cursor: Placed | null = null;

  hint(): string {
    return this.start ? "Click the end of the arc" : "Click the end of a line or arc to continue from";
  }

  down(p: P2, e: PointerIn, api: ToolApi): void {
    if (e.button !== 0) return;
    const snap = api.snap(p, e, {});
    const at: Placed = { point: snap.point, snap, alt: e.alt };
    if (!this.start) {
      const t = tangentAtEnd(at, api.curves());
      if (!t) {
        api.notify("info", "A tangent arc starts at the end of a line or an arc.");
        return;
      }
      this.start = at;
      this.from = t;
      return;
    }
    const arc = tangentArc(this.start.point, this.from!.dir, at.point);
    if (!arc || dist(this.start.point, at.point) <= api.tol() * 0.5) {
      api.notify("warning", "The end lies on the tangent line: no arc.");
      return;
    }
    const ids = api.ids();
    const id = ids.next("a");
    const r = api.commit(
      [
        { op: "addCurve", curve: { kind: "arc", id, start: lit(this.start.point), end: lit(at.point), center: lit(arc.center), ccw: arc.ccw, ...cons(api.construction()) } },
        { op: "addConstraint", constraint: { type: "tangent", id: ids.next("tan"), a: this.from!.curve, b: id } },
      ],
      bindPoint(`${id}.end`, at, ids, api.curves()),
    );
    if (r.ok) {
      // Continue the chain from the new arc's end.
      const c = r.snapshot.curves.find((x) => x.id === id);
      if (c && c.kind === "arc") {
        this.start = { point: c.end, snap: { point: c.end, kind: "endpoint", ref: `${id}.end`, guides: [] }, alt: false };
        this.from = { curve: id, dir: tangentAt(c, c.end) };
        return;
      }
    }
    this.start = null;
  }

  move(p: P2, e: PointerIn, api: ToolApi): void {
    const snap = api.snap(p, e, {});
    this.cursor = { point: snap.point, snap, alt: e.alt };
  }

  up(): void {}

  escape(): boolean {
    if (!this.start) return false;
    this.start = null;
    return true;
  }

  enter(): boolean {
    return this.escape();
  }

  preview(): ToolPreview {
    const p: ToolPreview = { ...EMPTY_PREVIEW, snap: this.cursor?.snap ?? null };
    if (this.start && this.cursor && this.from) {
      const a = tangentArc(this.start.point, this.from.dir, this.cursor.point);
      if (a) p.curves = [{ kind: "arc", id: "__a", start: this.start.point, end: this.cursor.point, center: a.center, ccw: a.ccw }];
    }
    return p;
  }
}

// ─── Slot, polygon, point ────────────────────────────────────────────────────────────────────

function slotCurves(a: P2, b: P2, w: number, names: [string, string, string, string]): LiteralCurve[] {
  const d = norm(sub(b, a));
  const n = perp(d);
  const h = w / 2;
  const [right, capB, left, capA] = names;
  return [
    { kind: "line", id: right, start: lit(sub(a, scale(n, h))), end: lit(sub(b, scale(n, h))) },
    { kind: "arc", id: capB, start: lit(sub(b, scale(n, h))), end: lit(add(b, scale(n, h))), center: lit(b), ccw: true },
    { kind: "line", id: left, start: lit(add(b, scale(n, h))), end: lit(add(a, scale(n, h))) },
    { kind: "arc", id: capA, start: lit(add(a, scale(n, h))), end: lit(sub(a, scale(n, h))), center: lit(a), ccw: true },
  ];
}

export function slotTool(): SketchTool {
  return new ShapeTool({
    id: "slot",
    steps: ["Click the first centre", "Click the second centre", "Click to set the width"],
    build(pts) {
      if (pts.length === 2) return { curves: [{ kind: "line", id: "__l", start: pts[0]!, end: pts[1]!, construction: true }], labels: [] };
      if (pts.length < 3 || dist(pts[0]!, pts[1]!) < 1e-9) return null;
      const w = 2 * dist(pts[2]!, projectOnLine(pts[0]!, pts[1]!, pts[2]!));
      if (w < 1e-9) return null;
      return { curves: slotCurves(pts[0]!, pts[1]!, w, ["__1", "__2", "__3", "__4"]), labels: [{ at: pts[2]!, text: `w ${fmt(w, 2)}` }] };
    },
    commit(placed, api) {
      const [a, b, c] = placed;
      if (!a || !b || !c) return null;
      if (dist(a.point, b.point) <= api.tol() * 0.5) return null;
      const w = 2 * dist(c.point, projectOnLine(a.point, b.point, c.point));
      if (w <= api.tol() * 0.5) return null;
      const ids = api.ids();
      const names: [string, string, string, string] = [ids.next("l"), ids.next("a"), ids.next("l"), ids.next("a")];
      const curves = slotCurves(a.point, b.point, w, names).map((cv) => ({ ...cv, ...cons(api.construction()) }) as LiteralCurve);
      const [right, capB, left, capA] = names;
      const t = (x: string, y: string): SketchEdit => ({ op: "addConstraint", constraint: { type: "tangent", id: ids.next("tan"), a: x, b: y } });
      return {
        core: [
          ...curves.map((curve): SketchEdit => ({ op: "addCurve", curve })),
          t(right, capB),
          t(left, capB),
          t(left, capA),
          t(right, capA),
          { op: "addConstraint", constraint: { type: "equal", id: ids.next("eq"), a: capA, b: capB } },
        ],
        auto: [...bindPoint(`${capA}.center`, a, ids, api.curves()), ...bindPoint(`${capB}.center`, b, ids, api.curves())],
      };
    },
  });
}

export class PolygonTool implements SketchTool {
  readonly id = "polygon" as const;
  sides = 6;
  private readonly inner: ShapeTool;

  constructor() {
    const self = this;
    this.inner = new ShapeTool({
      id: "polygon",
      steps: ["Click the centre · type the number of sides", "Click a vertex"],
      build([m, v]) {
        if (!m || !v || dist(m, v) < 1e-9) return null;
        const r = dist(m, v);
        const a0 = angleOf(sub(v, m));
        const pts = Array.from({ length: self.sides }, (_, k) => polar(m, r, a0 + (2 * Math.PI * k) / self.sides));
        return { curves: pts.map((p, k): LiteralCurve => ({ kind: "line", id: `__p${k}`, start: p, end: pts[(k + 1) % pts.length]! })), labels: [{ at: v, text: `${self.sides} sides · R${fmt(r, 2)}` }] };
      },
      commit([m, v], api) {
        if (!m || !v) return null;
        const r = dist(m.point, v.point);
        if (r <= api.tol() * 0.5) return null;
        const ids = api.ids();
        const n = self.sides;
        const a0 = angleOf(sub(v.point, m.point));
        const pts = Array.from({ length: n }, (_, k) => lit(polar(m.point, r, a0 + (2 * Math.PI * k) / n)));
        const names = pts.map(() => ids.next("l"));
        const circ = ids.next("c");
        const core: SketchEdit[] = [
          { op: "addCurve", curve: { kind: "circle", id: circ, center: lit(m.point), radius: r, construction: true } },
          ...names.map((id, k): SketchEdit => ({ op: "addCurve", curve: { kind: "line", id, start: pts[k]!, end: pts[(k + 1) % n]!, ...cons(api.construction()) } })),
          ...names.map((id): SketchEdit => ({ op: "addConstraint", constraint: { type: "point_on_circle", id: ids.next("on"), point: `${id}.start`, curve: circ } })),
          ...names.slice(1).map((id): SketchEdit => ({ op: "addConstraint", constraint: { type: "equal", id: ids.next("eq"), a: names[0]!, b: id } })),
        ];
        return { core, auto: bindPoint(`${circ}.center`, m, ids, api.curves()) };
      },
    });
  }

  hint(): string {
    return `${this.inner.hint()} (${this.sides} sides)`;
  }
  typedLabel(): string | null {
    return "Sides";
  }
  typed(value: number): boolean {
    const n = Math.round(value);
    if (n < 3 || n > 64) return false;
    this.sides = n;
    return true;
  }
  down(p: P2, e: PointerIn, api: ToolApi): void {
    this.inner.down(p, e, api);
  }
  move(p: P2, e: PointerIn, api: ToolApi): void {
    this.inner.move(p, e, api);
  }
  up(p: P2, e: PointerIn, api: ToolApi): void {
    this.inner.up(p, e, api);
  }
  escape(): boolean {
    return this.inner.escape();
  }
  preview(): ToolPreview {
    return this.inner.preview();
  }
}

export function pointTool(): SketchTool {
  return new ShapeTool({
    id: "point",
    steps: ["Click to place a point"],
    build: () => null,
    commit([p], api) {
      if (!p) return null;
      const ids = api.ids();
      const id = ids.next("p");
      return { core: [{ op: "addCurve", curve: { kind: "point", id, at: lit(p.point), ...cons(api.construction()) } }], auto: bindPoint(id, p, ids, api.curves()) };
    },
  });
}
