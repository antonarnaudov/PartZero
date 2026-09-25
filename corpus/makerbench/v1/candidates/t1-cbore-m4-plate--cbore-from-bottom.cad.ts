// expect: fail — counterbored from the bottom face although the prompt says from the top
import { doc, part, param, sketch, extrude, rect, hole, grid, XY } from "@aicad/std";

doc({ name: "cbore_m4_plate", description: "100x60x8 mounting plate with four M4 ISO 4762 counterbored holes on an 84x44 grid" });

const thick = param(8, { min: 5, note: "plate thickness" });

part("plate");
const outline = sketch(XY, { plate: rect({ center: [0, 0], w: 100, h: 60 }) });
const plate = extrude(outline, { distance: thick });
const mounts = hole(plate.cap("start"), { at: grid({ nx: 2, ny: 2, dx: 84, dy: 44 }), size: "M4", depth: "through", cbore: "iso4762" });
