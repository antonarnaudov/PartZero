"""W7b: reference replay per [W0-35], [W0-50] and [W0-54] (probe radius, face / body normals by a
positive dot product, edge normals by the largest dot product, probes without `normal` by position
alone), coincident faces with agreeing normals left unmatched (§8.1: no tie-break by key), and the
`references/probes.json` runner."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from test_v1_support import body_of, cap, doc, ex, feat, max_matching, rect, run, sk

from aicad_oracle.v1.compare import MATCH, ROBUSTNESS, compare_reports
from aicad_oracle.v1.consts import LINEAR_TOLERANCE as TOL
from aicad_oracle.v1.evaluate import evaluate_data
from aicad_oracle.v1.replay import match_radius

REPO = Path(__file__).resolve().parents[2]
PROBES = json.loads((REPO / "corpus/v1/conformance/references/probes.json").read_text())["cases"]


@pytest.mark.parametrize("s, r", [(1.0, 2 * TOL), (3.0, 3e-6), (10.0, 5 * TOL), (120.0, 5 * TOL)])
def test_match_radius_is_clamped(s, r):
    assert match_radius(s) == pytest.approx(r, rel=1e-12)


def _replay(d: dict, mutate=None) -> tuple[dict, dict]:
    forge = run(d)
    if mutate:
        mutate(forge)
    oracle = run(d, replay=copy.deepcopy(forge))
    return forge, oracle


def _findings(rep: dict, fid: str) -> list[str]:
    return [w["code"] for w in feat(rep, fid)["warnings"]]


def _overlapping_caps():
    """Two separate bodies whose start caps lie in one plane and overlap where the second body's
    probe falls (the sketch-on-face case of v1 seeds 5, 23 and 47)."""
    return doc(sk("s1", [rect("a", 20, 20)]), ex("e1", "s1", 5),
               sk("s2", [rect("b", 10, 10, center=(3, 2))]), ex("e2", "s2", 8),
               sk("s3", [rect("c", 2, 2, center=(3, 2))], plane=cap("e2", "start")),
               ex("e3", "s3", 1, op="join", targets=body_of("e2")))


#: Contract-stage question (`replay.PENDING_DEVIATIONS["key-tie-break"]`; W7b report, CONTRACT
#: ISSUES 2): may the replay tell coincident faces with agreeing normals apart by the member's key?
#: §8.1 [W0-35] says "more than one left is not a match", so today's outcome is
#: `ORACLE_PROBE_UNMATCHED` → ROBUSTNESS (asserted below, like Forge's `FORGE_PENDING_*`). Were the
#: SPEC amended with the tie-break, these would be MATCH.
ORACLE_PENDING_KEY_TIEBREAK = {"overlapping-caps": ROBUSTNESS}

#: The Contract-stage question `replay.PENDING_DEVIATIONS["single-candidate-normal"]` (W7b report,
#: CONTRACT ISSUES): §8.1 [W0-35] applies the face/body normal test only among several candidates,
#: and the oracle follows it (W7b review 4; before, it applied the test to a single candidate too,
#: which is the proposal): a single face whose outward normal contradicts the probe's is the match
#: → MATCH. Were §8.1 amended to test every candidate count, these would be ROBUSTNESS.
ORACLE_PENDING_SINGLE_CANDIDATE_NORMAL = {"flipped-normal-single-face": MATCH,
                                          "flipped-normal-single-body": MATCH}


def test_the_pending_deviations_are_recorded():
    from aicad_oracle.v1.replay import PENDING_DEVIATIONS

    assert set(PENDING_DEVIATIONS) == {"single-candidate-normal", "key-tie-break"}
    assert all(set(v) == {"spec", "oracle", "outcome"} for v in PENDING_DEVIATIONS.values())


def _one_box_with_top_tag():
    return doc(sk("s1", [rect("a", 10, 10)]), ex("e1", "s1", 4),
               {"type": "tag", "id": "t1", "name": "top", "target": {"kind": "face", "q": {
                   "op": "cap", "feature": "e1", "end": "end"}}},
               {"type": "tag", "id": "t2", "name": "whole", "target": body_of("e1")})


@pytest.mark.parametrize("case, fid", [("flipped-normal-single-face", "t1"), ("flipped-normal-single-body", "t2")])
def test_a_single_candidate_with_a_contradicting_normal_is_pending(case, fid):
    """One face (body) within r, its outward normal opposite to the probe's: the match, per §8.1
    (the normal test is for several candidates)."""
    def flip(rep):
        m = feat(rep, fid)["refs"][0]["members"][0]
        m["probe"]["normal"] = [-x for x in m["probe"]["normal"]]

    forge, oracle = _replay(_one_box_with_top_tag(), flip)
    assert not [w for w in feat(oracle, fid)["warnings"] if w["code"] == "ORACLE_PROBE_UNMATCHED"]
    assert compare_reports(forge, oracle).classification == ORACLE_PENDING_SINGLE_CANDIDATE_NORMAL[case]


def test_coincident_faces_with_agreeing_normals_are_unmatched_per_the_spec():
    """§8.1 [W0-35]: two faces left after the normal test are no match — the caps of e1 and e2 lie
    in z = 0 and overlap where s3's plane probe falls, both with outward normal −Z."""
    forge, oracle = _replay(_overlapping_caps())
    w = next(x for x in feat(oracle, "s3")["warnings"] if x["code"] == "ORACLE_PROBE_UNMATCHED")
    assert w["details"]["matches"] == 2 and "not a match" in w["details"]["reason"]
    assert compare_reports(forge, oracle).classification == ORACLE_PENDING_KEY_TIEBREAK["overlapping-caps"]
    # the fallback to the oracle's own resolution still builds the same part
    assert [b["volume"] for b in forge["parts"][0]["bodies"]] == [b["volume"] for b in oracle["parts"][0]["bodies"]]


def test_a_probe_without_normal_on_coincident_faces_stays_unmatched():
    def drop(rep):
        for m in feat(rep, "s3")["refs"][0]["members"]:
            m["probe"].pop("normal", None)

    forge, oracle = _replay(_overlapping_caps(), drop)
    assert "ORACLE_PROBE_UNMATCHED" in _findings(oracle, "s3")
    assert compare_reports(forge, oracle).classification == ROBUSTNESS


def _touching_boxes():
    """Box A = [0, 10]³ and box B = [10, 20] × [0, 10]², touching on x = 10: A's and B's vertical
    edges at (10, 0) coincide; a tag selects A's by `between`."""
    return doc(sk("s1", [rect("a", 10, 10, center=(5, 5))]), ex("e1", "s1", 10),
               sk("s2", [rect("b", 10, 10, center=(15, 5))]), ex("e2", "s2", 10),
               {"type": "tag", "id": "t1", "name": "edge", "target": {"kind": "edge", "q": {
                   "op": "between", "a": {"op": "side", "feature": "e1", "curve": "a.right"},
                   "b": {"op": "side", "feature": "e1", "curve": "a.bottom"}}}})


def test_coincident_edges_are_told_apart_by_the_largest_dot_product():
    forge, oracle = _replay(_touching_boxes())
    (m,) = feat(forge, "t1")["refs"][0]["members"]
    assert m["probe"]["normal"] == pytest.approx([2 ** -0.5, -(2 ** -0.5), 0.0], abs=1e-12)
    assert "ORACLE_PROBE_UNMATCHED" not in _findings(oracle, "t1")
    assert compare_reports(forge, oracle).classification == MATCH


def test_an_edge_probe_without_normal_among_coincident_edges_is_unmatched():
    def drop(rep):
        feat(rep, "t1")["refs"][0]["members"][0]["probe"].pop("normal")

    forge, oracle = _replay(_touching_boxes(), drop)
    assert "ORACLE_PROBE_UNMATCHED" in _findings(oracle, "t1")
    assert compare_reports(forge, oracle).classification == ROBUSTNESS


def test_an_edge_probe_without_normal_matches_a_single_edge_by_position():
    """[W0-54]: one edge within r is the match (Forge's edge probes carry no normal until W3)."""
    d = doc(sk("s1", [rect("a", 10, 10)]), ex("e1", "s1", 4),
            {"type": "tag", "id": "t1", "name": "edge", "target": {"kind": "edge", "q": {
                "op": "between", "a": {"op": "side", "feature": "e1", "curve": "a.right"},
                "b": {"op": "cap", "feature": "e1", "end": "end"}}}})

    def drop(rep):
        feat(rep, "t1")["refs"][0]["members"][0]["probe"].pop("normal")

    forge, oracle = _replay(d, drop)
    assert "ORACLE_PROBE_UNMATCHED" not in _findings(oracle, "t1")
    assert compare_reports(forge, oracle).classification == MATCH


def test_a_face_probe_a_little_off_its_face_matches_only_within_the_radius():
    d = doc(sk("s1", [rect("a", 0.5, 0.5)]), ex("e1", "s1", 0.2),  # s < 1: r = 2·tol
            {"type": "tag", "id": "t1", "name": "top", "target": {"kind": "face", "q": {"op": "cap", "feature": "e1",
                                                                                      "end": "end"}}})
    for dz, ok in ((1.5e-6, True), (3e-6, False)):
        def move(rep, dz=dz):
            feat(rep, "t1")["refs"][0]["members"][0]["probe"]["point"][2] += dz

        _, oracle = _replay(d, move)
        assert ("ORACLE_PROBE_UNMATCHED" not in _findings(oracle, "t1")) is ok


# -- references/probes.json ------------------------------------------------------------------------

#: Probe points (mm) and unit normals are compared per component within this (the Rust runner's
#: `PROBE_TOLERANCE`).
PROBE_TOLERANCE = 1e-9


def _close3(g, w) -> bool:
    return (isinstance(g, list) and isinstance(w, list) and len(g) == 3 and len(w) == 3
            and all(abs(a - b) <= PROBE_TOLERANCE for a, b in zip(g, w)))


def _probe_match(got: dict, want: dict) -> bool:
    """A member probe against a fixture probe. A fixture `normal: null` (or no `normal`) means the
    probe has **no normal**: the key omitted or `null`, both of which the metrics schema allows for
    probes (§11.1's `references/probes.json` row, §7.6) — the Rust runner's `probe_fits`. (§9.4's
    null-means-absent rule is for `details`, not probes; W7b review 5.)"""
    if got.get("kind") != want["kind"] or not _close3(got.get("point"), want["point"]):
        return False
    wn = want.get("normal")
    if wn is None:
        return got.get("normal") is None
    return _close3(got.get("normal"), wn)


def test_a_fixture_null_normal_means_no_normal_omitted_or_null():
    want = {"kind": "edge", "point": [0.0, 0.0, 0.0], "normal": None}
    assert _probe_match({"kind": "edge", "point": [0.0, 0.0, 0.0]}, want)
    assert _probe_match({"kind": "edge", "point": [0.0, 0.0, 0.0], "normal": None}, want)
    assert not _probe_match({"kind": "edge", "point": [0.0, 0.0, 0.0], "normal": [0.0, 0.0, 1.0]}, want)
    assert _probe_match({"kind": "edge", "point": [0.0, 0.0, 0.0]}, {"kind": "edge", "point": [0.0, 0.0, 0.0]})
    assert not _probe_match({"kind": "edge", "point": [0.0, 0.0, 0.0], "normal": None},
                            {"kind": "edge", "point": [0.0, 0.0, 0.0], "normal": [0.0, 0.0, 1.0]})


#: Cases the oracle does not follow yet, with the problems `_probe_problems` reports for them
#: today (asserted, like Forge's `FORGE_PENDING_PROBES`: a pending case must still differ from the
#: expectation, so fixing it forces its removal here). Empty: the oracle follows both cases.
ORACLE_PENDING_PROBES: dict[str, list] = {}


def _probe_problems(rep: dict, expect: dict) -> list[str]:
    """The differences between a report and a `probes.json` expectation: per feature and field,
    the expected probes (a multiset) matched to distinct reported members, then the unmatched."""
    out = []
    for fid, fields in expect.items():
        f = feat(rep, fid)
        for field, want in fields.items():
            got = [m["probe"] for r in f.get("refs") or [] if r["field"] == field for m in r["members"]]
            # a maximum matching (the Rust runner's Kuhn `unmatched`), not a greedy pass in fixture
            # order (W7b review 5)
            m = max_matching(len(want), len(got), lambda i, j: _probe_match(got[j], want[i]))
            out += [f"{fid}{field}: no member probe matches {w}" for i, w in enumerate(want) if i not in m]
            used = set(m.values())
            out += [f"{fid}{field}: unexpected member probe {g}" for j, g in enumerate(got) if j not in used]
    return out


@pytest.mark.parametrize("case", PROBES, ids=lambda c: c["id"])
def test_probes_fixture(case):
    """`references/probes.json` ([W0-50], [W0-54]): the members' probes as a multiset, matched to
    distinct members; the oracle's own probes (its report entries)."""
    bad = _probe_problems(evaluate_data(case["document"], case["id"]), case["expect"])
    if case["id"] in ORACLE_PENDING_PROBES:
        assert bad == ORACLE_PENDING_PROBES[case["id"]] and bad
    else:
        assert bad == []


def test_the_probe_runner_reports_missing_and_extra_members():
    rep = {"features": [{"feature_id": "t1", "refs": [{"field": "/target", "members": [
        {"probe": {"kind": "edge", "point": [0.0, 0.0, 0.0]}},
        {"probe": {"kind": "edge", "point": [1.0, 0.0, 0.0], "normal": [0.0, 0.0, 1.0]}}]}]}]}
    ok = {"t1": {"/target": [{"kind": "edge", "point": [0.0, 0.0, 0.0], "normal": None},
                             {"kind": "edge", "point": [1.0, 0.0, 0.0], "normal": [0.0, 0.0, 1.0]}]}}
    assert _probe_problems(rep, ok) == []
    assert len(_probe_problems(rep, {"t1": {"/target": ok["t1"]["/target"][:1]}})) == 1  # an extra member
    two = {"t1": {"/target": [ok["t1"]["/target"][0]] * 2}}
    assert len(_probe_problems(rep, two)) == 2  # one expected probe unmatched, one member left over


def test_the_probe_runner_matches_a_multiset_not_in_fixture_order():
    """A member at x = 0.75e-9 fits both expected probes (x = 0 and x = 1.5e-9, each within
    `PROBE_TOLERANCE`), the member at x = 0 only the first: a greedy pass that gives the first
    expected probe the first member leaves the second unmatched — a false failure."""
    def pt(x):
        return {"kind": "edge", "point": [x, 0.0, 0.0]}

    rep = {"features": [{"feature_id": "t1", "refs": [{"field": "/target", "members": [
        {"probe": pt(0.75e-9)}, {"probe": pt(0.0)}]}]}]}
    assert _probe_problems(rep, {"t1": {"/target": [pt(0.0), pt(1.5e-9)]}}) == []
    assert len(_probe_problems(rep, {"t1": {"/target": [pt(1.5e-9), pt(1.5e-9)]}})) == 2
