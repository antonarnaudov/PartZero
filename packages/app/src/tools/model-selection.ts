/**
 * The tool framework's ports on the viewport (FULL-MODELING-PLAN §2.4–§2.6, contracts C2/C3):
 *
 * - {@link modelSelectionPort}: the tools' {@link SelectionPort} over the selection model (the
 *   viewport's multi-selection of faces, edges, vertices, bodies, sketches, datums and origin
 *   planes/axes) plus the timeline's feature selection. Model entities keep their provenance name
 *   and the point where they were picked (what `refFor` needs), and a human label.
 * - {@link manipulatorHandlesPort}: panels' handles on the viewport's manipulator host.
 * - {@link bindToolPicking}: while an open panel has an active selection input, the viewport
 *   **picks for it**: a click adds or removes the entity under the cursor (no Shift needed, as in
 *   Fusion and Shapr3D), a click on empty space keeps what was picked, the kind filter admits only
 *   the kinds the input takes (restored after), and timeline clicks add or remove features.
 */
import type { AppServices } from "../services";
import { labelOf } from "../selection/labels";
import { ORIGIN_IDS, type OriginId, type SelectionItem as ViewItem, type SelectionKind as ViewKind } from "../selection/types";
import { viewportRuntime } from "../viewport/runtime";
import type { HandlesPort, SelectionItem, SelectionKind, SelectionPort } from "./framework/types";
import type { Shell } from "./shell";

function v1Parts(services: AppServices): Array<{ id: string; name: string; features: Array<{ id: string; name: string; type: string }> }> {
  const s = services.doc.getState();
  if (s.format !== "ir-v1") return [];
  try {
    return (JSON.parse(s.source) as { parts: Array<{ id: string; name: string; features: Array<{ id: string; name: string; type: string }> }> }).parts;
  } catch {
    return [];
  }
}

/** `part/slab#1` → the id of the part named `part` (else the first part's, else the name). */
export function partOfBody(services: AppServices, body: string): string {
  const slash = body.indexOf("/");
  const name = slash >= 0 ? body.slice(0, slash) : body;
  const parts = v1Parts(services);
  return parts.find((p) => p.name === name)?.id ?? parts.find((p) => p.id === name)?.id ?? parts[0]?.id ?? name;
}

/** A viewport selection item as the tools see it. */
export function toToolItem(services: AppServices, it: ViewItem): SelectionItem {
  const ir = services.doc.getState().model?.ir ?? null;
  const label = labelOf(it, ir);
  switch (it.kind) {
    case "face":
    case "edge":
    case "vertex":
      return { kind: it.kind, part: partOfBody(services, it.body), key: it.key, body: it.body, ...(it.point ? { point: it.point } : {}), label };
    case "body":
      return { kind: "body", part: partOfBody(services, it.body), body: it.body, label };
    case "sketch": {
      const f = v1Parts(services).flatMap((p) => p.features).find((x) => x.id === it.feature || x.name === it.feature);
      return { kind: "feature", feature: f?.id ?? it.feature, label: f?.name ?? it.feature };
    }
    case "datum":
      return { kind: "datum", feature: it.feature, label };
    case "origin":
      return { kind: "origin", feature: it.id, label };
  }
}

/** The kinds of the viewport's filter that admit the tool kinds `accepts`. */
export function viewKindsFor(accepts: readonly SelectionKind[]): ViewKind[] {
  const out = new Set<ViewKind>();
  for (const k of accepts) {
    if (k === "face" || k === "edge" || k === "vertex" || k === "body" || k === "datum" || k === "origin") out.add(k);
    if (k === "feature") out.add("sketch");
  }
  return [...out];
}

interface PickingState {
  /** The timeline features picked while picking (a timeline click toggles one). */
  features: SelectionItem[];
}

const picking = new WeakMap<AppServices, PickingState>();
const pickingListeners = new WeakMap<AppServices, Set<() => void>>();

function notifyPicking(services: AppServices): void {
  for (const l of [...(pickingListeners.get(services) ?? [])]) l();
}

/** The selection the tools see: the viewport's items, then the timeline's feature(s). */
export function modelSelectionPort(services: AppServices): SelectionPort {
  const rt = viewportRuntime(services);
  let key = "";
  let cached: SelectionItem[] = [];
  const compute = (): SelectionItem[] => {
    const view = rt.selection.getState().items.map((it) => toToolItem(services, it));
    const p = picking.get(services);
    const docSel = services.doc.getState().selection;
    const extra: SelectionItem[] = [];
    if (p) extra.push(...p.features);
    else if (docSel.featureId && !docSel.entity) {
      const f = v1Parts(services).flatMap((x) => x.features).find((x) => x.id === docSel.featureId || x.name === docSel.featureId);
      extra.push({ kind: "feature", feature: f?.id ?? docSel.featureId, label: f?.name ?? docSel.featureId });
    }
    const seen = new Set(view.filter((i) => i.kind === "feature").map((i) => (i as { feature: string }).feature));
    return [...view, ...extra.filter((i) => i.kind !== "feature" || !seen.has(i.feature))];
  };
  const stamp = (): string => `${rt.selection.getState().revision}|${services.doc.getState().selection.featureId ?? ""}|${services.doc.getState().docId}|${picking.get(services)?.features.map((f) => (f as { feature: string }).feature).join(",") ?? "-"}`;
  return {
    items: () => {
      const k = stamp();
      if (k !== key) {
        key = k;
        cached = compute();
      }
      return cached;
    },
    subscribe: (listener) => {
      let last = stamp();
      const check = (): void => {
        const k = stamp();
        if (k === last) return;
        last = k;
        listener();
      };
      const a = rt.selection.subscribe(check);
      const b = services.doc.subscribe(check);
      let set = pickingListeners.get(services);
      if (!set) pickingListeners.set(services, (set = new Set()));
      const listeners = set;
      listeners.add(check);
      return () => {
        a();
        b();
        listeners.delete(check);
      };
    },
  };
}

/** Panels' handles on the viewport's manipulator host. */
export function manipulatorHandlesPort(services: AppServices): HandlesPort {
  const rt = viewportRuntime(services);
  return {
    show: (handles, listener) => rt.manipulators.show(handles, listener),
    update: (id, patch) => rt.manipulators.update(id, patch),
    dragging: () => rt.manipulators.dragging,
  };
}

/** A tool item as a viewport selection item (null: not a viewport pick, e.g. a timeline feature). */
export function toViewItem(services: AppServices, it: SelectionItem): ViewItem | null {
  switch (it.kind) {
    case "face":
    case "edge":
    case "vertex":
      return it.body && !it.refMember ? { kind: it.kind, body: it.body, key: it.key, ...(it.point ? { point: [it.point[0], it.point[1], it.point[2]] } : {}) } : null;
    case "body":
      return it.refMember ? null : { kind: "body", body: it.body };
    case "origin":
      return (ORIGIN_IDS as readonly string[]).includes(it.feature) ? { kind: "origin", id: it.feature as OriginId } : null;
    case "datum":
      return { kind: "datum", feature: it.feature };
    case "feature": {
      const f = v1Parts(services).flatMap((p) => p.features).find((x) => x.id === it.feature || x.name === it.feature);
      return f?.type === "sketch" ? { kind: "sketch", feature: f.name } : null;
    }
    default:
      return null;
  }
}

/**
 * While the open panel has an active selection input, the viewport picks for it (see the file
 * comment): when an input becomes active, the viewport selection becomes what the input holds, the
 * filter admits its kinds, and clicks toggle (or replace, for an input of one item). OK clears the
 * selection; Cancel keeps it. Returns an unbind function.
 */
export function bindToolPicking(shell: Shell, services: AppServices): () => void {
  const rt = viewportRuntime(services);
  let active: { panel: number; field: string; savedFilter: Record<string, boolean> } | null = null;
  let offPanel: (() => void) | null = null;
  let lastDocFeature: string | null = null;

  const end = (committed: boolean): void => {
    if (!active) return;
    rt.pickForTool = false;
    picking.delete(services);
    rt.selection.setFilter(active.savedFilter as never);
    if (committed) rt.selectItems([]);
    active = null;
  };

  const sync = (): void => {
    const panel = shell.getState().panel;
    const st = panel ? panel.getState() : null;
    if (!st || st.state === "closed") return end(st?.closedBy === "ok");
    const fieldKey = st.activeSelectionField;
    const field = fieldKey ? st.fields.find((f) => f.key === fieldKey) : undefined;
    if (!field || field.spec.kind !== "selection" || !field.visible) return end(false);
    if (active && active.panel === st.id && active.field === field.key) return;
    const savedFilter = active ? active.savedFilter : { ...rt.selection.getState().filter };
    if (active) {
      rt.pickForTool = false;
      picking.delete(services);
    }
    active = { panel: st.id, field: field.key, savedFilter };
    const items = field.value as readonly SelectionItem[];
    // Timeline features the input holds; the viewport shows the rest.
    picking.set(services, { features: items.filter((i) => i.kind === "feature" && toViewItem(services, i) === null) });
    lastDocFeature = services.doc.getState().selection.featureId;
    const kinds = viewKindsFor(field.spec.accepts);
    if (kinds.length > 0) {
      const next: Record<string, boolean> = {};
      for (const k of Object.keys(savedFilter)) next[k] = kinds.includes(k as ViewKind);
      rt.selection.setFilter(next as never);
    }
    rt.pickForTool = field.spec.max === 1 ? "replace" : "toggle";
    rt.selection.set(items.map((i) => toViewItem(services, i)).filter((i): i is ViewItem => i !== null));
    // A timeline row already selected must register when clicked again (to take it out).
    if (services.doc.getState().selection.featureId && !services.doc.getState().selection.entity) {
      services.doc.clearSelection();
      lastDocFeature = null;
    }
    notifyPicking(services);
  };

  const onShell = (): void => {
    const panel = shell.getState().panel;
    offPanel?.();
    offPanel = panel ? panel.subscribe(sync) : null;
    sync();
  };
  const offShell = shell.subscribe(onShell);
  // Timeline clicks while picking toggle features into the input (or replace, for one item).
  const offDoc = services.doc.subscribe(() => {
    const p = picking.get(services);
    const id = services.doc.getState().selection.featureId;
    if (!p || id === lastDocFeature) return;
    lastDocFeature = id;
    if (!id || services.doc.getState().selection.entity) return;
    const f = v1Parts(services).flatMap((x) => x.features).find((x) => x.id === id || x.name === id);
    // The row stays clickable: a second click on it takes it out again.
    queueMicrotask(() => {
      if (services.doc.getState().selection.featureId === id && !services.doc.getState().selection.entity) {
        lastDocFeature = null;
        services.doc.clearSelection();
      }
    });
    if (f?.type === "sketch") {
      // A sketch is a viewport item (it is drawn there): it goes through the viewport selection.
      const it: ViewItem = { kind: "sketch", feature: f.name };
      if (rt.pickForTool === "replace") rt.selection.set([it]);
      else rt.selection.toggle(it);
      return;
    }
    const item: SelectionItem = { kind: "feature", feature: f?.id ?? id, label: f?.name ?? id };
    const has = p.features.some((x) => x.kind === "feature" && x.feature === item.feature);
    if (rt.pickForTool === "replace") p.features = [item];
    else p.features = has ? p.features.filter((x) => !(x.kind === "feature" && x.feature === item.feature)) : [...p.features, item];
    notifyPicking(services);
  });
  onShell();
  return () => {
    end(false);
    offShell();
    offPanel?.();
    offDoc();
  };
}

