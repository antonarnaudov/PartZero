import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "sensor_mount_plate", description: "60x45x3 sensor board mount: 4x M3 clearance on a 38x24 pattern (centred), 8 mm cable hole at the left" });

part("plate");
const outline = sketch(XY, {
  bottom: line([-30, -22.5], [30, -22.5]),
  right: line([30, -22.5], [30, 22.5]),
  top: line([30, 22.5], [-30, 22.5]),
  left: line([-30, 22.5], [-30, -22.5]),
  m3_ne: circle({ center: [19, 12], radius: 1.7 }),
  m3_nw: circle({ center: [-19, 12], radius: 1.7 }),
  m3_sw: circle({ center: [-19, -12], radius: 1.7 }),
  m3_se: circle({ center: [19, -12], radius: 1.7 }),
  cable: circle({ center: [-22, 0], radius: 4 }),
});
const plate = extrude(outline, { distance: 3 });
