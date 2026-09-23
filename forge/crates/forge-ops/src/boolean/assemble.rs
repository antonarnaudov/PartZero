//! Selecting fragments and assembling result bodies.
//!
//! | op | from A | from B |
//! |---|---|---|
//! | join | out, on-same | out |
//! | intersect | in, on-same | in |
//! | cut (A − B) | out, on-opposite | in, reversed |
//!
//! The selected fragments must use every edge piece exactly twice, in opposite directions.
//! An edge used four times (two solids touching along a curve) or a vertex whose faces
//! form more than one fan (touching at a point), or a tangent contact point kept on both
//! sides, is `BOOLEAN_NON_MANIFOLD`; any other count is an internal inconsistency.
//! Connected fragments form shells; a shell whose own faces enclose the space just beyond
//! its outward normal is a void and joins the innermost outer shell containing it.

use std::collections::BTreeMap;

use forge_core::Tolerance;
use forge_core::geom::{Curve2, Curve3, Line3, Surface};
use forge_core::linalg::{Point2, Point3, Vec3};
use forge_core::math;
use forge_core::topo::{
    Body, BodyBuilder, EntityNames, Provenance, Severity, has_errors, validate,
};
use forge_ir::v1::EntityKind;
use forge_ssi::{SsiTolerance, UvBox, intersect_curve_surface};

use super::BodyOp;
use super::chart::Chart;
use super::classify::{Class, Fragment};
use super::error::BooleanError;
use super::geom::{
    Aabb, clamp_pcurve, fit_pcurve, param_on, pcurve_error, singular_offset, singular_v_at,
    surface_box, uv_near, weld_loop,
};
use super::intersect::{Imprint, PieceSrc, VTOL};
use super::model::Model;

/// Largest pcurve deviation accepted into an edge tolerance (mm): ten times the IR's
/// linear tolerance (derived from it, so a change of `LINEAR_TOLERANCE` propagates). Vertex
/// merging and welding move pcurve ends by at most the vertex tolerance; anything larger is
/// an error.
pub(crate) const MAX_PCURVE_ERROR: f64 = 10.0 * VTOL;

/// A face of the result.
#[derive(Clone, Debug)]
pub(crate) struct RFace {
    pub frag: usize,
    pub reversed: bool,
}

/// Which fragments the operation keeps.
pub(crate) fn select(op: BodyOp, m: &Model, frags: &[Fragment], classes: &[Class]) -> Vec<RFace> {
    let mut out = Vec::new();
    for (i, fr) in frags.iter().enumerate() {
        let a = m.faces[fr.face].operand == 0;
        let keep = match (op, a, classes[i]) {
            (BodyOp::Join, true, Class::Out | Class::OnSame) => Some(false),
            (BodyOp::Join, false, Class::Out) => Some(false),
            (BodyOp::Intersect, true, Class::In | Class::OnSame) => Some(false),
            (BodyOp::Intersect, false, Class::In) => Some(false),
            (BodyOp::Cut, true, Class::Out | Class::OnOpp) => Some(false),
            (BodyOp::Cut, false, Class::In) => Some(true),
            _ => None,
        };
        if let Some(reversed) = keep {
            out.push(RFace { frag: i, reversed });
        }
    }
    out
}

/// Context of one assembly.
pub(crate) struct Assembly<'a> {
    pub m: &'a Model,
    pub imp: &'a Imprint,
    pub frags: &'a [Fragment],
    pub charts: &'a [Chart],
    /// `(piece, face)`: section pieces that separate nothing on the face (tangent contact
    /// lines), not part of its loops.
    pub contacts: &'a [(usize, usize)],
    pub feature: &'a str,
}

/// One result body: its shells as lists of result faces (outer shell first).
pub(crate) struct RBody {
    pub shells: Vec<Vec<RFace>>,
}

impl Assembly<'_> {
    fn loops_of(&self, rf: &RFace) -> Vec<Vec<(usize, bool)>> {
        let fr = &self.frags[rf.frag];
        if !rf.reversed {
            return fr.loops.clone();
        }
        fr.loops
            .iter()
            .map(|l| l.iter().rev().map(|&(p, f)| (p, !f)).collect())
            .collect()
    }

    fn piece_mid(&self, p: usize) -> Point3 {
        let pc = &self.imp.pieces[p];
        pc.curve.eval(0.5 * (pc.range.0 + pc.range.1))
    }

    /// Group the selected faces into bodies (shells, voids); non-manifold checks.
    pub fn bodies(&self, faces: Vec<RFace>) -> Result<Vec<RBody>, BooleanError> {
        if faces.is_empty() {
            return Ok(Vec::new());
        }
        // Edge uses.
        let mut uses: BTreeMap<usize, Vec<(usize, bool)>> = BTreeMap::new();
        let loops: Vec<Vec<Vec<(usize, bool)>>> = faces.iter().map(|f| self.loops_of(f)).collect();
        for (fi, ls) in loops.iter().enumerate() {
            for &(p, fwd) in ls.iter().flatten() {
                uses.entry(p).or_default().push((fi, fwd));
            }
        }
        for (&p, us) in &uses {
            let nf = us.iter().filter(|u| u.1).count();
            let nb = us.len() - nf;
            if us.len() == 2 && nf == 1 {
                continue;
            }
            if us.len() >= 4 && nf == nb {
                return Err(BooleanError::non_manifold(
                    EntityKind::Edge,
                    self.piece_mid(p).to_array(),
                ));
            }
            if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
                let pc = &self.imp.pieces[p];
                eprintln!(
                    "piece {p}: {} {:?} {:?}->{:?} src {:?} on {:?} used by {:?}",
                    pc.curve.kind_name(),
                    pc.range,
                    pc.start,
                    pc.end,
                    pc.src,
                    pc.on
                        .iter()
                        .map(|o| (self.m.faces[o.face].prov.name(), o.boundary))
                        .collect::<Vec<_>>(),
                    us.iter()
                        .map(|u| (
                            self.m.faces[self.frags[faces[u.0].frag].face].prov.name(),
                            self.frags[faces[u.0].frag].group,
                            u.1
                        ))
                        .collect::<Vec<_>>()
                );
                for (fi, fr) in self.frags.iter().enumerate() {
                    if fr.loops.iter().flatten().any(|x| x.0 == p) {
                        eprintln!(
                            "  in fragment {fi}: {} #{}",
                            self.m.faces[fr.face].prov.name(),
                            fr.group
                        );
                    }
                }
            }
            return Err(BooleanError::inconsistent(
                format!("edge piece used {} times ({} forward)", us.len(), nf),
                format!("{:?}", self.piece_mid(p).to_array()),
            ));
        }
        // Vertex fans: each vertex's coedges must form a single cycle.
        self.check_vertex_fans(&loops, &uses)?;
        // Is a result face of operand face `face` kept at `p`? At a singular point of the
        // surface (a cone apex, a sphere pole: a whole line of parameters) and on a
        // fragment boundary, the fragments around the point decide: kept if any of them
        // is (conservative: a contact kept on both sides is an error, never a body).
        let kept = |face: usize, grp: usize| {
            faces
                .iter()
                .any(|rf| self.frags[rf.frag].face == face && self.frags[rf.frag].group == grp)
        };
        let on = |face: usize, p: Point3| -> bool {
            let s = &self.m.faces[face].surface;
            let chart = &self.charts[face];
            if let Some(vs) = singular_v_at(s, p, VTOL)
                && let Some(around) = chart.around_singular(vs, singular_offset(s, vs, 10.0 * VTOL))
            {
                return around
                    .iter()
                    .any(|g| matches!(g, Some(Some(x)) if kept(face, *x)));
            }
            let uv = uv_near(s, p, None);
            if let Some(grp) = chart.face_at(uv) {
                return kept(face, grp);
            }
            around_uv(s, uv, 10.0 * VTOL)
                .into_iter()
                .any(|q| chart.face_at(q).is_some_and(|g| kept(face, g)))
        };
        // Tangent contact points kept on both sides. A kept face passing smoothly through the
        // point (the point inside it) while another kept face touches it there makes the
        // result touch itself (the link of the point has two boundary circles). When the
        // point lies on the boundary of the kept parts of both faces and is a vertex of the
        // result (a circle touching another face's edge, a sphere touching a box edge), the
        // faces around it are exactly its vertex fan, which `check_vertex_fans` has already
        // found to be one disk: manifold. This decision is independent of where the
        // surfaces' poles or seams lie.
        for &(p, f, g) in &self.imp.tangent_points {
            let (fi, fb) = self.kept_at(&faces, f, p);
            let (gi, gb) = self.kept_at(&faces, g, p);
            if !((fi || fb) && (gi || gb)) {
                continue;
            }
            if !fi && !gi && self.is_result_vertex(&uses, p) {
                continue;
            }
            return Err(BooleanError::non_manifold(EntityKind::Vertex, p.to_array()));
        }
        // Tangent contact lines: a face kept across the line while the other operand keeps
        // a face through it too (across it, or bounded by it) touches the result along the
        // line.
        for &(pi, f) in self.contacts {
            let pm = self.piece_mid(pi);
            if !on(f, pm) {
                continue;
            }
            let operand = self.m.faces[f].operand;
            let other_across = self
                .contacts
                .iter()
                .any(|&(pj, g)| pj == pi && self.m.faces[g].operand != operand && on(g, pm));
            let other_edge = uses.get(&pi).is_some_and(|us| {
                us.iter()
                    .any(|u| self.m.faces[self.frags[faces[u.0].frag].face].operand != operand)
            });
            if other_across || other_edge {
                return Err(BooleanError::non_manifold(EntityKind::Edge, pm.to_array()));
            }
        }
        // Shells: connected components through shared pieces.
        let n = faces.len();
        let mut uf: Vec<usize> = (0..n).collect();
        fn find(uf: &mut [usize], mut x: usize) -> usize {
            while uf[x] != x {
                uf[x] = uf[uf[x]];
                x = uf[x];
            }
            x
        }
        for us in uses.values() {
            let (a, b) = (find(&mut uf, us[0].0), find(&mut uf, us[1].0));
            if a != b {
                let (lo, hi) = (a.min(b), a.max(b));
                uf[hi] = lo;
            }
        }
        let mut comp: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
        for i in 0..n {
            let r = find(&mut uf, i);
            comp.entry(r).or_default().push(i);
        }
        let shells: Vec<Vec<usize>> = comp.into_values().collect();
        // Shared vertices between shells: touching at a point.
        let mut vshell: BTreeMap<usize, usize> = BTreeMap::new();
        for (si, sh) in shells.iter().enumerate() {
            for &fi in sh {
                for &(p, _) in loops[fi].iter().flatten() {
                    let pc = &self.imp.pieces[p];
                    for v in [pc.start, pc.end].into_iter().flatten() {
                        match vshell.get(&v) {
                            Some(&s) if s != si => {
                                return Err(BooleanError::non_manifold(
                                    EntityKind::Vertex,
                                    self.imp.verts[v].p.to_array(),
                                ));
                            }
                            _ => {
                                vshell.insert(v, si);
                            }
                        }
                    }
                }
            }
        }
        // Outer shells and voids.
        let mut outer: Vec<bool> = Vec::with_capacity(shells.len());
        let mut boxes: Vec<Aabb> = Vec::with_capacity(shells.len());
        for sh in &shells {
            let fs: Vec<&RFace> = sh.iter().map(|&i| &faces[i]).collect();
            boxes.push(self.shell_box(&fs));
            outer.push(!self.is_void(&fs)?);
        }
        let mut bodies: Vec<(usize, Vec<usize>)> = Vec::new(); // (outer shell, voids)
        for (si, &o) in outer.iter().enumerate() {
            if o {
                bodies.push((si, Vec::new()));
            }
        }
        for (si, &o) in outer.iter().enumerate() {
            if o {
                continue;
            }
            let fs: Vec<&RFace> = shells[si].iter().map(|&i| &faces[i]).collect();
            let probe = self.face_point(fs[0]);
            let mut best: Option<(f64, usize)> = None;
            for (bi, (os, _)) in bodies.iter().enumerate() {
                let ofs: Vec<&RFace> = shells[*os].iter().map(|&i| &faces[i]).collect();
                if self.inside_shell(&ofs, probe.0, None)? {
                    let vol = {
                        let d = boxes[*os].hi - boxes[*os].lo;
                        d.x * d.y * d.z
                    };
                    if best.is_none_or(|b| vol < b.0) {
                        best = Some((vol, bi));
                    }
                }
            }
            let Some((_, bi)) = best else {
                return Err(BooleanError::inconsistent(
                    "a void shell outside every outer shell",
                    format!("{:?}", probe.0.to_array()),
                ));
            };
            bodies[bi].1.push(si);
        }
        let mut faces_opt: Vec<Option<RFace>> = faces.into_iter().map(Some).collect();
        let mut out = Vec::new();
        for (os, voids) in bodies {
            let mut shs = Vec::new();
            for s in std::iter::once(os).chain(voids) {
                shs.push(
                    shells[s]
                        .iter()
                        .map(|&i| faces_opt[i].take().expect("face in one shell"))
                        .collect(),
                );
            }
            out.push(RBody { shells: shs });
        }
        Ok(out)
    }

    /// Whether the selected faces keep operand face `face` at point `p` (on its surface):
    /// `(inside, on_boundary)`: `inside` when a kept fragment contains `p` in its interior,
    /// `on_boundary` when `p` lies on the boundary of the face's fragments (on one of their
    /// pieces, or at a singular point of the surface the fragments meet at) and some kept
    /// fragment reaches it.
    fn kept_at(&self, faces: &[RFace], face: usize, p: Point3) -> (bool, bool) {
        let kept = |grp: usize| {
            faces
                .iter()
                .any(|rf| self.frags[rf.frag].face == face && self.frags[rf.frag].group == grp)
        };
        let s = &self.m.faces[face].surface;
        let chart = &self.charts[face];
        let on_piece = self
            .frags
            .iter()
            .filter(|fr| fr.face == face)
            .flat_map(|fr| fr.loops.iter().flatten())
            .any(|&(pi, _)| {
                let pc = &self.imp.pieces[pi];
                param_on(&pc.curve, pc.range, p).1 <= VTOL
            });
        if let Some(vs) = singular_v_at(s, p, VTOL)
            && let Some(around) = chart.around_singular(vs, singular_offset(s, vs, 10.0 * VTOL))
        {
            let groups: Vec<Option<usize>> = around.iter().map(|g| g.flatten()).collect();
            let all_one = !on_piece
                && groups.iter().all(|g| g.is_some() && *g == groups[0])
                && around.iter().all(Option::is_some);
            if all_one {
                return (groups[0].is_some_and(kept), false);
            }
            return (false, groups.iter().flatten().any(|&g| kept(g)));
        }
        let uv = uv_near(s, p, None);
        if !on_piece && let Some(grp) = chart.face_at(uv) {
            return (kept(grp), false);
        }
        let near = around_uv(s, uv, 10.0 * VTOL)
            .into_iter()
            .any(|q| chart.face_at(q).is_some_and(kept));
        (false, near)
    }

    /// `true` if `p` is a vertex of the pieces the selected faces use (so that the vertex fan
    /// check has seen every face through it).
    fn is_result_vertex(&self, uses: &BTreeMap<usize, Vec<(usize, bool)>>, p: Point3) -> bool {
        uses.keys().any(|&pi| {
            let pc = &self.imp.pieces[pi];
            [pc.start, pc.end]
                .into_iter()
                .flatten()
                .any(|v| self.imp.verts[v].p.distance(p) <= VTOL.max(self.imp.verts[v].tol))
        })
    }

    fn check_vertex_fans(
        &self,
        loops: &[Vec<Vec<(usize, bool)>>],
        uses: &BTreeMap<usize, Vec<(usize, bool)>>,
    ) -> Result<(), BooleanError> {
        // Coedge = (face, loop, index). For a coedge c ending at v, the next coedge in its
        // loop starts at v; its twin ends at v again.
        let piece_end = |p: usize, fwd: bool| {
            let pc = &self.imp.pieces[p];
            if fwd { pc.end } else { pc.start }
        };
        let mut by_vertex: BTreeMap<usize, Vec<(usize, usize, usize)>> = BTreeMap::new();
        for (fi, ls) in loops.iter().enumerate() {
            for (li, l) in ls.iter().enumerate() {
                for (k, &(p, fwd)) in l.iter().enumerate() {
                    if let Some(v) = piece_end(p, fwd) {
                        by_vertex.entry(v).or_default().push((fi, li, k));
                    }
                }
            }
        }
        for (v, cs) in by_vertex {
            // Map coedge -> next-around-vertex.
            let index: BTreeMap<(usize, usize, usize), usize> =
                cs.iter().enumerate().map(|(i, &c)| (c, i)).collect();
            let mut seen = vec![false; cs.len()];
            let mut fans = 0;
            for s in 0..cs.len() {
                if seen[s] {
                    continue;
                }
                fans += 1;
                let mut c = s;
                let mut guard = 0;
                while !seen[c] {
                    seen[c] = true;
                    let (fi, li, k) = cs[c];
                    let l = &loops[fi][li];
                    let (np, nfwd) = l[(k + 1) % l.len()];
                    // The twin of the next coedge.
                    let twin = uses[&np]
                        .iter()
                        .find(|u| u.1 != nfwd)
                        .map(|u| u.0)
                        .ok_or_else(|| BooleanError::inconsistent("edge without twin", "fan"))?;
                    // The coedge of face `twin` on piece np ending at v.
                    let mut found = None;
                    for (li2, l2) in loops[twin].iter().enumerate() {
                        for (k2, &(p2, f2)) in l2.iter().enumerate() {
                            if p2 == np && f2 != nfwd {
                                found = Some((twin, li2, k2));
                            }
                        }
                    }
                    let Some(key) = found else {
                        return Err(BooleanError::inconsistent("twin coedge not found", "fan"));
                    };
                    c = *index.get(&key).ok_or_else(|| {
                        BooleanError::inconsistent("fan walk left the vertex", "fan")
                    })?;
                    guard += 1;
                    if guard > cs.len() + 1 {
                        return Err(BooleanError::inconsistent("runaway fan walk", "fan"));
                    }
                }
            }
            if fans > 1 {
                return Err(BooleanError::non_manifold(
                    EntityKind::Vertex,
                    self.imp.verts[v].p.to_array(),
                ));
            }
        }
        Ok(())
    }

    fn shell_box(&self, fs: &[&RFace]) -> Aabb {
        let mut b = Aabb::empty();
        for rf in fs {
            let fr = &self.frags[rf.frag];
            for &(p, _) in fr.loops.iter().flatten() {
                let pc = &self.imp.pieces[p];
                for t in [0.0, 0.25, 0.5, 0.75, 1.0] {
                    b.add_point(pc.curve.eval(pc.range.0 + (pc.range.1 - pc.range.0) * t));
                }
            }
            if fr.loops.is_empty() {
                b.add_box(&self.m.faces[fr.face].bbox);
            }
        }
        b
    }

    /// A point inside the fragment and its outward normal (result orientation).
    fn face_point(&self, rf: &RFace) -> (Point3, Vec3) {
        let fr = &self.frags[rf.frag];
        let f = &self.m.faces[fr.face];
        let p = f.surface.eval(fr.uv.x, fr.uv.y);
        let n = f.surface.normal(fr.uv.x, fr.uv.y).unwrap_or(Vec3::unit_z());
        let s = if f.sense != rf.reversed { 1.0 } else { -1.0 };
        (p, n * s)
    }

    /// `true` if a shell is a void (its normals point into the space it encloses).
    fn is_void(&self, fs: &[&RFace]) -> Result<bool, BooleanError> {
        let (p, n) = self.face_point(fs[0]);
        // Rays leaving the shell on the outward side of its first face.
        self.inside_shell(fs, p, Some((n, fs[0])))
    }

    /// Parity ray test against the faces of one shell. With `from = Some((n, face))` the
    /// point lies on that face and the rays leave it along `n` (the hit at the start is
    /// ignored).
    fn inside_shell(
        &self,
        fs: &[&RFace],
        p: Point3,
        from: Option<(Vec3, &RFace)>,
    ) -> Result<bool, BooleanError> {
        let tol = SsiTolerance::default();
        let mut bb = self.shell_box(fs);
        for rf in fs {
            bb.add_box(&self.m.faces[self.frags[rf.frag].face].bbox);
        }
        let len = 2.0 * (bb.diag() + p.distance(bb.lo.lerp(bb.hi, 0.5))) + 1.0;
        let dirs: Vec<Vec3> = super::classify_dirs()
            .into_iter()
            .map(|d| match from {
                Some((n, _)) => {
                    let d = if d.dot(n) < 0.0 { -d } else { d };
                    (n * 2.0 + d).normalize().expect("dir")
                }
                None => d,
            })
            .collect();
        'dirs: for dir in dirs {
            let line: Curve3 = Line3::new(p, dir)
                .map_err(|_| BooleanError::inconsistent("ray", "shell"))?
                .into();
            let mut count = 0usize;
            for rf in fs {
                let fr = &self.frags[rf.frag];
                let f = &self.m.faces[fr.face];
                let hits = intersect_curve_surface(&line, (0.0, len), &f.surface, f.uvbox, &tol)
                    .map_err(|e| BooleanError::ssi(&e, format!("ray × face {}", f.prov.name())))?;
                if !hits.overlaps.is_empty() {
                    continue 'dirs;
                }
                for h in &hits.points {
                    let at_start = h.point.distance(p) <= 10.0 * VTOL;
                    if at_start {
                        if from.is_some_and(|(_, sf)| sf.frag == rf.frag) {
                            continue;
                        }
                        // Another face through the start point (a coplanar neighbour):
                        // harmless when the point is outside it.
                        match self.in_fragment(rf, h.point, h.uv) {
                            Some(false) => continue,
                            _ => continue 'dirs,
                        }
                    }
                    if h.contact.is_tangent() {
                        continue 'dirs;
                    }
                    match self.in_fragment(rf, h.point, h.uv) {
                        Some(true) => count += 1,
                        Some(false) => {}
                        None => continue 'dirs,
                    }
                }
            }
            return Ok(count % 2 == 1);
        }
        Err(BooleanError::inconsistent(
            "every ray direction is degenerate (shell orientation)",
            format!("{:?}", p.to_array()),
        ))
    }

    /// `Some(inside)` for a point on the fragment's surface; `None` near its boundary.
    fn in_fragment(&self, rf: &RFace, p: Point3, uv: Point2) -> Option<bool> {
        let fr = &self.frags[rf.frag];
        for &(pi, _) in fr.loops.iter().flatten() {
            let pc = &self.imp.pieces[pi];
            if param_on(&pc.curve, pc.range, p).1 <= VTOL {
                return None;
            }
        }
        match self.charts[fr.face].face_at(uv) {
            Some(g) => Some(g == fr.group),
            None => {
                // Outside every fragment of the face, or undecidable.
                self.charts[fr.face].contains(uv).map(|_| false)
            }
        }
    }

    /// Build a validated body.
    pub fn build(&self, rb: &RBody) -> Result<Body, BooleanError> {
        let tol = Tolerance::IR_DEFAULT;
        let mut bb = BodyBuilder::with_tolerance(tol);
        // Pieces and vertices used.
        let mut piece_ids: BTreeMap<usize, forge_core::topo::EdgeId> = BTreeMap::new();
        let mut vert_ids: BTreeMap<usize, forge_core::topo::VertexId> = BTreeMap::new();
        let all: Vec<&RFace> = rb.shells.iter().flatten().collect();
        // Faces around each piece and vertex, by key (SPEC §5.2: the keys of new edges and
        // vertices name the result faces around them) and by operand face.
        let face_key = |rf: &RFace| self.m.faces[self.frags[rf.frag].face].prov.key();
        let mut piece_faces: BTreeMap<usize, Vec<String>> = BTreeMap::new();
        let mut piece_ofaces: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
        let mut vertex_faces: BTreeMap<usize, Vec<String>> = BTreeMap::new();
        for rf in &all {
            for &(p, _) in self.frags[rf.frag].loops.iter().flatten() {
                let name = face_key(rf);
                piece_faces.entry(p).or_default().push(name.clone());
                piece_ofaces
                    .entry(p)
                    .or_default()
                    .push(self.frags[rf.frag].face);
                let pc = &self.imp.pieces[p];
                for v in [pc.start, pc.end].into_iter().flatten() {
                    let e = vertex_faces.entry(v).or_default();
                    if !e.contains(&name) {
                        e.push(name.clone());
                    }
                }
            }
        }
        // Circles and ellipses whose image turns clockwise in every plane face of the result
        // they bound are re-parametrized by their mirror frame (see `mirror_conic`).
        let mut mirrored: BTreeMap<usize, RangedCurve> = BTreeMap::new();
        for &p in piece_faces.keys() {
            let faces_of_p: Vec<usize> = all
                .iter()
                .filter(|rf| self.frags[rf.frag].loops.iter().flatten().any(|x| x.0 == p))
                .map(|rf| self.frags[rf.frag].face)
                .collect();
            if let Some(x) = mirror_conic(self.m, &self.imp.pieces[p], &faces_of_p)? {
                mirrored.insert(p, x);
            }
        }
        // The piece's curve, range and end vertices as the result edge has them.
        let geo = |p: usize| -> (&Curve3, (f64, f64), Option<usize>, Option<usize>) {
            let pc = &self.imp.pieces[p];
            match mirrored.get(&p) {
                Some((c, r)) => (c, *r, pc.end, pc.start),
                None => (&pc.curve, pc.range, pc.start, pc.end),
            }
        };
        let flip = |p: usize| mirrored.contains_key(&p);
        // Vertex tolerances: cover every incident curve end.
        let mut vtol: BTreeMap<usize, f64> = BTreeMap::new();
        for &p in piece_faces.keys() {
            let (curve, range, start, end) = geo(p);
            for (v, t) in [(start, range.0), (end, range.1)] {
                if let Some(v) = v {
                    let d = curve.eval(t).distance(self.imp.verts[v].p);
                    let e = vtol.entry(v).or_insert(self.imp.verts[v].tol);
                    *e = e.max(1.01 * d);
                }
            }
        }
        for (&v, &t) in &vtol {
            let vx = &self.imp.verts[v];
            let prov = match vx.orig {
                Some(o) => self.m.verts[o].prov.clone(),
                None => Provenance::vertex_at(self.feature, vertex_faces[&v].clone()),
            };
            let id = bb.add_vertex(vx.p, prov).map_err(topo_err)?;
            bb.set_vertex_tolerance(id, t.max(tol.linear))
                .map_err(topo_err)?;
            vert_ids.insert(v, id);
        }
        // Pcurves per coedge: clamped to the edge range, welded along each loop.
        let pcurve = |p: usize, face: usize| -> Option<&Curve2> {
            self.imp.pieces[p]
                .on
                .iter()
                .find(|o| o.face == face)
                .map(|o| &o.pcurve)
        };
        let mut etol: BTreeMap<usize, f64> = BTreeMap::new();
        let mut face_pcurves: Vec<Vec<Vec<Curve2>>> = Vec::new();
        for rf in &all {
            let fr = &self.frags[rf.frag];
            let f = &self.m.faces[fr.face];
            let mut per_loop = Vec::new();
            for l in self.loops_of(rf) {
                let mut uses: Vec<(Curve2, (f64, f64), bool)> = Vec::with_capacity(l.len());
                for &(p, fw) in &l {
                    let pc = &self.imp.pieces[p];
                    let c = pcurve(p, fr.face).ok_or_else(|| {
                        BooleanError::inconsistent("missing pcurve", f.prov.name())
                    })?;
                    let (curve, range, _, _) = geo(p);
                    let refit;
                    let c = if flip(p) {
                        // The mirrored parameter runs backwards from the old end.
                        let near = Some(c.eval(pc.range.1));
                        refit = fit_pcurve(&f.surface, curve, range, near)?.0;
                        &refit
                    } else {
                        c
                    };
                    uses.push((
                        clamp_pcurve(&f.surface, curve, range, c)?,
                        range,
                        fw != flip(p),
                    ));
                }
                weld_loop(&f.surface, &mut uses);
                for (&(p, _), (c, _, _)) in l.iter().zip(&uses) {
                    let pc = &self.imp.pieces[p];
                    let (curve, range, _, _) = geo(p);
                    let err = pcurve_error(&f.surface, curve, c, range, 64);
                    // A pcurve far off its edge is a construction error, never absorbed
                    // into the edge tolerance.
                    if err > MAX_PCURVE_ERROR {
                        return Err(BooleanError::inconsistent(
                            format!("pcurve deviates {err:e} mm from its edge"),
                            f.prov.name(),
                        ));
                    }
                    let e = etol.entry(p).or_insert(pc.tol);
                    *e = e.max(1.01 * err);
                }
                per_loop.push(uses.into_iter().map(|x| x.0).collect());
            }
            face_pcurves.push(per_loop);
        }
        for &p in piece_faces.keys() {
            let pc = &self.imp.pieces[p];
            // An operand edge between the same two operand faces as before keeps its key
            // (§5.2 rule 3: trimmed or split, not new); one whose faces changed (a tool's
            // rim now between the target's face and the tool's side) is a new edge of the
            // operation, keyed by the result faces around it, like every section piece.
            let same_faces = |e: usize| {
                let mut before: Vec<usize> = self
                    .m
                    .faces
                    .iter()
                    .enumerate()
                    .filter(|(_, f)| f.edges().any(|x| x == e))
                    .map(|(i, _)| i)
                    .collect();
                let mut now = piece_ofaces[&p].clone();
                before.sort_unstable();
                now.sort_unstable();
                before == now
            };
            let prov = match pc.src {
                PieceSrc::Edge(e) if same_faces(e) => self.m.edges[e].prov.clone(),
                _ => {
                    let ks = &piece_faces[&p];
                    let (a, b) = match ks.as_slice() {
                        [a, b] => (a.clone(), b.clone()),
                        _ => {
                            return Err(BooleanError::inconsistent(
                                format!("an edge piece bounds {} result faces", ks.len()),
                                "assembly",
                            ));
                        }
                    };
                    Provenance::edge_between(self.feature, a, b)
                }
            };
            let (curve, range, start, end) = geo(p);
            let id = match (start, end) {
                (Some(s), Some(e)) => bb
                    .add_edge(curve.clone(), range, vert_ids[&s], vert_ids[&e], prov)
                    .map_err(topo_err)?,
                _ => bb
                    .add_ring_edge_with_range(curve.clone(), range, prov)
                    .map_err(topo_err)?,
            };
            let t = etol[&p];
            if !t.is_finite() {
                return Err(BooleanError::inconsistent(
                    "edge without a pcurve on its face",
                    "assembly",
                ));
            }
            bb.set_edge_tolerance(id, t.max(tol.linear))
                .map_err(topo_err)?;
            piece_ids.insert(p, id);
        }
        let mut k = 0;
        for shell in &rb.shells {
            let sid = bb.add_shell(true);
            for rf in shell {
                let fr = &self.frags[rf.frag];
                let f = &self.m.faces[fr.face];
                let fid = bb
                    .add_face(
                        sid,
                        f.surface.clone(),
                        f.sense != rf.reversed,
                        f.prov.clone(),
                    )
                    .map_err(topo_err)?;
                for (li, l) in self.loops_of(rf).into_iter().enumerate() {
                    let us: Vec<_> = l
                        .iter()
                        .map(|&(p, fw)| (piece_ids[&p], fw != flip(p)))
                        .collect();
                    let lid = bb.add_loop(fid, &us).map_err(topo_err)?;
                    let cids = bb
                        .body()
                        .loop_(lid)
                        .map(|x| x.coedges.clone())
                        .unwrap_or_default();
                    for (ci, cid) in cids.into_iter().enumerate() {
                        bb.set_pcurve(cid, face_pcurves[k][li][ci].clone())
                            .map_err(topo_err)?;
                    }
                }
                k += 1;
            }
        }
        let body = bb.finish();
        let issues = validate(&body);
        if has_errors(&issues) {
            let names = EntityNames::new(&body);
            if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
                eprintln!("invalid result at assemble");
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
}

/// Orientation of a circle's or ellipse's image in a plane's `(u, v)`: `Some(true)` when it
/// turns counter-clockwise (its pcurve is an exact `Ellipse2`), `Some(false)` clockwise
/// (only a fitted pcurve follows it: `Ellipse2` turns counter-clockwise), `None` if the
/// conic does not lie in the plane.
fn conic_image_ccw(plane: &forge_core::geom::Plane, curve: &Curve3) -> Option<bool> {
    let fr = match curve {
        Curve3::Circle(c) => c.frame(),
        Curve3::Ellipse(e) => e.frame(),
        _ => return None,
    };
    let f = plane.frame();
    if fr.z().cross(f.z()).norm() > 1e-9 {
        return None;
    }
    let x = f.to_local_vector(fr.x()).truncate();
    let y = f.to_local_vector(fr.y()).truncate();
    Some(x.perp_dot(y) > 0.0)
}

/// A curve with its parameter range.
type RangedCurve = (Curve3, (f64, f64));

/// A circle or ellipse piece whose image turns clockwise in every plane face of the result
/// it bounds (e.g. a tool's circle on a target face whose frame normal points the other
/// way: a boss on a side face) gets its mirror frame (`z → −z`, `y → −y`, `t → −t`, range
/// `(−t1, −t0)`, direction reversed): its pcurves there are then exact ellipses, and on a
/// cylinder, cone or sphere (a parallel) still exact lines, instead of cubic fits within
/// 5e-8 mm that make the volumes inexact. `None` when the piece stays as it is.
fn mirror_conic(
    m: &Model,
    p: &super::intersect::Piece,
    faces: &[usize],
) -> Result<Option<RangedCurve>, BooleanError> {
    let (mut cw, mut ccw) = (0, 0);
    for &fi in faces {
        if let Surface::Plane(pl) = &m.faces[fi].surface {
            match conic_image_ccw(pl, &p.curve) {
                Some(true) => ccw += 1,
                Some(false) => cw += 1,
                None => {}
            }
        }
    }
    if cw == 0 || ccw > 0 {
        return Ok(None);
    }
    let mirror = |fr: &forge_core::linalg::Frame| {
        forge_core::linalg::Frame::from_normal_x(fr.origin(), -fr.z(), fr.x())
    };
    let bad = || BooleanError::inconsistent("mirror frame of a conic", "assembly");
    let curve: Curve3 = match &p.curve {
        Curve3::Circle(c) => {
            forge_core::geom::Circle3::new(mirror(c.frame()).ok_or_else(bad)?, c.radius())
                .map_err(|_| bad())?
                .into()
        }
        Curve3::Ellipse(e) => {
            forge_core::geom::Ellipse3::new(mirror(e.frame()).ok_or_else(bad)?, e.rx(), e.ry())
                .map_err(|_| bad())?
                .into()
        }
        _ => return Ok(None),
    };
    Ok(Some((curve, (-p.range.1, -p.range.0))))
}

/// Eight parameter points around `uv` at about `dist` (mm) from `S(uv)`.
fn around_uv(s: &Surface, uv: Point2, dist: f64) -> Vec<Point2> {
    let (su, sv) = (s.du(uv.x, uv.y).norm(), s.dv(uv.x, uv.y).norm());
    if su <= 0.0 || sv <= 0.0 {
        return Vec::new();
    }
    (0..8)
        .map(|k| {
            let a = (k as f64 + 0.5) * math::TAU / 8.0;
            Point2::new(
                uv.x + dist / su * math::cos(a),
                uv.y + dist / sv * math::sin(a),
            )
        })
        .collect()
}

fn topo_err(e: forge_core::topo::TopoError) -> BooleanError {
    BooleanError::inconsistent(
        format!("topology construction: {} ({e})", e.code()),
        "assembly",
    )
}

/// Parameter box and bounding box helpers for fragments (used by ray tests on bodies
/// built from scratch).
#[allow(dead_code)]
pub(crate) fn fragment_uvbox(chart: &Chart) -> UvBox {
    let (u, v) = chart.uv_box();
    UvBox::new(u.0, u.1, v.0, v.1)
}

#[allow(dead_code)]
pub(crate) fn surface_bbox(s: &Surface, b: &UvBox) -> Aabb {
    surface_box(s, b.u, b.v, 4)
}
