"""Body operations (SPEC-v1 §6.0.2–§6.0.5, §6.4) with OCCT `BRepAlgoAPI_*`, normalised per §8.3:
no fuzzy value, `SetRunParallel(false)`, `SetNonDestructive(true)`, then
`ShapeUpgrade_UnifySameDomain(UnifyFaces, UnifyEdges, ConcatBSplines = false)` with *tol* and
`ANGULAR_TOLERANCE` (the same-domain merge of §6.0.4), then the §8.3 rule 1 count normalization and
the rule 3 section-edge types (`normalize.py`): result bodies are built with the normalized topology
(face groups on one carrier, counted edges, merged edges) and report its counts.

* `join`: the union of the targets and tools; its connected components are the result bodies.
  [W0-39] The failure row applies **per tool**: a tool that neither meets a target nor shares a
  face of positive area with one is `BOOLEAN_NO_INTERSECTION` (`min_distance`), even when it is
  in a component with a target through another tool.
* `cut`: each target minus the union of the tools (target by target, so overlapping targets stay
  separate bodies); a target is acted on (`modified`) iff the tools **meet** it ([W0-41] step 2,
  [W0-48], [W0-53]: the common part is somewhere thicker than *tol* — `meets`); none met is
  `BOOLEAN_NO_INTERSECTION`.
* `intersect`: each target ∩ the union of the tools; targets with an empty result disappear;
  all empty is `BOOLEAN_EMPTY_RESULT`. With several tools the oracle fuses them into one operand
  first (`fused_tools`, W7b review 4): OCCT's `Common([t], [k1, k2])` returns the common part split
  per tool into solids sharing faces, which the piece and non-manifold checks took for touching
  bodies (`BOOLEAN_NON_MANIFOLD` on a valid result). The meet, piece and layer tests of cuts and
  intersects run on the same union. The intersect's volume gate is independent of the Common that
  built it: `vol(t ∩ K) = vol t − vol(t − K)` with a Cut by the separate tools.
* [W0-41] step 3 and [W0-53]: a result piece that is **degenerate** (`2V/A ≤ tol/2`) or a
  **layer** of the cut (nowhere thicker than *tol*: every sample point within *tol* of a target
  face and of a tool face, and none farther than *tol*/2 from the piece's boundary) is not
  produced; a target left with such pieces only is consumed.
* Identity (§6.0.3): a result body inherits the origin of the target it comes from; a join
  component with several targets takes the first (timeline index, member); split pieces share the
  origin (`BOOLEAN_SPLIT`); consumed targets are `BOOLEAN_BODY_CONSUMED`. [W0-40] `removed` lists,
  once each, the target origins **no body in the part carries** after the operation (never tools).
* Keys (§5.2 rule 3): faces and edges keep the key of the input entity they come from (through
  OCCT's `Modified` history and the unify history); a face or edge merged from several keeps the
  byte-wise smallest key among the targets' (else among all) and the others become aliases; new
  edges and vertices get `G/edge:{A|B}` and `G/vertex:{…}` (G = the operation's feature id).
* Gate: every result body must be BRepCheck-valid, and the volumes must satisfy the set identities
  (`vol(t − K) = vol t − vol(t ∩ K)`, `vol(a ∪ b) = vol a + vol b − vol(a ∩ b)` for two-body
  components, `vol(t ∩ K) ≤ min(vol t, vol K)`), within 1e-8 relative — else the feature fails with
  the engine-internal `OCCT_SELF_CHECK_FAILED`. Where a small volume is the difference of two large
  ones (a cut's removed part, an intersection) the allowance is 1e-8 of the small volume plus
  `VOLUME_NOISE_REL` (1e-9) of the operand's (`_close_diff`; W7b review 5: 1e-8 of the target's
  volume let a 1 mm³ intersection of a 1e6 mm³ target be 0.5 % wrong), and an intersection is
  checked from both operands' sides (`vol t − vol(t − K)` and `vol K − vol(K − t)`), so its floor
  is 1e-9 of the **smaller** operand. What the gate cannot see: an error below that floor — for a
  cut, 1e-9 of the target's volume, since the result's own volume carries the integrator's noise
  at that scale.

The [R-3] coincidence of §6.0.3 step 1 (faces within *tol* coincide) is realized by the meet and
layer tests only (the booleans run without a fuzzy value): how the oracle realizes it in the
geometry is §11.1's open issue 6, and the `identity` fixtures in that band are pending. A join
tool that shares a face with a target only within *tol* (a gap in (0, *tol*]) is therefore not
joined by the oracle: it fails with the engine-internal `ORACLE_COINCIDENCE_UNREALIZED`
(ROBUSTNESS), not `BOOLEAN_NO_INTERSECTION` (`within_tol_contact`). The same band between two
**tools** of one operation (pattern instances, hole positions, a boolean's tool set) fails the same
way (`tool_band_pairs`): for a join a gap in the band, or an overlap nowhere thicker than *tol*
(every tool is in the result: two bosses 5e-7 mm apart or overlapping by 5e-7 mm, which the SPEC
treats like tangent ones, `BOOLEAN_NON_MANIFOLD`, are never reported as two bosses or one merged
through a neck); for a cut or intersect a gap in the band inside a target it acts on (a 5e-7 mm
wall between two holes, `gap_within`). A pattern's seed tools take part as peers of its instances.
A tool face in the band of a **target** face (parallel planes, coaxial cylinders or cones,
concentric spheres at most *tol* and more than OCCT's own fuzziness apart, within *tol* of each
other) that is still a face of the result next to a face on the target face's carrier — a blind
hole's floor 5e-7 mm above the far face, a pocket's the same, a join boss's side 5e-7 mm inside the
plate's side — fails the same way (`check_target_band`, W7b review 4): the SPEC's faces coincide
(the hole opens, the sides are flush), the oracle's result keeps a membrane or a step. A band pair
whose tool face is not in the result (it cuts through, hovers outside, or is buried in a join)
changes nothing and passes.
"""

from __future__ import annotations

import math

from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex, BRepBuilderAPI_NurbsConvert
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepGProp import BRepGProp
from OCP.BRepTools import BRepTools
from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
from OCP.GProp import GProp_GProps
from OCP.gp import gp_Pnt, gp_Pnt2d
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_IN, TopAbs_ON, TopAbs_SHELL, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Compound
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape, TopTools_ListOfShape

from . import geom
from .consts import ANGULAR_TOLERANCE, LINEAR_TOLERANCE
from .normalize import section_type
from .sweeps import FeatureFailure
from .topo import Body, TopoError, body_report, point_shape_distance

GATE_REL = 1e-8
#: The volume integrator's noise on an operand, relative to its volume (`gk_volume_area`:
#: `VolumePropertiesGK` at 1e-10), with a 10× margin: the floor of the difference gates
#: (`_close_diff`), where a small volume is checked as the difference of two large ones.
VOLUME_NOISE_REL = 1e-9
TOL = LINEAR_TOLERANCE
#: `meets` / `degenerate_piece`: a region whose mean thickness `2V/A` exceeds this is taken to be
#: thicker than *tol* somewhere and is not sampled. For a **convex** region that is certain (its
#: inradius is at least `V/A`, so it exceeds *tol*/2 here — W7b review 4: the bound `V ≤ r·A`
#: holds for convex bodies only). For a non-convex region it is a heuristic: inner offsets grow at
#: reflex edges, so a comb of teeth each thinner than *tol* could have a larger mean thickness. The
#: regions tested are the **fused** common part `t ∩ ∪K` and the pieces of `t − ∪K` (one region
#: per connected component, no partition faces between tools), which keeps the regions the
#: heuristic sees as simple as the operands.
THICK_MEAN = 4.0 * TOL
#: `face_maxima`: the UV grid per face and the pattern-search steps of the thickness sampling
#: (settings of the oracle's search, not tolerances: the tests compare against *tol*).
FACE_GRID = 5
FACE_REFINE_STEPS = 24


def _list(shapes) -> TopTools_ListOfShape:
    lst = TopTools_ListOfShape()
    for s in shapes:
        lst.Append(s)
    return lst


def _run(cls, args, tools):
    op = cls()
    op.SetArguments(_list(args))
    op.SetTools(_list(tools))
    op.SetRunParallel(False)
    op.SetNonDestructive(True)
    op.SetToFillHistory(True)
    op.Build()
    if not op.IsDone():
        raise TopoError("OCCT_BOOLEAN_FAILED", f"{cls.__name__} failed")
    return op


def _unify(shape):
    usd = ShapeUpgrade_UnifySameDomain(shape, True, True, False)
    usd.SetLinearTolerance(LINEAR_TOLERANCE)
    usd.SetAngularTolerance(ANGULAR_TOLERANCE)
    usd.Build()
    return usd


def unified(shape) -> tuple[object, object | None]:
    """(shape, history) after `ShapeUpgrade_UnifySameDomain` (§8.3 rule 1) — or the operation's own
    result with no unify history when unifying makes a valid result invalid (OCP 7.9.3 does, e.g.
    for a bore along the axis of a 270° revolve): the count normalization of rule 1 then merges
    the same-carrier faces and edges itself."""
    from OCP.BRepCheck import BRepCheck_Analyzer

    usd = _unify(shape)
    out = usd.Shape()
    if BRepCheck_Analyzer(out).IsValid() or not BRepCheck_Analyzer(shape).IsValid():
        return out, usd
    return shape, None


def _solids(shape) -> list:
    out = []
    ex = TopExp_Explorer(shape, TopAbs_SOLID)
    while ex.More():
        out.append(TopoDS.Solid_s(ex.Current()))
        ex.Next()
    return out


def _sub(shape, kind) -> list:
    m = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, kind, m)
    return [m.FindKey(i) for i in range(1, m.Extent() + 1)]


def gk_volume_area(shape) -> tuple[float, float]:
    """Adaptive volume and area ([W0-44]: `VolumePropertiesGK` 1e-10, `SurfaceProperties` 1e-12)."""
    vp = GProp_GProps()
    BRepGProp.VolumePropertiesGK_s(shape, vp, 1e-10)
    sp = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, sp, 1e-12)
    return vp.Mass(), sp.Mass()


def _common(a, bs) -> list:
    op = _run(BRepAlgoAPI_Common, [a], bs)
    return _solids(op.Shape())


def _distance(a, bs) -> float:
    best = math.inf
    for b in bs:
        d = BRepExtrema_DistShapeShape(a, b)
        if d.IsDone() and d.NbSolution() > 0:
            best = min(best, d.Value())
    return best


def _foot_distance(p, face) -> float:
    """The distance from a point to a face's carrier surface when the foot (the closest point of
    the untrimmed surface) lies on the trimmed face — IN or ON, trying the periodic
    representatives of its parameters — else inf. `BRepExtrema` misses such feet on a seam (it
    then returns the distance to the seam edge, up to √2 times too large near a sphere's seam), so
    `_boundary_distance` takes the smaller of the two: both are distances to points of the face."""
    surf = BRep_Tool.Surface_s(face)
    pr = GeomAPI_ProjectPointOnSurf(gp_Pnt(*p), surf)
    if pr.NbPoints() == 0:
        return math.inf
    u, v = pr.LowerDistanceParameters()
    ad = BRepAdaptor_Surface(face, False)
    us = [0.0] + ([ad.UPeriod(), -ad.UPeriod()] if ad.IsUPeriodic() else [])
    vs = [0.0] + ([ad.VPeriod(), -ad.VPeriod()] if ad.IsVPeriodic() else [])
    for du in us:
        for dv in vs:
            st = BRepClass_FaceClassifier(face, gp_Pnt2d(u + du, v + dv), 1e-9).State()
            if st in (TopAbs_IN, TopAbs_ON):
                return pr.LowerDistance()
    return math.inf


def _boundary_distance(p, shape) -> float:
    """Distance from a point to the boundary (the shells) of a solid, inside or outside: the
    smaller of `BRepExtrema`'s and, per face, the distance to its foot on the face
    (`_foot_distance`)."""
    best = math.inf
    for sh in _sub(shape, TopAbs_SHELL):
        best = min(best, point_shape_distance(p, sh))
    for f in _sub(shape, TopAbs_FACE):
        best = min(best, _foot_distance(p, TopoDS.Face_s(f)))
    return best


def _inside(p, solid) -> bool:
    return BRepClass3d_SolidClassifier(solid, gp_Pnt(*p), 1e-9).State() == TopAbs_IN


def _nearest_on_boundary(p, shape) -> tuple[float, tuple | None]:
    """(distance, nearest point) from a point to the boundary (the shells) of a solid, with the
    feet on the faces as in `_boundary_distance`."""
    best, q = math.inf, None
    v = BRepBuilderAPI_MakeVertex(gp_Pnt(*p)).Vertex()
    for sh in _sub(shape, TopAbs_SHELL):
        d = BRepExtrema_DistShapeShape(v, sh)
        if d.IsDone() and d.NbSolution() > 0 and d.Value() < best:
            best = d.Value()
            w = d.PointOnShape2(1)
            q = (w.X(), w.Y(), w.Z())
    for f in _sub(shape, TopAbs_FACE):
        f = TopoDS.Face_s(f)
        if _foot_distance(p, f) < best:
            pr = GeomAPI_ProjectPointOnSurf(gp_Pnt(*p), BRep_Tool.Surface_s(f))
            w = pr.NearestPoint()
            best, q = pr.LowerDistance(), (w.X(), w.Y(), w.Z())
    return best, q


def face_maxima(face, measure, grid: int = FACE_GRID, steps: int = FACE_REFINE_STEPS) -> tuple[float, tuple] | None:
    """(the largest `measure` found, where) over the points of a face: a `grid × grid` UV grid of
    points classified **inside** the trimmed face (a mid-parameter point need not lie on it — e.g.
    a face crossing its surface's seam), then a pattern search from the best of them (steps of
    half a cell, halved when no neighbour improves), inside the face too. None: no grid point
    lies inside."""
    ad = BRepAdaptor_Surface(face, True)
    u0, u1, v0, v1 = BRepTools.UVBounds_s(face)

    def val(u: float, v: float):
        if BRepClass_FaceClassifier(face, gp_Pnt2d(u, v), 1e-9).State() != TopAbs_IN:
            return None
        q = ad.Value(u, v)
        p = (q.X(), q.Y(), q.Z())
        return measure(p), p

    best = None
    for i in range(grid):
        for j in range(grid):
            u = u0 + (u1 - u0) * (i + 0.5) / grid
            v = v0 + (v1 - v0) * (j + 0.5) / grid
            r = val(u, v)
            if r is not None and (best is None or r[0] > best[0]):
                best, bu, bv = r, u, v
    if best is None:
        return None
    su, sv = 0.5 * (u1 - u0) / grid, 0.5 * (v1 - v0) / grid
    for _ in range(steps):
        for du, dv in ((su, 0.0), (-su, 0.0), (0.0, sv), (0.0, -sv)):
            r = val(bu + du, bv + dv)
            if r is not None and r[0] > best[0]:
                best, bu, bv = r, bu + du, bv + dv
                break
        else:
            su, sv = 0.5 * su, 0.5 * sv
    return best


def _samples(region, measure=None, other=None) -> list:
    """Sample points of a (thin) solid region for the thickness tests: its vertices, the midpoints
    of its edges, its centre of mass when it lies inside (the mid-surface of a slab, fin, wall or
    wedge), and on each face the point where `measure` (the distance to the operand the face does
    not lie on) is largest (`face_maxima`) — the deepest point of a curved lens, which no vertex or
    edge midpoint need be near — with the midpoint between it and its nearest point on the other
    operand's boundary (`other(p)`: the centre of the widest ball there, for [W0-53]'s ball test).

    This is still a sampling of a max-min problem (a pattern search finds a local maximum per
    face): a known approximation, one-sided — it can only miss a meet (visible as a status
    difference in the diff, never a silently kept or dropped volume the oracle claims to have
    checked)."""
    pts = []
    for v in _sub(region, TopAbs_VERTEX):
        pnt = BRep_Tool.Pnt_s(TopoDS.Vertex_s(v))
        pts.append((pnt.X(), pnt.Y(), pnt.Z()))
    for e in _sub(region, TopAbs_EDGE):
        e = TopoDS.Edge_s(e)
        if BRep_Tool.Degenerated_s(e):
            continue
        ad = BRepAdaptor_Curve(e)
        q = ad.Value(0.5 * (ad.FirstParameter() + ad.LastParameter()))
        pts.append((q.X(), q.Y(), q.Z()))
    vp = GProp_GProps()
    BRepGProp.VolumeProperties_s(region, vp, False, False, False)
    c = vp.CentreOfMass()
    cp = (c.X(), c.Y(), c.Z())
    if _inside(cp, region):
        pts.append(cp)
    if measure is not None:
        for f in _sub(region, TopAbs_FACE):
            got = face_maxima(TopoDS.Face_s(f), measure)
            if got is None:
                continue
            p = got[1]
            pts.append(p)
            if other is not None:
                q = other(p)
                if q is not None:
                    pts.append(geom.mul(geom.add(p, q), 0.5))
    return pts


def _thickness_probes(target, tools: list):
    """(measure, other) for `_samples`: the face-distance thickness `max(d_T, d_K)` at a point, and
    the nearest point across the region (on the operand farther from the point)."""
    def measure(p):
        return max(_boundary_distance(p, target), min(_boundary_distance(p, k) for k in tools))

    def other(p):
        dt, qt = _nearest_on_boundary(p, target)
        best = min((_nearest_on_boundary(p, k) for k in tools), key=lambda x: x[0])
        return qt if dt > best[0] else best[1]

    return measure, other


def meets(target, tools: list) -> bool:
    """[W0-41] step 2 with [W0-48] and [W0-53]: the tools meet the target iff the common part is
    somewhere thicker than *tol*: some point of it lies farther than *tol* from the target's faces
    or from the tools' faces, or ([W0-53]'s ball test) a point **inside** it lies farther than
    *tol*/2 from its own boundary — `_boundary_distance(p, c)` for the common part `c`, the SPEC's
    measure and the one `degenerate_piece` uses. (For a point inside `c` this equals
    `min(d_T, d_K)`: ∂c ⊂ ∂T ∪ ∂K gives ≥, and the segment to the nearest point of ∂T — or of ∂K —
    crosses ∂c no later, so the form before W7b's second review was the same number, not a
    stricter one; it is written as the SPEC words it now.) A common part whose mean thickness
    `2V/A` exceeds `THICK_MEAN` qualifies at once (certain for a convex part, a heuristic for a
    non-convex one — see `THICK_MEAN`); a thinner one is decided on its sample points
    (`_samples`, with each face's deepest point). `tools` should be **one** operand, the union of
    the operation's tools (`fused_tools`): with several, `_common` splits the common part per tool
    and the ball test would measure to the partition faces between the pieces (W7b review 4)."""
    measure, other = _thickness_probes(target, tools)
    for c in _common(target, tools):
        v, a = gk_volume_area(c)
        if not v > 0.0:
            continue
        if a > 0.0 and 2.0 * v / a > THICK_MEAN:
            return True
        for p in _samples(c, measure, other):
            dt = _boundary_distance(p, target)
            dk = min(_boundary_distance(p, k) for k in tools)
            if max(dt, dk) > TOL:
                return True
            if _boundary_distance(p, c) > TOL / 2 and _inside(p, c):
                return True
    return False


def shares_face(target, tool) -> bool:
    """A join tool that shares a face of positive area with the target, **as OCCT computes it**
    (no fuzzy value, §8.3 rule 2): their union is one solid. Faces that coincide only within *tol*
    ([W0-41] step 2 counts them) are not realized here: `within_tol_contact` detects that band, and
    the join then fails with the engine-internal `ORACLE_COINCIDENCE_UNREALIZED` (§11.1 open issue 6)
    rather than asserting a catalogue code."""
    o = _run(BRepAlgoAPI_Fuse, [target], [tool])
    return len(_solids(_unify(o.Shape()).Shape())) == 1


def within_tol_contact(target, tool) -> bool:
    """Whether a tool that OCCT sees apart from the target (or touching it without a shared face)
    shares a face with it once faces within *tol* coincide ([R-3]): its distance is at most *tol*
    and a fuse with the fuzzy value *tol* — used only for this test, never for a result — gives one
    solid."""
    if _distance(target, [tool]) > TOL:
        return False
    op = BRepAlgoAPI_Fuse()
    op.SetArguments(_list([target]))
    op.SetTools(_list([tool]))
    op.SetRunParallel(False)
    op.SetNonDestructive(True)
    op.SetFuzzyValue(TOL)
    op.Build()
    if not op.IsDone():
        return False
    return len(_solids(_unify(op.Shape()).Shape())) == 1


def _shape_tolerance(shape) -> float:
    """The largest tolerance of the shape's vertices, edges and faces (OCCT's own fuzziness)."""
    from OCP.ShapeAnalysis import ShapeAnalysis_ShapeTolerance

    return ShapeAnalysis_ShapeTolerance().Tolerance(shape, 1)


def tool_band_pairs(tools: list[Body], peers: list[Body] = ()) -> list[tuple[Body, Body, float]]:
    """Pairs of tools of **one** operation whose contact [R-3] decides differently from OCCT —
    `(a, b, distance)` (0.0 for an overlap):

    * **a gap in the band**: their distance exceeds OCCT's own fuzziness (the sum of the two
      shapes' tolerances, within which its booleans already treat them as touching) and is at most
      *tol*. By [R-3] their faces (or an edge and a face) coincide, so the SPEC's union of the
      tools closes the gap — two bosses 5e-7 mm apart touch like tangent ones
      (`BOOLEAN_NON_MANIFOLD` for a line contact, one merged wall for a face contact), two
      cutters leave no 5e-7 mm wall — while the oracle's booleans (no fuzzy value, §8.3 rule 2)
      would keep it;
    * **an overlap that is only a contact**: they touch or overlap, and their common part is
      nowhere thicker than *tol* ([W0-41] step 1: `meets` is false) — bosses overlapping by 5e-7
      mm touch along a line for the SPEC, where OCCT fuses them through a 5e-7 mm neck.

    Tangent tools (a contact OCCT realizes: distance within the tolerances, nothing in common) are
    not in the band. Boxes farther than *tol* apart are skipped without a distance computation.
    `peers`: bodies already part of the targets that act as tools of the same operation for this
    test — a pattern's seed tools, which the instances copy (the seed boss is in the target when
    its first copy is joined 5e-7 mm away)."""
    out = []
    for i, a in enumerate(tools):
        lo_a, hi_a = a.body_metrics()["bbox_min"], a.body_metrics()["bbox_max"]
        for b in list(tools[i + 1:]) + list(peers):
            lo_b, hi_b = b.body_metrics()["bbox_min"], b.body_metrics()["bbox_max"]
            if any(lo_a[k] > hi_b[k] + TOL or lo_b[k] > hi_a[k] + TOL for k in range(3)):
                continue
            dist = _band(a.solid, b.solid)
            if dist is not None:
                out.append((a, b, dist))
    return out


def _is_peer(b: Body, peers) -> bool:
    return any(b is x for x in peers)


def _band(sa, sb) -> float | None:
    """`tool_band_pairs`' test on two solids: their distance when it is in the band, 0.0 for an
    overlap that is only a contact, None otherwise."""
    d = BRepExtrema_DistShapeShape(sa, sb)
    if not (d.IsDone() and d.NbSolution() > 0) or d.Value() > TOL:
        return None
    if d.Value() > _shape_tolerance(sa) + _shape_tolerance(sb):
        return d.Value()
    common = [c for c in _common(sa, [sb]) if _vol(c) > 0.0]
    if common and not meets(sa, [sb]):
        return 0.0
    return None


def gap_within(target, a: Body, b: Body, b_applied: bool) -> bool:
    """For a cut or intersect: whether two tools in the band leave a **gap** in (their tolerances,
    *tol*] inside the target — a wall the SPEC does not have (two holes 5e-7 mm apart). The test
    runs on the tools' common parts with the target (the part of the band that matters); a peer
    already applied (`b_applied`: a pattern's seed cutter, whose hole is already in the target) is
    taken whole. An overlap of two cutters within the band changes nothing a face contact would
    not (the union of the cutters covers the same region), so only gaps count here."""
    ca = _common(target, [a.solid])
    cb = [b.solid] if b_applied else _common(target, [b.solid])
    for x in ca:
        for y in cb:
            d = _band(x, y)
            if d is not None and d > 0.0:
                return True
    return False


def _band_failure(a: Body, b: Body, dist: float) -> TopoError:
    return TopoError("ORACLE_COINCIDENCE_UNREALIZED",
                     (f"tools {a.key} and {b.key} are {dist:.3g} mm apart" if dist > 0.0 else
                      f"tools {a.key} and {b.key} overlap nowhere thicker than tol") +
                     ": [R-3] makes that a contact, which the oracle does not realize in the geometry "
                     "(§11.1 open issue 6)")


def _carrier_gap(ga, gb) -> float | None:
    """The largest distance between two carriers of one family that lie within *tol* of each other
    everywhere: parallel planes (their offset), coaxial cylinders (radius difference plus axis
    offset), coaxial cones with one half-angle (apex offset along the axis × sin α plus the axis
    offset), concentric spheres (radius difference plus centre offset); None for any other pair or
    a pair farther apart than *tol*."""
    from .normalize import _dist_line, _par

    if ga is None or gb is None or ga.kind != gb.kind:
        return None
    k = ga.kind
    if k == "plane":
        if not _par(ga.axis, gb.axis):
            return None
        g = abs(geom.dot(geom.sub(gb.loc, ga.loc), ga.axis))
    elif k == "cylinder":
        if not _par(ga.axis, gb.axis):
            return None
        g = abs(ga.r - gb.r) + _dist_line(gb.loc, ga.loc, ga.axis)
    elif k == "cone":
        if not (geom.dot(ga.axis, gb.axis) > 0.0 and _par(ga.axis, gb.axis) and abs(ga.alpha - gb.alpha) <= ANGULAR_TOLERANCE):
            return None
        w = geom.sub(gb.loc, ga.loc)
        g = abs(geom.dot(w, ga.axis)) * math.sin(ga.alpha) + _dist_line(gb.loc, ga.loc, ga.axis)
    elif k == "sphere":
        g = abs(ga.r - gb.r) + geom.dist(ga.loc, gb.loc)
    else:
        return None
    return g if g <= TOL else None


def _bbox(shape):
    """The shape's bounding box enlarged by *tol* (a pre-filter: boxes apart are farther than *tol*)."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    b = Bnd_Box()
    BRepBndLib.Add_s(shape, b, False)
    b.Enlarge(TOL)
    return b


def band_face_pairs(target, tools: list) -> list[tuple[object, object, float]]:
    """[R-3] between a target and the tools of one operation: `(tool face, target face, gap)` for
    faces on carriers of one family (`_carrier_gap`) at most *tol* apart but farther than OCCT's
    own fuzziness (the two shapes' tolerances, within which its booleans already make them
    coincide), that come within *tol* of each other. By [R-3] such faces coincide — a blind floor
    5e-7 mm above the far face opens there, a boss side 5e-7 mm inside the plate's side is flush
    with it — which the oracle's booleans (no fuzzy value, §8.3 rule 2) do not realize."""
    from .normalize import surface_geom

    out = []
    tb = _bbox(target)
    tt = tfaces = tgeo = tboxes = None
    for k in tools:
        if tb.IsOut(_bbox(k)):
            continue
        if tfaces is None:
            tt = _shape_tolerance(target)
            tfaces = [TopoDS.Face_s(f) for f in _sub(target, TopAbs_FACE)]
            tgeo = [surface_geom(f) for f in tfaces]
            tboxes = [_bbox(f) for f in tfaces]
        fuzz = tt + _shape_tolerance(k)
        for fk in _sub(k, TopAbs_FACE):
            fk = TopoDS.Face_s(fk)
            kb = _bbox(fk)
            if tb.IsOut(kb):
                continue
            gk = surface_geom(fk)
            if gk is None:
                continue
            for ft, gt, fb in zip(tfaces, tgeo, tboxes):
                if fb.IsOut(kb):
                    continue
                g = _carrier_gap(gk, gt)
                if g is None or g <= fuzz:
                    continue
                d = BRepExtrema_DistShapeShape(fk, ft)
                if d.IsDone() and d.NbSolution() > 0 and d.Value() <= TOL:
                    out.append((fk, ft, g))
    return out


def check_target_band(target, tools: list, pieces) -> None:
    """Raise the engine-internal `ORACLE_COINCIDENCE_UNREALIZED` (ROBUSTNESS) when a tool face in
    the [R-3] band of a target face (`band_face_pairs`) is still a face of the result next to a
    face on that target face's carrier: the SPEC makes the two coincide (one face, or no material
    between them) where the oracle's result keeps a step, a ledge or a membrane `gap` thick
    (W7b review 4: a blind hole whose floor is 5e-7 mm above the far face kept its floor while
    `HOLE_BREAKS_THROUGH` said it opened; a pocket 4.9999995 mm deep in a 5 mm plate the same; a
    join boss 5e-7 mm inside the plate's side kept a 5e-7 mm step). `pieces`: the result solids
    for this target (after the degenerate / layer filter), or a callable computing them. A band
    pair whose tool face is not in the result — a cutter hovering 5e-7 mm above a face it does not
    cut, a tool reaching 5e-7 mm past a face it cuts through, a join tool face buried in the
    target — or whose target face is gone changes nothing the SPEC's coincidence would: it passes.
    Faces are told apart by carrier: a result face is on a pair member's carrier when within a
    quarter of the pair's gap of it."""
    from .normalize import surface_geom

    pairs = band_face_pairs(target, tools)
    if not pairs:
        return
    if callable(pieces):
        pieces = pieces()
    rfaces = []
    for p in pieces:
        for f in _sub(p, TopAbs_FACE):
            f = TopoDS.Face_s(f)
            rfaces.append((f, surface_geom(f)))
    for fk, ft, g in pairs:
        gk, gt = surface_geom(fk), surface_geom(ft)

        def on(gc, gf, g=g):
            x = _carrier_gap(gf, gc)
            return x is not None and x <= g / 4

        on_k = [f for f, gf in rfaces if on(gk, gf)]
        on_t = [f for f, gf in rfaces if on(gt, gf)]
        for a in on_k:
            for b in on_t:
                d = BRepExtrema_DistShapeShape(a, b)
                if not (d.IsDone() and d.NbSolution() > 0 and d.Value() <= TOL):
                    continue
                q = d.PointOnShape1(1)
                raise TopoError("ORACLE_COINCIDENCE_UNREALIZED",
                                f"a tool face lies {g:.3g} mm from a parallel target face, next to it in the "
                                f"result at ({q.X():.6g}, {q.Y():.6g}, {q.Z():.6g}): [R-3] makes the two coincide "
                                "(no step, ledge or membrane that thin), which the oracle does not realize in the "
                                "geometry (§11.1 open issue 6)")


def degenerate_piece(piece, target, tools: list) -> bool:
    """[W0-41] step 3 and step 1 (a layer of `T − K` nowhere thicker than *tol* is a contact, not
    volume, [W0-53]): the piece is not produced. The `THICK_MEAN` shortcut is certain for a convex
    piece and a heuristic otherwise; `tools` is the union of the tools as one operand
    (`fused_tools`), so that the face distances are to ∂(∪K), not to faces inside it."""
    v, a = gk_volume_area(piece)
    if not (v > 0.0 and a > 0.0):
        return True
    mean = 2.0 * v / a
    if mean <= TOL / 2:
        return True
    if mean > THICK_MEAN or not tools:
        return False
    measure, other = _thickness_probes(target, tools)
    for p in _samples(piece, measure, other):
        dt = _boundary_distance(p, target)
        dk = min(_boundary_distance(p, k) for k in tools)
        if dt > TOL or dk > TOL or (_boundary_distance(p, piece) > TOL / 2 and _inside(p, piece)):
            return False
    return True


class _ChainHistory:
    """The history of OCCT operations applied one after the other (`Modified` / `IsDeleted` in
    the form `_images` reads): an input sub-shape's images through the first, each of those
    through the next, … — a sub-shape an operation does not know passes through unchanged."""

    def __init__(self, *ops):
        self.ops = ops

    def _through(self, s) -> list:
        cur = [s]
        for op in self.ops:
            nxt = []
            for x in cur:
                m = [y for y in op.Modified(x)]
                if m:
                    nxt.extend(m)
                elif not op.IsDeleted(x):
                    nxt.append(x)
            cur = nxt
        return cur

    def Modified(self, s) -> list:
        out = self._through(s)
        return [] if len(out) == 1 and out[0].IsSame(s) else out

    def IsDeleted(self, s) -> bool:
        return not self._through(s)


class _ModifyHistory:
    """A `BRepBuilderAPI_ModifyShape` (the B-spline conversion of a target) in the form
    `_images` reads: its `Modified` raises for a shape it was not given (a tool's faces, chained
    after it), which passes through unchanged here."""

    def __init__(self, op):
        self.op = op

    def Modified(self, s) -> list:
        try:
            return [x for x in self.op.Modified(s)]
        except Exception:  # noqa: BLE001 — OCCT's Standard_Failure: not an input sub-shape
            return []

    def IsDeleted(self, s) -> bool:
        return False


def fused_tools(tools: list):
    """(tool shape, history) for a cut or intersect: the union ∪K of the tools as **one** operand
    (§6.0.3: `t ∩ ∪K`, `t − ∪K`), with the fuse's history (None for a single tool). OCCT's
    `Common([t], [k1, k2])` returns the common part split into one solid per tool region, pieces
    sharing faces, which the piece and non-manifold checks then took for separate touching bodies
    (W7b review 4: two overlapping intersect tools failed with `BOOLEAN_NON_MANIFOLD`); and the
    thickness tests measured to those partition faces."""
    if len(tools) == 1:
        return tools[0], None
    o = _run(BRepAlgoAPI_Fuse, tools[:1], tools[1:])
    return o.Shape(), o


def _images(shape, op, usd) -> list:
    """The final images of an input sub-shape through the boolean and the unify histories."""
    first = [s for s in op.Modified(shape)] if op is not None else []
    if not first:
        if op is not None and op.IsDeleted(shape):
            return []
        first = [shape]
    hist = usd.History() if usd is not None else None
    out = []
    for s in first:
        if hist is None:
            out.append(s)
            continue
        mod = [x for x in hist.Modified(s)]
        if mod:
            out.extend(mod)
        elif not hist.IsRemoved(s):
            out.append(s)
    return out


def _smallest(keys, prefer: set[str] | None = None) -> list[str]:
    pk = sorted({k for k in keys if prefer is not None and k in prefer}, key=str.encode)
    return pk or sorted(set(keys), key=str.encode)


def name_results(result_shape, op, usd, inputs: list[Body], targets: list[Body], gid: str, *,
                 face_merge_ok=None, extra_face_src=None) -> list[tuple[Body, list[Body]]]:
    """Result solids as normalized Bodies with keys (§5.2 rule 3), each with the input bodies it
    came from. `extra_face_src(result_face) -> list[Entity]` supplies sources OCCT's history does
    not (tools built by the oracle)."""
    solids = _solids(result_shape)
    fmap_all = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(result_shape, TopAbs_FACE, fmap_all)
    emap_all = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(result_shape, TopAbs_EDGE, emap_all)
    vmap_all = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(result_shape, TopAbs_VERTEX, vmap_all)
    solid_of_face: dict[int, int] = {}
    for si, s in enumerate(solids):
        for f in _sub(s, TopAbs_FACE):
            solid_of_face.setdefault(fmap_all.FindIndex(f), si)
    face_src: dict[int, list] = {}
    edge_src: dict[int, list] = {}
    vert_src: dict[int, list] = {}
    body_of: dict[int, set[int]] = {}
    for bi, b in enumerate(inputs):
        for f in b.faces:
            for piece in f.parts():
                for img in _images(piece, op, usd):
                    k = fmap_all.FindIndex(img)
                    if k:
                        face_src.setdefault(k, []).append(f)
                        if k in solid_of_face:
                            body_of.setdefault(bi, set()).add(solid_of_face[k])
        for e in b.edges:
            for piece in e.parts():
                for img in _images(piece, op, usd):
                    k = emap_all.FindIndex(img)
                    if k:
                        edge_src.setdefault(k, []).append(e)
        for v in b.vertices:
            for img in _images(v.shape, op, usd):
                k = vmap_all.FindIndex(img)
                if k:
                    vert_src.setdefault(k, []).append(v)
    # bodies whose every face vanished: classify one of their points
    for bi, b in enumerate(inputs):
        if bi in body_of or not b.faces:
            continue
        p = b.faces[0].point()
        for si, s in enumerate(solids):
            if BRepClass3d_SolidClassifier(s, gp_Pnt(*p), 1e-7).State() in (TopAbs_IN, TopAbs_ON):
                body_of.setdefault(bi, set()).add(si)
                break
    target_ids = {id(t) for t in targets}
    target_keys: set[str] = set()
    for t in targets:
        target_keys |= {x.key for x in t.faces + t.edges}
    out: list[tuple[Body, list[Body]]] = []
    for si, s in enumerate(solids):
        members = [inputs[bi] for bi, sis in body_of.items() if si in sis]
        members.sort(key=lambda b: (b.order, b.member.encode()))
        tgt = [b for b in members if id(b) in target_ids]
        origin = (tgt or members or [None])[0]
        if origin is None:
            raise TopoError("OCCT_NAMING_FAILED", "a boolean result solid comes from no input body")
        nb = Body(s, origin.feature, origin.member, origin.order)
        nb.instance = origin.instance

        def etype(edge, fa, fb, nb=nb):
            srcs = edge_src.get(emap_all.FindIndex(edge), [])
            if srcs:
                src = sorted(srcs, key=lambda x: (x.key.encode(), x.type))[0]
                return src.type  # an input edge (trimmed or split) keeps its type (§8.3 rule 3)
            notes: list[str] = []
            t, _ = section_type(edge, fa, fb, notes)
            nb.notes.extend(f"ORACLE_SECTION_NOT_CONIC: {n}" for n in notes)
            return t

        nb.build_normalized_topology(etype, face_merge_ok)
        out.append((nb, members))
        broken = [b.naming_error for b in members if b.naming_error]
        if broken:
            nb.naming_error = f"an input body is unnamed: {broken[0]}"
            continue
        fsrcs: list[list] = []
        for f in nb.faces:
            srcs = []
            for piece in f.parts():
                srcs += face_src.get(fmap_all.FindIndex(piece), [])
                if extra_face_src is not None:
                    srcs += extra_face_src(piece)
            fsrcs.append(srcs)
        missing = [f for f, srcs in zip(nb.faces, fsrcs) if not srcs]
        if missing:
            nb.naming_error = f"{len(missing)} boolean result face(s) have no source face in OCCT's history"
            continue
        for f, srcs in zip(nb.faces, fsrcs):
            tkeys = {x.key for x in srcs if id(x.body) in target_ids}
            keys = _smallest(tkeys) if tkeys else _smallest({x.key for x in srcs})
            f.key = keys[0]
            for x in srcs:
                if x.key != f.key:
                    nb.aliases[x.key] = f.key
                for a, bkey in x.body.aliases.items():
                    if bkey == x.key:
                        nb.aliases[a] = f.key
            if (len(srcs) == 1 and not f.pieces and srcs[0].shape.IsSame(f.shape)
                    and srcs[0].probe_point is not None):
                f.probe_point = srcs[0].probe_point
        for e in nb.edges:
            fk = sorted(x.key for x in nb.faces_of_edge(e))
            if len(fk) == 1:
                fk = fk * 2
            # An edge the operation only trimmed or split keeps its key (§5.2 rule 3); one whose
            # faces changed (e.g. a tool's rim now lying between the target's cap and the tool's
            # side) is a new intersection edge of the operation: G/edge:{A|B}.
            srcs = []
            for piece in e.parts():
                srcs += [x for x in edge_src.get(emap_all.FindIndex(piece), [])
                         if _same_faces(_edge_faces(x.key), fk, nb.aliases)]
            if srcs:
                keys = _smallest({x.key for x in srcs}, target_keys)
                e.key = keys[0]
                for x in srcs:
                    if x.key != e.key:
                        nb.aliases[x.key] = e.key
            else:
                e.key = f"{gid}/edge:{{{fk[0]}|{fk[1]}}}"
        for v in nb.vertices:
            srcs = vert_src.get(vmap_all.FindIndex(v.shape), [])
            if srcs:
                v.key = sorted({x.key for x in srcs}, key=str.encode)[0]
            else:
                keys = sorted({x.key for x in nb.faces_of_vertex(v)})
                v.key = f"{gid}/vertex:{{{'|'.join(keys)}}}"
    return out


def _edge_faces(key: str) -> tuple[str, str] | None:
    """The face-key pair of an edge key `F/edge:{A|B}[@q]` (None when the key has another form)."""
    i = key.find("/edge:{")
    if i < 0 or not key.endswith(("}",)) and "}@" not in key:
        return None
    body = key[i + len("/edge:{"):]
    depth, j = 0, 0
    for j, ch in enumerate(body):
        if ch == "{":
            depth += 1
        elif ch == "}":
            if depth == 0:
                break
            depth -= 1
    inner = body[:j]
    depth = 0
    for k, ch in enumerate(inner):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        elif ch == "|" and depth == 0:
            return tuple(sorted((inner[:k], inner[k + 1:])))
    return None


def _same_faces(pair: tuple[str, str] | None, fk: list[str], aliases: dict[str, str]) -> bool:
    """Whether an input edge's face pair (through merge aliases) is the result edge's pair."""
    if pair is None:
        return True
    return tuple(sorted(aliases.get(k, k) for k in pair)) == tuple(sorted(fk))


def check_valid(bodies: list[Body]) -> None:
    for b in bodies:
        m = b.body_metrics()
        if not m["valid"]:
            raise TopoError("OCCT_INVALID_RESULT", f"BRepCheck_Analyzer rejects the result {b}")
        anc = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(b.solid, TopAbs_EDGE, TopAbs_FACE, anc)
        for i in range(1, anc.Extent() + 1):
            if anc.FindFromIndex(i).Size() > 2:
                e = TopoDS.Edge_s(anc.FindKey(i))
                ad = BRepAdaptor_Curve(e)
                q = ad.Value(0.5 * (ad.FirstParameter() + ad.LastParameter()))
                raise FeatureFailure("BOOLEAN_NON_MANIFOLD", "the result touches itself along an edge",
                                     {"probe": {"kind": "edge", "point": [q.X(), q.Y(), q.Z()]}})


def _gate(cond: bool, what: str) -> None:
    if not cond:
        raise TopoError("OCCT_SELF_CHECK_FAILED", f"boolean volume identity violated: {what}")


def _close(a: float, b: float, scale: float, ref: float = 0.0) -> bool:
    """Within `GATE_REL` of the larger of the two sides and of `ref` (the operands' volume: a
    consumed target's `vol t − vol(t ∩ K)` is rounding noise of that size, not of zero)."""
    return abs(a - b) <= GATE_REL * max(abs(a), abs(b), abs(ref), 1e-9 * scale ** 3)


def _close_diff(x: float, big: float, rest: float, scale: float) -> bool:
    """`x = big − rest`, where `big` is an operand's volume and `x` may be much smaller (a cut's
    removed part, an intersection): within `GATE_REL` of `x` itself plus the integrator's noise on
    the operand (`VOLUME_NOISE_REL · big`). W7b review 5: scaling the whole allowance with `big`
    (`_close(…, ref=big)`) let a 1 mm³ intersection of a 1e6 mm³ target be 0.5 % wrong."""
    exp = big - rest
    return abs(x - exp) <= (GATE_REL * max(abs(x), abs(exp)) + VOLUME_NOISE_REL * abs(big)
                            + GATE_REL * 1e-9 * scale ** 3)


def _vol(shape) -> float:
    return gk_volume_area(shape)[0]


def _check_pieces_apart(pieces: list[Body]) -> None:
    for i, a in enumerate(pieces):
        for b in pieces[i + 1:]:
            if _distance(a.solid, [b.solid]) <= LINEAR_TOLERANCE:
                raise FeatureFailure("BOOLEAN_NON_MANIFOLD", "result pieces touch along an edge or vertex",
                                     {"probe": {"kind": "body", "point": list(a.centroid)}})


def apply_body_op(ev, st, gid: str, order: int, op: str, targets: list[Body], tools: list[Body], entry: dict,
                  keep_tools: bool, *, extra_face_src=None, band_peers: list[Body] = (),
                  nurbs_targets: bool = False) -> list[Body]:
    """Apply join / cut / intersect of `tools` to `targets` in the part state `st`; fill the
    feature entry (`bodies`, `removed`, `warnings`). Returns the result bodies it created or
    modified."""
    warns = entry["warnings"]
    scale = max([1.0] + [math.dist(b.body_metrics()["bbox_min"], b.body_metrics()["bbox_max"])
                         for b in targets + tools])
    tool_shapes = [k.solid for k in tools]
    created: list[tuple[Body, str]] = []
    replaced: set[int] = set()  # ids of scope bodies replaced by results
    if not targets:
        raise FeatureFailure("BOOLEAN_NO_INTERSECTION", "the operation has no target bodies",
                             {"tool": tools[0].origin if tools else None, "min_distance": None})
    if op == "join":
        # [W0-39]: the failure row per tool
        for k in tools:
            if not any(meets(t.solid, [k.solid]) or shares_face(t.solid, k.solid) for t in targets):
                if any(within_tol_contact(t.solid, k.solid) for t in targets):
                    # [R-3]: faces within tol coincide, so the tool shares a face and the SPEC joins
                    # it; the oracle's booleans run without a fuzzy value (§8.3 rule 2) and cannot
                    # build that union — an explicit engine-internal failure (ROBUSTNESS), never a
                    # catalogue code the SPEC does not give (§11.1 open issue 6)
                    raise TopoError("ORACLE_COINCIDENCE_UNREALIZED",
                                    f"tool {k.feature}/{k.member} shares a face with a target only within tol "
                                    f"(distance {_distance(k.solid, [t.solid for t in targets]):.3g} mm): "
                                    "the oracle does not realize [R-3] coincidence in the geometry")
                raise FeatureFailure("BOOLEAN_NO_INTERSECTION",
                                     f"tool {k.feature}/{k.member} neither overlaps nor shares a face with a target",
                                     {"tool": k.origin, "min_distance": _distance(k.solid, [t.solid for t in targets])})
        # [R-3] between two tools: every tool of a join is in the result, so a gap in (0, tol]
        # between two of them is one the SPEC closes (§11.1 open issue 6)
        for a, b, dist in tool_band_pairs(tools, band_peers):
            raise _band_failure(a, b, dist)
        o = _run(BRepAlgoAPI_Fuse, [t.solid for t in targets], tool_shapes)
        ushape, usd = unified(o.Shape())
        # [R-3] between a tool and a target it meets (a boss side 5e-7 mm inside the plate's side)
        for t in targets:
            check_target_band(t.solid, tool_shapes, lambda: _solids(ushape))
        results = name_results(ushape, o, usd, targets + tools, targets, gid, extra_face_src=extra_face_src)
        tool_ids = {id(k) for k in tools}
        target_ids = {id(t) for t in targets}
        for nb, ms in results:
            tg = [m for m in ms if id(m) in target_ids]
            if len(tg) == 1 and not any(id(m) in tool_ids for m in ms):
                continue  # a target no tool reaches is untouched ([W0-39])
            vol_in = [m.body_metrics()["volume"] for m in ms if id(m) in target_ids or id(m) in tool_ids]
            v = nb.body_metrics()["volume"]
            _gate(v <= sum(vol_in) * (1 + GATE_REL) + 1e-9 * scale ** 3 and v >= max(vol_in) * (1 - GATE_REL) - 1e-9 * scale ** 3,
                  f"join volume {v} outside [max input, sum of inputs]")
            if len(ms) == 2:
                inter = sum(_vol(c) for c in _common(ms[0].solid, [ms[1].solid]))
                exp = ms[0].body_metrics()["volume"] + ms[1].body_metrics()["volume"] - inter
                _gate(_close(v, exp, scale), f"vol(a ∪ b) = {v}, vol a + vol b − vol(a ∩ b) = {exp}")
            for m in tg:
                replaced.add(id(m))
            created.append((nb, "modified" if tg else "created"))
        check_valid([nb for nb, _ in created])
    else:
        met_any = False
        empty_all = True
        band = None
        # the tools' union as one operand: the meet, piece and layer tests measure t ∩ ∪K and
        # t − ∪K, and intersect builds t ∩ ∪K as one solid per connected component
        kshape, kfuse = fused_tools(tool_shapes)
        for t in targets:
            # [threads] the target as B-splines (§8.3 rule 9): OCCT intersects swept thread
            # flanks with analytic faces unreliably (whole grooves lost or cut short, depending
            # on where a cylinder's seam lies), and reliably with B-spline faces
            ts, conv = t.solid, None
            if nurbs_targets:
                raw_conv = BRepBuilderAPI_NurbsConvert(t.solid, True)
                ts = TopoDS.Solid_s(_solids(raw_conv.Shape())[0])
                conv = _ModifyHistory(raw_conv)
            common = _common(ts, [kshape])
            inter = sum(_vol(c) for c in common)
            if op == "cut":
                if not (common and meets(ts, [kshape])):
                    empty_all = False
                    continue
                met_any = True
            # [R-3] between two tools, where the gap lies in (or on) this target: the SPEC's union
            # of the tools has no gap there (two cutters leave no wall thinner than tol between
            # them; §11.1 open issue 6)
            if band is None:
                band = tool_band_pairs(tools, band_peers)
            for a, b, dist in band:
                if dist > 0.0 and gap_within(ts, a, b, _is_peer(b, band_peers)):
                    raise _band_failure(a, b, dist)
            if op == "cut":
                o = _run(BRepAlgoAPI_Cut, [ts], tool_shapes)
                hist = o if conv is None else _ChainHistory(conv, o)
            else:
                o = _run(BRepAlgoAPI_Common, [ts], [kshape])
                pre = [h for h in (conv, kfuse) if h is not None]
                hist = o if not pre else _ChainHistory(*pre, o)
            ushape, usd = unified(o.Shape())
            raw = _solids(ushape)
            vt = t.body_metrics()["volume"]
            vraw = sum(_vol(s) for s in raw)
            if op == "cut":
                # the removed part: vol(t ∩ K) = vol t − vol(t − K), within GATE_REL of the removed
                # volume plus the integrator's noise on vol t (`_close_diff`)
                _gate(_close_diff(inter, vt, vraw, scale),
                      f"vol(t ∩ K) = {inter}, vol t − vol(t − K) = {vt - vraw} (vol t = {vt})")
            else:
                # independent of the Common call that built the result, from both operands' sides
                # (W7b review 5: each side's noise is relative to that operand's volume, so a small
                # result is checked tightly whenever one operand is small): vol(t ∩ K) = vol t −
                # vol(t − K) with a Cut by the separate tools, and = vol K − vol(K − t)
                vcut = sum(_vol(x) for x in _solids(_run(BRepAlgoAPI_Cut, [ts], tool_shapes).Shape()))
                _gate(_close_diff(vraw, vt, vcut, scale) and vraw <= vt * (1 + GATE_REL) + 1e-9 * scale ** 3,
                      f"vol(t ∩ K) = {vraw}, vol t − vol(t − K) = {vt - vcut}, vol t = {vt}")
                vk = _vol(kshape)
                vkt = sum(_vol(x) for x in _solids(_run(BRepAlgoAPI_Cut, [kshape], [ts]).Shape()))
                _gate(_close_diff(vraw, vk, vkt, scale),
                      f"vol(t ∩ K) = {vraw}, vol K − vol(K − t) = {vk - vkt}, vol K = {vk}")
            keep = [s for s in raw if not degenerate_piece(s, ts, [kshape])]
            # [R-3] between a tool face and a face of this target (a blind floor 5e-7 mm above the
            # far face): the coincident faces change the topology — an explicit failure
            check_target_band(ts, tool_shapes, keep)
            results = []
            if keep:
                if len(keep) == len(raw):
                    shape = ushape
                else:
                    comp = TopoDS_Compound()
                    bld = BRep_Builder()
                    bld.MakeCompound(comp)
                    for s in keep:
                        bld.Add(comp, s)
                    shape = comp
                results = name_results(shape, hist, usd, [t] + tools, [t], gid, extra_face_src=extra_face_src)
            pieces = [nb for nb, _ in results]
            replaced.add(id(t))
            if not pieces:
                warns.append({"code": "BOOLEAN_BODY_CONSUMED", "severity": "warning",
                              "message": f"{t.feature}/{t.member} was consumed", "details": {"origin": t.origin}})
                continue
            empty_all = False
            _check_pieces_apart(pieces)
            if len(pieces) >= 2:
                warns.append({"code": "BOOLEAN_SPLIT", "severity": "info",
                              "message": f"{t.feature}/{t.member} was split into {len(pieces)} pieces",
                              "details": {"origin": t.origin, "pieces": len(pieces)}})
            for nb in pieces:
                created.append((nb, "modified"))
        if op == "cut" and not met_any:
            raise FeatureFailure("BOOLEAN_NO_INTERSECTION", "no tool meets the interior of any target",
                                 {"tool": tools[0].origin if tools else None,
                                  "min_distance": min(_distance(k.solid, [t.solid for t in targets]) for k in tools)})
        if op == "intersect" and empty_all:
            raise FeatureFailure("BOOLEAN_EMPTY_RESULT", "every target's intersection with the tools is empty",
                                 {"targets": [t.origin for t in targets]})
        check_valid([nb for nb, _ in created])
    commit(st, targets, tools, created, replaced, keep_tools, entry)
    for nb, _ in created:
        for n in nb.notes:
            code, _, msg = n.partition(": ")
            if code.startswith("ORACLE_") and not any(w.get("message") == msg for w in warns):
                warns.append({"code": code, "severity": "info", "message": msg, "details": {}})
    return [nb for nb, _ in created]


def commit(st, targets: list[Body], tools: list[Body], created: list[tuple[Body, str]], replaced: set[int],
           keep_tools: bool, entry: dict) -> None:
    """Replace the acted-on targets by the results, drop consumed tools (they are new tool bodies,
    or kept on request), and report `bodies` and [W0-40] `removed`."""
    tool_ids = {id(k) for k in tools}
    keep = []
    for b in st.bodies:
        if id(b) in replaced:
            continue
        if id(b) in tool_ids and not keep_tools:
            continue
        keep.append(b)
    st.bodies[:] = keep + [nb for nb, _ in created]
    if created:
        entry["bodies"] = [body_report(nb, ch) for nb, ch in
                           sorted(created, key=lambda x: (x[0].order, x[0].member.encode(),
                                                          tuple(x[0].instance or ()),
                                                          tuple(round(c, 9) for c in x[0].centroid)))]
    carried = {_origin_key(b.origin) for b in st.bodies}
    removed: list[dict] = []
    seen: set = set()
    for t in sorted((t for t in targets if id(t) in replaced), key=lambda b: (b.order, b.member.encode())):
        k = _origin_key(t.origin)
        if k in carried or k in seen:
            continue
        seen.add(k)
        removed.append(t.origin)
    if removed:
        entry["removed"] = removed


def _origin_key(o: dict) -> tuple:
    return (o["feature"], o["member"], tuple(o.get("instance", ()) or ()))


def resolve_targets(ev, st, targets, path: str, refs: list, warns: list) -> list[Body]:
    if targets == "all":
        return list(st.bodies)
    return list(ev.resolve(st, targets, "some", path, refs, warns))


def boolean_feature(ev, st, fi: int, f: dict, entry: dict, refs: list) -> None:
    warns = entry["warnings"]
    targets = list(ev.resolve(st, f["targets"], "some", "/targets", refs, warns))
    tools = list(ev.resolve(st, f["tools"], "some", "/tools", refs, warns))
    keep = bool(ev.scalar(st, f.get("keep_tools", False), "bool"))
    both = [t for t in targets if any(t is k for k in tools)]
    if both:
        raise FeatureFailure("BOOLEAN_TOOL_IS_TARGET", f"{both[0]} is both a target and a tool",
                             {"origin": both[0].origin})
    apply_body_op(ev, st, f["id"], fi, f["op"], targets, tools, entry, keep_tools=keep)
