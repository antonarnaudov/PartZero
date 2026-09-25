/**
 * Compact text views of an IR v1 document and its `aicad.metrics/1` report: the v1 `ir_summary`
 * (parameters with their evaluated values, each feature as its canonical CadScript call, results,
 * warnings and unresolved references), `measure`, model totals and apply deltas. Deterministic
 * and sized for an LLM context (the summary targets ≤ 4k tokens, other views ≤ 2k).
 */
import ts from "typescript";
import { v1 as cs } from "@aicad/cadscript";
import type { v1 as ir, metricsV1 } from "@aicad/ir-types";
import { capList, CHARS_PER_TOKEN, clip, dims, histogram, ident, jsonQuote, num, oneLine, plural, quoteText, vec } from "../format.js";
import { bboxSize } from "../summaries.js";
import { refCandidates } from "./playbooks.js";
import { displayName, featureName, probeText, type V1View } from "./render.js";
import { allParams } from "./session.js";

type Report = metricsV1.EvalReport;
type Entry = metricsV1.FeatureReport;

/** `V 30.44 mm³, bbox 7×7×1 @[-3.5, -3.5, 0], faces 4 (cylinder 2, plane 2)` */
export function bodyTextV1(b: metricsV1.BodyReport): string {
  const faces = histogram(b.face_types);
  return `V ${num(b.volume)} mm³, bbox ${dims(bboxSize(b))} @${vec(b.bbox_min)}, faces ${b.faces}${faces ? ` (${faces})` : ""}${b.shells > 1 ? `, ${b.shells} shells` : ""}${b.valid ? "" : ", INVALID"}`;
}

/** One line for a successful feature entry: regions, bodies created/modified, holes, blends, … */
export function featureResultTextV1(f: Entry): string {
  const parts: string[] = [];
  if (f.regions) {
    const holes = f.regions.reduce((n, r) => n + r.loops - 1, 0);
    parts.push(`${plural(f.regions.length, "region")}${holes > 0 ? `, ${plural(holes, "inner loop")}` : ""}`);
  }
  if (f.sketch && f.sketch.mode === "constrained") parts.push(`${f.sketch.status ?? "solved"}${f.sketch.dof ? `, ${f.sketch.dof} DOF` : ""}`);
  if (f.holes) parts.push(plural(f.holes.length, "hole"));
  if (f.fillet) parts.push(`${plural(f.fillet.edges.length, "edge")} filleted`);
  if (f.chamfer) parts.push(`${plural(f.chamfer.edges.length, "edge")} chamfered`);
  if (f.shell) parts.push(`${plural(f.shell.removed_faces.length, "face")} opened${f.shell.closed_void ? ", closed void" : ""}`);
  if (f.pattern) parts.push(`${plural(f.pattern.instances, "instance")}${f.pattern.skipped?.length ? `, ${f.pattern.skipped.length} skipped` : ""}`);
  if (f.datum) parts.push("normal" in f.datum ? `plane at ${vec(f.datum.origin)} normal ${vec(f.datum.normal)}` : `axis through ${vec(f.datum.origin)} along ${vec(f.datum.direction)}`);
  const bodies = f.bodies ?? [];
  if (bodies.length > 0) {
    const created = bodies.filter((b) => b.change !== "modified").length;
    const modified = bodies.length - created;
    const label = [created > 0 ? `${created} created` : "", modified > 0 ? `${modified} modified` : ""].filter(Boolean).join(", ");
    parts.push(bodies.length === 1 ? `1 body (${label}): ${bodyTextV1(bodies[0]!)}` : `${plural(bodies.length, "body", "bodies")} (${label})`);
  }
  if (f.removed?.length) parts.push(`${plural(f.removed.length, "body", "bodies")} consumed`);
  if (f.type === "tag" && f.refs?.[0]) parts.push(`${plural(f.refs[0].members.length, "entity", "entities")}`);
  return parts.join("; ") || "ok";
}

export interface ModelTotalsV1 {
  bodies: number;
  volume: number;
  bboxMin: number[];
  bboxMax: number[];
}

/** The final bodies of every part (SPEC-v1 §6.0.5). */
export function finalBodies(report: Report): metricsV1.BodyReport[] {
  return (report.parts ?? []).flatMap((p) => p.bodies);
}

export function modelTotalsV1(report: Report): ModelTotalsV1 {
  const bodies = finalBodies(report);
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

export function totalsTextV1(t: ModelTotalsV1): string {
  if (t.bodies === 0) return "no bodies yet";
  const size = [0, 1, 2].map((i) => t.bboxMax[i]! - t.bboxMin[i]!);
  return `${plural(t.bodies, "body", "bodies")}, total V ${num(t.volume)} mm³, overall bbox ${dims(size)} from ${vec(t.bboxMin)} to ${vec(t.bboxMax)}`;
}

function paramValue(v: ir.ParamValue): string {
  return typeof v === "string" ? `= ${oneLine(v, 160)}` : String(v);
}

/** `width = 80 mm [20..300] "outer width"` / `inner = width - 2 * wall → 76 mm` / `✗ PARAM_OUT_OF_RANGE`. */
export function paramsTextV1(doc: ir.IrDocument, report: Report | null | undefined): string[] {
  const values = new Map((report?.params ?? []).map((p) => [`${p.scope}|${p.name}`, p] as const));
  return allParams(doc).map((p) => {
    const r = values.get(`${p.scope}|${p.name}`);
    const bounds = p.min !== undefined || p.max !== undefined ? ` [${p.min === undefined ? "" : typeof p.min === "number" ? num(p.min) : oneLine(p.min, 40)}..${p.max === undefined ? "" : typeof p.max === "number" ? num(p.max) : oneLine(p.max, 40)}]` : "";
    const derived = typeof p.value === "string";
    const evaluated = r?.error ? ` → ✗ ${ident(r.error.code)}` : derived && r?.value !== undefined ? ` → ${typeof r.value === "number" ? num(r.value) : String(r.value)}` : "";
    const scope = p.scope === "doc" ? "" : ` (part ${quoteText(p.scope, 60)})`;
    return `  ${ident(p.name)} ${derived ? paramValue(p.value) : `= ${typeof p.value === "number" ? num(p.value) : String(p.value)}`} ${p.unit}${bounds}${evaluated}${scope}${p.note ? ` ${quoteText(p.note, 80)}` : ""}`;
  });
}

/** Each feature's canonical CadScript call (`fillet(slab.sides().edges().parallel(Z), { r: 2 })`), by name. */
export function printedCalls(doc: ir.IrDocument): Map<string, string> {
  const out = new Map<string, string>();
  let printed: string;
  try {
    printed = cs.print(doc);
  } catch {
    return out;
  }
  const sf = ts.createSourceFile("print.cad.ts", printed, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const d = stmt.declarationList.declarations[0];
    if (d && ts.isIdentifier(d.name) && d.initializer) out.set(d.name.text, d.initializer.getText(sf).replace(/\s*\n\s*/g, " "));
  }
  return out;
}

/** Failed and non-exact references of a feature entry, one line each. */
function refLines(f: Entry): string[] {
  const out: string[] = [];
  for (const r of f.refs ?? []) {
    if (r.status === "exact") continue;
    const cands = refCandidates(r.unresolved ?? []);
    out.push(`    ref ${r.field}: ${r.status}${r.code ? ` ${ident(r.code)}` : ""}${cands.length > 0 ? `, ${plural(cands.length, "candidate")}: ${capList(cands, 3, (c) => `${c.index}. ${displayName(String(c.candidate["name"] ?? "?"))}`).join(", ")}` : ""}${r.proposal ? " (proposal available: accept_ref_proposal)" : ""}`);
  }
  return out;
}

export interface IrSummaryOptionsV1 {
  /** Character cap (default ≈ 4k tokens). */
  maxChars?: number;
}

/** The v1 `ir_summary`: parameters, then every feature as its CadScript call with its result, warnings and references. */
export function irSummaryV1(doc: ir.IrDocument, report?: Report | null, options: IrSummaryOptionsV1 = {}): string {
  const byName = new Map<string, Entry>();
  for (const f of report?.features ?? []) byName.set(f.feature, f);
  const featureCount = doc.parts.reduce((n, p) => n + p.features.length, 0);
  const title = doc.meta?.name ? quoteText(doc.meta.name, 120) : "(unnamed)";
  const lines = [`doc ${title}: ${plural(doc.parts.length, "part")}, ${plural(featureCount, "feature")}${report ? `, status ${report.status}` : ""}`];
  if (doc.meta?.description) lines.push(`  intent: ${quoteText(doc.meta.description)}`);
  const params = paramsTextV1(doc, report);
  if (params.length > 0) lines.push(`parameters (${params.length}):`, ...params);
  const calls = printedCalls(doc);
  for (const part of doc.parts) {
    lines.push(`part ${quoteText(part.name, 120)}`);
    for (const f of part.features) {
      const r = byName.get(f.name);
      const status = f.suppressed === true ? " [suppressed]" : !r ? "" : r.status === "ok" ? ` → ${featureResultTextV1(r)}` : ` → ✗ ${ident(r.error?.code ?? "ERROR")}`;
      const call = calls.get(f.name);
      lines.push(`  ${ident(f.name)}: ${call ? oneLine(call, f.type === "sketch" ? 260 : 200) : f.type}${status}`);
      for (const w of r?.warnings ?? []) lines.push(`    ${w.severity} ${ident(w.code)}: ${oneLine(w.message, 160)}`);
      if (r) lines.push(...refLines(r));
    }
  }
  if (report?.error) lines.push(`document rejected: ${ident(report.error.code)}: ${oneLine(report.error.message, 200)}`);
  if (report) lines.push(`model: ${totalsTextV1(modelTotalsV1(report))}`);
  return clip(lines.join("\n"), options.maxChars ?? Math.floor(4000 * CHARS_PER_TOKEN), "use get_code or measure for one feature");
}

function bodyDetail(b: metricsV1.BodyReport, view: V1View): string[] {
  return [
    `origin ${ident(featureName(view, b.origin.feature))} (region ${ident(b.origin.member)})${b.origin.instance ? ` instance ${vec(b.origin.instance)}` : ""}${b.change ? `, ${b.change}` : ""}`,
    `volume ${num(b.volume)} mm³, area ${num(b.area)} mm², centroid ${vec(b.centroid)}`,
    `bbox ${vec(b.bbox_min)} → ${vec(b.bbox_max)} (size ${dims(bboxSize(b))})`,
    `faces ${b.faces} (${histogram(b.face_types)}), edges ${b.edges} (${histogram(b.edge_types)}), shells ${b.shells}, valid ${b.valid}`,
  ];
}

/** The v1 `measure` view: one feature in detail, or every feature briefly plus the final bodies. */
export function measureTextV1(report: Report, options: { feature?: string | undefined; body?: number | undefined; ir?: ir.IrDocument | null } = {}): string {
  const view: V1View = { report, ir: options.ir ?? null };
  const lines: string[] = [`report: ${oneLine(report.engine, 80)}, status ${report.status}`];
  if (options.feature !== undefined) {
    const f = report.features.find((x) => x.feature === options.feature);
    if (!f) {
      const names = report.features.map((x) => ident(x.feature)).join(", ");
      return `no feature ${jsonQuote(options.feature)} in the latest report (evaluated features: ${names || "none"}; suppressed features are not evaluated)`;
    }
    lines.push(`${ident(f.feature)} (${ident(f.type)}, part ${quoteText(f.part, 120)}): ${f.status}${f.error ? ` ${ident(f.error.code)}: ${oneLine(f.error.message)}` : ""}`);
    for (const w of f.warnings ?? []) lines.push(`  ${w.severity} ${ident(w.code)}: ${oneLine(w.message, 200)}`);
    if (f.regions) {
      lines.push(`${plural(f.regions.length, "region")}:`);
      f.regions.slice(0, 20).forEach((r, i) => lines.push(`  region ${i}: area ${num(r.area)} mm², loops ${r.loops} [outer: ${r.outer_curves.map(ident).join(", ")}]`));
    }
    if (f.sketch) {
      const dims2 = (f.sketch.dimensions ?? []).map((d) => `${ident(d.id)} ${num(d.measured)}${d.driving ? "" : " (reference)"}`);
      lines.push(`sketch: ${f.sketch.mode}${f.sketch.status ? `, ${f.sketch.status}` : ""}${f.sketch.dof !== undefined && f.sketch.dof !== null ? `, ${f.sketch.dof} DOF` : ""}${dims2.length ? `; dimensions ${capList(dims2, 12, (x) => x).join(", ")}` : ""}`);
    }
    for (const h of (f.holes ?? []).slice(0, 12)) {
      lines.push(`  hole ${ident(h.at)}: Ø${num(h.d)} ${h.depth === null ? "through" : `depth ${num(h.depth)}`} ${h.kind}${h.size ? ` ${h.size}` : ""} at ${vec(h.center)} axis ${vec(h.axis)}${h.cbore ? `, cbore Ø${num(h.cbore.d)}×${num(h.cbore.depth)}` : ""}${h.csink ? `, csink Ø${num(h.csink.d)} ${num(h.csink.angle)}°` : ""}${h.thread ? `, ${h.thread.modeled ? "modelled " : ""}thread ${h.thread.standard ?? ""}${h.thread.standard ? " " : ""}P${num(h.thread.pitch)}` : ""}`);
    }
    if ((f.holes?.length ?? 0) > 12) lines.push(`  … ${f.holes!.length - 12} more holes`);
    if (f.thread) {
      const t = f.thread;
      lines.push(
        `thread: ${t.modeled ? "modelled" : "cosmetic"} ${t.kind} ${t.standard ?? `D${num(t.major)}×P${num(t.pitch)}`} on ${ident(t.face)}: major Ø${num(t.major)}, minor Ø${num(t.minor)}, crest Ø${num(t.crest_d)}, length ${num(t.length)}${t.offset ? ` from ${num(t.offset)}` : ""}${t.starts > 1 ? `, ${t.starts} starts` : ""}${t.hand === "left" ? ", left hand" : ""}`,
      );
    }
    const blend = f.fillet ?? f.chamfer;
    if (blend) lines.push(`${f.fillet ? "fillet" : "chamfer"}: ${plural(blend.edges.length, "edge")}${blend.chain_added?.length ? ` (${blend.chain_added.length} added by tangent chain)` : ""}, ${plural(blend.faces_created.length, "face")} created`);
    for (const r of f.refs ?? []) {
      lines.push(`ref ${r.field}: ${r.status}${r.code ? ` ${ident(r.code)}` : ""}, ${plural(r.members.length, "member")}${r.members.length ? `: ${capList(r.members, 6, (m) => `${displayName(m.name)} (${probeText(m.probe)})`).join("; ")}` : ""}`);
    }
    const bodies = f.bodies ?? [];
    const pick = options.body === undefined ? bodies.map((b, i) => ({ b, i })) : bodies[options.body] ? [{ b: bodies[options.body]!, i: options.body }] : [];
    if (options.body !== undefined && pick.length === 0) lines.push(`no body #${options.body} (this feature created or modified ${bodies.length})`);
    for (const { b, i } of pick.slice(0, 6)) {
      lines.push(`body ${i}:`);
      for (const l of bodyDetail(b, view)) lines.push(`  ${l}`);
    }
    if (pick.length > 6) lines.push(`… ${pick.length - 6} more bodies (pass body: N)`);
    return clip(lines.join("\n"));
  }
  for (const f of report.features) {
    if (f.status !== "ok") lines.push(`✗ ${ident(f.feature)} (${ident(f.type)}): ${ident(f.error?.code ?? "ERROR")}`);
    else lines.push(`${ident(f.feature)} (${ident(f.type)}): ${featureResultTextV1(f)}`);
  }
  for (const p of report.params ?? []) if (p.error) lines.push(`✗ parameter ${ident(p.name)}: ${ident(p.error.code)}`);
  if (report.error) lines.push(`document rejected: ${ident(report.error.code)}: ${oneLine(report.error.message)}`);
  for (const part of report.parts ?? []) {
    lines.push(`final bodies of ${quoteText(part.part, 80)}: ${part.bodies.length === 0 ? "none" : ""}`);
    part.bodies.slice(0, 6).forEach((b, i) => lines.push(`  ${i}: ${bodyTextV1(b)} (from ${ident(featureName(view, b.origin.feature))})`));
    if (part.bodies.length > 6) lines.push(`  … ${part.bodies.length - 6} more`);
  }
  lines.push(`model: ${totalsTextV1(modelTotalsV1(report))}`);
  return clip(lines.join("\n"), undefined, "pass feature: <name> for one feature");
}
