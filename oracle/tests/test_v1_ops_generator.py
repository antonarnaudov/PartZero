"""W7b: `oracle gen --ir v1 --family …` — every family yields valid `ok` programs whose closed-form
self-checks hold, deterministically; the `classic` family is W7a's generator, unchanged."""

from __future__ import annotations

import random

import pytest

from aicad_oracle.v1.genops import FAMILIES, GROUPS, Check, Ops
from aicad_oracle.v1.generator import Builder, gen_one, generate_program_v1, program_name
from aicad_oracle.v1.jsonio import dumps_canonical

N = 4


@pytest.mark.parametrize("family", ["booleans", "holes", "patterns", "blends"])
def test_family_programs_are_ok_and_pass_their_self_checks(family):
    kinds = set()
    for i in range(N):
        r = gen_one((9, i, 20, family))
        assert r["text"] is not None, [f["message"] for f in r["failures"]]
        assert not [f for f in r["failures"] if f["kind"] == "self_check"], r["failures"]
        # every failing feature is one its group expects to fail (a line contact, a blend or shell
        # drawn above its limit: `Check.code`), or a known OCCT limitation its group names
        # (`Check.engine_limits`, listed as `occt_limited`)
        limited = {(x["feature"], x["code"]) for x in r["occt_limited"]}
        assert all(x[1].startswith("OCCT_") for x in limited)
        assert r["report"]["status"] == "ok" or all(
            f["error"]["code"] in ("BOOLEAN_NO_INTERSECTION", "BOOLEAN_NON_MANIFOLD", "FILLET_RADIUS_TOO_LARGE",
                                   "CHAMFER_DISTANCE_TOO_LARGE", "SHELL_THICKNESS_TOO_LARGE")
            or (f["feature_id"], f["error"]["code"]) in limited
            for f in r["report"]["features"] if f.get("error"))
        assert r["name"] == program_name(9, i, family) and r["name"].startswith(f"gen1{family[0]}_s9_")
        kinds |= {f["type"] for f in r["report"]["features"]}
    want = {"booleans": {"extrude"}, "holes": {"hole"}, "patterns": {"pattern"},
            "blends": {"fillet", "chamfer", "shell"}}[family]
    assert kinds & want


@pytest.mark.parametrize("group", [g for g, _ in GROUPS["ops"]])
def test_every_group_builds_an_ok_program_with_its_closed_form(group):
    from aicad_oracle.v1.evaluate import evaluate_text
    from aicad_oracle.v1.genops import _Retry

    for attempt in range(10):
        b = Builder(random.Random(f"w7b-test/{group}/{attempt}"))
        ops = Ops(b)
        try:
            getattr(ops, group)()
        except _Retry:
            continue
        d = {"schema": "aicad.ir/1", "meta": {"name": group}, "parts": [{"id": "p1", "name": "part", "features": b.features}]}
        if b.part_params:
            d["parts"][0]["params"] = b.part_params
        if b.doc_params:
            d["params"] = b.doc_params
        rep = evaluate_text(dumps_canonical(d), group)
        expected = {c.fid for c in ops.checks if c.code or c.occt_limited(rep)}
        assert not [f for f in rep["features"] if f.get("error") and f["feature_id"] not in expected], \
            [f.get("error") for f in rep["features"] if f.get("error")]
        assert ops.checks and all(c.verify(rep) is None for c in ops.checks), [c.verify(rep) for c in ops.checks]
        return
    pytest.fail(f"{group}: no draw in 10 attempts")


def test_families_are_deterministic_and_classic_is_unchanged():
    a = gen_one((4, 2, 5, "holes"))["text"]
    assert a == gen_one((4, 2, 5, "holes"))["text"]
    # the classic generator's RNG stream and names are W7a's
    x = dumps_canonical(generate_program_v1(random.Random("aicad-gen-v1/3/5/0"), "x"))
    assert x == dumps_canonical(Builder(random.Random("aicad-gen-v1/3/5/0")).build("x"))
    assert program_name(3, 5) == "gen1_s3_00005" and set(FAMILIES) >= {"booleans", "holes", "patterns", "blends", "ops"}


def test_a_self_check_that_fails_is_reported():
    rep = {"features": [{"feature_id": "e1", "status": "ok", "warnings": [], "bodies": [{"volume": 10.0}]}]}
    assert Check("e1", volume=10.0).verify(rep) is None
    assert "closed form" in Check("e1", volume=11.0).verify(rep)
    assert "bodies" in Check("e1", bodies=2).verify(rep)


@pytest.mark.parametrize("group, variants", [
    ("tangent_cylinders", {"enlarge_hole", "fill_hole", "boss_on_side", "pin_outside", "pin_in_hole", "hole_beside_hole",
                           "pocket_at_side"}),
    ("boolean_feature", {"join", "cut", "intersect"}),
    ("oblique_sections", {"cylinder_ellipse", "crossing_equal", "cone_ellipse", "cone_lines", "cone_parabola"}),
])
def test_the_new_boolean_groups_cover_their_case_classes(group, variants):
    """The W4 acceptance's boolean classes (tangent cylinders; the `boolean` feature with `intersect`
    and `keep_tools`; the rule-3 sections of oblique planes and cones) are drawn by the generator,
    each checked against its closed form or the SPEC's error code."""
    from aicad_oracle.v1.genops import _Retry

    seen, keep = set(), False
    for attempt in range(80):
        b = Builder(random.Random(f"w7b-cover/{group}/{attempt}"))
        ops = Ops(b)
        try:
            getattr(ops, group)()
        except _Retry:
            continue
        desc = b.desc[-1]
        seen |= {v for v in variants if f"({v}" in desc}
        keep |= "keep" in desc
    assert seen == variants
    if group == "boolean_feature":
        assert keep


def test_a_self_check_can_expect_an_error_edge_types_and_kept_bodies():
    rep = {"features": [{"feature_id": "e2", "status": "error", "warnings": [], "error": {"code": "BOOLEAN_NON_MANIFOLD"}},
                        {"feature_id": "b1", "status": "ok", "warnings": [],
                         "bodies": [{"volume": 1.0, "edge_types": {"ellipse": 1, "line": 2}}]}],
           "parts": [{"bodies": [{"origin": {"feature": "e1"}}, {"origin": {"feature": "e3"}}]}]}
    assert Check("e2", code="BOOLEAN_NON_MANIFOLD").verify(rep) is None
    assert "expected BOOLEAN_NO_INTERSECTION" in Check("e2", code="BOOLEAN_NO_INTERSECTION").verify(rep)
    assert Check("b1", edge_types={"ellipse": 1, "bspline": 0}).verify(rep) is None
    assert "edge types" in Check("b1", edge_types={"ellipse": 2}).verify(rep)
    assert Check("b1", kept=["e1", "e3"], gone=["e2"]).verify(rep) is None
    assert "missing" in Check("b1", kept=["e2"]).verify(rep)
    assert "left" in Check("b1", gone=["e3"]).verify(rep)


def test_pattern_families_use_through_hole_seeds_only_about_the_hole_axis():
    """The §6.10 contract issue (W7b review): through/up_to hole seeds only in layouts that keep
    each copy's extent — `circular_holes` rotates through holes drilled along −Z about Z."""
    for attempt in range(20):
        b = Builder(random.Random(f"w7b-seed/{attempt}"))
        Ops(b).circular_holes()
        hole = next(f for f in b.features if f["type"] == "hole")
        pat = next(f for f in b.features if f["type"] == "pattern")
        assert hole["on"]["face"]["q"]["op"] == "cap" and not hole.get("flip")  # drilled along −Z
        assert pat["layout"]["circular"]["axis"] == "Z"


@pytest.mark.parametrize("group, variants", [
    ("blend_limits", {"fillet_vertical, above", "fillet_vertical, below", "chamfer_top, above", "chamfer_top, below",
                      "shell_open, above", "shell_open, below", "shell_closed_in, above", "shell_closed_in, below",
                      "shell_closed_out, below"}),
    ("cap_blends", {"fillet, above", "fillet, below", "chamfer, above", "chamfer, below"}),
    ("concave_fillet", {"above", "below"}),
    ("hole_edge_blend", {"fillet, above", "fillet, below", "chamfer, above", "chamfer, below"}),
])
def test_the_blend_limit_groups_cover_both_sides_of_each_limit(group, variants):
    """W7b review 3: the `blends` family draws blends and shells just above their analytic limit
    (the `*_TOO_LARGE` code with the closed-form `max_feasible_*`) and just below it (the
    closed-form volume), cylinder-rim torus / cone blends, concave fillets, closed shells in both
    directions, and a hole narrowing the face across the edge."""
    from aicad_oracle.v1.genops import _Retry

    seen = set()
    for attempt in range(120):
        b = Builder(random.Random(f"w7b-limits/{group}/{attempt}"))
        ops = Ops(b)
        try:
            getattr(ops, group)()
        except _Retry:
            continue
        desc = b.desc[-1]
        seen |= {v for v in variants if f"({v})" in desc}
        (c,) = ops.checks
        if "above" in desc:
            assert c.code and c.code.endswith("_TOO_LARGE") and len(c.details) == 1
            (mx,) = c.details.values()
            assert mx > 0 and round(mx, 3) == mx
        else:
            assert c.code is None and c.volume is not None
    assert seen == variants


def test_a_self_check_can_expect_error_details_and_face_types():
    rep = {"features": [{"feature_id": "f1", "status": "error", "warnings": [],
                         "error": {"code": "FILLET_RADIUS_TOO_LARGE", "details": {"max_feasible_r": 1.999}}},
                        {"feature_id": "f2", "status": "ok", "warnings": [],
                         "bodies": [{"volume": 1.0, "face_types": {"torus": 1, "plane": 2}}]}]}
    assert Check("f1", code="FILLET_RADIUS_TOO_LARGE", details={"max_feasible_r": 1.999}).verify(rep) is None
    assert "closed form 2.999" in Check("f1", code="FILLET_RADIUS_TOO_LARGE", details={"max_feasible_r": 2.999}).verify(rep)
    assert Check("f2", face_types={"torus": 1, "bspline": 0}).verify(rep) is None
    assert "face types" in Check("f2", face_types={"cylinder": 1}).verify(rep)


def test_the_limit_rounding_is_exact_and_retries_at_a_boundary():
    from aicad_oracle.v1.genops import _floor3, _Retry

    assert _floor3(2.0 - 1e-6) == 1.999 and _floor3(15.0614995) == 15.061
    with pytest.raises(_Retry):
        _floor3(2.0)


@pytest.mark.parametrize("group, variants, n", [
    ("multi_intersect", {"touch, 1", "touch, 2", "overlap, 1", "overlap, 2", "mixed"}, 16),
    ("intersect_seed_pattern", {"2, overlap", "3, overlap", "3, skip"}, 12),
])
def test_the_multi_tool_intersect_groups_hold_their_closed_forms(group, variants, n):
    """W7b review 4: the generator draws `intersect`s with two or three overlapping / touching tools
    and patterns of an `intersect` seed whose instances overlap — each program `ok` with the
    closed-form `t ∩ ∪K` (one body per target, never OCCT's per-tool pieces)."""
    from aicad_oracle.v1.evaluate import evaluate_text
    from aicad_oracle.v1.genops import _Retry

    seen, built = set(), 0
    for attempt in range(80):
        if built >= n and seen == variants:
            break
        b = Builder(random.Random(f"w7b-multi/{group}/{attempt}"))
        ops = Ops(b)
        try:
            getattr(ops, group)()
        except _Retry:
            continue
        desc = b.desc[-1]
        seen |= {v for v in variants if f"({v}" in desc}
        d = {"schema": "aicad.ir/1", "meta": {"name": group}, "parts": [{"id": "p1", "name": "part", "features": b.features}]}
        if b.part_params:
            d["parts"][0]["params"] = b.part_params
        if b.doc_params:
            d["params"] = b.doc_params
        rep = evaluate_text(dumps_canonical(d), group)
        assert rep["status"] == "ok", (desc, [f.get("error") for f in rep["features"] if f.get("error")])
        assert all(c.verify(rep) is None for c in ops.checks), (desc, [c.verify(rep) for c in ops.checks])
        built += 1
    assert seen == variants and built >= n


def test_a_self_check_failure_fails_oracle_gen(tmp_path, monkeypatch):
    """W7b review 4: a closed-form self-check the oracle fails is an oracle bug. `gen_one` retries
    the index (the corpus stays complete), but `oracle gen` exits 1 so that CI sees it, unless
    `--allow-self-check-failures`."""
    from aicad_oracle.cli import main
    from aicad_oracle.v1 import genops

    real = genops.Check.verify
    calls = {"n": 0}

    def flaky(self, rep):
        calls["n"] += 1
        return "injected closed-form disagreement" if calls["n"] == 1 else real(self, rep)

    monkeypatch.setattr(genops.Check, "verify", flaky)
    args = ["gen", "--ir", "v1", "--family", "patterns", "--count", "1", "--seed", "5", "--jobs", "1",
            "--invalid-per-kind", "0"]
    assert main([*args, "--out", str(tmp_path / "a")]) == 1
    import json

    (st,) = [json.loads(p.read_text()) for p in (tmp_path / "a").glob("*.stats.json")]
    assert st["self_check_failures"] == 1 and st["generated"] == 1
    calls["n"] = 0
    assert main([*args, "--out", str(tmp_path / "b"), "--allow-self-check-failures"]) == 0
    calls["n"] = 10 ** 6  # no injected failure
    assert main([*args, "--out", str(tmp_path / "c")]) == 0


def test_notched_shells_cover_every_open_face_and_keep_the_occt_limited_draws():
    """W7b review 5: `shell_notched` — a non-convex body shelled with its notched top, its bottom or
    no face open. The closed form holds wherever OCCT builds the shell; the top-open draws, where
    `MakeThickSolid` returns the body unchanged, fail with the engine-internal `OCCT_SHELL_FAILED`
    only, and `gen_one` keeps them (`occt_limited`) instead of dropping them as self-check failures,
    so the F1/F2 diff lists Forge's result there (ROBUSTNESS)."""
    from aicad_oracle.v1.evaluate import evaluate_text
    from aicad_oracle.v1.genops import _Retry

    seen = {}
    for attempt in range(40):
        b = Builder(random.Random(f"w7b-review5/notched/{attempt}"))
        ops = Ops(b)
        try:
            ops.shell_notched()
        except _Retry:
            continue
        variant = b.desc[-1]
        if variant in seen:
            continue
        d = {"schema": "aicad.ir/1", "meta": {"name": "n"}, "parts": [{"id": "p1", "name": "part", "features": b.features}]}
        if b.part_params:
            d["parts"][0]["params"] = b.part_params
        if b.doc_params:
            d["params"] = b.doc_params
        rep = evaluate_text(dumps_canonical(d), "n")
        assert all(c.verify(rep) is None for c in ops.checks), [c.verify(rep) for c in ops.checks]
        shell = ops.checks[-1]
        seen[variant] = shell.occt_limited(rep)
        if variant != "shell_notched(end)":
            assert seen[variant] is None  # built, and in closed form (verify)
        else:
            assert seen[variant] in (None, "OCCT_SHELL_FAILED")
        if len(seen) == 3:
            break
    assert set(seen) == {"shell_notched(end)", "shell_notched(start)", "shell_notched(closed)"}


def test_gen_one_keeps_an_occt_limited_draw_and_lists_it():
    """A group's `engine_limits` failure is not an `oracle_error` or a `self_check` failure: the
    program is kept with its `occt_limited` entry (the stats and `oracle gen` list them)."""
    from aicad_oracle.v1 import genops

    real = genops.GROUPS["blends"]
    genops.GROUPS["blends"] = [("shell_notched", 1)]
    try:
        hits = []
        for i in range(12):
            r = gen_one((5, i, 20, "blends"))
            assert r["text"] is not None and not r["failures"], r["failures"]
            hits += r["occt_limited"]
            if hits:
                break
    finally:
        genops.GROUPS["blends"] = real
    assert hits and hits[0]["code"] == "OCCT_SHELL_FAILED", hits
