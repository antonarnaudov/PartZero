# /// script
# requires-python = "==3.11.*"
# dependencies = ["python-solvespace==3.0.8"]
# ///
"""Second, independent oracle for forge-solve: SolveSpace's solver (python-solvespace, GPL).

CI/dev tooling only - never a runtime dependency of Forge (CLAUDE.md principle 1). The
wheel exists for CPython 3.11 on macOS arm64, hence the pin.

    cargo run -p forge-solve --release --example oracle_corpus -- <dir> 1000 2026
    uv run crates/forge-solve/oracle/solvespace_oracle.py <dir>

Compares, per sketch of <dir>/corpus.jsonl against <dir>/forge.jsonl:
  dof        forge DOF == SolveSpace DOF on sketches both solve (SolveSpace's DOF comes
             from its Jacobian rank, like PlaneGCS's and forge's)
  class      clean (under/fully) vs redundant vs conflict. SolveSpace's library reports
             both redundancy and conflict as INCONSISTENT; it writes the solution back
             only when the system is consistent, so its own returned geometry is checked
             against the constraints to tell the two apart.
  dependency detected   both see a dependency (redundant or conflict) or neither does:
             robust, since SolveSpace's library does not separate the two reliably
  class_adj  as `class`, but forge "redundant" vs SolveSpace "conflict" counts as agreement
             when forge's own solution satisfies every constraint (a consistent system
             cannot conflict: SolveSpace simply did not converge on the redundant system)
  mcs ⊆ failed   every forge MCS member is among SolveSpace's "failed" constraints (its
             failed list is "equations left unsatisfied", so this is informative only)
Writes <dir>/solvespace.jsonl and <dir>/summary_solvespace.json.
"""

import json
import math
import sys
from pathlib import Path

import python_solvespace as ss

NONE = ss.Entity.NONE
C = ss.Constraint


class Unsupported(Exception):
    pass


def build(sketch):
    s = ss.SolverSystem()
    s.set_group(1)
    wp = s.create_2d_base()
    nm = s.add_normal_3d(*ss.make_quaternion(1, 0, 0, 0, 1, 0))
    ents = {e["id"]: e for e in sketch["entities"]}
    # Points fixed by entity flags live in group 1 (constants).
    fixed = set()
    for e in sketch["entities"]:
        if not e.get("fixed"):
            continue
        t = e["type"]
        fixed.update({"point": [e["id"]], "line": [e.get("p1"), e.get("p2")],
                      "circle": [e.get("center")], "arc": [e.get("center"), e.get("start"), e.get("end")]}[t])
    # `fix` constraints pin their explicit targets: start those points there.
    pos = {e["id"]: [e["x"], e["y"]] for e in sketch["entities"] if e["type"] == "point"}
    for k in sketch["constraints"]:
        if k["type"] == "fix" and ents[k["entity"]]["type"] == "point":
            p = pos[k["entity"]]
            pos[k["entity"]] = [k.get("x", p[0]), k.get("y", p[1])]
    h = {}
    rad = {}  # circle id → its radius (distance) entity
    for e in sketch["entities"]:
        if e["type"] == "point":
            s.set_group(1 if e["id"] in fixed else 2)
            h[e["id"]] = s.add_point_2d(pos[e["id"]][0], pos[e["id"]][1], wp)
    for e in sketch["entities"]:
        t = e["type"]
        s.set_group(1 if e.get("fixed") else 2)
        if t == "line":
            h[e["id"]] = s.add_line_2d(h[e["p1"]], h[e["p2"]], wp)
        elif t == "circle":
            rad[e["id"]] = s.add_distance(e["radius"], wp)
            h[e["id"]] = s.add_circle(nm, h[e["center"]], rad[e["id"]], wp)
        elif t == "arc":
            h[e["id"]] = s.add_arc(nm, h[e["center"]], h[e["start"]], h[e["end"]], wp)
    s.set_group(2)
    owner = []  # SolveSpace constraint handle (1-based) → our constraint id

    def add(fn, cid):
        fn()
        owner.append(cid)

    def cross_sign(p, line):
        a, b = pos[ents[line]["p1"]], pos[ents[line]["p2"]]
        q = pos[p]
        c = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])
        return 1.0 if c >= 0 else -1.0

    for k in sketch["constraints"]:
        if k.get("driving") is False:
            continue
        t, cid = k["type"], k["id"]
        if t == "coincident":
            add(lambda: s.coincident(h[k["a"]], h[k["b"]], wp), cid)
        elif t == "horizontal":
            add(lambda: s.horizontal(h[k["line"]], wp), cid)
        elif t == "vertical":
            add(lambda: s.vertical(h[k["line"]], wp), cid)
        elif t == "parallel":
            add(lambda: s.parallel(h[k["a"]], h[k["b"]], wp), cid)
        elif t == "perpendicular":
            add(lambda: s.perpendicular(h[k["a"]], h[k["b"]], wp), cid)
        elif t == "tangent":
            ta, tb = ents[k["a"]]["type"], ents[k["b"]]["type"]
            if {ta, tb} == {"line", "arc"}:
                arc, line = (k["a"], k["b"]) if ta == "arc" else (k["b"], k["a"])
                A, L = ents[arc], ents[line]
                if A["start"] in (L["p1"], L["p2"]) or joined(sketch, A["start"], (L["p1"], L["p2"])):
                    other = 0
                elif A["end"] in (L["p1"], L["p2"]) or joined(sketch, A["end"], (L["p1"], L["p2"])):
                    other = 1
                else:
                    raise Unsupported("line-arc tangency without a shared endpoint")
                add(lambda: s.add_constraint(C.ARC_LINE_TANGENT, wp, 0.0, NONE, NONE, h[arc], h[line], other=other), cid)
            elif ta == "arc" and tb == "arc":
                A, B = ents[k["a"]], ents[k["b"]]
                pair = None
                for oa, pa in ((0, A["start"]), (1, A["end"])):
                    for ob, pb in ((0, B["start"]), (1, B["end"])):
                        if pair is None and (pa == pb or joined(sketch, pa, (pb,))):
                            pair = (oa, ob)
                if pair is None:
                    raise Unsupported("arc-arc tangency without a shared endpoint")
                add(lambda: s.add_constraint(C.CURVE_CURVE_TANGENT, wp, 0.0, NONE, NONE, h[k["a"]], h[k["b"]],
                                             other=pair[0], other2=pair[1]), cid)
            else:
                raise Unsupported(f"tangent {ta}-{tb}")
        elif t == "equal":
            add(lambda: s.equal(h[k["a"]], h[k["b"]], wp), cid)
        elif t == "distance":
            if ents[k["b"]]["type"] == "line":
                v = k["value"] * cross_sign(k["a"], k["b"])
                add(lambda: s.distance(h[k["a"]], h[k["b"]], v, wp), cid)
            else:
                add(lambda: s.distance(h[k["a"]], h[k["b"]], k["value"], wp), cid)
        elif t == "angle":
            v = abs(k["value"])
            if v < 1e-6 or abs(v - 180.0) < 1e-6:
                raise Unsupported("0/180 degree angle (singular in SolveSpace's cosine form)")
            add(lambda: s.angle(h[k["a"]], h[k["b"]], v, wp), cid)
        elif t in ("radius", "diameter"):
            d = 2.0 * k["value"] if t == "radius" else k["value"]
            add(lambda: s.diameter(h[k["curve"]], d), cid)
        elif t == "point_on_line":
            add(lambda: s.coincident(h[k["point"]], h[k["line"]], wp), cid)
        elif t == "point_on_circle":
            add(lambda: s.add_constraint(C.PT_ON_CIRCLE, wp, 0.0, h[k["point"]], NONE, h[k["curve"]], NONE), cid)
        elif t == "midpoint":
            add(lambda: s.midpoint(h[k["point"]], h[k["line"]], wp), cid)
        elif t == "symmetric":
            add(lambda: s.symmetric(h[k["a"]], h[k["b"]], h[k["line"]], wp), cid)
        elif t == "fix":
            e = ents[k["entity"]]
            if e["type"] == "point":
                add(lambda: s.dragged(h[e["id"]], wp), cid)
            elif e["type"] == "line":
                add(lambda: s.dragged(h[e["p1"]], wp), cid)
                add(lambda: s.dragged(h[e["p2"]], wp), cid)
            else:
                add(lambda: s.dragged(h[e["center"]], wp), cid)
                add(lambda: s.diameter(h[e["id"]], 2.0 * e["radius"]), cid)
        else:
            raise Unsupported(t)
    return s, h, rad, owner


def joined(sketch, p, others):
    """p is joined to one of `others` through driving coincident constraints."""
    adj = {}
    for k in sketch["constraints"]:
        if k["type"] == "coincident" and k.get("driving", True):
            adj.setdefault(k["a"], set()).add(k["b"])
            adj.setdefault(k["b"], set()).add(k["a"])
    seen, stack = {p}, [p]
    while stack:
        for n in adj.get(stack.pop(), ()):
            if n not in seen:
                seen.add(n)
                stack.append(n)
    return any(o in seen for o in others)


def violation(sketch, s, h, rad):
    """Largest violation of our constraints on SolveSpace's returned geometry."""
    ents = {e["id"]: e for e in sketch["entities"]}
    P = {i: s.params(h[i].params) for i, e in ents.items() if e["type"] == "point"}

    def radius(cid):
        e = ents[cid]
        if e["type"] == "circle":
            return s.params(rad[cid].params)[0]
        c, a = P[e["center"]], P[e["start"]]
        return math.hypot(a[0] - c[0], a[1] - c[1])

    def line(i):
        e = ents[i]
        return P[e["p1"]], P[e["p2"]]

    def ldist(p, l):
        a, b = l
        d = (b[0] - a[0], b[1] - a[1])
        return abs(d[0] * (p[1] - a[1]) - d[1] * (p[0] - a[0])) / math.hypot(*d)

    worst = 0.0
    for e in ents.values():
        if e["type"] == "arc":
            c, a, b = P[e["center"]], P[e["start"]], P[e["end"]]
            worst = max(worst, abs(math.hypot(a[0] - c[0], a[1] - c[1]) - math.hypot(b[0] - c[0], b[1] - c[1])))
    for k in sketch["constraints"]:
        if k.get("driving") is False:
            continue
        t = k["type"]
        if t == "coincident":
            a, b = P[k["a"]], P[k["b"]]
            err = math.hypot(a[0] - b[0], a[1] - b[1])
        elif t in ("horizontal", "vertical"):
            a, b = line(k["line"])
            err = abs(b[1] - a[1]) if t == "horizontal" else abs(b[0] - a[0])
        elif t in ("parallel", "perpendicular", "angle"):
            (a1, b1), (a2, b2) = line(k["a"]), line(k["b"])
            u, v = (b1[0] - a1[0], b1[1] - a1[1]), (b2[0] - a2[0], b2[1] - a2[1])
            cr, dt = u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]
            n = math.hypot(*u) * math.hypot(*v)
            if t == "parallel":
                err = abs(cr) / n
            elif t == "perpendicular":
                err = abs(dt) / n
            else:
                e_ = math.atan2(cr, dt) - math.radians(k["value"])
                err = abs(math.atan2(math.sin(e_), math.cos(e_)))
        elif t == "tangent":
            ta, tb = ents[k["a"]]["type"], ents[k["b"]]["type"]
            if "line" in (ta, tb):
                l, cv = (k["a"], k["b"]) if ta == "line" else (k["b"], k["a"])
                err = abs(ldist(P[ents[cv]["center"]], line(l)) - radius(cv))
            else:
                c1, c2 = P[ents[k["a"]]["center"]], P[ents[k["b"]]["center"]]
                d = math.hypot(c2[0] - c1[0], c2[1] - c1[1])
                r1, r2 = radius(k["a"]), radius(k["b"])
                err = min(abs(d - (r1 + r2)), abs(d - abs(r1 - r2)))
        elif t == "equal":
            if ents[k["a"]]["type"] == "line":
                (a1, b1), (a2, b2) = line(k["a"]), line(k["b"])
                err = abs(math.hypot(b1[0] - a1[0], b1[1] - a1[1]) - math.hypot(b2[0] - a2[0], b2[1] - a2[1]))
            else:
                err = abs(radius(k["a"]) - radius(k["b"]))
        elif t == "distance":
            if ents[k["b"]]["type"] == "line":
                err = abs(ldist(P[k["a"]], line(k["b"])) - k["value"])
            else:
                a, b = P[k["a"]], P[k["b"]]
                err = abs(math.hypot(b[0] - a[0], b[1] - a[1]) - k["value"])
        elif t == "radius":
            err = abs(radius(k["curve"]) - k["value"])
        elif t == "diameter":
            err = abs(2 * radius(k["curve"]) - k["value"])
        elif t == "point_on_line":
            err = ldist(P[k["point"]], line(k["line"]))
        elif t == "point_on_circle":
            c = P[ents[k["curve"]]["center"]]
            p = P[k["point"]]
            err = abs(math.hypot(p[0] - c[0], p[1] - c[1]) - radius(k["curve"]))
        elif t == "midpoint":
            a, b = line(k["line"])
            p = P[k["point"]]
            err = math.hypot(p[0] - (a[0] + b[0]) / 2, p[1] - (a[1] + b[1]) / 2)
        elif t == "symmetric":
            a, b = P[k["a"]], P[k["b"]]
            l = line(k["line"])
            m = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            d = (l[1][0] - l[0][0], l[1][1] - l[0][1])
            err = ldist(m, l) + abs(d[0] * (b[0] - a[0]) + d[1] * (b[1] - a[1])) / math.hypot(*d)
        elif t == "fix":
            e = ents[k["entity"]]
            if e["type"] == "point":
                p = P[e["id"]]
                err = math.hypot(p[0] - k.get("x", e["x"]), p[1] - k.get("y", e["y"]))
            else:
                err = 0.0  # dragged() pins the (input) positions exactly
        else:
            err = 0.0
        worst = max(worst, err)
    return worst


def main():
    d = Path(sys.argv[1] if len(sys.argv) > 1 else "../../../target/forge-solve-oracle")
    corpus = [json.loads(l) for l in (d / "corpus.jsonl").read_text().splitlines() if l]
    forge = [json.loads(l) for l in (d / "forge.jsonl").read_text().splitlines() if l]
    assert len(corpus) == len(forge)
    tallies = {k: [0, 0] for k in ("dof_both_solved", "dependency_detected", "class", "class_adj",
                                    "conflict_detected", "mcs_subset_failed", "redundant_detected",
                                    "redundant_in_failed")}
    unsupported, disagreements = 0, []
    out = open(d / "solvespace.jsonl", "w")

    def hit(k, ok):
        tallies[k][1] += 1
        tallies[k][0] += 1 if ok else 0

    for g, f in zip(corpus, forge):
        sk = g["sketch"]
        try:
            s, h, rad, owner = build(sk)
        except Unsupported as e:
            unsupported += 1
            out.write(json.dumps({"name": g["name"], "unsupported": str(e)}) + "\n")
            continue
        res = s.solve()
        dof = s.dof()
        failed = sorted({owner[i - 1] for i in s.failures() if 0 < i <= len(owner)})
        viol = violation(sk, s, h, rad)
        if res == 0:
            cls = "clean"
        elif res in (1, 2):
            cls = "redundant" if viol <= 1e-6 else "conflict"
        else:
            cls = "failed"
        fc = {"conflict": "conflict", "over_constrained_redundant": "redundant",
              "failed_to_converge": "failed"}.get(f["status"], "clean")
        note = []
        hit("class", fc == cls)
        hit("dependency_detected", (fc == "clean") == (cls == "clean"))
        adj = fc == cls or (fc == "redundant" and cls == "conflict" and f["ok"])
        hit("class_adj", adj)
        if not adj:
            note.append(f"class forge {fc} solvespace {cls} (result {res}, violation {viol:.2e})")
        if cls in ("clean", "redundant") and fc in ("clean", "redundant"):
            hit("dof_both_solved", dof == f["dof"])
            if dof != f["dof"]:
                note.append(f"dof forge {f['dof']} solvespace {dof}")
        if "conflict" in (fc, cls):
            hit("conflict_detected", fc == cls)
        if fc == "conflict" and cls == "conflict":
            for m in f["conflicts"]:
                ok = set(m) <= set(failed)
                hit("mcs_subset_failed", ok)
                if not ok:
                    note.append(f"mcs {m} not within failed {failed}")
        if "redundant" in (fc, cls):
            hit("redundant_detected", fc == cls)
        if fc == "redundant" and cls == "redundant":
            for r in f["redundant"]:
                hit("redundant_in_failed", r in failed)
        out.write(json.dumps({"name": g["name"], "result": res, "dof": dof, "failed": failed,
                              "class": cls, "violation": viol, "note": note}) + "\n")
        if note:
            disagreements.append({"name": g["name"], "note": note})
    out.close()
    summary = {"sketches": len(corpus), "unsupported": unsupported,
               "rates": {k: {"ok": v[0], "n": v[1], "rate": (v[0] / v[1]) if v[1] else None} for k, v in tallies.items()},
               "disagreements": disagreements[:200], "disagreement_count": len(disagreements)}
    (d / "summary_solvespace.json").write_text(json.dumps(summary, indent=2))
    print("| Check | Agreement |\n|---|---|")
    for k, (ok, n) in tallies.items():
        print(f"| {k} | {ok}/{n} ({100 * ok / n:.1f}%) |" if n else f"| {k} | n/a |")
    print(f"\nunsupported (skipped): {unsupported}; disagreements: {len(disagreements)}")
    for x in disagreements[:15]:
        print(" ", x["name"], "; ".join(x["note"]))


if __name__ == "__main__":
    main()
