import { doc, part, sketch, line, arc, circle, extrude, frame, XY } from "@aicad/std";

doc({ name: "headphone_stand", description: "Headphone stand: 120x6 base disc, 30x20x250 post, 100x30x8 rounded saddle on top" });

part("stand");
const base_outline = sketch(XY, {
  rim: circle({ center: [0, 0], radius: 60 }),
});
const base = extrude(base_outline, { distance: 6 });
const post_outline = sketch(frame({ origin: [0, 0, 6], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  bottom: line([-15, -10], [15, -10]),
  right: line([15, -10], [15, 10]),
  top: line([15, 10], [-15, 10]),
  left: line([-15, 10], [-15, -10]),
});
const post = extrude(post_outline, { distance: 250 });
const saddle_outline = sketch(frame({ origin: [0, 0, 256], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  side_a: line([-35, -15], [35, -15]),
  end_r: arc({ start: [35, -15], end: [35, 15], center: [35, 0], ccw: true }),
  side_b: line([35, 15], [-35, 15]),
  end_l: arc({ start: [-35, 15], end: [-35, -15], center: [-35, 0], ccw: true }),
});
const saddle = extrude(saddle_outline, { distance: 8 });
