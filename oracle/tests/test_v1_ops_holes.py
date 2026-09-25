"""W7b: the `hole` feature (SPEC-v1 §6.5, §8.3 rule 7) — the `holes/tools.json` dimensions through
evaluation, closed-form tool volumes (the body gate for holes), placements, keys and the error
corpus (`HOLE_*`)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from test_v1_support import PI, cap, code, doc, ex, feat, keys, rect, rel, run, sk

REPO = Path(__file__).resolve().parents[2]
TOOLS = json.loads((REPO / "corpus/v1/conformance/holes/tools.json").read_text())["cases"]


def _slab(t=20, w=40, d=40):
    return [sk("s1", [rect("o", w, d)]), ex("e1", "s1", t)]


def _hole(hid="h1", end="end", **kw):
    return {"type": "hole", "id": hid, "name": f"n_{hid}", "on": cap("e1", end), **kw}


# -- holes/tools.json: the resolved tool through evaluation ---------------------------------------

@pytest.mark.parametrize("case", [c for c in TOOLS if "expected" in c], ids=lambda c: c["id"])
def test_hole_tool_dimensions_fixture(case):
    """`holes/tools.json` (I9): the report's hole entry carries the fixture's `d`, kind, presets,
    insert depth and thread pitch (the test W7a skipped until W7b)."""
    h = _hole(at={"list": [{"id": "a", "at": [0, 0]}]}, **case["hole"])
    rep = run(doc(*_slab(), h))
    f = feat(rep, "h1")
    assert f["status"] == "ok", f.get("error")
    (e,) = f["holes"]
    x = case["expected"]
    assert e["d"] == x["d"] and e["kind"] == x["kind"]
    for k in ("cbore", "csink", "insert"):
        assert e.get(k) == ({kk: float(v) for kk, v in x[k].items()} if k in x else None), k
    if "depth" in x:
        assert e["depth"] == x["depth"]
    if "thread" in x:
        assert e["thread"]["pitch"] == x["thread"]["pitch"]


# -- closed-form volumes (the body gate for holes) ------------------------------------------------

def _tip(r, angle=118.0):
    return r / math.tan(math.radians(angle / 2))


@pytest.mark.parametrize("fields, removed", [
    ({"d": 4, "depth": "through"}, PI * 4 * 20),
    ({"d": 4, "depth": {"blind": 8}}, PI * 4 * 8 + PI * 4 * _tip(2) / 3),
    ({"d": 4, "depth": {"blind": 8}, "tip": 90}, PI * 4 * 8 + PI * 4 * _tip(2, 90) / 3),
    ({"d": 4, "depth": {"blind": 8}, "tip": "flat"}, PI * 4 * 8),
    ({"size": "M5", "depth": "through", "cbore": "iso4762"}, PI * 25 * 5.4 + PI * 2.75 ** 2 * (20 - 5.4)),
    ({"d": 3, "depth": "through", "cbore": {"d": 6, "depth": 2}}, PI * 9 * 2 + PI * 2.25 * 18),
    ({"size": "M4", "depth": "through", "csink": "iso10642"},
     (lambda rk, r: PI * (rk - r) / 3 * (rk * rk + rk * r + r * r) + PI * r * r * (20 - (rk - r)))(9.18 / 2, 4.5 / 2)),
    ({"size": "M3", "insert": "std"}, PI * 4 * 6.7),
    ({"size": "M3", "depth": {"blind": 10}, "thread": True}, PI * 1.25 ** 2 * 10 + PI * 1.25 ** 2 * _tip(1.25) / 3),
])
def test_hole_volume_in_closed_form(fields, removed):
    rep = run(doc(*_slab(), _hole(at={"list": [{"id": "a", "at": [5, -3]}]}, **fields)))
    (b,) = feat(rep, "h1")["bodies"]
    assert b["change"] == "modified"
    assert rel(b["volume"], 40 * 40 * 20 - removed) < 1e-9


def test_hole_faces_carry_the_spec_keys():
    """§5.2 rule 3: `H/wall@p`, `H/tip@p`, `H/cbore_wall@p`, `H/cbore_floor@p`; queries by `hole_face`."""
    d = doc(*_slab(), _hole(at={"list": [{"id": "a", "at": [0, 0]}]}, d=4, depth={"blind": 8}),
            _hole("h2", at={"list": [{"id": "b", "at": [10, 10]}]}, size="M5", depth="through", cbore="iso4762"),
            {"type": "tag", "id": "t1", "name": "wall", "target": {"kind": "face", "q": {
                "op": "hole_face", "feature": "h1", "at": "a", "part": "wall"}}},
            {"type": "tag", "id": "t2", "name": "tips", "target": {"kind": "face", "q": {"op": "created", "feature": "h1"}}},
            {"type": "tag", "id": "t3", "name": "cb", "target": {"kind": "face", "q": {"op": "created", "feature": "h2"}}})
    rep = run(d)
    assert keys(feat(rep, "t1")) == ["h1/wall@a"]
    assert keys(feat(rep, "t2")) == ["h1/tip@a", "h1/wall@a"]
    assert keys(feat(rep, "t3")) == ["h2/cbore_floor@b", "h2/cbore_wall@b", "h2/wall@b"]


# -- placements --------------------------------------------------------------------------------------

def test_grid_ids_in_index_order_and_positions():
    rep = run(doc(*_slab(), _hole(at={"grid": {"nx": 2, "ny": 3, "dx": 10, "dy": 8, "center": [1, 2]}},
                                  d=2, depth="through")))
    hs = feat(rep, "h1")["holes"]
    assert [h["at"] for h in hs] == ["g0_0", "g0_1", "g0_2", "g1_0", "g1_1", "g1_2"]
    assert [h["center"][:2] for h in hs] == [[-4, -6], [-4, 2], [-4, 10], [6, -6], [6, 2], [6, 10]]
    assert all(h["axis"] == [0.0, 0.0, -1.0] and h["depth"] is None for h in hs)


def test_bolt_circle_positions_use_exact_degree_trigonometry():
    rep = run(doc(*_slab(), _hole(at={"circle": {"n": 4, "d": 20, "start": 90}}, d=2, depth="through")))
    hs = feat(rep, "h1")["holes"]
    assert [h["at"] for h in hs] == ["c0", "c1", "c2", "c3"]
    assert [h["center"][:2] for h in hs] == [[0.0, 10.0], [-10.0, 0.0], [0.0, -10.0], [10.0, 0.0]]


def test_sketch_points_are_projected_onto_the_placement_plane():
    d = doc(*_slab(t=5), sk("s2", [{"kind": "point", "id": "p", "at": [3, 4]}, {"kind": "circle", "id": "k",
                                                                             "center": [-6, 1], "radius": 1}],
                            plane={"origin": [0, 0, 30], "normal": [0, 0, 1], "x_dir": [1, 0, 0]}),
            _hole(at={"points": {"sketch": "s2", "ids": ["p", "k.center"]}}, d=1, depth="through"))
    hs = feat(run(d), "h1")["holes"]
    assert [(h["at"], h["center"]) for h in hs] == [("p", [3.0, 4.0, 5.0]), ("k.center", [-6.0, 1.0, 5.0])]


def test_flip_drills_out_of_the_material():
    rep = run(doc(*_slab(), _hole(at={"list": [{"id": "a", "at": [0, 0]}]}, d=2, depth="through", flip=True)))
    assert code(feat(rep, "h1")) == "HOLE_MISSES_BODY"


# -- the error corpus (§6.5, at least 3 cases per code the oracle computes) ----------------------------

@pytest.mark.parametrize("at, want", [
    ({"list": [{"id": "a", "at": [0, 0]}, {"id": "b", "at": [0, 5e-7]}]}, "HOLE_DUPLICATE_POSITION"),
    ({"grid": {"nx": 2, "ny": 1, "dx": 1e-7, "dy": 1}}, "HOLE_DUPLICATE_POSITION"),
    ({"circle": {"n": 3, "d": 1.1e-6}}, "HOLE_DUPLICATE_POSITION"),  # chords 9.5e-7 mm
    ({"list": [{"id": "a", "at": [25, 0]}]}, "HOLE_POINT_OFF_FACE"),
    ({"list": [{"id": "a", "at": [0, 0]}, {"id": "b", "at": [0, 30]}]}, "HOLE_POINT_OFF_FACE"),
    ({"grid": {"nx": 2, "ny": 2, "dx": 50, "dy": 1}}, "HOLE_POINT_OFF_FACE"),
])
def test_position_errors(at, want):
    rep = run(doc(*_slab(), _hole(at=at, d=2, depth="through")))
    f = feat(rep, "h1")
    assert code(f) == want and f["error"]["details"]["at"]


def test_duplicate_positions_name_the_later_id():
    rep = run(doc(*_slab(), _hole(at={"list": [{"id": "a", "at": [0, 0]}, {"id": "b", "at": [1e-7, 0]}]},
                                  d=2, depth="through")))
    assert feat(rep, "h1")["error"]["details"]["at"] == "b"


@pytest.mark.parametrize("q", [
    {"op": "cap", "feature": "e2", "end": "end"},  # a face beside the hole axis
    {"op": "cap", "feature": "e2", "end": "start"},
    {"op": "side", "feature": "e2", "curve": "far.left"},
])
def test_up_to_missed(q):
    d = doc(*_slab(), sk("s2", [rect("far", 4, 4, center=(100, 0))]), ex("e2", "s2", 5),
            _hole(at={"list": [{"id": "a", "at": [0, 0]}]}, d=2, depth={"up_to": {"kind": "face", "q": q}},
                  targets=body_of_e1()))
    assert code(feat(run(d), "h1")) == "HOLE_UP_TO_MISSED"


def body_of_e1():
    return {"kind": "body", "q": {"op": "body", "feature": "e1"}}


def test_up_to_depth_is_the_distance_to_the_face_with_a_flat_floor():
    d = doc(*_slab(t=20), sk("s2", [rect("step", 40, 40)], plane={"origin": [0, 0, 8], "normal": [0, 0, 1],
                                                                  "x_dir": [1, 0, 0]}), ex("e2", "s2", 1),
            _hole(at={"list": [{"id": "a", "at": [0, 0]}]}, d=2,
                  depth={"up_to": {"kind": "face", "q": {"op": "cap", "feature": "e2", "end": "end"}}},
                  targets=body_of_e1()))
    f = feat(run(d), "h1")
    (h,) = f["holes"]
    assert abs(h["depth"] - 11.0) < 1e-12
    assert rel(f["bodies"][0]["volume"], 40 * 40 * 20 - PI * 11) < 1e-9


@pytest.mark.parametrize("fields", [
    {"d": 2, "depth": {"blind": 25}},
    {"d": 2, "depth": {"blind": 19.9}},  # the 118° tip pokes through the 20 mm slab
    {"size": "M3", "insert": "std", "flip": True, "on_end": "start"},
])
def test_blind_holes_breaking_through_warn(fields):
    fields = dict(fields)
    end = fields.pop("on_end", "end")
    if end == "start":
        fields.pop("flip")
        rep = run(doc(*_slab(t=5), _hole(end="start", at={"list": [{"id": "a", "at": [0, 0]}]}, **fields)))
    else:
        rep = run(doc(*_slab(), _hole(at={"list": [{"id": "a", "at": [0, 0]}]}, **fields)))
    f = feat(rep, "h1")
    assert f["status"] == "ok" and [w["code"] for w in f["warnings"]] == ["HOLE_BREAKS_THROUGH"]


@pytest.mark.parametrize("at", [
    {"list": [{"id": "a", "at": [0, 0]}]},
    {"grid": {"nx": 2, "ny": 2, "dx": 4, "dy": 4}},
    {"circle": {"n": 3, "d": 6}},
])
def test_misses_body_on_a_datum_plane_away_from_the_part(at):
    d = doc(*_slab(), {"type": "datum_plane", "id": "d1", "name": "high", "mode": "offset", "from": "XY",
                       "distance": 100},
            {"type": "hole", "id": "h1", "name": "n_h1", "on": {"datum": "d1"}, "flip": True, "at": at, "d": 2,
             "depth": {"blind": 5}, "targets": "all"})
    assert code(feat(run(d), "h1")) == "HOLE_MISSES_BODY"


def test_hole_errors_pass_the_input_through():
    rep = run(doc(*_slab(), _hole(at={"list": [{"id": "a", "at": [99, 0]}]}, d=2, depth="through"),
                  _hole("h2", at={"list": [{"id": "b", "at": [0, 0]}]}, d=2, depth="through")))
    assert code(feat(rep, "h1")) == "HOLE_POINT_OFF_FACE"
    (b,) = feat(rep, "h2")["bodies"]
    assert rel(b["volume"], 40 * 40 * 20 - PI * 20) < 1e-9


# -- the head of an up_to hole must end above its floor (review finding) ---------------------------

def _up_to_one_mm(**head):
    """A slab 40 × 40 × 20 and a separate body whose top face is 1 mm below the placement plane: the
    up_to depth is 1."""
    return doc(*_slab(t=20), sk("s3", [rect("c", 6, 6)], plane={"origin": [0, 0, 18], "normal": [0, 0, 1],
                                                                "x_dir": [1, 0, 0]}),
               ex("e3", "s3", 1),
               _hole(at={"list": [{"id": "a", "at": [0, 0]}]}, d=3.4,
                     depth={"up_to": {"kind": "face", "q": {"op": "cap", "feature": "e3", "end": "end"}}}, **head))


@pytest.mark.parametrize("head, field, value, limit", [
    ({"cbore": {"d": 6.5, "depth": 3.4}}, "/cbore/depth", 3.4, 1.0 - 1e-6),
    ({"cbore": {"d": 6.5, "depth": 1.0}}, "/cbore/depth", 1.0, 1.0 - 1e-6),  # equal: no wall left
    ({"csink": {"d": 10.2, "angle": 90}}, "/csink/d", 10.2, 3.4 + 2 * (1.0 - 1e-6)),  # hk = 3.4
    ({"size": "M3", "cbore": "iso4762"}, "/cbore", 3.4, 1.0 - 1e-6),  # the preset: 3.4 deep
])
def test_an_up_to_head_deeper_than_the_depth_is_invalid_with_its_feasible_range(head, field, value, limit):
    """Before the review the oracle built a folded profile — a pin standing in the counterbore, whose
    volume the tool gate computed from the same folded profile — and reported `ok` (silently wrong).
    Now it is `INVALID_VALUE` naming the head's field and the feasible range."""
    head = dict(head)
    if "size" in head:
        head.pop("d", None)
    d = _up_to_one_mm(**head)
    if "size" in head:
        d["parts"][0]["features"][-1].pop("d")
    f = feat(run(d), "h1")
    assert code(f) == "INVALID_VALUE", f.get("error") or f["status"]
    det = f["error"]["details"]
    assert det["field"] == field and det["value"] == value
    assert det["expected"].startswith("< ") and float(det["expected"][2:]) == pytest.approx(limit, abs=1e-12)


@pytest.mark.parametrize("head, removed", [
    ({"cbore": {"d": 6.5, "depth": 0.5}}, PI * 3.25 ** 2 * 0.5 + PI * 1.7 ** 2 * 0.5),
    ({"csink": {"d": 4.4, "angle": 90}}, PI * 0.5 / 3 * (2.2 ** 2 + 2.2 * 1.7 + 1.7 ** 2) + PI * 1.7 ** 2 * 0.5),
])
def test_an_up_to_head_above_the_floor_is_built_in_closed_form(head, removed):
    """hc = 0.5, and hk = (4.4 − 3.4)/2 = 0.5 < the up_to depth 1."""
    f = feat(run(_up_to_one_mm(**head)), "h1")
    assert f["status"] == "ok" and f["holes"][0]["depth"] == pytest.approx(1.0, abs=1e-12)
    (b,) = [x for x in f["bodies"] if x["origin"]["feature"] == "e1"]
    assert rel(b["volume"], 40 * 40 * 20 - removed) < 1e-9


def test_a_blind_head_within_tol_of_the_depth_is_invalid():
    """[R-3], as Forge's `hole::spec` reads §6.5: `hc < depth` by more than *tol*."""
    for hc, ok in ((6.0 - 5e-7, False), (6.0 - 2e-6, True)):
        f = feat(run(doc(*_slab(), _hole(at={"list": [{"id": "a", "at": [0, 0]}]}, d=3, depth={"blind": 6},
                                          cbore={"d": 6, "depth": hc}))), "h1")
        assert (f["status"] == "ok") is ok, f.get("error")


def test_a_folded_profile_fails_explicitly():
    """The backstop in `profile`: never a tool whose wall runs upwards."""
    from aicad_oracle.v1.holes import HoleSpec, profile
    from aicad_oracle.v1.topo import TopoError

    with pytest.raises(TopoError) as e:
        profile(HoleSpec(d=3.4, kind="counterbore", depth_kind="up_to", cbore=(6.5, 3.4)), 1.0, False)
    assert e.value.code == "ORACLE_HOLE_PROFILE_FOLDED"


@pytest.mark.parametrize("gap, warns", [(3e-6, True), (0.5e-6, True), (0.0, True), (-0.5e-6, None), (-0.9e-6, None),
                                        (-3e-6, False)])
def test_a_flat_floor_within_tol_of_the_far_face_breaks_through(gap, warns):
    """[R-3]: a floor within *tol* of the slab's bottom face (past it, on it, or 0.5e-6 mm short of
    it) lies on that face, so the hole opens there; 3e-6 mm of material left is a blind hole.
    Short of the face by at most *tol* (`warns` None) the SPEC's hole opens, but the oracle's cut
    (no fuzzy value) keeps a floor that thin: W7b review 4 — it reported `ok` +
    `HOLE_BREAKS_THROUGH` with the floor still there (one plane too many); it now fails with the
    engine-internal `ORACLE_COINCIDENCE_UNREALIZED` (ROBUSTNESS), never a body contradicting its
    own warning."""
    f = feat(run(doc(*_slab(t=5), _hole(at={"list": [{"id": "a", "at": [0, 0]}]}, d=2, tip="flat",
                                        depth={"blind": 5 + gap}))), "h1")
    if warns is None:
        assert code(f) == "ORACLE_COINCIDENCE_UNREALIZED", f.get("error") or f["status"]
        return
    assert f["status"] == "ok" and (["HOLE_BREAKS_THROUGH"] if warns else []) == [w["code"] for w in f["warnings"]]
    (b,) = f["bodies"]
    # an open hole has no floor: the slab's six planes and the wall; a blind one adds its floor
    assert b["face_types"] == {"cylinder": 1, "plane": 6 if warns else 7}


@pytest.mark.parametrize("depth, want, planes", [
    (4.9999995, "ORACLE_COINCIDENCE_UNREALIZED", None),  # a 5e-7 mm floor the SPEC does not have
    (4.9999991, "ORACLE_COINCIDENCE_UNREALIZED", None),  # 0.9e-6 mm: still in the band
    (5.0, None, 10),  # through, flush
    (5.0000005, None, 10),  # 5e-7 mm past the bottom: through
    (4.99, None, 11),  # a real 0.01 mm floor
])
def test_a_pocket_floor_within_tol_of_the_far_face(depth, want, planes):
    """The same band for a `cut` extrude: a 10 × 10 pocket `depth` deep in a 5 mm plate. By [R-3]
    a floor within *tol* of the bottom face is on it (the pocket opens); the oracle fails that
    explicitly instead of returning the 11-face body with a 5e-7 mm membrane."""
    d = doc(*_slab(t=5), sk("s2", [rect("p", 10, 10)], plane=cap("e1")),
            ex("e2", "s2", depth, op="cut", targets={"kind": "body", "q": {"op": "body", "feature": "e1"}},
               direction="reverse"))
    f = feat(run(d), "e2")
    assert code(f) == want, f.get("error") or f["status"]
    if want is None:
        (b,) = f["bodies"]
        assert b["face_types"] == {"plane": planes}
        assert rel(b["volume"], 40 * 40 * 5 - 100 * min(depth, 5.0)) < 1e-9


# -- a countersink deeper than the plate (W7b review 2) ------------------------------------------------

def _csink_removed(d, dk, beta, t):
    """The countersunk through hole's cut from a plate `t` thick: the cone frustum from `Dk` down
    to the plate's far face (or down to `D` at `hk`, then the bore)."""
    r, rk = d / 2, dk / 2
    k = math.tan(math.radians(beta / 2))
    hk = (rk - r) / k

    def frustum(h):
        r1 = rk - h * k
        return PI / 3 * h * (rk * rk + rk * r1 + r1 * r1)

    return frustum(t) if t <= hk else frustum(hk) + PI * r * r * (t - hk)


@pytest.mark.parametrize("t", [0.5, 2.0, 3.0, 5.0])
@pytest.mark.parametrize("head", [{"size": "M8", "csink": "iso10642"}, {"d": 6, "csink": {"d": 20, "angle": 60}}])
def test_a_countersink_deeper_than_the_plate_is_a_conical_through_hole(t, head):
    """§6.5 bounds the head depth only for blind holes: a through hole's tool must reach past the
    countersink as well as past the targets (it failed with the engine-internal
    `ORACLE_HOLE_PROFILE_FOLDED` when `hk` exceeded the plate plus the margin). A plate thinner
    than `hk` loses a frustum of the countersink cone; the bore does not reach it."""
    rep = run(doc(*_slab(t), _hole(at={"list": [{"id": "a", "at": [0, 0]}]}, depth="through", **head)))
    f = feat(rep, "h1")
    assert f["status"] == "ok", f.get("error")
    (e,) = f["holes"]
    removed = _csink_removed(e["d"], e["csink"]["d"], e["csink"]["angle"], t)
    (b,) = f["bodies"]
    assert rel(b["volume"], 40 * 40 * t - removed) < 1e-9
    hk = (e["csink"]["d"] - e["d"]) / 2 / math.tan(math.radians(e["csink"]["angle"] / 2))
    assert ("cylinder" in b["face_types"]) == (t > hk)
