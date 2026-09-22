import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ } from "@aicad/std";

doc({ name: "revolve_torus", description: "Circle r=4 at distance 15 revolved 360 -> torus" });

part("part");
const profile = sketch(XZ, {
  tube: circle({ center: [15, 0], radius: 4 }),
});
const donut = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });
