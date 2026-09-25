/**
 * `ManipulatorHost`: the API tools use to put handles on the canvas.
 *
 * ```ts
 * const off = runtime.manipulators.show(
 *   [{ id: "distance", kind: "pushPull", origin, axis: normal, value: 10, min: 0.1 }],
 *   (c) => { if (c.phase === "drag") session.set("distance", c.value); if (c.phase === "end") session.commit(); },
 * );
 * // later: runtime.manipulators.update("distance", { value: 12 }); off();
 * ```
 *
 * The host keeps the handles and the active drag in a store; `ManipulatorLayer` draws them and
 * turns pointer events into `begin`/`move`/`end` calls here. Only one set of handles is shown at a
 * time (the active tool's); `show` replaces the previous set, whose listener gets `cancel` if a
 * drag was in flight.
 */
import { Store } from "../../store";
import type { CameraFrame } from "../view-camera";
import { dragParam, dragValue, unwrapDegrees, type DragStart } from "./drag-math";
import type { HandleChange, HandleListener, HandleSpec } from "./types";

export interface ActiveDrag {
  id: string;
  value: number;
  clamped?: "min" | "max";
}

export interface ManipulatorState {
  handles: readonly HandleSpec[];
  active: ActiveDrag | null;
  /** Hovered handle id. */
  hover: string | null;
  revision: number;
}

export class ManipulatorHost extends Store<ManipulatorState> {
  private listener: HandleListener | null = null;
  private drag: { id: string; start: DragStart; lastParam: number; accumulated: number } | null = null;
  /** Every change emitted, most recent last (bounded; e2e and debugging). */
  readonly log: HandleChange[] = [];

  constructor() {
    super({ handles: [], active: null, hover: null, revision: 0 });
  }

  /** Show `handles` (replacing any others); returns a function that removes them. */
  show(handles: readonly HandleSpec[], listener: HandleListener): () => void {
    this.cancelDrag();
    this.listener = listener;
    this.setState((s) => ({ handles: handles.map((h) => ({ ...h })), active: null, hover: null, revision: s.revision + 1 }));
    const mine = listener;
    return () => {
      if (this.listener !== mine) return;
      this.cancelDrag();
      this.listener = null;
      this.setState((s) => ({ handles: [], active: null, hover: null, revision: s.revision + 1 }));
    };
  }

  update(id: string, patch: Partial<Omit<HandleSpec, "id">>): void {
    this.setState((s) => ({ handles: s.handles.map((h) => (h.id === id ? { ...h, ...patch } : h)), revision: s.revision + 1 }));
  }

  handle(id: string): HandleSpec | undefined {
    return this.getState().handles.find((h) => h.id === id);
  }

  setHover(id: string | null): void {
    if (this.getState().hover !== id) this.setState({ hover: id });
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  private emit(c: HandleChange): void {
    this.log.push(c);
    if (this.log.length > 200) this.log.shift();
    this.listener?.(c);
  }

  /** Pointer-down on a handle's grip at pixel (x, y). Returns whether a drag started. */
  begin(id: string, frame: CameraFrame, x: number, y: number): boolean {
    const h = this.handle(id);
    if (!h) return false;
    const param = dragParam(h, frame.ray(x, y));
    if (param === null) return false;
    this.drag = { id, start: { value: h.value, param }, lastParam: param, accumulated: 0 };
    this.setState({ active: { id, value: h.value } });
    this.emit({ id, value: h.value, phase: "start" });
    return true;
  }

  /** Pointer-move during a drag. `fine` (Shift) uses the fine step; `snap: false` (Alt) disables snapping. */
  move(frame: CameraFrame, x: number, y: number, opts: { fine: boolean; snap: boolean }): number | null {
    const d = this.drag;
    if (!d) return null;
    const h = this.handle(d.id);
    if (!h) return null;
    const param = dragParam(h, frame.ray(x, y));
    if (param === null) return this.getState().active?.value ?? null;
    if (h.kind === "rotate") {
      d.accumulated += unwrapDegrees(param - d.lastParam);
      d.lastParam = param;
    }
    const r = dragValue(h, d.start, param, { ...opts, accumulated: d.accumulated });
    this.update(h.id, { value: r.value });
    this.setState({ active: { id: h.id, value: r.value, ...(r.clamped ? { clamped: r.clamped } : {}) } });
    this.emit({ id: h.id, value: r.value, phase: "drag", ...(r.clamped ? { clamped: r.clamped } : {}) });
    return r.value;
  }

  /** Set the dragged value directly (Tab during a drag: a typed value). */
  typeValue(value: number): void {
    const d = this.drag;
    if (!d) return;
    const h = this.handle(d.id);
    if (!h) return;
    let v = value;
    let clamped: "min" | "max" | undefined;
    if (h.min !== undefined && v < h.min) {
      v = h.min;
      clamped = "min";
    } else if (h.max !== undefined && v > h.max) {
      v = h.max;
      clamped = "max";
    }
    this.update(h.id, { value: v });
    this.setState({ active: { id: h.id, value: v, ...(clamped ? { clamped } : {}) } });
    this.emit({ id: h.id, value: v, phase: "drag", ...(clamped ? { clamped } : {}) });
  }

  end(): number | null {
    const d = this.drag;
    if (!d) return null;
    this.drag = null;
    const v = this.handle(d.id)?.value ?? d.start.value;
    this.setState({ active: null });
    this.emit({ id: d.id, value: v, phase: "end" });
    return v;
  }

  /** Esc during a drag: the handle snaps back to where the drag started. */
  cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.update(d.id, { value: d.start.value });
    this.setState({ active: null });
    this.emit({ id: d.id, value: d.start.value, phase: "cancel" });
  }
}
