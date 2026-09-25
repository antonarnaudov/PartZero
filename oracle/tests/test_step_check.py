"""The STEP export check (step_check.py): OCCT reads Forge's own STEP files."""

from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

import pytest

from aicad_oracle import step_check

REPO = Path(__file__).resolve().parents[2]
GOLDEN = REPO / "forge" / "crates" / "forge-io" / "tests" / "golden" / "cylinder.p21"
AICAD = REPO / "forge" / "target" / "debug" / "aicad"


def _summary(volume: float, area: float, lo, hi, faces: int, edges: int, step: dict) -> dict:
    return {
        "schema": "aicad.export/1",
        "format": "step",
        "error": None,
        "bodies": [{
            "name": "cylinder",
            "forge": {"volume": volume, "area": area, "bboxMin": lo, "bboxMax": hi,
                      "faces": faces, "edges": edges, "shells": 1, "vertices": 0},
            "step": step,
        }],
    }


CYL_STEP = {"solids": 1, "voids": 0, "faces": 3, "edges": 3, "vertices": 2, "seamEdges": 1,
            "splitPieces": 0, "newVertices": 2}


def test_occt_reads_the_golden_cylinder_exactly(tmp_path):
    """The writer's golden cylinder (r 10, h 30): valid, exact volume and area, one seam."""
    step = tmp_path / "cyl.step"
    shutil.copy(GOLDEN, step)
    exact_v = math.pi * 100 * 30
    exact_a = 2 * math.pi * 100 + 2 * math.pi * 10 * 30
    (tmp_path / "cyl.summary.json").write_text(json.dumps(
        _summary(exact_v, exact_a, [-10, -10, 0], [10, 10, 30], 3, 2, CYL_STEP)))
    r = step_check.check_pair(step, tmp_path / "cyl.summary.json", 1e-9)
    assert r.status == "match", [b.problems for b in r.bodies]
    occt = r.bodies[0].occt
    assert occt["valid"] and occt["closed"]
    assert occt["seams"] == 1 and occt["edges"] == 2 and occt["faces"] == 3


def test_a_wrong_forge_metric_is_reported_not_hidden(tmp_path):
    step = tmp_path / "cyl.step"
    shutil.copy(GOLDEN, step)
    (tmp_path / "cyl.summary.json").write_text(json.dumps(
        _summary(1.0, 2.0, [0, 0, 0], [1, 1, 1], 4, 5, CYL_STEP)))
    r = step_check.check_pair(step, tmp_path / "cyl.summary.json", 1e-6)
    assert r.status == "mismatch"
    problems = " ".join(r.bodies[0].problems)
    for word in ("volume", "area", "box", "faces"):
        assert word in problems


def test_an_export_error_is_its_own_status(tmp_path):
    (tmp_path / "x.summary.json").write_text(json.dumps({
        "schema": "aicad.export/1", "format": "step", "bodies": [],
        "error": {"code": "STEP_UNSUPPORTED_SEAM", "message": "m"},
    }))
    r = step_check.check_pair(tmp_path / "x.step", tmp_path / "x.summary.json", 1e-6)
    assert r.status == "export-error" and "STEP_UNSUPPORTED_SEAM" in r.detail


def test_compare_body_accounts_for_seams_and_split_pieces():
    occt = {"solids": 1, "valid": True, "closed": True, "volume": 1.0, "area": 6.0,
            "bboxMin": [0, 0, 0], "bboxMax": [1, 1, 1], "faces": 6, "edges": 13, "seams": 1,
            "degenerate": 0}
    forge = {"volume": 1.0, "area": 6.0, "bboxMin": [0, 0, 0], "bboxMax": [1, 1, 1], "faces": 6, "edges": 12}
    step = {"solids": 1, "edges": 14, "seamEdges": 1, "splitPieces": 1}
    assert step_check.compare_body("b", occt, forge, step, 1e-6).ok
    step_bad = {"solids": 1, "edges": 14, "seamEdges": 1, "splitPieces": 0}
    assert not step_check.compare_body("b", occt, forge, step_bad, 1e-6).ok


@pytest.mark.skipif(not AICAD.exists(), reason="needs forge/target/debug/aicad (cargo build -p forge-cli)")
def test_the_corpus_programs_export_and_match(tmp_path):
    report = tmp_path / "report.json"
    code = step_check.run(["--programs", str(REPO / "corpus" / "programs"), "--aicad", str(AICAD),
                           "--json", str(report)])
    data = json.loads(report.read_text())
    assert data["bodies"] >= 9
    assert code == 0, [r for r in data["results"] if r["status"] != "match"]
