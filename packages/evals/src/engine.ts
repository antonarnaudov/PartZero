/**
 * Engines evaluate an IR document into an `aicad.metrics/0` report.
 *
 * - {@link ForgeCliEngine}: `forge/target/debug/aicad eval <file> --format json` (native Forge).
 * - {@link OracleEngine}: `uv run oracle eval <file>` in `oracle/` (OCCT via build123d; dev/CI only).
 * - {@link FixtureEngine}: precomputed reports keyed by the IR's content hash (unit tests, offline runs).
 *
 * Process engines report absence through {@link Engine.availability} instead of failing mid-run.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEvalReport, type EvalReport, type IrDocument } from "@aicad/ir-types";
import { contentHash } from "./hash.js";
import { repoRoot } from "./paths.js";

export type EngineErrorCode = "ENGINE_UNAVAILABLE" | "ENGINE_FAILED" | "ENGINE_TIMEOUT" | "ENGINE_BAD_OUTPUT" | "FIXTURE_MISSING";

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

export interface EngineAvailability {
  available: boolean;
  /** What was found, or why the engine cannot run and how to fix it. */
  detail: string;
}

export interface EvaluateOptions {
  /** Document name; used as the temp file stem (the report's `document` falls back to it). */
  name?: string;
}

export interface Engine {
  /** `forge`, `oracle`, `fixture`, … */
  readonly kind: string;
  availability(): Promise<EngineAvailability>;
  /** Evaluate a document. Throws {@link EngineError} when the engine cannot produce a report. */
  evaluate(ir: IrDocument, options?: EvaluateOptions): Promise<EvalReport>;
}

// ─── Process plumbing ──────────────────────────────────────────────────────────────────────

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn error (e.g. ENOENT), if the process could not start. */
  error?: Error;
}

export function runProcess(cmd: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<ProcessResult> {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (r: ProcessResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        done(r);
      }
    };
    const child = spawn(cmd, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 120_000);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (error) => finish({ code: null, stdout, stderr, timedOut, error }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
  });
}

function tail(text: string, n = 800): string {
  const t = text.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/** Write `ir` to a fresh temp dir as `<name>.json`, run `fn(path)`, clean up. */
async function withTempIr<T>(ir: IrDocument, name: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "aicad-evals-"));
  try {
    const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_") || "doc";
    const path = join(dir, `${safe}.json`);
    writeFileSync(path, JSON.stringify(ir));
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Parse a report from engine stdout. `oracle eval` exits 0 for status ok and 1 for a report with
 * status error; any exit code is accepted as long as stdout holds a valid report.
 */
function reportFromProcess(what: string, r: ProcessResult, timeoutMs: number): EvalReport {
  if (r.error) throw new EngineError("ENGINE_UNAVAILABLE", `${what}: could not start: ${r.error.message}`);
  if (r.timedOut) throw new EngineError("ENGINE_TIMEOUT", `${what}: timed out after ${timeoutMs} ms`);
  const stderr = r.stderr.trim() ? `; stderr: ${tail(r.stderr)}` : "";
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    const code: EngineErrorCode = r.code === 0 || r.code === 1 ? "ENGINE_BAD_OUTPUT" : "ENGINE_FAILED";
    throw new EngineError(code, `${what}: exit code ${r.code}, stdout is not a JSON report${stderr}`);
  }
  try {
    return parseEvalReport(json);
  } catch (e) {
    throw new EngineError("ENGINE_BAD_OUTPUT", `${what}: not an aicad.metrics/0 report: ${(e as Error).message}${stderr}`);
  }
}

// ─── Forge CLI ─────────────────────────────────────────────────────────────────────────────

export interface ForgeCliEngineOptions {
  /** Path to the `aicad` binary. Default: `<repo>/forge/target/debug/aicad`. */
  bin?: string;
  timeoutMs?: number;
}

export class ForgeCliEngine implements Engine {
  readonly kind = "forge";
  readonly bin: string;
  private readonly timeoutMs: number;

  constructor(options: ForgeCliEngineOptions = {}) {
    this.bin = resolve(options.bin ?? join(repoRoot(), "forge", "target", "debug", process.platform === "win32" ? "aicad.exe" : "aicad"));
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  availability(): Promise<EngineAvailability> {
    try {
      accessSync(this.bin, constants.X_OK);
      return Promise.resolve({ available: true, detail: this.bin });
    } catch {
      return Promise.resolve({
        available: false,
        detail: `Forge CLI not found at ${this.bin} (build it with \`cargo build -p forge-cli\` in forge/, or pass --forge-bin)`,
      });
    }
  }

  async evaluate(ir: IrDocument, options: EvaluateOptions = {}): Promise<EvalReport> {
    const a = await this.availability();
    if (!a.available) throw new EngineError("ENGINE_UNAVAILABLE", a.detail);
    return withTempIr(ir, options.name ?? "doc", async (path) => {
      const r = await runProcess(this.bin, ["eval", path, "--format", "json"], { timeoutMs: this.timeoutMs });
      return reportFromProcess("aicad eval", r, this.timeoutMs);
    });
  }
}

// ─── OCCT oracle ───────────────────────────────────────────────────────────────────────────

export interface OracleEngineOptions {
  /** The `oracle/` uv project. Default: `<repo>/oracle`. */
  oracleDir?: string;
  /** The uv executable. Default: `uv` on PATH. */
  uv?: string;
  timeoutMs?: number;
}

export class OracleEngine implements Engine {
  readonly kind = "oracle";
  readonly oracleDir: string;
  private readonly uv: string;
  private readonly timeoutMs: number;
  private probe: Promise<EngineAvailability> | undefined;

  constructor(options: OracleEngineOptions = {}) {
    this.oracleDir = resolve(options.oracleDir ?? join(repoRoot(), "oracle"));
    this.uv = options.uv ?? "uv";
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  availability(): Promise<EngineAvailability> {
    this.probe ??= this.check();
    return this.probe;
  }

  private async check(): Promise<EngineAvailability> {
    if (!existsSync(join(this.oracleDir, "pyproject.toml"))) {
      return { available: false, detail: `no oracle project at ${this.oracleDir} (pass --oracle-dir)` };
    }
    const r = await runProcess(this.uv, ["run", "oracle", "--help"], { cwd: this.oracleDir, timeoutMs: this.timeoutMs });
    if (r.error) return { available: false, detail: `\`${this.uv}\` is not runnable (${r.error.message}); install uv: https://docs.astral.sh/uv/` };
    if (r.timedOut || r.code !== 0 || !/\beval\b/.test(r.stdout)) {
      return { available: false, detail: `\`uv run oracle --help\` failed in ${this.oracleDir}: ${tail(r.stderr || r.stdout, 400)}` };
    }
    return { available: true, detail: `uv run oracle (${this.oracleDir})` };
  }

  async evaluate(ir: IrDocument, options: EvaluateOptions = {}): Promise<EvalReport> {
    const a = await this.availability();
    if (!a.available) throw new EngineError("ENGINE_UNAVAILABLE", a.detail);
    return withTempIr(ir, options.name ?? "doc", async (path) => {
      const r = await runProcess(this.uv, ["run", "oracle", "eval", path], { cwd: this.oracleDir, timeoutMs: this.timeoutMs });
      return reportFromProcess("oracle eval", r, this.timeoutMs);
    });
  }
}

// ─── Fixtures ──────────────────────────────────────────────────────────────────────────────

export const FIXTURE_SCHEMA = "aicad.evals.fixtures/0";

/** One task's recorded engine outputs: `fixtures/makerbench/<task-id>.json`. */
export interface FixtureFile {
  schema: typeof FIXTURE_SCHEMA;
  task: string;
  /** The recording engine's identifier (`report.engine`). */
  engine: string;
  entries: FixtureEntry[];
}

export interface FixtureEntry {
  /** What was evaluated: `reference`, `context`, `mutant:<kind>`, … */
  label: string;
  /** {@link irHash} of the IR document (content hash without part/feature ids). */
  ir_sha256: string;
  report: EvalReport;
}

/**
 * Fixture key: the content hash of the IR **without part and feature ids**. Ids never reach an
 * `aicad.metrics/0` report (it names parts and features), so fixtures survive changes to how the
 * CadScript compiler assigns ids; everything that can change a report is hashed.
 */
export function irHash(ir: IrDocument): string {
  return contentHash({
    ...ir,
    parts: ir.parts.map(({ id: _part, ...part }) => ({ ...part, features: part.features.map(({ id: _feature, ...f }) => f) })),
  });
}

export class FixtureEngine implements Engine {
  readonly kind = "fixture";
  private readonly reports = new Map<string, EvalReport>();
  private readonly engines = new Set<string>();
  readonly source: string;

  /** `source`: a directory of fixture files, or fixture files already loaded. */
  constructor(source: string | readonly FixtureFile[]) {
    const files: FixtureFile[] = [];
    if (typeof source === "string") {
      this.source = resolve(source);
      if (existsSync(this.source)) {
        for (const f of readdirSync(this.source).filter((f) => f.endsWith(".json")).sort()) {
          files.push(JSON.parse(readFileSync(join(this.source, f), "utf8")) as FixtureFile);
        }
      }
    } else {
      this.source = "<memory>";
      files.push(...source);
    }
    for (const file of files) {
      if (file.schema !== FIXTURE_SCHEMA) throw new Error(`fixture for ${file.task}: schema must be ${FIXTURE_SCHEMA}`);
      this.engines.add(file.engine);
      for (const e of file.entries) this.reports.set(e.ir_sha256, parseEvalReport(e.report));
    }
  }

  /** Number of recorded reports. */
  get size(): number {
    return this.reports.size;
  }

  /** The engines the fixtures were recorded with. */
  get recordedWith(): string[] {
    return [...this.engines].sort();
  }

  availability(): Promise<EngineAvailability> {
    return Promise.resolve(
      this.reports.size > 0
        ? { available: true, detail: `${this.reports.size} recorded reports from ${this.recordedWith.join(", ")} (${this.source})` }
        : { available: false, detail: `no fixtures in ${this.source} (record them with \`aicad-evals fixtures\`)` },
    );
  }

  evaluate(ir: IrDocument): Promise<EvalReport> {
    const r = this.reports.get(irHash(ir));
    if (!r) {
      return Promise.reject(
        new EngineError(
          "FIXTURE_MISSING",
          "no recorded report for this IR (content hash not in the fixtures); re-record with `aicad-evals fixtures --engine oracle`",
        ),
      );
    }
    return Promise.resolve(structuredClone(r));
  }
}
