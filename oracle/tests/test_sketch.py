"""SPEC §3: loop assembly, errors, crossings, nesting, regions, canonical order (pure 2D)."""

import math
import random

import pytest

from aicad_oracle.ir import parse_document
from aicad_oracle.sketch import SketchError, evaluate_sketch, signed_extent

from helpers import A, C, L, doc, rect, sketch


def curves_of(raw):
    d = parse_document(doc(sketch(raw)))
    return list(d.parts[0].features[0].curves)


def ev(raw):
    return evaluate_sketch(curves_of(raw))


def code_of(raw):
    with pytest.raises(SketchError) as ei:
        ev(raw)
    return ei.value.code


# --- loop assembly ---------------------------------------------------------------------------

def test_rectangle_forms_one_loop_one_region():
    res = ev(rect("", -40, -25, 40, 25))
    assert len(res.loops) == 1 and len(res.regions) == 1
    r = res.regions[0]
    assert r.area == pytest.approx(4000.0, rel=1e-15)
    assert r.loops == 1
    assert r.outer_curves == ["b", "l", "r", "t"]


def test_loop_assembly_ignores_curve_order_and_direction():
    raw = rect("", 0, 0, 3, 2)
    rng = random.Random(4)
    for _ in range(20):
        shuffled = [dict(c) for c in raw]
        rng.shuffle(shuffled)
        for c in shuffled:
            if rng.random() < 0.5:
                c["start"], c["end"] = c["end"], c["start"]
        res = ev(shuffled)
        assert len(res.loops) == 1
        assert res.regions[0].area == pytest.approx(6.0)


def test_endpoints_within_tolerance_are_coincident():
    raw = rect("", 0, 0, 10, 10)
    raw[1]["start"] = [10 + 4e-7, 3e-7]  # |Δ| = 5e-7 < 1e-6
    assert len(ev(raw).loops) == 1


def test_coincidence_is_inclusive_at_exactly_tol():
    # the gap between c's end (0,0) and a's start (1e-6,0) is exactly 1e-6 in binary64 [R-3]
    raw = [L("a", (1e-6, 0), (10, 0)), L("b", (10, 0), (0, 5)), L("c", (0, 5), (0, 0))]
    assert math.hypot(1e-6, 0.0) == 1e-6
    assert len(ev(raw).loops) == 1
    raw[0]["start"] = [1.0000001e-6, 0]
    assert code_of(raw) == "SKETCH_OPEN_LOOP"


def test_two_curve_line_arc_loop_is_valid():
    raw = [A("arc", (5, 0), (-5, 0), (0, 0), True), L("chord", (-5, 0), (5, 0))]
    res = ev(raw)
    assert res.regions[0].area == pytest.approx(math.pi * 25 / 2, rel=1e-14)


def test_arc_ccw_flag_selects_the_side():
    ccw = ev([A("a", (10, 0), (0, 10), (0, 0), True), L("l1", (0, 10), (0, 0)), L("l2", (0, 0), (10, 0))])
    cw = ev([A("a", (10, 0), (0, 10), (0, 0), False), L("l1", (0, 10), (0, 0)), L("l2", (0, 0), (10, 0))])
    assert ccw.regions[0].area == pytest.approx(math.pi * 100 / 4, rel=1e-14)
    assert cw.regions[0].area == pytest.approx(3 * math.pi * 100 / 4, rel=1e-14)


def test_circle_split_into_arcs_on_the_same_circle():
    raw = [A("a1", (5, 0), (-5, 0), (0, 0)), A("a2", (-5, 0), (0, -5), (0, 0)), A("a3", (0, -5), (5, 0), (0, 0))]
    assert ev(raw).regions[0].area == pytest.approx(25 * math.pi, rel=1e-14)


def test_slot_with_tangent_joins_is_valid():
    raw = [
        L("lower", (-20, -6), (20, -6)),
        A("right_cap", (20, -6), (20, 6), (20, 0), True),
        L("upper", (20, 6), (-20, 6)),
        A("left_cap", (-20, 6), (-20, -6), (-20, 0), True),
    ]
    assert ev(raw).regions[0].area == pytest.approx(40 * 12 + math.pi * 36, rel=1e-14)


# --- error codes -----------------------------------------------------------------------------

def test_open_loop():
    assert code_of(rect("", 0, 0, 10, 10)[:3]) == "SKETCH_OPEN_LOOP"


def test_open_loop_when_gap_exceeds_tolerance():
    raw = rect("", 0, 0, 10, 10)
    raw[1]["start"] = [10 + 2e-6, 0]
    assert code_of(raw) == "SKETCH_OPEN_LOOP"


def test_branching():
    raw = rect("", 0, 0, 10, 10) + [L("spur", (10, 10), (20, 20)), L("spur2", (20, 20), (10, 10))]
    assert code_of(raw) == "SKETCH_BRANCHING"


def test_crossing_bowtie():
    raw = [L("a", (0, 0), (10, 10)), L("b", (10, 10), (10, 0)), L("c", (10, 0), (0, 10)), L("d", (0, 10), (0, 0))]
    assert code_of(raw) == "SKETCH_CURVES_CROSS"


def test_crossing_between_loops():
    assert code_of(rect("a", 0, 0, 10, 10) + rect("b", 5, 5, 15, 15)) == "SKETCH_CURVES_CROSS"


def test_touching_circle_is_a_crossing():
    # circle tangent to the inside of the rectangle's bottom edge
    assert code_of(rect("", 0, 0, 10, 10) + [C("c", (5, 3), 3)]) == "SKETCH_CURVES_CROSS"
    # tangent circles from outside
    assert code_of([C("c1", (0, 0), 3), C("c2", (5, 0), 2)]) == "SKETCH_CURVES_CROSS"
    # identical circles
    assert code_of([C("c1", (0, 0), 3), C("c2", (0, 0), 3)]) == "SKETCH_CURVES_CROSS"


def test_touch_within_tolerance_is_a_crossing():
    assert code_of(rect("", 0, 0, 10, 10) + [C("c", (5, 3 + 5e-7), 3)]) == "SKETCH_CURVES_CROSS"
    # 2e-6 away: not touching
    assert len(ev(rect("", 0, 0, 10, 10) + [C("c", (5, 3 + 2e-6), 3)]).regions) == 1


def test_vertex_touching_another_loop_is_a_crossing():
    tri = [L("t1", (5, 0), (8, -5)), L("t2", (8, -5), (2, -5)), L("t3", (2, -5), (5, 0))]
    assert code_of(rect("", 0, 0, 10, 10) + tri) == "SKETCH_CURVES_CROSS"


def test_collinear_overlap_in_one_loop_is_a_crossing():
    raw = [L("a", (0, 0), (10, 0)), L("b", (10, 0), (5, 0)), L("c", (5, 0), (5, 5)), L("d", (5, 5), (0, 0))]
    assert code_of(raw) == "SKETCH_CURVES_CROSS"


def test_line_arc_segment_below_its_chord_is_valid():
    # A line + arc loop can only meet at its two shared endpoints: a circular segment.
    raw = [L("l", (0, 0), (10, 0)), A("a", (10, 0), (0, 0), (5, 1), False)]
    r = math.hypot(5, 1)
    # clockwise from (10,0) to (0,0) about (5,1) is the minor arc below the chord
    theta = 2 * math.atan2(5, 1)
    res = ev(raw)
    assert res.regions[0].area == pytest.approx(r * r * (theta - math.sin(theta)) / 2, rel=1e-13)


def test_arc_crossing_a_line_of_its_own_loop():
    # the clockwise arc from (10,5) to (0,0) about (5,2.5) dips below y = 0 and meets the
    # first line at (10,0), which is not an endpoint the arc shares with that line
    raw = [L("l1", (0, 0), (10, 0)), L("l2", (10, 0), (10, 5)), A("a", (10, 5), (0, 0), (5, 2.5), False)]
    assert code_of(raw) == "SKETCH_CURVES_CROSS"


def test_overlapping_arcs_on_the_same_circle():
    raw = [
        A("a1", (5, 0), (-5, 0), (0, 0)), A("a2", (-5, 0), (5, 0), (0, 0)),  # a full circle ...
        A("b1", (0, 5), (0, -5), (0, 0)), L("bl", (0, -5), (0, 5)),  # ... overlapped by another arc
    ]
    assert code_of(raw) in ("SKETCH_CURVES_CROSS", "SKETCH_BRANCHING")


# --- nesting, regions and ordering -----------------------------------------------------------

def test_holes_and_islands_nest_by_depth():
    raw = [C("outer", (0, 0), 30), C("hole", (0, 0), 20), C("island", (0, 0), 10), C("far", (100, 0), 5)]
    res = ev(raw)
    names = [r.outer_curves for r in res.regions]
    assert names == [["far"], ["island"], ["outer"]]
    by = {r.outer_curves[0]: r for r in res.regions}
    assert by["outer"].loops == 2
    assert by["outer"].area == pytest.approx(math.pi * (900 - 400))
    assert by["island"].loops == 1 and by["far"].loops == 1


def test_plate_with_four_holes():
    raw = rect("", 0, 0, 100, 60) + [C(f"h{i}", c, 2.75) for i, c in enumerate([(10, 10), (90, 10), (90, 50), (10, 50)])]
    (r,) = ev(raw).regions
    assert r.loops == 5
    assert r.area == pytest.approx(6000 - 4 * math.pi * 2.75**2, rel=1e-14)


def test_canonical_order_is_lexicographic_on_sorted_ids():
    raw = [C("c2", (0, 0), 1), C("c10", (10, 0), 1), C("b9", (20, 0), 1)] + rect("z", 30, 0, 32, 2)
    raw += [L("a0", (40, 0), (42, 0)), L("zz", (42, 0), (41, 2)), L("m", (41, 2), (40, 0))]
    res = ev(raw)
    assert [r.outer_curves for r in res.regions] == [
        ["a0", "m", "zz"], ["b9"], ["c10"], ["c2"], ["zb", "zl", "zr", "zt"],
    ]


def test_revolve_signed_extent_includes_arc_extremes():
    raw = [A("a", (0, -5), (0, 5), (0, 0), True), L("l", (0, 5), (0, -5))]
    res = ev(raw)
    lo, hi = signed_extent(curves_of(raw), res.regions[0].outer, (0, 0), (0, 1))
    assert lo == pytest.approx(-5.0) and hi == pytest.approx(0.0, abs=1e-12)
