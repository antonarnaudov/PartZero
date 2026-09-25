"""STEP export check: read Forge's own STEP files with OCCT and compare with Forge's metrics.

CI/dev tooling only (ADR 0000: OCCT never ships). For each exported document the input is a
pair written by ``aicad export --format step --summary``:

* ``<name>.step`` — the file Forge's writer produced (forge-io ``step``);
* ``<name>.summary.json`` — ``aicad.export/1`` with, per body, Forge's own metrics (exact
  volume and area, tight box, topology counts) and what the writer produced (solids, faces,
  edges, vertices, synthesized seams, split pieces).

OCCT (``STEPControl_Reader``, default healing) reads the file, and every body is checked:

* **valid** — ``BRepCheck_Analyzer`` passes on every solid, and each solid is closed;
* **volume, area** — OCCT's exact-geometry mass properties equal Forge's within ``--rel``
  (default 1e-6 relative, FULL-MODELING-PLAN IO-5); the fast fixed-order integrator first, and
  when it disagrees the adaptive ones the boolean oracle uses (Gauss-Kronrod volume, adaptive
  area), which B-spline-trimmed faces need;
* **box** — OCCT's tight box equals Forge's within ``--rel`` of the box diagonal;
* **faces** — the face count equals Forge's;
* **edges** — after seam normalization (OCCT edges minus seam and degenerate edges) the count
  equals the writer's non-seam edges, and those minus the writer's split pieces equal Forge's
  edge count (the writer adds nothing else).

``python -m aicad_oracle.step_check --programs ../corpus/programs ../corpus/v1/programs``
exports the programs with the ``aicad`` binary first; ``--dir DIR`` checks existing pairs
(e.g. the boolean corpus dump of ``cargo run -p forge-io --example step_corpus``). The match
rate is printed and, with ``--json``, written as a report. Exit 0 when every exported body
matches, 1 otherwise, 2 on usage errors.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_REL = 1e-6


@dataclass
class BodyResult:
    """The comparison of one body."""

    name: str
    ok: bool
    problems: list[str] = field(default_factory=list)
    occt: dict = field(default_factory=dict)
    forge: dict = field(default_factory=dict)


@dataclass
class FileResult:
    """The comparison of one exported document."""

    name: str
    status: str  # "match", "mismatch", "export-error", "read-error", "skipped"
    detail: str = ""
    bodies: list[BodyResult] = field(default_factory=list)


def _rel(a: float, b: float) -> float:
    return abs(a - b) / max(abs(a), abs(b), 1e-300)


def read_step(path: Path):
    """The solids of a STEP file, in file order (OCCT's default reader with healing)."""
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_Reader
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    reader = STEPControl_Reader()
    if reader.ReadFile(str(path)) != IFSelect_RetDone:
        raise RuntimeError("OCCT could not read the file")
    if reader.TransferRoots() == 0:
        raise RuntimeError("OCCT transferred no roots")
    shape = reader.OneShape()
    solids = []
    ex = TopExp_Explorer(shape, TopAbs_SOLID)
    while ex.More():
        solids.append(TopoDS.Solid_s(ex.Current()))
        ex.Next()
    return solids


def occt_metrics(solids) -> dict:
    """Validity, mass properties, box and normalized topology counts of a body's solids."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_SHELL
    from OCP.TopExp import TopExp, TopExp_Explorer
    from OCP.TopoDS import TopoDS
    from OCP.TopTools import TopTools_IndexedMapOfShape

    from .occt import surface_props, tight_bbox, volume_props

    valid = True
    closed = True
    volume = area = 0.0
    faces = edges = seams = degenerate = 0
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    for s in solids:
        valid = valid and BRepCheck_Analyzer(s).IsValid()
        ex = TopExp_Explorer(s, TopAbs_SHELL)
        while ex.More():
            closed = closed and BRep_Tool.IsClosed_s(ex.Current())
            ex.Next()
        volume += volume_props(s).Mass()
        area += surface_props(s).Mass()
        blo, bhi = tight_bbox(s)
        lo = [min(a, b) for a, b in zip(lo, blo)]
        hi = [max(a, b) for a, b in zip(hi, bhi)]
        fmap = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(s, TopAbs_FACE, fmap)
        emap = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(s, TopAbs_EDGE, emap)
        faces += fmap.Extent()
        seam_set = set()
        for i in range(1, fmap.Extent() + 1):
            f = TopoDS.Face_s(fmap.FindKey(i))
            fe = TopExp_Explorer(f, TopAbs_EDGE)
            while fe.More():
                e = TopoDS.Edge_s(fe.Current())
                if BRep_Tool.IsClosed_s(e, f):
                    seam_set.add(emap.FindIndex(e))
                fe.Next()
        for i in range(1, emap.Extent() + 1):
            e = TopoDS.Edge_s(emap.FindKey(i))
            if BRep_Tool.Degenerated_s(e):
                degenerate += 1
            elif i in seam_set:
                seams += 1
            else:
                edges += 1
    return {
        "solids": len(solids),
        "valid": valid,
        "closed": closed,
        "volume": volume,
        "area": area,
        "bboxMin": lo,
        "bboxMax": hi,
        "faces": faces,
        "edges": edges,
        "seams": seams,
        "degenerate": degenerate,
    }


def accurate_mass(solids) -> tuple[float, float]:
    """Volume and area by the adaptive integrators (Gauss-Kronrod volume, adaptive area), as
    the boolean oracle measures bodies with B-spline-trimmed faces; slower, so only used when
    the fixed-order result disagrees."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    volume = area = 0.0
    for s in solids:
        p = GProp_GProps()
        BRepGProp.VolumePropertiesGK_s(s, p, 1e-10)
        volume += p.Mass()
        q = GProp_GProps()
        BRepGProp.SurfaceProperties_s(s, q, 1e-12)
        area += q.Mass()
    return volume, area


def compare_body(name: str, occt: dict, forge: dict, step: dict, rel: float) -> BodyResult:
    """Compare OCCT's reading of one body with Forge's metrics and the writer's counts."""
    p: list[str] = []
    if occt["solids"] != step["solids"]:
        p.append(f"OCCT read {occt['solids']} solids, the writer wrote {step['solids']}")
    if not occt["valid"]:
        p.append("BRepCheck_Analyzer: invalid")
    if not occt["closed"]:
        p.append("a shell is not closed")
    if _rel(occt["volume"], forge["volume"]) > rel:
        p.append(f"volume {occt['volume']!r} vs Forge {forge['volume']!r} (rel {_rel(occt['volume'], forge['volume']):.2e})")
    if _rel(occt["area"], forge["area"]) > rel:
        p.append(f"area {occt['area']!r} vs Forge {forge['area']!r} (rel {_rel(occt['area'], forge['area']):.2e})")
    diag = math.dist(forge["bboxMin"], forge["bboxMax"])
    box_err = max(
        max(abs(a - b) for a, b in zip(occt["bboxMin"], forge["bboxMin"])),
        max(abs(a - b) for a, b in zip(occt["bboxMax"], forge["bboxMax"])),
    )
    if box_err > rel * max(diag, 1.0):
        p.append(f"box differs by {box_err:.3e} mm (diagonal {diag:.3g})")
    if occt["faces"] != forge["faces"]:
        p.append(f"{occt['faces']} faces vs Forge {forge['faces']}")
    non_seam = step["edges"] - step["seamEdges"]
    if occt["edges"] != non_seam:
        p.append(f"{occt['edges']} edges after seam normalization vs {non_seam} written")
    if non_seam - step["splitPieces"] != forge["edges"]:
        p.append(f"writer: {non_seam} non-seam edges less {step['splitPieces']} split pieces != Forge's {forge['edges']}")
    if occt["seams"] > step["seamEdges"]:
        p.append(f"OCCT found {occt['seams']} seams, the writer made {step['seamEdges']}")
    return BodyResult(name=name, ok=not p, problems=p, occt=occt, forge=forge)


def check_pair(step_path: Path, summary_path: Path, rel: float) -> FileResult:
    """Check one exported document."""
    name = step_path.stem
    summary = json.loads(summary_path.read_text())
    if summary.get("error"):
        e = summary["error"]
        return FileResult(name, "export-error", f"{e['code']}: {e['message']}")
    try:
        solids = read_step(step_path)
    except Exception as e:  # noqa: BLE001 - any OCCT failure is a result
        return FileResult(name, "read-error", str(e))
    bodies = summary["bodies"]
    want = sum(b["step"]["solids"] for b in bodies)
    if len(solids) != want:
        return FileResult(name, "mismatch", f"OCCT read {len(solids)} solids, {want} written")
    out = FileResult(name, "match")
    k = 0
    for b in bodies:
        n = b["step"]["solids"]
        occt = occt_metrics(solids[k : k + n])
        if _rel(occt["volume"], b["forge"]["volume"]) > rel or _rel(occt["area"], b["forge"]["area"]) > rel:
            occt["fixedOrder"] = {"volume": occt["volume"], "area": occt["area"]}
            occt["volume"], occt["area"] = accurate_mass(solids[k : k + n])
        k += n
        r = compare_body(b["name"], occt, b["forge"], b["step"], rel)
        out.bodies.append(r)
        if not r.ok:
            out.status = "mismatch"
    return out


def export_programs(programs: list[Path], aicad: Path, out_dir: Path, schema: str) -> list[tuple[Path, Path, str]]:
    """Run ``aicad export --format step --summary`` on each program; (step, summary, stderr)."""
    pairs = []
    for prog in programs:
        step = out_dir / f"{prog.stem}.step"
        summ = out_dir / f"{prog.stem}.summary.json"
        r = subprocess.run(
            [str(aicad), "export", str(prog), "--out", str(step), "--format", "step",
             "--step-schema", schema, "--summary", str(summ)],
            capture_output=True, text=True, check=False,
        )
        pairs.append((step, summ, r.stderr.strip()))
    return pairs


def _default_aicad() -> Path:
    here = Path(__file__).resolve()
    for base in here.parents:
        cand = base / "forge" / "target" / "debug" / "aicad"
        if cand.exists():
            return cand
    return Path("aicad")


def run(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="step-check", description=__doc__.splitlines()[0])
    ap.add_argument("--programs", nargs="*", default=[], help="IR programs or directories of them to export and check")
    ap.add_argument("--dir", nargs="*", default=[], help="directories of <name>.step + <name>.summary.json pairs")
    ap.add_argument("--aicad", default=os.environ.get("AICAD_BIN"), help="the aicad binary (default: forge/target/debug/aicad)")
    ap.add_argument("--schema", default="ap214", choices=["ap214", "ap242"])
    ap.add_argument("--rel", type=float, default=DEFAULT_REL, help="relative tolerance for volume, area and box")
    ap.add_argument("--json", help="write the full report here")
    ap.add_argument("--keep", help="keep the exported files in this directory")
    args = ap.parse_args(argv)
    if not args.programs and not args.dir:
        ap.error("give --programs and/or --dir")

    results: list[FileResult] = []
    programs: list[Path] = []
    for p in map(Path, args.programs):
        programs.extend(sorted(p.glob("*.json")) if p.is_dir() else [p])
    if programs:
        aicad = Path(args.aicad) if args.aicad else _default_aicad()
        tmp = Path(args.keep) if args.keep else Path(tempfile.mkdtemp(prefix="step-check-"))
        tmp.mkdir(parents=True, exist_ok=True)
        for step, summ, err in export_programs(programs, aicad, tmp, args.schema):
            if not summ.exists():
                results.append(FileResult(step.stem, "skipped", err.splitlines()[-1] if err else "no output"))
            else:
                results.append(check_pair(step, summ, args.rel))
    for d in map(Path, args.dir):
        for summ in sorted(d.glob("*.summary.json")):
            step = summ.with_name(summ.name.replace(".summary.json", ".step"))
            results.append(check_pair(step, summ, args.rel))

    checked = [r for r in results if r.status in ("match", "mismatch", "read-error", "export-error")]
    bodies = [b for r in results for b in r.bodies]
    matched_bodies = sum(1 for b in bodies if b.ok)
    matched_files = sum(1 for r in checked if r.status == "match")
    for r in results:
        if r.status == "match":
            continue
        print(f"{r.status.upper():13} {r.name}: {r.detail}")
        for b in r.bodies:
            for p in b.problems:
                print(f"    {b.name}: {p}")
    skipped = sum(1 for r in results if r.status == "skipped")
    rate = matched_bodies / len(bodies) if bodies else 0.0
    print(
        f"step-check: {matched_files}/{len(checked)} files and {matched_bodies}/{len(bodies)} bodies match "
        f"(match rate {rate:.1%}); {skipped} programs not exportable by this Forge build"
    )
    if args.json:
        Path(args.json).write_text(json.dumps({
            "schema": "aicad.step-check/1",
            "rel": args.rel,
            "files": len(checked),
            "filesMatched": matched_files,
            "bodies": len(bodies),
            "bodiesMatched": matched_bodies,
            "matchRate": rate,
            "skipped": skipped,
            "results": [
                {
                    "name": r.name,
                    "status": r.status,
                    "detail": r.detail,
                    "bodies": [
                        {"name": b.name, "ok": b.ok, "problems": b.problems, "occt": b.occt, "forge": b.forge}
                        for b in r.bodies
                    ],
                }
                for r in results
            ],
        }, indent=2) + "\n")
    return 0 if checked and matched_files == len(checked) else 1


def main() -> None:
    sys.exit(run())


if __name__ == "__main__":
    main()
