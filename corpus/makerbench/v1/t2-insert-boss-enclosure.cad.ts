import { doc, part, param, sketch, extrude, rect, circle, fillet, shell, hole, frame, XY, Z } from "@aicad/std";

doc({ name: "insert_boss_enclosure", description: "Shelled enclosure base with rounded corners and four M3 heat-set insert bosses" });

const width = param(80, { min: 40, note: "outer width (X)" });
const depth = param(60, { min: 30, note: "outer depth (Y)" });
const height = param(30, { min: 12, note: "outer height" });
const wall = param(2, { min: 1.2, max: 4, note: "wall and floor thickness" });
const boss_inset = param(10, { note: "boss centre to the outer wall" });

part("base");
const outline = sketch(XY, { box: rect({ center: [0, 0], w: width, h: depth }) });
const blank = extrude(outline, { distance: height });
const corners = fillet(blank.sides().edges().parallel(Z), { r: 5 });
const hollow = shell(blank, { open: blank.cap("end"), thickness: wall });
const bossSk = sketch(XY, {
  b1: circle({ center: [boss_inset - width / 2, boss_inset - depth / 2], radius: 4 }),
  b2: circle({ center: [width / 2 - boss_inset, boss_inset - depth / 2], radius: 4 }),
  b3: circle({ center: [width / 2 - boss_inset, depth / 2 - boss_inset], radius: 4 }),
  b4: circle({ center: [boss_inset - width / 2, depth / 2 - boss_inset], radius: 4 }),
});
const bosses = extrude(bossSk, { distance: height - 4, op: "join", targets: blank });
const inserts = hole(frame({ origin: [0, 0, height - 4], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  at: bossSk.points("b1.center", "b2.center", "b3.center", "b4.center"),
  size: "M3",
  insert: "std",
  targets: blank,
});
