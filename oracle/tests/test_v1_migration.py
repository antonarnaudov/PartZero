"""Migration equivalence (SPEC-v1 §9.1 "Metric preservation", W0 migration gate, oracle side).

For every v0 document `d`, the oracle's `aicad.metrics/1` report of `migrate(d)` has the same
feature list, statuses, error codes, regions and body metrics as its `aicad.metrics/0` report of
`d`, **bit for bit** (float equality, not tolerance): the corpus programs, the 81 migration
fixtures (MakerBench references included), v0-generator programs and the v0 error corpus.
Documents whose migration rewrote ids are compared through the rename map (the SPEC says the
report uses the new names). Rejected v0 documents keep their codes and paths.

It also checks that replacing literals by parameters and exact expressions (`generator.parametrize`)
changes nothing: the expression evaluator produces the same bits the literals had.
"""

from __future__ import annotations

import json
import random
from pathlib import Path

import pytest

from aicad_oracle.evaluate import evaluate_data as eval_v0
from aicad_oracle.generator import generate_program
from aicad_oracle.invalidgen import generate_invalid
from aicad_oracle.v1.evaluate import evaluate_data as eval_v1_data
from aicad_oracle.v1.evaluate import evaluate_text as eval_v1
from aicad_oracle.v1.generator import Builder, parametrize
from aicad_oracle.v1.jsonio import dumps_canonical, loads_serde
from aicad_oracle.v1.migrate import migrate_v0_to_v1

REPO = Path(__file__).resolve().parents[2]
BODY = ("volume", "area", "centroid", "bbox_min", "bbox_max", "faces", "edges", "face_types", "edge_types", "valid")


def _norm_v0(rep: dict, renames: list[dict]) -> dict:
    """The v0 report with the migration's renames applied (feature names, curve ids)."""
    names = {r["from"]: r["to"] for r in renames if r["kind"] == "feature_name"}
    curves: dict[str, dict[str, str]] = {}
    for r in renames:
        if r["kind"] == "curve_id":
            curves.setdefault(r["path"].rsplit("/curves/", 1)[0], {})[r["from"]] = r["to"]
    all_curves = {k: v for m in curves.values() for k, v in m.items()}
    rep = json.loads(json.dumps(rep))
    for f in rep.get("features", []):
        f["feature"] = names.get(f["feature"], f["feature"])
        for r in f.get("regions", []):
            r["outer_curves"] = sorted(all_curves.get(c, c) for c in r["outer_curves"])
    return rep


def _key(x):
    return json.dumps(x, sort_keys=True)


def assert_equivalent(r0: dict, r1: dict, renames: list[dict]) -> None:
    r0 = _norm_v0(r0, renames)
    assert r1["schema"] == "aicad.metrics/1" and r0["schema"] == "aicad.metrics/0"
    assert r0["status"] == r1["status"]
    if r0.get("error") and not r0["features"]:
        assert r1.get("error") and not r1["features"]
        assert r0["error"]["code"] == r1["error"]["code"]
        return
    assert len(r0["features"]) == len(r1["features"])
    for a, b in zip(r0["features"], r1["features"]):
        assert (a["feature"], a["type"], a["status"]) == (b["feature"], b["type"], b["status"])
        assert (a.get("error") or {}).get("code") == (b.get("error") or {}).get("code"), (a, b)
        ra = sorted((_key(x) for x in a.get("regions", [])))
        rb = sorted((_key(x) for x in b.get("regions", [])))
        assert ra == rb, a["feature"]
        ba = sorted(_key({k: x[k] for k in BODY}) for x in a.get("bodies", []))
        bb = sorted(_key({k: x[k] for k in BODY}) for x in b.get("bodies", []))
        assert ba == bb, a["feature"]  # JSON text of the floats: equal bits
        if not renames:
            assert [x["outer_curves"] for x in a.get("regions", [])] == [x["outer_curves"] for x in b.get("regions", [])]


V0_FILES = sorted((REPO / "corpus" / "programs").glob("*.json")) + \
    sorted((REPO / "corpus" / "v1" / "conformance" / "migration").glob("*/*.v0.json"))


@pytest.mark.parametrize("path", V0_FILES, ids=lambda p: f"{p.parent.name}/{p.stem}")
def test_migrated_program_has_identical_metrics(path: Path):
    text = path.read_text()
    v0 = loads_serde(text)
    _, renames = migrate_v0_to_v1(v0)
    r0 = eval_v0(v0, path.stem)
    r1 = eval_v1(text, path.stem)
    assert_equivalent(r0, r1, renames)
    if renames:
        assert r1["migration"] == {"renames": renames}
    else:
        assert "migration" not in r1


@pytest.mark.parametrize("index", range(24))
def test_generated_v0_programs_migrate_with_identical_metrics(index: int):
    doc = generate_program(random.Random(f"aicad-gen/5/{index}/0"), f"g{index}")
    r0 = eval_v0(json.loads(json.dumps(doc)), "g")
    r1 = eval_v1_data(json.loads(json.dumps(doc)), "g")
    assert_equivalent(r0, r1, [])


def test_v0_error_corpus_keeps_its_outcomes():
    for case in generate_invalid(3, 1):
        doc = json.loads(json.dumps(case.doc))
        r0 = eval_v0(json.loads(json.dumps(doc)), "e")
        r1 = eval_v1_data(doc, "e")
        assert_equivalent(r0, r1, migrate_v0_to_v1(doc)[1] if not r0.get("error") else [])


@pytest.mark.parametrize("index", range(16))
def test_parameters_reproduce_the_literals_bit_for_bit(index: int):
    rng = random.Random(f"aicad-v1-lift/{index}")
    v0 = generate_program(random.Random(f"aicad-gen/11/{index}/0"), "lift")
    v1, _ = migrate_v0_to_v1(json.loads(json.dumps(v0)))
    b = Builder(rng)
    for f in v1["parts"][0]["features"]:
        b.names.add(f["name"])
    parametrize(v1["parts"][0]["features"], b, rng)
    v1["params"] = b.doc_params
    text = dumps_canonical(v1)
    assert b.doc_params, "the lift must introduce parameters"
    r0 = eval_v0(json.loads(json.dumps(v0)), "lift")
    r1 = eval_v1(text, "lift")
    assert_equivalent(r0, r1, [])
