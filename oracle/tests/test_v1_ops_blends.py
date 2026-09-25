"""W7b: fillet, chamfer, shell and draft (SPEC-v1 §6.6–§6.9, §8.3 rules 4–8) — closed forms, chain
expansion, the feasible-range property on analytic cases, the error codes, keys, and the
`kernel-diff` relaxations of rules 4 and 5."""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path

import pytest
from test_v1_support import PI, body_of, circle, code, doc, ex, feat, keys, rect, rel, run, sk

from aicad_oracle.v1.compare import MATCH, NORMALIZED, ROBUSTNESS, SILENT_WRONG, compare_reports

REPO = Path(__file__).resolve().parents[2]


def _box(w=40, d=30, t=10, **kw):
    return [sk("s1", [rect("o", w, d, **kw)]), ex("e1", "s1", t)]


def _edges(q):
    return {"kind": "edge", "q": q}


VERTICAL = _edges({"op": "filter", "where": {"parallel": "Z"}, "of": {"op": "edges", "of": {"op": "sides", "feature": "e1"}}})
TOP = _edges({"op": "edges", "of": {"op": "cap", "feature": "e1", "end": "end"}})
TOP_FACE = {"kind": "face", "q": {"op": "cap", "feature": "e1", "end": "end"}}


def _fillet(r, edges=VERTICAL, fid="f1", **kw):
    return {"type": "fillet", "id": fid, "name": f"n_{fid}", "r": r, "edges": edges, **kw}


def _chamfer(d, edges=TOP, fid="c1", **kw):
    return {"type": "chamfer", "id": fid, "name": f"n_{fid}", "d": d, "edges": edges, **kw}


# -- closed forms ----------------------------------------------------------------------------------

@pytest.mark.parametrize("r", [0.5, 3.0, 14.9])
def test_vertical_edge_fillets_in_closed_form(r):
    f = feat(run(doc(*_box(), _fillet(r))), "f1")
    (b,) = f["bodies"]
    assert rel(b["volume"], 40 * 30 * 10 - 4 * (1 - PI / 4) * r * r * 10) < 1e-9
    assert b["face_types"] == {"cylinder": 4, "plane": 6} and b["edge_types"] == {"circle": 8, "line": 16}
    assert f["fillet"]["chain_added"] == [] and len(f["fillet"]["edges"]) == 4
    assert all(k.startswith("f1/blend:{e1/edge:{") for k in f["fillet"]["faces_created"])


@pytest.mark.parametrize("d", [0.5, 1.0, 4.0])
def test_top_edge_chamfer_in_closed_form(d):
    """Each edge removes `L·d²/2`; the four corners overlap by `d³/3` each."""
    (b,) = feat(run(doc(*_box(), _chamfer(d))), "c1")["bodies"]
    assert rel(b["volume"], 40 * 30 * 10 - (140 * d * d / 2 - 4 * d ** 3 / 3)) < 1e-9


def test_two_distance_chamfer_measures_d_on_the_side_face():
    (b,) = feat(run(doc(*_box(), _chamfer(2, d2=1, side=TOP_FACE))), "c1")["bodies"]
    assert rel(b["volume"], 40 * 30 * 10 - (140 * 2 * 1 / 2 - 4 * 2 * 2 * 1 / 3)) < 1e-9


def test_distance_angle_chamfer_puts_d_tan_angle_on_the_other_face():
    """§6.7 does not say which angle; OCCT's `AddDA` (the oracle's reading, reported to W0) measures
    it between the bevel and the `side` face, so the other distance is `d·tan(angle)`."""
    e = _edges({"op": "filter", "where": {"parallel": "X"}, "of": {"op": "edges", "of": {"op": "cap", "feature": "e1",
                                                                                        "end": "end"}}})
    (b,) = feat(run(doc(*_box(20, 20), _chamfer(2, edges=e, angle=30, side=TOP_FACE))), "c1")["bodies"]
    assert rel(b["volume"], 20 * 20 * 10 - 2 * 20 * 2 * 2 * math.tan(math.radians(30)) / 2) < 1e-9


def test_chain_expansion_on_a_rounded_rectangle():
    """With `tangent_chain` (default) the arcs tangent to a selected line join the set."""
    e = _edges({"op": "filter", "where": {"parallel": "X"}, "of": {"op": "edges", "of": {"op": "cap", "feature": "e1",
                                                                                        "end": "end"}}})
    f = feat(run(doc(*_box(r=4), _chamfer(1, edges=e))), "c1")
    assert len(f["chamfer"]["edges"]) == 8 and len(f["chamfer"]["chain_added"]) == 6
    assert f["bodies"][0]["face_types"].get("cone") == 4


@pytest.mark.parametrize("th, inward", [(1.0, True), (2.5, True), (1.0, False), (0.3, False)])
def test_shell_open_top_in_closed_form(th, inward):
    s = {"type": "shell", "id": "sh1", "name": "hollow", "thickness": th, "body": body_of("e1"), "open": TOP_FACE}
    if not inward:
        s["direction"] = "outward"
    f = feat(run(doc(*_box(), s)), "sh1")
    (b,) = f["bodies"]
    want = 40 * 30 * 10 - (40 - 2 * th) * (30 - 2 * th) * (10 - th) if inward else \
        (40 + 2 * th) * (30 + 2 * th) * (10 + th) - 40 * 30 * 10
    assert rel(b["volume"], want) < 1e-9
    assert f["shell"] == {"removed_faces": ["e1/cap:end@o.bottom"]} and b["faces"] == 11


def test_shell_keys_offsets_and_rims():
    d = doc(*_box(), {"type": "shell", "id": "sh1", "name": "hollow", "thickness": 1, "body": body_of("e1"),
                      "open": TOP_FACE},
            {"type": "tag", "id": "t1", "name": "made", "target": {"kind": "face", "q": {"op": "created", "feature": "sh1"}}})
    ks = keys(feat(run(d), "t1"))
    assert "sh1/rim:{e1/cap:end@o.bottom}" in ks and "sh1/offset:{e1/cap:start@o.bottom}" in ks and len(ks) == 6


def test_a_closed_shell_makes_an_internal_void():
    f = feat(run(doc(*_box(), {"type": "shell", "id": "sh1", "name": "hollow", "thickness": 1, "body": body_of("e1")})), "sh1")
    (b,) = f["bodies"]
    assert b["shells"] == 2 and [w["code"] for w in f["warnings"]] == ["SHELL_CLOSED_VOID"]
    assert f["shell"]["closed_void"] is True and rel(b["volume"], 40 * 30 * 10 - 38 * 28 * 8) < 1e-9


def test_fillet_then_shell_in_closed_form():
    r, th = 5.0, 1.5
    d = doc(*_box(), _fillet(r), {"type": "shell", "id": "sh1", "name": "wall", "thickness": th, "body": body_of("e1"),
                                  "open": TOP_FACE})

    def area(w, dd, rr):
        return w * dd - (4 - PI) * rr * rr

    (b,) = feat(run(d), "sh1")["bodies"]
    assert rel(b["volume"], area(40, 30, r) * 10 - area(40 - 2 * th, 30 - 2 * th, r - th) * (10 - th)) < 1e-9


# -- errors and the feasible-range property -------------------------------------------------------

def test_fillet_radius_too_large_reports_the_analytic_limit():
    """Two vertical fillets on one 30 mm face must leave *tol* of it: 2r ≤ 30 − tol, so the
    largest multiple of 0.001 mm is 14.999 (at r = 15 the face vanishes and OCCT fails)."""
    f = feat(run(doc(*_box(), _fillet(16))), "f1")
    assert code(f) == "FILLET_RADIUS_TOO_LARGE" and f["error"]["details"]["max_feasible_r"] == 14.999
    assert [e["max_r"] for e in f["error"]["details"]["edges"]] == [14.999] * 4


def _vertical_chamfer(d):
    return _chamfer(d, edges=VERTICAL)


def _top_chamfer_two_distance(d):
    return _chamfer(d, d2=1, side=TOP_FACE)


def _top_chamfer_angle(d):
    return _chamfer(d, angle=30, side=TOP_FACE)


def _shell_open_top(t):
    return {"type": "shell", "id": "sh1", "name": "hollow", "thickness": t, "body": body_of("e1"), "open": TOP_FACE}


#: (id, the program's features for a size, its id, the too-large code, the max field, a size that
#: is too large, the expected max): the analytic cases of the feasible-range property.
FEASIBLE = [
    ("fillet-vertical", lambda x: [*_box(), _fillet(x)], "f1", "FILLET_RADIUS_TOO_LARGE", "max_feasible_r", 20, 14.999),
    ("fillet-top", lambda x: [*_box(t=4), _fillet(x, edges=TOP)], "f1", "FILLET_RADIUS_TOO_LARGE", "max_feasible_r",
     5, 3.999),
    ("chamfer-top", lambda x: [*_box(t=4), _chamfer(x)], "c1", "CHAMFER_DISTANCE_TOO_LARGE", "max_feasible_d", 5, 3.999),
    ("chamfer-vertical", lambda x: [*_box(), _vertical_chamfer(x)], "c1", "CHAMFER_DISTANCE_TOO_LARGE",
     "max_feasible_d", 16, 14.999),
    # d on the 40 × 30 top face (two parallel edges 30 apart), d2 = 1 on the walls, held fixed
    ("chamfer-two-distance", lambda x: [*_box(), _top_chamfer_two_distance(x)], "c1", "CHAMFER_DISTANCE_TOO_LARGE",
     "max_feasible_d", 20, 14.999),
    # d on the top face, d·tan 30° on the walls (10 mm: d ≤ 17.32), so the top face limits d
    ("chamfer-distance-angle", lambda x: [*_box(), _top_chamfer_angle(x)], "c1", "CHAMFER_DISTANCE_TOO_LARGE",
     "max_feasible_d", 20, 14.999),
    # the floor and the opened top are 10 apart: t ≤ 10 − tol
    ("shell-gap", lambda x: [*_box(), _shell_open_top(x)], "sh1", "SHELL_THICKNESS_TOO_LARGE",
     "max_feasible_thickness", 12, 9.999),
]


@pytest.mark.parametrize("name, feats, fid, want, field, big, mx", FEASIBLE, ids=[c[0] for c in FEASIBLE])
def test_feasible_range_property_on_analytic_cases(name, feats, fid, want, field, big, mx):
    """§6.6–§6.8 (the W6 acceptance's property, on the oracle's side): the size too large reports
    `max`; `max` exactly succeeds; 1.01·max fails with the same code; and asking for the limit
    itself (where the face or gap vanishes) reports the same `max` — it does not depend on the
    requested size."""
    f = feat(run(doc(*feats(big))), fid)
    assert code(f) == want and f["error"]["details"][field] == mx
    assert feat(run(doc(*feats(f["error"]["details"][field]))), fid)["status"] == "ok"
    assert code(feat(run(doc(*feats(mx * 1.01))), fid)) == want
    at_limit = feat(run(doc(*feats(round(mx + 0.001, 3)))), fid)
    assert code(at_limit) == want and at_limit["error"]["details"][field] == mx


def test_feasible_range_property_on_the_curvature_limit():
    """A disk of radius 5 shelled inward: its wall's offset degenerates at 5, so the largest
    thickness is 4.999, which builds; 1.01 · 4.999 fails."""
    def prog(t):
        return doc(sk("s1", [circle("c", (0, 0), 5)]), ex("e1", "s1", 20), _shell_open_top(t))

    f = feat(run(prog(6)), "sh1")
    assert code(f) == "SHELL_THICKNESS_TOO_LARGE" and f["error"]["details"]["max_feasible_thickness"] == 4.999
    # the limit names the face whose offset degenerates (W7b review: not an empty key)
    assert f["error"]["details"]["limits"] == [{"key": "e1/side:c", "name": "n_e1/side:c", "reason": "curvature"}]
    assert feat(run(prog(4.999)), "sh1")["status"] == "ok"
    assert code(feat(run(prog(4.999 * 1.01)), "sh1")) == "SHELL_THICKNESS_TOO_LARGE"


def test_a_two_distance_chamfer_whose_d2_alone_is_too_wide_has_no_feasible_d():
    """`d2` is not scaled with `d`: 12 mm on the 10 mm walls fits for no `d` (max_feasible_d 0.0;
    the SPEC's details cannot say "reduce d2" — reported to the Contract stage)."""
    f = feat(run(doc(*_box(), _chamfer(1, d2=12, side=TOP_FACE))), "c1")
    assert code(f) == "CHAMFER_DISTANCE_TOO_LARGE" and f["error"]["details"]["max_feasible_d"] == 0.0


@pytest.mark.parametrize("x, want", [(15.0, 15.0), (14.9999995, 14.999), (3.41, 3.41), (0.0029999999999999996, 0.002),
                                     (math.nextafter(3.41, 0.0), 3.409), (1e-7, 0.0), (-1.0, 0.0)])
def test_round_down_never_rounds_up(x, want):
    from aicad_oracle.v1.blends import _round_down

    assert _round_down(x) == want and _round_down(x) <= max(x, 0.0)


def test_smooth_edges_are_unsupported():
    """The tangent junction edges of a rounded rectangle are `smooth`."""
    f = feat(run(doc(*_box(r=3), _fillet(1))), "f1")
    assert code(f) == "FILLET_EDGE_UNSUPPORTED"
    assert {e["reason"] for e in f["error"]["details"]["edges"]} == {"smooth"}


def test_chamfer_side_must_be_adjacent():
    bottom = {"kind": "face", "q": {"op": "cap", "feature": "e1", "end": "start"}}
    f = feat(run(doc(*_box(), _chamfer(1, d2=2, side=bottom))), "c1")
    assert code(f) == "CHAMFER_SIDE_NOT_ADJACENT"


def test_shell_errors():
    other = [sk("s2", [rect("x", 4, 4, center=(100, 0))]), ex("e2", "s2", 4)]
    f = feat(run(doc(*_box(), *other, {"type": "shell", "id": "sh1", "name": "h", "thickness": 1, "body": body_of("e1"),
                                         "open": {"kind": "face", "q": {"op": "cap", "feature": "e2", "end": "end"}}})),
             "sh1")
    assert code(f) == "SHELL_FACE_NOT_ON_BODY"
    cyl = doc(sk("s1", [circle("c", (0, 0), 2)]), ex("e1", "s1", 10),
              {"type": "shell", "id": "sh1", "name": "h", "thickness": 2.5, "body": body_of("e1"), "open": TOP_FACE})
    f = feat(run(cyl), "sh1")
    assert code(f) == "SHELL_THICKNESS_TOO_LARGE" and f["error"]["details"]["max_feasible_thickness"] < 2


def test_draft_tapers_planar_side_faces_with_the_analytic_normal():
    d = doc(*_box(), {"type": "draft", "id": "d1", "name": "taper", "neutral": "XY", "angle": 5,
                      "faces": {"kind": "face", "q": {"op": "sides", "feature": "e1"}}})
    f = feat(run(d), "d1")
    (b,) = f["bodies"]
    assert f["status"] == "ok" and b["faces"] == 6 and b["volume"] < 40 * 30 * 10
    # a prismatoid: the 40 × 30 base, sides leaning in by tan(5°) over 10 mm (exact: h/6·(A1 + 4Am + A2))
    k = 10 * math.tan(math.radians(5))
    a1, am, a2 = 40 * 30, (40 - k) * (30 - k), (40 - 2 * k) * (30 - 2 * k)
    assert rel(b["volume"], 10 / 6 * (a1 + 4 * am + a2)) < 1e-9


def test_draft_rejects_non_planar_faces():
    d = doc(*_box(r=3), {"type": "draft", "id": "d1", "name": "taper", "neutral": "XY", "angle": 5,
                         "faces": {"kind": "face", "q": {"op": "sides", "feature": "e1"}}})
    assert code(feat(run(d), "d1")) == "DRAFT_FACE_UNSUPPORTED"


# -- §8.3 rules 4 and 5 in kernel-diff --------------------------------------------------------------

def test_the_normative_spherical_corner_is_not_normalized():
    """Three convex edges between mutually perpendicular planes, one radius: a sphere patch (§6.6),
    compared as is."""
    f = feat(run(doc(*_box(), _fillet(2, edges=_edges({"op": "edges", "of": {"op": "body", "feature": "e1"}})))), "f1")
    assert f["status"] == "ok" and f["bodies"][0]["face_types"]["sphere"] == 8
    assert not any(w["code"] == "ORACLE_NORMALIZED" for w in f["warnings"])


def test_rule_5_corner_patches_relax_counts_and_mark_normalized():
    """Chamfer corners where three bevels meet are engine-defined (§8.3 rule 5)."""
    oracle = run(doc(*_box(), _chamfer(1, edges=_edges({"op": "edges", "of": {"op": "body", "feature": "e1"}}))))
    f = feat(oracle, "c1")
    assert f["status"] == "ok" and {"code": "ORACLE_NORMALIZED", "severity": "info"}.items() <= next(
        w for w in f["warnings"] if w["code"] == "ORACLE_NORMALIZED").items()
    forge = copy.deepcopy(oracle)
    for fe in forge["features"]:
        fe["warnings"] = [w for w in fe["warnings"] if w["code"] != "ORACLE_NORMALIZED"]
    bodies = [feat(forge, "c1")["bodies"][0]] + [p["bodies"][0] for p in forge["parts"]]
    for b in bodies:  # Forge's own corner patches: other counts, a volume 5e-6 off
        b["faces"] += 8
        b["face_types"] = {**b["face_types"], "bspline": 8}
        b["volume"] *= 1 + 5e-6
    cmp = compare_reports(forge, oracle)
    assert cmp.classification == NORMALIZED, [str(x) for x in cmp.differences]
    for b in bodies:
        b["volume"] *= 1 + 1e-4
    assert compare_reports(forge, oracle).classification == SILENT_WRONG


def test_rule_4_allows_bspline_blend_faces_where_forge_has_the_normative_type():
    oracle = run(doc(*_box(), _fillet(3)))
    forge = copy.deepcopy(oracle)
    fe = feat(oracle, "f1")
    fe["warnings"].append({"code": "ORACLE_NORMALIZED", "severity": "info", "message": "",
                           "details": {"rule": "4", "types": ["cylinder", "sphere", "torus"]}})
    for b in [fe["bodies"][0]] + [p["bodies"][0] for p in oracle["parts"]]:
        b["face_types"] = {"bspline": 1, "cylinder": 3, "plane": 6}
    cmp = compare_reports(forge, oracle)
    assert cmp.classification == NORMALIZED, [str(x) for x in cmp.differences]
    # rule 4 does not cover a plane that became a bspline
    for b in [fe["bodies"][0]] + [p["bodies"][0] for p in oracle["parts"]]:
        b["face_types"] = {"bspline": 1, "cylinder": 4, "plane": 5}
    assert compare_reports(forge, oracle).classification == SILENT_WRONG
    assert compare_reports(forge, copy.deepcopy(forge)).classification == MATCH


# -- W7b review 2: shells that must not come back unchanged, local width limits, circular edges --

def _poly(pts):
    return [{"kind": "line", "id": f"l{k}", "start": list(pts[k]), "end": list(pts[(k + 1) % len(pts)])}
            for k in range(len(pts))]


def _prism_shell(t):
    """A right-triangle prism (legs 10, height 20; inradius ρ = (20 − √200)/2 ≈ 2.929), top open."""
    return doc(sk("s1", _poly([(0, 0), (10, 0), (0, 10)])), ex("e1", "s1", 20), _shell_open_top(t))


RHO = (20 - math.sqrt(200)) / 2


@pytest.mark.parametrize("t", [3.0, 5.0, 8.0, 12.0])
def test_a_prism_shelled_past_its_inradius_is_too_large_never_unchanged(t):
    """Three walls closing in (no pair of parallel or coaxial walls): OCCT's `MakeThickSolid`
    returns the input body unchanged from t ≈ 5 on — valid, the opened top still there, the volume
    within 2e-13 of the input's — which a strict `v1 < v0` accepted as `ok`. The structural check
    (open face gone, every other face offset, a volume change beyond float noise) rejects it; the
    maximum is bisected from the body's diameter, so it is the same for every request."""
    f = feat(run(_prism_shell(t)), "sh1")
    assert code(f) == "SHELL_THICKNESS_TOO_LARGE", f.get("bodies")
    mx = f["error"]["details"]["max_feasible_thickness"]
    assert RHO - 0.01 < mx < RHO and mx == 2.927
    assert all(x["key"] for x in f["error"]["details"]["limits"])  # named faces, not empty keys


def test_a_prism_shell_below_the_inradius_is_in_closed_form():
    """The inner prism is the triangle offset inward by t (similar, scale (ρ − t)/ρ), t lower."""
    t = 1.0
    (b,) = feat(run(_prism_shell(t)), "sh1")["bodies"]
    assert rel(b["volume"], 50 * 20 - 50 * ((RHO - t) / RHO) ** 2 * (20 - t)) < 1e-9
    assert feat(run(_prism_shell(2.927)), "sh1")["status"] == "ok"


def _pipe_shell(t):
    """A tube (outer radius 5, inner 4, height 10) shelled inward, the top ring open."""
    return doc(sk("s1", [circle("o", (0, 0), 5), circle("i", (0, 0), 4)]), ex("e1", "s1", 10), _shell_open_top(t))


@pytest.mark.parametrize("t", [0.5, 0.55, 1.0, 2.0, 3.9])
def test_a_tube_shelled_past_its_wall_is_too_large(t):
    """The outer (convex) and inner (concave) cylinder are coaxial walls 1 mm apart: both offset,
    they meet at 0.5 (a double normal through the material, `_gap_limits`); OCCT returned the tube
    unchanged from t = 1 on, reported `ok`. Now the analytic limit decides: 0.499 for every t."""
    f = feat(run(_pipe_shell(t)), "sh1")
    assert code(f) == "SHELL_THICKNESS_TOO_LARGE", f.get("bodies")
    d = f["error"]["details"]
    assert d["max_feasible_thickness"] == 0.499
    assert {x["key"] for x in d["limits"]} == {"e1/side:o", "e1/side:i"}
    assert {x["reason"] for x in d["limits"]} == {"gap"}


@pytest.mark.parametrize("t", [0.3, 0.45, 0.499])
def test_a_tube_shell_below_half_its_wall_is_in_closed_form(t):
    (b,) = feat(run(_pipe_shell(t)), "sh1")["bodies"]
    assert rel(b["volume"], PI * 9 * 10 - PI * ((5 - t) ** 2 - (4 + t) ** 2) * (10 - t)) < 1e-9


@pytest.mark.parametrize("t", [5.5, 6.0, 8.0, 9.5])
def test_a_hole_near_a_wall_limits_the_shell_analytically(t):
    """40 × 30 × 20 box with an r = 5 bore: the bore and the long walls are 10 apart (a plane
    facing a cylinder whose axis is parallel to it): 4.999 whatever the request (it was bisected
    from the request: 4.997, 4.998, 4.996, 4.995)."""
    d = doc(sk("s1", [rect("o", 40, 30), circle("h", (0, 0), 5)]), ex("e1", "s1", 20), _shell_open_top(t))
    f = feat(run(d), "sh1")
    assert code(f) == "SHELL_THICKNESS_TOO_LARGE" and f["error"]["details"]["max_feasible_thickness"] == 4.999


def test_a_hole_near_a_wall_shell_in_closed_form():
    t = 4.0
    d = doc(sk("s1", [rect("o", 40, 30), circle("h", (0, 0), 5)]), ex("e1", "s1", 20), _shell_open_top(t))
    (b,) = feat(run(d), "sh1")["bodies"]
    body = (1200 - 25 * PI) * 20
    cavity = ((40 - 2 * t) * (30 - 2 * t) - PI * (5 + t) ** 2) * (20 - t)
    assert rel(b["volume"], body - cavity) < 1e-9


def test_shell_structure_rejects_the_unchanged_input():
    """`_shell_structure` on the input solid itself (what OCCT returned past a collision)."""
    from aicad_oracle.v1 import blends

    seen = {}
    real = blends._build_shell

    def spy(b, open_faces, t, inward, fid, check=True, why=None):
        seen["b"], seen["open"] = b, open_faces
        return real(b, open_faces, t, inward, fid, check=check, why=why)

    blends._build_shell = spy
    try:
        run(_pipe_shell(0.3))
    finally:
        blends._build_shell = real

    class _Unchanged:  # an empty history: nothing generated, nothing modified
        def Generated(self, s):
            return []

    b = seen["b"]
    lost = blends._shell_structure(b, seen["open"], b.solid, _Unchanged(), True)
    assert lost == []  # the opened face is still there


# the L-shaped cap of the review: the edge between the cap and `l2` (y = 20, x 20…30) has the
# cap's arm above it (80 mm) and the square below its line — the face's interior point
L_CAP = [(0, 0), (20, 0), (20, 20), (30, 20), (30, 100), (15, 100), (15, 20), (0, 20)]
L2_TOP = _edges({"op": "intersect", "of": [{"op": "edges", "of": {"op": "cap", "feature": "e1", "end": "end"}},
                                           {"op": "edges", "of": {"op": "side", "feature": "e1", "curve": "l2"}}]})


@pytest.mark.parametrize("r", [19, 25, 40, 59])
def test_the_width_limit_is_measured_on_the_faces_side_of_the_edge(r):
    """`w` is oriented into the face at the edge, not towards the face's interior point (which lies
    in the square across the edge's line): r = 25 and 40 were `FILLET_RADIUS_TOO_LARGE` with max
    19.999; the cut of a straight fillet over the 10 mm edge is `(1 − π/4)·r²·10`."""
    f = feat(run(doc(sk("s1", _poly(L_CAP)), ex("e1", "s1", 60), _fillet(r, edges=L2_TOP))), "f1")
    assert f["status"] == "ok", f.get("error")
    assert rel(f["bodies"][0]["volume"], 1600 * 60 - (1 - PI / 4) * r * r * 10) < 1e-9


def test_the_width_limit_on_the_faces_side_is_the_short_one():
    """The mirror of the review: a 3 mm strip above the edge, a square across its line; the limit
    is the strip's 3 mm (it was the square's 20)."""
    pts = [(0, 0), (20, 0), (20, 20), (30, 20), (30, 23), (-10, 23), (-10, 20), (0, 20)]
    f = feat(run(doc(sk("s1", _poly(pts)), ex("e1", "s1", 60), _fillet(5, edges=L2_TOP))), "f1")
    assert code(f) == "FILLET_RADIUS_TOO_LARGE" and f["error"]["details"]["max_feasible_r"] == 2.999
    (e,) = f["error"]["details"]["edges"]  # one entry per edge (deduplicated)
    assert e["face"] == "e1/cap:end@o" or e["face"].startswith("e1/cap:end")


def test_a_face_whose_far_side_is_an_arc_has_its_arc_as_the_width():
    """A D-shaped cap (flat edge on y = 0, a semicircle of R = 10 above it): no vertex lies across
    the flat edge, so the vertex-based extent was 0 and every fillet was too large (max 0). The
    extent is the arc's apex, 10 mm."""
    d_curves = [{"kind": "line", "id": "flat", "start": [10, 0], "end": [-10, 0]},
                {"kind": "arc", "id": "arc", "start": [-10, 0], "end": [10, 0], "center": [0, 0], "ccw": False}]
    top_flat = _edges({"op": "intersect", "of": [{"op": "edges", "of": {"op": "cap", "feature": "e1", "end": "end"}},
                                                 {"op": "edges", "of": {"op": "side", "feature": "e1", "curve": "flat"}}]})
    d = doc(sk("s1", d_curves), ex("e1", "s1", 30), _fillet(3, edges=top_flat))
    f = feat(run(d), "f1")
    assert f["status"] == "ok", f.get("error")
    removed = PI * 50 * 30 - f["bodies"][0]["volume"]
    assert 0.0 < removed < (1 - PI / 4) * 9 * 20
    g = feat(run(doc(sk("s1", d_curves), ex("e1", "s1", 30), _fillet(12, edges=top_flat))), "f1")
    assert code(g) == "FILLET_RADIUS_TOO_LARGE" and 0.0 < g["error"]["details"]["max_feasible_r"] <= 9.999


def _cyl_top(kind, x):
    blend = _fillet(x, edges=TOP) if kind == "fillet" else _chamfer(x, edges=TOP)
    return doc(sk("s1", [circle("c", (0, 0), 5)]), ex("e1", "s1", 20), blend)


@pytest.mark.parametrize("kind", ["fillet", "chamfer"])
@pytest.mark.parametrize("x", [5 - 5e-7, 5.0, 5 + 5e-7, 5.5, 8.0, 19.0, 25.0])
def test_a_cylinder_cap_blend_leaves_tol_of_the_cap(kind, x):
    """§6.6 on a circular edge (plane ⟂ axis, coaxial cylinder): the cap disc's extent is R, so the
    limit is R − tol — the same rule as for line edges. r = R was `ok` (the cap vanished: a sphere
    patch, 3 faces), R + 5e-7 reported max 5.0; the maxima were 4.997 … 5.0 depending on the
    request. Now every size past R − tol is too large with 4.999."""
    f = feat(run(_cyl_top(kind, x)), "f1" if kind == "fillet" else "c1")
    field = "max_feasible_r" if kind == "fillet" else "max_feasible_d"
    assert code(f) in ("FILLET_RADIUS_TOO_LARGE", "CHAMFER_DISTANCE_TOO_LARGE"), f.get("bodies")
    assert f["error"]["details"][field] == 4.999


@pytest.mark.parametrize("kind", ["fillet", "chamfer"])
def test_an_occt_failure_inside_the_analytic_limit_is_failed_not_too_large(kind):
    """W7b review 3: R − 2e-6 leaves 2e-6 of the cap — feasible by §6.6 (more than *tol*) — but
    OCCT fails there without evidence of a limit (no face lost, no blend running into another
    face). The oracle no longer asserts a `*_TOO_LARGE` it has not shown; review 5: nor §6.6's
    `*_FAILED` — the SPEC defines this blend, so OCCT's failure is engine-internal
    (`OCCT_*_FAILED`, ROBUSTNESS against any Forge outcome), with the largest size OCCT builds in
    the message."""
    f = feat(run(_cyl_top(kind, 5 - 2e-6)), "f1" if kind == "fillet" else "c1")
    assert code(f) == ("OCCT_FILLET_FAILED" if kind == "fillet" else "OCCT_CHAMFER_FAILED")
    assert set(f["error"]["details"]) == {"edges", "reason"} and "4.999" in f["error"]["message"]


@pytest.mark.parametrize("x", [1.0, 4.9, 4.999])
def test_a_cylinder_cap_fillet_is_a_torus_in_closed_form(x):
    """Pappus on the spandrel (square r × r minus a quarter disc; its centroid r/(6(1 − π/4)) from
    the disc's centre): the torus blend of §6.6."""
    (b,) = feat(run(_cyl_top("fillet", x)), "f1")["bodies"]
    a = (1 - PI / 4) * x * x
    rho = (5 - x) + x / (6 * (1 - PI / 4))
    assert b["face_types"] == {"cylinder": 1, "plane": 2, "torus": 1}
    assert rel(b["volume"], PI * 25 * 20 - 2 * PI * rho * a) < 1e-9


@pytest.mark.parametrize("x", [1.0, 4.9])
def test_a_cylinder_cap_chamfer_is_a_cone_in_closed_form(x):
    (b,) = feat(run(_cyl_top("chamfer", x)), "c1")["bodies"]
    assert b["face_types"] == {"cone": 1, "cylinder": 1, "plane": 2}
    assert rel(b["volume"], PI * 25 * 20 - 2 * PI * (5 - x / 3) * x * x / 2) < 1e-9


def test_a_blend_that_consumes_a_face_is_never_ok():
    """`_build_blend` rejects an OCCT result that lost a face (at r = R the cap is gone) even
    below an analytic limit; here directly, bypassing the limit."""
    from aicad_oracle.v1 import blends

    seen = {}
    real = blends._width_limits

    def no_limits(edges, setback):
        seen["edges"] = edges
        return []

    blends._width_limits = no_limits
    try:
        f = feat(run(_cyl_top("fillet", 5.0)), "f1")
    finally:
        blends._width_limits = real
    assert code(f) == "FILLET_RADIUS_TOO_LARGE" and f["error"]["details"]["max_feasible_r"] < 5.0


# an L profile (legs 25 wide beyond a 15 × 15 corner): the inner vertical edge is concave
L_PROFILE = [(0, 0), (40, 0), (40, 15), (15, 15), (15, 40), (0, 40)]
INNER = _edges({"op": "intersect", "of": [{"op": "edges", "of": {"op": "side", "feature": "e1", "curve": "l2"}},
                                          {"op": "edges", "of": {"op": "side", "feature": "e1", "curve": "l3"}}]})


@pytest.mark.parametrize("r", [10.0, 20.0, 24.999])
def test_a_concave_fillet_adds_material_in_closed_form(r):
    (b,) = feat(run(doc(sk("s1", _poly(L_PROFILE)), ex("e1", "s1", 20), _fillet(r, edges=INNER))), "f1")["bodies"]
    assert rel(b["volume"], 975 * 20 + (1 - PI / 4) * r * r * 20) < 1e-9


@pytest.mark.parametrize("r", [25.0, 30.0, 40.0, 60.0])
def test_a_concave_line_edge_has_the_analytic_setback(r):
    """The concave setback r / tan((2π − θ)/2) = r at 270°: the 25 mm walls give 24.999 whatever
    the request (it was bisected from the request: 14.99 … 24.98)."""
    f = feat(run(doc(sk("s1", _poly(L_PROFILE)), ex("e1", "s1", 20), _fillet(r, edges=INNER))), "f1")
    assert code(f) == "FILLET_RADIUS_TOO_LARGE" and f["error"]["details"]["max_feasible_r"] == 24.999
    assert len(f["error"]["details"]["edges"]) == 1


def test_blend_volume_direction_has_a_noise_margin():
    from aicad_oracle.v1 import blends

    class B:
        def __init__(self, v):
            self.v = v

        def body_metrics(self):
            return {"volume": self.v}

    class E:
        def __init__(self, b):
            self.body = b

    b = B(1000.0)
    e = E(b)
    orig = blends.convexity
    blends.convexity = lambda _e: "convex"
    try:
        blends._check_volume_direction([(b, B(1000.0 - 1e-10))], [e])  # a real cut
        blends._check_volume_direction([(b, B(1000.0 + 1e-13))], [e])  # within the noise: structure decides
        with pytest.raises(Exception, match="did not remove volume"):
            blends._check_volume_direction([(b, B(1000.0 + 1e-6))], [e])
    finally:
        blends.convexity = orig


def _hole_rim(r):
    rim = _edges({"op": "filter", "where": {"type": "circle"},
                  "of": {"op": "edges", "of": {"op": "cap", "feature": "e1", "end": "end"}}})
    return doc(sk("s1", [rect("o", 40, 40), circle("h", (0, 0), 3)]), ex("e1", "s1", 5), _fillet(r, edges=rim))


@pytest.mark.parametrize("r, ok", [(1.0, True), (4.999, True), (5.0, False), (6.0, False)])
def test_a_hole_rim_fillet_is_limited_by_the_bore_depth(r, ok):
    """A circle between the plate's top (outside the circle) and the bore (a concave cylinder): the
    bore's 5 mm along the axis limits r to 4.999; below it the torus blend of §6.6 (the spandrel
    revolved outside the bore: centroid at R + r − r/(6(1 − π/4)))."""
    f = feat(run(_hole_rim(r)), "f1")
    if not ok:
        assert code(f) == "FILLET_RADIUS_TOO_LARGE" and f["error"]["details"]["max_feasible_r"] == 4.999
        return
    (b,) = f["bodies"]
    a = (1 - PI / 4) * r * r
    rho = 3 + r - r / (6 * (1 - PI / 4))
    assert b["face_types"] == {"cylinder": 1, "plane": 6, "torus": 1}
    assert rel(b["volume"], 40 * 40 * 5 - PI * 9 * 5 - 2 * PI * rho * a) < 1e-9


def _boss_base(r):
    base = _edges({"op": "intersect", "of": [{"op": "edges", "of": {"op": "side", "feature": "e2", "curve": "b"}},
                                             {"op": "edges", "of": {"op": "cap", "feature": "e1", "end": "end"}}]})
    return doc(sk("s1", [rect("o", 40, 40)]), ex("e1", "s1", 5),
               sk("s2", [circle("b", (0, 0), 3)], plane={"face": TOP_FACE}),
               ex("e2", "s2", 10, op="join", targets=body_of("e1")), _fillet(r, edges=base))


@pytest.mark.parametrize("r, ok", [(1.0, True), (5.0, True), (9.999, True), (10.0, False), (12.0, False)])
def test_a_boss_base_fillet_adds_a_concave_torus_limited_by_the_boss(r, ok):
    """A concave circle (the plate's top outside the boss, the boss's convex cylinder): the boss's
    10 mm limit r to 9.999; the material added is the spandrel revolved at R + r − r/(6(1 − π/4))."""
    f = feat(run(_boss_base(r)), "f1")
    if not ok:
        assert code(f) == "FILLET_RADIUS_TOO_LARGE" and f["error"]["details"]["max_feasible_r"] == 9.999
        return
    (b,) = f["bodies"]
    a = (1 - PI / 4) * r * r
    rho = 3 + r - r / (6 * (1 - PI / 4))
    assert rel(b["volume"], 40 * 40 * 5 + PI * 9 * 10 + 2 * PI * rho * a) < 1e-9


# -- W7b review 3: the narrowest width across the edge, normative blends, closed outward shells,
# -- request-independent outward maxima, and limits only where they are shown ---------------------

TOP_X = _edges({"op": "filter", "where": {"parallel": "X"},
                "of": {"op": "edges", "of": {"op": "cap", "feature": "e1", "end": "end"}}})


def _box_hole(blend):
    """40 × 30 × 10 with a through hole r = 5 at (0, 8): the top face is 2 mm wide between the hole
    and the y = 15 edge (the review's case)."""
    return doc(sk("s1", [rect("o", 40, 30), circle("h", (0, 8), 5)]), ex("e1", "s1", 10), blend)


@pytest.mark.parametrize("kind, x", [("fillet", 2.05), ("fillet", 2.5), ("fillet", 3.0), ("fillet", 4.5),
                                     ("chamfer", 2.5), ("chamfer", 3.0)])
def test_a_hole_near_the_edge_limits_the_blend_to_the_narrowest_width(kind, x):
    """§6.6 "the width of the narrowest adjacent planar face across the edge": 2 mm, not the face's
    30 mm extent. The fillets were `ok` with a free-form patch where the ball ran into the hole
    (11 faces, a bspline, ORACLE_NORMALIZED, volumes 2e-5 … 8e-4 off the rolling ball); now the
    fillet and the chamfer give the same answer: too large, max 1.999, the y = 15 edge only."""
    blend = _fillet(x, edges=TOP_X) if kind == "fillet" else _chamfer(x, edges=TOP_X)
    f = feat(run(_box_hole(blend)), "f1" if kind == "fillet" else "c1")
    field = "max_feasible_r" if kind == "fillet" else "max_feasible_d"
    assert code(f) == ("FILLET_RADIUS_TOO_LARGE" if kind == "fillet" else "CHAMFER_DISTANCE_TOO_LARGE")
    d = f["error"]["details"]
    assert d[field] == 1.999
    (e,) = d["edges"]
    assert "side:o.top" in e["key"]
    if kind == "fillet":
        assert e["limit"] == "face-width" and e["face"] == "e1/cap:end@o.bottom"


@pytest.mark.parametrize("r", [0.5, 1.5, 1.999])
def test_a_fillet_below_the_hole_gap_is_the_rolling_ball_in_closed_form(r):
    """Two straight `(1 − π/4)·r²·40` fillets, the hole untouched (it stops at y = 13 < 15 − r)."""
    f = feat(run(_box_hole(_fillet(r, edges=TOP_X))), "f1")
    (b,) = f["bodies"]
    assert b["face_types"] == {"cylinder": 3, "plane": 6}
    assert not any(w["code"] == "ORACLE_NORMALIZED" for w in f["warnings"])
    assert rel(b["volume"], 12000 - PI * 25 * 10 - 2 * (1 - PI / 4) * r * r * 40) < 1e-9


def test_a_blend_that_runs_into_another_face_is_infeasible_even_without_the_width_limit():
    """The backstop (`_normative_blends_ok`): with the analytic limits switched off, OCCT's result at
    r = 2.5 (the edge's blend split by the hole and patched with a bspline) is not the §6.6 rolling
    ball, so the size is bisected like a failure — too large, below 2, the evidence edge only."""
    from aicad_oracle.v1 import blends

    real = blends._width_limits
    blends._width_limits = lambda edges, setback: []
    try:
        f = feat(run(_box_hole(_fillet(2.5, edges=TOP_X))), "f1")
    finally:
        blends._width_limits = real
    assert code(f) == "FILLET_RADIUS_TOO_LARGE", f.get("bodies")
    d = f["error"]["details"]
    assert 1.9 < d["max_feasible_r"] < 2.0
    (e,) = d["edges"]
    assert "side:o.top" in e["key"] and e["limit"] == "face-width" and "face" not in e


def test_an_off_centre_hole_in_a_cap_narrows_the_ring_across_the_rim():
    """A cylinder R = 10 with a through hole r = 2 at 5 mm from the axis: the cap ring is 3 mm wide
    between the rim and the hole (it was the cap's full radius, 10)."""
    def prog(r):
        return doc(sk("s1", [circle("c", (0, 0), 10), circle("h", (5, 0), 2)]), ex("e1", "s1", 20),
                   _fillet(r, edges=_edges({"op": "filter", "where": {"radius": {"eq": 10}},
                                            "of": {"op": "edges", "of": {"op": "cap", "feature": "e1", "end": "end"}}})))

    f = feat(run(prog(4)), "f1")
    assert code(f) == "FILLET_RADIUS_TOO_LARGE" and f["error"]["details"]["max_feasible_r"] == 2.999
    r = 2.9
    (b,) = feat(run(prog(r)), "f1")["bodies"]
    assert b["face_types"].get("torus") == 1 and "bspline" not in b["face_types"]
    rho = (10 - r) + r / (6 * (1 - PI / 4))
    assert rel(b["volume"], (PI * 100 - PI * 4) * 20 - 2 * PI * rho * (1 - PI / 4) * r * r) < 1e-9


def test_a_plate_edge_near_a_hole_rim_limits_the_rim_fillet():
    """A hole r = 3 whose rim comes 2 mm from the plate's y = 20 side: outside the circle the
    nearest other boundary sets the width (it was the farthest corner, ~25 mm)."""
    rim = _edges({"op": "filter", "where": {"type": "circle"},
                  "of": {"op": "edges", "of": {"op": "cap", "feature": "e1", "end": "end"}}})
    d = doc(sk("s1", [rect("o", 40, 40), circle("h", (0, 15), 3)]), ex("e1", "s1", 5), _fillet(2.5, edges=rim))
    f = feat(run(d), "f1")
    assert code(f) == "FILLET_RADIUS_TOO_LARGE" and f["error"]["details"]["max_feasible_r"] == 1.999


def test_limits_name_the_rule_that_bound_the_edge():
    """`face-width` for two blends sharing a face (the box's 30 mm walls; §6.6's own diagnostic
    reads "max feasible r = 3.41 (face width 6.82 …)") and for one edge's own face (the L cap's
    3 mm strip), `curvature` for a ball on a cylinder's concave side (a cap rim: the cap and the
    wall both give R − tol; the ball in a bore's air does not)."""
    from aicad_oracle.v1 import blends

    f = feat(run(doc(*_box(), _fillet(16))), "f1")
    es = f["error"]["details"]["edges"]
    assert {e["limit"] for e in es} == {"face-width"} and {e["face"] for e in es} == {
        "e1/side:o.left", "e1/side:o.right"}
    pts = [(0, 0), (20, 0), (20, 20), (30, 20), (30, 23), (-10, 23), (-10, 20), (0, 20)]
    g = feat(run(doc(sk("s1", _poly(pts)), ex("e1", "s1", 60), _fillet(5, edges=L2_TOP))), "f1")
    assert [e["limit"] for e in g["error"]["details"]["edges"]] == ["face-width"]
    seen = {}
    real = blends._curvature_limits

    def spy(edges):
        seen["out"] = real(edges)
        return seen["out"]

    blends._curvature_limits = spy
    try:
        run(_cyl_top("fillet", 1.0))
        (c,) = seen["out"]
        assert c["limit"] == "curvature" and c["max"] == pytest.approx(5 - 1e-6, abs=1e-12)
        run(_hole_rim(1.0))  # convex rim edge, concave bore: the ball is on the bore's convex side
        assert seen["out"] == []
        run(_boss_base(1.0))  # concave base edge, convex boss: the ball (in the air) on its convex side
        assert seen["out"] == []
    finally:
        blends._curvature_limits = real


def test_a_fillet_occt_fails_without_evidence_is_occt_fillet_failed():
    """Finding 3: below every analytic limit, an OCCT failure that leaves no evidence (no face
    lost, no blend running into another face) is not a `FILLET_RADIUS_TOO_LARGE` that asserts a
    limit; review 5: it is engine-internal `OCCT_FILLET_FAILED`, not §6.6's `FILLET_FAILED`; the
    message carries the largest size that builds."""
    from aicad_oracle.v1 import blends

    real = blends._build_blend

    def weak(b, edges, size, *a, **kw):
        return None if size > 2.0 else real(b, edges, size, *a, **kw)

    blends._build_blend = weak
    try:
        f = feat(run(doc(*_box(), _fillet(3))), "f1")
    finally:
        blends._build_blend = real
    assert code(f) == "OCCT_FILLET_FAILED" and set(f["error"]["details"]) == {"edges", "reason"}
    assert "the largest size it builds is 1.999" in f["error"]["message"], f["error"]["message"]


# closed shells: the void is the offset of the whole boundary (§6.8, 2 shells, SHELL_CLOSED_VOID)

def _closed(t, outward, *feats):
    s = {"type": "shell", "id": "sh1", "name": "hollow", "thickness": t, "body": body_of("e1")}
    if outward:
        s["direction"] = "outward"
    return doc(*feats, s)


@pytest.mark.parametrize("t", [0.5, 1.0, 3.0])
def test_a_closed_outward_box_shell_in_closed_form(t):
    """It was `SHELL_FAILED` for every body: the assembled solid had both shells oriented inward
    (volume −(22³ + 20³) on a 20 mm cube with t = 1)."""
    f = feat(run(_closed(t, True, sk("s1", [rect("o", 20, 30)]), ex("e1", "s1", 10))), "sh1")
    (b,) = f["bodies"]
    assert b["shells"] == 2 and [w["code"] for w in f["warnings"]] == ["SHELL_CLOSED_VOID"]
    assert rel(b["volume"], (20 + 2 * t) * (30 + 2 * t) * (10 + 2 * t) - 20 * 30 * 10) < 1e-9
    assert b["valid"] is True


@pytest.mark.parametrize("outward", [True, False])
def test_a_closed_cylinder_shell_in_closed_form(outward):
    t, R, H = 1.0, 5.0, 10.0
    (b,) = feat(run(_closed(t, outward, sk("s1", [circle("c", (0, 0), R)]), ex("e1", "s1", H))), "sh1")["bodies"]
    want = PI * (R + t) ** 2 * (H + 2 * t) - PI * R * R * H if outward else PI * R * R * H - PI * (R - t) ** 2 * (H - 2 * t)
    assert b["shells"] == 2 and rel(b["volume"], want) < 1e-9


@pytest.mark.parametrize("outward", [True, False])
def test_a_closed_u_prism_shell_in_closed_form(outward):
    """A mitered offset of a rectilinear polygon: area `A ± P·t + (c − k)·t²` (c convex, k reflex
    corners: 6 and 2 here; A = 288, P = 108)."""
    U = [(0, 0), (20, 0), (20, 20), (14, 20), (14, 6), (6, 6), (6, 20), (0, 20)]
    t = 0.5
    (b,) = feat(run(_closed(t, outward, sk("s1", _poly(U)), ex("e1", "s1", 20))), "sh1")["bodies"]
    s = 1 if outward else -1
    area = 288 + s * 108 * t + 4 * t * t
    want = area * (20 + 2 * t) - 288 * 20 if outward else 288 * 20 - area * (20 - 2 * t)
    assert b["shells"] == 2 and rel(b["volume"], want) < 1e-9


# an outward shell whose V-groove closes: request-independent, the groove's walls as the limit

V_NOTCH = [(0, 0), (20, 0), (20, 20), (16, 20), (10, 3), (4, 20), (0, 20)]


def _v_shell(t):
    return doc(sk("s1", _poly(V_NOTCH)), ex("e1", "s1", 20), {**_shell_open_top(t), "direction": "outward"})


def _mitered_area(pts, t):
    """The outward mitered offset of a simple CCW polygon: `A + P·t + t²·Σ cot(αᵢ/2)`, αᵢ the
    interior angles (negative cotangent at reflex corners)."""
    n = len(pts)
    area = 0.5 * sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    per = sum(math.dist(pts[i], pts[(i + 1) % n]) for i in range(n))
    cots = 0.0
    for i in range(n):
        a, b, c = pts[i - 1], pts[i], pts[(i + 1) % n]
        u, v = (a[0] - b[0], a[1] - b[1]), (c[0] - b[0], c[1] - b[1])
        # CCW polygon: the interior angle at b turns from u (to the previous vertex) to v clockwise
        interior = 2 * math.pi - (math.atan2(v[1], v[0]) - math.atan2(u[1], u[0])) % (2 * math.pi)
        cots += 1 / math.tan(interior / 2)
    return area + per * t + cots * t * t


@pytest.mark.parametrize("t", [8.6, 9.0, 12.0])
def test_an_outward_shell_past_a_closing_groove_has_one_maximum(t):
    """It was bisected from the request (8.473, 8.477, 8.478) with every face as a `gap` limit; now
    from the body's diameter — one value — and the limits are the groove's two walls, whose offset
    faces vanish at the maximum (walls closing in; reason `gap`)."""
    f = feat(run(_v_shell(t)), "sh1")
    assert code(f) == "SHELL_THICKNESS_TOO_LARGE"
    d = f["error"]["details"]
    assert d["max_feasible_thickness"] == 8.474
    assert {x["key"] for x in d["limits"]} == {"e1/side:l3", "e1/side:l4"} and {x["reason"] for x in d["limits"]} == {"gap"}


@pytest.mark.parametrize("t", [2.0, 5.0, 8.0])
def test_an_outward_shell_below_the_groove_limit_is_mitered(t):
    (b,) = feat(run(_v_shell(t)), "sh1")["bodies"]
    a0 = _mitered_area(V_NOTCH, 0.0)
    assert rel(b["volume"], _mitered_area(V_NOTCH, t) * (20 + t) - a0 * 20) < 1e-9


def test_a_shell_occt_fails_without_evidence_is_occt_shell_failed():
    """§6.8: `SHELL_THICKNESS_TOO_LARGE` when an offset degenerates or walls collide. An OCCT
    failure past 1.0 on a box (no analytic limit below 5, no face lost, no offset face vanishing at
    the maximum) is OCCT's own failure — it listed every face as a `gap`; review 5: engine-internal
    `OCCT_SHELL_FAILED`, not the catalogue `SHELL_FAILED` a Forge failure would MATCH."""
    from aicad_oracle.v1 import blends

    real = blends._build_shell

    def weak(b, open_faces, t, *a, **kw):
        return None if t > 1.0 else real(b, open_faces, t, *a, **kw)

    blends._build_shell = weak
    try:
        f = feat(run(doc(*_box(), _shell_open_top(2.0))), "sh1")
    finally:
        blends._build_shell = real
    assert code(f) == "OCCT_SHELL_FAILED" and "the largest thickness it builds is 0.999" in f["error"]["message"]


# -- W7b review 4: edges a blend does not create keep their keys -----------------------------------

def _all_edges(tid="t9"):
    return {"type": "tag", "id": tid, "name": f"all_{tid}", "target": {"kind": "edge", "card": "any",
                                                                        "q": {"op": "edges", "of": {"op": "bodies"}}}}


def _boss_on_box():
    return [*_box(), sk("s2", [circle("ring", (0, 0), 8)], plane={"face": TOP_FACE}),
            ex("e2", "s2", 10, op="join", targets=body_of("e1"))]


ROOT = _edges({"op": "between", "a": {"op": "side", "feature": "e2", "curve": "ring"},
               "b": {"op": "cap", "feature": "e1", "end": "end"}})
BOX_EDGES = sorted(f"e1/edge:{{e1/cap:{c}@o.bottom|e1/side:o.{s}}}" for c in ("start", "end")
                   for s in ("bottom", "left", "right", "top")) + [
    "e1/edge:{e1/side:o.bottom|e1/side:o.left}@o.bottom.start", "e1/edge:{e1/side:o.bottom|e1/side:o.right}@o.bottom.end",
    "e1/edge:{e1/side:o.left|e1/side:o.top}@o.left.start", "e1/edge:{e1/side:o.right|e1/side:o.top}@o.right.end"]
TOP_RING = "e2/edge:{e2/cap:end@ring|e2/side:ring}"


@pytest.mark.parametrize("kind", ["fillet", "chamfer"])
def test_an_untouched_ring_keeps_its_key_through_a_blend_of_the_root_ring(kind):
    """The review's case (forge-regen `fillet_then_chamfer_keys`): a blend of the boss's root ring
    does not touch the top ring, whose key stays `e2/edge:{…}` (§5.2 rule 3) — OCCT's `IsDeleted`
    said True for it, and the oracle gave it `f1/edge:{…}`, which the chamfer's report then listed
    (a false POTENTIAL_SILENT_WRONG against Forge). Every edge of the box keeps its key too."""
    blend = _fillet(2, ROOT) if kind == "fillet" else _chamfer(2, ROOT, fid="f1")
    rep = run(doc(*_boss_on_box(), blend, _all_edges(),
                  _chamfer(1, _edges({"op": "edges", "of": {"op": "cap", "feature": "e2", "end": "end"}}), fid="c1")))
    got = keys(feat(rep, "t9"))
    assert TOP_RING in got and set(BOX_EDGES) <= set(got)
    assert [k for k in got if k.startswith("f1/")] == sorted(k for k in got if k.startswith("f1/"))
    assert all("f1/blend:{" in k or "f1/bevel:{" in k for k in got if k.startswith("f1/"))
    assert feat(rep, "c1")["chamfer"]["edges"] == [TOP_RING]


def test_the_review_program_reports_the_kept_key():
    """forge-regen `tests/v1_programs/fillet_then_chamfer_keys.json`, as written."""
    d = json.loads((REPO / "forge/crates/forge-regen/tests/v1_programs/fillet_then_chamfer_keys.json").read_text())
    rep = run(d)
    assert feat(rep, "c1")["chamfer"]["edges"] == [TOP_RING]
    assert feat(rep, "c1")["chamfer"]["faces_created"] == [f"c1/bevel:{{{TOP_RING}}}"]


SIDES_REF = {"kind": "face", "q": {"op": "sides", "feature": "e1"}}


@pytest.mark.parametrize("op", ["fillet", "chamfer", "shell", "shell_closed", "draft"])
def test_trimmed_and_untouched_edges_keep_their_keys(op):
    """§5.2 rule 3: an entity an operation only modifies (trims, extends) keeps its key. Fillet and
    chamfer of the vertical edges trim the eight cap edges; the shell (top open) keeps the outer
    skin's twelve edges (the top four now border rims); the closed shell keeps all twelve; the
    draft tilts the sides, extending or trimming every edge. New edges bound created faces only."""
    f = {"fillet": _fillet(2), "chamfer": _chamfer(2, VERTICAL, fid="f1"),
         "shell": {"type": "shell", "id": "f1", "name": "sh", "thickness": 1, "body": body_of("e1"), "open": TOP_FACE},
         "shell_closed": {"type": "shell", "id": "f1", "name": "sh", "thickness": 1, "body": body_of("e1")},
         "draft": {"type": "draft", "id": "f1", "name": "taper", "neutral": "XY", "angle": 5, "faces": SIDES_REF}}[op]
    rep = run(doc(*_box(), f, _all_edges()))
    assert feat(rep, "f1")["status"] == "ok", feat(rep, "f1").get("error")
    got = keys(feat(rep, "t9"))
    kept = [k for k in got if k.startswith("e1/")]
    # the vertical (junction) edges carry a qualifier after the braces; fillet and chamfer blend them
    want = [k for k in BOX_EDGES if op not in ("fillet", "chamfer") or k.endswith("}")]
    assert sorted(kept) == sorted(want)
    new = [k for k in got if k.startswith("f1/")]
    created = ("f1/blend:{", "f1/bevel:{", "f1/offset:{", "f1/rim:{")
    assert all(any(c in k for c in created) for k in new), new
    if op == "draft":
        assert not new


def test_an_edge_without_history_takes_the_key_of_the_input_edge_on_its_carrier(monkeypatch):
    """The fallback of `name_history`: an OCCT history that reports no edge or vertex images (the
    trimmed cap edges of a vertical-edge fillet are new shapes) still gives each trimmed edge the
    key of the input edge between the same two kept faces on whose carrier it lies."""
    from aicad_oracle.v1 import blends

    base = run(doc(*_box(), _fillet(2), _all_edges()))
    real = blends.name_history

    class _NoEdgeHistory:
        def __init__(self, mk):
            self.mk = mk

        def Modified(self, s):
            from OCP.TopAbs import TopAbs_FACE

            return self.mk.Modified(s) if s.ShapeType() == TopAbs_FACE else []

        def __getattr__(self, n):
            return getattr(self.mk, n)

    monkeypatch.setattr(blends, "name_history", lambda solid, mk, *a, **kw: real(solid, _NoEdgeHistory(mk), *a, **kw))
    rep = run(doc(*_box(), _fillet(2), _all_edges()))
    assert keys(feat(rep, "t9")) == keys(feat(base, "t9"))
    # an edge between kept faces that matches no input edge is an explicit naming failure, never
    # a guessed `f1/edge:{…}`
    monkeypatch.setattr(blends, "_kept_edge_key", lambda *a: None)
    f = feat(run(doc(*_box(), _fillet(2))), "f1")
    assert code(f) == "OCCT_NAMING_FAILED" and "between kept faces" in f["error"]["message"]


def _named_body(d):
    """The oracle's named Body at the end of the one-body document `d`."""
    from aicad_oracle.v1 import evaluate as E

    seen = []
    real = E.PartState

    class _Recording(real):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            seen.append(self)

    E.PartState = _Recording
    try:
        run(d)
    finally:
        E.PartState = real
    (b,) = seen[0].bodies
    return b


def _named_box_body(z0):
    """The oracle's named Body of a 40 × 30 × 10 box extrude (`e1`, rect `o`) standing at `z0`."""
    return _named_body(doc(sk("s1", [rect("o", 40, 30)], plane={"origin": [0, 0, z0], "normal": [0, 0, 1],
                                                                  "x_dir": [1, 0, 0]}), ex("e1", "s1", 10)))


def test_kept_edge_key_needs_the_same_faces_and_the_carrier():
    """`_kept_edge_key` gives an input edge's key only to an edge between the same two faces (by
    key) lying on that edge's carrier: not to the same-named edge of a box 1 mm higher, nor to an
    edge between other faces."""
    from aicad_oracle.v1 import blends

    b1, b2 = _named_box_body(0.0), _named_box_body(1.0)
    k = "e1/edge:{e1/cap:end@o.bottom|e1/side:o.bottom}"
    e_up = next(x for x in b2.edges if x.key == k)
    fk = sorted(x.key for x in b2.faces_of_edge(e_up))
    assert blends._kept_edge_key(e_up, fk, b1) is None  # the same faces, another carrier (1 mm up)
    same = next(x for x in b1.edges if x.key == k)
    assert blends._kept_edge_key(same, fk, b1) == k
    assert blends._kept_edge_key(same, ["e1/cap:start@o.bottom", "e1/side:o.bottom"], b1) is None


def test_kept_edge_key_takes_the_collinear_input_edge_it_overlaps_never_the_smallest():
    """W7b review 5: a notch splits the box's top-front edge into two collinear pieces between the
    same two faces. Given different keys (as edges of different origins would have), each piece
    keeps its **own** key — the carrier alone matched both and took the byte-wise smallest — and an
    edge spanning both (the un-notched box's) overlaps two different keys: None with the reason (the
    caller's `OCCT_NAMING_FAILED`), never a guessed key. Pieces sharing one key are one."""
    from aicad_oracle.v1 import blends

    k = "e1/edge:{e1/cap:end@o.bottom|e1/side:o.bottom}"
    notched = _named_body(doc(*_notched_box(None)["parts"][0]["features"][:4]))  # the box and its notch
    left, right = sorted((x for x in notched.edges if x.key == k), key=lambda x: x.point()[0])
    fk = sorted(x.key for x in notched.faces_of_edge(left))
    assert blends._kept_edge_key(left, fk, notched) == k == blends._kept_edge_key(right, fk, notched)
    whole = next(x for x in _named_box_body(0.0).edges if x.key == k)
    assert blends._kept_edge_key(whole, fk, notched) == k  # split pieces sharing one key are one
    left.key, right.key = "e1/edge:{a}", "e1/edge:{b}"
    try:
        assert blends._kept_edge_key(left, fk, notched) == "e1/edge:{a}"
        assert blends._kept_edge_key(right, fk, notched) == "e1/edge:{b}"
        why: list = []
        assert blends._kept_edge_key(whole, fk, notched, why=why) is None
        assert why == ["it overlaps input edges with different keys ['e1/edge:{a}', 'e1/edge:{b}']"]
    finally:
        left.key = right.key = k


def test_kept_edge_key_resolves_the_operations_own_merge_aliases():
    """The result's face keys are canonical after the operation's own same-face merges: an input
    edge between faces the operation merged under another key still names the result edge."""
    from aicad_oracle.v1 import blends

    b1 = _named_box_body(0.0)
    k = "e1/edge:{e1/cap:end@o.bottom|e1/side:o.bottom}"
    same = next(x for x in b1.edges if x.key == k)
    merged = ["X/merged", "e1/side:o.bottom"]
    assert blends._kept_edge_key(same, merged, b1) is None
    assert blends._kept_edge_key(same, merged, b1, {"e1/cap:end@o.bottom": "X/merged"}) == k
    assert blends._resolve_key("a", {"a": "b"}, {"b": "c", "c": "c"}) == "c"
    assert blends._resolve_key("a", {"a": "b"}, {"b": "a"}) in ("a", "b")  # a cycle ends


# -- W7b review 5: OCCT's own failure on a shell the SPEC defines is engine-internal ----------------

def _notched_box(open_end, t=1.0):
    """The reviewer's case: a 40 × 30 × 10 box with a 10 × 5 × 5 notch cut from its front-top edge
    (the tool overshoots the front and the top by 1 mm), shelled inward by t with the notched top
    (`e1` cap end), the bottom or no face open."""
    s = {"type": "shell", "id": "sh1", "name": "hollow", "thickness": t, "body": body_of("e1")}
    if open_end:
        s["open"] = {"kind": "face", "q": {"op": "cap", "feature": "e1", "end": open_end}}
    return doc(*_box(), sk("s2", [rect("n", 10, 6, center=(0, -13))],
                           plane={"origin": [0, 0, 5], "normal": [0, 0, 1], "x_dir": [1, 0, 0]}),
               ex("e2", "s2", 6, op="cut", targets=body_of("e1")), s, name=f"notched_{open_end}")


def _notched_closed_form(open_end, t=1.0):
    """The body minus the cavity: the box offset inward by t (an open face not offset) minus the
    notch grown by t on its side walls, back wall and floor (`genops.shell_notched`)."""
    top, bottom = open_end != "end", open_end != "start"
    body = 40 * 30 * 10 - 10 * 5 * 5
    cavity = (40 - 2 * t) * (30 - 2 * t) * (10 - t * (top + bottom)) - (10 + 2 * t) * 5 * (5 + (0 if top else t))
    return body - cavity


@pytest.mark.parametrize("open_end, want", [("start", 2474.0), (None, 3538.0)])
def test_a_notched_box_shell_in_closed_form(open_end, want):
    assert _notched_closed_form(open_end) == want
    f = feat(run(_notched_box(open_end)), "sh1")
    assert f["status"] == "ok" and rel(sum(b["volume"] for b in f["bodies"]), want) < 1e-9
    assert ({w["code"] for w in f["warnings"]} & {"SHELL_CLOSED_VOID"}) == ({"SHELL_CLOSED_VOID"} if open_end is None
                                                                             else set())


def test_occt_failing_a_shell_the_spec_defines_is_engine_internal():
    """Open on its notched top the shell is 2534 mm³ in closed form (§6.8 defines it; Forge builds
    it); OCCT's `MakeThickSolid` returns the body unchanged at every thickness, which
    `_shell_structure` rejects. That is OCCT's failure, reported engine-internal —
    `OCCT_SHELL_FAILED` — so that a Forge failure there is never a MATCH on a shared catalogue
    code: both-fail and ok-vs-fail are ROBUSTNESS."""
    assert _notched_closed_form("end") == 2534.0
    oracle = run(_notched_box("end"))
    f = feat(oracle, "sh1")
    assert code(f) == "OCCT_SHELL_FAILED" and f["error"]["details"] == {"reason": "OCCT BRepOffsetAPI_MakeThickSolid failed"}
    for forge_code in ("SHELL_FAILED", "FORGE_SHELL_FAILED"):
        forge = copy.deepcopy(oracle)
        feat(forge, "sh1")["error"] = {"code": forge_code, "message": "", "details": {}}
        cmp = compare_reports(forge, oracle)
        assert cmp.classification == ROBUSTNESS, [str(x) for x in cmp.differences]
        assert any("engine-internal" in d.detail for d in cmp.differences)


@pytest.mark.parametrize("open_end", ["end", "start", None])
def test_forge_against_the_oracle_on_notched_box_shells(open_end, tmp_path):
    """End to end with Forge (skipped when the binary is not built): MATCH where OCCT shells the
    body, ROBUSTNESS (listed, not a MATCH) where it does not; Forge's volume is the closed form."""
    import os

    from aicad_oracle.diffrun import run_forge

    fb = Path(os.environ.get("AICAD_FORGE_BIN", Path(__file__).resolve().parents[2] / "forge/target/debug/aicad"))
    if not fb.is_file():
        if os.environ.get("CI"):
            pytest.fail(f"Forge binary {fb} is missing under CI (cargo build -p forge-cli)")
        pytest.skip(f"Forge binary {fb} not built (cargo build -p forge-cli)")
    d = _notched_box(open_end)
    path = tmp_path / "notched.json"
    path.write_text(json.dumps(d))
    forge, problem = run_forge(fb, path)
    assert forge is not None, problem
    ff = feat(forge, "sh1")
    assert ff["status"] == "ok" and rel(sum(b["volume"] for b in ff["bodies"]), _notched_closed_form(open_end)) < 1e-9
    cmp = compare_reports(forge, run(d))
    assert cmp.classification == (ROBUSTNESS if open_end == "end" else MATCH), [str(x) for x in cmp.differences]
