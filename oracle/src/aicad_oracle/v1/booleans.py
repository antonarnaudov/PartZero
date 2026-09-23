"""Body operations (SPEC-v1 §6.0.2–§6.0.5, §6.4) with OCCT `BRepAlgoAPI_*`, normalised per §8.3:
no fuzzy value, `SetRunParallel(false)`, `SetNonDestructive(true)`, then
`ShapeUpgrade_UnifySameDomain(UnifyFaces, UnifyEdges, ConcatBSplines = false)` with *tol* and
`ANGULAR_TOLERANCE` (the same-domain merge of §6.0.4).

* `join`: the union of the targets and tools; its connected components are the result bodies. A
  tool that ends up in no component with a target is `BOOLEAN_NO_INTERSECTION` (`min_distance`).
* `cut`: each target minus the union of the tools (target by target, so overlapping targets stay
  separate bodies); no tool meeting any target's interior is `BOOLEAN_NO_INTERSECTION`.
* `intersect`: each target ∩ the union of the tools; targets with an empty result disappear;
  all empty is `BOOLEAN_EMPTY_RESULT`.
* Identity (§6.0.3): a result body inherits the origin of the target it comes from; a join
  component with several targets takes the first (timeline index, member), the others are
  reported in `removed`; split pieces share the origin (`BOOLEAN_SPLIT`); consumed targets are
  `BOOLEAN_BODY_CONSUMED` and listed in `removed`.
* Keys (§5.2 rule 3): faces and edges keep the key of the input entity they come from (through
  OCCT's `Modified` history and the unify history); a face merged from several keeps the
  byte-wise smallest key among the targets' faces (else among all) and the others become aliases;
  new edges and vertices get `G/edge:{A|B}` and `G/vertex:{…}` (G = the operation's feature id).
* Gate: every result body must be BRepCheck-valid, and the volumes must satisfy the set identities
  (`vol(t − K) = vol t − vol(t ∩ K)`, `vol(a ∪ b) = vol a + vol b − vol(a ∩ b)` for two-body
  components, `vol(t ∩ K) ≤ min(vol t, vol K)`), within 1e-8 relative — else the feature fails with
  the engine-internal `OCCT_SELF_CHECK_FAILED`.
"""

from __future__ import annotations

import math

from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape, TopTools_ListOfShape

from .. import occt
from .consts import ANGULAR_TOLERANCE, LINEAR_TOLERANCE
from .sweeps import FeatureFailure
from .topo import CURVE_RECOGNITION_REL, Body, TopoError, body_report, count_shells

GATE_REL = 1e-8


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


def _solids(shape) -> list:
    out = []
    ex = TopExp_Explorer(shape, TopAbs_SOLID)
    while ex.More():
        out.append(TopoDS.Solid_s(ex.Current()))
        ex.Next()
    return out


def _volume(shape) -> float:
    return occt.volume_props(shape).Mass() if shape is not None else 0.0


def _common_volume(a, bs) -> float:
    op = _run(BRepAlgoAPI_Common, [a], bs)
    return sum(_volume(s) for s in _solids(op.Shape()))


def _distance(a, bs) -> float:
    best = math.inf
    for b in bs:
        d = BRepExtrema_DistShapeShape(a, b)
        if d.IsDone() and d.NbSolution() > 0:
            best = min(best, d.Value())
    return best


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


def _new_bodies(result_shape, op, usd, inputs: list[Body], targets: list[Body], gid: str) -> list[tuple[Body, list[Body]]]:
    """Result solids as Bodies with keys, each with the list of input bodies it came from."""
    solids = _solids(result_shape)
    fmaps = []
    for s in solids:
        m = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(s, TopAbs_FACE, m)
        fmaps.append(m)
    # final face (solid index, face index) → source entities; input body → solid indices
    face_src: dict[tuple[int, int], list] = {}
    edge_src: dict[int, list] = {}
    body_of: dict[int, set[int]] = {}
    all_emap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(result_shape, TopAbs_EDGE, all_emap)
    all_vmap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(result_shape, TopAbs_VERTEX, all_vmap)
    vert_src: dict[int, list] = {}
    for bi, b in enumerate(inputs):
        for f in b.faces:
            for img in _images(f.shape, op, usd):
                for si, m in enumerate(fmaps):
                    k = m.FindIndex(img)
                    if k:
                        face_src.setdefault((si, k), []).append(f)
                        body_of.setdefault(bi, set()).add(si)
        for e in b.edges:
            for img in _images(e.shape, op, usd):
                k = all_emap.FindIndex(img)
                if k:
                    edge_src.setdefault(k, []).append(e)
        for v in b.vertices:
            for img in _images(v.shape, op, usd):
                k = all_vmap.FindIndex(img)
                if k:
                    vert_src.setdefault(k, []).append(v)
    # bodies whose every face vanished: classify one of their points
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN, TopAbs_ON

    for bi, b in enumerate(inputs):
        if bi in body_of or not b.faces:
            continue
        p = b.faces[0].point()
        for si, s in enumerate(solids):
            if BRepClass3d_SolidClassifier(s, gp_Pnt(*p), 1e-7).State() in (TopAbs_IN, TopAbs_ON):
                body_of.setdefault(bi, set()).add(si)
                break
    target_ids = {id(t) for t in targets}
    out: list[tuple[Body, list[Body]]] = []
    for si, s in enumerate(solids):
        members = [inputs[bi] for bi, sis in body_of.items() if si in sis]
        members.sort(key=lambda b: (b.order, b.member.encode()))
        tgt = [b for b in members if id(b) in target_ids]
        origin = (tgt or members or [None])[0]
        if origin is None:
            raise TopoError("OCCT_NAMING_FAILED", "a boolean result solid comes from no input body")
        nb = Body(s, origin.feature, origin.member, origin.order)
        nb.build_topology()
        m = occt.body_metrics(s, edge_recognition_rel=CURVE_RECOGNITION_REL)  # §8.3 rule 3
        m["shells"] = count_shells(s)
        nb.metrics = m
        out.append((nb, members))
        broken = [b.naming_error for b in members if b.naming_error]
        if broken:
            nb.naming_error = f"an input body is unnamed: {broken[0]}"
            continue
        fm = fmaps[si]
        missing = [f for f in nb.faces if not face_src.get((si, fm.FindIndex(f.shape)))]
        if missing:
            nb.naming_error = f"{len(missing)} boolean result face(s) have no source face in OCCT's history"
            continue
        for f in nb.faces:
            srcs = face_src.get((si, fm.FindIndex(f.shape)), [])
            tkeys = sorted({x.key for x in srcs if id(x.body) in target_ids}, key=str.encode)
            keys = tkeys or sorted({x.key for x in srcs}, key=str.encode)
            f.key = keys[0]
            for x in srcs:
                if x.key != f.key:
                    nb.aliases[x.key] = f.key
                for a, bkey in x.body.aliases.items():
                    if bkey == x.key:
                        nb.aliases[a] = f.key
            same = len(srcs) == 1 and srcs[0].shape.IsSame(f.shape)
            if same and srcs[0].probe_point is not None:
                f.probe_point = srcs[0].probe_point
        for e in nb.edges:
            fk = sorted(x.key for x in nb.faces_of_edge(e))
            if len(fk) == 1:
                fk = fk * 2
            # An edge the operation only trimmed or split keeps its key (§5.2 rule 3); one whose
            # faces changed (e.g. a tool's rim now lying between the target's cap and the tool's
            # side) is a new intersection edge of the operation: G/edge:{A|B}.
            srcs = [x for x in edge_src.get(all_emap.FindIndex(e.shape), [])
                    if _same_faces(_edge_faces(x.key), fk, nb.aliases)]
            if srcs:
                e.key = sorted({x.key for x in srcs}, key=str.encode)[0]
            else:
                e.key = f"{gid}/edge:{{{fk[0]}|{fk[1]}}}"
        for v in nb.vertices:
            srcs = vert_src.get(all_vmap.FindIndex(v.shape), [])
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


def _unchanged(nb: Body, members: list[Body]) -> Body | None:
    """The input body a result solid reproduces exactly (every face an unmodified input face)."""
    if len(members) != 1:
        return None
    b = members[0]
    if len(b.faces) != len(nb.faces):
        return None
    for f in nb.faces:
        if not any(g.shape.IsSame(f.shape) for g in b.faces):
            return None
    return b


def _check_valid(bodies: list[Body]) -> None:
    for b in bodies:
        m = b.body_metrics()
        if not m["valid"]:
            raise TopoError("OCCT_INVALID_RESULT", f"BRepCheck_Analyzer rejects the boolean result {b}")
        anc = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(b.solid, TopAbs_EDGE, TopAbs_FACE, anc)
        for i in range(1, anc.Extent() + 1):
            if anc.FindFromIndex(i).Size() > 2:
                p = b.edges[0].point() if b.edges else b.centroid
                raise FeatureFailure("BOOLEAN_NON_MANIFOLD", "the result touches itself along an edge",
                                     {"probe": {"kind": "edge", "point": list(p)}})


def _gate(cond: bool, what: str) -> None:
    if not cond:
        raise TopoError("OCCT_SELF_CHECK_FAILED", f"boolean volume identity violated: {what}")


def _close(a: float, b: float, scale: float) -> bool:
    return abs(a - b) <= GATE_REL * max(abs(a), abs(b), 1e-9 * scale ** 3)


def apply_body_op(ev, st, gid: str, order: int, op: str, targets: list[Body], tools: list[Body], entry: dict,
                  keep_tools: bool) -> None:
    """Apply join / cut / intersect of `tools` to `targets` in the part state `st`; fill the
    feature entry (`bodies`, `removed`, `warnings`)."""
    warns = entry["warnings"]
    scale = max([1.0] + [math.dist(b.body_metrics()["bbox_min"], b.body_metrics()["bbox_max"])
                         for b in targets + tools])
    tool_shapes = [k.solid for k in tools]
    created: list[tuple[Body, str]] = []
    removed: list[dict] = []
    replaced: set[int] = set()  # ids of scope bodies replaced by results
    if not targets:
        raise FeatureFailure("BOOLEAN_NO_INTERSECTION", "the operation has no target bodies",
                             {"tool": tools[0].origin if tools else None, "min_distance": None})
    if op == "join":
        o = _run(BRepAlgoAPI_Fuse, [t.solid for t in targets], tool_shapes)
        usd = _unify(o.Shape())
        results = _new_bodies(usd.Shape(), o, usd, targets + tools, targets, gid)
        tool_ids = {id(k) for k in tools}
        target_ids = {id(t) for t in targets}
        for k in tools:
            comp = next((ms for nb, ms in results if any(id(m) == id(k) for m in ms)), [])
            if not any(id(m) in target_ids for m in comp):
                others = [t.solid for t in targets]
                raise FeatureFailure("BOOLEAN_NO_INTERSECTION",
                                     f"tool {k.feature}/{k.member} neither overlaps nor shares a face with a target",
                                     {"tool": k.origin, "min_distance": _distance(k.solid, others)})
        new_bodies = []
        for nb, ms in results:
            same = _unchanged(nb, ms)
            if same is not None and id(same) in target_ids:
                new_bodies.append(same)
                continue
            tg = [m for m in ms if id(m) in target_ids]
            vol_in = [m.body_metrics()["volume"] for m in ms if id(m) in target_ids or id(m) in tool_ids]
            v = nb.body_metrics()["volume"]
            _gate(v <= sum(vol_in) * (1 + GATE_REL) + 1e-9 * scale ** 3 and v >= max(vol_in) * (1 - GATE_REL) - 1e-9 * scale ** 3,
                  f"join volume {v} outside [max input, sum of inputs]")
            if len(ms) == 2:
                inter = _common_volume(ms[0].solid, [ms[1].solid])
                exp = ms[0].body_metrics()["volume"] + ms[1].body_metrics()["volume"] - inter
                _gate(_close(v, exp, scale), f"vol(a ∪ b) = {v}, vol a + vol b − vol(a ∩ b) = {exp}")
            for m in tg[1:]:
                removed.append(m.origin)
            for m in tg:
                replaced.add(id(m))
            created.append((nb, "modified" if tg else "created"))
            new_bodies.append(nb)
        _check_valid([nb for nb, _ in created])
    else:
        met_any = False
        empty_all = True
        for t in targets:
            inter = _common_volume(t.solid, tool_shapes)
            meets = inter > 1e-9 * scale ** 3 * 1e-3
            met_any = met_any or meets
            if op == "cut":
                if not meets:
                    empty_all = False
                    continue
                o = _run(BRepAlgoAPI_Cut, [t.solid], tool_shapes)
            else:
                o = _run(BRepAlgoAPI_Common, [t.solid], tool_shapes)
            usd = _unify(o.Shape())
            results = _new_bodies(usd.Shape(), o, usd, [t] + tools, [t], gid) if _solids(usd.Shape()) else []
            pieces = [nb for nb, _ in results]
            vsum = sum(nb.body_metrics()["volume"] for nb in pieces)
            vt = t.body_metrics()["volume"]
            if op == "cut":
                _gate(_close(vsum, vt - inter, scale), f"vol(t − K) = {vsum}, vol t − vol(t ∩ K) = {vt - inter}")
            else:
                _gate(_close(vsum, inter, scale) and vsum <= vt * (1 + GATE_REL) + 1e-9 * scale ** 3,
                      f"vol(t ∩ K) = {vsum}, common = {inter}, vol t = {vt}")
            replaced.add(id(t))
            if not pieces:
                warns.append({"code": "BOOLEAN_BODY_CONSUMED", "severity": "warning",
                              "message": f"{t.feature}/{t.member} was consumed", "details": {"origin": t.origin}})
                removed.append(t.origin)
                continue
            empty_all = False
            for i, a in enumerate(pieces):
                for b in pieces[i + 1:]:
                    if _distance(a.solid, [b.solid]) <= LINEAR_TOLERANCE:
                        raise FeatureFailure("BOOLEAN_NON_MANIFOLD", "result pieces touch along an edge or vertex",
                                             {"probe": {"kind": "body", "point": list(a.centroid)}})
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
        _check_valid([nb for nb, _ in created])
    # commit: replace targets, drop consumed tools (they are new tool bodies, or kept on request)
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
                                                          tuple(round(c, 9) for c in x[0].centroid)))]
    if removed:
        entry["removed"] = removed


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
