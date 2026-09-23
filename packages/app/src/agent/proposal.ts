/**
 * The agent's proposal as a reviewable change set (ARCHITECTURE §7 "Draft branch and diff"):
 *
 * - {@link diffProposal}: base IR → proposed IR, per feature (by part + feature name): added,
 *   removed or modified, with a one-line summary and the other changes it builds on.
 * - {@link buildVariant}: the IR you get by accepting only some changes, applied onto a target IR
 *   (the base, or the document as the user has edited it since: then conflicts are reported).
 * - {@link checkVariant}: dependency-aware warnings — rejecting a sketch an accepted extrude uses,
 *   or accepting the removal of a sketch that a kept feature still needs, breaks the model.
 *
 * Pure functions over `@aicad/ir-types`; the CadScript splice (`applyIrEdit`) and evaluation happen
 * in the agent service.
 */
import type { Feature, IrDocument, PartStudio, SketchCurve } from "@aicad/ir-types";

export type ChangeKind = "added" | "removed" | "modified";

export interface FeatureChange {
  /** `<part>/<feature>`, or `doc:meta` for the document name/description. */
  key: string;
  part: string;
  /** Feature name (the CadScript const); empty for `doc:meta`. */
  feature: string;
  /** Feature type (`sketch`, `extrude`, `revolve`) or `document`. */
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
      return `new extrude of \`${f.sketch}\`, ${fmt(f.distance)} mm${f.direction && f.direction !== "normal" ? ` ${f.direction}` : ""}`;
    case "revolve":
      return `new revolve of \`${f.sketch}\`, ${fmt(f.angle)}°`;
  }
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
  const baseParts = new Map(base.parts.map((p) => [p.name, p]));
  const seenParts = new Set<string>();
  const byKey = new Map<string, FeatureChange>();
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
  // Dependencies: an added/modified extrude or revolve builds on its sketch's change, if any.
  for (const pp of proposed.parts) {
    for (const f of pp.features) {
      const c = byKey.get(keyOf(pp.name, f.name));
      const s = sketchOf(f);
      if (!c || !s || c.kind === "removed") continue;
      const dep = byKey.get(keyOf(pp.name, s));
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
