/**
 * Queries a manual tool and the agent share for **picked geometry** (FULL-MODELING-PLAN §2.2
 * "Queries", §2.5–§2.6): where a new feature goes, the Ref for entities picked in a view
 * (`refFor`, synthesized and verified by Forge) and the **feasible range** of a feature's size
 * field (`feasibleRange`: a fillet's `r`, a chamfer's `d`, a shell's `thickness`), which handles
 * clamp to before a drag starts and panels offer as "Use 3.41 mm".
 *
 * Nothing here writes: tools and the agent commit the results through the same catalogue ops
 * (`addFeature`, `setField`) and so the same transactions, failure rule and authorship rules.
 */
import { CommandEngineError, type IrCommandEngine, type RefForRequest, type RefForResult } from "./engine.js";
import { isObject, parseDoc, requireFeature, requirePart, type FeatureJson, type JsonObject } from "./doc.js";

/**
 * The feature a new feature of `part` is inserted after (an `addFeature` without `after`): the
 * rollback marker when it is in that part, else the part's last feature; `null` when the part has
 * no features (the new one goes first).
 */
export function insertionPoint(document: string, part: string | undefined, rollback: string | null): { part: string; after: string | null } {
  const d = parseDoc(document);
  const { part: p } = requirePart(d, part);
  if (rollback !== null && p.features.some((f) => f.id === rollback)) return { part: p.id, after: rollback };
  const last = p.features[p.features.length - 1];
  return { part: p.id, after: last ? last.id : null };
}

/**
 * A Ref for picked entities, in the scope where a new feature of `part` goes (at the rollback
 * marker, or at the end), or where an existing feature `feature` sits (the Ref then resolves in its
 * input state: re-editing a fillet's edges). Forge synthesizes and verifies it (`refFor`).
 */
export async function refForPicks(
  engine: IrCommandEngine,
  document: string,
  request: RefForRequest,
  at: { part?: string; rollback?: string | null; feature?: string },
): Promise<RefForResult> {
  if (at.feature !== undefined) {
    const d = parseDoc(document);
    const loc = requireFeature(d, at.feature);
    const before = loc.index > 0 ? loc.part.features[loc.index - 1]!.id : null;
    if (before === null) {
      throw new CommandEngineError("COMMAND_PICK_NOT_FOUND", `${loc.feature.id} is the first feature of its part: nothing is there to pick before it`, [], { pick: 0, reason: "first-feature" });
    }
    return engine.refFor(document, loc.part.id, before, request);
  }
  const p = insertionPoint(document, at.part, at.rollback ?? null);
  if (p.after === null) throw new CommandEngineError("COMMAND_PICK_NOT_FOUND", "the part has no features: nothing is there to pick", [], { pick: 0, reason: "empty-part" });
  return engine.refFor(document, p.part, p.after, request);
}

// ─── Feasible ranges ──────────────────────────────────────────────────────────────────────────

/** How Forge reports the largest value of a size field that builds (SPEC-v1 §6.6–§6.8). */
export const FEASIBLE_FIELDS: Readonly<Record<string, { field: string; code: string; detail: string; what: string }>> = {
  fillet: { field: "r", code: "FILLET_RADIUS_TOO_LARGE", detail: "max_feasible_r", what: "radius" },
  chamfer: { field: "d", code: "CHAMFER_DISTANCE_TOO_LARGE", detail: "max_feasible_d", what: "distance" },
  shell: { field: "thickness", code: "SHELL_THICKNESS_TOO_LARGE", detail: "max_feasible_thickness", what: "thickness" },
};

/** A size far beyond any part (mm): the probe value that makes Forge report the maximum. */
export const FEASIBLE_PROBE = 100_000;

export interface FeasibleRange {
  /** The feature (its id, or the candidate's). */
  feature: string;
  field: string;
  /** Values must be greater than this (a size > 0). */
  min: number;
  minExclusive: true;
  /** The largest value that builds, rounded down to 0.001 mm by Forge (absent: no limit was found). */
  max?: number;
  /** Why the range ends there (Forge's message: the face or wall that limits it), or why no maximum is known. */
  reason?: string;
  /** Forge's code of the failure that bounds the range when it is not a size limit (a blend running into another feature): with `max`, the largest size that built before it; without, no maximum is known. */
  code?: string;
}

/**
 * The feasible range of a size field (`r`, `d`, `thickness`) of a feature, with the rest of the
 * document fixed (the plan's `feasibleRange(feature, field)`): the field is set to a value no part
 * can take and the document evaluated through the feature, and Forge's `*_TOO_LARGE` error reports
 * the largest value that builds (computed analytically where it can, else by certified
 * bisection, and rounded down so it is safe to apply). `feature` is an existing feature's id, or a
 * candidate feature (JSON with an `id`) inserted after `after` in `part`.
 */
export async function feasibleRange(
  engine: IrCommandEngine,
  document: string,
  target: { feature: string } | { candidate: JsonObject; part?: string; after: string | null },
  field?: string,
): Promise<FeasibleRange> {
  const d = parseDoc(document);
  let feature: FeatureJson;
  let partIndex: number;
  let index: number;
  if ("feature" in target) {
    const loc = requireFeature(d, target.feature);
    feature = loc.feature;
    partIndex = loc.partIndex;
    index = loc.index;
  } else {
    const { part, partIndex: pi } = requirePart(d, target.part);
    const cand = structuredClone(target.candidate) as FeatureJson;
    if (typeof cand.id !== "string") cand.id = "__feasible";
    if (typeof cand.name !== "string") cand.name = cand.id;
    index = target.after === null ? 0 : part.features.findIndex((f) => f.id === target.after) + 1;
    if (index <= 0 && target.after !== null) throw new CommandEngineError("COMMAND_UNKNOWN_FEATURE", `there is no feature ${target.after} in part ${part.id}`, [], { feature: target.after });
    part.features.splice(index, 0, cand);
    feature = cand;
    partIndex = pi;
  }
  const spec = FEASIBLE_FIELDS[feature.type];
  if (!spec || (field !== undefined && field !== spec.field)) {
    throw new CommandEngineError(
      "COMMAND_NO_FEASIBLE_RANGE",
      `Forge reports a feasible range for ${Object.entries(FEASIBLE_FIELDS).map(([t, s]) => `${t}.${s.field}`).join(", ")} only`,
      [],
      { type: feature.type, field: field ?? null },
    );
  }
  const out: FeasibleRange = { feature: feature.id, field: spec.field, min: 0, minExclusive: true };
  // Evaluate through the feature only (later features cannot change its range).
  const part = d.parts[partIndex]!;
  part.features = part.features.slice(0, index + 1);
  const probe = async (v: number): Promise<Probe> => {
    (part.features[index] as JsonObject)[spec.field] = v;
    const report = await engine.report(JSON.stringify(d));
    const entry = report.features.find((f) => f.feature_id === feature.id);
    if (!entry) return { kind: "absent" };
    if (entry.status !== "error" || !entry.error) return { kind: "ok" };
    const details = isObject(entry.error.details) ? entry.error.details : {};
    const max = details[spec.detail];
    if (entry.error.code === spec.code && typeof max === "number" && Number.isFinite(max)) return { kind: "too-large", max, message: entry.error.message };
    return { kind: "failed", code: entry.error.code, message: entry.error.message };
  };
  const first = await probe(FEASIBLE_PROBE);
  if (first.kind === "absent") return { ...out, reason: "the feature was not evaluated (suppressed)" };
  if (first.kind === "ok") return { ...out, reason: `no limit: it builds at ${FEASIBLE_PROBE} mm` };
  if (first.kind === "too-large") return { ...out, max: first.max, reason: first.message };
  // A failure no size changes (a reference, an unsupported edge): no search.
  if (!SIZE_FAILURES.has(first.code)) return { ...out, code: first.code, reason: first.message };
  // Forge failed another way at that size (a blend running into another feature is a capability
  // gap, not a size limit, SPEC §6.6): find where the failures start. Quarter the size until it
  // builds (or Forge names a maximum), then bisect between the largest size that built and the
  // smallest that failed, to 0.001 mm. The value returned is one that was built.
  let bad = FEASIBLE_PROBE;
  let good: number | null = null;
  let last: { code: string; message: string } = { code: first.code, message: first.message };
  for (let i = 0; i < FEASIBLE_SEARCH_STEPS && good === null; i++) {
    const v = bad / 4;
    const r = await probe(v);
    if (r.kind === "too-large") return { ...out, max: r.max, reason: r.message };
    if (r.kind === "ok") good = v;
    else if (r.kind === "failed") {
      bad = v;
      last = { code: r.code, message: r.message };
    } else break;
  }
  if (good === null) return { ...out, code: last.code, reason: last.message };
  let built: number = good;
  for (let i = 0; i < FEASIBLE_SEARCH_STEPS && bad - built > 0.0005; i++) {
    const mid: number = (built + bad) / 2;
    const r = await probe(mid);
    if (r.kind === "too-large") return { ...out, max: r.max, reason: r.message };
    if (r.kind === "ok") built = mid;
    else {
      bad = mid;
      if (r.kind === "failed") last = { code: r.code, message: r.message };
    }
  }
  // Rounded down to 0.001 mm, and checked to build.
  let max = Math.floor(built * 1000) / 1000;
  for (let i = 0; i < 3 && max > 0 && max !== built; i++) {
    const r = await probe(max);
    if (r.kind === "ok") break;
    max = Math.round((max - 0.001) * 1000) / 1000;
  }
  if (!(max > 0)) return { ...out, code: last.code, reason: last.message };
  return { ...out, max, code: last.code, reason: `above ${max} mm: ${last.message}` };
}

/** Evaluations the fallback search of {@link feasibleRange} may spend per phase. */
const FEASIBLE_SEARCH_STEPS = 24;

/** Failures a smaller size can avoid (a blend or wall running into another feature), which the search looks below. */
const SIZE_FAILURES: ReadonlySet<string> = new Set(["FILLET_FAILED", "CHAMFER_FAILED", "SHELL_FAILED", "INVALID_RESULT"]);

type Probe = { kind: "absent" } | { kind: "ok" } | { kind: "too-large"; max: number; message: string } | { kind: "failed"; code: string; message: string };
