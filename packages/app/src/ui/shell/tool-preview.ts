/**
 * The viewport side of a tool's live preview: the bodies of the open panel's last passing preview,
 * or null. Works outside the shell too (returns null), so the viewport does not depend on it.
 */
import { useContext, useSyncExternalStore } from "react";
import type { RenderBody } from "../../engine/types";
import { ShellContext } from "./context";

const NONE = (): null => null;
const NO = (): boolean => false;
const NOOP = (): (() => void) => () => undefined;

export function useToolPreviewBodies(): readonly RenderBody[] | null {
  const shell = useContext(ShellContext)?.shell ?? null;
  return useSyncExternalStore(shell ? shell.subscribe : NOOP, shell ? () => shell.getState().previewBodies : NONE);
}

/** True while the panel checks newer values: the preview bodies may not match its fields any more. */
export function useToolPreviewStale(): boolean {
  const shell = useContext(ShellContext)?.shell ?? null;
  return useSyncExternalStore(shell ? shell.subscribe : NOOP, shell ? () => shell.getState().previewStale : NO);
}
