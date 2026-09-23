//! Carriers, fingerprints and their comparison (SPEC-v1 §5.6, §5.7 step 4).
//!
//! The comparison is the forge-naming fingerprint comparison of spike 02
//! (`forge-naming/src/fingerprint.rs`, `compare`), which SPEC §5.7 names, ported to the v1
//! capture types: the same tolerances, the same score formula, the same "identical" rule.
//! The only difference is the length scale. forge-naming compares at
//! `max(reference.scale, cand.scale)`, each the diagonal of the owning body's box; v1 captures
//! store no scale (§5.6), so comparisons run at [`comparison_scale`]: the larger of the scope's
//! scale `s` (the diagonal of the box of every body in scope, which bounds the candidate's
//! body) and [`captured_scale`] (a lower bound of the captured body's diagonal derived from the
//! capture itself), at least 1. A body that shrank since the capture therefore keeps the
//! capture's padding, as in forge-naming; the remaining differences are that the captured
//! scale is a lower bound (exact when the captured entity reaches the body's box on every
//! axis) and that `s` covers every body of the scope, not only the candidate's.

use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::Vec3;
use forge_core::math;
use forge_ir::v1::{Carrier, Fingerprint, FingerprintType};

/// Angle (rad) within which two carrier directions are the same (forge-naming).
pub const SUPPORT_ANGLE_TOL: f64 = 1e-7;
/// Relative linear tolerance (times `max(1, s)`) within which two carriers coincide.
pub const SUPPORT_LINEAR_TOL: f64 = 1e-6;
/// SPEC-v1 §3.2: the first component with absolute value above this decides the sign of a
/// sign-canonical direction.
pub const CANONICAL_SIGN_EPS: f64 = 1e-9;

/// A direction made sign-canonical (§3.2): the first component (x, then y, then z) with
/// absolute value > 1e-9 is made positive.
pub fn sign_canonical(d: Vec3) -> Vec3 {
    let s = [d.x, d.y, d.z]
        .into_iter()
        .find(|c| c.abs() > CANONICAL_SIGN_EPS)
        .map_or(1.0, |c| if c < 0.0 { -1.0 } else { 1.0 });
    d * s
}

/// Point of the line `(p, d)` (unit `d`) closest to the world origin.
pub fn closest_to_origin(p: Vec3, d: Vec3) -> Vec3 {
    p - d * p.dot(d)
}

/// `+0.0` for `-0.0` (stable output).
pub(crate) fn clean(x: f64) -> f64 {
    x + 0.0
}

pub(crate) fn clean3(v: Vec3) -> [f64; 3] {
    [clean(v.x), clean(v.y), clean(v.z)]
}

/// Type and carrier of a face (outward normal for planes).
pub fn face_carrier(surface: &Surface, sense: bool) -> (FingerprintType, Carrier) {
    match surface {
        Surface::Plane(p) => {
            let n = if sense { p.frame().z() } else { -p.frame().z() };
            (
                FingerprintType::Plane,
                Carrier::Plane {
                    normal: clean3(n),
                    offset: clean(n.dot(p.frame().origin())),
                },
            )
        }
        Surface::Cylinder(c) => {
            let a = sign_canonical(c.frame().z());
            (
                FingerprintType::Cylinder,
                Carrier::Cylinder {
                    axis: clean3(a),
                    point: clean3(closest_to_origin(c.frame().origin(), a)),
                    radius: c.radius(),
                },
            )
        }
        Surface::Cone(c) => (
            FingerprintType::Cone,
            Carrier::Cone {
                axis: clean3(sign_canonical(c.frame().z())),
                apex: clean3(c.apex()),
                half_angle: clean(math::rad_to_deg(c.half_angle())),
            },
        ),
        Surface::Sphere(s) => (
            FingerprintType::Sphere,
            Carrier::Sphere {
                center: clean3(s.frame().origin()),
                radius: s.radius(),
            },
        ),
        Surface::Torus(t) => (
            FingerprintType::Torus,
            Carrier::Torus {
                axis: clean3(sign_canonical(t.frame().z())),
                center: clean3(t.frame().origin()),
                major: t.major(),
                minor: t.minor(),
            },
        ),
        Surface::BSpline(_) => (FingerprintType::Bspline, Carrier::Free),
    }
}

/// Type and carrier of an edge curve.
pub fn edge_carrier(curve: &Curve3) -> (FingerprintType, Carrier) {
    match curve {
        Curve3::Line(l) => {
            let d = sign_canonical(l.dir());
            (
                FingerprintType::Line,
                Carrier::Line {
                    direction: clean3(d),
                    point: clean3(closest_to_origin(l.origin(), d)),
                },
            )
        }
        Curve3::Circle(c) => (
            FingerprintType::Circle,
            Carrier::Circle {
                normal: clean3(sign_canonical(c.frame().z())),
                center: clean3(c.frame().origin()),
                radius: c.radius(),
            },
        ),
        Curve3::Ellipse(_) => (FingerprintType::Ellipse, Carrier::Free),
        Curve3::BSpline(_) => (FingerprintType::Bspline, Carrier::Free),
    }
}

fn v3(a: [f64; 3]) -> Vec3 {
    Vec3::from(a)
}

fn angle(a: Vec3, b: Vec3) -> f64 {
    math::atan2(a.cross(b).norm(), a.dot(b))
}

/// Angle between two unoriented axes, in `[0, π/2]`, sign-independent.
pub fn axis_angle(a: Vec3, b: Vec3) -> f64 {
    math::atan2(a.cross(b).norm(), a.dot(b).abs())
}

/// How far apart two carriers are: `(angle, linear offset)`; `None` for different types or
/// `free` carriers. Plane normals are oriented; other axes are compared up to sign.
pub fn support_gap(a: &Carrier, b: &Carrier) -> Option<(f64, f64)> {
    let ang = |x: &[f64; 3], y: &[f64; 3]| angle(v3(*x), v3(*y));
    let axis = |x: &[f64; 3], y: &[f64; 3]| axis_angle(v3(*x), v3(*y));
    let dist = |x: &[f64; 3], y: &[f64; 3]| v3(*x).distance(v3(*y));
    Some(match (a, b) {
        (
            Carrier::Plane {
                normal: n1,
                offset: d1,
            },
            Carrier::Plane {
                normal: n2,
                offset: d2,
            },
        ) => (ang(n1, n2), (d1 - d2).abs()),
        (
            Carrier::Cylinder {
                axis: a1,
                point: p1,
                radius: r1,
            },
            Carrier::Cylinder {
                axis: a2,
                point: p2,
                radius: r2,
            },
        ) => (axis(a1, a2), dist(p1, p2) + (r1 - r2).abs()),
        (
            Carrier::Cone {
                axis: a1,
                apex: p1,
                half_angle: h1,
            },
            Carrier::Cone {
                axis: a2,
                apex: p2,
                half_angle: h2,
            },
        ) => (
            axis(a1, a2) + math::deg_to_rad((h1 - h2).abs()),
            dist(p1, p2),
        ),
        (
            Carrier::Sphere {
                center: c1,
                radius: r1,
            },
            Carrier::Sphere {
                center: c2,
                radius: r2,
            },
        ) => (0.0, dist(c1, c2) + (r1 - r2).abs()),
        (
            Carrier::Torus {
                axis: a1,
                center: c1,
                major: m1,
                minor: n1,
            },
            Carrier::Torus {
                axis: a2,
                center: c2,
                major: m2,
                minor: n2,
            },
        ) => (
            axis(a1, a2),
            dist(c1, c2) + (m1 - m2).abs() + (n1 - n2).abs(),
        ),
        (
            Carrier::Line {
                direction: d1,
                point: p1,
            },
            Carrier::Line {
                direction: d2,
                point: p2,
            },
        ) => (axis(d1, d2), dist(p1, p2)),
        (
            Carrier::Circle {
                normal: n1,
                center: c1,
                radius: r1,
            },
            Carrier::Circle {
                normal: n2,
                center: c2,
                radius: r2,
            },
        ) => (axis(n1, n2), dist(c1, c2) + (r1 - r2).abs()),
        _ => return None,
    })
}

/// Relative part of the comparison's box padding: boxes and centroids are equal within
/// `BOX_PAD_REL · scale + BOX_PAD_ABS` (forge-naming `compare`).
pub const BOX_PAD_REL: f64 = 1e-4;
/// Absolute part of the comparison's box padding (mm), see [`BOX_PAD_REL`].
pub const BOX_PAD_ABS: f64 = 1e-6;

/// The box (and centroid) padding of [`compare`] at a comparison scale (see
/// [`comparison_scale`]).
pub fn box_pad(scale: f64) -> f64 {
    BOX_PAD_REL * scale.max(1.0) + BOX_PAD_ABS
}

/// A lower bound of the diagonal of the captured entity's body, from the capture alone: the
/// body's box is centred on `body_center` and contains the entity's `bbox`, so its half extent
/// on each axis is at least the entity box's farthest distance from that centre. Exact when the
/// entity reaches the body's box on every axis (a body fingerprint, a side face spanning the
/// body). 0 for a non-finite capture.
pub fn captured_scale(reference: &Fingerprint) -> f64 {
    let [lo, hi] = reference.bbox;
    let c = reference.body_center;
    let h2: f64 = (0..3)
        .map(|i| sq((lo[i] - c[i]).abs().max((hi[i] - c[i]).abs())))
        .sum();
    let d = 2.0 * h2.sqrt();
    if d.is_finite() { d } else { 0.0 }
}

/// The length scale [`compare`] runs at for a captured fingerprint in a scope of scale `s`:
/// `max(s, captured_scale(reference), 1)` (the forge-naming `max(reference.scale,
/// cand.scale)`, see the module docs).
pub fn comparison_scale(reference: &Fingerprint, s: f64) -> f64 {
    s.max(captured_scale(reference)).max(1.0)
}

/// `true` if two carriers coincide within the support tolerances at scale `s`.
pub fn same_support(a: &Carrier, b: &Carrier, s: f64) -> bool {
    match support_gap(a, b) {
        Some((ang, off)) => ang <= SUPPORT_ANGLE_TOL && off <= SUPPORT_LINEAR_TOL * s.max(1.0),
        None => false,
    }
}

/// How a candidate's fingerprint compares with a captured one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Comparison {
    /// Same carrier.
    pub same_support: bool,
    /// The candidate's box lies inside the captured box (padded by `1e-4·s`).
    pub contained: bool,
    /// `min(size)/max(size)` (1 when both are 0).
    pub size_ratio: f64,
    /// Relative centroid distance (world, or body-local plus body displacement).
    pub position: f64,
    /// Geometry indistinguishable from the capture: same carrier, box, size and centroid.
    pub identical: bool,
    /// Soft similarity in `[0, 1]`.
    pub score: f64,
}

fn sq(x: f64) -> f64 {
    x * x
}

/// Compare a candidate fingerprint with a captured one in a scope of scale `s` (the
/// forge-naming `compare`: `score = s_support · s_size · s_position`; different types score
/// 0), at the length scale [`comparison_scale`]`(reference, s)`.
pub fn compare(reference: &Fingerprint, cand: &Fingerprint, s: f64) -> Comparison {
    let scale = comparison_scale(reference, s);
    let same = same_support(&reference.carrier, &cand.carrier, scale);
    let pad = box_pad(scale);
    let [rmin, rmax] = reference.bbox;
    let [cmin, cmax] = cand.bbox;
    let contained = (0..3).all(|i| cmin[i] >= rmin[i] - pad && cmax[i] <= rmax[i] + pad);
    let box_equal =
        (0..3).all(|i| (cmin[i] - rmin[i]).abs() <= pad && (cmax[i] - rmax[i]).abs() <= pad);
    let size_ratio = match (reference.size > 0.0, cand.size > 0.0) {
        (true, true) => reference.size.min(cand.size) / reference.size.max(cand.size),
        (false, false) => 1.0,
        _ => 0.0,
    };
    let world_d = v3(reference.centroid).distance(v3(cand.centroid));
    let world = world_d / scale;
    let body_shift = v3(reference.body_center).distance(v3(cand.body_center)) / scale;
    let local = v3(reference.local).distance(v3(cand.local)) + body_shift;
    let position = world.min(local);
    // Vertices and bodies have a `free` carrier: "same carrier" is then the type match (a
    // vertex is its position; a body is its box, volume and centroid). Free *curves and
    // surfaces* (B-splines, ellipses) never count as the same carrier, as in forge-naming:
    // equal boxes and sizes do not make two B-splines the same shape.
    let free_same = matches!(reference.carrier, Carrier::Free)
        && matches!(cand.carrier, Carrier::Free)
        && reference.geom_type == cand.geom_type
        && matches!(
            reference.geom_type,
            FingerprintType::Vertex | FingerprintType::Body
        );
    let identical = (same || free_same) && box_equal && size_ratio >= 0.999 && world_d <= pad;
    let s_support = if same {
        1.0
    } else {
        match support_gap(&reference.carrier, &cand.carrier) {
            Some((a, o)) => math::exp(-sq(a / 0.05) - sq(o / (0.02 * scale))),
            None if matches!(reference.carrier, Carrier::Free)
                && matches!(cand.carrier, Carrier::Free) =>
            {
                1.0
            }
            None => 0.0,
        }
    };
    let s_pos = math::exp(-sq(position / 0.05));
    let score = if reference.geom_type == cand.geom_type {
        s_support * size_ratio * s_pos
    } else {
        0.0
    };
    Comparison {
        same_support: same,
        contained,
        size_ratio,
        position,
        identical,
        score,
    }
}

#[cfg(test)]
#[allow(clippy::float_cmp)] // exact expectations on purpose
mod tests {
    use super::*;

    fn fp(carrier: Carrier, size: f64, c: [f64; 3]) -> Fingerprint {
        Fingerprint {
            geom_type: FingerprintType::Plane,
            carrier,
            bbox: [
                [c[0] - 1.0, c[1] - 1.0, c[2]],
                [c[0] + 1.0, c[1] + 1.0, c[2]],
            ],
            size,
            centroid: c,
            local: [0.5; 3],
            body_center: [0.0; 3],
            neighbors: 0,
        }
    }

    #[test]
    fn sign_canonical_follows_spec_threshold() {
        assert_eq!(
            sign_canonical(Vec3::new(0.0, -1.0, 0.0)),
            Vec3::new(0.0, 1.0, 0.0)
        );
        // A first component at the 1e-9 threshold does not decide the sign.
        assert_eq!(
            sign_canonical(Vec3::new(-1e-9, -1.0, 0.0)),
            Vec3::new(1e-9, 1.0, 0.0)
        );
        assert_eq!(
            sign_canonical(Vec3::new(-2e-9, 1.0, 0.0)),
            Vec3::new(2e-9, -1.0, 0.0)
        );
    }

    #[test]
    fn identical_fingerprints_compare_identical_with_score_one() {
        let pl = Carrier::Plane {
            normal: [0.0, 0.0, 1.0],
            offset: 5.0,
        };
        let a = fp(pl.clone(), 4.0, [0.0, 0.0, 5.0]);
        let c = compare(&a, &a, 10.0);
        assert!(c.identical && c.same_support && c.contained);
        assert!((c.score - 1.0).abs() < 1e-15);
        // Moved by more than the pad (also within its body): not identical, lower score.
        let mut b = fp(pl, 4.0, [0.5, 0.0, 5.0]);
        b.local = [0.75, 0.5, 0.5];
        let c = compare(&a, &b, 10.0);
        assert!(!c.identical);
        assert!(c.score < 1.0);
        // Opposite plane: different carrier.
        let d = fp(
            Carrier::Plane {
                normal: [0.0, 0.0, -1.0],
                offset: -5.0,
            },
            4.0,
            [0.0, 0.0, 5.0],
        );
        assert!(!compare(&a, &d, 10.0).same_support);
    }

    #[test]
    fn the_captured_scale_is_the_body_diagonal_when_the_entity_spans_the_body() {
        // A body fingerprint: its box is the body's box.
        let mut b = fp(Carrier::Free, 0.0, [0.0, 0.0, 2.0]);
        b.geom_type = FingerprintType::Body;
        b.bbox = [[-20.0, -10.0, 0.0], [20.0, 10.0, 4.0]];
        b.body_center = [0.0, 0.0, 2.0];
        let diag = (40.0f64 * 40.0 + 20.0 * 20.0 + 4.0 * 4.0).sqrt();
        assert!((captured_scale(&b) - diag).abs() <= 1e-12 * diag);
        // A side face spanning the body's x and z extents at y = -10 bounds it exactly too.
        let mut f = b.clone();
        f.bbox = [[-20.0, -10.0, 0.0], [20.0, -10.0, 4.0]];
        assert!((captured_scale(&f) - diag).abs() <= 1e-12 * diag);
        // Never below the scope's scale, never below 1; non-finite captures add nothing.
        assert_eq!(comparison_scale(&f, 1e3), 1e3);
        assert_eq!(comparison_scale(&f, 0.0), captured_scale(&f));
        let mut nan = f.clone();
        nan.body_center = [f64::NAN; 3];
        assert_eq!(captured_scale(&nan), 0.0);
        assert_eq!(comparison_scale(&nan, 0.5), 1.0);
    }

    /// A body that shrank since the capture keeps the capture's padding (forge-naming compares
    /// at the larger of the two bodies' scales): a centroid 0.005 away is identical at the
    /// captured scale 100 (pad ≈ 0.01), not at the shrunken scope's scale 10 (pad ≈ 0.001).
    #[test]
    fn a_shrunken_scope_compares_at_the_captured_scale() {
        let pl = Carrier::Plane {
            normal: [0.0, 0.0, 1.0],
            offset: 5.0,
        };
        let mut a = fp(pl, 4.0, [0.0, 0.0, 5.0]);
        // The captured entity reaches its body's box (centred on the origin, diagonal 100) on
        // every axis.
        let big = 100.0;
        a.body_center = [0.0; 3];
        a.bbox = [[-big / 2.0 / 3f64.sqrt(); 3], [big / 2.0 / 3f64.sqrt(); 3]];
        let s_cap = captured_scale(&a);
        assert!((s_cap - big).abs() <= 1e-9, "{s_cap}");
        let mut b = a.clone();
        for i in 0..3 {
            b.bbox[0][i] += 0.005 / 3f64.sqrt();
            b.bbox[1][i] += 0.005 / 3f64.sqrt();
            b.centroid[i] += 0.005 / 3f64.sqrt();
        }
        assert!(box_pad(big) > 0.005 && box_pad(10.0) < 0.005);
        assert!(compare(&a, &b, 10.0).identical);
        assert!(compare(&a, &b, big).identical);
        // Without the captured bound the comparison at 10 would not be identical.
        let mut unbounded = a.clone();
        unbounded.bbox = [[0.0; 3], [0.0; 3]];
        unbounded.body_center = [0.0; 3];
        let mut ub = unbounded.clone();
        ub.centroid = b.centroid;
        assert!(!compare(&unbounded, &ub, 10.0).identical);
    }

    #[test]
    fn different_types_score_zero() {
        let a = fp(
            Carrier::Plane {
                normal: [0.0, 0.0, 1.0],
                offset: 0.0,
            },
            1.0,
            [0.0; 3],
        );
        let mut b = a.clone();
        b.geom_type = FingerprintType::Cylinder;
        assert_eq!(compare(&a, &b, 1.0).score, 0.0);
    }

    #[test]
    fn cone_half_angles_are_compared_in_radians() {
        let c1 = Carrier::Cone {
            axis: [0.0, 0.0, 1.0],
            apex: [0.0; 3],
            half_angle: 30.0,
        };
        let c2 = Carrier::Cone {
            axis: [0.0, 0.0, 1.0],
            apex: [0.0; 3],
            half_angle: 30.0 + 1e-6,
        };
        let (a, _) = support_gap(&c1, &c2).expect("same type");
        assert!((a - math::deg_to_rad(1e-6)).abs() < 1e-15);
        assert!(same_support(&c1, &c2, 1.0));
    }
}
