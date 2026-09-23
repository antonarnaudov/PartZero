//! # forge-mesh — B-rep tessellation
//!
//! [`tessellate`] turns a [`Body`] into a watertight, outward-oriented triangle mesh
//! ([`BodyMesh`]) whose distance to the exact geometry is bounded by
//! [`TessParams::chordal_deflection`], whose normals turn by at most
//! [`TessParams::angular_deflection_rad`] along any mesh edge, and (optionally) whose edges
//! are no longer than [`TessParams::max_edge_length`]. [`tessellate_render`] produces the
//! same triangles with vertices split per face for rendering. [`check_watertight`],
//! [`max_deviation`] and [`mesh_volume`] validate the result.
//!
//! Everything that decides geometric quality is ours: the constrained Delaunay
//! triangulation ([`cdt`]) uses forge-core's adaptive exact predicates; there is no
//! external mesher or triangulation crate.
//!
//! ## How it works
//! 1. **Edges once.** Every edge is discretized a single time (the `edges` module):
//!    lines only need their endpoints (unless a length limit applies), circles get the
//!    uniform step meeting the chordal/angular limits, other curves are bisected
//!    adaptively. The test also checks the image of each segment on *both* adjacent faces,
//!    so neither face ever needs to split a boundary segment. Both faces then use exactly
//!    these vertices: the mesh is **watertight by construction**.
//! 2. **Faces in parameter space.** Each face's loops are mapped to its `(u, v)` domain
//!    (pcurves, or projection of the edge samples when a coedge has none), unwrapped
//!    across periodic directions, and classified by their winding numbers. Periodic
//!    faces without seams (ADR 0012) — a cylinder side between two rings, a cone bounded
//!    by one ring, a loop-less sphere or torus — are unwrapped by an internal cut placed
//!    deterministically and validated with exact predicates; both copies of the cut share
//!    vertices, so the wrap-around is stitched without duplicate seam vertices. Surface
//!    singularities (sphere poles, cone apexes, spindle-torus axis points) become
//!    *singular chains* whose points all map to one mesh vertex, producing fans with the
//!    correct limit normals.
//! 3. **CDT + refinement.** The planar domain is triangulated by our CDT (in a working
//!    metric scaled by `|S_u|`, `|S_v|`, compressed along the straight generators of
//!    cylinders and cones), seeded with a curvature-derived lattice on doubly curved
//!    faces, and refined until every edge midpoint is within `0.74·δ` of the surface
//!    (which bounds the whole triangle by `0.987·δ` for locally quadratic surfaces),
//!    every centroid within `δ`, every edge within the angular limit, and every facet
//!    oriented like the surface.
//! 4. **Assembly** in deterministic order; the face `sense` flips triangle winding so
//!    all triangles face outward.
//!
//! ## Failure policy
//! Tessellation never returns a silently wrong mesh: unsupported boundary
//! configurations, budget exhaustion and internal inconsistencies are reported as
//! [`MeshError`]s with stable codes and the provenance name of the face or edge.
//!
//! ## Determinism
//! Arenas are iterated in index order, maps are `BTreeMap`s, transcendental functions go
//! through `forge_core::math`, predicates are exact, and all refinement queues are FIFO in
//! slot order: the same body and parameters give bit-identical output on every target
//! (checked by golden fingerprints; native and `wasm32` agree).
//!
//! ## Scope and known limitations
//! - The mesher is `f64`-only (not generic over `Scalar`): it produces display/export
//!   geometry, never certified quantities — metrics are computed on the exact geometry.
//! - The deflection bound assumes locally quadratic surfaces (`0.987·δ` from the midpoint
//!   tests, 1.3 % left for higher-order terms); [`max_deviation`] measures it.
//! - A periodic band is unwrapped by one straight parameter-space cut; if every such cut
//!   is blocked by holes the face fails with `MESH_PERIODIC_CUT_NOT_FOUND`. Torus faces
//!   whose loops wind around both directions, and bands on horn tori, are rejected
//!   (`MESH_INVALID_LOOPS` / `MESH_UNBOUNDED_FACE`).
//! - Singular jumps at B-rep vertices are handled along collapsed iso-lines (sphere
//!   poles, cone apexes, collapsed B-spline rows); B-spline faces are treated as
//!   non-periodic.

pub mod cdt;
mod check;
mod edges;
mod error;
mod face;
mod mesh;
mod surf;

use std::collections::BTreeMap;

use forge_core::Vec3;
use forge_core::topo::{Body, EdgeId, VertexId};

pub use check::{
    WatertightError, WatertightIssue, WatertightStats, check_watertight, max_deviation, mesh_area,
    mesh_volume,
};
pub use error::MeshError;
pub use mesh::{BodyMesh, EdgePolyline, FaceRange, RenderMesh, TessParams};

use edges::{CoedgeView, edge_params};
use face::{EdgeSamples, FaceCtx, FaceOut, Global, mesh_face};
use surf::{Sing, Surf, Tol};

/// Per-face result kept for assembly.
struct FaceRun {
    name: String,
    surface: forge_core::Surface,
    sense: bool,
    /// Cone nappe of the face (see `surf::face_nappe_v`).
    nappe_v: Option<f64>,
    out: FaceOut,
}

/// Everything computed by one tessellation run.
struct Run {
    global: Global,
    faces: Vec<FaceRun>,
    edges: Vec<(String, Vec<u32>)>,
}

fn run(body: &Body, params: &TessParams) -> Result<Run, MeshError> {
    params.validate()?;
    let tol = Tol::new(params);
    let mut global = Global::default();

    // B-rep vertices.
    let mut vmap: BTreeMap<VertexId, u32> = BTreeMap::new();
    for (vid, v) in body.vertices().iter() {
        if !v.point.is_finite() {
            return Err(MeshError::NonFinite {
                entity: v.provenance.name(),
            });
        }
        vmap.insert(vid, global.add(v.point));
    }

    // Edges: sampled once, shared by every face that uses them.
    let mut samples: BTreeMap<EdgeId, EdgeSamples> = BTreeMap::new();
    let mut edges = Vec::new();
    for (eid, e) in body.edges().iter() {
        let name = e.provenance.name();
        let mut views = Vec::new();
        for &cid in &e.coedges {
            let c = body.coedge(cid).ok_or_else(|| MeshError::InvalidBody {
                detail: format!("edge {name}: stale coedge id"),
            })?;
            let f = body
                .loop_(c.loop_id)
                .and_then(|l| body.face(l.face))
                .ok_or_else(|| MeshError::InvalidBody {
                    detail: format!("edge {name}: coedge without face"),
                })?;
            views.push(CoedgeView {
                surf: Surf::for_face(body, f),
                pcurve: c.pcurve.as_ref(),
            });
        }
        let ts = edge_params(e, &views, &tol, &name)?;
        let n = ts.len();
        let mut gids = Vec::with_capacity(n);
        if e.is_ring() {
            for &t in &ts[..n - 1] {
                gids.push(global.add(e.curve.eval(t)));
            }
            gids.push(gids[0]);
        } else {
            let lookup = |v: Option<VertexId>| {
                v.and_then(|v| vmap.get(&v).copied())
                    .ok_or_else(|| MeshError::InvalidBody {
                        detail: format!("edge {name}: missing vertex"),
                    })
            };
            gids.push(lookup(e.start)?);
            for &t in &ts[1..n - 1] {
                gids.push(global.add(e.curve.eval(t)));
            }
            gids.push(lookup(e.end)?);
        }
        edges.push((name, gids.clone()));
        samples.insert(eid, EdgeSamples { ts, gids });
    }

    // Faces.
    let mut faces = Vec::new();
    for (_, f) in body.faces().iter() {
        let name = f.provenance.name();
        let ctx = FaceCtx {
            body,
            face: f,
            name: &name,
            samples: &samples,
            tol,
        };
        let out = mesh_face(&ctx, &mut global)?;
        faces.push(FaceRun {
            name,
            surface: f.surface.clone(),
            sense: f.sense,
            nappe_v: surf::face_nappe_v(body, f),
            out,
        });
    }
    for p in &global.pos {
        if !p.is_finite() {
            return Err(MeshError::NonFinite {
                entity: "mesh vertex".into(),
            });
        }
    }
    Ok(Run {
        global,
        faces,
        edges,
    })
}

/// Map a face triangle to mesh vertices; `None` for a triangle collapsed onto a singular
/// vertex (the degenerate half of a fan). A repeated non-singular vertex is a bug.
fn face_triangle(fr: &FaceRun, t: [u32; 3]) -> Result<Option<[u32; 3]>, MeshError> {
    let p = t.map(|k| fr.out.pts[k as usize]);
    for i in 0..3 {
        let (a, b) = (p[i], p[(i + 1) % 3]);
        if a.gid == b.gid {
            if a.sing != Sing::No && b.sing != Sing::No {
                return Ok(None);
            }
            return Err(MeshError::Internal {
                face: fr.name.clone(),
                detail: "triangle joins two copies of a cut vertex",
            });
        }
    }
    let g = p.map(|x| x.gid);
    Ok(Some(if fr.sense { g } else { [g[0], g[2], g[1]] }))
}

/// Parameters for the limit normal at singular corner `k` of a face triangle: the
/// irrelevant coordinate is replaced by the mean of the triangle's regular corners.
fn singular_limit_uv(fr: &FaceRun, t: [u32; 3], k: usize) -> [f64; 2] {
    let p = fr.out.pts[t[k] as usize];
    let regular: Vec<[f64; 2]> = t
        .iter()
        .map(|&j| fr.out.pts[j as usize])
        .filter(|q| q.sing == Sing::No)
        .map(|q| q.uv)
        .collect();
    let mut uv = p.uv;
    if !regular.is_empty() {
        let m = regular.len() as f64;
        match p.sing {
            Sing::U => uv[0] = regular.iter().map(|q| q[0]).sum::<f64>() / m,
            Sing::V => uv[1] = regular.iter().map(|q| q[1]).sum::<f64>() / m,
            Sing::No => {}
        }
    }
    uv
}

fn to_f32(v: Vec3) -> [f32; 3] {
    [v.x as f32, v.y as f32, v.z as f32]
}

/// Tessellate a body (see the crate docs).
pub fn tessellate(body: &Body, params: &TessParams) -> Result<BodyMesh, MeshError> {
    let r = run(body, params)?;
    let n = r.global.pos.len();
    let mut acc = vec![Vec3::zero(); n];
    let mut stamp = vec![usize::MAX; n];
    let mut triangles = Vec::new();
    let mut face_ranges = Vec::with_capacity(r.faces.len());
    for (fi, fr) in r.faces.iter().enumerate() {
        let surf = Surf::with_nappe(&fr.surface, fr.sense, fr.nappe_v);
        for p in &fr.out.pts {
            let g = p.gid as usize;
            if p.sing != Sing::No || stamp[g] == fi {
                continue;
            }
            stamp[g] = fi;
            if let Some(nrm) = surf.normal_out(p.uv) {
                acc[g] += nrm;
            }
        }
        let start = triangles.len();
        for &t in &fr.out.tris {
            if let Some(g) = face_triangle(fr, t)? {
                // Singular corners: the limit normal along this fan triangle, weighted by
                // its angle at the singular point (exact axis for poles and apexes).
                for k in 0..3 {
                    let p = fr.out.pts[t[k] as usize];
                    if p.sing == Sing::No {
                        continue;
                    }
                    let uv = singular_limit_uv(fr, t, k);
                    let c = r.global.pos[p.gid as usize];
                    let a = r.global.pos[g[(k + 1) % 3] as usize] - c;
                    let b = r.global.pos[g[(k + 2) % 3] as usize] - c;
                    let w = forge_core::math::atan2(a.cross(b).norm(), a.dot(b));
                    if let Some(nrm) = surf.normal_out(uv) {
                        acc[p.gid as usize] += nrm * w;
                    }
                }
                triangles.push(g);
            }
        }
        face_ranges.push(FaceRange {
            face_name: fr.name.clone(),
            tri_start: start as u32,
            tri_count: (triangles.len() - start) as u32,
        });
    }
    // Fallback normals (vertices not on any face): area-weighted facet normals.
    let mut facet = vec![Vec3::zero(); n];
    for t in &triangles {
        let [a, b, c] = t.map(|k| r.global.pos[k as usize]);
        let nf = (b - a).cross(c - a);
        for &k in t {
            facet[k as usize] += nf;
        }
    }
    let normals = (0..n)
        .map(|i| {
            acc[i]
                .normalize()
                .or_else(|| facet[i].normalize())
                .map_or([0.0; 3], to_f32)
        })
        .collect();
    Ok(BodyMesh {
        positions: r.global.pos.iter().map(|p| p.to_array()).collect(),
        normals,
        triangles,
        face_ranges,
        edge_polylines: r
            .edges
            .into_iter()
            .map(|(edge_name, gids)| EdgePolyline {
                edge_name,
                points: gids
                    .iter()
                    .map(|&g| r.global.pos[g as usize].to_array())
                    .collect(),
            })
            .collect(),
    })
}

/// Tessellate a body into a render mesh: the same triangles as [`tessellate`], with
/// vertices split per face and each carrying its face's exact outward normal (limit
/// normals at singular points, per fan triangle at a cone apex), plus the same edge
/// polylines as [`tessellate`] (one run; the edges are sampled once).
pub fn tessellate_render(body: &Body, params: &TessParams) -> Result<RenderMesh, MeshError> {
    let r = run(body, params)?;
    let mut out = RenderMesh::default();
    for fr in &r.faces {
        let surf = Surf::with_nappe(&fr.surface, fr.sense, fr.nappe_v);
        let start = out.triangles.len();
        let mut local: Vec<u32> = vec![u32::MAX; fr.out.pts.len()];
        for &t in &fr.out.tris {
            if face_triangle(fr, t)?.is_none() {
                continue;
            }
            let mut tri = [0u32; 3];
            for (k, &li) in t.iter().enumerate() {
                if local[li as usize] == u32::MAX {
                    let p = fr.out.pts[li as usize];
                    let pos = r.global.pos[p.gid as usize];
                    let nrm = match p.sing {
                        // At a singular point use the limit normal along the fan
                        // triangle's regular corners (mean parameter).
                        Sing::No => surf.normal_out(p.uv),
                        _ => {
                            let uv = singular_limit_uv(fr, t, k);
                            // Singular corners are not shared between fan triangles.
                            let idx = out.positions.len() as u32;
                            out.positions.push(to_f32(pos));
                            out.normals
                                .push(surf.normal_out(uv).map_or([0.0; 3], to_f32));
                            tri[k] = idx;
                            continue;
                        }
                    };
                    local[li as usize] = out.positions.len() as u32;
                    out.positions.push(to_f32(pos));
                    out.normals.push(nrm.map_or([0.0; 3], to_f32));
                }
                tri[k] = local[li as usize];
            }
            out.triangles.push(if fr.sense {
                tri
            } else {
                [tri[0], tri[2], tri[1]]
            });
        }
        out.face_ranges.push(FaceRange {
            face_name: fr.name.clone(),
            tri_start: start as u32,
            tri_count: (out.triangles.len() - start) as u32,
        });
    }
    out.edge_polylines = r
        .edges
        .into_iter()
        .map(|(edge_name, gids)| EdgePolyline {
            edge_name,
            points: gids
                .iter()
                .map(|&g| r.global.pos[g as usize].to_array())
                .collect(),
        })
        .collect();
    Ok(out)
}
