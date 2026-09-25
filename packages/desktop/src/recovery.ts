/**
 * Autosave and crash recovery (FULL-MODELING-PLAN §2.9 "Autosave"): snapshots of documents with unsaved changes in
 * `userData/Recovery/`, a marker for an unclean shutdown, and what the first window of the next launch offers to
 * restore.
 *
 * - Each window autosaves its document (as a `.partzero`) under its recovery id: `<id>.partzero` + `<id>.json`
 *   (title, the document's own path, time). Both are written atomically.
 * - A snapshot disappears when its document is saved, closed with "Don't Save", or restored or discarded; a clean quit
 *   leaves none. So whatever is left at launch was left by a crash, a force quit or a power cut.
 * - `session.json` exists while the app runs; finding it at launch means the previous run did not quit cleanly.
 * - The path recorded with a snapshot is kept only if the window may write it at that moment ({@link PathGrants}),
 *   so restoring a snapshot can grant it again without letting a renderer name an arbitrary file.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileCapped, writeFileAtomic } from "./files.js";

export interface RecoveryMeta {
  id: string;
  title: string;
  path: string | null;
  savedAt: number;
  bytes: number;
}

const ID = /^[a-z0-9-]{8,64}$/;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;

export function isRecoveryId(id: unknown): id is string {
  return typeof id === "string" && ID.test(id);
}

export class RecoveryStore {
  readonly dir: string;
  private readonly now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
  }

  private marker(): string {
    return join(this.dir, "session.json");
  }

  /**
   * Start a session: report whether the previous one ended uncleanly and what it left behind, then write this
   * session's marker.
   */
  beginSession(pid: number = process.pid): { uncleanExit: boolean; entries: RecoveryMeta[] } {
    mkdirSync(this.dir, { recursive: true });
    let uncleanExit = false;
    try {
      statSync(this.marker());
      uncleanExit = true;
    } catch {
      // clean
    }
    const entries = this.list();
    writeFileSync(this.marker(), `${JSON.stringify({ pid, startedAt: this.now() })}\n`);
    return { uncleanExit, entries };
  }

  /** A clean quit: no snapshots should remain (every window saved or discarded), and the marker goes. */
  endSession(): void {
    rmSync(this.marker(), { force: true });
  }

  /** Every snapshot, newest first (metadata that is missing, damaged or without its snapshot is skipped). */
  list(): RecoveryMeta[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: RecoveryMeta[] = [];
    for (const name of names) {
      const m = /^([a-z0-9-]{8,64})\.json$/.exec(name);
      if (!m) continue;
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as Partial<RecoveryMeta>;
        const st = statSync(join(this.dir, `${m[1]}.partzero`));
        if (raw.id !== m[1] || typeof raw.title !== "string" || typeof raw.savedAt !== "number") continue;
        out.push({ id: m[1]!, title: raw.title.slice(0, 200), path: typeof raw.path === "string" ? raw.path : null, savedAt: raw.savedAt, bytes: st.size });
      } catch {
        // an incomplete pair: skipped
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? -1 : 1));
  }

  get(id: string): RecoveryMeta | null {
    return this.list().find((e) => e.id === id) ?? null;
  }

  /** Write (replace) a snapshot. `path` must already be checked by the caller (see the module comment). */
  async write(entry: { id: string; title: string; path: string | null; data: Uint8Array }): Promise<RecoveryMeta> {
    if (!isRecoveryId(entry.id)) throw new Error("invalid recovery id");
    if (entry.data.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("snapshot too large");
    mkdirSync(this.dir, { recursive: true });
    const meta: RecoveryMeta = { id: entry.id, title: String(entry.title).slice(0, 200), path: entry.path, savedAt: this.now(), bytes: entry.data.byteLength };
    // The snapshot first, then its metadata: `list` only shows complete pairs.
    await writeFileAtomic(join(this.dir, `${entry.id}.partzero`), entry.data);
    await writeFileAtomic(join(this.dir, `${entry.id}.json`), `${JSON.stringify(meta)}\n`);
    return meta;
  }

  async read(id: string): Promise<Uint8Array> {
    if (!isRecoveryId(id)) throw new Error("invalid recovery id");
    return readFileCapped(join(this.dir, `${id}.partzero`), MAX_SNAPSHOT_BYTES);
  }

  /** Remove a snapshot. Synchronous underneath: a window closing during a quit must not leave it behind. */
  async discard(id: string): Promise<void> {
    if (!isRecoveryId(id)) throw new Error("invalid recovery id");
    rmSync(join(this.dir, `${id}.json`), { force: true });
    rmSync(join(this.dir, `${id}.partzero`), { force: true });
  }
}
