"""`oracle gen --ir v1`: deterministic random generator of valid IR v1 programs.

Every program is produced from its own RNG seeded `aicad-gen-v1/<seed>/<index>/<attempt>` (so it is
independent of `--jobs`), written as canonical JSON (`jsonio.dumps_canonical`, expressions in
canonical form), loaded through the full v1 rejection pipeline and evaluated by the v1 oracle; a
program is kept only when it is accepted and every feature evaluates `ok` (else the attempt is
recorded under `failed/` and the index is retried).

Program groups (1–3 per program, on the v0 operation set plus body operations):

| Group | Exercises |
|---|---|
| `param_plate` | document/part parameters (mm, count, bool, ratio), derived parameters, bounds; `rect` (center or corner, expression corner radius); a grid of circle holes placed by expressions |
| `slot_bar` | `slot` with expression ends and width, symmetric extrude |
| `polygon_standoff` | `polygon` with every size field, count and angle parameters, a concentric bore |
| `revolve_ring` | explicit revolve profile from parameters, expression angle, every direction |
| `datum_stack` | `datum_plane` (offset / angle / frame) and a sketch on it |
| `face_boss` | a sketch on a planar face (`{ face: cap }`), extruded as `new_body` or `join` |
| `face_pocket` | a sketch on a face, extruded `cut` into its body (`targets` by reference or `"all"`) |
| `regions` | two regions, only one selected by a member id (`regions: [...]`) |
| `lifted_v0` | a v0 generator program, migrated (§9.1), with literals replaced by parameters and exact expressions (bit-identical values) |
| `extrude_intersect` | a block and a cylinder extruded `op: intersect` into it |
| `boolean_pair` | two overlapping new bodies (a block and a vertical or horizontal cylinder) combined by a `boolean` feature (`join` / `cut` / `intersect`, optional `keep_tools`) |
| `tagged_boss` | a `tag` on a face chosen by a geometric filter (`normal: +Z`), a sketch on the tag, a `join` boss |
| `axis_tilt` | a `datum_axis` (`points` / `planes` / `edge` mode) and a `datum_plane` rotated about it, with a sketch on it |
| `constrained_rect` | a **constrained** sketch (welded rectangle, horizontal/vertical, dimensions bound to parameters, a `fix`, a reference dimension) whose stored guess is the §4.4 rule 4 fixed point, so the oracle evaluates it standalone |
| `suppressed` | features suppressed by a bool parameter expression |
"""

from __future__ import annotations

import json
import random
import time
from pathlib import Path

from . import expr
from .jsonio import dumps_canonical

GROUPS = [
    ("param_plate", 4), ("slot_bar", 2), ("polygon_standoff", 2), ("revolve_ring", 3),
    ("datum_stack", 2), ("face_boss", 3), ("face_pocket", 2), ("regions", 1), ("lifted_v0", 3),
    ("extrude_intersect", 2), ("boolean_pair", 3), ("tagged_boss", 2), ("axis_tilt", 2), ("constrained_rect", 2),
]


def _c(text: str) -> str:
    """Canonical expression text (the DocStore stores the canonical form, §2.4)."""
    return expr.canonicalize(text)


def _r(rng: random.Random, a: float, b: float, nd: int = 3) -> float:
    return round(rng.uniform(a, b), nd)


class Builder:
    def __init__(self, rng: random.Random):
        self.rng = rng
        self.doc_params: list[dict] = []
        self.part_params: list[dict] = []
        self.features: list[dict] = []
        self.counter: dict[str, int] = {}
        self.names: set[str] = set()
        self.desc: list[str] = []

    def fid(self, prefix: str) -> str:
        self.counter[prefix] = self.counter.get(prefix, 0) + 1
        return f"{prefix}{self.counter[prefix]}"

    def pname(self, base: str) -> str:
        k = 1
        name = base
        while name in self.names:
            k += 1
            name = f"{base}_{k}"
        self.names.add(name)
        return name

    def param(self, base: str, unit: str, value, *, part: bool = False, mn=None, mx=None) -> str:
        name = self.pname(base)
        p = {"name": name, "unit": unit, "value": value}
        if mn is not None:
            p["min"] = mn
        if mx is not None:
            p["max"] = mx
        (self.part_params if part else self.doc_params).append(p)
        return name

    def feature(self, f: dict) -> dict:
        f["name"] = self.pname(f["name"])
        self.features.append(f)
        return f

    def plane(self) -> object:
        rng = self.rng
        x = rng.random()
        if x < 0.3:
            return "XY"
        if x < 0.45:
            return "XZ"
        if x < 0.6:
            return "YZ"
        # an explicit frame with expression components
        ox = self.param("ox", "mm", _r(rng, -30, 30))
        ang = self.param("tilt", "deg", float(rng.choice([0, 15, 30, 45, 60, 90, 120, 135])))
        return {"origin": [ox, 0.0, _r(rng, -10, 10)], "normal": [0.0, _c(f"-sin({ang})"), _c(f"cos({ang})")],
                "x_dir": [1.0, 0.0, 0.0]}

    # -- groups -------------------------------------------------------------------------------
    def param_plate(self, plane=None) -> tuple[str, str]:
        rng = self.rng
        w = self.param("width", "mm", _r(rng, 30, 120), mn=10.0)
        d = self.param("depth", "mm", _r(rng, 20, 90))
        t = self.param("thick", "mm", _r(rng, 2, 15), mn=0.5)
        corner = rng.random() < 0.3
        rect = {"kind": "rect", "id": "outline", "w": w, "h": d}
        if corner:
            rect["corner"] = [_c(f"-{w} / 2"), _c(f"-{d} / 2")]
        else:
            rect["center"] = [0.0, 0.0]
        if rng.random() < 0.6:
            rect["r"] = _c(f"min({w}, {d}) / {rng.choice([8, 10, 12, 16])}")
        curves = [rect]
        if rng.random() < 0.7:
            n = self.param("holes", "count", float(rng.choice([1, 2, 3, 4])))
            margin = self.param("margin", "mm", _c(f"min({w}, {d}) / 5"), part=True)
            hd = self.param("hole_d", "mm", _r(rng, 1.5, 4.0))
            ratio = self.param("spread", "ratio", _r(rng, 0.2, 0.8, 2))
            for k in range(int(self.rng.choice([1, 2]))):
                y = f"({d} / 2 - {margin}) * {'1' if k == 0 else '-1'}"
                curves.append({"kind": "circle", "id": f"h{k}", "center": [_c(f"({w} / 2 - {margin}) * {ratio}"), _c(y)],
                               "radius": _c(f"{hd} / 2")})
            curves.append({"kind": "circle", "id": "hc", "center": [0.0, 0.0],
                           "radius": _c(f"{hd} / 2 * max(1, {n} / 4)")})
        if rng.random() < 0.3:
            curves.append({"kind": "point", "id": "mark", "at": [0.0, 0.0]})
        if rng.random() < 0.3:
            curves.append({"kind": "line", "id": "guide", "start": [_c(f"-{w} / 2"), 0.0],
                           "end": [_c(f"{w} / 2"), 0.0], "construction": True})
        sid = self.fid("s")
        self.feature({"type": "sketch", "id": sid, "name": "plate_sk", "plane": plane or self.plane(), "curves": curves})
        eid = self.fid("e")
        e = {"type": "extrude", "id": eid, "name": "plate", "sketch": sid, "distance": t}
        dr = rng.choice(["normal", "normal", "reverse", "symmetric"])
        if dr != "normal":
            e["direction"] = dr
        self.feature(e)
        self.desc.append(f"param_plate({dr})")
        return eid, dr

    def slot_bar(self) -> None:
        rng = self.rng
        L = self.param("slot_len", "mm", _r(rng, 10, 60))
        sw = self.param("slot_w", "mm", _r(rng, 2, 12))
        ang = self.param("slot_ang", "deg", float(rng.choice([0, 30, 45, 60, 90, 17])))
        curves = [{"kind": "slot", "id": "bar", "a": [0.0, 0.0],
                   "b": [_c(f"{L} * cos({ang})"), _c(f"{L} * sin({ang})")], "w": sw}]
        sid = self.fid("s")
        self.feature({"type": "sketch", "id": sid, "name": "slot_sk", "plane": self.plane(), "curves": curves})
        self.feature({"type": "extrude", "id": self.fid("e"), "name": "slot_bar", "sketch": sid,
                      "distance": _c(f"{sw} * 2"), "direction": "symmetric"})
        self.desc.append("slot_bar")

    def polygon_standoff(self) -> None:
        rng = self.rng
        n = self.param("sides", "count", float(rng.choice([3, 4, 5, 6, 8, 12])))
        size = self.param("af", "mm", _r(rng, 4, 20))
        which = rng.choice(["circumradius", "inradius", "across_flats", "side"])
        poly = {"kind": "polygon", "id": "hex", "center": [0.0, 0.0], "n": n, which: size}
        if rng.random() < 0.5:
            poly["rotation"] = self.param("rot", "deg", float(rng.choice([0, 15, 30, 45, 7.5])))
        curves = [poly]
        if rng.random() < 0.6:
            # a bore well inside the inscribed circle
            curves.append({"kind": "circle", "id": "bore", "center": [0.0, 0.0], "radius": _c(f"{size} / 8")})
        sid = self.fid("s")
        self.feature({"type": "sketch", "id": sid, "name": "poly_sk", "plane": self.plane(), "curves": curves})
        self.feature({"type": "extrude", "id": self.fid("e"), "name": "standoff", "sketch": sid,
                      "distance": _c(f"{size} * 1.5")})
        self.desc.append(f"polygon({which})")

    def revolve_ring(self) -> None:
        rng = self.rng
        rin = self.param("r_in", "mm", _r(rng, 0.0, 20.0) if rng.random() < 0.7 else 0.0)
        wd = self.param("ring_w", "mm", _r(rng, 1.0, 15.0))
        ht = self.param("ring_h", "mm", _r(rng, 1.0, 20.0))
        full = rng.random() < 0.5
        ang = self.param("sweep", "deg", 360.0 if full else float(rng.choice([45, 90, 120, 180, 270, 33.3])))
        profile = {"kind": "rect", "id": "prof", "corner": [rin, _r(rng, -5, 5)], "w": wd, "h": ht}
        if rng.random() < 0.4:
            profile["r"] = _c(f"min({wd}, {ht}) / 4")
        sid = self.fid("s")
        self.feature({"type": "sketch", "id": sid, "name": "prof_sk", "plane": rng.choice(["XZ", "XY", "YZ"]),
                      "curves": [profile]})
        r = {"type": "revolve", "id": self.fid("r"), "name": "ring", "sketch": sid,
             "axis": {"origin": [0.0, 0.0], "direction": [0.0, 1.0]}, "angle": ang}
        dr = rng.choice(["normal", "reverse", "symmetric"])
        if dr != "normal":
            r["direction"] = dr
        self.feature(r)
        self.desc.append(f"revolve_ring({'full' if full else 'partial'}, {dr})")

    def datum_stack(self) -> None:
        rng = self.rng
        mode = rng.choice(["offset", "angle", "frame"])
        did = self.fid("d")
        if mode == "offset":
            off = self.param("lift", "mm", _r(rng, -30, 30))
            self.feature({"type": "datum_plane", "id": did, "name": "lifted", "mode": "offset",
                          "from": rng.choice(["XY", "XZ", "YZ"]), "distance": _c(f"{off} * 2")})
        elif mode == "angle":
            a = self.param("tilt_a", "deg", float(rng.choice([15, 30, 45, 60, 22.5])))
            self.feature({"type": "datum_plane", "id": did, "name": "tilted", "mode": "angle", "from": "XY",
                          "axis": rng.choice(["X", "Y"]), "angle": a})
        else:
            z = self.param("z0", "mm", _r(rng, -20, 20))
            self.feature({"type": "datum_plane", "id": did, "name": "framed", "mode": "frame",
                          "origin": [0.0, 0.0, z], "normal": [0.0, 0.0, 1.0], "x_dir": [0.0, 1.0, 0.0]})
        rd = self.param("puck_r", "mm", _r(rng, 2, 15))
        sid = self.fid("s")
        self.feature({"type": "sketch", "id": sid, "name": "puck_sk", "plane": {"datum": did},
                      "curves": [{"kind": "circle", "id": "puck", "center": [0.0, 0.0], "radius": rd}]})
        self.feature({"type": "extrude", "id": self.fid("e"), "name": "puck", "sketch": sid,
                      "distance": _c(f"{rd} / 2")})
        self.desc.append(f"datum_stack({mode})")

    def _on_cap(self, eid: str, dr: str) -> tuple[dict, str]:
        end = "end" if dr != "reverse" else "start"
        end = self.rng.choice([end, "end"]) if dr == "symmetric" else end
        return {"face": {"kind": "face", "q": {"op": "cap", "feature": eid, "end": end}}}, end

    def face_boss(self) -> None:
        rng = self.rng
        eid, dr = self.param_plate(plane=rng.choice(["XY", "XZ", "YZ"]))
        plane, _ = self._on_cap(eid, dr)
        br = self.param("boss_r", "mm", _r(rng, 1.0, 4.0))
        sid = self.fid("s")
        self.feature({"type": "sketch", "id": sid, "name": "boss_sk", "plane": plane,
                      "curves": [{"kind": "circle", "id": "ring", "center": [_r(rng, -2, 2), _r(rng, -2, 2)],
                                  "radius": br}]})
        e = {"type": "extrude", "id": self.fid("e"), "name": "boss", "sketch": sid, "distance": _c(f"{br} * 3")}
        if rng.random() < 0.6:
            e["op"] = "join"
            e["targets"] = {"kind": "body", "q": {"op": "body", "feature": eid}}
        self.feature(e)
        self.desc.append(f"face_boss({e.get('op', 'new_body')})")

    def face_pocket(self) -> None:
        rng = self.rng
        eid, dr = self.param_plate(plane=rng.choice(["XY", "XZ", "YZ"]))
        plane, _ = self._on_cap(eid, dr)
        pw = self.param("pocket_w", "mm", _r(rng, 1.0, 5.0))
        sid = self.fid("s")
        self.feature({"type": "sketch", "id": sid, "name": "pocket_sk", "plane": plane,
                      "curves": [{"kind": "rect", "id": "pocket", "center": [_r(rng, -1, 1), _r(rng, -1, 1)],
                                  "w": pw, "h": _c(f"{pw} * 0.75")}]})
        through = rng.random() < 0.3
        e = {"type": "extrude", "id": self.fid("e"), "name": "pocket", "sketch": sid,
             "distance": 1000.0 if through else _c("0.25 mm"), "direction": "reverse", "op": "cut",
             "targets": "all" if rng.random() < 0.4 else {"kind": "body", "q": {"op": "body", "feature": eid}}}
        self.feature(e)
        self.desc.append(f"face_pocket({'through' if through else 'blind'})")

    def regions(self) -> None:
        rng = self.rng
        a = self.param("pad", "mm", _r(rng, 3, 10))
        curves = [{"kind": "rect", "id": "left", "center": [_c(f"-2 * {a}"), 0.0], "w": a, "h": a},
                  {"kind": "circle", "id": "right", "center": [_c(f"2 * {a}"), 0.0], "radius": _c(f"{a} / 2")}]
        sid = self.fid("s")
        self.feature({"type": "sketch", "id": sid, "name": "two_sk", "plane": "XY", "curves": curves})
        pick = rng.choice(["left.top", "right"])
        self.feature({"type": "extrude", "id": self.fid("e"), "name": "one_pad", "sketch": sid,
                      "regions": [pick], "distance": a})
        self.desc.append(f"regions({pick})")

    def lifted_v0(self) -> None:
        from ..generator import generate_program
        from .migrate import migrate_v0_to_v1

        v0 = generate_program(random.Random(self.rng.random()), "lift")
        v1, _ = migrate_v0_to_v1(json.loads(json.dumps(v0)))
        feats = v1["parts"][0]["features"]
        remap = {}
        for f in feats:
            old = f["id"]
            f["id"] = self.fid("l")
            remap[old] = f["id"]
            f["name"] = self.pname(f["name"])
        for f in feats:
            if f["type"] in ("extrude", "revolve"):
                f["sketch"] = remap[f["sketch"]]
        parametrize(feats, self, self.rng)
        self.features.extend(feats)
        self.desc.append("lifted_v0")

    # -- body operations, tags, axes, constrained sketches ---------------------------------------
    def _block(self, name: str) -> tuple[str, str, str, str, str]:
        """A w × d × t block centred on the origin of XY: (extrude id, rect id, w, d, t) names."""
        rng = self.rng
        w = self.param(f"{name}_w", "mm", _r(rng, 20, 80))
        d = self.param(f"{name}_d", "mm", _r(rng, 20, 80))
        t = self.param(f"{name}_t", "mm", _r(rng, 3, 15))
        rid = f"{name}_r"
        sid = self.fid("s")
        self.feature({"type": "sketch", "id": sid, "name": f"{name}_sk", "plane": "XY",
                      "curves": [{"kind": "rect", "id": rid, "center": [0.0, 0.0], "w": w, "h": d}]})
        eid = self.fid("e")
        self.feature({"type": "extrude", "id": eid, "name": name, "sketch": sid, "distance": t})
        return eid, rid, w, d, t

    @staticmethod
    def _body(eid: str) -> dict:
        return {"kind": "body", "q": {"op": "body", "feature": eid}}

    def extrude_intersect(self) -> None:
        rng = self.rng
        eid, _, w, d, t = self._block("core")
        k = self.param("core_frac", "ratio", _r(rng, 0.15, 0.45, 2))
        sid = self.fid("s")
        self.feature({"type": "sketch", "id": sid, "name": "core_tool_sk", "plane": "XY",
                      "curves": [{"kind": "circle", "id": "tool", "center": [0.0, 0.0],
                                  "radius": _c(f"min({w}, {d}) * {k}")}]})
        self.feature({"type": "extrude", "id": self.fid("e"), "name": "core_cut", "sketch": sid,
                      "distance": _c(f"2 * {t} + 2"), "direction": "symmetric", "op": "intersect",
                      "targets": self._body(eid)})
        self.desc.append("extrude_intersect")

    def boolean_pair(self, op: str | None = None) -> None:
        rng = self.rng
        eid, _, w, d, t = self._block("pair")
        horizontal = rng.random() < 0.4
        sid = self.fid("s")
        if horizontal:
            # a cylinder along Y through the block's mid-height (XZ sketch: u = X, v = Z)
            r = self.param("pin_r", "mm", _c(f"{t} * {_r(rng, 0.15, 0.4, 2)}"))
            curve = {"kind": "circle", "id": "pin", "center": [_r(rng, -5, 5), _c(f"{t} / 2")], "radius": r}
            plane, length = "XZ", _c(f"{d} + 10")
        else:
            r = self.param("pin_r", "mm", _c(f"min({w}, {d}) * {_r(rng, 0.08, 0.2, 2)}"))
            curve = {"kind": "circle", "id": "pin", "center": [_r(rng, -5, 5), _r(rng, -5, 5)], "radius": r}
            plane, length = "XY", _c(f"2 * {t} + 6")
        self.feature({"type": "sketch", "id": sid, "name": "pin_sk", "plane": plane, "curves": [curve]})
        tid = self.fid("e")
        self.feature({"type": "extrude", "id": tid, "name": "pin", "sketch": sid, "distance": length,
                      "direction": "symmetric"})
        op = op or rng.choice(["join", "cut", "intersect"])
        b = {"type": "boolean", "id": self.fid("b"), "name": f"pair_{op}", "op": op,
             "targets": self._body(eid), "tools": self._body(tid)}
        if op != "intersect" and rng.random() < 0.3:
            b["keep_tools"] = True
        self.feature(b)
        self.desc.append(f"boolean_pair({op}{', horizontal' if horizontal else ''}{', keep' if 'keep_tools' in b else ''})")

    def tagged_boss(self) -> None:
        rng = self.rng
        eid, _, w, d, t = self._block("deck")
        tid = self.fid("t")
        self.feature({"type": "tag", "id": tid, "name": "deck_top",
                      "target": {"kind": "face", "card": "one",
                                 "q": {"op": "filter", "where": {"normal": "+Z"},
                                       "of": {"op": "faces", "of": {"op": "body", "feature": eid}}}}})
        r = self.param("stud_r", "mm", _r(rng, 1.0, 5.0))
        sid = self.fid("s")
        self.feature({"type": "sketch", "id": sid, "name": "stud_sk",
                      "plane": {"face": {"kind": "face", "q": {"op": "tagged", "feature": tid}}},
                      "curves": [{"kind": "circle", "id": "stud", "center": [_r(rng, -3, 3), _r(rng, -3, 3)],
                                  "radius": r}]})
        self.feature({"type": "extrude", "id": self.fid("e"), "name": "stud", "sketch": sid,
                      "distance": _c(f"{r} * 2"), "op": "join", "targets": self._body(eid)})
        self.desc.append("tagged_boss")

    def axis_tilt(self, mode: str | None = None) -> None:
        rng = self.rng
        mode = mode or rng.choice(["points", "planes", "edge"])
        aid = self.fid("a")
        base = "XY"
        if mode == "edge":
            # `edge_at` is the vertical corner edge swept from the curve's end: parallel to XZ
            base = rng.choice(["XZ", "YZ"])
            eid, rid, *_ = self._block("hinge")
            self.feature({"type": "datum_axis", "id": aid, "name": "hinge_axis", "mode": "edge",
                          "edge": {"kind": "edge", "q": {"op": "edge_at", "feature": eid, "curve": f"{rid}.bottom",
                                                         "end": "end"}}})
        elif mode == "planes":
            self.feature({"type": "datum_axis", "id": aid, "name": "hinge_axis", "mode": "planes",
                          "a": "XZ", "b": "XY"})
        else:
            y = self.param("hinge_y", "mm", _r(rng, -20, 20))
            self.feature({"type": "datum_axis", "id": aid, "name": "hinge_axis", "mode": "points",
                          "points": [[0.0, y, 0.0], [_r(rng, 1, 10), y, 0.0]]})
        ang = self.param("hinge_ang", "deg", float(rng.choice([15, 30, 45, 60, 75, 20.5])))
        did = self.fid("d")
        self.feature({"type": "datum_plane", "id": did, "name": "hinged", "mode": "angle", "from": base,
                      "axis": {"datum": aid}, "angle": ang})
        r = self.param("flap_r", "mm", _r(rng, 2, 8))
        sid = self.fid("s")
        self.feature({"type": "sketch", "id": sid, "name": "flap_sk", "plane": {"datum": did},
                      "curves": [{"kind": "rect", "id": "flap", "center": [0.0, _c(f"3 * {r}")],
                                  "w": _c(f"2 * {r}"), "h": r}]})
        self.feature({"type": "extrude", "id": self.fid("e"), "name": "flap", "sketch": sid, "distance": 2.0})
        self.desc.append(f"axis_tilt({mode})")

    def constrained_rect(self) -> None:
        """A welded rectangle whose stored geometry satisfies every constraint exactly (w/2 and h/2
        are exact halves, so every measured distance equals its parameter bit for bit)."""
        rng = self.rng
        wv, hv = _r(rng, 10, 60), _r(rng, 10, 60)
        w = self.param("cw", "mm", wv)
        h = self.param("ch", "mm", hv)
        x, y = wv / 2.0, hv / 2.0
        curves = [{"kind": "line", "id": "bottom", "start": [-x, -y], "end": [x, -y]},
                  {"kind": "line", "id": "right", "start": [x, -y], "end": [x, y]},
                  {"kind": "line", "id": "top", "start": [x, y], "end": [-x, y]},
                  {"kind": "line", "id": "left", "start": [-x, y], "end": [-x, -y]}]
        cons = [{"type": "horizontal", "id": "hb", "line": "bottom"},
                {"type": "horizontal", "id": "ht", "line": "top"},
                {"type": "vertical", "id": "vl", "line": "left"},
                {"type": "vertical", "id": "vr", "line": "right"},
                {"type": "distance", "id": "dw", "a": "bottom.start", "b": "bottom.end", "value": w},
                {"type": "distance", "id": "dh", "a": "right.start", "b": "right.end", "value": h},
                {"type": "fix", "id": "pin", "entity": "bottom.start"}]
        if rng.random() < 0.5:
            curves.append({"kind": "line", "id": "diag", "start": [-x, -y], "end": [x, y], "construction": True})
            cons.append({"type": "distance", "id": "dd", "a": "diag.start", "b": "diag.end", "driving": False})
        if rng.random() < 0.5:
            curves.append({"kind": "circle", "id": "bore", "center": [0.0, 0.0], "radius": round(min(x, y) / 2, 3)})
            cons.append({"type": "radius", "id": "rb", "curve": "bore", "value": round(min(x, y) / 2, 3)})
        sid = self.fid("s")
        self.feature({"type": "sketch", "id": sid, "name": "crect_sk", "plane": rng.choice(["XY", "XZ", "YZ"]),
                      "curves": curves, "constraints": cons})
        self.feature({"type": "extrude", "id": self.fid("e"), "name": "crect", "sketch": sid,
                      "distance": _r(rng, 2, 10), "regions": ["bottom"]})
        self.desc.append("constrained_rect")

    def build(self, name: str) -> dict:
        rng = self.rng
        k = rng.choice([1, 1, 2, 2, 3])
        table = [(g, w) for g, w in GROUPS]
        for _ in range(k):
            total = sum(w for _, w in table)
            x = rng.uniform(0, total)
            for g, w in table:
                x -= w
                if x <= 0:
                    break
            getattr(self, g)()
        if rng.random() < 0.15 and self.features:
            flag = self.param("with_extra", "bool", rng.random() < 0.5)
            sid = self.fid("s")
            self.feature({"type": "sketch", "id": sid, "name": "extra_sk", "plane": "XY",
                          "curves": [{"kind": "circle", "id": "c", "center": [200.0, 0.0], "radius": 3.0}]})
            self.feature({"type": "extrude", "id": self.fid("e"), "name": "extra", "sketch": sid, "distance": 2.0,
                          "suppressed": _c(f"!{flag}")})
            self.desc.append("suppressed")
        part = {"id": "p1", "name": "part_1", "features": self.features}
        if self.part_params:
            part["params"] = self.part_params
        doc = {"schema": "aicad.ir/1", "meta": {"name": name, "description": "; ".join(self.desc)}}
        if self.doc_params:
            doc["params"] = self.doc_params
        doc["parts"] = [part]
        return doc


def parametrize(features: list[dict], b: Builder, rng: random.Random) -> None:
    """Replace literals by parameters and exact expressions whose values are bit-identical."""
    for f in features:
        if f["type"] == "extrude" and rng.random() < 0.8:
            d = float(f["distance"])
            if rng.random() < 0.5:
                f["distance"] = b.param("dist", "mm", d)
            else:
                half = b.param("half", "mm", d / 2.0)  # exact: division by 2 (no underflow here)
                f["distance"] = _c(f"2 * {half}")
        elif f["type"] == "revolve" and rng.random() < 0.8:
            f["angle"] = b.param("angle", "deg", float(f["angle"]))
        elif f["type"] == "sketch":
            for c in f["curves"]:
                if c["kind"] == "circle" and rng.random() < 0.5:
                    c["radius"] = b.param("rad", "mm", float(c["radius"]))
                elif c["kind"] == "line" and rng.random() < 0.2:
                    s = b.param("sx", "mm", float(c["start"][0]))
                    c["start"] = [s, c["start"][1]]


def generate_program_v1(rng: random.Random, name: str, family: str = "classic") -> dict:
    return generate_with_checks(rng, name, family)[0]


def generate_with_checks(rng: random.Random, name: str, family: str = "classic") -> tuple[dict, list]:
    """(document, self-checks). `classic` is the W7a generator (no self-checks); the W7b families
    (`genops.FAMILIES`) add body operations, holes, patterns and blends with closed-form checks."""
    if family == "classic":
        return Builder(rng).build(name), []
    from .genops import build

    return build(Builder(rng), family, name)


def program_name(seed: int, index: int, family: str = "classic") -> str:
    """`gen1_s<seed>_<index>` (classic) or `gen1<f>_s<seed>_<index>` (`f` the family's initial, `x` for
    `ops`)."""
    tag = "" if family == "classic" else ("x" if family == "ops" else family[0])
    return f"gen1{tag}_s{seed}_{index:05d}"


def ambiguous_probes(text: str, name: str, rep: dict) -> list[dict]:
    """The references of the oracle's own report whose probes do not replay (§8.1 [W0-35]): the
    report replayed through itself, each `ORACLE_PROBE_UNMATCHED` as `{feature, reason}`. Two
    coplanar overlapping caps of separate bodies (two plates sketched on one plane) put a
    sketch-on-face probe on 2 OCCT faces with agreeing normals, which §8.1 does not match — the
    3 ROBUSTNESS programs of W7b's first ledger. Until the Contract stage rules on a key
    tie-break (`replay.PENDING_DEVIATIONS["key-tie-break"]`; W7b report, CONTRACT ISSUES 2) the
    classic family does not emit such programs: a flagged attempt is rejected, the next attempt is
    generated. The exclusion stays visible: the count is in the stats (`rejected`), printed by
    `oracle gen`, and `oracle diff` over the generated directory reports it next to the class
    counts (`generator_rejected`), since these configurations would otherwise be ROBUSTNESS rows
    the MATCH rate does not show."""
    from .evaluate import evaluate_text

    if not any(m.get("probe", {}).get("kind") in ("face", "body")
               for f in rep["features"] for r in f.get("refs", []) for m in r.get("members", [])):
        return []
    again = evaluate_text(text, name, replay=rep)
    return [{"feature": f["feature_id"], "reason": w.get("details", {}).get("reason", w.get("message", ""))}
            for f in again["features"] for w in f["warnings"] if w["code"] == "ORACLE_PROBE_UNMATCHED"]


def gen_one(task: tuple) -> dict:
    from . import normalize
    from .evaluate import check_report, evaluate_text
    from .genops import _Retry
    from .load import Rejected, load_text

    seed, index, max_attempts = task[:3]
    family = task[3] if len(task) > 3 else "classic"
    name = program_name(seed, index, family)
    failures = []
    rejected = []
    for attempt in range(max_attempts):
        rng = random.Random(f"aicad-gen-v1/{seed}/{index}/{attempt}" if family == "classic"
                            else f"aicad-gen-v1/{family}/{seed}/{index}/{attempt}")
        try:
            doc, checks = generate_with_checks(rng, name, family)
        except _Retry:
            continue
        text = dumps_canonical(doc) + "\n"
        try:
            loaded = load_text(text)
        except Rejected as r:
            failures.append({"attempt": attempt, "kind": "invalid_ir", "code": r.code, "message": r.message, "text": text})
            continue
        t0 = time.perf_counter()
        merges0 = dict(normalize.merge_stats)
        rep = evaluate_text(text, name)
        merges = {k: normalize.merge_stats[k] - merges0.get(k, 0) for k in normalize.merge_stats}
        dt = time.perf_counter() - t0
        bad = check_report(rep)
        if bad:
            failures.append({"attempt": attempt, "kind": "bad_report", "code": "REPORT_SCHEMA",
                             "message": "; ".join(bad[:3]), "text": text})
            continue
        # a feature a group expects to fail (`Check.code`: the SPEC's error for a configuration,
        # e.g. a line contact) may fail with that code, and one with a known OCCT limitation
        # (`Check.engine_limits`) with its engine-internal code — kept and listed as `occt_limited`;
        # any other failure is the oracle's
        expected = {c.fid for c in checks if getattr(c, "code", None)}
        occt_limited = [{"feature": c.fid, "code": c.occt_limited(rep)} for c in checks
                        if getattr(c, "engine_limits", None) and c.occt_limited(rep)]
        tolerated = expected | {x["feature"] for x in occt_limited}
        errs = [f["error"] for f in rep["features"] if f.get("error") and f["feature_id"] not in tolerated] + \
               [p["error"] for p in rep["params"] if p.get("error")]
        if rep["status"] != "ok" and (errs or not tolerated):
            e = errs[0] if errs else {"code": "?", "message": ""}
            failures.append({"attempt": attempt, "kind": "oracle_error", "code": e["code"],
                             "message": e["message"], "text": text})
            continue
        bad = [m for m in (c.verify(rep) for c in checks) if m]
        if bad:
            # the oracle disagrees with a closed form: an oracle bug to investigate, never kept
            failures.append({"attempt": attempt, "kind": "self_check", "code": "ORACLE_SELF_CHECK",
                             "message": "; ".join(bad), "text": text})
            continue
        if family == "classic":
            amb = ambiguous_probes(text, name, rep)
            if amb:
                rejected.append({"attempt": attempt, "kind": "ambiguous_probe", "features": amb})
                continue
        return {"index": index, "name": name, "text": text, "report": rep, "failures": failures, "seconds": dt,
                "doc": loaded.doc, "merges": merges, "rejected": rejected, "occt_limited": occt_limited}
    return {"index": index, "name": name, "text": None, "report": None, "failures": failures, "seconds": 0.0,
            "merges": {}, "rejected": rejected, "occt_limited": []}


def cmd_gen_v1(args) -> int:
    from concurrent.futures import ProcessPoolExecutor

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    family = getattr(args, "family", "classic") or "classic"
    tasks = [(args.seed, i, args.max_attempts, family) for i in range(args.count)]
    t0 = time.perf_counter()
    jobs = max(1, args.jobs)
    if jobs == 1:
        results = [gen_one(t) for t in tasks]
    else:
        with ProcessPoolExecutor(max_workers=jobs) as ex:
            results = list(ex.map(gen_one, tasks, chunksize=2))
    elapsed = time.perf_counter() - t0
    features: dict[str, int] = {}
    failure_list = []
    gave_up = []
    generated = 0
    merges = {"a": 0, "b": 0, "b_near_tangent": 0}
    rejected = []
    occt_limited = []
    for r in sorted(results, key=lambda r: r["index"]):
        for k, v in r.get("merges", {}).items():
            merges[k] = merges.get(k, 0) + v
        rejected += [{"program": r["name"], **x} for x in r.get("rejected", [])]
        occt_limited += [{"program": r["name"], **x} for x in r.get("occt_limited", [])]
        for f in r["failures"]:
            fname = f"{r['name']}_a{f['attempt']}.json"
            (out / "failed").mkdir(exist_ok=True)
            (out / "failed" / fname).write_text(f["text"])
            failure_list.append({"file": f"failed/{fname}", "kind": f["kind"], "code": f["code"],
                                 "message": f["message"][:500]})
        if r["text"] is None:
            gave_up.append(r["name"])
            continue
        generated += 1
        (out / f"{r['name']}.json").write_text(r["text"])
        if args.with_reports:
            (out / f"{r['name']}.metrics.json").write_text(
                json.dumps(r["report"], indent=2, ensure_ascii=False, allow_nan=False) + "\n")
        for fr in r["report"]["features"]:
            features[fr["type"]] = features.get(fr["type"], 0) + 1
    stats = {"seed": args.seed, "ir": "v1", "requested": args.count, "generated": generated, "gave_up": gave_up,
             "failures": len(failure_list), "features": dict(sorted(features.items())),
             "seconds": round(elapsed, 2), "failure_details": failure_list}
    stats["family"] = family
    stats["self_check_failures"] = sum(1 for f in failure_list if f["kind"] == "self_check")
    # SPEC-v1 §8.3 rule 1.3: the oracle's edge merges in the kept programs' evaluations — (a) same
    # carrier, (b) the tangency rule, and (b) at nearly tangent vertices (the known residue W7b
    # reports; `normalize.NEAR_TANGENT`)
    stats["normalize_merges"] = merges
    # attempts the generator itself discarded (not oracle failures): programs whose own reference
    # probes do not replay (`ambiguous_probes`)
    stats["rejected"] = rejected
    # kept programs where the oracle hit a known OCCT limitation on a configuration the SPEC defines
    # (`Check.engine_limits`, an engine-internal code): the diff lists Forge's result there as
    # ROBUSTNESS (W7b review 5)
    stats["occt_limited"] = occt_limited
    (out / f"{program_name(args.seed, 0, family).rsplit('_', 1)[0]}.stats.json").write_text(
        json.dumps(stats, indent=2) + "\n")
    print(f"generated {generated}/{args.count} IR v1 programs in {elapsed:.1f}s ({jobs} jobs) -> {out}")
    print(f"oracle failures {len(failure_list)} ({stats['self_check_failures']} self-check); "
          f"features {stats['features']}")
    print(f"§8.3 rule 1.3 edge merges: (a) {merges['a']}, (b) {merges['b']}, of which at nearly tangent "
          f"vertices {merges['b_near_tangent']}; attempts rejected for ambiguous probes: {len(rejected)}")
    if occt_limited:
        print(f"kept programs with a known OCCT limitation (engine-internal; diffed as ROBUSTNESS): {len(occt_limited)} "
              f"({', '.join(sorted({x['code'] for x in occt_limited}))})")
    for f in failure_list[:20]:
        print(f"  {f['file']}: {f['kind']} {f['code']}: {f['message'][:200]}")
    inv_ok = True
    if getattr(args, "invalid_per_kind", 4) > 0:
        # the v1 error corpus (fixed documents, independent of the seed): `<out>/invalid` or
        # `--invalid-out`, with its manifest (`errcorpus.MANIFEST`); `oracle diff <dir> --forge-bin …`
        # runs Forge against it
        from .errcorpus import write_corpus

        inv_dir = Path(args.invalid_out) if getattr(args, "invalid_out", None) else out / "invalid"
        res = write_corpus(inv_dir)
        inv_ok = not res["mismatches"]
        print(f"error corpus v1: {res['cases']} programs -> {inv_dir}; "
              f"oracle vs expectation mismatches: {len(res['mismatches'])}")
        for m in res["mismatches"][:20]:
            print(f"  {m['file']}: expected {m['expected']}, got {m['got']} {m['schema'] or ''}")
    # a closed-form self-check the oracle failed is an oracle bug (W7b review 4): the attempt was
    # retried, so the corpus is complete, but the command fails so that CI and nightly jobs see it
    # (`--allow-self-check-failures` to only report them)
    sc_ok = stats["self_check_failures"] == 0 or getattr(args, "allow_self_check_failures", False)
    if not sc_ok:
        print(f"oracle gen: {stats['self_check_failures']} closed-form self-check failure(s) (see failed/): exit 1")
    return 0 if not gave_up and inv_ok and sc_ok else 1
