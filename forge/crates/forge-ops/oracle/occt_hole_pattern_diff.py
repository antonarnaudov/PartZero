#!/usr/bin/env python3
"""Differential oracle: forge-ops holes and patterns (W5) vs OCCT.

CI/dev tooling only (OCCT is LGPL; never a runtime dependency of Forge).

Usage (from the repository's ``oracle/`` directory, which has uv + OCP)::

    # from forge/: write Forge's side
    HOLE_PATTERN_BATCH_OUT=/tmp/hp7.jsonl HOLE_PATTERN_SEED=7 HOLE_PATTERN_COUNT=320 \\
      cargo test --release -p forge-ops --test hole_pattern_oracle -- --ignored --nocapture
    # from oracle/:
    uv run python ../forge/crates/forge-ops/oracle/occt_hole_pattern_diff.py /tmp/hp7.jsonl \\
      [/tmp/hp8.jsonl …] --out /tmp/hp7.json [--gate] [--up-to-rule open|never|warn] \\
      [--zero-instances open|noop|fail] [--tip-rule open|vertex|breaks]

``--gate`` (for the oracle CI / nightly job, W7b/W11) exits 1 on **any**
POTENTIAL_SILENT_WRONG (a tracked one included: CLAUDE.md, a silent-wrong result found by the
oracle blocks a release), on any ``OCCT_WRONG`` that neither the exact adjudication decided
(``exact_adjudicate``: Forge within the §8.2 tolerances of an estimate from the analytic
operands) nor ``OCCT_WRONG_REVIEWED`` lists (a fixed case with an exact Rust closed-form test
pinning Forge's value; review 6: the Monte Carlo band alone is far looser than §8.2), or when a
``--gate-families`` family (default: every generated
family — ``pattern/plan``, ``pattern/extra``, ``pattern/tilted``, ``pattern/crossing``,
``hole``, ``golden``, ``curved`` — and all generated pattern families pooled, the plan's
"generated pattern corpus") is below ``--min-rate`` (0.995) MATCH. Only ``OPEN_CONTRACT`` cases
(questions the SPEC leaves open, ``RULES``) are left out of a gated rate; ``EXPLICIT_CONTRACT``
cases (Forge fails explicitly where the SPEC's reading gives a body) count as non-matches
unless ``--gate-exclude-explicit``. The summary's ``f1`` block is the plan's F1 view over every
generated family (fixed cases excluded), and a per-family table closes the output.

Several batches are pooled into one summary (per family and pattern sub-family: ``plan`` — the
in-plane families of the W5 plan —, ``extra`` — the same with pattern-scope targets that differ
from the seed's —, ``tilted`` and ``crossing``).

Everything on the oracle side is computed from the SPEC, independently of Forge:

* the plate (and every v0 seed operand) is rebuilt with the oracle's own v0 evaluator;
* hole dimensions are resolved from ``HOLE_SIZES`` in ``ir-v1.constants.json`` by the rules of
  SPEC §6.5 / [W0-10] (``d``, else the insert bore, else the tap drill when threaded or
  ``fit: tap``, else the ISO 273 series of ``fit``; presets from the table);
* positions come from the placement form (``list``, ``grid``, ``circle``: SPEC §6.5 formulas)
  in the face frame of SPEC §3.1 (top: x = X, y = Y, n = +Z; bottom: x = X, y = −Y, n = −Z),
  and the drilling direction is ``−n`` (``n`` with ``flip``);
* ``HOLE_POINT_OFF_FACE``: ``BRepExtrema`` distance from the position to the placement face
  greater than 1e-6;
* hole tools are revolved profiles (``BRepPrimAPI_MakeRevol`` of the SPEC §6.5 profile: top
  disc, counterbore or countersink, wall, 118°-style tip cone or flat floor), cut together
  with ``BRepAlgoAPI_Cut`` and unified with ``ShapeUpgrade_UnifySameDomain`` (the §8.3
  settings of the W4 script). A through tool's length is the oracle's own: past the farthest
  corner of the plate's box along ``d`` plus the box's whole diagonal plus 1 mm — not
  Forge's ``1 + 0.01·diag`` margin (the SPEC only says "long enough to leave every target";
  for a hole any such length gives the same body);
* ``up_to``: the first ``h ≥ 1e-6`` with ``P + h·d`` on the planar face, no angular cut-off
  (an axis exactly parallel to the plane never hits it; a nearly parallel one hits where the
  face test says); every position's miss (``HOLE_UP_TO_MISSED``) before the head check, which
  the shallowest position decides (``INVALID_VALUE`` at ``/cbore/depth`` or ``/cbore``, or
  ``/csink/d`` or ``/csink``, with the head's value — compared);
* ``HOLE_MISSES_BODY``: a position whose tool has no common volume with the plate (first in
  position order);
* ``HOLE_BREAKS_THROUGH`` (blind holes): some sample point of the tool's bottom (the tip
  cone's generators or the flat floor, 5 × 8 points) is not strictly inside the plate
  (``BRepClass3d_SolidClassifier``). ``up_to`` holes are sampled the same way (the W7b
  oracle's reading: a floor on a target face breaks through); Forge never warns for them.
  Open W5 contract question: ``--up-to-rule open`` (default) classifies such a case
  ``OPEN_CONTRACT``, ``never`` / ``warn`` apply one ruling;
* patterns: instances from the layout by SPEC §6.10 (linear ``i·spacing·u1 + j·spacing2·u2``,
  circular ``k·Δ`` about the axis, mirror ``gp_Trsf.SetMirror``) minus ``skip``; the seed's
  own operation first (cut, join, hole or nothing) on the plate, then the pattern-scope
  targets (the seed's result, and the case's ``extra`` block: fused under the plate, or a
  separate target), then every instance's tools; an instance is skipped when its tools have
  no common volume with any target (cut, hole) or are detached from it (join: distance >
  1e-6, or a fuse that does not give one solid); [W0-39] per tool: a join instance with one
  detached tool and one that meets is ``BOOLEAN_NO_INTERSECTION``; ``PATTERN_ALL_INSTANCES_FAILED``
  when every instance is skipped; one combined operation. A layout **without** non-seed
  instances (``count`` 1, or ``skip`` naming every instance) is Forge's no-op reading; the W7b
  oracle fails it (open W5 contract question: ``--zero-instances open`` (default) classifies it
  ``OPEN_CONTRACT``, ``noop`` / ``fail`` apply one ruling);
* copies of **through** hole tools are read as unbounded (SPEC §6.5 "long enough to leave
  every target"): each instance's through tool is rebuilt on the moved axis, long enough to
  pass the pattern-scope targets' box. Forge copies the seed's tool unchanged (§6.10 "as
  evaluated at the seed") and fails with ``FORGE_PATTERN_THROUGH_COPY_TOO_SHORT`` where that
  copy would not leave the targets; the oracle checks the claim independently (the cylinder
  of the hole's radius beyond Forge's reported ``length`` on the moved axis has common volume
  with a target) and classifies a justified error ``EXPLICIT_CONTRACT`` (the W5 contract
  question), an unjustified one ``CODE_MISMATCH``. Whenever Forge returns a body it must
  equal the unbounded reading (else ``POTENTIAL_SILENT_WRONG``).

Generation 3 of the batch writer adds (see ``tests/hole_pattern_oracle.rs``):

* **curved** plates (the plate minus a tilted cylinder, a cone whose axis is parallel to it, or
  an edge notch; or a z-cylinder minus a slanted half-space): one hole near the curved boundary
  (``HOLE_POINT_OFF_FACE`` with its distance, ``up_to`` the bottom), and 24 point–face probes —
  Forge's ``planar_face_distance`` against the ``BRepExtrema`` distance to the face, Forge's
  ``up_to_depth`` against ``ray_to_face``. A probe Forge puts on the face (or a ray it lets hit
  it) where OCCT does not is ``POTENTIAL_SILENT_WRONG``; other probe differences are
  ``PROBE_MISMATCH``;
* **golden**: every non-error case of ``corpus/v1/conformance/holes/tools.json`` on a
  40 × 40 × 20 plate, compared as a hole and, in addition, the removed volume of both engines
  against its closed form (``CLOSED_FORM_MISMATCH``);
* **crossing** patterns (a hole mirrored or rotated about a point of its own axis).

Generation 4 adds multi-tool pattern seeds (multi-position hole grids whose copies coincide
under the layout half the time; two-region cut and join seeds, ``docs``/``members``),
zero-instance layouts, and the deterministic **fixed** family (``fixed``: a name; sub-family
``fixed``, not in the generated rates): ``up_to`` the far face, zero instances, join instances
straddling the part's edge, coincident blind copies, and the W4 regression ``909#59``
(Forge's W5 tangent-contact guard fails it with ``BOOLEAN_NON_MANIFOLD``, like OCCT, until W4
fixes its own check), and since the fourth review the reviews' other W4 regressions
(``W4_TRACKED``: an SSI failure, an inconsistent face split with extra targets, a dense bolt
circle Forge calls non-manifold) and three section-type cases (``edge_types_*``) that the older
count normalization had misclassified.

Review 5 adds:

* the seed's own outcome on both sides (Forge's batch records the seed's error code, message
  and details; ``why`` names both; two seed failures match only with the same code, and a
  ``BOOLEAN_NON_MANIFOLD`` seed also by its probe);
* the oracle's own [R-3] contact tests (SPEC §6.0.3), which OCCT's booleans do not flag:
  two **tools touching** where the result pinches (``touching_tools``: join tools touching
  outside every target, cut tools touching in or on one, no third tool covering the point —
  seed 97 #71's tangent bosses) and a **cylindrical tool face tangent to a planar target
  face** along a ruling the tool face really has (``tangent_line_contact``: the oracle's side
  of W5's tangent-contact guard), both as ``BOOLEAN_NON_MANIFOLD``; a seed's own result is
  checked too;
* ``body_join`` seeds (a separate body built from ``doc`` and its cut / join ``parts``, whose
  copies are joined to the plate: the notched-rod cases);
* comparisons of **every** hole report field (``axis``, ``kind``, ``size``, ``cbore``,
  ``csink``, ``insert``, ``thread`` besides ``at``, ``center``, ``depth``, ``d``), of skipped
  instances as ``(index, code)`` pairs (also inside ``PATTERN_ALL_INSTANCES_FAILED``), and of
  error details when both engines raise the same code: a ``BOOLEAN_NON_MANIFOLD`` probe must lie
  within the §8.1 radius of OCCT's non-manifold edges or shared vertices (or of both touching
  shapes of the contact tests), a join's ``BOOLEAN_NO_INTERSECTION`` must name the same
  instance;
* drill points within tol of a face (``touching_tips``, the fixed ``tip_band_*`` cases): Forge
  fails them with ``BOOLEAN_NON_MANIFOLD`` at the apex ([R-3]), this oracle's cut gives a body
  that warns ``HOLE_BREAKS_THROUGH``; open W5 contract question, ``--tip-rule open`` (default:
  ``OPEN_CONTRACT``), ``vertex`` or ``breaks``;
* two named count classes: ``UNMERGED_SAME_DOMAIN`` (Forge's result has an edge between two
  faces on one carrier — the batch's per-body ``unmerged`` count; a §6.0.4 W4 defect) and
  ``COUNT_PINCHED_FACE`` (OCCT has faces pinched at a vertex, which Forge splits per lobe: seed
  41 #79; a W5 contract issue). Both are non-matches;
* an **adjudication** of volume disagreements (``adjudicate``): the volume the operation
  changes, estimated by Monte Carlo against the targets and the primitive tool solids (no
  boolean of the operation involved), decides between the engines; ``OCCT_WRONG`` (Forge
  agrees with the estimate, OCCT does not: seed 131 #169, a Steinmetz crossing where OCCT's cut
  removes 16.6 mm³ too little and Forge the closed form) is a non-match but not
  ``POTENTIAL_SILENT_WRONG``; an undecided disagreement stays ``POTENTIAL_SILENT_WRONG``.
  Since review 6 the Monte Carlo estimate is only a triage: where every operand is the
  plate box or a hole tool (holes, golden, hole-seed patterns without ``extra``),
  ``exact_adjudicate`` decides first, from the analytic operands (exact membership of the
  box and of the tools as solids of revolution; surface quadrature at 0.002 and 0.001 mm of
  the removed volume — divergence theorem — and the area change), and an ``OCCT_WRONG`` needs
  Forge within the §8.2 tolerances of it; any other ``OCCT_WRONG`` fails ``--gate`` unless its
  (fixed) case is in ``OCCT_WRONG_REVIEWED`` with a closed-form Rust test.

Review 6 adds:

* **pinches at a vertex** of one OCCT solid (``pinch_vertices``: the faces around a vertex form
  two or more fans), which ``W4.non_manifold`` misses — seed 313 #73 (a copied wall's top
  ruling reaching the seed's counterbore floor, wall and the copy's shoulder at one point:
  two horns joined there) and the second, symmetric point of #31. OCCT's topology is not
  evidence on its own (#249 has two fans where the material around the vertex is one wedge),
  so each candidate is decided on the operands (``pinch_verdict``: two solids of material or
  of space reaching the vertex inside a small ball — confirmed; one region each on small
  spheres — refuted; else undecided, kept). Confirmed and undecided pinches join the
  non-manifold set: the oracle's ``BOOLEAN_NON_MANIFOLD`` and the probe matching. OCCT's own
  edges in more than two faces are checked the same way (``edge_refuted``: one region of
  material and one of space on small spheres about three points of the edge): seeds 419 #275
  and 521 #267, flat-bottomed blind holes rotated about a point of their axis, where OCCT's
  cut has such an edge in a manifold region — and the wrong volume or area;
* the **exact adjudication** (``exact_adjudicate``) of volume and area disagreements for
  holes and hole-seed patterns, and ``--gate`` fails on an ``OCCT_WRONG`` row it did not
  decide unless the case is in ``OCCT_WRONG_REVIEWED``;
* the fixed cases ``join_detached_first_313_37`` (a detached join copy before the join's own
  non-manifold failure), ``pinch_vertex_313_73``, ``pinch_vertex_313_31``,
  ``pinch_refuted_313_249``, ``occt_wrong_419_275`` and ``occt_wrong_521_267``.

A preset whose size has no table value is ``HOLE_OPTIONS_CONFLICT`` (SPEC §6.5).

Compared (classes as in the W4 script): status and code (and the details above), skipped
instances, the report's hole entries, break-through positions, number of bodies, per body volume and area
(relative 1e-6), validity, and faces / edges / ``face_types`` / ``edge_types`` by the current
SPEC §8.3 (``v1_counts``: the W7b oracle's rule 1 and its rule-3 section typing of [W0-52] —
since review 4; the W4 script's older normalizations typed OCCT's native conics for unlisted
pairs, such as a cone and its mirror image, as conics and blamed Forge for ``bspline``), the
literal and W4-script counts reported alongside. Bodies are paired as
SPEC §8.2 says: canonical order (§5.4: centroids compared coordinate by coordinate with
tolerance ``LINEAR_TOLERANCE·s``), then nearest centroid, greedily — not by sorting exact
centroids, which paired the wrong bodies when rounding swapped two centroids that agree in a
coordinate (review case #81). Forge's engine-prefixed warnings (``FORGE_PATTERN_HOLE_*``,
``FORGE_HOLE_THREAD_DEEPER_THAN_HOLE``) are not compared (§8.2).
"""

from __future__ import annotations

import argparse
import functools
import json
import math
import os
import sys
from collections import Counter

from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakePolygon,
    BRepBuilderAPI_MakeVertex,
    BRepBuilderAPI_Transform,
)
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepPrimAPI import BRepPrimAPI_MakeRevol
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Plane
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.TopAbs import TopAbs_FACE, TopAbs_IN
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_ListOfShape
from OCP.gp import gp_Ax1, gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import occt_boolean_diff as W4  # noqa: E402  (the W4 script's builders and §8.3 counts)
from aicad_oracle import occt as O  # noqa: E402

REL = 1e-6
TOL = 1e-6
HERE = os.path.dirname(os.path.abspath(__file__))
CONSTANTS = os.path.join(HERE, "..", "..", "forge-ir", "schema", "ir-v1.constants.json")
SIZES = json.load(open(CONSTANTS))["HOLE_SIZES"]["sizes"]


def table(size: str, key: str):
    v = SIZES[size].get(key)
    return None if v is None else v["value"]


# ---------------------------------------------------------------------------------------------
# Holes (SPEC §6.5)
# ---------------------------------------------------------------------------------------------


class Reject(Exception):
    def __init__(self, code: str, at: str | None = None, **extra):
        super().__init__(code)
        self.code = code
        self.at = at
        self.extra = extra


def resolve(h: dict) -> dict:
    """Tool numbers of a hole's fields, from HOLE_SIZES (SPEC §6.5, [W0-10]).

    A preset whose size has no table value is ``HOLE_OPTIONS_CONFLICT`` (SPEC §6.5 "A preset that
    needs a missing value is rejected for that size")."""
    size = h.get("size")
    for key, keys in (("cbore", ("cbore_d", "cbore_depth")), ("csink", ("csink_d",)),
                      ("insert", ("insert_d", "insert_depth"))):
        if isinstance(h.get(key), str) and (size is None or any(table(size, k) is None for k in keys)):
            raise Reject("HOLE_OPTIONS_CONFLICT")
    thread = h.get("thread") not in (None, False)
    insert = None
    if "insert" in h:
        if h["insert"] == "std":
            insert = (table(size, "insert_d"), table(size, "insert_depth"))
        else:
            insert = (h["insert"]["d"], h["insert"]["depth"])
    if "d" in h:
        d = h["d"]
    elif insert:
        d = insert[0]
    elif thread or h.get("fit") == "tap":
        d = table(size, "tap")
    else:
        d = table(size, h.get("fit", "normal"))
    cbore = csink = None
    if "cbore" in h:
        c = h["cbore"]
        cbore = (table(size, "cbore_d"), table(size, "cbore_depth")) if c == "iso4762" else (c["d"], c["depth"])
    if "csink" in h:
        c = h["csink"]
        csink = (table(size, "csink_d"), 90.0) if c == "iso10642" else (c["d"], c.get("angle", 90.0))
    depth = h.get("depth")
    if insert:
        depth = {"blind": insert[1]}
    tip = h.get("tip", 118.0)
    blind = isinstance(depth, dict) and "blind" in depth
    up_to = isinstance(depth, dict) and "up_to" in depth
    if not blind or insert:
        tip = "flat"
    return {"d": d, "cbore": cbore, "csink": csink, "insert": insert,
            "depth": depth if blind else ("up_to" if up_to else "through"), "tip": tip}


def deg_sin_cos(a: float) -> tuple[float, float]:
    """SPEC §2.7 rule 4 degree trigonometry (exact at multiples of 30° and 45°)."""
    r = a % 360.0
    q = int(r // 90.0)
    s = r - 90.0 * q
    table_ = {0.0: (0.0, 1.0), 30.0: (0.5, 0.8660254037844386),
              45.0: (0.7071067811865476, 0.7071067811865476), 60.0: (0.8660254037844386, 0.5)}
    ss, cs = table_.get(s, (math.sin(math.radians(s)), math.cos(math.radians(s))))
    sn, cn = [(ss, cs), (cs, -ss), (-ss, -cs), (-cs, ss)][q]
    return sn + 0.0, cn + 0.0


def positions(at: dict) -> list[tuple[str, float, float]]:
    if "list" in at:
        return [(p["id"], p["at"][0], p["at"][1]) for p in at["list"]]
    if "grid" in at:
        g = at["grid"]
        cx, cy = g.get("center", [0, 0])
        nx, ny = int(g["nx"]), int(g["ny"])
        return [
            (f"g{i}_{j}", cx + (i - (nx - 1) / 2) * g["dx"], cy + (j - (ny - 1) / 2) * g["dy"])
            for i in range(nx) for j in range(ny)
        ]
    c = at["circle"]
    cx, cy = c.get("center", [0, 0])
    n = int(c["n"])
    out = []
    for k in range(n):
        s, co = deg_sin_cos(c.get("start", 0.0) + (360.0 * k) / n)
        out.append((f"c{k}", cx + c["d"] / 2 * co, cy + c["d"] / 2 * s))
    return out


def face_frame(top: bool, t: float):
    if top:
        return (0.0, 0.0, t), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)
    return (0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, -1.0, 0.0), (0.0, 0.0, -1.0)


def add(*vs):
    return tuple(sum(c) for c in zip(*vs))


def mul(v, s):
    return tuple(c * s for c in v)


def tan_half(a: float) -> float:
    s, c = deg_sin_cos(0.5 * a)
    return s / c


def profile(r: dict, h: float, through: bool) -> list[tuple[float, float]]:
    """(ρ, y) polygon of the tool profile (SPEC §6.5), starting on the axis at the top."""
    rr = r["d"] / 2
    pts = [(0.0, 0.0)]
    if r["cbore"]:
        rc, hc = r["cbore"][0] / 2, r["cbore"][1]
        pts += [(rc, 0.0), (rc, hc), (rr, hc)]
    elif r["csink"]:
        rk = r["csink"][0] / 2
        pts += [(rk, 0.0), (rr, (rk - rr) / tan_half(r["csink"][1]))]
    else:
        pts += [(rr, 0.0)]
    pts.append((rr, h))
    if through or r["tip"] == "flat":
        pts.append((0.0, h))
    else:
        pts.append((0.0, h + rr / tan_half(r["tip"])))
    return pts


def revolve(p0, e, d, prof):
    poly = BRepBuilderAPI_MakePolygon()
    for rho, y in prof:
        q = add(p0, mul(e, rho), mul(d, y))
        poly.Add(gp_Pnt(*q))
    poly.Close()
    face = BRepBuilderAPI_MakeFace(poly.Wire(), True).Face()
    return BRepPrimAPI_MakeRevol(face, gp_Ax1(gp_Pnt(*p0), gp_Dir(*d)), 2 * math.pi).Shape()


def cut_many(target, tools, op: str = "cut"):
    """``op`` of the target (one shape, or a list of shapes) by the tools, unified."""
    args = TopTools_ListOfShape()
    for t in target if isinstance(target, list) else [target]:
        args.Append(t)
    tl = TopTools_ListOfShape()
    for t in tools:
        tl.Append(t)
    algo = {"cut": BRepAlgoAPI_Cut, "join": BRepAlgoAPI_Fuse}[op]()
    algo.SetArguments(args)
    algo.SetTools(tl)
    algo.SetRunParallel(False)
    algo.SetNonDestructive(True)
    algo.Build()
    if not algo.IsDone():
        raise RuntimeError("OCCT boolean failed")
    usd = ShapeUpgrade_UnifySameDomain(algo.Shape(), True, True, False)
    usd.SetLinearTolerance(1e-6)
    usd.SetAngularTolerance(1e-9)
    usd.Build()
    return usd.Shape()


def common_volume(a, b) -> float:
    c = BRepAlgoAPI_Common(a, b)
    return W4.volume(c.Shape()) if c.IsDone() else 0.0


def box_of(shape):
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    b = Bnd_Box()
    BRepBndLib.Add_s(shape, b)
    return b.Get()


def box_gap(a, b) -> float:
    return max(0.0, max(max(a[k] - b[k + 3], b[k] - a[k + 3]) for k in range(3)))


def state_of(solid, q, tol: float = 1e-7):
    """``IN`` / ``ON`` / ``OUT`` of the point ``q`` against a solid (classifier tolerance
    ``tol``)."""
    from OCP.TopAbs import TopAbs_ON
    cls = BRepClass3d_SolidClassifier(solid)
    cls.Perform(gp_Pnt(*q), tol)
    st = cls.State()
    return "IN" if st == TopAbs_IN else "ON" if st == TopAbs_ON else "OUT"


def touching_tools(targets, tools, op: str):
    """Review 5 (the oracle's own [R-3] contact test for tools, SPEC §6.0.3): a point where two
    tools touch — within tol, without common volume — that no third tool covers (strictly
    inside it) and where the result therefore touches itself: for a ``join``, outside every
    target (not strictly inside one: the union pinches there); for a ``cut``, in or on a
    target (the material between the two tools pinches). ``(i, j, point)`` or None. OCCT's
    booleans leave such contacts without a shared edge, so ``W4.non_manifold`` misses them
    (seed 97 #71: two join bosses tangent along a vertical line above the plate)."""
    boxes = [box_of(t) for t in tools]
    for i in range(len(tools)):
        for j in range(i + 1, len(tools)):
            if box_gap(boxes[i], boxes[j]) > TOL:
                continue
            dist = BRepExtrema_DistShapeShape(tools[i], tools[j])
            if not dist.IsDone() or dist.Value() > TOL or common_volume(tools[i], tools[j]) > 1e-9:
                continue
            for k in range(1, dist.NbSolution() + 1):
                p = dist.PointOnShape1(k)
                q = (p.X(), p.Y(), p.Z())
                if any(state_of(tools[m], q) == "IN" for m in range(len(tools)) if m not in (i, j)):
                    continue
                states = [state_of(t, q) for t in targets]
                pinch = all(x != "IN" for x in states) if op == "join" else any(x != "OUT" for x in states)
                if pinch:
                    return i, j, q
    return None


def faces_of(shape) -> list:
    out = []
    ex = TopExp_Explorer(shape, TopAbs_FACE)
    while ex.More():
        out.append(TopoDS.Face_s(ex.Current()))
        ex.Next()
    return out


def point_dist(q, shape) -> float:
    return BRepExtrema_DistShapeShape(BRepBuilderAPI_MakeVertex(gp_Pnt(*q)).Vertex(), shape).Value()


def tangent_line_contact(targets, tools, op: str):
    """Review 5, the oracle's side of W5's tangent-contact guard (SPEC §6.0.3): a cylindrical
    tool face whose axis is parallel to a planar target face at distance ``r`` on the
    conflicting side (``join``: the tool outside the target; ``cut``: inside), with a point of
    that ruling — one of 63 samples over the face's axial range — on the tool face (within
    tol: the face really has the ruling there), in the target face's interior (on it, farther
    than tol from its edges) and inside no other tool: the result touches itself along the
    line. ``(tool face, target face, point)`` or None. OCCT's booleans leave such a line
    without an edge, so ``W4.non_manifold`` misses it."""
    from OCP.GeomAbs import GeomAbs_Cylinder
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_REVERSED
    planes = []
    for g in targets:
        for f in faces_of(g):
            srf = BRepAdaptor_Surface(f)
            if srf.GetType() != GeomAbs_Plane:
                continue
            pl = srf.Plane()
            a = pl.Axis().Direction()
            n = (a.X(), a.Y(), a.Z())
            if f.Orientation() == TopAbs_REVERSED:
                n = mul(n, -1.0)
            loc = pl.Location()
            planes.append((n, sum(n[i] * (loc.X(), loc.Y(), loc.Z())[i] for i in range(3)), f))
    for k, t in enumerate(tools):
        for f in faces_of(t):
            srf = BRepAdaptor_Surface(f)
            if srf.GetType() != GeomAbs_Cylinder:
                continue
            cyl = srf.Cylinder()
            ax = cyl.Axis()
            z = (ax.Direction().X(), ax.Direction().Y(), ax.Direction().Z())
            o = (ax.Location().X(), ax.Location().Y(), ax.Location().Z())
            r = cyl.Radius()
            v0, v1 = srf.FirstVParameter(), srf.LastVParameter()
            for n, c, pf in planes:
                if abs(sum(z[i] * n[i] for i in range(3))) > 1e-9:
                    continue
                h = sum(n[i] * o[i] for i in range(3)) - c
                if abs(h - (r if op == "join" else -r)) > TOL:
                    continue
                edges = []
                ex = TopExp_Explorer(pf, TopAbs_EDGE)
                while ex.More():
                    edges.append(ex.Current())
                    ex.Next()
                for i in range(1, 64):
                    q = add(o, mul(z, v0 + (v1 - v0) * i / 64), mul(n, -h))
                    if point_dist(q, f) > TOL or point_dist(q, pf) > TOL:
                        continue
                    if min(point_dist(q, e) for e in edges) <= TOL:
                        continue
                    if any(state_of(tools[m], q) == "IN" for m in range(len(tools)) if m != k):
                        continue
                    return f, pf, q
    return None


def pinch_vertices(solid) -> list:
    """Review 6: vertices where one OCCT solid touches itself at a point — the faces around the
    vertex do not form one fan. Every use of the vertex by a face's wire (the two wire edges
    meeting there: a **corner**) is a node; two corners are adjacent when they share an edge
    at that vertex (a manifold edge is in two corners there; a seam or degenerated edge joins
    two corners of one face). Around a manifold vertex the corners form one cycle; two or more
    components mean two wedges of material meet only at the vertex (seed 313 #73: the copied
    wall's top ruling reaches the seed's counterbore floor, wall and the copy's shoulder at one
    point, leaving two horns joined there), which ``W4.non_manifold`` misses (no edge with
    three faces, one solid). A face pinched at a vertex of a manifold solid (seed 41 #79) has
    two corners there that the other faces join into one cycle: not reported. Returns the
    vertex positions."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepTools import BRepTools_WireExplorer
    from OCP.TopAbs import TopAbs_WIRE

    corners = []  # (vertex, [edges])
    for f in faces_of(solid):
        wx = TopExp_Explorer(f, TopAbs_WIRE)
        while wx.More():
            we = BRepTools_WireExplorer(TopoDS.Wire_s(wx.Current()), f)
            seq = []
            while we.More():
                seq.append((TopoDS.Edge_s(we.Current()), we.CurrentVertex()))
                we.Next()
            for k, (e, v) in enumerate(seq):
                prev = seq[k - 1][0]
                corners.append((v, [prev, e]))
            wx.Next()
    # Group corners by vertex (IsSame), then union corners sharing an edge.
    groups = []  # [vertex, [corner indices]]
    for i, (v, _) in enumerate(corners):
        for g in groups:
            if g[0].IsSame(v):
                g[1].append(i)
                break
        else:
            groups.append([v, [i]])
    out = []
    for v, idx in groups:
        if len(idx) < 2:
            continue
        parent = {i: i for i in idx}

        def find(i, parent=parent):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        for a in range(len(idx)):
            for b in range(a + 1, len(idx)):
                ea, eb = corners[idx[a]][1], corners[idx[b]][1]
                if any(x.IsSame(y) for x in ea for y in eb):
                    parent[find(idx[a])] = find(idx[b])
        if len({find(i) for i in idx}) > 1:
            p = BRep_Tool.Pnt_s(TopoDS.Vertex_s(v))
            out.append((p.X(), p.Y(), p.Z()))
    return out


def non_manifold_set(solids, targets=None, tools=None, op: str = "cut") -> dict:
    """Where OCCT's result touches itself (``W4.non_manifold``'s tests, all of them): the edges
    used by more than two faces and the vertex positions two solids share — for matching
    Forge's ``probe`` (SPEC §8.1) — and (review 6) the vertices where one solid touches itself
    at a point (``pinch_vertices``) that the operands do not refute (``pinch_verdict``; without
    the operands every candidate counts)."""
    from OCP.BRep import BRep_Tool
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_VERTEX
    edges, points = [], []
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
                edges.append(e)
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
                points.append(pts[i][1:])
    # Review 6: OCCT's topology alone is not evidence — seed 313 #249 has a vertex with two
    # fans (the shoulder circles of a hole and its mirror image crossing on the mirror plane)
    # where the material around it is one wedge, seeds 419 #275 and 521 #267 an edge in more
    # than two faces with one region of material around it. Each candidate is decided on the
    # operands; a refuted one is recorded, not reported.
    pinches, verdicts, refuted_edges = [], [], []
    for s in solids:
        for q in pinch_vertices(s):
            v = pinch_verdict(q, targets, tools, op) if targets is not None else "undecided"
            verdicts.append((q, v))
            if v != "refuted":
                pinches.append(q)
    if targets is not None:
        kept = []
        for e in edges:
            (refuted_edges if edge_refuted(e, targets, tools, op) else kept).append(e)
        edges = kept
    return {"edges": edges, "points": points + pinches, "pinches": pinches, "pinch_verdicts": verdicts,
            "edges_refuted": refuted_edges}


def _ball(q, r):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeSphere
    return BRepPrimAPI_MakeSphere(gp_Pnt(*q), r).Shape()


def local_material(q, radius: float, targets, tools, op: str) -> list:
    """The operation's material within the ball of ``radius`` about ``q``, from the operands
    (targets and tools cut to the ball, then the operation) — no boolean of the whole
    operation involved: its solids."""
    ball = _ball(q, radius)
    pieces = [x for t in targets for x in W4.solids_of(BRepAlgoAPI_Common(t, ball).Shape())]
    near = [t for t in tools if box_gap(box_of(t), box_of(ball)) <= TOL]
    if op == "join":
        local = [x for t in near for x in W4.solids_of(BRepAlgoAPI_Common(t, ball).Shape())]
        if local:
            pieces = W4.solids_of(cut_many(pieces, local, "join")) if pieces else local
    elif near and pieces:
        pieces = W4.solids_of(cut_many(pieces, near, "cut"))
    return pieces


def one_disk_around(q, targets, tools, op: str) -> bool:
    """Review 6: is the result's boundary one disk around ``q`` at the scale of wedges? On
    spheres of radius 0.01 and 0.001 mm about ``q`` (a 120 × 240 latitude–longitude grid, 1.5°
    apart, each point classified against the targets and tools — no boolean involved) the
    material covers between 1 % and 99 % of the sphere in one connected region, and so does the
    rest. Two wedges touching along a line through ``q`` or at ``q`` alone give two regions;
    horns or wedges thinner than the grid, and cusps (a covered fraction outside [1 %, 99 %]),
    give ``False`` (not decided here)."""
    tcl = [BRepClass3d_SolidClassifier(t) for t in targets]
    kcl = [BRepClass3d_SolidClassifier(t) for t in tools]

    def inside(cls, p) -> bool:
        cls.Perform(gp_Pnt(*p), 1e-12)
        return cls.State() == TopAbs_IN

    def material(p) -> bool:
        in_t = any(inside(c, p) for c in tcl)
        if op == "join":
            return in_t or any(inside(c, p) for c in kcl)
        return in_t and not any(inside(c, p) for c in kcl)

    nlat, nlon = 120, 240
    for rho in (1e-2, 1e-3):
        grid = []
        for i in range(nlat):
            th = math.pi * (i + 0.5) / nlat
            row = []
            for j in range(nlon):
                ph = 2 * math.pi * j / nlon
                d = (math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th))
                row.append(material(add(q, mul(d, rho))))
            grid.append(row)
        frac = sum(map(sum, grid)) / (nlat * nlon)
        if not 0.01 <= frac <= 0.99:
            return False
        for want in (True, False):
            if _grid_components(grid, want) != 1:
                return False
    return True


def pinch_verdict(q, targets, tools, op: str) -> str:
    """Review 6: is the operation's result really pinched at the OCCT vertex ``q``
    (``pinch_vertices``)? Decided on the operands, never on OCCT's result:

    * ``"refuted"``: ``one_disk_around(q)`` (seed 313 #249: 61 % material, one region each, at
      both radii) — decided first, without any boolean;
    * ``"confirmed"``: within a ball about ``q`` (radius 0.3, 0.1, 0.03 or 0.01 mm) the material,
      or the space it leaves, falls into two or more solids that each reach ``q`` (within tol) —
      two wedges or horns meeting only at ``q`` (seed 313 #73's horns, too thin for the
      spheres: two solids at 0.3 and 0.1 mm);
    * ``"undecided"`` otherwise: kept as a pinch, so a Forge body there stays
      ``POTENTIAL_SILENT_WRONG`` for review."""
    if one_disk_around(q, targets, tools, op):
        return "refuted"
    for radius in (0.3, 0.1, 0.03, 0.01):
        try:
            mat = local_material(q, radius, targets, tools, op)
        except Exception:  # noqa: BLE001  (an OCCT failure decides nothing)
            continue
        void = W4.solids_of(cut_many([_ball(q, radius)], mat, "cut")) if mat else []
        v = BRepBuilderAPI_MakeVertex(gp_Pnt(*q)).Vertex()
        for part in (mat, void):
            touching = [x for x in part if BRepExtrema_DistShapeShape(v, x).Value() <= TOL]
            if len(touching) >= 2:
                return "confirmed"
    return "undecided"


def edge_refuted(e, targets, tools, op: str) -> bool:
    """Review 6: an OCCT edge with more than two faces that is not where the result touches
    itself: ``one_disk_around`` holds at the points 1/4, 1/2 and 3/4 along it (seeds 419 #275
    and 521 #267: flat-bottomed blind holes rotated about a horizontal axis through a point of
    their axis, where OCCT's result has an elliptic edge in three or four faces but the
    material around it is one region). A real non-manifold edge — two wedges along a line —
    shows two regions on every sphere about its points."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    c = BRepAdaptor_Curve(e)
    t0, t1 = c.FirstParameter(), c.LastParameter()
    for s in (0.25, 0.5, 0.75):
        p = c.Value(t0 + s * (t1 - t0))
        if not one_disk_around((p.X(), p.Y(), p.Z()), targets, tools, op):
            return False
    return True


def _grid_components(grid, want: bool) -> int:
    """Connected components of the cells equal to ``want`` on a latitude–longitude grid
    (longitude wraps; each polar row is one neighbourhood)."""
    nlat, nlon = len(grid), len(grid[0])
    seen = [[False] * nlon for _ in range(nlat)]
    n = 0
    for i0 in range(nlat):
        for j0 in range(nlon):
            if grid[i0][j0] != want or seen[i0][j0]:
                continue
            n += 1
            stack = [(i0, j0)]
            seen[i0][j0] = True
            while stack:
                i, j = stack.pop()
                nb = [(i, (j + 1) % nlon), (i, (j - 1) % nlon)]
                nb += [(i + 1, j)] if i + 1 < nlat else []
                nb += [(i - 1, j)] if i > 0 else []
                if i in (0, nlat - 1):
                    nb += [(i, k) for k in range(nlon)]
                for a, b in nb:
                    if grid[a][b] == want and not seen[a][b]:
                        seen[a][b] = True
                        stack.append((a, b))
    return n


def non_manifold_error(solids, tools=None, targets=None, op="cut"):
    """``BOOLEAN_NON_MANIFOLD`` of a result: OCCT's own non-manifold edges and shared vertices
    and (review 6) its vertices where one solid is pinched at a point, unless the operands
    refute the pinch; else two tools touching where the result pinches (``touching_tools``) or
    a tool wall along a target face (``tangent_line_contact``); None if none."""
    where = non_manifold_set(solids, targets, tools or [], op)
    if where["edges"] or where["points"]:
        if where["edges"]:
            from OCP.BRepAdaptor import BRepAdaptor_Curve
            c = BRepAdaptor_Curve(where["edges"][0])
            q = c.Value(0.5 * (c.FirstParameter() + c.LastParameter()))
            first = [q.X(), q.Y(), q.Z()]
        else:
            first = list(where["points"][0])
        return {"status": "error", "code": "BOOLEAN_NON_MANIFOLD", "probe": first, "where": where}
    if tools:
        hit = touching_tools(targets, tools, op)
        if hit is not None:
            i, j, q = hit
            return {"status": "error", "code": "BOOLEAN_NON_MANIFOLD", "probe": list(q),
                    "where": {"touch": (tools[i], tools[j]), "edges": [], "points": []}}
        line = tangent_line_contact(targets, tools, op)
        if line is not None:
            f, pf, q = line
            return {"status": "error", "code": "BOOLEAN_NON_MANIFOLD", "probe": list(q),
                    "where": {"touch": (f, pf), "edges": [], "points": []}}
    return None


def plate_face(plate, top: bool):
    ex = TopExp_Explorer(plate, TopAbs_FACE)
    best = None
    while ex.More():
        f = TopoDS.Face_s(ex.Current())
        s = BRepAdaptor_Surface(f)
        if s.GetType() == GeomAbs_Plane:
            ax = s.Plane().Axis().Direction()
            z = s.Plane().Location().Z()
            if abs(abs(ax.Z()) - 1) < 1e-12:
                if best is None or (top and z > best[0]) or (not top and z < best[0]):
                    best = (z, f)
        ex.Next()
    return best[1]


def bbox_far(shape, p0, d) -> tuple[float, float]:
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    b = Bnd_Box()
    BRepBndLib.Add_s(shape, b)
    x0, y0, z0, x1, y1, z1 = b.Get()
    corners = [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    far = max(0.0, max(sum((c[i] - p0[i]) * d[i] for i in range(3)) for c in corners))
    diag = math.dist((x0, y0, z0), (x1, y1, z1))
    return far, diag


def up_to_face(plate, which: str, top: bool):
    """The `up_to` face of the batch: the plate's opposite cap, or its side face at x = 0."""
    if which == "far":
        return plate_face(plate, not top)
    if which != "side":
        raise RuntimeError(f"unknown up_to face {which!r}")
    ex = TopExp_Explorer(plate, TopAbs_FACE)
    while ex.More():
        f = TopoDS.Face_s(ex.Current())
        s = BRepAdaptor_Surface(f)
        if s.GetType() == GeomAbs_Plane:
            ax = s.Plane().Axis().Direction()
            if abs(abs(ax.X()) - 1) < 1e-12 and abs(s.Plane().Location().X()) < 1e-9:
                return f
        ex.Next()
    raise RuntimeError("no side face at x = 0")


def ray_to_face(face, p, d) -> float | None:
    """First h >= 1e-6 with p + h·d on the planar face (within 1e-6), SPEC §6.5 `up_to`."""
    pl = BRepAdaptor_Surface(face).Plane()
    n = pl.Axis().Direction()
    nv = (n.X(), n.Y(), n.Z())
    o = pl.Location()
    den = sum(d[i] * nv[i] for i in range(3))
    if den == 0.0:
        return None
    h = sum(((o.X(), o.Y(), o.Z())[i] - p[i]) * nv[i] for i in range(3)) / den
    if not math.isfinite(h) or h < 1e-6:
        return None
    q = add(p, mul(d, h))
    dist = BRepExtrema_DistShapeShape(BRepBuilderAPI_MakeVertex(gp_Pnt(*q)).Vertex(), face)
    return h if dist.Value() <= TOL else None


def hole_tools(plate, hdef: dict, top: bool, flip: bool, t: float, up_to: str | None = None):
    """(resolved, [(id, point, tool, h, through)], d) — raises Reject for placement errors."""
    r = resolve(hdef)
    o, x, y, n = face_frame(top, t)
    d = n if flip else mul(n, -1.0)
    face = plate_face(plate, top)
    pos = positions(hdef["at"])
    seen = []
    out = []
    # Placement first (duplicates), then the face (SPEC §6.5 order of the checks).
    for pid, u, v in pos:
        p = add(o, mul(x, u), mul(y, v))
        if any(math.dist(p, q) <= TOL for q in seen):
            raise Reject("HOLE_DUPLICATE_POSITION", pid)
        seen.append(p)
    for (pid, _, _), p in zip(pos, seen):
        dist = BRepExtrema_DistShapeShape(BRepBuilderAPI_MakeVertex(gp_Pnt(*p)).Vertex(), face)
        if dist.Value() > TOL:
            raise Reject("HOLE_POINT_OFF_FACE", pid, distance=dist.Value())
    up_to_h = {}
    if r["depth"] == "up_to":
        # Every up_to miss first (position order), then the head check against the shallowest
        # position (the order Forge and the W7b oracle follow; W5 proposal for SPEC §6.5).
        for (pid, _, _), p in zip(pos, seen):
            h = ray_to_face(up_to_face(plate, up_to, top), p, d)
            if h is None:
                raise Reject("HOLE_UP_TO_MISSED", pid)
            up_to_h[pid] = h
        # The counterbore or countersink must end above the floor (SPEC §6.5 blind rule).
        top_h = 0.0
        if r["cbore"]:
            top_h = r["cbore"][1]
        elif r["csink"]:
            top_h = (r["csink"][0] - r["d"]) / 2 / tan_half(r["csink"][1])
        shallow = min(pos, key=lambda q: up_to_h[q[0]])[0]
        if up_to_h[shallow] - top_h <= TOL:
            # Reported at the head's field with the head's value, as for blind holes.
            if r["cbore"]:
                field = "/cbore" if hdef["cbore"] == "iso4762" else "/cbore/depth"
                value = r["cbore"][1]
            else:
                field = "/csink" if hdef["csink"] == "iso10642" else "/csink/d"
                value = r["csink"][0]
            raise Reject("INVALID_VALUE", None, field=field, value=value, shallowest=shallow)
    for (pid, _, _), p in zip(pos, seen):
        if r["depth"] == "up_to":
            h, through = up_to_h[pid], False
        elif r["depth"] == "through":
            # The oracle's own "long enough": past the box by its whole diagonal.
            far, diag = bbox_far(plate, p, d)
            h = far + diag + 1.0
            through = True
        else:
            h, through = r["depth"]["blind"], False
        out.append((pid, p, revolve(p, x, d, profile(r, h, through)), h, through))
    return r, out, d


def breaks_through(plate, r, p, d, e, h) -> bool:
    """Some bottom sample point of a blind tool is not strictly inside the plate."""
    rr = r["d"] / 2
    f_ = gp_Dir(*e)
    ev = (f_.X(), f_.Y(), f_.Z())
    w = (d[1] * ev[2] - d[2] * ev[1], d[2] * ev[0] - d[0] * ev[2], d[0] * ev[1] - d[1] * ev[0])
    tip = 0.0 if r["tip"] == "flat" else rr / tan_half(r["tip"])
    cls = BRepClass3d_SolidClassifier(plate)
    for k in range(5):
        f = k / 4
        for j in range(8):
            a = 2 * math.pi * j / 8
            rho = (1 - f) * rr
            q = add(p, mul(d, h + f * tip), mul(ev, rho * math.cos(a)), mul(w, rho * math.sin(a)))
            cls.Perform(gp_Pnt(*q), 1e-7)
            if cls.State() != TopAbs_IN:
                return True
    return False


def v1_counts(solid) -> tuple[int, int, dict, dict]:
    """(faces, edges, face_types, edge_types) of an OCCT solid by the current SPEC §8.3: the
    W7b oracle's rule 1 (``aicad_oracle.v1.normalize.normalized_topology``) and rule 3
    ([W0-43], [W0-49], [W0-51], [W0-52]: ``section_type`` — a line, circle or ellipse only for a
    listed face pair whose OCCT curve is within tol of that conic, else ``bspline``). Every edge
    is typed by its face pair: in these cases the construction edges (plate lines, hole-tool
    circles, extruded sketch lines and circles) all lie between listed pairs of their own conic,
    so this equals "section edges by rule 3, construction edges by their type"."""
    from aicad_oracle.v1.normalize import normalized_topology, section_type

    nt = normalized_topology(solid, edge_type=lambda e, fa, fb: section_type(e, fa, fb)[0])
    ft = Counter(O.face_type(g[0]) for g in nt.faces)
    et = Counter(nt.edge_types)
    return len(nt.faces), len(nt.edges), dict(sorted(ft.items())), dict(sorted(et.items()))


def pinched_faces(solid) -> int:
    """OCCT faces whose boundary passes through one vertex twice (a region pinched at a point,
    e.g. at the double point of a cone–cone intersection; review 5, seed 41 #79): Forge splits
    such a region into one face per lobe, and SPEC §6.0.4 / §8.3 do not say which count is
    right (W5 contract issue)."""
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_WIRE
    from OCP.TopExp import TopExp
    n = 0
    for f in faces_of(solid):
        pinched = False
        wx = TopExp_Explorer(f, TopAbs_WIRE)
        while wx.More() and not pinched:
            uses = []  # [vertex, uses by the wire's edge ends]
            ex = TopExp_Explorer(wx.Current(), TopAbs_EDGE)
            while ex.More():
                e = TopoDS.Edge_s(ex.Current())
                for v in (TopExp.FirstVertex_s(e), TopExp.LastVertex_s(e)):
                    for u in uses:
                        if u[0].IsSame(v):
                            u[1] += 1
                            break
                    else:
                        uses.append([v, 1])
                ex.Next()
            pinched = any(c > 2 for _, c in uses)
            wx.Next()
        n += pinched
    return n


def metrics_of(shape) -> list[dict]:
    out = []
    for s in W4.solids_of(shape):
        m = O.body_metrics(s, edge_recognition_rel=1e-7)
        m["_solid"] = s  # for ``precise`` (never serialized)
        diag = math.dist(m["bbox_min"], m["bbox_max"])
        # The W4 script's (pre-[W0-43]) normalizations: reported, no longer decisive.
        m["faces_n"], m["edges_n"], m["face_types_n"], m["edge_types_n"] = W4.normalized_counts(
            s, 1e-7 * max(1.0, diag)
        )
        m["faces_v1"], m["edges_v1"], m["face_types_v1"], m["edge_types_v1"] = v1_counts(s)
        m["pinched"] = pinched_faces(s)
        out.append(m)
    out.sort(key=lambda m: m["centroid"])
    return out


def oracle_hole(case: dict, plate, t: float) -> dict:
    hdef, top, flip = case["hole"], case["top"], case["flip"]
    try:
        r, tools, d = hole_tools(plate, hdef, top, flip, t, case.get("up_to"))
    except Reject as rj:
        return {"status": "error", "code": rj.code, "at": rj.at, **rj.extra}
    for pid, _, tool, _, _ in tools:
        if common_volume(plate, tool) <= 1e-9:
            return {"status": "error", "code": "HOLE_MISSES_BODY", "at": pid}
    shape = cut_many(plate, [x[2] for x in tools])
    touch = touching_tips(plate, r, tools, d)
    nm = non_manifold_error(W4.solids_of(shape), [x[2] for x in tools], [plate], "cut")
    if nm is not None:
        nm["touching_tips"] = touch
        return nm
    o, x, y, n = face_frame(top, t)
    notes, notes_up_to = [], []
    if isinstance(r["depth"], dict):  # blind holes (Forge's reading of HOLE_BREAKS_THROUGH)
        for pid, p, _, h, _ in tools:
            if breaks_through(plate, r, p, d, x, h):
                notes.append(pid)
    elif r["depth"] == "up_to":
        # The W7b oracle's reading: up_to holes are tested too (a floor on a target face is
        # open). Open W5 contract question; see ``--up-to-rule``.
        for pid, p, _, h, _ in tools:
            if breaks_through(plate, r, p, d, x, h):
                notes_up_to.append(pid)
    holes = [hole_report(hdef, r, pid, p, d, None if th else h) for pid, p, _, h, th in tools]
    return {"status": "ok", "bodies": metrics_of(shape), "holes": holes, "notes": notes,
            "notes_up_to": notes_up_to, "resolved": r, "touching_tips": touch,
            "_adjudicate": ("cut", [plate], [x[2] for x in tools]), "_hole_info": (r, tools, d)}


def hole_report(hdef: dict, r: dict, pid: str, p, d, depth) -> dict:
    """The report entry of one position (SPEC §6.5 "Report", [W0-16]): ``at``, ``center``,
    ``axis`` (= d), ``d``, ``depth`` (None for through), ``kind``, and ``size``, ``cbore``
    ``{d, depth}``, ``csink`` ``{d, angle}``, ``insert`` ``{d, depth}``, ``thread``
    ``{size?, pitch, depth}`` when present (a thread's pitch from the table unless given, its
    depth the given one or the hole's)."""
    kind = ("insert" if r["insert"] else "counterbore" if r["cbore"] else
            "countersink" if r["csink"] else "simple")
    out = {"at": pid, "center": list(p), "axis": list(d), "d": r["d"], "depth": depth, "kind": kind}
    if hdef.get("size") is not None:
        out["size"] = hdef["size"]
    if r["cbore"]:
        out["cbore"] = {"d": r["cbore"][0], "depth": r["cbore"][1]}
    if r["csink"]:
        out["csink"] = {"d": r["csink"][0], "angle": r["csink"][1]}
    if r["insert"]:
        out["insert"] = {"d": r["insert"][0], "depth": r["insert"][1]}
    th = hdef.get("thread")
    if th not in (None, False):
        th = th if isinstance(th, dict) else {}
        out["thread"] = {"pitch": th["pitch"] if "pitch" in th else table(hdef["size"], "pitch"),
                         "depth": th.get("depth", depth)}
        if hdef.get("size") is not None:
            out["thread"]["size"] = hdef["size"]
    return out


def touching_tips(plate, r, tools, d) -> list:
    """Blind drill-point tools whose apex lies within tol of the plate's boundary from the
    material's side (IN or ON; review 5, the tol band at the far face): the W5 contract
    question — by [R-3] the apex lies on the face and the result touches itself at a point
    (Forge: ``BOOLEAN_NON_MANIFOLD``, vertex), where this oracle's cut gives a body and
    ``HOLE_BREAKS_THROUGH`` (``--tip-rule``)."""
    if not isinstance(r["depth"], dict) or r["tip"] == "flat":
        return []
    out = []
    shell = TopExp_Explorer(plate, TopAbs_FACE)
    faces = []
    while shell.More():
        faces.append(shell.Current())
        shell.Next()
    for pid, p, _, h, _ in tools:
        a = add(p, mul(d, h + (r["d"] / 2) / tan_half(r["tip"])))
        v = BRepBuilderAPI_MakeVertex(gp_Pnt(*a)).Vertex()
        dist = min(BRepExtrema_DistShapeShape(v, f).Value() for f in faces)
        if dist <= TOL and state_of(plate, a, TOL) != "OUT":
            out.append(pid)
    return out


# ---------------------------------------------------------------------------------------------
# Patterns (SPEC §6.10)
# ---------------------------------------------------------------------------------------------


def instances(layout: dict, skip: list) -> list[tuple[list[int], gp_Trsf]]:
    skipped = {tuple(s) for s in skip}
    out = []
    if "linear" in layout:
        l = layout["linear"]
        u1 = l["dir"]
        n1 = math.hypot(*u1)
        u1 = [c / n1 for c in u1]
        two = "dir2" in l
        n2 = int(l.get("count2", 1))
        u2 = l.get("dir2", [0, 0, 0])
        m2 = math.hypot(*u2) or 1.0
        u2 = [c / m2 for c in u2]
        for i in range(int(l["count"])):
            for j in range(n2):
                if i == 0 and j == 0:
                    continue
                idx = [i, j] if two else [i]
                tv = [u1[k] * (i * l["spacing"]) + (u2[k] * (j * l.get("spacing2", 0)) if two else 0) for k in range(3)]
                tr = gp_Trsf()
                tr.SetTranslation(gp_Vec(*tv))
                out.append((idx, tr))
    elif "circular" in layout:
        c = layout["circular"]
        n = int(c["count"])
        delta = 360.0 / n if c["angle"] >= 360 else c["angle"] / (n - 1)
        for k in range(1, n):
            tr = gp_Trsf()
            tr.SetRotation(gp_Ax1(gp_Pnt(*c["origin"]), gp_Dir(*c["axis"])), math.radians(k * delta))
            out.append(([k], tr))
    else:
        m = layout["mirror"]
        tr = gp_Trsf()
        tr.SetMirror(gp_Ax2(gp_Pnt(*m["origin"]), gp_Dir(*m["normal"])))
        out.append(([1], tr))
    return sorted([x for x in out if tuple(x[0]) not in skipped], key=lambda x: x[0])


def moved(shape, tr):
    return BRepBuilderAPI_Transform(shape, tr, True).Shape()


def detached(target, tool) -> bool:
    d = BRepExtrema_DistShapeShape(target, tool)
    if d.Value() > TOL:
        return True
    if common_volume(target, tool) > 1e-9:
        return False
    return len(W4.solids_of(cut_many(target, [tool], "join"))) != 1


def pattern_setup(case: dict, plate, t: float) -> dict:
    """The seed's own operation on the plate and the pattern-scope targets.

    Returns ``{"status": "seed_failed", "code"}`` or ``{"status": "ok", "kind", "op",
    "seed_tools", "info", "targets"}``; ``info`` has one ``(pid, p, d, e, r, h, through)`` per
    hole seed tool (empty for other seeds)."""
    seed = case["seed"]
    kind = seed["kind"]
    info = []
    if kind == "hole":
        try:
            r, tools, d = hole_tools(plate, seed["hole"], True, False, t)
        except Reject as rj:
            return {"status": "seed_failed", "code": rj.code}
        seed_tools = [x[2] for x in tools]
        if any(common_volume(plate, x) <= 1e-9 for x in seed_tools):
            return {"status": "seed_failed", "code": "HOLE_MISSES_BODY"}
        target = W4.solids_of(cut_many(plate, seed_tools))
        nm = non_manifold_error(target, seed_tools, [plate], "cut")
        if nm is not None:
            return {"status": "seed_failed", "code": "BOOLEAN_NON_MANIFOLD", "probe": nm["probe"],
                    "where": nm["where"]}
        op = "cut"
        _, ex, _, _ = face_frame(True, t)
        info = [(pid, p, d, ex, r, h, th) for pid, p, _, h, th in tools]
    elif kind == "body_join":
        # Review 5: a body seed (a separate body, built from ``doc`` and its ``parts``) whose
        # copies are joined to the plate; the seed itself changes nothing.
        seed_tools = [composite(seed)]
        target, op = [plate], "join"
    else:
        # One tool per region (generation 4 two-region seeds: ``docs``).
        seed_tools = [W4.build(doc) for doc in seed.get("docs") or [seed["doc"]]]
        if kind == "new_body":
            target, op = [plate], None
        else:
            op = kind
            # [W0-39]: a join fails when any tool is detached; a cut when no tool meets.
            if op == "join" and any(detached(plate, x) for x in seed_tools):
                return {"status": "seed_failed", "code": "BOOLEAN_NO_INTERSECTION"}
            if op == "cut" and all(common_volume(plate, x) <= 1e-9 for x in seed_tools):
                return {"status": "seed_failed", "code": "BOOLEAN_NO_INTERSECTION"}
            target = W4.solids_of(cut_many(plate, seed_tools, op))
            # Review 5: the seed's own result may touch itself (seed 97 #71).
            nm = non_manifold_error(target, seed_tools, [plate], op)
            if nm is not None:
                return {"status": "seed_failed", "code": "BOOLEAN_NON_MANIFOLD", "probe": nm["probe"],
                        "where": nm["where"]}
    if len(target) != 1:
        return {"status": "seed_failed", "code": "SPLIT"}
    targets = [target[0]]
    extra = case.get("extra")
    if extra is not None and op is not None:
        block = W4.build(extra["doc"])
        if extra["join"]:
            fused = W4.solids_of(cut_many(targets[0], [block], "join"))
            if len(fused) != 1:
                return {"status": "seed_failed", "code": "EXTRA_JOIN"}
            targets = fused
        else:
            targets = [targets[0], block]
    return {"status": "ok", "kind": kind, "op": op, "seed_tools": seed_tools, "info": info,
            "targets": targets}


def composite(seed: dict):
    """A ``body_join`` seed body: ``doc`` built, then each of ``parts`` (``{op, doc}``: cut or
    join) applied in order; one solid."""
    shape = W4.build(seed["doc"])
    for part in seed.get("parts", []):
        solids = W4.solids_of(cut_many(shape, [W4.build(part["doc"])], part["op"]))
        if len(solids) != 1:
            raise RuntimeError(f"the composite seed has {len(solids)} solids")
        shape = solids[0]
    return shape


def moved_axis(entry, tr):
    """The moved top point, axis and radial direction of a hole seed tool."""
    _, p, d, e, _, _, _ = entry
    P = gp_Pnt(*p).Transformed(tr)
    D = gp_Dir(*d).Transformed(tr)
    E = gp_Dir(*e).Transformed(tr)
    return (P.X(), P.Y(), P.Z()), (D.X(), D.Y(), D.Z()), (E.X(), E.Y(), E.Z())


def reach_of(targets, p, d) -> float:
    return max(bbox_far(x, p, d)[0] for x in targets)


def unbounded_copy(entry, tr, targets):
    """A through tool on the moved axis, long enough to pass every target's box (SPEC §6.5)."""
    _, _, _, _, r, h, _ = entry
    p2, d2, e2 = moved_axis(entry, tr)
    return revolve(p2, e2, d2, profile(r, max(h, reach_of(targets, p2, d2) + 1.0), True))


def verify_too_short(setup: dict, case: dict, det: dict) -> tuple[bool, str]:
    """Is Forge's ``FORGE_PATTERN_THROUGH_COPY_TOO_SHORT`` justified: does the cylinder of the
    hole's radius beyond the reported ``length`` on the instance's moved axis have common
    volume with a pattern-scope target (the copy does not leave every target)?"""
    trs = {tuple(i): tr for i, tr in instances(case["layout"], case["skip"])}
    tr = trs.get(tuple(det["index"]))
    entry = next((x for x in setup["info"] if x[0] == det["at"]), None)
    if tr is None or entry is None or not entry[6]:
        return False, f"no through tool {det['at']} in instance {det['index']}"
    p2, d2, e2 = moved_axis(entry, tr)
    reach = reach_of(setup["targets"], p2, d2)
    length = det["length"]
    top = max(reach, length) + 1.0
    rr = entry[4]["d"] / 2
    far = add(p2, mul(d2, length))
    # The extension has the seed hole's radius, so with a seed hole in the target it is an
    # equal-radius cylinder pair, which ``BRepAlgoAPI_Common`` can get silently wrong: review
    # case 303#21 returned an empty common part (and a cut that removed nothing) where 3.26 mm³
    # of material lies inside the extension (a Monte Carlo estimate gave 3.3 mm³, and the same
    # extension 1e-9 thinner gives 3.263 mm³). A thinner extension meets only what the true one
    # meets, so its positive common volume proves the claim too.
    common = 0.0
    for k in (0.0, 1e-7):
        r_ = rr * (1.0 - k)
        ext = revolve(far, e2, d2, [(0.0, 0.0), (r_, 0.0), (r_, top - length), (0.0, top - length)])
        common = max(common, max(common_volume(x, ext) for x in setup["targets"]))
    note = f"beyond {length:.4f} mm: common volume {common:.3e} mm3; reach Forge {det['reach']:.6f} vs OCCT {reach:.6f}"
    return common > 1e-9, note


def oracle_pattern(case: dict, plate, t: float, setup: dict | None = None) -> dict:
    setup = setup or pattern_setup(case, plate, t)
    if setup["status"] != "ok":
        return setup
    kind, op, seed_tools, info, targets = (setup[k] for k in ("kind", "op", "seed_tools", "info", "targets"))
    inst = instances(case["layout"], case["skip"])
    if op is None:
        created = []
        for idx, tr in inst:
            for s in seed_tools:
                m = metrics_of(moved(s, tr))[0]
                m["instance"] = idx
                created.append(m)
        return {"status": "ok", "instances": [i for i, _ in inst], "skipped": [], "created": created,
                "bodies": []}
    kept, skipped = [], []
    code = "HOLE_MISSES_BODY" if kind == "hole" else "BOOLEAN_NO_INTERSECTION"
    mixed = None
    for idx, tr in inst:
        if kind == "hole":
            tools = [unbounded_copy(i, tr, targets) if i[6] else moved(s, tr) for s, i in zip(seed_tools, info)]
        else:
            tools = [moved(s, tr) for s in seed_tools]
        if op == "join":
            apart = [detached(targets[0], x) for x in tools]
            miss = all(apart)
            if any(apart) and not miss and mixed is None:
                mixed = idx
        else:
            miss = all(common_volume(tg, x) <= 1e-9 for tg in targets for x in tools)
        (skipped if miss else kept).append((idx, tools))
    if mixed is not None:
        # [W0-39] per tool: a kept join instance with a detached tool is the join's error.
        return {"status": "error", "code": "BOOLEAN_NO_INTERSECTION", "instance": mixed}
    if not inst:
        # No non-seed instance: the no-op reading (Forge); the W7b oracle fails the pattern
        # (``PATTERN_ALL_INSTANCES_FAILED``). Open W5 contract question: ``--zero-instances``.
        bodies = sorted((m for x in targets for m in metrics_of(x)), key=lambda m: m["centroid"])
        return {"status": "ok", "instances": [], "skipped": [], "bodies": bodies, "created": [],
                "zero_instances": True}
    if inst and not kept:
        return {"status": "error", "code": "PATTERN_ALL_INSTANCES_FAILED",
                "skipped": [{"index": i, "code": code} for i, _ in skipped]}
    if kept:
        shape = cut_many(targets, [x for _, ts in kept for x in ts], op)
        solids = W4.solids_of(shape)
        bodies = metrics_of(shape)
    else:
        solids = list(targets)
        bodies = sorted((m for x in targets for m in metrics_of(x)), key=lambda m: m["centroid"])
    # The kept copies and (feature seeds of a cut, join or hole) the seed's own tools, whose
    # regions the targets already carry: two of them touching where the result pinches.
    live = [x for _, ts in kept for x in ts] + ([] if kind == "body_join" else list(seed_tools))
    nm = non_manifold_error(solids, live, targets, "join" if op == "join" else "cut")
    if nm is not None:
        return nm
    return {"status": "ok", "instances": [i for i, _ in inst],
            "skipped": [{"index": i, "code": code} for i, _ in skipped],
            "bodies": bodies, "created": [],
            "_adjudicate": ("join" if op == "join" else "cut", list(targets), [x for _, ts in kept for x in ts]),
            "_setup": setup}


# ---------------------------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------------------------


def rel(a: float, b: float) -> float:
    return abs(a - b) / max(1e-12, abs(a), abs(b))


def canonical(ms: list, s: float) -> list:
    """SPEC §5.4: bodies (of one origin) by centroid, lexicographically, each coordinate
    compared with tolerance ``LINEAR_TOLERANCE·s`` (a tie falls through to the next one).
    Bodies without a centroid (a Forge metrics error) come first."""
    tol = TOL * s

    def cmp(a: dict, b: dict) -> int:
        ca, cb = a.get("centroid"), b.get("centroid")
        if ca is None or cb is None:
            return (ca is not None) - (cb is not None)
        for x, y in zip(ca, cb):
            if abs(x - y) > tol:
                return -1 if x < y else 1
        return 0

    return sorted(ms, key=functools.cmp_to_key(cmp))


def match_bodies(fb: list, ob: list, s: float) -> list[tuple[dict, dict]]:
    """SPEC §8.2 body matching: bodies sharing an origin (here: all of them) are matched by
    nearest centroid, greedily in canonical order (§5.4) — never by a plain sort, which pairs
    the wrong bodies when rounding swaps two centroids that are equal in some coordinate."""
    fb, ob = canonical(fb, s), canonical(ob, s)
    left = list(range(len(ob)))
    pairs = []
    for f in fb:
        c = f.get("centroid")
        j = left[0] if c is None else min(left, key=lambda j: math.dist(c, ob[j]["centroid"]))
        left.remove(j)
        pairs.append((f, ob[j]))
    return pairs


def precise(o: dict) -> dict:
    """OCCT's volume and area of a body again, with the precise integrators: Gauss–Kronrod
    volume (``VolumePropertiesGK``, 1e-10) and adaptive area (``SurfaceProperties`` with
    ``Eps`` 1e-11). The oracle's default fixed-order Gauss scheme (``aicad_oracle.occt``) is
    exact to ~1e-11 on analytic faces but not on faces trimmed by B-spline edges (cylinders
    cut by tilted cylinders or cones): there it was 1.5e-6 (volume) and 1.6e-6 (area) off,
    while GK and the adaptive area agreed with Forge's exact mass properties to 1e-12. Called
    only when the default values disagree with Forge — the values themselves never depend on
    Forge."""
    if "volume_precise" not in o:
        from OCP.BRepGProp import BRepGProp
        from OCP.GProp import GProp_GProps
        p = GProp_GProps()
        BRepGProp.VolumePropertiesGK_s(o["_solid"], p, 1e-10, False, False)
        o["volume_precise"] = p.Mass()
        p = GProp_GProps()
        BRepGProp.SurfaceProperties_s(o["_solid"], p, 1e-11, False)
        o["area_precise"] = p.Mass()
    return o


def compare_bodies(fb: list, ob: list, why: list, s: float, key: str = "bodies",
                   flags: dict | None = None) -> tuple[bool, bool]:
    """(geometry equal, counts equal after the §8.3 normalizations) into `why`; bodies are
    matched as SPEC §8.2 says (``match_bodies``), ``s`` the scale of the case. ``flags["pinched"]``
    counts the bodies whose count difference comes with OCCT faces pinched at a vertex."""
    if len(fb) != len(ob):
        why.append(f"{key}: {len(fb)} Forge vs {len(ob)} OCCT")
        return False, False
    geom, counts = True, True
    pinched = 0
    for i, (f, o) in enumerate(match_bodies(fb, ob, s)):
        if "metrics_error" in f:
            why.append(f"{key}[{i}]: Forge metrics error {f['metrics_error']}")
            return False, False
        if not f["valid"]:
            why.append(f"{key}[{i}]: Forge body invalid")
            geom = False
        for q in ("volume", "area"):
            if rel(f[q], o[q]) <= REL:
                continue
            if "_solid" in o and rel(f[q], precise(o)[f"{q}_precise"]) <= REL:
                why.append(f"{key}[{i}]: {q} {f[q]} vs OCCT {o[q]} (fixed-order Gauss), "
                           f"{o[q + '_precise']} (precise): equal")
                continue
            why.append(f"{key}[{i}]: {q} {f[q]} vs {o[q]}"
                       + (f" (precise {o[q + '_precise']})" if f"{q}_precise" in o else ""))
            geom = False
        mine = (f["faces"], f["edges"], f["face_types"], f["edge_types"])
        lit = mine == (o["faces"], o["edges"], o["face_types"], o["edge_types"])
        old = mine == (o["faces_n"], o["edges_n"], o["face_types_n"], o["edge_types_n"])
        # Decisive: the current §8.3 ([W0-52]) counts.
        v1 = mine == (o["faces_v1"], o["edges_v1"], o["face_types_v1"], o["edge_types_v1"])
        if not v1:
            why.append(
                f"{key}[{i}]: counts Forge {f['faces']}/{f['edges']} {f['face_types']} {f['edge_types']} vs "
                f"OCCT §8.3 {o['faces_v1']}/{o['edges_v1']} {o['face_types_v1']} {o['edge_types_v1']} "
                f"(literal {o['faces']}/{o['edges']}; W4 script {o['faces_n']}/{o['edges_n']} "
                f"{o['edge_types_n']}{', equal' if old else ''})")
            counts = False
            if o.get("pinched") and f["faces"] > o["faces_v1"]:
                why.append(f"{key}[{i}]: OCCT has {o['pinched']} face(s) pinched at a vertex (a wire "
                           "through one vertex twice), which Forge splits per lobe (W5 contract issue)")
                pinched += 1
        elif not lit:
            why.append(f"{key}[{i}]: literal counts differ, §8.3 counts equal"
                       + ("" if old else " (the W4 script's older normalization differs)"))
    if flags is not None:
        flags["pinched"] = pinched
    return geom, counts


def build_plate(plate: dict):
    """The plate of a case: its v0 operand, minus the ``cut_doc`` operand when there is one (the
    curved family's tilted cylinder, cone or notch; one solid)."""
    shape = W4.build(plate["doc"])
    if "cut_doc" in plate:
        solids = W4.solids_of(cut_many(shape, [W4.build(plate["cut_doc"])]))
        if len(solids) != 1:
            raise RuntimeError(f"the curved plate has {len(solids)} solids")
        shape = solids[0]
    return shape


def find_face(shape, normal, point):
    """The planar face of ``shape`` whose outward normal is ``normal`` and whose plane contains
    ``point``."""
    from OCP.TopAbs import TopAbs_REVERSED
    ex = TopExp_Explorer(shape, TopAbs_FACE)
    while ex.More():
        f = TopoDS.Face_s(ex.Current())
        srf = BRepAdaptor_Surface(f)
        if srf.GetType() == GeomAbs_Plane:
            pl = srf.Plane()
            a = pl.Axis().Direction()
            n = (a.X(), a.Y(), a.Z())
            if f.Orientation() == TopAbs_REVERSED:
                n = tuple(-c for c in n)
            loc = pl.Location()
            off = sum((point[i] - (loc.X(), loc.Y(), loc.Z())[i]) * n[i] for i in range(3))
            if sum(n[i] * normal[i] for i in range(3)) > 1 - 1e-9 and abs(off) < 1e-7:
                return f
        ex.Next()
    raise RuntimeError(f"no planar face with normal {normal} through {point}")


def compare_probes(probes: dict, plate, row: dict) -> tuple[int, int, int]:
    """Point–face probes of the curved family: Forge's ``planar_face_distance`` against the
    ``BRepExtrema`` distance (on the face within 1e-6 in both, else equal within 1e-6), and
    Forge's ``up_to_depth`` against ``ray_to_face``. Returns ``(probes, mismatches, silent)``,
    ``silent`` counting the mismatches where Forge put a point on the face (or hit it) and
    OCCT did not — a hole that should have failed."""
    face = find_face(plate, probes["face"]["normal"], probes["face"]["point"])
    rface = find_face(plate, probes["ray_face"]["normal"], probes["ray_face"]["point"])
    n = bad = silent = 0
    for p, fd in zip(probes["points"], probes["d"]):
        n += 1
        od = BRepExtrema_DistShapeShape(BRepBuilderAPI_MakeVertex(gp_Pnt(*p)).Vertex(), face).Value()
        if not isinstance(fd, (int, float)):
            bad += 1
            row["why"].append(f"probe {p}: Forge {fd}, OCCT distance {od:.6g}")
            continue
        f_on, o_on = fd <= TOL, od <= TOL
        if f_on != o_on or (not f_on and abs(fd - od) > TOL):
            bad += 1
            silent += int(f_on and not o_on)
            row["why"].append(f"probe {p}: distance Forge {fd:.9g} vs OCCT {od:.9g}")
    for ray, fh in zip(probes["rays"], probes["h"]):
        n += 1
        oh = ray_to_face(rface, ray["p"], ray["d"])
        if isinstance(fh, dict):
            bad += 1
            row["why"].append(f"ray {ray['p']}: Forge {fh}, OCCT {oh}")
        elif (fh is None) != (oh is None) or (fh is not None and abs(fh - oh) > 1e-7):
            bad += 1
            silent += int(fh is not None and oh is None)
            row["why"].append(f"ray {ray['p']}: up_to Forge {fh} vs OCCT {oh}")
    return n, bad, silent


def closed_form_removed(r: dict, t: float) -> float:
    """The volume a single resolved hole removes from a plate of thickness ``t`` it fits in
    (SPEC §6.5 tool profile: counterbore cylinder or countersink frustum, wall, drill point)."""
    rr = r["d"] / 2
    v, y0 = 0.0, 0.0
    if r["cbore"]:
        rc, hc = r["cbore"][0] / 2, r["cbore"][1]
        v, y0 = math.pi * rc * rc * hc, hc
    elif r["csink"]:
        rk = r["csink"][0] / 2
        hk = (rk - rr) / tan_half(r["csink"][1])
        v, y0 = math.pi * hk * (rk * rk + rk * rr + rr * rr) / 3, hk
    h = r["depth"]["blind"] if isinstance(r["depth"], dict) else t
    v += math.pi * rr * rr * (h - y0)
    if isinstance(r["depth"], dict) and r["tip"] != "flat":
        v += math.pi * rr * rr * (rr / tan_half(r["tip"])) / 3
    return v


def is_tilted(layout: dict) -> bool:
    """A layout that moves the drilling axis off the vertical (the tilted families)."""
    if "linear" in layout:
        l = layout["linear"]
        return abs(l["dir"][2]) > 0 or ("dir2" in l and abs(l["dir2"][2]) > 0)
    if "circular" in layout:
        a = layout["circular"]["axis"]
        return abs(a[0]) > 0 or abs(a[1]) > 0
    return abs(layout["mirror"]["normal"][2]) > 0


def subfamily(case: dict) -> str:
    fam = case["family"]
    if case.get("fixed"):
        return "fixed"
    if fam != "pattern":
        return fam
    c = case["case"]
    if c.get("crossing"):
        return "pattern/crossing"
    if is_tilted(c["layout"]):
        return "pattern/tilted"
    return "pattern/extra" if "extra" in c else "pattern/plan"


# ---------------------------------------------------------------------------------------------
# Exact adjudication (review 6)
# ---------------------------------------------------------------------------------------------


class Revolved:
    """A hole tool as the analytic solid of revolution it is (SPEC §6.5 profile): top point
    ``p``, unit axis ``d``, radial unit ``e``, and the profile polygon ``prof`` (``profile``:
    (ρ, y) from the axis at the top round to the axis at the end)."""

    def __init__(self, p, d, e, prof):
        import numpy as np
        self.p = np.array(p, float)
        self.d = np.array(d, float) / np.linalg.norm(d)
        e = np.array(e, float) - np.dot(e, self.d) * self.d
        self.e = e / np.linalg.norm(e)
        self.f = np.cross(self.d, self.e)
        self.prof = prof
        self.L = max(y for _, y in prof)
        # The outer boundary R(y): the profile's edges off the axis that are not horizontal.
        self.segs = [(a, b) for a, b in zip(prof[1:-1], prof[2:]) if b[1] != a[1]]

    def inside(self, q):
        import numpy as np
        v = q - self.p
        y = v @ self.d
        rho2 = np.einsum("ij,ij->i", v, v) - y * y
        r = np.zeros_like(y)
        for (r0, y0), (r1, y1) in self.segs:
            m = (y >= min(y0, y1)) & (y <= max(y0, y1))
            r = np.where(m, np.maximum(r, r0 + (r1 - r0) * (y - y0) / (y1 - y0)), r)
        return (y >= 0.0) & (y <= self.L) & (rho2 <= r * r)

    def patches(self, h: float, clip):
        """Midpoint grids on the revolved profile edges (the axis edge excluded): points,
        outward unit normals and area weights, each edge at spacing about ``h``, in chunks of
        about 2e5 points; chunks whose box misses ``clip`` ((lo, hi)) are not generated."""
        import numpy as np
        pts = self.prof
        area2 = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1]))
        sign = 1.0 if area2 > 0 else -1.0  # counter-clockwise in (ρ, y): outward = (dy, −dρ)
        for (ra, ya), (rb, yb) in zip(pts[:-1], pts[1:]):
            ln = math.hypot(rb - ra, yb - ya)
            if ln == 0.0 or (ra == 0.0 and rb == 0.0):
                continue
            nr, ny = sign * (yb - ya) / ln, -sign * (rb - ra) / ln
            nt = max(8, int(math.ceil(ln / h)))
            nth = max(64, int(math.ceil(2 * math.pi * max(ra, rb) / h)))
            th = 2 * math.pi * (np.arange(nth) + 0.5) / nth
            radial = np.cos(th)[:, None] * self.e + np.sin(th)[:, None] * self.f
            step = max(1, 200_000 // nth)
            for t0 in range(0, nt, step):
                t = (np.arange(t0, min(nt, t0 + step)) + 0.5) / nt
                # The chunk's box: the axis piece widened by the larger radius.
                ya_, yb_ = ya + (yb - ya) * t[0], ya + (yb - ya) * t[-1]
                rmax = max(ra + (rb - ra) * t[0], ra + (rb - ra) * t[-1])
                ends = [self.p + y * self.d for y in (ya_, yb_)]
                if (np.minimum(*ends) - rmax > clip[1]).any() or (np.maximum(*ends) + rmax < clip[0]).any():
                    continue
                rho = ra + (rb - ra) * t
                y = ya + (yb - ya) * t
                x = (self.p + y[:, None, None] * self.d + rho[:, None, None] * radial[None]).reshape(-1, 3)
                n = np.broadcast_to(nr * radial[None] + ny * self.d, (len(t), nth, 3)).reshape(-1, 3)
                w = np.repeat(rho * ln / nt * (2 * math.pi / nth), nth)
                yield x, n, w


class Box:
    """The plate ``[0, w] × [0, d] × [0, t]``."""

    def __init__(self, size):
        import numpy as np
        self.lo, self.hi = np.zeros(3), np.array(size, float)

    def inside(self, q):
        return ((q >= self.lo) & (q <= self.hi)).all(axis=1)

    def patches(self, h: float, boxes):
        """Midpoint grids (spacing ``h``, one lattice per face) on the parts of the six faces
        that lie in one of ``boxes`` ((lo, hi) pairs: the tools' boxes, where alone the
        result can differ from the targets), generated in tiles of about 1 mm."""
        import numpy as np
        for k in range(3):
            i, j = [a for a in range(3) if a != k]
            na = max(8, int(math.ceil((self.hi[i] - self.lo[i]) / h)))
            nb = max(8, int(math.ceil((self.hi[j] - self.lo[j]) / h)))
            da, db = (self.hi[i] - self.lo[i]) / na, (self.hi[j] - self.lo[j]) / nb
            tile = max(1, int(1.0 / h))
            for side, c in ((-1.0, self.lo[k]), (1.0, self.hi[k])):
                rects = [(b[0][i], b[1][i], b[0][j], b[1][j]) for b in boxes
                         if b[0][k] - TOL <= c <= b[1][k] + TOL]
                if not rects:
                    continue
                n = np.zeros(3)
                n[k] = side
                for ta in range(0, na, tile):
                    a_lo, a_hi = self.lo[i] + ta * da, self.lo[i] + min(na, ta + tile) * da
                    for tb in range(0, nb, tile):
                        b_lo, b_hi = self.lo[j] + tb * db, self.lo[j] + min(nb, tb + tile) * db
                        if not any(r[0] <= a_hi and a_lo <= r[1] and r[2] <= b_hi and b_lo <= r[3]
                                   for r in rects):
                            continue
                        ua = self.lo[i] + (np.arange(ta, min(na, ta + tile)) + 0.5) * da
                        ub = self.lo[j] + (np.arange(tb, min(nb, tb + tile)) + 0.5) * db
                        ga, gb = np.meshgrid(ua, ub, indexing="ij")
                        x = np.zeros(ga.shape + (3,))
                        x[..., i], x[..., j], x[..., k] = ga, gb, c
                        yield (x.reshape(-1, 3), np.broadcast_to(n, (ga.size, 3)),
                               np.full(ga.size, da * db))


def exact_model(case: dict, fam: str, plate_size, setup: dict | None, hole_info: list | None):
    """``(box, seeds, tools)`` of analytic operands for a case whose operands are all the plate
    box and hole tools — holes, golden holes, and hole-seed patterns on a plain plate (no
    ``extra`` target) — else None. Through copies are the unbounded reading (``unbounded_copy``)."""
    box = Box(plate_size)
    if fam in ("hole", "golden") and hole_info is not None:
        r, tools, d = hole_info
        _, ex, _, _ = face_frame(case["top"], plate_size[2])
        return box, [], [Revolved(p, d, ex, profile(r, h, th)) for _, p, _, h, th in tools]
    if fam != "pattern" or setup is None or setup.get("kind") != "hole" or "extra" in case:
        return None
    seeds = [Revolved(p, d, e, profile(r, h, th)) for _, p, d, e, r, h, th in setup["info"]]
    tools = []
    for _, tr in instances(case["layout"], case["skip"]):
        for entry in setup["info"]:
            _, _, _, _, r, h, th = entry
            p2, d2, e2 = moved_axis(entry, tr)
            if th:
                h = max(h, reach_of(setup["targets"], p2, d2) + 1.0)
            tools.append(Revolved(p2, d2, e2, profile(r, h, th)))
    return box, seeds, tools


def exact_change(model, h: float, eps: float = 1e-7) -> tuple[float, float]:
    """The volume a cut by ``tools`` removes from ``box`` minus ``seeds`` and the change of the
    area, from the operands alone (no boolean): midpoint quadrature at spacing ``h`` over every
    operand surface. A surface point belongs to the boundary of a region when the region's
    membership differs at ``±eps`` along the normal (coincident surfaces — a coaxial copy,
    a top disc on the plate face — are decided like any other); a point on the surface of an
    earlier operand is skipped (counted once). The removed region ``K = T ∩ ∪tools``
    (``T = box − ∪seeds``) has volume ``(1/3)∮_{∂K} (x − x0)·n dA``; the area change is
    ``A(∂(T − ∪tools)) − A(∂T)``."""
    import numpy as np
    box, seeds, tools = model
    # Every change lies in the tools' boxes.
    boxes = []
    for t in tools:
        rm = max(r for r, _ in t.prof)
        ends = [t.p + y * t.d for y in (0.0, t.L)]
        boxes.append((np.minimum(*ends) - rm - 1e-3, np.maximum(*ends) + rm + 1e-3))
    lo = np.min([b[0] for b in boxes], axis=0)
    hi = np.max([b[1] for b in boxes], axis=0)
    clip = (lo, hi)
    ops = [box] + seeds + tools

    def member(q):
        ins = [o.inside(q) for o in ops]
        t_ = ins[0].copy()
        for s in ins[1:1 + len(seeds)]:
            t_ &= ~s
        c_ = np.zeros(len(q), bool)
        for s in ins[1 + len(seeds):]:
            c_ |= s
        return t_, c_, ins

    vol, dA = 0.0, 0.0
    # Nothing changes outside the tools' boxes, nor outside the plate.
    clip = (np.maximum(clip[0], box.lo - 1e-3), np.minimum(clip[1], box.hi + 1e-3))
    x0 = 0.5 * (clip[0] + clip[1])
    for j, o in enumerate(ops):
        gen = o.patches(h, boxes) if o is box else o.patches(h, clip)
        for x, n, w in gen:
            keep = ((x >= clip[0]) & (x <= clip[1])).all(axis=1)
            x, n, w = x[keep], n[keep], w[keep]
            for a in range(0, len(x), 1_000_000):
                xs, ns, ws = x[a:a + 1_000_000], n[a:a + 1_000_000], w[a:a + 1_000_000]
                tp, cp, ip = member(xs + eps * ns)
                tm, cm, im = member(xs - eps * ns)
                dup = np.zeros(len(xs), bool)
                for i in range(j):
                    dup |= ip[i] != im[i]
                kp, km = tp & cp, tm & cm
                rp, rm_ = tp & ~cp, tm & ~cm
                sk = np.where(km, 1.0, -1.0) * (kp != km) * ~dup
                vol += float(np.sum(sk * np.einsum("ij,ij->i", xs - x0, ns) * ws)) / 3.0
                dA += float(np.sum((((rp != rm_) & ~dup).astype(float) - ((tp != tm) & ~dup)) * ws))
    return vol, dA


def exact_samples(model, h: float) -> float:
    """About how many surface points ``exact_change`` classifies at spacing ``h`` (operand
    surfaces within the plate, and the plate's faces within the tools' boxes)."""
    import numpy as np
    box, seeds, tools = model
    area = 0.0
    for t in seeds + tools:
        full = sum(math.pi * (a[0] + b[0]) * math.hypot(b[0] - a[0], b[1] - a[1])
                   for a, b in zip(t.prof[:-1], t.prof[1:]))
        rm = max(r for r, _ in t.prof)
        ys = np.linspace(0.0, t.L, 201)
        c = t.p + ys[:, None] * t.d
        within = ((c >= box.lo - rm) & (c <= box.hi + rm)).all(axis=1).mean()
        area += full * within
    for t in tools:
        rm = max(r for r, _ in t.prof)
        ends = [t.p + y * t.d for y in (0.0, t.L)]
        lo = np.maximum(np.minimum(*ends) - rm, box.lo)
        hi = np.minimum(np.maximum(*ends) + rm, box.hi)
        for k in range(3):
            i, j = [a for a in range(3) if a != k]
            for c in (box.lo[k], box.hi[k]):
                if lo[k] - TOL <= c <= hi[k] + TOL:
                    area += max(0.0, hi[i] - lo[i]) * max(0.0, hi[j] - lo[j])
    return area / (h * h)


#: Largest number of surface points ``exact_adjudicate`` classifies at its finer spacing
#: (0.001 mm; about two minutes); larger cases fall back to the Monte Carlo triage.
EXACT_MAX_SAMPLES = 1e9


def exact_adjudicate(model, occ: dict, forge: dict, why: list, scale: float) -> str | None:
    """Review 6: the result's volume and area from the analytic operands alone — the plate box
    (exact), minus the seeds' holes, minus the removed region, each by ``exact_change`` at
    spacings 0.002 and 0.001 mm (the error estimate is their difference, conservative for its
    second-order convergence) — against each engine's bodies (OCCT's by its precise
    integrators). ``"OCCT_WRONG"`` only when Forge agrees within the §8.2 tolerances
    (v0 SPEC §6: ``max(1e-6·V, 1e-9·s³)``, ``max(1e-6·A, 1e-9·s²)``; ``s`` the case's scale) plus the estimate's error, that error is at most a
    quarter of each tolerance, and OCCT is off by more than the tolerance plus three errors in
    volume or area; ``"FORGE_WRONG"`` in the mirror case; else None. Neither engine's boolean
    is involved. (Seed 419 #275: removed 72.23005 mm³, Forge 72.23016, OCCT 71.67640; seed 521
    #267: area change 177.39047 mm², Forge 177.39063, OCCT 177.43613.)"""
    import numpy as np
    info = occ.get("_adjudicate")
    if info is None or info[0] != "cut" or not forge.get("bodies"):
        return None
    if exact_samples(model, 0.001) > EXACT_MAX_SAMPLES:
        why.append("exact adjudication skipped (too many surface points)")
        return None
    box, seeds, tools = model
    size = box.hi - box.lo
    v_box = float(np.prod(size))
    a_box = 2.0 * float(size[0] * size[1] + size[0] * size[2] + size[1] * size[2])
    est = []
    for h in (0.002, 0.001):
        sv, sa = exact_change((box, [], seeds), h) if seeds else (0.0, 0.0)
        kv, ka = exact_change(model, h)
        est.append((v_box - sv - kv, a_box + sa + ka))
    (v_e, a_e), ev, ea = est[1], abs(est[1][0] - est[0][0]), abs(est[1][1] - est[0][1])
    v_f, a_f = sum(b["volume"] for b in forge["bodies"]), sum(b["area"] for b in forge["bodies"])
    v_o = sum(precise(b)["volume_precise"] if "_solid" in b else b["volume"] for b in occ["bodies"])
    a_o = sum(precise(b)["area_precise"] if "_solid" in b else b["area"] for b in occ["bodies"])
    tol_v, tol_a = max(REL * v_f, 1e-9 * scale ** 3), max(REL * a_f, 1e-9 * scale ** 2)
    why.append(f"exact adjudication (analytic operands, spacing 0.001 mm): volume {v_e:.6f} "
               f"(±{ev:.1e}), Forge {v_f:.6f}, OCCT {v_o:.6f} (tol {tol_v:.1e}); area "
               f"{a_e:.6f} (±{ea:.1e}), Forge {a_f:.6f}, OCCT {a_o:.6f} (tol {tol_a:.1e})")
    if ev > tol_v / 4 or ea > tol_a / 4:
        return None
    f_ok = abs(v_f - v_e) <= tol_v + ev and abs(a_f - a_e) <= tol_a + ea
    o_ok = abs(v_o - v_e) <= tol_v + ev and abs(a_o - a_e) <= tol_a + ea
    o_off = abs(v_o - v_e) > tol_v + 3 * ev or abs(a_o - a_e) > tol_a + 3 * ea
    f_off = abs(v_f - v_e) > tol_v + 3 * ev or abs(a_f - a_e) > tol_a + 3 * ea
    if f_ok and o_off:
        return "OCCT_WRONG"
    if o_ok and f_off:
        return "FORGE_WRONG"
    return None


def adjudicate(occ: dict, forge: dict, why: list, n: int = 60000) -> str | None:
    """Review 5 (seed 131 #169): when the bodies' volumes differ, an estimate independent of
    both engines' booleans decides who is right. The volume the operation changes — ``cut``:
    in a target and in a tool; ``join``: in a tool and in no target — is estimated by Monte
    Carlo over the tools' box (``n`` points, a fixed seed; each point classified against the
    targets and the tools, which are OCCT's primitive solids or the plate with the seed's own
    features: no boolean of the operation is involved), and compared with the change each
    engine's result implies. ``"OCCT_WRONG"`` when Forge's change is within 5 standard errors
    (plus 1e-6 relative) of the estimate and OCCT's is not, ``"FORGE_WRONG"`` in the opposite
    case, else None (undecided: stays ``POTENTIAL_SILENT_WRONG``)."""
    import random
    info = occ.get("_adjudicate")
    if info is None or not forge.get("bodies") or any("volume" not in b for b in forge["bodies"]):
        return None
    op, targets, tools = info
    if not tools:
        return None
    boxes = [box_of(t) for t in tools]
    lo = [min(b[k] for b in boxes) for k in range(3)]
    hi = [max(b[k + 3] for b in boxes) for k in range(3)]
    vol_box = math.prod(hi[k] - lo[k] for k in range(3))
    rng = random.Random(20260925)
    tcls = [BRepClass3d_SolidClassifier(t) for t in targets]
    kcls = [BRepClass3d_SolidClassifier(t) for t in tools]

    def inside(cls, q) -> bool:
        cls.Perform(gp_Pnt(*q), 1e-9)
        return cls.State() == TopAbs_IN

    hits = 0
    for _ in range(n):
        q = tuple(lo[k] + (hi[k] - lo[k]) * rng.random() for k in range(3))
        in_tool = any(inside(c, q) for c in kcls)
        if not in_tool:
            continue
        in_target = any(inside(c, q) for c in tcls)
        hits += in_target if op == "cut" else not in_target
    p = hits / n
    est, se = vol_box * p, vol_box * math.sqrt(max(p * (1 - p), 1.0 / n) / n)
    v_targets = sum(W4.volume(t) for t in targets)
    v_forge = sum(b["volume"] for b in forge["bodies"])
    v_occt = sum(precise(b)["volume_precise"] if "_solid" in b else b["volume"] for b in occ["bodies"])
    sign = 1.0 if op == "cut" else -1.0
    ch_forge, ch_occt = sign * (v_targets - v_forge), sign * (v_targets - v_occt)
    band = 5 * se + 1e-6 * max(1.0, est)
    why.append(f"adjudication ({op}, Monte Carlo, {n} points): changed volume {est:.4f} ± {se:.4f} mm3; "
               f"Forge {ch_forge:.4f}, OCCT {ch_occt:.4f}")
    f_ok, o_ok = abs(ch_forge - est) <= band, abs(ch_occt - est) <= band
    if f_ok and not o_ok:
        return "OCCT_WRONG"
    if o_ok and not f_ok:
        return "FORGE_WRONG"
    return None


def report_diff(a: dict, b: dict) -> list:
    """Differences between Forge's and the oracle's hole report entries, every field of SPEC
    §6.5 "Report" (review 5): positions within 1e-9 mm, the axis within 1e-12, numbers within
    1e-9, the rest exactly; an absent optional field differs from a present one."""
    bad = []

    def num(x, y, tol=1e-9) -> bool:
        if x is None or y is None:
            return x is None and y is None
        return abs(x - y) <= tol

    for k in ("center", "axis"):
        if math.dist(a[k], b[k]) > (1e-9 if k == "center" else 1e-12):
            bad.append(f"{k} {a[k]} vs {b[k]}")
    for k in ("d", "depth"):
        if not num(a.get(k), b.get(k)):
            bad.append(f"{k} {a.get(k)} vs {b.get(k)}")
    for k in ("kind", "size"):
        if a.get(k) != b.get(k):
            bad.append(f"{k} {a.get(k)} vs {b.get(k)}")
    for k, fields in (("cbore", ("d", "depth")), ("csink", ("d", "angle")), ("insert", ("d", "depth")),
                      ("thread", ("pitch", "depth"))):
        x, y = a.get(k), b.get(k)
        if (x is None) != (y is None) or (x is not None and (
                any(not num(x.get(f), y.get(f)) for f in fields) or x.get("size") != y.get("size"))):
            bad.append(f"{k} {x} vs {y}")
    return bad


def probe_radius(scale: float) -> float:
    """SPEC §8.1 [W0-35]: probes match within ``clamp(1e-6·s, 2·tol, 5·tol)``."""
    return min(max(1e-6 * scale, 2 * TOL), 5 * TOL)


def probe_matches(details, occ: dict, scale: float, why: list) -> bool:
    """Does Forge's ``BOOLEAN_NON_MANIFOLD`` probe (``details.probe.point``) lie where OCCT's
    result touches itself (review 5): within the §8.1 radius of one of OCCT's non-manifold
    edges or shared vertices, or — for the oracle's own tool-contact test — of both touching
    tools?"""
    fp = ((details or {}).get("probe") or {}).get("point")
    where = occ.get("where")
    if fp is None or where is None:
        why.append(f"BOOLEAN_NON_MANIFOLD probe: Forge {fp}, OCCT {occ.get('probe')} (not comparable)")
        return fp is None and where is None
    r = probe_radius(scale)
    v = BRepBuilderAPI_MakeVertex(gp_Pnt(*fp)).Vertex()
    if "touch" in where:
        d = max(BRepExtrema_DistShapeShape(v, t).Value() for t in where["touch"])
    else:
        ds = [BRepExtrema_DistShapeShape(v, e).Value() for e in where["edges"]]
        ds += [math.dist(fp, q) for q in where["points"]]
        d = min(ds) if ds else math.inf
    if d > r:
        why.append(f"BOOLEAN_NON_MANIFOLD probe {fp} ({((details or {}).get('probe') or {}).get('kind')}) "
                   f"is {d:.3g} mm from OCCT's non-manifold set (radius {r:.3g}); OCCT probe {occ.get('probe')}")
        return False
    return True


def compare(case: dict) -> dict:
    fam = case["family"]
    size = case["plate"]["size"]
    t = size[2]
    scale = max(1.0, math.hypot(*size))
    forge = case["forge"]
    row = {"id": case["id"], "family": fam, "sub": subfamily(case), "forge_status": forge["status"],
           "forge_code": forge.get("code"), "why": []}
    probes_silent = 0
    try:
        plate = build_plate(case["plate"])
        if fam == "curved":
            n, bad, probes_silent = compare_probes(case["case"]["probes"], plate, row)
            row["probes"], row["probe_mismatches"], row["probe_silent"] = n, bad, probes_silent
            if case["case"]["hole"] is None:
                row["class"] = ("MATCH" if bad == 0 else
                                "POTENTIAL_SILENT_WRONG" if probes_silent else "PROBE_MISMATCH")
                return row
        if fam == "pattern" and forge.get("code") == "FORGE_PATTERN_THROUGH_COPY_TOO_SHORT":
            setup = pattern_setup(case["case"], plate, t)
            if setup["status"] != "ok":
                row["class"] = "CODE_MISMATCH"
                row["why"].append(f"Forge through-copy error, OCCT seed {setup.get('code')}")
                return row
            ok, note = verify_too_short(setup, case["case"], forge["details"])
            row["occt_status"] = "verified" if ok else "unjustified"
            row["why"].append(note)
            row["class"] = "EXPLICIT_CONTRACT" if ok else "CODE_MISMATCH"
            return row
        occ = oracle_pattern(case["case"], plate, t) if fam == "pattern" else oracle_hole(case["case"], plate, t)
    except Exception as e:  # noqa: BLE001
        row["class"] = "ORACLE_FAIL"
        row["why"].append(f"{type(e).__name__}: {e}")
        return row
    row["occt_status"], row["occt_code"] = occ["status"], occ.get("code")
    why = row["why"]
    holeish = fam in ("hole", "golden", "curved")
    if occ["status"] == "seed_failed" or forge["status"] == "seed_failed":
        # Review 5: the seed's (or the extra block's join's) own outcome, both sides.
        fseed = forge.get("seed") or {}
        fcode = "EXTRA_JOIN" if fseed.get("stage") == "extra" and fseed.get("code") == "SPLIT" else fseed.get("code")
        row["forge_seed_code"] = fcode
        why.append(f"seed: Forge {forge['status']} {fcode or ''} {fseed.get('message', '')!r} vs OCCT "
                   f"{occ['status']} {occ.get('code') or ''}")
        same = occ["status"] == forge["status"] and (occ["status"] != "seed_failed" or fcode == occ.get("code"))
        if same and fcode == "BOOLEAN_NON_MANIFOLD":
            same = probe_matches(fseed.get("details"), occ, scale, why)
        row["class"] = "MATCH" if same else "CODE_MISMATCH"
        return finish(row, probes_silent)
    if forge["status"] != "ok" or occ["status"] != "ok":
        same = forge["status"] == occ["status"] and forge.get("code") == occ.get("code")
        if same and holeish and occ.get("at") is not None:
            fat = (forge.get("details") or {}).get("at")
            if fat != occ.get("at"):
                why.append(f"at: Forge {fat} vs OCCT {occ.get('at')}")
                same = False
            if forge.get("code") == "HOLE_POINT_OFF_FACE":
                fd = forge["details"]["distance"]
                if abs(fd - occ["distance"]) > 1e-6:
                    why.append(f"distance {fd} vs {occ['distance']}")
                    same = False
        if same and holeish and forge.get("code") == "INVALID_VALUE" and "field" in occ:
            fd = forge.get("details") or {}
            if (fd.get("field"), fd.get("value")) != (occ["field"], occ["value"]):
                why.append(f"INVALID_VALUE at {fd.get('field')} = {fd.get('value')} vs {occ['field']} = {occ['value']}")
                same = False
        if same and fam == "pattern" and forge.get("code") == "PATTERN_ALL_INSTANCES_FAILED":
            # (index, code) pairs (review 5). The W7b oracle also emits a
            # PATTERN_INSTANCE_SKIPPED warning per instance next to the error and lists bare
            # indices; Forge emits none: W5 contract issue 4, not compared here.
            fi = sorted((tuple(s["index"]), s["code"]) for s in forge["details"]["instances"])
            oi = sorted((tuple(s["index"]), s["code"]) for s in occ["skipped"])
            if fi != oi:
                why.append(f"failed instances {fi} vs {oi}")
                same = False
        if same and forge.get("code") == "BOOLEAN_NON_MANIFOLD":
            same = probe_matches(forge.get("details"), occ, scale, why)
        if same and forge.get("code") == "BOOLEAN_NO_INTERSECTION" and "instance" in occ:
            ft = ((forge.get("details") or {}).get("tool") or {}).get("instance")
            if ft != occ["instance"]:
                why.append(f"BOOLEAN_NO_INTERSECTION: Forge names instance {ft}, OCCT {occ['instance']}")
                same = False
        if not same and holeish and occ.get("touching_tips") and RULES["tip"] != "breaks":
            # A drill point within tol of the far face ([R-3]: on it). Forge fails it
            # (BOOLEAN_NON_MANIFOLD at the apex, or an explicit W4 error under the face); this
            # oracle's cut gives a body that warns. W5 contract question (``--tip-rule``).
            fd = (forge.get("details") or {}).get("probe") or {}
            vertex = forge.get("code") == "BOOLEAN_NON_MANIFOLD" and fd.get("kind") == "vertex"
            why.append(f"drill point(s) {occ['touching_tips']} within tol of the far face: Forge "
                       f"{forge.get('code')} vs OCCT {occ['status']} (W5 contract: a touching tip)")
            if vertex and RULES["tip"] == "open":
                row["class"] = "OPEN_CONTRACT"
                return finish(row, probes_silent)
            if vertex and RULES["tip"] == "vertex":
                row["class"] = "MATCH"
                return finish(row, probes_silent)
        if not same:
            why.append(f"outcome Forge {forge['status']} {forge.get('code')} vs OCCT {occ['status']} {occ.get('code')}")
            # Forge produced a body the oracle rejects: potentially silent wrong.
            row["class"] = "POTENTIAL_SILENT_WRONG" if forge["status"] == "ok" else "CODE_MISMATCH"
        else:
            row["class"] = "MATCH"
        return finish(row, probes_silent)
    ok = True
    open_contract = False
    if fam == "pattern" and occ.get("zero_instances"):
        if RULES["zero"] == "fail":
            why.append("zero instances: Forge ok (no-op) vs the fail reading PATTERN_ALL_INSTANCES_FAILED")
            row["class"] = "CODE_MISMATCH"
            return finish(row, probes_silent)
        if RULES["zero"] == "open":
            why.append("zero instances: Forge no-op, the W7b oracle PATTERN_ALL_INSTANCES_FAILED "
                       "(open W5 contract question)")
            open_contract = True
    if holeish:
        fh = forge["holes"]
        if [h["at"] for h in fh] != [h["at"] for h in occ["holes"]]:
            why.append("hole ids differ")
            ok = False
        for a, b in zip(fh, occ["holes"]):
            bad = report_diff(a, b)
            if bad:
                why.append(f"hole {a['at']}: " + "; ".join(bad))
                ok = False
        fnotes = [n["details"]["at"] for n in forge["notes"] if n["code"] == "HOLE_BREAKS_THROUGH"]
        onotes = list(occ["notes"])
        if RULES["up_to"] == "warn":
            onotes = [h["at"] for h in occ["holes"] if h["at"] in set(onotes) | set(occ.get("notes_up_to", []))]
        if fnotes != onotes:
            why.append(f"HOLE_BREAKS_THROUGH {fnotes} vs {onotes}")
            ok = False
        elif RULES["up_to"] == "open" and occ.get("notes_up_to"):
            why.append(f"HOLE_BREAKS_THROUGH on up_to holes {occ['notes_up_to']}: Forge never warns, "
                       "the W7b oracle does (open W5 contract question)")
            open_contract = True
        if abs(forge["resolved"]["d"] - occ["resolved"]["d"]) > 0:
            why.append(f"d {forge['resolved']['d']} vs {occ['resolved']['d']}")
            ok = False
        if fam == "golden" and len(forge["bodies"]) == 1 and len(occ["bodies"]) == 1:
            full = size[0] * size[1] * size[2]
            cf = closed_form_removed(occ["resolved"], t)
            fv, ov = full - forge["bodies"][0]["volume"], full - occ["bodies"][0]["volume"]
            row["closed_form"] = {"removed": cf, "forge": fv, "occt": ov}
            if abs(fv - cf) > 1e-9 * max(1.0, cf) or abs(ov - cf) > REL * max(1.0, cf):
                why.append(f"removed volume: closed form {cf:.12g}, Forge {fv:.12g}, OCCT {ov:.12g}")
                row["class"] = "CLOSED_FORM_MISMATCH"
                return finish(row, probes_silent)
    else:
        fs = sorted((tuple(s["index"]), s["code"]) for s in forge["skipped"])
        os_ = sorted((tuple(s["index"]), s["code"]) for s in occ["skipped"])
        if fs != os_:
            why.append(f"skipped {fs} vs {os_}")
            ok = False
        if [list(i) for i in forge["instances"]] != occ["instances"]:
            why.append("instance lists differ")
            ok = False
        if occ["created"] or forge.get("created"):
            fc = sorted(forge.get("created", []), key=lambda m: m.get("instance"))
            oc = sorted(occ["created"], key=lambda m: m.get("instance"))
            if len(fc) != len(oc):
                why.append(f"created {len(fc)} vs {len(oc)}")
                ok = False
            for a, b in zip(fc, oc):
                if a.get("instance") != b.get("instance") or rel(a["volume"], b["volume"]) > REL or math.dist(
                    a["centroid"], b["centroid"]
                ) > 1e-6 * max(1.0, math.hypot(*b["centroid"])):
                    why.append(f"created {a.get('instance')}: {a['volume']} {a['centroid']} vs {b['volume']} {b['centroid']}")
                    ok = False
    flags = {}
    geom, counts = compare_bodies(forge["bodies"], occ["bodies"], why, scale, flags=flags)
    unmerged = sum(b.get("unmerged", 0) for b in forge["bodies"])
    verdict = None
    if not geom and len(forge["bodies"]) == len(occ["bodies"]):
        # Review 6: the exact adjudication where every operand is the plate box or a hole tool;
        # the Monte Carlo triage otherwise (its OCCT_WRONG needs a reviewed closed form).
        model = exact_model(case["case"], fam, size, occ.get("_setup"), occ.get("_hole_info"))
        if model is not None:
            verdict = exact_adjudicate(model, occ, forge, why, scale)
            row["exact_adjudication"] = verdict is not None
        if verdict is None:
            verdict = adjudicate(occ, forge, why)
    if not geom and verdict == "OCCT_WRONG":
        # Forge's body agrees with the independent estimate and OCCT's does not: an oracle
        # failure (not a match, not a Forge silent-wrong result; review 5, seed 131 #169).
        row["class"] = "OCCT_WRONG"
    elif not geom:
        row["class"] = "POTENTIAL_SILENT_WRONG"
    elif not ok:
        row["class"] = "REPORT_MISMATCH"
    elif not counts and unmerged:
        # Review 5: Forge keeps adjacent faces on one carrier apart (SPEC §6.0.4): a W4 unify
        # defect with wrong topology and keys, reported apart from other count differences.
        why.append(f"{unmerged} edge(s) of Forge's result between faces on one carrier (§6.0.4)")
        row["class"] = "UNMERGED_SAME_DOMAIN"
    elif not counts and flags.get("pinched"):
        # Review 5 (seed 41 #79): the count difference comes with OCCT faces pinched at a
        # vertex, which Forge splits per lobe: a named non-match (W5 contract issue), not
        # unmerged faces (Forge's `unmerged` is 0 there).
        row["class"] = "COUNT_PINCHED_FACE"
    elif not counts:
        row["class"] = "COUNT_MISMATCH"
    elif open_contract:
        row["class"] = "OPEN_CONTRACT"
    else:
        row["class"] = "MATCH"
    return finish(row, probes_silent)


def finish(row: dict, probes_silent: int) -> dict:
    """Fold the curved family's probe outcome into the row's class: a probe Forge puts on the
    face (or hits) where OCCT does not is potentially silent wrong; another probe mismatch
    turns a MATCH into PROBE_MISMATCH."""
    if row.get("probe_mismatches"):
        if probes_silent:
            row["class"] = "POTENTIAL_SILENT_WRONG"
        elif row["class"] == "MATCH":
            row["class"] = "PROBE_MISMATCH"
    return row


#: Readings of the open W5 contract questions (set from the command line): ``up_to`` —
#: ``open`` (classify a disagreement ``OPEN_CONTRACT``), ``never`` (Forge: up_to holes never
#: warn), ``warn`` (W7b: an up_to floor on a target face breaks through); ``zero`` — ``open``,
#: ``noop`` (Forge: a layout without instances changes nothing), ``fail`` (W7b:
#: ``PATTERN_ALL_INSTANCES_FAILED``).
RULES = {"up_to": "open", "zero": "open", "tip": "open"}

#: Forge defects the differential found and another workstream owns, by fixed case name
#: (the fixed family replays them in every batch). The note is printed with the row; the
#: class is computed as for any other case, and nothing here exempts a case from ``--gate``
#: (a POTENTIAL_SILENT_WRONG always fails it). Remove an entry when its owner fixes it.
W4_TRACKED = {
    "regression_909_59": "W4 release blocker: a contact line across an inner loop of a planar "
    "face is not detected; W5's tangent-contact guard now fails it with BOOLEAN_NON_MANIFOLD "
    "(tests/pattern_apply.rs w4_contact_line_across_an_inner_loop, ignored)",
    "w4_ssi_29_41": "W4: FORGE_BOOLEAN_SSI where OCCT cuts (tests/pattern_apply.rs "
    "w4_explicit_failures_of_pattern_cuts, ignored)",
    "w4_ssi_41_187": "W4: FORGE_BOOLEAN_SSI where OCCT fails with BOOLEAN_NON_MANIFOLD "
    "(tests/pattern_apply.rs w4_explicit_failures_of_pattern_cuts, ignored)",
    "w4_ssi_41_279": "W4: FORGE_BOOLEAN_SSI where OCCT cuts (tests/pattern_apply.rs "
    "w4_explicit_failures_of_pattern_cuts, ignored)",
    "triage_topology_41_79": "contract (review 5 triage): equal volume and area; the two mirrored "
    "tips meet in a curve with double points, where OCCT keeps a region pinched at a vertex as one "
    "face (wires through a vertex twice) and Forge splits it per lobe (24/41 vs OCCT §8.3 23/38); "
    "no adjacent faces on one carrier (Forge unmerged = 0), so not a §6.0.4 merge defect",
    "tip_band_p05": "W4: a drill-point apex 0.5e-6 mm under the far face is "
    "FORGE_BOOLEAN_INCONSISTENT; by [R-3] a vertex contact, BOOLEAN_NON_MANIFOLD (tests/hole_apply.rs "
    "w4_a_drill_point_just_through_the_far_face, ignored); OCCT: ok + HOLE_BREAKS_THROUGH (contract)",
    "floor_band_m05": "W4: a flat floor 0.5e-6 mm above the far face is "
    "FORGE_BOOLEAN_NEAR_COINCIDENT (explicit; [W0-53] reads the membrane as nowhere thicker than tol)",
    "floor_band_p05": "W4: a flat floor 0.5e-6 mm under the far face is FORGE_BOOLEAN_NEAR_COINCIDENT "
    "(explicit)",
    "floor_band_p15": "W4: a flat floor 1.5e-6 mm under the far face (a through hole, distinct faces) "
    "is FORGE_BOOLEAN_NEAR_COINCIDENT (explicit; W4's near-coincidence band is 10·tol)",
    "w4_inconsistent_23_49": "W4: FORGE_BOOLEAN_INCONSISTENT where OCCT cuts (tests/pattern_apply.rs "
    "w4_explicit_failures_of_pattern_cuts, ignored)",
    "w4_bolt_circle_12": "W4: BOOLEAN_NON_MANIFOLD for a tangency covered by a third tool "
    "(tests/hole_apply.rs w4_a_dense_bolt_circle_is_manifold, ignored)",
}

#: ``OCCT_WRONG`` verdicts reviewed by hand, by fixed case name, each with the exact Rust
#: closed-form test that pins Forge's value (review 6). The Monte Carlo adjudication's band
#: (5 standard errors, about 5 % of the changed volume at 60000 points) is some 10^4 times
#: looser than the §8.2 volume tolerance, so on its own it cannot clear Forge: where both
#: engines are wrong and OCCT is further off, Forge's body would pass as an oracle failure.
#: ``--gate`` therefore fails on every ``OCCT_WRONG`` row that is neither listed here nor
#: decided by ``exact_adjudicate`` (the row keeps its class; the summary lists it under
#: ``occt_wrong_unreviewed``).
OCCT_WRONG_REVIEWED = {
    "occt_wrong_131_169": "tests/pattern_apply.rs "
    "a_hole_rotated_about_a_point_of_its_axis_removes_the_bicylinder_closed_form (Forge removes "
    "pi r^2 8 + pi r^2 9.5 - 16 r^3 / 3 exactly; OCCT 16.6 mm3 too little)",
}

#: The classes that are the contract's business, not an engine defect.
CONTRACT = ("EXPLICIT_CONTRACT", "OPEN_CONTRACT")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("batch", nargs="+")
    ap.add_argument("--out")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--up-to-rule", choices=("open", "never", "warn"), default="open",
                    help="HOLE_BREAKS_THROUGH on up_to holes (open W5 contract question)")
    ap.add_argument("--zero-instances", choices=("open", "noop", "fail"), default="open",
                    help="a pattern without non-seed instances (open W5 contract question)")
    ap.add_argument("--tip-rule", choices=("open", "vertex", "breaks"), default="open",
                    help="a drill point within tol of a face (open W5 contract question): "
                         "BOOLEAN_NON_MANIFOLD at the apex ([R-3], Forge) or ok + HOLE_BREAKS_THROUGH")
    ap.add_argument("--gate", action="store_true",
                    help="exit 1 on any POTENTIAL_SILENT_WRONG, on any OCCT_WRONG neither "
                         "decided exactly nor in OCCT_WRONG_REVIEWED, or when a --gate-families family "
                         "(or all generated pattern families pooled) is below --min-rate MATCH "
                         "(OPEN_CONTRACT excluded; EXPLICIT_CONTRACT counts as a non-match unless "
                         "--gate-exclude-explicit)")
    ap.add_argument("--gate-families",
                    default="pattern/plan,pattern/extra,pattern/tilted,pattern/crossing,hole,golden,curved")
    ap.add_argument("--gate-exclude-explicit", action="store_true",
                    help="leave EXPLICIT_CONTRACT cases out of the gated rates too")
    ap.add_argument("--min-rate", type=float, default=0.995)
    args = ap.parse_args()
    RULES["up_to"], RULES["zero"], RULES["tip"] = args.up_to_rule, args.zero_instances, args.tip_rule
    rows = []
    for path in args.batch:
        with open(path) as fh:
            for k, line in enumerate(fh):
                if args.limit is not None and k >= args.limit:
                    break
                case = json.loads(line)
                row = compare(case)
                row["batch"] = os.path.basename(path)
                if case.get("fixed"):
                    row["fixed"] = case["fixed"]
                    if case["fixed"] in W4_TRACKED:
                        row["tracked"] = W4_TRACKED[case["fixed"]]
                rows.append(row)
    classes = Counter(r["class"] for r in rows)
    by_fam = Counter((r["sub"], r["class"]) for r in rows)
    n = len(rows)
    match = classes.get("MATCH", 0)
    explicit = classes.get("EXPLICIT_CONTRACT", 0)
    contract = sum(classes.get(c, 0) for c in CONTRACT)

    def rate(pred) -> dict:
        sel = [r for r in rows if pred(r)]
        m = sum(1 for r in sel if r["class"] == "MATCH")
        e = sum(1 for r in sel if r["class"] == "EXPLICIT_CONTRACT")
        c = sum(1 for r in sel if r["class"] in CONTRACT)
        o = c - e
        return {"cases": len(sel), "match": m, "explicit_contract": e,
                "open_contract": o,
                "match_rate": m / len(sel) if sel else 0.0,
                # EXPLICIT_CONTRACT counted as a non-match (the gate's default).
                "match_rate_excluding_open_contract": m / (len(sel) - o) if len(sel) > o else 1.0,
                "match_rate_excluding_explicit_contract": m / (len(sel) - e) if len(sel) > e else 0.0,
                "match_rate_excluding_contract": m / (len(sel) - c) if len(sel) > c else 1.0,
                "potential_silent_wrong": sum(1 for r in sel if r["class"] == "POTENTIAL_SILENT_WRONG")}

    families = {
        "pattern": rate(lambda r: r["family"] == "pattern" and r["sub"] != "fixed"),
        "pattern_plan_scope": rate(lambda r: r["sub"] == "pattern/plan"),
        "pattern_extra_targets": rate(lambda r: r["sub"] == "pattern/extra"),
        "pattern_tilted": rate(lambda r: r["sub"] == "pattern/tilted"),
        "pattern_crossing": rate(lambda r: r["sub"] == "pattern/crossing"),
        "hole": rate(lambda r: r["sub"] == "hole"),
        "curved": rate(lambda r: r["family"] == "curved"),
        "golden": rate(lambda r: r["family"] == "golden"),
        "fixed": rate(lambda r: r["sub"] == "fixed"),
    }
    psw = [r for r in rows if r["class"] == "POTENTIAL_SILENT_WRONG"]
    generated = [r for r in rows if r["sub"] != "fixed"]
    gen_match = sum(1 for r in generated if r["class"] == "MATCH")
    gen_contract = sum(1 for r in generated if r["class"] in CONTRACT)
    gate_key = ("match_rate_excluding_contract" if args.gate_exclude_explicit
                else "match_rate_excluding_open_contract")
    gated = {f: (lambda r, f=f: r["sub"] == f) for f in args.gate_families.split(",") if f}
    gated["pattern (all generated)"] = lambda r: r["family"] == "pattern" and r["sub"] != "fixed"
    gate_rates = {}
    for f, pred in gated.items():
        rr = rate(pred)
        if rr["cases"]:
            gate_rates[f] = rr[gate_key]
    gate_failures = [f"{f}: {v:.4f} < {args.min_rate}" for f, v in gate_rates.items() if v < args.min_rate]
    if psw:
        gate_failures.append(f"{len(psw)} POTENTIAL_SILENT_WRONG")
    # Review 6: an OCCT_WRONG verdict clears Forge only with a reviewed closed-form test.
    occt_wrong = [r for r in rows if r["class"] == "OCCT_WRONG"]
    unreviewed = [r for r in occt_wrong
                  if r.get("fixed") not in OCCT_WRONG_REVIEWED and not r.get("exact_adjudication")]
    unreviewed_ids = [f"{r['batch']}#{r['id']}" for r in unreviewed]
    if unreviewed:
        gate_failures.append(f"{len(unreviewed)} OCCT_WRONG without a reviewed closed-form test "
                             f"({', '.join(unreviewed_ids)})")
    summary = {
        "batches": args.batch,
        "rules": dict(RULES),
        "cases": n,
        "match": match,
        "match_rate": match / n if n else 0.0,
        # Forge's verified FORGE_PATTERN_THROUGH_COPY_TOO_SHORT (the W5 contract question).
        "explicit_contract": explicit,
        # Disagreements on the open W5 contract questions (``RULES``).
        "open_contract": contract - explicit,
        "match_rate_excluding_explicit_contract": match / (n - explicit) if n > explicit else 0.0,
        "match_rate_excluding_contract": match / (n - contract) if n > contract else 1.0,
        **families,
        # Plan F1: every generated family (fixed cases excluded), contract classes excluded.
        "f1": {"cases": len(generated),
               "match_rate_excluding_contract": gen_match / (len(generated) - gen_contract)
               if len(generated) > gen_contract else 1.0,
               "potential_silent_wrong": sum(1 for r in generated if r["class"] == "POTENTIAL_SILENT_WRONG")},
        "potential_silent_wrong": len(psw),
        "occt_wrong": len(occt_wrong),
        "occt_wrong_unreviewed": unreviewed_ids,
        "tracked": {f"{r['batch']}#{r['id']} {r['fixed']}": f"{r['class']}: {r['tracked']}"
                    for r in rows if r.get("tracked")},
        "gate": {"families": gate_rates, "rate": gate_key, "min_rate": args.min_rate,
                 "failures": gate_failures},
        "probes": sum(r.get("probes", 0) for r in rows),
        "probe_mismatches": sum(r.get("probe_mismatches", 0) for r in rows),
        "probe_silent": sum(r.get("probe_silent", 0) for r in rows),
        "classes": dict(classes),
        "by_family": {f"{a}/{b}": c for (a, b), c in sorted(by_fam.items())},
        "fixed_cases": {r["fixed"]: r["class"] for r in rows if r.get("fixed")},
        "forge_outcomes": dict(Counter(f"{r['family']}:{r['forge_code'] or r['forge_status']}" for r in rows)),
    }
    print(json.dumps(summary, indent=1))
    for r in rows:
        if r["class"] != "MATCH":
            name = f" [{r['fixed']}]" if r.get("fixed") else ""
            tracked = f" (tracked: {r['tracked']})" if r.get("tracked") else ""
            print(f"{r['batch']}#{r['id']} {r['sub']}{name} {r['class']}{tracked}: " + "; ".join(r["why"][:4]))
    # Per-family table: MATCH over all cases, over cases without OPEN_CONTRACT (the gate's
    # rate), and over cases without any contract class.
    subs = sorted({r["sub"] for r in rows})
    print(f"{'family':<18} {'cases':>5} {'match':>5} {'expl':>4} {'open':>4} {'psw':>3} "
          f"{'all':>7} {'-open':>7} {'-contract':>9}")
    for f in subs + ["pattern (all generated)"]:
        pred = gated["pattern (all generated)"] if f == "pattern (all generated)" else (lambda r, f=f: r["sub"] == f)
        rr = rate(pred)
        print(f"{f:<18} {rr['cases']:>5} {rr['match']:>5} {rr['explicit_contract']:>4} "
              f"{rr['open_contract']:>4} {rr['potential_silent_wrong']:>3} {rr['match_rate']:>7.3f} "
              f"{rr['match_rate_excluding_open_contract']:>7.3f} {rr['match_rate_excluding_contract']:>9.3f}")
    if args.out:
        with open(args.out, "w") as fh:
            json.dump({"summary": summary, "rows": rows}, fh, indent=1)
    if args.gate and gate_failures:
        print("GATE FAILED: " + "; ".join(gate_failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
