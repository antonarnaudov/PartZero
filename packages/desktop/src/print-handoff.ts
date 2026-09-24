/**
 * "Open in Bambu Studio" (ALPHA-0-PLAN W5, §1.1 step 8; ADR 0016): export the current design for
 * the active printer profile into `~/PartZero/Prints`, with a receipt beside it, then hand the file
 * to the user's own Bambu Studio.
 *
 * 1. **Check.** `aicad eval` must report the design `ok` with every body valid; nothing unchecked
 *    is exported (NORTH-STAR §2, ALPHA-0-PLAN W8 "Export gate").
 * 2. **Export.** `aicad export --bed …` tessellates for printing (the profile's 0.01 mm / 0.1 rad),
 *    refuses a design that does not fit the bed less the margin (`EXPORT_BED_FIT`, nothing
 *    written), and centres the build on the bed with z-min = 0 through the 3MF build-item
 *    transform. `Title` is the document name, `Application` is `PartZero <version>`.
 * 3. **Save.** `<doc>-<hash8>.3mf`, where hash8 starts the SHA-256 of the 3MF bytes (the same design
 *    always gets the same name; a changed one never overwrites the last), and
 *    `<doc>-<hash8>.receipt.json`: what PartZero checked, against which profile. Both are written
 *    atomically. The folder is created on first use; there is no dialog (ALPHA-0-PLAN D4).
 * 4. **Hand off.** The slicer is found and launched by `slicer.ts`. When it is missing or does not
 *    start, the export still stands and the result says so (the UI offers Show in Finder).
 *
 * The receipt never contains the slicer's output: downstream results are advisory (ADR 0016 §2).
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OpenInSlicerRequest, OpenInSlicerResult, SlicerInfo } from "@aicad/app/bridge";
import { forgeEval, forgeInfo, forgePrintExport } from "./forge-cli.js";
import { type MachineProfile, type MaterialProfile, type ProfileStore, writeFileAtomic } from "./profiles.js";
import { detectSlicer, openInSlicer, type SlicerSystem } from "./slicer.js";

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
}): unknown {
  const p = o.printer;
  const m = o.material;
  return {
    schema: RECEIPT_SCHEMA,
    file: o.file,
    sha256: o.sha256,
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
    },
    tessellation: o.summary.tessellation ?? null,
    bbox: { model: o.summary.bbox ?? null, onBed: o.summary.placement?.bbox ?? null },
    placement: { translation: o.summary.placement?.translation ?? null },
    note: "What PartZero checked against this printer profile. The slicer's own results are not part of this receipt (ADR 0016).",
  };
}

type Written = { file: string; receipt: string; bodies: number; bytes: number };

/** Steps 1–3: check, export and save. */
export async function exportForPrinter(deps: PrintHandoffDeps, req: OpenInSlicerRequest): Promise<Written | Extract<OpenInSlicerResult, { status: "refused" }>> {
  if (typeof req.irJson !== "string" || req.irJson.length === 0 || req.irJson.length > MAX_IR_BYTES) throw new Error("invalid IR document");
  const docName = typeof req.docName === "string" ? req.docName.slice(0, 200) : "";
  const info = await forgeInfo(deps.forgeBin);
  if (!info.available) return { status: "refused", code: "FORGE_UNAVAILABLE", message: info.detail };
  const printer = deps.profiles.printer();
  const material = deps.profiles.material();
  const [ev, ex] = await Promise.all([
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
    return { status: "refused", code: "EXPORT_FAILED", message: `The export failed: ${ex.error ?? (ex.stderr.split("\n").pop() || `exit code ${String(ex.exitCode)}`)}` };
  }
  const sha256 = createHash("sha256").update(ex.data).digest("hex");
  const stem = `${printFileStem(docName)}-${sha256.slice(0, 8)}`;
  mkdirSync(deps.printsDir, { recursive: true });
  const file = join(deps.printsDir, `${stem}.3mf`);
  const receiptPath = join(deps.printsDir, `${stem}.receipt.json`);
  writeFileAtomic(file, ex.data);
  const r = receipt({
    file: `${stem}.3mf`,
    sha256,
    bytes: ex.data.byteLength,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    appVersion: deps.appVersion,
    docName,
    printer,
    material,
    reportStatus: checks.status,
    valid,
    summary,
  });
  writeFileAtomic(receiptPath, `${JSON.stringify(r, null, 2)}\n`);
  return { file, receipt: receiptPath, bodies: summary.bodies?.length ?? 0, bytes: ex.data.byteLength };
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
  return { status: "opened", ...written, slicer };
}
