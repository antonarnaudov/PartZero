// expect: pass — the drain drilled from the underside face as a plain hole on the bottom cap (no flip), up to the pocket floor: the same geometry and the same hole
import { doc, part, sketch, extrude, rect, hole, XY } from "@aicad/std";

doc({ name: "magnetic_parts_tray", description: "80x40x16 parts tray: 64x24x10 pocket, two flat magnet pockets underneath, a drain drilled up into the pocket, loose M4 mounting holes, M3 self-tapping pilots for a lid" });

part("tray");
const outline = sketch(XY, { body: rect({ center: [0, 0], w: 80, h: 40 }) });
const block = extrude(outline, { distance: 16 });
const pocketSk = sketch(block.cap("end"), { pocket: rect({ center: [0, 0], w: 64, h: 24 }) });
const pocket = extrude(pocketSk, { distance: 10, direction: "reverse", op: "cut", targets: block });
// Flat-bottomed pockets for Ø8 × 3 magnets, from the underside.
const magnets = hole(block.cap("start"), { at: { m1: [-30, 0], m2: [30, 0] }, d: 8.2, depth: { blind: 3.2 }, tip: "flat" });
// The drain is drilled up from the XY plane (flipped: XY's normal points into the part) to the pocket floor.
const drain = hole(block.cap("start"), { at: { drain: [0, 0] }, d: 3, depth: { upTo: pocket.cap("end") } });
// Loose-fit M4 mounting holes through the floor, and M3 tap-drill pilots for self-tapping lid screws.
const mounts = hole(pocket.cap("end"), { at: { a: [-20, 0], b: [20, 0] }, size: "M4", fit: "loose", depth: "through" });
const pilots = hole(block.cap("end"), { at: { p1: [-36, 0], p2: [36, 0] }, size: "M3", fit: "tap", depth: { blind: 8 } });
