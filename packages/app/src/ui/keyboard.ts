/**
 * Keyboard-first: one window-level (capture phase) handler maps keybindings to commands.
 *
 * - Bindings with ⌘/Ctrl work everywhere, including inside the code editor (undo/redo go to the
 *   document history, not Monaco's own stack).
 * - Single-key bindings (`F`, `Escape`, `F5`) are ignored while typing in an editable element.
 * - In plain text fields (chat input, palette) undo/redo stay native text editing.
 *
 * The native menu shows the same accelerators but does not register them (`registerAccelerator:
 * false` in the desktop shell), so every shortcut has exactly one owner: this handler.
 */
import type { AppCommandRegistry } from "../commands/commands";
import { eventToKey } from "../commands/registry";

const TEXT_UNDO_REDO = new Set(["mod+z", "mod+shift+z", "mod+y"]);

function isEditable(el: EventTarget | null): { editable: boolean; monaco: boolean } {
  if (!(el instanceof HTMLElement)) return { editable: false, monaco: false };
  const monaco = el.closest(".monaco-editor") !== null;
  const editable = monaco || el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
  return { editable, monaco };
}

export function installKeyboard(registry: AppCommandRegistry, isMac: boolean, isBlocked: () => boolean): () => void {
  const keymap = registry.keymap();
  const handler = (e: KeyboardEvent): void => {
    if (e.isComposing || e.repeat) return;
    const key = eventToKey(e, isMac);
    const id = keymap.get(key);
    if (!id) return;
    const { editable, monaco } = isEditable(e.target);
    const hasModifier = key.includes("mod+") || key.includes("ctrl+") || key.includes("alt+");
    if (!hasModifier && editable) return;
    if (editable && !monaco && TEXT_UNDO_REDO.has(key)) {
      // Native text undo in inputs (Electron on macOS has no Edit-menu role doing it for us).
      e.preventDefault();
      document.execCommand(key === "mod+z" ? "undo" : "redo");
      return;
    }
    // Modal dialogs own Escape and the arrow keys; everything else is blocked while one is open,
    // except toggling the palette itself.
    if (isBlocked() && id !== "view.commandPalette") return;
    e.preventDefault();
    e.stopPropagation();
    void registry.executeUnknown({ id, args: {} }, { source: "keyboard" });
  };
  window.addEventListener("keydown", handler, true);
  return () => window.removeEventListener("keydown", handler, true);
}
