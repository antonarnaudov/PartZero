"""W7b: the oracle's runners for the Phase B amendment fixtures (SPEC-v1 §9.4, §11.1 "Runners"):
`invalid/documents.json` **with `details`** ([W0-47]: `null` = the key is absent, entries matched to
distinct problems) and `expressions/parameters.json` ([W0-20] … [W0-27], [W0-46]). The boolean,
section and probe fixtures have their runners in `test_v1_ops_booleans.py`,
`test_v1_ops_normalize.py` and `test_v1_ops_replay.py`.

Each runner has a pending list of the cases the oracle does not follow yet, with the outcome it
gives today (asserted, like Forge's `FORGE_PENDING_*`): all empty after W7b.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_v1_support import max_matching

from aicad_oracle.v1.evaluate import evaluate_data
from aicad_oracle.v1.load import Rejected, load_value

REPO = Path(__file__).resolve().parents[2]
CONF = REPO / "corpus" / "v1" / "conformance"
INVALID = json.loads((CONF / "invalid/documents.json").read_text())["cases"]
PARAMS = json.loads((CONF / "expressions/parameters.json").read_text())["cases"]

ORACLE_PENDING_DETAILS: dict[str, list] = {}
ORACLE_PENDING_PARAMETERS: dict[str, list] = {}


def _bits(v: float) -> str:
    return "0x" + struct.pack(">d", float(v)).hex()


def _same(a, b) -> bool:
    """Fixture equality: numbers bit for bit (an integral JSON number equals its float)."""
    if isinstance(b, bool) or isinstance(a, bool):
        return a is b
    if isinstance(b, (int, float)) and isinstance(a, (int, float)):
        return _bits(a) == _bits(b)
    if isinstance(b, list) and isinstance(a, list):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    if isinstance(b, dict) and isinstance(a, dict):
        return a.keys() == b.keys() and all(_same(a[k], b[k]) for k in b)
    return a == b


def _details_match(got: dict, want: dict | None) -> bool:
    for k, v in (want or {}).items():
        if v is None:
            if k in got:  # [W0-47]: a fixture `null` means the key is absent (an emitted null fails)
                return False
        elif k not in got or not _same(got[k], v):
            return False
    return True


def _fits(p, e: dict) -> bool:
    return p.code == e["code"] and p.path == e["path"] and _details_match(getattr(p, "details", None) or {},
                                                                          e.get("details"))


def _unmatched(problems: list, expected: list[dict]) -> list[dict]:
    """The expected entries left unmatched by a maximum matching to distinct returned problems (code,
    path, listed details) — the Rust runner's `unmatched` (Kuhn), not a greedy pass in fixture
    order (W7b review 5)."""
    m = max_matching(len(expected), len(problems), lambda w, g: _fits(problems[g], expected[w]))
    return [e for i, e in enumerate(expected) if i not in m]


def test_details_are_matched_by_a_maximum_matching_not_in_fixture_order():
    """The less specific entry (code and path only) comes first and fits both problems; a greedy
    pass lets it take the one the second entry's `details` need — a false failure."""
    p1 = SimpleNamespace(code="X", path="/a", details={"k": 1})
    p2 = SimpleNamespace(code="X", path="/a", details={"k": 2})
    want = [{"code": "X", "path": "/a"}, {"code": "X", "path": "/a", "details": {"k": 1}}]
    assert _unmatched([p1, p2], want) == []
    assert _unmatched([p2, p1], want) == []
    assert _unmatched([p2, p2], want) == [want[1]]
    assert _unmatched([p1], want) == [want[1]]  # one problem never satisfies two entries


DETAIL_CASES = [c for c in INVALID if not c.get("parse_error") and any("details" in e for e in c["expected"])]


def test_the_details_cases_exist():
    assert len(DETAIL_CASES) >= 13


@pytest.mark.parametrize("case", DETAIL_CASES, ids=lambda c: c["id"])
def test_invalid_document_details(case):
    """[W0-47]: `details` are compared where an entry carries them (`test_invalid_document` compares
    code and path of every case)."""
    try:
        load_value(case["document"])
        problems = []
    except Rejected as r:
        problems = list(r.problems)
    bad = _unmatched(problems, case["expected"])
    if case["id"] in ORACLE_PENDING_DETAILS:
        assert bad == ORACLE_PENDING_DETAILS[case["id"]] and bad
    else:
        assert not bad, [(p.code, p.path, getattr(p, "details", None)) for p in problems]


def _err_ok(got: dict | None, want: dict) -> bool:
    return got is not None and got.get("code") == want["code"] and _details_match(got.get("details") or {},
                                                                                   want.get("details"))


def test_the_parameter_cases_exist():
    assert len(PARAMS) >= 7


@pytest.mark.parametrize("case", PARAMS, ids=lambda c: c["id"])
def test_parameters_fixture(case):
    rep = evaluate_data(case["document"], case["id"])
    ps = {p["name"]: p for p in rep["params"]}
    fs = {f["feature_id"]: f for f in rep["features"]}
    bad = []
    for n, w in (case.get("params") or {}).items():
        p = ps[n]
        if "error" in w:
            if not _err_ok(p.get("error"), w["error"]):
                bad.append((n, p.get("error") or p.get("value")))
        elif "error" in p or _bits(p["value"]) != w["bits"]:
            bad.append((n, p.get("error") or _bits(p["value"])))
    for fid, w in (case.get("features") or {}).items():
        f = fs[fid]
        if f["status"] != w["status"] or (w["status"] == "error" and not _err_ok(f.get("error"), w["error"])):
            bad.append((fid, f["status"], f.get("error")))
    if case["id"] in ORACLE_PENDING_PARAMETERS:
        assert bad == ORACLE_PENDING_PARAMETERS[case["id"]] and bad
    else:
        assert not bad, bad
