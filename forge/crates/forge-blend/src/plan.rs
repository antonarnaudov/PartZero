//! An editable copy of a body: flat tables of vertices, edges and faces (with loops of
//! edge uses) that fillet, chamfer and shell rewrite, then rebuild into a fresh [`Body`]
//! through `BodyBuilder` (bodies are immutable once built).
//!
//! Entities keep their input order and new ones are appended, so the rebuilt body's arena
//! order — and every output — is deterministic.

use std::collections::BTreeMap;

use forge_core::Tolerance;
use forge_core::geom::{Curve2, Curve3, Surface};
use forge_core::linalg::{Point2, Point3};
use forge_core::topo::{Body, BodyBuilder, EdgeId, FaceId, Provenance, VertexId};

use crate::pcurve::pcurve_for;

/// A vertex.
#[derive(Clone, Debug)]
pub(crate) struct PV {
    pub p: Point3,
    pub tol: f64,
    pub prov: Provenance,
}

/// An edge: `start`/`end` both `None` for a ring edge.
#[derive(Clone, Debug)]
pub(crate) struct PE {
    pub curve: Curve3,
    pub range: (f64, f64),
    pub start: Option<usize>,
    pub end: Option<usize>,
    pub tol: f64,
    pub prov: Provenance,
}

impl PE {
    pub fn is_ring(&self) -> bool {
        self.start.is_none()
    }
}

/// A use of an edge by a loop; `pc` is computed at build time when `None`.
#[derive(Clone, Debug)]
pub(crate) struct PU {
    pub edge: usize,
    pub fwd: bool,
    pub pc: Option<Curve2>,
}

/// A face.
#[derive(Clone, Debug)]
pub(crate) struct PF {
    pub surf: Surface,
    pub sense: bool,
    pub prov: Provenance,
    pub loops: Vec<Vec<PU>>,
    pub shell: usize,
    /// A parameter point inside the face: computed pcurves of each loop start in the
    /// period copy nearest it (on a doubly periodic torus, two rings bound the band on the
    /// side the pcurves' `v` values give).
    pub hint: Option<Point2>,
}

/// The editable body.
#[derive(Clone, Debug, Default)]
pub(crate) struct Plan {
    /// `closed` flag per shell.
    pub shells: Vec<bool>,
    pub vs: Vec<PV>,
    pub es: Vec<PE>,
    /// `None` for a removed face.
    pub fs: Vec<Option<PF>>,
    pub vmap: BTreeMap<VertexId, usize>,
    pub emap: BTreeMap<EdgeId, usize>,
    pub fmap: BTreeMap<FaceId, usize>,
}

impl Plan {
    /// A copy of `body`. Every coedge must carry a pcurve (bodies from forge-ops do).
    pub fn from_body(body: &Body) -> Result<Self, String> {
        let mut p = Plan::default();
        let mut smap = BTreeMap::new();
        for (i, &sid) in body.shell_ids().iter().enumerate() {
            smap.insert(sid, i);
            p.shells
                .push(body.shell(sid).map(|s| s.closed).unwrap_or(true));
        }
        for (vid, v) in body.vertices().iter() {
            p.vmap.insert(vid, p.vs.len());
            p.vs.push(PV {
                p: v.point,
                tol: v.tolerance,
                prov: v.provenance.clone(),
            });
        }
        for (eid, e) in body.edges().iter() {
            let idx = |v: Option<VertexId>| -> Result<Option<usize>, String> {
                match v {
                    None => Ok(None),
                    Some(v) => p
                        .vmap
                        .get(&v)
                        .copied()
                        .map(Some)
                        .ok_or_else(|| "dangling vertex".to_string()),
                }
            };
            let (start, end) = (idx(e.start)?, idx(e.end)?);
            p.emap.insert(eid, p.es.len());
            p.es.push(PE {
                curve: e.curve.clone(),
                range: e.t_range,
                start,
                end,
                tol: e.tolerance,
                prov: e.provenance.clone(),
            });
        }
        for (fid, f) in body.faces().iter() {
            let mut loops = Vec::with_capacity(f.loops.len());
            for lid in &f.loops {
                let l = body.loop_(*lid).ok_or("dangling loop")?;
                let mut uses = Vec::with_capacity(l.coedges.len());
                for cid in &l.coedges {
                    let c = body.coedge(*cid).ok_or("dangling coedge")?;
                    let pc = c
                        .pcurve
                        .clone()
                        .ok_or("a coedge of the input has no pcurve")?;
                    uses.push(PU {
                        edge: *p.emap.get(&c.edge).ok_or("dangling edge")?,
                        fwd: c.forward,
                        pc: Some(pc),
                    });
                }
                loops.push(uses);
            }
            p.fmap.insert(fid, p.fs.len());
            p.fs.push(Some(PF {
                surf: f.surface.clone(),
                sense: f.sense,
                prov: f.provenance.clone(),
                loops,
                shell: *smap.get(&f.shell).ok_or("dangling shell")?,
                hint: None,
            }));
        }
        Ok(p)
    }

    /// Append a vertex.
    pub fn add_v(&mut self, p: Point3, prov: Provenance) -> usize {
        self.vs.push(PV {
            p,
            tol: forge_ir::v1::LINEAR_TOLERANCE,
            prov,
        });
        self.vs.len() - 1
    }

    /// Append an edge.
    pub fn add_e(&mut self, e: PE) -> usize {
        self.es.push(e);
        self.es.len() - 1
    }

    /// Append a face.
    pub fn add_f(&mut self, f: PF) -> usize {
        self.fs.push(Some(f));
        self.fs.len() - 1
    }

    /// The vertex a use starts at (in traversal order); `None` for rings.
    pub fn use_start(&self, u: &PU) -> Option<usize> {
        let e = &self.es[u.edge];
        if u.fwd { e.start } else { e.end }
    }

    /// The vertex a use ends at (in traversal order); `None` for rings.
    pub fn use_end(&self, u: &PU) -> Option<usize> {
        let e = &self.es[u.edge];
        if u.fwd { e.end } else { e.start }
    }

    /// Compute every missing pcurve (in face, loop, use order). Returns, per edge, the
    /// largest deviation of a computed pcurve.
    pub fn fill_pcurves(&mut self) -> Result<BTreeMap<usize, f64>, String> {
        let mut dev: BTreeMap<usize, f64> = BTreeMap::new();
        for fi in 0..self.fs.len() {
            let Some(f) = self.fs[fi].as_ref() else {
                continue;
            };
            let surf = f.surf.clone();
            let mut updates: Vec<(usize, usize, Curve2)> = Vec::new();
            for (li, lp) in f.loops.iter().enumerate() {
                let mut near: Option<Point2> = f.hint;
                for (ui, u) in lp.iter().enumerate() {
                    let e = &self.es[u.edge];
                    if let Some(pc) = &u.pc {
                        let t = if u.fwd { e.range.1 } else { e.range.0 };
                        near = Some(pc.eval(t));
                        continue;
                    }
                    let t_first = if u.fwd { e.range.0 } else { e.range.1 };
                    let seed = near.map(|n| {
                        // Start the fit in the period copy of the previous use's end.
                        crate::pcurve::uv_near(&surf, e.curve.eval(t_first), Some(n))
                    });
                    let (pc, d) = pcurve_for(&surf, &e.curve, e.range, None)
                        .map_err(|m| format!("{m} ({})", f.prov.name()))?;
                    // Shift the pcurve to the seed's period copy (keeps loops contiguous).
                    let pc = match seed {
                        Some(sd) => shift_to(&surf, pc, t_first, sd),
                        None => pc,
                    };
                    let t_last = if u.fwd { e.range.1 } else { e.range.0 };
                    near = Some(pc.eval(t_last));
                    let slot = dev.entry(u.edge).or_insert(0.0);
                    *slot = slot.max(d);
                    updates.push((li, ui, pc));
                }
            }
            let f = self.fs[fi].as_mut().expect("face present");
            for (li, ui, pc) in updates {
                f.loops[li][ui].pc = Some(pc);
            }
        }
        Ok(dev)
    }

    /// Rebuild a body. Only vertices and edges used by live faces are created (in index
    /// order); every coedge gets its pcurve; edge tolerances grow by computed pcurve
    /// deviations.
    pub fn build(mut self) -> Result<Body, String> {
        let dev = self.fill_pcurves()?;
        let tol = Tolerance::IR_DEFAULT;
        let mut bb = BodyBuilder::with_tolerance(tol);
        let mut used_e = vec![false; self.es.len()];
        let mut used_v = vec![false; self.vs.len()];
        let mut used_s = vec![false; self.shells.len()];
        for f in self.fs.iter().flatten() {
            used_s[f.shell] = true;
            for u in f.loops.iter().flatten() {
                used_e[u.edge] = true;
            }
        }
        for (i, e) in self.es.iter().enumerate() {
            if used_e[i] {
                for v in [e.start, e.end].into_iter().flatten() {
                    used_v[v] = true;
                }
            }
        }
        let mut vid = vec![None; self.vs.len()];
        for (i, v) in self.vs.iter().enumerate() {
            if used_v[i] {
                let id = bb
                    .add_vertex(v.p, v.prov.clone())
                    .map_err(|e| e.to_string())?;
                if v.tol > tol.linear {
                    bb.set_vertex_tolerance(id, v.tol)
                        .map_err(|e| e.to_string())?;
                }
                vid[i] = Some(id);
            }
        }
        let mut eid = vec![None; self.es.len()];
        for (i, e) in self.es.iter().enumerate() {
            if !used_e[i] {
                continue;
            }
            let id = match (e.start, e.end) {
                (Some(s), Some(t)) => bb
                    .add_edge(
                        e.curve.clone(),
                        e.range,
                        vid[s].expect("used vertex"),
                        vid[t].expect("used vertex"),
                        e.prov.clone(),
                    )
                    .map_err(|x| format!("{x} ({})", e.prov.name()))?,
                _ => bb
                    .add_ring_edge_with_range(e.curve.clone(), e.range, e.prov.clone())
                    .map_err(|x| format!("{x} ({})", e.prov.name()))?,
            };
            let t = e
                .tol
                .max(tol.linear)
                .max(dev.get(&i).map_or(0.0, |d| 2.0 * d));
            if t > tol.linear {
                bb.set_edge_tolerance(id, t).map_err(|x| x.to_string())?;
            }
            eid[i] = Some(id);
        }
        let mut sid = vec![None; self.shells.len()];
        for (i, &closed) in self.shells.iter().enumerate() {
            if used_s[i] {
                sid[i] = Some(bb.add_shell(closed));
            }
        }
        for f in self.fs.iter().flatten() {
            let fid = bb
                .add_face(
                    sid[f.shell].expect("used shell"),
                    f.surf.clone(),
                    f.sense,
                    f.prov.clone(),
                )
                .map_err(|x| x.to_string())?;
            for lp in &f.loops {
                let uses: Vec<_> = lp
                    .iter()
                    .map(|u| (eid[u.edge].expect("used edge"), u.fwd))
                    .collect();
                let lid = bb
                    .add_loop(fid, &uses)
                    .map_err(|x| format!("{x} (a loop of {})", f.prov.name()))?;
                let cids = bb.body().loop_(lid).expect("loop").coedges.clone();
                for (cid, u) in cids.into_iter().zip(lp) {
                    bb.set_pcurve(cid, u.pc.clone().expect("filled"))
                        .map_err(|x| x.to_string())?;
                }
            }
        }
        Ok(bb.finish())
    }
}

/// `pc` shifted by whole periods so that its value at `t` is the period copy nearest `seed`.
fn shift_to(surf: &Surface, pc: Curve2, t: f64, seed: Point2) -> Curve2 {
    let at = pc.eval(t);
    let (pu, pv) = surf.periodicity();
    let du = pu.map_or(0.0, |p| ((seed.x - at.x) / p).round() * p);
    let dv = pv.map_or(0.0, |p| ((seed.y - at.y) / p).round() * p);
    if du == 0.0 && dv == 0.0 {
        return pc;
    }
    translate2(&pc, forge_core::linalg::Vec2::new(du, dv))
}

/// A 2D curve translated by `d`.
pub(crate) fn translate2(c: &Curve2, d: forge_core::linalg::Vec2) -> Curve2 {
    use forge_core::geom::{Circle2, Ellipse2, Line2, NurbsCurve2};
    match c {
        Curve2::Line(l) => Line2::new(l.origin() + d, l.dir())
            .map(Into::into)
            .unwrap_or_else(|_| c.clone()),
        Curve2::Circle(k) => Circle2::new(k.center() + d, k.radius())
            .map(Into::into)
            .unwrap_or_else(|_| c.clone()),
        Curve2::Ellipse(e) => Ellipse2::new(e.center() + d, e.x_dir(), e.rx(), e.ry())
            .map(Into::into)
            .unwrap_or_else(|_| c.clone()),
        Curve2::BSpline(n) => {
            let m: NurbsCurve2 = n.map_control_points(|p| [p[0] + d.x, p[1] + d.y]);
            m.into()
        }
    }
}
