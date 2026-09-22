"""`oracle diff`: run the oracle and Forge (or the committed golden reports) over programs."""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .compare import CODE_MISMATCH, MATCH, ROBUSTNESS, SILENT_WRONG, Comparison, compare_reports
from .ir import METRICS_SCHEMA

NO_REFERENCE = "NO_REFERENCE"


@dataclass
class Row:
    program: str
    reference: str  # "forge", "golden" or "none"
    oracle_status: str
    reference_status: str
    classification: str
    comparison: Comparison | None = None
    notes: list[str] = field(default_factory=list)


def list_programs(target: Path) -> list[Path]:
    if target.is_dir():
        return sorted(
            p for p in target.glob("*.json") if not p.name.endswith((".metrics.json", ".stats.json"))
        )
    return [target]


def resolve_forge_bin(forge_bin: str | None) -> Path | None:
    if not forge_bin:
        return None
    p = Path(forge_bin)
    if p.is_file():
        return p
    found = shutil.which(forge_bin)
    return Path(found) if found else None


def rejected_report(code: str, message: str, engine: str = "forge") -> dict:
    """Stand-in report for an engine that rejected the document (SPEC §0 [R-10]: exit code 2)."""
    return {"schema": METRICS_SCHEMA, "engine": engine, "document": "", "status": "error",
            "error": {"code": code, "message": message}, "features": []}


def run_forge(forge_bin: Path, program: Path, timeout: float = 300.0) -> tuple[dict | None, str | None]:
    """Run `<forge-bin> eval <file> --format json` and parse the report from stdout.

    * exit code 2 → the document was rejected (SPEC §0 [R-10]); stdout may or may not carry a
      report, and stderr carries the diagnostics;
    * any other exit code is accepted as long as stdout carries a report (Forge may signal
      `status: error` through its exit code).
    Returns (report, problem): report is None when Forge crashed or printed no report.
    """
    try:
        proc = subprocess.run(
            [str(forge_bin), "eval", str(program), "--format", "json"],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return None, f"forge timed out after {timeout:.0f}s"
    except OSError as e:
        return None, f"cannot run forge: {e}"
    report = None
    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError:
        pass
    if proc.returncode == 2:
        diag = " | ".join((proc.stderr or "").strip().splitlines()[-3:])
        if isinstance(report, dict) and report.get("error"):
            return {**report, "features": []}, None
        return rejected_report("REJECTED", diag or "rejected (exit 2)"), None
    if report is None:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]
        return None, f"forge exited {proc.returncode} without a JSON report: {' | '.join(tail)}"
    if not isinstance(report, dict) or report.get("schema") != METRICS_SCHEMA:
        return None, f"forge output is not an {METRICS_SCHEMA} report"
    return report, None


def default_golden_dir(target: Path) -> Path:
    base = target if target.is_dir() else target.parent
    return base.parent / "golden"


def golden_path(golden_dir: Path, program: Path) -> Path:
    return golden_dir / f"{program.stem}.metrics.json"


def diff_one(program: Path, oracle_report: dict, reference: dict | None, ref_name: str, ref_problem: str | None) -> Row:
    ost = oracle_report.get("status", "?")
    if reference is None:
        if ref_problem is not None:
            # The reference engine crashed / produced no report: a robustness difference.
            cmp = Comparison()
            cmp.add("report", ref_problem, ROBUSTNESS)
            return Row(program.stem, ref_name, ost, "crash", ROBUSTNESS, cmp)
        return Row(program.stem, "none", ost, "-", NO_REFERENCE)
    cmp = compare_reports(reference, oracle_report, ref_name, "oracle")
    rst = "rejected" if reference.get("error") and not reference.get("features") else reference.get("status", "?")
    if oracle_report.get("error") and not oracle_report.get("features"):
        ost = "rejected"
    return Row(program.stem, ref_name, ost, rst, cmp.classification, cmp, list(cmp.notes))


def render_table(rows: list[Row]) -> str:
    headers = ["program", "reference", "oracle", "ref", "result", "first difference"]
    data = []
    for r in rows:
        first = str(r.comparison.differences[0]) if r.comparison and r.comparison.differences else ""
        data.append([r.program, r.reference, r.oracle_status, r.reference_status, r.classification, first])
    widths = [max(len(h), *(len(d[i]) for d in data)) if data else len(h) for i, h in enumerate(headers)]
    widths[-1] = min(widths[-1], 100)
    line = "  ".join(h.ljust(w) for h, w in zip(headers, widths))
    out = [line, "  ".join("-" * w for w in widths)]
    for d in data:
        d = d[:-1] + [d[-1][:100]]
        out.append("  ".join(c.ljust(w) for c, w in zip(d, widths)))
    return "\n".join(out)


def summary_counts(rows: list[Row]) -> dict[str, int]:
    out = {MATCH: 0, ROBUSTNESS: 0, CODE_MISMATCH: 0, SILENT_WRONG: 0, NO_REFERENCE: 0}
    for r in rows:
        out[r.classification] = out.get(r.classification, 0) + 1
    return out


def render_markdown(rows: list[Row], title: str, header_notes: list[str]) -> str:
    counts = summary_counts(rows)
    md = [f"# {title}", ""]
    md += [f"- {n}" for n in header_notes]
    md += [
        "",
        "| result | count |",
        "|---|---|",
        *[f"| {k} | {v} |" for k, v in counts.items()],
        "",
        "| program | reference | oracle | reference status | result |",
        "|---|---|---|---|---|",
    ]
    for r in rows:
        md.append(f"| `{r.program}` | {r.reference} | {r.oracle_status} | {r.reference_status} | **{r.classification}** |")
    details = [r for r in rows if r.comparison and (r.comparison.differences or r.notes)]
    if details:
        md += ["", "## Differences", ""]
        for r in details:
            md.append(f"### `{r.program}` — {r.classification}")
            md.append("")
            for d in r.comparison.differences:
                md.append(f"- `{d.classification}` {d.path}: {d.detail}")
            for n in r.notes:
                md.append(f"- note: {n}")
            md.append("")
    return "\n".join(md) + "\n"
