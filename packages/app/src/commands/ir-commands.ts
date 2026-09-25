/**
 * Commands of the IR v1 command layer (SPEC-v1 §0.6, §5.9, §9.2; interface I7), over the
 * {@link IrDocStore} (`ctx.ir`). The palette, the agent and MCP call these; each op is one
 * undoable transaction (`ir.apply` runs several as one), and every result is JSON the agent
 * can read.
 *
 * A refused op fails the command; the registry's error then carries the engine's
 * machine-readable `detail` (`{ code, errors, details }`: an IR rejection such as
 * `EXPR_UNIT_MISMATCH` with its path, or a `COMMAND_*` refusal such as `COMMAND_REF_FAILED` with
 * the reference's candidates), the input of the agent's repair playbooks (W10).
 */
import type { metricsV1 } from "@aicad/ir-types";
import { z } from "zod";
import { CommandEngineError } from "../doc/v1/command-engine";
import type { TransactionOutcome } from "../doc/v1/ir-doc-store";
import {
  AcceptRefCandidateOp,
  AcceptRefProposalOp,
  CaptureRefOp,
  IrOpSchema,
  refEntries,
  RenameCurveOp,
  RenameFeatureOp,
  repairOps,
  SetParamOp,
  UpgradeFeatureOp,
  WriteBackSolutionOp,
  type IrOp,
  type RefLocation,
} from "../doc/v1/ops";
import type { AppServices } from "../services";
import { defineCommand, type ExecuteMeta } from "./registry";

const command = defineCommand<AppServices>();

function store(ctx: AppServices) {
  if (!ctx.ir) throw new CommandEngineError("IR_UNAVAILABLE", "this host has no IR v1 document store");
  return ctx.ir;
}

function originOf(meta: ExecuteMeta): "agent" | "command" | "user" {
  if (meta.source === "agent" || meta.source === "mcp") return "agent";
  return meta.source === "ui" || meta.source === "keyboard" || meta.source === "palette" ? "user" : "command";
}

/** A committed (or unchanged) transaction, as commands return it: no document text. */
export interface IrTransactionResult {
  changed: boolean;
  label: string;
  /** The store's revision after the transaction. */
  revision: number;
  ops: Array<{ op: IrOp; changed: boolean; result: unknown; inverse: IrOp | null }>;
}

export interface IrLoadResult {
  loaded: true;
  /** Ids the migration of a v0 document rewrote (SPEC-v1 §9.1; `from` is untrusted data). */
  renames: metricsV1.IdRename[];
  revision: number;
}

export interface IrStateResult {
  loaded: boolean;
  revision: number;
  params: metricsV1.ParamReport[] | null;
  history: { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null };
  document?: string | null;
}

/** A reference of the report with the repair ops it offers. */
export interface ListedRef extends RefLocation {
  repairs: IrOp[];
}

/** A transaction's outcome without the document text (the agent reads the ops' results). */
function summary(t: TransactionOutcome, revision: number): IrTransactionResult {
  return {
    changed: t.changed,
    label: t.label,
    revision,
    ops: t.ops.map((o) => ({ op: o.op, changed: o.changed, result: o.result, inverse: o.inverse })),
  };
}

async function runOp(ctx: AppServices, meta: ExecuteMeta, op: IrOp): Promise<IrTransactionResult> {
  const ir = store(ctx);
  const t = await ir.apply(IrOpSchema.parse(op), { origin: originOf(meta) });
  return summary(t, ir.getState().revision);
}

const enabled = (ctx: AppServices): boolean => ctx.ir !== undefined;

export const IR_COMMANDS = {
  "ir.load": command({
    id: "ir.load",
    title: "Load IR v1 Document",
    category: "Model",
    description:
      "Load an IR document (aicad.ir/1, or aicad.ir/0 which is migrated) as the IR v1 document of record. Without `document`, loads the migration of the current document's compiled IR. Clears the IR history.",
    args: z.strictObject({ document: z.string().max(20_000_000).optional() }),
    enabled,
    async run({ document }, ctx): Promise<IrLoadResult> {
      let text = document;
      if (text === undefined) {
        const s = await ctx.doc.idle();
        if (!s.model?.ir) throw new Error("the current document has not compiled yet");
        text = JSON.stringify(s.model.ir);
      }
      const r = await store(ctx).load(text);
      return { loaded: true, renames: r.renames, revision: store(ctx).getState().revision };
    },
  }),

  "ir.state": command({
    id: "ir.state",
    title: "IR v1 Document State",
    category: "Model",
    description: "The IR v1 document's revision, parameter values, history and (with `document: true`) its canonical text.",
    args: z.strictObject({ document: z.boolean().optional() }),
    palette: false,
    enabled,
    run({ document }, ctx): IrStateResult {
      const s = store(ctx).getState();
      return {
        loaded: s.document !== null,
        revision: s.revision,
        params: s.params,
        history: s.history,
        ...(document ? { document: s.document } : {}),
      };
    },
  }),

  "ir.undo": command({
    id: "ir.undo",
    title: "Undo IR Edit",
    category: "Edit",
    args: z.strictObject({}),
    enabled,
    run(_args, ctx) {
      const ir = store(ctx);
      const label = ir.getState().history.undoLabel;
      return { undone: ir.undo(), label, revision: ir.getState().revision };
    },
  }),

  "ir.redo": command({
    id: "ir.redo",
    title: "Redo IR Edit",
    category: "Edit",
    args: z.strictObject({}),
    enabled,
    run(_args, ctx) {
      const ir = store(ctx);
      const label = ir.getState().history.redoLabel;
      return { redone: ir.redo(), label, revision: ir.getState().revision };
    },
  }),

  "ir.apply": command({
    id: "ir.apply",
    title: "Apply IR Ops",
    category: "Model",
    description:
      "Apply several command-layer ops as ONE undoable transaction (atomic: if one is refused, none is applied). Ops: setParam, writeBackSolution, captureRef, acceptRefCandidate, acceptRefProposal, renameCurve, renameFeature, upgradeFeature (with the `confirm` token of the diff you reviewed: preview it with ir.upgradeFeature first).",
    args: z.strictObject({ ops: z.array(IrOpSchema).min(1).max(100), label: z.string().max(200).optional() }),
    palette: false,
    enabled,
    async run({ ops, label }, ctx, meta) {
      const ir = store(ctx);
      const t = await ir.transaction(
        label ?? (ops.length === 1 ? `${ops.length} op` : `${ops.length} ops`),
        async (tx) => {
          for (const op of ops) await tx.apply(op);
        },
        { origin: originOf(meta), ...(label !== undefined ? { label } : {}) },
      );
      return summary(t, ir.getState().revision);
    },
  }),

  "ir.setParam": command({
    id: "ir.setParam",
    title: "Set Parameter",
    category: "Model",
    description:
      "Set a parameter's value: a number or boolean literal, or an expression string (stored canonically, e.g. \"width/2\" → \"width / 2\"). Refused with the IR rejection (EXPR_*, PARAM_*) when the edit would not load.",
    args: SetParamOp.omit({ op: true }),
    palette: false,
    enabled,
    run(args, ctx, meta) {
      return runOp(ctx, meta, { op: "setParam", ...args });
    },
  }),

  "ir.writeBackSolution": command({
    id: "ir.writeBackSolution",
    title: "Write Back Sketch Solutions",
    category: "Model",
    description:
      "Store the solved geometry of constrained sketches (all, or `sketches`) as their literal guess (SPEC-v1 §4.4 rule 9), repeated to its fixed point (a solve that welds ends moves the geometry again once). Idempotent.",
    args: WriteBackSolutionOp.omit({ op: true }),
    enabled,
    run(args, ctx, meta) {
      return runOp(ctx, meta, { op: "writeBackSolution", ...args });
    },
  }),

  "ir.captureRef": command({
    id: "ir.captureRef",
    title: "Capture Reference",
    category: "Model",
    description:
      "Store the capture of a reference's current resolution (`field`: the Ref's pointer in the feature, as in the report's refs[].field). Refused for a failing reference: repair it first.",
    args: CaptureRefOp.omit({ op: true }),
    palette: false,
    enabled,
    run(args, ctx, meta) {
      return runOp(ctx, meta, { op: "captureRef", ...args });
    },
  }),

  "ir.acceptRefCandidate": command({
    id: "ir.acceptRefCandidate",
    title: "Accept Reference Candidate",
    category: "Model",
    description:
      "Repair a reference: replace its query by a candidate's query (from ir.listRefs: unresolved[member].candidates) and refresh its capture. `candidateIndex` picks one of several candidates sharing a key; pass the candidate's `probe` too (ir.listRefs' repairs carry it): the op is refused with COMMAND_CANDIDATE_CHANGED when the candidate is no longer that entity (re-read ir.listRefs then).",
    args: AcceptRefCandidateOp.omit({ op: true }),
    palette: false,
    enabled,
    run(args, ctx, meta) {
      return runOp(ctx, meta, { op: "acceptRefCandidate", ...args });
    },
  }),

  "ir.acceptRefProposal": command({
    id: "ir.acceptRefProposal",
    title: "Accept Reference Proposal",
    category: "Model",
    description: "Apply a reference's proposal (REF_REPAIRED / REF_SET_CHANGED): its rewritten query and a fresh capture.",
    args: AcceptRefProposalOp.omit({ op: true }),
    palette: false,
    enabled,
    run(args, ctx, meta) {
      return runOp(ctx, meta, { op: "acceptRefProposal", ...args });
    },
  }),

  "ir.renameCurve": command({
    id: "ir.renameCurve",
    title: "Rename Sketch Curve",
    category: "Model",
    description:
      "Rename a sketch curve and every query, region, hole point, constraint argument and capture key naming it, in one op; every reference keeps resolving exactly.",
    args: RenameCurveOp.omit({ op: true }),
    palette: false,
    enabled,
    run(args, ctx, meta) {
      return runOp(ctx, meta, { op: "renameCurve", ...args });
    },
  }),

  "ir.renameFeature": command({
    id: "ir.renameFeature",
    title: "Rename Feature",
    category: "Model",
    description: "Rename a feature (by id). References use ids, so nothing else changes.",
    args: RenameFeatureOp.omit({ op: true }),
    palette: false,
    enabled,
    run(args, ctx, meta) {
      return runOp(ctx, meta, { op: "renameFeature", ...args });
    },
  }),

  "ir.upgradeFeature": command({
    id: "ir.upgradeFeature",
    title: "Upgrade Feature Version",
    category: "Model",
    description:
      "Upgrade a feature's behavior version `v` (default: the newest defined). SPEC-v1 §9.2: the report diff is shown before the upgrade is applied — call with `preview: true` to get the diff and its `confirm` token, then again with that `confirm` to apply it. Without a matching `confirm` an upgrade that changes the document is refused (COMMAND_UPGRADE_UNCONFIRMED, with the diff and its token in the details).",
    args: z.strictObject({ ...UpgradeFeatureOp.omit({ op: true }).shape, preview: z.boolean().optional() }),
    palette: false,
    enabled,
    async run({ feature, to, confirm, preview }, ctx, meta): Promise<IrTransactionResult | { preview: true; changed: boolean; result: unknown }> {
      const op: IrOp = { op: "upgradeFeature", feature, ...(to !== undefined ? { to } : {}), ...(confirm !== undefined ? { confirm } : {}) };
      if (preview) {
        const o = await store(ctx).preview(op);
        return { preview: true, changed: o.changed, result: o.result };
      }
      return runOp(ctx, meta, op);
    },
  }),

  "ir.listRefs": command({
    id: "ir.listRefs",
    title: "List References",
    category: "Model",
    description:
      "Every reference of the IR v1 document (or of one feature) from its aicad.metrics/1 report: status, code, members with probes, unresolved members with ranked candidates (probe, query), proposal — and the repair ops each offers (only ops the engine applies: no candidate whose query would drop another member, no capture of a repaired reference).",
    args: z.strictObject({ feature: z.string().min(1).max(200).optional(), failedOnly: z.boolean().optional() }),
    palette: false,
    enabled,
    async run({ feature, failedOnly }, ctx): Promise<ListedRef[]> {
      const report = await store(ctx).report();
      return refEntries(report, feature)
        .filter((l) => !failedOnly || l.entry.status !== "exact")
        .map((l) => ({ ...l, repairs: repairOps(l) }));
    },
  }),
};
