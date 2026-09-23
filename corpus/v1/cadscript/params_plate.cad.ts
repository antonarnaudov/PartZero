import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ, param, rect } from "@aicad/std";

doc({ name: "params_plate", description: "SPEC-v1 §2.10: a rounded plate driven by three parameters" });

const width = param(80);
const depth = param(50);
const thick = param(8, { min: 2 });

part("plate");
const base = sketch(XY, {
  outline: rect({ center: [0, 0], w: width, h: depth, r: 4 }),
});
const slab = extrude(base, { distance: thick });
