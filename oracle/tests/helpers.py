"""Small builders for IR documents used by the tests."""

from __future__ import annotations

import math

from aicad_oracle.evaluate import evaluate_data


def L(cid, a, b):
    return {"kind": "line", "id": cid, "start": list(a), "end": list(b)}


def A(cid, a, b, c, ccw=True):
    return {"kind": "arc", "id": cid, "start": list(a), "end": list(b), "center": list(c), "ccw": ccw}


def C(cid, c, r):
    return {"kind": "circle", "id": cid, "center": list(c), "radius": r}


def rect(prefix, x0, y0, x1, y1):
    return [
        L(f"{prefix}b", (x0, y0), (x1, y0)),
        L(f"{prefix}r", (x1, y0), (x1, y1)),
        L(f"{prefix}t", (x1, y1), (x0, y1)),
        L(f"{prefix}l", (x0, y1), (x0, y0)),
    ]


def sketch(curves, plane="XY", name="sk", fid="s1", **kw):
    return {"type": "sketch", "id": fid, "name": name, "plane": plane, "curves": curves, **kw}


def extrude(distance, sketch_name="sk", fid="e1", name="ex", **kw):
    return {"type": "extrude", "id": fid, "name": name, "sketch": sketch_name, "distance": distance, **kw}


def revolve(angle, origin=(0, 0), axis_dir=(0, 1), sketch_name="sk", fid="r1", name="rv", **kw):
    return {
        "type": "revolve", "id": fid, "name": name, "sketch": sketch_name,
        "axis": {"origin": list(origin), "direction": list(axis_dir)}, "angle": angle, **kw,
    }


def doc(*features, name="t"):
    return {"schema": "aicad.ir/0", "meta": {"name": name}, "parts": [{"id": "p1", "name": "part", "features": list(features)}]}


def run(*features, checks=None):
    return evaluate_data(doc(*features), "t", checks)


def feature(report, name):
    """Feature entry by feature NAME (SPEC §5: reports carry part/feature names)."""
    for f in report["features"]:
        if f["feature"] == name:
            return f
    raise KeyError(name)


def rel(a, b):
    return abs(a - b) / max(abs(b), 1e-300)


PI = math.pi
