/**
 * Settings ▸ Navigation (FD3: "other presets live in Settings"): how a scroll moves the camera —
 * detected per gesture (Auto), or forced to Mouse (every scroll zooms) or Trackpad (every scroll
 * orbits, Shift pans). A test pad shows what each scroll is read as and why, and copies the raw
 * events (for a bug report, or a fixture in `test/fixtures/wheel-sequences.ts`).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { useApp } from "../ui/context";
import { NAV_PRESETS, newWheelMemory, classifyWheel, wheelSignal, type NavAction, type NavPreset, type WheelLike } from "./navigation";
import { routedExecute } from "./registry";
import { viewportRuntime } from "./runtime";
import "./viewport.css";

const PRESET_LABEL: Record<NavPreset, { title: string; hint: string }> = {
  auto: { title: "Detect mouse or trackpad", hint: "A mouse wheel zooms; a two-finger scroll orbits, with Shift it pans." },
  mouse: { title: "Mouse", hint: "Every scroll zooms, a trackpad's too." },
  trackpad: { title: "Trackpad", hint: "Every scroll orbits (with Shift it pans), a mouse wheel's too." },
};

/** One recorded wheel event: what Chromium reported, and what it was read as. */
export interface WheelRecord extends WheelLike {
  read: string;
}

const MAX_RECORDS = 400;

function actionText(a: NavAction | null): string {
  if (!a) return "nothing";
  return a.type === "zoom" ? (a.factor < 1 ? "zoom in" : "zoom out") : a.type;
}

export function NavigationSection(): ReactElement {
  const { services, commands } = useApp();
  const runtime = viewportRuntime(services);
  const preset = useSyncExternalStore(runtime.view.subscribe, () => runtime.view.getState().navigation);
  const padRef = useRef<HTMLDivElement>(null);
  const records = useRef<WheelRecord[]>([]);
  const [last, setLast] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [copy, setCopy] = useState<string | null>(null);

  useEffect(() => {
    const pad = padRef.current;
    if (!pad) return;
    const mem = newWheelMemory();
    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault();
      const e = ev as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number };
      const like: WheelLike = {
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        ...(e.wheelDeltaX !== undefined ? { wheelDeltaX: e.wheelDeltaX } : {}),
        ...(e.wheelDeltaY !== undefined ? { wheelDeltaY: e.wheelDeltaY } : {}),
        timeStamp: e.timeStamp,
      };
      const sig = wheelSignal(like);
      const a = classifyWheel(like, mem, preset);
      const as = mem.device === "pinch" ? "pinch" : mem.device === "mouse" ? "mouse wheel" : "trackpad";
      const why = preset !== "auto" && sig.device !== "pinch" ? `set to ${PRESET_LABEL[preset].title}` : mem.device === sig.device ? sig.rule : `continues the ${as} gesture`;
      const read = `${as} → ${actionText(a)} (${why})`;
      records.current.push({ ...like, read });
      if (records.current.length > MAX_RECORDS) records.current.shift();
      setLast(read);
      setCount((c) => c + 1);
    };
    pad.addEventListener("wheel", onWheel, { passive: false });
    return () => pad.removeEventListener("wheel", onWheel);
  }, [preset]);

  const choose = (device: NavPreset): void => void routedExecute(services, commands, { id: "view.setNavigation", args: { device } }, "ui");

  const copyEvents = (): void => {
    const text = JSON.stringify({ userAgent: navigator.userAgent, preset, events: records.current }, null, 1);
    navigator.clipboard.writeText(text).then(
      () => setCopy(`Copied ${records.current.length} events.`),
      () => setCopy("Could not copy to the clipboard."),
    );
  };

  return (
    <section className="settings-section" data-testid="settings-navigation">
      <h3>Navigation</h3>
      <p className="muted small">Right-drag orbits, middle-drag (or Shift+right-drag) pans and pinch zooms in every mode. What a scroll does:</p>
      <div className="nav-presets" role="radiogroup" aria-label="Scroll navigation">
        {NAV_PRESETS.map((p) => (
          <label key={p} className="nav-preset" data-preset={p}>
            <input type="radio" name="nav-preset" value={p} checked={preset === p} onChange={() => choose(p)} />
            <span>
              <span className="key-name">{PRESET_LABEL[p].title}</span>
              <span className="muted small"> {PRESET_LABEL[p].hint}</span>
            </span>
          </label>
        ))}
      </div>
      <div ref={padRef} className="nav-test-pad" data-testid="nav-test-pad" tabIndex={0} aria-label="Scroll or pinch here to test">
        {last === null ? <span className="muted small">Scroll or pinch here to see how it is read.</span> : <span className="small" data-testid="nav-test-read">{last}</span>}
      </div>
      <div className="nav-test-foot small">
        <span className="muted">{count > 0 ? `${count} event${count === 1 ? "" : "s"}` : ""}</span>
        <span className="spacer" />
        {copy && <span className="muted">{copy}</span>}
        <button type="button" className="ghost-btn tiny" disabled={count === 0} onClick={copyEvents}>
          Copy events
        </button>
      </div>
    </section>
  );
}
