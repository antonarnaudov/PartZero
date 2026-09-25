/**
 * Combine (SPEC-v1 §6.4): join, cut or intersect bodies — target bodies with tool bodies, the tools
 * consumed unless kept.
 */
import { z } from "zod";
import { argError, bodiesRef } from "./keys.js";
import { defineModelingTool, docOf, editTarget, featureOps, IdArg, partFor, PickArg } from "./tool.js";

export const BooleanArgs = z.strictObject({
  feature: IdArg.optional().describe("Edit this boolean (id or name) instead of adding one."),
  operation: z.enum(["join", "cut", "intersect"]).optional().describe("join (default), cut (targets minus tools) or intersect."),
  targets: z.array(PickArg).min(1).max(1000).optional().describe("The bodies that are kept and changed, by name (part/extrude1) or by the feature that made them."),
  tools: z.array(PickArg).min(1).max(1000).optional().describe("The bodies joined to, cut from or intersected with the targets."),
  keep_tools: z.boolean().optional().describe("Keep the tool bodies (default: they are consumed)."),
  name: IdArg.optional(),
});
export type BooleanArgs = z.infer<typeof BooleanArgs>;

const OWNED = ["op", "targets", "tools", "keep_tools"] as const;

export const booleanModelingTool = defineModelingTool<BooleanArgs>({
  id: "boolean",
  title: "Combine",
  agentTool: "combine",
  featureTypes: ["boolean"],
  description:
    'Combine bodies (the Combine tool): {operation: join | cut | intersect, targets: [body…], tools: [body…], keep_tools?}. Bodies are named as the viewport shows them (part/extrude1) or by the feature that made them. A body in both lists is refused (BOOLEAN_TOOL_IS_TARGET). Edit: {feature, …changed}.',
  args: BooleanArgs,
  async build(args, ctx) {
    const doc = docOf(ctx);
    const existing = args.feature ? editTarget(doc, args.feature, ["boolean"]) : null;
    const op = args.operation ?? (existing?.["op"] as string | undefined) ?? "join";
    const targets = args.targets ? bodiesRef(doc, args.targets, ctx.report, "targets") : existing?.["targets"];
    const tools = args.tools ? bodiesRef(doc, args.tools, ctx.report, "tools") : existing?.["tools"];
    if (targets === undefined) throw argError("targets", "pick the target bodies", "MODEL_MISSING_ARG");
    if (tools === undefined) throw argError("tools", "pick the tool bodies", "MODEL_MISSING_ARG");
    const keep = args.keep_tools ?? (existing?.["keep_tools"] === true);
    const fields: Record<string, unknown> = { op, targets, tools, ...(keep ? { keep_tools: true } : {}) };
    const part = existing ? partFor(doc, existing.id) : partFor(doc, ctx.host.rollback);
    const verb = op === "cut" ? "Cut" : op === "intersect" ? "Intersect" : "Join";
    return featureOps(doc, "boolean", { fields, name: args.name }, existing, OWNED, part, existing ? `Edit ${existing.name}` : `${verb} bodies`);
  },
  argsOf(f) {
    return { feature: f.id, operation: f["op"] as BooleanArgs["operation"], ...(f["keep_tools"] === true ? { keep_tools: true } : {}), name: f.name };
  },
});
