/**
 * The design agent as the app sees it: runs (started through the desktop bridge, streamed back as
 * protocol events), the proposal under review (feature diff, per-feature accept/reject, the
 * variant's CadScript and its ghost preview) and the agent settings view.
 *
 * Commands (`agent.*`, `settings.*`) are thin wrappers over this service; the only document change
 * it makes is {@link AgentService.accept}, which applies the accepted variant as ONE undoable
 * transaction (`origin: "agent"`).
 */
import type { IrDocument } from "@aicad/ir-types";
import type {
  AgentBridge,
  AgentEvent,
  AgentModelInfo,
  AgentPhase,
  AgentQuestion,
  AgentRunResult,
  AgentSettingsView,
  AgentStartErrorCode,
  AgentTransportKind,
  ApiProviderId,
  PlanUsageView,
  ProviderId,
  SettingsBridge,
  SettingsUpdate,
} from "../agent-protocol";
import type { CadScriptService } from "../cadscript/service";
import type { DocStore } from "../doc/doc-store";
import type { ForgeEngine, RenderBody } from "../engine/types";
import { Store } from "../store";
import type { SelectionChip, UiStore } from "../ui-store";
import { buildVariant, checkVariant, diffProposal, type DependencyWarning, type FeatureChange } from "./proposal";
import { describeSelection } from "./selection";
import { downgradeToV0 } from "./v0-surface";

export type RunStatus = "running" | "question" | "done" | "failed";

export interface ActivityItem {
  id: number;
  t: number;
  kind: "tool" | "llm" | "note";
  ok?: boolean;
  text: string;
}

export interface AgentRun {
  runId: string;
  prompt: string;
  chips: SelectionChip[];
  status: RunStatus;
  /** Current orchestrator state and the states seen so far (in order). */
  phase: AgentPhase | null;
  phases: AgentPhase[];
  detail: string;
  activity: ActivityItem[];
  spentUsd: number;
  budgetUsd: number;
  /** The spend is (partly) a CLI plan's list-price estimate, not a bill ("≈ $0.42 plan usage"). */
  notional?: boolean;
  /** Plan usage a CLI reported during the run (Claude: 5-hour and 7-day windows). */
  planUsage?: PlanUsageView | null;
  /** ms since the run started (latest event). */
  elapsedMs: number;
  models: Partial<Record<string, AgentModelInfo>>;
  transport: AgentTransportKind | null;
  engine: string;
  draft: { source: string; applyIndex: number; verified: boolean } | null;
  question: { questionId: string; kind: "clarify" | "budget"; questions: AgentQuestion[] } | null;
  result: AgentRunResult | null;
  error: { code: string; message: string } | null;
  lastSeq: number;
}

export interface PreviewState {
  status: "idle" | "evaluating" | "ready" | "error";
  bodies: readonly RenderBody[];
  error: string | null;
}

export interface ProposalReview {
  runId: string;
  prompt: string;
  /** `draft`: the run is still going (live snapshot); `ready`: the result is reviewable. */
  status: "draft" | "preparing" | "ready" | "error";
  baseSource: string;
  proposedSource: string;
  baseIr: IrDocument | null;
  proposedIr: IrDocument | null;
  changes: FeatureChange[];
  /** Change keys currently ticked. */
  accepted: string[];
  /** CadScript of the ticked subset (the right side of the diff). */
  variantSource: string;
  variantIr: IrDocument | null;
  warnings: DependencyWarning[];
  error: string | null;
  preview: PreviewState;
  previewEnabled: boolean;
  resolution: { kind: "accepted" | "partial" | "rejected"; applied: number; total: number } | null;
}

export interface AgentState {
  available: boolean;
  runs: AgentRun[];
  activeRunId: string | null;
  review: ProposalReview | null;
  /** Which view the code panel shows. */
  codeTab: "code" | "proposal";
  settings: AgentSettingsView | null;
  settingsError: string | null;
}

export interface AgentServiceDeps {
  agent: AgentBridge | null;
  settings: SettingsBridge | null;
  cadscript: CadScriptService;
  engine: () => ForgeEngine;
  doc: DocStore;
  ui: UiStore;
}

/** Start refusals that Settings fixes (a key, a CLI login or update, a local model): the message offers "Open Settings". */
const SETTINGS_FIXES: ReadonlySet<AgentStartErrorCode> = new Set<AgentStartErrorCode>(["NO_API_KEY", "CLI_NOT_INSTALLED", "CLI_UNSUPPORTED", "CLI_BLOCKED", "CLI_NOT_LOGGED_IN", "LOCAL_UNAVAILABLE"]);

/** Proposal preview tint (sRGB 0..1). */
export const PREVIEW_TINT: [number, number, number] = [0.33, 0.74, 0.58];
const MAX_ACTIVITY = 120;

export class AgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

function newRun(runId: string, prompt: string, chips: SelectionChip[]): AgentRun {
  return {
    runId,
    prompt,
    chips,
    status: "running",
    phase: null,
    phases: [],
    detail: "",
    activity: [],
    spentUsd: 0,
    budgetUsd: 0,
    notional: false,
    planUsage: null,
    elapsedMs: 0,
    models: {},
    transport: null,
    engine: "",
    draft: null,
    question: null,
    result: null,
    error: null,
    lastSeq: 0,
  };
}

/** Pure: apply one protocol event to a run. */
export function reduceRun(run: AgentRun, e: AgentEvent): AgentRun {
  if (e.seq <= run.lastSeq) return run; // duplicate
  const r: AgentRun = { ...run, lastSeq: e.seq, elapsedMs: Math.max(run.elapsedMs, e.t) };
  const act = (item: Omit<ActivityItem, "id" | "t">): void => {
    r.activity = [...r.activity.slice(-(MAX_ACTIVITY - 1)), { id: e.seq, t: e.t, ...item }];
  };
  switch (e.type) {
    case "started":
      r.models = e.models;
      r.budgetUsd = e.budgetUsd;
      r.transport = e.transport;
      r.engine = e.engine;
      if (e.transport === "live" && Object.values(e.models).some((m) => m?.billing === "subscription")) r.notional = true;
      break;
    case "phase":
      r.phase = e.phase;
      r.detail = e.detail;
      if (r.phases[r.phases.length - 1] !== e.phase) r.phases = [...r.phases, e.phase];
      break;
    case "tool":
      act({ kind: "tool", ok: e.ok, text: `${e.name}: ${e.summary}` });
      break;
    case "llm":
      act({ kind: "llm", text: `${e.role} · ${e.model} · $${e.costUsd.toFixed(4)}` });
      break;
    case "note":
      act({ kind: "note", text: e.text });
      break;
    case "cost":
      r.spentUsd = e.spentUsd;
      r.budgetUsd = e.budgetUsd;
      if (e.notional) r.notional = true;
      break;
    case "plan":
      r.planUsage = e.usage;
      break;
    case "draft":
      r.draft = { source: e.source, applyIndex: e.applyIndex, verified: e.verified };
      break;
    case "question":
      r.question = { questionId: e.questionId, kind: e.kind, questions: e.questions };
      r.status = "question";
      break;
    case "answered":
      if (r.question?.questionId === e.questionId) r.question = null;
      if (r.status === "question") r.status = "running";
      act({ kind: "note", text: `answered: ${e.answers.join("; ")}` });
      break;
    case "result":
      r.result = e.result;
      r.question = null;
      r.status = "done";
      r.spentUsd = e.result.costUsd;
      r.budgetUsd = e.result.budgetUsd;
      r.elapsedMs = Math.max(r.elapsedMs, e.result.latencyMs);
      break;
    case "error":
      r.error = { code: e.code, message: e.message };
      r.question = null;
      r.status = "failed";
      break;
  }
  return r;
}

const EMPTY_PREVIEW: PreviewState = { status: "idle", bodies: [], error: null };

function shortLabel(prompt: string): string {
  const one = prompt.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

export class AgentService extends Store<AgentState> {
  readonly #deps: AgentServiceDeps;
  readonly #pendingEvents = new Map<string, AgentEvent[]>();
  #reviewSeq = 0;
  #previewSeq = 0;
  #unsubscribe: (() => void) | null = null;

  constructor(deps: AgentServiceDeps) {
    super({ available: deps.agent !== null, runs: [], activeRunId: null, review: null, codeTab: "code", settings: null, settingsError: null });
    this.#deps = deps;
    this.#unsubscribe = deps.agent?.onEvent((e) => this.handleEvent(e)) ?? null;
  }

  dispose(): void {
    this.#unsubscribe?.();
  }

  run(runId: string): AgentRun | undefined {
    return this.getState().runs.find((r) => r.runId === runId);
  }

  get activeRun(): AgentRun | undefined {
    const id = this.getState().activeRunId;
    return id ? this.run(id) : undefined;
  }

  /** Whether a proposal is waiting for accept/reject. */
  get reviewPending(): boolean {
    const r = this.getState().review;
    return !!r && r.resolution === null && r.status !== "draft";
  }

  // ─── Runs ──────────────────────────────────────────────────────────────────────────────────

  async start(input: { prompt: string; chips: SelectionChip[] }): Promise<{ runId: string }> {
    const bridge = this.#deps.agent;
    if (!bridge) throw new AgentError("UNAVAILABLE", "The design agent runs in the desktop app (it needs the agent process and your API keys).");
    if (this.activeRun) throw new AgentError("BUSY", "The agent is already working on a request. Stop it first.");
    if (this.reviewPending) throw new AgentError("REVIEW_PENDING", "A proposal is waiting for review: accept or reject it first.");
    const { ui, doc } = this.#deps;
    ui.addChatMessage("user", input.prompt, input.chips);
    const s = await doc.idle();
    const ir = s.compile?.ok ? s.compile.ir : (s.model?.ir ?? null);
    const selection = describeSelection(input.chips, ir);
    // An IR v1 model reaches the designer as CadScript (its print; a model without features: none,
    // the designer starts from scratch). Its proposal comes back as a code edit (accept()).
    let source = s.source;
    if (s.format === "ir-v1") {
      const empty = (ir?.parts ?? []).every((p) => p.features.length === 0);
      const v0 = empty ? null : downgradeToV0(s.source);
      source = empty ? "" : v0 ? await this.#deps.cadscript.print(v0) : ((await this.#deps.cadscript.printV1(s.source)) ?? "");
    }
    const res = await bridge.start({ v: 1, prompt: input.prompt, source, documentName: s.name, selection });
    if (!res.ok) {
      ui.addChatMessage("system", res.message, [], { tone: "error", ...(SETTINGS_FIXES.has(res.code) ? { action: { label: "Open Settings", command: "settings.open" } } : {}) });
      throw new AgentError(res.code, res.message);
    }
    const run = newRun(res.runId, input.prompt, input.chips);
    this.#bases.set(res.runId, source);
    if (s.format === "ir-v1") this.#v1Bases.set(res.runId, s.source);
    this.setState((st) => ({ runs: [...st.runs, run], activeRunId: res.runId }));
    ui.addChatMessage("agent", "", [], { runId: res.runId });
    const early = this.#pendingEvents.get(res.runId);
    this.#pendingEvents.delete(res.runId);
    for (const e of early ?? []) this.handleEvent(e);
    return { runId: res.runId };
  }

  async stop(): Promise<{ stopped: boolean }> {
    const run = this.activeRun;
    if (!run || !this.#deps.agent) return { stopped: false };
    const r = await this.#deps.agent.stop({ v: 1, runId: run.runId });
    return { stopped: r.ok };
  }

  async answer(answers: string[]): Promise<{ answered: boolean }> {
    const run = this.activeRun;
    const q = run?.question;
    if (!run || !q || !this.#deps.agent) throw new AgentError("NO_QUESTION", "The agent is not waiting for an answer.");
    const full = q.questions.map((qq, i) => (answers[i]?.trim() ? answers[i]!.trim() : qq.default));
    const r = await this.#deps.agent.answer({ v: 1, runId: run.runId, questionId: q.questionId, answers: full });
    return { answered: r.ok };
  }

  handleEvent(e: AgentEvent): void {
    const run = this.run(e.runId);
    if (!run) {
      // Events can overtake the start() reply: keep them until the run is registered.
      const list = this.#pendingEvents.get(e.runId) ?? [];
      if (list.length < 1000) list.push(e);
      this.#pendingEvents.set(e.runId, list);
      return;
    }
    const next = reduceRun(run, e);
    if (next === run) return;
    const terminal = e.type === "result" || e.type === "error";
    this.setState((st) => ({
      runs: st.runs.map((r) => (r.runId === e.runId ? next : r)),
      activeRunId: terminal && st.activeRunId === e.runId ? null : st.activeRunId,
    }));
    if (e.type === "draft") this.#onDraft(next, e.source);
    else if (e.type === "result") this.#onResult(next, e.result);
    else if (e.type === "error") this.#dropDraft(e.runId);
  }

  #onDraft(run: AgentRun, source: string): void {
    const cur = this.getState().review;
    if (cur && cur.runId !== run.runId && cur.resolution === null && cur.status !== "draft") return; // never hide a pending review
    const base = run.result?.baseSource ?? this.#baseOf(run);
    const first = !cur || cur.runId !== run.runId;
    this.setState({
      review: {
        runId: run.runId,
        prompt: run.prompt,
        status: "draft",
        baseSource: base,
        proposedSource: source,
        baseIr: null,
        proposedIr: null,
        changes: [],
        accepted: [],
        variantSource: source,
        variantIr: null,
        warnings: [],
        error: null,
        preview: EMPTY_PREVIEW,
        previewEnabled: false,
        resolution: null,
      },
      ...(first ? { codeTab: "proposal" as const } : {}),
    });
  }

  /** The document source when the run started (kept per run for live drafts). */
  readonly #bases = new Map<string, string>();
  /** IR v1 models: the model (canonical text) each run started from. */
  readonly #v1Bases = new Map<string, string>();
  #baseOf(run: AgentRun): string {
    let b = this.#bases.get(run.runId);
    if (b === undefined) {
      b = this.#deps.doc.getState().source;
      this.#bases.set(run.runId, b);
    }
    return b;
  }

  #dropDraft(runId: string): void {
    const cur = this.getState().review;
    if (cur?.runId === runId && cur.status === "draft") this.setState({ review: null, codeTab: "code" });
  }

  #onResult(run: AgentRun, result: AgentRunResult): void {
    const { ui } = this.#deps;
    if (result.status === "answered" && result.answer) ui.addChatMessage("assistant", result.answer);
    if (!result.changed) {
      this.#dropDraft(run.runId);
      return;
    }
    void this.#prepareReview(run, result);
  }

  async #prepareReview(run: AgentRun, result: AgentRunResult): Promise<void> {
    const seq = ++this.#reviewSeq;
    const { cadscript, doc } = this.#deps;
    const review: ProposalReview = {
      runId: run.runId,
      prompt: run.prompt,
      status: "preparing",
      baseSource: result.baseSource,
      proposedSource: result.proposedSource,
      baseIr: null,
      proposedIr: null,
      changes: [],
      accepted: [],
      variantSource: result.proposedSource,
      variantIr: null,
      warnings: [],
      error: null,
      preview: EMPTY_PREVIEW,
      previewEnabled: false,
      resolution: null,
    };
    this.setState({ review, codeTab: "proposal" });
    try {
      const d = doc.getState();
      let baseIr: IrDocument | null;
      let proposedIr: IrDocument | null;
      if (d.format === "ir-v1") {
        // The model and the proposal as IR v1 (a v0 proposal compiles to its migration).
        const v1Base = this.#v1Bases.get(run.runId) ?? d.source;
        const proposed = result.proposedSource.trim() ? await this.#proposalAsV1(result.proposedSource) : null;
        if (seq !== this.#reviewSeq) return;
        baseIr = JSON.parse(v1Base) as IrDocument;
        proposedIr = proposed ? (JSON.parse(proposed) as IrDocument) : null;
      } else {
        const idBase = d.source === result.baseSource && d.compile?.ok ? d.compile.ir : null;
        const base = await cadscript.compile(result.baseSource, idBase);
        const proposed = await cadscript.compile(result.proposedSource, base.ok ? base.ir : null);
        if (seq !== this.#reviewSeq) return;
        baseIr = base.ok ? base.ir : null;
        proposedIr = proposed.ok ? proposed.ir : null;
      }
      const changes = baseIr && proposedIr ? diffProposal(baseIr, proposedIr) : [];
      this.setState({
        review: {
          ...review,
          status: "ready",
          baseIr,
          proposedIr,
          changes,
          accepted: changes.map((c) => c.key),
          variantIr: proposedIr,
          previewEnabled: proposedIr !== null,
          error: proposedIr ? null : "The proposed code does not compile; only accepting it as a whole is possible.",
        },
      });
      if (proposedIr) void this.#evaluatePreview(proposedIr);
    } catch (e) {
      if (seq !== this.#reviewSeq) return;
      this.setState({ review: { ...review, status: "error", error: e instanceof Error ? e.message : String(e) } });
    }
  }

  /**
   * A proposal's CadScript as canonical IR v1 text: CadScript v0 compiles to IR v0 (feature ids = the
   * const names, as the model's) and is migrated by the engine; CadScript v1 compiles as v1. Null when
   * it compiles as neither.
   */
  async #proposalAsV1(source: string): Promise<string | null> {
    const { cadscript } = this.#deps;
    const v0 = await cadscript.compile(source);
    const commands = this.#deps.engine().commands;
    if (v0.ok && v0.ir && commands) {
      try {
        return (await commands.canonicalize(JSON.stringify(v0.ir))).document;
      } catch {
        // falls through to the v1 compiler
      }
    }
    const v1 = await cadscript.compileV1(source);
    return v1.ok && v1.irJson ? v1.irJson : null;
  }

  async #evaluatePreview(ir: IrDocument): Promise<void> {
    const seq = ++this.#previewSeq;
    this.#patchReview((r) => ({ preview: { ...r.preview, status: "evaluating", error: null } }));
    try {
      const res = await this.#deps.engine().evaluate(JSON.stringify(ir));
      if (seq !== this.#previewSeq) return;
      const bodies = res.bodies.map((b) => ({ ...b, color: PREVIEW_TINT }));
      this.#patchReview(() => ({ preview: { status: "ready", bodies, error: null } }));
    } catch (e) {
      if (seq !== this.#previewSeq) return;
      this.#patchReview(() => ({ preview: { status: "error", bodies: [], error: e instanceof Error ? e.message : String(e) } }));
    }
  }

  #patchReview(patch: (r: ProposalReview) => Partial<ProposalReview>): void {
    const r = this.getState().review;
    if (r) this.setState({ review: { ...r, ...patch(r) } });
  }

  // ─── Review ────────────────────────────────────────────────────────────────────────────────

  #readyReview(): ProposalReview {
    const r = this.getState().review;
    if (!r || r.status === "draft" || r.status === "preparing") throw new AgentError("NO_PROPOSAL", "There is no proposal to review.");
    if (r.resolution) throw new AgentError("RESOLVED", `The proposal was already ${r.resolution.kind === "rejected" ? "rejected" : "accepted"}.`);
    return r;
  }

  /** Resolve feature names or change keys to change keys (unknown names throw). */
  resolveKeys(review: ProposalReview, refs: readonly string[]): string[] {
    return refs.map((ref) => {
      if (review.changes.some((c) => c.key === ref)) return ref;
      const byName = review.changes.filter((c) => c.feature === ref);
      if (byName.length === 1) return byName[0]!.key;
      throw new AgentError("UNKNOWN_CHANGE", byName.length > 1 ? `\`${ref}\` is ambiguous; use the part-qualified key (part/feature)` : `the proposal does not change \`${ref}\``);
    });
  }

  /** Variant (IR, source, warnings) for a set of change keys, onto the base. */
  async #variant(review: ProposalReview, keys: ReadonlySet<string>): Promise<{ ir: IrDocument | null; source: string; warnings: DependencyWarning[] }> {
    const all = review.changes.every((c) => keys.has(c.key));
    if (all || !review.baseIr || !review.proposedIr) return { ir: review.proposedIr, source: review.proposedSource, warnings: [] };
    const v = buildVariant(review.baseIr, review.proposedIr, review.baseIr, keys, review.changes);
    const warnings = checkVariant(v.ir, review.changes, keys);
    const source = await this.#deps.cadscript.applyIrEdit(review.baseSource, review.baseIr, v.ir);
    return { ir: v.ir, source, warnings };
  }

  /** Tick/untick changes: recomputes the variant's CadScript, warnings and preview. */
  async setAccepted(refs: readonly string[]): Promise<{ accepted: string[]; warnings: DependencyWarning[] }> {
    const review = this.#readyReview();
    const keys = this.resolveKeys(review, refs);
    const set = new Set(keys);
    const ordered = review.changes.map((c) => c.key).filter((k) => set.has(k));
    this.#patchReview(() => ({ accepted: ordered }));
    try {
      const v = await this.#variant(review, set);
      const cur = this.getState().review;
      if (cur?.runId !== review.runId || cur.accepted.join("\u0000") !== ordered.join("\u0000")) return { accepted: ordered, warnings: v.warnings };
      this.#patchReview(() => ({ variantSource: v.source, variantIr: v.ir, warnings: v.warnings, error: null }));
      if (v.ir) void this.#evaluatePreview(v.ir);
      return { accepted: ordered, warnings: v.warnings };
    } catch (e) {
      this.#patchReview(() => ({ error: e instanceof Error ? e.message : String(e) }));
      throw e;
    }
  }

  /**
   * Apply the accepted changes (default: all) to the document as one undoable transaction.
   * Error-level dependency warnings refuse unless `force`.
   */
  async accept(options: { features?: readonly string[]; force?: boolean } = {}): Promise<{ applied: number; total: number; changed: boolean; warnings: DependencyWarning[] }> {
    const review = this.#readyReview();
    const keys = options.features ? this.resolveKeys(review, options.features) : review.changes.map((c) => c.key);
    if (options.features && keys.length === 0) throw new AgentError("NOTHING_SELECTED", "Select at least one change, or reject the proposal.");
    const set = new Set(keys);
    const all = review.changes.every((c) => set.has(c.key));
    const { doc, cadscript, ui } = this.#deps;
    if (doc.isV1) return this.#acceptV1(review, set, all, options);
    let warnings: DependencyWarning[] = [];
    if (!all && review.baseIr && review.proposedIr) {
      const v = buildVariant(review.baseIr, review.proposedIr, review.baseIr, set, review.changes);
      warnings = checkVariant(v.ir, review.changes, set);
      const errors = warnings.filter((w) => w.severity === "error");
      if (errors.length > 0 && !options.force) throw new AgentError("DEPENDENCY", `This selection breaks the model: ${errors.map((w) => w.message).join(" ")}`);
    }
    const s = await doc.idle();
    let source: string;
    if (s.source === review.baseSource) {
      source = all ? review.proposedSource : (await this.#variant(review, set)).source;
    } else {
      // The document was edited during the run: rebase the accepted changes onto it.
      if (!review.baseIr || !review.proposedIr) throw new AgentError("CONFLICT", "The document changed since the run started, and the proposal cannot be merged feature by feature. Reject it and run again.");
      const target = s.compile?.ok ? s.compile.ir : null;
      if (!target) throw new AgentError("CONFLICT", "The document changed since the run started and has code errors; fix them (or undo your edits) before accepting.");
      const v = buildVariant(review.baseIr, review.proposedIr, target, set, review.changes);
      if (v.conflicts.length > 0) throw new AgentError("CONFLICT", `Cannot merge the proposal into your edits: ${v.conflicts.join("; ")}.`);
      source = await cadscript.applyIrEdit(s.source, target, v.ir);
    }
    if (doc.getState().source !== s.source) throw new AgentError("CONFLICT", "The document changed while the proposal was being applied; try again.");
    const check = await cadscript.compile(source, s.compile?.ok ? s.compile.ir : null);
    if (!check.ok) {
      const first = check.diagnostics.find((d) => d.severity === "error");
      if (!options.force) throw new AgentError("INVALID", `The accepted code does not compile${first ? `: ${first.message}` : ""}.`);
    }
    const partial = !all;
    const changed = doc.setSource(source, { label: `Agent: ${shortLabel(review.prompt)}`, origin: "agent" });
    const applied = all ? review.changes.length : keys.length;
    this.#patchReview(() => ({ resolution: { kind: partial ? "partial" : "accepted", applied, total: review.changes.length }, previewEnabled: false }));
    this.setState({ codeTab: "code" });
    ui.addChatMessage(
      "system",
      partial ? `Applied ${applied} of ${review.changes.length} changes as one undo step.` : `Applied the proposal as one undo step${review.changes.length ? ` (${review.changes.length} change${review.changes.length === 1 ? "" : "s"})` : ""}.`,
    );
    return { applied, total: review.changes.length, changed, warnings };
  }

  /**
   * Accept on an IR v1 model: the accepted changes (the whole proposal, or the variant of the ticked
   * features) replace the model as ONE undoable code edit (`replaceDocument`, origin `agent`). Your
   * accept is the approval ADR 0015 asks for: of the features and parameters the proposal changes.
   */
  async #acceptV1(
    review: ProposalReview,
    set: ReadonlySet<string>,
    all: boolean,
    options: { features?: readonly string[]; force?: boolean },
  ): Promise<{ applied: number; total: number; changed: boolean; warnings: DependencyWarning[] }> {
    const { doc, ui } = this.#deps;
    const s = await doc.idle();
    const base = this.#v1Bases.get(review.runId);
    if (base !== undefined && s.source !== base) {
      throw new AgentError("CONFLICT", "The model changed since the run started; reject the proposal and run again (or undo your edits).");
    }
    if (!review.proposedIr) throw new AgentError("INVALID", review.error ?? "The proposed code does not compile to a model.");
    let target: IrDocument = review.proposedIr;
    let warnings: DependencyWarning[] = [];
    if (!all && review.baseIr) {
      const v = buildVariant(review.baseIr, review.proposedIr, review.baseIr, set, review.changes);
      warnings = checkVariant(v.ir, review.changes, set);
      const errors = warnings.filter((w) => w.severity === "error");
      if (errors.length > 0 && !options.force) throw new AgentError("DEPENDENCY", `This selection breaks the model: ${errors.map((w) => w.message).join(" ")}`);
      target = v.ir;
    }
    const current = JSON.parse(s.source) as IrDocument;
    const approvals = {
      features: current.parts.flatMap((p) => p.features.map((f) => f.id)),
      params: [...((current as { params?: Array<{ name: string }> }).params ?? []), ...current.parts.flatMap((p) => (p as { params?: Array<{ name: string }> }).params ?? [])].map((p) => p.name),
    };
    const ir = this.#deps.doc;
    let changed: boolean;
    try {
      changed = await ir.applyDocument(JSON.stringify(target), { label: `Agent: ${shortLabel(review.prompt)}`, origin: "agent", approvals });
    } catch (e) {
      throw new AgentError("INVALID", e instanceof Error ? e.message : String(e));
    }
    const applied = all ? review.changes.length : set.size;
    this.#patchReview(() => ({ resolution: { kind: all ? "accepted" : "partial", applied, total: review.changes.length }, previewEnabled: false }));
    this.setState({ codeTab: "code" });
    ui.addChatMessage("system", all ? `Applied the proposal as one undo step${review.changes.length ? ` (${review.changes.length} change${review.changes.length === 1 ? "" : "s"})` : ""}.` : `Applied ${applied} of ${review.changes.length} changes as one undo step.`);
    return { applied, total: review.changes.length, changed, warnings };
  }

  reject(): { rejected: true } {
    const review = this.#readyReview();
    this.#patchReview(() => ({ resolution: { kind: "rejected", applied: 0, total: review.changes.length }, previewEnabled: false }));
    this.setState({ codeTab: "code" });
    this.#deps.ui.addChatMessage("system", "Proposal rejected; the document is unchanged.");
    return { rejected: true };
  }

  setPreview(enabled: boolean): boolean {
    const r = this.getState().review;
    if (!r || r.status !== "ready" || r.resolution) return false;
    this.#patchReview(() => ({ previewEnabled: enabled }));
    return enabled;
  }

  setCodeTab(tab: "code" | "proposal"): void {
    if (tab === "proposal" && !this.getState().review) return;
    this.setState({ codeTab: tab });
  }

  // ─── Settings ──────────────────────────────────────────────────────────────────────────────

  #settingsBridge(): SettingsBridge {
    const s = this.#deps.settings;
    if (!s) throw new AgentError("UNAVAILABLE", "Agent settings are only available in the desktop app.");
    return s;
  }

  async #settingsCall(f: (b: SettingsBridge) => Promise<AgentSettingsView>): Promise<AgentSettingsView> {
    try {
      const view = await f(this.#settingsBridge());
      this.setState({ settings: view, settingsError: null });
      return view;
    } catch (e) {
      // Electron prefixes remote errors ("Error invoking remote method '…': KeyStoreError: …").
      const message = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, "");
      this.setState({ settingsError: message });
      throw new AgentError("SETTINGS", message);
    }
  }

  refreshSettings(): Promise<AgentSettingsView> {
    return this.#settingsCall((b) => b.get());
  }

  setApiKey(provider: ApiProviderId, key: string): Promise<AgentSettingsView> {
    return this.#settingsCall((b) => b.setApiKey({ v: 1, provider, key }));
  }

  clearApiKey(provider: ApiProviderId): Promise<AgentSettingsView> {
    return this.#settingsCall((b) => b.clearApiKey({ v: 1, provider }));
  }

  /** Settings → Re-check: detect CLI agents and local models again now (no model call is made). */
  probeProviders(providers?: ProviderId[]): Promise<AgentSettingsView> {
    return this.#settingsCall((b) => (b.probeProviders ? b.probeProviders({ v: 1, ...(providers ? { providers } : {}) }) : b.get()));
  }

  updateSettings(update: Omit<SettingsUpdate, "v">): Promise<AgentSettingsView> {
    return this.#settingsCall((b) => b.update({ v: 1, ...update }));
  }
}
