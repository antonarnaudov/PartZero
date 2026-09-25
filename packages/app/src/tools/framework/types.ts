/**
 * The tool and property-panel contract (docs FULL-MODELING-PLAN §2.5, contract C3). Other workstreams
 * (feature tools, the sketcher, inspect tools) and the integrator build against this file; the shell
 * (`ui/shell/**`) renders it.
 *
 * A **tool** is a toolbar entry: `{ id, label, group, icon, shortcut, enabledWhen, activate }`.
 * `activate(ctx)` runs when the user clicks the button, presses the shortcut, picks the tool in the
 * command palette or an agent/test runs `tool.start { id }`. It usually opens a **property panel**:
 * either by returning a {@link PanelSpec} or by calling `ctx.openPanel(spec)`. A tool without a
 * panel (a one-shot action) does its work and returns nothing.
 *
 * A **property panel** is described, not drawn: a list of typed {@link FieldSpec}s (numbers with
 * units and expressions, selection inputs with counts, dropdowns, toggles, text), plus callbacks:
 * - `preview(values, { signal })`: a live, checked preview. Called (debounced) after every valid
 *   change; a newer preview aborts the older one's `signal`, and stale results are dropped. It
 *   returns `{ ok: true, summary? }` or `{ ok: false, errors }`; errors name the field they belong to
 *   and may carry the **feasible range** Forge reports, shown inline with a one-click fix.
 * - `commit(values)`: OK (and Apply). It must make the change as **one transaction** through the
 *   command layer (plan §2.1: a tool never edits IR JSON or calls the engine to edit). It returns
 *   `{ ok: true }` or `{ ok: false, errors }` (the panel stays open and shows them).
 * - `cancel()`: Cancel / Esc. Remove preview state; the document must be unchanged.
 *
 * Keys in an open panel: Enter = OK, Esc = Cancel, Tab = next field (plan §2.5).
 *
 * Registration: a workstream adds one line to `TOOL_MODULES` in `tools/catalog.ts`: a function that
 * calls `registry.register(def)` for each of its tools (it returns an unregister function). Tool ids
 * are `<area>.<name>` (`feature.fillet`, `sketch.line`, `inspect.bodyProperties`), unique app-wide.
 *
 * This file is framework-only: no React, no DOM. Tools stay testable without a browser.
 */
import type { AppInvocation } from "../../commands/commands";
import type { CommandResult } from "../../commands/registry";
import type { AppServices } from "../../services";

// ─── Tool groups and modes ─────────────────────────────────────────────────────────────────────

/** The toolbar groups, in toolbar order. */
export type ToolGroupId = "sketch" | "create" | "modify" | "pattern" | "inspect" | "construct";

export interface ToolGroupInfo {
  id: ToolGroupId;
  label: string;
  /** One line for the group's menu header. */
  description: string;
}

export const TOOL_GROUPS: readonly ToolGroupInfo[] = [
  { id: "sketch", label: "Sketch", description: "Draw and constrain 2D profiles" },
  { id: "create", label: "Create", description: "Make solids: extrude, revolve, holes" },
  { id: "modify", label: "Modify", description: "Change solids: fillet, chamfer, shell, combine" },
  { id: "pattern", label: "Pattern", description: "Repeat and mirror features and bodies" },
  { id: "inspect", label: "Inspect", description: "Measure and check the part" },
  { id: "construct", label: "Construct", description: "Datum planes and axes" },
];

/**
 * Where the user is (plan C10): modelling, or inside a sketch. Tools are offered, and their
 * shortcuts are live, only in the modes they list.
 */
export type ShellMode = "model" | "sketch";

// ─── Selection (plan §2.4, contract C2) ────────────────────────────────────────────────────────

/**
 * One selected thing. This mirrors `SelectionItem` of `packages/model-ops/src/selection.ts`
 * (contract C2, owned by SEL); when that lands, this type becomes a re-export of it.
 * Model entities carry their provenance key (`plate/cap:end`), never an engine id.
 */
export type SelectionItem =
  | { kind: "face" | "edge" | "vertex"; part: string; key: string; body?: string; point?: readonly [number, number, number] }
  | { kind: "body"; part: string; body: string }
  | { kind: "feature" | "datum" | "origin"; feature: string; label?: string }
  | { kind: "sketchCurve" | "sketchPoint"; sketch: string; id: string; sub?: "start" | "end" | "center" | "mid" }
  | { kind: "constraint" | "dimension"; sketch: string; index: number }
  | { kind: "region"; sketch: string; curves: readonly string[] }
  | { kind: "param"; name: string };

export type SelectionKind = SelectionItem["kind"];

/** The live selection, as tools see it. */
export interface SelectionPort {
  items(): readonly SelectionItem[];
  /** Called after every selection change; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

// ─── Parameters (for expression fields) ────────────────────────────────────────────────────────

/** A document parameter as the expression fields see it (SPEC-v1 §2.1 units). */
export interface ParamInfo {
  name: string;
  unit: "mm" | "deg" | "ratio" | "count" | "bool";
  /** The evaluated value when known (null: not evaluated yet or failed). */
  value: number | boolean | null;
  /** The part the parameter belongs to; absent for document parameters. */
  part?: string;
}

export interface ParamsPort {
  list(): readonly ParamInfo[];
}

// ─── The tool ──────────────────────────────────────────────────────────────────────────────────

/** Why a tool is disabled right now (shown as its tooltip), or `true` when it is enabled. */
export type Enablement = true | { reason: string };

export interface ToolDefinition {
  /** `<area>.<name>`, e.g. `feature.fillet`. Unique; also the `tool.start` argument. */
  id: string;
  /** Button and palette label, e.g. `Fillet`. */
  label: string;
  group: ToolGroupId;
  /**
   * An icon name from the shell's tool icon set (`ui/shell/tool-icons.tsx`: `extrude`, `fillet`,
   * `hole`, `line`, …). Unknown names fall back to a generic tool glyph.
   */
  icon: string;
  /**
   * Keyboard shortcut in the command layer's syntax: `E`, `Shift+F`, `Mod+Shift+H` (`Mod` = ⌘ on
   * macOS). Single keys are ignored while typing. A shortcut already bound to an app command keeps
   * the command (the registry reports the clash).
   */
  shortcut?: string;
  /** One line: what the tool does (tooltip, palette). */
  description?: string;
  /** Modes the tool is offered in (default: `["model"]`). */
  modes?: readonly ShellMode[];
  /** Position within its group (default 100; ties sort by label). */
  order?: number;
  /**
   * A build flag (plan §3.5): the tool is hidden, and cannot start, while the flag is off. Flags are
   * on in development runs; a packaged build turns on the flags whose specs pass.
   */
  flag?: string;
  /**
   * Selection-first (plan §2.5): the selection kinds the tool acts on, so a contextual toolbar can
   * offer it. Informational for now.
   */
  accepts?: readonly SelectionKind[];
  /** Whether the tool can start now; a `{ reason }` disables it with that tooltip. Default: enabled. */
  enabledWhen?(ctx: ToolContext): Enablement | boolean;
  /**
   * Start the tool. Return a {@link PanelSpec} (or call `ctx.openPanel`) to open its property panel.
   * Throwing is reported to the user as an error toast; nothing is left open.
   */
  activate(ctx: ToolContext): void | PanelSpec | Promise<void | PanelSpec>;
}

/** What a tool gets. Everything goes through the app's services and command layer. */
export interface ToolContext {
  /** The app services (document, UI, host, engines, agent). Read them; change the document only through commands. */
  readonly services: AppServices;
  /** Run an app command (source `ui`), e.g. `{ id: "doc.applyIr", args: { ir, label } }`. */
  run(cmd: AppInvocation): Promise<CommandResult<unknown>>;
  readonly selection: SelectionPort;
  readonly params: ParamsPort;
  readonly mode: ShellMode;
  /** Open (or replace) the property panel. Returns the live session. */
  openPanel(spec: PanelSpec): PanelSessionHandle;
  /** A short notice (info / success / error toast). */
  notify(kind: "info" | "success" | "error", message: string): void;
}

// ─── Property panels ───────────────────────────────────────────────────────────────────────────

/** What a number field measures; decides its unit, its unit check and its display. */
export type Quantity = "length" | "angle" | "count" | "ratio";

/** The value of a number field: what was typed and what it evaluates to. */
export interface NumberValue {
  /** The text as typed: `12`, `12 mm`, `0.5 in`, `wall * 2`. */
  text: string;
  /** The evaluated value in base units (mm, degrees, 1), or null when it cannot be evaluated here. */
  value: number | null;
  /**
   * True when the text is an expression (it names a parameter or uses an operator) rather than a
   * plain number: tools write it to the IR as an expression string (`canonical`) so it stays live.
   */
  expression: boolean;
  /** The canonical IR expression text (SPEC-v1 §2.4), e.g. `wall * 2`, `12.7`; null when invalid. */
  canonical: string | null;
}

export type FieldValue = NumberValue | readonly SelectionItem[] | string | boolean;

interface FieldBase {
  /** The key of the value in the panel's values object. */
  key: string;
  label: string;
  /** One line under the field. */
  hint?: string;
  /** Hide the field while this returns false (e.g. only for `op: "cut"`). */
  visibleWhen?(values: PanelValues): boolean;
}

export interface NumberFieldSpec extends FieldBase {
  kind: "number";
  quantity: Quantity;
  /** Inclusive bounds in base units (mm, degrees). */
  min?: number;
  max?: number;
  /** Strictly greater than `min` (e.g. a distance > 0). */
  minExclusive?: boolean;
  /** Arrow-key step in base units (default: 1 mm, 1°, 1). */
  step?: number;
  /** Allow parameter expressions (default true). */
  expressions?: boolean;
  /** Default text when the panel opens. */
  default?: string;
  /** May be left empty (value null). Default: required. */
  optional?: boolean;
}

export interface SelectionFieldSpec extends FieldBase {
  kind: "selection";
  /** The kinds this input takes; other selected things are ignored (and counted in the hint). */
  accepts: readonly SelectionKind[];
  /** Fewest items (default 1). */
  min?: number;
  /** Most items (default unlimited). */
  max?: number;
  /** Take the current selection when the panel opens (default true). */
  fromSelection?: boolean;
}

export interface ChoiceFieldSpec extends FieldBase {
  kind: "choice";
  options: ReadonlyArray<{ value: string; label: string; hint?: string }>;
  /** `segmented` (default for ≤ 4 options) or `dropdown`. */
  style?: "segmented" | "dropdown";
  default?: string;
}

export interface ToggleFieldSpec extends FieldBase {
  kind: "toggle";
  default?: boolean;
}

export interface TextFieldSpec extends FieldBase {
  kind: "text";
  placeholder?: string;
  /** A regular expression the text must match (with `patternMessage` as the error). */
  pattern?: RegExp;
  patternMessage?: string;
  maxLength?: number;
  default?: string;
  optional?: boolean;
}

export type FieldSpec = NumberFieldSpec | SelectionFieldSpec | ChoiceFieldSpec | ToggleFieldSpec | TextFieldSpec;
export type FieldKind = FieldSpec["kind"];

/** A panel's values, by field key. */
export type PanelValues = Readonly<Record<string, FieldValue>>;

/** The range of a field's value that builds (Forge's feasible range), in base units. */
export interface FeasibleRange {
  min?: number;
  max?: number;
}

/** A problem shown in the panel: under its field, or at the top when `field` is absent. */
export interface FieldError {
  /** The field key it belongs to. */
  field?: string;
  /** Machine-readable code (`FILLET_TOO_LARGE`, `EXPR_UNKNOWN_NAME`, `REQUIRED`, …). */
  code?: string;
  message: string;
  /** Values that would build; the panel offers "Use <nearest>" for number fields. */
  feasible?: FeasibleRange;
}

/** A read-only line in the panel (previews of inspect tools, "3 edges · 2.4 mm max"). */
export interface SummaryRow {
  label: string;
  value: string;
  /** Tone of the value. */
  tone?: "ok" | "warn" | "error";
}

export type PreviewOutcome =
  | { ok: true; summary?: readonly SummaryRow[]; warnings?: readonly string[] }
  | { ok: false; errors: readonly FieldError[]; summary?: readonly SummaryRow[] };

export type CommitOutcome = { ok: true; message?: string } | { ok: false; errors: readonly FieldError[] };

export interface PreviewIO {
  /** Aborted when a newer preview starts or the panel closes. */
  signal: AbortSignal;
}

export interface PanelSpec<V extends PanelValues = PanelValues> {
  title: string;
  /** Tool icon name (defaults to the tool's). */
  icon?: string;
  /** One line under the title. */
  description?: string;
  fields: readonly FieldSpec[];
  /** Initial values by key (override field defaults and the selection). */
  initial?: Partial<Record<string, FieldValue>>;
  /** Label of the commit button (default `OK`). */
  okLabel?: string;
  /** Show "Apply" (commit and keep the panel open for another). Default false. */
  apply?: boolean;
  /** An inspect panel: no commit, one "Close" button; `preview` supplies its summary. */
  readOnly?: boolean;
  /** Extra checks across fields (after each field's own check). */
  validate?(values: V): readonly FieldError[];
  /** Live, checked preview (see the file comment). */
  preview?(values: V, io: PreviewIO): PreviewOutcome | Promise<PreviewOutcome>;
  /** OK / Apply: one transaction through the command layer. */
  commit?(values: V): CommitOutcome | Promise<CommitOutcome>;
  /** Cancel / Esc / the panel was replaced: drop preview state. */
  cancel?(): void;
  /** Delay between the last change and the preview, ms (default 150). */
  previewDelayMs?: number;
}

/**
 * - `collecting`: a required input is missing or a field is invalid;
 * - `previewing`: a preview is running;
 * - `ready`: everything checks (and the preview, if any, passed): OK is enabled;
 * - `invalid`: the preview or the last commit reported errors;
 * - `committing`: OK was pressed and the commit runs;
 * - `closed`: committed or cancelled.
 */
export type PanelState = "collecting" | "previewing" | "ready" | "invalid" | "committing" | "closed";

/** What `openPanel` returns: drive the panel from the tool (tests, selection-driven tools). */
export interface PanelSessionHandle {
  readonly id: number;
  set(key: string, value: FieldValue | string): void;
  commit(): Promise<CommitOutcome>;
  cancel(): void;
}
