"""Query evaluation and reference resolution (SPEC-v1 §5.3–§5.8), computed by the oracle over its
own OCCT bodies and provenance keys (`topo.py`).

This is the oracle's *independent* evaluation of references (SPEC §8.1 "independent mode"):
named sources look entities up by the oracle's own keys, navigation uses OCCT adjacency, filters
and picks use the oracle's exact geometry. The replay check of Forge's resolved members lives in
`replay.py`.

Resolution (§5.7): step 1 evaluates the query (with per-member named/broad tracking; a named source
on a failed feature is `DEPENDENCY_FAILED`); a capture's named members are validated by key
(exact, merged through an alias, kind changed, split); a missing captured member would need the
geometric fallback of step 4, which the oracle does not implement yet (engine-internal
`ORACLE_REF_FALLBACK_UNSUPPORTED`, classified ROBUSTNESS); broad-set changes are
`REF_SET_CHANGED`; then the cardinality check of §5.5.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable

from . import geom
from .consts import LINEAR_TOLERANCE, QUERY_ANGLE_TOLERANCE, QUERY_SIZE_TIE_REL
from .geom import Vec3
from .topo import Body, Entity

TOL = LINEAR_TOLERANCE
SIN_QA = math.sin(QUERY_ANGLE_TOLERANCE)

DIR_NAMES = {
    "+X": ((1.0, 0.0, 0.0), True), "-X": ((-1.0, 0.0, 0.0), True),
    "+Y": ((0.0, 1.0, 0.0), True), "-Y": ((0.0, -1.0, 0.0), True),
    "+Z": ((0.0, 0.0, 1.0), True), "-Z": ((0.0, 0.0, -1.0), True),
    "X": ((1.0, 0.0, 0.0), False), "Y": ((0.0, 1.0, 0.0), False), "Z": ((0.0, 0.0, 1.0), False),
}


class RefFailure(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.details = details or {}


@dataclass
class FeatState:
    """What later queries need to know about an evaluated feature."""

    fid: str
    name: str
    type: str
    status: str  # ok / error / suppressed
    code: str | None = None
    message: str = ""
    ref: dict | None = None  # tags: the target Ref
    tag_kind: str | None = None
    curves: list | None = None  # sweeps: the (snapped) profile curves
    region_curves: dict[str, list[str]] = field(default_factory=dict)  # member → curve ids of its loops
    outer_curves: dict[str, list[str]] = field(default_factory=dict)  # member → outer-loop curve ids


@dataclass
class Scope:
    """The input state of a feature: the part's bodies and the earlier features."""

    bodies: list[Body]
    features: dict[str, FeatState]
    names: dict[str, str]  # feature id → name (display names)
    eval_scalar: Callable[[Any, str, str], float] | None = None  # (value, field type, path) → float
    resolve_axis: Callable[[dict, str], geom.Axis] | None = None

    _scale: float | None = None

    @property
    def scale(self) -> float:
        """§5.3: the diagonal of the scope's bounding box, at least 1."""
        if self._scale is None:
            if not self.bodies:
                self._scale = 1.0
            else:
                lo = [min(b.body_metrics()["bbox_min"][i] for b in self.bodies) for i in range(3)]
                hi = [max(b.body_metrics()["bbox_max"][i] for b in self.bodies) for i in range(3)]
                self._scale = max(1.0, geom.dist(tuple(lo), tuple(hi)))
        return self._scale

    def entities(self, kind: str) -> list:
        if kind == "body":
            return list(self.bodies)
        for b in self.bodies:
            unnamed(b)
        out = []
        for b in self.bodies:
            out.extend({"face": b.faces, "edge": b.edges, "vertex": b.vertices}[kind])
        return out

    def by_key(self, kind: str, pred: Callable[[str], bool]) -> list:
        out = []
        for e in self.entities(kind):
            k = e.key
            if pred(k) or any(pred(a) and b == k for a, b in e.body.aliases.items()):
                out.append(e)
        return out


def unnamed(b: Body) -> None:
    """Queries cannot look into a body the oracle could not name (engine-internal failure)."""
    if b.naming_error:
        raise RefFailure("ORACLE_NAMING_UNAVAILABLE",
                         f"the oracle could not name the entities of {b.feature}/{b.member}: {b.naming_error}",
                         {"origin": b.origin})


# A query result: ordered members with their named/broad flag.
Result = list[tuple[Any, bool]]


def _merge(parts: list[Result]) -> Result:
    seen: dict[int, int] = {}
    out: Result = []
    for r in parts:
        for e, named in r:
            if id(e) in seen:
                i = seen[id(e)]
                out[i] = (e, out[i][1] and named)
            else:
                seen[id(e)] = len(out)
                out.append((e, named))
    return out


def kind_of(e) -> str:
    return e.kind


class Evaluator:
    def __init__(self, scope: Scope):
        self.scope = scope

    # -- helpers --------------------------------------------------------------------------------
    def feature(self, fid: str, named: bool) -> FeatState | None:
        f = self.scope.features.get(fid)
        if f is None:
            return None
        if named and f.status == "error":
            raise RefFailure("DEPENDENCY_FAILED",
                             f"the query names feature {fid!r}, which failed with {f.code}",
                             {"feature": fid, "code": f.code, "message": f.message})
        return f

    def dir_vec(self, d: Any, path: str) -> tuple[Vec3, bool]:
        """(unit direction, signed?) of a Dir."""
        if isinstance(d, str):
            return DIR_NAMES[d]
        if isinstance(d, list):
            v = tuple(self.scope.eval_scalar(x, "ratio", f"{path}/{i}") for i, x in enumerate(d))
            if geom.norm(v) <= TOL:
                raise RefFailure("INVALID_VALUE", "a zero direction vector", {"field": path})
            return geom.unit(v), True
        ax = self.scope.resolve_axis(d, path)
        return ax.direction, True

    # -- evaluation -------------------------------------------------------------------------------
    def eval(self, q: dict, path: str) -> Result:
        op = q["op"]
        sc = self.scope
        if op == "body":
            f = self.feature(q["feature"], True)
            if f is None or f.status != "ok":
                return []
            bs = [b for b in sc.bodies if b.feature == q["feature"]]
            if "member" in q:
                bs = [b for b in bs if q["member"] in f.outer_curves.get(b.member, [])]
            return [(b, True) for b in bs]
        if op == "bodies":
            return [(b, False) for b in sc.bodies]
        if op in ("cap", "endcap"):
            f = self.feature(q["feature"], True)
            if f is None or f.status != "ok":
                return []
            members = [m for m, oc in f.outer_curves.items() if "member" not in q or q["member"] in oc]
            keys = {f"{q['feature']}/{op}:{q['end']}@{m}" for m in members}
            return [(e, True) for e in sc.by_key("face", lambda k: k in keys)]
        if op == "side":
            f = self.feature(q["feature"], True)
            if f is None or f.status != "ok":
                return []
            key = f"{q['feature']}/side:{q['curve']}"
            return [(e, True) for e in sc.by_key("face", lambda k: k == key)]
        if op == "sides":
            f = self.feature(q["feature"], False)
            if f is None or f.status != "ok":
                return []
            if "member" in q:
                curves = set()
                for m, oc in f.outer_curves.items():
                    if q["member"] in oc:
                        curves |= set(f.region_curves.get(m, []))
                keys = {f"{q['feature']}/side:{c}" for c in curves}
                return [(e, False) for e in sc.by_key("face", lambda k: k in keys)]
            pre = f"{q['feature']}/side:"
            return [(e, False) for e in sc.by_key("face", lambda k: k.startswith(pre))]
        if op == "edge_at":
            f = self.feature(q["feature"], True)
            if f is None or f.status != "ok" or not f.curves:
                return []
            from .sweeps import vertex_names

            c = next((c for c in f.curves if c.id == q["curve"]), None)
            if c is None or not hasattr(c, "start"):
                return []
            pt = c.start if q["end"] == "start" else c.end
            names = vertex_names(f.curves, pt)
            if not names:
                return []
            qual = "@" + min(names, key=lambda s: s.encode())
            pre = f"{q['feature']}/edge:"
            return [(e, True) for e in sc.by_key("edge", lambda k: k.startswith(pre) and k.endswith(qual))]
        if op == "between":
            ra = self.eval(q["a"], f"{path}/a")
            rb = self.eval(q["b"], f"{path}/b")
            named = all(n for _, n in ra) and all(n for _, n in rb) and bool(ra) and bool(rb)
            fa = {id(e) for e, _ in ra}
            fb = {id(e) for e, _ in rb}
            out = []
            for e in sc.entities("edge"):
                fs = e.body.faces_of_edge(e)
                if len(fs) != 2:
                    continue
                x, y = id(fs[0]), id(fs[1])
                if (x in fa and y in fb) or (x in fb and y in fa):
                    out.append((e, named))
            return out
        if op == "hole_face":
            f = self.feature(q["feature"], True)
            if f is None or f.status != "ok":
                return []
            key = f"{q['feature']}/{q['part']}@{q['at']}"
            return [(e, True) for e in sc.by_key("face", lambda k: k == key)]
        if op == "created":
            f = self.feature(q["feature"], False)
            if f is None:
                return []
            pre = f"{q['feature']}/"

            def ok(k: str) -> bool:
                if not k.startswith(pre):
                    return False
                if "role" not in q:
                    return True
                rest = k[len(pre):]
                label = rest.split(":", 1)[0].split("@", 1)[0]
                return label == q["role"]

            return [(e, False) for e in sc.by_key("face", ok)]
        if op == "instance":
            f = self.feature(q["feature"], False)
            if f is None or f.status != "ok":
                return []
            idx = ".".join(str(i) for i in q["index"])
            pre = f"{q['feature']}/copy:"
            return [(e, False) for e in sc.by_key("face", lambda k: k.startswith(pre) and k.endswith(f"@{idx}"))]
        if op == "tagged":
            f = self.feature(q["feature"], False)
            if f is None or f.status == "suppressed" or f.ref is None:
                return []
            if f.status == "error":
                raise RefFailure("DEPENDENCY_FAILED", f"tag {q['feature']!r} failed with {f.code}",
                                 {"feature": q["feature"], "code": f.code, "message": f.message})
            return self.eval(f.ref["q"], f"{path}")
        if op in ("faces", "edges", "vertices", "owner"):
            src = self.eval(q["of"], f"{path}/of")
            out: list = []
            for e, _ in src:
                out.extend(self.navigate(op, e))
            return _merge([[(x, False) for x in out]])
        if op == "union":
            return _merge([self.eval(sub, f"{path}/of/{i}") for i, sub in enumerate(q["of"])])
        if op == "intersect":
            parts = [self.eval(sub, f"{path}/of/{i}") for i, sub in enumerate(q["of"])]
            keep = set.intersection(*[{id(e) for e, _ in p} for p in parts]) if parts else set()
            return [(e, n) for e, n in _merge(parts) if id(e) in keep]
        if op == "minus":
            a = self.eval(q["a"], f"{path}/a")
            b = {id(e) for e, _ in self.eval(q["b"], f"{path}/b")}
            return [(e, n) for e, n in a if id(e) not in b]
        if op == "filter":
            src = self.eval(q["of"], f"{path}/of")
            return [(e, n) for e, n in src if self.predicate(q["where"], e, f"{path}/where")]
        if op == "extreme":
            src = self.eval(q["of"], f"{path}/of")
            if not src:
                return []
            d, _signed = self.dir_vec(q["dir"], f"{path}/dir")
            vals = [geom.dot(e.centroid, d) for e, _ in src]
            best = max(vals) if q["which"] == "max" else min(vals)
            tol = TOL * sc.scale
            return [(e, n) for (e, n), v in zip(src, vals) if abs(v - best) <= tol]
        if op in ("largest", "smallest"):
            src = self.eval(q["of"], f"{path}/of")
            if not src:
                return []
            sizes = [e.size for e, _ in src]
            best = max(sizes) if op == "largest" else min(sizes)
            tol = QUERY_SIZE_TIE_REL * max(abs(best), 1e-300)
            return [(e, n) for (e, n), s in zip(src, sizes) if abs(s - best) <= tol]
        raise RefFailure("QUERY_INVALID", f"unknown query op {op!r}", {"path": path})

    def navigate(self, op: str, e) -> list:
        k = e.kind
        if op != "owner":
            unnamed(e if k == "body" else e.body)
        if op == "owner":
            return [e] if k == "body" else [e.body]
        if op == "faces":
            if k == "body":
                return list(e.faces)
            if k == "edge":
                return e.body.faces_of_edge(e)
            return e.body.faces_of_vertex(e)
        if op == "edges":
            if k == "body":
                return list(e.edges)
            if k == "face":
                return e.body.edges_of_face(e)
            return e.body.edges_of_vertex(e)
        if k == "body":
            return list(e.vertices)
        if k == "face":
            return e.body.vertices_of_face(e)
        return e.body.vertices_of_edge(e)

    # -- predicates -------------------------------------------------------------------------------
    def predicate(self, p: dict, e, path: str) -> bool:
        (name, val), = p.items()
        t = e.type
        if name == "type":
            return t == val
        if name == "normal":
            d, _ = self.dir_vec(val, f"{path}/normal")
            n = e.plane_normal() if e.kind == "face" else None
            return n is not None and geom.angle_between(n, d) <= QUERY_ANGLE_TOLERANCE
        if name in ("parallel", "perpendicular"):
            d, _ = self.dir_vec(val, f"{path}/{name}")
            return self._orient(name, e, d)
        if name in ("convex", "concave", "smooth"):
            if e.kind != "edge":
                return False
            a = material_angle(e)
            if a is None:
                return False
            if name == "convex":
                return a < math.pi - QUERY_ANGLE_TOLERANCE
            if name == "concave":
                return a > math.pi + QUERY_ANGLE_TOLERANCE
            return abs(a - math.pi) <= QUERY_ANGLE_TOLERANCE
        if name == "radius":
            if not ((e.kind == "face" and t in ("cylinder", "sphere", "torus")) or (e.kind == "edge" and t == "circle")):
                return False
            r = e.radius()
            if r is None:
                return False
            if "eq" in val:
                return abs(r - self.scope.eval_scalar(val["eq"], "length", f"{path}/radius/eq")) <= TOL
            lo = self.scope.eval_scalar(val["min"], "length", f"{path}/radius/min") if "min" in val else -math.inf
            hi = self.scope.eval_scalar(val["max"], "length", f"{path}/radius/max") if "max" in val else math.inf
            return lo <= r <= hi
        return False

    @staticmethod
    def _parallel(a: Vec3, b: Vec3) -> bool:
        return geom.norm(geom.cross(a, b)) <= SIN_QA

    @staticmethod
    def _perp(a: Vec3, b: Vec3) -> bool:
        return abs(geom.dot(a, b)) <= SIN_QA

    def _orient(self, name: str, e, d: Vec3) -> bool:
        if e.kind == "edge":
            ld = e.line_direction()
            if name == "parallel":
                return ld is not None and self._parallel(ld, d)
            if ld is not None:
                return self._perp(ld, d)
            ca = e.circle_axis()
            return ca is not None and self._parallel(ca.direction, d)
        if e.kind != "face":
            return False
        n = e.plane_normal()
        if name == "parallel":
            if n is not None:
                return self._perp(n, d)
            ax = e.surface_axis()
            return ax is not None and e.type in ("cylinder", "cone") and self._parallel(ax.direction, d)
        return n is not None and self._parallel(n, d)


def into_face_sign(edge, face, w: Vec3) -> int | None:
    """+1 if the 3D direction `w` (tangent to `face`, perpendicular to `edge`) points into the
    face at the edge's parametric midpoint, -1 if it points out of it, None if inconclusive.

    Decided in the face's parametric frame, not with a fixed 3D step: `w` is expressed in (u, v)
    through the surface derivatives at the edge's p-curve midpoint, and the two points at ±`w`
    a step of `UV_STEP_REL` of the face's own UV extent away are classified with OCCT's 2D face
    classifier. A face narrower than any fixed 3D step is therefore still oriented correctly."""
    try:
        from OCP.BRepAdaptor import BRepAdaptor_Curve2d, BRepAdaptor_Surface
        from OCP.BRepTopAdaptor import BRepTopAdaptor_FClass2d
        from OCP.gp import gp_Pnt, gp_Pnt2d, gp_Vec, gp_Vec2d
        from OCP.TopAbs import TopAbs_IN
        from OCP.TopoDS import TopoDS

        f = TopoDS.Face_s(face)
        c2 = BRepAdaptor_Curve2d(TopoDS.Edge_s(edge), f)
        t = 0.5 * (c2.FirstParameter() + c2.LastParameter())
        uv, duv = gp_Pnt2d(), gp_Vec2d()
        c2.D1(t, uv, duv)
        sa = BRepAdaptor_Surface(f, True)
        du = sa.LastUParameter() - sa.FirstUParameter()
        dv = sa.LastVParameter() - sa.FirstVParameter()
        if not (math.isfinite(du) and math.isfinite(dv) and du > 0.0 and dv > 0.0):
            return None
        P, Su, Sv = gp_Pnt(), gp_Vec(), gp_Vec()
        sa.D1(uv.X(), uv.Y(), P, Su, Sv)
        su, sv = (Su.X(), Su.Y(), Su.Z()), (Sv.X(), Sv.Y(), Sv.Z())
        a11, a12, a22 = geom.dot(su, su), geom.dot(su, sv), geom.dot(sv, sv)
        b1, b2 = geom.dot(su, w), geom.dot(sv, w)
        det = a11 * a22 - a12 * a12
        if not det > 0.0:
            return None
        a, b = (b1 * a22 - b2 * a12) / det, (a11 * b2 - a12 * b1) / det  # w ≈ a·Su + b·Sv
        m = max(abs(a) / du, abs(b) / dv)
        if not m > 0.0:
            return None
        h = UV_STEP_REL / m  # the UV step moves ≤ UV_STEP_REL of the face's extent on each axis
        cls = BRepTopAdaptor_FClass2d(f, 1e-12 * max(du, dv))
        fwd = cls.Perform(gp_Pnt2d(uv.X() + a * h, uv.Y() + b * h)) == TopAbs_IN
        bwd = cls.Perform(gp_Pnt2d(uv.X() - a * h, uv.Y() - b * h)) == TopAbs_IN
    except Exception:
        return None
    if fwd != bwd:
        return 1 if fwd else -1
    return None


#: The parametric step of `into_face_sign`, relative to the face's UV extent.
UV_STEP_REL = 1e-5


def material_angle(e: Entity) -> float | None:
    """The material angle across an edge at its parametric midpoint (radians, in (0, 2π))."""
    faces = e.body.faces_of_edge(e)
    if len(faces) != 2:
        return None
    p, t = e.edge_mid_tangent()
    from .topo import outward_normal, point_shape_distance

    ws = []
    ns = []
    for f in faces:
        n = outward_normal(f.shape, p)
        if n is None:
            return None
        w = geom.cross(n, t)  # in the face's tangent plane, perpendicular to the edge
        # orient w into the face: decided in the face's parametric frame; the fixed 3D step
        # (1e-4·s) is only a fallback when the parametric test is inconclusive
        sign = into_face_sign(e.shape, f.shape, w)
        if sign is None:
            m = e.body.body_metrics()
            step = 1e-4 * max(1.0, geom.dist(tuple(m["bbox_min"]), tuple(m["bbox_max"])))
            fwd = point_shape_distance(geom.add(p, geom.mul(geom.unit(w), step)), f.shape)
            bwd = point_shape_distance(geom.add(p, geom.mul(geom.unit(w), -step)), f.shape)
            sign = -1 if fwd > bwd else 1
        if sign < 0:
            w = geom.mul(w, -1.0)
        ws.append(geom.unit(w))
        ns.append(n)
    ang = geom.angle_between(ws[0], ws[1])
    # Convex when the second face's inward direction points below the first face (into material).
    if geom.dot(ns[0], ws[1]) < 0:
        return ang
    return 2.0 * math.pi - ang


# ---------------------------------------------------------------------------------------------
# Resolution (§5.7) and the report entry (§5.8)
# ---------------------------------------------------------------------------------------------

def display_name(key: str, names: dict[str, str]) -> str:
    """Feature ids → current names (the key grammar keeps ids at segment starts)."""
    out = []
    i = 0
    while i < len(key):
        j = i
        while j < len(key) and (key[j].isalnum() or key[j] == "_"):
            j += 1
        tok = key[i:j]
        if tok and j < len(key) and key[j] == "/" and tok in names and (i == 0 or key[i - 1] in "{|"):
            out.append(names[tok])
        else:
            out.append(tok)
        if j < len(key):
            out.append(key[j])
        i = j + 1 if j < len(key) else j
    return "".join(out)


def canonical_order(members: list[tuple[Any, bool]], scale: float) -> list[tuple[Any, bool]]:
    """§5.4: faces/edges/vertices by key then probe point; bodies by origin then centroid."""
    tol = TOL * scale

    def qp(p):
        return tuple(round(c / tol) for c in p) if tol > 0 else tuple(p)

    def key(m):
        e = m[0]
        if e.kind == "body":
            return (e.order, e.member.encode(), qp(e.centroid))
        return (0, e.key.encode(), qp(e.point()))

    return sorted(members, key=key)


def check_card(card: Any, members: list, same_key: bool) -> tuple[str, dict] | None:
    n = len(members)
    if card == "one":
        if n == 0:
            return "REF_MISSING", {"expected": "one", "found": 0}
        if n >= 2:
            return ("REF_SPLIT" if same_key else "REF_AMBIGUOUS"), {"expected": "one", "found": n}
        return None
    if card == "some":
        return ("REF_MISSING", {"expected": "some", "found": 0}) if n == 0 else None
    if card == "any":
        return None
    if n != card:
        return "REF_CARDINALITY", {"expected": card, "found": n}
    return None


@dataclass
class Resolution:
    members: list  # entities in canonical order
    entry: dict  # the `refs` report entry
    warnings: list[dict]
    failure: RefFailure | None


def resolve(ref: dict, default_card: Any, field_path: str, scope: Scope) -> Resolution:
    card = ref.get("card", default_card)
    entry: dict = {"field": field_path, "status": "exact", "members": []}
    warnings: list[dict] = []
    ev = Evaluator(scope)
    try:
        result = ev.eval(ref["q"], f"{field_path}/q")
    except RefFailure as f:
        entry["status"] = "failed"
        entry["code"] = f.code
        return Resolution([], entry, warnings, f)
    result = canonical_order(result, scope.scale)
    statuses = {id(e): "exact" for e, _ in result}
    cap = ref.get("capture")
    if cap:
        keys_now = {}
        for e, n in result:
            keys_now.setdefault(e.key, []).append((e, n))
        for m in cap.get("members", []):
            if m.get("via") != "named":
                continue
            found = keys_now.get(m["key"], [])
            if not found:
                aliased = [(e, n) for e, n in result if e.body.aliases.get(m["key"]) == e.key] if result and result[0][0].kind != "body" else []
                if aliased:
                    for e, _ in aliased:
                        statuses[id(e)] = "merged"
                    warnings.append({"code": "REF_MERGED", "severity": "info",
                                     "message": f"{m['key']} was merged", "details": {"field": field_path, "key": m["key"], "into": aliased[0][0].key}})
                    continue
                f = RefFailure("ORACLE_REF_FALLBACK_UNSUPPORTED",
                               f"captured member {m['key']} is gone; the oracle does not implement the "
                               "geometric fallback of SPEC §5.7 step 4 yet", {"field": field_path, "key": m["key"]})
                entry["status"] = "failed"
                entry["code"] = f.code
                return Resolution([], entry, warnings, f)
            was = m.get("geom", {}).get("type")
            if len(found) == 1 and was and found[0][0].type != was and was not in ("vertex", "body"):
                statuses[id(found[0][0])] = "kind_changed"
                warnings.append({"code": "REF_KIND_CHANGED", "severity": "warning",
                                 "message": f"{m['key']} changed from {was} to {found[0][0].type}",
                                 "details": {"field": field_path, "key": m["key"], "was": was, "now": found[0][0].type}})
            if len(found) >= 2:
                for e, _ in found:
                    statuses[id(e)] = "split"
                if card == "one":
                    f = RefFailure("REF_SPLIT", f"{m['key']} was split into {len(found)} pieces",
                                   {"field": field_path, "key": m["key"], "pieces": len(found)})
                    entry["status"] = "failed"
                    entry["code"] = f.code
                    return Resolution([], entry, warnings, f)
                warnings.append({"code": "REF_SPLIT_ACCEPTED", "severity": "info",
                                 "message": f"{m['key']} was split into {len(found)} pieces",
                                 "details": {"field": field_path, "key": m["key"], "pieces": len(found)}})
        cap_broad = {m["key"] for m in cap.get("members", []) if m.get("via") == "broad"}
        now_broad = {e.key for e, n in result if not n}
        added, removed = sorted(now_broad - cap_broad), sorted(cap_broad - now_broad)
        if added or removed:
            entry["added"], entry["removed"] = added, removed
            warnings.append({"code": "REF_SET_CHANGED", "severity": "warning",
                             "message": "the broad members of the reference changed",
                             "details": {"field": field_path, "added": added, "removed": removed}})
    members = [e for e, _ in result]
    same_key = len({e.key for e in members}) == 1 and len(members) > 1
    bad = check_card(card, members, same_key)
    entry["members"] = [
        {"key": e.key, "name": display_name(e.key, scope.names), "via": "named" if n else "broad",
         "status": statuses[id(e)], "probe": e.probe()}
        for e, n in result
    ]
    if bad is not None:
        code, det = bad
        f = RefFailure(code, f"{field_path}: expected {det['expected']} entities, found {det['found']}",
                       {"field": field_path, **det, "unresolved": []})
        entry["status"] = "failed"
        entry["code"] = code
        return Resolution(members, entry, warnings, f)
    if warnings:
        entry["status"] = "accepted"
    return Resolution(members, entry, warnings, None)
