/**
 * The model panels' dialogs: "Delete with dependents" (what a delete takes with it, from the
 * engine's own dependency check) and the rename editor, anchored where the name was.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useApp, useStore } from "../context";
import { useShell } from "../shell/context";
import { ToolIcon } from "../shell/tool-icons";
import { closeModelDialog, commitRename, confirmDelete, modelDialogs, type ModelActionContext } from "./actions";
import { featureIcon, typeTitle } from "./feature-types";
import { ModelIcon } from "./icons";

function DeleteDialog({ ctx }: { ctx: ModelActionContext }): ReactElement | null {
  const d = useStore(modelDialogs, (s) => s.delete);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => ok.current?.focus(), [d]);
  if (!d) return null;
  const n = d.dependents.length;
  return (
    <div className="overlay" onMouseDown={() => closeModelDialog(ctx)}>
      <div
        className="dialog pz-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="pz-del-title"
        data-testid="delete-feature-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            closeModelDialog(ctx);
          }
        }}
      >
        <header className="dialog-head">
          <ModelIcon.Trash size={15} />
          <h2 id="pz-del-title">
            Delete {typeTitle(d.type).toLowerCase()} “{d.name}”?
          </h2>
        </header>
        <div className="pz-confirm-body">
          <p>
            {n === 1 ? "1 feature is" : `${n} features are`} built on <b>{d.name}</b>. They reference it, so they go with it:
          </p>
          <ul className="pz-dep-list" data-testid="delete-dependents">
            {d.dependents.map((x) => (
              <li key={x.id} data-feature={x.name}>
                <ToolIcon name={featureIcon(x.type)} size={14} />
                <span className="pz-dep-name">{x.name}</span>
                <span className="muted">{typeTitle(x.type)}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">To keep them, change what they use first (edit them to use another sketch or face). Undo brings everything back.</p>
        </div>
        <footer className="pz-confirm-foot">
          <button type="button" className="ghost-btn" onClick={() => closeModelDialog(ctx)} data-testid="delete-cancel">
            Cancel
          </button>
          <button ref={ok} type="button" className="primary-btn danger" onClick={() => void confirmDelete(ctx)} data-testid="delete-confirm">
            Delete {n + 1} features
          </button>
        </footer>
      </div>
    </div>
  );
}

function RenameEditor({ ctx }: { ctx: ModelActionContext }): ReactElement | null {
  const r = useStore(modelDialogs, (s) => s.rename);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!r) return;
    setText(r.name);
    requestAnimationFrame(() => input.current?.select());
  }, [r]);
  if (!r) return null;
  const width = Math.max(180, r.anchor.w);
  const left = Math.max(6, Math.min(r.anchor.x, window.innerWidth - width - 8));
  const top = Math.max(6, Math.min(r.anchor.y - 40, window.innerHeight - 90));
  return (
    <div className="pz-rename-layer" onMouseDown={() => closeModelDialog(ctx)}>
      <form
        className="pz-rename"
        style={{ left, top, width }}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void commitRename(ctx, text);
        }}
        data-testid="rename-editor"
      >
        <label className="pz-rename-label" htmlFor="pz-rename-input">
          Rename {r.kind === "param" ? "parameter" : "feature"}
        </label>
        <input
          id="pz-rename-input"
          ref={input}
          className="pz-field mono"
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              closeModelDialog(ctx);
            }
          }}
          data-testid="rename-input"
        />
      </form>
    </div>
  );
}

/** Mount once (the app shell does): renders whichever model dialog is open. */
export function ModelDialogs(): ReactElement {
  const { services } = useApp();
  const { shell } = useShell();
  const ctx: ModelActionContext = { services, shell };
  // Another document, or the app closing its dialogs, drops ours.
  const dialog = useStore(services.ui, (s) => s.dialog);
  const docId = useStore(services.doc, (s) => s.docId);
  useEffect(() => {
    const s = modelDialogs.getState();
    if ((s.delete || s.rename) && dialog !== "model") modelDialogs.set({});
  }, [dialog]);
  useEffect(() => closeModelDialog(ctx), [docId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <DeleteDialog ctx={ctx} />
      <RenameEditor ctx={ctx} />
    </>
  );
}
