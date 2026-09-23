//! Near-coincident faces: SPEC [R-3] (review rounds 3 and 4).
//!
//! SPEC [R-3] makes faces within `LINEAR_TOLERANCE` coincident and faces farther apart
//! distinct. Before any intersection, every pair of **aligned** faces of the two operands
//! (parallel planes; cylinders, cones and tori with parallel axes; spheres) that overlap is
//! classified by the offset `d` of their surfaces:
//!
//! | `d` | Outcome |
//! |---|---|
//! | `≤ COINCIDENT_OFFSET` (1e-8 mm) | coincident as they are (the SSI's coincidence snap) |
//! | `(COINCIDENT_OFFSET, LINEAR_TOLERANCE]` | coincident: operand B is **translated** onto A ([`snap`]) |
//! | `> LINEAR_TOLERANCE` | distinct geometry |
//!
//! The snap is one translation `T` of B, `|T| ≤ √3·tol`, that makes every such pair
//! exactly coincident and keeps the pairs already coincident so: the least-squares
//! (minimum-norm) solution of the pairs' linear conditions (a plane pins `T` along its
//! normal, a cylinder across its axis, a sphere, cone or torus completely), accepted only
//! when it meets every condition. B's geometry moves by less than the tolerance, as [R-3]
//! allows; A (the target side of every two-solid step) never moves. When no translation
//! does it — faces that differ in radius or angle (coaxial cylinders of radii `r` and
//! `r + 5e-7`), or conditions that conflict — the operation is
//! `FORGE_BOOLEAN_NEAR_COINCIDENT` with the reason.
//!
//! Faces a little more than the tolerance apart are computed as distinct geometry. Where
//! the boolean then cannot separate them — two curves on one face closer than
//! `DISTINCT_OFFSET` (1e-5 mm), or a consistency check failing for faces that stay within
//! `DISTINCT_OFFSET` of each other over their overlap (aligned faces 1e-6 to 1e-5 mm apart,
//! planes crossing at an angle so small that they never part by more than that) — the
//! failure is reported as `FORGE_BOOLEAN_NEAR_COINCIDENT` with the measured largest
//! separation over the overlap ([`explain`]): one code for these configurations, whatever
//! the surface type and the operation.

use forge_core::geom::Surface;
use forge_core::linalg::{Point2, Point3, Vec3};
use forge_core::math;

use super::error::BooleanError;
use super::geom::uv_near;
use super::intersect::{Loc, VTOL, locate};
use super::model::Model;

/// Faces whose surfaces are at most this far apart are coincident as they are: the SSI's
/// coincidence snap (`0.1 × SsiTolerance::fit`).
pub(crate) const COINCIDENT_OFFSET: f64 = 1e-8;
/// Aligned faces up to this far apart are coincident (SPEC [R-3]); B is snapped onto A.
pub(crate) const SNAP_OFFSET: f64 = VTOL;
/// Distinct faces closer than this (ten times the linear tolerance) may be beyond what the
/// boolean can separate: its failures there are reported as near-coincident faces.
pub(crate) const DISTINCT_OFFSET: f64 = 10.0 * VTOL;

/// Directions parallel (or anti-parallel) within the angular tolerance: the sine of the
/// angle between them.
fn parallel(a: Vec3, b: Vec3) -> Option<f64> {
    let s = a.cross(b).norm();
    (s <= 1e-9).then_some(s)
}

/// Two unit vectors orthogonal to the unit vector `z`.
fn basis_perp(z: Vec3) -> (Vec3, Vec3) {
    let a = if z.x.abs() < 0.6 {
        Vec3::new(1.0, 0.0, 0.0)
    } else {
        Vec3::new(0.0, 1.0, 0.0)
    };
    let e1 = (a - z * a.dot(z))
        .normalize()
        .unwrap_or(Vec3::new(0.0, 0.0, 1.0));
    (e1, z.cross(e1))
}

/// The linear conditions `n · T = b` under which face surface `b` translated by `T`
/// coincides with `a`, and what no translation can fix (differences of radius or angle and
/// the tilt over a region of size `size`, mm). `None` when the surfaces are not aligned.
fn conditions(a: &Surface, b: &Surface, size: f64) -> Option<(Vec<(Vec3, f64)>, f64)> {
    let xyz = [
        Vec3::new(1.0, 0.0, 0.0),
        Vec3::new(0.0, 1.0, 0.0),
        Vec3::new(0.0, 0.0, 1.0),
    ];
    let all = |d: Vec3| xyz.iter().map(|&e| (e, -e.dot(d))).collect::<Vec<_>>();
    match (a, b) {
        (Surface::Plane(x), Surface::Plane(y)) => {
            let s = parallel(x.frame().z(), y.frame().z())?;
            let n = x.frame().z();
            let rhs = -n.dot(y.frame().origin() - x.frame().origin());
            Some((vec![(n, rhs)], s * size))
        }
        (Surface::Cylinder(x), Surface::Cylinder(y)) => {
            let s = parallel(x.frame().z(), y.frame().z())?;
            let z = x.frame().z();
            let d = y.frame().origin() - x.frame().origin();
            let w = d - z * d.dot(z);
            let (e1, e2) = basis_perp(z);
            Some((
                vec![(e1, -e1.dot(w)), (e2, -e2.dot(w))],
                (x.radius() - y.radius()).abs() + s * size,
            ))
        }
        (Surface::Sphere(x), Surface::Sphere(y)) => Some((
            all(y.frame().origin() - x.frame().origin()),
            (x.radius() - y.radius()).abs(),
        )),
        (Surface::Cone(x), Surface::Cone(y)) => {
            let s = parallel(x.frame().z(), y.frame().z())?;
            // Same opening direction along the common axis (frame z points to the widening
            // side).
            if x.frame().z().dot(y.frame().z()) <= 0.0 {
                return None;
            }
            Some((
                all(y.apex() - x.apex()),
                (x.half_angle() - y.half_angle()).abs() * size + s * size,
            ))
        }
        (Surface::Torus(x), Surface::Torus(y)) => {
            let s = parallel(x.frame().z(), y.frame().z())?;
            Some((
                all(y.frame().origin() - x.frame().origin()),
                (x.major() - y.major()).abs() + (x.minor() - y.minor()).abs() + s * size,
            ))
        }
        _ => None,
    }
}

/// A near-tangent contact of two surfaces that are not aligned: the translation condition
/// `u · T = rhs` that makes surface `b` translated by `T` exactly tangent to `a`, the signed
/// gap (negative: they overlap by that much; positive: they clear by it), and points of the
/// contact on `a` (a generator line, or one point) to test against the faces.
struct Tangency {
    u: Vec3,
    rhs: f64,
    gap: f64,
    contact: Vec<Point3>,
}

/// Plane–cylinder (axis parallel to the plane), plane–sphere, sphere–sphere,
/// cylinder–cylinder (parallel axes), sphere–cylinder tangencies, external or internal;
/// `extent` bounds the contact line's samples along a cylinder axis.
fn tangency(a: &Surface, b: &Surface, extent: f64) -> Option<Tangency> {
    let line = |p: Point3, z: Vec3| -> Vec<Point3> {
        (-8..=8)
            .map(|k| p + z * (extent * k as f64 / 8.0))
            .collect()
    };
    let sgn = |x: f64| if x >= 0.0 { 1.0 } else { -1.0 };
    // (gap, sign of the direction the contact lies in) of two radii at distance `dist`:
    // external or internal tangency, whichever gap is smaller.
    let pick = |dist: f64, ra: f64, rb: f64| -> (f64, bool) {
        let (ge, gi) = (dist - (ra + rb), dist - (ra - rb).abs());
        if ge.abs() <= gi.abs() {
            (ge, true)
        } else {
            (gi, false)
        }
    };
    match (a, b) {
        (Surface::Plane(p), Surface::Cylinder(c)) | (Surface::Cylinder(c), Surface::Plane(p)) => {
            let n = p.frame().z();
            let z = c.frame().z();
            if z.dot(n).abs() > 1e-9 {
                return None;
            }
            let s = n.dot(c.frame().origin() - p.frame().origin());
            let gap = s.abs() - c.radius();
            let on_plane = c.frame().origin() - n * (sgn(s) * c.radius());
            let rhs = if matches!(a, Surface::Plane(_)) {
                -sgn(s) * gap
            } else {
                sgn(s) * gap
            };
            Some(Tangency {
                u: n,
                rhs,
                gap,
                contact: line(on_plane, z),
            })
        }
        (Surface::Plane(p), Surface::Sphere(q)) | (Surface::Sphere(q), Surface::Plane(p)) => {
            let n = p.frame().z();
            let s = n.dot(q.frame().origin() - p.frame().origin());
            let gap = s.abs() - q.radius();
            let rhs = if matches!(a, Surface::Plane(_)) {
                -sgn(s) * gap
            } else {
                sgn(s) * gap
            };
            Some(Tangency {
                u: n,
                rhs,
                gap,
                contact: vec![q.frame().origin() - n * (sgn(s) * q.radius())],
            })
        }
        (Surface::Sphere(x), Surface::Sphere(y)) => {
            let d = y.frame().origin() - x.frame().origin();
            let dist = d.norm();
            let u = d.normalize()?;
            if dist <= 1e-9 {
                return None;
            }
            let (gap, external) = pick(dist, x.radius(), y.radius());
            // The contact on `a` towards `b` (external, or `b` inside `a`), or away from it
            // (`a` inside `b`).
            let dir = if external || x.radius() >= y.radius() {
                u
            } else {
                -u
            };
            Some(Tangency {
                u,
                rhs: -gap,
                gap,
                contact: vec![x.frame().origin() + dir * x.radius()],
            })
        }
        (Surface::Cylinder(x), Surface::Cylinder(y)) => {
            let z = x.frame().z();
            parallel(z, y.frame().z())?;
            let d = y.frame().origin() - x.frame().origin();
            let w = d - z * d.dot(z);
            let dist = w.norm();
            if dist <= 1e-9 {
                return None;
            }
            let u = w.normalize()?;
            let (gap, external) = pick(dist, x.radius(), y.radius());
            let dir = if external || x.radius() >= y.radius() {
                u
            } else {
                -u
            };
            Some(Tangency {
                u,
                rhs: -gap,
                gap,
                contact: line(x.frame().origin() + dir * x.radius(), z),
            })
        }
        (Surface::Cylinder(c), Surface::Sphere(q)) | (Surface::Sphere(q), Surface::Cylinder(c)) => {
            let z = c.frame().z();
            let d = q.frame().origin() - c.frame().origin();
            let w = d - z * d.dot(z);
            let dist = w.norm();
            if dist <= 1e-9 {
                return None;
            }
            let u = w.normalize()?;
            let (gap, external) = pick(dist, c.radius(), q.radius());
            // The contact on the sphere: towards the axis (outside the cylinder), or away
            // from it (inside).
            let contact =
                q.frame().origin() + u * (if external { -q.radius() } else { q.radius() });
            let rhs = if matches!(a, Surface::Cylinder(_)) {
                -gap
            } else {
                gap
            };
            Some(Tangency {
                u,
                rhs,
                gap,
                contact: vec![contact],
            })
        }
        _ => None,
    }
}

/// Whether some point of the contact lies in (or on the boundary of) both faces `f` and `g`.
fn contact_in_faces(m: &Model, f: usize, g: usize, contact: &[Point3]) -> Option<Point3> {
    contact.iter().copied().find(|&p| {
        [f, g].into_iter().all(|k| {
            let s = &m.faces[k].surface;
            let uv = uv_near(s, p, None);
            locate(m, k, s.eval(uv.x, uv.y), uv) != Loc::Out
        })
    })
}

/// Offset of two aligned surfaces: the translation they need plus what it cannot fix.
fn offset_of(conds: &[(Vec3, f64)], mismatch: f64) -> f64 {
    let mut t = Vec3::zero();
    // The conditions of one pair are orthonormal: their right-hand sides are the
    // components of the needed translation.
    for (n, b) in conds {
        t += *n * *b;
    }
    t.norm() + mismatch
}

/// Sample points of face `fi`: inside points of a 9 × 9 grid of its parameter box and the
/// middles of its edges.
fn samples(m: &Model, fi: usize) -> Vec<Point3> {
    let f = &m.faces[fi];
    let mut out = Vec::new();
    let (u, v) = f.chart.uv_box();
    let n = 8;
    for i in 0..=n {
        for j in 0..=n {
            let uv = Point2::new(
                u.0 + (u.1 - u.0) * (i as f64 + 0.5) / (n as f64 + 1.0),
                v.0 + (v.1 - v.0) * (j as f64 + 0.5) / (n as f64 + 1.0),
            );
            if f.chart.contains(uv) == Some(true) {
                out.push(f.surface.eval(uv.x, uv.y));
            }
        }
    }
    for ei in f.edges() {
        let e = &m.edges[ei];
        out.push(e.curve.eval(0.5 * (e.range.0 + e.range.1)));
    }
    out
}

/// Samples of face `f` lying within `reach` of face `g` (projecting inside it or onto its
/// boundary), with their distances to `g`'s surface.
fn overlap(m: &Model, f: usize, g: usize, reach: f64) -> Vec<(Point3, f64)> {
    let gs = &m.faces[g].surface;
    let mut out = Vec::new();
    for p in samples(m, f) {
        let (_, _, d) = gs.project(p);
        if d > reach {
            continue;
        }
        let uv = uv_near(gs, p, None);
        let q = gs.eval(uv.x, uv.y);
        if locate(m, g, q, uv) != Loc::Out {
            out.push((p, d));
        }
    }
    out
}

/// A sample of face `f` lying within `reach` of face `g`, if any.
fn overlap_point(m: &Model, f: usize, g: usize, reach: f64) -> Option<Point3> {
    overlap(m, f, g, reach).first().map(|x| x.0)
}

fn pair_name(m: &Model, f: usize, g: usize) -> String {
    format!("{} × {}", m.faces[f].prov.name(), m.faces[g].prov.name())
}

/// The translation of operand B that makes every aligned, overlapping pair of faces offset
/// by at most [`SNAP_OFFSET`] exactly coincident (see the module docs); `None` when no pair
/// needs it. `FORGE_BOOLEAN_NEAR_COINCIDENT` when no translation does it.
pub(crate) fn snap(m: &Model) -> Result<Option<Vec3>, BooleanError> {
    // (condition, pair)
    let mut rows: Vec<(Vec3, f64, usize, usize)> = Vec::new();
    let mut need: Option<(usize, usize, f64)> = None;
    for fi in m.faces_of(0) {
        let f = &m.faces[fi];
        for gi in m.faces_of(1) {
            let g = &m.faces[gi];
            if !f.bbox.grown(DISTINCT_OFFSET).overlaps(&g.bbox) {
                continue;
            }
            let size = f.bbox.diag().max(g.bbox.diag());
            let aligned = conditions(&f.surface, &g.surface, size).filter(|(conds, mismatch)| {
                offset_of(conds, *mismatch) <= SNAP_OFFSET * (1.0 + 1e-9)
            });
            let Some((conds, mismatch)) = aligned else {
                // A near-tangent contact within the tolerance (surfaces not coincident: two
                // spheres or parallel cylinders touching count too): made exactly tangent
                // (it clears or overlaps by at most the tolerance: SPEC [R-3], a contact).
                if let Some(tg) = tangency(&f.surface, &g.surface, size)
                    && tg.gap.abs() <= SNAP_OFFSET * (1.0 + 1e-9)
                    && contact_in_faces(m, fi, gi, &tg.contact).is_some()
                {
                    if tg.gap.abs() > 1e-12 * (1.0 + size)
                        && need.is_none_or(|x| tg.gap.abs() > x.2)
                    {
                        need = Some((fi, gi, tg.gap.abs()));
                    }
                    rows.push((tg.u, tg.rhs, fi, gi));
                }
                continue;
            };
            let d = offset_of(&conds, mismatch);
            let Some(p) = overlap_point(m, fi, gi, DISTINCT_OFFSET)
                .or_else(|| overlap_point(m, gi, fi, DISTINCT_OFFSET))
            else {
                continue;
            };
            if mismatch > COINCIDENT_OFFSET {
                return Err(BooleanError::NearCoincident {
                    entities: pair_name(m, fi, gi),
                    offset: d,
                    limit: DISTINCT_OFFSET,
                    point: p.to_array(),
                    reason: format!(
                        "coincident within the linear tolerance but different in radius, angle or direction by {mismatch:.3e} mm: no translation makes them one surface"
                    ),
                });
            }
            if d > COINCIDENT_OFFSET && need.is_none_or(|x| d > x.2) {
                need = Some((fi, gi, d));
            }
            for (n, b) in conds {
                rows.push((n, b, fi, gi));
            }
        }
    }
    let Some((nf, ng, nd)) = need else {
        return Ok(None);
    };
    let t = min_norm_solution(&rows);
    // Every condition met (pairs already coincident stay so), within the snap itself.
    for &(n, b, fi, gi) in &rows {
        let r = (n.dot(t) - b).abs();
        if r > 0.5 * COINCIDENT_OFFSET {
            let p = overlap_point(m, fi, gi, DISTINCT_OFFSET).unwrap_or(Vec3::zero());
            return Err(BooleanError::NearCoincident {
                entities: pair_name(m, fi, gi),
                offset: offset_of(&[(n, b)], 0.0),
                limit: DISTINCT_OFFSET,
                point: p.to_array(),
                reason: format!(
                    "coincident within the linear tolerance, but the translation that makes them one surface conflicts with other coincident faces (residual {r:.3e} mm)"
                ),
            });
        }
    }
    if t.norm() > SNAP_OFFSET * 3f64.sqrt() * (1.0 + 1e-9) {
        let p = overlap_point(m, nf, ng, DISTINCT_OFFSET).unwrap_or(Vec3::zero());
        return Err(BooleanError::NearCoincident {
            entities: pair_name(m, nf, ng),
            offset: nd,
            limit: DISTINCT_OFFSET,
            point: p.to_array(),
            reason: format!(
                "coincident within the linear tolerance, but making them one surface moves the tool by {:.3e} mm",
                t.norm()
            ),
        });
    }
    Ok(Some(t))
}

/// Minimum-norm least-squares solution of `n_i · T = b_i` (Jacobi eigen-decomposition of
/// the 3 × 3 normal matrix; deterministic).
fn min_norm_solution(rows: &[(Vec3, f64, usize, usize)]) -> Vec3 {
    let mut a = [[0.0f64; 3]; 3];
    let mut rhs = [0.0f64; 3];
    for (n, b, _, _) in rows {
        let v = [n.x, n.y, n.z];
        for i in 0..3 {
            for j in 0..3 {
                a[i][j] += v[i] * v[j];
            }
            rhs[i] += v[i] * b;
        }
    }
    let mut vecs = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _ in 0..64 {
        let mut off = 0.0;
        for (p, q) in [(0, 1), (0, 2), (1, 2)] {
            off += a[p][q] * a[p][q];
            if a[p][q].abs() <= 1e-300 {
                continue;
            }
            let theta = 0.5 * math::atan2(2.0 * a[p][q], a[q][q] - a[p][p]);
            let (s, c) = math::sin_cos(theta);
            for row in a.iter_mut() {
                let (akp, akq) = (row[p], row[q]);
                row[p] = c * akp - s * akq;
                row[q] = s * akp + c * akq;
            }
            let (lo, hi) = a.split_at_mut(q);
            for (x, y) in lo[p].iter_mut().zip(hi[0].iter_mut()) {
                let (apk, aqk) = (*x, *y);
                *x = c * apk - s * aqk;
                *y = s * apk + c * aqk;
            }
            for v in &mut vecs {
                let (vp, vq) = (v[p], v[q]);
                v[p] = c * vp - s * vq;
                v[q] = s * vp + c * vq;
            }
        }
        if off <= 1e-30 {
            break;
        }
    }
    // Columns of the rotation are the eigenvectors: vecs[k][i] is component k of vector i.
    let lmax = (0..3).map(|i| a[i][i].abs()).fold(0.0, f64::max);
    let mut t = [0.0f64; 3];
    for i in 0..3 {
        let l = a[i][i];
        if l <= 1e-12 * lmax.max(f64::MIN_POSITIVE) {
            continue;
        }
        let e = [vecs[0][i], vecs[1][i], vecs[2][i]];
        let c = (e[0] * rhs[0] + e[1] * rhs[1] + e[2] * rhs[2]) / l;
        for k in 0..3 {
            t[k] += c * e[k];
        }
    }
    Vec3::new(t[0], t[1], t[2])
}

/// `FORGE_BOOLEAN_NEAR_COINCIDENT` for the first pair of faces of the two operands (in
/// face order) that are aligned, offset by more than [`COINCIDENT_OFFSET`] and at most
/// [`SNAP_OFFSET`], and overlap: a pair [`snap`] should have made coincident.
pub(crate) fn check(m: &Model) -> Result<(), BooleanError> {
    for fi in m.faces_of(0) {
        let f = &m.faces[fi];
        for gi in m.faces_of(1) {
            let g = &m.faces[gi];
            if !f.bbox.grown(DISTINCT_OFFSET).overlaps(&g.bbox) {
                continue;
            }
            let size = f.bbox.diag().max(g.bbox.diag());
            let Some((conds, mismatch)) = conditions(&f.surface, &g.surface, size) else {
                continue;
            };
            let d = offset_of(&conds, mismatch);
            if d <= COINCIDENT_OFFSET || d > SNAP_OFFSET * (1.0 + 1e-9) {
                continue;
            }
            let hit = overlap_point(m, fi, gi, DISTINCT_OFFSET)
                .or_else(|| overlap_point(m, gi, fi, DISTINCT_OFFSET));
            if let Some(p) = hit {
                return Err(BooleanError::NearCoincident {
                    entities: pair_name(m, fi, gi),
                    offset: d,
                    limit: DISTINCT_OFFSET,
                    point: p.to_array(),
                    reason: "coincident within the linear tolerance after the snap".into(),
                });
            }
        }
    }
    Ok(())
}

/// Separation of faces `f` and `g` over their overlap, sampled on both faces: the largest
/// distance from a sample of one face that projects inside the other face to that face's
/// surface, the sine of the largest angle between their normals at those samples, and the
/// sample where the separation is largest; `None` when no sample of either face projects
/// inside the other within `DISTINCT_OFFSET` (they do not overlap).
pub(crate) fn separation(m: &Model, f: usize, g: usize) -> Option<(f64, f64, Point3)> {
    let over = |a: usize, b: usize| -> Vec<(Point3, f64)> { overlap(m, a, b, f64::INFINITY) };
    let hits: Vec<(Point3, f64)> = over(f, g).into_iter().chain(over(g, f)).collect();
    if !hits.iter().any(|x| x.1 <= DISTINCT_OFFSET) {
        return None;
    }
    let (fs, gs) = (&m.faces[f].surface, &m.faces[g].surface);
    let mut worst: (f64, Point3) = (0.0, hits[0].0);
    let mut angle: f64 = 0.0;
    for &(p, d) in &hits {
        if d > worst.0 {
            worst = (d, p);
        }
        let (u1, v1, _) = fs.project(p);
        let (u2, v2, _) = gs.project(p);
        if let (Some(n1), Some(n2)) = (fs.normal(u1, v1), gs.normal(u2, v2)) {
            angle = angle.max(n1.cross(n2).norm());
        }
    }
    Some((worst.0, angle, worst.1))
}

/// The explanation of a failure `err` of the boolean on `m` (an internal consistency check,
/// an invalid result): when two faces of the operands stay within `DISTINCT_OFFSET` of each
/// other over their whole overlap (and are not coincident), the failure follows from faces
/// the boolean cannot separate: `FORGE_BOOLEAN_NEAR_COINCIDENT` with the largest
/// separation over the overlap (and the angle when they cross); otherwise `err`.
pub(crate) fn explain(m: &Model, err: BooleanError) -> BooleanError {
    if !matches!(
        err,
        BooleanError::Inconsistent { .. } | BooleanError::InvalidResult { .. }
    ) {
        return err;
    }
    let mut best: Option<(f64, f64, Point3, usize, usize)> = None;
    let mut tangent: Option<(f64, Point3, usize, usize)> = None;
    for fi in m.faces_of(0) {
        let f = &m.faces[fi];
        for gi in m.faces_of(1) {
            let g = &m.faces[gi];
            if !f.bbox.grown(DISTINCT_OFFSET).overlaps(&g.bbox) {
                continue;
            }
            // A near-tangent contact (surfaces that touch, or cross or clear by less than
            // the reach).
            let size = f.bbox.diag().max(g.bbox.diag());
            // (Exact tangency, which the intersection handles, never explains a failure; the
            // snap has made every contact within the tolerance exact.)
            if let Some(tg) = tangency(&f.surface, &g.surface, size)
                && tg.gap.abs() < DISTINCT_OFFSET
                && tg.gap.abs() > COINCIDENT_OFFSET
                && let Some(p) = contact_in_faces(m, fi, gi, &tg.contact)
                && tangent.is_none_or(|t: (f64, Point3, usize, usize)| tg.gap.abs() > t.0)
            {
                tangent = Some((tg.gap.abs(), p, fi, gi));
            }
            let Some((sep, angle, p)) = separation(m, fi, gi) else {
                continue;
            };
            // Within the reach over the whole overlap, and not coincident.
            if sep > DISTINCT_OFFSET || sep <= COINCIDENT_OFFSET {
                continue;
            }
            if best.is_none_or(|b| sep > b.0) {
                best = Some((sep, angle, p, fi, gi));
            }
        }
    }
    let Some((sep, angle, p, fi, gi)) = best else {
        let Some((gap, p, fi, gi)) = tangent else {
            return err;
        };
        return BooleanError::NearCoincident {
            entities: pair_name(m, fi, gi),
            offset: gap,
            limit: DISTINCT_OFFSET,
            point: p.to_array(),
            reason: format!(
                "a near-tangent contact: the surfaces touch within {gap:.3e} mm, closer than the boolean can separate ({})",
                err.code()
            ),
        };
    };
    BooleanError::NearCoincident {
        entities: pair_name(m, fi, gi),
        offset: sep,
        limit: DISTINCT_OFFSET,
        point: p.to_array(),
        reason: if angle > 1e-9 {
            format!(
                "they cross at {:.3e} rad and never part by more than {DISTINCT_OFFSET:e} mm over their overlap; the boolean cannot separate them ({})",
                math::asin(angle.min(1.0)),
                err.code()
            )
        } else {
            format!(
                "distinct, but closer than the boolean can separate ({})",
                err.code()
            )
        },
    }
}
