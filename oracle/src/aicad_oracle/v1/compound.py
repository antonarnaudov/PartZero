"""Compound-curve expansion (SPEC-v1 §4.1 [D-19], [W0-6]), written from the SPEC member tables.

Inputs are evaluated values. Members are `<id>.<member>` in member-table order (rect: bottom,
c_br, right, c_tr, top, c_tl, left, c_bl; slot: right, cap_b, left, cap_a; polygon: e0 … e(n−1));
a member whose chord `|end − start|` is ≤ tol is omitted. All arcs are ccw. Invalid sizes raise
`CompoundError` with `INVALID_VALUE` (details `{field, value, expected}`), and a polygon `n`
that is not an exact integer `EXPR_NOT_INTEGER`, below 3 `INVALID_COUNT`.

A polygon's `n` may be as large as `MAX_COUNT_MAGNITUDE` (2^31). The oracle never loops that far:
when every side is at most tol/2 long, every member is omitted and the expansion is empty
(computed without the loop; exact, since the coordinates' rounding is far below tol there);
otherwise more than `MAX_POLYGON_SIDES` sides fail with the engine-internal
`ORACLE_RESOURCE_LIMIT` (ROBUSTNESS in the diff), never a hang.
"""

from __future__ import annotations

import math

from ..ir import Arc, Line
from .consts import LINEAR_TOLERANCE, MAX_COUNT_MAGNITUDE
from .expr import sin_cos_deg

TOL = LINEAR_TOLERANCE
#: The oracle's resource limit on polygon sides (not a SPEC rule; engine-internal code).
MAX_POLYGON_SIDES = 100_000


class CompoundError(Exception):
    def __init__(self, code: str, field: str, value: float, expected: str):
        super().__init__(f"{code}: {field} = {value}: expected {expected}")
        self.code = code
        self.field = field
        self.value = value
        self.expected = expected

    @property
    def details(self) -> dict:
        v = self.value if math.isfinite(self.value) else None
        return {"field": self.field, "value": v, "expected": self.expected}


def _bad(field: str, value: float, expected: str) -> CompoundError:
    return CompoundError("INVALID_VALUE", field, value, expected)


def _dist(a, b) -> float:
    return math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]))


def _line(cid: str, member: str, s, e) -> Line | None:
    return Line(f"{cid}.{member}", (s[0], s[1]), (e[0], e[1])) if _dist(s, e) > TOL else None


def _arc(cid: str, member: str, c, s, e) -> Arc | None:
    return Arc(f"{cid}.{member}", (s[0], s[1]), (e[0], e[1]), (c[0], c[1]), True) if _dist(s, e) > TOL else None


def expand_rect(cid: str, center, corner, w: float, h: float, r: float) -> list:
    if not (math.isfinite(w) and w > TOL):
        raise _bad("w", w, f"> {TOL}")
    if not (math.isfinite(h) and h > TOL):
        raise _bad("h", h, f"> {TOL}")
    half_min = min(w, h) / 2.0
    if not (math.isfinite(r) and 0.0 <= r <= half_min):
        raise _bad("r", r, f"in [0, {half_min}] (min(w, h)/2)")
    if center is not None and corner is None:
        x0, x1, y0, y1 = center[0] - w / 2.0, center[0] + w / 2.0, center[1] - h / 2.0, center[1] + h / 2.0
    elif corner is not None and center is None:
        x0, x1, y0, y1 = corner[0], corner[0] + w, corner[1], corner[1] + h
    else:
        raise _bad("center", math.nan, "exactly one of center / corner")
    if r == 0.0:
        out = [_line(cid, "bottom", (x0, y0), (x1, y0)), _line(cid, "right", (x1, y0), (x1, y1)),
               _line(cid, "top", (x1, y1), (x0, y1)), _line(cid, "left", (x0, y1), (x0, y0))]
    else:
        out = [
            _line(cid, "bottom", (x0 + r, y0), (x1 - r, y0)),
            _arc(cid, "c_br", (x1 - r, y0 + r), (x1 - r, y0), (x1, y0 + r)),
            _line(cid, "right", (x1, y0 + r), (x1, y1 - r)),
            _arc(cid, "c_tr", (x1 - r, y1 - r), (x1, y1 - r), (x1 - r, y1)),
            _line(cid, "top", (x1 - r, y1), (x0 + r, y1)),
            _arc(cid, "c_tl", (x0 + r, y1 - r), (x0 + r, y1), (x0, y1 - r)),
            _line(cid, "left", (x0, y1 - r), (x0, y0 + r)),
            _arc(cid, "c_bl", (x0 + r, y0 + r), (x0, y0 + r), (x0 + r, y0)),
        ]
    return [m for m in out if m is not None]


def expand_slot(cid: str, a, b, w: float) -> list:
    length = _dist(a, b)
    if not (math.isfinite(length) and length > TOL):
        raise _bad("b", length, f"|b − a| > {TOL}")
    if not (math.isfinite(w) and w > TOL):
        raise _bad("w", w, f"> {TOL}")
    d = ((b[0] - a[0]) / length, (b[1] - a[1]) / length)
    m = (-d[1], d[0])
    h = w / 2.0
    am = (a[0] - h * m[0], a[1] - h * m[1])
    ap = (a[0] + h * m[0], a[1] + h * m[1])
    bm = (b[0] - h * m[0], b[1] - h * m[1])
    bp = (b[0] + h * m[0], b[1] + h * m[1])
    out = [_line(cid, "right", am, bm), _arc(cid, "cap_b", b, bm, bp),
           _line(cid, "left", bp, ap), _arc(cid, "cap_a", a, ap, am)]
    return [x for x in out if x is not None]


def expand_polygon(cid: str, center, n: float, size_field: str, size: float, rotation: float) -> list:
    if not (math.isfinite(n) and n == math.floor(n) and abs(n) <= MAX_COUNT_MAGNITUDE):
        raise CompoundError("EXPR_NOT_INTEGER", "n", n, "an exact integer")
    if n < 3.0:
        raise CompoundError("INVALID_COUNT", "n", n, ">= 3")
    if not (math.isfinite(size) and size > TOL):
        raise _bad(size_field, size, f"> {TOL}")
    if not math.isfinite(rotation):
        raise _bad("rotation", rotation, "finite")
    half = 180.0 / n
    sc = sin_cos_deg(half)
    if sc is None:
        raise _bad("n", n, "a finite polygon")
    s_half, c_half = sc
    if size_field == "circumradius":
        big_r = size
    elif size_field == "inradius":
        big_r = size / c_half
    elif size_field == "across_flats":
        big_r = size / (2.0 * c_half)
    else:
        big_r = size / (2.0 * s_half)
    count = int(n)
    if 2.0 * big_r * s_half <= 0.5 * TOL:
        return []  # every side ≤ tol/2: every member is omitted (§4.1)
    if count > MAX_POLYGON_SIDES:
        raise CompoundError("ORACLE_RESOURCE_LIMIT", "n", n,
                            f"<= {MAX_POLYGON_SIDES} sides (an oracle resource limit, not a SPEC rule)")
    pts = []
    for k in range(count):
        theta = rotation + (360.0 * float(k)) / n
        sn, cs = sin_cos_deg(theta)
        pts.append((center[0] + big_r * cs, center[1] + big_r * sn))
    out = [_line(cid, f"e{k}", pts[k], pts[(k + 1) % count]) for k in range(count)]
    return [x for x in out if x is not None]


def expand(c: dict, value) -> list:
    """Expand a compound curve dict whose Scalars are evaluated by `value(key_path_suffix, v)`.
    `value(v)` maps a Scalar to a float (literals pass through)."""
    k, cid = c["kind"], c["id"]
    if k == "rect":
        center = [value(x) for x in c["center"]] if "center" in c else None
        corner = [value(x) for x in c["corner"]] if "corner" in c else None
        return expand_rect(cid, center, corner, value(c["w"]), value(c["h"]), value(c.get("r", 0.0)))
    if k == "slot":
        return expand_slot(cid, [value(x) for x in c["a"]], [value(x) for x in c["b"]], value(c["w"]))
    assert k == "polygon"
    sizes = [f for f in ("circumradius", "inradius", "across_flats", "side") if f in c]
    return expand_polygon(cid, [value(x) for x in c["center"]], value(c["n"]), sizes[0],
                          value(c[sizes[0]]), value(c.get("rotation", 0.0)))
