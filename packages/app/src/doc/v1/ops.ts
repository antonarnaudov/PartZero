/**
 * The IR v1 domain ops of the command layer (SPEC-v1 §0.6, §5.9, §9.2; interface I7). The UI,
 * the agent (W10), the CLI and MCP issue the same ops; the {@link IrDocStore} applies them as
 * undoable transactions.
 *
 * | Op | Effect | Semantic inverse |
 * |---|---|---|
 * | `setParam` | a parameter's value (literal, or an expression stored canonically) | `setParam` with the previous value |
 * | `writeBackSolution` | the solved geometry of constrained sketches (§4.4 rule 9), to its fixed point | — (the recorded inverse edit) |
 * | `captureRef` | a reference's capture, exactly its current resolution (§5.6); refused for a failing reference (`COMMAND_REF_FAILED`, `details` = its report entry) or a member only the geometric fallback repaired (`COMMAND_REF_REPAIRED`: accept the proposal) | — |
 * | `acceptRefCandidate` | a reference's query ← a repair candidate's query, capture refreshed; with the candidate's `probe`, refused (`COMMAND_CANDIDATE_CHANGED`) when the candidate is no longer that entity | — |
 * | `acceptRefProposal` | a reference ← its `proposal` (query and fresh capture, §5.8) | — |
 * | `renameCurve` | a curve id and every query, region, hole point, constraint and capture key naming it; `result.unverified` lists rewritten captures of references the engine did not resolve (their feature fails upstream) | `renameCurve` back |
 * | `renameFeature` | a feature's name (references use ids) | `renameFeature` back |
 * | `upgradeFeature` | a feature's behavior version `v`, with the report diff (§9.2); applied only with the `confirm` of that diff | — |
 *
 * Every op is **exactly** undoable: a transaction records the canonical document before and
 * after and undoes by restoring it (the "recorded inverse"), whatever the op. Where a semantic
 * inverse op exists it is returned too (for transcripts and the agent), and the tests check it
 * restores the same bytes. The engine reads and writes canonical text (every expression stored
 * canonically, SPEC-v1 §2.4), and the store holds canonical text, so those bytes are canonical.
 *
 * §9.2 "upgradeFeature shows the report diff before it is applied": an upgrade that changes the
 * document is applied only with `confirm`, the token of the diff the caller was shown — returned
 * by a preview ({@link IrDocStore.preview}, `ir.upgradeFeature` with `preview: true`) and by the
 * refusal of an unconfirmed upgrade (`COMMAND_UPGRADE_UNCONFIRMED`, whose `details` carry the
 * diff). A token of another diff (the document changed since the preview) is refused the same
 * way, with the new diff.
 */
import { metricsV1 } from "@aicad/ir-types";
import { z } from "zod";
import {
  CommandEngineError,
  requireCommandEngine,
  type EditResult,
  type IrCommandEngine,
  type ParamValueInput,
  type UpgradeFeatureResult,
} from "./command-engine";

const Id = z.string().min(1).max(200);
/** A Ref's JSON pointer relative to its feature (the report's `refs[].field`). */
const Field = z.string().regex(/^\/[A-Za-z0-9_/]*$/, "a JSON pointer relative to the feature, e.g. /target").max(200);
const Key = z.string().max(2048);

export const SetParamOp = z.strictObject({
  op: z.literal("setParam"),
  name: Id,
  value: z.union([z.number().finite(), z.boolean(), z.string().min(1).max(4096)]),
});
export const WriteBackSolutionOp = z.strictObject({
  op: z.literal("writeBackSolution"),
  /** Sketch ids; default every constrained sketch. */
  sketches: z.array(Id).max(1000).optional(),
});
export const CaptureRefOp = z.strictObject({ op: z.literal("captureRef"), feature: Id, field: Field });
export const AcceptRefCandidateOp = z.strictObject({
  op: z.literal("acceptRefCandidate"),
  feature: Id,
  field: Field,
  /** The unresolved member's key (`""` for a reference without a capture). */
  member: Key,
  candidate: Key,
  /** The candidate's position in the member's candidates (split pieces share a key). */
  candidateIndex: z.number().int().min(0).max(1000).optional(),
  /**
   * The candidate's probe as read from the report: the engine refuses the op
   * (`COMMAND_CANDIDATE_CHANGED`) when the chosen candidate is no longer that entity — e.g. after
   * the write-back the store runs before a repair moved or reordered the pieces. Required with
   * `candidateIndex` when that write-back changed the document.
   */
  probe: metricsV1.ProbeSchema.optional(),
});
export const AcceptRefProposalOp = z.strictObject({ op: z.literal("acceptRefProposal"), feature: Id, field: Field });
export const RenameCurveOp = z.strictObject({ op: z.literal("renameCurve"), sketch: Id, old: Id, new: Id });
export const RenameFeatureOp = z.strictObject({ op: z.literal("renameFeature"), feature: Id, name: Id });
export const UpgradeFeatureOp = z.strictObject({
  op: z.literal("upgradeFeature"),
  feature: Id,
  /** Default: the newest version the contract defines for the feature's type. */
  to: z.number().int().min(1).max(1_000_000).optional(),
  /** The `confirm` token of the diff the caller reviewed (from a preview); required when the upgrade changes the document. */
  confirm: z.string().max(200).optional(),
});

/** Every op, validated (the command layer validates whoever the caller is). */
export const IrOpSchema = z.discriminatedUnion("op", [
  SetParamOp,
  WriteBackSolutionOp,
  CaptureRefOp,
  AcceptRefCandidateOp,
  AcceptRefProposalOp,
  RenameCurveOp,
  RenameFeatureOp,
  UpgradeFeatureOp,
]);

export type IrOp = z.infer<typeof IrOpSchema>;
export type IrOpName = IrOp["op"];

/** The outcome of one op on a document. */
export interface OpOutcome {
  op: IrOp;
  /** The canonical `aicad.ir/1` text after the op. */
  document: string;
  changed: boolean;
  /** The engine's result (previous values, captures, candidates, report diff, …). */
  result: unknown;
  /** The op that undoes this one semantically, when there is one (the store always undoes exactly). */
  inverse: IrOp | null;
  /** A short human-readable label (undo menu, transcripts). */
  label: string;
}

/** A short label for an op (`Set width = 80`, `Rename curve top → rim`, …). */
export function opLabel(op: IrOp): string {
  switch (op.op) {
    case "setParam":
      return `Set ${op.name} = ${typeof op.value === "string" ? op.value : String(op.value)}`;
    case "writeBackSolution":
      return op.sketches ? `Write back ${op.sketches.join(", ")}` : "Write back sketch solutions";
    case "captureRef":
      return `Capture reference ${op.feature}${op.field}`;
    case "acceptRefCandidate":
      return `Repair reference ${op.feature}${op.field}`;
    case "acceptRefProposal":
      return `Accept proposal for ${op.feature}${op.field}`;
    case "renameCurve":
      return `Rename curve ${op.old} → ${op.new}`;
    case "renameFeature":
      return `Rename feature to ${op.name}`;
    case "upgradeFeature":
      return `Upgrade ${op.feature}${op.to !== undefined ? ` to v${op.to}` : ""}`;
  }
}

function outcome(op: IrOp, r: EditResult<unknown>, inverse: IrOp | null): OpOutcome {
  return { op, document: r.document, changed: r.changed, result: r.result, inverse: r.changed ? inverse : null, label: opLabel(op) };
}

/** A 64-bit digest of a text (hex): the diff binding of an upgrade's `confirm` token (not a security measure). */
function digest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** The `confirm` token of an upgrade's result: its feature, versions and report diff. */
export function upgradeConfirmation(r: UpgradeFeatureResult): string {
  return `v${r.from}-v${r.to}-${digest(JSON.stringify([r.feature, r.from, r.to, r.diff]))}`;
}

export interface ApplyOptions {
  /** Compute the op's outcome for review only (an upgrade then needs no `confirm`). */
  preview?: boolean;
}

/**
 * Apply one op to `document` (either IR version; the result is canonical `aicad.ir/1` text).
 * Throws a `CommandEngineError` when the engine refuses it (the document's rejection or a
 * `COMMAND_*` refusal), or when an upgrade that changes the document lacks the `confirm` of its
 * diff (`COMMAND_UPGRADE_UNCONFIRMED`); never returns a document that failed the engine's
 * verification.
 */
export async function applyOp(
  engine: IrCommandEngine | null | undefined,
  document: string,
  op: IrOp,
  options: ApplyOptions = {},
): Promise<OpOutcome> {
  const e = requireCommandEngine(engine);
  switch (op.op) {
    case "setParam": {
      const r = await e.setParam(document, op.name, op.value);
      return outcome(op, r, { op: "setParam", name: op.name, value: r.result.previous });
    }
    case "writeBackSolution": {
      // The engine iterates to the fixed point ([W0-31]), so a second write-back changes nothing.
      const r = await e.writeBack(document, op.sketches);
      const { document: text, ...result } = r;
      return outcome(op, { document: text, changed: r.changed, result }, null);
    }
    case "captureRef":
      return outcome(op, await e.captureRef(document, op.feature, op.field), null);
    case "acceptRefCandidate": {
      return outcome(op, await e.acceptRefCandidate(document, op.feature, op.field, op.member, op.candidate, op.candidateIndex, op.probe), null);
    }
    case "acceptRefProposal":
      return outcome(op, await e.acceptRefProposal(document, op.feature, op.field), null);
    case "renameCurve":
      return outcome(op, await e.renameCurve(document, op.sketch, op.old, op.new), {
        op: "renameCurve",
        sketch: op.sketch,
        old: op.new,
        new: op.old,
      });
    case "renameFeature": {
      const r = await e.renameFeature(document, op.feature, op.name);
      return outcome(op, r, { op: "renameFeature", feature: op.feature, name: r.result.previous });
    }
    case "upgradeFeature": {
      const r: EditResult<UpgradeFeatureResult> = await e.upgradeFeature(document, op.feature, op.to);
      const confirm = upgradeConfirmation(r.result);
      if (r.changed && !options.preview && op.confirm !== confirm) {
        const { feature, from, to, diff } = r.result;
        throw new CommandEngineError(
          "COMMAND_UPGRADE_UNCONFIRMED",
          `upgrading ${feature} from v${from} to v${to} changes the report of ${diff.length} entr${diff.length === 1 ? "y" : "ies"}: ` +
            `review the diff and apply it with its confirm token (${op.confirm === undefined ? "none was given" : "the given token is for another diff"})`,
          [],
          { feature, from, to, diff, confirm, ...(op.confirm !== undefined ? { given: op.confirm } : {}) },
        );
      }
      return outcome(op, { ...r, result: { ...r.result, confirm } }, null);
    }
  }
}

/** A reference's report entry, located by feature id and field (SPEC-v1 §5.8). */
export interface RefLocation {
  featureId: string;
  feature: string;
  field: string;
  entry: metricsV1.RefReport;
}

/**
 * Every reference entry of an `aicad.metrics/1` report (optionally of one feature): members with
 * probes, unresolved members with ranked candidates (each with probe and synthesised `query`),
 * and proposals — what the repair UI and the agent's `repair_ref` read.
 */
export function refEntries(report: metricsV1.EvalReport, featureId?: string): RefLocation[] {
  const out: RefLocation[] = [];
  for (const f of report.features) {
    if (featureId !== undefined && f.feature_id !== featureId) continue;
    for (const entry of f.refs ?? []) out.push({ featureId: f.feature_id, feature: f.feature, field: entry.field, entry });
  }
  return out;
}

/** Whether a reported member is the entity of that key and probe (split pieces share a key). */
function sameEntity(m: { key: string; probe: metricsV1.Probe }, c: { key: string; probe: metricsV1.Probe }): boolean {
  return m.key === c.key && JSON.stringify(m.probe) === JSON.stringify(c.probe);
}

/**
 * Whether accepting candidate `c` of unresolved entry `u` drops no other member (forge-wasm's
 * `COMMAND_CANDIDATE_PARTIAL` rule): the reference has no other unresolved entry, and every
 * resolved member is `c` itself or stands for `u` — a candidate of an entry without a capture
 * (key `""`), or a piece of `u`'s own key that `u` offers. A member merely listed among the
 * candidates (another captured key accounts for it) is still another member.
 */
export function candidateReplacesAll(e: metricsV1.RefReport, u: metricsV1.Unresolved, c: metricsV1.Candidate): boolean {
  if ((e.unresolved ?? []).length !== 1) return false;
  return e.members.every(
    (m) => sameEntity(m, c) || ((u.key === "" || m.key === u.key) && u.candidates.some((x) => sameEntity(m, x))),
  );
}

/**
 * The ops a failed or changed reference offers, derived from its report entry — only ops the
 * engine can apply: a candidate with a query whose acceptance drops no other member
 * ({@link candidateReplacesAll}), and `captureRef` only for a reference the query resolves by
 * itself (not failed, no member repaired by the geometric fallback: accept the proposal
 * instead).
 */
export function repairOps(loc: RefLocation): IrOp[] {
  const ops: IrOp[] = [];
  const e = loc.entry;
  if (e.proposal) ops.push({ op: "acceptRefProposal", feature: loc.featureId, field: loc.field });
  for (const u of e.unresolved ?? []) {
    u.candidates.forEach((c, i) => {
      if (!c.query || !candidateReplacesAll(e, u, c)) return;
      const shared = u.candidates.filter((x) => x.key === c.key).length > 1;
      // The probe identifies the entity the caller saw, whatever the store does before applying
      // it (the write-back before a repair): an index alone could name another piece then.
      ops.push({
        op: "acceptRefCandidate",
        feature: loc.featureId,
        field: loc.field,
        member: u.key,
        candidate: c.key,
        ...(shared ? { candidateIndex: i } : {}),
        probe: c.probe,
      });
    });
  }
  const repaired = e.members.some((m) => m.status === "repaired");
  if (e.status !== "failed" && !repaired) ops.push({ op: "captureRef", feature: loc.featureId, field: loc.field });
  return ops;
}

export type { ParamValueInput };
