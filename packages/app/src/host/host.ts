/**
 * `AppHost`: what the app needs from the platform it runs on. `ElectronHost` forwards to the
 * desktop preload bridge (`window.aicad`); `BrowserHost` uses web APIs (file input, downloads).
 */
import type {
  AgentBridge,
  AicadBridge,
  AppInfo,
  DocumentStateMessage,
  MenuCommandMessage,
  OpenDialogOptions,
  SaveDialogOptions,
  SettingsBridge,
} from "../bridge";

export interface AppHost {
  readonly kind: "electron" | "browser";
  /** `darwin`, `win32`, `linux` or `web`. */
  readonly platform: string;
  appInfo(): Promise<AppInfo>;
  /** Ask the user for a file to open; resolves to a path (or a browser handle) or null. */
  pickOpenPath(options: OpenDialogOptions): Promise<string | null>;
  pickSavePath(options: SaveDialogOptions): Promise<string | null>;
  readTextFile(path: string): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  recentFiles(): Promise<string[]>;
  clearRecentFiles(): Promise<void>;
  /** The native Forge CLI, when the host has one. */
  readonly forgeCli: AicadBridge["forge"] | null;
  /** The design agent (desktop only: it runs in a utility process with the user's API keys). */
  readonly agent: AgentBridge | null;
  /** Agent settings and API keys (desktop only). */
  readonly settings: SettingsBridge | null;
  setDocumentState(state: DocumentStateMessage): void;
  onMenuCommand(listener: (message: MenuCommandMessage) => void): () => void;
}

/** File name of a path (either separator). */
export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Document display name: file name without `.cad.ts` / `.json`. */
export function docNameFromPath(path: string): string {
  return baseName(path).replace(/\.cad\.ts$/i, "").replace(/\.json$/i, "");
}
