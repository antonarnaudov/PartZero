/**
 * CadScript v0 headed for the IR v1 model. The v0 compiler gives features fresh ids (`f_plate`)
 * and names faces by the feature's *name* (`plate/cap:end`); IR v1 names faces by the feature's
 * *id*. So that a part written in v0 CadScript keeps the face names people and tools know
 * (`plate/cap:end`) and ids read like names, the compiled document's feature ids become their
 * names before it is migrated (v0 references features by name, so nothing else changes).
 */
import type { IrDocument } from "@aicad/ir-types";

const ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function namesAsIds(ir: IrDocument): IrDocument {
  const next = structuredClone(ir);
  const names = new Set(next.parts.flatMap((p) => p.features.map((f) => f.name)));
  const taken = new Set<string>();
  for (const p of next.parts) {
    for (const f of p.features) {
      if (ID.test(f.name) && !taken.has(f.name)) f.id = f.name;
      else if (taken.has(f.id) || names.has(f.id)) {
        let n = 2;
        while (taken.has(`${f.id}_${n}`) || names.has(`${f.id}_${n}`)) n++;
        f.id = `${f.id}_${n}`;
      }
      taken.add(f.id);
    }
  }
  return next;
}
