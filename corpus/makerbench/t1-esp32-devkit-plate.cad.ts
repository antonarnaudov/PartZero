import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "esp32_devkit_plate", description: "ESP32 dev board carrier: 70x40x3, 4x M2.5 on the board's 47x23.5 pattern (centred), 4x M3 4 mm from the corners" });

part("plate");
const outline = sketch(XY, {
  bottom: line([-35, -20], [35, -20]),
  right: line([35, -20], [35, 20]),
  top: line([35, 20], [-35, 20]),
  left: line([-35, 20], [-35, -20]),
  // Board holes: M2.5 clearance (2.7 mm) on the measured 47 x 23.5 mm pattern.
  board_ne: circle({ center: [23.5, 11.75], radius: 1.35 }),
  board_nw: circle({ center: [-23.5, 11.75], radius: 1.35 }),
  board_sw: circle({ center: [-23.5, -11.75], radius: 1.35 }),
  board_se: circle({ center: [23.5, -11.75], radius: 1.35 }),
  // Enclosure screws: M3 clearance (3.4 mm), 4 mm in from both edges.
  m3_ne: circle({ center: [31, 16], radius: 1.7 }),
  m3_nw: circle({ center: [-31, 16], radius: 1.7 }),
  m3_sw: circle({ center: [-31, -16], radius: 1.7 }),
  m3_se: circle({ center: [31, -16], radius: 1.7 }),
});
const plate = extrude(outline, { distance: 3 });
