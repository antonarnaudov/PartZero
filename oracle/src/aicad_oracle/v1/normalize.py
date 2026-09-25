"""SPEC-v1 §8.3 normalizations of OCCT results (rules 1 and 3), for W7b.

OCCT's topology after a body operation differs from Forge's seam-free topology in ways the SPEC
lists; the oracle normalizes the **counts** (never positions rounded to a grid) on OCCT's own
topological entities (shared `TopoDS` vertices and edges):

Rule 1 (same-domain merge, [W0-42], [W0-49]) — after `ShapeUpgrade_UnifySameDomain`, which in OCP
7.9.3 does not re-merge periodic faces split along seams:

1. faces on one carrier surface (the same surface, the same orientation) that share an edge are one
   face. "The same surface" is decided with the named tests of `same_carrier` (Forge's
   `forge-ops` `boolean::geom::same_carrier`); free-form carriers only when they are one OCCT
   handle (a shared construction); "the same orientation": outward normals with a positive dot
   product at the shared edge;
2. an edge is counted iff it has two **different** faces (after 1) on its sides — a seam, or an
   internal edge between two pieces of one face, is not; an edge between two different faces is
   counted even where it lies on a periodic face's seam line (v0's `IsClosed` test dropped those);
3. counted edges that meet at a vertex no other counted edge uses (seam edges do not count there,
   a degenerate edge does) are one edge when they lie on one carrier curve: (a) both lines, both
   circles or both ellipses (after rule 3) on the same carrier, or (b) both between the same two
   different faces F and G that are transversal at the vertex (`|n_F × n_G| > ANGULAR_TOLERANCE`)
   with unit tangents leaving the vertex satisfying `t0 · t1 < 0`. The merged edge has the type
   of its longest piece.

Rule 3 (section edge types, [W0-43], [W0-49], [W0-51], [W0-52]) — `section_type`: an edge a body
operation creates where faces of two operands meet is a line, circle or ellipse iff (a) its two
faces are a pair of the rule-3 list (`pair_conic`, classified with `ANGULAR_TOLERANCE` for
directions and *tol* for positions and radii, the plane–cone test of [W0-51] included) and (b)
OCCT's own curve lies within *tol* of a conic of that type — and within *tol* of both faces'
carrier surfaces ([W0-52]: a conic OCCT substitutes for a pair that passes (a) only within its
tolerances is wrong geometry, not a witness; `surface_distance`) — at its end points and at 33
interior points evenly spaced in its parameter (the witness: OCCT's curve itself when it is that
conic, else `ShapeAnalysis_CanonicalRecognition` at *tol* — the SPEC also names
`GeomConvert_CurveToAnalyticalCurve`, which this OCP build does not expose); otherwise `bspline`.
When (a) holds and (b) fails the oracle notes `ORACLE_SECTION_NOT_CONIC` (engine-prefixed, no
class). The type is the one (a) names, nothing else: a nearly round ellipse (an oblique plane
1e-4 rad off perpendicular to a cylinder's axis) stays `ellipse` — a circle within *tol* is a
witness of an ellipse, never a reason to retype it (W7b review 5; the SPEC turns no nearly round
ellipse into a circle).

Known limitation of rule 1.3(b) (SPEC): at a tangency where two branches cross with
`t0 · t1 < 0` the oracle can still merge two pieces that §6.0.4 keeps apart; `merge_stats`
counts the (b) merges at nearly tangent vertices (`|n_F × n_G| < 1e-6`) so W7b can report their
frequency.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field

from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepGProp import BRepGProp
from OCP.Geom import Geom_Ellipse
from OCP.GeomAbs import GeomAbs_CurveType, GeomAbs_SurfaceType
from OCP.GeomAPI import GeomAPI_ProjectPointOnCurve
from OCP.GProp import GProp_GProps
from OCP.gp import gp_Circ, gp_Elips, gp_Lin, gp_Pnt, gp_Vec
from OCP.ShapeAnalysis import ShapeAnalysis_CanonicalRecognition
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_FORWARD, TopAbs_REVERSED
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape

from . import geom
from .consts import ANGULAR_TOLERANCE, LINEAR_TOLERANCE, QUERY_ANGLE_TOLERANCE

ANG = ANGULAR_TOLERANCE
TOL = LINEAR_TOLERANCE
#: Interior sample points of the rule-3 (b) check ("no fewer than 31", evenly spaced in the
#: curve's parameter), plus the two end points.
SECTION_SAMPLES = 33
#: Rule 1.3(b) merges at vertices where `|n_F × n_G|` is below this are counted in `merge_stats`
#: (the known limitation of the SPEC). Only a statistic, never a decision: it borrows the named
#: `QUERY_ANGLE_TOLERANCE` so that no unnamed number appears here.
NEAR_TANGENT = QUERY_ANGLE_TOLERANCE

_ST = GeomAbs_SurfaceType
_CT = GeomAbs_CurveType

#: Counters for W7b's report on rule 1.3(b) (process-local; informative only).
merge_stats = {"a": 0, "b": 0, "b_near_tangent": 0}


def _v(p) -> tuple[float, float, float]:
    return (p.X(), p.Y(), p.Z())


def _par(a, b) -> bool:
    return geom.norm(geom.cross(a, b)) <= ANG


def _perp(a, b) -> bool:
    return abs(geom.dot(a, b)) <= ANG


def _dist_line(p, o, d) -> float:
    """Distance of point p to the line through o with unit direction d."""
    return geom.norm(geom.cross(geom.sub(p, o), d))


def _line_line_distance(o1, d1, o2, d2) -> float:
    n = geom.cross(d1, d2)
    ln = geom.norm(n)
    if ln <= ANG:  # parallel within ANGULAR_TOLERANCE: the common normal is ill-conditioned
        return _dist_line(o2, o1, d1)
    return abs(geom.dot(geom.sub(o2, o1), n)) / ln


# ---------------------------------------------------------------------------------------------
# Carrier surfaces
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class SurfGeom:
    """An analytic carrier surface. plane: `loc` a point, `axis` the (face-independent) normal;
    cylinder: `loc` a point of the axis, `r`; cone: `loc` the apex, `alpha` the half-angle;
    sphere: `loc` the centre, `r`; torus: `loc` the centre, `r` major, `r2` minor."""

    kind: str
    loc: tuple
    axis: tuple | None
    r: float = 0.0
    r2: float = 0.0
    alpha: float = 0.0


def surface_geom(face) -> SurfGeom | None:
    """The analytic carrier of a face (surfaces of revolution and extrusion included), or None
    for a free-form one."""
    ad = BRepAdaptor_Surface(face, False)
    t = ad.GetType()
    if t == _ST.GeomAbs_Plane:
        pos = ad.Plane().Position()
        return SurfGeom("plane", _v(pos.Location()), geom.unit(_v(pos.Direction())))
    if t == _ST.GeomAbs_Cylinder:
        c = ad.Cylinder()
        return SurfGeom("cylinder", _v(c.Axis().Location()), geom.unit(_v(c.Axis().Direction())), c.Radius())
    if t == _ST.GeomAbs_Cone:
        c = ad.Cone()
        a = abs(c.SemiAngle())
        d = geom.unit(_v(c.Axis().Direction()))
        # v0 [R-8] (SPEC §4.4, "1e-9 rad as in §1" = ANGULAR_TOLERANCE): a profile line within
        # ANGULAR_TOLERANCE of parallel to the axis sweeps a cylinder, within it of perpendicular a
        # plane — so a cone of such a half-angle is that cylinder or plane
        if a <= ANG:
            return SurfGeom("cylinder", _v(c.Axis().Location()), d, c.RefRadius())
        if abs(math.pi / 2 - a) <= ANG:
            return SurfGeom("plane", _v(c.Apex()), d)
        # OCCT's axis direction and SemiAngle sign: the generators open towards +axis when the
        # SemiAngle is positive. Orient `axis` towards the opening so that axes compare with sense.
        if c.SemiAngle() < 0:
            d = geom.mul(d, -1.0)
        return SurfGeom("cone", _v(c.Apex()), d, alpha=a)
    if t == _ST.GeomAbs_Sphere:
        s = ad.Sphere()
        return SurfGeom("sphere", _v(s.Location()), None, s.Radius())
    if t == _ST.GeomAbs_Torus:
        tr = ad.Torus()
        if tr.MajorRadius() <= TOL:
            return SurfGeom("sphere", _v(tr.Location()), None, tr.MinorRadius())
        return SurfGeom("torus", _v(tr.Location()), geom.unit(_v(tr.Axis().Direction())), tr.MajorRadius(),
                        tr.MinorRadius())
    if t == _ST.GeomAbs_SurfaceOfRevolution:
        ax = ad.AxeOfRevolution()
        ao, ad_ = _v(ax.Location()), geom.unit(_v(ax.Direction()))
        bc = ad.BasisCurve()
        if bc.GetType() == _CT.GeomAbs_Line:
            ln = bc.Line()
            lo, ld = _v(ln.Location()), geom.unit(_v(ln.Direction()))
            if _par(ld, ad_):
                return SurfGeom("cylinder", ao, ad_, _dist_line(lo, ao, ad_))
            if _perp(ld, ad_):
                return SurfGeom("plane", lo, ad_)
            n = geom.cross(ld, ad_)
            if abs(geom.dot(geom.sub(lo, ao), n)) / geom.norm(n) > TOL:
                return None  # a hyperboloid
            # apex: the line's point on the axis
            w = geom.sub(lo, ao)
            dd = geom.dot(ld, ad_)
            s = (geom.dot(w, ad_) * dd - geom.dot(w, ld)) / (1.0 - dd * dd)
            apex = geom.add(lo, geom.mul(ld, s))
            alpha = math.acos(min(1.0, abs(dd)))
            # the cone opens along the axis direction on which the generator lies away from apex
            return SurfGeom("cone", apex, ad_ if dd >= 0 else geom.mul(ad_, -1.0), alpha=alpha)
        if bc.GetType() == _CT.GeomAbs_Circle:
            ci = bc.Circle()
            cc = _v(ci.Location())
            h = geom.dot(geom.sub(cc, ao), ad_)
            foot = geom.add(ao, geom.mul(ad_, h))
            rho = geom.dist(cc, foot)
            if rho <= TOL:
                return SurfGeom("sphere", foot, None, ci.Radius())
            return SurfGeom("torus", foot, ad_, rho, ci.Radius())
        return None
    if t == _ST.GeomAbs_SurfaceOfExtrusion:
        dv = geom.unit(_v(ad.Direction()))
        bc = ad.BasisCurve()
        if bc.GetType() == _CT.GeomAbs_Line:
            ln = bc.Line()
            n = geom.cross(_v(ln.Direction()), dv)
            if geom.norm(n) <= ANG:
                return None
            return SurfGeom("plane", _v(ln.Location()), geom.unit(n))
        if bc.GetType() == _CT.GeomAbs_Circle:
            ci = bc.Circle()
            if _par(_v(ci.Axis().Direction()), dv):
                return SurfGeom("cylinder", _v(ci.Location()), dv, ci.Radius())
        return None
    return None


def same_carrier(ga: SurfGeom | None, gb: SurfGeom | None, fa=None, fb=None) -> bool:
    """§8.3 rule 1.1 [W0-49]: the same carrier surface, by the named tests (orientation apart).
    Free-form carriers (None) only when both faces hold one OCCT surface handle."""
    if ga is None or gb is None:
        if ga is None and gb is None and fa is not None and fb is not None:
            return BRep_Tool.Surface_s(fa) == BRep_Tool.Surface_s(fb)
        return False
    if ga.kind != gb.kind:
        return False
    k = ga.kind
    if k == "plane":
        return _par(ga.axis, gb.axis) and abs(geom.dot(geom.sub(gb.loc, ga.loc), ga.axis)) <= TOL
    if k == "cylinder":
        return (_par(ga.axis, gb.axis) and abs(ga.r - gb.r) <= TOL
                and _dist_line(gb.loc, ga.loc, ga.axis) <= TOL)
    if k == "cone":
        return (geom.dot(ga.axis, gb.axis) > 0.0 and _par(ga.axis, gb.axis) and abs(ga.alpha - gb.alpha) <= ANG
                and geom.dist(ga.loc, gb.loc) <= TOL)
    if k == "sphere":
        return abs(ga.r - gb.r) <= TOL and geom.dist(ga.loc, gb.loc) <= TOL
    if k == "torus":
        return (_par(ga.axis, gb.axis) and abs(ga.r - gb.r) <= TOL and abs(ga.r2 - gb.r2) <= TOL
                and geom.dist(ga.loc, gb.loc) <= TOL)
    return False


# ---------------------------------------------------------------------------------------------
# Rule 3: the surface pairs whose section is a conic, and the (b) check
# ---------------------------------------------------------------------------------------------

_REVOLUTION = ("cylinder", "cone", "sphere", "torus")


def _coaxial(ga: SurfGeom, gb: SurfGeom) -> bool:
    """Two surfaces of revolution sharing an axis (a sphere's axis is any line through its
    centre)."""
    if ga.kind == "sphere" and gb.kind == "sphere":
        return True
    if ga.kind == "sphere":
        return _dist_line(ga.loc, gb.loc, gb.axis) <= TOL
    if gb.kind == "sphere":
        return _dist_line(gb.loc, ga.loc, ga.axis) <= TOL
    return _par(ga.axis, gb.axis) and _dist_line(gb.loc, ga.loc, ga.axis) <= TOL


def pair_conic(ga: SurfGeom | None, gb: SurfGeom | None) -> str | None:
    """§8.3 rule 3 (a): the conic type (`line`, `circle`, `ellipse`) of the section of two carrier
    surfaces whose intersection is exactly that conic, or None (the section is `bspline`)."""
    if ga is None or gb is None:
        return None
    if ga.kind > gb.kind:  # order the pair: cone < cylinder < plane < sphere < torus
        ga, gb = gb, ga
    ka, kb = ga.kind, gb.kind
    if ka == "plane" and kb == "plane":
        return None if _par(ga.axis, gb.axis) else "line"
    if kb == "plane" and ka in _REVOLUTION or ka == "plane" and kb in _REVOLUTION:
        pl, rv = (ga, gb) if ka == "plane" else (gb, ga)
        n = pl.axis
        if rv.kind == "sphere":
            return "circle"  # every plane–sphere pair (a plane is perpendicular to some axis)
        a = rv.axis
        if _par(n, a):
            return "circle"  # a plane perpendicular to the axis counts as a surface of revolution
        if rv.kind == "cylinder":
            return "line" if _perp(n, a) else "ellipse"
        if rv.kind == "cone":
            # [W0-51]: c = |n · a|, α the half-angle
            c = abs(geom.dot(n, a))
            sa = math.sin(rv.alpha)
            if c > sa + ANG:
                return "ellipse"
            apex_off = abs(geom.dot(geom.sub(rv.loc, pl.loc), n))
            if apex_off <= TOL and c < sa - ANG:
                return "line"
            return None  # parabola, hyperbola, or the guard band
        if rv.kind == "torus":
            if _perp(n, a) and abs(geom.dot(geom.sub(rv.loc, pl.loc), n)) <= TOL:
                return "circle"  # a plane through the axis: meridian circles
            if (abs(geom.dot(geom.sub(rv.loc, pl.loc), n)) <= TOL and rv.r > rv.r2
                    and abs(rv.r * geom.norm(geom.cross(n, a)) - rv.r2) <= TOL):
                return "circle"  # a bitangent plane of a ring torus: Villarceau circles
            return None
        return None
    # two surfaces of revolution
    if ka == "cylinder" and kb == "cylinder":
        if _par(ga.axis, gb.axis):
            return None if _coaxial(ga, gb) else "line"  # parallel axes: lines (coaxial: no section)
        if abs(ga.r - gb.r) <= TOL and _line_line_distance(ga.loc, ga.axis, gb.loc, gb.axis) <= TOL:
            return "ellipse"
        return None
    if ka in _REVOLUTION and kb in _REVOLUTION and _coaxial(ga, gb):
        return "circle"
    return None


def curve_carrier(edge, want: str):
    """A conic of type `want` within *tol* of the edge's curve (a witness), or None: OCCT's own
    curve when it is that conic, else `ShapeAnalysis_CanonicalRecognition` at *tol*. For
    `ellipse` a circle is a witness too (an ellipse with equal radii) — it witnesses the type,
    it does not change it (`section_type`)."""
    ad = BRepAdaptor_Curve(edge)
    t = ad.GetType()
    if want == "line" and t == _CT.GeomAbs_Line:
        return ad.Line()
    if want == "circle" and t == _CT.GeomAbs_Circle:
        return ad.Circle()
    if want == "ellipse" and t == _CT.GeomAbs_Ellipse:
        return ad.Ellipse()
    if want == "ellipse" and t == _CT.GeomAbs_Circle:
        return ad.Circle()
    try:
        cr = ShapeAnalysis_CanonicalRecognition(edge)
        if want == "line":
            out = gp_Lin()
            return out if cr.IsLine(TOL, out) else None
        if want == "circle":
            out = gp_Circ()
            if cr.IsCircle(TOL, out):
                return out
            if t == _CT.GeomAbs_Ellipse:
                el = ad.Ellipse()
                if el.MajorRadius() - el.MinorRadius() <= TOL:
                    return gp_Circ(el.Position(), el.MajorRadius())
            return None
        if want == "ellipse":
            out = gp_Elips()
            if cr.IsEllipse(TOL, out):
                return out
            out2 = gp_Circ()
            if cr.IsCircle(TOL, out2):  # an ellipse with equal radii
                return out2
            return None
    except Exception:  # recognition failures are "no witness"
        return None
    return None


def _conic_distance(w, p: gp_Pnt) -> float:
    if isinstance(w, gp_Lin):
        return w.Distance(p)
    if isinstance(w, gp_Circ):
        return w.Distance(p)
    proj = GeomAPI_ProjectPointOnCurve(p, Geom_Ellipse(w))
    if proj.NbPoints() == 0:
        return math.inf
    return proj.LowerDistance()


def surface_distance(g: SurfGeom, p: tuple) -> float:
    """The distance from a point to an analytic carrier surface (untrimmed; a cone is OCCT's
    double cone)."""
    if g.kind == "plane":
        return abs(geom.dot(geom.sub(p, g.loc), g.axis))
    if g.kind == "sphere":
        return abs(geom.dist(p, g.loc) - g.r)
    if g.kind == "cylinder":
        return abs(_dist_line(p, g.loc, g.axis) - g.r)
    w = geom.sub(p, g.loc)
    h = geom.dot(w, g.axis)
    rho = geom.norm(geom.sub(w, geom.mul(g.axis, h)))
    if g.kind == "torus":
        return abs(math.hypot(rho - g.r, h) - g.r2)
    if g.kind == "cone":
        # in the meridian half-plane (h, ρ ≥ 0): the generators are the rays from the apex along
        # (±cos α, sin α)
        ca, sa = math.cos(g.alpha), math.sin(g.alpha)
        best = math.hypot(h, rho)
        for sgn in (1.0, -1.0):
            if sgn * h * ca + rho * sa >= 0.0:
                best = min(best, abs(-sgn * h * sa + rho * ca))
        return best
    return math.inf


def within_tol(edge, w, surfaces: tuple = ()) -> bool:
    """§8.3 rule 3 (b): OCCT's curve within *tol* of the conic `w` — and, [W0-52], of each of the
    two faces' carrier `surfaces` (the curve checked is the engine's computed intersection of the
    two faces, which must lie within *tol* of both: a conic OCCT substitutes for the section of a
    pair that passes (a) only within its tolerances is not a witness) — at its end points and at
    `SECTION_SAMPLES` interior points evenly spaced in its parameter."""
    ad = BRepAdaptor_Curve(edge)
    u0, u1 = ad.FirstParameter(), ad.LastParameter()
    n = SECTION_SAMPLES + 1
    for i in range(n + 1):
        u = u0 + (u1 - u0) * i / n
        q = ad.Value(u)
        if _conic_distance(w, q) > TOL:
            return False
        if any(surface_distance(g, _v(q)) > TOL for g in surfaces):
            return False
    return True


def section_type(edge, fa, fb, notes: list | None = None) -> tuple[str, object]:
    """(canonical type, carrier) of a section edge between faces `fa` and `fb` (§8.3 rule 3)."""
    ga, gb = surface_geom(fa), surface_geom(fb)
    want = pair_conic(ga, gb)
    if want is None:
        return "bspline", None
    w = curve_carrier(edge, want)
    if w is None or not within_tol(edge, w):
        if notes is not None:
            notes.append(f"a {want} pair whose OCCT section is not within tol of a {want}")
        return "bspline", None
    if not within_tol(edge, w, (ga, gb)):
        if notes is not None:
            notes.append(f"a {want} pair whose OCCT section is not within tol of both faces (a substituted {want})")
        return "bspline", None
    # (a) names the type and (b) passed: that is the type. An `ellipse` whose witness is a circle
    # (or an ellipse with radii within tol) stays an ellipse — §8.3 rule 3 has no ellipse-to-circle
    # collapse, and Forge reports the pair's ellipse (W7b review 5).
    return want, w


def own_curve_type(edge) -> str:
    """The canonical type of a new edge of a local operation (a blend's, a bevel's or a shell's rim,
    `blends.name_history`), typed by its own curve: OCCT's native line, circle or ellipse **as
    built** — a native ellipse with radii within *tol* stays `ellipse` (v0's
    `occt.edge_type` collapsed it at `LINEAR_TOLERANCE`, the collapse W7b review 5 removed from
    rule 3) — else a free-form curve with a witness conic within *tol* (§8.3 rule 3 (b)'s named
    constant; a line, then a circle, then an ellipse: without a face pair naming the type, a curve
    within *tol* of both a circle and an ellipse is typed by the more specific one), else
    `bspline` (`other` for an offset curve)."""
    ad = BRepAdaptor_Curve(edge)
    t = ad.GetType()
    if t == _CT.GeomAbs_Line:
        return "line"
    if t == _CT.GeomAbs_Circle:
        return "circle"
    if t == _CT.GeomAbs_Ellipse:
        return "ellipse"
    if t in (_CT.GeomAbs_BSplineCurve, _CT.GeomAbs_BezierCurve, _CT.GeomAbs_OffsetCurve):
        try:
            cr = ShapeAnalysis_CanonicalRecognition(edge)
            if cr.IsLine(TOL, gp_Lin()):
                return "line"
            if cr.IsCircle(TOL, gp_Circ()):
                return "circle"
            if cr.IsEllipse(TOL, gp_Elips()):
                return "ellipse"
        except Exception:  # recognition failures are "no witness"
            pass
        return "bspline" if t != _CT.GeomAbs_OffsetCurve else "other"
    return "other"


def native_carrier(edge, ctype: str):
    """The carrier conic of an edge whose type is already decided (for rule 1.3 (a))."""
    if ctype not in ("line", "circle", "ellipse"):
        return None
    return curve_carrier(edge, ctype)


def same_curve_carrier(ta: str, ca, tb: str, cb) -> bool:
    """§8.3 rule 1.3 (a): both lines, both circles or both ellipses on the same carrier."""
    if ta != tb or ta not in ("line", "circle", "ellipse") or ca is None or cb is None:
        return False
    if ta == "line":
        da, db = _v(ca.Direction()), _v(cb.Direction())
        return _par(da, db) and _dist_line(_v(cb.Location()), _v(ca.Location()), geom.unit(da)) <= TOL
    na, nb = _v(ca.Axis().Direction()), _v(cb.Axis().Direction())
    if not (_par(na, nb) and geom.dist(_v(ca.Location()), _v(cb.Location())) <= TOL):
        return False
    if ta == "circle":
        if type(ca) is not type(cb) or not isinstance(ca, gp_Circ):
            return False
        return abs(ca.Radius() - cb.Radius()) <= TOL
    # `ellipse`: a witness may be a circle (a nearly round ellipse, rule 3); compare radii, and the
    # major axes only when neither is round within tol (a round one's major axis is arbitrary).
    (a1, b1, xa), (a2, b2, xb) = _ellipse_radii(ca), _ellipse_radii(cb)
    if abs(a1 - a2) > TOL or abs(b1 - b2) > TOL:
        return False
    if a1 - b1 <= TOL or a2 - b2 <= TOL:
        return True
    return _par(xa, xb)


def _ellipse_radii(w) -> tuple[float, float, tuple | None]:
    """(major, minor, major-axis direction) of an ellipse witness; a circle is round (no axis)."""
    if isinstance(w, gp_Circ):
        return w.Radius(), w.Radius(), None
    return w.MajorRadius(), w.MinorRadius(), _v(w.XAxis().Direction())


# ---------------------------------------------------------------------------------------------
# Rule 1: the normalized topology of a solid
# ---------------------------------------------------------------------------------------------

def _outward_normal_at(face, p) -> tuple | None:
    from .topo import outward_normal

    return outward_normal(face, p)


def _edge_length(e) -> float:
    g = GProp_GProps()
    BRepGProp.LinearProperties_s(e, g, False, False)
    return g.Mass()


def _tangent_leaving(e, v) -> tuple | None:
    """The unit tangent of edge e leaving vertex v (None when not evaluable)."""
    ad = BRepAdaptor_Curve(e)
    u0, u1 = ad.FirstParameter(), ad.LastParameter()
    p0 = _v(ad.Value(u0))
    q = _v(BRep_Tool.Pnt_s(v))
    p1 = _v(ad.Value(u1))
    at_start = geom.dist(p0, q) <= geom.dist(p1, q)
    u = u0 if at_start else u1
    pnt, vec = gp_Pnt(), gp_Vec()
    ad.D1(u, pnt, vec)
    t = (vec.X(), vec.Y(), vec.Z())
    if geom.norm(t) <= 1e-300:
        return None
    t = geom.unit(t)
    return t if at_start else geom.mul(t, -1.0)


class _UF:
    def __init__(self, n: int):
        self.p = list(range(n))

    def find(self, i: int) -> int:
        while self.p[i] != i:
            self.p[i] = self.p[self.p[i]]
            i = self.p[i]
        return i

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            if ra < rb:
                self.p[rb] = ra
            else:
                self.p[ra] = rb


@dataclass
class NormTopo:
    """The normalized topology of one solid: face groups (oriented OCCT faces), edge groups (OCCT
    edges), their adjacency and types, and the vertices (OCCT vertices that remain)."""

    faces: list[list] = field(default_factory=list)
    edges: list[list] = field(default_factory=list)
    edge_faces: list[list[int]] = field(default_factory=list)  # face-group indices of each edge group
    edge_types: list[str] = field(default_factory=list)
    vertices: list = field(default_factory=list)
    vertex_edges: list[list[int]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def normalized_topology(solid, *, edge_type: Callable[[object, object, object], str],
                        face_merge_ok: Callable[[object, object], bool] | None = None) -> NormTopo:
    """§8.3 rules 1.1–1.3 on the OCCT topology of `solid`.

    `edge_type(edge, face_a, face_b)` gives the canonical type of a counted OCCT edge (rule 3 for
    section edges, the construction type otherwise); `face_merge_ok(face_a, face_b)` restricts
    rule 1.1 (None: every same-carrier pair — after body operations, §6.0.4)."""
    fmap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(solid, TopAbs_FACE, fmap)
    nf = fmap.Extent()
    oriented: dict[int, object] = {}
    ex = TopExp_Explorer(solid, TopAbs_FACE)
    while ex.More():
        f = TopoDS.Face_s(ex.Current())
        oriented.setdefault(fmap.FindIndex(f), f)
        ex.Next()
    faces = [oriented.get(i, TopoDS.Face_s(fmap.FindKey(i))) for i in range(1, nf + 1)]
    anc = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(solid, TopAbs_EDGE, TopAbs_FACE, anc)
    edges: list = []
    edge_face_idx: list[list[int]] = []
    degenerate: list = []
    for i in range(1, anc.Extent() + 1):
        e = TopoDS.Edge_s(anc.FindKey(i))
        if BRep_Tool.Degenerated_s(e):
            degenerate.append(e)
            continue
        fl = sorted({fmap.FindIndex(f) - 1 for f in anc.FindFromIndex(i)})
        edges.append(e)
        edge_face_idx.append(fl)
    geoms = [surface_geom(f) for f in faces]
    # -- rule 1.1: face groups
    uf = _UF(nf)
    for e, fl in zip(edges, edge_face_idx):
        if len(fl) != 2:
            continue
        a, b = fl
        if uf.find(a) == uf.find(b):
            continue
        if face_merge_ok is not None and not face_merge_ok(faces[a], faces[b]):
            continue
        if not same_carrier(geoms[a], geoms[b], faces[a], faces[b]):
            continue
        ad = BRepAdaptor_Curve(e)
        p = _v(ad.Value(0.5 * (ad.FirstParameter() + ad.LastParameter())))
        na, nb = _outward_normal_at(faces[a], p), _outward_normal_at(faces[b], p)
        if na is None or nb is None or geom.dot(na, nb) <= 0.0:
            continue
        uf.union(a, b)
    roots = sorted({uf.find(i) for i in range(nf)})
    gidx = {r: k for k, r in enumerate(roots)}
    fgroup = [gidx[uf.find(i)] for i in range(nf)]
    out = NormTopo(faces=[[faces[i] for i in range(nf) if fgroup[i] == k] for k in range(len(roots))])
    # -- rule 1.2: counted edges (two different faces on their sides)
    counted: list[int] = []
    cfaces: list[list[int]] = []
    for k, fl in enumerate(edge_face_idx):
        gs = sorted({fgroup[i] for i in fl})
        if len(gs) >= 2:
            counted.append(k)
            cfaces.append(gs)
    ctypes: list[str] = []
    for k, gs in zip(counted, cfaces):
        fl = edge_face_idx[k]
        fa = next(faces[i] for i in fl if fgroup[i] == gs[0])
        fb = next(faces[i] for i in fl if fgroup[i] == gs[1])
        ctypes.append(edge_type(edges[k], fa, fb))
    # -- rule 1.3: merge counted edges at vertices only they use
    vmap = TopTools_IndexedMapOfShape()
    uses: dict[int, list[int]] = {}
    for ci, k in enumerate(counted):
        e = edges[k]
        for v in (TopExp.FirstVertex_s(e), TopExp.LastVertex_s(e)):
            vi = vmap.Add(v)
            uses.setdefault(vi, []).append(ci)
    blocked: set[int] = set()
    for e in degenerate:
        for v in (TopExp.FirstVertex_s(e), TopExp.LastVertex_s(e)):
            vi = vmap.FindIndex(v)
            if vi:
                blocked.add(vi)
    carriers: dict[int, object] = {}

    def carrier(ci: int):
        if ci not in carriers:
            carriers[ci] = native_carrier(edges[counted[ci]], ctypes[ci])
        return carriers[ci]

    euf = _UF(len(counted))
    merged_vertices: set[int] = set()
    for vi in sorted(uses):
        us = uses[vi]
        if vi in blocked or len(us) != 2 or us[0] == us[1]:
            continue
        a, b = us
        v = TopoDS.Vertex_s(vmap.FindKey(vi))
        ok = same_curve_carrier(ctypes[a], carrier(a), ctypes[b], carrier(b))
        if ok:
            merge_stats["a"] += 1
        elif cfaces[a] == cfaces[b] and len(cfaces[a]) == 2:
            q = _v(BRep_Tool.Pnt_s(v))
            ga, gb = cfaces[a]
            fa = next(faces[i] for i in edge_face_idx[counted[a]] if fgroup[i] == ga)
            fb = next(faces[i] for i in edge_face_idx[counted[a]] if fgroup[i] == gb)
            na, nb = _outward_normal_at(fa, q), _outward_normal_at(fb, q)
            t0, t1 = _tangent_leaving(edges[counted[a]], v), _tangent_leaving(edges[counted[b]], v)
            if na is not None and nb is not None and t0 is not None and t1 is not None:
                cr = geom.norm(geom.cross(na, nb))
                if cr > ANG and geom.dot(t0, t1) < 0.0:
                    ok = True
                    merge_stats["b"] += 1
                    if cr < NEAR_TANGENT:
                        merge_stats["b_near_tangent"] += 1
                        out.notes.append(f"rule 1.3(b) merge at a nearly tangent vertex (|nF x nG| = {cr:.3g})")
        if ok:
            # (a chain closing on itself at its last vertex becomes a ring: no vertex)
            euf.union(a, b)
            merged_vertices.add(vi)
    eroots = sorted({euf.find(i) for i in range(len(counted))})
    eidx = {r: k for k, r in enumerate(eroots)}
    groups: list[list[int]] = [[] for _ in eroots]
    for ci in range(len(counted)):
        groups[eidx[euf.find(ci)]].append(ci)
    for g in groups:
        pieces = [edges[counted[ci]] for ci in g]
        out.edges.append(pieces)
        out.edge_faces.append(cfaces[g[0]])
        if len(g) == 1:
            out.edge_types.append(ctypes[g[0]])
        else:
            lens = [(_edge_length(edges[counted[ci]]), -ci) for ci in g]
            best = g[lens.index(max(lens))]
            out.edge_types.append(ctypes[best])
    # vertices: OCCT vertices at the ends of edge groups (merged ones drop). A closed (ring) edge
    # has no vertex of its own in a seam-free topology — its OCCT vertex drops unless another
    # counted edge uses that vertex, where the ring passes through a real vertex and belongs to it
    # (a line ending on a full circle): then the ring is adjacent to that vertex like any edge.
    vedges: dict[int, list[int]] = {}
    ring_at: dict[int, list[int]] = {}
    for gi, g in enumerate(groups):
        ends: dict[int, int] = {}
        for ci in g:
            e = edges[counted[ci]]
            v1, v2 = TopExp.FirstVertex_s(e), TopExp.LastVertex_s(e)
            if v1.IsSame(v2):
                ring_at.setdefault(vmap.FindIndex(v1), []).append(gi)
                continue
            for v in (v1, v2):
                vi = vmap.FindIndex(v)
                ends[vi] = ends.get(vi, 0) + 1
        for vi, cnt in ends.items():
            if vi in merged_vertices and cnt % 2 == 0:
                continue
            vedges.setdefault(vi, []).append(gi)
    for vi, rings in ring_at.items():
        users = {eidx[euf.find(ci)] for ci in uses.get(vi, [])}  # the edge groups using the vertex
        for gi in rings:
            if users - {gi}:
                vedges.setdefault(vi, []).append(gi)
    for vi in sorted(vedges):
        out.vertices.append(TopoDS.Vertex_s(vmap.FindKey(vi)))
        out.vertex_edges.append(sorted(set(vedges[vi])))
    return out


def face_orientation_ok(face) -> bool:
    return face.Orientation() in (TopAbs_FORWARD, TopAbs_REVERSED)


__all__ = ["SurfGeom", "surface_geom", "same_carrier", "pair_conic", "section_type", "curve_carrier", "own_curve_type",
           "within_tol", "surface_distance", "same_curve_carrier", "normalized_topology", "NormTopo", "merge_stats"]
