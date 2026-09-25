/**
 * Push/Pull (Q): pick a face and drag its arrow (or type an offset); the face's driver — the extrude
 * distance, revolve angle, hole diameter or shell thickness that positions it, or the parameter
 * behind it — is edited, never the geometry directly. The panel over the `push_pull` command.
 */
import { faceDriver, parseDoc, pushPullModelingTool, type PushPullArgs } from "@aicad/model-ops";
import type { AppServices } from "../../services";
import type { FieldSpec, PanelHandle, PanelSpec, PanelValues, SummaryRow, ToolContext, ToolDefinition } from "../framework/types";
import { faceGeometry, itemsOf, modelingPanel, numberOf, PanelArgError, scalarArg, type PreviewInfo } from "./kit";
import { bodyNames, needsV1 } from "./model";

const FIELDS: FieldSpec[] = [
  { key: "face", label: "Face", kind: "selection", accepts: ["face"], min: 1, max: 1, hint: "An end cap, a hole wall, a shell face…" },
  { key: "offset", label: "Offset", kind: "number", quantity: "length", default: "0", hint: "Along the face's outward normal; negative pushes in" },
];

function args(values: PanelValues): PushPullArgs {
  const face = itemsOf(values["face"])[0];
  if (!face || face.kind !== "face") throw new PanelArgError("face", "Select a face to push or pull.");
  const offset = scalarArg(values["offset"]);
  if (typeof offset !== "number") throw new PanelArgError("offset", "Enter an offset (a number).", "NOT_A_NUMBER");
  return { face: face.key, offset };
}

function handles(services: AppServices, values: PanelValues): PanelHandle[] {
  const face = itemsOf(values["face"])[0];
  if (!face || face.kind !== "face") return [];
  const g = faceGeometry(services.doc.getState().bodies, face.key);
  const offset = numberOf(values["offset"]);
  if (!g || offset === null) return [];
  return [{ id: "offset", field: "offset", kind: "pushPull", origin: g.center, axis: g.normal, value: offset, label: "Offset" }];
}

function summary(values: PanelValues, info: PreviewInfo): SummaryRow[] {
  const face = itemsOf(values["face"])[0];
  if (!face || face.kind !== "face") return [];
  try {
    const d = faceDriver(parseDoc(info.ctx.document), face.key);
    const op = info.plan.ops[0];
    const to = op?.op === "updateFeature" ? (op.set as Record<string, unknown>)[d.field] : op?.op === "setParam" ? op.value : undefined;
    const from = d.feature[d.field];
    return [
      { label: "Drives", value: d.label },
      ...(op?.op === "setParam" ? [{ label: "Parameter", value: op.name }] : []),
      { label: "Value", value: `${String(from)} → ${String(to ?? from)} ${d.unit}` },
    ];
  } catch {
    return [];
  }
}

export const pushPullTool: ToolDefinition = {
  id: "feature.pushPull",
  label: "Push/Pull",
  group: "modify",
  icon: "pushPull",
  shortcut: "Q",
  order: 5,
  description: "Drag a face: its extrude distance, angle, hole size or wall thickness follows",
  accepts: ["face"],
  enabledWhen(ctx) {
    const v1 = needsV1(ctx, "Push/Pull");
    if (v1) return v1;
    return bodyNames(ctx.services).length > 0 ? true : { reason: "Make a body first (Extrude, E)." };
  },
  activate(ctx: ToolContext): PanelSpec {
    return modelingPanel(ctx.services, {
      tool: pushPullModelingTool,
      title: "Push/Pull",
      icon: "pushPull",
      description: "Moves a face by editing what drives it",
      fields: FIELDS,
      args,
      cut: "marker",
      codeField: { MODEL_NO_DRIVER: "face", MODEL_DERIVED_VALUE: "face", INVALID_DISTANCE: "offset", INVALID_ANGLE: "offset", SHELL_TOO_THICK: "offset" },
      handles: (values) => handles(ctx.services, values),
      summary,
    });
  },
};
