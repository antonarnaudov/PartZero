/**
 * IR v1 mutations for {@link MutantSolver} on tasks that require `ir/1`: each one models a
 * typical agent mistake with the Phase C operations, and the hidden tests of every applicable
 * task must catch it. A mutation returns null when it does not apply (the document has no such
 * feature, or changing it would break a feature that depends on it, which is a different mistake).
 *
 * - `scale`: every length ×1.1 (wrong units or a misread dimension): literal `mm` parameters,
 *   bounds included, and every literal length in the features — sketch geometry and length
 *   dimensions, plane and axis origins, sweep distances, hole diameters, depths and positions,
 *   blend sizes, shell thickness, pattern spacings, datum offsets. Expressions scale through the
 *   parameters they name (a literal inside an expression does not), so a model driven by
 *   parameters scales like one written with literals.
 * - `drop_hole`: the last hole feature loses one position (the last listed point, a grid column or
 *   row, a bolt-circle hole; a count that is an expression `n` becomes `(n) - 1`); a
 *   single-position hole is suppressed instead.
 * - `hole_size`: every hole one size up (`M3` → `M4`, `M8` → `M6`), or an explicit `d` ×1.1
 *   (wrong clearance).
 * - `drop_blend`: the last fillet or chamfer suppressed (the edge treatment was forgotten).
 * - `blend_size`: the last fillet radius or chamfer distance halved.
 * - `shell_thickness`: the last shell's wall thickness halved.
 * - `pattern_count`: the last linear or circular pattern gets one instance fewer (count ≥ 3), or
 *   the last mirror is suppressed.
 * - `hole_flip`: the right holes drilled from the wrong face — every hole placed on an extrude's
 *   cap whose side matters (counterbore, countersink, insert, blind or `up_to` depth) moves to
 *   the opposite cap (the most common agent mistake: counterbores on the bottom). Same positions
 *   in the new face's frame (§3.1), so symmetric layouts land on the same axes.
 */
import type { v1 as irv1 } from "@aicad/ir-types";

export const MUTATIONS_V1 = ["scale", "drop_hole", "hole_size", "drop_blend", "blend_size", "shell_thickness", "pattern_count", "hole_flip"] as const;
export type MutationKindV1 = (typeof MUTATIONS_V1)[number];

export function isMutationKindV1(s: string): s is MutationKindV1 {
  return (MUTATIONS_V1 as readonly string[]).includes(s);
}

type Doc = irv1.IrDocument;
type Obj = Record<string, unknown>;

const SCALE = 1.1;
const SIZES = ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8"] as const;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `k · v` for a Scalar: a literal is multiplied, an expression wrapped (`k * (e)`). */
function scaleScalar(v: unknown, k: number): unknown {
  if (typeof v === "number") return v * k;
  if (typeof v === "string") return `${k} * (${v})`;
  return v;
}

/** Every feature of the document with its part index, in timeline order. */
function features(doc: Doc): { part: number; index: number; f: Obj }[] {
  const out: { part: number; index: number; f: Obj }[] = [];
  doc.parts.forEach((p, pi) => (p.features as unknown as Obj[]).forEach((f, index) => out.push({ part: pi, index, f })));
  return out;
}

function suppressed(f: Obj): boolean {
  return f["suppressed"] === true;
}

/** True when a later feature of the part mentions `id` (a sketch, seed, datum, tag or query naming it). */
function hasDependents(doc: Doc, part: number, index: number, id: string): boolean {
  const later = (doc.parts[part]!.features as unknown as Obj[]).slice(index + 1);
  const needle = JSON.stringify(id);
  return later.some((f) => JSON.stringify(f).includes(needle));
}

/** The last non-suppressed feature of one of `types`. */
function lastOf(doc: Doc, types: readonly string[]): { part: number; index: number; f: Obj } | undefined {
  return features(doc)
    .filter((x) => types.includes(String(x.f["type"])) && !suppressed(x.f))
    .at(-1);
}

function suppressIfFree(doc: Doc, hit: { part: number; index: number; f: Obj } | undefined): Doc | null {
  if (!hit || hasDependents(doc, hit.part, hit.index, String(hit.f["id"]))) return null;
  hit.f["suppressed"] = true;
  return doc;
}

/** Scale the literal lengths of the document by `k` (parameters and features); true if any changed. */
function scaleLengths(doc: Doc, k: number): boolean {
  let changed = false;
  const lists = [doc.params ?? [], ...doc.parts.map((p) => p.params ?? [])];
  for (const p of lists.flat() as unknown as Obj[]) {
    if (p["unit"] !== "mm" || typeof p["value"] !== "number") continue;
    p["value"] = (p["value"] as number) * k;
    for (const b of ["min", "max"]) if (typeof p[b] === "number") p[b] = (p[b] as number) * k;
    changed = true;
  }
  /** Scale `o[f]` when it is a literal number. */
  const num = (o: unknown, f: string | number) => {
    if (!isObj(o) && !Array.isArray(o)) return;
    const c = o as Record<string | number, unknown>;
    if (typeof c[f] === "number") {
      c[f] = (c[f] as number) * k;
      changed = true;
    }
  };
  const vec = (v: unknown) => {
    if (Array.isArray(v)) v.forEach((_, i) => num(v, i));
  };
  const plane = (pl: unknown) => {
    if (isObj(pl) && !("datum" in pl)) vec(pl["origin"]);
  };
  const axis = (a: unknown) => {
    if (isObj(a) && isObj(a["line"])) vec(a["line"]["origin"]);
  };
  for (const { f } of features(doc)) {
    switch (f["type"]) {
      case "sketch": {
        plane(f["plane"]);
        for (const c of (f["curves"] as Obj[] | undefined) ?? []) {
          for (const key of ["start", "end", "center", "at", "corner", "a", "b"]) vec(c[key]);
          for (const key of ["radius", "w", "h", "r", "circumradius", "inradius", "across_flats", "side"]) num(c, key);
        }
        for (const c of (f["constraints"] as Obj[] | undefined) ?? []) {
          if (c["type"] === "distance" || c["type"] === "radius" || c["type"] === "diameter") num(c, "value");
          if (c["type"] === "fix") for (const key of ["x", "y"]) num(c, key);
        }
        break;
      }
      case "extrude":
        num(f, "distance");
        break;
      case "revolve":
        if (isObj(f["axis"])) vec(f["axis"]["origin"]);
        break;
      case "hole": {
        plane(f["on"]);
        num(f, "d");
        if (isObj(f["depth"])) num(f["depth"], "blind");
        for (const key of ["cbore", "insert"]) if (isObj(f[key])) for (const d of ["d", "depth"]) num(f[key], d);
        if (isObj(f["csink"])) num(f["csink"], "d");
        if (isObj(f["thread"])) num(f["thread"], "depth");
        const at = f["at"];
        if (isObj(at)) {
          for (const p of (at["list"] as Obj[] | undefined) ?? []) vec(p["at"]);
          if (isObj(at["grid"])) {
            num(at["grid"], "dx");
            num(at["grid"], "dy");
            vec(at["grid"]["center"]);
          }
          if (isObj(at["circle"])) {
            num(at["circle"], "d");
            vec(at["circle"]["center"]);
          }
        }
        break;
      }
      case "fillet":
        num(f, "r");
        break;
      case "chamfer":
        num(f, "d");
        num(f, "d2");
        break;
      case "shell":
        num(f, "thickness");
        break;
      case "pattern": {
        const layout = f["layout"];
        if (!isObj(layout)) break;
        if (isObj(layout["linear"])) {
          num(layout["linear"], "spacing");
          num(layout["linear"], "spacing2");
          axis(layout["linear"]["dir"]);
          axis(layout["linear"]["dir2"]);
        }
        if (isObj(layout["circular"])) axis(layout["circular"]["axis"]);
        if (isObj(layout["mirror"])) plane(layout["mirror"]["plane"]);
        break;
      }
      case "datum_plane":
        num(f, "distance");
        vec(f["origin"]);
        for (const p of (f["points"] as unknown[] | undefined) ?? []) vec(p);
        break;
      case "datum_axis":
        for (const p of (f["points"] as unknown[] | undefined) ?? []) vec(p);
        break;
    }
  }
  return changed;
}

function scaleDoc(doc: Doc): Doc | null {
  return scaleLengths(doc, SCALE) ? doc : null;
}

/** A hole's side matters when it has a counterbore, countersink or insert, or is not through. */
function sideMatters(f: Obj): boolean {
  return f["cbore"] !== undefined || f["csink"] !== undefined || f["insert"] !== undefined || (f["depth"] !== undefined && f["depth"] !== "through");
}

function flipHoles(doc: Doc): Doc | null {
  let changed = false;
  for (const { f } of features(doc)) {
    if (f["type"] !== "hole" || suppressed(f) || !sideMatters(f)) continue;
    const on = f["on"];
    const face = isObj(on) ? on["face"] : undefined;
    const q = isObj(face) ? face["q"] : undefined;
    if (!isObj(q) || q["op"] !== "cap" || (q["end"] !== "start" && q["end"] !== "end")) continue;
    q["end"] = q["end"] === "start" ? "end" : "start";
    if (isObj(face) && "capture" in face) delete face["capture"];
    changed = true;
  }
  return changed ? doc : null;
}

function dropHolePosition(doc: Doc): Doc | null {
  const hit = lastOf(doc, ["hole"]);
  if (!hit) return null;
  const at = hit.f["at"];
  if (!isObj(at)) return null;
  if (Array.isArray(at["list"]) && at["list"].length > 1) {
    at["list"] = at["list"].slice(0, -1);
    return doc;
  }
  if (isObj(at["points"]) && Array.isArray(at["points"]["ids"]) && at["points"]["ids"].length > 1) {
    at["points"]["ids"] = (at["points"]["ids"] as unknown[]).slice(0, -1);
    return doc;
  }
  if (isObj(at["grid"])) {
    const g = at["grid"];
    const [nx, ny] = [g["nx"], g["ny"]];
    if (typeof nx === "string") {
      g["nx"] = `(${nx}) - 1`;
      return doc;
    }
    if (typeof nx === "number" && nx > 1 && (typeof ny !== "number" || nx >= ny)) {
      g["nx"] = nx - 1;
      return doc;
    }
    if (typeof ny === "number" && ny > 1) {
      g["ny"] = ny - 1;
      return doc;
    }
  }
  if (isObj(at["circle"])) {
    const n = at["circle"]["n"];
    if (typeof n === "string") {
      at["circle"]["n"] = `(${n}) - 1`;
      return doc;
    }
    if (typeof n === "number" && n > 1) {
      at["circle"]["n"] = n - 1;
      return doc;
    }
  }
  return suppressIfFree(doc, hit);
}

function growHoles(doc: Doc): Doc | null {
  let changed = false;
  for (const { f } of features(doc)) {
    if (f["type"] !== "hole" || suppressed(f)) continue;
    if (f["d"] !== undefined) {
      f["d"] = scaleScalar(f["d"], SCALE);
      changed = true;
    } else if (typeof f["size"] === "string") {
      const i = SIZES.indexOf(f["size"] as (typeof SIZES)[number]);
      if (i < 0) continue;
      f["size"] = i === SIZES.length - 1 ? SIZES[i - 1] : SIZES[i + 1];
      changed = true;
    }
  }
  return changed ? doc : null;
}

function halveBlend(doc: Doc): Doc | null {
  const hit = lastOf(doc, ["fillet", "chamfer"]);
  if (!hit) return null;
  const field = hit.f["type"] === "fillet" ? "r" : "d";
  hit.f[field] = scaleScalar(hit.f[field], 0.5);
  if (hit.f["type"] === "chamfer" && hit.f["d2"] !== undefined) hit.f["d2"] = scaleScalar(hit.f["d2"], 0.5);
  return doc;
}

function halveShell(doc: Doc): Doc | null {
  const hit = lastOf(doc, ["shell"]);
  if (!hit) return null;
  hit.f["thickness"] = scaleScalar(hit.f["thickness"], 0.5);
  return doc;
}

function fewerInstances(doc: Doc): Doc | null {
  const hit = lastOf(doc, ["pattern"]);
  if (!hit) return null;
  const layout = hit.f["layout"];
  if (!isObj(layout)) return null;
  const l = isObj(layout["linear"]) ? layout["linear"] : isObj(layout["circular"]) ? layout["circular"] : null;
  if (!l) return suppressIfFree(doc, hit);
  const n = l["count"];
  if (typeof n === "number") {
    if (n < 3) return null;
    l["count"] = n - 1;
  } else if (typeof n === "string") {
    l["count"] = `(${n}) - 1`;
  } else {
    return null;
  }
  // A skip entry beyond the new count would be rejected: drop them (the mistake is the count).
  if (Array.isArray(hit.f["skip"])) {
    const max = typeof l["count"] === "number" ? l["count"] : Infinity;
    const kept = (hit.f["skip"] as number[][]).filter((i) => (i[0] ?? 0) < max);
    if (kept.length > 0) hit.f["skip"] = kept;
    else delete hit.f["skip"];
  }
  return doc;
}

/** Apply a mutation to a copy of `doc`; null when it does not apply. Never touches the input. */
export function mutateIrV1(doc: Doc, kind: MutationKindV1): Doc | null {
  const out = structuredClone(doc);
  switch (kind) {
    case "scale":
      return scaleDoc(out);
    case "drop_hole":
      return dropHolePosition(out);
    case "hole_size":
      return growHoles(out);
    case "drop_blend":
      return suppressIfFree(out, lastOf(out, ["fillet", "chamfer"]));
    case "blend_size":
      return halveBlend(out);
    case "shell_thickness":
      return halveShell(out);
    case "pattern_count":
      return fewerInstances(out);
    case "hole_flip":
      return flipHoles(out);
  }
}
