"""Independent self-checks of oracle bodies — a gate on every body the oracle reports.

For every body the oracle builds with OCCT, predict from the 2D profile alone:
  * volume — extrude: area × distance; revolve: Pappus, angle × |∬ signed-distance dA|;
  * area — extrude: 2·A + perimeter·d; revolve: angle × Σ|∫ρ ds| (+ 2·A end caps);
  * centroid — extrude only: region centroid + half the sweep;
  * faces / edges / face_types / edge_types — from the SPEC §4–§5 counting rules
    (one face per non-axis profile curve, end caps when angle < 360, no seams, no degenerate
    edges, profile edges on the axis generate no faces);
  * bbox — cross-checked against OCCT's own BRepBndLib::AddOptimal.
Any disagreement means OCCT (or the oracle's normalisation of OCCT conventions) did not
produce the exact geometry the spec defines — e.g. BRepSweep_Rotation turns a profile line up
to ~3e-4 rad off parallel into a cylinder. evaluate.py then fails the feature with the
engine-prefixed code OCCT_SELF_CHECK_FAILED (SPEC §4 [R-12]; §6 classifies it as ROBUSTNESS).
"""

from __future__ import annotations

import math

from .ir import LINEAR_TOLERANCE, Circle, Curve, ExtrudeFeature, Line, ResolvedPlane, RevolveFeature, Vec2
from .sketch import Loop, Region, region_area, region_moments

#: SPEC §1: angular tolerance for classification (parallel / perpendicular), 1e-9 rad.
ANGULAR_TOL = 1e-9
#: Relative tolerance of the closed-form volume / area / centroid gate. 100× inside the §6 diff
#: tolerance (1e-6) and ~300× above OCCT's measured integration noise (≤ 3.2e-11); allows the
#: in-spec geometric snapping of lines within 1e-9 rad of parallel/perpendicular.
METRIC_GATE = 1e-8


def _loops(region: Region) -> list[Loop]:
    return [region.outer, *region.holes]


def _add(h: dict, k: str, n: int = 1) -> None:
    if n:
        h[k] = h.get(k, 0) + n


def expected_extrude(curves: list[Curve], region: Region) -> dict:
    faces, edges = 2, 0
    ft: dict[str, int] = {"plane": 2}
    et: dict[str, int] = {}
    for lp in _loops(region):
        k = len(lp.edges)
        faces += k
        for e in lp.edges:
            c = curves[e.index]
            _add(ft, "plane" if isinstance(c, Line) else "cylinder")
            _add(et, "line" if isinstance(c, Line) else "circle", 2)  # bottom + top copies
            edges += 2
        if not (k == 1 and isinstance(curves[lp.edges[0].index], Circle)):
            edges += k  # one straight edge per vertex
            _add(et, "line", k)
    return {"faces": faces, "edges": edges, "face_types": ft, "edge_types": et}


def expected_revolve(curves: list[Curve], region: Region, origin: Vec2, direction: Vec2, angle: float) -> dict:
    L = math.hypot(*direction)
    d = (direction[0] / L, direction[1] / L)

    def sd(p: Vec2) -> float:
        return d[0] * (p[1] - origin[1]) - d[1] * (p[0] - origin[0])

    full = angle >= 360.0
    faces = 0 if full else 2
    edges = 0
    ft: dict[str, int] = {} if full else {"plane": 2}
    et: dict[str, int] = {}
    for lp in _loops(region):
        for e in lp.edges:
            c = curves[e.index]
            if isinstance(c, Line):
                on_axis = abs(sd(c.start)) <= LINEAR_TOLERANCE and abs(sd(c.end)) <= LINEAR_TOLERANCE
                if on_axis:
                    if not full:
                        edges += 1  # shared by both end caps
                        _add(et, "line")
                    continue
                t = (c.end[0] - c.start[0], c.end[1] - c.start[1])
                tl = math.hypot(*t)
                cos = abs(t[0] * d[0] + t[1] * d[1]) / tl
                sin = abs(t[0] * d[1] - t[1] * d[0]) / tl
                _add(ft, "cylinder" if sin <= ANGULAR_TOL else "plane" if cos <= ANGULAR_TOL else "cone")
                faces += 1
                if not full:
                    edges += 2
                    _add(et, "line", 2)
            else:
                center = c.center
                _add(ft, "sphere" if abs(sd(center)) <= LINEAR_TOLERANCE else "torus")
                faces += 1
                if not full:
                    edges += 2
                    _add(et, "circle", 2)
        # vertices off the axis sweep one circular edge each
        if not (len(lp.edges) == 1 and isinstance(curves[lp.edges[0].index], Circle)):
            for e in lp.edges:
                c = curves[e.index]
                p = c.end if e.forward else c.start  # type: ignore[union-attr]
                if abs(sd(p)) > LINEAR_TOLERANCE:
                    edges += 1
                    _add(et, "circle")
    return {"faces": faces, "edges": edges, "face_types": ft, "edge_types": et}


def _curve_sd_integral(c: Curve, origin: Vec2, d: Vec2) -> tuple[float, float]:
    """(length, ∫ signed-distance-to-axis ds) along a curve."""
    from .sketch import curve_geometry

    def sd(p: Vec2) -> float:
        return d[0] * (p[1] - origin[1]) - d[1] * (p[0] - origin[0])

    g = curve_geometry(c)
    if isinstance(c, Line):
        L = math.dist(c.start, c.end)
        return L, L * 0.5 * (sd(c.start) + sd(c.end))
    t0, t1 = g.t0, g.t0 + g.sweep
    integral = g.r * (
        sd(g.c) * (t1 - t0) + g.r * (d[0] * (math.cos(t0) - math.cos(t1)) - d[1] * (math.sin(t1) - math.sin(t0)))
    )
    return g.r * g.sweep, integral


def analytic_area(feat, curves: list[Curve], region: Region) -> float:
    """Exact surface area: extrude 2A + P·d; revolve θ·Σ|∫ρ ds| (+ 2A end caps if partial)."""
    loops = _loops(region)
    if isinstance(feat, ExtrudeFeature):
        per = sum(_curve_sd_integral(curves[e.index], (0.0, 0.0), (1.0, 0.0))[0] for lp in loops for e in lp.edges)
        return 2 * region_area(curves, region) + per * feat.distance
    L = math.hypot(*feat.axis_direction)
    d = (feat.axis_direction[0] / L, feat.axis_direction[1] / L)
    lateral = sum(abs(_curve_sd_integral(curves[e.index], feat.axis_origin, d)[1]) for lp in loops for e in lp.edges)
    caps = 0.0 if feat.angle >= 360.0 else 2 * region_area(curves, region)
    return math.radians(feat.angle) * lateral + caps


def check_body(
    feat, curves: list[Curve], region: Region, pl: ResolvedPlane, metrics: dict, solid=None
) -> list[str]:
    """Return a list of human-readable self-check failures for one body."""
    problems: list[str] = []
    area, mx, my = region_moments(curves, region)
    if isinstance(feat, ExtrudeFeature):
        exp = expected_extrude(curves, region)
        vol = area * feat.distance
        cu, cv = mx / area, my / area
        off = {"normal": 0.5, "reverse": -0.5, "symmetric": 0.0}[feat.direction] * feat.distance
        c3 = pl.to3d((cu, cv))
        cen = [c3[i] + pl.normal[i] * off for i in range(3)]
    else:
        assert isinstance(feat, RevolveFeature)
        exp = expected_revolve(curves, region, feat.axis_origin, feat.axis_direction, feat.angle)
        L = math.hypot(*feat.axis_direction)
        dx, dy = feat.axis_direction[0] / L, feat.axis_direction[1] / L
        ox, oy = feat.axis_origin
        first = dx * (my - area * oy) - dy * (mx - area * ox)  # ∬ signed distance dA
        vol = math.radians(feat.angle) * abs(first)
        cen = None
    s = max(1.0, math.dist(metrics["bbox_min"], metrics["bbox_max"]))
    if abs(metrics["volume"] - vol) > METRIC_GATE * max(abs(vol), 1e-9 * s**3):
        problems.append(f"volume {metrics['volume']!r} != analytic {vol!r}")
    area_exact = analytic_area(feat, curves, region)
    if abs(metrics["area"] - area_exact) > METRIC_GATE * max(abs(area_exact), 1e-9 * s**2):
        problems.append(f"area {metrics['area']!r} != analytic {area_exact!r}")
    if cen is not None:
        if any(abs(metrics["centroid"][i] - cen[i]) > METRIC_GATE * s for i in range(3)):
            problems.append(f"centroid {metrics['centroid']} != analytic {cen}")
    for k in ("faces", "edges", "face_types", "edge_types"):
        if metrics[k] != exp[k]:
            problems.append(f"{k} {metrics[k]} != spec-predicted {exp[k]}")
    if not metrics["valid"]:
        problems.append("BRepCheck_Analyzer reports the solid invalid")
    if solid is not None:
        from OCP.Bnd import Bnd_Box
        from OCP.BRepBndLib import BRepBndLib

        box = Bnd_Box()
        BRepBndLib.AddOptimal_s(solid, box, False, False)
        v = box.Get()
        lo, hi = v[:3], v[3:]
        for i in range(3):
            if not (lo[i] - 1e-9 * s <= metrics["bbox_min"][i] and metrics["bbox_max"][i] <= hi[i] + 1e-9 * s):
                problems.append(f"tight bbox not inside OCCT AddOptimal box on axis {i}")
            if abs(lo[i] - metrics["bbox_min"][i]) > 1e-6 * s or abs(hi[i] - metrics["bbox_max"][i]) > 1e-6 * s:
                problems.append(f"tight bbox differs from OCCT AddOptimal box by > 1e-6·s on axis {i}")
    return problems
