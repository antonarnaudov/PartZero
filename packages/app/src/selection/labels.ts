/**
 * Human labels for selection items, from provenance names: "End cap of plate",
 * "Edge: end cap / side top (plate)", "Vertex of plate (25, −25, 5)". Used by hover readouts, the
 * selection chips and `selection.get` (the agent gets the same labels next to the exact names).
 */
import type { IrDocument } from "@aicad/ir-types";
import { featureNameOfBody, featureNameOfFace } from "../doc/provenance";
import { facesOfEdgeName } from "./picking";
import type { SelectionItem } from "./types";

function fmt(n: number): string {
  const v = Math.round(n * 1000) / 1000;
  return String(Object.is(v, -0) ? 0 : v);
}

/** Short role of a face name: `cap:end` → "end cap", `side:top` → "side top". */
export function faceRole(face: string): string {
  const feature = featureNameOfFace(face);
  const role = face.slice(feature.length + 1).replace(/@.*$/, "").replace(/#\d+$/, "");
  const m = /^(cap|endcap):(start|end)$/.exec(role);
  if (m) return `${m[2]} ${m[1] === "cap" ? "cap" : "end face"}`;
  const side = /^side:(.+)$/.exec(role);
  if (side) return `side ${side[1]}`;
  const op = /^([a-z_]+):\{(.+)\}$/.exec(role);
  if (op) return op[1]!.replace(/_/g, " ");
  return role || "face";
}

/** Feature display name: the IR feature name (provenance uses it as the name's first segment). */
function featureName(name: string, _ir?: IrDocument | null): string {
  return featureNameOfFace(name);
}

export function faceLabel(face: string, ir?: IrDocument | null): string {
  const role = faceRole(face);
  return `${role.charAt(0).toUpperCase()}${role.slice(1)} of ${featureName(face, ir)}`;
}

export function edgeLabel(edge: string, ir?: IrDocument | null): string {
  const faces = facesOfEdgeName(edge);
  if (faces.length === 2) return `Edge: ${faceRole(faces[0]!)} / ${faceRole(faces[1]!)} (${featureName(edge, ir)})`;
  return `Edge of ${featureName(edge, ir)}`;
}

export function labelOf(it: SelectionItem, ir?: IrDocument | null): string {
  switch (it.kind) {
    case "face":
      return faceLabel(it.key, ir);
    case "edge":
      return edgeLabel(it.key, ir);
    case "vertex":
      return `Vertex of ${featureNameOfBody(it.body)}${it.point ? ` (${it.point.map(fmt).join(", ")})` : ""}`;
    case "body":
      return `Body ${featureNameOfBody(it.body)}`;
    case "sketch":
      return `Sketch ${it.feature}`;
    case "datum":
      return `Datum ${it.feature}`;
    case "origin":
      return it.id === "O" ? "Origin" : it.id.length === 2 ? `${it.id} plane` : `${it.id} axis`;
  }
}
