#!/usr/bin/env python3
"""Differential oracle: forge-ssi vs OCCT (GeomInt_IntSS) on analytic surface pairs.

CI/dev tooling only (OCCT is LGPL; never a runtime dependency of Forge).

Usage (from the repository's ``oracle/`` directory, which has uv + OCP):

    cargo run --release -p forge-ssi --example ssi_oracle_batch -- \
        --seed 17 --count 2400 --out /tmp/ssi_batch.jsonl         # from forge/
    uv run python ../forge/crates/forge-ssi/oracle/occt_ssi_diff.py \
        /tmp/ssi_batch.jsonl --out /tmp/ssi_report.json
    uv run python ../forge/crates/forge-ssi/oracle/occt_ssi_diff.py \
        /tmp/ssi_batch.jsonl --bench                                # timings

For every pair the script builds the same surfaces in OCCT, intersects them with
``GeomInt_IntSS`` (approximated B-spline curves for the general case), clips OCCT's
curves to Forge's parameter boxes (Forge's parametrization conventions, boundary points
refined by bisection), and compares:

* **components** – connected pieces after gluing curve ends closer than ``GLUE`` (OCCT
  often splits one closed curve into several arcs, so raw branch counts are not
  comparable) and how many of them are closed;
* **Hausdorff distance** between the two point sets (point-to-polyline, both ways; Forge
  both sides are sampled with a chord sagitta <= 1e-5 mm);
* **isolated points** (tangential contacts);
* **accuracy** – distance of every sampled point to both surfaces (exact distance
  forms), i.e. which side is actually on the surfaces.

Disagreements are adjudicated by an independent brute-force "truth" sampler: a dense
grid over each surface's box, sign changes of the other surface's distance form refined
by bisection, giving points that are certainly on both surfaces. A result that misses
truth points (missed branch) or has points off the surfaces is wrong.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict

import numpy as np
from scipy.spatial import cKDTree
from OCP.GeomInt import GeomInt_IntSS
from OCP.Geom import (
    Geom_ConicalSurface,
    Geom_CylindricalSurface,
    Geom_Plane,
    Geom_SphericalSurface,
    Geom_ToroidalSurface,
)
from OCP.gp import gp_Ax3, gp_Dir, gp_Pnt
from OCP.Standard import Standard_Failure

TAU = 2.0 * math.pi
GLUE = 1e-4          # mm: curve ends closer than this are the same point
AGREE_HAUSDORFF = 1e-4  # mm: point sets closer than this agree
ON_SURFACE = 1e-5    # mm: a point farther than this from a surface is "off"
OCCT_TOL = 1e-7
SAGITTA = 1e-5       # mm: max chord sagitta of sampled polylines (both sides)


# --------------------------------------------------------------------------------------
# Surfaces with Forge's conventions (numpy)


class Surf:
    """An analytic surface with Forge's parametrization and distance form."""

    def __init__(self, d: dict):
        self.kind = d["type"]
        self.o = np.array(d["origin"], float)
        self.z = np.array(d["z"], float)
        self.x = np.array(d["x"], float)
        self.y = np.cross(self.z, self.x)
        self.d = d
        if self.kind == "cone":
            self.ta = math.tan(d["half_angle"])

    def local(self, p: np.ndarray) -> np.ndarray:
        r = p - self.o
        return np.stack([r @ self.x, r @ self.y, r @ self.z], axis=-1)

    def eval(self, u: np.ndarray, v: np.ndarray) -> np.ndarray:
        k = self.kind
        if k == "plane":
            loc = np.stack([u, v, np.zeros_like(u)], -1)
        elif k == "cylinder":
            r = self.d["radius"]
            loc = np.stack([r * np.cos(u), r * np.sin(u), v], -1)
        elif k == "cone":
            r = self.d["radius"] + v * self.ta
            loc = np.stack([r * np.cos(u), r * np.sin(u), v], -1)
        elif k == "sphere":
            r = self.d["radius"]
            loc = np.stack([r * np.cos(v) * np.cos(u), r * np.cos(v) * np.sin(u), r * np.sin(v)], -1)
        else:
            big, small = self.d["major"], self.d["minor"]
            rho = big + small * np.cos(v)
            loc = np.stack([rho * np.cos(u), rho * np.sin(u), small * np.sin(v)], -1)
        return self.o + loc[..., 0:1] * self.x + loc[..., 1:2] * self.y + loc[..., 2:3] * self.z

    def dist(self, p: np.ndarray) -> np.ndarray:
        """Signed distance form (as forge_core::geom::surface::implicit)."""
        l = self.local(p)
        k = self.kind
        rho = np.hypot(l[..., 0], l[..., 1])
        if k == "plane":
            return l[..., 2]
        if k == "cylinder":
            return rho - self.d["radius"]
        if k == "cone":
            ca = math.cos(self.d["half_angle"])
            return (rho - np.abs(self.d["radius"] + l[..., 2] * self.ta)) * ca
        if k == "sphere":
            return np.linalg.norm(l, axis=-1) - self.d["radius"]
        return np.hypot(rho - self.d["major"], l[..., 2]) - self.d["minor"]

    def uv(self, p: np.ndarray, ref: tuple[float, float]) -> tuple[np.ndarray, np.ndarray]:
        """Forge parameters, periodic ones in (ref - pi, ref + pi]."""
        l = self.local(p)
        k = self.kind

        def ang(x, y, r):
            return r + np.arctan2(-x * math.sin(r) + y * math.cos(r), x * math.cos(r) + y * math.sin(r))

        if k == "plane":
            return l[..., 0], l[..., 1]
        if k == "cylinder":
            return ang(l[..., 0], l[..., 1], ref[0]), l[..., 2]
        if k == "cone":
            rh = self.d["radius"] + l[..., 2] * self.ta
            s = np.where(rh < 0, -1.0, 1.0)
            return ang(s * l[..., 0], s * l[..., 1], ref[0]), l[..., 2]
        if k == "sphere":
            return ang(l[..., 0], l[..., 1], ref[0]), np.arctan2(l[..., 2], np.hypot(l[..., 0], l[..., 1]))
        rho = np.hypot(l[..., 0], l[..., 1])
        return ang(l[..., 0], l[..., 1], ref[0]), ang(rho - self.d["major"], l[..., 2], ref[1])

    def occt(self):
        ax = gp_Ax3(gp_Pnt(*self.o), gp_Dir(*self.z), gp_Dir(*self.x))
        k = self.kind
        if k == "plane":
            return Geom_Plane(ax)
        if k == "cylinder":
            return Geom_CylindricalSurface(ax, self.d["radius"])
        if k == "cone":
            return Geom_ConicalSurface(ax, self.d["half_angle"], self.d["radius"])
        if k == "sphere":
            return Geom_SphericalSurface(ax, self.d["radius"])
        return Geom_ToroidalSurface(ax, self.d["major"], self.d["minor"])

    def periodic(self) -> tuple[bool, bool]:
        return (self.kind != "plane", self.kind == "torus")


class Box:
    def __init__(self, d: dict, s: Surf):
        self.u = tuple(d["u"])
        self.v = tuple(d["v"])
        self.s = s
        pu, pv = s.periodic()
        self.full_u = pu and self.u[1] - self.u[0] >= TAU * (1 - 1e-12)
        self.full_v = pv and self.v[1] - self.v[0] >= TAU * (1 - 1e-12)
        self.ref = (0.5 * (self.u[0] + self.u[1]), 0.5 * (self.v[0] + self.v[1]))

    def inside(self, p: np.ndarray, slack: float = 1e-9) -> np.ndarray:
        u, v = self.s.uv(p, self.ref)
        ok = np.ones(u.shape, bool)
        if not self.full_u:
            ok &= (u >= self.u[0] - slack) & (u <= self.u[1] + slack)
        if not self.full_v:
            ok &= (v >= self.v[0] - slack) & (v <= self.v[1] + slack)
        return ok


# --------------------------------------------------------------------------------------
# Geometry helpers


def seg_dist(points: np.ndarray, polylines: list[np.ndarray], k: int = 6) -> np.ndarray:
    """Distance from each point to the nearest segment of any polyline.

    A KD-tree over all vertices finds the ``k`` nearest vertices; the exact
    point-to-segment distance is then taken over the segments adjacent to them (exact for
    dense polylines, whose nearest segment always touches one of the nearest vertices).
    """
    if not polylines or len(points) == 0:
        return np.full(len(points), np.inf)
    verts = np.vstack(polylines)
    starts = np.cumsum([0] + [len(p) for p in polylines])
    owner_end = np.repeat(starts[1:], [len(p) for p in polylines])
    owner_start = np.repeat(starts[:-1], [len(p) for p in polylines])
    tree = cKDTree(verts)
    kk = min(k, len(verts))
    _, idx = tree.query(points, k=kk)
    idx = idx.reshape(len(points), kk)
    best = np.linalg.norm(points - verts[idx[:, 0]], axis=1)
    for off in (-1, 0):
        a_i = idx + off
        b_i = a_i + 1
        valid = (a_i >= owner_start[idx]) & (b_i < owner_end[idx])
        a_i = np.where(valid, a_i, idx)
        b_i = np.where(valid, b_i, idx)
        a = verts[a_i]
        b = verts[b_i]
        ab = b - a
        l2 = np.maximum((ab * ab).sum(-1), 1e-300)
        t = np.clip(((points[:, None, :] - a) * ab).sum(-1) / l2, 0.0, 1.0)
        q = a + t[..., None] * ab
        d = np.linalg.norm(points[:, None, :] - q, axis=-1).min(1)
        best = np.minimum(best, d)
    return best


def components(polylines: list[np.ndarray], glue: float) -> tuple[int, int]:
    """(components, closed components) of polylines glued at nearby end points."""
    n = len(polylines)
    if n == 0:
        return 0, 0
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    ends = []
    for i, pl in enumerate(polylines):
        ends.append((i, 0, pl[0]))
        ends.append((i, 1, pl[-1]))
    glued = [[False, False] for _ in range(n)]
    for a in range(len(ends)):
        for b in range(a + 1, len(ends)):
            ia, ea, pa = ends[a]
            ib, eb, pb = ends[b]
            if np.linalg.norm(pa - pb) <= glue:
                glued[ia][ea] = True
                glued[ib][eb] = True
                parent[find(ia)] = find(ib)
    comps = defaultdict(list)
    for i in range(n):
        comps[find(i)].append(i)
    closed = sum(1 for c in comps.values() if all(glued[i][0] and glued[i][1] for i in c))
    return len(comps), closed


# --------------------------------------------------------------------------------------
# OCCT side


def sample_curve(c, box_a: Box, box_b: Box, n: int = 3000) -> list[np.ndarray]:
    """Sample an OCCT curve, keep the parts inside both boxes (ends refined)."""
    f, l = c.FirstParameter(), c.LastParameter()
    name = c.DynamicType().Name()
    basis = c
    if name == "Geom_TrimmedCurve":
        basis = c.BasisCurve()
    bname = basis.DynamicType().Name()
    big = 1e9
    if abs(f) > big or abs(l) > big:
        lim = 6.0 if "Hyperbola" in bname else 80.0
        f, l = max(f, -lim), min(l, lim)
    ts = np.linspace(f, l, n)

    def pts_at(t):
        return np.array([[c.Value(x).X(), c.Value(x).Y(), c.Value(x).Z()] for x in np.atleast_1d(t)])

    pts = pts_at(ts)
    # Refine until every chord's sagitta (curve midpoint vs chord) is <= SAGITTA.
    for _ in range(40):
        tm = 0.5 * (ts[:-1] + ts[1:])
        pm = pts_at(tm)
        a, b = pts[:-1], pts[1:]
        ab = b - a
        l2 = np.maximum((ab * ab).sum(1), 1e-300)
        s = np.clip(((pm - a) * ab).sum(1) / l2, 0.0, 1.0)
        dev = np.linalg.norm(a + s[:, None] * ab - pm, axis=1)
        bad = np.nonzero((dev > SAGITTA) & (np.diff(ts) > 1e-13 * (1 + np.abs(ts[:-1]))))[0]
        if len(bad) == 0 or len(ts) > 200000:
            break
        order = np.argsort(np.concatenate([ts, tm[bad]]), kind="stable")
        ts = np.concatenate([ts, tm[bad]])[order]
        pts = np.vstack([pts, pm[bad]])[order]
    n = len(ts)

    def ok(p):
        return box_a.inside(p, 1e-9) & box_b.inside(p, 1e-9)

    mask = ok(pts)
    runs = []
    i = 0
    while i < n:
        if not mask[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and mask[j + 1]:
            j += 1
        seg_t = list(ts[i : j + 1])
        # Refine the ends by bisection on the curve parameter.
        if i > 0:
            lo, hi = ts[i - 1], ts[i]
            for _ in range(50):
                m = 0.5 * (lo + hi)
                if ok(pts_at(m))[0]:
                    hi = m
                else:
                    lo = m
            seg_t.insert(0, hi)
        if j + 1 < n:
            lo, hi = ts[j], ts[j + 1]
            for _ in range(50):
                m = 0.5 * (lo + hi)
                if ok(pts_at(m))[0]:
                    lo = m
                else:
                    hi = m
            seg_t.append(lo)
        runs.append(pts_at(np.array(seg_t)))
        i = j + 1
    return runs


def occt_intersect(sa: Surf, sb: Surf, box_a: Box, box_b: Box):
    try:
        it = GeomInt_IntSS(sa.occt(), sb.occt(), OCCT_TOL, True, False, False)
    except Standard_Failure as e:  # pragma: no cover - depends on OCCT
        return {"status": "error", "message": str(e)}
    if not it.IsDone():
        return {"status": "not_done"}
    polylines = []
    for i in range(1, it.NbLines() + 1):
        try:
            polylines.extend(sample_curve(it.Line(i), box_a, box_b))
        except Standard_Failure as e:
            return {"status": "error", "message": str(e)}
    points = []
    for i in range(1, it.NbPoints() + 1):
        p = it.Point(i)
        q = np.array([[p.X(), p.Y(), p.Z()]])
        if box_a.inside(q, 1e-7)[0] and box_b.inside(q, 1e-7)[0]:
            points.append(q[0])
    return {
        "status": "ok",
        "polylines": polylines,
        "points": points,
        "tol3d": it.TolReached3d(),
    }


# --------------------------------------------------------------------------------------
# Independent truth sampler


def truth_points(sa: Surf, box_a: Box, sb: Surf, box_b: Box, n: int = 360) -> np.ndarray:
    """Points on both surfaces from sign changes of d_b over a grid on a (and vice versa),
    refined by bisection along the grid edge and filtered to both boxes."""
    out = []
    for s1, b1, s2, b2 in ((sa, box_a, sb, box_b), (sb, box_b, sa, box_a)):
        u = np.linspace(b1.u[0], b1.u[1], n)
        v = np.linspace(b1.v[0], b1.v[1], n)
        uu, vv = np.meshgrid(u, v, indexing="ij")
        f = s2.dist(s1.eval(uu, vv))
        for axis in (0, 1):
            f0 = f[:-1, :] if axis == 0 else f[:, :-1]
            f1 = f[1:, :] if axis == 0 else f[:, 1:]
            idx = np.nonzero(np.signbit(f0) != np.signbit(f1))
            if len(idx[0]) == 0:
                continue
            i, j = idx
            ua, va = uu[i, j], vv[i, j]
            ub = uu[i + 1, j] if axis == 0 else uu[i, j + 1]
            vb = vv[i + 1, j] if axis == 0 else vv[i, j + 1]
            fa = f0[i, j]
            lo = np.zeros_like(ua)
            hi = np.ones_like(ua)
            for _ in range(40):
                m = 0.5 * (lo + hi)
                fm = s2.dist(s1.eval(ua + (ub - ua) * m, va + (vb - va) * m))
                same = np.signbit(fm) == np.signbit(fa)
                lo = np.where(same, m, lo)
                hi = np.where(same, hi, m)
            m = 0.5 * (lo + hi)
            p = s1.eval(ua + (ub - ua) * m, va + (vb - va) * m)
            keep = (np.abs(s2.dist(p)) < 1e-6) & b2.inside(p, 1e-9)
            out.append(p[keep])
    return np.vstack(out) if out else np.zeros((0, 3))


def local_truth(sa: Surf, box_a: Box, sb: Surf, box_b: Box, centre: np.ndarray, radius: float) -> np.ndarray:
    """Intersection points near ``centre``: a fine grid on each surface around the
    parameters of ``centre`` (window of about ``radius`` in 3D), sign changes of the
    other surface's distance form refined by bisection."""
    out = []
    for s1, b1, s2, b2 in ((sa, box_a, sb, box_b), (sb, box_b, sa, box_a)):
        uu, vv = s1.uv(centre[None, :], b1.ref)
        u0, v0 = uu[0], vv[0]
        h = 1e-6
        pu = np.linalg.norm(s1.eval(np.array([u0 + h]), np.array([v0])) - s1.eval(np.array([u0]), np.array([v0]))) / h
        pv = np.linalg.norm(s1.eval(np.array([u0]), np.array([v0 + h])) - s1.eval(np.array([u0]), np.array([v0]))) / h
        wu = radius / max(pu, 1e-9)
        wv = radius / max(pv, 1e-9)
        n = 121
        us = np.linspace(u0 - wu, u0 + wu, n)
        vs = np.linspace(v0 - wv, v0 + wv, n)
        U, V = np.meshgrid(us, vs, indexing="ij")
        F = s2.dist(s1.eval(U, V))
        for axis in (0, 1):
            f0 = F[:-1, :] if axis == 0 else F[:, :-1]
            f1 = F[1:, :] if axis == 0 else F[:, 1:]
            i, j = np.nonzero(np.signbit(f0) != np.signbit(f1))
            if len(i) == 0:
                continue
            ua, va = U[i, j], V[i, j]
            ub = U[i + 1, j] if axis == 0 else U[i, j + 1]
            vb = V[i + 1, j] if axis == 0 else V[i, j + 1]
            fa = f0[i, j]
            lo, hi = np.zeros_like(ua), np.ones_like(ua)
            for _ in range(50):
                m = 0.5 * (lo + hi)
                fm = s2.dist(s1.eval(ua + (ub - ua) * m, va + (vb - va) * m))
                same = np.signbit(fm) == np.signbit(fa)
                lo = np.where(same, m, lo)
                hi = np.where(same, hi, m)
            m = 0.5 * (lo + hi)
            p = s1.eval(ua + (ub - ua) * m, va + (vb - va) * m)
            keep = (np.abs(s2.dist(p)) < 1e-9) & b1.inside(p, 1e-9) & b2.inside(p, 1e-9)
            out.append(p[keep])
    return np.vstack(out) if out else np.zeros((0, 3))


def dedupe_polylines(lines: list[np.ndarray], tol: float) -> tuple[list[np.ndarray], int]:
    """Drop polylines that duplicate another one (OCCT sometimes returns a curve twice)."""
    kept: list[np.ndarray] = []
    dup = 0
    for pl in lines:
        if kept and seg_dist(pl, kept).max() <= tol:
            dup += 1
            continue
        kept.append(pl)
    return kept, dup


# --------------------------------------------------------------------------------------


def compare(case: dict) -> dict:
    sa, sb = Surf(case["a"]), Surf(case["b"])
    box_a, box_b = Box(case["dom_a"], sa), Box(case["dom_b"], sb)
    fr = case["forge"]
    row = {"id": case["id"], "family": case["family"], "forge_status": fr["status"]}
    if fr["status"] != "ok":
        row["forge_code"] = fr.get("code")
    oc = occt_intersect(sa, sb, box_a, box_b)
    row["occt_status"] = oc["status"]
    if fr["status"] != "ok" or oc["status"] != "ok":
        row["verdict"] = "robustness"
        return row
    if fr.get("coincident"):
        row["forge_coincident"] = True
        row["occt_components"] = len(oc["polylines"])
        row["verdict"] = "coincident"
        return row

    # Forge exports sagitta-controlled samples (<= SAGITTA): plain polylines.
    f_lines = [np.array(b["points"], float) for b in fr["branches"]]
    branch_ends = [pl[0] for pl in f_lines] + [pl[-1] for pl in f_lines]
    f_iso = [
        np.array(v["point"])
        for v in fr["vertices"]
        if all(np.linalg.norm(np.array(v["point"]) - e) > GLUE for e in branch_ends)
    ]
    o_lines = [pl for pl in oc["polylines"] if len(pl) >= 2]
    # OCCT reports a tangential contact as a point or a degenerate curve.
    o_iso = list(oc["points"]) + [
        pl.mean(0) for pl in o_lines if np.linalg.norm(pl.max(0) - pl.min(0)) <= GLUE
    ]
    o_lines = [pl for pl in o_lines if np.linalg.norm(pl.max(0) - pl.min(0)) > GLUE]
    o_lines, dup = dedupe_polylines(o_lines, GLUE)
    if dup:
        row["occt_duplicates"] = dup

    nf, cf = components(f_lines, GLUE)
    no, co = components(o_lines, 10 * GLUE)
    row.update(forge_components=nf, forge_closed=cf, occt_components=no, occt_closed=co)
    fpts = np.vstack(f_lines) if f_lines else np.zeros((0, 3))
    opts = np.vstack(o_lines) if o_lines else np.zeros((0, 3))
    d_fo = seg_dist(fpts, o_lines) if len(fpts) and o_lines else None
    d_of = seg_dist(opts, f_lines) if len(opts) and f_lines else None
    h_fo = float(d_fo.max()) if d_fo is not None else (0.0 if not len(fpts) else math.inf)
    h_of = float(d_of.max()) if d_of is not None else (0.0 if not len(opts) else math.inf)
    row["hausdorff"] = max(h_fo, h_of)
    # Accuracy: distance of sampled points to both surfaces.
    if len(opts):
        row["occt_err"] = float(np.maximum(np.abs(sa.dist(opts)), np.abs(sb.dist(opts))).max())
    if len(fpts):
        raw = np.vstack([np.array(b["points"], float) for b in fr["branches"]])
        row["forge_err"] = float(np.maximum(np.abs(sa.dist(raw)), np.abs(sb.dist(raw))).max())
    # Isolated points.
    def matched(ps, lines, others):
        return all(
            any(np.linalg.norm(p - q) <= 1e-3 for q in others)
            or (lines and seg_dist(p[None, :], lines)[0] <= 1e-3)
            for p in ps
        )

    iso_ok = matched(f_iso, o_lines, o_iso) and matched(o_iso, f_lines, f_iso)
    row["forge_points"] = len(f_iso)
    row["occt_points"] = len(o_iso)
    agree = row["hausdorff"] <= AGREE_HAUSDORFF and nf == no and cf == co and iso_ok
    if agree:
        row["verdict"] = "agree"
        return row
    # Adjudicate with the truth sampler.
    truth = truth_points(sa, box_a, sb, box_b)
    row["truth_points"] = int(len(truth))
    reach = 0.05
    if len(truth):
        f_all = f_lines + [np.array([p]) for p in f_iso]
        o_all = o_lines + [np.array([p]) for p in o_iso]
        f_miss = int((seg_dist(truth, f_all) > reach).sum()) if f_all else len(truth)
        o_miss = int((seg_dist(truth, o_all) > reach).sum()) if o_all else len(truth)
    else:
        f_miss = o_miss = 0
    row["forge_missed_truth"] = f_miss
    row["occt_missed_truth"] = o_miss
    # Dangling ends: an intersection curve can only end on a box boundary or at a
    # tangency / singular point (an isolated vertex). An end in the interior of both
    # boxes is a gap in the curve.
    iso_all = f_iso + o_iso

    def dangling(lines, glue):
        ends = []
        for pl in lines:
            ends += [pl[0], pl[-1]]
        out = 0
        for i, e in enumerate(ends):
            if any(j != i and np.linalg.norm(e - f) <= glue for j, f in enumerate(ends)):
                continue
            if any(np.linalg.norm(e - q) <= 1e-3 for q in iso_all):
                continue
            q = e[None, :]
            on_boundary = not (box_a.inside(q, -1e-4)[0] and box_b.inside(q, -1e-4)[0])
            if not on_boundary:
                out += 1
        return out

    row["forge_dangling"] = dangling(f_lines, GLUE)
    row["occt_dangling"] = dangling(o_lines, 10 * GLUE)
    # Unmatched isolated points: are they really contacts (on both surfaces)?
    def on_both(p):
        q = p[None, :]
        return max(abs(sa.dist(q)[0]), abs(sb.dist(q)[0])) <= 1e-6

    f_iso_lost = sum(
        1
        for p in f_iso
        if on_both(p)
        and not any(np.linalg.norm(p - q) <= 1e-3 for q in o_iso)
        and not (o_lines and seg_dist(p[None, :], o_lines)[0] <= 1e-3)
    )
    o_iso_lost = sum(
        1
        for p in o_iso
        if on_both(p)
        and not any(np.linalg.norm(p - q) <= 1e-3 for q in f_iso)
        and not (f_lines and seg_dist(p[None, :], f_lines)[0] <= 1e-3)
    )
    row["occt_missed_contacts"] = f_iso_lost
    row["forge_missed_contacts"] = o_iso_lost
    # Local truth at the worst discrepancies: which curve is near the true intersection?
    local_f = local_o = 0.0
    if math.isfinite(row["hausdorff"]) and row["hausdorff"] > AGREE_HAUSDORFF:
        centres = []
        if d_fo is not None:
            centres.append(fpts[int(d_fo.argmax())])
        if d_of is not None:
            centres.append(opts[int(d_of.argmax())])
        radius = min(max(20.0 * row["hausdorff"], 1e-3), 0.05)
        for c in centres:
            t = local_truth(sa, box_a, sb, box_b, c, radius)
            if len(t) == 0:
                continue
            if f_lines:
                local_f = max(local_f, float(seg_dist(t, f_lines).max()))
            if o_lines:
                local_o = max(local_o, float(seg_dist(t, o_lines).max()))
        row["local_truth_forge"] = local_f
        row["local_truth_occt"] = local_o
    local_tol = 5e-5
    forge_bad = (
        f_miss > 0
        or row.get("forge_err", 0.0) > ON_SURFACE
        or row["forge_dangling"] > 0
        or o_iso_lost > 0
        or local_f > local_tol
    )
    occt_bad = (
        o_miss > 0
        or row.get("occt_err", 0.0) > ON_SURFACE
        or row["occt_dangling"] > 0
        or f_iso_lost > 0
        or local_o > local_tol
    )
    if forge_bad and not occt_bad:
        row["verdict"] = "forge_wrong"
    elif occt_bad and not forge_bad:
        row["verdict"] = "occt_wrong"
    elif forge_bad and occt_bad:
        row["verdict"] = "both_wrong"
    else:
        # Both cover the truth and are on the surfaces: a topological reporting difference
        # (component splitting at tangency points, isolated point representation) or a
        # Hausdorff gap near a domain boundary / tangency.
        row["verdict"] = "equivalent_geometry"
    return row


def bench(path: str, limit: int | None) -> int:
    """Time ``GeomInt_IntSS`` (construction = the whole computation, including its
    B-spline approximation; without and with pcurve approximation on both surfaces)
    per pair family, best of 3 runs, and print it next to
    Forge's time from the batch file. OCCT intersects the untrimmed surfaces while Forge
    works on the parameter boxes, and the OCCT time includes a few µs of Python binding
    overhead: a rough comparison only."""
    import time

    occt = defaultdict(list)
    occt_pc = defaultdict(list)
    forge = defaultdict(list)
    with open(path) as f:
        json.loads(f.readline())
        for k, line in enumerate(f):
            if limit and k >= limit:
                break
            case = json.loads(line)
            sa, sb = Surf(case["a"]), Surf(case["b"])
            ga, gb = sa.occt(), sb.occt()
            for pc, out in ((False, occt), (True, occt_pc)):
                best = math.inf
                for _ in range(3):
                    t0 = time.perf_counter()
                    try:
                        GeomInt_IntSS(ga, gb, OCCT_TOL, True, pc, pc)
                    except Standard_Failure:
                        pass
                    best = min(best, time.perf_counter() - t0)
                out[case["family"]].append(best * 1e6)
            forge[case["family"]].append(case["forge"].get("time_us", math.nan))
    med = lambda xs: sorted(xs)[len(xs) // 2]
    print(f"{'family':<40} {'n':>4} {'forge µs':>10} {'occt µs':>10} {'occt+pc µs':>11}")
    for fam in sorted(occt):
        print(
            f"{fam:<40} {len(occt[fam]):>4} {med(forge[fam]):>10.0f} {med(occt[fam]):>10.0f}"
            f" {med(occt_pc[fam]):>11.0f}"
        )
    mean = lambda d: sum(x for v in d.values() for x in v) / sum(len(v) for v in d.values())
    print(
        f"{'all (mean)':<40} {sum(len(v) for v in occt.values()):>4} {mean(forge):>10.0f}"
        f" {mean(occt):>10.0f} {mean(occt_pc):>11.0f}"
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("batch")
    ap.add_argument("--out")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--bench", action="store_true", help="time OCCT vs Forge per family")
    args = ap.parse_args()
    if args.bench:
        return bench(args.batch, args.limit)
    rows = []
    with open(args.batch) as f:
        header = json.loads(f.readline())
        for k, line in enumerate(f):
            if args.limit and k >= args.limit:
                break
            rows.append(compare(json.loads(line)))
            if (k + 1) % 200 == 0:
                print(f"... {k + 1}/{header['count']}", file=sys.stderr)
    verdicts = Counter(r["verdict"] for r in rows)
    by_family = defaultdict(Counter)
    for r in rows:
        by_family[r["family"].split("/")[0]][r["verdict"]] += 1
    print(f"cases: {len(rows)}")
    for k, v in sorted(verdicts.items()):
        print(f"  {k:<22} {v:>6}  ({100.0 * v / len(rows):.2f}%)")
    print("per pair:")
    for fam in sorted(by_family):
        c = by_family[fam]
        print(f"  {fam:<22} " + ", ".join(f"{k}={v}" for k, v in sorted(c.items())))
    hs = [r["hausdorff"] for r in rows if r.get("verdict") == "agree"]
    if hs:
        hs.sort()
        print(
            "hausdorff (agreeing, mm): median %.2e  p99 %.2e  max %.2e"
            % (hs[len(hs) // 2], hs[int(0.99 * (len(hs) - 1))], hs[-1])
        )
    errs = [r["occt_err"] for r in rows if "occt_err" in r]
    ferrs = [r["forge_err"] for r in rows if "forge_err" in r]
    if errs:
        errs.sort()
        print("occt point error (mm): median %.2e max %.2e" % (errs[len(errs) // 2], errs[-1]))
    if ferrs:
        ferrs.sort()
        print("forge point error (mm): median %.2e max %.2e" % (ferrs[len(ferrs) // 2], ferrs[-1]))
    for r in rows:
        if r["verdict"] not in ("agree", "coincident"):
            print("  ", json.dumps({k: v for k, v in r.items()}))
    if args.out:
        with open(args.out, "w") as f:
            json.dump({"summary": dict(verdicts), "rows": rows}, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
