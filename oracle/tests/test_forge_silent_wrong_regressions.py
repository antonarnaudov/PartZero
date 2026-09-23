"""Regressions for the Phase 0 audit's silent-wrong findings in Forge (forge-check, forge-mesh).

* H1 — a revolve within ~4e-7° of 360° dropped every face that runs from the axis to the axis:
  forge-check joined the face's two meridians as an ε-wide sliver instead of a `2π − ε` domain,
  so the sphere / spindle pocket vanished from volume, area and centroid while the body was
  reported ok and valid (pocket at 359.9999999°: 4423.36 mm³ against 3899.76). At tiny angles
  the same join lost the lune (5 % volume error, inside the absolute tolerance).
* H2 — the tight box of 360° spindle (lemon/apple) and horn faces included torus critical points
  beyond the singular line: up to 9× too large, in every sketch plane.
* V1 — five `oracle gen --seed 23` revolves whose profile touches the axis at a point evaluated
  fine but `aicad export` failed ("refinement stopped … estimated deviation inf"): the cone apex
  vertex's pcurve v rounded a few ulps onto the other nappe, where the cone normal flips.
* L6 — [R-12] per report: an `ok` feature whose body has `valid` ≠ true is POTENTIAL_SILENT_WRONG
  whichever engine reported it and whatever the other engine reported (pure `compare` tests).
* Profiles OCCT cannot revolve (horn torus from a circle touching the axis, an arrow and a
  pinched sphere touching it at two points): the oracle errors, so the diff leaves Forge's
  result unverified (ROBUSTNESS); Forge is checked against closed forms instead.

Each Forge case runs the Forge CLI (`AICAD_FORGE_BIN`, default `forge/target/debug/aicad`; build
it with `cargo build -p forge-cli`) and, where OCCT can build it, the oracle on the same IR, and
must classify MATCH under SPEC §6; the H1/H2 cases are also checked against closed forms. Without
a Forge binary the tests skip locally and fail under CI (`CI` set): they must never pass having
compared nothing.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
from pathlib import Path

import pytest

from aicad_oracle.compare import MATCH, ROBUSTNESS, SILENT_WRONG, compare_reports
from aicad_oracle.diffrun import run_forge
from aicad_oracle.evaluate import evaluate_data
from helpers import A, C, L

REPO = Path(__file__).resolve().parents[2]
FORGE_BIN = Path(os.environ.get("AICAD_FORGE_BIN", REPO / "forge" / "target" / "debug" / "aicad"))


def forge_bin() -> Path:
    if not FORGE_BIN.is_file():
        if os.environ.get("CI"):
            pytest.fail(f"Forge binary {FORGE_BIN} is missing under CI (cargo build -p forge-cli)")
        pytest.skip(f"Forge binary {FORGE_BIN} not built (cargo build -p forge-cli)")
    return FORGE_BIN


def revolve_doc(name, curves, angle, plane="XZ", direction="normal"):
    rv = {"type": "revolve", "id": "r1", "name": "spinner", "sketch": "profile",
          "axis": {"origin": [0, 0], "direction": [0, 1]}, "angle": angle}
    if direction != "normal":
        rv["direction"] = direction
    return {"schema": "aicad.ir/0", "meta": {"name": name}, "parts": [{"id": "p1", "name": "part", "features": [
        {"type": "sketch", "id": "s1", "name": "profile", "plane": plane, "curves": curves}, rv]}]}


def forge_report(doc: dict, tmp_path: Path) -> dict:
    path = tmp_path / f"{doc['meta']['name']}.json"
    path.write_text(json.dumps(doc))
    report, problem = run_forge(forge_bin(), path)
    assert report is not None, problem
    return report


def assert_match(doc: dict, tmp_path: Path) -> dict:
    """Forge vs oracle per SPEC §6; returns Forge's report."""
    fr = forge_report(doc, tmp_path)
    orc = evaluate_data(doc, doc["meta"]["name"])
    cmp = compare_reports(fr, orc, "forge", "oracle")
    assert cmp.classification == MATCH, "\n".join(map(str, cmp.differences))
    return fr


def body_of(report: dict) -> dict:
    f = report["features"][-1]
    assert f["status"] == "ok", f
    (b,) = f["bodies"]
    assert b["valid"] is True
    return b


# ---- H1: pockets from the axis to the axis, revolved near 360° ----------------------------------

def pocket(cx: float, width: float) -> list[dict]:
    return [A("pocket", (0, 10), (0, 0), (cx, 5), ccw=False), L("ax1", (0, 0), (0, -10)),
            L("bot", (0, -10), (width, -10)), L("side", (width, -10), (width, 12)),
            L("top", (width, 12), (0, 12)), L("ax2", (0, 12), (0, 10))]


def pocket_moment(cx: float, width: float) -> float:
    """∫ρ dA of the pocket profile (rectangle minus the part of the disc at x ≥ 0)."""
    r2, d = 25.0 + cx * cx, abs(cx)
    alpha = math.acos(d / math.sqrt(r2))
    minor_area = r2 * alpha - 5.0 * d
    if cx < 0:
        seg = 250.0 / 3.0 - d * minor_area
    else:
        seg = 250.0 / 3.0 + 2.0 * d * (math.pi * r2 / 2.0 - minor_area / 2.0)
    return width * width / 2.0 * 22.0 - seg


H1_CASES = {
    # name: (pocket centre x, width, angle, direction)
    "pocket_near": (0.0, 8.0, 359.9999999, "normal"),
    "pocket_near_reverse": (0.0, 8.0, 359.9999999, "reverse"),
    "pocket_near_symmetric": (0.0, 8.0, 359.9999999, "symmetric"),
    "pocket_threshold_wrong": (0.0, 8.0, 359.9999996, "normal"),
    "pocket_threshold_right": (0.0, 8.0, 359.9999995, "normal"),
    "pocket_small": (0.0, 8.0, 1e-4, "normal"),
    "pocket_tiny": (0.0, 8.0, 1e-7, "normal"),
    "lemonpocket_near": (-2.0, 8.0, 359.9999999, "normal"),
    "lemonpocket_tiny": (-2.0, 8.0, 1e-7, "normal"),
    "applepocket_near": (2.0, 9.0, 359.9999999, "normal"),
    "applepocket_tiny": (2.0, 9.0, 1e-7, "normal"),
}


@pytest.mark.parametrize("name", sorted(H1_CASES))
def test_h1_near_full_revolve_keeps_the_axis_to_axis_face(name, tmp_path):
    cx, width, angle, direction = H1_CASES[name]
    b = body_of(assert_match(revolve_doc(name, pocket(cx, width), angle, direction=direction), tmp_path))
    want = math.radians(angle) * pocket_moment(cx, width)
    assert b["volume"] == pytest.approx(want, rel=1e-10)


def test_h1_pocket_matches_the_audit_closed_form(tmp_path):
    b = body_of(forge_report(revolve_doc("pocket", pocket(0.0, 8.0), 359.9999999), tmp_path))
    full = math.pi * 64 * 22 - 4 / 3 * math.pi * 125  # 3899.76, not 4423.36
    assert b["volume"] == pytest.approx(full * 359.9999999 / 360, rel=1e-12)
    assert b["area"] == pytest.approx(math.radians(359.9999999) * 290 + 2 * (176 - 12.5 * math.pi), rel=1e-12)


# ---- H2: 360° spindle and horn faces, tight box --------------------------------------------------

LEMON = [A("arc", (0, -6), (2, 0), (-8, 0)), L("top", (2, 0), (0, 0)), L("ax", (0, 0), (0, -6))]
LEMON_UP = [A("arc", (2, 0), (0, 6), (-8, 0)), L("ax", (0, 6), (0, 0)), L("bot", (0, 0), (2, 0))]
HORN = [A("arc", (0, 0), (4, -4), (4, 0)), L("l", (4, -4), (0, -4)), L("ax", (0, -4), (0, 0))]
ZS = math.sqrt(21)
LEMON_HALF = [A("arc", (0, -ZS), (3, 0), (-2, 0)), L("l", (3, 0), (0, 0)), L("ax", (0, 0), (0, -ZS))]
T1 = {"origin": [1, 2, 3], "normal": [1, 2, 3], "x_dir": [2, -1, 0]}
T2 = {"origin": [0, 0, 0], "normal": [0.3, -1, 0.2], "x_dir": [1, 0.3, 0]}

H2_CASES = {
    # name: (profile, plane, direction, expected bbox or None for the tilted frames)
    "lemonbb_xz_360": (LEMON, "XZ", "normal", ([-2, -2, -6], [2, 2, 0])),
    "lemonbb_xy_360": (LEMON, "XY", "normal", ([-2, -6, -2], [2, 0, 2])),
    "lemonbb_t1_360": (LEMON, T1, "normal", None),
    "lemonbb_t2_360": (LEMON, T2, "normal", None),
    "lemonup_xz_360": (LEMON_UP, "XZ", "normal", ([-2, -2, 0], [2, 2, 6])),
    "lemonup_t1_360": (LEMON_UP, T1, "normal", None),
    "horndown_xz_360": (HORN, "XZ", "normal", ([-4, -4, -4], [4, 4, 0])),
    "horndown_xy_360": (HORN, "XY", "normal", ([-4, -4, -4], [4, 0, 4])),
    "horndown_t1_360": (HORN, T1, "normal", None),
    "horndown_t2_360": (HORN, T2, "normal", None),
    "lemonhalf_360_normal": (LEMON_HALF, "XZ", "normal", ([-3, -3, -ZS], [3, 3, 0])),
    "lemonhalf_360_reverse": (LEMON_HALF, "XZ", "reverse", ([-3, -3, -ZS], [3, 3, 0])),
    "lemonhalf_360_symmetric": (LEMON_HALF, "XZ", "symmetric", ([-3, -3, -ZS], [3, 3, 0])),
}


@pytest.mark.parametrize("name", sorted(H2_CASES))
def test_h2_spindle_and_horn_boxes_end_at_the_singular_point(name, tmp_path):
    profile, plane, direction, box = H2_CASES[name]
    b = body_of(assert_match(revolve_doc(name, profile, 360, plane=plane, direction=direction), tmp_path))
    if box is not None:
        lo, hi = box
        assert b["bbox_min"] == pytest.approx(lo, abs=1e-12)
        assert b["bbox_max"] == pytest.approx(hi, abs=1e-12)


# ---- V1: revolves touching the axis at a point, export ------------------------------------------

V1_PROGRAMS = {
    "gen_s23_00000": '{"schema":"aicad.ir/0","meta":{"name":"gen_s23_00000","description":"revolve[point_touch] 37.25deg on XZ normal; +extrude of the same sketch"},"units":{"length":"mm","angle":"deg"},"parts":[{"id":"p1","name":"part_1","features":[{"type":"sketch","id":"s1","name":"sketch_1","plane":"XZ","curves":[{"kind":"line","id":"l2","start":[-35.25568459218553,18.896899332818613],"end":[-29.426444482221918,-10.182889596955235]},{"kind":"line","id":"l1","start":[-29.426444482221918,-10.182889596955235],"end":[-12.63709230694402,-5.6855561921037605]},{"kind":"line","id":"l3","start":[-35.25568459218553,18.896899332818613],"end":[-12.63709230694402,-5.6855561921037605]}]},{"type":"revolve","id":"r1","name":"revolve_1","sketch":"sketch_1","axis":{"origin":[-26.461758865855018,21.2525123139463],"direction":[-3.0217614384689373,-0.8094337718836649]},"angle":37.25318679046964,"direction":"normal"},{"type":"extrude","id":"e1","name":"extrude_1","sketch":"sketch_1","distance":6.598795556895757}]}]}',
    "gen_s23_00101": '{"schema":"aicad.ir/0","meta":{"name":"gen_s23_00101","description":"revolve[point_touch] 270deg on XY normal"},"units":{"length":"mm","angle":"deg"},"parts":[{"id":"p1","name":"part_1","features":[{"type":"sketch","id":"s1","name":"sketch_1","plane":"XY","curves":[{"kind":"line","id":"l1","start":[13.635727373037279,-7.5611890685511876],"end":[13.63572737303728,14.512467698019943]},{"kind":"line","id":"l3","start":[-0.5980372496422646,6.796202100185187],"end":[13.635727373037279,-7.5611890685511876]},{"kind":"line","id":"l2","start":[-0.5980372496422646,6.796202100185187],"end":[13.63572737303728,14.512467698019943]}]},{"type":"revolve","id":"r1","name":"revolve_1","sketch":"sketch_1","axis":{"origin":[-0.5980372496422635,24.773906399888883],"direction":[4.638006018643589e-17,0.7574438641202915]},"angle":270.0,"direction":"normal"}]}]}',
    "gen_s23_00116": '{"schema":"aicad.ir/0","meta":{"name":"gen_s23_00116","description":"revolve[point_touch+horn_torus] 45deg on frame symmetric"},"units":{"length":"mm","angle":"deg"},"parts":[{"id":"p1","name":"part_1","features":[{"type":"sketch","id":"s1","name":"sketch_1","plane":{"origin":[-33.47781058479853,-42.80632652421254,-38.97205065329851],"normal":[-0.25198856332743597,-0.9480674678646277,-0.13776635047628272],"x_dir":[0.941935404940926,-0.2777756537582326,0.18867532721042357]},"curves":[{"kind":"line","id":"l3","start":[-15.93292085321552,26.517351496798145],"end":[-29.40053654836551,28.29400866979981]},{"kind":"circle","id":"c4","center":[-7.060865585521234,5.963135584339831],"radius":8.848984452602354},{"kind":"line","id":"l2","start":[-29.40053654836551,28.29400866979981],"end":[-14.642557766542826,14.352605605780559]},{"kind":"line","id":"l1","start":[-14.642557766542826,14.352605605780559],"end":[-15.93292085321552,26.517351496798145]}]},{"type":"revolve","id":"r1","name":"revolve_1","sketch":"sketch_1","axis":{"origin":[-10.867169289834395,21.73189371756155],"direction":[-0.629498807912848,0.5946679243259323]},"angle":45.0,"direction":"symmetric"}]}]}',
    "gen_s23_00159": '{"schema":"aicad.ir/0","meta":{"name":"gen_s23_00159","description":"revolve[cone] 246.6deg on frame normal"},"units":{"length":"mm","angle":"deg"},"parts":[{"id":"p1","name":"part_1","features":[{"type":"sketch","id":"s1","name":"sketch_1","plane":{"origin":[-18.94358160729014,45.741165330523216,-19.93867085978202],"normal":[-0.3503615961936677,0.44856023153206664,-0.8222168026746497],"x_dir":[0.8703197088720082,-0.16847870970821788,-0.46277265338824536]},"curves":[{"kind":"line","id":"l1","start":[17.449335313913032,28.018706582897217],"end":[7.402868190292725,28.018706582897217]},{"kind":"line","id":"l2","start":[7.402868190292725,7.834024312338311],"end":[17.449335313913032,28.018706582897217]},{"kind":"line","id":"line_03","start":[7.402868190292725,7.834024312338311],"end":[7.402868190292725,28.018706582897217]}]},{"type":"revolve","id":"r1","name":"revolve_1","sketch":"sketch_1","axis":{"origin":[30.504787779054546,28.018706582897217],"direction":[-0.39266677820044843,-0.0]},"angle":246.6483818548231}]}]}',
    "gen_s23_00169": '{"schema":"aicad.ir/0","meta":{"name":"gen_s23_00169","description":"revolve[point_touch] 332.2deg on frame normal"},"units":{"length":"mm","angle":"deg"},"parts":[{"id":"p1","name":"part_1","features":[{"type":"sketch","id":"s1","name":"sketch_1","plane":{"origin":[38.69942221308608,-11.496750995785582,-14.94398149328751],"normal":[-0.003940520206366067,-0.3906908002658517,0.9205135365045599],"x_dir":[-0.2693100382381405,-4.381024256160477,-1.8605778474202963]},"curves":[{"kind":"line","id":"l3","start":[-7.484252406377674,12.591181389549314],"end":[-25.561524950315114,-4.690385227890893]},{"kind":"line","id":"l2","start":[-7.484252406377674,-16.28117340072476],"end":[-7.484252406377674,12.591181389549314]},{"kind":"line","id":"l1","start":[-7.484252406377674,-16.28117340072476],"end":[-25.561524950315114,-4.690385227890893]}]},{"type":"revolve","id":"r1","name":"revolve_1","sketch":"sketch_1","axis":{"origin":[-25.561524950315114,-7.830831156958157],"direction":[2.097390960645417e-16,3.4252993795528677]},"angle":332.18829918579735,"direction":"normal"}]}]}',
}


@pytest.mark.parametrize("name", sorted(V1_PROGRAMS))
def test_v1_point_touch_revolves_evaluate_and_export(name, tmp_path):
    doc = json.loads(V1_PROGRAMS[name])
    fr = assert_match(doc, tmp_path)
    assert fr["status"] == "ok"
    src = tmp_path / f"{name}.json"
    out = tmp_path / f"{name}.3mf"
    proc = subprocess.run([str(forge_bin()), "export", str(src), "--out", str(out)],
                          capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, proc.stderr
    assert out.is_file() and out.stat().st_size > 0


# ---- L6: [R-12] per report, independent of the other engine -------------------------------------

def _metrics(valid=True, status="ok", drop_valid=False):
    """A minimal `aicad.metrics/0` report: sketch + extrude of a 10 mm cube."""
    feat = {"part": "p1", "feature": "e1", "type": "extrude", "status": status}
    if status == "ok":
        body = {"volume": 1000.0, "area": 600.0, "centroid": [5.0, 5.0, 5.0],
                "bbox_min": [0.0, 0.0, 0.0], "bbox_max": [10.0, 10.0, 10.0], "faces": 6, "edges": 12,
                "face_types": {"plane": 6}, "edge_types": {"line": 12}, "valid": valid}
        if drop_valid:
            del body["valid"]
        feat["bodies"] = [body]
    else:
        feat["error"] = {"code": "EXTRUDE_SELF_INTERSECTION", "message": "x"}
    return {"schema": "aicad.metrics/0", "engine": "x", "document": "d",
            "status": "ok" if status == "ok" else "error",
            "features": [{"part": "p1", "feature": "s1", "type": "sketch", "status": "ok",
                          "regions": [{"area": 100.0, "loops": 1, "outer_curves": ["a", "b", "c", "d"]}]},
                         feat]}


REJECTED = {"schema": "aicad.metrics/0", "engine": "x", "document": "d", "status": "error",
            "error": {"code": "IR_SCHEMA", "message": "x"}, "features": []}

INVALID = {"valid=false": dict(valid=False), "valid=null": dict(valid=None), "valid missing": dict(drop_valid=True),
           "valid=1": dict(valid=1)}


@pytest.mark.parametrize("how", sorted(INVALID))
@pytest.mark.parametrize("side", ["forge", "oracle"])
def test_r12_invalid_ok_body_is_silent_wrong_when_both_are_ok(side, how):
    bad = _metrics(**INVALID[how])
    a, b = (bad, _metrics()) if side == "forge" else (_metrics(), bad)
    cmp = compare_reports(a, b, "forge", "oracle")
    assert cmp.classification == SILENT_WRONG, cmp.differences
    assert any("[R-12]" in d.detail and d.detail.startswith(side) for d in cmp.differences), cmp.differences


@pytest.mark.parametrize("other", ["feature error", "rejected document"])
@pytest.mark.parametrize("side", ["forge", "oracle"])
def test_r12_holds_even_when_the_other_engine_failed(side, other):
    # compare_features returns on the status mismatch (ROBUSTNESS) before any body is compared, and
    # compare_reports returns early on a one-sided rejection: [R-12] must not depend on either.
    failed = _metrics(status="error") if other == "feature error" else REJECTED
    for valid, want in ((True, ROBUSTNESS), (False, SILENT_WRONG)):
        ok = _metrics(valid=valid)
        a, b = (ok, failed) if side == "forge" else (failed, ok)
        cmp = compare_reports(a, b, "forge", "oracle")
        assert cmp.classification == want, (valid, cmp.differences)


def test_r12_both_valid_still_matches():
    assert compare_reports(_metrics(), _metrics(), "forge", "oracle").classification == MATCH


# ---- Profiles OCCT cannot revolve: Forge against closed forms -----------------------------------

HORN_CUT = [C("c", (5, 0), 5.0000005)]  # crosses the axis by 5e-7 < the IR tolerance: a horn torus
ARROW = [L("e0", (0, 0), (5, 5)), L("e1", (5, 5), (0, 10)), L("e2", (0, 10), (3, 5)), L("e3", (3, 5), (0, 0))]
SPHERE_PINCH = [A("a", (0, -5), (0, 5), (0, 0), ccw=True), L("l1", (0, 5), (3, 0)), L("l2", (3, 0), (0, -5))]


def _frame_y(plane) -> list[float]:
    """World direction of the sketch y axis (the revolve axis here)."""
    if plane == "XZ":
        return [0.0, 0.0, 1.0]
    n, x = plane["normal"], plane["x_dir"]
    y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]]
    ny = math.sqrt(sum(c * c for c in y))
    return [c / ny for c in y]


def _origin(plane) -> list[float]:
    return [0.0, 0.0, 0.0] if plane == "XZ" else [float(c) for c in plane["origin"]]


# name: (profile, ∫ρ dA, ∫ρ ds of the swept curves, axial centroid at 360°, profile area, rel tol);
# Pappus: V = θ·∫ρ dA, A = θ·∫ρ ds + 2·(profile area) below 360°.
OCCT_FAILS = {
    # Horn torus R = r = 5: ∫ρ dA = πr²·R, ∫ρ ds = 2πr·R. Tolerance 1e-6: the profile radius
    # 5.0000005 is snapped to the axis within the IR linear tolerance.
    "horncut": (HORN_CUT, 125 * math.pi, 50 * math.pi, 0.0, 25 * math.pi, 1e-6),
    # Triangle (0,0),(5,5),(0,10) minus (0,0),(3,5),(0,10): ∫ρ dA = 25·5/3 − 15·1.
    "arrow": (ARROW, 80 / 3, 25 * math.sqrt(2) + 3 * math.sqrt(34), 5.0, 10.0, 1e-10),
    # Half disc r = 5 minus triangle (0,5),(3,0),(0,−5): ∫ρ dA = 2r³/3 − 15.
    "spherepinch": (SPHERE_PINCH, 250 / 3 - 15, 50 + 3 * math.sqrt(34), 0.0, 12.5 * math.pi - 15, 1e-10),
}


@pytest.mark.parametrize("plane", ["XZ", "T1"])
@pytest.mark.parametrize("angle", [360, 200, 359.9999999])
@pytest.mark.parametrize("name", sorted(OCCT_FAILS))
def test_profiles_occt_cannot_revolve_match_closed_forms(name, angle, plane, tmp_path):
    profile, moment, curve_moment, axial, cap, rel = OCCT_FAILS[name]
    frame = "XZ" if plane == "XZ" else T1
    doc = revolve_doc(f"{name}_{plane}_{angle}", profile, angle, plane=frame)
    fr = forge_report(doc, tmp_path)
    b = body_of(fr)
    theta = math.radians(angle)
    caps = 0.0 if angle == 360 else 2 * cap
    assert b["volume"] == pytest.approx(theta * moment, rel=rel)
    assert b["area"] == pytest.approx(theta * curve_moment + caps, rel=rel)
    if angle == 360:
        y, o = _frame_y(frame), _origin(frame)
        want = [o[k] + axial * y[k] for k in range(3)]
        assert b["centroid"] == pytest.approx(want, abs=1e-9)
    # The oracle cannot check Forge here, but must not contradict it.
    orc = evaluate_data(doc, doc["meta"]["name"])
    assert compare_reports(fr, orc, "forge", "oracle").classification in (MATCH, ROBUSTNESS)
