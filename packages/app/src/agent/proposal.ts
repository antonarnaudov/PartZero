/**
 * The agent's proposal as a reviewable change set (ARCHITECTURE §7 "Draft branch and diff"):
 *
 * - {@link diffProposal}: base IR → proposed IR, per feature (by part + feature name): added,
 *   removed or modified, with a one-line summary and the other changes it builds on.
 * - {@link buildVariant}: the IR you get by accepting only some changes, applied onto a target IR
 *   (the base, or the document as the user has edited it since: then conflicts are reported).
 * - {@link checkVariant}: dependency-aware warnings — rejecting a sketch an accepted extrude uses,
 *   or accepting the removal of a sketch that a kept feature still needs, breaks the model.
 * - {@link approvalsFor}: what your accept approves (ADR 0015): exactly the features and
 *   parameters the accepted changes modify or remove — nothing the list did not show you.
 *
 * On IR v1 models parameters are changes of their own (`param:<name>`, type `parameter`).
 *
 * Pure functions over `@aicad/ir-types`; the CadScript splice (`applyIrEdit`) and evaluation happen
 * in the agent service.
 */
import type { Feature, IrDocument, PartStudio, SketchCurve } from "@aicad/ir-types";

export type ChangeKind = "added" | "removed" | "modified";

export interface FeatureChange {
  /** `<part>/<feature>`, `param:<name>` for a parameter, or `doc:meta` for the document name/description. */
  key: string;
  /** The part's name (a parameter: its part, or `""` for a document parameter). */
  part: string;
  /** Feature name (the CadScript const) or parameter name; empty for `doc:meta`. */
  feature: string;
  /** Feature type (`sketch`, `extrude`, `revolve`, …), `parameter` or `document`. */
  type: string;
  kind: ChangeKind;
  /** Keys of other changes this one builds on (an extrude whose sketch the agent also added or changed). */
  requires: string[];
  /** One line, e.g. `distance 5 → 7 mm`. */
  summary: string;
}

export interface DependencyWarning {
  /** `error`: the accepted set does not form a valid model; `warning`: probably not what the agent intended. */
  severity: "error" | "warning";
  /** The change the warning is about (tick or untick it to resolve). */
  key: string;
  message: string;
}

export const META_KEY = "doc:meta";

/** A parameter change's key prefix: `param:<name>`. */
export const PARAM_PREFIX = "param:";

/** A parameter as IR v1 holds it (documents and parts); IR v0 has none. */
interface ParamJson {
  name: string;
  value?: unknown;
  unit?: string;
  [k: string]: unknown;
}

type WithParams = { params?: ParamJson[]; parts: Array<{ name: string; params?: ParamJson[] }> };

/** Every parameter by name, with its scope (`""`: the document; else the part's name). */
function paramsOf(ir: IrDocument): Map<string, { scope: string; param: ParamJson }> {
  const d = ir as unknown as WithParams;
  const out = new Map<string, { scope: string; param: ParamJson }>();
  for (const param of d.params ?? []) out.set(param.name, { scope: "", param });
  for (const part of d.parts) for (const param of part.params ?? []) out.set(param.name, { scope: part.name, param });
  return out;
}

function paramValue(p: ParamJson): string {
  const v = typeof p.value === "number" ? fmt(p.value) : typeof p.value === "string" ? p.value : JSON.stringify(p.value ?? null);
  return `${v}${p.unit && typeof p.value === "number" ? ` ${p.unit}` : ""}`;
}

/** Whether a feature's JSON mentions `name` in an expression (a string field). */
function mentions(v: unknown, name: string): boolean {
  if (typeof v === "string") return new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[^A-Za-z0-9_]/g, "")}($|[^A-Za-z0-9_])`).test(v);
  if (Array.isArray(v)) return v.some((x) => mentions(x, name));
  if (typeof v === "object" && v !== null) return Object.values(v).some((x) => mentions(x, name));
  return false;
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    typeof x === "object" && x !== null && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : x,
  );
}

/** Features compare without their ids (a re-added feature gets a new id but is the same statement). */
function sameFeature(a: Feature, b: Feature): boolean {
  const { id: _a, ...ra } = a;
  const { id: _b, ...rb } = b;
  return stable(ra) === stable(rb);
}

const keyOf = (part: string, feature: string): string => `${part}/${feature}`;

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function curveSummary(a: readonly SketchCurve[], b: readonly SketchCurve[]): string {
  const ma = new Map(a.map((c) => [c.id, stable(c)]));
  const mb = new Map(b.map((c) => [c.id, stable(c)]));
  const added = [...mb.keys()].filter((k) => !ma.has(k));
  const removed = [...ma.keys()].filter((k) => !mb.has(k));
  const changed = [...mb.keys()].filter((k) => ma.has(k) && ma.get(k) !== mb.get(k));
  const parts: string[] = [];
  const list = (xs: string[]): string => (xs.length <= 3 ? xs.join(", ") : `${xs.slice(0, 3).join(", ")} +${xs.length - 3}`);
  if (added.length) parts.push(`+${list(added)}`);
  if (removed.length) parts.push(`−${list(removed)}`);
  if (changed.length) parts.push(`~${list(changed)}`);
  return parts.length ? `curves ${parts.join(" ")}` : "";
}

function modifiedSummary(a: Feature, b: Feature): string {
  const out: string[] = [];
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  if (a.type !== b.type) return `${a.type} → ${b.type}`;
  if (a.type === "sketch" && b.type === "sketch") {
    if (stable(a.plane) !== stable(b.plane)) out.push("plane changed");
    const c = curveSummary(a.curves, b.curves);
    if (c) out.push(c);
  }
  for (const k of ["distance", "angle"]) {
    if (ra[k] !== rb[k] && typeof rb[k] === "number") out.push(`${k} ${typeof ra[k] === "number" ? fmt(ra[k]) : "—"} → ${fmt(rb[k])}${k === "distance" ? " mm" : "°"}`);
  }
  for (const k of ["sketch", "direction", "op", "regions"]) {
    if (stable(ra[k]) !== stable(rb[k])) out.push(`${k} ${String(ra[k] ?? "default")} → ${String(rb[k] ?? "default")}`);
  }
  if (stable(ra["axis"]) !== stable(rb["axis"])) out.push("axis changed");
  if ((ra["suppressed"] ?? false) !== (rb["suppressed"] ?? false)) out.push(rb["suppressed"] ? "suppressed" : "unsuppressed");
  return out.join(", ") || "changed";
}

function addedSummary(f: Feature): string {
  switch (f.type) {
    case "sketch":
      return `new sketch on ${typeof f.plane === "string" ? f.plane : "a frame"}, ${f.curves.length} curve${f.curves.length === 1 ? "" : "s"}`;
    case "extrude":
      return `new extrude of \`${f.sketch}\`, ${typeof f.distance === "number" ? `${fmt(f.distance)} mm` : String(f.distance)}${f.direction && f.direction !== "normal" ? ` ${f.direction}` : ""}`;
    case "revolve":
      return `new revolve of \`${f.sketch}\`, ${fmt(f.angle)}°`;
  }
  // IR v1 feature types the v0 types do not name (holes, fillets, patterns, …).
  return `new ${String((f as { type?: unknown }).type ?? "feature")}`;
}

function sketchOf(f: Feature): string | null {
  return f.type === "extrude" || f.type === "revolve" ? f.sketch : null;
}

/** Per-feature changes from `base` to `proposed`, in proposed document order (removals after their part). */
export function diffProposal(base: IrDocument, proposed: IrDocument): FeatureChange[] {
  const out: FeatureChange[] = [];
  if (stable(base.meta ?? {}) !== stable(proposed.meta ?? {})) {
    const nameA = base.meta?.name ?? "";
    const nameB = proposed.meta?.name ?? "";
    out.push({
      key: META_KEY,
      part: "",
      feature: "",
      type: "document",
      kind: "modified",
      requires: [],
      summary: nameA !== nameB ? `name "${nameA}" → "${nameB}"` : "description changed",
    });
  }
  const byKey = new Map<string, FeatureChange>();
  // Parameters (IR v1): added, removed or with another value.
  const bp = paramsOf(base);
  const pp = paramsOf(proposed);
  for (const [name, { scope, param }] of pp) {
    const old = bp.get(name);
    let c: FeatureChange | null = null;
    const common = { key: `${PARAM_PREFIX}${name}`, part: scope, feature: name, type: "parameter", requires: [] as string[] };
    if (!old) c = { ...common, kind: "added", summary: `new parameter = ${paramValue(param)}` };
    else if (stable(old.param) !== stable(param)) c = { ...common, kind: "modified", summary: paramValue(old.param) !== paramValue(param) ? `${paramValue(old.param)} → ${paramValue(param)}` : "changed" };
    if (c) {
      out.push(c);
      byKey.set(c.key, c);
    }
  }
  for (const [name, { scope }] of bp) {
    if (pp.has(name)) continue;
    const c: FeatureChange = { key: `${PARAM_PREFIX}${name}`, part: scope, feature: name, type: "parameter", kind: "removed", requires: [], summary: "remove parameter" };
    out.push(c);
    byKey.set(c.key, c);
  }
  const baseParts = new Map(base.parts.map((p) => [p.name, p]));
  const seenParts = new Set<string>();
  for (const pp of proposed.parts) {
    seenParts.add(pp.name);
    const bp = baseParts.get(pp.name);
    const bf = new Map((bp?.features ?? []).map((f) => [f.name, f]));
    const names = new Set(pp.features.map((f) => f.name));
    for (const f of pp.features) {
      const old = bf.get(f.name);
      let c: FeatureChange | null = null;
      if (!old) c = { key: keyOf(pp.name, f.name), part: pp.name, feature: f.name, type: f.type, kind: "added", requires: [], summary: addedSummary(f) };
      else if (!sameFeature(old, f)) c = { key: keyOf(pp.name, f.name), part: pp.name, feature: f.name, type: f.type, kind: "modified", requires: [], summary: modifiedSummary(old, f) };
      if (c) {
        out.push(c);
        byKey.set(c.key, c);
      }
    }
    for (const f of bp?.features ?? []) {
      if (names.has(f.name)) continue;
      const c: FeatureChange = { key: keyOf(pp.name, f.name), part: pp.name, feature: f.name, type: f.type, kind: "removed", requires: [], summary: `remove ${f.type}` };
      out.push(c);
      byKey.set(c.key, c);
    }
  }
  for (const bp of base.parts) {
    if (seenParts.has(bp.name)) continue;
    for (const f of bp.features) {
      const c: FeatureChange = { key: keyOf(bp.name, f.name), part: bp.name, feature: f.name, type: f.type, kind: "removed", requires: [], summary: `remove ${f.type} (part \`${bp.name}\` removed)` };
      out.push(c);
      byKey.set(c.key, c);
    }
  }
  // Dependencies: an added/modified extrude or revolve builds on its sketch's change, if any; a
  // feature whose expressions use an added or changed parameter builds on that change.
  const paramChanges = [...byKey.values()].filter((c) => c.type === "parameter" && c.kind !== "removed");
  for (const part of proposed.parts) {
    for (const f of part.features) {
      const c = byKey.get(keyOf(part.name, f.name));
      if (!c || c.kind === "removed") continue;
      for (const pc of paramChanges) if (mentions(f, pc.feature)) c.requires.push(pc.key);
      const s = sketchOf(f);
      if (!s) continue;
      const dep = byKey.get(keyOf(part.name, s));
      if (dep && dep.kind !== "removed") c.requires.push(dep.key);
    }
  }
  // Removing a feature requires removing what uses it (reported the other way round by checkVariant).
  for (const bp of base.parts) {
    for (const f of bp.features) {
      const c = byKey.get(keyOf(bp.name, f.name));
      const s = sketchOf(f);
      if (!c || c.kind !== "removed" || !s) continue;
      const dep = byKey.get(keyOf(bp.name, s));
      if (dep && dep.kind === "removed") dep.requires.push(c.key);
    }
  }
  return out;
}

function findPart(ir: IrDocument, name: string): PartStudio | undefined {
  return ir.parts.find((p) => p.name === name);
}

export interface VariantResult {
  ir: IrDocument;
  /** Accepted changes that collide with edits made to the target since the run started. */
  conflicts: string[];
}

/**
 * Apply the `accepted` changes of `base → proposed` onto `target` (normally `base` itself; the
 * current document when the user edited it during the run). A change conflicts when `target`'s
 * version of that feature is no longer `base`'s.
 */
export function buildVariant(base: IrDocument, proposed: IrDocument, target: IrDocument, accepted: ReadonlySet<string>, changes: readonly FeatureChange[] = diffProposal(base, proposed)): VariantResult {
  const ir = structuredClone(target);
  const conflicts: string[] = [];
  const byKey = new Map(changes.map((c) => [c.key, c]));
  if (accepted.has(META_KEY) && byKey.has(META_KEY)) {
    if (stable(target.meta ?? {}) !== stable(base.meta ?? {})) conflicts.push("the document name/description was edited since the run started");
    else if (proposed.meta) ir.meta = structuredClone(proposed.meta);
    else delete ir.meta;
  }
  for (const c of changes) {
    if (c.key === META_KEY || !accepted.has(c.key)) continue;
    if (c.type === "parameter") {
      applyParamChange(ir, base, proposed, c, conflicts);
      continue;
    }
    const baseF = findPart(base, c.part)?.features.find((f) => f.name === c.feature);
    let part = findPart(ir, c.part);
    const current = part?.features.find((f) => f.name === c.feature);
    if (c.kind === "modified" || c.kind === "removed") {
      if (!current || !baseF || !sameFeature(current, baseF)) {
        conflicts.push(`\`${c.feature}\` was edited since the run started`);
        continue;
      }
      if (c.kind === "removed") {
        part!.features = part!.features.filter((f) => f.name !== c.feature);
      } else {
        const next = findPart(proposed, c.part)!.features.find((f) => f.name === c.feature)!;
        part!.features = part!.features.map((f) => (f.name === c.feature ? { ...structuredClone(next), id: f.id } : f));
      }
      continue;
    }
    // added
    if (current) {
      conflicts.push(`a feature named \`${c.feature}\` was added since the run started`);
      continue;
    }
    const pp = findPart(proposed, c.part)!;
    if (!part) {
      // A new part: insert it after the part that precedes it in the proposal.
      const idx = proposed.parts.indexOf(pp);
      const prev = proposed.parts.slice(0, idx).reverse().find((p) => findPart(ir, p.name));
      part = { id: pp.id, name: pp.name, features: [] };
      const at = prev ? ir.parts.findIndex((p) => p.name === prev.name) + 1 : 0;
      ir.parts.splice(at, 0, part);
    }
    const fi = pp.features.findIndex((f) => f.name === c.feature);
    const prevName = pp.features
      .slice(0, fi)
      .reverse()
      .find((f) => part!.features.some((x) => x.name === f.name))?.name;
    const at = prevName === undefined ? 0 : part.features.findIndex((f) => f.name === prevName) + 1;
    part.features.splice(at, 0, structuredClone(pp.features[fi]!));
  }
  // Parts the proposal removed and that ended up empty go too.
  ir.parts = ir.parts.filter((p) => p.features.length > 0 || findPart(proposed, p.name) !== undefined || findPart(target, p.name)?.features.length === 0);
  return { ir, conflicts };
}

/** Apply one accepted parameter change onto `ir` (conflicts: the parameter changed since the run started). */
function applyParamChange(ir: IrDocument, base: IrDocument, proposed: IrDocument, c: FeatureChange, conflicts: string[]): void {
  const d = ir as unknown as WithParams;
  const listOf = (scope: string, create: boolean): ParamJson[] | null => {
    if (scope === "") return d.params ?? (create ? (d.params = []) : null);
    const part = d.parts.find((p) => p.name === scope);
    if (!part) return null;
    return part.params ?? (create ? (part.params = []) : null);
  };
  const current = paramsOf(ir).get(c.feature);
  const baseP = paramsOf(base).get(c.feature);
  if (c.kind === "added") {
    if (current) {
      conflicts.push(`a parameter named \`${c.feature}\` was added since the run started`);
      return;
    }
    const list = listOf(c.part, true);
    const next = paramsOf(proposed).get(c.feature);
    if (!list || !next) {
      conflicts.push(`parameter \`${c.feature}\` has no place in the model (its part is missing)`);
      return;
    }
    list.push(structuredClone(next.param));
    return;
  }
  if (!current || !baseP || stable(current.param) !== stable(baseP.param)) {
    conflicts.push(`parameter \`${c.feature}\` was edited since the run started`);
    return;
  }
  const list = listOf(current.scope, false)!;
  const i = list.findIndex((p) => p.name === c.feature);
  if (c.kind === "removed") list.splice(i, 1);
  else list[i] = structuredClone(paramsOf(proposed).get(c.feature)!.param);
}

/**
 * What accepting `accepted` of `changes` approves (ADR 0015 §3): the ids and names of the base's
 * features the accepted changes modify or remove, and the names of the parameters they modify or
 * remove. Additions need no approval; anything the change list did not show (a reorder of your
 * features) is not approved, so the commit check refuses it.
 */
export function approvalsFor(base: IrDocument, changes: readonly FeatureChange[], accepted: ReadonlySet<string>): { features: string[]; params: string[] } {
  const features: string[] = [];
  const params: string[] = [];
  for (const c of changes) {
    if (!accepted.has(c.key) || c.key === META_KEY || c.kind === "added") continue;
    if (c.type === "parameter") {
      params.push(c.feature);
      continue;
    }
    const f = findPart(base, c.part)?.features.find((x) => x.name === c.feature);
    if (f) features.push(f.id, f.name);
  }
  return { features: [...new Set(features)], params: [...new Set(params)] };
}

/**
 * Dependency-aware warnings for an accepted subset: features that would reference a sketch that is
 * missing or later than them (errors), and changes accepted without the change they build on
 * (warnings).
 */
export function checkVariant(variant: IrDocument, changes: readonly FeatureChange[], accepted: ReadonlySet<string>): DependencyWarning[] {
  const out: DependencyWarning[] = [];
  const byKey = new Map(changes.map((c) => [c.key, c]));
  for (const part of variant.parts) {
    const sketches = new Set<string>();
    for (const f of part.features) {
      if (f.type === "sketch") {
        sketches.add(f.name);
        continue;
      }
      // IR v1 features that build on no sketch (a fillet, a hole on a face, …): nothing to check here.
      if (typeof (f as { sketch?: unknown }).sketch !== "string") continue;
      if (sketches.has(f.sketch)) continue;
      const depKey = keyOf(part.name, f.sketch);
      const dep = byKey.get(depKey);
      const own = keyOf(part.name, f.name);
      if (dep?.kind === "added" && !accepted.has(depKey)) {
        out.push({ severity: "error", key: depKey, message: `\`${f.name}\` uses sketch \`${f.sketch}\`, which you rejected. Accept \`${f.sketch}\` too, or reject \`${f.name}\`.` });
      } else if (dep?.kind === "removed" && accepted.has(depKey)) {
        out.push({ severity: "error", key: depKey, message: `Removing \`${f.sketch}\` breaks \`${f.name}\`, which still uses it. Keep \`${f.sketch}\`, or remove \`${f.name}\` too.` });
      } else {
        out.push({ severity: "error", key: byKey.has(own) ? own : depKey, message: `\`${f.name}\` uses sketch \`${f.sketch}\`, which does not exist before it in part \`${part.name}\`.` });
      }
    }
  }
  for (const c of changes) {
    if (!accepted.has(c.key) || c.kind === "removed") continue;
    for (const r of c.requires) {
      const dep = byKey.get(r);
      if (dep?.type === "parameter" && dep.kind === "added" && !accepted.has(r)) {
        out.push({ severity: "error", key: r, message: `\`${c.feature}\` uses parameter \`${dep.feature}\`, which you rejected. Accept \`${dep.feature}\` too, or reject \`${c.feature}\`.` });
      }
    }
  }
  const reported = new Set(out.map((w) => w.key));
  for (const c of changes) {
    if (!accepted.has(c.key) || c.kind === "removed") continue;
    for (const r of c.requires) {
      const dep = byKey.get(r);
      if (!dep || accepted.has(r) || reported.has(r) || dep.kind !== "modified") continue;
      out.push({ severity: "warning", key: r, message: `\`${c.feature}\` was changed together with \`${dep.feature}\`; accepting it without \`${dep.feature}\` may not give the result the agent verified.` });
    }
  }
  return out;
}
