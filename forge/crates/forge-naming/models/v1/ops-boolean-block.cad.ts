import { doc, part, sketch, extrude, rect, circle, frame, XY } from "@aicad/std";

doc({ name: "ops_boolean_block", description: "Naming harness (booleans): 80x40x20 block with a 10 mm groove across it, a joined boss, and a bridge joined to it that stops short of a second block" });

part("block");
const blockSk = sketch(XY, { body: rect({ center: [0, 0], w: 80, h: 40 }) });
const block = extrude(blockSk, { distance: 20 });
const grooveSk = sketch(frame({ origin: [0, 0, 20], normal: [0, 0, 1], xDir: [1, 0, 0] }), { groove: rect({ center: [-10, 0], w: 10, h: 50 }) });
const groove = extrude(grooveSk, { distance: 10, direction: "reverse", op: "cut", targets: block });
const bossSk = sketch(frame({ origin: [0, 0, 20], normal: [0, 0, 1], xDir: [1, 0, 0] }), { post: circle({ center: [25, 0], radius: 6 }) });
const boss = extrude(bossSk, { distance: 10, op: "join", targets: block });
const sideSk = sketch(XY, { side: rect({ center: [70, 0], w: 30, h: 40 }) });
const side = extrude(sideSk, { distance: 20 });
const bridgeSk = sketch(XY, { bridge: rect({ corner: [38, -5], w: 12, h: 10 }) });
const bridge = extrude(bridgeSk, { distance: 5, op: "join", targets: "all" });
