"""Builders shared by the IR v1 tests (no tests here)."""

from __future__ import annotations

import json
import math

from aicad_oracle.v1.evaluate import check_report, evaluate_data

PI = math.pi


def doc(*features, params=None, part_params=None, name="t") -> dict:
    part = {"id": "p1", "name": "part", "features": list(features)}
    if part_params:
        part["params"] = part_params
    d = {"schema": "aicad.ir/1", "meta": {"name": name}, "parts": [part]}
    if params:
        d["params"] = params
    return d


def P(name, unit, value, **kw) -> dict:
    return {"name": name, "unit": unit, "value": value, **kw}


def sk(fid, curves, plane="XY", name=None, **kw) -> dict:
    return {"type": "sketch", "id": fid, "name": name or f"n_{fid}", "plane": plane, "curves": curves, **kw}


def ex(fid, sketch, distance, name=None, **kw) -> dict:
    return {"type": "extrude", "id": fid, "name": name or f"n_{fid}", "sketch": sketch, "distance": distance, **kw}


def rv(fid, sketch, angle, origin=(0, 0), direction=(0, 1), name=None, **kw) -> dict:
    return {"type": "revolve", "id": fid, "name": name or f"n_{fid}", "sketch": sketch,
            "axis": {"origin": list(origin), "direction": list(direction)}, "angle": angle, **kw}


def rect(cid="r", w=10, h=10, center=(0, 0), **kw) -> dict:
    return {"kind": "rect", "id": cid, "center": list(center), "w": w, "h": h, **kw}


def circle(cid, center, radius, **kw) -> dict:
    return {"kind": "circle", "id": cid, "center": list(center), "radius": radius, **kw}


def ref(kind, q, **kw) -> dict:
    return {"kind": kind, "q": q, **kw}


def body_of(fid, **kw) -> dict:
    return ref("body", {"op": "body", "feature": fid}, **kw)


def cap(fid, end="end") -> dict:
    return {"face": ref("face", {"op": "cap", "feature": fid, "end": end})}


def run(d: dict, **kw) -> dict:
    rep = evaluate_data(json.loads(json.dumps(d)), d.get("meta", {}).get("name", "t"), **kw)
    bad = check_report(rep)
    assert not bad, bad
    return rep


def feat(rep: dict, fid: str) -> dict:
    for f in rep["features"]:
        if f["feature_id"] == fid:
            return f
    raise KeyError(fid)


def param(rep: dict, name: str) -> dict:
    for p in rep["params"]:
        if p["name"] == name:
            return p
    raise KeyError(name)


def code(f: dict) -> str | None:
    return (f.get("error") or {}).get("code")


def rel(a: float, b: float) -> float:
    return abs(a - b) / max(abs(b), 1e-300)


def keys(f: dict, field: str | None = None) -> list[str]:
    refs = f.get("refs") or []
    r = refs[0] if field is None else next(x for x in refs if x["field"] == field)
    return [m["key"] for m in r["members"]]


def max_matching(n_want: int, n_got: int, fits) -> dict[int, int]:
    """A maximum matching of `n_want` expected entries to distinct returned entries (`n_got`) under
    `fits(w, g)`, as {expected index: returned index} — Kuhn's augmenting paths, the algorithm of
    the Rust runners' `unmatched` (`forge-ir/tests/v1_conformance*.rs`), so both engines' fixture
    runners compare the same multiset: one returned entry never satisfies two expected ones, and
    fixture order never decides which expected entry takes a returned one (a greedy pass can let a
    less specific entry take the entry a later, more specific one needs — a false failure)."""
    owner: list[int | None] = [None] * n_got

    def augment(w: int, seen: list[bool]) -> bool:
        for g in range(n_got):
            if seen[g] or not fits(w, g):
                continue
            seen[g] = True
            if owner[g] is None or augment(owner[g], seen):
                owner[g] = w
                return True
        return False

    for w in range(n_want):
        augment(w, [False] * n_got)
    return {w: g for g, w in enumerate(owner) if w is not None}
