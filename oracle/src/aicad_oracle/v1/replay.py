"""Reference replay (SPEC-v1 §8.1): check Forge's resolved members against the oracle's OCCT model.

For one Ref field of one feature, given Forge's `refs` entry (from its `aicad.metrics/1` report):

0. Forge's report MUST carry one `refs` entry per Ref-valued field (§5.8): an `ok` feature without
   it is `ORACLE_REF_UNREPORTED` (ROBUSTNESS; the oracle uses its own resolution);
1. every member's **probe** must match exactly one OCCT entity of the right kind within `1e-6·s`,
   and no two members may match the same entity — else `ORACLE_PROBE_UNMATCHED` (engine-prefixed:
   ROBUSTNESS in the diff). A probe with an outward `normal` (§7.6: face probes, and body probes,
   which are a face's probe) also needs a face there whose outward normal agrees — for a single
   candidate too (a contradicting orientation is never accepted silently), and for several
   (coincident faces of touching bodies) that is what disambiguates;
2. the **geometric predicates and picks** of the query are re-applied to each matched entity,
   **recursively over the whole query AST** (`_Checker`), and the member count is checked against
   the declared cardinality:
   * `filter`: the predicate holds and the member satisfies the filtered query;
   * `extreme` / `largest` / `smallest`: the member satisfies the picked query and is not short of
     the best of the oracle's own pool (`of` evaluated by the oracle) beyond the tie band plus the
     cross-engine tolerance;
   * `union`: at least one operand; `intersect`: every operand; `minus`: `a`, and — when `b` is
     key-free (decidable from geometry alone) — not *clearly* in `b`;
   * navigation (`faces`, `edges`, `vertices`, `owner`) and `between`: some adjacent entity
     satisfies the operand(s); `tagged`: the tag's query;
   * key-based sources (`cap`, `side`, `edge_at`, `body`, …) are not geometric: they pass here, and
     the set comparison of step 3 covers them.

   A member that fails is `ORACLE_PREDICATE_FAILED` (Forge used an entity its own query excludes:
   POTENTIAL_SILENT_WRONG). A predicate or pick the oracle cannot evaluate on the member (a
   non-evaluable material angle, radius or normal, an empty or failing pool), or one the member
   misses by less than the cross-engine tolerance (a radius bound, `eq`, an angle test, a
   near-tie), is `ORACLE_PREDICATE_UNCHECKED` (ROBUSTNESS: never a silent MATCH, never a false
   silent-wrong);
3. the matched set is compared with the oracle's own resolution (`query.py`):
   * **default mode** (the PR and nightly gate of §8.1): the oracle **builds from Forge's
     replayed members** (`Replay.members`), as the SPEC's "replays the members' probes" says. A
     difference from its own resolution — or its own resolution failing — is `ORACLE_REF_DIFFERS`,
     ROBUSTNESS in the diff: never a MATCH (the W7 acceptance: a probe moved to a neighbouring
     face is never MATCH, also on a predicate-free query such as `cap`), and never REF_MISMATCH,
     which §8.4 reserves for the independent-refs mode;
   * **independent-refs mode** (`--independent-refs`, nightly from F2, W7c): the oracle builds
     from its own resolution and a difference is `ORACLE_REF_MISMATCH` (the diff's
     `REF_MISMATCH`).

When a probe does not match (step 1), or Forge's reference failed, nothing is replayed and the
oracle falls back to its own resolution.

A Ref **nested in a query's Dir** (an AxisRef such as `{parallel: {edge: Ref}}`, §3.2) is always
the oracle's own resolution, in every mode, so that a wrong nested member of Forge's can steer
neither the oracle's resolution of the enclosing query nor the re-check of Forge's members for it.
Forge's entry for it (at its JSON pointer), when reported, goes through steps 1–3 but is never
adopted (`adopt=False`); a missing one is not `ORACLE_REF_UNREPORTED` (`required=False`: forge-refs
drops these entries, and §5.8 asks for one per Ref-valued *field*).

Findings are returned as warnings on the oracle's feature entry; `kernel-diff` v1 reads them.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from ..compare import ABS_FLOOR, POS_TOL, REL_TOL
from . import geom
from .consts import LINEAR_TOLERANCE, QUERY_ANGLE_TOLERANCE, QUERY_SIZE_TIE_REL
from .query import Evaluator, RefFailure, Scope, canonical_order, check_card, display_name, material_angle

MEMBER_STATUSES = ("exact", "merged", "neighborhood_changed", "kind_changed", "split", "repaired")
_SIZE_DIM = {"edge": 1, "face": 2, "body": 3}
#: Cross-engine allowance on an angle test (datum directions are compared at 1e-9, §8.2).
ANGLE_SLACK = 1e-9
SIN_QA = math.sin(QUERY_ANGLE_TOLERANCE)

#: Sources that designate entities by provenance key (§5.3), with their static kind.
KEYED_SOURCES = {"body": "body", "cap": "face", "endcap": "face", "side": "face", "sides": "face",
                 "edge_at": "edge", "hole_face": "face", "created": "face", "instance": "face"}
NAVIGATION = {"faces": "face", "edges": "edge", "vertices": "vertex", "owner": "body"}
PICKS = ("extreme", "largest", "smallest")


#: Questions the replay leaves to the Contract stage (W7b report, CONTRACT ISSUES), with what the
#: oracle does meanwhile — **what §8.1 says** (W7b review 4: the oracle follows the SPEC until a
#: ruling; before, it applied the single-candidate test on its own) — and the outcome in the diff.
PENDING_DEVIATIONS = {
    "single-candidate-normal": {
        "spec": "§8.1 [W0-35]: the face/body normal test applies 'when several faces or bodies are within r'",
        "oracle": "follows §8.1: one face or body within r is the match whatever its outward normal; the "
                  "proposal (apply the positive-dot-product test to every candidate count, so that a face "
                  "whose orientation contradicts the probe is not taken) waits for a Contract-stage ruling",
        "outcome": "MATCH for a single candidate with a contradicting normal (per §8.1)",
    },
    "key-tie-break": {
        "spec": "§8.1 [W0-35]: several faces or bodies left after the normal test are no match",
        "oracle": "follows §8.1 (no tie-break by the member's key): ORACLE_PROBE_UNMATCHED; `oracle gen --ir v1` "
                  "(classic) rejects programs whose own probes do not replay, so its corpora exclude this "
                  "configuration, and reports the rejected attempts (`rejected`, rate next to the class counts)",
        "outcome": "ROBUSTNESS in the diff (Forge-produced corpora); rejected generator attempts listed next to "
                   "the class counts",
    },
}


def _finding(code: str, message: str, details: dict, severity: str = "warning") -> dict:
    return {"code": code, "severity": severity, "message": message, "details": details}


@dataclass
class Replay:
    #: Forge's members as OCCT entities (canonical order) when every probe matched; else None.
    members: list | None = None
    #: The `refs` report entry describing `members`.
    entry: dict | None = None
    findings: list[dict] = field(default_factory=list)


# ---------------------------------------------------------------------------------------------
# Probe matching
# ---------------------------------------------------------------------------------------------

def _pool(scope: Scope, kind: str) -> list:
    """Every OCCT entity of a kind in the scope — without requiring the oracle's own naming, so
    that a probe can be replayed on a body the oracle could not name."""
    if kind == "body":
        return list(scope.bodies)
    out = []
    for b in scope.bodies:
        out.extend({"face": b.faces, "edge": b.edges, "vertex": b.vertices}[kind])
    return out


def _unit3(x: Any) -> tuple | None:
    if not (isinstance(x, list) and len(x) == 3
            and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in x)):
        return None
    v = tuple(float(c) for c in x)
    return geom.unit(v) if geom.norm(v) > 0.0 else None


def _normal_agrees(face, p, n) -> bool:
    """[W0-35]: the face's outward normal at `p` has a positive dot product with the probe's."""
    m = face.normal_at(p)
    return m is not None and geom.dot(m, n) > 0.0


def match_radius(scale: float) -> float:
    """[W0-35] §8.1: probes match the entities within `clamp(1e-6·s, 2·tol, 5·tol)` of their point."""
    return min(max(1e-6 * scale, 2.0 * LINEAR_TOLERANCE), 5.0 * LINEAR_TOLERANCE)


def _match(scope: Scope, probe: Any) -> tuple[list, str]:
    """The OCCT entities of the probe's kind within `match_radius(s)` of its point (§8.1 [W0-35]),
    and, when there is not exactly one, why.

    * Face and body probes carry an outward `normal` (§7.6): when **several** faces or bodies are
      within the radius (coincident faces of touching bodies), those whose outward normal has no
      positive dot product with it are dropped (§8.1 [W0-35]). One candidate is the match whatever
      its normal, as §8.1 says (W7b review 4: the oracle applied the test to a single candidate
      too, stricter than the SPEC; that proposal waits for a Contract-stage ruling,
      `PENDING_DEVIATIONS["single-candidate-normal"]`, and the tests pin the SPEC's outcome,
      `ORACLE_PENDING_SINGLE_CANDIDATE_NORMAL` in `tests/test_v1_ops_replay.py`).
    * Edge probes ([W0-50], [W0-54]): one edge within the radius is the match, with or without
      normals; among several, a probe without `normal` (a cusp, or an engine that does not emit
      edge normals yet) cannot choose, and otherwise the edge whose own normal (§7.6, None at a
      cusp: never kept) has the largest positive dot product with the probe's wins; two equal
      largest (exactly equal: §8.1 names no tolerance) are no match.
    * When several faces or bodies are still left after the normal test — coincident at the
      probe with agreeing normals, e.g. the coplanar overlapping caps of two separate bodies, where
      position and normal cannot decide — the probe is **not** matched (§8.1 [W0-35]: "more than
      one left is not a match", `ORACLE_PROBE_UNMATCHED`, ROBUSTNESS). The caller then falls back
      to its own resolution. A tie-break by the member's key was considered and is not applied: the
      SPEC does not contain it (`PENDING_DEVIATIONS["key-tie-break"]`; W7b report, CONTRACT ISSUES
      2 — the replayed geometry is not the same whichever is taken in general: a hole whose default
      target is `on_face.body` drills the body of the face it takes)."""
    if not isinstance(probe, dict):
        return [], "the probe is malformed"
    kind = probe.get("kind")
    pt = probe.get("point")
    if (kind not in ("face", "edge", "vertex", "body") or not isinstance(pt, list) or len(pt) != 3
            or not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in pt)):
        return [], "the probe is malformed"
    tol = match_radius(scope.scale)
    p = tuple(float(x) for x in pt)
    n = _unit3(probe.get("normal"))
    if kind == "body":
        bc = [(b, [f for f in b.faces if f.distance(p) <= tol]) for b in scope.bodies]
        bc = [(b, fs) for b, fs in bc if fs]
        if len(bc) > 1 and n is not None:
            keep = [(b, fs) for b, fs in bc if any(_normal_agrees(f, p, n) for f in fs)]
            if not keep:
                return [], (f"it lies on {len(bc)} body(ies), but no face there has the probe's outward "
                            f"normal {list(n)}")
            bc = keep
        cands = [b for b, _ in bc]
    else:
        cands = [e for e in _pool(scope, kind) if e.distance(p) <= tol]
        if len(cands) > 1 and kind == "face" and n is not None:
            keep = [e for e in cands if _normal_agrees(e, p, n)]
            if not keep:
                return [], (f"it lies on {len(cands)} face(s), none with the probe's outward normal {list(n)} "
                            "(a contradicting face orientation)")
            cands = keep
        if kind == "edge" and len(cands) > 1:
            if n is None:
                return cands, "several edges lie there and the probe has no normal to choose by ([W0-54])"
            scored = []
            for e in cands:
                m = e.edge_normal(p)
                if m is not None:
                    scored.append((geom.dot(m, n), e))
            best = max((d for d, _ in scored), default=0.0)
            top = [e for d, e in scored if d > 0.0 and d == best]
            if len(top) == 1:
                return top, ""
            if not top:
                return [], "no edge there has a normal with a positive dot product with the probe's ([W0-50])"
            cands = top
    if len(cands) > 1 and kind in ("face", "body"):
        return cands, (f"{len(cands)} {kind}s lie there with agreeing outward normals; §8.1 [W0-35]: more than "
                       "one left is not a match")
    return cands, ""


# ---------------------------------------------------------------------------------------------
# The recursive re-check of a query's geometric predicates and picks (three-valued)
# ---------------------------------------------------------------------------------------------

PASS, FAIL, UNCHECKED = "pass", "fail", "unchecked"


@dataclass
class Verdict:
    status: str
    reasons: tuple[str, ...] = ()


_OK = Verdict(PASS)


def _all(vs: Iterable[Verdict]) -> Verdict:
    """Every operand holds (three-valued AND); short-circuits on the first failure."""
    unc: list[str] = []
    for v in vs:
        if v.status == FAIL:
            return v
        if v.status == UNCHECKED:
            unc += v.reasons
    return Verdict(UNCHECKED, tuple(unc)) if unc else _OK


def _any(vs: Iterable[Verdict]) -> Verdict:
    """Some operand holds (three-valued OR); short-circuits on the first pass."""
    unc: list[str] = []
    fails: list[str] = []
    for v in vs:
        if v.status == PASS:
            return v
        (unc if v.status == UNCHECKED else fails).extend(v.reasons)
    if unc:
        return Verdict(UNCHECKED, tuple(unc))
    return Verdict(FAIL, tuple(fails[:4]) + ((f"… {len(fails) - 4} more",) if len(fails) > 4 else ()))


def _lazy(*thunks) -> Iterable[Verdict]:
    """Evaluate operands one at a time, so that `_all` / `_any` short-circuit."""
    return (t() for t in thunks)


def _margin(m: float, slack: float, strict: bool, what: str) -> Verdict:
    """A test that holds when its margin `m` ≥ 0, with the cross-engine allowance `slack`.
    Loose (may the member satisfy it?): m ≥ 0 passes, m ≥ −slack is unchecked, else fails.
    Strict (does it clearly satisfy it?): m > slack passes, m ≥ −slack is unchecked, else fails."""
    if not math.isfinite(m):
        return Verdict(UNCHECKED, (f"{what}: not evaluable",))
    if m > slack or (m >= 0.0 and not strict):
        return _OK
    if m >= -slack:
        return Verdict(UNCHECKED, (f"{what}: within the cross-engine tolerance of its bound (margin {m:.3g})",))
    return Verdict(FAIL, (f"{what} does not hold (margin {m:.3g})",))


class _Checker:
    """Does a replayed entity satisfy the geometric part of a query? (module docs, step 2)

    `check(q, e, strict=False)` asks whether `e` *may* be a member of `q` as far as geometry can
    tell (key-based sources pass); `strict=True` asks whether `e` is *clearly* a member (used for
    the `b` of `minus`, only when `b` is key-free)."""

    def __init__(self, scope: Scope):
        self.scope = scope
        self.ev = Evaluator(scope)
        self._pools: dict[int, Any] = {}

    # -- static facts about the query -------------------------------------------------------------
    def static_kind(self, q: dict) -> str | None:
        op = q.get("op")
        if op in KEYED_SOURCES:
            return KEYED_SOURCES[op]
        if op == "bodies":
            return "body"
        if op == "between":
            return "edge"
        if op in NAVIGATION:
            return NAVIGATION[op]
        if op == "tagged":
            f = self.scope.features.get(q.get("feature"))
            return f.tag_kind if f is not None else None
        if op in ("union", "intersect"):
            return self.static_kind(q["of"][0]) if q.get("of") else None
        if op == "minus":
            return self.static_kind(q["a"])
        if op == "filter" or op in PICKS:
            return self.static_kind(q["of"])
        return None

    def key_free(self, q: dict) -> bool:
        """Can membership in `q` be decided from geometry alone (no provenance key involved)?"""
        op = q.get("op")
        if op == "bodies":
            return True
        if op in KEYED_SOURCES:
            return False
        if op == "tagged":
            f = self.scope.features.get(q.get("feature"))
            return f is not None and f.ref is not None and self.key_free(f.ref["q"])
        if op in NAVIGATION or op == "filter" or op in PICKS:
            return self.key_free(q["of"])
        if op in ("union", "intersect"):
            return all(self.key_free(s) for s in q.get("of") or [])
        if op in ("minus", "between"):
            return self.key_free(q["a"]) and self.key_free(q["b"])
        return False

    def pool(self, q: dict, path: str) -> list:
        """The oracle's own evaluation of a sub-query (cached; raises RefFailure)."""
        k = id(q)
        if k not in self._pools:
            try:
                self._pools[k] = [e for e, _ in self.ev.eval(q, path)]
            except RefFailure as f:
                self._pools[k] = f
        r = self._pools[k]
        if isinstance(r, RefFailure):
            raise r
        return r

    # -- the check ----------------------------------------------------------------------------------
    def check(self, q: dict, e, path: str, strict: bool = False) -> Verdict:
        op = q.get("op")
        if op == "bodies":
            return _OK if e.kind == "body" else Verdict(FAIL, (f"{path}: a {e.kind} is not a body",))
        if op in KEYED_SOURCES:
            # provenance keys are not geometric: the set comparison (step 3) covers them
            return Verdict(UNCHECKED, (f"{path}: {op} is key-based",)) if strict else _OK
        if op == "tagged":
            f = self.scope.features.get(q.get("feature"))
            if f is None or f.ref is None:
                return Verdict(UNCHECKED, (f"{path}: tag {q.get('feature')!r} is not available",))
            return self.check(f.ref["q"], e, f"{path}(tag {q.get('feature')})", strict)
        if op in NAVIGATION:
            return self.navigation(q, e, path, strict)
        if op == "between":
            if e.kind != "edge":
                return Verdict(FAIL, (f"{path}: a {e.kind} is not an edge",))
            fs = e.body.faces_of_edge(e)
            if len(fs) != 2:
                return Verdict(FAIL, (f"{path}: the edge has {len(fs)} adjacent faces, not 2",))
            f0, f1 = fs
            return _any(_all(_lazy(lambda x=x: self.check(q["a"], x, f"{path}/a", strict),
                                   lambda y=y: self.check(q["b"], y, f"{path}/b", strict)))
                        for x, y in ((f0, f1), (f1, f0)))
        if op == "union":
            return _any(self.check(s, e, f"{path}/of/{i}", strict) for i, s in enumerate(q.get("of") or []))
        if op == "intersect":
            return _all(self.check(s, e, f"{path}/of/{i}", strict) for i, s in enumerate(q.get("of") or []))
        if op == "minus":
            va = self.check(q["a"], e, f"{path}/a", strict)
            if va.status == FAIL or not self.key_free(q["b"]):
                return va  # a key-based `b` is decided by the set comparison
            vb = self.check(q["b"], e, f"{path}/b", strict=True)
            if vb.status == PASS:
                return Verdict(FAIL, (f"{path}/b: excluded by `b`, which it clearly satisfies",))
            if vb.status == UNCHECKED:
                return _all([va, Verdict(UNCHECKED, (f"{path}/b: may be excluded by `b`",) + vb.reasons)])
            return va
        if op == "filter":
            return _all(_lazy(lambda: self.check(q["of"], e, f"{path}/of", strict),
                              lambda: self.predicate(q["where"], e, f"{path}/where", strict)))
        if op in PICKS:
            vo = self.check(q["of"], e, f"{path}/of", strict)
            if vo.status == FAIL:
                return vo
            return _all([vo, self.pick(q, e, path, strict)])
        return Verdict(UNCHECKED, (f"{path}: unknown op {op!r}",))

    def navigation(self, q: dict, e, path: str, strict: bool) -> Verdict:
        op = q["op"]
        if e.kind != NAVIGATION[op]:
            return Verdict(FAIL, (f"{path}: a {e.kind} is not among the {op} of anything",))
        kx = self.static_kind(q["of"])
        if kx is None:
            return Verdict(UNCHECKED, (f"{path}: the kind of `of` is unknown",))
        try:
            related = self.related(op, e, kx)
        except Exception as ex:  # noqa: BLE001 — adjacency on a body the oracle could not build
            return Verdict(UNCHECKED, (f"{path}: adjacency unavailable ({type(ex).__name__})",))
        if not related:
            return Verdict(FAIL, (f"{path}: it is not among the {op} of any {kx}",))
        return _any(self.check(q["of"], y, f"{path}/of", strict) for y in related)

    @staticmethod
    def related(op: str, e, kx: str) -> list:
        """The entities `y` of kind `kx` with `e` ∈ `op(y)` (inverse navigation, §5.3)."""
        if op == "owner":
            return list({"face": e.faces, "edge": e.edges, "vertex": e.vertices}.get(kx, []))
        if kx == "body":
            return [e.body]
        b = e.body
        inv = {("faces", "edge"): b.edges_of_face, ("faces", "vertex"): b.vertices_of_face,
               ("edges", "face"): b.faces_of_edge, ("edges", "vertex"): b.vertices_of_edge,
               ("vertices", "face"): b.faces_of_vertex, ("vertices", "edge"): b.edges_of_vertex}.get((op, kx))
        return inv(e) if inv is not None else []

    # -- predicates (§5.3) --------------------------------------------------------------------------
    def predicate(self, p: dict, e, path: str, strict: bool) -> Verdict:
        try:
            return self._predicate(p, e, path, strict)
        except RefFailure as f:
            return Verdict(UNCHECKED, (f"{path}: {f.code}",))
        except Exception as ex:  # noqa: BLE001 — a value or direction the oracle cannot evaluate
            return Verdict(UNCHECKED, (f"{path}: not evaluable ({type(ex).__name__}: {ex})",))

    def _predicate(self, p: dict, e, path: str, strict: bool) -> Verdict:
        (name, val), = p.items()
        what = f"{path} {{{name}: {val!r}}}"
        t = e.type
        no = Verdict(FAIL, (f"{what}: a {e.kind} of type {t} never satisfies it",))
        if name == "type":
            return _OK if t == val else Verdict(FAIL, (f"{what}: the type is {t}",))
        if name == "normal":
            if e.kind != "face" or t != "plane":
                return no
            d, _ = self.ev.dir_vec(val, f"{path}/normal")
            n = e.plane_normal()
            if n is None:
                return Verdict(UNCHECKED, (f"{what}: the face's normal is not evaluable",))
            return _margin(QUERY_ANGLE_TOLERANCE - geom.angle_between(n, d), ANGLE_SLACK, strict, what)
        if name in ("parallel", "perpendicular"):
            d, _ = self.ev.dir_vec(val, f"{path}/{name}")
            return self._orient(name, e, d, strict, what, no)
        if name in ("convex", "concave", "smooth"):
            if e.kind != "edge":
                return no
            a = material_angle(e)
            if a is None:
                return Verdict(UNCHECKED, (f"{what}: the material angle is not evaluable",))
            m = {"convex": (math.pi - QUERY_ANGLE_TOLERANCE) - a, "concave": a - (math.pi + QUERY_ANGLE_TOLERANCE),
                 "smooth": QUERY_ANGLE_TOLERANCE - abs(a - math.pi)}[name]
            return _margin(m, ANGLE_SLACK, strict, what)
        if name == "radius":
            if not ((e.kind == "face" and t in ("cylinder", "sphere", "torus")) or (e.kind == "edge" and t == "circle")):
                return no
            r = e.radius()
            if r is None:
                return Verdict(UNCHECKED, (f"{what}: the radius is not evaluable",))
            s = self.scope.scale
            ev = self.scope.eval_scalar

            def slack(bound: float) -> float:
                return max(REL_TOL * abs(bound), ABS_FLOOR * s)

            if "eq" in val:
                v = ev(val["eq"], "length", f"{path}/radius/eq")
                return _margin(LINEAR_TOLERANCE - abs(r - v), slack(v), strict, f"{what} (radius {r!r})")
            out = []
            if "min" in val:
                lo = ev(val["min"], "length", f"{path}/radius/min")
                out.append(_margin(r - lo, slack(lo), strict, f"{what} (radius {r!r})"))
            if "max" in val:
                hi = ev(val["max"], "length", f"{path}/radius/max")
                out.append(_margin(hi - r, slack(hi), strict, f"{what} (radius {r!r})"))
            return _all(out)
        return Verdict(UNCHECKED, (f"{what}: unknown predicate",))

    @staticmethod
    def _orient(name: str, e, d, strict: bool, what: str, no: Verdict) -> Verdict:
        def par(a):  # a ∥ d: |a × d| ≤ sin(tol)
            return _margin(SIN_QA - geom.norm(geom.cross(a, d)), ANGLE_SLACK, strict, what)

        def perp(a):  # a ⟂ d: |a · d| ≤ sin(tol)
            return _margin(SIN_QA - abs(geom.dot(a, d)), ANGLE_SLACK, strict, what)

        unk = Verdict(UNCHECKED, (f"{what}: the direction of the {e.kind} is not evaluable",))
        if e.kind == "edge":
            if e.type == "line":
                ld = e.line_direction()
                if ld is None:
                    return unk
                return par(ld) if name == "parallel" else perp(ld)
            if name == "perpendicular" and e.type == "circle":
                ca = e.circle_axis()
                return unk if ca is None else par(ca.direction)
            return no
        if e.kind != "face":
            return no
        if e.type == "plane":
            n = e.plane_normal()
            if n is None:
                return unk
            return perp(n) if name == "parallel" else par(n)
        if name == "parallel" and e.type in ("cylinder", "cone"):
            ax = e.surface_axis()
            return unk if ax is None else par(ax.direction)
        return no

    # -- picks (§5.3) --------------------------------------------------------------------------------
    def pick(self, q: dict, e, path: str, strict: bool) -> Verdict:
        op = q["op"]
        try:
            pool = self.pool(q["of"], f"{path}/of")
        except RefFailure as f:
            return Verdict(UNCHECKED, (f"{path}: the oracle cannot evaluate the pool of {op} ({f.code})",))
        if not pool:
            return Verdict(UNCHECKED, (f"{path}: the oracle's own pool of {op} is empty",))
        s = self.scope.scale
        if op == "extreme":
            try:
                d, _ = self.ev.dir_vec(q["dir"], f"{path}/dir")
            except Exception as ex:  # noqa: BLE001
                return Verdict(UNCHECKED, (f"{path}: the direction is not evaluable ({type(ex).__name__})",))
            sign = 1.0 if q.get("which") == "max" else -1.0

            def val(x):
                return sign * geom.dot(x.centroid, d)

            band, slack = LINEAR_TOLERANCE * s, POS_TOL * s
            what = f"{path}: extreme {q.get('which')}"
        else:
            sign = 1.0 if op == "largest" else -1.0

            def val(x):
                return sign * x.size

            best0 = max(x.size for x in pool) if op == "largest" else min(x.size for x in pool)
            band = QUERY_SIZE_TIE_REL * abs(best0)
            slack = size_pick_tolerance(best0, e.kind, s) - band
            what = f"{path}: {op}"
        best = max(val(x) for x in pool)
        short = best - val(e)  # ≤ 0: at least as good as every pool member
        if not strict:
            # Beyond the pool's best is not a pick failure: membership of the pool is key-based
            # (the set comparison covers it).
            return _margin(band - short, slack, False, f"{what} (short of the best by {short:.3g})")
        if not any(x is e for x in pool) or short > band + slack:
            return Verdict(FAIL, (f"{what}: not picked",))
        rivals = [x for x in pool if x is not e and best - val(x) <= band + slack]
        return Verdict(UNCHECKED, (f"{what}: a near-tie",)) if rivals else _OK


def size_pick_tolerance(best: float, kind: str, scale: float) -> float:
    """How far (in size units) a replayed largest/smallest member may be from the oracle's best:
    the SPEC's tie band (`QUERY_SIZE_TIE_REL`) plus the cross-engine size tolerance of v0 §6
    (`rel 1e-6`, absolute floor `1e-9·s^dim`), since Forge chose with its own sizes. A member
    beyond the tie band but within this is `ORACLE_PREDICATE_UNCHECKED`, beyond it
    `ORACLE_PREDICATE_FAILED`."""
    b = abs(best)
    return QUERY_SIZE_TIE_REL * b + max(REL_TOL * b, ABS_FLOOR * scale ** _SIZE_DIM.get(kind, 2))


def _recheck(field_path: str, ref: dict, card: Any, members: list, matched: list, scope: Scope) -> list[dict]:
    out: list[dict] = []
    ck = _Checker(scope)
    for m, e in matched:
        v = ck.check(ref["q"], e, f"{field_path}/q")
        if v.status == PASS:
            continue
        code = "ORACLE_PREDICATE_FAILED" if v.status == FAIL else "ORACLE_PREDICATE_UNCHECKED"
        verb = "fails the query's geometric predicates/picks" if v.status == FAIL else \
            "cannot be confirmed against the query's geometric predicates/picks"
        out.append(_finding(code, f"{field_path}: Forge's member {m.get('key')} {verb}: {'; '.join(v.reasons[:4])}",
                            {"field": field_path, "key": m.get("key"), "reasons": list(v.reasons[:8])}))
    keys = [m.get("key") for m in members]
    bad = check_card(card, members, len(set(map(str, keys))) == 1 and len(keys) > 1)
    if bad is not None:
        out.append(_finding("ORACLE_PREDICATE_FAILED",
                            f"{field_path}: Forge reports {len(members)} member(s) as resolved, the declared "
                            f"cardinality is {card!r} ({bad[0]})",
                            {"field": field_path, "card": card, "found": len(members)}))
    return out


def replay_ref(forge_entry: dict | None, field_path: str, ref: dict, card: Any, res: Any, scope: Scope, *,
               independent: bool = False, required: bool = True, adopt: bool = True) -> Replay:
    """Replay Forge's resolution of one Ref field (see the module docs). `res` is the oracle's own
    `query.Resolution`; `card` the field's effective cardinality.

    `required=False`: a missing entry is not `ORACLE_REF_UNREPORTED`; `adopt=False`: Forge's
    members are checked (steps 1–3) but never returned for building — both for a Ref nested in a
    query's Dir (`evaluate.Evaluator.query_axis`), which the oracle always resolves itself."""
    if not isinstance(forge_entry, dict):
        return Replay()
    refs = forge_entry.get("refs")
    fr = next((r for r in refs if isinstance(r, dict) and r.get("field") == field_path), None) \
        if isinstance(refs, list) else None
    if fr is None:
        if required and forge_entry.get("status") == "ok":
            return Replay(findings=[_finding(
                "ORACLE_REF_UNREPORTED",
                f"{field_path}: Forge reports the feature ok without a `refs` entry for this field (SPEC §5.8); "
                "nothing to replay, the oracle used its own resolution", {"field": field_path})])
        return Replay()
    if fr.get("status") == "failed":
        return Replay()
    raw = fr.get("members")
    members = [m if isinstance(m, dict) else {} for m in (raw if isinstance(raw, list) else [])]
    out = Replay()
    matched: list[tuple[dict, Any]] = []
    owner: dict[int, Any] = {}
    for m in members:
        cands, why = _match(scope, m.get("probe"))
        if len(cands) != 1:
            out.findings.append(_finding("ORACLE_PROBE_UNMATCHED",
                                         f"{field_path}: the probe of {m.get('key')} matches {len(cands)} OCCT entities"
                                         + (f": {why}" if why else ""),
                                         {"field": field_path, "key": m.get("key"), "matches": len(cands),
                                          **({"reason": why} if why else {})}))
            continue
        if id(cands[0]) in owner:
            out.findings.append(_finding("ORACLE_PROBE_UNMATCHED",
                                         f"{field_path}: the probes of {owner[id(cands[0])].get('key')} and "
                                         f"{m.get('key')} match the same OCCT entity",
                                         {"field": field_path, "key": m.get("key"), "matches": 1}))
            continue
        owner[id(cands[0])] = m
        matched.append((m, cands[0]))
    out.findings += _recheck(field_path, ref, card, members, matched, scope)
    if len(matched) != len(members):
        return out  # cannot replay: the oracle falls back to its own resolution
    theirs = {id(e) for _, e in matched}
    code = "ORACLE_REF_MISMATCH" if independent else "ORACLE_REF_DIFFERS"
    suffix = " (replayed Forge's members)" if adopt else \
        " (a Ref nested in a query Dir: checked, not adopted; the oracle used its own resolution)"
    if res.failure is None:
        mine = {id(e) for e in res.members}
        if mine != theirs:
            det = {"field": field_path,
                   "forge_only": sorted(e.key for _, e in matched if id(e) not in mine),
                   "oracle_only": sorted(e.key for e in res.members if id(e) not in theirs)}
            msg = f"{field_path}: Forge resolved {len(theirs)} entities, the oracle {len(mine)}; the sets differ"
            out.findings.append(_finding(code, msg + ("" if independent else suffix), det))
    else:
        out.findings.append(_finding(code,
                                     f"{field_path}: the oracle's own resolution fails with {res.failure.code}, "
                                     f"Forge resolved {len(theirs)} entities"
                                     + ("" if independent else suffix),
                                     {"field": field_path, "code": res.failure.code}))
    if independent or not adopt:
        return out
    ordered = [e for e, _ in canonical_order([(e, True) for _, e in matched], scope.scale)] \
        if all(getattr(e, "key", "") for _, e in matched) else [e for _, e in matched]
    by_id = {id(e): m for m, e in matched}
    out.members = ordered
    out.entry = {"field": field_path, "status": "exact", "members": [
        {"key": e.key or str(by_id[id(e)].get("key")),
         "name": display_name(e.key, scope.names) if e.key else str(by_id[id(e)].get("name", by_id[id(e)].get("key"))),
         "via": by_id[id(e)].get("via") if by_id[id(e)].get("via") in ("named", "broad") else "named",
         "status": by_id[id(e)].get("status") if by_id[id(e)].get("status") in MEMBER_STATUSES else "exact",
         "probe": e.probe()}
        for e in ordered]}
    if fr.get("status") == "accepted":
        out.entry["status"] = "accepted"
    return out
