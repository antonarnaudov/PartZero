/**
 * What the create tools read of the open model: its features, sketches and bodies, and the
 * enablement rules they share.
 */
import { keyOfFaceQuery } from "@aicad/model-ops";
import { faceLabel } from "../../selection/labels";
import type { AppServices } from "../../services";
import type { Enablement, SelectionItem, ToolContext } from "../framework/types";

export interface ModelFeature {
  id: string;
  name: string;
  type: string;
  part: string;
  partName: string;
  json: Record<string, unknown>;
}

/** The IR v1 document the app holds, parsed (null on a CadScript document). */
export function modelDoc(services: AppServices): { parts: Array<{ id: string; name: string; features: Array<Record<string, unknown>> }> } | null {
  const s = services.doc.getState();
  if (s.format !== "ir-v1") return null;
  try {
    return JSON.parse(s.source) as { parts: Array<{ id: string; name: string; features: Array<Record<string, unknown>> }> };
  } catch {
    return null;
  }
}

export function modelFeatures(services: AppServices): ModelFeature[] {
  const d = modelDoc(services);
  if (!d) return [];
  return d.parts.flatMap((p) => p.features.map((f) => ({ id: String(f["id"]), name: String(f["name"]), type: String(f["type"]), part: p.id, partName: p.name, json: f })));
}

export function sketchesOf(services: AppServices): ModelFeature[] {
  return modelFeatures(services).filter((f) => f.type === "sketch");
}

/** The render bodies of the model as displayed (cut at the rollback marker). */
export function bodyNames(services: AppServices): string[] {
  return services.doc.getState().bodies.map((b) => b.name);
}

/** Enabled on an IR v1 model only. */
export function needsV1(ctx: ToolContext, label: string): Enablement | null {
  if (!ctx.services.doc.isV1) return { reason: `${label} needs an IR v1 model (File ▸ New).` };
  return null;
}

/** The sketch the selection names (a sketch picked in the timeline or the viewport), if any. */
export function selectedSketch(ctx: ToolContext, sketches: readonly ModelFeature[]): string | null {
  for (const item of ctx.selection.items()) {
    if (item.kind === "feature") {
      const f = sketches.find((s) => s.id === item.feature || s.name === item.feature);
      if (f) return f.id;
    }
  }
  return null;
}

/** A face reference of a feature as a selection item (for re-editing it), when the reference is a simple named face. */
export function faceItemOf(ref: unknown, services: AppServices): SelectionItem | null {
  const q = (ref as { q?: unknown } | undefined)?.q;
  const key = keyOfFaceQuery(q);
  if (!key) return null;
  const f = modelFeatures(services).find((x) => x.id === (q as { feature?: string }).feature);
  return { kind: "face", part: f?.partName ?? "part", key, label: faceLabel(key, services.doc.getState().model?.ir) };
}

/** Bodies picked directly, or through one of their faces (click any face of a body). */
export function bodiesOfItems(items: readonly SelectionItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const b = it.kind === "body" ? it.body : (it.kind === "face" || it.kind === "edge" || it.kind === "vertex") && it.body ? it.body : null;
    if (b && !out.includes(b)) out.push(b);
  }
  return out;
}
