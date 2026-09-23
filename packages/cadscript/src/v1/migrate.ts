/**
 * `migrate_v0_to_v1` (SPEC-v1 §9.1 [D-59], [W0-12]) — a port of `forge_ir::v1::migrate`. Pure,
 * total and deterministic; its canonical JSON (`toJson`) is byte-identical to Rust's and
 * Python's (checked against `corpus/v1/conformance/migration/`).
 *
 * CadScript uses it to print a v0 document (SPEC-v1 §9.1: "printing a v0 IR prints its
 * migration") and to compile v0 sources into v1 documents.
 */
import type { IrDocument as V0Document, Feature as V0Feature, PartStudio as V0Part } from "@aicad/ir-types";
import { v1 } from "@aicad/ir-types";
import { isId, sanitize, unique } from "./ids.js";

export type RenameKind = "part_id" | "part_name" | "feature_id" | "feature_name" | "curve_id";

/** One id or name that migration rewrote. `from` is the original string: untrusted data. */
export interface IdRename {
  path: string;
  kind: RenameKind;
  from: string;
  to: string;
}

export interface MigrationReport {
  renames: IdRename[];
}

/** New values for the ids of one namespace, in input order (`undefined` = unchanged). */
function assign(items: readonly string[]): (string | undefined)[] {
  const taken = new Set(items.filter(isId));
  return items.map((s) => {
    if (isId(s)) return undefined;
    const fresh = unique(sanitize(s), taken);
    taken.add(fresh);
    return fresh;
  });
}

/** Is this an `aicad.ir/0` document (by its `schema` field)? */
export function isV0Document(doc: { schema?: unknown }): boolean {
  return doc.schema === "aicad.ir/0";
}

/** Migrate an `aicad.ir/0` document to `aicad.ir/1`. */
export function migrateV0ToV1(doc: V0Document): v1.IrDocument {
  return migrateV0ToV1Report(doc).doc;
}

/** {@link migrateV0ToV1}, also returning the ids and names it rewrote. */
export function migrateV0ToV1Report(doc: V0Document): { doc: v1.IrDocument; report: MigrationReport } {
  const renames: IdRename[] = [];
  const partIds = assign(doc.parts.map((p) => p.id));
  const partNames = assign(doc.parts.map((p) => p.name));
  const all = doc.parts.flatMap((p) => p.features);
  const featureIds = assign(all.map((f) => f.id));
  const featureNames = assign(all.map((f) => f.name));
  let k = 0;
  const rename = (path: string, kind: RenameKind, from: string, to: string | undefined): string => {
    if (to === undefined) return from;
    renames.push({ path, kind, from, to });
    return to;
  };
  const parts: v1.PartStudio[] = doc.parts.map((p, pi) => {
    const pp = `/parts/${pi}`;
    const id = rename(`${pp}/id`, "part_id", p.id, partIds[pi]);
    const name = rename(`${pp}/name`, "part_name", p.name, partNames[pi]);
    const fids = p.features.map((f, fi) => {
      const fp = `${pp}/features/${fi}`;
      const newId = rename(`${fp}/id`, "feature_id", f.id, featureIds[k]);
      const newName = rename(`${fp}/name`, "feature_name", f.name, featureNames[k]);
      k++;
      let curves: string[] = [];
      if (f.type === "sketch") {
        const fresh = assign(f.curves.map((c) => c.id));
        curves = f.curves.map((c, ci) => rename(`${fp}/curves/${ci}/id`, "curve_id", c.id, fresh[ci]));
      }
      return { id: newId, name: newName, curves };
    });
    return migratePart(p, id, name, fids);
  });
  const out: v1.IrDocument = { schema: v1.IR_SCHEMA, parts } as v1.IrDocument;
  const meta: v1.Meta = {};
  if (doc.meta?.name) meta.name = doc.meta.name;
  if (doc.meta?.description) meta.description = doc.meta.description;
  const ordered: Record<string, unknown> = { schema: v1.IR_SCHEMA };
  if (Object.keys(meta).length > 0) ordered["meta"] = meta;
  if (doc.units && (doc.units.length !== "mm" || doc.units.angle !== "deg")) ordered["units"] = { ...doc.units };
  ordered["parts"] = out.parts;
  return { doc: ordered as unknown as v1.IrDocument, report: { renames } };
}

function migratePart(p: V0Part, id: string, name: string, ids: { id: string; name: string; curves: string[] }[]): v1.PartStudio {
  // v0 references sketches by name; the v1 reference is the (possibly rewritten) sketch id.
  const sketchIds = new Map<string, string>();
  const features: v1.Feature[] = p.features.map((f: V0Feature, fi) => {
    const { id: fid, name: fname, curves } = ids[fi]!;
    const resolve = (n: string): string => sketchIds.get(n) ?? n;
    let out: v1.Feature;
    switch (f.type) {
      case "sketch": {
        const s: Record<string, unknown> = { type: "sketch", id: fid, name: fname };
        if (f.suppressed) s["suppressed"] = true;
        s["plane"] = typeof f.plane === "string" ? f.plane : { origin: [...f.plane.origin], normal: [...f.plane.normal], x_dir: [...f.plane.x_dir] };
        s["curves"] = f.curves.map((c, ci) => {
          const cid = curves[ci]!;
          switch (c.kind) {
            case "line":
              return { kind: "line", id: cid, start: [...c.start], end: [...c.end] };
            case "arc":
              return { kind: "arc", id: cid, start: [...c.start], end: [...c.end], center: [...c.center], ccw: c.ccw };
            default:
              return { kind: "circle", id: cid, center: [...c.center], radius: c.radius };
          }
        });
        out = s as unknown as v1.Feature;
        sketchIds.set(f.name, fid);
        break;
      }
      case "extrude": {
        const e: Record<string, unknown> = { type: "extrude", id: fid, name: fname };
        if (f.suppressed) e["suppressed"] = true;
        e["sketch"] = resolve(f.sketch);
        e["distance"] = f.distance;
        if (f.direction !== undefined && f.direction !== "normal") e["direction"] = f.direction;
        out = e as unknown as v1.Feature;
        break;
      }
      default: {
        const r: Record<string, unknown> = { type: "revolve", id: fid, name: fname };
        if (f.suppressed) r["suppressed"] = true;
        r["sketch"] = resolve(f.sketch);
        r["axis"] = { origin: [...f.axis.origin], direction: [...f.axis.direction] };
        r["angle"] = f.angle;
        if (f.direction !== undefined && f.direction !== "normal") r["direction"] = f.direction;
        out = r as unknown as v1.Feature;
        break;
      }
    }
    return out;
  });
  return { id, name, features } as v1.PartStudio;
}
