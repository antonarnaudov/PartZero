import { doc, part, sketch, line, revolve, XZ } from "@aicad/std";

doc({ name: "knob", description: "Round knob: 30 mm dia, 15 tall, 6 mm bore 10 deep from below, 2 mm top chamfer" });

part("knob");
const profile = sketch(XZ, {
  bottom: line([3, 0], [15, 0]),
  side: line([15, 0], [15, 13]),
  chamfer: line([15, 13], [13, 15]),
  top: line([13, 15], [0, 15]),
  axis_cap: line([0, 15], [0, 10]),
  bore_end: line([0, 10], [3, 10]),
  bore_wall: line([3, 10], [3, 0]),
});
const knob = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });
