"""W7b: the IR v1 error corpus (IR-V1 plan, W7 acceptance: "at least 3 cases per **E** code the
oracle can compute, each with the expected code; the oracle agrees with every expectation").

The corpus is `aicad_oracle.v1.errcorpus.CASES` — documents, which `oracle gen --ir v1` writes to
`<out>/invalid` with the manifest `err1_expected.stats.json`, so that `oracle diff` runs Forge against them.
Every code of the catalogue with an E stage (`E` or `R/E`) is covered by at least three documents
that fail it at the E stage, except the ones `NOT_COMPUTABLE` names with a reason."""

from __future__ import annotations

import collections
import json

import pytest
from test_v1_support import run

from aicad_oracle.v1 import errcorpus
from aicad_oracle.v1.consts import error_codes
from aicad_oracle.v1.errcorpus import CASES, NOT_COMPUTABLE, e_codes, expected_codes, outcome
from aicad_oracle.v1.load import load_value


def test_at_least_three_cases_per_computable_e_code():
    n = collections.Counter(c.code for c in CASES)
    short = {k: n[k] for k in expected_codes() if n[k] < 3}
    assert not short, short
    # nothing outside the E codes, nothing both covered and excluded
    assert set(n) <= set(expected_codes())
    assert set(NOT_COMPUTABLE) <= set(e_codes()) and not set(NOT_COMPUTABLE) & set(n)


def test_the_excluded_codes_are_the_plans_and_the_documented_ones():
    """The plan excludes the replay-only solver outcomes; the others need an OCCT failure at every
    size, an engine's own invalid body, or the §5.7 step 4 fallback the oracle does not implement."""
    assert {"SKETCH_CONSTRAINT_CONFLICT", "SKETCH_SOLVE_FAILED"} <= set(NOT_COMPUTABLE)
    assert set(NOT_COMPUTABLE) == {"SKETCH_CONSTRAINT_CONFLICT", "SKETCH_SOLVE_FAILED", "FILLET_FAILED",
                                   "CHAMFER_FAILED", "SHELL_FAILED", "DRAFT_FAILED", "INVALID_RESULT",
                                   "REF_UNCERTAIN"}
    assert all(error_codes()[k]["stage"] == "E" for k in NOT_COMPUTABLE)


def test_case_names_are_unique():
    assert len({c.name for c in CASES}) == len(CASES)


@pytest.mark.parametrize("case", CASES, ids=[c.name for c in CASES])
def test_error_corpus(case):
    """The document passes the rejection pipeline (the code is an evaluation outcome, not a
    rejection), and the oracle fails the named feature or parameter with the expected code."""
    load_value(json.loads(json.dumps(case.doc)))
    rep = run(case.doc)
    assert outcome(rep, case) == case.code, [
        (f["feature_id"], f["error"]["code"]) for f in rep["features"] if f.get("error")] + [
        (p["name"], p["error"]["code"]) for p in rep["params"] if p.get("error")]


def test_the_corpus_is_written_as_documents_with_a_manifest(tmp_path, monkeypatch):
    """`oracle gen --ir v1` writes the corpus (here three cases, to keep the test quick) with
    its manifest; a disagreeing expectation is reported, never written as agreeing."""
    few = [c for c in CASES if c.code in ("HOLE_MISSES_BODY", "PARAM_FAILED")][:3]
    wrong = errcorpus.ErrCase("wrong", few[0].doc, "BOOLEAN_EMPTY_RESULT", few[0].where)
    monkeypatch.setattr(errcorpus, "CASES", [*few, wrong])
    res = errcorpus.write_corpus(tmp_path / "invalid")
    man = json.loads((tmp_path / "invalid" / errcorpus.MANIFEST).read_text())
    assert res["cases"] == 4 and [m["expected"] for m in res["mismatches"]] == ["BOOLEAN_EMPTY_RESULT"]
    assert [m["code"] for m in man["cases"]] == [c.code for c in few] + ["BOOLEAN_EMPTY_RESULT"]
    for m in man["cases"]:
        d = load_value(json.loads((tmp_path / "invalid" / m["file"]).read_text()))
        assert d is not None and ("feature" in m or "param" in m)
    assert set(man["not_computable"]) == set(NOT_COMPUTABLE)


def test_gen_v1_writes_the_error_corpus(tmp_path, monkeypatch):
    from aicad_oracle.cli import main

    few = [c for c in CASES if c.code == "HOLE_UP_TO_MISSED"]
    monkeypatch.setattr(errcorpus, "CASES", few)
    out = tmp_path / "gen"
    assert main(["gen", "--ir", "v1", "--family", "booleans", "--count", "1", "--seed", "3", "--jobs", "1",
                 "--out", str(out)]) == 0
    from aicad_oracle.diffrun import list_programs

    assert (out / "invalid" / errcorpus.MANIFEST).exists()
    # `oracle diff` takes the programs, not the manifest
    progs = [p.name for p in list_programs(out / "invalid")]
    assert len(progs) == len(few) == 3 and all(p.startswith("err1_0") for p in progs)


def test_a_points_only_sketch_is_valid_and_places_holes():
    """v1: a sketch of points (and construction curves) has no regions and is `ok` — its points
    place holes (§6.5); only a body feature consuming it fails with `SKETCH_NO_REGIONS` (Forge's
    reading; the oracle failed the sketch itself before, a status difference the corpus exposed)."""
    from test_v1_support import PI, cap, doc, ex, feat, rect, rel, sk

    d = doc(sk("s1", [rect("o", 40, 40)]), ex("e1", "s1", 10),
            sk("s2", [{"kind": "point", "id": "a", "at": [5, 5]}, {"kind": "point", "id": "b", "at": [-5, 5]}],
               plane=cap("e1")),
            {"type": "hole", "id": "h1", "name": "h", "on": cap("e1"), "at": {"points": {"sketch": "s2", "ids": "all"}},
             "d": 2, "depth": "through"})
    rep = run(d)
    assert feat(rep, "s2")["status"] == "ok" and feat(rep, "s2")["regions"] == []
    (b,) = feat(rep, "h1")["bodies"]
    assert rel(b["volume"], 40 * 40 * 10 - 2 * PI * 10) < 1e-9


# -- W7b review 4: §0.5 rule 2 for every angle field -----------------------------------------------

def _angle_docs():
    """(name, feature id, a document builder taking the angle value) for every angle field with a
    range check: revolve and circular pattern (`INVALID_ANGLE`), chamfer, draft, hole tip and
    countersink (`INVALID_VALUE`)."""
    from test_v1_support import body_of, cap, circle, ex, rect, rv, sk

    def plate():
        return [sk("s1", [rect("o", 40, 30)]), ex("e1", "s1", 10)]

    top = {"kind": "edge", "q": {"op": "edges", "of": {"op": "cap", "feature": "e1", "end": "end"}}}
    top_face = {"kind": "face", "q": {"op": "cap", "feature": "e1", "end": "end"}}
    boss = [*plate(), sk("s2", [circle("b", (5, 0), 2)], plane=cap("e1")),
            ex("e2", "s2", 3, op="join", targets=body_of("e1"))]
    one = {"list": [{"id": "a", "at": [0, 0]}]}
    return [
        ("revolve", "r1", lambda a: [sk("s1", [rect("o", 4, 4, center=(5, 0))]), rv("r1", "s1", a)]),
        ("circular", "pt1", lambda a: [*boss, {"type": "pattern", "id": "pt1", "name": "ring", "seed": {"features": ["e2"]},
                                               "layout": {"circular": {"axis": "Z", "count": 3, "angle": a}}}]),
        ("chamfer", "c1", lambda a: [*plate(), {"type": "chamfer", "id": "c1", "name": "c", "d": 1, "edges": top,
                                                "angle": a, "side": top_face}]),
        ("draft", "d1", lambda a: [*plate(), {"type": "draft", "id": "d1", "name": "taper", "neutral": "XY", "angle": a,
                                              "faces": {"kind": "face", "q": {"op": "sides", "feature": "e1"}}}]),
        ("tip", "h1", lambda a: [*plate(), {"type": "hole", "id": "h1", "name": "h", "on": cap("e1"), "at": one, "d": 3,
                                            "depth": {"blind": 4}, "tip": a}]),
        ("csink", "h1", lambda a: [*plate(), {"type": "hole", "id": "h1", "name": "h", "on": cap("e1"), "at": one, "d": 3,
                                              "depth": "through", "csink": {"d": 6, "angle": a}}]),
    ]


@pytest.mark.parametrize("name, fid, build", _angle_docs(), ids=[n for n, _, _ in _angle_docs()])
@pytest.mark.parametrize("bad", [0, -5, 400])
def test_literal_and_expression_angle_range_checks_share_their_code(name, fid, build, bad):
    """§0.5 rule 2: a range check on an expression-valued field uses the code of the literal check
    (raised at evaluation). The review found the chamfer and draft checks raising `INVALID_ANGLE`
    at evaluation where their literal checks (the oracle's validator, forge-ir's, the conformance
    fixtures) say `INVALID_VALUE`."""
    from test_v1_support import P, code, doc, feat

    lit = run(doc(*build(bad)))
    assert lit["status"] == "error" and lit["features"] == [], lit.get("error")
    lit_codes = {(e["code"], e["path"].rsplit("/", 1)[-1]) for e in lit["error"]["details"]["errors"]}
    (lit_code, _), = [x for x in lit_codes if x[1] == "angle" or x[1] == "tip"]
    rep = run(doc(*build("a"), params=[P("a", "deg", bad)]))
    f = feat(rep, fid)
    assert code(f) == lit_code, (name, code(f), lit_code)
    assert f["error"]["details"]["value"] == bad
    want = {"revolve": "INVALID_ANGLE", "circular": "INVALID_ANGLE"}.get(name, "INVALID_VALUE")
    assert lit_code == want


@pytest.mark.parametrize("case", CASES, ids=[c.name for c in CASES])
def test_error_corpus_probes_replay(case):
    """W7b review 4: every case's own reference probes replay unambiguously (§8.1), so that `oracle
    diff` against Forge checks the case's code instead of classifying it ROBUSTNESS
    (`err1_004_join_along_an_edge_with_overlap_elsewhere` matched 2 bodies before) — except the
    cases `REPLAY_AMBIGUOUS` lists (none), which the manifest names."""
    from aicad_oracle.v1.errcorpus import REPLAY_AMBIGUOUS
    from aicad_oracle.v1.generator import ambiguous_probes
    from aicad_oracle.v1.jsonio import dumps_canonical

    text = dumps_canonical(case.doc)
    rep = run(case.doc)
    amb = ambiguous_probes(text, case.name, rep)
    assert bool(amb) == (case.name in REPLAY_AMBIGUOUS), amb
