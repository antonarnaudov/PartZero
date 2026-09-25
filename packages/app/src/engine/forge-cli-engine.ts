/**
 * `ForgeCliEngine`: the native `aicad` binary, run by the desktop main process over IPC.
 *
 * `evaluate` runs `aicad eval` (the `aicad.metrics/0` report) and `aicad export --allow-partial`
 * to OBJ (display meshes with per-face groups) in one round trip; the OBJ is parsed here in the
 * renderer. This is the working fallback until `@aicad/forge-web` lands, and stays useful as a
 * cross-check of the WASM build.
 */
import { metricsV1, parseEvalReport } from "@aicad/ir-types";
import type { AicadBridge, ForgeCliInfo } from "../bridge";
import { parseObj } from "./obj";
import { EngineError, type EvalResult, type ForgeEngine, type MeshFormat, type TessellationOptions } from "./types";

export type ForgeCliBridge = AicadBridge["forge"];

export class ForgeCliEngine implements ForgeEngine {
  readonly id = "forge-cli" as const;
  readonly label = "Forge CLI · native";
  readonly detail: string;
  private readonly bridge: ForgeCliBridge;

  constructor(bridge: ForgeCliBridge, info: ForgeCliInfo) {
    this.bridge = bridge;
    this.detail = info.detail;
  }

  async evaluate(irJson: string, tessellation?: TessellationOptions): Promise<EvalResult> {
    // The CLI's display export takes the chordal tolerance (its angular one stays the CLI's default).
    const deflection = tessellation?.chordalDeflection;
    const r = await this.bridge.eval({ irJson, meshes: true, ...(deflection !== undefined ? { deflection } : {}) });
    if (r.error) throw new EngineError("ENGINE_FAILED", r.error);
    if (r.reportJson === null) {
      throw new EngineError("ENGINE_FAILED", `aicad eval produced no report (exit ${String(r.evalExitCode)}): ${r.stderr.trim()}`);
    }
    let report;
    try {
      const raw = JSON.parse(r.reportJson) as { schema?: unknown };
      // An IR v1 document gets the aicad.metrics/1 report (the app's document model); v0 keeps v0's.
      report = raw.schema === "aicad.metrics/1" ? (metricsV1.EvalReportSchema.parse(raw) as unknown as EvalResult["report"]) : parseEvalReport(raw);
    } catch (e) {
      throw new EngineError("ENGINE_BAD_OUTPUT", `aicad eval: not an aicad.metrics report: ${(e as Error).message}`);
    }
    let bodies: EvalResult["bodies"] = [];
    if (r.objText !== null) {
      try {
        bodies = parseObj(r.objText);
      } catch (e) {
        throw new EngineError("ENGINE_BAD_OUTPUT", `aicad export: unreadable OBJ: ${(e as Error).message}`);
      }
    }
    return { report, bodies };
  }

  async exportMesh(irJson: string, format: MeshFormat, tessellation?: TessellationOptions): Promise<Uint8Array> {
    const r = await this.bridge.export({
      irJson,
      format,
      ...(tessellation?.chordalDeflection !== undefined ? { deflection: tessellation.chordalDeflection } : {}),
      ...(tessellation?.angularDeflection !== undefined ? { angular: tessellation.angularDeflection } : {}),
    });
    if (r.error) throw new EngineError("EXPORT_FAILED", r.error);
    if (!r.data || r.exitCode !== 0) {
      const why = r.stderr.trim() || `exit code ${String(r.exitCode)}`;
      throw new EngineError("EXPORT_FAILED", `aicad export failed: ${why}`);
    }
    return r.data;
  }

  dispose(): void {
    // Stateless: every call is its own process in the main process.
  }
}

