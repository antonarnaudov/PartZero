import { doc, part, sketch, extrude, rect, circle, hole, linearPattern, circularPattern, XY, X, Z } from "@aicad/std";

doc({ name: "ops_pattern_rail", description: "Naming harness (patterns): 120x40x6 rail with a linear pattern of bosses with holes, and a circular pattern of pockets on a disc" });

part("rail");
const railSk = sketch(XY, { rail: rect({ center: [0, 0], w: 120, h: 40 }) });
const rail = extrude(railSk, { distance: 6 });
const bossSk = sketch(rail.cap("end"), { ring: circle({ center: [-45, 0], radius: 5 }) });
const boss = extrude(bossSk, { distance: 8, op: "join", targets: rail });
const bore = hole(boss.cap("end"), { at: { p: [-45, 0] }, d: 4, depth: { blind: 10 }, tip: "flat" });
const row = linearPattern([boss, bore], { dir: X, count: 4, spacing: 22 });

part("disc");
const discSk = sketch(XY, { rim: circle({ center: [0, 80], radius: 30 }) });
const disc = extrude(discSk, { distance: 8 });
const pocketSk = sketch(disc.cap("end"), { pocket: rect({ center: [18, 80], w: 10, h: 6 }) });
const pocket = extrude(pocketSk, { distance: 3, direction: "reverse", op: "cut", targets: disc });
const ring = circularPattern([pocket], { axis: { line: { origin: [0, 80, 0], direction: [0, 0, 1] } }, count: 5 });
