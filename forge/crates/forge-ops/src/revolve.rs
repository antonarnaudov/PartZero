//! Revolve (SPEC §4.3, §4.4): a region swept about an axis in its sketch plane.
//!
//! # Profile coordinates
//! Every sketch point is mapped to `(ρ, h)`: `h` along the axis direction, `ρ ≥ 0` the
//! distance from the axis on the region's side. The map is an isometry; when it reverses
//! orientation the loops are traversed backwards so the region stays on the left (outer
//! loop counter-clockwise in `(ρ, h)`). A profile point at sweep angle `φ` is
//! `A + h·D + ρ·(cos φ·x + sin φ·y)` in the revolve frame (`A` axis origin, `D` axis
//! direction, `x` the start direction of the sweep, `y = D × x`), with `φ ∈ [0, Θ]`.
//!
//! # Topology (normative per [R-8, R-9])
//! | Profile curve | Face |
//! |---|---|
//! | line on the axis (both ends within tol) | none |
//! | line ∥ axis (`|Δρ| ≤ 1e-9·L`) | `cylinder` |
//! | line ⟂ axis (`|Δh| ≤ 1e-9·L`) | `plane` (disc/annulus sector) |
//! | other line | `cone` (apex on the axis is a surface singularity) |
//! | arc centred on the axis (within tol) | `sphere` |
//! | other arc / circle | `torus`: ring, horn, or a spindle-torus patch |
//!
//! - Off-axis profile vertices sweep **ring edges** at 360° and circular **arcs** below.
//! - On-axis profile vertices are singular points: no edge, no vertex at 360°; below
//!   360° they are one vertex shared by both end caps.
//! - A profile line on the axis is, below 360°, one line edge shared by both end caps.
//! - Below 360° there are two planar end caps (`endcap:start` at `φ = 0`,
//!   `endcap:end` at `φ = Θ`) whose loops are the profile loops.
//! - Shells are the connected components of the faces (a full revolve of a region with
//!   holes has a cavity shell per hole).
//!
//! The side-face loop of a profile curve `P0 → P1` follows the counter-clockwise boundary
//! of its `(φ, s)` parameter rectangle: arc of `P0` (+φ), end-cap copy (`P0 → P1`), arc of
//! `P1` (−φ), start-cap copy (`P1 → P0`); `M_φ × M_s = ρ·N_out` makes this the outward
//! orientation. Each face's `sense` is checked numerically against the outward normal
//! `t_h·e_r(φ) − t_ρ·D` of the profile tangent `t`.

use forge_core::Tolerance;
use forge_core::geom::{
    Circle2, Circle3, Cone, Curve2, Cylinder, Line2, Line3, NurbsCurve2, Plane, Sphere,
    SpindlePatch, Surface, Torus,
};
use forge_core::linalg::{Frame, Point2, Point3, Vec2, Vec3};
use forge_core::topo::{Body, Provenance};
use forge_core::{math, orient2d};
use forge_ir::{SketchAxis, SweepDirection};

use crate::error::OpError;
use crate::extrude::sense_at;
use crate::plan::{EIdx, PUse, Plan, VIdx, check_curve_ids};
use crate::sketch::prim::{circle_point, contains_angle};
use crate::sketch::{Loop, LoopCurveGeom, Region};

/// Angular tolerance for the parallel/perpendicular classification (SPEC §1).
pub const ANGULAR_TOLERANCE: f64 = 1e-9;

/// Which side of the (directed) axis a region lies on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AxisSide {
    /// Left of the axis direction (positive signed distance).
    Left,
    /// Right of the axis direction.
    Right,
}

/// SPEC §4.3 [R-7]: the side of the axis the region lies on, or `REVOLVE_CROSSES_AXIS`
/// if it has points farther than `tol` on both sides.
///
/// The candidate extreme points are the junction points of the outer loop and, for arcs
/// and circles, the carrier-circle points farthest from the axis on either side when
/// they lie on the curve. A point within `tol` of the axis is on it; beyond that its side
/// is the exact sign of [`orient2d`] against the axis line.
pub fn check_revolve_profile(
    region: &Region,
    axis: &SketchAxis,
    tol: f64,
) -> Result<AxisSide, OpError> {
    let o = Point2::from(axis.origin);
    let raw = Vec2::from(axis.direction);
    let dh = raw.normalize().ok_or(OpError::InvalidParameter {
        what: "revolve axis direction length",
        value: raw.norm(),
        expected: "> 0",
    })?;
    let nrm = dh.perp();
    let o2 = o + raw;
    let mut pts: Vec<Point2> = Vec::new();
    let lp = &region.outer;
    for (k, c) in lp.curves.iter().enumerate() {
        match c.geom {
            LoopCurveGeom::Line { start, end } => pts.extend([start, end]),
            LoopCurveGeom::Arc {
                center,
                radius,
                start_angle,
                sweep,
            } => {
                let (a, b) = lp.curve_ends(k);
                pts.extend([a, b]);
                let (t0, sw) = if sweep > 0.0 {
                    (start_angle, sweep)
                } else {
                    (start_angle + sweep, -sweep)
                };
                for s in [1.0, -1.0] {
                    let t = math::atan2(s * nrm.y, s * nrm.x);
                    if contains_angle(t0, sw, false, t, 0.0) {
                        pts.push(circle_point(center, radius, t));
                    }
                }
            }
            LoopCurveGeom::Circle { center, radius, .. } => {
                pts.extend([center + nrm * radius, center - nrm * radius]);
            }
        }
    }
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut left, mut right) = (false, false);
    for p in pts {
        let d = dh.perp_dot(p - o);
        lo = lo.min(d);
        hi = hi.max(d);
        if d.abs() > tol {
            if orient2d(o, o2, p) > 0.0 {
                left = true;
            } else {
                right = true;
            }
        }
    }
    match (left, right) {
        (true, true) => Err(OpError::RevolveCrossesAxis {
            outer_curves: region.outer_curves.clone(),
            min: lo,
            max: hi,
            tolerance: tol,
        }),
        (true, false) => Ok(AxisSide::Left),
        (false, true) => Ok(AxisSide::Right),
        (false, false) => Err(OpError::Internal(format!(
            "region {:?} lies within the tolerance band of the revolve axis",
            region.outer_curves
        ))),
    }
}

// ---- profile ----------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct PJunction {
    p: Point2,
    on_axis: bool,
    tol: f64,
    key: String,
}

#[derive(Clone, Copy, Debug)]
enum PKind {
    Line { a: Point2, b: Point2 },
    Arc { c: Point2, r: f64, a0: f64, sw: f64 },
    Circle { c: Point2, r: f64, ccw: bool },
}

#[derive(Clone, Debug)]
struct PCurve {
    id: String,
    kind: PKind,
}

struct PLoop {
    curves: Vec<PCurve>,
    junctions: Vec<PJunction>,
}

struct ProfileMap {
    o: Point2,
    dh: Vec2,
    sigma: f64,
    tol: f64,
}

impl ProfileMap {
    fn point(&self, p: Point2) -> Point2 {
        let w = p - self.o;
        Point2::new(self.sigma * self.dh.perp_dot(w), self.dh.dot(w))
    }
    fn vector(&self, v: Vec2) -> Vec2 {
        Vec2::new(self.sigma * self.dh.perp_dot(v), self.dh.dot(v))
    }
    /// +1 if the map preserves orientation.
    fn orientation(&self) -> f64 {
        -self.sigma
    }
    fn profile_loop(&self, lp: &Loop) -> PLoop {
        let lp = if self.orientation() < 0.0 {
            lp.reversed()
        } else {
            lp.clone()
        };
        let junctions: Vec<PJunction> = lp
            .junctions
            .iter()
            .map(|j| {
                let mut p = self.point(j.point);
                let on_axis = p.x.abs() <= self.tol;
                let mut tol = j.tolerance;
                if on_axis {
                    tol += p.x.abs();
                    p.x = 0.0;
                }
                PJunction {
                    p,
                    on_axis,
                    tol,
                    key: j.key.clone(),
                }
            })
            .collect();
        let n = lp.curves.len();
        let curves = lp
            .curves
            .iter()
            .enumerate()
            .map(|(k, c)| PCurve {
                id: c.id.clone(),
                kind: match c.geom {
                    LoopCurveGeom::Line { .. } => PKind::Line {
                        a: junctions[k].p,
                        b: junctions[(k + 1) % n].p,
                    },
                    LoopCurveGeom::Arc {
                        center,
                        radius,
                        start_angle,
                        sweep,
                    } => {
                        let (s, co) = math::sin_cos(start_angle);
                        let d = self.vector(Vec2::new(co, s));
                        let c = self.point(center);
                        let (a0, sw) = (math::atan2(d.y, d.x), sweep * self.orientation());
                        if c.x.abs() <= self.tol {
                            // SPEC [R-16]: a sphere's centre is the projection of the arc
                            // centre onto the axis, its radius the distance to the arc's
                            // (IR) start; the angles are re-measured from that centre.
                            let ps = circle_point(c, radius, a0);
                            let pe = circle_point(c, radius, a0 + sw);
                            let cp = Point2::new(0.0, c.y);
                            let ir_start = if lp.curves[k].reversed { pe } else { ps };
                            let (vs, ve) = (ps - cp, pe - cp);
                            let a0p = math::atan2(vs.y, vs.x);
                            let turn = math::atan2(vs.perp_dot(ve), vs.dot(ve));
                            let swp = sw + wrap_pi(turn - sw);
                            PKind::Arc {
                                c: cp,
                                r: ir_start.distance(cp),
                                a0: a0p,
                                sw: swp,
                            }
                        } else {
                            PKind::Arc {
                                c,
                                r: radius,
                                a0,
                                sw,
                            }
                        }
                    }
                    LoopCurveGeom::Circle {
                        center,
                        radius,
                        ccw,
                    } => PKind::Circle {
                        c: self.point(center),
                        r: radius,
                        ccw: ccw == (self.orientation() > 0.0),
                    },
                },
            })
            .collect();
        PLoop { curves, junctions }
    }
}

/// Wrap an angle into `(−π, π]`.
fn wrap_pi(a: f64) -> f64 {
    let w = math::wrap_angle(a, -math::PI);
    if w <= -math::PI { w + math::TAU } else { w }
}

// ---- side surfaces ------------------------------------------------------------------------

/// How a side surface's `(u, v)` relates to `(φ, profile point)`.
#[derive(Clone, Copy, Debug)]
enum Param {
    /// Cylinder: `u = φ`, `v = h`.
    Cylinder,
    /// Plane through the axis frame at height `h`: `(ρ cos φ, ρ sin φ)`.
    Plane,
    /// Cone: `u = ±φ`, `v = ±(h − h_ref)` (`flip`: frame axis is `−D`).
    Cone { flip: bool, h_ref: f64 },
    /// Sphere / torus: `u = φ`, `v = ψ` (angle about the arc centre), or `π − ψ` on the
    /// inner sheet of a spindle torus (`lemon`).
    Round { lemon: bool },
}

struct Side {
    surface: Surface,
    param: Param,
    /// Largest distance of the curve's end points from the surface caused by snapping a
    /// nearly parallel/perpendicular line to a cylinder/plane.
    dev: f64,
}

impl Param {
    fn u_of(&self, phi: f64) -> f64 {
        match self {
            Param::Cone { flip: true, .. } => -phi,
            _ => phi,
        }
    }
    fn v_of_h(&self, h: f64) -> f64 {
        match *self {
            Param::Cone { flip, h_ref } => {
                if flip {
                    h_ref - h
                } else {
                    h - h_ref
                }
            }
            _ => h,
        }
    }
    fn v_of_psi(&self, psi: f64) -> f64 {
        match self {
            Param::Round { lemon: true } => math::PI - psi,
            _ => psi,
        }
    }
}

// ---- the operation -----------------------------------------------------------------------

/// Revolve `region` (sketch coordinates of `frame`) about `axis` by `angle` degrees in
/// `direction` into one solid body of feature `feature`.
///
/// Errors: `REVOLVE_CROSSES_AXIS` (see [`check_revolve_profile`]), `INVALID_PARAMETER`
/// for an angle outside `(0, 360]` or a zero axis direction, `FORGE_INVALID_CURVE_ID`,
/// `INVALID_RESULT`/`FORGE_INTERNAL` if the result fails Forge's own checks.
pub fn revolve(
    region: &Region,
    frame: &Frame,
    axis: &SketchAxis,
    angle: f64,
    direction: SweepDirection,
    feature: &str,
) -> Result<Body, OpError> {
    let tol = Tolerance::IR_DEFAULT;
    if !(angle.is_finite() && angle > 0.0 && angle <= 360.0) {
        return Err(OpError::InvalidParameter {
            what: "revolve angle",
            value: angle,
            expected: "in (0, 360] degrees",
        });
    }
    check_curve_ids(
        region
            .loops()
            .flat_map(|l| l.curves.iter().map(|c| c.id.as_str())),
    )?;
    let side = check_revolve_profile(region, axis, tol.linear)?;
    let sigma = match side {
        AxisSide::Left => 1.0,
        AxisSide::Right => -1.0,
    };
    let o2 = Point2::from(axis.origin);
    let dh = Vec2::from(axis.direction)
        .normalize()
        .ok_or_else(|| OpError::Internal("axis direction vanished".into()))?;
    let map = ProfileMap {
        o: o2,
        dh,
        sigma,
        tol: tol.linear,
    };

    // Revolve frame.
    let a3 = frame.to_world_point(Vec3::new(o2.x, o2.y, 0.0));
    let d3 = frame
        .to_world_vector(Vec3::new(dh.x, dh.y, 0.0))
        .normalize()
        .ok_or_else(|| OpError::Internal("axis direction vanished in 3D".into()))?;
    let r0 = frame.to_world_vector(Vec3::new(-dh.y, dh.x, 0.0)) * sigma;
    let phi0 = match direction {
        SweepDirection::Normal => 0.0,
        SweepDirection::Reverse => -angle,
        SweepDirection::Symmetric => -0.5 * angle,
    };
    let (s0, c0) = math::sin_cos_deg(phi0);
    let xf = r0 * c0 + d3.cross(r0) * s0;
    let ff = Frame::from_normal_x(a3, d3, xf)
        .ok_or_else(|| OpError::Internal("degenerate revolve frame".into()))?;
    let d = ff.z();
    let full = angle >= 360.0;
    let theta = math::deg_to_rad(angle);
    let (st, ct) = math::sin_cos_deg(angle);
    let dirs = [ff.x(), ff.x() * ct + ff.y() * st];
    let phis = [0.0, theta];
    let cs = [(1.0, 0.0), (ct, st)];
    let p3 = |q: Point2, w: usize| -> Point3 { a3 + d * q.y + dirs[w] * q.x };
    let on_axis_point = |h: f64| -> Point3 { a3 + d * h };

    let profile: Vec<PLoop> = region.loops().map(|l| map.profile_loop(l)).collect();

    let mut plan = Plan::new(feature, tol);
    let mut start_cap: Vec<Vec<PUse>> = Vec::new();
    let mut end_cap: Vec<Vec<PUse>> = Vec::new();
    let mut side_faces: Vec<(Surface, bool, Provenance, Vec<Vec<PUse>>)> = Vec::new();

    for pl in &profile {
        let n = pl.curves.len();
        // Classify the curves first: ring tolerances depend on both neighbours.
        let sides: Vec<Option<Side>> = pl
            .curves
            .iter()
            .enumerate()
            .map(|(k, c)| classify(c, &pl.junctions, k, &ff, tol.linear))
            .collect::<Result<_, _>>()?;
        let dev = |k: usize| sides[k].as_ref().map_or(0.0, |s| s.dev);

        // Junction vertices and swept junction edges.
        let mut v_at: Vec<[Option<VIdx>; 2]> = vec![[None, None]; pl.junctions.len()];
        let mut sweep_edge: Vec<Option<EIdx>> = vec![None; pl.junctions.len()];
        for (j, pj) in pl.junctions.iter().enumerate() {
            if pj.on_axis {
                if !full {
                    let v = plan.vertex(on_axis_point(pj.p.y), pj.tol, format!("{}@axis", pj.key));
                    v_at[j] = [Some(v), Some(v)];
                }
                continue;
            }
            let etol = pj.tol.max(dev(j)).max(dev((j + n - 1) % n));
            let circ = Circle3::new(ff.with_origin(on_axis_point(pj.p.y)), pj.p.x)?;
            if full {
                sweep_edge[j] = Some(plan.ring(circ, (0.0, math::TAU), etol, pj.key.clone()));
            } else {
                let v0 = plan.vertex(p3(pj.p, 0), pj.tol, format!("{}@0", pj.key));
                let v1 = plan.vertex(p3(pj.p, 1), pj.tol, format!("{}@1", pj.key));
                v_at[j] = [Some(v0), Some(v1)];
                sweep_edge[j] = Some(plan.edge(circ, (0.0, theta), v0, v1, etol, pj.key.clone()));
            }
        }

        let mut start_uses: Vec<PUse> = Vec::new();
        let mut end_uses: Vec<PUse> = Vec::new();
        for (k, c) in pl.curves.iter().enumerate() {
            let kn = (k + 1) % n.max(1);
            let side = &sides[k];
            // Profile copies at φ = 0 and φ = Θ (or the shared on-axis edge).
            let mut copies: [Option<(EIdx, bool)>; 2] = [None, None];
            if !full {
                match (c.kind, side) {
                    (PKind::Line { a, b }, None) => {
                        // On the axis: one edge shared by both end caps.
                        let (pa, pb) = (on_axis_point(a.y), on_axis_point(b.y));
                        let va =
                            v_at[k][0].ok_or_else(|| OpError::Internal("axis vertex".into()))?;
                        let vb =
                            v_at[kn][0].ok_or_else(|| OpError::Internal("axis vertex".into()))?;
                        let e = plan.edge(
                            Line3::through(pa, pb)?,
                            (0.0, pa.distance(pb)),
                            va,
                            vb,
                            tol.linear,
                            c.id.clone(),
                        );
                        copies = [Some((e, true)), Some((e, true))];
                    }
                    (PKind::Line { a, b }, Some(_)) => {
                        for w in 0..2 {
                            let (pa, pb) = (p3(a, w), p3(b, w));
                            let va =
                                v_at[k][w].ok_or_else(|| OpError::Internal("vertex".into()))?;
                            let vb =
                                v_at[kn][w].ok_or_else(|| OpError::Internal("vertex".into()))?;
                            let e = plan.edge(
                                Line3::through(pa, pb)?,
                                (0.0, pa.distance(pb)),
                                va,
                                vb,
                                tol.linear.max(dev(k)),
                                format!("{}@{w}", c.id),
                            );
                            copies[w] = Some((e, true));
                        }
                    }
                    (PKind::Arc { c: ctr, r, a0, sw }, _) => {
                        let range = if sw > 0.0 {
                            (a0, a0 + sw)
                        } else {
                            (a0 + sw, a0)
                        };
                        for w in 0..2 {
                            let va =
                                v_at[k][w].ok_or_else(|| OpError::Internal("vertex".into()))?;
                            let vb =
                                v_at[kn][w].ok_or_else(|| OpError::Internal("vertex".into()))?;
                            let (vs, ve) = if sw > 0.0 { (va, vb) } else { (vb, va) };
                            let e = plan.edge(
                                Circle3::new(meridian_frame(&p3, &dirs, d, ctr, w)?, r)?,
                                range,
                                vs,
                                ve,
                                tol.linear,
                                format!("{}@{w}", c.id),
                            );
                            copies[w] = Some((e, sw > 0.0));
                        }
                    }
                    (PKind::Circle { c: ctr, r, ccw }, _) => {
                        for (w, slot) in copies.iter_mut().enumerate() {
                            let e = plan.ring(
                                Circle3::new(meridian_frame(&p3, &dirs, d, ctr, w)?, r)?,
                                (0.0, math::TAU),
                                tol.linear,
                                format!("{}@{w}", c.id),
                            );
                            *slot = Some((e, ccw));
                        }
                    }
                }
                let cap_pc: Curve2 = match c.kind {
                    PKind::Line { a, b } => Line2::through(a, b)?.into(),
                    PKind::Arc { c: ctr, r, .. } | PKind::Circle { c: ctr, r, .. } => {
                        Circle2::new(ctr, r)?.into()
                    }
                };
                let (e0, f0) = copies[0].expect("start copy");
                let (e1, f1) = copies[1].expect("end copy");
                start_uses.push(PUse {
                    edge: e0,
                    forward: f0,
                    pcurve: cap_pc.clone(),
                });
                end_uses.push(PUse {
                    edge: e1,
                    forward: !f1,
                    pcurve: cap_pc,
                });
            }

            let Some(side) = side else { continue };
            let loops = side_loops(
                c,
                side,
                &pl.junctions,
                k,
                kn,
                &sweep_edge,
                &copies,
                full,
                &phis,
                &cs,
            )?;
            let sense = side_sense(c, side, &ff, full, theta)?;
            side_faces.push((
                side.surface.clone(),
                sense,
                Provenance::side(feature, c.id.as_str()),
                loops,
            ));
        }
        if !full {
            end_uses.reverse();
            start_cap.push(start_uses);
            end_cap.push(end_uses);
        }
    }

    if !full {
        let fs = Frame::from_normal_x(a3, dirs[0].cross(d), dirs[0])
            .ok_or_else(|| OpError::Internal("degenerate start cap frame".into()))?;
        let fe = Frame::from_normal_x(a3, dirs[1].cross(d), dirs[1])
            .ok_or_else(|| OpError::Internal("degenerate end cap frame".into()))?;
        plan.face(
            Plane::new(fs),
            true,
            Provenance::end_cap_start(feature),
            start_cap,
        );
        plan.face(
            Plane::new(fe),
            false,
            Provenance::end_cap_end(feature),
            end_cap,
        );
    }
    for (surface, sense, prov, loops) in side_faces {
        plan.face(surface, sense, prov, loops);
    }
    plan.build()
}

/// Frame of the meridian plane at sweep position `w` (0 = start, 1 = end) centred at the
/// profile point `ctr`: `x` radial, `y = D`, so the circle parameter is the profile angle.
fn meridian_frame(
    p3: &impl Fn(Point2, usize) -> Point3,
    dirs: &[Vec3; 2],
    d: Vec3,
    ctr: Point2,
    w: usize,
) -> Result<Frame, OpError> {
    Frame::from_normal_x(p3(ctr, w), dirs[w].cross(d), dirs[w])
        .ok_or_else(|| OpError::Internal("degenerate meridian frame".into()))
}

/// Classify a profile curve and build its side surface (`None` for a line on the axis).
fn classify(
    c: &PCurve,
    js: &[PJunction],
    k: usize,
    ff: &Frame,
    tol: f64,
) -> Result<Option<Side>, OpError> {
    let at_h = |h: f64| ff.with_origin(ff.origin() + ff.z() * h);
    match c.kind {
        PKind::Line { a, b } => {
            let n = js.len();
            if js[k].on_axis && js[(k + 1) % n].on_axis {
                return Ok(None);
            }
            let (dr, dhh) = (b.x - a.x, b.y - a.y);
            let len = a.distance(b);
            if dr.abs() <= ANGULAR_TOLERANCE * len {
                let rho = 0.5 * (a.x + b.x);
                return Ok(Some(Side {
                    surface: Cylinder::new(*ff, rho)?.into(),
                    param: Param::Cylinder,
                    dev: 0.5 * dr.abs(),
                }));
            }
            if dhh.abs() <= ANGULAR_TOLERANCE * len {
                let h = 0.5 * (a.y + b.y);
                return Ok(Some(Side {
                    surface: Plane::new(at_h(h)).into(),
                    param: Param::Plane,
                    dev: 0.5 * dhh.abs(),
                }));
            }
            let (rref, href) = if a.x >= b.x { (a.x, a.y) } else { (b.x, b.y) };
            let alpha = math::atan2(dr.abs(), dhh.abs());
            let widening_up = dr * dhh > 0.0;
            let frame = if widening_up {
                at_h(href)
            } else {
                Frame::from_normal_x(ff.origin() + ff.z() * href, -ff.z(), ff.x())
                    .ok_or_else(|| OpError::Internal("degenerate cone frame".into()))?
            };
            Ok(Some(Side {
                surface: Cone::new(frame, rref, alpha)?.into(),
                param: Param::Cone {
                    flip: !widening_up,
                    h_ref: href,
                },
                dev: 0.0,
            }))
        }
        PKind::Arc { c: ctr, r, .. } | PKind::Circle { c: ctr, r, .. } => {
            let frame = at_h(ctr.y);
            let is_arc = matches!(c.kind, PKind::Arc { .. });
            if is_arc && ctr.x == 0.0 {
                return Ok(Some(Side {
                    surface: Sphere::new(frame, r)?.into(),
                    param: Param::Round { lemon: false },
                    dev: 0.0,
                }));
            }
            if ctr.x > 0.0 && r <= ctr.x + tol {
                return Ok(Some(Side {
                    surface: Torus::new(frame, ctr.x, r.min(ctr.x))?.into(),
                    param: Param::Round { lemon: false },
                    dev: 0.0,
                }));
            }
            if !is_arc {
                return Err(OpError::Internal(format!(
                    "circle {:?} crosses the revolve axis",
                    c.id
                )));
            }
            if ctr.x > 0.0 {
                // The carrier circle crosses the axis; the arc is on the outer sheet.
                return Ok(Some(Side {
                    surface: Torus::spindle(frame, ctr.x, r, SpindlePatch::Outer)?.into(),
                    param: Param::Round { lemon: false },
                    dev: 0.0,
                }));
            }
            // Centre on the far side of the axis: the arc is on the inner sheet of the
            // spindle torus whose tube centres are at radius |ρc| (frame x reversed).
            if r <= -ctr.x + tol {
                return Err(OpError::Internal(format!(
                    "arc {:?} lies within the tolerance band of the axis",
                    c.id
                )));
            }
            let lf = Frame::from_normal_x(frame.origin(), ff.z(), -ff.x())
                .ok_or_else(|| OpError::Internal("degenerate torus frame".into()))?;
            Ok(Some(Side {
                surface: Torus::spindle(lf, -ctr.x, r, SpindlePatch::Inner)?.into(),
                param: Param::Round { lemon: true },
                dev: 0.0,
            }))
        }
    }
}

/// The profile angle (about the arc centre) at junction `j` of curve `k`.
fn psi_at(kind: PKind, at_start: bool) -> f64 {
    match kind {
        PKind::Arc { a0, sw, .. } => {
            if at_start {
                a0
            } else {
                a0 + sw
            }
        }
        _ => 0.0,
    }
}

/// Pcurve on the side face of the swept junction edge (parameter `φ`).
fn sweep_pcurve(
    side: &Side,
    kind: PKind,
    pj: &PJunction,
    at_start: bool,
) -> Result<Curve2, OpError> {
    Ok(match side.param {
        Param::Cylinder => Line2::new(Vec2::new(0.0, pj.p.y), Vec2::unit_x())?.into(),
        Param::Plane => Circle2::new(Vec2::zero(), pj.p.x)?.into(),
        Param::Cone { flip, .. } => Line2::new(
            Vec2::new(0.0, side.param.v_of_h(pj.p.y)),
            Vec2::new(if flip { -1.0 } else { 1.0 }, 0.0),
        )?
        .into(),
        Param::Round { .. } => Line2::new(
            Vec2::new(0.0, side.param.v_of_psi(psi_at(kind, at_start))),
            Vec2::unit_x(),
        )?
        .into(),
    })
}

/// Pcurve on the side face of the profile copy at `φ` (same parameter as its edge).
fn copy_pcurve(side: &Side, kind: PKind, phi: f64, cs: (f64, f64)) -> Result<Curve2, OpError> {
    Ok(match (side.param, kind) {
        (Param::Cylinder, PKind::Line { a, b }) => Line2::new(
            Vec2::new(phi, a.y),
            Vec2::new(0.0, if b.y > a.y { 1.0 } else { -1.0 }),
        )?
        .into(),
        (Param::Plane, PKind::Line { a, b }) => {
            let s = if b.x > a.x { 1.0 } else { -1.0 };
            Line2::new(
                Vec2::new(a.x * cs.0, a.x * cs.1),
                Vec2::new(s * cs.0, s * cs.1),
            )?
            .into()
        }
        (Param::Cone { .. }, PKind::Line { a, b }) => {
            let len = a.distance(b);
            let u = side.param.u_of(phi);
            NurbsCurve2::new(
                1,
                vec![0.0, 0.0, len, len],
                vec![[u, side.param.v_of_h(a.y)], [u, side.param.v_of_h(b.y)]],
                None,
            )
            .map_err(forge_core::geom::GeomError::from)?
            .into()
        }
        (Param::Round { lemon }, PKind::Arc { .. } | PKind::Circle { .. }) => {
            if lemon {
                Line2::new(Vec2::new(phi, math::PI), -Vec2::unit_y())?.into()
            } else {
                Line2::new(Vec2::new(phi, 0.0), Vec2::unit_y())?.into()
            }
        }
        _ => {
            return Err(OpError::Internal(
                "profile curve kind does not match its side surface".into(),
            ));
        }
    })
}

#[allow(clippy::too_many_arguments)]
fn side_loops(
    c: &PCurve,
    side: &Side,
    js: &[PJunction],
    k: usize,
    kn: usize,
    sweep_edge: &[Option<EIdx>],
    copies: &[Option<(EIdx, bool)>; 2],
    full: bool,
    phis: &[f64; 2],
    cs: &[(f64, f64); 2],
) -> Result<Vec<Vec<PUse>>, OpError> {
    if let PKind::Circle { ccw, .. } = c.kind {
        if full {
            return Ok(Vec::new());
        }
        let (e0, _) = copies[0].expect("copy");
        let (e1, _) = copies[1].expect("copy");
        return Ok(vec![
            vec![PUse {
                edge: e1,
                forward: ccw,
                pcurve: copy_pcurve(side, c.kind, phis[1], cs[1])?,
            }],
            vec![PUse {
                edge: e0,
                forward: !ccw,
                pcurve: copy_pcurve(side, c.kind, phis[0], cs[0])?,
            }],
        ]);
    }
    let sweep_use = |j: usize, forward: bool, at_start: bool| -> Result<Option<PUse>, OpError> {
        match sweep_edge[j] {
            Some(e) => Ok(Some(PUse {
                edge: e,
                forward,
                pcurve: sweep_pcurve(side, c.kind, &js[j], at_start)?,
            })),
            None => Ok(None),
        }
    };
    if full {
        let mut loops = Vec::new();
        let mut radii = Vec::new();
        if let Some(u) = sweep_use(k, true, true)? {
            loops.push(vec![u]);
            radii.push(js[k].p.x);
        }
        if let Some(u) = sweep_use(kn, false, false)? {
            loops.push(vec![u]);
            radii.push(js[kn].p.x);
        }
        // A planar annulus lists its outer ring first.
        if matches!(side.param, Param::Plane) && radii.len() == 2 && radii[1] > radii[0] {
            loops.swap(0, 1);
        }
        return Ok(loops);
    }
    let (e0, f0) = copies[0].expect("copy");
    let (e1, f1) = copies[1].expect("copy");
    let mut lp = Vec::new();
    if let Some(u) = sweep_use(k, true, true)? {
        lp.push(u);
    }
    lp.push(PUse {
        edge: e1,
        forward: f1,
        pcurve: copy_pcurve(side, c.kind, phis[1], cs[1])?,
    });
    if let Some(u) = sweep_use(kn, false, false)? {
        lp.push(u);
    }
    lp.push(PUse {
        edge: e0,
        forward: !f0,
        pcurve: copy_pcurve(side, c.kind, phis[0], cs[0])?,
    });
    Ok(vec![lp])
}

/// Sense of a side face: its surface normal against the outward normal at the middle of
/// the profile curve and of the sweep.
fn side_sense(
    c: &PCurve,
    side: &Side,
    ff: &Frame,
    full: bool,
    theta: f64,
) -> Result<bool, OpError> {
    let phi = if full { math::PI } else { 0.5 * theta };
    let (sp, cp) = math::sin_cos(phi);
    let er = ff.x() * cp + ff.y() * sp;
    // Profile point, tangent (region on the left) and the profile angle at the middle.
    let (q, t, psi) = match c.kind {
        PKind::Line { a, b } => {
            let t = (b - a)
                .normalize()
                .ok_or_else(|| OpError::Internal("zero-length profile line".into()))?;
            (a.lerp(b, 0.5), t, 0.0)
        }
        PKind::Arc { c: ctr, r, a0, sw } => {
            let m = a0 + 0.5 * sw;
            let (s, co) = math::sin_cos(m);
            (circle_point(ctr, r, m), Vec2::new(-s, co) * sw.signum(), m)
        }
        PKind::Circle { c: ctr, r, ccw } => {
            // The point farthest from the axis (never singular).
            let t = if ccw { Vec2::unit_y() } else { -Vec2::unit_y() };
            (Point2::new(ctr.x + r, ctr.y), t, 0.0)
        }
    };
    let outward = er * t.y - ff.z() * t.x;
    let (u, v) = match side.param {
        Param::Cylinder => (phi, q.y),
        Param::Plane => (q.x * cp, q.x * sp),
        Param::Cone { .. } => (side.param.u_of(phi), side.param.v_of_h(q.y)),
        Param::Round { .. } => (phi, side.param.v_of_psi(psi)),
    };
    sense_at(&side.surface, u, v, outward)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn param_maps_are_consistent() {
        let p = Param::Cone {
            flip: true,
            h_ref: 2.0,
        };
        assert!((p.u_of(1.0) + 1.0).abs() == 0.0);
        assert!((p.v_of_h(5.0) + 3.0).abs() == 0.0);
        let l = Param::Round { lemon: true };
        assert!((l.v_of_psi(0.25) - (math::PI - 0.25)).abs() == 0.0);
    }
}
