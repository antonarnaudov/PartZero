//! What a blend does at each vertex of its edges (all vertices here have three faces):
//!
//! | Blended edges at the vertex | Result |
//! |---|---|
//! | 1 (`e` between `A`, `B`; third face `C`) | the blend **ends on `C`**: its end curve is the blend surface ∩ `C` (a circle or ellipse for a cylinder and a plane, a meridian circle for a torus and a plane through its axis, a line for a bevel; on any other analytic `C` — a curved face, a plane oblique to a circle blend's meridians — the curve traced along the blend's rulings, [`one_on_surface`], or its exact conic); the two other edges of the vertex are trimmed or extended along their carriers to the contact curves |
//! | 2, tangent (a tangent chain; the third edge is smooth) | the two blends **share their cross-section** at the vertex; the smooth edge is shortened to the contact point |
//! | 2, not tangent (both line edges, same convexity, symmetric) | the two blends meet along their **mitre** (an ellipse for two cylinders of equal radius whose axes meet, a line for two bevels); the third edge is shortened |
//! | 2, not tangent (a line edge and a circle edge on one plane, same convexity: a D-flat's corner) | the **curved mitre**: the two blends' intersection, traced along the line blend's rulings (a B-spline); the third edge is shortened ([`two_curved`]) |
//! | 2, not tangent (both line edges, same convexity, asymmetric: the dihedral angles differ) | the mitre runs from the contacts' meeting point on the shared face to the side face it reaches first; the other blend continues and **ends on that face** (its section by the face's plane), no corner patch — OCCT's construction; the third edge is shortened to that section's end |
//! | 3 (line edges, same convexity) | a **corner patch**: the sphere of the ball touching the three planes (the normative corner when the planes are mutually perpendicular), bounded by the three blends' cross-sections through its centre; for chamfers the triangle through the three contact-line corners — exact at any vertex and for any distances (each bevel holds the two corner points on its faces), built when it truncates the bevels' own tip and only where the three faces are mutually perpendicular (engine-defined, SPEC §8.3 rule 5: W6 review round 6 — at oblique vertices OCCT's corner differs by up to 2e-3 of the volume, so they are an explicit `CHAMFER_FAILED` until the Contract stage defines the chamfer corner; the mixed-convexity chamfer corner, OCCT's planar quadrilateral, equals OCCT's at oblique reflex vertices too and stays) |
//!
//! Anything else is an explicit `*_FAILED` naming the vertex.

use forge_core::geom::{Curve3, NurbsCurve3, Plane, Sphere, Surface};
use forge_core::linalg::Point3;
use forge_ir::v1::{ANGULAR_TOLERANCE, LINEAR_TOLERANCE, TANGENT_CHAIN_TOLERANCE};

use super::St;
use super::edge::{Eg, Fam};
use super::region::{Cell, EndKind, Interior};
use crate::geom::{
    as_plane, circle_in_plane, cylinder_plane_section, frame_zx, line, line_line, line_plane,
    three_planes,
};
use crate::topo::{outward_normal, tangent_away};

/// A corner patch to add (sphere or plane) bounded by the blends' closing curves (`arcs`,
/// used by the blend faces) and by edges inserted into other faces' loops (`extra`).
#[derive(Clone, Debug)]
pub(crate) struct CornerPatch {
    pub v: usize,
    pub surf: Surface,
    /// `None`: a plane whose sense follows from its loop (oriented by its neighbours).
    pub sense: Option<bool>,
    pub arcs: Vec<usize>,
    pub extra: Vec<usize>,
    pub shell: usize,
    pub edges: Vec<usize>,
}

/// A chamfer corner where one blended edge's convexity differs from the two others' (an
/// L-block's inner corner, a pocket's rim corner): OCCT's planar quadrilateral patch. With
/// `m` the odd edge (between faces `A` and `C`) and `e1` (`A`, `B`), `e2` (`C`, `B`) the
/// others: on `A`, `e1`'s and `m`'s contact lines meet at `P_A` (on `C`, `P_C`); `e1`'s bevel
/// ends at its cross-section through `P_A` (reaching `B` at `Q_A`), `e2`'s at `P_C`/`Q_C`;
/// `m`'s bevel ends at the segment `P_A P_C`; the patch is the quadrilateral
/// `P_A Q_A Q_C P_C`, and `B` gets the edge `Q_A Q_C`. The four points must be coplanar
/// (true for equal distances on perpendicular faces), otherwise an explicit failure; where
/// they are, the patch is exact at any vertex (engine-defined, SPEC §8.3 rule 5).
fn mixed_bevel_corner(st: &mut St<'_>, v: usize, gs: &[Eg]) -> Result<(), super::Fail> {
    let cx = st.cx;
    let vname = cx.vname[v].clone();
    let bl: Vec<usize> = gs.iter().map(|g| g.e).collect();
    let convex = gs.iter().filter(|g| g.convex).count();
    let odd = if convex == 1 {
        gs.iter().position(|g| g.convex)
    } else {
        gs.iter().position(|g| !g.convex)
    };
    let Some(odd) = odd else {
        return Err(st.failed(&bl, format!("unexpected corner at vertex {vname}")));
    };
    let m = &gs[odd];
    let others: Vec<&Eg> = gs
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != odd)
        .map(|(_, g)| g)
        .collect();
    let (a, c) = (m.a, m.b);
    let Some(g1) = others.iter().copied().find(|g| g.side_of(a).is_some()) else {
        return Err(st.failed(&bl, format!("unexpected corner at vertex {vname}")));
    };
    let Some(g2) = others.iter().copied().find(|g| g.side_of(c).is_some()) else {
        return Err(st.failed(&bl, format!("unexpected corner at vertex {vname}")));
    };
    let b = if g1.a == a { g1.b } else { g1.a };
    if g2.side_of(b).is_none() {
        return Err(st.failed(&bl, format!("unexpected corner at vertex {vname}")));
    }
    // The patch and its edge on `B` are planar pieces: the three faces must be planes.
    if [a, b, c]
        .iter()
        .any(|&f| as_plane(&cx.plan0.fs[f].as_ref().expect("face").surf).is_none())
    {
        return Err(st.failed(&bl, format!("non-planar face at vertex {vname}")));
    }
    let vp = cx.plan0.vs[v].p;
    let dir = |g: &Eg| match g.fam {
        Fam::Line { t, .. } => t,
        Fam::Circle { .. } => unreachable!("line family"),
    };
    let meet = |g: &Eg, h: &Eg, f: usize| -> Option<Point3> {
        let p = g.contact_at(g.side_of(f)?, 0.0);
        let q = h.contact_at(h.side_of(f)?, 0.0);
        let (x, y) = line_line(p, dir(g), q, dir(h))?;
        (x.distance(y) <= agree_tol(cx.scale)).then_some(x)
    };
    let (Some(pa), Some(pc)) = (meet(g1, m, a), meet(g2, m, c)) else {
        return Err(st.failed(&bl, format!("degenerate corner at vertex {vname}")));
    };
    let qa = g1.contact_at(g1.side_of(b).expect("side"), g1.station(pa));
    let qc = g2.contact_at(g2.side_of(b).expect("side"), g2.station(pc));
    let n = (pa - qa).cross(qc - qa);
    let Some(nn) = n.normalize() else {
        return Err(st.failed(&bl, format!("degenerate corner at vertex {vname}")));
    };
    if (pc - qa).dot(nn).abs() > LINEAR_TOLERANCE {
        return Err(st.failed(
            &bl,
            format!(
                "the chamfers at vertex {vname} (one {} edge between two {} ones) do not close with a planar corner",
                if convex == 1 { "convex" } else { "concave" },
                if convex == 1 { "concave" } else { "convex" }
            ),
        ));
    }
    let Some(fr) = frame_zx(qa, nn, pa - qa) else {
        return Err(st.failed(&bl, format!("degenerate corner at vertex {vname}")));
    };
    let corner_key = crate::keys::derived(cx.feature, "corner", &cx.vkey[v]).key();
    let (k1, k2, km) = (st.blend_key(g1.e), st.blend_key(g2.e), st.blend_key(m.e));
    let vpa = st.new_vertex(
        pa,
        vec![
            cx.fkey[a].clone(),
            k1.clone(),
            km.clone(),
            corner_key.clone(),
        ],
    );
    let vpc = st.new_vertex(
        pc,
        vec![
            cx.fkey[c].clone(),
            k2.clone(),
            km.clone(),
            corner_key.clone(),
        ],
    );
    let vqa = st.new_vertex(qa, vec![cx.fkey[b].clone(), k1.clone(), corner_key.clone()]);
    let vqc = st.new_vertex(qc, vec![cx.fkey[b].clone(), k2.clone(), corner_key.clone()]);
    let seg = |x: Point3, y: Point3| crate::geom::dir(x, y).and_then(|d| line(x, d));
    let mk =
        |st: &mut St<'_>, x: usize, y: usize, px: Point3, py: Point3, k: &str, attr: &[usize]| {
            let Some(l) = seg(px, py) else {
                return Err(st.failed(&bl, format!("degenerate corner at vertex {vname}")));
            };
            let prov = crate::keys::edge_between(cx.feature, k, &corner_key);
            st.new_edge(l, x, y, (px + py) * 0.5, prov, attr, usize::MAX)
        };
    let c1 = mk(st, vpa, vqa, pa, qa, &k1, &[g1.e])?;
    let c2 = mk(st, vpc, vqc, pc, qc, &k2, &[g2.e])?;
    let cm = mk(st, vpa, vpc, pa, pc, &km, &[m.e])?;
    let cb = mk(st, vqa, vqc, qa, qc, &cx.fkey[b], &[g1.e, g2.e])?;
    st.ends.insert((v, a, g1.e), vpa);
    st.ends.insert((v, b, g1.e), vqa);
    st.ends.insert((v, c, g2.e), vpc);
    st.ends.insert((v, b, g2.e), vqc);
    st.ends.insert((v, a, m.e), vpa);
    st.ends.insert((v, c, m.e), vpc);
    st.closers.insert((v, g1.e), vec![c1]);
    st.closers.insert((v, g2.e), vec![c2]);
    st.closers.insert((v, m.e), vec![cm]);
    st.inserts.entry((v, b)).or_default().push(cb);
    // Where each blend's material ends: g1 and g2 at their cross-sections through P_A and
    // P_C, the odd edge at the corner quadrilateral's plane.
    let into = |g: &Eg| tangent_away(cx.plan0, g.e, v);
    if let (Some(t1), Some(t2)) = (into(g1), into(g2)) {
        st.endk.insert((v, g1.e), EndKind::Plane { o: pa, n: t1 });
        st.endk.insert((v, g2.e), EndKind::Plane { o: pc, n: t2 });
    }
    let away = if (vp - qa).dot(nn) > 0.0 { -nn } else { nn };
    st.endk.insert((v, m.e), EndKind::Plane { o: qa, n: away });
    let shell = cx.plan0.fs[a].as_ref().expect("face").shell;
    st.corners.push(CornerPatch {
        v,
        surf: Surface::Plane(Plane::new(fr)),
        sense: None,
        arcs: vec![c1, c2, cm],
        extra: vec![cb],
        shell,
        edges: bl,
    });
    Ok(())
}

/// The largest deviation from a right angle (radians) between two of `normals` (unit).
fn max_off_perpendicular(normals: &[forge_core::linalg::Vec3]) -> f64 {
    let mut worst: f64 = 0.0;
    for i in 0..normals.len() {
        for j in (i + 1)..normals.len() {
            worst = worst
                .max(forge_core::math::asin(normals[i].dot(normals[j]).clamp(-1.0, 1.0)).abs());
        }
    }
    worst
}

/// A corner of three chamfers is built only where its three faces are mutually
/// perpendicular (SPEC §8.3 rule 3's test: `|n_i · n_j| ≤ ANGULAR_TOLERANCE`): the only
/// chamfer corner both engines build alike. Elsewhere `CHAMFER_FAILED` naming the vertex and
/// its faces' largest deviation from a right angle — the Contract stage has not defined the
/// chamfer corner (SPEC §6.7), and a corner that differs from OCCT's beyond rule 5's 1e-5 is a
/// potential silent-wrong row (W6 review round 6).
fn refuse_oblique_chamfer_corner(
    st: &St<'_>,
    v: usize,
    bl: &[usize],
    normals: &[forge_core::linalg::Vec3],
) -> Result<(), super::Fail> {
    let perpendicular = (0..normals.len()).all(|i| {
        ((i + 1)..normals.len()).all(|j| normals[i].dot(normals[j]).abs() <= ANGULAR_TOLERANCE)
    });
    if perpendicular {
        return Ok(());
    }
    let cx = st.cx;
    let off = forge_core::math::rad_to_deg(max_off_perpendicular(normals));
    Err(st.failed(
        bl,
        format!(
            "chamfer corner undefined by SPEC §6.7 (awaiting a Contract ruling on chamfer corners): the chamfers of {} meet at vertex {}, whose faces are not mutually perpendicular (up to {off:.4}° off a right angle), where Forge's planar corner differs from OCCT's beyond SPEC §8.3 rule 5",
            bl.iter()
                .map(|&e| cx.ename[e].clone())
                .collect::<Vec<_>>()
                .join(", "),
            cx.vname[v]
        ),
    ))
}

/// Distance within which two computations of one point must agree (mm).
fn agree_tol(scale: f64) -> f64 {
    1e-9 * scale.max(1.0)
}

/// Handle vertex `v`.
pub(crate) fn vertex(st: &mut St<'_>, v: usize) -> Result<(), super::Fail> {
    let cx = st.cx;
    let corners = cx.adj.corners[v].clone();
    let inc = cx.adj.vertex_edges(v);
    let bl: Vec<usize> = inc
        .iter()
        .copied()
        .filter(|e| st.egs.contains_key(e))
        .collect();
    let vname = cx.vname[v].clone();
    if corners.len() != 3 || inc.len() != 3 {
        return Err(st.failed(
            &bl,
            format!(
                "vertex {vname} has {} edges; blends end only at vertices of three edges",
                inc.len()
            ),
        ));
    }
    for &e in &bl {
        let pe = &cx.plan0.es[e];
        if pe.start == pe.end {
            return Err(st.failed(
                &bl,
                format!("edge {} is closed at vertex {vname}", cx.ename[e]),
            ));
        }
    }
    let faces_of = |e: usize| cx.adj.edge_faces(e);
    match bl.len() {
        1 => one(
            st,
            v,
            bl[0],
            &inc,
            &corners.iter().map(|c| c.face).collect::<Vec<_>>(),
        ),
        2 => {
            let (e1, e2) = (bl[0], bl[1]);
            let f1 = faces_of(e1);
            let f2 = faces_of(e2);
            let Some(&b) = f1.iter().find(|f| f2.contains(f)) else {
                return Err(st.failed(&bl, format!("the blends at vertex {vname} share no face")));
            };
            let a = *f1.iter().find(|&&f| f != b).expect("two faces");
            let c = *f2.iter().find(|&&f| f != b).expect("two faces");
            let ca = *inc
                .iter()
                .find(|&&x| x != e1 && x != e2)
                .expect("three edges");
            two(st, v, e1, e2, a, b, c, ca)
        }
        3 => three(st, v, &bl),
        _ => Ok(()),
    }
}

/// One blended edge at the vertex: the blend ends on the third face.
fn one(
    st: &mut St<'_>,
    v: usize,
    e: usize,
    inc: &[usize],
    faces: &[usize],
) -> Result<(), super::Fail> {
    let cx = st.cx;
    let eg = st.egs[&e].clone();
    let vname = cx.vname[v].clone();
    let (a, b) = (eg.a, eg.b);
    let Some(&c) = faces.iter().find(|&&f| f != a && f != b) else {
        return Err(st.failed(&[e], format!("vertex {vname}: no face ends the blend")));
    };
    let others: Vec<usize> = inc.iter().copied().filter(|&x| x != e).collect();
    let fs = |x: usize| cx.adj.edge_faces(x);
    let Some(&ca) = others
        .iter()
        .find(|&&x| fs(x).contains(&a) && fs(x).contains(&c))
    else {
        return Err(st.failed(&[e], format!("vertex {vname}: unexpected star")));
    };
    let Some(&bc) = others
        .iter()
        .find(|&&x| fs(x).contains(&b) && fs(x).contains(&c))
    else {
        return Err(st.failed(&[e], format!("vertex {vname}: unexpected star")));
    };
    let fc = cx.plan0.fs[c].as_ref().expect("face");
    let vp = cx.plan0.vs[v].p;
    // A plane across a line blend, or a meridian plane of a circle blend, ends it in a conic
    // section (below); any other end face along the blend's rulings ([`one_on_surface`]).
    let meridian = |pl: &Plane| match eg.fam {
        Fam::Line { .. } => true,
        Fam::Circle { o, z, .. } => {
            let (pn, po) = (pl.frame().z(), pl.frame().origin());
            pn.dot(z).abs() <= ANGULAR_TOLERANCE && (o - po).dot(pn).abs() <= LINEAR_TOLERANCE
        }
    };
    let Some(pl) = as_plane(&fc.surf).filter(|pl| meridian(pl)).cloned() else {
        return one_on_surface(st, v, e, &eg, [a, b, c], [ca, bc]);
    };
    let pn = pl.frame().z();
    let po = pl.frame().origin();
    let (xa, xb, end_curve, mid): (Point3, Point3, Curve3, Point3) = match eg.fam {
        Fam::Line { t, .. } => {
            let hit = |k: usize| line_plane(eg.contact_at(k, 0.0), t, po, pn);
            let (Some(xa), Some(xb)) = (hit(0), hit(1)) else {
                return Err(st.failed(
                    &[e],
                    format!(
                        "the blend of {} runs parallel to its end face at vertex {vname}",
                        cx.ename[e]
                    ),
                ));
            };
            let curve = if eg.is_fillet() {
                let ao = eg.fam.to3(0.0, eg.c2);
                cylinder_plane_section(ao, t, eg.r, &pl)
            } else {
                crate::geom::dir(xa, xb).and_then(|d| line(xa, d))
            };
            let Some(curve) = curve else {
                return Err(st.failed(&[e], format!("degenerate blend end at vertex {vname}")));
            };
            let mid = if eg.is_fillet() {
                let (tp, _) = curve.project(vp);
                curve.eval(tp)
            } else {
                (xa + xb) * 0.5
            };
            (xa, xb, curve, mid)
        }
        Fam::Circle { o, z, .. } => {
            // Only a plane through the axis (a meridian plane) ends a torus or cone blend in
            // a circle or a line.
            if pn.dot(z).abs() > ANGULAR_TOLERANCE || (o - po).dot(pn).abs() > LINEAR_TOLERANCE {
                return Err(st.failed(
                    &[e],
                    format!(
                        "the blend of {} ends on {} at vertex {vname}, which is not a plane through its axis",
                        cx.ename[e], cx.fname[c]
                    ),
                ));
            }
            let th = eg.station(vp);
            let xa = eg.contact_at(0, th);
            let xb = eg.contact_at(1, th);
            let curve = if eg.is_fillet() {
                circle_in_plane(eg.fam.to3(th, eg.c2), eg.r, &pl).map(Curve3::Circle)
            } else {
                crate::geom::dir(xa, xb).and_then(|d| line(xa, d))
            };
            let Some(curve) = curve else {
                return Err(st.failed(&[e], format!("degenerate blend end at vertex {vname}")));
            };
            (xa, xb, curve, eg.mid_profile(th))
        }
    };
    // The trimmed edges keep their carriers: the new vertices must lie on them.
    for (x, edge) in [(xa, ca), (xb, bc)] {
        let pe = &cx.plan0.es[edge];
        let (t, _) = pe.curve.project(x);
        if pe.curve.eval(t).distance(x) > LINEAR_TOLERANCE {
            return Err(st.failed(
                &[e],
                format!(
                    "the blend of {} does not end on edge {} at vertex {vname}",
                    cx.ename[e], cx.ename[edge]
                ),
            ));
        }
    }
    // A convex blend ending at a reflex vertex: `c` meets it on the material's side, and
    // the construction extends the other edge of the vertex along its carrier (the end cap
    // joins `c`, as OCCT builds it). The region then ends at `c`'s plane from the blend's
    // side (W6 review round 4: an end `Face` put it on the far side, into the solid).
    let reflex = reflex_side(st, v, e, [(xa, ca), (xb, bc)]);
    let bk = st.blend_key(e);
    let va = st.new_vertex(xa, vec![cx.fkey[a].clone(), cx.fkey[c].clone(), bk.clone()]);
    let vb = st.new_vertex(xb, vec![cx.fkey[b].clone(), cx.fkey[c].clone(), bk.clone()]);
    let prov = crate::keys::edge_between(cx.feature, &cx.fkey[c], &bk);
    let ee = st.new_edge(end_curve, va, vb, mid, prov, &[e], c)?;
    st.ends.insert((v, a, e), va);
    st.ends.insert((v, b, e), vb);
    st.moved.insert((v, ca), va);
    st.moved.insert((v, bc), vb);
    st.note_moved(ca, &[e]);
    st.note_moved(bc, &[e]);
    st.inserts.entry((v, c)).or_default().push(ee);
    st.closers.insert((v, e), vec![ee]);
    let n_out = outward_normal(fc, vp).unwrap_or(pn);
    if reflex {
        // Into the region: towards the blended edge's interior.
        let pe = &cx.plan0.es[e];
        let m = pe.curve.eval(0.5 * (pe.range.0 + pe.range.1));
        let n_in = if (m - po).dot(n_out) >= 0.0 {
            n_out
        } else {
            -n_out
        };
        st.endk.insert((v, e), EndKind::Plane { o: po, n: n_in });
    } else {
        st.endk.insert((v, e), EndKind::Face { o: po, n: n_out });
    }
    Ok(())
}

/// Does a convex blend's contact meet the end face's plane behind vertex `v` on one of the
/// two other edges' carriers (the vertex is reflex: `c` meets the blend on the material's
/// side)? See [`reflex_end`].
fn reflex_side(st: &St<'_>, v: usize, e: usize, ends: [(Point3, usize); 2]) -> bool {
    let cx = st.cx;
    if !st.egs[&e].convex {
        return false;
    }
    let vp = cx.plan0.vs[v].p;
    ends.iter().any(|&(x, edge)| {
        tangent_away(cx.plan0, edge, v)
            .is_some_and(|into| (x - vp).dot(into) < -10.0 * LINEAR_TOLERANCE)
    })
}

/// A convex blend's contacts must meet the end face `c` **on** the two other edges of the
/// vertex — which the blend trims — never on their extensions behind the vertex: there `c` meets the
/// blend on the material's side (the vertex is reflex, e.g. a star prism's inner corner, and
/// the third edge is concave), and the end would reach into the solid. On a **planar** end
/// face the construction extends the other edge instead ([`reflex_side`], OCCT's result);
/// on a curved end face such an end is not built: an immediate `*_FAILED` naming the vertex
/// and the face, whatever the radius — never a search down to the floor blaming another face
/// (W6 review round 4).
fn reflex_end(
    st: &St<'_>,
    v: usize,
    e: usize,
    c: usize,
    ends: [(Point3, usize); 2],
) -> Result<(), super::Fail> {
    let cx = st.cx;
    // A concave blend adds material: its contacts legitimately run on along the other edges'
    // carriers (a rib's root fillet past the rib's corner).
    if !st.egs[&e].convex {
        return Ok(());
    }
    let vp = cx.plan0.vs[v].p;
    for (x, edge) in ends {
        let Some(into) = tangent_away(cx.plan0, edge, v) else {
            continue;
        };
        if (x - vp).dot(into) < -10.0 * LINEAR_TOLERANCE {
            return Err(st.failed(
                &[e],
                format!(
                    "the blend of {} ends at the reflex vertex {} ({}): face {} ({}) meets it on the material's side, so edge {} would have to run on into the solid; a blend ending at such a vertex is not supported (any {})",
                    cx.ename[e],
                    cx.vname[v],
                    cx.vkey[v],
                    cx.fname[c],
                    cx.fkey[c],
                    cx.ename[edge],
                    if cx.label == "bevel" { "distance" } else { "radius" },
                ),
            ));
        }
    }
    Ok(())
}

/// One blended edge `e` at vertex `v` ending on face `c` that is not a plane across its
/// cross-section (a cylinder, cone, sphere or torus, or a plane oblique to a circle blend's
/// meridians — a D-flat's top edge ending on the shaft, its top arc on the flat; W6 review
/// round 3). The blend surface is ruled — lines along a line blend, circles about a circle
/// blend's axis — through the points of its cross-section profile, so its end curve on `c` is
/// traced along the rulings: the ruling through each profile point meets `c` at the point
/// nearest the vertex (forge-ssi's certified curve–surface intersection), and a piecewise
/// quintic B-spline through those points, spans halved until it is within [`END_FIT`] of
/// them at every sample between the nodes, is the end curve; its ends are the contacts'
/// meetings with `c`, which lie on the two other edges of the vertex (checked). The
/// material's end is `c`'s surface (the region of [`super::region`]).
fn one_on_surface(
    st: &mut St<'_>,
    v: usize,
    e: usize,
    eg: &Eg,
    [a, b, c]: [usize; 3],
    [ca, bc]: [usize; 2],
) -> Result<(), super::Fail> {
    let cx = st.cx;
    let vname = cx.vname[v].clone();
    let fc = cx.plan0.fs[c].as_ref().expect("face");
    let vp = cx.plan0.vs[v].p;
    let fail = |st: &St<'_>, what: String| {
        Err(st.failed(
            &[e],
            format!(
                "the blend of {} ends on {} ({}) at vertex {vname}: {what}",
                cx.ename[e],
                cx.fname[c],
                fc.surf.kind_name()
            ),
        ))
    };
    if matches!(fc.surf, Surface::BSpline(_)) {
        return fail(st, "a free-form end face is not supported".into());
    }
    let sv = eg.station(vp);
    let reach = (eg.pa - eg.e2).norm().max((eg.pb - eg.e2).norm());
    let tol = forge_ssi::SsiTolerance::default();
    let dom = forge_ssi::UvBox::natural(&fc.surf, 4.0 * cx.scale.max(1.0) + 10.0);
    // The ruling through the cross-section point `p2`, and where it meets `c` nearest `vp`.
    let hit = |p2: forge_core::linalg::Vec2| -> Option<Point3> {
        let (curve, range) = match eg.fam {
            Fam::Line { t, .. } => {
                let span = 4.0 * reach + 1.0;
                (
                    Curve3::Line(forge_core::geom::Line3::new(eg.fam.to3(sv, p2), t).ok()?),
                    (-span, span),
                )
            }
            Fam::Circle { o, z, x0, .. } => {
                let fr = frame_zx(o + z * p2.y, z, x0)?;
                (
                    Curve3::Circle(forge_core::geom::Circle3::new(fr, p2.x).ok()?),
                    (0.0, forge_core::math::TAU),
                )
            }
        };
        let h = forge_ssi::intersect_curve_surface(&curve, range, &fc.surf, dom, &tol).ok()?;
        if !h.overlaps.is_empty() {
            return None;
        }
        h.points
            .iter()
            .map(|x| x.point)
            .min_by(|p, q| p.distance(vp).total_cmp(&q.distance(vp)))
            .filter(|p| p.distance(vp) <= 4.0 * reach + 10.0 * LINEAR_TOLERANCE)
    };
    // The profile: the ball's arc facing the edge (fillet) or the bevel's segment.
    let prof = |s: f64| -> forge_core::linalg::Vec2 {
        if eg.is_fillet() {
            let ang =
                |q: forge_core::linalg::Vec2| forge_core::math::atan2(q.y - eg.c2.y, q.x - eg.c2.x);
            let (t0, t1) = (ang(eg.pa), ang(eg.pb));
            let d = crate::geom::wrap(t1 - t0 + forge_core::math::PI) - forge_core::math::PI;
            let (sn, cs) = forge_core::math::sin_cos(t0 + d * s);
            eg.c2 + forge_core::linalg::Vec2::new(cs, sn) * eg.r
        } else {
            eg.pa + (eg.pb - eg.pa) * s
        }
    };
    let Some(curve) = fit_ruled_end(&|s| hit(prof(s))) else {
        return fail(
            st,
            "its rulings do not all meet the face near the vertex".into(),
        );
    };
    let (xa, xb) = (curve.eval(0.0), curve.eval(1.0));
    // The trimmed edges keep their carriers: the new vertices must lie on them.
    for (x, edge) in [(xa, ca), (xb, bc)] {
        let pe = &cx.plan0.es[edge];
        let (t, _) = pe.curve.project(x);
        if pe.curve.eval(t).distance(x) > LINEAR_TOLERANCE {
            return fail(
                st,
                format!("the contacts do not meet edge {}", cx.ename[edge]),
            );
        }
    }
    reflex_end(st, v, e, c, [(xa, ca), (xb, bc)])?;
    let mid = curve.eval(0.5);
    let bk = st.blend_key(e);
    let va = st.new_vertex(xa, vec![cx.fkey[a].clone(), cx.fkey[c].clone(), bk.clone()]);
    let vb = st.new_vertex(xb, vec![cx.fkey[b].clone(), cx.fkey[c].clone(), bk.clone()]);
    let prov = crate::keys::edge_between(cx.feature, &cx.fkey[c], &bk);
    // The box and station window of the end curve (the region's end on `c`).
    let mut lo = xa.min_components(xb);
    let mut hi = xa.max_components(xb);
    let (mut w0, mut w1) = (f64::INFINITY, f64::NEG_INFINITY);
    for k in 0..=32 {
        let x = curve.eval(k as f64 / 32.0);
        lo = lo.min_components(x);
        hi = hi.max_components(x);
        let st_x = eg.station(x);
        let st_x = match eg.fam {
            Fam::Line { .. } => st_x,
            Fam::Circle { .. } => {
                sv + crate::geom::wrap(st_x - sv + forge_core::math::PI) - forge_core::math::PI
            }
        };
        w0 = w0.min(st_x);
        w1 = w1.max(st_x);
    }
    let pad = 0.25 * lo.distance(hi) + 10.0 * LINEAR_TOLERANCE;
    let d = forge_core::linalg::Vec3::new(pad, pad, pad);
    // A planar bevel ends on a cylinder in an ellipse (or a circle) and on a sphere in a
    // circle: the exact conic replaces the traced curve (both engines type it so, §8.3).
    let exact: Option<Curve3> = match (&eg.surf, &fc.surf) {
        (Surface::Plane(bp), Surface::Cylinder(cy)) => {
            let f = cy.frame();
            cylinder_plane_section(f.origin(), f.z(), cy.radius(), bp)
        }
        (Surface::Plane(bp), Surface::Sphere(sp)) => {
            let n = bp.frame().z();
            let c0 = sp.frame().origin();
            let h = (c0 - bp.frame().origin()).dot(n);
            let rho = (sp.radius() * sp.radius() - h * h).max(0.0).sqrt();
            circle_in_plane(c0 - n * h, rho, bp).map(Curve3::Circle)
        }
        _ => None,
    };
    // The conic must pass through the traced curve's points (else keep the traced curve).
    let exact = exact.filter(|k| {
        (0..=16).all(|i| {
            let x = curve.eval(i as f64 / 16.0);
            k.project(x).1 <= 10.0 * END_FIT + 1e-12 * (1.0 + x.norm())
        })
    });
    let end = exact.unwrap_or(Curve3::BSpline(curve));
    let ee = st.new_edge(end, va, vb, mid, prov, &[e], c)?;
    st.ends.insert((v, a, e), va);
    st.ends.insert((v, b, e), vb);
    st.moved.insert((v, ca), va);
    st.moved.insert((v, bc), vb);
    st.note_moved(ca, &[e]);
    st.note_moved(bc, &[e]);
    st.inserts.entry((v, c)).or_default().push(ee);
    st.closers.insert((v, e), vec![ee]);
    st.endk.insert(
        (v, e),
        EndKind::OnFace {
            f: c,
            window: (w0.min(sv), w1.max(sv)),
            bx: (lo - d, hi + d),
        },
    );
    Ok(())
}

/// Largest distance (mm) between a fitted end curve and the points it interpolates, at the
/// samples between its nodes.
const END_FIT: f64 = 2e-11;

/// A piecewise quintic B-spline `C(s)`, `s ∈ [0, 1]`, through `x(s)` at Chebyshev–Lobatto
/// nodes of each span, spans halved until `|C(s) − x(s)| ≤ END_FIT` at 24 samples of each
/// (tight enough that the face pcurves fitted to it, [`crate::pcurve`], reach their own
/// 1e-10 mm); `None` when a point is missing or it does not converge within 256 spans.
fn fit_ruled_end(x: &dyn Fn(f64) -> Option<Point3>) -> Option<NurbsCurve3> {
    const NODES: [f64; 6] = [
        0.0,
        0.095_491_502_812_526_27,
        0.345_491_502_812_526_3,
        0.654_508_497_187_473_7,
        0.904_508_497_187_473_7,
        1.0,
    ];
    const BINOM5: [f64; 6] = [1.0, 5.0, 10.0, 10.0, 5.0, 1.0];
    let bern = |s: f64| -> [f64; 6] {
        core::array::from_fn(|j| {
            BINOM5[j]
                * forge_core::math::powi(s, j as i32)
                * forge_core::math::powi(1.0 - s, 5 - j as i32)
        })
    };
    // Solve the 6×6 collocation system (Gaussian elimination, partial pivoting).
    let solve = |vals: &[Point3; 6]| -> Option<[Point3; 6]> {
        let mut m = [[0.0f64; 9]; 6];
        for (k, &s) in NODES.iter().enumerate() {
            let b = bern(s);
            m[k][..6].copy_from_slice(&b);
            m[k][6] = vals[k].x;
            m[k][7] = vals[k].y;
            m[k][8] = vals[k].z;
        }
        for c in 0..6 {
            let p = (c..6).max_by(|&i, &j| m[i][c].abs().total_cmp(&m[j][c].abs()))?;
            m.swap(c, p);
            let d = m[c][c];
            if d.abs() < 1e-300 {
                return None;
            }
            let pivot = m[c];
            for (r, row) in m.iter_mut().enumerate() {
                if r != c {
                    let f = row[c] / d;
                    for (x, y) in row.iter_mut().zip(pivot).skip(c) {
                        *x -= f * y;
                    }
                }
            }
        }
        Some(core::array::from_fn(|j| {
            Point3::new(m[j][6] / m[j][j], m[j][7] / m[j][j], m[j][8] / m[j][j])
        }))
    };
    let mut spans: Vec<(f64, f64)> = vec![(0.0, 0.25), (0.25, 0.5), (0.5, 0.75), (0.75, 1.0)];
    let mut out: Vec<[Point3; 6]> = Vec::new();
    let mut breaks: Vec<f64> = vec![0.0];
    let mut i = 0;
    while i < spans.len() {
        let (a, b) = spans[i];
        let mut vals = [Point3::zero(); 6];
        for (k, &n) in NODES.iter().enumerate() {
            vals[k] = x(a + (b - a) * n)?;
        }
        let mut cp = solve(&vals)?;
        cp[0] = vals[0];
        cp[5] = vals[5];
        let mut err: f64 = 0.0;
        for m in 0..24 {
            let s = (m as f64 + 0.5) / 24.0;
            let bs = bern(s);
            let p = (0..6).fold(Point3::zero(), |acc, j| acc + cp[j] * bs[j]);
            err = err.max(p.distance(x(a + (b - a) * s)?));
        }
        if err > END_FIT {
            if spans.len() >= 256 {
                return None;
            }
            let m = 0.5 * (a + b);
            spans[i] = (a, m);
            spans.insert(i + 1, (m, b));
            continue;
        }
        out.push(cp);
        breaks.push(b);
        i += 1;
    }
    let mut knots = vec![0.0; 6];
    let mut ctrl: Vec<Point3> = Vec::with_capacity(5 * out.len() + 1);
    for (k, cp) in out.iter().enumerate() {
        if k == 0 {
            ctrl.push(cp[0]);
        }
        ctrl.extend_from_slice(&cp[1..]);
        if k + 1 < out.len() {
            knots.extend([breaks[k + 1]; 5]);
        }
    }
    knots.extend([1.0; 6]);
    NurbsCurve3::from_points(5, knots, &ctrl, None).ok()
}

/// Two blended edges sharing face `b` (`e1` between `a` and `b`, `e2` between `b` and `c`);
/// `ca` is the third edge.
#[allow(clippy::too_many_arguments)]
fn two(
    st: &mut St<'_>,
    v: usize,
    e1: usize,
    e2: usize,
    a: usize,
    b: usize,
    c: usize,
    ca: usize,
) -> Result<(), super::Fail> {
    let cx = st.cx;
    let vname = cx.vname[v].clone();
    let g1 = st.egs[&e1].clone();
    let g2 = st.egs[&e2].clone();
    let vp = cx.plan0.vs[v].p;
    let (Some(t1), Some(t2)) = (tangent_away(cx.plan0, e1, v), tangent_away(cx.plan0, e2, v))
    else {
        return Err(st.failed(&[e1, e2], format!("degenerate edges at vertex {vname}")));
    };
    let tangent = forge_core::math::acos((-t1.dot(t2)).clamp(-1.0, 1.0)) <= TANGENT_CHAIN_TOLERANCE;
    let bk1 = st.blend_key(e1);
    let bk2 = st.blend_key(e2);
    let side = |g: &Eg, f: usize| g.side_of(f).expect("face of the edge");
    if tangent {
        // The cross-sections of both blends at the vertex.
        let s1 = g1.station(vp);
        let s2 = g2.station(vp);
        let xb1 = g1.contact_at(side(&g1, b), s1);
        let xa = g1.contact_at(side(&g1, a), s1);
        let xb2 = g2.contact_at(side(&g2, b), s2);
        let xc = g2.contact_at(side(&g2, c), s2);
        let tol = 10.0 * LINEAR_TOLERANCE;
        if xb1.distance(xb2) > tol || xa.distance(xc) > tol || g1.convex != g2.convex {
            return Err(st.failed(
                &[e1, e2],
                format!(
                    "the blends of {} and {} do not share a cross-section at the tangent vertex {vname}",
                    cx.ename[e1], cx.ename[e2]
                ),
            ));
        }
        let pe = &cx.plan0.es[ca];
        let (t, _) = pe.curve.project(xa);
        if pe.curve.eval(t).distance(xa) > LINEAR_TOLERANCE {
            return Err(st.failed(
                &[e1, e2],
                format!(
                    "the blends at vertex {vname} do not end on edge {}",
                    cx.ename[ca]
                ),
            ));
        }
        let (curve, mid) = if g1.is_fillet() {
            let ctr = g1.fam.to3(s1, g1.c2);
            let n = g1.fam.tangent(s1);
            let Some(fr) = frame_zx(ctr, n, xb1 - ctr) else {
                return Err(st.failed(&[e1, e2], format!("degenerate cross-section at {vname}")));
            };
            let circ = forge_core::geom::Circle3::new(fr, g1.r)
                .ok()
                .map(Curve3::Circle);
            (circ, g1.mid_profile(s1))
        } else {
            (
                crate::geom::dir(xb1, xa).and_then(|d| line(xb1, d)),
                (xb1 + xa) * 0.5,
            )
        };
        let Some(curve) = curve else {
            return Err(st.failed(&[e1, e2], format!("degenerate cross-section at {vname}")));
        };
        let vb = st.new_vertex(xb1, vec![cx.fkey[b].clone(), bk1.clone(), bk2.clone()]);
        let vac = st.new_vertex(
            xa,
            vec![
                cx.fkey[a].clone(),
                cx.fkey[c].clone(),
                bk1.clone(),
                bk2.clone(),
            ],
        );
        let prov = crate::keys::edge_between(cx.feature, &bk1, &bk2);
        let ce = st.new_edge(curve, vb, vac, mid, prov, &[e1, e2], usize::MAX)?;
        st.ends.insert((v, b, e1), vb);
        st.ends.insert((v, b, e2), vb);
        st.ends.insert((v, a, e1), vac);
        st.ends.insert((v, c, e2), vac);
        st.moved.insert((v, ca), vac);
        st.note_moved(ca, &[e1, e2]);
        st.closers.insert((v, e1), vec![ce]);
        st.closers.insert((v, e2), vec![ce]);
        st.endk.insert((v, e1), EndKind::Plane { o: vp, n: t1 });
        st.endk.insert((v, e2), EndKind::Plane { o: vp, n: t2 });
        return Ok(());
    }
    // A line edge and a circle edge of the same convexity on one plane (a D-flat's top line
    // and top arc at its corner): the curved mitre.
    if g1.convex == g2.convex && g1.fam.is_line() != g2.fam.is_line() {
        return two_curved(st, v, [e1, e2], [a, b, c], ca);
    }
    // Mitre: two line edges between planes, same convexity, meeting symmetrically.
    if !(g1.fam.is_line() && g2.fam.is_line()) || g1.convex != g2.convex {
        return Err(st.failed(
            &[e1, e2],
            format!(
                "the blends of {} and {} meet at vertex {vname} in a corner that is not supported ({})",
                cx.ename[e1],
                cx.ename[e2],
                if g1.convex != g2.convex {
                    "one convex, one concave"
                } else {
                    "a curved edge"
                }
            ),
        ));
    }
    let pl_of = |f: usize| as_plane(&cx.plan0.fs[f].as_ref().expect("face").surf).cloned();
    let (Some(pa), Some(pb), Some(pc)) = (pl_of(a), pl_of(b), pl_of(c)) else {
        return Err(st.failed(&[e1, e2], format!("non-planar faces at vertex {vname}")));
    };
    let (Fam::Line { t: d1, .. }, Fam::Line { t: d2, .. }) = (g1.fam, g2.fam) else {
        unreachable!("checked above");
    };
    // Where each blend's contact on the side faces meets the third edge.
    let x1 = line_plane(
        g1.contact_at(side(&g1, a), 0.0),
        d1,
        pc.frame().origin(),
        pc.frame().z(),
    );
    let x2 = line_plane(
        g2.contact_at(side(&g2, c), 0.0),
        d2,
        pa.frame().origin(),
        pa.frame().z(),
    );
    let (Some(x1), Some(x2)) = (x1, x2) else {
        return Err(st.failed(&[e1, e2], format!("degenerate mitre at vertex {vname}")));
    };
    if x1.distance(x2) > agree_tol(cx.scale) {
        return asymmetric_two(st, v, &g1, &g2, [a, b, c], ca, &pb, [x1, x2], [t1, t2]);
    }
    let m = x1;
    let q1 = g1.contact_at(side(&g1, b), 0.0);
    let q2 = g2.contact_at(side(&g2, b), 0.0);
    let Some((mb, mb2)) = line_line(q1, d1, q2, d2) else {
        return Err(st.failed(&[e1, e2], format!("parallel blends at vertex {vname}")));
    };
    if mb.distance(mb2) > agree_tol(cx.scale) || pb.signed_distance(mb).abs() > LINEAR_TOLERANCE {
        return Err(st.failed(&[e1, e2], format!("inconsistent mitre at vertex {vname}")));
    }
    let pe = &cx.plan0.es[ca];
    let (t, _) = pe.curve.project(m);
    if pe.curve.eval(t).distance(m) > LINEAR_TOLERANCE {
        return Err(st.failed(
            &[e1, e2],
            format!(
                "the mitre at vertex {vname} does not end on edge {}",
                cx.ename[ca]
            ),
        ));
    }
    let (curve, mid) = if g1.is_fillet() {
        // Axes meet at q; the mitre plane holds q, the contact corner on b and m.
        let a1 = g1.fam.to3(0.0, g1.c2);
        let a2 = g2.fam.to3(0.0, g2.c2);
        let Some((q, qq)) = line_line(a1, d1, a2, d2) else {
            return Err(st.failed(&[e1, e2], format!("parallel blend axes at vertex {vname}")));
        };
        if q.distance(qq) > agree_tol(cx.scale) {
            return Err(st.failed(&[e1, e2], format!("blend axes miss at vertex {vname}")));
        }
        let n = (mb - q).cross(m - q);
        let Some(fr) = frame_zx(q, n, mb - q) else {
            return Err(st.failed(
                &[e1, e2],
                format!("degenerate mitre plane at vertex {vname}"),
            ));
        };
        let mp = Plane::new(fr);
        let Some(curve) = cylinder_plane_section(a1, d1, g1.r, &mp) else {
            return Err(st.failed(&[e1, e2], format!("degenerate mitre at vertex {vname}")));
        };
        // Both ends on the curve and the curve on the second cylinder.
        let on2 = |p: Point3| {
            let w = p - a2;
            ((w - d2 * w.dot(d2)).norm() - g2.r).abs()
        };
        let (tp, _) = curve.project(vp);
        let mid = curve.eval(tp);
        let bad = [mb, m]
            .iter()
            .any(|&p| curve.project(p).1 > LINEAR_TOLERANCE)
            || on2(mid) > LINEAR_TOLERANCE;
        if bad {
            return Err(st.failed(&[e1, e2], format!("inconsistent mitre at vertex {vname}")));
        }
        (curve, mid)
    } else {
        let Some(l) = crate::geom::dir(mb, m).and_then(|d| line(mb, d)) else {
            return Err(st.failed(&[e1, e2], format!("degenerate mitre at vertex {vname}")));
        };
        (l, (mb + m) * 0.5)
    };
    let vb = st.new_vertex(mb, vec![cx.fkey[b].clone(), bk1.clone(), bk2.clone()]);
    let vm = st.new_vertex(
        m,
        vec![
            cx.fkey[a].clone(),
            cx.fkey[c].clone(),
            bk1.clone(),
            bk2.clone(),
        ],
    );
    let prov = crate::keys::edge_between(cx.feature, &bk1, &bk2);
    let me = st.new_edge(curve, vb, vm, mid, prov, &[e1, e2], usize::MAX)?;
    st.ends.insert((v, b, e1), vb);
    st.ends.insert((v, b, e2), vb);
    st.ends.insert((v, a, e1), vm);
    st.ends.insert((v, c, e2), vm);
    st.moved.insert((v, ca), vm);
    st.note_moved(ca, &[e1, e2]);
    st.closers.insert((v, e1), vec![me]);
    st.closers.insert((v, e2), vec![me]);
    // The mitre plane (through the vertex and the mitre's ends) splits the two blends'
    // material; each blend's lies on its own edge's side.
    let n = (mb - vp).cross(m - vp);
    let (n1, n2) = match n.normalize() {
        Some(n) => {
            let n1 = if n.dot(t1) >= 0.0 { n } else { -n };
            (n1, -n1)
        }
        None => (t1, t2),
    };
    st.endk.insert((v, e1), EndKind::Plane { o: vp, n: n1 });
    st.endk.insert((v, e2), EndKind::Plane { o: vp, n: n2 });
    Ok(())
}

/// The point of line `l` on circle `k` (coplanar) nearest `near`.
fn line_circle(l: &Curve3, k: &Curve3, near: Point3) -> Option<Point3> {
    let (Curve3::Line(l), Curve3::Circle(k)) = (l, k) else {
        return None;
    };
    let (o, d) = (l.origin(), l.dir());
    let w = o - k.frame().origin();
    let (bq, cq) = (d.dot(w), w.dot(w) - k.radius() * k.radius());
    let disc = bq * bq - cq;
    if disc.is_nan() || disc < 0.0 {
        return None;
    }
    let sq = disc.sqrt();
    [-bq - sq, -bq + sq]
        .into_iter()
        .map(|s| o + d * s)
        .min_by(|p, q| p.distance(near).total_cmp(&q.distance(near)))
}

/// The point of circle `k` on the plane `pl` nearest `near`.
fn circle_plane(k: &Curve3, pl: &Plane, near: Point3) -> Option<Point3> {
    let Curve3::Circle(k) = k else {
        return None;
    };
    let f = k.frame();
    let n = pl.frame().z();
    let (aa, bb) = (k.radius() * f.x().dot(n), k.radius() * f.y().dot(n));
    let dd = (f.origin() - pl.frame().origin()).dot(n);
    let amp = aa.hypot(bb);
    if amp.is_nan() || amp <= 0.0 || (dd / amp).abs() > 1.0 {
        return None;
    }
    let base = forge_core::math::atan2(bb, aa);
    let off = forge_core::math::acos((-dd / amp).clamp(-1.0, 1.0));
    [base - off, base + off]
        .into_iter()
        .map(|th| {
            let (sn, cs) = forge_core::math::sin_cos(th);
            f.origin() + (f.x() * cs + f.y() * sn) * k.radius()
        })
        .min_by(|p, q| p.distance(near).total_cmp(&q.distance(near)))
}

/// Two blended edges of the same convexity on the plane `b` at vertex `v`, one a line edge
/// between planes, the other a circle edge (a D-flat's top line and top arc at its corner; W6
/// review round 4): their blends — a cylinder and a torus, or a plane and a cone — meet along
/// their intersection, the **curved mitre**, from `m_b`, where their contacts on `b` meet, to
/// `m`, where their contacts on the side faces meet the third edge `ca` (at one point: else
/// not supported). The mitre is traced along the line blend's rulings — each meets the other
/// blend surface at the point nearest the vertex (forge-ssi's certified curve–surface
/// intersection) — and fitted ([`fit_ruled_end`]); the topology is the symmetric mitre's
/// ([`two`]). The two blends' materials are split by the plane through the vertex and the
/// mitre's ends, each region reaching past it by the mitre's largest distance from it (the
/// regions overlap, so nothing between them escapes the obstacle checks).
fn two_curved(
    st: &mut St<'_>,
    v: usize,
    [e1, e2]: [usize; 2],
    [a, b, c]: [usize; 3],
    ca: usize,
) -> Result<(), super::Fail> {
    let cx = st.cx;
    let vname = cx.vname[v].clone();
    let vp = cx.plan0.vs[v].p;
    let (g1, g2) = (st.egs[&e1].clone(), st.egs[&e2].clone());
    let fail = |st: &St<'_>, why: &str| {
        Err(st.failed(
            &[e1, e2],
            format!(
                "the blends of {} and {} meet at vertex {vname} in a curved mitre that cannot be built ({why})",
                cx.ename[e1], cx.ename[e2]
            ),
        ))
    };
    // `gl`: the line edge's blend and its side face; `gc`: the circle edge's.
    let (gl, gc, fl) = if g1.fam.is_line() {
        (&g1, &g2, a)
    } else {
        (&g2, &g1, c)
    };
    let face = |f: usize| &cx.plan0.fs[f].as_ref().expect("face").surf;
    let (Some(_), Some(pl_side)) = (as_plane(face(b)).cloned(), as_plane(face(fl)).cloned()) else {
        return fail(st, "the faces of the line edge are not planes");
    };
    let (Some(kl_b), Some(kc_b)) = (gl.side_of(b), gc.side_of(b)) else {
        return fail(st, "the blends share no face");
    };
    let (kl_s, kc_s) = (1 - kl_b, 1 - kc_b);
    // Where the contacts meet on `b`, and on the side faces (at the third edge).
    let Some(mb) = line_circle(&gl.contact[kl_b], &gc.contact[kc_b], vp) else {
        return fail(st, "the contacts on the shared face do not meet");
    };
    let Some(m) = circle_plane(&gc.contact[kc_s], &pl_side, vp) else {
        return fail(
            st,
            "the circle blend's contact does not reach the line edge's face",
        );
    };
    let tol = agree_tol(cx.scale);
    if gl.contact[kl_s].project(m).1 > tol {
        return fail(
            st,
            "the contacts on the side faces reach the third edge at different points",
        );
    }
    let pe = &cx.plan0.es[ca];
    let (t_ca, _) = pe.curve.project(m);
    if pe.curve.eval(t_ca).distance(m) > LINEAR_TOLERANCE {
        return fail(st, "the mitre does not end on the third edge");
    }
    // The line blend's profile from its contact on `b` to its contact on its side face, and
    // each ruling's meeting with the circle blend's surface nearest the vertex.
    let (p_from, p_to) = if kl_b == 0 {
        (gl.pa, gl.pb)
    } else {
        (gl.pb, gl.pa)
    };
    let prof = |s: f64| -> forge_core::linalg::Vec2 {
        if gl.is_fillet() {
            let ang =
                |q: forge_core::linalg::Vec2| forge_core::math::atan2(q.y - gl.c2.y, q.x - gl.c2.x);
            let (t0, t1) = (ang(p_from), ang(p_to));
            let d = crate::geom::wrap(t1 - t0 + forge_core::math::PI) - forge_core::math::PI;
            let (sn, cs) = forge_core::math::sin_cos(t0 + d * s);
            gl.c2 + forge_core::linalg::Vec2::new(cs, sn) * gl.r
        } else {
            p_from + (p_to - p_from) * s
        }
    };
    let Fam::Line { t, .. } = gl.fam else {
        return fail(st, "internal: not a line blend");
    };
    let sv = gl.station(vp);
    let reach = mb.distance(vp).max(m.distance(vp)) + gl.r + 1.0;
    let ssi_tol = forge_ssi::SsiTolerance::default();
    let dom = forge_ssi::UvBox::natural(&gc.surf, 4.0 * cx.scale.max(1.0) + 10.0);
    let hit = |p2: forge_core::linalg::Vec2| -> Option<Point3> {
        let line = Curve3::Line(forge_core::geom::Line3::new(gl.fam.to3(sv, p2), t).ok()?);
        let h = forge_ssi::intersect_curve_surface(
            &line,
            (-4.0 * reach, 4.0 * reach),
            &gc.surf,
            dom,
            &ssi_tol,
        )
        .ok()?;
        if !h.overlaps.is_empty() {
            return None;
        }
        h.points
            .iter()
            .map(|x| x.point)
            .min_by(|p, q| p.distance(vp).total_cmp(&q.distance(vp)))
            .filter(|p| p.distance(vp) <= 2.0 * reach)
    };
    let Some(curve) = fit_ruled_end(&|s| hit(prof(s))) else {
        return fail(st, "the mitre could not be traced");
    };
    if curve.eval(0.0).distance(mb) > 10.0 * LINEAR_TOLERANCE
        || curve.eval(1.0).distance(m) > 10.0 * LINEAR_TOLERANCE
    {
        return fail(st, "the traced mitre does not join its ends");
    }
    let bk1 = st.blend_key(e1);
    let bk2 = st.blend_key(e2);
    let mid = curve.eval(0.5);
    // The plane through the vertex and the mitre's ends, and the mitre's largest distance
    // from it.
    let n = (mb - vp).cross(m - vp);
    let t1 = tangent_away(cx.plan0, e1, v).unwrap_or(t);
    let (n1, dev) = match n.normalize() {
        Some(n) => {
            let n1 = if n.dot(t1) >= 0.0 { n } else { -n };
            let dev = (0..=32)
                .map(|k| (curve.eval(k as f64 / 32.0) - vp).dot(n1).abs())
                .fold(0.0, f64::max);
            (n1, dev + 10.0 * LINEAR_TOLERANCE)
        }
        None => (t1, 0.0),
    };
    let vb = st.new_vertex(mb, vec![cx.fkey[b].clone(), bk1.clone(), bk2.clone()]);
    let vm = st.new_vertex(
        m,
        vec![
            cx.fkey[a].clone(),
            cx.fkey[c].clone(),
            bk1.clone(),
            bk2.clone(),
        ],
    );
    let prov = crate::keys::edge_between(cx.feature, &bk1, &bk2);
    let me = st.new_edge(
        Curve3::BSpline(curve),
        vb,
        vm,
        mid,
        prov,
        &[e1, e2],
        usize::MAX,
    )?;
    st.ends.insert((v, b, e1), vb);
    st.ends.insert((v, b, e2), vb);
    st.ends.insert((v, a, e1), vm);
    st.ends.insert((v, c, e2), vm);
    st.moved.insert((v, ca), vm);
    st.note_moved(ca, &[e1, e2]);
    st.closers.insert((v, e1), vec![me]);
    st.closers.insert((v, e2), vec![me]);
    st.endk.insert(
        (v, e1),
        EndKind::Plane {
            o: vp - n1 * dev,
            n: n1,
        },
    );
    st.endk.insert(
        (v, e2),
        EndKind::Plane {
            o: vp + n1 * dev,
            n: -n1,
        },
    );
    Ok(())
}

/// Two line blends of the same convexity sharing face `b` that meet **asymmetrically** (their
/// dihedral angles differ, so their contacts on `a` and `c` reach the third edge `ca` at
/// different points `x1`, `x2`): the rolling-ball result, as OCCT builds it (no corner
/// patch). The contacts on `b` meet at `m_b`; from there the blends meet along their mitre —
/// the two cylinders' intersection in the bisector plane of their axes with normal
/// `t1 − t2` (the edges' tangents leaving the vertex), or the two bevels' line — which
/// touches `a` where the first blend's contact line crosses it (`m_a`) and `c` where the
/// second's does (`m_c`). Travelling from `m_b` into the corner, the point reached first ends
/// the mitre. Say `m_c`: the second blend ends there; the first continues and ends on `c`
/// along its section by `c`'s plane, from `m_c` to `x1` on `ca` (its face closes with the
/// mitre and that section; `c` gets the section as a new edge). The obstacle regions end on
/// the opposite side faces.
#[allow(clippy::too_many_arguments)]
fn asymmetric_two(
    st: &mut St<'_>,
    v: usize,
    g1: &Eg,
    g2: &Eg,
    [a, b, c]: [usize; 3],
    ca: usize,
    pb: &Plane,
    [x1, x2]: [Point3; 2],
    [t1, t2]: [forge_core::linalg::Vec3; 2],
) -> Result<(), super::Fail> {
    let cx = st.cx;
    let vname = cx.vname[v].clone();
    let (e1, e2) = (g1.e, g2.e);
    let fail = |st: &mut St<'_>, what: &str| {
        Err(st.failed(
            &[e1, e2],
            format!(
                "the blends of {} and {} meet at vertex {vname} asymmetrically ({:.3e} mm apart on edge {}): {what}",
                cx.ename[e1],
                cx.ename[e2],
                x1.distance(x2),
                cx.ename[ca]
            ),
        ))
    };
    let (Fam::Line { t: d1, .. }, Fam::Line { t: d2, .. }) = (g1.fam, g2.fam) else {
        return fail(st, "not two line blends");
    };
    let side = |g: &Eg, f: usize| g.side_of(f).expect("face of the edge");
    let vp = cx.plan0.vs[v].p;
    let tol = agree_tol(cx.scale);
    let plane_of = |f: usize| as_plane(&cx.plan0.fs[f].as_ref().expect("face").surf).cloned();
    let (Some(pa), Some(pc)) = (plane_of(a), plane_of(c)) else {
        return fail(st, "non-planar side faces");
    };
    // The contacts on b meet at m_b.
    let q1 = g1.contact_at(side(g1, b), 0.0);
    let q2 = g2.contact_at(side(g2, b), 0.0);
    let Some((mb, mb2)) = line_line(q1, d1, q2, d2) else {
        return fail(st, "parallel blends");
    };
    if mb.distance(mb2) > tol || pb.signed_distance(mb).abs() > LINEAR_TOLERANCE {
        return fail(st, "the contacts on the shared face do not meet");
    }
    let l1a = g1.contact_at(side(g1, a), 0.0);
    let l2c = g2.contact_at(side(g2, c), 0.0);
    let fillet = g1.is_fillet();
    let (a1, a2) = (g1.fam.to3(0.0, g1.c2), g2.fam.to3(0.0, g2.c2));
    let bevel = |g: &Eg| -> Option<Plane> {
        let (p, q) = (g.contact_at(0, 0.0), g.contact_at(1, 0.0));
        let Fam::Line { t, .. } = g.fam else {
            return None;
        };
        let n = (q - p).cross(t).normalize()?;
        frame_zx(p, n, t).map(Plane::new)
    };
    // The mitre: its curve, and where each side face's contact line meets it.
    let (mitre, ma, mc) = if fillet {
        let Some((q, qq)) = line_line(a1, d1, a2, d2) else {
            return fail(st, "parallel blend axes");
        };
        if q.distance(qq) > tol {
            return fail(st, "the blend axes miss each other");
        }
        let Some(n) = (t1 - t2).normalize() else {
            return fail(st, "degenerate mitre plane");
        };
        if (mb - q).dot(n).abs() > LINEAR_TOLERANCE {
            return fail(st, "the mitre plane misses the shared contact point");
        }
        let Some(fr) = frame_zx(q, n, (mb - q).cross(n)) else {
            return fail(st, "degenerate mitre plane");
        };
        let mp = Plane::new(fr);
        let hit = |o: Point3, d: forge_core::linalg::Vec3| {
            line_plane(o, d, mp.frame().origin(), mp.frame().z())
        };
        (
            cylinder_plane_section(a1, d1, g1.r, &mp),
            hit(l1a, d1),
            hit(l2c, d2),
        )
    } else {
        let (Some(b1), Some(b2)) = (bevel(g1), bevel(g2)) else {
            return fail(st, "degenerate bevels");
        };
        let Some(dir) = b1.frame().z().cross(b2.frame().z()).normalize() else {
            return fail(st, "parallel bevels");
        };
        let hit = |o: Point3, d: forge_core::linalg::Vec3, pl: &Plane| {
            line_plane(o, d, pl.frame().origin(), pl.frame().z())
        };
        (line(mb, dir), hit(l1a, d1, &b2), hit(l2c, d2, &b1))
    };
    let Some(mitre) = mitre else {
        return fail(st, "degenerate mitre");
    };
    // On the mitre (the other blend's surface too).
    let on = |x: Option<Point3>| x.filter(|&p| mitre.project(p).1 <= tol);
    let (ma, mc) = (on(ma), on(mc));
    // Travel along the mitre from m_b into the corner (towards the vertex).
    let (tb, _) = mitre.project(mb);
    let h = 1e-6 * (1.0 + tb.abs());
    let fwd = (mitre.eval(tb + h) - mitre.eval(tb - h)).dot(vp - mb) > 0.0;
    let travel = |x: Point3| -> f64 {
        let (t, _) = mitre.project(x);
        let dt = if fwd { t - tb } else { tb - t };
        match mitre.period() {
            Some(p) => forge_core::math::rem_euclid(dt, p),
            None => dt,
        }
    };
    let first = match (ma, mc) {
        (Some(x), Some(y)) => {
            let (ta, tc) = (travel(x), travel(y));
            if ta > 0.0 && (tc <= 0.0 || ta < tc) {
                Some(true)
            } else if tc > 0.0 {
                Some(false)
            } else {
                None
            }
        }
        (Some(x), None) => (travel(x) > 0.0).then_some(true),
        (None, Some(y)) => (travel(y) > 0.0).then_some(false),
        _ => None,
    };
    // Case A: the mitre ends at m_a on a, the second blend ends on a; case C: the other way.
    let (m, end_face, x_end, long, short, long_axis, long_dir, cut_plane) = match first {
        Some(true) => (ma.expect("m_a"), a, x2, g2, g1, a2, d2, &pa),
        Some(false) => (mc.expect("m_c"), c, x1, g1, g2, a1, d1, &pc),
        None => return fail(st, "the mitre reaches neither side face"),
    };
    // The third edge's carrier holds the end of the long blend's contact.
    let pe = &cx.plan0.es[ca];
    let (tx, _) = pe.curve.project(x_end);
    if pe.curve.eval(tx).distance(x_end) > LINEAR_TOLERANCE {
        return fail(st, "the long blend does not end on the third edge");
    }
    // The long blend's section by the end face (m → x_end).
    let section = if fillet {
        cylinder_plane_section(long_axis, long_dir, long.r, cut_plane)
    } else {
        crate::geom::dir(m, x_end).and_then(|d| line(m, d))
    };
    let Some(section) = section else {
        return fail(st, "degenerate section");
    };
    if [m, x_end]
        .iter()
        .any(|&p| section.project(p).1 > LINEAR_TOLERANCE)
        || mitre.project(m).1 > LINEAR_TOLERANCE
    {
        return fail(st, "inconsistent mitre");
    }
    // The arcs: the mitre's part travelled from m_b, the section's part next to the corner.
    let (tm, _) = mitre.project(m);
    let mid_m = match mitre.period() {
        Some(_) => {
            let span = travel(m);
            mitre.eval(if fwd {
                tb + 0.5 * span
            } else {
                tb - 0.5 * span
            })
        }
        None => mitre.eval(0.5 * (tb + tm)),
    };
    let mid_s = {
        let (t, _) = section.project((m + x_end) * 0.5);
        section.eval(t)
    };
    let (bk1, bk2) = (st.blend_key(e1), st.blend_key(e2));
    let bk_long = st.blend_key(long.e);
    let other_face = if end_face == a { c } else { a };
    let vb = st.new_vertex(mb, vec![cx.fkey[b].clone(), bk1.clone(), bk2.clone()]);
    let vm = st.new_vertex(m, vec![cx.fkey[end_face].clone(), bk1.clone(), bk2.clone()]);
    let vx = st.new_vertex(
        x_end,
        vec![cx.fkey[a].clone(), cx.fkey[c].clone(), bk_long.clone()],
    );
    let me = st.new_edge(
        mitre,
        vb,
        vm,
        mid_m,
        crate::keys::edge_between(cx.feature, &bk1, &bk2),
        &[e1, e2],
        usize::MAX,
    )?;
    let se = st.new_edge(
        section,
        vm,
        vx,
        mid_s,
        crate::keys::edge_between(cx.feature, &cx.fkey[end_face], &bk_long),
        &[e1, e2],
        end_face,
    )?;
    st.ends.insert((v, b, e1), vb);
    st.ends.insert((v, b, e2), vb);
    // The short blend's contact on the end face stops at m; the long one's on the other
    // side face at x_end.
    st.ends.insert((v, end_face, short.e), vm);
    st.ends.insert((v, other_face, long.e), vx);
    st.moved.insert((v, ca), vx);
    st.note_moved(ca, &[e1, e2]);
    st.inserts.entry((v, end_face)).or_default().push(se);
    st.closers.insert((v, short.e), vec![me]);
    st.closers.insert((v, long.e), vec![me, se]);
    // Each blend's material ends on the opposite side face (a superset of the part each
    // removes or fills next to the mitre).
    for (g, f) in [(g1, c), (g2, a)] {
        let fp = cx.plan0.fs[f].as_ref().expect("face");
        let n = outward_normal(fp, vp).unwrap_or(if f == a {
            pa.frame().z()
        } else {
            pc.frame().z()
        });
        st.endk.insert((v, g.e), EndKind::Face { o: vp, n });
    }
    Ok(())
}

/// Three blended edges: a corner patch.
fn three(st: &mut St<'_>, v: usize, bl: &[usize]) -> Result<(), super::Fail> {
    let cx = st.cx;
    let vname = cx.vname[v].clone();
    let gs: Vec<Eg> = bl.iter().map(|e| st.egs[e].clone()).collect();
    let mixed = !gs.iter().all(|g| g.convex == gs[0].convex);
    if mixed && gs.iter().all(|g| g.fam.is_line() && !g.is_fillet()) {
        return mixed_bevel_corner(st, v, &gs);
    }
    if !gs.iter().all(|g| g.fam.is_line()) || mixed {
        return Err(st.failed(
            bl,
            format!(
                "three blends meet at vertex {vname} in a corner that is not supported ({})",
                if gs.iter().all(|g| g.fam.is_line()) {
                    "mixed convexity"
                } else {
                    "a curved edge"
                }
            ),
        ));
    }
    let convex = gs[0].convex;
    let vp = cx.plan0.vs[v].p;
    // The three faces.
    let mut faces: Vec<usize> = gs.iter().flat_map(|g| [g.a, g.b]).collect();
    faces.sort_unstable();
    faces.dedup();
    if faces.len() != 3 {
        return Err(st.failed(bl, format!("unexpected star at vertex {vname}")));
    }
    let mut normals = Vec::with_capacity(3);
    for &f in &faces {
        let face = cx.plan0.fs[f].as_ref().expect("face");
        if as_plane(&face.surf).is_none() {
            return Err(st.failed(bl, format!("non-planar face at vertex {vname}")));
        }
        normals.push(outward_normal(face, vp).expect("plane normal"));
    }
    let corner_key = crate::keys::derived(cx.feature, "corner", &cx.vkey[v]).key();
    let blend_keys: Vec<String> = bl.iter().map(|&e| st.blend_key(e)).collect();
    // Corner points on each face: ball feet (fillet) or contact-line corners (chamfer).
    let (surf, pts): (Surface, Vec<Point3>) = if gs[0].is_fillet() {
        let r = gs[0].r;
        let sig = if convex { -1.0 } else { 1.0 };
        let n = [normals[0], normals[1], normals[2]];
        let d = [0, 1, 2].map(|i| n[i].dot(vp) + sig * r);
        let Some(q) = three_planes(n, d) else {
            return Err(st.failed(bl, format!("degenerate corner at vertex {vname}")));
        };
        let feet: Vec<Point3> = (0..3).map(|i| q - n[i] * (sig * r)).collect();
        let Some(fr) = frame_zx(q, n[0] - n[1], n[2]) else {
            return Err(st.failed(bl, format!("degenerate corner at vertex {vname}")));
        };
        let Ok(sph) = Sphere::new(fr, r) else {
            return Err(st.failed(bl, format!("degenerate corner at vertex {vname}")));
        };
        (Surface::Sphere(sph), feet)
    } else {
        // SPEC §6.7 defines no chamfer corner, and §8.3 rule 5 still compares volume and
        // area at 1e-5: the corner triangle below agrees with OCCT's corner only where the
        // three faces are mutually perpendicular (W6 review round 6: at oblique vertices the
        // two differ by up to 2e-3 of the volume, a difference the SPEC comparison flags as
        // potential silent-wrong). Elsewhere: an explicit failure naming the vertex until the
        // Contract stage defines the chamfer corner.
        refuse_oblique_chamfer_corner(st, v, bl, &normals)?;
        let mut pts = Vec::with_capacity(3);
        for &f in &faces {
            // The two blends on face f.
            let on: Vec<&Eg> = gs.iter().filter(|g| g.side_of(f).is_some()).collect();
            if on.len() != 2 {
                return Err(st.failed(bl, format!("unexpected star at vertex {vname}")));
            }
            let (Fam::Line { t: d1, .. }, Fam::Line { t: d2, .. }) = (on[0].fam, on[1].fam) else {
                unreachable!("line family");
            };
            let p1 = on[0].contact_at(on[0].side_of(f).expect("side"), 0.0);
            let p2 = on[1].contact_at(on[1].side_of(f).expect("side"), 0.0);
            let Some((x, y)) = line_line(p1, d1, p2, d2) else {
                return Err(st.failed(bl, format!("parallel bevels at vertex {vname}")));
            };
            if x.distance(y) > agree_tol(cx.scale) {
                return Err(st.failed(bl, format!("inconsistent bevels at vertex {vname}")));
            }
            pts.push(x);
        }
        let mut n = (pts[1] - pts[0]).cross(pts[2] - pts[0]);
        // Outward: toward the vertex for a convex corner (the removed tip).
        let toward = (vp - pts[0]).dot(n) > 0.0;
        if toward != convex {
            n = -n;
        }
        // The corner triangle P_A P_B P_C is exact at any vertex: each bevel holds the two
        // corner points on its faces (its contact lines meet the neighbours' there), so it
        // ends at a side of the triangle. It closes the corner only when the three bevels'
        // own tip (where their planes meet) lies strictly on the vertex's side of it — the
        // triangle truncates that tip; otherwise the bevels would pass through each other
        // before reaching it (an explicit failure, never an inverted patch).
        let bevel_plane = |g: &Eg| -> Option<(forge_core::linalg::Vec3, f64)> {
            let pl = as_plane(&g.surf)?;
            let nz = pl.frame().z();
            Some((nz, nz.dot(pl.frame().origin())))
        };
        let tip = match (
            bevel_plane(&gs[0]),
            bevel_plane(&gs[1]),
            bevel_plane(&gs[2]),
        ) {
            (Some(a0), Some(a1), Some(a2)) => three_planes([a0.0, a1.0, a2.0], [a0.1, a1.1, a2.1]),
            _ => None,
        };
        let side = |x: Point3| {
            (x - pts[0]).dot(n.normalize().unwrap_or(n)) * if convex { 1.0 } else { -1.0 }
        };
        match tip {
            Some(q) if side(q) > 10.0 * LINEAR_TOLERANCE => {}
            _ => {
                return Err(st.failed(
                    bl,
                    format!(
                        "the chamfers at vertex {vname} do not close with a planar corner (their bevels meet beyond the corner triangle)"
                    ),
                ));
            }
        }
        let Some(fr) = frame_zx(pts[0], n, pts[1] - pts[0]) else {
            return Err(st.failed(bl, format!("degenerate corner at vertex {vname}")));
        };
        (Surface::Plane(Plane::new(fr)), pts)
    };
    // Check each corner point lies on the contacts of the two blends on its face.
    for (i, &f) in faces.iter().enumerate() {
        for g in gs.iter().filter(|g| g.side_of(f).is_some()) {
            let k = g.side_of(f).expect("side");
            let c = &g.contact[k];
            let (t, _) = c.project(pts[i]);
            if c.eval(t).distance(pts[i]) > LINEAR_TOLERANCE {
                return Err(st.failed(bl, format!("inconsistent corner at vertex {vname}")));
            }
        }
    }
    let mut vids = Vec::with_capacity(3);
    for (i, &f) in faces.iter().enumerate() {
        let mut ks = vec![cx.fkey[f].clone(), corner_key.clone()];
        for (j, g) in gs.iter().enumerate() {
            if g.side_of(f).is_some() {
                ks.push(blend_keys[j].clone());
            }
        }
        vids.push(st.new_vertex(pts[i], ks));
    }
    // The sphere's normal points out of the ball (outward for a convex corner); the corner
    // plane's frame z was oriented outward above.
    let sense = match &surf {
        Surface::Sphere(_) => convex,
        _ => true,
    };
    let q = match &surf {
        Surface::Sphere(s) => Some(s.frame().origin()),
        _ => None,
    };
    let mut arcs = Vec::with_capacity(3);
    for (j, g) in gs.iter().enumerate() {
        let (ia, ib) = (
            faces.iter().position(|&f| f == g.a).expect("face"),
            faces.iter().position(|&f| f == g.b).expect("face"),
        );
        let (pa, pb) = (pts[ia], pts[ib]);
        let (curve, mid) = match q {
            Some(q) => {
                let Fam::Line { t, .. } = g.fam else {
                    unreachable!("line family")
                };
                let Some(fr) = frame_zx(q, t, pa - q) else {
                    return Err(st.failed(bl, format!("degenerate corner at vertex {vname}")));
                };
                let circ = forge_core::geom::Circle3::new(fr, g.r)
                    .ok()
                    .map(Curve3::Circle);
                let m = ((pa + pb) * 0.5 - q).normalize().map(|d| q + d * g.r);
                match (circ, m) {
                    (Some(c), Some(m)) => (c, m),
                    _ => {
                        return Err(st.failed(bl, format!("degenerate corner at vertex {vname}")));
                    }
                }
            }
            None => {
                let Some(l) = crate::geom::dir(pa, pb).and_then(|d| line(pa, d)) else {
                    return Err(st.failed(bl, format!("degenerate corner at vertex {vname}")));
                };
                (l, (pa + pb) * 0.5)
            }
        };
        let prov = crate::keys::edge_between(cx.feature, &blend_keys[j], &corner_key);
        let ae = st.new_edge(curve, vids[ia], vids[ib], mid, prov, &[g.e], usize::MAX)?;
        st.ends.insert((v, g.a, g.e), vids[ia]);
        st.ends.insert((v, g.b, g.e), vids[ib]);
        st.closers.insert((v, g.e), vec![ae]);
        arcs.push(ae);
    }
    // The material each blend removes (fills) ends at its closing curve's plane; the corner
    // cell between those planes and the vertex is the corner patch's.
    // Into the cell: the material side of the faces at a convex corner, the air side at a
    // concave one.
    let cell_faces: Vec<(usize, Point3, forge_core::linalg::Vec3)> = faces
        .iter()
        .zip(&normals)
        .map(|(&f, &n)| (f, vp, if convex { -n } else { n }))
        .collect();
    let mut cell_planes = Vec::with_capacity(3);
    for g in &gs {
        let Some(t_in) = tangent_away(cx.plan0, g.e, v) else {
            return Err(st.failed(bl, format!("degenerate corner at vertex {vname}")));
        };
        match (&q, &surf) {
            (Some(q), _) => {
                st.endk.insert((v, g.e), EndKind::Plane { o: *q, n: t_in });
                cell_planes.push((*q, -t_in));
            }
            (None, Surface::Plane(pl)) => {
                let n = pl.frame().z();
                let away = if (vp - pts[0]).dot(n) > 0.0 { -n } else { n };
                st.endk
                    .insert((v, g.e), EndKind::Plane { o: pts[0], n: away });
            }
            _ => {}
        }
    }
    let interior = match (&q, &surf) {
        (Some(q), _) => Interior::Ball { c: *q, r: gs[0].r },
        (None, Surface::Plane(pl)) => {
            let n = pl.frame().z();
            Interior::Plane {
                o: pts[0],
                n: if (vp - pts[0]).dot(n) > 0.0 { n } else { -n },
            }
        }
        _ => unreachable!("sphere or plane corner"),
    };
    st.cells.push(Cell {
        v,
        edges: bl.to_vec(),
        faces: cell_faces,
        planes: cell_planes,
        interior,
    });
    let shell = cx.plan0.fs[faces[0]].as_ref().expect("face").shell;
    st.corners.push(CornerPatch {
        v,
        surf,
        sense: Some(sense),
        arcs,
        extra: Vec::new(),
        shell,
        edges: bl.to_vec(),
    });
    Ok(())
}
