import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ } from "@aicad/std";

doc({ name: "extrude_two_regions", description: "Two disjoint regions produce two bodies; a ring (region with hole) and a disc" });

part("part");
const base = sketch(XY, {
  ring_outer: circle({ center: [0, 0], radius: 20 }),
  ring_inner: circle({ center: [0, 0], radius: 12 }),
  disc: circle({ center: [50, 0], radius: 8 }),
});
const pucks = extrude(base, { distance: 3, direction: "reverse" });
