"""Independent self-checks of oracle bodies — a gate on every body the oracle reports.

For every body the oracle builds with OCCT, predict from the 2D profile alone:
  * volume — extrude: area × distance; revolve: Pappus, angle × |∬ signed-distance dA|;
  * area — extrude: 2·A + perimeter·d; revolve: angle × Σ|∫ρ ds| (+ 2·A end caps);
  * centroid — extrude only: region centroid + half the sweep;
  * faces / edges / face_types / edge_types — from the SPEC §4–§5 counting rules
    (one face per non-axis profile curve, end caps when angle < 360, no seams, no degenerate
    edges, profile edges on the axis generate no faces);
  * bbox — closed form: extremes of the swept profile boundary (not OCCT's AddOptimal, which
    is wrong for OCCT's surface-of-revolution horn tori).
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


def _linear_extremes(curves: list[Curve], region: Region, o: Vec2, g: Vec2) -> tuple[float, float]:
    """(max, min) of dot(p − o, g) over the region's boundary curves (closed form)."""
    from .sketch import curve_geometry

    def f(p) -> float:
        return (p[0] - o[0]) * g[0] + (p[1] - o[1]) * g[1]

    gn = math.hypot(*g)
    if gn == 0.0:
        return 0.0, 0.0  # the coordinate does not depend on the sketch point
    vals: list[float] = []
    for lp in _loops(region):
        for e in lp.edges:
            c = curves[e.index]
            geo = curve_geometry(c)
            if isinstance(c, Line):
                vals += [f(c.start), f(c.end)]
                continue
            if not geo.full:
                vals += [f(geo.p0), f(geo.p1)]
            t = math.atan2(g[1], g[0])
            for tt in (t, t + math.pi):
                if geo.contains_angle(tt):
                    vals.append(f(geo.point(tt)))
    return max(vals), min(vals)


def predicted_bbox(feat, curves: list[Curve], region: Region, pl: ResolvedPlane) -> tuple[list[float], list[float]]:
    """Closed-form tight bbox of the swept region (independent of OCCT).

    The maximum of a coordinate over the solid is attained on the swept boundary curves.
    Extrude: coordinate(p + t·n) = e·O + dot(p, (e·x, e·y)) + t·(e·n), t over the sweep range.
    Revolve (axis A, Z; profile side ρ̂₀; ρ ≥ 0; sweep θ ∈ [θ₀, θ₁]):
      coordinate = e·A + z·(e·Z) + ρ·m·cos(θ − θ*), m = |(e·ρ̂₀, e·(Z×ρ̂₀))|; for fixed θ this is
      linear in the sketch point, and the optimal θ is θ*, θ*+π (when inside the sweep) or an end.
    """
    lo3: list[float] = []
    hi3: list[float] = []
    if isinstance(feat, ExtrudeFeature):
        a, b = {"normal": (0.0, feat.distance), "reverse": (-feat.distance, 0.0),
                "symmetric": (-feat.distance / 2, feat.distance / 2)}[feat.direction]
        for k in range(3):
            g = (pl.x[k], pl.y[k])
            mx, mn = _linear_extremes(curves, region, (0.0, 0.0), g)
            nk = pl.normal[k]
            hi3.append(pl.origin[k] + mx + max(a * nk, b * nk))
            lo3.append(pl.origin[k] + mn + min(a * nk, b * nk))
        return lo3, hi3
    L = math.hypot(*feat.axis_direction)
    dh = (feat.axis_direction[0] / L, feat.axis_direction[1] / L)
    n2 = (-dh[1], dh[0])
    o = feat.axis_origin
    from .sketch import signed_extent

    smin, smax = signed_extent(curves, region.outer, o, feat.axis_direction)
    side = 1.0 if smax >= -smin else -1.0
    A = pl.to3d(o)
    Zv = pl.dir3d(dh)
    zl = math.sqrt(sum(c * c for c in Zv))
    Z = tuple(c / zl for c in Zv)
    r0 = pl.dir3d((side * n2[0], side * n2[1]))
    rl = math.sqrt(sum(c * c for c in r0))
    rho0 = tuple(c / rl for c in r0)
    w = (Z[1] * rho0[2] - Z[2] * rho0[1], Z[2] * rho0[0] - Z[0] * rho0[2], Z[0] * rho0[1] - Z[1] * rho0[0])
    ang = math.radians(feat.angle)
    t0, t1 = {"normal": (0.0, ang), "reverse": (-ang, 0.0), "symmetric": (-ang / 2, ang / 2)}[feat.direction]
    for k in range(3):
        alpha, beta, gamma = Z[k], rho0[k], w[k]
        m = math.hypot(beta, gamma)
        ts = [t0, t1]
        if m > 0.0:
            tstar = math.atan2(gamma, beta)
            for cand in (tstar, tstar + math.pi):
                if ang >= 2 * math.pi - 1e-15:
                    ts.append(cand)
                else:
                    d = (cand - t0) % (2 * math.pi)
                    if d <= t1 - t0:
                        ts.append(t0 + d)
        best_hi, best_lo = -math.inf, math.inf
        for th in ts:
            c = beta * math.cos(th) + gamma * math.sin(th)
            # z-coefficient α along dh, ρ-coefficient c along side·n2
            g = (alpha * dh[0] + c * side * n2[0], alpha * dh[1] + c * side * n2[1])
            mx, mn = _linear_extremes(curves, region, o, g)
            best_hi, best_lo = max(best_hi, A[k] + mx), min(best_lo, A[k] + mn)
        hi3.append(best_hi)
        lo3.append(best_lo)
    return lo3, hi3


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
    lo, hi = predicted_bbox(feat, curves, region, pl)
    for i in range(3):
        if abs(metrics["bbox_min"][i] - lo[i]) > METRIC_GATE * s or abs(metrics["bbox_max"][i] - hi[i]) > METRIC_GATE * s:
            problems.append(
                f"bbox {metrics['bbox_min']}..{metrics['bbox_max']} != analytic {lo}..{hi} (axis {i})"
            )
    return problems
