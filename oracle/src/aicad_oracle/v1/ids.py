"""The id grammar of SPEC-v1 §0.3 [W0-12]: `[A-Za-z_][A-Za-z0-9_]*`, 1 to 64 bytes.

References to ids are 1 to 3 ids joined by `.`. A string that fails the grammar is never echoed
in a message or in details (`shown`).
"""

from __future__ import annotations

from .consts import MAX_ID_LEN, MAX_REF_SEGMENTS


def _id_char(c: str) -> bool:
    return c == "_" or ("a" <= c <= "z") or ("A" <= c <= "Z") or ("0" <= c <= "9")


def check_id(s: str) -> str | None:
    """None when `s` is an id, else the reason: `empty`, `charset` or `too-long`."""
    if s == "":
        return "empty"
    c0 = s[0]
    if not (c0 == "_" or ("a" <= c0 <= "z") or ("A" <= c0 <= "Z")) or not all(_id_char(c) for c in s):
        return "charset"
    if len(s.encode("utf-8")) > MAX_ID_LEN:
        return "too-long"
    return None


def is_id(s: str) -> bool:
    return check_id(s) is None


def check_ref(s: str) -> str | None:
    """None when `s` is 1 to 3 ids joined by `.`."""
    if s == "":
        return "empty"
    segs = s.split(".")
    if len(segs) > MAX_REF_SEGMENTS:
        return "charset"
    for seg in segs:
        why = check_id(seg)
        if why is not None:
            return why
    return None


def is_ref(s: str) -> bool:
    return check_ref(s) is None


def shown(s: str) -> str:
    """What messages may show of a string: itself if it is a valid reference."""
    return s if isinstance(s, str) and is_ref(s) else "<invalid id>"


def byte_len(s: str) -> int:
    return len(s.encode("utf-8"))


def sanitize(s: str) -> str:
    """[W0-12] migration rewrite: non-`[A-Za-z0-9_]` characters become `_`; a `_` prefix for an
    empty result or a leading digit; cut to 64 bytes (the result is ASCII)."""
    t = "".join(c if _id_char(c) else "_" for c in s)
    if t == "" or ("0" <= t[0] <= "9"):
        t = "_" + t
    return t[:MAX_ID_LEN]


def unique(base: str, taken: set[str]) -> str:
    """`base` if free, else the first free `base_2`, `base_3`, ... (base cut to stay <= 64)."""
    if base not in taken:
        return base
    k = 2
    while True:
        suffix = f"_{k}"
        cand = base[: MAX_ID_LEN - len(suffix)] + suffix
        if cand not in taken:
            return cand
        k += 1
