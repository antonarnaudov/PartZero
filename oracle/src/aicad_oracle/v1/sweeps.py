"""Extrude and revolve tool bodies (SPEC-v1 §6.2, §6.3 with v0 §4.2–§4.4) and their names.

The OCCT construction is the v0 oracle's, call for call (`occt.build_face`, `occt.extrude`,
`occt.revolve`, profile snapping to the revolve axis, the `selfcheck` body gate, the
`BRepCheck` validity rule), so a migrated v0 document yields bit-identical body metrics. On top,
each body gets its origin (§5.2 rule 4) and provenance keys (`topo.py`).
"""

from __future__ import annotations

import math

from .. import occt
from ..ir import Circle, ExtrudeFeature, Line, ResolvedPlane, RevolveFeature
from ..selfcheck import check_body
from ..sketch import Region, curve_geometry, dist_point_curve, snap_to_axis, winding_number
from . import geom
from .consts import LINEAR_TOLERANCE
from .topo import Body, TopoError

TOL = LINEAR_TOLERANCE


class FeatureFailure(Exception):
    """A feature error with a code of the catalogue (or an engine-prefixed one)."""

    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.details = details or {}


# ---------------------------------------------------------------------------------------------
# 2D helpers
# ---------------------------------------------------------------------------------------------

def curve_mid(c) -> tuple[float, float]:
    g = curve_geometry(c)
    if isinstance(c, Line):
        return g.point(0.5)
    return g.point(g.t0 + 0.5 * g.sweep)


def region_loops(region: Region):
    return [region.outer, *region.holes]


def region_interior_point(curves: list, region: Region) -> tuple[float, float]:
    """A point inside the region, as far from its boundary as a refined grid search finds."""
    loops = region_loops(region)
    idx = [e.index for lp in loops for e in lp.edges]
    xs, ys = [], []
    for i in idx:
        g = curve_geometry(curves[i])
        if isinstance(curves[i], Line):
            xs += [g.a[0], g.b[0]]
            ys += [g.a[1], g.b[1]]
        else:
            xs += [g.c[0] - g.r, g.c[0] + g.r]
            ys += [g.c[1] - g.r, g.c[1] + g.r]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)

    def inside(p) -> bool:
        if winding_number(p, curves, region.outer) == 0:
            return False
        return all(winding_number(p, curves, h) == 0 for h in region.holes)

    def clearance(p) -> float:
        return min(dist_point_curve(p, curve_geometry(curves[i])) for i in idx)

    best, best_d = None, -1.0
    n = 24
    for i in range(n + 1):
        for j in range(n + 1):
            p = (x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * j / n)
            if inside(p):
                d = clearance(p)
                if d > best_d:
                    best, best_d = p, d
    if best is None:  # a sliver: fall back to a finer scan along the test point's neighbourhood
        tp = region.outer.test_point
        best, best_d = tp, 0.0
    step = max(x1 - x0, y1 - y0) / n
    for _ in range(30):
        improved = False
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            p = (best[0] + dx * step, best[1] + dy * step)
            if inside(p):
                d = clearance(p)
                if d > best_d:
                    best, best_d, improved = p, d, True
        if not improved:
            step *= 0.5
    return best


def vertex_names(curves: list, q: tuple[float, float]) -> list[str]:
    """The curve ends (`c.start` / `c.end`) within tol of the 2D point q."""
    out = []
    for c in curves:
        if isinstance(c, Circle):
            continue
        for which, p in (("start", c.start), ("end", c.end)):
            if math.hypot(p[0] - q[0], p[1] - q[1]) <= TOL:
                out.append(f"{c.id}.{which}")
    return out


def junction_qualifier(curves: list, ca: str, cb: str, q: tuple[float, float]) -> str | None:
    """`@c.end` of a side–side edge between the sides of curves ca and cb near the 2D point q:
    the byte-wise smallest curve end at the shared sketch vertex nearest to q."""
    by_id = {c.id: c for c in curves}
    a, b = by_id.get(ca), by_id.get(cb)
    if a is None or b is None or isinstance(a, Circle) or isinstance(b, Circle):
        return None
    shared = []
    for pa in (a.start, a.end):
        for pb in (b.start, b.end):
            if math.hypot(pa[0] - pb[0], pa[1] - pb[1]) <= TOL:
                shared.append(pa)
    if not shared:
        return None
    v = min(shared, key=lambda p: math.hypot(p[0] - q[0], p[1] - q[1]))
    names = vertex_names(curves, v)
    return min(names, key=lambda s: s.encode()) if names else None


def _side_curve(key: str, feature: str) -> str | None:
    pre = f"{feature}/side:"
    return key[len(pre):] if key.startswith(pre) else None


# ---------------------------------------------------------------------------------------------
# Extrude
# ---------------------------------------------------------------------------------------------

def extrude_range(distance: float, direction: str) -> tuple[float, float]:
    """(start, end) of the sweep along the normal; `start` is the cap:start plane (§5.2)."""
    if direction == "symmetric":
        return -distance / 2.0, distance / 2.0
    if direction == "reverse":
        return 0.0, -distance
    return 0.0, distance


def build_extrude(fid: str, name: str, order: int, curves: list, regions: list[Region],
                  pl: ResolvedPlane, distance: float, direction: str, gate: list | None = None) -> list[Body]:
    feat = ExtrudeFeature(fid, name, "", distance, direction)
    bodies = []
    t0, t1 = extrude_range(distance, direction)
    n = pl.normal
    for region in regions:
        face = occt.build_face(curves, region, pl)
        solid = occt.extrude(face, pl, distance, direction)
        m = occt.body_metrics(solid)
        _gate(feat, curves, region, pl, m, solid, gate)
        member = min(region.outer_curves, key=lambda s: s.encode())
        body = Body(solid, fid, member, order)
        body.metrics = m
        from .topo import count_shells

        m["shells"] = count_shells(solid)
        body.build_topology()
        q = region_interior_point(curves, region)
        targets = [
            (f"{fid}/cap:start@{member}", geom.add(pl.to3d(q), geom.mul(n, t0))),
            (f"{fid}/cap:end@{member}", geom.add(pl.to3d(q), geom.mul(n, t1))),
        ]
        tm = 0.5 * (t0 + t1)
        for lp in region_loops(region):
            for e in lp.edges:
                c = curves[e.index]
                targets.append((f"{fid}/side:{c.id}", geom.add(pl.to3d(curve_mid(c)), geom.mul(n, tm))))
        body.assign_face_keys(targets)

        def qualifier(edge, ka, kb, curves=curves):
            a, b = _side_curve(ka, fid), _side_curve(kb, fid)
            if a is None or b is None:
                return None
            p = edge.point()
            o = pl.origin
            q2 = (geom.dot(geom.sub(p, o), pl.x), geom.dot(geom.sub(p, o), pl.y))
            return junction_qualifier(curves, a, b, q2)

        body.key_edges_and_vertices(fid, qualifier)
        bodies.append(body)
    return bodies


def _gate(feat, curves, region, pl, m, solid, gate) -> None:
    if not m["valid"]:
        raise TopoError("OCCT_INVALID_RESULT",
                        f"BRepCheck_Analyzer rejects the OCCT solid for region {region.outer_curves}")
    problems = check_body(feat, curves, region, pl, m, solid)
    if problems:
        if gate is not None:
            gate.extend(f"{feat.id} region {region.outer_curves}: {p}" for p in problems)
        raise TopoError("OCCT_SELF_CHECK_FAILED",
                        f"OCCT body for region {region.outer_curves} disagrees with the spec's "
                        f"closed-form prediction: {'; '.join(problems)}")


# ---------------------------------------------------------------------------------------------
# Revolve
# ---------------------------------------------------------------------------------------------

def revolve_angles(angle: float, direction: str) -> tuple[float, float]:
    """(start, end) sweep angles in degrees about the axis direction; `start` is endcap:start."""
    if direction == "symmetric":
        return -angle / 2.0, angle / 2.0
    if direction == "reverse":
        return 0.0, -angle
    return 0.0, angle


def _rot(p, a3, d3, deg: float):
    r = math.radians(deg)
    return geom.add(a3, geom.rotate(geom.sub(p, a3), d3, math.sin(r), math.cos(r)))


def build_revolve(fid: str, name: str, order: int, curves: list, regions: list[Region],
                  pl: ResolvedPlane, axis_origin, axis_direction, angle: float, direction: str,
                  gate: list | None = None) -> list[Body]:
    feat = RevolveFeature(fid, name, "", tuple(axis_origin), tuple(axis_direction), angle, direction)
    snapped = snap_to_axis(curves, feat.axis_origin, feat.axis_direction)
    a3 = pl.to3d(feat.axis_origin)
    # The v0 oracle's arithmetic, call for call (`sum` is Python's compensated float sum), so a
    # migrated v0 document gets bit-identical bodies.
    d3 = pl.dir3d(feat.axis_direction)
    nd = math.sqrt(sum(c * c for c in d3))
    d3 = (d3[0] / nd, d3[1] / nd, d3[2] / nd)
    L = math.hypot(*feat.axis_direction)
    d2 = (feat.axis_direction[0] / L, feat.axis_direction[1] / L)
    n2 = (-d2[1], d2[0])
    th0, th1 = revolve_angles(angle, direction)
    full = angle >= 360.0
    bodies = []
    for region in regions:
        face = occt.build_face(snapped, region, pl)
        solid = occt.revolve(face, a3, d3, angle, direction)
        m = occt.body_metrics(solid)
        _gate(feat, snapped, region, pl, m, solid, gate)
        member = min(region.outer_curves, key=lambda s: s.encode())
        body = Body(solid, fid, member, order)
        from .topo import count_shells

        m["shells"] = count_shells(solid)
        body.metrics = m
        body.build_topology()
        q = region_interior_point(snapped, region)
        side = 1.0 if (d2[0] * (q[1] - feat.axis_origin[1]) - d2[1] * (q[0] - feat.axis_origin[0])) >= 0 else -1.0
        targets = []
        if not full:
            targets.append((f"{fid}/endcap:start@{member}", _rot(pl.to3d(q), a3, d3, th0)))
            targets.append((f"{fid}/endcap:end@{member}", _rot(pl.to3d(q), a3, d3, th1)))
        tm = 0.5 * (th0 + th1)
        for lp in region_loops(region):
            for e in lp.edges:
                c = snapped[e.index]
                if isinstance(c, Line) and _on_axis(c.start, feat) and _on_axis(c.end, feat):
                    continue  # a profile line on the axis generates no face
                targets.append((f"{fid}/side:{c.id}", _rot(pl.to3d(curve_mid(c)), a3, d3, tm)))
        body.assign_face_keys(targets)

        def qualifier(edge, ka, kb, snapped=snapped, side=side):
            a, b = _side_curve(ka, fid), _side_curve(kb, fid)
            if a is None or b is None:
                return None
            p = edge.point()
            rel = geom.sub(p, a3)
            z = geom.dot(rel, d3)
            rho = geom.norm(geom.sub(rel, geom.mul(d3, z)))
            q2 = (feat.axis_origin[0] + z * d2[0] + side * rho * n2[0],
                  feat.axis_origin[1] + z * d2[1] + side * rho * n2[1])
            return junction_qualifier(snapped, a, b, q2)

        body.key_edges_and_vertices(fid, qualifier)
        bodies.append(body)
    return bodies


def _on_axis(p, feat: RevolveFeature) -> bool:
    L = math.hypot(*feat.axis_direction)
    d = (feat.axis_direction[0] / L, feat.axis_direction[1] / L)
    return abs(d[0] * (p[1] - feat.axis_origin[1]) - d[1] * (p[0] - feat.axis_origin[0])) <= TOL


def check_revolve_profile(curves: list, regions: list[Region], axis_origin, axis_direction) -> None:
    """v0 §4.3: a region with points on both sides of the axis → REVOLVE_CROSSES_AXIS."""
    from ..sketch import signed_extent

    for r in regions:
        lo, hi = signed_extent(curves, r.outer, tuple(axis_origin), tuple(axis_direction))
        if lo < -TOL and hi > TOL:
            raise FeatureFailure(
                "REVOLVE_CROSSES_AXIS",
                f"region {r.outer_curves} has points on both sides of the revolve axis "
                f"(signed distance range [{lo:.9g}, {hi:.9g}] mm)",
                {"region": r.outer_curves},
            )


__all__ = ["FeatureFailure", "build_extrude", "build_revolve", "check_revolve_profile"]
