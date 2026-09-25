/**
 * Extrude (SPEC-v1 §6.2): a sketch's closed regions swept along the sketch normal — a distance (a
 * number or a parameter expression), one side, flipped or symmetric, as a new body or joined to,
 * cut from or intersected with target bodies.
 */
import { z } from "zod";
import { bodiesRef, featureOf, argError } from "./keys.js";
import {
  defineModelingTool,
  DirectionArg,
  docOf,
  editTarget,
  featureOps,
  IdArg,
  irScalar,
  OperationArg,
  partFor,
  ScalarArg,
  scalarOf,
  TargetsArg,
  type ModelingContext,
} from "./tool.js";

export const ExtrudeArgs = z.strictObject({
  feature: IdArg.optional().describe("Edit this extrude (id or name) instead of adding one; arguments left out keep their values."),
  sketch: IdArg.optional().describe("The profile: a sketch (id or name) whose closed regions are extruded. Required for a new extrude."),
  regions: z.union([z.literal("all"), z.array(IdArg).min(1).max(1000)]).optional().describe('"all" (default) or the curve ids of the regions to extrude.'),
  distance: ScalarArg.optional().describe("How far (mm), > 0: a number or a parameter expression. Default 10 for a new extrude."),
  direction: DirectionArg.optional().describe("normal (along the sketch normal, default), reverse (the other way), symmetric (half each way)."),
  operation: OperationArg.optional().describe("new_body (default), join, cut or intersect."),
  targets: TargetsArg.optional().describe('For join/cut/intersect: "all" (default) or the bodies to act on, by name (part/extrude1).'),
  name: IdArg.optional().describe("The feature's name (default: its id)."),
});
export type ExtrudeArgs = z.infer<typeof ExtrudeArgs>;

const OWNED = ["sketch", "regions", "distance", "direction", "op", "targets"] as const;

export const extrudeModelingTool = defineModelingTool<ExtrudeArgs>({
  id: "extrude",
  title: "Extrude",
  agentTool: "extrude",
  featureTypes: ["extrude"],
  description:
    'Extrude a sketch\'s closed regions into a solid (the Extrude tool). New: {sketch, distance, direction?, operation?, targets?}. Edit an existing extrude: {feature, …changed arguments}. distance is mm or an expression ("thick", "wall * 2"). operation join/cut/intersect acts on targets ("all" or body names). One undoable step; refused with the engine\'s code when it would not build.',
  args: ExtrudeArgs,
  async build(args, ctx: ModelingContext) {
    const doc = docOf(ctx);
    const existing = args.feature ? editTarget(doc, args.feature, ["extrude"]) : null;
    const prev: Record<string, unknown> = existing ?? {};
    const sketchArg = args.sketch ?? (typeof prev["sketch"] === "string" ? (prev["sketch"] as string) : undefined);
    if (!sketchArg) throw argError("sketch", "pick the sketch to extrude", "MODEL_MISSING_ARG");
    const sketch = featureOf(doc, sketchArg);
    if (!sketch || sketch.type !== "sketch") throw argError("sketch", `${sketchArg} is not a sketch of this model`, "MODEL_NOT_A_SKETCH", { sketch: sketchArg });
    const distance = args.distance !== undefined ? irScalar(args.distance) : (prev["distance"] ?? 10);
    const direction = args.direction ?? (prev["direction"] as string | undefined) ?? "normal";
    const op = args.operation ?? (prev["op"] as string | undefined) ?? "new_body";
    let targets: unknown;
    if (op !== "new_body") {
      if (args.targets === undefined) targets = prev["targets"] ?? "all";
      else targets = args.targets === "all" ? "all" : bodiesRef(doc, args.targets, ctx.report, "targets");
    }
    const regions = args.regions ?? (prev["regions"] as unknown);
    const fields: Record<string, unknown> = {
      sketch: sketch.id,
      distance,
      direction: direction === "normal" ? undefined : direction,
      op: op === "new_body" ? undefined : op,
      targets,
      regions: regions === "all" ? undefined : regions,
    };
    const part = existing ? partFor(doc, existing.id) : partFor(doc, sketch.id);
    const what = existing ? `Edit ${existing.name}` : `Extrude ${sketch.name}`;
    return featureOps(doc, "extrude", { fields, name: args.name }, existing, OWNED, part, what);
  },
  argsOf(f) {
    const targets = f["targets"];
    return {
      feature: f.id,
      sketch: String(f["sketch"]),
      ...(scalarOf(f["distance"]) !== undefined ? { distance: scalarOf(f["distance"])! } : {}),
      direction: (f["direction"] as ExtrudeArgs["direction"]) ?? "normal",
      operation: (f["op"] as ExtrudeArgs["operation"]) ?? "new_body",
      ...(targets === "all" ? { targets: "all" as const } : {}),
      name: f.name,
    };
  },
});
