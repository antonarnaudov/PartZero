/**
 * The browser's tree (FULL-MODELING-PLAN T0 #19; Fusion's Browser): the document → its origin
 * (planes, axes, point) → per part its bodies, sketches and construction features.
 *
 * Bodies are the evaluated model's bodies. Their names are `part/feature[#k]` (SPEC-v1 §5.2, the
 * origin feature's name, `#k` when one feature made several), so each body knows the feature that
 * made it: its colour is that feature's appearance (`ir.setAppearance`, saved with the document),
 * and "the feature" is what selecting it in the timeline shows.
 */
import type { TimelineFeature, TimelineModel } from "../../doc/timeline";
import { isConstruction } from "./feature-types";

export interface BrowserBody {
  /** The render body name (`part/feature[#k]`): the key of visibility and selection. */
  name: string;
  /** For people: the origin feature's name, with the piece number when there are several. */
  label: string;
  /** The feature that made it (its origin), when it is known. */
  feature: { id: string; name: string } | null;
}

export interface BrowserPart {
  id: string;
  name: string;
  bodies: BrowserBody[];
  sketches: TimelineFeature[];
  construction: TimelineFeature[];
}

export interface BrowserTree {
  parts: BrowserPart[];
  bodyCount: number;
}

export const ORIGIN_ITEMS = [
  { id: "O", label: "Origin point", kind: "point" },
  { id: "XY", label: "XY plane", kind: "plane" },
  { id: "XZ", label: "XZ plane", kind: "plane" },
  { id: "YZ", label: "YZ plane", kind: "plane" },
  { id: "X", label: "X axis", kind: "axis" },
  { id: "Y", label: "Y axis", kind: "axis" },
  { id: "Z", label: "Z axis", kind: "axis" },
] as const;

/** Split a body name into its part key, origin feature name and piece number. */
export function parseBodyName(name: string): { part: string; feature: string; piece: number | null } {
  const slash = name.indexOf("/");
  const part = slash >= 0 ? name.slice(0, slash) : "";
  const rest = slash >= 0 ? name.slice(slash + 1) : name;
  const hash = rest.lastIndexOf("#");
  if (hash >= 0 && /^\d+$/.test(rest.slice(hash + 1))) return { part, feature: rest.slice(0, hash), piece: Number(rest.slice(hash + 1)) };
  return { part, feature: rest, piece: null };
}

export function buildBrowserTree(timeline: TimelineModel, bodyNames: readonly string[]): BrowserTree {
  const parts: BrowserPart[] = timeline.parts.map((p) => ({
    id: p.id,
    name: p.name,
    bodies: [],
    sketches: p.features.filter((f) => f.type === "sketch"),
    construction: p.features.filter((f) => isConstruction(f.type)),
  }));
  for (const name of bodyNames) {
    const b = parseBodyName(name);
    const part = parts.find((p) => p.id === b.part) ?? parts.find((p) => p.name === b.part) ?? (parts.length === 1 ? parts[0] : undefined);
    const owner = part && timeline.parts.find((p) => p.id === part.id);
    const f = owner?.features.find((x) => x.name === b.feature) ?? owner?.features.find((x) => x.id === b.feature);
    const body: BrowserBody = { name, label: b.piece === null ? b.feature : `${b.feature} (${b.piece + 1})`, feature: f ? { id: f.id, name: f.name } : null };
    if (part) part.bodies.push(body);
    else {
      // A body of an unknown part (an older document shape): show it under the first part.
      parts[0]?.bodies.push(body);
    }
  }
  return { parts, bodyCount: bodyNames.length };
}
