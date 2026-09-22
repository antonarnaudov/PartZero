"""Evaluate an IR v0 document per SPEC §4 and produce an `aicad.metrics/0` report."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .ir import (
    LINEAR_TOLERANCE,
    METRICS_SCHEMA,
    Document,
    DocumentError,
    ExtrudeFeature,
    RevolveFeature,
    SketchFeature,
    load_document,
    metrics_validator,
    resolve_plane,
    schema_errors,
)
from .sketch import SketchError, SketchResult, evaluate_sketch, signed_extent


class FeatureError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _err(code: str, message: str) -> dict:
    return {"code": code, "message": message}


def _feature_entry(part_name: str, feat, status: str, error: dict | None = None, regions=None, bodies=None) -> dict:
    # Key order and omission rules mirror serde in forge-ir/src/metrics.rs.
    # SPEC §5: `part` and `feature` are the part NAME and the feature NAME.
    out: dict[str, Any] = {"part": part_name, "feature": feat.name, "type": feat.type, "status": status}
    if error is not None:
        out["error"] = error
    if regions:
        out["regions"] = regions
    if bodies:
        out["bodies"] = bodies
    return out


def _sketch_report(res: SketchResult) -> list[dict]:
    return [
        {"area": r.area, "loops": r.loops, "outer_curves": list(r.outer_curves)} for r in res.regions
    ]


def _engine() -> str:
    from .occt import engine_string

    return engine_string()


def _check_revolve_profile(feat: RevolveFeature, sk: SketchFeature, res: SketchResult) -> None:
    curves = list(sk.curves)
    for r in res.regions:
        lo, hi = signed_extent(curves, r.outer, feat.axis_origin, feat.axis_direction)
        if lo < -LINEAR_TOLERANCE and hi > LINEAR_TOLERANCE:
            raise FeatureError(
                "REVOLVE_CROSSES_AXIS",
                f"region {r.outer_curves} of sketch {sk.name!r} has points on both sides of the "
                f"revolve axis (signed distance range [{lo:.9g}, {hi:.9g}] mm)",
            )


def _bodies_for(feat, sk: SketchFeature, res: SketchResult, checks: list | None, shapes: list | None) -> list[dict]:
    from . import occt

    pl = resolve_plane(sk.plane)
    curves = list(sk.curves)
    bodies: list[dict] = []
    for region in res.regions:
        face = occt.build_face(curves, region, pl)
        if isinstance(feat, ExtrudeFeature):
            solid = occt.extrude(face, pl, feat.distance, feat.direction)
        else:
            o3 = pl.to3d(feat.axis_origin)
            d3 = pl.dir3d(feat.axis_direction)
            n = math.sqrt(sum(c * c for c in d3))
            solid = occt.revolve(face, o3, (d3[0] / n, d3[1] / n, d3[2] / n), feat.angle, feat.direction)
        m = occt.body_metrics(solid)
        if not m["valid"]:
            # An OCCT result that OCCT itself rejects is not a reference: report the failure
            # instead of metrics (a Forge disagreement then classifies as ROBUSTNESS, not as a
            # potential silent-wrong). Seen for partial revolves of a circle tangent to the axis.
            raise occt.BuildError(
                "OCCT_INVALID_RESULT",
                f"BRepCheck_Analyzer rejects the OCCT solid for region {region.outer_curves} "
                f"(volume {m['volume']:.6g}, area {m['area']:.6g})",
            )
        if shapes is not None:
            shapes.append((feat.name, len(bodies), solid))
        if checks is not None:
            from .selfcheck import check_body

            for problem in check_body(feat, curves, region, pl, m, solid):
                checks.append(f"{feat.name} region {region.outer_curves}: {problem}")
        bodies.append(m)
    return bodies


def evaluate_document(doc: Document, name: str, checks: list | None = None, shapes: list | None = None) -> dict:
    """Evaluate a validated document. If `checks` is a list, run the independent self-checks
    (selfcheck.py) on every body and append any failures to it. If `shapes` is a list, append
    (feature name, body index, TopoDS_Solid) for every body."""
    features: list[dict] = []
    status = "ok"
    for part in doc.parts:
        sketches: dict[str, tuple[SketchFeature, SketchResult | None, dict | None]] = {}
        for feat in part.features:
            if isinstance(feat, SketchFeature):
                if feat.suppressed:
                    sketches[feat.name] = (feat, None, None)
                    continue
                try:
                    res = evaluate_sketch(list(feat.curves))
                    sketches[feat.name] = (feat, res, None)
                    features.append(_feature_entry(part.name, feat, "ok", regions=_sketch_report(res)))
                except SketchError as e:
                    err = _err(e.code, e.message)
                    sketches[feat.name] = (feat, None, err)
                    features.append(_feature_entry(part.name, feat, "error", error=err))
                    status = "error"
                continue
            if feat.suppressed:
                continue
            try:
                sk, res, sk_err = sketches[feat.sketch]
                if sk.suppressed:
                    raise FeatureError("SKETCH_SUPPRESSED", f"sketch {feat.sketch!r} is suppressed")
                if res is None:
                    assert sk_err is not None
                    # SPEC gap: the code of a feature consuming a failed sketch is not specified.
                    # The oracle propagates the sketch's own code (see README).
                    raise FeatureError(sk_err["code"], f"sketch {feat.sketch!r} failed: {sk_err['message']}")
                if isinstance(feat, RevolveFeature):
                    _check_revolve_profile(feat, sk, res)
                bodies = _bodies_for(feat, sk, res, checks, shapes)
                features.append(_feature_entry(part.name, feat, "ok", bodies=bodies))
            except (FeatureError, SketchError) as e:
                features.append(_feature_entry(part.name, feat, "error", error=_err(e.code, e.message)))
                status = "error"
            except Exception as e:  # OCCT build failures and oracle bugs
                code = getattr(e, "code", "ORACLE_EXCEPTION")
                msg = getattr(e, "message", f"{type(e).__name__}: {e}")
                features.append(_feature_entry(part.name, feat, "error", error=_err(code, msg)))
                status = "error"
    return {
        "schema": METRICS_SCHEMA,
        "engine": _engine(),
        "document": name,
        "status": status,
        "features": features,
    }


def error_report(name: str, code: str, message: str) -> dict:
    return {
        "schema": METRICS_SCHEMA,
        "engine": _engine(),
        "document": name,
        "status": "error",
        "error": _err(code, message),
        "features": [],
    }


def evaluate_data(data: Any, fallback_name: str, checks: list | None = None, shapes: list | None = None) -> dict:
    """Evaluate already-parsed JSON data (validating it first)."""
    name = fallback_name
    if isinstance(data, dict) and isinstance(data.get("meta"), dict):
        meta_name = data["meta"].get("name")
        if isinstance(meta_name, str) and meta_name:
            name = meta_name
    try:
        doc = load_document(data)
    except DocumentError as e:
        return error_report(name, e.code, e.message)
    return evaluate_document(doc, name, checks, shapes)


def evaluate_file(path: str | Path, checks: list | None = None, shapes: list | None = None) -> dict:
    path = Path(path)
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        return error_report(path.stem, "IR_PARSE_ERROR", str(e))
    return evaluate_data(data, path.stem, checks, shapes)


def check_report(report: dict) -> list[str]:
    """Validate a report against metrics-v0.schema.json plus value sanity (finite numbers)."""
    errs = schema_errors(metrics_validator(), report)

    def walk(x, path):
        if isinstance(x, float) and not math.isfinite(x):
            errs.append(f"{path}: non-finite number {x}")
        elif isinstance(x, dict):
            for k, v in x.items():
                walk(v, f"{path}/{k}")
        elif isinstance(x, list):
            for i, v in enumerate(x):
                walk(v, f"{path}/{i}")

    walk(report, "")
    return errs


def dumps_report(report: dict) -> str:
    return json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n"


def export_step(shapes: list, path: str | Path) -> None:
    """Write the evaluated bodies to one STEP file (debug aid; uses build123d's exporter)."""
    from build123d import Compound, Solid
    from build123d import export_step as b3d_export_step

    comp = Compound([Solid(s) for _, _, s in shapes])
    if not b3d_export_step(comp, str(path)):
        raise RuntimeError(f"STEP export to {path} failed")
