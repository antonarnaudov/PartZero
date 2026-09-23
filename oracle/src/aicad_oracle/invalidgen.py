"""Deterministic generator of programs with a KNOWN non-ok outcome (the "error corpus").

Every case carries its expected result per SPEC, so that Forge's and the oracle's error
handling can be diffed (§6: both rejected = MATCH, different semantic codes = CODE_MISMATCH):

  open_loop        a curve removed, or a line end displaced by 1.5·tol … 1e-3
  branching        a duplicated line, or a "fin" (V→Q→V) attached to an existing vertex
  crossing         a circle dropped onto an existing line
  near_touch       purpose-built pairs at gap g: g ∈ {0.3, 0.6, 0.95}·tol must CROSS [R-3/R-4];
                   controls at g ∈ {1.5, 3, 50}·tol must evaluate ok — line/circle, internal and
                   external circle/circle, vertex/line, parallel line/line
  crosses_axis     a revolve profile reaching δ ∈ {2·tol, 1e-3, …} past the axis [R-7]; with a
                   second, valid region the whole feature still fails; controls: δ = 0.5·tol
                   (within tolerance → ok) and regions on opposite sides (ok)
  dependency       a broken sketch consumed by several features → DEPENDENCY_FAILED [R-1];
                   later, independent features still evaluate ok
  suppressed       a suppressed sketch consumed by a live feature → SKETCH_SUPPRESSED
  degenerate_loop  a triangle (0,0), (2·tol,0), (tol, h) of area h·tol² [R-5]: h = 1 is exactly
                   tol² → SKETCH_DEGENERATE_LOOP (inclusive bound); h = 1 + 1e-9, just above, must
                   evaluate ok — alone, next to a valid region, or as a hole in one
  rejected         structurally invalid documents (RESERVED_NAME, DUPLICATE_NAME across parts,
                   unknown curve field, INCONSISTENT_ARC, DEGENERATE_CURVE, INVALID_ANGLE,
                   INVALID_PLANE, UNRESOLVED_SKETCH) → rejected, exit 2 [R-10]

`expect` is {"rejected": CODE} or {"features": {feature_name: CODE or "ok"}}.
"""

from __future__ import annotations

import copy
import math
import random
from dataclasses import dataclass

from .generator import generate_program, random_plane, rigid
from .ir import LINEAR_TOLERANCE

TOL = LINEAR_TOLERANCE


@dataclass
class Case:
    kind: str
    doc: dict
    expect: dict
    note: str


def _doc(name: str, features: list[dict], desc: str) -> dict:
    return {"schema": "aicad.ir/0", "meta": {"name": name, "description": desc},
            "parts": [{"id": "p1", "name": "part_1", "features": features}]}


def _all_ok(doc: dict) -> dict:
    return {f["name"]: "ok" for p in doc["parts"] for f in p["features"] if not f.get("suppressed")}


def _consumers(doc: dict, sketch_name: str) -> list[dict]:
    return [f for p in doc["parts"] for f in p["features"]
            if f.get("sketch") == sketch_name and not f.get("suppressed")]


def _base_with_lines(rng: random.Random, name: str) -> tuple[dict, dict]:
    """A valid generated program whose first sketch has at least one line and a consumer."""
    for _ in range(200):
        doc = generate_program(rng, name)
        sk = doc["parts"][0]["features"][0]
        if any(c["kind"] == "line" for c in sk["curves"]) and _consumers(doc, sk["name"]):
            return doc, sk
    raise RuntimeError("no suitable base program")


def _fresh_id(sk: dict, stem: str) -> str:
    ids = {c["id"] for c in sk["curves"]}
    k = 0
    while f"{stem}{k}" in ids:
        k += 1
    return f"{stem}{k}"


def _break(doc: dict, sk: dict, code: str) -> dict:
    exp = _all_ok(doc)
    exp[sk["name"]] = code
    for f in _consumers(doc, sk["name"]):
        exp[f["name"]] = "DEPENDENCY_FAILED"
    return exp


# --- mutations of valid programs -------------------------------------------------------------

def open_loop(rng: random.Random, name: str, k: int) -> Case:
    doc, sk = _base_with_lines(rng, name)
    lines = [c for c in sk["curves"] if c["kind"] == "line"]
    victim = rng.choice(lines)
    if k % 2 == 0:
        sk["curves"].remove(victim)
        note = f"removed line {victim['id']}"
    else:
        g = [1.5 * TOL, 5 * TOL, 1e-5, 1e-3][(k // 2) % 4]
        t = rng.uniform(0, 2 * math.pi)
        end = rng.choice(["start", "end"])
        victim[end] = [victim[end][0] + g * math.cos(t), victim[end][1] + g * math.sin(t)]
        note = f"displaced the {end} of {victim['id']} by {g:g} mm"
    return Case("open_loop", doc, {"features": _break(doc, sk, "SKETCH_OPEN_LOOP")}, note)


def branching(rng: random.Random, name: str, k: int) -> Case:
    doc, sk = _base_with_lines(rng, name)
    ln = rng.choice([c for c in sk["curves"] if c["kind"] == "line"])
    if k % 2 == 0:
        dup = dict(ln, id=_fresh_id(sk, "dup"))
        sk["curves"].append(dup)
        note = f"duplicated line {ln['id']}"
    else:
        v = ln["end"]
        q = [v[0] + rng.uniform(-3, 3), v[1] + rng.uniform(-3, 3)]
        sk["curves"] += [{"kind": "line", "id": _fresh_id(sk, "fin_a"), "start": v, "end": q},
                         {"kind": "line", "id": _fresh_id(sk, "fin_b"), "start": q, "end": v}]
        note = f"fin attached at the end of {ln['id']}"
    return Case("branching", doc, {"features": _break(doc, sk, "SKETCH_BRANCHING")}, note)


def crossing(rng: random.Random, name: str, k: int) -> Case:
    doc, sk = _base_with_lines(rng, name)
    ln = rng.choice([c for c in sk["curves"] if c["kind"] == "line"])
    t = rng.uniform(0.2, 0.8)
    c = [ln["start"][0] + t * (ln["end"][0] - ln["start"][0]), ln["start"][1] + t * (ln["end"][1] - ln["start"][1])]
    L = math.dist(ln["start"], ln["end"])
    sk["curves"].append({"kind": "circle", "id": _fresh_id(sk, "cx"), "center": c, "radius": 0.1 * L})
    return Case("crossing", doc, {"features": _break(doc, sk, "SKETCH_CURVES_CROSS")},
                f"circle centred on line {ln['id']}")


def dependency(rng: random.Random, name: str, k: int) -> Case:
    doc, sk = _base_with_lines(rng, name)
    feats = doc["parts"][0]["features"]
    ln = rng.choice([c for c in sk["curves"] if c["kind"] == "line"])
    sk["curves"].remove(ln)
    # a second consumer of the broken sketch, then an independent, valid sketch + extrude
    feats.append({"type": "extrude", "id": "dep_e1", "name": "dep_extrude_1", "sketch": sk["name"], "distance": 2.0})
    feats.append({"type": "sketch", "id": "dep_s2", "name": "dep_sketch_2", "plane": "XY", "curves": [
        {"kind": "circle", "id": "c0", "center": [0.0, 0.0], "radius": 3.0}]})
    feats.append({"type": "extrude", "id": "dep_e2", "name": "dep_extrude_2", "sketch": "dep_sketch_2", "distance": 1.0})
    return Case("dependency", doc, {"features": _break(doc, sk, "SKETCH_OPEN_LOOP")},
                f"removed {ln['id']}; 2 consumers fail, later features stay ok")


def suppressed(rng: random.Random, name: str, k: int) -> Case:
    doc, sk = _base_with_lines(rng, name)
    sk["suppressed"] = True
    exp = _all_ok(doc)
    exp.pop(sk["name"], None)  # a suppressed feature has no report entry
    for f in _consumers(doc, sk["name"]):
        exp[f["name"]] = "SKETCH_SUPPRESSED"
    return Case("suppressed", doc, {"features": exp}, f"sketch {sk['name']} suppressed")


# --- purpose-built near-touch geometry -------------------------------------------------------

def _place(rng: random.Random, curves: list[dict]) -> list[dict]:
    f = rigid(rng.uniform(0, 2 * math.pi), (rng.uniform(-30, 30), rng.uniform(-30, 30)))
    out = []
    for c in curves:
        d = dict(c)
        for key in ("start", "end", "center"):
            if key in d:
                d[key] = list(f(tuple(d[key])))
        out.append(d)
    return out


def _rect(x0, y0, x1, y1, p="r"):
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return [{"kind": "line", "id": f"{p}{i}", "start": list(pts[i]), "end": list(pts[(i + 1) % 4])} for i in range(4)]


NEAR_TOUCH_GAPS = [0.3 * TOL, 0.6 * TOL, 0.95 * TOL, 1.5 * TOL, 3 * TOL, 50 * TOL]


def near_touch(rng: random.Random, name: str, k: int) -> Case:
    g = NEAR_TOUCH_GAPS[k % len(NEAR_TOUCH_GAPS)]
    variant = (k // len(NEAR_TOUCH_GAPS)) % 5
    W, H = rng.uniform(20, 60), rng.uniform(20, 60)
    if variant == 0:  # circle hole near the bottom edge of a rectangle
        R = rng.uniform(2, min(W, H) / 5)
        curves = _rect(0, 0, W, H) + [{"kind": "circle", "id": "hole", "center": [W / 2, R + g], "radius": R}]
        what = "circle/line"
    elif variant == 1:  # internal circle/circle tangency
        R = rng.uniform(10, 30)
        r = rng.uniform(1, R / 3)
        curves = [{"kind": "circle", "id": "outer", "center": [0.0, 0.0], "radius": R},
                  {"kind": "circle", "id": "inner", "center": [R - r - g, 0.0], "radius": r}]
        what = "circle/circle internal"
    elif variant == 2:  # external circle/circle tangency (two separate regions)
        r1, r2 = rng.uniform(2, 20), rng.uniform(2, 20)
        curves = [{"kind": "circle", "id": "left", "center": [0.0, 0.0], "radius": r1},
                  {"kind": "circle", "id": "right", "center": [r1 + r2 + g, 0.0], "radius": r2}]
        what = "circle/circle external"
    elif variant == 3:  # vertex of a triangular hole near an edge
        b, h = rng.uniform(2, W / 4), rng.uniform(2, H / 3)
        tri = [(W / 2, g), (W / 2 + b, g + h), (W / 2 - b, g + h)]
        curves = _rect(0, 0, W, H) + [
            {"kind": "line", "id": f"t{i}", "start": list(tri[i]), "end": list(tri[(i + 1) % 3])} for i in range(3)]
        what = "vertex/line"
    else:  # parallel line/line: rectangular hole whose bottom edge runs at gap g
        curves = _rect(0, 0, W, H) + _rect(W / 4, g, 3 * W / 4, H / 2, p="h")
        what = "parallel line/line"
    crosses = g <= TOL
    feats = [{"type": "sketch", "id": "s1", "name": "sketch_1", "plane": random_plane(rng), "curves": _place(rng, curves)},
             {"type": "extrude", "id": "e1", "name": "extrude_1", "sketch": "sketch_1", "distance": rng.uniform(1, 10)}]
    exp = ({"sketch_1": "SKETCH_CURVES_CROSS", "extrude_1": "DEPENDENCY_FAILED"} if crosses
           else {"sketch_1": "ok", "extrude_1": "ok"})
    return Case("near_touch", _doc(name, feats, ""), {"features": exp},
                f"{what} gap {g / TOL:g}·tol → {'cross' if crosses else 'control, ok'}")


# --- revolve profiles crossing the axis ------------------------------------------------------

AXIS_DELTAS = [2 * TOL, 10 * TOL, 1e-3, 0.5, 0.5 * TOL, None]  # None: two regions on opposite sides


def crosses_axis(rng: random.Random, name: str, k: int) -> Case:
    delta = AXIS_DELTAS[k % len(AXIS_DELTAS)]
    with_good = (k // len(AXIS_DELTAS)) % 2 == 1
    phi = rng.uniform(0, 2 * math.pi)
    a = (math.cos(phi), math.sin(phi))
    p = (-a[1], a[0])
    O = (rng.uniform(-20, 20), rng.uniform(-20, 20))

    def f(rho, z):
        return [O[0] + z * a[0] + rho * p[0], O[1] + z * a[1] + rho * p[1]]

    def rect(r0, r1, z0, z1, pre):
        pts = [f(r0, z0), f(r1, z0), f(r1, z1), f(r0, z1)]
        return [{"kind": "line", "id": f"{pre}{i}", "start": pts[i], "end": pts[(i + 1) % 4]} for i in range(4)]

    W, Z = rng.uniform(3, 20), rng.uniform(3, 20)
    if delta is None:
        curves = rect(1.0, 1.0 + W, 0, Z, "a") + rect(-1.0 - W, -1.0, 0, Z, "b")
        crosses, what = False, "regions on opposite sides (ok)"
    else:
        curves = rect(-delta, W, 0, Z, "a")
        crosses = delta > TOL
        what = f"profile reaches {delta:g} mm past the axis"
        if with_good:
            curves += rect(1.0, 1.0 + W, Z + 2, 2 * Z + 2, "g")
            what += " + one valid region"
    ang = rng.choice([360.0, 90.0, 200.0])
    feats = [{"type": "sketch", "id": "s1", "name": "sketch_1", "plane": random_plane(rng), "curves": curves},
             {"type": "revolve", "id": "r1", "name": "revolve_1", "sketch": "sketch_1",
              "axis": {"origin": list(O), "direction": list(a)}, "angle": ang}]
    exp = {"sketch_1": "ok", "revolve_1": "REVOLVE_CROSSES_AXIS" if crosses else "ok"}
    return Case("crosses_axis", _doc(name, feats, ""), {"features": exp}, what)


# --- degenerate loops [R-5] ------------------------------------------------------------------

#: Apex heights h (× tol) of the triangle (0,0), (2·tol,0), (tol, h·tol), whose area is h·tol².
#: h = 1 is exactly tol², the inclusive [R-5] bound: every shoelace product of these points is a
#: power-of-two multiple of tol·tol, so any engine computes the area exactly, in any vertex
#: order and after the exact symmetries below. h = 1 + 1e-9 is just above the bound (a margin of
#: ~4.5e6 ulp) and must evaluate ok. Apexes below tol are avoided: the apex would then lie within
#: tol of the base line, where the [R-4] overlap rule, not [R-5], decides.
DEGENERATE_APEX = [1.0, 1.0 + 1e-9]
DEGENERATE_LAYOUTS = ["alone", "next to a valid region", "as a hole in a valid region"]


def _square_symmetry(i: int):
    """One of the 8 symmetries of the square (exact in floating point: swaps and negations)."""

    def f(p: tuple[float, float]) -> list[float]:
        x, y = p
        if i & 4:
            x, y = y, x
        if i & 1:
            x = -x
        if i & 2:
            y = -y
        return [x + 0.0, y + 0.0]  # + 0.0 turns -0.0 into 0.0

    return f


def degenerate_loop(rng: random.Random, name: str, k: int) -> Case:
    h = DEGENERATE_APEX[k % len(DEGENERATE_APEX)]
    layout = (k // len(DEGENERATE_APEX)) % len(DEGENERATE_LAYOUTS)
    sym = rng.randrange(8)
    f = _square_symmetry(sym)
    pts = [f((0.0, 0.0)), f((2 * TOL, 0.0)), f((TOL, h * TOL))]
    tri = [{"kind": "line", "id": f"t{i}", "start": pts[i], "end": pts[(i + 1) % 3]} for i in range(3)]
    if rng.random() < 0.5:  # traverse the loop the other way round
        tri = [{"kind": "line", "id": c["id"], "start": c["end"], "end": c["start"]} for c in reversed(tri)]
    r = rng.randrange(3)
    tri = tri[r:] + tri[:r]
    W, H = rng.uniform(5, 30), rng.uniform(5, 30)
    if layout == 1:  # a separate, valid region away from the triangle
        x0, y0 = rng.uniform(5, 20), rng.uniform(-20, 5)
        curves = tri + _rect(x0, y0, x0 + W, y0 + H)
    elif layout == 2:  # the triangle is a hole of a valid region
        curves = _rect(-W / 2, -H / 2, W / 2, H / 2) + tri
    else:
        curves = tri
    degenerate = h <= 1.0  # [R-5]: |area| ≤ tol² (inclusive)
    feats = [{"type": "sketch", "id": "s1", "name": "sketch_1", "plane": random_plane(rng), "curves": curves},
             {"type": "extrude", "id": "e1", "name": "extrude_1", "sketch": "sketch_1", "distance": rng.uniform(1, 10)}]
    exp = ({"sketch_1": "SKETCH_DEGENERATE_LOOP", "extrude_1": "DEPENDENCY_FAILED"} if degenerate
           else {"sketch_1": "ok", "extrude_1": "ok"})
    area = "exactly tol²" if h == 1.0 else f"{h:.10g}·tol² (just above)"
    return Case("degenerate_loop", _doc(name, feats, ""), {"features": exp},
                f"triangle of area {area} {DEGENERATE_LAYOUTS[layout]}, symmetry {sym}")


# --- rejected documents ----------------------------------------------------------------------

def rejected(rng: random.Random, name: str, k: int) -> Case:
    doc = generate_program(rng, name)
    feats = doc["parts"][0]["features"]
    sk = feats[0]
    variant = k % 8
    if variant == 0:
        feats[-1]["name"] = "extrude" if feats[-1]["type"] != "sketch" else "sketch"
        code, note = "RESERVED_NAME", "feature named like a CadScript builtin"
    elif variant == 1:
        doc["parts"].append({"id": "p_dup", "name": "part_dup", "features": [copy.deepcopy(sk)]})
        doc["parts"][-1]["features"][0]["id"] = "other_id"
        code, note = "DUPLICATE_NAME", "sketch name reused in a second part"
    elif variant == 2:
        sk["curves"][0]["weight"] = 1.0
        code, note = "IR_SCHEMA_INVALID", "unknown field inside a curve"
    elif variant == 3:
        sk["curves"].append({"kind": "arc", "id": "bad_arc", "start": [0.0, 1.0], "end": [0.0, -1.0 - 5e-6],
                             "center": [0.0, 0.0], "ccw": True})
        code, note = "INCONSISTENT_ARC", "|end−center| − |start−center| = 5e-6"
    elif variant == 4:
        sk["curves"].append({"kind": "line", "id": "tiny", "start": [0.0, 0.0], "end": [0.0, TOL]})
        code, note = "DEGENERATE_CURVE", "line of length exactly tol (degenerate, inclusive)"
    elif variant == 5:
        feats.append({"type": "revolve", "id": "bad_r", "name": "bad_revolve", "sketch": sk["name"],
                      "axis": {"origin": [0.0, 0.0], "direction": [0.0, 1.0]}, "angle": 400.0})
        code, note = "INVALID_ANGLE", "angle 400°"
    elif variant == 6:
        sk["plane"] = {"origin": [0.0, 0.0, 0.0], "normal": [0.0, 0.0, 1.0], "x_dir": [1.0, 0.0, 1e-7]}
        code, note = "INVALID_PLANE", "normal·x_dir cos = 1e-7 > 1e-9"
    else:
        feats.insert(0, {"type": "extrude", "id": "early", "name": "too_early", "sketch": sk["name"], "distance": 1.0})
        code, note = "UNRESOLVED_SKETCH", "extrude before its sketch"
    return Case("rejected", doc, {"rejected": code}, note)


KINDS = {
    "open_loop": open_loop,
    "branching": branching,
    "crossing": crossing,
    "near_touch": near_touch,
    "crosses_axis": crosses_axis,
    "dependency": dependency,
    "suppressed": suppressed,
    "degenerate_loop": degenerate_loop,
    "rejected": rejected,
}
#: near_touch / crosses_axis / degenerate_loop / rejected cycle through fixed variant tables;
#: give them enough cases to cover every variant once per `per_kind` round (degenerate_loop:
#: twice, with different symmetries, orientations and planes).
MIN_PER_KIND = {"near_touch": 30, "crosses_axis": 12, "degenerate_loop": 12, "rejected": 8}


def generate_invalid(seed: int, per_kind: int) -> list[Case]:
    cases: list[Case] = []
    for kind, fn in KINDS.items():
        n = max(per_kind, MIN_PER_KIND.get(kind, 0)) if per_kind > 0 else 0
        for k in range(n):
            name = f"inv_s{seed}_{kind}_{k:03d}"
            c = fn(random.Random(f"aicad-inv/{seed}/{kind}/{k}"), name, k)
            c.doc["meta"] = {"name": name, "description": f"{kind}: {c.note}; expect {_fmt_expect(c.expect)}"}
            cases.append(c)
    return cases


def _fmt_expect(e: dict) -> str:
    if "rejected" in e:
        return f"rejected {e['rejected']}"
    return ", ".join(f"{k}={v}" for k, v in e["features"].items())


def check_case(case: Case, report: dict) -> list[str]:
    """Compare an oracle report with the case's expectation; return mismatches."""
    e = case.expect
    if "rejected" in e:
        got = (report.get("error") or {}).get("code")
        if report.get("features") or got != e["rejected"]:
            return [f"expected rejection {e['rejected']}, got {got or report.get('status')}"]
        return []
    out = []
    got = {f["feature"]: (f["error"]["code"] if f["status"] == "error" else "ok") for f in report.get("features", [])}
    if report.get("error"):
        return [f"unexpected rejection {report['error']['code']}: {report['error']['message'][:200]}"]
    for name, want in e["features"].items():
        if got.get(name) != want:
            out.append(f"{name}: expected {want}, got {got.get(name)}")
    extra = set(got) - set(e["features"])
    if extra:
        out.append(f"unexpected report entries {sorted(extra)}")
    return out
