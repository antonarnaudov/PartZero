import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useApp, useStore } from "./context";
import { fuzzyScore } from "./CommandPalette";
import { Icon } from "./icons";

export function TemplateDialog(): ReactElement {
  const { services, run } = useApp();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const templates = services.templates;
  const results = useMemo(
    () =>
      templates
        .map((t) => ({ t, score: Math.max(fuzzyScore(query, t.title), fuzzyScore(query, `${t.tags.join(" ")} ${t.id}`) - 20) }))
        .filter((r) => r.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.t),
    [templates, query],
  );
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);
  const close = (): void => services.ui.closeDialog();
  const open = (id: string | undefined): void => {
    if (id) run({ id: "file.newFromTemplate", args: { templateId: id } });
  };
  const current = results[index];

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog templates" role="dialog" aria-label="New from template" data-testid="template-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <Icon.Template size={15} />
          <h2>New from template</h2>
          <span className="muted small">MakerBench reference models · {templates.length}</span>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <Icon.Close size={12} />
          </button>
        </header>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search templates (bracket, gasket, nema…)"
          value={query}
          aria-label="Search templates"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              open(current?.id);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        />
        <div className="tpl-body">
          <div className="tpl-list" role="listbox">
            {results.map((t, i) => (
              <div
                key={t.id}
                role="option"
                aria-selected={i === index}
                data-testid="template-item"
                data-template={t.id}
                className={`tpl-item${i === index ? " active" : ""}`}
                onMouseMove={() => setIndex(i)}
                onClick={() => open(t.id)}
              >
                <span className="tpl-title">{t.title}</span>
                <span className="tpl-meta">
                  {t.tier && <span className="tag">{t.tier}</span>}
                  {t.process && <span className="tag">{t.process}</span>}
                </span>
              </div>
            ))}
          </div>
          <div className="tpl-detail">
            {current ? (
              <>
                <h3>{current.title}</h3>
                <p>{current.description}</p>
                <div className="tpl-tags">
                  {current.tags.map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                </div>
                <pre className="tpl-source">{current.source.split("\n").slice(0, 16).join("\n")}</pre>
                <button type="button" className="primary-btn" onClick={() => open(current.id)}>
                  Create from template
                </button>
              </>
            ) : (
              <p className="muted">No templates match.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AboutDialog(): ReactElement {
  const { services } = useApp();
  const info = useStore(services.ui, (s) => s.appInfo);
  const engines = useStore(services.engines, (s) => s.candidates);
  const active = useStore(services.engines, (s) => s.active);
  const viewport = useStore(services.ui, (s) => s.viewport);
  const close = (): void => services.ui.closeDialog();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const rows: Array<[string, string]> = [
    ["Version", info?.version ?? "—"],
    ["Electron / Chrome / Node", info ? `${info.electron} / ${info.chrome} / ${info.node}` : "—"],
    ["Platform", info ? `${info.platform} ${info.arch}` : "—"],
    ["Cross-origin isolated", String(globalThis.crossOriginIsolated === true)],
    ["Active engine", `${active.label} — ${active.detail}`],
    ...engines.map((c): [string, string] => [`Engine: ${c.id}`, `${c.available === null ? "not probed" : c.available ? "available" : "unavailable"} — ${c.detail}`]),
    ["Viewport", `${viewport.kind} · ${viewport.backend}`],
  ];
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog about" role="dialog" aria-label="About aicad" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <Icon.Cube size={15} />
          <h2>aicad</h2>
          <span className="muted small">AI-native CAD · app shell spike</span>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <Icon.Close size={12} />
          </button>
        </header>
        <dl className="about-grid">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="muted small">MPL-2.0. Forge kernel, CadScript and the Feature-Graph IR are developed in this repository.</p>
      </div>
    </div>
  );
}

export function Toasts(): ReactElement {
  const { services } = useApp();
  const toasts = useStore(services.ui, (s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => services.ui.dismissToast(t.id)}>
          {t.kind === "error" ? <Icon.Error size={13} /> : t.kind === "success" ? <Icon.Check size={13} /> : <Icon.Info size={13} />}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
