/**
 * Inspect tools that read Forge's report (never the display mesh): body properties and the printer
 * fit. Both are read-only panels; their numbers are Forge's exact-geometry metrics
 * (`aicad.metrics/0` feature bodies, or `aicad.metrics/1` final part bodies).
 */
import type { AppServices } from "../../services";
import { formatNumber } from "../framework/expr";
import type { PanelSpec, PreviewOutcome, SelectionItem, SummaryRow, ToolContext, ToolDefinition } from "../framework/types";
import type { ToolRegistry } from "../registry";

type Vec3 = readonly [number, number, number];

export interface ReportBody {
  /** Stable key for the chooser. */
  key: string;
  /** Shown to the user, e.g. `box / shell` or `plate/plate`. */
  label: string;
  part: string;
  /** The render body name, when known (`part/feature`, v0). */
  renderName: string | null;
  volume: number;
  area: number;
  centroid: Vec3;
  bboxMin: Vec3;
  bboxMax: Vec3;
  faces: number;
  edges: number;
  valid: boolean;
}

function vec3(v: unknown): Vec3 | null {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? [v[0], v[1], v[2]] : null;
}

function bodyOf(raw: unknown, key: string, label: string, part: string, renderName: string | null): ReportBody | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const bboxMin = vec3(b["bbox_min"]);
  const bboxMax = vec3(b["bbox_max"]);
  const centroid = vec3(b["centroid"]);
  if (typeof b["volume"] !== "number" || typeof b["area"] !== "number" || !bboxMin || !bboxMax || !centroid) return null;
  return {
    key,
    label,
    part,
    renderName,
    volume: b["volume"],
    area: b["area"],
    centroid,
    bboxMin,
    bboxMax,
    faces: typeof b["faces"] === "number" ? b["faces"] : 0,
    edges: typeof b["edges"] === "number" ? b["edges"] : 0,
    valid: b["valid"] === true,
  };
}

/**
 * The bodies a report describes as the document's result: `parts[].bodies` of an
 * `aicad.metrics/1` report (the final bodies after booleans), else every feature's bodies
 * (`aicad.metrics/0`, where every extrude/revolve body is final).
 */
export function reportBodies(report: unknown): ReportBody[] {
  if (!report || typeof report !== "object") return [];
  const r = report as { parts?: unknown; features?: unknown };
  const out: ReportBody[] = [];
  if (Array.isArray(r.parts)) {
    for (const p of r.parts) {
      if (!p || typeof p !== "object") continue;
      const part = String((p as { part?: unknown }).part ?? "part");
      const bodies = (p as { bodies?: unknown }).bodies;
      if (!Array.isArray(bodies)) continue;
      bodies.forEach((b, i) => {
        const origin = (b as { origin?: { feature?: unknown; member?: unknown } }).origin;
        const label = bodies.length > 1 ? `${part} · body ${i + 1}` : part;
        const key = `${part}#${i}${origin?.feature ? `:${String(origin.feature)}` : ""}`;
        const body = bodyOf(b, key, label, part, null);
        if (body) out.push(body);
      });
    }
    return out;
  }
  if (Array.isArray(r.features)) {
    for (const f of r.features) {
      if (!f || typeof f !== "object") continue;
      const { part, feature, bodies } = f as { part?: unknown; feature?: unknown; bodies?: unknown };
      if (!Array.isArray(bodies)) continue;
      bodies.forEach((b, i) => {
        const name = `${String(part)}/${String(feature)}${bodies.length > 1 ? `#${i + 1}` : ""}`;
        const body = bodyOf(b, name, name, String(part), name);
        if (body) out.push(body);
      });
    }
  }
  return out;
}

function union(bodies: readonly ReportBody[]): { min: Vec3; max: Vec3 } | null {
  if (bodies.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, b.bboxMin[i]!);
      max[i] = Math.max(max[i]!, b.bboxMax[i]!);
    }
  }
  return { min, max };
}

const size = (box: { min: Vec3; max: Vec3 }): Vec3 => [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
const fmt3 = (v: Vec3, d = 2): string => v.map((x) => formatNumber(x, d)).join(" × ");

/** PLA's density, g/cm³ (a solid part; a print with infill weighs less). */
export const PLA_DENSITY = 1.24;

export function bodySummary(bodies: readonly ReportBody[]): SummaryRow[] {
  const box = union(bodies);
  if (!box) return [{ label: "Bodies", value: "none" }];
  const volume = bodies.reduce((s, b) => s + b.volume, 0);
  const area = bodies.reduce((s, b) => s + b.area, 0);
  const invalid = bodies.filter((b) => !b.valid).length;
  const rows: SummaryRow[] = [
    { label: bodies.length === 1 ? "Body" : "Bodies", value: bodies.length === 1 ? bodies[0]!.label : String(bodies.length) },
    { label: "Volume", value: `${formatNumber(volume, 2)} mm³ (${formatNumber(volume / 1000, 3)} cm³)` },
    { label: "Surface area", value: `${formatNumber(area, 2)} mm²` },
    { label: "Size (X × Y × Z)", value: `${fmt3(size(box))} mm` },
    { label: "From", value: `${fmt3(box.min)} mm` },
    { label: "To", value: `${fmt3(box.max)} mm` },
  ];
  if (bodies.length === 1) rows.push({ label: "Centre of mass", value: `${fmt3(bodies[0]!.centroid)} mm` });
  rows.push({ label: "Faces / edges", value: `${bodies.reduce((s, b) => s + b.faces, 0)} / ${bodies.reduce((s, b) => s + b.edges, 0)}` });
  rows.push({ label: "Solid PLA", value: `≈ ${formatNumber((volume / 1000) * PLA_DENSITY, 1)} g (no infill)` });
  rows.push(invalid === 0 ? { label: "Check", value: "Valid solid" + (bodies.length === 1 ? "" : "s"), tone: "ok" } : { label: "Check", value: `${invalid} invalid bod${invalid === 1 ? "y" : "ies"}`, tone: "error" });
  return rows;
}

/** The report body a selection item belongs to (v0 render body names; v1 by part). */
function bodyForSelection(bodies: readonly ReportBody[], items: readonly SelectionItem[]): ReportBody | null {
  for (const it of items) {
    const name = it.kind === "body" ? it.body : it.kind === "face" || it.kind === "edge" || it.kind === "vertex" ? (it.body ?? null) : null;
    if (name) {
      const exact = bodies.find((b) => b.renderName === name);
      if (exact) return exact;
    }
    if ((it.kind === "face" || it.kind === "edge" || it.kind === "vertex" || it.kind === "body") && bodies.filter((b) => b.part === it.part).length === 1) {
      return bodies.find((b) => b.part === it.part) ?? null;
    }
  }
  return null;
}

function currentBodies(services: AppServices): ReportBody[] {
  return reportBodies(services.doc.getState().report);
}

export const bodyPropertiesTool: ToolDefinition = {
  id: "inspect.bodyProperties",
  label: "Properties",
  group: "inspect",
  icon: "properties",
  shortcut: "Shift+I",
  description: "Volume, area, size, centre of mass and weight, from Forge's exact geometry",
  accepts: ["body", "face", "edge"],
  order: 20,
  enabledWhen: (ctx) => (currentBodies(ctx.services).length > 0 ? true : { reason: "There are no bodies yet: build or open a part first" }),
  activate(ctx: ToolContext): PanelSpec {
    const bodies = currentBodies(ctx.services);
    const picked = bodyForSelection(bodies, ctx.selection.items());
    return {
      title: "Body properties",
      description: "Exact values from Forge (not from the display mesh).",
      readOnly: true,
      fields: [
        {
          kind: "choice",
          key: "body",
          label: "Body",
          style: "dropdown",
          options: [{ value: "*", label: bodies.length === 1 ? `${bodies[0]!.label} (the only body)` : `All ${bodies.length} bodies` }, ...(bodies.length > 1 ? bodies.map((b) => ({ value: b.key, label: b.label })) : [])],
          default: picked && bodies.length > 1 ? picked.key : "*",
        },
      ],
      preview: (values): PreviewOutcome => {
        const all = currentBodies(ctx.services);
        const which = values["body"] === "*" ? all : all.filter((b) => b.key === values["body"]);
        if (which.length === 0) return { ok: false, errors: [{ code: "BODY_GONE", message: "That body no longer exists (the part changed)." }] };
        return { ok: true, summary: bodySummary(which) };
      },
    };
  },
};

export interface FitResult {
  fits: boolean;
  size: Vec3;
  usable: Vec3;
  /** Per axis: room left (≥ 0) or overhang (< 0), mm. */
  slack: Vec3;
  /** Bodies that start above the lowest one (the slicer drops them onto the plate). */
  floating: string[];
}

/** Whether the bodies fit a bed (less its margin on each side in X and Y) and its height. */
export function bedFit(bodies: readonly ReportBody[], bed: { x: number; y: number; z: number }, margin: number): FitResult | null {
  const box = union(bodies);
  if (!box) return null;
  const s = size(box);
  const usable: Vec3 = [bed.x - 2 * margin, bed.y - 2 * margin, bed.z];
  const slack: Vec3 = [usable[0] - s[0], usable[1] - s[1], usable[2] - s[2]];
  const floating = bodies.filter((b) => b.bboxMin[2] - box.min[2] > 1e-6).map((b) => b.label);
  return { fits: slack.every((x) => x >= -1e-9), size: s, usable, slack, floating };
}

export const bedFitTool: ToolDefinition = {
  id: "inspect.printerFit",
  label: "Printer fit",
  group: "inspect",
  icon: "bedFit",
  description: "Does the part fit your printer's bed? The same limits Open in Bambu Studio checks",
  order: 30,
  enabledWhen: (ctx) => {
    if (!ctx.services.host.print) return { reason: "Printer profiles are in the desktop app" };
    return currentBodies(ctx.services).length > 0 ? true : { reason: "There are no bodies yet: build or open a part first" };
  },
  activate(ctx: ToolContext): PanelSpec {
    const print = ctx.services.host.print;
    return {
      title: "Printer fit",
      description: "Open in Bambu Studio centres the part on the bed with its lowest point at z = 0.",
      readOnly: true,
      fields: [],
      preview: async (): Promise<PreviewOutcome> => {
        if (!print) return { ok: false, errors: [{ code: "NO_PRINTER", message: "Printer profiles are in the desktop app." }] };
        const profile = await print.profile();
        const fit = bedFit(currentBodies(ctx.services), profile.printer.bed, profile.printer.bedMargin);
        if (!fit) return { ok: false, errors: [{ code: "NO_BODIES", message: "There are no bodies to place." }] };
        const axis = ["X", "Y", "Z"] as const;
        const over = fit.slack.map((s, i) => (s < 0 ? `${formatNumber(-s, 1)} mm too ${i === 2 ? "tall" : "long"} in ${axis[i]}` : null)).filter(Boolean);
        const summary: SummaryRow[] = [
          { label: "Printer", value: profile.printer.name },
          { label: "Usable (X × Y × Z)", value: `${fmt3(fit.usable, 0)} mm (${formatNumber(profile.printer.bedMargin, 0)} mm kept free at the edges)` },
          { label: "Part (X × Y × Z)", value: `${fmt3(fit.size, 1)} mm` },
          fit.fits
            ? { label: "Fits", value: `Yes · room left ${fit.slack.map((s) => formatNumber(s, 0)).join(" / ")} mm`, tone: "ok" }
            : { label: "Fits", value: `No · ${over.join(", ")}`, tone: "error" },
          { label: "Material", value: profile.material.name },
        ];
        const warnings = fit.floating.length ? [`${fit.floating.join(", ")} start${fit.floating.length === 1 ? "s" : ""} above the bed: the slicer drops ${fit.floating.length === 1 ? "it" : "them"} onto the plate.`] : [];
        return { ok: true, summary, warnings };
      },
    };
  },
};

export function registerInspectTools(registry: ToolRegistry): void {
  registry.register(bodyPropertiesTool);
  registry.register(bedFitTool);
}
