/**
 * The agent worker's half of `--self-test` (docs/ALPHA-0-PLAN.md W1, G1 #2): read-only checks that the bundled worker
 * has everything a run needs, without a model call and without touching a document or a CLI.
 *
 * - CadScript compiles (the TypeScript compiler is inlined into the worker bundle, with a `createRequire` banner);
 * - Forge evaluates the compiled v0 document in this process (forge-web WASM, loaded from next to the worker);
 * - Forge migrates it to `aicad.ir/1` and evaluates that (`aicad.metrics/1`);
 * - the role prompts are found (`bundle/prompts`, or the agent package's own);
 * - the CAD MCP host and its shim, and the CLI agent-runtime driver, are loadable.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrompt, type PromptRole } from "@aicad/agent";
import { compile } from "@aicad/cadscript";
import { bundledPromptsDir } from "../bundle-paths.js";
import { ForgeWebNodeEngine, forgeWasmPath } from "./engine.js";
import { loadCliRuntime, loadMcpServer } from "./optional-modules.js";

/** A small v0 part: an 80 × 50 × 8 mm plate (volume 32 000 mm³). */
export const SELF_TEST_SOURCE = `import { doc, part, sketch, line, extrude, XY } from "@aicad/std";

doc({ name: "self-test", description: "" });

part("part");
const base = sketch(XY, {
  bottom: line([-40, -25], [40, -25]),
  right: line([40, -25], [40, 25]),
  top: line([40, 25], [-40, 25]),
  left: line([-40, 25], [-40, -25]),
});
const plate = extrude(base, { distance: 8 });
`;
export const SELF_TEST_VOLUME = 32_000;

export interface CheckResult {
  ok: boolean;
  detail: string;
}

export interface EvalCheck extends CheckResult {
  schema: string | null;
  status: string | null;
  bodies: number;
  volume: number | null;
}

export interface WorkerSelfTestReport {
  cadscript: CheckResult;
  engine: CheckResult & { wasm: string | null };
  v0: EvalCheck;
  v1: EvalCheck;
  prompts: CheckResult & { dir: string; ids: string[] };
  mcp: CheckResult & { shim: string | null };
  cliRuntime: CheckResult;
}

interface AnyReport {
  schema?: string;
  status?: string;
  features?: Array<{ bodies?: Array<{ volume?: number }> }>;
  parts?: Array<{ bodies?: Array<{ volume?: number }> }>;
  error?: { code?: string; message?: string } | null;
}

/** Bodies and total volume of a v0 (last body-creating feature) or v1 (final part bodies) report. */
export function summarizeReport(r: AnyReport): Omit<EvalCheck, "ok" | "detail"> {
  let bodies: Array<{ volume?: number }> = [];
  if (Array.isArray(r.parts)) bodies = r.parts.flatMap((p) => p.bodies ?? []);
  else if (Array.isArray(r.features)) bodies = [...r.features].reverse().find((f) => (f.bodies ?? []).length > 0)?.bodies ?? [];
  const volumes = bodies.map((b) => b.volume).filter((v): v is number => typeof v === "number");
  return { schema: r.schema ?? null, status: r.status ?? null, bodies: bodies.length, volume: volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) : null };
}

function evalCheck(r: AnyReport, schema: string): EvalCheck {
  const s = summarizeReport(r);
  const volumeOk = s.volume !== null && Math.abs(s.volume - SELF_TEST_VOLUME) <= SELF_TEST_VOLUME * 1e-6;
  const ok = s.schema === schema && s.status === "ok" && s.bodies === 1 && volumeOk;
  const detail = ok
    ? `${schema}: 1 body, ${s.volume} mm³`
    : `${s.schema ?? "no schema"}: status ${s.status ?? "?"}, ${s.bodies} bodies, volume ${s.volume ?? "?"} (expected ${schema}, ok, 1 body, ${SELF_TEST_VOLUME} mm³)${r.error?.code ? `; ${r.error.code}: ${r.error.message ?? ""}` : ""}`;
  return { ok, detail, ...s };
}

const fail = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const NOT_RUN: EvalCheck = { ok: false, detail: "not run", schema: null, status: null, bodies: 0, volume: null };

export interface WorkerSelfTestOptions {
  /** The bundled MCP shim the main process found (`bundle-paths.ts`), or null. */
  mcpShimPath: string | null;
  /** Development: the workspace's `packages/mcp-server`. */
  mcpServerDir: string | null;
  /** The folder of the worker's code (default: this module's; tests pass another). */
  workerDir?: string;
}

export async function workerSelfTest(o: WorkerSelfTestOptions): Promise<WorkerSelfTestReport> {
  const workerDir = o.workerDir ?? dirname(fileURLToPath(import.meta.url));

  let ir: object | null = null;
  let cadscript: CheckResult;
  try {
    const r = compile(SELF_TEST_SOURCE);
    ir = r.ok ? (r.ir as object) : null;
    cadscript = r.ok ? { ok: true, detail: "CadScript v0 compiles" } : { ok: false, detail: r.diagnostics.map((d) => d.message).join("; ").slice(0, 300) };
  } catch (e) {
    cadscript = { ok: false, detail: fail(e) };
  }

  let wasm: string | null = null;
  try {
    wasm = forgeWasmPath(workerDir);
  } catch {
    wasm = null;
  }
  const web = new ForgeWebNodeEngine();
  const availability = await web.availability();
  const engine = { ok: availability.available, detail: availability.detail, wasm };
  let v0 = NOT_RUN;
  let v1 = NOT_RUN;
  if (availability.available && ir !== null) {
    try {
      const m = await web.module();
      v0 = evalCheck(m.evaluate(ir).report as AnyReport, "aicad.metrics/0");
      const migrated = m.migrate(ir).document;
      v1 = evalCheck(m.evaluate(migrated).report as AnyReport, "aicad.metrics/1");
    } catch (e) {
      const detail = fail(e);
      if (v0 === NOT_RUN) v0 = { ...NOT_RUN, detail };
      else v1 = { ...NOT_RUN, detail };
    }
  }

  const dir = bundledPromptsDir(workerDir);
  const ids: string[] = [];
  let prompts: WorkerSelfTestReport["prompts"];
  try {
    for (const role of ["triage", "spec_writer", "designer"] as PromptRole[]) {
      const p = loadPrompt(role, dir !== null ? { dir } : {});
      ids.push(`${p.id}@${p.sha256}`);
    }
    prompts = { ok: true, detail: dir !== null ? "bundled prompts" : "the agent package's prompts", dir: dir ?? "(package default)", ids };
  } catch (e) {
    prompts = { ok: false, detail: fail(e), dir: dir ?? "(package default)", ids };
  }

  const loaded = await loadMcpServer(o.mcpServerDir, o.mcpShimPath).catch(() => null);
  const mcp = loaded ? { ok: true, detail: "CAD MCP host loaded", shim: loaded.stdio } : { ok: false, detail: "the CAD MCP server is not available in this build", shim: null };
  const runtime = await loadCliRuntime().catch(() => null);
  const cliRuntime = runtime ? { ok: true, detail: "CLI agent runtime loaded" } : { ok: false, detail: "the CLI agent runtime is not available" };

  return { cadscript, engine, v0, v1, prompts, mcp, cliRuntime };
}
