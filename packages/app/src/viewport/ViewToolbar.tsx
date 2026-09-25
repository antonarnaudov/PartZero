/**
 * The viewport's floating toolbars: views, fit, zoom to selection, projection, display mode,
 * grid/origin, section, measure and the bodies list (top left); the selection filter and count
 * (bottom centre).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { featureNameOfBody } from "../doc/provenance";
import type { SelectionKind } from "../selection/types";
import { BODY_SWATCHES, DISPLAY_MODE_LABELS, DISPLAY_MODES, hexToRgb, modeAvailable, rgbToHex } from "./display";
import type { ViewportRuntime } from "./runtime";
import type { StandardView } from "./view-camera";

type Run = (cmd: { id: string; args?: Record<string, unknown> }) => void;

const VIEWS: Array<{ view: StandardView; label: string; title: string }> = [
  { view: "iso", label: "Iso", title: "Isometric (Shift+7)" },
  { view: "top", label: "Top", title: "Top (Shift+5)" },
  { view: "front", label: "Front", title: "Front (Shift+1)" },
  { view: "right", label: "Right", title: "Right (Shift+4)" },
];

const SHOW_ITEMS: Array<{ toggle: "grid" | "origin" | "sketches" | "viewCube" | "axes"; label: string; title: string }> = [
  { toggle: "grid", label: "Grid", title: "Ground grid" },
  { toggle: "origin", label: "Origin", title: "Origin planes, axes and point (selectable)" },
  { toggle: "sketches", label: "Sketches", title: "Every sketch (the selected one is always shown)" },
  { toggle: "viewCube", label: "View cube", title: "The view cube" },
  { toggle: "axes", label: "Axes gizmo", title: "The axes in the corner" },
];

export interface ViewToolbarProps {
  runtime: ViewportRuntime;
  run: Run;
  measureOpen: boolean;
}

export function ViewToolbar({ runtime, run, measureOpen }: ViewToolbarProps): ReactElement {
  const view = useSyncExternalStore(runtime.view.subscribe, runtime.view.getState);
  const [menu, setMenu] = useState<null | "section" | "bodies" | "show">(null);
  const native = runtime.adapter?.capabilities().nativeModes ?? DISPLAY_MODES;
  const toggleMenu = (m: "section" | "bodies" | "show"): void => setMenu((cur) => (cur === m ? null : m));
  const barRef = useRef<HTMLDivElement>(null);
  // A menu closes on a press anywhere outside the toolbar, or on Escape.
  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent): void => {
      if (!barRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [menu]);
  return (
    <div ref={barRef} className="vp-toolbar" role="toolbar" aria-label="View">
      {VIEWS.map((v) => (
        <button key={v.view} type="button" className={`vp-btn${view.view === v.view ? " active" : ""}`} title={v.title} data-view={v.view} onClick={() => run({ id: "view.setView", args: { view: v.view } })}>
          {v.label}
        </button>
      ))}
      <span className="vp-sep" />
      <button type="button" className="vp-btn icon" title="Zoom to fit (F)" aria-label="Zoom to fit" data-testid="vp-fit" onClick={() => run({ id: "view.fit" })}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      <button type="button" className="vp-btn icon" title="Zoom to selection (Shift+Z)" aria-label="Zoom to selection" data-testid="vp-zoom-selection" onClick={() => run({ id: "view.zoomToSelection" })}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="m10.2 10.2 3.6 3.6M5 7h4M7 5v4" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      <button
        type="button"
        className="vp-btn"
        title="Toggle perspective / orthographic (P)"
        data-testid="vp-projection"
        onClick={() => run({ id: "view.setProjection", args: { projection: view.projection === "perspective" ? "orthographic" : "perspective" } })}
      >
        {view.projection === "perspective" ? "Persp" : "Ortho"}
      </button>
      <span className="vp-sep" />
      <select
        className="vp-select"
        aria-label="Display mode"
        data-testid="display-mode"
        value={view.display}
        onChange={(e) => run({ id: "view.setDisplayMode", args: { mode: e.target.value } })}
      >
        {DISPLAY_MODES.map((m) => (
          <option key={m} value={m} disabled={!modeAvailable(m, native)}>
            {DISPLAY_MODE_LABELS[m]}
            {modeAvailable(m, native) ? "" : " (renderer update needed)"}
          </option>
        ))}
      </select>
      <span className="vp-menu-anchor">
        <button type="button" className={`vp-btn${menu === "show" ? " on" : ""}`} title="Show or hide the grid, origin, sketches, view cube and axes" aria-expanded={menu === "show"} data-testid="show-menu" onClick={() => toggleMenu("show")}>
          Show ▾
        </button>
        {menu === "show" && (
          <div className="vp-menu" role="menu">
            {SHOW_ITEMS.map((t) => (
              <button
                key={t.toggle}
                type="button"
                role="menuitemcheckbox"
                aria-checked={view[t.toggle]}
                className={`vp-menu-item check${view[t.toggle] ? " checked" : ""}`}
                data-testid={`toggle-${t.toggle.toLowerCase()}`}
                title={t.title}
                onClick={() => run({ id: "view.setToggle", args: { toggle: t.toggle } })}
              >
                <span className="vp-check" aria-hidden="true">
                  {view[t.toggle] ? "✓" : ""}
                </span>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </span>
      <span className="vp-menu-anchor">
        <button type="button" className={`vp-btn${view.section ? " on" : ""}`} title="Section view" aria-expanded={menu === "section"} data-testid="section-menu" onClick={() => toggleMenu("section")}>
          Section
        </button>
        {menu === "section" && (
          <div className="vp-menu" role="menu">
            {(["XY", "XZ", "YZ"] as const).map((b) => (
              <button key={b} type="button" role="menuitem" className="vp-menu-item" data-section={b} onClick={() => (setMenu(null), run({ id: "view.section", args: { base: b } }))}>
                {b} plane
              </button>
            ))}
            <button type="button" role="menuitem" className="vp-menu-item" data-section="face" onClick={() => (setMenu(null), run({ id: "view.section", args: { base: "face" } }))}>
              From selected face
            </button>
            {view.section && (
              <button type="button" role="menuitem" className="vp-menu-item" data-section="off" onClick={() => (setMenu(null), run({ id: "view.clearSection" }))}>
                Remove section
              </button>
            )}
          </div>
        )}
      </span>
      <button type="button" className={`vp-btn${measureOpen ? " on" : ""}`} title="Measure (I)" aria-pressed={measureOpen} data-testid="toggle-measure" onClick={() => run({ id: "measure.toggle" })}>
        Measure
      </button>
      <span className="vp-menu-anchor">
        <button type="button" className={`vp-btn${menu === "bodies" ? " on" : ""}`} title="Bodies: show, hide, colour" aria-expanded={menu === "bodies"} data-testid="bodies-menu" onClick={() => toggleMenu("bodies")}>
          Bodies
        </button>
        {menu === "bodies" && <BodiesMenu runtime={runtime} run={run} />}
      </span>
    </div>
  );
}

function BodiesMenu({ runtime, run }: { runtime: ViewportRuntime; run: Run }): ReactElement {
  const view = useSyncExternalStore(runtime.view.subscribe, runtime.view.getState);
  const names = [...runtime.topo.bodies.keys()];
  return (
    <div className="vp-menu vp-bodies" role="menu" data-testid="bodies-list">
      {names.length === 0 && <div className="vp-menu-note">No bodies</div>}
      {names.map((n) => {
        const b = view.bodies[n] ?? { visible: true, color: null };
        return (
          <div key={n} className="vp-body-row" data-body={n}>
            <button
              type="button"
              className={`vp-eye${b.visible ? "" : " off"}`}
              title={b.visible ? "Hide" : "Show"}
              aria-label={`${b.visible ? "Hide" : "Show"} ${n}`}
              aria-pressed={b.visible}
              data-testid="body-visibility"
              onClick={() => run({ id: "view.setBodyVisible", args: { body: n, visible: !b.visible } })}
            >
              {b.visible ? "◉" : "○"}
            </button>
            <span className="vp-body-name mono" title={n}>
              {featureNameOfBody(n)}
            </span>
            <span className="vp-swatches">
              {BODY_SWATCHES.map((s) => {
                const on = s.hex ? b.color !== null && rgbToHex(b.color) === rgbToHex(hexToRgb(s.hex)!) : b.color === null;
                return (
                  <button
                    key={s.name}
                    type="button"
                    className={`vp-swatch${on ? " on" : ""}${s.hex ? "" : " default"}`}
                    style={s.hex ? { background: s.hex } : undefined}
                    title={s.name}
                    aria-label={`${s.name} colour for ${n}`}
                    data-swatch={s.name}
                    onClick={() => run({ id: "view.setBodyColor", args: { body: n, color: s.hex || null } })}
                  />
                );
              })}
            </span>
          </div>
        );
      })}
      {names.length > 0 && (
        <button type="button" className="vp-menu-item" onClick={() => run({ id: "view.showAll" })}>
          Show all (Shift+V)
        </button>
      )}
    </div>
  );
}

const FILTERS: Array<{ kind: SelectionKind; label: string; key: string }> = [
  { kind: "vertex", label: "Vertex", key: "1" },
  { kind: "edge", label: "Edge", key: "2" },
  { kind: "face", label: "Face", key: "3" },
  { kind: "body", label: "Body", key: "4" },
  { kind: "sketch", label: "Sketch", key: "5" },
];

export function SelectionBar({ runtime, run }: { runtime: ViewportRuntime; run: Run }): ReactElement {
  const sel = useSyncExternalStore(runtime.selection.subscribe, runtime.selection.getState);
  const n = sel.items.length;
  return (
    <div className="vp-selbar" role="toolbar" aria-label="Selection filter" data-testid="selection-bar">
      <span className="vp-selbar-label">Select</span>
      {FILTERS.map((f) => (
        <button
          key={f.kind}
          type="button"
          className={`vp-filter${sel.filter[f.kind] ? " on" : ""}`}
          aria-pressed={sel.filter[f.kind]}
          title={`${f.label}s (${f.key} = only ${f.label.toLowerCase()}s, 0 = everything)`}
          data-filter={f.kind}
          onClick={() => run({ id: "selection.setFilter", args: { [f.kind]: !sel.filter[f.kind] } })}
        >
          {f.label}
        </button>
      ))}
      <span className="vp-sep" />
      <span className="vp-selcount" data-testid="selection-count">
        {n === 0 ? "Nothing selected" : `${n} selected`}
      </span>
      {n > 0 && (
        <button type="button" className="vp-btn" onClick={() => run({ id: "selection.clear" })} title="Clear selection (Esc)">
          Clear
        </button>
      )}
    </div>
  );
}
