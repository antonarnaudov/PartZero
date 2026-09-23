"""The oracle's independent constraint checker (`aicad_oracle.v1.constraints`, SPEC-v1 §4.3, §4.4,
§8.1): one test per row of the §4.3 constraint table — a satisfied configuration passes, the same
configuration perturbed by more than `SOLVE_CHECK_TOLERANCE` fails *on that constraint* — plus the
semantics forge-solve's model adds (tangency mode decided from the guess, first-order tangency at
a joint, `fix` holding the coordinates `x`/`y` do not give), the §4.4 rule 4 fixed point, and
seeded property tests (random exact constructions pass; a random perturbation that breaks one
constraint is detected)."""

from __future__ import annotations

import copy
import math
import random

import pytest

from aicad_oracle.v1 import constraints as C
from aicad_oracle.v1.consts import SOLVE_CHECK_TOLERANCE, SOLVE_TOLERANCE

TOL = SOLVE_CHECK_TOLERANCE
EPS = 1e-7  # a perturbation 100× the check tolerance


def line(i, a, b, **kw):
    return {"kind": "line", "id": i, "start": [float(a[0]), float(a[1])], "end": [float(b[0]), float(b[1])], **kw}


def arc(i, s, e, c, ccw=True):
    return {"kind": "arc", "id": i, "start": [float(s[0]), float(s[1])], "end": [float(e[0]), float(e[1])],
            "center": [float(c[0]), float(c[1])], "ccw": ccw}


def circ(i, c, r):
    return {"kind": "circle", "id": i, "center": [float(c[0]), float(c[1])], "radius": float(r)}


def pt(i, p):
    return {"kind": "point", "id": i, "at": [float(p[0]), float(p[1])]}


def con(t, i="k", **kw):
    return {"type": t, "id": i, **kw}


def check(cons, stored, solved=None, values=None, tol=TOL):
    return C.check(cons, values or {}, stored, copy.deepcopy(stored if solved is None else solved), tol)


def moved(curves, cid, key, dx=0.0, dy=0.0):
    out = copy.deepcopy(curves)
    for c in out:
        if c["id"] == cid:
            if key == "radius":
                c["radius"] += dx
            else:
                c[key] = [c[key][0] + dx, c[key][1] + dy]
    return out


def assert_row(cons, stored, perturbed, values=None, cid="k"):
    ok = check(cons, stored, values=values)
    assert ok.ok, ok.failures
    bad = check(cons, stored, perturbed, values=values)
    assert not bad.ok
    assert any(f.startswith(f"constraint {cid} ") for f in bad.failures), bad.failures


# ---------------------------------------------------------------------------------------------
# One test per row of the §4.3 table
# ---------------------------------------------------------------------------------------------

def test_coincident():
    s = [pt("p", (1, 2)), pt("q", (1, 2))]
    assert_row([con("coincident", a="p", b="q")], s, moved(s, "q", "at", EPS))


@pytest.mark.parametrize("t, d", [("horizontal", (0, EPS)), ("vertical", (EPS, 0))])
def test_horizontal_vertical(t, d):
    s = [line("l", (0, 0), (10, 0) if t == "horizontal" else (0, 10))]
    assert_row([con(t, line="l")], s, moved(s, "l", "end", *d))


def test_parallel_and_perpendicular():
    s = [line("a", (0, 0), (10, 0)), line("b", (0, 5), (10, 5)), line("c", (20, 0), (20, 10))]
    assert_row([con("parallel", a="a", b="b")], s, moved(s, "b", "end", 0, EPS))
    assert_row([con("perpendicular", a="a", b="c")], s, moved(s, "c", "end", EPS, 0))
    # anti-parallel is parallel
    assert check([con("parallel", a="a", b="b")], [s[0], line("b", (10, 5), (0, 5)), s[2]]).ok


def test_angular_residuals_use_the_guess_scale_and_bound_the_solved_size():
    """An angular error of 1e-11 rad on 1 mm guess lines passes (1e-11 mm at the solver's scale)
    even when a dimension grew them to 50 mm (5e-10 mm at the solved size) — measuring with the
    solved lengths would reject a converged solve; 1e-8 rad fails."""
    g = [line("a", (0, 0), (1, 0)), line("b", (0, 2), (1, 2))]
    for ang, ok in ((1e-11, True), (1e-8, False)):
        s = [line("a", (0, 0), (50, 0)), line("b", (0, 2), (50, 2 + 50 * ang))]
        assert check([con("parallel", a="a", b="b")], g, s).ok is ok
    # the natural measure: off by more than tol (1e-6 mm) at the solved size while the
    # guess-scaled check passes (a 1 µm guess grown to 100 mm) is not a failure — §8.1 states only
    # the check measure — but the ROBUSTNESS note ORACLE_REPLAY_SIZE_BOUND
    tiny = [line("a", (0, 0), (1e-3, 0)), line("b", (0, 1), (1e-3, 1))]
    big = [line("a", (0, 0), (100, 0)), line("b", (0, 1), (100, 1 + 100 * 5e-7))]
    r = check([con("parallel", a="a", b="b")], tiny, big)
    assert r.ok, r.failures
    assert [c for c, _ in r.notes] == ["ORACLE_REPLAY_SIZE_BOUND"] and "at the solved size" in r.notes[0][1]
    # within tol at the solved size: no note; beyond the check tolerance: a failure, not a note
    ok = [line("a", (0, 0), (100, 0)), line("b", (0, 1), (100, 1 + 100 * 5e-9))]
    assert check([con("parallel", a="a", b="b")], tiny, ok).notes == []
    worse = [line("a", (0, 0), (100, 0)), line("b", (0, 1), (100, 1 + 100 * 5e-6))]
    r = check([con("parallel", a="a", b="b")], tiny, worse)
    assert not r.ok and r.notes == [], (r.failures, r.notes)


def test_tangent_line_circle():
    s = [line("l", (-10, 5), (10, 5)), circ("c", (0, 0), 5)]
    assert_row([con("tangent", a="l", b="c")], s, moved(s, "c", "radius", EPS))
    assert_row([con("tangent", a="c", b="l")], s, moved(s, "l", "start", 0, EPS))


def _joint(ccw=False):
    # a line ending at the top of a circle of r = 5, then a quarter arc down to (5, 0)
    return [line("l", (-10, 5), (0, 5)), arc("a", (0, 5), (5, 0), (0, 0), ccw=False) if not ccw
            else arc("a", (5, 0), (0, 5), (0, 0), ccw=True)]


@pytest.mark.parametrize("ccw", [False, True])
def test_tangent_line_arc_at_a_joint_is_first_order(ccw):
    """At a joint the distance condition is only second order: rotating the line about the joint
    by 1e-8 rad moves the distance by ~1e-16 mm. The first-order condition (line ⟂ radius at the
    joint) catches it."""
    s = _joint(ccw)
    cons = [con("tangent", a="l", b="a")]
    assert check(cons, s).ok
    rot = moved(s, "l", "start", 0, 10 * 1e-8)
    c, r = (0.0, 0.0), 5.0
    a, b = rot[0]["start"], rot[0]["end"]
    assert abs(abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / math.dist(a, b) - r) < 1e-12
    bad = check(cons, s, rot)
    assert not bad.ok and any(f.startswith("constraint k ") for f in bad.failures), bad.failures


def test_tangent_line_arc_joint_through_a_coincident_constraint():
    s = [line("l", (-10, 5), (0, 5)), arc("a", (0, 5 + 1e-3), (5, 0), (0, 0), ccw=False)]  # not welded
    s[1]["start"] = [0.0, 5.0 + 1e-3]
    cons = [con("coincident", "j", a="l.end", b="a.start"), con("tangent", a="l", b="a")]
    j = C.joints_of(s, cons)
    assert j.between(["l.start", "l.end"], ["a.start", "a.end"]) == [("l.end", "a.start")]
    assert C.joints_of(s, [cons[1]]).between(["l.start", "l.end"], ["a.start", "a.end"]) == []


def test_tangent_arc_arc_at_a_joint():
    # two quarter arcs meeting at (5, 0) with collinear radii (an S-curve, external)
    s = [arc("a", (0, 5), (5, 0), (0, 0), ccw=False), arc("b", (5, 0), (10, -5), (10, 0), ccw=True)]
    cons = [con("tangent", a="a", b="b")]
    assert check(cons, s).ok
    # the second arc's centre moved along its own circle direction: radii no longer collinear
    bent = copy.deepcopy(s)
    bent[1]["center"] = [10.0, EPS * 100]
    bent[1]["end"] = [10.0 + 0.0, -5.0 + EPS * 100]
    assert not check(cons, s, bent).ok


def _s_curve():
    """The reviewer's case: two r = 10 arcs welded at (10, 0), externally tangent (d = r1 + r2)."""
    return [arc("a1", (0, -10), (10, 0), (0, 0), ccw=True), arc("a2", (10, 0), (20, 10), (20, 0), ccw=False)]


@pytest.mark.parametrize("internal, note", [(None, False), (False, False), (True, True)])
def test_tangent_arc_arc_at_a_joint_has_no_mode(internal, note):
    """forge-solve (`system.rs`, `TangentCurvesAt`) checks only the collinear radii at an arc–arc
    joint and ignores `internal`, so a result that follows it exactly — here the welded guess, a
    clear fixed point it returns unchanged — is never a failure; a mode other than `internal` /
    the guess rule is the ROBUSTNESS note ORACLE_TANGENCY_MODE_DIFFERS."""
    s = _s_curve()
    cons = [con("tangent", a="a1", b="a2", **({} if internal is None else {"internal": internal}))]
    r = check(cons, s)
    assert r.ok, r.failures
    assert [c for c, _ in r.notes] == (["ORACLE_TANGENCY_MODE_DIFFERS"] if note else [])
    if note:
        assert "externally tangent" in r.notes[0][1] and "`internal: true`" in r.notes[0][1]
    chk, clear = C.fixed_point(cons, {}, s, SOLVE_TOLERANCE)
    assert chk.ok and clear  # rule 4: Forge must return it bit for bit, whatever `internal` says
    # the first-order condition is still checked: the second arc rotated about the joint by 1e-6 rad
    # (the distance moves only to second order) fails on the constraint
    rot = copy.deepcopy(s)
    ca, sa = math.cos(1e-6), math.sin(1e-6)
    for key in ("end", "center"):
        x, y = rot[1][key][0] - 10.0, rot[1][key][1]
        rot[1][key] = [10.0 + ca * x - sa * y, sa * x + ca * y]
    bad = check(cons, s, rot)
    assert not bad.ok and any(f.startswith("constraint k ") for f in bad.failures), bad.failures


def test_tangent_arc_arc_joint_solved_in_the_other_mode_than_the_guess_rule():
    """The reviewer's second case: guess radii at 80° (r1 = 10, r2 = 5, external by the guess
    rule); a valid collinear internal solution (c2 = (5, 0)) is accepted, with the mode note."""
    th = math.radians(80.0)
    c2g = (10.0 - 5.0 * math.cos(th), -5.0 * math.sin(th))
    guess = [arc("a", (0, 10), (10, 0), (0, 0), ccw=False),
             arc("b", (10, 0), (c2g[0] + 5.0 * math.cos(th + 1.0), c2g[1] + 5.0 * math.sin(th + 1.0)), c2g)]
    cons = [con("tangent", a="a", b="b")]
    assert not C.curve_tangency_internal(cons[0], C.Geometry(C.entities_of(guess)))
    assert not C.fixed_point(cons, {}, guess, SOLVE_TOLERANCE)[0].ok
    solved = [guess[0], arc("b", (10, 0), (5, 5), (5, 0))]
    r = check(cons, guess, solved)
    assert r.ok, r.failures
    assert [c for c, _ in r.notes] == ["ORACLE_TANGENCY_MODE_DIFFERS"] and "guess rule" in r.notes[0][1]


@pytest.mark.parametrize("c2, internal", [((5, 0), False), ((2, 0), True)])
def test_tangent_circle_circle_external_and_internal(c2, internal):
    r2 = 2 if not internal else 3
    s = [circ("a", (0, 0), 3 if not internal else 5), circ("b", c2, r2)]
    for flag in (None, internal):
        cons = [con("tangent", a="a", b="b", **({} if flag is None else {"internal": flag}))]
        assert_row(cons, s, moved(s, "b", "radius", EPS))
    # the other mode, forced, does not hold on this geometry
    assert not check([con("tangent", a="a", b="b", internal=not internal)], s).ok


def test_tangent_mode_omitted_is_decided_from_the_guess_and_a_flip_is_detected():
    """forge-solve (model.rs, adopted by §4.3): internal iff, in the input geometry, the centre
    distance is below the larger radius. A solution that jumped to the other mode fails."""
    guess = [circ("a", (0, 0), 5), circ("b", (2, 0), 3)]  # internal
    external = [circ("a", (0, 0), 5), circ("b", (8, 0), 3)]  # d = r1 + r2
    cons = [con("tangent", a="a", b="b")]
    assert C.curve_tangency_internal(cons[0], C.Geometry(C.entities_of(guess)))
    r = check(cons, guess, external)
    assert not r.ok and any(f.startswith("constraint k ") for f in r.failures), r.failures
    # and the other way round
    assert not check(cons, external, guess).ok
    assert check(cons, external).ok


def test_equal():
    s = [line("a", (0, 0), (10, 0)), line("b", (0, 5), (10, 5)), circ("c", (30, 0), 2), circ("d", (40, 0), 2)]
    assert_row([con("equal", a="a", b="b")], s, moved(s, "b", "end", EPS))
    assert_row([con("equal", a="c", b="d")], s, moved(s, "d", "radius", EPS))


def test_distance_point_point_and_point_line():
    s = [pt("p", (0, 0)), pt("q", (3, 4)), line("l", (-10, 7), (10, 7))]
    assert_row([con("distance", a="p", b="q", value=5)], s, moved(s, "q", "at", EPS), values={"k": 5.0})
    assert_row([con("distance", a="p", b="l", value=7)], s, moved(s, "l", "start", 0, EPS), values={"k": 7.0})
    assert not check([con("distance", a="p", b="q", value=5)], s, values={"k": 5.0 + EPS}).ok


def _rays(deg_b):
    t = math.radians(deg_b)
    return [line("a", (0, 0), (10, 0)), line("b", (0, 0), (10 * math.cos(t), 10 * math.sin(t)))]


@pytest.mark.parametrize("deg", [30.0, 150.0, 210.0, 330.0])
def test_angle_is_counter_clockwise_from_a_to_b(deg):
    s = _rays(deg)
    k = [con("angle", a="a", b="b", value=deg)]
    assert check(k, s, values={"k": deg}).ok
    assert not check(k, s, values={"k": 360.0 - deg}).ok  # the clockwise reading
    assert not check(k, s, values={"k": deg + 1e-7}).ok
    # 0 and 360 are the same direction
    assert check(k, _rays(0.0), values={"k": 360.0}).ok


def test_radius_and_diameter_on_circles_and_arcs():
    s = [circ("c", (0, 0), 4), arc("a", (10, 0), (0, 10), (0, 0))]
    assert_row([con("radius", curve="c", value=4)], s, moved(s, "c", "radius", EPS), values={"k": 4.0})
    assert_row([con("diameter", curve="c", value=8)], s, moved(s, "c", "radius", EPS), values={"k": 8.0})
    grown = copy.deepcopy(s)
    grown[1].update(start=[10.0 + EPS, 0.0], end=[0.0, 10.0 + EPS])
    assert_row([con("radius", curve="a", value=10)], s, grown, values={"k": 10.0})


def test_point_on_line_point_on_circle_and_midpoint():
    s = [pt("p", (3, 0)), line("l", (-10, 0), (10, 0)), circ("c", (3, 4), 4), pt("m", (0, 0))]
    assert_row([con("point_on_line", point="p", line="l")], s, moved(s, "p", "at", 0, EPS))
    assert_row([con("point_on_circle", point="p", curve="c")], s, moved(s, "p", "at", 0, EPS))
    assert_row([con("midpoint", point="m", line="l")], s, moved(s, "m", "at", EPS, 0))


def test_symmetric():
    s = [pt("p", (-3, 2)), pt("q", (3, 2)), line("l", (0, -10), (0, 10))]
    assert_row([con("symmetric", a="p", b="q", line="l")], s, moved(s, "q", "at", EPS, 0))  # midpoint off the line
    assert_row([con("symmetric", a="p", b="q", line="l")], s, moved(s, "q", "at", 0, EPS))  # not perpendicular


@pytest.mark.parametrize("given, move", [
    ({}, (EPS, 0)), ({}, (0, EPS)),
    ({"x": 1.0}, (EPS, 0)), ({"x": 1.0}, (0, EPS)),  # x given: y still held at the guess
    ({"y": 2.0}, (0, EPS)), ({"y": 2.0}, (EPS, 0)),  # y given: x still held at the guess
    ({"x": 1.0, "y": 2.0}, (EPS, 0)), ({"x": 1.0, "y": 2.0}, (0, EPS)),
])
def test_fix_point_holds_every_coordinate(given, move):
    """forge-solve's `K::Fix`: a coordinate `x`/`y` does not give is held at its initial value (the
    welded guess), not left free."""
    s = [pt("p", (1, 2))]
    values = {f"k.{c}": v for c, v in given.items()}
    assert_row([con("fix", entity="p", **given)], s, moved(s, "p", "at", *move), values=values)


def test_fix_target_values_differ_from_the_guess():
    s = [pt("p", (1, 2))]
    k = [con("fix", entity="p", x=5.0)]
    assert check(k, s, [pt("p", (5, 2))], values={"k.x": 5.0}).ok
    assert not check(k, s, [pt("p", (5, 3))], values={"k.x": 5.0}).ok


def test_fix_line_and_circle():
    s = [line("l", (0, 0), (10, 0)), circ("c", (5, 5), 2)]
    assert_row([con("fix", entity="l")], s, moved(s, "l", "end", 0, EPS))
    assert_row([con("fix", entity="c")], s, moved(s, "c", "radius", EPS))
    assert_row([con("fix", entity="c")], s, moved(s, "c", "center", EPS))


def test_reference_dimensions_are_measured_not_checked():
    s = [pt("p", (0, 0)), pt("q", (3, 4))]
    r = check([con("distance", a="p", b="q", driving=False)], s)
    assert r.ok and r.dimensions == [{"id": "k", "driving": False, "measured": 5.0}]


def test_arc_rule_and_welds():
    s = [line("l", (0, 0), (10, 0)), arc("a", (10, 0), (0, 10), (0, 0))]
    assert check([], s).ok
    off = moved(s, "a", "end", 0, EPS)  # radially
    assert any(f.startswith("arc a:") for f in check([], s, off).failures)
    split = moved(s, "a", "start", 1e-12)  # welded to l.end in the stored geometry: must stay bit-equal
    assert any("welded ends" in f for f in check([], s, split).failures)


def test_nan_residual_is_a_violation():
    s = [line("a", (0, 0), (10, 0)), line("b", (0, 5), (10, 5))]
    degenerate = [line("a", (0, 0), (0, 0)), line("b", (0, 5), (10, 5))]
    assert not check([con("parallel", a="a", b="b")], s, degenerate).ok


# ---------------------------------------------------------------------------------------------
# §4.4 rule 4: the fixed point
# ---------------------------------------------------------------------------------------------

def test_fixed_point_is_clear_only_with_margin():
    s = [line("l", (0, 0), (10, 0))]
    chk, clear = C.fixed_point([con("horizontal", line="l")], {}, s, SOLVE_TOLERANCE)
    assert chk.ok and clear
    near = [line("l", (0, 0), (10, 0.7e-10))]
    chk, clear = C.fixed_point([con("horizontal", line="l")], {}, near, SOLVE_TOLERANCE)
    assert chk.ok and not clear  # a fixed point, but too close to the threshold to demand bit identity
    far = [line("l", (0, 0), (10, 2e-10))]
    chk, clear = C.fixed_point([con("horizontal", line="l")], {}, far, SOLVE_TOLERANCE)
    assert not chk.ok and not clear


def test_differs_from_reports_every_moved_number():
    s = [line("l", (0, 0), (10, 0)), circ("c", (5, 5), 2)]
    assert C.differs_from(copy.deepcopy(s), s) == []
    assert C.differs_from(moved(s, "l", "end", 0, 1e-15), s) == ["l.end = [10.0, 1e-15] (the fixed point is [10.0, 0.0])"]
    assert len(C.differs_from(moved(s, "c", "radius", 1e-15), s)) == 1
    z = copy.deepcopy(s)
    z[0]["start"] = [-0.0, 0.0]
    assert C.differs_from(z, s) == []  # -0.0 == 0.0


# ---------------------------------------------------------------------------------------------
# Properties (seeded: deterministic)
# ---------------------------------------------------------------------------------------------

def _rect(rng):
    w, h = rng.uniform(1, 100), rng.uniform(1, 100)
    th = rng.uniform(0, 2 * math.pi)
    cx, cy = rng.uniform(-100, 100), rng.uniform(-100, 100)
    u, v = (math.cos(th), math.sin(th)), (-math.sin(th), math.cos(th))
    p = [(cx + sx * w / 2 * u[0] + sy * h / 2 * v[0], cy + sx * w / 2 * u[1] + sy * h / 2 * v[1])
         for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    curves = [line("a", p[0], p[1]), line("b", p[1], p[2]), line("c", p[2], p[3]), line("d", p[3], p[0])]
    cons = [con("perpendicular", "k1", a="a", b="b"), con("perpendicular", "k2", a="b", b="c"),
            con("perpendicular", "k3", a="c", b="d"), con("parallel", "k4", a="a", b="c"),
            con("equal", "k5", a="b", b="d"), con("distance", "k6", a="a.start", b="a.end", value=w),
            con("distance", "k7", a="b.start", b="b.end", value=h),
            con("angle", "k8", a="a", b="b", value=90)]
    return curves, cons, {"k6": w, "k7": h, "k8": 90.0}


@pytest.mark.parametrize("seed", range(40))
def test_property_random_rectangles_pass_and_a_moved_corner_is_detected(seed):
    rng = random.Random(f"v1-constraints/rect/{seed}")
    curves, cons, values = _rect(rng)
    ok = C.check(cons, values, curves, copy.deepcopy(curves), TOL)
    assert ok.ok, ok.failures
    # move one corner (both welded ends at it) by 1e-6 … 1e-2 mm in a random direction
    bad = copy.deepcopy(curves)
    i = rng.randrange(4)
    d = 10 ** rng.uniform(-6, -2)
    t = rng.uniform(0, 2 * math.pi)
    for c, key in ((bad[i], "end"), (bad[(i + 1) % 4], "start")):
        c[key] = [c[key][0] + d * math.cos(t), c[key][1] + d * math.sin(t)]
    r = C.check(cons, values, curves, bad, TOL)
    assert not r.ok and all(f.startswith("constraint k") for f in r.failures), r.failures


@pytest.mark.parametrize("seed", range(40))
def test_property_random_tangent_circles_and_mode_flips(seed):
    rng = random.Random(f"v1-constraints/tangent/{seed}")
    r1, r2 = rng.uniform(1, 50), rng.uniform(1, 50)
    c1 = (rng.uniform(-100, 100), rng.uniform(-100, 100))
    t = rng.uniform(0, 2 * math.pi)
    internal = rng.random() < 0.5
    if internal and abs(r1 - r2) < 0.5:
        r2 = r1 + 1.0
    d = abs(r1 - r2) if internal else r1 + r2
    c2 = (c1[0] + d * math.cos(t), c1[1] + d * math.sin(t))
    s = [circ("a", c1, r1), circ("b", c2, r2)]
    cons = [con("tangent", a="a", b="b")]
    assert check(cons, s).ok
    # a radius change beyond the tolerance is detected
    assert not check(cons, s, moved(s, "b", "radius", rng.choice((-1, 1)) * 10 ** rng.uniform(-7, -2))).ok
    # the other tangency mode (satisfied exactly) is a flip, detected
    d2 = r1 + r2 if internal else abs(r1 - r2)
    flipped = [circ("a", c1, r1), circ("b", (c1[0] + d2 * math.cos(t), c1[1] + d2 * math.sin(t)), r2)]
    if abs(r1 - r2) > 1e-3:
        assert not check(cons, s, flipped).ok


@pytest.mark.parametrize("seed", range(40))
def test_property_random_angles_and_tangent_lines(seed):
    rng = random.Random(f"v1-constraints/angle/{seed}")
    ta, tb = rng.uniform(0, 360), rng.uniform(0, 360)
    la, lb = rng.uniform(1, 100), rng.uniform(1, 100)
    o = (rng.uniform(-50, 50), rng.uniform(-50, 50))

    def ray(i, deg, n):
        r = math.radians(deg)
        return line(i, o, (o[0] + n * math.cos(r), o[1] + n * math.sin(r)))

    s = [ray("a", ta, la), ray("b", tb, lb)]
    val = (tb - ta) % 360.0
    k = [con("angle", a="a", b="b", value=val)]
    assert check(k, s, values={"k": val}).ok
    err = rng.choice((-1, 1)) * 10 ** rng.uniform(-6, 0)  # degrees
    assert not check(k, s, values={"k": (val + err) % 360.0}).ok
    # a line tangent to a random circle
    c, r = (rng.uniform(-50, 50), rng.uniform(-50, 50)), rng.uniform(1, 30)
    phi = rng.uniform(0, 2 * math.pi)
    foot = (c[0] + r * math.cos(phi), c[1] + r * math.sin(phi))
    tdir = (-math.sin(phi), math.cos(phi))
    s2 = [line("l", (foot[0] - 20 * tdir[0], foot[1] - 20 * tdir[1]), (foot[0] + 20 * tdir[0], foot[1] + 20 * tdir[1])),
          circ("c", c, r)]
    assert check([con("tangent", a="l", b="c")], s2).ok
    assert not check([con("tangent", a="l", b="c")], s2, moved(s2, "c", "radius", 10 ** rng.uniform(-7, -1))).ok


@pytest.mark.parametrize("seed", range(40))
def test_property_random_arc_arc_joints(seed):
    """Two arcs welded at a random point with collinear radii, in a random mode: accepted whatever
    `internal` says (a note exactly when it contradicts the mode), and rotating the second arc
    about the joint by a random angle beyond the tolerance is detected on the constraint."""
    rng = random.Random(f"v1-constraints/arc-joint/{seed}")
    p = (rng.uniform(-50, 50), rng.uniform(-50, 50))
    t = rng.uniform(0, 2 * math.pi)
    u = (math.cos(t), math.sin(t))
    r1, r2 = rng.uniform(1, 20), rng.uniform(1, 20)
    internal = rng.random() < 0.5
    if internal and abs(r1 - r2) < 0.5:
        r2 = r1 + 1.0
    c1 = (p[0] - r1 * u[0], p[1] - r1 * u[1])
    c2 = (p[0] - r2 * u[0], p[1] - r2 * u[1]) if internal else (p[0] + r2 * u[0], p[1] + r2 * u[1])

    def on(c, r, ang):
        return (c[0] + r * math.cos(ang), c[1] + r * math.sin(ang))

    a_end = on(c1, r1, t + rng.uniform(0.3, 2.5))
    b_end = on(c2, r2, t + (0.0 if internal else math.pi) + rng.uniform(0.3, 2.5))
    s = [arc("a", a_end, p, c1, ccw=True), arc("b", p, b_end, c2, ccw=True)]
    for flag in (None, False, True):
        cons = [con("tangent", a="a", b="b", **({} if flag is None else {"internal": flag}))]
        r = check(cons, s)
        assert r.ok, (flag, r.failures)
        want_note = flag is not None and flag != internal
        assert [c for c, _ in r.notes] == (["ORACLE_TANGENCY_MODE_DIFFERS"] if want_note else []), (flag, r.notes)
    delta = rng.choice((-1, 1)) * 10 ** rng.uniform(-7, -2)
    ca, sa = math.cos(delta), math.sin(delta)
    rot = copy.deepcopy(s)
    for key in ("end", "center"):
        x, y = rot[1][key][0] - p[0], rot[1][key][1] - p[1]
        rot[1][key] = [p[0] + ca * x - sa * y, p[1] + sa * x + ca * y]
    bad = check([con("tangent", a="a", b="b")], s, rot)
    assert not bad.ok and any(f.startswith("constraint k ") for f in bad.failures), bad.failures
