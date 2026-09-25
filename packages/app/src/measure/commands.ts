/**
 * `measure.*` commands: open/close the Measure panel (I), measure the selection, or measure given
 * items without touching the selection. Read-only on the document; the agent may call
 * `measure.selection` and `measure.items`.
 */
import { z } from "zod";
import { defineCommand } from "../commands/registry";
import type { AppServices } from "../services";
import { SelectionItemSchema, toItem } from "../selection/commands";
import { viewportRuntime } from "../viewport/runtime";
import { formatMeasurement, measureSelection } from "./measure";

const command = defineCommand<AppServices>();
const NoArgs = z.strictObject({});

function withText<T extends { rows: Array<{ value: number; unit: "mm" | "mm²" | "mm³" | "°"; exact: boolean }> }>(r: T | null) {
  return r ? { ...r, rows: r.rows.map((m) => ({ ...m, text: formatMeasurement(m) })) } : null;
}

export const MEASURE_COMMANDS = {
  "measure.toggle": command({
    id: "measure.toggle",
    title: "Measure",
    category: "View",
    description: "Open or close the Measure panel: it measures whatever is selected (distance, angle, radius, area, length, volume).",
    args: z.strictObject({ open: z.boolean().optional() }),
    keys: ["I"],
    run({ open }, ctx) {
      const m = viewportRuntime(ctx).measure;
      const next = open ?? !m.getState().open;
      m.setOpen(next);
      return { open: next };
    },
  }),

  "measure.selection": command({
    id: "measure.selection",
    title: "Measure Selection",
    category: "View",
    description: "Read-only: measure the current selection. Exact values unless `exact: false` (then `text` starts with ≈).",
    args: NoArgs,
    palette: false,
    run(_args, ctx) {
      const r = viewportRuntime(ctx);
      return { result: withText(measureSelection(r.selection.items, r.topo, ctx.doc.getState().report)) };
    },
  }),

  "measure.items": command({
    id: "measure.items",
    title: "Measure Items",
    category: "View",
    description: "Read-only: measure the given items (as `selection.get` returns them) without changing the selection.",
    args: z.strictObject({ items: z.array(SelectionItemSchema).min(1).max(50) }),
    palette: false,
    run({ items }, ctx) {
      const r = viewportRuntime(ctx);
      return { result: withText(measureSelection(items.map(toItem), r.topo, ctx.doc.getState().report)) };
    },
  }),
};
