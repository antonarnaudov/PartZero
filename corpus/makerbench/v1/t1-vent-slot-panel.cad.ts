import { doc, part, param, sketch, extrude, rect, slot, linearPattern, XY, Y } from "@aicad/std";

doc({ name: "vent_slot_panel", description: "120x80x2 vent panel with a column of 40x4 slots every 8 mm, the first 12 mm above the bottom edge" });

const slots = param(8, { unit: "count", min: 1, note: "number of slots" });
const pitch = param(8, { note: "slot spacing" });

part("panel");
const outline = sketch(XY, { panel: rect({ center: [0, 0], w: 120, h: 80 }) });
const panel = extrude(outline, { distance: 2 });
const slotSk = sketch(XY, { vent: slot({ a: [-18, -28], b: [18, -28], w: 4 }) });
const firstSlot = extrude(slotSk, { distance: 2, op: "cut", targets: panel });
const vents = linearPattern([firstSlot], { dir: Y, count: slots, spacing: pitch });
