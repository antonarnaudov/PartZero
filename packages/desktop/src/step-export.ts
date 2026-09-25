/**
 * STEP export over the bundled Forge CLI (IO stream): `aicad export --format step` writes the exact
 * B-rep of the evaluated bodies with forge-io's own AP214/AP242 writer (no third-party kernel or
 * translator), and `--summary` records, per body, Forge's metrics next to what the writer produced.
 *
 * The renderer reaches it through `forge:exportStep` (`window.aicad.forge.exportStep`): like the mesh
 * export, the main process owns the temp directory and the argument list (no shell, no user paths on
 * the command line); the renderer gets the bytes back and writes them where the user picked with the
 * usual save dialog grant.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ForgeStepExportRequest, ForgeStepExportResponse, StepSchema } from "@aicad/app/bridge";
import { forgeInfo, run, withTempDoc } from "./forge-cli.js";

export const STEP_SCHEMAS: readonly StepSchema[] = ["ap214", "ap242"];

/** The flags of `aicad export` a STEP export needs; an `aicad` built before STEP export rejects them. */
export const STEP_EXPORT_FLAGS = ["--format", "--step-schema", "--title", "--summary"] as const;

const MAX_IR_BYTES = 32 * 1024 * 1024;

/** Product names on the command line: no control characters, bounded, never empty. */
function productArg(s: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
  return clean.length > 0 ? clean : "part";
}

/** Validate an IPC request (it comes from the renderer). Throws on anything malformed. */
export function validateStepRequest(req: unknown): Required<ForgeStepExportRequest> {
  const r = (typeof req === "object" && req !== null ? req : {}) as Partial<ForgeStepExportRequest>;
  if (typeof r.irJson !== "string" || r.irJson.length === 0 || r.irJson.length > MAX_IR_BYTES) {
    throw new Error("invalid IR document");
  }
  const schema = r.schema ?? "ap214";
  if (!STEP_SCHEMAS.includes(schema)) throw new Error("invalid STEP schema");
  if (r.productName !== undefined && typeof r.productName !== "string") throw new Error("invalid product name");
  return {
    irJson: r.irJson,
    schema,
    productName: productArg(r.productName ?? "part"),
    allowPartial: r.allowPartial === true,
  };
}

/** Run `aicad export --format step` on a validated request. */
export async function forgeStepExport(
  bin: string,
  req: Required<ForgeStepExportRequest>,
  timeoutMs = 300_000,
): Promise<ForgeStepExportResponse> {
  return withTempDoc(req.irJson, async (dir, docPath) => {
    const out = join(dir, "export.step");
    const summaryPath = join(dir, "summary.json");
    const args = [
      "export",
      docPath,
      "--out",
      out,
      "--format",
      "step",
      "--step-schema",
      req.schema,
      `--title=${req.productName}`,
      `--summary=${summaryPath}`,
      ...(req.allowPartial ? ["--allow-partial"] : []),
    ];
    const r = await run(bin, args, timeoutMs);
    let data: Uint8Array | null = null;
    if (r.code === 0) {
      try {
        data = new Uint8Array(await readFile(out));
      } catch {
        data = null;
      }
    }
    let summary: unknown = null;
    try {
      summary = JSON.parse(await readFile(summaryPath, "utf8"));
    } catch {
      summary = null;
    }
    return { data, summary, exitCode: r.code, stderr: r.stderr.trim(), ...(r.error ? { error: r.error } : {}) };
  });
}

/** The `forge:exportStep` IPC handler body: validate, check the binary, export. */
export async function handleStepExport(bin: string, req: unknown): Promise<ForgeStepExportResponse> {
  const request = validateStepRequest(req);
  const info = await forgeInfo(bin);
  if (!info.available) return { data: null, summary: null, exitCode: null, stderr: "", error: info.detail };
  return forgeStepExport(bin, request);
}
