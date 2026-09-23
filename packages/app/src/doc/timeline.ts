/**
 * The feature timeline view model: parts → features with type, status, issues and a one-line
 * summary, built from the last good compile, the evaluation report and the problem list.
 */
import type { Feature, FeatureReport } from "@aicad/ir-types";
import type { DocState } from "./doc-store";
import { problemsByFeature, type Problem } from "./problems";

export type FeatureStatus = "ok" | "warning" | "error" | "suppressed" | "pending";

export interface TimelineFeature {
  id: string;
  name: string;
  type: Feature["type"];
  partId: string;
  partName: string;
  suppressed: boolean;
  status: FeatureStatus;
  issues: Problem[];
  summary: string;
  bodyCount: number | null;
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
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function summarize(f: Feature, r: FeatureReport | undefined): string {
  switch (f.type) {
    case "sketch": {
      const plane = typeof f.plane === "string" ? f.plane : "frame";
      const parts = [plane, plural(f.curves.length, "curve")];
      if (r?.regions) parts.push(plural(r.regions.length, "region"));
      return parts.join(" · ");
    }
    case "extrude": {
      const parts = [`${fmt(f.distance)} mm`];
      if (f.direction && f.direction !== "normal") parts.push(f.direction);
      if (r?.bodies) parts.push(plural(r.bodies.length, "body", "bodies"));
      return parts.join(" · ");
    }
    case "revolve": {
      const parts = [`${fmt(f.angle)}°`];
      if (f.direction && f.direction !== "normal") parts.push(f.direction);
      if (r?.bodies) parts.push(plural(r.bodies.length, "body", "bodies"));
      return parts.join(" · ");
    }
  }
}

export function buildTimeline(
  state: Pick<DocState, "compile" | "model" | "report">,
  problems: readonly Problem[],
): TimelineModel {
  const model = state.model;
  if (!model?.ir) return { parts: [], stale: state.compile !== null && !state.compile.ok, featureCount: 0 };
  const byFeature = problemsByFeature(problems);
  const reports = new Map<string, FeatureReport>();
  for (const r of state.report?.features ?? []) reports.set(`${r.part}\u0000${r.feature}`, r);

  let featureCount = 0;
  const parts = model.ir.parts.map((part) => ({
    id: part.id,
    name: part.name,
    features: part.features.map((f): TimelineFeature => {
      featureCount++;
      const r = reports.get(`${part.name}\u0000${f.name}`);
      const issues = byFeature.get(f.id) ?? [];
      const suppressed = f.suppressed === true;
      let status: FeatureStatus;
      if (suppressed) status = "suppressed";
      else if (issues.some((p) => p.severity === "error") || r?.status === "error") status = "error";
      else if (issues.some((p) => p.severity === "warning")) status = "warning";
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
        summary: summarize(f, r),
        bodyCount: r?.bodies ? r.bodies.length : null,
      };
    }),
  }));
  return { parts, stale: state.compile !== null && !state.compile.ok, featureCount };
}
