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
 * **The commit check** (ADR 0015 §3). An agent, MCP or CLI transaction that changes, removes,
 * moves or recolours a user-authored feature, makes one newly fail, changes or removes an existing
 * parameter (parameters have no author: every existing one is yours), or moves the rollback marker,
 * without a matching approval is refused with `unapproved_user_change`. Such a transaction's `ack`
 * accepts newly failing features of its own only. Your own edits skip the check.
 */
import type { metricsV1 } from "@aicad/ir-types";
import { isAgentAuthored, needsApproval, type HostState, type OpOrigin, type Touched } from "./apply.js";
import { allFeatures, allParams, jsonEqual, parseDoc, type DocJson, type FeatureJson } from "./doc.js";
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
  /**
   * Who issued the transaction, and the document it started from: an agent, MCP or CLI
   * transaction may acknowledge only its own features' failures; one that makes a user-authored
   * feature newly fail needs the user's approval of that feature (`unapproved_user_change`).
   */
  origin?: OpOrigin | undefined;
  base?: string | undefined;
  approvals?: Approvals | undefined;
}

/** Throws the failure rule's refusal, or returns the (acknowledged) newly failing features. */
export function checkFailureRule({ before, after, touched, ack, origin, base, approvals }: FailureRuleInput): NewFailure[] {
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
  // Before the ack: an agent cannot acknowledge breaking your features (ADR 0015 §3, §5.7).
  if (origin !== undefined && base !== undefined) checkNewFailureAuthors(fresh, base, origin, approvals);
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

/**
 * What an agent, MCP or CLI transaction may change of yours (ADR 0015 §3): the feature ids and
 * names and the parameter names you approved, and whether you approved moving the rollback marker.
 * Only host code passes approvals (your accept, your answer to the agent's question); an agent's own
 * `ack` never approves anything of yours.
 */
export interface Approvals {
  features?: readonly string[];
  params?: readonly string[];
  /** You approved the transaction's `setRollback` (the marker hides what you built after it). */
  rollback?: boolean;
}

/** How a transaction touched one of your features without your approval. */
export type UserFeatureChange = "changed" | "removed" | "moved" | "recoloured" | "fails";

export interface UnapprovedFeature {
  id: string;
  name: string;
  change: UserFeatureChange;
  /** For `fails`: the failure's code. */
  code?: string;
}

export interface UnapprovedParam {
  name: string;
  change: "changed" | "removed";
}

function refuseUnapproved(origin: OpOrigin, features: UnapprovedFeature[], params: UnapprovedParam[], rollback: { from: string | null; to: string | null } | null): never {
  const what = [
    ...features.map((f) => `${f.name} (${f.change === "fails" ? `would fail: ${f.code ?? "FAILED"}` : f.change})`),
    ...params.map((p) => `parameter ${p.name} (${p.change})`),
    ...(rollback ? [`the rollback marker (${rollback.from ?? "end"} → ${rollback.to ?? "end"})`] : []),
  ].join(", ");
  const fails = features.some((f) => f.change === "fails");
  throw new CommandEngineError(
    "unapproved_user_change",
    `this ${origin} edit changes what the user made without their approval: ${what}. ` +
      (fails ? "An acknowledgement (ack) accepts failures of your own features only; breaking the user's features needs their approval. " : "") +
      "Ask the user first; their approval of these features lets the edit through.",
    [],
    { origin, features, params, ...(rollback ? { rollback } : {}) },
  );
}

/**
 * The newly failing features an agent, MCP or CLI transaction may not break on its own (ADR 0015
 * §3, §5.7): the user-authored ones (by their authorship in `base`) you did not approve. Throws
 * `unapproved_user_change` listing them (change `fails`), whatever the transaction's `ack` says.
 */
export function checkNewFailureAuthors(fresh: readonly NewFailure[], base: string, origin: OpOrigin, approvals: Approvals = {}): void {
  if (!needsApproval(origin) || fresh.length === 0) return;
  const ok = new Set(approvals.features ?? []);
  const byId = new Map(allFeatures(parseDoc(base)).map((f) => [f.id, f]));
  const users = fresh.filter((n) => {
    const f = byId.get(n.id);
    return f !== undefined && !isAgentAuthored(f) && !ok.has(f.id) && !ok.has(f.name);
  });
  if (users.length === 0) return;
  refuseUnapproved(
    origin,
    users.map((n) => ({ id: n.id, name: byId.get(n.id)!.name, change: "fails", code: n.code })),
    [],
    null,
  );
}

/** The longest common subsequence of two id lists (the features that kept their relative order). */
function keptOrder(a: readonly string[], b: readonly string[]): Set<string> {
  const n = a.length;
  const m = b.length;
  const len: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) len[i]![j] = a[i] === b[j] ? len[i + 1]![j + 1]! + 1 : Math.max(len[i + 1]![j]!, len[i]![j + 1]!);
  }
  const kept = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      kept.add(a[i]!);
      i++;
      j++;
    } else if (len[i + 1]![j]! >= len[i]![j + 1]!) i++;
    else j++;
  }
  return kept;
}

export interface ApprovalCheck {
  /** The documents before and after the transaction's own ops (before the automatic write-back, which follows from approved edits). */
  base: string;
  after: string;
  origin: OpOrigin;
  approvals?: Approvals | undefined;
  /** The host state before and after the transaction (appearance of your features is yours too). */
  baseHost?: HostState | undefined;
  afterHost?: HostState | undefined;
  /** The rollback marker's move by the transaction's own `setRollback` ops, if they moved it. */
  rollback?: { from: string | null; to: string | null } | null | undefined;
}

/**
 * ADR 0015's commit check: throws `unapproved_user_change` when a transaction from an agent, MCP
 * or the CLI touched what you made without your approval. It counts as touching:
 * - changing or removing one of your features (its JSON), or moving it (the relative order of your
 *   features, per part, changed: a reorder changes what each builds on, although no JSON does);
 * - recolouring one of your features (the host state's appearance);
 * - changing or removing an existing parameter (parameters have no author: every one is yours
 *   unless the approvals list it, e.g. one this agent session added itself);
 * - moving the rollback marker with `setRollback` (a new feature placed at the marker moves it
 *   past itself; that is not a `setRollback`).
 */
export function checkApprovals(c: ApprovalCheck): void {
  const { base, after, origin } = c;
  const approvals = c.approvals ?? {};
  if (!needsApproval(origin)) return;
  const b = parseDoc(base);
  const a = base === after ? b : parseDoc(after);
  const okFeatures = new Set(approvals.features ?? []);
  const okParams = new Set(approvals.params ?? []);
  const approved = (f: FeatureJson) => okFeatures.has(f.id) || okFeatures.has(f.name);
  const afterFeatures = new Map(allFeatures(a).map((f) => [f.id, f]));
  const features: UnapprovedFeature[] = [];
  const reported = new Set<string>();
  const report = (f: FeatureJson, change: UserFeatureChange) => {
    if (reported.has(f.id)) return;
    reported.add(f.id);
    features.push({ id: f.id, name: f.name, change });
  };
  const userIds = new Set<string>();
  for (const f of allFeatures(b)) {
    if (isAgentAuthored(f)) continue;
    userIds.add(f.id);
    if (approved(f)) continue;
    const g = afterFeatures.get(f.id);
    if (!g) report(f, "removed");
    else if (!jsonEqual(f, g)) report(f, "changed");
  }
  // Moves: your features that left their part, or lost their place among your features.
  if (base !== after) {
    const partOf = (d: DocJson) => new Map(d.parts.flatMap((p) => p.features.map((f) => [f.id, p.id] as const)));
    const partBefore = partOf(b);
    const partAfter = partOf(a);
    const baseById = new Map(allFeatures(b).map((f) => [f.id, f]));
    for (const p of b.parts) {
      const q = a.parts.find((x) => x.id === p.id);
      const stays = (id: string) => userIds.has(id) && partAfter.get(id) === p.id;
      const before = p.features.map((f) => f.id).filter(stays);
      const now = (q?.features ?? []).map((f) => f.id).filter((id) => stays(id) && partBefore.get(id) === p.id);
      const kept = keptOrder(before, now);
      for (const id of before) if (!kept.has(id) && !approved(baseById.get(id)!)) report(baseById.get(id)!, "moved");
    }
    for (const [id, part] of partBefore) {
      const moved = partAfter.get(id);
      const f = baseById.get(id)!;
      if (userIds.has(id) && moved !== undefined && moved !== part && !approved(f)) report(f, "moved");
    }
  }
  // Appearance: the colour of your features' bodies.
  if (c.baseHost && c.afterHost) {
    for (const f of allFeatures(b)) {
      if (!userIds.has(f.id) || approved(f) || !afterFeatures.has(f.id)) continue;
      if ((c.baseHost.appearance[f.id] ?? null) !== (c.afterHost.appearance[f.id] ?? null)) report(f, "recoloured");
    }
  }
  const params: UnapprovedParam[] = [];
  if (base !== after) {
    const afterParams = new Map(allParams(a).map((l) => [String(l.param["name"]), l.param]));
    for (const l of allParams(b)) {
      const name = String(l.param["name"]);
      if (okParams.has(name)) continue;
      const q = afterParams.get(name);
      if (!q) params.push({ name, change: "removed" });
      else if (!jsonEqual(l.param, q)) params.push({ name, change: "changed" });
    }
  }
  const rollback = c.rollback && !approvals.rollback ? c.rollback : null;
  if (features.length === 0 && params.length === 0 && !rollback) return;
  refuseUnapproved(origin, features, params, rollback);
}
