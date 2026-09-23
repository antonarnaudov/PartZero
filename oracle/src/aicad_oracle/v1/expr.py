"""IR v1 expressions (SPEC-v1 §2.3–§2.7): lexer, parser, canonical printer, type checker and
evaluator — an independent Python implementation written from the SPEC text (not from Forge).

* Grammar §2.3 with the [W0-15] resolutions: whitespace is space and tab only; a unit is
  recognised only directly after a number (optional whitespace between); `sin (30)` is a call;
  a literal that rounds to ±∞ is `EXPR_SYNTAX`; comparisons are non-associative.
* Canonical form §2.4: minimal parentheses, ECMAScript number text, `-(a ^ 2)` / `!(a ^ 2)`.
* Types §2.5: Bool, Real(L, A), Flex; use-site check against the field type.
* Evaluation §2.7: IEEE binary64; binary exponentiation for integer |b| ≤ 64; the exact degree
  trigonometry of rule 4 ([W0-5]: a tiny negative angle reduces to 0, not 360); the exact inverse
  table of rule 5; short-circuit `?:`, `&&`, `||`; NaN/∞/÷0 → `EXPR_DOMAIN`; every `-0` → `+0`.

**Nesting depth** (`MAX_EXPR_DEPTH` = 64, §2.3) is not defined further by the SPEC. This
implementation counts one level per parenthesised group, call argument list, `?:` branch, unary
operand and `^` exponent (the right-recursive constructs); a left-associative chain `a + b + c`
does not nest. See the W7a report.
"""

from __future__ import annotations

import math
import sys
from dataclasses import dataclass, field
from typing import Union

from .consts import MAX_COUNT_MAGNITUDE, MAX_EXPR_BYTES, MAX_EXPR_DEPTH
from .jsonio import fmt_js_number

# Deeply left-nested chains (4096 bytes allow ~2000 operators) recurse in the printer, the type
# checker and the evaluator.
sys.setrecursionlimit(max(sys.getrecursionlimit(), 20000))

#: π rounded to the nearest f64.
PI = math.pi
#: 180/π rounded to the nearest f64 (§2.7 rule 5).
RAD_TO_DEG = 57.29577951308232
#: π/180 rounded to the nearest f64 (§2.7 rule 4).
DEG_TO_RAD = 0.017453292519943295

UNITS = {"mm": 1.0, "cm": 10.0, "in": 25.4, "deg": 1.0}
#: name → (min arity, max arity or None).
FUNCTIONS: dict[str, tuple[int, int | None]] = {
    "min": (2, None), "max": (2, None), "abs": (1, 1), "sqrt": (1, 1), "floor": (1, 1),
    "ceil": (1, 1), "round": (1, 1), "clamp": (3, 3), "hypot": (2, 2), "sin": (1, 1),
    "cos": (1, 1), "tan": (1, 1), "asin": (1, 1), "acos": (1, 1), "atan": (1, 1),
    "atan2": (2, 2),
}
FIELD_TYPES = ("length", "angle", "ratio", "count", "bool")
UNIT_FIELD = {"mm": "length", "deg": "angle", "ratio": "ratio", "count": "count", "bool": "bool"}


class ExprError(Exception):
    """A coded expression error: `code` from the catalogue, `stage` `R` (rejected) or `E`."""

    def __init__(self, code: str, message: str, details: dict | None = None, stage: str = "R"):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.details = details or {}
        self.stage = stage


# ---------------------------------------------------------------------------------------------
# AST
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Num:
    value: float
    unit: str | None = None
    offset: int = field(default=0, compare=False)


@dataclass(frozen=True)
class BoolLit:
    value: bool
    offset: int = field(default=0, compare=False)


@dataclass(frozen=True)
class Name:
    name: str
    offset: int = field(default=0, compare=False)


@dataclass(frozen=True)
class Unary:
    op: str  # "-" or "!"
    operand: "Node"
    offset: int = field(default=0, compare=False)


@dataclass(frozen=True)
class Binary:
    op: str  # + - * / % ^ < <= > >= == != && ||
    left: "Node"
    right: "Node"
    offset: int = field(default=0, compare=False)


@dataclass(frozen=True)
class Cond:
    cond: "Node"
    then: "Node"
    other: "Node"
    offset: int = field(default=0, compare=False)


@dataclass(frozen=True)
class Call:
    name: str
    args: tuple
    offset: int = field(default=0, compare=False)


Node = Union[Num, BoolLit, Name, Unary, Binary, Cond, Call]

CMP_OPS = ("<", "<=", ">", ">=", "==", "!=")


# ---------------------------------------------------------------------------------------------
# Lexer
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Tok:
    kind: str  # "num", "ident", "op", "eof"
    text: str
    offset: int
    value: float = 0.0
    unit: str | None = None


_TWO = ("&&", "||", "<=", ">=", "==", "!=")
_ONE = set("+-*/%^!<>?:,()")


def _syntax(text: str, offset: int, expected: str) -> ExprError:
    return ExprError(
        "EXPR_SYNTAX",
        f"syntax error at offset {offset}: expected {expected}",
        {"expr": text, "offset": offset, "expected": expected},
    )


def _is_digit(c: str) -> bool:
    return "0" <= c <= "9"


def _is_ident_start(c: str) -> bool:
    return c == "_" or ("a" <= c <= "z") or ("A" <= c <= "Z")


def _is_ident_char(c: str) -> bool:
    return _is_ident_start(c) or _is_digit(c)


def lex(text: str) -> list[Tok]:
    toks: list[Tok] = []
    i, n = 0, len(text)

    def skip_ws(j: int) -> int:
        while j < n and text[j] in " \t":
            j += 1
        return j

    while True:
        i = skip_ws(i)
        if i >= n:
            toks.append(Tok("eof", "", i))
            return toks
        c = text[i]
        if _is_digit(c):
            s = i
            while i < n and _is_digit(text[i]):
                i += 1
            if i < n and text[i] == ".":
                i += 1
                if not (i < n and _is_digit(text[i])):
                    raise _syntax(text, i, "a digit after '.'")
                while i < n and _is_digit(text[i]):
                    i += 1
            if i < n and text[i] in "eE":
                j = i + 1
                if j < n and text[j] in "+-":
                    j += 1
                if not (j < n and _is_digit(text[j])):
                    raise _syntax(text, j, "exponent digits")
                i = j
                while i < n and _is_digit(text[i]):
                    i += 1
            lit = text[s:i]
            v = float(lit)
            if not math.isfinite(v):
                raise _syntax(text, s, "a finite number")
            unit = None
            j = skip_ws(i)
            if j < n and _is_ident_start(text[j]):
                k = j
                while k < n and _is_ident_char(text[k]):
                    k += 1
                if text[j:k] in UNITS:
                    unit = text[j:k]
                    i = k
            toks.append(Tok("num", lit, s, v, unit))
            continue
        if _is_ident_start(c):
            s = i
            while i < n and _is_ident_char(text[i]):
                i += 1
            toks.append(Tok("ident", text[s:i], s))
            continue
        two = text[i : i + 2]
        if two in _TWO:
            toks.append(Tok("op", two, i))
            i += 2
            continue
        if c in _ONE:
            toks.append(Tok("op", c, i))
            i += 1
            continue
        raise _syntax(text, i, "a number, name, operator or parenthesis")


# ---------------------------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------------------------

class _Parser:
    def __init__(self, text: str):
        self.text = text
        self.toks = lex(text)
        self.i = 0

    def peek(self) -> Tok:
        return self.toks[self.i]

    def next(self) -> Tok:
        t = self.toks[self.i]
        self.i += 1
        return t

    def is_op(self, *ops: str) -> bool:
        t = self.peek()
        return t.kind == "op" and t.text in ops

    def expect(self, op: str) -> Tok:
        t = self.peek()
        if t.kind == "op" and t.text == op:
            return self.next()
        raise _syntax(self.text, t.offset, repr(op))

    def deeper(self, depth: int) -> int:
        if depth + 1 > MAX_EXPR_DEPTH:
            raise ExprError(
                "EXPR_SYNTAX",
                f"expression nested deeper than {MAX_EXPR_DEPTH} levels",
                {"expr": self.text, "offset": self.peek().offset,
                 "expected": f"at most {MAX_EXPR_DEPTH} nesting levels"},
            )
        return depth + 1

    def parse(self) -> Node:
        node = self.expr(0)
        t = self.peek()
        if t.kind != "eof":
            raise _syntax(self.text, t.offset, "an operator or the end of the expression")
        return node

    def expr(self, depth: int) -> Node:
        c = self.or_expr(depth)
        if self.is_op("?"):
            t = self.next()
            a = self.expr(self.deeper(depth))
            self.expect(":")
            b = self.expr(self.deeper(depth))
            return Cond(c, a, b, t.offset)
        return c

    def or_expr(self, depth: int) -> Node:
        left = self.and_expr(depth)
        while self.is_op("||"):
            t = self.next()
            left = Binary("||", left, self.and_expr(depth), t.offset)
        return left

    def and_expr(self, depth: int) -> Node:
        left = self.cmp_expr(depth)
        while self.is_op("&&"):
            t = self.next()
            left = Binary("&&", left, self.cmp_expr(depth), t.offset)
        return left

    def cmp_expr(self, depth: int) -> Node:
        left = self.add_expr(depth)
        if self.is_op(*CMP_OPS):
            t = self.next()
            left = Binary(t.text, left, self.add_expr(depth), t.offset)
            if self.is_op(*CMP_OPS):
                raise _syntax(self.text, self.peek().offset,
                              "no second comparison (comparisons are not associative)")
        return left

    def add_expr(self, depth: int) -> Node:
        left = self.mul_expr(depth)
        while self.is_op("+", "-"):
            t = self.next()
            left = Binary(t.text, left, self.mul_expr(depth), t.offset)
        return left

    def mul_expr(self, depth: int) -> Node:
        left = self.unary(depth)
        while self.is_op("*", "/", "%"):
            t = self.next()
            left = Binary(t.text, left, self.unary(depth), t.offset)
        return left

    def unary(self, depth: int) -> Node:
        if self.is_op("-", "!"):
            t = self.next()
            return Unary(t.text, self.unary(self.deeper(depth)), t.offset)
        return self.power(depth)

    def power(self, depth: int) -> Node:
        base = self.atom(depth)
        if self.is_op("^"):
            t = self.next()
            return Binary("^", base, self.unary(self.deeper(depth)), t.offset)
        return base

    def atom(self, depth: int) -> Node:
        t = self.peek()
        if t.kind == "num":
            self.next()
            return Num(t.value, t.unit, t.offset)
        if t.kind == "ident":
            self.next()
            if t.text in ("true", "false"):
                return BoolLit(t.text == "true", t.offset)
            if self.is_op("("):
                self.next()
                d = self.deeper(depth)
                args: list[Node] = []
                if not self.is_op(")"):
                    args.append(self.expr(d))
                    while self.is_op(","):
                        self.next()
                        args.append(self.expr(d))
                self.expect(")")
                return Call(t.text, tuple(args), t.offset)
            return Name(t.text, t.offset)
        if t.kind == "op" and t.text == "(":
            self.next()
            e = self.expr(self.deeper(depth))
            self.expect(")")
            return e
        raise _syntax(self.text, t.offset, "a number, name, call or '('")


def parse(text: str) -> Node:
    """Parse an expression (§2.3). Raises ExprError(EXPR_SYNTAX)."""
    if len(text.encode("utf-8")) > MAX_EXPR_BYTES:
        raise ExprError("EXPR_SYNTAX", f"expression longer than {MAX_EXPR_BYTES} bytes",
                        {"offset": MAX_EXPR_BYTES, "expected": f"at most {MAX_EXPR_BYTES} bytes"})
    if text.strip(" \t") == "":
        raise ExprError("EXPR_SYNTAX", "empty expression",
                        {"offset": 0, "expected": "an expression", "length": len(text)})
    return _Parser(text).parse()


# ---------------------------------------------------------------------------------------------
# Canonical printer (§2.4)
# ---------------------------------------------------------------------------------------------

_PREC_BIN = {"||": 1, "&&": 2, "+": 4, "-": 4, "*": 5, "/": 5, "%": 5, "^": 7,
             **{op: 3 for op in CMP_OPS}}


def _prec(n: Node) -> int:
    if isinstance(n, Cond):
        return 0
    if isinstance(n, Binary):
        return _PREC_BIN[n.op]
    if isinstance(n, Unary):
        return 6
    return 8


def _fmt(n: Node, min_prec: int) -> str:
    s = _raw(n)
    return f"({s})" if _prec(n) < min_prec else s


def _raw(n: Node) -> str:
    if isinstance(n, Num):
        s = fmt_js_number(n.value)
        return f"{s} {n.unit}" if n.unit else s
    if isinstance(n, BoolLit):
        return "true" if n.value else "false"
    if isinstance(n, Name):
        return n.name
    if isinstance(n, Call):
        return f"{n.name}({', '.join(_fmt(a, 0) for a in n.args)})"
    if isinstance(n, Unary):
        o = n.operand
        inner = f"({_raw(o)})" if isinstance(o, Binary) and o.op == "^" else _fmt(o, 6)
        return n.op + inner
    if isinstance(n, Cond):
        return f"{_fmt(n.cond, 1)} ? {_fmt(n.then, 0)} : {_fmt(n.other, 0)}"
    assert isinstance(n, Binary)
    op = n.op
    if op == "^":
        return f"{_fmt(n.left, 8)} ^ {_fmt(n.right, 6)}"
    if op == "||":
        return f"{_fmt(n.left, 1)} || {_fmt(n.right, 2)}"
    if op == "&&":
        return f"{_fmt(n.left, 2)} && {_fmt(n.right, 3)}"
    if op in CMP_OPS:
        return f"{_fmt(n.left, 4)} {op} {_fmt(n.right, 4)}"
    if op in ("+", "-"):
        return f"{_fmt(n.left, 4)} {op} {_fmt(n.right, 5)}"
    return f"{_fmt(n.left, 5)} {op} {_fmt(n.right, 6)}"


def canonical(n: Node) -> str:
    return _fmt(n, 0)


def canonicalize(text: str) -> str:
    return canonical(parse(text))


# ---------------------------------------------------------------------------------------------
# Types (§2.5)
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Ty:
    kind: str  # "bool", "flex", "real"
    L: int = 0
    A: int = 0

    def __str__(self) -> str:
        if self.kind != "real":
            return self.kind
        parts = []
        for sym, e in (("mm", self.L), ("deg", self.A)):
            if e == 1:
                parts.append(sym)
            elif e != 0:
                parts.append(f"{sym}^{e}")
        return "*".join(parts) if parts else "1"

    @property
    def dimless(self) -> bool:
        return self.kind == "real" and self.L == 0 and self.A == 0


BOOL = Ty("bool")
FLEX = Ty("flex")
LENGTH = Ty("real", 1, 0)
ANGLE = Ty("real", 0, 1)
ONE = Ty("real", 0, 0)
FIELD_TY = {"length": LENGTH, "angle": ANGLE, "ratio": ONE, "count": ONE}
UNIT_TY = {"mm": LENGTH, "deg": ANGLE, "ratio": ONE, "count": ONE, "bool": BOOL}


class _Checker:
    """Name resolution (pass 1) and typing (pass 2) of one expression site."""

    def __init__(self, text: str, types: dict[str, Ty], *, other_parts: dict[str, str] | None,
                 features: set[str] | frozenset[str]):
        self.text = text
        self.types = types
        self.other_parts = other_parts or {}
        self.features = features
        self.used: list[str] = []

    # -- pass 1: names, functions, arity ------------------------------------------------------
    def names(self, n: Node) -> None:
        if isinstance(n, Name):
            if n.name == "PI":
                return
            if n.name in self.types:
                if n.name not in self.used:
                    self.used.append(n.name)
                return
            if n.name in self.other_parts:
                raise ExprError(
                    "EXPR_SCOPE",
                    f"{n.name!r} is a parameter of part {self.other_parts[n.name]!r}",
                    {"name": n.name, "part": self.other_parts[n.name]},
                )
            similar = sorted(k for k in self.types if _similar(k, n.name))[:5]
            raise ExprError(
                "EXPR_UNKNOWN_NAME",
                f"{n.name!r} is not a visible parameter",
                {"name": n.name, "is_feature": n.name in self.features, "similar": similar},
            )
        if isinstance(n, Call):
            if n.name not in FUNCTIONS:
                similar = sorted(k for k in FUNCTIONS if _similar(k, n.name))[:5]
                raise ExprError("EXPR_UNKNOWN_FUNCTION", f"unknown function {n.name!r}",
                                {"name": n.name, "similar": similar})
            lo, hi = FUNCTIONS[n.name]
            k = len(n.args)
            if k < lo or (hi is not None and k > hi):
                exp = f">= {lo}" if hi is None else str(lo)
                raise ExprError("EXPR_ARITY", f"{n.name} takes {exp} arguments, got {k}",
                                {"name": n.name, "expected": exp, "found": k})
            for a in n.args:
                self.names(a)
            return
        if isinstance(n, Unary):
            self.names(n.operand)
        elif isinstance(n, Binary):
            self.names(n.left)
            self.names(n.right)
        elif isinstance(n, Cond):
            self.names(n.cond)
            self.names(n.then)
            self.names(n.other)

    # -- pass 2: types --------------------------------------------------------------------------
    def unit_err(self, sub: Node, expected: str, found: str) -> ExprError:
        return ExprError(
            "EXPR_UNIT_MISMATCH",
            f"{canonical(sub)}: expected {expected}, found {found}",
            {"expr": self.text, "subexpr": canonical(sub), "expected": expected, "found": found},
        )

    def type_err(self, sub: Node, expected: str, found: str) -> ExprError:
        return ExprError(
            "EXPR_TYPE_MISMATCH",
            f"{canonical(sub)}: expected {expected}, found {found}",
            {"expr": self.text, "subexpr": canonical(sub), "expected": expected, "found": found},
        )

    def num(self, n: Node) -> Ty:
        t = self.ty(n)
        if t.kind == "bool":
            raise self.type_err(n, "number", "bool")
        return t

    def boolean(self, n: Node) -> None:
        t = self.ty(n)
        if t.kind != "bool":
            raise self.type_err(n, "bool", str(t))

    def unify(self, whole: Node, ts: list[Ty]) -> Ty:
        fixed = None
        for t in ts:
            if t.kind == "flex":
                continue
            if fixed is None:
                fixed = t
            elif t != fixed:
                raise self.unit_err(whole, str(fixed), str(t))
        return fixed or FLEX

    def ty(self, n: Node) -> Ty:
        if isinstance(n, Num):
            if n.unit is None:
                return FLEX
            return ANGLE if n.unit == "deg" else LENGTH
        if isinstance(n, BoolLit):
            return BOOL
        if isinstance(n, Name):
            return FLEX if n.name == "PI" else self.types[n.name]
        if isinstance(n, Unary):
            if n.op == "!":
                self.boolean(n.operand)
                return BOOL
            return self.num(n.operand)
        if isinstance(n, Cond):
            self.boolean(n.cond)
            a, b = self.ty(n.then), self.ty(n.other)
            if (a.kind == "bool") != (b.kind == "bool"):
                raise self.type_err(n, str(a), str(b))
            return BOOL if a.kind == "bool" else self.unify(n, [a, b])
        if isinstance(n, Call):
            return self.call(n)
        assert isinstance(n, Binary)
        op = n.op
        if op in ("&&", "||"):
            self.boolean(n.left)
            self.boolean(n.right)
            return BOOL
        if op in ("==", "!="):
            a, b = self.ty(n.left), self.ty(n.right)
            if (a.kind == "bool") != (b.kind == "bool"):
                raise self.type_err(n, str(a), str(b))
            if a.kind != "bool":
                self.unify(n, [a, b])
            return BOOL
        if op in ("<", "<=", ">", ">="):
            self.unify(n, [self.num(n.left), self.num(n.right)])
            return BOOL
        if op in ("+", "-", "%"):
            return self.unify(n, [self.num(n.left), self.num(n.right)])
        if op == "*":
            a, b = self.num(n.left), self.num(n.right)
            if a.kind == "flex" and b.kind == "flex":
                return FLEX
            if a.kind == "flex":
                return FLEX if b.dimless else b
            if b.kind == "flex":
                return FLEX if a.dimless else a
            return Ty("real", a.L + b.L, a.A + b.A)
        if op == "/":
            a, b = self.num(n.left), self.num(n.right)
            if a.kind == "flex" and b.kind == "flex":
                return FLEX
            if a.kind == "flex":
                return FLEX if b.dimless else Ty("real", -b.L, -b.A)
            if b.kind == "flex":
                return FLEX if a.dimless else a
            return Ty("real", a.L - b.L, a.A - b.A)
        assert op == "^"
        a, b = self.num(n.left), self.num(n.right)
        if a.kind == "flex" or a.dimless:
            if not (b.kind == "flex" or b.dimless):
                raise self.unit_err(n, "a dimensionless exponent", str(b))
            return a
        k = _int_literal(n.right)
        if k is None:
            raise self.unit_err(n, "an integer literal exponent", canonical(n.right))
        return Ty("real", a.L * k, a.A * k)

    def call(self, n: Call) -> Ty:
        f = n.name
        if f in ("min", "max", "clamp", "hypot"):
            return self.unify(n, [self.num(a) for a in n.args])
        if f in ("abs", "floor", "ceil", "round"):
            return self.num(n.args[0])
        if f == "sqrt":
            t = self.num(n.args[0])
            if t.kind == "flex":
                return FLEX
            if t.L % 2 or t.A % 2:
                raise self.unit_err(n, "even exponents", str(t))
            return Ty("real", t.L // 2, t.A // 2)
        if f in ("sin", "cos", "tan"):
            t = self.num(n.args[0])
            if t.kind == "flex":
                return FLEX
            if t != ANGLE:
                raise self.unit_err(n, "deg", str(t))
            return ONE
        if f in ("asin", "acos", "atan"):
            t = self.num(n.args[0])
            if not (t.kind == "flex" or t.dimless):
                raise self.unit_err(n, "1", str(t))
            return ANGLE
        assert f == "atan2"
        self.unify(n, [self.num(a) for a in n.args])
        return ANGLE


def _int_literal(n: Node) -> int | None:
    """An integer literal, optionally negated (parentheses are not AST nodes)."""
    neg = False
    if isinstance(n, Unary) and n.op == "-":
        neg, n = True, n.operand
    if isinstance(n, Num) and n.unit is None and math.isfinite(n.value) and n.value == math.floor(n.value):
        k = int(n.value)
        return -k if neg else k
    return None


def _similar(candidate: str, wanted: str) -> bool:
    common = 0
    for a, b in zip(candidate, wanted):
        if a != b:
            break
        common += 1
    return common >= max(1, min(3, len(wanted))) and candidate != wanted


def use_site(ty: Ty, fld: str, node: Node, text: str) -> None:
    """The use-site check of §2.5 against a field type (`length`, `angle`, `ratio`, `count`,
    `bool`)."""
    if fld == "bool":
        if ty.kind != "bool":
            raise ExprError("EXPR_TYPE_MISMATCH", f"expected bool, found {ty}",
                            {"expr": text, "subexpr": canonical(node), "expected": "bool", "found": str(ty)})
        return
    want = FIELD_TY[fld]
    if ty.kind == "bool":
        raise ExprError("EXPR_TYPE_MISMATCH", f"expected {want}, found bool",
                        {"expr": text, "subexpr": canonical(node), "expected": str(want), "found": "bool"})
    if ty.kind == "flex":
        return
    if ty != want:
        raise ExprError("EXPR_UNIT_MISMATCH", f"expected {want}, found {ty}",
                        {"expr": text, "subexpr": canonical(node), "expected": str(want), "found": str(ty)})


@dataclass
class Checked:
    """A statically valid expression: its AST, canonical text, static type, used names."""

    ast: Node
    canonical: str
    ty: Ty
    uses: list[str]


def check(text: str, fld: str, types: dict[str, Ty], *, other_parts: dict[str, str] | None = None,
          features: set[str] | frozenset[str] = frozenset()) -> Checked:
    """Parse, resolve and type one expression site. `types` maps the visible parameter names to
    their types; `other_parts` maps parameters of other parts to their part (`EXPR_SCOPE`);
    `features` are feature names (for the `is_feature` detail). Raises ExprError (stage R)."""
    ast = parse(text)
    c = _Checker(text, types, other_parts=other_parts, features=features)
    c.names(ast)
    t = c.ty(ast)
    use_site(t, fld, ast, text)
    return Checked(ast, canonical(ast), t, c.used)


# ---------------------------------------------------------------------------------------------
# Evaluation (§2.7)
# ---------------------------------------------------------------------------------------------

def _z(v: float) -> float:
    """§2.7 rule 8: -0 → +0."""
    return 0.0 if v == 0.0 else v


_TABLE = {0.0: (0.0, 1.0), 30.0: (0.5, 0.8660254037844386),
          45.0: (0.7071067811865476, 0.7071067811865476), 60.0: (0.8660254037844386, 0.5)}


def sin_cos_deg(x: float) -> tuple[float, float] | None:
    """(sin x, cos x) for x in degrees, §2.7 rule 4; None for a non-finite x."""
    if not math.isfinite(x):
        return None
    r = math.fmod(x, 360.0)  # exact
    if r < 0.0:
        r += 360.0
    if r >= 360.0:  # [W0-5] a tiny negative x rounds up to 360: the same angle as 0
        r = 0.0
    q = 3 if r >= 270.0 else 2 if r >= 180.0 else 1 if r >= 90.0 else 0
    s = r - 90.0 * q  # exact (Sterbenz)
    if s in _TABLE:
        ss, cs = _TABLE[s]
    else:
        rad = s * DEG_TO_RAD
        ss, cs = math.sin(rad), math.cos(rad)
    sn, cn = ((ss, cs), (cs, -ss), (-ss, -cs), (-cs, ss))[q]
    return _z(sn), _z(cn)


def tan_deg(x: float) -> float | None:
    sc = sin_cos_deg(x)
    if sc is None or sc[1] == 0.0:
        return None
    return _z(sc[0] / sc[1])


def _asin_deg(x: float) -> float:
    exact = {0.0: 0.0, 0.5: 30.0, -0.5: -30.0, 1.0: 90.0, -1.0: -90.0}
    return exact[x] if x in exact else math.asin(x) * RAD_TO_DEG


def _acos_deg(x: float) -> float:
    exact = {1.0: 0.0, 0.5: 60.0, 0.0: 90.0, -0.5: 120.0, -1.0: 180.0}
    return exact[x] if x in exact else math.acos(x) * RAD_TO_DEG


def _atan_deg(x: float) -> float:
    exact = {0.0: 0.0, 1.0: 45.0, -1.0: -45.0}
    return exact[x] if x in exact else math.atan(x) * RAD_TO_DEG


def _atan2_deg(y: float, x: float) -> float | None:
    if y == 0.0 and x == 0.0:
        return None
    if y == 0.0:
        return 0.0 if x > 0.0 else 180.0
    if x == 0.0:
        return 90.0 if y > 0.0 else -90.0
    if abs(y) == abs(x):
        if x > 0.0:
            return 45.0 if y > 0.0 else -45.0
        return 135.0 if y > 0.0 else -135.0
    return math.atan2(y, x) * RAD_TO_DEG


def _round_half_away(x: float) -> float:
    r = math.floor(x)
    diff = x - r  # exact: the fractional part is representable
    if diff > 0.5 or (diff == 0.5 and x > 0.0):
        r += 1
    return float(r)


def ipow(a: float, n: int) -> float:
    """Binary exponentiation of §2.7 rule 3 (n ≥ 0), multiplication order as written."""
    r = 1.0
    p = a
    while True:
        if n & 1:
            r = r * p
        n >>= 1
        if n == 0:
            break
        p = p * p
    return r


class _Eval:
    def __init__(self, text: str, env: dict[str, float | bool]):
        self.text = text
        self.env = env

    def domain(self, n: Node, operands: list, why: str) -> ExprError:
        return ExprError(
            "EXPR_DOMAIN",
            f"{canonical(n)}: {why}",
            {"expr": self.text, "subexpr": canonical(n), "operands": [_jsonable(o) for o in operands]},
            stage="E",
        )

    def fin(self, n: Node, v: float, operands: list) -> float:
        if not math.isfinite(v):
            raise self.domain(n, operands, "the result is not finite")
        return _z(v)

    def ev(self, n: Node):
        if isinstance(n, Num):
            v = n.value * UNITS[n.unit] if n.unit else n.value
            return self.fin(n, v, [n.value])
        if isinstance(n, BoolLit):
            return n.value
        if isinstance(n, Name):
            if n.name == "PI":
                return PI
            v = self.env[n.name]
            return v if isinstance(v, bool) else _z(v)
        if isinstance(n, Unary):
            v = self.ev(n.operand)
            return (not v) if n.op == "!" else _z(-v)
        if isinstance(n, Cond):
            return self.ev(n.then) if self.ev(n.cond) else self.ev(n.other)
        if isinstance(n, Call):
            return self.call(n)
        op = n.op
        if op == "&&":
            return bool(self.ev(n.left)) and bool(self.ev(n.right))
        if op == "||":
            return bool(self.ev(n.left)) or bool(self.ev(n.right))
        a, b = self.ev(n.left), self.ev(n.right)
        if op == "==":
            return a == b
        if op == "!=":
            return a != b
        if op == "<":
            return a < b
        if op == "<=":
            return a <= b
        if op == ">":
            return a > b
        if op == ">=":
            return a >= b
        if op == "+":
            return self.fin(n, a + b, [a, b])
        if op == "-":
            return self.fin(n, a - b, [a, b])
        if op == "*":
            return self.fin(n, a * b, [a, b])
        if op == "/":
            if b == 0.0:
                raise self.domain(n, [a, b], "division by zero")
            return self.fin(n, a / b, [a, b])
        if op == "%":
            if b == 0.0:
                raise self.domain(n, [a, b], "remainder by zero")
            return self.fin(n, math.fmod(a, b), [a, b])
        assert op == "^"
        return self.power(n, a, b)

    def power(self, n: Node, a: float, b: float) -> float:
        if b == math.floor(b) and abs(b) <= 64.0:
            k = int(abs(b))
            r = ipow(a, k)
            if b < 0.0:
                if r == 0.0:
                    raise self.domain(n, [a, b], "zero to a negative power")
                r = 1.0 / r
            return self.fin(n, r, [a, b])
        if a < 0.0 and b != math.floor(b):
            raise self.domain(n, [a, b], "a negative base with a non-integer exponent")
        if a == 0.0 and b < 0.0:
            raise self.domain(n, [a, b], "zero to a negative power")
        try:
            r = math.pow(a, b)
        except (OverflowError, ValueError):
            raise self.domain(n, [a, b], "the result is not finite") from None
        return self.fin(n, r, [a, b])

    def call(self, n: Call):
        f = n.name
        args = [self.ev(a) for a in n.args]
        if f == "min":
            r = args[0]
            for x in args[1:]:
                if x < r:
                    r = x
            return _z(r)
        if f == "max":
            r = args[0]
            for x in args[1:]:
                if x > r:
                    r = x
            return _z(r)
        if f == "clamp":
            x, lo, hi = args
            if lo > hi:
                raise self.domain(n, args, "clamp with lo > hi")
            m = lo if lo > x else x
            return _z(hi if hi < m else m)
        (x, *rest) = args
        if f == "abs":
            return _z(abs(x))
        if f == "sqrt":
            if x < 0.0:
                raise self.domain(n, args, "square root of a negative number")
            return _z(math.sqrt(x))
        if f == "floor":
            return _z(float(math.floor(x)))
        if f == "ceil":
            return _z(float(math.ceil(x)))
        if f == "round":
            return _z(_round_half_away(x))
        if f == "hypot":
            return self.fin(n, math.hypot(x, rest[0]), args)
        if f in ("sin", "cos"):
            sc = sin_cos_deg(x)
            if sc is None:
                raise self.domain(n, args, "not finite")
            return sc[0] if f == "sin" else sc[1]
        if f == "tan":
            t = tan_deg(x)
            if t is None:
                raise self.domain(n, args, "tangent of an odd multiple of 90 degrees")
            return self.fin(n, t, args)
        if f in ("asin", "acos"):
            if abs(x) > 1.0:
                raise self.domain(n, args, f"{f} of a value outside [-1, 1]")
            return _z(_asin_deg(x) if f == "asin" else _acos_deg(x))
        if f == "atan":
            return _z(_atan_deg(x))
        assert f == "atan2"
        r = _atan2_deg(x, rest[0])
        if r is None:
            raise self.domain(n, args, "atan2(0, 0)")
        return self.fin(n, r, args)


def _jsonable(v):
    return v if isinstance(v, (bool, int, float)) else str(v)


def is_count(v: float) -> bool:
    return math.isfinite(v) and v == math.floor(v) and abs(v) <= MAX_COUNT_MAGNITUDE


def evaluate(node: Node, env: dict[str, float | bool], *, text: str = "", fld: str | None = None):
    """Evaluate a checked AST. With `fld="count"` the result must be an exact integer with
    |v| ≤ 2^31 (`EXPR_NOT_INTEGER`, §2.7 rule 9). Raises ExprError (stage E)."""
    v = _Eval(text or canonical(node), env).ev(node)
    if fld == "count" and not is_count(v):
        raise ExprError("EXPR_NOT_INTEGER", f"a count must be an exact integer with |v| <= 2^31, got {v!r}",
                        {"expr": text or canonical(node), "value": v}, stage="E")
    return v
