//! Extrude (SPEC §4.2, §4.4): a region swept along the sketch normal into a seam-free
//! solid.
//!
//! # Topology
//! - **Caps**: two planar faces (`cap:start`, `cap:end`) whose loops mirror the region's
//!   loops. The cap at the lower offset has outward normal `−n` (`sense = false`, loops
//!   reversed), the upper one `+n`.
//! - **Sides**: one face per sketch curve ([R-8]): a line gives a `plane`, an arc a
//!   `cylinder` whose `u` range is the arc's angles, a circle a full `cylinder` bounded
//!   by two **ring** edges (no seam, no vertex).
//! - **Edges**: a bottom and a top copy of every curve, plus one vertical line per loop
//!   junction. Every coedge has a pcurve.
//!
//! Side faces have the material on the left of the (counter-clockwise outer, clockwise
//! hole) loop direction, so their outward normal is `tangent × n`; the `sense` of every
//! face is derived from that vector against the surface normal at the face's middle.

use forge_core::Tolerance;
use forge_core::geom::{Circle2, Circle3, Curve2, Cylinder, Line2, Line3, Plane, Surface};
use forge_core::linalg::{Frame, Vec2, Vec3};
use forge_core::math;
use forge_core::topo::{Body, Provenance};
use forge_ir::SweepDirection;

use crate::error::OpError;
use crate::plan::{PUse, Plan, check_curve_ids};
use crate::plane::lift;
use crate::sketch::{LoopCurveGeom, Region};

/// Extrude `region` (sketch coordinates of `frame`) by `distance` in `direction` into one
/// solid body whose entities carry provenance of feature `feature`.
///
/// Errors: `INVALID_PARAMETER` for a non-finite or degenerate distance,
/// `FORGE_INVALID_CURVE_ID` for curve ids that cannot be part of a provenance name,
/// `INVALID_RESULT`/`FORGE_INTERNAL` if the result fails Forge's own checks.
pub fn extrude(
    region: &Region,
    frame: &Frame,
    distance: f64,
    direction: SweepDirection,
    feature: &str,
) -> Result<Body, OpError> {
    let tol = Tolerance::IR_DEFAULT;
    if !(distance.is_finite() && distance > tol.linear) {
        return Err(OpError::InvalidParameter {
            what: "extrude distance",
            value: distance,
            expected: "finite and > 1e-6 mm",
        });
    }
    check_curve_ids(
        region
            .loops()
            .flat_map(|l| l.curves.iter().map(|c| c.id.as_str())),
    )?;
    let (z0, z1) = match direction {
        SweepDirection::Normal => (0.0, distance),
        SweepDirection::Reverse => (-distance, 0.0),
        SweepDirection::Symmetric => (-0.5 * distance, 0.5 * distance),
    };
    let h = z1 - z0;
    let (bottom_prov, top_prov) = match direction {
        SweepDirection::Reverse => (Provenance::cap_end(feature), Provenance::cap_start(feature)),
        _ => (Provenance::cap_start(feature), Provenance::cap_end(feature)),
    };
    let n = frame.z();
    let at = |z: f64| frame.with_origin(frame.to_world_point(Vec3::new(0.0, 0.0, z)));

    let mut plan = Plan::new(feature, tol);
    let mut bottom_loops: Vec<Vec<PUse>> = Vec::new();
    let mut top_loops: Vec<Vec<PUse>> = Vec::new();
    let mut sides: Vec<(Surface, bool, Provenance, Vec<Vec<PUse>>)> = Vec::new();
    let unit_u = |o: Vec2| -> Result<Curve2, OpError> { Ok(Line2::new(o, Vec2::unit_x())?.into()) };
    let unit_v = |o: Vec2| -> Result<Curve2, OpError> { Ok(Line2::new(o, Vec2::unit_y())?.into()) };

    for lp in region.loops() {
        if let [c] = lp.curves.as_slice()
            && let LoopCurveGeom::Circle {
                center,
                radius,
                ccw,
            } = c.geom
        {
            let fb = frame.with_origin(lift(frame, center, z0));
            let ft = frame.with_origin(lift(frame, center, z1));
            let eb = plan.ring(
                Circle3::new(fb, radius)?,
                (0.0, math::TAU),
                tol.linear,
                format!("{}@bottom", c.id),
            );
            let et = plan.ring(
                Circle3::new(ft, radius)?,
                (0.0, math::TAU),
                tol.linear,
                format!("{}@top", c.id),
            );
            let cap_pc: Curve2 = Circle2::new(center, radius)?.into();
            bottom_loops.push(vec![PUse {
                edge: eb,
                forward: !ccw,
                pcurve: cap_pc.clone(),
            }]);
            top_loops.push(vec![PUse {
                edge: et,
                forward: ccw,
                pcurve: cap_pc,
            }]);
            let cyl = Surface::Cylinder(Cylinder::new(fb, radius)?);
            let tangent = if ccw { Vec2::unit_y() } else { -Vec2::unit_y() };
            let outward = frame.to_world_vector(tangent.extend(0.0)).cross(n);
            let sense = sense_at(&cyl, 0.0, 0.5 * h, outward)?;
            sides.push((
                cyl,
                sense,
                Provenance::side(feature, c.id.as_str()),
                vec![
                    vec![PUse {
                        edge: eb,
                        forward: ccw,
                        pcurve: unit_u(Vec2::zero())?,
                    }],
                    vec![PUse {
                        edge: et,
                        forward: !ccw,
                        pcurve: unit_u(Vec2::new(0.0, h))?,
                    }],
                ],
            ));
            continue;
        }

        let m = lp.curves.len();
        let mut vb = Vec::with_capacity(m);
        let mut vt = Vec::with_capacity(m);
        let mut vert = Vec::with_capacity(m);
        for j in &lp.junctions {
            let pb = lift(frame, j.point, z0);
            let pt = lift(frame, j.point, z1);
            let b = plan.vertex(pb, j.tolerance, format!("{}@bottom", j.key));
            let t = plan.vertex(pt, j.tolerance, format!("{}@top", j.key));
            vert.push(plan.edge(
                Line3::new(pb, n)?,
                (0.0, h),
                b,
                t,
                j.tolerance,
                j.key.clone(),
            ));
            vb.push(b);
            vt.push(t);
        }
        let mut bottom_uses = Vec::with_capacity(m);
        let mut top_uses = Vec::with_capacity(m);
        for (k, c) in lp.curves.iter().enumerate() {
            let kn = (k + 1) % m;
            let (ja, jb) = (lp.junctions[k].point, lp.junctions[kn].point);
            let (fwd, eb, et, cap_pc, surface, u_start, u_end, mid_uv, tangent) = match c.geom {
                LoopCurveGeom::Line { .. } => {
                    let (pb0, pb1) = (lift(frame, ja, z0), lift(frame, jb, z0));
                    let (pt0, pt1) = (lift(frame, ja, z1), lift(frame, jb, z1));
                    let len = pb0.distance(pb1);
                    let eb = plan.edge(
                        Line3::through(pb0, pb1)?,
                        (0.0, len),
                        vb[k],
                        vb[kn],
                        tol.linear,
                        format!("{}@bottom", c.id),
                    );
                    let et = plan.edge(
                        Line3::through(pt0, pt1)?,
                        (0.0, len),
                        vt[k],
                        vt[kn],
                        tol.linear,
                        format!("{}@top", c.id),
                    );
                    let dhat = (pb1 - pb0) / len;
                    let pf = Frame::from_normal_x(pb0, dhat.cross(n), dhat).ok_or_else(|| {
                        OpError::Internal(format!("degenerate side plane for curve {:?}", c.id))
                    })?;
                    let cap_pc: Curve2 = Line2::through(ja, jb)?.into();
                    (
                        true,
                        eb,
                        et,
                        cap_pc,
                        Surface::Plane(Plane::new(pf)),
                        0.0,
                        len,
                        (0.5 * len, 0.5 * h),
                        dhat,
                    )
                }
                LoopCurveGeom::Arc {
                    center,
                    radius,
                    start_angle,
                    sweep,
                } => {
                    let fb = frame.with_origin(lift(frame, center, z0));
                    let ft = frame.with_origin(lift(frame, center, z1));
                    let fwd = sweep > 0.0;
                    let range = if fwd {
                        (start_angle, start_angle + sweep)
                    } else {
                        (start_angle + sweep, start_angle)
                    };
                    let (sb, eb_v) = if fwd {
                        (vb[k], vb[kn])
                    } else {
                        (vb[kn], vb[k])
                    };
                    let (st, et_v) = if fwd {
                        (vt[k], vt[kn])
                    } else {
                        (vt[kn], vt[k])
                    };
                    let eb = plan.edge(
                        Circle3::new(fb, radius)?,
                        range,
                        sb,
                        eb_v,
                        tol.linear,
                        format!("{}@bottom", c.id),
                    );
                    let et = plan.edge(
                        Circle3::new(ft, radius)?,
                        range,
                        st,
                        et_v,
                        tol.linear,
                        format!("{}@top", c.id),
                    );
                    let cap_pc: Curve2 = Circle2::new(center, radius)?.into();
                    let mid = start_angle + 0.5 * sweep;
                    let (s, co) = math::sin_cos(mid);
                    let t2 = Vec2::new(-s, co) * sweep.signum();
                    (
                        fwd,
                        eb,
                        et,
                        cap_pc,
                        Surface::Cylinder(Cylinder::new(fb, radius)?),
                        start_angle,
                        start_angle + sweep,
                        (mid, 0.5 * h),
                        frame.to_world_vector(t2.extend(0.0)),
                    )
                }
                LoopCurveGeom::Circle { .. } => {
                    return Err(OpError::Internal(format!(
                        "circle {:?} inside a multi-curve loop",
                        c.id
                    )));
                }
            };
            bottom_uses.push(PUse {
                edge: eb,
                forward: !fwd,
                pcurve: cap_pc.clone(),
            });
            top_uses.push(PUse {
                edge: et,
                forward: fwd,
                pcurve: cap_pc,
            });
            let outward = tangent.cross(n);
            let sense = sense_at(&surface, mid_uv.0, mid_uv.1, outward)?;
            // Side pcurves: lines use (distance along the curve, height); arcs (angle,
            // height). Edge curves are parametrized the same way.
            let (pc_b, pc_t) = (unit_u(Vec2::zero())?, unit_u(Vec2::new(0.0, h))?);
            let side_loop = vec![
                PUse {
                    edge: eb,
                    forward: fwd,
                    pcurve: pc_b,
                },
                PUse {
                    edge: vert[kn],
                    forward: true,
                    pcurve: unit_v(Vec2::new(u_end, 0.0))?,
                },
                PUse {
                    edge: et,
                    forward: !fwd,
                    pcurve: pc_t,
                },
                PUse {
                    edge: vert[k],
                    forward: false,
                    pcurve: unit_v(Vec2::new(u_start, 0.0))?,
                },
            ];
            sides.push((
                surface,
                sense,
                Provenance::side(feature, c.id.as_str()),
                vec![side_loop],
            ));
        }
        bottom_uses.reverse();
        bottom_loops.push(bottom_uses);
        top_loops.push(top_uses);
    }

    plan.face(Plane::new(at(z0)), false, bottom_prov, bottom_loops);
    plan.face(Plane::new(at(z1)), true, top_prov, top_loops);
    for (surface, sense, prov, loops) in sides {
        plan.face(surface, sense, prov, loops);
    }
    plan.build()
}

/// `true` if the surface normal at `(u, v)` agrees with `outward`; an error if the two
/// are not clearly parallel (a construction bug).
pub(crate) fn sense_at(surface: &Surface, u: f64, v: f64, outward: Vec3) -> Result<bool, OpError> {
    let n = surface
        .normal(u, v)
        .ok_or_else(|| OpError::Internal(format!("{} normal undefined", surface.kind_name())))?;
    let w = outward
        .normalize()
        .ok_or_else(|| OpError::Internal("zero outward direction".into()))?;
    let d = n.dot(w);
    if d.abs() < 0.5 {
        return Err(OpError::Internal(format!(
            "{} normal is not aligned with the outward direction (cos = {d})",
            surface.kind_name()
        )));
    }
    Ok(d > 0.0)
}
