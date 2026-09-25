/**
 * STEP export: the hook the export dialog (documents stream) calls, over the host's Forge CLI
 * (`window.aicad.forge.exportStep` → `aicad export --format step`, forge-io's own AP214/AP242
 * writer: exact B-rep, millimetres, one named solid per body, deterministic bytes).
 *
 * ```ts
 * const r = await exportStepFile(ctx.host, { irJson, docName: state.name, schema: "ap214" });
 * if (r.exported) ctx.ui.toast("success", `Exported ${baseName(r.path)} (${r.bodies} bodies)`);
 * ```
 *
 * It picks the path with the host's save dialog (unless `path` is given), runs the export, writes
 * the bytes, and returns what was written. Failures are {@link StepExportError}s with a stable
 * `code`: `STEP_UNAVAILABLE` (no host CLI: the browser build, until the WASM binding lands),
 * `FORGE_OUTDATED` (an `aicad` older than STEP export), a writer refusal (`STEP_UNSUPPORTED_SEAM`,
 * `STEP_UNSUPPORTED_TOPOLOGY`, `STEP_SELF_CHECK`, …), `EXPORT_FEATURES_FAILED` (features failed and
 * `allowPartial` was not set), `EXPORT_NO_BODIES`, or `EXPORT_FAILED`.
 */
import type { FileFilter, ForgeStepExportResponse, StepSchema } from "../bridge";
import type { ExportFormat } from "../file/export-formats";
import type { AppHost } from "../host/host";

/** The save dialog filter for STEP files. */
export const STEP_FILE_FILTER: FileFilter = { name: "STEP", extensions: ["step", "stp"] };

export type StepExportErrorCode =
  | "STEP_UNAVAILABLE"
  | "FORGE_OUTDATED"
  | "EXPORT_FEATURES_FAILED"
  | "EXPORT_NO_BODIES"
  | "EXPORT_FAILED"
  | `STEP_${string}`;

export class StepExportError extends Error {
  readonly code: StepExportErrorCode;
  constructor(code: StepExportErrorCode, message: string) {
    super(message);
    this.name = "StepExportError";
    this.code = code;
  }
}

/** What one body became (from the `aicad.export/1` summary). */
export interface StepExportBody {
  name: string;
  /** Forge's own measurements of the body. */
  forge: { volume: number; area: number; faces: number; edges: number; vertices: number };
  /** What the writer produced: solids, faces, edges (with synthesized seams and split pieces), vertices. */
  step: {
    solids: number;
    voids: number;
    faces: number;
    edges: number;
    vertices: number;
    seamEdges: number;
    splitPieces: number;
    newVertices: number;
  } | null;
}

export interface StepExportArgs {
  /** The compiled IR of the document (JSON). */
  irJson: string;
  /** The document name: the suggested file name and the STEP product name. */
  docName: string;
  /** Default `ap214`. */
  schema?: StepSchema;
  /** Write here instead of asking (e.g. a command invoked with a path). */
  path?: string;
  /** Export the bodies that evaluated even when some features failed. */
  allowPartial?: boolean;
}

export type StepExportResult =
  | { exported: false }
  | { exported: true; path: string; bytes: number; schema: StepSchema; bodies: StepExportBody[] };

type StepHost = Pick<AppHost, "pickSavePath" | "writeFile" | "forgeCli">;

/** Whether this host can export STEP (a desktop shell new enough to have the channel). */
export function stepExportAvailable(host: Pick<AppHost, "forgeCli">): boolean {
  return typeof host.forgeCli?.exportStep === "function";
}

/** The suggested file name for a document: its name with unsafe characters replaced, `.step`. */
export function stepFileName(docName: string): string {
  // eslint-disable-next-line no-control-regex
  const base = docName.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_").trim() || "part";
  return `${base}.step`;
}

/** Export the document's bodies as STEP (see the module docs). */
export async function exportStepFile(host: StepHost, args: StepExportArgs): Promise<StepExportResult> {
  const cli = host.forgeCli;
  if (!cli || typeof cli.exportStep !== "function") {
    throw new StepExportError(
      "STEP_UNAVAILABLE",
      "STEP export needs the desktop app's Forge engine; this build has none.",
    );
  }
  const schema = args.schema ?? "ap214";
  const target =
    args.path ??
    (await host.pickSavePath({
      title: "Export STEP",
      defaultPath: stepFileName(args.docName),
      filters: [STEP_FILE_FILTER],
    }));
  if (!target) return { exported: false };
  const res = await cli.exportStep({
    irJson: args.irJson,
    schema,
    productName: args.docName,
    allowPartial: args.allowPartial === true,
  });
  if (res.data === null || res.exitCode !== 0) throw classifyFailure(res);
  await host.writeFile(target, res.data);
  return { exported: true, path: target, bytes: res.data.length, schema, bodies: summaryBodies(res.summary) };
}

function summaryBodies(summary: unknown): StepExportBody[] {
  if (typeof summary !== "object" || summary === null) return [];
  const bodies = (summary as { bodies?: unknown }).bodies;
  return Array.isArray(bodies) ? (bodies as StepExportBody[]) : [];
}

/** Turn a failed `forge:exportStep` response into a coded error. */
export function classifyFailure(res: ForgeStepExportResponse): StepExportError {
  if (res.error) return new StepExportError("EXPORT_FAILED", res.error);
  const summaryError = (res.summary as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (summaryError && typeof summaryError.code === "string") {
    return new StepExportError(
      summaryError.code as StepExportErrorCode,
      typeof summaryError.message === "string" ? summaryError.message : summaryError.code,
    );
  }
  const lines = res.stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // clap refusing a flag or the `step` value: an aicad built before STEP export.
  if (res.exitCode === 2 && /unexpected argument '--step-schema'|invalid value 'step'/.test(res.stderr)) {
    return new StepExportError(
      "FORGE_OUTDATED",
      "The Forge CLI is older than STEP export; rebuild it with `cargo build -p forge-cli` in forge/.",
    );
  }
  const coded = lines.map((l) => /^aicad: (STEP_[A-Z_]+): (.*)$/.exec(l)).find((m) => m !== null);
  if (coded) return new StepExportError(coded[1] as StepExportErrorCode, coded[2] ?? coded[1]!);
  if (res.exitCode === 1) {
    const noBodies = lines.some((l) => l.includes("produced no bodies"));
    return new StepExportError(
      noBodies ? "EXPORT_NO_BODIES" : "EXPORT_FEATURES_FAILED",
      lines.filter((l) => l.startsWith("aicad:")).join("\n") || "features failed",
    );
  }
  const line = lines.find((l) => /^(error|aicad):/i.test(l)) ?? lines.at(-1);
  return new StepExportError("EXPORT_FAILED", (line ?? `exit code ${String(res.exitCode)}`).slice(0, 500));
}

/**
 * STEP in the export dialog (File → Export…, `file.export { format: "step" }`): the same export
 * as {@link exportStepFile} (AP214), with the document layer choosing the path and writing the
 * bytes. It replaces the documents stream's placeholder (`registerExportFormat` in main.tsx).
 */
export function stepExportFormat(host: Pick<AppHost, "forgeCli">): ExportFormat {
  return {
    id: "step",
    label: "STEP",
    extensions: ["step", "stp"],
    description: "Exact B-rep (AP214) for other CAD programs, written and checked by Forge.",
    available: () =>
      stepExportAvailable(host) ? { ok: true } : { ok: false, reason: "STEP export needs the desktop app's Forge engine; this build has none." },
    async run({ irJson, name }) {
      const cli = host.forgeCli;
      if (!cli || typeof cli.exportStep !== "function") {
        throw new StepExportError("STEP_UNAVAILABLE", "STEP export needs the desktop app's Forge engine; this build has none.");
      }
      const res = await cli.exportStep({ irJson, schema: "ap214", productName: name, allowPartial: false });
      if (res.data === null || res.exitCode !== 0) {
        const e = classifyFailure(res);
        throw new StepExportError(e.code, `${e.message} (${e.code})`);
      }
      return res.data;
    },
  };
}
