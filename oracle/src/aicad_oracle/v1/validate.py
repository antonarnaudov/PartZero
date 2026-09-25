"""Structural validation of IR v1 documents (SPEC-v1 §0.5 rule 1, every **R** code of §7.5), a
port of W0's frozen rules (`forge_ir::v1::validate`), plus the oracle's own expression checker
in place of W1's hook (§0.5 rule 4 step 5): syntax, names, functions, arity, units, types, scope
(`EXPR_SCOPE`) and parameter cycles (`PARAM_CYCLE`).

Input is a JSON value that already passed the raw pre-checks and `ir-v1.schema.json`. Every
problem is returned (not just the first); the set of `{code, path}` is normative, the order is
not ([W0-1]).

The module also exports the Scalar **site walker** (`sites`): every expression and literal of a
document with its JSON pointer, field type (§2.2) and scope (§2.8). Evaluation uses it to decide
`PARAM_FAILED` and to evaluate feature fields.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from . import consts, expr
from .consts import IR_SCHEMA, IR_SCHEMA_V0, LINEAR_TOLERANCE, MAX_EXPR_BYTES
from .ids import byte_len, check_id, check_ref, is_ref, shown
from .precheck import Problem

TOL = LINEAR_TOLERANCE


def _tol() -> str:
    return "> 0.000001"


def lit(s: Any) -> float | None:
    """The literal value of a Scalar, or None for an expression."""
    if isinstance(s, bool) or not isinstance(s, (int, float)):
        return None
    return float(s)


def lit2(p: Any) -> tuple[float, float] | None:
    a, b = lit(p[0]), lit(p[1])
    return None if a is None or b is None else (a, b)


def lit3(p: Any) -> tuple[float, float, float] | None:
    a, b, c = lit(p[0]), lit(p[1]), lit(p[2])
    return None if a is None or b is None or c is None else (a, b, c)


def _dist2(a, b) -> float:
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)


def _len3(v) -> float:
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


# ---------------------------------------------------------------------------------------------
# The Scalar site walker (SPEC-v1 §2.2; W0's `expr_sites` / `literal_sites`)
# ---------------------------------------------------------------------------------------------

@dataclass
class Site:
    path: str
    field: str  # length / angle / ratio / count / bool
    scope: int | None  # None = document, else the part index
    owner: tuple  # ("param", part index or None, name) or ("feature", part index, feature index)
    text: str | None = None  # an expression
    value: float | None = None  # a literal

    @property
    def is_expr(self) -> bool:
        return self.text is not None


class Walker:
    def __init__(self):
        self.sites: list[Site] = []
        self.owner: tuple = ()
        self.scope: int | None = None

    def s(self, path: str, v: Any, fld: str) -> None:
        if isinstance(v, str):
            self.sites.append(Site(path, fld, self.scope, self.owner, text=v))
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            self.sites.append(Site(path, fld, self.scope, self.owner, value=float(v)))

    def b(self, path: str, v: Any) -> None:
        if isinstance(v, str):
            self.sites.append(Site(path, "bool", self.scope, self.owner, text=v))

    def p2(self, path: str, v: Any, fld: str) -> None:
        for i in range(2):
            self.s(f"{path}/{i}", v[i], fld)

    def p3(self, path: str, v: Any, fld: str) -> None:
        for i in range(3):
            self.s(f"{path}/{i}", v[i], fld)

    def opt(self, path: str, d: dict, key: str, fld: str) -> None:
        if key in d:
            self.s(f"{path}/{key}", d[key], fld)

    def document(self, doc: dict) -> "Walker":
        for i, p in enumerate(doc.get("params", [])):
            self.param(f"/params/{i}", p, None)
        for pi, part in enumerate(doc["parts"]):
            for i, p in enumerate(part.get("params", [])):
                self.param(f"/parts/{pi}/params/{i}", p, pi)
            for fi, f in enumerate(part["features"]):
                self.feature(pi, fi, f)
        return self

    def param(self, pp: str, p: dict, part: int | None) -> None:
        self.owner = ("param", part, p["name"])
        self.scope = part
        fld = expr.UNIT_FIELD[p["unit"]]
        v = p["value"]
        if isinstance(v, str):
            self.sites.append(Site(f"{pp}/value", fld, part, self.owner, text=v))
        elif not isinstance(v, bool):
            self.sites.append(Site(f"{pp}/value", fld, part, self.owner, value=float(v)))
        if p["unit"] != "bool":
            self.opt(pp, p, "min", fld)
            self.opt(pp, p, "max", fld)

    def feature(self, pi: int, fi: int, f: dict) -> None:
        fp = f"/parts/{pi}/features/{fi}"
        self.owner = ("feature", pi, fi)
        self.scope = pi
        if "suppressed" in f:
            self.b(f"{fp}/suppressed", f["suppressed"])
        t = f["type"]
        if t == "sketch":
            self.plane(f"{fp}/plane", f["plane"])
            for ci, c in enumerate(f["curves"]):
                self.curve(f"{fp}/curves/{ci}", c)
            for k, c in enumerate(f.get("constraints", [])):
                kp = f"{fp}/constraints/{k}"
                ct = c["type"]
                if ct in ("distance", "radius", "diameter"):
                    self.opt(kp, c, "value", "length")
                elif ct == "angle":
                    self.opt(kp, c, "value", "angle")
                elif ct == "fix":
                    self.opt(kp, c, "x", "length")
                    self.opt(kp, c, "y", "length")
        elif t == "extrude":
            if "distance" in f:
                self.s(f"{fp}/distance", f["distance"], "length")
            ext = f.get("extent")
            if isinstance(ext, dict) and "up_to" in ext:
                self.plane(f"{fp}/extent/up_to", ext["up_to"])
            self.targets(f"{fp}/targets", f.get("targets"))
        elif t == "revolve":
            self.p2(f"{fp}/axis/origin", f["axis"]["origin"], "length")
            self.p2(f"{fp}/axis/direction", f["axis"]["direction"], "ratio")
            self.s(f"{fp}/angle", f["angle"], "angle")
            self.targets(f"{fp}/targets", f.get("targets"))
        elif t == "boolean":
            self.r(f"{fp}/targets", f["targets"])
            self.r(f"{fp}/tools", f["tools"])
            if "keep_tools" in f:
                self.b(f"{fp}/keep_tools", f["keep_tools"])
        elif t == "transform":
            self.r(f"{fp}/bodies", f["bodies"])
            if "translate" in f:
                self.p3(f"{fp}/translate", f["translate"], "length")
            if isinstance(f.get("rotate"), dict):
                self.axis(f"{fp}/rotate/axis", f["rotate"]["axis"])
                self.s(f"{fp}/rotate/angle", f["rotate"]["angle"], "angle")
            if "copy" in f:
                self.b(f"{fp}/copy", f["copy"])
        elif t == "hole":
            self.hole(fp, f)
        elif t == "fillet":
            self.r(f"{fp}/edges", f["edges"])
            self.s(f"{fp}/r", f["r"], "length")
            if "tangent_chain" in f:
                self.b(f"{fp}/tangent_chain", f["tangent_chain"])
        elif t == "chamfer":
            self.r(f"{fp}/edges", f["edges"])
            self.s(f"{fp}/d", f["d"], "length")
            self.opt(fp, f, "d2", "length")
            self.opt(fp, f, "angle", "angle")
            if "side" in f:
                self.r(f"{fp}/side", f["side"])
            if "tangent_chain" in f:
                self.b(f"{fp}/tangent_chain", f["tangent_chain"])
        elif t == "shell":
            self.r(f"{fp}/body", f["body"])
            if "open" in f:
                self.r(f"{fp}/open", f["open"])
            self.s(f"{fp}/thickness", f["thickness"], "length")
        elif t == "draft":
            self.r(f"{fp}/faces", f["faces"])
            self.plane(f"{fp}/neutral", f["neutral"])
            self.s(f"{fp}/angle", f["angle"], "angle")
        elif t == "pattern":
            seed = f["seed"]
            if "bodies" in seed:
                self.r(f"{fp}/seed/bodies", seed["bodies"])
            lay = f["layout"]
            if "linear" in lay:
                lp, l = f"{fp}/layout/linear", lay["linear"]
                self.dir(f"{lp}/dir", l["dir"])
                self.s(f"{lp}/count", l["count"], "count")
                self.s(f"{lp}/spacing", l["spacing"], "length")
                if "dir2" in l:
                    self.dir(f"{lp}/dir2", l["dir2"])
                self.opt(lp, l, "count2", "count")
                self.opt(lp, l, "spacing2", "length")
            elif "circular" in lay:
                cp, c = f"{fp}/layout/circular", lay["circular"]
                self.axis(f"{cp}/axis", c["axis"])
                self.s(f"{cp}/count", c["count"], "count")
                if "angle" in c:
                    self.s(f"{cp}/angle", c["angle"], "angle")
            else:
                self.plane(f"{fp}/layout/mirror/plane", lay["mirror"]["plane"])
            self.targets(f"{fp}/targets", f.get("targets"))
        elif t == "datum_plane":
            if "from" in f:
                self.plane(f"{fp}/from", f["from"])
            self.opt(fp, f, "distance", "length")
            if "axis" in f:
                self.axis(f"{fp}/axis", f["axis"])
            self.opt(fp, f, "angle", "angle")
            for k in ("a", "b"):
                if k in f:
                    self.plane(f"{fp}/{k}", f[k])
            for k, p in enumerate(f.get("points", [])):
                self.point(f"{fp}/points/{k}", p)
            if "origin" in f:
                self.p3(f"{fp}/origin", f["origin"], "length")
            if "normal" in f:
                self.p3(f"{fp}/normal", f["normal"], "ratio")
            if "x_dir" in f:
                self.p3(f"{fp}/x_dir", f["x_dir"], "ratio")
        elif t == "datum_axis":
            if "edge" in f:
                self.r(f"{fp}/edge", f["edge"])
            if "face" in f:
                self.r(f"{fp}/face", f["face"])
            for k in ("a", "b"):
                if k in f:
                    self.plane(f"{fp}/{k}", f[k])
            for k, p in enumerate(f.get("points", [])):
                self.point(f"{fp}/points/{k}", p)
            if "flip" in f:
                self.b(f"{fp}/flip", f["flip"])
        elif t == "tag":
            self.r(f"{fp}/target", f["target"])

    def hole(self, fp: str, h: dict) -> None:
        self.plane(f"{fp}/on", h["on"])
        if "flip" in h:
            self.b(f"{fp}/flip", h["flip"])
        at = h["at"]
        if "list" in at:
            for k, p in enumerate(at["list"]):
                self.p2(f"{fp}/at/list/{k}/at", p["at"], "length")
        elif "grid" in at:
            gp, g = f"{fp}/at/grid", at["grid"]
            self.s(f"{gp}/nx", g["nx"], "count")
            self.s(f"{gp}/ny", g["ny"], "count")
            self.s(f"{gp}/dx", g["dx"], "length")
            self.s(f"{gp}/dy", g["dy"], "length")
            self.p2(f"{gp}/center", g.get("center", [0.0, 0.0]), "length")
        elif "circle" in at:
            cp, c = f"{fp}/at/circle", at["circle"]
            self.s(f"{cp}/n", c["n"], "count")
            self.s(f"{cp}/d", c["d"], "length")
            self.p2(f"{cp}/center", c.get("center", [0.0, 0.0]), "length")
            self.s(f"{cp}/start", c.get("start", 0.0), "angle")
        self.opt(fp, h, "d", "length")
        depth = h.get("depth")
        if isinstance(depth, dict) and "blind" in depth:
            self.s(f"{fp}/depth/blind", depth["blind"], "length")
        elif isinstance(depth, dict) and "up_to" in depth:
            self.r(f"{fp}/depth/up_to", depth["up_to"])
        tip = h.get("tip", 118.0)
        if tip != "flat":
            self.s(f"{fp}/tip", tip, "angle")
        for key, fields in (("cbore", ("d", "depth")), ("insert", ("d", "depth"))):
            v = h.get(key)
            if isinstance(v, dict):
                for k in fields:
                    self.s(f"{fp}/{key}/{k}", v[k], "length")
        cs = h.get("csink")
        if isinstance(cs, dict):
            self.s(f"{fp}/csink/d", cs["d"], "length")
            self.s(f"{fp}/csink/angle", cs.get("angle", 90.0), "angle")
        th = h.get("thread")
        if isinstance(th, dict):
            self.opt(f"{fp}/thread", th, "pitch", "length")
            self.opt(f"{fp}/thread", th, "depth", "length")
        self.targets(f"{fp}/targets", h.get("targets"))

    def curve(self, cp: str, c: dict) -> None:
        k = c["kind"]
        if k == "line":
            self.p2(f"{cp}/start", c["start"], "length")
            self.p2(f"{cp}/end", c["end"], "length")
        elif k == "arc":
            self.p2(f"{cp}/start", c["start"], "length")
            self.p2(f"{cp}/end", c["end"], "length")
            self.p2(f"{cp}/center", c["center"], "length")
        elif k == "circle":
            self.p2(f"{cp}/center", c["center"], "length")
            self.s(f"{cp}/radius", c["radius"], "length")
        elif k == "point":
            self.p2(f"{cp}/at", c["at"], "length")
        elif k == "rect":
            if "center" in c:
                self.p2(f"{cp}/center", c["center"], "length")
            if "corner" in c:
                self.p2(f"{cp}/corner", c["corner"], "length")
            self.s(f"{cp}/w", c["w"], "length")
            self.s(f"{cp}/h", c["h"], "length")
            self.s(f"{cp}/r", c.get("r", 0.0), "length")
        elif k == "slot":
            self.p2(f"{cp}/a", c["a"], "length")
            self.p2(f"{cp}/b", c["b"], "length")
            self.s(f"{cp}/w", c["w"], "length")
        elif k == "polygon":
            self.p2(f"{cp}/center", c["center"], "length")
            self.s(f"{cp}/n", c["n"], "count")
            for key in ("circumradius", "inradius", "across_flats", "side"):
                self.opt(cp, c, key, "length")
            self.s(f"{cp}/rotation", c.get("rotation", 0.0), "angle")

    def targets(self, path: str, t: Any) -> None:
        if isinstance(t, dict):
            self.r(path, t)

    def plane(self, path: str, p: Any) -> None:
        if not isinstance(p, dict) or "datum" in p:
            return
        if "face" in p:
            self.r(f"{path}/face", p["face"])
            if "origin" in p:
                self.p3(f"{path}/origin", p["origin"], "length")
            if "x_dir" in p:
                self.p3(f"{path}/x_dir", p["x_dir"], "ratio")
            return
        self.p3(f"{path}/origin", p["origin"], "length")
        self.p3(f"{path}/normal", p["normal"], "ratio")
        self.p3(f"{path}/x_dir", p["x_dir"], "ratio")

    def axis(self, path: str, a: Any) -> None:
        if isinstance(a, dict):
            self.axis_object(path, a)

    def axis_object(self, path: str, o: dict) -> None:
        if "edge" in o:
            self.r(f"{path}/edge", o["edge"])
        elif "cylinder" in o:
            self.r(f"{path}/cylinder", o["cylinder"])
        elif "line" in o:
            self.p3(f"{path}/line/origin", o["line"]["origin"], "length")
            self.p3(f"{path}/line/direction", o["line"]["direction"], "ratio")
        if "flip" in o:
            self.b(f"{path}/flip", o["flip"])

    def point(self, path: str, p: Any) -> None:
        if isinstance(p, list):
            self.p3(path, p, "length")
        else:
            self.r(f"{path}/vertex", p["vertex"])

    def dir(self, path: str, d: Any) -> None:
        if isinstance(d, list):
            self.p3(path, d, "ratio")
        elif isinstance(d, dict):
            self.axis_object(path, d)

    def r(self, path: str, r: dict) -> None:
        self.q(f"{path}/q", r["q"])

    def q(self, path: str, q: dict) -> None:
        op = q["op"]
        if op in ("between", "minus"):
            self.q(f"{path}/a", q["a"])
            self.q(f"{path}/b", q["b"])
        elif op in ("faces", "edges", "vertices", "owner", "largest", "smallest"):
            self.q(f"{path}/of", q["of"])
        elif op in ("union", "intersect"):
            for i, sub in enumerate(q["of"]):
                self.q(f"{path}/of/{i}", sub)
        elif op == "filter":
            self.q(f"{path}/of", q["of"])
            wp, w = f"{path}/where", q["where"]
            for key in ("normal", "parallel", "perpendicular"):
                if key in w:
                    self.dir(f"{wp}/{key}", w[key])
            if "radius" in w:
                for key in ("eq", "min", "max"):
                    self.opt(f"{wp}/radius", w["radius"], key, "length")
        elif op == "extreme":
            self.q(f"{path}/of", q["of"])
            self.dir(f"{path}/dir", q["dir"])


def sites(doc: dict) -> list[Site]:
    return Walker().document(doc).sites


def feature_sites(pi: int, fi: int, f: dict) -> list[Site]:
    w = Walker()
    w.feature(pi, fi, f)
    return w.sites


# ---------------------------------------------------------------------------------------------
# Per-part context
# ---------------------------------------------------------------------------------------------

LINE, ARC, CIRCLE = "line", "arc", "circle"


@dataclass
class SketchInfo:
    profile: dict[str, str] = field(default_factory=dict)
    wild_polygons: list[str] = field(default_factory=list)
    points: set[str] = field(default_factory=set)
    point_curves: list[str] = field(default_factory=list)

    def cls(self, cid: str) -> str | None:
        if cid in self.profile:
            return self.profile[cid]
        for p in self.wild_polygons:
            pre = p + ".e"
            if cid.startswith(pre):
                rest = cid[len(pre):]
                if rest and all("0" <= ch <= "9" for ch in rest):
                    return LINE
        return None


@dataclass
class FeatInfo:
    ty: str
    sketch: str | None = None
    tag_kind: str | None = None


@dataclass
class PartCtx:
    earlier: dict[str, FeatInfo] = field(default_factory=dict)
    sketches: dict[str, SketchInfo] = field(default_factory=dict)

    def consumed_sketch(self, feature: str) -> SketchInfo | None:
        f = self.earlier.get(feature)
        if f is None or f.sketch is None:
            return None
        return self.sketches.get(f.sketch)


ONE_, SOME_, ANY_ = "one", "some", "any"
FACE_ONE = (("face",), ONE_)
FACE_SOME = (("face",), SOME_)
FACE_ANY = (("face",), ANY_)
EDGE_ONE = (("edge",), ONE_)
EDGE_SOME = (("edge",), SOME_)
VERTEX_ONE = (("vertex",), ONE_)
BODY_ONE = (("body",), ONE_)
BODY_SOME = (("body",), SOME_)
ANY_SOME = ((), SOME_)

SWEEPS = ("extrude", "revolve")
BODY_ORIGINS = ("extrude", "revolve", "pattern", "transform")
CREATORS = ("extrude", "revolve", "boolean", "hole", "fillet", "chamfer", "shell", "draft", "pattern", "transform")


def member_names(kind: str, n: int | None) -> list[str]:
    if kind == "rect":
        return ["bottom", "c_br", "right", "c_tr", "top", "c_tl", "left", "c_bl"]
    if kind == "slot":
        return ["right", "cap_b", "left", "cap_a"]
    if kind == "polygon":
        return [f"e{k}" for k in range(n or 0)]
    return []


def solver_entities(c: dict) -> list[tuple[str, str | None]]:
    """The ids a curve puts in the sketch namespace, with their solver entity type (§4.3)."""
    cid, k = c["id"], c["kind"]

    def line(i):
        return [(i, "line"), (f"{i}.start", "point"), (f"{i}.end", "point")]

    def arc(i):
        return [(i, "arc"), (f"{i}.start", "point"), (f"{i}.end", "point"), (f"{i}.center", "point")]

    if k == "point":
        return [(cid, "point")]
    if k == "line":
        return line(cid)
    if k == "arc":
        return arc(cid)
    if k == "circle":
        return [(cid, "circle"), (f"{cid}.center", "point")]
    n = None
    if k == "polygon":
        v = lit(c["n"])
        if v is not None and expr.is_count(v) and v <= 4096.0:
            n = int(v)
    out: list[tuple[str, str | None]] = [(cid, None)]
    for m in member_names(k, n):
        mid = f"{cid}.{m}"
        out.extend(arc(mid) if m.startswith(("c_", "cap_")) else line(mid))
    return out


def sketch_info(s: dict) -> SketchInfo:
    info = SketchInfo()
    for c in s["curves"]:
        cid, k = c["id"], c["kind"]
        cons = bool(c.get("construction", False))
        if k == "point":
            info.points.add(cid)
            info.point_curves.append(cid)
        elif k == "circle":
            info.points.add(f"{cid}.center")
            if not cons:
                info.profile[cid] = CIRCLE
        elif cons:
            pass
        elif k == "line":
            info.profile[cid] = LINE
        elif k == "arc":
            info.profile[cid] = ARC
        elif k == "polygon" and lit(c["n"]) is None:
            info.wild_polygons.append(cid)
        else:
            for eid, ent in solver_entities(c):
                if ent == "line":
                    info.profile[eid] = LINE
                elif ent == "arc":
                    info.profile[eid] = ARC
    return info


def _similar(candidate: str, wanted: str) -> bool:
    common = 0
    for a, b in zip(candidate.encode(), wanted.encode()):
        if a != b:
            break
        common += 1
    return common >= max(1, min(3, len(wanted.encode()))) and candidate != wanted


# ---------------------------------------------------------------------------------------------
# The validator
# ---------------------------------------------------------------------------------------------

class Validator:
    def __init__(self, doc: dict):
        self.doc = doc
        self.errs: list[Problem] = []
        self.names: set[str] = set()
        self.feature_ids: set[str] = set()
        self.part_ids: set[str] = set()
        self.part_names: set[str] = set()

    def err(self, code: str, path: str, message: str, details: dict | None = None) -> None:
        self.errs.append(Problem(code, path, message, details or {}))

    def run(self) -> list[Problem]:
        doc = self.doc
        if doc["schema"] != IR_SCHEMA:
            self.err("UNSUPPORTED_SCHEMA", "/schema", f"expected {IR_SCHEMA!r}",
                     {"found": shown(doc["schema"]), "supported": [IR_SCHEMA_V0, IR_SCHEMA]})
        if not doc["parts"]:
            self.err("NO_PARTS", "/parts", "a document needs at least one part studio")
        for i, p in enumerate(doc.get("params", [])):
            self.param(p, f"/params/{i}")
        for pi, part in enumerate(doc["parts"]):
            self.part(pi, part)
        return self.errs

    # -- names and ids --------------------------------------------------------------------------
    def name(self, name: str, path: str, reserved: frozenset[str]) -> None:
        why = check_id(name)
        if why is not None:
            self.err("INVALID_NAME", path, f"names must match [A-Za-z_][A-Za-z0-9_]* ({why})",
                     {"path": path, "reason": why, "length": byte_len(name)})
        elif name in reserved:
            self.err("RESERVED_NAME", path, f"{name!r} is a reserved word or CadScript builtin",
                     {"name": name})
        if name in self.names:
            self.err("DUPLICATE_NAME", path, f"{shown(name)!r} is already a feature or parameter name",
                     {"name": shown(name)})
        self.names.add(name)

    def id(self, s: str, path: str) -> bool:
        why = check_id(s)
        if why is None:
            return True
        self.err("INVALID_ID", path, f"ids must match [A-Za-z_][A-Za-z0-9_]* ({why})",
                 {"path": path, "reason": why, "length": byte_len(s)})
        return False

    def reference(self, s: str, path: str) -> bool:
        why = check_ref(s)
        if why is None:
            return True
        self.err("INVALID_ID", path, f"references must be ids joined by '.' ({why})",
                 {"path": path, "reason": why, "length": byte_len(s)})
        return False

    # -- parameters -----------------------------------------------------------------------------
    def param(self, p: dict, pp: str) -> None:
        self.name(p["name"], f"{pp}/name", consts.reserved_names_v1())
        name = p["name"]
        unit = p["unit"]
        if unit == "bool":
            for fld in ("min", "max"):
                if fld in p:
                    self.err("PARAM_INVALID", f"{pp}/{fld}", "bounds are not allowed on a bool parameter",
                             {"name": shown(name), "reason": "bounds-on-bool"})
        vp = f"{pp}/value"
        v = p["value"]
        if isinstance(v, bool) and unit != "bool":
            self.err("EXPR_TYPE_MISMATCH", vp, "a boolean literal for a numeric parameter",
                     {"expected": str(expr.UNIT_TY[unit]), "found": "bool"})
        elif not isinstance(v, (bool, str)) and unit == "bool":
            self.err("EXPR_TYPE_MISMATCH", vp, "a number literal for a bool parameter",
                     {"expected": "bool", "found": "number"})
        lo = lit(p["min"]) if "min" in p else None
        hi = lit(p["max"]) if "max" in p else None
        if lo is not None and hi is not None and lo > hi:
            self.err("PARAM_INVALID", f"{pp}/max", f"min {lo} > max {hi}",
                     {"name": shown(name), "reason": "min-greater-than-max"})
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            x = float(v)
            if (lo is not None and x < lo) or (hi is not None and x > hi):
                self.err("PARAM_OUT_OF_RANGE", vp, f"{x} is outside [{lo}, {hi}]",
                         {"name": shown(name), "value": x, "min": lo, "max": hi})

    # -- parts and features -----------------------------------------------------------------------
    def part(self, pi: int, part: dict) -> None:
        pp = f"/parts/{pi}"
        if self.id(part["id"], f"{pp}/id"):
            if part["id"] in self.part_ids:
                self.err("DUPLICATE_ID", f"{pp}/id", f"part id {part['id']!r}", {"id": part["id"]})
            self.part_ids.add(part["id"])
        why = check_id(part["name"])
        if why is not None:
            self.err("INVALID_NAME", f"{pp}/name", f"part names must match the id grammar ({why})",
                     {"path": f"{pp}/name", "reason": why, "length": byte_len(part["name"])})
        else:
            if part["name"] in self.part_names:
                self.err("DUPLICATE_NAME", f"{pp}/name", f"part {part['name']!r}", {"name": part["name"]})
            self.part_names.add(part["name"])
        for i, p in enumerate(part.get("params", [])):
            self.param(p, f"{pp}/params/{i}")
        ctx = PartCtx()
        for fi, f in enumerate(part["features"]):
            fp = f"{pp}/features/{fi}"
            self.feature(f, fp, ctx)
            t = f["type"]
            info = FeatInfo(t, sketch=f["sketch"] if t in SWEEPS else None,
                            tag_kind=f["target"]["kind"] if t == "tag" else None)
            if t == "sketch":
                ctx.sketches[f["id"]] = sketch_info(f)
            ctx.earlier.setdefault(f["id"], info)

    def range(self, code: str, fp: str, fld: str, value: float, expected: str) -> None:
        self.err(code, f"{fp}/{fld}", f"{fld} = {value}: must be {expected}",
                 {"field": fld, "value": value, "expected": expected})

    def extrude_extent(self, f: dict, fp: str, ctx: PartCtx) -> None:
        """Amendment set F (§6.2): exactly one of `distance` and `extent`; `through_all` cuts or
        intersects; `up_to` is one-sided and names a plane."""
        ext = f.get("extent")

        def conflict(why: str, fields: list) -> None:
            self.err("EXTRUDE_EXTENT_CONFLICT", f"{fp}/extent", why, {"field": "extent", "fields": fields})

        has_d = "distance" in f
        if ext is None and not has_d:
            conflict("an extrude needs a distance or an extent", ["distance", "extent"])
        elif ext is not None and has_d:
            conflict("an extrude has a distance or an extent, not both", ["distance", "extent"])
        elif ext == "through_all":
            if f.get("op", "new_body") not in ("cut", "intersect"):
                conflict("through_all cuts or intersects (op cut or intersect)", ["extent", "op"])
        elif isinstance(ext, dict) and "up_to" in ext:
            if f.get("direction", "normal") == "symmetric":
                conflict("up_to goes one way: not with direction symmetric", ["extent", "direction"])
            self.plane(ext["up_to"], f"{fp}/extent/up_to", ctx)

    def feature(self, f: dict, fp: str, ctx: PartCtx) -> None:
        if self.id(f["id"], f"{fp}/id"):
            if f["id"] in self.feature_ids:
                self.err("DUPLICATE_ID", f"{fp}/id", f"feature id {f['id']!r}", {"id": f["id"]})
            self.feature_ids.add(f["id"])
        self.name(f["name"], f"{fp}/name", consts.reserved_names_v0())
        t = f["type"]
        v = f.get("v", 1)
        if v not in consts.feature_versions().get(t, []):
            self.err("UNSUPPORTED_FEATURE_VERSION", f"{fp}/v", f"{t} v{v} is not implemented",
                     {"type": t, "v": v, "supported": consts.feature_versions().get(t, [])})
        if t == "sketch":
            self.sketch(f, fp, ctx)
        elif t == "extrude":
            self.sketch_ref(f["sketch"], f"{fp}/sketch", ctx)
            self.regions(f.get("regions", "all"), f["sketch"], fp, ctx)
            d = lit(f["distance"]) if "distance" in f else None
            if d is not None and d <= TOL:
                self.range("INVALID_DISTANCE", fp, "distance", d, _tol())
            self.extrude_extent(f, fp, ctx)
            self.body_op(f.get("op", "new_body"), f.get("targets"), fp, ctx)
        elif t == "revolve":
            self.sketch_ref(f["sketch"], f"{fp}/sketch", ctx)
            self.regions(f.get("regions", "all"), f["sketch"], fp, ctx)
            a = lit(f["angle"])
            if a is not None and not (0.0 < a <= 360.0):
                self.range("INVALID_ANGLE", fp, "angle", a, "in (0, 360]")
            d = lit2(f["axis"]["direction"])
            if d is not None and math.sqrt(d[0] * d[0] + d[1] * d[1]) <= TOL:
                self.err("INVALID_AXIS", f"{fp}/axis", "axis direction must be non-zero",
                         {"field": "axis", "value": list(d), "expected": "a non-zero direction"})
            self.body_op(f.get("op", "new_body"), f.get("targets"), fp, ctx)
        elif t == "boolean":
            self.check_ref(f["targets"], f"{fp}/targets", BODY_SOME, ctx)
            self.check_ref(f["tools"], f"{fp}/tools", BODY_SOME, ctx)
        elif t == "transform":
            self.check_ref(f["bodies"], f"{fp}/bodies", BODY_SOME, ctx)
            if isinstance(f.get("rotate"), dict):
                self.axis(f["rotate"]["axis"], f"{fp}/rotate/axis", ctx)
                a = lit(f["rotate"]["angle"])
                if a is not None and not (math.isfinite(a) and abs(a) <= 360.0):
                    self.range("INVALID_ANGLE", fp, "rotate/angle", a, "in [-360, 360]")
        elif t == "hole":
            self.hole(f, fp, ctx)
        elif t == "fillet":
            self.check_ref(f["edges"], f"{fp}/edges", EDGE_SOME, ctx)
            r = lit(f["r"])
            if r is not None and r <= TOL:
                self.range("INVALID_RADIUS", fp, "r", r, _tol())
        elif t == "chamfer":
            self.chamfer(f, fp, ctx)
        elif t == "shell":
            self.check_ref(f["body"], f"{fp}/body", BODY_ONE, ctx)
            if "open" in f:
                self.check_ref(f["open"], f"{fp}/open", FACE_ANY, ctx)
            th = lit(f["thickness"])
            if th is not None and th <= TOL:
                self.range("INVALID_VALUE", fp, "thickness", th, _tol())
        elif t == "draft":
            self.check_ref(f["faces"], f"{fp}/faces", FACE_SOME, ctx)
            self.plane(f["neutral"], f"{fp}/neutral", ctx)
            a = lit(f["angle"])
            if a is not None and not (0.0 < a < 45.0):
                self.range("INVALID_VALUE", fp, "angle", a, "in (0, 45)")
        elif t == "pattern":
            self.pattern(f, fp, ctx)
        elif t == "datum_plane":
            self.datum_plane(f, fp, ctx)
        elif t == "datum_axis":
            self.datum_axis(f, fp, ctx)
        elif t == "tag":
            self.check_ref(f["target"], f"{fp}/target", ANY_SOME, ctx)

    # -- sketches --------------------------------------------------------------------------------
    def sketch(self, s: dict, fp: str, ctx: PartCtx) -> None:
        self.plane(s["plane"], f"{fp}/plane", ctx)
        if not s["curves"]:
            self.err("EMPTY_SKETCH", f"{fp}/curves", "a sketch needs at least one curve",
                     {"sketch": shown(s["id"])})
        constrained = bool(s.get("constraints"))
        ns: set[str] = set()
        ents: dict[str, str] = {}
        for ci, c in enumerate(s["curves"]):
            cp = f"{fp}/curves/{ci}"
            if not self.id(c["id"], f"{cp}/id"):
                continue
            clashed = False
            for eid, ent in solver_entities(c):
                if eid in ns:
                    if not clashed:
                        self.err("DUPLICATE_ID", f"{cp}/id", f"id {eid!r} is already used in this sketch",
                                 {"id": eid})
                    clashed = True
                else:
                    ns.add(eid)
                    if ent is not None:
                        ents[eid] = ent
            self.curve(s, c, cp, constrained)
        for k, con in enumerate(s.get("constraints", [])):
            kp = f"{fp}/constraints/{k}"
            if self.id(con["id"], f"{kp}/id"):
                if con["id"] in ns:
                    self.err("DUPLICATE_ID", f"{kp}/id",
                             f"constraint id {con['id']!r} is already used in this sketch", {"id": con["id"]})
                ns.add(con["id"])
            self.constraint(con, kp, ents)

    def positive_len(self, cp: str, fld: str, v: Any) -> None:
        x = lit(v)
        if x is not None and x <= TOL:
            self.range("INVALID_VALUE", cp, fld, x, _tol())

    def curve(self, s: dict, c: dict, cp: str, constrained: bool) -> None:
        k = c["kind"]
        if constrained:
            if k in ("rect", "slot", "polygon"):
                self.err("SKETCH_MIXED_MODE", cp,
                         f"compound curve {shown(c['id'])!r} in a constrained sketch",
                         {"sketch": shown(s["id"]), "path": cp})
            else:
                w = Walker()
                w.owner, w.scope = ("feature", 0, 0), 0
                w.curve(cp, c)
                for site in w.sites:
                    if site.is_expr:
                        self.err("SKETCH_MIXED_MODE", site.path,
                                 "a constrained sketch stores literal geometry only",
                                 {"sketch": shown(s["id"]), "path": site.path})

        def degenerate(reason: str) -> None:
            self.err("DEGENERATE_CURVE", cp, reason, {"curve": shown(c["id"]), "reason": reason})

        if k == "line":
            a, b = lit2(c["start"]), lit2(c["end"])
            if a is not None and b is not None and _dist2(a, b) <= TOL:
                degenerate("zero-length line")
        elif k == "arc":
            a, b, m = lit2(c["start"]), lit2(c["end"]), lit2(c["center"])
            if a is not None and b is not None and m is not None:
                r0, r1 = _dist2(a, m), _dist2(b, m)
                if r0 <= TOL or r1 <= TOL:
                    degenerate("zero-radius arc")
                elif not constrained and abs(r0 - r1) > TOL:
                    self.err("INCONSISTENT_ARC", cp, f"|start-center| = {r0} but |end-center| = {r1}",
                             {"curve": shown(c["id"]), "r_start": r0, "r_end": r1})
                elif _dist2(a, b) <= TOL:
                    degenerate("arc start == end; use a circle for a full turn")
        elif k == "circle":
            r = lit(c["radius"])
            if r is not None and r <= TOL:
                degenerate("circle radius must be > 0")
        elif k == "rect":
            if ("center" in c) == ("corner" in c):
                self.err("CURVE_OPTIONS_CONFLICT", cp, "a rect needs exactly one of center / corner",
                         {"curve": shown(c["id"]), "fields": ["center", "corner"]})
            self.positive_len(cp, "w", c["w"])
            self.positive_len(cp, "h", c["h"])
            rv = lit(c.get("r", 0.0))
            wv, hv = lit(c["w"]), lit(c["h"])
            if rv is not None and rv < 0.0:
                self.range("INVALID_VALUE", cp, "r", rv, ">= 0")
            elif wv is not None and hv is not None and rv is not None and wv > TOL and hv > TOL \
                    and rv > min(wv, hv) / 2.0:
                self.range("INVALID_VALUE", cp, "r", rv, f"<= min(w, h)/2 = {min(wv, hv) / 2.0}")
        elif k == "slot":
            self.positive_len(cp, "w", c["w"])
            pa, pb = lit2(c["a"]), lit2(c["b"])
            if pa is not None and pb is not None and _dist2(pa, pb) <= TOL:
                self.range("INVALID_VALUE", cp, "b", _dist2(pa, pb), "|b - a| > 0.000001")
        elif k == "polygon":
            sizes = ("circumradius", "inradius", "across_flats", "side")
            if sum(1 for f in sizes if f in c) != 1:
                self.err("CURVE_OPTIONS_CONFLICT", cp,
                         "a polygon needs exactly one of circumradius / inradius / across_flats / side",
                         {"curve": shown(c["id"]), "fields": list(sizes)})
            for f in sizes:
                if f in c:
                    self.positive_len(cp, f, c[f])
            nv = lit(c["n"])
            if nv is not None and expr.is_count(nv) and nv < 3.0:
                self.range("INVALID_COUNT", cp, "n", nv, ">= 3")

    def constraint(self, con: dict, kp: str, ents: dict[str, str]) -> None:
        cid = shown(con["id"])
        t = con["type"]
        if t in ("distance", "angle", "radius", "diameter"):
            driving = con.get("driving", True)
            has = "value" in con
            if not has and driving:
                self.err("CONSTRAINT_VALUE_REQUIRED", kp, f"driving dimension {cid!r} needs a value",
                         {"constraint": cid})
            elif has and not driving:
                self.err("CONSTRAINT_VALUE_ON_REFERENCE", f"{kp}/value",
                         f"reference dimension {cid!r} must not have a value", {"constraint": cid})
            elif has and driving:
                x = lit(con["value"])
                if x is not None and t != "angle" and x <= 0.0:
                    self.err("SKETCH_INVALID_DIMENSION", f"{kp}/value", f"{t} must be > 0, got {x}",
                             {"constraint": cid, "value": x})
        args = constraint_arguments(con)
        ok = True
        for arg, ref in args:
            ok &= self.reference(ref, f"{kp}/{arg}")
        if not ok:
            return
        e = check_constraint_refs(con, ents)
        if e is None:
            return
        kind = e[0]
        if kind == "unknown":
            _, arg, ref = e
            self.err("SKETCH_UNKNOWN_REFERENCE", f"{kp}/{arg}", f"`{cid}` references unknown entity `{ref}`",
                     {"owner": cid, "reference": ref})
        elif kind == "wrong":
            _, arg, ref, expected, found = e
            self.err("SKETCH_WRONG_ENTITY_TYPE", f"{kp}/{arg}", f"`{cid}` expects {expected} for `{ref}`",
                     {"owner": cid, "reference": ref, "expected": expected, "found": found})
        elif kind == "combination":
            _, ckind, a, b = e
            self.err("SKETCH_UNSUPPORTED_COMBINATION", kp, f"`{cid}`: unsupported {ckind} between {a} and {b}",
                     {"id": cid, "kind": ckind, "a": a, "b": b})
        else:
            _, arg, ref = e
            self.err("SKETCH_SELF_REFERENCE", f"{kp}/{arg}", f"`{cid}` references `{ref}` twice",
                     {"id": cid, "reference": ref})

    def sketch_ref(self, sketch: str, path: str, ctx: PartCtx) -> None:
        if not self.reference(sketch, path):
            return
        f = ctx.earlier.get(sketch)
        if f is None or f.ty != "sketch":
            self.err("UNRESOLVED_SKETCH", path,
                     f"{sketch!r} is not the id of an earlier sketch feature in this part studio",
                     {"sketch": sketch})

    def regions(self, regions: Any, sketch: str, fp: str, ctx: PartCtx) -> None:
        if not isinstance(regions, list):
            return
        if not regions:
            self.err("INVALID_VALUE", f"{fp}/regions", 'regions must be "all" or a non-empty list',
                     {"field": "regions", "value": [], "expected": '"all" or a non-empty list'})
        for k, cid in enumerate(regions):
            rp = f"{fp}/regions/{k}"
            if self.reference(cid, rp) and is_ref(sketch):
                info = ctx.sketches.get(sketch)
                if info is not None and info.cls(cid) is None:
                    self.unknown_curve(rp, sketch, cid, info)

    def unknown_curve(self, path: str, feature: str, curve: str, info: SketchInfo) -> None:
        similar = [k for k in sorted(info.profile) if _similar(k, curve)][:5]
        self.err("QUERY_UNKNOWN_CURVE", path,
                 f"{curve!r} is not a profile curve of the sketch consumed by {feature!r}",
                 {"feature": feature, "curve": curve, "similar": similar})

    def body_op(self, op: str, targets: Any, fp: str, ctx: PartCtx) -> None:
        if op == "new_body":
            if targets is not None:
                self.err("INVALID_VALUE", f"{fp}/targets", "targets are only used when op is join, cut or intersect",
                         {"field": "targets", "value": None, "expected": "absent when op is new_body"})
        elif targets is None:
            self.err("BOOLEAN_TARGETS_REQUIRED", f"{fp}/targets",
                     'join/cut/intersect need explicit targets ("all" or a body reference)', {"feature": fp})
        else:
            self.targets(targets, f"{fp}/targets", ctx)

    def targets(self, t: Any, path: str, ctx: PartCtx) -> None:
        if isinstance(t, dict):
            self.check_ref(t, path, BODY_SOME, ctx)

    # -- planes, axes, points, directions -----------------------------------------------------
    def plane(self, p: Any, path: str, ctx: PartCtx) -> None:
        if isinstance(p, str):
            return
        if "face" in p:
            self.check_ref(p["face"], f"{path}/face", FACE_ONE, ctx)
            if "x_dir" in p:
                self.nonzero(p["x_dir"], f"{path}/x_dir", "INVALID_VALUE")
        elif "datum" in p:
            self.datum_ref(p["datum"], f"{path}/datum", "datum_plane", ctx)
        else:
            self.frame(p["normal"], p["x_dir"], path)

    def frame(self, normal: Any, x_dir: Any, path: str) -> None:
        n, x = lit3(normal), lit3(x_dir)
        if n is None or x is None:
            return
        ln, lx = _len3(n), _len3(x)
        if ln <= TOL or lx <= TOL:
            self.err("INVALID_PLANE", path, "degenerate frame",
                     {"field": path, "reason": "zero-length normal or x_dir"})
        else:
            dot = (n[0] * x[0] + n[1] * x[1] + n[2] * x[2]) / (ln * lx)
            if abs(dot) > 1e-9:
                self.err("INVALID_PLANE", path, f"normal and x_dir must be perpendicular (cos = {dot:e})",
                         {"field": path, "reason": "normal and x_dir are not perpendicular"})

    def nonzero(self, v: Any, path: str, code: str) -> None:
        x = lit3(v)
        if x is not None and _len3(x) <= TOL:
            self.err(code, path, "direction must be non-zero",
                     {"field": path, "value": list(x), "expected": "a non-zero vector"})

    def datum_ref(self, fid: str, path: str, expected: str, ctx: PartCtx) -> None:
        if not self.reference(fid, path):
            return
        f = ctx.earlier.get(fid)
        if f is None or f.ty != expected:
            self.err("UNRESOLVED_FEATURE", path, f"{fid!r} is not an earlier {expected} feature",
                     {"id": fid, "field": path, "expected": expected})

    def axis(self, a: Any, path: str, ctx: PartCtx) -> None:
        if isinstance(a, dict):
            self.axis_object(a, path, ctx)

    def axis_object(self, o: dict, path: str, ctx: PartCtx) -> None:
        if "edge" in o:
            self.check_ref(o["edge"], f"{path}/edge", EDGE_ONE, ctx)
        elif "cylinder" in o:
            self.check_ref(o["cylinder"], f"{path}/cylinder", FACE_ONE, ctx)
        elif "datum" in o:
            self.datum_ref(o["datum"], f"{path}/datum", "datum_axis", ctx)
        else:
            self.nonzero(o["line"]["direction"], f"{path}/line/direction", "INVALID_AXIS")

    def point(self, p: Any, path: str, ctx: PartCtx) -> None:
        if isinstance(p, dict):
            self.check_ref(p["vertex"], f"{path}/vertex", VERTEX_ONE, ctx)

    def dir(self, d: Any, path: str, ctx: PartCtx) -> None:
        if isinstance(d, list):
            self.nonzero(d, path, "INVALID_VALUE")
        elif isinstance(d, dict):
            self.axis_object(d, path, ctx)

    # -- references and queries -----------------------------------------------------------------
    def check_ref(self, r: dict, path: str, fld: tuple, ctx: PartCtx) -> None:
        kinds, card_default = fld
        qk = self.query(r["q"], f"{path}/q", ctx)
        if qk is not None and qk != r["kind"]:
            self.err("REF_KIND_MISMATCH", f"{path}/kind",
                     f"kind is {r['kind']!r} but the query selects {qk}s",
                     {"field": path, "expected": qk, "found": r["kind"]})
        if kinds and r["kind"] not in kinds:
            self.err("REF_KIND_MISMATCH", f"{path}/kind",
                     f"this field takes {' or '.join(kinds)} references, not {r['kind']}",
                     {"field": path, "expected": list(kinds), "found": r["kind"]})
        card = r.get("card")
        if card_default == ONE_ and card is not None and card not in ("one", 1):
            self.err("INVALID_CARDINALITY", f"{path}/card",
                     'this field designates exactly one entity; card must be "one"',
                     {"field": path, "allowed": ["one", 1]})
        if card == 0 and not isinstance(card, bool):
            self.err("INVALID_CARDINALITY", f"{path}/card", "card must be one, some, any or an integer >= 1",
                     {"field": path, "allowed": ["one", "some", "any", ">= 1"]})

    def feature_of(self, feature: str, path: str, allowed: tuple, ctx: PartCtx, qpath: str) -> str | None:
        fpath = f"{path}/feature"
        if not self.reference(feature, fpath):
            return None
        f = ctx.earlier.get(feature)
        if f is None:
            self.err("UNRESOLVED_FEATURE", fpath,
                     f"{feature!r} is not the id of an earlier feature of this part studio",
                     {"id": feature, "field": fpath, "expected": list(allowed)})
            return None
        if allowed and f.ty not in allowed:
            self.err("QUERY_INVALID", fpath, f"this query needs a {' or '.join(allowed)} feature",
                     {"path": qpath, "expected": list(allowed), "found": f.ty})
            return None
        return f.ty

    def curve_of(self, feature: str, curve: str, path: str, ctx: PartCtx) -> str | None:
        if not self.reference(curve, path):
            return None
        info = ctx.consumed_sketch(feature)
        if info is None:
            return None
        cls = info.cls(curve)
        if cls is None:
            self.unknown_curve(path, feature, curve, info)
        return cls

    def query_invalid(self, path: str, expected: str, found: str, message: str) -> None:
        self.err("QUERY_INVALID", path, message, {"path": path, "expected": expected, "found": found})

    def query(self, q: dict, path: str, ctx: PartCtx) -> str | None:
        op = q["op"]
        if op == "body":
            ty = self.feature_of(q["feature"], path, BODY_ORIGINS, ctx, path)
            if ty in SWEEPS and "member" in q:
                self.curve_of(q["feature"], q["member"], f"{path}/member", ctx)
            return "body"
        if op == "bodies":
            return "body"
        if op in ("cap", "endcap"):
            allowed = ("extrude",) if op == "cap" else ("revolve",)
            if self.feature_of(q["feature"], path, allowed, ctx, path) is not None and "member" in q:
                self.curve_of(q["feature"], q["member"], f"{path}/member", ctx)
            return "face"
        if op == "side":
            if self.feature_of(q["feature"], path, SWEEPS, ctx, path) is not None:
                self.curve_of(q["feature"], q["curve"], f"{path}/curve", ctx)
            return "face"
        if op == "sides":
            if self.feature_of(q["feature"], path, SWEEPS, ctx, path) is not None and "member" in q:
                self.curve_of(q["feature"], q["member"], f"{path}/member", ctx)
            return "face"
        if op == "edge_at":
            if self.feature_of(q["feature"], path, SWEEPS, ctx, path) is not None \
                    and self.curve_of(q["feature"], q["curve"], f"{path}/curve", ctx) == CIRCLE:
                self.query_invalid(f"{path}/curve", "a line or arc (a curve with ends)", "circle",
                                   f"{q['curve']!r} is a circle: it has no ends")
            return "edge"
        if op == "between":
            for side in ("a", "b"):
                sp = f"{path}/{side}"
                k = self.query(q[side], sp, ctx)
                if k is not None and k != "face":
                    self.query_invalid(sp, "face", k, f"between takes two face queries, {side} selects {k}s")
            return "edge"
        if op == "hole_face":
            self.feature_of(q["feature"], path, ("hole",), ctx, path)
            self.id(q["at"], f"{path}/at")
            return "face"
        if op == "created":
            self.feature_of(q["feature"], path, CREATORS, ctx, path)
            if "role" in q:
                self.id(q["role"], f"{path}/role")
            return "face"
        if op == "instance":
            self.feature_of(q["feature"], path, ("pattern",), ctx, path)
            n = len(q["index"])
            if n == 0 or n > 2:
                self.query_invalid(f"{path}/index", "[i] or [i, j]", f"{n} indices",
                                   "an instance index is [i] or [i, j]")
            return "face"
        if op == "tagged":
            if self.feature_of(q["feature"], path, ("tag",), ctx, path) is None:
                return None
            return ctx.earlier[q["feature"]].tag_kind
        if op == "faces":
            return self.nav(q["of"], path, ("body", "edge", "vertex"), "face", ctx)
        if op == "edges":
            return self.nav(q["of"], path, ("body", "face", "vertex"), "edge", ctx)
        if op == "vertices":
            return self.nav(q["of"], path, ("body", "face", "edge"), "vertex", ctx)
        if op == "owner":
            return self.nav(q["of"], path, ("face", "edge", "vertex"), "body", ctx)
        if op in ("union", "intersect"):
            if not q["of"]:
                self.query_invalid(f"{path}/of", "at least one query", "none", f"{op} needs at least one operand")
                return None
            kind = None
            for i, sub in enumerate(q["of"]):
                sp = f"{path}/of/{i}"
                k = self.query(sub, sp, ctx)
                if k is not None:
                    if kind is None:
                        kind = k
                    elif kind != k:
                        self.query_invalid(sp, kind, k, f"set operands must have one kind: {kind} vs {k}")
            return kind
        if op == "minus":
            ka = self.query(q["a"], f"{path}/a", ctx)
            kb = self.query(q["b"], f"{path}/b", ctx)
            if ka is not None and kb is not None and ka != kb:
                self.query_invalid(f"{path}/b", ka, kb, "minus operands must have one kind")
            return ka
        if op == "filter":
            k = self.query(q["of"], f"{path}/of", ctx)
            if k is None:
                return None
            self.predicate(q["where"], k, f"{path}/where", ctx)
            return k
        if op == "extreme":
            self.dir(q["dir"], f"{path}/dir", ctx)
            return self.query(q["of"], f"{path}/of", ctx)
        if op in ("largest", "smallest"):
            k = self.query(q["of"], f"{path}/of", ctx)
            if k is None:
                return None
            if k == "vertex":
                self.query_invalid(f"{path}/of", "faces, edges or bodies", "vertex",
                                   f"{op} needs a size; vertices have none")
            return k
        return None

    def nav(self, of: dict, path: str, frm: tuple, to: str, ctx: PartCtx) -> str:
        sp = f"{path}/of"
        k = self.query(of, sp, ctx)
        if k is not None and k not in frm:
            self.query_invalid(sp, " or ".join(frm), k, f"cannot navigate from {k}s to {to}s")
        return to

    def predicate(self, p: dict, k: str, path: str, ctx: PartCtx) -> None:
        (name, val), = p.items()
        if name == "type":
            faces = ("plane", "cylinder", "cone", "sphere", "torus", "bspline")
            edges = ("line", "circle", "ellipse", "bspline")
            ok = (k == "face" and val in faces) or (k == "edge" and val in edges)
            expected = "faces" if val in faces else "edges"
        elif name == "normal":
            ok, expected = k == "face", "faces"
        elif name in ("parallel", "perpendicular", "radius"):
            ok, expected = k in ("face", "edge"), "faces or edges"
        else:  # convex / concave / smooth
            ok, expected = k == "edge", "edges"
        if not ok:
            self.query_invalid(path, expected, k, f"predicate {name!r} does not apply to {k}s")
        if name in ("normal", "parallel", "perpendicular"):
            self.dir(val, f"{path}/{name}", ctx)
        elif name in ("convex", "concave", "smooth") and val is not True:
            self.query_invalid(f"{path}/{name}", "true", "false", f"{{ {name!r}: false }} is not a predicate")
        elif name == "radius":
            eq, lo, hi = "eq" in val, "min" in val, "max" in val
            if not ((eq and not lo and not hi) or (not eq and (lo or hi))):
                self.query_invalid(f"{path}/radius", "{ eq } or { min?, max? }", "other fields",
                                   "radius takes eq, or min and/or max")
            for f in ("eq", "min", "max"):
                x = lit(val.get(f)) if f in val else None
                if x is not None and x < 0.0:
                    self.range("INVALID_VALUE", f"{path}/radius", f, x, ">= 0")

    # -- holes -----------------------------------------------------------------------------------
    def hole(self, h: dict, fp: str, ctx: PartCtx) -> None:
        self.plane(h["on"], f"{fp}/on", ctx)
        sizes = list(consts.hole_sizes())
        table = consts.constants()["HOLE_SIZES"]["sizes"]

        def conflict(fld: str, allowed: Any, message: str) -> None:
            self.err("HOLE_OPTIONS_CONFLICT", f"{fp}/{fld}", message, {"field": fld, "allowed": allowed})

        def preset_ok(size: str, preset: str) -> bool:
            row = table[size]
            keys = {"cbore": ("cbore_d", "cbore_depth"), "csink": ("csink_d",),
                    "insert": ("insert_d", "insert_depth")}[preset]
            return all(row.get(k) is not None for k in keys)

        size = h.get("size")
        if size is None and "d" not in h:
            self.err("HOLE_SIZE_REQUIRED", fp, "a hole needs a standard size or an explicit diameter d",
                     {"field": "size", "allowed": sizes})
        for fld, kw in (("cbore", "iso4762"), ("csink", "iso10642"), ("insert", "std")):
            if h.get(fld) != kw:
                continue
            if size is None:
                conflict(fld, sizes, f"the {fld} preset needs a standard size")
            elif not preset_ok(size, fld):
                conflict(fld, [s for s in sizes if preset_ok(s, fld)],
                         f"the {fld} preset has no table value for {size}")
        heads = [n for n in ("cbore", "csink", "insert") if n in h]
        if len(heads) > 1:
            conflict(heads[1], ["cbore", "csink", "insert"], f"at most one of cbore, csink, insert")
        thread = h.get("thread")
        threaded = thread is not None and thread is not False
        if threaded and "insert" in h:
            conflict("thread", ["thread", "insert"], "thread excludes insert")
        if threaded and h.get("fit", "normal") in ("close", "loose"):
            conflict("fit", ["normal", "tap"], "a threaded hole uses the tap drill")
        if threaded and size is None and not (isinstance(thread, dict) and "pitch" in thread):
            conflict("thread", {"pitch": "required without size"}, "a thread without a standard size needs a pitch")
        depth = h.get("depth")
        if depth is None and "insert" not in h:
            self.err("HOLE_DEPTH_REQUIRED", f"{fp}/depth", "depth is required",
                     {"field": "depth", "allowed": ["through", "blind", "up_to"]})
        elif depth is not None and "insert" in h:
            conflict("depth", ["insert"], "an insert sets its own blind depth")
        tip = h.get("tip", 118.0)
        tip_default = lit(tip) == 118.0
        if not tip_default and not (isinstance(depth, dict) and "blind" in depth):
            conflict("tip", ["blind"], "tip applies to blind holes only")
        if tip != "flat":
            x = lit(tip)
            if x is not None and not (0.0 < x < 180.0):
                self.range("INVALID_VALUE", fp, "tip", x, "in (0, 180)")
        if "d" in h:
            self.positive_len(fp, "d", h["d"])
        if isinstance(depth, dict) and "blind" in depth:
            self.positive_len(f"{fp}/depth", "blind", depth["blind"])
        elif isinstance(depth, dict) and "up_to" in depth:
            self.check_ref(depth["up_to"], f"{fp}/depth/up_to", FACE_ONE, ctx)
        if isinstance(h.get("cbore"), dict):
            self.positive_len(f"{fp}/cbore", "d", h["cbore"]["d"])
            self.positive_len(f"{fp}/cbore", "depth", h["cbore"]["depth"])
        if isinstance(h.get("csink"), dict):
            self.positive_len(f"{fp}/csink", "d", h["csink"]["d"])
            x = lit(h["csink"].get("angle", 90.0))
            if x is not None and not (0.0 < x < 180.0):
                self.range("INVALID_VALUE", f"{fp}/csink", "angle", x, "in (0, 180)")
        if isinstance(h.get("insert"), dict):
            self.positive_len(f"{fp}/insert", "d", h["insert"]["d"])
            self.positive_len(f"{fp}/insert", "depth", h["insert"]["depth"])
        if isinstance(thread, dict):
            for f in ("pitch", "depth"):
                if f in thread:
                    self.positive_len(f"{fp}/thread", f, thread[f])
        self.placement(h["at"], f"{fp}/at", ctx)
        on_face = isinstance(h["on"], dict) and "face" in h["on"]
        if "targets" in h:
            self.targets(h["targets"], f"{fp}/targets", ctx)
        elif not on_face:
            self.err("BOOLEAN_TARGETS_REQUIRED", f"{fp}/targets",
                     "a hole placed on a plane that is not a face needs explicit targets", {"feature": fp})

    def placement(self, at: dict, ap: str, ctx: PartCtx) -> None:
        if "points" in at:
            sp, p = f"{ap}/points", at["points"]
            self.sketch_ref(p["sketch"], f"{sp}/sketch", ctx)
            ids = p["ids"]
            if isinstance(ids, list):
                if not ids:
                    self.err("INVALID_VALUE", f"{sp}/ids", "ids: must be \"all\" or a non-empty list",
                             {"field": "ids", "value": [], "expected": '"all" or a non-empty list'})
                info = ctx.sketches.get(p["sketch"])
                seen: set[str] = set()
                for k, pid in enumerate(ids):
                    ip = f"{sp}/ids/{k}"
                    if not self.reference(pid, ip):
                        continue
                    if pid in seen:
                        self.err("DUPLICATE_ID", ip, f"position {pid!r} listed twice", {"id": pid})
                    seen.add(pid)
                    if info is not None and pid not in info.points:
                        similar = [x for x in sorted(info.points) if _similar(x, pid)][:5]
                        self.err("QUERY_UNKNOWN_CURVE", ip, f"{pid!r} is not a point of sketch {p['sketch']!r}",
                                 {"feature": p["sketch"], "curve": pid, "similar": similar})
        elif "list" in at:
            if not at["list"]:
                self.err("INVALID_VALUE", f"{ap}/list", "list: must be a non-empty list",
                         {"field": "list", "value": [], "expected": "a non-empty list"})
            seen = set()
            for k, pos in enumerate(at["list"]):
                ip = f"{ap}/list/{k}/id"
                if self.id(pos["id"], ip):
                    if pos["id"] in seen:
                        self.err("DUPLICATE_ID", ip, f"position id {pos['id']!r}", {"id": pos["id"]})
                    seen.add(pos["id"])
        elif "grid" in at:
            gp = f"{ap}/grid"
            self.count_min(gp, "nx", at["grid"]["nx"], 1.0)
            self.count_min(gp, "ny", at["grid"]["ny"], 1.0)
        elif "circle" in at:
            cp = f"{ap}/circle"
            self.count_min(cp, "n", at["circle"]["n"], 1.0)
            self.positive_len(cp, "d", at["circle"]["d"])

    def count_min(self, base: str, fld: str, v: Any, mn: float) -> None:
        x = lit(v)
        if x is not None and expr.is_count(x) and x < mn:
            self.range("INVALID_COUNT", base, fld, x, f">= {mn}")

    # -- chamfer, pattern, datums ------------------------------------------------------------------
    def chamfer(self, c: dict, fp: str, ctx: PartCtx) -> None:
        self.check_ref(c["edges"], f"{fp}/edges", EDGE_SOME, ctx)
        form = ("d2" in c, "angle" in c, "side" in c)
        if form not in ((False, False, False), (True, False, True), (False, True, True)):
            self.err("CHAMFER_OPTIONS_CONFLICT", fp, "a chamfer is { d }, { d, d2, side } or { d, angle, side }",
                     {"fields": ["d", "d2", "angle", "side"]})
        self.positive_len(fp, "d", c["d"])
        if "d2" in c:
            self.positive_len(fp, "d2", c["d2"])
        a = lit(c["angle"]) if "angle" in c else None
        if a is not None and not (0.0 < a < 90.0):
            self.range("INVALID_VALUE", fp, "angle", a, "in (0, 90)")
        if "side" in c:
            self.check_ref(c["side"], f"{fp}/side", FACE_ONE, ctx)

    def pattern(self, p: dict, fp: str, ctx: PartCtx) -> None:
        seed = p["seed"]
        feature_seeds = "features" in seed
        if feature_seeds:
            seeds = seed["features"]
            if not seeds:
                self.err("INVALID_VALUE", f"{fp}/seed/features", "features: must be a non-empty list",
                         {"field": "features", "value": [], "expected": "a non-empty list"})
            for k, sid in enumerate(seeds):
                sp = f"{fp}/seed/features/{k}"
                if not self.reference(sid, sp):
                    continue
                f = ctx.earlier.get(sid)
                if f is None:
                    self.err("UNRESOLVED_FEATURE", sp, f"{sid!r} is not the id of an earlier feature",
                             {"id": sid, "field": sp, "expected": ["extrude", "revolve", "hole"]})
                elif f.ty not in ("extrude", "revolve", "hole"):
                    self.err("PATTERN_SEED_UNSUPPORTED", sp, f"a {f.ty} cannot be a pattern seed",
                             {"seed": sid, "type": f.ty})
        else:
            self.check_ref(seed["bodies"], f"{fp}/seed/bodies", BODY_SOME, ctx)
        lp = f"{fp}/layout"
        lay = p["layout"]
        two_d = False
        if "linear" in lay:
            ll, l = f"{lp}/linear", lay["linear"]
            self.dir(l["dir"], f"{ll}/dir", ctx)
            self.count_min(ll, "count", l["count"], 1.0)
            s = lit(l["spacing"])
            if s is not None and abs(s) <= TOL:
                self.range("INVALID_VALUE", ll, "spacing", s, "|spacing| > 0.000001")
            if ("dir2" in l) != ("spacing2" in l) or ("count2" in l and "dir2" not in l):
                self.err("PATTERN_OPTIONS_CONFLICT", ll, "a second direction needs dir2 and spacing2",
                         {"fields": ["dir2", "count2", "spacing2"]})
            if "dir2" in l:
                two_d = True
                self.dir(l["dir2"], f"{ll}/dir2", ctx)
            if "count2" in l:
                self.count_min(ll, "count2", l["count2"], 1.0)
            s2 = lit(l["spacing2"]) if "spacing2" in l else None
            if s2 is not None and abs(s2) <= TOL:
                self.range("INVALID_VALUE", ll, "spacing2", s2, "|spacing2| > 0.000001")
            counts = (lit(l["count"]), lit(l["count2"]) if "count2" in l else 1.0)
        elif "circular" in lay:
            cp, c = f"{lp}/circular", lay["circular"]
            self.axis(c["axis"], f"{cp}/axis", ctx)
            self.count_min(cp, "count", c["count"], 2.0)
            a = lit(c.get("angle", 360.0))
            if a is not None and not (0.0 < a <= 360.0):
                self.range("INVALID_ANGLE", cp, "angle", a, "in (0, 360]")
            counts = (lit(c["count"]), None)
        else:
            self.plane(lay["mirror"]["plane"], f"{lp}/mirror/plane", ctx)
            counts = (2.0, None)
        for k, idx in enumerate(p.get("skip", [])):
            sp = f"{fp}/skip/{k}"
            want = 2 if two_d else 1
            is_seed = all(i == 0 for i in idx)
            oor = (len(idx) >= 1 and counts[0] is not None and float(idx[0]) >= counts[0]) or (
                two_d and len(idx) >= 2 and counts[1] is not None and float(idx[1]) >= counts[1])
            if len(idx) != want or is_seed or oor:
                exp = "[i, j] of an existing non-seed instance" if two_d else "[i] of an existing non-seed instance"
                self.err("INVALID_VALUE", sp, f"skip: must be {exp}", {"field": "skip", "value": idx, "expected": exp})
        op = p.get("op", "new_body")
        tg = p.get("targets")
        if feature_seeds:
            if not (op == "new_body" and tg is None):
                self.err("PATTERN_OPTIONS_CONFLICT", fp, "op and targets apply to body seeds only",
                         {"fields": ["op", "targets"]})
        elif op == "join" and tg is None:
            self.err("BOOLEAN_TARGETS_REQUIRED", f"{fp}/targets", "a body pattern with op join needs targets",
                     {"feature": fp})
        elif op == "new_body" and tg is not None:
            self.err("PATTERN_OPTIONS_CONFLICT", f"{fp}/targets", "targets are only used with op join",
                     {"fields": ["op", "targets"]})
        elif tg is not None:
            self.targets(tg, f"{fp}/targets", ctx)

    def mode_fields(self, fp: str, mode: str, present: list[tuple[str, bool]], required: tuple) -> None:
        missing = [r for r in required if not any(n == r and pr for n, pr in present)]
        unexpected = [n for n, pr in present if pr and n not in required]
        if missing or unexpected:
            self.err("DATUM_OPTIONS_CONFLICT", fp,
                     f"mode {mode!r} takes {', '.join(required)}; missing {missing}, not allowed {unexpected}",
                     {"mode": mode, "fields": list(required), "missing": missing, "unexpected": unexpected})

    def datum_plane(self, d: dict, fp: str, ctx: PartCtx) -> None:
        keys = ("from", "distance", "axis", "angle", "a", "b", "points", "origin", "normal", "x_dir")
        present = [(k, k in d) for k in keys]
        required = {"offset": ("from", "distance"), "angle": ("from", "axis", "angle"),
                    "midplane": ("a", "b"), "through": ("points",),
                    "frame": ("origin", "normal", "x_dir")}[d["mode"]]
        self.mode_fields(fp, d["mode"], present, required)
        for k in ("from", "a", "b"):
            if k in d:
                self.plane(d[k], f"{fp}/{k}", ctx)
        if "axis" in d:
            self.axis(d["axis"], f"{fp}/axis", ctx)
        for k, p in enumerate(d.get("points", [])):
            self.point(p, f"{fp}/points/{k}", ctx)
        if "origin" in d and "normal" in d and "x_dir" in d:
            self.frame(d["normal"], d["x_dir"], fp)

    def datum_axis(self, d: dict, fp: str, ctx: PartCtx) -> None:
        keys = ("edge", "face", "a", "b", "points")
        present = [(k, k in d) for k in keys]
        required = {"edge": ("edge",), "cylinder": ("face",), "planes": ("a", "b"),
                    "points": ("points",)}[d["mode"]]
        self.mode_fields(fp, d["mode"], present, required)
        if "edge" in d:
            self.check_ref(d["edge"], f"{fp}/edge", EDGE_ONE, ctx)
        if "face" in d:
            self.check_ref(d["face"], f"{fp}/face", FACE_ONE, ctx)
        for k in ("a", "b"):
            if k in d:
                self.plane(d[k], f"{fp}/{k}", ctx)
        for k, p in enumerate(d.get("points", [])):
            self.point(p, f"{fp}/points/{k}", ctx)


def constraint_arguments(con: dict) -> list[tuple[str, str]]:
    t = con["type"]
    if t in ("coincident", "parallel", "perpendicular", "tangent", "equal", "distance", "angle"):
        return [("a", con["a"]), ("b", con["b"])]
    if t in ("horizontal", "vertical"):
        return [("line", con["line"])]
    if t in ("radius", "diameter"):
        return [("curve", con["curve"])]
    if t in ("point_on_line", "midpoint"):
        return [("point", con["point"]), ("line", con["line"])]
    if t == "point_on_circle":
        return [("point", con["point"]), ("curve", con["curve"])]
    if t == "symmetric":
        return [("a", con["a"]), ("b", con["b"]), ("line", con["line"])]
    return [("entity", con["entity"])]


class _SolveErr(Exception):
    def __init__(self, info: tuple):
        super().__init__(info)
        self.info = info


def check_constraint_refs(con: dict, ents: dict[str, str]) -> tuple | None:
    """forge-solve's reference checks in its order, on the argument ids as written ([W0-9])."""

    def ent(arg, i):
        if i not in ents:
            raise _SolveErr(("unknown", arg, i))
        return ents[i]

    def want(arg, i, ok, expected):
        e = ent(arg, i)
        if e not in ok:
            raise _SolveErr(("wrong", arg, i, expected, e))
        return e

    def point(arg, i):
        return want(arg, i, ("point",), "point")

    def line(arg, i):
        return want(arg, i, ("line",), "line")

    def curve(arg, i):
        return want(arg, i, ("circle", "arc"), "circle or arc")

    def distinct(a, b):
        if a == b:
            raise _SolveErr(("self", "b", b))

    def is_curve(e):
        return e in ("circle", "arc")

    t = con["type"]
    try:
        if t == "coincident":
            distinct(con["a"], con["b"])
            point("a", con["a"])
            point("b", con["b"])
        elif t in ("horizontal", "vertical"):
            line("line", con["line"])
        elif t in ("parallel", "perpendicular", "angle"):
            distinct(con["a"], con["b"])
            line("a", con["a"])
            line("b", con["b"])
        elif t == "tangent":
            distinct(con["a"], con["b"])
            ea, eb = ent("a", con["a"]), ent("b", con["b"])
            if not ((ea == "line" and is_curve(eb)) or (is_curve(ea) and eb == "line") or (is_curve(ea) and is_curve(eb))):
                raise _SolveErr(("combination", "tangent", ea, eb))
        elif t == "equal":
            distinct(con["a"], con["b"])
            ea, eb = ent("a", con["a"]), ent("b", con["b"])
            if not ((ea == "line" and eb == "line") or (is_curve(ea) and is_curve(eb))):
                raise _SolveErr(("combination", "equal", ea, eb))
        elif t == "distance":
            distinct(con["a"], con["b"])
            point("a", con["a"])
            want("b", con["b"], ("point", "line"), "point or line")
        elif t in ("radius", "diameter"):
            curve("curve", con["curve"])
        elif t in ("point_on_line", "midpoint"):
            point("point", con["point"])
            line("line", con["line"])
        elif t == "point_on_circle":
            point("point", con["point"])
            curve("curve", con["curve"])
        elif t == "symmetric":
            distinct(con["a"], con["b"])
            point("a", con["a"])
            point("b", con["b"])
            line("line", con["line"])
        elif t == "fix":
            e = ent("entity", con["entity"])
            if e in ("line", "circle") and ("x" in con or "y" in con):
                raise _SolveErr(("wrong", "entity", con["entity"], "point (x/y targets)", e))
            if e == "arc":
                raise _SolveErr(("wrong", "entity", con["entity"],
                                 "point, line or circle (fix an arc's points)", "arc"))
    except _SolveErr as s:
        return s.info
    return None


# ---------------------------------------------------------------------------------------------
# Expressions: the oracle's own checker in place of W1's hook (§0.5 rule 4 step 5)
# ---------------------------------------------------------------------------------------------

@dataclass
class ParamDecl:
    name: str
    unit: str
    part: int | None  # None: a document parameter
    path: str  # the parameter's JSON pointer (/params/i or /parts/p/params/i)
    decl: dict


def param_decls(doc: dict) -> list[ParamDecl]:
    """Every parameter in declaration order: document parameters first, then per part."""
    out = [ParamDecl(p["name"], p["unit"], None, f"/params/{i}", p) for i, p in enumerate(doc.get("params", []))]
    for pi, part in enumerate(doc["parts"]):
        out += [ParamDecl(p["name"], p["unit"], pi, f"/parts/{pi}/params/{i}", p)
                for i, p in enumerate(part.get("params", []))]
    return out


class Scope:
    """Name resolution per §2.8: visible parameter types for a scope, other parts' parameters."""

    def __init__(self, doc: dict):
        self.decls = param_decls(doc)
        self.doc_params: dict[str, ParamDecl] = {}
        self.part_params: dict[int, dict[str, ParamDecl]] = {}
        for d in self.decls:
            table = self.doc_params if d.part is None else self.part_params.setdefault(d.part, {})
            table.setdefault(d.name, d)
        self.part_names = [p["name"] for p in doc["parts"]]
        self.features = frozenset(f["name"] for p in doc["parts"] for f in p["features"])

    def visible(self, scope: int | None) -> dict[str, ParamDecl]:
        out = dict(self.doc_params)
        if scope is not None:
            for k, v in self.part_params.get(scope, {}).items():
                out.setdefault(k, v)
        return out

    def types(self, scope: int | None) -> dict[str, expr.Ty]:
        return {k: expr.UNIT_TY[v.unit] for k, v in self.visible(scope).items()}

    def other_parts(self, scope: int | None) -> dict[str, str]:
        if scope is None:
            return {}
        vis = self.visible(scope)
        out = {}
        for pi, table in self.part_params.items():
            if pi == scope:
                continue
            for k in table:
                if k not in vis:
                    out.setdefault(k, self.part_names[pi])
        return out

    def check(self, site: Site) -> expr.Checked:
        return expr.check(site.text, site.field, self.types(site.scope),
                          other_parts=self.other_parts(site.scope), features=self.features)


def _generic_expr_problem(site: Site) -> Problem | None:
    """W0's parser-free checks: empty / blank and over-long expression text (no `expr` echo)."""
    if site.text.strip() == "":
        return Problem("EXPR_SYNTAX", site.path, "empty expression",
                       {"offset": 0, "expected": "an expression", "length": len(site.text.encode())})
    if len(site.text.encode()) > MAX_EXPR_BYTES:
        return Problem("EXPR_SYNTAX", site.path, f"expression longer than {MAX_EXPR_BYTES} bytes",
                       {"offset": MAX_EXPR_BYTES, "expected": "at most 4096 bytes",
                        "length": len(site.text.encode())})
    return None


def param_cycles(scope: Scope, uses: dict[str, list[str]],
                 field_uses: dict[str, dict[str, list[str]]] | None = None) -> list[tuple[list[ParamDecl], str]]:
    """§2.8 rule 3 [W0-26] [W0-47]: one `(cycle, field)` per strongly connected component that
    contains a cycle, the components ordered by their first member in declaration order. `cycle`
    is the shortest cycle through that first member, found breadth-first following each
    parameter's dependencies in order of first appearance (`value`, then `min`, then `max`, each
    left to right), closed (`[a, b, a]`); `field` is the first member's first field that uses the
    cycle's second member. `uses` maps a parameter's path to the parameter names its value and
    bounds use, in that order (resolved in its scope)."""
    decls = scope.decls
    index = {d.path: i for i, d in enumerate(decls)}
    adj: list[list[int]] = [[] for _ in decls]
    for d in decls:
        vis = scope.visible(d.part)
        for n in uses.get(d.path, []):
            if n in vis:
                adj[index[d.path]].append(index[vis[n].path])
    # Tarjan (iterative)
    order = [0]
    low = [-1] * len(decls)
    num = [-1] * len(decls)
    on = [False] * len(decls)
    stack: list[int] = []
    comps: list[list[int]] = []
    for root in range(len(decls)):
        if num[root] != -1:
            continue
        work = [(root, 0)]
        while work:
            v, i = work.pop()
            if i == 0:
                num[v] = low[v] = order[0]
                order[0] += 1
                stack.append(v)
                on[v] = True
            if i < len(adj[v]):
                work.append((v, i + 1))
                w = adj[v][i]
                if num[w] == -1:
                    work.append((w, 0))
                elif on[w]:
                    low[v] = min(low[v], num[w])
                continue
            for w in adj[v]:
                if on[w]:
                    low[v] = min(low[v], low[w])
            if low[v] == num[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on[w] = False
                    comp.append(w)
                    if w == v:
                        break
                comps.append(sorted(comp))
    out = []
    for comp in comps:
        if not (len(comp) > 1 or comp[0] in adj[comp[0]]):
            continue
        members = set(comp)
        first = min(comp)
        # breadth-first from `first`, neighbours in order of first appearance, back to `first`
        prev: dict[int, int] = {}
        queue = [first]
        seen = {first}
        end = None
        while queue and end is None:
            nxt = []
            for v in queue:
                for w in dict.fromkeys(adj[v]):
                    if w == first:
                        end = v
                        break
                    if w in members and w not in seen:
                        seen.add(w)
                        prev[w] = v
                        nxt.append(w)
                if end is not None:
                    break
            queue = nxt
        path = [end]
        while path[-1] != first:
            path.append(prev[path[-1]])
        cyc = [decls[i] for i in reversed(path)] + [decls[first]]
        d0 = decls[first]
        second = cyc[1]
        fld = "value"
        if field_uses is not None:
            vis = scope.visible(d0.part)
            for f in ("value", "min", "max"):
                if any(n in vis and vis[n].path == second.path for n in field_uses.get(d0.path, {}).get(f, [])):
                    fld = f
                    break
        out.append((cyc, fld))
    out.sort(key=lambda c: index[c[0][0].path])
    return out


def expression_problems(doc: dict, all_sites: list[Site]) -> list[Problem]:
    scope = Scope(doc)
    errs: list[Problem] = []
    uses: dict[str, list[str]] = {}
    field_uses: dict[str, dict[str, list[str]]] = {}  # param path → field → identifiers
    for site in all_sites:
        if not site.is_expr or _generic_expr_problem(site) is not None:
            continue
        ast = None
        try:
            ch = scope.check(site)
            ast = ch.ast
        except expr.ExprError as e:
            details = dict(e.details)
            # [W0-46]: EXPR_SYNTAX keeps the stored text when it lexes (the parser puts it in only
            # then); [W0-12] never echoes text that fails the lexer or the id grammar
            errs.append(Problem(e.code, site.path, e.message, details))
            if e.code != "EXPR_SYNTAX":
                try:  # [W0-26]: every expression that parses contributes its edges
                    ast = expr.parse(site.text)
                except expr.ExprError:
                    ast = None
        if ast is not None and site.owner[0] == "param":
            ppath, fld = site.path.rsplit("/", 1)
            field_uses.setdefault(ppath, {})[fld] = expr.identifiers(ast)
    for ppath, fu in field_uses.items():
        uses[ppath] = [n for f in ("value", "min", "max") for n in fu.get(f, [])]
    for cyc, fld in param_cycles(scope, uses, field_uses):
        first = cyc[0]
        errs.append(Problem("PARAM_CYCLE", f"{first.path}/{fld}",
                            f"parameter cycle: {' -> '.join(d.name for d in cyc)}",
                            {"cycle": [d.name for d in cyc]}))
    return errs


def validate(doc: dict, *, expressions: bool = True) -> list[Problem]:
    """Every rejection of a schema-valid v1 document (empty when the document is valid)."""
    errs = Validator(doc).run()
    all_sites = sites(doc)
    for s in all_sites:
        if s.is_expr:
            p = _generic_expr_problem(s)
            if p is not None:
                errs.append(p)
        elif not math.isfinite(s.value):
            errs.append(Problem("NON_FINITE", s.path, "literal values must be finite", {"field": s.path}))
        elif s.field == "count" and not expr.is_count(s.value):
            errs.append(Problem("EXPR_NOT_INTEGER", s.path,
                                f"a count must be an exact integer with |v| <= 2^31, got {s.value}",
                                {"expr": s.value, "value": s.value}))
    if expressions:
        errs.extend(expression_problems(doc, all_sites))
    return errs
