/**
 * Start the shell for a window: the shell commands, the tool registry with every registered tool,
 * the dock panels, the shortcut map, and (in development and e2e runs only) a small automation hook.
 */
import type { AppCommandRegistry } from "../../commands/commands";
import type { AppServices } from "../../services";
import { registerAllTools } from "../../tools/catalog";
import { createShellCommandRegistry } from "../../tools/commands";
import type { PanelSpec, ToolDefinition } from "../../tools/framework/types";
import { ToolRegistry } from "../../tools/registry";
import { attachShell, Shell } from "../../tools/shell";
import type { ShellContextValue } from "./context";
import { registerBuiltinPanels } from "./panel-catalog";
import { PanelRegistry, type PanelDefinition } from "./panels";
import { PANEL_KEYS, ShortcutDocs, VIEWPORT_NAVIGATION } from "./shortcut-docs";

/**
 * `window.__partzero`: drive the shell from e2e tests and the console, **only** where the command
 * layer's own automation hook (`window.__aicad`) is allowed: a dev build or an unpackaged run.
 */
export interface ShellAutomation {
  registerTool(def: ToolDefinition): () => void;
  registerPanel(def: PanelDefinition): () => void;
  startTool(id: string): Promise<{ started: boolean; panel: boolean; reason?: string }>;
  openPanel(spec: PanelSpec): void;
  /** The open panel: state, values and errors (JSON). */
  panel(): unknown;
  tools(): Array<{ id: string; label: string; group: string; enabled: boolean; reason?: string }>;
  setMode(mode: "model" | "sketch"): void;
  welcomeVisible(): boolean;
  execute(cmd: { id: string; args?: unknown }): Promise<unknown>;
}

declare global {
  interface Window {
    __partzero?: ShellAutomation;
  }
}

export function installShell(
  services: AppServices,
  commands: AppCommandRegistry,
  options: { automation: boolean; tools?: ToolRegistry; flags?: (flag: string) => boolean },
): ShellContextValue {
  const shellCommands = createShellCommandRegistry(() => services);
  // Failures of user-initiated shell commands surface as toasts, like the app's (bootstrap.ts).
  shellCommands.onDidExecute((r) => {
    if (!r.ok && r.error && (r.source === "ui" || r.source === "keyboard" || r.source === "menu" || r.source === "palette")) services.ui.toast("error", r.error.message);
  });
  // Build flags (plan §3.5): all on in development and e2e runs; a packaged build shows unflagged tools
  // only until `packages/app/src/flags.ts` (INT) says which flags are on.
  const tools = options.tools ?? new ToolRegistry({ flags: options.flags ?? (() => options.automation) });
  const shell = new Shell({ services, commands, shellCommands, tools });
  attachShell(services, shell);
  registerAllTools(tools);
  const panels = new PanelRegistry();
  registerBuiltinPanels(panels);
  const shortcutDocs = new ShortcutDocs([PANEL_KEYS, VIEWPORT_NAVIGATION]);

  if (options.automation && typeof window !== "undefined") {
    window.__partzero = {
      registerTool: (def) => tools.register(def),
      registerPanel: (def) => panels.register(def),
      startTool: (id) => shell.startTool(id, "test"),
      openPanel: (spec) => void shell.openPanel(spec),
      panel: () => {
        const p = shell.getState().panel;
        if (!p) return null;
        const s = p.getState();
        return {
          toolId: s.toolId,
          title: s.title,
          state: s.state,
          values: p.values(),
          fieldErrors: Object.fromEntries(s.fields.filter((f) => f.error || f.remoteError).map((f) => [f.key, (f.remoteError ?? f.error)!.code ?? "ERROR"])),
          errors: s.errors,
          summary: s.summary,
        };
      },
      tools: () =>
        tools.list().map((t) => {
          const en = shell.enablement(t);
          return { id: t.id, label: t.label, group: t.group, enabled: en === true, ...(en === true ? {} : { reason: en.reason }) };
        }),
      setMode: (mode) => shell.setMode(mode),
      welcomeVisible: () => shell.welcomeVisible(),
      execute: (cmd) => shell.execute(cmd, "test"),
    };
  }
  return { shell, panels, shortcutDocs };
}
