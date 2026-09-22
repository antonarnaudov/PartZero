"""IR v0 (`aicad.ir/0`) document model, JSON-Schema validation and structural validation.

The structural checks mirror `forge/crates/forge-ir/src/validate.rs` one-to-one (same codes,
same order) so that a document rejected by Forge is rejected by the oracle for the same reason.
Unknown fields (everywhere, including sketch curves) are rejected by the JSON Schema, which is
read at run time from `forge/crates/forge-ir/schema/` (never vendored).
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Union

IR_SCHEMA = "aicad.ir/0"
METRICS_SCHEMA = "aicad.metrics/0"
#: SPEC §1: points closer than this are coincident; lengths at or below it are degenerate.
LINEAR_TOLERANCE = 1e-6
#: SPEC §2: |cos(normal, x_dir)| must not exceed this for an explicit frame.
FRAME_PERPENDICULAR_TOL = 1e-9

Vec2 = tuple[float, float]
Vec3 = tuple[float, float, float]


# ---------------------------------------------------------------------------------------------
# Schema files
# ---------------------------------------------------------------------------------------------

def schema_dir() -> Path:
    """Locate `forge/crates/forge-ir/schema` (the single source of truth for both schemas)."""
    env = os.environ.get("AICAD_IR_SCHEMA_DIR")
    if env:
        return Path(env)
    rel = Path("forge") / "crates" / "forge-ir" / "schema"
    for base in [Path(__file__).resolve(), Path.cwd().resolve()]:
        for parent in [base, *base.parents]:
            cand = parent / rel
            if (cand / "ir-v0.schema.json").is_file():
                return cand
    raise FileNotFoundError(
        "cannot find forge/crates/forge-ir/schema; set AICAD_IR_SCHEMA_DIR"
    )


@lru_cache(maxsize=None)
def _validator(name: str):
    import jsonschema

    schema = json.loads((schema_dir() / name).read_text())
    cls = jsonschema.validators.validator_for(schema)
    cls.check_schema(schema)
    return cls(schema)


def ir_validator():
    return _validator("ir-v0.schema.json")


@lru_cache(maxsize=None)
def constants() -> dict:
    """`schema/ir-v0.constants.json` (IR_SCHEMA, LINEAR_TOLERANCE, RESERVED_NAMES, ...)."""
    c = json.loads((schema_dir() / "ir-v0.constants.json").read_text())
    # The oracle hard-codes these two; fail loudly if the contract moved.
    assert c["IR_SCHEMA"] == IR_SCHEMA and c["METRICS_SCHEMA"] == METRICS_SCHEMA, c
    assert c["LINEAR_TOLERANCE"] == LINEAR_TOLERANCE, c
    return c


def reserved_names() -> frozenset[str]:
    """SPEC §0: feature names that are reserved words or CadScript builtins."""
    return frozenset(constants()["RESERVED_NAMES"])


def metrics_validator():
    return _validator("metrics-v0.schema.json")


def schema_errors(validator, data: Any) -> list[str]:
    errs = sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
    return [f"/{'/'.join(str(p) for p in e.absolute_path)}: {e.message}" for e in errs]


# ---------------------------------------------------------------------------------------------
# Document model
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Line:
    id: str
    start: Vec2
    end: Vec2
    kind: str = "line"


@dataclass(frozen=True)
class Arc:
    id: str
    start: Vec2
    end: Vec2
    center: Vec2
    ccw: bool
    kind: str = "arc"


@dataclass(frozen=True)
class Circle:
    id: str
    center: Vec2
    radius: float
    kind: str = "circle"


Curve = Union[Line, Arc, Circle]


@dataclass(frozen=True)
class Frame:
    origin: Vec3
    normal: Vec3
    x_dir: Vec3


PlaneSpec = Union[str, Frame]


@dataclass(frozen=True)
class ResolvedPlane:
    """(origin, x, y, normal) with x, y, normal unit length (SPEC §2)."""

    origin: Vec3
    x: Vec3
    y: Vec3
    normal: Vec3

    def to3d(self, p: Vec2) -> Vec3:
        u, v = p
        o, x, y = self.origin, self.x, self.y
        return (o[0] + u * x[0] + v * y[0], o[1] + u * x[1] + v * y[1], o[2] + u * x[2] + v * y[2])

    def dir3d(self, d: Vec2) -> Vec3:
        u, v = d
        x, y = self.x, self.y
        return (u * x[0] + v * y[0], u * x[1] + v * y[1], u * x[2] + v * y[2])


@dataclass(frozen=True)
class SketchFeature:
    id: str
    name: str
    plane: PlaneSpec
    curves: tuple[Curve, ...]
    suppressed: bool = False
    type: str = "sketch"


@dataclass(frozen=True)
class ExtrudeFeature:
    id: str
    name: str
    sketch: str
    distance: float
    direction: str = "normal"
    suppressed: bool = False
    type: str = "extrude"


@dataclass(frozen=True)
class RevolveFeature:
    id: str
    name: str
    sketch: str
    axis_origin: Vec2
    axis_direction: Vec2
    angle: float
    direction: str = "normal"
    suppressed: bool = False
    type: str = "revolve"


Feature = Union[SketchFeature, ExtrudeFeature, RevolveFeature]


@dataclass(frozen=True)
class PartStudio:
    id: str
    name: str
    features: tuple[Feature, ...]


@dataclass(frozen=True)
class Document:
    schema: str
    name: str
    description: str
    parts: tuple[PartStudio, ...] = field(default_factory=tuple)


def _v2(a) -> Vec2:
    return (float(a[0]), float(a[1]))


def _v3(a) -> Vec3:
    return (float(a[0]), float(a[1]), float(a[2]))


def _curve(c: dict) -> Curve:
    k = c["kind"]
    if k == "line":
        return Line(c["id"], _v2(c["start"]), _v2(c["end"]))
    if k == "arc":
        return Arc(c["id"], _v2(c["start"]), _v2(c["end"]), _v2(c["center"]), bool(c["ccw"]))
    if k == "circle":
        return Circle(c["id"], _v2(c["center"]), float(c["radius"]))
    raise ValueError(f"unknown curve kind {k!r}")


def _plane(p) -> PlaneSpec:
    if isinstance(p, str):
        return p
    return Frame(_v3(p["origin"]), _v3(p["normal"]), _v3(p["x_dir"]))


def _feature(f: dict) -> Feature:
    t = f["type"]
    sup = bool(f.get("suppressed", False))
    if t == "sketch":
        return SketchFeature(
            f["id"], f["name"], _plane(f["plane"]), tuple(_curve(c) for c in f["curves"]), sup
        )
    if t == "extrude":
        return ExtrudeFeature(
            f["id"], f["name"], f["sketch"], float(f["distance"]), f.get("direction", "normal"), sup
        )
    if t == "revolve":
        ax = f["axis"]
        return RevolveFeature(
            f["id"],
            f["name"],
            f["sketch"],
            _v2(ax["origin"]),
            _v2(ax["direction"]),
            float(f["angle"]),
            f.get("direction", "normal"),
            sup,
        )
    raise ValueError(f"unknown feature type {t!r}")


def parse_document(data: dict) -> Document:
    """Build the typed model. `data` must already satisfy the JSON Schema."""
    meta = data.get("meta", {}) or {}
    parts = tuple(
        PartStudio(p["id"], p["name"], tuple(_feature(f) for f in p["features"]))
        for p in data["parts"]
    )
    return Document(data["schema"], meta.get("name", ""), meta.get("description", ""), parts)


# ---------------------------------------------------------------------------------------------
# Planes
# ---------------------------------------------------------------------------------------------

def _norm3(v: Vec3) -> Vec3:
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    return (v[0] / n, v[1] / n, v[2] / n)


def cross3(a: Vec3, b: Vec3) -> Vec3:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def resolve_plane(p: PlaneSpec) -> ResolvedPlane:
    """SPEC §2 — identical arithmetic to `PlaneSpec::resolve` in forge-ir.

    [R-14] n = normalize(normal); x = normalize(x_dir − (x_dir·n) n); y = n × x.
    """
    if p == "XY":
        return ResolvedPlane((0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
    if p == "XZ":
        return ResolvedPlane((0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.0, -1.0, 0.0))
    if p == "YZ":
        return ResolvedPlane((0.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
    assert isinstance(p, Frame), p
    n = _norm3(p.normal)
    xd = p.x_dir
    d = xd[0] * n[0] + xd[1] * n[1] + xd[2] * n[2]
    x = _norm3((xd[0] - d * n[0], xd[1] - d * n[1], xd[2] - d * n[2]))
    return ResolvedPlane(p.origin, x, cross3(n, x), n)


# ---------------------------------------------------------------------------------------------
# Structural validation (mirror of validate.rs)
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class ValidationError:
    code: str
    path: str
    message: str

    def __str__(self) -> str:
        return f"{self.code} at {self.path}: {self.message}"


def _is_identifier(s: str) -> bool:
    if not s:
        return False
    c0 = s[0]
    if not (c0 == "_" or (c0.isascii() and c0.isalpha())):
        return False
    return all(c == "_" or (c.isascii() and c.isalnum()) for c in s[1:])


def _finite2(p: Vec2) -> bool:
    return math.isfinite(p[0]) and math.isfinite(p[1])


def dist2(a: Vec2, b: Vec2) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _len3(v: Vec3) -> float:
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def validate_structure(doc: Document) -> list[ValidationError]:
    errs: list[ValidationError] = []
    if doc.schema != IR_SCHEMA:
        errs.append(
            ValidationError("UNSUPPORTED_SCHEMA", "/schema", f"expected {IR_SCHEMA!r}, got {doc.schema!r}")
        )
    if not doc.parts:
        errs.append(ValidationError("NO_PARTS", "/parts", "a document needs at least one part studio"))
    part_ids: set[str] = set()
    part_names: set[str] = set()
    # SPEC §0: feature ids and names are unique across the WHOLE document.
    feature_ids: set[str] = set()
    feature_names: set[str] = set()
    for pi, part in enumerate(doc.parts):
        pp = f"/parts/{pi}"
        if part.id in part_ids:
            errs.append(ValidationError("DUPLICATE_ID", f"{pp}/id", f"part id {part.id!r}"))
        part_ids.add(part.id)
        if part.name in part_names:
            errs.append(ValidationError("DUPLICATE_NAME", f"{pp}/name", f"part {part.name!r}"))
        part_names.add(part.name)
        _validate_part(part, pp, feature_ids, feature_names, errs)
    return errs


def _validate_part(
    part: PartStudio, pp: str, ids: set[str], names: set[str], errs: list[ValidationError]
) -> None:
    reserved = reserved_names()
    sketches_before: set[str] = set()
    for fi, f in enumerate(part.features):
        fp = f"{pp}/features/{fi}"
        if f.id in ids:
            errs.append(ValidationError("DUPLICATE_ID", f"{fp}/id", f"feature id {f.id!r}"))
        ids.add(f.id)
        if f.name in names:
            errs.append(ValidationError("DUPLICATE_NAME", f"{fp}/name", repr(f.name)))
        names.add(f.name)
        if not _is_identifier(f.name):
            errs.append(
                ValidationError(
                    "INVALID_NAME",
                    f"{fp}/name",
                    f"{f.name!r} must match [A-Za-z_][A-Za-z0-9_]* (it is a CadScript const)",
                )
            )
        elif f.name in reserved:
            errs.append(
                ValidationError(
                    "RESERVED_NAME",
                    f"{fp}/name",
                    f"{f.name!r} is a reserved word or CadScript builtin; pick another name",
                )
            )
        if isinstance(f, SketchFeature):
            _validate_sketch(f, fp, errs)
            sketches_before.add(f.name)
        elif isinstance(f, ExtrudeFeature):
            _check_sketch_ref(f.sketch, sketches_before, fp, errs)
            if not (math.isfinite(f.distance) and f.distance > LINEAR_TOLERANCE):
                errs.append(
                    ValidationError(
                        "INVALID_DISTANCE",
                        f"{fp}/distance",
                        f"must be finite and > {LINEAR_TOLERANCE} mm, got {f.distance}",
                    )
                )
        elif isinstance(f, RevolveFeature):
            _check_sketch_ref(f.sketch, sketches_before, fp, errs)
            if not (math.isfinite(f.angle) and 0.0 < f.angle <= 360.0):
                errs.append(
                    ValidationError(
                        "INVALID_ANGLE", f"{fp}/angle", f"must be in (0, 360] degrees, got {f.angle}"
                    )
                )
            d = f.axis_direction
            if not (_finite2(f.axis_origin) and _finite2(d)) or math.hypot(d[0], d[1]) <= LINEAR_TOLERANCE:
                errs.append(
                    ValidationError(
                        "INVALID_AXIS",
                        f"{fp}/axis",
                        "axis origin/direction must be finite and direction non-zero",
                    )
                )


def _check_sketch_ref(name: str, before: set[str], fp: str, errs: list[ValidationError]) -> None:
    if name not in before:
        errs.append(
            ValidationError(
                "UNRESOLVED_SKETCH",
                f"{fp}/sketch",
                f"{name!r} is not an earlier sketch feature in this part studio",
            )
        )


def _validate_sketch(s: SketchFeature, fp: str, errs: list[ValidationError]) -> None:
    if isinstance(s.plane, Frame):
        f = s.plane
        n = _len3(f.normal)
        x = _len3(f.x_dir)
        finite = all(math.isfinite(v) for v in (*f.origin, *f.normal, *f.x_dir))
        if not finite or n <= LINEAR_TOLERANCE or x <= LINEAR_TOLERANCE:
            errs.append(ValidationError("INVALID_PLANE", f"{fp}/plane", "degenerate frame"))
        else:
            dot = (f.normal[0] * f.x_dir[0] + f.normal[1] * f.x_dir[1] + f.normal[2] * f.x_dir[2]) / (n * x)
            if abs(dot) > FRAME_PERPENDICULAR_TOL:
                errs.append(
                    ValidationError(
                        "INVALID_PLANE",
                        f"{fp}/plane",
                        f"normal and x_dir must be perpendicular (cos = {dot:e})",
                    )
                )
    if not s.curves:
        errs.append(ValidationError("EMPTY_SKETCH", f"{fp}/curves", "a sketch needs at least one curve"))
    ids: set[str] = set()
    for ci, c in enumerate(s.curves):
        cp = f"{fp}/curves/{ci}"
        if c.id in ids:
            errs.append(ValidationError("DUPLICATE_ID", f"{cp}/id", f"curve id {c.id!r}"))
        ids.add(c.id)
        if isinstance(c, Line):
            if not (_finite2(c.start) and _finite2(c.end)):
                errs.append(ValidationError("NON_FINITE", cp, "line endpoints must be finite"))
            elif dist2(c.start, c.end) <= LINEAR_TOLERANCE:
                errs.append(ValidationError("DEGENERATE_CURVE", cp, "zero-length line"))
        elif isinstance(c, Arc):
            if not (_finite2(c.start) and _finite2(c.end) and _finite2(c.center)):
                errs.append(ValidationError("NON_FINITE", cp, "arc points must be finite"))
                continue
            r0 = dist2(c.start, c.center)
            r1 = dist2(c.end, c.center)
            if r0 <= LINEAR_TOLERANCE or r1 <= LINEAR_TOLERANCE:
                errs.append(ValidationError("DEGENERATE_CURVE", cp, "zero-radius arc"))
            elif abs(r0 - r1) > LINEAR_TOLERANCE:
                errs.append(
                    ValidationError("INCONSISTENT_ARC", cp, f"|start−center| = {r0} but |end−center| = {r1}")
                )
            elif dist2(c.start, c.end) <= LINEAR_TOLERANCE:
                errs.append(
                    ValidationError("DEGENERATE_CURVE", cp, "arc start == end; use a circle for a full turn")
                )
        elif isinstance(c, Circle):
            if not (_finite2(c.center) and math.isfinite(c.radius)):
                errs.append(ValidationError("NON_FINITE", cp, "circle center and radius must be finite"))
            elif c.radius <= LINEAR_TOLERANCE:
                errs.append(ValidationError("DEGENERATE_CURVE", cp, "circle radius must be > 0"))


# ---------------------------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------------------------

class DocumentError(Exception):
    """A document-level failure (unparseable / schema-invalid / structurally invalid)."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def load_document(data: Any) -> Document:
    """Validate raw JSON data against the IR schema and validate.rs rules; return the model.

    Raises DocumentError with code `IR_SCHEMA_INVALID` or the first structural code.
    """
    errs = schema_errors(ir_validator(), data)
    if errs:
        raise DocumentError("IR_SCHEMA_INVALID", "; ".join(errs[:10]))
    doc = parse_document(data)
    verrs = validate_structure(doc)
    if verrs:
        raise DocumentError(verrs[0].code, "; ".join(str(e) for e in verrs))
    return doc
