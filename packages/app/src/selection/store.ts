/**
 * `SelectionStore`: the selection model the viewport, the tools and the agent read (§2.4). It holds
 * ordered items (the first is the primary), the kind filter, the hover pre-highlight and a revision
 * counter. After every regeneration {@link SelectionStore.resolve} re-resolves the items against the
 * new scene: faces and edges by provenance name, vertices by derived key and then by position, and
 * drops what no longer exists (reported in `dropped`, for a quiet notice).
 */
import { Store } from "../store";
import type { Vec3 } from "../viewport/view-camera";
import { hasEntity, type SceneTopology } from "./topology";
import { ALL_KINDS, isEntity, itemId, passesFilter, sameItem, type KindMask, type SelectionItem, type SelectionKind, type SelectionState } from "./types";

/** At most this many items (a box over a large model stays manageable for tools and chips). */
export const MAX_SELECTION = 5000;

export class SelectionStore extends Store<SelectionState> {
  constructor(filter: KindMask = ALL_KINDS) {
    super({ items: [], filter, hover: null, revision: 0, dropped: [] });
  }

  private commit(items: readonly SelectionItem[], dropped: readonly SelectionItem[] = []): void {
    const unique: SelectionItem[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const id = itemId(it);
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(it);
      if (unique.length >= MAX_SELECTION) break;
    }
    const cur = this.getState().items;
    if (unique.length === cur.length && unique.every((it, i) => itemId(it) === itemId(cur[i]!)) && dropped.length === 0) return;
    this.setState((s) => ({ items: unique, revision: s.revision + 1, dropped }));
  }

  get items(): readonly SelectionItem[] {
    return this.getState().items;
  }

  get primary(): SelectionItem | null {
    return this.getState().items[0] ?? null;
  }

  set(items: readonly SelectionItem[]): void {
    this.commit(items);
  }

  add(items: readonly SelectionItem[]): void {
    this.commit([...this.getState().items, ...items]);
  }

  remove(items: readonly SelectionItem[]): void {
    const ids = new Set(items.map(itemId));
    this.commit(this.getState().items.filter((it) => !ids.has(itemId(it))));
  }

  /** Add the item, or remove it when already selected (shift/⌘-click). */
  toggle(item: SelectionItem): boolean {
    const cur = this.getState().items;
    const has = cur.some((it) => sameItem(it, item));
    this.commit(has ? cur.filter((it) => !sameItem(it, item)) : [...cur, item]);
    return !has;
  }

  clear(): void {
    this.commit([]);
  }

  /** Another document was loaded: no items, no hover, no pending "dropped" notice. The filter stays. */
  reset(): void {
    const s = this.getState();
    if (s.items.length === 0 && s.hover === null && s.dropped.length === 0) return;
    this.setState((st) => ({ items: [], hover: null, dropped: [], revision: st.revision + 1 }));
  }

  has(item: SelectionItem): boolean {
    return this.getState().items.some((it) => sameItem(it, item));
  }

  setHover(hover: SelectionItem | null): void {
    if (sameItem(this.getState().hover, hover)) return;
    this.setState({ hover });
  }

  /** Change the filter; items the new filter excludes are deselected (as in Fusion). */
  setFilter(patch: Partial<Record<SelectionKind, boolean>>): KindMask {
    const filter: KindMask = { ...this.getState().filter, ...patch };
    this.setState({ filter });
    const kept = this.getState().items.filter((it) => passesFilter(it, filter));
    if (kept.length !== this.getState().items.length) this.commit(kept);
    if (this.getState().hover && !passesFilter(this.getState().hover!, filter)) this.setState({ hover: null });
    return filter;
  }

  /** Only `kind` (keys 1–5 behaviour: a single kind), or everything back. */
  solo(kind: SelectionKind | "all"): KindMask {
    if (kind === "all") return this.setFilter(ALL_KINDS);
    const next = Object.fromEntries(Object.keys(ALL_KINDS).map((k) => [k, k === kind])) as Record<SelectionKind, boolean>;
    // Datums and origin stay pickable with the face filter (they are construction planes).
    if (kind === "face") {
      next.datum = true;
      next.origin = true;
    }
    return this.setFilter(next);
  }

  /**
   * Re-resolve against a new scene: entities that still exist are kept (a vertex whose key changed
   * is found again by its position), the rest are dropped. Returns the dropped items.
   */
  resolve(topo: SceneTopology): SelectionItem[] {
    const kept: SelectionItem[] = [];
    const dropped: SelectionItem[] = [];
    for (const it of this.getState().items) {
      const r = resolveItem(topo, it);
      if (r) kept.push(r);
      else dropped.push(it);
    }
    const hover = this.getState().hover;
    if (hover && !resolveItem(topo, hover)) this.setState({ hover: null });
    if (dropped.length > 0 || kept.some((k, i) => k !== this.getState().items[i])) this.commit(kept, dropped);
    return dropped;
  }
}

function near(a: Vec3, b: Vec3, tol: number): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

/** The item in the new scene, or `null` when it no longer exists. */
export function resolveItem(topo: SceneTopology, it: SelectionItem): SelectionItem | null {
  if (!isEntity(it)) {
    if (it.kind === "body") return topo.bodies.has(it.body) ? it : null;
    return it;
  }
  if (hasEntity(topo, it.kind, it.body, it.key)) {
    if (it.kind !== "vertex") return it;
    const v = topo.bodies.get(it.body)!.vertices.get(it.key)!;
    return it.point && near(it.point, v.point, 0) ? it : { ...it, point: v.point };
  }
  if (it.kind === "vertex" && it.point) {
    const b = topo.bodies.get(it.body);
    const size = b?.bbox ? Math.hypot(b.bbox.max[0] - b.bbox.min[0], b.bbox.max[1] - b.bbox.min[1], b.bbox.max[2] - b.bbox.min[2]) : 1;
    const tol = Math.max(1e-6, size * 1e-6);
    for (const v of b?.vertices.values() ?? []) if (near(v.point, it.point, tol)) return { kind: "vertex", body: it.body, key: v.key, point: v.point };
  }
  return null;
}
