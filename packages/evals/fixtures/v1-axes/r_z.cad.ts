import { doc, part, sketch, revolve, line, hole, circularPattern, XZ, Z } from "@aicad/std";
doc({ name: "revolved_hub_axes" });
part("r");
const rs = sketch(XZ, {
  r_bot: line([5, 0], [20, 0]),
  r_out: line([20, 0], [20, 10]),
  r_top: line([20, 10], [5, 10]),
  r_in: line([5, 10], [5, 0]),
});
const hub = revolve(rs, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });
const h = hole(hub.side("r_top"), { at: { a: [12, 0] }, d: 3, depth: "through" });
const p = circularPattern([h], { axis: Z, count: 4 });
