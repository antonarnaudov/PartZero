/**
 * Thumbnails of the five starter parts (ALPHA-0-PLAN §2.4) for the welcome screen, drawn here as
 * isometric illustrations (our own, from the starters' stated dimensions): the storage bin, the
 * phone stand, the cable clip, the knob and the electronics box. A starter whose ready-made example
 * this build opens shows Forge's render of it instead (`starter-thumbnail.ts`); the illustration is
 * its placeholder while that renders, and the picture of the ones the agent designs from a prompt.
 *
 * Faces are shaded like the viewport's render (lit top, mid left, dark right; `.st-*` in
 * `styles/design.css`), so both kinds of thumbnail sit together in one grid. Each drawing frames
 * itself: the view box is the projected extent plus a margin.
 */
import type { ReactElement } from "react";

type V3 = readonly [number, number, number];
type Face = { d: string; cls: string };

/** Isometric projection (x to the lower right, y to the lower left, z up) that records the drawing's extent. */
class Iso {
  private x0 = Infinity;
  private x1 = -Infinity;
  private y0 = Infinity;
  private y1 = -Infinity;

  constructor(private readonly s: number) {}

  private track(x: number, y: number): void {
    this.x0 = Math.min(this.x0, x);
    this.x1 = Math.max(this.x1, x);
    this.y0 = Math.min(this.y0, y);
    this.y1 = Math.max(this.y1, y);
  }

  pt([x, y, z]: V3): [number, number] {
    const sx = (x - y) * 0.866 * this.s;
    const sy = ((x + y) * 0.5 - z) * this.s;
    this.track(sx, sy);
    return [sx, sy];
  }

  poly(pts: readonly V3[]): string {
    return `M${pts.map((p) => this.pt(p).map((v) => v.toFixed(2)).join(" ")).join(" L")} Z`;
  }

  /** A box's three visible faces: top, +y (left front), +x (right front). */
  box(o: V3, d: V3): Face[] {
    const [x0, y0, z0] = o;
    const [x1, y1, z1] = [x0 + d[0], y0 + d[1], z0 + d[2]];
    return [
      { cls: "st-l", d: this.poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]) },
      { cls: "st-r", d: this.poly([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]) },
      { cls: "st-t", d: this.poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]) },
    ];
  }

  /** A cylinder along z: its side and its top ellipse (as an ellipse element's attributes). */
  cyl(x: number, y: number, z0: number, r: number, h: number): { side: string; top: { cx: number; cy: number; rx: number; ry: number } } {
    const [bx, by] = this.pt([x, y, z0]);
    const [tx, ty] = this.pt([x, y, z0 + h]);
    const rx = r * 1.2247 * this.s;
    const ry = r * 0.7071 * this.s;
    this.track(bx - rx, by + ry);
    this.track(tx + rx, ty - ry);
    return {
      side: `M${tx - rx} ${ty} L${bx - rx} ${by} A${rx} ${ry} 0 0 0 ${bx + rx} ${by} L${tx + rx} ${ty} Z`,
      top: { cx: tx, cy: ty, rx, ry },
    };
  }

  /**
   * A prism: a closed profile in the x–z plane, extruded along y from `ya` to `yb`. Faces in the
   * painter's order (the far cap, the sides from far to near, the near cap), shaded by their normal.
   */
  prism(profile: ReadonlyArray<readonly [number, number]>, ya: number, yb: number, smooth = false): Face[] {
    const out: Face[] = [{ cls: "st-l", d: this.poly(profile.map(([x, z]) => [x, ya, z] as V3)) }];
    const sides: Array<Face & { depth: number }> = [];
    for (let i = 0; i < profile.length; i++) {
      const a = profile[i]!;
      const b = profile[(i + 1) % profile.length]!;
      // Outward normal of a counter-clockwise profile (x right, z up).
      const nx = b[1] - a[1];
      const nz = -(b[0] - a[0]);
      if (nx < -1e-9 && nz <= 1e-9) continue; // faces away (−x, or down)
      if (nz < -1e-9 && nx <= 1e-9) continue;
      const cls = nz > Math.abs(nx) * 0.35 ? "st-t" : nx > 0 ? "st-r" : "st-l";
      sides.push({ cls: smooth ? `${cls} sm` : cls, d: this.poly([[a[0], ya, a[1]], [b[0], ya, b[1]], [b[0], yb, b[1]], [a[0], yb, a[1]]]), depth: (a[0] + b[0]) / 2 + (a[1] + b[1]) / 2 });
    }
    sides.sort((p, q) => p.depth - q.depth);
    out.push(...sides, { cls: "st-l", d: this.poly(profile.map(([x, z]) => [x, yb, z] as V3)) });
    return out;
  }

  /** The drawing's extent with a margin, fitted to the thumbnail's 16:10 frame. */
  viewBox(margin = 0.1): string {
    const w = this.x1 - this.x0;
    const h = this.y1 - this.y0;
    let vw = w * (1 + 2 * margin);
    let vh = h * (1 + 2 * margin) + h * 0.12; // room for the contact shadow
    if (vw / vh < 1.6) vw = vh * 1.6;
    else vh = vw / 1.6;
    const cx = (this.x0 + this.x1) / 2;
    const cy = (this.y0 + this.y1) / 2 + h * 0.04;
    return `${(cx - vw / 2).toFixed(2)} ${(cy - vh / 2).toFixed(2)} ${vw.toFixed(2)} ${vh.toFixed(2)}`;
  }

  /** The contact shadow under the drawing. */
  shadow(): { cx: number; cy: number; rx: number; ry: number } {
    return { cx: (this.x0 + this.x1) / 2, cy: this.y1 - (this.y1 - this.y0) * 0.02, rx: (this.x1 - this.x0) * 0.46, ry: (this.y1 - this.y0) * 0.07 };
  }
}

const circle = (cx: number, cz: number, r: number, a0: number, a1: number, n: number): Array<[number, number]> =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = a0 + ((a1 - a0) * i) / n;
    return [cx + r * Math.cos(t), cz + r * Math.sin(t)] as [number, number];
  });

function Art({ iso, label, children }: { iso: Iso; label: string; children: ReactElement[] }): ReactElement {
  const shadow = iso.shadow();
  return (
    <svg className="starter-art" viewBox={iso.viewBox()} role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
      <ellipse className="st-shadow" {...shadow} />
      {children}
    </svg>
  );
}

const draw = (faces: Face[], key: string): ReactElement[] => faces.map((f, i) => <path key={`${key}${i}`} className={f.cls} d={f.d} />);

/** Storage bin: 80 × 40 × 30 mm, two compartments, 1.2 mm walls, open top. */
function StorageBin(): ReactElement {
  const iso = new Iso(1);
  const w = 1.2;
  const parts: ReactElement[] = [
    ...draw(iso.box([0, 0, 0], [80, 40, 30]), "o"),
    <path key="cav" className="st-cavity" d={iso.poly([[w, w, 30], [80 - w, w, 30], [80 - w, 40 - w, 30], [w, 40 - w, 30]])} />,
    <path key="in1" className="st-inner" d={iso.poly([[w, w, 30], [80 - w, w, 30], [80 - w, w, 9], [w, w, 9]])} />,
    <path key="in2" className="st-inner-dark" d={iso.poly([[w, w, 30], [w, 40 - w, 30], [w, 40 - w, 9], [w, w, 9]])} />,
    ...draw(iso.box([40 - 0.6, w, w], [1.2, 40 - 2 * w, 25 - w]), "d"),
  ];
  return (
    <Art iso={iso} label="Storage bin with dividers">
      {parts}
    </Art>
  );
}

/** Phone stand: a back at about 65°, a lip, a base, with a cable gap. */
function PhoneStand(): ReactElement {
  const iso = new Iso(1);
  const profile: Array<[number, number]> = [
    [0, 0],
    [70, 0],
    [70, 5],
    [26, 5],
    [26, 12],
    [20, 12],
    [20, 5],
    [16, 5],
    [40, 58],
    [34, 60],
    [8, 5],
    [0, 5],
  ];
  const faces = iso.prism(profile, 0, 64);
  return (
    <Art iso={iso} label="Phone stand">
      {[...draw(faces, "p"), <path key="gap" className="st-slot" d={iso.poly([[20, 27, 12.05], [26, 27, 12.05], [26, 37, 12.05], [20, 37, 12.05]])} />]}
    </Art>
  );
}

/** Screw-on cable clip: a C ring for a 6 mm cable on a 26 × 10 × 3 mm foot, one countersunk M3 hole. */
function CableClip(): ReactElement {
  const iso = new Iso(1);
  // The ring's profile in the x–z plane (a C open at the top), extruded along the cable (y).
  const cx = -8.3;
  const cz = 6;
  const gap = Math.asin(2.25 / 4.6);
  const outerArc = circle(cx, cz, 4.6, Math.PI / 2 + gap, Math.PI / 2 + 2 * Math.PI - gap, 40);
  const innerArc = circle(cx, cz, 3, Math.PI / 2 + 2 * Math.PI - Math.asin(2.25 / 3), Math.PI / 2 + Math.asin(2.25 / 3), 30);
  const ring = iso.prism([...outerArc, ...innerArc], -5, 5, true);
  const hole = iso.cyl(6.5, 0, 0, 1.7, 3);
  return (
    <Art iso={iso} label="Screw-on cable clip">
      {[
        ...draw(iso.box([-13, -5, 0], [26, 10, 3]), "f"),
        ...draw(ring, "r"),
        <ellipse key="cs" className="st-cavity" cx={hole.top.cx} cy={hole.top.cy} rx={hole.top.rx * 1.7} ry={hole.top.ry * 1.7} />,
        <ellipse key="h" className="st-hole" {...hole.top} />,
      ]}
    </Art>
  );
}

/** Knob for a D-shaft pot: 30 mm across, 16 mm tall, 18 grip grooves, a pointer line. */
function Knob(): ReactElement {
  const iso = new Iso(1);
  const body = iso.cyl(0, 0, 0, 15, 16);
  const grooves: ReactElement[] = [];
  const { rx, cx, cy, ry } = body.top;
  for (let i = 0; i < 18; i++) {
    const t = (i / 18) * Math.PI * 2 + 0.17;
    if (Math.sin(t) < 0.02) continue; // the back half is hidden
    const gx = cx + Math.cos(t) * rx;
    const gy = cy + Math.sin(t) * ry;
    grooves.push(<path key={`g${i}`} className="st-groove" d={`M${gx.toFixed(2)} ${(gy + 2).toFixed(2)} v${(16 - 3).toFixed(2)}`} />);
  }
  return (
    <Art iso={iso} label="Knob for a D-shaft pot">
      {[
        <path key="s" className="st-r" d={body.side} />,
        ...grooves,
        <ellipse key="t" className="st-t" {...body.top} />,
        <ellipse key="c" className="st-chamfer" cx={cx} cy={cy} rx={rx * 0.92} ry={ry * 0.92} />,
        <path key="p" className="st-pointer" d={`M${(cx + rx * 0.12).toFixed(2)} ${(cy + ry * 0.12).toFixed(2)} L${(cx + rx * 0.7).toFixed(2)} ${(cy + ry * 0.7).toFixed(2)}`} />,
      ]}
    </Art>
  );
}

/** Electronics box with a sliding lid beside it: inside 60 × 32 × 22 mm, 2 mm walls. */
function ElectronicsBox(): ReactElement {
  const iso = new Iso(1);
  return (
    <Art iso={iso} label="Electronics box with a lid">
      {[
        ...draw(iso.box([6, 48, 0], [64, 36, 2]), "l"),
        ...draw(iso.box([8, 50, 2], [60, 32, 3]), "k"),
        ...draw(iso.box([0, 0, 0], [64, 36, 24]), "b"),
        <path key="cav" className="st-cavity" d={iso.poly([[2, 2, 24], [62, 2, 24], [62, 34, 24], [2, 34, 24]])} />,
        <path key="in" className="st-inner" d={iso.poly([[2, 2, 24], [62, 2, 24], [62, 2, 7], [2, 2, 7]])} />,
        <path key="in2" className="st-inner-dark" d={iso.poly([[2, 2, 24], [2, 34, 24], [2, 34, 7], [2, 2, 7]])} />,
        <path key="usb" className="st-slot" d={iso.poly([[64, 12, 7], [64, 24, 7], [64, 24, 14], [64, 12, 14]])} />,
      ]}
    </Art>
  );
}

const ART: Record<string, () => ReactElement> = {
  "p1-storage-bin": StorageBin,
  "p2-phone-stand": PhoneStand,
  "p3-cable-clip": CableClip,
  "p4-knob": Knob,
  "p5-electronics-box": ElectronicsBox,
};

/** The illustration of a starter (a plain block for an unknown id). */
export function StarterArt({ id }: { id: string }): ReactElement {
  const A = ART[id];
  if (A) return <A />;
  const iso = new Iso(1);
  return (
    <Art iso={iso} label="Part">
      {draw(iso.box([0, 0, 0], [40, 40, 30]), "b")}
    </Art>
  );
}
