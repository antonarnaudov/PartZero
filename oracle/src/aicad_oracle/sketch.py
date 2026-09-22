"""SPEC §3 — sketch curves, loop assembly, crossing detection, nesting and regions.

Pure 2D math (no OCCT): the oracle decides sketch topology with its own simple, analytic code
and uses OCCT only for the 3D solids and their metrics. Every tolerance decision uses
`LINEAR_TOLERANCE` from the spec.

Error precedence (the spec lists the rules but not their priority; see README):
  1. endpoints, scanned in curve order (start before end): first endpoint with 0 partners →
     SKETCH_OPEN_LOOP, with >1 partners → SKETCH_BRANCHING;
  2. crossings, scanned over curve pairs (i < j) in curve order → SKETCH_CURVES_CROSS;
  3. zero-area loops → SKETCH_DEGENERATE_LOOP;
  4. no regions → SKETCH_NO_REGIONS.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .ir import LINEAR_TOLERANCE, Arc, Circle, Curve, Line, Vec2

TOL = LINEAR_TOLERANCE
TWO_PI = 2.0 * math.pi
#: A loop whose |signed area| is at or below this is degenerate (SPEC §3.1 rule 4 gives no number).
DEGENERATE_AREA = LINEAR_TOLERANCE * LINEAR_TOLERANCE


class SketchError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------------------------
# Small vector helpers
# ---------------------------------------------------------------------------------------------

def _sub(a: Vec2, b: Vec2) -> Vec2:
    return (a[0] - b[0], a[1] - b[1])


def _add(a: Vec2, b: Vec2) -> Vec2:
    return (a[0] + b[0], a[1] + b[1])


def _mul(a: Vec2, s: float) -> Vec2:
    return (a[0] * s, a[1] * s)


def _dot(a: Vec2, b: Vec2) -> float:
    return a[0] * b[0] + a[1] * b[1]


def _cross(a: Vec2, b: Vec2) -> float:
    return a[0] * b[1] - a[1] * b[0]


def _norm(a: Vec2) -> float:
    return math.hypot(a[0], a[1])


def _dist(a: Vec2, b: Vec2) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _angle(p: Vec2, c: Vec2) -> float:
    return math.atan2(p[1] - c[1], p[0] - c[0])


def _mod2pi(a: float) -> float:
    r = math.fmod(a, TWO_PI)
    if r < 0.0:
        r += TWO_PI
    if r >= TWO_PI:
        r -= TWO_PI
    return r


# ---------------------------------------------------------------------------------------------
# Geometric curve primitives
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Seg:
    a: Vec2
    b: Vec2

    @property
    def length(self) -> float:
        return _dist(self.a, self.b)

    def point(self, t: float) -> Vec2:
        return (self.a[0] + (self.b[0] - self.a[0]) * t, self.a[1] + (self.b[1] - self.a[1]) * t)


@dataclass(frozen=True)
class CArc:
    """Counter-clockwise circular arc on circle (c, r) over angles [t0, t0 + sweep].

    `full` marks a whole circle (then t0 = 0, sweep = 2π).
    """

    c: Vec2
    r: float
    t0: float
    sweep: float
    full: bool = False

    def point(self, t: float) -> Vec2:
        return (self.c[0] + self.r * math.cos(t), self.c[1] + self.r * math.sin(t))

    @property
    def p0(self) -> Vec2:
        return self.point(self.t0)

    @property
    def p1(self) -> Vec2:
        return self.point(self.t0 + self.sweep)

    def contains_angle(self, t: float, slack: float = 0.0) -> bool:
        if self.full:
            return True
        d = _mod2pi(t - self.t0)
        return d <= self.sweep + slack or d >= TWO_PI - slack

    def contains_point_angle(self, p: Vec2) -> bool:
        return self.contains_angle(_angle(p, self.c), TOL / self.r)


def arc_geometry(a: Arc) -> tuple[CArc, bool]:
    """Return the CCW arc geometry and whether the IR arc runs reversed (clockwise).

    r = |start − center| (SPEC §3). The end angle is taken from `end` (its radial deviation is
    at most LINEAR_TOLERANCE by validation).
    """
    r = _dist(a.start, a.center)
    ts = _angle(a.start, a.center)
    te = _angle(a.end, a.center)
    if a.ccw:
        return CArc(a.center, r, ts, _mod2pi(te - ts)), False
    return CArc(a.center, r, te, _mod2pi(ts - te)), True


def curve_geometry(c: Curve):
    if isinstance(c, Line):
        return Seg(c.start, c.end)
    if isinstance(c, Arc):
        return arc_geometry(c)[0]
    return CArc(c.center, c.radius, 0.0, TWO_PI, True)


# ---------------------------------------------------------------------------------------------
# Distances
# ---------------------------------------------------------------------------------------------

def dist_point_seg(p: Vec2, s: Seg) -> float:
    d = _sub(s.b, s.a)
    L2 = _dot(d, d)
    t = _dot(_sub(p, s.a), d) / L2
    t = min(1.0, max(0.0, t))
    return _dist(p, s.point(t))


def dist_point_arc(p: Vec2, a: CArc) -> float:
    rho = _dist(p, a.c)
    if a.full or (rho > 0.0 and a.contains_angle(_angle(p, a.c))):
        return abs(rho - a.r)
    return min(_dist(p, a.p0), _dist(p, a.p1))


def dist_point_curve(p: Vec2, g) -> float:
    return dist_point_seg(p, g) if isinstance(g, Seg) else dist_point_arc(p, g)


def _endpoints(g) -> list[Vec2]:
    if isinstance(g, Seg):
        return [g.a, g.b]
    if g.full:
        return []
    return [g.p0, g.p1]


# ---------------------------------------------------------------------------------------------
# Contacts (intersections and touches within tolerance)
# ---------------------------------------------------------------------------------------------

@dataclass
class Contacts:
    points: list[Vec2] = field(default_factory=list)
    overlap: bool = False  # the curves share a stretch longer than the tolerance


def _seg_seg(s1: Seg, s2: Seg) -> Contacts:
    out = Contacts()
    d = _sub(s1.b, s1.a)
    e = _sub(s2.b, s2.a)
    L1, L2 = _norm(d), _norm(e)
    denom = _cross(d, e)
    w = _sub(s2.a, s1.a)
    if abs(denom) > 1e-12 * L1 * L2:
        t = _cross(w, e) / denom
        u = _cross(w, d) / denom
        if -TOL / L1 <= t <= 1 + TOL / L1 and -TOL / L2 <= u <= 1 + TOL / L2:
            out.points.append(s1.point(t))
    else:
        # Parallel: collinear within tolerance?
        if abs(_cross(d, w)) / L1 <= TOL:
            dh = _mul(d, 1.0 / L1)
            q0 = _dot(_sub(s2.a, s1.a), dh)
            q1 = _dot(_sub(s2.b, s1.a), dh)
            lo = max(0.0, min(q0, q1))
            hi = min(L1, max(q0, q1))
            if hi - lo > TOL:
                out.overlap = True
            elif hi - lo >= -TOL:
                out.points.append(_add(s1.a, _mul(dh, 0.5 * (lo + hi))))
    for p in (s1.a, s1.b):
        if dist_point_seg(p, s2) <= TOL:
            out.points.append(p)
    for p in (s2.a, s2.b):
        if dist_point_seg(p, s1) <= TOL:
            out.points.append(p)
    return out


def _seg_arc(s: Seg, a: CArc) -> Contacts:
    out = Contacts()
    d = _sub(s.b, s.a)
    L = _norm(d)
    dh = _mul(d, 1.0 / L)
    rel = _sub(a.c, s.a)
    sf = _dot(rel, dh)  # foot parameter (length units)
    h = abs(_cross(dh, rel))  # distance centre → line
    cands: list[float] = []
    if abs(h - a.r) <= TOL:
        cands.append(sf)
    elif h < a.r:
        w = math.sqrt(max(0.0, a.r * a.r - h * h))
        cands += [sf - w, sf + w]
    for q in cands:
        if -TOL <= q <= L + TOL:
            p = _add(s.a, _mul(dh, q))
            if a.contains_point_angle(p):
                out.points.append(p)
    for p in (s.a, s.b):
        if dist_point_arc(p, a) <= TOL:
            out.points.append(p)
    for p in _endpoints(a):
        if dist_point_seg(p, s) <= TOL:
            out.points.append(p)
    return out


def _arc_overlap_length(a1: CArc, a2: CArc) -> float:
    """Angular overlap (radians) of two arcs on the same circle."""
    if a1.full or a2.full:
        return min(a1.sweep, a2.sweep)
    tot = 0.0
    u0 = a1.t0 + _mod2pi(a2.t0 - a1.t0)
    for shift in (0.0, -TWO_PI):
        lo = max(a1.t0, u0 + shift)
        hi = min(a1.t0 + a1.sweep, u0 + shift + a2.sweep)
        if hi > lo:
            tot += hi - lo
    return tot


def _arc_arc(a1: CArc, a2: CArc) -> Contacts:
    out = Contacts()
    dv = _sub(a2.c, a1.c)
    dd = _norm(dv)
    r1, r2 = a1.r, a2.r
    if dd <= TOL and abs(r1 - r2) <= TOL:
        if _arc_overlap_length(a1, a2) * max(r1, r2) > TOL:
            out.overlap = True
    elif dd <= TOL:
        pass  # concentric, different radii: no contact from the circles themselves
    elif dd > r1 + r2 + TOL or dd < abs(r1 - r2) - TOL:
        pass
    else:
        u = _mul(dv, 1.0 / dd)
        pts: list[Vec2] = []
        if abs(dd - (r1 + r2)) <= TOL:
            pts.append(_add(a1.c, _mul(u, r1)))
        elif abs(dd - abs(r1 - r2)) <= TOL:
            pts.append(_add(a1.c, _mul(u, r1 if r1 >= r2 else -r1)))
        else:
            aa = (r1 * r1 - r2 * r2 + dd * dd) / (2 * dd)
            hh = math.sqrt(max(0.0, r1 * r1 - aa * aa))
            base = _add(a1.c, _mul(u, aa))
            perp = (-u[1], u[0])
            pts += [_add(base, _mul(perp, hh)), _add(base, _mul(perp, -hh))]
        for p in pts:
            if a1.contains_point_angle(p) and a2.contains_point_angle(p):
                out.points.append(p)
    for p in _endpoints(a1):
        if dist_point_arc(p, a2) <= TOL:
            out.points.append(p)
    for p in _endpoints(a2):
        if dist_point_arc(p, a1) <= TOL:
            out.points.append(p)
    return out


def contacts(g1, g2) -> Contacts:
    if isinstance(g1, Seg) and isinstance(g2, Seg):
        return _seg_seg(g1, g2)
    if isinstance(g1, Seg):
        return _seg_arc(g1, g2)
    if isinstance(g2, Seg):
        return _seg_arc(g2, g1)
    return _arc_arc(g1, g2)


# ---------------------------------------------------------------------------------------------
# Loops
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class LoopEdge:
    index: int  # index into the sketch's curve list
    forward: bool  # traversed start→end (True) or end→start


@dataclass
class Loop:
    edges: list[LoopEdge]
    signed_area: float = 0.0
    test_point: Vec2 = (0.0, 0.0)
    depth: int = 0

    def curve_indices(self) -> list[int]:
        return [e.index for e in self.edges]


def _endpoint(c: Curve, which: int) -> Vec2:
    return c.start if which == 0 else c.end  # type: ignore[union-attr]


def _coincident(a: Vec2, b: Vec2) -> bool:
    # SPEC §1: "Points closer than this are coincident".
    return _dist(a, b) < LINEAR_TOLERANCE


def match_endpoints(curves: list[Curve]) -> dict[tuple[int, int], tuple[int, int]]:
    """SPEC §3.1 rule 1. Returns the partner map {(curve, end) → (curve, end)}."""
    ends = [(i, w) for i, c in enumerate(curves) if not isinstance(c, Circle) for w in (0, 1)]
    partner: dict[tuple[int, int], tuple[int, int]] = {}
    for i, w in ends:
        p = _endpoint(curves[i], w)
        ps = [(j, k) for (j, k) in ends if (j, k) != (i, w) and _coincident(p, _endpoint(curves[j], k))]
        which = "start" if w == 0 else "end"
        if not ps:
            raise SketchError(
                "SKETCH_OPEN_LOOP",
                f"the {which} of curve {curves[i].id!r} at ({p[0]:.9g}, {p[1]:.9g}) meets no other curve end",
            )
        if len(ps) > 1:
            others = ", ".join(f"{curves[j].id!r}" for j, _ in ps)
            raise SketchError(
                "SKETCH_BRANCHING",
                f"the {which} of curve {curves[i].id!r} at ({p[0]:.9g}, {p[1]:.9g}) meets {len(ps)} "
                f"other curve ends ({others}); exactly one is required",
            )
        partner[(i, w)] = ps[0]
    return partner


def assemble_loops(curves: list[Curve], partner) -> list[Loop]:
    """SPEC §3.1 rule 2: walk the chains. Each circle is its own loop."""
    loops: list[Loop] = []
    used = [False] * len(curves)
    for i, c in enumerate(curves):
        if used[i]:
            continue
        if isinstance(c, Circle):
            used[i] = True
            loops.append(Loop([LoopEdge(i, True)]))
            continue
        edges = [LoopEdge(i, True)]
        used[i] = True
        cur = (i, 1)
        for _ in range(len(curves) + 1):
            j, k = partner[cur]
            if j == i:
                break  # closed back at the start of the first curve
            used[j] = True
            fwd = k == 0
            edges.append(LoopEdge(j, fwd))
            cur = (j, 1 if fwd else 0)
        else:  # pragma: no cover - impossible when every end has exactly one partner
            raise SketchError("SKETCH_OPEN_LOOP", f"chain starting at {c.id!r} does not close")
        loops.append(Loop(edges))
    return loops


def find_crossing(curves: list[Curve], partner) -> tuple[int, int, Vec2 | None] | None:
    """SPEC §3.1 rule 3. Returns (i, j, point) of the first offending pair, or None."""
    geoms = [curve_geometry(c) for c in curves]
    n = len(curves)
    for i in range(n):
        for j in range(i + 1, n):
            ct = contacts(geoms[i], geoms[j])
            if ct.overlap:
                return i, j, None
            if not ct.points:
                continue
            shared: list[Vec2] = []
            for w in (0, 1):
                q = partner.get((i, w))
                if q is not None and q[0] == j:
                    shared.append(_endpoint(curves[i], w))
                    shared.append(_endpoint(curves[j], q[1]))
            for p in ct.points:
                if not any(_dist(p, s) <= 2.0 * TOL for s in shared):
                    return i, j, p
    return None


# ---------------------------------------------------------------------------------------------
# Area, winding, test points
# ---------------------------------------------------------------------------------------------

def _seg_area_term(a: Vec2, b: Vec2) -> float:
    return 0.5 * (a[0] * b[1] - b[0] * a[1])


def _arc_area_term(c: Vec2, r: float, alpha: float, beta: float) -> float:
    """½∮(x dy − y dx) along the circle (c, r) from angle alpha to beta (signed sweep)."""
    return 0.5 * (
        r * r * (beta - alpha)
        + r * c[0] * (math.sin(beta) - math.sin(alpha))
        - r * c[1] * (math.cos(beta) - math.cos(alpha))
    )


def loop_signed_area(curves: list[Curve], loop: Loop) -> float:
    total = 0.0
    for e in loop.edges:
        c = curves[e.index]
        if isinstance(c, Circle):
            total += math.pi * c.radius * c.radius
        elif isinstance(c, Line):
            a, b = (c.start, c.end) if e.forward else (c.end, c.start)
            total += _seg_area_term(a, b)
        else:
            g, rev = arc_geometry(c)
            t0, t1 = g.t0, g.t0 + g.sweep
            # IR direction: ccw (rev False) runs t0→t1; cw runs t1→t0. Then apply loop direction.
            if rev:
                t0, t1 = t1, t0
            if not e.forward:
                t0, t1 = t1, t0
            total += _arc_area_term(g.c, g.r, t0, t1)
    return total


def loop_perimeter(curves: list[Curve], loop: Loop) -> float:
    s = 0.0
    for e in loop.edges:
        g = curve_geometry(curves[e.index])
        s += g.length if isinstance(g, Seg) else g.r * g.sweep
    return s


def _winding_contribution(p: Vec2, c: Curve, forward: bool) -> float:
    if isinstance(c, Circle):
        return TWO_PI if _dist(p, c.center) < c.radius else 0.0
    if isinstance(c, Line):
        a, b = (c.start, c.end) if forward else (c.end, c.start)
        va, vb = _sub(a, p), _sub(b, p)
        return math.atan2(_cross(va, vb), _dot(va, vb))
    g, rev = arc_geometry(c)
    ccw = (not rev) == forward  # traversal is ccw about the arc centre
    a, b = (g.p0, g.p1) if ccw else (g.p1, g.p0)
    va, vb = _sub(a, p), _sub(b, p)
    principal = math.atan2(_cross(va, vb), _dot(va, vb))
    if _dist(p, g.c) < g.r:
        # Seen from inside the circle the direction turns monotonically with the arc.
        ang = _mod2pi(principal) if ccw else -_mod2pi(-principal)
        if ang == 0.0:
            ang = TWO_PI if ccw else -TWO_PI
        return ang
    return principal


def winding_number(p: Vec2, curves: list[Curve], loop: Loop) -> int:
    tot = sum(_winding_contribution(p, curves[e.index], e.forward) for e in loop.edges)
    return int(round(tot / TWO_PI))


def _test_point(curves: list[Curve], loop: Loop) -> Vec2:
    c = curves[loop.edges[0].index]
    g = curve_geometry(c)
    if isinstance(g, Seg):
        return g.point(0.5)
    return g.point(g.t0 + 0.5 * g.sweep)


# ---------------------------------------------------------------------------------------------
# Regions
# ---------------------------------------------------------------------------------------------

@dataclass
class Region:
    outer: Loop
    holes: list[Loop]
    outer_curves: list[str]
    area: float

    @property
    def loops(self) -> int:
        return 1 + len(self.holes)


@dataclass
class SketchResult:
    loops: list[Loop]
    regions: list[Region]  # canonical order


def evaluate_sketch(curves: list[Curve]) -> SketchResult:
    """Run SPEC §3 on a (structurally valid) curve list. Raises SketchError."""
    curves = list(curves)
    if not curves:
        raise SketchError("SKETCH_NO_REGIONS", "the sketch has no curves")
    partner = match_endpoints(curves)
    loops = assemble_loops(curves, partner)
    hit = find_crossing(curves, partner)
    if hit is not None:
        i, j, p = hit
        where = "overlap along a stretch" if p is None else f"meet at ({p[0]:.9g}, {p[1]:.9g})"
        raise SketchError(
            "SKETCH_CURVES_CROSS",
            f"curves {curves[i].id!r} and {curves[j].id!r} {where}, not at a shared endpoint",
        )
    for lp in loops:
        lp.signed_area = loop_signed_area(curves, lp)
        if abs(lp.signed_area) <= DEGENERATE_AREA:
            ids = ", ".join(repr(curves[k].id) for k in lp.curve_indices())
            raise SketchError("SKETCH_DEGENERATE_LOOP", f"loop ({ids}) encloses zero area")
        lp.test_point = _test_point(curves, lp)
    # Nesting: depth = number of other loops that strictly contain the loop.
    contains: dict[int, list[int]] = {k: [] for k in range(len(loops))}  # k → loops containing k
    for k, lp in enumerate(loops):
        for m, other in enumerate(loops):
            if m != k and winding_number(lp.test_point, curves, other) != 0:
                contains[k].append(m)
        lp.depth = len(contains[k])
    regions: list[Region] = []
    for k, lp in enumerate(loops):
        if lp.depth % 2 != 0:
            continue
        holes = [
            loops[h]
            for h in range(len(loops))
            if loops[h].depth == lp.depth + 1 and k in contains[h]
        ]
        outer_ids = sorted(curves[e.index].id for e in lp.edges)
        area = abs(lp.signed_area) - sum(abs(h.signed_area) for h in holes)
        regions.append(Region(lp, holes, outer_ids, area))
    if not regions:
        raise SketchError("SKETCH_NO_REGIONS", "the sketch yields no regions")
    regions.sort(key=lambda r: r.outer_curves)
    return SketchResult(loops, regions)


def _seg_moments(a: Vec2, b: Vec2) -> tuple[float, float]:
    """(∮ x²/2 dy, −∮ y²/2 dx) along a→b: contributions to ∬x dA and ∬y dA."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    mx = 0.5 * dy * (a[0] * a[0] + a[0] * dx + dx * dx / 3.0)
    my = -0.5 * dx * (a[1] * a[1] + a[1] * dy + dy * dy / 3.0)
    return mx, my


def _arc_moments(c: Vec2, r: float, alpha: float, beta: float) -> tuple[float, float]:
    cx, cy = c

    def fx(t: float) -> float:  # antiderivative of (cx + r cos t)² r cos t / 2
        s = math.sin(t)
        return 0.5 * (cx * cx * r * s + 2 * cx * r * r * (t / 2 + math.sin(2 * t) / 4) + r**3 * (s - s**3 / 3))

    def fy(t: float) -> float:  # antiderivative of (cy + r sin t)² r sin t / 2
        co = math.cos(t)
        return 0.5 * (-cy * cy * r * co + 2 * cy * r * r * (t / 2 - math.sin(2 * t) / 4) + r**3 * (-co + co**3 / 3))

    return fx(beta) - fx(alpha), fy(beta) - fy(alpha)


def loop_moments(curves: list[Curve], loop: Loop) -> tuple[float, float]:
    """Signed first moments (∬x dA, ∬y dA) of a loop (sign follows its orientation)."""
    mx = my = 0.0
    for e in loop.edges:
        c = curves[e.index]
        if isinstance(c, Circle):
            a = math.pi * c.radius * c.radius
            mx += a * c.center[0]
            my += a * c.center[1]
        elif isinstance(c, Line):
            a, b = (c.start, c.end) if e.forward else (c.end, c.start)
            dmx, dmy = _seg_moments(a, b)
            mx += dmx
            my += dmy
        else:
            g, rev = arc_geometry(c)
            t0, t1 = g.t0, g.t0 + g.sweep
            if rev:
                t0, t1 = t1, t0
            if not e.forward:
                t0, t1 = t1, t0
            dmx, dmy = _arc_moments(g.c, g.r, t0, t1)
            mx += dmx
            my += dmy
    return mx, my


def region_moments(curves: list[Curve], region: Region) -> tuple[float, float, float]:
    """(area, ∬x dA, ∬y dA) of a region (outer counted positive, holes negative)."""
    def oriented(lp: Loop, sign: float) -> tuple[float, float]:
        mx, my = loop_moments(curves, lp)
        s = sign if lp.signed_area > 0 else -sign
        return s * mx, s * my

    mx, my = oriented(region.outer, 1.0)
    for h in region.holes:
        hx, hy = oriented(h, -1.0)
        mx += hx
        my += hy
    return region.area, mx, my


# ---------------------------------------------------------------------------------------------
# Revolve profile check (SPEC §4.3)
# ---------------------------------------------------------------------------------------------

def signed_extent(curves: list[Curve], loop: Loop, origin: Vec2, direction: Vec2) -> tuple[float, float]:
    """(min, max) of the signed distance of the loop's points to the axis line."""
    L = _norm(direction)
    dh = (direction[0] / L, direction[1] / L)
    nrm = (-dh[1], dh[0])  # left normal of the axis

    def sd(p: Vec2) -> float:
        return _cross(dh, _sub(p, origin))

    vals: list[float] = []
    for e in loop.edges:
        g = curve_geometry(curves[e.index])
        if isinstance(g, Seg):
            vals += [sd(g.a), sd(g.b)]
        else:
            if not g.full:
                vals += [sd(g.p0), sd(g.p1)]
            for s in (1.0, -1.0):
                t = math.atan2(s * nrm[1], s * nrm[0])
                if g.contains_angle(t):
                    vals.append(sd(g.point(t)))
    return min(vals), max(vals)
