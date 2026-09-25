#!/usr/bin/env python3
"""Differential oracle: forge-blend (IR v1 W6) fillet / chamfer / shell vs OCCT.

CI/dev tooling only (OCCT is LGPL; never a runtime dependency of Forge).

Usage (the Forge side from ``forge/``, the OCCT side from the repository's ``oracle/``
directory, which has uv + OCP)::

    BLEND_BATCH_OUT=/tmp/blend17.jsonl BLEND_SEED=17 BLEND_COUNT=400 BLEND_CURVED=60 \\
      BLEND_SEQ=100 BLEND_ADV=120 \\
      cargo test --release -p forge-blend --test oracle_batch write_blend_oracle_batch -- --ignored --nocapture
    uv run python ../forge/crates/forge-blend/oracle/occt_blend_diff.py /tmp/blend17.jsonl \\
      --reference-all --out /tmp/blend17-report.json [--baseline previous-report.json] \\
      [--expect ../forge/crates/forge-blend/oracle/expected-summary.json --seed 17]

For every case the script

* rebuilds the base independently: each operand (an ``aicad.ir/0`` document) with the
  oracle's own v0 evaluator (``aicad_oracle.evaluate``), combined with
  ``BRepAlgoAPI_Fuse`` / ``BRepAlgoAPI_Cut`` (SPEC §8.3 rule 2 settings) and
  ``ShapeUpgrade_UnifySameDomain`` (rule 1), and checks that the base's metrics equal
  Forge's (``BASE_MISMATCH`` otherwise: the comparison of that case is void);
* finds the OCCT edges (faces) at Forge's probes — the point at an edge's middle parameter,
  an interior point of a face — within ``1e-6·s``; a probe that matches no entity, or more
  than one, is ``PROBE_UNMATCHED`` (faces and edges alike);
* runs ``BRepFilletAPI_MakeFillet`` (``Add(r, E)`` per edge), ``BRepFilletAPI_MakeChamfer``
  (``Add(d, E)``, ``Add(d, d2, E, F)`` with ``F`` the side face, ``AddDA(d, angle, E, F)``) or
  ``BRepOffsetAPI_MakeThickSolid.MakeThickSolidByJoin`` (offset ``∓t``, tolerance 1e-7,
  ``GeomAbs_Intersection`` joins; SPEC §8.3 rule 6), then ``UnifySameDomain`` as for body
  operations (OCCT propagates tangent chains by itself);
* compares OCCT's single valid solid with Forge's body: volume and area (relative
  ``1e-6``), and faces, edges, ``face_types``, ``edge_types`` (exact, after SPEC §8.3
  rule 1 — ``aicad_oracle.v1.normalize.normalized_topology``: faces on one carrier sharing
  an edge are one face, seams and edges inside one face are not counted, and counted edges
  on one carrier meeting at a vertex no other counted edge uses are one edge — so OCCT's
  pieces of an edge split at a seam or a vertex it rebuilt are counted as Forge's seam-free
  topology counts them; OCCT's raw counts are kept per row under ``rule1``);
* computes an **independent reference** where it can: the exact rolling-ball (bevel) result
  as an OCCT boolean of the base with the blend's tools — for each blended edge, the
  cross-section region between the edge and the ball (the bevel) swept along a line edge
  between two planes (extended past its ends and clipped by the planes of the faces it ends
  on) or revolved about a full circle between coaxial faces of revolution — cut from the
  base (convex edges) or fused to it (concave ones). Configurations it does not cover
  (tangent chains, several blended edges at a vertex, arcs, mixed convexity, shells) are
  ``unadjudicated``.

Sequences and families (W6 review round 4): besides the core and curved families, the batch
has **sequence** cases (``-q``: fillet → shell, fillet → fillet, chamfer → shell) whose
``pre`` blends the script runs with OCCT first (by the same probes; OCCT's result of each
must equal Forge's volume, ``BASE_MISMATCH`` otherwise; a sequence Forge fails before the
operation is ``OCCT_ONLY`` or ``BOTH_FAIL`` by OCCT's result of that blend), and
**adversarial** cases (``-a``: star prisms, tilted wedges, V-grooves, ribs). Families with a
closed form of the result (``closed_form``: enclosures and rounded boxes, written here from the
geometry independently of Forge) use it as the independent reference. The summary splits
everything by group (``split``) and states the rows that are classified by rules the SPEC's
text does not have yet (``under_spec_text``, a contract issue).

Classes (one per case):

* ``MATCH`` — both succeed, everything equal;
* ``NORMALIZED`` — both succeed, volume and area within ``1e-5``, and only counts or types
  differ where SPEC §8.3 applies: rule 4 (OCCT leaves a blend face free-form: it has
  B-spline faces where Forge has the analytic blend, with equal face and edge counts) — only
  as the SPEC states it (W6 review round 5, ``rule4_covered``): fillet and chamfer rows whose
  edges are pairs §6.6/§6.7 give a normative type for — or rule 5 (Forge's result has an
  **engine-defined** corner patch — any corner other than the normative sphere where three
  perpendicular faces meet, as the Forge batch records per corner);
* ``COUNT_DIFF`` — both succeed with equal volume and area but counts differ even after
  rule 1: every such row is listed in the summary (``count_diff_rows``) and must be explained
  in the W6 report; rows that only rule 4's re-typing would match outside its text
  (``RULE4_OUTSIDE_SPEC_TEXT``: plane–sphere blends, shells) or whose blend face's boundary
  edges are B-splines in OCCT (``RULE4_EDGES``) are COUNT_DIFF — mismatches in the gate —
  until the Contract stage extends rule 4;
* ``METRIC_DIFF`` — both succeed with different volume or area and the independent
  reference does not confirm Forge: **potential silent wrong**;
* ``OCCT_DIFF_REF_OK`` — both succeed with different volume or area, and the independent
  reference confirms Forge's volume (OCCT is the one that is off). The reference is
  independent only where the SPEC defines the result: at an engine-defined corner (every
  chamfer corner, a fillet corner other than the normative sphere) it would build Forge's own
  convention, so it gives no verdict there (W6 review round 5) and such a row stays
  ``METRIC_DIFF``;
* ``FORGE_ONLY_REF_OK`` / ``FORGE_ONLY_UNADJUDICATED`` — Forge succeeds, OCCT fails or
  returns an invalid shape; the reference confirms Forge's volume, or cannot be built;
* ``POTENTIAL_SILENT_WRONG`` — Forge succeeds, OCCT does not, and Forge's volume differs from
  the independent reference;
* ``OCCT_ONLY`` — OCCT returns a valid solid, Forge a structured error: a validity loss
  (broken down by Forge's code). No Forge code is taken as proof that a value breaks a SPEC
  rule: these count against the gate. A blend that runs into another feature is Forge's
  ``*_FAILED`` (W6 review round 6: SPEC §6.6 defines the rolling ball there, a capability
  gap; the reference still checks OCCT's body, ``occt_vs_reference``); a chamfer corner
  Forge refuses (three chamfers at a vertex whose faces are not mutually perpendicular, which
  SPEC §6.7 does not define) awaits a Contract ruling;
* ``BOTH_FAIL``.

Forge's ``*_TOO_LARGE`` errors carry ``max_feasible_*``: the Forge batch records its result
at that value, and the script runs OCCT at the same value (``at_max``: ``MATCH`` /
``DIFF`` / ``OCCT_FAIL``) — a check that the suggested value works in the other engine too.

Measurements follow SPEC-v1 §8.3: volume, area and centroid of OCCT's bodies (base and result)
are integrated adaptively ([W0-44]: ``VolumePropertiesGK`` 1e-10, ``SurfaceProperties`` 1e-12);
compared besides the counts and types: shells, centroid and bbox (absolute ``1e-6·s``) and the
number of blended edges (Forge's report ``edges``, which include ``chain_added``, against the
edges of OCCT's contours). Rule 4 re-types OCCT's free-form faces with ``ShapeAnalysis_CanonicalRecognition`` at
``1e-7·s`` and applies only where the remaining B-spline faces are exactly the ones Forge has as
analytic blend types; rule 5 applies only to corners the **oracle** finds engine-defined: a
sphere corner is normative only at a base vertex of three planes pairwise perpendicular within
``ANGULAR_TOLERANCE``.

Independent checks of Forge's results beyond OCCT:

* the reference above, which fails **explicitly** (never returns the base's volume) when a
  boolean fails or is invalid, a tool is empty, or the result is unchanged; for shells
  (``shell_reference_volume``) another OCCT path — the closed body's offset
  (``MakeOffsetShape``, intersection joins) with a lid over each opening, and booleans — where
  the openings are extreme planar faces whose walls are perpendicular to them;
* an OCCT result that leaves the body unchanged (``MakeThickSolid`` sometimes returns its
  input) is an OCCT failure (``OCCT_UNCHANGED``), not a metric difference;
* ``at_max``: where Forge builds its suggested value, the result is adjudicated with the
  reference too, and an OCCT failure there leaves it ``REF_OK``, ``POTENTIAL_SILENT_WRONG`` or
  ``UNADJUDICATED``;
* **closed forms** of the feasible range where the geometry gives one (``closed_form_limits``):
  two full rim circles of blended edges on one plane (fillets, equal chamfers of edges between a
  plane and a perpendicular cylinder), and for shells two full parallel cylinders or a full
  cylinder and a planar wall parallel to its axis that face each other. A suggested
  ``max_feasible_*`` at or above such a limit, or a Forge body built at or above it, is
  ``CLOSED_FORM_VIOLATION``;
* Forge's own certified self-intersection verdict (``interference`` in the batch): a ``hit``
  is ``SELF_INTERSECTING``.

Every one of these counts as potential silent-wrong in the gate.

The gate (the IR v1 plan's W6 acceptance): ``forge_valid >= occt_valid``, where a Forge body
counts as valid only with an **independent verdict** (W6 review round 3: OCCT's agreement or
the reference, and Forge's own certified self-intersection verdict) — Forge-only bodies
nothing adjudicates, bodies whose self-intersection verdict is ``unverified``, and suggested
values whose body OCCT fails on and the reference does not cover are listed under
``unadjudicated`` and fail the gate until adjudicated; ``potential_silent_wrong == 0``; and
``MATCH`` + ``NORMALIZED`` ≥ 99 % of the programs both engines build with ``NORMALIZED`` ≤ 5 %
of all programs. The summary also splits the ``OCCT_ONLY`` rows (``gap_kind``) into those that
need a **Contract ruling** (Forge's ``*_TOO_LARGE``: OCCT builds a value the Forge semantics call
infeasible — colliding shell walls, a value past a face's width; and Forge's ``*_FAILED`` that
says it awaits a Contract ruling — the undefined chamfer corners) and those that need **Forge
capability** (every other ``*_FAILED``: blends trimmed around another feature, NURBS blends, …). The exit status is non-zero when the
gate fails, when ``--baseline`` is given and Forge's valid count dropped or the
potential-silent-wrong count grew against it, or when ``--expect`` is given and the summary
differs from the pinned one (the CI hook, W7c).

Pinned seeds for CI (W7c): 17 and 71, 400 cases each (``BLEND_COUNT=400``); the expected
summaries of this revision are recorded in ``forge-blend/oracle/expected-summary.json``.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter

from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_MakeEdge,
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakeVertex,
    BRepBuilderAPI_MakeWire,
)
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepFilletAPI import BRepFilletAPI_MakeChamfer, BRepFilletAPI_MakeFillet
from OCP.BRepGProp import BRepGProp
from OCP.BRepLProp import BRepLProp_SLProps
from OCP.BRepOffset import BRepOffset_Skin
from OCP.BRepOffsetAPI import BRepOffsetAPI_MakeOffsetShape, BRepOffsetAPI_MakeThickSolid
from OCP.BRepPrimAPI import (
    BRepPrimAPI_MakeBox,
    BRepPrimAPI_MakeCylinder,
    BRepPrimAPI_MakeHalfSpace,
    BRepPrimAPI_MakePrism,
    BRepPrimAPI_MakeRevol,
    BRepPrimAPI_MakeSphere,
)
from OCP.GC import GC_MakeArcOfCircle, GC_MakeSegment
from OCP.GeomAbs import (
    GeomAbs_Hyperbola,
    GeomAbs_Parabola,
    GeomAbs_Sphere,
    GeomAbs_Torus,
    GeomAbs_BezierSurface,
    GeomAbs_BSplineSurface,
    GeomAbs_Circle,
    GeomAbs_Cone,
    GeomAbs_Cylinder,
    GeomAbs_Intersection,
    GeomAbs_Line,
    GeomAbs_OffsetSurface,
    GeomAbs_Plane,
    GeomAbs_SurfaceOfExtrusion,
    GeomAbs_SurfaceOfRevolution,
)
from OCP.GProp import GProp_GProps
from OCP.ElCLib import ElCLib
from OCP.gp import gp_Ax1, gp_Ax2, gp_Cone, gp_Cylinder, gp_Dir, gp_Pln, gp_Pnt, gp_Pnt2d, gp_Sphere, gp_Vec
from OCP.ShapeAnalysis import ShapeAnalysis_CanonicalRecognition, ShapeAnalysis_Surface
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_IN, TopAbs_ON, TopAbs_REVERSED, TopAbs_SHELL, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape, TopTools_ListOfShape

from aicad_oracle import occt as O
from aicad_oracle.evaluate import evaluate_data
from aicad_oracle.v1.consts import ANGULAR_TOLERANCE, LINEAR_TOLERANCE
from aicad_oracle.v1.normalize import native_carrier, normalized_topology, same_curve_carrier

REL = 1e-6
REL_NORMALIZED = 1e-5
REL_REFERENCE = 1e-6


def build_operand(doc: dict):
    shapes: list = []
    rep = evaluate_data(doc, "operand", shapes=shapes)
    if rep.get("status") != "ok" or len(shapes) != 1:
        raise RuntimeError(f"operand build failed: {rep.get('features')}")
    return shapes[0][2]


def unify(shape):
    usd = ShapeUpgrade_UnifySameDomain(shape, True, True, False)
    usd.SetLinearTolerance(1e-6)
    usd.SetAngularTolerance(1e-9)
    usd.Build()
    return usd.Shape()


def boolean(a, b, op: str, do_unify: bool = True):
    args = TopTools_ListOfShape()
    args.Append(a)
    tools = TopTools_ListOfShape()
    tools.Append(b)
    algo = {"join": BRepAlgoAPI_Fuse, "cut": BRepAlgoAPI_Cut, "common": BRepAlgoAPI_Common}[op]()
    algo.SetArguments(args)
    algo.SetTools(tools)
    algo.SetRunParallel(False)
    algo.SetNonDestructive(True)
    algo.Build()
    if not algo.IsDone():
        raise RuntimeError("OCCT boolean failed")
    return unify(algo.Shape()) if do_unify else algo.Shape()


def solids_of(shape):
    out = []
    ex = TopExp_Explorer(shape, TopAbs_SOLID)
    while ex.More():
        out.append(TopoDS.Solid_s(ex.Current()))
        ex.Next()
    return out


class PreMismatch(RuntimeError):
    """OCCT's result of a sequence's earlier blend differs from Forge's (the comparison of
    the case is void, like a base mismatch)."""


def occt_blend(shape, op: dict, edge_probes: list, s: float):
    """OCCT's fillet or equal chamfer of the edges at `edge_probes` on `shape` (a sequence's
    earlier blend, W6 review round 4): (solid, None) or (None, error)."""
    tol = 1e-6 * s
    try:
        edges = []
        for e in edge_probes:
            oe = by_probe(shape, TopAbs_EDGE, e["probe"], tol)
            if oe is None:
                return None, "PROBE_UNMATCHED"
            edges.append(oe)
        if op["kind"] == "fillet":
            mk = BRepFilletAPI_MakeFillet(shape)
            for e in edges:
                mk.Add(op["r"], e)
        else:
            mk = BRepFilletAPI_MakeChamfer(shape)
            for e in edges:
                mk.Add(op["d"], e)
        mk.Build()
        if not mk.IsDone():
            return None, "OCCT_NOT_DONE"
        solids = solids_of(unify(mk.Shape()))
        if len(solids) != 1:
            return None, f"OCCT_{len(solids)}_SOLIDS"
        if not BRepCheck_Analyzer(solids[0]).IsValid():
            return None, "OCCT_INVALID"
        return solids[0], None
    except Exception as ex:  # noqa: BLE001
        return None, f"OCCT_EXCEPTION {type(ex).__name__}: {ex}"[:200]


def base_of(case: dict, upto: int | None = None):
    """The body the case's operation applies to: the base from its operands, then the
    sequence's earlier blends (``pre``, up to index ``upto`` exclusive), each checked against
    Forge's result of it (volume, relative ``REL``: ``PreMismatch`` otherwise)."""
    shape = None
    for st in case["steps"]:
        s = build_operand(st["doc"])
        shape = s if st["op"] == "new" else boolean(shape, s, st["op"])
    solids = solids_of(shape)
    if len(solids) != 1:
        raise RuntimeError(f"base has {len(solids)} solids")
    shape = solids[0]
    pre = case.get("pre") or []
    for k, p in enumerate(pre[: len(pre) if upto is None else upto]):
        fm = p.get("metrics")
        sc = scale_of(fm) if fm else 1.0
        solid, err = occt_blend(shape, p["op"], p["edges"], sc)
        if solid is None:
            raise PreMismatch(f"OCCT fails the sequence's blend {k} ({p['op']['kind']} {p['select']}): {err}")
        if fm is not None and rel(volume(solid), fm["volume"]) > REL:
            raise PreMismatch(f"the sequence's blend {k}: OCCT volume {volume(solid)} vs Forge {fm['volume']}")
        shape = solid
    return shape


#: SPEC-independent closed forms of the sequence families (W6 review round 4), written from
#: the geometry: a body whose horizontal sections are rounded rectangles `a × b` (corner
#: radius `R`) rounded at the bottom by a blend of radius `ρ` has the section area
#: `A(d) = (a − 2d)(b − 2d) − (4 − π)(R − d)²` at the blend's inset `d`; over the blend's slab
#: (`d = ρ(1 − sin θ)`, `dz = ρ sin θ dθ`) Pappus gives `blend_slab` exactly.
K_CORNER = 4.0 - math.pi


def _section(a: float, b: float, rc: float) -> float:
    return a * b - K_CORNER * rc * rc


def _blend_slab(a: float, b: float, rc: float, rho: float) -> float:
    return rho * (_section(a, b, rc) + rho * (2.0 * K_CORNER * rc - 2.0 * (a + b)) * (1.0 - math.pi / 4.0)
                  + rho * rho * (4.0 - K_CORNER) * (5.0 / 3.0 - math.pi / 2.0))


def _rounded_box(a: float, b: float, c: float, r: float) -> float:
    x, y, z = a - 2 * r, b - 2 * r, c - 2 * r
    return x * y * z + 2 * r * (x * y + y * z + z * x) + math.pi * r * r * (x + y + z) + 4.0 / 3.0 * math.pi * r ** 3


def closed_form_volume(case: dict, value: float | None = None) -> tuple[float | None, str]:
    """The volume of the case's result at `value` (the requested one by default) from its
    family's closed form, or (None, why)."""
    cf = case.get("closed_form")
    if not cf:
        return None, "no closed form"
    op = case["op"]
    if cf["kind"] == "enclosure":
        a, b, c, rv, rb = cf["a"], cf["b"], cf["c"], cf["rv"], cf["rb"]
        if op["kind"] == "fillet":
            r = value if value is not None else op["r"]
            if not (0 < r < rv and r < c):
                return None, "the bottom blend reaches the corners' radius"
            return _blend_slab(a, b, rv, r) + (c - r) * _section(a, b, rv), "closed form (enclosure)"
        t = value if value is not None else op["thickness"]
        v0 = _blend_slab(a, b, rv, rb) + (c - rb) * _section(a, b, rv)
        foot = _section(a - 2 * rb, b - 2 * rb, rv - rb)
        sel = case["select"]
        if op["direction"] == "inward":
            if not (t < rb and t < rv):
                return None, "the offset degenerates"
            top = {"open_top": c, "closed": c - t, "open_bottom": c - t}[sel]
            cav = _blend_slab(a - 2 * t, b - 2 * t, rv - t, rb - t) + (top - rb) * _section(a - 2 * t, b - 2 * t, rv - t)
            if sel == "open_bottom":
                cav += foot * t
            return v0 - cav, "closed form (enclosure shell)"
        top = {"open_top": c, "closed": c + t, "open_bottom": c + t}[sel]
        outer = _blend_slab(a + 2 * t, b + 2 * t, rv + t, rb + t) + (top - rb) * _section(a + 2 * t, b + 2 * t, rv + t)
        if sel == "open_bottom":
            outer -= foot * t
        return outer - v0, "closed form (enclosure shell)"
    if cf["kind"] == "rounded_box":
        a, b, c, r = cf["a"], cf["b"], cf["c"], cf["r"]
        if op["kind"] != "shell":
            return None, "not a shell"
        t = value if value is not None else op["thickness"]
        v0 = _rounded_box(a, b, c, r)
        lateral = (a - 2 * r) * (b - 2 * r) * t if case["select"] in ("open_top", "open_bottom") else 0.0
        if op["direction"] == "inward":
            if not t < r:
                return None, "the offset degenerates"
            return v0 - _rounded_box(a - 2 * t, b - 2 * t, c - 2 * t, r - t) - lateral, "closed form (rounded box shell)"
        return _rounded_box(a + 2 * t, b + 2 * t, c + 2 * t, r + t) - v0 - lateral, "closed form (rounded box shell)"
    return None, f"unknown closed form {cf['kind']}"


def entities(shape, kind):
    m = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, kind, m)
    cast = {TopAbs_EDGE: TopoDS.Edge_s, TopAbs_FACE: TopoDS.Face_s, TopAbs_VERTEX: TopoDS.Vertex_s}[kind]
    return [cast(m.FindKey(i)) for i in range(1, m.Extent() + 1)]


def point_shape_distance(p, shape) -> float:
    v = BRepBuilderAPI_MakeVertex(gp_Pnt(*p)).Vertex()
    d = BRepExtrema_DistShapeShape(v, shape)
    return d.Value() if d.IsDone() else math.inf


def by_probe(shape, kind, p, tol):
    """The unique entity of `kind` within `tol` of point `p` (None if none, or if several
    are that close: an ambiguous probe matches nothing). Edges: when the probe lies where
    OCCT split one of Forge's edges (a circle cut at OCCT's seam vertex, W6 review round 3),
    the pieces within `tol` are one edge by position along the curve ([W0-54] matches probes
    without normals by position): if every candidate is a piece of one carrier curve (§8.3
    rule 1.3 (a)) and they meet at the probe, the piece holding the probe farthest inside
    its own range is taken — OCCT's fillet and chamfer propagate along the G1 continuation
    to the other pieces themselves."""
    hits = []
    seams = seam_edges(shape) if kind == TopAbs_EDGE else []
    for e in entities(shape, kind):
        if kind == TopAbs_EDGE and (BRep_Tool.Degenerated_s(e) or any(e.IsSame(x) for x in seams)):
            # Degenerate edges and seams (one face on both sides) are not edges of the
            # seam-free topology the probes come from (a seam ends on its face's rim circle,
            # right at a circle's probe: W6 review round 3, the cross-hole rows).
            continue
        d = point_shape_distance(p, e)
        if d <= tol:
            hits.append((d, e))
    if len(hits) == 1:
        return hits[0][1]
    if kind != TopAbs_EDGE or len(hits) < 2:
        return None
    types = [O.edge_type(e) for _, e in hits]
    carriers = [native_carrier(e, t) for (_, e), t in zip(hits, types)]
    if any(c is None for c in carriers) or not all(
        same_curve_carrier(types[0], carriers[0], t, c) for t, c in zip(types[1:], carriers[1:])
    ):
        return None
    # Pieces of one curve meeting at the probe: the one whose range holds it most inside.
    best, depth = None, -math.inf
    for _, e in hits:
        ad = BRepAdaptor_Curve(e)
        a, b = ad.FirstParameter(), ad.LastParameter()
        ts = [t for t in (a + (b - a) * i / 64.0 for i in range(65))]
        t = min(ts, key=lambda x: math.dist(v3(ad.Value(x)), p))
        inside = min(t - a, b - t) / max(b - a, 1e-300)
        if inside > depth:
            best, depth = e, inside
    return best


def seam_edges(shape) -> list:
    """Edges with the same face on both sides (seams of periodic faces)."""
    anc = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, anc)
    out = []
    for i in range(1, anc.Extent() + 1):
        e = TopoDS.Edge_s(anc.FindKey(i))
        if any(BRep_Tool.IsClosed_s(e, TopoDS.Face_s(f)) for f in anc.FindFromIndex(i)):
            out.append(e)
    return out


def scale_of(m: dict) -> float:
    lo, hi = m["bbox_min"], m["bbox_max"]
    return max(1.0, math.dist(lo, hi))


def volume(shape) -> float:
    """Adaptive volume ([W0-44]): the reference's booleans are v1 body operations too."""
    g = GProp_GProps()
    BRepGProp.VolumePropertiesGK_s(shape, g, 1e-10)
    return g.Mass()


FREEFORM = (
    GeomAbs_BSplineSurface,
    GeomAbs_BezierSurface,
    GeomAbs_OffsetSurface,
    GeomAbs_SurfaceOfRevolution,
    GeomAbs_SurfaceOfExtrusion,
)


def rule4_face_type(face, s: float) -> str:
    """SPEC §8.3 rule 4: a free-form (B-spline, Bézier, offset, revolution, extrusion) face goes
    through ShapeAnalysis_CanonicalRecognition at 1e-7·s; analytic faces keep their type."""
    if BRepAdaptor_Surface(face).GetType() not in FREEFORM:
        return O.face_type(face)
    tol = 1e-7 * s
    cr = ShapeAnalysis_CanonicalRecognition(face)
    if cr.IsPlane(tol, gp_Pln()):
        return "plane"
    if cr.IsCylinder(tol, gp_Cylinder()):
        return "cylinder"
    if cr.IsCone(tol, gp_Cone()):
        return "cone"
    if cr.IsSphere(tol, gp_Sphere()):
        return "sphere"
    return "bspline"


def conic_or_bspline(edge) -> str:
    """v0's edge type, with parabola and hyperbola arcs counted as `bspline` (SPEC §8.3 rule 3:
    the canonical types have neither; OCCT returns a cone bevel's section by a plane parallel
    to its axis as an exact hyperbola, Forge as a B-spline)."""
    t = O.edge_type(edge)
    if t == "other" and BRepAdaptor_Curve(edge).GetType() in (GeomAbs_Hyperbola, GeomAbs_Parabola):
        return "bspline"
    return t


def metrics_v1(solid, s: float) -> dict:
    """The oracle's body metrics with SPEC-v1 §8.3's measurements: adaptive volume, area and
    centroid ([W0-44]), the shell count, and the rule-4 face types."""
    m = O.body_metrics(solid)
    vp = GProp_GProps()
    # (shape, props, eps, OnlyClosed, IsUseSpan, CGFlag: compute the centre of mass too)
    BRepGProp.VolumePropertiesGK_s(solid, vp, 1e-10, False, False, True)
    sp = GProp_GProps()
    BRepGProp.SurfaceProperties_s(solid, sp, 1e-12)
    c = vp.CentreOfMass()
    m["volume"], m["area"], m["centroid"] = vp.Mass(), sp.Mass(), [c.X(), c.Y(), c.Z()]
    m["shells"] = len(entities_any(solid, TopAbs_SHELL))
    hist: dict = {}
    for f in entities(solid, TopAbs_FACE):
        t = rule4_face_type(f, s)
        hist[t] = hist.get(t, 0) + 1
    m["face_types_rule4"] = dict(sorted(hist.items()))
    # SPEC §8.3 rule 1 (the oracle MUST apply it): faces on one carrier sharing an edge are
    # one face, edges with one face on both sides are not counted, and counted edges on one
    # carrier meeting at a vertex no other counted edge uses are one edge — OCCT splits
    # edges and faces where Forge's seam-free topology (§6.0.4) has one (W6 review round 3:
    # the unexplained COUNT_DIFF rows). The counts compared are the normalized ones; OCCT's
    # raw counts are kept under "raw".
    try:
        nt = normalized_topology(solid, edge_type=lambda e, fa, fb: conic_or_bspline(e))
        ft, ft4, et = Counter(), Counter(), Counter()
        for group in nt.faces:
            ft[O.face_type(group[0])] += 1
            ft4[rule4_face_type(group[0], s)] += 1
        for t in nt.edge_types:
            et[t] += 1
        norm = {"faces": len(nt.faces), "edges": len(nt.edges), "face_types": dict(sorted(ft.items())),
                "edge_types": dict(sorted(et.items())), "face_types_rule4": dict(sorted(ft4.items()))}
        raw = {k: m[k] for k in norm}
        m["raw"] = raw
        m["rule1_changed"] = raw != norm
        m.update(norm)
    except Exception as ex:  # noqa: BLE001 - the raw counts then stand, with a note
        m["rule1_error"] = f"{type(ex).__name__}: {ex}"[:160]
    return m


def entities_any(shape, kind) -> list:
    m = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, kind, m)
    return [m.FindKey(i) for i in range(1, m.Extent() + 1)]


def face_contains(face, p, tol) -> bool:
    """`p` (on the face's surface) is IN or ON the face."""
    sas = ShapeAnalysis_Surface(BRep_Tool.Surface_s(face))
    uv = sas.ValueOfUV(gp_Pnt(*p), 1e-9)
    st = BRepClass_FaceClassifier(face, gp_Pnt2d(uv.X(), uv.Y()), tol).State()
    return st in (TopAbs_IN, TopAbs_ON)


# ---------------------------------------------------------------------------------------
# Independent reference: the exact rolling-ball / bevel result by booleans.


def v3(p) -> tuple:
    return (p.X(), p.Y(), p.Z())


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def mul(a, k):
    return (a[0] * k, a[1] * k, a[2] * k)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def unit(a):
    n = math.sqrt(dot(a, a))
    if n <= 1e-300:
        raise ValueError("zero vector")
    return mul(a, 1.0 / n)


def outward_normal(face, p) -> tuple:
    ad = BRepAdaptor_Surface(face)
    sas = ShapeAnalysis_Surface(BRep_Tool.Surface_s(face))
    uv = sas.ValueOfUV(gp_Pnt(*p), 1e-9)
    props = BRepLProp_SLProps(ad, uv.X(), uv.Y(), 1, 1e-9)
    if not props.IsNormalDefined():
        raise ValueError("no normal")
    n = props.Normal()
    n = (n.X(), n.Y(), n.Z())
    return mul(n, -1.0) if face.Orientation() == TopAbs_REVERSED else n


def into_face(face, p, t, eps) -> tuple:
    """The unit direction at `p` (on an edge of tangent `t`) that is tangent to `face` along
    its meridian / perpendicular to the edge and points into it."""
    n = outward_normal(face, p)
    d = unit(cross(n, t))
    for cand in (d, mul(d, -1.0)):
        if point_shape_distance(add(p, mul(cand, eps)), face) <= 1e-7:
            return cand
    raise ValueError("no into-face direction")


def profile_points(ia, ib, op, side_is_a, value):
    """The cross-section in the (ia, ib) frame: (setback on a, setback on b, arc centre
    coefficients or None); `value` the fillet radius / chamfer distance."""
    cphi = max(-1.0, min(1.0, dot(ia, ib)))
    phi = math.acos(cphi)
    if not (1e-6 < phi < math.pi - 1e-6):
        raise ValueError("degenerate angle")
    if op["kind"] == "fillet":
        r = value
        s = r / math.tan(phi / 2.0)
        return s, s, r / math.sin(phi / 2.0), phi
    d = value
    if "d2" in op:
        da, db = (d, op["d2"]) if side_is_a else (op["d2"], d)
    elif "angle" in op:
        th = math.radians(op["angle"])
        if phi + th >= math.pi - 1e-9:
            raise ValueError("bevel misses the face")
        other = d * math.sin(th) / math.sin(phi + th)
        da, db = (d, other) if side_is_a else (other, d)
    else:
        da = db = d
    return da, db, None, phi


def wire_face(points_and_arcs):
    """A planar face from a closed sequence of ('seg', a, b) / ('arc', a, m, b)."""
    mk = BRepBuilderAPI_MakeWire()
    for item in points_and_arcs:
        if item[0] == "seg":
            c = GC_MakeSegment(gp_Pnt(*item[1]), gp_Pnt(*item[2])).Value()
        else:
            c = GC_MakeArcOfCircle(gp_Pnt(*item[1]), gp_Pnt(*item[2]), gp_Pnt(*item[3])).Value()
        mk.Add(BRepBuilderAPI_MakeEdge(c).Edge())
    return BRepBuilderAPI_MakeFace(mk.Wire(), True).Face()


def face_trace(face, e0, t, circle_axis=None):
    """The curve of `face` in the cross-section through `e0` (W6 review round 3): `None` for a
    line (a plane; a plane perpendicular to a circle edge's axis, a coaxial cylinder or cone),
    or `(centre, radius)` of a circle — a cylinder parallel to a line edge (tangent `t`), a
    sphere centred on a circle edge's axis `circle_axis = (point, direction)`, a ring torus
    about it. Raises ValueError for anything else."""
    ad = BRepAdaptor_Surface(face)
    typ = ad.GetType()
    if circle_axis is None:
        if typ == GeomAbs_Plane:
            return None
        if typ == GeomAbs_Cylinder:
            cy = ad.Cylinder()
            a, o = v3(cy.Axis().Direction()), v3(cy.Location())
            if _norm(cross(a, t)) > 1e-9:
                raise ValueError("a cylinder not parallel to the edge")
            return add(o, mul(a, dot(sub(e0, o), a))), cy.Radius()
        raise ValueError("line edge on an unsupported face")
    ao, az = circle_axis

    def off_axis(p) -> float:
        w = sub(p, ao)
        return _norm(sub(w, mul(az, dot(w, az))))

    if typ in (GeomAbs_Plane, GeomAbs_Cylinder, GeomAbs_Cone):
        return None
    if typ == GeomAbs_Sphere:
        sp = ad.Sphere()
        c = v3(sp.Location())
        if off_axis(c) > 1e-7:
            raise ValueError("a sphere off the axis")
        return c, sp.Radius()
    if typ == GeomAbs_Torus:
        tr = ad.Torus()
        c, a = v3(tr.Location()), v3(tr.Axis().Direction())
        if off_axis(c) > 1e-7 or _norm(cross(a, az)) > 1e-9 or tr.MinorRadius() > tr.MajorRadius():
            raise ValueError("a torus not about the axis")
        w = sub(e0, ao)
        er = unit(sub(w, mul(az, dot(w, az))))
        return add(add(ao, mul(az, dot(sub(c, ao), az))), mul(er, tr.MajorRadius())), tr.MinorRadius()
    raise ValueError("circle edge on an unsupported face")


def _roots_line_circle(p, d, c, rr):
    """Points of the line p + s·d (|d| = 1) at distance rr from c (2D tuples)."""
    w = (p[0] - c[0], p[1] - c[1])
    bq = w[0] * d[0] + w[1] * d[1]
    disc = bq * bq - (w[0] ** 2 + w[1] ** 2 - rr * rr)
    if disc < 0:
        return []
    sq = math.sqrt(disc)
    return [(p[0] + d[0] * t, p[1] + d[1] * t) for t in (-bq - sq, -bq + sq)]


def _meet2(oa, ob):
    """Where two offsets (('line', p, d) or ('circle', c, rr)) meet (2D)."""
    if oa[0] == "line" and ob[0] == "line":
        (p, d), (q, e) = oa[1:], ob[1:]
        den = d[0] * e[1] - d[1] * e[0]
        if abs(den) < 1e-15:
            return []
        t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den
        return [(p[0] + d[0] * t, p[1] + d[1] * t)]
    if oa[0] == "circle" and ob[0] == "line":
        oa, ob = ob, oa
    if oa[0] == "line":
        return _roots_line_circle(oa[1], oa[2], ob[1], ob[2])
    (c1, r1), (c2, r2) = oa[1:], ob[1:]
    dx, dy = c2[0] - c1[0], c2[1] - c1[1]
    dd = math.hypot(dx, dy)
    if dd < 1e-15 or dd > r1 + r2 or dd < abs(r1 - r2):
        return []
    a = (r1 * r1 - r2 * r2 + dd * dd) / (2 * dd)
    h = math.sqrt(max(0.0, r1 * r1 - a * a))
    ux, uy = dx / dd, dy / dd
    mx, my = c1[0] + ux * a, c1[1] + uy * a
    return [(mx - uy * h, my + ux * h), (mx + uy * h, my - ux * h)]


def _chord_point(trace2, i2, d):
    """The point of a face's trace (None: the line along i2; (c, R): a circle through the
    origin) at chord distance d from the origin, leaving along i2."""
    if trace2 is None:
        return (i2[0] * d, i2[1] * d)
    (c, R) = trace2
    if d >= 2 * R:
        raise ValueError("chamfer longer than the diameter")
    th = 2.0 * math.asin(d / (2.0 * R))
    a = (-c[0], -c[1])
    ccw = a[0] * i2[1] - a[1] * i2[0] > 0
    th = th if ccw else -th
    co, si = math.cos(th), math.sin(th)
    return (c[0] + a[0] * co - a[1] * si, c[1] + a[0] * si + a[1] * co)


def curved_section(e0, ia, ib, traces, op, side_is_a, value):
    """The cross-section face at `e0` when a face's trace is a circle: the rolling ball touches
    each face from the other's side (centre where the faces' offsets by r meet — a line moved
    by r, a concentric circle R ∓ r — nearest the tangent lines' ball), a bevel's contacts are at
    chord distance d; the region runs along the faces' arcs from the edge point to the contacts
    (an independent implementation of SPEC §6.6/§6.7's geometry, not Forge's code)."""
    X = unit(ia)
    Y = unit(sub(ib, mul(X, dot(ib, X))))
    to2 = lambda p: (dot(sub(p, e0), X), dot(sub(p, e0), Y))  # noqa: E731
    to3 = lambda q: add(e0, add(mul(X, q[0]), mul(Y, q[1])))  # noqa: E731
    i2 = [(1.0, 0.0), (dot(ib, X), dot(ib, Y))]
    tr2 = [None if tr is None else (to2(tr[0]), tr[1]) for tr in traces]
    n2 = [(0.0, 1.0), None]
    nb = (i2[1][1], -i2[1][0])
    n2[1] = nb if nb[0] > 0 else (-nb[0], -nb[1])
    phi = math.acos(max(-1.0, min(1.0, i2[1][0])))
    if op["kind"] == "fillet":
        r = value
        m = unit((1.0 + i2[1][0], i2[1][1], 0.0))
        c0 = (m[0] * r / math.sin(phi / 2), m[1] * r / math.sin(phi / 2))
        offs = []
        for k in (0, 1):
            if tr2[k] is None:
                offs.append(("line", (n2[k][0] * r, n2[k][1] * r), i2[k]))
            else:
                (c, R) = tr2[k]
                inside = c[0] * n2[k][0] + c[1] * n2[k][1] > 0
                rr = R - r if inside else R + r
                if rr <= 1e-9:
                    raise ValueError("radius reaches the curvature")
                offs.append(("circle", c, rr))
        cands = _meet2(offs[0], offs[1])
        if not cands:
            raise ValueError("offsets do not meet")
        c2 = min(cands, key=lambda q: math.hypot(q[0] - c0[0], q[1] - c0[1]))
        cont = []
        for k in (0, 1):
            if tr2[k] is None:
                t_ = c2[0] * i2[k][0] + c2[1] * i2[k][1]
                cont.append((i2[k][0] * t_, i2[k][1] * t_))
            else:
                (c, R) = tr2[k]
                u = unit((c2[0] - c[0], c2[1] - c[1], 0.0))
                cont.append((c[0] + u[0] * R, c[1] + u[1] * R))
        pa, pb = cont
        q = unit((-c2[0], -c2[1], 0.0))
        mid = (c2[0] + q[0] * r, c2[1] + q[1] * r)
        profile = ("arc", to3(pa), to3(mid), to3(pb))
    else:
        d = value
        if "d2" in op:
            da, db = (d, op["d2"]) if side_is_a else (op["d2"], d)
        elif "angle" in op:
            ks = 0 if side_is_a else 1
            if tr2[ks] is not None:
                raise ValueError("distance-angle on a curved side")
            th = math.radians(op["angle"])
            ps = (i2[ks][0] * d, i2[ks][1] * d)
            w = (-i2[ks][0] * math.cos(th) + n2[ks][0] * math.sin(th), -i2[ks][1] * math.cos(th) + n2[ks][1] * math.sin(th))
            o = 1 - ks
            if tr2[o] is None:
                hits = _meet2(("line", ps, w), ("line", (0.0, 0.0), i2[o]))
            else:
                hits = _roots_line_circle(ps, w, tr2[o][0], tr2[o][1])
            hits = [h for h in hits if (h[0] - ps[0]) * w[0] + (h[1] - ps[1]) * w[1] > 1e-9]
            if not hits:
                raise ValueError("bevel misses the face")
            po = min(hits, key=lambda h: math.hypot(h[0] - ps[0], h[1] - ps[1]))
            pa, pb = (ps, po) if ks == 0 else (po, ps)
            da = db = None
        else:
            da = db = d
        if da is not None:
            pa, pb = _chord_point(tr2[0], i2[0], da), _chord_point(tr2[1], i2[1], db)
        profile = ("seg", to3(pa), to3(pb))

    def along(k, p2):
        if tr2[k] is None:
            return ("seg", e0, to3(p2)) if k == 0 else ("seg", to3(p2), e0)
        (c, R) = tr2[k]
        u = unit(add((-c[0], -c[1], 0.0), unit((p2[0] - c[0], p2[1] - c[1], 0.0))))
        mid = (c[0] + u[0] * R, c[1] + u[1] * R)
        return ("arc", e0, to3(mid), to3(p2)) if k == 0 else ("arc", to3(p2), to3(mid), e0)

    return wire_face([along(0, pa), profile, along(1, pb)])


def section(e0, ia, ib, op, side_is_a, value):
    """The cross-section face at the point `e0` of the edge."""
    sa, sb, cdist, phi = profile_points(ia, ib, op, side_is_a, value)
    pa, pb = add(e0, mul(ia, sa)), add(e0, mul(ib, sb))
    if cdist is None:
        return wire_face([("seg", e0, pa), ("seg", pa, pb), ("seg", pb, e0)])
    c = add(e0, mul(unit(add(ia, ib)), cdist))
    q = add(c, mul(unit(sub(e0, c)), value))
    return wire_face([("seg", e0, pa), ("arc", pa, q, pb), ("seg", pb, e0)])


def ancestors(shape, kind, parent):
    m = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, kind, parent, m)
    return m


def listed(m, s) -> list:
    out = []
    for x in m.FindFromKey(s):
        if not any(x.IsSame(y) for y in out):
            out.append(x)
    return out


def edge_convex(edge, e2f, eps) -> bool:
    """Is `edge` convex (the material's dihedral angle below π) at its middle?"""
    faces = [TopoDS.Face_s(f) for f in listed(e2f, edge)]
    if len(faces) != 2:
        return False
    ad = BRepAdaptor_Curve(edge)
    tm = 0.5 * (ad.FirstParameter() + ad.LastParameter())
    m = v3(ad.Value(tm))
    t = unit(v3_vec(ad.DN(tm, 1)))
    return dot(into_face(faces[0], m, t, eps), outward_normal(faces[1], m)) < 0.0


def v3_vec(v) -> tuple:
    return (v.X(), v.Y(), v.Z())


def box_around(c, h):
    """The axis-aligned box of half-size `h` about `c` (bounds a corner piece before its
    half-spaces cut it: commons of unbounded half-spaces alone are unreliable in OCCT)."""
    return BRepPrimAPI_MakeBox(gp_Pnt(c[0] - h, c[1] - h, c[2] - h), 2.0 * h, 2.0 * h, 2.0 * h).Shape()


def half_space(p, n_out, big):
    """The half-space `(x − p)·n_out ≤ 0` as an OCCT solid."""
    pln = gp_Pln(gp_Pnt(*p), gp_Dir(*n_out))
    wide = BRepBuilderAPI_MakeFace(pln, -4.0 * big, 4.0 * big, -4.0 * big, 4.0 * big).Face()
    return BRepPrimAPI_MakeHalfSpace(wide, gp_Pnt(*sub(p, n_out))).Solid()


def corner_ball_centre(v, r, v2f):
    """The centre of the ball of radius `r` inside the three planes at convex vertex `v`
    (`n_i · q = n_i · v − r`)."""
    vp = v3(BRep_Tool.Pnt_s(v))
    ns = [outward_normal(TopoDS.Face_s(f), vp) for f in listed(v2f, v)]
    rhs = [dot(n, vp) - r for n in ns]

    def det3(m):
        return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))

    m = [list(n) for n in ns]
    d = det3(m)
    if abs(d) < 1e-12:
        raise ValueError("degenerate corner")
    out = []
    for k in range(3):
        mm = [row[:] for row in m]
        for i in range(3):
            mm[i][k] = rhs[i]
        out.append(det3(mm) / d)
    return tuple(out)


def corner_piece(v, op, val, v2e, v2f, e2f, big, eps):
    """The material a convex corner of three blended line edges between planes removes
    beyond the three edges' own tools (W6 review round 3): a chamfer's tetrahedron cut off by
    the plane through the contact lines' corners on the three faces; a fillet's cell between
    the vertex, the three planes through the corner ball's centre across the edges, and the
    ball (the ball touching the three planes). Built from the base's geometry and SPEC
    §6.6/§6.7, not from Forge's construction."""
    if op["kind"] != "fillet" and ("d2" in op or "angle" in op):
        raise ValueError("an unequal chamfer corner")
    vp = v3(BRep_Tool.Pnt_s(v))
    fs = [TopoDS.Face_s(f) for f in listed(v2f, v)]
    ns = [outward_normal(f, vp) for f in fs]
    es = listed(v2e, v)
    dirs = []
    for x in es:
        ad = BRepAdaptor_Curve(TopoDS.Edge_s(x))
        a, b = v3(ad.Value(ad.FirstParameter())), v3(ad.Value(ad.LastParameter()))
        far = b if math.dist(a, vp) < math.dist(b, vp) else a
        dirs.append((TopoDS.Edge_s(x), unit(sub(far, vp))))
    reach = 0.0
    solid = None
    if op["kind"] == "fillet":
        r = val
        # n_i · q = n_i · v − r: the ball inside the three planes.
        m = [list(n) for n in ns]
        rhs = [dot(n, vp) - r for n in ns]
        det = (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
               + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))
        if abs(det) < 1e-12:
            raise ValueError("degenerate corner")

        def col(k):
            mm = [row[:] for row in m]
            for i in range(3):
                mm[i][k] = rhs[i]
            return (mm[0][0] * (mm[1][1] * mm[2][2] - mm[1][2] * mm[2][1]) - mm[0][1] * (mm[1][0] * mm[2][2] - mm[1][2] * mm[2][0])
                    + mm[0][2] * (mm[1][0] * mm[2][1] - mm[1][1] * mm[2][0])) / det

        q = (col(0), col(1), col(2))
        reach = math.dist(q, vp) + r
        solid = box_around(vp, 2.0 * reach)
        for h in [half_space(vp, n, big) for n in ns] + [half_space(q, t_, big) for _, t_ in dirs]:
            solid = boolean(solid, h, "common", do_unify=False)
        solid = boolean(solid, BRepPrimAPI_MakeSphere(gp_Pnt(*q), r).Shape(), "cut", do_unify=False)
    else:
        d = val
        # Contact lines: on face F, at distance d from each of its two edges.
        lines = {}
        for x, t_ in dirs:
            ef = [TopoDS.Face_s(f) for f in listed(e2f, x)]
            for k in (0, 1):
                f, g = ef[k], ef[1 - k]
                nf, ng = outward_normal(f, vp), outward_normal(g, vp)
                u = unit(cross(nf, t_))
                if dot(u, ng) > 0.0:
                    u = mul(u, -1.0)
                key = next(i for i, ff in enumerate(fs) if ff.IsSame(f))
                lines.setdefault(key, []).append((add(vp, mul(u, d)), t_))
        corners = []
        for key in range(3):
            (p1, d1), (p2, d2) = lines[key]
            w = sub(p1, p2)
            a_, b_, c_ = dot(d1, d1), dot(d1, d2), dot(d2, d2)
            s_ = (b_ * dot(d2, w) - c_ * dot(d1, w)) / (a_ * c_ - b_ * b_)
            corners.append(add(p1, mul(d1, s_)))
        n = unit(cross(sub(corners[1], corners[0]), sub(corners[2], corners[0])))
        if dot(sub(vp, corners[0]), n) < 0.0:
            n = mul(n, -1.0)
        reach = max(math.dist(c, vp) for c in corners) * 4.0
        solid = box_around(vp, 2.0 * reach)
        for h in [half_space(vp, nn, big) for nn in ns] + [half_space(corners[0], mul(n, -1.0), big)]:
            solid = boolean(solid, h, "common", do_unify=False)
    if not (volume(solid) > 0.0) or volume(solid) >= (2.0 * reach) ** 3 * 0.99:
        raise ValueError("corner piece is empty or not cut by its planes")
    return solid


def reference_corner_normative(v, op: dict, v2f) -> bool:
    """SPEC §6.6: the only normative corner patch is a fillet's sphere where three pairwise
    perpendicular planes meet (within ANGULAR_TOLERANCE); §6.7 defines no chamfer corner."""
    if op["kind"] != "fillet":
        return False
    fs = [TopoDS.Face_s(f) for f in listed(v2f, v)]
    if len(fs) != 3:
        return False
    ns = []
    for f in fs:
        ad = BRepAdaptor_Surface(f)
        if ad.GetType() != GeomAbs_Plane:
            return False
        ns.append(v3(ad.Plane().Axis().Direction()))
    return _perpendicular(ns)


def _perpendicular(ns: list) -> bool:
    """Unit normals pairwise perpendicular by SPEC §8.3 rule 3's test, `|a · b| ≤
    ANGULAR_TOLERANCE` (W6 review round 6: `|a × b| ≥ cos(ANGULAR_TOLERANCE)` rounds to
    `≥ 1.0` in floating point and failed rotated boxes; Forge applies the same test to decide
    which chamfer corners it builds)."""
    return all(abs(dot(ns[i], ns[j])) <= ANGULAR_TOLERANCE for i in range(len(ns)) for j in range(i + 1, len(ns)))


def end_clip(tool, face, inside, big):
    """`tool` clipped to the material side of the end face's whole surface (a bounded face
    would bound it only where the face is): a plane's half-space; a cylinder's or sphere's
    solid (common) or its complement (cut), by the side `inside` (a point just inside the
    body at the vertex) lies on (W6 review round 3: blends ending on curved faces)."""
    ad = BRepAdaptor_Surface(face)
    typ = ad.GetType()
    if typ == GeomAbs_Plane:
        pln = ad.Plane()
        wide = BRepBuilderAPI_MakeFace(pln, -4.0 * big, 4.0 * big, -4.0 * big, 4.0 * big).Face()
        hs = BRepPrimAPI_MakeHalfSpace(wide, gp_Pnt(*inside)).Solid()
        return boolean(tool, hs, "common", do_unify=False)
    if typ == GeomAbs_Cylinder:
        cy = ad.Cylinder()
        a, o, r = v3(cy.Axis().Direction()), v3(cy.Location()), cy.Radius()
        w = sub(inside, o)
        within = _norm(sub(w, mul(a, dot(w, a)))) < r
        base_pt = sub(o, mul(a, 4.0 * big))
        solid = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(*base_pt), gp_Dir(*a)), r, 8.0 * big).Shape()
    elif typ == GeomAbs_Sphere:
        sp = ad.Sphere()
        c, r = v3(sp.Location()), sp.Radius()
        within = math.dist(inside, c) < r
        solid = BRepPrimAPI_MakeSphere(gp_Pnt(*c), r).Shape()
    else:
        raise ValueError("end face type")
    return boolean(tool, solid, "common" if within else "cut", do_unify=False)


def reference_volume(case: dict, base, s: float, value: float | None = None, value2: float | None = None):
    """(volume, None) of the exact result, or (None, reason) when not covered or when a step
    fails (never the base's volume). `value`/`value2`: the fillet radius or chamfer distances
    to use instead of the case's (Forge's suggested value)."""
    op = dict(case["op"])
    if value2 is not None and "d2" in op:
        op["d2"] = value2
    if op["kind"] == "shell":
        return None, "shell"
    tol = 1e-6 * s
    edges = []
    for e in case["edges"]:
        oe = by_probe(base, TopAbs_EDGE, e["probe"], tol)
        if oe is None:
            return None, "probe"
        edges.append(oe)
    side = None
    if case.get("side"):
        side = by_probe(base, TopAbs_FACE, case["side"]["probe"], tol)
        if side is None:
            return None, "probe"
    val = value if value is not None else (op["r"] if op["kind"] == "fillet" else op["d"])
    e2f = ancestors(base, TopAbs_EDGE, TopAbs_FACE)
    v2e = ancestors(base, TopAbs_VERTEX, TopAbs_EDGE)
    v2f = ancestors(base, TopAbs_VERTEX, TopAbs_FACE)
    big = 2.0 * s + 10.0
    eps = 1e-4
    tools, convex_flags = [], []
    blended = edges
    corner_vertices: list = []
    for edge in edges:
        faces = [TopoDS.Face_s(f) for f in listed(e2f, edge)]
        if len(faces) != 2:
            return None, "not two faces"
        fa, fb = faces
        side_is_a = side is not None and fa.IsSame(side)
        ca = BRepAdaptor_Curve(edge)
        try:
            if ca.GetType() == GeomAbs_Line:
                v0, v1 = TopExp.FirstVertex_s(edge), TopExp.LastVertex_s(edge)
                p0, p1 = v3(BRep_Tool.Pnt_s(v0)), v3(BRep_Tool.Pnt_s(v1))
                t = unit(sub(p1, p0))
                mid = mul(add(p0, p1), 0.5)
                ia, ib = into_face(fa, mid, t, eps), into_face(fb, mid, t, eps)
                start = sub(p0, mul(t, big))
                traces = [face_trace(f, start, t) for f in faces]
                convex = dot(ia, outward_normal(fb, mid)) < 0.0
                # Each end: one blended edge, three faces, the third a face the edge leaves; or
                # a convex corner of 2 or 3 blended line edges between planes, where the tools
                # run on past the vertex (their union is the rolling-ball / bevel result there)
                # and a corner of 3 gets its corner piece (`corner_piece`).
                clips = []
                for v, into in ((v0, t), (v1, mul(t, -1.0))):
                    es = listed(v2e, v)
                    fs = [TopoDS.Face_s(f) for f in listed(v2f, v)]
                    if len(es) != 3 or len(fs) != 3:
                        return None, "vertex valence"
                    here = [TopoDS.Edge_s(x) for x in es if any(x.IsSame(b) for b in blended)]
                    if len(here) == 2 and convex and traces == [None, None] and all(
                        BRepAdaptor_Curve(x).GetType() == GeomAbs_Line for x in here
                    ) and all(BRepAdaptor_Surface(f).GetType() == GeomAbs_Plane for f in fs) and all(
                        edge_convex(x, e2f, eps) for x in here
                    ) and not all(edge_convex(TopoDS.Edge_s(x), e2f, eps) for x in es):
                        # Two convex blended line edges at a reflex vertex (the third edge is
                        # concave: a star's inner corner): with equal dihedral angles the two
                        # blends meet in their plane of symmetry through the vertex (W6 review
                        # round 4: the reviewer's closed form), each tool on its own side of it.
                        pv0 = v3(BRep_Tool.Pnt_s(v))
                        dirs2, dih = [], []
                        for x in here:
                            ax = BRepAdaptor_Curve(x)
                            qa, qb = v3(ax.Value(ax.FirstParameter())), v3(ax.Value(ax.LastParameter()))
                            far = qb if math.dist(qa, pv0) < math.dist(qb, pv0) else qa
                            dirs2.append((x, unit(sub(far, pv0))))
                            xf = [TopoDS.Face_s(f) for f in listed(e2f, x)]
                            dih.append(dot(outward_normal(xf[0], pv0), outward_normal(xf[1], pv0)))
                        if abs(dih[0] - dih[1]) > 1e-9:
                            return None, "an asymmetric corner of two blended edges"
                        mine = [d for x, d in dirs2 if x.IsSame(edge)]
                        other = [d for x, d in dirs2 if not x.IsSame(edge)]
                        if len(mine) != 1 or len(other) != 1:
                            return None, "several blended edges at a vertex"
                        n_keep = sub(mine[0], other[0])
                        if _norm(n_keep) < 1e-9:
                            return None, "degenerate mitre"
                        clips.append(("mitre", pv0, unit(n_keep)))
                        continue
                    if len(here) > 1:
                        # Only at a convex vertex (all three edges convex: the body is the
                        # three faces' half-spaces there, so the tools' extensions past the
                        # vertex leave it); elsewhere they would run into the body.
                        if not convex or traces != [None, None] or any(
                            BRepAdaptor_Curve(x).GetType() != GeomAbs_Line for x in here
                        ) or any(BRepAdaptor_Surface(f).GetType() != GeomAbs_Plane for f in fs) or not all(
                            edge_convex(TopoDS.Edge_s(x), e2f, eps) for x in es
                        ):
                            return None, "several blended edges at a vertex"
                        if len(here) == 2:
                            # Two blended edges of different dihedral angles meet in a mitre that
                            # runs to the first side face one reaches, the other blend ending on
                            # that face (Forge and OCCT alike): not the union of the two tools
                            # run on past the vertex (W6 review round 4: the V-groove rows).
                            dihedral = []
                            for x in here:
                                xf = [TopoDS.Face_s(f) for f in listed(e2f, x)]
                                pv0 = v3(BRep_Tool.Pnt_s(v))
                                dihedral.append(dot(outward_normal(xf[0], pv0), outward_normal(xf[1], pv0)))
                            if abs(dihedral[0] - dihedral[1]) > 1e-9:
                                return None, "an asymmetric corner of two blended edges"
                        if len(here) == 3 and not any(v.IsSame(x) for x in corner_vertices):
                            corner_vertices.append(v)
                        if len(here) == 3 and op["kind"] == "fillet":
                            # The blend ends at its cross-section through the corner ball's
                            # centre (the corner cell holds the rest).
                            q = corner_ball_centre(v, val, v2f)
                            clips.append(("plane", q, into))
                        continue
                    third = [f for f in fs if not f.IsSame(fa) and not f.IsSame(fb)]
                    if len(third) != 1:
                        return None, "end face"
                    pv = v3(BRep_Tool.Pnt_s(v))
                    nc = outward_normal(third[0], pv)
                    if abs(dot(nc, into)) <= 1e-9:
                        return None, "end face along the edge"
                    if dot(nc, into) > 0.0:
                        # A reflex vertex: the end face meets the blend on the material's side;
                        # the blend ends at its plane from the edge's side, the face taking the
                        # end cap (OCCT's result: the L-block and pentagon closed forms of the
                        # W6 tests). A concave blend is not covered here.
                        if not convex or BRepAdaptor_Surface(third[0]).GetType() != GeomAbs_Plane:
                            return None, "end face leans over the edge"
                        clips.append(("face", third[0], add(pv, into)))
                        continue
                    clips.append(("face", third[0], add(pv, mul(nc, -1.0))))
                if traces == [None, None]:
                    sec = section(start, ia, ib, op, side_is_a, val)
                else:
                    sec = curved_section(start, ia, ib, traces, op, side_is_a, val)
                length = math.dist(p0, p1) + 2.0 * big
                tool = BRepPrimAPI_MakePrism(sec, gp_Vec(*mul(t, length))).Shape()
                for kind, what, where in clips:
                    if kind == "mitre":
                        # Keep (x − v)·n ≥ 0: this edge's side of the plane of symmetry.
                        tool = boolean(tool, half_space(what, mul(where, -1.0), big), "common", do_unify=False)
                    elif kind == "plane":
                        # Keep (x − q)·t ≥ 0, t pointing away from the vertex along the edge:
                        # the side of the closing plane through the corner ball's centre q.
                        tool = boolean(tool, half_space(what, mul(where, -1.0), big), "common", do_unify=False)
                    else:
                        tool = end_clip(tool, what, where, big)
            elif ca.GetType() == GeomAbs_Circle:
                v0, v1 = TopExp.FirstVertex_s(edge), TopExp.LastVertex_s(edge)
                arc_clips = []
                if not v0.IsSame(v1):
                    # An arc whose blend ends on planes at both vertices (W6 review round 3: a
                    # D-flat's top arc ends on the flat, oblique to its meridians): the full
                    # revolved tool clipped by those planes' half-spaces, when they cut the
                    # circle exactly at the arc (every point of the arc inside, every other
                    # point outside one of them).
                    for v in (v0, v1):
                        es = listed(v2e, v)
                        fs = [TopoDS.Face_s(f) for f in listed(v2f, v)]
                        if len(es) != 3 or len(fs) != 3:
                            return None, "vertex valence"
                        if any(any(x.IsSame(b) for b in blended) for x in es if not x.IsSame(edge)):
                            return None, "several blended edges at a vertex"
                        third = [f for f in fs if not f.IsSame(fa) and not f.IsSame(fb)]
                        if len(third) != 1 or BRepAdaptor_Surface(third[0]).GetType() != GeomAbs_Plane:
                            return None, "arc end face"
                        pv = v3(BRep_Tool.Pnt_s(v))
                        nc = outward_normal(third[0], pv)
                        if not any(third[0].IsSame(x[0]) for x in arc_clips):
                            arc_clips.append((third[0], pv, nc))
                    full = ca.Circle()
                    a0, a1 = ca.FirstParameter(), ca.LastParameter()
                    for k in range(72):
                        u = 2.0 * math.pi * (k + 0.5) / 72.0
                        q = v3(ElCLib.Value_s(u, full))
                        on_arc = a0 <= u <= a1 or a0 <= u + 2.0 * math.pi <= a1
                        inside = all(dot(sub(q, pv), nc) <= 1e-9 for _, pv, nc in arc_clips)
                        if on_arc != inside:
                            return None, "arc end planes do not cut the circle at the arc"
                circ = ca.Circle()
                ctr, z = v3(circ.Location()), v3(circ.Axis().Direction())
                m = v3(ca.Value(ca.FirstParameter()))
                er = unit(sub(m, ctr))
                t = cross(z, er)
                traces = [face_trace(f, m, t, (ctr, z)) for f in faces]
                ia, ib = into_face(fa, m, t, eps), into_face(fb, m, t, eps)
                convex = dot(ia, outward_normal(fb, m)) < 0.0
                if traces == [None, None]:
                    sec = section(m, ia, ib, op, side_is_a, val)
                else:
                    sec = curved_section(m, ia, ib, traces, op, side_is_a, val)
                tool = BRepPrimAPI_MakeRevol(sec, gp_Ax1(gp_Pnt(*ctr), gp_Dir(*z)), 2.0 * math.pi).Shape()
                for face, pv, nc in arc_clips:
                    tool = end_clip(tool, face, add(pv, mul(nc, -1.0)), big)
            else:
                return None, "curve type"
        except (ValueError, RuntimeError) as ex:
            return None, f"construction: {ex}"
        tools.append(tool)
        convex_flags.append(convex)
    if not tools:
        return None, "no edges"
    if len(set(convex_flags)) != 1:
        return None, "mixed convexity"
    for v in corner_vertices:
        # W6 review round 5: a corner patch the SPEC does not define (every chamfer corner,
        # a fillet corner other than the sphere at three pairwise perpendicular planes) would
        # be built here the way Forge builds it — that confirms Forge's convention, not its
        # correctness against OCCT: no independent verdict until the Contract stage rules on
        # such corners.
        if not reference_corner_normative(v, op, v2f):
            return None, "an engine-defined corner (the reference would follow Forge's convention: not independent)"
        try:
            tools.append(corner_piece(v, op, val, v2e, v2f, e2f, big, eps))
        except (ValueError, RuntimeError) as ex:
            return None, f"corner: {ex}"
    # Fail explicitly — never return the base's volume — when a tool is empty, a boolean fails
    # or is invalid, or it changes nothing.
    try:
        for x in tools:
            if not (volume(x) > 0.0) or not BRepCheck_Analyzer(x).IsValid():
                return None, "empty or invalid blend tool"
        u = tools[0]
        for x in tools[1:]:
            u = boolean(u, x, "join", do_unify=False)
        if not BRepCheck_Analyzer(u).IsValid():
            return None, "invalid union of the blend tools"
        v0 = volume(base)
        part = boolean(base, u, "common", do_unify=False) if convex_flags[0] else boolean(u, base, "cut", do_unify=False)
        if not BRepCheck_Analyzer(part).IsValid():
            return None, "invalid reference boolean"
        dv = volume(part)
        if not (dv > 1e-12 * max(1.0, v0)):
            return None, "the reference boolean changed nothing"
        return (v0 - dv if convex_flags[0] else v0 + dv), None
    except RuntimeError as ex:
        return None, f"boolean: {ex}"


def shell_reference_volume(case: dict, base, s: float, value: float | None = None):
    """(volume, None) of the exact shell by another OCCT path, or (None, reason). Inward: the
    base, each opening extruded outward by 2t (a lid), offset by −t (`MakeOffsetShape`,
    intersection joins) is the cavity, open through the lids; the shell is the base minus it.
    Outward: the offset by +t cut by each opening's plane, minus the base. Needs every
    opening planar and extreme (the body on one side of its plane) with the faces around it
    perpendicular to it (so a lid continues them); `None` otherwise."""
    op = case["op"]
    t = value if value is not None else op["thickness"]
    inward = op["direction"] != "outward"
    tol = 1e-6 * s
    opens = [by_probe(base, TopAbs_FACE, f["probe"], tol) for f in case["faces"]]
    if any(o is None for o in opens):
        return None, "probe"
    e2f = ancestors(base, TopAbs_EDGE, TopAbs_FACE)
    pts = [v3(BRep_Tool.Pnt_s(TopoDS.Vertex_s(x))) for x in entities_any(base, TopAbs_VERTEX)]
    planes = []
    for o in opens:
        ad = BRepAdaptor_Surface(o)
        if ad.GetType() != GeomAbs_Plane:
            return None, "non-planar opening"
        p0 = v3(ad.Value(0.5 * (ad.FirstUParameter() + ad.LastUParameter()), 0.5 * (ad.FirstVParameter() + ad.LastVParameter())))
        n = outward_normal(o, p0)
        if any(dot(sub(p, p0), n) > tol for p in pts):
            return None, "opening not extreme"
        for e in entities(o, TopAbs_EDGE):
            for f in listed(e2f, e):
                f = TopoDS.Face_s(f)
                if f.IsSame(o):
                    continue
                ca = BRepAdaptor_Curve(e)
                m = v3(ca.Value(0.5 * (ca.FirstParameter() + ca.LastParameter())))
                try:
                    nf = outward_normal(f, m)
                except ValueError:
                    return None, "degenerate wall"
                if abs(dot(nf, n)) > 1e-9:
                    return None, "a wall not perpendicular to its opening"
        planes.append((o, p0, n))

    def offset(shape, d):
        mo = BRepOffsetAPI_MakeOffsetShape()
        mo.PerformByJoin(shape, d, 1e-7, BRepOffset_Skin, False, False, GeomAbs_Intersection)
        if not mo.IsDone():
            raise RuntimeError("offset not done")
        sol = solids_of(unify(mo.Shape()))
        if len(sol) != 1 or not BRepCheck_Analyzer(sol[0]).IsValid():
            raise RuntimeError("offset not one valid solid")
        return sol[0]

    try:
        if inward:
            ext = base
            for o, p0, n in planes:
                lid = BRepPrimAPI_MakePrism(o, gp_Vec(*mul(n, 2.0 * t))).Shape()
                ext = boolean(ext, lid, "join")
            sol = solids_of(ext)
            if len(sol) != 1:
                return None, "lids"
            res = boolean(base, offset(sol[0], -t), "cut")
        else:
            outer = offset(base, t)
            for o, p0, n in planes:
                pln = BRepAdaptor_Surface(o).Plane()
                big = 4.0 * s + 10.0
                wide = BRepBuilderAPI_MakeFace(pln, -big, big, -big, big).Face()
                hs = BRepPrimAPI_MakeHalfSpace(wide, gp_Pnt(*sub(p0, n))).Solid()
                outer = boolean(outer, hs, "common")
            res = boolean(outer, base, "cut")
        sol = solids_of(res)
        if len(sol) != 1 or not BRepCheck_Analyzer(sol[0]).IsValid():
            return None, "reference not one valid solid"
        v = volume(sol[0])
        if abs(v - volume(base)) <= 1e-9 * max(1.0, volume(base)):
            return None, "the reference changed nothing"
        return v, None
    except (RuntimeError, ValueError) as ex:
        return None, f"shell reference: {ex}"


def shell_rule_evidence(case: dict, base, s: float, max_t: float | None) -> str | None:
    """Independent evidence that a shell thickness breaks a rule SPEC §6.8 states: an offset
    surface degenerates (a cylinder, sphere or torus radius reaches zero on the side the
    offset moves to), or — inward — the walls collide: OCCT's inward offset of the closed
    base by `t` is not one valid solid while the offset at Forge's `max_feasible_thickness`
    is. `None` when neither can be shown."""
    op = case["op"]
    t = op["thickness"]
    sign = 1.0 if op["direction"] == "outward" else -1.0
    tol = 1e-6 * s
    open_faces = [by_probe(base, TopAbs_FACE, f["probe"], tol) for f in case["faces"]]
    for f in entities(base, TopAbs_FACE):
        if any(o is not None and f.IsSame(o) for o in open_faces):
            continue
        ad = BRepAdaptor_Surface(f)
        kind = ad.GetType()
        if kind == GeomAbs_Cylinder:
            c = ad.Cylinder()
            radius, axis_pt, axis = c.Radius(), v3(c.Location()), v3(c.Axis().Direction())
        else:
            continue
        # A point of the face and its outward normal: convex (away from the axis) or not.
        u = 0.5 * (ad.FirstUParameter() + ad.LastUParameter())
        v = 0.5 * (ad.FirstVParameter() + ad.LastVParameter())
        p = v3(ad.Value(u, v))
        n = outward_normal(f, p)
        w = sub(p, axis_pt)
        radial = sub(w, mul(axis, dot(w, axis)))
        convex = dot(n, radial) > 0.0
        # The offset moves along ±n: the radius shrinks when it moves towards the axis.
        new_r = radius + sign * t if convex else radius - sign * t
        if new_r <= 1e-6:
            return f"a cylinder of radius {radius:.4g} offset by {t:g} degenerates (radius {new_r:.3g})"
    if sign < 0 and max_t:
        def offset_ok(x: float) -> bool:
            try:
                mo = BRepOffsetAPI_MakeOffsetShape()
                mo.PerformByJoin(base, -x, 1e-7, BRepOffset_Skin, False, False, GeomAbs_Intersection)
                if not mo.IsDone():
                    return False
                sol = solids_of(unify(mo.Shape()))
                return len(sol) == 1 and BRepCheck_Analyzer(sol[0]).IsValid() and volume(sol[0]) > 0.0
            except Exception:  # noqa: BLE001
                return False

        if offset_ok(max_t) and not offset_ok(t):
            return f"OCCT's inward offset of the closed base collapses at {t:g} (not at {max_t:g}): the walls collide"
    return None


# ---------------------------------------------------------------------------------------


def _full_circle(edge) -> bool:
    return TopExp.FirstVertex_s(edge).IsSame(TopExp.LastVertex_s(edge))


def _norm(a) -> float:
    return math.sqrt(dot(a, a))


def _parallel(a, b) -> bool:
    return _norm(cross(unit(a), unit(b))) <= ANGULAR_TOLERANCE


def closed_form_limits(case: dict, base, s: float) -> list:
    """Closed forms of the feasible range, `[(limit, what)]`, where the geometry gives one (see
    the module docs); each is a value at which the construction certainly fails (contacts or
    walls meet), so a feasible value must be below it."""
    op = case["op"]
    tol = 1e-6 * s
    out = []
    if op["kind"] in ("fillet", "chamfer"):
        if op["kind"] == "chamfer" and ("d2" in op or "angle" in op):
            return out
        edges = [by_probe(base, TopAbs_EDGE, e["probe"], tol) for e in case["edges"]]
        if any(e is None for e in edges):
            return out
        e2f = ancestors(base, TopAbs_EDGE, TopAbs_FACE)
        rims = []
        for e in edges:
            ca = BRepAdaptor_Curve(e)
            if ca.GetType() != GeomAbs_Circle or not _full_circle(e):
                continue
            fs = [TopoDS.Face_s(f) for f in listed(e2f, e)]
            if len(fs) != 2:
                continue
            kinds = [BRepAdaptor_Surface(f).GetType() for f in fs]
            if sorted(kinds) != sorted([GeomAbs_Plane, GeomAbs_Cylinder]):
                continue
            pl = fs[kinds.index(GeomAbs_Plane)]
            cy = fs[kinds.index(GeomAbs_Cylinder)]
            n = v3(BRepAdaptor_Surface(pl).Plane().Axis().Direction())
            a = v3(BRepAdaptor_Surface(cy).Cylinder().Axis().Direction())
            if not _parallel(n, a):
                continue
            circ = ca.Circle()
            c, rad = v3(circ.Location()), circ.Radius()
            xd = v3(circ.XAxis().Direction())
            # The contact on the plane moves away from the axis iff the plane lies outside the
            # circle (a hole's rim), towards it otherwise (a boss's top).
            p_out = add(c, mul(xd, rad + 1e-3 * max(1.0, rad)))
            sigma = 1.0 if face_contains(pl, p_out, tol) else -1.0
            rims.append((pl, c, rad, sigma))
        for i in range(len(rims)):
            for j in range(i + 1, len(rims)):
                pa, ca_, ra, sa = rims[i]
                pb, cb, rb, sb = rims[j]
                if not pa.IsSame(pb):
                    continue
                d = math.dist(ca_, cb)
                x = None
                if d >= ra + rb and sa + sb > 0:
                    x = (d - ra - rb) / (sa + sb)
                elif d + rb <= ra and sb - sa > 0:
                    x = (ra - rb - d) / (sb - sa)
                elif d + ra <= rb and sa - sb > 0:
                    x = (rb - ra - d) / (sa - sb)
                if x is not None and x > 0:
                    out.append((x, "two rim contacts on one plane meet"))
        return out
    # Shells.
    inward = op["direction"] != "outward"
    open_faces = [by_probe(base, TopAbs_FACE, f["probe"], tol) for f in case["faces"]]
    cyls, planes = [], []
    for f in entities(base, TopAbs_FACE):
        if any(o is not None and f.IsSame(o) for o in open_faces):
            continue
        ad = BRepAdaptor_Surface(f)
        u0, u1 = ad.FirstUParameter(), ad.LastUParameter()
        v0, v1 = ad.FirstVParameter(), ad.LastVParameter()
        p = v3(ad.Value(0.5 * (u0 + u1), 0.5 * (v0 + v1)))
        n = outward_normal(f, p)
        if ad.GetType() == GeomAbs_Cylinder and u1 - u0 >= 2.0 * math.pi - 1e-9:
            cyl = ad.Cylinder()
            o, a, rad = v3(cyl.Location()), v3(cyl.Axis().Direction()), cyl.Radius()
            w = sub(p, o)
            convex = dot(n, sub(w, mul(a, dot(w, a)))) > 0.0
            k = (-1.0 if convex else 1.0) * (1.0 if inward else -1.0)
            cyls.append((f, o, a, rad, k, (v0, v1)))
        elif ad.GetType() == GeomAbs_Plane:
            planes.append((f, p, n))
    for i in range(len(cyls)):
        fa, oa, aa, ra, ka, (za0, za1) = cyls[i]
        for j in range(i + 1, len(cyls)):
            fb, ob, ab, rb, kb, _ = cyls[j]
            if not _parallel(aa, ab):
                continue
            # Heights of b along a's axis must overlap a's.
            hb = [dot(sub(add(ob, mul(ab, v)), oa), aa) for v in (cyls[j][5][0], cyls[j][5][1])]
            if max(min(hb), za0) >= min(max(hb), za1):
                continue
            w = sub(ob, oa)
            d = _norm(sub(w, mul(aa, dot(w, aa))))
            x = None
            if d >= ra + rb and ka + kb > 0:
                x = (d - ra - rb) / (ka + kb)
            elif d + rb <= ra and kb - ka > 0:
                x = (ra - rb - d) / (kb - ka)
            elif d + ra <= rb and ka - kb > 0:
                x = (rb - ra - d) / (ka - kb)
            if x is not None and x > 0:
                out.append((x, "two cylindrical walls meet"))
        for fp, pp, n in planes:
            if abs(dot(n, aa)) > ANGULAR_TOLERANCE:
                continue
            m = n if not inward else mul(n, -1.0)
            sdist = dot(sub(oa, pp), m)
            if sdist <= ra or 1.0 + ka <= 0:
                continue
            # The axis' foot on the wall, at mid height, must be on the wall face.
            mid = add(oa, mul(aa, 0.5 * (za0 + za1)))
            foot = sub(mid, mul(n, dot(sub(mid, pp), n)))
            if not face_contains(fp, foot, tol):
                continue
            out.append(((sdist - ra) / (1.0 + ka), "a cylindrical wall meets a planar wall"))
    return out


def corner_normative(corner: dict, base, s: float) -> bool:
    """SPEC §6.6 / §8.3 rule 5, decided by the oracle: a sphere corner at a base vertex of three
    planes pairwise perpendicular within ANGULAR_TOLERANCE is the normative one; any other
    corner patch is engine-defined."""
    if corner.get("surface") != "sphere" or not corner.get("at"):
        return False
    v = by_probe(base, TopAbs_VERTEX, corner["at"], 1e-6 * s)
    if v is None:
        return False
    fs = listed(ancestors(base, TopAbs_VERTEX, TopAbs_FACE), v)
    if len(fs) != 3:
        return False
    ns = []
    for f in fs:
        ad = BRepAdaptor_Surface(TopoDS.Face_s(f))
        if ad.GetType() != GeomAbs_Plane:
            return False
        ns.append(v3(ad.Plane().Axis().Direction()))
    return _perpendicular(ns)


def forge_blended(report: dict | None) -> int | None:
    """Forge's blended edges (the report's `edges`: the reference's members, then the tangent
    chain's)."""
    if not report or "edges" not in report:
        return None
    return len(report["edges"])


def occt_run(case: dict, base, s: float, value: float | None = None, value2: float | None = None, info: dict | None = None):
    """(result solid or None, error text or None); `info["blended"]`: the number of edges in
    OCCT's fillet/chamfer contours."""
    info = {} if info is None else info
    op = case["op"]
    tol = 1e-6 * s
    kind = op["kind"]
    try:
        if kind == "shell":
            faces = TopTools_ListOfShape()
            for f in case["faces"]:
                face = by_probe(base, TopAbs_FACE, f["probe"], tol)
                if face is None:
                    return None, "PROBE_UNMATCHED"
                faces.Append(face)
            t = value if value is not None else op["thickness"]
            off = t if op["direction"] == "outward" else -t
            if faces.Size() == 0:
                # MakeThickSolid without closing faces returns the offset solid alone, not
                # a hollow body: SPEC §6.8's internal void is base − offset (inward) or
                # offset − base (outward), with the same offset settings.
                mo = BRepOffsetAPI_MakeOffsetShape()
                mo.PerformByJoin(base, off, 1e-7, BRepOffset_Skin, False, False, GeomAbs_Intersection)
                if not mo.IsDone():
                    return None, "OCCT_NOT_DONE"
                offset = mo.Shape()
                shape = boolean(base, offset, "cut") if off < 0 else boolean(offset, base, "cut")
            else:
                mk = BRepOffsetAPI_MakeThickSolid()
                mk.MakeThickSolidByJoin(base, faces, off, 1e-7, BRepOffset_Skin, False, False, GeomAbs_Intersection)
                mk.Build()
                if not mk.IsDone():
                    return None, "OCCT_NOT_DONE"
                shape = mk.Shape()
        else:
            edges = []
            for e in case["edges"]:
                oe = by_probe(base, TopAbs_EDGE, e["probe"], tol)
                if oe is None:
                    return None, "PROBE_UNMATCHED"
                edges.append(oe)
            side = None
            if case.get("side"):
                side = by_probe(base, TopAbs_FACE, case["side"]["probe"], tol)
                if side is None:
                    return None, "PROBE_UNMATCHED"
            if kind == "fillet":
                r = value if value is not None else op["r"]
                mk = BRepFilletAPI_MakeFillet(base)
                for e in edges:
                    mk.Add(r, e)
            else:
                d = value if value is not None else op["d"]
                mk = BRepFilletAPI_MakeChamfer(base)
                for e in edges:
                    if "d2" in op:
                        # At Forge's suggested value both distances scale together.
                        d2 = value2 if value2 is not None else op["d2"]
                        mk.Add(d, d2, e, side)
                    elif "angle" in op:
                        mk.AddDA(d, math.radians(op["angle"]), e, side)
                    else:
                        mk.Add(d, e)
            mk.Build()
            if not mk.IsDone():
                return None, "OCCT_NOT_DONE"
            info["blended"] = sum(mk.NbEdges(i) for i in range(1, mk.NbContours() + 1))
            shape = mk.Shape()
        shape = unify(shape)
        solids = solids_of(shape)
        if len(solids) != 1:
            return None, f"OCCT_{len(solids)}_SOLIDS"
        if not BRepCheck_Analyzer(solids[0]).IsValid():
            return None, "OCCT_INVALID"
        # A blend or shell that leaves the body as it was did not happen (OCCT sometimes
        # returns its input from MakeThickSolid).
        v0 = volume(base)
        if abs(volume(solids[0]) - v0) <= 1e-9 * max(1.0, v0):
            return None, "OCCT_UNCHANGED"
        # A fillet or chamfer of convex edges only removes material: a result larger than
        # the base, or reaching outside its box, is not a result (W6 review round 4: an OCCT
        # D-flat fillet 28 mm outside its base that BRepCheck accepts).
        if kind != "shell" and edges:
            e2f = ancestors(base, TopAbs_EDGE, TopAbs_FACE)
            if all(edge_convex(e, e2f, 1e-4) for e in edges):
                grown = volume(solids[0]) > v0 * (1.0 + 1e-9)
                bb, rb = box_of(base), box_of(solids[0])
                pad = 1e-6 * s
                outside = any(rb[0][i] < bb[0][i] - pad or rb[1][i] > bb[1][i] + pad for i in range(3))
                if grown or outside:
                    return None, "OCCT_GROWN"
        return solids[0], None
    except Exception as ex:  # noqa: BLE001 - OCCT raises Standard_Failure subclasses
        return None, f"OCCT_EXCEPTION {type(ex).__name__}: {ex}"[:200]


def box_of(shape) -> tuple:
    """The optimal bounding box of `shape` (min and max corners)."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    b = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, b, False, False)
    x0, y0, z0, x1, y1, z1 = b.Get()
    return (x0, y0, z0), (x1, y1, z1)


def rel(a: float, b: float) -> float:
    return abs(a - b) / max(abs(b), 1e-300)


NORMATIVE_TYPES = ("plane", "cylinder", "cone", "sphere", "torus")

RULE4_OUTSIDE = "RULE4_OUTSIDE_SPEC_TEXT"


def _surface_name(t) -> str:
    """A GeomAbs surface type's name (OCP's enums do not order)."""
    for k, name in ((GeomAbs_Plane, "plane"), (GeomAbs_Cylinder, "cylinder"), (GeomAbs_Cone, "cone"),
                    (GeomAbs_Sphere, "sphere"), (GeomAbs_Torus, "torus")):
        if t == k:
            return name
    return "other"


def rule4_covered(case: dict, base, s: float) -> tuple[bool, str]:
    """Whether SPEC §8.3 rule 4 covers this row (W6 review round 5: rule 4 is applied only as
    the SPEC states it): a fillet or chamfer whose every given edge is one of the pairs §6.6
    (fillet: a line edge between planes; a circle edge between a plane and a cylinder or
    cone about the circle's axis, or two coaxial cylinders) or §6.7 (chamfer: a line edge
    between planes; a circle edge between a plane and a coaxial cylinder or cone) gives a
    normative blend type for. Shells (rule 4 names fillet and chamfer faces) and other pairs
    (a plane and a sphere, a blend face of an earlier operation) are not covered: a row that
    only re-typing would make NORMALIZED stays a mismatch until the Contract stage extends
    the rule. (The tangent chain's added edges continue the given ones and are not checked.)"""
    kind = case["op"]["kind"]
    if kind not in ("fillet", "chamfer"):
        return False, f"rule 4 covers fillet and chamfer faces, not a {kind}'s"
    # Probes resolve at 1e-6·s (as everywhere in this script); the pair is classified with the
    # SPEC's named constants (§8.3: "where a normalization decides topology, a type or a
    # match, it uses the named constants"; W6 review round 6): directions parallel within
    # ANGULAR_TOLERANCE, positions within tol = LINEAR_TOLERANCE.
    tol = 1e-6 * s
    e2f = ancestors(base, TopAbs_EDGE, TopAbs_FACE)
    for e in case["edges"]:
        edge = by_probe(base, TopAbs_EDGE, e["probe"], tol)
        if edge is None:
            return False, "an edge probe did not resolve"
        faces = [TopoDS.Face_s(f) for f in listed(e2f, edge)]
        if len(faces) != 2:
            return False, "an edge not between two faces"
        ca = BRepAdaptor_Curve(edge)
        sa = [BRepAdaptor_Surface(f) for f in faces]
        types = sorted(_surface_name(x.GetType()) for x in sa)
        if ca.GetType() == GeomAbs_Line:
            if types != ["plane", "plane"]:
                return False, "a line edge not between two planes"
            continue
        if ca.GetType() != GeomAbs_Circle:
            return False, "an edge that is neither a line nor a circle"
        z = v3(ca.Circle().Axis().Direction())
        ctr = v3(ca.Circle().Location())

        def about_axis(ad) -> bool:
            t = ad.GetType()
            if t == GeomAbs_Plane:
                return _norm(cross(v3(ad.Plane().Axis().Direction()), z)) <= ANGULAR_TOLERANCE
            if t in (GeomAbs_Cylinder, GeomAbs_Cone):
                ax = ad.Cylinder().Axis() if t == GeomAbs_Cylinder else ad.Cone().Axis()
                d, o = v3(ax.Direction()), v3(ax.Location())
                w = sub(ctr, o)
                off = _norm(sub(w, mul(d, dot(w, d))))
                return _norm(cross(d, z)) <= ANGULAR_TOLERANCE and off <= LINEAR_TOLERANCE
            return False

        allowed = (
            [["cylinder", "plane"], ["cone", "plane"], ["cylinder", "cylinder"]]
            if kind == "fillet" else [["cylinder", "plane"], ["cone", "plane"]]
        )
        if types not in allowed:
            return False, (f"a circle edge between a {types[0]} and a {types[1]}: "
                           f"§6.{6 if kind == 'fillet' else 7} gives no normative blend type for the pair")
        if not all(about_axis(x) for x in sa):
            return False, "a circle edge whose faces are not about its axis"
    return True, ""


def rule4_applies(fm: dict, om: dict) -> bool:
    """SPEC §8.3 rule 4: after OCCT's free-form faces are re-typed (`face_types_rule4`), the
    B-spline faces OCCT still has beyond Forge's are exactly the analytic faces Forge has beyond
    OCCT's (and the face and edge counts are equal)."""
    ft_f, ft_o = fm["face_types"], om["face_types_rule4"]
    extra = ft_o.get("bspline", 0) - ft_f.get("bspline", 0)
    if extra <= 0 or fm["faces"] != om["faces"] or fm["edges"] != om["edges"]:
        return False
    deficit = {t: ft_f.get(t, 0) - ft_o.get(t, 0) for t in set(ft_f) | set(ft_o) if t != "bspline"}
    if any(v < 0 or (v > 0 and t not in NORMATIVE_TYPES) for t, v in deficit.items()):
        return False
    return sum(deficit.values()) == extra


RULE4_EDGES = "RULE4_EDGES"


def rule4_edges_only(fm: dict, om: dict) -> str | None:
    """The explained COUNT_DIFF (W6 review round 3): OCCT returns a blend face as a B-spline
    that rule 4's recognition re-types to exactly Forge's analytic type, with the same face and
    edge counts, and the only other difference is that the edges bounding it are B-splines in
    OCCT where Forge has lines or conics — the SPEC re-types the face (rule 4) but not its edges
    (rule 3 covers section edges of body operations only; a blend's edges keep v0's typing).
    Contract issue: rule 4 should re-type those edges with rule 3's (a)+(b) tests."""
    if fm["faces"] != om["faces"] or fm["edges"] != om["edges"]:
        return None
    if fm["face_types"] != om.get("face_types_rule4"):
        return None
    ef, eo = fm["edge_types"], om["edge_types"]
    if eo.get("bspline", 0) - ef.get("bspline", 0) <= 0:
        return None
    deficit = {t: ef.get(t, 0) - eo.get(t, 0) for t in set(ef) | set(eo) if t != "bspline"}
    if any(v < 0 or (v > 0 and t not in ("line", "circle", "ellipse")) for t, v in deficit.items()):
        return None
    if sum(deficit.values()) != eo.get("bspline", 0) - ef.get("bspline", 0):
        return None
    return f"{RULE4_EDGES}: OCCT's rule-4 blend face is bounded by B-spline edges where Forge has {deficit}"


def geometry_equal(fm: dict, om: dict, s: float) -> tuple[bool, str]:
    """Shells, centroid and bbox (absolute 1e-6·s)."""
    tol = 1e-6 * s
    notes = []
    if fm.get("shells") is not None and fm.get("shells") != om.get("shells"):
        notes.append(f"shells {fm.get('shells')}/{om.get('shells')}")
    for key in ("centroid", "bbox_min", "bbox_max"):
        a, b = fm.get(key), om.get(key)
        if a is None or b is None:
            continue
        d = max(abs(x - y) for x, y in zip(a, b))
        if d > tol:
            notes.append(f"{key} off by {d:.3e}")
    return not notes, ", ".join(notes)


def metric_class(fm: dict, om: dict, case: dict, engine_corner: bool, s: float,
                 blended: tuple | None = None, rule4: tuple[bool, str] = (True, "")) -> tuple[str, str]:
    """`engine_corner`: Forge's body has a corner patch the oracle finds engine-defined (rule
    5); `blended`: (Forge's, OCCT's) number of blended edges, compared exactly; `rule4`:
    whether rule 4 covers the row (`rule4_covered`), and why not."""
    dv, da = rel(fm["volume"], om["volume"]), rel(fm["area"], om["area"])
    geo_ok, geo_note = geometry_equal(fm, om, s)
    blended_ok = blended is None or None in blended or blended[0] == blended[1]
    counts_equal = (
        fm["faces"] == om["faces"]
        and fm["edges"] == om["edges"]
        and fm["face_types"] == om["face_types"]
        and fm["edge_types"] == om["edge_types"]
    )
    if dv <= REL and da <= REL and geo_ok and counts_equal and blended_ok:
        return "MATCH", ("§8.3 rule 1: OCCT's split edges/faces merged" if om.get("rule1_changed") else "")
    if dv <= REL and da <= REL and geo_ok and blended_ok and rule4_applies(fm, om):
        if rule4[0]:
            return "NORMALIZED", f"rule 4: {om['face_types_rule4']} vs {fm['face_types']}"
        return "COUNT_DIFF", (
            f"{RULE4_OUTSIDE}: only rule 4's re-typing would match ({rule4[1]}): "
            f"{om['face_types_rule4']} vs {fm['face_types']}"
        )
    rule5 = case["op"]["kind"] != "shell" and engine_corner
    if dv <= REL_NORMALIZED and da <= REL_NORMALIZED and rule5 and blended_ok:
        return "NORMALIZED", f"dv {dv:.2e} da {da:.2e} (rule 5)"
    if dv <= REL and da <= REL and geo_ok:
        why = "" if blended_ok else f"blended edges {blended[0]}/{blended[1]}; "
        known = rule4_edges_only(fm, om)
        if known and not rule4[0]:
            # W6 review round 6: a blend face of a pair §6.6/§6.7 gives no normative type for
            # (a plane–sphere chamfer) is outside rule 4's text whatever its edges.
            known = f"{RULE4_OUTSIDE}: only rule 4's re-typing of the blend face and its edges would match ({rule4[1]})"
        if known:
            why = known + "; " + why
        return "COUNT_DIFF", why + (
            f"faces {fm['faces']}/{om['faces']} edges {fm['edges']}/{om['edges']} "
            f"ft {fm['face_types']}/{om['face_types']} et {fm['edge_types']}/{om['edge_types']}"
        )
    return "METRIC_DIFF", (
        f"volume {fm['volume']:.9g} vs {om['volume']:.9g} (rel {dv:.2e}), area rel {da:.2e}"
        + (f", {geo_note}" if geo_note else "")
    )


def engine_corner(corners: list | None, base, s: float) -> bool:
    return any(not corner_normative(c, base, s) for c in (corners or []))


def compare(case: dict, reference_all: bool = False) -> dict:
    row = {"id": case["id"], "family": case["family"], "op": case["op"], "select": case["select"]}
    forge = case["forge"]
    psw: list = []
    pf = case.get("pre_failed")
    if pf:
        # Forge fails one of the sequence's earlier blends: OCCT runs the same blends; a
        # success is a validity loss (the operation itself is not compared).
        row["forge"] = forge["code"]
        row["forge_reason"] = str((forge.get("details") or {}).get("reason", forge.get("message", "")))
        try:
            base = base_of(case, upto=pf["index"])
        except PreMismatch as ex:
            row.update(cls="BASE_MISMATCH", note=str(ex)[:200])
            return row
        except Exception as ex:  # noqa: BLE001
            row.update(cls="BASE_FAIL", note=str(ex)[:200])
            return row
        fb = case["base"]
        s = scale_of(fb)
        solid, err = occt_blend(base, case["pre"][pf["index"]]["op"], case["pre"][pf["index"]]["edges"], s)
        row["occt"] = "ok" if solid is not None else err
        row["pre_failed"] = pf["index"]
        note = f"the sequence's blend {pf['index']}: {forge['code']}: {forge['message'][:160]}"
        row.update(cls="OCCT_ONLY" if solid is not None else "BOTH_FAIL", note=note)
        return row
    try:
        base = base_of(case)
    except PreMismatch as ex:
        row.update(cls="BASE_MISMATCH", note=str(ex)[:200])
        return row
    except Exception as ex:  # noqa: BLE001
        row.update(cls="BASE_FAIL", note=str(ex)[:200])
        return row
    fb = case["base"]
    s = scale_of(fb)
    bm = metrics_v1(base, s)
    # After a sequence's blends OCCT's topology may differ (its corner patches): the volume
    # decides.
    faces_differ = bm["faces"] != fb["faces"] and not case.get("pre")
    if rel(bm["volume"], fb["volume"]) > REL or faces_differ:
        row.update(cls="BASE_MISMATCH", note=f"base volume {bm['volume']} vs {fb['volume']}, faces {bm['faces']} vs {fb['faces']}")
        return row
    info: dict = {}
    solid, err = occt_run(case, base, s, info=info)
    om = metrics_v1(solid, s) if solid is not None else None
    row["occt"] = "ok" if solid is not None else err
    row["forge"] = forge["status"] if forge["status"] == "ok" else forge["code"]
    op = case["op"]
    requested = op.get("r", op.get("d", op.get("thickness")))

    def adjudicate(fmetrics: dict, value=None, value2=None) -> tuple[bool | None, str]:
        if case.get("closed_form"):
            vref, why = closed_form_volume(case, value)
            if vref is not None:
                d = rel(fmetrics["volume"], vref)
                return d <= REL_REFERENCE, f"{why} {vref:.9g} vs Forge {fmetrics['volume']:.9g} (rel {d:.2e})"
        if op["kind"] == "shell":
            vref, why = shell_reference_volume(case, base, s, value)
        else:
            vref, why = reference_volume(case, base, s, value, value2)
        if vref is None:
            return None, f"unadjudicated ({why})"
        d = rel(fmetrics["volume"], vref)
        return d <= REL_REFERENCE, f"reference {vref:.9g} vs Forge {fmetrics['volume']:.9g} (rel {d:.2e})"

    if om is not None and om.get("rule1_changed"):
        row["rule1"] = {"raw": om["raw"]}
    try:
        r4 = rule4_covered(case, base, s)
    except Exception as ex:  # noqa: BLE001
        r4 = (False, f"rule 4 coverage could not be decided: {ex}"[:120])
    if forge["status"] == "ok" and om is not None:
        blended = (forge_blended(forge.get("report")), info.get("blended"))
        cls, note = metric_class(forge["metrics"], om, case, engine_corner(forge.get("corners"), base, s), s, blended, r4)
        if cls == "METRIC_DIFF":
            ok, why = adjudicate(forge["metrics"])
            if ok:
                cls = "OCCT_DIFF_REF_OK"
            note = f"{note}; {why}"
        elif reference_all:
            # Also against the independent reference where OCCT agrees.
            ok, why = adjudicate(forge["metrics"])
            row["reference"] = {True: "ok", False: "MISMATCH", None: "n/a"}[ok]
            if ok is False:
                cls, note = "POTENTIAL_SILENT_WRONG", f"OCCT agrees but {why}"
        row.update(cls=cls, note=note)
    elif forge["status"] == "ok":
        ok, why = adjudicate(forge["metrics"])
        cls = {True: "FORGE_ONLY_REF_OK", False: "POTENTIAL_SILENT_WRONG", None: "FORGE_ONLY_UNADJUDICATED"}[ok]
        row.update(cls=cls, note=f"OCCT {err}; {why}")
    elif om is not None:
        note = f"{forge['code']}: {forge['message'][:160]}"
        row["forge_reason"] = str((forge.get("details") or {}).get("reason", forge.get("message", "")))
        if forge["code"] in ("FILLET_RADIUS_TOO_LARGE", "CHAMFER_DISTANCE_TOO_LARGE") or is_obstacle(forge):
            # Evidence for the Contract ruling on blends that run into another feature: is
            # OCCT's body the exact rolling-ball (bevel) result trimmed by the rest of the body,
            # i.e. the reference at the requested value?
            vref, why = reference_volume(case, base, s)
            if vref is None:
                row["occt_vs_reference"] = f"n/a ({why})"
            else:
                d = rel(om["volume"], vref)
                row["occt_vs_reference"] = f"{'equal' if d <= REL_REFERENCE else 'differs'} (rel {d:.2e})"
        if forge["code"] == "SHELL_THICKNESS_TOO_LARGE":
            max_t = (forge.get("details") or {}).get("max_feasible_thickness")
            ev = shell_rule_evidence(case, base, s, max_t)
            if ev:
                note = f"{note}; SPEC §6.8 rule broken: {ev}"
                row["spec_rule"] = ev
        row.update(cls="OCCT_ONLY", note=note)
    else:
        row.update(cls="BOTH_FAIL", note=f"{forge['code']} / {err}")
    if str(forge.get("interference", "")).startswith("hit"):
        psw.append(f"SELF_INTERSECTING: Forge's result {forge['interference']}")
    elif str(forge.get("interference", "")).startswith("unverified"):
        row["interference"] = "unverified"
        row["interference_note"] = str(forge["interference"])[:200]
    # Forge at its suggested value: OCCT there, and the reference whenever OCCT fails (or
    # always with --reference-all).
    at_max = forge.get("at_max")
    if at_max and at_max.get("status") == "ok":
        info2: dict = {}
        s2, err2 = occt_run(case, base, s, at_max["value"], at_max.get("value2"), info=info2)
        if s2 is None:
            ok, why = adjudicate(at_max["metrics"], at_max["value"], at_max.get("value2"))
            verdict = {True: "REF_OK", False: "POTENTIAL_SILENT_WRONG", None: "UNADJUDICATED"}[ok]
            row["at_max"] = f"OCCT_FAIL {err2}; {verdict} ({why})"
            row["at_max_adjudication"] = verdict
            if ok is False:
                psw.append(f"at max: {why}")
        else:
            blended2 = (forge_blended(at_max.get("report")), info2.get("blended"))
            c2, n2 = metric_class(at_max["metrics"], metrics_v1(s2, s), case,
                                  engine_corner(at_max.get("corners"), base, s), s, blended2, r4)
            row["at_max"] = c2 if c2 in ("MATCH", "NORMALIZED") else f"DIFF {c2} {n2}"
            if c2 == "METRIC_DIFF" or reference_all:
                ok, why = adjudicate(at_max["metrics"], at_max["value"], at_max.get("value2"))
                row["at_max_adjudication"] = {True: "REF_OK", False: "POTENTIAL_SILENT_WRONG", None: "UNADJUDICATED"}[ok]
                if ok is False:
                    psw.append(f"at max: {why}")
        if str(at_max.get("interference", "")).startswith("hit"):
            psw.append(f"SELF_INTERSECTING at max: {at_max['interference']}")
        elif str(at_max.get("interference", "")).startswith("unverified"):
            row["at_max_interference"] = "unverified"
    elif at_max:
        row["at_max"] = f"FORGE_FAIL {at_max.get('code')}"
    # Closed forms of the feasible range.
    try:
        limits = closed_form_limits(case, base, s)
    except Exception as ex:  # noqa: BLE001
        limits = []
        row["closed_form_error"] = str(ex)[:120]
    if limits:
        lim, what = min(limits)
        row["closed_form"] = {"limit": lim, "what": what}
        if forge["status"] == "ok" and requested is not None and requested >= lim:
            psw.append(f"CLOSED_FORM_VIOLATION: built {requested} at or above the limit {lim:.6g} ({what})")
        details = forge.get("details") or {}
        mx = details.get("max_feasible_r", details.get("max_feasible_d", details.get("max_feasible_thickness")))
        if mx is not None and mx >= lim:
            psw.append(f"CLOSED_FORM_VIOLATION: suggested {mx} at or above the limit {lim:.6g} ({what})")
    if psw:
        row["potential_silent_wrong"] = psw
    return row


def unadjudicated(r: dict) -> list:
    """Why a body Forge returned in row `r` has no independent verdict (W6 review round 3):
    Forge alone built it and neither OCCT nor the reference covers it; Forge's own
    self-intersection verdict is uncertain; or Forge's suggested value built a body OCCT fails
    on and the reference does not cover. Such bodies are **not valid for the gate** and are
    counted until adjudicated (the gate needs 0)."""
    out = []
    if r.get("forge") == "ok" and r["cls"] == "FORGE_ONLY_UNADJUDICATED":
        out.append("forge_only")
    if r.get("forge") == "ok" and r.get("interference") == "unverified":
        out.append("interference_unverified")
    if str(r.get("at_max", "")).startswith("OCCT_FAIL") and r.get("at_max_adjudication") == "UNADJUDICATED":
        out.append("at_max")
    if r.get("at_max_interference") == "unverified":
        out.append("at_max_interference_unverified")
    return out


def summarize(rows: list) -> dict:
    classes = Counter(r["cls"] for r in rows)
    ops = Counter((r["op"]["kind"], r["cls"]) for r in rows)
    forge_ok = sum(1 for r in rows if r.get("forge") == "ok")
    # Validity for the gate: a Forge body counts only with an independent verdict and no
    # potential-silent-wrong flag.
    forge_valid = sum(
        1 for r in rows
        if r.get("forge") == "ok" and not unadjudicated(r) and not r.get("potential_silent_wrong")
        and r["cls"] not in ("METRIC_DIFF", "POTENTIAL_SILENT_WRONG")
    )
    unadj = Counter(k for r in rows for k in unadjudicated(r))
    occt_valid = sum(1 for r in rows if r.get("occt") == "ok")
    both = sum(classes.get(c, 0) for c in ("MATCH", "NORMALIZED", "COUNT_DIFF", "METRIC_DIFF", "OCCT_DIFF_REF_OK"))
    flagged = sum(1 for r in rows if r.get("potential_silent_wrong") and r["cls"] not in ("METRIC_DIFF", "POTENTIAL_SILENT_WRONG"))
    psw = classes.get("METRIC_DIFF", 0) + classes.get("POTENTIAL_SILENT_WRONG", 0) + flagged
    at_max = Counter(r["at_max"].split(" ")[0] for r in rows if "at_max" in r)
    occt_only = [r for r in rows if r["cls"] == "OCCT_ONLY"]
    ruling = sum(1 for r in occt_only if gap_kind(r) == "ruling")
    capability = sum(1 for r in occt_only if gap_kind(r) == "capability")
    share = (classes.get("MATCH", 0) + classes.get("NORMALIZED", 0)) / both if both else None
    def group(r: dict) -> str:
        part = r["id"].split("-")[1] if "-" in r["id"] else ""
        return {"c": "curved", "q": "sequence", "a": "adversarial"}.get(part[:1], "core")

    split = {}
    for gname in sorted({group(r) for r in rows}):
        rs = [r for r in rows if group(r) == gname]
        split[gname] = {
            "cases": len(rs),
            "classes": dict(sorted(Counter(r["cls"] for r in rs).items())),
            "forge_ok": sum(1 for r in rs if r.get("forge") == "ok"),
            "forge_valid": sum(
                1 for r in rs
                if r.get("forge") == "ok" and not unadjudicated(r) and not r.get("potential_silent_wrong")
                and r["cls"] not in ("METRIC_DIFF", "POTENTIAL_SILENT_WRONG")),
            "occt_valid": sum(1 for r in rs if r.get("occt") == "ok"),
        }
    # Rows this script classifies with rules SPEC §8.3/§8.4 do not state yet (W6 review round
    # 4, a contract issue): under the SPEC's text a kernel diff would call them
    # POTENTIAL_SILENT_WRONG (both engines build, metrics differ beyond rule 5's 1e-5 — the
    # SPEC has no class for "an independent reference confirms one engine") or not NORMALIZED
    # (rule 4 applied to a pair outside §6.6's normative list — plane–sphere circle edges — or
    # to the blend face's boundary edges, RULE4_EDGES). Stated here until the Contract stage
    # rules; not counted in the gate above.
    # W6 review round 5: the rows rule 4 does not cover (other pairs, shells) and the RULE4_EDGES
    # rows are COUNT_DIFF — mismatches in the gate — and listed here.
    spec_psw = [r["id"] for r in rows if r["cls"] == "OCCT_DIFF_REF_OK"]
    spec_rule4_pair = [r["id"] for r in rows if r["cls"] == "COUNT_DIFF" and RULE4_OUTSIDE in r.get("note", "")]
    spec_rule4_edges = [r["id"] for r in rows if r["cls"] == "COUNT_DIFF" and RULE4_EDGES in r.get("note", "")]
    under_spec_text = {
        "potential_silent_wrong": len(spec_psw),
        "potential_silent_wrong_rows": spec_psw,
        "count_diff_rule4_not_covered": len(spec_rule4_pair),
        "count_diff_rule4_not_covered_rows": spec_rule4_pair,
        "count_diff_rule4_edges": len(spec_rule4_edges),
    }
    return {
        "cases": len(rows),
        "under_spec_text": under_spec_text,
        "split": split,
        "classes": dict(sorted(classes.items())),
        "by_op": {f"{k[0]}:{k[1]}": v for k, v in sorted(ops.items())},
        "forge_ok": forge_ok,
        "forge_valid": forge_valid,
        "occt_valid": occt_valid,
        "validity_ge_occt": forge_valid >= occt_valid,
        # Forge bodies without an independent verdict (see `unadjudicated`); the gate needs 0.
        "unadjudicated": {"total": sum(unadj.values()), **dict(sorted(unadj.items()))},
        # The plan's second criterion: MATCH + NORMALIZED ≥ 99 % of the programs both engines
        # build, NORMALIZED ≤ 5 % of all programs.
        "match_plus_normalized_ge_99": share is None or share >= 0.99,
        "normalized_le_5": classes.get("NORMALIZED", 0) / max(1, len(rows)) <= 0.05,
        # Rows whose OCCT counts changed under §8.3 rule 1 (compared normalized).
        "rule1_normalized": sum(1 for r in rows if r.get("rule1")),
        "count_diff_rows": [f"{r['id']}: {r.get('note', '')}" for r in rows if r["cls"] == "COUNT_DIFF"],
        # COUNT_DIFF rows by what they would need: RULE4_EDGES (`rule4_edges_only`) and
        # RULE4_OUTSIDE_SPEC_TEXT (`rule4_covered`) need a Contract ruling extending rule 4 —
        # mismatches until then (W6 review round 5); "unexplained" rows fail review.
        "count_diff_explained": dict(sorted(Counter(
            (RULE4_EDGES if RULE4_EDGES in r.get("note", "")
             else RULE4_OUTSIDE if RULE4_OUTSIDE in r.get("note", "") else "unexplained")
            for r in rows if r["cls"] == "COUNT_DIFF").items())),
        # The OCCT_ONLY gap split by what closes it (`gap_kind`): a Contract ruling (Forge's
        # *_TOO_LARGE where OCCT builds colliding walls or a value past a limit; a *_FAILED
        # awaiting a ruling: undefined chamfer corners) or Forge capability (other *_FAILED:
        # trimmed blends, NURBS blends, …); and the gate as it would stand if the rulings went
        # Forge's way.
        "gap": {
            "occt_only": len(occt_only),
            "needs_ruling": ruling,
            "needs_capability": capability,
            "other": len(occt_only) - ruling - capability,
            "validity_ge_occt_if_ruled_for_forge": forge_valid >= occt_valid - ruling,
        },
        # OCCT_ONLY rows where OCCT's body breaks a rule the SPEC states, shown
        # independently (shells only; see shell_rule_evidence): reported, not excluded from
        # the gate above.
        "occt_only_spec_rule_verified": sum(1 for r in occt_only if r.get("spec_rule")),
        # Blend rows that need the ruling: OCCT's body against the exact rolling-ball (bevel)
        # result trimmed by the rest of the body (the reference) at the requested value.
        "occt_only_blend_vs_reference": dict(sorted(Counter(
            str(r.get("occt_vs_reference", "")).split(" ")[0] for r in occt_only if "occt_vs_reference" in r).items())),
        "match_plus_normalized_share": share,
        "normalized_share": classes.get("NORMALIZED", 0) / max(1, len(rows)),
        "potential_silent_wrong": psw,
        "potential_silent_wrong_flags": dict(Counter(
            f.split(":")[0].split(" ")[0] for r in rows for f in r.get("potential_silent_wrong", []))),
        "reference_checked": sum(1 for r in rows if r.get("reference") in ("ok", "MISMATCH")),
        "forge_only_unadjudicated": classes.get("FORGE_ONLY_UNADJUDICATED", 0),
        "at_max": dict(sorted(at_max.items())),
        "at_max_adjudication": dict(sorted(Counter(r["at_max_adjudication"] for r in rows if "at_max_adjudication" in r).items())),
        "closed_form_checked": sum(1 for r in rows if "closed_form" in r),
        "interference_unverified": sum(1 for r in rows if r.get("interference") == "unverified"),
        "occt_only_codes": dict(sorted(Counter(r["forge"] for r in occt_only).items())),
    }


def is_obstacle(forge: dict) -> bool:
    """Forge's `*_FAILED` for a blend that runs into another feature of the body (W6 review
    round 6: a capability gap — SPEC §6.6 defines the rolling ball there —, no longer a
    `*_TOO_LARGE`)."""
    reason = str((forge.get("details") or {}).get("reason", ""))
    return str(forge.get("code", "")).endswith("_FAILED") and "another feature" in reason


def gap_kind(r: dict) -> str:
    """What closes an OCCT_ONLY row: a Contract **ruling** (Forge's `*_TOO_LARGE` where OCCT
    builds colliding walls or a value past a limit; a `*_FAILED` Forge states awaits a Contract
    ruling — the chamfer corners SPEC §6.7 does not define), Forge **capability** (any other
    `*_FAILED`, e.g. a blend trimmed around another feature), or other."""
    code = str(r.get("forge", ""))
    if code.endswith("_TOO_LARGE"):
        return "ruling"
    if code.endswith("_FAILED"):
        return "ruling" if "Contract ruling" in str(r.get("forge_reason", "")) else "capability"
    return "other"


#: Summary fields `--expect` pins.
PINNED = ("cases", "classes", "forge_valid", "occt_valid", "potential_silent_wrong", "gap", "unadjudicated",
          "match_plus_normalized_share")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("batch")
    ap.add_argument("--out")
    ap.add_argument("--only", help="substring of case ids to run")
    ap.add_argument("--baseline", help="a previous --out report: fail if Forge's validity drops or silent-wrong grows")
    ap.add_argument("--reference-all", action="store_true", help="check every Forge body the independent reference covers, not only the rows OCCT disagrees on")
    ap.add_argument("--expect", help="expected-summary.json: fail when the pinned fields of this seed's summary differ")
    ap.add_argument("--seed", help="the batch's seed (with --expect)")
    args = ap.parse_args()
    rows = []
    with open(args.batch) as fh:
        for line in fh:
            case = json.loads(line)
            if args.only and args.only not in case["id"]:
                continue
            try:
                row = compare(case, args.reference_all)
            except Exception as ex:  # noqa: BLE001 - one case's script failure fails the gate, not the run
                import traceback
                row = {"id": case["id"], "family": case["family"], "op": case["op"], "select": case["select"],
                       "cls": "SCRIPT_ERROR", "note": f"{type(ex).__name__}: {ex}"[:300],
                       "forge": case["forge"]["status"] if case["forge"]["status"] == "ok" else case["forge"]["code"]}
                traceback.print_exc()
            rows.append(row)
            if row["cls"] not in ("MATCH",) or row.get("potential_silent_wrong"):
                extra = "; ".join(row.get("potential_silent_wrong", []))
                print(f"{row['cls']:24} {row['id']:30} {row['op']['kind']:8} {row.get('forge','')!s:26} {row.get('occt','')!s:14} {row.get('note','')} {extra}", file=sys.stderr)
    summary = summarize(rows)
    print(json.dumps(summary, indent=2))
    if args.out:
        with open(args.out, "w") as fh:
            json.dump({"summary": summary, "rows": rows}, fh, indent=1)
    failures = []
    if summary["potential_silent_wrong"] > 0:
        failures.append(f"{summary['potential_silent_wrong']} potential silent-wrong case(s)")
    if summary["classes"].get("SCRIPT_ERROR"):
        failures.append(f"{summary['classes']['SCRIPT_ERROR']} case(s) the script could not compare")
    if not summary["validity_ge_occt"]:
        g = summary["gap"]
        failures.append(
            f"validity below OCCT ({summary['forge_valid']} < {summary['occt_valid']}; "
            f"{g['needs_ruling']} need a Contract ruling, {g['needs_capability']} Forge capability, {g['other']} other)"
        )
    if summary["unadjudicated"]["total"] > 0:
        failures.append(f"{summary['unadjudicated']['total']} Forge bodies without an independent verdict: {summary['unadjudicated']}")
    if not summary["match_plus_normalized_ge_99"]:
        failures.append(f"MATCH + NORMALIZED {summary['match_plus_normalized_share']} < 99 % of the programs both engines build")
    if not summary["normalized_le_5"]:
        failures.append("NORMALIZED above 5 % of the programs")
    if args.baseline:
        with open(args.baseline) as fh:
            base = json.load(fh)["summary"]
        if summary["forge_valid"] < base["forge_valid"]:
            failures.append(f"Forge validity regressed ({summary['forge_valid']} < {base['forge_valid']})")
        if summary["potential_silent_wrong"] > base["potential_silent_wrong"]:
            failures.append("more potential silent-wrong cases than the baseline")
    if args.expect:
        with open(args.expect) as fh:
            pinned = json.load(fh)["seeds"][str(args.seed)]["summary"]
        for k in PINNED:
            if summary.get(k) != pinned.get(k):
                failures.append(f"summary field {k!r} differs from the pinned one: {summary.get(k)} vs {pinned.get(k)}")
    for f in failures:
        print(f"GATE FAILED: {f}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
