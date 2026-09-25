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
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { copyFile, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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

/** Documents (not exports) go into the recent list: PartZero documents, CadScript and IR JSON. */
export function isDocumentPath(path: string): boolean {
  return /\.(partzero|ts|json)$/i.test(path);
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

// ─── Saving and reading documents ───────────────────────────────────────────────────────────

/** Largest file the renderer may read or write in one piece (a document, an imported mesh). */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

/**
 * A test-only hook at a named point of a save: it throws to simulate a crash there (FULL-MODELING-PLAN C7
 * `fault("save:afterTempWrite")`), or returns a promise to hold the save there (a save still in flight). The main
 * process passes one only in unpackaged runs.
 */
export type FaultPoint = "save:afterTempWrite" | "save:beforeRename";
export type FaultHook = (point: FaultPoint) => void | Promise<void>;

export interface AtomicWriteOptions {
  /** Keep the previous version of the file as `<file>.bak` (documents). */
  backup?: boolean;
  fault?: FaultHook;
}

/** The backup kept next to a document: `plate.partzero` → `plate.partzero.bak`. */
export function backupPath(path: string): string {
  return `${path}.bak`;
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return; // directories cannot be opened for fsync on Windows
  let h;
  try {
    h = await open(dir, "r");
    await h.sync();
  } catch {
    // Best effort: some file systems refuse fsync on a directory.
  } finally {
    await h?.close();
  }
}

/**
 * Write `data` to `target` so that a crash at any moment leaves either the old file or the new one, never a torn one
 * (FULL-MODELING-PLAN §2.9 "Saves"): write a temp file in the same folder, fsync it, keep the old version as `.bak`
 * (copied, so the target never disappears), rename the temp file over the target, fsync the folder. The file mode of
 * an existing target is kept.
 */
export async function writeFileAtomic(target: string, data: Uint8Array | string, options: AtomicWriteOptions = {}): Promise<{ bytes: number; backup: string | null }> {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("file too large");
  const dir = dirname(target);
  const tmp = join(dir, `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  let mode = 0o644;
  let existed = false;
  try {
    const st = await stat(target);
    if (!st.isFile()) throw new Error(`${target} is not a file`);
    mode = st.mode & 0o777;
    existed = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const h = await open(tmp, "wx", mode);
  try {
    await h.writeFile(bytes);
    await h.sync();
  } catch (e) {
    await h.close();
    await rm(tmp, { force: true });
    throw e;
  }
  await h.close();
  try {
    await options.fault?.("save:afterTempWrite");
    let backup: string | null = null;
    if (options.backup && existed) {
      const bak = backupPath(target);
      const bakTmp = `${tmp}.bak`;
      await copyFile(target, bakTmp, fsConstants.COPYFILE_FICLONE);
      await rename(bakTmp, bak);
      backup = bak;
    }
    await options.fault?.("save:beforeRename");
    await rename(tmp, target);
    await syncDirectory(dir);
    return { bytes: bytes.byteLength, backup };
  } catch (e) {
    await rm(tmp, { force: true });
    await rm(`${tmp}.bak`, { force: true });
    throw e;
  }
}

/** Read a whole file, refusing anything larger than `max` bytes (checked before reading). */
export async function readFileCapped(path: string, max = MAX_FILE_BYTES): Promise<Uint8Array> {
  const st = await stat(path);
  if (!st.isFile()) throw new Error(`${path} is not a file`);
  if (st.size > max) throw new Error(`${basename(path)} is too large (${Math.round(st.size / 1024 / 1024)} MB; the limit is ${Math.round(max / 1024 / 1024)} MB)`);
  return new Uint8Array(await readFile(path));
}

/**
 * Documents named on the command line (Windows and Linux open files this way; macOS sends `open-file` instead):
 * absolute or relative paths of existing document files. Switches and the app folder are skipped.
 */
export function documentPathsFromArgv(argv: readonly string[], cwd: string = process.cwd()): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (a.startsWith("-") || !isDocumentPath(a) || a.includes("\0")) continue;
    const p = isAbsolute(a) ? a : resolve(cwd, a);
    try {
      if (statSync(p).isFile() && !out.includes(p)) out.push(p);
    } catch {
      // not a file
    }
  }
  return out;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/**
 * Thumbnails of saved documents for the recent-files grid, kept in the profile (`Thumbnails/`), keyed by the
 * document's canonical path. The renderer sends one with each save; only PNGs up to 2 MiB are kept.
 */
export class ThumbnailCache {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(docPath: string): string {
    return join(this.dir, `${createHash("sha256").update(canonicalPath(docPath)).digest("hex").slice(0, 32)}.png`);
  }

  async put(docPath: string, png: Uint8Array): Promise<void> {
    if (png.byteLength > MAX_THUMBNAIL_BYTES || !PNG_SIGNATURE.every((b, i) => png[i] === b)) throw new Error("invalid thumbnail");
    mkdirSync(this.dir, { recursive: true });
    await writeFileAtomic(this.file(docPath), png);
  }

  async get(docPath: string): Promise<Uint8Array | null> {
    try {
      return await readFileCapped(this.file(docPath), MAX_THUMBNAIL_BYTES);
    } catch {
      return null;
    }
  }

  has(docPath: string): boolean {
    return existsSync(this.file(docPath));
  }
}

/** A recent document with what the recent-files grid shows about it. */
export interface RecentDocumentInfo {
  path: string;
  name: string;
  exists: boolean;
  modifiedMs: number | null;
  hasThumbnail: boolean;
}

export function describeRecent(paths: readonly string[], thumbs: ThumbnailCache): RecentDocumentInfo[] {
  return paths.map((p) => {
    let exists = false;
    let modifiedMs: number | null = null;
    try {
      const st = statSync(p);
      exists = st.isFile();
      modifiedMs = exists ? Math.round(st.mtimeMs) : null;
    } catch {
      // gone
    }
    return { path: p, name: basename(p), exists, modifiedMs, hasThumbnail: exists && thumbs.has(p) };
  });
}

/** Plain write (exports): not atomic, no backup, size-capped. */
export async function writeFilePlain(path: string, data: Uint8Array | string): Promise<void> {
  if ((typeof data === "string" ? Buffer.byteLength(data) : data.byteLength) > MAX_FILE_BYTES) throw new Error("file too large");
  await writeFile(path, data);
}
