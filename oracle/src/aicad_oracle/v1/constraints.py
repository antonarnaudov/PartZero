"""The oracle's independent constraint checker (SPEC-v1 §4.3, §4.4, §8.1), written from the SPEC's
constraint table — not from forge-solve's residuals.

The oracle never solves a constrained sketch. It either
* **replays** Forge's `sketch.solved` (diff mode). Only the *numbers* are taken from the reference:
  the replayed geometry is the document's curves, in document order, with their `kind`,
  `construction` and `ccw` from the document and their coordinates and radii from `solved`
  (`replay_geometry`); `solved` must list exactly the document's curves, in order, with the same
  kind, `construction` and `ccw`, and finite coordinates. The check then verifies, with the
  residuals below, that every driving constraint holds to `SOLVE_CHECK_TOLERANCE` (1e-9 mm), that
  ends welded in the stored guess coincide *exactly* in the solution, and (`check_dimensions`) that
  every reported dimension value equals the oracle's own evaluation of the expression; or
* **computes** the fixed point of §4.4 rule 4 (standalone mode): when the stored guess, after
  welding, already satisfies every driving constraint to `SOLVE_TOLERANCE`, the solution is that
  welded guess, bit for bit.

Residuals are distances in mm (`residual`, one row per constraint kind of the §4.3 table). Each has
two measures:

* the **check** measure, compared with the tolerance: a length for conditions that are lengths;
  an angular condition (a dimensionless sine, cosine or wrapped angle in radians) times a
  **constant** length scale taken from the **welded stored guess** — the geometric mean of the two
  lengths involved, floored at 1 µm. §4.4 rule 3 pins forge-solve's convergence test, which scales
  its angular equations exactly so (`angular_scale`, `joint_scale`); measuring with the solved
  lengths instead would reject valid solves whose lines a dimension grew by more than ~10×
  (the solver's angular accuracy is relative to its starting point).
* the **natural** measure: the same angular condition times the longer of the solved lengths
  involved — how far the far end is off at the solved size. §8.1 states only the check measure,
  so a natural measure above *tol* (`LINEAR_TOLERANCE`) is **not** a failure: it is the
  ROBUSTNESS finding `ORACLE_REPLAY_SIZE_BOUND` (`CheckResult.notes`) — visible, never MATCH, never
  a silent-wrong answer under a rule the SPEC does not state (a legitimate solve from a guess whose
  lines are near the 1 µm scale floor to lines of 100 mm or more can meet forge-solve's criterion
  and still exceed it).

Every check measure is at least forge-solve's equation residual for the same constraint (Euclidean
distances where forge-solve has one equation per coordinate, the maximum of both conditions where
it has two, both the distance (in either mode at an arc–arc joint) and the first-order condition
of a tangency at a joint), so a stored
guess the oracle calls a fixed point is one forge-solve accepts without iterating (§4.4 rule 4).

Row semantics that are not visible in the §4.3 table and come from forge-solve's implementation
(`system.rs::compile_constraint`), which §4.3 adopts ("the 16 kinds are forge-solve's"):

* a curve–curve `tangent` **without a joint**: `internal` when given, else internal iff, in the
  welded guess, the centre distance is below the larger radius; that mode only is checked;
* a line–arc `tangent` whose curves share a **joint** (ends welded together, or joined by driving
  `coincident` constraints): the first-order condition there (line ⟂ radius) — forge-solve's only
  equation (`TangentLineAt`) — and the distance condition (which it implies, the joint lying on both);
* an arc–arc `tangent` at a joint: forge-solve's only equation (`TangentCurvesAt`) is that the two
  radii are collinear at the joint, and it **ignores `internal`** (model.rs documents a mode,
  system.rs does not apply one at a joint). The oracle checks exactly that — the collinear radii,
  plus tangency in *either* mode, `min(|d − (r1 + r2)|, |d − |r1 − r2||)`, which they imply — and a
  solved mode other than `internal` / the guess rule is the ROBUSTNESS finding
  `ORACLE_TANGENCY_MODE_DIFFERS` (`CheckResult.notes`), never a failure, until the SPEC says
  whether a tangency at an arc–arc joint has a mode;
* a point `fix` holds every coordinate that `x`/`y` does not give at its welded-guess value.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .consts import LINEAR_TOLERANCE, PARAM_VALUE_REL

TOL = LINEAR_TOLERANCE
DIMENSION_TYPES = ("distance", "angle", "radius", "diameter")
#: The numeric fields of each literal curve kind (LiteralCurve, metrics-v1.schema.json).
POINT_FIELDS = {"point": ("at",), "line": ("start", "end"), "arc": ("start", "end", "center"), "circle": ("center",)}


@dataclass
class SolverEntities:
    """Solver entities of a constrained sketch (§4.3): points by derived id, lines, circles, arcs."""

    points: dict[str, tuple[float, float]]
    lines: dict[str, tuple[str, str]]  # line id → (p1 id, p2 id)
    circles: dict[str, tuple[str, float]]  # circle id → (center id, radius)
    arcs: dict[str, tuple[str, str, str]]  # arc id → (center, start, end) as forge-solve (ccw)


def entities_of(curves: list[dict]) -> SolverEntities:
    """From literal curve dicts (`LiteralCurve` shape: kind, id, start/end/center/radius/at, ccw)."""
    pts: dict[str, tuple[float, float]] = {}
    lines: dict[str, tuple[str, str]] = {}
    circles: dict[str, tuple[str, float]] = {}
    arcs: dict[str, tuple[str, str, str]] = {}
    for c in curves:
        cid, k = c["id"], c["kind"]
        if k == "point":
            pts[cid] = tuple(c["at"])
        elif k == "line":
            pts[f"{cid}.start"], pts[f"{cid}.end"] = tuple(c["start"]), tuple(c["end"])
            lines[cid] = (f"{cid}.start", f"{cid}.end")
        elif k == "arc":
            pts[f"{cid}.start"], pts[f"{cid}.end"] = tuple(c["start"]), tuple(c["end"])
            pts[f"{cid}.center"] = tuple(c["center"])
            if c["ccw"]:
                arcs[cid] = (f"{cid}.center", f"{cid}.start", f"{cid}.end")
            else:
                arcs[cid] = (f"{cid}.center", f"{cid}.end", f"{cid}.start")
        elif k == "circle":
            pts[f"{cid}.center"] = tuple(c["center"])
            circles[cid] = (f"{cid}.center", float(c["radius"]))
    return SolverEntities(pts, lines, circles, arcs)


def weld_groups(curves: list[dict]) -> list[list[str]]:
    """§4.3 welding: union-find over curve ends (lines and arcs, curve order, start before end)
    that coincide within tol in the stored geometry; the representative is the first member."""
    ends: list[tuple[str, tuple[float, float]]] = []
    for c in curves:
        if c["kind"] in ("line", "arc"):
            ends.append((f"{c['id']}.start", tuple(c["start"])))
            ends.append((f"{c['id']}.end", tuple(c["end"])))
    parent = list(range(len(ends)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(ends)):
        for j in range(i + 1, len(ends)):
            pa, pb = ends[i][1], ends[j][1]
            if math.hypot(pa[0] - pb[0], pa[1] - pb[1]) <= TOL:
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[max(ri, rj)] = min(ri, rj)
    groups: dict[int, list[str]] = {}
    for i, (name, _) in enumerate(ends):
        groups.setdefault(find(i), []).append(name)
    return [g for g in groups.values() if len(g) > 1]


def welded(curves: list[dict]) -> list[dict]:
    """The stored guess with every alias moved onto its representative (the fixed point)."""
    ents = entities_of(curves)
    moved: dict[str, tuple[float, float]] = {}
    for g in weld_groups(curves):
        rep = ents.points[g[0]]
        for alias in g[1:]:
            moved[alias] = rep
    out = []
    for c in curves:
        d = dict(c)
        for which in ("start", "end"):
            key = f"{c['id']}.{which}"
            if key in moved:
                d[which] = list(moved[key])
        out.append(d)
    return out


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def _len(a) -> float:
    return math.hypot(a[0], a[1])


def _cross(a, b) -> float:
    return a[0] * b[1] - a[1] * b[0]


def _dot(a, b) -> float:
    return a[0] * b[0] + a[1] * b[1]


def _line_dist(p, a, b) -> float:
    d = _sub(b, a)
    return abs(_cross(d, _sub(p, a))) / _len(d)


class Geometry:
    def __init__(self, ents: SolverEntities):
        self.e = ents

    def p(self, i: str):
        return self.e.points[i]

    def line(self, i: str):
        a, b = self.e.lines[i]
        return self.p(a), self.p(b)

    def circle(self, i: str):
        """(center, radius) of a circle or arc (an arc's radius is |start − center|)."""
        if i in self.e.circles:
            c, r = self.e.circles[i]
            return self.p(c), r
        c, s, _e = self.e.arcs[i]
        return self.p(c), _len(_sub(self.p(s), self.p(c)))


def measure(con: dict, g: Geometry) -> float:
    """The measured value of a dimension constraint (mm or degrees)."""
    t = con["type"]
    if t == "distance":
        pa = g.p(con["a"])
        if con["b"] in g.e.lines:
            a, b = g.line(con["b"])
            return _line_dist(pa, a, b)
        return _len(_sub(g.p(con["b"]), pa))
    if t == "angle":
        a1, a2 = g.line(con["a"])
        b1, b2 = g.line(con["b"])
        da, db = _sub(a2, a1), _sub(b2, b1)
        ang = math.degrees(math.atan2(_cross(da, db), _dot(da, db)))
        return ang + 360.0 if ang < 0 else ang
    _c, r = g.circle(con["curve"])
    return 2.0 * r if t == "diameter" else r


#: forge-solve's floor of the constant length scale of an angular condition (1 µm).
SCALE_FLOOR = 1e-3


def length_scale(a: float, b: float) -> float:
    """The constant length scale of an angular condition: the geometric mean of two lengths of
    the welded stored guess, floored at 1 µm (module docs)."""
    return max(math.sqrt(a * b), SCALE_FLOOR)


def joints_of(curves: list[dict], constraints: list[dict]) -> Joints:
    """Points joined for tangency (forge-solve's `joint_root`): the welded groups of the stored
    geometry, plus every pair of points joined by a driving `coincident` constraint."""
    j = Joints()
    for grp in weld_groups(curves):
        for alias in grp[1:]:
            j.union(grp[0], alias)
    for con in constraints:
        if con.get("type") == "coincident" and con.get("driving", True) is not False:
            j.union(con["a"], con["b"])
    return j


class Joints:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        while self.parent.get(x, x) != x:
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            lo, hi = sorted((ra, rb))
            self.parent[hi] = lo

    def between(self, ends_a: list[str], ends_b: list[str]) -> list[tuple[str, str]]:
        """Every (end of a, end of b) pair that is joined, in curve order."""
        return [(x, y) for x in ends_a for y in ends_b if self.find(x) == self.find(y)]


def _ends(g: Geometry, i: str) -> list[str]:
    if i in g.e.lines:
        return list(g.e.lines[i])
    if i in g.e.arcs:
        return [f"{i}.start", f"{i}.end"]
    return []  # circles have no ends


@dataclass
class Ctx:
    """What a residual needs besides the constraint: the replayed geometry `g`, the welded stored
    guess `guess` (the solver's starting point) and the tangency joints."""

    g: Geometry
    guess: Geometry
    joints: Joints


def _linear(e: float) -> tuple[float, float]:
    return e, e


def _angular(ang: float, scale: float, solved: float) -> tuple[float, float]:
    return ang * scale, ang * solved


def _max(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    # NaN propagates (a NaN residual is a violation, never a pass)
    return tuple(x if (math.isnan(x) or x >= y) else y for x, y in zip(a, b))  # type: ignore[return-value]


def curve_tangency_internal(con: dict, guess: Geometry) -> bool:
    """§4.3 (forge-solve's model): `internal` when given, else decided from the welded guess —
    internal iff the centre distance is below the larger radius."""
    internal = con.get("internal")
    if isinstance(internal, bool):
        return internal
    c1, r1 = guess.circle(con["a"])
    c2, r2 = guess.circle(con["b"])
    return _len(_sub(c2, c1)) < max(r1, r2)


def residual(con: dict, cx: Ctx, value: float | None) -> tuple[float, float]:
    """`(check, natural)`: how far (mm) the replayed geometry is from satisfying one driving
    constraint, in the two measures of the module docs."""
    t = con["type"]
    g, g0 = cx.g, cx.guess
    if t == "coincident":
        return _linear(_len(_sub(g.p(con["a"]), g.p(con["b"]))))
    if t in ("horizontal", "vertical"):
        a, b = g.line(con["line"])
        return _linear(abs(b[1] - a[1]) if t == "horizontal" else abs(b[0] - a[0]))
    if t in ("parallel", "perpendicular", "angle"):
        a1, a2 = g.line(con["a"])
        b1, b2 = g.line(con["b"])
        da, db = _sub(a2, a1), _sub(b2, b1)
        la, lb = _len(da), _len(db)
        if t == "parallel":
            ang = abs(_cross(da, db)) / (la * lb)
        elif t == "perpendicular":
            ang = abs(_dot(da, db)) / (la * lb)
        else:  # the wrapped angle error, radians (counter-clockwise from a to b)
            dd = (measure(con, g) - value) % 360.0
            ang = math.radians(min(dd, 360.0 - dd))
        (ga1, ga2), (gb1, gb2) = g0.line(con["a"]), g0.line(con["b"])
        scale = length_scale(_len(_sub(ga2, ga1)), _len(_sub(gb2, gb1)))
        return _angular(ang, scale, max(la, lb))
    if t == "tangent":
        joints = cx.joints.between(_ends(g, con["a"]), _ends(g, con["b"]))
        if con["a"] in g.e.lines or con["b"] in g.e.lines:
            line_first = con["a"] in g.e.lines
            ln, cv = (con["a"], con["b"]) if line_first else (con["b"], con["a"])
            a, b = g.line(ln)
            c, r = g.circle(cv)
            out = _linear(abs(_line_dist(c, a, b) - r))
            (ga, gb), (gc, _gr) = g0.line(ln), g0.circle(cv)
            for ja, jb in joints:
                pl = ja if line_first else jb  # the line's end at the joint
                d, rv = _sub(b, a), _sub(g.p(pl), c)
                ang = abs(_dot(d, rv)) / (_len(d) * _len(rv))  # line ⟂ radius at the joint
                scale = length_scale(_len(_sub(gb, ga)), _len(_sub(g0.p(pl), gc)))
                out = _max(out, _angular(ang, scale, max(_len(d), _len(rv))))
            return out
        c1, r1 = g.circle(con["a"])
        c2, r2 = g.circle(con["b"])
        d = _len(_sub(c1, c2))
        ext, inn = abs(d - (r1 + r2)), abs(d - abs(r1 - r2))
        if joints:
            # an arc–arc joint (circles have no ends): no mode in forge-solve's model (module docs)
            out = _linear(min(ext, inn))
        else:
            out = _linear(inn if curve_tangency_internal(con, g0) else ext)
        (gc1, _), (gc2, _) = g0.circle(con["a"]), g0.circle(con["b"])
        for ja, _jb in joints:
            p = g.p(ja)
            u, w = _sub(p, c1), _sub(p, c2)
            ang = abs(_cross(u, w)) / (_len(u) * _len(w))  # the two radii collinear at the joint
            p0 = g0.p(ja)
            scale = length_scale(_len(_sub(p0, gc1)), _len(_sub(p0, gc2)))
            out = _max(out, _angular(ang, scale, max(_len(u), _len(w))))
        return out
    if t == "equal":
        if con["a"] in g.e.lines:
            a1, a2 = g.line(con["a"])
            b1, b2 = g.line(con["b"])
            return _linear(abs(_len(_sub(a2, a1)) - _len(_sub(b2, b1))))
        return _linear(abs(g.circle(con["a"])[1] - g.circle(con["b"])[1]))
    if t in ("distance", "radius", "diameter"):
        return _linear(abs(measure(con, g) - value))
    if t == "point_on_line":
        a, b = g.line(con["line"])
        return _linear(_line_dist(g.p(con["point"]), a, b))
    if t == "point_on_circle":
        c, r = g.circle(con["curve"])
        return _linear(abs(_len(_sub(g.p(con["point"]), c)) - r))
    if t == "midpoint":
        a, b = g.line(con["line"])
        m = ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
        return _linear(_len(_sub(g.p(con["point"]), m)))
    if t == "symmetric":
        pa, pb = g.p(con["a"]), g.p(con["b"])
        a, b = g.line(con["line"])
        m = ((pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0)
        u = _sub(b, a)
        return _linear(max(_line_dist(m, a, b), abs(_dot(_sub(pb, pa), u)) / _len(u)))
    if t == "fix":
        ent = con["entity"]
        if ent in g.e.points:
            # forge-solve's `K::Fix`: a coordinate that `x`/`y` does not give is held at its
            # initial value, the welded guess.
            p, p0 = g.p(ent), g0.p(ent)
            target = (con["_x"] if "x" in con else p0[0], con["_y"] if "y" in con else p0[1])
            return _linear(_len(_sub(p, target)))
        if ent in g.e.lines:
            (a, b), (ga, gb) = g.line(ent), g0.line(ent)
            return _linear(max(_len(_sub(a, ga)), _len(_sub(b, gb))))
        (c, r), (gc, gr) = g.circle(ent), g0.circle(ent)
        return _linear(max(_len(_sub(c, gc)), abs(r - gr)))
    raise ValueError(t)


def joint_tangency_mode(con: dict, cx: Ctx) -> str | None:
    """At an arc–arc joint (module docs): a message when the solved mode — internal iff
    `|d − |r1 − r2|| < |d − (r1 + r2)|` — is not the mode `internal` gives or, when omitted, the
    guess rule's; else None (also for every other tangency, where the mode is checked)."""
    g = cx.g
    a, b = con["a"], con["b"]
    if a not in g.e.arcs or b not in g.e.arcs or not cx.joints.between(_ends(g, a), _ends(g, b)):
        return None
    (c1, r1), (c2, r2) = g.circle(a), g.circle(b)
    d = _len(_sub(c1, c2))
    solved = abs(d - abs(r1 - r2)) < abs(d - (r1 + r2))
    want = curve_tangency_internal(con, cx.guess)
    if solved == want:
        return None
    given = isinstance(con.get("internal"), bool)
    mode = {True: "internal", False: "external"}
    src = f"`internal: {str(want).lower()}`" if given else \
        f"the guess rule (centre distance {'below' if want else 'not below'} the larger radius)"
    return (f"constraint {con['id']} (tangent): the arcs are {mode[solved]}ly tangent at their joint, "
            f"{src} says {mode[want]}; forge-solve has no mode at an arc–arc joint and SPEC §4.3 does not say")


def arc_residuals(g: Geometry) -> list[tuple[str, float]]:
    """The implicit arc rule: |start − center| = |end − center|."""
    out = []
    for aid, (c, s, e) in g.e.arcs.items():
        out.append((aid, abs(_len(_sub(g.p(s), g.p(c))) - _len(_sub(g.p(e), g.p(c))))))
    return out


def _real(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _pt(x) -> bool:
    return isinstance(x, list) and len(x) == 2 and all(_real(v) for v in x)


def replay_geometry(stored: list[dict], solved) -> tuple[list[dict] | None, list[str]]:
    """The replayed geometry: the document's curves (`stored`), in document order, with only the
    coordinates and radii taken from the reference's `solved` (matched by id).

    `solved` must contain exactly the document's curve ids, in document order, without duplicates,
    each with the document's `kind`, `construction` and (arcs) `ccw`, and finite numbers in every
    geometric field. Anything else — an extra, missing, duplicated, reordered, re-kinded or
    re-flagged curve, a malformed coordinate — is a failure: the reference's trace is not a
    solution of *this* document (SPEC §4.3: `construction` is passed through, arcs are mapped back
    through the document's `ccw`). Returns `(geometry, [])` or `(None, failures)`.
    """
    if not isinstance(solved, list) or not all(isinstance(c, dict) for c in solved):
        return None, ["sketch.solved is not a list of curve objects"]
    fails: list[str] = []
    ids = [c.get("id") for c in solved]
    if not all(isinstance(i, str) for i in ids):
        return None, [f"sketch.solved has curves without a string id: {ids}"]
    want = [c["id"] for c in stored]
    counts: dict[str, int] = {}
    for i in ids:
        counts[i] = counts.get(i, 0) + 1
    dup = sorted(i for i, n in counts.items() if n > 1)
    if dup:
        fails.append(f"sketch.solved repeats curve ids {dup}")
    extra = [i for i in ids if i not in set(want)]
    missing = [i for i in want if i not in counts]
    if extra:
        fails.append(f"sketch.solved has curves {extra} that the document does not have")
    if missing:
        fails.append(f"sketch.solved lacks the document's curves {missing}")
    if not fails and ids != want:
        fails.append(f"sketch.solved lists the curves in the order {ids}, the document in {want}")
    if fails:
        return None, fails
    out: list[dict] = []
    for c, s in zip(stored, solved):
        cid, k = c["id"], c["kind"]
        if s.get("kind") != k:
            fails.append(f"curve {cid} changed kind {k} -> {s.get('kind')}")
            continue
        sc = s.get("construction", False)
        if not isinstance(sc, bool):
            fails.append(f"curve {cid}: construction is {sc!r}, not a bool")
        elif sc != bool(c.get("construction", False)):
            fails.append(f"curve {cid}: construction {bool(c.get('construction', False))} in the document, {sc} in the solution")
        if k == "arc" and (not isinstance(s.get("ccw"), bool) or s["ccw"] != bool(c["ccw"])):
            fails.append(f"arc {cid}: ccw {bool(c['ccw'])} in the document, {s.get('ccw')!r} in the solution")
        d: dict = {"kind": k, "id": cid}
        for key in POINT_FIELDS[k]:
            if not _pt(s.get(key)):
                fails.append(f"curve {cid}: {key} = {s.get(key)!r} is not two finite numbers")
            else:
                d[key] = [float(v) for v in s[key]]
        if k == "circle":
            if not _real(s.get("radius")):
                fails.append(f"circle {cid}: radius = {s.get('radius')!r} is not a finite number")
            else:
                d["radius"] = float(s["radius"])
        if k == "arc":
            d["ccw"] = bool(c["ccw"])
        if c.get("construction"):
            d["construction"] = True
        out.append(d)
    return (None, fails) if fails else (out, [])


def check_dimensions(constraints: list[dict], values: dict[str, float], reported) -> list[str]:
    """§8.1: the reference's `sketch.dimensions` lists the document's dimension constraints in
    constraint order with the same `driving` flag, and every driving `value` equals the oracle's
    own evaluation of the expression (`PARAM_VALUE_REL`). An absent list is the empty list (the
    frozen report type omits it when empty). `measured` is not compared (it is a measurement of
    the replayed geometry, which the residual check already covers)."""
    rep = [] if reported is None else reported
    if not isinstance(rep, list) or not all(isinstance(d, dict) for d in rep):
        return ["sketch.dimensions is not a list of objects"]
    want = [(c["id"], c.get("driving", True) is not False) for c in constraints if c["type"] in DIMENSION_TYPES]
    got = [(d.get("id"), d.get("driving")) for d in rep]
    if got != want:
        return [f"sketch.dimensions lists {got}, the document's dimension constraints are {want}"]
    fails = []
    for d in rep:
        if not d["driving"]:
            continue
        mine, v = values[d["id"]], d.get("value")
        if not _real(v) or not abs(v - mine) <= PARAM_VALUE_REL * max(1.0, abs(v), abs(mine)):
            fails.append(f"dimension {d['id']}: the reference evaluated its value to {v!r}, the oracle to {mine!r}")
    return fails


def degenerate(c: dict) -> str | None:
    """The v0 structural `DEGENERATE_CURVE` rule on one literal curve (§4.2: it applies in both
    modes; `INCONSISTENT_ARC` is not checked in constrained mode). Returns the reason or None."""
    k = c["kind"]
    if k == "line":
        return "zero-length line" if math.dist(c["start"], c["end"]) <= TOL else None
    if k == "arc":
        if math.dist(c["start"], c["center"]) <= TOL or math.dist(c["end"], c["center"]) <= TOL:
            return "zero-radius arc"
        return "arc start == end" if math.dist(c["start"], c["end"]) <= TOL else None
    if k == "circle":
        return None if c["radius"] > TOL else "circle radius must be > 0"
    return None


@dataclass
class CheckResult:
    ok: bool
    failures: list[str]
    dimensions: list[dict]
    max_residual: float
    geometry: list[dict] | None = None  # the replayed geometry (document structure, solved numbers)
    #: ROBUSTNESS findings `(code, message)` on rules the SPEC does not state (module docs):
    #: `ORACLE_TANGENCY_MODE_DIFFERS`, `ORACLE_REPLAY_SIZE_BOUND`. Never failures.
    notes: list[tuple[str, str]] = field(default_factory=list)


def check(constraints: list[dict], values: dict[str, float], stored: list[dict], solved,
          tol: float) -> CheckResult:
    """Check `solved` against the constraints. `values` maps driving dimension ids to their
    evaluated values (and fix `x`/`y` to `<id>.x` / `<id>.y`); `stored` is the document's guess.

    The structure of `solved` is checked first (`replay_geometry`); the residuals are measured on
    the replayed geometry: every driving constraint's check measure ≤ `tol`, every arc's arc rule
    ≤ `tol`, and the ends welded in the stored guess bit-identical. A natural measure above *tol*
    and an arc–arc joint tangency in the other mode are `notes` (module docs), not failures. The solver's *initial* values — a `fix`'s held
    coordinates, the angular length scales, the tangency mode — are the **welded** stored guess
    (§4.3: an alias end starts at its representative's stored position)."""
    geo, structural = replay_geometry(stored, solved)
    if geo is None:
        return CheckResult(False, structural, [], math.inf)
    g = Geometry(entities_of(geo))
    cx = Ctx(g, Geometry(entities_of(welded(stored))), joints_of(stored, constraints))
    failures: list[str] = []
    notes: list[tuple[str, str]] = []
    dims: list[dict] = []
    worst = 0.0
    for con in constraints:
        t = con["type"]
        driving = con.get("driving", True)
        val = values.get(con["id"]) if t in DIMENSION_TYPES else None
        c2 = dict(con)
        if t == "fix":
            if "x" in con:
                c2["_x"] = values[f"{con['id']}.x"]
            if "y" in con:
                c2["_y"] = values[f"{con['id']}.y"]
        try:
            if t in DIMENSION_TYPES:
                m = measure(con, g)
                d = {"id": con["id"], "driving": driving}
                if driving:
                    d["value"] = val
                d["measured"] = m
                dims.append(d)
                if not driving:
                    continue
            r, nat = residual(c2, cx, val)
        except (KeyError, ZeroDivisionError, TypeError, ValueError) as e:
            failures.append(f"constraint {con['id']}: cannot evaluate on the solved geometry ({type(e).__name__}: {e})")
            continue
        if not (math.isfinite(r) and math.isfinite(nat)):
            failures.append(f"constraint {con['id']} ({t}): the residual is {r!r} on the solved geometry")
            continue
        worst = max(worst, r)
        if not (r <= tol):
            failures.append(f"constraint {con['id']} ({t}) is violated by {r:.3g} mm (> {tol:g})")
            continue
        if not (nat <= TOL):
            notes.append(("ORACLE_REPLAY_SIZE_BOUND",
                          (f"constraint {con['id']} ({t}) holds at the solver's scale ({r:.3g} mm) but is off by "
                           f"{nat:.3g} mm at the solved size (> {TOL:g}); SPEC §8.1 states only "
                           "SOLVE_CHECK_TOLERANCE")))
        if t == "tangent":
            why = joint_tangency_mode(c2, cx)
            if why is not None:
                notes.append(("ORACLE_TANGENCY_MODE_DIFFERS", why))
    for aid, r in arc_residuals(g):
        worst = max(worst, r)
        if not (r <= tol):
            failures.append(f"arc {aid}: |start-center| != |end-center| by {r:.3g} mm")
    for grp in weld_groups(stored):
        pts = {tuple(g.p(n)) for n in grp}
        if len(pts) != 1:
            failures.append(f"welded ends {grp} do not coincide exactly in the solution")
    return CheckResult(not failures, failures, dims, worst, geo, notes)


#: §4.4 rule 4 in replay mode: the oracle demands a bit-identical solution only when the welded
#: guess satisfies every driving constraint to this fraction of `SOLVE_TOLERANCE` in its own
#: measures (which are never below forge-solve's, module docs), so that rounding at the
#: threshold never turns a converged solve into a claimed fixed point.
FIXED_POINT_MARGIN = 0.5


def fixed_point(constraints: list[dict], values: dict[str, float], stored: list[dict],
                solve_tolerance: float) -> tuple[CheckResult, bool]:
    """§4.4 rule 4 on the welded stored guess: `(check of the guess at SOLVE_TOLERANCE, clear)`.
    `check.ok` means the guess is a fixed point (the standalone oracle uses it as the solution);
    `clear` means it is one with the margin `FIXED_POINT_MARGIN`, so any engine MUST return it bit
    for bit and can neither fail nor move it."""
    chk = check(constraints, values, stored, welded(stored), solve_tolerance)
    return chk, chk.ok and chk.max_residual <= FIXED_POINT_MARGIN * solve_tolerance


def differs_from(geometry: list[dict], guess: list[dict]) -> list[str]:
    """The curves of a replayed `geometry` whose numbers are not exactly those of `guess` (same
    structure, as `replay_geometry` guarantees). `-0.0` equals `0.0`."""
    out = []
    for c, w in zip(geometry, guess):
        for key in (*POINT_FIELDS[c["kind"]], "radius"):
            if key in c and [float(v) for v in (c[key] if isinstance(c[key], list) else [c[key]])] != \
                    [float(v) for v in (w[key] if isinstance(w[key], list) else [w[key]])]:
                out.append(f"{c['id']}.{key} = {c[key]} (the fixed point is {w[key]})")
    return out
