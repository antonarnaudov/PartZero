/**
 * Undo "across everything": the one Undo/Redo (title bar, ⌘Z / ⇧⌘Z, Edit menu, palette) goes to
 * the innermost editing session that has its own history while it is open — sketch mode's edits
 * before they are finished into the model — and to the document's history otherwise.
 *
 * A session registers itself as the active scope while it is open (`undoScopes.set`) and clears
 * it when it closes; `edit.undo` / `edit.redo` and the title bar read it.
 */
import { Store } from "../store";

export interface UndoScope {
  /** `sketch`, … */
  id: string;
  /** For people: "sketch outline". */
  label: string;
  canUndo: boolean;
  canRedo: boolean;
  undo(): void;
  redo(): void;
}

class UndoScopeStore extends Store<{ scope: UndoScope | null }> {
  constructor() {
    super({ scope: null });
  }

  /** The active scope, or null (the document's history). */
  get active(): UndoScope | null {
    return this.getState().scope;
  }

  set(scope: UndoScope): void {
    this.setState({ scope });
  }

  /** Close `id`'s scope (a no-op when another scope is active). */
  clear(id: string): void {
    if (this.getState().scope?.id === id) this.setState({ scope: null });
  }
}

export const undoScopes = new UndoScopeStore();
