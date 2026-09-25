/**
 * Engines evaluate an IR document into an `aicad.metrics/0` report, and (with
 * {@link Engine.evaluateV1}) an `aicad.ir/1` document into an `aicad.metrics/1` report.
 *
 * - {@link ForgeCliEngine}: `forge/target/debug/aicad eval <file> --format json` (native Forge).
 * - {@link OracleEngine}: `uv run oracle eval <file>` in `oracle/` (OCCT via build123d; dev/CI only).
 *   For IR v1 it runs standalone, or replays a reference engine's report (`--replay`, SPEC-v1
 *   §8.1) when a constrained sketch needs a solution the oracle does not compute.
 * - {@link FixtureEngine}: precomputed reports keyed by the IR's content hash (unit tests, offline runs).
 *
 * Process engines report absence through {@link Engine.availability} instead of failing mid-run.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { v1 as cs } from "@aicad/cadscript";
import { parseEvalReport, v1 as irv1, type EvalReport, type IrDocument, type metricsV1 } from "@aicad/ir-types";
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

export type IrDocumentV1 = irv1.IrDocument;
export type EvalReportV1 = metricsV1.EvalReport;

export interface Engine {
  /** `forge`, `oracle`, `fixture`, … */
  readonly kind: string;
  availability(): Promise<EngineAvailability>;
  /** Evaluate a document. Throws {@link EngineError} when the engine cannot produce a report. */
  evaluate(ir: IrDocument, options?: EvaluateOptions): Promise<EvalReport>;
  /**
   * Evaluate an `aicad.ir/1` document into an `aicad.metrics/1` report (SPEC-v1 §7). Engines
   * without it cannot run IR v1 tasks (runners skip them). Throws {@link EngineError} when the
   * engine cannot produce a report; a rejected document is a report (status error, `error`).
   */
  evaluateV1?(doc: IrDocumentV1, options?: EvaluateOptions): Promise<EvalReportV1>;
}

// ─── Process plumbing ──────────────────────────────────────────────────────────────────────

export interface ProcessResult {
  code: number | null;
  /** The signal that ended the process (a kill, a crash), when it did not exit by itself. */
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn error (e.g. ENOENT), if the process could not start. */
  error?: Error;
}

export function runProcess(cmd: string, args: string[], options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<ProcessResult> {
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
    const child = spawn(cmd, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], ...(options.env ? { env: options.env } : {}) });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 120_000);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (error) => finish({ code: null, stdout, stderr, timedOut, error }));
    child.on("close", (code, signal) => finish({ code, signal, stdout, stderr, timedOut }));
  });
}

/** How a process that printed no report ended: `exit code N`, or `killed by SIGKILL`. */
function ending(r: ProcessResult): string {
  return r.code === null && r.signal ? `killed by ${r.signal}` : `exit code ${r.code}`;
}

/**
 * A process the OS killed: `SIGKILL` that nobody here sent (not our timeout, not a failed spawn),
 * which is how macOS memory pressure and the Linux OOM killer end a process when parallel runs
 * exhaust memory. Its run says nothing about the engine, so it is worth one retry, which
 * {@link ForgeCliEngine.retried} records. Any other signal (`SIGSEGV`, `SIGABRT`, `SIGBUS`, …) is
 * the engine crashing: never retried, it fails the evaluation at once, so a crash that happens on
 * some runs only (a determinism bug) cannot pass on its second try.
 */
export function killedByOs(r: ProcessResult): boolean {
  return !r.error && !r.timedOut && r.code === null && r.signal === "SIGKILL";
}

/**
 * The environment switch that lets a run with {@link ForgeCliEngine.retried} documents pass
 * (`AICAD_EVALS_ALLOW_RETRY=1`, the CLI's `--allow-retry`): for memory-constrained local runs
 * only. Without it the real-engine tests and `aicad-evals run` / `fixtures` fail when any
 * document had to be run twice.
 */
export const ALLOW_RETRY_ENV = "AICAD_EVALS_ALLOW_RETRY";

function tail(text: string, n = 800): string {
  const t = text.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/** Write `text` to a fresh temp dir as `<name>.json`, run `fn(path, dir)`, clean up. */
async function withTempText<T>(text: string, name: string, fn: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "aicad-evals-"));
  try {
    const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_") || "doc";
    const path = join(dir, `${safe}.json`);
    writeFileSync(path, text);
    return await fn(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write `ir` to a fresh temp dir as `<name>.json`, run `fn(path)`, clean up. */
function withTempIr<T>(ir: IrDocument, name: string, fn: (path: string) => Promise<T>): Promise<T> {
  return withTempText(JSON.stringify(ir), name, fn);
}

/** Canonical JSON text of a v1 document (byte-identical to forge-ir's, SPEC-v1 §0.4). */
function v1Text(doc: IrDocumentV1): string {
  return cs.toJson(doc);
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
    throw new EngineError(code, `${what}: ${ending(r)}, stdout is not a JSON report${stderr}`);
  }
  try {
    return parseEvalReport(json);
  } catch (e) {
    throw new EngineError("ENGINE_BAD_OUTPUT", `${what}: not an aicad.metrics/0 report: ${(e as Error).message}${stderr}`);
  }
}

/**
 * Parse an `aicad.metrics/1` report from engine stdout: exit 0 (ok), 1 (a feature or parameter
 * failed) and 2 (rejected document) all print a report.
 */
function reportV1FromProcess(what: string, r: ProcessResult, timeoutMs: number): EvalReportV1 {
  if (r.error) throw new EngineError("ENGINE_UNAVAILABLE", `${what}: could not start: ${r.error.message}`);
  if (r.timedOut) throw new EngineError("ENGINE_TIMEOUT", `${what}: timed out after ${timeoutMs} ms`);
  const stderr = r.stderr.trim() ? `; stderr: ${tail(r.stderr)}` : "";
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    const code: EngineErrorCode = r.code === 0 || r.code === 1 || r.code === 2 ? "ENGINE_BAD_OUTPUT" : "ENGINE_FAILED";
    throw new EngineError(code, `${what}: ${ending(r)}, stdout is not a JSON report${stderr}`);
  }
  let report: EvalReportV1;
  try {
    report = irv1.parseEvalReport(json);
  } catch (e) {
    throw new EngineError("ENGINE_BAD_OUTPUT", `${what}: not an aicad.metrics/1 report: ${(e as Error).message}${stderr}`);
  }
  if (report.schema !== irv1.METRICS_SCHEMA) {
    throw new EngineError("ENGINE_BAD_OUTPUT", `${what}: report schema is ${JSON.stringify(report.schema)}, expected ${irv1.METRICS_SCHEMA}`);
  }
  return report;
}

// ─── Forge CLI ─────────────────────────────────────────────────────────────────────────────

/**
 * Variables the `aicad` binary may inherit: paths, locale, the Windows essentials and
 * `RUST_BACKTRACE`. Callers such as the desktop agent hold provider API keys in their environment;
 * the kernel needs none of it.
 */
export const FORGE_CLI_ENV_ALLOWLIST: readonly string[] = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_NUMERIC", "TZ",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "RUST_BACKTRACE",
];

/** `env` filtered to {@link FORGE_CLI_ENV_ALLOWLIST} (case-insensitive: Windows names are). */
export function forgeCliEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allow = new Set(FORGE_CLI_ENV_ALLOWLIST.map((k) => k.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && allow.has(k.toUpperCase())) out[k] = v;
  return out;
}

export interface ForgeCliEngineOptions {
  /** Path to the `aicad` binary. Default: `<repo>/forge/target/debug/aicad`. */
  bin?: string;
  /** Per-document timeout (default 120 s; a debug build needs more for the largest v1 documents). */
  timeoutMs?: number;
}

export class ForgeCliEngine implements Engine {
  readonly kind = "forge";
  readonly bin: string;
  private readonly timeoutMs: number;
  /**
   * Documents whose first run the OS killed ({@link killedByOs}) and that were run once more,
   * `<name>: SIGKILL`. A second kill fails the evaluation. Runners fail when this is non-empty
   * unless the run opts in ({@link ALLOW_RETRY_ENV}, `--allow-retry`): a gate never passes on a
   * document's second run unnoticed.
   */
  readonly retried: string[] = [];

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
    return withTempIr(ir, options.name ?? "doc", async (path) => reportFromProcess("aicad eval", await this.run(path, options.name), this.timeoutMs));
  }

  async evaluateV1(doc: IrDocumentV1, options: EvaluateOptions = {}): Promise<EvalReportV1> {
    const a = await this.availability();
    if (!a.available) throw new EngineError("ENGINE_UNAVAILABLE", a.detail);
    return withTempText(v1Text(doc), options.name ?? "doc", async (path) => reportV1FromProcess("aicad eval", await this.run(path, options.name), this.timeoutMs));
  }

  /** `aicad eval <path>`, once more if the OS killed the first run (a crash is never retried). */
  private async run(path: string, name = "doc"): Promise<ProcessResult> {
    const once = () => runProcess(this.bin, ["eval", path, "--format", "json"], { timeoutMs: this.timeoutMs, env: forgeCliEnv() });
    const r = await once();
    if (!killedByOs(r)) return r;
    this.retried.push(`${name}: ${r.signal}`);
    return once();
  }
}

// ─── OCCT oracle ───────────────────────────────────────────────────────────────────────────

export interface OracleEngineOptions {
  /** The `oracle/` uv project. Default: `<repo>/oracle`. */
  oracleDir?: string;
  /** The uv executable. Default: `uv` on PATH. */
  uv?: string;
  timeoutMs?: number;
  /**
   * IR v1: the engine whose report the oracle replays (`oracle eval --replay`, SPEC-v1 §8.1),
   * usually Forge. The oracle does not solve constrained sketches: standalone it only accepts a
   * stored guess that already satisfies every constraint (`ORACLE_SOLVE_REQUIRES_REPLAY`
   * otherwise). With a replay engine, a document is evaluated standalone first and, only if a
   * feature fails with `ORACLE_SOLVE_REQUIRES_REPLAY`, again replaying that engine's report (the
   * oracle then checks the replayed solution independently and replays reference members).
   */
  replay?: Engine | undefined;
}

/** The oracle's code for a constrained sketch it cannot evaluate without a reference report. */
export const ORACLE_SOLVE_REQUIRES_REPLAY = "ORACLE_SOLVE_REQUIRES_REPLAY";

export class OracleEngine implements Engine {
  readonly kind = "oracle";
  readonly oracleDir: string;
  private readonly uv: string;
  private readonly timeoutMs: number;
  private readonly replay: Engine | undefined;
  private probe: Promise<EngineAvailability> | undefined;

  constructor(options: OracleEngineOptions = {}) {
    this.oracleDir = resolve(options.oracleDir ?? join(repoRoot(), "oracle"));
    this.uv = options.uv ?? "uv";
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.replay = options.replay;
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

  async evaluateV1(doc: IrDocumentV1, options: EvaluateOptions = {}): Promise<EvalReportV1> {
    const a = await this.availability();
    if (!a.available) throw new EngineError("ENGINE_UNAVAILABLE", a.detail);
    const name = options.name ?? "doc";
    const standalone = await this.runV1(doc, name, undefined);
    const needsReplay = standalone.features.some((f) => f.error?.code === ORACLE_SOLVE_REQUIRES_REPLAY);
    if (!needsReplay || !this.replay?.evaluateV1) return standalone;
    const reference = await this.replay.evaluateV1(doc, { name });
    return this.runV1(doc, name, reference);
  }

  private runV1(doc: IrDocumentV1, name: string, replay: EvalReportV1 | undefined): Promise<EvalReportV1> {
    return withTempText(v1Text(doc), name, async (path, dir) => {
      const args = ["run", "oracle", "eval", path];
      if (replay) {
        const rp = join(dir, "replay.metrics.json");
        writeFileSync(rp, JSON.stringify(replay));
        args.push("--replay", rp);
      }
      const r = await runProcess(this.uv, args, { cwd: this.oracleDir, timeoutMs: this.timeoutMs });
      return reportV1FromProcess(replay ? "oracle eval --replay" : "oracle eval", r, this.timeoutMs);
    });
  }
}

// ─── Fixtures ──────────────────────────────────────────────────────────────────────────────

export const FIXTURE_SCHEMA = "aicad.evals.fixtures/0";
/** Fixtures of IR v1 tasks: `aicad.metrics/1` reports keyed by {@link irHashV1}. */
export const FIXTURE_SCHEMA_V1 = "aicad.evals.fixtures/1";

/** One task's recorded engine outputs: `fixtures/makerbench/<task-id>.json`. */
export interface FixtureFile {
  schema: typeof FIXTURE_SCHEMA;
  task: string;
  /** The recording engine's identifier (`report.engine`). */
  engine: string;
  entries: FixtureEntry[];
}

/** One IR v1 task's recorded engine outputs: `fixtures/makerbench-v1/<task-id>.json`. */
export interface FixtureFileV1 {
  schema: typeof FIXTURE_SCHEMA_V1;
  task: string;
  /** The recording engine's identifier (`report.engine`). */
  engine: string;
  entries: FixtureEntryV1[];
}

export interface FixtureEntryV1 {
  /** What was evaluated: `reference`, `context`, `mutant:<kind>`, `…/param:<set>`. */
  label: string;
  /** {@link irHashV1} of the v1 document. */
  ir_sha256: string;
  report: EvalReportV1;
}

/**
 * Fixture key of an IR v1 document: the content hash of the whole document. Unlike v0's
 * {@link irHash}, ids are kept: v1 reports carry feature ids (`feature_id`, body origins,
 * `DEPENDENCY_FAILED.feature`).
 */
export function irHashV1(doc: IrDocumentV1): string {
  return contentHash(doc);
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
  private readonly reportsV1 = new Map<string, EvalReportV1>();
  private readonly engines = new Set<string>();
  readonly source: string;

  /**
   * `source`: a directory of fixture files, several directories (IR v0 and IR v1 fixtures live
   * in separate directories), or fixture files already loaded. A missing directory adds nothing.
   */
  constructor(source: string | readonly string[] | readonly (FixtureFile | FixtureFileV1)[]) {
    const files: (FixtureFile | FixtureFileV1)[] = [];
    const dirs = typeof source === "string" ? [source] : source.every((x) => typeof x === "string") ? (source as readonly string[]) : null;
    if (dirs) {
      this.source = dirs.map((d) => resolve(d)).join(", ");
      for (const d of dirs.map((x) => resolve(x))) {
        if (!existsSync(d)) continue;
        for (const f of readdirSync(d).filter((f) => f.endsWith(".json")).sort()) {
          files.push(JSON.parse(readFileSync(join(d, f), "utf8")) as FixtureFile | FixtureFileV1);
        }
      }
    } else {
      this.source = "<memory>";
      files.push(...(source as readonly (FixtureFile | FixtureFileV1)[]));
    }
    for (const file of files) {
      if (file.schema === FIXTURE_SCHEMA) {
        for (const e of file.entries) this.reports.set(e.ir_sha256, parseEvalReport(e.report));
      } else if (file.schema === FIXTURE_SCHEMA_V1) {
        for (const e of file.entries) this.reportsV1.set(e.ir_sha256, irv1.parseEvalReport(e.report));
      } else {
        throw new Error(`fixture for ${(file as { task?: string }).task}: schema must be ${FIXTURE_SCHEMA} or ${FIXTURE_SCHEMA_V1}`);
      }
      this.engines.add(file.engine);
    }
  }

  /** Number of recorded reports (both IR versions). */
  get size(): number {
    return this.reports.size + this.reportsV1.size;
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

  evaluateV1(doc: IrDocumentV1): Promise<EvalReportV1> {
    const r = this.reportsV1.get(irHashV1(doc));
    if (!r) {
      return Promise.reject(
        new EngineError(
          "FIXTURE_MISSING",
          "no recorded report for this IR v1 document (content hash not in the fixtures); re-record with `aicad-evals fixtures --engine oracle`",
        ),
      );
    }
    return Promise.resolve(structuredClone(r));
  }
}
