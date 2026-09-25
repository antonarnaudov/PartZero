/**
 * The tool and property-panel contract (docs FULL-MODELING-PLAN §2.5, contract C3, **as amended** in
 * `C3-AMENDMENT.md` next to this file: the plan's `ToolSpec` and this file differ in shape, and the
 * amendment maps one onto the other for the owner and INT to approve). Other workstreams (feature
 * tools, the sketcher, inspect tools) and the integrator build against this file; the shell
 * (`ui/shell/**`) renders it.
 *
 * A **tool** is a toolbar entry: `{ id, label, group, icon, shortcut, enabledWhen, activate }`.
 * `activate(ctx)` runs when the user clicks the button, presses the shortcut, picks the tool in the
 * command palette or an agent/test runs `tool.start { id, args }`. It usually opens a **property
 * panel**: either by returning a {@link PanelSpec} or by calling `ctx.openPanel(spec)`. A tool without
 * a panel (a one-shot action) does its work and returns nothing. A tool that makes a feature also
 * re-edits it: `features` names the feature types and `fromFeature` opens the panel prefilled from one
 * (`feature.edit { feature }`, the timeline's double-click).
 *
 * A **property panel** is described, not drawn: a list of typed {@link FieldSpec}s (numbers with
 * units and expressions, selection inputs with counts, dropdowns, toggles, text), plus callbacks:
 * - `preview(values, { signal, revision })`: a live, checked preview. Called (debounced) after every
 *   valid change **and after every document change** (undo, the code editor, an accepted agent
 *   proposal). A newer preview aborts the older one's `signal`; stale results are dropped, bodies
 *   included. It returns `{ ok: true, summary?, bodies? }` or `{ ok: false, errors }`; `bodies` are
 *   drawn in the viewport (tinted) while they are current. Errors name the field they belong to and
 *   may carry the **feasible range** Forge reports, shown inline with a one-click fix.
 * - `toOps(values)`: OK (and Apply). **The** way a tool changes the document (plan §2.1, §2.5): it
 *   returns domain ops ({@link ToolOp}); the framework applies them as **one transaction** against the
 *   document as it is at OK time, so an edit made meanwhile by the user, undo or the agent is kept, not
 *   overwritten. `commit(values)` is the escape hatch for a change the op catalogue can't express yet;
 *   it must still be one transaction through the command layer, built from the document as it is when
 *   `commit` runs (never from a copy captured in `activate`).
 * - OK never commits values the live check has not passed: while a preview runs, OK waits for it and
 *   commits only if it passes, against the current document revision.
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
import type { IrOp } from "@aicad/model-ops";
import type { AppInvocation } from "../../commands/commands";
import type { CommandResult, CommandSource } from "../../commands/registry";
import type { RenderBody } from "../../engine/types";
import type { AppServices } from "../../services";
import type { HandleSpec } from "../../viewport/manipulators/types";

// ─── Tool groups and modes ─────────────────────────────────────────────────────────────────────

/** The toolbar groups (plan §2.5: sketch | create | modify | construct | pattern | inspect | print). */
export type ToolGroupId = "sketch" | "create" | "modify" | "pattern" | "inspect" | "construct" | "print";

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
  { id: "print", label: "Print", description: "Get the part ready for the printer" },
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

// ─── The document (revisions and features) ─────────────────────────────────────────────────────

/** A feature of the document, as `fromFeature` gets it. */
export interface FeatureInfo {
  /** The feature id (`fillet1`). */
  id: string;
  /** The CadScript `const` name, when the IR has one. */
  name?: string;
  /** The IR feature type (`extrude`, `fillet`, …): picks the tool that re-edits it. */
  type: string;
  /** The id of the part it belongs to. */
  part: string;
  /** The feature's IR JSON (read it; change it only through `setField` ops). */
  json: Readonly<Record<string, unknown>>;
}

/**
 * The document as tools see it. `revision()` changes with **every** change of the document or of its
 * evaluation, from any origin: the user, undo/redo, the code editor, an accepted agent proposal, a
 * re-evaluation. An open panel re-checks itself when it changes.
 */
export interface DocumentPort {
  revision(): number;
  /** Called after the revision changed; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** A feature by id (or CadScript name) in the current document; null when there is none. */
  feature(idOrName: string): FeatureInfo | null;
}

// ─── Domain ops (plan §2.2, contract C1) ───────────────────────────────────────────────────────

/** Set one field of a feature: `path` is a JSON pointer relative to the feature (`/distance`). */
export interface SetFieldOp {
  op: "setField";
  feature: string;
  path: string;
  /** The new JSON value, or `{ expr }` for a parameter expression (IR v1 only). */
  value: unknown;
}

export interface SetSuppressedOp {
  op: "setSuppressed";
  feature: string;
  suppressed: boolean;
}

/**
 * Add a feature to a part after `after` (a feature id or name; null: first). The id is `<type><n>`
 * (C9: `fillet1`) unless the feature JSON has one; the name defaults to the id.
 */
export interface AddFeatureOp {
  op: "addFeature";
  part: string;
  after: string | null;
  feature: Readonly<Record<string, unknown>>;
}

/**
 * A domain op a tool commits (plan §2.2): any op of C1's catalogue (`@aicad/model-ops` `IrOp`).
 * On an IR v1 document the shell's port applies them through the command layer (`ir.apply`, one
 * transaction); on a CadScript (IR v0) document only `setField`, `setSuppressed` and `addFeature`
 * apply, and any other op is refused with `COMMAND_NOT_IMPLEMENTED`, never ignored.
 */
export type ToolOp = IrOp;

/** The three ops a CadScript (IR v0) document takes. */
export type V0ToolOp = SetFieldOp | SetSuppressedOp | AddFeatureOp;

/** Applies a tool's ops (the command layer's transaction; C6 `IrDocStore.transaction` once bound). */
export interface OpsPort {
  /**
   * Apply `ops` as **one** transaction (one undo step, labelled `label`) to the document **as it is
   * now**. All or nothing: a refused op refuses the transaction (errors with `COMMAND_*` codes) and
   * leaves the document unchanged.
   */
  apply(ops: readonly ToolOp[], meta: { label: string; source: CommandSource }): Promise<CommitOutcome>;
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
   * Prefill from `ctx.selection` (selection fields do it by themselves). `tool.start { id, args }`
   * values override the panel's initial values by field key. Throwing is reported to the user as an
   * error toast; nothing is left open.
   */
  activate(ctx: ToolContext): void | PanelSpec | Promise<void | PanelSpec>;
  /** The IR feature types this tool makes and re-edits with {@link fromFeature} (`["fillet"]`). */
  features?: readonly string[];
  /**
   * Re-edit an existing feature (`feature.edit { feature }`, the timeline's double-click): return the
   * panel prefilled from it, whose `toOps` emits `setField` ops for that feature.
   */
  fromFeature?(feature: FeatureInfo, ctx: ToolContext): PanelSpec | Promise<PanelSpec>;
}

/** What a tool gets. Everything goes through the app's services and command layer. */
export interface ToolContext {
  /** The app services (document, UI, host, engines, agent). Read them; change the document only through ops or commands. */
  readonly services: AppServices;
  /**
   * Run an app command (source `ui`). For document changes prefer a panel's `toOps`; a command that
   * takes a whole document (`doc.applyIr`) overwrites edits made since you read it.
   */
  run(cmd: AppInvocation): Promise<CommandResult<unknown>>;
  readonly selection: SelectionPort;
  readonly params: ParamsPort;
  /** The document's revision and features. Read the document when you preview or commit, not in `activate`. */
  readonly document: DocumentPort;
  readonly mode: ShellMode;
  /** `tool.start { id, args }`'s args (empty from the toolbar, the keyboard and the palette). */
  readonly args: Readonly<Record<string, unknown>>;
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
  | {
      ok: true;
      summary?: readonly SummaryRow[];
      warnings?: readonly string[];
      /**
       * Preview geometry, drawn in the viewport (tinted) instead of the document, e.g. the bodies of
       * `engines.active.evaluate(candidate)`. Shown only while this preview is current: a newer
       * preview, a document change, Cancel or OK replace or remove it. While the next preview runs
       * the viewport marks it stale.
       */
      bodies?: readonly RenderBody[];
      /** Manipulator handles for this preview (plan §2.6); see {@link PanelHandle}. */
      handles?: readonly PanelHandle[];
    }
  | { ok: false; errors: readonly FieldError[]; summary?: readonly SummaryRow[]; handles?: readonly PanelHandle[] };

export type CommitOutcome = { ok: true; message?: string } | { ok: false; errors: readonly FieldError[] };

// ─── Manipulators (plan §2.6) ─────────────────────────────────────────────────────────────────

/**
 * A handle in the viewport bound to one number field of the panel: dragging it sets the field
 * (`toText(value)`, default the number), which re-runs the preview; OK commits as usual. A panel
 * returns its handles with each preview ({@link PreviewOutcome}), placed from the previewed
 * geometry; a failing preview keeps the last ones, so the user can drag back into range.
 */
export interface PanelHandle extends HandleSpec {
  /** The number field the handle drives. */
  field: string;
  /** The handle's value as the field's text (e.g. a symmetric extrude's arrow shows half the distance). */
  toText?(value: number): string;
}

/** Where the shell shows the open panel's handles (the viewport's manipulator host once bound). */
export interface HandlesPort {
  /** Show or update the handles; drags report to `onChange`. */
  show(handles: readonly PanelHandle[], onChange: (id: string, value: number, phase: "start" | "drag" | "end" | "cancel") => void): void;
  /** Remove them (the panel closed). */
  clear(): void;
}

export interface PreviewIO {
  /** Aborted when a newer preview starts, the document changes or the panel closes. */
  signal: AbortSignal;
  /** The document revision ({@link DocumentPort.revision}) this preview checks against. */
  revision: number;
}

export interface PanelSpec<V extends PanelValues = PanelValues> {
  title: string;
  /** Tool icon name (defaults to the tool's). */
  icon?: string;
  /** One line under the title. */
  description?: string;
  fields: readonly FieldSpec[];
  /**
   * Initial values by key (override field defaults and the selection). Number fields also take a
   * plain number. Checked when the panel opens: an unknown key or a value its field can't take throws.
   */
  initial?: Partial<Record<string, FieldValue | number>>;
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
  /**
   * OK / Apply: the domain ops of the change. The framework applies them as one transaction to the
   * document as it is at OK time (an empty list changes nothing). A panel has `toOps` or `commit`,
   * not both.
   */
  toOps?(values: V): readonly ToolOp[] | Promise<readonly ToolOp[]>;
  /** The undo label of the `toOps` transaction (default: the panel title). */
  label?(values: V): string;
  /**
   * OK / Apply for a change `toOps` can't express yet: one transaction through the command layer,
   * built from the document as it is now (see the file comment).
   */
  commit?(values: V): CommitOutcome | Promise<CommitOutcome>;
  /** Cancel / Esc / the panel was replaced: drop preview state. */
  cancel?(): void;
  /** Delay between the last change and the preview, ms (default 150). */
  previewDelayMs?: number;
}

/**
 * - `collecting`: a required input is missing or a field is invalid;
 * - `previewing`: a preview is scheduled or running (OK waits for it, then commits only if it passed);
 * - `ready`: everything checks (and the preview, if any, passed at the current document revision);
 * - `invalid`: the preview or the last commit reported errors;
 * - `committing`: OK was pressed and the commit runs;
 * - `closed`: committed or cancelled.
 */
export type PanelState = "collecting" | "previewing" | "ready" | "invalid" | "committing" | "closed";

/** What `openPanel` returns: drive the panel from the tool (tests, selection-driven tools). */
export interface PanelSessionHandle {
  readonly id: number;
  set(key: string, value: FieldValue | string): void;
  /** OK. `source`: who pressed it (default `ui`), for the transaction's origin. */
  commit(source?: CommandSource): Promise<CommitOutcome>;
  cancel(): void;
}
