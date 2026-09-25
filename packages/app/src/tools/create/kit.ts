/**
 * The panel side of the modeling tools (`@aicad/model-ops` `MODELING_TOOLS`): a property panel is a
 * thin front end over the tool's **command** — its values become the command's arguments, and
 *
 * - the live preview runs the command's `build` against the document as it is, applies the ops for
 *   review only (the same op code the transaction runs, so the engine refuses here exactly what it
 *   would refuse at OK), evaluates the candidate cut at the feature (the rest of the timeline
 *   rolled back, as when editing a feature in Fusion), and shows the bodies it changes tinted, with
 *   errors on the field they belong to and the feasible range when the engine gives one;
 * - OK runs the same `build` again at OK time and commits its ops as ONE transaction — the same
 *   ops the agent's tool and MCP commit for the same arguments.
 */
import type { metricsV1 } from "@aicad/ir-types";
import {
  CommandEngineError,
  planeFrame,
  previewPlan,
  rolledBack,
  sketchFrame,
  solvedCurves,
  type Frame,
  type HostState,
  type ModelingContext,
  type ModelingPlan,
  type ModelingTool,
  type ReportLike,
  type V3,
} from "@aicad/model-ops";
import type { RenderBody } from "../../engine/types";
import type { AppServices } from "../../services";
import type { FieldError, FieldSpec, FieldValue, NumberValue, PanelHandle, PanelSpec, PanelValues, PreviewOutcome, SelectionItem, SummaryRow } from "../framework/types";

type Report = metricsV1.EvalReport;
type FeatureEntry = metricsV1.FeatureReport;

/** The modeling context of the app's IR v1 store (the document, marker, report and engine). */
export async function appModelingContext(services: AppServices): Promise<ModelingContext> {
  const ir = services.ir;
  if (!ir || ir.getState().document === null) throw new CommandEngineError("IR_NO_DOCUMENT", "this tool works on an IR v1 model (File ▸ New)");
  await ir.idle();
  const document = ir.document;
  let report: ReportLike | null = null;
  try {
    report = (await ir.report()) as unknown as ReportLike;
  } catch {
    report = null;
  }
  return { document, host: ir.getState().host, report, engine: ir.commandEngine() };
}

/** A panel field's problem (thrown by `args` for inputs the command cannot take). */
export class PanelArgError extends Error {
  readonly field: string;
  readonly code: string;
  constructor(field: string, message: string, code = "REQUIRED") {
    super(message);
    this.field = field;
    this.code = code;
  }
}

/** What a panel's handles and summary see of a passing preview. */
export interface PreviewInfo {
  plan: ModelingPlan;
  ctx: ModelingContext;
  /** The candidate document and host state (after the ops). */
  candidate: string;
  candidateHost: HostState;
  /** The report of the candidate, cut where the preview is cut. */
  report: Report;
  /** The tool's feature's entry in it (null for a feature that makes no entry). */
  entry: FeatureEntry | null;
  /** The candidate's bodies (render meshes, as evaluated). */
  bodies: readonly RenderBody[];
}

export interface ModelingPanelDef<A extends Record<string, unknown>> {
  tool: ModelingTool<A>;
  title: string;
  icon?: string;
  description?: string;
  fields: readonly FieldSpec[];
  initial?: Partial<Record<string, FieldValue | number>>;
  apply?: boolean;
  okLabel?: string;
  /** The panel's values as the command's arguments; throw {@link PanelArgError} for an input that is missing. */
  args(values: PanelValues, ctx: ModelingContext): A | Promise<A>;
  /** Command argument → panel field, where they differ (errors land on the field). */
  argField?: Readonly<Record<string, string>>;
  /** Engine error code → panel field (e.g. `HOLE_POINT_OFF_FACE` → `at`). */
  codeField?: Readonly<Record<string, string>>;
  /** Where the preview is cut: at the tool's feature (default) or at the rollback marker (the whole part). */
  cut?: "feature" | "marker";
  /** Handles from the previewed geometry; `info` is null when the command cannot build yet. */
  handles?(values: PanelValues, info: PreviewInfo | null): PanelHandle[];
  summary?(values: PanelValues, info: PreviewInfo): SummaryRow[];
  /** Cancel / Esc: tidy up (e.g. a temporary selection filter). */
  cancel?(): void;
}

/** The field an engine error or a refusal belongs to. */
function fieldOfError<A extends Record<string, unknown>>(def: ModelingPanelDef<A>, keys: ReadonlySet<string>, code: string, details: Record<string, unknown>, path?: string): string | undefined {
  const byArg = (k: unknown): string | undefined => {
    if (typeof k !== "string") return undefined;
    const base = k.replace(/^\//, "").split(/[./]/)[0]!;
    const f = def.argField?.[base] ?? base;
    return keys.has(f) ? f : undefined;
  };
  const fromCode = def.codeField?.[code];
  if (fromCode && keys.has(fromCode)) return fromCode;
  const fromDetails = byArg(details["field"]);
  if (fromDetails) return fromDetails;
  if (path) {
    const m = /^\/parts\/\d+\/features\/\d+\/([^/]+)/.exec(path) ?? /^\/([^/]+)/.exec(path);
    const f = byArg(m?.[1]);
    if (f) return f;
  }
  return undefined;
}

/** Feasible values an engine error's details name (`max_feasible_r`, `feasible: { min, max }`). */
function feasibleOf(details: Record<string, unknown>): { min?: number; max?: number } | undefined {
  const f = details["feasible"] as { min?: unknown; max?: unknown } | undefined;
  const out: { min?: number; max?: number } = {};
  if (f && typeof f === "object") {
    if (typeof f.min === "number") out.min = f.min;
    if (typeof f.max === "number") out.max = f.max;
  }
  for (const [k, v] of Object.entries(details)) {
    if (typeof v !== "number") continue;
    if (/^max_feasible/.test(k) || k === "max") out.max ??= v;
    if (/^min_feasible/.test(k) || k === "min") out.min ??= v;
  }
  return out.min !== undefined || out.max !== undefined ? out : undefined;
}

/** A thrown refusal as panel errors. */
export function errorsOf<A extends Record<string, unknown>>(def: ModelingPanelDef<A>, keys: ReadonlySet<string>, e: unknown): FieldError[] {
  if (e instanceof PanelArgError) return [{ field: e.field, code: e.code, message: e.message }];
  if (e instanceof CommandEngineError) {
    // A failing feature (the failure rule) carries its own code, details and feasible range.
    const failing = (e.details["features"] as Array<{ code?: string; message?: string; details?: Record<string, unknown> }> | undefined)?.[0];
    const code = failing?.code ?? e.code;
    const details = { ...e.details, ...(failing?.details ?? {}) };
    if (e.errors.length > 0) {
      return e.errors.slice(0, 3).map((p) => {
        const field = fieldOfError(def, keys, p.code, p.details ?? {}, p.path);
        return { ...(field ? { field } : {}), code: p.code, message: p.message };
      });
    }
    const field = fieldOfError(def, keys, code, details);
    const feasible = feasibleOf(details);
    return [{ ...(field ? { field } : {}), code, message: failing?.message ?? e.message, ...(feasible ? { feasible } : {}) }];
  }
  return [{ code: "PREVIEW_FAILED", message: e instanceof Error ? e.message : String(e) }];
}

/** The accent the preview tints changed bodies with (the app's blue). */
export const PREVIEW_TINT: [number, number, number] = [0.29, 0.56, 0.96];

/** Tint the render bodies that the feature created or modified (render bodies follow the report's part bodies, in order). */
export function tintChanged(report: Report, entry: FeatureEntry | null, bodies: readonly RenderBody[]): RenderBody[] {
  if (!entry) return [...bodies];
  const changed = new Set((entry.bodies ?? []).map((b) => originKey(b.origin)));
  const all = (report.parts ?? []).flatMap((p) => p.bodies);
  return bodies.map((b, i) => {
    const o = all[i]?.origin;
    return o && changed.has(originKey(o)) ? { ...b, color: PREVIEW_TINT } : b;
  });
}

function originKey(o: { feature: string; member: string; instance?: readonly number[] | null | undefined }): string {
  return `${o.feature}\u0000${o.member}\u0000${(o.instance ?? []).join(".")}`;
}

/** A property panel over a modeling tool's command. */
export function modelingPanel<A extends Record<string, unknown>>(services: AppServices, def: ModelingPanelDef<A>): PanelSpec {
  const keys = new Set(def.fields.map((f) => f.key));
  let lastLabel = def.title;
  const plan = async (values: PanelValues): Promise<{ ctx: ModelingContext; plan: ModelingPlan }> => {
    const ctx = await appModelingContext(services);
    const args = await def.args(values, ctx);
    const p = await def.tool.build(args, ctx);
    lastLabel = p.label;
    return { ctx, plan: p };
  };
  return {
    title: def.title,
    ...(def.icon ? { icon: def.icon } : {}),
    ...(def.description ? { description: def.description } : {}),
    fields: def.fields,
    ...(def.initial ? { initial: def.initial } : {}),
    ...(def.apply ? { apply: true } : {}),
    ...(def.okLabel ? { okLabel: def.okLabel } : {}),
    async preview(values, io): Promise<PreviewOutcome> {
      let built: { ctx: ModelingContext; plan: ModelingPlan };
      try {
        built = await plan(values);
      } catch (e) {
        // Handles that need no preview (placed from the displayed model) show even while the
        // command cannot build yet, e.g. Move's arrows before anything was moved.
        let handles: PanelHandle[] | undefined;
        try {
          handles = def.handles?.(values, null);
        } catch {
          handles = undefined;
        }
        return { ok: false, errors: errorsOf(def, keys, e), ...(handles?.length ? { handles } : {}) };
      }
      const { ctx, plan: p } = built;
      let candidate = ctx.document;
      let candidateHost = ctx.host;
      if (p.ops.length > 0) {
        try {
          const r = await previewPlan(ctx.engine!, ctx.document, ctx.host, p.ops);
          candidate = r.document;
          candidateHost = r.host;
        } catch (e) {
          return { ok: false, errors: errorsOf(def, keys, e) };
        }
      }
      if (io.signal.aborted) return { ok: true };
      const cutAt = (def.cut ?? "feature") === "feature" && p.feature ? p.feature : candidateHost.rollback;
      const text = rolledBack(candidate, cutAt);
      const r = await services.engines.active.evaluate(text);
      if (io.signal.aborted) return { ok: true };
      const report = r.report as unknown as Report;
      if (report.error) return { ok: false, errors: errorsOf(def, keys, new CommandEngineError(report.error.code, report.error.message, ((report.error.details as { errors?: [] } | undefined)?.errors ?? []) as never[])) };
      const entry = p.feature ? (report.features.find((f) => f.feature_id === p.feature) ?? null) : null;
      const info: PreviewInfo = { plan: p, ctx, candidate, candidateHost, report, entry, bodies: r.bodies };
      let handles: PanelHandle[] | undefined;
      try {
        handles = def.handles?.(values, info);
      } catch {
        handles = undefined;
      }
      if (entry && entry.status === "error" && entry.error) {
        const e = new CommandEngineError(entry.error.code, entry.error.message, [], (entry.error.details ?? {}) as Record<string, unknown>);
        return { ok: false, errors: errorsOf(def, keys, e), ...(handles ? { handles } : {}) };
      }
      const warnings = (entry?.warnings ?? []).filter((w) => w.severity === "warning").map((w) => w.message);
      return {
        ok: true,
        bodies: tintChanged(report, entry, r.bodies),
        ...(handles ? { handles } : {}),
        ...(def.summary ? { summary: def.summary(values, info) } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
    },
    async toOps(values) {
      return (await plan(values)).plan.ops;
    },
    label: () => lastLabel,
    ...(def.cancel ? { cancel: def.cancel } : {}),
  };
}

// ─── Values → arguments ──────────────────────────────────────────────────────────────────────

/** A number field's value as a command argument: its canonical expression, or the number. */
export function scalarArg(v: FieldValue | undefined): number | string | undefined {
  const n = v as NumberValue | undefined;
  if (!n || typeof n !== "object" || !("text" in n)) return undefined;
  if (n.expression) return n.canonical ?? undefined;
  if (n.value !== null) return n.value;
  return n.canonical !== null && Number.isFinite(Number(n.canonical)) ? Number(n.canonical) : undefined;
}

/** A number field's evaluated value (mm, degrees), or null. */
export function numberOf(v: FieldValue | undefined): number | null {
  const n = v as NumberValue | undefined;
  return n && typeof n === "object" && "value" in n ? n.value : null;
}

export function itemsOf(v: FieldValue | undefined): readonly SelectionItem[] {
  return Array.isArray(v) ? (v as readonly SelectionItem[]) : [];
}

/** A selected item as the provenance name a command takes. */
export function pickName(it: SelectionItem): string {
  switch (it.kind) {
    case "face":
    case "edge":
    case "vertex":
      return it.key;
    case "body":
      return it.body;
    case "feature":
    case "datum":
    case "origin":
      return it.feature;
    default:
      return "";
  }
}

// ─── Geometry for handles ────────────────────────────────────────────────────────────────────

export const v3 = {
  add: (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a: V3): number => Math.hypot(a[0], a[1], a[2]),
  unit(a: V3): V3 {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 1e-12 ? [a[0] / l + 0, a[1] / l + 0, a[2] / l + 0] : [0, 0, 1];
  },
};

/** The centre (u, v) of a sketch's profile curves (the bounding box of its solved curves). */
export function profileCenter(report: ReportLike | null, sketchId: string): [number, number] | null {
  const curves = solvedCurves(report, sketchId)?.filter((c) => !c.construction && c.kind !== "point");
  if (!curves || curves.length === 0) return null;
  let lo = [Infinity, Infinity];
  let hi = [-Infinity, -Infinity];
  const take = (p?: readonly number[]): void => {
    if (!p) return;
    lo = [Math.min(lo[0]!, p[0]!), Math.min(lo[1]!, p[1]!)];
    hi = [Math.max(hi[0]!, p[0]!), Math.max(hi[1]!, p[1]!)];
  };
  for (const c of curves) {
    take(c.start);
    take(c.end);
    if (c.center && c.radius !== undefined) {
      take([c.center[0] - c.radius, c.center[1] - c.radius]);
      take([c.center[0] + c.radius, c.center[1] + c.radius]);
    } else take(c.center);
  }
  return Number.isFinite(lo[0]!) ? [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2] : null;
}

/** A sketch's frame from the current document and report (see model-ops `sketchFrame`). */
export function frameOfSketch(ctx: ModelingContext, sketchId: string): Frame | null {
  try {
    return sketchFrame(JSON.parse(ctx.document), ctx.report, sketchId);
  } catch {
    return null;
  }
}

export function frameOfPlane(ctx: ModelingContext, plane: unknown, owner?: { id: string; field: string }): Frame | null {
  try {
    return planeFrame(JSON.parse(ctx.document), ctx.report, plane, owner);
  } catch {
    return null;
  }
}

/** The world point of (u, v) in a frame. */
export function worldOf(f: Frame, uv: readonly [number, number], w = 0): V3 {
  return v3.add(f.origin, v3.add(v3.scale(f.x, uv[0]), v3.add(v3.scale(f.y, uv[1]), v3.scale(f.normal, w))));
}

/**
 * The outward normal and centre of a face of the render mesh (for a face picked in the viewport,
 * e.g. push/pull's arrow): the area-weighted normal of its triangles and their centroid.
 */
export function faceGeometry(bodies: readonly RenderBody[], key: string, near?: readonly [number, number, number]): { normal: V3; center: V3 } | null {
  const strip = (s: string): string => s.replace(/#\d+$/, "").replace(/@[^/{}|]*$/, "");
  const want = strip(key);
  for (const b of bodies) {
    for (const r of b.faceRanges) {
      if (strip(r.face) !== want) continue;
      let n: V3 = [0, 0, 0];
      let c: V3 = [0, 0, 0];
      let area = 0;
      // Face ranges count triangles (not index-buffer offsets); normals are the exact per-vertex ones.
      for (let t = r.start; t < r.start + r.count; t++) {
        const ids = [0, 1, 2].map((k) => b.indices[3 * t + k]!);
        const p = ids.map((i) => [b.positions[3 * i]!, b.positions[3 * i + 1]!, b.positions[3 * i + 2]!] as V3);
        const a = v3.norm(v3.cross(v3.sub(p[1]!, p[0]!), v3.sub(p[2]!, p[0]!))) / 2;
        for (const i of ids) n = v3.add(n, v3.scale([b.normals[3 * i]!, b.normals[3 * i + 1]!, b.normals[3 * i + 2]!], a / 3));
        c = v3.add(c, v3.scale(v3.add(p[0]!, v3.add(p[1]!, p[2]!)), a / 3));
        area += a;
      }
      if (area <= 0) continue;
      const center = v3.scale(c, 1 / area);
      if (near && v3.norm(v3.sub(center, near as V3)) > 1e9) continue;
      return { normal: v3.unit(n), center };
    }
  }
  return null;
}
