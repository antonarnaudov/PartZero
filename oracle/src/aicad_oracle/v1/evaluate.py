"""Evaluate an IR v1 document (SPEC-v1 §7) and emit its `aicad.metrics/1` report (interface I5).

What the oracle **computes** and what it **replays** (SPEC §8.1):

| Item | Oracle |
|---|---|
| parameters and expressions | computes (`expr.py`: own parser, type checker, evaluator) |
| explicit sketches, compound curves, regions | computes (`compound.py`, the v0 `sketch.py`) |
| constrained sketches | standalone: computes only the §4.4 rule 4 fixed point (the welded stored guess, when it already satisfies every driving constraint); otherwise **replays** the numbers of Forge's `sketch.solved` on the document's own curve structure, after the independent check of `constraints.py` (structure, residuals, welds, dimension values, and bit-identity with a clear fixed point; `--replay` / `oracle diff`); `DEGENERATE_CURVE` applies to the result |
| datum frames, face frames, axes | computes |
| references | standalone: computes them itself over its own OCCT bodies and keys (`query.py`). With a Forge report (default mode, the §8.1 PR/nightly gate): **replays** Forge's members by probe, re-checks the query's geometric predicates and picks (recursively) and the cardinality on them, and builds from them (`replay.py`); a set difference from its own resolution is ROBUSTNESS (`ORACLE_REF_DIFFERS`). With `independent_refs`: builds from its own resolution and reports a difference as `ORACLE_REF_MISMATCH`. A Ref nested in a query's Dir (an AxisRef, §3.2) is always the oracle's own resolution; Forge's entry for it, when reported, is checked like a field but never adopted (`Evaluator.query_axis`) |
| extrude / revolve | computes (the v0 construction and body gate), `new_body`, `join`, `cut`, `intersect` (`booleans.py`) |
| boolean | computes (`booleans.py`) |
| hole, fillet, chamfer, shell, draft, pattern | not yet (W7b/W7c): the feature fails with the engine-internal `ORACLE_UNSUPPORTED_FEATURE` |

Engine-internal codes are prefixed `OCCT_` / `ORACLE_` (v0 [R-12]); `kernel-diff` classifies a
disagreement on them as ROBUSTNESS, never as a silent-wrong answer, and never as MATCH.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from .. import ir as ir0
from ..sketch import SketchError, evaluate_sketch
from . import compound, constraints, expr, geom, query
from .consts import (
    ANGULAR_TOLERANCE,
    LINEAR_TOLERANCE,
    METRICS_SCHEMA,
    QUERY_ANGLE_TOLERANCE,
    SOLVE_CHECK_TOLERANCE,
    SOLVE_TOLERANCE,
)
from .load import Loaded, Rejected, load_text, load_value
from .sweeps import FeatureFailure, build_extrude, build_revolve, check_revolve_profile
from .topo import Body, TopoError, body_report, canonical_bodies
from .validate import Scope as NameScope
from .validate import feature_sites, param_decls

TOL = LINEAR_TOLERANCE


def _engine() -> str:
    from ..occt import engine_string

    return engine_string()


def _err(code: str, message: str, details: dict | None = None) -> dict:
    return {"code": code, "message": message, "details": details or {}}


def _z(v):
    return 0.0 if isinstance(v, float) and v == 0.0 else v


# ---------------------------------------------------------------------------------------------
# Parameters (§2.1, §2.8)
# ---------------------------------------------------------------------------------------------

@dataclass
class ParamResult:
    value: Any = None  # float or bool when ok
    error: dict | None = None


class Params:
    def __init__(self, doc: dict):
        self.doc = doc
        self.names = NameScope(doc)
        self.decls = param_decls(doc)
        self.results: dict[str, ParamResult] = {}  # by parameter path
        self._checked: dict[tuple[str, str, Any], expr.Checked] = {}

    def checked(self, text: str, fld: str, scope: int | None) -> expr.Checked:
        k = (text, fld, scope)
        if k not in self._checked:
            self._checked[k] = expr.check(text, fld, self.names.types(scope),
                                          other_parts=self.names.other_parts(scope),
                                          features=self.names.features)
        return self._checked[k]

    def decl_for(self, name: str, scope: int | None):
        return self.names.visible(scope).get(name)

    def failed_use(self, uses: list[str], scope: int | None) -> dict | None:
        """The PARAM_FAILED error for the first used parameter that failed (§2.8 rule 5)."""
        for n in uses:
            d = self.decl_for(n, scope)
            if d is None:
                continue
            r = self.evaluate(d)
            if r.error is not None:
                root = r.error["details"].get("code", r.error["code"]) if r.error["code"] == "PARAM_FAILED" else r.error["code"]
                return _err("PARAM_FAILED", f"parameter {n!r} failed with {root}", {"param": n, "code": r.error["code"]})
        return None

    def env(self, uses: list[str], scope: int | None) -> dict[str, Any]:
        """Values of the parameters an expression uses (only those: evaluating every visible
        parameter would evaluate parameters out of dependency order)."""
        out = {}
        for n in uses:
            d = self.decl_for(n, scope)
            if d is None:
                continue
            r = self.evaluate(d)
            if r.error is None:
                out[n] = r.value
        return out

    def scalar(self, v: Any, fld: str, scope: int | None) -> Any:
        """Evaluate a Scalar/BoolScalar/param value. Raises FeatureFailure."""
        if isinstance(v, bool):
            return v
        if isinstance(v, (int, float)):
            return float(v)
        ch = self.checked(v, fld, scope)
        bad = self.failed_use(ch.uses, scope)
        if bad is not None:
            raise FeatureFailure(bad["code"], bad["message"], bad["details"])
        try:
            return expr.evaluate(ch.ast, self.env(ch.uses, scope), text=v, fld=fld)
        except expr.ExprError as e:
            raise FeatureFailure(e.code, e.message, e.details) from None

    def evaluate(self, d) -> ParamResult:
        if d.path in self.results:
            return self.results[d.path]
        self.results[d.path] = ParamResult(error=_err("PARAM_CYCLE", "cycle"))  # guard; cycles are rejected
        p = d.decl
        fld = expr.UNIT_FIELD[p["unit"]]
        try:
            v = self.scalar(p["value"], fld, d.part)
            lo = self.scalar(p["min"], fld, d.part) if "min" in p else None
            hi = self.scalar(p["max"], fld, d.part) if "max" in p else None
            if not isinstance(v, bool) and ((lo is not None and v < lo) or (hi is not None and v > hi)):
                raise FeatureFailure("PARAM_OUT_OF_RANGE", f"{p['name']} = {v} is outside [{lo}, {hi}]",
                                     {"name": p["name"], "value": v, "min": lo, "max": hi})
            res = ParamResult(value=_z(v))
        except FeatureFailure as f:
            res = ParamResult(error=_err(f.code, f.message, f.details))
        self.results[d.path] = res
        return res

    def report(self) -> list[dict]:
        out = []
        for d in self.decls:
            r = self.evaluate(d)
            e: dict = {"name": d.name, "scope": "doc" if d.part is None else self.doc["parts"][d.part]["name"],
                       "unit": d.unit}
            if r.error is None:
                e["value"] = r.value
            else:
                e["error"] = r.error
            out.append(e)
        return out


# ---------------------------------------------------------------------------------------------
# Per-feature evaluation state
# ---------------------------------------------------------------------------------------------

@dataclass
class SketchEval:
    plane: ir0.ResolvedPlane
    profile: list  # v0 Line/Arc/Circle of the profile (points and construction removed)
    regions: list
    all_curves: list[dict]  # LiteralCurve dicts (the report's `solved`)
    member_ids: dict[str, list[str]] = field(default_factory=dict)


@dataclass
class DatumEval:
    plane: ir0.ResolvedPlane | None = None
    axis: geom.Axis | None = None


class PartState:
    def __init__(self, pi: int, part: dict):
        self.pi = pi
        self.part = part
        self.bodies: list[Body] = []
        self.features: dict[str, query.FeatState] = {}
        self.sketches: dict[str, SketchEval] = {}
        self.datums: dict[str, DatumEval] = {}
        self.names: dict[str, str] = {}
        self.tainted = False


class Evaluator:
    def __init__(self, loaded: Loaded, name: str, *, replay: dict | None = None,
                 gate: list | None = None, shapes: list | None = None, independent_refs: bool = False):
        self.loaded = loaded
        self.doc = loaded.doc
        self.name = name
        self.replay = replay
        #: §8.1 independent-refs mode: build from the oracle's own resolution, and report a
        #: difference from Forge's members as ORACLE_REF_MISMATCH (REF_MISMATCH).
        self.independent_refs = independent_refs
        self.gate = gate
        self.shapes = shapes
        self.params = Params(self.doc)
        self.features_out: list[dict] = []
        self.parts_out: list[dict] = []
        #: per feature: the feature, and the replay findings of Refs nested in query Dirs
        #: (`query_axis`), once per JSON pointer
        self._current_feature: dict = {}
        self._nested_seen: set[str] = set()
        self._nested_findings: list[dict] = []

    # -- entry --------------------------------------------------------------------------------
    def run(self) -> dict:
        params = self.params.report()
        for pi, part in enumerate(self.doc["parts"]):
            st = PartState(pi, part)
            for fi, f in enumerate(part["features"]):
                self.feature(st, fi, f)
            self.parts_out.append({
                "part": part["name"], "part_id": part["id"],
                "bodies": [body_report(b) for b in canonical_bodies(st.bodies)],
            })
            if self.shapes is not None:
                for b in st.bodies:
                    self.shapes.append((f"{b.feature}@{b.member}", 0, b.solid))
        ok = all("error" not in p for p in params) and all(f["status"] == "ok" for f in self.features_out)
        rep: dict = {"schema": METRICS_SCHEMA, "engine": _engine(), "document": self.name,
                     "status": "ok" if ok else "error"}
        if self.loaded.renames:
            rep["migration"] = {"renames": self.loaded.renames}
        rep["params"] = params
        rep["features"] = self.features_out
        rep["parts"] = self.parts_out
        return rep

    # -- helpers --------------------------------------------------------------------------------
    def scalar(self, st: PartState, v: Any, fld: str) -> Any:
        return self.params.scalar(v, fld, st.pi)

    def p2(self, st, v, fld="length") -> tuple[float, float]:
        return (self.scalar(st, v[0], fld), self.scalar(st, v[1], fld))

    def p3(self, st, v, fld="length") -> tuple[float, float, float]:
        return (self.scalar(st, v[0], fld), self.scalar(st, v[1], fld), self.scalar(st, v[2], fld))

    def qscope(self, st: PartState) -> query.Scope:
        sc = query.Scope(list(st.bodies), dict(st.features), dict(st.names))
        sc.eval_scalar = lambda v, fld, path: self.scalar(st, v, fld)
        axes: dict[tuple[str, int], geom.Axis] = {}

        def resolve_axis(a: Any, path: str) -> geom.Axis:
            # one resolution per Dir per scope: the query evaluator and the replay re-check ask
            # for the same Dir many times (per pool, per member)
            k = (path, id(a))
            if k not in axes:
                try:
                    axes[k] = self.query_axis(st, a, path)
                except FeatureFailure as e:
                    # the enclosing query fails with the nested code (standalone: the feature's
                    # error, as before); in replay mode Forge's members are still replayed, their
                    # predicates on this Dir unchecked (ROBUSTNESS), never adopted blindly
                    raise query.RefFailure(e.code, e.message, e.details) from None
            return axes[k]

        sc.resolve_axis = resolve_axis
        return sc

    def query_axis(self, st: PartState, a: Any, path: str) -> geom.Axis:
        """An AxisRef used as a query Dir (§3.2, §5.3: `{parallel: {edge: Ref}}`, an `extreme` or
        pattern `dir`). Its nested Ref is **always the oracle's own resolution**, in every mode: a
        member of Forge's would otherwise steer both the oracle's own resolution of the enclosing
        query and the re-check of Forge's members for it, so a wrong nested member could make a
        wrong answer compare as MATCH. Forge's `refs` entry for the nested Ref (at its JSON pointer,
        e.g. `/target/q/where/parallel/edge`), **when reported**, is replayed like a field — probes
        matched, the query's geometric predicates and picks and the cardinality re-checked, the set
        compared with the oracle's own (`ORACLE_PREDICATE_FAILED`, `ORACLE_PROBE_UNMATCHED`,
        `ORACLE_REF_DIFFERS` / `ORACLE_REF_MISMATCH`) — but never adopted. It is **optional**: §5.8
        asks for one entry per Ref-valued *field*, and forge-refs' `frames::direction` drops the
        entries of Refs nested in a query, so a missing one is not `ORACLE_REF_UNREPORTED`. The
        findings go to the feature's warnings (`_nested_findings`), once per pointer."""
        return self.axis_ref(st, a, path, [], [], nested=True)

    def resolve(self, st: PartState, ref: dict, card: Any, fpath: str, refs: list, warns: list, *,
                nested: bool = False) -> list:
        """Resolve one Ref field. Standalone and in independent-refs mode the oracle uses its own
        resolution (`query.py`); in the default replay mode (§8.1, PR/nightly gate) it builds from
        Forge's replayed members when every probe matched (`replay.py`). `nested`: a Ref inside a
        query's Dir (`query_axis`) — own resolution only, Forge's entry checked, never adopted."""
        scope = self.qscope(st)
        res = query.resolve(ref, card, fpath, scope)
        if nested:
            self.check_nested(st, ref, card, fpath, res, scope)
            if res.failure is not None:
                raise FeatureFailure(res.failure.code, res.failure.message, res.failure.details)
            return res.members
        warns.extend(res.warnings)
        if self.replay is not None:
            from .replay import replay_ref

            rp = replay_ref(self.replay_feature(st), fpath, ref, ref.get("card", card), res, scope,
                            independent=self.independent_refs)
            warns.extend(rp.findings)
            if rp.members is not None:
                refs.append(rp.entry)
                return rp.members
        refs.append(res.entry)
        if res.failure is not None:
            raise FeatureFailure(res.failure.code, res.failure.message, res.failure.details)
        return res.members

    def check_nested(self, st: PartState, ref: dict, card: Any, fpath: str, res: Any, scope: query.Scope) -> None:
        """Replay-check Forge's entry for a Ref nested in a query Dir (`query_axis`), once per JSON
        pointer, and only when the pointer designates this very Ref in the feature (a `tagged`
        query's content is evaluated under the tagging feature's path, where it does not exist)."""
        if self.replay is None or fpath in self._nested_seen:
            return
        self._nested_seen.add(fpath)
        if _at_pointer(self._current_feature, fpath) is not ref:
            return
        from .replay import replay_ref

        rp = replay_ref(self.replay_feature(st), fpath, ref, ref.get("card", card), res, scope,
                        independent=self.independent_refs, required=False, adopt=False)
        self._nested_findings.extend(rp.findings)

    def replay_feature(self, st: PartState) -> dict | None:
        fid = getattr(self, "_current_fid", None)
        for f in (self.replay or {}).get("features", []):
            if f.get("feature_id") == fid and f.get("part") == st.part["name"]:
                return f
        return None

    def dep(self, st: PartState, fid: str, suppressed_code: str) -> query.FeatState:
        f = st.features.get(fid)
        if f is None:
            raise FeatureFailure("DEPENDENCY_FAILED", f"{fid!r} is not available", {"feature": fid})
        if f.status == "suppressed":
            raise FeatureFailure(suppressed_code, f"{fid!r} is suppressed", {"feature": fid})
        if f.status == "error":
            raise FeatureFailure("DEPENDENCY_FAILED", f"{fid!r} failed with {f.code}: {f.message}",
                                 {"feature": fid, "code": f.code, "message": f.message})
        return f

    # -- planes, axes, points ---------------------------------------------------------------------
    def plane_ref(self, st: PartState, p: Any, path: str, refs: list, warns: list) -> ir0.ResolvedPlane:
        if isinstance(p, str):
            return ir0.resolve_plane(p)
        if "datum" in p:
            self.dep(st, p["datum"], "DEPENDENCY_SUPPRESSED")
            return st.datums[p["datum"]].plane
        if "face" in p:
            origin = self.p3(st, p["origin"]) if "origin" in p else None
            xdir = self.p3(st, p["x_dir"], "ratio") if "x_dir" in p else None
            (face,) = self.resolve(st, p["face"], "one", f"{path}/face", refs, warns)
            return face_frame(face, origin, xdir)
        o, n, x = self.p3(st, p["origin"]), self.p3(st, p["normal"], "ratio"), self.p3(st, p["x_dir"], "ratio")
        check_frame(n, x, path)
        return ir0.resolve_plane(ir0.Frame(o, n, x))

    def axis_ref(self, st: PartState, a: Any, path: str, refs: list, warns: list, *,
                 nested: bool = False) -> geom.Axis:
        if isinstance(a, str):
            d = {"X": (1.0, 0.0, 0.0), "Y": (0.0, 1.0, 0.0), "Z": (0.0, 0.0, 1.0)}[a]
            return geom.Axis((0.0, 0.0, 0.0), d)
        if "edge" in a:
            (e,) = self.resolve(st, a["edge"], "one", f"{path}/edge", refs, warns, nested=nested)
            ax = e.edge_axis()
            if ax is None:
                raise FeatureFailure("AXIS_REF_UNSUPPORTED", f"an edge of type {e.type} has no axis", {"type": e.type})
        elif "cylinder" in a:
            (f,) = self.resolve(st, a["cylinder"], "one", f"{path}/cylinder", refs, warns, nested=nested)
            ax = f.surface_axis() if f.type in ("cylinder", "cone") else None
            if ax is None:
                raise FeatureFailure("AXIS_REF_UNSUPPORTED", f"a face of type {f.type} has no axis", {"type": f.type})
        elif "datum" in a:
            self.dep(st, a["datum"], "DEPENDENCY_SUPPRESSED")
            ax = st.datums[a["datum"]].axis
        else:
            o = self.p3(st, a["line"]["origin"])
            d = self.p3(st, a["line"]["direction"], "ratio")
            if geom.norm(d) <= TOL:
                raise FeatureFailure("INVALID_AXIS", "axis direction must be non-zero", {"field": f"{path}/line/direction"})
            ax = geom.Axis(o, geom.unit(d))
        if "flip" in a and self.scalar(st, a["flip"], "bool"):
            ax = ax.flipped()
        return ax

    def point_ref(self, st: PartState, p: Any, path: str, refs: list, warns: list) -> tuple[float, float, float]:
        if isinstance(p, list):
            return self.p3(st, p)
        (v,) = self.resolve(st, p["vertex"], "one", f"{path}/vertex", refs, warns)
        return v.point()

    # -- features -------------------------------------------------------------------------------
    def feature(self, st: PartState, fi: int, f: dict) -> None:
        fid, t = f["id"], f["type"]
        self._current_fid = fid
        self._current_feature = f
        self._nested_seen = set()
        self._nested_findings = []
        st.names[fid] = f["name"]
        entry: dict = {"part": st.part["name"], "feature": f["name"], "feature_id": fid, "type": t,
                       "status": "ok", "warnings": []}
        refs: list = []
        fs = query.FeatState(fid, f["name"], t, "ok")
        try:
            sup = f.get("suppressed", False)
            if isinstance(sup, str):
                sup = self.scalar(st, sup, "bool")
            if sup:
                fs.status = "suppressed"
                st.features[fid] = fs
                return
            for site in feature_sites(st.pi, fi, f):
                if site.is_expr:
                    ch = self.params.checked(site.text, site.field, site.scope)
                    bad = self.params.failed_use(ch.uses, st.pi)
                    if bad is not None:
                        raise FeatureFailure(bad["code"], bad["message"], bad["details"])
            # §7.1: features referenced by id (the consumed sketch, datums) before field values.
            if t in ("extrude", "revolve"):
                dep = st.features.get(f["sketch"])
                if dep is not None and dep.status == "suppressed":
                    raise FeatureFailure("SKETCH_SUPPRESSED", f"sketch {f['sketch']!r} is suppressed",
                                         {"feature": f["sketch"]})
                self.dep(st, f["sketch"], "SKETCH_SUPPRESSED")
            for did in datum_refs(f):
                self.dep(st, did, "DEPENDENCY_SUPPRESSED")
            if t == "sketch":
                self.sketch(st, f, entry, refs, fs)
            elif t in ("extrude", "revolve"):
                self.sweep(st, fi, f, entry, refs, fs)
            elif t == "datum_plane":
                self.datum_plane(st, f, entry, refs)
            elif t == "datum_axis":
                self.datum_axis(st, f, entry, refs)
            elif t == "tag":
                self.resolve(st, f["target"], "some", "/target", refs, entry["warnings"])
                fs.ref = f["target"]
                fs.tag_kind = f["target"]["kind"]
            elif t == "boolean":
                from .booleans import boolean_feature

                boolean_feature(self, st, fi, f, entry, refs)
            else:
                raise FeatureFailure("ORACLE_UNSUPPORTED_FEATURE",
                                     f"the oracle does not evaluate {t} features yet (W7b/W7c)", {"type": t})
        except (FeatureFailure, SketchError, TopoError) as e:
            entry["status"] = "error"
            entry["error"] = _err(e.code, e.message, getattr(e, "details", {}) or {})
        except query.RefFailure as e:
            entry["status"] = "error"
            entry["error"] = _err(e.code, e.message, e.details)
        except Exception as e:  # OCCT build failures and oracle bugs → engine-prefixed codes
            entry["status"] = "error"
            code = getattr(e, "code", None) or "ORACLE_EXCEPTION"
            if not str(code).startswith(("OCCT_", "ORACLE_")):
                code = "ORACLE_EXCEPTION"
            entry["error"] = _err(code, getattr(e, "message", None) or f"{type(e).__name__}: {e}")
        entry["warnings"].extend(self._nested_findings)
        if refs:
            entry["refs"] = refs
        if entry["status"] == "error":
            fs.status, fs.code, fs.message = "error", entry["error"]["code"], entry["error"]["message"]
            if t == "tag":
                fs.ref, fs.tag_kind = f["target"], f["target"]["kind"]
        st.features[fid] = fs
        self.features_out.append(_order_entry(entry))

    # -- sketches -------------------------------------------------------------------------------
    def sketch(self, st: PartState, f: dict, entry: dict, refs: list, fs: query.FeatState) -> None:
        constrained = bool(f.get("constraints"))
        dims: list[dict] = []
        solve: dict | None = None
        # §7.1 order: field expressions and range checks → references → the operation. In
        # explicit mode every curve check is a check of computed field values (§0.5, §4.2); in
        # constrained mode the dimension values are, and solving (replay, fixed point) and
        # `DEGENERATE_CURVE` on the solution are the operation.
        if constrained:
            stored, values = self.constrained_values(st, f)
        else:
            literal = self.explicit_geometry(st, f)
        plane = self.plane_ref(st, f["plane"], "/plane", refs, entry["warnings"])
        if constrained:
            literal, dims, solve = self.constrained_geometry(st, f, stored, values, entry["warnings"])
            if solve is not None:
                # [W0-16] `status` and `dof` are forge-solve's verdict; the oracle does not solve
                # (§8.1), so they are copied from the replayed report and marked as replayed.
                entry["warnings"].append({"code": "ORACLE_REPLAYED", "severity": "info",
                                          "message": "the solved geometry (and forge-solve's status and dof) are "
                                                     "replayed from the reference report and checked independently "
                                                     "(SPEC §8.1)",
                                          "details": {"fields": ["sketch.solved"] + [f"sketch.{k}" for k in solve]}})
        profile = []
        for c in literal:
            if c["kind"] == "point" or c.get("construction"):
                continue
            profile.append(_v0_curve(c))
        res = evaluate_sketch(profile)
        entry["regions"] = [{"area": r.area, "loops": r.loops, "outer_curves": list(r.outer_curves)}
                            for r in res.regions]
        block: dict = {"mode": "constrained" if constrained else "explicit", **(solve or {}), "solved": literal}
        if dims:  # the frozen report type omits an empty list (metrics.rs `skip_serializing_if`)
            block["dimensions"] = dims
        entry["sketch"] = block
        st.sketches[f["id"]] = SketchEval(plane, profile, res.regions, literal)

    def explicit_geometry(self, st: PartState, f: dict) -> list[dict]:
        out: list[dict] = []
        for c in f["curves"]:
            k, cid = c["kind"], c["id"]
            cons = bool(c.get("construction", False))
            if k in ("rect", "slot", "polygon"):
                fld_of = {"n": "count", "rotation": "angle"}
                # Evaluate every Scalar with its field type, then expand (§4.1).
                ev = {}
                for key in ("w", "h", "r", "n", "circumradius", "inradius", "across_flats", "side", "rotation"):
                    if key in c:
                        ev[key] = self.scalar(st, c[key], fld_of.get(key, "length"))
                for key in ("center", "corner", "a", "b"):
                    if key in c:
                        ev[key] = list(self.p2(st, c[key]))
                c2 = {**c, **ev}
                try:
                    members = compound.expand(c2, lambda v: float(v))
                except compound.CompoundError as e:
                    raise FeatureFailure(e.code, str(e), e.details) from None
                for m in members:
                    out.append(_literal(m, cons))
                continue
            if k == "point":
                d = {"kind": "point", "id": cid, "at": list(self.p2(st, c["at"]))}
            elif k == "line":
                d = {"kind": "line", "id": cid, "start": list(self.p2(st, c["start"])), "end": list(self.p2(st, c["end"]))}
                if math.dist(d["start"], d["end"]) <= TOL:
                    raise FeatureFailure("DEGENERATE_CURVE", f"line {cid!r} has zero length", {"curve": cid})
            elif k == "arc":
                d = {"kind": "arc", "id": cid, "start": list(self.p2(st, c["start"])), "end": list(self.p2(st, c["end"])),
                     "center": list(self.p2(st, c["center"])), "ccw": bool(c["ccw"])}
                r0, r1 = math.dist(d["start"], d["center"]), math.dist(d["end"], d["center"])
                if r0 <= TOL or r1 <= TOL:
                    raise FeatureFailure("DEGENERATE_CURVE", f"arc {cid!r} has zero radius", {"curve": cid})
                if abs(r0 - r1) > TOL:
                    raise FeatureFailure("INCONSISTENT_ARC", f"arc {cid!r}: |start-center| = {r0} but |end-center| = {r1}",
                                         {"curve": cid, "r_start": r0, "r_end": r1})
                if math.dist(d["start"], d["end"]) <= TOL:
                    raise FeatureFailure("DEGENERATE_CURVE", f"arc {cid!r}: start == end", {"curve": cid})
            else:
                d = {"kind": "circle", "id": cid, "center": list(self.p2(st, c["center"])),
                     "radius": self.scalar(st, c["radius"], "length")}
                if not d["radius"] > TOL:
                    raise FeatureFailure("DEGENERATE_CURVE", f"circle {cid!r} radius must be > 0", {"curve": cid})
            if cons:
                d["construction"] = True
            out.append(d)
        return out

    def constrained_values(self, st: PartState, f: dict) -> tuple[list[dict], dict[str, float]]:
        """The stored guess (literal numbers as floats) and the evaluated constraint values of a
        constrained sketch: §4.4 rule 1, the field range check `SKETCH_INVALID_DIMENSION`."""
        stored = []
        for c in f["curves"]:
            d = {k: v for k, v in c.items()}
            for key in ("start", "end", "center", "at"):
                if key in d:
                    d[key] = [float(x) for x in d[key]]
            if "radius" in d:
                d["radius"] = float(d["radius"])
            if not d.get("construction"):
                d.pop("construction", None)
            stored.append(d)
        values: dict[str, float] = {}
        for con in f["constraints"]:
            t = con["type"]
            if t in constraints.DIMENSION_TYPES and con.get("driving", True):
                v = self.scalar(st, con["value"], "angle" if t == "angle" else "length")
                if t != "angle" and not v > 0.0:
                    raise FeatureFailure("SKETCH_INVALID_DIMENSION", f"{t} {con['id']!r} must be > 0, got {v}",
                                         {"constraint": con["id"], "value": v})
                values[con["id"]] = v
            if t == "fix":
                for key in ("x", "y"):
                    if key in con:
                        values[f"{con['id']}.{key}"] = self.scalar(st, con[key], "length")
        return stored, values

    def constrained_geometry(self, st: PartState, f: dict, stored: list[dict], values: dict[str, float],
                             warns: list) -> tuple[list[dict], list[dict], dict | None]:
        """(literal geometry, dimension reports, replayed `{status?, dof?}` or None when standalone)
        of a constrained sketch — the operation, after its values and plane (§7.1).

        First the §4.4 rule 4 fixed point on the welded stored guess (`constraints.fixed_point`).

        Replay (a reference report is given and its sketch is ok): the geometry is the document's
        curves with the reference's solved numbers, after the independent check (`constraints`:
        structure, residuals, welds, dimension values) and, when the guess is clearly a fixed point,
        bit-identity with it (rule 4: under-constrained sketches cannot drift along a free degree of
        freedom); any failure is `ORACLE_REPLAY_CHECK_FAILED`. A reference that reports the solver
        outcomes `SKETCH_CONSTRAINT_CONFLICT` / `SKETCH_SOLVE_FAILED` is mirrored (the oracle does
        not solve, §8.1) — unless the guess is clearly a fixed point, where rule 4 makes the guess
        the solution and the failure provably wrong (`ORACLE_REPLAY_CHECK_FAILED`).
        Standalone: the fixed point, or `ORACLE_SOLVE_REQUIRES_REPLAY`. Either way
        `DEGENERATE_CURVE` then applies to the result (§4.2). The replay check's `notes` (findings
        on rules the SPEC does not state: `ORACLE_TANGENCY_MODE_DIFFERS`, `ORACLE_REPLAY_SIZE_BOUND`)
        become warnings (ROBUSTNESS in the diff)."""
        rf = self.replay_feature(st)
        solve: dict | None = None
        fp, clear = constraints.fixed_point(f["constraints"], values, stored, SOLVE_TOLERANCE)
        if rf is not None and rf.get("status") == "error":
            err = rf.get("error") or {}
            code = err.get("code", "")
            if code in ("SKETCH_CONSTRAINT_CONFLICT", "SKETCH_SOLVE_FAILED"):
                if clear:
                    raise FeatureFailure(
                        "ORACLE_REPLAY_CHECK_FAILED",
                        f"the reference reports {code}, but the welded stored guess already satisfies every "
                        f"driving constraint (max residual {fp.max_residual:.3g} mm): by SPEC §4.4 rule 4 the "
                        "solution is the guess, so the solve cannot fail",
                        {"failures": [f"{code} on a fixed point"], "max_residual": fp.max_residual,
                         "replayed_code": code})
                # A solver outcome the oracle cannot compute (SPEC §8.1): replayed as reported.
                raise FeatureFailure(code, f"replayed from the reference report: {err.get('message', '')}",
                                     err.get("details") or {})
        if rf is not None and rf.get("status") == "ok":
            blk = rf.get("sketch")
            if not isinstance(blk, dict) or blk.get("mode") != "constrained" or "solved" not in blk:
                raise FeatureFailure("ORACLE_REPLAY_CHECK_FAILED",
                                     "the reference reports this constrained sketch as ok without a constrained "
                                     "`sketch.solved` block to replay",
                                     {"failures": ["no constrained sketch block"], "max_residual": None})
            chk = constraints.check(f["constraints"], values, stored, blk["solved"], SOLVE_CHECK_TOLERANCE)
            warns.extend({"code": c, "severity": "warning", "message": m, "details": {}} for c, m in chk.notes)
            failures = list(chk.failures)
            if chk.ok:
                failures += constraints.check_dimensions(f["constraints"], values, blk.get("dimensions"))
                if clear:
                    failures += [f"§4.4 rule 4 (the welded stored guess is a fixed point): {x}"
                                 for x in constraints.differs_from(chk.geometry, constraints.welded(stored))]
            if failures:
                mr = chk.max_residual if math.isfinite(chk.max_residual) else None
                raise FeatureFailure("ORACLE_REPLAY_CHECK_FAILED",
                                     "the replayed solution fails the oracle's independent check: " + "; ".join(failures[:5]),
                                     {"failures": failures[:20], "max_residual": mr})
            geometry, dims, solve = chk.geometry, chk.dimensions, {}
            if blk.get("status") in ("fully_constrained", "under_constrained", "over_constrained_redundant"):
                solve["status"] = blk["status"]
            if isinstance(blk.get("dof"), int) and not isinstance(blk.get("dof"), bool) and blk["dof"] >= 0:
                solve["dof"] = blk["dof"]
        else:
            if not fp.ok:
                raise FeatureFailure("ORACLE_SOLVE_REQUIRES_REPLAY",
                                     "the stored guess does not satisfy the constraints and the oracle does not solve "
                                     "(SPEC §8.1): run it with a reference report (--replay) to check Forge's solution",
                                     {"max_residual": fp.max_residual if math.isfinite(fp.max_residual) else None})
            geometry, dims = constraints.welded(stored), fp.dimensions
        for c in geometry:
            why = constraints.degenerate(c)
            if why is not None:
                raise FeatureFailure("DEGENERATE_CURVE", f"curve {c['id']!r}: {why} in the solved geometry",
                                     {"curve": c["id"]})
        return geometry, dims, solve

    # -- sweeps -----------------------------------------------------------------------------------
    def sweep(self, st: PartState, fi: int, f: dict, entry: dict, refs: list, fs: query.FeatState) -> None:
        t = f["type"]
        dep = st.features.get(f["sketch"])
        if dep is not None and dep.status == "suppressed":
            raise FeatureFailure("SKETCH_SUPPRESSED", f"sketch {f['sketch']!r} is suppressed", {"feature": f["sketch"]})
        self.dep(st, f["sketch"], "SKETCH_SUPPRESSED")
        sk = st.sketches[f["sketch"]]
        if t == "extrude":
            d = self.scalar(st, f["distance"], "length")
            if not d > TOL:
                raise FeatureFailure("INVALID_DISTANCE", f"distance = {d}: must be > 0.000001",
                                     {"value": d, "expected": "> 0.000001"})
        else:
            ang = self.scalar(st, f["angle"], "angle")
            if not (0.0 < ang <= 360.0):
                raise FeatureFailure("INVALID_ANGLE", f"angle = {ang}: must be in (0, 360]",
                                     {"value": ang, "expected": "in (0, 360]"})
            ao = self.p2(st, f["axis"]["origin"])
            ad = self.p2(st, f["axis"]["direction"], "ratio")
            if math.hypot(ad[0], ad[1]) <= TOL:
                raise FeatureFailure("INVALID_AXIS", "axis direction must be non-zero",
                                     {"field": "axis", "value": list(ad), "expected": "a non-zero direction"})
        regions = select_regions(sk, f.get("regions", "all"))
        op = f.get("op", "new_body")
        targets = None
        if op != "new_body":
            from .booleans import resolve_targets

            targets = resolve_targets(self, st, f["targets"], "/targets", refs, entry["warnings"])
        if t == "revolve":
            check_revolve_profile(sk.profile, regions, ao, ad)
            tools = build_revolve(f["id"], f["name"], fi, sk.profile, regions, sk.plane, ao, ad, ang,
                                  f.get("direction", "normal"), self.gate)
            from ..sketch import snap_to_axis

            fs.curves = snap_to_axis(sk.profile, ao, ad)
        else:
            tools = build_extrude(f["id"], f["name"], fi, sk.profile, regions, sk.plane, d,
                                  f.get("direction", "normal"), self.gate)
            fs.curves = list(sk.profile)
        for r in regions:
            m = min(r.outer_curves, key=lambda s: s.encode())
            fs.outer_curves[m] = list(r.outer_curves)
            fs.region_curves[m] = sorted(sk.profile[e.index].id for lp in [r.outer, *r.holes] for e in lp.edges)
        if op == "new_body":
            st.bodies.extend(tools)
            entry["bodies"] = [body_report(b, "created") for b in canonical_bodies(tools)]
            return
        from .booleans import apply_body_op

        apply_body_op(self, st, f["id"], fi, op, targets, tools, entry, keep_tools=False)

    # -- datums -------------------------------------------------------------------------------------
    def datum_plane(self, st: PartState, f: dict, entry: dict, refs: list) -> None:
        mode = f["mode"]
        w = entry["warnings"]
        if mode == "offset":
            dist = self.scalar(st, f["distance"], "length")
            base = self.plane_ref(st, f["from"], "/from", refs, w)
            pl = ir0.ResolvedPlane(geom.add(base.origin, geom.mul(base.normal, dist)), base.x, base.y, base.normal)
        elif mode == "angle":
            ang = self.scalar(st, f["angle"], "angle")
            base = self.plane_ref(st, f["from"], "/from", refs, w)
            ax = self.axis_ref(st, f["axis"], "/axis", refs, w)
            c = abs(geom.dot(ax.direction, base.normal))
            if c > math.sin(QUERY_ANGLE_TOLERANCE):
                raise FeatureFailure("DATUM_DEGENERATE", "the rotation axis is not parallel to the plane",
                                     {"reason": "axis-not-in-plane", "angle_deg": math.degrees(math.asin(min(1.0, c)))})
            sc = expr.sin_cos_deg(ang)
            s, co = sc
            k = ax.direction

            def rot(v):
                return geom.rotate(v, k, s, co)

            o = geom.add(ax.origin, rot(geom.sub(base.origin, ax.origin)))
            pl = ir0.ResolvedPlane(o, rot(base.x), rot(base.y), rot(base.normal))
        elif mode == "midplane":
            a = self.plane_ref(st, f["a"], "/a", refs, w)
            b = self.plane_ref(st, f["b"], "/b", refs, w)
            if geom.norm(geom.cross(a.normal, b.normal)) > math.sin(QUERY_ANGLE_TOLERANCE):
                raise FeatureFailure("DATUM_DEGENERATE", "midplane of non-parallel planes",
                                     {"reason": "planes-not-parallel",
                                      "angle_deg": math.degrees(geom.angle_between(a.normal, b.normal))})
            h = geom.dot(geom.sub(b.origin, a.origin), a.normal) / 2.0
            pl = ir0.ResolvedPlane(geom.add(a.origin, geom.mul(a.normal, h)), a.x, a.y, a.normal)
        elif mode == "through":
            p0, p1, p2 = (self.point_ref(st, p, f"/points/{k}", refs, w) for k, p in enumerate(f["points"]))
            u = geom.sub(p1, p0)
            cr = geom.cross(u, geom.sub(p2, p0))
            # §3.3 exactly: collinear iff |cross| ≤ tol·|p1 − p0| (which also covers p1 = p0).
            if geom.norm(cr) <= TOL * geom.norm(u):
                raise FeatureFailure("DATUM_DEGENERATE", "the three points are collinear", {"reason": "collinear"})
            n = geom.unit(cr)
            x = geom.unit(u)
            pl = ir0.ResolvedPlane(p0, x, geom.cross(n, x), n)
        else:
            o, n, x = self.p3(st, f["origin"]), self.p3(st, f["normal"], "ratio"), self.p3(st, f["x_dir"], "ratio")
            check_frame(n, x, "")
            pl = ir0.resolve_plane(ir0.Frame(o, n, x))
        st.datums[f["id"]] = DatumEval(plane=pl)
        entry["datum"] = geom.frame_dict(pl)

    def datum_axis(self, st: PartState, f: dict, entry: dict, refs: list) -> None:
        mode = f["mode"]
        w = entry["warnings"]
        if mode == "edge":
            (e,) = self.resolve(st, f["edge"], "one", "/edge", refs, w)
            ax = e.edge_axis()
            if ax is None:
                raise FeatureFailure("AXIS_REF_UNSUPPORTED", f"an edge of type {e.type} has no axis", {"type": e.type})
        elif mode == "cylinder":
            (fc,) = self.resolve(st, f["face"], "one", "/face", refs, w)
            ax = fc.surface_axis() if fc.type in ("cylinder", "cone") else None
            if ax is None:
                raise FeatureFailure("AXIS_REF_UNSUPPORTED", f"a face of type {fc.type} has no axis", {"type": fc.type})
        elif mode == "planes":
            a = self.plane_ref(st, f["a"], "/a", refs, w)
            b = self.plane_ref(st, f["b"], "/b", refs, w)
            cr = geom.cross(a.normal, b.normal)
            if geom.norm(cr) <= math.sin(QUERY_ANGLE_TOLERANCE):
                raise FeatureFailure("DATUM_DEGENERATE", "parallel planes do not intersect",
                                     {"reason": "planes-parallel", "angle_deg": 0.0})
            d = geom.sign_canonical(geom.unit(cr))
            ax = geom.Axis(plane_plane_point(a, b, d), d)
        else:
            pa, pb = (self.point_ref(st, p, f"/points/{k}", refs, w) for k, p in enumerate(f["points"]))
            if geom.dist(pa, pb) <= TOL:
                raise FeatureFailure("DATUM_DEGENERATE", "the two points coincide", {"reason": "coincident-points"})
            ax = geom.Axis(pa, geom.unit(geom.sub(pb, pa)))
        if "flip" in f and self.scalar(st, f["flip"], "bool"):
            ax = ax.flipped()
        st.datums[f["id"]] = DatumEval(axis=ax)
        entry["datum"] = geom.axis_dict(ax)


# ---------------------------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------------------------

def check_frame(n, x, path: str) -> None:
    ln, lx = geom.norm(n), geom.norm(x)
    if ln <= TOL or lx <= TOL:
        raise FeatureFailure("INVALID_PLANE", "degenerate frame", {"field": path, "reason": "zero-length normal or x_dir"})
    c = geom.dot(n, x) / (ln * lx)
    if abs(c) > ANGULAR_TOLERANCE:
        raise FeatureFailure("INVALID_PLANE", f"normal and x_dir must be perpendicular (cos = {c:e})",
                             {"field": path, "reason": "normal and x_dir are not perpendicular"})


def face_frame(face, origin, xdir) -> ir0.ResolvedPlane:
    """§3.1 face frame."""
    if face.type != "plane":
        raise FeatureFailure("PLANE_NOT_PLANAR", f"the face {face.key} is a {face.type}, not a plane",
                             {"surface": face.type})
    n = face.plane_normal()
    p0 = face.point()
    o = origin if origin is not None else (0.0, 0.0, 0.0)
    o = geom.sub(o, geom.mul(n, geom.dot(geom.sub(o, p0), n)))
    if xdir is not None:
        xp = geom.sub(xdir, geom.mul(n, geom.dot(xdir, n)))
    else:
        axes = [(1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)]
        best = min(range(3), key=lambda i: (abs(geom.dot(n, axes[i])), i))
        a = axes[best]
        xp = geom.sub(a, geom.mul(n, geom.dot(a, n)))
    if geom.norm(xp) <= 1e-9:
        raise FeatureFailure("PLANE_DEGENERATE", "x_dir projects to zero on the face plane", {"x_dir": list(xdir or ())})
    x = geom.unit(xp)
    return ir0.ResolvedPlane(o, x, geom.cross(n, x), n)


def plane_plane_point(a: ir0.ResolvedPlane, b: ir0.ResolvedPlane, d) -> tuple:
    """The point of the intersection line of two planes closest to the world origin."""
    na, nb = a.normal, b.normal
    ca, cb = geom.dot(na, a.origin), geom.dot(nb, b.origin)
    # p = α na + β nb (the closest point to the origin lies in span(na, nb))
    g = geom.dot(na, nb)
    det = 1.0 - g * g
    alpha = (ca - cb * g) / det
    beta = (cb - ca * g) / det
    return geom.add(geom.mul(na, alpha), geom.mul(nb, beta))


def _at_pointer(doc: Any, pointer: str) -> Any:
    """The value at a JSON pointer (RFC 6901) in `doc`, or None when the pointer does not resolve."""
    cur = doc
    for tok in pointer.split("/")[1:]:
        tok = tok.replace("~1", "/").replace("~0", "~")
        if isinstance(cur, dict) and tok in cur:
            cur = cur[tok]
        elif isinstance(cur, list) and tok.isdigit() and int(tok) < len(cur):
            cur = cur[int(tok)]
        else:
            return None
    return cur


def datum_refs(f: dict) -> list[str]:
    """Ids of datum features a feature references by id (`{ "datum": id }` planes and axes),
    in field order; Ref queries are not searched (their feature references resolve with the
    query, §5.7 step 1)."""
    out: list[str] = []

    def walk(v: Any) -> None:
        if isinstance(v, dict):
            if isinstance(v.get("datum"), str) and set(v) <= {"datum", "flip"}:
                if v["datum"] not in out:
                    out.append(v["datum"])
                return
            for k, x in v.items():
                if k in ("q", "capture"):
                    continue
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    for k, v in f.items():
        if k not in ("id", "name", "type"):
            walk(v)
    return out


def select_regions(sk: SketchEval, regions: Any) -> list:
    """§4.5: "all", or per curve id the region whose outer loop contains it (canonical order)."""
    if regions == "all":
        return list(sk.regions)
    chosen = []
    for cid in regions:
        r = next((r for r in sk.regions if cid in r.outer_curves), None)
        if r is None:
            raise FeatureFailure("REGION_NOT_FOUND", f"no region's outer loop contains curve {cid!r}", {"curve": cid})
        if all(r is not x for x in chosen):
            chosen.append(r)
    return [r for r in sk.regions if any(r is x for x in chosen)]


def _v0_curve(c: dict):
    if c["kind"] == "line":
        return ir0.Line(c["id"], tuple(c["start"]), tuple(c["end"]))
    if c["kind"] == "arc":
        return ir0.Arc(c["id"], tuple(c["start"]), tuple(c["end"]), tuple(c["center"]), bool(c["ccw"]))
    return ir0.Circle(c["id"], tuple(c["center"]), float(c["radius"]))


def _literal(m, construction: bool) -> dict:
    if isinstance(m, ir0.Line):
        d = {"kind": "line", "id": m.id, "start": list(m.start), "end": list(m.end)}
    elif isinstance(m, ir0.Arc):
        d = {"kind": "arc", "id": m.id, "start": list(m.start), "end": list(m.end), "center": list(m.center), "ccw": m.ccw}
    else:
        d = {"kind": "circle", "id": m.id, "center": list(m.center), "radius": m.radius}
    if construction:
        d["construction"] = True
    return d


_ENTRY_ORDER = ("part", "feature", "feature_id", "type", "status", "error", "warnings", "regions", "sketch",
                "datum", "bodies", "removed", "refs", "holes", "fillet", "chamfer", "shell", "pattern")


def _order_entry(e: dict) -> dict:
    return {k: e[k] for k in _ENTRY_ORDER if k in e}


# ---------------------------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------------------------

def rejected_report(name: str, rej: Rejected) -> dict:
    errors = [p.as_dict() for p in rej.problems] or [{"code": rej.code, "path": "", "message": rej.parse or ""}]
    return {"schema": METRICS_SCHEMA, "engine": _engine(), "document": name, "status": "error",
            "error": _err(rej.code, rej.message, {"errors": errors}), "params": [], "features": [], "parts": []}


def _doc_name(data: Any, fallback: str) -> str:
    if isinstance(data, dict) and isinstance(data.get("meta"), dict):
        n = data["meta"].get("name")
        if isinstance(n, str) and n:
            return n
    return fallback


def evaluate_loaded(loaded: Loaded, name: str, **kw) -> dict:
    return Evaluator(loaded, name, **kw).run()


def evaluate_data(data: Any, fallback_name: str, **kw) -> dict:
    name = _doc_name(data, fallback_name)
    try:
        loaded = load_value(data)
    except Rejected as r:
        return rejected_report(name, r)
    return evaluate_loaded(loaded, name, **kw)


def evaluate_text(text: str, fallback_name: str, **kw) -> dict:
    try:
        from .jsonio import loads_strict

        data = loads_strict(text)
    except Exception:
        data = None
    name = _doc_name(data, fallback_name)
    try:
        loaded = load_text(text)
    except Rejected as r:
        return rejected_report(name, r)
    return evaluate_loaded(loaded, name, **kw)


def check_report(report: dict) -> list[str]:
    from .consts import metrics_validator, schema_errors

    errs = schema_errors(metrics_validator(), report)

    def walk(x, path):
        if isinstance(x, float) and not math.isfinite(x):
            errs.append(f"{path}: non-finite number {x}")
        elif isinstance(x, dict):
            for k, v in x.items():
                walk(v, f"{path}/{k}")
        elif isinstance(x, list):
            for i, v in enumerate(x):
                walk(v, f"{path}/{i}")

    walk(report, "")
    return errs


__all__ = ["Evaluator", "evaluate_data", "evaluate_text", "evaluate_loaded", "check_report"]
