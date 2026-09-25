/**
 * Modify tools over `sketch/ops.ts`: trim, extend, offset, mirror, corner fillet and chamfer.
 */
import { dist, fmt, nearestOnCurve, type LiteralCurve, type P2 } from "../../sketch/geom";
import { chamferCorner, extend, filletCorner, findCorner, mirror, offset, trim, type OpResult } from "../../sketch/ops";
import { EMPTY_PREVIEW, type PointerIn, type SketchTool, type ToolApi, type ToolId, type ToolPreview } from "./types";

function run(api: ToolApi, r: OpResult): boolean {
  if (!r.ok) {
    api.notify("warning", r.reason);
    return false;
  }
  const out = api.commit(r.edits, [], { dropRedundant: true });
  if (out.ok && r.note) api.notify("info", r.note);
  return out.ok;
}

/** Click a curve piece (trim) or near a curve end (extend). */
class ClickCurveTool implements SketchTool {
  private hover: LiteralCurve | null = null;
  private at: P2 | null = null;

  constructor(
    readonly id: ToolId,
    private readonly label: string,
    private readonly act: (curve: LiteralCurve, at: P2, api: ToolApi) => OpResult,
  ) {}

  hint(): string {
    return this.label;
  }

  down(p: P2, e: PointerIn, api: ToolApi): void {
    if (e.button !== 0) return;
    const c = api.hitCurve(p);
    if (!c || c.kind === "point") return;
    run(api, this.act(c, p, api));
    this.hover = null;
  }

  move(p: P2, _e: PointerIn, api: ToolApi): void {
    this.hover = api.hitCurve(p);
    this.at = p;
  }

  up(): void {}

  escape(): boolean {
    return false;
  }

  preview(): ToolPreview {
    return { ...EMPTY_PREVIEW, highlight: this.hover ? [this.hover.id] : [], marks: this.at && this.hover ? [nearestOnCurve(this.hover, this.at).point] : [] };
  }
}

export function trimTool(): SketchTool {
  return new ClickCurveTool("trim", "Click the piece of a curve to cut away", (c, at, api) => trim(c.id, at, api.curves(), api.feature(), api.ids()));
}

export function extendTool(): SketchTool {
  return new ClickCurveTool("extend", "Click near the end of a line or arc to extend it", (c, at, api) => extend(c.id, at, api.curves(), api.feature(), api.ids()));
}

/** Offset: select curves (or click one), move to choose side and distance, click or type it. */
export class OffsetTool implements SketchTool {
  readonly id = "offset" as const;
  private curves: string[] = [];
  private cursor: P2 | null = null;
  private distance = 0;

  hint(): string {
    return this.curves.length ? "Move to the side, click or type the distance" : "Click a curve (or select curves first, then click)";
  }

  typedLabel(): string | null {
    return this.curves.length ? "Distance" : null;
  }

  private chosen(api: ToolApi): string[] {
    return api
      .selection()
      .filter((s): s is { kind: "curve"; id: string } => s.kind === "curve")
      .map((s) => s.id);
  }

  down(p: P2, e: PointerIn, api: ToolApi): void {
    if (e.button !== 0) return;
    if (this.curves.length === 0) {
      const sel = this.chosen(api);
      const hit = api.hitCurve(p);
      this.curves = sel.length ? sel : hit ? [hit.id] : [];
      this.cursor = p;
      return;
    }
    this.commit(this.rounded(api), p, api);
  }

  private rounded(api: ToolApi): number {
    const step = api.mmPerPx() > 0.5 ? 1 : api.mmPerPx() > 0.05 ? 0.5 : 0.1;
    return Math.max(step, Math.round(this.distance / step) * step);
  }

  private commit(d: number, side: P2, api: ToolApi): void {
    if (run(api, offset(this.curves, d, side, api.curves(), api.ids(), api.construction()))) this.curves = [];
  }

  move(p: P2, _e: PointerIn, api: ToolApi): void {
    this.cursor = p;
    if (!this.curves.length) return;
    let best = Infinity;
    for (const id of this.curves) {
      const c = api.curves().find((x) => x.id === id);
      if (c) best = Math.min(best, nearestOnCurve(c, p).distance);
    }
    this.distance = Number.isFinite(best) ? best : 0;
  }

  up(): void {}

  typed(value: number, _raw: string, api: ToolApi): boolean {
    if (!this.curves.length || !this.cursor) return false;
    this.commit(value, this.cursor, api);
    return true;
  }

  escape(): boolean {
    if (!this.curves.length) return false;
    this.curves = [];
    return true;
  }

  preview(): ToolPreview {
    return { ...EMPTY_PREVIEW, highlight: this.curves, labels: this.curves.length && this.cursor ? [{ at: this.cursor, text: `offset ${fmt(this.distance, 2)}` }] : [] };
  }
}

/** Mirror: select curves first, then click the mirror line. */
export class MirrorTool implements SketchTool {
  readonly id = "mirror" as const;
  private hover: LiteralCurve | null = null;

  hint(): string {
    return "Select the curves to mirror, then click the mirror line";
  }

  down(p: P2, e: PointerIn, api: ToolApi): void {
    if (e.button !== 0) return;
    const axis = api.hitCurve(p);
    const sel = api
      .selection()
      .filter((s): s is { kind: "curve"; id: string } => s.kind === "curve")
      .map((s) => s.id);
    if (!axis || axis.kind !== "line") {
      api.notify("info", "Click a line to mirror about.");
      return;
    }
    if (sel.filter((id) => id !== axis.id).length === 0) {
      api.notify("info", "Select the curves to mirror first (Select tool, then Mirror).");
      return;
    }
    if (run(api, mirror(sel, axis.id, api.curves(), api.ids()))) api.setSelection([]);
  }

  move(p: P2, _e: PointerIn, api: ToolApi): void {
    const c = api.hitCurve(p);
    this.hover = c && c.kind === "line" ? c : null;
  }

  up(): void {}

  escape(): boolean {
    return false;
  }

  preview(): ToolPreview {
    return { ...EMPTY_PREVIEW, highlight: this.hover ? [this.hover.id] : [] };
  }
}

/** Corner fillet / chamfer: click a corner where two lines meet, move to size it, click or type. */
export class CornerTool implements SketchTool {
  private corner: ReturnType<typeof findCorner> = null;
  private cursor: P2 | null = null;
  private size = 0;

  constructor(readonly id: "fillet" | "chamfer") {}

  hint(): string {
    return this.corner ? `Move to size the ${this.id}, click or type the ${this.id === "fillet" ? "radius" : "distance"}` : "Click a corner where two lines meet";
  }

  typedLabel(): string | null {
    return this.corner ? (this.id === "fillet" ? "Radius" : "Distance") : null;
  }

  down(p: P2, e: PointerIn, api: ToolApi): void {
    if (e.button !== 0) return;
    if (!this.corner) {
      this.corner = findCorner(p, api.curves(), api.tol() * 2);
      if (!this.corner) api.notify("info", "Click closer to a corner of two lines.");
      return;
    }
    const step = api.mmPerPx() > 0.5 ? 1 : api.mmPerPx() > 0.05 ? 0.5 : 0.1;
    this.apply(Math.max(step, Math.round(this.size / step) * step), api);
  }

  private apply(size: number, api: ToolApi): void {
    if (!this.corner) return;
    const r = this.id === "fillet" ? filletCorner(this.corner, size, api.feature(), api.ids()) : chamferCorner(this.corner, size, api.feature(), api.ids());
    if (run(api, r)) this.corner = null;
  }

  move(p: P2): void {
    this.cursor = p;
    if (this.corner) this.size = dist(p, this.corner.vertex);
  }

  up(): void {}

  typed(value: number, _raw: string, api: ToolApi): boolean {
    if (!this.corner) return false;
    this.apply(value, api);
    return true;
  }

  escape(): boolean {
    if (!this.corner) return false;
    this.corner = null;
    return true;
  }

  preview(): ToolPreview {
    if (!this.corner) return EMPTY_PREVIEW;
    return {
      ...EMPTY_PREVIEW,
      highlight: [this.corner.a.id, this.corner.b.id],
      marks: [this.corner.vertex],
      labels: this.cursor ? [{ at: this.cursor, text: `${this.id === "fillet" ? "R" : ""}${fmt(this.size, 2)}` }] : [],
    };
  }
}
