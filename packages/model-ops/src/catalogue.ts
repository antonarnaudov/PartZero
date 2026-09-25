/**
 * The op catalogue v2 (FULL-MODELING-PLAN §2.2, contract C1): **one definition per domain op** — its
 * zod schema, label, and the metadata the app's command registry, the agent's tools and the MCP
 * server are generated from. The UI, the agent, MCP (and later the CLI) issue these ops; a store
 * applies them as undoable transactions (`transaction.ts`, the app's `IrDocStore`).
 *
 * | Op | Effect | Semantic inverse |
 * |---|---|---|
 * | `addFeature` | a feature (any v1 type, sketches included) into a part, after a feature (or at the rollback marker) | `deleteFeature` |
 * | `setField` | one field of a feature, by JSON pointer (also into a sketch's curves and constraints); `{ expr }` stores an expression | `setField` with the previous value |
 * | `updateFeature` | several top-level fields of a feature (JSON merge patch: `null` removes a field) | `updateFeature` with the previous values |
 * | `deleteFeature` | a feature; `dependents`: `refuse` (default, lists them), `cascade` (deletes them too) or `keep` | `addFeature` for each deleted feature |
 * | `moveFeature` | a feature to another place in its part's timeline, refused when a reference would point forward | `moveFeature` back |
 * | `setSuppressed` | suppress / unsuppress a feature | the opposite |
 * | `renameFeature` | a feature's name (references use ids) | `renameFeature` back |
 * | `addParam` | a parameter (document or part level) | `deleteParam` |
 * | `setParam` | a parameter's value (literal or expression) | `setParam` with the previous value |
 * | `renameParam` | a parameter and every expression that uses it | `renameParam` back |
 * | `deleteParam` | a parameter; `uses`: `refuse` (default, lists them) or `inline` (its value replaces each use) | `addParam` + the uses restored |
 * | `setRollback` | the rollback marker (features after it are not built; new features go after it) | `setRollback` back |
 * | `setAppearance` | the display colour of the bodies a feature creates | `setAppearance` with the previous colour |
 * | `setAuthor` | (host only, ADR 0015) who authored features: "Keep" makes the agent's features yours | `setAuthor` back |
 * | `writeBackSolution`, `captureRef`, `acceptRefCandidate`, `acceptRefProposal`, `renameCurve`, `upgradeFeature` | Phase C (SPEC-v1 §0.6, §5.9, §9.2), applied by the engine | see `apply.ts` |
 *
 * Every transaction is **exactly** undoable whatever the op: the store records the canonical
 * document (and the host state: rollback marker, appearance) before and after. The semantic inverse
 * is returned too (transcripts, the agent) and the tests check it restores the same bytes.
 */
import { metricsV1 } from "@aicad/ir-types";
import { z } from "zod";

const Id = z.string().min(1).max(200);
/** A Ref's JSON pointer relative to its feature (the report's `refs[].field`). */
const Field = z.string().regex(/^\/[A-Za-z0-9_/]*$/, "a JSON pointer relative to the feature, e.g. /target").max(200);
const Key = z.string().max(2048);
/** A JSON pointer into a feature (`/distance`, `/curves/0/end/1`, `/constraints/3/value`). */
const Pointer = z.string().min(2).max(500).regex(/^\//, "a JSON pointer into the feature, e.g. /distance");
const ParamLiteral = z.union([z.number().finite(), z.boolean(), z.string().min(1).max(4096)]);
const BoundValue = z.union([z.number().finite(), z.string().min(1).max(4096)]);
/** A feature as IR v1 JSON (`type` selects the variant, SPEC-v1 §6); the engine validates the rest. */
const FeatureJson = z.looseObject({ type: z.string().min(1).max(64) });
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour like #3a7bd5");
export const PARAM_UNITS = ["mm", "deg", "ratio", "count", "bool"] as const;

// ─── Phase C ops (engine-applied) ─────────────────────────────────────────────────────────────

export const SetParamOp = z.strictObject({
  op: z.literal("setParam"),
  name: Id,
  value: ParamLiteral,
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

// ─── Catalogue v2: features ───────────────────────────────────────────────────────────────────

export const AddFeatureOp = z.strictObject({
  op: z.literal("addFeature"),
  /** Part id or name (default: the first part). */
  part: Id.optional(),
  /**
   * Insert after this feature (id or name); `null` inserts it first. Omitted: at the rollback
   * marker, or at the end of the part when there is none.
   */
  after: Id.nullable().optional(),
  /** The feature as IR v1 JSON. Its id is `<type><n>` (`extrude1`) unless given; its name defaults to the id. */
  feature: FeatureJson,
});
export const SetFieldOp = z.strictObject({
  op: z.literal("setField"),
  feature: Id,
  /** A JSON pointer into the feature: `/distance`, `/curves/0/end`, `/constraints/2/value`; `/-` appends to an array. */
  path: Pointer,
  /** The new JSON value; `{ "expr": "width / 2" }` stores an expression. */
  value: z.unknown().optional(),
  /** Remove the field (or the array element) instead of setting it. */
  remove: z.boolean().optional(),
});
export const UpdateFeatureOp = z.strictObject({
  op: z.literal("updateFeature"),
  feature: Id,
  /** Top-level fields to set (JSON merge patch: `null` removes a field). `id`, `type` and `author` are fixed. */
  set: z.record(z.string().min(1).max(64), z.unknown()),
});
export const DeleteFeatureOp = z.strictObject({
  op: z.literal("deleteFeature"),
  feature: Id,
  /** Features that reference it: `refuse` (default: the refusal lists them), `cascade` (delete them too) or `keep`. */
  dependents: z.enum(["refuse", "cascade", "keep"]).optional(),
});
export const MoveFeatureOp = z.strictObject({
  op: z.literal("moveFeature"),
  feature: Id,
  /** The feature it goes after (same part); `null` moves it first. */
  after: Id.nullable(),
});
export const SetSuppressedOp = z.strictObject({ op: z.literal("setSuppressed"), feature: Id, suppressed: z.boolean() });

// ─── Catalogue v2: parameters ─────────────────────────────────────────────────────────────────

export const AddParamOp = z.strictObject({
  op: z.literal("addParam"),
  name: Id,
  unit: z.enum(PARAM_UNITS),
  /** A literal, or an expression over other parameters (`"width - 2 * wall"`). */
  value: ParamLiteral,
  min: BoundValue.optional(),
  max: BoundValue.optional(),
  note: z.string().max(2000).optional(),
  /** Part id or name for a part-level parameter (default: document level). */
  part: Id.optional(),
  /** Position in its parameter list (default: last). */
  at: z.number().int().min(0).max(100_000).optional(),
});
export const DeleteParamOp = z.strictObject({
  op: z.literal("deleteParam"),
  name: Id,
  /** Expressions that use it: `refuse` (default: the refusal lists them) or `inline` (each use gets its current value). */
  uses: z.enum(["refuse", "inline"]).optional(),
});
export const RenameParamOp = z.strictObject({ op: z.literal("renameParam"), old: Id, new: Id });

// ─── Catalogue v2: host state (not IR) ────────────────────────────────────────────────────────

export const SetRollbackOp = z.strictObject({
  op: z.literal("setRollback"),
  /** The last feature that is built (id or name); `null` clears the marker (everything is built). */
  after: Id.nullable(),
});
export const SetAppearanceOp = z.strictObject({
  op: z.literal("setAppearance"),
  /** The feature whose bodies get the colour (id or name). */
  feature: Id,
  /** `#rrggbb`, or `null` for the default. */
  color: Color.nullable(),
});
export const SetAuthorOp = z.strictObject({
  op: z.literal("setAuthor"),
  /** Feature ids or names. */
  features: z.array(Id).min(1).max(10_000),
  author: z.enum(["user", "agent"]),
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
  AddFeatureOp,
  SetFieldOp,
  UpdateFeatureOp,
  DeleteFeatureOp,
  MoveFeatureOp,
  SetSuppressedOp,
  AddParamOp,
  DeleteParamOp,
  RenameParamOp,
  SetRollbackOp,
  SetAppearanceOp,
  SetAuthorOp,
]);

export type IrOp = z.infer<typeof IrOpSchema>;
export type IrOpName = IrOp["op"];
export type OpOf<N extends IrOpName> = Extract<IrOp, { op: N }>;

/** The zod schema of each op (without the discriminated union). */
export const OP_SCHEMAS = {
  setParam: SetParamOp,
  writeBackSolution: WriteBackSolutionOp,
  captureRef: CaptureRefOp,
  acceptRefCandidate: AcceptRefCandidateOp,
  acceptRefProposal: AcceptRefProposalOp,
  renameCurve: RenameCurveOp,
  renameFeature: RenameFeatureOp,
  upgradeFeature: UpgradeFeatureOp,
  addFeature: AddFeatureOp,
  setField: SetFieldOp,
  updateFeature: UpdateFeatureOp,
  deleteFeature: DeleteFeatureOp,
  moveFeature: MoveFeatureOp,
  setSuppressed: SetSuppressedOp,
  addParam: AddParamOp,
  deleteParam: DeleteParamOp,
  renameParam: RenameParamOp,
  setRollback: SetRollbackOp,
  setAppearance: SetAppearanceOp,
  setAuthor: SetAuthorOp,
} as const satisfies { [K in IrOpName]: z.ZodType<OpOf<K>> };

/** What the command registry, the agent's tools and MCP generate from each op. */
export interface OpInfo {
  op: IrOpName;
  /** Command palette and menu title. */
  title: string;
  /** The agent tool / MCP tool name (snake_case); absent for host-only ops. */
  tool?: string;
  /** For people and models: what it does, how to call it, what refuses it. */
  description: string;
  /**
   * Host-only (ADR 0015 §2): never an agent or MCP tool. `setAuthor` ("Keep") is the user's; an
   * agent that could write authorship could launder its edits as the user's.
   */
  hostOnly?: true;
  /** Which area of the model it edits (grouping in the palette and the agent's tool list). */
  area: "feature" | "param" | "reference" | "sketch" | "view";
}

/** The catalogue, in the order people see it. */
export const OP_CATALOGUE: readonly OpInfo[] = [
  {
    op: "addFeature",
    title: "Add Feature",
    tool: "add_feature",
    area: "feature",
    description:
      "Add a feature (any IR v1 type: sketch, extrude, revolve, boolean, hole, fillet, chamfer, shell, pattern, datum_plane, datum_axis, tag) to a part. `feature` is its IR v1 JSON; its id is <type><n> (extrude1) unless given, its name defaults to the id. Inserted after `after` (a feature id or name; null = first), or at the rollback marker / end of the part when omitted. Refused with the IR rejection (code and path) when the document would not load, or COMMAND_FEATURE_FAILS when the new feature does not build.",
  },
  {
    op: "setField",
    title: "Set Feature Field",
    tool: "set_field",
    area: "feature",
    description:
      'Set one field of a feature by JSON pointer: "/distance", "/curves/0/end", "/constraints/2/value", "/targets". value is JSON; {"expr": "width / 2"} stores an expression (canonical form). remove: true deletes the field. id, type and author are fixed. Refused with the IR rejection at the path, or COMMAND_FEATURE_FAILS when the feature would not build.',
  },
  {
    op: "updateFeature",
    title: "Update Feature",
    tool: "update_feature",
    area: "feature",
    description:
      'Set several top-level fields of a feature at once (JSON merge patch: {"distance": 12, "op": "join", "targets": "all"}; null removes a field, e.g. {"direction": null}). id, type and author are fixed. Validated like set_field.',
  },
  {
    op: "deleteFeature",
    title: "Delete Feature",
    tool: "delete_feature",
    area: "feature",
    description:
      "Delete a feature. Features that reference it by id (an extrude of this sketch, a fillet of this body…) are its dependents: with dependents \"refuse\" (default) the op is refused with COMMAND_HAS_DEPENDENTS listing them; \"cascade\" deletes them too; \"keep\" keeps features that only fail after the delete (they then need an acknowledgement).",
  },
  {
    op: "moveFeature",
    title: "Move Feature",
    tool: "move_feature",
    area: "feature",
    description:
      "Reorder a feature within its part: it goes after `after` (a feature id or name; null = first). Refused with COMMAND_ILLEGAL_ORDER when a feature would reference a later one (SPEC-v1 §0.3 rule 4).",
  },
  {
    op: "setSuppressed",
    title: "Suppress / Unsuppress Feature",
    tool: "set_suppressed",
    area: "feature",
    description: "Suppress (skip) or unsuppress a feature. Features that fail because of it need an acknowledgement (COMMAND_NEW_FAILURES lists them).",
  },
  {
    op: "renameFeature",
    title: "Rename Feature",
    tool: "rename_feature",
    area: "feature",
    description: "Rename a feature (by id). References use ids, so nothing else changes. Names share one namespace with parameters.",
  },
  {
    op: "addParam",
    title: "Add Parameter",
    tool: "add_param",
    area: "param",
    description:
      'Add a named parameter: unit mm | deg | ratio | count | bool, value a literal or an expression over other parameters ("width - 2 * wall"), optional min/max, optional part (a part-level parameter). Fields reference it by name in expressions ({"expr": "wall * 2"}).',
  },
  {
    op: "setParam",
    title: "Set Parameter",
    tool: "set_param",
    area: "param",
    description:
      'Set a parameter\'s value: a number or boolean literal, or an expression string (stored canonically, e.g. "width/2" → "width / 2"). Refused with the IR rejection (EXPR_*, PARAM_*) when the edit would not load, or COMMAND_NEW_FAILURES when features would newly fail.',
  },
  {
    op: "renameParam",
    title: "Rename Parameter",
    tool: "rename_param",
    area: "param",
    description: "Rename a parameter and rewrite every expression that uses it; the model is unchanged.",
  },
  {
    op: "deleteParam",
    title: "Delete Parameter",
    tool: "delete_param",
    area: "param",
    description:
      'Delete a parameter. With uses "refuse" (default) a parameter that expressions use is refused (COMMAND_PARAM_IN_USE lists the uses); "inline" replaces each use with the parameter\'s current value.',
  },
  {
    op: "setRollback",
    title: "Set Rollback Marker",
    tool: "set_rollback",
    area: "view",
    description:
      "Move the timeline's rollback marker after a feature (id or name): later features are not built, and new features are inserted at the marker. null clears it (everything is built).",
  },
  {
    op: "setAppearance",
    title: "Set Appearance",
    tool: "set_appearance",
    area: "view",
    description: 'Set the display colour ("#rrggbb", or null for the default) of the bodies a feature creates. Geometry-free.',
  },
  {
    op: "setAuthor",
    title: "Keep Features",
    area: "feature",
    hostOnly: true,
    description: "Record who authored features (ADR 0015): Keep makes the agent's features yours. Host-only: agents and MCP clients cannot write authorship.",
  },
  {
    op: "writeBackSolution",
    title: "Write Back Sketch Solutions",
    tool: "write_back_solution",
    area: "sketch",
    description:
      "Store the solved geometry of constrained sketches (all, or `sketches`) as their literal guess (SPEC-v1 §4.4 rule 9), repeated to its fixed point. Idempotent. Every transaction already does this.",
  },
  {
    op: "renameCurve",
    title: "Rename Sketch Curve",
    tool: "rename_curve",
    area: "sketch",
    description:
      "Rename a sketch curve and every query, region, hole point, constraint argument and capture key naming it, in one op; every reference keeps resolving exactly.",
  },
  {
    op: "captureRef",
    title: "Capture Reference",
    tool: "capture_ref",
    area: "reference",
    description:
      "Store the capture of a reference's current resolution (`field`: the Ref's pointer in the feature, as in the report's refs[].field). Refused for a failing reference: repair it first.",
  },
  {
    op: "acceptRefCandidate",
    title: "Accept Reference Candidate",
    tool: "accept_ref_candidate",
    area: "reference",
    description:
      "Repair a reference: replace its query by a candidate's query (from the report's unresolved[member].candidates) and refresh its capture. Pass the candidate's probe: the op is refused with COMMAND_CANDIDATE_CHANGED when the candidate is no longer that entity.",
  },
  {
    op: "acceptRefProposal",
    title: "Accept Reference Proposal",
    tool: "accept_ref_proposal",
    area: "reference",
    description: "Apply a reference's proposal (REF_REPAIRED / REF_SET_CHANGED): its rewritten query and a fresh capture.",
  },
  {
    op: "upgradeFeature",
    title: "Upgrade Feature Version",
    tool: "upgrade_feature",
    area: "feature",
    description:
      "Upgrade a feature's behavior version `v` (default: the newest defined). The report diff is shown before it is applied: without the `confirm` token of that diff an upgrade that changes the document is refused (COMMAND_UPGRADE_UNCONFIRMED, with the diff and its token in the details).",
  },
];

/** Ops no agent or MCP client may issue (ADR 0015); the snapshot test holds every other op to a generated tool. */
export const HOST_ONLY_OPS: ReadonlySet<IrOpName> = new Set(OP_CATALOGUE.filter((o) => o.hostOnly).map((o) => o.op));

export function opInfo(op: IrOpName): OpInfo {
  const info = OP_CATALOGUE.find((o) => o.op === op);
  if (!info) throw new Error(`op ${op} is not in the catalogue`);
  return info;
}

const shortValue = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};

/** A short label for an op (`Set width = 80`, `Add extrude1`, `Delete fillet2`, …). */
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
    case "addFeature": {
      const f = op.feature as Record<string, unknown>;
      const name = typeof f["name"] === "string" ? f["name"] : typeof f["id"] === "string" ? f["id"] : null;
      return name ? `Add ${op.feature.type} ${name}` : `Add ${op.feature.type}`;
    }
    case "setField":
      return op.remove ? `Clear ${op.feature}${op.path}` : `Set ${op.feature}${op.path} = ${shortValue(op.value)}`;
    case "updateFeature":
      return `Edit ${op.feature} (${Object.keys(op.set).join(", ")})`;
    case "deleteFeature":
      return `Delete ${op.feature}${op.dependents === "cascade" ? " and its dependents" : ""}`;
    case "moveFeature":
      return op.after === null ? `Move ${op.feature} to the start` : `Move ${op.feature} after ${op.after}`;
    case "setSuppressed":
      return `${op.suppressed ? "Suppress" : "Unsuppress"} ${op.feature}`;
    case "addParam":
      return `Add parameter ${op.name} = ${typeof op.value === "string" ? op.value : String(op.value)}`;
    case "deleteParam":
      return `Delete parameter ${op.name}`;
    case "renameParam":
      return `Rename parameter ${op.old} → ${op.new}`;
    case "setRollback":
      return op.after === null ? "Roll forward to the end" : `Roll back to ${op.after}`;
    case "setAppearance":
      return op.color === null ? `Reset colour of ${op.feature}` : `Colour ${op.feature} ${op.color}`;
    case "setAuthor":
      return op.author === "user" ? `Keep ${op.features.length === 1 ? op.features[0] : `${op.features.length} features`}` : `Mark ${op.features.length} as agent-made`;
  }
}
