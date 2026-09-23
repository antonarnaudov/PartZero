"""`oracle` command line: eval / diff / golden / gen."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


# ---------------------------------------------------------------------------------------------
# eval
# ---------------------------------------------------------------------------------------------

def _cmd_eval(args) -> int:
    from .evaluate import check_report, dumps_report, evaluate_file

    path = Path(args.file)
    if not path.is_file():
        print(f"oracle eval: no such file: {path}", file=sys.stderr)
        return 2
    checks: list[str] | None = [] if args.self_check else None
    shapes: list | None = [] if args.step else None
    report = evaluate_file(path, checks, shapes)
    if args.step:
        from .evaluate import export_step

        if shapes:
            export_step(shapes, args.step)
            print(f"oracle eval: wrote {len(shapes)} bodies to {args.step}", file=sys.stderr)
        else:
            print("oracle eval: no bodies to export", file=sys.stderr)
    errs = check_report(report)
    if errs:
        print("oracle eval: INTERNAL: report violates metrics-v0.schema.json:", file=sys.stderr)
        for e in errs:
            print(f"  {e}", file=sys.stderr)
        return 3
    text = dumps_report(report)
    if args.out:
        _write(Path(args.out), text)
    else:
        sys.stdout.write(text)
    if report.get("error") and not report["features"]:
        # SPEC §0 [R-10]: a rejected document exits 2 with its diagnostics (the JSON report with
        # the top-level error is still written, for tooling).
        e = report["error"]
        print(f"oracle eval: document rejected: {e['code']}: {e['message']}", file=sys.stderr)
        return 2
    if checks:
        print("oracle eval: self-check failures:", file=sys.stderr)
        for c in checks:
            print(f"  {c}", file=sys.stderr)
        return 4
    return 0 if report["status"] == "ok" else 1


# ---------------------------------------------------------------------------------------------
# diff
# ---------------------------------------------------------------------------------------------

def _cmd_diff(args) -> int:
    from .compare import CODE_MISMATCH, ROBUSTNESS, SILENT_WRONG, compare_reports
    from .diffrun import (
        NO_REFERENCE,
        default_golden_dir,
        diff_one,
        golden_path,
        list_programs,
        render_markdown,
        render_table,
        resolve_forge_bin,
        run_forge,
        summary_counts,
    )
    from .evaluate import check_report, evaluate_file

    if args.a or args.b:
        if not (args.a and args.b):
            print("oracle diff: --a and --b must be given together", file=sys.stderr)
            return 2
        a = json.loads(Path(args.a).read_text())
        b = json.loads(Path(args.b).read_text())
        cmp = compare_reports(a, b, "a", "b")
        print(f"{cmp.classification}")
        for d in cmp.differences:
            print(f"  {d}")
        for n in cmp.notes:
            print(f"  note: {n}")
        if args.report:
            from .diffrun import Row

            row = Row(Path(args.a).name + " vs " + Path(args.b).name, "b", a.get("status", "?"),
                      b.get("status", "?"), cmp.classification, cmp, list(cmp.notes))
            _write(Path(args.report), render_markdown([row], "Report diff", [f"a = `{args.a}`", f"b = `{args.b}`"]))
        failing = {SILENT_WRONG, CODE_MISMATCH} | ({ROBUSTNESS} if args.fail_on_robustness else set())
        return 1 if cmp.classification in failing else 0

    if not args.target:
        print("oracle diff: give a program file/directory, or --a/--b", file=sys.stderr)
        return 2
    target = Path(args.target)
    if not target.exists():
        print(f"oracle diff: no such file or directory: {target}", file=sys.stderr)
        return 2
    programs = list_programs(target)
    if not programs:
        # A diff over zero programs compares nothing; never let it pass as a green gate.
        print(f"oracle diff: no IR programs in {target}", file=sys.stderr)
        return 2
    forge = resolve_forge_bin(args.forge_bin)
    golden_dir = Path(args.golden_dir) if args.golden_dir else default_golden_dir(target)
    notes: list[str] = []
    if args.forge_bin and forge is None:
        # An explicitly requested engine that cannot be found is a usage error, never a silent
        # fallback: comparing the oracle with oracle-written goldens says nothing about Forge.
        print(f"oracle diff: forge binary not found: {args.forge_bin!r} (build it with "
              f"`cargo build -p forge-cli` in forge/, or omit --forge-bin to compare the oracle "
              f"against the golden reports in {golden_dir})", file=sys.stderr)
        return 2
    if forge is None:
        notes.append(f"no --forge-bin given; comparing the oracle against golden reports in {golden_dir}")
    else:
        notes.append(f"forge = `{forge}`")

    rows = []
    for prog in programs:
        oracle_report = evaluate_file(prog)
        bad = check_report(oracle_report)
        if bad:
            print(f"oracle diff: INTERNAL: oracle report for {prog} violates the schema: {bad[:3]}", file=sys.stderr)
            return 3
        if forge is not None:
            ref, problem = run_forge(forge, prog, args.timeout)
            rows.append(diff_one(prog, oracle_report, ref, "forge", problem))
        else:
            gp = golden_path(golden_dir, prog)
            ref = json.loads(gp.read_text()) if gp.is_file() else None
            rows.append(diff_one(prog, oracle_report, ref, "golden", None))

    print(render_table(rows))
    counts = summary_counts(rows)
    print("\n" + "  ".join(f"{k}={v}" for k, v in counts.items()))
    if args.report:
        _write(Path(args.report), render_markdown(rows, "Forge vs OCCT oracle diff", notes))
        print(f"report written to {args.report}")
    failed = (counts.get(SILENT_WRONG, 0) + counts.get(CODE_MISMATCH, 0) > 0
              or (args.fail_on_robustness and counts.get(ROBUSTNESS, 0) > 0)
              or (args.fail_on_no_reference and counts.get(NO_REFERENCE, 0) > 0))
    return 1 if failed else 0


# ---------------------------------------------------------------------------------------------
# golden
# ---------------------------------------------------------------------------------------------

def _cmd_golden(args) -> int:
    from .diffrun import default_golden_dir, list_programs
    from .evaluate import check_report, dumps_report, evaluate_file

    src = Path(args.dir)
    out = Path(args.out) if args.out else default_golden_dir(src)
    rc = 0
    for prog in list_programs(src):
        checks: list[str] = []
        rep = evaluate_file(prog, checks)
        bad = check_report(rep)
        if bad:
            print(f"{prog.name}: INTERNAL: report violates the schema: {bad[:3]}", file=sys.stderr)
            return 3
        dest = out / f"{prog.stem}.metrics.json"
        _write(dest, dumps_report(rep))
        vols = [
            f"{b['volume']:.10g}" for f in rep["features"] for b in f.get("bodies", [])
        ]
        print(f"{prog.stem:32s} {rep['status']:5s} volumes=[{', '.join(vols)}] -> {dest}")
        for c in checks:
            print(f"  SELF-CHECK FAILED: {c}", file=sys.stderr)
            rc = 4
    return rc


# ---------------------------------------------------------------------------------------------
# gen
# ---------------------------------------------------------------------------------------------

def _gen_one(task: tuple[int, int, int]) -> dict:
    """Worker: produce program `index` (retrying on oracle failure). Returns a result dict."""
    import random

    from .evaluate import check_report, evaluate_data
    from .generator import generate_program
    from .ir import DocumentError, load_document

    seed, index, max_attempts = task
    name = f"gen_s{seed}_{index:05d}"
    failures = []
    for attempt in range(max_attempts):
        rng = random.Random(f"aicad-gen/{seed}/{index}/{attempt}")
        doc = generate_program(rng, name)
        try:
            load_document(json.loads(json.dumps(doc)))
        except DocumentError as e:
            failures.append({"attempt": attempt, "kind": "invalid_ir", "code": e.code, "message": e.message, "doc": doc})
            continue
        checks: list[str] = []
        t0 = time.perf_counter()
        try:
            rep = evaluate_data(doc, name, checks)
        except Exception as e:  # pragma: no cover - evaluate_data catches feature errors
            failures.append({"attempt": attempt, "kind": "oracle_crash", "code": type(e).__name__,
                             "message": str(e), "doc": doc})
            continue
        dt = time.perf_counter() - t0
        bad = check_report(rep)
        if bad:
            failures.append({"attempt": attempt, "kind": "bad_report", "code": "REPORT_SCHEMA", "message": "; ".join(bad[:3]), "doc": doc})
            continue
        if rep["status"] != "ok":
            errs = [f["error"] for f in rep["features"] if f.get("error")] or [rep.get("error")]
            failures.append({"attempt": attempt, "kind": "oracle_error", "code": errs[0]["code"],
                             "message": errs[0]["message"], "doc": doc})
            continue
        if checks:
            failures.append({"attempt": attempt, "kind": "self_check", "code": "SELF_CHECK",
                             "message": " | ".join(checks), "doc": doc})
            continue
        return {"index": index, "name": name, "doc": doc, "report": rep, "failures": failures, "seconds": dt}
    return {"index": index, "name": name, "doc": None, "report": None, "failures": failures, "seconds": 0.0}


def _cmd_gen(args) -> int:
    from concurrent.futures import ProcessPoolExecutor

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rej = out / "failed"
    tasks = [(args.seed, i, args.max_attempts) for i in range(args.count)]
    t0 = time.perf_counter()
    jobs = max(1, args.jobs)
    if jobs == 1:
        results = [_gen_one(t) for t in tasks]
    else:
        with ProcessPoolExecutor(max_workers=jobs) as ex:
            results = list(ex.map(_gen_one, tasks, chunksize=4))
    elapsed = time.perf_counter() - t0

    generated = 0
    features = {"extrude": 0, "revolve": 0, "sketch": 0}
    bodies = 0
    face_types: dict[str, int] = {}
    failure_codes: dict[str, int] = {}
    failure_kinds: dict[str, int] = {}
    failure_list = []
    gave_up = []
    for r in sorted(results, key=lambda r: r["index"]):
        for f in r["failures"]:
            failure_codes[f["code"]] = failure_codes.get(f["code"], 0) + 1
            failure_kinds[f["kind"]] = failure_kinds.get(f["kind"], 0) + 1
            fname = f"{r['name']}_a{f['attempt']}.json"
            _write(rej / fname, json.dumps(f["doc"], indent=1) + "\n")
            failure_list.append({"file": f"failed/{fname}", "kind": f["kind"], "code": f["code"],
                                 "message": f["message"][:500]})
        if r["doc"] is None:
            gave_up.append(r["name"])
            continue
        generated += 1
        _write(out / f"{r['name']}.json", json.dumps(r["doc"], indent=1) + "\n")
        if args.with_reports:
            from .evaluate import dumps_report

            _write(out / f"{r['name']}.metrics.json", dumps_report(r["report"]))
        for fr in r["report"]["features"]:
            features[fr["type"]] = features.get(fr["type"], 0) + 1
            for b in fr.get("bodies", []):
                bodies += 1
                for k, v in b["face_types"].items():
                    face_types[k] = face_types.get(k, 0) + v
    attempts = generated + len(failure_list)
    stats = {
        "seed": args.seed,
        "requested": args.count,
        "generated": generated,
        "gave_up": gave_up,
        "attempts": attempts,
        "failures": len(failure_list),
        "failures_by_kind": dict(sorted(failure_kinds.items())),
        "failures_by_code": dict(sorted(failure_codes.items())),
        "features": features,
        "bodies": bodies,
        "face_types": dict(sorted(face_types.items())),
        "seconds": round(elapsed, 2),
        "failure_details": failure_list,
    }
    _write(out / f"gen_s{args.seed}.stats.json", json.dumps(stats, indent=2) + "\n")
    print(f"generated {generated}/{args.count} programs in {elapsed:.1f}s ({jobs} jobs) -> {out}")
    print(f"attempts {attempts}, oracle/self-check failures {len(failure_list)} "
          f"(by kind {stats['failures_by_kind']}, by code {stats['failures_by_code']})")
    print(f"features {features}, bodies {bodies}, face types {stats['face_types']}")
    for f in failure_list[:20]:
        print(f"  {f['file']}: {f['kind']} {f['code']}: {f['message'][:200]}")
    if gave_up:
        print(f"gave up on {len(gave_up)} programs after {args.max_attempts} attempts: {gave_up[:10]}")
    inv_ok = _gen_invalid(args, out)
    return 0 if not gave_up and inv_ok else 1


def _gen_invalid(args, out: Path) -> bool:
    """Write the error corpus (programs with a known non-ok outcome) and check the oracle."""
    if args.invalid_per_kind <= 0:
        return True
    from .evaluate import check_report, dumps_report, evaluate_data
    from .invalidgen import check_case, generate_invalid

    inv_dir = Path(args.invalid_out) if args.invalid_out else out / "invalid"
    cases = generate_invalid(args.seed, args.invalid_per_kind)
    by_kind: dict[str, int] = {}
    mismatches = []
    for c in cases:
        by_kind[c.kind] = by_kind.get(c.kind, 0) + 1
        name = c.doc["meta"]["name"]
        _write(inv_dir / f"{name}.json", json.dumps(c.doc, indent=1) + "\n")
        rep = evaluate_data(c.doc, name)
        bad = check_report(rep)
        if args.with_reports:
            _write(inv_dir / f"{name}.metrics.json", dumps_report(rep))
        problems = (bad and [f"report violates schema: {bad[:2]}"]) or check_case(c, rep)
        if problems:
            mismatches.append({"file": f"{name}.json", "kind": c.kind, "note": c.note, "problems": problems})
    stats = {"seed": args.seed, "cases": len(cases), "by_kind": by_kind,
             "expectation_mismatches": len(mismatches), "mismatch_details": mismatches}
    _write(inv_dir / f"inv_s{args.seed}.stats.json", json.dumps(stats, indent=2) + "\n")
    print(f"error corpus: {len(cases)} programs {by_kind} -> {inv_dir}; "
          f"oracle vs expectation mismatches: {len(mismatches)}")
    for m in mismatches[:20]:
        print(f"  {m['file']} ({m['note']}): {'; '.join(m['problems'])[:300]}")
    return not mismatches


# ---------------------------------------------------------------------------------------------
# parser
# ---------------------------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="oracle",
        description="OCCT reference evaluator of aicad IR v0 documents, for differential testing of Forge.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    pe = sub.add_parser("eval", help="evaluate one IR document and print its aicad.metrics/0 report")
    pe.add_argument("file", help="IR v0 JSON document")
    pe.add_argument("--out", help="write the report here instead of stdout")
    pe.add_argument("--self-check", action="store_true",
                    help="print the self-check gate's findings (the gate always runs: a failing body "
                         "is reported as OCCT_SELF_CHECK_FAILED) and exit 4 if there are any")
    pe.add_argument("--step", help="also write the bodies to this STEP file (debugging, via build123d)")
    pe.set_defaults(func=_cmd_eval)

    pd = sub.add_parser("diff", help="compare Forge (or golden reports) against the oracle, per SPEC §6; "
                        "exit 1 on POTENTIAL_SILENT_WRONG or CODE_MISMATCH, 2 on a usage error "
                        "(including a --forge-bin that does not exist, or no programs)")
    pd.add_argument("target", nargs="?", help="IR program file or directory of programs")
    pd.add_argument("--forge-bin", help="Forge CLI; run as `<bin> eval <file> --format json`. Without it the "
                    "oracle is compared against the golden reports; if it is given but missing, exit 2")
    pd.add_argument("--golden-dir", help="golden reports directory (default: <programs>/../golden)")
    pd.add_argument("--report", help="write a Markdown report here")
    pd.add_argument("--timeout", type=float, default=300.0, help="per-program Forge timeout, seconds")
    pd.add_argument("--fail-on-robustness", action="store_true", help="also exit 1 on ROBUSTNESS differences")
    pd.add_argument("--fail-on-no-reference", action="store_true",
                    help="also exit 1 when a program has no reference report (a missing golden file)")
    pd.add_argument("--a", help="compare two report files directly: first report")
    pd.add_argument("--b", help="second report")
    pd.set_defaults(func=_cmd_diff)

    pg = sub.add_parser("golden", help="write <out>/<stem>.metrics.json oracle reports for every program in a directory")
    pg.add_argument("dir", help="directory of IR programs")
    pg.add_argument("--out", help="output directory (default: <dir>/../golden)")
    pg.set_defaults(func=_cmd_golden)

    pn = sub.add_parser("gen", help="generate random valid IR v0 extrude/revolve programs")
    pn.add_argument("--count", type=int, default=1000)
    pn.add_argument("--seed", type=int, default=0)
    pn.add_argument("--out", default="../corpus/generated/")
    pn.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    pn.add_argument("--max-attempts", type=int, default=20)
    pn.add_argument("--with-reports", action="store_true", help="also write <name>.metrics.json oracle reports")
    pn.add_argument("--invalid-per-kind", type=int, default=4,
                    help="error-corpus programs per error kind (0 disables; some kinds use more to "
                         "cover every variant)")
    pn.add_argument("--invalid-out", help="error-corpus directory (default: <out>/invalid)")
    pn.set_defaults(func=_cmd_gen)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
