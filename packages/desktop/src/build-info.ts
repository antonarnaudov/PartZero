/**
 * What a bundled build knows about itself (electron-free, unit-tested): `bundle/build-info.json`, written by
 * `scripts/bundle.mjs` from the edition table in `editions.cjs` and baked into `app.asar`, where the asar integrity
 * fuse covers it (docs/ALPHA-0-PLAN.md W1). An unbundled development run has no such file and uses
 * {@link DEV_BUILD_INFO}.
 *
 * - `productName`: the app's name (`app.setName`, the window title, the menu, and with it the profile folder
 *   `~/Library/Application Support/<productName>` and the log folder `~/Library/Logs/<productName>`).
 * - `commit`, `dirty`, `builtAt`: the build identity reports, receipts and `--self-test` carry.
 * - `flags.apiKeys`: whether the build takes API keys at all (the Alpha 0 build does not: no key entry, no keychain).
 * - `flags.mcpShim`: whether a packaged build runs the CAD MCP shim as `ELECTRON_RUN_AS_NODE=1 <app> <shim>`, which
 *   needs the `runAsNode` fuse on (decision D1 keeps it on for the local Alpha 0 build only).
 * - `flags.loginShell`: which CLIs may be looked up through the user's login shell (`$SHELL -ilc 'command -v …'`) when
 *   they are in no known install folder: `all`, or `claude-cli` only (the Alpha 0 build). The lookup runs the user's
 *   shell startup files as a child of the app, so macOS attributes anything they touch (Desktop, Documents, iCloud)
 *   to the app, and may ask the user about it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildFlags {
  apiKeys: boolean;
  mcpShim: boolean;
  loginShell: LoginShellFlag;
}

export type LoginShellFlag = "all" | "claude-cli";

export interface BuildInfo {
  /** `dev` (unbundled), or the edition the bundle was made for (`default`, `alpha-local`). */
  edition: string;
  productName: string;
  appId: string;
  version: string;
  /** `git rev-parse --short=12 HEAD` at bundle time, or null outside a git checkout. */
  commit: string | null;
  /** The working tree had uncommitted changes when the bundle was made. */
  dirty: boolean;
  /** ISO time of the bundle, or null (development). */
  builtAt: string | null;
  flags: BuildFlags;
}

export const BUILD_INFO_FILE = "build-info.json";

/** An unbundled run (`pnpm dev`, `pnpm start`, the e2e suite on `dist/`): today's behavior. */
export const DEV_BUILD_INFO: BuildInfo = {
  edition: "dev",
  productName: "aicad",
  appId: "dev.aicad.desktop",
  version: "0.0.0",
  commit: null,
  dirty: false,
  builtAt: null,
  flags: { apiKeys: true, mcpShim: false, loginShell: "all" },
};

const NAME = /^[A-Za-z][A-Za-z0-9 ._-]{0,63}$/;
const APP_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

/**
 * A validated build info, or null. The product name becomes a folder name, so it is restricted to letters, digits,
 * space, dot, underscore and dash; everything else must have the right type. Unknown fields are dropped.
 */
export function parseBuildInfo(raw: unknown): BuildInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const flags = o["flags"] as Record<string, unknown> | undefined;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
  if (!str(o["edition"]) || !str(o["productName"]) || !NAME.test(o["productName"]) || !str(o["appId"]) || !APP_ID.test(o["appId"]) || !str(o["version"])) return null;
  if (o["commit"] !== null && !(typeof o["commit"] === "string" && /^[0-9a-f]{7,40}$/.test(o["commit"]))) return null;
  if (typeof o["dirty"] !== "boolean" || (o["builtAt"] !== null && !str(o["builtAt"]))) return null;
  if (typeof flags !== "object" || flags === null || typeof flags["apiKeys"] !== "boolean" || typeof flags["mcpShim"] !== "boolean") return null;
  if (flags["loginShell"] !== "all" && flags["loginShell"] !== "claude-cli") return null;
  return {
    edition: o["edition"],
    productName: o["productName"],
    appId: o["appId"],
    version: o["version"],
    commit: o["commit"] as string | null,
    dirty: o["dirty"],
    builtAt: o["builtAt"] as string | null,
    flags: { apiKeys: flags["apiKeys"], mcpShim: flags["mcpShim"], loginShell: flags["loginShell"] },
  };
}

/**
 * The build info next to the main bundle (`mainDir/build-info.json`). Missing: {@link DEV_BUILD_INFO} (an unbundled
 * run). Present but unreadable or invalid: an error, because a bundled build that silently fell back to development
 * behavior would, for example, show API-key entry in a build meant to have none.
 */
export function readBuildInfo(mainDir: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): BuildInfo {
  let text: string;
  try {
    text = read(join(mainDir, BUILD_INFO_FILE));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return DEV_BUILD_INFO;
    throw new Error(`cannot read ${BUILD_INFO_FILE}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${BUILD_INFO_FILE} is not JSON`);
  }
  const info = parseBuildInfo(raw);
  if (info === null) throw new Error(`${BUILD_INFO_FILE} is not a valid build info`);
  return info;
}

/** The CLIs the login-shell lookup may run for (`flags.loginShell`), or null for every CLI (the detector's option). */
export function loginShellProviders(info: BuildInfo): readonly ["claude-cli"] | null {
  return info.flags.loginShell === "all" ? null : [info.flags.loginShell];
}

/**
 * The app executable for the MCP shim, or null: an unpackaged run always has one (it is not fused); a packaged build
 * only when its edition runs the shim (`flags.mcpShim`, which the builder config pairs with the `runAsNode` fuse).
 */
export function mcpShimExecutable(info: BuildInfo, isPackaged: boolean, exePath: string): string | null {
  return !isPackaged || info.flags.mcpShim ? exePath : null;
}
