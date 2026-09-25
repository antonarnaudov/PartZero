/**
 * The PartZero icon for unpackaged runs (`pnpm dev`, the e2e suite): the Dock shows `build/icon.png`
 * instead of Electron's. A packaged app carries `build/icon.icns` in its bundle (electron-builder
 * `buildResources`), so this does nothing there.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** `build/icon.png` next to the folder the main process runs from (`dist/` or `bundle/`), if present. */
export function devIconPath(mainDir: string): string | null {
  const p = join(mainDir, "..", "build", "icon.png");
  return existsSync(p) ? p : null;
}

export interface DockLike {
  isPackaged: boolean;
  dock?: { setIcon(image: string): void } | undefined;
}

/** Set the Dock icon of an unpackaged macOS run. Returns the icon used, or null. */
export function applyDevDockIcon(app: DockLike, mainDir: string, platform: string = process.platform): string | null {
  if (app.isPackaged || platform !== "darwin" || !app.dock) return null;
  const icon = devIconPath(mainDir);
  if (!icon) return null;
  try {
    app.dock.setIcon(icon);
    return icon;
  } catch {
    // A cosmetic: never let it stop the app.
    return null;
  }
}
