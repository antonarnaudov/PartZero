/**
 * Engines for IR v1: evaluate an `aicad.ir/1` document into an `aicad.metrics/1` report (SPEC-v1
 * §7). The v0 engines of `@aicad/evals` parse `aicad.metrics/0` only; until the evals harness grows
 * v1 engines (W11), the agent's v1 sessions use these.
 *
 * - {@link ForgeCliEngineV1}: `forge/target/debug/aicad eval <file> --format json` (native Forge,
 *   which answers every non-v0 document with an `aicad.metrics/1` report, exit 0/1/2).
 * - {@link OracleCliEngineV1}: `oracle eval <file>` (the OCCT oracle's v1 pipeline, CI/dev only).
 * - {@link FixtureEngineV1}: recorded reports keyed by the document's content hash (offline tests).
 * - {@link ScriptedEngineV1}: a function from document to report (tests).
 *
 * Failures that are not a report (the engine is missing, crashed, timed out or printed no report)
 * throw the evals {@link EngineError}, so the playbooks' `ENGINE_*` hints apply unchanged.
 */
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { v1 as cs } from "@aicad/cadscript";
import { contentHash, EngineError, runProcess, type EngineAvailability } from "@aicad/evals";
import { v1 as ir, type metricsV1 } from "@aicad/ir-types";

export type IrDocumentV1 = ir.IrDocument;
/** What `runProcess` resolves to. */
export type ProcessResultV1 = Awaited<ReturnType<typeof runProcess>>;
export type ReportV1 = metricsV1.EvalReport;

export interface EvaluateOptionsV1 {
  /** Document name: the temp file stem (the report's `document` falls back to it). */
  name?: string;
  /**
   * A tighter time limit for this evaluation, ms (the task's remaining wall time): the engine's
   * own timeout applies when it is shorter. Past it the evaluation is killed (`ENGINE_TIMEOUT`).
   */
  timeoutMs?: number;
}

/** The time limit of one evaluation: the engine's own, or the caller's when that is shorter. */
function limitMs(own: number, options: EvaluateOptionsV1): number {
  const t = options.timeoutMs;
  return t !== undefined && Number.isFinite(t) && t > 0 ? Math.min(own, Math.ceil(t)) : own;
}

/** An engine that evaluates IR v1 documents. */
export interface EngineV1 {
  /** `forge`, `fixture`, `scripted`, … */
  readonly kind: string;
  availability(): Promise<EngineAvailability>;
  /** Evaluate a document. Throws {@link EngineError} when the engine cannot produce a report. */
  evaluate(doc: IrDocumentV1, options?: EvaluateOptionsV1): Promise<ReportV1>;
}

/**
 * The fixture key of a v1 document: the hash of its canonical JSON. Unlike v0's `irHash`, ids are
 * kept: v1 reports carry feature ids (`feature_id`, origins, `DEPENDENCY_FAILED.feature`).
 */
export function irHashV1(doc: IrDocumentV1): string {
  return contentHash(doc);
}

/**
 * Environment variables the `aicad` binary may inherit (the same allowlist as the evals
 * `ForgeCliEngine`): paths, locale, the Windows essentials and `RUST_BACKTRACE`. Hosts hold provider
 * API keys in their environment; the kernel needs none of it.
 */
export const FORGE_CLI_ENV_ALLOWLIST_V1: readonly string[] = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_NUMERIC", "TZ",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "RUST_BACKTRACE",
];

/** `env` filtered to {@link FORGE_CLI_ENV_ALLOWLIST_V1} (case-insensitive, as Windows names are). */
export function forgeCliEnvV1(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allow = new Set(FORGE_CLI_ENV_ALLOWLIST_V1.map((k) => k.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && allow.has(k.toUpperCase())) out[k] = v;
  return out;
}

function tail(text: string, n = 800): string {
  const t = text.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/** Parse an `aicad.metrics/1` report from engine stdout; any exit code is fine when stdout holds one. */
export function reportFromProcessV1(what: string, r: ProcessResultV1, timeoutMs: number): ReportV1 {
  if (r.error) throw new EngineError("ENGINE_UNAVAILABLE", `${what}: could not start: ${r.error.message}`);
  if (r.timedOut) throw new EngineError("ENGINE_TIMEOUT", `${what}: timed out after ${timeoutMs} ms`);
  const stderr = r.stderr.trim() ? `; stderr: ${tail(r.stderr)}` : "";
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    const code = r.code === 0 || r.code === 1 || r.code === 2 ? "ENGINE_BAD_OUTPUT" : "ENGINE_FAILED";
    throw new EngineError(code, `${what}: exit code ${r.code}, stdout is not a JSON report${stderr}`);
  }
  let report: ReportV1;
  try {
    report = ir.parseEvalReport(json);
  } catch (e) {
    throw new EngineError("ENGINE_BAD_OUTPUT", `${what}: not an aicad.metrics/1 report: ${(e as Error).message}${stderr}`);
  }
  if (report.schema !== ir.METRICS_SCHEMA) throw new EngineError("ENGINE_BAD_OUTPUT", `${what}: report schema is ${JSON.stringify(report.schema)}, expected ${ir.METRICS_SCHEMA}`);
  return report;
}

export interface ForgeCliEngineV1Options {
  /** Path to the `aicad` binary. Default: `<repo>/forge/target/debug/aicad` (from this package's location). */
  bin?: string;
  timeoutMs?: number;
}

function defaultForgeBin(): string {
  // packages/agent-tools/{src,dist}/v1/engine.* → repo root is four levels up.
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  return join(root, "forge", "target", "debug", process.platform === "win32" ? "aicad.exe" : "aicad");
}

/** Native Forge through its CLI: canonical v1 JSON in, `aicad.metrics/1` out. */
export class ForgeCliEngineV1 implements EngineV1 {
  readonly kind = "forge";
  readonly bin: string;
  readonly #timeoutMs: number;

  constructor(options: ForgeCliEngineV1Options = {}) {
    this.bin = resolve(options.bin ?? defaultForgeBin());
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  availability(): Promise<EngineAvailability> {
    try {
      accessSync(this.bin, constants.X_OK);
      return Promise.resolve({ available: true, detail: this.bin });
    } catch {
      return Promise.resolve({ available: false, detail: `Forge CLI not found at ${this.bin} (build it with \`cargo build -p forge-cli\` in forge/, or pass --forge-bin)` });
    }
  }

  async evaluate(doc: IrDocumentV1, options: EvaluateOptionsV1 = {}): Promise<ReportV1> {
    const a = await this.availability();
    if (!a.available) throw new EngineError("ENGINE_UNAVAILABLE", a.detail);
    const dir = mkdtempSync(join(tmpdir(), "aicad-agent-v1-"));
    try {
      const safe = (options.name ?? "doc").replace(/[^A-Za-z0-9_.-]/g, "_") || "doc";
      const path = join(dir, `${safe}.json`);
      writeFileSync(path, cs.toJson(doc));
      const timeoutMs = limitMs(this.#timeoutMs, options);
      const r = await runProcess(this.bin, ["eval", path, "--format", "json"], { timeoutMs, env: forgeCliEnvV1() });
      return reportFromProcessV1("aicad eval", r, timeoutMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export interface OracleCliEngineV1Options {
  /** The `oracle/` uv project. Default: `<repo>/oracle` (from this package's location). */
  oracleDir?: string;
  /** Run this `oracle` executable directly (e.g. `oracle/.venv/bin/oracle`) instead of `uv run oracle`. */
  bin?: string;
  /** The uv executable. Default: `uv` on PATH. */
  uv?: string;
  timeoutMs?: number;
}

/** `env` for the oracle: the Forge allowlist plus uv's and the XDG cache/config variables uv reads. */
export function oracleCliEnvV1(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out = forgeCliEnvV1(env);
  for (const [k, v] of Object.entries(env)) if (v !== undefined && /^(UV_|XDG_)/i.test(k)) out[k] = v;
  return out;
}

/**
 * The OCCT oracle through its CLI: `oracle eval <file>` runs every `aicad.ir/1` document through
 * its v1 pipeline and prints an `aicad.metrics/1` report (checked against metrics-v1.schema.json;
 * exit 0 ok, 1 feature errors, 2 document rejected). It evaluates operations Forge may not yet
 * (draft, as of 2026-09-25: `probeEngineCapabilitiesV1` asks an engine), so agents can build v1
 * models on it while Forge grows (IR-V1-IMPLEMENTATION-PLAN, agent critical path). CI/dev only:
 * the oracle is never a runtime dependency of the app.
 */
export class OracleCliEngineV1 implements EngineV1 {
  readonly kind = "oracle";
  readonly oracleDir: string;
  readonly bin: string | undefined;
  readonly #uv: string;
  readonly #timeoutMs: number;
  #probe: Promise<EngineAvailability> | undefined;

  constructor(options: OracleCliEngineV1Options = {}) {
    this.oracleDir = resolve(options.oracleDir ?? fileURLToPath(new URL("../../../../oracle", import.meta.url)));
    this.bin = options.bin === undefined ? undefined : resolve(options.bin);
    this.#uv = options.uv ?? "uv";
    this.#timeoutMs = options.timeoutMs ?? 300_000;
  }

  /** The command line that evaluates `path`. */
  #command(path: string): [string, string[]] {
    return this.bin !== undefined ? [this.bin, ["eval", path]] : [this.#uv, ["run", "oracle", "eval", path]];
  }

  availability(): Promise<EngineAvailability> {
    this.#probe ??= this.#check();
    return this.#probe;
  }

  async #check(): Promise<EngineAvailability> {
    if (this.bin !== undefined) {
      try {
        accessSync(this.bin, constants.X_OK);
        return { available: true, detail: this.bin };
      } catch {
        return { available: false, detail: `oracle executable not found at ${this.bin}` };
      }
    }
    try {
      accessSync(join(this.oracleDir, "pyproject.toml"), constants.R_OK);
    } catch {
      return { available: false, detail: `no oracle project at ${this.oracleDir} (pass --oracle-dir)` };
    }
    const r = await runProcess(this.#uv, ["run", "oracle", "--help"], { cwd: this.oracleDir, timeoutMs: this.#timeoutMs, env: oracleCliEnvV1() });
    if (r.error) return { available: false, detail: `\`${this.#uv}\` is not runnable (${r.error.message}); install uv: https://docs.astral.sh/uv/` };
    if (r.timedOut || r.code !== 0 || !/\beval\b/.test(r.stdout)) return { available: false, detail: `\`${this.#uv} run oracle --help\` failed in ${this.oracleDir}: ${tail(r.stderr || r.stdout, 400)}` };
    return { available: true, detail: `uv run oracle (${this.oracleDir})` };
  }

  evaluate(doc: IrDocumentV1, options: EvaluateOptionsV1 = {}): Promise<ReportV1> {
    return this.evaluateText(cs.toJson(doc), options);
  }

  /** Evaluate a document's JSON text exactly as written (fixture recording of invalid documents). */
  async evaluateText(text: string, options: EvaluateOptionsV1 = {}): Promise<ReportV1> {
    const a = await this.availability();
    if (!a.available) throw new EngineError("ENGINE_UNAVAILABLE", a.detail);
    const dir = mkdtempSync(join(tmpdir(), "aicad-agent-v1-oracle-"));
    try {
      const safe = (options.name ?? "doc").replace(/[^A-Za-z0-9_.-]/g, "_") || "doc";
      const path = join(dir, `${safe}.json`);
      writeFileSync(path, text);
      const [cmd, args] = this.#command(path);
      const timeoutMs = limitMs(this.#timeoutMs, options);
      const r = await runProcess(cmd, args, { cwd: this.oracleDir, timeoutMs, env: oracleCliEnvV1() });
      return reportFromProcessV1("oracle eval", r, timeoutMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** One recorded evaluation. */
export interface FixtureEntryV1 {
  label: string;
  /** {@link irHashV1} of the document. */
  ir_sha256: string;
  report: ReportV1;
}

/** Recorded reports, replayed by content hash: `FIXTURE_MISSING` for anything else. */
export class FixtureEngineV1 implements EngineV1 {
  readonly kind = "fixture";
  readonly #reports = new Map<string, ReportV1>();
  evaluations = 0;

  constructor(entries: readonly FixtureEntryV1[]) {
    for (const e of entries) this.#reports.set(e.ir_sha256, ir.parseEvalReport(e.report));
  }

  get size(): number {
    return this.#reports.size;
  }

  availability(): Promise<EngineAvailability> {
    return Promise.resolve(this.#reports.size > 0 ? { available: true, detail: `${this.#reports.size} recorded v1 reports` } : { available: false, detail: "no recorded v1 reports" });
  }

  evaluate(doc: IrDocumentV1): Promise<ReportV1> {
    this.evaluations++;
    const r = this.#reports.get(irHashV1(doc));
    if (!r) return Promise.reject(new EngineError("FIXTURE_MISSING", "no recorded aicad.metrics/1 report for this document (content hash not in the fixtures)"));
    return Promise.resolve(structuredClone(r));
  }
}

/**
 * A report as the fixture checks compare it: the `document` name blanked (it is the first caller's
 * label) and every `message` dropped, at any depth — hints and the verification ladder read codes
 * and `details`, never messages, so an engine that only rewords a message does not make a recording
 * stale (review: a Forge message change failed `check-forge-v1` with identical details).
 */
export function comparableReportV1(r: unknown): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (k !== "message") out[k] = strip(x);
      return out;
    }
    return v;
  };
  const o = r !== null && typeof r === "object" && !Array.isArray(r) ? { ...(r as Record<string, unknown>), document: "" } : r;
  return JSON.stringify(strip(o));
}

/**
 * The check mode of a recorded fixture (`AICAD_RECORD_FIXTURES=check-forge-v1`): every evaluation
 * runs on a live engine and returns its report — the test file runs against the engine as it is
 * now — while the engine notes where the recording no longer matches: a document it never
 * recorded, or a report that differs ({@link comparableReportV1}: the `document` name and messages aside).
 * {@link FixtureCheckEngineV1.problems} adds the recorded entries nothing evaluated. It writes
 * nothing; a test file's `finish()` fails on any problem, so a fixture that stores only IR hashes
 * (the tool and agent fixtures) is still checked without being re-recorded.
 */
export class FixtureCheckEngineV1 implements EngineV1 {
  readonly kind: string;
  readonly #inner: EngineV1;
  readonly #recorded = new Map<string, FixtureEntryV1>();
  readonly #seen = new Set<string>();
  readonly #stale: string[] = [];

  constructor(inner: EngineV1, recorded: readonly FixtureEntryV1[]) {
    this.#inner = inner;
    this.kind = inner.kind;
    for (const e of recorded) this.#recorded.set(e.ir_sha256, e);
  }

  availability(): Promise<EngineAvailability> {
    return this.#inner.availability();
  }

  async evaluate(doc: IrDocumentV1, options: EvaluateOptionsV1 = {}): Promise<ReportV1> {
    const key = irHashV1(doc);
    const first = !this.#seen.has(key);
    this.#seen.add(key);
    let report: ReportV1;
    try {
      report = await this.#inner.evaluate(doc, options);
    } catch (e) {
      if (first && this.#recorded.has(key)) this.#stale.push(`${this.#recorded.get(key)!.label}: recorded, but the engine now fails on it (${e instanceof Error ? e.message : String(e)})`);
      throw e;
    }
    if (first) {
      const was = this.#recorded.get(key);
      if (!was) this.#stale.push(`${options.name ?? "doc"}: not recorded (${key.slice(0, 12)})`);
      else if (comparableReportV1(was.report) !== comparableReportV1(report)) this.#stale.push(`${was.label}: the engine's report differs from the recording (${key.slice(0, 12)})`);
    }
    return report;
  }

  /** What no longer matches: stale or missing reports, and recorded entries no evaluation asked for. */
  problems(): string[] {
    const unused = [...this.#recorded.values()].filter((e) => !this.#seen.has(e.ir_sha256)).map((e) => `${e.label}: recorded, but nothing evaluates it now (${e.ir_sha256.slice(0, 12)})`);
    return [...this.#stale, ...unused];
  }
}

/** A report computed by a function (tests): the function may throw an {@link EngineError}. */
export class ScriptedEngineV1 implements EngineV1 {
  readonly kind = "scripted";
  readonly #fn: (doc: IrDocumentV1, options: EvaluateOptionsV1) => ReportV1 | Promise<ReportV1>;
  evaluations = 0;

  constructor(fn: (doc: IrDocumentV1, options: EvaluateOptionsV1) => ReportV1 | Promise<ReportV1>) {
    this.#fn = fn;
  }

  availability(): Promise<EngineAvailability> {
    return Promise.resolve({ available: true, detail: "scripted" });
  }

  async evaluate(doc: IrDocumentV1, options: EvaluateOptionsV1 = {}): Promise<ReportV1> {
    this.evaluations++;
    return ir.parseEvalReport(await this.#fn(structuredClone(doc), options));
  }
}
