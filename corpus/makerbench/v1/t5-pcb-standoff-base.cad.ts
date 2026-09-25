import { doc, part, param, sketch, extrude, rect, circle, hole, frame, XY } from "@aicad/std";

doc({ name: "pcb_standoff_base", description: "Base plate for an Arduino Nano-sized PCB: 50x25x3 plate, four Ø6x5 standoffs with M2 tap holes on a 38x13.5 pattern" });

const hx = param(38, { min: 10, max: 120, note: "hole spacing along X (assumed: Arduino Nano 38.1)" });
const hy = param(13.5, { min: 5, max: 80, note: "hole spacing along Y (assumed: Nano 13.97)" });
const standoff = param(5, { min: 2, max: 20, note: "standoff height (assumed)" });

part("base");
const plateSk = sketch(XY, { plate: rect({ center: [0, 0], w: hx + 12, h: hy + 12 }) });
const plate = extrude(plateSk, { distance: 3 });
const postSk = sketch(plate.cap("end"), {
  p1: circle({ center: [-hx / 2, -hy / 2], radius: 3 }),
  p2: circle({ center: [hx / 2, -hy / 2], radius: 3 }),
  p3: circle({ center: [hx / 2, hy / 2], radius: 3 }),
  p4: circle({ center: [-hx / 2, hy / 2], radius: 3 }),
});
const posts = extrude(postSk, { distance: standoff, op: "join", targets: plate });
const taps = hole(frame({ origin: [0, 0, 3 + standoff], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  at: postSk.points("p1.center", "p2.center", "p3.center", "p4.center"),
  size: "M2",
  thread: true,
  depth: "through",
  targets: plate,
});
