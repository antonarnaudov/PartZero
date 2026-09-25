/**
 * While sketch mode is open, the one Undo/Redo (title bar, Edit menu, palette, ⌘Z) steps through
 * the sketch's own edits (`doc/undo-scope.ts`); Finish commits them to the model as one step.
 */
import { useEffect } from "react";
import { undoScopes } from "../../doc/undo-scope";
import { sketchMode } from "../../sketch/instance";
import { useStore } from "../context";

export function SketchUndoScope(): null {
  const phase = useStore(sketchMode, (s) => s.phase);
  const name = useStore(sketchMode, (s) => s.sketchName ?? "");
  const canUndo = useStore(sketchMode, (s) => s.snapshot?.canUndo ?? false);
  const canRedo = useStore(sketchMode, (s) => s.snapshot?.canRedo ?? false);
  useEffect(() => {
    if (phase !== "active") {
      undoScopes.clear("sketch");
      return;
    }
    undoScopes.set({ id: "sketch", label: name ? `sketch ${name}` : "sketch", canUndo, canRedo, undo: () => sketchMode.undo(), redo: () => sketchMode.redo() });
  }, [phase, name, canUndo, canRedo]);
  useEffect(() => () => undoScopes.clear("sketch"), []);
  return null;
}
