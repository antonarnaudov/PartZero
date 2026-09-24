/**
 * `PartZero --self-test` (docs/ALPHA-0-PLAN.md W1, G1 #2): the packaged app starts hidden on a throwaway profile,
 * checks what a first run needs, prints one JSON report on stdout and exits (0 when every required check passed).
 * It is read-only for the user's own data: the real profile's `agent-settings.json` is copied into the throwaway
 * profile (so a Claude Code path set in Settings is honored), and nothing else of it is read or written.
 *
 * No model is ever called: Claude Code is only asked for `--version`, `--help` and `auth status` (what Settings shows).
 *
 * This module holds the electron-free parts (unit-tested); `main.ts` drives the app and the processes.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSettingsView, CliProviderStatus } from "@aicad/app/bridge";
import type { WorkerSelfTestReport } from "./agent/self-test.js";
import type { BuildInfo } from "./build-info.js";
import type { ForgeSelfCheck } from "./forge-cli.js";
import { userFolders } from "./user-folders.js";

export const SELF_TEST_SWITCH = "--self-test";
export const SELF_TEST_SCHEMA = "partzero.self-test/1";
/**
 * The whole self-test's limit (main.ts starts it with the app). Every probe has its own shorter timeout (120 s), so
 * this only fires when something hangs outside them; the app then prints {@link abortedSelfTestReport} and exits.
 * It cannot fire while the main thread is blocked (a synchronous system prompt): the build script's own timeout
 * covers that.
 */
export const SELF_TEST_TIMEOUT_MS = 180_000;
/** Exit codes: every required check passed; a check failed (or the self-test threw); the self-test did not finish. */
export const SELF_TEST_EXIT = { ok: 0, failed: 1, timedOut: 2 } as const;

/** The v0 IR of `agent/self-test.ts` `SELF_TEST_SOURCE` (80 × 50 × 8 mm, 32 000 mm³), for the Forge CLI checks. */
export const SELF_TEST_IR = {
  schema: "aicad.ir/0",
  meta: { name: "self-test", description: "" },
  parts: [
    {
      id: "p1",
      name: "part",
      features: [
        {
          type: "sketch",
          id: "s1",
          name: "base",
          plane: "XY",
          curves: [
            { kind: "line", id: "bottom", start: [-40, -25], end: [40, -25] },
            { kind: "line", id: "right", start: [40, -25], end: [40, 25] },
            { kind: "line", id: "top", start: [40, 25], end: [-40, 25] },
            { kind: "line", id: "left", start: [-40, 25], end: [-40, -25] },
          ],
        },
        { type: "extrude", id: "e1", name: "plate", sketch: "base", distance: 8 },
      ],
    },
  ],
} as const;

/** What the renderer shows once it has loaded and evaluated its starting document (read from the DOM). */
export interface RendererSnapshot {
  url: string;
  shell: boolean;
  crossOriginIsolated: boolean;
  engine: string | null;
  features: Array<{ name: string | null; status: string | null }>;
  bodies: string | null;
  problems: string | null;
  /** The status bar's document status: "Up to date" once Forge evaluated the document with status ok. */
  status: string | null;
}

/**
 * Run in the hidden window (`webContents.executeJavaScript`): the same test ids the e2e suite reads. A string, not a
 * function, because it crosses into the renderer's own world.
 */
export const RENDERER_PROBE = `(() => {
  const q = (id) => document.querySelector('[data-testid="' + id + '"]');
  const text = (id) => { const el = q(id); return el ? (el.textContent || "").trim() : null; };
  return {
    url: location.href,
    shell: q("app-shell") !== null,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    engine: text("engine-label"),
    features: [...document.querySelectorAll('[data-testid="timeline-feature"]')].map((el) => ({ name: el.getAttribute("data-feature"), status: el.getAttribute("data-status") })),
    bodies: text("body-count"),
    problems: text("problems-count"),
    status: text("doc-status"),
  };
})()`;

/** The renderer's own WASM engine (`packages/app` `ForgeWebEngine.label`); a fresh profile picks it first. */
export const RENDERER_WASM_ENGINE = "forge-web · wasm";
/** Engine labels that mean no engine has evaluated anything yet. */
const ENGINE_NOT_READY: ReadonlySet<string> = new Set(["Starting engine…", "No engine"]);
const BODY_COUNT = /^(\d+) bod(?:y|ies)$/;

/**
 * The starting document evaluated in a cross-origin-isolated page: an engine is up, Forge's report came back ok
 * ("Up to date", which needs an evaluation, not only a compile), and there are no problems. Whatever the starting
 * document is: a document with features needs every feature ok and at least one body; an empty one (W2 makes a new
 * document start empty) needs no body. It only has to be evaluated, not to have a particular shape.
 */
export function rendererReady(s: RendererSnapshot | null): s is RendererSnapshot {
  if (s === null || !s.shell || !s.crossOriginIsolated) return false;
  if (s.engine === null || s.engine.length === 0 || ENGINE_NOT_READY.has(s.engine)) return false;
  if (s.problems !== "0" || s.status === null || !s.status.startsWith("Up to date")) return false;
  const bodies = BODY_COUNT.exec(s.bodies ?? "");
  if (bodies === null) return false;
  if (s.features.length === 0) return Number(bodies[1]) === 0;
  return s.features.every((f) => f.status === "ok") && Number(bodies[1]) > 0;
}

/** One line about what the renderer showed, for the report. */
export function describeRenderer(s: RendererSnapshot | null): string {
  if (s === null) return "the page did not answer";
  const what = s.features.length === 0 ? "the empty starting document" : `the starting document (${s.features.length} features, ${s.features.filter((f) => f.status === "ok").length} ok)`;
  return `${s.url}: ${s.engine ?? "no engine label"}, ${what}, ${s.bodies ?? "? bodies"}, ${s.problems ?? "?"} problems, status "${s.status ?? "?"}"${s.crossOriginIsolated ? "" : ", NOT cross-origin isolated"}`;
}

export type ForgeCliCheck = ForgeSelfCheck;

export interface ClaudeCodeCheck {
  ok: boolean;
  detail: string;
  installed: boolean;
  path: string | null;
  pathSource: string | null;
  version: string | null;
  support: string | null;
  lockdownLevel: string | null;
  auth: string | null;
  plan: string | null;
  /** "Using Claude Code (detected)": the provider the default models come from. */
  autoDefault: string | null;
}

export interface SlicerCheck {
  found: boolean;
  name: "Bambu Studio";
  path: string | null;
  bundleId: string | null;
  version: string | null;
}

export interface SelfTestReport {
  schema: typeof SELF_TEST_SCHEMA;
  ok: boolean;
  failures: string[];
  warnings: string[];
  app: {
    name: string;
    version: string;
    edition: string;
    commit: string | null;
    dirty: boolean;
    builtAt: string | null;
    packaged: boolean;
    flags: BuildInfo["flags"];
    electron: string;
    chrome: string;
    node: string;
    platform: string;
    arch: string;
  };
  paths: { profile: string; logs: string; prints: string; reports: string };
  forgeCli: ForgeCliCheck;
  worker: { ok: boolean; detail: string; readyMs: number | null; report: WorkerSelfTestReport | null };
  renderer: { ok: boolean; detail: string; ms: number | null; snapshot: RendererSnapshot | null };
  claudeCode: ClaudeCodeCheck;
  slicer: SlicerCheck;
}

/** Claude Code as Settings sees it: found, runnable (version and lockdown), logged in. */
export function claudeCodeCheck(view: Pick<AgentSettingsView, "cli" | "autoDefault"> | null, error: string | null = null): ClaudeCodeCheck {
  const s: CliProviderStatus | undefined = view?.cli?.find((c) => c.id === "claude-cli");
  const autoDefault = view?.autoDefault?.label ?? null;
  if (!s) {
    return { ok: false, detail: error ?? "Claude Code was not checked (CLI providers are off in this build)", installed: false, path: null, pathSource: null, version: null, support: null, lockdownLevel: null, auth: null, plan: null, autoDefault };
  }
  const ready = s.support === "ready";
  const loggedIn = s.auth === "logged_in";
  const detail = !s.installed
    ? `not installed: ${s.supportDetail}`
    : !ready
      ? `${s.support}: ${s.supportDetail}`
      : !loggedIn
        ? `installed but not logged in (${s.auth}): ${s.loginHint}`
        : `Claude Code ${s.version ?? "?"} at ${s.path ?? "?"} (${s.pathSource ?? "?"}), ${s.lockdownLevel ?? "?"} lockdown, logged in${s.plan ? ` (${s.plan} plan)` : ""}`;
  return {
    ok: ready && loggedIn,
    detail,
    installed: s.installed,
    path: s.path,
    pathSource: s.pathSource,
    version: s.version,
    support: s.support,
    lockdownLevel: s.lockdownLevel,
    auth: s.auth,
    plan: s.plan,
    autoDefault,
  };
}

/**
 * The verdict: every required check, with a failure line for each one that did not pass. Bambu Studio is reported
 * but not required (without it, Open in Bambu Studio falls back to a plain export), and neither is the MCP shim in a
 * build that does not run it.
 */
export function selfTestVerdict(r: Omit<SelfTestReport, "ok" | "failures" | "warnings" | "schema">): { ok: boolean; failures: string[]; warnings: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];
  if (!r.forgeCli.ok) failures.push(`Forge CLI: ${r.forgeCli.detail}`);
  if (!r.worker.ok) failures.push(`agent worker: ${r.worker.detail}`);
  const w = r.worker.report;
  if (w) {
    for (const [name, c] of [
      ["CadScript", w.cadscript],
      ["forge-web engine", w.engine],
      ["v0 evaluation (forge-web)", w.v0],
      ["v1 evaluation (forge-web)", w.v1],
      ["prompts", w.prompts],
      ["CLI agent runtime", w.cliRuntime],
    ] as const) {
      if (!c.ok) failures.push(`${name}: ${c.detail}`);
    }
    if (!w.mcp.ok) (r.app.flags.mcpShim || !r.app.packaged ? failures : warnings).push(`CAD MCP server: ${w.mcp.detail}`);
  }
  if (!r.renderer.ok) failures.push(`renderer: ${r.renderer.detail}`);
  else if (r.renderer.snapshot !== null && r.renderer.snapshot.engine !== RENDERER_WASM_ENGINE) {
    warnings.push(`the renderer evaluates with ${r.renderer.snapshot.engine ?? "?"}, not ${RENDERER_WASM_ENGINE}: the WASM engine did not start in the page`);
  }
  if (!r.claudeCode.ok) failures.push(`Claude Code: ${r.claudeCode.detail}`);
  if (!r.slicer.found) warnings.push("Bambu Studio was not found in /Applications or ~/Applications: Open in Bambu Studio falls back to a plain export");
  if (r.app.packaged && r.app.commit === null) warnings.push("the build has no commit (it was not bundled from a git checkout)");
  if (r.app.dirty) warnings.push("the build was bundled from a working tree with uncommitted changes");
  return { ok: failures.length === 0, failures, warnings };
}

/**
 * The report of a self-test that could not finish (the watchdog fired, or the self-test threw): `ok: false`, the
 * reason as the only failure, and every check marked as not finished. Same shape as a finished report, so every
 * reader (the build script, the e2e suite) handles it.
 */
export function abortedSelfTestReport(reason: string, app: SelfTestReport["app"], paths: SelfTestReport["paths"]): SelfTestReport {
  const notFinished = `not finished: ${reason}`;
  return {
    schema: SELF_TEST_SCHEMA,
    ok: false,
    failures: [reason],
    warnings: [],
    app,
    paths,
    forgeCli: { ok: false, path: "", version: null, detail: notFinished, v0: null, v1: null },
    worker: { ok: false, detail: notFinished, readyMs: null, report: null },
    renderer: { ok: false, detail: notFinished, ms: null, snapshot: null },
    claudeCode: claudeCodeCheck(null, notFinished),
    slicer: { found: false, name: "Bambu Studio", path: null, bundleId: null, version: null },
  };
}

type Exec = (file: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string }>;

/** `execFile` without a shell, with a timeout and a size cap (ADR 0016 §2: a launched tool's output is capped). */
export const execCapped: Exec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 256 * 1024, shell: false, windowsHide: true }, (error, stdout) => {
      const exit = (error as { code?: unknown } | null)?.code;
      resolve({ code: error === null ? 0 : typeof exit === "number" ? exit : null, stdout: String(stdout ?? "") });
    });
  });

/**
 * Bambu Studio where the user installed it (ADR 0016 §3: we launch the installed slicer; we never bundle it):
 * `/Applications`, then `~/Applications`; the version and bundle id from its Info.plist (read with `plutil`). W5's
 * `slicer:detect` adds the LaunchServices lookup and a path set in Settings.
 */
export async function detectBambuStudio(o: { home?: string; exists?: (p: string) => boolean; exec?: Exec } = {}): Promise<SlicerCheck> {
  const home = o.home ?? homedir();
  const exists = o.exists ?? existsSync;
  const exec = o.exec ?? execCapped;
  const none: SlicerCheck = { found: false, name: "Bambu Studio", path: null, bundleId: null, version: null };
  if (process.platform !== "darwin" && o.exists === undefined) return none;
  const path = ["/Applications/BambuStudio.app", join(home, "Applications", "BambuStudio.app")].find((p) => exists(join(p, "Contents", "Info.plist")));
  if (path === undefined) return none;
  const plist = join(path, "Contents", "Info.plist");
  const read = async (key: string): Promise<string | null> => {
    const r = await exec("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], 5_000);
    const v = r.stdout.trim();
    return r.code === 0 && v.length > 0 && v.length < 200 ? v : null;
  };
  return { found: true, name: "Bambu Studio", path, bundleId: await read("CFBundleIdentifier"), version: await read("CFBundleShortVersionString") };
}

/** Where the report says the app keeps its files (the profile is the real one, not the throwaway self-test profile). */
export function reportPaths(o: { profile: string; logs: string; home?: string }): SelfTestReport["paths"] {
  const folders = userFolders(o.home ?? homedir());
  return { profile: o.profile, logs: o.logs, prints: folders.prints, reports: folders.reports };
}
