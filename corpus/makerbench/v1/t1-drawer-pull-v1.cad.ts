import { doc, part, sketch, extrude, rect, fillet, edgesBetween, XY } from "@aicad/std";

doc({ name: "drawer_pull", description: "U-shaped drawer pull for 96 mm screw spacing: 106x25 profile, 12 wide, R8 outer top corners" });

part("pull");
// Side profile lying on the build plate (XY), extruded 12 mm up: one bar, the gap cut from below.
const barSk = sketch(XY, { bar: rect({ corner: [0, 0], w: 106, h: 25 }) });
const bar = extrude(barSk, { distance: 12 });
const gapSk = sketch(XY, { gap: rect({ corner: [10, 0], w: 86, h: 17 }) });
const gap = extrude(gapSk, { distance: 12, op: "cut", targets: bar });
const corners = fillet(edgesBetween(bar.side("bar.top"), bar.side("bar.left").and(bar.side("bar.right"))), { r: 8 });
