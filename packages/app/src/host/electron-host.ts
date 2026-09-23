import type { AicadBridge } from "../bridge";
import type { AppHost } from "./host";

declare global {
  interface Window {
    /** Set by the desktop preload (`@aicad/desktop`). */
    aicad?: AicadBridge;
  }
}

/** The desktop host: everything goes through the typed preload bridge. */
export class ElectronHost implements AppHost {
  readonly kind = "electron" as const;
  readonly platform: string;
  readonly forgeCli: AicadBridge["forge"];
  private readonly bridge: AicadBridge;

  constructor(bridge: AicadBridge) {
    this.bridge = bridge;
    this.platform = bridge.platform;
    this.forgeCli = bridge.forge;
  }

  appInfo = (): ReturnType<AicadBridge["appInfo"]> => this.bridge.appInfo();
  pickOpenPath: AppHost["pickOpenPath"] = (o) => this.bridge.showOpenDialog(o);
  pickSavePath: AppHost["pickSavePath"] = (o) => this.bridge.showSaveDialog(o);
  readTextFile: AppHost["readTextFile"] = (p) => this.bridge.readTextFile(p);
  writeFile: AppHost["writeFile"] = (p, d) => this.bridge.writeFile(p, d);
  recentFiles: AppHost["recentFiles"] = () => this.bridge.recentFiles();
  clearRecentFiles: AppHost["clearRecentFiles"] = () => this.bridge.clearRecentFiles();
  setDocumentState: AppHost["setDocumentState"] = (s) => this.bridge.setDocumentState(s);
  onMenuCommand: AppHost["onMenuCommand"] = (l) => this.bridge.onMenuCommand(l);
}
