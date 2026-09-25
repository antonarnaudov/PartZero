/**
 * Move / Copy (SPEC-v1 §6.13 `transform`, amendment set F): bodies moved — or copied — by a
 * rotation about an axis (degrees) and then a translation. Moved bodies keep their identity, so
 * features that reference their faces keep resolving; copies are new bodies of the transform.
 */
import { z } from "zod";
import { singleHoleResolver } from "./frames.js";
import { argError, axisRef, bodiesRef } from "./keys.js";
import { defineModelingTool, docOf, editTarget, featureOps, IdArg, irScalar, isObject, partFor, PickArg, ScalarArg, scalarOf, type Scalar } from "./tool.js";

export const MoveArgs = z.strictObject({
  feature: IdArg.optional().describe("Edit this transform (id or name) instead of adding one."),
  bodies: z.array(PickArg).min(1).max(1000).optional().describe("The bodies to move, by name (part/extrude1) or by the feature that made them. Required for a new move."),
  translate: z.tuple([ScalarArg, ScalarArg, ScalarArg]).optional().describe("[dx, dy, dz] in mm (numbers or expressions), applied after the rotation."),
  rotate: z
    .strictObject({ axis: PickArg.describe("X, Y, Z, a datum axis, a straight or circular edge, or a cylindrical face."), angle: ScalarArg.describe("Degrees, right-hand rule, |angle| ≤ 360.") })
    .optional(),
  no_rotation: z.boolean().optional().describe("Edit only: remove the rotation."),
  rotate_angle: ScalarArg.optional().describe("Edit only: change the angle of the existing rotation, keeping its axis."),
  copy: z.boolean().optional().describe("Keep the originals and add moved copies (default false: move them)."),
  name: IdArg.optional(),
});
export type MoveArgs = z.infer<typeof MoveArgs>;

const OWNED = ["bodies", "translate", "rotate", "copy"] as const;

export const moveModelingTool = defineModelingTool<MoveArgs>({
  id: "move",
  title: "Move/Copy",
  agentTool: "move_bodies",
  featureTypes: ["transform"],
  description:
    'Move or copy bodies (the Move/Copy tool, M): {bodies: [body…], translate?: [dx, dy, dz], rotate?: {axis: "Z" | edge | datum axis, angle}, copy?}. The rotation happens first, about the axis line; then the translation. A move keeps the bodies\' identity (later features on their faces follow them); copy: true adds new bodies. Edit: {feature, …changed}.',
  args: MoveArgs,
  async build(args, ctx) {
    const doc = docOf(ctx);
    const existing = args.feature ? editTarget(doc, args.feature, ["transform"]) : null;
    const prev: Record<string, unknown> = existing ?? {};
    const bodies = args.bodies ? bodiesRef(doc, args.bodies, ctx.report, "bodies") : prev["bodies"];
    if (bodies === undefined) throw argError("bodies", "pick the bodies to move", "MODEL_MISSING_ARG");
    const translate = args.translate ? args.translate.map(irScalar) : (prev["translate"] as unknown[] | undefined);
    let rotate: unknown = prev["rotate"];
    if (args.no_rotation) rotate = undefined;
    if (args.rotate_angle !== undefined) {
      if (!isObject(rotate)) throw argError("rotate_angle", "there is no rotation to change; give rotate {axis, angle}", "MODEL_MISSING_ARG");
      rotate = { ...rotate, angle: irScalar(args.rotate_angle) };
    }
    if (args.rotate) rotate = { axis: axisRef(doc, args.rotate.axis, "rotate", singleHoleResolver(ctx.report)), angle: irScalar(args.rotate.angle) };
    const copy = args.copy ?? (prev["copy"] === true);
    const zero = !translate || translate.every((x) => x === 0);
    if (zero && rotate === undefined && !existing) throw argError("translate", "give a translation or a rotation", "MODEL_MISSING_ARG");
    const fields: Record<string, unknown> = { bodies, translate: zero ? undefined : translate, rotate, copy: copy ? true : undefined };
    const part = existing ? partFor(doc, existing.id) : partFor(doc, ctx.host.rollback);
    return featureOps(doc, "transform", { fields, name: args.name }, existing, OWNED, part, existing ? `Edit ${existing.name}` : copy ? "Copy bodies" : "Move bodies");
  },
  argsOf(f) {
    const t = f["translate"];
    const out: Partial<MoveArgs> = { feature: f.id, copy: f["copy"] === true, name: f.name };
    if (Array.isArray(t) && t.length === 3) out.translate = t as [Scalar, Scalar, Scalar];
    const r = f["rotate"];
    if (isObject(r) && typeof r["axis"] === "string" && scalarOf(r["angle"]) !== undefined) out.rotate = { axis: r["axis"], angle: scalarOf(r["angle"])! };
    return out;
  },
});
