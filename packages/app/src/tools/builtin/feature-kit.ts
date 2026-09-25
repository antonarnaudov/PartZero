/**
 * What the modify and pattern tools share (FULL-MODELING-PLAN §2.2, §2.5, §2.6):
 *
 * - the IR v1 document and its rollback marker as the app holds them;
 * - picks from the selection (render names, picked points, body origins) and **Refs** for them from
 *   Forge's `refFor` (cached per document revision and selection);
 * - the **checked preview** of a candidate: the document with the new (or edited) feature, cut at
 *   the rollback marker, evaluated by the engine; the bodies the feature creates or modifies are
 *   tinted, errors are mapped to the panel's fields with Forge's feasible range;
 * - handle anchors from the displayed topology (an edge's midpoint and the outward bisector of its
 *   faces, a face's centroid and normal, a body's centre).
 *
 * The tools commit only catalogue ops (`addFeature`, `updateFeature`) — the ops the agent and MCP
 * issue — through the shell's ops port (one transaction, the failure rule, authorship).
 */
import type { metricsV1 } from "@aicad/ir-types";
import {
  CommandEngineError,
  insertionPoint,
  refForPicks,
  rolledBack,
  type IrCommandEngine,
  type RefForRequest,
  type RefForResult,
  type RefPick,
} from "@aicad/model-ops";
import type { RenderBody } from "../../engine/types";
import type { AppServices } from "../../services";
import { facesOfEdgeName } from "../../selection/picking";
import { buildTopology, type BodyInfo, type SceneTopology } from "../../selection/topology";
import { viewportRuntime } from "../../viewport/runtime";
import type { FieldError, PreviewOutcome, SelectionItem, SummaryRow } from "../framework/types";

export type Json = Record<string, unknown>;
type Vec3 = [number, number, number];

export interface DocFeature {
  id: string;
  name: string;
  type: string;
  json: Json;
  part: string;
}

interface DocJson {
  parts: Array<{ id: string; name: string; features: Json[] }>;
}

// ─── The document ────────────────────────────────────────────────────────────────────────────

/** The IR v1 document text and rollback marker the app holds (null on a CadScript document). */
export function v1Document(services: AppServices): { document: string; rollback: string | null } | null {
  const s = services.doc.getState();
  if (s.format !== "ir-v1") return null;
  return { document: s.source, rollback: s.v1?.host.rollback ?? null };
}

export function parseDocument(text: string): DocJson | null {
  try {
    return JSON.parse(text) as DocJson;
  } catch {
    return null;
  }
}

export function docFeatures(services: AppServices): DocFeature[] {
  const v = v1Document(services);
  const d = v ? parseDocument(v.document) : null;
  if (!d) return [];
  return d.parts.flatMap((p) => p.features.map((f) => ({ id: String(f["id"]), name: String(f["name"]), type: String(f["type"]), json: f, part: p.id })));
}

/** The engine's command layer (refFor, reports), or null (no IR v1 store or engine). */
export function commandEngine(services: AppServices): IrCommandEngine | null {
  try {
    return services.ir?.commandEngine() ?? null;
  } catch {
    return null;
  }
}

/** The part a tool works in: the part of the first picked entity, else the first part. */
export function partOf(services: AppServices, items: readonly SelectionItem[]): string {
  for (const it of items) if ((it.kind === "face" || it.kind === "edge" || it.kind === "vertex" || it.kind === "body") && it.part) return it.part;
  const v = v1Document(services);
  return (v && parseDocument(v.document)?.parts[0]?.id) || "p1";
}

/** A free feature id `<type><n>` (what `addFeature` would give), so a preview names its feature. */
export function previewId(document: string, type: string): string {
  const d = parseDocument(document);
  const taken = new Set((d?.parts ?? []).flatMap((p) => p.features.flatMap((f) => [String(f["id"]), String(f["name"])])));
  for (let n = 1; ; n++) if (!taken.has(`${type}${n}`)) return `${type}${n}`;
}

// ─── Picks and Refs ──────────────────────────────────────────────────────────────────────────

interface RenderOrigin {
  part: string;
  origin: { feature: string; member: string; instance?: number[] };
}

/**
 * Render body name → part and origin, as forge-wasm names bodies (`<part name>/<origin feature
 * name>`, `#k` among equal names, in the report's canonical order).
 */
export function renderOrigins(irText: string | null, report: unknown): Map<string, RenderOrigin> {
  const out = new Map<string, RenderOrigin>();
  // The DocStore's evaluation key of an IR v1 model is the evaluated text, NUL, the appearance.
  const d = irText ? parseDocument(irText.split("\u0000")[0]!) : null;
  const parts = (report as { parts?: Array<{ part: string; part_id?: string; bodies: Array<{ origin: RenderOrigin["origin"] }> }> } | null)?.parts ?? [];
  for (const [pi, p] of parts.entries()) {
    const docPart = d?.parts.find((x) => x.id === p.part_id) ?? d?.parts[pi];
    const nameOf = (id: string): string => String(docPart?.features.find((f) => f["id"] === id)?.["name"] ?? id);
    const names = p.bodies.map((b) => `${p.part}/${nameOf(b.origin.feature)}`);
    p.bodies.forEach((b, i) => {
      const same = names.map((n, j) => (n === names[i] ? j : -1)).filter((j) => j >= 0);
      const name = same.length === 1 ? names[i]! : `${names[i]}#${same.indexOf(i)}`;
      out.set(name, { part: p.part_id ?? docPart?.id ?? p.part, origin: b.origin });
    });
  }
  return out;
}

/** The origin of a displayed body (null when the display is not the current evaluation's). */
export function originOfBody(services: AppServices, body: string): RenderOrigin["origin"] | null {
  const s = services.doc.getState();
  return renderOrigins(s.evaluatedIrJson, s.report).get(body)?.origin ?? null;
}

/** Selection items as `refFor` picks (entities by render name and picked point; bodies by origin). */
export function picksOf(services: AppServices, items: readonly SelectionItem[]): RefPick[] {
  const s = services.doc.getState();
  const origins = renderOrigins(s.evaluatedIrJson, s.report);
  const out: RefPick[] = [];
  for (const it of items) {
    if (it.kind === "face" || it.kind === "edge" || it.kind === "vertex") {
      const o = it.body && !it.refMember ? origins.get(it.body)?.origin : undefined;
      // Members of an existing Ref (a re-edited feature) carry report keys, not render names.
      const byKey = it.refMember === true || it.body === undefined;
      out.push({
        kind: it.kind,
        ...(it.kind === "vertex" ? {} : byKey ? { key: it.key } : { name: it.key }),
        ...(it.point ? { point: [it.point[0], it.point[1], it.point[2]] as Vec3 } : {}),
        ...(o ? { body: o } : {}),
      });
    } else if (it.kind === "body") {
      const o = it.refMember ? originOfBodyKey(it.body) : origins.get(it.body)?.origin;
      if (o) out.push({ kind: "body", body: o });
    }
  }
  return out;
}

/** A body key `F/body:m`, `F/body:m@i` or `F/body:m@i.j` (SPEC-v1 §5.2 rule 7) as an origin. */
export function originOfBodyKey(key: string): RenderOrigin["origin"] | null {
  const m = /^([^/]+)\/body:([^@]+)(?:@(\d+)(?:\.(\d+))?)?$/.exec(key);
  if (!m) return null;
  const instance = m[3] !== undefined ? [Number(m[3]), ...(m[4] !== undefined ? [Number(m[4])] : [])] : undefined;
  return { feature: m[1]!, member: m[2]!, ...(instance ? { instance } : {}) };
}

/** `refFor` results for the selection, cached by document revision (previews call it on every change). */
export class RefCache {
  private readonly cache = new Map<string, Promise<RefForResult>>();

  constructor(private readonly services: AppServices) {}

  get(request: RefForRequest, at: { part?: string; feature?: string }): Promise<RefForResult> {
    const engine = commandEngine(this.services);
    const v = v1Document(this.services);
    if (!engine || !v) return Promise.reject(new CommandEngineError("ENGINE_UNSUPPORTED", "Picking needs the Forge engine and an IR v1 model"));
    const key = JSON.stringify([this.services.doc.getState().revision, v.rollback, request, at]);
    let p = this.cache.get(key);
    if (!p) {
      if (this.cache.size > 64) this.cache.clear();
      p = refForPicks(engine, v.document, request, { ...at, rollback: v.rollback });
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return p;
  }
}

/** A `refFor` refusal as the error of the selection field it came from. */
export function refError(e: unknown, field: string): FieldError {
  const code = e instanceof CommandEngineError ? e.code : "REF_FAILED";
  const message =
    code === "COMMAND_PICK_NOT_FOUND"
      ? "A picked item is not there at this point of the timeline (pick it again)."
      : code === "COMMAND_REF_NO_QUERY" || code === "COMMAND_REF_NOT_EXACT"
        ? "Forge cannot reference the picked items exactly; pick them again or pick fewer."
        : e instanceof Error
          ? e.message
          : String(e);
  return { field, code, message };
}

// ─── Candidates and the checked preview ──────────────────────────────────────────────────────

/** The document with `feature` inserted where a new feature goes, cut after it (what the viewport would show). */
export function withNewFeature(document: string, rollback: string | null, part: string, feature: Json): { text: string; after: string | null } {
  const d = parseDocument(document);
  if (!d) return { text: document, after: null };
  const at = insertionPoint(document, part, rollback);
  const p = d.parts.find((x) => x.id === at.part)!;
  const i = at.after === null ? 0 : p.features.findIndex((f) => f["id"] === at.after) + 1;
  p.features.splice(i, 0, feature);
  return { text: rolledBack(JSON.stringify(d), String(feature["id"])), after: at.after };
}

/** The document with a feature's top-level fields replaced (`null` removes one), cut at the rollback marker. */
export function withEditedFeature(document: string, rollback: string | null, id: string, set: Json): string {
  const d = parseDocument(document);
  if (!d) return document;
  for (const p of d.parts) {
    const f = p.features.find((x) => x["id"] === id);
    if (!f) continue;
    for (const [k, v] of Object.entries(set)) {
      if (v === null) delete f[k];
      else f[k] = v;
    }
  }
  return rolledBack(JSON.stringify(d), rollback);
}

export const PREVIEW_TINT: [number, number, number] = [0.25, 0.56, 0.98];

/** Maps a failing feature's error to a panel field (and the feasible range Forge reported). */
export type ErrorMapper = (error: { code: string; message: string; details: Json }, refField: string | null) => { field?: string; max?: number } | null;

type FeatureEntry = metricsV1.FeatureReport;

/** A short first sentence of a Forge message (the panel line stays readable). */
export function shortMessage(message: string): string {
  const cut = message.indexOf(" (");
  const m = cut > 30 ? message.slice(0, cut) : message;
  return m.length > 220 ? `${m.slice(0, 219)}…` : m;
}

/**
 * Evaluate `text` and check the feature `id`: its failure (mapped to fields), or the preview bodies
 * (the ones it created or modified tinted) and a summary.
 */
export async function checkedPreview(
  services: AppServices,
  text: string,
  id: string,
  signal: AbortSignal,
  map: ErrorMapper,
  summarize?: (entry: FeatureEntry, report: metricsV1.EvalReport) => SummaryRow[],
): Promise<PreviewOutcome> {
  const r = await services.engines.active.evaluate(text);
  if (signal.aborted) return { ok: true };
  const report = r.report as unknown as metricsV1.EvalReport;
  if (report.error) {
    const errs = (report.error.details?.["errors"] as Array<{ code: string; path: string; message: string }> | undefined) ?? [];
    const first = errs[0] ?? { code: report.error.code, path: "", message: report.error.message };
    const m = /^\/parts\/\d+\/features\/\d+\/([^/]+)/.exec(first.path);
    const mapped = map({ code: first.code, message: first.message, details: {} }, m ? `/${m[1]}` : null);
    return { ok: false, errors: [{ ...(mapped?.field ? { field: mapped.field } : m ? { field: m[1]! } : {}), code: first.code, message: shortMessage(first.message) }] };
  }
  const entry = report.features.find((f) => f.feature_id === id);
  if (!entry) return { ok: false, errors: [{ code: "NOT_EVALUATED", message: "The feature was not evaluated (is it suppressed?)." }] };
  if (entry.status === "error" && entry.error) {
    const failedRef = entry.refs?.find((x) => x.status === "failed")?.field ?? null;
    const details = (entry.error.details ?? {}) as Json;
    const mapped = map({ code: entry.error.code, message: entry.error.message, details }, failedRef);
    const error: FieldError = {
      ...(mapped?.field ? { field: mapped.field } : {}),
      code: entry.error.code,
      message: shortMessage(entry.error.message),
      ...(mapped?.max !== undefined ? { feasible: { min: 0, max: mapped.max } } : {}),
    };
    return { ok: false, errors: [error] };
  }
  const touched = new Set((entry.bodies ?? []).map((b) => JSON.stringify([b.origin.feature, b.origin.member, b.origin.instance ?? null])));
  const origins = renderOrigins(text, report);
  const bodies: RenderBody[] = r.bodies.map((b) => {
    const o = origins.get(b.name)?.origin;
    const hit = o && touched.has(JSON.stringify([o.feature, o.member, o.instance ?? null]));
    return hit ? { ...b, color: PREVIEW_TINT } : b;
  });
  const warnings = (entry.warnings ?? []).filter((w) => w.severity === "warning").map((w) => shortMessage(w.message));
  return { ok: true, bodies, ...(summarize ? { summary: summarize(entry, report) } : {}), ...(warnings.length ? { warnings } : {}) };
}

/** The volume change of the part, for summaries. */
export function volumeRow(services: AppServices, report: metricsV1.EvalReport): SummaryRow | null {
  const before = (services.doc.getState().report as unknown as metricsV1.EvalReport | null)?.parts?.flatMap((p) => p.bodies.map((b) => b.volume)) ?? [];
  const after = report.parts?.flatMap((p) => p.bodies.map((b) => b.volume)) ?? [];
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const v = sum(after);
  const d = v - sum(before);
  if (!Number.isFinite(v)) return null;
  const fmt = (x: number): string => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2));
  return { label: "Volume", value: `${fmt(v)} mm³ (${d >= 0 ? "+" : "−"}${fmt(Math.abs(d))})` };
}

/** A number field's value as IR: a literal (base units) or a canonical expression. */
export function scalarOf(v: { text: string; value: number | null; expression: boolean; canonical: string | null }): number | string | null {
  if (v.expression) return v.canonical;
  return v.value ?? (v.canonical !== null && Number.isFinite(Number(v.canonical)) ? Number(v.canonical) : null);
}

/** A Scalar field of a feature as the text a number field starts with. */
export function scalarText(v: unknown, fallback: string): string {
  if (typeof v === "number") return String(v);
  if (typeof v === "string" && v.length > 0) return v;
  return fallback;
}

// ─── Handle anchors (the displayed topology) ─────────────────────────────────────────────────

const topologies = new WeakMap<readonly RenderBody[], SceneTopology>();

/**
 * The document's topology (not the displayed one: while a tool previews, the viewport shows the
 * preview, where a filleted edge or an opened face no longer exists).
 */
function topology(services: AppServices): SceneTopology {
  const bodies = services.doc.getState().bodies;
  let t = topologies.get(bodies);
  if (!t) {
    t = bodies.length ? buildTopology(bodies) : viewportRuntime(services).topo;
    topologies.set(bodies, t);
  }
  return t;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 1];
};

function pointOf(a: Float32Array, i: number): Vec3 {
  return [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];
}

/** The body a picked entity is on, in the displayed scene. */
function bodyInfo(services: AppServices, body: string | undefined): BodyInfo | null {
  return body ? (topology(services).bodies.get(body) ?? null) : null;
}

/** The outward normal of a face near `p` (the render normals of its nearest vertex). */
export function faceNormalNear(b: BodyInfo, face: string, p: Vec3): Vec3 | null {
  const f = b.faces.get(face);
  if (!f) return null;
  let best = -1;
  let bestD = Infinity;
  for (const r of f.ranges) {
    for (let t = r.start; t < r.start + r.count; t++) {
      for (let k = 0; k < 3; k++) {
        const vi = b.body.indices[t * 3 + k]!;
        const d = len(sub(pointOf(b.body.positions, vi), p));
        if (d < bestD) {
          bestD = d;
          best = vi;
        }
      }
    }
  }
  return best >= 0 ? unit(pointOf(b.body.normals, best)) : null;
}

/** An edge's midpoint (by arc length) and the outward bisector of its two faces. */
export function edgeAnchor(services: AppServices, it: SelectionItem): { origin: Vec3; axis: Vec3 } | null {
  if (it.kind !== "edge") return null;
  const b = bodyInfo(services, it.body);
  const e = b?.edges.get(it.key);
  if (!b || !e || e.points.length < 6) return null;
  const n = e.points.length / 3;
  let total = 0;
  for (let i = 1; i < n; i++) total += len(sub(pointOf(e.points, i), pointOf(e.points, i - 1)));
  let acc = 0;
  let mid = pointOf(e.points, 0);
  for (let i = 1; i < n; i++) {
    const a = pointOf(e.points, i - 1);
    const c = pointOf(e.points, i);
    const l = len(sub(c, a));
    if (acc + l >= total / 2) {
      mid = add(a, scale(sub(c, a), l > 0 ? (total / 2 - acc) / l : 0));
      break;
    }
    acc += l;
  }
  const normals = facesOfEdgeName(it.key)
    .map((f) => faceNormalNear(b, f, mid))
    .filter((x): x is Vec3 => x !== null);
  const axis = normals.length ? unit(normals.reduce((s, x) => add(s, x), [0, 0, 0] as Vec3)) : ([0, 0, 1] as Vec3);
  return { origin: mid, axis };
}

/** A face's area-weighted centroid and its outward normal there. */
export function faceAnchor(services: AppServices, it: SelectionItem): { origin: Vec3; axis: Vec3 } | null {
  if (it.kind !== "face") return null;
  const b = bodyInfo(services, it.body);
  const f = b?.faces.get(it.key);
  if (!b || !f) return null;
  let area = 0;
  let c: Vec3 = [0, 0, 0];
  for (const r of f.ranges) {
    for (let t = r.start; t < r.start + r.count; t++) {
      const [p, q, s] = [0, 1, 2].map((k) => pointOf(b.body.positions, b.body.indices[t * 3 + k]!)) as [Vec3, Vec3, Vec3];
      const cr = [
        (q[1] - p[1]) * (s[2] - p[2]) - (q[2] - p[2]) * (s[1] - p[1]),
        (q[2] - p[2]) * (s[0] - p[0]) - (q[0] - p[0]) * (s[2] - p[2]),
        (q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0]),
      ] as Vec3;
      const a = len(cr) / 2;
      area += a;
      c = add(c, scale(add(add(p, q), s), a / 3));
    }
  }
  if (area <= 0) return null;
  const origin = scale(c, 1 / area);
  const axis = (it.point ? faceNormalNear(b, it.key, [it.point[0], it.point[1], it.point[2]]) : null) ?? faceNormalNear(b, it.key, origin) ?? [0, 0, 1];
  return { origin: it.point ? [it.point[0], it.point[1], it.point[2]] : origin, axis };
}

/** The centre of what a set of items designates (bodies, faces of features, entities). */
export function centreOf(services: AppServices, items: readonly SelectionItem[]): Vec3 | null {
  const topo = topology(services);
  const pts: Vec3[] = [];
  const addBox = (box: { min: Vec3; max: Vec3 } | null): void => {
    if (box) pts.push(scale(add(box.min, box.max), 0.5));
  };
  for (const it of items) {
    if (it.kind === "body") addBox(topo.bodies.get(it.body)?.bbox ?? null);
    else if ((it.kind === "face" || it.kind === "edge" || it.kind === "vertex") && it.point) pts.push([it.point[0], it.point[1], it.point[2]]);
    else if (it.kind === "feature") {
      // The faces a feature created (their keys start with its id).
      for (const b of topo.bodies.values()) {
        for (const [name, f] of b.faces) {
          if (!name.startsWith(`${it.feature}/`)) continue;
          for (const r of f.ranges) {
            const vi = b.body.indices[r.start * 3]!;
            pts.push(pointOf(b.body.positions, vi));
          }
        }
      }
    }
  }
  if (!pts.length) return null;
  return scale(pts.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / pts.length);
}

/** The direction of a line edge (its end points), for pattern directions. */
export function edgeDirection(services: AppServices, it: SelectionItem): Vec3 | null {
  if (it.kind !== "edge") return null;
  const e = bodyInfo(services, it.body)?.edges.get(it.key);
  if (!e || e.points.length < 6) return null;
  const n = e.points.length / 3;
  return unit(sub(pointOf(e.points, n - 1), pointOf(e.points, 0)));
}

/** Sign-canonical (SPEC-v1 §3.2): the first component with |x| > 1e-9 is positive. */
export function signCanonical(v: Vec3): Vec3 {
  for (const c of v) {
    if (Math.abs(c) > 1e-9) return c < 0 ? scale(v, -1) : v;
  }
  return v;
}

export { add, len, scale, sub };
export type { Vec3 };
