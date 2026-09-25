import { doc, part, param, sketch, extrude, rect, hole, XZ } from "@aicad/std";

doc({ name: "headphone_wall_hook", description: "Wall hook for headphones: 40x70x5 back plate, 45 mm arm with a 15 mm lip, two countersunk M4 screws" });

const width = param(40, { min: 20, max: 80, note: "hook width (assumed: headband width + margin)" });
const reach = param(45, { min: 25, max: 90, note: "arm length from the wall" });
const lip = param(15, { min: 5, max: 30, note: "lip height at the arm's end" });
const thick = param(5, { min: 3, max: 10, note: "material thickness" });

part("hook");
// Back plate on the wall (XZ plane is the wall, the arm sticks out along −Y).
const plateSk = sketch(XZ, { plate: rect({ center: [0, 35], w: width, h: 70 }) });
const plate = extrude(plateSk, { distance: thick, direction: "reverse" });
const armSk = sketch(plate.cap("start"), { arm: rect({ corner: [-width / 2, 0], w: width, h: thick }) });
const arm = extrude(armSk, { distance: reach, op: "join", targets: plate });
const lipSk = sketch(arm.cap("end"), { tip: rect({ corner: [-width / 2, 0], w: width, h: lip + thick }) });
const tip = extrude(lipSk, { distance: thick, direction: "reverse", op: "join", targets: plate });
const screws = hole(plate.cap("start"), { at: { upper: [0, 60], lower: [0, 30] }, size: "M4", depth: "through", csink: "iso10642" });
