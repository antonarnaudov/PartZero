/**
 * Keyboard-first: one window-level (capture phase) handler maps keybindings to commands and tools.
 *
 * - Bindings with ⌘/Ctrl work everywhere, including inside the code editor (undo/redo go to the
 *   document history, not Monaco's own stack).
 * - Single-key bindings (`F`, `Escape`, `F5`, tool keys like `E`) are ignored while typing in an
 *   editable element, and Space/Enter keep activating a focused button.
 * - In plain text fields (chat input, palette) undo/redo stay native text editing.
 * - Esc unwinds one layer at a time (plan C10): the open tool panel, then the welcome screen, then
 *   the selection (`selection.clear`). Enter outside a text field presses OK on the open panel.
 * - Tool shortcuts come from the tool registry, for the current mode; an app command bound to the
 *   same key keeps it.
 *
 * The native menu shows the same accelerators but does not register them (`registerAccelerator:
 * false` in the desktop shell), so every shortcut has exactly one owner: this handler.
 */
import type { AppCommandRegistry } from "../commands/commands";
import { eventToKey } from "../commands/registry";
import type { Shell } from "../tools/shell";

const TEXT_UNDO_REDO = new Set(["mod+z", "mod+shift+z", "mod+y"]);

function classify(el: EventTarget | null): { editable: boolean; monaco: boolean; interactive: boolean } {
  if (!(el instanceof HTMLElement)) return { editable: false, monaco: false, interactive: false };
  const monaco = el.closest(".monaco-editor") !== null;
  const editable = monaco || el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
  const interactive = el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button" || el.getAttribute("role") === "switch" || el.getAttribute("role") === "radio" || el.getAttribute("role") === "tab" || el.getAttribute("role") === "menuitem";
  return { editable, monaco, interactive };
}

/** `eventToKey` with Space spelled out (`" "` → `space`), as bindings write it. */
export function keyOf(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, isMac: boolean): string {
  const k = eventToKey(e, isMac);
  return k.endsWith(" ") ? `${k.slice(0, -1)}space` : k;
}

export function installKeyboard(registry: AppCommandRegistry, isMac: boolean, isBlocked: () => boolean, shell?: Shell): () => void {
  const keymap = shell ? shell.commandKeymap() : registry.keymap();
  const execute = (id: string): void => {
    if (shell) void shell.execute({ id, args: {} }, "keyboard");
    else void registry.executeUnknown({ id, args: {} }, { source: "keyboard" });
  };
  const enabled = (id: string): boolean => (shell ? shell.isCommandEnabled(id) : registry.isEnabled(id));

  const handler = (e: KeyboardEvent): void => {
    if (e.isComposing || e.repeat) return;
    const key = keyOf(e, isMac);
    const { editable, monaco, interactive } = classify(e.target);
    const hasModifier = key.includes("mod+") || key.includes("ctrl+") || key.includes("alt+");
    const blocked = isBlocked();

    // 1. The open tool panel owns Esc and Enter (inside its fields the panel handles them itself).
    if (shell && !blocked && !editable && !hasModifier) {
      if (key === "escape" && shell.getState().panel) {
        e.preventDefault();
        e.stopPropagation();
        shell.cancelPanel();
        return;
      }
      if (key === "enter" && shell.getState().panel && !interactive) {
        e.preventDefault();
        e.stopPropagation();
        void shell.commitPanel();
        return;
      }
      if (key === "escape" && shell.welcomeVisible()) {
        e.preventDefault();
        shell.dismissWelcome();
        return;
      }
    }

    // 2. App (and shell) commands.
    const id = keymap.get(key);
    if (id) {
      if (!hasModifier && editable) return;
      if (!hasModifier && interactive && (key === "space" || key === "enter")) return;
      if (editable && !monaco && TEXT_UNDO_REDO.has(key)) {
        // Native text undo in inputs (Electron on macOS has no Edit-menu role doing it for us).
        e.preventDefault();
        document.execCommand(key === "mod+z" ? "undo" : "redo");
        return;
      }
      // Modal dialogs own Escape and the arrow keys; everything else is blocked while one is open,
      // except toggling the palette and the shortcuts map themselves.
      if (blocked && id !== "view.commandPalette" && id !== "help.shortcuts") return;
      // A single key whose command cannot run now stays with the focused element (Space on a button).
      if (!hasModifier && !enabled(id)) return;
      e.preventDefault();
      e.stopPropagation();
      execute(id);
      return;
    }

    // 3. Tools of the current mode.
    if (!shell || blocked || (editable && !hasModifier)) return;
    const toolId = shell.tools.keymap(shell.getState().mode).get(key);
    if (!toolId) return;
    const tool = shell.tools.get(toolId);
    if (!tool || shell.enablement(tool) !== true) return;
    e.preventDefault();
    e.stopPropagation();
    void shell.startTool(toolId, "keyboard");
  };
  window.addEventListener("keydown", handler, true);
  return () => window.removeEventListener("keydown", handler, true);
}
