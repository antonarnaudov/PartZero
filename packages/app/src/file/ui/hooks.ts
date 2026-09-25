/** React access to this window's document layer (see install.ts). */
import { useMemo, useSyncExternalStore } from "react";
import type { RenderBody } from "../../engine/types";
import type { DocumentFiles, FilesState } from "../document-files";
import { documentFiles } from "../install";

const NO_STATE: FilesState = { recoveryId: "", references: [], extraDirty: false, dialog: null, autosave: { at: null, error: null }, warnings: [] };
const noop = (): (() => void) => () => undefined;

export function useDocumentFiles(): DocumentFiles | null {
  return documentFiles();
}

export function useFilesState(): FilesState {
  const files = documentFiles();
  return useSyncExternalStore(files ? files.subscribe : noop, files ? files.getState : () => NO_STATE);
}

/** Display bodies of the visible reference meshes (the viewport draws them after the document's bodies). */
export function useReferenceBodies(): readonly RenderBody[] {
  const refs = useFilesState().references;
  return useMemo(() => refs.filter((r) => r.entry.visible).map((r) => r.body), [refs]);
}
