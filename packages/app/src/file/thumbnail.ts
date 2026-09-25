/**
 * Document thumbnails for `.partzero` files and the recent-files grid: a small software rasteriser (isometric,
 * orthographic, flat shading, z-buffer, 2× supersampling) and our own PNG encoder. Host-free: it does not read the
 * viewport (a WebGPU canvas cannot be read back reliably), so the same bodies give the same PNG everywhere.
 */
import { adler32, crc32 } from "./partzero/checksum";
import { deflateRaw } from "./partzero/deflate";

/** What the rasteriser needs of a display body (`RenderBody` fits). */
export interface ThumbnailBody {
  positions: Float32Array;
  indices: Uint32Array;
  color?: [number, number, number];
}

export interface Thumbnail {
  png: Uint8Array;
  width: number;
  height: number;
}

export const THUMBNAIL_SIZE = { width: 256, height: 192 } as const;

const BODY: [number, number, number] = [0.6, 0.64, 0.69];

/** RGBA pixels of the bodies seen from the front-right-top (Z up), transparent background; null without triangles. */
export function renderThumbnailRgba(bodies: readonly ThumbnailBody[], width: number, height: number): Uint8Array | null {
  const ss = 2;
  const W = width * ss;
  const H = height * ss;
  // Camera: looking from (1, -1, 0.8) towards the origin; screen x to the right, y up.
  const d = norm([1, -1, 0.8]);
  const x = norm(cross([0, 0, 1], d));
  const y = cross(d, x);
  const light = norm([0.35, -0.55, 1]);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let tris = 0;
  for (const b of bodies) {
    const p = b.positions;
    for (let i = 0; i < b.indices.length; i++) {
      const v = b.indices[i]! * 3;
      const sx = p[v]! * x[0] + p[v + 1]! * x[1] + p[v + 2]! * x[2];
      const sy = p[v]! * y[0] + p[v + 1]! * y[1] + p[v + 2]! * y[2];
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }
    tris += b.indices.length / 3;
  }
  if (tris === 0 || !Number.isFinite(minX)) return null;
  const margin = 0.08;
  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);
  const scale = Math.min((W * (1 - 2 * margin)) / spanX, (H * (1 - 2 * margin)) / spanY);
  const offX = W / 2 - ((minX + maxX) / 2) * scale;
  const offY = H / 2 + ((minY + maxY) / 2) * scale;
  const depth = new Float64Array(W * H).fill(-Infinity);
  const color = new Float32Array(W * H * 3);
  const cover = new Uint8Array(W * H);
  for (const b of bodies) {
    const base = b.color ?? BODY;
    const p = b.positions;
    for (let t = 0; t < b.indices.length; t += 3) {
      const vs = [b.indices[t]! * 3, b.indices[t + 1]! * 3, b.indices[t + 2]! * 3];
      const w3 = vs.map((v) => [p[v]!, p[v + 1]!, p[v + 2]!] as [number, number, number]);
      const n = cross(sub(w3[1]!, w3[0]!), sub(w3[2]!, w3[0]!));
      const nl = Math.hypot(n[0], n[1], n[2]);
      if (nl === 0) continue;
      const nn: [number, number, number] = [n[0] / nl, n[1] / nl, n[2] / nl];
      // Two-sided lighting: meshes with flipped triangles still read as solid.
      const facing = dot(nn, d) >= 0 ? nn : ([-nn[0], -nn[1], -nn[2]] as [number, number, number]);
      const shade = 0.38 + 0.62 * Math.max(0, dot(facing, light));
      const px = w3.map((q) => dot(q, x) * scale + offX);
      const py = w3.map((q) => offY - dot(q, y) * scale);
      const pz = w3.map((q) => dot(q, d));
      const area = (px[1]! - px[0]!) * (py[2]! - py[0]!) - (px[2]! - px[0]!) * (py[1]! - py[0]!);
      if (area === 0) continue;
      const x0 = Math.max(0, Math.floor(Math.min(px[0]!, px[1]!, px[2]!)));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(px[0]!, px[1]!, px[2]!)));
      const y0 = Math.max(0, Math.floor(Math.min(py[0]!, py[1]!, py[2]!)));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(py[0]!, py[1]!, py[2]!)));
      for (let yy = y0; yy <= y1; yy++) {
        const cy = yy + 0.5;
        for (let xx = x0; xx <= x1; xx++) {
          const cx = xx + 0.5;
          const w0 = ((px[1]! - cx) * (py[2]! - cy) - (px[2]! - cx) * (py[1]! - cy)) / area;
          const w1 = ((px[2]! - cx) * (py[0]! - cy) - (px[0]! - cx) * (py[2]! - cy)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * pz[0]! + w1 * pz[1]! + w2 * pz[2]!;
          const i = yy * W + xx;
          if (z <= depth[i]!) continue;
          depth[i] = z;
          cover[i] = 1;
          color[i * 3] = base[0] * shade;
          color[i * 3 + 1] = base[1] * shade;
          color[i * 3 + 2] = base[2] * shade;
        }
      }
    }
  }
  // Downsample (box filter), premultiplied by coverage.
  const out = new Uint8Array(width * height * 4);
  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < width; xx++) {
      let r = 0, g = 0, bl = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const i = (yy * ss + sy) * W + (xx * ss + sx);
          if (!cover[i]) continue;
          a++;
          r += color[i * 3]!;
          g += color[i * 3 + 1]!;
          bl += color[i * 3 + 2]!;
        }
      }
      const o = (yy * width + xx) * 4;
      if (a > 0) {
        out[o] = Math.round(srgb(r / a) * 255);
        out[o + 1] = Math.round(srgb(g / a) * 255);
        out[o + 2] = Math.round(srgb(bl / a) * 255);
        out[o + 3] = Math.round((a / (ss * ss)) * 255);
      }
    }
  }
  return out;
}

/** A PNG (RGBA, 8 bits) of `rgba` (`width × height × 4` bytes), with our own DEFLATE. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error("encodePng: pixel buffer size does not match the image size");
  // Filter "Sub" on every row: small and deterministic.
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let yy = 0; yy < height; yy++) {
    const o = yy * (stride + 1);
    raw[o] = 1;
    for (let i = 0; i < stride; i++) {
      const cur = rgba[yy * stride + i]!;
      const left = i >= 4 ? rgba[yy * stride + i - 4]! : 0;
      raw[o + 1 + i] = (cur - left) & 0xff;
    }
  }
  const z = deflateRaw(raw);
  const idat = new Uint8Array(2 + z.length + 4);
  idat[0] = 0x78;
  idat[1] = 0x01;
  idat.set(z, 2);
  new DataView(idat.buffer).setUint32(2 + z.length, adler32(raw));
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** A PNG thumbnail of the bodies, or null when there is nothing to draw. */
export function renderThumbnail(bodies: readonly ThumbnailBody[], size: { width: number; height: number } = THUMBNAIL_SIZE): Thumbnail | null {
  const rgba = renderThumbnailRgba(bodies, size.width, size.height);
  return rgba ? { png: encodePng(rgba, size.width, size.height), width: size.width, height: size.height } : null;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function srgb(c: number): number {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}
function sub(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}
function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}
function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}
function norm(a: readonly number[]): [number, number, number] {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!);
  return [a[0]! / l, a[1]! / l, a[2]! / l];
}
