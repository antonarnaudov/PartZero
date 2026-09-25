/// <reference types="node" />
/**
 * Drive sketch mode in tests with the real WASM session (`@aicad/forge-web/sketch`, built) and
 * pointer events at sketch coordinates.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { SketchSession, initSketchSync } from "@aicad/forge-web/sketch";
import { MemorySink } from "../../src/sketch/commit";
import { SketchMode, type SketchEngineFactory } from "../../src/sketch/controller";
import { namedFrame } from "../../src/sketch/frames";
import type { P2 } from "../../src/sketch/geom";
import { PlaneView } from "../../src/sketch/view";
import type { PointerIn } from "../../src/tools/sketch/types";

const require = createRequire(import.meta.url);
const forgeWeb = dirname(require.resolve("@aicad/forge-web/package.json"));
initSketchSync(readFileSync(join(forgeWeb, "pkg-sketch/forge_sketch_wasm_bg.wasm")));

export const engines: SketchEngineFactory = {
  ready: async () => {},
  load: (req) => SketchSession.load(req),
};

export interface Driver {
  mode: SketchMode;
  sink: MemorySink;
  px(p: P2): P2;
  click(p: P2, o?: Partial<PointerIn>): void;
  move(p: P2, o?: Partial<PointerIn>): void;
  drag(from: P2, to: P2, o?: Partial<PointerIn>): void;
  key(key: string, o?: { mod?: boolean; shift?: boolean; alt?: boolean }): boolean;
  type(text: string): void;
}

export async function start(opts: { document?: import("@aicad/ir-types").v1.IrDocument } = {}): Promise<Driver> {
  const sink = new MemorySink();
  const mode = new SketchMode(engines, sink);
  mode.setViewport(1000, 800);
  const ok = await mode.begin({ plane: { ref: "XY", frame: namedFrame("XY"), label: "XY" }, ...(opts.document ? { document: opts.document } : {}) });
  if (!ok) throw new Error(mode.getState().error ?? "begin failed");
  const px = (p: P2): P2 => new PlaneView(mode.getState().view).toScreen(p);
  const ev = (p: P2, o: Partial<PointerIn> = {}): PointerIn => ({ px: px(p), button: 0, shift: false, alt: false, ctrl: false, meta: false, clicks: 1, ...o });
  return {
    mode,
    sink,
    px,
    click(p, o) {
      mode.pointerMove(ev(p, o));
      mode.pointerDown(ev(p, o));
      mode.pointerUp(ev(p, o));
    },
    move(p, o) {
      mode.pointerMove(ev(p, o));
    },
    drag(from, to, o) {
      mode.pointerMove(ev(from, o));
      mode.pointerDown(ev(from, o));
      const steps = 6;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        mode.pointerMove(ev([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t], o));
      }
      mode.pointerUp(ev(to, o));
    },
    key(key, o = {}) {
      return mode.key({ key, mod: !!o.mod, shift: !!o.shift, alt: !!o.alt, editable: false });
    },
    type(text) {
      for (const ch of text) mode.key({ key: ch, mod: false, shift: false, alt: false, editable: false });
      const t = mode.getState().typed;
      if (t) mode.setTypedText(text);
    },
  };
}
