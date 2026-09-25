/**
 * The Browser (FULL-MODELING-PLAN T0 #19; Fusion's browser, Shapr3D's items): what the model holds,
 * by kind rather than by history, with show/hide and pick.
 *
 * - **Origin:** the XY, XZ and YZ planes, the X, Y and Z axes and the origin point. A click selects
 *   one (a sketch plane for Create Sketch, a reference for a tool); the eye shows or hides them.
 * - **Bodies:** every body of the evaluated model with its colour. Click selects, double-click zooms
 *   to it, the eye shows or hides it; "Show all" when some are hidden.
 * - **Sketches and construction:** the sketches and datum planes and axes; click selects, a
 *   double-click opens a sketch in sketch mode (as the timeline does).
 *
 * Every action is a command (`selection.set`, `view.setBodyVisible`, `view.setToggle`,
 * `view.showAll`, `view.zoomToSelection`), the same the agent and MCP call.
 */
import { useState, type ReactElement, type ReactNode } from "react";
import type { IrDocument } from "@aicad/ir-types";
import { featureNameOfBody } from "../../doc/provenance";
import type { SelectionItem } from "../../selection/types";
import { editSketchFeature } from "../../sketch/integration";
import { viewportRuntime } from "../../viewport/runtime";
import { useApp, useStore } from "../context";
import { Icon } from "../icons";
import { useShell } from "./context";
import { ToolIcon } from "./tool-icons";

type Rgb = readonly [number, number, number];

const DEFAULT_BODY: Rgb = [0.64, 0.68, 0.73];

function hex(c: Rgb): string {
  return `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function sameItem(a: SelectionItem, b: SelectionItem): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "body":
      return a.body === (b as typeof a).body;
    case "sketch":
    case "datum":
      return a.feature === (b as typeof a).feature;
    case "origin":
      return a.id === (b as typeof a).id;
    default:
      return false;
  }
}

function Section({ title, count, icon, children, extra, testId }: { title: string; count?: number; icon: string; children: ReactNode; extra?: ReactNode; testId: string }): ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <li className={`br-section${open ? " open" : ""}`} data-testid={testId}>
      <div className="br-section-head">
        <button type="button" className="br-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={`chev${open ? " open" : ""}`}>
            <Icon.Chevron size={10} />
          </span>
          <ToolIcon name={icon} size={15} />
          <span className="br-section-title">{title}</span>
          {count !== undefined && <span className="br-count">{count}</span>}
        </button>
        {extra}
      </div>
      {open && <ul className="br-items">{children}</ul>}
    </li>
  );
}

function Eye({ on, label, onClick, testId }: { on: boolean; label: string; onClick: () => void; testId?: string }): ReactElement {
  return (
    <button
      type="button"
      className={`br-eye${on ? "" : " off"}`}
      aria-label={`${on ? "Hide" : "Show"} ${label}`}
      aria-pressed={on}
      title={`${on ? "Hide" : "Show"} ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      data-testid={testId}
    >
      {on ? <Icon.Eye size={13} /> : <Icon.EyeOff size={13} />}
    </button>
  );
}

const ORIGIN_ROWS: ReadonlyArray<{ id: "XY" | "XZ" | "YZ" | "X" | "Y" | "Z" | "O"; label: string; icon: string }> = [
  { id: "O", label: "Origin", icon: "origin" },
  { id: "XY", label: "XY plane", icon: "plane" },
  { id: "XZ", label: "XZ plane", icon: "plane" },
  { id: "YZ", label: "YZ plane", icon: "plane" },
  { id: "X", label: "X axis", icon: "axis" },
  { id: "Y", label: "Y axis", icon: "axis" },
  { id: "Z", label: "Z axis", icon: "axis" },
];

export function BrowserPanel(): ReactElement {
  const { services, run } = useApp();
  const { shell } = useShell();
  const rt = viewportRuntime(services);
  const view = useStore(rt.view, (s) => s);
  const selected = useStore(rt.selection, (s) => s.items);
  const bodies = useStore(services.doc, (s) => s.bodies);
  const ir = useStore(services.doc, (s) => s.model?.ir ?? null) as IrDocument | null;
  const name = useStore(services.doc, (s) => s.name);

  const isSel = (it: SelectionItem): boolean => selected.some((s) => sameItem(s, it));
  const select = (it: SelectionItem, additive: boolean): void => {
    const next = additive ? (isSel(it) ? selected.filter((s) => !sameItem(s, it)) : [...selected, it]) : [it];
    void shell.execute({ id: "selection.set", args: { items: next } }, "ui");
  };
  const features = (ir?.parts ?? []).flatMap((p) => p.features.map((f) => ({ part: p.name, id: f.id, name: f.name, type: f.type as string, plane: (f as { plane?: unknown }).plane })));
  const sketches = features.filter((f) => f.type === "sketch");
  const datums = features.filter((f) => f.type === "datum_plane" || f.type === "datum_axis");
  const parts = new Set(bodies.map((b) => b.name.split("/")[0]));
  const hidden = bodies.filter((b) => view.bodies[b.name]?.visible === false).length;

  return (
    <section className="panel browser" aria-label="Browser" data-testid="browser-panel">
      <div className="panel-body">
        <div className="br-doc" title={name}>
          <ToolIcon name="part" size={15} />
          <span className="br-doc-name">{name}</span>
        </div>
        <ul className="br-tree" role="tree">
          <Section
            title="Origin"
            icon="origin"
            testId="browser-origin"
            extra={<Eye on={view.origin} label="the origin planes and axes" onClick={() => run({ id: "view.setToggle", args: { toggle: "origin" } })} testId="browser-origin-eye" />}
          >
            {ORIGIN_ROWS.map((o) => {
              const it: SelectionItem = { kind: "origin", id: o.id };
              return (
                <li key={o.id} className={`br-item${isSel(it) ? " selected" : ""}${view.origin ? "" : " hidden"}`} role="treeitem" aria-selected={isSel(it)} onClick={(e) => select(it, e.shiftKey || e.metaKey)} data-testid={`browser-origin-${o.id}`}>
                  <ToolIcon name={o.icon} size={14} />
                  <span className="br-label">{o.label}</span>
                </li>
              );
            })}
          </Section>
          <Section
            title="Bodies"
            count={bodies.length}
            icon="body"
            testId="browser-bodies"
            extra={
              hidden > 0 ? (
                <button type="button" className="br-link" onClick={() => run({ id: "view.showAll" })} data-testid="browser-show-all">
                  Show all
                </button>
              ) : undefined
            }
          >
            {bodies.length === 0 && <li className="br-empty">No bodies yet. Extrude a sketch to make one.</li>}
            {bodies.map((b) => {
              const d = view.bodies[b.name];
              const visible = d?.visible !== false;
              const color = (d?.color ?? b.color ?? DEFAULT_BODY) as Rgb;
              const it: SelectionItem = { kind: "body", body: b.name };
              const label = featureNameOfBody(b.name);
              return (
                <li
                  key={b.name}
                  className={`br-item${isSel(it) ? " selected" : ""}${visible ? "" : " hidden"}`}
                  role="treeitem"
                  aria-selected={isSel(it)}
                  title={b.name}
                  onClick={(e) => select(it, e.shiftKey || e.metaKey)}
                  onDoubleClick={() => {
                    void shell.execute({ id: "selection.set", args: { items: [it] } }, "ui").then(() => run({ id: "view.zoomToSelection" }));
                  }}
                  data-testid="browser-body"
                  data-body={b.name}
                >
                  <span className="br-swatch" style={{ background: hex(color) }} />
                  <span className="br-label">{label}</span>
                  {parts.size > 1 && <span className="br-meta">{b.name.split("/")[0]}</span>}
                  <Eye on={visible} label={label} onClick={() => run({ id: "view.setBodyVisible", args: { body: b.name, visible: !visible } })} />
                </li>
              );
            })}
          </Section>
          <Section
            title="Sketches"
            count={sketches.length}
            icon="sketch"
            testId="browser-sketches"
            extra={<Eye on={view.sketches} label="every sketch" onClick={() => run({ id: "view.setToggle", args: { toggle: "sketches" } })} />}
          >
            {sketches.length === 0 && <li className="br-empty">No sketches yet. Create Sketch starts one.</li>}
            {sketches.map((s) => {
              const it: SelectionItem = { kind: "sketch", feature: s.name };
              return (
                <li
                  key={s.id}
                  className={`br-item${isSel(it) ? " selected" : ""}`}
                  role="treeitem"
                  aria-selected={isSel(it)}
                  onClick={(e) => select(it, e.shiftKey || e.metaKey)}
                  onDoubleClick={() => {
                    if (!editSketchFeature(s.id)) void shell.execute({ id: "feature.edit", args: { feature: s.id } }, "ui");
                  }}
                  data-testid="browser-sketch"
                  data-feature={s.name}
                >
                  <ToolIcon name="sketch" size={14} />
                  <span className="br-label">{s.name}</span>
                  <span className="br-meta">{typeof s.plane === "string" ? s.plane : parts.size > 1 ? s.part : ""}</span>
                </li>
              );
            })}
          </Section>
          {datums.length > 0 && (
            <Section title="Construction" count={datums.length} icon="plane" testId="browser-construction">
              {datums.map((d) => {
                const it: SelectionItem = { kind: "datum", feature: d.name };
                return (
                  <li key={d.id} className={`br-item${isSel(it) ? " selected" : ""}`} role="treeitem" aria-selected={isSel(it)} onClick={(e) => select(it, e.shiftKey || e.metaKey)} data-testid="browser-datum">
                    <ToolIcon name={d.type === "datum_axis" ? "axis" : "plane"} size={14} />
                    <span className="br-label">{d.name}</span>
                  </li>
                );
              })}
            </Section>
          )}
        </ul>
      </div>
    </section>
  );
}
