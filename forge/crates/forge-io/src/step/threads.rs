//! Modelled threads in STEP: AP214/AP242's geometry has no helicoid and no helix, so a body
//! carrying them (forge-ops' threads) is written with **certified B-spline approximations**:
//! every [`Helicoid`] face as a degree-(5, 1) B-spline surface over its parameter box and
//! every [`Helix3`] edge as a degree-5 B-spline curve, each within [`THREAD_APPROX_TOL`] of
//! the exact geometry (`Helicoid::to_nurbs`, `Helix3::to_nurbs`: quintic Hermite pieces with
//! a proven error bound) and **sharing its parametrization**, so every pcurve of the body
//! stays valid unchanged and the edges still lie on their faces within the body's tolerance.
//! Everything else is copied as it is.

use forge_core::Tolerance;
use forge_core::geom::{Curve3, Surface};
use forge_core::topo::{Body, BodyBuilder};

/// Distance (mm) between the written B-splines and the exact thread geometry: a tenth of
/// the IR's linear tolerance, so the file's edges still lie on its faces within it.
pub const THREAD_APPROX_TOL: f64 = 1e-7;

/// Relative padding of a helicoid face's parameter box (its pcurves must lie inside it).
const BOX_PAD: f64 = 1e-9;

/// `true` if the body has helicoid faces or helix edges.
pub(crate) fn has_threads(body: &Body) -> bool {
    body.faces()
        .values()
        .any(|f| matches!(f.surface, Surface::Helicoid(_)))
        || body
            .edges()
            .values()
            .any(|e| matches!(e.curve, Curve3::Helix(_)))
}

/// The body with its thread geometry replaced by B-splines (see the module docs).
pub(crate) fn to_bsplines(body: &Body) -> Result<Body, String> {
    let mut bb = BodyBuilder::with_tolerance(Tolerance::IR_DEFAULT);
    let topo = |e: forge_core::topo::TopoError| e.to_string();
    let mut vmap = std::collections::BTreeMap::new();
    for (vid, v) in body.vertices().iter() {
        let nv = bb.add_vertex(v.point, v.provenance.clone()).map_err(topo)?;
        bb.set_vertex_tolerance(nv, v.tolerance).map_err(topo)?;
        vmap.insert(vid, nv);
    }
    let mut emap = std::collections::BTreeMap::new();
    for (eid, e) in body.edges().iter() {
        let curve = match &e.curve {
            Curve3::Helix(h) => Curve3::BSpline(
                h.to_nurbs(e.t_range.0, e.t_range.1, THREAD_APPROX_TOL)
                    .map_err(|x| x.to_string())?,
            ),
            c => c.clone(),
        };
        let ne = match (e.start, e.end) {
            (Some(a), Some(b)) => {
                bb.add_edge(curve, e.t_range, vmap[&a], vmap[&b], e.provenance.clone())
            }
            _ => bb.add_ring_edge_with_range(curve, e.t_range, e.provenance.clone()),
        }
        .map_err(topo)?;
        bb.set_edge_tolerance(ne, e.tolerance).map_err(topo)?;
        emap.insert(eid, ne);
    }
    let mut smap = std::collections::BTreeMap::new();
    for &sid in body.shell_ids() {
        let closed = body.shell(sid).map(|s| s.closed).unwrap_or(true);
        smap.insert(sid, bb.add_shell(closed));
    }
    for (fid, f) in body.faces().iter() {
        let surface = match &f.surface {
            Surface::Helicoid(h) => {
                let (mut ulo, mut uhi, mut vlo, mut vhi) = (
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                );
                for &lid in &f.loops {
                    let lp = body.loop_(lid).ok_or("dangling loop")?;
                    for &cid in &lp.coedges {
                        let c = body.coedge(cid).ok_or("dangling coedge")?;
                        let e = body.edge(c.edge).ok_or("dangling edge")?;
                        let pc = c.pcurve.as_ref().ok_or("a coedge has no pcurve")?;
                        for k in 0..=16 {
                            let t = e.t_range.0 + (e.t_range.1 - e.t_range.0) * k as f64 / 16.0;
                            let uv = pc.eval(t);
                            ulo = ulo.min(uv.x);
                            uhi = uhi.max(uv.x);
                            vlo = vlo.min(uv.y);
                            vhi = vhi.max(uv.y);
                        }
                    }
                }
                if !(ulo < uhi && vlo < vhi) {
                    return Err(format!(
                        "helicoid face {} has an empty parameter box",
                        f.provenance.name()
                    ));
                }
                let pu = BOX_PAD * (1.0 + ulo.abs().max(uhi.abs()));
                let pv = BOX_PAD * (1.0 + vlo.abs().max(vhi.abs()));
                Surface::BSpline(
                    h.to_nurbs(
                        (ulo - pu, uhi + pu),
                        (vlo - pv, vhi + pv),
                        THREAD_APPROX_TOL,
                    )
                    .map_err(|x| x.to_string())?,
                )
            }
            s => s.clone(),
        };
        let nf = bb
            .add_face(smap[&f.shell], surface, f.sense, f.provenance.clone())
            .map_err(topo)?;
        for &lid in &f.loops {
            let lp = body.loop_(lid).ok_or("dangling loop")?;
            let mut uses = Vec::with_capacity(lp.coedges.len());
            let mut pcs = Vec::with_capacity(lp.coedges.len());
            for &cid in &lp.coedges {
                let c = body.coedge(cid).ok_or("dangling coedge")?;
                uses.push((emap[&c.edge], c.forward));
                pcs.push(c.pcurve.clone());
            }
            let nl = bb.add_loop(nf, &uses).map_err(topo)?;
            let cids = bb
                .body()
                .loop_(nl)
                .map(|l| l.coedges.clone())
                .unwrap_or_default();
            for (cid, pc) in cids.into_iter().zip(pcs) {
                if let Some(pc) = pc {
                    bb.set_pcurve(cid, pc).map_err(topo)?;
                }
            }
        }
        let _ = fid;
    }
    Ok(bb.finish())
}
