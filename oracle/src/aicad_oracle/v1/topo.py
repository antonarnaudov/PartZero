"""OCCT bodies with provenance keys, entity properties and probes (SPEC-v1 §5.2, §5.3, §7.6).

The oracle names what it builds **itself** (never from Forge): every face of an extrude or
revolve body is found by a point that the SPEC's construction puts on it (the midpoint of the
generating profile curve at mid-height / mid-angle for a side face, an interior point of the
region on the start / end plane for a cap), and gets the key of §5.2 rule 3:

    F/cap:start@m  F/cap:end@m  F/endcap:start@m  F/endcap:end@m  F/side:c
    F/edge:{A|B}   (+ `@c.end` on side–side junction edges: the smallest curve end at the sketch
                    vertex the edge was swept from)
    F/vertex:{A|B|…} (the sorted keys of the incident faces; vertex keys are not spelled out by
                    §5.2 — this is the oracle's reading, used only internally)

OCCT seam edges and degenerated edges are not entities (Forge's topology is seam-free, §4.4 of
v0); vertices are the end vertices of the remaining open edges. Body operations (booleans) carry
keys through OCCT's history (`booleans.py`).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepGProp import BRepGProp
from OCP.BRepLProp import BRepLProp_SLProps
from OCP.GeomAbs import GeomAbs_CurveType, GeomAbs_SurfaceType
from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
from OCP.GProp import GProp_GProps
from OCP.gp import gp_Pnt
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_SHELL
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape

from .. import occt
from . import geom
from .geom import Vec3

#: SPEC-v1 §8.3 rule 3: intersection edges that OCCT returns as B-splines but that are lines or
#: conics within `1e-7·s` are counted as such (OCCT's `ShapeAnalysis_CanonicalRecognition`; the
#: SPEC names `GeomConvert_CurveToAnalyticalCurve`, which this OCP build does not expose — both
#: fit the curve against the analytic candidates within the given tolerance).
CURVE_RECOGNITION_REL = 1e-7

_ST = GeomAbs_SurfaceType
_CT = GeomAbs_CurveType


class TopoError(Exception):
    """An engine-internal failure while naming or probing OCCT topology (OCCT_* code)."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _v(p) -> Vec3:
    return (p.X(), p.Y(), p.Z())


def point_shape_distance(p: Vec3, shape) -> float:
    v = BRepBuilderAPI_MakeVertex(gp_Pnt(*p)).Vertex()
    d = BRepExtrema_DistShapeShape(v, shape)
    if not d.IsDone() or d.NbSolution() == 0:
        return math.inf
    return d.Value()


def outward_normal(face, p: Vec3) -> Vec3 | None:
    """The outward unit normal of `face` at (the projection of) `p`."""
    surf = BRep_Tool.Surface_s(face)
    proj = GeomAPI_ProjectPointOnSurf(gp_Pnt(*p), surf)
    if proj.NbPoints() == 0:
        return None
    u, v = proj.LowerDistanceParameters()
    ad = BRepAdaptor_Surface(face, False)
    props = BRepLProp_SLProps(ad, u, v, 1, 1e-9)
    if not props.IsNormalDefined():
        return None
    n = _v(props.Normal())
    if face.Orientation() == TopAbs_REVERSED:
        n = geom.mul(n, -1.0)
    return n


# ---------------------------------------------------------------------------------------------
# Entities
# ---------------------------------------------------------------------------------------------

@dataclass(eq=False)
class Entity:
    kind: str  # face / edge / vertex
    shape: object
    body: "Body"
    key: str = ""
    probe_point: Vec3 | None = None  # set by the naming step when a construction point is known
    _cache: dict = field(default_factory=dict)

    def __repr__(self) -> str:
        return f"<{self.kind} {self.key}>"

    # -- canonical type ------------------------------------------------------------------------
    @property
    def type(self) -> str:
        if "type" not in self._cache:
            if self.kind == "face":
                self._cache["type"] = occt.face_type(self.shape)
            elif self.kind == "edge":
                m = self.body.body_metrics()
                s = max(1.0, geom.dist(tuple(m["bbox_min"]), tuple(m["bbox_max"])))
                self._cache["type"] = occt.edge_type(self.shape, CURVE_RECOGNITION_REL * s)
            else:
                self._cache["type"] = "vertex"
        return self._cache["type"]

    # -- size and centroid -----------------------------------------------------------------
    def _props(self):
        if "props" not in self._cache:
            p = GProp_GProps()
            if self.kind == "face":
                BRepGProp.SurfaceProperties_s(self.shape, p, False, False)
                self._cache["props"] = (p.Mass(), _v(p.CentreOfMass()))
            elif self.kind == "edge":
                BRepGProp.LinearProperties_s(self.shape, p, False, False)
                self._cache["props"] = (p.Mass(), _v(p.CentreOfMass()))
            else:
                self._cache["props"] = (0.0, _v(BRep_Tool.Pnt_s(self.shape)))
        return self._cache["props"]

    @property
    def size(self) -> float:
        return self._props()[0]

    @property
    def centroid(self) -> Vec3:
        return self._props()[1]

    # -- geometry ------------------------------------------------------------------------------
    def plane_normal(self) -> Vec3 | None:
        """Outward unit normal of a planar face."""
        if self.kind != "face" or self.type != "plane":
            return None
        if "pn" not in self._cache:
            self._cache["pn"] = outward_normal(self.shape, self.point())
        return self._cache["pn"]

    def plane_origin_offset(self) -> float:
        n = self.plane_normal()
        return geom.dot(n, self.point())

    def surface_axis(self) -> geom.Axis | None:
        """Cylinder / cone axis (sign-canonical direction, point closest to the origin)."""
        if self.kind != "face":
            return None
        ad = BRepAdaptor_Surface(self.shape, False)
        t = ad.GetType()
        if t == _ST.GeomAbs_Cylinder:
            ax = ad.Cylinder().Axis()
        elif t == _ST.GeomAbs_Cone:
            ax = ad.Cone().Axis()
        elif t == _ST.GeomAbs_SurfaceOfRevolution and self.type in ("cylinder", "cone"):
            ax = ad.AxeOfRevolution()
        else:
            return None
        d = geom.sign_canonical(geom.unit(_v(ax.Direction())))
        return geom.Axis(geom.closest_to_origin(_v(ax.Location()), d), d)

    def radius(self) -> float | None:
        if self.kind == "face":
            ad = BRepAdaptor_Surface(self.shape, False)
            t = ad.GetType()
            if t == _ST.GeomAbs_Cylinder:
                return ad.Cylinder().Radius()
            if t == _ST.GeomAbs_Sphere:
                return ad.Sphere().Radius()
            if t == _ST.GeomAbs_Torus:
                if self.type == "sphere":
                    return ad.Torus().MinorRadius()
                return ad.Torus().MinorRadius()
            if t == _ST.GeomAbs_SurfaceOfRevolution and ad.BasisCurve().GetType() == _CT.GeomAbs_Circle:
                if self.type in ("sphere", "torus"):
                    return ad.BasisCurve().Circle().Radius()
            return None
        if self.kind == "edge" and self.type == "circle":
            ad = BRepAdaptor_Curve(self.shape)
            if ad.GetType() == _CT.GeomAbs_Circle:
                return ad.Circle().Radius()
            if ad.GetType() == _CT.GeomAbs_Ellipse:
                return ad.Ellipse().MajorRadius()
        return None

    def line_direction(self) -> Vec3 | None:
        if self.kind != "edge" or self.type != "line":
            return None
        ad = BRepAdaptor_Curve(self.shape)
        if ad.GetType() == _CT.GeomAbs_Line:
            return geom.unit(_v(ad.Line().Direction()))
        a = _v(ad.Value(ad.FirstParameter()))
        b = _v(ad.Value(ad.LastParameter()))
        return geom.unit(geom.sub(b, a))

    def circle_axis(self) -> geom.Axis | None:
        if self.kind != "edge" or self.type != "circle":
            return None
        ad = BRepAdaptor_Curve(self.shape)
        if ad.GetType() == _CT.GeomAbs_Circle:
            c = ad.Circle()
        elif ad.GetType() == _CT.GeomAbs_Ellipse:
            c = ad.Ellipse()
        else:
            return None
        return geom.Axis(_v(c.Location()), geom.sign_canonical(geom.unit(_v(c.Axis().Direction()))))

    def edge_axis(self) -> geom.Axis | None:
        """§3.2 `{ edge }`: a line's line (point closest to the origin), a circle's axis."""
        d = self.line_direction()
        if d is not None:
            d = geom.sign_canonical(d)
            return geom.Axis(geom.closest_to_origin(self.point(), d), d)
        return self.circle_axis()

    # -- points --------------------------------------------------------------------------------
    def point(self) -> Vec3:
        """A point on the entity: the probe point (§7.6)."""
        if self.probe_point is not None:
            return self.probe_point
        if "pt" not in self._cache:
            if self.kind == "vertex":
                self._cache["pt"] = _v(BRep_Tool.Pnt_s(self.shape))
            elif self.kind == "edge":
                ad = BRepAdaptor_Curve(self.shape)
                self._cache["pt"] = _v(ad.Value(0.5 * (ad.FirstParameter() + ad.LastParameter())))
            else:
                self._cache["pt"] = face_interior_point(self.shape)
        return self._cache["pt"]

    def probe(self) -> dict:
        p = self.point()
        out: dict = {"kind": self.kind, "point": list(p)}
        if self.kind == "face":
            n = outward_normal(self.shape, p)
            if n is not None:
                out["normal"] = list(n)
        return out

    def edge_mid_tangent(self) -> tuple[Vec3, Vec3]:
        ad = BRepAdaptor_Curve(self.shape)
        t = 0.5 * (ad.FirstParameter() + ad.LastParameter())
        p = gp_Pnt()
        from OCP.gp import gp_Vec

        v = gp_Vec()
        ad.D1(t, p, v)
        return _v(p), geom.unit((v.X(), v.Y(), v.Z()))


def face_interior_point(face) -> Vec3:
    """A point inside a face, away from its boundary: the best of a UV grid classified IN, by
    3D distance to the face's boundary (deterministic)."""
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.BRepTools import BRepTools
    from OCP.gp import gp_Pnt2d
    from OCP.TopAbs import TopAbs_IN

    ad = BRepAdaptor_Surface(face, True)
    u0, u1, v0, v1 = BRepTools.UVBounds_s(face)
    wire_edges = []
    ex = TopExp_Explorer(face, TopAbs_EDGE)
    while ex.More():
        wire_edges.append(ex.Current())
        ex.Next()
    best, best_d = None, -1.0
    n = 12
    for i in range(n):
        for j in range(n):
            u = u0 + (u1 - u0) * (i + 0.5) / n
            v = v0 + (v1 - v0) * (j + 0.5) / n
            if BRepClass_FaceClassifier(face, gp_Pnt2d(u, v), 1e-9).State() != TopAbs_IN:
                continue
            p = _v(ad.Value(u, v))
            d = min((point_shape_distance(p, e) for e in wire_edges), default=math.inf)
            if d > best_d:
                best, best_d = p, d
    if best is None:
        c = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, c, False, False)
        best = _v(c.CentreOfMass())
    return best


# ---------------------------------------------------------------------------------------------
# Bodies
# ---------------------------------------------------------------------------------------------

@dataclass(eq=False)
class Body:
    solid: object
    feature: str  # origin feature id
    member: str  # origin member
    order: int  # timeline index of the origin feature (canonical order, §5.4)
    faces: list[Entity] = field(default_factory=list)
    edges: list[Entity] = field(default_factory=list)
    vertices: list[Entity] = field(default_factory=list)
    aliases: dict[str, str] = field(default_factory=dict)  # merged key → surviving key
    metrics: dict | None = None
    naming_error: str | None = None  # set when the oracle could not name the body's entities
    _cache: dict = field(default_factory=dict)

    def __repr__(self) -> str:
        return f"<body {self.feature}/{self.member}>"

    @property
    def origin(self) -> dict:
        return {"feature": self.feature, "member": self.member}

    @property
    def kind(self) -> str:
        return "body"

    @property
    def key(self) -> str:
        return f"{self.feature}/body@{self.member}"

    @property
    def size(self) -> float:
        return self.body_metrics()["volume"]

    @property
    def centroid(self) -> Vec3:
        return tuple(self.body_metrics()["centroid"])

    @property
    def type(self) -> str:
        return "body"

    def body_metrics(self) -> dict:
        if self.metrics is None:
            m = occt.body_metrics(self.solid, edge_recognition_rel=CURVE_RECOGNITION_REL)
            m["shells"] = count_shells(self.solid)
            self.metrics = m
        return self.metrics

    def point(self) -> Vec3:
        fs = sorted(self.faces, key=lambda f: f.key)
        return fs[0].point() if fs else self.centroid

    def probe(self) -> dict:
        fs = sorted(self.faces, key=lambda f: f.key)
        if not fs:
            return {"kind": "body", "point": list(self.centroid)}
        # §7.6: the probe of its face with the smallest key — with that face's outward normal, which
        # tells two touching bodies apart (the replay disambiguates such probes by it).
        p = fs[0].probe()
        return {"kind": "body", **{k: p[k] for k in ("point", "normal") if k in p}}

    def build_topology(self) -> None:
        """Faces, non-seam non-degenerate edges, and the vertices of the open ones."""
        fmap = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(self.solid, TopAbs_FACE, fmap)
        self.faces = [Entity("face", TopoDS.Face_s(fmap.FindKey(i)), self) for i in range(1, fmap.Extent() + 1)]
        # Use the faces as they appear in the solid (orientation matters for outward normals).
        ex = TopExp_Explorer(self.solid, TopAbs_FACE)
        oriented = {}
        while ex.More():
            f = TopoDS.Face_s(ex.Current())
            oriented.setdefault(fmap.FindIndex(f), f)
            ex.Next()
        for i, ent in enumerate(self.faces, start=1):
            ent.shape = oriented.get(i, ent.shape)
        anc = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(self.solid, TopAbs_EDGE, TopAbs_FACE, anc)
        self._cache["fmap"] = fmap
        edges = []
        edge_faces: list[list[int]] = []
        for i in range(1, anc.Extent() + 1):
            e = TopoDS.Edge_s(anc.FindKey(i))
            if BRep_Tool.Degenerated_s(e):
                continue
            fl = [fmap.FindIndex(f) for f in anc.FindFromIndex(i)]
            seam = any(BRep_Tool.IsClosed_s(e, TopoDS.Face_s(f)) for f in anc.FindFromIndex(i))
            if seam:
                continue
            edges.append(Entity("edge", e, self))
            edge_faces.append(sorted(set(fl)))
        self.edges = edges
        self._cache["edge_faces"] = edge_faces
        vmap = TopTools_IndexedMapOfShape()
        vertex_edges: dict[int, list[int]] = {}
        for ei, e in enumerate(edges):
            v1 = TopExp.FirstVertex_s(e.shape)
            v2 = TopExp.LastVertex_s(e.shape)
            if v1.IsSame(v2):
                continue  # a closed (ring) edge has no vertex in a seam-free topology
            for v in (v1, v2):
                k = vmap.Add(v)
                vertex_edges.setdefault(k, []).append(ei)
        self.vertices = [Entity("vertex", TopoDS.Vertex_s(vmap.FindKey(i)), self) for i in range(1, vmap.Extent() + 1)]
        self._cache["vertex_edges"] = [sorted(set(vertex_edges[i])) for i in range(1, vmap.Extent() + 1)]

    # -- adjacency -----------------------------------------------------------------------------
    def faces_of_edge(self, e: Entity) -> list[Entity]:
        i = self.edges.index(e)
        return [self.faces[k - 1] for k in self._cache["edge_faces"][i]]

    def edges_of_face(self, f: Entity) -> list[Entity]:
        k = self.faces.index(f) + 1
        return [e for i, e in enumerate(self.edges) if k in self._cache["edge_faces"][i]]

    def edges_of_vertex(self, v: Entity) -> list[Entity]:
        i = self.vertices.index(v)
        return [self.edges[k] for k in self._cache["vertex_edges"][i]]

    def faces_of_vertex(self, v: Entity) -> list[Entity]:
        out: list[Entity] = []
        for e in self.edges_of_vertex(v):
            for f in self.faces_of_edge(e):
                if f not in out:
                    out.append(f)
        return out

    def vertices_of_edge(self, e: Entity) -> list[Entity]:
        return [v for v in self.vertices if e in self.edges_of_vertex(v)]

    def vertices_of_face(self, f: Entity) -> list[Entity]:
        out: list[Entity] = []
        for e in self.edges_of_face(f):
            for v in self.vertices_of_edge(e):
                if v not in out:
                    out.append(v)
        return out

    # -- naming helpers ---------------------------------------------------------------------------
    def key_edges_and_vertices(self, feature: str, qualifier=None) -> None:
        """Edge keys from their faces (§5.2 rule 3) and vertex keys from theirs. `qualifier(e,
        ka, kb)` returns the `@c.end` qualifier of a side–side junction edge or None."""
        if self.naming_error:
            return
        for e in self.edges:
            fs = self.faces_of_edge(e)
            keys = sorted(f.key for f in fs)
            if len(keys) == 1:
                keys = keys * 2
            base = f"{feature}/edge:{{{keys[0]}|{keys[1]}}}"
            q = qualifier(e, keys[0], keys[1]) if qualifier is not None else None
            e.key = base + (f"@{q}" if q else "")
        for v in self.vertices:
            keys = sorted({f.key for f in self.faces_of_vertex(v)})
            v.key = f"{feature}/vertex:{{{'|'.join(keys)}}}"

    def assign_face_keys(self, targets: list[tuple[str, Vec3]]) -> None:
        """Give each face the key of the construction point nearest to it. The assignment must be
        a bijection between construction points and faces, each point within tol·s of its face;
        otherwise the body stays unnamed (`naming_error`): its geometry is still reported, and
        only a query that needs its keys fails (engine-internal, `ORACLE_NAMING_UNAVAILABLE`)."""
        scale = max(1.0, geom.dist(tuple(self.body_metrics()["bbox_min"]), tuple(self.body_metrics()["bbox_max"])))
        tol = 1e-6 * scale
        chosen: dict[int, tuple[str, Vec3]] = {}
        for key, p in targets:
            ds = sorted((point_shape_distance(p, f.shape), i) for i, f in enumerate(self.faces))
            if not ds or ds[0][0] > tol:
                self.naming_error = (f"no face of the OCCT body contains the construction point of {key} "
                                     f"(nearest at {ds[0][0] if ds else math.inf:.3g})")
                return
            if len(ds) > 1 and ds[1][0] - ds[0][0] <= 1e-12 * scale:
                self.naming_error = f"the construction point of {key} is equidistant from several faces"
                return
            if ds[0][1] in chosen:
                self.naming_error = f"faces keyed twice: {chosen[ds[0][1]][0]} and {key}"
                return
            chosen[ds[0][1]] = (key, p)
        if len(chosen) != len(self.faces):
            self.naming_error = (f"{len(self.faces) - len(chosen)} OCCT face(s) match no construction element "
                                 "of the SPEC sweep")
            return
        for i, (key, p) in chosen.items():
            self.faces[i].key = key
            self.faces[i].probe_point = p


def count_shells(solid) -> int:
    n = 0
    ex = TopExp_Explorer(solid, TopAbs_SHELL)
    while ex.More():
        n += 1
        ex.Next()
    return n


def body_report(b: Body, change: str | None = None) -> dict:
    m = b.body_metrics()
    out: dict = {"origin": b.origin}
    if change:
        out["change"] = change
    for k in ("volume", "area", "centroid", "bbox_min", "bbox_max", "faces", "edges", "shells",
              "face_types", "edge_types", "valid"):
        out[k] = m[k]
    return out


def canonical_bodies(bodies: list[Body]) -> list[Body]:
    """§5.4: by origin (timeline index of the origin feature, then member), then by centroid."""
    return sorted(bodies, key=lambda b: (b.order, b.member.encode(), tuple(round(c, 9) for c in b.centroid)))
