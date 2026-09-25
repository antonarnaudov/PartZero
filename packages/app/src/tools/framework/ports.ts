/**
 * Default bindings of the tool ports to today's app: the document store's single selection (a
 * feature, or a picked body/face/edge), the document's parameters as the last evaluation reported
 * them, and the document's revision and features. The selection workstream (SEL, contract C2) and
 * the IR v1 store replace these with richer sources through `Shell.bindPorts` without touching any
 * tool.
 */
import type { DocState, DocStore } from "../../doc/doc-store";
import { findFeature } from "../../doc/provenance";
import type { DocumentPort, FeatureInfo, ParamInfo, ParamsPort, SelectionItem, SelectionPort } from "./types";

/** `part/feature#2` → `part`. */
function partOfBody(body: string): string {
  const slash = body.indexOf("/");
  return slash >= 0 ? body.slice(0, slash) : body;
}

/** The document store's selection as selection items (at most one item today). */
export function docSelectionItems(doc: DocStore): SelectionItem[] {
  const s = doc.getState();
  const e = s.selection.entity;
  if (e) {
    const part = partOfBody(e.body);
    if (e.face) return [{ kind: "face", part, key: e.face, body: e.body }];
    if (e.edge) return [{ kind: "edge", part, key: e.edge, body: e.body }];
    return [{ kind: "body", part, body: e.body }];
  }
  if (s.selection.featureId) {
    const loc = findFeature(s.model?.ir, s.selection.featureId);
    return [{ kind: "feature", feature: s.selection.featureId, ...(loc ? { label: loc.feature.name } : {}) }];
  }
  return [];
}

export function docSelectionPort(doc: DocStore): SelectionPort {
  let last = doc.getState().selection;
  let cached = docSelectionItems(doc);
  return {
    items: () => {
      const cur = doc.getState().selection;
      if (cur !== last) {
        last = cur;
        cached = docSelectionItems(doc);
      }
      return cached;
    },
    subscribe: (listener) => {
      let prev = doc.getState().selection;
      return doc.subscribe(() => {
        const cur = doc.getState().selection;
        if (cur === prev) return;
        prev = cur;
        listener();
      });
    },
  };
}

/**
 * Parameters from the last evaluation report (`aicad.metrics/1` lists them with their values).
 * An `aicad.metrics/0` report (IR v0) has none.
 */
export function reportParams(report: unknown): ParamInfo[] {
  if (!report || typeof report !== "object") return [];
  const params = (report as { params?: unknown }).params;
  if (!Array.isArray(params)) return [];
  const out: ParamInfo[] = [];
  for (const p of params) {
    if (!p || typeof p !== "object") continue;
    const { name, unit, value, part, scope } = p as Record<string, unknown>;
    if (typeof name !== "string" || (unit !== "mm" && unit !== "deg" && unit !== "ratio" && unit !== "count" && unit !== "bool")) continue;
    const v = typeof value === "number" || typeof value === "boolean" ? value : null;
    const owner = typeof part === "string" ? part : typeof scope === "string" && scope !== "doc" ? scope : undefined;
    out.push({ name, unit, value: v, ...(owner !== undefined ? { part: owner } : {}) });
  }
  return out;
}

export function docParamsPort(doc: DocStore): ParamsPort {
  return { list: () => reportParams(doc.getState().report) };
}

/**
 * The document store as a {@link DocumentPort}: the revision moves when another document loads, the
 * source changes (edits, undo/redo, the code editor, accepted proposals) or a new evaluation report
 * arrives. Selection changes don't move it.
 */
export function docDocumentPort(doc: DocStore): DocumentPort {
  const key = (s: DocState) => ({ docId: s.docId, revision: s.revision, report: s.report });
  let seen = key(doc.getState());
  let rev = 0;
  const revision = (): number => {
    const s = doc.getState();
    if (s.docId !== seen.docId || s.revision !== seen.revision || s.report !== seen.report) {
      seen = key(s);
      rev++;
    }
    return rev;
  };
  return {
    revision,
    subscribe: (listener) => {
      let prev = revision();
      return doc.subscribe(() => {
        const r = revision();
        if (r === prev) return;
        prev = r;
        listener();
      });
    },
    feature: (idOrName) => {
      const s = doc.getState();
      const loc = findFeature(s.model?.ir, idOrName);
      if (!loc) return null;
      const info: FeatureInfo = { id: loc.feature.id, name: loc.feature.name, type: loc.feature.type, part: loc.part.id, json: structuredClone(loc.feature) as unknown as Record<string, unknown> };
      return info;
    },
  };
}

/** A document whose revision a test moves by hand. */
export function staticDocumentPort(features: readonly FeatureInfo[] = []): DocumentPort & { bump(): void } {
  let rev = 0;
  const listeners = new Set<() => void>();
  return {
    revision: () => rev,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    feature: (idOrName) => features.find((f) => f.id === idOrName) ?? features.find((f) => f.name === idOrName) ?? null,
    bump: () => {
      rev++;
      for (const l of [...listeners]) l();
    },
  };
}

/** A fixed selection (tests, scripted tools). */
export function staticSelectionPort(items: readonly SelectionItem[] = []): SelectionPort & { set(items: readonly SelectionItem[]): void } {
  let current = items;
  const listeners = new Set<() => void>();
  return {
    items: () => current,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set: (next) => {
      current = next;
      for (const l of [...listeners]) l();
    },
  };
}

export function staticParamsPort(params: readonly ParamInfo[] = []): ParamsPort {
  return { list: () => params };
}
