import type { AgentBridge, AicadBridge, PrintBridge, SettingsBridge } from "../bridge";
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
  readonly agent: AgentBridge | null;
  readonly settings: SettingsBridge | null;
  readonly print: PrintBridge | null;
  private readonly bridge: AicadBridge;

  constructor(bridge: AicadBridge) {
    this.bridge = bridge;
    this.platform = bridge.platform;
    this.forgeCli = bridge.forge;
    // Optional chaining: an older shell without the agent channels still runs the app.
    this.agent = bridge.agent ?? null;
    this.settings = bridge.settings ?? null;
    this.print = bridge.print ?? null;
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
