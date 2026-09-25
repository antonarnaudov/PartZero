import { doc, part, sketch, extrude, frame, rect, XY, YZ, param } from "@aicad/std";

doc({ name: "electronics_box", description: "P5: a box with a slide-on lid for an ESP32 dev board, both printed flat" });

// The board and the fit (ALPHA-0-PLAN §2.4 P5). Inside size and clearance drive everything else.
const inner_x = param(60, { min: 20, max: 200, note: "inside length" });
const inner_y = param(32, { min: 15, max: 200, note: "inside width" });
const inner_z = param(22, { min: 5, max: 150, note: "inside depth" });
const wall = param(2, { min: 1.2, max: 5, note: "walls and floor" });
const corner_r = param(3, { min: 2, max: 10, note: "outside corner radius" });
const clearance_slip = param(0.2, { min: 0, max: 0.8, note: "diametral slip clearance of the lid lip (PLA default)" });
const lid_t = param(2, { min: 1.2, max: 5, note: "lid plate thickness" });
const lip_h = param(3, { min: 1, max: 10, note: "lip depth" });
const lid_gap = param(8, { min: 5, max: 50, note: "gap between the box and the lid on the bed" });
const usb_w = param(12, { min: 4, max: 30, note: "USB cable slot width" });
const usb_h = param(7, { min: 3, max: 20, note: "USB cable slot height" });
const usb_z = param(5, { min: 0, max: 50, note: "slot height above the floor" });

part("box");
const outline = sketch(XY, { outer: rect({ center: [0, 0], w: inner_x + 2 * wall, h: inner_y + 2 * wall, r: corner_r }) });
const shell = extrude(outline, { distance: inner_z + wall });
const cavity = sketch(frame({ origin: [0, 0, wall], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  inner: rect({ center: [0, 0], w: inner_x, h: inner_y, r: corner_r - wall }),
});
const hollow = extrude(cavity, { distance: inner_z, op: "cut", targets: shell });
const usb = sketch(YZ, { slot: rect({ center: [0, wall + usb_z + usb_h / 2], w: usb_w, h: usb_h }) });
const usb_cut = extrude(usb, { distance: inner_x + 2 * wall, op: "cut", targets: shell });

part("lid");
const plate_sk = sketch(frame({ origin: [0, -(inner_y + 2 * wall + lid_gap), 0], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  plate: rect({ center: [0, 0], w: inner_x + 2 * wall, h: inner_y + 2 * wall, r: corner_r }),
});
const lid = extrude(plate_sk, { distance: lid_t });
const lip_sk = sketch(frame({ origin: [0, -(inner_y + 2 * wall + lid_gap), lid_t], normal: [0, 0, 1], xDir: [1, 0, 0] }), {
  lip: rect({ center: [0, 0], w: inner_x - clearance_slip, h: inner_y - clearance_slip, r: corner_r - wall - clearance_slip / 2 }),
});
const lip = extrude(lip_sk, { distance: lip_h, op: "join", targets: lid });
