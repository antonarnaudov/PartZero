#!/usr/bin/env node
// The PartZero app icon: rasterizes the mark (packages/app/src/ui/shell/BrandMark.tsx: an isometric
// block with a round hole through its top face, on a dark tile) with no dependencies, and writes
//   build/icon.icns  (macOS: 16–1024 px, PNG entries; electron-builder picks it from buildResources)
//   build/icon.png   (1024 px: Linux packages, and the Dock icon of unpackaged runs)
//   build/icon.svg   (the same mark as vectors)
//
//   node scripts/make-icon.mjs            write the files
//   node scripts/make-icon.mjs --check    exit 1 if the committed files differ from what this makes
//
// Deterministic: the same bytes on every machine (no fonts, no system rasterizer, fixed zlib level).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = join(here, "..", "build");

// ─── The mark (64-unit grid; keep in step with BrandMark.tsx MARK) ──────────────────────────────

export const MARK = {
  tile: { top: [0x23, 0x2b, 0x3d], bottom: [0x12, 0x16, 0x20] },
  cube: {
    top: [
      [32, 16],
      [48.454, 25.5],
      [32, 35],
      [15.546, 25.5],
    ],
    left: [
      [15.546, 25.5],
      [32, 35],
      [32, 54],
      [15.546, 44.5],
    ],
    right: [
      [32, 35],
      [48.454, 25.5],
      [48.454, 44.5],
      [32, 54],
    ],
    colors: { top: [0x9c, 0xc0, 0xff], left: [0x4c, 0x8d, 0xff], right: [0x2a, 0x5b, 0xd0] },
  },
  hole: { cx: 32, cy: 25.5, rx: 7, ry: 4.041, wallDrop: 2.6, depth: [0x0d, 0x14, 0x26], wall: [0x3f, 0x74, 0xe0] },
  glow: [0x4c, 0x8d, 0xff],
};

// macOS icon grid (Big Sur and later): an 824 px tile centred on a 1024 px canvas, corner radius 185.
const TILE = { x0: 100, y0: 100, size: 824, r: 185 };
// The mark's tile spans 4..60 of the 64 grid; map it onto the macOS tile.
const S = TILE.size / 56;
const gx = (x) => TILE.x0 + (x - 4) * S;
const gy = (y) => TILE.y0 + (y - 4) * S;

/** Signed distance to the rounded tile (negative inside), in 1024-space units. */
function tileSdf(x, y, dy = 0) {
  const hx = TILE.size / 2;
  const cx = TILE.x0 + hx;
  const cy = TILE.y0 + hx + dy;
  const qx = Math.abs(x - cx) - (hx - TILE.r);
  const qy = Math.abs(y - cy) - (hx - TILE.r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - TILE.r;
}

function convexContains(poly, x, y) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c === 0) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

const scaled = (poly) => poly.map(([x, y]) => [gx(x), gy(y)]);
const FACES = [
  [scaled(MARK.cube.top), MARK.cube.colors.top],
  [scaled(MARK.cube.left), MARK.cube.colors.left],
  [scaled(MARK.cube.right), MARK.cube.colors.right],
];
const H = { cx: gx(MARK.hole.cx), cy: gy(MARK.hole.cy), rx: MARK.hole.rx * S, ry: MARK.hole.ry * S, drop: MARK.hole.wallDrop * S };
const inEllipse = (x, y, cy) => ((x - H.cx) / H.rx) ** 2 + ((y - cy) / H.ry) ** 2 <= 1;
const GLOW = { cx: gx(32), cy: gy(35), r: 21 * S };

/** Premultiplied RGBA (0–1) of one sample point in 1024 space. */
function sample(x, y) {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  const over = (cr, cg, cb, ca) => {
    r = cr * ca + r * (1 - ca);
    g = cg * ca + g * (1 - ca);
    b = cb * ca + b * (1 - ca);
    a = ca + a * (1 - ca);
  };
  // A soft shadow under the tile (offset down), as macOS icons carry.
  const ds = tileSdf(x, y, 12);
  if (ds < 28) {
    const t = Math.min(1, Math.max(0, 1 - (ds + 4) / 32));
    if (t > 0) over(0, 0, 0, 0.32 * t * t);
  }
  if (tileSdf(x, y) > 0) return [r, g, b, a];
  // The tile: a vertical gradient, and a faint accent glow behind the block.
  const t = (y - TILE.y0) / TILE.size;
  const [t0, t1] = [MARK.tile.top, MARK.tile.bottom];
  over((t0[0] + (t1[0] - t0[0]) * t) / 255, (t0[1] + (t1[1] - t0[1]) * t) / 255, (t0[2] + (t1[2] - t0[2]) * t) / 255, 1);
  const gd = Math.hypot(x - GLOW.cx, y - GLOW.cy) / GLOW.r;
  if (gd < 1) over(MARK.glow[0] / 255, MARK.glow[1] / 255, MARK.glow[2] / 255, 0.2 * (1 - gd) ** 2);
  for (const [poly, c] of FACES) if (convexContains(poly, x, y)) over(c[0] / 255, c[1] / 255, c[2] / 255, 1);
  if (inEllipse(x, y, H.cy)) {
    const c = inEllipse(x, y, H.cy + H.drop) ? MARK.hole.depth : MARK.hole.wall;
    over(c[0] / 255, c[1] / 255, c[2] / 255, 1);
  }
  return [r, g, b, a];
}

/** RGBA8 pixels of the icon at `size` px (n × n supersampling). */
export function render(size) {
  const n = size <= 64 ? 8 : size <= 256 ? 6 : 4;
  const scale = 1024 / size;
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const [sr, sg, sb, sa] = sample((px + (sx + 0.5) / n) * scale, (py + (sy + 0.5) / n) * scale);
          r += sr;
          g += sg;
          b += sb;
          a += sa;
        }
      }
      const k = n * n;
      const i = (py * size + px) * 4;
      const alpha = a / k;
      // Un-premultiply for PNG's straight alpha.
      out[i] = alpha > 0 ? Math.round(Math.min(1, r / k / alpha) * 255) : 0;
      out[i + 1] = alpha > 0 ? Math.round(Math.min(1, g / k / alpha) * 255) : 0;
      out[i + 2] = alpha > 0 ? Math.round(Math.min(1, b / k / alpha) * 255) : 0;
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

// ─── PNG and ICNS ───────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** ICNS element types with PNG payloads and their pixel sizes. */
export const ICNS_TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 48],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
];

export function icns(pngs) {
  const entries = ICNS_TYPES.map(([type, size]) => {
    const data = pngs.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(entries);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "latin1");
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

const fmt = (c) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const pts = (poly) => poly.map(([x, y]) => `${x},${y}`).join(" ");

export function svg() {
  const h = MARK.hole;
  const ring = (cy) => `M${h.cx - h.rx},${cy} a${h.rx},${h.ry} 0 1,0 ${2 * h.rx},0 a${h.rx},${h.ry} 0 1,0 ${-2 * h.rx},0 Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="1024" height="1024">
  <title>PartZero</title>
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${fmt(MARK.tile.top)}"/><stop offset="1" stop-color="${fmt(MARK.tile.bottom)}"/></linearGradient>
    <clipPath id="hole"><ellipse cx="${h.cx}" cy="${h.cy}" rx="${h.rx}" ry="${h.ry}"/></clipPath>
  </defs>
  <rect x="4" y="4" width="56" height="56" rx="13" fill="url(#tile)"/>
  <polygon points="${pts(MARK.cube.top)}" fill="${fmt(MARK.cube.colors.top)}"/>
  <polygon points="${pts(MARK.cube.left)}" fill="${fmt(MARK.cube.colors.left)}"/>
  <polygon points="${pts(MARK.cube.right)}" fill="${fmt(MARK.cube.colors.right)}"/>
  <ellipse cx="${h.cx}" cy="${h.cy}" rx="${h.rx}" ry="${h.ry}" fill="${fmt(h.depth)}"/>
  <path clip-path="url(#hole)" fill-rule="evenodd" fill="${fmt(h.wall)}" d="${ring(h.cy)} ${ring(h.cy + h.wallDrop)}"/>
</svg>
`;
}

export function makeAll() {
  const pngs = new Map();
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) pngs.set(size, png(size, render(size)));
  return { icns: icns(pngs), png: pngs.get(1024), svg: Buffer.from(svg()), pngs };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes("--check");
  const files = makeAll();
  const targets = [
    ["icon.icns", files.icns],
    ["icon.png", files.png],
    ["icon.svg", files.svg],
  ];
  let stale = 0;
  for (const [name, data] of targets) {
    const path = join(buildDir, name);
    if (check) {
      let same = false;
      try {
        same = Buffer.compare(readFileSync(path), data) === 0;
      } catch {
        same = false;
      }
      if (!same) {
        stale++;
        console.error(`${path} is out of date: run node scripts/make-icon.mjs`);
      }
    } else {
      writeFileSync(path, data);
      console.log(`${path}: ${data.length} bytes`);
    }
  }
  process.exit(stale ? 1 : 0);
}
