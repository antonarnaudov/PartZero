/**
 * Main-process wiring of the agent: key store (safeStorage), settings, environment/.env keys in
 * development, the transport (live / scripted / replay), provider detection (CLI agents, Ollama) and
 * the utility process factory.
 *
 * Environment (all optional; development and tests only: a packaged build always uses the live
 * transport and never reads a `.env`):
 * - `AICAD_AGENT_TRANSPORT` = `live` (default) | `scripted` | `replay`
 * - `AICAD_AGENT_SCRIPT`    = JSON script for `scripted` (see `runner.ts` `parseScriptFile`)
 * - `AICAD_AGENT_FIXTURES`  = JSON fixture array for `replay` (`@aicad/llm-gateway` `Fixture[]`)
 * - `AICAD_AGENT_DOTENV`    = path of the `.env` read in development, or `off` (default: `<repo>/.env`)
 * - `AICAD_CLI_DIRS`        = look for CLI agents only in these directories (read by `env.ts`)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentEvent, CliProviderId } from "@aicad/app/bridge";
import { CLI_PROVIDERS, defaultWorkspaceRoot, probeOllama, setDefaultWorkspaceRoot, unsafeAncestor } from "@aicad/llm-gateway/cli";
import { CliDetector } from "./cli-detect.js";
import { AgentHost, type CliRunSetup, type WorkerHandle } from "./host.js";
import { KeyResolver, KeyStore, keysFromVariables, parseDotenv, type Cipher } from "./keys.js";
import { LocalModels, type OllamaProbe } from "./local-detect.js";
import { brokerSocketFits, type TransportConfig } from "./protocol.js";
import { SettingsStore } from "./settings.js";
import { clearCliWorkspaces } from "./workspaces.js";

export function transportFromEnv(env: NodeJS.ProcessEnv, warn: (m: string) => void = () => undefined, isPackaged = false): TransportConfig {
  if (isPackaged) {
    if (env["AICAD_AGENT_TRANSPORT"]) warn("AICAD_AGENT_TRANSPORT is ignored in packaged builds; using the live transport");
    return { kind: "live" };
  }
  const kind = env["AICAD_AGENT_TRANSPORT"] ?? "live";
  if (kind === "scripted") {
    const scriptPath = env["AICAD_AGENT_SCRIPT"];
    if (scriptPath && existsSync(scriptPath)) return { kind: "scripted", scriptPath };
    warn(`AICAD_AGENT_TRANSPORT=scripted needs AICAD_AGENT_SCRIPT pointing to a script file; using the live transport`);
  } else if (kind === "replay") {
    const fixturesPath = env["AICAD_AGENT_FIXTURES"];
    if (fixturesPath && existsSync(fixturesPath)) return { kind: "replay", fixturesPath };
    warn(`AICAD_AGENT_TRANSPORT=replay needs AICAD_AGENT_FIXTURES pointing to a fixtures file; using the live transport`);
  } else if (kind !== "live") {
    warn(`unknown AICAD_AGENT_TRANSPORT=${kind}; using the live transport`);
  }
  return { kind: "live" };
}

/** Keys from a development `.env` (never read in packaged builds). */
export function dotenvKeys(env: NodeJS.ProcessEnv, repoRoot: string | null, isPackaged: boolean): ReturnType<typeof keysFromVariables> {
  if (isPackaged) return {};
  const setting = env["AICAD_AGENT_DOTENV"];
  if (setting === "off") return {};
  const path = setting ?? (repoRoot ? join(repoRoot, ".env") : null);
  if (!path || !existsSync(path)) return {};
  try {
    return keysFromVariables(parseDotenv(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

/**
 * The workspace's `packages/mcp-server` in development (the shim must be built), or null. Packaged builds have no
 * workspace; they would ship the package itself.
 */
export function workspaceMcpServerDir(repoRoot: string | null): string | null {
  if (repoRoot === null) return null;
  const dir = join(repoRoot, "packages", "mcp-server");
  return existsSync(join(dir, "dist", "stdio.js")) ? dir : null;
}

/** The gateway's own private default root (per-user temp dir, `$XDG_RUNTIME_DIR` or the cache dir), ignoring any override. */
function gatewayDefaultRoot(): string {
  setDefaultWorkspaceRoot(null);
  return defaultWorkspaceRoot();
}

/** This app profile's own folder inside the gateway's shared default root (`app-<10 hex of the userData path>`). */
export function profileWorkspaceDir(userData: string): string {
  return `app-${createHash("sha256").update(userData).digest("hex").slice(0, 10)}`;
}

/**
 * The private root for CLI workspaces, broker sockets and detection probes (docs/CLI-PROVIDERS.md §5.4). Every folder
 * above it must be private (another local user must not be able to write to it: opencode reads `opencode.json`,
 * `.opencode/` and `AGENTS.md` from every folder above its cwd, other CLIs discover context files the same way), and
 * the broker socket `<root>/s/<8 hex>/b.sock` should fit the 103-byte limit.
 *
 * 1. `<userData>/cli-work` when every folder above it is private and the socket fits;
 * 2. else this profile's own folder in the gateway's private default root (on macOS the per-user
 *    `/var/folders/…/T/aicad-cli/app-<hash>`; never a shared `/tmp`) when that fits and every folder above it is private;
 * 3. else `<userData>/cli-work` if at least its ancestors are private: the worker turns the MCP broker off
 *    (`runner.ts`), so CLI providers run one call at a time and Gemini CLI and opencode answer through the strict JSON reply;
 * 4. else no root (`null`): CLI providers are off, with the note saying why.
 *
 * The root is exclusive to this app instance (the single-instance lock is per userData folder, and the fallback is a
 * per-profile folder), which is what lets the app empty it at start and on quit (`workspaces.ts`).
 */
export function cliWorkspaceRoot(userData: string, fallback: () => string = gatewayDefaultRoot): { root: string | null; note: string | null } {
  const own = join(userData, "cli-work");
  const shared = unsafeAncestor(userData);
  if (shared === null && brokerSocketFits(own)) return { root: own, note: null };
  let alt: string | null = null;
  try {
    alt = join(fallback(), profileWorkspaceDir(userData));
  } catch {
    alt = null;
  }
  const why =
    shared === null
      ? "the path of the app's data folder is too long for the MCP broker socket (103 bytes)"
      : `the app's data folder is inside ${shared}, which other users of this computer can write to`;
  if (alt !== null && brokerSocketFits(alt) && unsafeAncestor(dirname(alt)) === null) {
    return { root: alt, note: `CLI workspaces use ${alt}: ${why}` };
  }
  if (shared === null) return { root: own, note: `${why} and no shorter private folder was found: CLI agents run one call at a time` };
  return { root: null, note: `CLI agents are off: ${why}, and no private folder was found for their workspaces (CLIs read config files from every folder above their working folder)` };
}

/**
 * The detector's login-shell option: never with a restricted search (`AICAD_CLI_DIRS`, test profiles), else the CLIs
 * the build allows (`build-info.ts` `loginShellProviders`), or every CLI.
 */
export function detectorLoginShell(cliDirs: readonly string[] | null, loginShellProviders: readonly CliProviderId[] | null): boolean | readonly CliProviderId[] {
  if (cliDirs !== null) return false;
  return loginShellProviders ?? true;
}

export interface AgentSetupOptions {
  userData: string;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  repoRoot: string | null;
  forgeBin: string;
  cipher: Cipher;
  spawnWorker(): WorkerHandle;
  send(event: AgentEvent): void;
  log(level: "info" | "warn" | "error", message: string): void;
  /** The environment detection probes run with (`env.ts` `cliDetectEnv`). */
  detectEnv: Record<string, string>;
  /** Development and tests: search CLIs only here (`AICAD_CLI_DIRS`). */
  cliDirs: string[] | null;
  /**
   * The CLIs the login-shell lookup may run for (`build-info.ts` `loginShellProviders`); null or absent: every CLI.
   * Never used with {@link cliDirs} (a restricted search has no login shell).
   */
  loginShellProviders?: readonly CliProviderId[] | null;
  /** The app executable, for the MCP shim; null when it cannot run as Node (packaged: the runAsNode fuse is off). */
  exePath: string | null;
  /** Ollama probe (tests inject one; default: HTTP to the configured base URL). */
  ollamaProbe?: OllamaProbe;
  /** Probe the default Ollama URL (false in isolated test profiles: only an explicitly configured URL is probed). */
  detectLocalModels?: boolean;
  /** CLI login locations and proxy settings, for CLI children only (`env.ts` `cliChildHostEnv`). */
  cliChildEnv?: Record<string, string>;
  /** What the `auto` CLI mode means (`env.ts` `DevOverrides.cliAutoMode`; default `runtime`). */
  cliAutoMode?: "runtime" | "completion";
  /**
   * Whether this build takes API keys (`build-info.ts` `flags.apiKeys`; default true). False: no key store, no keys
   * from the environment or a `.env`, and no keychain access at all (the Alpha 0 build runs on Claude Code only).
   */
  apiKeys?: boolean;
  /**
   * The bundled MCP shim (`bundle/mcp/stdio.mjs`, asar-unpacked in a packaged build), or null: then development runs
   * use the workspace's `packages/mcp-server`, and a packaged build has none.
   */
  mcpShimPath?: string | null;
}

export interface AgentSetup {
  host: AgentHost;
  keys: KeyResolver;
  settings: SettingsStore;
  cli: CliDetector;
  local: LocalModels;
  /** The private root CLI runs use for workspaces and broker sockets ({@link cliWorkspaceRoot}), or null: CLIs are off. */
  workspaceRoot: string | null;
}

export function setupAgent(o: AgentSetupOptions): AgentSetup {
  const apiKeys = o.apiKeys ?? true;
  const store = new KeyStore(join(o.userData, "agent-keys.json"), o.cipher, { enabled: apiKeys });
  const keys = apiKeys ? new KeyResolver(store, keysFromVariables(o.env), dotenvKeys(o.env, o.repoRoot, o.isPackaged)) : new KeyResolver(store);
  const settings = new SettingsStore(join(o.userData, "agent-settings.json"));
  const transport = transportFromEnv(o.env, (m) => o.log("warn", m), o.isPackaged);
  // CLI workspaces, broker sockets and detection probes live under a private folder whose socket path fits (§5.4).
  const { root: workspaceRoot, note: rootNote } = cliWorkspaceRoot(o.userData);
  if (rootNote !== null) o.log(workspaceRoot === null ? "warn" : "info", rootNote);
  if (workspaceRoot !== null) {
    setDefaultWorkspaceRoot(workspaceRoot);
    // The root is this instance's alone and nothing runs yet: what is there was left by a session that crashed or was
    // killed before it could clean up (§5.8).
    const stale = clearCliWorkspaces(workspaceRoot);
    if (stale > 0) o.log("info", `removed ${stale} CLI workspace folder(s) left by an earlier session`);
  }
  const cli = new CliDetector({
    // No private root: no CLI is ever probed or run (Settings and the start precheck say why).
    providers: workspaceRoot === null ? new Map() : CLI_PROVIDERS,
    env: () => o.detectEnv,
    cliPaths: () => settings.get().cliPaths,
    searchDirs: o.cliDirs,
    loginShell: detectorLoginShell(o.cliDirs, o.loginShellProviders ?? null),
    // Lockdown blocks survive a restart (§5.5): only a passing Re-check or a changed binary lifts one.
    blocks: { load: () => settings.get().cliBlocks, save: (blocks) => settings.setCliBlocks(blocks) },
    log: o.log,
  });
  const probe: OllamaProbe = o.ollamaProbe ?? ((url, options) => probeOllama(url, options));
  const local = new LocalModels({
    baseUrl: () => settings.get().ollamaBaseUrl,
    probe: (url, options) =>
      o.detectLocalModels === false && settings.get().ollamaBaseUrl === null
        ? Promise.resolve({ running: false, version: null, models: [], detail: "Local model detection is off in this isolated test profile (set an Ollama URL to probe one)." })
        : probe(url, options),
  });
  const cliRun: CliRunSetup | null =
    workspaceRoot === null
      ? null
      : {
          workspaceRoot,
          exePath: o.exePath,
          mcpServerDir: o.isPackaged || o.mcpShimPath ? null : workspaceMcpServerDir(o.repoRoot),
          mcpShimPath: o.mcpShimPath ?? null,
          childEnv: { ...(o.cliChildEnv ?? {}) },
          autoMode: o.cliAutoMode ?? "runtime",
        };
  const host = new AgentHost({
    spawnWorker: o.spawnWorker,
    keys,
    settings,
    transport,
    forgeBin: o.forgeBin,
    send: o.send,
    log: o.log,
    cli,
    local,
    ...(cliRun !== null ? { cliRun } : { cliOff: rootNote ?? "CLI agents are off: no private folder was found for their workspaces" }),
  });
  return { host, keys, settings, cli, local, workspaceRoot };
}
