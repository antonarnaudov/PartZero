/**
 * A property panel's manipulator handles (FULL-MODELING-PLAN §2.6): the panel describes them
 * ({@link PanelSpec.handles}), this binds them to its number fields through a {@link HandlesPort}
 * (the viewport's manipulator host):
 *
 * - the handles are placed from the current values, and placed again (debounced) after the values
 *   or the document change — never while one is being dragged;
 * - **at drag start** the panel's `feasible(field)` is asked for the field's feasible range (Forge's
 *   `feasibleRange`), and the handle clamps to it from then on and says why it stopped;
 * - a drag sets the field (the live preview follows), Esc during the drag restores the text it had,
 *   the end of the drag leaves the value in the field; OK commits it like a typed value.
 *
 * Framework-only (no DOM): tests drive it with a fake port.
 */
import { formatNumber } from "./expr";
import type { PanelSession } from "./session";
import type { DocumentPort, FieldError, HandlesPort, NumberValue, PanelHandle, PanelHandleSpec, PanelSpec } from "./types";

const DEFAULT_DELAY_MS = 120;

export class PanelHandles {
  private readonly session: PanelSession;
  private readonly spec: PanelSpec;
  private readonly port: HandlesPort;
  private off: (() => void) | null = null;
  private readonly unsubscribe: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private lastRevision = -1;
  /** The text of the dragged field when its drag started (Esc restores it). */
  private dragStart: { field: string; text: string } | null = null;
  private disposed = false;
  /** The handles shown now (tests). */
  shown: readonly PanelHandleSpec[] = [];
  /** Every feasible-range answer at drag start, most recent last (tests and debugging). */
  readonly feasibleLog: Array<{ field: string; min?: number; max?: number; reason?: string; error?: string }> = [];
  /** Resolves when no placement is pending (tests). */
  private pending: Promise<void> = Promise.resolve();

  constructor(session: PanelSession, spec: PanelSpec, port: HandlesPort, document: DocumentPort, private readonly delayMs = DEFAULT_DELAY_MS) {
    this.session = session;
    this.spec = spec;
    this.port = port;
    this.unsubscribe.push(
      session.subscribe(() => {
        const s = session.getState();
        if (s.state === "closed") return this.dispose();
        if (s.revision !== this.lastRevision) this.schedule();
      }),
    );
    this.unsubscribe.push(document.subscribe(() => this.schedule()));
    this.schedule(0);
  }

  /** Resolves when the handles are placed for the current values. */
  async settled(): Promise<void> {
    for (let i = 0; i < 20 && (this.timer !== null || this.pendingRunning); i++) {
      if (this.timer !== null) await new Promise((r) => setTimeout(r, this.delayMs + 1));
      await this.pending;
    }
  }

  private pendingRunning = false;

  private schedule(delay = this.delayMs): void {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = this.place();
    }, delay);
  }

  private async place(): Promise<void> {
    if (this.disposed || !this.spec.handles) return;
    // Never move handles under the pointer: the drag's own value is what the field shows.
    if (this.port.dragging() && this.dragStart) return;
    const seq = ++this.seq;
    const state = this.session.getState();
    this.lastRevision = state.revision;
    this.pendingRunning = true;
    let handles: readonly PanelHandle[] = [];
    try {
      handles = await this.spec.handles(this.session.values());
    } catch {
      handles = [];
    } finally {
      this.pendingRunning = false;
    }
    if (this.disposed || seq !== this.seq) return;
    const specs: PanelHandleSpec[] = [];
    for (const h of handles) {
      const f = this.session.getState().fields.find((x) => x.key === h.field);
      if (!f || f.spec.kind !== "number" || !f.visible) continue;
      const v = (f.value as NumberValue).value;
      if (v === null || !Number.isFinite(v)) continue;
      specs.push({
        id: h.field,
        kind: h.kind,
        origin: [...h.origin] as [number, number, number],
        axis: [...h.axis] as [number, number, number],
        ...(h.ref ? { ref: [...h.ref] as [number, number, number] } : {}),
        value: v,
        ...(h.min !== undefined ? { min: h.min } : {}),
        ...(h.max !== undefined ? { max: h.max } : {}),
        ...(h.limitReason !== undefined ? { limitReason: h.limitReason } : {}),
        ...(h.step !== undefined ? { step: h.step } : {}),
        ...(h.fineStep !== undefined ? { fineStep: h.fineStep } : {}),
        label: h.label ?? f.spec.label,
        ...(h.size !== undefined ? { size: h.size } : {}),
      });
    }
    if (this.port.dragging() && this.dragStart) return;
    this.off?.();
    this.off = null;
    this.shown = specs;
    if (specs.length === 0) return;
    this.off = this.port.show(specs, (c) => this.onChange(c));
  }

  private onChange(c: { id: string; value: number; phase: "start" | "drag" | "end" | "cancel" }): void {
    if (this.disposed) return;
    const f = this.session.getState().fields.find((x) => x.key === c.id);
    if (!f) return;
    switch (c.phase) {
      case "start": {
        this.dragStart = { field: c.id, text: (f.value as NumberValue).text };
        const feasible = this.spec.feasible;
        if (feasible) {
          void feasible(c.id, this.session.values()).then(
            (r) => {
              this.feasibleLog.push({ field: c.id, ...(r ? { ...(r.min !== undefined ? { min: r.min } : {}), ...(r.max !== undefined ? { max: r.max } : {}), ...(r.reason ? { reason: r.reason } : {}) } : { error: "no range" }) });
              if (this.feasibleLog.length > 50) this.feasibleLog.shift();
              if (this.disposed || !r) return;
              this.port.update(c.id, {
                ...(r.min !== undefined ? { min: r.min } : {}),
                ...(r.max !== undefined ? { max: r.max } : {}),
                ...(r.reason ? { limitReason: r.reason } : {}),
              });
            },
            (e: unknown) => {
              this.feasibleLog.push({ field: c.id, error: e instanceof Error ? e.message : String(e) });
            },
          );
        }
        return;
      }
      case "drag":
        this.session.set(c.id, formatNumber(c.value));
        return;
      case "cancel":
        if (this.dragStart?.field === c.id) this.session.set(c.id, this.dragStart.text);
        this.dragStart = null;
        return;
      case "end":
        this.dragStart = null;
        this.session.set(c.id, formatNumber(c.value));
        return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const u of this.unsubscribe) u();
    this.off?.();
    this.off = null;
    this.shown = [];
  }
}

/** A field error with Forge's feasible range, for number fields a handle drives. */
export function feasibleError(field: string, code: string, message: string, max: number | undefined, min = 0): FieldError {
  return { field, code, message, feasible: { min, ...(max !== undefined ? { max } : {}) } };
}
