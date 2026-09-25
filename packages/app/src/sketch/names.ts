/**
 * Names for new sketches: `sketch1`, `sketch2`, … — the first one no feature, part or parameter
 * of the document uses as an id or a name (SPEC-v1 §0.3: feature names and parameters share one
 * namespace; CadScript v0 uses the name as its `const`).
 */
import type { v1 } from "@aicad/ir-types";

/** Every id and name a document already uses: parts, features, and parameters (document and part level). */
export function namesIn(document: v1.IrDocument | null | undefined): string[] {
  if (!document) return [];
  const out: string[] = [];
  for (const p of document.params ?? []) out.push(p.name);
  for (const part of document.parts) {
    out.push(part.id, part.name);
    for (const p of part.params ?? []) out.push(p.name);
    for (const f of part.features) out.push(f.id, f.name);
  }
  return out;
}

/** The first `sketch<n>` (n ≥ 1) that is not in `taken`. */
export function nextSketchName(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const name = `sketch${n}`;
    if (!used.has(name)) return name;
  }
}
