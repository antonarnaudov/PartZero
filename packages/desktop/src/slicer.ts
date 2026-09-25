/**
 * The slicer handoff's launcher (ALPHA-0-PLAN W5, ADR 0016 §2–3): find the Bambu Studio the user
 * installed and hand it a 3MF through the OS "open with" mechanism.
 *
 * - **Never bundled, linked or installed** (ADR 0016 §3). We look for the user's own copy and
 *   start it as a separate process through `/usr/bin/open`; we exchange only the file.
 * - **Detection** (macOS): the path set in Settings, when there is one, is the only place looked
 *   at (so a wrong path shows up as "not found" rather than silently falling back); otherwise
 *   `/Applications`, then `~/Applications`, then LaunchServices' index by bundle id (`mdfind`).
 *   A candidate counts only when its `Info.plist` says `CFBundleIdentifier` is Bambu Studio's, so
 *   a path set from the renderer can never launch another app.
 * - **Launch:** `execFile("/usr/bin/open", ["-a", <app>, <file>])`, no shell, a 10 s timeout,
 *   capped output, and only for a `.3mf` (or `.step`) inside the prints folder. `-a <app>` opens the exact copy
 *   that was detected (and whose version is reported); a Bambu Studio that is already running
 *   receives the file as an open-document event. Bambu Studio 02.06 opens a file it receives
 *   while a part is loaded in a **new instance** (docs/SLICER-HANDOFF.md, finding 4), so the
 *   launch first asks `pgrep` whether it is running and the result says so; the UI then tells you
 *   a new window may open. `open` exiting 0 means macOS handed the file over, not that Bambu
 *   Studio loaded it: nothing here can see its window.
 * - Other platforms: not supported in Alpha 0; the export still works and is shown in the folder.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SlicerInfo } from "@aicad/app/bridge";

export const BAMBU_STUDIO = Object.freeze({
  name: "Bambu Studio",
  bundleId: "com.bambulab.bambu-studio",
  appName: "BambuStudio.app",
  /** Tested with Bambu Studio 02.06.00.51 on macOS 27 (docs/SLICER-HANDOFF.md). */
  testedVersion: "02.06.00.51",
});

export const OPEN_TIMEOUT_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_OUTPUT = 64 * 1024;

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** `execFile` with no shell, a timeout and capped output; never rejects. */
export function execFileCapped(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((done) => {
    nodeExecFile(file, args, { shell: false, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) return done({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string };
      const code = typeof e.code === "number" ? e.code : null;
      const why = e.killed ? `timed out after ${timeoutMs} ms` : e.message;
      done({ code, stdout: stdout ?? "", stderr: stderr ?? "", error: why });
    });
  });
}

/** What the launcher needs from the system (injected in tests). */
export interface SlicerSystem {
  platform: NodeJS.Platform;
  /** Folders searched for `BambuStudio.app`, in order. */
  searchDirs: string[];
  /** Whether to ask LaunchServices' index (`mdfind`) when the folders have none. */
  useLaunchServices: boolean;
  /** The `open` executable (`/usr/bin/open`; a fake in tests). */
  openBin: string;
  /** `pgrep`, to tell whether Bambu Studio is already running (`/usr/bin/pgrep`; null: don't ask). */
  pgrepBin: string | null;
  exec: (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>;
  isDir: (path: string) => boolean;
  readText: (path: string) => string | null;
}

/** The real system: `/Applications`, `~/Applications`, `mdfind`, `/usr/bin/open`, `/usr/bin/pgrep`. */
export function defaultSlicerSystem(overrides: { searchDirs?: string[] | null; openBin?: string | null } = {}): SlicerSystem {
  return {
    platform: process.platform,
    searchDirs: overrides.searchDirs ?? ["/Applications", join(homedir(), "Applications")],
    // A test profile searches only its own folders, and never asks about the user's real Bambu Studio.
    useLaunchServices: !overrides.searchDirs,
    openBin: overrides.openBin ?? "/usr/bin/open",
    pgrepBin: overrides.searchDirs ? null : "/usr/bin/pgrep",
    exec: execFileCapped,
    isDir: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    readText: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** Values of `<key>K</key><string>V</string>` pairs in an XML property list. */
export function plistStrings(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<key>([^<]{1,200})<\/key>\s*<string>([^<]{0,500})<\/string>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const key = m[1]!.trim();
    if (!(key in out)) out[key] = unescapeXml(m[2]!.trim());
  }
  return out;
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** The bundle id, version and executable name of an `.app`, or null when it has no readable `Info.plist`. */
export async function readBundleInfo(sys: SlicerSystem, app: string): Promise<{ bundleId: string; version: string | null; executable: string | null } | null> {
  const plist = join(app, "Contents", "Info.plist");
  let text = sys.readText(plist);
  if (text === null) return null;
  if (!text.includes("<plist")) {
    // A binary property list: let plutil convert it.
    const r = await sys.exec("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", plist], LOOKUP_TIMEOUT_MS);
    if (r.code !== 0) return null;
    text = r.stdout;
  }
  const keys = plistStrings(text);
  const bundleId = keys["CFBundleIdentifier"];
  if (!bundleId) return null;
  return { bundleId, version: keys["CFBundleShortVersionString"] || null, executable: keys["CFBundleExecutable"] || null };
}

function notFound(customPath: string | null, reason: string, fix: string): SlicerInfo {
  return { found: false, name: BAMBU_STUDIO.name, bundleId: BAMBU_STUDIO.bundleId, path: customPath, version: null, source: null, customPath, reason, fix };
}

async function candidate(sys: SlicerSystem, app: string): Promise<{ path: string; version: string | null } | null> {
  if (!sys.isDir(app)) return null;
  const info = await readBundleInfo(sys, app);
  return info && info.bundleId === BAMBU_STUDIO.bundleId ? { path: app, version: info.version } : null;
}

/** Find Bambu Studio (see the module docs). `customPath` is the path set in Settings, if any. */
export async function detectSlicer(sys: SlicerSystem, customPath: string | null): Promise<SlicerInfo> {
  if (sys.platform !== "darwin") {
    return notFound(customPath, "Opening Bambu Studio from PartZero works on macOS only in Alpha 0.", "Open the saved 3MF in Bambu Studio yourself.");
  }
  const hit = (c: { path: string; version: string | null }, source: SlicerInfo["source"]): SlicerInfo => ({
    found: true,
    name: BAMBU_STUDIO.name,
    bundleId: BAMBU_STUDIO.bundleId,
    path: c.path,
    version: c.version,
    source,
    customPath,
  });
  if (customPath) {
    if (!sys.isDir(customPath)) {
      return notFound(customPath, `Bambu Studio isn't at ${customPath}, the path set in Settings.`, "Fix the Bambu Studio path in Settings, or clear it to search /Applications again.");
    }
    const c = await candidate(sys, customPath);
    if (!c) {
      return notFound(customPath, `${customPath} is not Bambu Studio (its bundle id is not ${BAMBU_STUDIO.bundleId}).`, "Point the path in Settings at BambuStudio.app, or clear it.");
    }
    return hit(c, "settings");
  }
  for (const [i, dir] of sys.searchDirs.entries()) {
    const c = await candidate(sys, join(dir, BAMBU_STUDIO.appName));
    if (c) return hit(c, i === 0 ? "applications" : "user-applications");
  }
  if (sys.useLaunchServices) {
    const r = await sys.exec("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${BAMBU_STUDIO.bundleId}'`], LOOKUP_TIMEOUT_MS);
    if (r.code === 0) {
      for (const line of r.stdout.split("\n").map((l) => l.trim())) {
        if (!line.endsWith(".app") || !isAbsolute(line)) continue;
        const c = await candidate(sys, line);
        if (c) return hit(c, "launch-services");
      }
    }
  }
  return notFound(
    null,
    "Bambu Studio isn't installed in /Applications or ~/Applications.",
    "Install Bambu Studio from bambulab.com, or set its path in Settings. The 3MF is saved either way.",
  );
}

export type OpenOutcome =
  /** `open` handed the file over. `alreadyRunning`: whether Bambu Studio was running before (null: not known). */
  | { ok: true; alreadyRunning: boolean | null }
  | { ok: false; code: "SLICER_NOT_FOUND" | "SLICER_LAUNCH_FAILED" | "PRINT_PATH_NOT_ALLOWED"; message: string };

/**
 * Whether a process of the app at `appPath` is running for this user: `pgrep -x -U <uid> <exe>`,
 * where `<exe>` is the bundle's `CFBundleExecutable` (`BambuStudio`). Null when that can't be
 * told (no pgrep, no uid, no readable Info.plist, or pgrep failed); never throws.
 */
export async function slicerRunning(sys: SlicerSystem, appPath: string): Promise<boolean | null> {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!sys.pgrepBin || uid === null) return null;
  const info = await readBundleInfo(sys, appPath);
  // pgrep matches the kernel's process name, at most 16 characters (MAXCOMLEN) on macOS.
  const exe = info?.executable ?? null;
  if (!exe || exe.length > 16 || !/^[\w .+-]+$/.test(exe)) return null;
  const r = await sys.exec(sys.pgrepBin, ["-x", "-U", String(uid), exe], LOOKUP_TIMEOUT_MS);
  // pgrep: 0 = a match, 1 = none; anything else is an error.
  return r.code === 0 ? true : r.code === 1 ? false : null;
}

/** Whether `file` is a `.3mf` inside `dir` (after resolving symlinks). */
export function isInside(dir: string, file: string): boolean {
  let realDir: string;
  let realFile: string;
  try {
    realDir = realpathSync(dir);
    realFile = realpathSync(file);
  } catch {
    return false;
  }
  const rel = relative(realDir, realFile);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

/** Hand `file` (a `.3mf`, or a `.step` / `.stp`, in `printsDir`) to the detected slicer. */
export async function openInSlicer(sys: SlicerSystem, slicer: SlicerInfo, file: string, printsDir: string): Promise<OpenOutcome> {
  if (!slicer.found || !slicer.path) {
    return { ok: false, code: "SLICER_NOT_FOUND", message: slicer.reason ?? "Bambu Studio was not found." };
  }
  const abs = resolve(file);
  if (!/\.(3mf|step|stp)$/i.test(abs) || !existsSync(abs) || !isInside(printsDir, abs)) {
    return { ok: false, code: "PRINT_PATH_NOT_ALLOWED", message: `Only a 3MF or STEP file in ${printsDir} can be opened in the slicer.` };
  }
  const alreadyRunning = await slicerRunning(sys, slicer.path);
  const r = await sys.exec(sys.openBin, ["-a", slicer.path, abs], OPEN_TIMEOUT_MS);
  if (r.code !== 0) {
    const detail = (r.stderr.trim() || r.error || `exit code ${String(r.code)}`).slice(0, 300);
    return { ok: false, code: "SLICER_LAUNCH_FAILED", message: `Bambu Studio did not open: ${detail}` };
  }
  return { ok: true, alreadyRunning };
}
