/**
 * The viewport side of a tool's live preview: the bodies a tool showed with `ctx.showPreview`, or
 * null. Works outside the shell too (returns null), so the viewport does not depend on it.
 */
import { useContext, useSyncExternalStore } from "react";
import type { RenderBody } from "../../engine/types";
import { ShellContext } from "./context";

const NONE = (): null => null;
const NOOP = (): (() => void) => () => undefined;

export function useToolPreviewBodies(): readonly RenderBody[] | null {
  const shell = useContext(ShellContext)?.shell ?? null;
  return useSyncExternalStore(shell ? shell.subscribe : NOOP, shell ? () => shell.getState().previewBodies : NONE);
}
