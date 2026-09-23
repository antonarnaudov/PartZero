import { doc, part, sketch, line, revolve, XZ } from "@aicad/std";

doc({ name: "lamp_base_stem", description: "Table lamp: 120 mm conical base with a 20.4 socket and 8 mm cable hole, plus a 20 x 250 mm tube stem, assembled" });

part("base");
// Half profile in XZ (u = radius, v = height), revolved about the Z axis.
const base_profile = sketch(XZ, {
  bottom: line([4, 0], [60, 0]),
  rim: line([60, 0], [60, 15]),
  taper: line([60, 15], [16, 30]),
  top: line([16, 30], [10.2, 30]),
  socket_wall: line([10.2, 30], [10.2, 15]),
  socket_floor: line([10.2, 15], [4, 15]),
  cable_hole: line([4, 15], [4, 0]),
});
const base = revolve(base_profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });

part("stem");
// 20 mm tube with an 8 mm cable bore, standing on the socket floor (0.2 mm clearance in the 20.4 socket).
const stem_profile = sketch(XZ, {
  s_bottom: line([4, 15], [10, 15]),
  s_outer: line([10, 15], [10, 265]),
  s_top: line([10, 265], [4, 265]),
  s_bore: line([4, 265], [4, 15]),
});
const stem = revolve(stem_profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });
