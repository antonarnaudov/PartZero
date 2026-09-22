"""Hand-checked analytic values for the corpus programs, and golden-report regression."""

import json
import math
from pathlib import Path

import pytest

from aicad_oracle.compare import MATCH, compare_reports
from aicad_oracle.evaluate import check_report, evaluate_file

REPO = Path(__file__).resolve().parents[2]
PROGRAMS = REPO / "corpus" / "programs"
GOLDEN = REPO / "corpus" / "golden"

REL = 1e-9


def bodies(name):
    checks = []
    rep = evaluate_file(PROGRAMS / f"{name}.json", checks)
    assert rep["status"] == "ok", rep
    assert check_report(rep) == []
    assert checks == [], checks
    return [b for f in rep["features"] for b in f.get("bodies", [])]


def close(a, b, rel=REL):
    return abs(a - b) <= rel * abs(b)


def test_box():
    (b,) = bodies("extrude_box")
    assert close(b["volume"], 80 * 50 * 8)
    assert close(b["area"], 2 * (80 * 50 + 80 * 8 + 50 * 8))
    assert b["bbox_min"] == [-40.0, -25.0, 0.0] and b["bbox_max"] == [40.0, 25.0, 8.0]
    assert (b["faces"], b["edges"], b["face_types"], b["edge_types"]) == (6, 12, {"plane": 6}, {"line": 12})
    assert b["valid"] is True


def test_plate_with_holes():
    (b,) = bodies("extrude_plate_with_holes")
    assert close(b["volume"], 100 * 60 * 5 - 4 * math.pi * 2.75**2 * 5)
    assert close(b["area"], 2 * (6000 - 4 * math.pi * 2.75**2) + 5 * (320 + 4 * 2 * math.pi * 2.75))
    assert (b["faces"], b["edges"]) == (10, 20)
    assert b["face_types"] == {"cylinder": 4, "plane": 6} and b["edge_types"] == {"circle": 8, "line": 12}


def test_solid_cylinder():
    (b,) = bodies("revolve_solid_cylinder")
    assert close(b["volume"], math.pi * 100 * 30)
    assert close(b["area"], 2 * math.pi * 100 + 2 * math.pi * 10 * 30)
    assert close(b["centroid"][2], 15.0)
    assert (b["faces"], b["edges"], b["face_types"], b["edge_types"]) == (3, 2, {"cylinder": 1, "plane": 2}, {"circle": 2})


def test_torus():
    (b,) = bodies("revolve_torus")
    R, r = 15, 4
    assert close(b["volume"], 2 * math.pi**2 * R * r**2)
    assert close(b["area"], 4 * math.pi**2 * R * r)
    assert b["bbox_min"] == [-19.0, -19.0, -4.0] and b["bbox_max"] == [19.0, 19.0, 4.0]


def test_quarter_ring():
    (b,) = bodies("revolve_partial_ring")
    assert close(b["volume"], (math.pi / 4) * (32**2 - 20**2) * 6)
    # sweep 90° about +Z from +X: the ring occupies the first quadrant
    assert b["bbox_min"][1] == 0.0 and b["bbox_max"][:2] == [32.0, 32.0]
    assert (b["faces"], b["edges"]) == (6, 12)


def test_cone_and_sphere():
    (b,) = bodies("revolve_cone_sphere")
    assert close(b["volume"], math.pi * 100 * 20 / 3 + 2 / 3 * math.pi * 1000)
    assert close(b["area"], math.pi * 10 * math.hypot(10, 20) + 2 * math.pi * 100)
    assert (b["faces"], b["edges"], b["face_types"]) == (2, 1, {"cone": 1, "sphere": 1})


def test_slot_symmetric_on_xz():
    (b,) = bodies("extrude_slot_symmetric_xz")
    assert close(b["volume"], (40 * 12 + math.pi * 36) * 10)
    # XZ normal is −Y; symmetric → y ∈ [−5, 5]
    assert b["bbox_min"] == [-26.0, -5.0, -6.0] and b["bbox_max"] == [26.0, 5.0, 6.0]


def test_two_regions_reverse():
    disc, ring = bodies("extrude_two_regions")  # canonical order: ["disc"] < ["ring_outer"]
    assert close(disc["volume"], math.pi * 64 * 3) and close(ring["volume"], math.pi * (400 - 144) * 3)
    assert disc["bbox_max"][2] == 0.0 and disc["bbox_min"][2] == -3.0


@pytest.mark.parametrize("program", sorted(p.stem for p in PROGRAMS.glob("*.json")))
def test_golden_reports_match_current_oracle(program):
    golden = GOLDEN / f"{program}.metrics.json"
    assert golden.is_file(), f"run `uv run oracle golden ../corpus/programs` to create {golden}"
    rep = evaluate_file(PROGRAMS / f"{program}.json")
    cmp = compare_reports(json.loads(golden.read_text()), rep, "golden", "oracle")
    assert cmp.classification == MATCH, [str(d) for d in cmp.differences]
