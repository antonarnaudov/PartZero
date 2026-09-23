"""Random expressions for the W1 ↔ oracle agreement gate (IR-V1 plan §4 W1: "10,000 random
well-typed expressions; reals within 1e-12 relative, counts and bools exact, identical error
codes").

`oracle exprs --count N --seed S --out F` writes cases in the format of
`corpus/v1/conformance/expressions/cases.json` (`params` environment, then per case `text`, `field`,
and the oracle's `canonical`, `type`, `value` + `bits`, or `error: {code, stage}`), about 85 %
well-typed. Another implementation evaluates the same texts and writes the same fields;
`oracle exprs --check THEIRS.json` recomputes the oracle's answer for every case and reports each
disagreement: canonical text and type exact, reals within `PARAM_VALUE_REL` (1e-12) relative,
counts and bools exact, error code and stage exact.
"""

from __future__ import annotations

import json
import random
import struct

from . import expr as E
from .consts import PARAM_VALUE_REL

ENV_PARAMS = [
    {"name": "width", "unit": "mm", "value": 80.0}, {"name": "depth", "unit": "mm", "value": 50.0},
    {"name": "wall", "unit": "mm", "value": 2.0}, {"name": "tiny", "unit": "mm", "value": 0.1},
    {"name": "neg", "unit": "mm", "value": -3.0}, {"name": "zero", "unit": "mm", "value": 0.0},
    {"name": "holes", "unit": "count", "value": 4.0}, {"name": "tilt", "unit": "deg", "value": 15.0},
    {"name": "half", "unit": "ratio", "value": 0.5}, {"name": "third", "unit": "ratio", "value": 0.3333333333333333},
    {"name": "lid", "unit": "bool", "value": True}, {"name": "off", "unit": "bool", "value": False},
]
TYPES = {p["name"]: E.UNIT_TY[p["unit"]] for p in ENV_PARAMS}
ENV = {p["name"]: p["value"] for p in ENV_PARAMS}
LEN = [p["name"] for p in ENV_PARAMS if p["unit"] == "mm"]
ONE = [p["name"] for p in ENV_PARAMS if p["unit"] in ("ratio", "count")]
BOOLS = ["lid", "off"]
NUMS = [0.0, 0.5, 1.0, 2.0, 3.0, 7.0, 10.0, 12.5, 30.0, 45.0, 60.0, 90.0, 0.1, 1e-3, 123.456, 1e6]


def _num(rng: random.Random) -> E.Node:
    return E.Num(rng.choice(NUMS) if rng.random() < 0.8 else round(rng.uniform(0, 200), rng.choice([0, 2, 6])))


def gen(rng: random.Random, want: str, depth: int = 0) -> E.Node:
    """A (mostly) well-typed AST of the wanted kind: `len`, `deg`, `one`, `flex` or `bool`."""
    leaf = depth >= 4 or rng.random() < 0.3
    if want == "bool":
        if leaf:
            return E.Name(rng.choice(BOOLS)) if rng.random() < 0.7 else E.BoolLit(rng.random() < 0.5)
        k = rng.random()
        if k < 0.4:
            t = rng.choice(["len", "one", "flex"])
            return E.Binary(rng.choice(["<", "<=", ">", ">=", "==", "!="]), gen(rng, t, depth + 1), gen(rng, t, depth + 1))
        if k < 0.7:
            return E.Binary(rng.choice(["&&", "||"]), gen(rng, "bool", depth + 1), gen(rng, "bool", depth + 1))
        if k < 0.85:
            return E.Unary("!", gen(rng, "bool", depth + 1))
        return E.Cond(gen(rng, "bool", depth + 1), gen(rng, "bool", depth + 1), gen(rng, "bool", depth + 1))
    if leaf:
        if want == "len":
            return E.Name(rng.choice(LEN)) if rng.random() < 0.7 else E.Num(rng.choice(NUMS), rng.choice(["mm", "cm", "in"]))
        if want == "deg":
            return E.Name("tilt") if rng.random() < 0.5 else E.Num(rng.choice(NUMS), "deg")
        if want == "one":
            return E.Name(rng.choice(ONE))
        return _num(rng) if rng.random() < 0.85 else E.Name("PI")
    k = rng.random()
    if k < 0.35:
        return E.Binary(rng.choice(["+", "-", "%"]), gen(rng, want, depth + 1), gen(rng, rng.choice([want, "flex"]), depth + 1))
    if k < 0.55:
        other = "flex" if want != "flex" else rng.choice(["flex", "one"])
        a, b = gen(rng, want, depth + 1), gen(rng, other, depth + 1)
        if rng.random() < 0.5:
            a, b = b, a
        if want == "flex" and other == "one":
            return E.Binary("*", a, b) if rng.random() < 0.5 else E.Binary("/", gen(rng, "flex", depth + 1), gen(rng, "one", depth + 1))
        return E.Binary("*", a, b) if rng.random() < 0.7 else E.Binary("/", gen(rng, want, depth + 1), gen(rng, "flex", depth + 1))
    if k < 0.62:
        return E.Unary("-", gen(rng, want, depth + 1))
    if k < 0.7:
        return E.Cond(gen(rng, "bool", depth + 1), gen(rng, want, depth + 1), gen(rng, want, depth + 1))
    if k < 0.78:
        f = rng.choice(["min", "max", "clamp", "hypot"])
        n = {"min": rng.choice([2, 3]), "max": 2, "clamp": 3, "hypot": 2}[f]
        return E.Call(f, tuple(gen(rng, rng.choice([want, "flex"]), depth + 1) for _ in range(n)))
    if k < 0.84:
        return E.Call(rng.choice(["abs", "floor", "ceil", "round"]), (gen(rng, want, depth + 1),))
    if k < 0.9 and want in ("one", "flex"):
        t = rng.choice(["deg", "flex"])
        return E.Call(rng.choice(["sin", "cos", "tan"]), (gen(rng, t, depth + 1),))
    if k < 0.94 and want == "deg":
        f = rng.choice(["asin", "acos", "atan", "atan2"])
        if f == "atan2":
            t = rng.choice(["len", "one", "flex"])
            return E.Call(f, (gen(rng, t, depth + 1), gen(rng, t, depth + 1)))
        return E.Call(f, (E.Binary("/", gen(rng, "one", depth + 1), E.Num(rng.choice([2.0, 3.0, 7.0]))),))
    if want in ("one", "flex") and rng.random() < 0.5:
        return E.Binary("^", E.Num(rng.choice([2.0, 1.5, 0.5, 10.0])), gen(rng, rng.choice(["flex", "one"]), depth + 1))
    if want == "len" and rng.random() < 0.3:
        return E.Call("sqrt", (E.Binary("*", E.Name(rng.choice(LEN)), E.Name(rng.choice(LEN))),))
    return gen(rng, want, depth + 1)


FIELD_OF = {"len": "length", "deg": "angle", "one": "ratio", "flex": "count", "bool": "bool"}


def oracle_case(text: str, fld: str) -> dict:
    out: dict = {}
    try:
        ch = E.check(text, fld, TYPES)
    except E.ExprError as e:
        out["error"] = {"code": e.code, "stage": e.stage}
        return out
    out["canonical"], out["type"] = ch.canonical, str(ch.ty)
    try:
        v = E.evaluate(ch.ast, ENV, text=text, fld=fld)
    except E.ExprError as e:
        out["error"] = {"code": e.code, "stage": e.stage}
        return out
    out["value"] = v
    if isinstance(v, float):
        out["bits"] = "0x" + struct.pack(">d", v).hex()
    return out


def generate(seed: int, count: int) -> dict:
    rng = random.Random(f"aicad-exprs/{seed}")
    cases = []
    for i in range(count):
        want = rng.choice(list(FIELD_OF))
        fld = FIELD_OF[want]
        ast = gen(rng, want)
        if rng.random() < 0.1:  # a sprinkling of ill-typed ones: identical error codes are compared too
            ast = E.Binary(rng.choice(["+", "*"]), ast, E.Name(rng.choice(LEN + BOOLS)))
        text = E.canonical(ast)
        cases.append({"id": f"r{i:05d}", "text": text, "field": fld, **oracle_case(text, fld)})
    return {"description": "Random expressions for the W1 <-> oracle agreement gate (oracle exprs).",
            "params": ENV_PARAMS, "cases": cases}


def check(theirs: dict) -> list[str]:
    """Disagreements between another implementation's results and the oracle's."""
    env = {p["name"]: p["value"] for p in theirs.get("params", ENV_PARAMS)}
    types = {p["name"]: E.UNIT_TY[p["unit"]] for p in theirs.get("params", ENV_PARAMS)}
    out = []
    for c in theirs["cases"]:
        mine: dict = {}
        try:
            ch = E.check(c["text"], c["field"], types)
            mine["canonical"], mine["type"] = ch.canonical, str(ch.ty)
            try:
                mine["value"] = E.evaluate(ch.ast, env, text=c["text"], fld=c["field"])
            except E.ExprError as e:
                mine["error"] = {"code": e.code, "stage": e.stage}
        except E.ExprError as e:
            mine["error"] = {"code": e.code, "stage": e.stage}
        cid = c.get("id", c["text"])
        for k in ("canonical", "type", "error"):
            if k in c or k in mine:
                if c.get(k) != mine.get(k):
                    out.append(f"{cid}: {k} theirs={c.get(k)!r} oracle={mine.get(k)!r}")
        if "value" in c or "value" in mine:
            a, b = c.get("value"), mine.get("value")
            if isinstance(a, bool) or isinstance(b, bool) or c["field"] == "count":
                if a != b or type(a) is not type(b):
                    out.append(f"{cid}: value theirs={a!r} oracle={b!r} (exact)")
            elif not (isinstance(a, (int, float)) and isinstance(b, float)
                      and abs(a - b) <= PARAM_VALUE_REL * max(1.0, abs(a), abs(b))):
                out.append(f"{cid}: value theirs={a!r} oracle={b!r} (rel {PARAM_VALUE_REL:g})")
    return out


def cmd_exprs(args) -> int:
    from pathlib import Path

    if args.check:
        theirs = json.loads(Path(args.check).read_text())
        bad = check(theirs)
        n = len(theirs["cases"])
        print(f"{n - len({b.split(':')[0] for b in bad})}/{n} cases agree with the oracle")
        for b in bad[:50]:
            print(f"  {b}")
        return 1 if bad else 0
    data = generate(args.seed, args.count)
    text = json.dumps(data, indent=1, allow_nan=False) + "\n"
    if args.out:
        Path(args.out).write_text(text)
        ok = sum(1 for c in data["cases"] if "error" not in c)
        print(f"wrote {len(data['cases'])} expressions ({ok} evaluate, {len(data['cases']) - ok} errors) -> {args.out}")
    else:
        print(text, end="")
    return 0


__all__ = ["generate", "check", "cmd_exprs"]
