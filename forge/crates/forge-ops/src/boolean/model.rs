//! The boolean's working model: both operands' vertices, edges and faces in flat tables
//! (indices, not arena ids), each face with its parameter-domain chart.

use std::collections::BTreeMap;

use forge_core::geom::{Curve2, Curve3, Surface};
use forge_core::linalg::Point3;
use forge_core::topo::{Body, EdgeId, Provenance, VertexId};
use forge_ssi::UvBox;

use super::chart::{Chart, Input, Use};
use super::error::BooleanError;
use super::geom::{Aabb, curve_box, supported_surface, surface_box};

/// A vertex of an operand.
#[derive(Clone, Debug)]
pub(crate) struct MVert {
    pub p: Point3,
    pub tol: f64,
    pub prov: Provenance,
}

/// An edge of an operand.
#[derive(Clone, Debug)]
pub(crate) struct MEdge {
    pub curve: Curve3,
    pub range: (f64, f64),
    pub start: Option<usize>,
    pub end: Option<usize>,
    pub tol: f64,
    pub prov: Provenance,
    pub operand: usize,
    pub bbox: Aabb,
}

/// A coedge of an operand face.
#[derive(Clone, Debug)]
pub(crate) struct MUse {
    pub edge: usize,
    pub forward: bool,
    pub pcurve: Curve2,
}

/// A face of an operand.
pub(crate) struct MFace {
    pub surface: Surface,
    pub sense: bool,
    pub prov: Provenance,
    pub operand: usize,
    pub loops: Vec<Vec<MUse>>,
    /// Chart of the original face (boundary only).
    pub chart: Chart,
    pub uvbox: UvBox,
    pub bbox: Aabb,
    /// Index of the operand shell the face belongs to.
    pub shell: usize,
    /// The face bounds a **void** of its operand: its shell's box lies strictly inside the
    /// box of another shell of the operand (a body is one lump: one outer shell, the others
    /// cavities). Its outward normal points into the cavity.
    pub void: bool,
}

impl MFace {
    /// The face's edges.
    pub fn edges(&self) -> impl Iterator<Item = usize> + '_ {
        self.loops.iter().flatten().map(|u| u.edge)
    }
}

/// Both operands.
pub(crate) struct Model {
    pub verts: Vec<MVert>,
    pub edges: Vec<MEdge>,
    pub faces: Vec<MFace>,
    /// Faces `[face_start[k], face_start[k + 1])` belong to operand `k`.
    pub face_start: [usize; 3],
    /// Shells per operand.
    pub shells: [usize; 2],
    pub bbox: [Aabb; 2],
}

impl Model {
    /// Load two bodies.
    pub fn new(a: &Body, b: &Body) -> Result<Self, BooleanError> {
        let mut m = Model {
            verts: Vec::new(),
            edges: Vec::new(),
            faces: Vec::new(),
            face_start: [0, 0, 0],
            shells: [0, 0],
            bbox: [Aabb::empty(), Aabb::empty()],
        };
        m.load(a, 0)?;
        m.face_start[1] = m.faces.len();
        m.load(b, 1)?;
        m.face_start[2] = m.faces.len();
        Ok(m)
    }

    /// Faces of operand `k`.
    pub fn faces_of(&self, k: usize) -> std::ops::Range<usize> {
        self.face_start[k]..self.face_start[k + 1]
    }

    fn load(&mut self, body: &Body, operand: usize) -> Result<(), BooleanError> {
        let mut vmap: BTreeMap<VertexId, usize> = BTreeMap::new();
        let mut emap: BTreeMap<EdgeId, usize> = BTreeMap::new();
        let mut bbox = Aabb::empty();
        for (si, &sid) in body.shell_ids().iter().enumerate() {
            let shell = body
                .shell(sid)
                .ok_or_else(|| BooleanError::inconsistent("dangling shell", "operand"))?;
            if !shell.closed {
                return Err(BooleanError::Unsupported {
                    what: "open shell (sheet body)",
                    entity: format!("operand {operand} shell {si}"),
                });
            }
            for &fid in &shell.faces {
                let f = body
                    .face(fid)
                    .ok_or_else(|| BooleanError::inconsistent("dangling face", "operand"))?;
                if !supported_surface(&f.surface) {
                    return Err(BooleanError::Unsupported {
                        what: "surface type (B-spline, horn or spindle torus)",
                        entity: f.provenance.name(),
                    });
                }
                let mut loops = Vec::new();
                for &lid in &f.loops {
                    let lp = body.loop_(lid).ok_or_else(|| {
                        BooleanError::inconsistent("dangling loop", f.provenance.name())
                    })?;
                    let mut uses = Vec::new();
                    for &cid in &lp.coedges {
                        let c = body.coedge(cid).ok_or_else(|| {
                            BooleanError::inconsistent("dangling coedge", f.provenance.name())
                        })?;
                        let pcurve = c.pcurve.clone().ok_or_else(|| {
                            BooleanError::inconsistent(
                                "coedge without a pcurve",
                                f.provenance.name(),
                            )
                        })?;
                        let ei = match emap.get(&c.edge) {
                            Some(&i) => i,
                            None => {
                                let e = body.edge(c.edge).ok_or_else(|| {
                                    BooleanError::inconsistent("dangling edge", f.provenance.name())
                                })?;
                                let mut vid =
                                    |v: Option<VertexId>| -> Result<Option<usize>, BooleanError> {
                                        let Some(v) = v else { return Ok(None) };
                                        if let Some(&i) = vmap.get(&v) {
                                            return Ok(Some(i));
                                        }
                                        let vx = body.vertex(v).ok_or_else(|| {
                                            BooleanError::inconsistent(
                                                "dangling vertex",
                                                e.provenance.name(),
                                            )
                                        })?;
                                        self.verts.push(MVert {
                                            p: vx.point,
                                            tol: vx.tolerance,
                                            prov: vx.provenance.clone(),
                                        });
                                        vmap.insert(v, self.verts.len() - 1);
                                        Ok(Some(self.verts.len() - 1))
                                    };
                                let (s, t) = (vid(e.start)?, vid(e.end)?);
                                let eb = curve_box(&e.curve, e.t_range).grown(e.tolerance);
                                bbox.add_box(&eb);
                                self.edges.push(MEdge {
                                    curve: e.curve.clone(),
                                    range: e.t_range,
                                    start: s,
                                    end: t,
                                    tol: e.tolerance,
                                    prov: e.provenance.clone(),
                                    operand,
                                    bbox: eb,
                                });
                                emap.insert(c.edge, self.edges.len() - 1);
                                self.edges.len() - 1
                            }
                        };
                        uses.push(MUse {
                            edge: ei,
                            forward: c.forward,
                            pcurve,
                        });
                    }
                    loops.push(uses);
                }
                let inputs: Vec<Input> = loops
                    .iter()
                    .flatten()
                    .map(|u: &MUse| {
                        let e = &self.edges[u.edge];
                        Input {
                            pcurve: u.pcurve.clone(),
                            range: e.range,
                            start: e.start,
                            end: e.end,
                            use_: Use::Boundary(u.forward),
                        }
                    })
                    .collect();
                let chart = Chart::build(&f.surface, f.sense, inputs).map_err(|e| {
                    BooleanError::inconsistent(
                        format!("operand face domain: {e}"),
                        f.provenance.name(),
                    )
                })?;
                if chart.face_count() != 1 {
                    return Err(BooleanError::inconsistent(
                        format!("operand face domain has {} components", chart.face_count()),
                        f.provenance.name(),
                    ));
                }
                let (u, v) = chart.uv_box();
                let uvbox = UvBox::new(u.0, u.1, v.0, v.1);
                let fb = surface_box(&f.surface, u, v, 4);
                bbox.add_box(&fb);
                self.faces.push(MFace {
                    surface: f.surface.clone(),
                    sense: f.sense,
                    prov: f.provenance.clone(),
                    operand,
                    loops,
                    chart,
                    uvbox,
                    bbox: fb.grown(1e-6),
                    shell: si,
                    void: false,
                });
            }
        }
        // Voids: shells whose box lies strictly inside another shell's box.
        let first = self
            .faces
            .iter()
            .position(|f| f.operand == operand)
            .unwrap_or(self.faces.len());
        let nshells = body.shell_ids().len();
        let mut boxes = vec![Aabb::empty(); nshells];
        for f in &self.faces[first..] {
            boxes[f.shell].add_box(&f.bbox);
        }
        let inside = |a: &Aabb, b: &Aabb| {
            !a.is_empty()
                && !b.is_empty()
                && b.lo.x < a.lo.x
                && b.lo.y < a.lo.y
                && b.lo.z < a.lo.z
                && a.hi.x < b.hi.x
                && a.hi.y < b.hi.y
                && a.hi.z < b.hi.z
        };
        let void: Vec<bool> = (0..nshells)
            .map(|i| (0..nshells).any(|j| j != i && inside(&boxes[i], &boxes[j])))
            .collect();
        for f in &mut self.faces[first..] {
            f.void = void[f.shell];
        }
        self.shells[operand] = nshells;
        self.bbox[operand] = bbox;
        Ok(())
    }
}
