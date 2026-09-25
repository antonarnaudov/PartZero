/**
 * Problems: CadScript compiler + type-checker diagnostics, Forge evaluation errors (per feature,
 * mapped back to the feature's source span) and engine failures — one list for the problems
 * panel, the timeline badges and the editor markers.
 */
import type { Diagnostic, Severity, Span } from "@aicad/cadscript";
import type { IrDocument } from "@aicad/ir-types";
import { hasKernelHint as KERNEL_HINTS_KNOWN, kernelHint } from "../engine/hints";
import type { DocState } from "./doc-store";
import { featureAtPosition, findFeature } from "./provenance";

export type ProblemSource = "cadscript" | "typescript" | "forge" | "engine";

export interface Problem {
  /** Stable key for React lists. */
  key: string;
  severity: Severity;
  code: string;
  message: string;
  hint?: string;
  source: ProblemSource;
  span?: Span;
  /** For kernel errors the marker covers only the first line of the feature statement. */
  spanMode?: "exact" | "first-line";
  featureId?: string;
  featureName?: string;
  /** A parameter's own failure. */
  param?: string;
}

/**
 * Warnings that are information, not a problem to look at: an under-constrained sketch is normal
 * while you design (Fusion and Shapr3D show it in the sketch, not in the timeline).
 */
export const INFORMATIONAL_WARNINGS: ReadonlySet<string> = new Set(["SKETCH_UNDER_CONSTRAINED"]);

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function collectProblems(state: Pick<DocState, "compile" | "model" | "report" | "engineError">): Problem[] {
  const out: Problem[] = [];
  const compile = state.compile;
  if (compile) {
    compile.diagnostics.forEach((d, i) => out.push(fromDiagnostic(d, i, compile.spans, compile.ir)));
  }
  // Kernel errors belong to the evaluated model; only show them while the code compiles, so
  // stale evaluation errors never point at edited code.
  const model = state.model;
  if (state.report && compile?.ok && model?.ir) {
    for (const f of state.report.features) {
      // Warnings worth a look (IR v1 §7.3): not the informational ones (an under-constrained sketch while you design).
      for (const [wi, w] of ((f as { warnings?: Array<{ code: string; severity: string; message: string }> }).warnings ?? []).entries()) {
        if (INFORMATIONAL_WARNINGS.has(w.code)) continue;
        const loc = findFeature(model.ir, f.feature);
        // A note is not a failure: only a hint written for this very code (not the engine-failure fallback).
        const hint = KERNEL_HINTS_KNOWN(w.code) ? kernelHint(w.code) : undefined;
        out.push({
          key: `forge:${f.part}/${f.feature}:w${wi}:${w.code}`,
          severity: w.severity === "info" ? "info" : "warning",
          code: w.code,
          message: w.message,
          source: "forge",
          featureName: f.feature,
          ...(hint ? { hint } : {}),
          ...(loc ? { featureId: loc.feature.id } : {}),
        });
      }
      if (f.status !== "error" || !f.error) continue;
      const loc = findFeature(model.ir, f.feature);
      const span = loc ? model.spans[loc.feature.id] : undefined;
      const hint = kernelHint(f.error.code);
      out.push({
        key: `forge:${f.part}/${f.feature}:${f.error.code}`,
        severity: "error",
        code: f.error.code,
        message: f.error.message,
        source: "forge",
        featureName: f.feature,
        ...(hint ? { hint } : {}),
        ...(span ? { span, spanMode: "first-line" as const } : {}),
        ...(loc ? { featureId: loc.feature.id } : {}),
      });
    }
    // A parameter that fails (PARAM_FAILED, EXPR_*): every feature using it fails too, but the cause is here.
    for (const p of (state.report as { params?: Array<{ name: string; error?: { code: string; message: string } }> }).params ?? []) {
      if (!p.error) continue;
      const hint = kernelHint(p.error.code);
      out.push({
        key: `forge:param:${p.name}:${p.error.code}`,
        severity: "error",
        code: p.error.code,
        message: `parameter ${p.name}: ${p.error.message}`,
        source: "forge",
        param: p.name,
        ...(hint ? { hint } : {}),
      });
    }
    if (state.report.error) {
      const hint = kernelHint(state.report.error.code);
      out.push({
        key: `forge:doc:${state.report.error.code}`,
        severity: "error",
        code: state.report.error.code,
        message: state.report.error.message,
        source: "forge",
        ...(hint ? { hint } : {}),
      });
    }
  }
  if (state.engineError) {
    const hint = kernelHint("ENGINE_FAILED");
    out.push({ key: "engine", severity: "error", code: "ENGINE_FAILED", message: state.engineError, source: "engine", ...(hint ? { hint } : {}) });
  }
  return out.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.span?.start.line ?? Number.MAX_SAFE_INTEGER) - (b.span?.start.line ?? Number.MAX_SAFE_INTEGER) ||
      (a.span?.start.col ?? 0) - (b.span?.start.col ?? 0),
  );
}

function fromDiagnostic(d: Diagnostic, i: number, spans: Record<string, Span>, ir: IrDocument | null): Problem {
  const featureId = featureAtPosition(spans, d.span.start);
  const featureName = featureId ? findFeature(ir, featureId)?.feature.name : undefined;
  return {
    key: `diag:${i}:${d.code}:${d.span.start.line}:${d.span.start.col}`,
    severity: d.severity,
    code: d.code,
    message: d.message,
    source: d.code.startsWith("TS") ? "typescript" : "cadscript",
    span: d.span,
    spanMode: "exact",
    ...(d.hint ? { hint: d.hint } : {}),
    ...(featureId ? { featureId } : {}),
    ...(featureName ? { featureName } : {}),
  };
}

export function countBySeverity(problems: readonly Problem[]): Record<Severity, number> {
  const c: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const p of problems) c[p.severity]++;
  return c;
}

/** Problems grouped by feature id (for timeline badges). */
export function problemsByFeature(problems: readonly Problem[]): Map<string, Problem[]> {
  const m = new Map<string, Problem[]>();
  for (const p of problems) {
    if (!p.featureId) continue;
    const l = m.get(p.featureId);
    if (l) l.push(p);
    else m.set(p.featureId, [p]);
  }
  return m;
}

// ─── Editor markers ──────────────────────────────────────────────────────────────────────────

/** Monaco `MarkerSeverity` values (kept here so this module stays free of the editor runtime). */
export const MarkerSeverity = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;
export type MarkerSeverityValue = (typeof MarkerSeverity)[keyof typeof MarkerSeverity];

/** Structurally a Monaco `editor.IMarkerData`. */
export interface MarkerData {
  severity: MarkerSeverityValue;
  message: string;
  code?: string;
  source: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

const SEVERITY_TO_MARKER: Record<Severity, MarkerSeverityValue> = {
  error: MarkerSeverity.Error,
  warning: MarkerSeverity.Warning,
  info: MarkerSeverity.Info,
};

const SOURCE_LABEL: Record<ProblemSource, string> = {
  cadscript: "cadscript",
  typescript: "ts",
  forge: "forge",
  engine: "engine",
};

/**
 * Problems → editor markers. Spans are 1-based with an exclusive end (the same convention as
 * Monaco). Empty spans are widened to one character so they stay visible; kernel errors mark the
 * first line of the feature statement only.
 *
 * @param lineLength length of a 1-based line (without the line break); used to clamp and widen.
 */
export function problemsToMarkers(problems: readonly Problem[], lineLength: (line: number) => number): MarkerData[] {
  const markers: MarkerData[] = [];
  for (const p of problems) {
    if (!p.span) continue;
    let { line: sl, col: sc } = p.span.start;
    let { line: el, col: ec } = p.span.end;
    if (p.spanMode === "first-line") {
      el = sl;
      ec = lineLength(sl) + 1;
    }
    if (el < sl || (el === sl && ec < sc)) [el, ec] = [sl, sc];
    if (el === sl && ec === sc) {
      const len = lineLength(sl);
      if (sc <= len) ec = sc + 1;
      else if (sc > 1) sc = sc - 1;
    }
    markers.push({
      severity: SEVERITY_TO_MARKER[p.severity],
      message: p.hint ? `${p.message}\nHint: ${p.hint}` : p.message,
      code: p.code,
      source: SOURCE_LABEL[p.source],
      startLineNumber: sl,
      startColumn: sc,
      endLineNumber: el,
      endColumn: ec,
    });
  }
  return markers;
}
