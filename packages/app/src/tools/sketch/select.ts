/**
 * Select and drag: click a point or curve to select it (Shift toggles), drag it to move it
 * within its constraints (solved per frame on the UI thread), drag on empty space to box-select
 * (left to right: window, right to left: crossing).
 */
import type { SketchSel } from "../../sketch/constraints";
import { arcParams, dist, nearestOnCurve, type LiteralCurve, type P2 } from "../../sketch/geom";
import { EMPTY_PREVIEW, type PointerIn, type SketchTool, type ToolApi, type ToolPreview } from "./types";

const DRAG_PX = 4;

function inside(p: P2, a: P2, b: P2): boolean {
  return p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}

function samples(c: LiteralCurve): P2[] {
  switch (c.kind) {
    case "point":
      return [c.at];
    case "line":
      return Array.from({ length: 9 }, (_, k) => [c.start[0] + ((c.end[0] - c.start[0]) * k) / 8, c.start[1] + ((c.end[1] - c.start[1]) * k) / 8]);
    case "circle":
      return Array.from({ length: 24 }, (_, k) => [c.center[0] + c.radius * Math.cos((k * Math.PI) / 12), c.center[1] + c.radius * Math.sin((k * Math.PI) / 12)]);
    case "arc": {
      const ap = arcParams(c);
      return Array.from({ length: 17 }, (_, k) => [ap.center[0] + ap.r * Math.cos(ap.a0 + (ap.sweep * k) / 16), ap.center[1] + ap.r * Math.sin(ap.a0 + (ap.sweep * k) / 16)]);
    }
  }
}

/** The curves a box selects: all samples inside (window) or any (crossing). */
export function boxSelect(curves: readonly LiteralCurve[], a: P2, b: P2, crossing: boolean): string[] {
  return curves.filter((c) => (crossing ? samples(c).some((p) => inside(p, a, b)) : samples(c).every((p) => inside(p, a, b)))).map((c) => c.id);
}

export class SelectTool implements SketchTool {
  readonly id = "select" as const;
  private press: { p: P2; px: P2; target: SketchSel | null; rim: boolean; shift: boolean } | null = null;
  private dragging = false;
  private box: { from: P2; to: P2; crossing: boolean } | null = null;

  hint(): string {
    return "Click to select · drag geometry to move it · drag on empty space to box-select";
  }

  private target(p: P2, api: ToolApi): { sel: SketchSel | null; rim: boolean } {
    const pt = api.hitPoint(p);
    if (pt) return { sel: { kind: "point", ref: pt.ref }, rim: false };
    const c = api.hitCurve(p);
    if (!c) return { sel: null, rim: false };
    return { sel: { kind: "curve", id: c.id }, rim: c.kind === "circle" && dist(p, c.center) > api.tol() * 2 };
  }

  down(p: P2, e: PointerIn, api: ToolApi): void {
    if (e.button !== 0) return;
    const t = this.target(p, api);
    this.press = { p, px: e.px, target: t.sel, rim: t.rim, shift: e.shift };
    this.dragging = false;
  }

  move(p: P2, e: PointerIn, api: ToolApi): void {
    if (!this.press) return;
    const moved = Math.hypot(e.px[0] - this.press.px[0], e.px[1] - this.press.px[1]) > DRAG_PX;
    if (!moved && !this.dragging && !this.box) return;
    if (this.press.target) {
      if (!this.dragging) {
        const t = this.press.target;
        const id = t.kind === "point" ? t.ref : t.kind === "curve" ? t.id : null;
        if (!id) return;
        this.dragging = api.dragBegin(id, this.press.p, this.press.rim ? "rim" : undefined);
        if (!this.dragging) {
          this.press = null;
          return;
        }
      }
      api.dragTo(p);
    } else {
      this.box = { from: this.press.p, to: p, crossing: p[0] < this.press.p[0] };
    }
  }

  up(_p: P2, _e: PointerIn, api: ToolApi): void {
    const press = this.press;
    this.press = null;
    if (!press) return;
    if (this.dragging) {
      this.dragging = false;
      api.dragEnd();
      return;
    }
    if (this.box) {
      const ids = boxSelect(api.curves(), this.box.from, this.box.to, this.box.crossing);
      const next: SketchSel[] = ids.map((id) => ({ kind: "curve", id }));
      api.setSelection(press.shift ? merge(api.selection(), next) : next);
      this.box = null;
      return;
    }
    if (!press.target) {
      if (!press.shift) api.setSelection([]);
      return;
    }
    const cur = api.selection();
    const same = (s: SketchSel): boolean => JSON.stringify(s) === JSON.stringify(press.target);
    if (press.shift) api.setSelection(cur.some(same) ? cur.filter((s) => !same(s)) : [...cur, press.target]);
    else api.setSelection([press.target]);
  }

  escape(api: ToolApi): boolean {
    if (this.dragging) {
      api.dragCancel();
      this.dragging = false;
      this.press = null;
      return true;
    }
    if (this.box) {
      this.box = null;
      this.press = null;
      return true;
    }
    if (api.selection().length) {
      api.setSelection([]);
      return true;
    }
    return false;
  }

  preview(): ToolPreview {
    return { ...EMPTY_PREVIEW, box: this.box };
  }
}

function merge(a: readonly SketchSel[], b: readonly SketchSel[]): SketchSel[] {
  const key = (s: SketchSel): string => JSON.stringify(s);
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((s) => !seen.has(key(s)))];
}

/** Distance from a pointer to a curve (hit testing helper, exported for tests). */
export function curveDistance(c: LiteralCurve, p: P2): number {
  return nearestOnCurve(c, p).distance;
}
