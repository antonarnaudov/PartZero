/**
 * The timeline (FULL-MODELING-PLAN T0 #13; Fusion's bottom timeline): the history of the part as a
 * strip of feature icons under the viewport.
 *
 * - **Chips** in timeline order, per part: the type's icon, error/warning marks, the assistant's
 *   features tagged `AI` (ADR 0015), suppressed features struck through, features after the
 *   rollback marker faded. Hover shows the feature's card (summary, problems, hints).
 * - **Click** selects, **double-click** edits (a sketch opens in sketch mode, any other feature in
 *   its property panel), **right-click** opens the feature menu (Edit, Rename, Suppress, Roll Back
 *   Here, Move Earlier / Later, Keep, Delete).
 * - **Drag a chip** to reorder: while dragging, the drop line is green where the feature may go
 *   (after everything it uses, before everything that uses it: `feature-order.ts`) and red with
 *   the reason where it may not; the engine's `moveFeature` decides on drop.
 * - **The rollback marker** is a handle between chips: drag it (or use ⏮ ◀ ▶ ⏭) to roll the
 *   model back; features after it are not built, and new features go at the marker.
 * - **Keys** (with the strip focused): ←/→ select, Enter edits, F2 renames, Delete
 *   deletes (a dialog lists what is built on it).
 *
 * Every change is a command of the one command layer (`ir.moveFeature`, `ir.setRollback`,
 * `ir.setSuppressed`, `ir.renameFeature`, `ir.deleteFeature`, `ir.setAuthor`, `feature.edit`):
 * one undo step each, and the same commands the assistant and MCP call.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { TimelineFeature, TimelinePart } from "../../doc/timeline";
import { moveSlots, slotForGap, type MoveSlot, type OrderFeature } from "../../doc/v1/feature-order";
import { useApp, useStore } from "../context";
import { useProblems, useTimeline } from "../doc-hooks";
import { sketchMode } from "../../sketch/instance";
import { useShell } from "../shell/context";
import { ToolIcon } from "../shell/tool-icons";
import { editFeature, keepFeatures, moveFeature, requestDelete, rollTo, selectFeature, setSuppressed, startRename, type ModelActionContext } from "./actions";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { featureIcon, typeTitle } from "./feature-types";
import { ModelIcon } from "./icons";
import "./model.css";

const STATUS_TEXT: Record<TimelineFeature["status"], string> = {
  ok: "Built",
  warning: "Built, with a warning",
  error: "Failed",
  suppressed: "Suppressed",
  pending: "Not evaluated yet",
  "rolled-back": "Rolled back: not built",
};

type Json = Record<string, unknown>;

/** A drag of a chip (reorder) in progress. */
interface ChipDrag {
  feature: TimelineFeature;
  part: TimelinePart;
  index: number;
  slots: MoveSlot[];
  x: number;
  y: number;
  gap: number;
  active: boolean;
  startX: number;
  startY: number;
}

function featureJson(ir: unknown): Map<string, Json> {
  const m = new Map<string, Json>();
  for (const p of (ir as { parts?: Array<{ features?: Json[] }> } | null | undefined)?.parts ?? []) {
    for (const f of p.features ?? []) if (typeof f["id"] === "string") m.set(f["id"], f);
  }
  return m;
}

/** While dragging near either end of the strip, scroll it (long histories). */
function edgeScroll(track: HTMLElement | null, x: number): void {
  if (!track) return;
  const r = track.getBoundingClientRect();
  const zone = 36;
  if (x < r.left + zone) track.scrollLeft -= Math.ceil((r.left + zone - x) / 3);
  else if (x > r.right - zone) track.scrollLeft += Math.ceil((x - (r.right - zone)) / 3);
}

/** The gap (0…n) under client x among the chips of `part` (by chip centres). */
function gapAt(track: HTMLElement | null, partId: string | null, x: number): number {
  if (!track) return 0;
  const sel = partId === null ? '[data-testid="timeline-feature"]' : `[data-testid="timeline-feature"][data-part="${CSS.escape(partId)}"]`;
  const chips = [...track.querySelectorAll<HTMLElement>(sel)];
  let g = 0;
  for (const c of chips) {
    const r = c.getBoundingClientRect();
    if (x > r.left + r.width / 2) g++;
  }
  return g;
}

function HoverCard({ f, rect, json }: { f: TimelineFeature; rect: DOMRect; json: Json | undefined }): ReactElement {
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - 150, window.innerWidth - 308));
  const bottom = window.innerHeight - rect.top + 8;
  return (
    <div className="ptl-card" role="tooltip" style={{ left, bottom }} data-testid="timeline-card">
      <div className="ptl-card-head">
        <span className={`ptl-card-icon type-${f.type}`}>
          <ToolIcon name={featureIcon(f.type, json)} size={16} />
        </span>
        <span className="ptl-card-title">
          <b>{f.name}</b>
          <span className="muted">{typeTitle(f.type)}</span>
        </span>
        {f.agent && <span className="ptl-ai-tag">AI</span>}
      </div>
      {f.summary && <div className="ptl-card-summary">{f.summary}</div>}
      <div className={`ptl-card-status st-${f.status}`}>{STATUS_TEXT[f.status]}</div>
      {f.issues.slice(0, 3).map((p) => (
        <div key={p.key} className={`ptl-card-issue sev-${p.severity}`}>
          <code>{p.code}</code>
          <div>{p.message}</div>
          {p.hint && <div className="muted">{p.hint}</div>}
        </div>
      ))}
      {f.agent && <div className="ptl-card-note">Made by the assistant. It stays marked until you edit it or choose Keep.</div>}
      <div className="ptl-card-keys muted">Double-click to edit · drag to reorder · right-click for more</div>
    </div>
  );
}

export function TimelineBar(): ReactElement {
  const { services } = useApp();
  const { shell } = useShell();
  const ctx: ModelActionContext = useMemo(() => ({ services, shell }), [services, shell]);
  const problems = useProblems();
  const timeline = useTimeline(problems);
  const selectedId = useStore(services.doc, (s) => s.selection.featureId);
  const v1 = useStore(services.doc, (s) => s.format === "ir-v1");
  const ir = useStore(services.doc, (s) => s.model?.ir ?? null);
  const hasCompile = useStore(services.doc, (s) => s.compile !== null);
  const phase = useStore(services.doc, (s) => s.phase);
  const review = useStore(services.agent, (s) => (s.review && s.review.status === "ready" && s.review.resolution === null ? s.review : null));
  const draftKinds = useMemo(() => new Map((review?.changes ?? []).map((c) => [`${c.part}/${c.feature}`, c.kind])), [review]);
  const jsonById = useMemo(() => featureJson(ir), [ir]);
  const track = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ f: TimelineFeature; part: TimelinePart; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<{ f: TimelineFeature; rect: DOMRect } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [drag, setDrag] = useState<ChipDrag | null>(null);
  const dragRef = useRef<ChipDrag | null>(null);
  const suppressClick = useRef(false);
  const [markerGap, setMarkerGap] = useState<number | null>(null);
  // While a sketch is open the history waits (Finish or Cancel first), as in Fusion.
  const sketching = useStore(sketchMode, (s) => s.phase !== "off");

  const flat = useMemo(() => timeline.parts.flatMap((p) => p.features.map((f) => ({ f, part: p }))), [timeline]);
  const multiPart = timeline.parts.length > 1;
  const errors = flat.filter((x) => x.f.status === "error").length;
  const warnings = flat.filter((x) => x.f.status === "warning").length;
  const agentIds = flat.filter((x) => x.f.agent).map((x) => x.f.id);

  // ─── The rollback marker ────────────────────────────────────────────────────────────────
  /** The marker as a flat gap: after the marker feature, or after the last feature. */
  const markerFlat = useMemo(() => {
    if (timeline.rollback === null) return flat.length;
    const i = flat.findIndex((x) => x.f.id === timeline.rollback);
    return i < 0 ? flat.length : i + 1;
  }, [flat, timeline.rollback]);
  const shownMarker = markerGap ?? markerFlat;

  /** The `setRollback.after` for a flat gap: the feature before it, or null at the end of its part. */
  const afterForGap = useCallback(
    (gap: number): string | null => {
      const g = Math.max(1, Math.min(flat.length, gap));
      const x = flat[g - 1];
      if (!x) return null;
      const last = x.part.features[x.part.features.length - 1];
      return last && last.id === x.f.id ? null : x.f.id;
    },
    [flat],
  );

  const rollToGap = (gap: number): void => {
    if (!v1 || flat.length === 0) return;
    const after = afterForGap(gap);
    if (after === timeline.rollback) return;
    void rollTo(ctx, after);
  };

  const startMarkerDrag = (e: React.PointerEvent): void => {
    if (!v1 || e.button !== 0 || flat.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    // The marker moves between chips while it is dragged (React re-parents it), so the drag
    // listens on the window, not on the element.
    setMarkerGap(markerFlat);
    const done = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
    };
    const move = (ev: PointerEvent): void => {
      edgeScroll(track.current, ev.clientX);
      setMarkerGap(Math.max(1, gapAt(track.current, null, ev.clientX)));
    };
    const up = (ev: PointerEvent): void => {
      done();
      const g = Math.max(1, gapAt(track.current, null, ev.clientX));
      setMarkerGap(null);
      rollToGap(g);
    };
    const cancel = (): void => {
      done();
      setMarkerGap(null);
    };
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  };

  // ─── Reorder by drag ───────────────────────────────────────────────────────────────────
  const orderOf = useCallback((part: TimelinePart): OrderFeature[] => part.features.map((f) => ({ id: f.id, name: f.name, json: jsonById.get(f.id) ?? {} })), [jsonById]);

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      const active = d.active || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 4;
      if (active) edgeScroll(track.current, e.clientX);
      const next = { ...d, x: e.clientX, y: e.clientY, active, gap: gapAt(track.current, d.part.id, e.clientX) };
      dragRef.current = next;
      setDrag(next);
    };
    const up = (): void => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d || !d.active) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      const slot = slotForGap(d.slots, d.index, d.gap);
      if (!slot || slot.current) return;
      if (!slot.valid) {
        services.ui.toast("info", `${d.feature.name} can't go there: ${slot.reason ?? "a feature it uses would come after it"}`);
        return;
      }
      void moveFeature(ctx, d.feature.id, slot.after);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || !dragRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key, true);
    };
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const startChipDrag = (e: React.PointerEvent, f: TimelineFeature, part: TimelinePart, index: number): void => {
    if (e.button !== 0 || !v1) return;
    const d: ChipDrag = { feature: f, part, index, slots: moveSlots(orderOf(part), f.id), x: e.clientX, y: e.clientY, gap: index, active: false, startX: e.clientX, startY: e.clientY };
    dragRef.current = d;
    setDrag(d);
  };

  const activeDrag = drag?.active ? drag : null;
  const dropSlot = activeDrag ? slotForGap(activeDrag.slots, activeDrag.index, activeDrag.gap) : null;

  // ─── Menu ──────────────────────────────────────────────────────────────────────────────
  const menuItems = (f: TimelineFeature, part: TimelinePart, anchor: Element | null): MenuEntry[] => {
    const i = part.features.findIndex((x) => x.id === f.id);
    const slots = v1 ? moveSlots(orderOf(part), f.id) : [];
    const earlier = slots[i - 1];
    const later = slots[i + 1];
    const isMarker = timeline.rollback === f.id;
    const items: MenuEntry[] = [{ key: "edit", label: f.type === "sketch" ? "Edit Sketch" : "Edit Feature…", hint: "↵", run: () => editFeature(ctx, f) }];
    if (!v1) {
      items.push({ key: "suppress", label: f.suppressed ? "Unsuppress" : "Suppress", run: () => setSuppressed(ctx, f, false) });
      return items;
    }
    items.push(
      { key: "rename", label: "Rename…", hint: "F2", run: () => startRename(ctx, { kind: "feature", id: f.id, name: f.name }, anchor) },
      { key: "sep1", separator: true },
      { key: "suppress", label: f.suppressed ? "Unsuppress" : "Suppress", run: () => setSuppressed(ctx, f, true) },
      isMarker ? { key: "rollforward", label: "Roll to End", run: () => void rollTo(ctx, null) } : { key: "rollback", label: "Roll Back to Here", run: () => void rollTo(ctx, f.id) },
      {
        key: "up",
        label: "Move Earlier",
        disabled: !earlier || !earlier.valid,
        ...(earlier && !earlier.valid && earlier.reason ? { title: earlier.reason } : {}),
        run: () => earlier && void moveFeature(ctx, f.id, earlier.after),
      },
      {
        key: "down",
        label: "Move Later",
        disabled: !later || !later.valid,
        ...(later && !later.valid && later.reason ? { title: later.reason } : {}),
        run: () => later && void moveFeature(ctx, f.id, later.after),
      },
    );
    if (f.agent) items.push({ key: "keep", label: "Keep (make it yours)", run: () => keepFeatures(ctx, [f.id]) });
    items.push({ key: "sep2", separator: true }, { key: "delete", label: "Delete…", hint: "⌫", danger: true, run: () => void requestDelete(ctx, f) });
    return items;
  };

  // ─── Keys ──────────────────────────────────────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const i = flat.findIndex((x) => x.f.id === selectedId);
    const cur = flat[i];
    const pick = (j: number): void => {
      const x = flat[Math.max(0, Math.min(flat.length - 1, j))];
      if (x) selectFeature(ctx, x.f.id);
    };
    if (e.key === "ArrowRight") pick(i < 0 ? 0 : i + 1);
    else if (e.key === "ArrowLeft") pick(i < 0 ? flat.length - 1 : i - 1);
    else if (e.key === "Enter" && cur) editFeature(ctx, cur.f);
    else if (e.key === "F2" && cur && v1) startRename(ctx, { kind: "feature", id: cur.f.id, name: cur.f.name }, track.current?.querySelector(`[data-feature-id="${CSS.escape(cur.f.id)}"]`) ?? null);
    else if ((e.key === "Delete" || e.key === "Backspace") && cur && v1) void requestDelete(ctx, cur.f);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    if (!selectedId || !track.current) return;
    track.current.querySelector<HTMLElement>(`[data-feature-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);

  const showCard = (f: TimelineFeature, el: HTMLElement): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover({ f, rect: el.getBoundingClientRect() }), 380);
  };
  const hideCard = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHover(null);
  };

  const transport = (dir: "first" | "prev" | "next" | "last"): void => {
    if (dir === "last") return void rollTo(ctx, null);
    const part = timeline.parts.find((p) => p.features.some((f) => f.id === timeline.rollback)) ?? timeline.parts[timeline.parts.length - 1];
    if (!part || part.features.length === 0) return;
    const at = timeline.rollback === null ? part.features.length - 1 : part.features.findIndex((f) => f.id === timeline.rollback);
    const to = dir === "first" ? 0 : dir === "prev" ? at - 1 : at + 1;
    if (to < 0) return;
    void rollTo(ctx, to >= part.features.length - 1 ? null : part.features[to]!.id);
  };

  const rolled = timeline.rollback !== null;
  const canRoll = v1 && flat.length > 0;
  const empty = timeline.featureCount === 0;

  let flatIndex = 0;
  const marker = (
    <span
      key="marker"
      className={`ptl-marker${markerGap !== null ? " dragging" : ""}${rolled ? " rolled" : ""}`}
      role="slider"
      aria-label="Rollback marker: drag to roll the model back"
      aria-valuemin={1}
      aria-valuemax={Math.max(1, flat.length)}
      aria-valuenow={shownMarker}
      aria-orientation="horizontal"
      tabIndex={canRoll ? 0 : -1}
      data-testid="timeline-marker"
      data-after={timeline.rollback ?? ""}
      title={rolled ? "Rolled back: drag to the end (or ⏭) to build everything" : "Drag left to roll the model back"}
      onPointerDown={startMarkerDrag}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") transport("prev");
        else if (e.key === "ArrowRight") transport("next");
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <span className="ptl-marker-flag" />
      <span className="ptl-marker-line" />
    </span>
  );

  return (
    <section className={`ptl${activeDrag ? " dragging" : ""}${sketching ? " locked" : ""}`} aria-label="Timeline" data-testid="timeline" aria-disabled={sketching || undefined} title={sketching ? "Finish or cancel the sketch to work on the timeline" : undefined}>
      <div className="ptl-transport" role="toolbar" aria-label="Roll back">
        <button type="button" className="ptl-tbtn" title="Roll back to the first feature" aria-label="Roll back to the first feature" disabled={!canRoll} onClick={() => transport("first")} data-testid="timeline-first">
          <ModelIcon.First size={13} />
        </button>
        <button type="button" className="ptl-tbtn" title="Step back one feature" aria-label="Step back one feature" disabled={!canRoll} onClick={() => transport("prev")} data-testid="timeline-prev">
          <ModelIcon.Prev size={13} />
        </button>
        <button type="button" className="ptl-tbtn" title="Step forward one feature" aria-label="Step forward one feature" disabled={!canRoll || !rolled} onClick={() => transport("next")} data-testid="timeline-next">
          <ModelIcon.Next size={13} />
        </button>
        <button type="button" className="ptl-tbtn" title="Roll to the end (build everything)" aria-label="Roll to the end" disabled={!canRoll || !rolled} onClick={() => transport("last")} data-testid="timeline-roll-to-end">
          <ModelIcon.Last size={13} />
        </button>
      </div>
      <div
        ref={track}
        className="ptl-track"
        role="listbox"
        aria-orientation="horizontal"
        aria-label="Features in timeline order"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && track.current) track.current.scrollLeft += e.deltaY;
        }}
      >
        {empty ? (
          <span className="ptl-empty">{!hasCompile || phase === "compiling" ? "Loading…" : "No features yet. Start with a Sketch — your history appears here."}</span>
        ) : (
          timeline.parts.map((part, pi) => {
            const lastPart = pi === timeline.parts.length - 1;
            return (
              <div key={part.id} className="ptl-part" data-testid="timeline-part" data-part={part.id}>
                {multiPart && (
                  <span className="ptl-part-label" title={`Part ${part.name}`}>
                    {part.name}
                  </span>
                )}
                {part.features.map((f, i) => {
                  const fi = flatIndex++;
                  const draft = draftKinds.get(`${part.name}/${f.name}`);
                  const inDrag = activeDrag && activeDrag.part.id === part.id;
                  const dropHere = inDrag && activeDrag.gap === i && dropSlot && !dropSlot.current;
                  const previewRolled = markerGap !== null && fi >= markerGap && part.features.length > 0 && flat[markerGap - 1]?.part.id === part.id;
                  const json = jsonById.get(f.id);
                  return (
                    <Fragment key={f.id}>
                      {dropHere && <DropLine slot={dropSlot} />}
                      <button
                        type="button"
                        role="option"
                        className={[
                          "ptl-chip",
                          `st-${f.status}`,
                          f.id === selectedId ? "selected" : "",
                          f.suppressed ? "suppressed" : "",
                          (markerGap === null ? f.rolledBack : previewRolled) ? "rolled-back" : "",
                          f.agent ? "agent" : "",
                          activeDrag?.feature.id === f.id ? "drag-source" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        aria-selected={f.id === selectedId}
                        aria-label={`${f.name}, ${typeTitle(f.type)}${f.summary ? `, ${f.summary}` : ""}, ${STATUS_TEXT[f.status]}${f.agent ? ", made by the assistant" : ""}`}
                        tabIndex={-1}
                        data-testid="timeline-feature"
                        data-feature={f.name}
                        data-feature-id={f.id}
                        data-part={f.partId}
                        data-type={f.type}
                        data-status={f.status}
                        data-author={f.agent ? "agent" : "user"}
                        data-draft={draft ?? ""}
                        data-index={fi}
                        onPointerDown={(e) => startChipDrag(e, f, part, i)}
                        onClick={() => {
                          if (suppressClick.current) return;
                          selectFeature(ctx, f.id);
                          track.current?.focus({ preventScroll: true });
                        }}
                        onDoubleClick={() => editFeature(ctx, f)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          hideCard();
                          selectFeature(ctx, f.id);
                          setMenu({ f, part, x: e.clientX, y: e.clientY });
                        }}
                        onMouseEnter={(e) => showCard(f, e.currentTarget)}
                        onMouseLeave={hideCard}
                      >
                        <span className={`ptl-icon type-${f.type}`}>
                          <ToolIcon name={featureIcon(f.type, json)} size={17} />
                        </span>
                        {(f.status === "error" || f.status === "warning") && <span className={`ptl-flag ${f.status}`} aria-hidden="true" />}
                        {f.agent && (
                          <span className="ptl-ai" title="Made by the assistant" data-testid="timeline-agent-badge">
                            AI
                          </span>
                        )}
                        {draft && (
                          <span className={`ptl-draft kind-${draft}`} title={`The assistant's proposal ${draft === "removed" ? "removes" : "changes"} this feature`}>
                            {draft === "removed" ? "−" : "Δ"}
                          </span>
                        )}
                        <span className="tl-name pz-sr">{f.name}</span>
                        <span className="tl-summary pz-sr">{f.status === "error" && f.issues[0] ? f.issues[0].code : f.summary}</span>
                      </button>
                      {markerGap === null && timeline.rollback === f.id && marker}
                      {markerGap !== null && markerGap === fi + 1 && marker}
                    </Fragment>
                  );
                })}
                {activeDrag && activeDrag.part.id === part.id && activeDrag.gap >= part.features.length && dropSlot && !dropSlot.current && <DropLine slot={dropSlot} />}
                {(review?.changes ?? [])
                  .filter((c) => c.kind === "added" && c.part === part.name)
                  .map((c) => (
                    <span key={c.key} className="ptl-chip proposed" data-testid="timeline-proposed" title={`${c.feature} · proposed by the assistant`}>
                      <span className="ptl-icon">+</span>
                      <span className="pz-sr">{c.feature}</span>
                    </span>
                  ))}
                {lastPart && markerGap === null && timeline.rollback === null && marker}
              </div>
            );
          })
        )}
      </div>
      <div className="ptl-status">
        {timeline.stale && (
          <span className="ptl-pill warn" data-testid="timeline-stale" title="The code has errors: the timeline shows the last model that compiled">
            Code has errors
          </span>
        )}
        {rolled && (
          <button type="button" className="ptl-pill info" onClick={() => void rollTo(ctx, null)} title="Features after the marker are not built. Click to build everything." data-testid="timeline-rolled-pill">
            Rolled back
          </button>
        )}
        {agentIds.length > 0 && (
          <span className="ptl-pill agent" data-testid="timeline-keep-all">
            <span>{agentIds.length} by AI</span>
            <button type="button" className="link-button" onClick={() => keepFeatures(ctx, agentIds)} title="Make the assistant's features yours (ADR 0015)">
              Keep all
            </button>
          </span>
        )}
        {(errors > 0 || warnings > 0) && (
          <button type="button" className="ptl-pill problems" onClick={() => services.ui.setPanel("problems", true)} title="Show problems" data-testid="timeline-problem-count">
            {errors > 0 && <span className="err">{errors} failed</span>}
            {warnings > 0 && <span className="warn">{warnings} warning{warnings === 1 ? "" : "s"}</span>}
          </button>
        )}
        <span className="ptl-count" data-testid="timeline-count">
          {timeline.featureCount > 0 ? `${timeline.featureCount} feature${timeline.featureCount === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      {activeDrag && (
        <span className={`ptl-ghost${dropSlot && !dropSlot.valid ? " invalid" : ""}`} style={{ left: activeDrag.x, top: activeDrag.y }} aria-hidden="true">
          <ToolIcon name={featureIcon(activeDrag.feature.type, jsonById.get(activeDrag.feature.id))} size={17} />
        </span>
      )}
      {hover && !activeDrag && !menu && <HoverCard f={hover.f} rect={hover.rect} json={jsonById.get(hover.f.id)} />}
      {menu && (
        <ContextMenu
          testId="timeline-menu"
          at={{ x: menu.x, y: menu.y }}
          items={menuItems(menu.f, menu.part, track.current?.querySelector(`[data-feature-id="${CSS.escape(menu.f.id)}"]`) ?? null)}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}

function DropLine({ slot }: { slot: MoveSlot }): ReactElement {
  return (
    <span className={`ptl-drop${slot.valid ? " valid" : " invalid"}`} data-testid="timeline-drop" data-valid={slot.valid ? "true" : "false"} aria-hidden="true">
      <span className="ptl-drop-line" />
      {!slot.valid && slot.reason && <span className="ptl-drop-reason">{slot.reason}</span>}
    </span>
  );
}
