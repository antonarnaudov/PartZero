/**
 * The document layer's UI, mounted once by the shell (`<FileLayer />` in App.tsx): the recovery dialog after a crash,
 * the export dialog, the recent-documents grid, and the References panel (imported meshes with their measures).
 * Everything it changes goes through `file.*` commands.
 */
import { useEffect, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import type { RecentDocument, RecoveryEntry } from "../../bridge";
import { useApp } from "../../ui/context";
import { Icon } from "../../ui/icons";
import type { ReferenceMesh } from "../document-files";
import { formatSize } from "../document-files";
import { exportFormats } from "../export-formats";
import { useDocumentFiles, useFilesState } from "./hooks";
import "./file.css";

function timeAgo(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}

/** Run a command from this UI (failures surface as toasts, like every UI command). */
function useExec(): (id: string, args?: Record<string, unknown>) => void {
  const { commands } = useApp();
  return (id, args = {}) => void commands.executeUnknown({ id, args }, { source: "ui" });
}

/** Escape closes the dialog. Capture phase: the app's keyboard handler (also capture, registered first) stops propagation. */
function useEscape(onClose: () => void): void {
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
}

function RecoveryDialog({ entries, uncleanExit }: { entries: RecoveryEntry[]; uncleanExit: boolean }): ReactElement {
  const exec = useExec();
  const files = useDocumentFiles();
  const close = (): void => files?.closeDialog();
  useEscape(close);
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog pz-recovery" role="dialog" aria-label="Recover unsaved documents" data-testid="recovery-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <Icon.Warning size={15} />
          <h2>Recover unsaved documents</h2>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <Icon.Close size={12} />
          </button>
        </header>
        <p className="pz-lead">
          {uncleanExit ? "PartZero did not quit normally last time. " : ""}
          {entries.length === 1 ? "This document had" : "These documents had"} changes that were not saved. Restore to keep working on them, or discard them.
        </p>
        <ul className="pz-list">
          {entries.map((e) => (
            <li key={e.id} className="pz-row" data-testid="recovery-item" data-recovery-id={e.id}>
              <Icon.File size={16} />
              <div className="pz-row-main">
                <span className="pz-row-title">{e.title}</span>
                <span className="pz-row-meta">
                  {e.path ?? "Never saved"} · autosaved {timeAgo(e.savedAt)}
                </span>
              </div>
              <button type="button" className="ghost-btn" data-testid="recovery-discard" onClick={() => exec("file.discardRecovery", { id: e.id })}>
                Discard
              </button>
              <button type="button" className="primary-btn small" data-testid="recovery-restore" onClick={() => exec("file.restoreRecovery", { id: e.id })}>
                Restore
              </button>
            </li>
          ))}
        </ul>
        <footer className="pz-foot">
          <span className="muted small">Kept until you restore or discard them.</span>
          <span className="spacer" />
          <button type="button" className="ghost-btn" onClick={close}>
            Later
          </button>
          {entries.length > 1 && (
            <button
              type="button"
              className="primary-btn small"
              onClick={() => {
                for (const e of entries) exec("file.restoreRecovery", { id: e.id });
              }}
            >
              Restore all
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function ExportDialog({ initial }: { initial: string | null }): ReactElement {
  const { services } = useApp();
  const exec = useExec();
  const files = useDocumentFiles();
  const formats = exportFormats();
  const engine = services.engines.active;
  const firstAvailable = formats.find((f) => f.available({ engine }).ok)?.id ?? formats[0]?.id ?? "3mf";
  const [format, setFormat] = useState(initial ?? firstAvailable);
  const close = (): void => files?.closeDialog();
  useEscape(close);
  const current = formats.find((f) => f.id === format);
  const verdict = current?.available({ engine }) ?? { ok: false as const, reason: "unknown format" };
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog pz-export" role="dialog" aria-label="Export" data-testid="export-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <Icon.Export size={15} />
          <h2>Export</h2>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <Icon.Close size={12} />
          </button>
        </header>
        <div className="pz-formats" role="radiogroup" aria-label="Format">
          {formats.map((f) => {
            const ok = f.available({ engine });
            return (
              <label key={f.id} className={`pz-format${format === f.id ? " active" : ""}${ok.ok ? "" : " unavailable"}`} data-testid="export-format" data-format={f.id}>
                <input type="radio" name="pz-export-format" checked={format === f.id} onChange={() => setFormat(f.id)} />
                <span className="pz-format-label">{f.label}</span>
                <span className="pz-format-ext mono">.{f.extensions[0]}</span>
                <span className="pz-format-desc">{ok.ok ? f.description : ok.reason}</span>
              </label>
            );
          })}
        </div>
        <footer className="pz-foot">
          <span className="muted small">{verdict.ok ? "Every body of the document is exported, in millimetres." : verdict.reason}</span>
          <span className="spacer" />
          <button type="button" className="ghost-btn" onClick={close}>
            Cancel
          </button>
          <button type="button" className="primary-btn small" data-testid="export-run" disabled={!verdict.ok} onClick={() => exec("file.export", { format })}>
            Export…
          </button>
        </footer>
      </div>
    </div>
  );
}

function Thumb({ item }: { item: RecentDocument }): ReactElement {
  const files = useDocumentFiles();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!item.hasThumbnail || !files) return;
    let revoked = false;
    let made: string | null = null;
    void files.thumbnail(item.path).then((png) => {
      if (!png || revoked) return;
      made = URL.createObjectURL(new Blob([new Uint8Array(png)], { type: "image/png" }));
      setUrl(made);
    });
    return () => {
      revoked = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [item.path, item.hasThumbnail, files]);
  return url ? <img src={url} alt="" className="pz-thumb-img" /> : <Icon.Cube size={28} />;
}

function RecentDialog({ items }: { items: RecentDocument[] }): ReactElement {
  const exec = useExec();
  const files = useDocumentFiles();
  const close = (): void => files?.closeDialog();
  useEscape(close);
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog pz-recent" role="dialog" aria-label="Recent documents" data-testid="recent-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <Icon.FolderOpen size={15} />
          <h2>Recent documents</h2>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <Icon.Close size={12} />
          </button>
        </header>
        {items.length === 0 ? (
          <p className="pz-lead">No recent documents yet. Documents you open or save appear here.</p>
        ) : (
          <div className="pz-grid">
            {items.map((it) => (
              <button
                key={it.path}
                type="button"
                className={`pz-card${it.exists ? "" : " missing"}`}
                data-testid="recent-card"
                data-path={it.path}
                disabled={!it.exists}
                title={it.exists ? it.path : `${it.path} (moved or deleted)`}
                onClick={() => {
                  files?.closeDialog();
                  exec("file.openRecent", { path: it.path });
                }}
              >
                <span className="pz-thumb">
                  <Thumb item={it} />
                </span>
                <span className="pz-card-name">{it.name}</span>
                <span className="pz-card-meta">{it.exists ? timeAgo(it.modifiedMs) : "missing"}</span>
                <span className="pz-card-folder">{folderOf(it.path)}</span>
              </button>
            ))}
          </div>
        )}
        <footer className="pz-foot">
          <span className="spacer" />
          {items.length > 0 && (
            <button type="button" className="ghost-btn" onClick={() => exec("file.clearRecent")}>
              Clear recent
            </button>
          )}
          <button type="button" className="primary-btn small" onClick={() => exec("file.open")}>
            Open…
          </button>
        </footer>
      </div>
    </div>
  );
}

function ReferenceRow({ r }: { r: ReferenceMesh }): ReactElement {
  const exec = useExec();
  const m = r.measure;
  const [open, setOpen] = useState(false);
  return (
    <li className="pz-ref" data-testid="reference-item" data-reference={r.entry.id}>
      <div className="pz-ref-head">
        <button
          type="button"
          className="icon-btn"
          aria-label={r.entry.visible ? `Hide ${r.entry.name}` : `Show ${r.entry.name}`}
          onClick={() => exec("file.setReferenceVisible", { id: r.entry.id, visible: !r.entry.visible })}
        >
          {r.entry.visible ? <Icon.Eye size={13} /> : <Icon.EyeOff size={13} />}
        </button>
        <button type="button" className="pz-ref-name" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {r.entry.name}
          <span className="pz-ref-fmt">{r.entry.format.toUpperCase()}</span>
        </button>
        <button type="button" className="icon-btn" aria-label={`Remove ${r.entry.name}`} onClick={() => exec("file.removeReference", { id: r.entry.id })}>
          <Icon.Close size={11} />
        </button>
      </div>
      <div className="pz-ref-size" data-testid="reference-size">
        {formatSize(m)}
      </div>
      {open && (
        <dl className="pz-ref-measure">
          <dt>Triangles</dt>
          <dd>{m.triangles.toLocaleString("en-US")}</dd>
          <dt>Surface</dt>
          <dd>{(Math.round(m.area * 10) / 10).toLocaleString("en-US")} mm²</dd>
          <dt>Volume</dt>
          <dd>{m.volume === null ? (m.closed ? "not oriented" : "open mesh") : `${(Math.round(m.volume * 10) / 10).toLocaleString("en-US")} mm³`}</dd>
          <dt>From</dt>
          <dd className="mono">{r.entry.sourceName}</dd>
        </dl>
      )}
    </li>
  );
}

/**
 * The References card sits in the viewport's bottom-right corner (a portal into the viewport, which positions its
 * overlays), or bottom-right of the window when there is no viewport element.
 */
function ReferencesPanel({ refs }: { refs: ReferenceMesh[] }): ReactElement {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(document.querySelector<HTMLElement>('[data-testid="viewport"]'));
  }, []);
  const panel = (
    <section className={`pz-refs${host ? " in-viewport" : ""}`} aria-label="Reference meshes" data-testid="references-panel">
      <header title="Imported meshes: shown and measured, not editable, saved inside the .partzero">
        <span>References</span>
        <span className="muted small">{refs.length}</span>
      </header>
      <ul>
        {refs.map((r) => (
          <ReferenceRow key={r.entry.id} r={r} />
        ))}
      </ul>
    </section>
  );
  return host ? createPortal(panel, host) : panel;
}

export function FileLayer(): ReactElement | null {
  const state = useFilesState();
  const files = useDocumentFiles();
  const refs = state.references;
  if (!files) return null;
  const d = state.dialog;
  return (
    <>
      {refs.length > 0 && <ReferencesPanel refs={refs} />}
      {d?.kind === "recovery" && <RecoveryDialog entries={d.entries} uncleanExit={d.uncleanExit} />}
      {d?.kind === "export" && <ExportDialog initial={d.format} />}
      {d?.kind === "recent" && <RecentDialog items={d.items} />}
    </>
  );
}
