"""IR v1 evaluation by the oracle (SPEC-v1 §2, §3, §4, §5, §6.0–§6.4, §7): parameters, expression
fields, compound curves, datums and face frames, references, body operations, constrained-sketch
fixed points and replay, and the `aicad.metrics/1` report. Every body also passes the oracle's
gates (closed-form sweep predictions, boolean volume identities); every report validates against
`metrics-v1.schema.json` (`run`)."""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path

import pytest

from test_v1_support import (
    PI, P, body_of, cap, circle, code, doc, ex, feat, keys, param, rect, ref, rel, run, rv, sk,
)

REPO = Path(__file__).resolve().parents[2]
PROGRAMS = REPO / "corpus" / "v1" / "programs"


def _program(name: str) -> dict:
    return json.loads((PROGRAMS / name).read_text())


# ---------------------------------------------------------------------------------------------
# Parameters and expression fields (§2)
# ---------------------------------------------------------------------------------------------

def test_params_plate_example():
    rep = run(_program("params_plate.json"))
    assert rep["status"] == "ok"
    assert [(p["name"], p["scope"], p["unit"], p["value"]) for p in rep["params"]] == [
        ("width", "doc", "mm", 80.0), ("depth", "doc", "mm", 50.0), ("thick", "doc", "mm", 8.0)]
    (b,) = feat(rep, "e1")["bodies"]
    area = 80 * 50 - (4 - PI) * 4 * 4
    assert rel(b["volume"], area * 8) < 1e-9
    assert b["origin"] == {"feature": "e1", "member": "outline.bottom"} and b["change"] == "created"
    assert b["shells"] == 1 and b["face_types"] == {"cylinder": 4, "plane": 6}
    (pb,) = rep["parts"][0]["bodies"]
    assert pb["origin"] == b["origin"] and "change" not in pb
    s = feat(rep, "s1")
    assert s["sketch"]["mode"] == "explicit"
    assert [c["id"] for c in s["sketch"]["solved"]] == [f"outline.{m}" for m in
                                                          ("bottom", "c_br", "right", "c_tr", "top", "c_tl", "left", "c_bl")]


def test_part_parameters_derived_values_and_scopes():
    d = doc(sk("s1", [rect("r", w="w", h="inner")]), ex("e1", "s1", "t"),
            params=[P("w", "mm", 20), P("wall", "mm", 2.5)],
            part_params=[P("inner", "mm", "w - 2 * wall"), P("t", "mm", "inner / 3")])
    rep = run(d)
    assert rep["status"] == "ok"
    assert param(rep, "inner") == {"name": "inner", "scope": "part", "unit": "mm", "value": 15.0}
    assert param(rep, "t")["value"] == 5.0
    assert rel(feat(rep, "e1")["bodies"][0]["volume"], 20 * 15 * 5) < 1e-12


def test_failed_parameter_propagates_param_failed():
    d = doc(sk("s1", [rect("r", w="bad", h=5)]), ex("e1", "s1", 3),
            sk("s2", [circle("c", (100, 0), 2)]), ex("e2", "s2", "twice"), ex("e3", "s2", 4),
            params=[P("zero", "ratio", 0), P("bad", "mm", "10 / zero"), P("twice", "mm", "bad * 2")])
    rep = run(d)
    assert rep["status"] == "error"
    assert param(rep, "bad")["error"]["code"] == "EXPR_DOMAIN"
    assert param(rep, "twice")["error"]["code"] == "PARAM_FAILED"
    assert param(rep, "twice")["error"]["details"] == {"param": "bad", "code": "EXPR_DOMAIN"}
    assert code(feat(rep, "s1")) == "PARAM_FAILED"
    assert code(feat(rep, "e1")) == "DEPENDENCY_FAILED"
    assert code(feat(rep, "e2")) == "PARAM_FAILED"
    assert feat(rep, "e3")["status"] == "ok"  # evaluation continues (§7.1)


def test_param_bounds_are_checked_after_evaluation():
    d = doc(sk("s1", [circle("c", (0, 0), "r")]), ex("e1", "s1", 1),
            params=[P("base", "mm", 10), P("r", "mm", "base * 3", max=25)])
    rep = run(d)
    assert param(rep, "r")["error"]["code"] == "PARAM_OUT_OF_RANGE"
    assert code(feat(rep, "s1")) == "PARAM_FAILED"


@pytest.mark.parametrize("field, value, want", [
    ("distance", "t - 10", "INVALID_DISTANCE"),
    ("distance", "t / (t - 8) * 1 mm", "EXPR_DOMAIN"),
])
def test_expression_range_checks_use_the_literal_codes(field, value, want):
    d = doc(sk("s1", [rect()]), ex("e1", "s1", value), params=[P("t", "mm", 8)])
    rep = run(d)
    assert code(feat(rep, "e1")) == want


def test_revolve_angle_expression_out_of_range():
    d = doc(sk("s1", [rect("r", 2, 2, center=(5, 0))]), rv("r1", "s1", "a * 2"), params=[P("a", "deg", 200)])
    assert code(feat(run(d), "r1")) == "INVALID_ANGLE"


def test_count_field_must_be_an_integer_at_evaluation():
    d = doc(sk("s1", [{"kind": "polygon", "id": "p", "center": [0, 0], "n": "k / 2", "circumradius": 5}]),
            params=[P("k", "count", 7)])
    assert code(feat(run(d), "s1")) == "EXPR_NOT_INTEGER"


def test_suppressed_by_a_bool_expression():
    d = doc(sk("s1", [rect()]), ex("e1", "s1", 1, suppressed="!keep"), ex("e2", "s1", 2, suppressed="keep"),
            params=[P("keep", "bool", True)])
    rep = run(d)
    assert [f["feature_id"] for f in rep["features"]] == ["s1", "e1"]
    assert param(rep, "keep")["value"] is True


# ---------------------------------------------------------------------------------------------
# Compound curves (§4.1) through evaluation
# ---------------------------------------------------------------------------------------------

def test_rect_with_half_height_radius_is_a_stadium():
    w, h = 30.0, 10.0
    d = doc(sk("s1", [rect("o", w="w", h="h", r="h / 2")]), ex("e1", "s1", 2),
            params=[P("w", "mm", w), P("h", "mm", h)])
    rep = run(d)
    (region,) = feat(rep, "s1")["regions"]
    assert region["outer_curves"] == ["o.bottom", "o.c_bl", "o.c_br", "o.c_tl", "o.c_tr", "o.top"]
    r = h / 2
    assert rel(region["area"], w * h - (4 - PI) * r * r) < 1e-12
    # new bodies are not same-domain merged (§6.0.4 applies after body operations): the two
    # quarter arcs of each end stay two faces
    assert feat(rep, "e1")["bodies"][0]["face_types"] == {"cylinder": 4, "plane": 4}


def test_slot_and_polygon_areas():
    d = doc(sk("s1", [{"kind": "slot", "id": "sl", "a": [0, 0], "b": ["L * cos(30)", "L * sin(30)"], "w": 4}]),
            sk("s2", [{"kind": "polygon", "id": "hx", "center": [50, 0], "n": 6, "across_flats": 10}]),
            params=[P("L", "mm", 20)])
    rep = run(d)
    assert rel(feat(rep, "s1")["regions"][0]["area"], 20 * 4 + PI * 4) < 1e-12
    R = 10 / (2 * math.cos(math.pi / 6))
    assert rel(feat(rep, "s2")["regions"][0]["area"], 6 / 2 * R * R * math.sin(math.pi / 3)) < 1e-12


def test_huge_polygon_counts_never_hang():
    """`n` up to MAX_COUNT_MAGNITUDE (2^31) is valid; the oracle must not loop 2^31 times."""
    import time

    from aicad_oracle.v1 import compound

    t0 = time.monotonic()
    # every side ≤ tol/2: every member is omitted (§4.1), computed without the loop
    assert compound.expand_polygon("p", [0.0, 0.0], 2.0 ** 31, "circumradius", 10.0, 0.0) == []
    # sides longer than tol, too many of them: an engine-internal resource limit
    with pytest.raises(compound.CompoundError) as e:
        compound.expand_polygon("p", [0.0, 0.0], 2.0 ** 31, "circumradius", 1000.0, 0.0)
    assert e.value.code == "ORACLE_RESOURCE_LIMIT"
    assert time.monotonic() - t0 < 5.0
    # at the limit it still expands; the members are the SPEC's
    ms = compound.expand_polygon("p", [0.0, 0.0], float(compound.MAX_POLYGON_SIDES), "circumradius", 1e4, 0.0)
    assert len(ms) == compound.MAX_POLYGON_SIDES
    # end to end: the feature fails engine-internally (ROBUSTNESS in the diff), evaluation continues
    d = doc(sk("s1", [{"kind": "polygon", "id": "p", "center": [0, 0], "n": "2^31", "circumradius": 1000}]),
            sk("s2", [rect("r", 4, 4)]))
    rep = run(d)
    assert code(feat(rep, "s1")) == "ORACLE_RESOURCE_LIMIT" and feat(rep, "s2")["status"] == "ok"


def test_new_body_sweeps_are_not_same_domain_merged():
    """Pinned behaviour for a SPEC question (README, contract issues): §6.0.4 / §8.3 rule 1 say
    "after every body operation"; the oracle applies the merge after join/cut/intersect/boolean
    only, not to a new_body extrude or revolve, which stays the v0 construction (one side face
    per profile curve, so each side keeps its own `side:<curve>` key, and migrated v0 programs
    keep their v0 metrics bit for bit, §9.1). Two collinear adjacent lines therefore give two
    coplanar side faces on a new body; the same prism joined onto another body is merged."""
    outline = [{"kind": "line", "id": "b1", "start": [-5, -5], "end": [0, -5]},
               {"kind": "line", "id": "b2", "start": [0, -5], "end": [5, -5]},
               {"kind": "line", "id": "r", "start": [5, -5], "end": [5, 5]},
               {"kind": "line", "id": "t", "start": [5, 5], "end": [-5, 5]},
               {"kind": "line", "id": "l", "start": [-5, 5], "end": [-5, -5]}]
    rep = run(doc(sk("s1", outline), ex("e1", "s1", 2)))
    (b,) = feat(rep, "e1")["bodies"]
    assert b["faces"] == 7 and b["face_types"] == {"plane": 7}
    rep = run(doc(sk("s0", [rect("base", 10, 10)]), ex("e0", "s0", 2), sk("s1", outline),
                  ex("e1", "s1", 2, op="join", targets=body_of("e0"))))
    (b,) = feat(rep, "e1")["bodies"]
    assert b["faces"] == 6 and b["face_types"] == {"plane": 6}


def test_points_and_construction_curves_are_not_profile():
    d = doc(sk("s1", [rect("o", 10, 10), {"kind": "point", "id": "pt", "at": [0, 0]},
                      {"kind": "line", "id": "g", "start": [-20, 0], "end": [20, 0], "construction": True}]))
    s = feat(run(d), "s1")
    assert s["status"] == "ok" and len(s["regions"]) == 1
    kinds = [(c["id"], c["kind"], c.get("construction", False)) for c in s["sketch"]["solved"]]
    assert ("pt", "point", False) in kinds and ("g", "line", True) in kinds


def test_invalid_compound_size_at_evaluation():
    d = doc(sk("s1", [rect("o", w=10, h="hh")]), params=[P("hh", "mm", "0 - 1")])
    assert code(feat(run(d), "s1")) == "INVALID_VALUE"


def test_region_selection_by_member_and_region_not_found():
    curves = [rect("a", 10, 10, center=(-20, 0)), circle("b", (20, 0), 3), circle("hole", (-20, 0), 2)]
    rep = run(doc(sk("s1", curves), ex("e1", "s1", 1, regions=["a.top"]), ex("e2", "s1", 1, regions=["hole"])))
    (b,) = feat(rep, "e1")["bodies"]
    assert b["origin"]["member"] == "a.bottom" and rel(b["volume"], 100 - PI * 4) < 1e-12
    assert code(feat(rep, "e2")) == "REGION_NOT_FOUND"


# ---------------------------------------------------------------------------------------------
# Datums and face frames (§3)
# ---------------------------------------------------------------------------------------------

def _datum(rep, fid):
    return feat(rep, fid)["datum"]


def _close(a, b, tol=1e-12):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def test_datum_planes_and_axes():
    d = doc(
        {"type": "datum_plane", "id": "d1", "name": "off", "mode": "offset", "from": "XY", "distance": "z"},
        {"type": "datum_plane", "id": "d2", "name": "tilt", "mode": "angle", "from": "XY", "axis": "X", "angle": 30},
        {"type": "datum_plane", "id": "d3", "name": "mid", "mode": "midplane", "a": "XY", "b": {"datum": "d1"}},
        {"type": "datum_plane", "id": "d4", "name": "thr", "mode": "through",
         "points": [[0, 0, 0], [10, 0, 0], [0, 10, 0]]},
        {"type": "datum_plane", "id": "d5", "name": "frm", "mode": "frame", "origin": [1, 2, 3],
         "normal": [0, 0, 2], "x_dir": [0, 3, 0]},
        {"type": "datum_axis", "id": "a1", "name": "hinge", "mode": "planes", "a": "XZ", "b": {"datum": "d2"}},
        {"type": "datum_axis", "id": "a2", "name": "diag", "mode": "points", "points": [[1, 1, 1], [3, 1, 1]],
         "flip": True},
        params=[P("z", "mm", 12)])
    rep = run(d)
    assert rep["status"] == "ok"
    assert _datum(rep, "d1") == {"origin": [0.0, 0.0, 12.0], "x": [1.0, 0.0, 0.0], "y": [0.0, 1.0, 0.0],
                                 "normal": [0.0, 0.0, 1.0]}
    d2 = _datum(rep, "d2")  # right-hand rule about +X: +Z turns towards −Y (exact table angle)
    assert d2["normal"] == [0.0, -0.5, 0.8660254037844386] and d2["y"] == [0.0, 0.8660254037844386, 0.5]
    assert _datum(rep, "d3")["origin"] == [0.0, 0.0, 6.0]
    assert _datum(rep, "d4")["normal"] == [0.0, 0.0, 1.0]
    d5 = _datum(rep, "d5")
    assert d5["x"] == [0.0, 1.0, 0.0] and d5["y"] == [-1.0, 0.0, 0.0] and d5["origin"] == [1.0, 2.0, 3.0]
    a1 = _datum(rep, "a1")
    assert _close(a1["direction"], [1.0, 0.0, 0.0]) and _close(a1["origin"], [0.0, 0.0, 0.0])
    assert _datum(rep, "a2") == {"origin": [1.0, 1.0, 1.0], "direction": [-1.0, 0.0, 0.0]}


def test_degenerate_datums_fail():
    d = doc({"type": "datum_plane", "id": "d1", "name": "bad", "mode": "angle", "from": "XY", "axis": "Z", "angle": 10},
            {"type": "datum_plane", "id": "d2", "name": "col", "mode": "through", "points": [[0, 0, 0], [1, 1, 1], [2, 2, 2]]},
            {"type": "datum_axis", "id": "a1", "name": "par", "mode": "planes", "a": "XY",
             "b": {"datum": "d0"}} if False else
            {"type": "datum_axis", "id": "a1", "name": "same", "mode": "points", "points": [[1, 1, 1], [1, 1, 1]]})
    rep = run(d)
    assert [code(f) for f in rep["features"]] == ["DATUM_DEGENERATE"] * 3


@pytest.mark.parametrize("p1, p2, degenerate", [
    # §3.3 exactly: collinear iff |(p1 − p0) × (p2 − p0)| ≤ tol·|p1 − p0|
    ([5e-7, 0, 0], [0, 10, 0], False),  # |p1 − p0| ≤ tol but p2 far away: a valid frame
    ([0, 0, 0], [0, 10, 0], True),  # p1 = p0
    ([10, 0, 0], [20, 0.9e-6, 0], True),  # |cross| = 9e-6 ≤ 1e-6 · 10
    ([10, 0, 0], [20, 1.1e-6, 0], False),
])
def test_datum_plane_through_collinearity_is_the_spec_criterion(p1, p2, degenerate):
    d = doc({"type": "datum_plane", "id": "d1", "name": "thr", "mode": "through", "points": [[0, 0, 0], p1, p2]})
    f = feat(run(d), "d1")
    if degenerate:
        assert code(f) == "DATUM_DEGENERATE"
    else:
        assert f["status"] == "ok", f.get("error")
        assert f["datum"]["origin"] == [0.0, 0.0, 0.0]
        assert abs(abs(f["datum"]["normal"][2]) - 1.0) < 1e-12 and f["datum"]["x"][0] == 1.0


def test_datum_plane_through_with_nearly_coincident_p0_p1_is_ill_conditioned_by_the_spec():
    """Documents a contract gap (reported to the SPEC owner): §3.3 rejects only collinear points
    (`|cross| ≤ tol·|p1 − p0|`), not `|p1 − p0| ≤ tol` as `datum_axis` `points` does, so with
    `|p1 − p0| = 1e-9` and `p2` far away `x = normalize(p1 − p0)` is set by sub-tolerance noise:
    moving p1 by 1e-12 mm (vertex positions of two kernels differ by that much) turns x by 1e-3 rad,
    which kernel-diff (directions at 1e-9, §8.2) calls POTENTIAL_SILENT_WRONG. The oracle follows the
    SPEC as written."""
    from aicad_oracle.v1.compare import SILENT_WRONG, compare_reports

    def rep(p1):
        return run(doc({"type": "datum_plane", "id": "d1", "name": "thr", "mode": "through",
                        "points": [[0, 0, 0], p1, [0, 10, 0]]}))

    a, b = rep([1e-9, 0, 0]), rep([1e-9, 1e-12, 0])
    assert feat(a, "d1")["status"] == feat(b, "d1")["status"] == "ok"
    xa, xb = feat(a, "d1")["datum"]["x"], feat(b, "d1")["datum"]["x"]
    assert abs(xa[1] - xb[1]) > 1e-4
    assert compare_reports(a, b).classification == SILENT_WRONG


# The §3.1 table: outward normal → (x, y) of the face frame.
FACE_TABLE = {
    "cap:end": ((0, 0, 1), (1, 0, 0), (0, 1, 0)),
    "cap:start": ((0, 0, -1), (1, 0, 0), (0, -1, 0)),
    "side:r.bottom": ((0, -1, 0), (1, 0, 0), (0, 0, 1)),
    "side:r.top": ((0, 1, 0), (1, 0, 0), (0, 0, -1)),
    "side:r.right": ((1, 0, 0), (0, 1, 0), (0, 0, 1)),
    "side:r.left": ((-1, 0, 0), (0, 1, 0), (0, 0, -1)),
}


@pytest.mark.parametrize("face", sorted(FACE_TABLE))
def test_face_frames_follow_the_spec_table(face):
    role, _, rest = face.partition(":")
    q = ({"op": "cap", "feature": "e1", "end": rest} if role == "cap"
         else {"op": "side", "feature": "e1", "curve": rest})
    d = doc(sk("s1", [rect("r", 20, 10)]), ex("e1", "s1", 4),
            {"type": "datum_plane", "id": "d1", "name": "on", "mode": "offset",
             "from": {"face": ref("face", q)}, "distance": 0})
    rep = run(d)
    dt = _datum(rep, "d1")
    n, x, y = FACE_TABLE[face]
    assert _close(dt["normal"], n) and _close(dt["x"], x) and _close(dt["y"], y), dt
    # the origin is the projection of the world origin onto the face plane
    assert abs(sum(a * b for a, b in zip(dt["origin"], n)) - sum(a * b for a, b in zip(
        {"cap:end": (0, 0, 4), "cap:start": (0, 0, 0), "side:r.bottom": (0, -5, 0), "side:r.top": (0, 5, 0),
         "side:r.right": (10, 0, 0), "side:r.left": (-10, 0, 0)}[face], n))) < 1e-12


def test_plane_not_planar():
    d = doc(sk("s1", [circle("c", (0, 0), 5)]), ex("e1", "s1", 4),
            sk("s2", [circle("k", (0, 0), 1)], plane={"face": ref("face", {"op": "side", "feature": "e1", "curve": "c"})}))
    assert code(feat(run(d), "s2")) == "PLANE_NOT_PLANAR"


def test_dependency_on_a_suppressed_datum():
    d = doc({"type": "datum_plane", "id": "d1", "name": "dp", "mode": "offset", "from": "XY", "distance": 5,
             "suppressed": True},
            sk("s1", [rect()], plane={"datum": "d1"}))
    assert code(feat(run(d), "s1")) == "DEPENDENCY_SUPPRESSED"


def test_sketch_suppressed():
    d = doc(sk("s1", [rect()], suppressed=True), ex("e1", "s1", 1))
    assert code(feat(run(d), "e1")) == "SKETCH_SUPPRESSED"


# ---------------------------------------------------------------------------------------------
# References (§5)
# ---------------------------------------------------------------------------------------------

def test_knob_queries_resolve_to_spec_keys():
    rep = run(_program("knob_queries.json"))
    assert keys(feat(rep, "q1")) == ["r1/endcap:start@axis_seg"]
    assert keys(feat(rep, "q2")) == ["r1/side:bottom", "r1/side:rim", "r1/side:top"]
    assert keys(feat(rep, "q8")) == ["r1/side:rim", "r1/side:top"]
    assert keys(feat(rep, "q9")) == ["r1/edge:{r1/side:rim|r1/side:top}@rim.start"]
    assert keys(feat(rep, "q10")) == ["r1/side:bottom", "r1/side:rim"]
    # W7b: the pattern pt1 now copies r1, so the largest faces tie with the copy's
    assert keys(feat(rep, "q12")) == ["pt1/copy:{r1/side:rim}@1", "r1/side:rim"]
    assert keys(feat(rep, "q14")) == ["r1/side:rim"]
    # W7b: the blind hole's wall/tip edge and the pattern copy's inner corner are concave too
    assert keys(feat(rep, "q16")) == ["h1/edge:{h1/tip@c|h1/wall@c}",
                                      "pt1/copy:{r1/edge:{r1/endcap:end@axis_seg|r1/endcap:start@axis_seg}}@1",
                                      "r1/edge:{r1/endcap:end@axis_seg|r1/endcap:start@axis_seg}"]
    assert keys(feat(rep, "q23")) == ["pt1/copy:{r1/side:top}@1"]  # the copy is farther along the pattern dir
    q15 = keys(feat(rep, "q15"))  # r1's 4 endcap lines ⟂ Z, and its 2 circles whose normal ∥ Z
    own = [k for k in q15 if k.startswith("r1/")]
    assert len(own) == 6 and sum("}@" in k for k in own) == 2
    # W7b: the rest are the hole's circles and the pattern copy's edges
    assert all(k.startswith(("h1/", "pt1/copy:")) for k in q15 if not k.startswith("r1/"))
    # W7b: the hole is evaluated, so its named source resolves to the wall of position c
    assert keys(feat(rep, "q5")) == ["h1/wall@c"]
    for f in rep["features"]:
        for r in f.get("refs") or []:
            for m in r["members"]:
                assert m["probe"]["kind"] in ("face", "edge", "vertex", "body") and len(m["probe"]["point"]) == 3


def test_sketch_on_a_tagged_face_and_join():
    rep = run(_program("plate_features.json"))
    assert keys(feat(rep, "t1")) == ["e1/cap:end@outline.bottom"]
    assert keys(feat(rep, "s2"), "/plane/face") == ["e1/cap:end@outline.bottom"]
    (b,) = feat(rep, "e2")["bodies"]
    plate = 80 * 50 - (4 - PI) * 16
    assert b["origin"]["feature"] == "e1" and b["change"] == "modified"
    assert rel(b["volume"], plate * 8 + PI * 121 * 12) < 1e-9
    # W7b: the M5 counterbored through holes (cbore 10 x 5.4, bore 5.5) in the 8 mm plate
    (h,) = feat(rep, "h1")["bodies"]
    one = PI * 5 ** 2 * 5.4 + PI * 2.75 ** 2 * (8 - 5.4)
    assert rel(h["volume"], plate * 8 + PI * 121 * 12 - 4 * one) < 1e-9


def test_cardinality_violations():
    d = doc(sk("s1", [rect("r", 10, 10)]), ex("e1", "s1", 2),
            {"type": "tag", "id": "t1", "name": "one_of_four", "target": ref("face", {"op": "sides", "feature": "e1"}, card="one")},
            {"type": "tag", "id": "t2", "name": "three", "target": ref("face", {"op": "sides", "feature": "e1"}, card=3)},
            {"type": "tag", "id": "t3", "name": "none", "target": ref("edge", {"op": "filter", "where": {"radius": {"eq": 1}},
                                                                            "of": {"op": "edges", "of": {"op": "bodies"}}})})
    rep = run(d)
    assert [code(feat(rep, t)) for t in ("t1", "t2", "t3")] == ["REF_AMBIGUOUS", "REF_CARDINALITY", "REF_MISSING"]


# ---------------------------------------------------------------------------------------------
# Body operations (§6.0.3, §6.2, §6.4)
# ---------------------------------------------------------------------------------------------

def _plate(t=4):
    return [sk("s1", [rect("r", 20, 10)]), ex("e1", "s1", t)]


def test_cut_through_splits_the_target():
    d = doc(*_plate(), sk("s2", [rect("k", 2, 30)], plane=cap("e1")),
            ex("e2", "s2", 100, direction="reverse", op="cut", targets=body_of("e1")))
    rep = run(d)
    f = feat(rep, "e2")
    assert f["status"] == "ok" and [w["code"] for w in f["warnings"]] == ["BOOLEAN_SPLIT"]
    assert len(f["bodies"]) == 2 and all(b["origin"] == {"feature": "e1", "member": "r.bottom"} for b in f["bodies"])
    assert rel(sum(b["volume"] for b in f["bodies"]), 18 * 10 * 4) < 1e-9
    assert len(rep["parts"][0]["bodies"]) == 2


def test_cut_that_consumes_the_target():
    d = doc(*_plate(), sk("s2", [rect("k", 40, 40)], plane=cap("e1")),
            ex("e2", "s2", 100, direction="reverse", op="cut", targets="all"))
    rep = run(d)
    f = feat(rep, "e2")
    assert [w["code"] for w in f["warnings"]] == ["BOOLEAN_BODY_CONSUMED"]
    assert f["removed"] == [{"feature": "e1", "member": "r.bottom"}] and rep["parts"][0]["bodies"] == []


def test_detached_join_is_an_error():
    d = doc(*_plate(), sk("s2", [circle("c", (100, 0), 2)]), ex("e2", "s2", 2, op="join", targets=body_of("e1")))
    f = feat(run(d), "e2")
    assert code(f) == "BOOLEAN_NO_INTERSECTION" and f["error"]["details"]["min_distance"] > 70


def test_cut_missing_the_target_is_an_error():
    d = doc(*_plate(), sk("s2", [circle("c", (100, 0), 2)]), ex("e2", "s2", 2, op="cut", targets="all"))
    assert code(feat(run(d), "e2")) == "BOOLEAN_NO_INTERSECTION"


def test_intersect_and_standalone_boolean():
    d = doc(*_plate(), sk("s2", [circle("c", (10, 0), 3)]), ex("e2", "s2", 10, direction="symmetric"),
            {"type": "boolean", "id": "b1", "name": "common", "op": "intersect", "targets": body_of("e1"),
             "tools": body_of("e2")})
    rep = run(d)
    (b,) = feat(rep, "b1")["bodies"]
    assert rel(b["volume"], PI * 9 / 2 * 4) < 1e-9 and b["origin"]["feature"] == "e1"
    assert len(rep["parts"][0]["bodies"]) == 1  # the tool is consumed (keep_tools false)


def test_boolean_tool_is_target():
    d = doc(*_plate(), {"type": "boolean", "id": "b1", "name": "self", "op": "join", "targets": body_of("e1"),
                        "tools": body_of("e1")})
    assert code(feat(run(d), "b1")) == "BOOLEAN_TOOL_IS_TARGET"


def test_join_keeps_the_target_keys_and_merges_coplanar_faces():
    """§6.0.4: a boss flush with a plate side is one face; queries on the target still work."""
    d = doc(*_plate(), sk("s2", [rect("b", 4, 4, center=(8, 0))], plane=cap("e1")),
            ex("e2", "s2", 3, op="join", targets=body_of("e1")),
            {"type": "tag", "id": "t1", "name": "right", "target": ref("face", {"op": "side", "feature": "e1", "curve": "r.right"})})
    rep = run(d)
    (b,) = feat(rep, "e2")["bodies"]
    assert b["faces"] == 10  # the boss's right side merged into the plate's right side
    assert keys(feat(rep, "t1")) == ["e1/side:r.right"]


# ---------------------------------------------------------------------------------------------
# Constrained sketches: fixed point and replay (§4.4, §8.1)
# ---------------------------------------------------------------------------------------------

def test_constrained_sketch_fixed_point():
    rep = run(_program("constrained_plate.json"))
    s = feat(rep, "s1")
    assert s["status"] == "ok" and s["sketch"]["mode"] == "constrained"
    dims = {x["id"]: x for x in s["sketch"]["dimensions"]}
    assert dims["w"]["value"] == 80.0 and dims["w"]["measured"] == 80.0
    assert rel(feat(rep, "e1")["bodies"][0]["volume"], 80 * 50 * 6) < 1e-12


def _constrained(width=90.0):
    d = _program("constrained_plate.json")
    d["params"][0]["value"] = width
    return d


def test_constrained_sketch_that_needs_a_solve_is_replay_only():
    rep = run(_constrained())
    assert code(feat(rep, "s1")) == "ORACLE_SOLVE_REQUIRES_REPLAY"
    assert code(feat(rep, "e1")) == "DEPENDENCY_FAILED"


def _forge_like(width=90.0) -> dict:
    """A reference report whose sketch solution is the exact solve (the rectangle widened)."""
    h = width / 2
    solved = [
        {"kind": "line", "id": "bottom", "start": [-h, -25.0], "end": [h, -25.0]},
        {"kind": "line", "id": "right", "start": [h, -25.0], "end": [h, 25.0]},
        {"kind": "line", "id": "top", "start": [h, 25.0], "end": [-h, 25.0]},
        {"kind": "line", "id": "left", "start": [-h, 25.0], "end": [-h, -25.0]},
        {"kind": "point", "id": "o", "at": [0.0, 0.0]},
        {"kind": "line", "id": "diag", "start": [-h, -25.0], "end": [h, 25.0], "construction": True},
    ]
    dims = [{"id": "w", "driving": True, "value": width, "measured": width},
            {"id": "d", "driving": True, "value": 50.0, "measured": 50.0},
            {"id": "ref_diag", "driving": False, "measured": math.hypot(width, 50.0)}]
    return {"schema": "aicad.metrics/1", "engine": "forge", "document": "d", "status": "ok", "params": [],
            "features": [{"part": "plate", "feature": "base", "feature_id": "s1", "type": "sketch", "status": "ok",
                          "warnings": [], "sketch": {"mode": "constrained", "status": "fully_constrained", "dof": 0,
                                                     "solved": solved, "dimensions": dims}}],
            "parts": []}


def test_replayed_solution_is_checked_and_used():
    rep = run(_constrained(), replay=_forge_like())
    s = feat(rep, "s1")
    assert s["status"] == "ok"
    assert rel(feat(rep, "e1")["bodies"][0]["volume"], 90 * 50 * 6) < 1e-12
    # [W0-16] status and dof in constrained mode: replayed from the reference, and marked so.
    assert s["sketch"]["status"] == "fully_constrained" and s["sketch"]["dof"] == 0
    (w,) = [w for w in s["warnings"] if w["code"] == "ORACLE_REPLAYED"]
    assert w["severity"] == "info" and w["details"]["fields"] == ["sketch.solved", "sketch.status", "sketch.dof"]
    # the replayed geometry has the document's structure (construction flag from the document)
    assert [c["id"] for c in s["sketch"]["solved"]] == ["bottom", "right", "top", "left", "o", "diag"]
    assert s["sketch"]["solved"][5]["construction"] is True


def test_standalone_fixed_point_has_no_solver_status():
    """The oracle does not solve: without a reference, `status`/`dof` are unknown and omitted
    (documented in the README), and nothing is marked replayed."""
    s = feat(run(_program("constrained_plate.json")), "s1")
    assert "status" not in s["sketch"] and "dof" not in s["sketch"]
    assert not [w for w in s["warnings"] if w["code"] == "ORACLE_REPLAYED"]


def _sk(forge):
    return forge["features"][0]["sketch"]


@pytest.mark.parametrize("mutate", [
    # coordinates
    lambda b: b["solved"][1]["end"].__setitem__(0, b["solved"][1]["end"][0] + 1e-6),  # a point moved by 1e-6
    lambda b: b["solved"][0]["end"].__setitem__(0, 44.0),  # the dimension no longer holds
    lambda b: b["solved"][4]["at"].__setitem__(1, 0.5),  # the fixed midpoint moved
    # structure (SPEC §4.3: the solution is of *this* document's curves)
    lambda b: b["solved"].append({"kind": "circle", "id": "zz", "center": [0.0, 0.0], "radius": 5.0}),  # extra
    lambda b: b["solved"].pop(4),  # missing
    lambda b: b["solved"].append(dict(b["solved"][4])),  # duplicate id
    lambda b: b["solved"].insert(0, b["solved"].pop(3)),  # reordered
    lambda b: b["solved"][5].pop("construction"),  # construction flipped off
    lambda b: b["solved"][0].update(construction=True),  # construction flipped on
    lambda b: b["solved"][4].update(kind="line", start=[0.0, 0.0], end=[1.0, 0.0]),  # kind changed
    # malformed numbers: a replay-check failure, not an oracle exception
    lambda b: b["solved"][4].update(at=[None, 0.0]),
    lambda b: b["solved"][4].update(at=["0", 0.0]),
    lambda b: b["solved"][4].update(at=[float("nan"), 0.0]),
    lambda b: b["solved"][0].update(start=[-45.0]),
    lambda b: b.update(solved="nope"),
    # dimensions (§8.1: every dimension value equals the oracle's own evaluation)
    lambda b: b["dimensions"][0].update(value=90.000001),
    lambda b: b["dimensions"][1].update(driving=False),
    lambda b: b["dimensions"].pop(2),
    lambda b: b.pop("dimensions"),
    lambda b: b["dimensions"].reverse(),
    # the block itself
    lambda b: b.update(mode="explicit"),
])
def test_tampered_solution_fails_the_independent_check(mutate):
    forge = _forge_like()
    mutate(_sk(forge))
    rep = run(_constrained(), replay=forge)
    s = feat(rep, "s1")
    assert code(s) == "ORACLE_REPLAY_CHECK_FAILED", s.get("error")
    assert code(feat(rep, "e1")) == "DEPENDENCY_FAILED"


def test_missing_sketch_block_on_an_ok_reference_fails_the_check():
    forge = _forge_like()
    del forge["features"][0]["sketch"]
    assert code(feat(run(_constrained(), replay=forge), "s1")) == "ORACLE_REPLAY_CHECK_FAILED"


def test_replay_ignores_extra_reference_fields_and_takes_only_numbers():
    """Extra keys in a solved curve are ignored; `ccw`/`construction` must match the document."""
    forge = _forge_like()
    for c in _sk(forge)["solved"]:
        c["note"] = "ignored"
    s = feat(run(_constrained(), replay=forge), "s1")
    assert s["status"] == "ok" and all("note" not in c for c in s["sketch"]["solved"])


def _quarter_disc(ccw=True) -> dict:
    """lines l1, l2 and a quarter arc of r = 10 about the origin (the arc's centre pinned to l1.start)."""
    return doc(sk("s1", [
        {"kind": "line", "id": "l1", "start": [0.0, 0.0], "end": [10.0, 0.0]},
        {"kind": "arc", "id": "a", "start": [10.0, 0.0], "end": [0.0, 10.0], "center": [0.0, 0.0], "ccw": ccw},
        {"kind": "line", "id": "l2", "start": [0.0, 10.0], "end": [0.0, 0.0]},
    ], constraints=[{"type": "horizontal", "id": "h", "line": "l1"}, {"type": "vertical", "id": "v", "line": "l2"},
                    {"type": "coincident", "id": "c", "a": "a.center", "b": "l1.start"},
                    {"type": "radius", "id": "r", "curve": "a", "value": 10.0},
                    {"type": "fix", "id": "f", "entity": "l1.start"}]), ex("e1", "s1", 2))


def test_arc_ccw_flip_in_the_solution_fails_the_check():
    forge = run(_quarter_disc())
    s = feat(forge, "s1")
    assert s["status"] == "ok" and rel(s["regions"][0]["area"], PI * 25) < 1e-12
    assert code(feat(run(_quarter_disc(), replay=copy.deepcopy(forge)), "s1")) is None
    s["sketch"]["solved"][1]["ccw"] = False  # would be the three-quarter disc
    rep = run(_quarter_disc(), replay=forge)
    assert code(feat(rep, "s1")) == "ORACLE_REPLAY_CHECK_FAILED"


def _alias_fix(eps=5e-7) -> dict:
    """constrained_plate with `right.start` stored eps away from `bottom.end` (welded: an alias of
    it) and a `fix` on that alias."""
    d = _program("constrained_plate.json")
    f = d["parts"][0]["features"][0]
    f["curves"][1]["start"] = [40.0, -25.0 + eps]
    f["constraints"].append({"type": "fix", "id": "pin2", "entity": "right.start"})
    return d


def test_fix_on_a_welded_alias_is_measured_from_the_welded_guess():
    """§4.3: the alias starts at its representative's stored position, so the solver holds it
    there. The fixed point (standalone) and the replay of that fixed point both pass."""
    rep = run(_alias_fix())
    s = feat(rep, "s1")
    assert s["status"] == "ok", s.get("error")
    assert s["sketch"]["solved"][1]["start"] == [40.0, -25.0]  # moved onto the representative
    forge = copy.deepcopy(rep)
    again = run(_alias_fix(), replay=forge)
    assert feat(again, "s1")["status"] == "ok", feat(again, "s1").get("error")
    # the alias held at its own (unwelded) stored position instead breaks the weld: detected
    feat(forge, "s1")["sketch"]["solved"][1]["start"] = [40.0, -25.0 + 5e-7]
    assert code(feat(run(_alias_fix(), replay=forge), "s1")) == "ORACLE_REPLAY_CHECK_FAILED"


def test_degenerate_curve_applies_to_the_solved_geometry():
    """§4.2: DEGENERATE_CURVE still applies in constrained mode — to every solved curve,
    construction curves included (as forge-sketch's step 8)."""
    def d(end_y):
        return doc(sk("s1", [{"kind": "line", "id": "l", "start": [0.0, 0.0], "end": [10.0, end_y], "construction": True},
                             {"kind": "circle", "id": "c", "center": [20.0, 0.0], "radius": 3.0}],
                      constraints=[{"type": "horizontal", "id": "h", "line": "l"}]))

    forge = run(d(0.0))
    assert feat(forge, "s1")["status"] == "ok"
    # The stored line is not horizontal (not a fixed point): a solve is needed, and a solution that
    # is horizontal but collapsed passes the residual check and then fails DEGENERATE_CURVE.
    feat(forge, "s1")["sketch"]["solved"][0]["end"] = [0.0, 0.0]
    rep = run(d(1.0), replay=forge)
    assert code(feat(rep, "s1")) == "DEGENERATE_CURVE"
    assert feat(rep, "s1")["error"]["details"]["curve"] == "l"
    # On a fixed point (the stored line already horizontal) the same solution breaks §4.4 rule 4.
    assert code(feat(run(d(0.0), replay=forge), "s1")) == "ORACLE_REPLAY_CHECK_FAILED"


def test_replayed_conflict_is_mirrored_not_computed():
    forge = _forge_like()
    forge["features"][0].update(status="error", error={"code": "SKETCH_CONSTRAINT_CONFLICT", "message": "c",
                                                        "details": {"conflicts": []}})
    del forge["features"][0]["sketch"]
    rep = run(_constrained(), replay=forge)
    assert code(feat(rep, "s1")) == "SKETCH_CONSTRAINT_CONFLICT"


# ---------------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------------

def test_every_example_program_yields_a_schema_valid_deterministic_report():
    for p in sorted(PROGRAMS.glob("*.json")):
        d = json.loads(p.read_text())
        a, b = run(copy.deepcopy(d)), run(copy.deepcopy(d))
        a.pop("engine"), b.pop("engine")
        assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True), p.name


def test_shell_draft_and_pattern_features_evaluate_and_evaluation_continues():
    """W7b: shell, draft and pattern are evaluated (no `ORACLE_UNSUPPORTED_FEATURE` any more); a
    failing one fails with a catalogue code and later features still run."""
    rep = run(_program("shell_box.json"))
    assert feat(rep, "sh1")["status"] == "ok" and feat(rep, "pt1")["status"] == "ok"
    assert code(feat(rep, "dr1")) == "DRAFT_FACE_UNSUPPORTED"  # the rounded rect's corner cylinders
    assert not any(str(code(f) or "").startswith("ORACLE_") for f in rep["features"])
    assert feat(rep, "dp2")["status"] == "ok" and feat(rep, "r1")["status"] == "ok"


def test_rejected_document_report():
    rep = run(doc(ex("e1", "nope", 1)))
    assert rep["status"] == "error" and rep["features"] == [] and rep["error"]["code"] == "UNRESOLVED_SKETCH"
    assert rep["error"]["details"]["errors"][0]["path"] == "/parts/0/features/0/sketch"


def test_through_hole_cut_closed_form_and_topology():
    d = doc(*_plate(), sk("s2", [circle("h", (3, 1), 2)], plane=cap("e1")),
            ex("e2", "s2", 50, direction="reverse", op="cut", targets=body_of("e1")))
    rep = run(d)
    (b,) = feat(rep, "e2")["bodies"]
    assert rel(b["volume"], 20 * 10 * 4 - PI * 4 * 4) < 1e-9
    assert b["faces"] == 7 and b["face_types"] == {"cylinder": 1, "plane": 6}
    assert b["edges"] == 14 and b["edge_types"] == {"circle": 2, "line": 12}


@pytest.mark.parametrize("seed", range(8))
def test_union_and_intersection_satisfy_inclusion_exclusion(seed):
    import random

    rng = random.Random(f"v1-incl-excl/{seed}")
    w1, h1, w2, h2 = (rng.uniform(4, 20) for _ in range(4))
    cx, cy, t1, t2 = rng.uniform(-6, 6), rng.uniform(-6, 6), rng.uniform(2, 8), rng.uniform(2, 8)
    z0 = rng.uniform(-1, 1)
    common = [sk("s1", [rect("a", w1, h1)]), ex("e1", "s1", t1),
              sk("s2", [rect("b", w2, h2, center=(cx, cy))],
                 plane={"origin": [0, 0, z0], "normal": [0, 0, 1], "x_dir": [1, 0, 0]}), ]
    union = run(doc(*common, ex("e2", "s2", t2, op="join", targets=body_of("e1"))))
    inter = run(doc(*common, ex("e2", "s2", t2, op="intersect", targets=body_of("e1"))))
    ox = max(0.0, min(w1 / 2, cx + w2 / 2) - max(-w1 / 2, cx - w2 / 2))
    oy = max(0.0, min(h1 / 2, cy + h2 / 2) - max(-h1 / 2, cy - h2 / 2))
    oz = max(0.0, min(t1, z0 + t2) - max(0.0, z0))
    va, vb, vi = w1 * h1 * t1, w2 * h2 * t2, ox * oy * oz
    fu, fi = feat(union, "e2"), feat(inter, "e2")
    if vi <= 1e-9:
        assert fu["error"]["code"] == "BOOLEAN_NO_INTERSECTION" or fu["status"] == "ok"
        return
    assert rel(sum(b["volume"] for b in fu["bodies"]), va + vb - vi) < 1e-9
    assert rel(sum(b["volume"] for b in fi["bodies"]), vi) < 1e-9


# ---------------------------------------------------------------------------------------------
# §8.3 rule 3: curve types of intersection edges
# ---------------------------------------------------------------------------------------------

def _perturbed_ellipse_edge(delta: float):
    """A degree-4 B-spline that is an ellipse arc (a = 80, b = 50) with one pole moved by delta:
    within ~0.48·delta of an ellipse, but not exactly a conic."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
    from OCP.Geom import Geom_Ellipse, Geom_TrimmedCurve
    from OCP.GeomConvert import GeomConvert
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    el = Geom_Ellipse(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 80.0, 50.0)
    b = GeomConvert.CurveToBSplineCurve_s(Geom_TrimmedCurve(el, 0.3, 2.5))
    b.IncreaseDegree(4)
    u0, u1 = b.FirstParameter(), b.LastParameter()
    b.InsertKnot(u0 + (u1 - u0) * 0.37)
    b.InsertKnot(u0 + (u1 - u0) * 0.71)
    p = b.Pole(4)
    b.SetPole(4, gp_Pnt(p.X() + delta, p.Y() + delta, p.Z()))
    return BRepBuilderAPI_MakeEdge(b).Edge()


def test_freeform_edges_that_are_conics_within_1e7_s_are_counted_as_conics():
    from aicad_oracle import occt

    exact = _perturbed_ellipse_edge(0.0)
    assert occt.edge_type(exact, 1e-7) == "ellipse"
    near = _perturbed_ellipse_edge(1e-6)  # ~4.8e-7 from an ellipse
    assert occt.edge_type(near) == "bspline"  # v0's absolute tolerance (unchanged)
    assert occt.edge_type(near, 1e-7 * 100.0) == "ellipse"  # §8.3 rule 3 at s = 100
    far = _perturbed_ellipse_edge(1e-3)
    assert occt.edge_type(far, 1e-7 * 100.0) == "bspline"


def test_boolean_results_type_section_edges_by_the_rule_3_pair_test(monkeypatch):
    """[W0-43]/[W0-52] (replacing the `1e-7·s` recognition W7a pinned here): a body operation's
    section edges are typed by their face pair and OCCT's own curve within *tol*
    (`normalize.section_type`); edges taken from a sweep keep their construction type."""
    from aicad_oracle.v1 import booleans

    seen = []
    real = booleans.section_type
    monkeypatch.setattr(booleans, "section_type", lambda *a, **k: seen.append(a) or real(*a, **k))
    d = doc(sk("s1", [rect("r", 60, 80)]), ex("e1", "s1", 0.5),
            sk("s2", [circle("c", (0, 0), 3)], plane=cap("e1")),
            ex("e2", "s2", 1, direction="symmetric", op="join", targets=body_of("e1")))
    rep = run(d)
    (b,) = feat(rep, "e2")["bodies"]
    # the boss's rim (a sweep edge) and its new section with the plate's top (plane ⟂ axis: a circle)
    assert b["edge_types"] == {"circle": 2, "line": 12}
    assert seen  # the join's plane–cylinder section went through the pair test


def test_oblique_plane_cut_of_a_cylinder_counts_an_ellipse():
    """The §8.3 rule 3 example: the intersection edge is an ellipse, never counted as bspline."""
    a = math.radians(35)
    d = doc(sk("s1", [circle("c", (0, 0), 5)]), ex("e1", "s1", 20),
            sk("s2", [rect("r", 60, 60)], plane={"origin": [0, 0, 10], "normal": [0, math.sin(a), math.cos(a)],
                                                 "x_dir": [1, 0, 0]}),
            ex("e2", "s2", 30, op="cut", targets=body_of("e1")))
    (b,) = feat(run(d), "e2")["bodies"]
    assert b["edge_types"] == {"circle": 1, "ellipse": 1} and b["face_types"] == {"cylinder": 1, "plane": 2}


# ---------------------------------------------------------------------------------------------
# Convexity (§5.3 predicates): in-face directions from the face's parametric frame
# ---------------------------------------------------------------------------------------------

def _state(d: dict):
    from aicad_oracle.v1 import evaluate as ev

    E = ev.Evaluator(ev.load_value(json.loads(json.dumps(d))), "t")
    part = E.doc["parts"][0]
    st = ev.PartState(0, part)
    for fi, f in enumerate(part["features"]):
        E.feature(st, fi, f)
    return st


def test_in_face_direction_is_right_next_to_a_hole_narrower_than_the_old_fixed_step():
    """A 0.01 mm fin on a 1000 mm plate: the plate's top face has a 0.01 mm wide inner loop, far
    narrower than a fixed 3D step of 1e-4·s (0.14 mm), which lands on the face on *both* sides of
    the long inner edges. The parametric test orients every edge of that face like a local step
    of 1e-3 mm does, and the edges classify as the geometry says (20 convex, 4 concave)."""
    from aicad_oracle.v1 import geom, query
    from aicad_oracle.v1.topo import outward_normal, point_shape_distance

    st = _state(doc(sk("s1", [rect("r", 1000, 1000)]), ex("e1", "s1", 10),
                    sk("s2", [rect("f", 0.01, 500)], plane=cap("e1")),
                    ex("e2", "s2", 5, op="join", targets=body_of("e1"))))
    (b,) = st.bodies
    (top,) = [f for f in b.faces if f.key == "e1/cap:end@r.bottom"]
    ambiguous = 0
    for e in b.edges_of_face(top):
        p, t = e.edge_mid_tangent()
        w = geom.unit(geom.cross(outward_normal(top.shape, p), t))
        on = [point_shape_distance(geom.add(p, geom.mul(w, s * 1e-3)), top.shape) for s in (1, -1)]
        truth = 1 if on[0] < on[1] else -1
        assert query.into_face_sign(e.shape, top.shape, w) == truth, e.key
        far = [point_shape_distance(geom.add(p, geom.mul(w, s * 0.14)), top.shape) for s in (1, -1)]
        ambiguous += far[0] == far[1] == 0.0
    assert ambiguous == 2  # the two long inner edges: a fixed step cannot tell the sides apart
    kinds = {}
    for e in b.edges:
        a = query.material_angle(e)
        k = "convex" if a < math.pi - 1e-6 else "concave" if a > math.pi + 1e-6 else "smooth"
        kinds[k] = kinds.get(k, 0) + 1
    assert kinds == {"convex": 20, "concave": 4}


def test_convexity_on_curved_faces():
    """A boss on a plate (concave circle at the foot, convex circle at the top) and a through hole
    (convex circles at both ends), checked through the query predicates."""
    from aicad_oracle.v1 import query

    st = _state(doc(sk("s1", [rect("r", 20, 20)]), ex("e1", "s1", 4),
                    sk("s2", [circle("c", (5, 0), 3)], plane=cap("e1")),
                    ex("e2", "s2", 3, op="join", targets=body_of("e1")),
                    sk("s3", [circle("h", (-5, 0), 2)], plane=cap("e1")),
                    ex("e3", "s3", 10, direction="reverse", op="cut", targets=body_of("e1"))))
    (b,) = st.bodies
    circles = [e for e in b.edges if e.type == "circle"]
    res = sorted((round(e.centroid[0]), round(e.centroid[2]), query.material_angle(e) < math.pi) for e in circles)
    assert res == [(-5, 0, True), (-5, 4, True), (5, 4, False), (5, 7, True)]
