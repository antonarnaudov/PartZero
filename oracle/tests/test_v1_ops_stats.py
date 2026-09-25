"""W7b (second review): the statistics `oracle gen --ir v1` and `oracle diff` report — the §8.3 rule
1.3 edge merges (the (b) residue at nearly tangent vertices the SPEC asks W7b to measure) — and the
classic generator's filter for programs whose own reference probes do not replay (§8.1 [W0-35]:
coplanar overlapping caps of separate bodies; the key tie-break of W7b's CONTRACT ISSUES 2), whose
count `oracle diff` reports next to the class counts."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from test_v1_support import body_of, doc, ex, rect, sk

from aicad_oracle.cli import main
from aicad_oracle.v1.generator import ambiguous_probes, gen_one
from aicad_oracle.v1.jsonio import dumps_canonical

REPO = Path(__file__).resolve().parents[2]
MERGE_KEYS = {"a", "b", "b_near_tangent"}


def test_gen_stats_carry_the_rule_1_3_merges_and_the_rejected_attempts(tmp_path, capsys):
    out = tmp_path / "gen"
    assert main(["gen", "--ir", "v1", "--family", "patterns", "--count", "2", "--seed", "3", "--jobs", "1",
                 "--invalid-per-kind", "0", "--out", str(out)]) == 0
    (stats_file,) = out.glob("*.stats.json")
    stats = json.loads(stats_file.read_text())
    assert set(stats["normalize_merges"]) == MERGE_KEYS
    assert stats["normalize_merges"]["a"] >= 1  # gen1p_s3_00001 merges a pair of same-carrier edges
    assert stats["rejected"] == []  # only the classic family filters
    assert "rule 1.3 edge merges" in capsys.readouterr().out


def test_diff_stats_carry_the_rule_1_3_merges(tmp_path, capsys):
    progs = tmp_path / "programs"
    progs.mkdir()
    shutil.copy(REPO / "corpus/v1/programs/shell_box.json", progs)
    assert main(["golden", str(progs)]) == 0
    stats = tmp_path / "diff.stats.json"
    assert main(["diff", str(progs), "--golden-dir", str(tmp_path / "golden"), "--stats", str(stats)]) == 0
    got = json.loads(stats.read_text())
    assert got["programs"] == 1 and got["classes"].get("MATCH") == 1
    assert set(got["normalize_merges"]) == MERGE_KEYS
    assert "rule 1.3 edge merges" in capsys.readouterr().out


def _two_plates_on_one_plane() -> dict:
    """Two plates extruded in reverse from XY (their start caps coplanar and overlapping at z = 0)
    and a sketch on the first one's start cap: its face probe lies on both caps, with agreeing
    outward normals."""
    return doc(sk("s1", [rect("a", 40, 30)]), ex("e1", "s1", 5, direction="reverse"),
               sk("s2", [rect("b", 20, 20)]), ex("e2", "s2", 3, direction="reverse"),
               sk("s3", [{"kind": "circle", "id": "c", "center": [0, 0], "radius": 2}],
                  plane={"face": {"kind": "face", "q": {"op": "cap", "feature": "e1", "end": "start"}}}),
               ex("e3", "s3", 2, op="join", targets=body_of("e1")))


def test_a_cap_probe_on_two_coplanar_faces_is_ambiguous():
    from aicad_oracle.v1.evaluate import evaluate_text

    text = dumps_canonical(_two_plates_on_one_plane())
    rep = evaluate_text(text, "t")
    assert rep["status"] == "ok"
    amb = ambiguous_probes(text, "t", rep)
    assert [a["feature"] for a in amb] == ["s3"] and "2 faces" in amb[0]["reason"]


def test_the_classic_generator_skips_programs_whose_probes_do_not_replay():
    """gen1_s5_01098 (W7b's first ledger, ROBUSTNESS against Forge: its sketch-on-face probe lay on
    two coplanar start caps): its first attempt is rejected and the next one is kept."""
    r = gen_one((5, 1098, 20, "classic"))
    assert r["text"] is not None
    assert [x["kind"] for x in r["rejected"]] == ["ambiguous_probe"] and r["rejected"][0]["attempt"] == 0
    assert ambiguous_probes(r["text"], r["name"], r["report"]) == []
    assert set(r["merges"]) == MERGE_KEYS


def test_diff_reports_the_generator_rejections_next_to_the_class_counts(tmp_path, capsys):
    """W7b review 3: the attempts the classic generator discarded (ambiguous probes) are not diffed,
    so the gate summary lists their count beside the classes (stdout, the markdown report and the
    `--stats` JSON), and the MATCH rate cannot hide them."""
    progs = tmp_path / "programs"
    progs.mkdir()
    shutil.copy(REPO / "corpus/v1/programs/shell_box.json", progs)
    (progs / "gen1_s5.stats.json").write_text(json.dumps({"ir": "v1", "generated": 3, "rejected": [
        {"program": "gen1_s5_01098", "attempt": 0, "kind": "ambiguous_probe", "features": [{"feature": "s3"}]}]}))
    assert main(["golden", str(progs)]) == 0
    stats, report = tmp_path / "diff.stats.json", tmp_path / "diff.md"
    assert main(["diff", str(progs), "--golden-dir", str(tmp_path / "golden"), "--stats", str(stats),
                 "--report", str(report)]) == 0
    out = capsys.readouterr().out
    counts_line = next(ln for ln in out.splitlines() if ln.startswith("MATCH="))
    assert "generator_rejected=1" in counts_line and "ambiguous_probe 1" in counts_line
    # W7b review 4: the rate next to the class counts (1 rejected of 3 kept + 1 rejected draws)
    assert "(25.0% of 4 kept or rejected draws" in counts_line
    got = json.loads(stats.read_text())
    assert got["programs"] == 1 and got["generator_rejected"] == {
        "count": 1, "by_kind": {"ambiguous_probe": 1}, "programs": ["gen1_s5_01098"], "generated": 3, "rate": 0.25}
    assert "generator_rejected=1" in report.read_text()


def test_diff_without_generator_stats_reports_no_rejections(tmp_path):
    from aicad_oracle.diffrun import generator_rejections

    assert generator_rejections(tmp_path) is None
    (tmp_path / "gen1_s1.stats.json").write_text(json.dumps({"ir": "v1", "rejected": []}))
    assert generator_rejections(tmp_path) == {"count": 0, "by_kind": {}, "programs": [], "generated": 0, "rate": 0.0}
