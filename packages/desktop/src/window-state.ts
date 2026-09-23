/** Window bounds persistence: saved in `userData/window-state.json`, validated against the current displays. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const DEFAULT_WINDOW_STATE: WindowState = { width: 1440, height: 900, maximized: false };
export const MIN_SIZE = { width: 900, height: 600 };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function overlap(a: Rect, b: Rect): { w: number; h: number } {
  return {
    w: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    h: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * Validate a stored state: sizes are clamped to the minimum and to the largest work area, and a
 * position is kept only when enough of the title bar area stays on some display (monitors change).
 */
export function sanitizeWindowState(raw: unknown, workAreas: readonly Rect[]): WindowState {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  // Without display information, do not clamp to a maximum.
  const maxW = workAreas.length ? Math.max(MIN_SIZE.width, ...workAreas.map((a) => a.width)) : Number.POSITIVE_INFINITY;
  const maxH = workAreas.length ? Math.max(MIN_SIZE.height, ...workAreas.map((a) => a.height)) : Number.POSITIVE_INFINITY;
  const width = Math.round(Math.min(maxW, Math.max(MIN_SIZE.width, isNum(r["width"]) ? r["width"] : DEFAULT_WINDOW_STATE.width)));
  const height = Math.round(Math.min(maxH, Math.max(MIN_SIZE.height, isNum(r["height"]) ? r["height"] : DEFAULT_WINDOW_STATE.height)));
  const state: WindowState = { width, height, maximized: r["maximized"] === true };
  if (isNum(r["x"]) && isNum(r["y"])) {
    const rect = { x: Math.round(r["x"]), y: Math.round(r["y"]), width, height };
    const titleBar = { ...rect, height: 40 };
    if (workAreas.some((a) => {
      const o = overlap(titleBar, a);
      return o.w >= 100 && o.h >= 20;
    })) {
      state.x = rect.x;
      state.y = rect.y;
    }
  }
  return state;
}

export function loadWindowState(file: string, workAreas: readonly Rect[]): WindowState {
  try {
    return sanitizeWindowState(JSON.parse(readFileSync(file, "utf8")), workAreas);
  } catch {
    return sanitizeWindowState(null, workAreas);
  }
}

export function saveWindowState(file: string, state: WindowState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Best effort: failing to persist window bounds must never break the app.
  }
}
