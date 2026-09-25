/**
 * A property panel's live session: the values of its fields, their checks, the debounced live
 * preview (a newer preview aborts the older one, and stale results are dropped, bodies included),
 * and OK / Apply / Cancel. React renders it (`ui/shell/PropertyPanel.tsx`); tests drive it directly.
 *
 * Two guarantees the tools rely on:
 * - **OK commits only checked values.** While a preview is scheduled or running, OK waits for it
 *   (running a scheduled one at once) and commits only if it passes. A preview that passed at an
 *   older document revision doesn't count: OK checks again first.
 * - **The panel follows the document.** Any document change (undo, the code editor, an accepted
 *   agent proposal, a new evaluation) aborts the running preview and checks again, so read-only
 *   panels refresh and feature panels preview against the current part. `toOps` are applied to the
 *   document as it is at OK time.
 */
import type { CommandSource } from "../../commands/registry";
import type { RenderBody } from "../../engine/types";
import { Store } from "../../store";
import { checkNumberText } from "./expr";
import type {
  CommitOutcome,
  DocumentPort,
  FieldError,
  FieldSpec,
  FieldValue,
  NumberValue,
  OpsPort,
  PanelHandle,
  PanelSessionHandle,
  PanelSpec,
  PanelState,
  PanelValues,
  ParamsPort,
  PreviewOutcome,
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
  /** OK was pressed while the preview ran: the commit waits for the check. */
  pendingCommit: boolean;
  /** A one-line note for the user (e.g. why OK did not close the panel); cleared by the next edit. */
  notice: string | null;
  /** Manipulator handles of the last preview that returned any (kept while a preview fails). */
  handles: readonly PanelHandle[];
}

export type CloseReason = "ok" | "cancel" | "replaced";

export interface PanelSessionOptions {
  id: number;
  toolId?: string | null;
  params: ParamsPort;
  selection: SelectionPort;
  /** The document: a change re-checks the panel. */
  document: DocumentPort;
  /** Where `toOps` are applied (one transaction). Required for panels with `toOps`. */
  ops?: OpsPort | null;
  /** Called once when the panel closes. */
  onClose?: (reason: CloseReason, session: PanelSession) => void;
  /**
   * The preview geometry to draw now: the last passing preview's bodies (null: the document).
   * `stale`: a newer check is running, so they may not match the fields any more.
   */
  onPreviewBodies?: (bodies: readonly RenderBody[] | null, stale: boolean) => void;
}

const DEFAULT_PREVIEW_DELAY_MS = 150;
/** How often OK checks again when the document keeps changing under it before giving up. */
const MAX_COMMIT_CHECKS = 5;

function numberValue(text: string): NumberValue {
  return { text, value: null, expression: false, canonical: null };
}

/** An initial value (`PanelSpec.initial`, `tool.start` args) as the field's value; throws when it can't be one. */
function initialValue(f: FieldSpec, given: unknown): FieldValue {
  switch (f.kind) {
    case "number":
      if (typeof given === "string") return numberValue(given);
      if (typeof given === "number" && Number.isFinite(given)) return numberValue(String(given));
      if (typeof given === "object" && given !== null && typeof (given as { text?: unknown }).text === "string") return numberValue((given as NumberValue).text);
      throw new Error(`${f.key} takes a number or an expression, like "12" or "wall * 2"`);
    case "selection":
      if (!Array.isArray(given) || !given.every((x) => typeof x === "object" && x !== null && typeof (x as { kind?: unknown }).kind === "string")) {
        throw new Error(`${f.key} takes a list of selected items`);
      }
      return given as readonly SelectionItem[];
    case "choice": {
      const v = String(given);
      if (!f.options.some((o) => o.value === v)) throw new Error(`${f.key}: "${v}" is not one of ${f.options.map((o) => o.value).join(", ")}`);
      return v;
    }
    case "toggle":
      if (typeof given !== "boolean") throw new Error(`${f.key} takes true or false`);
      return given;
    case "text":
      if (typeof given !== "string") throw new Error(`${f.key} takes text`);
      return given;
  }
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
  private readonly onPreviewBodies: ((bodies: readonly RenderBody[] | null, stale: boolean) => void) | undefined;
  private readonly document: DocumentPort;
  private readonly ops: OpsPort | null;
  private readonly initialValues: Map<string, FieldValue>;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewAbort: AbortController | null = null;
  private previewSeq = 0;
  private unsubscribeSelection: (() => void) | null = null;
  private unsubscribeDocument: (() => void) | null = null;
  /** The promise of the preview in flight (tests await it). */
  private previewPromise: Promise<void> = Promise.resolve();
  /** The document revision the panel last saw. */
  private seenRevision: number;
  /** The document revision the last passing preview checked (null: none passed for these values). */
  private checkedRevision: number | null = null;
  /** The last passing preview's bodies (drawn while current). */
  private bodies: readonly RenderBody[] | null = null;
  /** The document changed while a commit ran. */
  private changedWhileCommitting = false;

  constructor(spec: PanelSpec, options: PanelSessionOptions) {
    if (spec.toOps && spec.commit) throw new Error(`panel "${spec.title}" has both toOps and commit; a panel commits one way`);
    const selected = options.selection.items();
    const fields: FieldState[] = [];
    let activeSelectionField: string | null = null;
    const keys = new Set(spec.fields.map((f) => f.key));
    const unknown = Object.keys(spec.initial ?? {}).filter((k) => !keys.has(k));
    if (unknown.length > 0) throw new Error(`${spec.title} has no input ${unknown.join(", ")} (its inputs: ${[...keys].join(", ") || "none"})`);
    for (const f of spec.fields) {
      let value: FieldValue;
      let ignored = 0;
      const given = spec.initial?.[f.key];
      if (given !== undefined) value = initialValue(f, given);
      else {
        switch (f.kind) {
          case "number":
            value = numberValue(f.default ?? "");
            break;
          case "selection":
            if (f.fromSelection !== false) {
              value = selected.filter((s) => accepts(f.accepts, s));
              ignored = selected.length - value.length;
            } else value = [];
            break;
          case "choice":
            value = f.default ?? f.options[0]?.value ?? "";
            break;
          case "toggle":
            value = f.default ?? false;
            break;
          case "text":
            value = f.default ?? "";
            break;
        }
      }
      if (f.kind === "selection") activeSelectionField ??= f.key;
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
      pendingCommit: false,
      notice: null,
      handles: [],
    });
    this.id = options.id;
    this.spec = spec;
    this.params = options.params;
    this.selectionPort = options.selection;
    this.document = options.document;
    this.ops = options.ops ?? null;
    this.onClose = options.onClose;
    this.onPreviewBodies = options.onPreviewBodies;
    this.initialValues = new Map(fields.map((f) => [f.key, f.value]));
    this.seenRevision = this.document.revision();
    if (activeSelectionField !== null) this.unsubscribeSelection = this.selectionPort.subscribe(() => this.followSelection());
    this.unsubscribeDocument = this.document.subscribe(() => this.onDocumentChanged());
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
      notice: null,
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
      notice: null,
    }));
    this.revalidate(false);
  }

  /** The document changed (any origin): check again, against the new document. */
  private onDocumentChanged(): void {
    if (this.closed) return;
    const rev = this.document.revision();
    if (rev === this.seenRevision) return;
    this.seenRevision = rev;
    if (this.getState().state === "committing") {
      // Usually the commit itself; the commit decides what to do next.
      this.changedWhileCommitting = true;
      return;
    }
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
    this.checkedRevision = null;
    const state: PanelState = blocked ? "collecting" : this.spec.preview ? "previewing" : "ready";
    this.setState({ fields: withCross, errors: panelErrors, state, ...(blocked ? { summary: [] } : {}) });
    // What the viewport draws meanwhile: nothing for values that don't check; the last preview,
    // marked stale, while the next one runs.
    if (blocked || !this.spec.preview) this.showBodies(null, false);
    else this.showBodies(this.bodies, true);
    if (!blocked && this.spec.preview) this.schedulePreview(initial ? 0 : (this.spec.previewDelayMs ?? DEFAULT_PREVIEW_DELAY_MS));
  }

  private showBodies(bodies: readonly RenderBody[] | null, stale: boolean): void {
    this.bodies = bodies;
    if (!this.closed) this.onPreviewBodies?.(bodies, stale && bodies !== null);
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

  /** Run a scheduled preview now (OK doesn't wait for the debounce). */
  private flushPreview(): void {
    if (this.previewTimer === null) return;
    clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.previewPromise = this.runPreview(this.previewSeq);
  }

  private async runPreview(seq: number): Promise<void> {
    const preview = this.spec.preview;
    if (!preview || seq !== this.previewSeq || this.closed) return;
    const abort = new AbortController();
    this.previewAbort = abort;
    const revision = this.document.revision();
    let outcome: PreviewOutcome;
    try {
      outcome = await preview(this.values(), { signal: abort.signal, revision });
    } catch (e) {
      if (abort.signal.aborted) return;
      outcome = { ok: false as const, errors: [{ code: "PREVIEW_FAILED", message: `The preview failed: ${e instanceof Error ? e.message : String(e)}` }] };
    }
    if (abort.signal.aborted || seq !== this.previewSeq || this.closed) return;
    this.previewAbort = null;
    if (revision !== this.document.revision()) {
      // The document changed under the preview and no newer one started yet: check again.
      this.revalidate(true);
      return;
    }
    this.applyOutcomeErrors(outcome.ok ? [] : outcome.errors);
    this.checkedRevision = outcome.ok ? revision : null;
    this.setState({
      state: outcome.ok ? "ready" : "invalid",
      summary: outcome.summary ?? [],
      warnings: outcome.ok ? (outcome.warnings ?? []) : [],
      ...(outcome.handles ? { handles: outcome.handles } : {}),
    });
    this.showBodies(outcome.ok ? (outcome.bodies ?? null) : null, false);
  }

  /** Resolves when the check of the current values and document has finished (or the panel closed). */
  private async waitForCheck(): Promise<void> {
    for (let i = 0; i < MAX_COMMIT_CHECKS; i++) {
      if (this.closed) return;
      const s = this.getState();
      if (s.state === "ready" && this.checkedRevision !== this.document.revision()) this.revalidate(true);
      if (this.getState().state !== "previewing") return;
      this.flushPreview();
      await new Promise<void>((resolve) => {
        const done = (): boolean => this.closed || this.getState().state !== "previewing";
        if (done()) return resolve();
        const off = this.subscribe(() => {
          if (!done()) return;
          off();
          resolve();
        });
      });
      if (this.closed || this.getState().state !== "ready" || this.checkedRevision === this.document.revision()) return;
    }
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
  commit(source: CommandSource = "ui"): Promise<CommitOutcome> {
    return this.finish(false, source);
  }

  /** Apply: commit, then start over with the initial values (the panel stays open). */
  apply(source: CommandSource = "ui"): Promise<CommitOutcome> {
    return this.finish(true, source);
  }

  private async finish(keepOpen: boolean, source: CommandSource): Promise<CommitOutcome> {
    const closedOutcome: CommitOutcome = { ok: false, errors: [{ code: "CLOSED", message: "The panel is closed." }] };
    let s = this.getState();
    if (s.state === "closed") return closedOutcome;
    if (s.state === "committing" || s.pendingCommit) return { ok: false, errors: [{ code: "BUSY", message: "Already committing." }] };
    if (s.readOnly || (!this.spec.commit && !this.spec.toOps)) {
      this.close("ok");
      return { ok: true };
    }
    // Only checked values are committed: wait for the preview of these values at this revision.
    if (this.spec.preview && (s.state === "previewing" || (s.state === "ready" && this.checkedRevision !== this.document.revision()))) {
      this.setState({ pendingCommit: true, notice: null });
      try {
        await this.waitForCheck();
      } finally {
        if (!this.closed) this.setState({ pendingCommit: false });
      }
      if (this.closed) return closedOutcome;
      s = this.getState();
      if (s.state === "ready" && this.checkedRevision !== this.document.revision()) {
        return { ok: false, errors: [{ code: "DOCUMENT_BUSY", message: "The part keeps changing; press OK again when it settles." }] };
      }
    }
    const blocking = s.fields.filter((f) => f.visible && f.error !== null).map((f) => f.error!);
    if (blocking.length > 0 || s.state === "collecting") {
      return { ok: false, errors: blocking.length ? blocking : s.errors.length ? s.errors : [{ code: "INCOMPLETE", message: "Fill in the highlighted fields first." }] };
    }
    if (s.state === "invalid") {
      const reported = [...s.errors, ...s.fields.flatMap((f) => (f.remoteError ? [f.remoteError] : []))];
      return { ok: false, errors: reported.length ? reported : [{ code: "INVALID", message: "The preview reported a problem; change a value first." }] };
    }
    if (s.state !== "ready") return { ok: false, errors: [{ code: "NOT_READY", message: "The values are still being checked." }] };
    this.cancelPreview();
    this.changedWhileCommitting = false;
    this.setState({ state: "committing", notice: null });
    let outcome: CommitOutcome;
    try {
      outcome = await this.runCommit(this.values(), source);
    } catch (e) {
      outcome = { ok: false, errors: [{ code: "COMMIT_FAILED", message: e instanceof Error ? e.message : String(e) }] };
    }
    if (this.closed) return outcome;
    if (!outcome.ok) {
      this.showBodies(null, false);
      if (this.changedWhileCommitting || outcome.errors.some((e) => e.code === "COMMAND_STALE")) {
        // The part changed under the commit: nothing was applied. Check again against the new part.
        this.changedWhileCommitting = false;
        this.revalidate(true);
        this.setState({ notice: "The part changed while this change was being applied, so it was not applied. It was checked again: press OK to apply it now." });
        return outcome;
      }
      this.applyOutcomeErrors(outcome.errors);
      this.setState({ state: "invalid" });
      return outcome;
    }
    this.changedWhileCommitting = false;
    this.seenRevision = this.document.revision();
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

  private async runCommit(values: PanelValues, source: CommandSource): Promise<CommitOutcome> {
    if (this.spec.commit) return this.spec.commit(values);
    const ops = await this.spec.toOps!(values);
    if (this.closed) return { ok: false, errors: [{ code: "CLOSED", message: "The panel is closed." }] };
    if (!this.ops) return { ok: false, errors: [{ code: "NO_OPS_PORT", message: "This window can't apply ops (no document store is bound)." }] };
    const label = this.spec.label?.(values) ?? this.getState().title;
    return this.ops.apply(ops, { label, source });
  }

  private close(reason: CloseReason): void {
    this.cancelPreview();
    this.unsubscribeSelection?.();
    this.unsubscribeSelection = null;
    this.unsubscribeDocument?.();
    this.unsubscribeDocument = null;
    if (reason !== "ok") {
      try {
        this.spec.cancel?.();
      } catch {
        // A tool's cleanup must not keep the panel open.
      }
    }
    this.setState({ state: "closed", closedBy: reason, handles: [] });
    this.onClose?.(reason, this);
  }

  // ─── Handles ──────────────────────────────────────────────────────────────────────────────

  /**
   * A handle of this panel was dragged (plan §2.6): its field takes the value (as text), which
   * re-checks and re-previews the panel. `cancel` puts the value the drag started from back.
   */
  handleChanged(id: string, value: number, phase: "start" | "drag" | "end" | "cancel"): void {
    if (this.closed || phase === "start") return;
    const h = this.getState().handles.find((x) => x.id === id);
    if (!h) return;
    const field = this.getState().fields.find((f) => f.key === h.field);
    if (!field || field.spec.kind !== "number") return;
    const text = h.toText ? h.toText(value) : formatHandleValue(value);
    if ((field.value as NumberValue).text === text) return;
    this.set(h.field, text);
  }
}

/** A dragged value as a field's text: at most 4 decimals, no trailing zeros. */
export function formatHandleValue(v: number): string {
  const r = Number(v.toFixed(4));
  return String(Object.is(r, -0) ? 0 : r);
}
