/**
 * The Assistant panel: the chat transcript with live agent run cards (progress checklist, cost
 * meter vs budget, Stop, clarifying questions as multiple-choice cards, the result with assumption
 * chips), selection chips that travel with the message, and the composer.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { AgentApprovalRequest, AgentPhase, AgentQuestion, AgentQuestionKind, AgentStepView, AutonomySetting } from "../agent-protocol";
import type { AgentRun } from "../agent/agent-service";
import type { AppInvocation } from "../commands/commands";
import { useSelectionChips as useModelSelectionChips } from "../selection/chips";
import type { ChatMessage, SelectionChip } from "../ui-store";
import { useApp, useStore } from "./context";
import { Icon } from "./icons";

// Chips come from the selection model (plural: every selected face, edge and body).
const useSelectionChips: () => SelectionChip[] = useModelSelectionChips;

// ─── Run card ────────────────────────────────────────────────────────────────────────────

interface Step {
  id: string;
  label: string;
  phases: readonly AgentPhase[];
  optional?: boolean;
}

const STEPS: readonly Step[] = [
  { id: "understand", label: "Understand the request", phases: ["TRIAGE"] },
  { id: "clarify", label: "Clarify", phases: ["CLARIFY"], optional: true },
  { id: "spec", label: "Write spec & tests", phases: ["SPEC"], optional: true },
  { id: "answer", label: "Answer", phases: ["ASK"], optional: true },
  { id: "build", label: "Build & verify", phases: ["BUILD", "REPAIR", "REPLAN"] },
  { id: "propose", label: "Propose", phases: ["PROPOSE"] },
];

type StepState = "pending" | "active" | "done" | "failed";

function stepsOf(run: AgentRun): Array<Step & { state: StepState; detail: string }> {
  const asked = run.phases.includes("ASK");
  const visible = STEPS.filter((s) => (s.optional ? s.phases.some((p) => run.phases.includes(p)) : !(asked && (s.id === "build" || s.id === "propose"))));
  const idxOf = (p: AgentPhase | null): number => (p ? visible.findIndex((s) => s.phases.includes(p)) : -1);
  let reached = -1;
  for (const p of run.phases) reached = Math.max(reached, idxOf(p));
  const current = idxOf(run.phase === "DONE" ? null : run.phase);
  const finished = run.status === "done" || run.status === "failed";
  const ok = run.result?.status === "proposed" || run.result?.status === "answered";
  return visible.map((s, i) => {
    let state: StepState = "pending";
    if (i < reached) state = "done";
    else if (i === reached || i === current) state = finished ? (ok ? "done" : "failed") : "active";
    let detail = "";
    if (s.id === "build") {
      if (run.phase === "REPAIR" || run.phase === "REPLAN") detail = run.detail || run.phase.toLowerCase();
      else if (run.draft) detail = `apply #${run.draft.applyIndex}${run.draft.verified ? " ✓" : ""}`;
    }
    return { ...s, state, detail };
  });
}

function money(usd: number): string {
  return usd < 0.1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/**
 * Spend vs the per-task budget. On a CLI plan the spend is notional: the API list price of what the run used, counted
 * against the same budget, but not billed (docs/CLI-PROVIDERS.md §11.6).
 */
function CostMeter({ spent, budget, notional }: { spent: number; budget: number; notional: boolean }): ReactElement {
  const frac = budget > 0 ? Math.min(1, spent / budget) : 0;
  const title = notional
    ? "Plan usage of this task at API list prices (not billed; your plan's own limits apply) vs the per-task budget (the run stops at 80 % and asks)"
    : "Model spend for this task vs the per-task budget (the run stops at 80 % and asks)";
  return (
    <div className={`cost-meter${frac >= 0.8 ? " warn" : ""}`} data-testid="agent-cost" data-notional={notional ? "yes" : "no"} title={title}>
      <span className="cost-text mono">
        {notional ? `≈ ${money(spent)} plan usage` : money(spent)} <span className="muted">/ {money(budget)}</span>
      </span>
      <span className="cost-bar" aria-hidden="true">
        <span className="cost-fill" style={{ width: `${(frac * 100).toFixed(1)}%` }} />
      </span>
    </div>
  );
}

/** Ask at each step: the step that just landed, Keep or Undo. */
function StepReviewCard({ step }: { step: AgentStepView | undefined }): ReactElement {
  const { run } = useApp();
  return (
    <div className="question-card step-review" data-testid="agent-step-review">
      <div className="question-title">
        <Icon.Question size={13} /> Keep this step?
      </div>
      <p className="step-review-note">{step ? `${step.index}. ${step.note}` : "The agent's last step"}</p>
      {step?.check && <p className="step-review-check mono muted small">{step.check}</p>}
      <div className="question-actions">
        <button type="button" className="ghost-btn" data-testid="agent-step-undo" onClick={() => run({ id: "agent.answer", args: { answers: ["Undo"] } })}>
          Undo step
        </button>
        <button type="button" className="primary-btn small" data-testid="agent-step-keep" onClick={() => run({ id: "agent.answer", args: { answers: ["Keep"] } })}>
          Keep
        </button>
      </div>
    </div>
  );
}

/** The agent asks to change the user's own work (ADR 0015 §3). */
function ApprovalCard({ approval }: { approval: AgentApprovalRequest | undefined }): ReactElement {
  const { run } = useApp();
  const what = approval ? [...approval.features.map((f) => `feature ${f}`), ...approval.params.map((p) => `parameter ${p}`), ...(approval.rollback ? ["the rollback marker"] : [])].join(", ") : "your work";
  return (
    <div className="question-card approval" data-testid="agent-approval">
      <div className="question-title">
        <Icon.Warning size={13} /> The agent asks to change your work
      </div>
      <p className="approval-what">{what}</p>
      {approval?.reason && <p className="approval-reason muted">{approval.reason}</p>}
      <div className="question-actions">
        <button type="button" className="ghost-btn" data-testid="agent-approval-deny" onClick={() => run({ id: "agent.answer", args: { answers: ["Don't allow"] } })}>
          Don’t allow
        </button>
        <button type="button" className="primary-btn small" data-testid="agent-approval-allow" onClick={() => run({ id: "agent.answer", args: { answers: ["Allow"] } })}>
          Allow for this task
        </button>
      </div>
    </div>
  );
}

function QuestionCard({ questionId, kind, questions, step, approval }: { questionId: string; kind: AgentQuestionKind; questions: AgentQuestion[]; step?: AgentStepView; approval?: AgentApprovalRequest }): ReactElement {
  if (kind === "step") return <StepReviewCard step={step} />;
  if (kind === "approval") return <ApprovalCard approval={approval} />;
  return <ChoiceQuestionCard questionId={questionId} kind={kind} questions={questions} />;
}

function ChoiceQuestionCard({ questionId, kind, questions }: { questionId: string; kind: AgentQuestionKind; questions: AgentQuestion[] }): ReactElement {
  const { run } = useApp();
  const [picked, setPicked] = useState<string[]>(() => questions.map((q) => q.default));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ""));
  const answers = picked.map((p, i) => (other[i]?.trim() ? other[i]!.trim() : p));
  return (
    <div className="question-card" data-testid="agent-question" data-question={questionId}>
      <div className="question-title">
        <Icon.Question size={13} /> {kind === "budget" ? "Budget checkpoint" : questions.length === 1 ? "The agent has a question" : `The agent has ${questions.length} questions`}
      </div>
      {questions.map((q, i) => {
        const options = q.options && q.options.length > 0 ? q.options : [q.default];
        return (
          <fieldset key={q.id} className="question" data-testid="agent-question-item">
            <legend>{q.question}</legend>
            <div className="question-options" role="radiogroup">
              {options.map((o) => (
                <button
                  key={o}
                  type="button"
                  role="radio"
                  aria-checked={picked[i] === o && !other[i]?.trim()}
                  className={`option${picked[i] === o && !other[i]?.trim() ? " picked" : ""}`}
                  onClick={() => {
                    setPicked(picked.map((p, j) => (j === i ? o : p)));
                    setOther(other.map((x, j) => (j === i ? "" : x)));
                  }}
                >
                  {o}
                  {o === q.default && <span className="default-tag">default</span>}
                </button>
              ))}
            </div>
            {kind === "clarify" && (
              <input
                className="question-other"
                placeholder="Other answer…"
                aria-label={`Other answer to ${q.id}`}
                value={other[i] ?? ""}
                onChange={(e) => setOther(other.map((x, j) => (j === i ? e.target.value : x)))}
              />
            )}
          </fieldset>
        );
      })}
      <div className="question-actions">
        <button type="button" className="ghost-btn" onClick={() => run({ id: "agent.answer", args: { answers: questions.map((q) => q.default) } })}>
          Use defaults
        </button>
        <button type="button" className="primary-btn small" data-testid="agent-answer" onClick={() => run({ id: "agent.answer", args: { answers } })}>
          {questions.length === 1 ? "Answer" : "Send answers"}
        </button>
      </div>
    </div>
  );
}

const STOP_LABEL: Record<string, string> = {
  cancelled: "Stopped",
  budget: "Stopped at the budget checkpoint",
  same_error: "Stopped: the same error repeated",
  repairs_exhausted: "Stopped: repairs exhausted",
  max_turns: "Stopped: turn limit",
  refusal: "Stopped: the model refused",
  no_progress: "Stopped: no progress",
  engine_unavailable: "Failed: no geometry engine",
  model_error: "Failed: model error",
  lockdown_violation: "Stopped: the CLI broke its lockdown",
  wall_time: "Stopped: time limit",
};

const AUTONOMY_LABELS: Record<AutonomySetting, { label: string; title: string }> = {
  ask: { label: "Ask each step", title: "The agent pauses after every step: you keep it or undo it before it goes on." },
  review: { label: "Review turn", title: "The agent builds live; you keep or undo its whole turn when it finishes." },
  auto: { label: "Auto", title: "The agent builds live and you get a notice. Your own features still change only with your approval." },
};

/** The autonomy dial (ADR 0015) in the Assistant header: only the user sets it. */
function AutonomyDial(): ReactElement | null {
  const { services, run } = useApp();
  const settings = useStore(services.agent, (s) => s.settings);
  const available = useStore(services.agent, (s) => s.available);
  useEffect(() => {
    if (available && settings === null) void services.agent.refreshSettings().catch(() => undefined);
  }, [available, settings, services.agent]);
  if (!available) return null;
  const value: AutonomySetting = settings?.autonomy ?? "review";
  return (
    <select
      className="autonomy-dial"
      data-testid="agent-autonomy"
      aria-label="Agent autonomy"
      title={AUTONOMY_LABELS[value].title}
      value={value}
      onChange={(e) => run({ id: "settings.setAutonomy", args: { autonomy: e.target.value as AutonomySetting } })}
    >
      {(Object.keys(AUTONOMY_LABELS) as AutonomySetting[]).map((k) => (
        <option key={k} value={k} title={AUTONOMY_LABELS[k].title}>
          {AUTONOMY_LABELS[k].label}
        </option>
      ))}
    </select>
  );
}

const kept = (run: AgentRun): number => run.steps.filter((s) => s.ok && !s.undone).length;

/** A live run's headline: what it is doing, or how it ended and what stayed. */
function liveHeadline(run: AgentRun): string {
  const n = kept(run);
  const steps = `${n} step${n === 1 ? "" : "s"}`;
  if (run.status === "failed") return n > 0 ? `Stopped — ${steps} kept` : "Failed";
  if (run.status === "question") return run.question?.kind === "step" ? "Keep this step?" : run.question?.kind === "approval" ? "Asking to change your work" : "Waiting for your answer";
  if (run.status === "running") {
    const last = [...run.steps].reverse().find((s) => s.ok);
    return last ? `Building — ${last.note}` : run.outline.length > 0 ? "Building…" : "Reading the model…";
  }
  const r = run.result!;
  if (r.status === "answered") return "Answered";
  if (r.status === "proposed") return n > 0 ? `Built — ${steps}` : "Done — no changes";
  if (r.quota) return r.quota.kind === "quota_exhausted" ? "Stopped: plan usage limit reached" : "Stopped: rate limited";
  const why = STOP_LABEL[r.stopReason] ?? `Stopped (${r.stopReason})`;
  return n > 0 ? `${why} — ${steps} kept` : why;
}

/** The live operator's plan and its steps, narrated one line each (the chat side of "watch it build"). */
function LiveSteps({ run }: { run: AgentRun }): ReactElement {
  const live = run.status === "running" || run.status === "question";
  return (
    <div className="live-steps" data-testid="agent-live">
      {run.outline.length > 0 && (
        <details className="live-plan" open={run.steps.length === 0}>
          <summary className="muted small">Plan · {run.outline.length} steps</summary>
          <ol data-testid="agent-plan">
            {run.outline.map((p, i) => (
              <li key={`${i}:${p}`}>{p}</li>
            ))}
          </ol>
        </details>
      )}
      <ol className="run-steps live" data-testid="agent-steps">
        {run.steps.map((s, i) => {
          const state = s.undone ? "undone" : s.ok ? "done" : "refused";
          return (
            <li key={`${i}:${s.index}:${s.label}`} className={`step step-${state}`} data-state={state} data-testid="agent-step" title={s.check ?? (s.code ? `refused: ${s.code}` : s.label)}>
              <span className="step-mark" aria-hidden="true">
                {s.undone ? <Icon.Close size={10} /> : s.ok ? <Icon.Check size={11} /> : <Icon.Warning size={10} />}
              </span>
              <span className="step-label">{s.ok ? s.note : `Tried: ${s.note}`}</span>
              {s.undone && <span className="step-detail muted">undone</span>}
              {!s.ok && s.code && <span className="step-detail mono muted">{s.code.split("/").at(-1)}</span>}
            </li>
          );
        })}
        {live && (
          <li className="step step-active" data-state="active">
            <span className="step-mark" aria-hidden="true">
              <Icon.Spinner size={11} />
            </span>
            <span className="step-label muted">{run.status === "question" ? "Waiting for you" : run.steps.length === 0 ? "Planning" : "Working on the next step"}</span>
          </li>
        )}
      </ol>
    </div>
  );
}

/** How a live turn ended: the summary, and Keep / Undo for the whole turn (one undo step). */
function LiveResult({ run }: { run: AgentRun }): ReactElement | null {
  const { run: exec, isMac } = useApp();
  const r = run.result;
  if (!r && !run.error) return null;
  const n = kept(run);
  const turn = run.turn;
  return (
    <div className="run-result live" data-testid="agent-result" data-result={r?.status ?? "failed"}>
      {r?.quota && (
        <p className="run-quota" data-testid="agent-quota" data-kind={r.quota.kind}>
          <Icon.Warning size={12} /> {r.quota.kind === "quota_exhausted" ? "Your plan's usage limit is reached." : "The provider is rate limiting requests."}
          {r.quota.resetsAt ? ` It resets ${resetTime(r.quota.resetsAt)}.` : " Try again later."}
        </p>
      )}
      {r && r.status !== "answered" && <p className="run-summary">{r.summary}</p>}
      {r && r.assumptions.length > 0 && (
        <div className="assumptions" aria-label="Assumptions">
          {r.assumptions.map((a) => (
            <span key={a} className="assumption-chip" title="A value the agent chose">
              {a}
            </span>
          ))}
        </div>
      )}
      {r && r.knownIssues.length > 0 && (
        <ul className="known-issues">
          {r.knownIssues.map((k) => (
            <li key={k}>
              <Icon.Warning size={12} /> {k}
            </li>
          ))}
        </ul>
      )}
      <div className="run-facts muted">
        {r?.verified ? "checked by Forge" : n > 0 ? "not fully checked" : ""}
        {r ? ` · ${r.turns} turn${r.turns === 1 ? "" : "s"}` : ""}
      </div>
      {turn && turn.kept && (
        <div className="run-review" data-testid="agent-turn">
          {turn.resolution === null && (
            <>
              <span className="muted small">
                {n} step{n === 1 ? "" : "s"} · one undo step{run.autonomy === "auto" ? "" : " · review it in the viewport"}
              </span>
              <span className="spacer" />
              <button type="button" className="ghost-btn" data-testid="agent-undo-turn" onClick={() => exec({ id: "agent.undoTurn", args: { runId: run.runId } })}>
                Undo turn
              </button>
              <button type="button" className="primary-btn small" data-testid="agent-keep" title="Make these features yours: they lose the AI mark" onClick={() => exec({ id: "agent.keep", args: { runId: run.runId } })}>
                Keep
              </button>
            </>
          )}
          {turn.resolution === "kept" && (
            <span className="resolution resolution-accepted" data-testid="agent-resolution">
              Kept · the features are yours · undo with {isMac ? "⌘Z" : "Ctrl+Z"}
            </span>
          )}
          {turn.resolution === "undone" && (
            <span className="resolution resolution-rejected" data-testid="agent-resolution">
              Undone — the model is back as before the turn.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function headline(run: AgentRun): string {
  if (run.surface === "ops") return liveHeadline(run);
  if (run.status === "failed") return "Failed";
  if (run.status === "question") return "Waiting for your answer";
  if (run.status === "running") {
    const s = stepsOf(run).find((x) => x.state === "active");
    return s ? `${s.label}…` : "Starting…";
  }
  const r = run.result!;
  if (r.status === "proposed") return r.changed ? "Proposal ready" : "Done — no changes";
  if (r.status === "answered") return "Answered";
  if (r.quota) return r.quota.kind === "quota_exhausted" ? "Stopped: plan usage limit reached" : "Stopped: rate limited";
  return STOP_LABEL[r.stopReason] ?? `Stopped (${r.stopReason})`;
}

/** A reset time for people: local date and time (the ISO string when it does not parse). */
function resetTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

function ResultBlock({ run }: { run: AgentRun }): ReactElement | null {
  const { services, run: exec, isMac } = useApp();
  const review = useStore(services.agent, (s) => (s.review?.runId === run.runId ? s.review : null));
  const r = run.result;
  if (!r) return null;
  const pending = review && review.status === "ready" && review.resolution === null;
  return (
    <div className="run-result" data-testid="agent-result" data-result={r.status}>
      {r.quota && (
        <p className="run-quota" data-testid="agent-quota" data-kind={r.quota.kind}>
          <Icon.Warning size={12} />{" "}
          {r.quota.kind === "quota_exhausted" ? "Your plan's usage limit is reached." : "The provider is rate limiting requests."}
          {r.quota.resetsAt ? ` It resets ${resetTime(r.quota.resetsAt)}.` : " Try again later."}
        </p>
      )}
      {r.status !== "answered" && <p className="run-summary">{r.summary}</p>}
      {r.assumptions.length > 0 && (
        <div className="assumptions" aria-label="Assumptions">
          {r.assumptions.map((a) => (
            <span key={a} className="assumption-chip" title="An assumption the agent made (edit the value in the code to change it)">
              {a}
            </span>
          ))}
        </div>
      )}
      {r.knownIssues.length > 0 && (
        <ul className="known-issues">
          {r.knownIssues.map((k) => (
            <li key={k}>
              <Icon.Warning size={12} /> {k}
            </li>
          ))}
        </ul>
      )}
      <div className="run-facts muted">
        {r.verified ? "verified L0–L2" : "not verified"}
        {r.tests ? ` · spec tests ${r.tests.passed}/${r.tests.total}` : ""} · {r.turns} turn{r.turns === 1 ? "" : "s"}
      </div>
      {r.changed && review && (
        <div className="run-review">
          {review.status === "preparing" && (
            <span className="muted">
              <Icon.Spinner size={12} /> Preparing the diff…
            </span>
          )}
          {pending && (
            <>
              <button type="button" className="ghost-btn" data-testid="agent-review" onClick={() => exec({ id: "agent.showProposal", args: { visible: true } })}>
                <Icon.Diff size={13} /> Review diff ({review.changes.length})
              </button>
              <span className="spacer" />
              <button type="button" className="ghost-btn" onClick={() => exec({ id: "agent.reject" })}>
                Reject
              </button>
              <button type="button" className="primary-btn small" onClick={() => exec({ id: "agent.accept", args: {} })}>
                Accept
              </button>
            </>
          )}
          {review.resolution && (
            <span className={`resolution resolution-${review.resolution.kind}`} data-testid="agent-resolution">
              {review.resolution.kind === "rejected"
                ? "Rejected — the document is unchanged."
                : `${review.resolution.kind === "partial" ? `Applied ${review.resolution.applied} of ${review.resolution.total} changes` : "Applied"} · undo with ${isMac ? "⌘Z" : "Ctrl+Z"}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function RunCard({ runId }: { runId: string }): ReactElement | null {
  const { services, run: exec } = useApp();
  const run = useStore(services.agent, (s) => s.runs.find((r) => r.runId === runId));
  const [now, setNow] = useState(() => Date.now());
  const started = useRef(Date.now());
  const live = run?.status === "running" || run?.status === "question";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [live]);
  if (!run) return null;
  const elapsed = live ? Math.max(run.elapsedMs, now - started.current) : run.elapsedMs;
  const steps = stepsOf(run);
  const designer = run.models["designer"];
  return (
    <div className={`run-card run-${run.status}`} data-testid="agent-run" data-run={run.runId} data-status={run.status}>
      <header className="run-head">
        {live ? <Icon.Spinner size={13} /> : run.status === "failed" ? <Icon.Error size={13} /> : <Icon.Sparkle size={13} />}
        <span className="run-headline" data-testid="agent-headline">
          {headline(run)}
        </span>
        <span className="run-time mono">{(elapsed / 1000).toFixed(1)} s</span>
        {live && (
          <button type="button" className="stop-btn" data-testid="agent-stop" title="Stop the agent (⌘.)" onClick={() => exec({ id: "agent.stop" })}>
            <Icon.Stop size={12} /> Stop
          </button>
        )}
      </header>
      {run.surface === "ops" ? (
        <LiveSteps run={run} />
      ) : (
        <ol className="run-steps" data-testid="agent-progress">
          {steps.map((s) => (
            <li key={s.id} className={`step step-${s.state}`} data-step={s.id} data-state={s.state}>
              <span className="step-mark" aria-hidden="true">
                {s.state === "done" ? <Icon.Check size={11} /> : s.state === "active" ? <Icon.Spinner size={11} /> : s.state === "failed" ? <Icon.Close size={10} /> : null}
              </span>
              <span className="step-label">{s.label}</span>
              {s.detail && <span className="step-detail mono">{s.detail}</span>}
            </li>
          ))}
        </ol>
      )}
      <div className="run-meta">
        <CostMeter spent={run.spentUsd} budget={run.budgetUsd} notional={run.notional === true} />
        <span className="run-model muted" title={Object.entries(run.models).map(([k, v]) => `${k}: ${v?.name ?? "?"}`).join("\n")}>
          {designer?.name ?? ""}
          {run.transport && run.transport !== "live" ? ` · ${run.transport}` : ""}
        </span>
      </div>
      {(run.notional === true || (run.planUsage?.windows.length ?? 0) > 0) && (
        <div className="run-plan muted small" data-testid="agent-plan-note" title="Plan usage the CLI reported during this run">
          {run.notional === true ? "(API list price; not billed)" : ""}
          {run.notional === true && run.planUsage && run.planUsage.windows.length > 0 ? " · " : ""}
          {run.planUsage && run.planUsage.windows.length > 0 && (
            <span data-testid="agent-plan-usage">
              Plan: {run.planUsage.windows.map((w) => `${w.label} ${w.utilization === null ? "?" : `${Math.round(w.utilization * 100)} %`}`).join(" · ")}
              {run.planUsage.status === "rejected" ? " · limit reached" : ""}
            </span>
          )}
        </div>
      )}
      {run.question && <QuestionCard key={run.question.questionId} {...run.question} />}
      {run.error && (
        <div className="run-error" data-testid="agent-error">
          <Icon.Error size={12} /> {run.error.message}
        </div>
      )}
      {run.surface === "ops" ? <LiveResult run={run} /> : <ResultBlock run={run} />}
      {run.activity.length > 0 && (
        <details className="run-log">
          <summary>Activity ({run.activity.length})</summary>
          <ul>
            {run.activity.slice(-40).map((a) => (
              <li key={a.id} className={`log-${a.kind}${a.ok === false ? " log-err" : ""}`}>
                <span className="log-t mono">{(a.t / 1000).toFixed(1)}s</span> {a.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ─── Panel ───────────────────────────────────────────────────────────────────────────────

function Message({ m }: { m: ChatMessage }): ReactElement {
  const { run } = useApp();
  if (m.role === "agent" && m.runId) return <RunCard runId={m.runId} />;
  return (
    <div className={`msg msg-${m.role}${m.tone === "error" ? " msg-error" : ""}`}>
      {m.chips.length > 0 && (
        <div className="msg-chips">
          {m.chips.map((c) => (
            <span key={`${c.kind}:${c.ref}`} className={`chip chip-${c.kind}`}>
              {c.kind}: {c.label}
            </span>
          ))}
        </div>
      )}
      <div className="msg-text">{m.text}</div>
      {m.action && (
        <button type="button" className="ghost-btn msg-action" onClick={() => run({ id: m.action!.command } as AppInvocation)}>
          {m.action.label}
        </button>
      )}
    </div>
  );
}

export function ChatPanel(): ReactElement {
  const { services, run, isMac } = useApp();
  const messages = useStore(services.ui, (s) => s.chat);
  const focusTick = useStore(services.ui, (s) => s.chatFocusTick);
  const available = useStore(services.agent, (s) => s.available);
  const activeRunId = useStore(services.agent, (s) => s.activeRunId);
  const reviewPending = useStore(services.agent, (s) => !!s.review && s.review.status === "ready" && s.review.resolution === null);
  const chips = useSelectionChips();
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // New selection → all chips included again.
  useEffect(() => setExcluded(new Set()), [chips]);
  useEffect(() => {
    if (focusTick > 0) inputRef.current?.focus();
  }, [focusTick]);
  const runs = useStore(services.agent, (s) => s.runs);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, runs]);

  const busy = activeRunId !== null;
  const activeChips = chips.filter((c) => !excluded.has(`${c.kind}:${c.ref}`));
  const blocked = busy ? "The agent is working — stop it to send a new request" : reviewPending ? "Accept or reject the proposal first" : null;
  const send = (): void => {
    const text = draft.trim();
    if (!text || blocked) return;
    run({ id: "chat.send", args: { text, chips: activeChips } });
    setDraft("");
  };

  let state = "ready";
  if (!available) state = "desktop app only";
  else if (busy) state = "working";
  else if (reviewPending) state = "proposal to review";

  return (
    <section className="panel chat" aria-label="Chat">
      <header className="panel-header">
        <Icon.Sparkle size={14} />
        <span className="panel-title">Assistant</span>
        <span className={`agent-state state-${state.replace(/\s+/g, "-")}`} data-testid="agent-state">
          <span className="dot" /> {state}
        </span>
        <AutonomyDial />
        {available && (
          <button type="button" className="icon-btn" aria-label="Agent settings" title="Agent settings (models, CLI agents, local models, API keys, budget)" onClick={() => run({ id: "settings.open" })}>
            <Icon.Gear size={13} />
          </button>
        )}
      </header>
      <div className="panel-body chat-list" ref={listRef} aria-live="polite">
        {messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
      </div>
      <div className="chat-compose">
        {activeChips.length > 0 && (
          <div className="compose-chips" aria-label="Context from selection">
            {activeChips.map((c) => (
              <span key={`${c.kind}:${c.ref}`} className={`chip chip-${c.kind}`}>
                <span className="chip-kind">{c.kind}</span> {c.label}
                <button type="button" aria-label={`Remove ${c.label}`} onClick={() => setExcluded(new Set([...excluded, `${c.kind}:${c.ref}`]))}>
                  <Icon.Close size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="compose-row">
          <textarea
            ref={inputRef}
            value={draft}
            rows={2}
            placeholder={`Describe a change… (${isMac ? "⌘" : "Ctrl+"}L to focus)`}
            aria-label="Message"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button type="button" className="send-btn" onClick={send} disabled={!draft.trim() || !!blocked} aria-label="Send" title={blocked ?? "Send (Enter)"}>
            <Icon.Send size={14} />
          </button>
        </div>
      </div>
    </section>
  );
}
