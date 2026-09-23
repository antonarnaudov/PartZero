import { doc, part, sketch, line, arc, extrude, XY } from "@aicad/std";

doc({ name: "split_shaft_collar", description: "Split clamp collar blank for an 8 mm shaft: 22 OD, 8.1 bore, 10 thick, 1.5 mm slit through one side" });

part("collar");
// The slit (|y| <= 0.75, x > 0) opens the ring, so the bore is part of one C-shaped outline.
// Slit corners: x = sqrt(11^2 - 0.75^2) on the outside, sqrt(4.05^2 - 0.75^2) on the bore.
const ring = sketch(XY, {
  outer: arc({ start: [10.974402033823985, 0.75], end: [10.974402033823985, -0.75], center: [0, 0], ccw: true }),
  slit_lower: line([10.974402033823985, -0.75], [3.97994974842648, -0.75]),
  bore: arc({ start: [3.97994974842648, -0.75], end: [3.97994974842648, 0.75], center: [0, 0], ccw: false }),
  slit_upper: line([3.97994974842648, 0.75], [10.974402033823985, 0.75]),
});
const collar = extrude(ring, { distance: 10 });
