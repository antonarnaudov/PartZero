import { doc, part, sketch, extrude, rect, hole, grid, XY } from "@aicad/std";

doc({ name: "sensor_plate", description: "90x60x8 plate with four M4 counterbored holes on a 70x40 grid" });

part("plate");
const outline = sketch(XY, { plate: rect({ center: [0, 0], w: 90, h: 60 }) });
const plate = extrude(outline, { distance: 8 });
const mounts = hole(plate.cap("end"), { at: grid({ nx: 2, ny: 2, dx: 70, dy: 40 }), size: "M4", depth: "through", cbore: "iso4762" });
