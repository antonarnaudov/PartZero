/**
 * Ids for new curves and constraints (SPEC-v1 §0.3 grammar; one namespace per sketch, shared by
 * curves and constraints). The session re-checks uniqueness; this only proposes free names.
 */
import type { v1 } from "@aicad/ir-types";
import type { SketchSnapshot } from "./engine-types";

export class IdAllocator {
  private readonly used: Set<string>;

  constructor(used: Iterable<string>) {
    this.used = new Set(used);
  }

  static of(snapshot: SketchSnapshot | null, feature?: v1.SketchFeature | null): IdAllocator {
    const ids: string[] = [];
    for (const c of snapshot?.curves ?? []) ids.push(c.id);
    for (const c of snapshot?.constraints ?? []) ids.push(c.id);
    for (const c of feature?.curves ?? []) ids.push(c.id);
    for (const c of feature?.constraints ?? []) ids.push(c.id);
    return new IdAllocator(ids);
  }

  /** `prefix1`, `prefix2`, … : the first free one (and reserve it). */
  next(prefix: string): string {
    for (let n = 1; ; n++) {
      const id = `${prefix}${n}`;
      if (!this.used.has(id)) {
        this.used.add(id);
        return id;
      }
    }
  }

  has(id: string): boolean {
    return this.used.has(id);
  }
}

/** Is `name` a valid IR id (`[A-Za-z_][A-Za-z0-9_]*`, at most 64 bytes)? */
export function isId(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 64;
}
