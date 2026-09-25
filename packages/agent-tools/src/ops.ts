/**
 * The command layer's ops as agent tools (FULL-MODELING-PLAN §2.1 rule 3): **generated from the op
 * catalogue** (`@aicad/model-ops` `OP_CATALOGUE`, one zod definition per op), so the agent and MCP
 * clients operate the same tools the user does — add a sketch, extrude it, set a field, suppress,
 * reorder, delete, add and set parameters — instead of writing code. Every call is one
 * transaction on the host's document ({@link OpsHost}: the app's live document, or an in-memory one
 * for headless MCP and evals), refused whole when any op is refused.
 *
 * Host-only ops (`setAuthor`: ADR 0015's "Keep") have no tool; a snapshot test fails when a
 * catalogue op has neither a tool nor a place on the host-only list.
 *
 * JSON-valued arguments (a feature, a field value, a merge patch, an op list) travel as JSON text
 * (`feature_json`, `value_json`, `set_json`, `ops_json`): strict tool schemas close every object,
 * so a free-form object could not pass through them otherwise.
 *
 * Every tool that changes the model takes an optional `note`: one line for the user's chat (the
 * live agent narrates each step with it). A committed change is followed by Forge's check of the
 * whole model (statuses, the touched features' warnings, bodies and their validity); a refusal
 * carries its op-worded repair hint (`ops-playbooks.ts`). The read-only tools that find entities by
 * semantic references, measure and check the model are in `ops-query.ts`.
 */
import {
  CommandEngineError,
  dependents,
  HOST_ONLY_OPS,
  IrOpSchema,
  OP_CATALOGUE,
  OP_SCHEMAS,
  paramUses,
  parseDoc,
  type IrOp,
  type IrOpName,
  type OpsCommit,
  type OpsHost,
} from "@aicad/model-ops";
import type { metricsV1 } from "@aicad/ir-types";
import { z } from "zod";
import { clip, oneLine } from "./format.js";
import { opsRepairHint } from "./ops-playbooks.js";
import { opsQueryTools, stepCheck } from "./ops-query.js";
import { defineTool, ToolRegistry, type AgentTool, type ToolOutput } from "./registry.js";

/** What the op tools run against. */
export interface OpsToolContext {
  ops: OpsHost;
  /** Ask/explain mode: tools that change the model refuse. */
  readOnly?: boolean;
}

/** Arguments that carry JSON values, per op: sent as `<name>_json` text. */
const JSON_ARGS: Partial<Record<IrOpName, readonly string[]>> = {
  addFeature: ["feature"],
  setField: ["value"],
  updateFeature: ["set"],
};

const Ack = z
  .array(z.string().min(1).max(200))
  .max(1000)
  .optional()
  .describe(
    "The ids of the newly failing features to accept, exactly as a COMMAND_NEW_FAILURES refusal listed them. Only your own (agent-authored) features: making one of the user's features fail is refused (unapproved_user_change); ask the user instead.",
  );

function errorText(e: unknown): string {
  if (e instanceof CommandEngineError) {
    const details = Object.keys(e.details).length ? ` details: ${clip(JSON.stringify(e.details), 1200)}` : "";
    const errors = e.errors.length ? ` problems: ${clip(JSON.stringify(e.errors.slice(0, 5)), 1200)}` : "";
    const fix = opsRepairHint({ code: e.code, details: e.details, errors: e.errors });
    return `Refused (${e.code}): ${e.message}.${errors}${details} Nothing was changed.\nfix: ${fix.join(" ")}`;
  }
  return `Refused: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`;
}

/** The inner code of a refusal (`COMMAND_FEATURE_FAILS` → the feature's own code), for signatures and narration. */
function innerCode(e: CommandEngineError): string | undefined {
  const c = e.details["code"];
  return typeof c === "string" ? c : e.errors[0]?.code;
}

/** The features a commit added or edited (for the step check's warnings and the narration). */
export function touchedFeatures(c: Pick<OpsCommit, "ops">): string[] {
  const out = new Set<string>();
  for (const o of c.ops) {
    const r = o.result as Record<string, unknown> | null;
    if (r && typeof r["feature"] === "string") out.add(r["feature"]);
    const op = o.op as Record<string, unknown>;
    if (typeof op["feature"] === "string") out.add(op["feature"]);
  }
  return [...out];
}

function commitText(c: OpsCommit, check: string | null): string {
  if (!c.changed) return `No change (${c.label}): the model already was that way.`;
  const results = c.ops
    .filter((o) => o.op.op !== "writeBackSolution")
    .map((o) => `${o.op.op}: ${clip(JSON.stringify(o.result), 400)}`)
    .join("\n");
  const fails = c.newFailures?.length ? `\nAcknowledged newly failing: ${c.newFailures.map((f) => `${f.name} (${f.code})`).join(", ")}.` : "";
  const withheld = c.writeBackWithheld?.length ? `\nSketch solution not written back (would fail): ${c.writeBackWithheld.map((w) => w.sketch).join(", ")}.` : "";
  return `Done: ${c.label} (revision ${c.revision}).\n${results}${fails}${withheld}${check ? `\nCheck: ${check}` : ""}`;
}

/** The optional narration line every model-changing tool takes. */
const Note = z
  .string()
  .max(240)
  .optional()
  .describe('One short line for the user\'s chat saying what this step does, in plain words (e.g. "Sketch the 40 mm base square on XY"). Shown live as you work.');

async function applyOps(ctx: OpsToolContext, name: string, ops: IrOp[], ack: readonly string[] | undefined, label?: string, note?: string): Promise<ToolOutput> {
  if (ctx.readOnly) return { text: `${name} changes the model; this is a read-only session.`, isError: true, data: { kind: "read_only" } };
  const narration = note !== undefined && note.trim() ? oneLine(note, 240) : undefined;
  let c: OpsCommit;
  try {
    c = await ctx.ops.apply(ops, { ...(ack ? { ack } : {}), ...(label ? { label } : {}) });
  } catch (e) {
    const err = e instanceof CommandEngineError ? e : null;
    const code = err?.code ?? "FAILED";
    const inner = err ? innerCode(err) : undefined;
    return {
      text: errorText(e),
      isError: true,
      data: {
        kind: "ops_refused",
        code,
        ...(inner ? { inner } : {}),
        ...(narration ? { note: narration } : {}),
        label: ops.length === 1 ? ops[0]!.op : `${ops.length} edits`,
        message: oneLine(e instanceof Error ? e.message : String(e), 300),
      },
    };
  }
  const touched = touchedFeatures(c);
  const check = c.changed ? await stepCheck(ctx.ops, new Set(touched)) : null;
  const checkText = check ? [check.line, ...check.issues.slice(0, 6)].join("\n  ") : null;
  return {
    text: commitText(c, checkText),
    data: {
      kind: "ops_commit",
      ops: ops.map((o) => o.op),
      changed: c.changed,
      revision: c.revision,
      label: c.label,
      features: touched,
      ...(narration ? { note: narration } : {}),
      ...(check ? { check: check.line, checkOk: check.ok } : {}),
    },
  };
}

function parseJsonArg(name: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new CommandEngineError("COMMAND_BAD_JSON", `${name} is not valid JSON (${(e as Error).message})`);
  }
}

/** The tool of one catalogue op: its schema without `op`, JSON-valued fields as JSON text, plus `ack`. */
function opTool(op: IrOpName, toolName: string, description: string): AgentTool<OpsToolContext, z.ZodObject> {
  const schema = OP_SCHEMAS[op] as unknown as z.ZodObject<z.ZodRawShape>;
  const jsonArgs = JSON_ARGS[op] ?? [];
  const omit: Record<string, true> = { op: true };
  for (const a of jsonArgs) omit[a] = true;
  const extra: Record<string, z.ZodType> = { ack: Ack, note: Note };
  for (const a of jsonArgs) {
    const field = schema.shape[a] as unknown as z.ZodType | undefined;
    const optional = field?.safeParse(undefined).success === true;
    const text = z.string().max(200_000).describe(`The ${a} as JSON text.`);
    extra[`${a}_json`] = optional ? text.optional() : text;
  }
  const input = (schema.omit(omit as never) as z.ZodObject<z.ZodRawShape>).extend(extra);
  return defineTool<OpsToolContext, z.ZodObject>({
    name: toolName,
    description,
    input,
    async run(args, ctx) {
      const { ack, note, ...rest } = args as { ack?: string[]; note?: string } & Record<string, unknown>;
      const raw: Record<string, unknown> = { op };
      try {
        for (const [k, v] of Object.entries(rest)) {
          if (v === undefined) continue;
          const base = k.endsWith("_json") ? k.slice(0, -5) : null;
          if (base && jsonArgs.includes(base)) raw[base] = parseJsonArg(k, String(v));
          else raw[k] = v;
        }
      } catch (e) {
        return { text: errorText(e), isError: true, data: { kind: "ops_refused", code: "COMMAND_BAD_JSON" } };
      }
      const parsed = IrOpSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`);
        return { text: `Invalid ${toolName} arguments: ${issues.join("; ")}. Nothing was changed.`, isError: true, data: { kind: "invalid_input" } };
      }
      return applyOps(ctx, toolName, [parsed.data], ack, undefined, note);
    },
  });
}

/** `apply_ops`: several ops as ONE transaction (atomic), e.g. a parameter and the feature that uses it. */
const applyOpsTool = defineTool<OpsToolContext, z.ZodObject>({
  name: "apply_ops",
  description:
    'Apply several ops as ONE undoable transaction (atomic: if one is refused, none is applied). ops_json: a JSON array of ops, each {"op": "<name>", …} with the same fields as its tool (addFeature, setField, updateFeature, deleteFeature, moveFeature, setSuppressed, renameFeature, addParam, setParam, renameParam, deleteParam, setRollback, setAppearance, …; JSON values inline, not as text). Example: [{"op":"addParam","name":"wall","unit":"mm","value":2},{"op":"setField","feature":"shell1","path":"/thickness","value":{"expr":"wall"}}].',
  input: z.strictObject({
    ops_json: z.string().min(2).max(400_000).describe("A JSON array of ops."),
    label: z.string().max(200).optional().describe("The undo label people see."),
    ack: Ack,
    note: Note,
  }),
  async run(args, ctx) {
    const { ops_json, label, ack, note } = args as { ops_json: string; label?: string; ack?: string[]; note?: string };
    let list: unknown;
    try {
      list = parseJsonArg("ops_json", ops_json);
    } catch (e) {
      return { text: errorText(e), isError: true, data: { kind: "ops_refused", code: "COMMAND_BAD_JSON" } };
    }
    if (!Array.isArray(list) || list.length === 0 || list.length > 100) {
      return { text: "ops_json must be a JSON array of 1 to 100 ops. Nothing was changed.", isError: true, data: { kind: "invalid_input" } };
    }
    const ops: IrOp[] = [];
    for (const [i, raw] of list.entries()) {
      const p = IrOpSchema.safeParse(raw);
      if (!p.success) {
        const issues = p.error.issues.slice(0, 3).map((x) => `${x.path.join(".") || "(op)"}: ${x.message}`);
        return { text: `Op ${i + 1} is invalid: ${issues.join("; ")}. Nothing was changed.`, isError: true, data: { kind: "invalid_input" } };
      }
      if (HOST_ONLY_OPS.has(p.data.op)) return { text: `Op ${i + 1} (${p.data.op}) is the user's to do. Nothing was changed.`, isError: true, data: { kind: "ops_refused", code: "COMMAND_HOST_ONLY" } };
      ops.push(p.data);
    }
    return applyOps(ctx, "apply_ops", ops, ack, label, note);
  },
});

interface FeatureLine {
  id: string;
  name: string;
  type: string;
  author: string;
  status: string;
}

/** `get_model`: parameters, features (id, name, type, author, status), rollback marker and final bodies. */
const getModelTool = defineTool<OpsToolContext, z.ZodObject>({
  name: "get_model",
  description:
    "The model as it is now: parameters (value or expression → evaluated), every feature in timeline order (id, name, type, author, status and its error code), the rollback marker, and the final bodies (volume, bounding box). Read it before editing; ids are what the other tools take.",
  input: z.strictObject({}),
  readOnly: true,
  async run(_args, ctx) {
    const doc = parseDoc(await ctx.ops.document());
    const host = await ctx.ops.hostState();
    let report: metricsV1.EvalReport | null = null;
    try {
      report = await ctx.ops.report();
    } catch {
      report = null;
    }
    const status = new Map((report?.features ?? []).map((f) => [f.feature_id, f.status === "error" ? `error ${f.error?.code ?? ""}`.trim() : f.status]));
    const values = new Map((report?.params ?? []).map((p) => [p.name, p.error ? `error ${p.error.code}` : JSON.stringify(p.value)]));
    const params = [...(doc.params ?? []), ...doc.parts.flatMap((p) => p.params ?? [])].map((p) => {
      const v = p["value"];
      const shown = typeof v === "string" ? `${v} → ${values.get(String(p["name"])) ?? "?"}` : JSON.stringify(v);
      return `${String(p["name"])} (${String(p["unit"])}) = ${shown}`;
    });
    const lines: string[] = [];
    for (const part of doc.parts) {
      lines.push(`part ${part.id} "${part.name}":`);
      const features: FeatureLine[] = part.features.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        author: f["author"] === "agent" ? "agent" : "user",
        status: f["suppressed"] === true ? "suppressed" : (status.get(f.id) ?? "not built"),
      }));
      for (const f of features) lines.push(`  ${f.id} ${f.name} [${f.type}] ${f.status}${f.author === "agent" ? " (agent-made)" : ""}${host.rollback === f.id ? "  ◀ rollback marker" : ""}`);
      if (features.length === 0) lines.push("  (no features)");
    }
    const bodies = (report?.parts ?? []).flatMap((p) =>
      p.bodies.map((b, i) => `${p.part} body ${i + 1}: volume ${b.volume.toFixed(2)} mm³, bbox [${b.bbox_min.map((x) => x.toFixed(2)).join(", ")}] – [${b.bbox_max.map((x) => x.toFixed(2)).join(", ")}]`),
    );
    const text = [`parameters: ${params.length ? `\n  ${params.join("\n  ")}` : "none"}`, ...lines, `bodies: ${bodies.length ? `\n  ${bodies.join("\n  ")}` : "none"}`].join("\n");
    return { text: clip(text, 7000), data: { kind: "model", features: doc.parts.flatMap((p) => p.features.map((f) => f.id)) } };
  },
});

const getFeatureTool = defineTool<OpsToolContext, z.ZodObject>({
  name: "get_feature",
  description: "One feature's IR v1 JSON (by id or name): its fields, for set_field / update_feature paths.",
  input: z.strictObject({ feature: z.string().min(1).max(200) }),
  readOnly: true,
  async run(args, ctx) {
    const { feature } = args as { feature: string };
    const doc = parseDoc(await ctx.ops.document());
    const f = doc.parts.flatMap((p) => p.features).find((x) => x.id === feature || x.name === feature);
    if (!f) return { text: `There is no feature ${feature}; call get_model for the ids.`, isError: true, data: { kind: "unknown_feature" } };
    return { text: clip(JSON.stringify(f, null, 1), 7000), data: { kind: "feature", id: f.id } };
  },
});

const dependentsTool = defineTool<OpsToolContext, z.ZodObject>({
  name: "feature_dependents",
  description: "The features that reference a feature by id (directly or through another dependent): what delete_feature would take with it.",
  input: z.strictObject({ feature: z.string().min(1).max(200) }),
  readOnly: true,
  async run(args, ctx) {
    const { feature } = args as { feature: string };
    try {
      const d = await dependents(ctx.ops.engine(), await ctx.ops.document(), feature);
      return { text: d.dependents.length ? d.dependents.map((x) => `${x.id} ${x.name} [${x.type}] via ${x.code} at ${x.path}`).join("\n") : `Nothing references ${d.feature}.`, data: { kind: "dependents", count: d.dependents.length } };
    } catch (e) {
      return { text: errorText(e), isError: true, data: { kind: "query_failed" } };
    }
  },
});

const paramUsesTool = defineTool<OpsToolContext, z.ZodObject>({
  name: "param_uses",
  description: "Every expression that uses a parameter (feature fields and other parameters), with its path.",
  input: z.strictObject({ name: z.string().min(1).max(200) }),
  readOnly: true,
  async run(args, ctx) {
    const { name } = args as { name: string };
    try {
      const u = await paramUses(ctx.ops.engine(), await ctx.ops.document(), name);
      return { text: u.uses.length ? u.uses.map((x) => `${x.feature ?? x.param ?? ""} ${x.path}: ${x.text}`).join("\n") : `Nothing uses ${name}.`, data: { kind: "param_uses", count: u.uses.length } };
    } catch (e) {
      return { text: errorText(e), isError: true, data: { kind: "query_failed" } };
    }
  },
});

/** Every catalogue op with a tool, generated. */
function catalogueTools(): AgentTool<OpsToolContext, z.ZodObject>[] {
  return OP_CATALOGUE.filter((o) => !o.hostOnly && o.tool).map((o) => opTool(o.op, o.tool!, o.description));
}

/** The op tools and the model reading tools (finding entities by semantic references, measuring, checking). */
export function opTools(): AgentTool<OpsToolContext, z.ZodObject>[] {
  return [...catalogueTools(), applyOpsTool, getModelTool, getFeatureTool, dependentsTool, paramUsesTool, ...(opsQueryTools() as AgentTool<OpsToolContext, z.ZodObject>[])];
}

/** The model reading tools (safe in ask/explain mode and for read-only MCP scopes). */
export const OPS_READ_TOOLS = ["check_model", "feature_dependents", "find_entities", "get_feature", "get_model", "list_entities", "measure", "param_uses"] as const;

/** Every op tool name, sorted: the catalogue's tools, `apply_ops` and the reading tools. */
export const OPS_TOOLS: readonly string[] = [...OP_CATALOGUE.filter((o) => !o.hostOnly && o.tool).map((o) => o.tool!), "apply_ops", ...OPS_READ_TOOLS].sort();

export function opsRegistry(): ToolRegistry<OpsToolContext> {
  return new ToolRegistry(opTools());
}
