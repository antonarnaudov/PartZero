import { createContext, useContext, useSyncExternalStore } from "react";
import type { Shell, ShellState } from "../../tools/shell";
import type { PanelDefinition, PanelRegistry } from "./panels";
import type { ShortcutDocs } from "./shortcut-docs";

export interface ShellContextValue {
  shell: Shell;
  panels: PanelRegistry;
  shortcutDocs: ShortcutDocs;
}

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const v = useContext(ShellContext);
  if (!v) throw new Error("ShellContext missing");
  return v;
}

/** Subscribe to a slice of the shell state (the selector must return a stable value). */
export function useShellState<S>(selector: (s: ShellState) => S): S {
  const { shell } = useShell();
  return useSyncExternalStore(shell.subscribe, () => selector(shell.getState()));
}

export function usePanels(): readonly PanelDefinition[] {
  const { panels } = useShell();
  return useSyncExternalStore(panels.subscribe, () => panels.getState().panels);
}
