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


def _golden_pair(tmp_path, text: str, name: str = "cyl"):
    step = tmp_path / f"{name}.step"
    step.write_text(text)
    exact_v = math.pi * 100 * 30
    exact_a = 2 * math.pi * 100 + 2 * math.pi * 10 * 30
    summary = tmp_path / f"{name}.summary.json"
    summary.write_text(json.dumps(_summary(exact_v, exact_a, [-10, -10, 0], [10, 10, 30], 3, 2, CYL_STEP)))
    return step, summary


def _flip_face(text: str, face: str) -> str:
    """Toggle one ADVANCED_FACE's same_sense (its loops stay as they are)."""
    line = next(l for l in text.splitlines() if f"ADVANCED_FACE('{face}'" in l)
    flipped = line.replace(",.T.);", ",.F.);") if line.endswith(",.T.);") else line.replace(",.F.);", ",.T.);")
    assert flipped != line
    return text.replace(line, flipped)


@pytest.mark.parametrize("face", ["cyl/side:c", "cyl/cap:end", "cyl/cap:start"])
def test_a_face_whose_same_sense_is_flipped_is_caught_although_healing_repairs_it(tmp_path, face):
    """OCCT's healing turns such a face back round (volume, area and BRepCheck then pass), so
    only the orientation comparison sees it."""
    step, summary = _golden_pair(tmp_path, _flip_face(GOLDEN.read_text(), face))
    r = step_check.check_pair(step, summary, 1e-9)
    assert r.status == "mismatch"
    body = r.bodies[0]
    assert body.occt["valid"] and abs(body.occt["volume"] - math.pi * 100 * 30) < 1e-6, "healing hid it"
    problems = " ".join(body.problems)
    assert "turned 1 of 3 faces round" in problems, problems
    assert any(step_check.is_orientation_repair(m) for m in r.healing), r.healing


def test_a_whole_inside_out_shell_is_caught_although_healing_is_silent(tmp_path):
    """Every face's same_sense and every bound's orientation flipped: a consistent, inside-out
    shell. OCCT turns it round without a warning; the per-face comparison still sees it."""
    text = GOLDEN.read_text()
    swap = {".T.);": ".F.);", ".F.);": ".T.);"}
    lines = []
    for line in text.splitlines():
        if any(f"={e}(" in line for e in ("ADVANCED_FACE", "FACE_OUTER_BOUND", "FACE_BOUND")):
            line = line[:-5] + swap[line[-5:]]
        lines.append(line)
    step, summary = _golden_pair(tmp_path, "\n".join(lines) + "\n")
    r = step_check.check_pair(step, summary, 1e-9)
    assert r.status == "mismatch"
    assert not any(step_check.is_orientation_repair(m) for m in r.healing), "no warning to rely on"
    assert "turned 3 of 3 faces round" in " ".join(r.bodies[0].problems)


def test_file_face_orientations_compose_same_sense_with_void_shells():
    text = """ISO-10303-21;
HEADER;
ENDSEC;
DATA;
#1=ADVANCED_FACE('a;#9',(#90),#91,.T.);
#2=ADVANCED_FACE('b',(#90),#91,.F.);
#3=ADVANCED_FACE('c',(#90),#91,.T.);
#4=CLOSED_SHELL('',(#1,#2));
#5=CLOSED_SHELL('',(#3));
#6=ORIENTED_CLOSED_SHELL('',*,#5,.F.);
#7=BREP_WITH_VOIDS('it''s #4',#4,(#6));
#8=MANIFOLD_SOLID_BREP('lump',#5);
ENDSEC;
END-ISO-10303-21;
"""
    assert step_check.file_face_orientations(text) == [[False, True, True], [False]]


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
