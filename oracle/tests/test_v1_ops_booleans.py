"""W7b: body operations — the `booleans/identity.json` runner ([W0-39] … [W0-41], [W0-48], [W0-53]),
the meet and piece tests, the per-tool join failure, `removed`, and the volume gates."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from test_v1_support import PI, body_of, circle, code, doc, ex, feat, rect, rel, run, sk

from aicad_oracle.v1 import booleans
from aicad_oracle.v1.consts import LINEAR_TOLERANCE as TOL
from aicad_oracle.v1.evaluate import evaluate_data

REPO = Path(__file__).resolve().parents[2]
IDENTITY = json.loads((REPO / "corpus/v1/conformance/booleans/identity.json").read_text())["cases"]
COMPARED = ("BOOLEAN_SPLIT", "BOOLEAN_BODY_CONSUMED", "HOLE_BREAKS_THROUGH", "PATTERN_INSTANCE_SKIPPED",
            "SHELL_CLOSED_VOID")

#: Cases the oracle does not follow yet, with the outcome it gives today (asserted, like Forge's
#: `FORGE_PENDING_BOOLEANS`). Empty: the band cases of §11.1 issue 6 agree on the outcome level the
#: fixture compares (codes, bodies, removed, warnings); how the oracle realizes [R-3] coincidence in
#: the geometry itself (a fuzzy value, snapping) stays open.
ORACLE_PENDING_IDENTITY: dict[str, dict] = {}


def _outcome(rep: dict, expect: dict) -> dict:
    out = {}
    for fid in expect:
        f = feat(rep, fid)
        if f["status"] == "error":
            out[fid] = {"status": "error", "code": code(f)}
            continue
        out[fid] = {"status": "ok",
                    "bodies": sorted(json.dumps({"origin": b["origin"], "change": b.get("change")}, sort_keys=True)
                                     for b in f.get("bodies") or []),
                    "removed": sorted(json.dumps(o, sort_keys=True) for o in f.get("removed") or []),
                    "warnings": sorted({w["code"] for w in f["warnings"] if w["code"] in COMPARED})}
    return out


def _want(expect: dict) -> dict:
    out = {}
    for fid, e in expect.items():
        if e["status"] == "error":
            out[fid] = {"status": "error", "code": e["code"]}
        else:
            out[fid] = {"status": "ok",
                        "bodies": sorted(json.dumps(b, sort_keys=True) for b in e["bodies"]),
                        "removed": sorted(json.dumps(o, sort_keys=True) for o in e["removed"]),
                        "warnings": sorted(e["warnings"])}
    return out


def test_identity_fixture_set():
    assert len(IDENTITY) >= 33  # [W0-47] a lower bound


@pytest.mark.parametrize("case", IDENTITY, ids=lambda c: c["id"])
def test_identity_fixture(case):
    got = _outcome(evaluate_data(case["document"], case["id"]), case["expect"])
    if case["id"] in ORACLE_PENDING_IDENTITY:
        assert got == ORACLE_PENDING_IDENTITY[case["id"]] and got != _want(case["expect"])
    else:
        assert got == _want(case["expect"])


# -- meets / pieces (unit level) -----------------------------------------------------------------

def _box(x0, y0, z0, x1, y1, z1):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt

    return BRepPrimAPI_MakeBox(gp_Pnt(x0, y0, z0), gp_Pnt(x1, y1, z1)).Solid()


@pytest.mark.parametrize("overlap, met", [(2e-7, False), (8e-7, False), (9.5e-7, False), (2e-6, True), (1e-3, True)])
def test_a_layer_overlap_meets_only_when_thicker_than_tol(overlap, met):
    """[W0-41] step 2: an overlap nowhere thicker than *tol* is a contact."""
    t = _box(0, 0, 0, 10, 10, 10)
    k = _box(0, 0, 10 - overlap, 10, 10, 20)
    assert booleans.meets(t, [k]) is met


def test_a_corner_1_2e_6_inside_a_tool_face_meets():
    """[W0-48]: the target vertex is 1.2e-6 mm from the tool's face (> tol), although the common
    tetrahedron's inscribed ball is smaller than *tol*."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf

    t = _box(0, 0, 0, 10, 10, 10)
    # a big box whose face is the plane x + y + z = 30 − √3·1.2e-6, i.e. 1.2e-6 mm inside the corner
    import math

    d = math.sqrt(3) * 1.2e-6
    k = _box(-50, -50, -50, 50, 50, 50)
    tr = gp_Trsf()
    tr.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(-1, 1, 0)), math.acos(1 / math.sqrt(3)))
    k = BRepBuilderAPI_Transform(k, tr, True).Shape()
    t2 = gp_Trsf()
    # place the tool so that its face nearest the corner (10, 10, 10) cuts 1.2e-6 mm off it
    from OCP.gp import gp_Vec

    n = (1 / math.sqrt(3),) * 3
    t2.SetTranslation(gp_Vec(*(c * (10 * math.sqrt(3) + 50 - 1.2e-6) for c in n)))
    k = BRepBuilderAPI_Transform(k, t2, True).Shape()
    assert d > 0 and booleans.meets(t, [k]) is True


def test_a_fin_covered_on_both_sides_meets():
    """[W0-53]: a 1.5e-6 mm fin of the target inside the tool: the fin's mid-plane is 7.5e-7 mm from
    its boundary (> tol/2)."""
    t = _box(0, 0, 0, 10, 10, 1.5e-6)
    k = _box(-1, -1, -1, 11, 11, 1)
    assert booleans.meets(t, [k]) is True


@pytest.mark.parametrize("h, degenerate", [(4e-7, True), (8e-7, True), (1.5e-6, False), (1e-3, False)])
def test_layers_left_by_a_cut_are_no_pieces(h, degenerate):
    """[W0-41] steps 1 and 3 with [W0-53]: a layer nowhere thicker than tol between the target's and
    the tool's faces is not a piece; a 1.5e-6 mm wall is."""
    target = _box(0, 0, 0, 10, 10, 10)
    tool = _box(-1, -1, h, 11, 11, 11)
    piece = _box(0, 0, 0, 10, 10, h)
    assert booleans.degenerate_piece(piece, target, [tool]) is degenerate


def test_a_join_tool_detached_from_every_target_is_no_intersection_per_tool():
    """[W0-39]: a tool touching the target only through another tool is detached."""
    d = doc(sk("s1", [rect("a", 10, 10)]), ex("e1", "s1", 5),
            sk("s2", [rect("b", 4, 4, center=(7, 0))]), ex("e2", "s2", 5),
            sk("s3", [rect("c", 4, 4, center=(12, 0))]), ex("e3", "s3", 5),
            {"type": "boolean", "id": "b1", "name": "j", "op": "join", "targets": body_of("e1"),
             "tools": {"kind": "body", "q": {"op": "union", "of": [{"op": "body", "feature": "e2"},
                                                                  {"op": "body", "feature": "e3"}]}}})
    rep = run(d)
    assert code(feat(rep, "b1")) == "BOOLEAN_NO_INTERSECTION"
    assert feat(rep, "b1")["error"]["details"]["tool"]["feature"] == "e3"


def test_removed_lists_only_origins_no_body_carries():
    """[W0-40]: re-joining two pieces of one origin removes nothing."""
    d = doc(sk("s1", [rect("r", 20, 4)]), ex("e1", "s1", 4),
            sk("s2", [rect("g", 1, 10)]), ex("e2", "s2", 10, direction="symmetric", op="cut", targets=body_of("e1")),
            sk("s3", [rect("br", 6, 2)]), ex("e3", "s3", 4, op="join", targets=body_of("e1")))
    rep = run(d)
    assert [w["code"] for w in feat(rep, "e2")["warnings"]] == ["BOOLEAN_SPLIT"]
    (b,) = feat(rep, "e3")["bodies"]
    assert b["origin"]["feature"] == "e1" and "removed" not in feat(rep, "e3")
    assert rel(b["volume"], (20 * 4 - 1 * 4 + 1 * 2) * 4) < 1e-9


def test_a_consumed_target_passes_the_volume_gate_with_rounding_noise():
    """The consumed case's `vol t − vol(t ∩ K)` is rounding noise of the target's size, not of 0."""
    d = doc(sk("s1", [rect("a", 3.7, 5.3)]), ex("e1", "s1", 2.9),
            sk("s2", [rect("c", 9, 9)]), ex("e2", "s2", 9, direction="symmetric", op="cut", targets=body_of("e1")))
    rep = run(d)
    f = feat(rep, "e2")
    assert f["status"] == "ok" and f.get("bodies") is None and f["removed"] == [{"feature": "e1", "member": "a.bottom"}]


def test_unify_that_breaks_validity_falls_back_to_the_raw_result():
    """OCP 7.9.3's UnifySameDomain turns the valid cut of a bore along a 270° revolve's axis into an
    invalid shape; the oracle keeps the operation's own result and normalizes the counts itself."""
    d = doc(sk("s1", [{"kind": "line", "id": "axis_seg", "start": [0, 0], "end": [0, 20]},
                      {"kind": "line", "id": "top", "start": [0, 20], "end": [15, 20]},
                      {"kind": "line", "id": "rim", "start": [15, 20], "end": [15, 0]},
                      {"kind": "line", "id": "bottom", "start": [15, 0], "end": [0, 0]}], plane="XZ"),
            {"type": "revolve", "id": "r1", "name": "knob", "sketch": "s1",
             "axis": {"origin": [0, 0], "direction": [0, 1]}, "angle": 270},
            sk("s2", [circle("b", (0, 0), 3)], plane={"origin": [0, 0, -1], "normal": [0, 0, 1], "x_dir": [1, 0, 0]}),
            ex("e2", "s2", 13, op="cut", targets=body_of("r1")))
    (b,) = feat(run(d), "e2")["bodies"]
    assert b["valid"] is True
    assert rel(b["volume"], 0.75 * PI * 15 ** 2 * 20 - 0.75 * PI * 9 * 12) < 1e-9


def test_meets_threshold_is_the_named_tolerance():
    assert booleans.TOL == TOL and booleans.THICK_MEAN == 4 * TOL


# -- the join-gap band (review finding: shares_face within tol) ------------------------------------

def _join_gap(g: float) -> dict:
    """Two 10 mm boxes; the tool's face at x = 10 + g (g < 0: they overlap by |g|)."""
    return doc(sk("s1", [rect("a", 10, 10, center=(5, 5))]), ex("e1", "s1", 10),
               sk("s2", [rect("b", 10, 10, center=(15 + g, 5))]), ex("e2", "s2", 10),
               {"type": "boolean", "id": "b1", "name": "j", "op": "join", "targets": body_of("e1"),
                "tools": body_of("e2")})


@pytest.mark.parametrize("g, want", [
    (0.5e-6, "ORACLE_COINCIDENCE_UNREALIZED"),  # [R-3]: the faces coincide, the SPEC joins
    (1e-6, "ORACLE_COINCIDENCE_UNREALIZED"),  # inclusive at tol
    (2e-6, "BOOLEAN_NO_INTERSECTION"),  # a real gap
    (-0.5e-6, None),  # an overlap of 0.5e-6: joined
])
def test_a_join_gap_within_tol_is_an_explicit_oracle_failure(g, want):
    """The oracle's booleans run without a fuzzy value (§8.3 rule 2), so it cannot build the union
    [R-3] asks for across a gap in (0, tol]: it fails with an engine-internal code (ROBUSTNESS in the
    diff) instead of asserting `BOOLEAN_NO_INTERSECTION`, which the SPEC does not give there. A
    Contract-stage fixture for this band is requested (W7b report)."""
    f = feat(run(_join_gap(g)), "b1")
    assert code(f) == want
    if want is None:
        (b,) = f["bodies"]
        assert rel(b["volume"], 2000 - 100 * 0.5e-6 * 10 / 10) < 1e-6


def test_a_join_gap_in_the_band_is_robustness_against_a_forge_that_joins():
    import copy

    from aicad_oracle.v1.compare import ROBUSTNESS, compare_reports

    oracle = run(_join_gap(0.5e-6))
    # a Forge that realizes [R-3] joins the boxes: its report is the joined one (a 0.5e-6 overlap
    # gives the same body within the metric tolerances)
    forge = copy.deepcopy(run(_join_gap(-0.5e-6)))
    cmp = compare_reports(forge, oracle)
    assert cmp.classification == ROBUSTNESS, [str(x) for x in cmp.differences]


# -- curved lenses in the band (review finding: the thickness sampling) ----------------------------

R = 10.0


def _lens(h: float, s: float) -> dict:
    """A sphere of radius 10 (the revolution of a half disc about the sketch's Y axis: its seam
    meridian passes through (10, 0, 0)) cut by a box whose face is h deep; the cap's centre is at the
    longitude where the seam crosses the cap s·a from its apex (a the cap's radius)."""
    import math

    a = math.sqrt(2 * R * h)
    phi = s * a / R
    n = [math.cos(phi), 0.0, math.sin(phi)]
    half = sk("s1", [{"kind": "arc", "id": "a", "center": [0, 0], "start": [0, -R], "end": [0, R], "ccw": True},
                     {"kind": "line", "id": "l", "start": [0, R], "end": [0, -R]}])
    return doc(half, {"type": "revolve", "id": "r1", "name": "ball", "sketch": "s1",
                      "axis": {"origin": [0, 0], "direction": [0, 1]}, "angle": 360},
               sk("s2", [rect("t", 10, 10)], plane={"origin": [c * (R - h) for c in n], "normal": n, "x_dir": [0, 1, 0]}),
               ex("e2", "s2", 5, op="cut", targets=body_of("r1")))


@pytest.mark.parametrize("h, s, met", [
    (0.95e-6, 0.0, False), (0.95e-6, 0.33, False),  # a contact: nowhere thicker than tol
    (1.05e-6, 0.0, True), (1.05e-6, 0.33, True), (1.2e-6, 0.5, True), (1.3e-6, 0.33, True),  # (tol, 1.33·tol)
])
def test_a_curved_lens_in_the_band_meets_iff_its_apex_is_deeper_than_tol(h, s, met):
    """[W0-48]: the lens's deepest point is its apex, h from the cut plane: the cut meets iff h > tol.
    The sampling now searches each face for its deepest point (grid inside the face, local search)
    and measures distances to the faces' feet too — `BRepExtrema` alone returns the distance to the
    sphere's seam edge (√2·h here) for points whose foot lies on the seam, which the search found
    as a false 'thick' point before `_foot_distance`."""
    f = feat(run(_lens(h, s)), "e2")
    assert (f["status"] == "ok") is met, code(f)
    if not met:
        assert code(f) == "BOOLEAN_NO_INTERSECTION"


def test_boundary_distance_finds_a_foot_on_a_seam():
    """A point 0.9e-6 outside a sphere, above its seam meridian: its distance to the sphere is
    0.9e-6, not the distance to the seam edge."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeSphere

    ball = BRepPrimAPI_MakeSphere(R).Solid()
    p = (R + 0.9e-6, -1e-7, -1e-6)
    import math

    want = math.dist(p, (0, 0, 0)) - R
    assert abs(booleans._boundary_distance(p, ball) - want) < 1e-12


def test_face_maxima_only_samples_points_inside_the_face():
    """A face crossing its surface's seam: the parametric midpoint of its UV box lies on the far side
    of the cylinder, off the face; every point `face_maxima` measures is on the face."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopoDS import TopoDS

    from aicad_oracle.v1.topo import point_shape_distance

    cyl = BRepPrimAPI_MakeCylinder(5.0, 10.0).Solid()  # seam at +X
    box = BRepPrimAPI_MakeBox(gp_Pnt(4.0, -2.0, 0.0), gp_Pnt(6.0, 2.0, 10.0)).Solid()
    piece = BRepAlgoAPI_Common(cyl, box).Shape()
    faces = [TopoDS.Face_s(f) for f in booleans._sub(piece, TopAbs_FACE)]
    seen = []

    def measure(p):
        seen.append(p)
        return p[0]

    for fc in faces:
        booleans.face_maxima(fc, measure)
    assert seen and all(point_shape_distance(p, piece) < 1e-7 for p in seen)
    assert all(p[0] >= 4.0 - 1e-9 for p in seen)  # never the far side (x = −5)


# -- the band between two tools of one operation (W7b review 2) ------------------------------------

def _two_tools(op: str, gap: float, z0: float = -1.0) -> dict:
    """A 40 × 20 × 10 plate and two 10 mm tool blocks whose facing sides are `gap` apart at x = 0
    (gap < 0: they overlap by |gap|), from z0 up to 11."""
    return doc(sk("s1", [rect("p", 40, 20)]), ex("e1", "s1", 10),
               sk("s2", [rect("a", 10, 10, center=(-5, 0))], plane={"origin": [0, 0, z0], "normal": [0, 0, 1],
                                                                 "x_dir": [1, 0, 0]}), ex("e2", "s2", 11 - z0),
               sk("s3", [rect("b", 10, 10, center=(5 + gap, 0))], plane={"origin": [0, 0, z0], "normal": [0, 0, 1],
                                                                      "x_dir": [1, 0, 0]}), ex("e3", "s3", 11 - z0),
               {"type": "boolean", "id": "b1", "name": "op", "op": op, "targets": body_of("e1"),
                "tools": {"kind": "body", "q": {"op": "union", "of": [{"op": "body", "feature": "e2"},
                                                                      {"op": "body", "feature": "e3"}]}}})


@pytest.mark.parametrize("op, gap, want", [
    ("join", 5e-7, "ORACLE_COINCIDENCE_UNREALIZED"),  # a gap in (0, tol]: [R-3] closes it
    ("join", 9.9e-7, "ORACLE_COINCIDENCE_UNREALIZED"),  # up to tol
    ("join", -5e-7, "ORACLE_COINCIDENCE_UNREALIZED"),  # an overlap nowhere thicker than tol: a contact
    ("join", 2e-6, None),  # a real gap: two bosses
    ("join", 0.0, None),  # touching: OCCT realizes the contact itself
    ("cut", 5e-7, "ORACLE_COINCIDENCE_UNREALIZED"),  # a 5e-7 mm wall the SPEC does not have
    ("cut", 9.9e-7, "ORACLE_COINCIDENCE_UNREALIZED"),
    ("cut", -5e-7, None),  # overlapping cutters: the union covers what touching ones would
    ("cut", 2e-6, None),  # a 2e-6 mm wall is left
    ("cut", 0.0, None),
])
def test_two_tools_in_the_band_fail_explicitly(op, gap, want):
    """The oracle's booleans (no fuzzy value) would keep a 5e-7 mm slot between the two joined
    blocks (or a 5e-7 mm wall between the two cutters) that the SPEC closes: an engine-internal
    failure (ROBUSTNESS), never a result with the wrong topology."""
    f = feat(run(_two_tools(op, gap)), "b1")
    assert code(f) == want, f.get("error")
    if want is None and op == "cut":
        # two 10 mm cubes cut from the plate, less their overlap
        assert rel(f["bodies"][0]["volume"], 40 * 20 * 10 - 2000 + (-gap * 100 if gap < 0 else 0)) < 1e-9


def test_two_cutters_in_the_band_outside_the_target_do_not_matter():
    """The cutters' gap lies above the plate (the second block starts at z = 12): the cut is the
    plain one."""
    d = _two_tools("cut", 5e-7)
    d["parts"][0]["features"][4]["plane"]["origin"] = [0, 0, 12]
    d["parts"][0]["features"][5]["distance"] = 5
    f = feat(run(d), "b1")
    assert f["status"] == "ok", f.get("error")
    assert rel(f["bodies"][0]["volume"], 40 * 20 * 10 - 10 * 10 * 10) < 1e-9


def test_meets_ball_test_is_the_common_parts_boundary_distance():
    """[W0-53]'s ball test in `meets` measures the distance to the common part's own boundary (as
    `degenerate_piece` does); inside the common part it equals min(d_T, d_K)."""
    t = _box(0, 0, 0, 10, 10, 1.5e-6)
    k = _box(-1, -1, -1, 11, 11, 1)
    (c,) = booleans._common(t, [k])
    p = (5.0, 5.0, 0.75e-6)
    dc = booleans._boundary_distance(p, c)
    assert abs(dc - min(booleans._boundary_distance(p, t), booleans._boundary_distance(p, k))) < 1e-12
    assert dc > booleans.TOL / 2 and booleans.meets(t, [k])


# -- W7b review 4: several intersect tools are one operand ∪K ---------------------------------------

def _multi_tool(op, spans, h=4.0):
    """A 10 mm cube (x, y ∈ [-5, 5]) and one 4 mm high tool block per x span (y ∈ [-2, 2]) standing
    on its floor; a `boolean` with every block as a tool."""
    feats = [sk("s1", [rect("o", 10, 10)]), ex("e1", "s1", 10)]
    for i, (x0, x1) in enumerate(spans):
        feats += [sk(f"s{i + 2}", [rect(f"k{i}", x1 - x0, 4, center=((x0 + x1) / 2, 0))]), ex(f"e{i + 2}", f"s{i + 2}", h)]
    feats.append({"type": "boolean", "id": "b1", "name": "b", "op": op, "targets": body_of("e1"),
                  "tools": {"kind": "body", "q": {"op": "union", "of": [{"op": "body", "feature": f"e{i + 2}"}
                                                                        for i in range(len(spans))]}}})
    return doc(*feats)


def _clip(spans):
    """The length of the union of the spans inside [-5, 5]."""
    xs = sorted((max(a, -5.0), min(b, 5.0)) for a, b in spans if min(b, 5.0) > max(a, -5.0))
    total, cur = 0.0, None
    for a, b in xs:
        if cur is None or a > cur[1]:
            total += 0.0 if cur is None else cur[1] - cur[0]
            cur = [a, b]
        else:
            cur[1] = max(cur[1], b)
    return total + (0.0 if cur is None else cur[1] - cur[0])


@pytest.mark.parametrize("spans, bodies", [
    ([(-2, 4), (0, 8)], 1),  # overlapping tools (the review's case: BOOLEAN_NON_MANIFOLD before)
    ([(0, 3), (3, 8)], 1),  # touching tools: one face in common
    ([(-4, 1), (-1, 2), (1.5, 9)], 1),  # three overlapping tools
    ([(-4, -1), (1, 4)], 2),  # apart: two pieces, BOOLEAN_SPLIT
    ([(-6, -3), (-3, 0), (0, 3), (3, 6)], 1),  # a chain of touching tools, over both target sides
])
def test_intersect_with_several_tools_is_the_target_and_their_union(spans, bodies):
    """§6.0.3 / §6.4: `intersect` keeps `t ∩ ∪K` — one body per connected component of that set.
    OCCT's `Common([t], [k1, k2])` splits it per tool into pieces sharing faces; the oracle fuses
    the tools first. Closed form: the clipped union of the spans × 4 × 4. The cut by the same tools
    is the complement."""
    f = feat(run(_multi_tool("intersect", spans)), "b1")
    assert f["status"] == "ok", f.get("error")
    assert len(f["bodies"]) == bodies
    assert rel(sum(b["volume"] for b in f["bodies"]), _clip(spans) * 16) < 1e-9
    assert ("BOOLEAN_SPLIT" in [w["code"] for w in f["warnings"]]) == (bodies > 1)
    assert all(b["shells"] == 1 for b in f["bodies"])
    c = feat(run(_multi_tool("cut", spans)), "b1")
    assert c["status"] == "ok", c.get("error")
    assert rel(sum(b["volume"] for b in c["bodies"]), 1000 - _clip(spans) * 16) < 1e-9


def test_intersect_of_one_merged_tool_region_has_the_merged_faces():
    """The two overlapping tools' tops (z = 4) lie on one plane: the result is one box, 6 faces."""
    f = feat(run(_multi_tool("intersect", [(-2, 4), (0, 8)])), "b1")
    (b,) = f["bodies"]
    assert b["faces"] == 6 and b["face_types"] == {"plane": 6} and b["edges"] == 12


def test_the_intersect_gate_is_independent_of_the_common_call(monkeypatch):
    """The intersect gate checks `vol(t ∩ K) = vol t − vol(t − K)` with a Cut by the separate tools,
    not against the same Common call that built the result: a Common that lost a piece fails the
    feature with `OCCT_SELF_CHECK_FAILED`."""
    real = booleans._run

    def lossy(cls, args, tools):
        op = real(cls, args, tools)
        if cls is booleans.BRepAlgoAPI_Common and len(tools) == 1 and len(args) == 1:
            sols = booleans._solids(op.Shape())
            if len(sols) == 2:
                class _Lossy:
                    def __init__(self, o, shape):
                        self.o, self.s = o, shape

                    def Shape(self):
                        return self.s

                    def __getattr__(self, n):
                        return getattr(self.o, n)
                return _Lossy(op, sols[0])
        return op

    monkeypatch.setattr(booleans, "_run", lossy)
    f = feat(run(_multi_tool("intersect", [(-4, -1), (1, 4)])), "b1")
    assert code(f) == "OCCT_SELF_CHECK_FAILED", f.get("error") or f["status"]


def test_the_difference_gate_scales_with_the_small_volume_not_the_operand():
    """W7b review 5: `_close(…, ref=vol t)` allowed 1e-8 of the target's volume, so a 1 mm³
    intersection of a 1e6 mm³ target could be 0.5 % wrong; `_close_diff` allows 1e-8 of the small
    volume plus `VOLUME_NOISE_REL` (1e-9) of the operand's — the integrator's noise, which the
    generated corpora measure at ~1e-15 relative."""
    big, x = 1e6, 1.0
    wrong = x * 1.005  # the Cut says vol t − vol(t − K) = 1.005
    assert booleans._close(x, big - (big - wrong), 10.0, big)  # the old gate passed it
    assert not booleans._close_diff(x, big, big - wrong, 10.0)
    assert booleans._close_diff(x, big, big - x - 5e-4, 10.0)  # integrator noise on vol t (5e-10 · 1e6)
    assert not booleans._close_diff(x, big, big - x - 2e-3, 10.0)
    assert booleans.VOLUME_NOISE_REL == 1e-9 and booleans.GATE_REL == 1e-8


def _small_common_of_a_large_target(op):
    """A 1 mm cube at the middle of a 100 mm cube: the intersect keeps it, the cut removes it."""
    return doc(sk("s1", [rect("big", 100, 100)]), ex("e1", "s1", 100),
               sk("s2", [rect("small", 1, 1)], plane={"origin": [0, 0, 50], "normal": [0, 0, 1], "x_dir": [1, 0, 0]}),
               ex("e2", "s2", 1, op=op, targets=body_of("e1")))


def _shrunk_common(monkeypatch, f=0.9975):
    """Every Common builds against the tools scaled by `f` about their centroids (−0.75 % volume):
    the error of an intersection that is slightly wrong."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.BRepGProp import BRepGProp
    from OCP.gp import gp_Trsf
    from OCP.GProp import GProp_GProps

    real = booleans._run

    def shrunk(cls, args, tools):
        if cls is booleans.BRepAlgoAPI_Common:
            out = []
            for k in tools:
                g = GProp_GProps()
                BRepGProp.VolumeProperties_s(k, g)
                tr = gp_Trsf()
                tr.SetScale(g.CentreOfMass(), f)
                out.append(BRepBuilderAPI_Transform(k, tr, True).Shape())
            tools = out
        return real(cls, args, tools)

    monkeypatch.setattr(booleans, "_run", shrunk)


def test_a_small_intersection_of_a_large_target_is_checked_tightly(monkeypatch):
    """The 1 mm³ result of a 1e6 mm³ target, 0.75 % short (7.5e-3 mm³, below the old allowance of
    1e-2 mm³): `OCCT_SELF_CHECK_FAILED`, from both operands' sides; unperturbed it is exact."""
    f = feat(run(_small_common_of_a_large_target("intersect")), "e2")
    assert f["status"] == "ok" and rel(f["bodies"][0]["volume"], 1.0) < 1e-12
    _shrunk_common(monkeypatch)
    f = feat(run(_small_common_of_a_large_target("intersect")), "e2")
    assert code(f) == "OCCT_SELF_CHECK_FAILED" and "vol(t ∩ K)" in f["error"]["message"], f.get("error")


def test_the_intersect_gate_checks_the_tool_side_too(monkeypatch):
    """Only the tool side (`vol K − vol(K − t)`) can see this error: a 1 mm cube tool against a
    1e9 mm³ target has a target-side floor of 1e-9 · 1e9 = 1 mm³, so a result 0.75 % short passes
    that side and fails the tool side, whose floor is 1e-9 of the 1 mm³ tool."""
    d = doc(sk("s1", [rect("big", 1000, 1000)]), ex("e1", "s1", 1000),
            sk("s2", [rect("small", 1, 1)], plane={"origin": [0, 0, 500], "normal": [0, 0, 1], "x_dir": [1, 0, 0]}),
            ex("e2", "s2", 1, op="intersect", targets=body_of("e1")))
    assert feat(run(d), "e2")["status"] == "ok"
    _shrunk_common(monkeypatch)
    f = feat(run(d), "e2")
    assert code(f) == "OCCT_SELF_CHECK_FAILED" and "vol K − vol(K − t)" in f["error"]["message"], f.get("error")


def test_a_small_removal_from_a_large_target_is_checked_tightly(monkeypatch):
    """A cut's removed part is `vol t − vol(t − K)`: a Common 0.75 % short of the 1 mm³ removed
    fails the gate (its allowance is 1e-8 of 1 mm³ plus 1e-9 of 1e6 mm³)."""
    f = feat(run(_small_common_of_a_large_target("cut")), "e2")
    assert f["status"] == "ok" and rel(f["bodies"][0]["volume"], 1e6 - 1.0) < 1e-12
    _shrunk_common(monkeypatch)
    f = feat(run(_small_common_of_a_large_target("cut")), "e2")
    assert code(f) == "OCCT_SELF_CHECK_FAILED" and "vol(t ∩ K)" in f["error"]["message"], f.get("error")


def test_pattern_of_an_intersect_seed_with_overlapping_instances():
    """A feature seed `extrude … op: intersect` (x ∈ [0, 10] of a 100 × 40 × 5 plate), patterned
    every 4 mm twice: the target (already the seed's 10 mm strip) is intersected with the union of
    the two instance tools, x ∈ [4, 18] — one strip x ∈ [4, 10], not two touching pieces."""
    d = doc(sk("s1", [rect("o", 100, 40)]), ex("e1", "s1", 5),
            sk("s2", [rect("k", 10, 40, center=(5, 0))]), ex("e2", "s2", 5, op="intersect", targets=body_of("e1")),
            {"type": "pattern", "id": "pt1", "name": "p", "seed": {"features": ["e2"]},
             "layout": {"linear": {"dir": "X", "count": 3, "spacing": 4}}})
    rep = run(d)
    assert rel(feat(rep, "e2")["bodies"][0]["volume"], 10 * 40 * 5) < 1e-9
    f = feat(rep, "pt1")
    assert f["status"] == "ok", f.get("error")
    (b,) = f["bodies"]
    assert rel(b["volume"], 6 * 40 * 5) < 1e-9 and b["faces"] == 6


# -- W7b review 4: a tool face in the [R-3] band of a target face it meets --------------------------

def _side_boss(off, op="join", h=3.0):
    """A 40 × 40 × 5 plate and a 10 × 10 block on its top whose +x side is `off` from the plate's +x
    side (x = 20): `off` < 0 inside, > 0 outside."""
    return doc(sk("s1", [rect("o", 40, 40)]), ex("e1", "s1", 5),
               sk("s2", [{"kind": "rect", "id": "b", "corner": [10, -5], "w": 10 + off, "h": 10}],
                  plane={"origin": [0, 0, 5], "normal": [0, 0, 1], "x_dir": [1, 0, 0]}),
               ex("e2", "s2", h, op=op, targets=body_of("e1")))


@pytest.mark.parametrize("off, want, faces", [
    (-5e-7, "ORACLE_COINCIDENCE_UNREALIZED", None),  # the review's case: ok with 11 faces before
    (5e-7, "ORACLE_COINCIDENCE_UNREALIZED", None),
    (-0.9e-6, "ORACLE_COINCIDENCE_UNREALIZED", None),
    (0.0, None, 10),  # flush: the sides merge (§6.0.4)
    (-2e-6, None, 11),  # a real 2e-6 mm step
    (-1.0, None, 11),
])
def test_a_join_boss_side_in_the_band_of_the_plate_side(off, want, faces):
    """By [R-3] a boss side within *tol* of the plate's side is flush with it (one merged side, 10
    faces); the oracle's fuse (no fuzzy value) keeps a 5e-7 mm step: an explicit engine-internal
    failure (ROBUSTNESS), never the 11-face body."""
    f = feat(run(_side_boss(off)), "e2")
    assert code(f) == want, f.get("error") or f["status"]
    if want is None:
        (b,) = f["bodies"]
        assert b["faces"] == faces and rel(b["volume"], 40 * 40 * 5 + 10 * (10 + off) * 3) < 1e-9


@pytest.mark.parametrize("h", [0.0000005, 1.0])
def test_a_cutter_hovering_in_the_band_above_a_face_is_not_a_failure(h):
    """A band pair that changes nothing passes: a through cutter whose bottom lies 5e-7 mm below
    the plate (it cuts through, its bottom face is not in the result), and one whose top is
    `h` above (not in the result either)."""
    d = doc(sk("s1", [rect("o", 40, 40)]), ex("e1", "s1", 5),
            sk("s2", [rect("k", 10, 10)], plane={"origin": [0, 0, -5e-7], "normal": [0, 0, 1], "x_dir": [1, 0, 0]}),
            ex("e2", "s2", 5 + 5e-7 + h, op="cut", targets=body_of("e1")))
    f = feat(run(d), "e2")
    assert f["status"] == "ok", f.get("error")
    (b,) = f["bodies"]
    assert b["faces"] == 10 and rel(b["volume"], 40 * 40 * 5 - 100 * 5) < 1e-9


def test_band_face_pairs_need_parallel_carriers_near_each_other():
    """`band_face_pairs` lists (tool face, target face) pairs on one carrier family, (fuzz, tol]
    apart and within tol of each other: the 5e-7 mm floor pair, not the 2e-6 mm one, nor a face
    exactly coplanar (OCCT realizes that itself)."""
    t = _box(0, 0, 0, 10, 10, 5)
    assert len(booleans.band_face_pairs(t, [_box(2, 2, 5e-7, 4, 4, 6)])) == 1
    assert booleans.band_face_pairs(t, [_box(2, 2, 2e-6, 4, 4, 6)]) == []
    assert booleans.band_face_pairs(t, [_box(2, 2, 0, 4, 4, 6)]) == []
    assert booleans.band_face_pairs(t, [_box(20, 20, 5e-7, 24, 24, 6)]) == []  # far away
