"""OCCT (via OCP) construction of region faces, extrude/revolve solids, and body metrics.

Everything here goes through explicit OCP calls so that every convention is visible:
  * planes are explicit gp_Ax3 frames built from SPEC §2 (no named-plane defaults);
  * arcs are Geom_Circle in the sketch plane, parametrised with the plane's x axis at 0 and
    increasing counter-clockwise about the plane normal;
  * metrics are computed on exact geometry (fixed-order Gauss integration on the exact
    surfaces, never triangulations; a tight bounding box without tolerance enlargement);
  * OCCT's seam edges and degenerated edges are excluded from edge counts (SPEC §5);
  * surfaces/curves are reported by canonical type (SPEC §5).
"""

from __future__ import annotations

import importlib.metadata as md
import math
from functools import lru_cache

from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_MakeEdge,
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakeWire,
    BRepBuilderAPI_Transform,
)
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.BRepLib import BRepLib
from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism, BRepPrimAPI_MakeRevol
from OCP.Bnd import Bnd_Box
from OCP.GeomAbs import GeomAbs_CurveType, GeomAbs_SurfaceType
from OCP.Geom import Geom_Circle, Geom_Line
from OCP.GProp import GProp_GProps
from OCP.gp import (
    gp_Ax1,
    gp_Ax2,
    gp_Ax3,
    gp_Circ,
    gp_Cone,
    gp_Cylinder,
    gp_Dir,
    gp_Elips,
    gp_Lin,
    gp_Pln,
    gp_Pnt,
    gp_Sphere,
    gp_Trsf,
    gp_Vec,
)
from OCP.ShapeAnalysis import ShapeAnalysis_CanonicalRecognition
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_SOLID
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Shape, TopoDS_Vertex
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape

from .ir import LINEAR_TOLERANCE, Arc, Circle, Curve, Line, ResolvedPlane, Vec2, Vec3
from .sketch import Loop, LoopEdge, Region, arc_geometry, region_area

#: Tolerance for recognising canonical geometry (angles are compared as |sin|/|cos|).
CANON_TOL = 1e-9
#: Tolerance passed to ShapeAnalysis_CanonicalRecognition for free-form geometry.
CANON_FREEFORM_TOL = 1e-7
#: Default OCCT vertex tolerance (Precision::Confusion()).
CONFUSION = 1e-7


def volume_props(shape) -> GProp_GProps:
    """Volume, centre of mass — exact geometry (UseTriangulation=False).

    Deliberately the NON-adaptive BRepGProp::VolumeProperties. Measured against closed-form
    prism/Pappus volumes on 526 generated bodies (see README):
      * adaptive VolumeProperties(S, P, Eps) has a false-convergence error estimator — with
        Eps=1e-9 a circular-segment revolve was off by 1.2e-5 relative while reporting an
        estimated error of 2e-16; with Eps=1e-12 still 1.7e-9 off;
      * VolumePropertiesGK is accurate but took 18–150 s on some bodies;
      * the default fixed-order Gauss scheme: worst 3.2e-11 relative, ~0.1 ms per body.
    """
    p = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, p, False, False, False)
    return p


def surface_props(shape) -> GProp_GProps:
    """Surface area — exact geometry, non-adaptive (worst 6.5e-13 relative on the same set)."""
    p = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, p, False, False)
    return p


class BuildError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@lru_cache(maxsize=1)
def engine_string() -> str:
    import OCP

    ocp = getattr(OCP, "__version__", None) or md.version("cadquery-ocp-novtk")
    occt = ".".join(str(ocp).split(".")[:3])
    try:
        b3d = md.version("build123d")
    except md.PackageNotFoundError:  # pragma: no cover
        b3d = "?"
    return f"occt {occt} (OCP {md.version('cadquery-ocp-novtk')}) / build123d {b3d}"


# ---------------------------------------------------------------------------------------------
# gp helpers
# ---------------------------------------------------------------------------------------------

def P(v: Vec3) -> gp_Pnt:
    return gp_Pnt(v[0], v[1], v[2])


def D(v: Vec3) -> gp_Dir:
    return gp_Dir(v[0], v[1], v[2])


def plane_ax3(pl: ResolvedPlane) -> gp_Ax3:
    """Right-handed frame: main direction = normal, X = plane x (so Y = normal × x)."""
    return gp_Ax3(P(pl.origin), D(pl.normal), D(pl.x))


# ---------------------------------------------------------------------------------------------
# Region → planar face
# ---------------------------------------------------------------------------------------------

def _make_vertex(p: Vec3, tol: float) -> TopoDS_Vertex:
    v = TopoDS_Vertex()
    BRep_Builder().MakeVertex(v, P(p), max(CONFUSION, tol))
    return v


def _oriented(loop: Loop, want_ccw: bool) -> list[LoopEdge]:
    ccw = loop.signed_area > 0.0
    if ccw == want_ccw:
        return list(loop.edges)
    return [LoopEdge(e.index, not e.forward) for e in reversed(loop.edges)]


def _ends2d(c: Curve, forward: bool) -> tuple[Vec2, Vec2]:
    a, b = c.start, c.end  # type: ignore[union-attr]
    return (a, b) if forward else (b, a)


def _dist3(a: Vec3, b: Vec3) -> float:
    return math.dist(a, b)


def build_wire(curves: list[Curve], loop: Loop, pl: ResolvedPlane, want_ccw: bool):
    """Build a closed wire for a loop, CCW (about the plane normal) or CW as requested."""
    edges = _oriented(loop, want_ccw)
    mw = BRepBuilderAPI_MakeWire()
    if len(edges) == 1 and isinstance(curves[edges[0].index], Circle):
        c = curves[edges[0].index]
        circ = Geom_Circle(gp_Ax2(P(pl.to3d(c.center)), D(pl.normal), D(pl.x)), c.radius)
        e = BRepBuilderAPI_MakeEdge(circ).Edge()
        if not want_ccw:
            e = TopoDS.Edge_s(e.Reversed())
        mw.Add(e)
        return mw.Wire()

    n = len(edges)
    # Junction k sits between edges[k-1] (its end) and edges[k] (its start).
    junction_pts: list[Vec3] = []
    for k in range(n):
        prev = curves[edges[k - 1].index]
        cur = curves[edges[k].index]
        a = _ends2d(prev, edges[k - 1].forward)[1]
        b = _ends2d(cur, edges[k].forward)[0]
        junction_pts.append(pl.to3d(((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5)))

    # Geometric curve end points (arcs: exact points on the circle) to size vertex tolerances.
    geo_ends: list[tuple[Vec3, Vec3]] = []
    for e in edges:
        c = curves[e.index]
        if isinstance(c, Arc):
            g, rev = arc_geometry(c)
            s2, e2 = (g.p0, g.p1) if not rev else (g.p1, g.p0)
            s2, e2 = (s2, e2) if e.forward else (e2, s2)
            geo_ends.append((pl.to3d(s2), pl.to3d(e2)))
        else:
            s2, e2 = _ends2d(c, e.forward)
            geo_ends.append((pl.to3d(s2), pl.to3d(e2)))
    verts: list[TopoDS_Vertex] = []
    for k in range(n):
        gap = max(_dist3(junction_pts[k], geo_ends[k - 1][1]), _dist3(junction_pts[k], geo_ends[k][0]))
        verts.append(_make_vertex(junction_pts[k], 1.5 * gap))

    for k, e in enumerate(edges):
        c = curves[e.index]
        v_start, v_end = verts[k], verts[(k + 1) % n]
        if isinstance(c, Line):
            # [R-6] the line runs exactly between its given end points; the (≤ tol) gap to the
            # shared vertex is absorbed by the vertex tolerance.
            a2, b2 = _ends2d(c, e.forward)
            a3, b3 = pl.to3d(a2), pl.to3d(b2)
            seg = (b3[0] - a3[0], b3[1] - a3[1], b3[2] - a3[2])
            length = math.sqrt(seg[0] ** 2 + seg[1] ** 2 + seg[2] ** 2)
            lin = Geom_Line(P(a3), D(seg))
            mk = BRepBuilderAPI_MakeEdge(lin, v_start, v_end, 0.0, length)
        else:
            g, rev = arc_geometry(c)
            circ = Geom_Circle(gp_Ax2(P(pl.to3d(g.c)), D(pl.normal), D(pl.x)), g.r)
            # Traversal is CCW about the normal iff (IR ccw) == forward.
            ccw = (not rev) == e.forward
            t0, t1 = g.t0, g.t0 + g.sweep
            if ccw:
                mk = BRepBuilderAPI_MakeEdge(circ, v_start, v_end, t0, t1)
            else:
                mk = BRepBuilderAPI_MakeEdge(circ, v_end, v_start, t0, t1)
        if not mk.IsDone():
            raise BuildError(
                "OCCT_BUILD_FAILED", f"BRepBuilderAPI_MakeEdge failed for curve {c.id!r} (error {mk.Error()})"
            )
        edge = mk.Edge()
        if not isinstance(c, Line) and not ((not arc_geometry(c)[1]) == e.forward):
            edge = TopoDS.Edge_s(edge.Reversed())
        mw.Add(edge)
        if not mw.IsDone():
            raise BuildError("OCCT_BUILD_FAILED", f"BRepBuilderAPI_MakeWire failed at curve {c.id!r}")
    return mw.Wire()


def build_face(curves: list[Curve], region: Region, pl: ResolvedPlane):
    outer = build_wire(curves, region.outer, pl, want_ccw=True)
    mf = BRepBuilderAPI_MakeFace(gp_Pln(plane_ax3(pl)), outer, True)
    if not mf.IsDone():
        raise BuildError("OCCT_BUILD_FAILED", f"BRepBuilderAPI_MakeFace failed (error {mf.Error()})")
    for h in region.holes:
        mf.Add(build_wire(curves, h, pl, want_ccw=False))
    face = mf.Face()
    # Self-check: the OCCT face must have the region's analytic area.
    fa = surface_props(face).Mass()
    ra = region_area(curves, region)
    if abs(fa - ra) > 1e-9 * max(1.0, abs(ra)):
        raise BuildError(
            "OCCT_INTERNAL",
            f"face area {fa!r} != region area {ra!r} for region {region.outer_curves}",
        )
    return face


# ---------------------------------------------------------------------------------------------
# Solids
# ---------------------------------------------------------------------------------------------

def _single_solid(shape: TopoDS_Shape, what: str):
    ex = TopExp_Explorer(shape, TopAbs_SOLID)
    solids = []
    while ex.More():
        solids.append(TopoDS.Solid_s(ex.Current()))
        ex.Next()
    if len(solids) != 1:
        raise BuildError("OCCT_BUILD_FAILED", f"{what} produced {len(solids)} solids, expected 1")
    solid = solids[0]
    if volume_props(solid).Mass() < 0.0:
        BRepLib.OrientClosedSolid_s(solid)
    return solid


def extrude(face, pl: ResolvedPlane, distance: float, direction: str):
    n = pl.normal
    if direction == "symmetric":
        tr = gp_Trsf()
        tr.SetTranslation(gp_Vec(-n[0] * distance / 2, -n[1] * distance / 2, -n[2] * distance / 2))
        face = BRepBuilderAPI_Transform(face, tr, True).Shape()
        vec = gp_Vec(n[0] * distance, n[1] * distance, n[2] * distance)
    elif direction == "reverse":
        vec = gp_Vec(-n[0] * distance, -n[1] * distance, -n[2] * distance)
    else:
        vec = gp_Vec(n[0] * distance, n[1] * distance, n[2] * distance)
    mk = BRepPrimAPI_MakePrism(face, vec, True)
    mk.Build()
    if not mk.IsDone():
        raise BuildError("OCCT_BUILD_FAILED", "BRepPrimAPI_MakePrism failed")
    return _single_solid(mk.Shape(), "extrude")


def revolve(face, axis_origin: Vec3, axis_dir: Vec3, angle_deg: float, direction: str):
    ax = gp_Ax1(P(axis_origin), D(axis_dir))
    ang = math.radians(angle_deg)
    if direction == "symmetric":
        tr = gp_Trsf()
        tr.SetRotation(ax, -ang / 2.0)
        face = BRepBuilderAPI_Transform(face, tr, True).Shape()
    elif direction == "reverse":
        ax = ax.Reversed()  # +angle about −d  ==  −angle about d
    mk = BRepPrimAPI_MakeRevol(face, ax, ang, True)
    mk.Build()
    if not mk.IsDone():
        raise BuildError("OCCT_BUILD_FAILED", "BRepPrimAPI_MakeRevol failed")
    return _single_solid(mk.Shape(), "revolve")


# ---------------------------------------------------------------------------------------------
# Canonical type recognition
# ---------------------------------------------------------------------------------------------

_ST = GeomAbs_SurfaceType
_CT = GeomAbs_CurveType


def _vec(p: gp_Pnt) -> Vec3:
    return (p.X(), p.Y(), p.Z())


def _dirv(d: gp_Dir) -> Vec3:
    return (d.X(), d.Y(), d.Z())


def _sub3(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot3(a: Vec3, b: Vec3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross3(a: Vec3, b: Vec3) -> Vec3:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _len3(a: Vec3) -> float:
    return math.sqrt(_dot3(a, a))


def _dist_point_line(p: Vec3, o: Vec3, d: Vec3) -> float:
    return _len3(_cross3(_sub3(p, o), d))


def _classify_revolution(curve_type, curve, ax: gp_Ax1) -> str:
    """Canonical type of a surface of revolution (basis curve revolved about `ax`)."""
    ao, ad = _vec(ax.Location()), _dirv(ax.Direction())
    if curve_type == _CT.GeomAbs_Line:
        lin = curve.Line()
        lo, ld = _vec(lin.Location()), _dirv(lin.Direction())
        s = _len3(_cross3(ld, ad))
        c = abs(_dot3(ld, ad))
        if s <= CANON_TOL:
            return "cylinder" if _dist_point_line(lo, ao, ad) > LINEAR_TOLERANCE else "other"
        if c <= CANON_TOL:
            return "plane"
        # Coplanar with the axis (the lines meet) → cone; skew → hyperboloid.
        nrm = _cross3(ld, ad)
        skew = abs(_dot3(_sub3(lo, ao), nrm)) / _len3(nrm)
        return "cone" if skew <= LINEAR_TOLERANCE else "other"
    if curve_type == _CT.GeomAbs_Circle:
        circ = curve.Circle()
        cc, cn = _vec(circ.Location()), _dirv(circ.Axis().Direction())
        axis_in_plane = abs(_dot3(cn, ad)) <= CANON_TOL and abs(_dot3(_sub3(cc, ao), cn)) <= LINEAR_TOLERANCE
        if not axis_in_plane:
            return "other"
        return "sphere" if _dist_point_line(cc, ao, ad) <= LINEAR_TOLERANCE else "torus"
    return "other"


def _classify_extrusion(curve_type, curve, d: gp_Dir) -> str:
    dv = _dirv(d)
    if curve_type == _CT.GeomAbs_Line:
        return "plane"
    if curve_type == _CT.GeomAbs_Circle:
        cn = _dirv(curve.Circle().Axis().Direction())
        return "cylinder" if _len3(_cross3(cn, dv)) <= CANON_TOL else "other"
    return "other"


def _recognise_freeform_surface(face) -> str:
    cr = ShapeAnalysis_CanonicalRecognition(face)
    if cr.IsPlane(CANON_FREEFORM_TOL, gp_Pln()):
        return "plane"
    if cr.IsCylinder(CANON_FREEFORM_TOL, gp_Cylinder()):
        return "cylinder"
    if cr.IsCone(CANON_FREEFORM_TOL, gp_Cone()):
        return "cone"
    if cr.IsSphere(CANON_FREEFORM_TOL, gp_Sphere()):
        return "sphere"
    return "bspline"


def face_type(face) -> str:
    ad = BRepAdaptor_Surface(face, False)
    t = ad.GetType()
    if t == _ST.GeomAbs_Plane:
        return "plane"
    if t == _ST.GeomAbs_Cylinder:
        return "cylinder"
    if t == _ST.GeomAbs_Cone:
        # SPEC §4.4 [R-8]: classification uses 1e-9 rad; a (numerically) degenerate cone is
        # the cylinder / plane the profile line really is.
        a = abs(ad.Cone().SemiAngle())
        if a <= CANON_TOL:
            return "cylinder"
        if abs(math.pi / 2 - a) <= CANON_TOL:
            return "plane"
        return "cone"
    if t == _ST.GeomAbs_Sphere:
        return "sphere"
    if t == _ST.GeomAbs_Torus:
        # arc centre within tol of the axis → sphere; horn / spindle patches stay torus
        return "sphere" if ad.Torus().MajorRadius() <= LINEAR_TOLERANCE else "torus"
    if t == _ST.GeomAbs_SurfaceOfRevolution:
        bc = ad.BasisCurve()
        return _classify_revolution(bc.GetType(), bc, ad.AxeOfRevolution())
    if t == _ST.GeomAbs_SurfaceOfExtrusion:
        bc = ad.BasisCurve()
        return _classify_extrusion(bc.GetType(), bc, ad.Direction())
    if t in (_ST.GeomAbs_BSplineSurface, _ST.GeomAbs_BezierSurface, _ST.GeomAbs_OffsetSurface):
        kind = _recognise_freeform_surface(face)
        if kind == "bspline" and t == _ST.GeomAbs_OffsetSurface:
            return "other"
        return kind
    return "other"


def edge_type(edge, freeform_tol: float = CANON_FREEFORM_TOL) -> str:
    """Canonical edge type; free-form curves (B-spline, Bézier, offset) that are lines or conics
    within `freeform_tol` are counted as such (v0: `CANON_FREEFORM_TOL`; IR v1 §8.3 rule 3 passes
    `1e-7·s`)."""
    ad = BRepAdaptor_Curve(edge)
    t = ad.GetType()
    if t == _CT.GeomAbs_Line:
        return "line"
    if t == _CT.GeomAbs_Circle:
        return "circle"
    if t == _CT.GeomAbs_Ellipse:
        el = ad.Ellipse()
        return "circle" if abs(el.MajorRadius() - el.MinorRadius()) <= LINEAR_TOLERANCE else "ellipse"
    if t in (_CT.GeomAbs_BSplineCurve, _CT.GeomAbs_BezierCurve, _CT.GeomAbs_OffsetCurve):
        cr = ShapeAnalysis_CanonicalRecognition(edge)
        if cr.IsLine(freeform_tol, gp_Lin()):
            return "line"
        if cr.IsCircle(freeform_tol, gp_Circ()):
            return "circle"
        if cr.IsEllipse(freeform_tol, gp_Elips()):
            return "ellipse"
        return "bspline" if t != _CT.GeomAbs_OffsetCurve else "other"
    return "other"


# ---------------------------------------------------------------------------------------------
# Body metrics
# ---------------------------------------------------------------------------------------------

def _hist(items: list[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for k in sorted(items):
        out[k] = out.get(k, 0) + 1
    return out


def _periodic_into(x: float, lo: float, hi: float, period: float) -> float | None:
    """Shift periodic parameter x into [lo, hi] if some representative lies there."""
    eps = 1e-12
    y = lo + math.fmod(x - lo + eps, period)
    if y < lo - eps:
        y += period
    y -= eps
    return y if y <= hi + 1e-12 else None


def _critical_uv(ad: BRepAdaptor_Surface, t) -> list[tuple[float, float]]:
    """(u, v) where the surface normal is parallel to a coordinate axis (sphere / torus)."""
    if t == _ST.GeomAbs_Sphere:
        pos = ad.Sphere().Position()
    else:
        pos = ad.Torus().Position()
    X, Y, Z = _dirv(pos.XDirection()), _dirv(pos.YDirection()), _dirv(pos.Direction())
    out: list[tuple[float, float]] = []
    for e in ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)):
        ex, ey, ez = _dot3(e, X), _dot3(e, Y), _dot3(e, Z)
        h = math.hypot(ex, ey)
        if h <= 1e-15:
            # e ∥ axis: critical set is the circle(s) cos v = 0; one sample u suffices because
            # the coordinate is constant along it and it meets the face boundary elsewhere.
            u = 0.5 * (ad.FirstUParameter() + ad.LastUParameter())
            out += [(u, math.pi / 2), (u, -math.pi / 2)]
            continue
        u1 = math.atan2(ey, ex)
        if t == _ST.GeomAbs_Sphere:
            # P − C = R(cos v (cos u X + sin u Y) + sin v Z) = ±R e
            out += [(u1, math.atan2(ez, h)), (u1 + math.pi, -math.atan2(ez, h))]
        else:
            # N = cos v (cos u X + sin u Y) + sin v Z ∥ e
            va, vb = math.atan2(ez, h), math.atan2(ez, -h)
            out += [(u1, va), (u1, va + math.pi), (u1 + math.pi, vb), (u1 + math.pi, vb + math.pi)]
    return out


def _revolution_critical_points(ad: BRepAdaptor_Surface) -> list[gp_Pnt]:
    """3D points where the normal is parallel to a coordinate axis, for a surface of
    revolution whose basis curve is a circle in a plane containing the axis (a torus — OCCT
    represents horn tori (R = r) this way — or a sphere when the centre is on the axis).

    For the torus (centre C, axis Z, major R, minor r) and a coordinate direction e not
    parallel to Z, with ρ̂ = unit(e − (e·Z)Z), the critical points are C ± R·ρ̂ ± r·e.
    (e ∥ Z: the critical sets are circles on which the coordinate is constant; they reach the
    face boundary or a seam, both covered by the edges.)
    """
    if ad.BasisCurve().GetType() != _CT.GeomAbs_Circle:
        return []
    ax = ad.AxeOfRevolution()
    A, Z = _vec(ax.Location()), _dirv(ax.Direction())
    circ = ad.BasisCurve().Circle()
    cc, cn, r = _vec(circ.Location()), _dirv(circ.Axis().Direction()), circ.Radius()
    if abs(_dot3(cn, Z)) > CANON_TOL:
        return []  # circle plane does not contain the axis: not a torus
    t = _dot3(_sub3(cc, A), Z)
    C = (A[0] + t * Z[0], A[1] + t * Z[1], A[2] + t * Z[2])
    R = _len3(_sub3(cc, C))
    out = []
    for e in ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)):
        ez = _dot3(e, Z)
        h = (e[0] - ez * Z[0], e[1] - ez * Z[1], e[2] - ez * Z[2])
        hn = _len3(h)
        if hn <= 1e-15:
            continue
        rho = (h[0] / hn, h[1] / hn, h[2] / hn)
        for s1 in (1.0, -1.0):
            for s2 in (1.0, -1.0):
                out.append(gp_Pnt(*(C[i] + s1 * R * rho[i] + s2 * r * e[i] for i in range(3))))
    return out


def _grid_refine_points(f, ad: BRepAdaptor_Surface, umin, umax, vmin, vmax, classify) -> list:
    """Generic fallback for surface types without a closed form: for each of ±x, ±y, ±z, take
    the best of a 24×24 in-face sample and refine it by a shrinking 9×9 local grid search."""
    n = 24
    pts = []
    samples = []
    for i in range(n + 1):
        for j in range(n + 1):
            u = umin + (umax - umin) * i / n
            v = vmin + (vmax - vmin) * j / n
            if classify(u, v):
                p = ad.Value(u, v)
                samples.append((u, v, (p.X(), p.Y(), p.Z())))
    if not samples:
        return pts
    for k in range(3):
        for sign in (1.0, -1.0):
            u, v, _ = max(samples, key=lambda q: sign * q[2][k])
            du, dv = (umax - umin) / n, (vmax - vmin) / n
            best = None
            for _ in range(40):
                best = None
                for a in range(-4, 5):
                    for b in range(-4, 5):
                        uu = min(max(u + a * du / 4, umin), umax)
                        vv = min(max(v + b * dv / 4, vmin), vmax)
                        q = ad.Value(uu, vv)
                        c = sign * (q.X(), q.Y(), q.Z())[k]
                        if best is None or c > best[0]:
                            best = (c, uu, vv)
                _, u, v = best
                du, dv = du / 2.5, dv / 2.5
            if classify(u, v):
                pts.append(ad.Value(u, v))
    return pts


def _circle_edge_points(e) -> list[gp_Pnt]:
    """Interior coordinate extremes of a circular edge (end points are vertices)."""
    ad = BRepAdaptor_Curve(e)
    if ad.GetType() == _CT.GeomAbs_Line:
        return []
    if ad.GetType() != _CT.GeomAbs_Circle:
        return None  # caller falls back
    circ = ad.Circle()
    X, Y = _dirv(circ.XAxis().Direction()), _dirv(circ.YAxis().Direction())
    t0, t1 = ad.FirstParameter(), ad.LastParameter()
    out = []
    for k in range(3):
        base = math.atan2(Y[k], X[k])
        for t in (base, base + math.pi):
            tt = _periodic_into(t, t0, t1, 2 * math.pi)
            if tt is not None:
                out.append(ad.Value(tt))
    return out


def tight_bbox(solid) -> tuple[list[float], list[float]]:
    """Tight axis-aligned box of the exact geometry, not enlarged by tolerances (SPEC §5).

    BRepBndLib::AddOptimal is NOT used for faces: it enlarges analytic tori by
    Precision::Confusion(), and on OCCT's surface-of-revolution horn tori its numerical search
    stops short of the true maximum (by 4.9e-2 mm on a R = r = 114 torus). The box is the union of
    exact pieces:
      * every vertex, and the interior extremes of every circular edge (closed form);
      * planes, cylinders, cones and extrusion / line-revolution faces attain their extremes on
        their boundary edges;
      * spheres, tori and circle-revolution faces: closed-form interior critical points, kept
        when the face classifier puts them inside the face;
      * any other surface: a sampled + refined search over the face (not exercised by IR v0).
    """
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.BRepTools import BRepTools
    from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
    from OCP.gp import gp_Pnt2d
    from OCP.TopAbs import TopAbs_IN, TopAbs_ON, TopAbs_VERTEX

    box = Bnd_Box()
    ex = TopExp_Explorer(solid, TopAbs_VERTEX)
    while ex.More():
        box.Add(BRep_Tool.Pnt_s(TopoDS.Vertex_s(ex.Current())))
        ex.Next()
    ex = TopExp_Explorer(solid, TopAbs_EDGE)
    while ex.More():
        e = TopoDS.Edge_s(ex.Current())
        ex.Next()
        if BRep_Tool.Degenerated_s(e):
            continue
        pts = _circle_edge_points(e)
        if pts is None:
            BRepBndLib.AddOptimal_s(e, box, False, False)
            continue
        for q in pts:
            box.Add(q)
    ex = TopExp_Explorer(solid, TopAbs_FACE)
    while ex.More():
        f = TopoDS.Face_s(ex.Current())
        ex.Next()
        ad = BRepAdaptor_Surface(f, False)
        t = ad.GetType()
        if t in (_ST.GeomAbs_Plane, _ST.GeomAbs_Cylinder, _ST.GeomAbs_Cone, _ST.GeomAbs_SurfaceOfExtrusion):
            continue
        umin, umax, vmin, vmax = BRepTools.UVBounds_s(f)

        def inside(u: float, v: float, f=f) -> bool:
            return BRepClass_FaceClassifier(f, gp_Pnt2d(u, v), 1e-9).State() in (TopAbs_IN, TopAbs_ON)

        if t in (_ST.GeomAbs_Sphere, _ST.GeomAbs_Torus):
            for u, v in _critical_uv(ad, t):
                uu = _periodic_into(u, umin, umax, 2 * math.pi)
                if uu is None:
                    continue
                if t == _ST.GeomAbs_Torus:
                    vv = _periodic_into(v, vmin, vmax, 2 * math.pi)
                    if vv is None:
                        continue
                else:
                    vv = v
                    if not (vmin - 1e-12 <= vv <= vmax + 1e-12):
                        continue
                if inside(uu, vv):
                    box.Add(ad.Value(uu, vv))
            continue
        if t == _ST.GeomAbs_SurfaceOfRevolution and ad.BasisCurve().GetType() == _CT.GeomAbs_Line:
            continue  # cone/cylinder/plane-like: extremes on edges
        if t == _ST.GeomAbs_SurfaceOfRevolution and ad.BasisCurve().GetType() == _CT.GeomAbs_Circle:
            surf = BRep_Tool.Surface_s(f)
            for P in _revolution_critical_points(ad):
                proj = GeomAPI_ProjectPointOnSurf(P, surf)
                for i in range(1, proj.NbPoints() + 1):
                    if proj.Distance(i) > 1e-9 * max(1.0, abs(P.X()) + abs(P.Y()) + abs(P.Z())):
                        continue
                    u, v = proj.Parameters(i)
                    uu = _periodic_into(u, umin, umax, 2 * math.pi)
                    vv = _periodic_into(v, vmin, vmax, 2 * math.pi)
                    if uu is not None and vv is not None and inside(uu, vv):
                        box.Add(ad.Value(uu, vv))
            continue
        for q in _grid_refine_points(f, ad, umin, umax, vmin, vmax, inside):
            box.Add(q)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    gap = box.GetGap()
    return [xmin + gap, ymin + gap, zmin + gap], [xmax - gap, ymax - gap, zmax - gap]


def body_metrics(solid, edge_recognition_rel: float | None = None) -> dict:
    """v0 §5 body metrics. `edge_recognition_rel` (IR v1 §8.3 rule 3): recognise free-form edges
    as lines/conics within `rel · s` (s = max(1, bbox diagonal)) instead of v0's absolute
    `CANON_FREEFORM_TOL`; v0 callers leave it None, so v0 metrics are unchanged."""
    vp = volume_props(solid)
    sp = surface_props(solid)
    com = vp.CentreOfMass()

    (xmin, ymin, zmin), (xmax, ymax, zmax) = tight_bbox(solid)
    freeform_tol = CANON_FREEFORM_TOL
    if edge_recognition_rel is not None:
        diag = math.sqrt((xmax - xmin) ** 2 + (ymax - ymin) ** 2 + (zmax - zmin) ** 2)
        freeform_tol = edge_recognition_rel * max(1.0, diag)

    fmap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(solid, TopAbs_FACE, fmap)
    faces = [TopoDS.Face_s(fmap.FindKey(i)) for i in range(1, fmap.Extent() + 1)]

    emap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(solid, TopAbs_EDGE, emap)
    anc = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(solid, TopAbs_EDGE, TopAbs_FACE, anc)
    counted: list[str] = []
    for i in range(1, emap.Extent() + 1):
        e = TopoDS.Edge_s(emap.FindKey(i))
        if BRep_Tool.Degenerated_s(e):
            continue  # OCCT degenerated edge (cone apex, sphere pole, vertex on the axis)
        seam = False
        if anc.Contains(e):
            for f in anc.FindFromKey(e):
                if BRep_Tool.IsClosed_s(e, TopoDS.Face_s(f)):
                    seam = True
                    break
        if seam:
            continue  # seam edge of a periodic face
        counted.append(edge_type(e, freeform_tol))

    return {
        "volume": vp.Mass(),
        "area": sp.Mass(),
        "centroid": [com.X(), com.Y(), com.Z()],
        "bbox_min": [xmin, ymin, zmin],
        "bbox_max": [xmax, ymax, zmax],
        "faces": len(faces),
        "edges": len(counted),
        "face_types": _hist([face_type(f) for f in faces]),
        "edge_types": _hist(counted),
        "valid": bool(BRepCheck_Analyzer(solid).IsValid()),
    }
