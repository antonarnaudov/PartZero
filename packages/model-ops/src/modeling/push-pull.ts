/**
 * Push/pull a face (FULL-MODELING-PLAN §2.6, NORTH-STAR B1): the face's **driver** — the feature
 * field that positions it — is found from the face's provenance, and the pull edits that field
 * (never the geometry directly), so the model stays parametric:
 *
 * | Face | Driver |
 * |---|---|
 * | extrude end cap (and either cap of a symmetric extrude) | `distance` (a pocket floor of a cut: pulling it out makes the cut shallower) |
 * | revolve end cap (either of a symmetric revolve) | `angle` (degrees) |
 * | hole wall with a custom diameter | `d` (the wall moves by the offset: d ± 2·offset) |
 * | shell offset face | `thickness` |
 *
 * A field holding a bare parameter (`thick`) sets that parameter; a derived expression (`wall * 2`)
 * is refused with the parameter to edit instead. Faces nothing drives (a side face, a start cap on
 * the sketch plane) are refused with `MODEL_NO_DRIVER`, saying what to edit instead.
 */
import { z } from "zod";
import type { IrOp } from "../catalogue.js";
import { tidy } from "./frames.js";
import { argError, featureOf, parseKey, type ReportLike } from "./keys.js";
import { defineModelingTool, docOf, irScalar, PickArg, ScalarArg, type ModelingContext, type Scalar } from "./tool.js";
import type { FeatureJson } from "../doc.js";

export const PushPullArgs = z.strictObject({
  face: PickArg.describe("The face to push or pull, by name (e1/cap:end)."),
  offset: z.number().finite().optional().describe("How far to move the face along its outward normal (mm; degrees for a revolve end cap); negative pushes it in."),
  value: ScalarArg.optional().describe("Or the new value of the driving field (e.g. the extrude distance), a number or an expression."),
});
export type PushPullArgs = z.infer<typeof PushPullArgs>;

export interface FaceDriver {
  feature: FeatureJson;
  field: "distance" | "angle" | "d" | "thickness";
  /** What a unit offset of the face does to the field (±1, ±2). */
  factor: number;
  unit: "mm" | "deg";
  /** For people: "boss · distance". */
  label: string;
}

/** The driver of a face (the field that positions it), or a refusal saying why there is none. */
export function faceDriver(ctxDoc: ReturnType<typeof docOf>, key: string): FaceDriver {
  const k = parseKey(key);
  const no = (why: string, hint: string): never => {
    throw argError("face", `${why}. ${hint}`, "MODEL_NO_DRIVER", { face: key });
  };
  if (!k) return no(`${key} is not a face name`, "Pick a face of the model.");
  const f = featureOf(ctxDoc, k.feature);
  if (!f) return no(`the feature of ${key} is not in the model`, "Pick a face of the model.");
  const leaf = k.leaves[0];
  if (k.label === "cap" && f.type === "extrude") {
    if (f["extent"] !== undefined) return no(`${f.name} goes ${f["extent"] === "through_all" ? "through all" : "up to a plane"}, so its end follows that`, "Change its extent in the Extrude tool, or move the plane it goes up to.");
    const dir = (f["direction"] as string | undefined) ?? "normal";
    const op = (f["op"] as string | undefined) ?? "new_body";
    const sign = op === "cut" ? -1 : 1;
    if (dir === "symmetric") return { feature: f, field: "distance", factor: 2 * sign, unit: "mm", label: `${f.name} · distance` };
    if (leaf === "end") return { feature: f, field: "distance", factor: sign, unit: "mm", label: `${f.name} · distance` };
    return no(`the start cap of ${f.name} lies on its sketch plane, so no distance moves it`, "Pull the end cap, or move the sketch's plane.");
  }
  if (k.label === "endcap" && f.type === "revolve") {
    const dir = (f["direction"] as string | undefined) ?? "normal";
    if (dir === "symmetric") return { feature: f, field: "angle", factor: 2, unit: "deg", label: `${f.name} · angle` };
    if (leaf === "end") return { feature: f, field: "angle", factor: 1, unit: "deg", label: `${f.name} · angle` };
    return no(`the start of ${f.name} lies on its profile plane`, "Pull the other end cap.");
  }
  if (k.label === "wall" && f.type === "hole") {
    if (f["d"] === undefined) return no(`${f.name} uses the standard ${String(f["size"] ?? "")} size`, "Change its size in the Hole tool (or give it a custom diameter first).");
    return { feature: f, field: "d", factor: 2, unit: "mm", label: `${f.name} · diameter` };
  }
  if (k.label === "offset" && f.type === "shell") return { feature: f, field: "thickness", factor: 1, unit: "mm", label: `${f.name} · thickness` };
  if (k.label === "side") return no(`a side face of ${f.name} is positioned by its sketch`, `Edit the sketch ${String(f["sketch"] ?? "")} (double-click it in the timeline).`);
  return no(`nothing in the timeline drives ${key} directly`, "Edit the feature that made it.");
}

function reportParam(report: ReportLike | null, name: string): number | null {
  const params = (report as { params?: Array<{ name: string; value?: unknown }> } | null)?.params ?? [];
  const p = params.find((x) => x.name === name);
  return typeof p?.value === "number" ? p.value : null;
}

/** The ops of a push/pull: a field edit or a parameter edit. */
export function pushPullOps(ctx: ModelingContext, driver: FaceDriver, args: Pick<PushPullArgs, "offset" | "value">): { ops: IrOp[]; from: number | string; to: number | string } {
  const current = driver.feature[driver.field] as Scalar | undefined;
  if (current === undefined) throw argError("face", `${driver.label} is not set`, "MODEL_NO_DRIVER");
  if (args.value !== undefined) {
    const to = irScalar(args.value);
    return { ops: [{ op: "updateFeature", feature: driver.feature.id, set: { [driver.field]: to } }], from: current, to };
  }
  if (args.offset === undefined) throw argError("offset", "give an offset (or a new value)", "MODEL_MISSING_ARG");
  const delta = args.offset * driver.factor;
  if (typeof current === "number") {
    const to = tidy(current + delta, 6);
    return { ops: [{ op: "updateFeature", feature: driver.feature.id, set: { [driver.field]: to } }], from: current, to };
  }
  const name = current.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    const now = reportParam(ctx.report, name);
    if (now === null) throw argError("face", `${driver.label} is the parameter ${name}, whose value is not known yet`, "MODEL_DERIVED_VALUE", { param: name });
    const doc = docOf(ctx);
    const own = [...(doc.params ?? []), ...doc.parts.flatMap((p) => p.params ?? [])].find((p) => p["name"] === name);
    if (own && typeof own["value"] !== "number") {
      throw argError("face", `${driver.label} is ${name} = ${String(own["value"])}, an expression; edit the parameters it uses`, "MODEL_DERIVED_VALUE", { param: name, expression: own["value"] });
    }
    const to = tidy(now + delta, 6);
    return { ops: [{ op: "setParam", name, value: to }], from: now, to };
  }
  throw argError("face", `${driver.label} is the expression "${name}"; edit the parameters it uses, or type a new value`, "MODEL_DERIVED_VALUE", { expression: name });
}

export const pushPullModelingTool = defineModelingTool<PushPullArgs>({
  id: "push_pull",
  title: "Push/Pull",
  agentTool: "push_pull",
  featureTypes: [],
  description:
    'Push or pull a face (the Push/Pull tool, Q): {face, offset} moves it along its outward normal by offset mm (negative pushes in), or {face, value} sets the driving value. The face\'s driver is edited — an extrude end cap its distance, a revolve end cap its angle, a custom hole wall its diameter, a shell face its thickness — or the parameter the field names. Refused with MODEL_NO_DRIVER (side faces: edit the sketch) or MODEL_DERIVED_VALUE (an expression: edit its parameters).',
  args: PushPullArgs,
  async build(args, ctx) {
    const doc = docOf(ctx);
    const driver = faceDriver(doc, args.face);
    const r = pushPullOps(ctx, driver, args);
    return { ops: r.ops, label: `Push/pull ${driver.label}`, feature: driver.feature.id, adds: false };
  },
});
