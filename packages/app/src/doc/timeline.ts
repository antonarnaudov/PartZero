/**
 * The feature timeline view model: parts → features with type, status, issues, authorship and a
 * one-line summary, built from the model (an IR v1 document, or the last good compile of CadScript
 * v0), the evaluation report and the problem list. For an IR v1 document it also marks the
 * features after the rollback marker (not built) and the agent's features (ADR 0015).
 */
import type { FeatureReport } from "@aicad/ir-types";
import { rolledBackFeatures } from "@aicad/model-ops";
import type { DocState } from "./doc-store";
import { INFORMATIONAL_WARNINGS, problemsByFeature, type Problem } from "./problems";

export type FeatureStatus = "ok" | "warning" | "error" | "suppressed" | "pending" | "rolled-back";

export interface TimelineFeature {
  id: string;
  name: string;
  /** The IR feature type (`sketch`, `extrude`, `hole`, `fillet`, …). */
  type: string;
  partId: string;
  partName: string;
  suppressed: boolean;
  status: FeatureStatus;
  issues: Problem[];
  summary: string;
  bodyCount: number | null;
  /** ADR 0015: made by the agent and not yet kept or edited by you. */
  agent: boolean;
  /** After the rollback marker: not built. */
  rolledBack: boolean;
}

export interface TimelinePart {
  id: string;
  name: string;
  features: TimelineFeature[];
}

export interface TimelineModel {
  parts: TimelinePart[];
  /** The code currently has errors: the timeline shows the last model that compiled. */
  stale: boolean;
  featureCount: number;
  /** The rollback marker (the last built feature's id), or null. */
  rollback: string | null;
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A Scalar field for people: `5 mm`, `t * 2`, `30°`. */
function scalar(v: unknown, unit: "mm" | "°" | "" = "mm"): string | null {
  if (typeof v === "number") return unit === "°" ? `${fmt(v)}°` : unit ? `${fmt(v)} ${unit}` : fmt(v);
  if (typeof v === "string" && v.length > 0) return v.length > 24 ? `${v.slice(0, 23)}…` : v;
  return null;
}

function planeLabel(plane: unknown): string {
  if (typeof plane === "string") return plane;
  if (plane && typeof plane === "object") {
    if ("face" in plane) return "face";
    if ("datum" in plane) return "datum";
  }
  return "frame";
}

type Json = Record<string, unknown>;

function summarize(f: Json, r: FeatureReport | undefined): string {
  const parts: string[] = [];
  const push = (s: string | null | undefined) => {
    if (s) parts.push(s);
  };
  const bodies = () => {
    if (r?.bodies) push(plural(r.bodies.length, "body", "bodies"));
  };
  const op = typeof f["op"] === "string" && f["op"] !== "new_body" ? String(f["op"]) : null;
  switch (f["type"]) {
    case "sketch": {
      const curves = Array.isArray(f["curves"]) ? f["curves"].length : 0;
      push(planeLabel(f["plane"]));
      push(plural(curves, "curve"));
      const constraints = Array.isArray(f["constraints"]) ? f["constraints"].length : 0;
      if (constraints > 0) push(plural(constraints, "constraint"));
      if (r?.regions) push(plural(r.regions.length, "region"));
      break;
    }
    case "extrude":
      push(scalar(f["distance"]));
      if (typeof f["direction"] === "string" && f["direction"] !== "normal") push(String(f["direction"]));
      push(op);
      bodies();
      break;
    case "revolve":
      push(scalar(f["angle"], "°"));
      push(op);
      bodies();
      break;
    case "hole": {
      const size = f["size"];
      push(typeof size === "string" ? size : scalar(size));
      if (f["depth"] === "through") push("through");
      if (r && "holes" in r && Array.isArray(r.holes)) push(plural(r.holes.length, "hole"));
      break;
    }
    case "fillet":
      push(scalar(f["r"]));
      break;
    case "chamfer":
      push(scalar(f["d"]));
      break;
    case "shell":
      push(scalar(f["thickness"]));
      break;
    case "draft":
      push(scalar(f["angle"], "°"));
      break;
    case "boolean":
      push(op ?? (typeof f["op"] === "string" ? String(f["op"]) : null));
      bodies();
      break;
    case "pattern":
      push(op);
      bodies();
      break;
    case "datum_plane":
    case "datum_axis":
      push(typeof f["mode"] === "string" ? String(f["mode"]) : null);
      break;
    default:
      bodies();
  }
  return parts.join(" · ");
}


/** Whether a report entry carries a warning worth a timeline badge. */
function notable(r: FeatureReport | undefined): boolean {
  const warnings = (r as { warnings?: Array<{ code?: string; severity?: string }> } | undefined)?.warnings ?? [];
  // Notes (severity info) are listed in Problems but do not mark the feature.
  return warnings.some((w) => w.severity !== "info" && !INFORMATIONAL_WARNINGS.has(w.code ?? ""));
}

export function buildTimeline(
  state: Pick<DocState, "compile" | "model" | "report"> & Partial<Pick<DocState, "format" | "source" | "v1">>,
  problems: readonly Problem[],
): TimelineModel {
  const model = state.model;
  const rollback = state.format === "ir-v1" ? (state.v1?.host.rollback ?? null) : null;
  if (!model?.ir) return { parts: [], stale: state.compile !== null && !state.compile.ok, featureCount: 0, rollback };
  const byFeature = problemsByFeature(problems);
  const byId = new Map<string, FeatureReport>();
  const byName = new Map<string, FeatureReport>();
  for (const r of state.report?.features ?? []) {
    const id = (r as FeatureReport & { feature_id?: string }).feature_id;
    if (typeof id === "string") byId.set(id, r);
    byName.set(`${r.part}\u0000${r.feature}`, r);
  }
  const later = new Set(state.format === "ir-v1" && state.source ? rolledBackFeatures(state.source, rollback) : []);

  let featureCount = 0;
  const parts = model.ir.parts.map((part) => ({
    id: part.id,
    name: part.name,
    features: part.features.map((f): TimelineFeature => {
      featureCount++;
      const json = f as unknown as Json;
      const r = byId.get(f.id) ?? byName.get(`${part.name}\u0000${f.name}`);
      const issues = byFeature.get(f.id) ?? [];
      const suppressed = f.suppressed === true;
      const rolledBack = later.has(f.id);
      let status: FeatureStatus;
      if (rolledBack) status = "rolled-back";
      else if (suppressed) status = "suppressed";
      else if (issues.some((p) => p.severity === "error") || r?.status === "error") status = "error";
      else if (issues.some((p) => p.severity === "warning") || notable(r)) status = "warning";
      else if (r?.status === "ok") status = "ok";
      else status = "pending";
      return {
        id: f.id,
        name: f.name,
        type: f.type,
        partId: part.id,
        partName: part.name,
        suppressed,
        status,
        issues,
        summary: summarize(json, r),
        bodyCount: r?.bodies ? r.bodies.length : null,
        agent: json["author"] === "agent",
        rolledBack,
      };
    }),
  }));
  return { parts, stale: state.compile !== null && !state.compile.ok, featureCount, rollback };
}
