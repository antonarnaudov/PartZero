import { doc, part, sketch, line, arc, extrude, XY } from "@aicad/std";

doc({ name: "drawer_pull", description: "U-shaped drawer pull for 96 mm screw spacing: 106x25 profile, 12 wide, R8 outer corners" });

part("pull");
// Side profile lying on the build plate (XY), extruded 12 mm up.
const profile = sketch(XY, {
  foot_l: line([0, 0], [10, 0]),
  leg_l_in: line([10, 0], [10, 17]),
  grip_under: line([10, 17], [96, 17]),
  leg_r_in: line([96, 17], [96, 0]),
  foot_r: line([96, 0], [106, 0]),
  leg_r_out: line([106, 0], [106, 17]),
  round_r: arc({ start: [106, 17], end: [98, 25], center: [98, 17], ccw: true }),
  grip_top: line([98, 25], [8, 25]),
  round_l: arc({ start: [8, 25], end: [0, 17], center: [8, 17], ccw: true }),
  leg_l_out: line([0, 17], [0, 0]),
});
const pull = extrude(profile, { distance: 12 });
