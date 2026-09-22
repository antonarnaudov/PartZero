"""SPEC §6 comparison rules and mismatch classification."""

import copy
import json
import sys
from pathlib import Path

import pytest

from aicad_oracle.compare import MATCH, ROBUSTNESS, SILENT_WRONG, compare_reports

BODY = {
    "volume": 1000.0, "area": 600.0, "centroid": [5.0, 5.0, 5.0],
    "bbox_min": [0.0, 0.0, 0.0], "bbox_max": [10.0, 10.0, 10.0],
    "faces": 6, "edges": 12, "face_types": {"plane": 6}, "edge_types": {"line": 12}, "valid": True,
}
REPORT = {
    "schema": "aicad.metrics/0", "engine": "x", "document": "d", "status": "ok",
    "features": [
        {"part": "p1", "feature": "s1", "type": "sketch", "status": "ok",
         "regions": [{"area": 100.0, "loops": 1, "outer_curves": ["a", "b", "c", "d"]}]},
        {"part": "p1", "feature": "e1", "type": "extrude", "status": "ok", "bodies": [BODY]},
    ],
}


def mutated(f):
    r = copy.deepcopy(REPORT)
    f(r)
    return r


def body(r):
    return r["features"][1]["bodies"][0]


def cls(b):
    return compare_reports(REPORT, b, "forge", "oracle").classification


def test_identical_reports_match_regardless_of_engine_and_document():
    assert cls(mutated(lambda r: r.update(engine="forge 0.0.1", document="other"))) == MATCH


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: body(r).update(volume=1000.0 * (1 + 0.9e-6)),
        lambda r: body(r).update(area=600.0 * (1 - 0.9e-6)),
        lambda r: body(r)["centroid"].__setitem__(0, 5.0 + 0.9e-6 * 17.32),  # s = diag ≈ 17.32
        lambda r: body(r)["bbox_max"].__setitem__(2, 10.0 + 1.5e-5),
        lambda r: r["features"][0]["regions"][0].update(area=100.0 * (1 + 0.9e-6)),
        lambda r: body(r).update(face_types={"plane": 6, "cone": 0}),  # zero counts ignored
    ],
)
def test_within_tolerance_matches(mutate):
    assert cls(mutated(mutate)) == MATCH


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: body(r).update(volume=1000.0 * (1 + 2e-6)),
        lambda r: body(r).update(area=600.0 * (1 + 2e-6)),
        lambda r: body(r)["centroid"].__setitem__(1, 5.0 + 1e-4),
        lambda r: body(r)["bbox_min"].__setitem__(0, -1e-4),
        lambda r: body(r).update(faces=7),
        lambda r: body(r).update(edges=13),
        lambda r: body(r).update(face_types={"plane": 5, "cylinder": 1}),
        lambda r: body(r).update(edge_types={"line": 11, "circle": 1}),
        lambda r: body(r).update(valid=False),
        lambda r: r["features"][1]["bodies"].append(copy.deepcopy(BODY)),
        lambda r: r["features"][0]["regions"][0].update(loops=2),
        lambda r: r["features"][0]["regions"][0].update(outer_curves=["a", "b", "c"]),
        lambda r: r["features"][0]["regions"][0].update(area=101.0),
        lambda r: r["features"][0]["regions"].append({"area": 1.0, "loops": 1, "outer_curves": ["z"]}),
        lambda r: r["features"].pop(),
    ],
)
def test_metric_difference_with_both_ok_is_potential_silent_wrong(mutate):
    assert cls(mutated(mutate)) == SILENT_WRONG


def err(code):
    return lambda r: (
        r.update(status="error"),
        r["features"][1].update(status="error", error={"code": code, "message": "m"}),
        r["features"][1].pop("bodies"),
    )


def test_one_engine_erroring_is_robustness():
    assert cls(mutated(err("OCCT_BUILD_FAILED"))) == ROBUSTNESS


def test_both_erroring_same_code_matches_even_if_messages_differ():
    a = mutated(err("SKETCH_OPEN_LOOP"))
    b = mutated(err("SKETCH_OPEN_LOOP"))
    b["features"][1]["error"]["message"] = "something else"
    assert compare_reports(a, b).classification == MATCH


def test_both_erroring_with_different_codes_is_robustness():
    a = mutated(err("SKETCH_OPEN_LOOP"))
    b = mutated(err("SKETCH_BRANCHING"))
    assert compare_reports(a, b).classification == ROBUSTNESS


def test_document_level_error_is_robustness():
    b = {"schema": "aicad.metrics/0", "engine": "x", "document": "d", "status": "error",
         "error": {"code": "IR_SCHEMA_INVALID", "message": "m"}, "features": []}
    assert cls(b) == ROBUSTNESS


def test_silent_wrong_dominates_robustness():
    def both(r):
        body(r).update(volume=2000.0)
        r["features"].append({"part": "p1", "feature": "e2", "type": "extrude", "status": "error",
                              "error": {"code": "X", "message": "m"}})
    a = copy.deepcopy(REPORT)
    a["features"].append({"part": "p1", "feature": "e2", "type": "extrude", "status": "ok", "bodies": [BODY]})
    assert compare_reports(a, mutated(both)).classification == SILENT_WRONG


def test_volume_absolute_floor_scales_with_bbox():
    tiny = copy.deepcopy(REPORT)
    b = body(tiny)
    b.update(volume=1e-12, bbox_min=[0, 0, 0], bbox_max=[1e-3, 1e-3, 1e-3])
    other = copy.deepcopy(tiny)
    body(other)["volume"] = 5e-10  # |Δ| < 1e-9·s³ with s = max(1, diag) = 1
    assert compare_reports(tiny, other).classification == MATCH


# --- CLI: `oracle diff` ------------------------------------------------------------------------

REPO = Path(__file__).resolve().parents[2]


def _cli(*args):
    from aicad_oracle.cli import main

    return main([str(a) for a in args])


def test_cli_report_pair(tmp_path, capsys):
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    a.write_text(json.dumps(REPORT))
    b.write_text(json.dumps(mutated(lambda r: body(r).update(volume=1234.0))))
    assert _cli("diff", "--a", a, "--b", a) == 0
    assert _cli("diff", "--a", a, "--b", b, "--report", tmp_path / "r.md") == 1
    assert "POTENTIAL_SILENT_WRONG" in (tmp_path / "r.md").read_text()


def test_cli_missing_forge_falls_back_to_golden(capsys):
    rc = _cli("diff", REPO / "corpus" / "programs", "--forge-bin", "/nonexistent/aicad")
    out = capsys.readouterr().out
    assert rc == 0 and "MATCH=8" in out


def _fake_forge(tmp_path, body_py):
    script = tmp_path / "fake_forge.py"
    script.write_text(
        "import json, sys\n"
        "sys.path.insert(0, %r)\n"
        "from aicad_oracle.evaluate import evaluate_file\n"
        "rep = evaluate_file(sys.argv[2])\n"
        "%s\n"
        "print(json.dumps(rep))\n" % (str(REPO / "oracle" / "src"), body_py)
    )
    exe = tmp_path / "forge"
    exe.write_text(f"#!/bin/sh\nexec {sys.executable} {script} \"$@\"\n")
    exe.chmod(0o755)
    return exe


def test_cli_with_forge_binary_classifies(tmp_path, capsys):
    prog = REPO / "corpus" / "programs" / "extrude_box.json"
    same = _fake_forge(tmp_path, "rep['engine'] = 'forge 0.0.1'")
    assert _cli("diff", prog, "--forge-bin", same) == 0
    assert "MATCH=1" in capsys.readouterr().out

    (tmp_path / "w").mkdir()
    wrong = _fake_forge(tmp_path / "w", "rep['features'][1]['bodies'][0]['volume'] *= 1.001")
    assert _cli("diff", prog, "--forge-bin", wrong) == 1
    assert "POTENTIAL_SILENT_WRONG=1" in capsys.readouterr().out

    (tmp_path / "c").mkdir()
    crash = _fake_forge(tmp_path / "c", "sys.exit(101)")
    assert _cli("diff", prog, "--forge-bin", crash) == 0
    assert "ROBUSTNESS=1" in capsys.readouterr().out
    assert _cli("diff", prog, "--forge-bin", crash, "--fail-on-robustness") == 1
