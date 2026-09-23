import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "pegboard_plate", description: "Pegboard adapter plate: 90x65x4, 6x 7 mm holes on the 25.4 mm (1 in) grid, 4x M4 6 mm from the corners" });

part("plate");
const outline = sketch(XY, {
  bottom: line([-45, -32.5], [45, -32.5]),
  right: line([45, -32.5], [45, 32.5]),
  top: line([45, 32.5], [-45, 32.5]),
  left: line([-45, 32.5], [-45, -32.5]),
  // 1/4 in (6.35 mm) bolts: 7 mm holes on the pegboard's 1 in pitch, 3 x 2, centred.
  peg_1: circle({ center: [-25.4, -12.7], radius: 3.5 }),
  peg_2: circle({ center: [0, -12.7], radius: 3.5 }),
  peg_3: circle({ center: [25.4, -12.7], radius: 3.5 }),
  peg_4: circle({ center: [-25.4, 12.7], radius: 3.5 }),
  peg_5: circle({ center: [0, 12.7], radius: 3.5 }),
  peg_6: circle({ center: [25.4, 12.7], radius: 3.5 }),
  // M4 clearance (4.5 mm) for whatever gets mounted, 6 mm in from both edges.
  m4_ne: circle({ center: [39, 26.5], radius: 2.25 }),
  m4_nw: circle({ center: [-39, 26.5], radius: 2.25 }),
  m4_sw: circle({ center: [-39, -26.5], radius: 2.25 }),
  m4_se: circle({ center: [39, -26.5], radius: 2.25 }),
});
const plate = extrude(outline, { distance: 4 });
