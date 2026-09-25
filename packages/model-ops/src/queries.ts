/**
 * Queries on a document (no edits; FULL-MODELING-PLAN §2.2 "Queries"): read-only agent tools and
 * the UI's dependency warnings use them.
 */
import { applyOp } from "./apply.js";
import { parseDoc, requireFeature, requireParam, type DocJson } from "./doc.js";
import { CommandEngineError, type IrCommandEngine } from "./engine.js";

export interface FeatureDependents {
  feature: string;
  /** Features that reference it by id, directly or through another dependent (with the reference's code and path). */
  dependents: Array<{ id: string; name: string; type: string; code: string; path: string }>;
}

/** The features that reference `feature` by id (the engine's own reference check decides). */
export async function dependents(engine: IrCommandEngine, document: string, feature: string): Promise<FeatureDependents> {
  const id = requireFeature(parseDoc(document), feature).feature.id;
  try {
    await applyOp(engine, document, { op: "deleteFeature", feature: id, dependents: "refuse" });
    return { feature: id, dependents: [] };
  } catch (e) {
    if (e instanceof CommandEngineError && e.code === "COMMAND_HAS_DEPENDENTS") {
      return { feature: id, dependents: e.details["dependents"] as FeatureDependents["dependents"] };
    }
    throw e;
  }
}

export interface ParamUses {
  param: string;
  uses: Array<{ path: string; feature?: string; param?: string; text: string }>;
}

/** Every expression that uses a parameter. */
export async function paramUses(engine: IrCommandEngine, document: string, name: string): Promise<ParamUses> {
  requireParam(parseDoc(document), name);
  try {
    await applyOp(engine, document, { op: "deleteParam", name, uses: "refuse" });
    return { param: name, uses: [] };
  } catch (e) {
    if (e instanceof CommandEngineError && e.code === "COMMAND_PARAM_IN_USE") return { param: name, uses: e.details["uses"] as ParamUses["uses"] };
    throw e;
  }
}

/**
 * The document cut at the rollback marker (FULL-MODELING-PLAN §2.3; `evaluateThrough`): the part
 * that holds `after` keeps its features up to and including it; later ones are not built. Other
 * parts are unchanged. Returns JSON text for evaluation (not canonical: nothing is stored).
 */
export function rolledBack(document: string, after: string | null): string {
  if (after === null) return document;
  const d: DocJson = parseDoc(document);
  for (const p of d.parts) {
    const i = p.features.findIndex((f) => f.id === after);
    if (i >= 0) {
      p.features = p.features.slice(0, i + 1);
      return JSON.stringify(d);
    }
  }
  return document;
}

/** The ids of the features after the rollback marker (shown rolled back in the timeline). */
export function rolledBackFeatures(document: string, after: string | null): string[] {
  if (after === null) return [];
  const d = parseDoc(document);
  for (const p of d.parts) {
    const i = p.features.findIndex((f) => f.id === after);
    if (i >= 0) return p.features.slice(i + 1).map((f) => f.id);
  }
  return [];
}
