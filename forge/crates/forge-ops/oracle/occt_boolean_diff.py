#!/usr/bin/env python3
"""Differential oracle: forge-ops booleans (W4) vs OCCT ``BRepAlgoAPI`` on the corpus.

CI/dev tooling only (OCCT is LGPL; never a runtime dependency of Forge).

Usage (from the repository's ``oracle/`` directory, which has uv + OCP)::

    # from forge/: write Forge's side (operands as aicad.ir/0 documents + Forge's outcome)
    BOOLEAN_BATCH_OUT=/tmp/b17.jsonl BOOLEAN_SEED=17 BOOLEAN_COUNT=600 \\
      cargo test --release -p forge-ops --test boolean_oracle -- --ignored --nocapture
    # from oracle/:
    uv run python ../forge/crates/forge-ops/oracle/occt_boolean_diff.py /tmp/b17.jsonl \\
      --out /tmp/r17.json

For every case the script rebuilds both operands with the oracle's **own** v0 evaluator
(``aicad_oracle.evaluate``: independent sketch regions, ``BRepPrimAPI_MakePrism`` /
``MakeRevol``), runs ``BRepAlgoAPI_Fuse/Cut/Common`` with the SPEC §8.3 settings (no fuzzy
value, not parallel, non-destructive) followed by ``ShapeUpgrade_UnifySameDomain``
(linear 1e-6, angular 1e-9), maps the result to the SPEC §6.0.3 semantics
(``BOOLEAN_NO_INTERSECTION`` when the tool meets no interior / a join tool is detached,
``BOOLEAN_EMPTY_RESULT``, ``BOOLEAN_NON_MANIFOLD`` for results that touch themselves along an
edge or at a vertex) and compares with Forge:

* status and semantic code (exact);
* number of bodies; bodies matched by nearest centroid;
* per body: volume and area (relative 1e-6), validity, and faces, edges, ``face_types`` and
  ``edge_types`` (exact, SPEC §8.2) two ways:

  - **literal SPEC §8.3** (what W7b's gate compares): OCCT's result after rule 1 (the
    ``UnifySameDomain`` call), v0's normalizations (seam and degenerated edges not counted) and
    rule 3 (B-spline edges recognised as lines and conics within ``1e-7·s``);
  - **normalized** (this script's proposal for §8.3, review round 3): additionally, faces on
    one surface that share an edge are one face (USD does not re-merge periodic faces split
    along a seam, contrary to what rule 1 says), single-face internal edges at tangent
    contacts are dropped, a real edge between two faces is counted even when OCCT also marks
    it closed on one of them (v0's seam rule drops it), edges on one carrier curve or between
    the same two faces meeting smoothly at a vertex nothing else uses (no degenerate pole
    edge either) are one edge (of the type of its longest piece), and parabola / hyperbola
    edges are counted as ``bspline`` (Forge's exact rational representation).

  The **headline** is the literal SPEC §8.3 MATCH rate (review round 4): outcome codes
  equal, or body counts, volumes, areas, validity and the four count/type fields equal
  after literal §8.3, over all cases and over the geometric ones. Every literal non-MATCH
  is broken down by reason, and a count/type disagreement by the smallest set of the
  proposed normalizations (``STEPS``) that explains it (CONTRACT ISSUES 1). Row classes
  (and the adjudication below) use the normalized comparison.

Every disagreement is **adjudicated** independently of both booleans:

* volume and area disagreements are first re-integrated adaptively on OCCT's result
  (``VolumePropertiesGK`` and ``SurfaceProperties`` with a small ``eps``): a row is
  ``occt_metric_wrong`` only when **every** disagreeing metric (volume and/or area) agrees
  with Forge after that; an area disagreement the adaptive integral does not settle is
  ``undecided_area`` (never blamed on OCCT without evidence);
* volumes by a grid integral of the indicator of ``A op B`` with OCCT's point classifier on
  the two *operands* (``BRepClass3d_SolidClassifier``; ~1e-3 relative), which decides gross
  volume disagreements;
* OCCT results that fail ``BRepCheck_Analyzer`` are OCCT-wrong;
* count-only disagreements (same volumes/areas, different face or edge counts) are reported
  with both engines' face and edge types for inspection (unify / seam conventions);
* semantic disagreements (non-manifold, no intersection) are adjudicated in both directions:
  Forge's ``BOOLEAN_NON_MANIFOLD`` against a solid from OCCT by the true result's local
  topology at Forge's probe; OCCT's non-manifold result against a body from Forge by the local
  topology at OCCT's touching edge or vertex; OCCT's empty / no-intersection outcome against a
  body from Forge by the grid volume. A code mismatch with a Forge body that cannot be decided
  is counted as a **potential silent wrong** in the summary.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict

from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.GeomAbs import (
    GeomAbs_Circle,
    GeomAbs_Cone,
    GeomAbs_Cylinder,
    GeomAbs_Ellipse,
    GeomAbs_Hyperbola,
    GeomAbs_Line,
    GeomAbs_Parabola,
    GeomAbs_Plane,
    GeomAbs_Sphere,
    GeomAbs_Torus,
)
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.BRep import BRep_Tool
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.gp import gp_Pnt, gp_Vec
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_IN, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.TopTools import (
    TopTools_IndexedDataMapOfShapeListOfShape,
    TopTools_IndexedMapOfShape,
    TopTools_ListOfShape,
)

from aicad_oracle import occt as O
from aicad_oracle.evaluate import evaluate_data

REL_VOL = 1e-6
REL_AREA = 1e-6
EMPTY_REL = 1e-9  # common volume below this (relative) counts as empty
GRID = 64         # grid cells per axis for the adjudication integral


def build(doc: dict):
    shapes: list = []
    rep = evaluate_data(doc, "operand", shapes=shapes)
    if rep.get("status") != "ok" or len(shapes) != 1:
        raise RuntimeError(f"operand build failed: {rep.get('features')}")
    return shapes[0][2]


def run_op(a, b, op: str):
    args = TopTools_ListOfShape()
    args.Append(a)
    tools = TopTools_ListOfShape()
    tools.Append(b)
    algo = {"join": BRepAlgoAPI_Fuse, "cut": BRepAlgoAPI_Cut, "intersect": BRepAlgoAPI_Common}[op]()
    algo.SetArguments(args)
    algo.SetTools(tools)
    algo.SetRunParallel(False)
    algo.SetNonDestructive(True)
    algo.Build()
    if not algo.IsDone():
        raise RuntimeError("OCCT boolean failed")
    shape = algo.Shape()
    usd = ShapeUpgrade_UnifySameDomain(shape, True, True, False)
    usd.SetLinearTolerance(1e-6)
    usd.SetAngularTolerance(1e-9)
    usd.Build()
    return usd.Shape()


def solids_of(shape):
    out = []
    ex = TopExp_Explorer(shape, TopAbs_SOLID)
    while ex.More():
        out.append(TopoDS.Solid_s(ex.Current()))
        ex.Next()
    return out


def volume(shape) -> float:
    return O.volume_props(shape).Mass()


def non_manifold(solids):
    """Where the result touches itself: the middle of an edge used by more than two faces, or
    a vertex position two solids share; None if nowhere."""
    for s in solids:
        anc = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(s, TopAbs_EDGE, TopAbs_FACE, anc)
        for i in range(1, anc.Extent() + 1):
            e = TopoDS.Edge_s(anc.FindKey(i))
            if BRep_Tool.Degenerated_s(e):
                continue
            faces = TopTools_IndexedMapOfShape()
            for f in anc.FindFromIndex(i):
                faces.Add(f)
            if faces.Extent() > 2:
                c = BRepAdaptor_Curve(e)
                q = c.Value(0.5 * (c.FirstParameter() + c.LastParameter()))
                return [q.X(), q.Y(), q.Z()]
    pts = []
    for k, s in enumerate(solids):
        vm = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(s, TopAbs_VERTEX, vm)
        for i in range(1, vm.Extent() + 1):
            p = BRep_Tool.Pnt_s(TopoDS.Vertex_s(vm.FindKey(i)))
            pts.append((k, p.X(), p.Y(), p.Z()))
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            if pts[i][0] != pts[j][0] and math.dist(pts[i][1:], pts[j][1:]) <= 1e-6:
                return list(pts[i][1:])
    return None


def gk_volume(shape) -> float:
    """Adaptive Gauss–Kronrod volume (slow; for adjudication only)."""
    p = GProp_GProps()
    BRepGProp.VolumePropertiesGK_s(shape, p, 1e-10)
    return p.Mass()


def adaptive_area(shape) -> float:
    """Adaptive surface integral (``SurfaceProperties`` with ``eps``; adjudication only)."""
    p = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, p, 1e-12)
    return p.Mass()


def _carrier_key(e):
    """A key equal for edges on one geometric line / circle / ellipse; None otherwise."""
    c = BRepAdaptor_Curve(e)
    t = c.GetType()
    r = lambda x: round(x, 6)  # noqa: E731
    if t == GeomAbs_Line:
        l = c.Line()
        d = l.Direction()
        dv = (d.X(), d.Y(), d.Z())
        if max(dv, key=abs) < 0:
            dv = tuple(-x for x in dv)
        p = l.Location()
        pv = (p.X(), p.Y(), p.Z())
        s = sum(pv[i] * dv[i] for i in range(3))
        foot = tuple(pv[i] - s * dv[i] for i in range(3))
        return ("line",) + tuple(map(r, dv + foot))
    if t in (GeomAbs_Circle, GeomAbs_Ellipse):
        g = c.Circle() if t == GeomAbs_Circle else c.Ellipse()
        ax = g.Axis().Direction()
        av = (ax.X(), ax.Y(), ax.Z())
        if max(av, key=abs) < 0:
            av = tuple(-x for x in av)
        o = g.Location()
        rad = (g.Radius(),) if t == GeomAbs_Circle else (g.MajorRadius(), g.MinorRadius())
        return (int(t),) + tuple(map(r, (o.X(), o.Y(), o.Z()) + av + rad))
    return None


def _surface_key(f):
    """A key equal for faces on one geometric plane / cylinder / cone / sphere / torus."""
    s = BRepAdaptor_Surface(f, False)
    t = s.GetType()
    r = lambda x: round(x, 6)  # noqa: E731

    def axis(ax):
        d = ax.Direction()
        dv = (d.X(), d.Y(), d.Z())
        if max(dv, key=abs) < 0:
            dv = tuple(-x for x in dv)
        return dv, ax.Location()

    if t == GeomAbs_Plane:
        dv, p = axis(s.Plane().Axis())
        return ("plane",) + tuple(map(r, dv + (p.X() * dv[0] + p.Y() * dv[1] + p.Z() * dv[2],)))
    if t in (GeomAbs_Cylinder, GeomAbs_Cone):
        g = s.Cylinder() if t == GeomAbs_Cylinder else s.Cone()
        dv, p = axis(g.Axis())
        pv = (p.X(), p.Y(), p.Z())
        if t == GeomAbs_Cylinder:
            k = sum(pv[i] * dv[i] for i in range(3))
            foot = tuple(pv[i] - k * dv[i] for i in range(3))
            return ("cyl",) + tuple(map(r, dv + foot + (g.Radius(),)))
        a = g.Apex()
        return ("cone",) + tuple(map(r, dv + (a.X(), a.Y(), a.Z(), abs(g.SemiAngle()))))
    if t == GeomAbs_Sphere:
        g = s.Sphere()
        c = g.Location()
        return ("sphere",) + tuple(map(r, (c.X(), c.Y(), c.Z(), g.Radius())))
    if t == GeomAbs_Torus:
        g = s.Torus()
        dv, c = axis(g.Axis())
        return ("torus",) + tuple(map(r, dv + (c.X(), c.Y(), c.Z(), g.MajorRadius(), g.MinorRadius())))
    return None


#: The normalizations this script proposes for SPEC §8.3 (CONTRACT ISSUES 1), in the order
#: the categorization tries them. Each can be switched on alone:
#:
#: * ``seam_faces``: faces on one surface that share an edge are one face (§8.3 rule 1 says
#:   UnifySameDomain "also re-merges periodic faces that OCCT split along seams"; with OCP
#:   7.9.3 it does not, so an oracle implementing rule 1 as written must add this step);
#: * ``internal_edges``: an edge with the same face on both sides (OCCT keeps one at a
#:   tangent contact inside a face) is not counted;
#: * ``seam_real_edges``: an edge between two distinct faces is counted even when OCCT also
#:   marks it closed on one of them (it lies on that face's parametric seam; v0's seam rule
#:   drops it);
#: * ``merge_edges``: edges on one carrier curve, or between the same two faces meeting
#:   smoothly, at a vertex nothing else uses (no degenerate pole edge either) are one edge
#:   (§6.0.4; rule 1's ``ConcatBSplines = false`` leaves pieces of one B-spline section, and
#:   OCCT splits section curves at the seams of periodic faces);
#: * ``conic_bspline``: parabola and hyperbola edges are counted as ``bspline`` (Forge's
#:   exact rational representation; the canonical types have no parabola or hyperbola).
STEPS = ("seam_faces", "internal_edges", "seam_real_edges", "merge_edges", "conic_bspline")


def normalized_counts(solid, freeform_tol: float = 1e-7, steps=STEPS):
    """(faces, edges, face_types, edge_types) of an OCCT solid after v0's normalizations
    (seam and degenerated edges not counted, canonical types, §8.3 rule 3 recognition within
    `freeform_tol`) and the proposed normalization `steps` (see `STEPS`). With no steps
    this reproduces the literal §8.3 counts of `aicad_oracle.occt.body_metrics`. A merged
    face has the type of its first member, a merged edge the type of its longest piece."""
    steps = set(steps)
    emap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(solid, TopAbs_EDGE, emap)
    anc = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(solid, TopAbs_EDGE, TopAbs_FACE, anc)
    fmap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(solid, TopAbs_FACE, fmap)
    fkeys = [None] + [_surface_key(TopoDS.Face_s(fmap.FindKey(i))) for i in range(1, fmap.Extent() + 1)]
    fparent = list(range(fmap.Extent() + 1))

    def ffind(x):
        while fparent[x] != x:
            fparent[x] = fparent[fparent[x]]
            x = fparent[x]
        return x

    counted = []
    # Vertices of degenerated edges (sphere poles, cone apexes): the edges meeting there are
    # not merged (SPEC §6.0.4 at a singular point: the vertex is shared with the degenerate
    # pole edge, and Forge keeps it too).
    singular_vertices = set()
    for i in range(1, emap.Extent() + 1):
        e = TopoDS.Edge_s(emap.FindKey(i))
        if BRep_Tool.Degenerated_s(e):
            ex = TopExp_Explorer(e, TopAbs_VERTEX)
            while ex.More():
                p = BRep_Tool.Pnt_s(TopoDS.Vertex_s(ex.Current()))
                singular_vertices.add((round(p.X(), 5), round(p.Y(), 5), round(p.Z(), 5)))
                ex.Next()
            continue
        seam = False
        if anc.Contains(e):
            faces = TopTools_IndexedMapOfShape()
            for f in anc.FindFromKey(e):
                faces.Add(f)
            closed = any(BRep_Tool.IsClosed_s(e, TopoDS.Face_s(f)) for f in anc.FindFromKey(e))
            if faces.Extent() == 1:
                # A seam (closed on its face), or an internal edge OCCT keeps inside one
                # face at a tangent contact (both sides the same face): no face boundary.
                seam = closed or "internal_edges" in steps
            elif faces.Extent() == 2:
                i0, i1 = fmap.FindIndex(faces.FindKey(1)), fmap.FindIndex(faces.FindKey(2))
                if "seam_faces" in steps and fkeys[i0] is not None and fkeys[i0] == fkeys[i1]:
                    # Two faces of one surface: an unmerged same-domain split.
                    fparent[ffind(i0)] = ffind(i1)
                    seam = True
                elif closed:
                    # A real edge between two faces that OCCT also marks closed on one of them
                    # (v0's seam rule drops it).
                    seam = "seam_real_edges" not in steps
            else:
                seam = closed
        if not seam:
            counted.append(e)
    parent = list(range(len(counted)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    if "merge_edges" in steps:
        keys = [_carrier_key(e) for e in counted]
        # Faces on either side (merged-face identity), for pieces of one intersection curve.
        sides = []
        for e in counted:
            fs = set()
            if anc.Contains(e):
                for f in anc.FindFromKey(e):
                    fs.add(ffind(fmap.FindIndex(f)))
            sides.append(frozenset(fs))
        # Vertices by position.
        ends = []
        for k, e in enumerate(counted):
            vs = []
            ex = TopExp_Explorer(e, TopAbs_VERTEX)
            while ex.More():
                p = BRep_Tool.Pnt_s(TopoDS.Vertex_s(ex.Current()))
                vs.append((round(p.X(), 5), round(p.Y(), 5), round(p.Z(), 5)))
                ex.Next()
            ends.append(set(vs))
        at = defaultdict(list)
        for k, vs in enumerate(ends):
            for v in vs:
                at[v].append(k)

        def tangent_at(e, v):
            # Unit tangent of edge `e` at its end nearest the vertex position `v`.
            c = BRepAdaptor_Curve(e)
            best = None
            for t in (c.FirstParameter(), c.LastParameter()):
                p = c.Value(t)
                d = math.dist((p.X(), p.Y(), p.Z()), v)
                if best is None or d < best[0]:
                    best = (d, t)
            pnt, vec = gp_Pnt(), gp_Vec()
            c.D1(best[1], pnt, vec)
            n = vec.Magnitude()
            return (vec.X() / n, vec.Y() / n, vec.Z() / n) if n > 0 else None

        for v, ks in at.items():
            if len(ks) != 2 or v in singular_vertices:
                continue
            same_carrier = keys[ks[0]] is not None and keys[ks[0]] == keys[ks[1]]
            # Two edges between the same two faces meeting smoothly at a vertex nothing else
            # uses are pieces of one intersection curve (OCCT splits them at seams of
            # periodic faces); distinct lines or arcs meeting at a corner are not.
            same_faces = False
            if len(sides[ks[0]]) == 2 and sides[ks[0]] == sides[ks[1]]:
                t0, t1 = tangent_at(counted[ks[0]], v), tangent_at(counted[ks[1]], v)
                if t0 is not None and t1 is not None:
                    same_faces = abs(sum(a * b for a, b in zip(t0, t1))) >= 0.999
            if same_carrier or same_faces:
                a, b = find(ks[0]), find(ks[1])
                if a != b:
                    parent[a] = b
    face_groups = {}
    for i in range(1, fmap.Extent() + 1):
        face_groups.setdefault(ffind(i), i)

    # A merged edge has the type of its longest member (OCCT may represent a short piece of
    # a B-spline intersection curve as a circle arc).
    def length(e):
        p = GProp_GProps()
        BRepGProp.LinearProperties_s(e, p)
        return p.Mass()

    edge_groups = {}
    for k in range(len(counted)):
        r = find(k)
        if r not in edge_groups or length(counted[k]) > length(counted[edge_groups[r]]):
            edge_groups[r] = k
    ftypes = Counter(O.face_type(TopoDS.Face_s(fmap.FindKey(i))) for i in face_groups.values())

    def etype(e):
        t = BRepAdaptor_Curve(e).GetType()
        if "conic_bspline" in steps and t in (GeomAbs_Parabola, GeomAbs_Hyperbola):
            return "bspline"
        return O.edge_type(e, freeform_tol)

    etypes = Counter(etype(counted[k]) for k in edge_groups.values())
    return len(face_groups), len(edge_groups), dict(ftypes), dict(etypes)


def literal_category(x: dict, solid, freeform_tol: float) -> str:
    """The smallest set of proposed normalization `STEPS` (fewest steps, then `STEPS`
    order) under which OCCT's counts and types equal Forge's body `x`; "unexplained" when
    none does."""
    import itertools

    want = (x["faces"], x["edges"], x.get("face_types"), x.get("edge_types"))
    for n in range(1, len(STEPS) + 1):
        for combo in itertools.combinations(STEPS, n):
            if normalized_counts(solid, freeform_tol, combo) == want:
                return "+".join(combo)
    return "unexplained"


def occt_outcome(a, b, op: str) -> dict:
    va, vb = volume(a), volume(b)
    common = run_op(a, b, "intersect")
    vi = sum(volume(s) for s in solids_of(common))
    empty = vi <= EMPTY_REL * (va + vb)
    if op == "intersect" and empty:
        return {"status": "error", "code": "BOOLEAN_EMPTY_RESULT", "vi": vi}
    if op == "cut" and empty:
        return {"status": "error", "code": "BOOLEAN_NO_INTERSECTION", "vi": vi}
    res = run_op(a, b, op)
    solids = solids_of(res)
    if op == "join" and empty:
        # SPEC §6.0.3: a join tool must overlap a target or share a face of positive area
        # with it. Sharing a face removes twice its area from the union's boundary; a union
        # touching only along an edge or at a point keeps all of it (OCCT may still return
        # it as one, non-manifold, solid).
        area = lambda x: O.surface_props(x).Mass()  # noqa: E731
        aa, ab = area(a), area(b)
        shared = len(solids) == 1 and area(solids[0]) < (aa + ab) * (1.0 - 1e-7)
        if not shared:
            return {"status": "error", "code": "BOOLEAN_NO_INTERSECTION", "vi": vi}
    touch = non_manifold(solids)
    if touch is not None:
        return {"status": "error", "code": "BOOLEAN_NON_MANIFOLD", "vi": vi, "probe": touch}
    bodies = []
    for i, s in enumerate(solids):
        # Literal SPEC §8.3: v0 normalizations plus rule 3 (conic recognition within 1e-7·s).
        m = O.body_metrics(s, edge_recognition_rel=1e-7)
        diag = math.dist(m["bbox_min"], m["bbox_max"])
        m["_index"] = i
        m["_freeform_tol"] = 1e-7 * max(1.0, diag)
        (
            m["faces_normalized"],
            m["edges_normalized"],
            m["face_types_normalized"],
            m["edge_types_normalized"],
        ) = normalized_counts(s, 1e-7 * max(1.0, diag))
        bodies.append(m)
    return {"status": "ok", "bodies": bodies, "vi": vi, "_solids": solids}


def grid_volume(a, b, op: str) -> float:
    """Indicator integral of `a op b` from the operands' point classifiers."""
    box = Bnd_Box()
    BRepBndLib.Add_s(a, box)
    BRepBndLib.Add_s(b, box)
    x0, y0, z0, x1, y1, z1 = box.Get()
    ca = BRepClass3d_SolidClassifier(a)
    cb = BRepClass3d_SolidClassifier(b)
    hx, hy, hz = (x1 - x0) / GRID, (y1 - y0) / GRID, (z1 - z0) / GRID
    n = 0
    for i in range(GRID):
        for j in range(GRID):
            for k in range(GRID):
                p = gp_Pnt(x0 + (i + 0.5) * hx, y0 + (j + 0.5) * hy, z0 + (k + 0.5) * hz)
                ca.Perform(p, 1e-7)
                cb.Perform(p, 1e-7)
                ia = ca.State() == TopAbs_IN
                ib = cb.State() == TopAbs_IN
                if (op == "join" and (ia or ib)) or (op == "cut" and ia and not ib) or (
                    op == "intersect" and ia and ib
                ):
                    n += 1
    return n * hx * hy * hz


def local_topology(a, b, op: str, p, rho: float, n: int = 20000) -> tuple[int, int]:
    """Connected components of the result's inside and outside on a small sphere around
    `p` (radius `rho`), from the operands' point classifiers: a boundary point is manifold
    iff both are single discs; two or more inside (or outside) components mean the result
    touches itself there (SPEC §6.0.3 non-manifold)."""
    import numpy as np
    from scipy.spatial import cKDTree

    k = np.arange(n) + 0.5
    phi = np.arccos(1.0 - 2.0 * k / n)
    theta = np.pi * (1.0 + 5.0**0.5) * k
    dirs = np.stack([np.cos(theta) * np.sin(phi), np.sin(theta) * np.sin(phi), np.cos(phi)], axis=1)
    pts = np.asarray(p)[None, :] + rho * dirs
    ca = BRepClass3d_SolidClassifier(a)
    cb = BRepClass3d_SolidClassifier(b)
    inside = np.zeros(n, dtype=bool)
    for i, q in enumerate(pts):
        g = gp_Pnt(*map(float, q))
        ca.Perform(g, 1e-9)
        cb.Perform(g, 1e-9)
        ia, ib = ca.State() == TopAbs_IN, cb.State() == TopAbs_IN
        inside[i] = (op == "join" and (ia or ib)) or (op == "cut" and ia and not ib) or (
            op == "intersect" and ia and ib
        )
    tree = cKDTree(dirs)
    spacing = (4.0 * np.pi / n) ** 0.5
    pairs = tree.query_pairs(2.0 * spacing)

    def components(mask):
        parent = list(range(n))

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for i, j in pairs:
            if mask[i] and mask[j]:
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[ri] = rj
        return len({find(i) for i in range(n) if mask[i]})

    return components(inside), components(~inside)


def rel(a: float, b: float) -> float:
    return abs(a - b) / max(1e-12, abs(a), abs(b))


def compare(case: dict) -> dict:
    fg = case["forge"]
    a, b = build(case["a"]), build(case["b"])
    try:
        oc = occt_outcome(a, b, case["op"])
    except Exception as e:  # noqa: BLE001 - OCCT failures are data here
        oc = {"status": "error", "code": "OCCT_FAILED", "message": str(e)}
    row = {"id": case["id"], "family": case["family"], "op": case["op"], "forge": fg, "occt": oc}
    fcode = fg.get("code") if fg["status"] == "error" else None
    ocode = oc.get("code") if oc["status"] == "error" else None
    if fcode and fcode.startswith("FORGE_"):
        row["class"] = "forge_error" if ocode is None else "both_error"
        return row
    if ocode == "OCCT_FAILED":
        row["class"] = "occt_error"
        return row
    if fcode or ocode:
        row["class"] = "agree" if fcode == ocode else "code_mismatch"
        if row["class"] == "code_mismatch":
            row["evidence"] = {"common_volume": oc.get("vi")}
            # Forge reports a non-manifold result that OCCT returned as a solid: probe the
            # true result's local topology at Forge's probe point.
            import re

            m = re.search(r"near \(([^)]*)\)", fg.get("message", ""))
            if fcode == "BOOLEAN_NON_MANIFOLD" and ocode is None and m:
                probe = [float(x) for x in m.group(1).split(",")]
                comps = [local_topology(a, b, case["op"], probe, r) for r in (0.05, 0.02)]
                row["evidence"]["local_components"] = comps
                if all(i >= 2 or o >= 2 for i, o in comps):
                    row["class"] = "occt_wrong"
                elif all(i <= 1 and o <= 1 for i, o in comps):
                    row["class"] = "forge_wrong"
            elif fcode is None and ocode == "BOOLEAN_NON_MANIFOLD" and oc.get("probe"):
                # The reverse: Forge returned a body where OCCT's result touches itself.
                comps = [local_topology(a, b, case["op"], oc["probe"], r) for r in (0.05, 0.02)]
                row["evidence"]["local_components"] = comps
                if all(i >= 2 or o >= 2 for i, o in comps):
                    row["class"] = "forge_wrong"
                elif all(i <= 1 and o <= 1 for i, o in comps):
                    row["class"] = "occt_wrong"
            elif fcode is None and ocode in ("BOOLEAN_EMPTY_RESULT", "BOOLEAN_NO_INTERSECTION"):
                # Forge returned a body where OCCT found nothing in common: the grid volume
                # of the true result decides.
                truth = grid_volume(a, b, case["op"])
                fv = sum(x["volume"] for x in fg["bodies"])
                row["truth_volume"] = truth
                if case["op"] != "join" and rel(fv, truth) < 0.02 and truth > 0:
                    row["class"] = "occt_wrong"
                elif case["op"] != "join" and truth == 0:
                    row["class"] = "forge_wrong"
            if row["class"] == "code_mismatch" and fcode is None:
                # Undecided, and Forge returned a body: counted as a potential silent wrong.
                row["potential_silent_wrong"] = True
        return row
    fb, ob = fg["bodies"], oc["bodies"]
    problems = []
    if len(fb) != len(ob):
        problems.append(f"bodies {len(fb)} vs {len(ob)}")
    # Match by nearest centroid.
    used = set()
    pairs = []
    for x in fb:
        best = None
        for j, y in enumerate(ob):
            if j in used:
                continue
            d = math.dist(x.get("centroid", [0, 0, 0]), y["centroid"])
            if best is None or d < best[0]:
                best = (d, j)
        if best is not None:
            used.add(best[1])
            pairs.append((x, ob[best[1]]))
    vol_bad = count_bad = False
    vol_mismatch = area_mismatch = False
    literal = []  # literal SPEC §8.3 disagreements (counts and types)
    categories = []  # the proposed normalizations that explain each of them
    for x, y in pairs:
        diff = [k for k in ("faces", "edges", "face_types", "edge_types") if x.get(k) != y.get(k)]
        for key in diff:
            literal.append(f"{key} {x.get(key)} vs {y.get(key)}")
        if diff:
            categories.append(literal_category(x, oc["_solids"][y["_index"]], y["_freeform_tol"]))
        if not x.get("valid", False):
            problems.append("forge body invalid")
        if not y["valid"]:
            problems.append("occt body invalid")
        if rel(x["volume"], y["volume"]) > REL_VOL:
            vol_bad = vol_mismatch = True
            problems.append(f"volume {x['volume']:.9g} vs {y['volume']:.9g}")
        if rel(x["area"], y["area"]) > REL_AREA:
            vol_bad = area_mismatch = True
            problems.append(f"area {x['area']:.9g} vs {y['area']:.9g}")
        if (
            x["faces"] != y["faces_normalized"]
            or x["edges"] != y["edges_normalized"]
            or x.get("face_types") != y["face_types_normalized"]
            or x.get("edge_types") != y["edge_types_normalized"]
        ):
            count_bad = True
            problems.append(
                f"faces/edges {x['faces']}/{x['edges']} vs {y['faces_normalized']}/"
                f"{y['edges_normalized']} (literal §8.3 {y['faces']}/{y['edges']}) "
                f"(forge {x.get('face_types')} {x.get('edge_types')}, occt normalized "
                f"{y['face_types_normalized']} {y['edge_types_normalized']}, literal "
                f"{y['face_types']} {y['edge_types']})"
            )
    if len(fb) != len(ob):
        literal.append("body count")
    row["literal_agree"] = not literal and not any(
        p.startswith(("volume", "area", "forge body", "occt body", "bodies")) for p in problems
    )
    if literal:
        row["literal_problems"] = literal
    if categories:
        row["literal_category"] = "; ".join(sorted(set(categories)))
    if not problems:
        row["class"] = "agree"
        return row
    row["problems"] = problems
    fv = sum(x["volume"] for x in fb)
    ov = sum(y["volume"] for y in ob)
    if vol_bad and len(fb) == len(ob):
        # OCCT's fixed-order integration is inexact on faces trimmed by approximated
        # curves: re-integrate adaptively before judging the geometry. Every metric that
        # disagreed must agree with Forge afterwards; otherwise nothing is blamed on OCCT.
        settled = True
        if vol_mismatch:
            gk = [gk_volume(s) for s in oc["_solids"]]
            row["occt_gk_volume"] = sum(gk)
            settled &= rel(fv, sum(gk)) <= REL_VOL
        if area_mismatch:
            fa = sum(x["area"] for x in fb)
            aa = [adaptive_area(s) for s in oc["_solids"]]
            row["occt_adaptive_area"] = sum(aa)
            area_settled = rel(fa, sum(aa)) <= REL_AREA
            row["area_settled"] = area_settled
            settled &= area_settled
            if not area_settled and not vol_mismatch:
                # Volumes agree, the area does not, and the adaptive integral sides with
                # neither or with OCCT: a possible Forge area error, reported as such.
                row["class"] = "undecided_area"
                return row
        if settled:
            # Same geometry; OCCT's own volume/area integral was the inexact one.
            row["occt_metric_inexact"] = True
            vol_bad = False
            if not count_bad:
                row["class"] = "occt_metric_wrong"
                return row
    if vol_bad or len(fb) != len(ob):
        truth = grid_volume(a, b, case["op"])
        row["truth_volume"] = truth
        ef, eo = rel(fv, truth), rel(ov, truth)
        # The grid integral is good to ~1e-2 relative on these sizes.
        if ef < 0.02 and eo >= 0.02:
            row["class"] = "occt_wrong"
        elif eo < 0.02 and ef >= 0.02:
            row["class"] = "forge_wrong"
        elif ef >= 0.02 and eo >= 0.02:
            row["class"] = "both_wrong"
        else:
            row["class"] = "undecided_volume"
    elif any(not y["valid"] for _, y in pairs):
        row["class"] = "occt_wrong"
    elif any(not x.get("valid", False) for x, _ in pairs):
        row["class"] = "forge_wrong"
    else:
        row["class"] = "count_mismatch"
    return row


def dump(case: dict) -> None:
    """Print OCCT's result edges (type, end points, faces) for one case."""
    a, b = build(case["a"]), build(case["b"])
    res = run_op(a, b, case["op"])
    for s in solids_of(res):
        emap = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(s, TopAbs_EDGE, emap)
        anc = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(s, TopAbs_EDGE, TopAbs_FACE, anc)
        fmap = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(s, TopAbs_FACE, fmap)
        print(f"solid: {fmap.Extent()} faces, {emap.Extent()} edges (raw); normalized {normalized_counts(s)}")
        for i in range(1, emap.Extent() + 1):
            e = TopoDS.Edge_s(emap.FindKey(i))
            vs = []
            ex = TopExp_Explorer(e, TopAbs_VERTEX)
            while ex.More():
                p = BRep_Tool.Pnt_s(TopoDS.Vertex_s(ex.Current()))
                vs.append((round(p.X(), 4), round(p.Y(), 4), round(p.Z(), 4)))
                ex.Next()
            fs = [fmap.FindIndex(f) for f in anc.FindFromKey(e)] if anc.Contains(e) else []
            seam = any(BRep_Tool.IsClosed_s(e, TopoDS.Face_s(f)) for f in anc.FindFromKey(e)) if anc.Contains(e) else False
            print(f"  {O.edge_type(e):8s} deg {BRep_Tool.Degenerated_s(e)} seam {seam} faces {fs} {vs}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("batch")
    ap.add_argument("--out")
    ap.add_argument("--ids", help="comma-separated case ids to run")
    ap.add_argument("--dump", type=int, help="print OCCT's result edges for one case id")
    args = ap.parse_args()
    cases = [json.loads(l) for l in open(args.batch)]
    if args.dump is not None:
        dump(next(c for c in cases if c["id"] == args.dump))
        return 0
    if args.ids:
        keep = {int(x) for x in args.ids.split(",")}
        cases = [c for c in cases if c["id"] in keep]
    rows = []
    for c in cases:
        try:
            rows.append(compare(c))
        except Exception as e:  # noqa: BLE001
            rows.append({"id": c["id"], "family": c["family"], "op": c["op"], "class": "script_error", "message": str(e)})
    cls = Counter(r["class"] for r in rows)
    by_family = defaultdict(Counter)
    for r in rows:
        by_family[r["family"]][r["class"]] += 1
    n = len(rows)
    # Geometric cases: both engines returned bodies (not a semantic outcome such as
    # BOOLEAN_NO_INTERSECTION / BOOLEAN_EMPTY_RESULT / BOOLEAN_NON_MANIFOLD on either side).
    geo = [r for r in rows if r.get("forge", {}).get("status") == "ok" and r.get("occt", {}).get("status") == "ok"]
    sem = [r for r in rows if r not in geo]

    def literal_match(r) -> bool:
        # SPEC §8.2 with literal §8.3: equal outcome codes, or equal body counts, volumes,
        # areas and validity and equal faces, edges, face_types and edge_types.
        if r in geo:
            return bool(r.get("literal_agree"))
        fg, oc = r.get("forge", {}), r.get("occt", {})
        return fg.get("status") == "error" and oc.get("status") == "error" and fg.get("code") == oc.get("code")

    lit = [r for r in rows if literal_match(r)]
    g_lit = [r for r in geo if literal_match(r)]
    psw = sum(bool(r.get("potential_silent_wrong")) for r in rows)
    print(
        f"HEADLINE literal SPEC §8.3 MATCH: {len(lit)}/{n} ({len(lit) / max(1, n):.2%}) of all cases; "
        f"geometric cases {len(g_lit)}/{len(geo)} ({len(g_lit) / max(1, len(geo)):.2%}); "
        f"semantic or error cases {sum(literal_match(r) for r in sem)}/{len(sem)}"
    )
    print(f"potential silent wrong (undecided code mismatch with a Forge body): {psw}")
    # Why the others are not literal matches.
    why = Counter()
    for r in rows:
        if literal_match(r):
            continue
        if r not in geo:
            why[f"outcome: {r['class']}"] += 1
            continue
        probs = r.get("problems", [])
        if any(p.startswith("bodies") for p in probs) or "body count" in r.get("literal_problems", []):
            why[f"body count: {r['class']}"] += 1
        elif any(p.startswith(("volume", "area")) for p in probs):
            why[f"volume/area: {r['class']}"] += 1
        elif any(p.startswith(("forge body", "occt body")) for p in probs):
            why[f"validity: {r['class']}"] += 1
        elif r.get("literal_category"):
            why[f"counts/types, explained by {r['literal_category']}"] += 1
        else:
            why[f"other: {r['class']}"] += 1
    print("literal non-MATCH by reason:")
    for k, v in why.most_common():
        print(f"  {v:5d}  {k}")
    agree = cls["agree"]
    print(f"cases {n}: " + ", ".join(f"{k} {v}" for k, v in sorted(cls.items())))
    print(f"normalized agreement (this script's proposal for §8.3) {agree / max(1, n):.2%}")
    g_agree = sum(r["class"] == "agree" for r in geo)
    g_ok = sum(r["class"] in ("agree", "occt_metric_wrong", "occt_wrong") for r in geo)
    print(
        f"geometric cases (both returned bodies) {len(geo)}: normalized agreement {g_agree / max(1, len(geo)):.2%}, "
        f"Forge correct after adjudication {g_ok / max(1, len(geo)):.2%}; semantic or error cases {len(sem)}"
    )
    for fam, c in sorted(by_family.items()):
        print(f"  {fam:10s} " + ", ".join(f"{k} {v}" for k, v in sorted(c.items())))
    for r in rows:
        if r["class"] != "agree":
            fg, oc = r.get("forge", {}), r.get("occt", {})
            print(
                f"#{r['id']} {r['family']} {r['op']}: {r['class']}: "
                f"forge {fg.get('status')} {fg.get('code', '')} | occt {oc.get('status')} {oc.get('code', '')} "
                f"{r.get('problems', '')} truth {r.get('truth_volume', '')} {r.get('message', '')}"[:600]
            )
    for r in rows:
        r.get("occt", {}).pop("_solids", None)
        for b in r.get("occt", {}).get("bodies", []):
            b.pop("_index", None)
            b.pop("_freeform_tol", None)
    if args.out:
        with open(args.out, "w") as f:
            json.dump({"summary": dict(cls), "rows": rows}, f, indent=1, default=str)
    return 0


if __name__ == "__main__":
    sys.exit(main())
