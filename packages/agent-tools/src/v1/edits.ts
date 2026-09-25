/**
 * IR v1 edits behind the one-step repair tools, mirroring the command-layer ops of SPEC-v1 §0.6 and
 * §5.9 (W9's DocStore ops apply the same changes in the app): `setParam`, `acceptRefCandidate`,
 * `acceptRefProposal`, and constraint removal / dimension values for `sketch_edit`. Each returns the
 * edited document; the tool splices it back into the CadScript source (`applyIrEdit`), so the file
 * stays the source of truth and every edit goes through the verification ladder.
 */
import { v1 as cs } from "@aicad/cadscript";
import { v1 as ir, type metricsV1 } from "@aicad/ir-types";
import { num, vec } from "../format.js";
import { candidateReplacementSafety, refCandidates, refUnresolvedV1 } from "./playbooks.js";
import { atPointer, displayName, irFeatureByName, obj, queryText, setAtPointer, str } from "./render.js";
import { allParams } from "./session.js";

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

function findParam(doc: ir.IrDocument, name: string): ir.Parameter | undefined {
  return [...(doc.params ?? []), ...doc.parts.flatMap((p) => p.params ?? [])].find((p) => p.name === name);
}

/**
 * `setParam(name, value)`: a literal (number or boolean) makes the parameter driving; a string is
 * an expression (a derived parameter). Units and bounds stay; the compiler re-checks them.
 */
export function setParamEdit(doc: ir.IrDocument, name: string, value: number | boolean | string): ir.IrDocument {
  const next = structuredClone(doc);
  const p = findParam(next, name);
  if (!p) {
    const names = allParams(doc).map((x) => x.name);
    throw new EditError(`no parameter ${JSON.stringify(name)} (parameters: ${names.join(", ") || "none"})`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new EditError("the value must be a finite number");
  if (p.unit === "bool" && typeof value === "number") throw new EditError(`${name} is a bool parameter: give true or false (or a condition as a string)`);
  if (p.unit !== "bool" && typeof value === "boolean") throw new EditError(`${name} is a ${p.unit} parameter: give a number (or an expression as a string)`);
  if (p.unit === "count" && typeof value === "number" && !Number.isInteger(value)) throw new EditError(`${name} is a count: give a whole number`);
  p.value = value;
  return next;
}

/**
 * The report entry of one Ref field of a feature and its unresolved members, from the same source
 * as the repair hint ({@link refUnresolvedV1}: the `refs` entry when it lists unresolved members,
 * else the error's details). `conflict` is set when both list candidates and the lists differ.
 */
export function refEntry(
  report: metricsV1.EvalReport | null,
  feature: string,
  field: string,
): { entry: metricsV1.FeatureReport; ref?: metricsV1.RefReport; unresolved: readonly unknown[]; conflict?: string } | undefined {
  const entry = report?.features.find((f) => f.feature === feature);
  if (!entry) return undefined;
  const ref = entry.refs?.find((r) => r.field === field);
  const details = entry.error?.details;
  const raw = str(details, "field") === field ? details?.["unresolved"] : undefined;
  const source = refUnresolvedV1(Array.isArray(raw) ? raw : [], ref?.unresolved);
  return { entry, ...(ref ? { ref } : {}), unresolved: source.unresolved, ...(source.conflict === undefined ? {} : { conflict: source.conflict }) };
}

function refAt(doc: ir.IrDocument, feature: string, field: string): { f: ir.Feature; ref: Record<string, unknown> } {
  const f = irFeatureByName(doc, feature);
  if (!f) throw new EditError(`no feature ${JSON.stringify(feature)}`);
  const ref = obj(atPointer(f, field));
  if (!ref || typeof ref["kind"] !== "string" || !obj(ref["q"])) throw new EditError(`${feature} has no reference at ${field}`);
  return { f, ref: ref as Record<string, unknown> };
}

export interface CandidateChoice {
  index: number;
  name: string;
  query: unknown;
  /** The candidate's provenance key (split pieces share one: the probe tells them apart). */
  key: string | undefined;
  /** The candidate's probe (SPEC-v1 §7.6): where the chosen entity is. */
  probe: metricsV1.Probe | undefined;
}

/**
 * `acceptRefCandidate`: replace the reference's query by candidate `index`'s synthesised query (the
 * numbering of the repair hint) and keep its declared count.
 *
 * - Refused unless the replacement is safe ({@link candidateReplacementSafety}): the reference
 *   designates one entity (`card` `one`/`1`), one member failed, and it resolves nothing but that
 *   member's candidates. A multi-member reference (`.some()`, `.exactly(n)`) would otherwise lose
 *   every other member while still verifying — silently wrong geometry.
 * - Deliberate deviation from SPEC-v1 §5.9 until `captureRef` reaches the agent's engine: §5.9 also
 *   "refreshes the capture"; here the stale capture is dropped (CadScript cannot write one, and
 *   `compile(src, { base })` only carries a capture over an unchanged query). The new query then
 *   resolves exactly without a capture; the app's command layer captures it on its next save.
 *   W9 landed `captureRef` in forge-wasm (the app's command engine, `packages/app/src/doc/v1/
 *   command-engine.ts`), but the native `aicad` CLI the agent evaluates with does not offer it
 *   (checked again 2026-09-25: `aicad` offers eval, export, migrate and solve). When an `EngineV1`
 *   can capture, refresh the capture here: splice the edit, then pass the captured document as the
 *   apply's `base` (the capture carries over because the query is unchanged from it). Until then
 *   the deviation is never silent: the tool's result says the reference has no capture, and the
 *   session lists it (`DesignSessionV1.uncapturedRepairs`) under the proposal's known_issues — an
 *   open W10 acceptance item, not a finished one.
 *
 * Candidates are chosen by position, not by key: the pieces of a split share their key
 * (`e1/side:bottom` for both `…#0` and `…#1`), so a key cannot name one (SPEC §5.9's
 * `candidateKey` has the same problem: reported under CONTRACT ISSUES).
 */
export function acceptCandidateEdit(doc: ir.IrDocument, report: metricsV1.EvalReport | null, feature: string, field: string, index: number): { doc: ir.IrDocument; chosen: CandidateChoice } {
  const found = refEntry(report, feature, field);
  if (!found) throw new EditError(`no report entry for ${JSON.stringify(feature)} (apply the model first)`);
  if (found.conflict !== undefined) throw new EditError(`${feature} ${field}: ${found.conflict}; narrow the query with a patch instead`);
  const cands = refCandidates(found.unresolved);
  if (cands.length === 0) throw new EditError(`${feature} ${field} has no candidates (the reference ${found.ref?.status === "exact" ? "resolves exactly" : "offers none"}): narrow the query with a patch instead`);
  const c = cands.find((x) => x.index === index);
  if (!c) throw new EditError(`no candidate ${index}: ${feature} ${field} has ${cands.length} (1–${cands.length})`);
  const q = c.candidate["query"];
  if (!obj(q)) throw new EditError(`candidate ${index} has no synthesised query: narrow the query with a patch instead`);
  const current = refAt(doc, feature, field);
  const safety = candidateReplacementSafety(current.ref, current.f.type, field, found.ref, found.unresolved);
  if (!safety.ok) {
    throw new EditError(
      `accept_ref_candidate would replace the whole query of ${feature} ${field}, but ${safety.reason}: rewrite the query with apply_cadscript patches instead (keep what it should still select; candidate ${index} alone is ${queryText({ ir: doc, report }, q, typeof current.ref["kind"] === "string" ? current.ref["kind"] : "face")})`,
    );
  }
  const next = structuredClone(doc);
  const { ref } = refAt(next, feature, field);
  const replaced: Record<string, unknown> = { kind: ref["kind"], q: structuredClone(q) };
  if (ref["card"] !== undefined) replaced["card"] = ref["card"];
  const f = irFeatureByName(next, feature)!;
  if (!setAtPointer(f, field, replaced)) throw new EditError(`cannot write ${feature} ${field}`);
  const probe = obj(c.candidate["probe"]) as metricsV1.Probe | undefined;
  return { doc: next, chosen: { index, name: str(c.candidate, "name") ?? "?", query: q, key: str(c.candidate, "key"), probe } };
}

/**
 * How far a member's probe may be from the chosen candidate's: SPEC-v1 [W0-35]'s largest
 * probe-matching radius (5·LINEAR_TOLERANCE). Both probes come from the same engine on the same
 * upstream geometry (only the consuming feature's query changed), so they agree far closer than that.
 */
export const CANDIDATE_PROBE_RADIUS_MM = 5 * ir.LINEAR_TOLERANCE;

function probeLine(p: metricsV1.Probe | undefined): string {
  if (!p || !Array.isArray(p.point)) return "no probe";
  return `${p.kind} at ${vec(p.point)}${Array.isArray(p.normal) ? ` facing ${vec(p.normal)}` : ""}`;
}

function memberLine(m: metricsV1.RefMember): string {
  return `${displayName(m.name || m.key)} (${probeLine(m.probe)})`;
}

/**
 * SPEC-v1 §5.8 only says a candidate's synthesised query SHOULD select exactly that candidate; a
 * synthesis bug (e.g. the "extreme along the best-separating axis" strategy) would re-aim the
 * feature at another entity while the model still verifies. After `accept_ref_candidate`'s edit is
 * evaluated, the reference must resolve to exactly one member with the candidate's key whose probe
 * is the candidate's (same kind, point within {@link CANDIDATE_PROBE_RADIUS_MM}, normals — when both
 * carry one — on the same side). Returns what differs, or undefined when it is the candidate.
 */
export function candidateResolutionProblem(report: metricsV1.EvalReport, feature: string, field: string, chosen: CandidateChoice): string | undefined {
  const want = `candidate ${chosen.index} ${displayName(chosen.name)} (${probeLine(chosen.probe)})`;
  const entry = report.features.find((f) => f.feature === feature);
  if (!entry) return `the edited model's report has no entry for ${feature}, so it cannot be checked that ${field} now designates ${want}`;
  const ref = entry.refs?.find((r) => r.field === field);
  if (!ref) return `${feature}'s report has no refs entry for ${field}, so it cannot be checked that it now designates ${want}`;
  const members = ref.members ?? [];
  if (members.length !== 1) {
    const got = members.length === 0 ? `nothing${ref.code ? ` (${ref.code})` : ""}` : `${members.length} entities: ${members.slice(0, 3).map(memberLine).join("; ")}${members.length > 3 ? "; …" : ""}`;
    return `the candidate's synthesised query makes ${feature} ${field} resolve ${got} instead of exactly ${want}`;
  }
  const m = members[0]!;
  const off = (why: string) => `the candidate's synthesised query makes ${feature} ${field} resolve ${memberLine(m)} instead of ${want}: ${why}`;
  if (chosen.key !== undefined && m.key !== chosen.key) return off(`key ${m.key} is not the candidate's ${chosen.key}`);
  const p = chosen.probe;
  if (!p || !Array.isArray(p.point) || !m.probe || !Array.isArray(m.probe.point)) return off("the probes cannot be compared");
  if (m.probe.kind !== p.kind) return off(`a ${m.probe.kind}, not a ${p.kind}`);
  const d = Math.hypot(m.probe.point[0] - p.point[0], m.probe.point[1] - p.point[1], m.probe.point[2] - p.point[2]);
  if (!(d <= CANDIDATE_PROBE_RADIUS_MM)) return off(`its probe is ${d < 0.001 ? d.toExponential(2) : num(d)} mm from the candidate's`);
  if (Array.isArray(p.normal) && Array.isArray(m.probe.normal) && p.normal[0] * m.probe.normal[0] + p.normal[1] * m.probe.normal[1] + p.normal[2] * m.probe.normal[2] <= 0) return off("it faces the other way");
  return undefined;
}

/** `acceptRefProposal`: apply the reference's `proposal` (query and fresh capture). */
export function acceptProposalEdit(doc: ir.IrDocument, report: metricsV1.EvalReport | null, feature: string, field: string): ir.IrDocument {
  const found = refEntry(report, feature, field);
  const proposal = found?.ref?.proposal ?? obj(found?.entry.warnings?.find((w) => str(w.details, "field") === field && w.details?.["proposal"] !== undefined)?.details?.["proposal"]);
  if (!proposal) throw new EditError(`${feature} ${field} has no proposal (only REF_REPAIRED and REF_SET_CHANGED offer one)`);
  const next = structuredClone(doc);
  refAt(next, feature, field);
  const f = irFeatureByName(next, feature)!;
  if (!setAtPointer(f, field, structuredClone(proposal))) throw new EditError(`cannot write ${feature} ${field}`);
  return next;
}

/** `sketch_edit`: remove constraints by id and set dimension values (numbers or expressions). */
export function sketchEdit(doc: ir.IrDocument, sketch: string, change: { remove?: readonly string[]; set?: Readonly<Record<string, number | string>> }): ir.IrDocument {
  const next = structuredClone(doc);
  const f = irFeatureByName(next, sketch);
  if (!f || f.type !== "sketch") throw new EditError(`no sketch ${JSON.stringify(sketch)}`);
  const constraints = (f.constraints ?? []) as unknown as Record<string, unknown>[];
  const ids = constraints.map((c) => String(c["id"]));
  for (const id of change.remove ?? []) if (!ids.includes(id)) throw new EditError(`${sketch} has no constraint ${JSON.stringify(id)} (constraints: ${ids.join(", ") || "none"})`);
  for (const [id, value] of Object.entries(change.set ?? {})) {
    const c = constraints.find((x) => x["id"] === id);
    if (!c) throw new EditError(`${sketch} has no constraint ${JSON.stringify(id)} (constraints: ${ids.join(", ") || "none"})`);
    if (!["distance", "angle", "radius", "diameter"].includes(String(c["type"]))) throw new EditError(`${id} is a ${String(c["type"])} constraint: only distance, angle, radius and diameter take a value`);
    if (c["driving"] === false) throw new EditError(`${id} is a reference dimension (driving: false): it has no value to set`);
    c["value"] = value;
  }
  const removed = new Set(change.remove ?? []);
  const kept = constraints.filter((c) => !removed.has(String(c["id"])));
  (f as unknown as Record<string, unknown>)["constraints"] = kept;
  if (kept.length === 0) delete (f as unknown as Record<string, unknown>)["constraints"];
  return next;
}

/**
 * Splice an edited document into the source (`applyIrEdit`, which keeps untouched text verbatim and
 * checks that the result compiles back to `after`).
 */
export function spliceEdit(source: string, before: ir.IrDocument, after: ir.IrDocument): string {
  try {
    return cs.applyIrEdit(source, before, after);
  } catch (e) {
    throw new EditError(`the edit cannot be written into the source: ${e instanceof Error ? e.message : String(e)}`);
  }
}
