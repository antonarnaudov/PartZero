#!/usr/bin/env python3
"""Dump the W7a oracle's answers for forge-params' differential test (`oracle_diff.rs`).

The oracle is `oracle/src/aicad_oracle/v1/expr.py`, an independent Python implementation of
SPEC-v1 §2.3–§2.7 (lexer, parser, canonical printer, type checker, evaluator). This script asks
it about:

* every case of `corpus/v1/conformance/expressions/cases.json` (text and field only);
* `--random N` seeded random expressions over the same parameter environment, generated
  type-directed (so that they are well typed) with, one time in three, exactly **one** fault
  injected (an unknown name or function, a wrong arity, a Bool or wrongly dimensioned operand,
  or a field of the wrong type): an expression with a single problem has a single correct
  code, whichever order an implementation checks in;
* the size-limit edges: nesting 64/65 through every construct, flat chains up to 4096 bytes.

For each case it writes the oracle's canonical text, static type, and value (with `bits` when
no libm function is involved, else `tolerance_rel`: 1e-12, or more when the expression amplifies
a one-ulp libm difference, see `sensitivity`) or error `{code, stage}`, in the format of the I9
fixture:

    cd oracle && .venv/bin/python ../forge/crates/forge-params/oracle/oracle_dump.py \\
        --random 30000 --seed 1 > "$TMPDIR/w1_oracle.json"
    cd ../forge && W1_ORACLE_CASES="$TMPDIR/w1_oracle.json" \\
        cargo test -p forge-params --test oracle_diff -- --ignored --nocapture
"""

from __future__ import annotations

import argparse
import json
import os
import random
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "oracle", "src"))

from aicad_oracle.v1 import expr as X  # noqa: E402

FIXTURE = os.path.join(REPO, "corpus", "v1", "conformance", "expressions", "cases.json")

# Known W7a deviation, corrected here so that the diff shows only unknown ones: SPEC-v1 §2.6
# gives `atan2` the range (−180, 180], but the oracle returns -180 when `atan2(y, x) · 180/π`
# rounds to -180 (y a tiny negative, x < 0: `atan2(-3, -1e21)`). Forge returns 180 (the same
# direction, inside the range). Reported in the W1 report; `--raw` keeps the oracle's answer.
_ATAN2_RAW = X._atan2_deg
ATAN2_FIXED = [0]


def _atan2_in_range(y: float, x: float) -> float | None:
    r = _ATAN2_RAW(y, x)
    if r == -180.0:
        ATAN2_FIXED[0] += 1
        return 180.0
    return r
# Results that go through a platform libm are compared within PARAM_VALUE_REL, not bit for bit.
LIBM = ("sin(", "cos(", "tan(", "asin(", "acos(", "atan(", "atan2(", "hypot(", "^")


def bits(x: float) -> str:
    return "0x%016x" % struct.unpack(">Q", struct.pack(">d", x))[0]


LIBM_FUNCS = ("sin", "cos", "asin", "acos", "atan", "atan2", "hypot", "pow")


def nudged(ast, env: dict, text: str, fld: str) -> list:
    """The outcomes (a value, or an error code) when every libm result moves by one ulp: all
    up, all down, and alternating both ways. Two correct libms may differ by that much."""
    import math

    orig = {f: getattr(math, f) for f in LIBM_FUNCS}
    out = []
    for mode in range(4):
        calls = [0]

        def nudge(f, mode=mode, calls=calls):
            def g(*args):
                r = f(*args)
                calls[0] += 1
                up = mode == 0 or (mode == 2 and calls[0] % 2) or (mode == 3 and not calls[0] % 2)
                return math.nextafter(r, math.inf if up else -math.inf)

            return g

        try:
            for f in LIBM_FUNCS:
                setattr(math, f, nudge(orig[f]))
            out.append(X.evaluate(ast, env, text=text, fld=fld))
        except X.ExprError as e:
            out.append(e.code)
        except (OverflowError, ValueError, ZeroDivisionError):
            out.append("PYTHON_ERROR")
        finally:
            for f in LIBM_FUNCS:
                setattr(math, f, orig[f])
    return out


def answer(text: str, fld: str, types: dict, env: dict) -> dict:
    case: dict = {"text": text, "field": fld}
    try:
        ch = X.check(text, fld, types)
    except X.ExprError as e:
        case["error"] = {"code": e.code, "stage": "R"}
        return case
    case["canonical"] = ch.canonical
    case["type"] = str(ch.ty)
    try:
        v, code = X.evaluate(ch.ast, env, text=text, fld=fld), None
    except X.ExprError as e:
        v, code = None, e.code
        case["error"] = {"code": e.code, "stage": "E"}
    else:
        case["value"] = v
    if not any(f in ch.canonical for f in LIBM):
        if code is None and not isinstance(v, bool):
            case["bits"] = bits(v)
        return case
    # libm-dependent: a relative tolerance of 1e-12, or 4x the one-ulp sensitivity when the
    # expression amplifies libm differences more; `unstable` when a one-ulp nudge changes the
    # outcome (value <-> error, a Bool, an integrality or pole decision) or moves a real by
    # more than 1e-6: then only the static part (canonical text, type) is comparable.
    worst = 0.0
    for w in nudged(ch.ast, env, text, fld):
        if code is not None or isinstance(w, str) or isinstance(v, bool):
            if w != (code if code is not None else v):
                case["unstable"] = True
                return case
            continue
        worst = max(worst, abs(w - v) / max(abs(v), 5e-324))
    if worst > 1e-6:
        case["unstable"] = True
    elif code is None and not isinstance(v, bool):
        case["tolerance_rel"] = max(1e-12, 4 * worst)
    return case


class Gen:
    """Type-directed random expressions; `kind` is L (mm), A (deg), R (dimensionless) or B."""

    def __init__(self, rng: random.Random, params: list):
        self.r = rng
        self.names = {"L": [], "A": [], "R": [], "B": []}
        for p in params:
            k = {"mm": "L", "deg": "A", "ratio": "R", "count": "R", "bool": "B"}[p["unit"]]
            self.names[k].append(p["name"])
        self.fault: str | None = None  # the one fault still to inject

    def ws(self) -> str:
        return self.r.choice(["", "", " ", " ", " ", "  ", "\t"])

    def num(self) -> str:
        r = self.r
        return r.choice([
            lambda: str(r.randint(0, 100)),
            lambda: str(r.randint(0, 9999)) + "." + str(r.randint(0, 999)),
            lambda: f"{r.randint(1, 9)}e{r.randint(-8, 8)}",
            lambda: r.choice(["0", "0.5", "30", "45", "60", "90", "180", "360", "1e300",
                              "1e-300", "2.5", "0.1", "1e21", "123456789012345678"]),
        ])()

    def leaf(self, k: str) -> str:
        r = self.r
        if self.fault is not None and r.random() < 0.15:
            f, self.fault = self.fault, None
            return {
                "name": lambda: r.choice(["nope", "widht", "base", "_x"]),
                "function": lambda: r.choice(["foo(1)", "sinh(30)", "len(2)"]),
                "arity": lambda: r.choice(["min(1)", "sin(1, 2)", "clamp(1, 2)", "atan2(1)"]),
                "bool": lambda: r.choice(["lid", "true", "(1 < 2)"]),
                "unit": lambda: {"L": "tilt", "A": "width", "R": "wall", "B": "width"}[k],
            }[f]()
        if k == "B":
            return r.choice(self.names["B"] + ["true", "false"])
        if r.random() < 0.4:
            return self.num()
        if k == "L" and r.random() < 0.3:
            return f"{self.num()}{r.choice(['', ' '])}{r.choice(['mm', 'cm', 'in'])}"
        if k == "A" and r.random() < 0.3:
            return f"{self.num()}{r.choice(['', ' '])}deg"
        if k == "R" and r.random() < 0.1:
            return "PI"
        return r.choice(self.names[k])

    def strict(self, k: str, d: int) -> str:
        """A fixed (non-Flex) dimension: a parameter, a unit literal, or one added to more."""
        r = self.r
        base = r.choice(self.names[k]) if k != "L" or r.random() < 0.7 else f"{r.randint(1, 50)} mm"
        return base if d <= 0 or r.random() < 0.6 else f"({base} + {self.op(k, d - 1)})"

    def op(self, k: str, d: int) -> str:
        """An operand: parenthesised unless it is a leaf or a call (so that the text parses as
        generated; the canonical printer drops the redundant parentheses again)."""
        t, atomic = self.gen(k, d)
        return t if atomic else f"({t})"

    def arg(self, k: str, d: int) -> str:
        return self.gen(k, d)[0]

    def gen(self, k: str, d: int) -> tuple[str, bool]:
        r = self.r
        if d <= 0 or r.random() < 0.25:
            t = self.leaf(k)
            return t, " " not in t.strip() or t.endswith(")")
        o = lambda kk: self.op(kk, d - 1)  # noqa: E731
        a = lambda kk: self.arg(kk, d - 1)  # noqa: E731
        w = self.ws
        call = lambda t: (t, True)  # noqa: E731
        forms = {
            "L": [
                lambda: f"{o('L')}{w()}+{w()}{o('L')}", lambda: f"{o('L')}{w()}-{w()}{o('L')}",
                lambda: f"{o('L')}{w()}*{w()}{o('R')}", lambda: f"{o('R')} * {o('L')}",
                lambda: f"{o('L')}{w()}/{w()}{o('R')}", lambda: f"{o('L')} % {o('L')}",
                lambda: f"-{o('L')}",
                lambda: call(f"{r.choice(['abs', 'floor', 'ceil', 'round'])}({a('L')})"),
                lambda: call(f"{r.choice(['min', 'max'])}({a('L')}, {a('L')})"),
                lambda: call(f"clamp({a('L')}, {a('L')}, {a('L')})"),
                lambda: call(f"hypot({a('L')},{w()}{a('L')})"),
                lambda: call((lambda t: f"sqrt({t} * {t})")(o('L'))),
                lambda: f"{o('B')} ? {a('L')} : {a('L')}",
                lambda: f"{o('L')} * {r.choice(['sin', 'cos'])}({a('A')})",
            ],
            "A": [
                lambda: f"{o('A')} + {o('A')}", lambda: f"{o('A')} - {o('A')}",
                lambda: f"{o('A')} * {o('R')}", lambda: f"-{o('A')}",
                lambda: call(f"{r.choice(['asin', 'acos', 'atan'])}({a('R')})"),
                lambda: call(f"atan2({a('L')}, {a('L')})"), lambda: call(f"atan2({a('R')}, {a('R')})"),
                lambda: f"{o('B')} ? {a('A')} : {a('A')}", lambda: call(f"max({a('A')}, {a('A')})"),
            ],
            "R": [
                lambda: f"{o('R')} + {o('R')}", lambda: f"{o('R')} * {o('R')}",
                lambda: f"{o('R')} / {o('R')}",
                lambda: f"{self.strict('L', d - 1)} / {self.strict('L', d - 1)}",
                lambda: f"{self.strict('A', d - 1)} / {self.strict('A', d - 1)}",
                lambda: f"{o('R')} ^ {r.choice(['2', '3', '-1', '-2', '0.5', '64', '65', '(-3)', o('R')])}",
                lambda: call(f"{r.choice(['sin', 'cos', 'tan'])}({a('A')})"), lambda: call(f"sqrt({a('R')})"),
                lambda: call(f"{r.choice(['floor', 'round', 'ceil'])}({a('R')})"), lambda: f"{o('R')} % {o('R')}",
                lambda: f"-{o('R')}", lambda: f"{o('B')} ? {a('R')} : {a('R')}",
            ],
            "B": [
                lambda: f"{o('B')} && {o('B')}", lambda: f"{o('B')} || {o('B')}", lambda: f"!{o('B')}",
                lambda: f"{o('L')} < {o('L')}", lambda: f"{o('L')} <= {o('L')}",
                lambda: f"{o('A')} > {o('A')}", lambda: f"{o('R')} >= {o('R')}",
                lambda: f"{o('L')} == {o('L')}", lambda: f"{o('B')} == {o('B')}",
                lambda: f"{o('B')} != {o('B')}",
                lambda: f"{o('B')} ? {a('B')} : {a('B')}",
            ],
        }
        t = r.choice(forms[k])()
        return t if isinstance(t, tuple) else (t, False)

    def case(self) -> tuple[str, str]:
        r = self.r
        k = r.choice("LLARRB")
        fld = {"L": "length", "A": "angle", "R": r.choice(["ratio", "count"]), "B": "bool"}[k]
        self.fault = None
        if r.random() < 1 / 3:
            self.fault = r.choice(["name", "function", "arity", "bool", "unit", "field"])
        if self.fault == "field":
            self.fault = None
            fld = r.choice([f for f in X.FIELD_TYPES if f != fld])
        return self.arg(k, r.randint(1, 6)), fld


def edges() -> list[tuple[str, str]]:
    out = []
    for n in (63, 64, 65):
        out += [
            ("(" * n + "1" + ")" * n, "ratio"),
            ("abs(" * n + "1" + ")" * n, "ratio"),
            ("-" * n + "1", "ratio"),
            ("!" * n + "lid", "bool"),
            (" ^ ".join(["1"] * (n + 1)), "ratio"),
            ("lid ? 1 : " * n + "1", "ratio"),
            ("lid ? " * n + "1" + " : 2" * n, "ratio"),
            ("(" * (n - 1) + "min(1, 2)" + ")" * (n - 1), "ratio"),
            ("-abs(" * (n // 2) + "1" + ")" * (n // 2), "ratio"),
        ]
    for n in (2, 64, 65, 1000, 2048):
        out.append(("+".join(["1"] * n), "ratio"))
        out.append(("*".join(["half"] * min(n, 1365)), "ratio"))
    out += [
        ("&&".join(["lid"] * 800), "bool"),
        ("(" * 64 + "*".join(["1"] * 1980) + ")" * 64, "ratio"),
        ("x" + " " * 4095, "ratio"),
        ("1" + " " * 4095, "ratio"),
        ("1" + " " * 4096, "ratio"),
        ("1e400", "ratio"), ("1e-400", "ratio"), ("5e-324", "ratio"), ("1.", "ratio"),
        (".5", "ratio"), ("1e", "ratio"), ("12mm", "length"), ("12 mm", "length"),
        ("mm", "length"), ("2 *\tin", "length"), ("1\n+1", "ratio"), ("sin (30)", "ratio"),
        ("1e300 ^ -2", "ratio"), ("(-1e300) ^ -3", "ratio"), ("0 ^ -2", "ratio"),
        ("width ^ 2.0 / width", "length"), ("-0", "ratio"), ("0 * -1", "ratio"),
    ]
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--random", type=int, default=30000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--raw", action="store_true", help="keep the oracle's atan2 = -180")
    a = ap.parse_args()
    if not a.raw:
        X._atan2_deg = _atan2_in_range
    fixture = json.load(open(FIXTURE))
    params = fixture["params"]
    types = {p["name"]: X.UNIT_TY[p["unit"]] for p in params}
    env = {p["name"]: p["value"] for p in params}
    texts = [(c["text"], c["field"]) for c in fixture["cases"]] + edges()
    g = Gen(random.Random(a.seed), params)
    seen = set(texts)
    while len(texts) < len(fixture["cases"]) + len(edges()) + a.random:
        t = g.case()
        if t not in seen and len(t[0].encode()) <= 4096:
            seen.add(t)
            texts.append(t)
    cases = [answer(t, f, types, env) for t, f in texts]
    json.dump({"params": params, "cases": cases}, sys.stdout, separators=(",", ":"))
    print(f"{len(cases)} cases; atan2 = -180 mapped to 180 in {ATAN2_FIXED[0]} evaluations",
          file=sys.stderr)


if __name__ == "__main__":
    main()
