import { doc, part, sketch, line, arc, revolve, XZ } from "@aicad/std";

doc({ name: "tube_end_plug", description: "End plug for 25x1.5 round tube: 21.8x10 spigot, 25x3 cap, 3 mm spherical dome" });

part("plug");
// Dome: sphere through (12.5, 13) and the apex (0, 16) with its centre on the axis:
// 12.5^2 + (13 - c)^2 = (16 - c)^2  =>  c = -69.25 / 6.
const profile = sketch(XZ, {
  bottom: line([0, 0], [10.9, 0]),
  spigot: line([10.9, 0], [10.9, 10]),
  shoulder: line([10.9, 10], [12.5, 10]),
  cap_edge: line([12.5, 10], [12.5, 13]),
  dome: arc({ start: [12.5, 13], end: [0, 16], center: [0, -11.541666666666666], ccw: true }),
  axis_edge: line([0, 16], [0, 0]),
});
const plug = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });
