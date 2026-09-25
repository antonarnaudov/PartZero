/**
 * Revolve (SPEC-v1 §6.3): a sketch's closed regions swept about an axis in the sketch plane — the
 * sketch's u (X) or v (Y) axis, a line of the sketch (often a construction line), or an explicit
 * axis — by an angle, one side, flipped or both sides (symmetric), as a new body or a body op.
 *
 * The IR stores the axis in sketch coordinates (§6.3). A line is taken at its solved position when
 * the tool runs; SPEC set A's `{ curve }` axis (FULL-MODELING-PLAN §2.7) will keep it bound to the
 * line when the line is edited later.
 */
import { z } from "zod";
import { solvedCurves, tidy } from "./frames.js";
import { argError, bodiesRef, featureOf } from "./keys.js";
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
} from "./tool.js";

const AxisObject = z.strictObject({ origin: z.tuple([ScalarArg, ScalarArg]), direction: z.tuple([ScalarArg, ScalarArg]) });

export const RevolveArgs = z.strictObject({
  feature: IdArg.optional().describe("Edit this revolve (id or name) instead of adding one; arguments left out keep their values."),
  sketch: IdArg.optional().describe("The profile sketch (id or name). Required for a new revolve."),
  axis: z
    .union([z.string().min(1).max(200), AxisObject])
    .optional()
    .describe('The axis in the sketch plane: "u" (the sketch\'s X axis), "v" (its Y axis, default), the id of a line of the sketch (a construction line), or {origin: [u, v], direction: [du, dv]}.'),
  angle: ScalarArg.optional().describe("Degrees in (0, 360] (default 360): a number or a parameter expression."),
  direction: DirectionArg.optional().describe("normal (default), reverse, or symmetric (both sides: half the angle each way)."),
  operation: OperationArg.optional().describe("new_body (default), join, cut or intersect."),
  targets: TargetsArg.optional().describe('For join/cut/intersect: "all" (default) or body names.'),
  name: IdArg.optional(),
});
export type RevolveArgs = z.infer<typeof RevolveArgs>;

const OWNED = ["sketch", "axis", "angle", "direction", "op", "targets"] as const;

/** An axis argument as the IR's sketch axis `{ origin, direction }`. */
function axisJson(axis: RevolveArgs["axis"], sketchId: string, report: Parameters<typeof solvedCurves>[0]): { origin: unknown[]; direction: unknown[] } {
  if (axis === undefined || axis === "v" || axis === "V" || axis === "y" || axis === "Y") return { origin: [0, 0], direction: [0, 1] };
  if (axis === "u" || axis === "U" || axis === "x" || axis === "X") return { origin: [0, 0], direction: [1, 0] };
  if (typeof axis === "object") return { origin: axis.origin.map(irScalar), direction: axis.direction.map(irScalar) };
  const curves = solvedCurves(report, sketchId);
  if (!curves) throw argError("axis", "the sketch has not been evaluated, so its lines are unknown; use u or v, or an explicit axis", "MODEL_SKETCH_NOT_SOLVED", { sketch: sketchId });
  const line = curves.find((c) => c.id === axis);
  if (!line) {
    const lines = curves.filter((c) => c.kind === "line").map((c) => c.id);
    throw argError("axis", `the sketch has no curve ${JSON.stringify(axis)} (its lines: ${lines.join(", ") || "none"})`, "MODEL_UNKNOWN_CURVE", { curve: axis, lines });
  }
  if (line.kind !== "line" || !line.start || !line.end) throw argError("axis", `${axis} is a ${line.kind}; the axis must be a straight line`, "MODEL_NOT_A_LINE", { curve: axis });
  const d = [line.end[0] - line.start[0], line.end[1] - line.start[1]];
  const len = Math.hypot(d[0]!, d[1]!);
  if (!(len > 1e-9)) throw argError("axis", `${axis} has zero length`, "MODEL_NOT_A_LINE", { curve: axis });
  return { origin: [tidy(line.start[0]), tidy(line.start[1])], direction: [tidy(d[0]! / len, 12), tidy(d[1]! / len, 12)] };
}

export const revolveModelingTool = defineModelingTool<RevolveArgs>({
  id: "revolve",
  title: "Revolve",
  agentTool: "revolve",
  featureTypes: ["revolve"],
  description:
    'Revolve a sketch\'s closed regions about an axis in the sketch plane (the Revolve tool). New: {sketch, axis?, angle?, direction?, operation?, targets?}; axis is "u", "v" (default) or the id of a line in the sketch. Edit: {feature, …changed}. angle in degrees (default 360). A profile crossing the axis is refused by the engine (REVOLVE_CROSSES_AXIS).',
  args: RevolveArgs,
  async build(args, ctx) {
    const doc = docOf(ctx);
    const existing = args.feature ? editTarget(doc, args.feature, ["revolve"]) : null;
    const prev: Record<string, unknown> = existing ?? {};
    const sketchArg = args.sketch ?? (typeof prev["sketch"] === "string" ? (prev["sketch"] as string) : undefined);
    if (!sketchArg) throw argError("sketch", "pick the sketch to revolve", "MODEL_MISSING_ARG");
    const sketch = featureOf(doc, sketchArg);
    if (!sketch || sketch.type !== "sketch") throw argError("sketch", `${sketchArg} is not a sketch of this model`, "MODEL_NOT_A_SKETCH", { sketch: sketchArg });
    const axis = args.axis !== undefined || !existing ? axisJson(args.axis, sketch.id, ctx.report) : prev["axis"];
    const angle = args.angle !== undefined ? irScalar(args.angle) : (prev["angle"] ?? 360);
    const direction = args.direction ?? (prev["direction"] as string | undefined) ?? "normal";
    const op = args.operation ?? (prev["op"] as string | undefined) ?? "new_body";
    let targets: unknown;
    if (op !== "new_body") {
      if (args.targets === undefined) targets = prev["targets"] ?? "all";
      else targets = args.targets === "all" ? "all" : bodiesRef(doc, args.targets, ctx.report, "targets");
    }
    const fields: Record<string, unknown> = {
      sketch: sketch.id,
      axis,
      angle,
      direction: direction === "normal" ? undefined : direction,
      op: op === "new_body" ? undefined : op,
      targets,
    };
    const part = existing ? partFor(doc, existing.id) : partFor(doc, sketch.id);
    return featureOps(doc, "revolve", { fields, name: args.name }, existing, OWNED, part, existing ? `Edit ${existing.name}` : `Revolve ${sketch.name}`);
  },
  argsOf(f) {
    const axis = f["axis"] as { origin?: unknown[]; direction?: unknown[] } | undefined;
    const isU = axis && JSON.stringify(axis.origin) === "[0,0]" && JSON.stringify(axis.direction) === "[1,0]";
    const isV = axis && JSON.stringify(axis.origin) === "[0,0]" && JSON.stringify(axis.direction) === "[0,1]";
    return {
      feature: f.id,
      sketch: String(f["sketch"]),
      ...(isU ? { axis: "u" } : isV ? { axis: "v" } : axis ? { axis: { origin: axis.origin as [number, number], direction: axis.direction as [number, number] } } : {}),
      ...(scalarOf(f["angle"]) !== undefined ? { angle: scalarOf(f["angle"])! } : {}),
      direction: (f["direction"] as RevolveArgs["direction"]) ?? "normal",
      operation: (f["op"] as RevolveArgs["operation"]) ?? "new_body",
      name: f.name,
    };
  },
});
