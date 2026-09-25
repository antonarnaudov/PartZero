"""`kernel-diff` v1 (SPEC-v1 §8.2–§8.4): one test per compared row, the new classes REF_MISMATCH and
NORMALIZED, the severity order, and the replay mutation tests of the IR-v1 plan (W7): tampered
reference reports — a solved point moved by 1e-6, a probe moved to a neighbouring face, a member
added that fails its predicate — are POTENTIAL_SILENT_WRONG or ROBUSTNESS, never MATCH."""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path

import pytest

from aicad_oracle.v1.compare import (
    CLASSES, CODE_MISMATCH, MATCH, NORMALIZED, REF_MISMATCH, ROBUSTNESS, SILENT_WRONG, compare_reports, worst,
)
from test_v1_support import P, body_of, cap, circle, code, doc, ex, feat, rect, ref, run, sk

REPO = Path(__file__).resolve().parents[2]

BODY = {"origin": {"feature": "e1", "member": "r.bottom"}, "change": "created", "volume": 1000.0, "area": 600.0,
        "centroid": [5.0, 5.0, 5.0], "bbox_min": [0.0, 0.0, 0.0], "bbox_max": [10.0, 10.0, 10.0], "faces": 6,
        "edges": 12, "shells": 1, "face_types": {"plane": 6}, "edge_types": {"line": 12}, "valid": True}
REPORT = {
    "schema": "aicad.metrics/1", "engine": "x", "document": "d", "status": "ok",
    "params": [{"name": "w", "scope": "doc", "unit": "mm", "value": 10.0},
               {"name": "n", "scope": "doc", "unit": "count", "value": 4.0},
               {"name": "lid", "scope": "part", "unit": "bool", "value": True}],
    "features": [
        {"part": "part", "feature": "base", "feature_id": "s1", "type": "sketch", "status": "ok", "warnings": [],
         "regions": [{"area": 100.0, "loops": 1, "outer_curves": ["r.bottom", "r.left", "r.right", "r.top"]}],
         "sketch": {"mode": "explicit", "solved": []}},
        {"part": "part", "feature": "slab", "feature_id": "e1", "type": "extrude", "status": "ok", "warnings": [],
         "bodies": [BODY]},
        {"part": "part", "feature": "mid", "feature_id": "d1", "type": "datum_plane", "status": "ok", "warnings": [],
         "datum": {"origin": [0.0, 0.0, 5.0], "x": [1.0, 0.0, 0.0], "y": [0.0, 1.0, 0.0], "normal": [0.0, 0.0, 1.0]}},
        {"part": "part", "feature": "cutter", "feature_id": "e2", "type": "extrude", "status": "ok", "warnings": [],
         "bodies": [dict(BODY, change="modified", volume=500.0, centroid=[2.5, 5.0, 5.0]),
                    dict(BODY, change="modified", volume=400.0, centroid=[8.0, 5.0, 5.0])]},
    ],
    "parts": [{"part": "part", "part_id": "p1", "bodies": [
        {k: v for k, v in dict(BODY, volume=500.0, centroid=[2.5, 5.0, 5.0]).items() if k != "change"},
        {k: v for k, v in dict(BODY, volume=400.0, centroid=[8.0, 5.0, 5.0]).items() if k != "change"}]}],
}


def mutated(f):
    r = copy.deepcopy(REPORT)
    f(r)
    return r


def cls(b, **kw):
    return compare_reports(REPORT, b, **kw).classification


def F(r, i):
    return r["features"][i]


def test_identical_reports_match():
    assert cls(copy.deepcopy(REPORT)) == MATCH


def test_severity_order_most_severe_first():
    assert list(reversed(CLASSES)) == [SILENT_WRONG, REF_MISMATCH, CODE_MISMATCH, ROBUSTNESS, NORMALIZED, MATCH]
    assert worst(MATCH, NORMALIZED) == NORMALIZED
    assert worst(ROBUSTNESS, CODE_MISMATCH, REF_MISMATCH) == REF_MISMATCH
    assert worst(REF_MISMATCH, SILENT_WRONG) == SILENT_WRONG


@pytest.mark.parametrize("mutate, want", [
    # parameters: reals within PARAM_VALUE_REL, counts and bools exact
    (lambda r: r["params"][0].update(value=10.0 * (1 + 0.5e-12)), MATCH),
    (lambda r: r["params"][0].update(value=10.0 * (1 + 3e-12)), SILENT_WRONG),
    (lambda r: r["params"][1].update(value=5.0), SILENT_WRONG),
    (lambda r: r["params"][2].update(value=False), SILENT_WRONG),
    # a status/code disagreement is semantic (evaluation is deterministic), unless engine-internal
    (lambda r: r["params"][0].update(value=None, error={"code": "EXPR_DOMAIN", "message": ""}), CODE_MISMATCH),
    (lambda r: r["params"][0].update(value=None, error={"code": "PARAM_OUT_OF_RANGE", "message": ""}), CODE_MISMATCH),
    (lambda r: r["params"][0].update(value=None, error={"code": "ORACLE_EXCEPTION", "message": ""}), ROBUSTNESS),
    (lambda r: r["params"][0].update(unit="deg"), SILENT_WRONG),
    (lambda r: r["params"][2].update(value=1), SILENT_WRONG),  # bool vs int, either way round
    # regions: exact counts and names, tolerance area
    (lambda r: F(r, 0)["regions"][0].update(outer_curves=["a"]), SILENT_WRONG),
    (lambda r: F(r, 0)["regions"][0].update(loops=2), SILENT_WRONG),
    (lambda r: F(r, 0)["regions"][0].update(area=100.0 * (1 + 0.5e-6)), MATCH),
    # bodies: exact topology and shells, tolerance metrics, matched by origin
    (lambda r: F(r, 1)["bodies"][0].update(shells=2), SILENT_WRONG),
    (lambda r: F(r, 1)["bodies"][0].update(face_types={"plane": 5, "cylinder": 1}), SILENT_WRONG),
    (lambda r: F(r, 1)["bodies"][0].update(volume=1000.0 * (1 + 2e-6)), SILENT_WRONG),
    (lambda r: F(r, 1)["bodies"][0].update(origin={"feature": "e1", "member": "r.left"}), SILENT_WRONG),
    (lambda r: F(r, 3)["bodies"].reverse(), MATCH),  # same-origin pieces matched by centroid
    (lambda r: r["parts"][0]["bodies"].reverse(), MATCH),
    (lambda r: r["parts"][0]["bodies"].pop(), SILENT_WRONG),
    (lambda r: F(r, 3).update(removed=[{"feature": "e9", "member": "x"}]), SILENT_WRONG),
    # datums: origins at 1e-6·s, directions at 1e-9
    (lambda r: F(r, 2)["datum"]["origin"].__setitem__(2, 5.0 + 0.5e-6), MATCH),
    (lambda r: F(r, 2)["datum"]["normal"].__setitem__(0, 2e-9), SILENT_WRONG),
    # validity per report [R-12]
    (lambda r: F(r, 1)["bodies"][0].update(valid=False), SILENT_WRONG),
    (lambda r: r["parts"][0]["bodies"][0].update(valid=False), SILENT_WRONG),
    # compared warning codes vs ignored ones
    (lambda r: F(r, 3)["warnings"].append({"code": "BOOLEAN_SPLIT", "severity": "info", "message": ""}), CODE_MISMATCH),
    (lambda r: F(r, 0)["warnings"].append({"code": "SKETCH_UNDER_CONSTRAINED", "severity": "info", "message": ""}), MATCH),
    # messages, details, probes, sketch blocks, engine and document names are not compared
    (lambda r: r.update(engine="occt", document="x"), MATCH),
    (lambda r: F(r, 0)["sketch"].update(solved=[{"kind": "point", "id": "p", "at": [0.0, 0.0]}]), MATCH),
])
def test_compared_rows(mutate, want):
    assert cls(mutated(mutate)) == want


def test_status_and_code_differences():
    def fail(i, c):
        return lambda r: F(r, i).update(status="error", error={"code": c, "message": ""})

    assert cls(mutated(fail(1, "INVALID_DISTANCE"))) == ROBUSTNESS
    both = mutated(fail(1, "INVALID_DISTANCE"))
    other = mutated(fail(1, "REGION_NOT_FOUND"))
    assert compare_reports(both, other).classification == CODE_MISMATCH
    assert compare_reports(both, mutated(fail(1, "OCCT_BUILD_FAILED"))).classification == ROBUSTNESS
    assert compare_reports(both, copy.deepcopy(both)).classification == MATCH


def test_differences_downstream_of_an_engine_divergence_are_capped_at_robustness():
    a = copy.deepcopy(REPORT)
    b = mutated(lambda r: (F(r, 1).update(status="error", error={"code": "ORACLE_UNSUPPORTED_FEATURE", "message": ""}),
                           F(r, 1).pop("bodies"), F(r, 3)["bodies"][0].update(volume=1.0),
                           r["parts"][0]["bodies"][0].update(volume=1.0)))
    cmp = compare_reports(a, b)
    assert cmp.classification == ROBUSTNESS
    assert any("downstream" in d.detail for d in cmp.differences)
    # the capped differences stay visible: counted, and noted per part
    assert cmp.capped == 2 and any("2 difference(s)" in n for n in cmp.notes)
    # a real silent-wrong answer upstream is still reported
    c = mutated(lambda r: (F(r, 0)["regions"][0].update(area=1.0),
                           F(r, 1).update(status="error", error={"code": "OCCT_X", "message": ""})))
    assert compare_reports(a, c).classification == SILENT_WRONG


def test_rejections():
    rej = {"schema": "aicad.metrics/1", "engine": "x", "document": "d", "status": "error",
           "error": {"code": "INVALID_ID", "message": ""}, "params": [], "features": [], "parts": []}
    assert compare_reports(rej, copy.deepcopy(rej)).classification == MATCH
    assert compare_reports(rej, copy.deepcopy(REPORT)).classification == ROBUSTNESS


@pytest.mark.parametrize("code, want, want_independent", [
    # §8.1/§8.4: REF_MISMATCH exists only in independent-refs mode; in the default (replay) mode
    # a difference from the oracle's own resolution is ROBUSTNESS — never MATCH (W7 acceptance).
    ("ORACLE_REF_MISMATCH", ROBUSTNESS, REF_MISMATCH), ("ORACLE_REF_DIFFERS", ROBUSTNESS, ROBUSTNESS),
    ("ORACLE_PREDICATE_FAILED", SILENT_WRONG, SILENT_WRONG),
    ("ORACLE_PROBE_UNMATCHED", ROBUSTNESS, ROBUSTNESS), ("ORACLE_PREDICATE_UNCHECKED", ROBUSTNESS, ROBUSTNESS),
    ("ORACLE_REF_UNREPORTED", ROBUSTNESS, ROBUSTNESS),
    # constraint-replay findings on rules the SPEC does not state
    ("ORACLE_TANGENCY_MODE_DIFFERS", ROBUSTNESS, ROBUSTNESS), ("ORACLE_REPLAY_SIZE_BOUND", ROBUSTNESS, ROBUSTNESS),
    ("ORACLE_NORMALIZED", NORMALIZED, NORMALIZED),
    ("ORACLE_REPLAYED", MATCH, MATCH),  # the info marker of a replayed sketch solution
])
def test_oracle_findings_classes(code, want, want_independent):
    b = mutated(lambda r: F(r, 1)["warnings"].append({"code": code, "severity": "warning", "message": code,
                                                     "details": {"rule": 4}}))
    assert cls(b) == want
    assert cls(b, independent_refs=True) == want_independent


def test_bool_against_int_is_silent_wrong_in_both_directions():
    a = mutated(lambda r: r["params"][2].update(value=1))
    assert compare_reports(a, copy.deepcopy(REPORT)).classification == SILENT_WRONG
    assert compare_reports(copy.deepcopy(REPORT), a).classification == SILENT_WRONG


def test_independent_refs_mode_compares_ref_warning_codes():
    b = mutated(lambda r: F(r, 1)["warnings"].append({"code": "REF_SET_CHANGED", "severity": "warning", "message": ""}))
    assert cls(b) == MATCH
    assert cls(b, independent_refs=True) == CODE_MISMATCH


# ---------------------------------------------------------------------------------------------
# End to end: the oracle's own report as the reference, then tampered (replay mutation tests)
# ---------------------------------------------------------------------------------------------

def _tagged_doc():
    return doc(sk("s1", [rect("r", 20, 10)]), ex("e1", "s1", 4),
               {"type": "tag", "id": "t1", "name": "top", "target": ref("face", {"op": "filter", "where": {"normal": "+Z"},
                                                                          "of": {"op": "faces", "of": body_of("e1")["q"]}},
                                                                        card="one")},
               sk("s2", [circle("c", (0, 0), 2)], plane=cap("e1")),
               ex("e2", "s2", 3, op="join", targets=body_of("e1")))


def _roundtrip(forge: dict):
    oracle = run(_tagged_doc(), replay=forge)
    return compare_reports(forge, oracle)


def test_self_consistent_reference_matches():
    forge = run(_tagged_doc())
    cmp = _roundtrip(forge)
    assert cmp.classification == MATCH, [str(d) for d in cmp.differences]


def test_probe_moved_to_a_neighbouring_face_is_never_match():
    forge = run(_tagged_doc())
    m = feat(forge, "t1")["refs"][0]["members"][0]
    m["probe"] = {"kind": "face", "point": [0.0, -5.0, 2.0], "normal": [0.0, -1.0, 0.0]}  # the front side
    # default (PR gate) mode: probes replayed, predicates re-checked; no REF_MISMATCH class
    cmp = _roundtrip(forge)
    assert cmp.classification == SILENT_WRONG  # the side face fails `normal: +Z`
    assert {d.classification for d in cmp.differences} == {SILENT_WRONG, ROBUSTNESS}
    assert any("sets differ" in d.detail and d.classification == ROBUSTNESS for d in cmp.differences)
    # independent-refs mode (nightly, W7c): the set difference is also REF_MISMATCH
    oracle = run(_tagged_doc(), replay=forge, independent_refs=True)
    cmp = compare_reports(forge, oracle, independent_refs=True)
    assert {d.classification for d in cmp.differences} >= {SILENT_WRONG, REF_MISMATCH}


def _boss_on_cap(end: str):
    return doc(sk("s1", [rect("r", 20, 10)]), ex("e1", "s1", 4),
               sk("s2", [circle("c", (0, 0), 2)], plane=cap("e1", end)),
               ex("e2", "s2", 3, op="join", targets=body_of("e1")))


def test_probe_moved_on_a_predicate_free_key_query_is_never_match():
    """W7 acceptance ("a probe moved to a neighbouring face is never MATCH") on a query with no
    geometric predicate (`cap`): the PR gate builds from Forge's replayed members (§8.1), so the
    bodies agree, but the set differs from the oracle's own resolution → ROBUSTNESS in the default
    mode (§8.4 keeps REF_MISMATCH for independent-refs mode), REF_MISMATCH (and the body
    differences) in independent-refs mode."""
    forge = run(_boss_on_cap("start"))  # Forge's (wrong) choice: the start cap
    default = compare_reports(forge, run(_boss_on_cap("end"), replay=forge))
    assert default.classification == ROBUSTNESS, [str(d) for d in default.differences]
    assert [d for d in default.differences if "sets differ" in d.detail]
    oracle = run(_boss_on_cap("end"), replay=forge, independent_refs=True)
    ind = compare_reports(forge, oracle, independent_refs=True)
    assert {d.classification for d in ind.differences} >= {REF_MISMATCH, SILENT_WRONG}


def _boss_on_side(curve: str):
    return doc(sk("s1", [rect("r", 20, 10)]), ex("e1", "s1", 4),
               sk("s2", [circle("c", (0, 0), 1)], plane={"face": ref("face", {"op": "side", "feature": "e1",
                                                                             "curve": curve})}),
               ex("e2", "s2", 3, op="join", targets=body_of("e1")))


def test_probe_moved_to_a_neighbouring_side_face_is_never_match():
    forge = run(_boss_on_side("r.left"))
    ok = compare_reports(forge, run(_boss_on_side("r.left"), replay=copy.deepcopy(forge)))
    assert ok.classification == MATCH, [str(d) for d in ok.differences]
    # Forge's probe moved to the neighbouring side (the document says r.right)
    cmp = compare_reports(forge, run(_boss_on_side("r.right"), replay=forge))
    assert cmp.classification not in (MATCH, NORMALIZED)
    assert cmp.classification == ROBUSTNESS, [str(d) for d in cmp.differences]


def test_forge_member_count_violating_the_cardinality_is_silent_wrong():
    forge = run(_tagged_doc())
    feat(forge, "t1")["refs"][0]["members"].clear()  # `card: one`, reported as resolved with 0 members
    assert _roundtrip(forge).classification == SILENT_WRONG


def test_two_probes_on_one_entity_are_not_replayed():
    forge = run(_tagged_doc())
    ms = feat(forge, "t1")["refs"][0]["members"]
    ms.append(dict(ms[0], key="e1/other"))
    cmp = _roundtrip(forge)
    assert cmp.classification in (ROBUSTNESS, SILENT_WRONG) and cmp.classification != MATCH
    assert any(d.classification == ROBUSTNESS for d in cmp.differences)


def test_replay_uses_forge_members_when_the_oracles_own_naming_is_unavailable(monkeypatch):
    """A body the oracle cannot name (ORACLE_NAMING_UNAVAILABLE) no longer fails the feature in
    replay mode: Forge's probes are matched on the raw OCCT entities and used."""
    from aicad_oracle.v1 import query

    forge = run(_tagged_doc())
    real = query.unnamed

    def broken(b):
        raise query.RefFailure("ORACLE_NAMING_UNAVAILABLE", "test", {})

    monkeypatch.setattr(query, "unnamed", broken)
    oracle = run(_tagged_doc(), replay=forge)
    assert feat(oracle, "t1")["status"] == "ok"
    assert any(w["code"] == "ORACLE_REF_DIFFERS" for w in feat(oracle, "t1")["warnings"])
    monkeypatch.setattr(query, "unnamed", real)
    # standalone, the same program fails engine-internally (no probes to replay)
    monkeypatch.setattr(query, "unnamed", broken)
    assert (feat(run(_tagged_doc()), "t1").get("error") or {}).get("code") == "ORACLE_NAMING_UNAVAILABLE"


def test_added_member_that_fails_its_predicate_is_silent_wrong():
    forge = run(_tagged_doc())
    ms = feat(forge, "t1")["refs"][0]["members"]
    ms.append(dict(ms[0], key="e1/side:r.right", probe={"kind": "face", "point": [10.0, 0.0, 2.0]}))
    assert _roundtrip(forge).classification == SILENT_WRONG


def test_probe_matching_nothing_is_robustness():
    forge = run(_tagged_doc())
    feat(forge, "t1")["refs"][0]["members"][0]["probe"]["point"] = [500.0, 500.0, 500.0]
    assert _roundtrip(forge).classification == ROBUSTNESS


def test_solved_point_moved_by_1e6_is_silent_wrong():
    d = json.loads((REPO / "corpus" / "v1" / "programs" / "constrained_plate.json").read_text())
    forge = run(d)  # the fixed point: Forge's solution equals the stored guess
    forge_ok = copy.deepcopy(forge)
    assert compare_reports(forge_ok, run(d, replay=forge_ok)).classification == MATCH
    feat(forge, "s1")["sketch"]["solved"][0]["start"][1] += 1e-6
    oracle = run(d, replay=forge)
    assert compare_reports(forge, oracle).classification == SILENT_WRONG


def _plate_program():
    return json.loads((REPO / "corpus" / "v1" / "programs" / "constrained_plate.json").read_text())


@pytest.mark.parametrize("mutate", [
    # structural replay mutations (SPEC §4.3, §8.1): the solution is not of this document
    lambda s: s["solved"].append({"kind": "circle", "id": "zz", "center": [0.0, 0.0], "radius": 5.0}),  # extra hole
    lambda s: s["solved"][5].pop("construction"),  # the construction diagonal becomes a profile curve
    lambda s: s["solved"].append(copy.deepcopy(s["solved"][0])),  # duplicate id
    lambda s: s["solved"][4].update(at=[None, 0.0]),  # malformed number: not an oracle exception
    lambda s: s["dimensions"][0].update(value=80.000001),  # a dimension value Forge evaluated differently
])
def test_structural_sketch_replay_mutations_are_silent_wrong(mutate):
    d = _plate_program()
    forge = run(d)  # the fixed point, as Forge would report it
    mutate(feat(forge, "s1")["sketch"])
    cmp = compare_reports(forge, run(d, replay=forge))
    assert cmp.classification == SILENT_WRONG, [str(x) for x in cmp.differences]


def test_arc_ccw_flip_in_the_replayed_solution_is_silent_wrong():
    d = doc(sk("s1", [
        {"kind": "line", "id": "l1", "start": [0.0, 0.0], "end": [10.0, 0.0]},
        {"kind": "arc", "id": "a", "start": [10.0, 0.0], "end": [0.0, 10.0], "center": [0.0, 0.0], "ccw": True},
        {"kind": "line", "id": "l2", "start": [0.0, 10.0], "end": [0.0, 0.0]},
    ], constraints=[{"type": "horizontal", "id": "h", "line": "l1"}, {"type": "vertical", "id": "v", "line": "l2"},
                    {"type": "coincident", "id": "c", "a": "a.center", "b": "l1.start"},
                    {"type": "radius", "id": "r", "curve": "a", "value": 10.0}]), ex("e1", "s1", 2))
    forge = run(d)
    assert compare_reports(forge, run(d, replay=copy.deepcopy(forge))).classification == MATCH
    feat(forge, "s1")["sketch"]["solved"][1]["ccw"] = False  # the three-quarter disc
    assert compare_reports(forge, run(d, replay=forge)).classification == SILENT_WRONG


def _largest_edges_doc():
    """A 10 × 10.000001 × 2 box: the four y edges are the largest; the four x edges are shorter
    by 1e-7 relative — a near-tie that cross-engine size noise may resolve either way."""
    return doc(sk("s1", [rect("r", 10, 10.000001)]), ex("e1", "s1", 2),
               {"type": "tag", "id": "t1", "name": "longest",
                "target": ref("edge", {"op": "largest", "of": {"op": "edges", "of": body_of("e1")["q"]}}, card="some")})


def _with_probes(forge, points):
    ms = feat(forge, "t1")["refs"][0]["members"]
    ms[:] = [dict(ms[0], key=f"forge/{i}", probe={"kind": "edge", "point": list(p)}) for i, p in enumerate(points)]
    return forge


def test_size_pick_near_a_tie_is_unchecked_not_silent_wrong():
    from aicad_oracle.v1.replay import size_pick_tolerance

    assert size_pick_tolerance(10.0, "edge", 1.0) >= 1e-5  # rel 1e-6 of the size, beyond the 1e-9 tie band
    forge = run(_largest_edges_doc())
    assert sorted(round(m["probe"]["point"][0]) for m in feat(forge, "t1")["refs"][0]["members"]) == [-5, -5, 5, 5]
    y = 5.0000005
    near = _with_probes(copy.deepcopy(forge), [(0, -y, 0), (0, -y, 2), (0, y, 0), (0, y, 2)])  # the x edges
    cmp = _roundtrip_doc(_largest_edges_doc(), near)
    # a near-tie: within the cross-engine size tolerance, so UNCHECKED (not a false silent-wrong),
    # and the engines resolved different sets: ROBUSTNESS, never MATCH
    assert cmp.classification == ROBUSTNESS, [str(d) for d in cmp.differences]
    assert any("sets differ" in d.detail for d in cmp.differences)
    assert any("cannot be confirmed" in d.detail for d in cmp.differences)
    wrong = _with_probes(copy.deepcopy(forge), [(-5, -y, 1), (5, -y, 1), (-5, y, 1), (5, y, 1)])  # 2 mm edges
    assert _roundtrip_doc(_largest_edges_doc(), wrong).classification == SILENT_WRONG


def _roundtrip_doc(d, forge):
    return compare_reports(forge, run(d, replay=forge))


# ---------------------------------------------------------------------------------------------
# Reviewer round 2: the recursive predicate re-check, set differences, capping, rule 4, robustness
# ---------------------------------------------------------------------------------------------

SIDES = {"op": "sides", "feature": "e1"}
TOP_CAP = {"key": "e1/forge-top", "name": "top", "via": "broad", "status": "exact",
           "probe": {"kind": "face", "point": [0.0, 0.0, 4.0], "normal": [0.0, 0.0, 1.0]}}
BOTTOM_EDGE = {"key": "e1/forge-edge", "name": "edge", "via": "broad", "status": "exact",
               "probe": {"kind": "edge", "point": [0.0, -5.0, 0.0]}}


def filt(where, of=None):
    return {"op": "filter", "where": where, "of": of or SIDES}


def _query_doc(q, kind="face", card="some", *extra):
    return doc(sk("s1", [rect("r", 20, 10)]), ex("e1", "s1", 4),
               {"type": "tag", "id": "t1", "name": "sel", "target": ref(kind, q, card=card)}, *extra)


def _add_member(d, member, tag="t1"):
    forge = run(d)
    base = compare_reports(forge, run(d, replay=copy.deepcopy(forge)))
    assert base.classification == MATCH, [str(x) for x in base.differences]
    feat(forge, tag)["refs"][0]["members"].append(dict(member))
    return compare_reports(forge, run(d, replay=forge))


@pytest.mark.parametrize("q, kind, member", [
    # §8.1: a member failing every predicate of a union
    ({"op": "union", "of": [filt({"normal": "+X"}), filt({"normal": "-X"})]}, "face", TOP_CAP),
    # the `a` of a minus
    ({"op": "minus", "a": filt({"parallel": "Z"}), "b": filt({"normal": "+Y"})}, "face", TOP_CAP),
    # one operand of an intersect
    ({"op": "intersect", "of": [filt({"parallel": "Z"}), filt({"type": "plane"})]}, "face", TOP_CAP),
    # a predicate under navigation: the edges of the +Z faces of the body
    ({"op": "edges", "of": filt({"normal": "+Z"}, {"op": "faces", "of": {"op": "body", "feature": "e1"}})},
     "edge", BOTTOM_EDGE),
    # a pick under a filter chain: the highest faces
    ({"op": "extreme", "dir": "+Z", "which": "max", "of": {"op": "faces", "of": {"op": "body", "feature": "e1"}}},
     "face", dict(TOP_CAP, probe={"kind": "face", "point": [10.0, 0.0, 2.0], "normal": [1.0, 0.0, 0.0]})),
])
def test_added_member_failing_a_nested_predicate_is_silent_wrong(q, kind, member):
    cmp = _add_member(_query_doc(q, kind), member)
    assert cmp.classification == SILENT_WRONG, [str(x) for x in cmp.differences]
    assert any("fails the query's geometric predicates" in x.detail for x in cmp.differences)


def test_added_member_failing_a_tagged_query_is_silent_wrong():
    d = _query_doc(filt({"normal": "+X"}), "face", "one",
                   {"type": "tag", "id": "t2", "name": "again",
                    "target": ref("face", {"op": "tagged", "feature": "t1"}, card="some")})
    cmp = _add_member(d, TOP_CAP, tag="t2")
    assert cmp.classification == SILENT_WRONG, [str(x) for x in cmp.differences]


def test_minus_with_a_key_free_b_excludes_a_member_that_clearly_satisfies_b():
    """`b` decidable from geometry alone (`bodies`-based): a member clearly in `b` is excluded."""
    b = filt({"normal": "+Y"}, {"op": "faces", "of": {"op": "bodies"}})
    d = _query_doc({"op": "minus", "a": filt({"parallel": "Z"}), "b": b})
    plus_y = dict(TOP_CAP, probe={"kind": "face", "point": [0.0, 5.0, 2.0], "normal": [0.0, 1.0, 0.0]})
    cmp = _add_member(d, plus_y)
    assert cmp.classification == SILENT_WRONG, [str(x) for x in cmp.differences]
    assert any("excluded by `b`" in x.detail for x in cmp.differences)


def test_an_empty_oracle_pool_is_unchecked_not_skipped(monkeypatch):
    from aicad_oracle.v1 import replay

    q = {"op": "largest", "of": filt({"parallel": "Z"})}
    d = _query_doc(q, "face", "some")
    forge = run(d)
    monkeypatch.setattr(replay._Checker, "pool", lambda self, q, path: [])
    cmp = compare_reports(forge, run(d, replay=forge))
    assert cmp.classification == ROBUSTNESS
    assert any("pool of largest is empty" in x.detail for x in cmp.differences)


def test_unevaluable_predicate_is_unchecked_not_failed(monkeypatch):
    from aicad_oracle.v1 import replay

    d = _query_doc(filt({"convex": True}, {"op": "edges", "of": {"op": "body", "feature": "e1"}}), "edge")
    forge = run(d)
    monkeypatch.setattr(replay, "material_angle", lambda e: None)
    cmp = compare_reports(forge, run(d, replay=forge))
    assert cmp.classification == ROBUSTNESS, [str(x) for x in cmp.differences]
    assert not [x for x in cmp.differences if x.classification == SILENT_WRONG]


def _cylinder_doc(bound):
    return doc(sk("s1", [circle("c", (0, 0), 3)]), ex("e1", "s1", 5),
               {"type": "tag", "id": "t1", "name": "wall",
                "target": ref("face", filt({"radius": bound}, {"op": "faces", "of": {"op": "body", "feature": "e1"}}),
                              card="one")})


@pytest.mark.parametrize("bound, want", [
    ({"max": 3}, MATCH), ({"eq": 3}, MATCH),
    ({"max": 3 - 2e-6}, ROBUSTNESS),  # within rel 1e-6 of the bound: unchecked, not a false silent-wrong
    ({"max": 2.9}, SILENT_WRONG),
    ({"min": 3 + 2e-6}, ROBUSTNESS), ({"eq": 3 + 1e-6 + 2e-6}, ROBUSTNESS), ({"eq": 3.1}, SILENT_WRONG),
])
def test_radius_bounds_allow_the_cross_engine_tolerance(bound, want):
    """Forge resolved the r = 3 wall (its report from the r = 3 bound); the document's bound differs."""
    forge = run(_cylinder_doc({"eq": 3}))
    cmp = compare_reports(forge, run(_cylinder_doc(bound), replay=forge))
    assert cmp.classification == want, [str(x) for x in cmp.differences]


def test_missing_refs_entry_of_an_ok_feature_is_robustness():
    forge = run(_tagged_doc())
    del feat(forge, "t1")["refs"]
    cmp = _roundtrip(forge)
    assert cmp.classification == ROBUSTNESS
    assert any("without a `refs` entry" in x.detail for x in cmp.differences)


def _stacked():
    return doc(sk("s1", [rect("r", 10, 10)]), ex("e1", "s1", 4),
               sk("s2", [rect("q", 6, 6)], plane=cap("e1")), ex("e2", "s2", 3),
               {"type": "boolean", "id": "b1", "name": "stack", "op": "join", "targets": body_of("e1"),
                "tools": body_of("e2")})


def test_body_probe_on_a_face_shared_with_a_stacked_body_is_disambiguated_by_its_normal():
    forge = run(_stacked())
    (m,) = feat(forge, "b1")["refs"][0]["members"]
    assert m["probe"]["point"][2] == 4.0 and m["probe"]["normal"] == [0.0, 0.0, 1.0]  # on e2's footprint
    cmp = compare_reports(forge, run(_stacked(), replay=copy.deepcopy(forge)))
    assert cmp.classification == MATCH, [str(x) for x in cmp.differences]
    # without the normal the probe is ambiguous: never MATCH, never silent-wrong
    for f in forge["features"]:
        for r in f.get("refs") or []:
            for mm in r["members"]:
                mm["probe"].pop("normal", None)
    assert compare_reports(forge, run(_stacked(), replay=forge)).classification == ROBUSTNESS


# -- capping ----------------------------------------------------------------------------------------

def test_both_engines_failing_a_feature_do_not_cap_later_differences():
    def fail(c):
        return lambda r: (F(r, 2).update(status="error", error={"code": c, "message": ""}), F(r, 2).pop("datum"))

    a = mutated(fail("FORGE_INTERNAL"))
    b = mutated(lambda r: (fail("INVALID_DISTANCE")(r), F(r, 3)["bodies"][0].update(volume=501.0)))
    cmp = compare_reports(a, b)
    assert cmp.classification == SILENT_WRONG and cmp.capped == 0, [str(x) for x in cmp.differences]
    assert any(x.classification == ROBUSTNESS and "engine-internal" in x.detail for x in cmp.differences)


def test_both_engines_failing_end_to_end_then_a_later_body_difference_is_silent_wrong():
    """The reviewer's case: e2 fails in both engines (Forge engine-internally), e3 joins on e1."""
    d = doc(sk("s1", [rect("r", 10, 10)]), ex("e1", "s1", 4),
            sk("s2", [circle("c", (0, 0), 1)]), ex("e2", "s2", "t - 10"),
            sk("s3", [circle("k", (0, 0), 2)], plane=cap("e1")), ex("e3", "s3", 3, op="join", targets=body_of("e1")),
            params=[P("t", "mm", 8)])
    forge = run(d)
    assert code(feat(forge, "e2")) == "INVALID_DISTANCE" and feat(forge, "e3")["status"] == "ok"
    feat(forge, "e2")["error"]["code"] = "FORGE_INTERNAL"
    feat(forge, "e3")["bodies"][0]["volume"] *= 1.01
    cmp = compare_reports(forge, run(d, replay=forge))
    assert cmp.classification == SILENT_WRONG and cmp.capped == 0, [str(x) for x in cmp.differences]


def test_status_divergence_still_caps_later_differences():
    a = copy.deepcopy(REPORT)
    b = mutated(lambda r: (F(r, 2).update(status="error", error={"code": "ORACLE_UNSUPPORTED_FEATURE", "message": ""}),
                           F(r, 3)["bodies"][0].update(volume=1.0)))
    cmp = compare_reports(a, b)
    assert cmp.classification == ROBUSTNESS and cmp.capped == 1


# -- §8.2 warning codes are a set ------------------------------------------------------------------

def test_warning_codes_are_compared_as_a_set():
    split = {"code": "BOOLEAN_SPLIT", "severity": "info", "message": ""}
    a = mutated(lambda r: F(r, 3)["warnings"].extend([split, dict(split)]))
    b = mutated(lambda r: F(r, 3)["warnings"].append(dict(split)))
    assert compare_reports(a, b).classification == MATCH
    assert compare_reports(a, copy.deepcopy(REPORT)).classification == CODE_MISMATCH


# -- §7.1 order for constrained sketches -----------------------------------------------------------

def _constrained_on_a_missing_face():
    return doc(sk("s1", [rect("r", 10, 10)]), ex("e1", "s1", 4),
               sk("s2", [{"kind": "line", "id": "l", "start": [0.0, 0.0], "end": [5.0, 1.0]}],
                  plane={"face": ref("face", filt({"normal": "+Z"}))},
                  constraints=[{"type": "horizontal", "id": "h", "line": "l"}]))


def test_constrained_sketch_checks_its_plane_reference_before_solving():
    d = _constrained_on_a_missing_face()
    rep = run(d)
    assert code(feat(rep, "s2")) == "REF_MISSING"  # not ORACLE_SOLVE_REQUIRES_REPLAY
    forge = copy.deepcopy(rep)  # Forge fails the same way
    cmp = compare_reports(forge, run(d, replay=forge))
    assert code(feat(run(d, replay=forge), "s2")) == "REF_MISSING"
    assert cmp.classification == MATCH, [str(x) for x in cmp.differences]


def test_constrained_sketch_dimension_range_check_comes_before_the_plane():
    d = _constrained_on_a_missing_face()
    s2 = d["parts"][0]["features"][2]
    s2["constraints"].append({"type": "distance", "id": "len", "a": "l.start", "b": "l.end", "value": "t - 10"})
    d["params"] = [P("t", "mm", 8)]
    assert code(feat(run(d), "s2")) == "SKETCH_INVALID_DIMENSION"


# -- §4.4 rule 4 in replay mode ----------------------------------------------------------------------

def _square(dy=0.0, extra=()):
    y0, y1 = dy, 10.0 + dy
    curves = [{"kind": "line", "id": "a", "start": [0.0, y0], "end": [10.0, y0]},
              {"kind": "line", "id": "b", "start": [10.0, y0], "end": [10.0, y1]},
              {"kind": "line", "id": "c", "start": [10.0, y1], "end": [0.0, y1]},
              {"kind": "line", "id": "d", "start": [0.0, y1], "end": [0.0, y0]}]
    return doc(sk("s1", curves, constraints=[{"type": "horizontal", "id": "h", "line": "a"}, *extra]),
               ex("e1", "s1", 2))


@pytest.mark.parametrize("dy", [3.0, 1e-6])
def test_an_under_constrained_fixed_point_moved_along_a_free_dof_is_silent_wrong(dy):
    """The stored square satisfies its only constraint: by §4.4 rule 4 the solution is the guess.
    A self-consistent Forge report (solution and bodies) of the square moved in y is caught."""
    forge = run(_square(dy))  # solved = the moved square, bodies built from it
    forge["document"] = "t"
    cmp = compare_reports(forge, run(_square(), replay=forge))
    assert cmp.classification == SILENT_WRONG, [str(x) for x in cmp.differences]
    assert any("rule 4" in x.detail for x in cmp.differences)


@pytest.mark.parametrize("claim", ["SKETCH_CONSTRAINT_CONFLICT", "SKETCH_SOLVE_FAILED"])
def test_a_solver_failure_claimed_on_a_fixed_point_is_silent_wrong(claim):
    d = _square()
    forge = run(d)
    feat(forge, "s1").update(status="error", error={"code": claim, "message": "", "details": {}})
    for k in ("sketch", "regions"):
        feat(forge, "s1").pop(k, None)
    feat(forge, "e1").update(status="error", error={"code": "DEPENDENCY_FAILED", "message": "", "details": {}})
    feat(forge, "e1").pop("bodies", None)
    forge["parts"][0]["bodies"] = []
    forge["status"] = "error"
    cmp = compare_reports(forge, run(d, replay=forge))
    assert cmp.classification == SILENT_WRONG, [str(x) for x in cmp.differences]


def test_a_solver_failure_on_a_guess_that_needs_solving_is_mirrored():
    d = _plate_program()
    d["params"][0]["value"] = 90.0  # the stored plate is 80 wide: not a fixed point
    forge = run(_plate_program())
    s = feat(forge, "s1")
    s.update(status="error", error={"code": "SKETCH_CONSTRAINT_CONFLICT", "message": "", "details": {}})
    s.pop("sketch"), s.pop("regions")
    for f in forge["features"][1:]:
        f.update(status="error", error={"code": "DEPENDENCY_FAILED", "message": "", "details": {}})
        f.pop("bodies", None)
    forge["parts"][0]["bodies"], forge["status"] = [], "error"
    forge["params"] = run(d)["params"]
    cmp = compare_reports(forge, run(d, replay=forge))
    assert cmp.classification == MATCH, [str(x) for x in cmp.differences]
    assert any("replayed from the reference" in n for n in cmp.notes)


def test_fix_x_holds_y_at_the_welded_guess():
    """The reviewer's case, off the fixed point: `fix a.start x = 0` holds a.start.y at 0 too."""
    fix = {"type": "fix", "id": "f", "entity": "a.start", "x": 0}
    stored = _square(extra=[fix])
    stored["parts"][0]["features"][0]["curves"][0]["end"] = [10.0, 0.5]  # a is not horizontal: solve
    stored["parts"][0]["features"][0]["curves"][1]["start"] = [10.0, 0.5]
    good = run(_square(extra=[fix]))  # Forge's solution: a.end moved to y = 0
    good["document"] = "t"
    cmp = compare_reports(good, run(stored, replay=copy.deepcopy(good)))
    assert cmp.classification == MATCH, [str(x) for x in cmp.differences]
    moved = run(_square(2.0, extra=[fix]))  # self-consistent, but a.start.y = 2
    moved["document"] = "t"
    cmp = compare_reports(moved, run(stored, replay=moved))
    assert cmp.classification == SILENT_WRONG, [str(x) for x in cmp.differences]


# -- malformed reference reports are classified, never an exception --------------------------------

HOLE = {"at": "h1", "center": [0.0, 0.0, 10.0], "axis": [0.0, 0.0, -1.0], "d": 5.0, "depth": 4.0}


@pytest.mark.parametrize("mutate", [
    lambda r: F(r, 3).update(holes=[dict(HOLE, d="5")]),
    lambda r: F(r, 3).update(holes=["h1"]),
    lambda r: F(r, 2).update(datum="frame"),
    lambda r: F(r, 3)["bodies"][0].update(centroid=["a", 1, 2]),
    lambda r: F(r, 3).update(bodies={"x": 1}),
    lambda r: F(r, 3).update(error="boom", status="error"),
    lambda r: F(r, 3).update(pattern=[1, 2]),
    lambda r: F(r, 3).update(fillet={"edges": "e"}),
    lambda r: F(r, 3).update(removed="e1"),
    lambda r: F(r, 0).update(regions=[1]),
    lambda r: r["features"].__setitem__(1, "e1"),
    lambda r: r.update(features={"e1": 1}),
    lambda r: r["params"].append(dict(r["params"][0])),  # a duplicate parameter
    lambda r: r["params"].append("w"),
])
def test_malformed_reference_fields_are_differences_not_exceptions(mutate):
    b = mutated(lambda r: F(r, 3).update(holes=[dict(HOLE)]))
    a = copy.deepcopy(b)
    mutate(a)
    assert compare_reports(a, b).classification in (SILENT_WRONG, ROBUSTNESS, CODE_MISMATCH)
    assert compare_reports(b, copy.deepcopy(b)).classification == MATCH


def _two_bodies():
    return doc(sk("s1", [rect("r", 20, 10)]), ex("e1", "s1", 4),
               sk("s2", [rect("q", 6, 6, center=(40, 0))]), ex("e2", "s2", 8),
               {"type": "tag", "id": "t1", "name": "top",
                "target": ref("face", {"op": "extreme", "dir": "+Z", "which": "max",
                                       "of": {"op": "faces", "of": {"op": "body", "feature": "e1"}}}, card="one")})


@pytest.mark.parametrize("point, normal, want", [
    # a face of the wrong body, above the pool's best: the pick holds against the oracle's pool, but
    # the member is not in it (key-based membership) — the set comparison makes it ROBUSTNESS
    ([40.0, 0.0, 8.0], [0.0, 0.0, 1.0], ROBUSTNESS),
    # a face of the wrong body below the pool's best: fails the pick
    ([40.0, 0.0, 0.0], [0.0, 0.0, -1.0], SILENT_WRONG),
])
def test_a_member_from_outside_the_oracles_pool_is_never_match(point, normal, want):
    d = _two_bodies()
    forge = run(d)
    assert compare_reports(forge, run(d, replay=copy.deepcopy(forge))).classification == MATCH
    (m,) = feat(forge, "t1")["refs"][0]["members"]
    m["probe"] = {"kind": "face", "point": point, "normal": normal}
    cmp = compare_reports(forge, run(d, replay=forge))
    assert cmp.classification == want, [str(x) for x in cmp.differences]


# ---------------------------------------------------------------------------------------------
# Reviewer round 3: Refs nested in query Dirs (AxisRef, §3.2), probe normals, capped findings
# ---------------------------------------------------------------------------------------------

E1_EDGES = {"op": "edges", "of": {"op": "body", "feature": "e1"}}
#: the top X-parallel edge at +Y (midpoint (0, 5, 4)) of the 20 × 10 × 4 slab
TOP_BACK_X_EDGE = {"op": "extreme", "dir": "+Y", "which": "max",
                   "of": {"op": "extreme", "dir": "+Z", "which": "max",
                          "of": {"op": "filter", "where": {"parallel": "X"}, "of": E1_EDGES}}}
AXIS_DIR = {"edge": ref("edge", TOP_BACK_X_EDGE)}
NESTED = {"filter": ("/target/q/where/parallel/edge",
                     {"op": "filter", "where": {"parallel": AXIS_DIR}, "of": E1_EDGES}, "edge", "some"),
          "extreme": ("/target/q/dir/edge",
                      {"op": "extreme", "dir": AXIS_DIR, "which": "max",
                       "of": {"op": "faces", "of": {"op": "body", "feature": "e1"}}}, "face", "one")}
#: members that violate the enclosing query when the nested axis is +X (the correct one)
WRONG_OUTER = {"filter": [{"kind": "edge", "point": [x, 0.0, z]} for x in (-10.0, 10.0) for z in (0.0, 4.0)],
               "extreme": [{"kind": "face", "point": [-10.0, 0.0, 2.0], "normal": [-1.0, 0.0, 0.0]}]}
#: a Y-parallel edge (+X, top): not parallel to X, so it fails the nested query's filter
Y_EDGE = {"key": "e1/forge-y-edge", "name": "y", "via": "broad", "status": "exact",
          "probe": {"kind": "edge", "point": [10.0, 0.0, 4.0]}}


def _nested_doc(which):
    _, q, kind, card = NESTED[which]
    return _query_doc(copy.deepcopy(q), kind, card)


def _nested_member():
    """The oracle's own (correct) member of the nested Ref, as Forge would report it."""
    rep = run(_query_doc(copy.deepcopy(TOP_BACK_X_EDGE), "edge", "one"))
    (m,) = feat(rep, "t1")["refs"][0]["members"]
    assert m["probe"]["point"] == [0.0, 5.0, 4.0]
    return m


def _nested_entry(which, member):
    return {"field": NESTED[which][0], "status": "exact", "members": [dict(member)]}


def _codes(f, field=None):
    return [w["code"] for w in f["warnings"] if field is None or (w.get("details") or {}).get("field") == field]


@pytest.mark.parametrize("which", sorted(NESTED))
def test_an_axisref_dir_in_a_query_replays_as_match(which):
    d = _nested_doc(which)
    forge = run(d)
    want = {"filter": 4, "extreme": 1}[which]
    assert len(feat(forge, "t1")["refs"][0]["members"]) == want
    # the nested Ref has no `refs` entry of its own (as forge-refs), and that is not UNREPORTED
    assert [r["field"] for r in feat(forge, "t1")["refs"]] == ["/target"]
    oracle = run(d, replay=copy.deepcopy(forge))
    assert _codes(feat(oracle, "t1")) == []
    assert compare_reports(forge, oracle).classification == MATCH
    # a correct nested entry reported by Forge is checked and accepted
    forge["features"][2]["refs"].append(_nested_entry(which, _nested_member()))
    oracle = run(d, replay=copy.deepcopy(forge))
    assert _codes(feat(oracle, "t1")) == []
    assert compare_reports(forge, oracle).classification == MATCH


@pytest.mark.parametrize("which", sorted(NESTED))
def test_a_wrong_nested_member_never_steers_the_replay(which):
    """The reviewer's repro: Forge's outer members built from a wrong nested axis (the Y edges),
    and the nested entry reporting that wrong axis edge. The oracle resolves the nested Ref itself,
    so the outer members fail the re-check (POTENTIAL_SILENT_WRONG), and the nested entry's own
    re-check fails too — the findings reach the feature's warnings."""
    d = _nested_doc(which)
    forge = run(d)
    fields = NESTED[which][0]
    t1 = feat(forge, "t1")
    t1["refs"][0]["members"] = [{"key": f"e1/forge-{i}", "name": f"m{i}", "via": "broad", "status": "exact",
                                 "probe": p} for i, p in enumerate(WRONG_OUTER[which])]
    # (a) the outer members alone
    oracle = run(d, replay=copy.deepcopy(forge))
    assert "ORACLE_PREDICATE_FAILED" in _codes(feat(oracle, "t1"), "/target")
    assert compare_reports(forge, oracle).classification == SILENT_WRONG
    # (b) plus Forge's nested entry designating the Y edge
    t1["refs"].append(_nested_entry(which, Y_EDGE))
    oracle = run(d, replay=copy.deepcopy(forge))
    nested = _codes(feat(oracle, "t1"), fields)
    assert "ORACLE_PREDICATE_FAILED" in nested and "ORACLE_REF_DIFFERS" in nested, feat(oracle, "t1")["warnings"]
    assert "ORACLE_PREDICATE_FAILED" in _codes(feat(oracle, "t1"), "/target")
    cmp = compare_reports(forge, oracle)
    assert cmp.classification == SILENT_WRONG
    assert any(fields in x.detail and x.classification == SILENT_WRONG for x in cmp.differences)
    # (c) only the nested entry is wrong (outer members correct): still never MATCH
    good = run(d)
    feat(good, "t1")["refs"].append(_nested_entry(which, Y_EDGE))
    cmp = compare_reports(good, run(d, replay=copy.deepcopy(good)))
    assert cmp.classification == SILENT_WRONG, [str(x) for x in cmp.differences]
    # independent-refs mode: the nested set difference is REF_MISMATCH
    oracle = run(d, replay=copy.deepcopy(good), independent_refs=True)
    assert "ORACLE_REF_MISMATCH" in _codes(feat(oracle, "t1"), fields)
    cmp = compare_reports(good, oracle, independent_refs=True)
    assert {x.classification for x in cmp.differences} >= {SILENT_WRONG, REF_MISMATCH}


def test_a_nested_member_failing_only_a_pick_is_silent_wrong():
    """Forge's nested member is the other top X edge (at −Y): it satisfies the nested query's
    filter and the +Z pick, only the +Y pick fails — and the axis it gives is the same (+X), so
    the enclosing query's result is unchanged. The nested entry alone is still never MATCH."""
    d = _nested_doc("filter")
    forge = run(d)
    other = dict(_nested_member(), key="e1/forge-front-top", probe={"kind": "edge", "point": [0.0, -5.0, 4.0]})
    feat(forge, "t1")["refs"].append(_nested_entry("filter", other))
    oracle = run(d, replay=copy.deepcopy(forge))
    codes = _codes(feat(oracle, "t1"), "/target/q/where/parallel/edge")
    assert "ORACLE_REF_DIFFERS" in codes and "ORACLE_PREDICATE_FAILED" in codes  # the +Y pick
    assert compare_reports(forge, oracle).classification == SILENT_WRONG


def test_a_nested_entry_at_a_pointer_that_is_not_this_ref_is_ignored():
    """A `tagged` query's content is evaluated under the tagging feature's path; Forge's entry at
    such a pointer (which does not exist in the feature) is not taken for the tag's nested Ref."""
    d = doc(sk("s1", [rect("r", 20, 10)]), ex("e1", "s1", 4),
            {"type": "tag", "id": "t1", "name": "x", "target": ref("edge", NESTED["filter"][1])},
            {"type": "tag", "id": "t2", "name": "y", "target": ref("edge", {"op": "tagged", "feature": "t1"})})
    forge = run(d)
    feat(forge, "t2")["refs"].append({"field": "/target/q/where/parallel/edge", "status": "exact",
                                      "members": [dict(Y_EDGE)]})
    oracle = run(d, replay=copy.deepcopy(forge))
    assert _codes(feat(oracle, "t2")) == []
    assert compare_reports(forge, oracle).classification == MATCH


# -- the downstream cap and replay findings ----------------------------------------------------------

def _diverge_at_datum(r):
    F(r, 2).update(status="error", error={"code": "ORACLE_UNSUPPORTED_FEATURE", "message": ""})
    F(r, 2).pop("datum")


@pytest.mark.parametrize("finding, want", [
    ("ORACLE_PREDICATE_FAILED", SILENT_WRONG),
    ("ORACLE_REF_MISMATCH", REF_MISMATCH),  # read in independent-refs mode
])
def test_reference_replay_findings_downstream_of_a_divergence_are_capped(finding, want):
    """After a status divergence Forge's probes are replayed onto a different B-rep: a failed
    predicate there is capped at ROBUSTNESS like every other downstream difference (listed,
    counted), never a silent-wrong answer — and upstream it keeps its class."""
    w = {"code": finding, "severity": "warning", "message": f"{finding} on e2", "details": {"field": "/targets"}}
    downstream = mutated(lambda r: (_diverge_at_datum(r), F(r, 3)["warnings"].append(dict(w))))
    cmp = compare_reports(REPORT, downstream, independent_refs=True)
    assert cmp.classification == ROBUSTNESS and cmp.capped == 1, [str(x) for x in cmp.differences]
    assert any(finding in x.detail and "downstream of" in x.detail and f"would be {want}" in x.detail
               for x in cmp.differences)
    upstream = mutated(lambda r: F(r, 1)["warnings"].append(dict(w)))
    assert compare_reports(REPORT, upstream, independent_refs=True).classification == want


def test_a_failed_sketch_replay_check_downstream_of_a_divergence_stays_silent_wrong():
    """The constrained-sketch replay check does not depend on the part state (2D, parameters
    only), so Forge's wrong solution is reported wherever it occurs (`_Cmp.oracle_findings`)."""
    sketch = {"part": "part", "feature": "late", "feature_id": "s9", "type": "sketch", "status": "ok",
              "warnings": [], "regions": [], "sketch": {"mode": "constrained", "solved": []}}
    a = mutated(lambda r: r["features"].append(copy.deepcopy(sketch)))
    b = mutated(lambda r: (_diverge_at_datum(r), r["features"].append(dict(
        copy.deepcopy(sketch), status="error", error={"code": "ORACLE_REPLAY_CHECK_FAILED", "message": "moved"}))))
    cmp = compare_reports(a, b)
    assert cmp.classification == SILENT_WRONG, [str(x) for x in cmp.differences]
    assert any("independent check" in x.detail and x.classification == SILENT_WRONG for x in cmp.differences)


# -- probe normals (§7.6: face and body probes carry the outward normal) -----------------------------

@pytest.mark.parametrize("normal, want", [
    ([0.0, 0.0, 1.0], MATCH),
    ([0.0, math.sin(5e-4), math.cos(5e-4)], MATCH),
    ([0.0, math.sin(2e-3), math.cos(2e-3)], MATCH),  # [W0-35]: a positive dot product (was 1e-3 rad)
    # §8.1 [W0-35] tests the normal only "when several faces or bodies are within r": one face is
    # the match whatever its normal (W7b review 4: the oracle follows the SPEC; the stricter test
    # for a single candidate is a Contract-stage proposal, `replay.PENDING_DEVIATIONS`)
    ([0.0, math.sin(1.6), math.cos(1.6)], MATCH),  # past 90°
    ([0.0, 0.0, -1.0], MATCH),  # a flipped (inward) normal
])
def test_a_single_face_candidate_must_agree_with_the_probe_normal(normal, want):
    forge = run(_tagged_doc())
    (m,) = feat(forge, "t1")["refs"][0]["members"]
    assert m["probe"]["point"][2] == 4.0
    m["probe"]["normal"] = normal
    oracle = run(_tagged_doc(), replay=copy.deepcopy(forge))
    cmp = compare_reports(forge, oracle)
    assert cmp.classification == want, [str(x) for x in cmp.differences]
    if want != MATCH:
        (w,) = [w for w in feat(oracle, "t1")["warnings"] if w["code"] == "ORACLE_PROBE_UNMATCHED"]
        assert w["details"]["matches"] == 0 and "outward normal" in w["details"]["reason"]


def test_a_single_body_candidate_must_agree_with_the_probe_normal():
    forge = run(_tagged_doc())
    e2 = feat(forge, "e2")
    (m,) = e2["refs"][0]["members"]
    assert m["probe"]["kind"] == "body" and m["probe"].get("normal")
    assert compare_reports(forge, run(_tagged_doc(), replay=copy.deepcopy(forge))).classification == MATCH
    m["probe"]["normal"] = [-x for x in m["probe"]["normal"]]
    oracle = run(_tagged_doc(), replay=copy.deepcopy(forge))
    # one body within r: the match whatever its normal (§8.1; W7b review 4)
    assert "ORACLE_PROBE_UNMATCHED" not in [w["code"] for w in feat(oracle, "e2")["warnings"]]
    assert compare_reports(forge, oracle).classification == MATCH
    # a probe without a normal is matched by position alone (§8.1)
    m["probe"].pop("normal")
    assert compare_reports(forge, run(_tagged_doc(), replay=copy.deepcopy(forge))).classification == MATCH


# -- constraint-replay findings on rules the SPEC does not state --------------------------------------

def _s_curve_plate(internal):
    """Two r = 10 arcs welded at (10, 0), externally tangent, closed by two lines."""
    curves = [{"kind": "arc", "id": "a1", "start": [0.0, -10.0], "end": [10.0, 0.0], "center": [0.0, 0.0], "ccw": True},
              {"kind": "arc", "id": "a2", "start": [10.0, 0.0], "end": [20.0, 10.0], "center": [20.0, 0.0],
               "ccw": False},
              {"kind": "line", "id": "l1", "start": [20.0, 10.0], "end": [20.0, -10.0]},
              {"kind": "line", "id": "l2", "start": [20.0, -10.0], "end": [0.0, -10.0]}]
    t = {"type": "tangent", "id": "t", "a": "a1", "b": "a2", **({} if internal is None else {"internal": internal})}
    return doc(sk("s1", curves, constraints=[t]), ex("e1", "s1", 2))


@pytest.mark.parametrize("internal, want", [(None, MATCH), (False, MATCH), (True, ROBUSTNESS)])
def test_an_arc_arc_joint_tangency_replays_whatever_internal_says(internal, want):
    """End to end: forge-solve ignores `internal` at an arc–arc joint, so the welded guess is a fixed
    point it returns unchanged; the oracle accepts it (standalone and replayed) and reports a mode
    that contradicts `internal` as ROBUSTNESS (ORACLE_TANGENCY_MODE_DIFFERS), never silent-wrong."""
    d = _s_curve_plate(internal)
    forge = run(d)
    assert feat(forge, "s1")["status"] == "ok" and feat(forge, "e1")["status"] == "ok"
    oracle = run(d, replay=copy.deepcopy(forge))
    codes = [w["code"] for w in feat(oracle, "s1")["warnings"]]
    assert ("ORACLE_TANGENCY_MODE_DIFFERS" in codes) == (internal is True), codes
    cmp = compare_reports(forge, oracle)
    assert cmp.classification == want, [str(x) for x in cmp.differences]


def test_a_nested_ref_the_oracle_cannot_resolve_is_robustness_not_match():
    """The oracle's own resolution of the nested Ref fails (no circle edge): standalone the tag
    fails with the nested code, as before; replaying Forge's (ok) report, the outer members are
    replayed with their predicates on that Dir unchecked — ROBUSTNESS, never MATCH."""
    no_circle = {"edge": ref("edge", {"op": "filter", "where": {"type": "circle"}, "of": E1_EDGES})}
    bad = _query_doc({"op": "filter", "where": {"parallel": no_circle}, "of": E1_EDGES}, "edge", "some")
    alone = feat(run(bad), "t1")
    assert alone["status"] == "error" and code(alone).startswith("REF_"), alone
    forge = run(_nested_doc("filter"))
    oracle = run(bad, replay=copy.deepcopy(forge))
    t1 = feat(oracle, "t1")
    assert t1["status"] == "ok" and len(t1["refs"][0]["members"]) == 4
    codes = _codes(t1, "/target")
    assert "ORACLE_PREDICATE_UNCHECKED" in codes and "ORACLE_REF_DIFFERS" in codes, t1["warnings"]
    assert compare_reports(forge, oracle).classification == ROBUSTNESS
