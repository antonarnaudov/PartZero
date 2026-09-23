import { doc, part, sketch, line, revolve, XZ } from "@aicad/std";

doc({ name: "knob", description: "Round knob: 25 mm dia, 12 tall, 6 mm bore 8 deep, 1.5 mm top chamfer" });

part("knob");
const profile = sketch(XZ, {
  bottom: line([3, 0], [12.5, 0]),
  side: line([12.5, 0], [12.5, 10.5]),
  chamfer: line([12.5, 10.5], [11, 12]),
  top: line([11, 12], [0, 12]),
  axis_cap: line([0, 12], [0, 8]),
  bore_end: line([0, 8], [3, 8]),
  bore_wall: line([3, 8], [3, 0]),
});
const knob = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });
