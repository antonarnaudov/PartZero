/**
 * `selection.*` commands over the selection model: set/add/toggle/remove items, the kind filter
 * (keys 1–5), box selection, and the read-only `selection.get` the agent uses (items with
 * semantic labels). The document's single selection (`selection.selectEntity`, `selection.clear`)
 * stays in the app registry; the primary item is mirrored into it.
 */
import { z } from "zod";
import { defineCommand } from "../commands/registry";
import type { AppServices } from "../services";
import { viewportRuntime } from "../viewport/runtime";
import { labelOf } from "./labels";
import { ORIGIN_IDS, SELECTION_KINDS, type SelectionItem } from "./types";

const command = defineCommand<AppServices>();
const NoArgs = z.strictObject({});
const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const SelectionItemSchema = z.union([
  z.strictObject({ kind: z.literal("face"), body: z.string().min(1), key: z.string().min(1), point: Vec3Schema.optional() }),
  z.strictObject({ kind: z.literal("edge"), body: z.string().min(1), key: z.string().min(1), point: Vec3Schema.optional() }),
  z.strictObject({ kind: z.literal("vertex"), body: z.string().min(1), key: z.string().min(1), point: Vec3Schema.optional() }),
  z.strictObject({ kind: z.literal("body"), body: z.string().min(1) }),
  z.strictObject({ kind: z.literal("sketch"), feature: z.string().min(1) }),
  z.strictObject({ kind: z.literal("datum"), feature: z.string().min(1) }),
  z.strictObject({ kind: z.literal("origin"), id: z.enum(ORIGIN_IDS) }),
]);

type ParsedItem = z.output<typeof SelectionItemSchema>;

/** zod output → the model type (drops `point: undefined`, which exact optional types forbid). */
export function toItem(p: ParsedItem): SelectionItem {
  if ((p.kind === "face" || p.kind === "edge" || p.kind === "vertex") && p.point === undefined) return { kind: p.kind, body: p.body, key: p.key };
  return p as SelectionItem;
}

function rt(ctx: AppServices) {
  return viewportRuntime(ctx);
}

/** Refuse items that do not exist in the displayed scene (never select something invisible by mistake). */
function checked(ctx: AppServices, items: readonly ParsedItem[]): SelectionItem[] {
  const topo = rt(ctx).topo;
  const out: SelectionItem[] = [];
  for (const p of items) {
    const it = toItem(p);
    if (it.kind === "face" || it.kind === "edge" || it.kind === "vertex" || it.kind === "body") {
      const b = topo.bodies.get(it.body);
      if (!b) throw new Error(`no body ${it.body}`);
      if (it.kind === "face" && !b.faces.has(it.key)) throw new Error(`no face ${it.key} on ${it.body}`);
      if (it.kind === "edge" && !b.edges.has(it.key)) throw new Error(`no edge ${it.key} on ${it.body}`);
      if (it.kind === "vertex") {
        const v = b.vertices.get(it.key);
        if (!v) throw new Error(`no vertex ${it.key} on ${it.body}`);
        out.push({ ...it, point: v.point });
        continue;
      }
    }
    out.push(it);
  }
  return out;
}

function describe(ctx: AppServices) {
  const r = rt(ctx);
  const ir = ctx.doc.getState().model?.ir;
  return r.selection.items.map((it) => ({ ...it, label: labelOf(it, ir) }));
}

const FilterSchema = z.strictObject(Object.fromEntries(SELECTION_KINDS.map((k) => [k, z.boolean().optional()])) as Record<(typeof SELECTION_KINDS)[number], z.ZodOptional<z.ZodBoolean>>);

export const SELECTION_COMMANDS = {
  "selection.get": command({
    id: "selection.get",
    title: "Get Selection",
    category: "Selection",
    description: "Read-only: the selected items (faces, edges and vertices by provenance name with a probe point, bodies, sketches, datums) with human labels, the primary first, and the kind filter.",
    args: NoArgs,
    palette: false,
    run(_args, ctx) {
      return { items: describe(ctx), filter: rt(ctx).selection.getState().filter, revision: rt(ctx).selection.getState().revision };
    },
  }),

  "selection.set": command({
    id: "selection.set",
    title: "Set Selection",
    category: "Selection",
    description: "Replace the selection with these items (validated against the displayed model).",
    args: z.strictObject({ items: z.array(SelectionItemSchema).max(5000) }),
    palette: false,
    run({ items }, ctx) {
      rt(ctx).selectItems(checked(ctx, items));
      return { items: describe(ctx) };
    },
  }),

  "selection.add": command({
    id: "selection.add",
    title: "Add to Selection",
    category: "Selection",
    args: z.strictObject({ items: z.array(SelectionItemSchema).min(1).max(5000) }),
    palette: false,
    run({ items }, ctx) {
      rt(ctx).selection.add(checked(ctx, items));
      rt(ctx).syncDocSelection();
      return { items: describe(ctx) };
    },
  }),

  "selection.toggle": command({
    id: "selection.toggle",
    title: "Toggle in Selection",
    category: "Selection",
    args: z.strictObject({ item: SelectionItemSchema }),
    palette: false,
    run({ item }, ctx) {
      const [it] = checked(ctx, [item]);
      const added = rt(ctx).selection.toggle(it!);
      rt(ctx).syncDocSelection();
      return { added, items: describe(ctx) };
    },
  }),

  "selection.remove": command({
    id: "selection.remove",
    title: "Remove from Selection",
    category: "Selection",
    args: z.strictObject({ items: z.array(SelectionItemSchema).min(1) }),
    palette: false,
    run({ items }, ctx) {
      rt(ctx).selection.remove(items.map(toItem));
      rt(ctx).syncDocSelection();
      return { items: describe(ctx) };
    },
  }),

  "selection.setFilter": command({
    id: "selection.setFilter",
    title: "Selection Filter",
    category: "Selection",
    description: "Which kinds a click or a box selects: vertex, edge, face, body, sketch (datum and origin too). Items the filter excludes are deselected.",
    args: FilterSchema,
    palette: false,
    run(args, ctx) {
      const patch = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)) as Partial<Record<(typeof SELECTION_KINDS)[number], boolean>>;
      return { filter: rt(ctx).selection.setFilter(patch) };
    },
  }),

  "selection.filterOnly": command({
    id: "selection.filterOnly",
    title: "Select Only…",
    category: "Selection",
    description: "Restrict picking to one kind (keys 1 vertex, 2 edge, 3 face, 4 body, 5 sketch; 0 everything).",
    args: z.strictObject({ kind: z.enum(["vertex", "edge", "face", "body", "sketch", "all"]) }),
    palette: [
      { title: "Select Only: Vertices", args: { kind: "vertex" } },
      { title: "Select Only: Edges", args: { kind: "edge" } },
      { title: "Select Only: Faces", args: { kind: "face" } },
      { title: "Select Only: Bodies", args: { kind: "body" } },
      { title: "Select Only: Sketches", args: { kind: "sketch" } },
      { title: "Select: Everything", args: { kind: "all" } },
    ],
    run({ kind }, ctx) {
      return { filter: rt(ctx).selection.solo(kind) };
    },
  }),

  "selection.filterVertex": command({ id: "selection.filterVertex", title: "Select Only Vertices", category: "Selection", args: NoArgs, keys: ["1"], palette: false, run: (_a, ctx) => ({ filter: rt(ctx).selection.solo("vertex") }) }),
  "selection.filterEdge": command({ id: "selection.filterEdge", title: "Select Only Edges", category: "Selection", args: NoArgs, keys: ["2"], palette: false, run: (_a, ctx) => ({ filter: rt(ctx).selection.solo("edge") }) }),
  "selection.filterFace": command({ id: "selection.filterFace", title: "Select Only Faces", category: "Selection", args: NoArgs, keys: ["3"], palette: false, run: (_a, ctx) => ({ filter: rt(ctx).selection.solo("face") }) }),
  "selection.filterBody": command({ id: "selection.filterBody", title: "Select Only Bodies", category: "Selection", args: NoArgs, keys: ["4"], palette: false, run: (_a, ctx) => ({ filter: rt(ctx).selection.solo("body") }) }),
  "selection.filterSketch": command({ id: "selection.filterSketch", title: "Select Only Sketches", category: "Selection", args: NoArgs, keys: ["5"], palette: false, run: (_a, ctx) => ({ filter: rt(ctx).selection.solo("sketch") }) }),
  "selection.filterAll": command({ id: "selection.filterAll", title: "Select Everything", category: "Selection", args: NoArgs, keys: ["0"], palette: false, run: (_a, ctx) => ({ filter: rt(ctx).selection.solo("all") }) }),

  "selection.box": command({
    id: "selection.box",
    title: "Box Select",
    category: "Selection",
    description: "Select by rectangle in viewport CSS pixels: window (entirely inside) or crossing (touching). One kind per box: faces if the filter allows, else edges, vertices, bodies. Visible entities only unless includeHidden.",
    args: z.strictObject({
      rect: z.strictObject({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }),
      mode: z.enum(["window", "crossing"]).optional(),
      additive: z.boolean().optional(),
      includeHidden: z.boolean().optional(),
    }),
    palette: false,
    run({ rect, mode, additive, includeHidden }, ctx) {
      const r = rt(ctx);
      if (!r.adapter) throw new Error("the viewport is not ready");
      const opts: { mode?: "window" | "crossing"; additive?: boolean; includeHidden?: boolean } = {};
      if (mode) opts.mode = mode;
      if (additive) opts.additive = true;
      if (includeHidden) opts.includeHidden = true;
      const picked = r.boxSelect(rect, opts);
      return { picked: picked.length, items: describe(ctx) };
    },
  }),

  "selection.selectAll": command({
    id: "selection.selectAll",
    title: "Select All",
    category: "Selection",
    description: "Select every visible entity of the filter's box kind (faces, else edges, vertices, bodies).",
    args: NoArgs,
    keys: ["Mod+A"],
    run(_args, ctx) {
      const r = rt(ctx);
      const f = r.selection.getState().filter;
      const hidden = r.view.hiddenBodies();
      const items: SelectionItem[] = [];
      for (const b of r.topo.bodies.values()) {
        if (hidden.has(b.name)) continue;
        if (f.face) for (const k of b.faces.keys()) items.push({ kind: "face", body: b.name, key: k });
        else if (f.edge) for (const k of b.edges.keys()) items.push({ kind: "edge", body: b.name, key: k });
        else if (f.vertex) for (const v of b.vertices.values()) items.push({ kind: "vertex", body: b.name, key: v.key, point: v.point });
        else if (f.body) items.push({ kind: "body", body: b.name });
      }
      r.selectItems(items);
      return { selected: items.length };
    },
  }),
};
