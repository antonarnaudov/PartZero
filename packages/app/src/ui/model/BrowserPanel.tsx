/**
 * The Browser (FULL-MODELING-PLAN T0 #19): the document as a tree — Origin (planes, axes, point),
 * then per part its Bodies, Sketches and Construction.
 *
 * - **Eye** on every row: bodies (`view.setBodyVisible`), sketches (`view.setSketchVisible`), the
 *   origin (`view.setToggle origin`) and whole folders. Visibility is view state: not undoable,
 *   not in the model.
 * - **Colour** per body (the swatch): Bambu Lab PLA Basic filament colours or any colour, stored
 *   in the document as the appearance of the feature that made the body (`ir.setAppearance`: one
 *   undo step, saved in the `.partzero`, the same op the assistant calls).
 * - **Isolate** shows only that body (`view.isolate`), again to show all.
 * - Click selects (the viewport and the timeline follow), double-click edits a sketch or a
 *   construction feature, right-click opens its menu (Rename, Suppress, Delete… for features).
 */
import { useMemo, useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import type { TimelineFeature } from "../../doc/timeline";
import type { SelectionItem } from "../../selection/types";
import { viewportRuntime } from "../../viewport/runtime";
import { useApp, useStore } from "../context";
import { useProblems, useTimeline } from "../doc-hooks";
import { Icon } from "../icons";
import { useShell } from "../shell/context";
import { ToolIcon } from "../shell/tool-icons";
import { editFeature, requestDelete, selectFeature, setSuppressed, startRename, type ModelActionContext } from "./actions";
import { buildBrowserTree, ORIGIN_ITEMS, type BrowserBody } from "./browser-model";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { featureIcon, typeTitle } from "./feature-types";
import { filamentOf, PLA_BASIC } from "./filaments";
import { ModelIcon } from "./icons";
import "./model.css";
import "./panels.css";

type Run = (id: string, args?: Record<string, unknown>) => void;

function Eye({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      className={`pzb-act pzb-eye${on ? "" : " off"}`}
      aria-pressed={on}
      aria-label={`${on ? "Hide" : "Show"} ${label}`}
      title={on ? "Hide" : "Show"}
      data-testid="browser-eye"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {on ? <ModelIcon.Eye size={14} /> : <ModelIcon.EyeOff size={14} />}
    </button>
  );
}

interface RowProps {
  kind: string;
  name: string;
  depth: number;
  icon: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  selected?: boolean;
  dim?: boolean;
  status?: string;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  title?: string;
}

function Row(p: RowProps): ReactElement {
  return (
    <div
      className={`pzb-row${p.selected ? " selected" : ""}${p.dim ? " dim" : ""}${p.status ? ` st-${p.status}` : ""}`}
      role="treeitem"
      aria-level={p.depth + 1}
      aria-expanded={p.onToggle ? p.open : undefined}
      aria-selected={p.selected ?? false}
      style={{ paddingLeft: 6 + p.depth * 14 }}
      data-testid="browser-row"
      data-kind={p.kind}
      data-name={p.name}
      title={p.title}
      onClick={p.onClick}
      onDoubleClick={p.onDoubleClick}
      onContextMenu={p.onContextMenu}
    >
      <span
        className={`pzb-chev${p.onToggle ? "" : " none"}${p.open ? " open" : ""}`}
        onClick={(e) => {
          if (!p.onToggle) return;
          e.stopPropagation();
          p.onToggle();
        }}
        aria-hidden="true"
      >
        {p.onToggle && <Icon.Chevron size={10} />}
      </span>
      <span className="pzb-icon">{p.icon}</span>
      <span className="pzb-label">{p.label}</span>
      {p.meta !== undefined && <span className="pzb-meta">{p.meta}</span>}
      {p.actions && <span className="pzb-actions">{p.actions}</span>}
    </div>
  );
}

function ColorPopover({ at, current, multi, onPick, onClose }: { at: { x: number; y: number }; current: string | null; multi: string | null; onPick: (hex: string | null) => void; onClose: () => void }): ReactElement {
  const left = Math.max(6, Math.min(at.x, window.innerWidth - 256));
  const top = Math.max(6, Math.min(at.y, window.innerHeight - 250));
  const cur = filamentOf(current);
  return (
    <div className="pz-rename-layer" onMouseDown={onClose}>
      <div className="pzb-colors" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()} data-testid="color-popover" role="dialog" aria-label="Body colour">
        <div className="pzb-colors-head">
          <span>Filament colour</span>
          <span className="muted">{cur ? cur.name : current ? current : "Default"}</span>
        </div>
        <div className="pzb-swatches" role="listbox" aria-label="Bambu Lab PLA Basic colours">
          {PLA_BASIC.map((f) => (
            <button
              key={f.hex}
              type="button"
              role="option"
              aria-selected={current === f.hex}
              className={`pzb-swatch${current === f.hex ? " on" : ""}`}
              style={{ background: f.hex }}
              title={`${f.name} ${f.hex.toUpperCase()}`}
              aria-label={f.name}
              data-color={f.hex}
              onClick={() => onPick(f.hex)}
            />
          ))}
        </div>
        <div className="pzb-colors-foot">
          <button type="button" className="ghost-btn tiny" onClick={() => onPick(null)} data-testid="color-default">
            Default
          </button>
          <label className="ghost-btn tiny pzb-custom">
            Custom…
            <input
              type="color"
              defaultValue={current ?? "#a4adb8"}
              aria-label="Custom colour"
              // The native picker fires `input` while you drag; commit once, on `change`.
              ref={(el) => {
                if (el && !el.dataset["wired"]) {
                  el.dataset["wired"] = "1";
                  el.addEventListener("change", () => onPick(el.value));
                }
              }}
            />
          </label>
          <span className="spacer" />
          <span className="muted small">Bambu PLA Basic</span>
        </div>
        {multi && <div className="pzb-colors-note muted small">Colours every body {multi} makes.</div>}
      </div>
    </div>
  );
}

export function BrowserPanel(): ReactElement {
  const { services } = useApp();
  const { shell } = useShell();
  const ctx: ModelActionContext = useMemo(() => ({ services, shell }), [services, shell]);
  const runtime = viewportRuntime(services);
  const view = useSyncExternalStore(runtime.view.subscribe, runtime.view.getState);
  const sel = useSyncExternalStore(runtime.selection.subscribe, runtime.selection.getState);
  const problems = useProblems();
  const timeline = useTimeline(problems);
  const docName = useStore(services.doc, (s) => s.name);
  const v1 = useStore(services.doc, (s) => s.format === "ir-v1");
  const bodies = useStore(services.doc, (s) => s.bodies);
  const appearance = useStore(services.doc, (s) => s.v1?.host.appearance ?? null);
  const selectedFeature = useStore(services.doc, (s) => s.selection.featureId);
  const ir = useStore(services.doc, (s) => s.model?.ir ?? null);
  const tree = useMemo(() => buildBrowserTree(timeline, bodies.map((b) => b.name)), [timeline, bodies]);
  const [closed, setClosed] = useState<Record<string, boolean>>({ origin: true });
  const [menu, setMenu] = useState<{ items: MenuEntry[]; x: number; y: number } | null>(null);
  const [colors, setColors] = useState<{ body: BrowserBody; x: number; y: number } | null>(null);
  const run: Run = (id, args = {}) => void shell.execute({ id, args }, "ui");
  const jsonOf = (id: string): unknown => (ir as { parts?: Array<{ features?: Array<{ id?: string }> }> } | null)?.parts?.flatMap((p) => p.features ?? []).find((f) => f.id === id);

  const isOpen = (k: string): boolean => !closed[k];
  const toggle = (k: string) => () => setClosed((c) => ({ ...c, [k]: !c[k] }));
  const selectedItem = (it: SelectionItem): boolean => sel.items.some((x) => JSON.stringify(x) === JSON.stringify(it));
  const pick = (item: SelectionItem): void => run("selection.set", { items: [item] });
  const bodyVisible = (name: string): boolean => view.bodies[name]?.visible ?? true;
  const bodyColor = (b: BrowserBody): string | null => {
    if (b.feature && appearance?.[b.feature.id]) return appearance[b.feature.id]!;
    const c = view.bodies[b.name]?.color;
    return c ? `#${c.map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}` : null;
  };
  const setColor = (b: BrowserBody, hex: string | null): void => {
    setColors(null);
    if (v1 && b.feature) run("ir.setAppearance", { feature: b.feature.id, color: hex });
    else run("view.setBodyColor", { body: b.name, color: hex });
  };
  const allBodies = tree.parts.flatMap((p) => p.bodies);
  const anyBodyShown = allBodies.some((b) => bodyVisible(b.name));

  const featureMenu = (f: TimelineFeature, extra: MenuEntry[] = []): MenuEntry[] => [
    { key: "edit", label: f.type === "sketch" ? "Edit Sketch" : "Edit Feature…", run: () => editFeature(ctx, f) },
    ...(v1
      ? ([
          { key: "rename", label: "Rename…", run: () => startRename(ctx, { kind: "feature", id: f.id, name: f.name }, document.querySelector(`[data-testid="browser-row"][data-name="${CSS.escape(f.name)}"] .pzb-label`)) },
          ...extra,
          { key: "sep", separator: true },
          { key: "suppress", label: f.suppressed ? "Unsuppress" : "Suppress", run: () => setSuppressed(ctx, f, true) },
          { key: "delete", label: "Delete…", danger: true, run: () => void requestDelete(ctx, f) },
        ] satisfies MenuEntry[])
      : extra),
  ];

  const bodyMenu = (b: BrowserBody, e: React.MouseEvent): MenuEntry[] => {
    const shown = bodyVisible(b.name);
    const x = e.clientX;
    const y = e.clientY;
    const items: MenuEntry[] = [
      { key: "visible", label: shown ? "Hide" : "Show", run: () => run("view.setBodyVisible", { body: b.name, visible: !shown }) },
      { key: "isolate", label: "Isolate", run: () => run("view.isolate", { bodies: [b.name] }) },
      { key: "showAll", label: "Show All Bodies", run: () => run("view.showAll") },
      { key: "sep", separator: true },
      { key: "color", label: "Colour…", run: () => setColors({ body: b, x, y }) },
    ];
    if (b.feature) {
      const f = b.feature;
      items.push({ key: "feature", label: `Select ${f.name} in the Timeline`, run: () => selectFeature(ctx, f.id) });
    }
    return items;
  };

  const featureRow = (f: TimelineFeature, depth: number, kind: "sketch" | "datum"): ReactElement => {
    const shown = kind === "sketch" ? (view.sketchVisibility[f.name] ?? view.sketches) : true;
    const item: SelectionItem = kind === "sketch" ? { kind: "sketch", feature: f.name } : { kind: "datum", feature: f.id };
    return (
      <Row
        key={f.id}
        kind={kind}
        name={f.name}
        depth={depth}
        icon={<ToolIcon name={featureIcon(f.type, jsonOf(f.id))} size={14} />}
        label={
          <>
            {f.name}
            {f.agent && <span className="pzb-ai">AI</span>}
          </>
        }
        meta={f.status === "error" ? <span className="pzb-err" title={f.issues[0]?.message ?? "Failed"}>failed</span> : f.suppressed ? "suppressed" : f.rolledBack ? "rolled back" : undefined}
        status={f.status}
        dim={f.suppressed || f.rolledBack || (kind === "sketch" && !shown)}
        selected={selectedFeature === f.id || selectedItem(item)}
        title={`${typeTitle(f.type)} ${f.name}${f.summary ? ` · ${f.summary}` : ""}`}
        onClick={() => {
          if (kind === "sketch") pick(item);
          else selectFeature(ctx, f.id);
        }}
        onDoubleClick={() => editFeature(ctx, f)}
        onContextMenu={(e) => {
          e.preventDefault();
          const extra: MenuEntry[] = kind === "sketch" ? [{ key: "visible", label: shown ? "Hide" : "Show", run: () => run("view.setSketchVisible", { sketch: f.name, visible: !shown }) }] : [];
          setMenu({ items: featureMenu(f, extra), x: e.clientX, y: e.clientY });
        }}
        actions={kind === "sketch" ? <Eye on={shown} label={f.name} onClick={() => run("view.setSketchVisible", { sketch: f.name, visible: !shown })} /> : undefined}
      />
    );
  };

  const empty = timeline.featureCount === 0;

  return (
    <section className="panel pzb" aria-label="Browser" data-testid="browser">
      <div className="panel-body pzb-body" role="tree" aria-label="Model browser">
        <Row
          kind="document"
          name={docName}
          depth={0}
          icon={<ModelIcon.Document size={14} />}
          label={<b>{docName}</b>}
          meta={tree.bodyCount > 0 ? `${tree.bodyCount} bod${tree.bodyCount === 1 ? "y" : "ies"}` : undefined}
          open
        />
        <Row
          kind="origin-folder"
          name="Origin"
          depth={1}
          icon={<ModelIcon.Origin size={14} />}
          label="Origin"
          open={isOpen("origin")}
          onToggle={toggle("origin")}
          dim={!view.origin}
          actions={<Eye on={view.origin} label="the origin planes and axes" onClick={() => run("view.setToggle", { toggle: "origin", on: !view.origin })} />}
        />
        {isOpen("origin") &&
          ORIGIN_ITEMS.map((o) => (
            <Row
              key={o.id}
              kind="origin"
              name={o.id}
              depth={2}
              icon={o.kind === "plane" ? <ModelIcon.Plane size={14} /> : o.kind === "axis" ? <ModelIcon.Axis size={14} /> : <ModelIcon.Point size={14} />}
              label={o.label}
              dim={!view.origin}
              selected={selectedItem({ kind: "origin", id: o.id })}
              onClick={() => pick({ kind: "origin", id: o.id })}
            />
          ))}
        {tree.parts.map((part) => {
          const depth = tree.parts.length > 1 ? 2 : 1;
          const pk = `part:${part.id}`;
          const content = (
            <>
              <Row
                kind="bodies"
                name={`${part.name} bodies`}
                depth={depth}
                icon={<ModelIcon.Folder size={14} />}
                label="Bodies"
                meta={part.bodies.length}
                open={isOpen(`${pk}:bodies`)}
                onToggle={toggle(`${pk}:bodies`)}
                actions={
                  part.bodies.length > 0 ? (
                    <Eye
                      on={part.bodies.some((b) => bodyVisible(b.name))}
                      label="all bodies"
                      onClick={() => {
                        const on = !part.bodies.some((b) => bodyVisible(b.name));
                        for (const b of part.bodies) run("view.setBodyVisible", { body: b.name, visible: on });
                      }}
                    />
                  ) : undefined
                }
              />
              {isOpen(`${pk}:bodies`) &&
                (part.bodies.length === 0 ? (
                  <div className="pzb-empty" style={{ paddingLeft: 34 + depth * 14 }}>
                    No bodies yet
                  </div>
                ) : (
                  part.bodies.map((b) => {
                    const shown = bodyVisible(b.name);
                    const color = bodyColor(b);
                    const fil = filamentOf(color);
                    return (
                      <Row
                        key={b.name}
                        kind="body"
                        name={b.name}
                        depth={depth + 1}
                        icon={
                          <span className="pzb-body-icon" style={color ? { color } : undefined}>
                            <ModelIcon.Body size={14} />
                          </span>
                        }
                        label={b.label}
                        dim={!shown}
                        selected={selectedItem({ kind: "body", body: b.name })}
                        title={`Body ${b.label}${b.feature ? ` · made by ${b.feature.name}` : ""}${fil ? ` · ${fil.name}` : ""}`}
                        onClick={() => pick({ kind: "body", body: b.name })}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setMenu({ items: bodyMenu(b, e), x: e.clientX, y: e.clientY });
                        }}
                        actions={
                          <>
                            <button
                              type="button"
                              className={`pzb-act pzb-swatch-btn${color ? "" : " default"}`}
                              style={color ? { background: color } : undefined}
                              title={fil ? `${fil.name}: change colour` : color ? `${color}: change colour` : "Colour"}
                              aria-label={`Colour of ${b.label}`}
                              data-testid="browser-swatch"
                              data-color={color ?? ""}
                              onClick={(e) => {
                                e.stopPropagation();
                                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                setColors({ body: b, x: r.left, y: r.bottom + 4 });
                              }}
                            />
                            <button
                              type="button"
                              className="pzb-act"
                              title="Isolate (show only this body)"
                              aria-label={`Isolate ${b.label}`}
                              data-testid="browser-isolate"
                              onClick={(e) => {
                                e.stopPropagation();
                                const only = allBodies.every((x) => (x.name === b.name) === bodyVisible(x.name));
                                run(only ? "view.showAll" : "view.isolate", only ? {} : { bodies: [b.name] });
                              }}
                            >
                              <ModelIcon.Isolate size={14} />
                            </button>
                            <Eye on={shown} label={b.label} onClick={() => run("view.setBodyVisible", { body: b.name, visible: !shown })} />
                          </>
                        }
                      />
                    );
                  })
                ))}
              <Row
                kind="sketches"
                name={`${part.name} sketches`}
                depth={depth}
                icon={<ModelIcon.Folder size={14} />}
                label="Sketches"
                meta={part.sketches.length}
                open={isOpen(`${pk}:sketches`)}
                onToggle={toggle(`${pk}:sketches`)}
                actions={part.sketches.length > 0 ? <Eye on={view.sketches} label="all sketches" onClick={() => run("view.setToggle", { toggle: "sketches", on: !view.sketches })} /> : undefined}
              />
              {isOpen(`${pk}:sketches`) && part.sketches.map((f) => featureRow(f, depth + 1, "sketch"))}
              {part.construction.length > 0 && (
                <Row
                  kind="construction"
                  name={`${part.name} construction`}
                  depth={depth}
                  icon={<ModelIcon.Construction size={14} />}
                  label="Construction"
                  meta={part.construction.length}
                  open={isOpen(`${pk}:construction`)}
                  onToggle={toggle(`${pk}:construction`)}
                />
              )}
              {isOpen(`${pk}:construction`) && part.construction.map((f) => featureRow(f, depth + 1, "datum"))}
            </>
          );
          if (tree.parts.length === 1) return <div key={part.id}>{content}</div>;
          return (
            <div key={part.id}>
              <Row kind="part" name={part.name} depth={1} icon={<Icon.Part size={14} />} label={part.name} meta={`${part.bodies.length} bod${part.bodies.length === 1 ? "y" : "ies"}`} open={isOpen(pk)} onToggle={toggle(pk)} />
              {isOpen(pk) && content}
            </div>
          );
        })}
        {empty && <p className="pzb-hint muted small">Start with a sketch on an origin plane (Sketch in the toolbar). Bodies and sketches you make appear here.</p>}
        {!empty && !anyBodyShown && allBodies.length > 0 && (
          <button type="button" className="link-button pzb-showall" onClick={() => run("view.showAll")}>
            Every body is hidden · Show all
          </button>
        )}
      </div>
      {menu && <ContextMenu testId="browser-menu" at={{ x: menu.x, y: menu.y }} items={menu.items} onClose={() => setMenu(null)} />}
      {colors && (
        <ColorPopover
          at={{ x: colors.x, y: colors.y }}
          current={bodyColor(colors.body)}
          multi={colors.body.feature && allBodies.filter((b) => b.feature?.id === colors.body.feature?.id).length > 1 ? colors.body.feature.name : null}
          onPick={(hex) => setColor(colors.body, hex)}
          onClose={() => setColors(null)}
        />
      )}
    </section>
  );
}
