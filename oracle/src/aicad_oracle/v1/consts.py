"""IR v1 schema files and constants, read at run time from `forge/crates/forge-ir/schema/`.

Nothing is vendored: `ir-v1.schema.json`, `metrics-v1.schema.json` and `ir-v1.constants.json`
are the frozen W0 contract (interfaces I1 and I5). The oracle hard-codes only the values it
must use in arithmetic, and asserts at load time that they still equal the constants file.
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from ..ir import schema_dir

IR_SCHEMA = "aicad.ir/1"
METRICS_SCHEMA = "aicad.metrics/1"
IR_SCHEMA_V0 = "aicad.ir/0"

#: SPEC-v1 §1 tolerances used in arithmetic (checked against the constants file below).
LINEAR_TOLERANCE = 1e-6
ANGULAR_TOLERANCE = 1e-9
QUERY_ANGLE_TOLERANCE = 1e-6
TANGENT_CHAIN_TOLERANCE = 1e-6
QUERY_SIZE_TIE_REL = 1e-9
SOLVE_TOLERANCE = 1e-10
SOLVE_CHECK_TOLERANCE = 1e-9
PARAM_VALUE_REL = 1e-12
MAX_EXPR_BYTES = 4096
MAX_EXPR_DEPTH = 64
MAX_COUNT_MAGNITUDE = 2147483648.0
MAX_ID_LEN = 64
MAX_REF_SEGMENTS = 3


@lru_cache(maxsize=None)
def constants() -> dict:
    """`schema/ir-v1.constants.json`."""
    c = json.loads((schema_dir() / "ir-v1.constants.json").read_text())
    expect = {
        "IR_SCHEMA": IR_SCHEMA,
        "METRICS_SCHEMA": METRICS_SCHEMA,
        "LINEAR_TOLERANCE": LINEAR_TOLERANCE,
        "ANGULAR_TOLERANCE": ANGULAR_TOLERANCE,
        "QUERY_ANGLE_TOLERANCE": QUERY_ANGLE_TOLERANCE,
        "TANGENT_CHAIN_TOLERANCE": TANGENT_CHAIN_TOLERANCE,
        "QUERY_SIZE_TIE_REL": QUERY_SIZE_TIE_REL,
        "SOLVE_TOLERANCE": SOLVE_TOLERANCE,
        "SOLVE_CHECK_TOLERANCE": SOLVE_CHECK_TOLERANCE,
        "PARAM_VALUE_REL": PARAM_VALUE_REL,
        "MAX_EXPR_BYTES": MAX_EXPR_BYTES,
        "MAX_EXPR_DEPTH": MAX_EXPR_DEPTH,
        "MAX_COUNT_MAGNITUDE": MAX_COUNT_MAGNITUDE,
        "MAX_ID_LEN": MAX_ID_LEN,
        "MAX_REF_SEGMENTS": MAX_REF_SEGMENTS,
    }
    for k, v in expect.items():
        # The oracle hard-codes these for arithmetic; fail loudly if the contract moved.
        # An explicit raise, not `assert`: `python -O` strips asserts.
        if k not in c or c[k] != v:
            raise RuntimeError(f"ir-v1.constants.json {k} = {c.get(k)!r}, oracle expects {v!r}")
    return c


def reserved_names_v0() -> frozenset[str]:
    return frozenset(constants()["RESERVED_NAMES_V0"])


def reserved_names_v1() -> frozenset[str]:
    """The full v1 list (applied to parameter names, SPEC-v1 §9.3 [W0-2])."""
    return frozenset(constants()["RESERVED_NAMES"])


def feature_types() -> tuple[str, ...]:
    return tuple(constants()["FEATURE_TYPES"])


def feature_versions() -> dict[str, list[int]]:
    return constants()["FEATURE_VERSIONS"]


def param_units() -> tuple[str, ...]:
    return tuple(constants()["PARAM_UNITS"])


def constraint_types() -> tuple[str, ...]:
    return tuple(constants()["CONSTRAINT_TYPES"])


def dimension_types() -> tuple[str, ...]:
    return tuple(constants()["DIMENSION_TYPES"])


def error_codes() -> dict[str, dict]:
    return constants()["ERROR_CODES"]


def hole_sizes() -> tuple[str, ...]:
    return tuple(constants()["HOLE_SIZES"]["sizes"].keys())


def _strict_validator(schema: dict):
    """A Draft 2020-12 validator whose `integer` type rejects floats (`1.0`), like serde's u32."""
    import jsonschema

    base = jsonschema.validators.validator_for(schema)

    def is_int(_checker, instance: Any) -> bool:
        return isinstance(instance, int) and not isinstance(instance, bool)

    checker = base.TYPE_CHECKER.redefine("integer", is_int)
    cls = jsonschema.validators.extend(base, type_checker=checker)
    cls.check_schema(schema)
    return cls(schema)


def _relax_instance_index(schema: dict) -> None:
    """The one place where `ir-v1.schema.json` is stricter than the typed parse it describes:
    `Query.instance.index` carries `minItems: 1, maxItems: 2` (schemars `length(min = 1,
    max = 2)`), while serde accepts any `Vec<u32>` and validation reports `QUERY_INVALID` at
    `…/index` — which is what the I9 fixtures `queries/typing.json` `instance-empty-index` and
    `instance-3d-index` expect. The oracle drops the two keywords so that its typed parse
    matches serde (reported as a contract issue in the W7a report)."""
    for variant in schema["$defs"]["Query"]["oneOf"]:
        props = variant.get("properties", {})
        if props.get("op", {}).get("const") == "instance" and "index" in props:
            props["index"].pop("minItems", None)
            props["index"].pop("maxItems", None)


@lru_cache(maxsize=None)
def ir_validator():
    """Validator of `ir-v1.schema.json` (the typed parse of SPEC-v1 §0.5 rule 4 step 4)."""
    schema = json.loads((schema_dir() / "ir-v1.schema.json").read_text())
    _relax_instance_index(schema)
    return _strict_validator(schema)


@lru_cache(maxsize=None)
def metrics_validator():
    """Validator of `metrics-v1.schema.json` (interface I5)."""
    return _strict_validator(json.loads((schema_dir() / "metrics-v1.schema.json").read_text()))


def schema_errors(validator, data: Any) -> list[str]:
    errs = sorted(validator.iter_errors(data), key=lambda e: [str(p) for p in e.absolute_path])
    return [f"/{'/'.join(str(p) for p in e.absolute_path)}: {e.message}" for e in errs]
