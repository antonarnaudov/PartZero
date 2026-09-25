"""W7b: the `pattern` feature (SPEC-v1 §6.10) — instances, skips, feature and body seeds, keys,
closed-form volumes (instance count × seed volume for disjoint instances)."""

from __future__ import annotations

import pytest
from test_v1_support import PI, body_of, cap, circle, code, doc, ex, feat, keys, rect, rel, run, sk


def _plate(w=100, d=40, t=5):
    return [sk("s1", [rect("o", w, d)]), ex("e1", "s1", t)]


def _boss(x=-40.0, y=0.0, r=3.0, h=4.0):
    return [sk("s2", [circle("b", (x, y), r)], plane=cap("e1")),
            ex("e2", "s2", h, op="join", targets=body_of("e1"))]


def _pattern(pid="pt1", seed=None, layout=None, **kw):
    return {"type": "pattern", "id": pid, "name": f"n_{pid}", "seed": seed or {"features": ["e2"]},
            "layout": layout, **kw}


BOSS = PI * 9 * 4


@pytest.mark.parametrize("count, spacing, kept, skipped", [
    (4, 20, 3, []),  # x = -20, 0, 20: all on the plate
    (7, 20, 4, [[5], [6]]),  # x = 60, 80 are off the 100 mm plate (edge at 50, boss r 3): skipped
    (12, 10, 9, [[10], [11]]),  # x up to 70: the bosses at 50 and 60 hang over / sit off
])
def test_linear_pattern_of_a_join_seed(count, spacing, kept, skipped):
    """Instances whose tool meets no target are skipped with `PATTERN_INSTANCE_SKIPPED`; a boss
    hanging over the edge still joins with its full volume."""
    rep = run(doc(*_plate(), *_boss(), _pattern(layout={"linear": {"dir": "X", "count": count, "spacing": spacing}})))
    f = feat(rep, "pt1")
    assert f["status"] == "ok", f.get("error")
    # the instance at x = -40 + 9·10 = 50 has its centre on the edge: it overlaps, so only 10, 11 skip
    assert f["pattern"] == {"instances": count - 1, "skipped": skipped}
    assert ("PATTERN_INSTANCE_SKIPPED" in [w["code"] for w in f["warnings"]]) == bool(skipped)
    (b,) = f["bodies"]
    assert rel(b["volume"], 100 * 40 * 5 + (kept + 1) * BOSS) < 1e-9


def test_two_direction_linear_pattern_with_skip():
    rep = run(doc(*_plate(), *_boss(y=-10), _pattern(layout={"linear": {"dir": "X", "count": 3, "spacing": 15,
                                                                         "dir2": "Y", "count2": 2, "spacing2": 20}},
                                                    skip=[[1, 1]])))
    f = feat(rep, "pt1")
    assert f["pattern"] == {"instances": 4, "skipped": []}
    assert rel(f["bodies"][0]["volume"], 100 * 40 * 5 + 5 * BOSS) < 1e-9


def test_all_instances_missing_fails_the_pattern():
    rep = run(doc(*_plate(), *_boss(x=45), _pattern(layout={"linear": {"dir": "X", "count": 3, "spacing": 30}})))
    assert code(feat(rep, "pt1")) == "PATTERN_ALL_INSTANCES_FAILED"


@pytest.mark.parametrize("count", [2, 6, 36])
def test_circular_pattern_of_a_hole_seed(count):
    d = doc(sk("s1", [circle("disk", (0, 0), 30)]), ex("e1", "s1", 4),
            {"type": "hole", "id": "h1", "name": "bolt", "on": cap("e1"), "at": {"list": [{"id": "a", "at": [20, 0]}]},
             "d": 2, "depth": "through"},
            _pattern(seed={"features": ["h1"]}, layout={"circular": {"axis": "Z", "count": count}}))
    f = feat(run(d), "pt1")
    assert f["pattern"] == {"instances": count - 1, "skipped": []}
    assert rel(f["bodies"][0]["volume"], PI * 900 * 4 - count * PI * 4) < 1e-9


def test_partial_circular_pattern_spacing():
    """`Δ = angle/(count − 1)` below a full turn: 3 instances over 90° put copies at 45° and 90°."""
    d = doc(*_plate(w=60, d=60), sk("s2", [circle("b", (20, 0), 2)], plane=cap("e1")),
            ex("e2", "s2", 3, op="join", targets=body_of("e1")),
            _pattern(layout={"circular": {"axis": "Z", "count": 3, "angle": 90}}),
            {"type": "tag", "id": "t1", "name": "tops", "target": {"kind": "face", "q": {
                "op": "instance", "feature": "pt1", "index": [2]}}})
    rep = run(d)
    f = feat(rep, "t1")
    tops = [m for m in f["refs"][0]["members"] if m["key"].startswith("pt1/copy:{e2/cap:end")]
    (top,) = tops
    assert abs(top["probe"]["point"][0]) < 2.1 and abs(top["probe"]["point"][1] - 20) < 2.1


def test_mirror_of_a_cut_seed_and_copy_keys():
    d = doc(*_plate(), sk("s2", [rect("pk", 6, 4, center=(20, 5))], plane=cap("e1")),
            ex("e2", "s2", 2, direction="reverse", op="cut", targets=body_of("e1")),
            _pattern(layout={"mirror": {"plane": "YZ"}}),
            {"type": "tag", "id": "t1", "name": "walls", "target": {"kind": "face", "q": {"op": "instance",
                                                                                          "feature": "pt1", "index": [1]}}})
    rep = run(d)
    f = feat(rep, "pt1")
    assert f["pattern"] == {"instances": 1, "skipped": []}
    assert rel(f["bodies"][0]["volume"], 100 * 40 * 5 - 2 * 6 * 4 * 2) < 1e-9
    ks = keys(feat(rep, "t1"))
    assert "pt1/copy:{e2/cap:end@pk.bottom}@1" in ks and all(k.endswith("@1") for k in ks)


def test_body_seeds_create_bodies_with_instance_origins():
    d = doc(sk("s1", [circle("pin", (10, 0), 1)]), ex("e1", "s1", 5),
            _pattern(seed={"bodies": body_of("e1")}, layout={"circular": {"axis": "Z", "count": 4}}),
            {"type": "tag", "id": "t1", "name": "pins", "target": {"kind": "body", "q": {"op": "body", "feature": "pt1"}}})
    rep = run(d)
    f = feat(rep, "pt1")
    assert [b["origin"] for b in f["bodies"]] == [{"feature": "pt1", "member": "pin", "instance": [k]} for k in (1, 2, 3)]
    assert all(rel(b["volume"], PI * 5) < 1e-9 and b["change"] == "created" for b in f["bodies"])
    # (the canonical order of pieces of one origin feature and member is by centroid, §5.4)
    assert sorted(keys(feat(rep, "t1"))) == ["pt1/body:pin@1", "pt1/body:pin@2", "pt1/body:pin@3"]


def test_body_seed_join():
    d = doc(*_plate(), sk("s2", [rect("blk", 4, 4, center=(-30, 0))]), ex("e2", "s2", 9),
            _pattern(seed={"bodies": body_of("e2")}, layout={"linear": {"dir": "X", "count": 3, "spacing": 20}},
                     op="join", targets=body_of("e1")))
    f = feat(run(d), "pt1")
    (b,) = f["bodies"]
    assert b["origin"]["feature"] == "e1" and rel(b["volume"], 100 * 40 * 5 + 2 * 16 * (9 - 5)) < 1e-9


def test_rotation_by_multiples_of_90_degrees_is_exact():
    """The rotation uses §2.7's exact degree sine and cosine: copies at 90° land bit-exactly."""
    d = doc(sk("s1", [rect("sq", 2, 2, center=(10, 0))]), ex("e1", "s1", 1),
            _pattern(seed={"bodies": body_of("e1")}, layout={"circular": {"axis": "Z", "count": 4}}))
    f = feat(run(d), "pt1")
    assert [b["bbox_min"][:2] for b in f["bodies"]] == [[-1.0, 9.0], [-11.0, -1.0], [-1.0, -11.0]]


def test_a_failed_seed_is_a_dependency_failure():
    d = doc(*_plate(), *_boss(x=400), _pattern(layout={"linear": {"dir": "X", "count": 2, "spacing": 10}}))
    rep = run(d)
    assert code(feat(rep, "e2")) == "BOOLEAN_NO_INTERSECTION"
    assert code(feat(rep, "pt1")) == "DEPENDENCY_FAILED"


# -- instances in the [R-3] band of each other or of the seed (W7b review 2) -------------------------

@pytest.mark.parametrize("spacing, want", [
    (4.0, "BOOLEAN_NON_MANIFOLD"),  # tangent bosses: a line contact
    (3.9999995, "ORACLE_COINCIDENCE_UNREALIZED"),  # overlapping by 5e-7: a contact for the SPEC
    (4.0000005, "ORACLE_COINCIDENCE_UNREALIZED"),  # 5e-7 apart: a contact for the SPEC
    (4.001, None),  # apart
])
def test_a_join_pattern_instance_in_the_band_of_the_seed(spacing, want):
    """The seed boss (r = 2) is already in the plate; its first copy `spacing` away: the SPEC treats
    5e-7 mm either way like the tangent case (`BOOLEAN_NON_MANIFOLD`); the oracle cannot build that
    (no fuzzy value) and fails explicitly instead of reporting two separate bosses (the review's
    `ok`, 4125.66)."""
    rep = run(doc(*_plate(), *_boss(r=2.0), _pattern(layout={"linear": {"dir": "X", "count": 2, "spacing": spacing}})))
    f = feat(rep, "pt1")
    assert code(f) == want, f.get("error")
    if want is None:
        assert rel(f["bodies"][0]["volume"], 100 * 40 * 5 + 2 * PI * 4 * 4) < 1e-9


@pytest.mark.parametrize("spacing, want", [(4.0000005, "ORACLE_COINCIDENCE_UNREALIZED"), (4.001, None)])
def test_a_hole_pattern_leaving_a_wall_in_the_band(spacing, want):
    """Two d = 4 through holes `spacing` apart leave a wall of `spacing − 4` between them: 5e-7 mm is
    no wall for the SPEC (the hole walls coincide)."""
    d = doc(*_plate(), {"type": "hole", "id": "h1", "name": "bolt", "on": cap("e1"),
                        "at": {"list": [{"id": "a", "at": [0, 0]}]}, "d": 4, "depth": "through"},
            _pattern(seed={"features": ["h1"]}, layout={"linear": {"dir": "X", "count": 2, "spacing": spacing}}))
    f = feat(run(d), "pt1")
    assert code(f) == want, f.get("error")
    if want is None:
        assert rel(f["bodies"][0]["volume"], 100 * 40 * 5 - 2 * PI * 4 * 5) < 1e-9


# -- W7b review 4: a missing `skipped` is the empty list -------------------------------------------

def test_a_missing_skipped_array_compares_equal_to_an_empty_one():
    """metrics-v1 makes `PatternReport.skipped` optional and Forge omits it when empty; the oracle
    writes `[]`. §8.2 compares the summary, not its serialization: missing == [] is a MATCH, the
    order of the skipped indices does not matter, and a real difference is still silent-wrong."""
    import copy

    from aicad_oracle.v1.compare import MATCH, SILENT_WRONG, compare_reports

    oracle = run(doc(*_plate(), *_boss(), _pattern(layout={"linear": {"dir": "X", "count": 4, "spacing": 20}})))
    assert feat(oracle, "pt1")["pattern"] == {"instances": 3, "skipped": []}
    forge = copy.deepcopy(oracle)
    del feat(forge, "pt1")["pattern"]["skipped"]
    assert compare_reports(forge, oracle).classification == MATCH
    assert compare_reports(oracle, forge).classification == MATCH
    feat(forge, "pt1")["pattern"]["skipped"] = None
    assert compare_reports(forge, oracle).classification == MATCH
    feat(forge, "pt1")["pattern"]["skipped"] = [[2]]
    assert compare_reports(forge, oracle).classification == SILENT_WRONG
    feat(forge, "pt1")["pattern"]["skipped"] = "none"
    assert compare_reports(forge, oracle).classification == SILENT_WRONG
    # order-free
    feat(oracle, "pt1")["pattern"]["skipped"] = [[5], [6]]
    feat(forge, "pt1")["pattern"]["skipped"] = [[6], [5]]
    assert compare_reports(forge, oracle).classification == MATCH
