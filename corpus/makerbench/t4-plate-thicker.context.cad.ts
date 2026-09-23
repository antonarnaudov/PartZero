import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "sensor_mount", description: "60x40x5 sensor mount: 12 mm sensor hole, two M4 clearance holes 44 mm apart" });

part("mount");
const outline = sketch(XY, {
  bottom: line([-30, -20], [30, -20]),
  right: line([30, -20], [30, 20]),
  top: line([30, 20], [-30, 20]),
  left: line([-30, 20], [-30, -20]),
  sensor: circle({ center: [0, 0], radius: 6 }),
  m4_l: circle({ center: [-22, 0], radius: 2.2 }),
  m4_r: circle({ center: [22, 0], radius: 2.2 }),
});
const plate = extrude(outline, { distance: 5 });
