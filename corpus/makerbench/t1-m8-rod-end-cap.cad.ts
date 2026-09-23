import { doc, part, sketch, line, arc, revolve, XZ } from "@aicad/std";

doc({ name: "m8_rod_end_cap", description: "Domed cap for an M8 threaded rod end: 14 mm dia, 10 mm straight + R7 dome, 8.4 mm bore 12 deep" });

part("cap");
// Half profile in XZ (u = radius, v = height), revolved about the Z axis.
const profile = sketch(XZ, {
  bottom: line([4.2, 0], [7, 0]),
  side: line([7, 0], [7, 10]),
  dome: arc({ start: [7, 10], end: [0, 17], center: [0, 10], ccw: true }),
  axis_cap: line([0, 17], [0, 12]),
  bore_end: line([0, 12], [4.2, 12]),
  bore: line([4.2, 12], [4.2, 0]),
});
const cap = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });
