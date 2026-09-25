/**
 * A tiny software triangle rasterizer (depth + id buffers), shared by the placeholder renderer and
 * box selection's occlusion test.
 */

/**
 * Fill one triangle into the depth/id buffers (pixel centers, edge functions). `k` is the depth
 * key (1/z for perspective, −z for orthographic): linear in screen space, larger = nearer.
 */
export function rasterTriangle(
  depth: Float32Array,
  ids: Int32Array,
  w: number,
  h: number,
  x0: number,
  y0: number,
  k0: number,
  x1: number,
  y1: number,
  k1: number,
  x2: number,
  y2: number,
  k2: number,
  id: number,
): void {
  let area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (area === 0 || !Number.isFinite(area)) return;
  if (area < 0) {
    // Make the winding consistent so all three edge functions are positive inside.
    [x1, x2] = [x2, x1];
    [y1, y2] = [y2, y1];
    [k1, k2] = [k2, k1];
    area = -area;
  }
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1, y2)));
  if (minX > maxX || minY > maxY) return;
  const inv = 1 / area;
  // Edge function coefficients: w_i(x, y) = A_i·x + B_i·y + C_i.
  const a0 = -(y2 - y1), b0 = x2 - x1, c0 = -(a0 * x1 + b0 * y1);
  const a1 = -(y0 - y2), b1 = x0 - x2, c1 = -(a1 * x2 + b1 * y2);
  const a2 = -(y1 - y0), b2 = x1 - x0, c2 = -(a2 * x0 + b2 * y0);
  for (let py = minY; py <= maxY; py++) {
    const cy = py + 0.5;
    let e0 = a0 * (minX + 0.5) + b0 * cy + c0;
    let e1 = a1 * (minX + 0.5) + b1 * cy + c1;
    let e2 = a2 * (minX + 0.5) + b2 * cy + c2;
    let i = py * w + minX;
    for (let px = minX; px <= maxX; px++, i++, e0 += a0, e1 += a1, e2 += a2) {
      if (e0 < 0 || e1 < 0 || e2 < 0) continue;
      const k = (e0 * k0 + e1 * k1 + e2 * k2) * inv;
      if (k > depth[i]!) {
        depth[i] = k;
        ids[i] = id;
      }
    }
  }
}
