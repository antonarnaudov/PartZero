/**
 * Revolve: the panel over the `revolve` command. Profile, axis (the sketch's vertical or horizontal
 * axis, or one of its lines — a construction line drawn for it), angle with a rotate ring, one side /
 * flip / both sides, and the body operation.
 */
import { revolveModelingTool, solvedCurves, type RevolveArgs } from "@aicad/model-ops";
import type { AppServices } from "../../services";
import type { ChoiceFieldSpec, FeatureInfo, FieldSpec, PanelHandle, PanelSpec, PanelValues, ToolContext, ToolDefinition } from "../framework/types";
import { formatHandleValue } from "../framework/session";
import { appModelingContext, frameOfSketch, itemsOf, modelingPanel, numberOf, PanelArgError, profileCenter, scalarArg, v3, worldOf, type PreviewInfo } from "./kit";
import { NAME_FIELD, OPERATIONS, TARGETS_FIELD } from "./extrude";
import { bodiesOfItems, needsV1, selectedSketch, sketchesOf, type ModelFeature } from "./model";

const REVOLVE_DIRECTIONS: ChoiceFieldSpec["options"] = [
  { value: "normal", label: "One side" },
  { value: "reverse", label: "Flip" },
  { value: "symmetric", label: "Both sides" },
];

/** Axis choices: the sketch's axes and every line of the model's sketches (`sketch:line`). */
function axisOptions(sketches: readonly ModelFeature[], report: unknown): ChoiceFieldSpec["options"] {
  const out: Array<{ value: string; label: string; hint?: string }> = [
    { value: "v", label: "Sketch vertical axis (V)" },
    { value: "u", label: "Sketch horizontal axis (U)" },
  ];
  for (const s of sketches) {
    for (const c of solvedCurves(report as never, s.id) ?? []) {
      if (c.kind !== "line") continue;
      out.push({ value: `${s.id}:${c.id}`, label: `${s.name} · ${c.id}${c.construction ? " (construction)" : ""}` });
    }
  }
  return out;
}

function fields(sketches: readonly ModelFeature[], axes: ChoiceFieldSpec["options"], edit: boolean): FieldSpec[] {
  return [
    {
      key: "sketch",
      label: "Profile",
      kind: "choice",
      style: "dropdown",
      options: sketches.map((s) => ({ value: s.id, label: s.name })),
      ...(sketches.length ? { default: sketches[sketches.length - 1]!.id } : {}),
    },
    { key: "axis", label: "Axis", kind: "choice", style: "dropdown", options: axes, default: "v", hint: "A line of the profile's sketch, or its axes" },
    { key: "angle", label: "Angle", kind: "number", quantity: "angle", min: 0, minExclusive: true, max: 360, default: "360", step: 15 },
    { key: "direction", label: "Direction", kind: "choice", options: REVOLVE_DIRECTIONS, default: "normal" },
    { key: "operation", label: "Operation", kind: "choice", options: OPERATIONS, default: "new_body" },
    TARGETS_FIELD,
    ...(edit ? [NAME_FIELD] : []),
  ];
}

function args(values: PanelValues, feature: string | null, keepAxis: boolean): RevolveArgs {
  const sketch = String(values["sketch"] ?? "");
  if (!sketch) throw new PanelArgError("sketch", "Draw a profile sketch first.");
  const angle = scalarArg(values["angle"]);
  if (angle === undefined) throw new PanelArgError("angle", "Enter an angle.");
  const axisValue = String(values["axis"] ?? "v");
  let axis: string | undefined;
  if (axisValue === "u" || axisValue === "v") axis = axisValue;
  else if (axisValue === "keep") axis = undefined;
  else {
    const [s, line] = axisValue.split(":");
    if (s !== sketch) throw new PanelArgError("axis", "That line is in another sketch: pick a line of the profile's sketch, or one of its axes.", "AXIS_OTHER_SKETCH");
    axis = line;
  }
  const operation = String(values["operation"] ?? "new_body") as RevolveArgs["operation"];
  const bodies = bodiesOfItems(itemsOf(values["targets"]));
  const name = typeof values["name"] === "string" && values["name"] !== "" ? values["name"] : undefined;
  return {
    ...(feature ? { feature } : {}),
    sketch,
    ...(axis !== undefined || !keepAxis ? { axis: axis ?? "v" } : {}),
    angle,
    direction: String(values["direction"] ?? "normal") as RevolveArgs["direction"],
    operation,
    ...(operation !== "new_body" && (bodies.length || !feature) ? { targets: bodies.length ? bodies : ("all" as const) } : {}),
    ...(name ? { name } : {}),
  };
}

/** The angle ring: about the revolve axis, its zero toward the profile. */
function handles(values: PanelValues, info: PreviewInfo): PanelHandle[] {
  const sketch = String(values["sketch"] ?? "");
  const frame = frameOfSketch(info.ctx, sketch);
  const angle = numberOf(values["angle"]);
  const feature = info.plan.feature;
  const f = feature ? (JSON.parse(info.candidate) as { parts: Array<{ features: Array<Record<string, unknown>> }> }).parts.flatMap((p) => p.features).find((x) => x["id"] === feature) : null;
  const axis = f?.["axis"] as { origin?: unknown[]; direction?: unknown[] } | undefined;
  if (!frame || angle === null || !axis || !axis.origin?.every((x) => typeof x === "number") || !axis.direction?.every((x) => typeof x === "number")) return [];
  const o = axis.origin as [number, number];
  const d = axis.direction as [number, number];
  const origin = worldOf(frame, o);
  const dir = v3.unit(v3.add(v3.scale(frame.x, d[0]), v3.scale(frame.y, d[1])));
  const c = profileCenter(info.ctx.report, sketch);
  let ref = c ? v3.sub(worldOf(frame, c), origin) : frame.normal;
  ref = v3.sub(ref, v3.scale(dir, v3.dot(ref, dir)));
  if (v3.norm(ref) < 1e-9) ref = frame.normal;
  const direction = String(values["direction"] ?? "normal");
  const symmetric = direction === "symmetric";
  const axisSign = direction === "reverse" ? -1 : 1;
  return [
    {
      id: "angle",
      field: "angle",
      kind: "rotate",
      origin,
      axis: v3.scale(dir, axisSign),
      ref: v3.unit(ref),
      value: symmetric ? angle / 2 : angle,
      min: 0.5,
      max: symmetric ? 180 : 360,
      label: "Angle",
      ...(symmetric ? { toText: (v: number) => formatHandleValue(v * 2) } : {}),
    },
  ];
}

function panel(services: AppServices, sketches: readonly ModelFeature[], axes: ChoiceFieldSpec["options"], feature: FeatureInfo | null, initial: PanelSpec["initial"]): PanelSpec {
  return modelingPanel(services, {
    tool: revolveModelingTool,
    title: feature ? `Edit ${feature.name ?? feature.id}` : "Revolve",
    icon: "revolve",
    description: "Sweeps the profile's closed regions about an axis in its plane",
    fields: fields(sketches, axes, feature !== null),
    ...(initial ? { initial } : {}),
    ...(feature ? {} : { apply: true }),
    args: (values) => args(values, feature?.id ?? null, feature !== null),
    codeField: { INVALID_ANGLE: "angle", INVALID_AXIS: "axis", REVOLVE_CROSSES_AXIS: "axis", SKETCH_NO_REGIONS: "sketch", BOOLEAN_NO_INTERSECTION: "operation" },
    handles,
  });
}

async function axisChoices(ctx: ToolContext, sketches: readonly ModelFeature[]): Promise<ChoiceFieldSpec["options"]> {
  try {
    const m = await appModelingContext(ctx.services);
    return axisOptions(sketches, m.report);
  } catch {
    return axisOptions(sketches, null);
  }
}

export const revolveTool: ToolDefinition = {
  id: "feature.revolve",
  label: "Revolve",
  group: "create",
  icon: "revolve",
  order: 20,
  description: "Sweep a sketch's closed regions about an axis: a sketch line or the sketch's axes",
  accepts: ["feature"],
  features: ["revolve"],
  enabledWhen(ctx) {
    const v1 = needsV1(ctx, "Revolve");
    if (v1) return v1;
    return sketchesOf(ctx.services).length > 0 ? true : { reason: "Draw a profile sketch first (Sketch, ⇧S)." };
  },
  async activate(ctx: ToolContext): Promise<PanelSpec> {
    const sketches = sketchesOf(ctx.services);
    const picked = selectedSketch(ctx, sketches);
    const axes = await axisChoices(ctx, sketches);
    const sketch = picked ?? sketches[sketches.length - 1]?.id;
    // Prefer a construction line of the profile's sketch (drawn to be the axis).
    const own = axes.find((o) => o.value.startsWith(`${sketch}:`) && o.label.endsWith("(construction)"));
    return panel(ctx.services, sketches, axes, null, { ...(picked ? { sketch: picked } : {}), ...(own ? { axis: own.value } : {}) });
  },
  async fromFeature(feature: FeatureInfo, ctx: ToolContext): Promise<PanelSpec> {
    const sketches = sketchesOf(ctx.services);
    const a = revolveModelingTool.argsOf!(feature.json as never, null as never);
    const axes = [...(await axisChoices(ctx, sketches))];
    let axis = typeof a.axis === "string" ? a.axis : "keep";
    if (axis === "keep") axes.unshift({ value: "keep", label: "Keep the current axis" });
    else if (axis !== "u" && axis !== "v") axis = "v";
    return panel(ctx.services, sketches, axes, feature, {
      sketch: String(a.sketch),
      axis,
      ...(a.angle !== undefined ? { angle: String(a.angle) } : {}),
      direction: a.direction ?? "normal",
      operation: a.operation ?? "new_body",
      name: feature.name ?? feature.id,
    });
  },
};
