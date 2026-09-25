/**
 * Feature timeline: parts → features with type icons, status badges, suppressed and rolled-back
 * state, the assistant's features marked (ADR 0015), and error tooltips (code, message, hint).
 *
 * - Click selects the feature; double-click edits it (a sketch opens in sketch mode, any other
 *   feature in its property panel: `feature.edit`).
 * - Right-click (or the ⋯ button) opens the feature's menu: Edit, Suppress, Roll Back Here, Move
 *   Up / Down, Keep (the assistant's features), Delete. Every entry is a command of the command
 *   layer (`ir.*`), the same the agent and MCP call.
 * - The rollback marker is drawn after the last built feature; features after it are not built.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { Problem } from "../doc/problems";
import type { FeatureStatus, TimelineFeature, TimelineModel } from "../doc/timeline";
import { editSketchFeature } from "../sketch/integration";
import { useApp, useStore } from "./context";
import { Icon } from "./icons";
import { useShell } from "./shell/context";
import { ToolIcon } from "./shell/tool-icons";

/** The toolbar glyph for each IR feature type. */
const TYPE_ICON: Record<string, string> = {
  sketch: "sketch",
  extrude: "extrude",
  revolve: "revolve",
  hole: "hole",
  fillet: "fillet",
  chamfer: "chamfer",
  shell: "shell",
  draft: "draft",
  boolean: "combine",
  pattern: "linearPattern",
  datum_plane: "plane",
  datum_axis: "axis",
  tag: "properties",
};

const STATUS_LABEL: Record<FeatureStatus, string> = {
  ok: "OK",
  warning: "Warning",
  error: "Error",
  suppressed: "Suppressed",
  pending: "Not evaluated",
  "rolled-back": "Rolled back (not built)",
};

function StatusBadge({ status }: { status: FeatureStatus }): ReactElement {
  return (
    <span className={`status-badge status-${status}`} aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]}>
      {status === "ok" && <Icon.Check size={12} />}
      {status === "error" && <Icon.Error size={12} />}
      {status === "warning" && <Icon.Warning size={12} />}
      {status === "suppressed" && <Icon.EyeOff size={12} />}
      {(status === "pending" || status === "rolled-back") && <span className="status-dot" />}
    </span>
  );
}

function IssueTooltip({ issues }: { issues: readonly Problem[] }): ReactElement {
  return (
    <div className="issue-tooltip" role="tooltip">
      {issues.slice(0, 4).map((p) => (
        <div key={p.key} className="issue">
          <div className="issue-head">
            <span className={`sev sev-${p.severity}`}>{p.severity}</span>
            <code>{p.code}</code>
          </div>
          <div className="issue-msg">{p.message}</div>
          {p.hint && <div className="issue-hint">{p.hint}</div>}
        </div>
      ))}
      {issues.length > 4 && <div className="issue-more">+{issues.length - 4} more in Problems</div>}
    </div>
  );
}

interface MenuItem {
  key: string;
  label: string;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
}

function FeatureMenu({ items, at, onClose }: { items: readonly MenuItem[]; at: { x: number; y: number }; onClose: () => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", esc, true);
    ref.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("keydown", esc, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="tl-menu" role="menu" style={{ left: at.x, top: at.y }} data-testid="timeline-menu">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="menuitem"
          className={`tl-menu-item${it.danger ? " danger" : ""}`}
          disabled={it.disabled}
          data-testid={`timeline-menu-${it.key}`}
          onClick={() => {
            onClose();
            it.run();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

interface RowProps {
  f: TimelineFeature;
  selected: boolean;
  focused: boolean;
  draft?: string | undefined;
  /** Where "Move Up" puts it (after this id; null = first), or undefined at the top. */
  upAfter: string | null | undefined;
  /** Where "Move Down" puts it (after this id), or undefined at the bottom. */
  downAfter: string | undefined;
  v1: boolean;
  isMarker: boolean;
}

function FeatureRow({ f, selected, focused, draft, upAfter, downAfter, v1, isMarker }: RowProps): ReactElement {
  const { run, services } = useApp();
  const { shell } = useShell();
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const firstIssue = f.issues[0];

  const edit = () => {
    if (f.type === "sketch") {
      if (editSketchFeature(f.id)) return;
    }
    void shell.execute({ id: "feature.edit", args: { feature: f.id } }, "ui");
  };
  const del = async () => {
    const r = await shell.execute({ id: "ir.dependents", args: { feature: f.id } }, "ui");
    const deps = r && r.ok ? ((r.value as { dependents: Array<{ name: string }> }).dependents ?? []) : [];
    if (deps.length > 0) {
      const ok = await services.confirm(`Delete ${f.name} and the ${deps.length} feature${deps.length === 1 ? "" : "s"} built on it (${deps.map((d) => d.name).join(", ")})?`);
      if (!ok) return;
      run({ id: "ir.deleteFeature", args: { feature: f.id, dependents: "cascade" } }, "ui");
    } else {
      run({ id: "ir.deleteFeature", args: { feature: f.id } }, "ui");
    }
  };
  const items: MenuItem[] = [
    { key: "edit", label: f.type === "sketch" ? "Edit Sketch" : "Edit Feature…", run: edit },
    ...(v1
      ? [
          { key: "suppress", label: f.suppressed ? "Unsuppress" : "Suppress", run: () => run({ id: "ir.setSuppressed", args: { feature: f.id, suppressed: !f.suppressed } }, "ui") },
          isMarker
            ? { key: "rollforward", label: "Roll to End", run: () => run({ id: "ir.setRollback", args: { after: null } }, "ui") }
            : { key: "rollback", label: "Roll Back to Here", run: () => run({ id: "ir.setRollback", args: { after: f.id } }, "ui") },
          { key: "up", label: "Move Up", disabled: upAfter === undefined, run: () => run({ id: "ir.moveFeature", args: { feature: f.id, after: upAfter ?? null } }, "ui") },
          { key: "down", label: "Move Down", disabled: downAfter === undefined, run: () => run({ id: "ir.moveFeature", args: { feature: f.id, after: downAfter ?? null } }, "ui") },
          ...(f.agent ? [{ key: "keep", label: "Keep (make it yours)", run: () => run({ id: "ir.setAuthor", args: { features: [f.id], author: "user" } }, "ui") }] : []),
          { key: "delete", label: "Delete", danger: true, run: () => void del() },
        ]
      : [{ key: "suppress", label: f.suppressed ? "Unsuppress" : "Suppress", run: () => run({ id: "feature.setSuppressed", args: { feature: f.id, suppressed: !f.suppressed } }, "ui") }]),
  ];
  return (
    <li
      className={`tl-feature${selected ? " selected" : ""}${focused ? " focused" : ""}${f.suppressed ? " suppressed" : ""}${f.rolledBack ? " rolled-back" : ""} st-${f.status}`}
      data-testid="timeline-feature"
      data-feature={f.name}
      data-feature-id={f.id}
      data-part={f.partId}
      data-type={f.type}
      data-status={f.status}
      data-author={f.agent ? "agent" : "user"}
      data-draft={draft ?? ""}
      aria-selected={selected}
      role="treeitem"
      tabIndex={-1}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => run({ id: "selection.selectFeature", args: { feature: f.id, origin: "timeline" } })}
      onDoubleClick={edit}
      onContextMenu={(e) => {
        e.preventDefault();
        run({ id: "selection.selectFeature", args: { feature: f.id, origin: "timeline" } });
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") edit();
      }}
    >
      <span className={`tl-type type-${f.type}`} title={f.type}>
        <ToolIcon name={TYPE_ICON[f.type] ?? f.type} size={15} />
      </span>
      <span className="tl-text">
        <span className="tl-name">
          {f.name}
          {f.agent && (
            <span className="tl-agent" title="Made by the assistant — it stays marked until you edit it or choose Keep" data-testid="timeline-agent-badge">
              AI
            </span>
          )}
        </span>
        <span className="tl-summary">{firstIssue && f.status === "error" ? firstIssue.code : f.summary}</span>
      </span>
      {draft && (
        <span className={`kind-badge tl-draft kind-${draft}`} title={`The agent's proposal ${draft === "removed" ? "removes" : "changes"} this feature`} aria-label={draft === "removed" ? "removed by the proposal" : "changed by the proposal"}>
          {draft === "removed" ? "−" : "Δ"}
        </span>
      )}
      <button
        type="button"
        className="tl-action"
        title={f.suppressed ? "Unsuppress" : "Suppress"}
        aria-label={f.suppressed ? `Unsuppress ${f.name}` : `Suppress ${f.name}`}
        onClick={(e) => {
          e.stopPropagation();
          run(v1 ? { id: "ir.setSuppressed", args: { feature: f.id, suppressed: !f.suppressed } } : { id: "feature.setSuppressed", args: { feature: f.id, suppressed: !f.suppressed } }, "ui");
        }}
      >
        {f.suppressed ? <Icon.Eye size={13} /> : <Icon.EyeOff size={13} />}
      </button>
      <button
        type="button"
        className="tl-action"
        title="More…"
        aria-label={`More actions for ${f.name}`}
        data-testid="timeline-more"
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 2 });
        }}
      >
        ⋯
      </button>
      <StatusBadge status={f.status} />
      {hover && f.issues.length > 0 && <IssueTooltip issues={f.issues} />}
      {menu && <FeatureMenu items={items} at={menu} onClose={() => setMenu(null)} />}
    </li>
  );
}

export function Timeline({ timeline }: { timeline: TimelineModel }): ReactElement {
  const { services, run } = useApp();
  const selectedId = useStore(services.doc, (s) => s.selection.featureId);
  const focusId = useStore(services.ui, (s) => s.codeFocusFeatureId);
  const phase = useStore(services.doc, (s) => s.phase);
  const hasCompile = useStore(services.doc, (s) => s.compile !== null);
  const v1 = useStore(services.doc, (s) => s.format === "ir-v1");
  const review = useStore(services.agent, (s) => (s.review && s.review.status === "ready" && s.review.resolution === null ? s.review : null));
  const draftKinds = new Map((review?.changes ?? []).map((c) => [`${c.part}/${c.feature}`, c.kind]));
  const agentCount = timeline.parts.reduce((n, p) => n + p.features.filter((f) => f.agent).length, 0);

  return (
    <section className="panel timeline" aria-label="Feature timeline">
      {/* The dock's tab titles the panel; this row says what is in it. */}
      <header className="panel-header tl-header">
        <span className="panel-meta" data-testid="timeline-count">
          {timeline.featureCount > 0
            ? `${timeline.featureCount} feature${timeline.featureCount === 1 ? "" : "s"}${timeline.parts.length > 1 ? ` · ${timeline.parts.length} parts` : ""}`
            : "History"}
        </span>
        <span className="spacer" />
        {timeline.rollback && (
          <button type="button" className="link-button" onClick={() => run({ id: "ir.setRollback", args: { after: null } }, "ui")} title="Build every feature again">
            Roll to end
          </button>
        )}
      </header>
      {timeline.stale && (
        <div className="panel-banner warn" data-testid="timeline-stale">
          <Icon.Warning size={13} /> Code has errors — showing the last valid model
        </div>
      )}
      {agentCount > 0 && (
        <div className="panel-banner info tl-keep" data-testid="timeline-keep-all">
          <span>
            {agentCount} feature{agentCount === 1 ? "" : "s"} by the assistant
          </span>
          <button
            type="button"
            className="link-button"
            onClick={() =>
              run(
                { id: "ir.setAuthor", args: { features: timeline.parts.flatMap((p) => p.features.filter((f) => f.agent).map((f) => f.id)), author: "user" } },
                "ui",
              )
            }
          >
            Keep all
          </button>
        </div>
      )}
      <div className="panel-body">
        {timeline.parts.length === 0 || timeline.featureCount === 0 ? (
          !hasCompile || phase === "compiling" ? (
            <div className="empty">Loading…</div>
          ) : (
            <div className="empty-state" data-testid="timeline-empty">
              <ToolIcon name="sketch" size={28} />
              <strong>No features yet</strong>
              <span>Every sketch and feature lands here, in order. Double-click one to edit it.</span>
              <span className="es-keys">
                Start with <kbd>⇧S</kbd> Create Sketch
              </span>
            </div>
          )
        ) : (
          <ul className="tl-tree" role="tree">
            {timeline.parts.map((part) => (
              <li key={part.id} className="tl-part" role="treeitem" aria-expanded="true">
                <div className="tl-part-head" data-testid="timeline-part">
                  <Icon.Part size={14} />
                  <span>{part.name}</span>
                  <span className="tl-count">{part.features.length}</span>
                </div>
                <ul role="group">
                  {part.features.map((f, i) => (
                    <FeatureRowWithMarker
                      key={f.id}
                      f={f}
                      selected={f.id === selectedId}
                      focused={f.id === focusId}
                      draft={draftKinds.get(`${part.name}/${f.name}`)}
                      upAfter={i === 0 ? undefined : (part.features[i - 2]?.id ?? null)}
                      downAfter={part.features[i + 1]?.id}
                      v1={v1}
                      isMarker={timeline.rollback === f.id}
                      onRollToEnd={() => run({ id: "ir.setRollback", args: { after: null } }, "ui")}
                    />
                  ))}
                  {(review?.changes ?? [])
                    .filter((c) => c.kind === "added" && c.part === part.name)
                    .map((c) => (
                      <li key={c.key} className="tl-proposed" data-testid="timeline-proposed">
                        <span className="kind-badge kind-added">new</span> {c.feature} <span className="muted">· proposed</span>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function FeatureRowWithMarker(props: RowProps & { onRollToEnd: () => void }): ReactElement {
  const { onRollToEnd, ...row } = props;
  return (
    <>
      <FeatureRow {...row} />
      {row.isMarker && (
        <li className="tl-marker" data-testid="timeline-rollback-marker" role="separator">
          <span className="tl-marker-line" />
          <span className="tl-marker-label">Rolled back here</span>
          <button type="button" className="link-button" onClick={onRollToEnd} data-testid="timeline-roll-to-end">
            Roll to end
          </button>
        </li>
      )}
    </>
  );
}

interface ParamRow {
  name: string;
  unit: string;
  value: number | boolean | null;
  error: string | null;
  scope: string;
}

/** The document's parameters (IR v1): values, inline editing (Enter sets), add and delete — all through `ir.*` commands. */
export function ParametersPanel({ docked = false }: { docked?: boolean } = {}): ReactElement {
  const { services, run } = useApp();
  const [openState, setOpen] = useState(false);
  // In its own dock tab the table is always open; under the timeline it folds.
  const open = docked || openState;
  const v1 = useStore(services.doc, (s) => s.format === "ir-v1");
  const params = useStore(services.doc, (s) => (s.report as { params?: unknown } | null)?.params ?? null) as Array<{
    name: string;
    unit: string;
    value?: number | boolean;
    scope: string;
    error?: { message: string };
  }> | null;
  const source = useStore(services.doc, (s) => s.source);
  const [adding, setAdding] = useState<{ name: string; value: string; unit: string } | null>(null);
  const rows: ParamRow[] = (v1 ? (params ?? []) : []).map((p) => ({ name: p.name, unit: p.unit, value: p.value ?? null, error: p.error?.message ?? null, scope: p.scope }));
  const declared = new Map<string, unknown>();
  if (v1) {
    try {
      const d = JSON.parse(source) as { params?: Array<{ name: string; value: unknown }>; parts?: Array<{ params?: Array<{ name: string; value: unknown }> }> };
      for (const p of [...(d.params ?? []), ...(d.parts ?? []).flatMap((x) => x.params ?? [])]) declared.set(p.name, p.value);
    } catch {
      // the model is loading
    }
  }
  return (
    <section className={`panel params${open ? " open" : ""}${docked ? " docked" : ""}`} aria-label="Parameters" data-testid="params-panel">
      {docked ? (
        <header className="panel-header tl-header">
          <span className="panel-meta">{v1 ? (rows.length > 0 ? `${rows.length} parameter${rows.length === 1 ? "" : "s"}` : "Named values") : ""}</span>
        </header>
      ) : (
        <header className="panel-header clickable" onClick={() => setOpen(!open)}>
          <span className={`chev${open ? " open" : ""}`}>
            <Icon.Chevron size={12} />
          </span>
          <Icon.Params size={14} />
          <span className="panel-title">Parameters</span>
          <span className="panel-meta">{v1 ? `${rows.length}` : ""}</span>
        </header>
      )}
      {open && (
        <div className="panel-body params-body">
          {!v1 && <p className="muted">Parameters need an IR v1 model (File ▸ New).</p>}
          {v1 && rows.length === 0 && !adding && (
            <div className="empty-state compact">
              <ToolIcon name="parameters" size={26} />
              <strong>No parameters yet</strong>
              <span>Name a value, like wall = 2 mm, and use it in any field or dimension. Change it here and the part follows.</span>
            </div>
          )}
          {v1 && rows.length > 0 && (
            <table className="params-table">
              <tbody>
                {rows.map((p) => (
                  <ParamLine key={p.name} p={p} declared={declared.get(p.name)} onSet={(value) => run({ id: "ir.setParam", args: { name: p.name, value } }, "ui")} onDelete={() => run({ id: "ir.deleteParam", args: { name: p.name } }, "ui")} />
                ))}
              </tbody>
            </table>
          )}
          {v1 && adding && (
            <form
              className="param-add"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(adding.value);
                const value = adding.value.trim() !== "" && Number.isFinite(n) ? n : adding.value.trim();
                run({ id: "ir.addParam", args: { name: adding.name.trim(), unit: adding.unit as "mm", value } }, "ui");
                setAdding(null);
              }}
            >
              <input aria-label="Parameter name" placeholder="name" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} autoFocus />
              <input aria-label="Parameter value" placeholder="value" value={adding.value} onChange={(e) => setAdding({ ...adding, value: e.target.value })} />
              <select aria-label="Parameter unit" value={adding.unit} onChange={(e) => setAdding({ ...adding, unit: e.target.value })}>
                {["mm", "deg", "ratio", "count", "bool"].map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
              <button type="submit" className="link-button">
                Add
              </button>
            </form>
          )}
          {v1 && !adding && (
            <button type="button" className="link-button" onClick={() => setAdding({ name: "", value: "", unit: "mm" })} data-testid="params-add">
              + Add parameter
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function ParamLine({ p, declared, onSet, onDelete }: { p: ParamRow; declared: unknown; onSet: (value: number | boolean | string) => void; onDelete: () => void }): ReactElement {
  const shown = typeof declared === "string" ? declared : declared === undefined ? String(p.value ?? "") : String(declared);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const evaluated = p.value === null ? "—" : typeof p.value === "number" ? `${Number(p.value.toFixed(4))}${p.unit === "mm" ? " mm" : p.unit === "deg" ? "°" : ""}` : String(p.value);
  return (
    <tr className={p.error ? "param-error" : ""} title={p.error ?? undefined}>
      <td className="param-name mono">{p.name}</td>
      <td>
        <input
          className="param-value mono"
          aria-label={`${p.name} value`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim() !== shown) {
              const n = Number(text);
              onSet(text.trim() === "true" ? true : text.trim() === "false" ? false : text.trim() !== "" && Number.isFinite(n) ? n : text.trim());
            }
            if (e.key === "Escape") setText(shown);
          }}
        />
      </td>
      <td className="param-eval muted">{typeof declared === "string" ? `= ${evaluated}` : p.unit}</td>
      <td>
        <button type="button" className="tl-action param-del" aria-label={`Delete ${p.name}`} title="Delete parameter" onClick={onDelete}>
          <Icon.Close size={11} />
        </button>
      </td>
    </tr>
  );
}
