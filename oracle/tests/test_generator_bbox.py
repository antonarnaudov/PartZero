"""Generator determinism/validity, and the tight bounding box of analytic faces."""

import json
import math
import random

import pytest

from aicad_oracle.evaluate import evaluate_data
from aicad_oracle.generator import generate_program
from aicad_oracle.ir import load_document


def gen(seed, i, attempt=0):
    return generate_program(random.Random(f"aicad-gen/{seed}/{i}/{attempt}"), f"g{i}")


def test_generator_is_deterministic():
    a = [json.dumps(gen(5, i)) for i in range(20)]
    b = [json.dumps(gen(5, i)) for i in range(20)]
    assert a == b
    assert a != [json.dumps(gen(6, i)) for i in range(20)]


@pytest.mark.parametrize("i", range(25))
def test_generated_programs_are_valid_and_pass_self_checks(i):
    d = gen(123, i)
    load_document(json.loads(json.dumps(d)))  # JSON Schema + validate.rs rules
    checks = []
    rep = evaluate_data(d, d["meta"]["name"], checks)
    assert rep["status"] == "ok", rep
    assert checks == []


def test_cli_gen_writes_programs_and_stats(tmp_path, capsys):
    from aicad_oracle.cli import main

    assert main(["gen", "--count", "6", "--seed", "2", "--out", str(tmp_path), "--jobs", "1"]) == 0
    files = sorted(p.name for p in tmp_path.glob("gen_s2_*[0-9].json"))
    assert files == [f"gen_s2_{i:05d}.json" for i in range(6)]
    stats = json.loads((tmp_path / "gen_s2.stats.json").read_text())
    assert stats["generated"] == 6


# --- tight bbox ------------------------------------------------------------------------------

def _sample_bbox(face_shapes, n=120):
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepTools import BRepTools

    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    for f in face_shapes:
        ad = BRepAdaptor_Surface(f, False)
        u0, u1, v0, v1 = BRepTools.UVBounds_s(f)
        for i in range(n + 1):
            for j in range(n + 1):
                p = ad.Value(u0 + (u1 - u0) * i / n, v0 + (v1 - v0) * j / n)
                for k, c in enumerate((p.X(), p.Y(), p.Z())):
                    lo[k] = min(lo[k], c)
                    hi[k] = max(hi[k], c)
    return lo, hi


@pytest.mark.parametrize("seed", range(6))
def test_tight_bbox_of_tilted_tori_and_spheres(seed):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeSphere, BRepPrimAPI_MakeTorus
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    from OCP.Bnd import Bnd_Box
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepBndLib import BRepBndLib
    from OCP.GeomAbs import GeomAbs_Plane

    from aicad_oracle.occt import tight_bbox

    rng = random.Random(seed)
    ax = gp_Ax2(gp_Pnt(*(rng.uniform(-9, 9) for _ in range(3))), gp_Dir(*(rng.gauss(0, 1) for _ in range(3))))
    for solid in (
        BRepPrimAPI_MakeTorus(ax, rng.uniform(5, 15), rng.uniform(1, 4), rng.uniform(0.3, 2 * math.pi)).Shape(),
        BRepPrimAPI_MakeSphere(ax, rng.uniform(1, 9), rng.uniform(-1.5, 0), rng.uniform(0, 1.5), rng.uniform(0.3, 2 * math.pi)).Shape(),
    ):
        lo, hi = tight_bbox(solid)
        faces = []
        ex = TopExp_Explorer(solid, TopAbs_FACE)
        while ex.More():
            f = TopoDS.Face_s(ex.Current())
            if BRepAdaptor_Surface(f, False).GetType() != GeomAbs_Plane:
                faces.append(f)  # analytic faces here are full UV rectangles; planes are trimmed
            ex.Next()
        slo, shi = _sample_bbox(faces)
        box = Bnd_Box()
        BRepBndLib.AddOptimal_s(solid, box, False, False)
        olo, ohi = box.Get()[:3], box.Get()[3:]
        for k in range(3):
            # never smaller than the sampled curved surface ...
            assert lo[k] <= slo[k] + 1e-9 and hi[k] >= shi[k] - 1e-9
            # ... inside OCCT's own (possibly tolerance-enlarged) optimal box, and within 1e-6 of it
            assert olo[k] - 1e-12 <= lo[k] and hi[k] <= ohi[k] + 1e-12
            assert lo[k] - olo[k] <= 1e-6 and ohi[k] - hi[k] <= 1e-6


def test_error_corpus_matches_its_expectations():
    from aicad_oracle.invalidgen import KINDS, check_case, generate_invalid

    cases = generate_invalid(7, 1)
    assert {c.kind for c in cases} == set(KINDS)
    for c in cases:
        rep = evaluate_data(c.doc, c.doc["meta"]["name"])
        assert check_case(c, rep) == [], (c.kind, c.note)
