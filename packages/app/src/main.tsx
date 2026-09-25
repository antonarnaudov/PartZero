import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { automationAllowed, bootstrap } from "./bootstrap";
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
    const isMac = services.host.platform === "darwin" || /Mac/.test(navigator.userAgent);
    document.documentElement.dataset["platform"] = services.host.platform;
    const shellValue = installShell(services, commands, { automation: automationAllowed(import.meta.env.DEV, services.ui.getState().appInfo) });
    const { shell } = shellValue;
    const run = (cmd: AppInvocation, source: CommandSource = "ui"): void => {
      void shell.execute(cmd, source);
    };
    installKeyboard(commands, isMac, () => services.ui.getState().dialog !== null || shell.getState().dialog !== null, shell);
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
