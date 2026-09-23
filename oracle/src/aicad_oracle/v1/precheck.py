"""Raw pre-checks of SPEC-v1 §0.5 rule 4 step 3 ([W0-1]): the rejections that must carry a
code although the typed parse (JSON Schema) would fail on them. They run on the JSON value
before schema validation, exactly like `forge_ir::v1::precheck` (the oracle must run the same
checks before its schema validation, SPEC §11 note W7).

| Where | Code |
|---|---|
| any `null` | parse error (no code) |
| `parts[*].features[*].type` unknown | `UNSUPPORTED_FEATURE` |
| `...features[*].v` not a defined version (`1.0`, `0`, `"1"`) | `UNSUPPORTED_FEATURE_VERSION` |
| a parameter's unknown `unit`, missing `value`, present `measure` | `PARAM_INVALID` |
| a Ref (object with `kind` and `q`) whose `card` is not one/some/any/integer ≥ 1 | `INVALID_CARDINALITY` |
| a hole `size` not in `HOLE_SIZES` | `HOLE_SIZE_UNKNOWN` |
| `driving` / `value` on a constraint that is not a dimension | `SKETCH_NOT_A_DIMENSION` |
"""

from __future__ import annotations

from typing import Any

from . import consts
from .ids import is_ref, shown

_U32_MAX = 2**32 - 1


class Problem:
    """A coded rejection: `{code, path}` is normative, `message` and `details` are not."""

    __slots__ = ("code", "path", "message", "details")

    def __init__(self, code: str, path: str, message: str, details: dict | None = None):
        self.code = code
        self.path = path
        self.message = message
        self.details = details if details is not None else {}

    def as_dict(self) -> dict:
        return {"code": self.code, "path": self.path, "message": self.message, "details": self.details}

    def __repr__(self) -> str:
        return f"{self.code} at {self.path}"


def _esc(k: str) -> str:
    return k.replace("~", "~0").replace("/", "~1")


def find_null(v: Any, path: str = "") -> str | None:
    if v is None:
        return path or "/"
    if isinstance(v, list):
        for i, x in enumerate(v):
            p = find_null(x, f"{path}/{i}")
            if p is not None:
                return p
    elif isinstance(v, dict):
        for k, x in v.items():
            p = find_null(x, f"{path}/{_esc(k)}")
            if p is not None:
                return p
    return None


def _is_uint(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _shown_value(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, str) and is_ref(v):
        return repr(v)
    if v is None:
        return "null"
    return "<invalid value>"


def _param(p: Any, pp: str, errs: list[Problem]) -> None:
    if not isinstance(p, dict):
        return
    name = shown(p.get("name")) if isinstance(p.get("name"), str) else "<invalid id>"
    allowed = list(consts.param_units())

    def invalid(path: str, reason: str, msg: str) -> None:
        errs.append(Problem("PARAM_INVALID", path, msg, {"name": name, "reason": reason, "allowed": allowed}))

    if "unit" in p:
        u = p["unit"]
        if not (isinstance(u, str) and u in allowed):
            invalid(f"{pp}/unit", "bad-unit", f"unit {_shown_value(u)} is not one of {', '.join(allowed)}")
    else:
        invalid(pp, "bad-unit", "unit is required")
    if "measure" in p:
        invalid(f"{pp}/measure", "measure-deferred",
                "measured parameters are deferred to IR v1.1 (ADR 0013 decision 5)")
    elif "value" not in p:
        invalid(pp, "value-required", "value is required")


def _feature(f: Any, fp: str, errs: list[Problem]) -> None:
    if not isinstance(f, dict):
        return
    ty = f.get("type")
    types = consts.feature_types()
    if not (isinstance(ty, str) and ty in types):
        errs.append(Problem("UNSUPPORTED_FEATURE", f"{fp}/type",
                            f"unknown feature type {_shown_value(ty)}",
                            {"type": _shown_value(ty), "supported": list(types)}))
        return
    if "v" in f:
        v = f["v"]
        supported = consts.feature_versions().get(ty, [])
        if not (_is_uint(v) and v in supported):
            errs.append(Problem("UNSUPPORTED_FEATURE_VERSION", f"{fp}/v",
                                f"{ty} v{_shown_value(v)} is not implemented (supported: {supported})",
                                {"type": ty, "v": _shown_value(v), "supported": supported}))
    if ty == "hole" and "size" in f:
        size = f["size"]
        sizes = list(consts.hole_sizes())
        if not (isinstance(size, str) and size in sizes):
            errs.append(Problem("HOLE_SIZE_UNKNOWN", f"{fp}/size",
                                f"unknown hole size {_shown_value(size)}; use one of {', '.join(sizes)}",
                                {"field": "size", "allowed": sizes}))
    if ty == "sketch" and isinstance(f.get("constraints"), list):
        ctypes, dims = consts.constraint_types(), consts.dimension_types()
        for k, c in enumerate(f["constraints"]):
            if not isinstance(c, dict):
                continue
            t = c.get("type")
            if not isinstance(t, str) or t not in ctypes or t in dims:
                continue
            for key in ("driving", "value"):
                if key in c:
                    cid = shown(c.get("id")) if isinstance(c.get("id"), str) else "<invalid id>"
                    errs.append(Problem("SKETCH_NOT_A_DIMENSION", f"{fp}/constraints/{k}/{key}",
                                        f"`{cid}`: only dimensions (distance, angle, radius, diameter) take {key}",
                                        {"id": cid}))


def _refs(v: Any, path: str, errs: list[Problem]) -> None:
    if isinstance(v, list):
        for i, x in enumerate(v):
            _refs(x, f"{path}/{i}", errs)
    elif isinstance(v, dict):
        if "kind" in v and "q" in v and "card" in v:
            card = v["card"]
            ok = (isinstance(card, str) and card in ("one", "some", "any")) or (
                _is_uint(card) and 1 <= card <= _U32_MAX)
            if not ok:
                errs.append(Problem("INVALID_CARDINALITY", f"{path}/card",
                                    f"card {_shown_value(card)} is not one, some, any or an integer >= 1",
                                    {"field": path, "allowed": ["one", "some", "any", ">= 1"]}))
        for k, x in v.items():
            if k == "capture":
                continue
            _refs(x, f"{path}/{_esc(k)}", errs)


def precheck(v: Any) -> tuple[str | None, list[Problem]]:
    """Returns (parse error message or None, coded problems)."""
    p = find_null(v)
    if p is not None:
        return f"null is not allowed at {p} (omit the field instead)", []
    errs: list[Problem] = []
    if not isinstance(v, dict):
        return None, errs
    if isinstance(v.get("params"), list):
        for i, prm in enumerate(v["params"]):
            _param(prm, f"/params/{i}", errs)
    if isinstance(v.get("parts"), list):
        for pi, part in enumerate(v["parts"]):
            if not isinstance(part, dict):
                continue
            pp = f"/parts/{pi}"
            if isinstance(part.get("params"), list):
                for i, prm in enumerate(part["params"]):
                    _param(prm, f"{pp}/params/{i}", errs)
            if not isinstance(part.get("features"), list):
                continue
            for fi, f in enumerate(part["features"]):
                _feature(f, f"{pp}/features/{fi}", errs)
    _refs(v, "", errs)
    return None, errs
