/**
 * CLI agents on this machine, as the main process sees them (docs/CLI-PROVIDERS.md §11.2, ADR 0014).
 *
 * - Detection per provider: locate the binary (Settings path override, else PATH, known install directories and,
 *   once per session, the login shell; development and tests may restrict the search to `AICAD_CLI_DIRS`), read
 *   `--version` and `--help`, and evaluate the lockdown. Cached for 10 minutes, keyed by the real path, size and
 *   mtime (CLIs update themselves: a changed binary is detected again).
 * - Login state: the provider's cheap probe (`claude auth status --json`, …). It never calls a model and never reads
 *   a credential file or keychain entry; only the state, the method label and the plan name are kept. Cached 60 s.
 * - Model discovery (Codex, opencode) for ready, logged-in CLIs, cached 10 minutes.
 * - A lockdown violation reported by the worker marks that exact binary (real path, size, mtime) blocked. The block is
 *   saved with the settings, so it survives a restart; it is lifted only by a forced Re-check that passes, or when the
 *   binary changes on disk (an update is detected and version-gated again).
 * - A Settings path override is re-validated before every detection. When the search is restricted
 *   (`AICAD_CLI_DIRS`, or an isolated test profile), an override outside those folders is not used either.
 *
 * Probes run in parallel across providers and one at a time per provider, each with the provider's own timeouts.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import type { CliProviderId, CliProviderStatus, PlanUsageView } from "@aicad/app/bridge";
import { BUILTIN_PROFILES, profileFromDiscovery, type CliAuthStatus, type CliBinary, type CliDetection, type CliProvider, type ModelProfile, type PlanUsage } from "@aicad/llm-gateway";
import { CLI_PROVIDER_IDS } from "./protocol.js";

/** What the worker is told about a binary (the full `CliBinary` travels as `CliBinaryWire`). */
export interface CliBinaryRef {
  provider: CliProviderId;
  path: string;
  realPath: string;
  version: string;
  size: number;
  mtimeMs: number;
  helpSha256: string;
}

/** A binary blocked after a lockdown violation (§5.5, §5.6), as saved in the settings file. */
export interface CliBlock {
  provider: CliProviderId;
  realPath: string;
  size: number;
  mtimeMs: number;
  /** The violation, without its payload (at most 300 characters). */
  reason: string;
  /** ISO time of the violation. */
  at: string;
}

/** Where blocks are kept across restarts (the settings store; tests may leave it out: memory only). */
export interface CliBlockStore {
  load(): readonly CliBlock[];
  save(blocks: CliBlock[]): void;
}

export const DETECTION_TTL_MS = 10 * 60_000;
export const AUTH_TTL_MS = 60_000;
/** Blocks kept (in memory and in the settings file): the newest ones. */
export const MAX_CLI_BLOCKS = 32;

/** Whether nothing is at `path` any more (a CLI that updated itself into a new versioned path leaves its old one). */
function vanished(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR";
  }
}

/** Vendor install pages, shown for "Not installed". */
export const CLI_INSTALL_URLS: Readonly<Record<CliProviderId, string>> = {
  "claude-cli": "https://docs.anthropic.com/en/docs/claude-code/setup",
  "gemini-cli": "https://github.com/google-gemini/gemini-cli",
  "codex-cli": "https://github.com/openai/codex",
  opencode: "https://opencode.ai/docs/",
  "cursor-agent": "https://cursor.com/cli",
};

export interface CliDetectorDeps {
  providers: ReadonlyMap<CliProviderId, CliProvider>;
  /** Environment for probes (allowlisted by the caller; the gateway allowlists again per child). */
  env: () => Record<string, string>;
  /** Settings → CLI path overrides. */
  cliPaths: () => Partial<Record<CliProviderId, string | null>>;
  now?: () => number;
  /** Development and tests (`AICAD_CLI_DIRS`): look for CLIs only in these directories. Null: normal discovery. */
  searchDirs?: readonly string[] | null;
  /** Last-resort lookup through the login shell (a packaged macOS app has a minimal PATH). Default true. */
  loginShell?: boolean;
  /** Model discovery through the CLI (`codex debug models`, `opencode models`). Default true. */
  discover?: boolean;
  /** Persistence of lockdown blocks (default: memory only). */
  blocks?: CliBlockStore;
  log?(level: "info" | "warn" | "error", message: string): void;
}

interface Entry {
  detection: CliDetection;
  detectedAt: number;
  /** The override path the detection used ("" = none). */
  pathKey: string;
  /** Where that override came from: Settings, or the development search dirs (shown as found on PATH). */
  pathFrom: "settings" | "search" | null;
  auth: CliAuthStatus | null;
  authAt: number;
  models: ModelProfile[];
  modelsAt: number;
}

/** The static part of {@link cliPathProblem}: an absolute path with the CLI's own name, or why not. */
export function cliPathShapeProblem(path: string, binaryNames: readonly string[]): string | null {
  if (!isAbsolute(path)) return "must be an absolute path";
  const name = basename(path).replace(/\.(exe|cmd)$/i, "");
  if (!binaryNames.includes(name)) return `must point to ${binaryNames.join(" or ")}`;
  return null;
}

/** Why a CLI path override cannot be used, or null (exists, is an executable file, has the CLI's own name). */
export function cliPathProblem(path: string, binaryNames: readonly string[]): string | null {
  const shape = cliPathShapeProblem(path, binaryNames);
  if (shape !== null) return shape;
  try {
    const st = statSync(path);
    if (!st.isFile()) return "is not a file";
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "does not exist" : "is not an executable file";
  }
  return null;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether `path` (resolved through symlinks) is inside one of `dirs` (also resolved). */
export function insideDirs(path: string, dirs: readonly string[]): boolean {
  const real = realOrSelf(path);
  return dirs.some((d) => {
    if (!isAbsolute(d)) return false;
    const root = realOrSelf(d).replace(/[\\/]+$/, "");
    return real.startsWith(root + sep);
  });
}

/** First `<dir>/<name>` that is an executable file (development search dirs). */
function findInDirs(names: readonly string[], dirs: readonly string[]): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of dirs) {
    if (!isAbsolute(dir)) continue;
    for (const name of names) for (const ext of exts) {
      const p = join(dir, `${name}${ext}`);
      if (cliPathProblem(p, names) === null) return p;
    }
  }
  return null;
}

const WINDOW_LABELS: Record<string, string> = { five_hour: "5-hour", seven_day: "7-day", seven_day_opus: "7-day (Opus)", seven_day_sonnet: "7-day (Sonnet)" };

/**
 * When a plan whose limit was reached is usable again: the reset of the window that ran out (utilization at 100 %;
 * with several, the latest of them, since all must reset), else of the fullest window, and only when no window
 * reports its utilization, the latest reset of all. Not simply the latest reset: Claude Code reports the 5-hour window
 * as the one that ran out while its 7-day window resets days later (packages/llm-gateway/test/cli/fixtures/claude).
 */
export function planResetAt(windows: ReadonlyArray<{ utilization: number | null; resetsAt: string | null }>): string | null {
  // The latest reset of `ws`, or null when one of them has no reset time (then nobody knows when the plan is back).
  const latest = (ws: ReadonlyArray<{ resetsAt: string | null }>): string | null => {
    const times = ws.map((w) => w.resetsAt);
    return times.includes(null) ? null : ((times as string[]).sort().at(-1) ?? null);
  };
  const exhausted = windows.filter((w) => w.utilization !== null && w.utilization >= 1);
  if (exhausted.length > 0) return latest(exhausted);
  const known = windows.filter((w): w is { utilization: number; resetsAt: string } => w.utilization !== null && w.resetsAt !== null);
  if (known.length > 0) {
    const top = Math.max(...known.map((w) => w.utilization));
    return latest(known.filter((w) => w.utilization === top));
  }
  const timed = windows.filter((w) => w.resetsAt !== null);
  return timed.length > 0 ? latest(timed) : null;
}

/** Gateway plan usage → the view the renderer shows. */
export function planUsageView(u: PlanUsage): PlanUsageView {
  return {
    status: u.status,
    windows: u.windows.map((w) => ({ id: w.id, label: WINDOW_LABELS[w.id] ?? w.id.replace(/_/g, " "), utilization: w.utilization, resetsAt: w.resetsAt })),
    observedAt: u.observedAt,
  };
}

export class CliDetector {
  readonly #deps: CliDetectorDeps;
  readonly #entries = new Map<CliProviderId, Entry>();
  readonly #inflight = new Map<CliProviderId, Promise<void>>();
  #blocks: CliBlock[];
  readonly #plans = new Map<CliProviderId, PlanUsageView>();

  constructor(deps: CliDetectorDeps) {
    this.#deps = deps;
    let loaded: readonly CliBlock[] = [];
    try {
      loaded = deps.blocks?.load() ?? [];
    } catch {
      loaded = [];
    }
    const known = loaded.filter((b) => deps.providers.has(b.provider));
    // A block on a file that is gone protects nothing (a new file there is detected and version-gated again); CLIs
    // that update themselves into new versioned paths would otherwise pile blocks up until the newest fall off.
    this.#blocks = known.filter((b) => !vanished(b.realPath)).slice(-MAX_CLI_BLOCKS).map((b) => ({ ...b }));
    if (this.#blocks.length !== known.length) this.#saveBlocks();
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  get providerIds(): CliProviderId[] {
    return CLI_PROVIDER_IDS.filter((id) => this.#deps.providers.has(id));
  }

  provider(id: CliProviderId): CliProvider | undefined {
    return this.#deps.providers.get(id);
  }

  /** Detect (cached) and return every provider's status, in the auto-default order. */
  async status(options: { force?: boolean; providers?: readonly CliProviderId[] } = {}): Promise<CliProviderStatus[]> {
    const ids = (options.providers ?? this.providerIds).filter((id) => this.#deps.providers.has(id));
    await Promise.all(ids.map((id) => this.#refresh(id, options.force === true)));
    return this.view();
  }

  /** The last known statuses without probing (providers not checked yet have `checkedAt: null`). */
  view(): CliProviderStatus[] {
    return this.providerIds.map((id) => this.statusOf(id));
  }

  statusOf(id: CliProviderId): CliProviderStatus {
    const provider = this.#deps.providers.get(id);
    const label = provider?.label ?? id;
    const e = this.#entries.get(id);
    const plan = this.#plans.get(id) ?? null;
    if (!provider || !e) {
      return {
        id,
        label,
        installed: false,
        path: null,
        pathSource: null,
        version: null,
        support: "not_installed",
        supportDetail: "not checked yet",
        lockdownLevel: null,
        residualRisks: [],
        auth: "unknown",
        plan: null,
        billing: "subscription",
        loginHint: provider?.loginHint ?? "",
        modes: [],
        planUsage: plan,
        checkedAt: null,
      };
    }
    const d = e.detection;
    const blocked = this.#blockedFor(id, d.binary);
    const support = blocked ? "blocked" : d.status;
    return {
      id,
      label,
      installed: d.status !== "not_installed",
      path: d.binary?.path ?? null,
      pathSource: d.binary ? (e.pathFrom === "search" ? "path" : d.binary.source) : null,
      version: d.binary?.version ?? null,
      support,
      supportDetail: blocked ? `Stopped after a lockdown violation (${blocked.reason}). Press Re-check to test it again.` : d.detail,
      lockdownLevel: d.lockdown?.level ?? null,
      residualRisks: d.lockdown?.residualRisks ?? [],
      auth: support === "ready" ? (e.auth?.state ?? "unknown") : "unknown",
      plan: support === "ready" ? (e.auth?.plan ?? null) : null,
      billing: e.auth?.billing === "metered" ? "metered" : "subscription",
      loginHint: provider.loginHint,
      modes: support === "ready" ? [...provider.capabilities.modes] : [],
      planUsage: plan,
      checkedAt: new Date(Math.max(e.detectedAt, e.authAt)).toISOString(),
    };
  }

  /** The detected binary when the provider may run (ready and not blocked), else null. */
  binary(id: CliProviderId): CliBinary | null {
    const e = this.#entries.get(id);
    if (!e || e.detection.status !== "ready" || !e.detection.binary) return null;
    if (this.#blockedFor(id, e.detection.binary)) return null;
    return e.detection.binary;
  }

  binaryRef(id: CliProviderId): CliBinaryRef | null {
    const b = this.binary(id);
    return b === null ? null : { provider: id, path: b.path, realPath: b.realPath, version: b.version, size: b.stat.size, mtimeMs: b.stat.mtimeMs, helpSha256: b.help.sha256 };
  }

  /**
   * After a tripwire: this exact binary (real path, size, mtime) stays blocked, across restarts, until a forced
   * Re-check passes or the file changes on disk.
   */
  markBlocked(id: CliProviderId, realPath: string, reason: string): void {
    const known = this.#entries.get(id)?.detection.binary;
    let size: number;
    let mtimeMs: number;
    if (known && known.realPath === realPath) {
      ({ size, mtimeMs } = known.stat);
    } else {
      try {
        const st = statSync(realPath);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        // Gone already: nothing on disk to block (a new file there is detected, and version-gated, again).
        return;
      }
    }
    const block: CliBlock = { provider: id, realPath, size, mtimeMs, reason: reason.slice(0, 300), at: new Date(this.#now()).toISOString() };
    // Newest last; blocks on files that are gone are dropped, and the oldest go first when there are too many.
    this.#blocks = [...this.#blocks.filter((b) => !(b.provider === id && b.realPath === realPath) && !vanished(b.realPath)), block].slice(-MAX_CLI_BLOCKS);
    this.#saveBlocks();
    this.#deps.log?.("warn", `${this.#deps.providers.get(id)?.label ?? id} at ${realPath} is blocked after a lockdown violation; press Re-check in Settings to test it again`);
  }

  /** The blocks in force (tests and diagnostics). */
  blocks(): CliBlock[] {
    return this.#blocks.map((b) => ({ ...b }));
  }

  #saveBlocks(): void {
    try {
      this.#deps.blocks?.save(this.blocks());
    } catch (e) {
      this.#deps.log?.("error", `could not save the CLI blocks: ${(e as Error).message}`.slice(0, 300));
    }
  }

  /** Drop blocks of `id` for which `drop` holds (and save when any was dropped). */
  #unblock(id: CliProviderId, drop: (b: CliBlock) => boolean): void {
    const next = this.#blocks.filter((b) => b.provider !== id || !drop(b));
    if (next.length === this.#blocks.length) return;
    this.#blocks = next;
    this.#saveBlocks();
  }

  /** The last plan usage a run reported (never a start error: it may be stale). */
  lastPlanUsage(id: CliProviderId): PlanUsageView | null {
    return this.#plans.get(id) ?? null;
  }

  setPlanUsage(id: CliProviderId, usage: PlanUsageView): void {
    this.#plans.set(id, usage);
  }

  /** Profiles of models the CLIs listed (ready and logged-in providers only). */
  discovered(): ModelProfile[] {
    const out: ModelProfile[] = [];
    for (const id of this.providerIds) {
      if (this.binary(id) === null) continue;
      out.push(...(this.#entries.get(id)?.models ?? []));
    }
    return out;
  }

  #blockedFor(id: CliProviderId, binary: CliBinary | null): CliBlock | null {
    if (!binary) return null;
    return this.#blocks.find((b) => b.provider === id && b.realPath === binary.realPath && b.size === binary.stat.size && b.mtimeMs === binary.stat.mtimeMs) ?? null;
  }

  #refresh(id: CliProviderId, force: boolean): Promise<void> {
    const running = this.#inflight.get(id);
    const next = (running ?? Promise.resolve()).then(() => this.#probe(id, force));
    const tracked = next.finally(() => {
      if (this.#inflight.get(id) === tracked) this.#inflight.delete(id);
    });
    this.#inflight.set(id, tracked);
    return tracked;
  }

  /**
   * The path detection uses: the Settings override (re-validated now), else the first match in the restricted search
   * dirs, else null (normal discovery). `problem`: the override cannot be used, reported as not installed.
   */
  #overridePath(id: CliProviderId, provider: CliProvider): { path: string | null; searched: boolean; problem?: string } {
    const configured = this.#deps.cliPaths()[id] ?? null;
    const dirs = this.#deps.searchDirs ?? null;
    if (configured) {
      const problem = cliPathProblem(configured, provider.binaryNames);
      if (problem !== null) return { path: configured, searched: false, problem: `the ${provider.label} path in Settings (${configured}) ${problem}` };
      // A restricted search (tests, development) never runs a CLI from elsewhere, even one named in Settings: an
      // isolated test profile must not reach the user's real, logged-in CLI through a stored or seeded path.
      if (dirs !== null && !insideDirs(configured, dirs)) {
        return {
          path: configured,
          searched: false,
          problem:
            dirs.length === 0
              ? `CLI detection is off in this isolated test profile (set AICAD_CLI_DIRS); the Settings path ${configured} is not used`
              : `the Settings path ${configured} is outside AICAD_CLI_DIRS, which this development or test profile is restricted to`,
        };
      }
      return { path: configured, searched: false };
    }
    if (dirs === null) return { path: null, searched: false };
    return { path: findInDirs(provider.binaryNames, dirs), searched: true };
  }

  async #probe(id: CliProviderId, force: boolean): Promise<void> {
    const provider = this.#deps.providers.get(id);
    if (!provider) return;
    const now = this.#now();
    const override = this.#overridePath(id, provider);
    const pathKey = override.path ?? "";
    let e = this.#entries.get(id);
    const stale = force || !e || now - e.detectedAt > DETECTION_TTL_MS || e.pathKey !== pathKey || binaryChanged(e.detection.binary);
    const env = this.#deps.env();
    if (stale) {
      let detection: CliDetection;
      if (override.problem !== undefined) {
        detection = { provider: id, status: "not_installed", binary: null, lockdown: null, detail: override.problem.slice(0, 300) };
      } else if (override.searched && override.path === null) {
        detection = {
          provider: id,
          status: "not_installed",
          binary: null,
          lockdown: null,
          detail: (this.#deps.searchDirs ?? []).length === 0 ? "CLI detection is off in this isolated test profile (set AICAD_CLI_DIRS)" : `${provider.label} was not found in AICAD_CLI_DIRS`,
        };
      } else {
        try {
          detection = await provider.detect({ overridePath: override.path, env, extraDirs: [], loginShell: this.#deps.loginShell ?? true });
        } catch (err) {
          detection = { provider: id, status: "not_installed", binary: null, lockdown: null, detail: `detection failed: ${(err as Error).message}`.slice(0, 300) };
        }
      }
      e = { detection, detectedAt: this.#now(), pathKey, pathFrom: override.path === null ? null : override.searched ? "search" : "settings", auth: null, authAt: 0, models: [], modelsAt: 0 };
      this.#entries.set(id, e);
      const found = detection.binary;
      if (found !== null) {
        // A blocked binary that changed on disk (an update) is a new binary: detection and the version gate decide.
        this.#unblock(id, (b) => b.realPath === found.realPath && (b.size !== found.stat.size || b.mtimeMs !== found.stat.mtimeMs));
        // Re-check (a forced detection) that passes lifts the block on this exact binary.
        if (force && detection.status === "ready") this.#unblock(id, (b) => b.realPath === found.realPath);
      }
    }
    const entry = e!;
    const binary = entry.detection.status === "ready" ? entry.detection.binary : null;
    if (binary === null) return;
    if (force || entry.auth === null || this.#now() - entry.authAt > AUTH_TTL_MS) {
      try {
        entry.auth = await provider.authStatus(binary, env);
      } catch (err) {
        entry.auth = { state: "unknown", method: null, plan: null, billing: "subscription", probe: "none", detail: `login probe failed: ${(err as Error).message}`.slice(0, 200), checkedAt: new Date().toISOString() };
      }
      entry.authAt = this.#now();
    }
    if (this.#deps.discover === false || provider.listModels === undefined || entry.auth?.state !== "logged_in") return;
    if (!force && entry.modelsAt > 0 && this.#now() - entry.modelsAt <= DETECTION_TTL_MS) return;
    try {
      const listed = await provider.listModels(binary, env);
      entry.models = listed.filter((m) => m.tools).slice(0, 200).map((m) => profileFromDiscovery(id, m, BUILTIN_PROFILES.find((p) => p.apiModelId === m.modelArg)));
    } catch (err) {
      entry.models = [];
      this.#deps.log?.("warn", `${provider.label}: model discovery failed: ${(err as Error).message}`.slice(0, 300));
    }
    entry.modelsAt = this.#now();
  }
}

/** A detected binary that changed on disk (size, mtime) or vanished since detection. */
function binaryChanged(binary: CliBinary | null): boolean {
  if (binary === null) return false;
  try {
    const st = statSync(binary.realPath);
    return st.size !== binary.stat.size || st.mtimeMs !== binary.stat.mtimeMs;
  } catch {
    return true;
  }
}
