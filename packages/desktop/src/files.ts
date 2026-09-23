/**
 * File access policy for the renderer: a path is readable or writable only after the user chose it
 * in a native dialog in this session, or earlier did so (recent documents). Recent documents
 * persist in userData.
 *
 * Grants are split: an open dialog grants read access (plus write for documents, which Save writes
 * back in place), a save dialog grants write access (plus read for documents, which then appear in
 * Open Recent). Grants are keyed by the real path (`fs.realpath`, with the parent resolved for a
 * file that does not exist yet), so replacing a granted file with a symlink to somewhere else does
 * not carry the grant over. The recent list records that real path too, and a grant is restored
 * from it only while the path still resolves to it, so the same holds across sessions.
 *
 * Grants restored from the recent list are revoked when it is cleared (Clear Recent), except for
 * the documents actually opened or saved in this session: Save must keep working for the open
 * document.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type Access = "read" | "write";
/**
 * Where a grant came from: a dialog in this session, a recent document opened or saved in this
 * session, or the persisted recent-documents list (the only origin Clear Recent revokes).
 */
export type GrantOrigin = "dialog" | "session" | "recent";

const MAX_PATH = 4096;

function validPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH || path.includes("\0")) throw new Error("invalid path");
  return resolve(path);
}

/** The canonical path: `realpath` of the file, or of its directory for a file that does not exist yet. */
export function canonicalPath(path: string): string {
  const p = resolve(path);
  try {
    return realpathSync.native(p);
  } catch {
    try {
      return join(realpathSync.native(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}

interface Grant {
  read: Set<GrantOrigin>;
  write: Set<GrantOrigin>;
}

export class PathGrants {
  /** Canonical path → grant. */
  private readonly grants = new Map<string, Grant>();

  /** Grant `access` to `path`; returns the absolute (not canonicalized) path for the renderer. */
  grant(path: string, access: readonly Access[], origin: GrantOrigin = "dialog"): string {
    const p = validPath(path);
    this.add(canonicalPath(p), access, origin);
    return p;
  }

  private add(key: string, access: readonly Access[], origin: GrantOrigin): void {
    let g = this.grants.get(key);
    if (!g) {
      g = { read: new Set(), write: new Set() };
      this.grants.set(key, g);
    }
    for (const a of access) g[a].add(origin);
  }

  /** After an open dialog: read; write too for documents (Save writes them back in place). */
  grantOpened(path: string): string {
    return this.grant(path, isDocumentPath(path) ? ["read", "write"] : ["read"]);
  }

  /** After a save dialog: write; read too for documents (they become recent documents). */
  grantSaveTarget(path: string): string {
    return this.grant(path, isDocumentPath(path) ? ["read", "write"] : ["write"]);
  }

  /**
   * A recent document from an earlier session (documents only), if `path` still resolves to `real`,
   * the canonical path recorded when it was opened or saved. An entry recorded without one (older
   * lists) is restored only if its path involves no symlink at all. Returns whether it was granted.
   */
  grantRecent(path: string, real: string | null): boolean {
    let p: string;
    try {
      p = validPath(path);
    } catch {
      return false;
    }
    if (!isDocumentPath(p)) return false;
    const key = canonicalPath(p);
    if (key !== (real ?? p)) return false;
    this.add(key, ["read", "write"], "recent");
    return true;
  }

  /**
   * The document at `key` (a canonical path returned by {@link check}) was opened or saved in this
   * session: whatever access it has now also survives {@link revokeRecent}.
   */
  keepForSession(key: string): void {
    const g = this.grants.get(key);
    if (!g) return;
    for (const a of ["read", "write"] as const) if (g[a].size > 0) g[a].add("session");
  }

  /**
   * Drop every grant that exists only because of the recent list (Clear Recent). Grants from dialogs
   * in this session, and those of documents opened or saved in it ({@link keepForSession}), stay.
   */
  revokeRecent(): void {
    for (const [key, g] of this.grants) {
      g.read.delete("recent");
      g.write.delete("recent");
      if (g.read.size === 0 && g.write.size === 0) this.grants.delete(key);
    }
  }

  has(path: string, access: Access): boolean {
    try {
      return (this.grants.get(canonicalPath(validPath(path)))?.[access].size ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /** Throws unless `path` was granted `access`; returns the canonical path to operate on. */
  check(path: unknown, access: Access): string {
    const p = validPath(path);
    const key = canonicalPath(p);
    if ((this.grants.get(key)?.[access].size ?? 0) === 0) {
      throw new Error(`access denied: ${p} was not chosen in a file dialog${access === "write" ? " for saving" : ""}`);
    }
    return key;
  }
}

/**
 * The path in a `doc:state` message, if the renderer may name it: only a granted path reaches
 * `setRepresentedFilename` (the macOS title-bar proxy icon, which can reveal and drag the file).
 */
export function documentStatePath(path: unknown, grants: PathGrants): string | null {
  if (typeof path !== "string") return null;
  return grants.has(path, "read") || grants.has(path, "write") ? resolve(path) : null;
}

/** Documents (not exports) go into the recent list. */
export function isDocumentPath(path: string): boolean {
  return /\.(ts|json)$/i.test(path);
}

/** A recent document: the path the user chose, and the canonical path it resolved to then (null in lists written before it was recorded). */
export interface RecentEntry {
  path: string;
  real: string | null;
}

function recentEntry(x: unknown): RecentEntry | null {
  if (typeof x === "string") return isDocumentPath(x) ? { path: x, real: null } : null;
  if (typeof x !== "object" || x === null) return null;
  const { path, real } = x as { path?: unknown; real?: unknown };
  if (typeof path !== "string" || !isDocumentPath(path)) return null;
  return { path, real: typeof real === "string" ? real : null };
}

export class RecentFiles {
  private items: RecentEntry[] = [];
  private readonly file: string;
  private readonly max: number;

  constructor(file: string, max = 10) {
    this.file = file;
    this.max = max;
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(raw)) this.items = raw.map(recentEntry).filter((e): e is RecentEntry => e !== null).slice(0, max);
    } catch {
      this.items = [];
    }
  }

  /** The paths, most recent first (menus and the renderer). */
  list(): string[] {
    return this.items.map((e) => e.path);
  }

  /** The entries with their recorded canonical paths (restoring grants). */
  entries(): RecentEntry[] {
    return this.items.map((e) => ({ ...e }));
  }

  /** Record `path`, which resolved to the canonical path `real` when it was opened or saved. */
  add(path: string, real: string): void {
    const p = resolve(path);
    this.items = [{ path: p, real }, ...this.items.filter((x) => x.path !== p)].slice(0, this.max);
    this.persist();
  }

  clear(): void {
    this.items = [];
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(this.items, null, 2)}\n`);
    } catch {
      // Best effort.
    }
  }
}
