/**
 * The IR v1 command layer's commands (FULL-MODELING-PLAN §2.1), over the {@link IrDocStore}
 * (`ctx.ir`). **Generated from the op catalogue** (`@aicad/model-ops` `OP_CATALOGUE`): every op is
 * a command `ir.<op>` whose arguments are the op's zod schema (plus `ack`), so the palette, the
 * menus, the tools, the agent and MCP all issue exactly the same ops. Each op is one undoable
 * transaction (`ir.apply` runs several as one); every result is JSON the agent can read.
 *
 * - **Who.** The command's source decides the transaction's origin: a UI gesture, key, menu or the
 *   palette is `user`; the agent is `agent`; MCP is `mcp:client`; tests and host code are `command`.
 *   Authorship and ADR 0015's commit check follow from it; host-only ops (`setAuthor`) refuse agent
 *   and MCP callers.
 * - **Newly failing features.** A transaction that would make features fail is refused with
 *   `COMMAND_NEW_FAILURES`. For a user gesture the command asks ("2 features will newly fail…
 *   Apply anyway?") and, when confirmed, applies it acknowledged; other callers pass `ack`.
 * - A refused op fails the command; the registry's error then carries the engine's machine-readable
 *   `detail` (`{ code, errors, details }`), the input of the agent's repair playbooks.
 */
import type { metricsV1 } from "@aicad/ir-types";
import { dependents, OP_CATALOGUE, OP_SCHEMAS, paramUses, type IrOpName, type NewFailure, type OpOrigin } from "@aicad/model-ops";
import { z } from "zod";
import { CommandEngineError } from "../doc/v1/command-engine";
import type { TransactionOutcome } from "../doc/v1/ir-doc-store";
import { IrOpSchema, opLabel, refEntries, repairOps, UpgradeFeatureOp, type IrOp, type RefLocation } from "../doc/v1/ops";
import type { AppServices } from "../services";
import { defineCommand, type AnyCommandSpec, type CommandSource, type CommandSpec, type ExecuteMeta } from "./registry";

const command = defineCommand<AppServices>();

function store(ctx: AppServices) {
  if (!ctx.ir) throw new CommandEngineError("IR_UNAVAILABLE", "this host has no IR v1 document store");
  return ctx.ir;
}

const USER_SOURCES: ReadonlySet<CommandSource> = new Set(["ui", "keyboard", "palette", "menu"]);

/** The transaction origin of a command's caller. */
export function originOf(meta: ExecuteMeta): OpOrigin {
  if (meta.source === "agent") return "agent";
  if (meta.source === "mcp") return "mcp:client";
  return USER_SOURCES.has(meta.source) ? "user" : "command";
}

/** A committed (or unchanged) transaction, as commands return it: no document text. */
export interface IrTransactionResult {
  changed: boolean;
  label: string;
  /** The store's revision after the transaction. */
  revision: number;
  ops: Array<{ op: IrOp; changed: boolean; result: unknown; inverse: IrOp | null }>;
  /** Newly failing features the transaction acknowledged. */
  newFailures?: NewFailure[];
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
  rollback: string | null;
  appearance: Readonly<Record<string, string>>;
  group: { label: string; origin: string; steps: number } | null;
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
    ...(t.newFailures?.length ? { newFailures: t.newFailures } : {}),
  };
}

const Ack = z.array(z.string().min(1).max(200)).max(1000).optional();

/**
 * Run `ops` as one transaction for a command. A user gesture refused only because features would
 * newly fail asks the user, and applies it acknowledged when they agree.
 */
export async function runOps(ctx: AppServices, meta: ExecuteMeta, ops: readonly IrOp[], options: { label?: string; ack?: readonly string[] } = {}): Promise<IrTransactionResult> {
  const ir = store(ctx);
  const origin = originOf(meta);
  for (const op of ops) {
    if (OP_CATALOGUE.find((o) => o.op === op.op)?.hostOnly && (meta.source === "agent" || meta.source === "mcp")) {
      throw new CommandEngineError("COMMAND_HOST_ONLY", `${op.op} is the user's to do (ADR 0015); agents and MCP clients cannot issue it`, [], { op: op.op });
    }
  }
  const parsed = ops.map((op) => IrOpSchema.parse(op));
  const label = options.label ?? (parsed.length === 1 ? undefined : `${parsed.length} edits`);
  const run = (ack?: readonly string[]) =>
    ir.transaction(
      label ?? (parsed[0] ? opLabel(parsed[0]) : "Edit"),
      async (tx) => {
        for (const op of parsed) await tx.apply(op);
      },
      { origin, ...(ack ? { ack } : {}), ...(label !== undefined ? { label } : {}) },
    );
  try {
    const t = await run(options.ack);
    return summary(t, ir.getState().revision);
  } catch (e) {
    if (!(e instanceof CommandEngineError) || e.code !== "COMMAND_NEW_FAILURES" || options.ack || !USER_SOURCES.has(meta.source)) throw e;
    const features = (e.details["features"] as NewFailure[] | undefined) ?? [];
    const list = features.map((f) => `• ${f.name}: ${f.code}`).join("\n");
    const ok = await ctx.confirm(`${features.length} feature${features.length === 1 ? "" : "s"} will newly fail:\n${list}\n\nApply anyway?`);
    if (!ok) throw e;
    const t = await run(features.map((f) => f.id));
    return summary(t, ir.getState().revision);
  }
}

const enabled = (ctx: AppServices): boolean => ctx.ir !== undefined && ctx.ir.getState().document !== null;
const hasStore = (ctx: AppServices): boolean => ctx.ir !== undefined;

type OpArgs<K extends IrOpName> = Omit<z.input<(typeof OP_SCHEMAS)[K]>, "op"> & { ack?: string[] | undefined };
type OpCommandSpec<K extends IrOpName> = CommandSpec<z.ZodType<OpArgs<K>, OpArgs<K>>, Promise<IrTransactionResult>, AppServices> & { id: `ir.${K}` };
/** The generated commands, typed per op (so `commands.execute({ id: "ir.addFeature", args })` is checked). */
export type CatalogueCommands = { [K in Exclude<IrOpName, "upgradeFeature"> as `ir.${K}`]: OpCommandSpec<K> };

/** `ir.<op>` for every catalogue op (upgradeFeature has its own command, with its preview). */
function catalogueCommands(): CatalogueCommands {
  const out: Record<string, AnyCommandSpec<AppServices>> = {};
  for (const info of OP_CATALOGUE) {
    if (info.op === "upgradeFeature") continue;
    const schema = OP_SCHEMAS[info.op as IrOpName] as unknown as z.ZodObject<z.ZodRawShape>;
    const args = schema.omit({ op: true }).extend({ ack: Ack });
    const id = `ir.${info.op}`;
    out[id] = command({
      id,
      title: info.title,
      category: "Model",
      description: `${info.description}${info.hostOnly ? " (Host-only: agents and MCP cannot call it.)" : ""} ack: the ids of newly failing features to accept ("Apply anyway").`,
      args,
      palette: false,
      enabled,
      run(a, ctx, meta) {
        const { ack, ...rest } = a as { ack?: string[] } & Record<string, unknown>;
        return runOps(ctx, meta, [{ op: info.op, ...rest } as IrOp], ack ? { ack } : {});
      },
    }) as unknown as AnyCommandSpec<AppServices>;
  }
  return out as unknown as CatalogueCommands;
}

export const IR_COMMANDS = {
  "ir.load": command({
    id: "ir.load",
    title: "Load IR v1 Document",
    category: "Model",
    description:
      "Load an IR document (aicad.ir/1, or aicad.ir/0 which is migrated) as the IR v1 document of record. Without `document`, loads the migration of the current document's compiled IR. Clears the IR history.",
    args: z.strictObject({ document: z.string().max(20_000_000).optional() }),
    enabled: hasStore,
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
    description: "The IR v1 document's revision, parameter values, history, rollback marker, appearance, open group and (with `document: true`) its canonical text.",
    args: z.strictObject({ document: z.boolean().optional() }),
    palette: false,
    enabled: hasStore,
    run({ document }, ctx): IrStateResult {
      const s = store(ctx).getState();
      return {
        loaded: s.document !== null,
        revision: s.revision,
        params: s.params,
        history: s.history,
        rollback: s.host.rollback,
        appearance: s.host.appearance,
        group: s.group,
        ...(document ? { document: s.document } : {}),
      };
    },
  }),

  "ir.undo": command({
    id: "ir.undo",
    title: "Undo IR Edit",
    category: "Edit",
    args: z.strictObject({}),
    palette: false,
    enabled: hasStore,
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
    palette: false,
    enabled: hasStore,
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
      "Apply several command-layer ops as ONE undoable transaction (atomic: if one is refused, none is applied). Ops: every op of the catalogue (addFeature, setField, updateFeature, deleteFeature, moveFeature, setSuppressed, renameFeature, addParam, setParam, renameParam, deleteParam, setRollback, setAppearance, writeBackSolution, captureRef, acceptRefCandidate, acceptRefProposal, renameCurve, upgradeFeature with its `confirm` token). `ack`: the ids of newly failing features to accept.",
    args: z.strictObject({ ops: z.array(IrOpSchema).min(1).max(100), label: z.string().max(200).optional(), ack: Ack }),
    palette: false,
    enabled,
    run({ ops, label, ack }, ctx, meta) {
      return runOps(ctx, meta, ops, { ...(label !== undefined ? { label } : {}), ...(ack ? { ack } : {}) });
    },
  }),

  ...catalogueCommands(),

  "ir.upgradeFeature": command({
    id: "ir.upgradeFeature",
    title: "Upgrade Feature Version",
    category: "Model",
    description:
      "Upgrade a feature's behavior version `v` (default: the newest defined). SPEC-v1 §9.2: the report diff is shown before the upgrade is applied — call with `preview: true` to get the diff and its `confirm` token, then again with that `confirm` to apply it. Without a matching `confirm` an upgrade that changes the document is refused (COMMAND_UPGRADE_UNCONFIRMED, with the diff and its token in the details).",
    args: z.strictObject({ ...UpgradeFeatureOp.omit({ op: true }).shape, preview: z.boolean().optional(), ack: Ack }),
    palette: false,
    enabled,
    async run({ feature, to, confirm, preview, ack }, ctx, meta): Promise<IrTransactionResult | { preview: true; changed: boolean; result: unknown }> {
      const op: IrOp = { op: "upgradeFeature", feature, ...(to !== undefined ? { to } : {}), ...(confirm !== undefined ? { confirm } : {}) };
      if (preview) {
        const o = await store(ctx).preview(op);
        return { preview: true, changed: o.changed, result: o.result };
      }
      return runOps(ctx, meta, [op], ack ? { ack } : {});
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

  "ir.dependents": command({
    id: "ir.dependents",
    title: "Feature Dependents",
    category: "Model",
    description: "The features that reference a feature by id (directly or through another dependent): what deleting it would take with it.",
    args: z.strictObject({ feature: z.string().min(1).max(200) }),
    palette: false,
    enabled,
    async run({ feature }, ctx) {
      const ir = store(ctx);
      await ir.idle();
      return dependents(ir.commandEngine(), ir.document, feature);
    },
  }),

  "ir.paramUses": command({
    id: "ir.paramUses",
    title: "Parameter Uses",
    category: "Model",
    description: "Every expression that uses a parameter (feature fields and other parameters), with its path.",
    args: z.strictObject({ name: z.string().min(1).max(200) }),
    palette: false,
    enabled,
    async run({ name }, ctx) {
      const ir = store(ctx);
      await ir.idle();
      return paramUses(ir.commandEngine(), ir.document, name);
    },
  }),

  "ir.openGroup": command({
    id: "ir.openGroup",
    title: "Open Undo Group",
    category: "Edit",
    description: "Start an undo group: the transactions until ir.sealGroup become ONE undo step (an agent turn, an edited sketch); ir.abortGroup restores the document from before it.",
    args: z.strictObject({ label: z.string().min(1).max(200) }),
    palette: false,
    enabled,
    async run({ label }, ctx, meta) {
      await store(ctx).openGroup({ label, origin: originOf(meta) });
      return { open: true, label };
    },
  }),

  "ir.sealGroup": command({
    id: "ir.sealGroup",
    title: "Seal Undo Group",
    category: "Edit",
    args: z.strictObject({}),
    palette: false,
    enabled,
    run(_args, ctx) {
      return store(ctx).sealGroup();
    },
  }),

  "ir.abortGroup": command({
    id: "ir.abortGroup",
    title: "Abort Undo Group",
    category: "Edit",
    args: z.strictObject({}),
    palette: false,
    enabled,
    run(_args, ctx) {
      return store(ctx).abortGroup();
    },
  }),
};
