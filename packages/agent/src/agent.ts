/**
 * The agent orchestrator: a deterministic state machine over the LLM gateway (ARCHITECTURE §6
 * "Loop"; not the Claude Agent SDK). The same code runs in the app, the CLI and evals.
 *
 *   TRIAGE ─┬─ ask ──────────► ASK (read-only tools) ───────────────────────────────► DONE
 *           ├─ quick_edit ───────────────────────► BUILD ⇄ REPAIR ×2 → REPLAN ×1 → PROPOSE
 *           └─ design ─► CLARIFY? ─► SPEC (fresh) ─► BUILD ⇄ REPAIR ×2 → REPLAN ×1 → PROPOSE
 *
 * - CLARIFY: ≤ 1 round of ≤ 3 questions with defaults, asked by the designer in its own short
 *   conversation (same cached prefix); eval mode answers from the task's recorded defaults.
 * - SPEC: the spec writer, in a fresh conversation that never sees builder messages; its tests are
 *   frozen before BUILD starts.
 * - BUILD: every apply runs the ladder L0 compile → L1 kernel → L2 expectations → L3 spec tests.
 *   A failing step gets REPAIR ×2, then ROLLBACK to the last verified checkpoint + REPLAN ×1.
 * - Stop rules: the same error twice in a row; repairs + replan exhausted; 80 % of the budget;
 *   the turn limit; a refusal (never retried); no progress.
 * - PROPOSE: accepted when the model verifies; failing spec tests are sent back (REFINE ×2) unless
 *   the designer names them as known issues. L5 (visual judge) is a hook, off until rendering exists.
 *
 * Context: tools (sorted) → system (role prompt + generated CadScript reference + conventions,
 * cache breakpoint) → task header → append-only turns. Tool results are short deltas.
 */
import { Conversation, type LLMGateway, type Message, type SystemBlock, type TextBlock, type ToolResultBlock, type ToolUseBlock } from "@aicad/llm-gateway";
import {
  DesignSession,
  designerRegistry,
  evalModeAnswers,
  formatTestResult,
  irSummary,
  summarizeTests,
  verificationLine,
  type Checkpoint,
  type DesignSpec,
  type DesignToolContext,
  type Proposal,
  type SpecTestResult,
  type ToolOutput,
  type ToolRegistry,
  type UserQuestion,
} from "@aicad/agent-tools";
import { describeTest, type Engine, type HiddenTest } from "@aicad/evals";
import type { EvalReport, IrDocument } from "@aicad/ir-types";
import { resolveModels, type AgentModels, type ModelOverrides } from "./models.js";
import { loadPrompt, type PromptInfo } from "./prompts.js";
import { cadscriptReference } from "./reference.js";
import { AgentStop, callModel, DEFAULT_LIMITS, responseText, type AgentLimits, type RunContext } from "./run-context.js";
import { clarificationsBlock, processLine, runSpecWriter, type Clarification } from "./spec-writer.js";
import { TraceRecorder, type AgentState, type AgentStopReason, type TraceEvent, type TraceSummary } from "./trace.js";
import { fallbackTriage, runTriage, type TriageKind, type TriageResult } from "./triage.js";

export interface AgentRequest {
  /** The user's message. */
  prompt: string;
  /** CadScript of the open model (edit tasks). */
  context?: string | undefined;
  /** Document name (engine temp files, traces). */
  name?: string | undefined;
  /** Manufacturing process: fdm | cnc | laser | any. */
  process?: string | undefined;
}

/** L5 visual judge verdict (hook; rendering does not exist yet). */
export interface JudgeVerdict {
  pass: boolean;
  findings: string[];
}

export interface AgentHooks {
  onEvent?(e: TraceEvent): void;
  /**
   * L5 VISUAL JUDGE — OUT OF SCOPE until forge-render exists. When set, it is called at PROPOSE
   * after L3 passes, with the model to judge; a failing verdict sends the proposal back (REFINE).
   * The judge must be a different model family than the designer (ADR 0009).
   */
  visualJudge?(input: { source: string; ir: IrDocument | null; report: EvalReport | null; spec: DesignSpec | undefined }): Promise<JudgeVerdict>;
  /** Interactive mode: at the budget checkpoint (80 %), return true to continue up to the hard cap. */
  onBudgetCheckpoint?(info: { spentUsd: number; capUsd: number }): Promise<boolean> | boolean;
}

export interface AgentOptions {
  gateway: LLMGateway;
  engine: Engine;
  /** Per-role model overrides (profile ids); defaults come from the gateway router. */
  models?: ModelOverrides;
  /** Hard USD cap for the whole task (default 1.5, the T1 cap). */
  budgetUsd?: number;
  /** `eval`: ask_user is answered from `recordedDefaults`; `interactive`: from `askUser`. */
  mode?: "eval" | "interactive";
  askUser?: (questions: readonly UserQuestion[]) => Promise<string[]> | string[];
  /** Eval mode: the task's recorded defaults (MakerBench `clarify.assumptions`). */
  recordedDefaults?: string | undefined;
  limits?: Partial<AgentLimits>;
  promptVersion?: string;
  promptsDir?: string;
  /** Project conventions appended to the designer's system prompt. */
  conventions?: string;
  /** Skip triage and force the route. */
  kind?: TriageKind;
  hooks?: AgentHooks;
  /** Task id for the gateway ledger. */
  taskId?: string;
  now?: () => number;
}

export type AgentStatus = "proposed" | "answered" | "stopped" | "failed";

export interface AgentResult {
  status: AgentStatus;
  stopReason: AgentStopReason;
  message: string;
  /** The final CadScript (the proposal, or the best verified state when stopped). */
  cadscript: string;
  /** The final state passes L0–L2. */
  verified: boolean;
  /** ASK: the answer. */
  answer?: string;
  triage: TriageResult;
  clarifications: Clarification[];
  spec?: DesignSpec;
  tests?: SpecTestResult[];
  proposal?: Proposal;
  models: AgentModels;
  prompts: Partial<Record<"designer" | "spec_writer" | "triage", { id: string; sha256: string }>>;
  costUsd: number;
  latencyMs: number;
  /** Designer turns. */
  turns: number;
  trace: TraceSummary;
  events: TraceEvent[];
  conversations: { triage?: Message[]; clarify?: Message[]; spec_writer?: Message[]; designer?: Message[] };
}

export class Agent {
  readonly options: AgentOptions;

  constructor(options: AgentOptions) {
    this.options = options;
  }

  run(request: AgentRequest): Promise<AgentResult> {
    return new AgentRun(this.options, request).execute();
  }
}

// ─── One run ─────────────────────────────────────────────────────────────────────────────────

const ORCH = "[orchestrator]";

function testLine(t: HiddenTest): string {
  const params = [t.type && `type ${t.type}`, t.axis && `axis ${t.axis}`, t.body !== undefined && `body ${t.body}`, t.kind && `kind ${t.kind}`, t.diameter && `Ø[${t.diameter.join(", ")}]`]
    .filter(Boolean)
    .join(", ");
  return `- ${t.id} — ${t.description} [${t.check}${params ? ` (${params})` : ""} ${describeTest(t)}]`;
}

function specBlocks(spec: DesignSpec | undefined, tests: readonly HiddenTest[]): string[] {
  const out: string[] = [];
  if (spec) {
    const lines = [`<design_spec>`, spec.summary];
    if (spec.requirements.length) lines.push("Requirements:", ...spec.requirements.map((r) => `- ${r.id}: ${r.text}`));
    if (spec.assumptions.length) lines.push("Assumptions (defaults taken — keep them unless the request says otherwise):", ...spec.assumptions.map((a) => `- ${a.id}: ${a.text} → ${a.default}`));
    if (spec.key_dimensions.length) lines.push(`Key dimensions: ${spec.key_dimensions.map((d) => `${d.name} ${d.value} ${d.unit}`).join("; ")}`);
    lines.push("</design_spec>");
    out.push(lines.join("\n"));
  }
  if (tests.length > 0) {
    out.push(`<spec_tests frozen="true">\nThese run as L3 after every successful apply (run_tests shows margins). You cannot change them.\n${tests.map(testLine).join("\n")}\n</spec_tests>`);
  }
  return out;
}

class AgentRun {
  readonly #o: AgentOptions;
  readonly #req: AgentRequest;
  readonly #limits: AgentLimits;
  readonly #now: () => number;
  readonly #trace: TraceRecorder;
  #models!: AgentModels;
  #rc!: RunContext;
  #session!: DesignSession;
  #registry: ToolRegistry<DesignToolContext> = designerRegistry();
  #prompts: { designer?: PromptInfo; spec_writer?: PromptInfo; triage?: PromptInfo } = {};
  #system: SystemBlock[] = [];
  #triage: TriageResult = fallbackTriage(false, "not run");
  #clarifications: Clarification[] = [];
  #conversations: AgentResult["conversations"] = {};
  #designer: Conversation | undefined;

  // Build-loop state.
  #failedStreak = 0;
  #lastFailSig = "";
  #replans = 0;
  #refines = 0;
  #proposeRejects = 0;
  #askRounds = 0;
  #lastGood: Checkpoint | undefined;
  #best: { cp: Checkpoint; passed: number } | undefined;
  #proposal: Proposal | undefined;
  #answer: string | undefined;
  #ended = false;
  #pendingStop: AgentStop | undefined;
  #budgetCheckpointDone = false;
  #stop: { reason: AgentStopReason; message: string } | undefined;

  constructor(options: AgentOptions, request: AgentRequest) {
    this.#o = options;
    this.#req = request;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#now = options.now ?? (() => performance.now());
    this.#trace = new TraceRecorder(this.#now, options.hooks?.onEvent);
  }

  async execute(): Promise<AgentResult> {
    const o = this.#o;
    this.#models = resolveModels(o.gateway, o.models);
    const task = o.gateway.createTask({
      id: o.taskId ?? `agent-${this.#req.name ?? "task"}`,
      budgetUsd: o.budgetUsd ?? 1.5,
      projectionOutputTokens: this.#limits.projectionOutputTokens,
    });
    this.#rc = { gateway: o.gateway, task, models: this.#models, trace: this.#trace, limits: this.#limits, now: this.#now };
    const variant = (role: "designer" | "spec_writer" | "triage") => o.gateway.profile(this.#models[role].model).promptVariant;
    const load = (role: "designer" | "spec_writer" | "triage") =>
      loadPrompt(role, { variant: variant(role), ...(o.promptVersion ? { version: o.promptVersion } : {}), ...(o.promptsDir ? { dir: o.promptsDir } : {}) });
    this.#prompts.designer = load("designer");
    this.#system = [
      { type: "text", text: this.#prompts.designer.text },
      { type: "text", text: cadscriptReference() },
      ...(o.conventions ? [{ type: "text" as const, text: `# Project conventions\n\n${o.conventions}` }] : []),
    ];
    try {
      const availability = await o.engine.availability();
      if (!availability.available) throw new AgentStop("engine_unavailable", `engine ${o.engine.kind} unavailable: ${availability.detail}`);
      this.#session = await DesignSession.open({ engine: o.engine, ...(this.#req.context ? { source: this.#req.context } : {}), name: this.#req.name ?? "design" });
      if (this.#session.checkpoints.length === 0) this.#session.checkpoint("start");
      else this.#lastGood = this.#session.state.verification.ok ? this.#session.checkpoints[0] : undefined;

      await this.#doTriage();
      let kind = this.#triage.kind;
      if (kind === "quick_edit" && !this.#req.context) kind = "design"; // nothing to edit
      if (kind === "ask") {
        await this.#ask();
      } else {
        if (kind === "design" && this.#triage.needs_clarification) await this.#clarify();
        if (kind === "design") await this.#spec();
        await this.#build(kind);
      }
    } catch (e) {
      if (e instanceof AgentStop) this.#stopWith(e.reason, e.message);
      else this.#stopWith("model_error", `internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
    return this.#finish();
  }

  // ── Phases ──

  async #doTriage(): Promise<void> {
    if (this.#o.kind) {
      this.#triage = { kind: this.#o.kind, complexity: "T1", needs_clarification: false, reason: "set by the caller", source: "forced" };
      this.#trace.enter("TRIAGE", "forced");
      return;
    }
    this.#trace.enter("TRIAGE");
    this.#prompts.triage = loadPrompt("triage", { variant: this.#o.gateway.profile(this.#models.triage.model).promptVariant, ...(this.#o.promptsDir ? { dir: this.#o.promptsDir } : {}) });
    const ir = this.#session.ir;
    const openModel = ir ? `${ir.parts.reduce((n, p) => n + p.features.length, 0)} features (${ir.parts.flatMap((p) => p.features.map((f) => `${f.name}: ${f.type}`)).join(", ")})` : undefined;
    const { result, messages } = await runTriage(this.#rc, this.#prompts.triage, { prompt: this.#req.prompt, ...(openModel ? { openModel } : {}) });
    this.#triage = result;
    this.#conversations.triage = messages;
    this.#trace.note(`triage: ${result.kind} ${result.complexity}${result.needs_clarification ? " (clarify)" : ""} — ${result.reason} [${result.source}]`);
  }

  #toolCtx(readOnly = false): DesignToolContext {
    const answer =
      this.#o.mode === "interactive" && this.#o.askUser ? this.#o.askUser : evalModeAnswers(this.#o.recordedDefaults);
    return {
      session: this.#session,
      readOnly,
      askUser: async (qs) => {
        const answers = await answer(qs);
        qs.forEach((q, i) => this.#clarifications.push({ question: q.question, answer: answers[i] ?? q.default }));
        return answers;
      },
    };
  }

  #taskLines(): string[] {
    const lines = [`<request>\n${this.#req.prompt}\n</request>`];
    const p = processLine(this.#req.process);
    if (p) lines.push(p);
    if (this.#req.context) {
      const v = this.#session.state.verification;
      lines.push(
        `<starting_model>\nThis file is already applied; edit it with patches and keep unrelated features unchanged.\n\`\`\`ts\n${this.#req.context.trimEnd()}\n\`\`\`\nIt evaluates: ${verificationLine(v)}${this.#session.report ? `\n${irSummary(this.#session.ir!, this.#session.report, { maxChars: 5000 })}` : ""}\n</starting_model>`,
      );
    }
    return lines;
  }

  async #clarify(): Promise<void> {
    this.#trace.enter("CLARIFY");
    const convo = new Conversation().appendUser(
      [
        ...this.#taskLines(),
        `Phase: CLARIFY. Before any modeling, decide whether to ask the user. Ask only if the request is ambiguous in a way that changes topology or interfaces, the units are unclear, or requirements conflict — and no safe default exists. If so, call ask_user once with at most 3 questions, each with the default you would use. Otherwise reply with exactly "NO QUESTIONS". Call no other tool now.`,
      ].join("\n\n"),
    );
    const res = await callModel(this.#rc, "designer", { system: this.#system, tools: this.#registry.defs(), messages: [...convo.messages] });
    convo.appendResponse(res);
    const ask = res.message.content.find((b): b is ToolUseBlock => b.type === "tool_use" && b.name === "ask_user");
    if (ask) {
      const out = await this.#registry.execute({ id: ask.id, name: ask.name, input: ask.input, ...(ask.inputError ? { inputError: ask.inputError } : {}) }, this.#toolCtx());
      this.#trace.tool({ name: "ask_user", ok: !out.isError, ms: 0, phase: "CLARIFY" }, out.text.split("\n")[0] ?? "");
    } else {
      this.#trace.note("clarify: no questions");
    }
    this.#conversations.clarify = [...convo.messages];
  }

  async #spec(): Promise<void> {
    this.#trace.enter("SPEC");
    this.#prompts.spec_writer = loadPrompt("spec_writer", {
      variant: this.#o.gateway.profile(this.#models.spec_writer.model).promptVariant,
      ...(this.#o.promptVersion ? { version: this.#o.promptVersion } : {}),
      ...(this.#o.promptsDir ? { dir: this.#o.promptsDir } : {}),
    });
    const out = await runSpecWriter(this.#rc, this.#prompts.spec_writer, this.#session, {
      prompt: this.#req.prompt,
      process: this.#req.process,
      clarifications: this.#clarifications,
    });
    this.#conversations.spec_writer = out.messages;
    this.#trace.note(out.spec ? `spec frozen: ${out.spec.requirements.length} requirements, ${out.spec.tests.length} tests` : `spec: ${out.note ?? "none"}`);
    if (out.note) this.#trace.note(out.note);
  }

  #buildHeader(kind: TriageKind): string {
    const lines = this.#taskLines();
    const c = clarificationsBlock(this.#clarifications);
    if (c) lines.push(c);
    lines.push(...specBlocks(this.#session.spec, this.#session.tests));
    const cap = this.#rc.task.budget.capUsd;
    lines.push(`<budget>Hard cap $${cap.toFixed(2)} for this task; the run stops at ${Math.round(this.#limits.budgetStopFraction * 100)}% of it.</budget>`);
    lines.push(
      kind === "quick_edit"
        ? "This is a quick edit: make the smallest change that does it (patches), check the result against the request (measure if a number is in doubt), then propose."
        : this.#session.tests.length > 0
          ? "Plan briefly (numbers computed), then build with apply_cadscript in small verified steps. Propose when the spec tests pass."
          : "Plan briefly (numbers computed), then build with apply_cadscript in small verified steps. There are no spec tests: check the result against the request with measure, then propose.",
    );
    return lines.join("\n\n");
  }

  async #budgetGate(): Promise<void> {
    const budget = this.#rc.task.budget;
    if (this.#budgetCheckpointDone || budget.spentUsd < this.#limits.budgetStopFraction * budget.capUsd) return;
    this.#budgetCheckpointDone = true;
    const info = { spentUsd: budget.spentUsd, capUsd: budget.capUsd };
    const cont = this.#o.mode === "interactive" && this.#o.hooks?.onBudgetCheckpoint ? await this.#o.hooks.onBudgetCheckpoint(info) : false;
    if (!cont) throw new AgentStop("budget", `spent $${info.spentUsd.toFixed(4)} of the $${info.capUsd.toFixed(2)} cap (≥ ${Math.round(this.#limits.budgetStopFraction * 100)}%)`);
    this.#trace.note("budget checkpoint: continuing to the hard cap");
  }

  async #build(kind: TriageKind): Promise<void> {
    this.#trace.enter("BUILD", kind);
    const convo = new Conversation().appendUser(this.#buildHeader(kind));
    this.#designer = convo;
    const tools = this.#registry.defs();
    let nudges = 0;
    let turns = 0;
    try {
      while (!this.#ended) {
        await this.#budgetGate();
        if (turns >= this.#limits.maxTurns) throw new AgentStop("max_turns", `${turns} designer turns without a proposal`);
        turns++;
        const res = await callModel(this.#rc, "designer", { system: this.#system, tools, messages: [...convo.messages] });
        convo.appendResponse(res);
        const calls = res.message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (calls.length === 0) {
          nudges++;
          if (nudges > this.#limits.maxNudges) {
            if (this.#session.verification.ok) {
              this.#trace.note("no tool call after nudges; the model verifies → implicit proposal");
              this.#accept({ summary: responseText(res) || "(no summary)", assumptions: [], known_issues: ["The designer stopped without calling propose."] });
              break;
            }
            throw new AgentStop("no_progress", `${nudges} designer turns without a tool call`);
          }
          convo.appendUser(
            res.stopReason === "max_tokens"
              ? `${ORCH} Your reply hit the output limit. Continue with smaller steps: patch one or two features per apply_cadscript call.`
              : `${ORCH} No tool call in your last turn. Continue with apply_cadscript, or call propose if the model is done.`,
          );
          continue;
        }
        nudges = 0;
        const results: ToolResultBlock[] = [];
        const notes: string[] = [];
        for (const call of calls) {
          if (this.#ended || this.#pendingStop) {
            results.push({ type: "tool_result", toolUseId: call.id, content: "Not executed: the task has ended.", isError: true });
            continue;
          }
          const out = await this.#execute(call, notes);
          results.push({ type: "tool_result", toolUseId: call.id, content: out.text, ...(out.isError ? { isError: true } : {}) });
        }
        const content: (ToolResultBlock | TextBlock)[] = [...results];
        if (notes.length > 0) content.push({ type: "text", text: notes.join("\n\n") });
        convo.appendUser(content);
        if (this.#pendingStop) throw this.#pendingStop;
      }
    } finally {
      this.#conversations.designer = [...convo.messages];
    }
  }

  async #ask(): Promise<void> {
    this.#trace.enter("ASK");
    const convo = new Conversation().appendUser(
      [...this.#taskLines(), "This is a question: do not change the design. Use get_code / ir_summary / measure as needed, then reply with the answer as plain text."].join("\n\n"),
    );
    this.#designer = convo;
    const tools = this.#registry.defs();
    try {
      for (let turn = 0; turn < Math.min(8, this.#limits.maxTurns); turn++) {
        await this.#budgetGate();
        const res = await callModel(this.#rc, "designer", { system: this.#system, tools, messages: [...convo.messages] });
        convo.appendResponse(res);
        const calls = res.message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (calls.length === 0) {
          this.#answer = responseText(res);
          this.#ended = true;
          this.#trace.stop("answered", this.#answer.slice(0, 120));
          return;
        }
        const results: ToolResultBlock[] = [];
        for (const call of calls) {
          const t0 = this.#now();
          const out = await this.#registry.execute({ id: call.id, name: call.name, input: call.input, ...(call.inputError ? { inputError: call.inputError } : {}) }, this.#toolCtx(true));
          this.#trace.tool({ name: call.name, ok: !out.isError, ms: Math.round(this.#now() - t0), phase: "ASK" }, out.text.split("\n")[0] ?? "");
          results.push({ type: "tool_result", toolUseId: call.id, content: out.text, ...(out.isError ? { isError: true } : {}) });
        }
        convo.appendUser(results);
      }
      throw new AgentStop("no_progress", "no answer after 8 turns");
    } finally {
      this.#conversations.designer = [...convo.messages];
    }
  }

  // ── Tool execution and ladder bookkeeping ──

  async #execute(call: ToolUseBlock, notes: string[]): Promise<ToolOutput> {
    const t0 = this.#now();
    let out: ToolOutput;
    if (call.name === "ask_user" && this.#askRounds >= this.#limits.maxAskRounds) {
      out = { text: "No more questions: continue with your defaults and list them as assumptions when you propose.", isError: true };
    } else {
      if (call.name === "ask_user") this.#askRounds++;
      out = await this.#registry.execute(
        { id: call.id, name: call.name, input: call.input, ...(call.inputError !== undefined ? { inputError: call.inputError, rawInput: call.rawInput ?? "" } : {}) },
        this.#toolCtx(),
      );
      const data = out.data;
      if (data?.kind === "apply") this.#afterApply(data, notes);
      else if (data?.kind === "rollback") {
        this.#failedStreak = 0;
        this.#lastFailSig = "";
      } else if (data?.kind === "propose") out = await this.#onPropose(data["proposal"] as Proposal);
    }
    this.#trace.tool({ name: call.name, ok: !out.isError, ms: Math.round(this.#now() - t0), phase: this.#trace.state }, out.text.split("\n")[0] ?? "");
    return out;
  }

  #afterApply(data: Record<string, unknown>, notes: string[]): void {
    const t = this.#trace;
    t.applies++;
    if (data["engineError"] === "ENGINE_UNAVAILABLE") {
      this.#pendingStop = new AgentStop("engine_unavailable", "the geometry engine became unavailable");
      return;
    }
    if (data["ok"] === true) {
      this.#failedStreak = 0;
      this.#lastFailSig = "";
      if (t.state !== "BUILD") t.enter("BUILD", "step verified");
      const cp = this.#session.checkpoint(`auto: apply #${String(data["index"])}`);
      this.#lastGood = cp;
      const passed = (data["tests"] as { passed: number } | undefined)?.passed ?? 0;
      if (!this.#best || passed >= this.#best.passed) this.#best = { cp, passed };
      return;
    }
    t.failedApplies++;
    const sig = String(data["errorSignature"] ?? "");
    if (sig !== "" && sig === this.#lastFailSig) {
      this.#pendingStop = new AgentStop("same_error", `the same error twice in a row: ${sig.slice(0, 300)}`);
      notes.push(`${ORCH} The same error occurred twice in a row; the task stops here.`);
      return;
    }
    this.#lastFailSig = sig;
    this.#failedStreak++;
    const max = this.#limits.maxRepairs;
    if (this.#failedStreak <= max) {
      t.repairs++;
      t.enter("REPAIR", `${this.#failedStreak}/${max}`);
      notes.push(`${ORCH} REPAIR ${this.#failedStreak}/${max}: fix the first root-cause error above with the smallest patch; leave unrelated features alone.`);
      return;
    }
    if (this.#replans < this.#limits.maxReplans) {
      this.#replans++;
      t.replans++;
      const target = this.#lastGood ?? this.#session.findCheckpoint("start")!;
      this.#session.rollback(target.id);
      this.#failedStreak = 0;
      this.#lastFailSig = "";
      t.enter("REPLAN", `rolled back to ${target.id}`);
      const state = target.state.ir ? `\nCurrent state:\n${irSummary(target.state.ir, target.state.report, { maxChars: 4000 })}` : "\nCurrent state: empty file.";
      notes.push(
        `${ORCH} ${max} repairs failed, so the design was rolled back to ${target.id} "${target.label}". REPLAN: build this step a different way (another construction or simpler geometry), not another variation of the failed attempt.${state}`,
      );
      return;
    }
    this.#pendingStop = new AgentStop("repairs_exhausted", `${max} repairs and ${this.#limits.maxReplans} replan failed; last error: ${sig.slice(0, 300)}`);
  }

  async #onPropose(proposal: Proposal): Promise<ToolOutput> {
    const v = this.#session.verification;
    if (!v.ok) {
      if (this.#proposeRejects < 1) {
        this.#proposeRejects++;
        return {
          text: `Not accepted: the current model fails verification (${verificationLine(v)}). Fix it${this.#lastGood ? `, or rollback to ${this.#lastGood.id} "${this.#lastGood.label}"` : ""}, then propose again.`,
          isError: true,
        };
      }
      const fallback = this.#best?.cp ?? this.#lastGood;
      if (fallback) {
        this.#session.rollback(fallback.id);
        proposal.known_issues.push(`The last edit did not verify; the proposal is the last verified state (${fallback.id} "${fallback.label}").`);
      } else {
        proposal.known_issues.push(`The model does not verify: ${verificationLine(v)}`);
      }
    }
    const tests = this.#session.runTests() ?? [];
    const failing = tests.filter((t) => !t.pass);
    const acknowledged = (t: SpecTestResult) => proposal.known_issues.some((k) => k.includes(t.id));
    const unacknowledged = failing.filter((t) => !acknowledged(t));
    if (unacknowledged.length > 0 && this.#refines < this.#limits.maxRefines) {
      this.#refines++;
      this.#trace.refines++;
      this.#trace.enter("REPAIR", `refine ${this.#refines}/${this.#limits.maxRefines}`);
      return {
        text: [
          `Not accepted (REFINE ${this.#refines}/${this.#limits.maxRefines}): ${failing.length} of ${tests.length} spec tests fail:`,
          ...failing.map((t) => `  ${formatTestResult(t)}`),
          "Fix the model. If you are certain a test contradicts the request, propose again and name that test id in known_issues.",
        ].join("\n"),
        isError: true,
      };
    }
    if (failing.length === 0 && this.#o.hooks?.visualJudge) {
      // L5: out of scope until rendering exists; only runs when a judge is plugged in.
      const verdict = await this.#o.hooks.visualJudge({ source: this.#session.source, ir: this.#session.ir, report: this.#session.report, spec: this.#session.spec });
      if (!verdict.pass) {
        if (this.#refines < this.#limits.maxRefines) {
          this.#refines++;
          this.#trace.refines++;
          return { text: `Not accepted (visual review): ${verdict.findings.join("; ")}. Fix these, then propose again.`, isError: true };
        }
        proposal.known_issues.push(...verdict.findings.map((f) => `visual review: ${f}`));
      }
    }
    for (const t of failing) if (!acknowledged(t)) proposal.known_issues.push(`spec test ${t.id} fails: ${formatTestResult(t)}`);
    this.#accept(proposal);
    return { text: `Proposal accepted${failing.length ? ` with ${failing.length} failing spec test(s) listed as known issues` : ""}. The task is complete.` };
  }

  #accept(proposal: Proposal): void {
    this.#proposal = proposal;
    this.#ended = true;
    this.#trace.enter("PROPOSE");
    this.#trace.stop("proposed", proposal.summary.slice(0, 160));
  }

  #stopWith(reason: AgentStopReason, message: string): void {
    this.#stop = { reason, message };
    this.#ended = true;
    this.#trace.stop(reason, message);
  }

  #finish(): AgentResult {
    const s = this.#session as DesignSession | undefined;
    let status: AgentStatus;
    let stopReason: AgentStopReason;
    let message: string;
    if (this.#answer !== undefined) {
      status = "answered";
      stopReason = "answered";
      message = "answered";
    } else if (this.#proposal) {
      status = "proposed";
      stopReason = "proposed";
      message = this.#proposal.summary;
    } else {
      stopReason = this.#stop?.reason ?? "no_progress";
      message = this.#stop?.message ?? "stopped";
      status = stopReason === "model_error" || stopReason === "engine_unavailable" ? "failed" : "stopped";
      // Hand back the best verified state, not a broken last attempt.
      if (s && !s.verification.ok) {
        const fallback = this.#best?.cp ?? this.#lastGood;
        if (fallback) {
          s.rollback(fallback.id);
          this.#trace.note(`final state: rolled back to ${fallback.id} "${fallback.label}"`);
        }
      }
    }
    this.#trace.enter("DONE", status);
    const tests = s?.runTests();
    const result: AgentResult = {
      status,
      stopReason,
      message,
      cadscript: s?.source ?? "",
      verified: s?.verification.ok ?? false,
      triage: this.#triage,
      clarifications: this.#clarifications,
      models: this.#models,
      prompts: Object.fromEntries(Object.entries(this.#prompts).map(([k, p]) => [k, { id: p.id, sha256: p.sha256 }])),
      costUsd: this.#rc?.task.costUsd ?? 0,
      latencyMs: this.#trace.elapsed(),
      turns: this.#trace.llmCalls.filter((c) => c.role === "designer").length,
      trace: this.#trace.summary(),
      events: this.#trace.events,
      conversations: this.#conversations,
    };
    if (this.#answer !== undefined) result.answer = this.#answer;
    if (s?.spec) result.spec = s.spec;
    if (tests) result.tests = tests;
    if (this.#proposal) result.proposal = this.#proposal;
    else if (status !== "answered") {
      const failing = (tests ?? []).filter((t) => !t.pass).map((t) => `spec test ${t.id} fails: ${formatTestResult(t)}`);
      result.proposal = { summary: `Stopped (${stopReason}): ${message}`, assumptions: [], known_issues: [message, ...failing] };
    }
    return result;
  }
}

/** One line for logs: status, cost, turns, tests. */
export function resultLine(r: AgentResult): string {
  const t = r.tests ? summarizeTests(r.tests) : undefined;
  return `${r.status} (${r.stopReason}) $${r.costUsd.toFixed(4)} ${r.turns} turns${t ? `, spec tests ${t.passed}/${t.total}` : ""}${r.verified ? "" : ", NOT verified"}`;
}

export type { AgentState };
