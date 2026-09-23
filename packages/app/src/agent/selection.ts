/**
 * Selection chips → semantic context for the agent (ARCHITECTURE §6 "Selection: described
 * semantically"). Face and edge chips carry Forge provenance names (`plate/cap:end`,
 * `plate/side:bottom`, `plate/edge:{plate/cap:end|plate/side:top}`); they are explained in terms of
 * the feature and sketch curve that made them, so "make this thicker" resolves to the right feature.
 */
import type { Feature, IrDocument } from "@aicad/ir-types";
import type { AgentSelectionItem } from "../agent-protocol";
import { featureNameOfBody, featureNameOfFace, findFeature } from "../doc/provenance";
import type { SelectionChip } from "../ui-store";

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** One line about a feature: `extrude \`plate\` of sketch \`outline\`, 5 mm (part \`plate\`)`. */
export function describeFeature(f: Feature, part: string): string {
  switch (f.type) {
    case "sketch":
      return `sketch \`${f.name}\` on ${typeof f.plane === "string" ? f.plane : "a custom frame"} with ${f.curves.length} curve${f.curves.length === 1 ? "" : "s"} (${f.curves.map((c) => c.id).join(", ")}) in part \`${part}\``;
    case "extrude":
      return `extrude \`${f.name}\` of sketch \`${f.sketch}\`, ${fmt(f.distance)} mm${f.direction && f.direction !== "normal" ? ` (${f.direction})` : ""}, in part \`${part}\``;
    case "revolve":
      return `revolve \`${f.name}\` of sketch \`${f.sketch}\`, ${fmt(f.angle)}°, in part \`${part}\``;
  }
}

/** Explain a face provenance name (`<feature>/<role>:<curve>`). */
export function describeFace(face: string, ir: IrDocument | null | undefined): string {
  const featureName = featureNameOfFace(face);
  const loc = findFeature(ir, featureName);
  const role = face.slice(featureName.length + 1);
  const what = loc ? describeFeature(loc.feature, loc.part.name) : `feature \`${featureName}\``;
  const sketch = loc && loc.feature.type !== "sketch" ? loc.feature.sketch : null;
  const m = /^(cap|endcap|side):(.+)$/.exec(role);
  if (m) {
    const [, kind, which] = m;
    if (kind === "cap" && which === "start") return `the start cap (the face on the sketch plane) of ${what}`;
    if (kind === "cap" && which === "end") return `the end cap (the face at the far end of the extrusion) of ${what}`;
    if (kind === "endcap") return `the ${which} end face of the partial ${what}`;
    if (kind === "side") return `the side face swept from curve \`${which}\`${sketch ? ` of sketch \`${sketch}\`` : ""} by ${what}`;
  }
  return `a face of ${what}`;
}

/** Explain an edge name `<feature>/edge:{faceA|faceB}`. */
export function describeEdge(edge: string, ir: IrDocument | null | undefined): string {
  const m = /^[^/]+\/edge:\{(.+)\|(.+)\}(#\d+)?$/.exec(edge);
  if (m) return `the edge between ${describeFace(m[1]!, ir)} and ${describeFace(m[2]!, ir)}`;
  const loc = findFeature(ir, featureNameOfFace(edge));
  return `an edge of ${loc ? describeFeature(loc.feature, loc.part.name) : `feature \`${featureNameOfFace(edge)}\``}`;
}

export function describeSelection(chips: readonly SelectionChip[], ir: IrDocument | null | undefined): AgentSelectionItem[] {
  return chips.map((c) => {
    let description: string | undefined;
    if (c.kind === "feature") {
      const loc = findFeature(ir, c.ref) ?? findFeature(ir, c.label);
      if (loc) description = describeFeature(loc.feature, loc.part.name);
    } else if (c.kind === "face") description = describeFace(c.ref, ir);
    else if (c.kind === "edge") description = describeEdge(c.ref, ir);
    else {
      const loc = findFeature(ir, featureNameOfBody(c.ref));
      description = `the solid body made by ${loc ? describeFeature(loc.feature, loc.part.name) : `\`${c.ref}\``}`;
    }
    return { kind: c.kind, ref: c.ref, label: c.label, ...(description ? { description } : {}) };
  });
}
