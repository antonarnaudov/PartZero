"""Fillet, chamfer, shell and draft (SPEC-v1 §6.6–§6.9) with OCCT, per §8.3 rules 4–8.

Shared rules:

* **Supported edges** (§6.6, §6.7): an edge between two different faces of one body, each a
  plane, cylinder, cone, sphere or torus, the edge not `smooth` (§5.3: the material angle within
  `QUERY_ANGLE_TOLERANCE` of 180°); else `FILLET_EDGE_UNSUPPORTED` / `CHAMFER_EDGE_UNSUPPORTED`,
  details `{ edges: [{ key, name, reason }] }`, `reason` `boundary`, `surface-type` or `smooth`.
* **Chain expansion** (`tangent_chain`, default true): repeatedly add every edge that shares a
  vertex with an edge of the set, whose tangent there continues the set edge's within
  `TANGENT_CHAIN_TOLERANCE` and whose convexity is the same; the added edges are reported in
  `chain_added` (keys). OCCT's `BRepFilletAPI_*::Add` propagates along tangent edges by itself: the
  oracle checks after the build that exactly the expanded set was blended (else the engine-internal
  `ORACLE_BLEND_PROPAGATION`, ROBUSTNESS) — with `tangent_chain: false` next to a tangent
  continuation OCCT cannot do what §6.6 asks.
* **Atomic**: any failure fails the feature (it passes its input through).
* **Feasibility**: for line edges between two planes and for full circles between a plane
  perpendicular to their axis and a coaxial cylinder or cone, the width limit is computed
  analytically (§6.6 "the width of the narrowest adjacent planar face across the edge",
  `_width_limits`): the blend's setback (`r / |tan(θ/2)|` for a fillet, θ the material angle —
  the concave form `r / tan((2π − θ)/2)` is the same number; for a chamfer `d` on the `side` face
  and the symmetric form, `d2` — fixed, not scaled with `d` — or `d·tan(angle)` on the other face)
  must leave at least *tol* of each adjacent face's extent across the edge, measured on the face's
  own side of the edge, and two blended edges bounding one face from opposite sides must leave
  *tol* of it together (the limit is exclusive by *tol* — at the face's extent itself the face
  vanishes); otherwise `FILLET_RADIUS_TOO_LARGE` / `CHAMFER_DISTANCE_TOO_LARGE` — also when OCCT
  would build a (self-overlapping or face-consuming) result. The width is the **narrowest across
  the edge** (W7b review 3): on a line edge's plane, the nearest other boundary of the face ahead
  of the edge within its span (`_nearest_ahead`: a hole 2 mm from the edge makes the width 2 mm,
  whatever the face's full extent), the edges sharing a vertex with it excepted (the faces across
  them trim the blend's ends); on a circle's plane, the nearest (outside) or farthest (inside)
  other boundary from the centre (`_dist_range`). Each limit names its rule (§6.6 `limit`):
  `face-width` for one edge's face and for two blends sharing a face between them (as §6.6's own
  diagnostic, "face width 6.82" for r = 3.41), `curvature` (fillets, `_curvature_limits`) for a ball on the concave side of an adjacent
  cylinder or sphere (`r ≤ ρ − tol`). An OCCT failure below the analytic
  limits (or on edges without one) is bisected on the size to 1e-3 relative, **from the smallest
  analytic limit, else from a geometric bound** (`_blend_bound`), never from the requested size
  (`_fallback_max`). Either way the reported `max_feasible_r` / `max_feasible_d` is **verified**
  (`_safe_max`): the largest multiple of 0.001 mm at most the limit (rounded down exactly) that
  OCCT builds, bisecting below a rounded value that fails — so applying it succeeds, it never
  exceeds the analytic rule, and it is a function of the geometry; no such size makes it
  `OCCT_FILLET_FAILED` / `OCCT_CHAMFER_FAILED`. On that fallback path the error is `*_TOO_LARGE`
  only where a failed build **shows** a limit (`_evidence_limits`: a face the blend consumed, or a
  normative blend that ran into another face), else `OCCT_*_FAILED` (W7b review 3 — the oracle
  does not assert a limit it has not shown; review 5 — nor §6.6's catalogue `*_FAILED`: the SPEC
  defines the blend, so OCCT's failure is engine-internal and a both-fail is `ROBUSTNESS`, never a
  MATCH on a shared code). Every result must be BRepCheck-valid, keep
  every face of the body (a blend that consumes a face is too large, whatever OCCT returns),
  replace every blended edge by blend faces, give every edge of a normative pair **the** §6.6 /
  §6.7 blend (`_normative_blends_ok`: one patch of the normative type — free-form pieces
  recognized as rule 4 does — and, for a fillet, of radius `r`; a split or free-form patch means
  the ball ran into another face: infeasible, never `ok` + `ORACLE_NORMALIZED`), and change the
  volume in the direction the edges' convexity implies (convex removes, concave adds) beyond the
  volume's float noise (`VOLUME_NOISE_REL`).
* **Keys** (§5.2 rule 3): faces OCCT keeps or modifies keep their keys; a blend face generated from
  edge `E` is `F/blend:{E}` (fillet) or `F/bevel:{E}` (chamfer), a corner patch generated from
  vertex `V` is `F/corner:{V}`; edges and vertices keep their keys through the history — an edge or
  vertex the result still holds unchanged keeps its key whatever OCCT's `IsDeleted` says
  (`BRepFilletAPI_*` answer True for every edge and vertex they did not modify: W7b review 4, where
  an untouched ring took `F/edge:{…}`), and an edge without history between two faces the
  operation kept takes the key of the input edge between the same two faces on whose carrier curve
  it lies and which it overlaps (trimmed or extended, §5.2 rule 3; `_kept_edge_key`; face keys
  resolved through this operation's merges too; several such input edges with different keys are
  a naming failure, W7b review 5). `F/edge:{A|B}` / `F/vertex:{…}` are
  for edges and vertices on a face the operation created; an edge between kept faces that matches
  no input edge fails the feature with `OCCT_NAMING_FAILED`, never a guessed key. The result's topology is the §8.3 rule 1 normalization
  restricted to faces with a common source (OCCT's seam splits of one face; §6.0.4's merge is for
  body operations only).
* **Types** (§8.3 rule 4): blend faces that OCCT returns as B-spline, offset or revolution surfaces
  are recognized with `ShapeAnalysis_CanonicalRecognition` at `1e-7·s`; a blend face still
  `bspline` (possible only on a non-normative pair now) is flagged `ORACLE_NORMALIZED` (rule 4),
  and a vertex where three or more blended edges
  meet, other than the normative spherical corner (three convex edges between mutually
  perpendicular planes, one `r`), is flagged `ORACLE_NORMALIZED` (rule 5): `kernel-diff` then
  relaxes the body comparison as §8.3 says.

Shell (§6.8, §8.3 rule 6): `BRepOffsetAPI_MakeThickSolid::MakeThickSolidByJoin` with
`GeomAbs_Intersection` joins, offset tolerance 1e-7, offset `−thickness` (inward) or `+thickness`
(outward); the input faces the result keeps keep their keys, offset faces are `S/offset:{X}`, rims
`S/rim:{X}`; no open face gives an internal void (`SHELL_CLOSED_VOID`, 2 shells; OCCT returns only
the offset body there, so the oracle assembles the solid with that boundary as its void, each shell
oriented by its signed volume — OCCT's outward offset shell comes back inward — and checks the
solid's volume is the outer's minus the void's). Failures:
an offset surface that degenerates (a cylinder, sphere or torus radius ≤ 0 for its offset side), or
opposite walls that collide (two faces with a double normal through the material — through the
air for an outward shell —: parallel planes, coaxial cylinders, concentric spheres, a plane and a
cylinder parallel to it; `w/2` apart for two offset walls, `w` when one is opened; `_gap_limits`),
is `SHELL_THICKNESS_TOO_LARGE` with the limiting faces: a thickness must leave at least *tol* of
the radius or gap (feasible iff `t ≤ limit − tol`), and `max_feasible_thickness` is verified like
the blends' (`_safe_max`). OCCT's solid is accepted only if it **is** the shell
(`_shell_structure`): every opened face gone, every other face with an offset image, the volume
changed beyond float noise — past collisions this oracle does not compute (three walls closing
in) `MakeThickSolid` returns the input body unchanged. A failure otherwise is bisected like the
blends, from the body's diameter (both directions) — never from the request —; it is
`SHELL_THICKNESS_TOO_LARGE` only with a collision shown: the faces a failed build left without an
offset, else the walls whose offset faces vanish between the maximum and the smallest failing
thickness (`_collapsing_faces`), reason `gap` (walls closing in that are not parallel: a prism's
walls at its inradius, a V-groove's walls). `OCCT_SHELL_FAILED` (engine-internal, W7b review 5)
when nothing builds or no collision is shown.

Draft (§6.9, optional; §8.3 rule 8): `BRepOffsetAPI_DraftAngle` with the neutral plane and pull
direction; each face planar with its normal ⟂ the pull direction within `QUERY_ANGLE_TOLERANCE`
(`DRAFT_FACE_UNSUPPORTED`); the drafted face's normal is checked against the analytic
`cos(a)·n + sin(a)·p` (else `OCCT_SELF_CHECK_FAILED`); drafted faces keep their keys; OCCT's own
failure is `OCCT_DRAFT_FAILED`.
"""

from __future__ import annotations

import math
from fractions import Fraction
from typing import Any

from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepFilletAPI import BRepFilletAPI_MakeChamfer, BRepFilletAPI_MakeFillet
from OCP.BRepOffset import BRepOffset_Skin
from OCP.BRepOffsetAPI import BRepOffsetAPI_DraftAngle, BRepOffsetAPI_MakeThickSolid
from OCP.GeomAbs import GeomAbs_Intersection
from OCP.gp import gp_Dir, gp_Pln, gp_Pnt
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_VERTEX
from OCP.TopExp import TopExp
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedMapOfShape, TopTools_ListOfShape

from .. import occt
from . import geom
from .consts import ANGULAR_TOLERANCE, LINEAR_TOLERANCE, QUERY_ANGLE_TOLERANCE, TANGENT_CHAIN_TOLERANCE
from .normalize import own_curve_type
from .sweeps import FeatureFailure
from .topo import Body, Entity, TopoError, body_report, count_shells

TOL = LINEAR_TOLERANCE
ANG = ANGULAR_TOLERANCE
SUPPORTED = ("plane", "cylinder", "cone", "sphere", "torus")
#: §6.6: "otherwise by bisection to 1e-3 relative".
BISECT_REL = 1e-3
#: Tries of `_safe_max` below a reported value that OCCT failed to build.
SAFE_MAX_TRIES = 6
#: The float noise of a `GProp` volume, relative: a change within it is no evidence of an
#: operation (a shell OCCT returned unchanged passed a strict `v1 < v0` by 7e-13 mm³ of 283 mm³).
#: A setting of the self-checks, not a tolerance of the SPEC.
VOLUME_NOISE_REL = 1e-12


def _round_down(x: float) -> float:
    """§6.6: the largest multiple of 0.001 mm that is **at most** x — computed exactly (`Fraction`),
    so it never rounds up by the binary error of `x·1000` (0.0 for x ≤ 0 or not finite)."""
    if not (math.isfinite(x) and x > 0.0):
        return 0.0
    n = math.floor(Fraction(x) * 1000)
    # `n / 1000` is correctly rounded (int true division) and n/1000 ≤ x with x a double, so the
    # rounded quotient is ≤ x as well.
    return n / 1000


def _safe_max(ok, hi: float) -> float | None:
    """§6.6 "rounded down … so that a suggested value is safe to apply": the largest multiple of
    0.001 mm at most `hi` that `ok` accepts, **verified** by building it; below a failing rounded
    value it bisects (to `BISECT_REL`) and rounds down again. None: no size up to `hi` builds."""
    x = _round_down(hi)
    for _ in range(SAFE_MAX_TRIES):
        if x <= 0.0:
            return None
        if ok(x):
            return x
        lo = _bisect(ok, x)
        if lo is None:
            return None
        x = _round_down(lo)
    return None


def _fallback_max(ok, size: float, bound: float | None) -> float | None:
    """The verified maximum when OCCT fails at `size` and no analytic limit is violated: `_safe_max`
    from `bound` — the smallest analytic limit of the set, else a geometric bound no size can
    exceed — so the reported value is a function of the geometry, not of the requested size (§6.6:
    one `max_*` per edge set). From `size` only when no bound is known, or when the geometric
    answer is not below the size that failed (OCCT's feasible set is not an interval there: the
    suggestion must still be smaller than what was asked)."""
    if bound is not None and math.isfinite(bound) and bound > 0.0:
        got = _safe_max(ok, bound)
        if got is None or got < size:
            return got
    return _safe_max(ok, size)


# ---------------------------------------------------------------------------------------------
# Edge sets: support, convexity, chain expansion
# ---------------------------------------------------------------------------------------------

def convexity(e: Entity) -> str | None:
    """`convex`, `concave` or `smooth` (§5.3), None when the material angle is not evaluable."""
    from .query import material_angle

    a = material_angle(e)
    if a is None:
        return None
    if a < math.pi - QUERY_ANGLE_TOLERANCE:
        return "convex"
    if a > math.pi + QUERY_ANGLE_TOLERANCE:
        return "concave"
    return "smooth"


def check_supported(edges: list[Entity], code: str, names: dict) -> None:
    bad = []
    for e in edges:
        fs = e.body.faces_of_edge(e)
        reason = None
        if len({id(f) for f in fs}) != 2:
            reason = "boundary"
        elif any(f.type not in SUPPORTED for f in fs):
            reason = "surface-type"
        elif convexity(e) in ("smooth", None):
            reason = "smooth"
        if reason:
            bad.append({"key": e.key, "name": _display(e.key, names), "reason": reason})
    if bad:
        raise FeatureFailure(code, f"{len(bad)} edge(s) cannot be blended ({bad[0]['reason']})", {"edges": bad})


def _display(key: str, names: dict) -> str:
    from .query import display_name

    return display_name(key, names) if key else ""


def _piece_at(e: Entity, v) -> Any:
    for p in e.parts():
        if TopExp.FirstVertex_s(p).IsSame(v) or TopExp.LastVertex_s(p).IsSame(v):
            return p
    return e.shape


def expand_chain(edges: list[Entity]) -> list[Entity]:
    """§6.6 chain expansion: the edges added (in discovery order)."""
    from .normalize import _tangent_leaving

    sin_tol = math.sin(TANGENT_CHAIN_TOLERANCE)
    chosen = list(edges)
    ids = {id(e) for e in chosen}
    conv = {id(e): convexity(e) for e in chosen}
    added: list[Entity] = []
    k = 0
    while k < len(chosen):
        e = chosen[k]
        k += 1
        b = e.body
        for v in b.vertices_of_edge(e):
            te = _tangent_leaving(_piece_at(e, v.shape), v.shape)
            if te is None:
                continue
            for g in b.edges_of_vertex(v):
                if id(g) in ids:
                    continue
                tg = _tangent_leaving(_piece_at(g, v.shape), v.shape)
                if tg is None:
                    continue
                arriving = geom.mul(te, -1.0)
                if geom.dot(arriving, tg) <= 0.0 or geom.norm(geom.cross(arriving, tg)) > sin_tol:
                    continue
                cg = convexity(g)
                if cg != conv[id(e)]:
                    continue
                ids.add(id(g))
                conv[id(g)] = cg
                chosen.append(g)
                added.append(g)
    return added


# ---------------------------------------------------------------------------------------------
# Naming a modified solid through an OCCT history
# ---------------------------------------------------------------------------------------------

def name_history(solid, mk, body: Body, fid: str, gen_key, *, extra_faces=None) -> Body:
    """The result solid of a local operation on `body` as a normalized Body with keys.
    `gen_key(kind, entity)` names faces generated from an input edge/face/vertex (None: not a
    source of new faces)."""
    from .normalize import normalized_topology  # noqa: F401  (Body.build_normalized_topology uses it)

    rmap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(solid, TopAbs_FACE, rmap)
    remap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(solid, TopAbs_EDGE, remap)
    rvmap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(solid, TopAbs_VERTEX, rvmap)
    face_src: dict[int, list[str]] = {}
    face_origin: dict[int, set[int]] = {}
    edge_src: dict[int, list[Entity]] = {}
    vert_src: dict[int, list[Entity]] = {}

    def images(s, result_map) -> list:
        """The images of an input sub-shape in the result: its modifications, else itself when the
        result still holds it. OCCT's `IsDeleted` is not consulted for that: `BRepFilletAPI_*`
        answer True for every edge and vertex they did not modify, including the ones the result
        keeps unchanged (W7b review 4 — an untouched ring lost its key to `F/edge:{…}`)."""
        out = [x for x in mk.Modified(s)]
        if out:
            return out
        if result_map.FindIndex(s):
            return [s]
        if hasattr(mk, "ModifiedShape"):
            # BRepBuilderAPI_ModifyShape (DraftAngle): the image through the modification
            try:
                m = mk.ModifiedShape(s)
                if not m.IsNull():
                    return [m]
            except Exception:
                pass
        return []

    for f in body.faces:
        for piece in f.parts():
            for img in images(piece, rmap):
                i = rmap.FindIndex(img)
                if i:
                    face_src.setdefault(i, []).append(f.key)
                    face_origin.setdefault(i, set()).add(id(f))
            gk = gen_key("face", f)
            if gk:
                for img in mk.Generated(piece):
                    i = rmap.FindIndex(img)
                    if i:
                        face_src.setdefault(i, []).append(gk)
                        face_origin.setdefault(i, set()).add(-id(f))
    for e in body.edges:
        gk = gen_key("edge", e)
        for piece in e.parts():
            for img in images(piece, remap):
                i = remap.FindIndex(img)
                if i:
                    edge_src.setdefault(i, []).append(e)
            if gk:
                for img in mk.Generated(piece):
                    i = rmap.FindIndex(img)
                    if i:
                        face_src.setdefault(i, []).append(gk)
                        face_origin.setdefault(i, set()).add(id(e))
    for v in body.vertices:
        gk = gen_key("vertex", v)
        for img in images(v.shape, rvmap):
            i = rvmap.FindIndex(img)
            if i:
                vert_src.setdefault(i, []).append(v)
        if gk:
            for img in mk.Generated(v.shape):
                i = rmap.FindIndex(img)
                if i and img.ShapeType() == TopAbs_FACE:
                    face_src.setdefault(i, []).append(gk)
                    face_origin.setdefault(i, set()).add(id(v))
    if extra_faces is not None:
        extra_faces(rmap, face_src, face_origin)
    nb = Body(solid, body.feature, body.member, body.order)
    nb.instance = body.instance

    def etype(edge, fa, fb):
        srcs = edge_src.get(remap.FindIndex(edge), [])
        if srcs:
            return sorted(srcs, key=lambda x: x.key.encode())[0].type
        # A new edge of the local operation (a blend's boundary, a bevel's, a shell's rim): typed by
        # its own curve — OCCT's native line or conic, or a free-form curve with a witness conic
        # within *tol* (§8.3 rule 3 (b) with the named constant; the withdrawn `1e-7·s` is not used).
        # It is not a section edge of rule 3 (a) — its faces are a blend and a face it is tangent
        # to; their types follow rule 4. A native ellipse is not collapsed into a circle (W7b
        # review 5: `normalize.own_curve_type`, not v0's `occt.edge_type`).
        return own_curve_type(edge)

    def merge_ok(fa, fb):
        a, b = face_origin.get(rmap.FindIndex(fa), set()), face_origin.get(rmap.FindIndex(fb), set())
        return bool(a & b)

    nb.build_normalized_topology(etype, merge_ok)
    missing = []
    for f in nb.faces:
        keys = []
        for piece in f.parts():
            keys += face_src.get(rmap.FindIndex(piece), [])
        if not keys:
            missing.append(f)
            continue
        ks = sorted(set(keys), key=str.encode)
        f.key = ks[0]
        for k in ks[1:]:
            nb.aliases[k] = f.key
    nb.aliases.update({a: k for a, k in body.aliases.items()})
    if missing:
        nb.naming_error = f"{len(missing)} result face(s) have no source in OCCT's history"
        return nb
    created = f"{fid}/"
    unmatched = []
    for e in nb.edges:
        fk = sorted(x.key for x in nb.faces_of_edge(e))
        if len(fk) == 1:
            fk = fk * 2
        srcs = []
        for piece in e.parts():
            srcs += edge_src.get(remap.FindIndex(piece), [])
        if srcs:
            e.key = sorted({x.key for x in srcs}, key=str.encode)[0]
        elif any(k.startswith(created) for k in fk):
            # a new edge of the operation: it bounds a face the operation created (§5.2 rule 3)
            e.key = f"{fid}/edge:{{{fk[0]}|{fk[1]}}}"
        else:
            # between two faces the operation kept, without history: the input edge it was trimmed
            # or extended from keeps its key (§5.2 rule 3) — the one between the same two face
            # keys on whose carrier curve it lies
            why: list[str] = []
            k = _kept_edge_key(e, fk, body, nb.aliases, why)
            if k is None:
                unmatched.append((e, why[0] if why else "no input edge qualifies"))
                e.key = f"{fid}/edge:{{{fk[0]}|{fk[1]}}}"
            else:
                e.key = k
    for v in nb.vertices:
        srcs = vert_src.get(rvmap.FindIndex(v.shape), [])
        keys = sorted({x.key for x in nb.faces_of_vertex(v)})
        if srcs:
            v.key = sorted({x.key for x in srcs}, key=str.encode)[0]
        elif not any(k.startswith(created) for k in keys) and (k := _kept_vertex_key(v, keys, body)):
            v.key = k
        else:
            v.key = f"{fid}/vertex:{{{'|'.join(keys)}}}"
    if unmatched:
        # an edge between two kept faces that is none of the input's edges: the oracle cannot tell
        # which key §5.2 gives it — an explicit engine-internal failure, never a guessed key
        nb.naming_error = (f"{len(unmatched)} result edge(s) between kept faces have no source in OCCT's "
                           f"history and no single input edge between the same faces they were trimmed or "
                           f"extended from ({unmatched[0][0].key}: {unmatched[0][1]})")
    return nb


def _carrier_curve(edge):
    """The untrimmed carrier curve of an OCCT edge (None for a degenerate edge)."""
    from OCP.BRep import BRep_Tool
    from OCP.Geom import Geom_TrimmedCurve

    edge = TopoDS.Edge_s(edge)
    if BRep_Tool.Degenerated_s(edge):
        return None
    c = BRep_Tool.Curve_s(edge, 0.0, 0.0)  # located (a copy when the edge has a location)
    if c is None:
        return None
    while isinstance(c, Geom_TrimmedCurve):
        c = c.BasisCurve()
    return c


def _edge_samples(edge, n: int = 7) -> list[tuple]:
    from OCP.BRepAdaptor import BRepAdaptor_Curve

    a = BRepAdaptor_Curve(TopoDS.Edge_s(edge))
    u0, u1 = a.FirstParameter(), a.LastParameter()
    out = []
    for i in range(n):
        p = a.Value(u0 + (u1 - u0) * i / (n - 1))
        out.append((p.X(), p.Y(), p.Z()))
    return out


def _on_carrier(e: Entity, src: Entity) -> bool:
    """Every sample of `e` (ends and interior points of each piece) lies within *tol* of the
    untrimmed carrier curve of one of `src`'s pieces."""
    from OCP.GeomAPI import GeomAPI_ProjectPointOnCurve

    curves = [c for c in (_carrier_curve(p) for p in src.parts()) if c is not None]
    if not curves:
        return False
    for piece in e.parts():
        for p in _edge_samples(piece):
            best = math.inf
            for c in curves:
                try:
                    pr = GeomAPI_ProjectPointOnCurve(gp_Pnt(*p), c)
                    if pr.NbPoints() > 0:
                        best = min(best, pr.LowerDistance())
                except Exception:
                    continue
            if best > TOL:
                return False
    return True


def _resolve_key(k: str, *alias_maps: dict) -> str:
    """A face key through alias maps (the operation's own merges first, then the input body's),
    followed to the end of the chain."""
    seen: set[str] = set()
    while k not in seen:
        seen.add(k)
        nxt = next((m[k] for m in alias_maps if m.get(k, k) != k), None)
        if nxt is None:
            break
        k = nxt
    return k


#: Samples per piece in `_overlaps` (the interior ones are tested).
OVERLAP_SAMPLES = 17


def _overlaps(e: Entity, src: Entity) -> bool:
    """`e` and `src` share a stretch of their curve: an **interior** sample of either lies within
    *tol* of the other edge itself — its trimmed pieces, not its untrimmed carrier. A trimmed `e`
    lies on `src`; an extended one contains `src`'s interior; two collinear pieces that only touch
    at a vertex (a notch splitting an edge) do not overlap."""
    from .topo import point_shape_distance

    def interior(ent: Entity) -> list[tuple]:
        return [q for piece in ent.parts() for q in _edge_samples(piece, OVERLAP_SAMPLES)[1:-1]]

    def near(q: tuple, ent: Entity) -> bool:
        return any(point_shape_distance(q, piece) <= TOL for piece in ent.parts())

    return any(near(q, src) for q in interior(e)) or any(near(q, e) for q in interior(src))


def _kept_edge_key(e: Entity, fk: list[str], body: Body, aliases: dict | None = None,
                   why: list | None = None) -> str | None:
    """The key of the input edge that `e` — between the faces keyed `fk`, without history — was
    trimmed or extended from (§5.2 rule 3: an entity an operation only modifies keeps its key): an
    input edge between the same two faces (keys resolved through the operation's own merge
    `aliases` and the input body's), on whose carrier `e` lies (`_on_carrier`) **and** which `e`
    overlaps (`_overlaps`; W7b review 5 — the carrier alone let one of several collinear input
    edges with different keys name `e` by byte order). None — the caller's `OCCT_NAMING_FAILED`,
    never a guessed key — when no input edge qualifies, or when edges with **different** keys do
    (split pieces sharing one key are one); the reason is appended to `why`."""
    def canon(keys) -> list[str]:
        return sorted(_resolve_key(k, aliases or {}, body.aliases) for k in keys)

    want = canon(fk)
    on_carrier, found = set(), set()
    for src in body.edges:
        sk = [x.key for x in body.faces_of_edge(src)]
        if len(sk) == 1:
            sk = sk * 2
        if canon(sk) != want or not _on_carrier(e, src):
            continue
        on_carrier.add(src.key)
        if _overlaps(e, src):
            found.add(src.key)
    if len(found) == 1:
        return next(iter(found))
    if why is not None:
        if found:
            why.append(f"it overlaps input edges with different keys {sorted(found, key=str.encode)}")
        elif on_carrier:
            why.append(f"it lies on the carrier of {sorted(on_carrier, key=str.encode)} but overlaps none of them")
        else:
            why.append("it lies on no input edge between the same faces")
    return None


def _kept_vertex_key(v: Entity, keys: list[str], body: Body) -> str | None:
    """The key of the input vertex, on the same kept faces, that the result vertex coincides with
    within *tol* (an unchanged vertex OCCT rebuilt); None otherwise."""
    p = v.point()
    found = set()
    for src in body.vertices:
        if sorted({x.key for x in body.faces_of_vertex(src)}) != keys:
            continue
        if geom.norm(geom.sub(src.point(), p)) <= TOL:
            found.add(src.key)
    return sorted(found, key=str.encode)[0] if found else None


def _blend_face_types(nb: Body, prefix: str) -> int:
    """§8.3 rule 4: blend faces OCCT returns as free-form are recognized at `1e-7·s`; the count of
    blend faces still `bspline`."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType as ST
    from OCP.gp import gp_Cone, gp_Cylinder, gp_Pln, gp_Sphere
    from OCP.ShapeAnalysis import ShapeAnalysis_CanonicalRecognition

    m = nb.body_metrics() if nb.metrics else occt.body_metrics(nb.solid)
    s = max(1.0, geom.dist(tuple(m["bbox_min"]), tuple(m["bbox_max"])))
    tol = 1e-7 * s
    left = 0
    for f in nb.faces:
        if not f.key.startswith(prefix):
            continue
        t = BRepAdaptor_Surface(f.shape, False).GetType()
        if t not in (ST.GeomAbs_BSplineSurface, ST.GeomAbs_BezierSurface, ST.GeomAbs_OffsetSurface,
                     ST.GeomAbs_SurfaceOfRevolution):
            continue
        if f.type in SUPPORTED:
            continue
        cr = ShapeAnalysis_CanonicalRecognition(f.shape)
        kind = None
        for name, fn, obj in (("plane", cr.IsPlane, gp_Pln()), ("cylinder", cr.IsCylinder, gp_Cylinder()),
                              ("cone", cr.IsCone, gp_Cone()), ("sphere", cr.IsSphere, gp_Sphere())):
            try:
                if fn(tol, obj):
                    kind = name
                    break
            except Exception:
                continue
        if kind is None:
            left += 1
        else:
            f._cache["type"] = kind
    nb.metrics = None
    return left


# ---------------------------------------------------------------------------------------------
# Fillet and chamfer
# ---------------------------------------------------------------------------------------------

def _width_limits(edges: list[Entity], setback) -> list[dict]:
    """§6.6 analytic width limits. `setback(e, face)` is the blend's extent across the edge on that
    face as `(a, c)`: `a·size + c` (a per unit size; c a part that does not scale with the size, the
    `d2` of a two-distance chamfer on its face). Returns every limit `{edge, face, max}`, `max` the
    largest size that fits.

    A blend fits a face when it leaves at least *tol* of it: `a·size + c ≤ W − tol` for one edge
    (W the face's extent across it), `(a₁ + a₂)·size + c₁ + c₂ ≤ W − tol` for two blended edges
    bounding the face from opposite sides (W their distance). At `W` exactly the face vanishes and
    OCCT fails or drops the face (the blend would have to meet the next face), and within *tol* of
    it the face left is a sliver that [R-3] does not distinguish from an edge — so the limit is
    exclusive by *tol*, for straight and circular edges alike, and the reported (rounded-down)
    value is feasible. `max` is 0.0 when no size fits (a constant part alone too wide).

    The extents (`_extents`):

    * a **line edge between two planes**: on each plane, `w = n × d` oriented into the face
      **locally** (at the edge, `query.into_face_sign`, not towards the face's interior point: on
      a non-convex face that point can lie across the edge's line), and `W` = the narrowest width
      across the edge: the nearest other boundary of the face ahead of the edge within its span
      (`_nearest_ahead`; the edges sharing a vertex with it excepted), capped by the face's extent
      along `w` from the edge — the largest `(q − p)·w` over the face, its tight bounding box in
      a frame whose X axis is `w` (exact on line and circle boundaries, e.g. a D-shaped face whose
      far side is an arc with no vertex on it). Two blended edges on one face are opposite when
      they are parallel (`ANGULAR_TOLERANCE`), their `w` point towards each other and their spans
      along `d` overlap by more than *tol*; `W` is then their distance.
    * a **full circle between a plane perpendicular to its axis and a coaxial cylinder or cone**
      (the normative torus / cone cases of §6.6 and §6.7): on the plane, `R` minus the farthest
      other boundary from the centre when the plane lies inside the circle (a cap disc: `R`; an
      annulus: `R − Rᵢ`; an off-centre hole: `R − (o + rₕ)`), else the nearest other boundary from
      the centre minus `R`; on the cylinder or cone, the face's extent along the
      axis from the circle (a cone's divided by the cosine between its generatrix and the axis:
      the setback is measured along the face). Two blended circles bounding one face are
      opposite when the face lies between them (two circles of one cylinder or cone, a plane's
      outer and inner circle); `W` is then their distance along the face.

    Other edges (partial arcs, other surface pairs) have no analytic limit: OCCT decides, with the
    structural checks of `_build_blend` (no adjacent face may vanish)."""

    def fit(width: float, a: float, c: float) -> float:
        room = width - TOL - c
        if a > 0.0:
            return max(0.0, room / a)
        return math.inf if room >= 0.0 else 0.0

    out = []
    sides: list[dict] = []
    for e in edges:
        sides += _extents(e)
    for s in sides:
        a, c = setback(s["edge"], s["face"])
        s["setback"] = (a, c)
        m = fit(s["width"], a, c)
        if m < math.inf:
            out.append({"edge": s["edge"], "face": s["face"], "max": m, "limit": "face-width"})
    for i, s in enumerate(sides):
        for t in sides[i + 1:]:
            if t["face"] is not s["face"] or t["edge"] is s["edge"]:
                continue
            sep = _opposite(s, t)
            if sep is None:
                continue
            (a1, c1), (a2, c2) = s["setback"], t["setback"]
            m = fit(sep, a1 + a2, c1 + c2)
            if m < math.inf:
                # still `face-width`: §6.6's own diagnostic reports two corner fillets on one face as
                # "max feasible r = 3.41 (face width 6.82 at slab/side:right)"; `adjacent-blend` is
                # not derived analytically here (W7b report, CONTRACT ISSUES 3)
                out.append({"edge": s["edge"], "face": s["face"], "max": m, "limit": "face-width"})
                out.append({"edge": t["edge"], "face": t["face"], "max": m, "limit": "face-width"})
    return out


def _curvature_limits(edges: list[Entity]) -> list[dict]:
    """§6.6 `curvature` (fillets): a rolling ball on the **concave** side of an adjacent cylinder or
    sphere — the material side of a convex face for a convex edge, the air side of a concave face
    for a concave one — fits only with `r ≤ ρ − tol` (ρ the face's radius; at `r = ρ` the blend
    degenerates, and within *tol* of it [R-3] does not tell it from that). Tori and cones (their
    curvature varies along the edge) have no analytic limit here."""
    out = []
    for e in edges:
        conv = convexity(e)
        for f in e.body.faces_of_edge(e):
            if f.type not in ("cylinder", "sphere"):
                continue
            rho = f.radius()
            convex_face = _face_is_convex(f, e.point())
            if rho is None or convex_face is None:
                continue
            if convex_face == (conv == "convex"):
                out.append({"edge": e, "face": f, "max": max(0.0, rho - TOL), "limit": "curvature"})
    return out


def _face_is_convex(f: Entity, p: tuple) -> bool | None:
    """Whether a cylinder or sphere face bulges outward at (the projection of) `p`: its outward
    normal points away from its axis or centre."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    n = f.normal_at(p)
    if n is None:
        return None
    if f.type == "sphere":
        ad = BRepAdaptor_Surface(f.nearest_part(p), False)
        try:
            loc = ad.Sphere().Location()
        except Exception:
            return None
        away = geom.sub(p, (loc.X(), loc.Y(), loc.Z()))
    else:
        ax = f.surface_axis()
        if ax is None:
            return None
        rel = geom.sub(p, ax.origin)
        away = geom.sub(rel, geom.mul(ax.direction, geom.dot(rel, ax.direction)))
    s = geom.dot(away, n)
    return None if s == 0.0 else s > 0.0


def _into(e: Entity, f: Entity, w: tuple) -> tuple | None:
    """`w` (tangent to `f`, perpendicular to `e`) oriented into `f` at the edge (None: undecided)."""
    from .query import into_face_sign

    p = e.point()
    sign = into_face_sign(e._largest_part(), f.nearest_part(p), w)
    if sign is None:
        # the parametric test is inconclusive: a fixed step of 1e-4·s, as `query.material_angle`
        m = e.body.body_metrics()
        step = 1e-4 * max(1.0, geom.dist(tuple(m["bbox_min"]), tuple(m["bbox_max"])))
        fwd = f.distance(geom.add(p, geom.mul(geom.unit(w), step)))
        bwd = f.distance(geom.add(p, geom.mul(geom.unit(w), -step)))
        if fwd == bwd:
            return None
        sign = -1 if fwd > bwd else 1
    return geom.unit(w) if sign > 0 else geom.mul(geom.unit(w), -1.0)


def _support(f: Entity, origin: tuple, w: tuple) -> float | None:
    """The largest `(q − origin)·w` over the face `f` (`w` a unit vector): the X extent of the
    face's tight bounding box (`BRepBndLib.AddOptimal`, no triangulation, no shape tolerance: exact
    on line and circle boundaries) in a frame at `origin` whose X axis is `w`."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.gp import gp_Ax3, gp_Trsf
    from OCP.TopLoc import TopLoc_Location

    z = geom.cross(w, (1.0, 0.0, 0.0) if abs(w[0]) < 0.9 else (0.0, 1.0, 0.0))
    ax = gp_Ax3(gp_Pnt(*origin), gp_Dir(*geom.unit(z)), gp_Dir(*w))
    tr = gp_Trsf()
    tr.SetTransformation(ax)  # global coordinates -> coordinates in `ax`
    best = None
    for piece in f.parts():
        box = Bnd_Box()
        BRepBndLib.AddOptimal_s(piece.Moved(TopLoc_Location(tr)), box, False, False)
        if box.IsVoid():
            continue
        x = box.Get()[3]
        best = x if best is None else max(best, x)
    return best


def _span(e: Entity, d: tuple) -> tuple[float, float]:
    xs = [geom.dot(v.point(), d) for v in e.body.vertices_of_edge(e)] or [geom.dot(e.point(), d)]
    return min(xs), max(xs)


def _full_circle(e: Entity) -> bool:
    from OCP.BRepAdaptor import BRepAdaptor_Curve

    total = 0.0
    for piece in e.parts():
        ad = BRepAdaptor_Curve(piece)
        total += ad.LastParameter() - ad.FirstParameter()
    return total >= 2.0 * math.pi - ANG


def _point_face_distance(p: tuple, f: Entity) -> float:
    return f.distance(p)


def _farthest_from(f: Entity, c: tuple) -> float:
    """The largest distance from `c` to a point of the face (attained on its boundary: `|q − c|` is
    convex): line edges at their ends, circular ones analytically, other curves sampled."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GeomAbs import GeomAbs_CurveType as CT
    from OCP.TopExp import TopExp_Explorer

    best = 0.0
    for piece in f.parts():
        ex = TopExp_Explorer(piece, TopAbs_EDGE)
        while ex.More():
            ed = TopoDS.Edge_s(ex.Current())
            ex.Next()
            ad = BRepAdaptor_Curve(ed)
            t0, t1 = ad.FirstParameter(), ad.LastParameter()
            ts = [t0, t1]
            kind = ad.GetType()
            if kind == CT.GeomAbs_Circle:
                ci = ad.Circle()
                cc = (ci.Location().X(), ci.Location().Y(), ci.Location().Z())
                ax = (ci.Axis().Direction().X(), ci.Axis().Direction().Y(), ci.Axis().Direction().Z())
                rel = geom.sub(cc, c)
                inplane = geom.sub(rel, geom.mul(ax, geom.dot(rel, ax)))
                if geom.norm(inplane) > 0.0:
                    # the farthest point of the circle from c: at the angle of `inplane`
                    xd = (ci.XAxis().Direction().X(), ci.XAxis().Direction().Y(), ci.XAxis().Direction().Z())
                    yd = (ci.YAxis().Direction().X(), ci.YAxis().Direction().Y(), ci.YAxis().Direction().Z())
                    ang = math.atan2(geom.dot(inplane, yd), geom.dot(inplane, xd))
                    for k in (-1, 0, 1, 2):
                        t = ang + 2.0 * math.pi * k
                        if t0 <= t <= t1:
                            ts.append(t)
                else:
                    ts.append(0.5 * (t0 + t1))  # equidistant from c
            elif kind != CT.GeomAbs_Line:
                ts += [t0 + (t1 - t0) * i / 128.0 for i in range(1, 128)]
            for t in ts:
                q = ad.Value(t)
                best = max(best, geom.dist((q.X(), q.Y(), q.Z()), c))
    return best


#: Samples of a free-form boundary curve in `_curve_params` (lines, circles and ellipses are exact).
CURVE_SAMPLES = 256


def _curve_params(ad, extra) -> list[float]:
    """Candidate parameters of an edge curve (`BRepAdaptor_Curve`) for an extremum on it: its ends,
    the parameters `extra(kind, ad)` names (critical points and level crossings, exact for lines,
    circles and ellipses), and for other curves `CURVE_SAMPLES` even samples; each mapped into the
    edge's range (periodic curves by multiples of 2π)."""
    from OCP.GeomAbs import GeomAbs_CurveType as CT

    t0, t1 = ad.FirstParameter(), ad.LastParameter()
    kind = ad.GetType()
    out = [t0, t1]
    periodic = kind in (CT.GeomAbs_Circle, CT.GeomAbs_Ellipse)
    for t in extra(kind, ad):
        if not math.isfinite(t):
            continue
        for k in ((-2, -1, 0, 1, 2) if periodic else (0,)):
            u = t + 2.0 * math.pi * k
            if t0 <= u <= t1:
                out.append(u)
    if kind not in (CT.GeomAbs_Line, CT.GeomAbs_Circle, CT.GeomAbs_Ellipse):
        out += [t0 + (t1 - t0) * i / CURVE_SAMPLES for i in range(1, CURVE_SAMPLES)]
    return out


def _conic(kind, ad):
    """(C, U, V) of a circle or ellipse: `q(t) = C + cos t·U + sin t·V`; None for other curves."""
    from OCP.GeomAbs import GeomAbs_CurveType as CT

    if kind == CT.GeomAbs_Circle:
        g, a, b = ad.Circle(), ad.Circle().Radius(), ad.Circle().Radius()
    elif kind == CT.GeomAbs_Ellipse:
        g, a, b = ad.Ellipse(), ad.Ellipse().MajorRadius(), ad.Ellipse().MinorRadius()
    else:
        return None
    x, y = g.XAxis().Direction(), g.YAxis().Direction()
    loc = g.Location()
    return ((loc.X(), loc.Y(), loc.Z()), geom.mul((x.X(), x.Y(), x.Z()), a), geom.mul((y.X(), y.Y(), y.Z()), b))


def _sinusoid_roots(A: float, B: float, k: float) -> list[float]:
    """The t with `A·cos t + B·sin t = k` (none when |k| exceeds the amplitude)."""
    m = math.hypot(A, B)
    if not m > 0.0 or abs(k) > m:
        return []
    phi, delta = math.atan2(B, A), math.acos(max(-1.0, min(1.0, k / m)))
    return [phi - delta, phi + delta]


def _nearest_ahead(shapes: list, p: tuple, w: tuple, d: tuple, span: tuple[float, float]) -> float | None:
    """The narrowest width of a planar face across a line edge (`_extents`): the smallest
    `(q − p)·w > tol` over the points `q` of the boundary curves `shapes` whose projection `q·d`
    lies in the edge's span — where the strip the blend takes off the face (between the edge and
    its setback line) first meets another boundary of the face (a hole, a notch, the far side).
    Exact on lines, circles and ellipses (the minimum of a linear function over the part of the
    curve in a slab is at a critical point, an end, or a slab crossing), sampled on other curves.
    None: no such point."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GeomAbs import GeomAbs_CurveType as CT

    s0, s1 = span
    eps = 1e-3 * TOL

    def extra(kind, ad):
        if kind == CT.GeomAbs_Line:
            ln = ad.Line()
            o = (ln.Location().X(), ln.Location().Y(), ln.Location().Z())
            dv = (ln.Direction().X(), ln.Direction().Y(), ln.Direction().Z())
            k = geom.dot(dv, d)
            return [(s - geom.dot(o, d)) / k for s in (s0, s1)] if k != 0.0 else []
        cn = _conic(kind, ad)
        if cn is None:
            return []
        c, u, v = cn
        out = [math.atan2(geom.dot(v, w), geom.dot(u, w))]
        out.append(out[0] + math.pi)
        for s in (s0, s1):
            out += _sinusoid_roots(geom.dot(u, d), geom.dot(v, d), s - geom.dot(c, d))
        return out

    best = None
    for sh in shapes:
        ad = BRepAdaptor_Curve(sh)
        for t in _curve_params(ad, extra):
            q = ad.Value(t)
            q = (q.X(), q.Y(), q.Z())
            x = geom.dot(q, d)
            if not (s0 - eps <= x <= s1 + eps):
                continue
            h = geom.dot(geom.sub(q, p), w)
            if h > TOL and (best is None or h < best):
                best = h
    return best


def _dist_range(shapes: list, c: tuple) -> tuple[float, float] | None:
    """The smallest and largest distance from `c` to the boundary curves `shapes` (exact on lines
    and circles, sampled on others); None for no curve."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GeomAbs import GeomAbs_CurveType as CT

    def extra(kind, ad):
        if kind == CT.GeomAbs_Line:
            ln = ad.Line()
            o = (ln.Location().X(), ln.Location().Y(), ln.Location().Z())
            dv = (ln.Direction().X(), ln.Direction().Y(), ln.Direction().Z())
            return [geom.dot(geom.sub(c, o), dv)]  # the foot of the perpendicular
        if kind == CT.GeomAbs_Circle:
            cc, u, v = _conic(kind, ad)
            rel = geom.sub(cc, c)
            t = math.atan2(geom.dot(rel, v), geom.dot(rel, u))  # the farthest point; + π the nearest
            return [t, t + math.pi]
        if kind == CT.GeomAbs_Ellipse:
            return [ad.FirstParameter() + (ad.LastParameter() - ad.FirstParameter()) * i / CURVE_SAMPLES
                    for i in range(1, CURVE_SAMPLES)]
        return []

    lo = hi = None
    for sh in shapes:
        ad = BRepAdaptor_Curve(sh)
        for t in _curve_params(ad, extra):
            q = ad.Value(t)
            r = geom.dist((q.X(), q.Y(), q.Z()), c)
            lo = r if lo is None else min(lo, r)
            hi = r if hi is None else max(hi, r)
    return None if lo is None else (lo, hi)


def _other_boundary(e: Entity, f: Entity) -> list:
    """The boundary curves (OCCT pieces) of face `f` other than `e` and the edges of `f` that share a
    vertex with `e`: the adjacent edges only trim the blend's ends (the faces across them cut it
    off), wherever they run; every other boundary the blend's strip reaches narrows the face."""
    b = e.body
    near = {id(e)}
    for v in b.vertices_of_edge(e):
        near |= {id(g) for g in b.edges_of_vertex(v)}
    return [piece for g in b.edges_of_face(f) if id(g) not in near for piece in g.parts()]


def _extents(e: Entity) -> list[dict]:
    """The analytic sides of an edge: `{edge, face, width, kind, …}` per adjacent face (see
    `_width_limits`); [] when the edge has no analytic limit."""
    fs = e.body.faces_of_edge(e)
    if len(fs) != 2 or fs[0] is fs[1]:
        return []
    if e.type == "line" and all(f.type == "plane" for f in fs):
        d = e.line_direction()
        p = e.point()
        out = []
        for f in fs:
            n = f.plane_normal()
            if n is None or d is None:
                return []
            w = _into(e, f, geom.cross(n, d))
            if w is None:
                return []
            width = _support(f, p, w)
            if width is None:
                return []
            span = _span(e, d)
            # the narrowest width across the edge (W7b review 3): a hole 2 mm from the edge limits
            # the blend to 2 mm, whatever the face's full extent beyond the hole
            near = _nearest_ahead(_other_boundary(e, f), p, w, d, span)
            if near is not None:
                width = min(width, near)
            out.append({"edge": e, "face": f, "width": width, "kind": "line", "d": d, "p": p, "w": w,
                        "span": span})
        return out
    if e.type == "circle" and _full_circle(e):
        ax = e.circle_axis()
        r = e.radius()
        if ax is None or r is None:
            return []
        c, a = ax.origin, ax.direction
        planes = [f for f in fs if f.type == "plane"]
        rev = [f for f in fs if f.type in ("cylinder", "cone")]
        if len(planes) != 1 or len(rev) != 1:
            return []
        pf, cf = planes[0], rev[0]
        n = pf.plane_normal()
        cax = cf.surface_axis()
        if n is None or cax is None or geom.norm(geom.cross(n, a)) > ANG or geom.norm(geom.cross(cax.direction, a)) > ANG:
            return []
        rel = geom.sub(c, cax.origin)
        if geom.norm(geom.sub(rel, geom.mul(cax.direction, geom.dot(rel, cax.direction)))) > TOL:
            return []  # not coaxial
        p, t = e.edge_mid_tangent()
        # the plane: inside or outside the circle (radial direction at the edge, into the plane)
        radial_in = geom.unit(geom.sub(geom.sub(c, p), geom.mul(a, geom.dot(geom.sub(c, p), a))))
        wp = _into(e, pf, radial_in)
        if wp is None:
            return []
        inside = geom.dot(wp, radial_in) > 0.0
        # the narrowest width across the circle (W7b review 3): the ring the blend takes off the
        # plane must not reach another boundary of it — inside, the farthest other boundary from
        # the centre (an annulus's inner circle, an off-centre hole); outside, the nearest one
        rng = _dist_range([piece for g in e.body.edges_of_face(pf) if g is not e for piece in g.parts()], c)
        if inside:
            wpl = r - max(_point_face_distance(c, pf), rng[1] if rng else 0.0)
        else:
            wpl = (rng[0] if rng else _farthest_from(pf, c)) - r
        # the cylinder or cone: along its face, away from the circle
        nc = cf.normal_at(p)
        if nc is None:
            return []
        wc = _into(e, cf, geom.cross(nc, t))
        if wc is None:
            return []
        cos_a = abs(geom.dot(wc, a))
        if not cos_a > ANG:
            return []
        a_in = a if geom.dot(wc, a) > 0.0 else geom.mul(a, -1.0)
        axial = _support(cf, c, a_in)
        if axial is None:
            return []
        return [{"edge": e, "face": pf, "width": wpl, "kind": "circle-plane", "c": c, "a": a, "r": r,
                 "inside": inside},
                {"edge": e, "face": cf, "width": axial / cos_a, "kind": "circle-rev", "c": c, "a_in": a_in,
                 "cos": cos_a}]
    return []


def _opposite(s: dict, t: dict) -> float | None:
    """The distance across the face between two blended edges bounding it from opposite sides
    (`_width_limits`), None when they are not opposite."""
    if s["kind"] != t["kind"]:
        return None
    if s["kind"] == "line":
        if geom.norm(geom.cross(s["d"], t["d"])) > ANG or geom.dot(s["w"], t["w"]) >= 0.0:
            return None
        (a0, a1), (b0, b1) = s["span"], (min(_span(t["edge"], s["d"])), max(_span(t["edge"], s["d"])))
        if min(a1, b1) - max(a0, b0) <= TOL:
            return None  # the edges do not face each other across the face
        return abs(geom.dot(geom.sub(t["p"], s["p"]), s["w"]))
    if s["kind"] == "circle-rev":
        if geom.dot(s["a_in"], t["a_in"]) >= 0.0:
            return None
        return abs(geom.dot(geom.sub(t["c"], s["c"]), s["a_in"])) / s["cos"]
    if s["kind"] == "circle-plane":
        if s["inside"] == t["inside"] or geom.norm(geom.cross(s["a"], t["a"])) > ANG:
            return None
        rel = geom.sub(t["c"], s["c"])
        if geom.norm(rel) > TOL:
            return None
        out, inn = (s, t) if s["inside"] else (t, s)
        if not out["r"] > inn["r"]:
            return None
        return out["r"] - inn["r"]
    return None


def _half_tan(e: Entity) -> float | None:
    from .query import material_angle

    a = material_angle(e)
    if a is None or not (0.0 < a < 2.0 * math.pi):
        return None
    return math.tan(a / 2.0)


def blend_feature(ev, st, fi: int, f: dict, entry: dict, refs: list, kind: str) -> None:
    warns = entry["warnings"]
    fid = f["id"]
    ch = kind == "chamfer"
    P = "CHAMFER" if ch else "FILLET"
    d1 = d2 = ang = None
    if ch:
        d1 = ev.scalar(st, f["d"], "length")
        if not d1 > TOL:
            raise FeatureFailure("INVALID_VALUE", f"d = {d1}: must be > 0.000001",
                                 {"field": "/d", "value": d1, "expected": "> 0.000001"})
        d2 = ev.scalar(st, f["d2"], "length") if "d2" in f else None
        if d2 is not None and not d2 > TOL:
            raise FeatureFailure("INVALID_VALUE", f"d2 = {d2}: must be > 0.000001",
                                 {"field": "/d2", "value": d2, "expected": "> 0.000001"})
        ang = ev.scalar(st, f["angle"], "angle") if "angle" in f else None
        if ang is not None and not (0.0 < ang < 90.0):
            # §0.5 rule 2: the literal check's code (validate: `INVALID_VALUE`), at evaluation
            raise FeatureFailure("INVALID_VALUE", f"angle = {ang}: must be in (0, 90)",
                                 {"field": "/angle", "value": ang, "expected": "in (0, 90)"})
        size = d1
    else:
        size = ev.scalar(st, f["r"], "length")
        if not size > TOL:
            raise FeatureFailure("INVALID_RADIUS", f"r = {size}: must be > 0.000001",
                                 {"field": "/r", "value": size, "expected": "> 0.000001"})
    chain = bool(ev.scalar(st, f.get("tangent_chain", True), "bool"))
    edges = list(ev.resolve(st, f["edges"], "some", "/edges", refs, warns))
    side = None
    if ch and "side" in f:
        (side,) = ev.resolve(st, f["side"], "one", "/side", refs, warns)
    check_supported(edges, f"{P}_EDGE_UNSUPPORTED", st.names)
    added = expand_chain(edges) if chain else []
    if added:
        check_supported(added, f"{P}_EDGE_UNSUPPORTED", st.names)
    all_edges = edges + added
    if side is not None:
        bad = [e for e in all_edges if side not in e.body.faces_of_edge(e)]
        if bad:
            raise FeatureFailure("CHAMFER_SIDE_NOT_ADJACENT", f"the side face is not adjacent to {bad[0].key}",
                                 {"edges": [{"key": e.key, "name": _display(e.key, st.names)} for e in bad]})
    # analytic width limits (plane–plane line edges, circles between a plane and a coaxial
    # cylinder or cone)
    def setback(e, face):
        """(a, c): the blend's extent across `e` on `face` is `a·size + c` (`size` = r or d)."""
        ht = _half_tan(e)
        if ht is None or ht == 0.0:
            return (0.0, 0.0)
        if not ch:
            # a fillet's setback: r / tan(θ/2) on a convex edge; on a concave one the ball rolls
            # in the air angle 2π − θ, r / tan((2π − θ)/2) = r / |tan(θ/2)|
            return (1.0 / abs(ht), 0.0)
        if side is None or face is side:
            return (1.0, 0.0)  # d, measured on the face
        if d2 is not None:
            return (0.0, d2)  # the two-distance form: d2 on the other face, whatever d is
        return (math.tan(math.radians(ang)), 0.0)  # the distance–angle form: d·tan(angle)
    bodies: list[Body] = []
    for e in all_edges:
        if all(e.body is not b for b in bodies):
            bodies.append(e.body)

    #: evidence of a size too large per failing size (`_build_blend`'s `why`)
    evidence: dict[float, list] = {}

    def builds(x: float) -> bool:
        """Every body builds with size x (the other fields as given; `d2` stays fixed)."""
        for b in bodies:
            es = [e for e in all_edges if e.body is b]
            why: list = []
            if _build_blend(b, es, x, ch, d2, ang, side, fid, check=False, why=why) is None:
                evidence[x] = why
                return False
        return True

    lim = _width_limits(all_edges, setback) + ([] if ch else _curvature_limits(all_edges))
    analytic = min((x["max"] for x in lim), default=math.inf)
    viol = [x for x in lim if size > x["max"]]
    if viol:
        safe = _safe_max(builds, analytic) if analytic > 0.0 else 0.0
        if safe is None:
            raise FeatureFailure(f"OCCT_{P}_FAILED", f"OCCT could not {kind} the edges at any size up to the width limit",
                                 {"edges": [e.key for e in all_edges], "reason": "OCCT BRepFilletAPI failed"})
        _too_large(P, size, safe, viol, st.names)
    results: list[tuple[Body, Body]] = []
    for b in bodies:
        es = [e for e in all_edges if e.body is b]
        why: list = []
        nb = _build_blend(b, es, size, ch, d2, ang, side, fid, why=why)
        if nb is None:
            # OCCT fails, drops a face or builds no §6.6 blend below every analytic limit: bisected
            # from the analytic limit, else from a geometric bound — never from the request, never
            # above the rule
            evidence[size] = why
            bound = analytic if math.isfinite(analytic) else _blend_bound(all_edges, ch, ang)
            safe = _fallback_max(builds, size, bound)
            if safe is None:
                raise FeatureFailure(f"OCCT_{P}_FAILED", f"OCCT could not {kind} the edges",
                                     {"edges": [e.key for e in es], "reason": "OCCT BRepFilletAPI failed"})
            shown = _evidence_limits(evidence, safe, es)
            if not shown:
                # W7b review 3: no geometric limit is shown (OCCT only failed): not a `*_TOO_LARGE`
                # that asserts one; W7b review 5: nor §6.6's `*_FAILED`, which a both-fail would
                # compare as MATCH — OCCT's own failure is engine-internal (`OCCT_*_FAILED`)
                raise FeatureFailure(f"OCCT_{P}_FAILED",
                                     f"OCCT could not {kind} the edges at {size} (the largest size it builds is "
                                     f"{safe}; no face-width or curvature limit is shown)",
                                     {"edges": [e.key for e in es], "reason": "OCCT BRepFilletAPI failed"})
            _too_large(P, size, safe, shown, st.names)
        results.append((b, nb))
    created = []
    faces_created: list[str] = []
    norm_rules: set[str] = set()
    for b, nb in results:
        if nb.naming_error:
            raise TopoError("OCCT_NAMING_FAILED", f"{kind} result: {nb.naming_error}")
        prefix = f"{fid}/{'bevel' if ch else 'blend'}:"
        left = _blend_face_types(nb, f"{fid}/")
        if left:
            norm_rules.add("4")
        if _nonnormative_corner(b, [e for e in all_edges if e.body is b], ch):
            norm_rules.add("5")
        faces_created += sorted({x.key for x in nb.faces if x.key.startswith(prefix) or
                                 x.key.startswith(f"{fid}/corner:")}, key=str.encode)
        created.append((b, nb))
    _check_volume_direction(created, all_edges)
    st.bodies[:] = [next((n for bb, n in created if bb is b), b) for b in st.bodies]
    entry["bodies"] = [body_report(nb, "modified") for _, nb in created]
    entry[kind] = {"edges": [e.key for e in all_edges], "chain_added": [e.key for e in added],
                   "faces_created": faces_created}
    for r in sorted(norm_rules):
        det: dict = {"rule": r}
        if r == "4":  # the normative blend surface types a still free-form blend face stands for
            det["types"] = ["cone", "plane"] if ch else ["cylinder", "sphere", "torus"]
        warns.append({"code": "ORACLE_NORMALIZED", "severity": "info",
                      "message": f"§8.3 rule {r} ({'free-form blend faces' if r == '4' else 'engine-defined corner patches'})",
                      "details": det})


def _evidence_limits(evidence: dict, safe: float, es: list[Entity]) -> list[dict]:
    """The limits a failed build **shows** (W7b review 3), from the smallest failing size above
    `safe` that left evidence: a face of the body the blend consumed (`face-width` on that face, for
    the set's edges adjacent to it, else for every edge of the set), a normative edge whose blend
    ran into another face (`face-width` of that edge, the face not known). [] when OCCT only
    failed."""
    for x in sorted(k for k in evidence if k > safe):
        out = []
        for kind, ent in evidence[x]:
            if kind == "face":
                near = [e for e in es if any(f is ent for f in e.body.faces_of_edge(e))] or es
                out += [{"edge": e, "face": ent, "max": safe, "limit": "face-width"} for e in near]
            elif kind == "blend":
                out.append({"edge": ent, "face": None, "max": safe, "limit": "face-width"})
        if out:
            return out
    return []


def _too_large(P: str, size: float, mx: float, viol: list, names: dict) -> None:
    """`mx` is the verified safe value (`_safe_max`). Each failing edge's `max_r` / `max_d` is its
    own limit rounded down, and never above `mx`: "in the context of the whole set" (§6.6), the
    set builds only up to `mx`, which is then the minimum over the edges as §6.6 defines it. A
    value of 0.0 says no size fits (a two-distance chamfer whose `d2` alone is too wide)."""
    def each(v) -> float:
        return min(_round_down(v["max"]), mx)

    # one entry per edge (an edge is limited on both its faces, and again by a pair): its
    # smallest limit and the face that sets it
    per: dict[int, dict] = {}
    for v in viol:
        k = id(v["edge"])
        if k not in per or v["max"] < per[k]["max"]:
            per[k] = v
    viol = sorted(per.values(), key=lambda v: v["edge"].key.encode())
    if P == "FILLET":
        raise FeatureFailure("FILLET_RADIUS_TOO_LARGE", f"max feasible r = {mx}",
                             {"r": size, "max_feasible_r": mx,
                              "edges": [{"key": v["edge"].key, "name": _display(v["edge"].key, names),
                                         "max_r": each(v), "limit": v.get("limit", "face-width"),
                                         **({"face": v["face"].key} if v.get("face") is not None else {})}
                                        for v in viol]})
    raise FeatureFailure("CHAMFER_DISTANCE_TOO_LARGE", f"max feasible d = {mx}",
                         {"d": size, "max_feasible_d": mx,
                          "edges": [{"key": v["edge"].key, "name": _display(v["edge"].key, names),
                                     "max_d": each(v)} for v in viol]})


def _blend_bound(edges: list[Entity], ch: bool, ang) -> float:
    """A size no blend of the set can reach (the start of the fallback bisection when no analytic
    limit applies): an edge's setback on an adjacent face — `r / |tan(θ/2)|` for a fillet (θ at
    the edge's midpoint), `d`, or `d·tan(angle)` — cannot exceed that face's own diameter (the
    diagonal of its bounding box), so no size above `diameter·max(1, k)` fits the edge; the set's
    bound is the smallest over its edges. Only a bisection start: a value too small under-reports
    the maximum (still verified), never an infeasible one."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    best = math.inf
    for e in edges:
        if ch:
            k = 1.0 if ang is None else max(1.0, 1.0 / math.tan(math.radians(ang)))
        else:
            ht = _half_tan(e)
            k = max(1.0, abs(ht)) if ht is not None else 1.0
        diam = 0.0
        for f in e.body.faces_of_edge(e):
            box = Bnd_Box()
            for piece in f.parts():
                BRepBndLib.AddOptimal_s(piece, box, False, False)
            if not box.IsVoid():
                x0, y0, z0, x1, y1, z1 = box.Get()
                diam = max(diam, geom.dist((x0, y0, z0), (x1, y1, z1)))
        if diam > 0.0:
            best = min(best, diam * k)
    return best


def _bisect(ok, hi: float) -> float | None:
    """The largest size in (0, hi) that succeeds, to BISECT_REL relative (None: none found):
    halving from `hi` down to *tol* (a size must exceed it) until one succeeds, then bisecting
    between it and its double."""
    lo = None
    x = hi
    while x > 2.0 * TOL:
        x *= 0.5
        if ok(x):
            lo = x
            break
    if lo is None:
        return None
    up = min(hi, lo * 2.0)
    while up - lo > BISECT_REL * lo:
        mid = 0.5 * (lo + up)
        if ok(mid):
            lo = mid
        else:
            up = mid
    return lo


def _normative_kind(e: Entity, ch: bool) -> str | None:
    """The §6.6 / §6.7 normative blend surface of an edge — a line between two planes (fillet
    `cylinder`, chamfer `plane`), a circle (arc) between a plane perpendicular to a cylinder's or
    cone's axis and that cylinder or cone, coaxial (fillet `torus`, chamfer `cone`) — None for other
    pairs (engine-defined, §8.3 rule 4)."""
    fs = e.body.faces_of_edge(e)
    if len(fs) != 2 or fs[0] is fs[1]:
        return None
    if e.type == "line" and all(f.type == "plane" for f in fs):
        return "plane" if ch else "cylinder"
    if e.type != "circle":
        return None
    planes = [f for f in fs if f.type == "plane"]
    rev = [f for f in fs if f.type in ("cylinder", "cone")]
    if len(planes) != 1 or len(rev) != 1:
        return None
    ax, n, cax = e.circle_axis(), planes[0].plane_normal(), rev[0].surface_axis()
    if ax is None or n is None or cax is None:
        return None
    if geom.norm(geom.cross(n, ax.direction)) > ANG or geom.norm(geom.cross(cax.direction, ax.direction)) > ANG:
        return None
    rel = geom.sub(ax.origin, cax.origin)
    if geom.norm(geom.sub(rel, geom.mul(cax.direction, geom.dot(rel, cax.direction)))) > TOL:
        return None
    return "cone" if ch else "torus"


def _surface_kind(face, tol: float) -> tuple[str, float | None]:
    """A result face's canonical type — free-form surfaces recognized within `tol` (§8.3 rule 4's
    recognizer) — and its blend radius (a cylinder's radius, a torus's minor radius; None
    otherwise)."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType as ST
    from OCP.gp import gp_Cone, gp_Cylinder, gp_Sphere
    from OCP.ShapeAnalysis import ShapeAnalysis_CanonicalRecognition

    ad = BRepAdaptor_Surface(face, False)
    t = ad.GetType()
    kind = occt.face_type(face)
    if t == ST.GeomAbs_Cylinder:
        return kind, ad.Cylinder().Radius()
    if t == ST.GeomAbs_Torus:
        return kind, ad.Torus().MinorRadius()
    if t == ST.GeomAbs_SurfaceOfRevolution and kind in ("torus", "cylinder"):
        # `occt.face_type` classified the revolved curve; the blend radius is the revolved circle's
        # radius (torus) or the revolved line's distance from the axis (cylinder)
        from OCP.GeomAbs import GeomAbs_CurveType as CT

        bc, axr = ad.BasisCurve(), ad.AxeOfRevolution()
        if kind == "torus" and bc.GetType() == CT.GeomAbs_Circle:
            return kind, bc.Circle().Radius()
        if kind == "cylinder" and bc.GetType() == CT.GeomAbs_Line:
            q, o = bc.Line().Location(), axr.Location()
            a = (axr.Direction().X(), axr.Direction().Y(), axr.Direction().Z())
            rel = (q.X() - o.X(), q.Y() - o.Y(), q.Z() - o.Z())
            return kind, geom.norm(geom.sub(rel, geom.mul(a, geom.dot(rel, a))))
        return kind, None
    if t not in (ST.GeomAbs_BSplineSurface, ST.GeomAbs_BezierSurface, ST.GeomAbs_OffsetSurface,
                 ST.GeomAbs_SurfaceOfRevolution):
        return kind, None
    cr = ShapeAnalysis_CanonicalRecognition(face)
    for name, fn, obj in (("plane", cr.IsPlane, gp_Pln()), ("cylinder", cr.IsCylinder, gp_Cylinder()),
                          ("cone", cr.IsCone, gp_Cone()), ("sphere", cr.IsSphere, gp_Sphere())):
        try:
            if fn(tol, obj):
                return name, (obj.Radius() if name == "cylinder" else None)
        except Exception:
            continue
    return ("torus" if kind == "torus" else "bspline"), None


def _normative_blends_ok(sol, mk, b: Body, edges: list[Entity], size: float, ch: bool) -> list[Entity]:
    """The edges of a normative pair (`_normative_kind`) whose blend in OCCT's result is **not** the
    §6.6 / §6.7 one ([] when all are): the faces generated from the edge must be one connected
    patch (pieces split only along a seam, sharing edges), every piece of the normative type (free-
    form pieces recognized at `1e-7·s`, as rule 4 does) and, for a fillet, of radius `r` (within
    *tol* plus that recognition tolerance). A rolling ball that runs into another face — a hole
    narrower than the face's extent, a notch — makes OCCT split the blend or patch it with a
    free-form face: that is a blend too large for the face, not an approximation to relax (W7b
    review 3), so the size is infeasible and bisected like a failure."""
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape

    m = b.body_metrics()
    tol = 1e-7 * max(1.0, geom.dist(tuple(m["bbox_min"]), tuple(m["bbox_max"])))
    rmap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(sol, TopAbs_FACE, rmap)
    anc = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(sol, TopAbs_EDGE, TopAbs_FACE, anc)
    bad = []
    for e in edges:
        want = _normative_kind(e, ch)
        if want is None:
            continue
        idx = sorted({i for piece in e.parts() for img in mk.Generated(piece) if (i := rmap.FindIndex(img))})
        ok = bool(idx)
        for i in idx:
            kind, rad = _surface_kind(TopoDS.Face_s(rmap.FindKey(i)), tol)
            if kind != want or (not ch and (rad is None or abs(rad - size) > TOL + tol)):
                ok = False
                break
        if ok and len(idx) > 1:
            # one patch: the generated faces connected through shared edges
            seen, todo = {idx[0]}, [idx[0]]
            members = set(idx)
            while todo:
                fx = TopoDS.Face_s(rmap.FindKey(todo.pop()))
                ex = TopTools_IndexedMapOfShape()
                TopExp.MapShapes_s(fx, TopAbs_EDGE, ex)
                for k in range(1, ex.Extent() + 1):
                    j = anc.FindIndex(ex.FindKey(k))
                    if not j:
                        continue
                    for g in anc.FindFromIndex(j):
                        gi = rmap.FindIndex(g)
                        if gi in members and gi not in seen:
                            seen.add(gi)
                            todo.append(gi)
            ok = seen == members
        if not ok:
            bad.append(e)
    return bad


def _build_blend(b: Body, edges: list[Entity], size: float, ch: bool, d2, ang, side, fid: str,
                 check: bool = True, why: list | None = None) -> Body | None:
    """The blended body, None when OCCT fails or its result is not the blend. `why` (when given)
    collects the evidence of a size too large: `("face", F)` for a face of the body the result lost
    (the blend consumed it), `("blend", E)` for a normative edge whose blend is not the rolling
    ball / bevel of §6.6 / §6.7 (it ran into another face)."""
    try:
        mk = BRepFilletAPI_MakeChamfer(b.solid) if ch else BRepFilletAPI_MakeFillet(b.solid)
        for e in edges:
            for piece in e.parts():
                if not ch:
                    mk.Add(size, piece)
                elif side is not None and d2 is not None:
                    mk.Add(size, d2, piece, side.nearest_part(e.point()))
                elif side is not None and ang is not None:
                    mk.AddDA(size, math.radians(ang), piece, side.nearest_part(e.point()))
                else:
                    mk.Add(size, piece)
        mk.Build()
        if not mk.IsDone():
            return None
        shape = mk.Shape()
    except Exception:
        return None
    from .booleans import _solids

    sols = _solids(shape)
    if len(sols) != 1 or not BRepCheck_Analyzer(sols[0]).IsValid():
        return None
    # no face of the body vanished: a blend that consumes an adjacent face is wider than it (§6.6:
    # at least *tol* of the face must remain) — OCCT builds such results (a cylinder's cap
    # filleted with r = R becomes a sphere patch), which are "too large", not a blend; and every
    # blended edge produced blend faces (an unchanged body is no blend)
    rmap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(sols[0], TopAbs_FACE, rmap)
    lost = [f for f in b.faces
            if not any(rmap.FindIndex(img) for piece in f.parts() for img in _face_images(mk, piece))]
    if lost:
        if why is not None:
            why += [("face", f) for f in lost]
        return None
    for e in edges:
        if not any(rmap.FindIndex(img) for piece in e.parts() for img in mk.Generated(piece)):
            return None
    off = _normative_blends_ok(sols[0], mk, b, edges, size, ch)
    if off:
        if why is not None:
            why += [("blend", e) for e in off]
        return None
    if not check:
        return b
    # exactly the expanded set was blended (OCCT propagates along tangent edges by itself)
    want = {id(e) for e in edges}
    for e in b.edges:
        gen = any(True for piece in e.parts() for _ in mk.Generated(piece))
        if gen != (id(e) in want):
            raise TopoError("ORACLE_BLEND_PROPAGATION",
                            f"OCCT blended {'' if gen else 'not '}{e.key}, the §6.6 edge set says otherwise")
    tag = "bevel" if ch else "blend"

    def gen_key(kind, ent):
        if kind == "edge" and id(ent) in want:
            return f"{fid}/{tag}:{{{ent.key}}}"
        if kind == "vertex":
            return f"{fid}/corner:{{{ent.key}}}"
        return None

    return name_history(sols[0], mk, b, fid, gen_key)


def _face_images(mk, piece) -> list:
    """A face's images through a local operation's history: its modifications, else itself unless
    deleted."""
    out = [x for x in mk.Modified(piece)]
    if out:
        return out
    return [] if mk.IsDeleted(piece) else [piece]


def _nonnormative_corner(b: Body, edges: list[Entity], ch: bool) -> bool:
    """§8.3 rule 5: a vertex where ≥ 3 blended edges meet, other than the normative spherical corner
    (three convex line edges between mutually perpendicular planes, one radius — fillets only)."""
    ids = {id(e) for e in edges}
    for v in b.vertices:
        es = [e for e in b.edges_of_vertex(v) if id(e) in ids]
        if len(es) < 3:
            continue
        if ch or len(es) != 3:
            return True
        faces = {id(f): f for e in es for f in b.faces_of_edge(e)}
        if len(faces) != 3 or any(f.type != "plane" for f in faces.values()):
            return True
        ns = [f.plane_normal() for f in faces.values()]
        # mutually perpendicular: |nᵢ · nⱼ| ≤ ANGULAR_TOLERANCE (§1's classification constant)
        if any(n is None for n in ns) or any(abs(geom.dot(ns[i], ns[j])) > ANG for i in range(3) for j in range(i + 1, 3)):
            return True
        if any(convexity(e) != "convex" or e.type != "line" for e in es):
            return True
    return False


def _check_volume_direction(created: list, edges: list[Entity]) -> None:
    """Convex edges remove volume, concave ones add it — beyond the volume's float noise
    (`VOLUME_NOISE_REL`): a strict `v1 < v0` would pass on noise alone. A change within the noise
    (a blend of a few *tol* on a large body) is not evidence either way; `_build_blend` has then
    verified the structure (every blended edge replaced by blend faces, no face lost)."""
    for b, nb in created:
        es = [e for e in edges if e.body is b]
        cs = {convexity(e) for e in es}
        v0, v1 = b.body_metrics()["volume"], nb.body_metrics()["volume"]
        noise = VOLUME_NOISE_REL * max(abs(v0), abs(v1))
        if cs == {"convex"} and v1 > v0 + noise:
            raise TopoError("OCCT_SELF_CHECK_FAILED", f"blending convex edges did not remove volume ({v0} -> {v1})")
        if cs == {"concave"} and v1 < v0 - noise:
            raise TopoError("OCCT_SELF_CHECK_FAILED", f"blending concave edges did not add volume ({v0} -> {v1})")


# ---------------------------------------------------------------------------------------------
# Shell
# ---------------------------------------------------------------------------------------------

def _offset_radius_limit(b: Body, inward: bool) -> tuple[float, Entity] | None:
    """The smallest thickness at which an offset surface degenerates (§6.8 `curvature`): a convex
    curved face offset inward (or a concave one outward) by its radius — with that face."""
    best = None
    for f in b.faces:
        if f.type not in ("cylinder", "sphere", "torus", "cone"):
            continue
        r = f.radius()
        if r is None:
            continue
        p = f.point()
        n = f.normal_at(p)
        ax = f.surface_axis()
        if n is None:
            continue
        # a convex face's outward normal points away from its axis / centre
        if f.type == "sphere":
            from OCP.BRepAdaptor import BRepAdaptor_Surface

            ad = BRepAdaptor_Surface(f.shape, False)
            c = (ad.Sphere().Location().X(), ad.Sphere().Location().Y(), ad.Sphere().Location().Z())
            away = geom.sub(p, c)
        elif ax is not None:
            rel = geom.sub(p, ax.origin)
            away = geom.sub(rel, geom.mul(ax.direction, geom.dot(rel, ax.direction)))
        else:
            continue
        convex = geom.dot(away, n) > 0.0
        if convex == inward and (best is None or r < best[0]):
            best = (r, f)
    return best


def _gap_limits(b: Body, open_faces: list[Entity], inward: bool, cap: float) -> list[tuple[float, list[Entity]]]:
    """The thicknesses at which opposite walls collide (§6.8 `gap`) below `cap`, each with its
    (non-open) faces: from every pair of faces with a **double normal** — closest points `p ∈ F`,
    `q ∈ G` (`BRepExtrema`) at a distance `w > tol` where both outward normals are parallel to
    `q − p` (within `QUERY_ANGLE_TOLERANCE`) — facing each other through the material for an
    inward shell (`n_F·u < 0 < n_G·u`, the midpoint inside the body) or through the air for an
    outward one (the signs reversed, the midpoint outside). Both offset, the walls meet at `w/2`;
    for an inward shell with one of them opened, the other's offset reaches the opening at `w`
    (pairs with an open face are not limits of an outward shell, nor two open faces of any).

    This covers parallel planes facing each other (a slab's floor and ceiling), coaxial curved
    walls (a tube's outer and inner cylinder, concentric spheres, tori sharing axis and major
    radius) and a plane facing a cylinder whose axis is parallel to it (a hole near a side wall);
    it replaces the parallel-planes-only test, under which a tube shelled past its wall came back
    from OCCT unchanged and was reported `ok`. Adjacent faces (sharing an edge) are skipped, and so
    are pairs whose bounding boxes are too far apart to give a limit below `cap`. A collision this
    does not see (three walls closing in, like a triangular prism's incircle) is left to OCCT and
    the structural check of `_build_shell`."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.TopAbs import TopAbs_IN, TopAbs_OUT

    from .topo import outward_normal

    opened = {id(x) for x in open_faces}
    faces = b.faces
    boxes = []
    for f in faces:
        box = Bnd_Box()
        for piece in f.parts():
            BRepBndLib.AddOptimal_s(piece, box, False, False)
        boxes.append(box)
    adjacent: set[tuple[int, int]] = set()
    for e in b.edges:
        fs = b.faces_of_edge(e)
        for x in fs:
            for y in fs:
                adjacent.add((id(x), id(y)))
    sin_tol = math.sin(QUERY_ANGLE_TOLERANCE)
    out = []
    for i, f in enumerate(faces):
        for j in range(i + 1, len(faces)):
            g = faces[j]
            o1, o2 = id(f) in opened, id(g) in opened
            if (o1 and o2) or (not inward and (o1 or o2)) or (id(f), id(g)) in adjacent:
                continue
            both = not (o1 or o2)
            lb = 0.0 if boxes[i].IsVoid() or boxes[j].IsVoid() else boxes[i].Distance(boxes[j])
            if (lb / 2.0 if both else lb) >= cap:
                continue
            best = None
            for p in f.parts():
                for q in g.parts():
                    d = BRepExtrema_DistShapeShape(p, q)
                    if not (d.IsDone() and d.NbSolution() > 0) or not d.Value() > TOL:
                        continue
                    for k in range(1, d.NbSolution() + 1):
                        a, c = d.PointOnShape1(k), d.PointOnShape2(k)
                        pa, pc = (a.X(), a.Y(), a.Z()), (c.X(), c.Y(), c.Z())
                        u = geom.unit(geom.sub(pc, pa))
                        na, nc = outward_normal(p, pa), outward_normal(q, pc)
                        if na is None or nc is None:
                            continue
                        if geom.norm(geom.cross(na, u)) > sin_tol or geom.norm(geom.cross(nc, u)) > sin_tol:
                            continue
                        da, dc = geom.dot(na, u), geom.dot(nc, u)
                        if not ((da < 0.0 < dc) if inward else (da > 0.0 > dc)):
                            continue
                        # the segment runs through the material (inward) or the air (outward):
                        # no sample of it on the other side (ON: BRepExtrema's solutions between
                        # parallel faces lie on their boundaries, the segment along a side face)
                        wrong = TopAbs_OUT if inward else TopAbs_IN
                        if any(BRepClass3d_SolidClassifier(
                                b.solid, gp_Pnt(*geom.add(pa, geom.mul(geom.sub(pc, pa), s))), 1e-9).State() == wrong
                               for s in (0.25, 0.5, 0.75)):
                            continue
                        w = d.Value()
                        lim = w / 2.0 if both else w
                        if best is None or lim < best:
                            best = lim
                        break
            if best is not None and best < cap:
                out.append((best, [x for x, o in ((f, o1), (g, o2)) if not o]))
    out.sort(key=lambda x: x[0])
    return out


def shell_feature(ev, st, fi: int, f: dict, entry: dict, refs: list) -> None:
    warns = entry["warnings"]
    fid = f["id"]
    t = ev.scalar(st, f["thickness"], "length")
    if not t > TOL:
        raise FeatureFailure("INVALID_VALUE", f"thickness = {t}: must be > 0.000001",
                             {"field": "/thickness", "value": t, "expected": "> 0.000001"})
    inward = f.get("direction", "inward") == "inward"
    (b,) = ev.resolve(st, f["body"], "one", "/body", refs, warns)
    open_faces = list(ev.resolve(st, f["open"], "any", "/open", refs, warns)) if "open" in f else []
    bad = [x for x in open_faces if x.body is not b]
    if bad:
        raise FeatureFailure("SHELL_FACE_NOT_ON_BODY", f"{bad[0].key} is not a face of the shelled body",
                             {"faces": [x.key for x in bad]})
    # Analytic limits (§6.8): an offset surface degenerates (radius ≤ 0) at `curv`, opposite walls
    # collide at each `gaps` entry. As for the blends' width limits, a thickness must leave at
    # least *tol* (a radius or a gap within *tol* of zero is degenerate by [R-3]): feasible iff
    # t ≤ limit − tol, and the reported value is verified by building it (`_safe_max`).
    missing: dict[float, list[Entity]] = {}

    def builds(x: float) -> bool:
        why: list[Entity] = []
        ok = _build_shell(b, open_faces, x, inward, fid, check=False, why=why) is not None
        if not ok:
            missing[x] = why
        return ok

    def face_limit(x: Entity, reason: str) -> dict:
        return {"key": x.key, "name": _display(x.key, st.names), "reason": reason}

    curv = _offset_radius_limit(b, inward)
    limits: list[tuple[float, list[dict]]] = []
    if curv is not None:
        limits.append((curv[0], [face_limit(curv[1], "curvature")]))
    for lim, fs in _gap_limits(b, open_faces, inward, t + TOL):
        limits.append((lim, [face_limit(x, "gap") for x in fs]))
    viol = [(x, why) for x, why in limits if t > x - TOL]
    if viol:
        # OCCT may still return a (meaningless) solid here: the analytic limit decides
        mx = min(x for x, _ in limits) - TOL
        safe = _safe_max(builds, mx) if mx > 0.0 else 0.0
        if safe is None:
            raise FeatureFailure("OCCT_SHELL_FAILED", "OCCT could not shell the body at any thickness up to the limit",
                                 {"reason": "OCCT BRepOffsetAPI_MakeThickSolid failed"})
        what = " and ".join(sorted({"an offset surface degenerates" if w[0]["reason"] == "curvature"
                                    else "opposite walls collide" for _, w in viol}))
        raise FeatureFailure("SHELL_THICKNESS_TOO_LARGE", f"{what} at thickness {min(x for x, _ in viol)}",
                             {"thickness": t, "max_feasible_thickness": safe,
                              "limits": _unique_limits([w for _, ws in viol for w in ws])})
    why: list[Entity] = []
    nb = _build_shell(b, open_faces, t, inward, fid, why=why)
    if nb is None:
        # OCCT fails, or returns a solid that is not the shell (`_build_shell`): bisected from a
        # geometric bound (inward: the body's diameter — no cavity survives a thickness beyond it),
        # never from the request; outward thicknesses have no such bound
        missing[t] = why
        m = b.body_metrics()
        # the body's diameter for both directions (W7b review 3: outward shells bisected from the
        # request, so their maximum depended on it — 8.473, 8.477, 8.478 for t = 8.6, 9, 12): a
        # fixed geometric start, halved until something builds, then bisected
        bound = geom.dist(tuple(m["bbox_min"]), tuple(m["bbox_max"]))
        safe = _fallback_max(builds, t, bound)
        if safe is None:
            raise FeatureFailure("OCCT_SHELL_FAILED", "OCCT could not shell the body",
                                 {"reason": "OCCT BRepOffsetAPI_MakeThickSolid failed"})
        # the limiting faces, only where a collision is **shown** (W7b review 3): those OCCT left
        # without an offset at the smallest failing thickness above the maximum (when it returned
        # a solid), else the walls whose offset faces vanish between the maximum and the smallest
        # failing thickness (`_collapsing_faces`: walls closing in, like a prism's three walls at
        # its inradius or a V-groove's two walls). The reason is `gap` — §6.8's "opposite walls
        # collide", here walls that are not parallel. Without either, OCCT only failed: not a
        # collision the oracle has not shown, and not §6.8's `SHELL_FAILED` either (W7b review 5:
        # a notched box opened on its notched top is a shell §6.8 defines — 2534 mm³ in closed
        # form, Forge builds it — that OCCT returns unchanged; had both engines said
        # `SHELL_FAILED` the diff would call it MATCH): OCCT's own failure, `OCCT_SHELL_FAILED`.
        fails = sorted(x for x in missing if x > safe)
        faces = next((missing[x] for x in fails if missing[x]), None)
        if not faces and fails:
            faces = _collapsing_faces(b, open_faces, inward, fid, safe, fails[0])
        if not faces:
            raise FeatureFailure("OCCT_SHELL_FAILED",
                                 f"OCCT could not shell the body at {t} (the largest thickness it builds is {safe}; "
                                 "no degenerate offset or wall collision is shown)",
                                 {"reason": "OCCT BRepOffsetAPI_MakeThickSolid failed"})
        raise FeatureFailure("SHELL_THICKNESS_TOO_LARGE", f"max feasible thickness = {safe}",
                             {"thickness": t, "max_feasible_thickness": safe,
                              "limits": _unique_limits([face_limit(x, "gap") for x in faces])})
    if nb.naming_error:
        raise TopoError("OCCT_NAMING_FAILED", f"shell result: {nb.naming_error}")
    st.bodies[:] = [nb if x is b else x for x in st.bodies]
    entry["bodies"] = [body_report(nb, "modified")]
    rep: dict = {"removed_faces": sorted((x.key for x in open_faces), key=str.encode)}
    if not open_faces:
        rep["closed_void"] = True
        warns.append({"code": "SHELL_CLOSED_VOID", "severity": "info",
                      "message": "the shell has no open face: the body gets an internal void", "details": {}})
    entry["shell"] = rep


def _collapsing_faces(b: Body, open_faces: list[Entity], inward: bool, fid: str, safe: float,
                      t_fail: float) -> list[Entity]:
    """The input faces whose offset **vanishes** between the verified maximum `safe` and the
    smallest failing thickness `t_fail` (the evidence of walls closing in when OCCT only fails):
    the shell is built (named) at `safe/2` and `safe`, and each offset face's area `A` — shrinking —
    is extrapolated to zero from the two, linearly and in `√A` (a wall narrowing in one direction,
    or a face shrinking in both: each extrapolation is exact for its own case and lands beyond the
    true zero for the other); a zero within one bisection interval past `t_fail` (`2·t_fail − safe`)
    is a collapse at the limit. A face that only shrinks lands far beyond it."""
    t1, t2 = 0.5 * safe, safe
    if not t1 > TOL:
        return []
    hi = _build_shell(b, open_faces, t2, inward, fid)
    lo = _build_shell(b, open_faces, t1, inward, fid)
    if hi is None or lo is None or hi.naming_error or lo.naming_error:
        return []
    area_lo: dict[str, float] = {}
    for f in lo.faces:
        area_lo[f.key] = area_lo.get(f.key, 0.0) + f.size
    area_hi: dict[str, float] = {}
    for f in hi.faces:
        area_hi[f.key] = area_hi.get(f.key, 0.0) + f.size
    by_key = {x.key: x for x in b.faces}
    opened = {id(x) for x in open_faces}
    out: list[Entity] = []
    for k in sorted(area_hi, key=str.encode):
        a2, a1 = area_hi[k], area_lo.get(k)
        if a1 is None or not a2 < a1:
            continue
        z_lin = t2 + a2 * (t2 - t1) / (a1 - a2)
        z_sqrt = t2 + math.sqrt(a2) * (t2 - t1) / (math.sqrt(a1) - math.sqrt(a2))
        if min(z_lin, z_sqrt) > 2.0 * t_fail - safe:
            continue
        pre = f"{fid}/offset:{{"
        src = by_key.get(k[len(pre):-1] if k.startswith(pre) and k.endswith("}") else k)
        if src is not None and id(src) not in opened and all(src is not x for x in out):
            out.append(src)
    return out


def _unique_limits(ls: list[dict]) -> list[dict]:
    seen = set()
    out = []
    for x in sorted(ls, key=lambda x: (x["key"].encode(), x["reason"])):
        k = (x["key"], x["reason"])
        if k not in seen:
            seen.add(k)
            out.append(x)
    return out


def _shell_structure(b: Body, open_faces: list[Entity], sol, mk, inward: bool) -> list[Entity] | None:
    """None when the solid OCCT returned is the shell of `b` (§6.8); else the non-open faces that
    have no offset image ([] for another defect). A thickness past a collision this oracle does
    not compute analytically (three walls closing in; walls OCCT's intersection joins cannot
    trim) can come back from `MakeThickSolid` as the **input body unchanged** — valid, with the
    opened face still there and the volume within float noise of the input's — which a strict
    `v1 < v0` accepted. So: every opened face is gone from the result, every other face has an
    offset image in the history (`Generated`), and the volume changed beyond its float noise
    (inward: the material left is less than the body and more than nothing; outward: the wall has
    volume)."""
    rmap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(sol, TopAbs_FACE, rmap)
    for x in open_faces:
        for piece in x.parts():
            if rmap.FindIndex(piece):
                return []
    opened = {id(x) for x in open_faces}
    lost = [f for f in b.faces if id(f) not in opened and
            not any(rmap.FindIndex(img) for piece in f.parts() for img in mk.Generated(piece))]
    if lost:
        return lost
    v0 = b.body_metrics()["volume"]
    v1 = occt.body_metrics(sol)["volume"]
    noise = VOLUME_NOISE_REL * max(abs(v0), abs(v1))
    if not v1 > noise:
        return []
    if inward and not v1 < v0 - noise:
        return []
    return None


def _build_shell(b: Body, open_faces: list[Entity], t: float, inward: bool, fid: str,
                 check: bool = True, why: list | None = None) -> Body | None:
    """The shelled body, None when OCCT fails or its solid is not the shell (`_shell_structure`;
    the faces without an offset then go to `why`). `check=False`: only whether it builds."""
    try:
        lst = TopTools_ListOfShape()
        for x in open_faces:
            for piece in x.parts():
                lst.Append(piece)
        mk = BRepOffsetAPI_MakeThickSolid()
        mk.MakeThickSolidByJoin(b.solid, lst, -t if inward else t, 1e-7, BRepOffset_Skin, False, False,
                                GeomAbs_Intersection)
        mk.Build()
        if not mk.IsDone():
            return None
        shape = mk.Shape()
    except Exception:
        return None
    from .booleans import _solids

    if not open_faces:
        # with no face to remove OCCT returns the offset body alone (OCP 7.9.3); the closed shell
        # is the body with that offset's boundary as an internal void (§6.8: 2 shells)
        shape, mk = _closed_shell(b.solid, shape, mk, inward)
        if shape is None:
            return None
    sols = _solids(shape)
    if len(sols) != 1 or not BRepCheck_Analyzer(sols[0]).IsValid():
        return None
    shells = count_shells(sols[0])
    if shells != (1 if open_faces else 2):
        return None
    lost = _shell_structure(b, open_faces, sols[0], mk, inward)
    if lost is not None:
        if why is not None:
            why += lost
        return None
    if not check:
        return b

    def gen_key(kind, ent):
        if kind == "face":
            return f"{fid}/offset:{{{ent.key}}}"
        return None

    def rims(rmap, face_src, face_origin):
        # MakeThickSolid reports the rim closing an opened face X as a modification of X
        for x in open_faces:
            for piece in x.parts():
                for img in mk.Modified(piece):
                    i = rmap.FindIndex(img)
                    if i:
                        face_src[i] = [k for k in face_src.get(i, []) if k != x.key] + [f"{fid}/rim:{{{x.key}}}"]
                        face_origin.setdefault(i, set()).add(-id(x) - 1)

    return name_history(sols[0], mk, b, fid, gen_key, extra_faces=rims)


class _ClosedHistory:
    """The history of a closed shell assembled by `_closed_shell`: the original faces are kept (no
    modification), the offset faces are *generated* from them (`S/offset:{X}`)."""

    def __init__(self, mk):
        self.mk = mk

    def Modified(self, s):
        return []

    def IsDeleted(self, s):
        return False

    def Generated(self, s):
        return [x for x in self.mk.Modified(s)] + [x for x in self.mk.Generated(s)]


def _closed_shell(solid, offset_shape, mk, inward: bool):
    from OCP.BRep import BRep_Builder
    from OCP.TopAbs import TopAbs_SHELL
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS_Solid

    def shells(sh):
        out = []
        ex = TopExp_Explorer(sh, TopAbs_SHELL)
        while ex.More():
            out.append(TopoDS.Shell_s(ex.Current()))
            ex.Next()
        return out

    orig, off = shells(solid), shells(offset_shape)
    if len(orig) != 1 or len(off) != 1:
        return None, mk
    bld = BRep_Builder()

    def signed_volume(*parts) -> float:
        from OCP.BRepGProp import BRepGProp
        from OCP.GProp import GProp_GProps

        s = TopoDS_Solid()
        bld.MakeSolid(s)
        for x in parts:
            bld.Add(s, x)
        g = GProp_GProps()
        BRepGProp.VolumeProperties_s(s, g, False, False, False)
        return g.Mass()

    def positive(sh):
        """The shell oriented to enclose positive volume (W7b review 3: OCCT's outward offset shell
        comes back oriented inward, so the solid assembled from it had both shells inward, a
        negative volume and failed BRepCheck — every closed outward shell was `SHELL_FAILED`)."""
        v = signed_volume(sh)
        return (sh, v) if v > 0.0 else (TopoDS.Shell_s(sh.Reversed()), -v)

    (outer, vo), (inner, vi) = positive(orig[0] if inward else off[0]), positive(off[0] if inward else orig[0])
    if not vo > vi > 0.0:
        return None, mk
    res = TopoDS_Solid()
    bld.MakeSolid(res)
    bld.Add(res, outer)
    bld.Add(res, inner.Reversed())
    # the void is subtracted: the solid's volume is the outer shell's minus the inner one's
    v = signed_volume(outer, inner.Reversed())
    if abs(v - (vo - vi)) > 1e-9 * vo:
        return None, mk
    return res, _ClosedHistory(mk)


# ---------------------------------------------------------------------------------------------
# Draft (optional in v1)
# ---------------------------------------------------------------------------------------------

def draft_feature(ev, st, fi: int, f: dict, entry: dict, refs: list) -> None:
    warns = entry["warnings"]
    fid = f["id"]
    a = ev.scalar(st, f["angle"], "angle")
    if not (0.0 < a < 45.0):
        # §0.5 rule 2: the literal check's code (validate: `INVALID_VALUE`), at evaluation
        raise FeatureFailure("INVALID_VALUE", f"angle = {a}: must be in (0, 45)",
                             {"field": "/angle", "value": a, "expected": "in (0, 45)"})
    faces = list(ev.resolve(st, f["faces"], "some", "/faces", refs, warns))
    pl = ev.plane_ref(st, f["neutral"], "/neutral", refs, warns)
    p = pl.normal if f.get("pull", "normal") == "normal" else geom.mul(pl.normal, -1.0)
    bad = []
    for x in faces:
        n = x.plane_normal()
        if x.type != "plane" or n is None or abs(geom.dot(n, p)) > math.sin(QUERY_ANGLE_TOLERANCE):
            bad.append(x.key)
    if bad:
        raise FeatureFailure("DRAFT_FACE_UNSUPPORTED", f"{len(bad)} face(s) cannot be drafted", {"faces": bad})
    bodies = []
    for x in faces:
        if all(x.body is not b for b in bodies):
            bodies.append(x.body)
    out = []
    for b in bodies:
        fs = [x for x in faces if x.body is b]
        nb = None
        for sign in (1.0, -1.0):
            nb = _build_draft(b, fs, a * sign, p, pl, fid)
            if nb is not None and _draft_normals_ok(nb, fs, a, p):
                break
            nb = None
        if nb is None:
            raise FeatureFailure("OCCT_DRAFT_FAILED", "OCCT could not draft the faces", {"faces": [x.key for x in fs]})
        out.append((b, nb))
    st.bodies[:] = [next((n for bb, n in out if bb is x), x) for x in st.bodies]
    entry["bodies"] = [body_report(nb, "modified") for _, nb in out]


def _build_draft(b: Body, faces: list[Entity], deg: float, p, pl, fid: str) -> Body | None:
    try:
        mk = BRepOffsetAPI_DraftAngle(b.solid)
        plane = gp_Pln(gp_Pnt(*pl.origin), gp_Dir(*pl.normal))
        for x in faces:
            for piece in x.parts():
                mk.Add(piece, gp_Dir(*p), math.radians(deg), plane, True)
                if not mk.AddDone():
                    return None
        mk.Build()
        if not mk.IsDone():
            return None
        shape = mk.Shape()
    except Exception:
        return None
    from .booleans import _solids

    sols = _solids(shape)
    if len(sols) != 1 or not BRepCheck_Analyzer(sols[0]).IsValid():
        return None
    return name_history(sols[0], mk, b, fid, lambda kind, ent: None)


def _draft_normals_ok(nb: Body, faces: list[Entity], a: float, p) -> bool:
    """The analytic self-check of §6.9: each drafted face's normal is `cos(a)·n + sin(a)·p`."""
    ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
    for x in faces:
        n = x.plane_normal()
        want = geom.unit(geom.add(geom.mul(n, ca), geom.mul(p, sa)))
        got = [y for y in nb.faces if y.key == x.key]
        if not got:
            return False
        m = got[0].plane_normal()
        # the normal's direction within ANGULAR_TOLERANCE (a unit-vector difference ≈ the angle)
        if m is None or geom.norm(geom.sub(m, want)) > ANG:
            return False
    return True


__all__ = ["blend_feature", "shell_feature", "draft_feature", "expand_chain", "name_history"]
