import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootstrap } from "./bootstrap";
import { installDocumentFiles } from "./file/install";
import type { AppInvocation } from "./commands/commands";
import type { CommandSource } from "./commands/registry";
import { App } from "./ui/App";
import { AppContext, type AppContextValue } from "./ui/context";
import { installKeyboard } from "./ui/keyboard";
import "./ui/styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root missing");
const root = createRoot(rootEl);

bootstrap().then(
  ({ services, commands }) => {
    // Documents and files (.partzero, recovery, windows): before the keyboard reads the command table.
    installDocumentFiles({ services, commands });
    const isMac = services.host.platform === "darwin" || /Mac/.test(navigator.userAgent);
    document.documentElement.dataset["platform"] = services.host.platform;
    const run = (cmd: AppInvocation, source: CommandSource = "ui"): void => {
      void commands.executeUnknown(cmd, { source });
    };
    installKeyboard(commands, isMac, () => services.ui.getState().dialog !== null);
    const value: AppContextValue = { services, commands, run, isMac };
    root.render(
      <StrictMode>
        <AppContext.Provider value={value}>
          <App />
        </AppContext.Provider>
      </StrictMode>,
    );
  },
  (e: unknown) => {
    rootEl.textContent = `aicad failed to start: ${e instanceof Error ? e.message : String(e)}`;
    console.error(e);
  },
);
