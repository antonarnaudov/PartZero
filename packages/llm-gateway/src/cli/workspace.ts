import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

/**
 * A fresh, empty, 0700 working directory per CLI invocation (docs/CLI-PROVIDERS.md §5.4, frozen). No user file is
 * ever placed here: design code reaches the model through the transcript or through `get_code`. The CLI's TMPDIR
 * points inside it, so crash reports and temp files are removed with it.
 */
export interface CliWorkspace {
  /** CLI cwd; empty except the files the provider writes. */
  readonly dir: string;
  /** `<dir>/.tmp`, the CLI's TMPDIR. */
  readonly tmp: string;
  /** Short path for the broker socket (macOS sun_path <= 103 bytes). */
  readonly socketDir: string;
  /** Refuses "..", absolute paths and symlinks. (additive) `encoding: "base64"` writes decoded bytes. */
  write(relPath: string, content: string, mode?: 0o400 | 0o600, encoding?: "utf8" | "base64"): string;
  /** rm -rf dir and socketDir unless `keep`. Idempotent. */
  dispose(): Promise<void>;
}

export const WORKSPACE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let rootOverride: string | null = null;

/**
 * (additive) Host override for {@link defaultWorkspaceRoot}, e.g. `<Electron userData>/cli-work`. It is used by the
 * transport's default workspaces AND by detection probes. `null` restores the built-in choice.
 */
export function setDefaultWorkspaceRoot(root: string | null): void {
  if (root !== null && !isAbsolute(root)) throw new Error("the CLI workspace root must be an absolute path");
  rootOverride = root;
}

/**
 * The first existing ancestor of `path` (itself included) that another local user could write into: not a
 * directory, owned by someone other than the current user or root, or group/other-writable (a sticky `/tmp` counts:
 * others can still CREATE files there). `null` when every ancestor is private. Always `null` on Windows.
 *
 * Why it matters (§5.4): opencode reads project config (`opencode.json`, `.opencode/` plugins and MCP servers,
 * `AGENTS.md`) from every folder above its cwd when there is no git repo, and other CLIs discover context files
 * the same way. A workspace under a shared folder would let another user plant one.
 */
export function unsafeAncestor(path: string): string | null {
  if (process.platform === "win32") return null;
  const uid = globalThis.process?.getuid?.();
  let p = normalize(path);
  for (;;) {
    let st: ReturnType<typeof statSync> | null = null;
    try {
      st = statSync(p);
    } catch {
      st = null; // not created yet
    }
    if (st !== null) {
      if (!st.isDirectory()) return p;
      if (uid !== undefined && st.uid !== uid && st.uid !== 0) return p;
      if ((Number(st.mode) & 0o022) !== 0) return p;
    }
    const parent = dirname(p);
    if (parent === p) return null;
    p = parent;
  }
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The default root, whose every ancestor is private (§5.4): {@link setDefaultWorkspaceRoot} when set, else
 * `realpath(os.tmpdir())/aicad-cli` when the temp dir is per-user (macOS `/var/folders/...`, Windows `%TEMP%`), else
 * `$XDG_RUNTIME_DIR/aicad-cli`, else the user cache dir (`~/Library/Caches`, `%LOCALAPPDATA%`, `$XDG_CACHE_HOME` or
 * `~/.cache`) + `/aicad-cli`. A shared `/tmp` is never used.
 */
export function defaultWorkspaceRoot(): string {
  if (rootOverride !== null) return rootOverride;
  const env = globalThis.process?.env ?? {};
  const home = env["HOME"] ?? homedir();
  const candidates: string[] = [join(realOrSelf(tmpdir()), "aicad-cli")];
  const runtime = env["XDG_RUNTIME_DIR"];
  if (runtime !== undefined && isAbsolute(runtime)) candidates.push(join(realOrSelf(runtime), "aicad-cli"));
  const cache =
    process.platform === "darwin"
      ? join(home, "Library", "Caches")
      : process.platform === "win32"
        ? (env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"))
        : env["XDG_CACHE_HOME"] !== undefined && isAbsolute(env["XDG_CACHE_HOME"])
          ? env["XDG_CACHE_HOME"]
          : join(home, ".cache");
  candidates.push(join(realOrSelf(cache), "aicad-cli"));
  for (const c of candidates) if (unsafeAncestor(dirname(c)) === null) return c;
  return candidates[candidates.length - 1] as string;
}

/** (additive) A fresh, empty, private directory for a no-model probe (`--version`, `--help`, `mcp list`) under the root. */
export function createProbeDir(root: string = defaultWorkspaceRoot()): string {
  ensurePrivateDir(root);
  const dir = join(root, hex(8));
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`CLI workspace root ${path} is not a directory`);
  const uid = globalThis.process?.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Error(`CLI workspace root ${path} is not owned by the current user`);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export async function createCliWorkspace(options: { root?: string; runId: string; keep?: boolean; basename?: string }): Promise<CliWorkspace> {
  const root = options.root ?? defaultWorkspaceRoot();
  ensurePrivateDir(root);
  const base = options.basename ?? "w";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(base) || base === "." || base === "..") throw new Error(`invalid workspace basename '${base}'`);
  const holder = join(root, hex(8));
  mkdirSync(holder, { mode: 0o700 });
  const dir = join(holder, base);
  mkdirSync(dir, { mode: 0o700 });
  const tmp = join(dir, ".tmp");
  mkdirSync(tmp, { mode: 0o700 });
  const sockets = join(root, "s");
  ensurePrivateDir(sockets);
  const socketDir = join(sockets, hex(4));
  mkdirSync(socketDir, { mode: 0o700 });
  let disposed = false;

  return {
    dir,
    tmp,
    socketDir,
    write(relPath: string, content: string, mode: 0o400 | 0o600 = 0o400, encoding: "utf8" | "base64" = "utf8"): string {
      if (relPath.length === 0 || isAbsolute(relPath) || relPath.split(/[\\/]/).includes("..")) {
        throw new Error(`refusing workspace path '${relPath}'`);
      }
      const target = normalize(join(dir, relPath));
      if (!target.startsWith(dir + sep)) throw new Error(`refusing workspace path '${relPath}'`);
      const parent = dirname(target);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      // Every directory between the workspace and the file must be a real directory (no symlink escapes).
      for (let p = parent; p.length > dir.length; p = dirname(p)) {
        if (lstatSync(p).isSymbolicLink()) throw new Error(`refusing workspace path '${relPath}' (symlink)`);
      }
      // "wx": fail if anything (including a symlink) already exists at the target.
      writeFileSync(target, encoding === "base64" ? Buffer.from(content, "base64") : content, { flag: "wx", mode });
      return target;
    },
    async dispose(): Promise<void> {
      if (disposed || options.keep === true) return;
      disposed = true;
      await rm(holder, { recursive: true, force: true });
      await rm(socketDir, { recursive: true, force: true });
    },
  };
}

/** Startup sweep: delete workspace directories under the root older than `maxAgeMs`. Returns how many were removed. */
export async function sweepCliWorkspaces(root: string = defaultWorkspaceRoot(), maxAgeMs: number = WORKSPACE_MAX_AGE_MS, now: number = Date.now()): Promise<number> {
  let removed = 0;
  const sweep = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (dir === root && name === "s") continue;
      if (!/^[0-9a-f]{8,16}$/.test(name)) continue;
      const p = join(dir, name);
      try {
        const st = await stat(p);
        if (st.isDirectory() && now - st.mtimeMs > maxAgeMs) {
          await rm(p, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // raced with another sweep or a dispose
      }
    }
  };
  try {
    statSync(root);
  } catch {
    return 0;
  }
  await sweep(root);
  await sweep(join(root, "s"));
  return removed;
}
