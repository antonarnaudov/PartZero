"""Small 3D vector helpers and frames (SPEC-v1 §3)."""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..ir import ResolvedPlane

Vec3 = tuple[float, float, float]


def add(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def mul(a: Vec3, s: float) -> Vec3:
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a: Vec3, b: Vec3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a: Vec3, b: Vec3) -> Vec3:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(a: Vec3) -> float:
    return math.sqrt(dot(a, a))


def unit(a: Vec3) -> Vec3:
    n = norm(a)
    return (a[0] / n, a[1] / n, a[2] / n)


def dist(a: Vec3, b: Vec3) -> float:
    return norm(sub(a, b))


def sign_canonical(d: Vec3) -> Vec3:
    """§3.2: the first component with |c| > 1e-9 is made positive."""
    for c in d:
        if abs(c) > 1e-9:
            return d if c > 0 else (-d[0], -d[1], -d[2])
    return d


def angle_between(a: Vec3, b: Vec3) -> float:
    """Angle in radians between two non-zero vectors (robust near 0 and π)."""
    return math.atan2(norm(cross(a, b)), dot(a, b))


def closest_to_origin(p: Vec3, d: Vec3) -> Vec3:
    """The point of the line (p, unit d) closest to the world origin."""
    return sub(p, mul(d, dot(p, d)))


def rotate(v: Vec3, axis: Vec3, s: float, c: float) -> Vec3:
    """Rodrigues rotation of v about the unit axis by the angle with sine s and cosine c."""
    k = axis
    kxv = cross(k, v)
    kdv = dot(k, v)
    return (
        v[0] * c + kxv[0] * s + k[0] * kdv * (1.0 - c),
        v[1] * c + kxv[1] * s + k[1] * kdv * (1.0 - c),
        v[2] * c + kxv[2] * s + k[2] * kdv * (1.0 - c),
    )


@dataclass(frozen=True)
class Axis:
    """An oriented line (§3.2): origin and unit direction."""

    origin: Vec3
    direction: Vec3

    def flipped(self) -> "Axis":
        return Axis(self.origin, mul(self.direction, -1.0))


def _nz(v) -> list[float]:
    """A reported vector: `-0` is reported as `0` (§2.7 rule 8 spirit)."""
    return [0.0 if c == 0.0 else c for c in v]


def frame_dict(p: ResolvedPlane) -> dict:
    return {"origin": _nz(p.origin), "x": _nz(p.x), "y": _nz(p.y), "normal": _nz(p.normal)}


def axis_dict(a: Axis) -> dict:
    return {"origin": _nz(a.origin), "direction": _nz(a.direction)}
