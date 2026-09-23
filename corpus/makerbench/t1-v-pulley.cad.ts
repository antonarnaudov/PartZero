import { doc, part, sketch, line, revolve, XZ } from "@aicad/std";

doc({ name: "v_pulley", description: "V-groove pulley: 40 mm dia, 10 thick, 8 mm bore, 90-degree groove 4 mm deep" });

part("pulley");
const profile = sketch(XZ, {
  bottom: line([4, 0], [20, 0]),
  rim_low: line([20, 0], [20, 1]),
  flank_low: line([20, 1], [16, 5]),
  flank_high: line([16, 5], [20, 9]),
  rim_high: line([20, 9], [20, 10]),
  top: line([20, 10], [4, 10]),
  bore: line([4, 10], [4, 0]),
});
const pulley = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });
