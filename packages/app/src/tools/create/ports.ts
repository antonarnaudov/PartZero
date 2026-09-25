/**
 * The shell's ports on the viewport (FULL-MODELING-PLAN §2.4, §2.6), bound by `installShell`:
 *
 * - {@link runtimeSelectionPort}: tools see the viewport's **multi**-selection (faces, edges,
 *   vertices, bodies, sketches, datums, origin planes and axes), plus a feature picked in the
 *   timeline, converted to the tool framework's `SelectionItem` (provenance keys, never engine ids).
 * - {@link manipulatorHandlesPort}: the open panel's handles in the viewport's manipulator host; a
 *   drag reports back to the panel, which sets the bound field.
 */
import { findFeature } from "../../doc/provenance";
import type { AppServices } from "../../services";
import type { SelectionItem as ViewItem } from "../../selection/types";
import type { ManipulatorHost } from "../../viewport/manipulators/host";
import type { HandleSpec } from "../../viewport/manipulators/types";
import { viewportRuntime } from "../../viewport/runtime";
import type { HandlesPort, PanelHandle, SelectionItem, SelectionPort } from "../framework/types";

function partOfBody(body: string): string {
  const slash = body.indexOf("/");
  return slash >= 0 ? body.slice(0, slash) : body;
}

const ORIGIN_LABELS: Record<string, string> = { XY: "XY plane", XZ: "XZ plane", YZ: "YZ plane", X: "X axis", Y: "Y axis", Z: "Z axis", O: "Origin" };

/** A viewport selection item as the tools see it. */
export function toToolItem(it: ViewItem): SelectionItem {
  switch (it.kind) {
    case "face":
    case "edge":
    case "vertex":
      return { kind: it.kind, part: partOfBody(it.body), key: it.key, body: it.body, ...(it.point ? { point: it.point } : {}) };
    case "body":
      return { kind: "body", part: partOfBody(it.body), body: it.body };
    case "sketch":
      return { kind: "feature", feature: it.feature, label: it.feature };
    case "datum":
      return { kind: "datum", feature: it.feature, label: it.feature };
    case "origin":
      return { kind: "origin", feature: it.id, label: ORIGIN_LABELS[it.id] ?? it.id };
  }
}

/**
 * The viewport's selection (ordered, the first is the primary) plus the feature selected in the
 * timeline when it is not already among them (a datum feature as `datum`, others as `feature`).
 */
export function runtimeSelectionPort(services: AppServices): SelectionPort {
  const rt = viewportRuntime(services);
  let lastSel = rt.selection.getState().items;
  let lastDoc = services.doc.getState().selection;
  let cached: SelectionItem[] = compute();
  function compute(): SelectionItem[] {
    const items = rt.selection.getState().items.map(toToolItem);
    const docSel = services.doc.getState().selection;
    if (docSel.featureId && !docSel.entity) {
      const loc = findFeature(services.doc.getState().model?.ir, docSel.featureId);
      if (loc) {
        const f = loc.feature;
        const type: string = f.type;
        const kind = type === "datum_plane" || type === "datum_axis" ? "datum" : "feature";
        if (!items.some((i) => (i.kind === "feature" || i.kind === "datum") && (i.feature === f.id || i.feature === f.name))) items.push({ kind, feature: f.id, label: f.name });
      }
    }
    return items;
  }
  const fresh = (): SelectionItem[] => {
    const sel = rt.selection.getState().items;
    const doc = services.doc.getState().selection;
    if (sel !== lastSel || doc !== lastDoc) {
      lastSel = sel;
      lastDoc = doc;
      cached = compute();
    }
    return cached;
  };
  return {
    items: fresh,
    subscribe(listener) {
      let prev = fresh();
      const check = (): void => {
        const next = fresh();
        if (next === prev) return;
        prev = next;
        listener();
      };
      const a = rt.selection.subscribe(check);
      const b = services.doc.subscribe(check);
      return () => {
        a();
        b();
      };
    },
  };
}

function specOf(h: PanelHandle): HandleSpec {
  const { field: _field, toText: _toText, ...spec } = h;
  return spec;
}

/** The open panel's handles in the viewport's manipulator host. */
export function manipulatorHandlesPort(host: ManipulatorHost): HandlesPort {
  let off: (() => void) | null = null;
  let ids = "";
  let listener: ((id: string, value: number, phase: "start" | "drag" | "end" | "cancel") => void) | null = null;
  return {
    show(handles, onChange) {
      listener = onChange;
      const key = handles.map((h) => `${h.id}:${h.kind}`).join("|");
      if (off && key === ids) {
        // Same handles, new geometry: update in place (a drag in progress keeps its value).
        const active = host.getState().active?.id ?? null;
        for (const h of handles) {
          const { value, ...rest } = specOf(h);
          host.update(h.id, h.id === active ? rest : { ...rest, value });
        }
        return;
      }
      off?.();
      ids = key;
      off = host.show(handles.map(specOf), (c) => listener?.(c.id, c.value, c.phase));
    },
    clear() {
      off?.();
      off = null;
      ids = "";
      listener = null;
    },
  };
}
