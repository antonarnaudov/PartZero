"""Deterministic random generator of valid IR v0 programs (extrude / revolve) for the F0 gate.

Every program is produced from its own RNG, seeded with `aicad-gen/<seed>/<index>/<attempt>`, so
program i does not depend on the others (or on `--jobs`). Shapes are valid by construction:
  * loops are built from shared vertex tuples (exact endpoint coincidence);
  * holes are placed inside the outer shape's inscribed circle, islands inside a hole's
    inscribed circle, disjoint regions at separated bounding circles;
  * revolve profiles are built in (ρ, z) coordinates with ρ ≥ 0 and mapped by a rigid motion
    (optionally mirrored) onto a random axis in the sketch.
Curve order, curve direction (start/end swap) and curve ids are shuffled so that loop assembly
and canonical region ordering are exercised.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

Pt = tuple[float, float]
TAU = 2.0 * math.pi


# ---------------------------------------------------------------------------------------------
# Loops in local coordinates
# ---------------------------------------------------------------------------------------------

@dataclass
class Shape:
    """A closed loop. curves: IR-like dicts without ids. Radii are about the local origin."""

    curves: list[dict]
    outer_r: float  # circle about the origin that contains the loop
    inner_r: float  # circle about the origin strictly inside the loop (0 if none)
    tag: str

    def transformed(self, f, flips: bool) -> "Shape":
        out = []
        for c in self.curves:
            d = dict(c)
            for k in ("start", "end", "center"):
                if k in d:
                    d[k] = f(d[k])
            if flips and d["kind"] == "arc":
                d["ccw"] = not d["ccw"]
            out.append(d)
        return Shape(out, self.outer_r, self.inner_r, self.tag)

    def scaled(self, k: float) -> "Shape":
        """Uniform scaling about the local origin (points, circle radii and both radii)."""
        out = []
        for c in self.curves:
            d = dict(c)
            for key in ("start", "end", "center"):
                if key in d:
                    d[key] = (d[key][0] * k, d[key][1] * k)
            if d["kind"] == "circle":
                d["radius"] = d["radius"] * k
            out.append(d)
        return Shape(out, self.outer_r * k, self.inner_r * k, self.tag)


def line(a: Pt, b: Pt) -> dict:
    return {"kind": "line", "start": a, "end": b}


def arc(a: Pt, b: Pt, c: Pt, ccw: bool) -> dict:
    return {"kind": "arc", "start": a, "end": b, "center": c, "ccw": ccw}


def circle(c: Pt, r: float) -> dict:
    return {"kind": "circle", "center": c, "radius": r}


def polar(r: float, t: float, c: Pt = (0.0, 0.0)) -> Pt:
    return (c[0] + r * math.cos(t), c[1] + r * math.sin(t))


def rigid(theta: float, t: Pt):
    ct, st = math.cos(theta), math.sin(theta)

    def f(p: Pt) -> Pt:
        return (t[0] + ct * p[0] - st * p[1], t[1] + st * p[0] + ct * p[1])

    return f


def _poly_lines(pts: list[Pt]) -> list[dict]:
    return [line(pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts))]


def _dist_origin_to_segment(a: Pt, b: Pt) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0.0, min(1.0, -(a[0] * dx + a[1] * dy) / (dx * dx + dy * dy)))
    return math.hypot(a[0] + t * dx, a[1] + t * dy)


def _sorted_angles(rng: random.Random, n: int, min_gap: float) -> list[float]:
    for _ in range(200):
        a = sorted(rng.uniform(0, TAU) for _ in range(n))
        gaps = [a[i + 1] - a[i] for i in range(n - 1)] + [a[0] + TAU - a[-1]]
        if min(gaps) >= min_gap:
            return a
    return [i * TAU / n + rng.uniform(-0.1, 0.1) * TAU / n for i in range(n)]


def s_rect(rng: random.Random, size: float) -> Shape:
    w = rng.uniform(0.4, 1.0) * size
    h = rng.uniform(0.4, 1.0) * size
    pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    return Shape(_poly_lines(pts), math.hypot(w, h) / 2, min(w, h) / 2, "rect")


def s_polygon(rng: random.Random, size: float, concave: bool) -> Shape:
    n = rng.randint(5 if concave else 3, 9 if concave else 8)
    R = size / 2
    ang = _sorted_angles(rng, n, min(0.35, 0.5 * TAU / n))
    rad = [R * (rng.uniform(0.45, 1.0) if concave else 1.0) for _ in range(n)]
    pts = [polar(r, t) for r, t in zip(rad, ang)]
    inner = min(_dist_origin_to_segment(pts[i], pts[(i + 1) % n]) for i in range(n))
    return Shape(_poly_lines(pts), R, inner, "star" if concave else "convex")


def s_slot(rng: random.Random, size: float) -> Shape:
    r = rng.uniform(0.15, 0.3) * size
    L = rng.uniform(0.2, 1.0) * size
    A, B, C, D = (-L / 2, -r), (L / 2, -r), (L / 2, r), (-L / 2, r)
    curves = [line(A, B), arc(B, C, (L / 2, 0.0), True), line(C, D), arc(D, A, (-L / 2, 0.0), True)]
    return Shape(curves, L / 2 + r, r, "slot")


def s_circle(rng: random.Random, size: float) -> Shape:
    r = rng.uniform(0.3, 0.5) * size
    return Shape([circle((0.0, 0.0), r)], r, r, "circle")


def s_rounded_rect(rng: random.Random, size: float) -> Shape:
    w = rng.uniform(0.5, 1.0) * size
    h = rng.uniform(0.5, 1.0) * size
    f = rng.uniform(0.05, 0.45) * min(w, h)
    x0, x1, y0, y1 = -w / 2, w / 2, -h / 2, h / 2
    curves = [
        line((x0 + f, y0), (x1 - f, y0)),
        arc((x1 - f, y0), (x1, y0 + f), (x1 - f, y0 + f), True),
        line((x1, y0 + f), (x1, y1 - f)),
        arc((x1, y1 - f), (x1 - f, y1), (x1 - f, y1 - f), True),
        line((x1 - f, y1), (x0 + f, y1)),
        arc((x0 + f, y1), (x0, y1 - f), (x0 + f, y1 - f), True),
        line((x0, y1 - f), (x0, y0 + f)),
        arc((x0, y0 + f), (x0 + f, y0), (x0 + f, y0 + f), True),
    ]
    return Shape(curves, math.hypot(w, h) / 2, min(w, h) / 2, "rounded_rect")


def s_dshape(rng: random.Random, size: float) -> Shape:
    """Arc + chord: the two-curve loop SPEC §3.1 calls out explicitly."""
    r = size / 2
    s = math.radians(rng.uniform(60.0, 300.0))
    a, b = polar(r, -s / 2), polar(r, s / 2)
    return Shape([arc(a, b, (0.0, 0.0), True), line(b, a)], r, 0.0, "dshape")


def s_lens(rng: random.Random, size: float) -> Shape:
    c = rng.uniform(0.5, 1.0) * size
    d1 = rng.uniform(0.3, 2.0) * c
    d2 = rng.uniform(0.3, 2.0) * c
    r1, r2 = math.hypot(d1, c / 2), math.hypot(d2, c / 2)
    lo, hi = (0.0, -c / 2), (0.0, c / 2)
    curves = [arc(lo, hi, (-d1, 0.0), True), arc(hi, lo, (d2, 0.0), True)]
    return Shape(curves, max(c / 2, r1 - d1, r2 - d2), min(r1 - d1, r2 - d2), "lens")


def s_chord_arcs(rng: random.Random, size: float) -> Shape:
    """Cyclic polygon whose edges are randomly chords or arcs of the circumcircle."""
    R = size / 2
    n = rng.randint(2, 6)
    ang = _sorted_angles(rng, n, 0.4)
    pts = [polar(R, t) for t in ang]
    curves = []
    inner = R
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        gap = (ang[(i + 1) % n] - ang[i]) % TAU
        if n == 2 or rng.random() < 0.5 or gap > math.pi:
            curves.append(arc(a, b, (0.0, 0.0), True))
        else:
            curves.append(line(a, b))
            inner = min(inner, _dist_origin_to_segment(a, b))
    return Shape(curves, R, inner, "chord_arcs")


EXTRUDE_SHAPES = [
    (s_rect, 3),
    (lambda rng, s: s_polygon(rng, s, False), 2),
    (lambda rng, s: s_polygon(rng, s, True), 2),
    (s_slot, 2),
    (s_circle, 2),
    (s_rounded_rect, 2),
    (s_dshape, 1),
    (s_lens, 1),
    (s_chord_arcs, 1),
]
HOLE_SHAPES = [(s_circle, 4), (s_rect, 2), (s_slot, 2), (lambda rng, s: s_polygon(rng, s, False), 1),
               (s_rounded_rect, 1), (lambda rng, s: s_polygon(rng, s, True), 1)]


def pick(rng: random.Random, table):
    total = sum(w for _, w in table)
    x = rng.uniform(0, total)
    for f, w in table:
        x -= w
        if x <= 0:
            return f
    return table[-1][0]


# ---------------------------------------------------------------------------------------------
# Sketch assembly
# ---------------------------------------------------------------------------------------------

@dataclass
class SketchBuilder:
    rng: random.Random
    loops: list[Shape] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)

    def add(self, s: Shape) -> None:
        self.loops.append(s)
        self.tags.append(s.tag)

    def curves(self) -> list[dict]:
        rng = self.rng
        flat = [dict(c) for s in self.loops for c in s.curves]
        prefix = {"line": "l", "arc": "a", "circle": "c"}
        numbers = list(range(1, len(flat) + 1))
        rng.shuffle(numbers)
        out = []
        for c, n in zip(flat, numbers):
            style = rng.random()
            cid = f"{prefix[c['kind']]}{n}" if style < 0.8 else f"{c['kind']}_{n:02d}"
            d = {"kind": c["kind"], "id": cid}
            if c["kind"] == "circle":
                d["center"] = list(c["center"])
                d["radius"] = c["radius"]
            else:
                a, b = c["start"], c["end"]
                ccw = c.get("ccw")
                if rng.random() < 0.3:  # reverse the curve's own direction
                    a, b = b, a
                    ccw = None if ccw is None else not ccw
                d["start"], d["end"] = list(a), list(b)
                if c["kind"] == "arc":
                    d["center"] = list(c["center"])
                    d["ccw"] = ccw
            out.append(d)
        if rng.random() < 0.7:
            rng.shuffle(out)
        return out


def _place_holes(rng: random.Random, sb: SketchBuilder, outer: Shape, f, depth: int) -> None:
    """Place holes (and maybe islands inside them) inside outer's inscribed circle."""
    if outer.inner_r < 0.6 or rng.random() < 0.35:
        return
    m = rng.choice([1, 1, 1, 2, 2, 3, 4])
    g = math.ceil(math.sqrt(m))
    half = 0.9 * outer.inner_r / math.sqrt(2)
    cell = 2 * half / g
    cells = [(i, j) for i in range(g) for j in range(g)]
    rng.shuffle(cells)
    for i, j in cells[:m]:
        cx = -half + (i + 0.5) * cell
        cy = -half + (j + 0.5) * cell
        target = 0.8 * cell / 2
        hole = pick(rng, HOLE_SHAPES)(rng, 2 * target)
        hole = hole.scaled(target / hole.outer_r)
        g2 = rigid(rng.uniform(0, TAU), (cx, cy))
        placed = hole.transformed(lambda p, g2=g2: f(g2(p)), False)
        sb.add(Shape(placed.curves, placed.outer_r, placed.inner_r, "hole_" + hole.tag))
        if depth < 2 and hole.inner_r > 0.8 and rng.random() < 0.3:
            isl = pick(rng, HOLE_SHAPES)(rng, 2 * 0.7 * hole.inner_r)
            isl = isl.scaled(0.7 * hole.inner_r / isl.outer_r)
            g3 = rigid(rng.uniform(0, TAU), (0.0, 0.0))
            placed2 = isl.transformed(lambda p, g3=g3, g2=g2: f(g2(g3(p))), False)
            sb.add(Shape(placed2.curves, 0, 0, "island_" + isl.tag))


def thin_wall_sketch(rng: random.Random) -> tuple[list[dict], str]:
    """Stress: a concentric hole leaving a wall of 1e-5..1e-3 of the size (≫ LINEAR_TOLERANCE)."""
    sb = SketchBuilder(rng)
    size = math.exp(rng.uniform(math.log(2.0), math.log(80.0)))
    eps = math.exp(rng.uniform(math.log(1e-5), math.log(1e-3)))
    c = (rng.uniform(-20, 20), rng.uniform(-20, 20))
    if rng.random() < 0.5:
        R = size / 2
        sb.add(Shape([circle(c, R)], R, R, "circle"))
        sb.add(Shape([circle(c, R * (1 - eps))], R, R, "thin_hole_circle"))
    else:
        w, h = size, size * rng.uniform(0.3, 1.0)
        g = eps * size
        f = rigid(rng.uniform(0, TAU), c)
        outer = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
        inner = [(-w / 2 + g, -h / 2 + g), (w / 2 - g, -h / 2 + g), (w / 2 - g, h / 2 - g), (-w / 2 + g, h / 2 - g)]
        sb.add(Shape(_poly_lines([f(q) for q in outer]), 0, 0, "rect"))
        sb.add(Shape(_poly_lines([f(q) for q in inner]), 0, 0, "thin_hole_rect"))
    return sb.curves(), "+".join(sb.tags)


def extrude_sketch(rng: random.Random) -> tuple[list[dict], str]:
    if rng.random() < 0.04:
        return thin_wall_sketch(rng)
    sb = SketchBuilder(rng)
    k = rng.choice([1, 1, 1, 1, 2, 2, 3])
    shapes = []
    for _ in range(k):
        size = math.exp(rng.uniform(math.log(2.0), math.log(120.0)))
        shapes.append(pick(rng, EXTRUDE_SHAPES)(rng, size))
    theta = rng.uniform(0, TAU) if rng.random() < 0.7 else 0.0
    origin = (rng.uniform(-40, 40), rng.uniform(-40, 40)) if rng.random() < 0.7 else (0.0, 0.0)
    x = 0.0
    for idx, s in enumerate(shapes):
        if idx > 0:
            x += shapes[idx - 1].outer_r + rng.uniform(0.5, 10.0) + s.outer_r
        f = rigid(theta, origin)
        loc = rigid(rng.uniform(0, TAU) if rng.random() < 0.6 else 0.0, (x, 0.0))
        ff = (lambda loc, f: (lambda p: f(loc(p))))(loc, f)
        sb.add(s.transformed(ff, False))
        _place_holes(rng, sb, s, ff, 1)
    return sb.curves(), "+".join(sb.tags)


# ---------------------------------------------------------------------------------------------
# Revolve profiles in (ρ, z), ρ ≥ 0
# ---------------------------------------------------------------------------------------------

def _U(rng, a, b):
    return rng.uniform(a, b)


def p_rect(rng, touch: bool) -> Shape:
    r0 = 0.0 if touch else _U(rng, 0.5, 30)
    w, z0, h = _U(rng, 0.5, 25), _U(rng, -20, 20), _U(rng, 0.5, 40)
    pts = [(r0, z0), (r0 + w, z0), (r0 + w, z0 + h), (r0, z0 + h)]
    return Shape(_poly_lines(pts), 0, 0, "axis_rect" if touch else "ring_rect")


def p_cone(rng) -> Shape:
    R, z0, h = _U(rng, 1, 30), _U(rng, -20, 20), _U(rng, 1, 40)
    if rng.random() < 0.5:
        pts = [(0.0, z0), (R, z0), (0.0, z0 + h)]
    else:
        pts = [(0.0, z0), (R, z0), (R * _U(rng, 0.2, 0.9), z0 + h), (0.0, z0 + h)]
    return Shape(_poly_lines(pts), 0, 0, "cone")


def p_point_touch(rng) -> Shape:
    R, z0 = _U(rng, 2, 30), _U(rng, -20, 20)
    h1, h2 = _U(rng, 1, 20), _U(rng, 1, 20)
    if rng.random() < 0.5:
        pts = [(0.0, z0), (R, z0 - h1), (R, z0 + h2)]
    else:
        pts = [(0.0, z0), (R * _U(rng, 0.4, 0.8), z0 - h1), (R, z0), (R * _U(rng, 0.4, 0.8), z0 + h2)]
    return Shape(_poly_lines(pts), 0, 0, "point_touch")


def p_trapezoid(rng) -> Shape:
    z0, h = _U(rng, -20, 20), _U(rng, 1, 30)
    a, b = sorted([_U(rng, 0.5, 30), _U(rng, 0.5, 30)])
    c, d = sorted([_U(rng, 0.5, 30), _U(rng, 0.5, 30)])
    if b - a < 0.3:
        b = a + 0.3
    if d - c < 0.3:
        d = c + 0.3
    pts = [(a, z0), (b, z0), (d, z0 + h), (c, z0 + h)]
    return Shape(_poly_lines(pts), 0, 0, "trapezoid")


def p_torus(rng, tangent: bool) -> Shape:
    r = _U(rng, 0.5, 12)
    rc = r if tangent else r + _U(rng, 0.2, 30)
    return Shape([circle((rc, _U(rng, -20, 20)), r)], 0, 0, "horn_torus" if tangent else "torus")


def p_ball(rng) -> Shape:
    r, zc = _U(rng, 1, 25), _U(rng, -20, 20)
    return Shape([arc((0.0, zc - r), (0.0, zc + r), (0.0, zc), True), line((0.0, zc + r), (0.0, zc - r))], 0, 0, "ball")


def p_hemisphere(rng) -> Shape:
    r, zc = _U(rng, 1, 25), _U(rng, -20, 20)
    up = rng.random() < 0.5
    tip = (0.0, zc + r) if up else (0.0, zc - r)
    rim = (r, zc)
    curves = [arc(rim, tip, (0.0, zc), up), line(tip, (0.0, zc)), line((0.0, zc), rim)]
    return Shape(curves, 0, 0, "hemisphere")


def p_shell_sector(rng) -> Shape:
    zc = _U(rng, -20, 20)
    r1 = _U(rng, 1, 20)
    r2 = r1 + _U(rng, 0.5, 15)
    a1 = 0.0 if rng.random() < 0.2 else math.radians(_U(rng, -80, 60))  # 0 → a plane face
    a2 = a1 + math.radians(_U(rng, 10, 80 - math.degrees(a1)))
    o1, o2 = polar(r2, a1, (0.0, zc)), polar(r2, a2, (0.0, zc))
    i1, i2 = polar(r1, a1, (0.0, zc)), polar(r1, a2, (0.0, zc))
    curves = [arc(o1, o2, (0.0, zc), True), line(o2, i2), arc(i2, i1, (0.0, zc), False), line(i1, o1)]
    return Shape(curves, 0, 0, "shell_sector")


def p_dshape(rng) -> Shape:
    r0, z0, c = _U(rng, 0.5, 20), _U(rng, -20, 20), _U(rng, 1, 25)
    d = _U(rng, -0.8, 2.0) * c
    rc = r0 - d
    if rc < 0:
        rc = 0.0  # centre on the axis → sphere zone
    center = (rc, z0 + c / 2)
    a, b = (r0, z0), (r0, z0 + c)
    # ccw from a to b bulges towards +ρ: a minor arc when rc < r0, a major arc when rc > r0;
    # either way every point has ρ ≥ r0 > 0.
    return Shape([arc(a, b, center, True), line(b, a)], 0, 0, "d_torus")


def _offset_shape(rng, maker, size: float) -> Shape:
    s = maker(rng, size)
    rc = s.outer_r + _U(rng, 0.0, 25) + (0.0 if rng.random() < 0.15 else 0.3)
    f = rigid(_U(rng, 0, TAU), (rc, _U(rng, -20, 20)))
    t = s.transformed(f, False)
    return Shape(t.curves, s.outer_r, s.inner_r, "off_" + s.tag)


REVOLVE_PROFILES = [
    (lambda rng: [p_rect(rng, False)], 3),
    (lambda rng: [p_rect(rng, True)], 3),
    (lambda rng: [p_cone(rng)], 3),
    (lambda rng: [p_point_touch(rng)], 2),
    (lambda rng: [p_trapezoid(rng)], 2),
    (lambda rng: [p_torus(rng, False)], 3),
    (lambda rng: [p_torus(rng, True)], 1),
    (lambda rng: [p_ball(rng)], 2),
    (lambda rng: [p_hemisphere(rng)], 2),
    (lambda rng: [p_shell_sector(rng)], 2),
    (lambda rng: [p_dshape(rng)], 2),
    (lambda rng: [_offset_shape(rng, pick(rng, EXTRUDE_SHAPES), _U(rng, 2, 30))], 4),
]


def _profile_with_hole(rng) -> list[Shape]:
    outer = _offset_shape(rng, pick(rng, [(s_rect, 2), (s_circle, 2), (s_rounded_rect, 1), (s_slot, 1)]), _U(rng, 4, 30))
    return [outer]


def revolve_profile(rng: random.Random) -> tuple[list[Shape], bool]:
    """Return loops in (ρ, z) coordinates and whether hole placement is allowed for the first."""
    x = rng.random()
    if x < 0.12:
        return _profile_with_hole(rng), True
    if x < 0.22:
        # two disjoint profiles stacked along the axis
        a = pick(rng, REVOLVE_PROFILES)(rng)
        b = pick(rng, REVOLVE_PROFILES)(rng)
        za = max(p[1] for s in a for c in s.curves for p in _pts(c))
        zb = min(p[1] for s in b for c in s.curves for p in _pts(c))
        dz = za - zb + _U(rng, 0.5, 10)
        b = [s.transformed(lambda p, dz=dz: (p[0], p[1] + dz), False) for s in b]
        return a + b, False
    return pick(rng, REVOLVE_PROFILES)(rng), False


def _pts(c: dict) -> list[Pt]:
    if c["kind"] == "circle":
        (x, y), r = c["center"], c["radius"]
        return [(x, y - r), (x, y + r)]
    pts = [c["start"], c["end"]]
    if c["kind"] == "arc":
        r = math.dist(c["start"], c["center"])
        pts += [(c["center"][0], c["center"][1] - r), (c["center"][0], c["center"][1] + r)]
    return pts


def revolve_sketch(rng: random.Random) -> tuple[list[dict], dict, str]:
    loops, holes_ok = revolve_profile(rng)
    phi = rng.uniform(0, TAU) if rng.random() < 0.7 else rng.choice([0.0, math.pi / 2])
    a = (math.cos(phi), math.sin(phi))
    p = (-a[1], a[0])
    side = rng.choice([1.0, -1.0])
    O = (rng.uniform(-30, 30), rng.uniform(-30, 30)) if rng.random() < 0.6 else (0.0, 0.0)

    def f(q: Pt) -> Pt:
        rho, z = q
        return (O[0] + z * a[0] + side * rho * p[0], O[1] + z * a[1] + side * rho * p[1])

    det = -side  # orientation of the (ρ, z) → sketch map
    sb = SketchBuilder(rng)
    for s in loops:
        sb.add(s.transformed(f, det < 0))
    if holes_ok:
        s0 = loops[0]
        # holes relative to the shape's own local frame are not tracked after _offset_shape, so
        # place a single circular hole at the loop's inscribed centre when we know it.
        c = _loop_center(s0)
        if c is not None and s0.inner_r > 0.6:
            r = rng.uniform(0.2, 0.7) * s0.inner_r
            sb.add(Shape([circle(f(c), r)], r, r, "hole_circle"))
    t = rng.uniform(-10, 10)
    k = math.exp(rng.uniform(math.log(0.3), math.log(5.0))) * rng.choice([1.0, -1.0])
    axis = {"origin": [O[0] + t * a[0], O[1] + t * a[1]], "direction": [a[0] * k, a[1] * k]}
    return sb.curves(), axis, "+".join(sb.tags)


def _loop_center(s: Shape) -> Pt | None:
    for c in s.curves:
        if c["kind"] == "circle":
            return tuple(c["center"])
    # rect / rounded rect / slot: centroid of the curve endpoints is the local origin
    pts = [c["start"] for c in s.curves]
    if s.tag.endswith(("rect", "slot", "rounded_rect")):
        return (sum(q[0] for q in pts) / len(pts), sum(q[1] for q in pts) / len(pts))
    return None


# ---------------------------------------------------------------------------------------------
# Planes and documents
# ---------------------------------------------------------------------------------------------

def _unit(v):
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v]


def random_plane(rng: random.Random):
    x = rng.random()
    if x < 0.2:
        return "XY"
    if x < 0.35:
        return "XZ"
    if x < 0.5:
        return "YZ"
    while True:
        n = _unit([rng.gauss(0, 1) for _ in range(3)])
        v = [rng.gauss(0, 1) for _ in range(3)]
        d = sum(a * b for a, b in zip(v, n))
        xv = [v[i] - d * n[i] for i in range(3)]
        if math.sqrt(sum(c * c for c in xv)) > 0.1:
            break
    xv = _unit(xv)
    # re-orthogonalise once more for |cos| ~ 1e-17
    d = sum(a * b for a, b in zip(xv, n))
    xv = _unit([xv[i] - d * n[i] for i in range(3)])
    sn = rng.choice([1.0, 1.0, rng.uniform(0.2, 5.0)])
    sx = rng.choice([1.0, 1.0, rng.uniform(0.2, 5.0)])
    origin = [rng.uniform(-60, 60) for _ in range(3)] if rng.random() < 0.8 else [0.0, 0.0, 0.0]
    return {"origin": origin, "normal": [c * sn for c in n], "x_dir": [c * sx for c in xv]}


def _plane_tag(pl) -> str:
    return pl if isinstance(pl, str) else "frame"


def _direction(rng) -> str:
    return rng.choice(["normal", "normal", "reverse", "symmetric"])


def generate_program(rng: random.Random, name: str) -> dict:
    features: list[dict] = []
    desc: list[str] = []
    counter = {"s": 0, "e": 0, "r": 0}

    def fid(kind: str) -> tuple[str, str]:
        counter[kind] += 1
        n = counter[kind]
        return f"{kind}{n}", {"s": "sketch", "e": "extrude", "r": "revolve"}[kind] + f"_{n}"

    def add_extrude_group() -> None:
        curves, tag = extrude_sketch(rng)
        pl = random_plane(rng)
        sid, sname = fid("s")
        features.append({"type": "sketch", "id": sid, "name": sname, "plane": pl, "curves": curves})
        eid, ename = fid("e")
        dist = math.exp(rng.uniform(math.log(0.2), math.log(80.0)))
        e = {"type": "extrude", "id": eid, "name": ename, "sketch": sname, "distance": dist}
        dr = _direction(rng)
        if dr != "normal" or rng.random() < 0.3:
            e["direction"] = dr
        features.append(e)
        desc.append(f"extrude[{tag}] on {_plane_tag(pl)} {dr}")

    def add_revolve_group() -> None:
        curves, axis, tag = revolve_sketch(rng)
        pl = random_plane(rng)
        sid, sname = fid("s")
        features.append({"type": "sketch", "id": sid, "name": sname, "plane": pl, "curves": curves})
        rid, rname = fid("r")
        x = rng.random()
        if x < 0.4:
            ang = 360.0
        elif x < 0.6:
            ang = float(rng.choice([45, 90, 120, 180, 270]))
        elif x < 0.64:
            ang = math.exp(rng.uniform(math.log(0.01), math.log(1.0)))  # stress: tiny sweep
        elif x < 0.66:
            ang = 360.0 - math.exp(rng.uniform(math.log(0.01), math.log(1.0)))  # stress: almost closed
        else:
            ang = rng.uniform(1.0, 359.0)
        r = {"type": "revolve", "id": rid, "name": rname, "sketch": sname, "axis": axis, "angle": ang}
        dr = _direction(rng)
        if dr != "normal" or rng.random() < 0.3:
            r["direction"] = dr
        features.append(r)
        desc.append(f"revolve[{tag}] {ang:.4g}deg on {_plane_tag(pl)} {dr}")
        if rng.random() < 0.1:
            eid, ename = fid("e")
            features.append({"type": "extrude", "id": eid, "name": ename, "sketch": sname,
                             "distance": rng.uniform(0.5, 20.0)})
            desc.append("+extrude of the same sketch")

    if rng.random() < 0.55:
        add_extrude_group()
    else:
        add_revolve_group()
    if rng.random() < 0.1:
        (add_extrude_group if rng.random() < 0.5 else add_revolve_group)()
    if rng.random() < 0.08:
        # suppressed features must be skipped and leave no report entry
        last_sketch = [f for f in features if f["type"] == "sketch"][-1]["name"]
        eid, ename = fid("e")
        features.append({"type": "extrude", "id": eid, "name": ename, "sketch": last_sketch,
                         "distance": 5.0, "suppressed": True})
        desc.append("+suppressed extrude")
    if rng.random() < 0.08:
        k = rng.choice([0.01, 0.1, 10.0, 100.0])
        _scale_features(features, k)
        desc.append(f"stress: scaled x{k:g}")
    if rng.random() < 0.04:
        off = [rng.choice([-1, 1]) * rng.uniform(1e3, 1e4) for _ in range(3)]
        for f in features:
            if f["type"] == "sketch" and isinstance(f["plane"], dict):
                f["plane"]["origin"] = [a + b for a, b in zip(f["plane"]["origin"], off)]
        desc.append("stress: far origin")
    parts = [{"id": "p1", "name": "part_1", "features": features}]
    if rng.random() < 0.04:
        # SPEC §0: feature ids and names are unique across the whole document, so the
        # counters keep running into the second part studio.
        features_p1 = features
        features = []
        add_extrude_group()
        parts.append({"id": "p2", "name": "part_2", "features": features})
        features = features_p1
        desc.append("+second part studio")
    from .ir import reserved_names

    all_features = [f for p in parts for f in p["features"]]
    assert len({f["id"] for f in all_features}) == len(all_features)
    assert len({f["name"] for f in all_features}) == len(all_features)
    assert not ({f["name"] for f in all_features} & reserved_names())
    return {
        "schema": "aicad.ir/0",
        "meta": {"name": name, "description": "; ".join(desc)},
        "units": {"length": "mm", "angle": "deg"},
        "parts": parts,
    }


def _scale_features(features: list[dict], k: float) -> None:
    """Uniformly scale every sketch (about the sketch origin) and sweep distance by k."""
    for f in features:
        if f["type"] == "sketch":
            for c in f["curves"]:
                for key in ("start", "end", "center"):
                    if key in c:
                        c[key] = [c[key][0] * k, c[key][1] * k]
                if c["kind"] == "circle":
                    c["radius"] *= k
        elif f["type"] == "extrude":
            f["distance"] *= k
        elif f["type"] == "revolve":
            f["axis"]["origin"] = [f["axis"]["origin"][0] * k, f["axis"]["origin"][1] * k]
