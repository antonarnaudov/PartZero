/**
 * The differential of two `aicad.metrics/1` reports of the same document (Forge against the
 * recorded oracle fixtures in `real-engine.test.ts`). It is the normative `kernel-diff` v1
 * comparison of SPEC-v1 §8.2 **plus** the fields the MakerBench v1 checks read that §8.2 leaves
 * out, so a task can neither pass on one engine and fail on the other unnoticed nor hide a
 * §8.2 difference. It lists differences; it does not classify them (§8.4 classes and the
 * downstream capping are the oracle's `oracle diff`, which the integration runs on the MakerBench
 * v1 documents as well).
 *
 * **§8.2, exact:** document, parameter and feature status; parameter and feature error codes;
 * the feature list (part, name, id, type, in order); the oracle-computable warning codes
 * (`BOOLEAN_SPLIT`, `BOOLEAN_BODY_CONSUMED`, `HOLE_BREAKS_THROUGH`, `PATTERN_INSTANCE_SKIPPED`,
 * `SHELL_CLOSED_VOID`, through the multiset below); `count` and `bool` parameter values; region
 * count, `loops`, `outer_curves`; the bodies of each feature and each part matched by `origin`
 * (exact) and, among bodies sharing an origin, by nearest centroid, greedily in canonical order
 * (centroids within `1e-6·s` of the nearest are a tie, broken by the nearest volume: a deviation
 * for concentric pieces, reported to the Contract stage); an unmatched body is a difference;
 * `removed`; `faces`, `edges`, `face_types`, `edge_types`, `shells`; hole instance count and
 * `at` ids; pattern `instances` and `skipped`; fillet and chamfer `edges` (the keys, as sets).
 *
 * **§8.2, tolerances** (v0 §6: `s = max(1, diagA, diagB)` per body pair, per part for hole and
 * datum quantities): real parameters `|a − b| ≤ PARAM_VALUE_REL · max(1, |a|, |b|)`; volume
 * `rel ≤ 1e-6` or `abs ≤ 1e-9·s³`; area and region area `rel ≤ 1e-6` or `abs ≤ 1e-9·s²` (regions:
 * `s = 1`); centroid and box, datum origins and hole centres per component `abs ≤ 1e-6·s`;
 * datum directions and hole axes per component `abs ≤ 1e-9`; hole `d` and `depth`
 * `abs ≤ 1e-9·s`. `chain_added` is not compared (§8.2: independent-refs mode only).
 *
 * **Check-level extras** (not in §8.2, read by the checks): a rejected document's error code
 * (§8.2 names only parameter and feature codes; repair hints read it); the multiset of every
 * warning code, engine-internal (`OCCT_`, `FORGE_`, `ORACLE_`) warnings of severity `warning`
 * included (`warning_count` may name one), an engine's **info** about itself (the oracle's
 * `ORACLE_REPLAYED` provenance note) left out as the oracle's own differential does (and
 * `warning_count` always names its code, so it never counts one); reference
 * statuses, codes and member counts (`ref_stability`); hole `kind`, `size`, counterbore,
 * countersink, insert and thread dimensions (`hole_count` filters; lengths `abs ≤ 1e-9·s`, the
 * countersink angle `abs ≤ 1e-9`); the number of blend faces created; the shell's opened-face
 * count and `closed_void` (`shell_open_faces`); body `valid` (the `valid` check).
 *
 * A difference that is an **open contract question** (the SPEC does not decide it) is still a
 * §8.4 `CODE_MISMATCH` between the engines; it is returned separately with the question, never
 * dropped, until the Contract stage rules: see {@link OPEN_CONTRACT_QUESTIONS}.
 */
import type { metricsV1, v1 as irv1 } from "@aicad/ir-types";
import { v1 as irConst } from "@aicad/ir-types";

type Report = metricsV1.EvalReport;
type Body = metricsV1.BodyReport;

export interface DiffOptions {
  /** The document both reports evaluated: needed to recognise open contract questions. */
  doc?: irv1.IrDocument | null;
}

/** An open contract question: which warning, on which features, and where it is recorded. */
export interface OpenContractQuestion {
  code: string;
  /** True for the IR features the question is about. */
  applies(feature: Record<string, unknown>): boolean;
  question: string;
}

/**
 * The open contract questions a MakerBench v1 differential may meet. Under §8.2 each is a
 * `CODE_MISMATCH` between the engines (the warning codes are compared exactly); it is set apart
 * because the SPEC does not say which engine is right, and it stays tracked here until the
 * Contract stage rules (remove the entry then, and fix the engine the ruling makes wrong):
 * - `HOLE_BREAKS_THROUGH` on an `up_to` hole: SPEC §6.5 reads up_to as "then as blind with a flat
 *   floor" but does not say whether a floor on the chosen (far) face breaks through. The oracle
 *   warns, Forge does not (forge-ops `hole/mod.rs` "Break-through"; W5's `OPEN_CONTRACT` class).
 */
export const OPEN_CONTRACT_QUESTIONS: readonly OpenContractQuestion[] = [
  {
    code: "HOLE_BREAKS_THROUGH",
    applies: (f) => f["type"] === "hole" && typeof f["depth"] === "object" && f["depth"] !== null && "up_to" in (f["depth"] as object),
    question: "CODE_MISMATCH pending a contract ruling: HOLE_BREAKS_THROUGH on an up_to hole (SPEC §6.5 silent; oracle warns, Forge does not)",
  },
];

/** The differences between two reports, and those that are open contract questions. */
export interface ClassifiedDifferences {
  /** Engine disagreements: each one is a bug on one side (or a missing contract question). */
  differences: string[];
  /** `CODE_MISMATCH`es the SPEC does not decide yet, `<where>: <question>`. */
  openContract: string[];
}

/** v0 §6. */
const REL_TOL = 1e-6;
const ABS_FLOOR = 1e-9;
const POS_TOL = 1e-6;

/** Differences between `a` and `b`, one line each (empty: they agree). Open contract questions count as differences here. */
export function reportDifferencesV1(a: Report, b: Report, options: DiffOptions = {}): string[] {
  const c = classifyDifferencesV1(a, b, options);
  return [...c.differences, ...c.openContract];
}

/** {@link reportDifferencesV1}, with open contract questions (needs `options.doc`) set apart. */
export function classifyDifferencesV1(a: Report, b: Report, options: DiffOptions = {}): ClassifiedDifferences {
  const out: string[] = [];
  const open: string[] = [];
  const irFeature = (part: string, id: string): Record<string, unknown> | undefined =>
    (options.doc?.parts.find((p) => p.name === part)?.features as unknown as Record<string, unknown>[] | undefined)?.find((f) => f["id"] === id);
  const same = (what: string, x: unknown, y: unknown) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${what}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
  };
  /** `|x − y| ≤ tol`, both numbers, or both absent. */
  const absNum = (what: string, x: number | null | undefined, y: number | null | undefined, tol: number) => {
    if (x === y) return;
    if (typeof x === "number" && typeof y === "number" && Math.abs(x - y) <= tol) return;
    out.push(`${what}: ${x} vs ${y} (allowed ±${tol.toPrecision(3)})`);
  };
  const absVec = (what: string, x: readonly number[] | undefined, y: readonly number[] | undefined, tol: number) => {
    if (x && y && x.length === y.length && x.every((v, i) => Math.abs(v - y[i]!) <= tol)) return;
    out.push(`${what}: ${JSON.stringify(x)} vs ${JSON.stringify(y)} (allowed ±${tol.toPrecision(3)} per component)`);
  };
  const relNum = (what: string, x: number, y: number, floor: number) => {
    const allowed = Math.max(REL_TOL * Math.max(Math.abs(x), Math.abs(y)), floor);
    if (!(Math.abs(x - y) <= allowed)) out.push(`${what}: ${x} vs ${y} (allowed ±${allowed.toPrecision(3)})`);
  };
  const partScale = (part: string) => Math.max(1, ...[a, b].flatMap((r) => (r.parts ?? []).filter((p) => p.part === part).flatMap((p) => p.bodies.map(diag))));

  const body = (at: string, x: Body, y: Body) => {
    const s = Math.max(1, diag(x), diag(y));
    relNum(`${at}: volume`, x.volume, y.volume, ABS_FLOOR * s ** 3);
    relNum(`${at}: area`, x.area, y.area, ABS_FLOOR * s ** 2);
    for (const k of ["centroid", "bbox_min", "bbox_max"] as const) absVec(`${at}: ${k}`, x[k], y[k], POS_TOL * s);
    same(`${at}: faces/edges/shells`, [x.faces, x.edges, x.shells], [y.faces, y.edges, y.shells]);
    same(`${at}: face types`, histogram(x.face_types), histogram(y.face_types));
    same(`${at}: edge types`, histogram(x.edge_types), histogram(y.edge_types));
    same(`${at}: valid`, x.valid, y.valid);
  };
  /**
   * §8.2 body matching: by origin (exact), same-origin bodies by nearest centroid, greedily in
   * canonical order. Centroids within `1e-6·s` of the nearest are a tie, broken by the nearest
   * volume: concentric pieces of one origin (a rim and a hub cut apart) have the same centroid
   * up to rounding, so the nearest centroid is noise there and §5.4's canonical order does not
   * separate them either (reported to the Contract stage).
   */
  const bodies = (at: string, xs: readonly Body[], ys: readonly Body[]) => {
    const pool = ys.map((y, j) => ({ y, j }));
    xs.forEach((x, i) => {
      const sameOrigin = pool.filter((p) => originKey(p.y.origin) === originKey(x.origin));
      if (sameOrigin.length === 0) {
        out.push(`${at} body ${i}: origin ${originKey(x.origin)} has no match in the second report`);
        return;
      }
      const nearest = Math.min(...sameOrigin.map((p) => centroidDistance(x, p.y)));
      const ties = sameOrigin.filter((p) => centroidDistance(x, p.y) <= nearest + POS_TOL * Math.max(1, diag(x), diag(p.y)));
      const best = ties.reduce((m, p) => (Math.abs(p.y.volume - x.volume) < Math.abs(m.y.volume - x.volume) ? p : m));
      pool.splice(pool.indexOf(best), 1);
      body(`${at} body ${originKey(x.origin)}`, x, best.y);
    });
    for (const p of pool) out.push(`${at}: body with origin ${originKey(p.y.origin)} has no match in the first report`);
  };

  same("status", a.status, b.status);
  same("document error", a.error?.code ?? null, b.error?.code ?? null);
  params(a, b, out, same);
  if (a.features.length !== b.features.length) out.push(`features: ${a.features.length} vs ${b.features.length}`);
  a.features.forEach((f, i) => {
    const g = b.features[i];
    const at = `feature ${i} ${f.feature}`;
    if (!g) return;
    same(`${at}: part/name/id/type`, [f.part, f.feature, f.feature_id, f.type], [g.part, g.feature, g.feature_id, g.type]);
    same(`${at}: status/error`, [f.status, f.error?.code ?? null], [g.status, g.error?.code ?? null]);
    const codes = (ws: readonly metricsV1.Warning[] | undefined) =>
      (ws ?? [])
        .filter((w) => !(w.severity === "info" && isEngineInternal(w.code)))
        .map((w) => w.code)
        .sort();
    const [wa, wb] = [codes(f.warnings), codes(g.warnings)];
    const ir = irFeature(f.part, f.feature_id);
    for (const q of OPEN_CONTRACT_QUESTIONS) {
      if (!ir || !q.applies(ir)) continue;
      const [na, nb] = [wa.filter((c) => c === q.code).length, wb.filter((c) => c === q.code).length];
      if (na === nb) continue;
      open.push(`${at}: ${q.question}`);
      for (const w of [wa, wb]) for (let k = w.length - 1; k >= 0; k--) if (w[k] === q.code) w.splice(k, 1);
    }
    same(`${at}: warnings`, wa, wb);
    const [ra, rb] = [f.regions ?? [], g.regions ?? []];
    same(
      `${at}: regions (loops, outer curves)`,
      ra.map((r) => [r.loops, r.outer_curves]),
      rb.map((r) => [r.loops, r.outer_curves]),
    );
    ra.forEach((r, k) => {
      if (rb[k]) relNum(`${at} region ${k}: area`, r.area, rb[k]!.area, ABS_FLOOR);
    });
    bodies(at, f.bodies ?? [], g.bodies ?? []);
    same(`${at}: removed`, (f.removed ?? []).map(originKey).sort(), (g.removed ?? []).map(originKey).sort());
    datum(`${at}: datum`, f.datum, g.datum, partScale(f.part), out, absVec, same);
    same(
      `${at}: references`,
      (f.refs ?? []).map((r) => [r.field, r.status, r.code ?? null, r.members.length]),
      (g.refs ?? []).map((r) => [r.field, r.status, r.code ?? null, r.members.length]),
    );
    const [ha, hb] = [f.holes ?? [], g.holes ?? []];
    same(
      `${at}: hole instances`,
      ha.map((h) => h.at),
      hb.map((h) => h.at),
    );
    const s = partScale(f.part);
    ha.forEach((h, k) => {
      const j = hb[k];
      if (!j || j.at !== h.at) return;
      const hat = `${at} hole ${h.at}`;
      absVec(`${hat}: centre`, h.center, j.center, POS_TOL * s);
      absVec(`${hat}: axis`, h.axis, j.axis, 1e-9);
      absNum(`${hat}: d`, h.d, j.d, ABS_FLOOR * s);
      absNum(`${hat}: depth`, h.depth, j.depth, ABS_FLOOR * s);
      same(`${hat}: kind/size`, [h.kind, h.size ?? null], [j.kind, j.size ?? null]);
      for (const key of ["cbore", "insert"] as const) {
        same(`${hat}: ${key}`, h[key] === undefined, j[key] === undefined);
        absNum(`${hat}: ${key} d`, h[key]?.d, j[key]?.d, ABS_FLOOR * s);
        absNum(`${hat}: ${key} depth`, h[key]?.depth, j[key]?.depth, ABS_FLOOR * s);
      }
      same(`${hat}: csink`, h.csink === undefined, j.csink === undefined);
      absNum(`${hat}: csink d`, h.csink?.d, j.csink?.d, ABS_FLOOR * s);
      absNum(`${hat}: csink angle`, h.csink?.angle, j.csink?.angle, 1e-9);
      same(`${hat}: thread`, h.thread === undefined, j.thread === undefined);
      absNum(`${hat}: thread pitch`, h.thread?.pitch, j.thread?.pitch, ABS_FLOOR * s);
      absNum(`${hat}: thread depth`, h.thread?.depth, j.thread?.depth, ABS_FLOOR * s);
    });
    same(`${at}: pattern`, f.pattern ? [f.pattern.instances, f.pattern.skipped ?? []] : null, g.pattern ? [g.pattern.instances, g.pattern.skipped ?? []] : null);
    for (const key of ["fillet", "chamfer"] as const) {
      const [x, y] = [f[key], g[key]];
      same(`${at}: ${key} edges`, x ? [...x.edges].sort() : null, y ? [...y.edges].sort() : null);
      same(`${at}: ${key} faces created`, x?.faces_created.length ?? null, y?.faces_created.length ?? null);
    }
    same(`${at}: shell`, f.shell ? [f.shell.removed_faces.length, f.shell.closed_void ?? false] : null, g.shell ? [g.shell.removed_faces.length, g.shell.closed_void ?? false] : null);
  });
  const partsB = new Map((b.parts ?? []).map((p) => [p.part, p] as const));
  same(
    "parts",
    (a.parts ?? []).map((p) => p.part).sort(),
    (b.parts ?? []).map((p) => p.part).sort(),
  );
  for (const p of a.parts ?? []) {
    const q = partsB.get(p.part);
    if (q) bodies(`part ${p.part}`, p.bodies, q.bodies);
  }
  return { differences: out, openContract: open };
}

/** §8.2 parameters: matched by scope and name; status, code and unit exact; values by type. */
function params(a: Report, b: Report, out: string[], same: (what: string, x: unknown, y: unknown) => void): void {
  const key = (p: metricsV1.ParamReport) => `${p.scope}/${p.name}`;
  const [pa, pb] = [new Map((a.params ?? []).map((p) => [key(p), p] as const)), new Map((b.params ?? []).map((p) => [key(p), p] as const))];
  same("parameters", [...pa.keys()].sort(), [...pb.keys()].sort());
  for (const [k, p] of pa) {
    const q = pb.get(k);
    if (!q) continue;
    same(`parameter ${k}: unit/error`, [p.unit, p.error?.code ?? null], [q.unit, q.error?.code ?? null]);
    if (p.error || q.error) continue;
    if (p.unit === "count" || p.unit === "bool" || typeof p.value !== "number" || typeof q.value !== "number") same(`parameter ${k}`, p.value, q.value);
    else if (!(Math.abs(p.value - q.value) <= irConst.PARAM_VALUE_REL * Math.max(1, Math.abs(p.value), Math.abs(q.value)))) out.push(`parameter ${k}: ${p.value} vs ${q.value}`);
  }
}

/** §8.2 datums: origins `abs ≤ 1e-6·s`, directions and normals `abs ≤ 1e-9`, the same fields. */
function datum(
  at: string,
  x: metricsV1.DatumReport | undefined,
  y: metricsV1.DatumReport | undefined,
  s: number,
  out: string[],
  absVec: (what: string, x: readonly number[] | undefined, y: readonly number[] | undefined, tol: number) => void,
  same: (what: string, x: unknown, y: unknown) => void,
): void {
  if (x === undefined && y === undefined) return;
  if (x === undefined || y === undefined) {
    out.push(`${at}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
    return;
  }
  const [rx, ry] = [x as unknown as Record<string, number[]>, y as unknown as Record<string, number[]>];
  same(`${at} fields`, Object.keys(rx).sort(), Object.keys(ry).sort());
  for (const k of Object.keys(rx)) absVec(`${at} ${k}`, rx[k], ry[k], k === "origin" ? POS_TOL * s : 1e-9);
}

/** A body's origin as one string: `feature/member`, `@i` or `@i.j` for a pattern instance. */
function originKey(o: metricsV1.Origin): string {
  return `${o.feature}/${o.member}${o.instance ? `@${o.instance.join(".")}` : ""}`;
}

function diag(b: Body): number {
  return Math.hypot(b.bbox_max[0] - b.bbox_min[0], b.bbox_max[1] - b.bbox_min[1], b.bbox_max[2] - b.bbox_min[2]);
}

function centroidDistance(x: Body, y: Body): number {
  return Math.hypot(x.centroid[0] - y.centroid[0], x.centroid[1] - y.centroid[1], x.centroid[2] - y.centroid[2]);
}

/** Engine-internal codes (not in the SPEC catalogue): `OCCT_`, `FORGE_`, `ORACLE_`. */
export function isEngineInternal(code: string): boolean {
  return /^(OCCT|FORGE|ORACLE)_/.test(code);
}

function histogram(m: Readonly<Record<string, number>>): [string, number][] {
  return Object.entries(m)
    .filter(([, n]) => n > 0)
    .sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0));
}
