//! Convex polytopes as intersections of half-spaces: an independent closed form of the
//! volume of a convex body chamfered with planar bevels and corners (W6 review round 3).

use forge_core::linalg::{Point3, Vec3};

/// A half-space `{x : (x − o)·n ≤ 0}`.
pub type Half = (Point3, Vec3);

/// Volume of the bounded convex polytope `∩ hs`.
pub fn polytope_volume(hs: &[Half]) -> f64 {
    // One half-space per plane (a bevel reached from both ends of its edge is listed twice).
    let mut uniq: Vec<Half> = Vec::new();
    for &(o, n) in hs {
        let n = n.normalize().expect("normal");
        if !uniq
            .iter()
            .any(|(p, m)| m.dot(n) > 1.0 - 1e-12 && (o - *p).dot(n).abs() < 1e-9)
        {
            uniq.push((o, n));
        }
    }
    let hs = &uniq[..];
    let mut verts: Vec<Point3> = Vec::new();
    let n = hs.len();
    for i in 0..n {
        for j in (i + 1)..n {
            for k in (j + 1)..n {
                let (a, b, c) = (hs[i].1, hs[j].1, hs[k].1);
                let det = a.dot(b.cross(c));
                if det.abs() < 1e-12 {
                    continue;
                }
                let (da, db, dc) = (a.dot(hs[i].0), b.dot(hs[j].0), c.dot(hs[k].0));
                let x = (b.cross(c) * da + c.cross(a) * db + a.cross(b) * dc) / det;
                if hs.iter().all(|(o, m)| (x - *o).dot(*m) <= 1e-9)
                    && !verts.iter().any(|v| v.distance(x) < 1e-9)
                {
                    verts.push(x);
                }
            }
        }
    }
    let centre = verts.iter().fold(Vec3::zero(), |s, v| s + *v) / verts.len() as f64;
    let mut vol = 0.0;
    for (o, m) in hs {
        let on: Vec<Point3> = verts
            .iter()
            .copied()
            .filter(|v| (*v - *o).dot(*m).abs() <= 1e-9)
            .collect();
        if on.len() < 3 {
            continue;
        }
        let fc = on.iter().fold(Vec3::zero(), |s, v| s + *v) / on.len() as f64;
        let u = (on[0] - fc).normalize().expect("u");
        let w = m.normalize().expect("n").cross(u);
        let mut sorted = on.clone();
        sorted.sort_by(|p, q| {
            let ap = (*p - fc).dot(w).atan2((*p - fc).dot(u));
            let aq = (*q - fc).dot(w).atan2((*q - fc).dot(u));
            ap.total_cmp(&aq)
        });
        for t in 0..sorted.len() {
            let (p, q) = (sorted[t], sorted[(t + 1) % sorted.len()]);
            vol += ((p - centre).cross(q - centre)).dot(fc - centre).abs() / 6.0;
        }
    }
    vol
}

/// The half-spaces a chamfer of distance `d` adds at a convex corner `vtx` of the polytope
/// `hs`, for its edges along `dirs` (unit, away from the vertex) whose faces are the pairs
/// `faces` (indices into `hs`): each bevel plane holds the two lines at distance `d` from its
/// edge on its faces; the corner plane holds the three points where the contact lines on each
/// face meet.
pub fn chamfer_halves(
    hs: &[Half],
    vtx: Point3,
    dirs: [Vec3; 3],
    faces: [(usize, usize); 3],
    d: f64,
) -> Vec<Half> {
    let into = |f: usize, other: usize, t: Vec3| -> Vec3 {
        let u = hs[f].1.cross(t).normalize().expect("u");
        if u.dot(hs[other].1) < 0.0 { u } else { -u }
    };
    let mut out = Vec::new();
    // Contact lines per face: (point, direction).
    let mut lines: Vec<(usize, Point3, Vec3)> = Vec::new();
    for (k, &(fa, fb)) in faces.iter().enumerate() {
        let t = dirs[k];
        let (ua, ub) = (into(fa, fb, t), into(fb, fa, t));
        let (pa, pb) = (vtx + ua * d, vtx + ub * d);
        let mut n = t.cross(pb - pa).normalize().expect("n");
        if (vtx - pa).dot(n) < 0.0 {
            n = -n;
        }
        // `n` points to the edge: keep the side away from it.
        out.push((pa, n));
        lines.push((fa, pa, t));
        lines.push((fb, pb, t));
    }
    let mut corners: Vec<Point3> = Vec::new();
    for f in [
        faces[0].0, faces[0].1, faces[1].0, faces[1].1, faces[2].0, faces[2].1,
    ] {
        if corners.len() == 3 {
            break;
        }
        let on: Vec<&(usize, Point3, Vec3)> = lines.iter().filter(|l| l.0 == f).collect();
        if on.len() != 2 {
            continue;
        }
        // Closest point of the two (coplanar) lines.
        let (p1, d1, p2, d2) = (on[0].1, on[0].2, on[1].1, on[1].2);
        let w = p1 - p2;
        let (a, b, c, dd, e) = (d1.dot(d1), d1.dot(d2), d2.dot(d2), d1.dot(w), d2.dot(w));
        let s = (b * e - c * dd) / (a * c - b * b);
        let x = p1 + d1 * s;
        if !corners.iter().any(|q| q.distance(x) < 1e-9) {
            corners.push(x);
        }
    }
    assert_eq!(corners.len(), 3);
    let mut n = (corners[1] - corners[0])
        .cross(corners[2] - corners[0])
        .normalize()
        .unwrap();
    if (vtx - corners[0]).dot(n) < 0.0 {
        n = -n;
    }
    out.push((corners[0], n));
    out
}
