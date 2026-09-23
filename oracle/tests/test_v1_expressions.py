"""IR v1 expressions (SPEC-v1 §2.3–§2.7): the oracle's independent implementation against the I9
conformance suite (`corpus/v1/conformance/expressions/cases.json`, all cases) and properties.

* canonical text, static type, value bits (or `tolerance_rel` for libm-dependent results) and
  error code + stage of every fixture case;
* `parse(canonical(ast)) == ast` and idempotence of `canonical` on random ASTs;
* soundness of the type checker: an accepted expression never fails evaluation for a *type*
  reason (only `EXPR_DOMAIN` / `EXPR_NOT_INTEGER` may be raised);
* exact degree trigonometry at k·30° and k·45° (k ∈ [−48, 48]) and the inverse table (§2.7).
"""

from __future__ import annotations

import json
import math
import random
import struct
from pathlib import Path

import pytest

from aicad_oracle.v1 import expr as E
from aicad_oracle.v1.jsonio import fmt_f64_json, fmt_js_number

REPO = Path(__file__).resolve().parents[2]
FIX = json.loads((REPO / "corpus" / "v1" / "conformance" / "expressions" / "cases.json").read_text())
TYPES = {p["name"]: E.UNIT_TY[p["unit"]] for p in FIX["params"]}
ENV = {p["name"]: p["value"] for p in FIX["params"]}


def _bits(v: float) -> str:
    return "0x" + struct.pack(">d", v).hex()


def test_the_suite_is_complete():
    assert len(FIX["cases"]) == 376
    assert len({c["id"] for c in FIX["cases"]}) == 376


@pytest.mark.parametrize("case", FIX["cases"], ids=lambda c: c["id"])
def test_expression_conformance_case(case):
    got: dict = {}
    try:
        ch = E.check(case["text"], case["field"], TYPES)
        got["canonical"], got["type"] = ch.canonical, str(ch.ty)
        try:
            got["value"] = E.evaluate(ch.ast, ENV, text=case["text"], fld=case["field"])
        except E.ExprError as e:
            got["error"] = {"code": e.code, "stage": e.stage}
    except E.ExprError as e:
        got["error"] = {"code": e.code, "stage": e.stage}
    for k in ("canonical", "type", "error"):
        if k in case:
            assert got.get(k) == case[k], (k, got)
    if "error" in case:
        assert "value" not in got, got
        return
    v = got["value"]
    if "bits" in case:
        assert isinstance(v, float) and _bits(v) == case["bits"], (v, case["value"])
    elif "tolerance_rel" in case:
        assert abs(v - case["value"]) <= case["tolerance_rel"] * max(1.0, abs(case["value"])), v
    else:
        assert v == case["value"] and type(v) is type(case["value"])


def test_canonical_text_of_every_accepted_case_is_a_fixed_point():
    for c in FIX["cases"]:
        if "canonical" in c:
            assert E.canonicalize(c["canonical"]) == c["canonical"], c["id"]


# ---------------------------------------------------------------------------------------------
# Random ASTs
# ---------------------------------------------------------------------------------------------

NUM_NAMES = [n for n, t in TYPES.items() if t.kind != "bool"]
BOOL_NAMES = [n for n, t in TYPES.items() if t.kind == "bool"]


def rand_num(rng: random.Random) -> float:
    return rng.choice([0.0, 1.0, 2.0, 0.5, 1e-7, 3.25, 12.0, 1e21, 123.456, 7.0, 90.0, 30.0, 45.0])


def rand_ast(rng: random.Random, depth: int = 0) -> E.Node:
    if depth > 5 or rng.random() < 0.25:
        k = rng.random()
        if k < 0.45:
            return E.Num(rand_num(rng), rng.choice([None, None, None, "mm", "cm", "in", "deg"]))
        if k < 0.8:
            return E.Name(rng.choice(NUM_NAMES + ["PI"]))
        if k < 0.9:
            return E.Name(rng.choice(BOOL_NAMES))
        return E.BoolLit(rng.random() < 0.5)
    k = rng.random()
    if k < 0.45:
        op = rng.choice(["+", "-", "*", "/", "%", "^", "<", "<=", ">", ">=", "==", "!=", "&&", "||"])
        return E.Binary(op, rand_ast(rng, depth + 1), rand_ast(rng, depth + 1))
    if k < 0.6:
        return E.Unary(rng.choice(["-", "-", "!"]), rand_ast(rng, depth + 1))
    if k < 0.7:
        return E.Cond(rand_ast(rng, depth + 1), rand_ast(rng, depth + 1), rand_ast(rng, depth + 1))
    f = rng.choice(sorted(E.FUNCTIONS))
    lo, hi = E.FUNCTIONS[f]
    n = lo if hi is not None else rng.choice([2, 3])
    return E.Call(f, tuple(rand_ast(rng, depth + 1) for _ in range(n)))


def test_parse_of_canonical_is_the_ast_and_canonical_is_idempotent():
    rng = random.Random("aicad-v1-expr/roundtrip")
    for _ in range(4000):
        ast = rand_ast(rng)
        text = E.canonical(ast)
        back = E.parse(text)
        assert back == ast, (text, back)
        assert E.canonical(back) == text


def test_type_checker_is_sound_for_evaluation():
    """Accepted expressions fail evaluation only with EXPR_DOMAIN or EXPR_NOT_INTEGER."""
    rng = random.Random("aicad-v1-expr/soundness")
    accepted = 0
    for _ in range(6000):
        text = E.canonical(rand_ast(rng))
        fld = rng.choice(E.FIELD_TYPES)
        try:
            ch = E.check(text, fld, TYPES)
        except E.ExprError as e:
            assert e.stage == "R" and e.code.startswith("EXPR_"), (text, e.code)
            continue
        accepted += 1
        try:
            v = E.evaluate(ch.ast, ENV, text=text, fld=fld)
        except E.ExprError as e:
            assert e.code in ("EXPR_DOMAIN", "EXPR_NOT_INTEGER") and e.stage == "E", (text, e.code)
            continue
        if fld == "bool":
            assert isinstance(v, bool), text
        else:
            assert isinstance(v, float) and math.isfinite(v), (text, v)
            assert not (v == 0.0 and math.copysign(1.0, v) < 0), f"-0 escaped from {text}"
    assert accepted > 500


def test_deep_left_chains_and_the_depth_limit():
    long = " + ".join(["1"] * 1000)  # 3997 bytes: a flat chain does not nest
    assert len(long) <= 4096
    assert E.evaluate(E.parse(long), {}) == 1000.0
    assert E.canonicalize(long) == long
    assert E.canonicalize("(" * 64 + "1" + ")" * 64) == "1"
    with pytest.raises(E.ExprError) as e:
        E.parse("(" * 65 + "1" + ")" * 65)
    assert e.value.code == "EXPR_SYNTAX"
    with pytest.raises(E.ExprError):
        E.parse("1" * 4097)


# ---------------------------------------------------------------------------------------------
# §2.7 exactness
# ---------------------------------------------------------------------------------------------

SIN_TABLE = {0: 0.0, 30: 0.5, 45: 0.7071067811865476, 60: 0.8660254037844386, 90: 1.0}


def _exact_sin(deg: int) -> float:
    r = deg % 360
    q, s = divmod(r, 90)
    sn = SIN_TABLE.get(s) if s in SIN_TABLE else None
    cs = SIN_TABLE.get(90 - s) if (90 - s) in SIN_TABLE else None
    return ((sn, cs, -sn, -cs)[q]) if sn is not None else None


@pytest.mark.parametrize("step", [30, 45])
def test_table_angles_are_exact(step):
    for k in range(-48, 49):
        x = float(step * k)
        s, c = E.sin_cos_deg(x)
        es, ec = _exact_sin(step * k), _exact_sin(step * k + 90)
        assert (s, c) == (es + 0.0, ec + 0.0), x
        assert not math.copysign(1.0, s) < 0 or s != 0.0
        t = E.tan_deg(x)
        if ec == 0.0:
            assert t is None
        else:
            assert t == (es / ec) + 0.0


def test_inverse_table_is_exact():
    ev = lambda t: E.evaluate(E.parse(t), {})  # noqa: E731
    exact = {"asin(0)": 0.0, "asin(0.5)": 30.0, "asin(-0.5)": -30.0, "asin(1)": 90.0, "asin(-1)": -90.0,
             "acos(1)": 0.0, "acos(0.5)": 60.0, "acos(0)": 90.0, "acos(-0.5)": 120.0, "acos(-1)": 180.0,
             "atan(0)": 0.0, "atan(1)": 45.0, "atan(-1)": -45.0, "atan2(0, 3)": 0.0, "atan2(0, -3)": 180.0,
             "atan2(-0, -3)": 180.0, "atan2(5, 0)": 90.0, "atan2(-5, 0)": -90.0, "atan2(7, 7)": 45.0,
             "atan2(-7, 7)": -45.0, "atan2(7, -7)": 135.0, "atan2(-7, -7)": -135.0}
    for text, v in exact.items():
        assert ev(text) == v, text


def test_tiny_negative_angle_reduces_to_zero_not_360():
    assert E.sin_cos_deg(-1e-20) == (0.0, 1.0)
    assert E.sin_cos_deg(math.inf) is None


def test_binary_exponentiation_is_the_specified_multiplication_sequence():
    for a in (1.1, 0.3, -1.7, 3.0, 1e-3):
        for n in range(0, 65):
            r, p, k = 1.0, a, n
            while True:
                if k & 1:
                    r = r * p
                k >>= 1
                if k == 0:
                    break
                p = p * p
            assert E.evaluate(E.parse(f"({fmt_js_number(a)}) ^ {n}"), {}) == r + 0.0


# ---------------------------------------------------------------------------------------------
# Number texts
# ---------------------------------------------------------------------------------------------

@pytest.mark.parametrize("x, js", [
    (1e21, "1e+21"), (1e20, "100000000000000000000"), (1e-7, "1e-7"), (1e-6, "0.000001"),
    (123456789012345678901.0, "123456789012345680000"), (0.1, "0.1"), (5e-324, "5e-324"),
    (1.7976931348623157e308, "1.7976931348623157e+308"), (-0.0, "0"), (2.5e-3, "0.0025"), (1000.0, "1000"),
])
def test_ecmascript_number_text(x, js):
    assert fmt_js_number(x) == js


@pytest.mark.parametrize("x, text", [
    (8.0, "8.0"), (0.00001, "0.00001"), (1e-6, "1e-6"), (1e-7, "1e-7"), (1.5e16, "1.5e+16"),
    (1e16, "1e+16"), (123456789012345.0, "123456789012345.0"), (12.5, "12.5"), (-0.0, "-0.0"),
    (0.0, "0.0"), (-2.75, "-2.75"), (1e300, "1e+300"),
])
def test_canonical_json_number_text(x, text):
    assert fmt_f64_json(x) == text


def test_json_number_text_round_trips():
    rng = random.Random("aicad-v1-expr/numbers")
    for _ in range(20000):
        x = struct.unpack(">d", rng.randbytes(8))[0]
        if not math.isfinite(x):
            continue
        assert float(fmt_f64_json(x)) == x
        assert float(fmt_js_number(x)) == x or x == 0.0


# ---------------------------------------------------------------------------------------------
# The W1 ↔ oracle agreement gate (`oracle exprs`)
# ---------------------------------------------------------------------------------------------

def test_agreement_gate_tooling(tmp_path, capsys):
    from aicad_oracle.cli import main
    from aicad_oracle.v1.exprgen import check, generate

    data = json.loads(json.dumps(generate(4, 600)))
    assert check(data) == []
    ok = [c for c in data["cases"] if "value" in c and isinstance(c["value"], float) and c["field"] != "count"]
    codes = {c["error"]["code"] for c in data["cases"] if "error" in c}
    assert len(ok) > 200 and {"EXPR_DOMAIN", "EXPR_UNIT_MISMATCH"} <= codes
    bad = copy_cases(data)
    bad["cases"][data["cases"].index(ok[0])]["value"] = ok[0]["value"] * (1 + 1e-10) + 1e-10
    err = next(c for c in bad["cases"] if "error" in c)
    err["error"] = {"code": "EXPR_SYNTAX", "stage": "R"}
    assert len(check(bad)) == 2
    f = tmp_path / "theirs.json"
    f.write_text(json.dumps(bad))
    assert main(["exprs", "--check", str(f)]) == 1
    f.write_text(json.dumps(data))
    assert main(["exprs", "--check", str(f)]) == 0
    assert main(["exprs", "--count", "20", "--out", str(tmp_path / "o.json")]) == 0
    assert len(json.loads((tmp_path / "o.json").read_text())["cases"]) == 20


def copy_cases(d: dict) -> dict:
    return json.loads(json.dumps(d))
