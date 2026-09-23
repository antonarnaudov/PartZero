import { doc, part, sketch, circle, extrude, XY } from "@aicad/std";

// Assumed: M3 hardware (most common hobby PCB screws), 10 mm tall, a set of four.
doc({ name: "pcb_spacers", description: "Assumed defaults: four round M3 spacers, 7 mm OD, 3.4 mm bore, 10 mm tall" });

part("spacers");
const rings = sketch(XY, {
  s1_outer: circle({ center: [0, 0], radius: 3.5 }),
  s1_bore: circle({ center: [0, 0], radius: 1.7 }),
  s2_outer: circle({ center: [12, 0], radius: 3.5 }),
  s2_bore: circle({ center: [12, 0], radius: 1.7 }),
  s3_outer: circle({ center: [24, 0], radius: 3.5 }),
  s3_bore: circle({ center: [24, 0], radius: 1.7 }),
  s4_outer: circle({ center: [36, 0], radius: 3.5 }),
  s4_bore: circle({ center: [36, 0], radius: 1.7 }),
});
const spacers = extrude(rings, { distance: 10 });
