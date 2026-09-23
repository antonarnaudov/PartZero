"""`migrate_v0_to_v1` (SPEC-v1 §9.1 [D-59], [W0-12]): a pure, total, deterministic function from
a valid `aicad.ir/0` document (a JSON value that passed the v0 schema and v0 validation) to an
`aicad.ir/1` document, plus the migration report of rewritten ids and names.

1. `schema` becomes `aicad.ir/1`;
2. the `sketch` field of every extrude and revolve (a sketch **name** in v0) becomes the id of the
   latest earlier sketch of the same part with that name (kept verbatim when there is none);
3. part ids and names, feature ids and names (document-wide) and curve ids (per sketch) that do
   not match the id grammar are rewritten with `sanitize` + `unique`: valid ids are reserved
   first, invalid ones are assigned in document order;
4. nothing else changes.

`jsonio.dumps_canonical(migrate(d))` must equal Forge's `to_json` byte for byte (tested on the I9
migration fixtures).
"""

from __future__ import annotations

import copy

from .consts import IR_SCHEMA, IR_SCHEMA_V0
from .ids import is_id, sanitize, unique


def _assign(items: list[str]) -> list[str | None]:
    taken = {s for s in items if is_id(s)}
    out: list[str | None] = []
    for s in items:
        if is_id(s):
            out.append(None)
        else:
            new = unique(sanitize(s), taken)
            taken.add(new)
            out.append(new)
    return out


def _f(x) -> float:
    return float(x)


def _curve(c: dict, cid: str) -> dict:
    k = c["kind"]
    if k == "line":
        return {"kind": "line", "id": cid, "start": [_f(v) for v in c["start"]], "end": [_f(v) for v in c["end"]]}
    if k == "arc":
        return {"kind": "arc", "id": cid, "start": [_f(v) for v in c["start"]], "end": [_f(v) for v in c["end"]],
                "center": [_f(v) for v in c["center"]], "ccw": bool(c["ccw"])}
    return {"kind": "circle", "id": cid, "center": [_f(v) for v in c["center"]], "radius": _f(c["radius"])}


def migrate_v0_to_v1(doc: dict) -> tuple[dict, list[dict]]:
    """Returns (v1 document, renames) where renames = [{path, kind, from, to}] in document order.
    `doc` is an `aicad.ir/1` document already: returned unchanged (idempotence)."""
    if doc.get("schema") == IR_SCHEMA:
        return copy.deepcopy(doc), []
    assert doc.get("schema") == IR_SCHEMA_V0, doc.get("schema")
    renames: list[dict] = []
    parts_in = doc["parts"]
    part_ids = _assign([p["id"] for p in parts_in])
    part_names = _assign([p["name"] for p in parts_in])
    all_feats = [f for p in parts_in for f in p["features"]]
    fids = iter(_assign([f["id"] for f in all_feats]))
    fnames = iter(_assign([f["name"] for f in all_feats]))

    def rename(path: str, kind: str, old: str, new: str | None) -> str:
        if new is None:
            return old
        renames.append({"path": path, "kind": kind, "from": old, "to": new})
        return new

    parts = []
    for pi, p in enumerate(parts_in):
        pp = f"/parts/{pi}"
        pid = rename(f"{pp}/id", "part_id", p["id"], part_ids[pi])
        pname = rename(f"{pp}/name", "part_name", p["name"], part_names[pi])
        sketch_ids: dict[str, str] = {}
        feats = []
        for fi, f in enumerate(p["features"]):
            fp = f"{pp}/features/{fi}"
            nid = rename(f"{fp}/id", "feature_id", f["id"], next(fids))
            nname = rename(f"{fp}/name", "feature_name", f["name"], next(fnames))
            t = f["type"]
            out: dict = {"type": t, "id": nid, "name": nname}
            if f.get("suppressed", False):
                out["suppressed"] = True
            if t == "sketch":
                new_cids = _assign([c["id"] for c in f["curves"]])
                curves = []
                for ci, (c, nc) in enumerate(zip(f["curves"], new_cids)):
                    cid = rename(f"{fp}/curves/{ci}/id", "curve_id", c["id"], nc)
                    curves.append(_curve(c, cid))
                pl = f["plane"]
                out["plane"] = pl if isinstance(pl, str) else {
                    "origin": [_f(v) for v in pl["origin"]], "normal": [_f(v) for v in pl["normal"]],
                    "x_dir": [_f(v) for v in pl["x_dir"]]}
                out["curves"] = curves
            else:
                out["sketch"] = sketch_ids.get(f["sketch"], f["sketch"])
                if t == "extrude":
                    out["distance"] = _f(f["distance"])
                else:
                    out["axis"] = {"origin": [_f(v) for v in f["axis"]["origin"]],
                                   "direction": [_f(v) for v in f["axis"]["direction"]]}
                    out["angle"] = _f(f["angle"])
                if f.get("direction", "normal") != "normal":
                    out["direction"] = f["direction"]
            if t == "sketch":
                sketch_ids[f["name"]] = nid
            feats.append(out)
        parts.append({"id": pid, "name": pname, "features": feats})
    v1: dict = {"schema": IR_SCHEMA}
    meta = {k: v for k, v in (doc.get("meta") or {}).items() if v != ""}
    if meta:
        v1["meta"] = meta
    units = doc.get("units")
    if units and units != {"length": "mm", "angle": "deg"}:
        v1["units"] = units
    v1["parts"] = parts
    return v1, renames
