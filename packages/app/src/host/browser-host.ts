/**
 * The web host (`vite dev` in a browser, and the future web app): open via a file input, save and
 * export via downloads. Opened files live in memory under a `browser:` pseudo path.
 */
import type { AppInfo, OpenDialogOptions, SaveDialogOptions } from "../bridge";
import { baseName, type AppHost } from "./host";

export class BrowserHost implements AppHost {
  readonly kind = "browser" as const;
  readonly platform = "web";
  readonly forgeCli = null;
  readonly agent = null;
  readonly settings = null;
  readonly print = null;
  private readonly files = new Map<string, string>();

  appInfo(): Promise<AppInfo> {
    return Promise.resolve({
      name: "PartZero",
      version: "0.0.1",
      electron: "—",
      chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? "—",
      node: "—",
      platform: "web",
      arch: "—",
      isDev: import.meta.env.DEV,
      forgeCli: { available: false, path: "", detail: "The Forge CLI is only available in the desktop app." },
    });
  }

  pickOpenPath(options: OpenDialogOptions): Promise<string | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      const exts = options.filters?.flatMap((f) => f.extensions.map((e) => `.${e}`)) ?? [];
      if (exts.length) input.accept = exts.join(",");
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        void file.text().then((text) => {
          const path = `browser:${file.name}`;
          this.files.set(path, text);
          resolve(path);
        });
      });
      input.addEventListener("cancel", () => resolve(null));
      input.click();
    });
  }

  pickSavePath(options: SaveDialogOptions): Promise<string | null> {
    return Promise.resolve(`download:${baseName(options.defaultPath ?? "untitled.cad.ts")}`);
  }

  readTextFile(path: string): Promise<string> {
    const text = this.files.get(path);
    return text === undefined ? Promise.reject(new Error(`not available in the browser: ${path}`)) : Promise.resolve(text);
  }

  writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const name = baseName(path.replace(/^(download|browser):/, ""));
    const blob = new Blob([typeof data === "string" ? data : new Uint8Array(data)], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    if (typeof data === "string") this.files.set(path, data);
    return Promise.resolve();
  }

  recentFiles(): Promise<string[]> {
    return Promise.resolve([]);
  }

  clearRecentFiles(): Promise<void> {
    return Promise.resolve();
  }

  setDocumentState(state: { title: string; dirty: boolean }): void {
    document.title = `${state.dirty ? "● " : ""}${state.title} — PartZero`;
  }

  onMenuCommand(): () => void {
    return () => undefined;
  }
}
