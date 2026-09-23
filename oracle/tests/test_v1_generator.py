"""`oracle gen --ir v1`: every generated program is valid IR v1 (the full rejection pipeline accepts
it), is written in canonical form (canonical JSON, canonical expression text), evaluates `ok` on
the oracle with every body gated, and generation is deterministic per (seed, index)."""

from __future__ import annotations

import json
import random

import pytest

from aicad_oracle.v1 import expr
from aicad_oracle.v1.compare import MATCH, compare_reports
from aicad_oracle.v1.evaluate import check_report, evaluate_text
from aicad_oracle.v1.generator import gen_one, generate_program_v1
from aicad_oracle.v1.jsonio import dumps_canonical
from aicad_oracle.v1.load import load_text
from aicad_oracle.v1.validate import sites

N = 30


@pytest.fixture(scope="module")
def programs():
    return [gen_one((7, i, 20)) for i in range(N)]


def test_every_program_is_produced(programs):
    assert all(p["text"] is not None for p in programs)


def test_generated_programs_are_valid_canonical_and_evaluate_ok(programs):
    for p in programs:
        loaded = load_text(p["text"])
        assert dumps_canonical(loaded.doc) + "\n" == p["text"], p["name"]
        for s in sites(loaded.doc):
            if s.is_expr:
                assert expr.canonicalize(s.text) == s.text, (p["name"], s.path)
        rep = evaluate_text(p["text"], p["name"])
        assert check_report(rep) == []
        assert rep["status"] == "ok", (p["name"], [f.get("error") for f in rep["features"] if f.get("error")])


def test_generation_is_deterministic():
    a = dumps_canonical(generate_program_v1(random.Random("aicad-gen-v1/3/5/0"), "x"))
    b = dumps_canonical(generate_program_v1(random.Random("aicad-gen-v1/3/5/0"), "x"))
    assert a == b
    assert gen_one((3, 5, 5))["text"] == gen_one((3, 5, 5))["text"]


def test_the_corpus_covers_the_v1_surface(programs):
    kinds, types, ops, planes, units, bool_ops = set(), set(), set(), set(), set(), set()
    n_expr = n_constrained = 0
    for p in programs:
        d = json.loads(p["text"])
        for prm in d.get("params", []) + [x for part in d["parts"] for x in part.get("params", [])]:
            units.add(prm["unit"])
        for f in d["parts"][0]["features"]:
            types.add(f["type"])
            if f["type"] == "boolean":
                bool_ops.add(f["op"])
            if f["type"] == "sketch" and f.get("constraints"):
                n_constrained += 1
            if f["type"] == "sketch":
                kinds |= {c["kind"] for c in f["curves"]}
                pl = f["plane"]
                planes.add(pl if isinstance(pl, str) else next(iter(k for k in ("face", "datum") if k in pl), "frame"))
            ops.add(f.get("op", "new_body") if f["type"] in ("extrude", "revolve") else None)
        n_expr += sum(1 for s in sites(d) if s.is_expr)
    assert {"rect", "slot", "polygon", "circle", "line"} <= kinds
    assert {"sketch", "extrude", "revolve", "datum_plane", "datum_axis", "boolean", "tag"} <= types
    assert {"new_body", "join", "cut", "intersect"} <= ops
    assert len(bool_ops) >= 2  # every op is covered by test_every_new_group_evaluates_ok
    assert n_constrained >= 2
    assert {"face", "datum", "frame", "XY"} <= planes
    assert {"mm", "count", "deg", "ratio"} <= units
    assert n_expr > 5 * N


def test_cli_gen_v1(tmp_path, capsys):
    from aicad_oracle.cli import main

    out = tmp_path / "gen"
    assert main(["gen", "--ir", "v1", "--count", "4", "--seed", "2", "--jobs", "1", "--out", str(out),
                 "--with-reports"]) == 0
    progs = sorted(out.glob("gen1_s2_*.json"))
    progs = [p for p in progs if not p.name.endswith((".metrics.json", ".stats.json"))]
    assert len(progs) == 4
    for p in progs:
        load_text(p.read_text())
        rep = json.loads(p.with_name(p.stem + ".metrics.json").read_text())
        assert rep["schema"] == "aicad.metrics/1" and rep["status"] == "ok"
    stats = json.loads((out / "gen1_s2.stats.json").read_text())
    assert stats["generated"] == 4 and stats["ir"] == "v1"


def test_generated_programs_replay_their_own_reports_as_match(programs):
    """The replay path end to end on the generated corpus: each program evaluated with its own
    report as the reference (constrained sketches replayed and checked, reference probes matched
    and predicates re-checked) classifies MATCH."""
    for p in programs:
        ref = evaluate_text(p["text"], p["name"])
        again = evaluate_text(p["text"], p["name"], replay=ref)
        assert check_report(again) == []
        cmp = compare_reports(ref, again)
        assert cmp.classification == MATCH, (p["name"], [str(d) for d in cmp.differences][:5])


@pytest.mark.parametrize("group, kw", [
    ("extrude_intersect", {}), ("boolean_pair", {"op": "join"}), ("boolean_pair", {"op": "cut"}),
    ("boolean_pair", {"op": "intersect"}), ("tagged_boss", {}), ("axis_tilt", {"mode": "points"}),
    ("axis_tilt", {"mode": "planes"}), ("axis_tilt", {"mode": "edge"}), ("constrained_rect", {}),
])
def test_every_new_group_evaluates_ok(group, kw):
    from aicad_oracle.v1.generator import Builder

    for i in range(6):
        b = Builder(random.Random(f"aicad-gen-v1-test/{group}/{kw}/{i}"))
        getattr(b, group)(**kw)
        part = {"id": "p1", "name": "part_1", "features": b.features}
        if b.part_params:
            part["params"] = b.part_params
        d = {"schema": "aicad.ir/1", "meta": {"name": "g"}, **({"params": b.doc_params} if b.doc_params else {}),
             "parts": [part]}
        text = dumps_canonical(d) + "\n"
        load_text(text)
        rep = evaluate_text(text, "g")
        assert check_report(rep) == []
        assert rep["status"] == "ok", (group, kw, i, [f.get("error") for f in rep["features"] if f.get("error")])
