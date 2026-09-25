/**
 * Forge's picture of a starter's ready-made example for the welcome screen: the example compiled,
 * evaluated by the active engine (as when it is opened) and drawn by the document thumbnail's own
 * software rasteriser (`file/thumbnail.ts`: isometric, shaded, transparent background). Cached per
 * app; `null` when there is no example, the engine cannot build it, or it has no bodies (the card
 * keeps its illustration, `starter-art.tsx`).
 */
import { renderThumbnailRgba } from "../../file/thumbnail";
import type { AppServices } from "../../services";
import type { Starter } from "../../tools/starters";

export const STARTER_THUMB_SIZE = { width: 384, height: 240 } as const;

export interface StarterThumbnail {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

const cache = new WeakMap<AppServices, Map<string, Promise<StarterThumbnail | null>>>();

async function build(services: AppServices, starter: Starter): Promise<StarterThumbnail | null> {
  if (!starter.source) return null;
  let irJson: string | null = null;
  if (services.doc.v1Available) {
    const v1 = await services.cadscript.compileV1(starter.source);
    irJson = v1.ok && v1.irJson ? v1.irJson : null;
  }
  if (irJson === null) {
    const v0 = await services.cadscript.compile(starter.source);
    irJson = v0.ok && v0.ir ? JSON.stringify(v0.ir) : null;
  }
  if (irJson === null) return null;
  const r = await services.engines.active.evaluate(irJson, services.doc.displayTessellation);
  const { width, height } = STARTER_THUMB_SIZE;
  const rgba = renderThumbnailRgba(r.bodies, width, height);
  return rgba ? { rgba: new Uint8ClampedArray(rgba), width, height } : null;
}

/** The starter's example as pixels, or null (see the module docs). Never rejects. */
export function starterThumbnail(services: AppServices, starter: Starter): Promise<StarterThumbnail | null> {
  let byId = cache.get(services);
  if (!byId) {
    byId = new Map();
    cache.set(services, byId);
  }
  const hit = byId.get(starter.id);
  if (hit) return hit;
  const p = build(services, starter).catch(() => null);
  byId.set(starter.id, p);
  // A failure (say, the engine was still starting) is not cached: the next welcome tries again.
  void p.then((t) => {
    if (!t) byId.delete(starter.id);
  });
  return p;
}
