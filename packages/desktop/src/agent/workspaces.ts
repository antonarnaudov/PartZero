/**
 * The app's CLI workspace root (docs/CLI-PROVIDERS.md §5.4, §5.8), main-process side.
 *
 * The root `setup.ts` picks is exclusive to this app instance: `<userData>/cli-work`, or a per-profile folder inside the
 * gateway's private default root. The single-instance lock is held per userData folder, so nothing else creates
 * workspaces there: only this instance's detection probes and its agent worker. That is what makes it safe to empty
 * the root when nothing can be using it: at start (leftovers of a session that crashed or was killed) and on quit (the
 * workspace of a runtime phase or CLI call the quit interrupted, which the worker had no chance to remove).
 */
import { readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Names the gateway gives workspace holders and probe folders (`<root>/<16 hex>`) and socket folders (`<root>/s/<8 hex>`). */
const ENTRY = /^[0-9a-f]{8,16}$/;

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => ENTRY.test(n));
  } catch {
    return [];
  }
}

/**
 * Remove every CLI workspace, probe folder and broker socket folder under `root` (synchronous: it runs from Electron's
 * `will-quit`), then `root/s` and `root` themselves when nothing else is left in them (the gateway recreates them, 0700,
 * when needed; a per-profile fallback root of a test profile that is deleted afterwards leaves no trace). Only for a
 * root exclusive to this app instance, at a moment nothing uses it. Returns how many workspace folders were removed.
 */
export function clearCliWorkspaces(root: string): number {
  let removed = 0;
  for (const dir of [root, join(root, "s")]) {
    for (const name of entries(dir)) {
      try {
        rmSync(join(dir, name), { recursive: true, force: true });
        removed += 1;
      } catch {
        // Held open or already gone: the next start (or the worker's 24 h sweep) tries again.
      }
    }
  }
  for (const dir of [join(root, "s"), root]) {
    try {
      rmdirSync(dir); // only when empty
    } catch {
      // not empty, or not there
    }
  }
  return removed;
}
