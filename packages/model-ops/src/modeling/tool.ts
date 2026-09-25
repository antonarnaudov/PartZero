/**
 * Modeling tools as commands (FULL-MODELING-PLAN §2.1, §2.5; the owner's rule: every hand tool is a
 * first-class command the AI can call and chain). A modeling tool — Extrude, Revolve, Hole, Datum
 * plane, Datum axis, Boolean, Push/pull — is **one definition** here:
 *
 * - typed arguments (zod), the same keys the property panel's fields use;
 * - `build(args, ctx)`: the catalogue ops the tool commits (`addFeature` of the feature it makes, or
 *   `updateFeature` / `renameFeature` / `setParam` when it edits one), as ONE transaction;
 * - `argsOf(feature)`: the arguments that reproduce an existing feature (re-editing it).
 *
 * The app's panel tools (`packages/app/src/tools/create`), its `model.*` commands, the agent's
 * tools and MCP all call `build` with the same arguments, then apply the ops through the same
 * transaction (the failure rule, ADR 0015 authorship): the UI and the agent run the same command.
 *
 * Selections travel as provenance names (`e1/cap:end`, `plate/extrude1`, `XY`): `keys.ts` turns
 * them into named queries. Numbers are a number (mm, degrees) or a parameter expression text.
 */
import { z } from "zod";
import type { HostState } from "../apply.js";
import { applyOp, EMPTY_HOST_STATE } from "../apply.js";
import type { IrOp } from "../catalogue.js";
import { isObject, nextFeatureId, parseDoc, requirePart, type DocJson, type FeatureJson, type JsonObject } from "../doc.js";
import type { IrCommandEngine } from "../engine.js";
import { CommandEngineError } from "../engine.js";
import { argError, featureOf, type ReportLike } from "./keys.js";

// ─── Arguments ──────────────────────────────────────────────────────────────────────────────

/** A number in the field's unit (mm, degrees) or a parameter expression (`"wall * 2"`, `"12 mm"`). */
export const ScalarArg = z.union([z.number().finite(), z.string().min(1).max(4096)]);
export const IdArg = z.string().min(1).max(200);
/** A picked entity by provenance name: a face (`e1/cap:end`), an edge, a body (`part/extrude1`), a plane (`XY`), … */
export const PickArg = z.string().min(1).max(4096);
export const Vec3Arg = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const OperationArg = z.enum(["new_body", "join", "cut", "intersect"]);
export const DirectionArg = z.enum(["normal", "reverse", "symmetric"]);
/** `"all"` (every body of the part) or picked bodies. */
export const TargetsArg = z.union([z.literal("all"), z.array(PickArg).min(1).max(1000)]);

export type Scalar = z.infer<typeof ScalarArg>;

// ─── Context and result ─────────────────────────────────────────────────────────────────────

export interface ModelingContext {
  /** The current document (canonical `aicad.ir/1` text). */
  document: string;
  /** The rollback marker and appearance (new features go at the marker). */
  host: HostState;
  /** The current document's report (frames, probes, solved sketches, body members); null when unknown. */
  report: ReportLike | null;
  /** The engine: tools that need geometry the report does not list (a face's frame) evaluate probes. */
  engine: IrCommandEngine | null;
}

export interface ModelingPlan {
  /** The ops of the change: ONE transaction. Empty: nothing to change. */
  ops: IrOp[];
  /** The undo label. */
  label: string;
  /** The feature the tool adds or edits (its id), for previews that roll back to it. */
  feature: string | null;
  /** True when the tool adds a feature (false: it edits one). */
  adds: boolean;
}

export interface ModelingTool<A extends Record<string, unknown> = Record<string, unknown>> {
  /** `extrude`, `revolve`, `hole`, `datum_plane`, `datum_axis`, `boolean`, `push_pull`. */
  id: string;
  title: string;
  /** The agent / MCP tool name. */
  agentTool: string;
  /** For people and models: what it does, its arguments, what refuses it. */
  description: string;
  args: z.ZodType<A>;
  /** Feature types it re-edits (`argsOf`). */
  featureTypes: readonly string[];
  build(args: A, ctx: ModelingContext): Promise<ModelingPlan>;
  /** The arguments that reproduce `feature` (for re-editing it with the same fields). */
  argsOf?(feature: FeatureJson, ctx: ModelingContext): Partial<A>;
}

export function defineModelingTool<A extends Record<string, unknown>>(t: ModelingTool<A>): ModelingTool<A> {
  return t;
}

// ─── Helpers the tools share ────────────────────────────────────────────────────────────────

/** A scalar as IR: a number, or an expression text (trimmed); plain numeric text becomes a number. */
export function irScalar(v: Scalar): number | string {
  if (typeof v === "number") return v;
  const t = v.trim();
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i.test(t)) return Number(t);
  return t;
}

/** The part a new feature goes into: the part of `near` (a feature id or name), else the first. */
export function partFor(doc: DocJson, near: string | null | undefined): string {
  if (near) {
    for (const p of doc.parts) if (p.features.some((f) => f.id === near || f.name === near)) return p.id;
  }
  return requirePart(doc, undefined).part.id;
}

/** The feature to edit, of one of `types`, or a refusal on `field`. */
export function editTarget(doc: DocJson, idOrName: string, types: readonly string[], field = "feature"): FeatureJson {
  const f = featureOf(doc, idOrName);
  if (!f) throw new CommandEngineError("COMMAND_UNKNOWN_FEATURE", `there is no feature ${JSON.stringify(idOrName)}`, [], { field, feature: idOrName });
  if (!types.includes(f.type)) throw argError(field, `${f.name} is a ${f.type}; this tool edits ${types.join(" or ")} features`, "MODEL_WRONG_FEATURE_TYPE", { feature: f.id, type: f.type });
  return f;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Top-level fields the tools own on a feature (others — `note`, `author`, `suppressed` — are kept). */
export interface FeaturePlan {
  /** The feature JSON without `id` / `name` (its tool-owned fields; `undefined` = absent). */
  fields: Record<string, unknown>;
  /** A new name (optional). */
  name?: string | undefined;
}

/**
 * The ops of a tool's result: `addFeature` (a new id `<type><n>`) when adding, or the minimal
 * `updateFeature` (merge patch: changed fields, `null` for removed ones) plus `renameFeature` when
 * editing `existing`.
 */
export function featureOps(doc: DocJson, type: string, plan: FeaturePlan, existing: FeatureJson | null, owned: readonly string[], part: string, label: string): ModelingPlan {
  if (!existing) {
    const id = nextFeatureId(doc, type);
    const feature: JsonObject = { type, id, ...(plan.name ? { name: plan.name } : {}) };
    for (const [k, v] of Object.entries(plan.fields)) if (v !== undefined) feature[k] = v;
    return { ops: [{ op: "addFeature", part, feature: feature as { type: string } & JsonObject }], label, feature: id, adds: true };
  }
  const set: Record<string, unknown> = {};
  for (const k of owned) {
    const next = plan.fields[k];
    const prev = existing[k];
    if (next === undefined) {
      if (prev !== undefined) set[k] = null;
    } else if (!jsonEqual(next, prev)) set[k] = next;
  }
  const ops: IrOp[] = [];
  if (Object.keys(set).length > 0) ops.push({ op: "updateFeature", feature: existing.id, set });
  if (plan.name && plan.name !== existing.name) ops.push({ op: "renameFeature", feature: existing.id, name: plan.name });
  return { ops, label, feature: existing.id, adds: false };
}

/** Parse the document once (a tool's context carries the text). */
export function docOf(ctx: ModelingContext): DocJson {
  return parseDoc(ctx.document);
}

/** A value of a feature's field as a tool argument (a Scalar as written; objects as JSON). */
export function scalarOf(v: unknown): Scalar | undefined {
  if (typeof v === "number" || (typeof v === "string" && v.length > 0)) return v;
  return undefined;
}

export { isObject };

// ─── Preview: the ops applied without committing ────────────────────────────────────────────

export interface PlanPreview {
  /** The candidate document after the ops (canonical text). */
  document: string;
  /** The host state after the ops (the rollback marker moves past a feature added at it). */
  host: HostState;
}

/**
 * Apply a plan's ops to `document` for review only (nothing is committed anywhere): the same op
 * implementations the transaction runs, so an argument the engine refuses is refused here with the
 * same code and path.
 */
export async function previewPlan(engine: IrCommandEngine, document: string, host: HostState | null, ops: readonly IrOp[]): Promise<PlanPreview> {
  let doc = document;
  let h = host ?? EMPTY_HOST_STATE;
  for (const op of ops) {
    const o = await applyOp(engine, doc, op, { preview: true, host: h, origin: "user" });
    doc = o.document;
    if (o.host) h = o.host;
  }
  return { document: doc, host: h };
}
