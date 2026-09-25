import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ, param, rect, hole, tag, thread } from "@aicad/std";

doc({ name: "threads", description: "Modelled threads (SPEC-v1 §6.5 thread.modeled, §6.13 thread): a 1/2-20 UNF through hole and an M8 blind tapped hole in a plate, and an M8 bolt thread on a boss" });

const thick = param(10, { min: 4 });
const boss_h = param(12, { min: 4 });

part("plate");
const base = sketch(XY, {
  outline: rect({ center: [0, 0], w: 60, h: 30 }),
});
const slab = extrude(base, { distance: thick });
const topFace = tag(slab.cap("end").one());
const muzzleThread = hole(topFace, { at: { a: [-15, 0] }, depth: "through", thread: { standard: "1/2-20 UNF", modeled: true } });
const tapped = hole(topFace, { at: { b: [2, 0] }, size: "M8", depth: { blind: 7 }, tip: "flat", thread: { modeled: true } });
const bossSk = sketch(topFace, {
  ring: circle({ center: [18, 0], radius: 4 }),
});
const boss = extrude(bossSk, { distance: boss_h, op: "join", targets: "all" });
const bossThread = thread(boss.side("ring"), { standard: "M8", length: 10 });
