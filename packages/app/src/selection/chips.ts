/**
 * Selection → the chat's context chips (what travels with a message to the agent): the feature
 * of the primary item, then one chip per selected face, edge and body, with the provenance name as
 * the reference and a human label. Vertices and origin items have no chip kind in the agent
 * protocol yet (`SelectionChip.kind`); they are left out rather than mislabelled.
 */
import type { IrDocument } from "@aicad/ir-types";
import { useMemo, useSyncExternalStore } from "react";
import { findFeature } from "../doc/provenance";
import type { Selection } from "../doc/doc-store";
import type { SelectionChip } from "../ui-store";
import { useApp, useStore } from "../ui/context";
import { viewportRuntime } from "../viewport/runtime";
import { labelOf } from "./labels";
import type { SelectionItem } from "./types";

/** At most this many entity chips (a box over a part must not flood the composer). */
export const MAX_CHIPS = 24;

export function selectionChips(items: readonly SelectionItem[], doc: Pick<Selection, "featureId" | "entity">, ir: IrDocument | null | undefined): SelectionChip[] {
  const chips: SelectionChip[] = [];
  const loc = doc.featureId ? findFeature(ir, doc.featureId) : null;
  if (loc) chips.push({ kind: "feature", ref: loc.feature.id, label: loc.feature.name });
  if (items.length === 0) {
    // The document's own single selection (a pick made before the model selection existed).
    const e = doc.entity;
    if (e?.face) chips.push({ kind: "face", ref: e.face, label: e.face });
    else if (e?.edge) chips.push({ kind: "edge", ref: e.edge, label: e.edge });
    return chips;
  }
  let n = 0;
  for (const it of items) {
    if (n >= MAX_CHIPS) break;
    if (it.kind === "face" || it.kind === "edge") chips.push({ kind: it.kind, ref: it.key, label: labelOf(it, ir) });
    else if (it.kind === "body") chips.push({ kind: "body", ref: it.body, label: labelOf(it, ir) });
    else if ((it.kind === "sketch" || it.kind === "datum") && !chips.some((c) => c.kind === "feature" && c.label === it.feature)) {
      const f = findFeature(ir, it.feature);
      if (f) chips.push({ kind: "feature", ref: f.feature.id, label: f.feature.name });
    } else continue;
    n++;
  }
  return chips;
}

/** The chips of the current selection (React). */
export function useSelectionChips(): SelectionChip[] {
  const { services } = useApp();
  const runtime = viewportRuntime(services);
  const sel = useSyncExternalStore(runtime.selection.subscribe, runtime.selection.getState);
  const docSel = useStore(services.doc, (s) => s.selection);
  const model = useStore(services.doc, (s) => s.model);
  return useMemo(() => selectionChips(sel.items, docSel, model?.ir), [sel.items, docSel, model]);
}
