/**
 * A property panel's live session: the values of its fields, their checks, the debounced live
 * preview (a newer preview aborts the older one, and stale results are dropped), and OK / Apply /
 * Cancel. React renders it (`ui/shell/PropertyPanel.tsx`); tests drive it directly.
 */
import { Store } from "../../store";
import { checkNumberText } from "./expr";
import type {
  CommitOutcome,
  FieldError,
  FieldSpec,
  FieldValue,
  NumberValue,
  PanelSessionHandle,
  PanelSpec,
  PanelState,
  PanelValues,
  ParamsPort,
  SelectionItem,
  SelectionKind,
  SelectionPort,
  SummaryRow,
} from "./types";

export interface FieldState {
  key: string;
  spec: FieldSpec;
  value: FieldValue;
  /** The field's own check (null: fine). `REQUIRED` means "not given yet", shown as a prompt, not an error. */
  error: FieldError | null;
  /** An error the preview or the last commit reported for this field (cleared when the value changes). */
  remoteError: FieldError | null;
  /** Number fields: `= 12.7 mm` when the text is an expression or has another unit. */
  resolved: string | null;
  visible: boolean;
  /** Selection fields: selected things of other kinds that this input ignores. */
  ignored: number;
}

export interface PanelSessionState {
  id: number;
  toolId: string | null;
  title: string;
  icon: string | null;
  description: string | null;
  okLabel: string;
  apply: boolean;
  readOnly: boolean;
  fields: readonly FieldState[];
  state: PanelState;
  /** Errors not tied to a field (from the preview, the commit or `validate`). */
  errors: readonly FieldError[];
  summary: readonly SummaryRow[];
  warnings: readonly string[];
  /** The selection input that follows the viewport selection (null: none). */
  activeSelectionField: string | null;
  /** Revision of the values: increments on every change. */
  revision: number;
  /** How the panel closed (null while open). */
  closedBy: "ok" | "cancel" | "replaced" | null;
}

export type CloseReason = "ok" | "cancel" | "replaced";

export interface PanelSessionOptions {
  id: number;
  toolId?: string | null;
  params: ParamsPort;
  selection: SelectionPort;
  /** Called once when the panel closes. */
  onClose?: (reason: CloseReason, session: PanelSession) => void;
}

const DEFAULT_PREVIEW_DELAY_MS = 150;

function numberValue(text: string): NumberValue {
  return { text, value: null, expression: false, canonical: null };
}

function accepts(kinds: readonly SelectionKind[], item: SelectionItem): boolean {
  return kinds.includes(item.kind);
}

/** Plural noun for a selection count: `1 edge`, `3 faces`, `2 items`. */
export function selectionNoun(kinds: readonly SelectionKind[], n: number): string {
  const names: Partial<Record<SelectionKind, [string, string]>> = {
    face: ["face", "faces"],
    edge: ["edge", "edges"],
    vertex: ["vertex", "vertices"],
    body: ["body", "bodies"],
    feature: ["feature", "features"],
    datum: ["datum", "datums"],
    origin: ["plane", "planes"],
    sketchCurve: ["curve", "curves"],
    sketchPoint: ["point", "points"],
    region: ["region", "regions"],
    param: ["parameter", "parameters"],
  };
  const pair = kinds.length === 1 ? names[kinds[0]!] : undefined;
  const [one, many] = pair ?? ["item", "items"];
  return `${n} ${n === 1 ? one : many}`;
}

function describeKinds(kinds: readonly SelectionKind[]): string {
  const plural: Partial<Record<SelectionKind, string>> = {
    face: "faces",
    edge: "edges",
    vertex: "vertices",
    body: "bodies",
    feature: "features",
    datum: "datum planes",
    origin: "origin planes",
    sketchCurve: "sketch curves",
    sketchPoint: "sketch points",
    region: "regions",
    param: "parameters",
  };
  const words = kinds.map((k) => plural[k] ?? k);
  return words.length <= 1 ? (words[0] ?? "items") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

export class PanelSession extends Store<PanelSessionState> implements PanelSessionHandle {
  readonly id: number;
  private readonly spec: PanelSpec;
  private readonly params: ParamsPort;
  private readonly selectionPort: SelectionPort;
  private readonly onClose: ((reason: CloseReason, session: PanelSession) => void) | undefined;
  private readonly initialValues: Map<string, FieldValue>;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewAbort: AbortController | null = null;
  private previewSeq = 0;
  private unsubscribeSelection: (() => void) | null = null;
  /** The promise of the preview in flight (tests await it). */
  private previewPromise: Promise<void> = Promise.resolve();

  constructor(spec: PanelSpec, options: PanelSessionOptions) {
    const selected = options.selection.items();
    const fields: FieldState[] = [];
    let activeSelectionField: string | null = null;
    for (const f of spec.fields) {
      let value: FieldValue;
      let ignored = 0;
      const given = spec.initial?.[f.key];
      switch (f.kind) {
        case "number":
          value = given !== undefined ? (typeof given === "string" ? numberValue(given) : (given as NumberValue)) : numberValue(f.default ?? "");
          break;
        case "selection": {
          if (given !== undefined) value = given as readonly SelectionItem[];
          else if (f.fromSelection !== false) {
            value = selected.filter((s) => accepts(f.accepts, s));
            ignored = selected.length - value.length;
          } else value = [];
          activeSelectionField ??= f.key;
          break;
        }
        case "choice":
          value = given !== undefined ? String(given) : (f.default ?? f.options[0]?.value ?? "");
          break;
        case "toggle":
          value = given !== undefined ? Boolean(given) : (f.default ?? false);
          break;
        case "text":
          value = given !== undefined ? String(given) : (f.default ?? "");
          break;
      }
      fields.push({ key: f.key, spec: f, value, error: null, remoteError: null, resolved: null, visible: true, ignored });
    }
    super({
      id: options.id,
      toolId: options.toolId ?? null,
      title: spec.title,
      icon: spec.icon ?? null,
      description: spec.description ?? null,
      okLabel: spec.okLabel ?? "OK",
      apply: spec.apply ?? false,
      readOnly: spec.readOnly ?? false,
      fields,
      state: "collecting",
      errors: [],
      summary: [],
      warnings: [],
      activeSelectionField,
      revision: 0,
      closedBy: null,
    });
    this.id = options.id;
    this.spec = spec;
    this.params = options.params;
    this.selectionPort = options.selection;
    this.onClose = options.onClose;
    this.initialValues = new Map(fields.map((f) => [f.key, f.value]));
    if (activeSelectionField !== null) this.unsubscribeSelection = this.selectionPort.subscribe(() => this.followSelection());
    this.revalidate(true);
  }

  // ─── Reading ──────────────────────────────────────────────────────────────────────────────

  /** The current values by key (number fields carry their checked {@link NumberValue}). */
  values(): PanelValues {
    const out: Record<string, FieldValue> = {};
    for (const f of this.getState().fields) out[f.key] = f.value;
    return out;
  }

  get closed(): boolean {
    return this.getState().state === "closed";
  }

  /** Resolves when no preview is scheduled or running. */
  async settled(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      if (this.previewTimer === null) {
        await this.previewPromise;
        if (this.previewTimer === null) return;
      } else {
        await new Promise((r) => setTimeout(r, (this.spec.previewDelayMs ?? DEFAULT_PREVIEW_DELAY_MS) + 1));
      }
    }
  }

  // ─── Editing ──────────────────────────────────────────────────────────────────────────────

  /**
   * Set a field. Number fields take the typed text (or a {@link NumberValue}); selection fields an
   * array of items; choices one of their option values; toggles a boolean; text fields a string.
   */
  set(key: string, value: FieldValue | string): void {
    if (this.closed) return;
    const field = this.getState().fields.find((f) => f.key === key);
    if (!field) throw new Error(`panel "${this.getState().title}" has no field ${key}`);
    let next: FieldValue;
    switch (field.spec.kind) {
      case "number":
        next = numberValue(typeof value === "string" ? value : typeof value === "object" && value !== null && "text" in value ? value.text : String(value));
        break;
      case "selection":
        if (!Array.isArray(value)) throw new Error(`${key} takes a list of selected items`);
        next = (value as readonly SelectionItem[]).filter((s) => accepts((field.spec as { accepts: readonly SelectionKind[] }).accepts, s));
        break;
      case "choice": {
        const v = String(value);
        if (!field.spec.options.some((o) => o.value === v)) throw new Error(`${key}: "${v}" is not one of ${field.spec.options.map((o) => o.value).join(", ")}`);
        next = v;
        break;
      }
      case "toggle":
        next = Boolean(value);
        break;
      case "text":
        next = String(value);
        break;
    }
    this.setState((s) => ({
      fields: s.fields.map((f) => (f.key === key ? { ...f, value: next, remoteError: null, ignored: f.spec.kind === "selection" ? 0 : f.ignored } : f)),
      revision: s.revision + 1,
      errors: [],
    }));
    this.revalidate(false);
  }

  /** Make a selection input follow the viewport selection from now on (clicking the input does this). */
  activateSelectionField(key: string | null): void {
    if (key !== null && !this.getState().fields.some((f) => f.key === key && f.spec.kind === "selection")) return;
    this.setState({ activeSelectionField: key });
  }

  /** Empty a selection input. */
  clearSelectionField(key: string): void {
    this.set(key, []);
  }

  private followSelection(): void {
    const key = this.getState().activeSelectionField;
    if (key === null || this.closed) return;
    const field = this.getState().fields.find((f) => f.key === key);
    if (!field || field.spec.kind !== "selection") return;
    const items = this.selectionPort.items();
    const kinds = field.spec.accepts;
    const taken = items.filter((s) => accepts(kinds, s));
    const ignored = items.length - taken.length;
    this.setState((s) => ({
      fields: s.fields.map((f) => (f.key === key ? { ...f, value: taken, remoteError: null, ignored } : f)),
      revision: s.revision + 1,
      errors: [],
    }));
    this.revalidate(false);
  }

  // ─── Checks and preview ──────────────────────────────────────────────────────────────────

  private checkField(f: FieldState): Pick<FieldState, "error" | "resolved" | "value"> {
    const spec = f.spec;
    switch (spec.kind) {
      case "number": {
        const r = checkNumberText((f.value as NumberValue).text, spec, this.params.list());
        return { error: r.error, resolved: r.resolved, value: r.value };
      }
      case "selection": {
        const n = (f.value as readonly SelectionItem[]).length;
        const min = spec.min ?? 1;
        if (n < min) {
          const what = describeKinds(spec.accepts);
          const message = min === 1 ? `Select ${what}.` : `Select at least ${min} ${what}.`;
          return { error: { field: f.key, code: "REQUIRED", message }, resolved: null, value: f.value };
        }
        if (spec.max !== undefined && n > spec.max) {
          return { error: { field: f.key, code: "TOO_MANY", message: `Select at most ${selectionNoun(spec.accepts, spec.max)}.` }, resolved: null, value: f.value };
        }
        return { error: null, resolved: null, value: f.value };
      }
      case "choice":
        return { error: null, resolved: null, value: f.value };
      case "toggle":
        return { error: null, resolved: null, value: f.value };
      case "text": {
        const t = String(f.value);
        if (t.trim() === "" && !spec.optional) return { error: { field: f.key, code: "REQUIRED", message: `Enter ${spec.label.toLowerCase()}.` }, resolved: null, value: f.value };
        if (spec.maxLength !== undefined && t.length > spec.maxLength) {
          return { error: { field: f.key, code: "TOO_LONG", message: `At most ${spec.maxLength} characters.` }, resolved: null, value: f.value };
        }
        if (spec.pattern && t !== "" && !spec.pattern.test(t)) {
          return { error: { field: f.key, code: "PATTERN", message: spec.patternMessage ?? "Not a valid value." }, resolved: null, value: f.value };
        }
        return { error: null, resolved: null, value: f.value };
      }
    }
  }

  /** Re-run the field checks; when everything checks, schedule the preview. */
  private revalidate(initial: boolean): void {
    if (this.closed) return;
    const s = this.getState();
    let values = this.values();
    const fields: FieldState[] = s.fields.map((f) => {
      const visible = f.spec.visibleWhen ? f.spec.visibleWhen(values) : true;
      const r = this.checkField(f);
      return { ...f, ...r, visible };
    });
    values = Object.fromEntries(fields.map((f) => [f.key, f.value]));
    const localErrors = fields.filter((f) => f.visible && f.error !== null);
    const crossErrors = localErrors.length === 0 && this.spec.validate ? [...this.spec.validate(values)] : [];
    const crossByField = new Map(crossErrors.filter((e) => e.field).map((e) => [e.field!, e]));
    const withCross = fields.map((f) => (crossByField.has(f.key) && f.error === null ? { ...f, error: crossByField.get(f.key)! } : f));
    const panelErrors = crossErrors.filter((e) => !e.field);
    const blocked = localErrors.length > 0 || crossErrors.length > 0;
    this.cancelPreview();
    const state: PanelState = blocked ? "collecting" : this.spec.preview ? "previewing" : "ready";
    this.setState({ fields: withCross, errors: panelErrors, state, ...(blocked ? { summary: [] } : {}) });
    if (!blocked && this.spec.preview) this.schedulePreview(initial ? 0 : (this.spec.previewDelayMs ?? DEFAULT_PREVIEW_DELAY_MS));
  }

  private cancelPreview(): void {
    if (this.previewTimer !== null) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.previewAbort?.abort();
    this.previewAbort = null;
    this.previewSeq++;
  }

  private schedulePreview(delay: number): void {
    const seq = this.previewSeq;
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      this.previewPromise = this.runPreview(seq);
    }, delay);
  }

  private async runPreview(seq: number): Promise<void> {
    const preview = this.spec.preview;
    if (!preview || seq !== this.previewSeq || this.closed) return;
    const abort = new AbortController();
    this.previewAbort = abort;
    let outcome;
    try {
      outcome = await preview(this.values(), { signal: abort.signal });
    } catch (e) {
      if (abort.signal.aborted) return;
      outcome = { ok: false as const, errors: [{ code: "PREVIEW_FAILED", message: `The preview failed: ${e instanceof Error ? e.message : String(e)}` }] };
    }
    if (abort.signal.aborted || seq !== this.previewSeq || this.closed) return;
    this.previewAbort = null;
    this.applyOutcomeErrors(outcome.ok ? [] : outcome.errors);
    this.setState({
      state: outcome.ok ? "ready" : "invalid",
      summary: outcome.summary ?? [],
      warnings: outcome.ok ? (outcome.warnings ?? []) : [],
    });
  }

  private applyOutcomeErrors(errors: readonly FieldError[]): void {
    const byField = new Map<string, FieldError>();
    const panel: FieldError[] = [];
    const keys = new Set(this.getState().fields.map((f) => f.key));
    for (const e of errors) {
      if (e.field && keys.has(e.field) && !byField.has(e.field)) byField.set(e.field, e);
      else panel.push(e);
    }
    this.setState((s) => ({
      fields: s.fields.map((f) => ({ ...f, remoteError: byField.get(f.key) ?? null })),
      errors: panel,
    }));
  }

  // ─── OK / Apply / Cancel ─────────────────────────────────────────────────────────────────

  /** OK: commit as one transaction; closes on success. Read-only panels just close. */
  commit(): Promise<CommitOutcome> {
    return this.finish(false);
  }

  /** Apply: commit, then start over with the initial values (the panel stays open). */
  apply(): Promise<CommitOutcome> {
    return this.finish(true);
  }

  private async finish(keepOpen: boolean): Promise<CommitOutcome> {
    const s = this.getState();
    if (s.state === "closed") return { ok: false, errors: [{ code: "CLOSED", message: "The panel is closed." }] };
    if (s.state === "committing") return { ok: false, errors: [{ code: "BUSY", message: "Already committing." }] };
    if (s.readOnly || !this.spec.commit) {
      this.close("ok");
      return { ok: true };
    }
    const blocking = s.fields.filter((f) => f.visible && f.error !== null).map((f) => f.error!);
    if (blocking.length > 0 || s.state === "collecting") {
      return { ok: false, errors: blocking.length ? blocking : s.errors.length ? s.errors : [{ code: "INCOMPLETE", message: "Fill in the highlighted fields first." }] };
    }
    if (s.state === "invalid") {
      const reported = [...s.errors, ...s.fields.flatMap((f) => (f.remoteError ? [f.remoteError] : []))];
      return { ok: false, errors: reported.length ? reported : [{ code: "INVALID", message: "The preview reported a problem; change a value first." }] };
    }
    this.cancelPreview();
    this.setState({ state: "committing" });
    let outcome: CommitOutcome;
    try {
      outcome = await this.spec.commit(this.values());
    } catch (e) {
      outcome = { ok: false, errors: [{ code: "COMMIT_FAILED", message: e instanceof Error ? e.message : String(e) }] };
    }
    if (this.closed) return outcome;
    if (!outcome.ok) {
      this.applyOutcomeErrors(outcome.errors);
      this.setState({ state: "invalid" });
      return outcome;
    }
    if (keepOpen) {
      this.setState((st) => ({
        fields: st.fields.map((f) => ({ ...f, value: this.initialValues.get(f.key) ?? f.value, remoteError: null })),
        revision: st.revision + 1,
        errors: [],
        summary: [],
      }));
      this.revalidate(true);
      return outcome;
    }
    this.close("ok");
    return outcome;
  }

  /** Cancel (Esc): drop the preview and close; nothing is committed. */
  cancel(): void {
    if (this.closed) return;
    this.close("cancel");
  }

  /** Close because another tool replaced this panel. */
  replace(): void {
    if (this.closed) return;
    this.close("replaced");
  }

  private close(reason: CloseReason): void {
    this.cancelPreview();
    this.unsubscribeSelection?.();
    this.unsubscribeSelection = null;
    if (reason !== "ok") {
      try {
        this.spec.cancel?.();
      } catch {
        // A tool's cleanup must not keep the panel open.
      }
    }
    this.setState({ state: "closed", closedBy: reason });
    this.onClose?.(reason, this);
  }
}
