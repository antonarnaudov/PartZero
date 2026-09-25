/**
 * Shortcuts of the viewport commands (Shift+1…7 views, N look-at, Shift+Z zoom to selection,
 * P projection, V hide, Shift+V show all, Shift+I isolate, 1–5 selection filters, 0 all,
 * I measure, ⌘A select all), handled like `ui/keyboard.ts`: window-level, single-key bindings
 * ignored while typing, nothing while a dialog is open. Keys the app registry already binds (F,
 * Escape…) are left to it.
 */
import type { AppCommandRegistry } from "../commands/commands";
import { eventToKey } from "../commands/registry";
import type { ViewportCommandRegistry } from "./registry";

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.closest(".monaco-editor") !== null || el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * Shortcuts that only make sense on the canvas and must never reach a text field, so they are
 * not in the command specs (the app keyboard runs modifier shortcuts inside editors too).
 */
const CANVAS_ONLY: ReadonlyArray<[string, string]> = [["mod+a", "selection.selectAll"]];

export function installViewportKeyboard(registry: ViewportCommandRegistry, appRegistry: AppCommandRegistry, isMac: boolean, isBlocked: () => boolean): () => void {
  const keymap = registry.keymap();
  for (const [k, id] of CANVAS_ONLY) if (!keymap.has(k)) keymap.set(k, id);
  const appKeys = appRegistry.keymap();
  const handler = (e: KeyboardEvent): void => {
    if (e.isComposing || e.repeat || e.defaultPrevented) return;
    const key = eventToKey(e, isMac);
    if (appKeys.has(key)) return;
    const id = keymap.get(key);
    if (!id) return;
    // Every viewport shortcut is a canvas shortcut: never while typing (⌘A selects text there).
    if (isEditable(e.target) || isBlocked()) return;
    e.preventDefault();
    e.stopPropagation();
    void registry.executeUnknown({ id, args: {} }, { source: "keyboard" });
  };
  window.addEventListener("keydown", handler, true);
  return () => window.removeEventListener("keydown", handler, true);
}
