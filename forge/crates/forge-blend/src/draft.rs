//! Draft (SPEC-v1 §6.9) by direct construction, on planar faces between planar faces.
//!
//! Each drafted face `F` (planar, outward normal `n` perpendicular to the pull direction `p`
//! within `QUERY_ANGLE_TOLERANCE`) is replaced by the plane through the line where `F`'s plane
//! meets the neutral plane, with normal `cos(a)·n + sin(a)·p`: the part tapers inward along `+p`.
//! The body keeps its topology: every vertex of a drafted face moves to the point where its
//! faces' planes (the new ones for drafted faces) meet, every edge with a moved vertex is the
//! line through its new vertices. Faces and edges keep their keys (§5.2: drafted faces are
//! modified, not created).
//!
//! Supported: drafted faces and every face around their vertices planar (the edges there are
//! lines), vertices where exactly the faces around them meet in one point (three faces, or
//! more that still meet). Anything else is `DRAFT_FAILED` naming what is not supported — a
//! drafted wall next to a cylinder (a filleted corner: draft before filleting) or with a hole
//! in it. The engine never guesses.
//!
//! Checks (never a silently wrong body): an edge that collapses or turns over, a face
//! boundary that meets itself ([`crate::check::face_crossings_ex`], certified) and a changed
//! face that meets another face away from what they share ([`crate::interfere`], certified;
//! what cannot be certified is `DRAFT_FAILED` too), then forge-check's validation and a
//! positive volume, and the strict degenerate-loop rule on every loop (the caps' loops moved
//! with their keys, so the sketch-region relaxation no longer applies to them).

use std::collections::{BTreeMap, BTreeSet};

use forge_core::geom::{Curve3, Line3, Plane, Surface};
use forge_core::linalg::{Point3, Vec3};
use forge_core::topo::{
    Body, EntityRef, FaceId, Severity, ValidateOptions, parse_key, validate_with,
};
use forge_ir::v1::{LINEAR_TOLERANCE, QUERY_ANGLE_TOLERANCE};

use crate::error::{BlendError, DraftFaceReason, Named, UnsupportedFace};
use crate::keys::{KeyMap, Pick};
use crate::plan::Plan;

/// Draft options.
#[derive(Clone, Debug)]
pub struct DraftOptions {
    /// The feature id (messages; drafted entities keep their keys).
    pub feature: String,
    /// Keys and display names of the input's entities (derived from provenance for those it
    /// does not name).
    pub keys: Option<KeyMap>,
    /// Index of the body drafted, in the numbering of the faces' [`Pick::body`] (default 0).
    pub body: usize,
}

impl DraftOptions {
    /// Options with derived keys and body index 0.
    pub fn new(feature: impl Into<String>) -> Self {
        Self {
            feature: feature.into(),
            keys: None,
            body: 0,
        }
    }
}

/// The neutral plane and the pull direction of a draft (§6.9).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DraftSpec {
    /// A point of the neutral plane.
    pub neutral_origin: Point3,
    /// The neutral plane's unit normal.
    pub neutral_normal: Vec3,
    /// The unit pull direction: the neutral normal, reversed for `pull: reverse`.
    pub pull: Vec3,
    /// The draft angle in degrees, in (0, 45).
    pub angle_deg: f64,
}

/// The outward unit normal of a planar face of the plan.
fn outward(surf: &Surface, sense: bool) -> Option<Vec3> {
    match surf {
        Surface::Plane(p) => Some(if sense { p.frame().z() } else { -p.frame().z() }),
        _ => None,
    }
}

/// A point of a planar face's plane and its outward normal.
fn plane_of(surf: &Surface, sense: bool) -> Option<(Point3, Vec3)> {
    match surf {
        Surface::Plane(p) => Some((p.frame().origin(), outward(surf, sense)?)),
        _ => None,
    }
}

/// The point where the planes `n_i · x = d_i` meet (least squares for more than three), with
/// the largest distance from it to any of them; `None` when they do not pin a point.
fn meet(planes: &[(Vec3, f64)]) -> Option<(Point3, f64)> {
    if planes.len() < 3 {
        return None;
    }
    // Normal equations AᵀA x = Aᵀd (exactly A x = d for three planes).
    let mut m = [[0.0f64; 3]; 3];
    let mut r = [0.0f64; 3];
    for (n, d) in planes {
        let a = [n.x, n.y, n.z];
        for i in 0..3 {
            for j in 0..3 {
                m[i][j] += a[i] * a[j];
            }
            r[i] += a[i] * d;
        }
    }
    let det = |m: &[[f64; 3]; 3]| {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    };
    let d0 = det(&m);
    // The planes' normals must span space (unit normals: a determinant of 1 when orthogonal).
    if d0.abs() <= 1e-12 || d0.is_nan() {
        return None;
    }
    let mut x = [0.0f64; 3];
    for (k, xk) in x.iter_mut().enumerate() {
        let mut mk = m;
        for (i, row) in mk.iter_mut().enumerate() {
            row[k] = r[i];
        }
        *xk = det(&mk) / d0;
    }
    let p = Point3::new(x[0], x[1], x[2]);
    let worst = planes
        .iter()
        .map(|(n, d)| (n.dot(p) - d).abs())
        .fold(0.0f64, f64::max);
    Some((p, worst))
}

/// Draft the faces `faces` of `body` (see the module docs).
pub fn draft(
    body: &Body,
    faces: &[Pick<FaceId>],
    spec: &DraftSpec,
    opts: &DraftOptions,
) -> Result<Body, BlendError> {
    let a = spec.angle_deg;
    if !(a.is_finite() && a > 0.0 && a < 45.0) {
        return Err(BlendError::InvalidValue {
            code: "INVALID_VALUE",
            field: "angle",
            value: a,
            expected: "in (0, 45)".into(),
        });
    }
    let keys = KeyMap::complete(body, opts.keys.as_ref());
    let named = |f: FaceId, fallback: &str| {
        keys.face(f).unwrap_or(Named {
            key: fallback.to_string(),
            name: fallback.to_string(),
        })
    };
    let drafted_named: Vec<Named> = faces.iter().map(|p| named(p.id, &p.key)).collect();
    let failed = |reason: String| BlendError::DraftFailed {
        faces: drafted_named.clone(),
        reason,
    };
    let mut plan =
        Plan::from_body(body).map_err(|m| failed(format!("the input body cannot be read: {m}")))?;
    let p = spec.pull;

    // 1. The drafted faces: planar, perpendicular to the pull direction, of this body.
    let mut bad: Vec<UnsupportedFace> = Vec::new();
    let mut drafted: Vec<usize> = Vec::new();
    for pick in faces {
        let n = named(pick.id, &pick.key);
        let here = if pick.body == opts.body {
            plan.fmap.get(&pick.id).copied()
        } else {
            None
        };
        let Some(fi) = here else {
            bad.push(UnsupportedFace {
                key: n.key,
                name: n.name,
                reason: DraftFaceReason::NotOnBody,
            });
            continue;
        };
        let f = plan.fs[fi].as_ref().expect("a face of the body");
        match outward(&f.surf, f.sense) {
            None => bad.push(UnsupportedFace {
                key: n.key,
                name: n.name,
                reason: DraftFaceReason::NotPlanar,
            }),
            Some(nrm) if nrm.dot(p).abs() > forge_core::math::sin(QUERY_ANGLE_TOLERANCE) => bad
                .push(UnsupportedFace {
                    key: n.key,
                    name: n.name,
                    reason: DraftFaceReason::NotPerpendicular,
                }),
            Some(_) => {
                if !drafted.contains(&fi) {
                    drafted.push(fi);
                }
            }
        }
    }
    if !bad.is_empty() {
        return Err(BlendError::DraftFaceUnsupported { faces: bad });
    }

    // 2. Their new planes: through the line where the face meets the neutral plane, normal
    //    cos(a)·n + sin(a)·p.
    let (sa, ca) = forge_core::math::sin_cos_deg(a);
    let nn = spec.neutral_normal;
    let along = p.dot(nn);
    if along.abs() < 0.5 {
        return Err(failed(
            "the pull direction is not the neutral plane's normal".into(),
        ));
    }
    for &fi in &drafted {
        let f = plan.fs[fi].as_mut().expect("face");
        let (o, n) = plane_of(&f.surf, f.sense).expect("planar");
        // Slide the face's point along p (it stays on the face's plane: n ⟂ p) onto N.
        let t = (spec.neutral_origin - o).dot(nn) / along;
        let q = o + p * t;
        let n2 = (n * ca + p * sa)
            .normalize()
            .ok_or_else(|| failed("a drafted normal is degenerate".into()))?;
        let plane = Plane::from_point_normal(q, n2)
            .map_err(|e| failed(format!("a drafted plane is degenerate: {e}")))?;
        f.surf = Surface::Plane(plane);
        f.sense = true;
        f.hint = None;
        for u in f.loops.iter_mut().flatten() {
            u.pc = None;
        }
    }

    // 3. The faces around every vertex of a drafted face; each must be planar.
    let mut vertex_faces: BTreeMap<usize, BTreeSet<usize>> = BTreeMap::new();
    let mut edge_faces: BTreeMap<usize, BTreeSet<usize>> = BTreeMap::new();
    for (fi, f) in plan.fs.iter().enumerate() {
        let Some(f) = f else { continue };
        for u in f.loops.iter().flatten() {
            edge_faces.entry(u.edge).or_default().insert(fi);
            for v in [plan.es[u.edge].start, plan.es[u.edge].end]
                .into_iter()
                .flatten()
            {
                vertex_faces.entry(v).or_default().insert(fi);
            }
        }
    }
    let drafted_set: BTreeSet<usize> = drafted.iter().copied().collect();
    let face_name = |plan: &Plan, fi: usize| {
        plan.fs[fi]
            .as_ref()
            .map_or_else(String::new, |f| f.prov.name())
    };
    let mut moved: BTreeMap<usize, Point3> = BTreeMap::new();
    for &fi in &drafted {
        let f = plan.fs[fi].as_ref().expect("face");
        for u in f.loops.iter().flatten() {
            let e = &plan.es[u.edge];
            if e.is_ring() {
                return Err(failed(format!(
                    "{} has a closed edge (a round hole or boss in the wall): only walls bounded by straight edges are drafted",
                    face_name(&plan, fi)
                )));
            }
            for v in [e.start, e.end].into_iter().flatten() {
                if moved.contains_key(&v) {
                    continue;
                }
                let around = vertex_faces.get(&v).cloned().unwrap_or_default();
                let mut planes = Vec::with_capacity(around.len());
                for &g in &around {
                    let pf = plan.fs[g].as_ref().expect("face");
                    let Some((o, n)) = plane_of(&pf.surf, pf.sense) else {
                        return Err(failed(format!(
                            "{} next to the drafted {} is curved: only drafts between planar faces are built (draft before filleting)",
                            face_name(&plan, g),
                            face_name(&plan, fi)
                        )));
                    };
                    planes.push((n, n.dot(o)));
                }
                let Some((x, worst)) = meet(&planes) else {
                    return Err(failed(format!(
                        "the faces around a corner of {} do not meet in one point after the draft",
                        face_name(&plan, fi)
                    )));
                };
                if worst > LINEAR_TOLERANCE {
                    return Err(failed(format!(
                        "{} faces meet at a corner of {}: after the draft they no longer meet in one point (only corners of three faces, or of faces that still meet, are drafted)",
                        around.len(),
                        face_name(&plan, fi)
                    )));
                }
                moved.insert(v, x);
            }
        }
    }

    // 4. Every edge with a moved vertex is the line through its new vertices; it must not
    //    collapse or turn over.
    let tol = 10.0 * LINEAR_TOLERANCE;
    let mut changed_faces: BTreeSet<usize> = drafted_set.clone();
    for ei in 0..plan.es.len() {
        let e = &plan.es[ei];
        let (Some(s), Some(t)) = (e.start, e.end) else {
            continue;
        };
        if !moved.contains_key(&s) && !moved.contains_key(&t) {
            continue;
        }
        let Curve3::Line(old) = &e.curve else {
            return Err(failed(format!(
                "{} runs from a drafted face and is not straight",
                e.prov.name()
            )));
        };
        let a0 = moved.get(&s).copied().unwrap_or(plan.vs[s].p);
        let b0 = moved.get(&t).copied().unwrap_or(plan.vs[t].p);
        let dir = b0 - a0;
        if dir.norm() <= tol || dir.dot(old.dir()) <= 0.0 {
            return Err(failed(format!(
                "the draft collapses or turns over {} (a smaller angle, or a taller neutral plane, keeps it)",
                e.prov.name()
            )));
        }
        let line = Line3::through(a0, b0).map_err(|x| failed(format!("{}: {x}", e.prov.name())))?;
        let len = dir.norm();
        let e = &mut plan.es[ei];
        e.curve = Curve3::Line(line);
        e.range = (0.0, len);
        for &g in edge_faces.get(&ei).into_iter().flatten() {
            changed_faces.insert(g);
        }
    }
    for (v, x) in &moved {
        plan.vs[*v].p = *x;
    }
    let moved_edges: BTreeSet<usize> = (0..plan.es.len())
        .filter(|&ei| {
            let e = &plan.es[ei];
            [e.start, e.end]
                .into_iter()
                .flatten()
                .any(|v| moved.contains_key(&v))
        })
        .collect();
    // Keys (§5.2: drafted entities keep theirs). A sweep's side–side junction edge is
    // qualified (`@c.end`) by the junction point its carrier passes through, which forge-refs
    // derives from the geometry when the provenance carries no qualifier; a moved edge no
    // longer passes through it (unless the neutral plane is the sketch's), so the qualifier of
    // the input's key is stamped on every moved edge and vertex that lacks one.
    let stamp = |prov: &mut forge_core::topo::Provenance, named: Option<Named>| {
        if prov.qualifier.is_none()
            && let Some(q) = named.and_then(|n| parse_key(&n.key).ok()?.qualifier)
        {
            prov.qualifier = Some(q);
        }
    };
    for (&eid, &ei) in &plan.emap {
        if moved_edges.contains(&ei) {
            stamp(&mut plan.es[ei].prov, keys.edge(eid));
        }
    }
    for (&vid, &vi) in &plan.vmap {
        if moved.contains_key(&vi) {
            stamp(&mut plan.vs[vi].prov, keys.vertex(vid));
        }
    }
    for f in plan.fs.iter_mut().flatten() {
        for u in f.loops.iter_mut().flatten() {
            if moved_edges.contains(&u.edge) {
                u.pc = None;
            }
        }
    }
    plan.fill_pcurves()
        .map_err(|m| failed(format!("the drafted faces cannot be parameterized: {m}")))?;

    // 5. Certified checks: no changed face meets itself or another face away from what they
    //    share.
    for &fi in &changed_faces {
        let (found, open) = crate::check::face_crossings_ex(&plan, fi);
        if !found.is_empty() {
            return Err(failed(format!(
                "the boundary of {} runs into itself after the draft",
                face_name(&plan, fi)
            )));
        }
        if !open.is_empty() {
            return Err(failed(format!(
                "the boundary of {} could not be certified after the draft",
                face_name(&plan, fi)
            )));
        }
    }
    let live: Vec<usize> = (0..plan.fs.len())
        .filter(|&f| plan.fs[f].is_some())
        .collect();
    {
        let ck = crate::interfere::Checker::new(&plan, &live);
        for &fa in &changed_faces {
            for &fb in &live {
                if fb == fa || (changed_faces.contains(&fb) && fb < fa) {
                    continue;
                }
                let sh = ck.topo_shared(fa, fb);
                match ck.pair(fa, fb, &sh) {
                    crate::interfere::Outcome::Clear => {}
                    crate::interfere::Outcome::Hit { .. } => {
                        return Err(failed(format!(
                            "after the draft {} runs into {}",
                            face_name(&plan, fa),
                            face_name(&plan, fb)
                        )));
                    }
                    crate::interfere::Outcome::Unverified(m) => {
                        return Err(failed(format!(
                            "{} and {} could not be certified apart after the draft: {m}",
                            face_name(&plan, fa),
                            face_name(&plan, fb)
                        )));
                    }
                }
            }
        }
    }
    let out = plan
        .build()
        .map_err(|m| failed(format!("the drafted body cannot be built: {m}")))?;
    crate::check::validate_body(&out)
        .map_err(|m| failed(format!("the drafted body is not valid: {m}")))?;
    // 6. The caps' loops moved with their keys kept, so the sketch no longer decided them:
    //    every loop proves its area under the strict rule, without the sketch-region
    //    relaxation (FORGE.md "Degenerate loops").
    let strict = ValidateOptions {
        strict_loops: true,
        ..ValidateOptions::default()
    };
    if let Some(issue) = validate_with(&out, &strict)
        .into_iter()
        .find(|i| i.severity == Severity::Error)
    {
        let face = issue
            .related
            .iter()
            .find_map(|r| match r {
                EntityRef::Face(f) => out.face(*f).map(|f| f.provenance.name()),
                _ => None,
            })
            .unwrap_or_else(|| "a face".to_string());
        return Err(failed(format!(
            "a boundary of {face} does not provably enclose any area after the draft ({}; a smaller angle keeps it)",
            issue.code.as_str()
        )));
    }
    let _ = &opts.feature;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_planes_meet_in_their_common_point_and_parallel_ones_do_not() {
        let planes = [
            (Vec3::new(1.0, 0.0, 0.0), 2.0),
            (Vec3::new(0.0, 1.0, 0.0), -3.0),
            (Vec3::new(0.0, 0.0, 1.0), 5.0),
        ];
        let (p, worst) = meet(&planes).expect("a point");
        assert!(
            (p.x - 2.0).abs() < 1e-12 && (p.y + 3.0).abs() < 1e-12 && (p.z - 5.0).abs() < 1e-12
        );
        assert!(worst < 1e-12);
        let parallel = [
            (Vec3::new(1.0, 0.0, 0.0), 2.0),
            (Vec3::new(1.0, 0.0, 0.0), 3.0),
            (Vec3::new(0.0, 0.0, 1.0), 5.0),
        ];
        assert!(meet(&parallel).is_none());
        // Four planes through one point meet there; four that do not report how far they miss.
        let mut four = planes.to_vec();
        four.push((
            Vec3::new(1.0, 1.0, 0.0).normalize().unwrap(),
            -1.0 / 2f64.sqrt(),
        ));
        let (_, w) = meet(&four).expect("a point");
        assert!(w < 1e-12, "{w}");
        four[3].1 += 1.0;
        assert!(meet(&four).expect("a point").1 > 0.1);
    }
}
