import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "corner_plate_2020", description: "L corner plate for 2020 extrusion: 60 mm legs, 20 wide, 4 thick, 5x M5 clearance" });

part("plate");
const outline = sketch(XY, {
  bottom: line([0, 0], [60, 0]),
  leg_x_end: line([60, 0], [60, 20]),
  inner_x: line([60, 20], [20, 20]),
  inner_y: line([20, 20], [20, 60]),
  leg_y_end: line([20, 60], [0, 60]),
  left: line([0, 60], [0, 0]),
  h_corner: circle({ center: [10, 10], radius: 2.75 }),
  h_x1: circle({ center: [30, 10], radius: 2.75 }),
  h_x2: circle({ center: [50, 10], radius: 2.75 }),
  h_y1: circle({ center: [10, 30], radius: 2.75 }),
  h_y2: circle({ center: [10, 50], radius: 2.75 }),
});
const plate = extrude(outline, { distance: 4 });
