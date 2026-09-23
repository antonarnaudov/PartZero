import { doc, part, sketch, line, arc, circle, extrude, XZ, YZ } from "@aicad/std";

doc({ name: "wall_hook", description: "Wall hook: 30x60x4 back plate with two 4.5 mm screw holes, 10 mm wide J arm with an R8 outer corner" });

part("hook");
// Back plate in XZ, back face on y = 0; XZ's normal is -Y, so "reverse" grows it toward +Y.
const plate_outline = sketch(XZ, {
  bottom: line([-15, 0], [15, 0]),
  right: line([15, 0], [15, 60]),
  top: line([15, 60], [-15, 60]),
  left: line([-15, 60], [-15, 0]),
  screw_low: circle({ center: [0, 10], radius: 2.25 }),
  screw_high: circle({ center: [0, 50], radius: 2.25 }),
});
const plate = extrude(plate_outline, { distance: 4, direction: "reverse" });
// Arm side profile in YZ (u = y = distance from the wall, v = z), 10 mm wide centred on x = 0.
const arm_profile = sketch(YZ, {
  arm_bottom: line([4, 20], [30, 20]),
  corner: arc({ start: [30, 20], end: [38, 28], center: [30, 28], ccw: true }),
  lip_front: line([38, 28], [38, 36]),
  lip_top: line([38, 36], [30, 36]),
  lip_back: line([30, 36], [30, 28]),
  arm_top: line([30, 28], [4, 28]),
  arm_root: line([4, 28], [4, 20]),
});
const arm = extrude(arm_profile, { distance: 10, direction: "symmetric" });
