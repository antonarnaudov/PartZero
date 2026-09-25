"""Modelled threads in the oracle (SPEC-v1 §6.13, §8.3 rule 9): the standards table, the swept
groove tool against its closed form, and the rule-9 type normalization of the comparison."""

import math

from aicad_oracle.v1 import threads
from aicad_oracle.v1.compare import _rule4_match, _THREAD_TYPES


def test_standard_designations_normalize_like_forge():
    assert threads.standard("M8")["designation"] == "M8"
    assert threads.standard("m8 x 1.25")["designation"] == "M8"  # the coarse pitch names the coarse row
    assert threads.standard("M8x1")["designation"] == "M8x1"
    unf = threads.standard("1/2-20 unf")
    assert unf["designation"] == "1/2-20 UNF"
    assert abs(unf["major"] - 12.7) < 1e-12 and abs(unf["pitch"] - 1.27) < 1e-12
    assert threads.standard("M7.5") is None
    assert threads.standard("M8x0.9") is None


def test_crest_range_matches_the_basic_profile():
    nut = threads.form_of(8.0, 1.25, 1, True, True)
    lo, hi = nut.crest_range()
    # A nut's crest lies between the flanks' reach and the root flat below the major diameter.
    assert lo < nut.minor < hi < 8.0
    nut.check_crest(6.8)  # the M8 tap drill fits
    bolt = threads.form_of(8.0, 1.25, 1, True, False)
    blo, bhi = bolt.crest_range()
    assert bolt.minor < blo < 8.0 <= bhi


def test_the_swept_groove_matches_its_closed_form():
    form = threads.form_of(8.0, 1.25, 1, True, True)
    rc = 3.4
    tools = threads.groove_tool("t", None, 0, form, rc, (0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0), 0.0, 5.0, [])
    assert len(tools) == 1
    crest_flat = form.pitch - form.width(rc)
    rin = rc - 0.4 * crest_flat / (2.0 * threads.TAN30)
    exact = 5.0 * 2.0 * math.pi / form.pitch * threads._moment(form, rin, form.rr)
    v = tools[0].body_metrics()["volume"]
    assert abs(v - exact) <= threads.THREAD_GATE_REL * exact
    keys = sorted(f.key for f in tools[0].faces)
    assert "t/thread_upper" in keys and "t/thread_lower" in keys and "t/thread_root" in keys


def test_rule_9_normalizes_helicoid_and_helix_types_only():
    ft, et = _THREAD_TYPES["face_types"], _THREAD_TYPES["edge_types"]
    forge = {"cylinder": 2, "helicoid": 2, "plane": 6}
    occt = {"bspline": 3, "cylinder": 1, "plane": 6}
    assert _rule4_match(forge, occt, ft)
    assert not _rule4_match(forge, {"bspline": 3, "cylinder": 1, "plane": 5, "cone": 1}, ft)
    assert _rule4_match({"circle": 4, "helix": 8, "line": 12}, {"bspline": 11, "circle": 1, "line": 12}, et)
    assert not _rule4_match({"circle": 4, "helix": 8, "line": 12}, {"bspline": 12, "line": 12, "circle": 1}, et)
