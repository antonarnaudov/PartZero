import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { absolutePathEntries } from "./env.js";
import type { CliHelpInfo, DetectOptions } from "./provider.js";
import { runCommand } from "./process.js";

/**
 * Binary discovery and version/help parsing (docs/CLI-PROVIDERS.md §5.2 L11, §11.2). Only absolute real paths are
 * used; relative and `.` PATH entries are ignored and nothing is ever run from a workspace.
 */

export interface ResolvedBinary {
  path: string;
  realPath: string;
  source: "settings" | "path" | "known-dir" | "login-shell";
  stat: { size: number; mtimeMs: number };
}

/** Common install directories (§11.2). Provider-specific ones are added by each provider. */
export function commonInstallDirs(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const home = env["HOME"] ?? env["USERPROFILE"] ?? homedir();
  const dirs = [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
  ];
  const appData = env["APPDATA"];
  if (appData !== undefined) dirs.push(join(appData, "npm"));
  return dirs;
}

function executableNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  return [`${name}.exe`, `${name}.cmd`, name];
}

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function toResolved(path: string, source: ResolvedBinary["source"]): ResolvedBinary | null {
  if (!isAbsolute(path) || !isExecutableFile(path)) return null;
  try {
    const realPath = realpathSync(path);
    const st = statSync(realPath);
    return { path, realPath, source, stat: { size: st.size, mtimeMs: st.mtimeMs } };
  } catch {
    return null;
  }
}

let loginShellCache: Map<string, string | null> | null = null;

async function loginShellLookup(name: string, env: Readonly<Record<string, string>>): Promise<string | null> {
  loginShellCache ??= new Map();
  if (loginShellCache.has(name)) return loginShellCache.get(name) ?? null;
  const shell = env["SHELL"] ?? process.env["SHELL"];
  let found: string | null = null;
  if (process.platform !== "win32" && shell !== undefined && isAbsolute(shell) && /^[A-Za-z0-9_.-]+$/.test(name)) {
    const r = await runCommand(shell, ["-ilc", `command -v ${name}`], { cwd: homedir(), env: { ...env, TERM: "dumb" }, timeoutMs: 5_000, maxBytes: 16_384 });
    const line = r.stdout.split("\n").map((l) => l.trim()).find((l) => isAbsolute(l));
    found = r.code === 0 && line !== undefined ? line : null;
  }
  loginShellCache.set(name, found);
  return found;
}

/** Test hook: forget the once-per-session login-shell lookups. */
export function resetLoginShellCache(): void {
  loginShellCache = null;
}

/** Locate a CLI: Settings override, then absolute PATH entries, then known dirs, then (optionally) a login shell. */
export async function resolveBinary(names: readonly string[], options: DetectOptions): Promise<ResolvedBinary | null> {
  if (options.overridePath !== null) {
    const base = basename(options.overridePath).replace(/\.(exe|cmd)$/i, "");
    if (!names.includes(base)) return null;
    return toResolved(options.overridePath, "settings");
  }
  const delimiter = process.platform === "win32" ? ";" : ":";
  for (const dir of absolutePathEntries(options.env["PATH"], delimiter)) {
    for (const name of names) for (const exe of executableNames(name)) {
      const r = toResolved(join(dir, exe), "path");
      if (r !== null) return r;
    }
  }
  for (const dir of options.extraDirs) {
    if (!isAbsolute(dir)) continue;
    for (const name of names) for (const exe of executableNames(name)) {
      const r = toResolved(join(dir, exe), "known-dir");
      if (r !== null) return r;
    }
  }
  if (options.loginShell) {
    for (const name of names) {
      const p = await loginShellLookup(name, options.env);
      if (p !== null) {
        const r = toResolved(p, "login-shell");
        if (r !== null) return r;
      }
    }
  }
  return null;
}

/** First `x.y.z`-like run of digits in a version string (`2.1.260 (Claude Code)`, `codex-cli 0.156.1`, `2026.01.28-fd13201`). */
export function normalizeVersion(raw: string): string {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (m === null) return raw.trim();
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3] ?? 0)}`;
}

function parts(v: string): number[] {
  return normalizeVersion(v)
    .split(".")
    .map((x) => (x === "x" ? Number.POSITIVE_INFINITY : Number(x)));
}

/** Numeric compare of normalized versions. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** `to` may end in `.x` (`0.49.x` = any 0.49 patch). */
export function versionInRange(version: string, range: { from: string; to: string } | null): boolean {
  if (range === null) return false;
  if (compareVersions(version, range.from) < 0) return false;
  const to = range.to;
  if (to.endsWith(".x")) {
    const prefix = to.slice(0, -2).split(".").map(Number);
    const v = normalizeVersion(version).split(".").map(Number);
    return prefix.every((n, i) => v[i] === n);
  }
  return compareVersions(version, to) <= 0;
}

/**
 * Parse `--help` text: every `--long-flag` and `-s` short flag of an option row, the command names listed under a
 * Commands section, and `(choices: "a", "b")` / `[choices: "a", "b"]` per flag. Tolerant of commander, yargs and
 * clap layouts.
 */
export function parseHelp(texts: readonly string[]): CliHelpInfo {
  const flags = new Set<string>();
  const subcommands = new Set<string>();
  const choices = new Map<string, string[]>();
  for (const text of texts) {
    const lines = text.replace(/\r/g, "").split("\n");
    const usage = /^\s*usage:\s+(\S+)/im.exec(text);
    const program = usage?.[1] === undefined ? null : basename(usage[1]);
    let section = "";
    let current: string[] = [];
    let entryText = "";
    const flush = (): void => {
      if (current.length > 0) {
        const m = /[([]choices:\s*((?:"[^"]*"\s*,?\s*)+)/.exec(entryText.replace(/\s+/g, " "));
        if (m?.[1] !== undefined) {
          const values = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1] ?? "");
          for (const f of current) choices.set(f, values);
        }
      }
      current = [];
      entryText = "";
    };
    for (const line of lines) {
      const header = /^([A-Za-z][A-Za-z ]*):\s*$/.exec(line);
      if (header !== null) {
        flush();
        section = (header[1] ?? "").toLowerCase();
        continue;
      }
      if (/^\s{0,8}-{1,2}[A-Za-z0-9]/.test(line)) {
        flush();
        const head = line.trim().split(/\s{2,}/)[0] ?? "";
        for (const f of head.matchAll(/(?:^|[\s,])(--?[A-Za-z0-9][\w-]*)/g)) {
          if (f[1] === undefined) continue;
          flags.add(f[1]);
          current.push(f[1]);
        }
        entryText = line;
        continue;
      }
      if (current.length > 0 && /^\s+\S/.test(line)) {
        entryText += ` ${line.trim()}`;
        continue;
      }
      flush();
      if (section.startsWith("command") && /^\s+\S/.test(line)) {
        const words = line.trim().split(/\s+/);
        let word = words[0];
        if (word !== undefined && program !== null && word === program && words.length > 1) word = words[1];
        if (word !== undefined && /^[a-z][\w-]*(\|[a-z][\w-]*)*$/.test(word)) subcommands.add(word.split("|")[0] ?? word);
      }
    }
    flush();
  }
  const sha256 = createHash("sha256").update(texts.join("\n\u0000\n")).digest("hex");
  return { flags, subcommands, sha256, choices };
}

/** For Node-script CLIs: a directory that holds `node`, preferring the one next to the binary's symlink. */
export function nodeDirFor(binaryPath: string, env: Readonly<Record<string, string>>): string | undefined {
  const name = process.platform === "win32" ? "node.exe" : "node";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const candidates = [dirname(binaryPath), ...absolutePathEntries(env["PATH"], delimiter)];
  for (const dir of candidates) if (isExecutableFile(join(dir, name))) return dir;
  return undefined;
}
