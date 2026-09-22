"""SPEC §6 report comparison (`kernel-diff`) and mismatch classification.

Pure functions over two `aicad.metrics/0` report dicts; no I/O, no OCCT.

Classification (per feature, then the worst over the document):
  * MATCH                   — every §6 rule holds;
  * ROBUSTNESS              — one engine reports an error where the other does not (also used when
                              both error with different codes, or an engine produced no report);
  * POTENTIAL_SILENT_WRONG  — both engines report `ok` for the feature but its metrics differ.
Severity: POTENTIAL_SILENT_WRONG > ROBUSTNESS > MATCH.

Interpretation choices where SPEC §6 is silent (documented in README):
  * relative tolerances are relative to max(|a|, |b|);
  * s = max(1, bbox diagonal) uses the larger diagonal of the two bodies;
  * region areas have no body, so s = 1 for them (floor 1e-9 mm²);
  * centroid / bbox tolerances apply per coordinate;
  * histograms ignore zero-count entries.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

MATCH = "MATCH"
ROBUSTNESS = "ROBUSTNESS"
SILENT_WRONG = "POTENTIAL_SILENT_WRONG"
_SEVERITY = {MATCH: 0, ROBUSTNESS: 1, SILENT_WRONG: 2}

REL_TOL = 1e-6
ABS_FLOOR = 1e-9
POS_TOL = 1e-6


def worst(*classes: str) -> str:
    return max(classes, key=lambda c: _SEVERITY[c]) if classes else MATCH


@dataclass
class Difference:
    path: str
    detail: str
    classification: str

    def __str__(self) -> str:
        return f"[{self.classification}] {self.path}: {self.detail}"


@dataclass
class Comparison:
    classification: str = MATCH
    differences: list[Difference] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def add(self, path: str, detail: str, cls: str) -> None:
        self.differences.append(Difference(path, detail, cls))
        self.classification = worst(self.classification, cls)


def _is_num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _diag(body: dict) -> float:
    try:
        lo, hi = body["bbox_min"], body["bbox_max"]
        return math.sqrt(sum((hi[i] - lo[i]) ** 2 for i in range(3)))
    except (KeyError, TypeError, IndexError):
        return 0.0


def scale(a_body: dict, b_body: dict) -> float:
    return max(1.0, _diag(a_body), _diag(b_body))


def close_rel(a: Any, b: Any, floor: float) -> tuple[bool, float]:
    """Relative REL_TOL with an absolute floor. Returns (ok, allowed)."""
    if not (_is_num(a) and _is_num(b)):
        return False, float("nan")
    allowed = max(REL_TOL * max(abs(a), abs(b)), floor)
    return abs(a - b) <= allowed, allowed


def close_abs_vec(a: Any, b: Any, tol: float) -> bool:
    if not (isinstance(a, list) and isinstance(b, list) and len(a) == len(b) == 3):
        return False
    return all(_is_num(x) and _is_num(y) and abs(x - y) <= tol for x, y in zip(a, b))


def _hist(h: Any) -> dict:
    if not isinstance(h, dict):
        return {"<invalid>": h}
    return {k: v for k, v in sorted(h.items()) if v != 0}


def _fmt(x: Any) -> str:
    if isinstance(x, float):
        return repr(x)
    return str(x)


def _feature_label(f: dict) -> str:
    return f"{f.get('part', '?')}/{f.get('feature', '?')}({f.get('type', '?')})"


def compare_regions(ra: list, rb: list, path: str, cmp: Comparison, la: str, lb: str) -> None:
    if len(ra) != len(rb):
        cmp.add(f"{path}.regions", f"region count {la}={len(ra)} {lb}={len(rb)}", SILENT_WRONG)
        return
    for i, (x, y) in enumerate(zip(ra, rb)):
        p = f"{path}.regions[{i}]"
        if x.get("outer_curves") != y.get("outer_curves"):
            cmp.add(p, f"outer_curves {la}={x.get('outer_curves')} {lb}={y.get('outer_curves')}", SILENT_WRONG)
        if x.get("loops") != y.get("loops"):
            cmp.add(p, f"loops {la}={x.get('loops')} {lb}={y.get('loops')}", SILENT_WRONG)
        ok, allowed = close_rel(x.get("area"), y.get("area"), ABS_FLOOR * 1.0**2)
        if not ok:
            cmp.add(
                p,
                f"area {la}={_fmt(x.get('area'))} {lb}={_fmt(y.get('area'))} (allowed ±{allowed:.3g})",
                SILENT_WRONG,
            )


EXACT_BODY_FIELDS = ("faces", "edges", "valid")


def compare_bodies(ba: list, bb: list, path: str, cmp: Comparison, la: str, lb: str) -> None:
    if len(ba) != len(bb):
        cmp.add(f"{path}.bodies", f"body count {la}={len(ba)} {lb}={len(bb)}", SILENT_WRONG)
        return
    for i, (x, y) in enumerate(zip(ba, bb)):
        p = f"{path}.bodies[{i}]"
        s = scale(x, y)
        for k in EXACT_BODY_FIELDS:
            if x.get(k) != y.get(k):
                cmp.add(p, f"{k} {la}={x.get(k)} {lb}={y.get(k)}", SILENT_WRONG)
        for k in ("face_types", "edge_types"):
            hx, hy = _hist(x.get(k)), _hist(y.get(k))
            if hx != hy:
                cmp.add(p, f"{k} {la}={hx} {lb}={hy}", SILENT_WRONG)
        ok, allowed = close_rel(x.get("volume"), y.get("volume"), ABS_FLOOR * s**3)
        if not ok:
            cmp.add(
                p,
                f"volume {la}={_fmt(x.get('volume'))} {lb}={_fmt(y.get('volume'))} (allowed ±{allowed:.3g})",
                SILENT_WRONG,
            )
        ok, allowed = close_rel(x.get("area"), y.get("area"), ABS_FLOOR * s**2)
        if not ok:
            cmp.add(
                p,
                f"area {la}={_fmt(x.get('area'))} {lb}={_fmt(y.get('area'))} (allowed ±{allowed:.3g})",
                SILENT_WRONG,
            )
        for k in ("centroid", "bbox_min", "bbox_max"):
            if not close_abs_vec(x.get(k), y.get(k), POS_TOL * s):
                cmp.add(
                    p, f"{k} {la}={x.get(k)} {lb}={y.get(k)} (allowed ±{POS_TOL * s:.3g} per coordinate)",
                    SILENT_WRONG,
                )


def compare_features(fa: dict, fb: dict, path: str, cmp: Comparison, la: str, lb: str) -> None:
    sa, sb = fa.get("status"), fb.get("status")
    ca = (fa.get("error") or {}).get("code")
    cb = (fb.get("error") or {}).get("code")
    if sa != sb:
        what = f"status {la}={sa}" + (f" [{ca}]" if ca else "") + f" {lb}={sb}" + (f" [{cb}]" if cb else "")
        cmp.add(path, what, ROBUSTNESS)
        return
    if sa == "error":
        if ca != cb:
            cmp.add(path, f"error code {la}={ca} {lb}={cb}", ROBUSTNESS)
        return
    compare_regions(fa.get("regions") or [], fb.get("regions") or [], path, cmp, la, lb)
    compare_bodies(fa.get("bodies") or [], fb.get("bodies") or [], path, cmp, la, lb)


def compare_reports(a: dict, b: dict, label_a: str = "a", label_b: str = "b") -> Comparison:
    """Compare two metrics reports per SPEC §6."""
    cmp = Comparison()
    la, lb = label_a, label_b
    if a.get("status") != b.get("status"):
        cmp.add("status", f"document status {la}={a.get('status')} {lb}={b.get('status')}", ROBUSTNESS)
    ea = (a.get("error") or {}).get("code")
    eb = (b.get("error") or {}).get("code")
    if ea != eb:
        cmp.notes.append(f"document-level error code {la}={ea} {lb}={eb} (not a §6 field)")
    fa_list = a.get("features") or []
    fb_list = b.get("features") or []
    n = max(len(fa_list), len(fb_list))
    for i in range(n):
        if i >= len(fa_list) or i >= len(fb_list):
            present = fa_list[i] if i < len(fa_list) else fb_list[i]
            missing_side = la if i >= len(fa_list) else lb
            missing_doc = a if i >= len(fa_list) else b
            cls = ROBUSTNESS if missing_doc.get("error") else SILENT_WRONG
            cmp.add(f"features[{i}]", f"{_feature_label(present)} missing in {missing_side}", cls)
            continue
        fa, fb = fa_list[i], fb_list[i]
        key_a = (fa.get("part"), fa.get("feature"), fa.get("type"))
        key_b = (fb.get("part"), fb.get("feature"), fb.get("type"))
        path = f"features[{i}] {_feature_label(fa)}"
        if key_a != key_b:
            cmp.add(
                f"features[{i}]",
                f"feature identity {la}={_feature_label(fa)} {lb}={_feature_label(fb)}",
                SILENT_WRONG if a.get("status") == b.get("status") == "ok" else ROBUSTNESS,
            )
            continue
        compare_features(fa, fb, path, cmp, la, lb)
    return cmp
