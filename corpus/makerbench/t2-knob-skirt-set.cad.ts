import { doc, part, sketch, line, arc, circle, revolve, extrude, XY, XZ } from "@aicad/std";

doc({ name: "knob_skirt_set", description: "Pot knob (20 dia x 16, 1 mm chamfer, 6 mm shaft hole 12 deep) and a separate 32 mm skirt with a 20.2 hole and a V pointer notch" });

part("knob");
// Half profile in XZ (u = radius, v = height), revolved about the Z axis.
const knob_profile = sketch(XZ, {
  bottom: line([3, 0], [10, 0]),
  side: line([10, 0], [10, 15]),
  chamfer: line([10, 15], [9, 16]),
  top: line([9, 16], [0, 16]),
  axis_cap: line([0, 16], [0, 12]),
  shaft_end: line([0, 12], [3, 12]),
  shaft_hole: line([3, 12], [3, 0]),
});
const knob = revolve(knob_profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });

part("skirt");
// Ø32 disc centred at X = 30; the V notch's corners sit on the rim at x = 30 ± 1 (y = √(16² − 1)).
const skirt_outline = sketch(XY, {
  rim: arc({ start: [29, 15.968719422671311], end: [31, 15.968719422671311], center: [30, 0], ccw: true }),
  notch_r: line([31, 15.968719422671311], [30, 14]),
  notch_l: line([30, 14], [29, 15.968719422671311]),
  // 20.2 mm: slides over the 20 mm knob.
  bore: circle({ center: [30, 0], radius: 10.1 }),
});
const skirt = extrude(skirt_outline, { distance: 2 });
