/**
 * Timeline order rules for the UI (IR v1, SPEC-v1 §5.3, §7.1): a feature references only earlier
 * features of its part, by id, in exactly these places:
 *
 * | Field | Where |
 * |---|---|
 * | `sketch` | extrude, revolve, hole points (`{ sketch, ids }`) |
 * | `datum` | plane and axis references (`{ datum: id }`) |
 * | `feature` | every named query source (`body`, `cap`, `side`, `hole_face`, `tagged`, …) |
 * | `features` | a pattern's feature seed |
 *
 * The timeline uses this to show, while you drag a feature, where it may go (after everything it
 * uses, before everything that uses it) and the rollback marker's positions. It is a preview: the
 * command layer's `moveFeature` asks the engine, whose refusal (`COMMAND_ILLEGAL_ORDER`) decides.
 */

type Json = Record<string, unknown>;

/** Keys whose string value names another feature of the part. */
const REF_KEYS: ReadonlySet<string> = new Set(["sketch", "datum", "feature"]);
/** Metadata that never holds a reference. */
const SKIP_KEYS: ReadonlySet<string> = new Set(["id", "name", "type", "v", "note", "intent", "author", "assumptions", "decision_ids", "capture"]);

/** The ids (among `ids`) that `feature` references, in first-seen order. */
export function featureRefs(feature: unknown, ids: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const hit = (v: unknown): void => {
    if (typeof v === "string" && ids.has(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  const walk = (node: unknown, top: boolean): void => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x, false);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Json)) {
      if (top && SKIP_KEYS.has(k)) continue;
      if (k === "capture") continue;
      if (REF_KEYS.has(k)) hit(v);
      else if (k === "features" && Array.isArray(v)) v.forEach(hit);
      if (v && typeof v === "object") walk(v, false);
    }
  };
  walk(feature, true);
  const own = (feature as Json | null)?.["id"];
  return out.filter((id) => id !== own);
}

export interface OrderFeature {
  id: string;
  name: string;
  /** The feature's IR JSON. */
  json: unknown;
}

/** A place a dragged feature can go: between two features of its part. */
export interface MoveSlot {
  /** The feature it would follow (`moveFeature.after`); null = first. */
  after: string | null;
  /** Index into the part's features without the dragged one (insert before this index). */
  index: number;
  /** The feature's current place (dropping there changes nothing). */
  current: boolean;
  valid: boolean;
  /** Why it may not go there: the feature it uses (it must stay after it) or its first user. */
  reason?: string;
}

/**
 * Every place `dragged` may be moved to within its part, with why the others are refused. A
 * feature must stay after every feature it references and before every feature that references
 * it directly (later dependents of those dependents do not constrain it).
 */
export function moveSlots(features: readonly OrderFeature[], dragged: string): MoveSlot[] {
  const at = features.findIndex((f) => f.id === dragged);
  if (at < 0) return [];
  const ids = new Set(features.map((f) => f.id));
  const self = features[at]!;
  const uses = new Set(featureRefs(self.json, ids));
  const users = new Set(features.filter((f) => f.id !== dragged && featureRefs(f.json, ids).includes(dragged)).map((f) => f.id));
  const rest = features.filter((f) => f.id !== dragged);
  const byId = new Map(features.map((f) => [f.id, f]));
  // The latest feature it uses, and the first feature that uses it, in `rest` order.
  let lastUse = -1;
  let firstUser = rest.length;
  rest.forEach((f, i) => {
    if (uses.has(f.id)) lastUse = i;
    if (users.has(f.id) && i < firstUser) firstUser = i;
  });
  const slots: MoveSlot[] = [];
  for (let k = 0; k <= rest.length; k++) {
    const after = k === 0 ? null : rest[k - 1]!.id;
    const slot: MoveSlot = { after, index: k, current: k === at, valid: true };
    if (k <= lastUse) {
      slot.valid = false;
      slot.reason = `${self.name} uses ${byId.get(rest[lastUse]!.id)!.name}: it must stay after it`;
    } else if (k > firstUser) {
      slot.valid = false;
      slot.reason = `${byId.get(rest[firstUser]!.id)!.name} uses ${self.name}: it must stay before it`;
    }
    slots.push(slot);
  }
  return slots;
}

/**
 * The slot for a drop gap in the displayed order (gap `g` = before the `g`-th chip, with the
 * dragged chip still shown): the gaps on either side of the dragged chip are its current place.
 */
export function slotForGap(slots: readonly MoveSlot[], draggedIndex: number, gap: number): MoveSlot | null {
  const k = gap <= draggedIndex ? gap : gap - 1;
  return slots[k] ?? null;
}
