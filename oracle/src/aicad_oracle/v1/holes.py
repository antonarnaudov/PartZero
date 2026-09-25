"""The `hole` feature (SPEC-v1 §6.5 [D-42]) with OCCT, per §8.3 rule 7: the oracle builds each hole
tool as the revolution of the exact §6.5 profile and applies **one** cut of the targets
(`booleans.apply_body_op`, §6.0.3).

Steps, in the §7.1 order:

1. **Field values** (expressions and range checks): the diameter and presets from `HOLE_SIZES`
   (read from `ir-v1.constants.json` at run time, `tool_dims`: `d` if given, else the insert bore,
   else the tap drill when threaded or `fit: tap`, else the ISO 273 series of `fit`), the depth,
   `tip`, thread, the placement numbers; `INVALID_VALUE` / `INVALID_COUNT` with the literal
   check's path.
2. **References**, in field order: the `on` plane (a face frame, §3.1), the `up_to` face, the
   `targets` (default: the body owning the `on` face).
3. **The operation**: positions (`list`, `grid` — ids `g<i>_<j>`, `i` outer —, `circle` — ids
   `c<k>`, exact degree trigonometry —, sketch `points` projected along `n`) as `P = o + u·x + v·y`;
   `HOLE_DUPLICATE_POSITION` (the later id), `HOLE_POINT_OFF_FACE` (a position farther than *tol*
   from the `on` face), `HOLE_UP_TO_MISSED` (no hit of the ray `P + t·d`, `t ≥ tol`, on the up-to
   face); the drilling direction `d = −n` (`flip`: `n`); one tool of revolution per position; per
   position `HOLE_MISSES_BODY` (its tool alone does not meet a target, [W0-41] step 2); the one
   cut; per blind position the warning `HOLE_BREAKS_THROUGH` (below).

**Tool profile** in the half-plane `(ρ ≥ 0, y)` spanned by a radial direction `e ⟂ d` and `d`
(`R = D/2`): `top` `(0,0)→(R_top,0)`, `cbore_wall` `(Rc,0)→(Rc,hc)`, `cbore_floor` `(Rc,hc)→(R,hc)`,
`csink` `(Rk,0)→(R,hk)` with `hk = (Rk − R)/tan(β/2)`, `wall` `(R,y0)→(R,h)`, then `tip`
`(R,h)→(0, h + R/tan(tip/2))`, `floor` `(R,h)→(0,h)` (inserts, `up_to`, `tip: "flat"`), or for a
through hole `end` `(R,L)→(0,L)` with `L` the larger of the farthest corner of the targets' boxes
along `d` and the head's depth (`hc` or `hk`: a countersink may be deeper than a thin plate), plus
`max(1, 0.01·s)`. Faces are keyed `H/<role>@p` (§5.2 rule 3); `top` and `end` are the
oracle's names for the two faces §5.2 does not list (`top` survives only when the placement plane
lies inside a target). The tool's volume is checked against its closed form (the body gate).

**Break-through** (§6.5 names the warning without a test; W7b reads it as): a blind hole breaks
through unless its bottom — the `tip` cone or the `floor` disc of its tool — lies inside the
targets' material farther than *tol* from every target face ([R-3]: within *tol* the bottom lies
on the face and the hole opens there; the unnamed `1e-9` relative-area test before W7b's review is
gone). Forge decides it from the result's topology (the bottom face missing or bounded by a face
that is not the hole's), which is the same reading once coincident faces are snapped. A floor
**short** of the far face by at most *tol* opens for the SPEC, but the oracle's cut (no fuzzy
value) keeps a floor that thin: the cut fails with the engine-internal
`ORACLE_COINCIDENCE_UNREALIZED` (`booleans.check_target_band`, W7b review 4), never `ok` +
`HOLE_BREAKS_THROUGH` with the floor still in the body.

**Report** (`holes`, in position order): `at`, `center` (= P), `axis` (= d), `d`, `depth` (the blind
or up-to depth, the insert depth, `null` for through), `kind` (insert > counterbore > countersink >
simple), `size`, `cbore` / `insert` `{d, depth}`, `csink` `{d, angle}`, `thread`
`{size?, pitch, depth}` (depth: the thread's own, else the hole depth, `null` for through).

What a pattern needs to re-apply the hole (§6.10) is kept on the feature state (`fs.seed`).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakeWire
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import BRepPrimAPI_MakeRevol
from OCP.GProp import GProp_GProps
from OCP.gp import gp_Ax1, gp_Dir, gp_Lin, gp_Pnt
from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector

from . import consts, expr, geom
from .consts import LINEAR_TOLERANCE
from .sweeps import FeatureFailure
from .topo import Body, TopoError, count_shells

TOL = LINEAR_TOLERANCE
#: The tool-volume gate (closed form vs OCCT), relative.
TOOL_GATE_REL = 1e-9


def _row(size: str) -> dict:
    return consts.constants()["HOLE_SIZES"]["sizes"][size]


def _tv(row: dict, key: str) -> float | None:
    v = row.get(key)
    return None if v is None else float(v["value"])


@dataclass
class HoleSpec:
    d: float
    kind: str
    depth_kind: str  # through / blind / up_to
    blind: float | None = None
    tip: float | None = None  # degrees; None = flat
    cbore: tuple[float, float] | None = None
    csink: tuple[float, float] | None = None
    insert: tuple[float, float] | None = None
    thread: tuple[float, float | None] | None = None  # (pitch, explicit depth)
    #: The thread's form beyond its pitch: `{standard, major, starts, right_hand, modeled}`
    #: (Forge's `HoleThreadForm`; §6.5 modelled threads).
    thread_form: dict | None = None
    size: str | None = None
    #: The field a head-depth violation names: `/cbore/depth` or `/csink/d` for custom heads,
    #: `/cbore` or `/csink` for the presets (whose numbers come from `HOLE_SIZES`).
    head_field: str | None = None


@dataclass
class HolePos:
    id: str
    uv: tuple[float, float]
    point: tuple


@dataclass
class HoleSeed:
    """What a pattern re-applies (§6.10): the tools as evaluated, and how to re-resolve targets."""

    tools: list = field(default_factory=list)
    positions: list = field(default_factory=list)
    spec: HoleSpec | None = None
    direction: tuple | None = None


def _positive(v: float, path: str) -> float:
    if not (math.isfinite(v) and v > TOL):
        raise FeatureFailure("INVALID_VALUE", f"{path} = {v}: must be > 0.000001",
                             {"field": path, "value": v, "expected": "> 0.000001"})
    return v


def _angle_open(v: float, path: str) -> float:
    if not (math.isfinite(v) and 0.0 < v < 180.0):
        raise FeatureFailure("INVALID_VALUE", f"{path} = {v}: must be in (0, 180)",
                             {"field": path, "value": v, "expected": "in (0, 180)"})
    return v


def _count(v: float, path: str) -> int:
    if not (math.isfinite(v) and v == math.floor(v) and v >= 1.0):
        raise FeatureFailure("INVALID_COUNT", f"{path} = {v}: must be an integer >= 1",
                             {"field": path, "value": v, "expected": ">= 1"})
    return int(v)


def hole_spec(ev, st, h: dict) -> HoleSpec:
    """§6.5 field values: `tool_dims` (HOLE_SIZES) and the range checks (step 1 of the module)."""
    sc = lambda v, fld="length": ev.scalar(st, v, fld)  # noqa: E731
    size = h.get("size")
    row = _row(size) if size else {}
    fit = h.get("fit", "normal")
    th = h.get("thread")
    if isinstance(th, str):
        th = sc(th, "bool")
    threaded = th is not None and th is not False
    std = None
    if isinstance(th, dict) and "standard" in th:
        from .threads import standard

        std = standard(th["standard"])
        if std is None:
            raise FeatureFailure("HOLE_OPTIONS_CONFLICT", f"{th['standard']!r} is not a THREAD_STANDARDS designation",
                                 {"field": "/thread/standard",
                                  "allowed": list(consts.constants()["THREAD_STANDARDS"]["threads"])})
    insert = None
    ins = h.get("insert")
    if ins == "std":
        insert = (_tv(row, "insert_d"), _tv(row, "insert_depth"))
    elif isinstance(ins, dict):
        insert = (_positive(sc(ins["d"]), "/insert/d"), _positive(sc(ins["depth"]), "/insert/depth"))
    if "d" in h:
        d = _positive(sc(h["d"]), "/d")
    elif insert is not None:
        d = insert[0]
    elif not size and std is not None:
        # §6.5: without a size, a thread standard gives the bore: its basic minor diameter
        d = float(std["minor"])
    else:
        key = "tap" if (threaded or fit == "tap") else fit
        d = _tv(row, key)
    if d is None:
        raise FeatureFailure("HOLE_OPTIONS_CONFLICT", "HOLE_SIZES has no verified value for this hole",
                             {"field": "/size", "allowed": []})
    cbore = None
    cb = h.get("cbore")
    if cb == "iso4762":
        cbore = (_tv(row, "cbore_d"), _tv(row, "cbore_depth"))
    elif isinstance(cb, dict):
        cbore = (_positive(sc(cb["d"]), "/cbore/d"), _positive(sc(cb["depth"]), "/cbore/depth"))
    csink = None
    cs = h.get("csink")
    if cs == "iso10642":
        csink = (_tv(row, "csink_d"), 90.0)
    elif isinstance(cs, dict):
        csink = (_positive(sc(cs["d"]), "/csink/d"),
                 _angle_open(sc(cs.get("angle", 90.0), "angle"), "/csink/angle"))
    thread = None
    if threaded:
        pitch = None
        tdepth = None
        if isinstance(th, dict):
            if "pitch" in th:
                pitch = _positive(sc(th["pitch"]), "/thread/pitch")
            if "depth" in th:
                tdepth = _positive(sc(th["depth"]), "/thread/depth")
        if pitch is None:
            pitch = float(std["pitch"]) if std is not None else _tv(row, "pitch")
        thread = (pitch, tdepth)
    thread_form = None
    if threaded:
        from .threads import standard

        starts, right, modeled = 1, True, False
        if isinstance(th, dict):
            if "starts" in th:
                n = sc(th["starts"], "count")
                if not (math.isfinite(n) and n == math.floor(n) and 1.0 <= n <= 8.0):
                    raise FeatureFailure("INVALID_COUNT", f"/thread/starts = {n}: must be an integer in [1, 8]",
                                         {"field": "/thread/starts", "value": n, "expected": "an integer in [1, 8]"})
                starts = int(n)
            right = th.get("hand", "right") == "right"
            modeled = bool(sc(th.get("modeled", False), "bool"))
        by_size = standard(size) if size else None
        major = float(std["major"]) if std is not None else (float(by_size["major"]) if by_size else None)
        thread_form = {"standard": th.get("standard") if isinstance(th, dict) else None, "major": major,
                       "starts": starts, "right_hand": right, "modeled": modeled}
    kind = "insert" if insert else "counterbore" if cbore else "countersink" if csink else "simple"
    head_field = None
    if cbore is not None:
        head_field = "/cbore/depth" if isinstance(cb, dict) else "/cbore"
    elif csink is not None:
        head_field = "/csink/d" if isinstance(cs, dict) else "/csink"
    spec = HoleSpec(d=d, kind=kind, depth_kind="blind", cbore=cbore, csink=csink, insert=insert,
                    thread=thread, thread_form=thread_form, size=size, head_field=head_field)
    dep = h.get("depth")
    if insert is not None:
        spec.depth_kind, spec.blind, spec.tip = "blind", insert[1], None
    elif dep == "through":
        spec.depth_kind = "through"
    elif isinstance(dep, dict) and "blind" in dep:
        spec.blind = _positive(sc(dep["blind"]), "/depth/blind")
        tip = h.get("tip", 118.0)
        spec.tip = None if tip == "flat" else _angle_open(sc(tip, "angle"), "/tip")
    elif isinstance(dep, dict) and "up_to" in dep:
        spec.depth_kind, spec.tip = "up_to", None
    if cbore is not None:
        if not cbore[0] > d:
            raise FeatureFailure("INVALID_VALUE", f"counterbore diameter {cbore[0]} must exceed the hole diameter {d}",
                                 {"field": "/cbore/d", "value": cbore[0], "expected": f"> {d}"})
    if csink is not None:
        if not csink[0] > d:
            raise FeatureFailure("INVALID_VALUE", f"countersink diameter {csink[0]} must exceed the hole diameter {d}",
                                 {"field": "/csink/d", "value": csink[0], "expected": f"> {d}"})
    if spec.depth_kind == "blind":
        check_head_depth(spec, spec.blind)
    return spec


def _csink_depth(spec: HoleSpec) -> float:
    """`hk = (Dk − D)/2 / tan(β/2)`: the depth at which the countersink cone reaches `D`."""
    return (spec.csink[0] - spec.d) / 2.0 / math.tan(math.radians(spec.csink[1] / 2.0))


def check_head_depth(spec: HoleSpec, h: float, at: str | None = None) -> None:
    """§6.5: the counterbore depth `hc` and the countersink depth `hk` are less than the hole depth
    `h` — the blind depth, or (W7b's reading, reported to the Contract stage: §6.5 states it for
    blind holes only, and `up_to` is "then as blind") each position's `up_to` depth — by more than
    *tol* ([R-3]: a head floor within *tol* of the hole's floor coincides with it; Forge's
    `hole::spec` reads it the same way). Otherwise the profile would fold back on itself (a pin
    left standing in the counterbore), so it is `INVALID_VALUE` with the feasible range:
    `hc < h − tol`, or `Dk < D + 2·(h − tol)·tan(β/2)`."""
    where = f" at {at}" if at is not None else ""
    if spec.cbore is not None and not h - spec.cbore[1] > TOL:
        raise FeatureFailure("INVALID_VALUE", f"counterbore depth {spec.cbore[1]} must be less than the hole depth {h}{where}",
                             {"field": spec.head_field or "/cbore/depth", "value": spec.cbore[1],
                              "expected": f"< {h - TOL!r}"})
    if spec.csink is not None and not h - _csink_depth(spec) > TOL:
        dk_max = spec.d + 2.0 * (h - TOL) * math.tan(math.radians(spec.csink[1] / 2.0))
        raise FeatureFailure("INVALID_VALUE",
                             f"the countersink ({_csink_depth(spec)!r} deep) must be shallower than the hole depth {h}{where}",
                             {"field": spec.head_field or "/csink/d", "value": spec.csink[0],
                              "expected": f"< {dk_max!r}"})


def placement(ev, st, h: dict) -> list[tuple[str, Any]]:
    """The placement's positions as `(id, (u, v))` for the plane forms, or `(id, P3)` for sketch
    points (projected later), with their numbers evaluated (step 1)."""
    at = h["at"]
    sc = lambda v, fld="length": ev.scalar(st, v, fld)  # noqa: E731
    if "list" in at:
        return [(p["id"], (sc(p["at"][0]), sc(p["at"][1]))) for p in at["list"]]
    if "grid" in at:
        g = at["grid"]
        nx, ny = _count(sc(g["nx"], "count"), "/at/grid/nx"), _count(sc(g["ny"], "count"), "/at/grid/ny")
        dx, dy = sc(g["dx"]), sc(g["dy"])
        c = g.get("center", [0.0, 0.0])
        cx, cy = sc(c[0]), sc(c[1])
        return [(f"g{i}_{j}", (cx + (i - (nx - 1) / 2.0) * dx, cy + (j - (ny - 1) / 2.0) * dy))
                for i in range(nx) for j in range(ny)]
    if "circle" in at:
        c = at["circle"]
        n = _count(sc(c["n"], "count"), "/at/circle/n")
        d = _positive(sc(c["d"]), "/at/circle/d")
        cc = c.get("center", [0.0, 0.0])
        cx, cy = sc(cc[0]), sc(cc[1])
        start = sc(c.get("start", 0.0), "angle")
        out = []
        for k in range(n):
            s, co = expr.sin_cos_deg(start + (360.0 * k) / n)
            out.append((f"c{k}", (cx + (d / 2.0) * co, cy + (d / 2.0) * s)))
        return out
    pts = at["points"]
    ev.dep(st, pts["sketch"], "SKETCH_SUPPRESSED")
    sk = st.sketches[pts["sketch"]]
    by_id: dict[str, tuple] = {}
    order: list[str] = []
    for c in sk.all_curves:
        if c["kind"] == "point":
            by_id[c["id"]] = tuple(c["at"])
            order.append(c["id"])
        elif c["kind"] == "circle":
            by_id[f"{c['id']}.center"] = tuple(c["center"])
    ids = order if pts["ids"] == "all" else list(pts["ids"])
    if not ids:
        raise FeatureFailure("INVALID_VALUE", "the sketch has no point", {"field": "/at/points/ids", "value": 0,
                                                                          "expected": "at least one sketch point"})
    out = []
    for i in ids:
        if i not in by_id:
            raise FeatureFailure("QUERY_UNKNOWN_CURVE", f"{i!r} is not a point of sketch {pts['sketch']!r}",
                                 {"feature": pts["sketch"], "curve": i, "similar": []})
        out.append((i, sk.plane.to3d(by_id[i])))
    return out


def _radial(d: tuple) -> tuple:
    """A deterministic unit vector perpendicular to d."""
    axes = [(1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)]
    a = min(axes, key=lambda x: (abs(geom.dot(x, d)), axes.index(x)))
    return geom.unit(geom.cross(d, a))


def profile(spec: HoleSpec, h: float, through: bool) -> list[tuple[str, tuple, tuple]]:
    """The tool profile `(role, (ρ0, y0), (ρ1, y1))` in the (ρ, y) half-plane (module docs)."""
    r = spec.d / 2.0
    out: list[tuple[str, tuple, tuple]] = []
    if spec.cbore is not None:
        rc, hc = spec.cbore[0] / 2.0, spec.cbore[1]
        out += [("top", (0.0, 0.0), (rc, 0.0)), ("cbore_wall", (rc, 0.0), (rc, hc)), ("cbore_floor", (rc, hc), (r, hc))]
        y0 = hc
    elif spec.csink is not None:
        rk = spec.csink[0] / 2.0
        hk = (rk - r) / math.tan(math.radians(spec.csink[1] / 2.0))
        out += [("top", (0.0, 0.0), (rk, 0.0)), ("csink", (rk, 0.0), (r, hk))]
        y0 = hk
    else:
        out.append(("top", (0.0, 0.0), (r, 0.0)))
        y0 = 0.0
    if not y0 < h:
        # The wall must run down the hole (`check_head_depth` rejects such holes first): a folded
        # profile revolves to a solid with a pin standing inside the head, whose closed-form volume
        # the tool gate would compute from the same folded profile — so fail explicitly.
        raise TopoError("ORACLE_HOLE_PROFILE_FOLDED",
                        f"the hole wall would run upwards (from depth {y0!r} to {h!r}): the head is deeper than the hole")
    out.append(("wall", (r, y0), (r, h)))
    if through:
        out.append(("end", (r, h), (0.0, h)))
        end = h
    elif spec.tip is None:
        out.append(("floor", (r, h), (0.0, h)))
        end = h
    else:
        end = h + r / math.tan(math.radians(spec.tip / 2.0))
        out.append(("tip", (r, h), (0.0, end)))
    out.append(("axis", (0.0, end), (0.0, 0.0)))
    return out


def profile_volume(prof: list) -> float:
    """Closed-form volume of the solid of revolution of the profile (Pappus on each segment's
    trapezoid against the axis: π/3·Δy·(ρ0² + ρ0ρ1 + ρ1²), signed by the traversal)."""
    v = 0.0
    for _, (r0, y0), (r1, y1) in prof:
        v += math.pi / 3.0 * (y1 - y0) * (r0 * r0 + r0 * r1 + r1 * r1)
    return abs(v)


def build_tool(fid: str, pid: str, order: int, spec: HoleSpec, p: tuple, d: tuple, h: float,
               through: bool, gate: list | None = None, nurbs: bool = False) -> Body:
    """The hole tool at position `p` (id `pid`) along `d`: the revolution of the §6.5 profile, keyed
    `H/<role>@p`. `nurbs`: converted to B-splines (exactly: rational), for a modelled thread's
    grooves to be fused with it (§8.3 rule 9)."""
    e = _radial(d)
    prof = profile(spec, h, through)

    def at(rho, y):
        return geom.add(p, geom.add(geom.mul(e, rho), geom.mul(d, y)))

    mw = BRepBuilderAPI_MakeWire()
    for _, a, b in prof:
        pa, pb = at(*a), at(*b)
        if geom.dist(pa, pb) <= 1e-12:
            continue
        mw.Add(BRepBuilderAPI_MakeEdge(gp_Pnt(*pa), gp_Pnt(*pb)).Edge())
    if not mw.IsDone():
        raise TopoError("OCCT_HOLE_TOOL_FAILED", f"hole {fid} position {pid}: the profile wire is not closed")
    face = BRepBuilderAPI_MakeFace(mw.Wire(), True).Face()
    rv = BRepPrimAPI_MakeRevol(face, gp_Ax1(gp_Pnt(*p), gp_Dir(*d)), 2.0 * math.pi)
    rv.Build()
    if not rv.IsDone():
        raise TopoError("OCCT_HOLE_TOOL_FAILED", f"hole {fid} position {pid}: the revolution failed")
    from .booleans import _solids

    sols = _solids(rv.Shape())
    if len(sols) != 1:
        raise TopoError("OCCT_HOLE_TOOL_FAILED", f"hole {fid} position {pid}: the tool is not one solid")
    solid = sols[0]
    gp = GProp_GProps()
    BRepGProp.VolumeProperties_s(solid, gp, False, False, False)
    exp = profile_volume(prof)
    if abs(gp.Mass() - exp) > TOOL_GATE_REL * max(exp, 1e-12):
        msg = f"hole {fid} position {pid}: tool volume {gp.Mass()!r} vs the closed form {exp!r}"
        if gate is not None:
            gate.append(msg)
        raise TopoError("OCCT_SELF_CHECK_FAILED", msg)
    if nurbs:
        # after the gate: the conversion is exact (rational), OCCT's fixed-order integrator on
        # rational patches is not
        from OCP.BRepBuilderAPI import BRepBuilderAPI_NurbsConvert
        from OCP.TopoDS import TopoDS

        solid = TopoDS.Solid_s(_solids(BRepBuilderAPI_NurbsConvert(solid, True).Shape())[0])
    body = Body(solid, fid, pid, order)
    body.build_topology()
    body.metrics = None
    targets = []
    for role, a, b in prof:
        if role == "axis":
            continue
        mid = ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
        # half a turn from the radial direction: away from the revolution's seam
        targets.append((f"{fid}/{role}@{pid}", geom.add(p, geom.add(geom.mul(e, -mid[0]), geom.mul(d, mid[1])))))
    body.assign_face_keys(targets)
    if body.naming_error:
        raise TopoError("OCCT_NAMING_FAILED", f"hole {fid} position {pid}: {body.naming_error}")
    body.key_edges_and_vertices(fid)
    return body


def ray_depth(face, p: tuple, d: tuple) -> float | None:
    """`up_to`: the smallest t ≥ tol with P + t·d on the face (None: no hit)."""
    best = None
    for piece in face.parts():
        it = IntCurvesFace_ShapeIntersector()
        it.Load(piece, 1e-9)
        it.Perform(gp_Lin(gp_Pnt(*p), gp_Dir(*d)), TOL, 1e300)
        if not it.IsDone():
            continue
        for i in range(1, it.NbPnt() + 1):
            t = it.WParameter(i)
            if t >= TOL and (best is None or t < best):
                best = t
    return best


def breaks_through(tool: Body, pid: str, fid: str, targets: list[Body]) -> bool:
    """The module's break-through reading: a blind hole does **not** break through iff its bottom
    face (tip or floor) lies inside a target's material and farther than *tol* from every target
    face — [R-3]: a bottom within *tol* of a face lies on it, so the hole opens there (a floor at
    exactly the far face, or 0.5e-6 mm past it, breaks through). Inside: an interior point of the
    bottom classified IN a target; the clearance: `BRepExtrema`'s minimum distance from the
    bottom face to the targets' shells (a minimum, so it is found, not sampled). Overlapping
    targets are read one by one (a bottom crossing from one target into another counts as open)."""
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.TopAbs import TopAbs_IN, TopAbs_SHELL

    from .booleans import _sub
    from .topo import face_interior_point

    bottom = [f for f in tool.faces if f.key in (f"{fid}/tip@{pid}", f"{fid}/floor@{pid}")]
    if not bottom:
        return False
    for f in bottom:
        for piece in f.parts():
            p = face_interior_point(piece)
            if not any(BRepClass3d_SolidClassifier(t.solid, gp_Pnt(*p), 1e-9).State() == TopAbs_IN for t in targets):
                return True
            for t in targets:
                for sh in _sub(t.solid, TopAbs_SHELL):
                    d = BRepExtrema_DistShapeShape(piece, sh)
                    if d.IsDone() and d.NbSolution() > 0 and d.Value() <= TOL:
                        return True
    return False


def hole_feature(ev, st, fi: int, f: dict, entry: dict, refs: list, fs) -> None:
    from .booleans import apply_body_op, meets
    from .evaluate import face_frame

    warns = entry["warnings"]
    fid = f["id"]
    # 1. field values (and the `on` PlaneRef's own numbers)
    spec = hole_spec(ev, st, f)
    raw = placement(ev, st, f)
    on = f["on"]
    origin = xdir = None
    if isinstance(on, dict) and "face" in on:
        origin = ev.p3(st, on["origin"]) if "origin" in on else None
        xdir = ev.p3(st, on["x_dir"], "ratio") if "x_dir" in on else None
    flip = bool(ev.scalar(st, f.get("flip", False), "bool"))
    # 2. references, in field order
    on_face = None
    if isinstance(on, dict) and "face" in on:
        (on_face,) = ev.resolve(st, on["face"], "one", "/on/face", refs, warns)
        plane = face_frame(on_face, origin, xdir)
    else:
        plane = ev.plane_ref(st, on, "/on", refs, warns)
    up_to = None
    if spec.depth_kind == "up_to":
        (up_to,) = ev.resolve(st, f["depth"]["up_to"], "one", "/depth/up_to", refs, warns)
    tg = f.get("targets")
    if tg is None:
        targets = [on_face.body]
    elif tg == "all":
        targets = list(st.bodies)
    else:
        targets = list(ev.resolve(st, tg, "some", "/targets", refs, warns))
    # 3. the operation
    n = plane.normal
    d = n if flip else geom.mul(n, -1.0)
    positions: list[HolePos] = []
    for pid, v in raw:
        if len(v) == 3:  # a sketch point: projected along n onto the placement plane
            q = geom.sub(v, geom.mul(n, geom.dot(geom.sub(v, plane.origin), n)))
            rel = geom.sub(q, plane.origin)
            uv = (geom.dot(rel, plane.x), geom.dot(rel, plane.y))
        else:
            uv = v
        positions.append(HolePos(pid, uv, plane.to3d(uv)))
    for k, a in enumerate(positions):
        for b in positions[:k]:
            dist = geom.dist(a.point, b.point)
            if dist <= TOL:
                raise FeatureFailure("HOLE_DUPLICATE_POSITION", f"positions {b.id} and {a.id} coincide",
                                     {"at": a.id, "distance": dist})
    if on_face is not None:
        for p in positions:
            dist = on_face.distance(p.point)
            if dist > TOL:
                raise FeatureFailure("HOLE_POINT_OFF_FACE", f"position {p.id} is {dist:.6g} mm off the placement face",
                                     {"at": p.id, "distance": dist})
    depths: dict[str, float] = {}
    if spec.depth_kind == "up_to":
        for p in positions:
            t = ray_depth(up_to, p.point, d)
            if t is None:
                raise FeatureFailure("HOLE_UP_TO_MISSED", f"position {p.id}: the up-to face is not hit along the hole axis",
                                     {"at": p.id})
            depths[p.id] = t
        # the head must end above each position's floor, as for blind holes (the shallowest decides)
        shallow = min(positions, key=lambda p: (depths[p.id], positions.index(p)))
        check_head_depth(spec, depths[shallow.id], shallow.id)
    scale = max([1.0] + [math.dist(b.body_metrics()["bbox_min"], b.body_metrics()["bbox_max"]) for b in targets])
    modeled = spec.thread_form is not None and spec.thread_form["modeled"]
    if modeled and spec.thread_form["major"] is None:
        raise FeatureFailure("HOLE_OPTIONS_CONFLICT",
                             "a modelled thread needs a size or thread.standard (its major diameter)",
                             {"field": "thread", "allowed": {"standard": "required for a modelled thread without size"}})
    tools: list[Body] = []
    for p in positions:
        if spec.depth_kind == "through":
            reach = 0.0
            for b in targets:
                lo, hi = b.body_metrics()["bbox_min"], b.body_metrics()["bbox_max"]
                for cx in (lo[0], hi[0]):
                    for cy in (lo[1], hi[1]):
                        for cz in (lo[2], hi[2]):
                            reach = max(reach, geom.dot(geom.sub((cx, cy, cz), p.point), d))
            # the head's depth (counterbore floor or countersink cone): the wall starts there, so
            # the through tool must reach past it as well as past the targets — a countersink
            # deeper than a thin plate is a valid document (§6.5 bounds the head only for blind
            # holes), not a folded profile
            y0 = spec.cbore[1] if spec.cbore else (_csink_depth(spec) if spec.csink else 0.0)
            h = max(reach, y0) + max(1.0, 0.01 * scale)
            tools.append(build_tool(fid, p.id, fi, spec, p.point, d, h, True, ev.gate, nurbs=modeled))
        else:
            h = depths[p.id] if spec.depth_kind == "up_to" else spec.blind
            tools.append(build_tool(fid, p.id, fi, spec, p.point, d, h, False, ev.gate, nurbs=modeled))
    for p, k in zip(positions, tools):
        if not any(meets(t.solid, [k.solid]) for t in targets):
            raise FeatureFailure("HOLE_MISSES_BODY", f"the hole at {p.id} meets no target", {"at": p.id})
    through_warn = []
    if spec.depth_kind != "through":
        for p, k in zip(positions, tools):
            if breaks_through(k, p.id, fid, targets):
                through_warn.append(p.id)
    grooves: list[Body] = []
    if modeled:
        from .threads import hole_grooves

        grooves = hole_grooves(ev, fid, fi, spec, positions, d, plane.x, depths, targets)
    apply_body_op(ev, st, fid, fi, "cut", targets, tools + grooves, entry, keep_tools=False)
    if modeled:
        from .threads import normalized

        normalized(entry)
    for pid in through_warn:
        warns.append({"code": "HOLE_BREAKS_THROUGH", "severity": "warning",
                      "message": f"the blind hole at {pid} breaks through", "details": {"at": pid}})
    entry["holes"] = [hole_report(spec, p, d, depths.get(p.id)) for p in positions]
    fs.seed = HoleSeed(tools=tools, positions=positions, spec=spec, direction=d)


def hole_report(spec: HoleSpec, p: HolePos, d: tuple, up_to: float | None) -> dict:
    depth = None if spec.depth_kind == "through" else (up_to if spec.depth_kind == "up_to" else spec.blind)
    out: dict = {"at": p.id, "center": list(p.point), "axis": list(d), "d": spec.d, "depth": depth,
                 "kind": spec.kind}
    if spec.size:
        out["size"] = spec.size
    if spec.cbore:
        out["cbore"] = {"d": spec.cbore[0], "depth": spec.cbore[1]}
    if spec.csink:
        out["csink"] = {"d": spec.csink[0], "angle": spec.csink[1]}
    if spec.insert:
        out["insert"] = {"d": spec.insert[0], "depth": spec.insert[1]}
    if spec.thread:
        t: dict = {}
        if spec.size:
            t["size"] = spec.size
        t["pitch"] = spec.thread[0]
        t["depth"] = spec.thread[1] if spec.thread[1] is not None else depth
        tf = spec.thread_form or {}
        if tf.get("standard") is not None:
            t["standard"] = tf["standard"]
        if tf.get("major") is not None and (tf.get("modeled") or tf.get("standard") is not None):
            t["major"] = tf["major"]
        if tf.get("modeled"):
            t["modeled"] = True
        out["thread"] = t
    return out


__all__ = ["hole_feature", "hole_spec", "build_tool", "profile", "profile_volume", "HoleSeed", "count_shells"]
