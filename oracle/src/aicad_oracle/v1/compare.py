"""`kernel-diff` v1 (SPEC-v1 §8.2–§8.4): compare two `aicad.metrics/1` reports (A = Forge,
B = oracle) and classify the program. Pure functions: no I/O, no OCCT.

**Exact** (§8.2): document, parameter and feature `status`; semantic error codes; the set of
oracle-computable semantic warning codes per feature (`BOOLEAN_SPLIT`, `BOOLEAN_BODY_CONSUMED`,
`HOLE_BREAKS_THROUGH`, `PATTERN_INSTANCE_SKIPPED`, `SHELL_CLOSED_VOID`; plus `REF_*` in
independent-refs mode); `count` and `bool` parameter values; region count, `loops`,
`outer_curves`; bodies per feature and per part, their `origin`, `removed`; `faces`, `edges`,
`face_types`, `edge_types`, `shells`; hole `at` ids and count, pattern `instances` / `skipped`,
fillet / chamfer `edges`.

**Tolerance**: real parameters `|a − b| ≤ PARAM_VALUE_REL · max(1, |a|, |b|)`; volume, area,
centroid, bbox as v0 §6; datum / face-frame origins and hole centres `abs ≤ 1e-6·s`; datum
directions, normals and hole axes `abs ≤ 1e-9`; hole `d`, `depth` `abs ≤ 1e-9·s`.

**Body matching**: by `origin` (exact); bodies sharing an origin by nearest centroid, greedily in
canonical order.

**Classes and severity** (§8.4), most severe first: `POTENTIAL_SILENT_WRONG`, `REF_MISMATCH`,
`CODE_MISMATCH`, `ROBUSTNESS`, `NORMALIZED`, `MATCH`.

**Parameters**: a status or error-code disagreement is CODE_MISMATCH (expression evaluation is
fully specified and deterministic, so it is never mere robustness) unless an engine-internal code
is involved (ROBUSTNESS); `unit` is compared exactly; `bool` values must be bools on both sides.

Oracle replay findings (warnings the oracle attaches to its own feature entries, `replay.py`,
`evaluate.py`): `ORACLE_REPLAY_CHECK_FAILED` (a feature error: Forge's constrained-sketch
solution fails the independent check, or breaks the §4.4 rule 4 fixed point) and
`ORACLE_PREDICATE_FAILED` → POTENTIAL_SILENT_WRONG; `ORACLE_REF_MISMATCH` → REF_MISMATCH **only in
independent-refs mode** (§8.1, §8.4); in the default mode a set difference from the oracle's own
resolution (`ORACLE_REF_DIFFERS`) is ROBUSTNESS — never MATCH (W7 acceptance), never REF_MISMATCH
(§8.4); `ORACLE_PROBE_UNMATCHED`, `ORACLE_PREDICATE_UNCHECKED` and `ORACLE_REF_UNREPORTED` (Forge's
report lacks a §5.8 `refs` entry) → ROBUSTNESS; the constraint-replay findings on rules the SPEC
does not state — `ORACLE_TANGENCY_MODE_DIFFERS` (an arc–arc tangency at a joint solved in the other
mode than `internal` / the guess rule) and `ORACLE_REPLAY_SIZE_BOUND` (an angular constraint within
`SOLVE_CHECK_TOLERANCE` at the solver's scale but off by more than *tol* at the solved size) →
ROBUSTNESS; `ORACLE_NORMALIZED` (details `{rule}`) marks a MATCH that needed §8.3 rule 4 or 5 →
NORMALIZED. Reference replay findings are subject to the downstream cap below like every other
difference; a failed constrained-sketch replay check is not (it does not depend on the part state,
`_Cmp.oracle_findings`).

**Downstream of an engine divergence** (a policy of this tool, not of the SPEC; it needs owner
sign-off, see the README): after a feature on which the engines disagree about **status** (one
fails, the other not — including an engine-internal failure against an `ok`,
and a failed replay check), the two part states differ by construction (a failed feature passes
its input through, §7.1), so later differences *in the same part* (features and final bodies) are
capped at ROBUSTNESS — never reported as a silent-wrong answer, never hidden as MATCH. Every capped
difference is still listed (suffixed "downstream of …"), counted in `Comparison.capped`, and noted
per part, so the gap stays visible. When **both** engines fail a feature (whatever the codes,
engine-internal or not) both pass their input through, the part states stay identical, and later
features are classified normally.

**Malformed reports**: a compared field of the wrong JSON type (a report that violates the frozen
I5 interface) is a difference of that field's class, never an exception; duplicate parameters are
POTENTIAL_SILENT_WRONG.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from ..compare import ABS_FLOOR, POS_TOL, close_abs_vec, close_rel
from .consts import PARAM_VALUE_REL

MATCH = "MATCH"
NORMALIZED = "NORMALIZED"
ROBUSTNESS = "ROBUSTNESS"
CODE_MISMATCH = "CODE_MISMATCH"
REF_MISMATCH = "REF_MISMATCH"
SILENT_WRONG = "POTENTIAL_SILENT_WRONG"
CLASSES = (MATCH, NORMALIZED, ROBUSTNESS, CODE_MISMATCH, REF_MISMATCH, SILENT_WRONG)
_SEVERITY = {c: i for i, c in enumerate(CLASSES)}

ENGINE_PREFIXES = ("OCCT_", "FORGE_", "ORACLE_")
COMPARED_WARNINGS = ("BOOLEAN_SPLIT", "BOOLEAN_BODY_CONSUMED", "HOLE_BREAKS_THROUGH",
                     "PATTERN_INSTANCE_SKIPPED", "SHELL_CLOSED_VOID")
#: Solver outcomes the oracle replays but cannot compute (§8.1).
REPLAY_ONLY_CODES = ("SKETCH_CONSTRAINT_CONFLICT", "SKETCH_SOLVE_FAILED")
#: Oracle replay findings classified ROBUSTNESS (`replay.py`): the oracle could not confirm
#: Forge's resolution, or the two engines resolved a reference differently in the default mode.
#: `ORACLE_TANGENCY_MODE_DIFFERS` and `ORACLE_REPLAY_SIZE_BOUND` are constraint-replay findings on
#: rules the SPEC does not state (`constraints.py`): visible, never MATCH, never silent-wrong.
ROBUSTNESS_FINDINGS = ("ORACLE_PROBE_UNMATCHED", "ORACLE_PREDICATE_UNCHECKED", "ORACLE_REF_DIFFERS",
                       "ORACLE_REF_MISMATCH", "ORACLE_REF_UNREPORTED", "ORACLE_TANGENCY_MODE_DIFFERS",
                       "ORACLE_REPLAY_SIZE_BOUND")


def _dicts(x: Any) -> list[dict]:
    """The dict items of a list-valued report field (a malformed field yields nothing)."""
    return [v for v in x if isinstance(v, dict)] if isinstance(x, list) else []


def worst(*cs: str) -> str:
    return max(cs, key=lambda c: _SEVERITY[c]) if cs else MATCH


def is_internal(code: str | None) -> bool:
    return bool(code) and str(code).startswith(ENGINE_PREFIXES)


@dataclass
class Difference:
    path: str
    detail: str
    classification: str

    def __str__(self) -> str:
        return f"[{self.classification}] {self.path}: {self.detail}"


@dataclass
class Comparison:
    classification: str = MATCH
    differences: list[Difference] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    independent_refs: bool = False
    #: differences capped at ROBUSTNESS because they are downstream of an engine divergence
    capped: int = 0

    def add(self, path: str, detail: str, cls: str) -> None:
        self.differences.append(Difference(path, detail, cls))
        self.classification = worst(self.classification, cls)


def _num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _code(x: Any) -> str | None:
    if x is None:
        return None
    if not isinstance(x, dict):
        return f"<malformed error {x!r}>"
    return x.get("code")


def _skipped(p) -> Any:
    """A pattern summary's `skipped` in canonical form: the sorted index lists, a missing (or
    `null`) array read as `[]` (metrics-v1 makes it optional; Forge omits it when empty, the oracle
    writes `[]` — W7b review 4); a malformed one is a fresh object, equal to nothing."""
    s = _d(p).get("skipped")
    if s is None:
        return []
    if not isinstance(s, list) or not all(isinstance(x, list) and all(isinstance(i, int) for i in x) for x in s):
        return object()
    return sorted(s)


def _d(x: Any) -> dict:
    return x if isinstance(x, dict) else {}


def _vec3(x: Any) -> tuple | None:
    if isinstance(x, list) and len(x) == 3 and all(_num(v) for v in x):
        return tuple(float(v) for v in x)
    return None


def is_rejected(r: dict) -> bool:
    return bool(r.get("error")) and not r.get("features")


def _diag(b: Any) -> float:
    lo, hi = _vec3(_d(b).get("bbox_min")), _vec3(_d(b).get("bbox_max"))
    return math.dist(lo, hi) if lo is not None and hi is not None else 0.0


def _hist(h: Any) -> dict:
    if not isinstance(h, dict):
        return {"<invalid>": h}
    return {k: v for k, v in sorted(h.items()) if v != 0}


_ANALYTIC = ("plane", "cylinder", "cone", "sphere", "torus")


def _rule4_match(ha: dict, hb: dict, allowed=_ANALYTIC) -> bool:
    """§8.3 rule 4: the oracle (B) has k more `bspline` faces exactly where Forge (A) has k more of
    the normative blend types (`allowed`: the oracle's `ORACLE_NORMALIZED` details `types`);
    every other count agrees."""
    k = hb.get("bspline", 0) - ha.get("bspline", 0)
    if k <= 0:
        return False
    extra = 0
    for t in set(ha) | set(hb):
        if t == "bspline":
            continue
        d = ha.get(t, 0) - hb.get(t, 0)
        if d < 0 or (d > 0 and t not in allowed):
            return False
        extra += d
    return extra == k


def _origin_key(b: Any) -> tuple:
    o = _d(_d(b).get("origin"))
    inst = o.get("instance")
    return (o.get("feature"), o.get("member"), tuple(inst) if isinstance(inst, list) else (inst,) if inst else ())


def _label(f: Any) -> str:
    f = _d(f)
    return f"{f.get('part', '?')}/{f.get('feature', '?')}#{f.get('feature_id', '?')}({f.get('type', '?')})"


class _Cmp:
    def __init__(self, a: dict, b: dict, la: str, lb: str, cmp: Comparison):
        self.a, self.b, self.la, self.lb, self.cmp = a, b, la, lb, cmp
        self.cap: dict[str, str] = {}  # part name → reason downstream differences are capped
        self.capped: dict[str, int] = {}  # part name → number of capped differences
        #: §8.3 rules 4 and 5 (`ORACLE_NORMALIZED` on the oracle's feature): part → body origin →
        #: the rules that relax that body's comparison, from that feature on (the blend faces and
        #: corner patches stay on the body)
        self.relax: dict[Any, dict[tuple, set[str]]] = {}
        self.blend_types: dict[Any, dict[tuple, set[str]]] = {}

    def add(self, part: str | None, path: str, detail: str, cls: str) -> None:
        if part is not None and part in self.cap and _SEVERITY[cls] > _SEVERITY[ROBUSTNESS]:
            self.cmp.add(path, f"{detail} (downstream of {self.cap[part]}; would be {cls})", ROBUSTNESS)
            self.capped[part] = self.capped.get(part, 0) + 1
            self.cmp.capped += 1
            return
        self.cmp.add(path, detail, cls)

    def taint(self, part: str, why: str) -> None:
        self.cap.setdefault(part, why)

    # -- bodies -------------------------------------------------------------------------------
    def body(self, part, path: str, x: dict, y: dict) -> None:
        s = max(1.0, _diag(x), _diag(y))
        la, lb = self.la, self.lb
        rules = self.relax.get(part, {}).get(_origin_key(y), set())
        corner = "5" in rules  # §8.3 rule 5: counts and types not compared, volume/area at 1e-5
        blend_types = self.blend_types.get(part, {}).get(_origin_key(y), set(_ANALYTIC))
        for k in ("faces", "edges", "shells"):
            if corner and k != "shells":
                continue
            if x.get(k) != y.get(k):
                self.add(part, path, f"{k} {la}={x.get(k)} {lb}={y.get(k)}", SILENT_WRONG)
        for k in ("face_types", "edge_types"):
            if corner:
                continue
            ha, hb = _hist(x.get(k)), _hist(y.get(k))
            if ha != hb and not (k == "face_types" and "4" in rules and _rule4_match(ha, hb, blend_types)):
                self.add(part, path, f"{k} {la}={ha} {lb}={hb}", SILENT_WRONG)
        if corner:
            for k in ("volume", "area"):
                u, v = x.get(k), y.get(k)
                if not (_num(u) and _num(v) and abs(u - v) <= 1e-5 * max(abs(u), abs(v))):
                    self.add(part, path, f"{k} {la}={u!r} {lb}={v!r} (§8.3 rule 5: allowed 1e-5 relative)",
                             SILENT_WRONG)
        ok, allowed = close_rel(x.get("volume"), y.get("volume"), ABS_FLOOR * s ** 3)
        if not ok and not corner:
            self.add(part, path, f"volume {la}={x.get('volume')!r} {lb}={y.get('volume')!r} (allowed ±{allowed:.3g})",
                     SILENT_WRONG)
        ok, allowed = close_rel(x.get("area"), y.get("area"), ABS_FLOOR * s ** 2)
        if not ok and corner:
            ok = True
        if not ok:
            self.add(part, path, f"area {la}={x.get('area')!r} {lb}={y.get('area')!r} (allowed ±{allowed:.3g})",
                     SILENT_WRONG)
        for k in ("centroid", "bbox_min", "bbox_max"):
            if not close_abs_vec(x.get(k), y.get(k), POS_TOL * s):
                self.add(part, path, f"{k} {la}={x.get(k)} {lb}={y.get(k)} (allowed ±{POS_TOL * s:.3g})",
                         SILENT_WRONG)

    def bodies(self, part, path: str, ba: list, bb: list) -> None:
        """Match by origin (exact), same-origin pieces by nearest centroid, greedily."""
        if not isinstance(ba, list) or not isinstance(bb, list):
            self.add(part, f"{path}.bodies", f"malformed bodies {self.la}={ba!r} {self.lb}={bb!r}", SILENT_WRONG)
            return
        pool = list(enumerate(bb))

        def dist(u, v) -> float:
            p, q = _vec3(_d(u).get("centroid")), _vec3(_d(v).get("centroid"))
            return math.dist(p, q) if p is not None and q is not None else math.inf

        for i, x in enumerate(ba):
            if not isinstance(x, dict):
                self.add(part, f"{path}.bodies[{i}]", f"malformed body {x!r} in {self.la}", SILENT_WRONG)
                continue
            same = [(j, y) for j, y in pool if isinstance(y, dict) and _origin_key(y) == _origin_key(x)]
            if not same:
                self.add(part, f"{path}.bodies[{i}]", f"body with origin {x.get('origin')} missing in {self.lb}",
                         SILENT_WRONG)
                continue
            j, y = min(same, key=lambda jy: (dist(x, jy[1]), jy[0]))
            pool.remove((j, y))
            self.body(part, f"{path}.bodies[{i}] origin={x.get('origin')}", x, y)
        for j, y in pool:
            self.add(part, f"{path}.bodies", f"body with origin {_d(y).get('origin')} missing in {self.la}", SILENT_WRONG)

    # -- features ---------------------------------------------------------------------------------
    def valid_bodies(self, r: dict, label: str) -> None:
        """[R-12] per report: every body of an ok feature, and every final body, is valid."""
        for i, f in enumerate(_dicts(r.get("features"))):
            if f.get("status") != "ok":
                continue
            for j, bd in enumerate(_dicts(f.get("bodies"))):
                if bd.get("valid") is not True:
                    self.cmp.add(f"features[{i}] {_label(f)}.bodies[{j}]",
                                 f"{label} reports a body with valid={bd.get('valid')} as ok [R-12]", SILENT_WRONG)
        for p in _dicts(r.get("parts")):
            for j, bd in enumerate(_dicts(p.get("bodies"))):
                if bd.get("valid") is not True:
                    self.cmp.add(f"parts[{p.get('part')}].bodies[{j}]",
                                 f"{label} reports a final body with valid={bd.get('valid')} [R-12]", SILENT_WRONG)

    def oracle_findings(self, i: int, fb: dict) -> None:
        """Replay findings of the oracle (B) on its own feature entry.

        Reference findings go through `add`, so the downstream cap applies to them like to every
        other difference: after a status divergence the oracle's part state differs from Forge's
        and Forge's probes are replayed onto a different B-rep, so a failed predicate there is
        capped at ROBUSTNESS (still listed and counted), never a silent-wrong answer.

        `ORACLE_REPLAY_CHECK_FAILED` (a constrained sketch) deliberately **bypasses** the cap: the
        check depends only on the document, the oracle's own parameter values (measured
        parameters, the only state-dependent ones, are deferred to v1.1) and Forge's reported
        `sketch.solved` / `sketch.dimensions` — not on the B-rep (it is 2D; a plane reference the
        oracle cannot resolve in a divergent state fails the feature *before* the check, which is
        then a capped status divergence). So a failed check is Forge's wrong solution wherever it
        occurs."""
        part = fb.get("part")
        path = f"features[{i}] {_label(fb)}"
        if _code(fb.get("error")) == "ORACLE_REPLAY_CHECK_FAILED":
            self.cmp.add(path, f"the reference's solution fails the oracle's independent check: "
                               f"{(fb.get('error') or {}).get('message', '')}", SILENT_WRONG)
            self.taint(part, "a failed replay check")
        for w in _dicts(fb.get("warnings")):
            c = w.get("code")
            msg = str(w.get("message", c))
            if c == "ORACLE_PREDICATE_FAILED":
                self.add(part, path, msg, SILENT_WRONG)
            elif c == "ORACLE_REF_MISMATCH" and self.cmp.independent_refs:
                self.add(part, path, msg, REF_MISMATCH)
            elif c in ROBUSTNESS_FINDINGS:
                # Includes a set difference from the oracle's own resolution in the default mode
                # (`ORACLE_REF_DIFFERS`; `ORACLE_REF_MISMATCH` of an independent-refs oracle report
                # read in the default mode): REF_MISMATCH is independent-refs only (§8.4), but a
                # reference the engines resolve differently is never a MATCH (W7 acceptance).
                self.add(part, path, msg, ROBUSTNESS)

    def feature(self, i: int, fa: dict, fb: dict) -> None:
        part = fa.get("part")
        path = f"features[{i}] {_label(fa)}"
        sa, sb = fa.get("status"), fb.get("status")
        ca, cb = _code(fa.get("error")), _code(fb.get("error"))
        self.oracle_findings(i, fb)
        rules = {str(_d(w.get("details")).get("rule")) for w in _dicts(fb.get("warnings"))
                 if w.get("code") == "ORACLE_NORMALIZED"} & {"4", "5"}
        if rules:
            types = set()
            for w in _dicts(fb.get("warnings")):
                if w.get("code") == "ORACLE_NORMALIZED" and str(_d(w.get("details")).get("rule")) == "4":
                    t = _d(w.get("details")).get("types")
                    types |= set(t) if isinstance(t, list) else set(_ANALYTIC)
            for bd in _dicts(fb.get("bodies")):
                self.relax.setdefault(part, {}).setdefault(_origin_key(bd), set()).update(rules)
                if types:
                    self.blend_types.setdefault(part, {}).setdefault(_origin_key(bd), set()).update(types)
        if ca == "ORACLE_REPLAY_CHECK_FAILED" or cb == "ORACLE_REPLAY_CHECK_FAILED":
            return
        if sa != sb:
            self.add(part, path, f"status {self.la}={sa}{f' [{ca}]' if ca else ''} "
                                 f"{self.lb}={sb}{f' [{cb}]' if cb else ''}", ROBUSTNESS)
            self.taint(part, f"{_label(fa)} ({self.la}={sa}, {self.lb}={sb})")
            return
        if sa == "error":
            # Both engines failed the feature, so both passed their input through (§7.1): the part
            # states stay identical and later features are classified normally (no capping).
            if is_internal(ca) or is_internal(cb):
                self.add(part, path, f"engine-internal error {self.la}={ca} {self.lb}={cb}", ROBUSTNESS)
            elif ca != cb:
                self.add(part, path, f"error code {self.la}={ca} {self.lb}={cb}", CODE_MISMATCH)
            elif ca in REPLAY_ONLY_CODES:
                self.cmp.notes.append(f"{path}: {ca} replayed from the reference, not computed")
            return
        # §8.2: the *set* of oracle-computable warning codes (multiplicity is not compared).
        wa = sorted({str(w.get("code")) for w in _dicts(fa.get("warnings")) if w.get("code") in COMPARED_WARNINGS})
        wb = sorted({str(w.get("code")) for w in _dicts(fb.get("warnings")) if w.get("code") in COMPARED_WARNINGS})
        if self.cmp.independent_refs:
            wa = sorted(set(wa) | {str(w.get("code")) for w in _dicts(fa.get("warnings"))
                                   if str(w.get("code", "")).startswith("REF_")})
            wb = sorted(set(wb) | {str(w.get("code")) for w in _dicts(fb.get("warnings"))
                                   if str(w.get("code", "")).startswith("REF_")})
        if wa != wb:
            self.add(part, path, f"warning codes {self.la}={wa} {self.lb}={wb}", CODE_MISMATCH)
        ra, rb = fa.get("regions") or [], fb.get("regions") or []
        if not isinstance(ra, list) or not isinstance(rb, list) or len(ra) != len(rb):
            n = [len(x) if isinstance(x, list) else repr(x) for x in (ra, rb)]
            self.add(part, path, f"region count {self.la}={n[0]} {self.lb}={n[1]}", SILENT_WRONG)
        else:
            for k, (x, y) in enumerate(zip(ra, rb)):
                p = f"{path}.regions[{k}]"
                x, y = _d(x), _d(y)
                for key in ("outer_curves", "loops"):
                    if x.get(key) != y.get(key) or key not in x:
                        self.add(part, p, f"{key} {self.la}={x.get(key)} {self.lb}={y.get(key)}", SILENT_WRONG)
                ok, allowed = close_rel(x.get("area"), y.get("area"), ABS_FLOOR)
                if not ok:
                    self.add(part, p, f"area {self.la}={x.get('area')!r} {self.lb}={y.get('area')!r}", SILENT_WRONG)
        self.bodies(part, path, fa.get("bodies") or [], fb.get("bodies") or [])
        rma, rmb = fa.get("removed") or [], fb.get("removed") or []
        oa = sorted(map(str, (_origin_key({"origin": o}) for o in rma))) if isinstance(rma, list) else [repr(rma)]
        ob = sorted(map(str, (_origin_key({"origin": o}) for o in rmb))) if isinstance(rmb, list) else [repr(rmb)]
        if oa != ob:
            self.add(part, path, f"removed {self.la}={fa.get('removed')} {self.lb}={fb.get('removed')}", SILENT_WRONG)
        self.datum(part, path, fa.get("datum"), fb.get("datum"))
        self.summaries(part, path, fa, fb)
        norm = [w for w in _dicts(fb.get("warnings")) if w.get("code") == "ORACLE_NORMALIZED"]
        if norm:
            rules = sorted({str(_d(w.get("details")).get("rule")) for w in norm})
            self.cmp.add(path, f"matched after §8.3 normalization rule(s) {', '.join(rules)}", NORMALIZED)

    def datum(self, part, path: str, da, db) -> None:
        if da is None and db is None:
            return
        if (da is None) != (db is None) or not isinstance(da, dict) or not isinstance(db, dict):
            self.add(part, path, f"datum {self.la}={da} {self.lb}={db}", SILENT_WRONG)
            return
        s = self.scale(part)
        for k, v in da.items():
            w = db.get(k)
            tol = POS_TOL * s if k == "origin" else 1e-9
            if not (isinstance(v, list) and isinstance(w, list) and len(v) == len(w) == 3
                    and all(_num(x) and _num(y) and abs(x - y) <= tol for x, y in zip(v, w))):
                self.add(part, f"{path}.datum.{k}", f"{self.la}={v} {self.lb}={w} (allowed ±{tol:.3g})", SILENT_WRONG)
        if set(da) != set(db):
            self.add(part, f"{path}.datum", f"fields {self.la}={sorted(da)} {self.lb}={sorted(db)}", SILENT_WRONG)

    def summaries(self, part, path: str, fa: dict, fb: dict) -> None:
        ha, hb = fa.get("holes"), fb.get("holes")
        if ha is not None or hb is not None:
            ha, hb = ha or [], hb or []
            if not (isinstance(ha, list) and isinstance(hb, list)
                    and all(isinstance(h, dict) for h in ha) and all(isinstance(h, dict) for h in hb)):
                self.add(part, f"{path}.holes", f"malformed holes {self.la}={ha!r} {self.lb}={hb!r}", SILENT_WRONG)
            elif [h.get("at") for h in ha] != [h.get("at") for h in hb]:
                self.add(part, f"{path}.holes", f"at {self.la}={[h.get('at') for h in ha]} "
                                                f"{self.lb}={[h.get('at') for h in hb]}", SILENT_WRONG)
            else:
                s = self.scale(part)
                for x, y in zip(ha, hb):
                    p = f"{path}.holes[{x.get('at')}]"
                    if not close_abs_vec(x.get("center"), y.get("center"), POS_TOL * s):
                        self.add(part, p, f"center {x.get('center')} {y.get('center')}", SILENT_WRONG)
                    if not close_abs_vec(x.get("axis"), y.get("axis"), 1e-9):
                        self.add(part, p, f"axis {x.get('axis')} {y.get('axis')}", SILENT_WRONG)
                    for k in ("d", "depth"):
                        u, v = x.get(k), y.get(k)
                        if u is None and v is None:
                            continue
                        if not (_num(u) and _num(v) and abs(u - v) <= 1e-9 * s):
                            self.add(part, p, f"{k} {u!r} {v!r}", SILENT_WRONG)
        pa, pb = fa.get("pattern"), fb.get("pattern")
        if (pa or pb) and (not isinstance(pa or {}, dict) or not isinstance(pb or {}, dict)
                           or _d(pa).get("instances") != _d(pb).get("instances")
                           or _skipped(pa) != _skipped(pb)):
            self.add(part, f"{path}.pattern", f"{self.la}={pa} {self.lb}={pb}", SILENT_WRONG)
        for k in ("fillet", "chamfer"):
            xa, xb = fa.get(k), fb.get(k)
            if not (xa or xb):
                continue
            ea, eb = _d(xa).get("edges") or [], _d(xb).get("edges") or []
            if (not isinstance(xa or {}, dict) or not isinstance(xb or {}, dict)
                    or not isinstance(ea, list) or not isinstance(eb, list)
                    or sorted(map(str, ea)) != sorted(map(str, eb))):
                self.add(part, f"{path}.{k}", f"edges {self.la}={xa} {self.lb}={xb}", SILENT_WRONG)

    def scale(self, part) -> float:
        diags = [1.0]
        for r in (self.a, self.b):
            for p in _dicts(r.get("parts")):
                if p.get("part") == part:
                    diags += [_diag(b) for b in _dicts(p.get("bodies"))]
        return max(diags)

    # -- params -------------------------------------------------------------------------------
    def _param_map(self, r: dict, label: str) -> dict:
        out: dict = {}
        ps = r.get("params") or []
        if not isinstance(ps, list):
            self.cmp.add("params", f"{label} reports malformed params {ps!r}", SILENT_WRONG)
            return out
        for i, p in enumerate(ps):
            if not isinstance(p, dict):
                self.cmp.add(f"params[{i}]", f"{label} reports a malformed parameter {p!r}", SILENT_WRONG)
                continue
            k = (p.get("scope"), p.get("name"))
            if k in out:
                self.cmp.add(f"params[{k[0]}/{k[1]}]", f"{label} reports the parameter twice", SILENT_WRONG)
                continue
            out[k] = p
        return out

    def params(self) -> None:
        pa = self._param_map(self.a, self.la)
        pb = self._param_map(self.b, self.lb)
        for k in sorted(set(pa) | set(pb), key=str):
            x, y = pa.get(k), pb.get(k)
            path = f"params[{k[0]}/{k[1]}]"
            if x is None or y is None:
                self.cmp.add(path, f"missing in {self.lb if y is None else self.la}", SILENT_WRONG)
                continue
            if x.get("unit") != y.get("unit"):
                self.cmp.add(path, f"unit {self.la}={x.get('unit')!r} {self.lb}={y.get('unit')!r}", SILENT_WRONG)
            ea, eb = _code(x.get("error")), _code(y.get("error"))
            if ea != eb:
                # §2.7: evaluation is fully specified and deterministic, so a disagreement on a
                # parameter's status or code is a semantic difference, unless an engine-internal
                # code is involved.
                cls = ROBUSTNESS if is_internal(ea) or is_internal(eb) else CODE_MISMATCH
                what = "status" if (ea is None) != (eb is None) else "error code"
                self.cmp.add(path, f"{what} {self.la}={ea or 'ok'} {self.lb}={eb or 'ok'}", cls)
                continue
            if ea is not None:
                continue
            u, v = x.get("value"), y.get("value")
            unit = x.get("unit")
            if unit in ("bool", "count") or isinstance(u, bool) or isinstance(v, bool):
                if u != v or (type(u) is bool) != (type(v) is bool):
                    self.cmp.add(path, f"value {self.la}={u!r} {self.lb}={v!r}", SILENT_WRONG)
            elif not (_num(u) and _num(v) and abs(u - v) <= PARAM_VALUE_REL * max(1.0, abs(u), abs(v))):
                self.cmp.add(path, f"value {self.la}={u!r} {self.lb}={v!r} (allowed rel {PARAM_VALUE_REL:g})",
                             SILENT_WRONG)

    # -- document -----------------------------------------------------------------------------
    def run(self) -> None:
        a, b = self.a, self.b
        if not isinstance(a, dict) or not isinstance(b, dict):
            self.cmp.add("document", f"malformed report {self.la}={type(a).__name__} {self.lb}={type(b).__name__}",
                         SILENT_WRONG)
            return
        self.valid_bodies(a, self.la)
        self.valid_bodies(b, self.lb)
        ra, rb = is_rejected(a), is_rejected(b)
        if ra and rb:
            if _code(a.get("error")) != _code(b.get("error")):
                self.cmp.notes.append(f"both rejected; codes {self.la}={_code(a.get('error'))} "
                                      f"{self.lb}={_code(b.get('error'))} (rejections are not compared)")
            return
        if ra or rb:
            who = self.la if ra else self.lb
            self.cmp.add("document", f"only {who} rejected the document ({_code((a if ra else b).get('error'))})",
                         ROBUSTNESS)
            return
        self.params()
        fa, fb = a.get("features") or [], b.get("features") or []
        if not isinstance(fa, list) or not isinstance(fb, list):
            self.cmp.add("features", f"malformed features {self.la}={type(fa).__name__} {self.lb}={type(fb).__name__}",
                         SILENT_WRONG)
            fa, fb = _dicts(fa), _dicts(fb)
        for i in range(max(len(fa), len(fb))):
            if i >= len(fa) or i >= len(fb):
                present = fa[i] if i < len(fa) else fb[i]
                self.cmp.add(f"features[{i}]", f"{_label(present)} missing in {self.la if i >= len(fa) else self.lb}",
                             SILENT_WRONG)
                continue
            x, y = fa[i], fb[i]
            if not isinstance(x, dict) or not isinstance(y, dict):
                self.cmp.add(f"features[{i}]", f"malformed feature entry {self.la}={x!r} {self.lb}={y!r}", SILENT_WRONG)
                continue
            ka = (x.get("part"), x.get("feature"), x.get("feature_id"), x.get("type"))
            kb = (y.get("part"), y.get("feature"), y.get("feature_id"), y.get("type"))
            if ka != kb:
                self.cmp.add(f"features[{i}]", f"feature identity {self.la}={_label(x)} {self.lb}={_label(y)}",
                             SILENT_WRONG)
                continue
            try:
                self.feature(i, x, y)
            except (TypeError, AttributeError, KeyError, ValueError) as e:  # a field of the wrong JSON type
                self.add(x.get("part"), f"features[{i}] {_label(x)}",
                         f"malformed report field ({type(e).__name__}: {e})", SILENT_WRONG)
        pa = {p.get("part"): p for p in _dicts(a.get("parts"))}
        pb = {p.get("part"): p for p in _dicts(b.get("parts"))}
        for name in sorted(set(pa) | set(pb), key=str):
            if name not in pa or name not in pb:
                self.cmp.add(f"parts[{name}]", f"missing in {self.la if name not in pa else self.lb}", SILENT_WRONG)
                continue
            self.bodies(name, f"parts[{name}]", pa[name].get("bodies") or [], pb[name].get("bodies") or [])
        if a.get("status") != b.get("status") and not self.cmp.differences:
            self.cmp.add("status", f"document status {self.la}={a.get('status')} {self.lb}={b.get('status')}",
                         ROBUSTNESS)
        for part, why in self.cap.items():
            n = self.capped.get(part, 0)
            self.cmp.notes.append(f"part {part!r}: {n} difference(s) after {why} capped at ROBUSTNESS")


def compare_reports(a: dict, b: dict, label_a: str = "forge", label_b: str = "oracle", *,
                    independent_refs: bool = False) -> Comparison:
    """Compare two `aicad.metrics/1` reports per SPEC-v1 §8.2–§8.4 (A = Forge, B = oracle)."""
    cmp = Comparison(independent_refs=independent_refs)
    _Cmp(a, b, label_a, label_b, cmp).run()
    return cmp


__all__ = ["compare_reports", "Comparison", "Difference", "CLASSES", "MATCH", "NORMALIZED", "ROBUSTNESS",
           "CODE_MISMATCH", "REF_MISMATCH", "SILENT_WRONG", "worst"]
