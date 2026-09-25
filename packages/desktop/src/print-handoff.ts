/**
 * "Open in Bambu Studio" (ALPHA-0-PLAN W5, §1.1 step 8; ADR 0016): export the current design for
 * the active printer profile into `~/PartZero/Prints`, with a receipt beside it, then hand the file
 * to the user's own Bambu Studio.
 *
 * 1. **Check.** `aicad eval` must report the design `ok` with every body valid; nothing unchecked
 *    is exported (NORTH-STAR §2, ALPHA-0-PLAN W8 "Export gate").
 * 2. **Export.** `aicad export --bed …` tessellates for printing (the profile's 0.01 mm / 5°),
 *    refuses a design that does not fit the bed less the margin (`EXPORT_BED_FIT`, nothing
 *    written), and centres the build on the bed with z-min = 0 through the 3MF build-item
 *    transform. `Title` is the document name, `Application` is `PartZero <version>`.
 *    Its summary must then confirm what the receipt claims, or nothing is saved: as many bodies as
 *    Forge checked, every mesh watertight (`EXPORT_NOT_WATERTIGHT`), a recorded placement, and no
 *    bodies stacked above each other (`EXPORT_BODIES_OVERLAP`: the slicer drops each object onto
 *    the plate, so they would print inside each other). A body that merely starts above the bed
 *    is a warning (`EXPORT_BODY_FLOATING`), shown and kept in the receipt.
 * 3. **Save.** `<doc>-<hash8>.3mf`, where hash8 starts the SHA-256 of the 3MF bytes: the same
 *    design, document name and app version give the same file and name, and a changed design never
 *    overwrites the last. `<doc>-<hash8>.receipt.json`: what PartZero checked, against which
 *    profile, with the file's SHA-256 (integrity) and Forge's geometry hash (the determinism hash:
 *    it ignores `Title` and `Application`, so it survives a rename or an app upgrade). Both are
 *    written atomically. The folder is created on first use; there is no dialog (ALPHA-0-PLAN D4).
 * 4. **Hand off.** The slicer is found and launched by `slicer.ts`. When it is missing or does not
 *    start, the export still stands and the result says so (the UI offers Show in Finder).
 *
 * **STEP instead of 3MF** (`format: "step"`, the owner's choice of "3MF print-ready or STEP
 * exact"): steps 1–2 run exactly as above on the print meshes, so a design that does not fit, leaks
 * or stacks is refused the same way; the file saved and handed over is then `aicad export --format
 * step` (AP214, the exact B-rep), `<doc>-<hash8>.step`, and the receipt says `format: "step"` with
 * no tessellation or placement: Bambu Studio 02.06 tessellates STEP itself (its STEP import
 * precision dialog) and places the part on the plate.
 *
 * The receipt never contains the slicer's output: downstream results are advisory (ADR 0016 §2).
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { OpenInSlicerRequest, OpenInSlicerResult, PrintWarning, SlicerFormat, SlicerInfo } from "@aicad/app/bridge";
import { forgeEval, forgeFailure, forgeInfo, forgePrintExport } from "./forge-cli.js";
import { type MachineProfile, type MaterialProfile, type ProfileStore, writeFileAtomic } from "./profiles.js";
import { detectSlicer, openInSlicer, type SlicerSystem } from "./slicer.js";
import { forgeStepExport } from "./step-export.js";
import { ensureUserFolder } from "./user-folders.js";

export const RECEIPT_SCHEMA = "partzero.receipt/1";
export const PRODUCT_NAME = "PartZero";
const MAX_IR_BYTES = 32 * 1024 * 1024;

export interface PrintHandoffDeps {
  /** The `aicad` binary. */
  forgeBin: string;
  /** `~/PartZero/Prints`. */
  printsDir: string;
  /** The app version for `Application = PartZero <version>` and the receipt. */
  appVersion: string;
  profiles: ProfileStore;
  slicer: SlicerSystem;
  now?: () => Date;
}

/** `knob`, `T1 NEMA17 plate` → `knob`, `t1-nema17-plate`: safe, short, never empty. */
export function printFileStem(docName: string): string {
  const s = docName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 48)
    .replace(/[-._]+$/g, "");
  return s || "part";
}

interface BodyCheck {
  valid: boolean;
}

/** Status and per-body validity of an `aicad.metrics/0` or `/1` report. */
export function reportChecks(reportJson: string | null): { status: string; bodies: BodyCheck[]; firstError: string | null } | null {
  if (!reportJson) return null;
  let r: {
    schema?: unknown;
    status?: unknown;
    error?: { code?: string; message?: string } | null;
    features?: Array<{ bodies?: BodyCheck[]; error?: { code?: string; message?: string } | null; feature?: string }>;
    parts?: Array<{ bodies?: BodyCheck[] }>;
  };
  try {
    r = JSON.parse(reportJson) as typeof r;
  } catch {
    return null;
  }
  if (typeof r !== "object" || r === null || typeof r.status !== "string") return null;
  const failed = r.error ?? r.features?.find((f) => f.error)?.error ?? null;
  const firstError = failed ? `${failed.code ?? "ERROR"}: ${failed.message ?? ""}`.trim() : null;
  const bodies =
    r.schema === "aicad.metrics/1" ? (r.parts ?? []).flatMap((p) => p.bodies ?? []) : (r.features ?? []).flatMap((f) => f.bodies ?? []);
  return { status: r.status, bodies, firstError };
}

interface Summary {
  status?: string;
  error?: { code?: string; message?: string; details?: unknown } | null;
  bodies?: Array<{ name?: string; watertight?: boolean; triangles?: number }>;
  watertight?: boolean;
  bbox?: unknown;
  placement?: { translation?: number[]; bbox?: unknown } | null;
  engine?: string;
  tessellation?: unknown;
  /** `fnv1a64:<hex>` over the geometry and placement, without the metadata. */
  geometryHash?: string | null;
  warnings?: Array<{ code?: unknown; message?: unknown; details?: unknown }>;
}

/** The summary's layout warnings, as the bridge carries them. */
function summaryWarnings(summary: Summary): PrintWarning[] {
  return (Array.isArray(summary.warnings) ? summary.warnings : [])
    .filter((w) => typeof w === "object" && w !== null && typeof w.code === "string")
    .map((w) => ({ code: String(w.code), message: typeof w.message === "string" ? w.message : String(w.code), ...(w.details !== undefined ? { details: w.details } : {}) }));
}

type Refusal = Extract<OpenInSlicerResult, { status: "refused" }>;

/**
 * What the export summary must confirm before the file is saved: the receipt states these, so
 * they are checked rather than assumed (NORTH-STAR "never silently wrong").
 */
function confirmSummary(summary: Summary | null, checkedBodies: number): Refusal | null {
  const refuse = (code: Refusal["code"], message: string, details?: unknown): Refusal => ({ status: "refused", code, message, ...(details !== undefined ? { details } : {}) });
  if (!summary || typeof summary !== "object" || !Array.isArray(summary.bodies)) {
    return refuse("EXPORT_FAILED", "Not saved: Forge wrote the 3MF but no readable export summary, so its bodies, watertightness and placement can't be confirmed.");
  }
  if (summary.bodies.length !== checkedBodies) {
    return refuse("EXPORT_FAILED", `Not saved: Forge checked ${checkedBodies} bod${checkedBodies === 1 ? "y" : "ies"} but exported ${summary.bodies.length}.`);
  }
  const leaky = summary.bodies.filter((b) => b.watertight !== true);
  if (summary.watertight !== true || leaky.length > 0) {
    const names = leaky.map((b) => `"${b.name ?? "?"}"`).join(", ") || "a body";
    return refuse(
      "EXPORT_NOT_WATERTIGHT",
      `Not saved: the print mesh of ${names} is not watertight, so a slicer could print it wrong. This is a Forge problem, not your design.`,
      { bodies: leaky.map((b) => b.name ?? null) },
    );
  }
  const t = summary.placement?.translation;
  if (!Array.isArray(t) || t.length !== 3 || !t.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return refuse("EXPORT_FAILED", "Not saved: Forge did not record where it placed the part on the bed.");
  }
  const stacked = summaryWarnings(summary).filter((w) => w.code === "EXPORT_BODIES_OVERLAP");
  if (stacked.length > 0) {
    return refuse(
      "EXPORT_BODIES_OVERLAP",
      `Not sent to Bambu Studio: ${stacked[0]!.message}. Lay the bodies out side by side, each in its print orientation (Export 3MF still writes the file as modelled).`,
      stacked.map((w) => w.details),
    );
  }
  return null;
}

function receipt(o: {
  file: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  appVersion: string;
  docName: string;
  printer: MachineProfile;
  material: MaterialProfile;
  reportStatus: string;
  valid: boolean;
  summary: Summary;
  warnings: PrintWarning[];
  format: SlicerFormat;
}): unknown {
  const p = o.printer;
  const m = o.material;
  const step = o.format === "step";
  return {
    schema: RECEIPT_SCHEMA,
    file: o.file,
    /** `3mf`: print meshes placed on the bed; `step`: the exact B-rep, tessellated and placed by the slicer. */
    format: o.format,
    /** The file's bytes (integrity). They include the document name and app version. */
    sha256: o.sha256,
    /** Forge's hash of the geometry and placement without the metadata (the determinism hash). */
    geometryHash: o.summary.geometryHash ?? null,
    bytes: o.bytes,
    createdAt: o.createdAt,
    app: { name: PRODUCT_NAME, version: o.appVersion },
    forge: { engine: o.summary.engine ?? null },
    document: { name: o.docName },
    printer: {
      id: p.id,
      version: p.version,
      name: p.name,
      bed: p.bed,
      bedMargin: p.bedMargin,
      nozzle: p.nozzle,
      exclusionZones: p.exclusionZones,
      unverified: p.unverified,
    },
    material: {
      id: m.id,
      version: m.version,
      name: m.name,
      clearances: m.clearances,
      clearanceSource: m.clearanceSource,
      minWall: m.minWall,
      maxOverhangDeg: m.maxOverhangDeg,
      unverified: m.unverified,
    },
    checks: {
      report: o.reportStatus,
      valid: o.valid,
      watertight: o.summary.watertight === true,
      bodies: o.summary.bodies?.length ?? 0,
      bedFit: { ok: true, usable: [p.bed.x - 2 * p.bedMargin, p.bed.y - 2 * p.bedMargin, p.bed.z] },
      layoutWarnings: o.warnings,
    },
    // A STEP file is exact geometry: the slicer tessellates it and places it on the plate.
    tessellation: step ? null : (o.summary.tessellation ?? null),
    bbox: { model: o.summary.bbox ?? null, onBed: step ? null : (o.summary.placement?.bbox ?? null) },
    placement: { translation: step ? null : (o.summary.placement?.translation ?? null) },
    note: step
      ? "What PartZero checked against this printer profile, on print meshes at the profile's tessellation. The file is the exact geometry (STEP AP214): Bambu Studio tessellates it with its own import precision and places it on the plate. The slicer's own results are not part of this receipt (ADR 0016)."
      : "What PartZero checked against this printer profile. The slicer's own results are not part of this receipt (ADR 0016).",
  };
}

type Written = { file: string; receipt: string; bodies: number; bytes: number; warnings: PrintWarning[]; format: SlicerFormat };

/** Steps 1–3: check, export and save. */
export async function exportForPrinter(deps: PrintHandoffDeps, req: OpenInSlicerRequest): Promise<Written | Refusal> {
  if (typeof req.irJson !== "string" || req.irJson.length === 0 || req.irJson.length > MAX_IR_BYTES) throw new Error("invalid IR document");
  const docName = typeof req.docName === "string" ? req.docName.slice(0, 200) : "";
  const info = await forgeInfo(deps.forgeBin);
  if (!info.available) return { status: "refused", code: "FORGE_UNAVAILABLE", message: info.detail };
  if (req.format !== undefined && req.format !== "3mf" && req.format !== "step") throw new Error("invalid slicer format");
  const format: SlicerFormat = req.format ?? "3mf";
  const printer = deps.profiles.printer();
  const material = deps.profiles.material();
  // STEP: the same checks run on the print meshes (validity, bed fit, watertight, layout); the file is the exact B-rep.
  const stepRun =
    format === "step" ? forgeStepExport(deps.forgeBin, { irJson: req.irJson, schema: "ap214", productName: docName.trim() || "part", allowPartial: false }) : Promise.resolve(null);
  const [ev, ex, stepOut] = await Promise.all([
    forgeEval(deps.forgeBin, { irJson: req.irJson, meshes: false }),
    forgePrintExport(deps.forgeBin, {
      irJson: req.irJson,
      bed: [printer.bed.x, printer.bed.y, printer.bed.z],
      margin: printer.bedMargin,
      exclusions: printer.exclusionZones.map((z) => [z.x0, z.y0, z.x1, z.y1] as const),
      deflection: printer.printTessellation.deflection,
      angular: printer.printTessellation.angular,
      title: docName || "part",
      application: `${PRODUCT_NAME} ${deps.appVersion}`,
    }),
    stepRun,
  ]);
  const checks = reportChecks(ev.reportJson);
  if (!checks) {
    return { status: "refused", code: "EXPORT_FAILED", message: `Forge could not check the design: ${ev.error ?? (ev.stderr || "no report")}` };
  }
  const valid = checks.bodies.length > 0 && checks.bodies.every((b) => b.valid === true);
  if (checks.status !== "ok" || !valid) {
    const why = checks.firstError ?? (checks.bodies.length === 0 ? "the design has no bodies" : "a body is not a valid solid");
    return { status: "refused", code: "EXPORT_NOT_VALID", message: `Not exported: Forge's check did not pass (${why}). Fix the design first.` };
  }
  const summary = (ex.summary ?? {}) as Summary;
  if (ex.exitCode === 4 || summary.error?.code === "EXPORT_BED_FIT") {
    return {
      status: "refused",
      code: "EXPORT_BED_FIT",
      message: `It doesn't fit the ${printer.name}: ${summary.error?.message ?? "the part is larger than the bed"}.`,
      details: summary.error?.details,
    };
  }
  if (ex.exitCode !== 0 || !ex.data) {
    const f = forgeFailure(ex, deps.forgeBin);
    return { status: "refused", code: f.code, message: f.code === "FORGE_OUTDATED" ? f.message : `The export failed: ${f.message}` };
  }
  const unconfirmed = confirmSummary(ex.summary as Summary | null, checks.bodies.length);
  if (unconfirmed) return unconfirmed;
  const warnings = summaryWarnings(summary);
  let data: Uint8Array = ex.data;
  if (format === "step") {
    if (!stepOut || stepOut.exitCode !== 0 || !stepOut.data) {
      const f = forgeFailure(stepOut ?? { exitCode: null, stderr: "" }, deps.forgeBin);
      return { status: "refused", code: f.code, message: f.code === "FORGE_OUTDATED" ? f.message : `The STEP export failed: ${f.message}` };
    }
    data = stepOut.data;
  }
  const ext = format === "step" ? "step" : "3mf";
  const sha256 = createHash("sha256").update(data).digest("hex");
  const stem = `${printFileStem(docName)}-${sha256.slice(0, 8)}`;
  // Created on first use (ALPHA-0-PLAN D4), with `~/PartZero` itself; a Prints (or PartZero) that is a symlink or a
  // file is refused rather than written through (user-folders.ts).
  try {
    ensureUserFolder(deps.printsDir, dirname(deps.printsDir));
  } catch (e) {
    return { status: "refused", code: "EXPORT_FAILED", message: `Not saved: ${e instanceof Error ? e.message : String(e)}.` };
  }
  const file = join(deps.printsDir, `${stem}.${ext}`);
  const receiptPath = join(deps.printsDir, `${stem}.receipt.json`);
  writeFileAtomic(file, data);
  const r = receipt({
    file: `${stem}.${ext}`,
    format,
    sha256,
    bytes: data.byteLength,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    appVersion: deps.appVersion,
    docName,
    printer,
    material,
    reportStatus: checks.status,
    valid,
    summary,
    warnings,
  });
  writeFileAtomic(receiptPath, `${JSON.stringify(r, null, 2)}\n`);
  return { file, receipt: receiptPath, bodies: summary.bodies?.length ?? 0, bytes: data.byteLength, warnings, format };
}

/** The slicer as currently configured (the Settings path, else the search). */
export function currentSlicer(deps: Pick<PrintHandoffDeps, "profiles" | "slicer">): Promise<SlicerInfo> {
  return detectSlicer(deps.slicer, deps.profiles.read().slicerPath);
}

/** Steps 1–4: `slicer:open`. */
export async function openPrintInSlicer(deps: PrintHandoffDeps, req: OpenInSlicerRequest): Promise<OpenInSlicerResult> {
  const written = await exportForPrinter(deps, req);
  if ("status" in written) return written;
  const slicer = await currentSlicer(deps);
  if (!slicer.found) {
    return {
      status: "exported",
      ...written,
      slicer,
      message: `Saved to ${deps.printsDir}. ${slicer.reason ?? "Bambu Studio was not found."}`,
      ...(slicer.fix ? { fix: slicer.fix } : {}),
    };
  }
  const opened = await openInSlicer(deps.slicer, slicer, written.file, deps.printsDir);
  if (!opened.ok) {
    return { status: "exported", ...written, slicer, message: `Saved to ${deps.printsDir}. ${opened.message}`, fix: "Open the file in Bambu Studio yourself (Show in Finder)." };
  }
  return { status: "opened", ...written, slicer, alreadyRunning: opened.alreadyRunning };
}
