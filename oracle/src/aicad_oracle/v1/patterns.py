"""The `pattern` feature (SPEC-v1 §6.10 [D-47]) with OCCT.

**Instances** (lexicographic index order, minus `skip`; entries outside the layout name no
instance): linear `[i]`, `i = 1 … count−1`, translated by `i·spacing·u1`, or with `dir2`
`[i, j]`, `i < count`, `j < count2`, except `[0, 0]`, translated by `i·spacing·u1 +
j·spacing2·u2`; circular `[k]`, `k = 1 … count−1`, rotated by `k·Δ` degrees about the axis
(right-hand rule; `Δ = 360/count` for a full turn, else `angle/(count − 1)`; sine and cosine by
the exact degree trigonometry of §2.7, the rotation set as a matrix); mirror `[1]`, the
reflection in the plane.

**Feature seeds** (`extrude`, `revolve`, `hole`, in timeline order): the seed's **tool bodies as
evaluated at the seed** (kept on its feature state: `SweepSeed`, `holes.HoleSeed`) are copied for
every instance (`BRepBuilderAPI_Transform`, copy mode) and the seed's operation is applied once
with all instance tools together: `new_body` seeds create new bodies (origin: the pattern id, the
seed body's member, the instance); body-operation and hole seeds apply their operation (`cut` for
a hole) to the seed's targets **re-resolved in the pattern's scope** with the oracle's own
resolution (`"all"`, the seed's `targets` Ref, or a hole's default: the owner of its `on` face).
An instance **none of whose tools meets a target** ([W0-41] step 2; a join tool may also share a
face) is skipped with the warning `PATTERN_INSTANCE_SKIPPED { index, code }` (`code`:
`HOLE_MISSES_BODY` for a hole, `BOOLEAN_EMPTY_RESULT` for an intersect, else
`BOOLEAN_NO_INTERSECTION`); when every instance of a seed is skipped the pattern fails with
`PATTERN_ALL_INSTANCES_FAILED { instances }`. A join instance that meets through one tool but has
another detached tool keeps the join's own error ([W0-39]).

**Contract issue** (W7b review, reported to the Contract stage): because the tools are copied *as
evaluated at the seed*, a `through` hole seed's tool keeps the oracle's own length (`holes`: the
targets' box along `d`, or the head's depth when deeper, plus `max(1, 0.01·s)`; the SPEC leaves the length unspecified and Forge
uses `1 + 0.01·diag`), and an `up_to` seed its seed depth. After a rotation about an axis that is
not the hole's direction, or on a target that is not a prism along it, a copied through hole need
not go through (a radial hole in a block, patterned about Z, stops short of the diagonal corners)
and an up_to copy ignores its own up-to face — both engines agree only if they happen to choose
the same length. Until §6.10 re-evaluates `through`/`up_to` per instance or fixes the through
length, the generated F1/F2 families avoid such seeds outside translations and rotations about the
hole's own axis direction (`genops`).

**Body seeds**: copies of the resolved bodies (their current state); `new_body` (default) adds
them as new bodies, `join` joins them to `targets` (§6.0.3).

**Keys** (§5.2 rule 3): every entity of a copy is keyed `P/copy:{K}@q` (`K` the seed entity's key,
`q` the instance `i` or `i.j`); copies keep the seed entity's normalized structure (pieces,
types) and probe points (transformed).

**Report**: `pattern: { instances, skipped }` (`instances` = the non-seed instances the layout
defines, minus `skip`; `skipped` = the instances skipped by any seed, in index order).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS

from . import expr, geom, query
from .consts import LINEAR_TOLERANCE
from .sweeps import FeatureFailure
from .topo import Body, Entity, TopoError

TOL = LINEAR_TOLERANCE


@dataclass
class SweepSeed:
    """An extrude or revolve as a pattern seed: its tools as evaluated, its op and targets field."""

    tools: list = field(default_factory=list)
    op: str = "new_body"
    targets: Any = None


@dataclass
class Instance:
    index: tuple[int, ...]
    trsf: Any

    @property
    def qual(self) -> str:
        return ".".join(str(i) for i in self.index)


def _count(v: float, path: str, lo: int) -> int:
    if not (math.isfinite(v) and v == math.floor(v) and v >= lo):
        raise FeatureFailure("INVALID_COUNT", f"{path} = {v}: must be an integer >= {lo}",
                             {"field": path, "value": v, "expected": f">= {lo}"})
    return int(v)


def _translation(v) -> gp_Trsf:
    t = gp_Trsf()
    t.SetTranslation(gp_Vec(*v))
    return t


def _rotation(origin, k, deg: float) -> gp_Trsf:
    """Rotation by `deg` degrees about the axis (origin, unit k), right-hand rule, with the exact
    degree sine and cosine of §2.7 rule 4."""
    s, c = expr.sin_cos_deg(deg)
    x, y, z = k
    C = 1.0 - c
    r = [[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
         [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
         [z * x * C - y * s, z * y * C + x * s, c + z * z * C]]
    t = [origin[i] - sum(r[i][j] * origin[j] for j in range(3)) for i in range(3)]
    tr = gp_Trsf()
    tr.SetValues(r[0][0], r[0][1], r[0][2], t[0], r[1][0], r[1][1], r[1][2], t[1], r[2][0], r[2][1], r[2][2], t[2])
    return tr


def _mirror(origin, normal) -> gp_Trsf:
    t = gp_Trsf()
    t.SetMirror(gp_Ax2(gp_Pnt(*origin), gp_Dir(*normal)))
    return t


def _dir(ev, st, d: Any, path: str, refs: list, warns: list) -> tuple:
    """A linear pattern Dir: a named direction, a vector of ratios, or an AxisRef object."""
    if isinstance(d, str):
        return query.DIR_NAMES[d][0]
    if isinstance(d, list):
        v = tuple(ev.scalar(st, x, "ratio") for x in d)
        if geom.norm(v) <= TOL:
            raise FeatureFailure("INVALID_VALUE", "a zero direction vector", {"field": path, "value": 0.0,
                                                                            "expected": "a non-zero direction"})
        return geom.unit(v)
    return ev.axis_ref(st, d, path, refs, warns).direction


def instances(ev, st, f: dict, refs: list, warns: list) -> tuple[list[Instance], int]:
    """(kept instances in index order, the non-seed instance count minus `skip`)."""
    lay = f["layout"]
    sc = lambda v, fld="length": ev.scalar(st, v, fld)  # noqa: E731
    out: list[Instance] = []
    if "linear" in lay:
        L = lay["linear"]
        n1 = _count(sc(L["count"], "count"), "/layout/linear/count", 1)
        s1 = sc(L["spacing"])
        if not (math.isfinite(s1) and abs(s1) > TOL):
            raise FeatureFailure("INVALID_VALUE", f"spacing = {s1}: |spacing| must be > 0.000001",
                                 {"field": "/layout/linear/spacing", "value": s1, "expected": "|spacing| > 0.000001"})
        two = "dir2" in L
        n2 = _count(sc(L.get("count2", 1.0), "count"), "/layout/linear/count2", 1) if two else 1
        s2 = sc(L["spacing2"]) if two else 0.0
        if two and not (math.isfinite(s2) and abs(s2) > TOL):
            raise FeatureFailure("INVALID_VALUE", f"spacing2 = {s2}: |spacing2| must be > 0.000001",
                                 {"field": "/layout/linear/spacing2", "value": s2, "expected": "|spacing2| > 0.000001"})
        u1 = _dir(ev, st, L["dir"], "/layout/linear/dir", refs, warns)
        u2 = _dir(ev, st, L["dir2"], "/layout/linear/dir2", refs, warns) if two else None
        for i in range(n1):
            for j in range(n2):
                if i == 0 and j == 0:
                    continue
                v = geom.mul(u1, i * s1)
                if two:
                    v = geom.add(v, geom.mul(u2, j * s2))
                out.append(Instance((i, j) if two else (i,), _translation(v)))
    elif "circular" in lay:
        C = lay["circular"]
        n = _count(sc(C["count"], "count"), "/layout/circular/count", 2)
        ang = sc(C.get("angle", 360.0), "angle")
        if not (0.0 < ang <= 360.0):
            raise FeatureFailure("INVALID_ANGLE", f"angle = {ang}: must be in (0, 360]",
                                 {"field": "/layout/circular/angle", "value": ang, "expected": "in (0, 360]"})
        ax = ev.axis_ref(st, C["axis"], "/layout/circular/axis", refs, warns)
        delta = 360.0 / n if ang == 360.0 else ang / (n - 1)
        for k in range(1, n):
            out.append(Instance((k,), _rotation(ax.origin, geom.unit(ax.direction), k * delta)))
    else:
        pl = ev.plane_ref(st, lay["mirror"]["plane"], "/layout/mirror/plane", refs, warns)
        out.append(Instance((1,), _mirror(pl.origin, pl.normal)))
    skip = {tuple(int(x) for x in s) for s in f.get("skip", [])}
    kept = [x for x in out if x.index not in skip]
    return kept, len(kept)


def copy_body(b: Body, trsf, feature: str, member: str, order: int, inst: Instance | None,
              key_of) -> Body:
    """A transformed copy of `b` with the same entity structure; keys mapped by `key_of`."""
    tr = BRepBuilderAPI_Transform(b.solid, trsf, True)
    if not tr.IsDone():
        raise TopoError("OCCT_TRANSFORM_FAILED", f"copying {b} failed")
    from .booleans import _solids

    sols = _solids(tr.Shape())
    if len(sols) != 1:
        raise TopoError("OCCT_TRANSFORM_FAILED", f"the copy of {b} is not one solid")
    nb = Body(sols[0], feature, member, order)
    nb.instance = list(inst.index) if inst is not None else None
    oriented = []
    ex = TopExp_Explorer(nb.solid, TopAbs_FACE)
    while ex.More():
        oriented.append(TopoDS.Face_s(ex.Current()))
        ex.Next()

    def img(s, kind):
        m = tr.ModifiedShape(s)
        if kind == "face":
            return next((o for o in oriented if o.IsSame(m)), TopoDS.Face_s(m))
        return TopoDS.Edge_s(m) if kind == "edge" else TopoDS.Vertex_s(m)

    def tp(p):
        if p is None:
            return None
        q = gp_Pnt(*p)
        q.Transform(trsf)
        return (q.X(), q.Y(), q.Z())

    def ent(e: Entity, kind: str, body: Body) -> Entity:
        pieces = [img(s, kind) for s in e.pieces]
        x = Entity(kind, img(e.shape, kind), body, key=key_of(e.key) if e.key else "", pieces=pieces,
                   ctype=e.ctype)
        x.probe_point = tp(e.probe_point)
        return x

    nb.faces = [ent(f, "face", nb) for f in b.faces]
    nb.edges = [ent(e, "edge", nb) for e in b.edges]
    nb.vertices = [ent(v, "vertex", nb) for v in b.vertices]
    for k in ("edge_faces", "vertex_edges"):
        nb._cache[k] = [list(x) for x in b._cache.get(k, [])]
    nb.aliases = {key_of(a): key_of(k) for a, k in b.aliases.items()}
    nb.normalized = b.normalized
    nb.naming_error = b.naming_error
    return nb


def _key_of(pid: str, inst: Instance):
    return lambda k: f"{pid}/copy:{{{k}}}@{inst.qual}"


def _own_resolve(ev, st, ref: dict, path: str) -> list:
    """The oracle's own resolution of a seed's Ref in the pattern's scope (not replayed: it is not a
    field of the pattern)."""
    res = query.resolve(ref, "some", path, ev.qscope(st))
    if res.failure is not None:
        raise FeatureFailure(res.failure.code, res.failure.message, res.failure.details)
    return list(res.members)


def _seed_targets(ev, st, sf: dict) -> list[Body]:
    t = sf.get("targets")
    if t == "all":
        return list(st.bodies)
    if isinstance(t, dict):
        return [b for b in _own_resolve(ev, st, t, "/targets")]
    if sf["type"] == "hole":
        (face,) = _own_resolve(ev, st, sf["on"]["face"], "/on/face")[:1] or [None]
        if face is None:
            raise FeatureFailure("REF_MISSING", "the hole seed's placement face is gone", {"field": "/on/face"})
        return [face.body]
    return list(st.bodies)


def _instance_meets(op: str, tools: list, targets: list) -> bool:
    from .booleans import meets, shares_face

    for k in tools:
        for t in targets:
            if meets(t.solid, [k.solid]):
                return True
            if op == "join" and shares_face(t.solid, k.solid):
                return True
    return False


def pattern_feature(ev, st, fi: int, f: dict, entry: dict, refs: list, fs) -> None:
    from .booleans import apply_body_op

    warns = entry["warnings"]
    pid = f["id"]
    seed = f["seed"]
    seed_bodies = None
    if "bodies" in seed:
        seed_bodies = list(ev.resolve(st, seed["bodies"], "some", "/seed/bodies", refs, warns))
    kept, n_inst = instances(ev, st, f, refs, warns)
    targets = None
    if seed_bodies is not None and f.get("op", "new_body") == "join":
        from .booleans import resolve_targets

        targets = resolve_targets(ev, st, f["targets"], "/targets", refs, warns)
    skipped: set[tuple] = set()
    created_all: list = []
    if seed_bodies is not None:
        op = f.get("op", "new_body")
        copies: list[tuple[Instance, list[Body]]] = []
        for inst in kept:
            copies.append((inst, [copy_body(b, inst.trsf, pid, b.member, fi, inst, _key_of(pid, inst))
                                  for b in seed_bodies]))
        _gate_copies(seed_bodies, copies)
        if op == "new_body":
            new = [b for _, bs in copies for b in bs]
            st.bodies.extend(new)
            created_all += [(b, "created") for b in new]
        else:
            live = []
            for inst, bs in copies:
                if _instance_meets("join", bs, targets):
                    live.append((inst, bs))
                else:
                    skipped.add(inst.index)
                    warns.append(_skip_warning(inst, "BOOLEAN_NO_INTERSECTION"))
            if not live:
                raise FeatureFailure("PATTERN_ALL_INSTANCES_FAILED", "every pattern instance misses its targets",
                                     {"instances": [list(i.index) for i in kept]})
            sub: dict = {"warnings": warns}
            apply_body_op(ev, st, pid, fi, "join", targets, [b for _, bs in live for b in bs], sub, keep_tools=False,
                          band_peers=[x for x in seed_bodies if any(x is t for t in targets)])
            _merge_entry(entry, sub)
    else:
        order = {x["id"]: i for i, x in enumerate(st.part["features"])}
        for sid in sorted(seed["features"], key=lambda s: order.get(s, 0)):
            sfs = st.features[sid]
            sf = st.part["features"][order[sid]]
            sd = sfs.seed
            if sd is None:
                raise TopoError("ORACLE_PATTERN_SEED_UNAVAILABLE", f"the seed {sid} kept no tools")
            for m, oc in sfs.outer_curves.items():
                fs.outer_curves.setdefault(m, oc)
                fs.region_curves.setdefault(m, sfs.region_curves.get(m, []))
            is_hole = sf["type"] == "hole"
            op = "cut" if is_hole else sd.op
            copies = [(inst, [copy_body(b, inst.trsf, pid if op == "new_body" else b.feature, b.member, fi, inst,
                                        _key_of(pid, inst)) for b in sd.tools]) for inst in kept]
            _gate_copies(sd.tools, copies)
            if op == "new_body":
                new = [b for _, bs in copies for b in bs]
                st.bodies.extend(new)
                created_all += [(b, "created") for b in new]
                continue
            tg = _seed_targets(ev, st, sf)
            code = "HOLE_MISSES_BODY" if is_hole else ("BOOLEAN_EMPTY_RESULT" if op == "intersect"
                                                       else "BOOLEAN_NO_INTERSECTION")
            live = []
            for inst, bs in copies:
                if _instance_meets(op, bs, tg):
                    live.append((inst, bs))
                else:
                    skipped.add(inst.index)
                    warns.append(_skip_warning(inst, code))
            if not live:
                raise FeatureFailure("PATTERN_ALL_INSTANCES_FAILED", "every pattern instance misses its targets",
                                     {"instances": [list(i.index) for i in kept]})
            sub = {"warnings": warns}
            apply_body_op(ev, st, pid, fi, op, tg, [b for _, bs in live for b in bs], sub, keep_tools=False,
                          band_peers=sd.tools)
            _merge_entry(entry, sub)
    if created_all:
        commit_new(entry, created_all)
    if "bodies" in entry:
        order = {x["id"]: i for i, x in enumerate(st.part["features"])}
        entry["bodies"].sort(key=lambda b: (order.get(b["origin"]["feature"], 0), b["origin"]["member"].encode(),
                                            tuple(b["origin"].get("instance") or ()),
                                            tuple(round(c, 9) for c in b["centroid"])))
    entry["pattern"] = {"instances": n_inst, "skipped": [list(i) for i in sorted(skipped)]}


def _skip_warning(inst: Instance, code: str) -> dict:
    return {"code": "PATTERN_INSTANCE_SKIPPED", "severity": "warning",
            "message": f"instance {list(inst.index)} meets no target ({code})",
            "details": {"index": list(inst.index), "code": code}}


def _gate_copies(seeds: list[Body], copies: list) -> None:
    """A rigid motion keeps every seed body's volume (the body gate for patterns)."""
    for _, bs in copies:
        for a, b in zip(seeds, bs):
            va, vb = a.body_metrics()["volume"], b.body_metrics()["volume"]
            if abs(va - vb) > 1e-9 * max(abs(va), 1e-12):
                raise TopoError("OCCT_SELF_CHECK_FAILED", f"a pattern copy changed the volume: {va!r} -> {vb!r}")


def _merge_entry(entry: dict, sub: dict) -> None:
    """Merge one seed operation's `bodies` / `removed` into the pattern's entry: a body reported by
    an earlier seed and modified again keeps one entry (the latest state); removed origins stay
    unique and are dropped when a later body carries them."""
    from .topo import body_report  # noqa: F401  (entries are already reports)

    bodies = entry.setdefault("bodies", [])
    for b in sub.get("bodies", []):
        o = b["origin"]
        same = [i for i, x in enumerate(bodies) if x["origin"] == o and x.get("change") == "modified"]
        for i in reversed(same):
            del bodies[i]
        bodies.append(b)
    if not bodies:
        entry.pop("bodies", None)
    rem = entry.setdefault("removed", [])
    for o in sub.get("removed", []):
        if o not in rem:
            rem.append(o)
    if not rem:
        entry.pop("removed", None)


def commit_new(entry: dict, created: list) -> None:
    from .topo import body_report

    bodies = entry.setdefault("bodies", [])
    for b, ch in sorted(created, key=lambda x: (x[0].order, x[0].member.encode(), tuple(x[0].instance or ()))):
        bodies.append(body_report(b, ch))


__all__ = ["pattern_feature", "SweepSeed", "copy_body", "instances"]
