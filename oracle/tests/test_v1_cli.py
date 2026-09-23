"""The `oracle` CLI on IR v1: `eval` (v1 input, `--report-version v1` for v0 input, `--replay`),
`diff` (golden mode and `--a/--b` on `aicad.metrics/1` reports) and `golden`."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from aicad_oracle.cli import main

REPO = Path(__file__).resolve().parents[2]
V1 = REPO / "corpus" / "v1" / "programs"


def _cli(*args) -> int:
    return main([str(a) for a in args])


def test_eval_v1_program(tmp_path, capsys):
    out = tmp_path / "r.json"
    assert _cli("eval", V1 / "params_plate.json", "--out", out) == 0
    rep = json.loads(out.read_text())
    assert rep["schema"] == "aicad.metrics/1" and rep["status"] == "ok"


def test_eval_feature_failure_and_rejection_exit_codes(tmp_path, capsys):
    assert _cli("eval", V1 / "shell_box.json", "--out", tmp_path / "a.json") == 1
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"schema": "aicad.ir/1", "parts": [{"id": "p1", "name": "part", "features": [
        {"type": "extrude", "id": "e1", "name": "e", "sketch": "nope", "distance": 1}]}]}))
    assert _cli("eval", bad, "--out", tmp_path / "b.json") == 2
    assert "UNRESOLVED_SKETCH" in capsys.readouterr().err


def test_v0_input_keeps_the_v0_report_unless_v1_is_asked(tmp_path):
    prog = REPO / "corpus" / "programs" / "extrude_box.json"
    assert _cli("eval", prog, "--out", tmp_path / "v0.json") == 0
    assert json.loads((tmp_path / "v0.json").read_text())["schema"] == "aicad.metrics/0"
    assert _cli("eval", prog, "--report-version", "v1", "--out", tmp_path / "v1.json") == 0
    r1 = json.loads((tmp_path / "v1.json").read_text())
    assert r1["schema"] == "aicad.metrics/1"
    r0 = json.loads((tmp_path / "v0.json").read_text())
    assert r1["features"][1]["bodies"][0]["volume"] == r0["features"][1]["bodies"][0]["volume"]


def test_eval_with_replay(tmp_path):
    ref = tmp_path / "ref.json"
    assert _cli("eval", V1 / "constrained_plate.json", "--out", ref) == 0
    assert _cli("eval", V1 / "constrained_plate.json", "--replay", ref, "--out", tmp_path / "o.json") == 0
    rep = json.loads(ref.read_text())
    rep["features"][0]["sketch"]["solved"][1]["end"][0] += 1e-6
    ref.write_text(json.dumps(rep))
    assert _cli("eval", V1 / "constrained_plate.json", "--replay", ref, "--out", tmp_path / "o2.json") == 1
    o2 = json.loads((tmp_path / "o2.json").read_text())
    assert o2["features"][0]["error"]["code"] == "ORACLE_REPLAY_CHECK_FAILED"


def test_golden_and_diff_on_v1_programs(tmp_path, capsys):
    progs = tmp_path / "programs"
    progs.mkdir()
    for n in ("params_plate.json", "constrained_plate.json"):
        shutil.copy(V1 / n, progs)
    assert _cli("golden", progs) == 0
    golden = tmp_path / "golden"
    assert sorted(p.name for p in golden.glob("*.json")) == ["constrained_plate.metrics.json", "params_plate.metrics.json"]
    capsys.readouterr()
    assert _cli("diff", progs, "--golden-dir", golden, "--fail-on-robustness", "--fail-on-no-reference") == 0
    out = capsys.readouterr().out
    assert "MATCH=2" in out
    g = json.loads((golden / "params_plate.metrics.json").read_text())
    g["features"][1]["bodies"][0]["volume"] *= 1.001
    (golden / "params_plate.metrics.json").write_text(json.dumps(g))
    assert _cli("diff", progs, "--golden-dir", golden) == 1
    assert "POTENTIAL_SILENT_WRONG=1" in capsys.readouterr().out


def test_diff_a_b_on_v1_reports(tmp_path, capsys):
    a = tmp_path / "a.json"
    assert _cli("eval", V1 / "params_plate.json", "--out", a) == 0
    b = tmp_path / "b.json"
    rep = json.loads(a.read_text())
    rep["features"][1]["warnings"].append({"code": "ORACLE_REF_MISMATCH", "severity": "warning", "message": "x",
                                           "details": {}})
    b.write_text(json.dumps(rep))
    capsys.readouterr()
    assert _cli("diff", "--a", a, "--b", a) == 0
    assert capsys.readouterr().out.startswith("MATCH")
    # SPEC-v1 §8.1/§8.4: REF_MISMATCH exists only in independent-refs mode; by default a set
    # difference is ROBUSTNESS (never MATCH), which does not fail the gate on its own
    assert _cli("diff", "--a", a, "--b", b) == 0
    assert capsys.readouterr().out.startswith("ROBUSTNESS")
    assert _cli("diff", "--a", a, "--b", b, "--fail-on-robustness") == 1
    capsys.readouterr()
    assert _cli("diff", "--a", a, "--b", b, "--independent-refs") == 1
    assert "REF_MISMATCH" in capsys.readouterr().out


def test_eval_replay_in_both_reference_modes(tmp_path, capsys):
    a = tmp_path / "a.json"
    assert _cli("eval", V1 / "params_plate.json", "--out", a) == 0
    for extra in ([], ["--independent-refs"]):
        b = tmp_path / f"b{len(extra)}.json"
        assert _cli("eval", V1 / "params_plate.json", "--replay", a, "--out", b, *extra) == 0
        capsys.readouterr()
        assert _cli("diff", "--a", a, "--b", b, *extra) == 0
        assert capsys.readouterr().out.startswith("MATCH")


def test_independent_refs_help_states_the_default_mode_classification(capsys):
    """The default (PR gate) mode classifies a set difference from the oracle's own resolution as
    ORACLE_REF_DIFFERS → ROBUSTNESS; the help of both commands says so."""
    for cmd in ("eval", "diff"):
        with pytest.raises(SystemExit):
            _cli(cmd, "--help")
        out = " ".join(capsys.readouterr().out.split())
        assert "ORACLE_REF_DIFFERS" in out and "ROBUSTNESS" in out and "only note" not in out
