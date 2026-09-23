import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";

doc({ name: "cell_spacer_18650_4s2p", description: "4S2P 18650 cell spacer: 88x46x5, 8x 18.6 mm holes on a 21 mm grid, centred" });

part("spacer");
const grid = sketch(XY, {
  bottom: line([-44, -23], [44, -23]),
  right: line([44, -23], [44, 23]),
  top: line([44, 23], [-44, 23]),
  left: line([-44, 23], [-44, -23]),
  // 18650 cells are 18.4 mm max; 18.6 mm holes, 21 mm pitch (2.4 mm walls between cells).
  c11: circle({ center: [-31.5, -10.5], radius: 9.3 }),
  c12: circle({ center: [-10.5, -10.5], radius: 9.3 }),
  c13: circle({ center: [10.5, -10.5], radius: 9.3 }),
  c14: circle({ center: [31.5, -10.5], radius: 9.3 }),
  c21: circle({ center: [-31.5, 10.5], radius: 9.3 }),
  c22: circle({ center: [-10.5, 10.5], radius: 9.3 }),
  c23: circle({ center: [10.5, 10.5], radius: 9.3 }),
  c24: circle({ center: [31.5, 10.5], radius: 9.3 }),
});
const spacer = extrude(grid, { distance: 5 });
