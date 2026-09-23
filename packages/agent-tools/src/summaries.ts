/**
 * Compact text views of the IR and of evaluation reports: the IR summary (feature list with key
 * parameters), body/region metrics, model totals and IR deltas. Everything is deterministic and
 * sized for an LLM context (the IR summary targets ≤ 4k tokens, other views ≤ 2k).
 */
import type { BodyMetrics, EvalReport, FeatureReport, IrDocument, PlaneSpec, RegionMetrics, SketchCurve } from "@aicad/ir-types";
import { curveChanges, featureChanges, type IrChange } from "@aicad/evals";
import { capList, CHARS_PER_TOKEN, clip, dims, histogram, num, plural, vec } from "./format.js";
import { arcRadius } from "./sketch-geom.js";

export function planeText(p: PlaneSpec): string {
  if (typeof p === "string") return p;
  return `frame(origin ${vec(p.origin)}, normal ${vec(p.normal)}, xDir ${vec(p.x_dir)})`;
}

export function curveText(c: SketchCurve): string {
  if (c.kind === "line") return `${c.id}: line ${vec(c.start)}→${vec(c.end)}`;
  if (c.kind === "circle") return `${c.id}: circle c${vec(c.center)} r${num(c.radius)}`;
  return `${c.id}: arc ${vec(c.start)}→${vec(c.end)} c${vec(c.center)} r${num(arcRadius(c))} ${c.ccw ? "ccw" : "cw"}`;
}

export function bboxSize(b: Pick<BodyMetrics, "bbox_min" | "bbox_max">): number[] {
  return [0, 1, 2].map((i) => b.bbox_max[i]! - b.bbox_min[i]!);
}

/** `V 30.44 mm³, bbox 7×7×1 @[-3.5, -3.5, 0], faces 4 (cylinder 2, plane 2)` */
export function bodyText(b: BodyMetrics): string {
  const faces = histogram(b.face_types);
  return `V ${num(b.volume)} mm³, bbox ${dims(bboxSize(b))} @${vec(b.bbox_min)}, faces ${b.faces}${faces ? ` (${faces})` : ""}${b.valid ? "" : ", INVALID"}`;
}

export function regionText(r: RegionMetrics): string {
  const holes = r.loops - 1;
  return `area ${num(r.area)} mm²${holes > 0 ? `, ${plural(holes, "hole")}` : ""} [outer: ${r.outer_curves.join(", ")}]`;
}

/** One line for a successful feature: bodies or regions. */
export function featureResultText(f: FeatureReport): string {
  if (f.regions) {
    const holes = f.regions.reduce((n, r) => n + r.loops - 1, 0);
    return `${plural(f.regions.length, "region")}${holes > 0 ? `, ${plural(holes, "hole")}` : ""}`;
  }
  const bodies = f.bodies ?? [];
  if (bodies.length === 1) return `1 body: ${bodyText(bodies[0]!)}`;
  return `${plural(bodies.length, "body", "bodies")}: ${capList(bodies, 4, bodyText).join("; ")}`;
}

export interface ModelTotals {
  bodies: number;
  volume: number;
  bboxMin: number[];
  bboxMax: number[];
}

export function modelTotals(report: EvalReport): ModelTotals {
  const bodies = report.features.filter((f) => f.status === "ok").flatMap((f) => f.bodies ?? []);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, b.bbox_min[i]!);
      max[i] = Math.max(max[i]!, b.bbox_max[i]!);
    }
  }
  return { bodies: bodies.length, volume: bodies.reduce((s, b) => s + b.volume, 0), bboxMin: min, bboxMax: max };
}

export function totalsText(t: ModelTotals): string {
  if (t.bodies === 0) return "no bodies yet";
  const size = [0, 1, 2].map((i) => t.bboxMax[i]! - t.bboxMin[i]!);
  return `${plural(t.bodies, "body", "bodies")}, total V ${num(t.volume)} mm³, overall bbox ${dims(size)} from ${vec(t.bboxMin)} to ${vec(t.bboxMax)}`;
}

/** `~base (curves +h1 −h2 ~top), +plate, −old` — IR changes grouped per feature. */
export function changesText(before: IrDocument | null, after: IrDocument | null): { text: string; changes: IrChange[] } {
  if (!after) return { text: "IR unavailable (compile errors)", changes: [] };
  const empty: IrDocument = { schema: after.schema, parts: [] };
  const base = before ?? empty;
  const feats = featureChanges(base, after);
  const curves = curveChanges(base, after);
  const byFeature = new Map<string, string[]>();
  for (const c of curves) {
    const [name, id] = [c.path.slice(0, c.path.indexOf(".")), c.path.slice(c.path.indexOf(".") + 1)];
    const sign = c.what === "added" ? "+" : c.what === "removed" ? "−" : "~";
    const list = byFeature.get(name) ?? [];
    list.push(`${sign}${id}`);
    byFeature.set(name, list);
  }
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const f of feats) {
    seen.add(f.path);
    const sign = f.what === "added" ? "+" : f.what === "removed" ? "−" : "~";
    const cs = f.what === "modified" ? byFeature.get(f.path) : undefined;
    parts.push(`${sign}${f.path}${cs ? ` (curves ${capList(cs, 8, (x) => x).join(" ")})` : ""}`);
  }
  for (const [name, cs] of byFeature) {
    if (seen.has(name)) continue;
    parts.push(`~${name} (curves ${capList(cs, 8, (x) => x).join(" ")})`);
  }
  return { text: parts.length > 0 ? parts.join(", ") : "no IR changes", changes: [...feats, ...curves] };
}

export interface IrSummaryOptions {
  /** Curves listed per sketch before switching to counts (default 12). */
  maxCurves?: number;
  /** Character cap (default ≈ 4k tokens). */
  maxChars?: number;
}

/** Compact feature list with key parameters and (when a report is given) per-feature results. */
export function irSummary(ir: IrDocument, report?: EvalReport | null, options: IrSummaryOptions = {}): string {
  const maxCurves = options.maxCurves ?? 12;
  const byName = new Map<string, FeatureReport>();
  for (const f of report?.features ?? []) byName.set(f.feature, f);
  const featureCount = ir.parts.reduce((n, p) => n + p.features.length, 0);
  const name = ir.meta?.name ? `"${ir.meta.name}"` : "(unnamed)";
  const lines: string[] = [`doc ${name}: ${plural(ir.parts.length, "part")}, ${plural(featureCount, "feature")}${report ? `, status ${report.status}` : ""}`];
  if (ir.meta?.description) lines.push(`  intent: ${ir.meta.description}`);
  for (const part of ir.parts) {
    lines.push(`part "${part.name}"`);
    for (const f of part.features) {
      const r = byName.get(f.name);
      const status = f.suppressed ? " [suppressed]" : !r ? "" : r.status === "ok" ? ` → ${featureResultText(r)}` : ` → ✗ ${r.error?.code ?? "ERROR"}`;
      if (f.type === "sketch") {
        const kinds: Record<string, number> = {};
        for (const c of f.curves) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
        lines.push(`  ${f.name}: sketch on ${planeText(f.plane)}, ${plural(f.curves.length, "curve")} (${histogram(kinds)})${status}`);
        if (f.curves.length <= maxCurves) for (const c of f.curves) lines.push(`    ${curveText(c)}`);
        else lines.push(`    ids: ${capList(f.curves, 40, (c) => c.id).join(", ")}`);
      } else if (f.type === "extrude") {
        lines.push(`  ${f.name}: extrude ${f.sketch} ${num(f.distance)} mm${f.direction && f.direction !== "normal" ? ` (${f.direction})` : ""}${status}`);
      } else {
        lines.push(
          `  ${f.name}: revolve ${f.sketch} ${num(f.angle)}° about origin ${vec(f.axis.origin)} dir ${vec(f.axis.direction)}${f.direction && f.direction !== "normal" ? ` (${f.direction})` : ""}${status}`,
        );
      }
    }
  }
  if (report) lines.push(`model: ${totalsText(modelTotals(report))}`);
  return clip(lines.join("\n"), options.maxChars ?? Math.floor(4000 * CHARS_PER_TOKEN), "use get_code or measure for one feature");
}

/** Detailed metrics of one body. */
export function bodyDetail(b: BodyMetrics): string[] {
  return [
    `volume ${num(b.volume)} mm³, area ${num(b.area)} mm², centroid ${vec(b.centroid)}`,
    `bbox ${vec(b.bbox_min)} → ${vec(b.bbox_max)} (size ${dims(bboxSize(b))})`,
    `faces ${b.faces} (${histogram(b.face_types)}), edges ${b.edges} (${histogram(b.edge_types)}), valid ${b.valid}`,
  ];
}

/** The `measure` view: one feature in detail, or every feature briefly plus model totals. */
export function measureText(report: EvalReport, options: { feature?: string | undefined; body?: number | undefined } = {}): string {
  const lines: string[] = [`report: ${report.engine}, status ${report.status}`];
  if (options.feature !== undefined) {
    const f = report.features.find((x) => x.feature === options.feature);
    if (!f) {
      const names = report.features.map((x) => x.feature).join(", ");
      return `no feature "${options.feature}" in the latest report (evaluated features: ${names || "none"}; suppressed features are not evaluated)`;
    }
    lines.push(`${f.feature} (${f.type}, part "${f.part}"): ${f.status}${f.error ? ` ${f.error.code}: ${f.error.message}` : ""}`);
    if (f.regions) {
      lines.push(`${plural(f.regions.length, "region")}, ${plural(f.regions.reduce((n, r) => n + r.loops, 0), "loop")} in total:`);
      f.regions.slice(0, 20).forEach((r, i) => lines.push(`  region ${i}: loops ${r.loops}, ${regionText(r)}`));
      if (f.regions.length > 20) lines.push(`  … ${f.regions.length - 20} more regions`);
    }
    const bodies = f.bodies ?? [];
    const pick = options.body === undefined ? bodies.map((b, i) => ({ b, i })) : bodies[options.body] ? [{ b: bodies[options.body]!, i: options.body }] : [];
    if (options.body !== undefined && pick.length === 0) lines.push(`no body #${options.body} (this feature made ${bodies.length})`);
    for (const { b, i } of pick.slice(0, 8)) {
      lines.push(`body ${i}:`);
      for (const l of bodyDetail(b)) lines.push(`  ${l}`);
    }
    if (pick.length > 8) lines.push(`… ${pick.length - 8} more bodies (pass body: N)`);
    return clip(lines.join("\n"));
  }
  for (const f of report.features) {
    if (f.status !== "ok") lines.push(`✗ ${f.feature} (${f.type}): ${f.error?.code ?? "ERROR"}`);
    else lines.push(`${f.feature} (${f.type}): ${featureResultText(f)}`);
  }
  if (report.error) lines.push(`document error ${report.error.code}: ${report.error.message}`);
  lines.push(`model: ${totalsText(modelTotals(report))}`);
  return clip(lines.join("\n"), undefined, "pass feature: <name> for one feature");
}
