"""Modelled threads with OCCT (SPEC-v1 §6.5 `thread.modeled`, §6.13 `thread`; FM9 stretch).

The oracle builds the **groove** of each start as an OCCT sweep of the 60° basic profile along a
helix (`BRepOffsetAPI_MakePipeShell` in Frenet mode, through build123d: the Frenet frame of a
circular helix turns the meridian profile rigidly with the screw motion), clips it to the
thread's axial range `[z_a, z_b]` with a cylinder, keys its faces like Forge (`F/thread_upper`,
`F/thread_lower`, `F/thread_root`, `F/thread_end_start`, `F/thread_end_end`, a hole's position
as `@p`, start `j > 0` as `:s<j>`) and **cuts** it from the part (`booleans.apply_body_op`): a
hole's grooves in the hole's own cut, together with the hole tool converted to B-splines
(`holes.build_tool(nurbs=True)`); a `thread` feature's from its target converted to B-splines
(`nurbs_targets`). OCCT intersects the swept flanks with analytic faces unreliably (a whole groove
lost, or cut short, depending on where a cylinder's seam lies) and reliably with B-spline faces
(SPEC-v1 §8.3 rule 9).
The profile reaches past the crest into the void by `0.4·crest_flat / (2 tan 30°)` (never
past the neighbouring turn), so the cut has no coincident crest faces.

This is a **different construction** from Forge's (direct B-rep of exact helicoids): the
differential compares what matters for printing — volume, area, box, validity — while face types
differ by design (OCCT's swept flanks are B-splines; `helicoid` has no OCCT counterpart: §8.3
rule 9, `ORACLE_NORMALIZED`). The
groove tool's volume is gated against the closed form `(z_b − z_a)·(2π/P)·∫ r·w(r) dr`
(`THREAD_GATE_REL`: OCCT's sweep approximates the helicoid).
"""

from __future__ import annotations

import math

import build123d as bd
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Cylinder, GeomAbs_Plane
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape

from . import consts, geom
from .consts import LINEAR_TOLERANCE
from .sweeps import FeatureFailure
from .topo import Body, TopoError

TOL = LINEAR_TOLERANCE
TAN30 = 1.0 / math.sqrt(3.0)
#: The groove-tool volume gate (closed form vs the OCCT sweep), relative.
THREAD_GATE_REL = 1e-4
#: A thread end inside its face lies at least this far from the face's end circle (Forge's
#: `END_MARGIN`).
END_MARGIN = 1e-3
MIN_CREST_FLAT = 0.02


def standard(designation: str) -> dict | None:
    """The `THREAD_STANDARDS` row of a designation (case, spaces and `×` ignored; `M8x1.25`
    names the coarse `M8`)."""
    table = consts.constants()["THREAD_STANDARDS"]["threads"]

    def key(s: str) -> str:
        return "".join("X" if c == "×" else c.upper() for c in s if not c.isspace())

    k = key(designation)
    for name, row in table.items():
        rk = key(name)
        if rk == k:
            return {"designation": name, **row}
        if row["family"] == "metric_coarse":
            p = ("%r" % row["pitch"]).rstrip("0").rstrip(".") if isinstance(row["pitch"], float) else str(row["pitch"])
            if k == f"{rk}X{p}":
                return {"designation": name, **row}
    return None


class Form:
    """The 60° basic profile (Forge's `ThreadForm`)."""

    def __init__(self, internal: bool, major: float, pitch: float, starts: int, right_hand: bool):
        self.internal, self.major, self.pitch = internal, major, pitch
        self.starts, self.right_hand = starts, right_hand
        h = pitch * math.sqrt(3.0) * 0.5
        self.minor = major - 1.25 * h
        self.rr = 0.5 * major if internal else 0.5 * self.minor
        self.w_root = pitch / 8.0 if internal else pitch / 4.0
        self.sigma = 1.0 if internal else -1.0
        lead = starts * pitch
        self.h = (lead if right_hand else -lead) / (2.0 * math.pi)

    def width(self, r: float) -> float:
        return self.w_root + 2.0 * abs(self.rr - r) * TAN30

    def crest_range(self) -> tuple[float, float]:
        reach = (self.pitch * (1.0 - MIN_CREST_FLAT) - self.w_root) / (2.0 * TAN30)
        depth = self.w_root
        if self.internal:
            return 2.0 * (self.rr - reach), 2.0 * (self.rr - depth)
        return 2.0 * (self.rr + depth), 2.0 * (self.rr + reach)

    def check_crest(self, d: float) -> None:
        lo, hi = self.crest_range()
        if not (lo <= d <= hi):
            raise FeatureFailure(
                "THREAD_DIAMETER_MISMATCH",
                f"the {'internal' if self.internal else 'external'} thread needs a crest diameter in [{lo}, {hi}] mm, the face has {d} mm",
                {"kind": "internal" if self.internal else "external",
                 "designation": f"D {self.major} × P {self.pitch}", "d": d, "min_d": lo, "max_d": hi})

    def flank(self, j: int, up: bool) -> tuple[float, float]:
        base = j * self.pitch
        half = 0.5 * self.w_root + self.sigma * self.rr * TAN30
        return (base + half, -self.sigma * TAN30) if up else (base - half, self.sigma * TAN30)


def _moment(form: Form, a: float, b: float) -> float:
    """`∫ r·w(r) dr` over `[a, b]` (w linear: Simpson is exact)."""
    n = 64
    h = (b - a) / n
    g = lambda r: r * form.width(r)  # noqa: E731
    return sum(h / 6.0 * (g(a + i * h) + 4.0 * g(a + i * h + h / 2.0) + g(a + i * h + h)) for i in range(n))


def groove_tool(fid: str, qual: str | None, order: int, form: Form, rc: float, origin, x_dir, z_dir,
                za: float, zb: float, gate: list | None = None) -> list[Body]:
    """The keyed groove tools (one per start) of a thread in the frame `(origin, x_dir, z_dir)`
    over `[za, zb]`, crest radius `rc`."""
    crest_flat = form.pitch - form.width(rc)
    delta = 0.4 * crest_flat / (2.0 * TAN30)
    rin = rc - delta if form.internal else rc + delta
    lead = form.starts * form.pitch
    plane = bd.Plane(origin=bd.Vector(*origin), x_dir=bd.Vector(*x_dir), z_dir=bd.Vector(*z_dir))
    tools = []
    for j in range(form.starts):
        zc = j * form.pitch  # groove centre at θ = 0
        pts = [(rin, zc - form.width(rin) / 2.0), (form.rr, zc - form.w_root / 2.0),
               (form.rr, zc + form.w_root / 2.0), (rin, zc + form.width(rin) / 2.0)]
        # Start the sweep a whole number of leads below za so the profile at θ = 0 sits at z0.
        k = math.floor((za - zc) / lead) - 2
        z0 = zc + k * lead
        height = (zb + 2.0 * lead) - z0
        wire = bd.Polyline(*[(x, 0.0, z - zc + z0) for x, z in pts], close=True)
        face = bd.Face(wire)
        helix = bd.Helix(pitch=lead, height=height, radius=form.rr, center=(0, 0, z0),
                         lefthand=not form.right_hand)
        swept = bd.Solid.sweep(face, helix, is_frenet=True)
        rmax = max(rc, form.rr) + 1.0
        slab = bd.Solid.make_cylinder(rmax, zb - za, bd.Plane(origin=(0, 0, za)))
        clipped = swept & slab
        sols = clipped.solids()
        if len(sols) != 1:
            raise TopoError("OCCT_THREAD_TOOL_FAILED", f"thread {fid}: the groove of start {j} is {len(sols)} solids")
        local = sols[0]
        a, b = (rin, form.rr) if form.internal else (form.rr, rin)
        exact = (zb - za) * 2.0 * math.pi / form.pitch * _moment(form, a, b) / form.starts
        if abs(local.volume - exact) > THREAD_GATE_REL * exact:
            msg = f"thread {fid} start {j}: groove volume {local.volume!r} vs the closed form {exact!r}"
            if gate is not None:
                gate.append(msg)
            raise TopoError("OCCT_SELF_CHECK_FAILED", msg)
        moved = plane.location * local
        solid = moved.wrapped if hasattr(moved, "wrapped") else moved
        body = Body(TopoDS.Solid_s(solid), fid, f"thread{j}" if qual is None else f"{qual}.thread{j}", order)
        body.build_topology()
        body.metrics = None
        # Construction points in thread-frame coordinates (ρ, θ, z) → world.
        def world(rho, th, z):
            return geom.add(origin, geom.add(geom.add(geom.mul(x_dir, rho * math.cos(th)),
                                                        geom.mul(geom.cross(z_dir, x_dir), rho * math.sin(th))),
                                               geom.mul(z_dir, z)))
        zmid = 0.5 * (za + zb)
        rmid = 0.5 * (rin + form.rr)
        src = "" if j == 0 else f":s{j}"
        q = "" if qual is None else f"@{qual}"
        targets = []
        for up, role in ((True, "thread_upper"), (False, "thread_lower")):
            c, kk = form.flank(j, up)
            th = (zmid - c - kk * rmid) / form.h
            targets.append((f"{fid}/{role}{src}{q}", world(rmid, th, zmid)))
        th = (zmid - zc) / form.h
        targets.append((f"{fid}/thread_root{src}{q}", world(form.rr, th, zmid)))
        targets.append((f"{fid}/thread_void{src}{q}", world(rin, th, zmid)))
        for ze, role in ((za, "thread_end_start"), (zb, "thread_end_end")):
            th = (ze - zc) / form.h
            targets.append((f"{fid}/{role}{src}{q}", world(rmid, th, ze)))
        body.assign_face_keys(targets)
        if body.naming_error:
            raise TopoError("OCCT_NAMING_FAILED", f"thread {fid}: {body.naming_error}")
        body.key_edges_and_vertices(fid)
        tools.append(body)
    return tools


def form_of(major: float, pitch: float, starts: int, right_hand: bool, internal: bool) -> Form:
    if not (math.isfinite(pitch) and pitch > 1e-3):
        raise FeatureFailure("THREAD_INVALID_VALUE", f"pitch = {pitch} is invalid", {"field": "pitch", "value": pitch, "expected": "> 0.001 mm"})
    if not (math.isfinite(major) and major > 2.0 * pitch):
        raise FeatureFailure("THREAD_INVALID_VALUE", f"major = {major} is invalid", {"field": "major", "value": major, "expected": "> 2 × pitch"})
    return Form(internal, major, pitch, starts, right_hand)


def _starts(ev, st, v) -> int:
    n = ev.scalar(st, v, "count")
    if not (math.isfinite(n) and n == math.floor(n) and 1 <= n <= 8):
        raise FeatureFailure("INVALID_COUNT", f"starts = {n}: must be an integer in [1, 8]",
                             {"field": "starts", "value": n, "expected": "an integer in [1, 8]"})
    return int(n)


# ---- the thread feature (§6.13) ---------------------------------------------------------------

def _face_ends(face_shape, solid):
    """The two boundary circles' centres of a cylinder face, and whether the plane next to each
    opens away from the cylinder; None if the face is not a two-circle band."""
    circles = []
    ex = TopExp_Explorer(face_shape, TopAbs_EDGE)
    seen = []
    while ex.More():
        e = TopoDS.Edge_s(ex.Current())
        ex.Next()
        if any(e.IsSame(s) for s in seen):
            continue
        seen.append(e)
        c = BRepAdaptor_Curve(e)
        if c.GetType() == GeomAbs_Circle:
            circles.append(e)
    if len(circles) != 2:
        return None
    m = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(solid, TopAbs_EDGE, TopAbs_FACE, m)
    centres, normals = [], []
    for e in circles:
        c = BRepAdaptor_Curve(e).Circle()
        centres.append((c.Location().X(), c.Location().Y(), c.Location().Z()))
        n = None
        for f in m.FindFromKey(e):
            f = TopoDS.Face_s(f)
            if f.IsSame(face_shape):
                continue
            s = BRepAdaptor_Surface(f)
            if s.GetType() == GeomAbs_Plane:
                d = s.Plane().Axis().Direction()
                v = (d.X(), d.Y(), d.Z())
                if f.Orientation() == TopAbs_REVERSED:
                    v = geom.mul(v, -1.0)
                n = v
        normals.append(n)
    c0, c1 = centres
    def away(i):
        this, other = (c0, c1) if i == 0 else (c1, c0)
        n = normals[i]
        return n is not None and geom.dot(n, geom.sub(this, other)) > 0.0
    return centres, [away(0), away(1)]


def thread_feature(ev, st, fi: int, f: dict, entry: dict, refs: list) -> None:
    from .booleans import apply_body_op

    warns = entry["warnings"]
    fid = f["id"]
    sc = lambda v, fld="length": ev.scalar(st, v, fld)  # noqa: E731
    std = None
    if "standard" in f:
        std = standard(f["standard"])
        if std is None:
            raise FeatureFailure("THREAD_STANDARD_UNKNOWN", f"{f['standard']!r} is not a thread designation",
                                 {"field": "standard", "value": f["standard"]})
    major = sc(f["major"]) if "major" in f else (std["major"] if std else None)
    pitch = sc(f["pitch"]) if "pitch" in f else (std["pitch"] if std else None)
    if major is None or pitch is None:
        raise FeatureFailure("THREAD_SIZE_REQUIRED", "a thread needs a standard designation, or both major and pitch",
                             {"field": "standard", "allowed": ["standard", "major + pitch"]})
    length = sc(f["length"]) if "length" in f else None
    offset = sc(f["offset"]) if "offset" in f else 0.0
    starts = _starts(ev, st, f["starts"]) if "starts" in f else 1
    flip = bool(sc(f.get("flip", False), "bool"))
    modeled = bool(sc(f.get("modeled", True), "bool"))
    right = f.get("hand", "right") == "right"
    (face,) = ev.resolve(st, f["face"], "one", "/face", refs, warns)
    s = BRepAdaptor_Surface(face.shape)
    if s.GetType() != GeomAbs_Cylinder:
        raise FeatureFailure("THREAD_FACE_UNSUPPORTED", "the face is not a cylinder", {"face": face.key, "reason": "not a cylinder"})
    cyl = s.Cylinder()
    rc = cyl.Radius()
    ends = _face_ends(face.shape, face.body.solid)
    if ends is None:
        raise FeatureFailure("THREAD_FACE_UNSUPPORTED", "a threadable cylinder is bounded by two full circles",
                             {"face": face.key, "reason": "not a two-circle band"})
    centres, opens = ends
    if opens[0] and not opens[1]:
        k = 0
    elif opens[1] and not opens[0]:
        k = 1
    else:
        a, b = centres
        k = 1 if (b[2], b[1], b[0]) > (a[2], a[1], a[0]) else 0
    if flip:
        k = 1 - k
    p0, p1 = centres[k], centres[1 - k]
    span = geom.dist(p0, p1)
    z_dir = geom.mul(geom.sub(p1, p0), 1.0 / span)
    xd = cyl.Position().XDirection()
    x0 = (xd.X(), xd.Y(), xd.Z())
    x_dir = geom.sub(x0, geom.mul(z_dir, geom.dot(x0, z_dir)))
    x_dir = geom.mul(x_dir, 1.0 / math.sqrt(geom.dot(x_dir, x_dir)))
    # Material side: OCCT's cylinder normal points away from the axis on a direct cylinder; the
    # face's orientation flips it. Normal away from the axis = material inside = a boss.
    outward_out = cyl.Direct() == (face.shape.Orientation() != TopAbs_REVERSED)
    internal = not outward_out
    form = form_of(major, pitch, starts, right, internal)
    form.check_crest(2.0 * rc)
    ln = length if length is not None else span - offset
    za, zb = offset, offset + ln
    if abs(zb - span) <= TOL:
        zb = span
    if modeled and not (zb - za > END_MARGIN):
        raise FeatureFailure("THREAD_INVALID_VALUE", f"length = {zb - za} is invalid",
                             {"field": "length", "value": zb - za, "expected": f"> {END_MARGIN} mm"})
    if zb > span + TOL or za < 0.0:
        raise FeatureFailure("THREAD_LENGTH_OUT_OF_RANGE", "the thread runs past the face",
                             {"face": face.key, "start": za, "end": zb, "face_start": 0.0, "face_end": span})
    entry["thread"] = {
        "face": face.key, "kind": "internal" if internal else "external",
        **({"standard": std["designation"]} if std else {}),
        "major": major, "pitch": pitch, "minor": form.minor, "crest_d": 2.0 * rc,
        "length": zb - za, "offset": za, "starts": starts, "hand": "right" if right else "left",
        "modeled": modeled,
    }
    if not modeled:
        return
    # The ends (Forge's order): each on an end circle or at least END_MARGIN inside the face, at
    # least one on an end circle; then the thread's region must be clear.
    for ze, fe in ((za, 0.0), (zb, span)):
        gap = abs(ze - fe)
        if TOL < gap < END_MARGIN:
            raise FeatureFailure("THREAD_END_TOO_CLOSE", f"a thread end lies {gap} mm from the end of {face.key}",
                                 {"face": face.key, "distance": gap, "margin": END_MARGIN})
    on_ring = (za <= TOL, zb >= span - TOL)
    if not any(on_ring):
        raise FeatureFailure("THREAD_END_UNSUPPORTED", "both thread ends are inside the face",
                             {"face": face.key,
                              "reason": "a thread must start at an end of its cylinder (both ends are inside it)"})
    _check_clear(face, form, rc, p0, z_dir, za, zb, [(p0, on_ring[0]), (p1, on_ring[1])])
    tools = groove_tool(fid, None, fi, form, rc, p0, x_dir, z_dir, za, zb, ev.gate)
    apply_body_op(ev, st, fid, fi, "cut", [face.body], tools, entry, keep_tools=False, nurbs_targets=True)
    normalized(entry)


def normalized(entry: dict) -> None:
    """§8.3 rule 9: the body's thread faces and edges are OCCT B-spline sweeps."""
    entry["warnings"].append({"code": "ORACLE_NORMALIZED", "severity": "info",
                              "message": "§8.3 rule 9 (thread flanks, crest and root as B-spline sweeps)",
                              "details": {"rule": "9"}})


#: Forge's `CLEARANCE`: the thread's region grows by ten times the linear tolerance.
CLEARANCE = 10.0 * LINEAR_TOLERANCE


def _radial(p, origin, z_dir) -> float:
    r = geom.sub(p, origin)
    return math.sqrt(max(0.0, geom.dot(r, r) - geom.dot(r, z_dir) ** 2))


def _edge_radial_range(edge_shape, origin, z_dir, n: int = 256) -> tuple[float, float]:
    c = BRepAdaptor_Curve(edge_shape)
    t0, t1 = c.FirstParameter(), c.LastParameter()
    rs = []
    for i in range(n + 1):
        q = c.Value(t0 + (t1 - t0) * i / n)
        rs.append(_radial((q.X(), q.Y(), q.Z()), origin, z_dir))
    return min(rs), max(rs)


def _check_clear(face, form, rc, origin, z_dir, za, zb, ends) -> None:
    """§6.13 `THREAD_INTERFERENCE` (Forge's `clear::check`): the region
    `ρ ∈ [min(R_c, R_r) − m, max(R_c, R_r) + m]`, `z ∈ [z_a − m, z_b + m]` (`m` = `CLEARANCE`) holds no
    face of the body but the crest and the faces the thread ends on, and a plane it ends on keeps
    its other boundary radially out of it. Measured exactly here (OCCT sections, sampled edges),
    where Forge decides by conservative bounds."""
    m = CLEARANCE
    r_lo, r_hi = min(rc, form.rr) - m, max(rc, form.rr) + m
    z_lo, z_hi = za - m, zb + m
    body = face.body
    region = {"r_in": r_lo, "r_out": r_hi, "z_start": z_lo, "z_end": z_hi}
    ring_faces: list = []
    for e in body.edges_of_face(face):
        ax = e.circle_axis() if e.type == "circle" else None
        if ax is None:
            continue
        for centre, on in ends:
            if on and geom.dist(ax.origin, centre) < 1e-6 * max(1.0, rc):
                for nb in body.faces_of_edge(e):
                    if nb is face or nb in ring_faces:
                        continue
                    ring_faces.append(nb)
                    if nb.type == "plane":
                        for other in body.edges_of_face(nb):
                            if other is e:
                                continue
                            for piece in other.parts():
                                lo, hi = _edge_radial_range(piece, origin, z_dir)
                                if not (hi < r_lo or lo > r_hi):
                                    raise FeatureFailure("THREAD_INTERFERENCE",
                                                         f"face {nb.key} reaches into the thread's region",
                                                         {"face": nb.key, **region})
    tube = _region_tube(origin, z_dir, r_lo, r_hi, z_lo, z_hi)
    for f in body.faces:
        if f is face or f in ring_faces:
            continue
        _clear_of(f, tube, region)


def _region_tube(origin, z_dir, r_lo, r_hi, z_lo, z_hi):
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    base = geom.add(origin, geom.mul(z_dir, z_lo))
    ax2 = gp_Ax2(gp_Pnt(*base), gp_Dir(*z_dir))
    outer = BRepPrimAPI_MakeCylinder(ax2, r_hi, z_hi - z_lo).Shape()
    inner = BRepPrimAPI_MakeCylinder(ax2, max(r_lo, 1e-9), z_hi - z_lo).Shape()
    return BRepAlgoAPI_Cut(outer, inner).Shape()


def _clear_of(f, tube, region) -> None:
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    for piece in f.parts():
        g = GProp_GProps()
        BRepGProp.SurfaceProperties_s(BRepAlgoAPI_Common(piece, tube).Shape(), g)
        if g.Mass() > 1e-12:
            raise FeatureFailure("THREAD_INTERFERENCE", f"face {f.key} reaches into the thread's region",
                                 {"face": f.key, **region})


def _hole_clear(targets, form, rc, origin, z_dir, za, zb) -> None:
    """`THREAD_INTERFERENCE` for a hole's modelled thread, checked on its targets before the cut
    (the bore does not exist yet): the planes across the axis at the thread's ends (the entry, a
    through hole's exit, a flat floor) keep their boundary radially out of the region; no other
    face enters it."""
    m = CLEARANCE
    r_lo, r_hi = min(rc, form.rr) - m, max(rc, form.rr) + m
    z_lo, z_hi = za - m, zb + m
    region = {"r_in": r_lo, "r_out": r_hi, "z_start": z_lo, "z_end": z_hi}
    tube = _region_tube(origin, z_dir, r_lo, r_hi, z_lo, z_hi)
    for b in targets:
        for f in b.faces:
            n = f.plane_normal()
            if n is not None and geom.dist(geom.cross(n, z_dir), (0.0, 0.0, 0.0)) <= 1e-9:
                h = geom.dot(geom.sub(f.point(), origin), z_dir)
                if min(abs(h - za), abs(h - zb)) <= TOL:
                    for e in b.edges_of_face(f):
                        for piece in e.parts():
                            lo, hi = _edge_radial_range(piece, origin, z_dir)
                            if not (hi < r_lo or lo > r_hi):
                                raise FeatureFailure("THREAD_INTERFERENCE",
                                                     f"face {f.key} reaches into the thread's region",
                                                     {"face": f.key, **region})
                    continue
            _clear_of(f, tube, region)


# ---- modelled hole threads (§6.5) -------------------------------------------------------------

def hole_grooves(ev, fid: str, fi: int, spec, positions, d, x_dir, depths: dict, targets) -> list[Body]:
    """The groove tools of a hole's modelled thread at every position: cut together with the
    (B-spline) hole tools in the hole's one cut, `targets` the hole's targets before it."""
    th = spec.thread_form
    form = form_of(th["major"], spec.thread[0], th["starts"], th["right_hand"], True)
    form.check_crest(spec.d)
    y0 = spec.cbore[1] if spec.cbore else (_csink_top(spec) if spec.csink else 0.0)
    tools = []
    for p in positions:
        explicit = spec.thread[1]
        hole_depth = depths.get(p.id)
        if spec.depth_kind == "blind":
            hole_depth = spec.blind
        zb = explicit if explicit is not None else hole_depth
        if hole_depth is not None and zb is not None:
            zb = min(zb, hole_depth)
        if zb is None:
            # A through hole: to the wall's far end, found on a line parallel to the axis through
            # the thread's annulus (material only next to the wall: Forge refuses any other face
            # there, THREAD_INTERFERENCE). The groove ends on the exit face, as Forge's does: a
            # groove reaching past it into the air is the same cut in exact arithmetic, but OCCT's
            # Cut then loses the whole groove (seen on a -z sweep through a plate).
            zb = _wall_exit(targets, p.point, x_dir, d, 0.5 * (0.5 * spec.d + form.rr))
            if zb is None:
                raise TopoError("OCCT_THREAD_TOOL_FAILED", f"hole {fid} position {p.id}: no wall end on the axis")
        _hole_clear(targets, form, 0.5 * spec.d, p.point, d, y0, zb)
        tools.extend(groove_tool(fid, p.id, fi, form, 0.5 * spec.d, p.point, x_dir, d, y0, zb, ev.gate))
    return tools


def _wall_exit(targets, point, x_dir, d, radius: float) -> float | None:
    """The largest `t` where the line `point + radius·x_dir + t·d` crosses a target's boundary."""
    from OCP.gp import gp_Dir, gp_Lin, gp_Pnt
    from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector

    o = geom.add(point, geom.mul(x_dir, radius))
    best = None
    for b in targets:
        it = IntCurvesFace_ShapeIntersector()
        it.Load(b.solid, 1e-9)
        it.Perform(gp_Lin(gp_Pnt(*o), gp_Dir(*d)), -1e300, 1e300)
        if not it.IsDone():
            continue
        for i in range(1, it.NbPnt() + 1):
            t = it.WParameter(i)
            if best is None or t > best:
                best = t
    return best


def _csink_top(spec) -> float:
    dk, beta = spec.csink
    return (0.5 * dk - 0.5 * spec.d) / math.tan(math.radians(beta) / 2.0)
