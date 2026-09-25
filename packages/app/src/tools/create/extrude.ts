/**
 * Extrude (E): the panel over the `extrude` command (model-ops). Profile, distance (a number or a
 * parameter expression) with a drag arrow, one side / flip / symmetric, new body / join / cut /
 * intersect with target bodies (click any face of a body), a live checked preview, and re-editing
 * an extrude from the timeline.
 */
import { extrudeModelingTool, type ExtrudeArgs } from "@aicad/model-ops";
import type { AppServices } from "../../services";
import type { ChoiceFieldSpec, FeatureInfo, FieldSpec, PanelHandle, PanelSpec, PanelValues, SummaryRow, ToolContext, ToolDefinition } from "../framework/types";
import { formatHandleValue } from "../framework/session";
import { frameOfSketch, itemsOf, modelingPanel, numberOf, PanelArgError, pickName, profileCenter, scalarArg, v3, worldOf, type PreviewInfo } from "./kit";
import { bodiesOfItems, needsV1, pickItem, selectedSketch, sketchesOf, type ModelFeature } from "./model";

export const DIRECTIONS: ChoiceFieldSpec["options"] = [
  { value: "normal", label: "One side" },
  { value: "reverse", label: "Flip" },
  { value: "symmetric", label: "Symmetric" },
];

export const OPERATIONS: ChoiceFieldSpec["options"] = [
  { value: "new_body", label: "New body" },
  { value: "join", label: "Join" },
  { value: "cut", label: "Cut" },
  { value: "intersect", label: "Intersect" },
];

export const NAME_FIELD: FieldSpec = {
  key: "name",
  label: "Name",
  kind: "text",
  optional: true,
  pattern: /^[A-Za-z_][A-Za-z0-9_]{0,63}$/,
  patternMessage: "Letters, digits and _; not starting with a digit.",
};

export const TARGETS_FIELD: FieldSpec = {
  key: "targets",
  label: "Bodies",
  kind: "selection",
  accepts: ["body", "face"],
  min: 0,
  fromSelection: false,
  hint: "Click a face of each body; empty: every body",
  visibleWhen: (v) => v["operation"] !== "new_body",
};

function fields(sketches: readonly ModelFeature[], edit: boolean): FieldSpec[] {
  return [
    {
      key: "sketch",
      label: "Profile",
      kind: "choice",
      style: "dropdown",
      options: sketches.map((s) => ({ value: s.id, label: s.name })),
      ...(sketches.length ? { default: sketches[sketches.length - 1]!.id } : {}),
      hint: "The sketch whose closed regions are extruded",
    },
    {
      key: "extent",
      label: "Extent",
      kind: "choice",
      options: [
        { value: "distance", label: "Distance" },
        { value: "through_all", label: "Through all", hint: "Cut through every body, however thick" },
        { value: "up_to", label: "Up to", hint: "End on a parallel face or plane (it follows it)" },
      ],
      default: "distance",
    },
    { key: "distance", label: "Distance", kind: "number", quantity: "length", min: 0, minExclusive: true, default: "10 mm", visibleWhen: (v) => v["extent"] === "distance" },
    { key: "upTo", label: "Up to", kind: "selection", accepts: ["face", "datum", "origin"], min: 0, max: 1, fromSelection: false, hint: "A planar face or plane parallel to the sketch", visibleWhen: (v) => v["extent"] === "up_to" },
    { key: "direction", label: "Direction", kind: "choice", options: DIRECTIONS, default: "normal" },
    { key: "operation", label: "Operation", kind: "choice", options: OPERATIONS, default: "new_body" },
    TARGETS_FIELD,
    ...(edit ? [NAME_FIELD] : []),
  ];
}

function args(values: PanelValues, feature: string | null): ExtrudeArgs {
  const sketch = String(values["sketch"] ?? "");
  if (!sketch) throw new PanelArgError("sketch", "Draw a sketch first.");
  const extent = String(values["extent"] ?? "distance") as NonNullable<ExtrudeArgs["extent"]>;
  const operation = String(values["operation"] ?? "new_body") as ExtrudeArgs["operation"];
  const how: Partial<ExtrudeArgs> = { extent };
  if (extent === "distance") {
    const distance = scalarArg(values["distance"]);
    if (distance === undefined) throw new PanelArgError("distance", "Enter a distance.");
    how.distance = distance;
  } else if (extent === "through_all") {
    if (operation !== "cut" && operation !== "intersect") throw new PanelArgError("operation", "Through all cuts: choose Cut (or Intersect).", "EXTENT_NEEDS_CUT");
  } else {
    const plane = itemsOf(values["upTo"])[0];
    if (plane) how.up_to = pickName(plane);
    else if (!feature) throw new PanelArgError("upTo", "Pick the face or plane to extrude up to.");
  }
  const bodies = bodiesOfItems(itemsOf(values["targets"]));
  const name = typeof values["name"] === "string" && values["name"] !== "" ? values["name"] : undefined;
  return {
    ...(feature ? { feature } : {}),
    sketch,
    ...how,
    direction: String(values["direction"] ?? "normal") as ExtrudeArgs["direction"],
    operation,
    // Empty: every body (a re-edit keeps the targets it has).
    ...(operation !== "new_body" && (bodies.length || !feature) ? { targets: bodies.length ? bodies : ("all" as const) } : {}),
    ...(name ? { name } : {}),
  };
}

/** The distance arrow: from the profile's centre on the sketch plane along the extrude direction. */
function handles(values: PanelValues, info: PreviewInfo | null): PanelHandle[] {
  if (!info || (values["extent"] ?? "distance") !== "distance") return [];
  const sketch = String(values["sketch"] ?? "");
  const frame = frameOfSketch(info.ctx, sketch);
  const d = numberOf(values["distance"]);
  if (!frame || d === null) return [];
  const c = profileCenter(info.ctx.report, sketch) ?? [0, 0];
  const origin = worldOf(frame, c);
  const direction = String(values["direction"] ?? "normal");
  const symmetric = direction === "symmetric";
  const axis = direction === "reverse" ? v3.scale(frame.normal, -1) : frame.normal;
  return [
    {
      id: "distance",
      field: "distance",
      kind: "pushPull",
      origin,
      axis,
      value: symmetric ? d / 2 : d,
      min: 0.001,
      label: "Distance",
      ...(symmetric ? { toText: (v: number) => formatHandleValue(v * 2) } : {}),
    },
  ];
}

function summary(_values: PanelValues, info: PreviewInfo): SummaryRow[] {
  const bodies = info.entry?.bodies ?? [];
  if (bodies.length === 0) return [];
  const volume = bodies.reduce((s, b) => s + b.volume, 0);
  const created = bodies.filter((b) => b.change === "created").length;
  return [{ label: created ? `${created} new bod${created === 1 ? "y" : "ies"}` : "Changes", value: `${(volume / 1000).toFixed(2)} cm³` }];
}

function panel(services: AppServices, sketches: readonly ModelFeature[], feature: FeatureInfo | null, initial: PanelSpec["initial"]): PanelSpec {
  return modelingPanel(services, {
    tool: extrudeModelingTool,
    title: feature ? `Edit ${feature.name ?? feature.id}` : "Extrude",
    icon: "extrude",
    description: "Pulls the profile's closed regions along the sketch normal",
    fields: fields(sketches, feature !== null),
    ...(initial ? { initial } : {}),
    ...(feature ? {} : { apply: true }),
    args: (values) => args(values, feature?.id ?? null),
    argField: { up_to: "upTo" },
    codeField: {
      INVALID_DISTANCE: "distance",
      BOOLEAN_NO_INTERSECTION: "operation",
      BOOLEAN_EMPTY_RESULT: "operation",
      BOOLEAN_TARGETS_REQUIRED: "targets",
      SKETCH_NO_REGIONS: "sketch",
      UNRESOLVED_SKETCH: "sketch",
      EXTRUDE_UP_TO_NOT_PARALLEL: "upTo",
      EXTRUDE_UP_TO_BEHIND: "upTo",
      PLANE_NOT_PLANAR: "upTo",
      EXTRUDE_EXTENT_CONFLICT: "extent",
    },
    handles,
    summary,
  });
}

export const extrudeTool: ToolDefinition = {
  id: "feature.extrude",
  label: "Extrude",
  group: "create",
  icon: "extrude",
  shortcut: "E",
  order: 10,
  description: "Pull a sketch's closed regions into a solid: new body, join, cut or intersect",
  accepts: ["feature"],
  features: ["extrude"],
  enabledWhen(ctx) {
    const v1 = needsV1(ctx, "Extrude");
    if (v1) return v1;
    return sketchesOf(ctx.services).length > 0 ? true : { reason: "Draw a sketch first (Sketch, ⇧S)." };
  },
  activate(ctx: ToolContext): PanelSpec {
    const sketches = sketchesOf(ctx.services);
    const picked = selectedSketch(ctx, sketches);
    return panel(ctx.services, sketches, null, picked ? { sketch: picked } : undefined);
  },
  fromFeature(feature: FeatureInfo, ctx: ToolContext): PanelSpec {
    const a = extrudeModelingTool.argsOf!(feature.json as never, null as never);
    const upTo = a.up_to ? pickItem(a.up_to, ctx) : null;
    return panel(ctx.services, sketchesOf(ctx.services), feature, {
      sketch: String(a.sketch),
      extent: a.extent ?? "distance",
      ...(a.distance !== undefined ? { distance: String(a.distance) } : {}),
      ...(upTo ? { upTo: [upTo] } : {}),
      direction: a.direction ?? "normal",
      operation: a.operation ?? "new_body",
      name: feature.name ?? feature.id,
    });
  },
};
