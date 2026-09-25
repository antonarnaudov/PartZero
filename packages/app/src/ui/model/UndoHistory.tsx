/**
 * The undo history list (beside Undo/Redo in the title bar): every step of the document's history,
 * newest first, with who made it (you, the assistant, a tool). Click a step to go back (or forward)
 * to just after it; each hop is the ordinary `edit.undo` / `edit.redo`, so nothing is lost and
 * Redo still works.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { undoScopes } from "../../doc/undo-scope";
import { useApp, useStore } from "../context";
import { useShell } from "../shell/context";
import { ModelIcon } from "./icons";
import "./model.css";
import "./panels.css";

interface Step {
  label: string;
  origin: string;
}

const isAgent = (origin: string): boolean => origin === "agent" || origin.startsWith("mcp:");

/** An op label for people: an expression value reads as its text (`= h`, not `= {"expr":"h"}`). */
export function readableLabel(label: string): string {
  return label.replace(/\{"expr":"((?:[^"\\]|\\.)*)"\}/g, (_m, e: string) => e.replace(/\\"/g, '"'));
}

export function UndoHistoryButton(): ReactElement {
  const { services } = useApp();
  const { shell } = useShell();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<{ undo: Step[]; redo: Step[] }>({ undo: [], redo: [] });
  const scope = useStore(undoScopes, (s) => s.scope);
  const canUndo = useStore(services.doc, (s) => s.history.canUndo);
  const canRedo = useStore(services.doc, (s) => s.history.canRedo);
  const ref = useRef<HTMLDivElement>(null);
  const refresh = (): void => setEntries(services.doc.historyEntries());
  const revision = useStore(services.doc, (s) => `${s.docId}:${s.revision}:${s.history.undoLabel ?? ""}:${s.history.redoLabel ?? ""}:${s.v1?.host.rollback ?? ""}`);
  useEffect(() => {
    if (open) refresh();
  }, [open, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  const hop = async (id: "edit.undo" | "edit.redo", n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      const r = (await shell.execute({ id, args: {} }, "ui")) as { ok: boolean; value?: { undone?: boolean; redone?: boolean } };
      if (!r.ok || !(r.value?.undone ?? r.value?.redone)) break;
      await services.doc.idle().catch(() => undefined);
    }
    refresh();
  };

  const n = entries.undo.length;
  return (
    <div className="pzh" ref={ref}>
      <button
        type="button"
        className="tb-btn pzh-btn"
        title="Undo history"
        aria-label="Undo history"
        aria-expanded={open}
        disabled={scope !== null || (!canUndo && !canRedo)}
        onClick={() => setOpen((o) => !o)}
        data-testid="tb-history"
      >
        <ModelIcon.History size={14} />
      </button>
      {open && (
        <div className="pzh-pop" role="menu" aria-label="Undo history" data-testid="history-list">
          <div className="pzh-head">History</div>
          <div className="pzh-list">
            {[...entries.redo].reverse().map((s, i, all) => (
              <button key={`r${i}`} type="button" role="menuitem" className="pzh-item redo" onClick={() => void hop("edit.redo", all.length - i)} data-testid="history-redo" title="Redo up to here">
                <span className="pzh-dot" />
                <span className="pzh-label">{readableLabel(s.label)}</span>
                {isAgent(s.origin) && <span className="pzb-ai">AI</span>}
              </button>
            ))}
            {[...entries.undo].reverse().map((s, i) => (
              <button
                key={`u${i}`}
                type="button"
                role="menuitem"
                className={`pzh-item${i === 0 ? " current" : ""}`}
                disabled={i === 0}
                onClick={() => void hop("edit.undo", i)}
                data-testid="history-undo"
                title={i === 0 ? "The model now" : "Go back to just after this step"}
              >
                <span className="pzh-dot" />
                <span className="pzh-label">{readableLabel(s.label)}</span>
                {isAgent(s.origin) && <span className="pzb-ai">AI</span>}
                {i === 0 && <span className="pzh-now">now</span>}
              </button>
            ))}
            <button type="button" role="menuitem" className={`pzh-item start${n === 0 ? " current" : ""}`} disabled={n === 0} onClick={() => void hop("edit.undo", n)} data-testid="history-start" title="Go back to how the document opened">
              <span className="pzh-dot" />
              <span className="pzh-label">Opened</span>
              {n === 0 && <span className="pzh-now">now</span>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
