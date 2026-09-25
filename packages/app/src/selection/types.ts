/**
 * The selection model (FULL-MODELING-PLAN §2.4, contract C2). Selection is app state, never IR: it
 * is turned into IR references only when a tool commits. Model entities are held by **provenance
 * name** (the semantic reference the tools and the agent read) plus a probe point, so they survive
 * re-evaluation and are re-resolved after every regeneration.
 *
 * Names are the render mesh's provenance names today (`plate/cap:end`,
 * `plate/edge:{plate/cap:end|plate/side:top}`, bodies `part/feature[#n]`). A vertex has no name in
 * the render mesh, so it gets a derived key from its incident edges, `vertex:{e1|e2|…}` (sorted, as
 * forge-core's `VertexAt` role renders its sources), and always carries its exact point.
 */
import type { Vec3 } from "../viewport/view-camera";

export const SELECTION_KINDS = ["vertex", "edge", "face", "body", "sketch", "datum", "origin"] as const;
export type SelectionKind = (typeof SELECTION_KINDS)[number];

/** A model entity: a face, an edge or a vertex of a body. */
export interface EntityItem {
  kind: "face" | "edge" | "vertex";
  /** Body name (`part/feature[#n]`). */
  body: string;
  /** Provenance name of the face or edge; the derived `vertex:{…}` key of a vertex. */
  key: string;
  /** A world point on the entity (where it was picked; a vertex: its exact position). */
  point?: Vec3;
}

export interface BodyItem {
  kind: "body";
  body: string;
}

/** A sketch feature (from the timeline or a sketch in the viewport). */
export interface SketchItem {
  kind: "sketch";
  feature: string;
}

/** An origin plane, axis or point: `XY | XZ | YZ | X | Y | Z | O`. */
export interface OriginItem {
  kind: "origin";
  id: OriginId;
}

/** A datum feature (plane/axis) by feature id or name. */
export interface DatumItem {
  kind: "datum";
  feature: string;
}

export type SelectionItem = EntityItem | BodyItem | SketchItem | OriginItem | DatumItem;

export const ORIGIN_IDS = ["XY", "XZ", "YZ", "X", "Y", "Z", "O"] as const;
export type OriginId = (typeof ORIGIN_IDS)[number];

/** Which kinds a click or a box may select (keys 1–5: vertex, edge, face, body, sketch). */
export type KindMask = Readonly<Record<SelectionKind, boolean>>;

export const ALL_KINDS: KindMask = { vertex: true, edge: true, face: true, body: false, sketch: true, datum: true, origin: true };

export interface SelectionState {
  /** Ordered: the first item is the primary. */
  items: readonly SelectionItem[];
  filter: KindMask;
  /** Pre-highlight under the cursor (what a click would select). */
  hover: SelectionItem | null;
  /** Incremented on every change of `items`. */
  revision: number;
  /** Items dropped by the last re-resolution (entities that no longer exist). */
  dropped: readonly SelectionItem[];
}

export type BoxMode = "window" | "crossing";

/** A stable identity string for an item (dedup, equality, test assertions). */
export function itemId(it: SelectionItem): string {
  switch (it.kind) {
    case "face":
    case "edge":
    case "vertex":
      return `${it.kind}:${it.body}\u0000${it.key}`;
    case "body":
      return `body:${it.body}`;
    case "sketch":
    case "datum":
      return `${it.kind}:${it.feature}`;
    case "origin":
      return `origin:${it.id}`;
  }
}

export function sameItem(a: SelectionItem | null | undefined, b: SelectionItem | null | undefined): boolean {
  if (!a || !b) return a === b;
  return itemId(a) === itemId(b);
}

export function isEntity(it: SelectionItem): it is EntityItem {
  return it.kind === "face" || it.kind === "edge" || it.kind === "vertex";
}

/** The kind a filter checks for an item (datum/origin share the "datum" switch in the UI). */
export function filterKindOf(it: SelectionItem): SelectionKind {
  return it.kind;
}

export function passesFilter(it: SelectionItem, filter: KindMask): boolean {
  return filter[filterKindOf(it)];
}
