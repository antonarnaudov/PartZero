import { doc, part, sketch, line, revolve, XZ } from "@aicad/std";

doc({ name: "m5_spacer", description: "Round spacer for M5: 10 mm OD, 5.3 mm bore, 15 mm long" });

part("spacer");
// Half cross-section in XZ (u = radius, v = height), revolved about the Z axis.
const profile = sketch(XZ, {
  bottom: line([2.65, 0], [5, 0]),
  outer: line([5, 0], [5, 15]),
  top: line([5, 15], [2.65, 15]),
  bore: line([2.65, 15], [2.65, 0]),
});
const spacer = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });
