/**
 * The folders PartZero writes files into for the user (decision D4, docs/ALPHA-0-PLAN.md §4.3): prints go to
 * `~/PartZero/Prints` and issue reports to `~/PartZero/Reports`. Both are outside the folders macOS guards (Desktop,
 * Documents, Downloads), so neither PartZero writing there nor Bambu Studio reading from there asks for a privacy
 * grant [as16], and no folder dialog is needed. Each is created on first use (W5 export, W10 Report Issue), never at
 * startup. Electron-free, unit-tested.
 */
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const USER_FOLDER_ROOT = "PartZero";

export interface UserFolders {
  root: string;
  prints: string;
  reports: string;
}

export function userFolders(home: string): UserFolders {
  const root = join(home, USER_FOLDER_ROOT);
  return { root, prints: join(root, "Prints"), reports: join(root, "Reports") };
}

/**
 * Create `dir` (and `~/PartZero`) if needed and return it. Refuses a path that exists as anything but a real folder,
 * including a symlink, so a file written "into Prints" cannot land somewhere the user did not choose.
 */
export function ensureUserFolder(dir: string, root: string): string {
  for (const p of [root, dir]) {
    let st;
    try {
      st = lstatSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      mkdirSync(p, { mode: 0o755 });
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${p} exists and is not a folder; move it aside and try again`);
  }
  return dir;
}
