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
//! - Below 360° there are two planar end caps whose loops are the profile loops:
//!   `endcap:start` where the sweep of SPEC §4.3 starts and `endcap:end` where it ends,
//!   the same convention as extrude's caps — `normal`: the profile plane and `+Θ`;
//!   `reverse`: the profile plane and `−Θ`; `symmetric`: `−Θ/2` and `+Θ/2`. (In the
//!   revolve frame, which always runs from its start plane to `+Θ`, a `reverse` sweep's
//!   start is the frame's `φ = Θ` plane.)
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
/// they lie on the curve. A point within `tol` of the axis is on it (up to the rounding of
/// its coordinates, [`round_slack`]); beyond that its side is the exact sign of
/// [`orient2d`] against the axis line.
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
    // Signed distances of carrier-circle points farthest from the axis: `dc ± r` for the
    // centre's signed distance `dc`, the arithmetic of the side surfaces' carrier gap
    // (`ρc − r`), so a point exactly `tol` from the axis is on it here as it is there (the
    // point `circle_point(c, r, t)` rounds differently, review finding).
    let mut extremes: Vec<(f64, f64)> = Vec::new();
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
                let dc = dh.perp_dot(center - o);
                let slack = round_slack((center - o).norm() + radius);
                for s in [1.0, -1.0] {
                    let t = math::atan2(s * nrm.y, s * nrm.x);
                    if contains_angle(t0, sw, false, t, 0.0) {
                        extremes.push((dc + s * radius, slack));
                    }
                }
            }
            LoopCurveGeom::Circle { center, radius, .. } => {
                let dc = dh.perp_dot(center - o);
                let slack = round_slack((center - o).norm() + radius);
                extremes.extend([(dc + radius, slack), (dc - radius, slack)]);
            }
        }
    }
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut left, mut right) = (false, false);
    for p in pts {
        let d = dh.perp_dot(p - o);
        lo = lo.min(d);
        hi = hi.max(d);
        if d.abs() > tol + round_slack((p - o).norm()) {
            if orient2d(o, o2, p) > 0.0 {
                left = true;
            } else {
                right = true;
            }
        }
    }
    // Beyond the tolerance band the sign of the distance is exact enough.
    for (d, slack) in extremes {
        lo = lo.min(d);
        hi = hi.max(d);
        if d.abs() > tol + slack {
            if d > 0.0 {
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

/// Rounding slack of a "within `tol` of the axis" test on sketch quantities of magnitude
/// `scale` (mm): the inclusive boundary `|ρ| ≤ tol` of [R-3] up to the rounding of the
/// sketch's own arithmetic. An IR rounded-rectangle corner measures its radius across a
/// subtraction (`y1 − (y1 − r)`, off by up to half an ulp of `y1`), so a corner whose side
/// lies exactly `tol` from the axis had a carrier crossing it by `tol + 7e-16` mm and failed
/// `REVOLVE_CROSSES_AXIS` (review finding). 32 ulps of the scale: `1e-13` mm at 15 mm.
fn round_slack(scale: f64) -> f64 {
    32.0 * f64::EPSILON * scale
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
    /// [`round_slack`] of the curve's sketch quantities (arcs and circles: centre and radius).
    slack: f64,
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
                let on_axis = p.x.abs() <= self.tol + round_slack((j.point - self.o).norm());
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
                slack: match c.geom {
                    LoopCurveGeom::Line { .. } => 0.0,
                    LoopCurveGeom::Arc { center, radius, .. }
                    | LoopCurveGeom::Circle { center, radius, .. } => {
                        round_slack((center - self.o).norm() + radius)
                    }
                },
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
            let etol = dev_tolerance(pj.tol, dev(j).max(dev((j + n - 1) % n)));
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
                                dev_tolerance(tol.linear, dev(k)),
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
                            // On a snapped (horn) torus the copy lies `dev` from the
                            // face, as a snapped line's copy does (review finding).
                            let e = plan.edge(
                                Circle3::new(meridian_frame(&p3, &dirs, d, ctr, w)?, r)?,
                                range,
                                vs,
                                ve,
                                dev_tolerance(tol.linear, dev(k)),
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
                                dev_tolerance(tol.linear, dev(k)),
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
        // Names follow the sweep, as for extrude's caps: a `reverse` sweep starts on the
        // profile plane (the frame's φ = Θ plane) and ends at −Θ (the frame's φ = 0).
        let (at_frame_start, at_frame_end) = match direction {
            SweepDirection::Reverse => (
                Provenance::end_cap_end(feature),
                Provenance::end_cap_start(feature),
            ),
            SweepDirection::Normal | SweepDirection::Symmetric => (
                Provenance::end_cap_start(feature),
                Provenance::end_cap_end(feature),
            ),
        };
        plan.face(Plane::new(fs), true, at_frame_start, start_cap);
        plan.face(Plane::new(fe), false, at_frame_end, end_cap);
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
            if ctr.x > 0.0 && r <= ctr.x + tol + c.slack {
                let minor = torus_minor(c.kind, js, k, ctr.x, r, tol + c.slack);
                return Ok(Some(Side {
                    surface: Torus::new(frame, ctr.x, minor)?.into(),
                    param: Param::Round { lemon: false },
                    dev: (r - minor).abs(),
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

/// The minor radius of the torus of an arc or circle whose carrier does not cross the axis
/// by more than `tol` (`r ≤ ρc + tol`, `ρc > 0` the centre's distance from the axis).
///
/// - A carrier crossing the axis by at most `tol` touches it ([R-3]): a **horn** torus,
///   minor = major = `ρc` (as before).
/// - [R-16] (an arc end on the axis): an arc with an end junction on the axis (snapped there,
///   `ρ ≤ tol`) lies on a carrier at most `tol` from the axis (`ρc − r ≤ ρ_end ≤ tol`, up to
///   rounding), and that end sweeps to a singular point with no edge ([R-8, R-9]). The surface
///   must then be singular there too: a horn torus, minor = major = `ρc`, decided from the
///   junction (with the rounding of `ρc` and `r` allowed on the gap). The ring torus of the raw radius (`r` a few ulps under `ρc`, as for a
///   rounded-rectangle corner whose radius is measured across a subtraction) has a
///   non-singular inner equator at `ρc − r ≈ 1e-15` mm, so the full revolve's side face had
///   one bounding edge and no singular line to close its domain (`FORGE_UNBOUNDED_DOMAIN`, v1
///   seed 47 #675/#975). Comparing `r ≥ ρc − tol` instead (review finding) failed at the
///   inclusive boundary: the junction's `|ρ| ≤ tol` and the carrier gap `(x0 + r) − r` round
///   differently, so an end exactly `tol` from the axis was snapped onto it while its carrier
///   stayed a ring torus. The other end moves by `|r − ρc|` (the face's `dev`, at most `tol`
///   plus rounding), like the sphere of [R-16]; every edge on the face carries it
///   ([`dev_tolerance`]).
/// - Otherwise the raw radius: a ring torus (or a horn torus when `r = ρc` exactly).
fn torus_minor(kind: PKind, js: &[PJunction], k: usize, rho_c: f64, r: f64, tol: f64) -> f64 {
    let n = js.len();
    let end_on_axis =
        matches!(kind, PKind::Arc { .. }) && n > 0 && (js[k].on_axis || js[(k + 1) % n].on_axis);
    // An end within `tol` of the axis bounds the carrier gap by `tol` (the caller's `tol`
    // includes the rounding slack of `ρc` and `r`); a gap beyond that is an arc whose end is
    // off its carrier: not snapped, so the body fails validation instead of moving the arc
    // by more than `tol`.
    let touches = end_on_axis && rho_c - r <= tol;
    if r >= rho_c || touches { rho_c } else { r }
}

/// Rounding slack added to a snapped side surface's deviation (mm): the validator measures
/// the distance of an edge `dev` from the surface through projections that round at the
/// coordinates' scale (`1.4e-16` mm over `dev = 1e-6` for a 0.3 mm corner, review finding).
const DEV_SLACK: f64 = 1e-12;

/// Tolerance of an edge on side surfaces that deviate from the profile by `dev` (the snapped
/// cylinder, plane or horn torus of [R-16]): `tol` when nothing was snapped, else enough to
/// cover the deviation as measured.
fn dev_tolerance(tol: f64, dev: f64) -> f64 {
    if dev > 0.0 {
        tol.max(dev + DEV_SLACK)
    } else {
        tol
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

    fn junction(x: f64) -> PJunction {
        PJunction {
            p: Point2::new(x, 0.0),
            on_axis: x == 0.0,
            tol: 1e-6,
            key: String::new(),
        }
    }

    #[test]
    fn torus_minor_is_horn_exactly_when_the_carrier_touches_the_axis() {
        let arc = PKind::Arc {
            c: Point2::new(2.0, 0.0),
            r: 2.0,
            a0: 0.0,
            sw: 1.0,
        };
        let circle = PKind::Circle {
            c: Point2::new(2.0, 0.0),
            r: 2.0,
            ccw: true,
        };
        let below = 2.0 - 4.0 * f64::EPSILON;
        let on = [junction(3.0), junction(0.0)];
        let on_rev = [junction(0.0), junction(3.0)];
        let off = [junction(3.0), junction(1.0)];
        let minor =
            |k: PKind, js: &[PJunction], r: f64| torus_minor(k, js, 0, 2.0, r, 1e-6).to_bits();
        let horn = 2.0f64.to_bits();
        // Crossing by at most tol, or exactly tangent: horn.
        assert_eq!(minor(arc, &off, 2.0 + 5e-7), horn);
        assert_eq!(minor(arc, &off, 2.0), horn);
        // An arc end snapped onto the axis: horn, from either end, for a radius up to tol under.
        assert_eq!(minor(arc, &on, below), horn);
        assert_eq!(minor(arc, &on_rev, below), horn);
        assert_eq!(minor(arc, &on, 2.0 - 9e-7), horn);
        // The inclusive boundary: a gap of exactly tol, and tol plus the rounding of ρc − r.
        assert_eq!(minor(arc, &on, 2.0 - 1e-6), horn);
        let past = f64::from_bits((2.0f64 - 1e-6).to_bits() - 4);
        assert_eq!(minor(arc, &on, past), past.to_bits());
        let slack =
            |k: PKind, js: &[PJunction], r: f64| torus_minor(k, js, 0, 2.0, r, 1e-6 + 1e-13);
        assert_eq!(slack(arc, &on, past).to_bits(), horn);
        // A gap beyond that is an arc whose end is off its carrier: never snapped.
        assert_eq!(minor(arc, &on, 2.0 - 1.1e-6), (2.0f64 - 1.1e-6).to_bits());
        // No end on the axis, or a full circle: the raw radius (a ring torus).
        assert_eq!(minor(arc, &off, below), below.to_bits());
        assert_eq!(minor(circle, &[], below), below.to_bits());
        assert_eq!(minor(arc, &on, 1.5), 1.5f64.to_bits());
    }
}
