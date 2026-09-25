import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { automationAllowed, bootstrap } from "./bootstrap";
import { registerExportFormat } from "./file/export-formats";
import { documentFiles, documentStoreGuards, installDocumentFiles } from "./file/install";
import { stepExportFormat } from "./io/step-export";
import type { AppInvocation } from "./commands/commands";
import type { CommandSource } from "./commands/registry";
import { installShell } from "./ui/shell/install";
import { AppContext, type AppContextValue } from "./ui/context";
import { installKeyboard } from "./ui/keyboard";
import { AppShell } from "./ui/shell/AppShell";
import { ShellContext } from "./ui/shell/context";
import "./ui/styles.css";
import "./ui/styles/shell.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root missing");
const root = createRoot(rootEl);

bootstrap().then(
  ({ services, commands }) => {
    // Documents and files (.partzero, recovery, windows): before the keyboard reads the command table.
    installDocumentFiles({ services, commands }, documentStoreGuards(services));
    // STEP in the export dialog: Forge's own writer through the desktop's Forge CLI (the web build says why not).
    registerExportFormat(stepExportFormat(services.host));
    const isMac = services.host.platform === "darwin" || /Mac/.test(navigator.userAgent);
    document.documentElement.dataset["platform"] = services.host.platform;
    const shellValue = installShell(services, commands, { automation: automationAllowed(import.meta.env.DEV, services.ui.getState().appInfo) });
    const { shell } = shellValue;
    const run = (cmd: AppInvocation, source: CommandSource = "ui"): void => {
      void shell.execute(cmd, source);
    };
    // Modal dialogs (the app's, the shell's and the document layer's) own Escape and block the global keys.
    const dialogOpen = (): boolean => services.ui.getState().dialog !== null || shell.getState().dialog !== null || (documentFiles()?.getState().dialog ?? null) !== null;
    installKeyboard(commands, isMac, dialogOpen, shell);
    const value: AppContextValue = { services, commands, run, isMac };
    root.render(
      <StrictMode>
        <AppContext.Provider value={value}>
          <ShellContext.Provider value={shellValue}>
            <AppShell />
          </ShellContext.Provider>
        </AppContext.Provider>
      </StrictMode>,
    );
  },
  (e: unknown) => {
    rootEl.textContent = `PartZero failed to start: ${e instanceof Error ? e.message : String(e)}`;
    console.error(e);
  },
);
