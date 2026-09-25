"""W7b: SPEC-v1 §8.3 rules 1 and 3 as amended ([W0-42], [W0-43], [W0-49], [W0-51], [W0-52]).

The programs are the hand-counted twins of Forge's `forge-regen/tests/v1_programs/seam_*` (their
counts are asserted there, from the geometry), inlined so the oracle suite stands alone; before
W7b the oracle disagreed with each (the `oracle-seam-*` families of
`forge-regen/tests/v1_oracle_known_differences.json`).
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

import pytest
from test_v1_support import PI, body_of, circle, doc, ex, feat, rect, rel, run, sk

from aicad_oracle.v1 import normalize
from aicad_oracle.v1.consts import ANGULAR_TOLERANCE, LINEAR_TOLERANCE
from aicad_oracle.v1.evaluate import evaluate_data
from aicad_oracle.v1.normalize import SurfGeom, pair_conic, same_carrier

REPO = Path(__file__).resolve().parents[2]
SECTIONS = json.loads((REPO / "corpus/v1/conformance/booleans/section-types.json").read_text())["cases"]

SEAM_BOSS_OVER_HOLE = {"schema": "aicad.ir/1", "parts": [{"id": "p1", "name": "part", "features": [
    {"type": "sketch", "id": "s1", "name": "s1", "plane": "XY",
     "curves": [{"kind": "rect", "id": "r", "center": [0, 0], "w": 40, "h": 40},
                {"kind": "circle", "id": "hc", "center": [0, 0], "radius": 3}]},
    {"type": "extrude", "id": "e1", "name": "e1", "sketch": "s1", "distance": 10},
    {"type": "sketch", "id": "s2", "name": "s2", "plane": {"origin": [0, 0, 10], "normal": [0, 0, 1], "x_dir": [1, 0, 0]},
     "curves": [{"kind": "circle", "id": "ring", "center": [4, 0], "radius": 3}]},
    {"type": "extrude", "id": "e2", "name": "e2", "sketch": "s2", "distance": 5, "op": "join",
     "targets": {"kind": "body", "q": {"op": "body", "feature": "e1"}}}]}]}

SEAM_NOTCH_IN_DISK = {"schema": "aicad.ir/1", "parts": [{"id": "p1", "name": "part", "features": [
    {"type": "sketch", "id": "s1", "name": "s1", "plane": "XY", "curves": [{"kind": "circle", "id": "c", "center": [0, 0], "radius": 10}]},
    {"type": "extrude", "id": "e1", "name": "e1", "sketch": "s1", "distance": 5},
    {"type": "sketch", "id": "s2", "name": "s2", "plane": "XY", "curves": [{"kind": "rect", "id": "n", "center": [0, -10], "w": 4, "h": 8}]},
    {"type": "extrude", "id": "e2", "name": "e2", "sketch": "s2", "distance": 2, "op": "cut",
     "targets": {"kind": "body", "q": {"op": "body", "feature": "e1"}}}]}]}

SEAM_EDGE_ON_HOLE_SEAM = {"schema": "aicad.ir/1", "parts": [{"id": "p1", "name": "part", "features": [
    {"type": "sketch", "id": "s1", "name": "s1", "plane": "XY",
     "curves": [{"kind": "rect", "id": "r", "center": [0, 0], "w": 40, "h": 40},
                {"kind": "circle", "id": "hc", "center": [0, 0], "radius": 5}]},
    {"type": "extrude", "id": "e1", "name": "e1", "sketch": "s1", "distance": 10},
    {"type": "sketch", "id": "s2", "name": "s2", "plane": "XY", "curves": [{"kind": "rect", "id": "n", "center": [5.5, 1.5], "w": 5, "h": 3}]},
    {"type": "extrude", "id": "e2", "name": "e2", "sketch": "s2", "distance": 10, "op": "cut",
     "targets": {"kind": "body", "q": {"op": "body", "feature": "e1"}}}]}]}

TINY_SLIVER_CUT = {"schema": "aicad.ir/1", "parts": [{"id": "p1", "name": "part", "features": [
    {"type": "sketch", "id": "s1", "name": "s1", "plane": "XY", "curves": [{"kind": "rect", "id": "r", "center": [0, 0], "w": 40, "h": 40}]},
    {"type": "extrude", "id": "e1", "name": "e1", "sketch": "s1", "distance": 10},
    {"type": "sketch", "id": "s2", "name": "s2", "plane": "XY", "curves": [{"kind": "rect", "id": "b", "center": [60, 0], "w": 10, "h": 10}]},
    {"type": "extrude", "id": "e2", "name": "e2", "sketch": "s2", "distance": 10},
    {"type": "sketch", "id": "s3", "name": "s3", "plane": "XY",
     "curves": [{"kind": "rect", "id": "sliver", "center": [20.0995, 0], "w": 0.2, "h": 0.01},
                {"kind": "rect", "id": "pk", "center": [60, 0], "w": 2, "h": 2}]},
    {"type": "extrude", "id": "e3", "name": "e3", "sketch": "s3", "distance": 0.01, "op": "cut", "targets": "all"}]}]}

SEAM_SPLIT_HOLE_WALL_FACE = {"schema": "aicad.ir/1", "params": [
    {"name": "width", "unit": "mm", "value": 42.953, "min": 10.0}, {"name": "depth", "unit": "mm", "value": 81.674},
    {"name": "thick", "unit": "mm", "value": 14.948, "min": 0.5}, {"name": "holes", "unit": "count", "value": 1.0},
    {"name": "hole_d", "unit": "mm", "value": 3.674}, {"name": "spread", "unit": "ratio", "value": 0.42},
    {"name": "pocket_w", "unit": "mm", "value": 1.932}],
    "parts": [{"id": "p1", "name": "part_1", "params": [{"name": "margin", "unit": "mm", "value": "min(width, depth) / 5"}],
               "features": [
                   {"type": "sketch", "id": "s1", "name": "plate_sk", "plane": "XY", "curves": [
                       {"kind": "rect", "id": "outline", "corner": ["-width / 2", "-depth / 2"], "w": "width", "h": "depth",
                        "r": "min(width, depth) / 12"},
                       {"kind": "circle", "id": "h0", "center": ["(width / 2 - margin) * spread", "(depth / 2 - margin) * 1"],
                        "radius": "hole_d / 2"},
                       {"kind": "circle", "id": "hc", "center": [0.0, 0.0], "radius": "hole_d / 2 * max(1, holes / 4)"}]},
                   {"type": "extrude", "id": "e1", "name": "plate", "sketch": "s1", "distance": "thick"},
                   {"type": "sketch", "id": "s2", "name": "pocket_sk",
                    "plane": {"face": {"kind": "face", "q": {"op": "cap", "feature": "e1", "end": "end"}}},
                    "curves": [{"kind": "rect", "id": "pocket", "center": [-0.659, -0.253], "w": "pocket_w",
                                "h": "pocket_w * 0.75"}]},
                   {"type": "extrude", "id": "e2", "name": "pocket", "sketch": "s2", "distance": 1000.0,
                    "direction": "reverse", "op": "cut", "targets": "all"}]}]}


def _body(d: dict, fid: str, i: int = 0) -> dict:
    return feat(run(d), fid)["bodies"][i]


# -- rule 1: counts on OCCT's own topology -------------------------------------------------------

def test_arcs_split_at_a_seam_vertex_are_one_edge_rule_1_3a():
    """seam_boss_over_hole: 10 faces (8 plane, 2 cylinder), 18 edges (12 line, 6 circle) — Forge's
    hand count; OCCT splits two arcs at its cylinder seams."""
    b = _body(SEAM_BOSS_OVER_HOLE, "e2")
    assert (b["faces"], b["face_types"]) == (10, {"cylinder": 2, "plane": 8})
    assert (b["edges"], b["edge_types"]) == (18, {"circle": 6, "line": 12})


def test_a_rim_arc_through_the_seam_is_one_edge():
    """seam_notch_in_disk: 7 faces (6 plane, 1 cylinder), 13 edges (10 line, 3 circle), and the
    volume in closed form (the disk minus the notch's part inside it)."""
    b = _body(SEAM_NOTCH_IN_DISK, "e2")
    assert (b["faces"], b["face_types"]) == (7, {"cylinder": 1, "plane": 6})
    assert (b["edges"], b["edge_types"]) == (13, {"circle": 3, "line": 10})
    # the notch x ∈ [-2, 2], y ∈ [-14, -6], z ∈ [0, 2] meets the disk r = 10 below y = -6:
    # area = ∫_{-2}^{2} (√(100 − x²) − 6) dx = 2·√96 + 100·asin(0.2) − 24
    area = 2 * math.sqrt(96) + 100 * math.asin(0.2) - 24
    assert rel(b["volume"], PI * 100 * 5 - area * 2) < 1e-8


def test_an_edge_on_a_seam_line_between_two_faces_is_counted_rule_1_2():
    """seam_edge_on_hole_seam: 24 edges (22 line, 2 circle); the notch wall y = 0 meets the hole wall
    along x = 5, y = 0, on OCCT's cylinder seam line — a real edge, not a seam."""
    b = _body(SEAM_EDGE_ON_HOLE_SEAM, "e2")
    assert (b["edges"], b["edge_types"]) == (24, {"circle": 2, "line": 22})


def test_a_periodic_face_split_along_its_seam_is_one_face_rule_1_1():
    """seam_split_hole_wall_face: the notched hole wall is one cylinder face (6 cylinders, 14 faces,
    35 edges)."""
    b = _body(SEAM_SPLIT_HOLE_WALL_FACE, "e2")
    assert (b["faces"], b["face_types"].get("cylinder"), b["edges"]) == (14, 6, 35)


def test_a_notch_well_above_tolerance_cuts_the_target():
    """tiny_sliver_cut: the 0.0005 × 0.01 × 0.01 mm notch is a cut ([W0-41] step 2; the W7a
    `1e-12·s³` volume threshold dropped it): the plate is modified, 10 faces and 24 edges."""
    rep = run(TINY_SLIVER_CUT)
    bs = {b["origin"]["feature"]: b for b in feat(rep, "e3")["bodies"]}
    assert set(bs) == {"e1", "e2"}
    assert (bs["e1"]["faces"], bs["e1"]["edges"]) == (10, 24)


def test_new_body_sweeps_keep_v0_topology():
    """§6.0.4 [W0-42]: no merge after a new_body sweep (two collinear profile lines stay two faces)."""
    d = doc(sk("s1", [{"kind": "line", "id": "a", "start": [0, 0], "end": [5, 0]},
                      {"kind": "line", "id": "b", "start": [5, 0], "end": [10, 0]},
                      {"kind": "line", "id": "c", "start": [10, 0], "end": [10, 10]},
                      {"kind": "line", "id": "d", "start": [10, 10], "end": [0, 10]},
                      {"kind": "line", "id": "e", "start": [0, 10], "end": [0, 0]}]), ex("e1", "s1", 3))
    b = _body(d, "e1")
    assert b["faces"] == 7
    # ... and a later join merges them (a body operation), with the tool's coplanar faces too
    d2 = doc(*d["parts"][0]["features"], sk("s2", [rect("t", 2, 2, center=(5, 5))], plane={"face": {
        "kind": "face", "q": {"op": "cap", "feature": "e1", "end": "end"}}}),
        ex("e2", "s2", 1, op="join", targets=body_of("e1")))
    b2 = _body(d2, "e2")
    assert b2["faces"] == 6 + 5  # the two front faces merged; the boss adds 4 sides and a top


# -- rule 1.1 carriers ------------------------------------------------------------------------------

def _g(kind, loc=(0, 0, 0), axis=(0, 0, 1), r=0.0, r2=0.0, alpha=0.0):
    return SurfGeom(kind, loc, axis, r, r2, alpha)


@pytest.mark.parametrize("a, b, same", [
    (_g("plane", axis=(0, 0, 1)), _g("plane", (5, 5, 0), (0, 0, -1)), True),  # orientation is a separate test
    (_g("plane", axis=(0, 0, 1)), _g("plane", (0, 0, 2e-6), (0, 0, 1)), False),
    (_g("plane", axis=(0, 0, 1)), _g("plane", (0, 0, 9e-7), (0, 0, 1)), True),
    (_g("cylinder", r=5), _g("cylinder", (0, 0, 7), (0, 0, -1), r=5 + 9e-7), True),
    (_g("cylinder", r=5), _g("cylinder", (2e-6, 0, 0), r=5), False),
    (_g("cone", alpha=0.5), _g("cone", alpha=0.5, axis=(0, 0, -1)), False),  # a cone's axis has a sense
    (_g("sphere", r=3), _g("sphere", (0, 0, 1e-6), None, r=3), True),
    (_g("torus", r=5, r2=1), _g("torus", r=5, r2=1 + 2e-6), False),
    (_g("plane"), _g("cylinder", r=1), False),
])
def test_same_carrier_uses_the_named_tests(a, b, same):
    assert same_carrier(a, b) is same


# -- rule 3: the pair list and the plane–cone test ------------------------------------------------

def _cone(half_deg, apex=(0, 0, 0)):
    return _g("cone", apex, (0, 0, 1), alpha=math.radians(half_deg))


def _plane_through(normal, point=(0, 0, 4)):
    n = normalize.geom.unit(normal)
    return _g("plane", point, n)


@pytest.mark.parametrize("a, b, want", [
    (_plane_through((0, 0, 1)), _g("plane", axis=(1, 0, 0)), "line"),
    (_plane_through((0, 0, 1)), _g("plane", axis=(0, 0, 1)), None),  # parallel planes do not meet
    (_plane_through((1, 0, 0)), _g("cylinder", r=2), "line"),  # a plane parallel to the axis
    (_plane_through((0, 0, 1)), _g("cylinder", r=2), "circle"),  # perpendicular: coaxial
    (_plane_through((0, 1, 1)), _g("cylinder", r=2), "ellipse"),  # oblique
    (_g("cylinder", r=2), _g("cylinder", (5, 0, 0), r=1), "line"),  # parallel axes
    (_g("cylinder", r=5), _g("cylinder", axis=(1, 0, 0), r=5), "ellipse"),  # equal radii, axes meet
    (_g("cylinder", r=5), _g("cylinder", axis=(1, 0, 0), r=5 + 8e-7), "ellipse"),  # within tol: (a) passes
    (_g("cylinder", r=5), _g("cylinder", axis=(1, 0, 0), r=4), None),
    (_g("sphere", r=5), _g("cylinder", r=3), "circle"),  # coaxial
    (_g("sphere", (0, 2e-6, 0), None, r=5), _g("cylinder", r=3), None),
    (_plane_through((1, 2, 3)), _g("sphere", r=5), "circle"),  # every plane–sphere pair
    (_g("sphere", r=5), _g("sphere", (1, 2, 3), None, r=4), "circle"),
    (_g("cone", alpha=0.3), _g("cylinder", r=1), "circle"),
    (_plane_through((1, 0, 0), (0, 0, 0)), _g("torus", r=5, r2=1), "circle"),  # meridian
    (_plane_through((0, 1, 1), (0, 0, 0)), _g("torus", r=5, r2=1), None),
    # [W0-51] the plane–cone test on a 45° cone: c = |n · a| against sin α
    (_plane_through((1, 0, 0), (1, 0, 0)), _cone(45), None),  # c = 0, off the apex: hyperbola
    (_plane_through((1, 0, 0), (0, 0, 0)), _cone(45), "line"),  # c = 0 through the apex: lines
    (_plane_through((-1, 0, 1)), _cone(45), None),  # c = sin 45°: parabola (the guard band)
    (_plane_through((-math.sin(math.radians(20)), 0, math.cos(math.radians(20)))), _cone(45), "ellipse"),
    (_plane_through((0, 0, 1)), _cone(45), "circle"),
])
def test_rule_3_pairs(a, b, want):
    assert pair_conic(a, b) == want and pair_conic(b, a) == want


def _plane_at_c(c: float, point=(0, 0, 4)):
    """A plane whose unit normal makes `c = |n · a|` with the Z axis (a cone's axis here)."""
    return _plane_through((-math.sqrt(1 - c * c), 0.0, c), point)


@pytest.mark.parametrize("half_deg, c, apex, want", [
    # α = 30°: sin α = 0.5 < c < cos α ≈ 0.866 is an ellipse; a sin/cos mix-up would not be
    (30, 0.45, False, None),  # c < sin α, off the apex: a hyperbola
    (30, 0.45, True, "line"),  # c < sin α through the apex: two generators
    (30, 0.6, False, "ellipse"),
    (30, 0.6, True, "ellipse"),  # the SPEC's test has no apex clause here: through the apex no edge arises
    (30, 0.9, False, "ellipse"),
    # α = 60°: cos α = 0.5 < c < sin α ≈ 0.866 is a hyperbola (or lines through the apex)
    (60, 0.45, False, None),
    (60, 0.6, False, None),
    (60, 0.6, True, "line"),
    (60, 0.9, False, "ellipse"),
])
def test_the_plane_cone_test_uses_sin_of_the_half_angle(half_deg, c, apex, want):
    """[W0-51] on cones where sin α ≠ cos α (W7b review 5: the 45° cases cannot tell them apart)."""
    pl = _plane_at_c(c, (0, 0, 0) if apex else (0, 0, 4))
    assert pair_conic(pl, _cone(half_deg)) == want and pair_conic(_cone(half_deg), pl) == want


@pytest.mark.parametrize("half_deg", [30, 45, 60])
def test_the_parabola_band_is_angular_tolerance_wide(half_deg):
    a = math.radians(half_deg)
    for off, want in ((0.5 * ANGULAR_TOLERANCE, None), (-0.5 * ANGULAR_TOLERANCE, None),
                      (3 * ANGULAR_TOLERANCE, "ellipse"), (-3 * ANGULAR_TOLERANCE, None)):
        # c = sin α + off (off the apex: below the band a hyperbola, `bspline`)
        assert pair_conic(_plane_at_c(math.sin(a) + off), _cone(half_deg)) == want


def _section_problems(rep: dict, expect: dict) -> list[str]:
    """The differences between a report and a `section-types.json` expectation: per feature its
    status; an expected error by its **code** (W7b review 3: not by the status alone); an `ok`
    feature by the listed edge types summed over its bodies."""
    out = []
    for fid, exp in expect.items():
        f = feat(rep, fid)
        if f["status"] != exp["status"]:
            out.append(f"{fid}: status {f['status']} ({(f.get('error') or {}).get('code')}), expected {exp['status']}")
            continue
        if exp["status"] == "error":
            got = (f.get("error") or {}).get("code")
            if got != exp.get("code"):
                out.append(f"{fid}: code {got}, expected {exp.get('code')}")
            continue
        tot: dict = {}
        for b in f.get("bodies") or []:
            for k, v in b["edge_types"].items():
                tot[k] = tot.get(k, 0) + v
        got = {k: tot.get(k, 0) for k in exp["edge_types"]}
        if got != exp["edge_types"]:
            out.append(f"{fid}: edge types {got}, expected {exp['edge_types']}")
    return out


#: Cases the oracle does not follow yet, with the problems `_section_problems` reports for them
#: today (asserted, like Forge's `FORGE_PENDING_*`: a pending case must still differ from the
#: expectation). Empty: the oracle follows all eight cases.
ORACLE_PENDING_SECTIONS: dict[str, list] = {}


@pytest.mark.parametrize("case", SECTIONS, ids=lambda c: c["id"])
def test_section_types_fixture(case):
    """`booleans/section-types.json` ([W0-52]): the edge types summed over the feature's bodies."""
    bad = _section_problems(evaluate_data(case["document"], case["id"]), case["expect"])
    if case["id"] in ORACLE_PENDING_SECTIONS:
        assert bad == ORACLE_PENDING_SECTIONS[case["id"]] and bad
    else:
        assert bad == []


def test_the_section_runner_compares_an_expected_error_by_its_code():
    rep = {"features": [{"feature_id": "e2", "status": "error", "error": {"code": "BOOLEAN_NO_EFFECT"}}]}
    assert _section_problems(rep, {"e2": {"status": "error", "code": "BOOLEAN_NO_EFFECT"}}) == []
    assert _section_problems(rep, {"e2": {"status": "error", "code": "BOOLEAN_FAILED"}}) == [
        "e2: code BOOLEAN_NO_EFFECT, expected BOOLEAN_FAILED"]
    assert _section_problems(rep, {"e2": {"status": "ok", "edge_types": {"line": 1}}})


def test_a_section_curve_off_its_pair_conic_is_bspline_and_noted():
    """(b) fails on OCCT's own curve: `bspline`, and the engine-prefixed note (no class)."""
    case = next(c for c in SECTIONS if c["id"].startswith("crossing-cylinders-8e-7"))
    rep = evaluate_data(case["document"], case["id"])
    (fid,) = case["expect"]
    f = feat(rep, fid)
    assert f["bodies"][0]["edge_types"].get("ellipse", 0) == 0
    assert any(w["code"] == "ORACLE_SECTION_NOT_CONIC" for w in f["warnings"])


def test_edges_taken_from_a_sweep_keep_their_construction_type():
    """A through hole's rims are the tool's circles (images of sweep edges), typed as constructed."""
    d = doc(sk("s1", [rect("r", 30, 20)]), ex("e1", "s1", 5),
            sk("s2", [circle("h", (3, 2), 1.5)]), ex("e2", "s2", 20, direction="symmetric", op="cut",
                                                       targets=body_of("e1")))
    b = _body(d, "e2")
    assert b["edge_types"] == {"circle": 2, "line": 12} and b["face_types"] == {"cylinder": 1, "plane": 6}
    assert rel(b["volume"], 30 * 20 * 5 - PI * 2.25 * 5) < 1e-9


def test_merge_stats_count_rule_1_3_merges():
    normalize.merge_stats.update(a=0, b=0, b_near_tangent=0)
    run(SEAM_NOTCH_IN_DISK)
    assert normalize.merge_stats["a"] >= 1


def test_linear_tolerance_is_the_named_constant():
    assert normalize.TOL == LINEAR_TOLERANCE and normalize.ANG == ANGULAR_TOLERANCE
    assert normalize.SECTION_SAMPLES >= 31


# -- named constants at the boundaries ([W0-42], [W0-43]) ------------------------------------------

def _cone_face(semi_angle: float):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.gp import gp_Ax3, gp_Cone, gp_Dir, gp_Pnt

    return BRepBuilderAPI_MakeFace(gp_Cone(gp_Ax3(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), semi_angle, 2.0),
                                   0.0, 2 * math.pi, 0.0, 1.0).Face()


@pytest.mark.parametrize("a, kind", [
    (0.5 * ANGULAR_TOLERANCE, "cylinder"), (ANGULAR_TOLERANCE, "cylinder"), (2 * ANGULAR_TOLERANCE, "cone"),
    (math.pi / 2 - 2 * ANGULAR_TOLERANCE, "cone"), (math.pi / 2 - 0.5 * ANGULAR_TOLERANCE, "plane"),
])
def test_a_cone_within_angular_tolerance_of_a_cylinder_or_plane_is_one(a, kind):
    """v0 [R-8] with the named `ANGULAR_TOLERANCE` (§8.3 [W0-43]), inclusive at the boundary."""
    assert normalize.surface_geom(_cone_face(a)).kind == kind


@pytest.mark.parametrize("g, p, want", [
    (_g("plane", (0, 0, 1), (0, 0, 1)), (3, 4, 3.5), 2.5),
    (_g("cylinder", r=2), (0, 3, 7), 1.0),
    (_g("sphere", (1, 0, 0), None, r=2), (1, 0, 5), 3.0),
    (_g("torus", r=5, r2=1), (6.5, 0, 0), 0.5),
    (_g("torus", r=5, r2=1), (5, 0, 2), 1.0),
    # a 45° cone with its apex at the origin: both nappes (OCCT's double cone), and the apex
    (_cone(45), (1, 0, 1), 0.0),
    (_cone(45), (1, 0, -1), 0.0),
    (_cone(45), (0, 0, 2), math.sqrt(2)),
    (_cone(45), (2, 0, 0), math.sqrt(2)),
])
def test_surface_distance_is_the_distance_to_the_untrimmed_carrier(g, p, want):
    assert normalize.surface_distance(g, p) == pytest.approx(want, abs=1e-12)


def _line_edge(a, b):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
    from OCP.gp import gp_Pnt

    return BRepBuilderAPI_MakeEdge(gp_Pnt(*a), gp_Pnt(*b)).Edge()


def _plane_face(z=0.0):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.gp import gp_Dir, gp_Pln, gp_Pnt

    return BRepBuilderAPI_MakeFace(gp_Pln(gp_Pnt(0, 0, z), gp_Dir(0, 0, 1)), -20, 20, -20, 20).Face()


def _x_cylinder_face(r):
    """A cylinder of radius r whose axis is the line y = 0, z = 1 along X: it touches z = 1 − r."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.gp import gp_Ax3, gp_Cylinder, gp_Dir, gp_Pnt

    return BRepBuilderAPI_MakeFace(gp_Cylinder(gp_Ax3(gp_Pnt(0, 0, 1), gp_Dir(1, 0, 0)), r),
                                   0.0, 2 * math.pi, -20, 20).Face()


@pytest.mark.parametrize("r, want", [(1.0, "line"), (1.0 - 5e-7, "line"), (1.0 - 2e-6, "bspline")])
def test_a_native_conic_off_one_face_is_not_a_witness(r, want):
    """[W0-52]: the section curve must lie within *tol* of **both** faces. The native line y = 0,
    z = 0 lies on the plane z = 0; the pair (a plane parallel to the cylinder's axis) passes (a)
    as `line` for every r here, but with r = 1 − 2e-6 the line is 2e-6 mm off the cylinder: a
    substituted conic, typed `bspline` and noted — not a witness."""
    notes: list = []
    t, _ = normalize.section_type(_line_edge((-5, 0, 0), (5, 0, 0)), _plane_face(), _x_cylinder_face(r), notes)
    assert t == want
    assert bool(notes) is (want == "bspline")
    if notes:
        assert "both faces" in notes[0]


# -- a nearly round ellipse stays an ellipse (W7b review 5) -----------------------------------------

def _tilted_plane_face(theta: float, z: float = 10.0):
    """The plane through (0, 0, z) whose normal is Z tilted by `theta` about Y."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.gp import gp_Dir, gp_Pln, gp_Pnt

    return BRepBuilderAPI_MakeFace(gp_Pln(gp_Pnt(0, 0, z), gp_Dir(math.sin(theta), 0, math.cos(theta))),
                                   -20, 20, -20, 20).Face()


def _z_cylinder_face(r):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.gp import gp_Ax3, gp_Cylinder, gp_Dir, gp_Pnt

    return BRepBuilderAPI_MakeFace(gp_Cylinder(gp_Ax3(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), r),
                                   0.0, 2 * math.pi, -50, 50).Face()


def _section_edge(theta: float, r: float, native: str, z: float = 10.0):
    """The section of the tilted plane with the cylinder r about Z: the exact ellipse (major
    r / cos θ along the tilted X, minor r), or the circle of radius r in the tilted plane."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
    from OCP.gp import gp_Ax2, gp_Circ, gp_Dir, gp_Elips, gp_Pnt

    ax = gp_Ax2(gp_Pnt(0, 0, z), gp_Dir(math.sin(theta), 0, math.cos(theta)), gp_Dir(math.cos(theta), 0, -math.sin(theta)))
    if native == "ellipse":
        return BRepBuilderAPI_MakeEdge(gp_Elips(ax, r / math.cos(theta), r)).Edge()
    return BRepBuilderAPI_MakeEdge(gp_Circ(ax, r)).Edge()


@pytest.mark.parametrize("theta, native", [(1e-4, "ellipse"), (1e-3, "ellipse"), (1e-7, "circle"), (1e-7, "ellipse")])
def test_a_nearly_round_ellipse_section_stays_an_ellipse(theta, native):
    """§8.3 rule 3: an oblique plane (|n × a| > ANGULAR_TOLERANCE) and a cylinder name `ellipse`;
    OCCT's curve passes (b), so the type is `ellipse` however round it is — at θ = 1e-4 rad and
    r = 5, major − minor = 2.5e-8 mm < tol (the oracle typed it `circle` before; Forge reports
    `ellipse`). At θ = 1e-7 a native **circle** in the plane is within tol of the section and of
    both faces: a witness of the ellipse, not a reason to retype it."""
    notes: list = []
    t, w = normalize.section_type(_section_edge(theta, 5.0, native), _tilted_plane_face(theta), _z_cylinder_face(5.0),
                                  notes)
    assert (t, notes) == ("ellipse", []) and w is not None


def test_a_perpendicular_plane_section_is_still_a_circle():
    """The coaxial pair (|n × a| ≤ ANGULAR_TOLERANCE) names `circle`; θ = 0.5·ANGULAR_TOLERANCE."""
    theta = 0.5 * ANGULAR_TOLERANCE
    t, _ = normalize.section_type(_section_edge(theta, 5.0, "circle"), _tilted_plane_face(theta), _z_cylinder_face(5.0))
    assert t == "circle"


def test_round_ellipse_witnesses_of_one_carrier_are_one_curve_rule_1_3a():
    """Rule 1.3 (a) on `ellipse` pieces whose witnesses are a circle and an ellipse with radii within
    tol: the same carrier (a round ellipse's major axis is arbitrary, so it is not compared)."""
    from OCP.gp import gp_Ax2, gp_Circ, gp_Dir, gp_Elips, gp_Pnt

    ax = gp_Ax2(gp_Pnt(0, 0, 10), gp_Dir(0, 0, 1), gp_Dir(1, 0, 0))
    ax_y = gp_Ax2(gp_Pnt(0, 0, 10), gp_Dir(0, 0, 1), gp_Dir(0, 1, 0))
    c, e = gp_Circ(ax, 5.0), gp_Elips(ax_y, 5.0 + 2.5e-8, 5.0)
    assert normalize.same_curve_carrier("ellipse", c, "ellipse", e)
    assert normalize.same_curve_carrier("ellipse", e, "ellipse", c)
    assert not normalize.same_curve_carrier("ellipse", c, "ellipse", gp_Circ(ax, 5.0 + 2e-6))
    # a clearly oblong ellipse keeps the major-axis test
    assert not normalize.same_curve_carrier("ellipse", gp_Elips(ax, 6.0, 5.0), "ellipse", gp_Elips(ax_y, 6.0, 5.0))
    assert normalize.same_curve_carrier("ellipse", gp_Elips(ax, 6.0, 5.0), "ellipse", gp_Elips(ax, 6.0, 5.0))
    # `circle` pieces are compared as circles only
    assert not normalize.same_curve_carrier("circle", c, "circle", e)


def test_a_new_blend_edge_keeps_its_native_ellipse():
    """`own_curve_type` (the new edges of fillets, chamfers, drafts and shells): OCCT's native
    ellipse with radii within tol stays `ellipse` (v0's `occt.edge_type` collapses it)."""
    from aicad_oracle import occt

    e = _section_edge(1e-4, 5.0, "ellipse")
    assert normalize.own_curve_type(e) == "ellipse" and occt.edge_type(e, LINEAR_TOLERANCE) == "circle"
    assert normalize.own_curve_type(_section_edge(1e-4, 5.0, "circle")) == "circle"
    assert normalize.own_curve_type(_line_edge((0, 0, 0), (1, 0, 0))) == "line"


def tilted_cut(theta: float, r: float = 5.0) -> dict:
    """A cylinder r × 20 cut above z = 10 by a plane tilted `theta` rad about Y (the reviewer's
    case): the section is an ellipse, major − minor = r·(1/cos θ − 1)."""
    n = [math.sin(theta), 0.0, math.cos(theta)]
    x = [math.cos(theta), 0.0, -math.sin(theta)]
    return doc(sk("s1", [circle("c", (0, 0), r)]), ex("e1", "s1", 20),
               sk("s2", [rect("r", 40, 40)], plane={"origin": [0, 0, 10], "normal": n, "x_dir": x}),
               ex("e2", "s2", 20, op="cut", targets=body_of("e1")), name=f"tilted_cut_{theta:g}")


@pytest.mark.parametrize("theta", [1e-4, 1e-3])
def test_a_cut_by_a_nearly_perpendicular_plane_has_an_ellipse_edge(theta):
    """End to end: the bottom rim is a circle (a sweep edge), the cut's section an ellipse; the
    volume is the cylinder below the plane (exactly π r² · 10: the plane passes through the axis
    at z = 10)."""
    b = _body(tilted_cut(theta), "e2")
    assert b["edge_types"] == {"circle": 1, "ellipse": 1} and b["face_types"] == {"cylinder": 1, "plane": 2}
    assert rel(b["volume"], PI * 25 * 10) < 1e-9


FORGE_BIN = Path(os.environ.get("AICAD_FORGE_BIN", REPO / "forge" / "target" / "debug" / "aicad"))


def _forge_report(d: dict, tmp_path: Path) -> dict:
    from aicad_oracle.diffrun import run_forge

    if not FORGE_BIN.is_file():
        if os.environ.get("CI"):
            pytest.fail(f"Forge binary {FORGE_BIN} is missing under CI (cargo build -p forge-cli)")
        pytest.skip(f"Forge binary {FORGE_BIN} not built (cargo build -p forge-cli)")
    path = tmp_path / f"{d['meta']['name']}.json"
    path.write_text(json.dumps(d))
    rep, problem = run_forge(FORGE_BIN, path)
    assert rep is not None, problem
    return rep


@pytest.mark.parametrize("theta", [1e-4, 1e-3])
def test_forge_and_the_oracle_agree_on_a_nearly_round_ellipse(theta, tmp_path):
    """The reviewer's end-to-end diff: at θ = 1e-4 the oracle's collapse made Forge's correct
    `ellipse` a POTENTIAL_SILENT_WRONG; now both engines report {circle: 1, ellipse: 1}: MATCH."""
    from aicad_oracle.v1.compare import MATCH, compare_reports

    d = tilted_cut(theta)
    fr = _forge_report(d, tmp_path)
    cmp = compare_reports(fr, evaluate_data(d, d["meta"]["name"]))
    assert cmp.classification == MATCH, [str(x) for x in cmp.differences]
    assert feat(fr, "e2")["bodies"][0]["edge_types"] == {"circle": 1, "ellipse": 1}


def test_a_ring_edge_through_a_vertex_of_other_edges_is_adjacent_to_it():
    """A boss r = 5 on a plate whose side x = 5 it touches at (5, 0, 5): the boss's bottom circle is
    a ring (no vertex of its own) passing through the vertex where the plate's top-side edge is
    split; the ring is adjacent to that vertex (and the vertex to it) — before, it was dropped from
    every vertex. Closed form: the plate plus the boss."""
    base = [sk("s1", [rect("a", 25, 20, center=(-7.5, 0))]), ex("e1", "s1", 5),
            sk("s2", [circle("c", (0, 0), 5)], plane={"origin": [0, 0, 5], "normal": [0, 0, 1], "x_dir": [1, 0, 0]}),
            ex("e2", "s2", 8, op="join", targets=body_of("e1"))]
    circles = {"op": "filter", "where": {"type": "circle"}, "of": {"op": "edges", "of": {"op": "body", "feature": "e1"}}}
    lines = {"op": "filter", "where": {"type": "line"}, "of": {"op": "edges", "of": {"op": "body", "feature": "e1"}}}
    rep = run(doc(*base,
                  {"type": "tag", "id": "t1", "name": "vs", "target": {"kind": "vertex", "card": "any",
                                                                       "q": {"op": "vertices", "of": circles}}},
                  {"type": "tag", "id": "t2", "name": "es", "target": {"kind": "edge", "card": "any", "q": {
                      "op": "filter", "where": {"type": "circle"},
                      "of": {"op": "edges", "of": {"op": "vertices", "of": lines}}}}}))
    b = feat(rep, "e2")["bodies"][0]
    assert rel(b["volume"], 25 * 20 * 5 + PI * 25 * 8) < 1e-9 and b["edge_types"] == {"circle": 2, "line": 13}
    (v,) = [m["probe"]["point"] for m in feat(rep, "t1")["refs"][0]["members"]]
    assert v == pytest.approx([5.0, 0.0, 5.0], abs=1e-9)
    assert [m["key"] for m in feat(rep, "t2")["refs"][0]["members"]] == ["e2/edge:{e1/cap:end@a.bottom|e2/side:c}"]
