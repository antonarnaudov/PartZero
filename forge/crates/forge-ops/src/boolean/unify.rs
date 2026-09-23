//! Same-domain merging (SPEC §6.0.4): adjacent faces on the same carrier surface with the
//! same outward normal become one face; then edges on one carrier curve meeting at a vertex
//! shared by no other edge become one edge (a full circle becomes a ring edge).
//!
//! The merged face keeps the byte-wise smallest provenance key among the merged faces of
//! the **target** bodies (all faces if none is a target's); every other key becomes an alias
//! (SPEC §5.2 rule 3). Merged edges follow the same rule (target edges first, then the
//! byte-wise smallest key; the other key becomes an alias). Its loops are re-traced in the
//! surviving face's chart from the boundary coedges left after dropping the edges between
//! merged faces; pcurves from the other faces are refitted on the surviving surface.
//!
//! A merge the SPEC requires that cannot be built (a pcurve that cannot be refitted, a
//! re-traced domain that is not one face, a merged edge whose coedges are not consecutive)
//! is a `FORGE_BOOLEAN_INCONSISTENT` error naming the faces or edges: never a result whose
//! faces, edges and keys silently differ from SPEC §6.0.4.

use std::collections::{BTreeMap, BTreeSet};

use forge_core::Tolerance;
use forge_core::geom::{Curve2, Curve3, Line3, Surface};
use forge_core::linalg::{Frame, Point2, Point3};
use forge_core::math;
use forge_core::topo::{
    Body, BodyBuilder, EdgeId, EntityNames, Provenance, Severity, VertexId, has_errors, validate,
};

use super::chart::{Chart, Input, Use};
use super::error::BooleanError;
use super::geom::{
    clamp_pcurve, fit_pcurve, pcurve_error, refit_pcurve, same_carrier, shift_curve2, weld_loop,
};

#[derive(Clone, Debug)]
struct UVert {
    p: Point3,
    tol: f64,
    prov: Provenance,
}

#[derive(Clone, Debug)]
struct UEdge {
    curve: Curve3,
    range: (f64, f64),
    start: Option<usize>,
    end: Option<usize>,
    tol: f64,
    prov: Provenance,
    alive: bool,
}

#[derive(Clone, Debug)]
struct UUse {
    edge: usize,
    fwd: bool,
    pcurve: Curve2,
}

#[derive(Clone, Debug)]
struct UFace {
    surface: Surface,
    sense: bool,
    prov: Provenance,
    shell: usize,
    loops: Vec<Vec<UUse>>,
    alive: bool,
}

struct UBody {
    verts: Vec<UVert>,
    edges: Vec<UEdge>,
    faces: Vec<UFace>,
    shells: usize,
}

/// Aliases produced by a merge: `(merged key, surviving key)`.
pub type Aliases = Vec<(String, String)>;

fn load(body: &Body) -> Result<UBody, BooleanError> {
    let mut vmap: BTreeMap<VertexId, usize> = BTreeMap::new();
    let mut emap: BTreeMap<EdgeId, usize> = BTreeMap::new();
    let mut ub = UBody {
        verts: Vec::new(),
        edges: Vec::new(),
        faces: Vec::new(),
        shells: body.shell_ids().len(),
    };
    let bad = |w: &str| BooleanError::inconsistent(format!("unify: {w}"), "body");
    for (si, &sid) in body.shell_ids().iter().enumerate() {
        let sh = body.shell(sid).ok_or_else(|| bad("dangling shell"))?;
        for &fid in &sh.faces {
            let f = body.face(fid).ok_or_else(|| bad("dangling face"))?;
            let mut loops = Vec::new();
            for &lid in &f.loops {
                let lp = body.loop_(lid).ok_or_else(|| bad("dangling loop"))?;
                let mut us = Vec::new();
                for &cid in &lp.coedges {
                    let c = body.coedge(cid).ok_or_else(|| bad("dangling coedge"))?;
                    let ei = match emap.get(&c.edge) {
                        Some(&i) => i,
                        None => {
                            let e = body.edge(c.edge).ok_or_else(|| bad("dangling edge"))?;
                            let mut vid =
                                |v: Option<VertexId>| -> Result<Option<usize>, BooleanError> {
                                    let Some(v) = v else { return Ok(None) };
                                    if let Some(&i) = vmap.get(&v) {
                                        return Ok(Some(i));
                                    }
                                    let x = body.vertex(v).ok_or_else(|| bad("dangling vertex"))?;
                                    ub.verts.push(UVert {
                                        p: x.point,
                                        tol: x.tolerance,
                                        prov: x.provenance.clone(),
                                    });
                                    vmap.insert(v, ub.verts.len() - 1);
                                    Ok(Some(ub.verts.len() - 1))
                                };
                            let (s, t) = (vid(e.start)?, vid(e.end)?);
                            ub.edges.push(UEdge {
                                curve: e.curve.clone(),
                                range: e.t_range,
                                start: s,
                                end: t,
                                tol: e.tolerance,
                                prov: e.provenance.clone(),
                                alive: true,
                            });
                            emap.insert(c.edge, ub.edges.len() - 1);
                            ub.edges.len() - 1
                        }
                    };
                    us.push(UUse {
                        edge: ei,
                        fwd: c.forward,
                        pcurve: c
                            .pcurve
                            .clone()
                            .ok_or_else(|| bad("coedge without pcurve"))?,
                    });
                }
                loops.push(us);
            }
            ub.faces.push(UFace {
                surface: f.surface.clone(),
                sense: f.sense,
                prov: f.provenance.clone(),
                shell: si,
                loops,
                alive: true,
            });
        }
    }
    Ok(ub)
}

/// Which kind of entity a provenance belongs to (for [`map_provenance`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProvOf {
    Face,
    Edge,
    Vertex,
}

/// A copy of `body` with every provenance passed through `f` (`None` keeps it); `body`
/// itself when nothing changes. The geometry and topology are rebuilt unchanged.
pub(crate) fn map_provenance(
    body: &Body,
    mut f: impl FnMut(ProvOf, &Provenance) -> Option<Provenance>,
) -> Result<Body, BooleanError> {
    let mut ub = load(body)?;
    let mut changed = false;
    for x in &mut ub.faces {
        if let Some(p) = f(ProvOf::Face, &x.prov) {
            changed |= p != x.prov;
            x.prov = p;
        }
    }
    for x in &mut ub.edges {
        if let Some(p) = f(ProvOf::Edge, &x.prov) {
            changed |= p != x.prov;
            x.prov = p;
        }
    }
    for x in &mut ub.verts {
        if let Some(p) = f(ProvOf::Vertex, &x.prov) {
            changed |= p != x.prov;
            x.prov = p;
        }
    }
    if !changed {
        return Ok(body.clone());
    }
    build(&ub)
}

/// A copy of `body` translated by `t` (surfaces, curves and vertices; the parametrizations
/// move with their frames, so pcurves are unchanged).
pub(crate) fn translate_body(
    body: &Body,
    t: forge_core::linalg::Vec3,
) -> Result<Body, BooleanError> {
    let tr = forge_core::linalg::Transform::translation(t);
    let mut ub = load(body)?;
    for f in &mut ub.faces {
        f.surface = f.surface.transform(&tr);
    }
    for e in &mut ub.edges {
        e.curve = e.curve.transform(&tr);
    }
    for v in &mut ub.verts {
        v.p += t;
    }
    build(&ub)
}

fn outward_normal(f: &UFace, uv: Point2) -> Option<forge_core::linalg::Vec3> {
    let n = f.surface.normal(uv.x, uv.y)?;
    Some(if f.sense { n } else { -n })
}

/// Merge same-domain faces and then collinear / co-circular edges of `body`.
///
/// `target_keys` are the provenance keys (SPEC §5.2, `Provenance::key`) of the faces and
/// edges of the target bodies (they win the surviving key). Returns the new body and the
/// aliases `(merged key, surviving key)` of faces and edges, as SPEC §5.2 keys.
pub fn unify_same_domain(
    body: &Body,
    target_keys: &BTreeSet<String>,
) -> Result<(Body, Aliases), BooleanError> {
    let body = super::keys::normalize(body, None)?;
    let (body, aliases) = unify_keyed(&body, target_keys, None, true)?;
    Ok((super::keys::denormalize(&body)?, aliases))
}

/// [`unify_same_domain`] on a body whose edge and vertex sources are face keys (see
/// `keys`): every comparison and alias is by `Provenance::key`. `created_by`: the feature
/// id of the operation that produced the body; the sources of its own new edges and
/// vertices follow the merged faces to the surviving key (their keys name the result's
/// faces), every other entity keeps its key.
/// `sections`: merged fitted section edges get pcurves on the true intersection of their
/// two faces (`geom::fit_section_pcurve`), as the imprint fitted their pieces.
pub(crate) fn unify_keyed(
    body: &Body,
    target_keys: &BTreeSet<String>,
    created_by: Option<&str>,
    sections: bool,
) -> Result<(Body, Aliases), BooleanError> {
    let mut ub = load(body)?;
    let tol = Tolerance::IR_DEFAULT.linear;
    let mut aliases: Aliases = Vec::new();
    // Merged-away face key → surviving face key.
    let mut face_moved: BTreeMap<String, String> = BTreeMap::new();
    // ---- faces -------------------------------------------------------------------------
    let nf = ub.faces.len();
    let mut uf: Vec<usize> = (0..nf).collect();
    fn find(uf: &mut [usize], mut x: usize) -> usize {
        while uf[x] != x {
            uf[x] = uf[uf[x]];
            x = uf[x];
        }
        x
    }
    // Faces per edge.
    let mut edge_faces: Vec<Vec<(usize, usize, usize)>> = vec![Vec::new(); ub.edges.len()];
    for (fi, f) in ub.faces.iter().enumerate() {
        for (li, l) in f.loops.iter().enumerate() {
            for (k, u) in l.iter().enumerate() {
                edge_faces[u.edge].push((fi, li, k));
            }
        }
    }
    for (ei, efs) in edge_faces.iter().enumerate() {
        let [(a, la, ka), (b, lb, kb)] = efs.as_slice() else {
            continue;
        };
        if a == b {
            continue;
        }
        let (fa, fb) = (&ub.faces[*a], &ub.faces[*b]);
        if fa.shell != fb.shell || !same_carrier(&fa.surface, &fb.surface, tol) {
            continue;
        }
        // Outward normals at the edge middle.
        let e = &ub.edges[ei];
        let tm = 0.5 * (e.range.0 + e.range.1);
        let uva = fa.loops[*la][*ka].pcurve.eval(tm);
        let uvb = fb.loops[*lb][*kb].pcurve.eval(tm);
        let (Some(na), Some(nb)) = (outward_normal(fa, uva), outward_normal(fb, uvb)) else {
            continue;
        };
        if na.dot(nb) <= 0.5 {
            continue;
        }
        let (ra, rb) = (find(&mut uf, *a), find(&mut uf, *b));
        if ra != rb {
            let (lo, hi) = (ra.min(rb), ra.max(rb));
            uf[hi] = lo;
        }
    }
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for i in 0..nf {
        let r = find(&mut uf, i);
        groups.entry(r).or_default().push(i);
    }
    for members in groups.values() {
        if members.len() < 2 {
            continue;
        }
        // Surviving face: smallest key among target faces, else among all.
        let key = |i: usize| ub.faces[i].prov.key();
        let from_targets: Vec<usize> = members
            .iter()
            .copied()
            .filter(|&i| target_keys.contains(&key(i)))
            .collect();
        let pool = if from_targets.is_empty() {
            members.clone()
        } else {
            from_targets
        };
        let rep = *pool
            .iter()
            .min_by(|&&x, &&y| key(x).cmp(&key(y)).then(x.cmp(&y)))
            .expect("non-empty");
        let set: BTreeSet<usize> = members.iter().copied().collect();
        // Boundary coedges: edges not shared by two faces of the group.
        let mut count: BTreeMap<usize, usize> = BTreeMap::new();
        for &fi in members {
            for u in ub.faces[fi].loops.iter().flatten() {
                *count.entry(u.edge).or_insert(0) += 1;
            }
        }
        let rsurf = ub.faces[rep].surface.clone();
        let rsense = ub.faces[rep].sense;
        let mut inputs = Vec::new();
        let mut uses: Vec<UUse> = Vec::new();
        let names = || {
            members
                .iter()
                .map(|&i| key(i))
                .collect::<Vec<_>>()
                .join(" + ")
        };
        for &fi in members {
            let f = &ub.faces[fi];
            for u in f.loops.iter().flatten() {
                if count[&u.edge] >= 2 {
                    continue;
                }
                let e = &ub.edges[u.edge];
                let pc = if fi == rep {
                    u.pcurve.clone()
                } else {
                    let near = {
                        let p = e.curve.eval(e.range.0);
                        let (uu, vv, _) = rsurf.project(p);
                        Some(Point2::new(uu, vv))
                    };
                    refit_pcurve(&rsurf, &e.curve, e.range, near, &f.surface, &u.pcurve)
                        .map_err(|x| {
                            BooleanError::inconsistent(
                                format!(
                                    "same-domain merge: boundary pcurve of {}: {x}",
                                    e.prov.name()
                                ),
                                names(),
                            )
                        })?
                        .0
                };
                inputs.push(Input {
                    pcurve: pc.clone(),
                    range: e.range,
                    start: e.start,
                    end: e.end,
                    use_: Use::Boundary(u.fwd),
                });
                uses.push(UUse {
                    edge: u.edge,
                    fwd: u.fwd,
                    pcurve: pc,
                });
            }
        }
        let merge_err = |what: String| {
            BooleanError::inconsistent(format!("same-domain merge: {what}"), names())
        };
        let chart = Chart::build(&rsurf, rsense, inputs)
            .map_err(|x| merge_err(format!("domain of the merged face: {x}")))?;
        let outs = chart
            .faces()
            .map_err(|x| merge_err(format!("faces of the merged domain: {x}")))?;
        if outs.len() != 1 {
            return Err(merge_err(format!(
                "the merged domain has {} faces, not one",
                outs.len()
            )));
        }
        let loops: Vec<Vec<UUse>> = outs[0]
            .loops
            .iter()
            .map(|l| {
                l.iter()
                    .map(|&(i, fw)| UUse {
                        edge: uses[i].edge,
                        fwd: fw,
                        pcurve: uses[i].pcurve.clone(),
                    })
                    .collect()
            })
            .collect();
        // Commit: internal edges die, other faces die.
        for (&e, &c) in &count {
            if c >= 2 {
                ub.edges[e].alive = false;
            }
        }
        let kept = ub.faces[rep].prov.key();
        for &fi in members {
            if fi != rep {
                ub.faces[fi].alive = false;
                let k = ub.faces[fi].prov.key();
                if k != kept {
                    face_moved.insert(k.clone(), kept.clone());
                    aliases.push((k, kept.clone()));
                }
            }
        }
        ub.faces[rep].loops = loops;
        let _ = set;
    }
    // The operation's own new edges and vertices name the result's faces.
    if let Some(feature) = created_by
        && !face_moved.is_empty()
    {
        let follow = |p: &mut Provenance| {
            if p.feature != feature
                || !matches!(
                    p.role,
                    forge_core::topo::Role::EdgeBetween | forge_core::topo::Role::VertexAt
                )
            {
                return;
            }
            let mut v: Vec<String> = p
                .sources
                .iter()
                .map(|s| face_moved.get(s).cloned().unwrap_or_else(|| s.clone()))
                .collect();
            if p.role == forge_core::topo::Role::VertexAt {
                v.sort();
                v.dedup();
            }
            p.sources = v.into_iter().collect();
        };
        for e in ub.edges.iter_mut().filter(|e| e.alive) {
            follow(&mut e.prov);
        }
        for v in &mut ub.verts {
            follow(&mut v.prov);
        }
    }
    // ---- edges ---------------------------------------------------------------------------
    loop {
        if !merge_one_edge_pair(&mut ub, target_keys, &mut aliases, sections)? {
            break;
        }
    }
    ringify_closed_edges(&mut ub);
    normalize_closed_faces(&mut ub)?;
    weld_faces(&mut ub)?;
    let body = build(&ub)?;
    aliases.sort();
    aliases.dedup();
    Ok((body, aliases))
}

/// `true` if two curves lie on one carrier (same line, same circle).
fn same_curve(a: &Curve3, b: &Curve3, tol: f64) -> bool {
    match (a, b) {
        (Curve3::Line(x), Curve3::Line(y)) => {
            x.dir().cross(y.dir()).norm() <= 1e-9
                && (y.origin() - x.origin()).cross(x.dir()).norm() <= tol
        }
        (Curve3::Circle(x), Curve3::Circle(y)) => {
            (x.radius() - y.radius()).abs() <= tol
                && x.frame().origin().distance(y.frame().origin()) <= tol
                && x.frame().z().cross(y.frame().z()).norm() <= 1e-9
        }
        // Parameters must agree too (the merge keeps one parametrization).
        (Curve3::Ellipse(x), Curve3::Ellipse(y)) => {
            (x.rx() - y.rx()).abs() <= tol
                && (x.ry() - y.ry()).abs() <= tol
                && x.frame().origin().distance(y.frame().origin()) <= tol
                && x.frame().z().distance(y.frame().z()) <= 1e-9
                && x.frame().x().distance(y.frame().x()) <= 1e-9
        }
        // Pieces of one intersection curve share the curve itself.
        (Curve3::BSpline(x), Curve3::BSpline(y)) => x == y,
        _ => false,
    }
}

/// A closed edge whose one vertex no other edge uses, alone in every loop using it, is a
/// ring (ADR 0012): drop the vertex (a circle or ellipse over a whole period, or a closed
/// B-spline over its whole domain).
fn ringify_closed_edges(ub: &mut UBody) {
    let mut inc: BTreeMap<usize, usize> = BTreeMap::new();
    for e in ub.edges.iter().filter(|e| e.alive) {
        for v in [e.start, e.end].into_iter().flatten() {
            *inc.entry(v).or_default() += 1;
        }
    }
    for ei in 0..ub.edges.len() {
        let e = &ub.edges[ei];
        let (Some(a), Some(b)) = (e.start, e.end) else {
            continue;
        };
        if !e.alive || a != b || inc.get(&a) != Some(&2) {
            continue;
        }
        let full = match &e.curve {
            Curve3::Circle(_) | Curve3::Ellipse(_) => {
                (e.range.1 - e.range.0 - math::TAU).abs() <= 1e-9 * math::TAU
            }
            Curve3::BSpline(nc) => nc.domain() == e.range,
            Curve3::Line(_) => false,
        };
        let alone = ub.faces.iter().filter(|f| f.alive).all(|f| {
            f.loops
                .iter()
                .all(|l| !l.iter().any(|u| u.edge == ei) || l.len() == 1)
        });
        // A ring's pcurves close up (modulo periods) on every face. A closed curve through a
        // cone apex or sphere pole has pcurve ends at two points of the singular line: its
        // vertex there stays (a ring through a singular point is no chart loop).
        let closes = ub.faces.iter().filter(|f| f.alive).all(|f| {
            f.loops.iter().flatten().filter(|u| u.edge == ei).all(|u| {
                let (a, b) = (u.pcurve.eval(e.range.0), u.pcurve.eval(e.range.1));
                let (pu, pv) = f.surface.periodicity();
                let wrap = |d: f64, p: Option<f64>| match p {
                    Some(p) => d - (d / p).round() * p,
                    None => d,
                };
                let d = b - a;
                wrap(d.x, pu).abs() <= 1e-9 * (1.0 + a.x.abs())
                    && wrap(d.y, pv).abs() <= 1e-9 * (1.0 + a.y.abs())
            })
        });
        if full && alone && closes {
            ub.edges[ei].start = None;
            ub.edges[ei].end = None;
        }
    }
}

/// Merge one pair of edges at a vertex of degree 2 lying on one carrier curve with the same
/// two faces on both sides. Returns `false` when nothing is left to merge. The merged edge
/// keeps the target edge's key (the byte-wise smallest if both or neither are a target's);
/// the other key becomes an alias.
fn merge_one_edge_pair(
    ub: &mut UBody,
    target_keys: &BTreeSet<String>,
    aliases: &mut Aliases,
    sections: bool,
) -> Result<bool, BooleanError> {
    let tol = Tolerance::IR_DEFAULT.linear;
    // Incident alive edges per vertex, and faces per edge (by coedge).
    let mut inc: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (ei, e) in ub.edges.iter().enumerate() {
        if !e.alive {
            continue;
        }
        for v in [e.start, e.end].into_iter().flatten() {
            inc.entry(v).or_default().push(ei);
        }
    }
    let mut efaces: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (fi, f) in ub.faces.iter().enumerate() {
        if !f.alive {
            continue;
        }
        for u in f.loops.iter().flatten() {
            efaces.entry(u.edge).or_default().push(fi);
        }
    }
    for (&v, es) in &inc {
        if es.len() != 2 || es[0] == es[1] {
            continue;
        }
        let (e1, e2) = (es[0], es[1]);
        let (c1, c2) = (&ub.edges[e1], &ub.edges[e2]);
        if !same_curve(&c1.curve, &c2.curve, tol) {
            continue;
        }
        let (mut f1, mut f2) = (efaces[&e1].clone(), efaces[&e2].clone());
        f1.sort_unstable();
        f2.sort_unstable();
        if f1 != f2 || f1.len() != 2 || f1[0] == f1[1] {
            continue;
        }
        // A vertex at a singular point of a face's surface (a sphere pole, a cone apex) is
        // where that face's boundary runs along the singular line (ADR 0012: an edge never
        // passes through a singular point, its pcurve cannot): the vertex stays, like the
        // degenerate pole edge OCCT keeps there.
        let pv = ub.verts[v].p;
        if f1
            .iter()
            .any(|&fi| super::geom::singular_v_at(&ub.faces[fi].surface, pv, tol).is_some())
        {
            continue;
        }
        // Other ends.
        let other = |e: &UEdge| if e.start == Some(v) { e.end } else { e.start };
        let (a, b) = (other(c1), other(c2));
        // Orientation: walk e1 towards v then e2 away from v (on e1's curve).
        let mut curve = c1.curve.clone();
        let p_a = a.map(|x| ub.verts[x].p);
        let p_b = b.map(|x| ub.verts[x].p);
        let e1_ends_at_v = c1.end == Some(v);
        // Parameter range on e1's curve from a through v to b.
        let (t_start, t_end, from, to) = match &curve {
            Curve3::Line(l) => {
                let ta = if e1_ends_at_v { c1.range.0 } else { c1.range.1 };
                let tb = l.project(p_b.expect("open")).0;
                if e1_ends_at_v {
                    (ta, tb, a, b)
                } else {
                    (tb, ta, b, a)
                }
            }
            Curve3::Circle(_) | Curve3::Ellipse(_) => {
                let per = math::TAU;
                let proj = |p: Point3| match &curve {
                    Curve3::Circle(c) => c.project(p).0,
                    Curve3::Ellipse(c) => c.project(p).0,
                    _ => unreachable!(),
                };
                if e1_ends_at_v {
                    let ta = c1.range.0;
                    let tv = c1.range.1;
                    let tb0 = proj(p_b.expect("open"));
                    let tb = tv + math::rem_euclid(tb0 - tv, per);
                    (ta, tb, a, b)
                } else {
                    let ta = c1.range.1;
                    let tv = c1.range.0;
                    let tb0 = proj(p_b.expect("open"));
                    let tb = tv - math::rem_euclid(tv - tb0, per);
                    (tb, ta, b, a)
                }
            }
            Curve3::BSpline(nc) => {
                // Pieces of one (possibly closed) B-spline: contiguous in its parameter, or
                // meeting across its closure (then concatenated, exactly).
                let (first, second) = if e1_ends_at_v { (c1, c2) } else { (c2, c1) };
                if first.end != Some(v) || second.start != Some(v) {
                    continue;
                }
                let (d0, d1) = nc.domain();
                let near = |x: f64, y: f64| (x - y).abs() <= 1e-9 * (1.0 + x.abs().max(y.abs()));
                if near(first.range.1, second.range.0) {
                    (first.range.0, second.range.1, first.start, second.end)
                } else if near(first.range.1, d1) && near(second.range.0, d0) {
                    let cat = super::geom::nurbs_segment(nc, first.range.0, d1)
                        .zip(super::geom::nurbs_segment(nc, d0, second.range.1))
                        .and_then(|(x, y)| super::geom::nurbs_concat(&x, &y))
                        .ok_or_else(|| {
                            BooleanError::inconsistent(
                                "same-domain edge merge: the pieces of a closed intersection curve do not concatenate",
                                format!("{} + {}", first.prov.name(), second.prov.name()),
                            )
                        })?;
                    let dom = cat.domain();
                    curve = Curve3::BSpline(cat);
                    (dom.0, dom.1, first.start, second.end)
                } else {
                    continue;
                }
            }
        };
        if t_end.partial_cmp(&t_start) != Some(std::cmp::Ordering::Greater) {
            continue;
        }
        let closed = from == to;
        let range = if closed {
            match &curve {
                Curve3::Circle(_) | Curve3::Ellipse(_) => (t_start, t_start + math::TAU),
                // The whole closed B-spline.
                Curve3::BSpline(nc) if nc.domain() == (t_start, t_end) => (t_start, t_end),
                _ => continue,
            }
        } else {
            (t_start, t_end)
        };
        let _ = p_a;
        // The coedges: every face using e1/e2 must traverse them consecutively.
        let mut new_uses: Vec<(usize, usize, Vec<UUse>)> = Vec::new();
        for &fi in &f1 {
            let f = &ub.faces[fi];
            for (li, l) in f.loops.iter().enumerate() {
                if !l.iter().any(|u| u.edge == e1 || u.edge == e2) {
                    continue;
                }
                // Direction of the merged edge in this loop: e1's use direction relative to
                // the merged orientation.
                let u1 = l.iter().find(|u| u.edge == e1).expect("uses e1");
                let e1_along = (c1.start == from || c1.end == to) == c1.start.is_some();
                let _ = e1_along;
                // Merged edge orientation vs e1: both on e1's curve with increasing t, so a
                // forward use of e1 is a forward use of the merged edge.
                let fwd = u1.fwd;
                // The period copy near the merged edge's start (on e1 or on e2).
                let near = if curve.eval(range.0).distance(c1.curve.eval(c1.range.0)) <= tol {
                    Some(u1.pcurve.eval(c1.range.0))
                } else {
                    l.iter()
                        .find(|u| u.edge == e2)
                        .map(|u2| u2.pcurve.eval(c2.range.0))
                        .or(Some(u1.pcurve.eval(c1.range.0)))
                };
                // A merged fitted section keeps its faces on the true intersection (as the
                // imprint put its pieces: `fit_section_pcurve`).
                let other = f1.iter().copied().find(|&x| x != fi);
                let section = match (&curve, other) {
                    (Curve3::BSpline(_), Some(o)) if sections => super::geom::fit_section_pcurve(
                        &f.surface,
                        &ub.faces[o].surface,
                        &curve,
                        range,
                        near,
                    ),
                    _ => None,
                };
                let fitted = section.unwrap_or_else(|| fit_pcurve(&f.surface, &curve, range, near));
                let pc = fitted
                    .map_err(|x| {
                        BooleanError::inconsistent(
                            format!("same-domain edge merge: pcurve on {}: {x}", f.prov.name()),
                            format!("{} + {}", c1.prov.name(), c2.prov.name()),
                        )
                    })?
                    .0;
                let mut nl: Vec<UUse> = Vec::new();
                let mut placed = false;
                for u in l {
                    if u.edge == e1 || u.edge == e2 {
                        if !placed {
                            nl.push(UUse {
                                edge: e1,
                                fwd,
                                pcurve: pc.clone(),
                            });
                            placed = true;
                        }
                    } else {
                        nl.push(u.clone());
                    }
                }
                // Rotate so a loop that started with e2 and ended with e1 stays consistent.
                new_uses.push((fi, li, nl));
            }
        }
        // Check loop continuity after the replacement (e1 then e2 must have been adjacent
        // in the loop, cyclically).
        for &(fi, li, _) in &new_uses {
            let l = &ub.faces[fi].loops[li];
            let pos1 = l.iter().position(|u| u.edge == e1);
            let pos2 = l.iter().position(|u| u.edge == e2);
            let n = l.len();
            let consecutive = match (pos1, pos2) {
                (Some(p1), Some(p2)) => (p1 + 1) % n == p2 || (p2 + 1) % n == p1,
                _ => false,
            };
            if !consecutive {
                return Err(BooleanError::inconsistent(
                    "same-domain edge merge: the coedges of the two edges are not consecutive in a loop",
                    format!(
                        "{} + {} on {}",
                        c1.prov.name(),
                        c2.prov.name(),
                        ub.faces[fi].prov.name()
                    ),
                ));
            }
        }
        // Commit: the target edge's key, else the byte-wise smallest; the other is an alias.
        let name1 = c1.prov.key();
        let name2 = c2.prov.key();
        let (t1, t2) = (target_keys.contains(&name1), target_keys.contains(&name2));
        let second_wins = if t1 != t2 { t2 } else { name2 < name1 };
        let (prov, loser, winner) = if second_wins {
            (c2.prov.clone(), name1, name2)
        } else {
            (c1.prov.clone(), name2, name1)
        };
        if loser != winner {
            aliases.push((loser, winner));
        }
        let tol_e = c1.tol.max(c2.tol);
        let new_curve = match (&curve, closed) {
            (Curve3::Line(l), _) => Curve3::Line(
                Line3::new(l.origin(), l.dir())
                    .map_err(|_| BooleanError::inconsistent("unify: line", "edge merge"))?,
            ),
            _ => curve.clone(),
        };
        // A closed merged edge is a ring only when it is alone in every loop using it.
        let ring = closed && new_uses.iter().all(|(_, _, nl)| nl.len() == 1);
        ub.edges[e1] = UEdge {
            curve: new_curve,
            range,
            start: if ring { None } else { from },
            end: if ring { None } else { to },
            tol: tol_e,
            prov,
            alive: true,
        };
        ub.edges[e2].alive = false;
        for (fi, li, nl) in new_uses {
            ub.faces[fi].loops[li] = nl;
        }
        // A closed merged edge with one vertex left: a ring when that vertex is only used
        // by it (handled by `closed`); the removed vertex `v` is simply no longer used.
        return Ok(true);
    }
    Ok(false)
}

/// Net displacement of a loop in whole periods `(k_u, k_v)` and its signed area in the
/// face's orientation (`σ·½∮(u dv − v du)` of the continuously lifted pcurves; meaningful
/// for contractible loops).
fn loop_winding(f: &UFace, l: &[UUse], edges: &[UEdge]) -> (i64, i64, f64) {
    let (pu, pv) = f.surface.periodicity();
    let sigma = if f.sense { 1.0 } else { -1.0 };
    let mut offset = forge_core::linalg::Vec2::zero();
    let mut prev_end: Option<Point2> = None;
    let mut first_start: Option<Point2> = None;
    let mut area = 0.0;
    for u in l {
        let e = &edges[u.edge];
        let (t0, t1) = if u.fwd {
            e.range
        } else {
            (e.range.1, e.range.0)
        };
        let start = u.pcurve.eval(t0);
        if let Some(pe) = prev_end {
            let d = pe - (start + offset);
            if let Some(p) = pu {
                offset.x += (d.x / p).round() * p;
            }
            if let Some(p) = pv {
                offset.y += (d.y / p).round() * p;
            }
        }
        if first_start.is_none() {
            first_start = Some(start + offset);
        }
        let n = 64;
        let mut prev = start + offset;
        for i in 1..=n {
            let t = t0 + (t1 - t0) * i as f64 / n as f64;
            let q = u.pcurve.eval(t) + offset;
            area += 0.5 * (prev.x * q.y - prev.y * q.x);
            prev = q;
        }
        prev_end = Some(u.pcurve.eval(t1) + offset);
    }
    let (Some(a), Some(b)) = (first_start, prev_end) else {
        return (0, 0, 0.0);
    };
    let d = b - a;
    let k = |x: f64, p: Option<f64>| p.map_or(0, |p| (x / p).round() as i64);
    // Close the lifted polygon for the area (contractible loops end where they start).
    area += 0.5 * (b.x * a.y - b.y * a.x);
    (k(d.x, pu), k(d.y, pv), sigma * area)
}

/// Faces on closed surfaces whose loops are all contractible holes cover both singular
/// points of a sphere, or a torus minus disks. forge-check's boundary formulation (and
/// ADR 0012's Euler adaptation) needs the region to reach a singular line through a
/// wrapping loop, so a sphere face is re-parametrized with a pole inside a hole and the
/// other inside the face ([`reparametrize_sphere`]; the geometry is unchanged, pcurves are
/// refitted), as is a sphere face whose loops all start and end on one pole; a torus
/// minus disks (genus 1 with boundary) is reported as unsupported rather than returned
/// unmeasurable.
fn normalize_closed_faces(ub: &mut UBody) -> Result<(), BooleanError> {
    for fi in 0..ub.faces.len() {
        if !ub.faces[fi].alive || ub.faces[fi].loops.is_empty() {
            continue;
        }
        let is_sphere = matches!(ub.faces[fi].surface, Surface::Sphere(_));
        let is_torus = matches!(ub.faces[fi].surface, Surface::Torus(_));
        if !is_sphere && !is_torus {
            continue;
        }
        let w: Vec<(i64, i64, f64)> = ub.faces[fi]
            .loops
            .iter()
            .map(|l| loop_winding(&ub.faces[fi], l, &ub.edges))
            .collect();
        if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
            eprintln!("closed face {}: windings {w:?}", ub.faces[fi].prov.name());
        }
        let contractible = w.iter().all(|x| x.0 == 0 && x.1 == 0);
        let has_outer = w.iter().any(|x| x.0 == 0 && x.1 == 0 && x.2 > 0.0);
        if is_torus {
            let wraps_u = w.iter().any(|x| x.0 != 0);
            let wraps_v = w.iter().any(|x| x.1 != 0);
            if (contractible && !has_outer) || (wraps_u && wraps_v) {
                return Err(BooleanError::Unsupported {
                    what: "torus face that is not a planar domain (torus minus disks); forge-check cannot measure it yet",
                    entity: ub.faces[fi].prov.name(),
                });
            }
            align_torus_loops(&mut ub.faces[fi], &w, &ub.edges);
            continue;
        }
        // A loop through a pole vertex already reaches the singular line (a lune between
        // two meridians): the face is measurable as it is, and re-parametrizing would turn
        // its exact meridian pcurves into fitted ones.
        let at_pole = |v: usize| {
            super::geom::singular_v_at(&ub.faces[fi].surface, ub.verts[v].p, ub.verts[v].tol)
        };
        let ends: Vec<Option<usize>> = ub.faces[fi]
            .loops
            .iter()
            .flatten()
            .flat_map(|u| [ub.edges[u.edge].start, ub.edges[u.edge].end])
            .collect();
        let through_pole = ends.iter().flatten().any(|&v| at_pole(v).is_some());
        // Every loop of the face starts and ends on one pole (a figure-eight through a pole
        // at the double point of a tangent section, a closed edge through a pole): the
        // loops' end points then say nothing about which side of the boundary the face lies
        // on, and forge-check's band reading (the singular line beyond the highest *end
        // point*) would pick that pole and integrate the complement with the wrong sign.
        // Such a face is re-parametrized with no vertex on a pole.
        let one_pole = {
            let mut vs = ends.iter().map(|v| v.and_then(at_pole));
            match vs.next() {
                Some(Some(first)) => vs.all(|x| x.is_some_and(|y| y.to_bits() == first.to_bits())),
                _ => false,
            }
        };
        let holes_only = contractible && !has_outer;
        if (!holes_only || through_pole) && !one_pole {
            continue;
        }
        reparametrize_sphere(ub, fi)?;
    }
    Ok(())
}

/// Chord distance on the unit sphere below which a pole candidate counts as touching a
/// loop (a fitted pcurve through a point this close to a pole would slide along the pole
/// line).
const POLE_MARGIN_MIN: f64 = 1e-4;

/// Re-parametrize a sphere face so that its pole `z` lies inside a hole of the face, away
/// from every edge, with the opposite pole `−z` inside the face or inside another hole (also
/// away from every edge): the face is then a band from `−z` up to its loops, or the band
/// between the loops around `z` and `−z`, which forge-check reads unambiguously (no vertex
/// on a pole).
///
/// The pole is chosen in 3D, independently of the current parametrization (so the outcome
/// does not depend on the axis the sphere was revolved about). Points are classified
/// against the face by the winding number of its loops projected stereographically from a
/// point known to lie outside it (just off a loop on the side away from the face): among
/// fixed candidate directions (a Fibonacci lattice, the loops' mean directions and their
/// hole points), those outside the face, the one farthest (with its opposite) from the
/// loops, the first on ties. The geometry is unchanged; pcurves are refitted to their old
/// images.
fn reparametrize_sphere(ub: &mut UBody, fi: usize) -> Result<(), BooleanError> {
    use forge_core::linalg::Vec3;
    let name = ub.faces[fi].prov.name();
    let Surface::Sphere(sph) = &ub.faces[fi].surface else {
        return Ok(());
    };
    let c = sph.frame().origin();
    let r = sph.radius();
    let sigma = if ub.faces[fi].sense { 1.0 } else { -1.0 };
    // `σ·W` as an integer (winding numbers are integers).
    let sense = ub.faces[fi].sense;
    let sw = move |w: i64| if sense { w } else { -w };
    // Loops as unit directions from the centre, in traversal order.
    let per_edge = 256;
    let loops3: Vec<Vec<Vec3>> = ub.faces[fi]
        .loops
        .iter()
        .map(|l| {
            let mut pts = Vec::with_capacity(l.len() * per_edge);
            for u in l {
                let e = &ub.edges[u.edge];
                let (t0, t1) = if u.fwd {
                    e.range
                } else {
                    (e.range.1, e.range.0)
                };
                for i in 0..per_edge {
                    let t = t0 + (t1 - t0) * i as f64 / per_edge as f64;
                    if let Some(d) = (e.curve.eval(t) - c).normalize() {
                        pts.push(d);
                    }
                }
            }
            pts
        })
        .collect();
    // Largest sample spacing: winding numbers are resolved for points farther than twice
    // this from every loop.
    let spacing = loops3
        .iter()
        .flat_map(|l| (0..l.len()).map(move |i| (l[(i + 1) % l.len()] - l[i]).norm()))
        .fold(0.0, f64::max);
    let chord_to_loops = |q: Vec3| -> f64 {
        let mut best = f64::INFINITY;
        for l in &loops3 {
            for i in 0..l.len() {
                best = best.min(segment_distance(q, l[i], l[(i + 1) % l.len()]));
            }
        }
        best
    };
    let mut cands: Vec<Vec3> = Vec::new();
    for (li, l) in loops3.iter().enumerate() {
        let mut m = Vec3::zero();
        for &d in l {
            m += d;
        }
        if let Some(d) = m.normalize() {
            cands.push(d);
            cands.push(-d);
        }
        if let Some(d) = hole_point(&ub.faces[fi], &ub.faces[fi].loops[li], &ub.edges)
            .and_then(|p| (p - c).normalize())
        {
            cands.push(d);
        }
    }
    let n = 256;
    let golden = math::PI * (3.0 - math::sqrt(5.0));
    for i in 0..n {
        let y = 1.0 - 2.0 * (i as f64 + 0.5) / n as f64;
        let rad = math::sqrt((1.0 - y * y).max(0.0));
        let (s, co) = math::sin_cos(golden * i as f64);
        cands.push(Vec3::new(co * rad, y, s * rad));
    }
    // A point known to lie outside the face, far enough from the loops for the projection
    // from it to be resolved: a candidate `o` with `W(o) = −σ` (outside, its opposite
    // inside), else a point just off a loop on the side away from the face (the face lies
    // on the left of its loops seen from outside when `σ = 1`) as far off as the loop's
    // neighbourhood allows.
    let resolved = 2.0 * spacing;
    let outside: Option<Vec3> = cands
        .iter()
        .copied()
        .filter(|&q| chord_to_loops(q) >= resolved && chord_to_loops(-q) >= resolved)
        .find(|&q| stereo_winding_about(&loops3, q, q).is_some_and(|w| sw(w) == -1))
        .or_else(|| {
            let mut best: Option<(f64, Vec3)> = None;
            for l in &loops3 {
                for i in 0..l.len() {
                    let (a, b, nx) = (l[(i + l.len() - 1) % l.len()], l[i], l[(i + 1) % l.len()]);
                    let Some(t) = (nx - a).normalize() else {
                        continue;
                    };
                    let Some(side) = (b.cross(t) * (-sigma)).normalize() else {
                        continue;
                    };
                    for delta in [0.5, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01] {
                        if delta < resolved || best.is_some_and(|(bd, _)| delta <= bd) {
                            break;
                        }
                        let Some(o) = (b + side * delta).normalize() else {
                            continue;
                        };
                        if chord_to_loops(o) >= 0.8 * delta {
                            best = Some((delta, o));
                            break;
                        }
                    }
                }
            }
            best.map(|(_, o)| o)
        });
    // `[q ∈ face]`: the winding of the loops projected from the outside point.
    let inside = |q: Vec3| -> Option<bool> {
        let o = outside?;
        stereo_winding_about(&loops3, -o, q).and_then(|w| match sw(w) {
            1 => Some(true),
            0 => Some(false),
            _ => None,
        })
    };
    // (margin, pole, opposite pole inside the face)
    let mut best: Option<(f64, Vec3, bool)> = None;
    for &q in &cands {
        let margin = chord_to_loops(q).min(chord_to_loops(-q));
        if margin < POLE_MARGIN_MIN || best.is_some_and(|(b, _, _)| margin <= b) {
            continue;
        }
        // `W(q) = [q ∈ face] − [−q ∈ face]` decides unless both or neither lie in the face;
        // then the classifier against the outside point does.
        let Some(w) = stereo_winding_about(&loops3, q, q) else {
            continue;
        };
        match sw(w) {
            -1 => best = Some((margin, q, true)),
            0 if inside(q) == Some(false) => best = Some((margin, q, false)),
            _ => {}
        }
    }
    let Some((_, z, opposite_in_face)) = best else {
        return Err(BooleanError::inconsistent(
            "sphere re-parametrization: no pole direction inside a hole, away from the loops",
            name,
        ));
    };
    let frame = Frame::from_normal(c, z).ok_or_else(|| {
        BooleanError::inconsistent("sphere re-parametrization frame", name.clone())
    })?;
    let ns: Surface = forge_core::geom::Sphere::new(frame, r)
        .map_err(|_| BooleanError::inconsistent("sphere re-parametrization", name.clone()))?
        .into();
    let old = ub.faces[fi].surface.clone();
    let mut loops = ub.faces[fi].loops.clone();
    for l in &mut loops {
        for u in l.iter_mut() {
            let e = &ub.edges[u.edge];
            let (pc, _) = refit_pcurve(&ns, &e.curve, e.range, None, &old, &u.pcurve)?;
            u.pcurve = pc;
        }
    }
    ub.faces[fi].surface = ns;
    ub.faces[fi].loops = loops;
    // The loops now wind around the new poles as forge-check must read them: once around
    // `z` in total when the face reaches down to `−z` (σ·Σ k_u = −1); around `z` and `−z`
    // in opposite senses when both lie in holes (Σ k_u = 0, a band between them); or not at
    // all when neither pole is enclosed (a disc with holes, its outer loop of positive
    // area: a face that only touched a pole before).
    let wa: Vec<(i64, i64, f64)> = ub.faces[fi]
        .loops
        .iter()
        .map(|l| loop_winding(&ub.faces[fi], l, &ub.edges))
        .collect();
    let ws: Vec<i64> = wa.iter().map(|x| x.0).collect();
    let w: i64 = ws.iter().sum();
    let ok = if opposite_in_face {
        sw(w) == -1
    } else {
        (w == 0 && ws.iter().filter(|&&x| x != 0).count() == 2)
            || (wa.iter().all(|x| x.0 == 0 && x.1 == 0) && wa.iter().any(|x| x.2 > 0.0))
    };
    if !ok {
        return Err(BooleanError::inconsistent(
            format!("sphere re-parametrization: the loops wind {ws:?} times around the new pole"),
            name,
        ));
    }
    Ok(())
}

/// Chord distance from `q` to the segment `a b`.
fn segment_distance(
    q: forge_core::linalg::Vec3,
    a: forge_core::linalg::Vec3,
    b: forge_core::linalg::Vec3,
) -> f64 {
    let d = b - a;
    let l2 = d.dot(d);
    let s = if l2 > 0.0 {
        ((q - a).dot(d) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (q - (a + d * s)).norm()
}

/// Winding number of closed loops of unit directions (seen from outside the unit sphere)
/// around `q`, from their stereographic projection from `−s` onto the plane tangent at `s`
/// (orientation as seen from outside at `s`). For `s = q` it is `[q ∈ R] − [−q ∈ R]` of the
/// region `R` on the loops' left; for `−s` outside `R`, `[q ∈ R]`. `None` when a step turns
/// by more than 2 rad (the sampling cannot resolve it) or a point projects to infinity.
fn stereo_winding_about(
    loops: &[Vec<forge_core::linalg::Vec3>],
    s: forge_core::linalg::Vec3,
    q: forge_core::linalg::Vec3,
) -> Option<i64> {
    use forge_core::linalg::Vec3;
    let e1 = {
        let a = if s.x.abs() < 0.6 {
            Vec3::new(1.0, 0.0, 0.0)
        } else {
            Vec3::new(0.0, 1.0, 0.0)
        };
        (a - s * a.dot(s)).normalize()?
    };
    let e2 = s.cross(e1);
    let proj = |d: Vec3| -> Option<(f64, f64)> {
        let k = 1.0 + d.dot(s);
        (k > 1e-12).then(|| (d.dot(e1) / k, d.dot(e2) / k))
    };
    let pq = proj(q)?;
    let mut total = 0.0;
    for l in loops {
        let pts: Vec<(f64, f64)> = l
            .iter()
            .map(|&d| proj(d).map(|p| (p.0 - pq.0, p.1 - pq.1)))
            .collect::<Option<_>>()?;
        for i in 0..pts.len() {
            let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
            let step = math::atan2(a.0 * b.1 - a.1 * b.0, a.0 * b.0 + a.1 * b.1);
            if step.abs() > 2.0 {
                return None;
            }
            total += step;
        }
    }
    let w = total / math::TAU;
    let k = w.round();
    ((w - k).abs() <= 0.1).then_some(k as i64)
}

/// A point inside the region a contractible loop of a sphere face bounds in `(u, v)` (a
/// hole of the face): the middle of the widest inside interval of horizontal lines across
/// the loop's polygon, widths measured on the sphere (`du · cos v`).
fn hole_point(f: &UFace, l: &[UUse], edges: &[UEdge]) -> Option<Point3> {
    let per = f.surface.periodicity();
    // Continuously lifted polygon.
    let mut poly: Vec<Point2> = Vec::new();
    let mut offset = forge_core::linalg::Vec2::zero();
    let mut prev_end: Option<Point2> = None;
    for u in l {
        let e = &edges[u.edge];
        let (t0, t1) = if u.fwd {
            e.range
        } else {
            (e.range.1, e.range.0)
        };
        let st = u.pcurve.eval(t0);
        if let Some(pe) = prev_end {
            let d = pe - (st + offset);
            if let Some(p) = per.0 {
                offset.x += (d.x / p).round() * p;
            }
            if let Some(p) = per.1 {
                offset.y += (d.y / p).round() * p;
            }
        }
        for i in 0..64 {
            poly.push(u.pcurve.eval(t0 + (t1 - t0) * i as f64 / 64.0) + offset);
        }
        prev_end = Some(u.pcurve.eval(t1) + offset);
    }
    let (vmin, vmax) = poly
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), p| {
            (a.min(p.y), b.max(p.y))
        });
    if vmax.partial_cmp(&vmin) != Some(std::cmp::Ordering::Greater) {
        return None;
    }
    let n = poly.len();
    let mut best: Option<(f64, Point2)> = None;
    for k in 1..16 {
        let y = vmin + (vmax - vmin) * k as f64 / 16.0;
        let mut xs: Vec<f64> = Vec::new();
        for i in 0..n {
            let (a, b) = (poly[i], poly[(i + 1) % n]);
            if (a.y <= y) != (b.y <= y) {
                xs.push(a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y));
            }
        }
        xs.sort_by(f64::total_cmp);
        for pair in xs.chunks_exact(2) {
            let w = (pair[1] - pair[0]) * math::cos(y);
            if best.is_none_or(|(bw, _)| w > bw) {
                best = Some((w, Point2::new(0.5 * (pair[0] + pair[1]), y)));
            }
        }
    }
    let (_, q) = best?;
    Some(f.surface.eval(q.x, q.y))
}

/// Mean parameter point of a loop (first coedge's period copy, continuously lifted).
fn loop_mean(l: &[UUse], edges: &[UEdge], per: (Option<f64>, Option<f64>)) -> Point2 {
    let mut sum = forge_core::linalg::Vec2::zero();
    let mut n: f64 = 0.0;
    let mut offset = forge_core::linalg::Vec2::zero();
    let mut prev_end: Option<Point2> = None;
    for u in l {
        let e = &edges[u.edge];
        let (t0, t1) = if u.fwd {
            e.range
        } else {
            (e.range.1, e.range.0)
        };
        let st = u.pcurve.eval(t0);
        if let Some(pe) = prev_end {
            let d = pe - (st + offset);
            if let Some(p) = per.0 {
                offset.x += (d.x / p).round() * p;
            }
            if let Some(p) = per.1 {
                offset.y += (d.y / p).round() * p;
            }
        }
        for i in 0..8 {
            sum += u.pcurve.eval(t0 + (t1 - t0) * i as f64 / 8.0) + offset;
            n += 1.0;
        }
        prev_end = Some(u.pcurve.eval(t1) + offset);
    }
    sum / n.max(1.0)
}

/// On a torus (both parameters periodic) forge-check's boundary integral reads a band or a
/// disk from the pcurves' period copies: shift whole loops by periods so that the region
/// lies between them as their orientation says (a band from its lower to its upper loop,
/// holes inside the band or within half a period of the outer loop).
fn align_torus_loops(f: &mut UFace, w: &[(i64, i64, f64)], edges: &[UEdge]) {
    let per = f.surface.periodicity();
    let (Some(pu), Some(pv)) = per else { return };
    let sigma = if f.sense { 1.0 } else { -1.0 };
    let means: Vec<Point2> = f.loops.iter().map(|l| loop_mean(l, edges, per)).collect();
    // Axis along which the region is bounded: v for u-wrapping bands, u for v-wrapping.
    let (axis, p, reference) = if w.iter().any(|x| x.0 != 0) {
        // Lower loop: region above it (wraps +u in the face's orientation).
        let Some(lo) = w.iter().position(|x| (x.0 as f64) * sigma > 0.0) else {
            return;
        };
        (1usize, pv, lo)
    } else if w.iter().any(|x| x.1 != 0) {
        // Left loop: region at larger u (wraps −v in the face's orientation).
        let Some(lo) = w.iter().position(|x| (x.1 as f64) * sigma < 0.0) else {
            return;
        };
        (0usize, pu, lo)
    } else {
        // Disk: the outer loop is the reference; holes within half a period of it.
        let Some(outer) = w.iter().position(|x| x.2 > 0.0) else {
            return;
        };
        for (li, m) in means.iter().enumerate() {
            if li == outer {
                continue;
            }
            let d = means[outer] - *m;
            let s = forge_core::linalg::Vec2::new((d.x / pu).round() * pu, (d.y / pv).round() * pv);
            if s.x != 0.0 || s.y != 0.0 {
                for u in &mut f.loops[li] {
                    u.pcurve = shift_curve2(&u.pcurve, s);
                }
            }
        }
        return;
    };
    let coord = |q: Point2| if axis == 0 { q.x } else { q.y };
    let base = coord(means[reference]);
    for (li, m) in means.iter().enumerate() {
        if li == reference {
            continue;
        }
        // Into (base, base + p].
        let x = coord(*m);
        let k = ((base + p - x) / p).floor();
        let target = x + k * p;
        let k = if target <= base { k + 1.0 } else { k };
        if k != 0.0 {
            let s = if axis == 0 {
                forge_core::linalg::Vec2::new(k * p, 0.0)
            } else {
                forge_core::linalg::Vec2::new(0.0, k * p)
            };
            for u in &mut f.loops[li] {
                u.pcurve = shift_curve2(&u.pcurve, s);
            }
        }
    }
}

/// Clamp and weld the pcurves of every loop (see [`weld_loop`]).
fn weld_faces(ub: &mut UBody) -> Result<(), BooleanError> {
    for fi in 0..ub.faces.len() {
        if !ub.faces[fi].alive {
            continue;
        }
        let surface = ub.faces[fi].surface.clone();
        for li in 0..ub.faces[fi].loops.len() {
            let mut uses: Vec<(Curve2, (f64, f64), bool)> = Vec::new();
            for u in &ub.faces[fi].loops[li] {
                let e = &ub.edges[u.edge];
                uses.push((
                    clamp_pcurve(&surface, &e.curve, e.range, &u.pcurve)?,
                    e.range,
                    u.fwd,
                ));
            }
            weld_loop(&surface, &mut uses);
            for (u, (c, _, _)) in ub.faces[fi].loops[li].iter_mut().zip(uses) {
                u.pcurve = c;
            }
        }
    }
    Ok(())
}

fn build(ub: &UBody) -> Result<Body, BooleanError> {
    let tol = Tolerance::IR_DEFAULT;
    let mut bb = BodyBuilder::with_tolerance(tol);
    let terr = |e: forge_core::topo::TopoError| {
        BooleanError::inconsistent(format!("unify rebuild: {} ({e})", e.code()), "body")
    };
    // Used edges and vertices.
    let mut used_e: BTreeSet<usize> = BTreeSet::new();
    for f in ub.faces.iter().filter(|f| f.alive) {
        for u in f.loops.iter().flatten() {
            used_e.insert(u.edge);
        }
    }
    let mut vtol: BTreeMap<usize, f64> = BTreeMap::new();
    for &e in &used_e {
        let ed = &ub.edges[e];
        for (v, t) in [(ed.start, ed.range.0), (ed.end, ed.range.1)] {
            if let Some(v) = v {
                let d = ed.curve.eval(t).distance(ub.verts[v].p);
                let x = vtol.entry(v).or_insert(ub.verts[v].tol);
                *x = x.max(1.01 * d);
            }
        }
    }
    let mut vid: BTreeMap<usize, VertexId> = BTreeMap::new();
    for (&v, &t) in &vtol {
        let x = &ub.verts[v];
        let id = bb.add_vertex(x.p, x.prov.clone()).map_err(terr)?;
        bb.set_vertex_tolerance(id, t.max(tol.linear))
            .map_err(terr)?;
        vid.insert(v, id);
    }
    // Edge tolerance covers every pcurve.
    let mut etol: BTreeMap<usize, f64> = BTreeMap::new();
    for f in ub.faces.iter().filter(|f| f.alive) {
        for u in f.loops.iter().flatten() {
            let e = &ub.edges[u.edge];
            let err = pcurve_error(&f.surface, &e.curve, &u.pcurve, e.range, 64);
            if err > super::assemble::MAX_PCURVE_ERROR {
                return Err(BooleanError::inconsistent(
                    format!("unify: pcurve deviates {err:e} mm from its edge"),
                    f.prov.name(),
                ));
            }
            let x = etol.entry(u.edge).or_insert(e.tol);
            *x = x.max(1.01 * err);
        }
    }
    let mut eid: BTreeMap<usize, EdgeId> = BTreeMap::new();
    for &e in &used_e {
        let ed = &ub.edges[e];
        let id = match (ed.start, ed.end) {
            (Some(s), Some(t)) => bb
                .add_edge(
                    ed.curve.clone(),
                    ed.range,
                    vid[&s],
                    vid[&t],
                    ed.prov.clone(),
                )
                .map_err(terr)?,
            _ => bb
                .add_ring_edge_with_range(ed.curve.clone(), ed.range, ed.prov.clone())
                .map_err(terr)?,
        };
        bb.set_edge_tolerance(id, etol[&e].max(tol.linear))
            .map_err(terr)?;
        eid.insert(e, id);
    }
    let mut shells = Vec::new();
    for _ in 0..ub.shells {
        shells.push(bb.add_shell(true));
    }
    for f in ub.faces.iter().filter(|f| f.alive) {
        let fid = bb
            .add_face(shells[f.shell], f.surface.clone(), f.sense, f.prov.clone())
            .map_err(terr)?;
        for l in &f.loops {
            let us: Vec<_> = l.iter().map(|u| (eid[&u.edge], u.fwd)).collect();
            let lid = bb.add_loop(fid, &us).map_err(terr)?;
            let cids = bb
                .body()
                .loop_(lid)
                .map(|x| x.coedges.clone())
                .unwrap_or_default();
            for (cid, u) in cids.into_iter().zip(l.iter()) {
                bb.set_pcurve(cid, u.pcurve.clone()).map_err(terr)?;
            }
        }
    }
    let body = bb.finish();
    let issues = validate(&body);
    if has_errors(&issues) {
        let names = EntityNames::new(&body);
        if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
            eprintln!("invalid result at unify");
            super::debug_dump(&body);
        }
        return Err(BooleanError::InvalidResult {
            issues: issues
                .iter()
                .filter(|i| i.severity == Severity::Error)
                .map(|i| names.describe(i))
                .collect(),
        });
    }
    Ok(body)
}
