"""The CI gates around the differential (audit findings H3, M3, M8, M9).

* `oracle diff` must never pass without comparing Forge: a missing `--forge-bin` is a usage
  error, an empty target compares nothing, and NO_REFERENCE can be made fatal.
* The CI workflows must build Forge, run the diff with every failure class enabled, and run
  the oracle's own tests; the nightly workflow runs the full differential.
* The error corpus exercises SKETCH_DEGENERATE_LOOP [R-5] at its inclusive bound.
"""

from __future__ import annotations

import math
import random
import re
import shutil
from pathlib import Path

import pytest

from aicad_oracle.evaluate import evaluate_data
from aicad_oracle.invalidgen import KINDS, TOL, check_case, generate_invalid

REPO = Path(__file__).resolve().parents[2]
WORKFLOWS = REPO / ".github" / "workflows"


def _cli(*args):
    from aicad_oracle.cli import main

    return main([str(a) for a in args])


# ---------------------------------------------------------------------------------------------
# oracle diff exit codes
# ---------------------------------------------------------------------------------------------

def test_diff_with_a_missing_forge_bin_is_a_usage_error_not_a_golden_fallback(capsys):
    rc = _cli("diff", REPO / "corpus" / "programs", "--forge-bin", "/nonexistent/aicad",
              "--fail-on-robustness")
    captured = capsys.readouterr()
    assert rc == 2
    assert "forge binary not found" in captured.err
    assert "MATCH=" not in captured.out  # nothing was compared


def test_diff_over_no_programs_is_a_usage_error(tmp_path, capsys):
    assert _cli("diff", tmp_path) == 2
    assert "no IR programs" in capsys.readouterr().err


def test_no_reference_fails_only_when_asked(tmp_path, capsys):
    progs = tmp_path / "programs"
    progs.mkdir()
    shutil.copy(REPO / "corpus" / "programs" / "extrude_box.json", progs)
    empty_golden = tmp_path / "golden"
    empty_golden.mkdir()
    assert _cli("diff", progs, "--golden-dir", empty_golden) == 0
    assert "NO_REFERENCE=1" in capsys.readouterr().out
    assert _cli("diff", progs, "--golden-dir", empty_golden, "--fail-on-no-reference") == 1


# ---------------------------------------------------------------------------------------------
# workflow wiring (text checks: PyYAML is not an oracle dependency)
# ---------------------------------------------------------------------------------------------

def _job(workflow: str, job: str) -> str:
    text = (WORKFLOWS / workflow).read_text()
    m = re.search(rf"^  {re.escape(job)}:\s*$(.*?)(?=^  \S|\Z)", text, re.M | re.S)
    assert m, f"{workflow}: no job {job!r}"
    return m.group(1)


def _step(body: str, name: str) -> str:
    """The text of the job step whose `name:` starts with `name`."""
    m = re.search(rf"^      - name: {re.escape(name)}.*?$(.*?)(?=^      - |\Z)", body, re.M | re.S)
    assert m, f"no step {name!r}"
    return m.group(0)


INDEPENDENT = "if: success() || failure()"


def _diff_commands(body: str) -> list[str]:
    # Join folded (">-") and backslash-continued lines, then pick the `oracle diff` calls.
    joined = re.sub(r"\\\n\s*", " ", body)
    joined = re.sub(r">-\n((?:[ ]{10,}\S.*\n?)+)", lambda m: " ".join(m.group(1).split()) + "\n", joined)
    return [ln.strip() for ln in joined.splitlines() if "oracle diff" in ln]


def test_ci_oracle_job_builds_forge_and_diffs_it_with_every_gate():
    body = _job("ci.yml", "oracle-diff")
    build = body.find("cargo build -p forge-cli")
    assert build >= 0, "the job must build the engine under test"
    diffs = _diff_commands(body)
    assert len(diffs) >= 2, diffs  # corpus/programs + generated programs + error corpus
    assert body.find("oracle diff") > build, "Forge must be built before the diff runs"
    for cmd in diffs:
        assert "--forge-bin ../forge/target/debug/aicad" in cmd, cmd
        assert "--fail-on-robustness" in cmd and "--fail-on-no-reference" in cmd, cmd
    assert any("../corpus/programs" in c for c in diffs)
    assert any("/invalid" in c for c in diffs), "the error corpus must be diffed too"
    assert re.search(r"uv run (--locked )?pytest", body), "the oracle's own tests must run"
    # A failing diff must not hide the next one.
    for step in ("Forge vs OCCT over the generated programs", "Forge vs OCCT over the error corpus"):
        assert INDEPENDENT in _step(body, step), step


def test_ci_runs_typescript_wasm_goldens_and_license_gates():
    ts = _job("ci.yml", "ts")
    assert "pnpm install --frozen-lockfile" in ts and "pnpm -r build" in ts and "pnpm -r test" in ts
    assert re.search(r'CADSCRIPT_FC_RUNS:\s*"?\d+', ts), "property-test runs must be pinned"
    wasm = _job("ci.yml", "forge-wasm")
    for crate in ("forge-core", "forge-mesh", "forge-io", "forge-solve"):
        assert re.search(rf"cargo test --target wasm32-wasip1 .*-p {crate}\b", wasm), crate
    for step in ("forge-core golden", "forge-mesh and forge-io", "forge-solve goldens"):
        assert INDEPENDENT in _step(wasm, step), step
    assert "CARGO_TARGET_WASM32_WASIP1_RUNNER: wasmtime" in wasm
    assert re.search(r"cargo clippy --target wasm32-unknown-unknown -p forge-render -p forge-wasm .*-D warnings", wasm)
    forge = _job("ci.yml", "forge")
    assert "mesa-vulkan-drivers" in forge and "FORGE_RENDER_REQUIRE_GPU" in forge
    lic = _job("ci.yml", "licenses")
    for gate in ("cargo deny", "js-licenses.mjs", "oracle-boundary.mjs", "own-licenses.mjs"):
        assert gate in lic, gate
    web = _job("ci.yml", "webgl2")
    assert "scripts/ci/webgl2/test.mjs llvmpipe" in web and "scripts/ci/webgl2/test.mjs auto" in web


def test_nightly_runs_the_full_differential_makerbench_and_solver_oracles():
    diff = _job("nightly.yml", "differential")
    assert re.search(r"oracle gen --count 1000 --seed \"\$SEED\"", diff)
    assert "github.run_number" in diff
    cmds = _diff_commands(diff)
    assert any("/gen/invalid" in c for c in cmds) and any(c.rstrip('"').endswith("gen") or '/gen"' in c for c in cmds)
    for cmd in cmds:
        assert "--forge-bin" in cmd and "--fail-on-robustness" in cmd, cmd
    mb = _job("nightly.yml", "makerbench-forge")
    assert "AICAD_EVALS_REAL_ENGINE: forge" in mb and "cargo build -p forge-cli" in mb
    so = _job("nightly.yml", "solver-oracles")
    for piece in ("--example oracle_corpus", "planegcs_oracle.mjs", "wasm_bench.mjs", "BUDGET_MS = 4.0", "39ec20a99e9b8750"):
        assert piece in so, piece
    # Independent gates: one oracle failing to install or run must not skip the others.
    for step in ("PlaneGCS agreement", "WASM drag budget"):
        assert INDEPENDENT in _step(so, step), step
    # python-solvespace 3.0.8 has wheels for macOS and Windows only, and its sdist does not
    # build (slvs.pyx without slvs.cpp, no Cython build requirement): SolveSpace runs on a
    # macOS runner and never falls back to building from source.
    assert "solvespace_oracle.py" not in so
    ss = _job("nightly.yml", "solver-oracle-solvespace")
    assert re.search(r"^    runs-on: macos-", ss, re.M)
    assert "--example oracle_corpus" in ss
    assert re.search(r"uv run --no-build \S*solvespace_oracle\.py", ss)
    for floor in ("dof_both_solved", "dependency_detected", "class_adj"):
        assert f'("{floor}"' in ss, floor
    assert INDEPENDENT in _step(ss, "SolveSpace agreement")


# ---------------------------------------------------------------------------------------------
# SKETCH_DEGENERATE_LOOP in the error corpus [R-5]
# ---------------------------------------------------------------------------------------------

def _degenerate_cases(seed: int = 11) -> list:
    return [c for c in generate_invalid(seed, 1) if c.kind == "degenerate_loop"]


def _triangle(case) -> list[tuple[float, float]]:
    sk = case.doc["parts"][0]["features"][0]
    lines = [c for c in sk["curves"] if c["id"].startswith("t")]
    assert len(lines) == 3
    return [tuple(c["start"]) for c in lines]


def test_error_corpus_has_degenerate_loops_at_and_just_above_the_bound():
    cases = _degenerate_cases()
    assert "degenerate_loop" in KINDS and len(cases) >= 12
    outcomes = {c.expect["features"]["sketch_1"] for c in cases}
    assert outcomes == {"SKETCH_DEGENERATE_LOOP", "ok"}
    for c in cases:
        if c.expect["features"]["sketch_1"] == "SKETCH_DEGENERATE_LOOP":
            assert c.expect["features"]["extrude_1"] == "DEPENDENCY_FAILED"
    # alone, next to a valid region, and as a hole of one
    assert {n for c in cases for n in ("alone", "next to", "as a hole") if n in c.note} == {"alone", "next to", "as a hole"}


def test_degenerate_loop_areas_are_exactly_tol_squared_in_every_vertex_order():
    cases = _degenerate_cases()
    assert cases
    for c in cases:
        pts = _triangle(c)
        want_exact = c.expect["features"]["sketch_1"] == "SKETCH_DEGENERATE_LOOP"
        for k in range(3):  # every starting vertex, both orientations
            for order in (pts[k:] + pts[:k], list(reversed(pts[k:] + pts[:k]))):
                shoelace = 0.5 * sum(order[i][0] * order[(i + 1) % 3][1] - order[(i + 1) % 3][0] * order[i][1]
                                     for i in range(3))
                o = order[0]  # relative to the first vertex, as Forge computes it
                rel = 0.5 * sum((order[i][0] - o[0]) * (order[(i + 1) % 3][1] - o[1])
                                - (order[(i + 1) % 3][0] - o[0]) * (order[i][1] - o[1]) for i in range(3))
                for a in (abs(shoelace), abs(rel)):
                    if want_exact:
                        assert a == TOL * TOL, (c.note, a)
                    else:
                        assert a > TOL * TOL, (c.note, a)


def test_oracle_meets_the_degenerate_loop_expectations():
    cases = _degenerate_cases()
    assert cases
    for c in cases:
        rep = evaluate_data(c.doc, c.doc["meta"]["name"])
        assert check_case(c, rep) == [], c.note


@pytest.mark.parametrize("bound, broken", [
    (math.nextafter(TOL * TOL, 0.0), "SKETCH_DEGENERATE_LOOP"),  # an exclusive (<) bound
    (TOL * TOL * (1 + 2e-9), "ok"),  # a bound that is too loose
])
def test_degenerate_loop_cases_catch_an_off_by_one_bound(monkeypatch, bound, broken):
    import aicad_oracle.sketch as sketch

    monkeypatch.setattr(sketch, "DEGENERATE_AREA", bound)
    cases = [c for c in _degenerate_cases() if c.expect["features"]["sketch_1"] == broken]
    assert cases
    for c in cases:
        assert check_case(c, evaluate_data(c.doc, c.doc["meta"]["name"])) != [], c.note


def test_degenerate_loop_generation_is_deterministic():
    a = [c.doc for c in _degenerate_cases(5)]
    b = [c.doc for c in _degenerate_cases(5)]
    assert a == b
    assert KINDS["degenerate_loop"](random.Random("x"), "n", 0).doc == KINDS["degenerate_loop"](random.Random("x"), "n", 0).doc
