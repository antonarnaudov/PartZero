"""The IR v1 **error corpus** (IR-V1 plan, W7 acceptance: "at least 3 cases per **E** code the
oracle can compute, each with the expected code; the oracle agrees with every expectation"), as
documents: `oracle gen --ir v1` writes them to `<out>/invalid` (or `--invalid-out`) with the manifest
`err1_expected.stats.json` (a `.stats.json` name, so `oracle diff` does not take it for a program),
and `oracle diff <dir> --forge-bin …` runs Forge against the same programs (the W5 acceptance's
"`HOLE_*` reproduced by both engines", and every other E code).

Each case is a valid document (it passes the §0.5 rejection pipeline) whose evaluation fails **one**
feature or parameter with the expected code at the E stage: R/E codes (`INVALID_*`,
`DEGENERATE_CURVE`, `INCONSISTENT_ARC`, `EXPR_NOT_INTEGER`, `PARAM_OUT_OF_RANGE`,
`SKETCH_INVALID_DIMENSION`) through expressions, which the rejection pipeline cannot evaluate.

**Codes the oracle cannot compute** (`NOT_COMPUTABLE`, with the reason). The plan excludes only
the first two (the replay-only `SKETCH_*` solver outcomes); the other six go beyond it and are
**pending the plan owner's acceptance** (W7b report, second review): `*_FAILED` and
`INVALID_RESULT` name an engine's own failure, which the SPEC does not define an outcome for — it
defines the operation's result, and gives every size limit its own code — so the oracle never
reports them: where OCCT cannot build what the SPEC defines it reports its own failure as
engine-internal `OCCT_*` (W7b review 5: a notched box opened on its notched top is a valid shell,
2534 mm³ in closed form, that OCCT returns unchanged; reported as the catalogue `SHELL_FAILED`,
a Forge failure with the same code would have compared as MATCH). `REF_UNCERTAIN` waits for W7c's
§5.7 step 4 fallback — when that lands it moves to the computed codes with its 3 cases.

| Code | Why |
|---|---|
| `SKETCH_CONSTRAINT_CONFLICT`, `SKETCH_SOLVE_FAILED` | solver outcomes the oracle replays, never computes (§8.1) |
| `FILLET_FAILED`, `CHAMFER_FAILED`, `SHELL_FAILED`, `DRAFT_FAILED` | an engine's own failure on an operation the SPEC defines; the oracle reports OCCT's as `OCCT_FILLET_FAILED`, `OCCT_CHAMFER_FAILED`, `OCCT_SHELL_FAILED`, `OCCT_DRAFT_FAILED` (engine-internal: `ROBUSTNESS` against any Forge outcome) |
| `INVALID_RESULT` | an engine's own invalid body (§7.1, v0 [R-12]); the oracle reports its own as `OCCT_*` |
| `REF_UNCERTAIN` | arises only in the §5.7 step 4 geometric fallback, which the oracle does not implement (`ORACLE_REF_FALLBACK_UNSUPPORTED`) |
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from . import consts

#: Cases whose own probes do not replay unambiguously (§8.1: a probe on coincident faces of two
#: bodies with agreeing normals is no match), which `oracle diff` against Forge would classify
#: ROBUSTNESS instead of checking the code — listed in the manifest (`replay_ambiguous`), and
#: pinned by `test_error_corpus_probes_replay`. Empty: every case replays (W7b review 4).
REPLAY_AMBIGUOUS: dict[str, str] = {}

NOT_COMPUTABLE = {
    "SKETCH_CONSTRAINT_CONFLICT": "a solver outcome the oracle replays (§8.1)",
    "SKETCH_SOLVE_FAILED": "a solver outcome the oracle replays (§8.1)",
    "FILLET_FAILED": "an engine's own failure on a fillet the SPEC defines; the oracle reports OCCT's as OCCT_FILLET_FAILED",
    "CHAMFER_FAILED": "an engine's own failure on a chamfer the SPEC defines; the oracle reports OCCT's as OCCT_CHAMFER_FAILED",
    "SHELL_FAILED": "an engine's own failure on a shell the SPEC defines; the oracle reports OCCT's as OCCT_SHELL_FAILED",
    "DRAFT_FAILED": "an engine's own failure on a draft the SPEC defines; the oracle reports OCCT's as OCCT_DRAFT_FAILED",
    "INVALID_RESULT": "an engine's own invalid body (§7.1); the oracle reports its own as OCCT_*",
    "REF_UNCERTAIN": "only from the §5.7 step 4 geometric fallback, which the oracle does not implement",
}


@dataclass(frozen=True)
class ErrCase:
    name: str
    doc: dict
    code: str
    #: ("feature", feature id) or ("param", parameter name): the entry that fails with `code`.
    where: tuple[str, str]


# ---------------------------------------------------------------------------------------------
# Builders (the same shapes as the tests' `test_v1_support`)
# ---------------------------------------------------------------------------------------------

def doc(*features, params=None) -> dict:
    d: dict = {"schema": "aicad.ir/1", "meta": {"name": "err"}, "parts": [{"id": "p1", "name": "part",
                                                                           "features": list(features)}]}
    if params:
        d["params"] = list(params)
    return d


def P(name, unit, value, **kw) -> dict:
    return {"name": name, "unit": unit, "value": value, **kw}


def sk(fid, curves, plane="XY", **kw) -> dict:
    return {"type": "sketch", "id": fid, "name": f"n_{fid}", "plane": plane, "curves": curves, **kw}


def ex(fid, sketch, distance, **kw) -> dict:
    return {"type": "extrude", "id": fid, "name": f"n_{fid}", "sketch": sketch, "distance": distance, **kw}


def rv(fid, sketch, angle=360, origin=(0, 0), direction=(0, 1), **kw) -> dict:
    return {"type": "revolve", "id": fid, "name": f"n_{fid}", "sketch": sketch,
            "axis": {"origin": list(origin), "direction": list(direction)}, "angle": angle, **kw}


def rect(cid, w, h, center=(0, 0), **kw) -> dict:
    return {"kind": "rect", "id": cid, "center": list(center), "w": w, "h": h, **kw}


def circle(cid, center, radius, **kw) -> dict:
    return {"kind": "circle", "id": cid, "center": list(center), "radius": radius, **kw}


def line(cid, a, b) -> dict:
    return {"kind": "line", "id": cid, "start": list(a), "end": list(b)}


def ref(kind, q, **kw) -> dict:
    return {"kind": kind, "q": q, **kw}


def body_of(fid) -> dict:
    return ref("body", {"op": "body", "feature": fid})


def face(q, **kw) -> dict:
    return {"face": ref("face", q, **kw)}


def cap_q(fid, end="end") -> dict:
    return {"op": "cap", "feature": fid, "end": end}


def plate(t=10, w=40, d=30, fid="e1", sid="s1", **kw) -> list:
    return [sk(sid, [rect("o", w, d, **kw)]), ex(fid, sid, t)]


def disk(r=5, t=10) -> list:
    return [sk("s1", [circle("c", (0, 0), r)]), ex("e1", "s1", t)]


def boolean(op, targets="e1", tools="e2", **kw) -> dict:
    return {"type": "boolean", "id": "b1", "name": "op", "op": op, "targets": body_of(targets),
            "tools": body_of(tools), **kw}


def two_blocks(w=10, gap=5.0, t=4) -> list:
    return [sk("s1", [rect("a", w, w)]), ex("e1", "s1", t),
            sk("s2", [rect("b", w, w, center=(w + gap, 0))]), ex("e2", "s2", t)]


def hole(at, hid="h1", on=None, **kw) -> dict:
    return {"type": "hole", "id": hid, "name": f"n_{hid}", "on": on or face(cap_q("e1")), "at": at, **kw}


def one_at(x=0.0, y=0.0) -> dict:
    return {"list": [{"id": "a", "at": [x, y]}]}


def blend(kind, size, q, fid=None, **kw) -> dict:
    fid = fid or ("f1" if kind == "fillet" else "c1")
    return {"type": kind, "id": fid, "name": f"n_{fid}", "edges": ref("edge", q),
            **({"r": size} if kind == "fillet" else {"d": size}), **kw}


def shell(t, open_q=None, body="e1", **kw) -> dict:
    s = {"type": "shell", "id": "sh1", "name": "h", "thickness": t, "body": body_of(body), **kw}
    if open_q is not None:
        s["open"] = ref("face", open_q)
    return s


def draft(q, **kw) -> dict:
    return {"type": "draft", "id": "d1", "name": "t", "neutral": "XY", "angle": 3, "faces": ref("face", q), **kw}


def pattern(layout, seed=("e2",), **kw) -> dict:
    return {"type": "pattern", "id": "pt1", "name": "p", "seed": {"features": list(seed)}, "layout": layout, **kw}


def datum_plane(did, mode, **kw) -> dict:
    return {"type": "datum_plane", "id": did, "name": f"n_{did}", "mode": mode, **kw}


def datum_axis(did, mode, **kw) -> dict:
    return {"type": "datum_axis", "id": did, "name": f"n_{did}", "mode": mode, **kw}


def tag(q, kind="face", tid="t1", **kw) -> dict:
    return {"type": "tag", "id": tid, "name": f"n_{tid}", "target": ref(kind, q, **kw)}


VERT = {"op": "filter", "where": {"parallel": "Z"}, "of": {"op": "edges", "of": {"op": "sides", "feature": "e1"}}}
TOP = {"op": "edges", "of": cap_q("e1")}
ROUND = [sk("s1", [rect("o", 40, 30, r=3)]), ex("e1", "s1", 10)]
OTHER = [sk("s9", [rect("x", 4, 4, center=(100, 0))]), ex("e9", "s9", 4)]
BOSS = [*plate(), sk("s2", [circle("b", (15, 0), 2)], plane=face(cap_q("e1"))),
        ex("e2", "s2", 3, op="join", targets=body_of("e1"))]
#: a bar cut in two by a slot: both pieces keep the key `e1/cap:end@o.bottom` of the top face
SPLIT = [*plate(t=4, w=40, d=10), sk("s2", [rect("gap", 2, 14)]),
         ex("e2", "s2", 10, direction="symmetric", op="cut", targets=body_of("e1"))]
#: the capture (§5.6) of SPLIT's top face before the slot: `e1/cap:end@o.bottom`, one plane
TOP_CAPTURE = {"members": [{"key": "e1/cap:end@o.bottom", "via": "named", "geom": {
    "type": "plane", "carrier": {"plane": {"normal": [0.0, 0.0, 1.0], "offset": 4.0}},
    "bbox": [[-20.0, -5.0, 4.0], [20.0, 5.0, 4.0]], "size": 400.0, "centroid": [0.0, 0.0, 4.0],
    "local": [0.5, 0.5, 1.0], "body_center": [0.0, 0.0, 2.0], "neighbors": 0}}]}
#: a rod cut by an oblique plane: its section is an ellipse (an edge with no axis, §3.2)
ELLIPSE = [*disk(5, 30), sk("s2", [rect("t", 60, 60)], plane={"origin": [0, 0, 15], "normal": [-0.5, 0, 1],
                                                           "x_dir": [0, 1, 0]}),
           ex("e2", "s2", 40, op="cut", targets=body_of("e1"))]
ELLIPSE_EDGE = {"op": "filter", "where": {"type": "ellipse"}, "of": {"op": "edges", "of": {"op": "body", "feature": "e1"}}}
#: the plate's side faces (four: a `one` reference to them is ambiguous)
SIDES = {"op": "sides", "feature": "e1"}
CYL = {"op": "sides", "feature": "e1"}  # of a disk: its one cylinder face


def _f(fid: str) -> tuple[str, str]:
    return ("feature", fid)


def _p(name: str) -> tuple[str, str]:
    return ("param", name)


# ---------------------------------------------------------------------------------------------
# The cases
# ---------------------------------------------------------------------------------------------

def _cases() -> list[ErrCase]:
    C: list[ErrCase] = []

    def add(name, d, code, where):
        C.append(ErrCase(name, d, code, where))

    # -- body operations (§6.0.3, §6.4) -----------------------------------------------------------
    add("join-detached", doc(*two_blocks(), boolean("join")), "BOOLEAN_NO_INTERSECTION", _f("b1"))
    add("cut-misses", doc(*two_blocks(), boolean("cut")), "BOOLEAN_NO_INTERSECTION", _f("b1"))
    add("cut-face-contact", doc(*two_blocks(gap=0.0), boolean("cut")), "BOOLEAN_NO_INTERSECTION", _f("b1"))
    add("join-edge-contact", doc(sk("s1", [rect("a", 10, 10)]), ex("e1", "s1", 4),
                                 sk("s2", [rect("b", 10, 10, center=(10, 10))]), ex("e2", "s2", 4), boolean("join")),
        "BOOLEAN_NO_INTERSECTION", _f("b1"))
    # the overlapping tool e3 floats inside e1 (z ∈ [2, 8]) with no face on one of e1's: its body
    # probe lies on e3 alone, so the diff replays it (W7b review 4 — flush with e1's caps it matched
    # 2 bodies, §8.1's "not a match", and the case came out ROBUSTNESS instead of checking its code)
    add("join-along-an-edge-with-overlap-elsewhere", doc(
        sk("s1", [rect("a", 10, 10)]), ex("e1", "s1", 10), sk("s2", [rect("b", 10, 10, center=(10, 10))]),
        ex("e2", "s2", 10),
        sk("s3", [rect("c", 2, 2)], plane={"origin": [0, 0, 2], "normal": [0, 0, 1], "x_dir": [1, 0, 0]}),
        ex("e3", "s3", 6),
        {"type": "boolean", "id": "b1", "name": "op", "op": "join", "targets": body_of("e1"),
         "tools": ref("body", {"op": "union", "of": [{"op": "body", "feature": "e2"}, {"op": "body", "feature": "e3"}]})}),
        "BOOLEAN_NO_INTERSECTION", _f("b1"))
    add("intersect-apart", doc(*two_blocks(), boolean("intersect")), "BOOLEAN_EMPTY_RESULT", _f("b1"))
    add("intersect-touching", doc(*two_blocks(gap=0.0), boolean("intersect")), "BOOLEAN_EMPTY_RESULT", _f("b1"))
    add("intersect-far", doc(*two_blocks(gap=100.0), boolean("intersect")), "BOOLEAN_EMPTY_RESULT", _f("b1"))
    add("tool-is-target", doc(*two_blocks(), boolean("join", tools="e1")), "BOOLEAN_TOOL_IS_TARGET", _f("b1"))
    add("tool-is-target-cut", doc(*two_blocks(), boolean("cut", targets="e2", tools="e2")), "BOOLEAN_TOOL_IS_TARGET",
        _f("b1"))
    add("tool-is-target-all", doc(*two_blocks(), {"type": "boolean", "id": "b1", "name": "op", "op": "intersect",
                                                  "targets": ref("body", {"op": "bodies"}), "tools": body_of("e2")}),
        "BOOLEAN_TOOL_IS_TARGET", _f("b1"))
    top6 = {"origin": [0, 0, 6], "normal": [0, 0, 1], "x_dir": [1, 0, 0]}
    add("pocket-tangent-to-a-side", doc(*plate(6, 20, 20), sk("s2", [circle("c", (8, 0), 2)], plane=top6),
                                        ex("e2", "s2", 3, direction="reverse", op="cut", targets=body_of("e1"))),
        "BOOLEAN_NON_MANIFOLD", _f("e2"))
    add("pocket-tangent-to-the-other-side", doc(*plate(6, 20, 20), sk("s2", [circle("c", (0, -8), 2)], plane=top6),
                                                ex("e2", "s2", 2, direction="reverse", op="cut",
                                                   targets=body_of("e1"))),
        "BOOLEAN_NON_MANIFOLD", _f("e2"))
    add("cut-leaving-pieces-on-an-edge", doc(
        *plate(4, 20, 20), sk("s2", [rect("q1", 10, 10, center=(5, 5))]), ex("e2", "s2", 10, direction="symmetric"),
        sk("s3", [rect("q3", 10, 10, center=(-5, -5))]), ex("e3", "s3", 10, direction="symmetric"),
        {"type": "boolean", "id": "b1", "name": "op", "op": "cut", "targets": body_of("e1"),
         "tools": ref("body", {"op": "union", "of": [{"op": "body", "feature": "e2"}, {"op": "body", "feature": "e3"}]})}),
        "BOOLEAN_NON_MANIFOLD", _f("b1"))
    add("hole-externally-tangent-to-a-hole", doc(
        *plate(5), sk("s2", [circle("h", (0, 0), 3)], plane=face(cap_q("e1"))),
        ex("e2", "s2", 7, direction="reverse", op="cut", targets=body_of("e1")),
        sk("s3", [circle("g", (5, 0), 2)], plane=face(cap_q("e1"))),
        ex("e3", "s3", 7, direction="reverse", op="cut", targets=body_of("e1"))),
        "BOOLEAN_NON_MANIFOLD", _f("e3"))
    add("revolve-crosses-axis", doc(sk("s1", [rect("r", 4, 4, center=(1, 5))]), rv("r1", "s1")),
        "REVOLVE_CROSSES_AXIS", _f("r1"))
    add("revolve-crosses-axis-circle", doc(sk("s1", [circle("c", (1, 5), 2)]), rv("r1", "s1", 90)),
        "REVOLVE_CROSSES_AXIS", _f("r1"))
    add("revolve-crosses-axis-by-param", doc(sk("s1", [rect("r", "w", 4, center=(3, 5))]), rv("r1", "s1"),
                                             params=[P("w", "mm", 8)]),
        "REVOLVE_CROSSES_AXIS", _f("r1"))

    # -- holes (§6.5) -----------------------------------------------------------------------------
    two = {"list": [{"id": "a", "at": [0, 0]}, {"id": "b", "at": [0, 5e-7]}]}
    add("hole-duplicate-list", doc(*plate(20, 40, 40), hole(two, d=2, depth="through")), "HOLE_DUPLICATE_POSITION",
        _f("h1"))
    add("hole-duplicate-grid", doc(*plate(20, 40, 40), hole({"grid": {"nx": 2, "ny": 1, "dx": 1e-7, "dy": 1}}, d=2,
                                                            depth="through")),
        "HOLE_DUPLICATE_POSITION", _f("h1"))
    add("hole-duplicate-circle", doc(*plate(20, 40, 40), hole({"circle": {"n": 3, "d": 1.1e-6}}, d=2, depth="through")),
        "HOLE_DUPLICATE_POSITION", _f("h1"))
    add("hole-off-the-face", doc(*plate(20, 40, 40), hole(one_at(25, 0), d=2, depth="through")),
        "HOLE_POINT_OFF_FACE", _f("h1"))
    add("hole-second-off-the-face", doc(*plate(20, 40, 40),
                                        hole({"list": [{"id": "a", "at": [0, 0]}, {"id": "b", "at": [0, 30]}]}, d=2,
                                             depth="through")),
        "HOLE_POINT_OFF_FACE", _f("h1"))
    add("hole-grid-off-the-face", doc(*plate(20, 40, 40), hole({"grid": {"nx": 2, "ny": 2, "dx": 50, "dy": 1}}, d=2,
                                                               depth="through")),
        "HOLE_POINT_OFF_FACE", _f("h1"))
    far = [sk("s2", [rect("far", 4, 4, center=(100, 0))]), ex("e2", "s2", 5)]
    for i, q in enumerate([cap_q("e2"), cap_q("e2", "start"), {"op": "side", "feature": "e2", "curve": "far.left"}]):
        add(f"hole-up-to-missed-{i}", doc(*plate(20, 40, 40), *far,
                                           hole(one_at(), d=2, depth={"up_to": ref("face", q)}, targets=body_of("e1"))),
            "HOLE_UP_TO_MISSED", _f("h1"))
    high = datum_plane("d1", "offset", **{"from": "XY", "distance": 100})
    for i, at in enumerate([one_at(), {"grid": {"nx": 2, "ny": 2, "dx": 4, "dy": 4}}, {"circle": {"n": 3, "d": 6}}]):
        add(f"hole-misses-body-{i}", doc(*plate(20, 40, 40), high,
                                         hole(at, on={"datum": "d1"}, flip=True, d=2, depth={"blind": 5},
                                              targets="all")),
            "HOLE_MISSES_BODY", _f("h1"))

    # -- fillet, chamfer, shell, draft, pattern (§6.6–§6.10) --------------------------------------
    add("fillet-wider-than-the-face", doc(*plate(), blend("fillet", 16, VERT)), "FILLET_RADIUS_TOO_LARGE", _f("f1"))
    add("fillet-taller-than-the-plate", doc(*plate(), blend("fillet", 11, TOP)), "FILLET_RADIUS_TOO_LARGE", _f("f1"))
    add("fillet-both-ends", doc(*plate(), blend("fillet", 25, VERT)), "FILLET_RADIUS_TOO_LARGE", _f("f1"))
    add("fillet-smooth-junction", doc(*ROUND, blend("fillet", 1, VERT)), "FILLET_EDGE_UNSUPPORTED", _f("f1"))
    add("fillet-smooth-cap-arcs", doc(*ROUND, blend("fillet", 1, {"op": "filter", "where": {"smooth": True}, "of": {
        "op": "edges", "of": {"op": "body", "feature": "e1"}}})), "FILLET_EDGE_UNSUPPORTED", _f("f1"))
    add("fillet-smooth-only", doc(*ROUND, blend("fillet", 0.5, {"op": "edges", "of": {
        "op": "side", "feature": "e1", "curve": "o.c_tr"}}, tangent_chain=False)), "FILLET_EDGE_UNSUPPORTED", _f("f1"))
    top_face = ref("face", cap_q("e1"))
    bottom_face = ref("face", cap_q("e1", "start"))
    add("chamfer-deeper-than-the-plate", doc(*plate(), blend("chamfer", 11, TOP)), "CHAMFER_DISTANCE_TOO_LARGE",
        _f("c1"))
    add("chamfer-wider-than-the-face", doc(*plate(), blend("chamfer", 16, VERT)), "CHAMFER_DISTANCE_TOO_LARGE", _f("c1"))
    add("chamfer-two-distance-too-deep", doc(*plate(), blend("chamfer", 1, TOP, d2=12, side=top_face)),
        "CHAMFER_DISTANCE_TOO_LARGE", _f("c1"))
    add("chamfer-smooth-junction", doc(*ROUND, blend("chamfer", 1, VERT)), "CHAMFER_EDGE_UNSUPPORTED", _f("c1"))
    add("chamfer-smooth-only", doc(*ROUND, blend("chamfer", 0.5, {"op": "filter", "where": {"smooth": True}, "of": {
        "op": "edges", "of": {"op": "body", "feature": "e1"}}})), "CHAMFER_EDGE_UNSUPPORTED", _f("c1"))
    add("chamfer-smooth-side", doc(*ROUND, blend("chamfer", 0.5, {"op": "edges", "of": {
        "op": "side", "feature": "e1", "curve": "o.c_bl"}}, tangent_chain=False)), "CHAMFER_EDGE_UNSUPPORTED", _f("c1"))
    add("chamfer-side-opposite", doc(*plate(), blend("chamfer", 1, TOP, d2=2, side=bottom_face)),
        "CHAMFER_SIDE_NOT_ADJACENT", _f("c1"))
    add("chamfer-side-angle", doc(*plate(), blend("chamfer", 1, TOP, angle=30, side=bottom_face)),
        "CHAMFER_SIDE_NOT_ADJACENT", _f("c1"))
    add("chamfer-side-a-wall", doc(*plate(), blend("chamfer", 1, TOP, d2=1, side=ref(
        "face", {"op": "side", "feature": "e1", "curve": "o.left"}))), "CHAMFER_SIDE_NOT_ADJACENT", _f("c1"))
    add("shell-thicker-than-a-cylinder", doc(*disk(), shell(6, cap_q("e1"))), "SHELL_THICKNESS_TOO_LARGE", _f("sh1"))
    add("shell-exactly-the-radius", doc(*disk(), shell(5, cap_q("e1"))), "SHELL_THICKNESS_TOO_LARGE", _f("sh1"))
    add("shell-walls-collide", doc(*plate(), shell(16, cap_q("e1"))), "SHELL_THICKNESS_TOO_LARGE", _f("sh1"))
    add("shell-open-face-of-another-body", doc(*plate(), *OTHER, shell(1, cap_q("e9"))), "SHELL_FACE_NOT_ON_BODY",
        _f("sh1"))
    add("shell-open-side-of-another-body", doc(*plate(), *OTHER, shell(1, {"op": "side", "feature": "e9",
                                                                             "curve": "x.left"})),
        "SHELL_FACE_NOT_ON_BODY", _f("sh1"))
    add("shell-open-mixed", doc(*plate(), *OTHER, shell(1, {"op": "union", "of": [cap_q("e1"), cap_q("e9")]})),
        "SHELL_FACE_NOT_ON_BODY", _f("sh1"))
    add("draft-a-cylinder", doc(*disk(), draft(SIDES)), "DRAFT_FACE_UNSUPPORTED", _f("d1"))
    add("draft-a-cap", doc(*plate(), draft(cap_q("e1"))), "DRAFT_FACE_UNSUPPORTED", _f("d1"))
    add("draft-rounded-corners", doc(*ROUND, draft(SIDES)), "DRAFT_FACE_UNSUPPORTED", _f("d1"))
    add("pattern-all-off-the-part", doc(*BOSS, pattern({"linear": {"dir": "X", "count": 3, "spacing": 40}})),
        "PATTERN_ALL_INSTANCES_FAILED", _f("pt1"))
    add("pattern-mirror-off-the-part", doc(*BOSS, pattern({"mirror": {"plane": {"origin": [30, 0, 0],
                                                                                "normal": [1, 0, 0],
                                                                                "x_dir": [0, 1, 0]}}})),
        "PATTERN_ALL_INSTANCES_FAILED", _f("pt1"))
    add("pattern-hole-off-the-part", doc(*plate(), hole(one_at(15, 0), d=2, depth="through"),
                                         pattern({"linear": {"dir": "Y", "count": 2, "spacing": 50}}, seed=("h1",))),
        "PATTERN_ALL_INSTANCES_FAILED", _f("pt1"))

    # -- references (§5.5, §5.7) --------------------------------------------------------------------
    no_cyl = {"op": "filter", "where": {"type": "cylinder"}, "of": {"op": "faces", "of": {"op": "body", "feature": "e1"}}}
    add("ref-missing-sketch-plane", doc(*plate(), sk("s2", [circle("c", (0, 0), 2)], plane=face(no_cyl))),
        "REF_MISSING", _f("s2"))
    add("ref-missing-fillet-edges", doc(*plate(), blend("fillet", 1, {"op": "filter", "where": {"type": "circle"},
                                                                      "of": TOP})),
        "REF_MISSING", _f("f1"))
    add("ref-missing-hole-face", doc(*plate(), hole(one_at(), on=face(no_cyl), d=2, depth="through")), "REF_MISSING",
        _f("h1"))
    add("ref-ambiguous-sketch-plane", doc(*plate(), sk("s2", [circle("c", (0, 0), 2)], plane=face(SIDES))),
        "REF_AMBIGUOUS", _f("s2"))
    add("ref-ambiguous-hole-face", doc(*plate(), hole(one_at(), on=face(SIDES), d=2, depth="through")),
        "REF_AMBIGUOUS", _f("h1"))
    add("ref-ambiguous-datum", doc(*plate(), datum_plane("d1", "offset", **{"from": face(SIDES), "distance": 2})),
        "REF_AMBIGUOUS", _f("d1"))
    # two pieces of one key, no capture: §5.7 step 2 → step 5 → REF_AMBIGUOUS (not REF_SPLIT)
    add("ref-ambiguous-split-pieces-without-capture", doc(*SPLIT, sk("s3", [circle("c", (10, 0), 1)],
                                                                     plane=face(cap_q("e1")))),
        "REF_AMBIGUOUS", _f("s3"))
    add("ref-cardinality-fillet", doc(*plate(), blend("fillet", 1, {**VERT}) | {"edges": ref("edge", VERT, card=2)}),
        "REF_CARDINALITY", _f("f1"))
    add("ref-cardinality-tag", doc(*plate(), tag(SIDES, card=3)), "REF_CARDINALITY", _f("t1"))
    add("ref-cardinality-shell-open", doc(*plate(), shell(1) | {"open": ref("face", SIDES, card=1)}),
        "REF_CARDINALITY", _f("sh1"))
    # §5.7 step 3: a captured named member whose key now has two pieces fails a `one` reference
    # with REF_SPLIT (without a capture it is REF_AMBIGUOUS, step 5)
    split_top = {**face(cap_q("e1"), capture=TOP_CAPTURE)}
    add("ref-split-sketch-plane", doc(*SPLIT, sk("s3", [circle("c", (10, 0), 1)], plane=split_top)),
        "REF_SPLIT", _f("s3"))
    add("ref-split-hole-face", doc(*SPLIT, hole(one_at(10, 0), on=split_top, d=1, depth="through")), "REF_SPLIT",
        _f("h1"))
    add("ref-split-datum", doc(*SPLIT, datum_plane("d1", "offset", **{"from": split_top, "distance": 1})),
        "REF_SPLIT", _f("d1"))

    # -- planes, axes, datums (§3) ------------------------------------------------------------------
    add("plane-not-planar-sketch", doc(*disk(), sk("s2", [circle("c", (0, 0), 1)], plane=face(CYL))),
        "PLANE_NOT_PLANAR", _f("s2"))
    add("plane-not-planar-datum", doc(*disk(), datum_plane("d1", "offset", **{"from": face(CYL), "distance": 1})),
        "PLANE_NOT_PLANAR", _f("d1"))
    add("plane-not-planar-hole", doc(*disk(), hole(one_at(), on=face(CYL), d=1, depth="through")),
        "PLANE_NOT_PLANAR", _f("h1"))
    along_n = {"face": ref("face", cap_q("e1")), "x_dir": [0, 0, 1]}
    add("plane-degenerate-sketch", doc(*plate(), sk("s2", [circle("c", (0, 0), 1)], plane=along_n)),
        "PLANE_DEGENERATE", _f("s2"))
    add("plane-degenerate-datum", doc(*plate(), datum_plane("d1", "offset", **{"from": along_n, "distance": 1})),
        "PLANE_DEGENERATE", _f("d1"))
    add("plane-degenerate-hole", doc(*plate(), hole(one_at(), on=along_n, d=1, depth="through")),
        "PLANE_DEGENERATE", _f("h1"))
    add("axis-ref-unsupported-plane-face", doc(*plate(), datum_axis("a1", "cylinder", face=ref("face", cap_q("e1")))),
        "AXIS_REF_UNSUPPORTED", _f("a1"))
    add("axis-ref-unsupported-ellipse-edge", doc(*ELLIPSE, datum_axis("a1", "edge", edge=ref("edge", ELLIPSE_EDGE))),
        "AXIS_REF_UNSUPPORTED", _f("a1"))
    add("axis-ref-unsupported-pattern-axis", doc(*BOSS, pattern({"circular": {"axis": {"cylinder": ref(
        "face", cap_q("e1"))}, "count": 4}})), "AXIS_REF_UNSUPPORTED", _f("pt1"))
    add("axis-ref-unsupported-datum-angle", doc(*ELLIPSE, datum_plane("d1", "angle", **{
        "from": "XY", "axis": {"edge": ref("edge", ELLIPSE_EDGE)}, "angle": 30})),
        "AXIS_REF_UNSUPPORTED", _f("d1"))
    add("datum-angle-axis-not-in-plane", doc(datum_plane("d1", "angle", **{"from": "XY", "axis": "Z", "angle": 30})),
        "DATUM_DEGENERATE", _f("d1"))
    add("datum-midplane-not-parallel", doc(datum_plane("d1", "midplane", a="XY", b="YZ")), "DATUM_DEGENERATE", _f("d1"))
    add("datum-through-collinear", doc(datum_plane("d1", "through", points=[[0, 0, 0], [1, 1, 1], [2, 2, 2]])),
        "DATUM_DEGENERATE", _f("d1"))
    add("datum-axis-parallel-planes", doc(datum_axis("a1", "planes", a="XY", b={"origin": [0, 0, 5], "normal": [0, 0, 1],
                                                                              "x_dir": [1, 0, 0]})),
        "DATUM_DEGENERATE", _f("a1"))
    add("datum-axis-coincident-points", doc(datum_axis("a1", "points", points=[[1, 2, 3], [1, 2, 3.0000005]])),
        "DATUM_DEGENERATE", _f("a1"))

    # -- dependencies (§7.1) ------------------------------------------------------------------------
    bad_datum = datum_plane("d1", "midplane", a="XY", b="YZ")
    add("dependency-failed-sketch-on-datum", doc(bad_datum, sk("s1", [circle("c", (0, 0), 1)], plane={"datum": "d1"})),
        "DEPENDENCY_FAILED", _f("s1"))
    add("dependency-failed-extrude-of-sketch", doc(sk("s1", [line("a", (0, 0), (5, 0)), line("b", (5, 0), (5, 5))]),
                                                   ex("e1", "s1", 2)),
        "DEPENDENCY_FAILED", _f("e1"))
    # the seed cut misses the plate (it starts 5 mm above it): BOOLEAN_NO_INTERSECTION, so the
    # pattern of it depends on a failed feature
    above = {"origin": [0, 0, 15], "normal": [0, 0, 1], "x_dir": [1, 0, 0]}
    add("dependency-failed-pattern-seed", doc(*plate(), sk("s2", [circle("b", (15, 0), 2)], plane=above),
                                              ex("e2", "s2", 3, op="cut", targets=body_of("e1")),
                                              pattern({"linear": {"dir": "X", "count": 2, "spacing": 5}})),
        "DEPENDENCY_FAILED", _f("pt1"))
    sup_datum = datum_plane("d1", "offset", suppressed=True, **{"from": "XY", "distance": 3})
    add("dependency-suppressed-sketch-plane", doc(sup_datum, sk("s1", [circle("c", (0, 0), 1)], plane={"datum": "d1"})),
        "DEPENDENCY_SUPPRESSED", _f("s1"))
    add("dependency-suppressed-datum-from", doc(sup_datum, datum_plane("d2", "offset", **{"from": {"datum": "d1"},
                                                                                        "distance": 1})),
        "DEPENDENCY_SUPPRESSED", _f("d2"))
    add("dependency-suppressed-pattern-seed", doc(*plate(), sk("s2", [circle("b", (15, 0), 2)], plane=face(cap_q("e1"))),
                                                  ex("e2", "s2", 3, op="join", targets=body_of("e1"), suppressed=True),
                                                  pattern({"linear": {"dir": "X", "count": 2, "spacing": 5}})),
        "DEPENDENCY_SUPPRESSED", _f("pt1"))
    add("sketch-suppressed-extrude", doc(sk("s1", [rect("o", 4, 4)], suppressed=True), ex("e1", "s1", 2)),
        "SKETCH_SUPPRESSED", _f("e1"))
    add("sketch-suppressed-revolve", doc(sk("s1", [rect("o", 4, 4, center=(5, 0))], suppressed=True), rv("r1", "s1")),
        "SKETCH_SUPPRESSED", _f("r1"))
    add("sketch-suppressed-hole-points", doc(*plate(), sk("s2", [{"kind": "point", "id": "q", "at": [0, 0]},
                                                                 circle("m", (5, 5), 0.5)],
                                                          plane=face(cap_q("e1")), suppressed=True),
                                             hole({"points": {"sketch": "s2", "ids": "all"}}, d=2, depth="through")),
        "SKETCH_SUPPRESSED", _f("h1"))
    add("region-not-found-inner-loop", doc(sk("s1", [rect("o", 10, 10), circle("h", (0, 0), 2)]),
                                           ex("e1", "s1", 2, regions=["h"])),
        "REGION_NOT_FOUND", _f("e1"))
    add("region-not-found-hole-around-an-island", doc(sk("s1", [rect("o", 10, 10), circle("h", (0, 0), 3),
                                                                circle("k", (0, 0), 1)]),
                                                      ex("e1", "s1", 2, regions=["k", "h"])),
        "REGION_NOT_FOUND", _f("e1"))
    add("region-not-found-revolve", doc(sk("s1", [rect("o", 4, 4, center=(5, 0)), circle("h", (5, 0), 1)]),
                                        rv("r1", "s1", regions=["h"])),
        "REGION_NOT_FOUND", _f("r1"))

    # -- sketches (§4.2, §4.5) -----------------------------------------------------------------------
    add("sketch-open-loop", doc(sk("s1", [line("a", (0, 0), (5, 0)), line("b", (5, 0), (5, 5))])), "SKETCH_OPEN_LOOP",
        _f("s1"))
    add("sketch-open-loop-arc", doc(sk("s1", [{"kind": "arc", "id": "a", "start": [5, 0], "end": [0, 5],
                                               "center": [0, 0], "ccw": True}])), "SKETCH_OPEN_LOOP", _f("s1"))
    add("sketch-open-loop-by-param", doc(sk("s1", [line("a", (0, 0), ("w", 0)), line("b", ("w", 0), ("w", 5)),
                                                   line("c", ("w", 5), (0, 5)), line("d", (0, 5), (0, 1))]),
                                         params=[P("w", "mm", 5)]),
        "SKETCH_OPEN_LOOP", _f("s1"))
    add("sketch-curves-cross", doc(sk("s1", [rect("a", 10, 10), rect("b", 10, 10, center=(5, 5))])),
        "SKETCH_CURVES_CROSS", _f("s1"))
    add("sketch-circles-cross", doc(sk("s1", [circle("a", (0, 0), 5), circle("b", (6, 0), 5)])), "SKETCH_CURVES_CROSS",
        _f("s1"))
    add("sketch-curves-cross-by-param", doc(sk("s1", [rect("a", 10, 10), circle("b", ("x", 0), 2)]),
                                            params=[P("x", "mm", 5)]),
        "SKETCH_CURVES_CROSS", _f("s1"))
    add("sketch-branching", doc(sk("s1", [line("a", (0, 0), (5, 0)), line("b", (5, 0), (5, 5)),
                                          line("c", (5, 5), (0, 0)), line("d", (5, 0), (9, 0))])),
        "SKETCH_BRANCHING", _f("s1"))
    add("sketch-branching-star", doc(sk("s1", [line("a", (0, 0), (5, 0)), line("b", (5, 0), (5, 5)),
                                               line("c", (5, 5), (0, 0)), line("d", (0, 0), (-3, 0)),
                                               line("e", (0, 0), (0, -3))])),
        "SKETCH_BRANCHING", _f("s1"))
    add("sketch-branching-by-param", doc(sk("s1", [line("a", (0, 0), ("w", 0)), line("b", ("w", 0), ("w", 5)),
                                                   line("c", ("w", 5), (0, 0)), line("d", ("w", 0), ("w", -3))]),
                                         params=[P("w", "mm", 5)]),
        "SKETCH_BRANCHING", _f("s1"))
    # [R-5]: a triangle (0,0), (2·tol,0), (tol, tol) of area exactly tol² (the inclusive bound)
    tri = [line("t1", (0, 0), (2e-6, 0)), line("t2", (2e-6, 0), (1e-6, 1e-6)), line("t3", (1e-6, 1e-6), (0, 0))]
    add("sketch-degenerate-loop", doc(sk("s1", tri)), "SKETCH_DEGENERATE_LOOP", _f("s1"))
    add("sketch-degenerate-loop-next-to-a-region", doc(sk("s1", [rect("o", 4, 4, center=(10, 0)), *tri])),
        "SKETCH_DEGENERATE_LOOP", _f("s1"))
    add("sketch-degenerate-loop-by-param", doc(sk("s1", [line("t1", (0, 0), ("2 * e", 0)), line("t2", ("2 * e", 0), ("e", "e")),
                                                         line("t3", ("e", "e"), (0, 0))]),
                                               params=[P("e", "mm", 1e-6)]),
        "SKETCH_DEGENERATE_LOOP", _f("s1"))
    # a sketch of points / construction curves is valid (hole placement); the body feature that
    # consumes it fails
    only_points = [{"kind": "point", "id": "p", "at": [0, 0]}]
    add("sketch-no-regions-points", doc(sk("s1", only_points), ex("e1", "s1", 2)), "SKETCH_NO_REGIONS", _f("e1"))
    add("sketch-no-regions-construction", doc(sk("s1", [rect("o", 4, 4, construction=True)]), ex("e1", "s1", 2)),
        "SKETCH_NO_REGIONS", _f("e1"))
    add("sketch-no-regions-construction-circle", doc(sk("s1", [circle("c", (5, 0), 3, construction=True),
                                                               {"kind": "point", "id": "p", "at": [1, 1]}]),
                                                     rv("r1", "s1")),
        "SKETCH_NO_REGIONS", _f("r1"))

    # -- parameters and expressions at the E stage (§2) ---------------------------------------------
    for i, (e, u) in enumerate([("sqrt(a - 5)", "ratio"), ("asin(a * 1.5)", "deg"), ("atan2(a - 1, a - 1)", "deg")]):
        add(f"expr-domain-param-{i}", doc(params=[P("a", "ratio", 1), P("b", u, e)]), "EXPR_DOMAIN", _p("b"))
    add("expr-domain-feature", doc(*plate(t="sqrt(a - 3) * 1 mm"), params=[P("a", "ratio", 2)]), "EXPR_DOMAIN",
        _f("e1"))
    for i, (v, u) in enumerate([("n / 2", "count"), ("n * 1.5", "count"), ("floor(n) + 0.25", "count")]):
        add(f"expr-not-integer-param-{i}", doc(params=[P("n", "count", 3), P("m", u, v)]), "EXPR_NOT_INTEGER", _p("m"))
    for i, (v, lo, hi) in enumerate([("w * 2", 0, 10), ("w - 10", 0, None), ("w", "w * 2", None)]):
        kw = {"min": lo} if hi is None else {"min": lo, "max": hi}
        add(f"param-out-of-range-{i}", doc(params=[P("w", "mm", 6), P("v", "mm", v, **kw)]), "PARAM_OUT_OF_RANGE",
            _p("v"))
    failed = [P("a", "mm", "sqrt(-1 mm * 1 mm)"), P("t", "mm", 4)]
    add("param-failed-feature", doc(*plate(t="a"), params=failed), "PARAM_FAILED", _f("e1"))
    add("param-failed-param", doc(params=[*failed, P("b", "mm", "a * 2")]), "PARAM_FAILED", _p("b"))
    add("param-failed-sketch", doc(sk("s1", [circle("c", (0, 0), "a")]), params=failed), "PARAM_FAILED", _f("s1"))

    # -- R/E codes at the E stage (through expressions) ---------------------------------------------
    t0 = [P("z", "mm", 0), P("k", "mm", 2)]
    add("invalid-distance-zero", doc(sk("s1", [rect("o", 4, 4)]), ex("e1", "s1", "z"), params=t0), "INVALID_DISTANCE",
        _f("e1"))
    add("invalid-distance-negative", doc(sk("s1", [rect("o", 4, 4)]), ex("e1", "s1", "z - k"), params=t0),
        "INVALID_DISTANCE", _f("e1"))
    add("invalid-distance-tiny", doc(sk("s1", [rect("o", 4, 4)]), ex("e1", "s1", "k * 1e-7"), params=t0),
        "INVALID_DISTANCE", _f("e1"))
    add("invalid-radius-zero", doc(*plate(), blend("fillet", "z", VERT), params=t0), "INVALID_RADIUS", _f("f1"))
    add("invalid-radius-negative", doc(*plate(), blend("fillet", "z - k", VERT), params=t0), "INVALID_RADIUS", _f("f1"))
    add("invalid-radius-tiny", doc(*plate(), blend("fillet", "k * 1e-7", TOP), params=t0), "INVALID_RADIUS", _f("f1"))
    add("invalid-value-hole-d", doc(*plate(), hole(one_at(), d="z", depth="through"), params=t0), "INVALID_VALUE",
        _f("h1"))
    add("invalid-value-shell", doc(*plate(), shell("z", cap_q("e1")), params=t0), "INVALID_VALUE", _f("sh1"))
    add("invalid-value-pattern-spacing", doc(*BOSS, pattern({"linear": {"dir": "X", "count": 2, "spacing": "z"}}),
                                             params=t0), "INVALID_VALUE", _f("pt1"))
    add("invalid-value-chamfer-d", doc(*plate(), blend("chamfer", "z", TOP), params=t0), "INVALID_VALUE", _f("c1"))
    ang = [P("a0", "deg", 0), P("a1", "deg", 95)]
    add("invalid-angle-revolve", doc(sk("s1", [rect("o", 4, 4, center=(5, 0))]), rv("r1", "s1", "a0"), params=ang),
        "INVALID_ANGLE", _f("r1"))
    add("invalid-angle-revolve-over", doc(sk("s1", [rect("o", 4, 4, center=(5, 0))]), rv("r1", "s1", "a1 * 4"),
                                          params=ang), "INVALID_ANGLE", _f("r1"))
    add("invalid-angle-circular", doc(*BOSS, pattern({"circular": {"axis": "Z", "count": 3, "angle": "a0"}}),
                                      params=ang), "INVALID_ANGLE", _f("pt1"))
    # §0.5 rule 2: an expression-valued angle fails with the literal check's code — `INVALID_VALUE`
    # for the chamfer's (0, 90) and the draft's (0, 45) (W7b review 4; `INVALID_ANGLE` is revolve's
    # and the circular pattern's)
    add("invalid-value-chamfer-angle", doc(*plate(), blend("chamfer", 1, TOP, angle="a1", side=top_face), params=ang),
        "INVALID_VALUE", _f("c1"))
    add("invalid-value-draft-angle", doc(*plate(), draft(SIDES, angle="a1 / 2"), params=ang), "INVALID_VALUE",
        _f("d1"))
    cnt = [P("n", "count", 3)]
    add("invalid-count-pattern", doc(*BOSS, pattern({"linear": {"dir": "X", "count": "n - 3", "spacing": 5}}), params=cnt),
        "INVALID_COUNT", _f("pt1"))
    add("invalid-count-circular", doc(*BOSS, pattern({"circular": {"axis": "Z", "count": "n - 2"}}), params=cnt),
        "INVALID_COUNT", _f("pt1"))
    add("invalid-count-hole-grid", doc(*plate(), hole({"grid": {"nx": "n - 3", "ny": 1, "dx": 2, "dy": 2}}, d=1,
                                                      depth="through"), params=cnt),
        "INVALID_COUNT", _f("h1"))
    zdir = [P("dz", "ratio", 0)]
    add("invalid-axis-pattern", doc(*BOSS, pattern({"circular": {"axis": {"line": {"origin": [0, 0, 0],
                                                                              "direction": [0, 0, "dz"]}},
                                                             "count": 3}}), params=zdir),
        "INVALID_AXIS", _f("pt1"))
    add("invalid-axis-datum-angle", doc(datum_plane("d1", "angle", **{"from": "XY", "axis": {"line": {
        "origin": [0, 0, 0], "direction": ["dz", 0, 0]}}, "angle": 30}), params=zdir), "INVALID_AXIS", _f("d1"))
    add("invalid-axis-pattern-flip", doc(*BOSS, pattern({"circular": {"axis": {"line": {"origin": [1, 0, 0],
                                                                                        "direction": ["dz", "dz", "dz"]},
                                                                               "flip": True}, "count": 3}}),
                                         params=zdir),
        "INVALID_AXIS", _f("pt1"))
    pl = [P("c", "ratio", 0.5), P("z0", "ratio", 0)]
    add("invalid-plane-not-perpendicular", doc(sk("s1", [rect("o", 4, 4)], plane={"origin": [0, 0, 0], "normal": [0, 0, 1],
                                                                                "x_dir": [1, 0, "c"]}), params=pl),
        "INVALID_PLANE", _f("s1"))
    add("invalid-plane-zero-normal", doc(sk("s1", [rect("o", 4, 4)], plane={"origin": [0, 0, 0], "normal": [0, 0, "z0"],
                                                                         "x_dir": [1, 0, 0]}), params=pl),
        "INVALID_PLANE", _f("s1"))
    add("invalid-plane-datum-frame", doc(datum_plane("d1", "frame", origin=[0, 0, 0], normal=[0, "c", 1],
                                                     x_dir=[0, 1, 0]), params=pl),
        "INVALID_PLANE", _f("d1"))
    add("degenerate-curve-circle", doc(sk("s1", [circle("c", (0, 0), "z")]), params=t0), "DEGENERATE_CURVE", _f("s1"))
    add("degenerate-curve-line", doc(sk("s1", [line("a", (0, 0), ("z", 0)), line("b", (0, 0), (4, 0))]), params=t0),
        "DEGENERATE_CURVE", _f("s1"))
    add("degenerate-curve-arc", doc(sk("s1", [{"kind": "arc", "id": "a", "start": ["z", 0], "end": [0, "z"],
                                               "center": [0, 0], "ccw": True}]), params=t0),
        "DEGENERATE_CURVE", _f("s1"))
    for i, (s, e) in enumerate([(("k", 0), (0, 3)), (("k", 0), (0, "k * 2")), (("k * 1.5", 0), (0, "k"))]):
        add(f"inconsistent-arc-{i}", doc(sk("s1", [{"kind": "arc", "id": "a", "start": list(s), "end": list(e),
                                                    "center": [0, 0], "ccw": True},
                                                   line("l", tuple(e), tuple(s))]), params=t0),
            "INCONSISTENT_ARC", _f("s1"))
    sq = [line("a", (0, 0), (5, 0)), line("b", (5, 0), (5, 5)), line("c", (5, 5), (0, 5)), line("d", (0, 5), (0, 0))]
    for i, v in enumerate(["z", "z - k", "k * 0"]):
        add(f"sketch-invalid-dimension-{i}", doc(sk("s1", sq, constraints=[
            {"type": "horizontal", "id": "h", "line": "a"},
            {"type": "distance", "id": "len", "a": "a.start", "b": "a.end", "value": v}]), params=t0),
            "SKETCH_INVALID_DIMENSION", _f("s1"))

    # -- threads (§6.13, §6.5 thread.modeled) ------------------------------------------------------
    def thr(q, fid="t1", **kw) -> dict:
        return {"type": "thread", "id": fid, "name": f"n_{fid}", "face": ref("face", q, card="one"), **kw}

    wall = {"op": "hole_face", "feature": "h1", "at": "a", "part": "wall"}
    boss = {"op": "side", "feature": "e1", "curve": "c"}

    def bore(d=6.8, t=10, at=(0.0, 0.0), extra=()) -> list:
        return [*plate(t=t), hole(one_at(*at), d=d, depth="through"), *extra]

    for i, kw in enumerate([{"major": 1, "pitch": 1}, {"major": 8, "pitch": 0.0005}, {"major": 2, "pitch": 1.5}]):
        add(f"thread-invalid-form-{i}", doc(*disk(r=4), thr(boss, **kw)), "THREAD_INVALID_VALUE", _f("t1"))
    add("thread-nut-in-a-small-bore", doc(*bore(d=5), thr(wall, standard="M8")), "THREAD_DIAMETER_MISMATCH", _f("t1"))
    add("thread-bolt-on-a-large-boss", doc(*disk(r=5), thr(boss, standard="M8")), "THREAD_DIAMETER_MISMATCH", _f("t1"))
    add("hole-thread-in-a-large-bore", doc(*plate(), hole(one_at(), d=10, depth="through",
                                                               thread={"standard": "1/2-20 UNF", "modeled": True})),
        "THREAD_DIAMETER_MISMATCH", _f("h1"))
    add("thread-on-a-cap", doc(*plate(), thr(cap_q("e1"), standard="M8")), "THREAD_FACE_UNSUPPORTED", _f("t1"))
    add("thread-on-a-plate-side", doc(*plate(), thr({"op": "side", "feature": "e1", "curve": "o.left"}, standard="M8")),
        "THREAD_FACE_UNSUPPORTED", _f("t1"))
    add("thread-on-a-drill-point", doc(*plate(), hole(one_at(), d=6.8, depth={"blind": 6}),
                                       thr({"op": "hole_face", "feature": "h1", "at": "a", "part": "tip"}, standard="M8")),
        "THREAD_FACE_UNSUPPORTED", _f("t1"))
    add("thread-longer-than-the-bore", doc(*bore(), thr(wall, standard="M8", length=12)), "THREAD_LENGTH_OUT_OF_RANGE", _f("t1"))
    add("thread-offset-past-the-bore", doc(*bore(), thr(wall, standard="M8", offset=3, length=8)),
        "THREAD_LENGTH_OUT_OF_RANGE", _f("t1"))
    add("thread-longer-than-the-boss", doc(*disk(r=4), thr(boss, standard="M8", length=20)), "THREAD_LENGTH_OUT_OF_RANGE", _f("t1"))
    add("thread-end-just-short-of-the-exit", doc(*bore(), thr(wall, standard="M8", length=9.9995)), "THREAD_END_TOO_CLOSE", _f("t1"))
    add("thread-start-just-inside-the-entry", doc(*bore(), thr(wall, standard="M8", offset=0.0005)), "THREAD_END_TOO_CLOSE", _f("t1"))
    add("bolt-thread-end-just-short", doc(*disk(r=4), thr(boss, standard="M8", length=9.9996)), "THREAD_END_TOO_CLOSE", _f("t1"))
    add("thread-floating-in-the-bore", doc(*bore(), thr(wall, standard="M8", offset=1, length=3)), "THREAD_END_UNSUPPORTED", _f("t1"))
    add("bolt-thread-floating-on-the-boss", doc(*disk(r=4), thr(boss, standard="M8", offset=2, length=2)),
        "THREAD_END_UNSUPPORTED", _f("t1"))
    add("thread-floating-mid-bore", doc(*bore(t=12), thr(wall, standard="M8", offset=4, length=4)),
        "THREAD_END_UNSUPPORTED", _f("t1"))
    add("thread-too-near-the-plate-edge", doc(*bore(at=(16.2, 0.0)), thr(wall, standard="M8")), "THREAD_INTERFERENCE", _f("t1"))
    add("thread-too-near-the-long-side", doc(*bore(at=(0.0, 11.2)), thr(wall, standard="M8")), "THREAD_INTERFERENCE", _f("t1"))
    add("thread-next-to-another-hole", doc(*bore(extra=(hole(one_at(7.2, 0.0), hid="h2", d=6.8, depth="through"),)),
                                           thr(wall, standard="M8")),
        "THREAD_INTERFERENCE", _f("t1"))
    add("hole-thread-too-near-the-plate-edge", doc(*plate(), hole(one_at(16.2, 0.0), size="M8", depth="through",
                                                                thread={"modeled": True})),
        "THREAD_INTERFERENCE", _f("h1"))
    return C


CASES: list[ErrCase] = _cases()


def e_codes() -> list[str]:
    """Every error code the catalogue gives an E stage (`E` or `R/E`)."""
    return sorted(k for k, v in consts.error_codes().items() if "E" in v["stage"].split("/"))


def expected_codes() -> list[str]:
    """The E codes the corpus covers: all but `NOT_COMPUTABLE`."""
    return [c for c in e_codes() if c not in NOT_COMPUTABLE]


def outcome(rep: dict, case: ErrCase) -> str | None:
    """The code the report gives the case's entry (None: it did not fail)."""
    kind, name = case.where
    if kind == "param":
        e = next((p for p in rep.get("params", []) if p.get("name") == name), None)
    else:
        e = next((f for f in rep.get("features", []) if f.get("feature_id") == name), None)
    return ((e or {}).get("error") or {}).get("code")


#: The manifest's file name (a `.stats.json` name: `oracle diff` skips it).
MANIFEST = "err1_expected.stats.json"


def file_name(i: int, case: ErrCase) -> str:
    return f"err1_{i:03d}_{case.name.replace('-', '_')}"


def write_corpus(out: Path, check: bool = True) -> dict:
    """Write every case as `<out>/<name>.json` with `meta.description` naming the expectation, plus
    `<out>/{MANIFEST}` (file, code, where); with `check`, evaluate each with the oracle and return
    the mismatches (the W7 acceptance: the oracle agrees with every one)."""
    from .evaluate import check_report, evaluate_data
    from .jsonio import dumps_canonical

    out.mkdir(parents=True, exist_ok=True)
    manifest, mismatches = [], []
    for i, c in enumerate(CASES):
        name = file_name(i, c)
        d = json.loads(json.dumps(c.doc))
        d["meta"] = {"name": name, "description": f"error corpus v1: {c.code} at {c.where[0]} {c.where[1]} ({c.name})"}
        (out / f"{name}.json").write_text(dumps_canonical(d) + "\n")
        manifest.append({"file": f"{name}.json", "code": c.code, c.where[0]: c.where[1]})
        if check:
            rep = evaluate_data(d, name)
            bad = check_report(rep)
            got = outcome(rep, c)
            if bad or got != c.code:
                mismatches.append({"file": f"{name}.json", "expected": c.code, "got": got, "schema": bad[:2]})
    (out / MANIFEST).write_text(json.dumps({"schema": "aicad.oracle-error-corpus/1", "cases": manifest,
                                                   "not_computable": NOT_COMPUTABLE,
                                                   "replay_ambiguous": REPLAY_AMBIGUOUS}, indent=1) + "\n")
    return {"cases": len(CASES), "mismatches": mismatches}


__all__ = ["CASES", "ErrCase", "MANIFEST", "NOT_COMPUTABLE", "REPLAY_AMBIGUOUS", "e_codes", "expected_codes", "outcome", "write_corpus"]
