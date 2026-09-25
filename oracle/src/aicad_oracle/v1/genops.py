"""`oracle gen --ir v1 --family …`: generated F1/F2 programs — body operations, holes, patterns and
blends — each with **analytic self-checks** (W7b).

Families (`--family`; the default `classic` is the W7a generator with its RNG streams and names
unchanged — an index can still land on another attempt where the oracle's verdict on a draw changed):

| Family | Groups |
|---|---|
| `booleans` | `flush_join` (coplanar faces merged, §6.0.4), `through_cut` (rect / circle / slot through a plate), `split_bar` (a slot across a bar: `BOOLEAN_SPLIT`), `consumed` (a tool covering a target: `BOOLEAN_BODY_CONSUMED`), `coaxial_corner_boss` (a boss on one cylinder with a rounded corner: coincident cylinders merged), `edge_notch` (a notch whose faces and edges coincide with the plate's), `bridge_join` (two targets merged: `removed`), `tangent_cylinders` (internal and external tangency, cut and join: holes enlarged or filled by tangent cylinders, a boss tangent to a side; line contacts that must fail with `BOOLEAN_NO_INTERSECTION` or `BOOLEAN_NON_MANIFOLD`), `boolean_feature` (the `boolean` feature: `join` / `cut` / `intersect`, one or two targets, up to three tools, `keep_tools`), `oblique_sections` (§8.3 rule 3 in generated programs: an oblique plane through a cylinder, crossing cylinders of equal radius, and [W0-51]'s plane–cone cases — ellipse, generator lines, parabola — with their edge types) |
| `holes` | plates with holes of every kind (simple, sized by fit, blind with 118°/90°/flat tips, counterbore and countersink presets and custom, inserts, threads) and every placement (`list`, `grid`, `circle`, sketch `points`) |
| `patterns` | linear (up to 12 × 12) and circular (up to 36) patterns of boss, pocket and hole seeds, mirrors, body seeds, `skip`, instances running off the part (`PATTERN_INSTANCE_SKIPPED`) |
| `blends` | vertical-edge fillets, top-edge chamfers (symmetric and two-distance), shells inward and outward, `shell_notched` (a notched, non-convex box shelled open on its notched top, its bottom or closed; W7b review 5), fillet then shell, chamfer chains on rounded rectangles, top-edge fillets; at their limits (W7b review 3): `blend_limits` (vertical fillets, top chamfers, open and closed shells in both directions, just above — the `*_TOO_LARGE` code and its closed-form `max_feasible_*` — or just below — the closed-form volume), `cap_blends` (a cylinder rim's torus fillet / cone chamfer), `concave_fillet` (an L prism's 270° edge), `hole_edge_blend` (a hole narrowing the face across the edge) |
| `ops` | all of the above |

**Self-checks.** Every group states the closed-form outcome of its feature where one exists (the
volume of the feature's bodies, their count, the warning codes, the pattern's `skipped` list, the
section edge types of §8.3 rule 3, which bodies a `boolean` keeps), or the SPEC's error code for a
configuration that must fail, from the SPEC's formulas — never from the oracle's own construction
code. `gen_one` keeps a program only when the oracle's report satisfies them; a violation is
recorded as a `self_check` failure (an oracle bug to investigate, printed by `oracle gen`), and the
index is retried. The one exception is a **known OCCT limitation** a check names
(`Check.engine_limits`): the oracle's engine-internal failure there is recorded as
`occt_limited` and the program is kept, so that the diff lists Forge's result against it.

**Pattern seeds** (§6.10, a Contract-stage issue of the W7b review): a pattern copies a hole
seed's tools *as evaluated at the seed*, so a `through` tool keeps the length the engine chose
(the SPEC leaves it unspecified) and an `up_to` tool its seed depth. After a rotation about an axis
that is not the hole's own direction, or on a target that is not a prism along it, a copied
`through` hole need not go through (and engines choosing different lengths differ). The F1/F2
families therefore use `through` / `up_to` hole seeds only in translations and in rotations about
an axis parallel to the hole axis on a prism along it (`circular_holes`: a Z-axis bolt circle of
through holes drilled along −Z in a Z-extruded plate, where every copy's extent is the seed's).
"""

from __future__ import annotations

import math
import random

from . import consts

PI = math.pi
FAMILIES = ("booleans", "holes", "patterns", "blends", "ops")


def _r(rng: random.Random, a: float, b: float, nd: int = 3) -> float:
    return round(rng.uniform(a, b), nd)


class Check:
    """A closed-form expectation on one feature entry of the oracle's report: its volume (summed
    over the feature's bodies), body count, compared warning codes, pattern `skipped`, the counts of
    the listed `edge_types` (summed over its bodies; §8.3 rule 3 in generated programs), the
    feature ids whose bodies must (`kept`) or must not (`gone`) be in the part at the end
    (`keep_tools`), or — `code` — the SPEC's error for a configuration that must fail."""

    def __init__(self, fid: str, volume: float | None = None, bodies: int | None = None,
                 warnings: set[str] | None = None, skipped: list | None = None, rel: float = 1e-7,
                 code: str | None = None, edge_types: dict | None = None, kept: list | None = None,
                 gone: list | None = None, details: dict | None = None, face_types: dict | None = None,
                 engine_limits: set[str] | None = None):
        self.fid, self.volume, self.bodies, self.warnings, self.skipped, self.rel = fid, volume, bodies, warnings, skipped, rel
        self.code, self.edge_types, self.kept, self.gone = code, edge_types, kept, gone
        #: with `code`: error details that must be equal (e.g. the closed-form `max_feasible_*`)
        self.details = details
        #: the counts of the listed `face_types`, summed over the feature's bodies
        self.face_types = face_types
        #: engine-internal codes (`OCCT_*`) of a **known OCCT limitation** on a configuration the
        #: SPEC defines (the closed form above is the SPEC's outcome): the oracle may fail the
        #: feature with one of them, and the program is kept all the same — `gen_one` records it as
        #: `occt_limited`, not as a self-check failure — so the F1/F2 diff lists Forge's result
        #: against it as `ROBUSTNESS` (engine-internal), where dropping the draw would hide it
        #: (W7b review 5: a notched box shelled open on its notched top)
        self.engine_limits = engine_limits

    def occt_limited(self, rep: dict) -> str | None:
        """The engine-internal code the oracle failed this feature with, when it is one of
        `engine_limits`; else None."""
        f = next((x for x in rep["features"] if x["feature_id"] == self.fid), None)
        c = ((f or {}).get("error") or {}).get("code")
        return c if self.engine_limits and f is not None and f["status"] == "error" and c in self.engine_limits else None

    def verify(self, rep: dict) -> str | None:
        f = next((x for x in rep["features"] if x["feature_id"] == self.fid), None)
        if self.occt_limited(rep):
            return None  # a known OCCT limitation (`engine_limits`): kept, listed by `gen_one`
        if self.code is not None:
            got = (f or {}).get("error") or {}
            if f is None or f["status"] != "error" or got.get("code") != self.code:
                return f"{self.fid}: {got.get('code') or (f or {}).get('status')}, expected {self.code}"
            for k, v in (self.details or {}).items():
                if (got.get("details") or {}).get(k) != v:
                    return f"{self.fid}: {self.code} {k} = {(got.get('details') or {}).get(k)!r}, closed form {v!r}"
            return None
        if f is None or f["status"] != "ok":
            return f"{self.fid}: not ok"
        for field, want in (("edge_types", self.edge_types), ("face_types", self.face_types)):
            if want is None:
                continue
            tot: dict = {}
            for b in f.get("bodies") or []:
                for k, v in b[field].items():
                    tot[k] = tot.get(k, 0) + v
            got = {k: tot.get(k, 0) for k in want}
            if got != want:
                return f"{self.fid}: {field.replace('_', ' ')} {got}, expected {want}"
        if self.kept is not None or self.gone is not None:
            present = {b["origin"]["feature"] for p in rep.get("parts", []) for b in p.get("bodies", [])}
            bad = [k for k in self.kept or [] if k not in present] + [k for k in self.gone or [] if k in present]
            if bad:
                return f"{self.fid}: part bodies of {bad} are {'missing' if bad[0] in (self.kept or []) else 'left'}"
        bs = f.get("bodies") or []
        if self.bodies is not None and len(bs) != self.bodies:
            return f"{self.fid}: {len(bs)} bodies, closed form {self.bodies}"
        if self.volume is not None:
            v = sum(b["volume"] for b in bs)
            if abs(v - self.volume) > self.rel * max(abs(self.volume), 1.0):
                return f"{self.fid}: volume {v!r}, closed form {self.volume!r}"
        if self.warnings is not None:
            got = {w["code"] for w in f["warnings"]} & {"BOOLEAN_SPLIT", "BOOLEAN_BODY_CONSUMED", "HOLE_BREAKS_THROUGH",
                                                         "PATTERN_INSTANCE_SKIPPED", "SHELL_CLOSED_VOID"}
            if got != self.warnings:
                return f"{self.fid}: warnings {sorted(got)}, expected {sorted(self.warnings)}"
        if self.skipped is not None:
            got = (f.get("pattern") or {}).get("skipped")
            if got != self.skipped:
                return f"{self.fid}: skipped {got}, expected {self.skipped}"
        return None


class Ops:
    """Adds F1/F2 groups to a `generator.Builder`."""

    def __init__(self, b):
        self.b = b
        self.rng = b.rng
        self.checks: list[Check] = []

    # -- shared pieces ----------------------------------------------------------------------------
    def plate(self, name: str, w=(30, 90), d=(20, 70), t=(4, 15)) -> dict:
        b, rng = self.b, self.rng
        W, D, T = _r(rng, *w), _r(rng, *d), _r(rng, *t)
        pw, pd, pt = b.param(f"{name}_w", "mm", W), b.param(f"{name}_d", "mm", D), b.param(f"{name}_t", "mm", T)
        sid = b.fid("s")
        b.feature({"type": "sketch", "id": sid, "name": f"{name}_sk", "plane": "XY",
                   "curves": [{"kind": "rect", "id": f"{name}_r", "center": [0.0, 0.0], "w": pw, "h": pd}]})
        eid = b.fid("e")
        b.feature({"type": "extrude", "id": eid, "name": name, "sketch": sid, "distance": pt})
        return {"eid": eid, "W": W, "D": D, "T": T, "V": W * D * T, "rid": f"{name}_r"}

    @staticmethod
    def body(eid: str) -> dict:
        return {"kind": "body", "q": {"op": "body", "feature": eid}}

    @staticmethod
    def cap(eid: str, end: str = "end") -> dict:
        return {"face": {"kind": "face", "q": {"op": "cap", "feature": eid, "end": end}}}

    def sketch(self, name: str, plane, curves: list) -> str:
        sid = self.b.fid("s")
        self.b.feature({"type": "sketch", "id": sid, "name": name, "plane": plane, "curves": curves})
        return sid

    # -- booleans ---------------------------------------------------------------------------------
    def flush_join(self) -> None:
        rng = self.rng
        p = self.plate("base")
        bw, bd, h = _r(rng, 2, p["W"] / 3), _r(rng, 2, p["D"] / 2), _r(rng, 1, 10)
        side = rng.choice(["+x", "-x", "+y", "-y", "corner"])
        if side in ("+x", "corner"):
            x0 = p["W"] / 2 - bw
        elif side == "-x":
            x0 = -p["W"] / 2
        else:
            x0 = _r(rng, -p["W"] / 2 + 1, p["W"] / 2 - bw - 1)
        if side == "+y":
            y0 = p["D"] / 2 - bd
        elif side in ("-y", "corner"):
            y0 = -p["D"] / 2
        else:
            y0 = _r(rng, -p["D"] / 2 + 1, p["D"] / 2 - bd - 1)
        sid = self.sketch("flush_sk", "XY", [{"kind": "rect", "id": "blk", "corner": [x0, y0], "w": bw, "h": bd}])
        fid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": fid, "name": "flush", "sketch": sid, "distance": p["T"] + h,
                        "op": "join", "targets": self.body(p["eid"])})
        self.checks.append(Check(fid, volume=p["V"] + bw * bd * h, bodies=1, warnings=set()))
        self.b.desc.append(f"flush_join({side})")

    def through_cut(self) -> None:
        rng = self.rng
        p = self.plate("plate")
        kind = rng.choice(["rect", "circle", "slot"])
        m = min(p["W"], p["D"]) / 2 - 1.5
        if kind == "rect":
            w, h = _r(rng, 1, m), _r(rng, 1, m)
            cur, area = {"kind": "rect", "id": "win", "center": [0.0, 0.0], "w": w, "h": h}, w * h
        elif kind == "circle":
            r = _r(rng, 0.5, m / 2)
            cur, area = {"kind": "circle", "id": "win", "center": [0.0, 0.0], "radius": r}, PI * r * r
        else:
            L, w = _r(rng, 1, m), _r(rng, 0.5, m / 2)
            cur, area = {"kind": "slot", "id": "win", "a": [-L / 2, 0.0], "b": [L / 2, 0.0], "w": w}, L * w + PI * (w / 2) ** 2
        sid = self.sketch("win_sk", self.cap(p["eid"]), [cur])
        fid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": fid, "name": "window", "sketch": sid, "distance": p["T"] + 2,
                        "direction": "reverse", "op": "cut", "targets": self.body(p["eid"])})
        self.checks.append(Check(fid, volume=p["V"] - area * p["T"], bodies=1, warnings=set()))
        self.b.desc.append(f"through_cut({kind})")

    def split_bar(self) -> None:
        rng = self.rng
        p = self.plate("bar", w=(30, 90), d=(5, 20))
        s = _r(rng, 0.5, 4)
        x0 = _r(rng, -p["W"] / 2 + 3, p["W"] / 2 - 3 - s)
        sid = self.sketch("gap_sk", "XY", [{"kind": "rect", "id": "gap", "corner": [x0, -p["D"] / 2 - 1],
                                              "w": s, "h": p["D"] + 2}])
        fid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": fid, "name": "gap", "sketch": sid, "distance": 2 * p["T"] + 2,
                        "direction": "symmetric", "op": "cut", "targets": self.body(p["eid"])})
        self.checks.append(Check(fid, volume=p["V"] - s * p["D"] * p["T"], bodies=2, warnings={"BOOLEAN_SPLIT"}))
        self.b.desc.append("split_bar")

    def consumed(self) -> None:
        a = self.plate("small", w=(3, 10), d=(3, 10), t=(1, 5))
        sid = self.sketch("cover_sk", "XY", [{"kind": "rect", "id": "cover", "center": [0.0, 0.0],
                                                 "w": a["W"] + 2, "h": a["D"] + 2}])
        fid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": fid, "name": "cover", "sketch": sid, "distance": 2 * a["T"] + 2,
                        "direction": "symmetric", "op": "cut", "targets": self.body(a["eid"])})
        self.checks.append(Check(fid, bodies=0, warnings={"BOOLEAN_BODY_CONSUMED"}))
        self.b.desc.append("consumed")

    def coaxial_corner_boss(self) -> None:
        """A boss coaxial with a rounded plate corner, of the corner's radius: its side face and the
        corner face lie on one cylinder and merge (§6.0.4) — coincident cylinders. (A pocket
        internally tangent to a side would pinch the wall to zero along a line: that result is
        `BOOLEAN_NON_MANIFOLD`, not a generated `ok` program.)"""
        rng = self.rng
        W, D, T = _r(rng, 20, 80), _r(rng, 20, 60), _r(rng, 3, 12)
        r, h = _r(rng, 1, min(W, D) / 4), _r(rng, 1, 10)
        sid = self.sketch("rr_sk", "XY", [{"kind": "rect", "id": "rr", "center": [0.0, 0.0], "w": W, "h": D, "r": r}])
        eid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": eid, "name": "rounded", "sketch": sid, "distance": T})
        sx, sy = rng.choice([1, -1]), rng.choice([1, -1])
        sid2 = self.sketch("post_sk", "XY", [{"kind": "circle", "id": "post",
                                                "center": [sx * (W / 2 - r), sy * (D / 2 - r)], "radius": r}])
        fid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": fid, "name": "post", "sketch": sid2, "distance": T + h, "op": "join",
                        "targets": self.body(eid)})
        vol = (W * D - (4 - PI) * r * r) * T + PI * r * r * h
        self.checks.append(Check(fid, volume=vol, bodies=1, warnings=set()))
        self.b.desc.append("coaxial_corner_boss")

    def edge_notch(self) -> None:
        rng = self.rng
        p = self.plate("plate")
        bw, e2, c = _r(rng, 0.5, p["W"] / 4), _r(rng, 0.5, p["D"] / 4), _r(rng, 0.2, p["T"] / 2)
        did = self.b.fid("d")
        self.b.feature({"type": "datum_plane", "id": did, "name": "notch_level", "mode": "offset", "from": "XY",
                        "distance": p["T"] - c})
        sid = self.sketch("notch_sk", {"datum": did},
                          [{"kind": "rect", "id": "notch", "corner": [p["W"] / 2 - bw, -e2], "w": bw, "h": 2 * e2}])
        fid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": fid, "name": "notch", "sketch": sid, "distance": c,
                        "op": "cut", "targets": self.body(p["eid"])})
        self.checks.append(Check(fid, volume=p["V"] - bw * 2 * e2 * c, bodies=1, warnings=set()))
        self.b.desc.append("edge_notch")

    def bridge_join(self) -> None:
        rng = self.rng
        g, W, D, T = _r(rng, 1, 10), _r(rng, 10, 40), _r(rng, 10, 40), _r(rng, 2, 10)
        ids = []
        for k, sgn in (("left", -1), ("right", 1)):
            x0 = -g / 2 - W if sgn < 0 else g / 2
            sid = self.sketch(f"{k}_sk", "XY", [{"kind": "rect", "id": f"{k}_r", "corner": [x0, -D / 2], "w": W, "h": D}])
            eid = self.b.fid("e")
            self.b.feature({"type": "extrude", "id": eid, "name": k, "sketch": sid, "distance": T})
            ids.append(eid)
        ov, e, h = _r(rng, 0.5, W / 2), _r(rng, 0.5, D / 3), _r(rng, 0.5, 5)
        sid = self.sketch("bridge_sk", "XY", [{"kind": "rect", "id": "bridge", "corner": [-g / 2 - ov, -e],
                                                  "w": g + 2 * ov, "h": 2 * e}])
        fid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": fid, "name": "bridge", "sketch": sid, "distance": T + h, "op": "join",
                        "targets": {"kind": "body", "q": {"op": "union", "of": [{"op": "body", "feature": ids[0]},
                                                                               {"op": "body", "feature": ids[1]}]}}})
        vol = 2 * W * D * T + g * 2 * e * T + (g + 2 * ov) * 2 * e * h
        self.checks.append(Check(fid, volume=vol, bodies=1, warnings=set()))
        self.b.desc.append("bridge_join")

    def _cut_circle(self, eid: str, c: tuple, r: float, T: float, name: str) -> str:
        """A through cut of a circle (centre c, radius r) from the top cap of plate `eid`."""
        sid = self.sketch(f"{name}_sk", self.cap(eid), [{"kind": "circle", "id": name, "center": list(c), "radius": r}])
        fid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": fid, "name": name, "sketch": sid, "distance": T + 2,
                        "direction": "reverse", "op": "cut", "targets": self.body(eid)})
        return fid

    def tangent_cylinders(self) -> None:
        """Cylinders tangent to cylinders or planes (the W4 acceptance's "tangent cylinders"), each
        with the SPEC's outcome: internal tangency that encloses (a hole enlarged by a tangent cut,
        a hole filled by a tangent pin: `ok`, closed-form volume), a boss tangent to a plate side
        (`ok`), and line contacts — a pin outside a side or inside a hole (`join`:
        `BOOLEAN_NO_INTERSECTION`, no overlap and no shared face of positive area), two holes
        externally tangent, a pocket tangent to a side (`cut`: the wall pinches to a line,
        `BOOLEAN_NON_MANIFOLD`)."""
        rng = self.rng
        p = self.plate("plate", w=(40, 90), d=(30, 70), t=(3, 12))
        W, D, T, V = p["W"], p["D"], p["T"], p["V"]
        kind = rng.choice(["enlarge_hole", "fill_hole", "boss_on_side", "pin_outside", "pin_in_hole",
                           "hole_beside_hole", "pocket_at_side"])
        m = min(W, D) / 2
        r1 = _r(rng, 1, m / 4)
        phi = math.radians(rng.choice([0, 30, 45, 90, 135, 180, 225, 270, 300]))
        u = (math.cos(phi), math.sin(phi))
        c1 = (_r(rng, -m / 4, m / 4), _r(rng, -m / 4, m / 4))
        h = _r(rng, 1, 8)
        if kind == "enlarge_hole":
            self._cut_circle(p["eid"], c1, r1, T, "hole")
            r2 = round(r1 + _r(rng, 0.5, 3), 3)
            c2 = (c1[0] + (r2 - r1) * u[0], c1[1] + (r2 - r1) * u[1])
            fid = self._cut_circle(p["eid"], c2, r2, T, "bigger")
            self.checks.append(Check(fid, volume=V - PI * r2 * r2 * T, bodies=1, warnings=set()))
        elif kind == "fill_hole":
            self._cut_circle(p["eid"], c1, r1, T, "hole")
            r2 = round(r1 + _r(rng, 0.5, 3), 3)
            c2 = (c1[0] + (r2 - r1) * u[0], c1[1] + (r2 - r1) * u[1])
            sid = self.sketch("pin_sk", "XY", [{"kind": "circle", "id": "pin", "center": list(c2), "radius": r2}])
            fid = self.b.fid("e")
            self.b.feature({"type": "extrude", "id": fid, "name": "pin", "sketch": sid, "distance": T + h, "op": "join",
                            "targets": self.body(p["eid"])})
            # the pin contains the hole: the union is the plate and the pin
            self.checks.append(Check(fid, volume=V + PI * r2 * r2 * h, bodies=1, warnings=set()))
        elif kind in ("boss_on_side", "pocket_at_side", "pin_outside"):
            r = _r(rng, 1, m / 3)
            side = rng.choice(["+x", "-x", "+y", "-y"])
            along = _r(rng, -(D if side[1] == "x" else W) / 2 + r + 1, (D if side[1] == "x" else W) / 2 - r - 1)
            inset = -r if kind == "pin_outside" else r  # the centre r inside (tangent from inside) or outside
            if side[1] == "x":
                c = ((W / 2 - inset) * (1 if side[0] == "+" else -1), along)
            else:
                c = (along, (D / 2 - inset) * (1 if side[0] == "+" else -1))
            fid = self.b.fid("e")
            if kind == "boss_on_side":
                sid = self.sketch("boss_sk", self.cap(p["eid"]), [{"kind": "circle", "id": "boss", "center": list(c), "radius": r}])
                self.b.feature({"type": "extrude", "id": fid, "name": "boss", "sketch": sid, "distance": h, "op": "join",
                                "targets": self.body(p["eid"])})
                self.checks.append(Check(fid, volume=V + PI * r * r * h, bodies=1, warnings=set()))
            elif kind == "pocket_at_side":
                dep = _r(rng, 0.3, T - 0.3)
                sid = self.sketch("pocket_sk", self.cap(p["eid"]), [{"kind": "circle", "id": "pocket", "center": list(c),
                                                                      "radius": r}])
                self.b.feature({"type": "extrude", "id": fid, "name": "pocket", "sketch": sid, "distance": dep,
                                "direction": "reverse", "op": "cut", "targets": self.body(p["eid"])})
                self.checks.append(Check(fid, code="BOOLEAN_NON_MANIFOLD"))
            else:
                sid = self.sketch("pin_sk", "XY", [{"kind": "circle", "id": "pin", "center": list(c), "radius": r}])
                self.b.feature({"type": "extrude", "id": fid, "name": "pin", "sketch": sid, "distance": T, "op": "join",
                                "targets": self.body(p["eid"])})
                self.checks.append(Check(fid, code="BOOLEAN_NO_INTERSECTION"))
            kind = f"{kind}{side}"
        elif kind == "pin_in_hole":
            self._cut_circle(p["eid"], c1, r1, T, "hole")
            r2 = round(r1 * _r(rng, 0.3, 0.8), 3)
            c2 = (c1[0] + (r1 - r2) * u[0], c1[1] + (r1 - r2) * u[1])
            sid = self.sketch("pin_sk", "XY", [{"kind": "circle", "id": "pin", "center": list(c2), "radius": r2}])
            fid = self.b.fid("e")
            self.b.feature({"type": "extrude", "id": fid, "name": "pin", "sketch": sid, "distance": T, "op": "join",
                            "targets": self.body(p["eid"])})
            self.checks.append(Check(fid, code="BOOLEAN_NO_INTERSECTION"))
        else:  # hole_beside_hole
            self._cut_circle(p["eid"], c1, r1, T, "hole")
            r2 = _r(rng, 0.5, m / 4)
            c2 = (c1[0] + (r1 + r2) * u[0], c1[1] + (r1 + r2) * u[1])
            fid = self._cut_circle(p["eid"], c2, r2, T, "beside")
            self.checks.append(Check(fid, code="BOOLEAN_NON_MANIFOLD"))
        self.b.desc.append(f"tangent_cylinders({kind})")

    def _block(self, name: str, corner: tuple, w: float, d: float, t: float, z0: float = 0.0) -> str:
        """A new-body box [corner, corner + (w, d)] × [z0, z0 + t]."""
        plane = "XY" if z0 == 0.0 else {"origin": [0.0, 0.0, z0], "normal": [0.0, 0.0, 1.0], "x_dir": [1.0, 0.0, 0.0]}
        sid = self.sketch(f"{name}_sk", plane, [{"kind": "rect", "id": name, "corner": list(corner), "w": w, "h": d}])
        eid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": eid, "name": name, "sketch": sid, "distance": t})
        return eid

    @staticmethod
    def bodies_of(eids: list[str]) -> dict:
        if len(eids) == 1:
            return {"kind": "body", "q": {"op": "body", "feature": eids[0]}}
        return {"kind": "body", "q": {"op": "union", "of": [{"op": "body", "feature": e} for e in eids]}}

    def boolean_feature(self) -> None:
        """The explicit `boolean` feature (§6.4): `join`, `cut` and `intersect`, one or two targets,
        one to three tools, `keep_tools` (kept tools stay in the part with their origin; consumed
        ones are gone), closed-form volumes of boxes."""
        rng = self.rng
        op = rng.choice(["join", "cut", "intersect"])
        keep = rng.random() < 0.4
        W, D, T = _r(rng, 20, 60), _r(rng, 15, 40), _r(rng, 2, 10)
        if op == "join":
            base = self._block("base", (-W / 2, -D / 2), W, D, T)
            k = rng.randint(1, 3)
            slot = W / k
            tools, vol = [], W * D * T
            for i in range(k):
                w = _r(rng, 0.5, slot - 1.0)
                d = _r(rng, 1.0, 8.0)
                o = _r(rng, 0.3, d - 0.3)  # the depth by which the block overlaps the base
                h = _r(rng, 0.5, 3.0)
                x0 = -W / 2 + i * slot + 0.5
                # taller than the base: a tab's top face (whose probe is its body's, §7.6) is not
                # coplanar with the base's — two bodies with agreeing normals at a body probe are
                # "not a match" by §8.1 (the key tie-break is a Contract-stage question)
                tools.append(self._block(f"tab{i}", (x0, D / 2 - o), w, d, T + h))
                vol += w * d * (T + h) - w * o * T
            targets = [base]
            want = dict(volume=vol, bodies=1)
        else:
            n = rng.randint(1, 2)
            gap = _r(rng, 1, 5)
            targets = [self._block(f"plate{i}", (-W / 2 + i * (W + gap), -D / 2), W, D, T) for i in range(n)]
            span = n * W + (n - 1) * gap + 4
            if op == "cut":
                k = rng.randint(1, 2)
                cuts = [_r(rng, 0.5, D / 4) for _ in range(k)]
                tools = []
                for i, s in enumerate(cuts):  # notches along the ±Y edges, through every target
                    y0 = D / 2 - s if i == 0 else -D / 2 - 1
                    tools.append(self._block(f"notch{i}", (-W / 2 - 2, y0), span, s + 1, T + 2, z0=-1.0))
                vol = n * W * (D - sum(cuts)) * T
            else:
                e1, e2 = _r(rng, 0.5, D / 4), _r(rng, 0.5, D / 4)
                tools = [self._block("band", (-W / 2 - 2, -D / 2 + e1), span, D - e1 - e2, T + 2, z0=-1.0)]
                vol = n * W * (D - e1 - e2) * T
            want = dict(volume=vol, bodies=n)
        fid = self.b.fid("b")
        f = {"type": "boolean", "id": fid, "name": f"{op}_all", "op": op, "targets": self.bodies_of(targets),
             "tools": self.bodies_of(tools)}
        if keep:
            f["keep_tools"] = True
        self.b.feature(f)
        self.checks.append(Check(fid, warnings=set(), kept=(targets + tools) if keep else targets,
                                 gone=None if keep else tools, **want))
        self.b.desc.append(f"boolean_feature({op}, {len(targets)} targets, {len(tools)} tools{', keep' if keep else ''})")

    def multi_intersect(self) -> None:
        """An `intersect` with two or three band tools that overlap or touch (W7b review 4): the
        result is `t ∩ ∪K`, one body per target — never the per-tool pieces OCCT's `Common` splits
        it into. The bands run along X through every target (1 or 2 plates), stand 1 mm proud of
        them in Z, and cover y ∈ [−D/2 + e1, D/2 − e2] together: `touch` bands meet at a shared
        y value (one face in common), `overlap` bands reach 0.3–1 mm into the next one, `mixed`
        does both. Closed form: n·W·(D − e1 − e2)·T."""
        rng = self.rng
        W, D, T = _r(rng, 20, 60), _r(rng, 20, 40), _r(rng, 2, 10)
        n = rng.randint(1, 2)
        gap = _r(rng, 1, 5)
        targets = [self._block(f"plate{i}", (-W / 2 + i * (W + gap), -D / 2), W, D, T) for i in range(n)]
        span = n * W + (n - 1) * gap + 4
        k = rng.randint(2, 3)
        kind = rng.choice(["touch", "overlap", "mixed"] if k == 3 else ["touch", "overlap"])
        e1, e2 = _r(rng, 0.5, D / 5), _r(rng, 0.5, D / 5)
        lo, hi = -D / 2 + e1, D / 2 - e2
        # cut points strictly inside [lo, hi], at least 2 mm apart and from the ends
        cuts = sorted(_r(rng, lo + 2, hi - 2) for _ in range(k - 1))
        if any(b - a < 2 for a, b in zip([lo] + cuts, cuts + [hi])):
            raise _Retry()
        edges = [lo] + cuts + [hi]
        tools = []
        for i in range(k):
            y0, y1 = edges[i], edges[i + 1]
            joint = kind == "overlap" or (kind == "mixed" and i == 0)
            if joint and i + 1 < k:
                y1 = y1 + _r(rng, 0.3, 1.0)  # reaches into the next band
            # a touching band starts exactly where the previous one ends: its corner is that float
            tools.append(self._block(f"band{i}", (-W / 2 - 2, y0), span, y1 - y0, T + 2, z0=-1.0))
        fid = self.b.fid("b")
        self.b.feature({"type": "boolean", "id": fid, "name": "intersect_bands", "op": "intersect",
                        "targets": self.bodies_of(targets), "tools": self.bodies_of(tools)})
        self.checks.append(Check(fid, volume=n * W * (hi - lo) * T, bodies=n, warnings=set(), kept=targets,
                                 gone=tools))
        self.b.desc.append(f"multi_intersect({kind}, {n} targets, {k} tools)")

    def _cone(self, R: float, H: float) -> str:
        """A cone of base radius R (the base disc on y = 0) and height H, its apex at (0, H, 0): the
        revolution of a right triangle about the sketch's Y axis."""
        sid = self.sketch("cone_sk", "XY", [{"kind": "line", "id": "base", "start": [0.0, 0.0], "end": [R, 0.0]},
                                            {"kind": "line", "id": "slant", "start": [R, 0.0], "end": [0.0, H]},
                                            {"kind": "line", "id": "axis", "start": [0.0, H], "end": [0.0, 0.0]}])
        eid = self.b.fid("r")
        self.b.feature({"type": "revolve", "id": eid, "name": "cone", "sketch": sid,
                        "axis": {"origin": [0.0, 0.0], "direction": [0.0, 1.0]}, "angle": 360.0})
        return eid

    def _slab_cut(self, target: str, o: tuple, n: tuple, x_dir: tuple, size: float, depth: float, name: str) -> str:
        """Cut away the side `n` of the plane through `o` (normal n): a size × size box on that plane,
        `depth` deep."""
        sid = self.sketch(f"{name}_sk", {"origin": list(o), "normal": list(n), "x_dir": list(x_dir)},
                          [{"kind": "rect", "id": name, "center": [0.0, 0.0], "w": size, "h": size}])
        fid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": fid, "name": name, "sketch": sid, "distance": depth, "op": "cut",
                        "targets": self.body(target)})
        return fid

    def oblique_sections(self) -> None:
        """Sections of §8.3 rule 3 in generated programs: an oblique plane through a cylinder
        (an ellipse), two crossing cylinders of equal radius (ellipses), and the plane–cone test of
        [W0-51] on a revolved cone — a plane cutting every generator (an ellipse), a plane through
        the axis (two generator lines), a plane parallel to a generator (a parabola, `bspline`) —
        with the edge types the rule gives and closed-form volumes where one exists (the apex piece
        cut off by a plane is an oblique cone: `π·a·b·d / 3`)."""
        rng = self.rng
        kind = rng.choice(["cylinder_ellipse", "crossing_equal", "cone_ellipse", "cone_lines", "cone_parabola"])
        if kind == "cylinder_ellipse":
            r, H = _r(rng, 2, 10), _r(rng, 20, 60)
            th = math.radians(_r(rng, 5, 50))
            lo, hi = r * math.tan(th) + 1, H - r * math.tan(th) - 1
            if not lo < hi:
                raise _Retry()
            z0 = _r(rng, lo, hi)
            sid = self.sketch("rod_sk", "XY", [{"kind": "circle", "id": "rod", "center": [0.0, 0.0], "radius": r}])
            eid = self.b.fid("e")
            self.b.feature({"type": "extrude", "id": eid, "name": "rod", "sketch": sid, "distance": H})
            n = (-math.sin(th), 0.0, math.cos(th))
            # every point of the rod is within H + r of the plane's origin: a 2·(H + 3r) square covers it
            fid = self._slab_cut(eid, (0.0, 0.0, z0), n, (0.0, 1.0, 0.0), 2 * (H + 3 * r), H + 2 * r, "slant")
            # the plane z = z0 + x·tan θ halves the rod's cross-sections about z0 on average: π r² z0 stays
            self.checks.append(Check(fid, volume=PI * r * r * z0, bodies=1, warnings=set(),
                                     edge_types={"ellipse": 1, "bspline": 0}))
        elif kind == "crossing_equal":
            r, L = _r(rng, 1, 6), _r(rng, 15, 40)
            s1 = self.sketch("vrod_sk", "XY", [{"kind": "circle", "id": "vrod", "center": [0.0, 0.0], "radius": r}])
            e1 = self.b.fid("e")
            self.b.feature({"type": "extrude", "id": e1, "name": "vrod", "sketch": s1, "distance": 2 * L, "direction": "symmetric"})
            s2 = self.sketch("hrod_sk", "YZ", [{"kind": "circle", "id": "hrod", "center": [0.0, 0.0], "radius": r}])
            fid = self.b.fid("e")
            self.b.feature({"type": "extrude", "id": fid, "name": "hrod", "sketch": s2, "distance": 2 * L,
                            "direction": "symmetric", "op": "join", "targets": self.body(e1)})
            # two rods of length 2L minus the Steinmetz bicylinder 16 r³ / 3
            self.checks.append(Check(fid, volume=2 * PI * r * r * 2 * L - 16 * r ** 3 / 3, bodies=1, warnings=set(),
                                     edge_types={"ellipse": 4, "bspline": 0}))
        else:
            R, H = _r(rng, 5, 15), _r(rng, 10, 30)
            alpha = math.atan2(R, H)
            cone = self._cone(R, H)
            V = PI * R * R * H / 3
            if kind == "cone_ellipse":
                # the plane through (0, y0, 0) with normal (sin θ, cos θ, 0), θ below 90° − α so that
                # it cuts every generator; the apex side is cut away
                th = rng.uniform(0.1, 0.8) * (PI / 2 - alpha)
                n = (math.sin(th), math.cos(th), 0.0)
                y0 = H * rng.uniform(0.35, 0.65)
                ends = []
                for sgn in (1.0, -1.0):  # the generators in the XY plane: x = sgn·(H − y)·tan α
                    t = (math.cos(th) * (y0 - H)) / (sgn * math.tan(alpha) * math.sin(th) - math.cos(th))
                    y = H - t  # t: the distance below the apex along the axis
                    ends.append((sgn * t * math.tan(alpha), y))
                if not all(0.5 < y < H - 0.5 for _, y in ends):
                    raise _Retry()
                a = 0.5 * math.dist(ends[0], ends[1])
                xc, yc = 0.5 * (ends[0][0] + ends[1][0]), 0.5 * (ends[0][1] + ends[1][1])
                b = math.sqrt(((H - yc) * math.tan(alpha)) ** 2 - xc * xc)
                d = abs(n[1] * (H - y0))  # the apex's distance from the plane
                fid = self._slab_cut(cone, (0.0, y0, 0.0), n, (0.0, 0.0, 1.0), 4 * R + 2 * H, H + R, "tilt")
                self.checks.append(Check(fid, volume=V - PI * a * b * d / 3, bodies=1, warnings=set(),
                                         edge_types={"ellipse": 1, "bspline": 0}))
            elif kind == "cone_lines":
                fid = self._slab_cut(cone, (0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), 4 * (R + H), R + 2, "half")
                # through the apex and the axis: two generator lines, the base diameter, the base arc
                self.checks.append(Check(fid, volume=V / 2, bodies=1, warnings=set(),
                                         edge_types={"line": 3, "circle": 1, "ellipse": 0, "bspline": 0}))
            else:  # cone_parabola: parallel to the generator x = (H − y)·tan α, through (x1, 0, 0)
                x1 = R * rng.uniform(0.2, 0.7)
                n = (math.cos(alpha), math.sin(alpha), 0.0)
                fid = self._slab_cut(cone, (x1, 0.0, 0.0), n, (0.0, 0.0, 1.0), 4 * (R + H), R + H, "flat")
                # a parabola (`bspline`, rule 3), the flat's base line, the base arc
                self.checks.append(Check(fid, bodies=1, warnings=set(),
                                         edge_types={"bspline": 1, "line": 1, "circle": 1, "ellipse": 0}))
        self.b.desc.append(f"oblique_sections({kind})")

    # -- holes --------------------------------------------------------------------------------------
    def _hole_kind(self, T: float) -> tuple[dict, float, float]:
        """(hole fields, max tool radius, closed-form tool volume inside a plate of thickness T)."""
        rng = self.rng
        sizes = consts.constants()["HOLE_SIZES"]["sizes"]

        def v(size, key):
            x = sizes[size].get(key)
            return None if x is None else float(x["value"])

        kind = rng.choice(["d", "fit", "blind", "flat", "cbore", "cbore_custom", "csink", "csink_custom", "insert",
                           "thread"])
        size = rng.choice(["M3", "M4", "M5", "M6", "M8"])
        if kind == "d":
            D = _r(rng, 1, 6)
            return {"d": D, "depth": "through"}, D / 2, PI * (D / 2) ** 2 * T
        if kind == "fit":
            fit = rng.choice(["close", "normal", "loose", "tap"])
            D = v(size, fit)
            h: dict = {"size": size, "depth": "through"}
            if fit != "normal":
                h["fit"] = fit
            return h, D / 2, PI * (D / 2) ** 2 * T
        if kind in ("blind", "flat", "thread"):
            D = v(size, "tap") if kind == "thread" else _r(rng, 1, 5)
            R = D / 2
            tip = 118.0 if kind != "flat" else None
            if kind == "blind" and rng.random() < 0.3:
                tip = 90.0
            th = R / math.tan(math.radians(tip / 2)) if tip else 0.0
            hmax = T - th - 0.5
            if hmax < 0.6:
                return self._hole_kind(T)
            depth = _r(rng, 0.5, hmax)
            h = {"depth": {"blind": depth}}
            if kind == "thread":
                h.update(size=size, thread=True)
            else:
                h["d"] = D
            if tip is None:
                h["tip"] = "flat"
            elif tip != 118.0:
                h["tip"] = tip
            vol = PI * R * R * depth + PI * R * R * th / 3
            return h, R, vol
        if kind in ("cbore", "cbore_custom"):
            if kind == "cbore":
                size = rng.choice(["M3", "M4", "M5", "M6", "M8"])
                Dc, hc, D = v(size, "cbore_d"), v(size, "cbore_depth"), v(size, "normal")
                h = {"size": size, "depth": "through", "cbore": "iso4762"}
            else:
                D = _r(rng, 1, 4)
                Dc, hc = round(D + _r(rng, 1, 4), 3), _r(rng, 0.5, 3)
                h = {"d": D, "depth": "through", "cbore": {"d": Dc, "depth": hc}}
            if hc >= T - 0.5:
                return self._hole_kind(T)
            return h, Dc / 2, PI * (Dc / 2) ** 2 * hc + PI * (D / 2) ** 2 * (T - hc)
        if kind in ("csink", "csink_custom"):
            if kind == "csink":
                size = rng.choice(["M3", "M4", "M5", "M6", "M8"])
                Dk, ang, D = v(size, "csink_d"), 90.0, v(size, "normal")
                h = {"size": size, "depth": "through", "csink": "iso10642"}
            else:
                D = _r(rng, 1, 4)
                Dk, ang = round(D + _r(rng, 1, 4), 3), rng.choice([60.0, 82.0, 90.0, 100.0, 120.0])
                h = {"d": D, "depth": "through", "csink": {"d": Dk, "angle": ang}}
            Rk, R = Dk / 2, D / 2
            hk = (Rk - R) / math.tan(math.radians(ang / 2))
            if hk >= T - 0.5:
                return self._hole_kind(T)
            return h, Rk, PI * hk / 3 * (Rk * Rk + Rk * R + R * R) + PI * R * R * (T - hk)
        size = rng.choice(["M3", "M4", "M5", "M6"])
        D, depth = v(size, "insert_d"), v(size, "insert_depth")
        if depth >= T - 0.5:
            return self._hole_kind(T)
        return {"size": size, "insert": "std"}, D / 2, PI * (D / 2) ** 2 * depth

    def holes(self) -> None:
        rng = self.rng
        p = self.plate("holed", w=(40, 100), d=(30, 80), t=(10, 20))
        fields, R, one = self._hole_kind(p["T"])
        margin = R + 1.0
        form = rng.choice(["list", "grid", "circle", "points"])
        W2, D2 = p["W"] / 2 - margin, p["D"] / 2 - margin
        gap = 2 * R + 1.0
        if form == "grid":
            nx, ny = rng.randint(1, 4), rng.randint(1, 4)
            dx = _r(rng, gap, max(gap, 2 * W2 / max(1, nx - 1))) if nx > 1 else _r(rng, gap, gap + 5)
            dy = _r(rng, gap, max(gap, 2 * D2 / max(1, ny - 1))) if ny > 1 else _r(rng, gap, gap + 5)
            if (nx - 1) * dx / 2 > W2 or (ny - 1) * dy / 2 > D2:
                nx, ny = 1, 1
            at = {"grid": {"nx": self.b.param("nx", "count", float(nx)), "ny": float(ny), "dx": dx, "dy": dy}}
            n = nx * ny
        elif form == "circle":
            rad = min(W2, D2)
            n = rng.randint(1, 8)
            if rad < gap:
                n = 1
            elif n > 1 and 2 * rad * math.sin(PI / n) < gap:
                n = max(1, int(PI / math.asin(min(1.0, gap / (2 * rad)))))
            at = {"circle": {"n": float(n), "d": round(2 * rad * 0.9, 3), "start": float(rng.choice([0, 15, 30, 45, 90]))}}
            if at["circle"]["d"] <= 2e-6:
                at["circle"]["d"] = 1.0
        else:
            pts: list[tuple[float, float]] = []
            for _ in range(rng.randint(1, 4)):
                for _t in range(20):
                    q = (_r(rng, -W2, W2), _r(rng, -D2, D2))
                    if all(math.dist(q, x) >= gap for x in pts):
                        pts.append(q)
                        break
            n = len(pts)
            if form == "list":
                at = {"list": [{"id": f"p{k}", "at": [x, y]} for k, (x, y) in enumerate(pts)]}
            else:
                # a small circle, never extruded: a points-only sketch is valid too (it has no
                # regions; only a body feature consuming it fails, SKETCH_NO_REGIONS), but the
                # circle keeps the draws of this group unchanged
                sid = self.sketch("hole_pts", self.cap(p["eid"]),
                                  [{"kind": "point", "id": f"q{k}", "at": [x, y]} for k, (x, y) in enumerate(pts)]
                                  + [{"kind": "circle", "id": "mark", "center": [0.0, 0.0], "radius": 0.5}])
                at = {"points": {"sketch": sid, "ids": "all" if rng.random() < 0.5 else [f"q{k}" for k in range(n)]}}
        hid = self.b.fid("h")
        h = {"type": "hole", "id": hid, "name": "holes", "on": self.cap(p["eid"]), "at": at, **fields}
        self.b.feature(h)
        self.checks.append(Check(hid, volume=p["V"] - n * one, bodies=1, warnings=set()))
        self.b.desc.append(f"holes({form}, {'/'.join(k for k in fields if k not in ('depth',))})")

    # -- patterns -----------------------------------------------------------------------------------
    def linear_bosses(self) -> None:
        rng = self.rng
        p = self.plate("deck", w=(40, 120), d=(30, 80), t=(3, 8))
        r, hb = _r(rng, 1, 4), _r(rng, 1, 6)
        x0, y0 = -p["W"] / 2 + r + 1, _r(rng, -p["D"] / 2 + r + 1, p["D"] / 2 - r - 1)
        sid = self.sketch("boss_sk", self.cap(p["eid"]), [{"kind": "circle", "id": "boss", "center": [x0, y0], "radius": r}])
        bid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": bid, "name": "boss", "sketch": sid, "distance": hb, "op": "join",
                        "targets": self.body(p["eid"])})
        two = rng.random() < 0.35
        n1 = rng.randint(2, 12)
        s1 = _r(rng, 2 * r + 0.5, 2 * r + 12)
        lay: dict = {"dir": "X", "count": self.b.param("n_boss", "count", float(n1)), "spacing": s1}
        n2, s2 = 1, 0.0
        if two:
            n2 = rng.randint(2, 12 if n1 <= 6 else 4)
            s2 = _r(rng, 2 * r + 0.5, 2 * r + 12) * rng.choice([1, -1])
            lay.update(dir2="Y", count2=float(n2), spacing2=s2)
        idx = [(i, j) for i in range(n1) for j in range(n2) if (i, j) != (0, 0)]
        skip = rng.sample(idx, k=min(len(idx) - 1, rng.randint(0, 2))) if len(idx) > 1 else []
        pat = {"type": "pattern", "id": self.b.fid("pt"), "name": "boss_row", "seed": {"features": [bid]},
               "layout": {"linear": lay}}
        if skip:
            pat["skip"] = [list(k) if two else [k[0]] for k in sorted(skip)]
        self.b.feature(pat)
        kept, skipped = 0, []
        for (i, j) in idx:
            if (i, j) in skip:
                continue
            cx, cy = x0 + i * s1, y0 + j * s2
            out = max(abs(cx) - p["W"] / 2, abs(cy) - p["D"] / 2)
            if abs(out - r) < 0.2 or (0 < out and abs(out) < 1e-3):
                self.b.desc.append("linear_bosses(borderline)")
                raise _Retry()
            if out > r:  # the boss would sit off the part: detached, skipped
                skipped.append([i, j] if two else [i])
            else:
                kept += 1
        if kept == 0:
            raise _Retry()
        # a boss hanging over the edge still joins; its volume is the full boss
        self.checks.append(Check(pat["id"], volume=p["V"] + (kept + 1) * PI * r * r * hb, bodies=1,
                                 warnings={"PATTERN_INSTANCE_SKIPPED"} if skipped else set(), skipped=skipped))
        self.b.desc.append(f"linear_bosses({n1}x{n2}, skip {len(skip)}, off {len(skipped)})")

    def intersect_seed_pattern(self) -> None:
        """A linear pattern of an `extrude … op: intersect` seed whose instances overlap (W7b review
        4): the seed keeps the plate's strip x ∈ [x0, x0 + w]; the pattern intersects that with the
        union of its instance tools, [x0 + s, x0 + (c − 1)·s + w] — one strip of width w − s.
        With `2s > w` the second instance misses the strip and is skipped
        (`PATTERN_INSTANCE_SKIPPED`)."""
        rng = self.rng
        p = self.plate("slab", w=(40, 90), d=(15, 50), t=(3, 10))
        w = _r(rng, 4, p["W"] / 2 - 2)
        x0 = _r(rng, -p["W"] / 2 + 1, p["W"] / 2 - 1 - w)
        s1 = _r(rng, 0.2 * w, 0.8 * w)
        if abs(2 * s1 - w) < 0.2:
            raise _Retry()
        c = rng.randint(2, 3)
        plane = {"origin": [0.0, 0.0, -1.0], "normal": [0.0, 0.0, 1.0], "x_dir": [1.0, 0.0, 0.0]}
        sid = self.sketch("strip_sk", plane, [{"kind": "rect", "id": "strip", "corner": [x0, -p["D"] / 2 - 1],
                                               "w": w, "h": p["D"] + 2}])
        eid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": eid, "name": "strip", "sketch": sid, "distance": p["T"] + 2,
                        "op": "intersect", "targets": self.body(p["eid"])})
        pid = self.b.fid("pt")
        self.b.feature({"type": "pattern", "id": pid, "name": "strips", "seed": {"features": [eid]},
                        "layout": {"linear": {"dir": "X", "count": float(c), "spacing": s1}}})
        skipped = [[2]] if c == 3 and 2 * s1 > w else []
        self.checks.append(Check(eid, volume=w * p["D"] * p["T"], bodies=1))
        self.checks.append(Check(pid, volume=(w - s1) * p["D"] * p["T"], bodies=1, skipped=skipped,
                                 warnings={"PATTERN_INSTANCE_SKIPPED"} if skipped else set()))
        self.b.desc.append(f"intersect_seed_pattern({c}, {'skip' if skipped else 'overlap'})")

    def circular_holes(self) -> None:
        """A bolt circle of through holes: the rotation axis (Z) is parallel to the hole axis (−Z) and
        the plate is a Z prism, so every copied through tool spans the plate as the seed's does
        (the module's note on pattern seeds)."""
        rng = self.rng
        p = self.plate("flange", w=(50, 100), d=(50, 100), t=(3, 10))
        D = _r(rng, 1, 4)
        rad = _r(rng, D + 2, min(p["W"], p["D"]) / 2 - D - 1)
        n = rng.randint(2, 36)
        while n > 2 and 2 * rad * math.sin(PI / n) < D + 0.5:
            n -= 1
        hid = self.b.fid("h")
        self.b.feature({"type": "hole", "id": hid, "name": "seed_hole", "on": self.cap(p["eid"]),
                        "at": {"list": [{"id": "a", "at": [rad, 0.0]}]}, "d": D, "depth": "through"})
        pid = self.b.fid("pt")
        self.b.feature({"type": "pattern", "id": pid, "name": "bolt_ring", "seed": {"features": [hid]},
                        "layout": {"circular": {"axis": "Z", "count": self.b.param("n_bolts", "count", float(n))}}})
        self.checks.append(Check(pid, volume=p["V"] - n * PI * (D / 2) ** 2 * p["T"], bodies=1, warnings=set()))
        self.b.desc.append(f"circular_holes({n})")

    def mirror_pocket(self) -> None:
        rng = self.rng
        p = self.plate("base")
        w, h, dep = _r(rng, 1, p["W"] / 4), _r(rng, 1, p["D"] / 2), _r(rng, 0.3, p["T"] / 2)
        x0 = _r(rng, 0.5, p["W"] / 2 - w - 0.5)
        sid = self.sketch("pocket_sk", self.cap(p["eid"]), [{"kind": "rect", "id": "pk", "corner": [x0, -h / 2],
                                                                "w": w, "h": h}])
        cid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": cid, "name": "pocket", "sketch": sid, "distance": dep,
                        "direction": "reverse", "op": "cut", "targets": self.body(p["eid"])})
        pid = self.b.fid("pt")
        self.b.feature({"type": "pattern", "id": pid, "name": "mirrored", "seed": {"features": [cid]},
                        "layout": {"mirror": {"plane": "YZ"}}})
        self.checks.append(Check(pid, volume=p["V"] - 2 * w * h * dep, bodies=1, warnings=set()))
        self.b.desc.append("mirror_pocket")

    def body_copies(self) -> None:
        rng = self.rng
        r, h = _r(rng, 0.5, 3), _r(rng, 1, 8)
        sid = self.sketch("pin_sk", "XY", [{"kind": "circle", "id": "pin", "center": [_r(rng, 5, 20), 0.0], "radius": r}])
        eid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": eid, "name": "pin", "sketch": sid, "distance": h})
        pid = self.b.fid("pt")
        if rng.random() < 0.5:
            n = rng.randint(2, 12)
            lay = {"circular": {"axis": "Z", "count": float(n)}}
        else:
            n = rng.randint(2, 8)
            lay = {"linear": {"dir": [1.0, 1.0, 0.0], "count": float(n), "spacing": round(2 * r + _r(rng, 1, 5), 3)}}
        self.b.feature({"type": "pattern", "id": pid, "name": "pins", "seed": {"bodies": self.body(eid)}, "layout": lay})
        self.checks.append(Check(pid, volume=(n - 1) * PI * r * r * h, bodies=n - 1, warnings=set()))
        self.b.desc.append("body_copies")

    # -- blends -------------------------------------------------------------------------------------
    def fillet_vertical(self) -> None:
        rng = self.rng
        p = self.plate("box")
        r = _r(rng, 0.2, 0.45 * min(p["W"], p["D"]))
        fid = self.b.fid("f")
        self.b.feature({"type": "fillet", "id": fid, "name": "corners", "r": self.b.param("r_corner", "mm", r),
                        "edges": {"kind": "edge", "q": {"op": "filter", "where": {"parallel": "Z"},
                                                        "of": {"op": "edges", "of": {"op": "sides", "feature": p["eid"]}}}}})
        self.checks.append(Check(fid, volume=p["V"] - 4 * (1 - PI / 4) * r * r * p["T"], bodies=1))
        self.b.desc.append("fillet_vertical")

    def chamfer_top(self) -> None:
        rng = self.rng
        p = self.plate("box")
        d = _r(rng, 0.2, 0.4 * min(p["T"], p["W"] / 2, p["D"] / 2))
        L = 2 * p["W"] + 2 * p["D"]
        cid = self.b.fid("c")
        c = {"type": "chamfer", "id": cid, "name": "top_edge", "d": d,
             "edges": {"kind": "edge", "q": {"op": "edges", "of": {"op": "cap", "feature": p["eid"], "end": "end"}}}}
        if rng.random() < 0.4:
            d2 = _r(rng, 0.2, 0.4 * min(p["T"], p["W"] / 2, p["D"] / 2))
            c.update(d2=d2, side={"kind": "face", "q": {"op": "cap", "feature": p["eid"], "end": "end"}})
            vol = p["V"] - (L * d * d2 / 2 - 4 * d * d * d2 / 3)
            self.b.desc.append("chamfer_top(two-distance)")
        else:
            vol = p["V"] - (L * d * d / 2 - 4 * d ** 3 / 3)
            self.b.desc.append("chamfer_top")
        self.b.feature(c)
        self.checks.append(Check(cid, volume=vol, bodies=1))

    def shell_box(self) -> None:
        rng = self.rng
        p = self.plate("box", t=(6, 20))
        th = _r(rng, 0.3, min(p["W"], p["D"], p["T"]) / 4)
        inward = rng.random() < 0.6
        sid = self.b.fid("sh")
        s = {"type": "shell", "id": sid, "name": "hollow", "thickness": th, "body": self.body(p["eid"]),
             "open": {"kind": "face", "q": {"op": "cap", "feature": p["eid"], "end": "end"}}}
        W, D, T = p["W"], p["D"], p["T"]
        if inward:
            vol = W * D * T - (W - 2 * th) * (D - 2 * th) * (T - th)
        else:
            s["direction"] = "outward"
            vol = (W + 2 * th) * (D + 2 * th) * (T + th) - W * D * T
        self.b.feature(s)
        self.checks.append(Check(sid, volume=vol, bodies=1, warnings=set()))
        self.b.desc.append(f"shell_box({'inward' if inward else 'outward'})")

    def shell_notched(self) -> None:
        """A **non-convex** shell (W7b review 5: `shell_box` covers only convex boxes): a box with a
        rectangular notch cut from its front-top edge (the tool overshoots the front and the top by
        1 mm), shelled inward by t with the notched top (`e1` cap end), the bottom or no face open.
        Closed form: the cavity is bounded by the box's faces offset inward by t — an open face not
        offset — minus the notch grown by t on its two side walls, back wall and floor (every wall
        drawn thicker than 2t + 1 mm, so no walls collide), and the shell is the body minus the
        cavity. The reviewer's 40 × 30 × 10 box with a 10 × 5 × 5 notch at t = 1: 2534 (top open),
        2474 (bottom open), 3538 (closed: `SHELL_CLOSED_VOID`). OCCT's `MakeThickSolid` returns the
        top-open body unchanged — a known OCCT limitation (`engine_limits`): the oracle reports
        `OCCT_SHELL_FAILED` and the program is kept, so Forge's result is listed (`ROBUSTNESS`)."""
        rng = self.rng
        p = self.plate("box", w=(30, 90), d=(20, 70), t=(8, 20))
        W, D, T = p["W"], p["D"], p["T"]
        th = _r(rng, 0.3, min(W, D, T) / 10)
        m = 2 * th + 1.0  # the thinnest wall left beside, behind and below the notch
        nw = _r(rng, 0.15 * W, W - 2 * m - 0.1)
        nd = _r(rng, 0.15 * D, 0.6 * (D - m))
        nh = _r(rng, 0.2 * T, T - m - 0.1)
        x0 = _r(rng, -W / 2 + m, W / 2 - m - nw)
        if not (x0 >= -W / 2 + m and x0 + nw <= W / 2 - m and D - nd >= m and T - nh >= m and nw > 0 and nh > 0):
            raise _Retry
        zf = T - nh  # the notch floor
        sid = self.sketch("notch_sk", {"origin": [0.0, 0.0, zf], "normal": [0.0, 0.0, 1.0], "x_dir": [1.0, 0.0, 0.0]},
                          [{"kind": "rect", "id": "notch", "center": [x0 + nw / 2, -D / 2 + (nd - 1.0) / 2],
                            "w": nw, "h": nd + 1.0}])
        cid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": cid, "name": "notch", "sketch": sid, "distance": nh + 1.0, "op": "cut",
                        "targets": self.body(p["eid"])})
        open_end = rng.choice(["end", "start", None])
        shid = self.b.fid("sh")
        s = {"type": "shell", "id": shid, "name": "hollow", "thickness": th, "body": self.body(p["eid"])}
        if open_end:
            s["open"] = {"kind": "face", "q": {"op": "cap", "feature": p["eid"], "end": open_end}}
        self.b.feature(s)
        top_closed, bottom_closed = open_end != "end", open_end != "start"
        body = W * D * T - nw * nd * nh
        cavity = ((W - 2 * th) * (D - 2 * th) * (T - th * (top_closed + bottom_closed))
                  - (nw + 2 * th) * nd * (nh + (0.0 if top_closed else th)))
        self.checks.append(Check(cid, volume=body, bodies=1))
        self.checks.append(Check(shid, volume=body - cavity, bodies=1,
                                 warnings={"SHELL_CLOSED_VOID"} if open_end is None else set(),
                                 engine_limits={"OCCT_SHELL_FAILED"} if open_end == "end" else None))
        self.b.desc.append(f"shell_notched({open_end or 'closed'})")

    def fillet_then_shell(self) -> None:
        rng = self.rng
        p = self.plate("tub", t=(6, 20))
        W, D, T = p["W"], p["D"], p["T"]
        r = _r(rng, 1.0, 0.4 * min(W, D))
        th = _r(rng, 0.3, min(r * 0.8, min(W, D, T) / 4))
        self.b.feature({"type": "fillet", "id": self.b.fid("f"), "name": "round", "r": r,
                        "edges": {"kind": "edge", "q": {"op": "filter", "where": {"parallel": "Z"},
                                                        "of": {"op": "edges", "of": {"op": "sides", "feature": p["eid"]}}}}})
        sid = self.b.fid("sh")
        self.b.feature({"type": "shell", "id": sid, "name": "wall", "thickness": th, "body": self.body(p["eid"]),
                        "open": {"kind": "face", "q": {"op": "cap", "feature": p["eid"], "end": "end"}}})

        def area(w, d, rr):
            return w * d - (4 - PI) * rr * rr

        vol = area(W, D, r) * T - area(W - 2 * th, D - 2 * th, r - th) * (T - th)
        self.checks.append(Check(sid, volume=vol, bodies=1, warnings=set()))
        self.b.desc.append("fillet_then_shell")

    def chamfer_chain(self) -> None:
        rng = self.rng
        W, D, T = _r(rng, 20, 60), _r(rng, 20, 60), _r(rng, 4, 12)
        rr = _r(rng, 1, min(W, D) / 4)
        sid = self.sketch("rr_sk", "XY", [{"kind": "rect", "id": "rr", "center": [0.0, 0.0], "w": W, "h": D, "r": rr}])
        eid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": eid, "name": "rounded", "sketch": sid, "distance": T})
        d = _r(rng, 0.2, min(rr, T) * 0.5)
        cid = self.b.fid("c")
        self.b.feature({"type": "chamfer", "id": cid, "name": "chain", "d": d,
                        "edges": {"kind": "edge", "q": {"op": "filter", "where": {"parallel": "X"},
                                                        "of": {"op": "edges", "of": {"op": "cap", "feature": eid, "end": "end"}}}}})
        self.checks.append(Check(cid, bodies=1))
        self.b.desc.append("chamfer_chain")

    def fillet_top(self) -> None:
        rng = self.rng
        p = self.plate("box")
        r = _r(rng, 0.2, 0.35 * min(p["T"], p["W"] / 2, p["D"] / 2))
        fid = self.b.fid("f")
        self.b.feature({"type": "fillet", "id": fid, "name": "top_round", "r": r,
                        "edges": {"kind": "edge", "q": {"op": "edges", "of": {"op": "cap", "feature": p["eid"], "end": "end"}}}})
        self.checks.append(Check(fid, bodies=1))
        self.b.desc.append("fillet_top")

    # -- blends at their limits (W7b review 3) -------------------------------------------------------
    # Each draws a size just above or just below a closed-form limit of §6.6–§6.8 (the width of the
    # narrowest face across the edge, two blends meeting on a face, a radius, a gap): above, the
    # SPEC's error with `max_feasible_*` = the limit − tol rounded down to 0.001 mm; below, `ok`
    # with the closed-form volume (and blend face types). The limits are the SPEC's formulas on
    # the drawn dimensions, never the oracle's construction code.

    def _near_limit(self, lim: float, lo: float = 0.3) -> tuple[bool, float]:
        """(above, size): a size 2–50 % above the limit, or `lo`–98 % of it (3 decimals)."""
        rng = self.rng
        if rng.random() < 0.5:
            x = round(lim * rng.uniform(1.02, 1.5), 3)
            if not x > lim:
                raise _Retry
            return True, x
        x = round(lim * rng.uniform(lo, 0.98), 3)
        if not x > 0.05:
            raise _Retry
        return False, x

    def blend_limits(self) -> None:
        rng = self.rng
        tol = consts.LINEAR_TOLERANCE
        kind = rng.choice(["fillet_vertical", "chamfer_top", "shell_open", "shell_closed_in", "shell_closed_out"])
        p = self.plate("box", w=(20, 60), d=(20, 60), t=(6, 20))
        W, D, T, V = p["W"], p["D"], p["T"], p["V"]
        body = self.body(p["eid"])
        top = {"kind": "edge", "q": {"op": "edges", "of": {"op": "cap", "feature": p["eid"], "end": "end"}}}
        vertical = {"kind": "edge", "q": {"op": "filter", "where": {"parallel": "Z"},
                                          "of": {"op": "edges", "of": {"op": "sides", "feature": p["eid"]}}}}
        if kind == "fillet_vertical":
            lim = (min(W, D) - tol) / 2  # two fillets on the narrower wall (`adjacent-blend`)
            above, r = self._near_limit(lim)
            fid = self.b.fid("f")
            self.b.feature({"type": "fillet", "id": fid, "name": "corners", "r": r, "edges": vertical})
            chk = Check(fid, code="FILLET_RADIUS_TOO_LARGE", details={"max_feasible_r": _floor3(lim)}) if above else \
                Check(fid, volume=V - 4 * (1 - PI / 4) * r * r * T, bodies=1, face_types={"cylinder": 4})
        elif kind == "chamfer_top":
            lim = min(T - tol, (min(W, D) - tol) / 2)  # the walls' height, or two bevels on the top face
            above, d = self._near_limit(lim)
            fid = self.b.fid("c")
            self.b.feature({"type": "chamfer", "id": fid, "name": "top_edge", "d": d, "edges": top})
            vol = V - ((2 * W + 2 * D) * d * d / 2 - 4 * d ** 3 / 3)
            chk = Check(fid, code="CHAMFER_DISTANCE_TOO_LARGE", details={"max_feasible_d": _floor3(lim)}) if above \
                else Check(fid, volume=vol, bodies=1)
        else:
            closed = kind != "shell_open"
            inward = kind != "shell_closed_out"
            # open top: the floor reaches the opening at T, two walls meet at W/2, D/2; closed: every
            # pair of opposite walls meets halfway; outward: no limit on a box
            lim = (min(W, D, T) / 2 if closed else min(T, W / 2, D / 2)) - tol
            above, t = self._near_limit(lim) if inward else (False, _r(rng, 0.3, min(W, D, T) / 2))
            fid = self.b.fid("sh")
            s = {"type": "shell", "id": fid, "name": "hollow", "thickness": t, "body": body}
            if not closed:
                s["open"] = {"kind": "face", "q": {"op": "cap", "feature": p["eid"], "end": "end"}}
            if not inward:
                s["direction"] = "outward"
            self.b.feature(s)
            if above:
                chk = Check(fid, code="SHELL_THICKNESS_TOO_LARGE", details={"max_feasible_thickness": _floor3(lim)})
            elif not inward:
                chk = Check(fid, volume=(W + 2 * t) * (D + 2 * t) * (T + 2 * t) - V, bodies=1,
                            warnings={"SHELL_CLOSED_VOID"})
            elif closed:
                chk = Check(fid, volume=V - (W - 2 * t) * (D - 2 * t) * (T - 2 * t), bodies=1,
                            warnings={"SHELL_CLOSED_VOID"})
            else:
                chk = Check(fid, volume=V - (W - 2 * t) * (D - 2 * t) * (T - t), bodies=1, warnings=set())
        self.checks.append(chk)
        self.b.desc.append(f"blend_limits({kind}, {'above' if chk.code else 'below'})")

    def cap_blends(self) -> None:
        """A cylinder's top rim filleted (the §6.6 torus) or chamfered (the §6.7 cone): limited by
        the cap disc (R), the wall's height (H) and, for the fillet, the wall's curvature (R)."""
        rng = self.rng
        tol = consts.LINEAR_TOLERANCE
        R, H = _r(rng, 3, 20), _r(rng, 4, 30)
        sid = self.sketch("cyl_sk", "XY", [{"kind": "circle", "id": "c", "center": [0.0, 0.0], "radius": R}])
        eid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": eid, "name": "cyl", "sketch": sid, "distance": H})
        rim = {"kind": "edge", "q": {"op": "edges", "of": {"op": "cap", "feature": eid, "end": "end"}}}
        lim = min(R, H) - tol
        above, x = self._near_limit(lim)
        fillet = rng.random() < 0.5
        fid = self.b.fid("f" if fillet else "c")
        if fillet:
            self.b.feature({"type": "fillet", "id": fid, "name": "rim", "r": x, "edges": rim})
            a, rho = (1 - PI / 4) * x * x, (R - x) + x / (6 * (1 - PI / 4))  # Pappus on the spandrel
            chk = Check(fid, code="FILLET_RADIUS_TOO_LARGE", details={"max_feasible_r": _floor3(lim)}) if above else \
                Check(fid, volume=PI * R * R * H - 2 * PI * rho * a, bodies=1, face_types={"torus": 1, "bspline": 0})
        else:
            self.b.feature({"type": "chamfer", "id": fid, "name": "rim", "d": x, "edges": rim})
            chk = Check(fid, code="CHAMFER_DISTANCE_TOO_LARGE", details={"max_feasible_d": _floor3(lim)}) if above \
                else Check(fid, volume=PI * R * R * H - 2 * PI * (R - x / 3) * x * x / 2, bodies=1,
                           face_types={"cone": 1, "bspline": 0})
        self.checks.append(chk)
        self.b.desc.append(f"cap_blends({'fillet' if fillet else 'chamfer'}, {'above' if above else 'below'})")

    def concave_fillet(self) -> None:
        """The inner (concave, 270°) vertical edge of an L prism: the fillet adds `(1 − π/4)·r²·H`;
        its setback `r` on each wall is limited by the shorter inner wall."""
        rng = self.rng
        tol = consts.LINEAR_TOLERANCE
        a, b = _r(rng, 20, 60), _r(rng, 20, 60)
        c, e = _r(rng, 5, a - 5), _r(rng, 5, b - 5)
        H = _r(rng, 4, 30)
        pts = [(0.0, 0.0), (a, 0.0), (a, e), (c, e), (c, b), (0.0, b)]
        curves = [{"kind": "line", "id": f"l{k}", "start": list(pts[k]), "end": list(pts[(k + 1) % 6])} for k in range(6)]
        sid = self.sketch("ell_sk", "XY", curves)
        eid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": eid, "name": "ell", "sketch": sid, "distance": H})
        inner = {"kind": "edge", "q": {"op": "intersect", "of": [
            {"op": "edges", "of": {"op": "side", "feature": eid, "curve": "l2"}},
            {"op": "edges", "of": {"op": "side", "feature": eid, "curve": "l3"}}]}}
        lim = min(a - c, b - e) - tol
        above, r = self._near_limit(lim)
        fid = self.b.fid("f")
        self.b.feature({"type": "fillet", "id": fid, "name": "inner", "r": r, "edges": inner})
        area = a * e + c * (b - e)
        self.checks.append(Check(fid, code="FILLET_RADIUS_TOO_LARGE", details={"max_feasible_r": _floor3(lim)})
                           if above else Check(fid, volume=area * H + (1 - PI / 4) * r * r * H, bodies=1,
                                               face_types={"cylinder": 1}))
        self.b.desc.append(f"concave_fillet({'above' if above else 'below'})")

    def hole_edge_blend(self) -> None:
        """A through hole `g` from a top edge: the top face is only `g` wide across that edge there,
        so a fillet or chamfer of the two X-parallel top edges is limited by `g − tol` (§6.6: the
        narrowest width across the edge, not the face's full extent — W7b review 3)."""
        rng = self.rng
        tol = consts.LINEAR_TOLERANCE
        W, D, T = _r(rng, 30, 70), _r(rng, 24, 50), _r(rng, 6, 15)
        h, g = _r(rng, 1, D / 6), _r(rng, 0.8, 3)
        y0 = round(D / 2 - g - h, 3)
        g = D / 2 - y0 - h
        if not D - g - 2 * h > g + 1.0:
            raise _Retry
        sid = self.sketch("plate_sk", "XY", [{"kind": "rect", "id": "o", "center": [0.0, 0.0], "w": W, "h": D},
                                              {"kind": "circle", "id": "h", "center": [0.0, y0], "radius": h}])
        eid = self.b.fid("e")
        self.b.feature({"type": "extrude", "id": eid, "name": "plate", "sketch": sid, "distance": T})
        edges = {"kind": "edge", "q": {"op": "filter", "where": {"parallel": "X"},
                                       "of": {"op": "edges", "of": {"op": "cap", "feature": eid, "end": "end"}}}}
        lim = g - tol
        above, x = self._near_limit(lim)
        fillet = rng.random() < 0.5
        fid = self.b.fid("f" if fillet else "c")
        base = W * D * T - PI * h * h * T
        if fillet:
            self.b.feature({"type": "fillet", "id": fid, "name": "long_edges", "r": x, "edges": edges})
            chk = Check(fid, code="FILLET_RADIUS_TOO_LARGE", details={"max_feasible_r": _floor3(lim)}) if above else \
                Check(fid, volume=base - 2 * (1 - PI / 4) * x * x * W, bodies=1, face_types={"bspline": 0})
        else:
            self.b.feature({"type": "chamfer", "id": fid, "name": "long_edges", "d": x, "edges": edges})
            chk = Check(fid, code="CHAMFER_DISTANCE_TOO_LARGE", details={"max_feasible_d": _floor3(lim)}) if above \
                else Check(fid, volume=base - 2 * W * x * x / 2, bodies=1, face_types={"bspline": 0})
        self.checks.append(chk)
        self.b.desc.append(f"hole_edge_blend({'fillet' if fillet else 'chamfer'}, {'above' if above else 'below'})")


def _floor3(x: float) -> float:
    """§6.6's rounding of a closed-form limit: the largest multiple of 0.001 mm at most `x`
    (exact); `_Retry` when `x` lies within 1e-9 mm of a multiple, where float noise in an engine's
    width could flip the floor."""
    from fractions import Fraction

    k = Fraction(x) * 1000
    n = math.floor(k)
    if k - n < Fraction(1, 10 ** 6) or (n + 1) - k < Fraction(1, 10 ** 6):
        raise _Retry
    return max(0, n) / 1000


class _Retry(Exception):
    """A draw that would sit on a tolerance boundary (the generator retries the index)."""


GROUPS = {
    "booleans": [("flush_join", 3), ("through_cut", 3), ("split_bar", 2), ("consumed", 1), ("coaxial_corner_boss", 2),
                 ("edge_notch", 2), ("bridge_join", 2), ("tangent_cylinders", 3), ("boolean_feature", 3),
                 ("oblique_sections", 3), ("multi_intersect", 2)],
    "holes": [("holes", 1)],
    "patterns": [("linear_bosses", 3), ("circular_holes", 2), ("mirror_pocket", 2), ("body_copies", 2),
                 ("intersect_seed_pattern", 2)],
    "blends": [("fillet_vertical", 3), ("chamfer_top", 3), ("shell_box", 3), ("shell_notched", 2), ("fillet_then_shell", 2),
               ("chamfer_chain", 1), ("fillet_top", 1), ("blend_limits", 4), ("cap_blends", 2),
               ("concave_fillet", 1), ("hole_edge_blend", 2)],
}
GROUPS["ops"] = [g for k in ("booleans", "holes", "patterns", "blends") for g in GROUPS[k]]


def build(b, family: str, name: str) -> tuple[dict, list[Check]]:
    """One program of `family` on the Builder `b`: 1 group (2 for `ops` 30 % of the time — the
    groups use disjoint features, so their self-checks stay valid)."""
    ops = Ops(b)
    table = GROUPS[family]
    k = 2 if family == "ops" and b.rng.random() < 0.3 else 1
    for _ in range(k):
        total = sum(w for _, w in table)
        x = b.rng.uniform(0, total)
        for g, w in table:
            x -= w
            if x <= 0:
                break
        getattr(ops, g)()
    part = {"id": "p1", "name": "part_1", "features": b.features}
    if b.part_params:
        part["params"] = b.part_params
    doc = {"schema": "aicad.ir/1", "meta": {"name": name, "description": "; ".join(b.desc)}}
    if b.doc_params:
        doc["params"] = b.doc_params
    doc["parts"] = [part]
    return doc, ops.checks


__all__ = ["FAMILIES", "GROUPS", "Check", "Ops", "build", "_Retry"]
