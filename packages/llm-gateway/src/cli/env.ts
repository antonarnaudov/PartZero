import { isAbsolute } from "node:path";

/**
 * The environment a CLI child gets (docs/CLI-PROVIDERS.md §5.3, frozen). Allowlist first, then a deny pattern, then
 * forced values, then provider extras. No credential variable from the host ever reaches a CLI: the CLI uses its own
 * login, stored where it keeps it (the location variables below point there, they never carry a secret).
 */

/** Inherited from the host when present (the desktop worker's env is already allowlisted: env.ts CHILD_ENV_ALLOWLIST). */
export const CLI_ENV_BASE: readonly string[] = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_NUMERIC", "TZ",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
];
/** Where a CLI keeps its own login and config. Never credential values. */
export const CLI_ENV_LOCATION: readonly string[] = [
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME",
];
/** Needed behind corporate proxies. May embed proxy credentials: forwarded, never logged. */
export const CLI_ENV_NETWORK: readonly string[] = [
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
];
/** Applied to every inherited name except CLI_ENV_NETWORK. A match is dropped even if listed above. */
export const CLI_ENV_DENY = /(API_?KEY|TOKEN|SECRET|PASSW|CREDENTIAL|COOKIE|PRIVATE|(^|_)AUTH($|_))/i;

/** Never inherited from the host, whatever the lists say. Provider extras may still set them. */
const ALWAYS_REMOVED_EXACT = new Set(["CI", "GITHUB_ACTIONS", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "CLAUDECODE", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CURSOR_API_KEY"]);
const ALWAYS_REMOVED_PREFIX = /^(CLAUDE_CODE_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_)/;
const PREFIX_EXCEPTIONS = new Set(["GEMINI_CLI_HOME"]);

export interface CliEnvOptions {
  /** `workspace.tmp`. */
  tmpDir: string;
  /** `dirname(binary.realPath)`, prepended to PATH. */
  binaryDir: string;
  /** For Node-script CLIs (gemini, npm-installed codex/opencode). */
  nodeDir?: string;
  /** Provider-documented non-secret vars + AICAD_MCP_TICKET / AICAD_MCP_BRIDGE. Applied last. */
  extra: Readonly<Record<string, string>>;
}

function removedAlways(name: string): boolean {
  if (ALWAYS_REMOVED_EXACT.has(name)) return true;
  return ALWAYS_REMOVED_PREFIX.test(name) && !PREFIX_EXCEPTIONS.has(name);
}

/** PATH with relative and empty entries removed (a relative entry could resolve into a workspace: T7). */
export function absolutePathEntries(path: string | undefined, delimiter: string): string[] {
  if (path === undefined) return [];
  return path.split(delimiter).filter((p) => p.length > 0 && isAbsolute(p));
}

export function cliChildEnv(parent: Readonly<Record<string, string | undefined>>, options: CliEnvOptions): Record<string, string> {
  const win = (parent["OS"] ?? "").toLowerCase().includes("windows") || globalThis.process?.platform === "win32";
  const delimiter = win ? ";" : ":";
  const env: Record<string, string> = {};
  for (const name of [...CLI_ENV_BASE, ...CLI_ENV_LOCATION]) {
    const v = parent[name];
    if (v === undefined || removedAlways(name) || CLI_ENV_DENY.test(name)) continue;
    env[name] = v;
  }
  for (const name of CLI_ENV_NETWORK) {
    const v = parent[name];
    if (v !== undefined) env[name] = v;
  }
  const pathEntries = [options.binaryDir, ...(options.nodeDir === undefined ? [] : [options.nodeDir]), ...absolutePathEntries(parent["PATH"], delimiter)];
  env["PATH"] = [...new Set(pathEntries.filter((p) => p.length > 0))].join(delimiter);
  env["TMPDIR"] = options.tmpDir;
  env["TEMP"] = options.tmpDir;
  env["TMP"] = options.tmpDir;
  env["NO_COLOR"] = "1";
  env["FORCE_COLOR"] = "0";
  env["TERM"] = "dumb";
  env["NO_BROWSER"] = "true";
  env["NO_OPEN_BROWSER"] = "1";
  for (const [k, v] of Object.entries(options.extra)) env[k] = v;
  return env;
}

/**
 * Values that must never appear in logs or stderr tails: the MCP ticket, anything whose name matches the deny
 * pattern, and proxy settings (which may embed credentials).
 */
export function secretValues(env: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v.length < 6) continue;
    if (k === "AICAD_MCP_TICKET" || CLI_ENV_DENY.test(k) || CLI_ENV_NETWORK.includes(k)) out.push(v);
  }
  return out;
}
