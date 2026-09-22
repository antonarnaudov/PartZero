"""SPEC §2 and §4: planes, features, errors, suppression and the report format."""

import math

import pytest

from aicad_oracle.evaluate import check_report, evaluate_data

from helpers import A, C, L, doc, extrude, feature, rect, revolve, run, sketch


def body(report, name="ex", i=0):
    return feature(report, name)["bodies"][i]


def approx3(v, w, tol=1e-9):
    return all(abs(a - b) <= tol for a, b in zip(v, w))


# --- report shape ----------------------------------------------------------------------------

def test_report_validates_against_metrics_schema_and_omits_empty_fields():
    rep = run(sketch(rect("", 0, 0, 10, 10)), extrude(5))
    assert check_report(rep) == []
    assert rep["schema"] == "aicad.metrics/0" and rep["status"] == "ok"
    assert rep["engine"].startswith("occt ")
    s, e = rep["features"]
    assert s == {"part": "part", "feature": "sk", "type": "sketch", "status": "ok",
                 "regions": [{"area": 100.0, "loops": 1, "outer_curves": ["b", "l", "r", "t"]}]}
    assert "regions" not in e and "error" not in e and len(e["bodies"]) == 1


def test_document_name_falls_back_to_file_stem(tmp_path):
    from aicad_oracle.evaluate import evaluate_file
    import json

    d = doc(sketch(rect("", 0, 0, 1, 1)))
    del d["meta"]
    p = tmp_path / "my_part.json"
    p.write_text(json.dumps(d))
    assert evaluate_file(p)["document"] == "my_part"


# --- planes (SPEC §2) ------------------------------------------------------------------------

@pytest.mark.parametrize(
    "plane, lo, hi",
    [
        ("XY", [0, 0, 0], [4, 2, 1]),
        ("XZ", [0, -1, 0], [4, 0, 2]),  # x=+X, y=+Z, normal −Y
        ("YZ", [0, 0, 0], [1, 4, 2]),  # x=+Y, y=+Z, normal +X
    ],
)
def test_named_planes(plane, lo, hi):
    b = body(run(sketch(rect("", 0, 0, 4, 2), plane=plane), extrude(1)))
    assert approx3(b["bbox_min"], lo) and approx3(b["bbox_max"], hi)


def test_explicit_frame_is_normalised_and_right_handed():
    # normal +Z (non-unit), x_dir = +Y (non-unit)  →  y = n × x = −X
    frame = {"origin": [1, 2, 3], "normal": [0, 0, 5], "x_dir": [0, 3, 0]}
    b = body(run(sketch(rect("", 0, 0, 4, 2), plane=frame), extrude(1)))
    assert approx3(b["bbox_min"], [1 - 2, 2, 3]) and approx3(b["bbox_max"], [1, 2 + 4, 4])


def test_frame_must_be_perpendicular():
    frame = {"origin": [0, 0, 0], "normal": [0, 0, 1], "x_dir": [1, 0, 1e-6]}
    rep = run(sketch(rect("", 0, 0, 4, 2), plane=frame))
    assert rep["status"] == "error" and rep["error"]["code"] == "INVALID_PLANE" and rep["features"] == []


# --- extrude directions ----------------------------------------------------------------------

@pytest.mark.parametrize("direction, z0, z1", [("normal", 0, 6), ("reverse", -6, 0), ("symmetric", -3, 3)])
def test_extrude_directions(direction, z0, z1):
    b = body(run(sketch(rect("", 0, 0, 2, 2)), extrude(6, direction=direction)))
    assert b["bbox_min"][2] == pytest.approx(z0) and b["bbox_max"][2] == pytest.approx(z1)
    assert b["volume"] == pytest.approx(24.0, rel=1e-12)
    assert b["centroid"][2] == pytest.approx((z0 + z1) / 2, abs=1e-12)


def test_one_body_per_region_in_canonical_order():
    rep = run(sketch([C("zeta", (0, 0), 1), C("alpha", (10, 0), 2)]), extrude(1))
    b0, b1 = feature(rep, "ex")["bodies"]
    assert b0["volume"] == pytest.approx(4 * math.pi) and b1["volume"] == pytest.approx(math.pi)


# --- revolve ---------------------------------------------------------------------------------

RING = [L("i", (20, 0), (20, 6)), L("t", (20, 6), (32, 6)), L("o", (32, 6), (32, 0)), L("b", (32, 0), (20, 0))]


@pytest.mark.parametrize(
    "direction, ylo, yhi",
    [("normal", 0.0, 32.0), ("reverse", -32.0, 0.0), ("symmetric", -32 * math.sin(math.pi / 4), 32 * math.sin(math.pi / 4))],
)
def test_revolve_right_hand_rule(direction, ylo, yhi):
    # Profile on XZ at +X; axis = sketch +v = +Z. +90° about +Z sweeps +X towards +Y.
    b = body(run(sketch(RING, plane="XZ"), revolve(90, direction=direction)), "rv")
    assert b["bbox_min"][1] == pytest.approx(ylo, abs=1e-9) and b["bbox_max"][1] == pytest.approx(yhi, abs=1e-9)
    assert b["volume"] == pytest.approx(math.pi / 4 * (32**2 - 20**2) * 6, rel=1e-12)


def test_revolve_crosses_axis():
    rep = run(sketch(rect("", -1, 0, 5, 3)), revolve(360))
    f = feature(rep, "rv")
    assert rep["status"] == "error" and f["status"] == "error"
    assert f["error"]["code"] == "REVOLVE_CROSSES_AXIS" and "bodies" not in f


def test_revolve_region_touching_axis_at_a_point_is_valid():
    tri = [L("a", (0, 0), (5, -3)), L("b", (5, -3), (5, 3)), L("c", (5, 3), (0, 0))]
    rep = run(sketch(tri), revolve(360), checks=(checks := []))
    assert rep["status"] == "ok" and checks == []
    b = body(rep, "rv")
    # two cones + one cylinder; the apex is a degenerated edge in OCCT and is not counted
    assert b["face_types"] == {"cone": 2, "cylinder": 1} and b["edges"] == 2


def test_revolve_axis_edges_generate_no_faces():
    prof = [L("base", (0, 0), (10, 0)), L("wall", (10, 0), (10, 30)), L("lid", (10, 30), (0, 30)), L("ax", (0, 30), (0, 0))]
    full = body(run(sketch(prof, plane="XZ"), revolve(360)), "rv")
    part = body(run(sketch(prof, plane="XZ"), revolve(90)), "rv")
    assert (full["faces"], full["edges"]) == (3, 2)
    assert full["face_types"] == {"cylinder": 1, "plane": 2} and full["edge_types"] == {"circle": 2}
    # 90°: 3 swept faces + 2 caps; edges: 3 profile curves × 2 + axis edge + 2 vertex arcs
    assert (part["faces"], part["edges"]) == (5, 9)
    assert part["edge_types"] == {"circle": 2, "line": 7}


def test_full_torus_has_no_counted_edges_and_a_tight_bbox():
    b = body(run(sketch([C("tube", (15, 0), 4)], plane="XZ"), revolve(360)), "rv")
    assert (b["faces"], b["edges"], b["face_types"], b["edge_types"]) == (1, 0, {"torus": 1}, {})
    assert b["bbox_min"] == [-19.0, -19.0, -4.0] and b["bbox_max"] == [19.0, 19.0, 4.0]


def test_arc_centred_on_axis_is_a_sphere():
    prof = [A("cap", (0, -5), (0, 5), (0, 0), False), L("ax", (0, 5), (0, -5))]
    b = body(run(sketch(prof), revolve(360)), "rv")
    assert b["face_types"] == {"sphere": 1} and b["edges"] == 0
    assert b["volume"] == pytest.approx(4 / 3 * math.pi * 125, rel=1e-12)


# --- errors, suppression, continuation (SPEC §4) --------------------------------------------

def test_failed_sketch_does_not_stop_evaluation():
    rep = run(
        sketch(rect("", 0, 0, 1, 1)[:3], name="bad", fid="s1"),
        extrude(1, sketch_name="bad", fid="e1", name="e_bad"),
        sketch(rect("", 0, 0, 1, 1), name="good", fid="s2"),
        extrude(1, sketch_name="good", fid="e2", name="e_good"),
    )
    assert rep["status"] == "error"
    assert feature(rep, "bad")["error"]["code"] == "SKETCH_OPEN_LOOP"
    # [R-1] consumers of a failed sketch fail with DEPENDENCY_FAILED naming the sketch and its code
    err = feature(rep, "e_bad")["error"]
    assert err["code"] == "DEPENDENCY_FAILED"
    assert "'bad'" in err["message"] and "SKETCH_OPEN_LOOP" in err["message"]
    assert feature(rep, "good")["status"] == "ok" and feature(rep, "e_good")["status"] == "ok"


def test_suppressed_features_are_skipped_and_suppressed_sketch_is_reported():
    rep = run(
        sketch(rect("", 0, 0, 1, 1), name="hidden", fid="s1", suppressed=True),
        extrude(1, sketch_name="hidden", fid="e1", name="uses_hidden"),
        sketch(rect("", 0, 0, 1, 1), name="shown", fid="s2"),
        extrude(1, sketch_name="shown", fid="e2", name="skipped", suppressed=True),
    )
    names = [f["feature"] for f in rep["features"]]
    assert names == ["uses_hidden", "shown"]
    assert feature(rep, "uses_hidden")["error"]["code"] == "SKETCH_SUPPRESSED"
    assert rep["status"] == "error"


@pytest.mark.parametrize(
    "mutate, code",
    [
        (lambda d: d.update(schema="aicad.ir/1"), "UNSUPPORTED_SCHEMA"),
        (lambda d: d["parts"][0]["features"].append(extrude(1, sketch_name="nope", fid="e9", name="x9")), "UNRESOLVED_SKETCH"),
        (lambda d: d["parts"][0]["features"][0].update(name="bad name"), "INVALID_NAME"),
        (lambda d: d["parts"][0]["features"][0]["curves"].append(L("b", (5, 5), (6, 6))), "DUPLICATE_ID"),
        (lambda d: d["parts"][0]["features"][0]["curves"].append(A("arc", (0, 1), (0, 3), (0, 0))), "INCONSISTENT_ARC"),
        (lambda d: d["parts"][0]["features"][0]["curves"].append(L("z", (5, 5), (5, 5 + 1e-7))), "DEGENERATE_CURVE"),
        (lambda d: d["parts"][0].update(extra=1), "IR_SCHEMA_INVALID"),
        (lambda d: d["parts"][0]["features"][0]["curves"][0].update(extra=1), "IR_SCHEMA_INVALID"),
        (lambda d: d["parts"][0]["features"][0].update(name="extrude"), "RESERVED_NAME"),
        (lambda d: d["parts"][0]["features"][0].update(name="part"), "RESERVED_NAME"),
        (lambda d: d["parts"][0]["features"][0]["curves"].append(C("cn", (0, 0), float("nan"))), "NON_FINITE"),
        (lambda d: d["parts"][0]["features"][0]["curves"].append(C("c0", (0, 0), 1e-7)), "DEGENERATE_CURVE"),
        # SPEC §0: feature ids and names are unique across the whole document
        (lambda d: d["parts"].append({"id": "p2", "name": "other", "features": [sketch(rect("", 0, 0, 1, 1), fid="s9")]}),
         "DUPLICATE_NAME"),
        (lambda d: d["parts"].append({"id": "p2", "name": "other", "features": [sketch(rect("", 0, 0, 1, 1), name="sk2")]}),
         "DUPLICATE_ID"),
    ],
)
def test_document_level_validation(mutate, code):
    d = doc(sketch(rect("", 0, 0, 1, 1)))
    mutate(d)
    rep = evaluate_data(d, "t")
    assert rep["status"] == "error" and rep["error"]["code"] == code and rep["features"] == []
    assert check_report(rep) == []


def test_angle_and_distance_bounds():
    for f, code in ((extrude(0), "INVALID_DISTANCE"), (revolve(0), "INVALID_ANGLE"), (revolve(360.5), "INVALID_ANGLE")):
        rep = evaluate_data(doc(sketch(rect("", 1, 0, 2, 1)), f), "t")
        assert rep["error"]["code"] == code


def test_defaults_may_be_explicit_or_omitted():
    explicit = extrude(2, direction="normal", op="new_body", regions="all", suppressed=False)
    d = doc(sketch(rect("", 0, 0, 1, 1), suppressed=False), explicit)
    d["units"] = {"length": "mm", "angle": "deg"}
    a = evaluate_data(d, "t")
    b = run(sketch(rect("", 0, 0, 1, 1)), extrude(2))
    assert a["status"] == b["status"] == "ok"
    assert a["features"] == b["features"]


def test_multi_part_reports_part_names_in_timeline_order():
    d = doc(sketch(rect("", 0, 0, 1, 1)), extrude(1))
    d["parts"].append({"id": "p2", "name": "second", "features": [
        sketch(rect("", 0, 0, 2, 2), fid="s2", name="sk_b"), extrude(1, sketch_name="sk_b", fid="e2", name="ex_b")]})
    rep = evaluate_data(d, "t")
    assert [(f["part"], f["feature"]) for f in rep["features"]] == [
        ("part", "sk"), ("part", "ex"), ("second", "sk_b"), ("second", "ex_b")]


def test_oracle_never_reports_an_occt_invalid_body_as_ok():
    # Reproducer found by `oracle gen --seed 3` (program 763): a partial revolve of a small circle
    # tangent to the axis. OCCT 7.9.3 builds an invalid solid of volume ~3e-20. The oracle must
    # either produce a body that passes every self-check or report OCCT_INVALID_RESULT — never
    # an ok-but-invalid body. (360° of the same profile is fine.)
    frame = {"origin": [0.0, 0.0, 0.0],
             "normal": [0.08766726664475087, 0.008832112355662176, 0.9961106585868736],
             "x_dir": [0.8476394694295915, 0.5246202948087344, -0.07925197877603636]}
    tube = C("c1", (-0.286289718967615, -0.04034503041513677), 0.023675013640640615)
    axis = dict(origin=(-0.2626147053269744, 0.010177387628741279),
                axis_dir=(-2.2122227482626996e-16, -3.6128339204461812))
    outcomes = {}
    for angle in (120.0, 360.0):
        checks = []
        rep = run(sketch([tube], plane=frame), revolve(angle, **axis), checks=checks)
        f = feature(rep, "rv")
        if f["status"] == "ok":
            assert checks == [] and f["bodies"][0]["valid"] is True
            outcomes[angle] = "ok"
        else:
            assert f["error"]["code"] == "OCCT_INVALID_RESULT" and "bodies" not in f
            outcomes[angle] = f["error"]["code"]
    assert outcomes[360.0] == "ok"



def test_frame_x_is_reorthogonalised_against_the_normal():
    from aicad_oracle.ir import Frame, resolve_plane

    pl = resolve_plane(Frame((0, 0, 0), (0.0, 0.0, 2.0), (3.0, 0.0, 2e-9)))  # |cos| < 1e-9 passes validation
    assert pl.x == (1.0, 0.0, 0.0) and pl.y == (0.0, 1.0, 0.0) and pl.normal == (0.0, 0.0, 1.0)
    pl = resolve_plane(Frame((0, 0, 0), (1.0, 1.0, 0.0), (1.0, -1.0, 1e-10)))
    dot = sum(a * b for a, b in zip(pl.x, pl.normal))
    assert abs(dot) < 1e-16


def test_part_names_are_free_strings():
    d = doc(sketch(rect("", 0, 0, 1, 1)), extrude(1))
    d["parts"][0]["name"] = "part"  # reserved names do not apply to parts [R-15]
    d["parts"].append({"id": "p2", "name": "Bracket #2 (left)", "features": [
        sketch(rect("", 0, 0, 1, 1), fid="s2", name="sk2")]})
    rep = evaluate_data(d, "t")
    assert rep["status"] == "ok" and rep["features"][-1]["part"] == "Bracket #2 (left)"


def test_profile_within_tolerance_past_the_axis_is_snapped_onto_it():
    # [R-3]/[R-7]: 0.5·tol past the axis is not a crossing; the vertex is ON the axis (§4.4),
    # so there is no ring edge and the body equals the exactly-on-axis one.
    exact = body(run(sketch(rect("", 0, 0, 10, 30)), revolve(90)), "rv")
    near = run(sketch(rect("", -5e-7, 0, 10, 30)), revolve(90), checks=(checks := []))
    assert near["status"] == "ok" and checks == []
    b = body(near, "rv")
    assert (b["faces"], b["edges"], b["edge_types"]) == (exact["faces"], exact["edges"], exact["edge_types"])
    assert b["volume"] == pytest.approx(exact["volume"], rel=1e-6)
    crossing = run(sketch(rect("", -2e-6, 0, 10, 30)), revolve(90))
    assert feature(crossing, "rv")["error"]["code"] == "REVOLVE_CROSSES_AXIS"


def test_regions_on_opposite_sides_of_the_axis_are_each_valid():
    rep = run(sketch(rect("a", 1, 0, 3, 2) + rect("b", -3, 0, -1, 2)), revolve(360))
    assert rep["status"] == "ok" and len(feature(rep, "rv")["bodies"]) == 2


def test_one_crossing_region_fails_the_whole_revolve():
    rep = run(sketch(rect("a", 1, 0, 3, 2) + rect("b", -1, 5, 1, 7)), revolve(360))
    f = feature(rep, "rv")
    assert f["error"]["code"] == "REVOLVE_CROSSES_AXIS" and "bodies" not in f


def test_degenerate_analytic_types_follow_the_spec_tolerances():
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeTorus
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    from aicad_oracle.occt import face_type

    # a torus whose major radius is ≤ tol is the sphere of an arc centred on the axis [R-8]
    shape = BRepPrimAPI_MakeTorus(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 5e-7, 4.0, 1.0).Shape()
    ex = TopExp_Explorer(shape, TopAbs_FACE)
    types = set()
    while ex.More():
        types.add(face_type(TopoDS.Face_s(ex.Current())))
        ex.Next()
    assert "sphere" in types and "torus" not in types


@pytest.mark.parametrize("angle, length", [(1e-5, 30.0), (1e-4, 0.3), (3e-4, 0.3)])
def test_occt_snapping_a_slanted_line_to_a_cylinder_is_not_reported_as_ok(angle, length):
    # §4.4: a line more than 1e-9 rad off parallel sweeps a CONE. OCCT's BRepSweep_Rotation
    # builds a cylinder for lines up to ~3e-4 rad off parallel (inexact geometry). The oracle's
    # gate must turn that into an engine-internal error rather than report wrong types/metrics.
    dr = length * math.tan(angle)
    prof = [L("b", (1, 0), (2, 0)), L("o", (2, 0), (2 + dr, length)), L("t", (2 + dr, length), (1, length)),
            L("i", (1, length), (1, 0))]
    f = feature(run(sketch(prof), revolve(360)), "rv")
    if f["status"] == "ok":  # a future OCCT that keeps the cone is fine too
        assert f["bodies"][0]["face_types"] == {"cone": 1, "cylinder": 1, "plane": 2}
    else:
        assert f["error"]["code"] == "OCCT_SELF_CHECK_FAILED" and "face_types" in f["error"]["message"]


def test_slanted_line_well_off_parallel_is_a_cone():
    prof = [L("b", (1, 0), (2, 0)), L("o", (2, 0), (2.3, 30)), L("t", (2.3, 30), (1, 30)), L("i", (1, 30), (1, 0))]
    b = body(run(sketch(prof), revolve(360)), "rv")
    assert b["face_types"] == {"cone": 1, "cylinder": 1, "plane": 2}


def test_occt_full_turn_for_a_partial_horn_torus_is_caught():
    # Found by `oracle gen --seed 3` (program 2600): OCCT 7.9.3 returns the FULL 360° torus for a
    # 311.5° reverse revolve of a circle tangent to the axis (volume 4988.79 instead of 4317.30).
    tube = C("c1", (-9.083420670524045, -19.403353315195183), 6.322496123800377)
    axis = dict(origin=(-2.7609245467236683, -30.79718619088601), axis_dir=(-3.9239346628357354e-17, -0.6408271618507037))
    rep = run(sketch([tube], plane="YZ"), revolve(311.54396644817473, direction="reverse", **axis))
    f = feature(rep, "rv")
    r, d = 6.322496123800377, 6.322496123800378
    if f["status"] == "ok":
        assert f["bodies"][0]["volume"] == pytest.approx(math.radians(311.54396644817473) * d * math.pi * r * r, rel=1e-8)
    else:
        assert f["error"]["code"] == "OCCT_SELF_CHECK_FAILED" and "volume" in f["error"]["message"]
