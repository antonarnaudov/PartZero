/**
 * The Forge CLI (`aicad`) as the desktop app's working engine until `@aicad/forge-web` lands.
 *
 * The renderer never passes arguments or paths: it sends IR JSON, and the main process writes it
 * to a private temp dir, runs `aicad eval` / `aicad export` with a fixed argument list (no shell),
 * returns the outputs and deletes the temp dir.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ForgeCliInfo, ForgeEvalRequest, ForgeEvalResponse, ForgeExportRequest, ForgeExportResponse, MeshFormat } from "@aicad/app/bridge";
import { forgeCliEnv } from "./env.js";

const EXE = process.platform === "win32" ? "aicad.exe" : "aicad";
const MAX_IR_BYTES = 32 * 1024 * 1024;
export const MESH_FORMATS: readonly MeshFormat[] = ["3mf", "stl", "obj"];

/** Walk up from `start` to the monorepo root (the directory with pnpm-workspace.yaml). */
export function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "forge"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface LocateOptions {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

/**
 * Where the `aicad` binary is: in a packaged build always the copy bundled in the app's resources
 * (`$AICAD_BIN` is ignored there); unpackaged, `$AICAD_BIN`, else the repo's cargo build
 * (`forge/target/{release,debug}`: debug is what `cargo build -p forge-cli` produces during
 * development).
 */
export function locateForgeBinary(o: LocateOptions): string {
  if (o.isPackaged) return join(o.resourcesPath, "bin", EXE);
  const fromEnv = o.env["AICAD_BIN"];
  if (fromEnv) return resolve(fromEnv);
  const root = findRepoRoot(o.appPath);
  if (!root) return join(o.appPath, EXE);
  const debug = join(root, "forge", "target", "debug", EXE);
  const release = join(root, "forge", "target", "release", EXE);
  return existsSync(debug) || !existsSync(release) ? debug : release;
}

export async function forgeInfo(bin: string): Promise<ForgeCliInfo> {
  try {
    await access(bin, constants.X_OK);
    return { available: true, path: bin, detail: `Native Forge via ${bin}` };
  } catch {
    return {
      available: false,
      path: bin,
      detail: `Forge CLI not found at ${bin}. Build it with \`cargo build -p forge-cli\` in forge/, or set AICAD_BIN.`,
    };
  }
}

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  error?: string;
}

export function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((done) => {
    // An allowlisted environment: the main process holds provider API keys (env / .env) that the
    // kernel has no business seeing.
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false, env: forgeCliEnv(process.env) });
    const out: Buffer[] = [];
    let err = "";
    let settled = false;
    const finish = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout: Buffer.concat(out), stderr: err, error: `aicad timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 64 * 1024) err += d.toString("utf8");
    });
    child.on("error", (e) => finish({ code: null, stdout: Buffer.alloc(0), stderr: err, error: `could not run ${bin}: ${e.message}` }));
    child.on("close", (code) => finish({ code, stdout: Buffer.concat(out), stderr: err }));
  });
}

export async function withTempDoc<T>(irJson: string, fn: (dir: string, docPath: string) => Promise<T>): Promise<T> {
  if (typeof irJson !== "string" || irJson.length === 0 || irJson.length > MAX_IR_BYTES) throw new Error("invalid IR document");
  const dir = await mkdtemp(join(tmpdir(), "aicad-"));
  try {
    const docPath = join(dir, "document.json");
    await writeFile(docPath, irJson, "utf8");
    return await fn(dir, docPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function forgeEval(bin: string, req: ForgeEvalRequest, timeoutMs = 120_000): Promise<ForgeEvalResponse> {
  const t0 = Date.now();
  const deflection = req.deflection ?? 0.05;
  if (!Number.isFinite(deflection) || deflection <= 0 || deflection > 10) throw new Error("invalid deflection");
  return withTempDoc(req.irJson, async (dir, docPath) => {
    const objPath = join(dir, "display.obj");
    const [ev, ex] = await Promise.all([
      run(bin, ["eval", docPath, "--format", "json"], timeoutMs),
      req.meshes === false
        ? Promise.resolve(null)
        : run(bin, ["export", docPath, "--out", objPath, "--allow-partial", "--deflection", String(deflection)], timeoutMs),
    ]);
    let objText: string | null = null;
    if (ex && ex.code === 0) {
      try {
        objText = await readFile(objPath, "utf8");
      } catch {
        objText = null;
      }
    }
    const reportJson = ev.stdout.length > 0 ? ev.stdout.toString("utf8") : null;
    const stderr = [ev.stderr, ex?.stderr ?? ""].filter(Boolean).join("\n").trim();
    const error = ev.error ?? (reportJson === null ? ex?.error : undefined);
    return {
      reportJson,
      objText,
      evalExitCode: ev.code,
      exportExitCode: ex?.code ?? null,
      stderr,
      ms: Date.now() - t0,
      ...(error ? { error } : {}),
    };
  });
}

/** A 3MF for a printer: centred on its bed, fit-checked, print tessellation (`aicad export --bed`). */
export interface ForgePrintExportRequest {
  irJson: string;
  /** Bed width, depth and height, mm. */
  bed: readonly [number, number, number];
  /** Room kept free on each side, mm. */
  margin: number;
  /** Areas of the bed no part may cover, `[x0, y0, x1, y1]`, mm. */
  exclusions: ReadonlyArray<readonly [number, number, number, number]>;
  deflection: number;
  angular: number;
  /** 3MF `Title` metadata. */
  title: string;
  /** 3MF `Application` metadata, e.g. `PartZero 0.0.1`. */
  application: string;
}

export interface ForgePrintExportResponse {
  /** The 3MF bytes (exit 0 only). */
  data: Uint8Array | null;
  /** The `aicad.export/1` summary, written on success and on `EXPORT_BED_FIT` (exit 4). */
  summary: unknown;
  exitCode: number | null;
  stderr: string;
  error?: string;
}

/** Metadata text for the command line: no control characters, bounded. */
function metaArg(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
}

function finite(v: number, what: string): string {
  if (!Number.isFinite(v)) throw new Error(`invalid ${what}`);
  return String(v);
}

export async function forgePrintExport(bin: string, req: ForgePrintExportRequest, timeoutMs = 300_000): Promise<ForgePrintExportResponse> {
  const args = (dir: string, docPath: string): string[] => [
    "export",
    docPath,
    "--out",
    join(dir, "print.3mf"),
    `--deflection=${finite(req.deflection, "deflection")}`,
    `--angular=${finite(req.angular, "angular")}`,
    `--bed=${req.bed.map((v) => finite(v, "bed size")).join(",")}`,
    `--bed-margin=${finite(req.margin, "bed margin")}`,
    ...req.exclusions.map((r) => `--bed-exclude=${r.map((v) => finite(v, "exclusion zone")).join(",")}`),
    `--title=${metaArg(req.title)}`,
    `--application=${metaArg(req.application)}`,
    `--summary=${join(dir, "summary.json")}`,
  ];
  return withTempDoc(req.irJson, async (dir, docPath) => {
    const r = await run(bin, args(dir, docPath), timeoutMs);
    let data: Uint8Array | null = null;
    if (r.code === 0) {
      try {
        data = new Uint8Array(await readFile(join(dir, "print.3mf")));
      } catch {
        data = null;
      }
    }
    let summary: unknown = null;
    try {
      summary = JSON.parse(await readFile(join(dir, "summary.json"), "utf8"));
    } catch {
      summary = null;
    }
    return { data, summary, exitCode: r.code, stderr: r.stderr.trim(), ...(r.error ? { error: r.error } : {}) };
  });
}

/** The flags of `aicad export` the print handoff needs (W5); an older `aicad` rejects them. */
export const PRINT_EXPORT_FLAGS = ["--bed", "--bed-margin", "--bed-exclude", "--title", "--application", "--summary"] as const;

/**
 * Why an `aicad` run failed, in words for a toast. An `aicad` built before the app (clap exits 2
 * with `unexpected argument '--bed'`) is `FORGE_OUTDATED`, with the rebuild command; otherwise
 * the first `error:` / `aicad:` line of stderr, not clap's closing "For more information, try
 * '--help'." line.
 */
export function forgeFailure(r: { exitCode: number | null; stderr: string; error?: string }, bin: string): { code: "FORGE_OUTDATED" | "EXPORT_FAILED"; message: string } {
  if (r.error) return { code: "EXPORT_FAILED", message: r.error };
  const lines = r.stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const unknown = r.exitCode === 2 ? /unexpected argument '(--?[\w-]+)/.exec(r.stderr) : null;
  if (unknown) {
    return {
      code: "FORGE_OUTDATED",
      message: `The Forge CLI at ${bin} is older than this app: it does not know ${unknown[1]}. Rebuild it with \`cargo build -p forge-cli\` in forge/ (with --release for a packaged build).`,
    };
  }
  const line = lines.find((l) => /^(error|aicad):/i.test(l)) ?? lines.at(-1);
  return { code: "EXPORT_FAILED", message: (line ?? `exit code ${String(r.exitCode)}`).slice(0, 500) };
}

/**
 * Whether `bin` is new enough for the print handoff: `aicad export --help` lists every flag in
 * {@link PRINT_EXPORT_FLAGS}. For the self-test (ALPHA-0-PLAN G1 #2) and diagnostics.
 */
export async function forgePrintCapability(bin: string, timeoutMs = 10_000): Promise<{ ok: boolean; missing: string[]; detail: string }> {
  const r = await run(bin, ["export", "--help"], timeoutMs);
  if (r.code !== 0) return { ok: false, missing: [...PRINT_EXPORT_FLAGS], detail: r.error ?? `aicad export --help exited with ${String(r.code)}` };
  const help = r.stdout.toString("utf8");
  const missing = PRINT_EXPORT_FLAGS.filter((f) => !new RegExp(`(^|[\\s,])${f}(?![\\w-])`, "m").test(help));
  return missing.length === 0
    ? { ok: true, missing, detail: `${bin} supports the print export` }
    : { ok: false, missing, detail: `${bin} is older than this app (no ${missing.join(", ")}); rebuild it with \`cargo build -p forge-cli\`` };
}

export async function forgeExport(bin: string, req: ForgeExportRequest, timeoutMs = 300_000): Promise<ForgeExportResponse> {
  if (!MESH_FORMATS.includes(req.format)) throw new Error(`unsupported mesh format: ${String(req.format)}`);
  return withTempDoc(req.irJson, async (dir, docPath) => {
    const out = join(dir, `export.${req.format}`);
    const args = ["export", docPath, "--out", out, ...(req.allowPartial ? ["--allow-partial"] : [])];
    const r = await run(bin, args, timeoutMs);
    let data: Uint8Array | null = null;
    if (r.code === 0) {
      try {
        data = new Uint8Array(await readFile(out));
      } catch {
        data = null;
      }
    }
    return { data, exitCode: r.code, stderr: r.stderr.trim(), ...(r.error ? { error: r.error } : {}) };
  });
}

/** What `--self-test` reports about the Forge CLI (`self-test.ts`). */
export interface ForgeSelfCheck {
  ok: boolean;
  path: string;
  version: string | null;
  detail: string;
  v0: { status: string | null; schema: string | null } | null;
  v1: { status: string | null; schema: string | null } | null;
}

function reportHead(stdout: Buffer): { status: string | null; schema: string | null } | null {
  try {
    const j = JSON.parse(stdout.toString("utf8")) as { status?: unknown; schema?: unknown };
    return { status: typeof j.status === "string" ? j.status : null, schema: typeof j.schema === "string" ? j.schema : null };
  } catch {
    return null;
  }
}

/**
 * `--self-test`: the bundled `aicad` runs (`--version`), evaluates `irJson` (a v0 document), migrates it to
 * `aicad.ir/1` and evaluates that. The v1 path is the one the Alpha 0 agent's fallback engine uses.
 */
export async function forgeSelfCheck(bin: string, irJson: string, timeoutMs = 60_000): Promise<ForgeSelfCheck> {
  const info = await forgeInfo(bin);
  if (!info.available) return { ok: false, path: bin, version: null, detail: info.detail, v0: null, v1: null };
  const ver = await run(bin, ["--version"], timeoutMs);
  const version = ver.code === 0 ? ver.stdout.toString("utf8").trim().slice(0, 100) : null;
  return withTempDoc(irJson, async (dir, docPath) => {
    const v0 = reportHead((await run(bin, ["eval", docPath, "--format", "json"], timeoutMs)).stdout);
    const v1Path = join(dir, "document.v1.json");
    const mig = await run(bin, ["migrate", docPath, "--out", v1Path], timeoutMs);
    const v1 = mig.code === 0 ? reportHead((await run(bin, ["eval", v1Path, "--format", "json"], timeoutMs)).stdout) : null;
    const ok = version !== null && v0?.status === "ok" && v0.schema === "aicad.metrics/0" && v1?.status === "ok" && v1.schema === "aicad.metrics/1";
    const detail = ok
      ? `${version}: evaluates v0 and v1`
      : version === null
        ? `${bin} --version failed: ${ver.error ?? ver.stderr.slice(0, 200)}`
        : `v0 ${v0?.schema ?? "no report"} ${v0?.status ?? ""}; migrate exit ${mig.code}${mig.code === 0 ? "" : ` (${mig.stderr.slice(0, 200)})`}; v1 ${v1?.schema ?? "no report"} ${v1?.status ?? ""}`;
    return { ok, path: bin, version, detail, v0, v1 };
  });
}
