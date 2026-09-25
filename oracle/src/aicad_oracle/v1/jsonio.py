"""JSON text for IR v1 (SPEC-v1 §0.4 [D-3], [W0-11]).

* `loads_strict`: RFC 8259 JSON with correctly rounded numbers (Python's `float()` is), duplicate
  keys rejected, `NaN`/`Infinity` literals and out-of-range numbers rejected. Integers keep their
  integer type (so `v: 1.0` is not a version), like `forge_ir::v1::json`.
* `dumps_canonical`: the canonical text of `forge_ir::v1::to_json`: serde_json's pretty printer
  (2-space indent, `": "`), object keys in the Rust struct declaration order (serde order: the
  enum tag first, then the fields), every stated default omitted, JSON numbers of `f64` fields
  printed like serde_json 1.0.151 (zmij: decimal for 1e-5 <= |x| < 1e16 with integral values
  ending in `.0`, else `<digits>e<sign><exp>` with an explicit `+`).
* `fmt_js_number`: ECMAScript `Number::toString`, the number form inside expression strings.

The key orders below are transcribed from the Rust types of `forge_ir::v1` (features.rs,
sketch.rs, planes.rs, params.rs, refs.rs, mod.rs). They cannot be derived from
`ir-v1.schema.json`, whose `properties` are sorted alphabetically (see the W7a report).
"""

from __future__ import annotations

import json
import math
from typing import Any


class JsonError(ValueError):
    pass


# ---------------------------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------------------------

_I64_MIN, _U64_MAX = -(2**63), 2**64 - 1


def _pairs(ps):
    d: dict = {}
    for k, v in ps:
        if k in d:
            raise JsonError(f"duplicate key {k!r}")
        d[k] = v
    return d


def _parse_float(s: str) -> float:
    f = float(s)
    if not math.isfinite(f):
        raise JsonError(f"number {s} is out of the f64 range")
    return f


def _parse_int(s: str):
    i = int(s)
    if _I64_MIN <= i <= _U64_MAX:
        return i
    return _parse_float(s)  # like serde_json: integers beyond i64/u64 become f64


def _parse_constant(s: str):
    raise JsonError(f"invalid literal {s}")


def loads_strict(text: str) -> Any:
    try:
        return json.loads(
            text,
            object_pairs_hook=_pairs,
            parse_float=_parse_float,
            parse_int=_parse_int,
            parse_constant=_parse_constant,
        )
    except json.JSONDecodeError as e:
        raise JsonError(str(e)) from e


# ---------------------------------------------------------------------------------------------
# serde_json's (non-`float_roundtrip`) number parser, for v0 documents
# ---------------------------------------------------------------------------------------------
#
# SPEC-v1 §0.4 [W0-11]: "v0 documents keep serde_json's parser (bit-for-bit v0 behavior)". That
# parser is not correctly rounded (about one 17-digit decimal in eight lands one ulp off), and
# `migrate_v0_to_v1` copies the values it read. To reproduce Forge's migration byte for byte
# (the I9 fixtures `t1-split-shaft-collar`, `t2-cable-organizer`), the oracle reads v0 text with
# an exact emulation of serde_json 1.0.151 `de.rs` (`parse_integer`, `parse_decimal`,
# `parse_exponent`, `f64_from_parts` without the `float_roundtrip` feature).

_U64_MAX_ = 2**64 - 1
_I32_MAX = 2**31 - 1
_POW10 = [float(f"1e{k}") for k in range(309)]


def _overflow(a: int, b: int, mx: int) -> bool:
    return a >= mx // 10 and (a > mx // 10 or b > mx % 10)


def _serde_f64_from_parts(positive: bool, significand: int, exponent: int) -> float:
    f = float(significand)
    while True:
        k = abs(exponent)
        if k < len(_POW10):
            if exponent >= 0:
                f *= _POW10[k]
                if math.isinf(f):
                    raise JsonError("number out of range")
            else:
                f /= _POW10[k]
            break
        if f == 0.0:
            break
        if exponent >= 0:
            raise JsonError("number out of range")
        f /= 1e308
        exponent += 308
    return f if positive else -f


def serde_number(lit: str) -> int | float:
    """The value serde_json assigns to the JSON number literal `lit` (an int for an integer
    within u64/i64, else an f64 computed exactly like serde_json without `float_roundtrip`)."""
    s = lit
    i = 0
    positive = True
    if s[i] == "-":
        positive = False
        i += 1
    n = len(s)

    def digit(j):
        return j < n and "0" <= s[j] <= "9"

    sig = 0
    exponent = 0
    if s[i] == "0":
        i += 1
    else:
        while digit(i):
            d = ord(s[i]) - 48
            if _overflow(sig, d, _U64_MAX_):
                # parse_long_integer: further integer digits only scale the exponent
                while digit(i):
                    i += 1
                    exponent += 1
                break
            sig = sig * 10 + d
            i += 1
    is_float = False
    if i < n and s[i] == ".":
        is_float = True
        i += 1
        while digit(i):
            d = ord(s[i]) - 48
            if _overflow(sig, d, _U64_MAX_):
                while digit(i):  # parse_decimal_overflow: ignore the remaining digits
                    i += 1
                break
            sig = sig * 10 + d
            exponent -= 1
            i += 1
    if i < n and s[i] in "eE":
        is_float = True
        i += 1
        pos_exp = True
        if s[i] in "+-":
            pos_exp = s[i] == "+"
            i += 1
        e = 0
        while digit(i):
            d = ord(s[i]) - 48
            if _overflow(e, d, _I32_MAX):
                if sig != 0 and pos_exp:
                    raise JsonError("number out of range")
                return 0.0 if positive else -0.0
            e = e * 10 + d
            i += 1
        exponent = exponent + e if pos_exp else exponent - e
        exponent = max(-(2**31), min(_I32_MAX, exponent))
    if not is_float and exponent == 0:
        if positive:
            return sig
        neg = -sig
        if sig == 0 or neg < -(2**63):
            return -float(sig)
        return neg
    return _serde_f64_from_parts(positive, sig, exponent)


def loads_serde(text: str) -> Any:
    """JSON text read with serde_json's number semantics (for `aicad.ir/0` documents)."""
    try:
        return json.loads(
            text,
            object_pairs_hook=_pairs,
            parse_float=serde_number,
            parse_int=serde_number,
            parse_constant=_parse_constant,
        )
    except json.JSONDecodeError as e:
        raise JsonError(str(e)) from e


# ---------------------------------------------------------------------------------------------
# Numbers
# ---------------------------------------------------------------------------------------------

def _digits_exp(x: float) -> tuple[str, int]:
    """Shortest round-trip digits `d` (no leading/trailing zeros) and `n` with x = 0.d × 10^n."""
    r = repr(abs(x))
    mant, _, e = r.partition("e")
    exp = int(e) if e else 0
    ip, _, fp = mant.partition(".")
    raw = (ip + fp).lstrip("0")
    lead = len(ip + fp) - len((ip + fp).lstrip("0"))
    digits = raw.rstrip("0")
    # value = int(ip+fp) · 10^(exp − len(fp)); the first significant digit sits at
    # position (len(ip) − lead) before the decimal point.
    n = len(ip) - lead + exp
    return digits, n


def fmt_js_number(x: float) -> str:
    """ECMAScript Number::toString (ECMA-262 §6.1.6.1.20); `-0` prints as `0`."""
    if x == 0:
        return "0"
    if x < 0:
        return "-" + fmt_js_number(-x)
    d, n = _digits_exp(x)
    k = len(d)
    if k <= n <= 21:
        return d + "0" * (n - k)
    if 0 < n <= 21:
        return d[:n] + "." + d[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + d
    e = n - 1
    sign = "+" if e >= 0 else "-"
    m = d if k == 1 else d[0] + "." + d[1:]
    return f"{m}e{sign}{abs(e)}"


def fmt_f64_json(x: float) -> str:
    """serde_json 1.0.151 (zmij) formatting of a finite f64."""
    if x == 0:
        return "-0.0" if math.copysign(1.0, x) < 0 else "0.0"
    neg = x < 0
    d, n = _digits_exp(x)
    dec_exp = n - 1  # 10^dec_exp <= |x| < 10^(dec_exp+1)
    k = len(d)
    if -5 <= dec_exp <= 15:
        if dec_exp >= k - 1:
            s = d + "0" * (dec_exp - k + 1) + ".0"
        elif dec_exp >= 0:
            s = d[: dec_exp + 1] + "." + d[dec_exp + 1 :]
        else:
            s = "0." + "0" * (-dec_exp - 1) + d
    else:
        m = d if k == 1 else d[0] + "." + d[1:]
        s = f"{m}e{'+' if dec_exp >= 0 else '-'}{abs(dec_exp)}"
    return ("-" + s) if neg else s


# ---------------------------------------------------------------------------------------------
# Pretty printer (serde_json::to_string_pretty)
# ---------------------------------------------------------------------------------------------

def _str(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def dumps_pretty(v: Any, indent: str = "") -> str:
    if v is True:
        return "true"
    if v is False:
        return "false"
    if v is None:
        return "null"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if not math.isfinite(v):
            raise JsonError("non-finite number")
        return fmt_f64_json(v)
    if isinstance(v, str):
        return _str(v)
    inner = indent + "  "
    if isinstance(v, (list, tuple)):
        if not v:
            return "[]"
        return "[\n" + ",\n".join(inner + dumps_pretty(x, inner) for x in v) + "\n" + indent + "]"
    if isinstance(v, dict):
        if not v:
            return "{}"
        return (
            "{\n"
            + ",\n".join(f"{inner}{_str(k)}: {dumps_pretty(x, inner)}" for k, x in v.items())
            + "\n" + indent + "}"
        )
    raise TypeError(f"not JSON: {type(v).__name__}")


# ---------------------------------------------------------------------------------------------
# Canonical documents
# ---------------------------------------------------------------------------------------------

_META = ["note", "intent", "author", "assumptions", "decision_ids"]
_COMMON = ["type", "id", "name", "v", "suppressed"]
FEATURE_ORDER: dict[str, list[str]] = {
    "sketch": _COMMON + ["plane", "curves", "constraints"] + _META,
    "extrude": _COMMON + ["sketch", "regions", "distance", "direction", "op", "targets"] + _META,
    "revolve": _COMMON + ["sketch", "regions", "axis", "angle", "direction", "op", "targets"] + _META,
    "boolean": _COMMON + ["op", "targets", "tools", "keep_tools"] + _META,
    "hole": _COMMON + ["on", "flip", "at", "size", "fit", "d", "depth", "tip", "cbore", "csink",
                       "insert", "thread", "targets"] + _META,
    "fillet": _COMMON + ["edges", "r", "tangent_chain"] + _META,
    "chamfer": _COMMON + ["edges", "d", "d2", "angle", "side", "tangent_chain"] + _META,
    "shell": _COMMON + ["body", "open", "thickness", "direction"] + _META,
    "draft": _COMMON + ["faces", "neutral", "angle", "pull"] + _META,
    "pattern": _COMMON + ["seed", "layout", "skip", "op", "targets"] + _META,
    "datum_plane": _COMMON + ["mode", "from", "distance", "axis", "angle", "a", "b", "points",
                              "origin", "normal", "x_dir"] + _META,
    "datum_axis": _COMMON + ["mode", "edge", "face", "a", "b", "points", "flip"] + _META,
    "tag": _COMMON + ["target"] + _META,
    "thread": _COMMON + ["face", "standard", "major", "pitch", "length", "offset", "flip", "hand",
                         "starts", "modeled"] + _META,
}
CURVE_ORDER: dict[str, list[str]] = {
    "line": ["kind", "id", "start", "end", "construction"],
    "arc": ["kind", "id", "start", "end", "center", "ccw", "construction"],
    "circle": ["kind", "id", "center", "radius", "construction"],
    "point": ["kind", "id", "at", "construction"],
    "rect": ["kind", "id", "center", "corner", "w", "h", "r", "construction"],
    "slot": ["kind", "id", "a", "b", "w", "construction"],
    "polygon": ["kind", "id", "center", "n", "circumradius", "inradius", "across_flats", "side",
                "rotation", "construction"],
}
CONSTRAINT_ORDER: dict[str, list[str]] = {
    "coincident": ["type", "id", "a", "b"],
    "horizontal": ["type", "id", "line"],
    "vertical": ["type", "id", "line"],
    "parallel": ["type", "id", "a", "b"],
    "perpendicular": ["type", "id", "a", "b"],
    "tangent": ["type", "id", "a", "b", "internal"],
    "equal": ["type", "id", "a", "b"],
    "distance": ["type", "id", "a", "b", "value", "driving"],
    "angle": ["type", "id", "a", "b", "value", "driving"],
    "radius": ["type", "id", "curve", "value", "driving"],
    "diameter": ["type", "id", "curve", "value", "driving"],
    "point_on_line": ["type", "id", "point", "line"],
    "point_on_circle": ["type", "id", "point", "curve"],
    "midpoint": ["type", "id", "point", "line"],
    "symmetric": ["type", "id", "a", "b", "line"],
    "fix": ["type", "id", "entity", "x", "y"],
}
QUERY_ORDER: dict[str, list[str]] = {
    "body": ["op", "feature", "member"],
    "bodies": ["op"],
    "cap": ["op", "feature", "end", "member"],
    "endcap": ["op", "feature", "end", "member"],
    "side": ["op", "feature", "curve"],
    "sides": ["op", "feature", "member"],
    "edge_at": ["op", "feature", "curve", "end"],
    "between": ["op", "a", "b"],
    "hole_face": ["op", "feature", "at", "part"],
    "created": ["op", "feature", "role"],
    "instance": ["op", "feature", "index"],
    "tagged": ["op", "feature"],
    "faces": ["op", "of"],
    "edges": ["op", "of"],
    "vertices": ["op", "of"],
    "owner": ["op", "of"],
    "union": ["op", "of"],
    "intersect": ["op", "of"],
    "minus": ["op", "a", "b"],
    "filter": ["op", "of", "where"],
    "extreme": ["op", "of", "dir", "which"],
    "largest": ["op", "of"],
    "smallest": ["op", "of"],
}


def _ordered(d: dict, order: list[str]) -> dict:
    out = {k: d[k] for k in order if k in d}
    for k, v in d.items():  # unknown keys (never in a valid document) keep their position last
        if k not in out:
            out[k] = v
    return out


def _num(x: Any) -> Any:
    """A Scalar: numbers are f64 in the typed document."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return x
    return float(x)


def _nums(v: Any) -> Any:
    if isinstance(v, list):
        return [_nums(x) for x in v]
    return _num(v)


def _query(q: Any) -> Any:
    if not isinstance(q, dict) or "op" not in q:
        return q
    op = q["op"]
    out = {}
    for k, v in q.items():
        if k in ("of",) and isinstance(v, list):
            out[k] = [_query(x) for x in v]
        elif k in ("of", "a", "b"):
            out[k] = _query(v)
        elif k == "dir":
            out[k] = _dir(v)
        elif k == "where":
            out[k] = _pred(v)
        elif k == "index":
            out[k] = v
        else:
            out[k] = v
    return _ordered(out, QUERY_ORDER.get(op, ["op"]))


def _pred(p: Any) -> Any:
    if not isinstance(p, dict):
        return p
    out = {}
    for k, v in p.items():
        if k in ("normal", "parallel", "perpendicular"):
            out[k] = _dir(v)
        elif k == "radius" and isinstance(v, dict):
            out[k] = _ordered({kk: _num(vv) for kk, vv in v.items()}, ["eq", "min", "max"])
        else:
            out[k] = v
    return out


def _ref(r: Any) -> Any:
    if not isinstance(r, dict):
        return r
    out = dict(r)
    if "q" in out:
        out["q"] = _query(out["q"])
    return _ordered(out, ["kind", "q", "card", "capture"])


def _dir(d: Any) -> Any:
    if isinstance(d, list):
        return _nums(d)
    if isinstance(d, dict):
        return _axis_object(d)
    return d


def _axis_object(o: dict) -> dict:
    out = dict(o)
    if "edge" in out:
        out["edge"] = _ref(out["edge"])
        order = ["edge", "flip"]
    elif "cylinder" in out:
        out["cylinder"] = _ref(out["cylinder"])
        order = ["cylinder", "flip"]
    elif "line" in out:
        out["line"] = _ordered({k: _nums(v) for k, v in out["line"].items()}, ["origin", "direction"])
        order = ["line", "flip"]
    else:
        order = ["datum", "flip"]
    if out.get("flip") is False:
        del out["flip"]
    return _ordered(out, order)


def _plane(p: Any) -> Any:
    if not isinstance(p, dict):
        return p
    if "face" in p:
        out = dict(p)
        out["face"] = _ref(out["face"])
        for k in ("origin", "x_dir"):
            if k in out:
                out[k] = _nums(out[k])
        return _ordered(out, ["face", "origin", "x_dir"])
    if "datum" in p:
        return p
    return _ordered({k: _nums(v) for k, v in p.items()}, ["origin", "normal", "x_dir"])


def _point(p: Any) -> Any:
    if isinstance(p, list):
        return _nums(p)
    if isinstance(p, dict) and "vertex" in p:
        return {"vertex": _ref(p["vertex"])}
    return p


def _curve(c: dict) -> dict:
    out = {}
    for k, v in c.items():
        if k in ("kind", "id", "ccw", "construction"):
            out[k] = v
        else:
            out[k] = _nums(v)
    if out.get("construction") is False:
        del out["construction"]
    kind = out.get("kind")
    if kind in ("rect", "polygon"):
        key = "r" if kind == "rect" else "rotation"
        if key in out and isinstance(out[key], float) and out[key] == 0.0:
            del out[key]
    return _ordered(out, CURVE_ORDER.get(kind, ["kind", "id"]))


def _constraint(c: dict) -> dict:
    out = {}
    for k, v in c.items():
        out[k] = _num(v) if k in ("value", "x", "y") else v
    if out.get("driving") is True:
        del out["driving"]
    return _ordered(out, CONSTRAINT_ORDER.get(out.get("type"), ["type", "id"]))


def _param(p: dict) -> dict:
    out = {}
    for k, v in p.items():
        out[k] = _num(v) if k in ("value", "min", "max") else v
    if out.get("note") == "":
        del out["note"]
    return _ordered(out, ["name", "unit", "value", "min", "max", "note"])


def _feature(f: dict) -> dict:
    t = f.get("type")
    out = {}
    for k, v in f.items():
        if k in ("plane", "on", "neutral", "from", "a", "b") and t != "boolean":
            out[k] = _plane(v)
        elif k in ("targets", "tools") and isinstance(v, dict):
            out[k] = _ref(v)
        elif k in ("target", "edges", "faces", "body", "open", "side", "edge", "face"):
            out[k] = _ref(v) if isinstance(v, dict) else v
        elif k == "curves":
            out[k] = [_curve(c) for c in v]
        elif k == "constraints":
            out[k] = [_constraint(c) for c in v]
        elif k == "axis" and t == "revolve":
            out[k] = _ordered({kk: _nums(vv) for kk, vv in v.items()}, ["origin", "direction"])
        elif k == "axis":
            out[k] = _axis_object(v) if isinstance(v, dict) else v
        elif k == "points":
            out[k] = [_point(p) for p in v]
        elif k in ("distance", "angle", "r", "d", "d2", "thickness"):
            out[k] = _num(v)
        elif k in ("origin", "normal", "x_dir"):
            out[k] = _nums(v)
        else:
            out[k] = v
    for k, default in (("v", 1), ("suppressed", False), ("direction", "normal"), ("op", "new_body"),
                       ("regions", "all"), ("constraints", []), ("note", ""), ("intent", ""),
                       ("author", ""), ("assumptions", []), ("decision_ids", []), ("flip", False)):
        if k in out and out[k] == default and type(out[k]) is type(default):
            del out[k]
    if t in ("extrude", "revolve") and isinstance(out.get("targets"), dict):
        if out["targets"].get("card") == "some":
            del out["targets"]["card"]
    if t in ("sketch",) and isinstance(out.get("plane"), dict) and "face" in out["plane"]:
        if out["plane"]["face"].get("card") in ("one",):
            del out["plane"]["face"]["card"]
    if t == "tag" and isinstance(out.get("target"), dict) and out["target"].get("card") == "some":
        del out["target"]["card"]
    return _ordered(out, FEATURE_ORDER.get(t, _COMMON))


def canonical_document(doc: dict) -> dict:
    """Reorder keys, coerce Scalars to f64 and omit the defaults of the surfaces the oracle
    writes (migration, generator). Expression strings are left as they are."""
    out: dict = {"schema": doc["schema"]}
    meta = doc.get("meta") or {}
    meta = _ordered({k: v for k, v in meta.items() if v != ""}, ["name", "description"])
    if meta:
        out["meta"] = meta
    units = doc.get("units")
    if units and units != {"length": "mm", "angle": "deg"}:
        out["units"] = _ordered(units, ["length", "angle"])
    if doc.get("params"):
        out["params"] = [_param(p) for p in doc["params"]]
    parts = []
    for p in doc.get("parts", []):
        q = {"id": p["id"], "name": p["name"]}
        if p.get("params"):
            q["params"] = [_param(x) for x in p["params"]]
        q["features"] = [_feature(f) for f in p.get("features", [])]
        parts.append(q)
    out["parts"] = parts
    return out


def dumps_canonical(doc: dict) -> str:
    """`forge_ir::v1::to_json` of a document the oracle wrote (no trailing newline)."""
    return dumps_pretty(canonical_document(doc))
