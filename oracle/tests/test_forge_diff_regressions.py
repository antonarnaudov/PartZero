"""Regressions from the first Forge-vs-oracle diff (seeds 5 and 11, 3,540 programs).

* gen_s11_00391 / gen_s5_01209 — POTENTIAL_SILENT_WRONG on bbox of horn tori. The ORACLE was
  wrong: OCCT represents a horn torus as a Geom_SurfaceOfRevolution, and the old tight_bbox
  fell back to BRepBndLib::AddOptimal for that face type, whose numerical search stopped short
  of the interior maximum (by 8.7e-4 and 4.9e-2 mm) and enlarged other sides by 1e-7. Forge's
  values equal the analytic torus extremes C ± R·ρ̂ ± r·e and dense sampling.
* gen_s5_00724 — OCCT builds a cylinder for a profile line 1.0e-4 rad off parallel (§4.4 says
  cone); the oracle's gate rejects the body. Forge's volume agrees with the closed form.
"""

import math

import pytest

from helpers import C, L, feature, revolve, run, sketch

HORN_CASES = {
    # name: (plane, circle centre, radius, axis origin, axis direction, angle, direction,
    #        Forge / analytic bbox max & min per axis)
    "gen_s11_00391": ("XY", (72.3164955152654, -32.109725742539176), 9.77763742055817,
                      (29.729998133300338, -22.047988903173177), (-4.227817444241523, 0.028182689794171625),
                      270.0, "reverse",
                      [82.224485773, -2.777247943, 19.555274841], [62.538858095, -41.887363163, -19.555274841]),
    "gen_s5_01209": ("YZ", (76.63277756853618, -66.66692674308928), 114.19771890729413,
                     (-37.67331965639479, -64.61543554907749), (0.010245555659515222, -0.3513214118559759),
                     311.03351018457494, "normal",
                     [228.395437815, 190.830496476, 47.530792164], [-228.395437815, -265.8633187, -187.522491296]),
}


def _sampled_bbox(plane, center, r, origin, adir, angle, direction, n=361):
    """Dense sampling of the swept circle, independent of OCCT and of the oracle."""
    from aicad_oracle.ir import resolve_plane

    pl = resolve_plane(plane)
    A = pl.to3d(origin)
    d = pl.dir3d(adir)
    dl = math.sqrt(sum(c * c for c in d))
    Z = [c / dl for c in d]
    ang = math.radians(angle)
    t0, t1 = {"normal": (0, ang), "reverse": (-ang, 0), "symmetric": (-ang / 2, ang / 2)}[direction]
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for i in range(n):
        phi = 2 * math.pi * i / n
        p = pl.to3d((center[0] + r * math.cos(phi), center[1] + r * math.sin(phi)))
        v = [p[k] - A[k] for k in range(3)]
        for j in range(n):
            th = t0 + (t1 - t0) * j / (n - 1)
            c, s = math.cos(th), math.sin(th)
            dot = sum(v[k] * Z[k] for k in range(3))
            cr = [Z[1] * v[2] - Z[2] * v[1], Z[2] * v[0] - Z[0] * v[2], Z[0] * v[1] - Z[1] * v[0]]
            q = [A[k] + v[k] * c + cr[k] * s + Z[k] * dot * (1 - c) for k in range(3)]  # Rodrigues
            for k in range(3):
                lo[k], hi[k] = min(lo[k], q[k]), max(hi[k], q[k])
    return lo, hi


@pytest.mark.parametrize("name", sorted(HORN_CASES))
def test_horn_torus_bbox_reaches_the_interior_extremes(name):
    plane, center, r, origin, adir, angle, direction, fhi, flo = HORN_CASES[name]
    rep = run(sketch([C("c", center, r)], plane=plane),
              revolve(angle, origin=origin, axis_dir=adir, **({"direction": direction} if direction != "normal" else {})))
    b = feature(rep, "rv")["bodies"][0]
    s = math.dist(b["bbox_min"], b["bbox_max"])
    # 1) the values Forge reported (= analytic torus extremes), to their printed precision
    for k in range(3):
        assert b["bbox_max"][k] == pytest.approx(fhi[k], abs=2e-9)
        assert b["bbox_min"][k] == pytest.approx(flo[k], abs=2e-9)
    # 2) never smaller than a dense sampling of the exact swept circle, and within 1e-4 of it
    slo, shi = _sampled_bbox(plane, center, r, origin, adir, angle, direction)
    for k in range(3):
        assert b["bbox_min"][k] <= slo[k] + 1e-9 * s and b["bbox_max"][k] >= shi[k] - 1e-9 * s
        assert slo[k] - b["bbox_min"][k] < 1e-3 * s and b["bbox_max"][k] - shi[k] < 1e-3 * s


@pytest.mark.parametrize("seed", range(8))
def test_partial_horn_tori_in_random_frames_have_the_analytic_bbox(seed):
    import random

    from aicad_oracle.generator import random_plane
    from aicad_oracle.ir import load_document, resolve_plane
    from aicad_oracle.selfcheck import predicted_bbox
    from aicad_oracle.sketch import evaluate_sketch
    from helpers import doc

    rng = random.Random(seed)
    phi = rng.uniform(0, 2 * math.pi)
    a = (math.cos(phi), math.sin(phi))
    r = rng.uniform(1, 50)
    O = (rng.uniform(-20, 20), rng.uniform(-20, 20))
    side = rng.choice([1, -1])
    center = (O[0] - side * r * a[1], O[1] + side * r * a[0])  # tangent to the axis
    plane = random_plane(rng)
    angle = rng.uniform(30, 350)
    direction = rng.choice(["normal", "reverse", "symmetric"])
    feats = [sketch([C("c", center, r)], plane=plane), revolve(angle, origin=O, axis_dir=a, direction=direction)]
    f = feature(run(*feats), "rv")
    if f["status"] != "ok":  # OCCT's known horn-torus defects are reported, never silently wrong
        assert f["error"]["code"].startswith("OCCT_")
        return
    b = f["bodies"][0]
    d = load_document(doc(*feats))
    sk, rv = d.parts[0].features
    res = evaluate_sketch(list(sk.curves))
    lo, hi = predicted_bbox(rv, list(sk.curves), res.regions[0], resolve_plane(sk.plane))
    s = max(1.0, math.dist(lo, hi))
    for k in range(3):
        assert abs(b["bbox_min"][k] - lo[k]) <= 1e-9 * s and abs(b["bbox_max"][k] - hi[k]) <= 1e-9 * s


PROFILE_724 = [
    L("l8", (-1.7357712509950165, 0.6317145023895443), (-1.2727006742484053, 0.45055021441929655)),
    L("l1", (-1.9592286474519591, 0.41351564018122644), (-2.2574433994003584, 0.0015973993134655862)),
    L("l5", (-1.4134466324591197, -1.1689747175433112), (-0.8092519630712323, -0.6660823146185445)),
    L("line_07", (-0.8092519630712323, -0.6660823146185445), (-1.1330809222821567, 0.16969345061405022)),
    L("l2", (-1.1330809222821567, 0.16969345061405022), (-1.2727006742484053, 0.45055021441929655)),
    L("l6", (-2.2574433994003584, 0.0015973993134655862), (-2.1862536414711977, -0.3788649353435747)),
    L("line_09", (-2.1862536414711977, -0.3788649353435747), (-1.993837330246095, -1.158826942963505)),
    L("line_04", (-1.7357712509950165, 0.6317145023895443), (-1.9592286474519591, 0.41351564018122644)),
    L("l3", (-1.993837330246095, -1.158826942963505), (-1.4134466324591197, -1.1689747175433112)),
]
FRAME_724 = {"origin": [15.702589704615193, 49.91237775695227, 57.14975955326473],
             "normal": [-2.4650889422930815, -0.07411836903447522, 1.9169741722372418],
             "x_dir": [0.31283973180539826, -0.8754327161117667, 0.36844112387883854]}
AXIS_724 = dict(origin=(0.9791520107235927, -1.9701433560427137), axis_dir=(1.510256076492502, -3.038773287945357))
EXACT_VOLUME_724 = 16.2135957812971006  # 50-digit Pappus on the polygon (mpmath)
FORGE_VOLUME_724 = 16.213595781297  # Forge's report


def test_gen_s5_00724_closed_form_and_forge_agree_and_occt_is_gated():
    from aicad_oracle.ir import load_document
    from aicad_oracle.sketch import evaluate_sketch, region_moments
    from helpers import doc

    feats = [sketch(PROFILE_724, plane=FRAME_724), revolve(333.3149917758695, **AXIS_724)]
    d = load_document(doc(*feats))
    sk, rv = d.parts[0].features
    reg = evaluate_sketch(list(sk.curves)).regions[0]
    area, mx, my = region_moments(list(sk.curves), reg)
    Lh = math.hypot(*rv.axis_direction)
    dx, dy = rv.axis_direction[0] / Lh, rv.axis_direction[1] / Lh
    ox, oy = rv.axis_origin
    vol = math.radians(rv.angle) * abs(dx * (my - area * oy) - dy * (mx - area * ox))
    assert vol == pytest.approx(EXACT_VOLUME_724, rel=1e-14)
    assert FORGE_VOLUME_724 == pytest.approx(EXACT_VOLUME_724, rel=1e-13)
    f = feature(run(*feats), "rv")
    if f["status"] == "ok":  # an OCCT that keeps the cone would have to match
        assert f["bodies"][0]["volume"] == pytest.approx(EXACT_VOLUME_724, rel=1e-9)
    else:
        assert f["error"]["code"] == "OCCT_SELF_CHECK_FAILED"
