/**
 * The two checks every transaction passes before it commits, whoever issued it.
 *
 * **The failure rule** (FULL-MODELING-PLAN §2.2, ADR 0021; C1). SPEC-v1 §7.1 lets a failed feature
 * pass its input through while later features still run, so an edit could quietly break the rest
 * of the timeline. The store evaluates the candidate document first:
 * 1. The edited thing must build: a feature the transaction added or edited that fails is refused
 *    with `COMMAND_FEATURE_FAILS` (its code, message and details); a parameter it added or set must
 *    evaluate (`COMMAND_PARAM_FAILS`). A feature or parameter that already failed before the
 *    transaction may still fail after it (you can edit a broken feature step by step).
 * 2. Features that were ok before and fail after ("newly failing") need an acknowledgement: the
 *    transaction is refused with `COMMAND_NEW_FAILURES` (their ids and codes) unless its `ack` lists
 *    exactly those features ("Apply anyway").
 *
 * **The commit check** (ADR 0015 §3). An agent, MCP or CLI transaction that changes or removes a
 * user-authored feature, or changes or removes an existing parameter (parameters have no author:
 * every existing one is yours), without a matching approval is refused with
 * `unapproved_user_change`. Your own edits skip it.
 */
import type { metricsV1 } from "@aicad/ir-types";
import { isAgentAuthored, needsApproval, type OpOrigin, type Touched } from "./apply.js";
import { allFeatures, allParams, jsonEqual, parseDoc } from "./doc.js";
import { CommandEngineError } from "./engine.js";

export interface NewFailure {
  id: string;
  name: string;
  code: string;
  message: string;
}

/** Features that fail in `after` but were ok in `before` (and are not in `except`). */
export function newlyFailing(before: metricsV1.EvalReport, after: metricsV1.EvalReport, except: ReadonlySet<string> = new Set()): NewFailure[] {
  const ok = new Set(before.features.filter((f) => f.status === "ok").map((f) => f.feature_id));
  return after.features
    .filter((f) => f.status === "error" && ok.has(f.feature_id) && !except.has(f.feature_id))
    .map((f) => ({ id: f.feature_id, name: f.feature, code: f.error?.code ?? "FAILED", message: f.error?.message ?? "fails" }));
}

export interface FailureRuleInput {
  before: metricsV1.EvalReport;
  after: metricsV1.EvalReport;
  touched: Touched;
  /** The acknowledged newly failing feature ids ("Apply anyway"). */
  ack?: readonly string[] | undefined;
}

/** Throws the failure rule's refusal, or returns the (acknowledged) newly failing features. */
export function checkFailureRule({ before, after, touched, ack }: FailureRuleInput): NewFailure[] {
  const failedBefore = new Set(before.features.filter((f) => f.status === "error").map((f) => f.feature_id));
  const suppressed = new Set(touched.suppressed);
  for (const id of new Set(touched.features)) {
    if (suppressed.has(id)) continue;
    const f = after.features.find((x) => x.feature_id === id);
    if (!f || f.status !== "error" || failedBefore.has(id)) continue;
    const err = f.error;
    throw new CommandEngineError(
      "COMMAND_FEATURE_FAILS",
      `${f.feature} would fail: ${err?.code ?? "FAILED"}${err?.message ? ` — ${err.message}` : ""}`,
      [],
      { feature: id, name: f.feature, type: f.type, code: err?.code ?? "FAILED", message: err?.message ?? "", details: err?.details ?? {} },
    );
  }
  const paramsFailedBefore = new Set((before.params ?? []).filter((p) => p.error).map((p) => p.name));
  for (const name of new Set(touched.params)) {
    const p = (after.params ?? []).find((x) => x.name === name);
    if (!p?.error || paramsFailedBefore.has(name)) continue;
    throw new CommandEngineError("COMMAND_PARAM_FAILS", `parameter ${name} would fail: ${p.error.code} — ${p.error.message}`, [], {
      param: name,
      code: p.error.code,
      message: p.error.message,
      details: p.error.details ?? {},
    });
  }
  const fresh = newlyFailing(before, after, new Set([...touched.features, ...touched.suppressed]));
  if (fresh.length === 0) return [];
  const want = [...new Set(fresh.map((f) => f.id))].sort();
  const got = [...new Set(ack ?? [])].sort();
  if (want.length !== got.length || want.some((id, i) => got[i] !== id)) {
    throw new CommandEngineError(
      "COMMAND_NEW_FAILURES",
      `${fresh.length} feature${fresh.length === 1 ? "" : "s"} will newly fail: ${fresh.map((f) => `${f.name} (${f.code})`).join(", ")}. ` +
        "Apply anyway by acknowledging exactly these features (ack), or change the edit.",
      [],
      { features: fresh, ack: got },
    );
  }
  return fresh;
}

/** What an agent, MCP or CLI transaction may change of yours (ADR 0015 §3): the ids and names you approved. */
export interface Approvals {
  features?: readonly string[];
  params?: readonly string[];
}

/**
 * ADR 0015's commit check: throws `unapproved_user_change` when a transaction from an agent, MCP
 * or the CLI changed or removed one of your features or parameters without your approval.
 * `base` and `after` are the documents before and after the transaction's own ops (before the
 * automatic write-back, which follows from approved edits).
 */
export function checkApprovals(base: string, after: string, origin: OpOrigin, approvals: Approvals = {}): void {
  if (!needsApproval(origin) || base === after) return;
  const b = parseDoc(base);
  const a = parseDoc(after);
  const okFeatures = new Set(approvals.features ?? []);
  const okParams = new Set(approvals.params ?? []);
  const afterFeatures = new Map(allFeatures(a).map((f) => [f.id, f]));
  const features: Array<{ id: string; name: string; change: "changed" | "removed" }> = [];
  for (const f of allFeatures(b)) {
    if (isAgentAuthored(f) || okFeatures.has(f.id) || okFeatures.has(f.name)) continue;
    const g = afterFeatures.get(f.id);
    if (!g) features.push({ id: f.id, name: f.name, change: "removed" });
    else if (!jsonEqual(f, g)) features.push({ id: f.id, name: f.name, change: "changed" });
  }
  const afterParams = new Map(allParams(a).map((l) => [String(l.param["name"]), l.param]));
  const params: Array<{ name: string; change: "changed" | "removed" }> = [];
  for (const l of allParams(b)) {
    const name = String(l.param["name"]);
    if (okParams.has(name)) continue;
    const q = afterParams.get(name);
    if (!q) params.push({ name, change: "removed" });
    else if (!jsonEqual(l.param, q)) params.push({ name, change: "changed" });
  }
  if (features.length === 0 && params.length === 0) return;
  const what = [...features.map((f) => `${f.name} (${f.change})`), ...params.map((p) => `parameter ${p.name} (${p.change})`)].join(", ");
  throw new CommandEngineError(
    "unapproved_user_change",
    `this ${origin} edit changes what the user made without their approval: ${what}. Ask the user first; their approval of these features lets the edit through.`,
    [],
    { origin, features, params },
  );
}
