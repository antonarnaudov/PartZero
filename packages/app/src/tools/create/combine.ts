/**
 * Combine: join, cut or intersect bodies (click any face of a body to pick it) — the panel over the
 * `combine` command (the IR's `boolean` feature).
 */
import { booleanModelingTool, type BooleanArgs } from "@aicad/model-ops";
import type { AppServices } from "../../services";
import type { FeatureInfo, FieldSpec, PanelSpec, PanelValues, SummaryRow, ToolContext, ToolDefinition } from "../framework/types";
import { itemsOf, modelingPanel, PanelArgError, type PreviewInfo } from "./kit";
import { NAME_FIELD } from "./extrude";
import { bodiesOfItems, bodyNames, needsV1 } from "./model";

function fields(edit: boolean): FieldSpec[] {
  return [
    {
      key: "operation",
      label: "Operation",
      kind: "choice",
      options: [
        { value: "join", label: "Join" },
        { value: "cut", label: "Cut" },
        { value: "intersect", label: "Intersect" },
      ],
      default: "join",
    },
    { key: "targets", label: "Target bodies", kind: "selection", accepts: ["body", "face"], min: edit ? 0 : 1, hint: edit ? "Empty: keep its targets" : "The bodies that are kept (click a face of each)" },
    { key: "tools", label: "Tool bodies", kind: "selection", accepts: ["body", "face"], min: edit ? 0 : 1, fromSelection: false, hint: edit ? "Empty: keep its tools" : "The bodies joined, cut away or intersected" },
    { key: "keep_tools", label: "Keep tools", kind: "toggle", default: false },
    ...(edit ? [NAME_FIELD] : []),
  ];
}

function args(values: PanelValues, feature: string | null): BooleanArgs {
  const targets = bodiesOfItems(itemsOf(values["targets"]));
  const tools = bodiesOfItems(itemsOf(values["tools"]));
  if (!feature && targets.length === 0) throw new PanelArgError("targets", "Pick the target bodies.");
  if (!feature && tools.length === 0) throw new PanelArgError("tools", "Pick the tool bodies.");
  const both = targets.filter((t) => tools.includes(t));
  if (both.length) throw new PanelArgError("tools", `${both[0]} is a target too: a body is a target or a tool, not both.`, "BOOLEAN_TOOL_IS_TARGET");
  const name = typeof values["name"] === "string" && values["name"] !== "" ? values["name"] : undefined;
  return {
    ...(feature ? { feature } : {}),
    operation: String(values["operation"] ?? "join") as BooleanArgs["operation"],
    ...(targets.length ? { targets } : {}),
    ...(tools.length ? { tools } : {}),
    keep_tools: values["keep_tools"] === true,
    ...(name ? { name } : {}),
  };
}

function summary(_values: PanelValues, info: PreviewInfo): SummaryRow[] {
  const bodies = info.entry?.bodies ?? [];
  const removed = info.entry?.removed?.length ?? 0;
  return [
    { label: "Result", value: `${bodies.length} bod${bodies.length === 1 ? "y" : "ies"}` },
    ...(removed ? [{ label: "Consumed", value: String(removed) }] : []),
  ];
}

function panel(services: AppServices, feature: FeatureInfo | null, initial: PanelSpec["initial"]): PanelSpec {
  return modelingPanel(services, {
    tool: booleanModelingTool,
    title: feature ? `Edit ${feature.name ?? feature.id}` : "Combine",
    icon: "combine",
    description: "Join, cut or intersect bodies",
    fields: fields(feature !== null),
    ...(initial ? { initial } : {}),
    args: (values) => args(values, feature?.id ?? null),
    codeField: { BOOLEAN_NO_INTERSECTION: "tools", BOOLEAN_EMPTY_RESULT: "operation", BOOLEAN_TOOL_IS_TARGET: "tools", MODEL_UNKNOWN_BODY: "targets" },
    summary,
  });
}

export const combineTool: ToolDefinition = {
  id: "feature.combine",
  label: "Combine",
  group: "modify",
  icon: "combine",
  order: 60,
  description: "Join, cut or intersect bodies",
  accepts: ["body", "face"],
  features: ["boolean"],
  enabledWhen(ctx) {
    const v1 = needsV1(ctx, "Combine");
    if (v1) return v1;
    return bodyNames(ctx.services).length >= 2 ? true : { reason: "Combine needs two bodies (Extrude with New body)." };
  },
  activate(ctx: ToolContext): PanelSpec {
    return panel(ctx.services, null, undefined);
  },
  fromFeature(feature: FeatureInfo, ctx: ToolContext): PanelSpec {
    const a = booleanModelingTool.argsOf!(feature.json as never, null as never);
    return panel(ctx.services, feature, { operation: a.operation ?? "join", keep_tools: a.keep_tools === true, targets: [], tools: [], name: feature.name ?? feature.id });
  },
};
