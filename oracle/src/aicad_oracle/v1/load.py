"""The rejection pipeline of SPEC-v1 §0.5 rule 4 ([W0-1]), for documents of either version:

1. JSON text → value (correctly rounded numbers, duplicate keys rejected);
2. dispatch on `schema`: `aicad.ir/0` → the v0 schema and v0 validation (the oracle's existing
   port of `validate.rs`: same codes and paths), then `migrate_v0_to_v1`; `aicad.ir/1` → the steps
   below; anything else → `UNSUPPORTED_SCHEMA` at `/schema`;
3. raw pre-checks (`precheck.py`);
4. typed parse = `ir-v1.schema.json` (unknown fields, wrong JSON types: a parse error, no code);
5. structural validation (`validate.py`), then the expression checks.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .. import ir as ir0
from . import consts
from .consts import IR_SCHEMA, IR_SCHEMA_V0
from .jsonio import JsonError, loads_serde, loads_strict
from .migrate import migrate_v0_to_v1
from .precheck import Problem, precheck
from .validate import validate


class Rejected(Exception):
    """The document is rejected (CLI exit 2). `problems` is empty for a parse error."""

    def __init__(self, problems: list[Problem], parse: str | None = None, parse_code: str = "IR_PARSE_ERROR"):
        self.problems = problems
        self.parse = parse
        self.parse_code = parse_code  # IR_PARSE_ERROR (JSON, null) or IR_SCHEMA_INVALID (typed parse)
        first = f"{problems[0].code} at {problems[0].path}" if problems else f"parse error: {parse}"
        super().__init__(first)

    @property
    def code(self) -> str:
        return self.problems[0].code if self.problems else self.parse_code

    @property
    def message(self) -> str:
        if not self.problems:
            return self.parse or "parse error"
        return "; ".join(f"{p.code} at {p.path}: {p.message}" for p in self.problems[:10])


@dataclass
class Loaded:
    doc: dict  # the (migrated) v1 document
    source: str  # the input's schema: aicad.ir/0 or aicad.ir/1
    renames: list[dict] = field(default_factory=list)


def load_value(value: Any, *, expressions: bool = True) -> Loaded:
    if not isinstance(value, dict):
        raise Rejected([], "a document is a JSON object")
    schema = value.get("schema")
    if schema == IR_SCHEMA_V0:
        errs = ir0.schema_errors(ir0.ir_validator(), value)
        if errs:
            raise Rejected([], "; ".join(errs[:10]), "IR_SCHEMA_INVALID")
        verrs = ir0.validate_structure(ir0.parse_document(value))
        if verrs:
            raise Rejected([Problem(e.code, e.path, e.message) for e in verrs])
        doc, renames = migrate_v0_to_v1(value)
        return Loaded(doc, IR_SCHEMA_V0, renames)
    if schema != IR_SCHEMA:
        shown = schema if isinstance(schema, str) and len(schema) < 64 else "<invalid value>"
        raise Rejected([Problem("UNSUPPORTED_SCHEMA", "/schema",
                                f"expected {IR_SCHEMA_V0!r} or {IR_SCHEMA!r}",
                                {"found": shown, "supported": [IR_SCHEMA_V0, IR_SCHEMA]})])
    parse, pre = precheck(value)
    if parse is not None:
        raise Rejected([], parse)
    if pre:
        raise Rejected(pre)
    errs = consts.schema_errors(consts.ir_validator(), value)
    if errs:
        raise Rejected([], "; ".join(errs[:10]), "IR_SCHEMA_INVALID")
    problems = validate(value, expressions=expressions)
    if problems:
        raise Rejected(problems)
    return Loaded(value, IR_SCHEMA, [])


def load_text(text: str, *, expressions: bool = True) -> Loaded:
    """Load JSON text. v1 text is read correctly rounded; v0 text is re-read with serde_json's
    number semantics (`jsonio.loads_serde`), which is what Forge's v0 path and its migration use."""
    try:
        value = loads_strict(text)
        if isinstance(value, dict) and value.get("schema") == IR_SCHEMA_V0:
            value = loads_serde(text)
    except (JsonError, RecursionError) as e:
        raise Rejected([], f"invalid JSON: {e}") from None
    return load_value(value, expressions=expressions)
