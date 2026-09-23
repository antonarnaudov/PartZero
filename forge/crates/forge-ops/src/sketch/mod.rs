//! Planar sketch regions (SPEC §3): loop assembly, the staged sketch checks, nesting and
//! canonical regions.
//!
//! # Pipeline ([R-2]: the first failing stage decides the error)
//! 1. **Endpoints**: every line/arc end must coincide (distance ≤ `tol`, [R-3]) with
//!    exactly one end of another curve, scanned in curve order, `start` before `end`.
//! 2. **Loop assembly**: the partner relation is an involution, so walking it from the
//!    lowest unused curve closes a loop; each circle is its own loop.
//! 3. **Crossings** over curve pairs `(i, j)`, `i < j`, in lexicographic order (see
//!    [`prim`] for the closed-form contact computation). A contact farther than `2·tol`
//!    from every endpoint the pair shares, or an overlap longer than `tol`, fails.
//! 4. **Degenerate loops**: enclosed area ≤ `tol²`.
//! 5. **Nesting**: a loop's depth is the number of other loops whose winding number
//!    around a test point on it (the midpoint of its lowest-index curve) is non-zero.
//!    After stage 3 the loops are separated by more than `tol`, so the winding number is
//!    decided robustly: line pieces use the exact [`orient2d`](forge_core::orient2d)
//!    (Sunday's crossing rule), arc pieces are split into y-monotone parts and compared
//!    in closed form.
//! 6. **Regions**: an even-depth loop (outer, oriented counter-clockwise) plus the loops
//!    one level deeper directly inside it (holes, clockwise), sorted by `outer_curves`.
//!
//! # Vertices
//! Where two curve ends coincide the loop has a **junction**; its point is the midpoint
//! of the two given end points and its tolerance covers the distance to both curves'
//! geometric ends (an arc's geometric end is on its carrier circle, [R-6]).

pub mod prim;
mod winding;

use forge_core::linalg::Point2;
use forge_core::{Tolerance, math};
use forge_ir::{SketchCurve, SketchFeature};

pub use prim::ArcGeom;
use prim::{Prim, contacts};

use crate::error::{CurveEnd, OpError};

/// Oriented geometry of one curve of a loop, in the loop's traversal direction.
#[derive(Clone, Debug, PartialEq)]
pub enum LoopCurveGeom {
    /// A straight segment between the loop's junction points.
    Line {
        /// Start (junction point).
        start: Point2,
        /// End (junction point).
        end: Point2,
    },
    /// A circular arc from `start_angle` sweeping `sweep` radians (positive =
    /// counter-clockwise), `0 < |sweep| < 2π`.
    Arc {
        /// Centre.
        center: Point2,
        /// Radius.
        radius: f64,
        /// Angle where the traversal starts.
        start_angle: f64,
        /// Signed sweep in the traversal direction.
        sweep: f64,
    },
    /// A full circle, traversed counter-clockwise (`ccw`) or clockwise.
    Circle {
        /// Centre.
        center: Point2,
        /// Radius.
        radius: f64,
        /// Traversal direction.
        ccw: bool,
    },
}

/// One curve of a loop.
#[derive(Clone, Debug, PartialEq)]
pub struct LoopCurve {
    /// The sketch curve id.
    pub id: String,
    /// Index of the curve in the sketch.
    pub sketch_index: usize,
    /// Geometry in traversal order.
    pub geom: LoopCurveGeom,
    /// `true` if the loop runs the IR curve from its `end` to its `start`.
    pub reversed: bool,
}

/// A point where two consecutive curves of a loop meet.
#[derive(Clone, Debug, PartialEq)]
pub struct Junction {
    /// Vertex position: the midpoint of the two coincident curve ends.
    pub point: Point2,
    /// Vertex tolerance: at least the linear tolerance, and at least twice the distance
    /// from `point` to either curve's geometric end.
    pub tolerance: f64,
    /// Stable identity, e.g. `"a:end|b:start"` (sorted), used to order entities that
    /// would otherwise get the same provenance name.
    pub key: String,
}

/// A closed loop of sketch curves.
#[derive(Clone, Debug, PartialEq)]
pub struct Loop {
    /// Curves in traversal order.
    pub curves: Vec<LoopCurve>,
    /// `junctions[k]` is where `curves[k]` starts (and `curves[k − 1]` ends). Empty for a
    /// circle loop.
    pub junctions: Vec<Junction>,
    /// Signed enclosed area (positive = counter-clockwise), exact: shoelace over the
    /// junction points plus a circular-segment term `½r²(θ − sin θ)` per arc.
    pub signed_area: f64,
}

impl Loop {
    /// Curve ids, sorted.
    pub fn sorted_ids(&self) -> Vec<String> {
        let mut v: Vec<String> = self.curves.iter().map(|c| c.id.clone()).collect();
        v.sort();
        v
    }
    /// Start and end point of curve `k` in traversal order (junction points; for a circle
    /// the point at angle 0).
    pub fn curve_ends(&self, k: usize) -> (Point2, Point2) {
        let n = self.curves.len();
        match &self.curves[k].geom {
            LoopCurveGeom::Circle { center, radius, .. } => {
                let p = Point2::new(center.x + radius, center.y);
                (p, p)
            }
            _ => (self.junctions[k].point, self.junctions[(k + 1) % n].point),
        }
    }
    /// The same loop traversed the other way.
    pub fn reversed(&self) -> Loop {
        let n = self.curves.len();
        let curves = self
            .curves
            .iter()
            .rev()
            .map(|c| LoopCurve {
                id: c.id.clone(),
                sketch_index: c.sketch_index,
                geom: match &c.geom {
                    LoopCurveGeom::Line { start, end } => LoopCurveGeom::Line {
                        start: *end,
                        end: *start,
                    },
                    LoopCurveGeom::Arc {
                        center,
                        radius,
                        start_angle,
                        sweep,
                    } => LoopCurveGeom::Arc {
                        center: *center,
                        radius: *radius,
                        start_angle: start_angle + sweep,
                        sweep: -sweep,
                    },
                    LoopCurveGeom::Circle {
                        center,
                        radius,
                        ccw,
                    } => LoopCurveGeom::Circle {
                        center: *center,
                        radius: *radius,
                        ccw: !ccw,
                    },
                },
                reversed: !c.reversed,
            })
            .collect();
        let junctions = if self.junctions.is_empty() {
            Vec::new()
        } else {
            (0..n)
                .map(|k| self.junctions[(n - k) % n].clone())
                .collect()
        };
        Loop {
            curves,
            junctions,
            signed_area: -self.signed_area,
        }
    }
    /// Rotate so the curve with the smallest sketch index comes first.
    fn canonical_start(mut self) -> Loop {
        let first = (0..self.curves.len())
            .min_by_key(|&k| self.curves[k].sketch_index)
            .unwrap_or(0);
        self.curves.rotate_left(first);
        if !self.junctions.is_empty() {
            self.junctions.rotate_left(first);
        }
        self
    }
    /// Winding number of the loop around `p` (which must not lie on the loop).
    pub fn winding_number(&self, p: Point2) -> i32 {
        winding::winding_number(self, p)
    }
}

/// A region: an outer loop (counter-clockwise) and its holes (clockwise), in sketch
/// coordinates.
#[derive(Clone, Debug, PartialEq)]
pub struct Region {
    /// Outer boundary, counter-clockwise.
    pub outer: Loop,
    /// Holes, clockwise, sorted by their sorted curve ids.
    pub holes: Vec<Loop>,
    /// Area: `|outer| − Σ|holes|` (mm²).
    pub area: f64,
    /// The region's name: the sorted ids of the outer loop's curves.
    pub outer_curves: Vec<String>,
}

impl Region {
    /// Number of boundary loops (1 + holes).
    pub fn loop_count(&self) -> usize {
        1 + self.holes.len()
    }
    /// All loops, outer first.
    pub fn loops(&self) -> impl Iterator<Item = &Loop> {
        std::iter::once(&self.outer).chain(self.holes.iter())
    }
}

// ---------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum Kind {
    Line {
        start: Point2,
        end: Point2,
    },
    Arc {
        start: Point2,
        end: Point2,
        geom: ArcGeom,
    },
    Circle {
        center: Point2,
        radius: f64,
    },
}

impl Kind {
    fn endpoint(&self, e: CurveEnd) -> Option<Point2> {
        match (*self, e) {
            (Kind::Line { start, .. } | Kind::Arc { start, .. }, CurveEnd::Start) => Some(start),
            (Kind::Line { end, .. } | Kind::Arc { end, .. }, CurveEnd::End) => Some(end),
            (Kind::Circle { .. }, _) => None,
        }
    }
    /// The geometric end of the curve at `e` (carrier-circle point for arcs).
    fn geometric_endpoint(&self, e: CurveEnd) -> Option<Point2> {
        match (*self, e) {
            (Kind::Arc { geom, .. }, CurveEnd::End) => Some(geom.geometric_end()),
            _ => self.endpoint(e),
        }
    }
    fn prim(&self) -> Prim {
        match *self {
            Kind::Line { start, end } => Prim::Seg { a: start, b: end },
            Kind::Arc { geom, .. } => geom.prim(),
            Kind::Circle { center, radius } => Prim::circle(center, radius),
        }
    }
    /// A point on the curve used to test nesting (oracle-compatible choice).
    fn test_point(&self) -> Point2 {
        match self.prim() {
            Prim::Seg { a, b } => a.lerp(b, 0.5),
            Prim::Arc {
                c, r, t0, sweep, ..
            } => prim::circle_point(c, r, t0 + 0.5 * sweep),
        }
    }
}

struct Curve<'a> {
    id: &'a str,
    kind: Kind,
}

type EndRef = (usize, CurveEnd);

/// The regions of a sketch in canonical order (SPEC §3), or the first sketch error.
///
/// `tol.linear` is the coincidence tolerance (`forge_ir::LINEAR_TOLERANCE` for IR v0).
pub fn regions(sketch: &SketchFeature, tol: &Tolerance) -> Result<Vec<Region>, OpError> {
    let t = tol.linear;
    let curves: Vec<Curve<'_>> = sketch
        .curves
        .iter()
        .map(|c| Curve {
            id: c.id(),
            kind: match c {
                SketchCurve::Line { start, end, .. } => Kind::Line {
                    start: (*start).into(),
                    end: (*end).into(),
                },
                SketchCurve::Arc {
                    start,
                    end,
                    center,
                    ccw,
                    ..
                } => Kind::Arc {
                    start: (*start).into(),
                    end: (*end).into(),
                    geom: ArcGeom::from_ir((*start).into(), (*end).into(), (*center).into(), *ccw),
                },
                SketchCurve::Circle { center, radius, .. } => Kind::Circle {
                    center: (*center).into(),
                    radius: *radius,
                },
            },
        })
        .collect();
    if curves.is_empty() {
        return Err(OpError::SketchNoRegions);
    }

    // Stage 1: endpoints.
    let ends: Vec<EndRef> = curves
        .iter()
        .enumerate()
        .filter(|(_, c)| !matches!(c.kind, Kind::Circle { .. }))
        .flat_map(|(i, _)| [(i, CurveEnd::Start), (i, CurveEnd::End)])
        .collect();
    let point_of = |(i, e): EndRef| curves[i].kind.endpoint(e).expect("line/arc end");
    let mut partner: Vec<[Option<EndRef>; 2]> = vec![[None, None]; curves.len()];
    for &(i, e) in &ends {
        let p = point_of((i, e));
        let hits: Vec<EndRef> = ends
            .iter()
            .copied()
            .filter(|&(j, _)| j != i)
            .filter(|&q| p.distance(point_of(q)) <= t)
            .collect();
        match hits.as_slice() {
            [] => {
                return Err(OpError::SketchOpenLoop {
                    curve: curves[i].id.to_string(),
                    end: e,
                    point: p.to_array(),
                });
            }
            [q] => partner[i][e as usize] = Some(*q),
            _ => {
                return Err(OpError::SketchBranching {
                    curve: curves[i].id.to_string(),
                    end: e,
                    point: p.to_array(),
                    partners: hits
                        .iter()
                        .map(|&(j, k)| format!("{}:{}", curves[j].id, k.as_str()))
                        .collect(),
                });
            }
        }
    }
    let partner_of = |q: EndRef| partner[q.0][q.1 as usize];

    // Loop assembly: (curve index, forward) uses.
    let mut raw_loops: Vec<Vec<(usize, bool)>> = Vec::new();
    let mut used = vec![false; curves.len()];
    for i in 0..curves.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        if matches!(curves[i].kind, Kind::Circle { .. }) {
            raw_loops.push(vec![(i, true)]);
            continue;
        }
        let mut uses = vec![(i, true)];
        let mut cur: EndRef = (i, CurveEnd::End);
        let mut closed = false;
        for _ in 0..=curves.len() {
            let (j, k) = partner_of(cur)
                .ok_or_else(|| OpError::Internal(format!("curve end {cur:?} lost its partner")))?;
            if j == i {
                closed = k == CurveEnd::Start;
                break;
            }
            used[j] = true;
            let fwd = k == CurveEnd::Start;
            uses.push((j, fwd));
            cur = (j, if fwd { CurveEnd::End } else { CurveEnd::Start });
        }
        if !closed {
            return Err(OpError::Internal(format!(
                "the chain starting at curve {:?} does not close",
                curves[i].id
            )));
        }
        raw_loops.push(uses);
    }

    // Stage 2: crossings.
    let prims: Vec<Prim> = curves.iter().map(|c| c.kind.prim()).collect();
    for i in 0..curves.len() {
        for j in i + 1..curves.len() {
            let ct = contacts(&prims[i], &prims[j], t);
            if ct.overlap {
                return Err(OpError::SketchCurvesCross {
                    first: curves[i].id.to_string(),
                    second: curves[j].id.to_string(),
                    point: None,
                });
            }
            if ct.points.is_empty() {
                continue;
            }
            let mut shared: Vec<Point2> = Vec::new();
            for e in [CurveEnd::Start, CurveEnd::End] {
                if let Some((pj, pk)) = partner_of((i, e))
                    && pj == j
                {
                    shared.push(point_of((i, e)));
                    shared.push(point_of((j, pk)));
                }
            }
            if let Some(p) = ct
                .points
                .iter()
                .find(|p| !shared.iter().any(|s| p.distance(*s) <= 2.0 * t))
            {
                return Err(OpError::SketchCurvesCross {
                    first: curves[i].id.to_string(),
                    second: curves[j].id.to_string(),
                    point: Some(p.to_array()),
                });
            }
        }
    }

    // Loop geometry and stage 3: degenerate loops.
    let mut loops: Vec<Loop> = Vec::with_capacity(raw_loops.len());
    let mut test_points: Vec<Point2> = Vec::with_capacity(raw_loops.len());
    for uses in &raw_loops {
        let lp = build_loop(&curves, uses, t);
        check_area(&lp, t)?;
        test_points.push(curves[uses[0].0].kind.test_point());
        loops.push(lp);
    }

    // Nesting.
    let n = loops.len();
    let mut containers: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (k, tp) in test_points.iter().enumerate() {
        for (m, other) in loops.iter().enumerate() {
            if m != k && other.winding_number(*tp) != 0 {
                containers[k].push(m);
            }
        }
    }
    let depth: Vec<usize> = containers.iter().map(Vec::len).collect();

    // Regions.
    let mut out: Vec<Region> = Vec::new();
    for k in 0..n {
        if !depth[k].is_multiple_of(2) {
            continue;
        }
        let outer = orient(loops[k].clone(), true);
        let mut holes: Vec<Loop> = (0..n)
            .filter(|&h| depth[h] == depth[k] + 1 && containers[h].contains(&k))
            .map(|h| orient(loops[h].clone(), false))
            .collect();
        holes.sort_by_key(Loop::sorted_ids);
        let area = outer.signed_area.abs() - holes.iter().map(|h| h.signed_area.abs()).sum::<f64>();
        let outer_curves = outer.sorted_ids();
        out.push(Region {
            outer,
            holes,
            area,
            outer_curves,
        });
    }
    if out.is_empty() {
        return Err(OpError::SketchNoRegions);
    }
    out.sort_by(|a, b| a.outer_curves.cmp(&b.outer_curves));
    Ok(out)
}

/// SPEC §3.1 stage 3: a loop must enclose more than `tol²`.
///
/// After stage 2 this is hard to trigger: any sliver thin enough is usually already a
/// tangency contact between its own curves. It stays as the last line of defence.
fn check_area(lp: &Loop, tol: f64) -> Result<(), OpError> {
    if lp.signed_area.abs() <= tol * tol {
        return Err(OpError::SketchDegenerateLoop {
            curves: lp.curves.iter().map(|c| c.id.clone()).collect(),
            area: lp.signed_area.abs(),
        });
    }
    Ok(())
}

/// Orient a loop counter-clockwise (`ccw`) or clockwise and start it canonically.
fn orient(lp: Loop, ccw: bool) -> Loop {
    let lp = if (lp.signed_area > 0.0) == ccw {
        lp
    } else {
        lp.reversed()
    };
    lp.canonical_start()
}

fn end_label(id: &str, e: CurveEnd) -> String {
    format!("{id}:{}", e.as_str())
}

fn build_loop(curves: &[Curve<'_>], uses: &[(usize, bool)], tol: f64) -> Loop {
    let n = uses.len();
    // Ends of use k in traversal order.
    let use_end = |k: usize, at_start: bool| -> CurveEnd {
        let fwd = uses[k].1;
        match (fwd, at_start) {
            (true, true) | (false, false) => CurveEnd::Start,
            _ => CurveEnd::End,
        }
    };
    let mut junctions = Vec::new();
    if !matches!(curves[uses[0].0].kind, Kind::Circle { .. }) {
        for k in 0..n {
            let (pi, _) = uses[(k + n - 1) % n];
            let (ci, _) = uses[k];
            let pe = use_end((k + n - 1) % n, false);
            let ce = use_end(k, true);
            let a = curves[pi].kind.endpoint(pe).expect("end");
            let b = curves[ci].kind.endpoint(ce).expect("end");
            let point = a.lerp(b, 0.5);
            let ga = curves[pi].kind.geometric_endpoint(pe).expect("end");
            let gb = curves[ci].kind.geometric_endpoint(ce).expect("end");
            let gap = point.distance(ga).max(point.distance(gb));
            let mut labels = [end_label(curves[pi].id, pe), end_label(curves[ci].id, ce)];
            labels.sort();
            junctions.push(Junction {
                point,
                tolerance: tol.max(2.0 * gap),
                key: labels.join("|"),
            });
        }
    }
    let mut loop_curves = Vec::with_capacity(n);
    for (k, &(ci, fwd)) in uses.iter().enumerate() {
        let geom = match curves[ci].kind {
            Kind::Line { .. } => LoopCurveGeom::Line {
                start: junctions[k].point,
                end: junctions[(k + 1) % n].point,
            },
            Kind::Arc { geom, .. } => {
                let (start_angle, sweep) = if fwd {
                    (geom.start_angle, geom.sweep)
                } else {
                    (geom.start_angle + geom.sweep, -geom.sweep)
                };
                LoopCurveGeom::Arc {
                    center: geom.center,
                    radius: geom.radius,
                    start_angle,
                    sweep,
                }
            }
            Kind::Circle { center, radius } => LoopCurveGeom::Circle {
                center,
                radius,
                ccw: true,
            },
        };
        loop_curves.push(LoopCurve {
            id: curves[ci].id.to_string(),
            sketch_index: ci,
            geom,
            reversed: !fwd,
        });
    }
    let signed_area = signed_area(&loop_curves, &junctions);
    Loop {
        curves: loop_curves,
        junctions,
        signed_area,
    }
}

/// Exact signed area: shoelace over the junction polygon (relative to its first point for
/// conditioning) plus the circular-segment area between each arc and its chord.
fn signed_area(curves: &[LoopCurve], junctions: &[Junction]) -> f64 {
    if let [c] = curves
        && let LoopCurveGeom::Circle { radius, ccw, .. } = c.geom
    {
        let a = math::PI * radius * radius;
        return if ccw { a } else { -a };
    }
    let n = junctions.len();
    let o = junctions[0].point;
    let mut twice = 0.0;
    for k in 0..n {
        let a = junctions[k].point - o;
        let b = junctions[(k + 1) % n].point - o;
        twice += a.perp_dot(b);
    }
    let mut seg = 0.0;
    for c in curves {
        if let LoopCurveGeom::Arc { radius, sweep, .. } = c.geom {
            seg += 0.5 * radius * radius * (sweep - math::sin(sweep));
        }
    }
    0.5 * twice + seg
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_triangle(h: f64) -> Loop {
        let pts = [
            Point2::new(0.0, 0.0),
            Point2::new(2e-6, 0.0),
            Point2::new(1e-6, h),
        ];
        let junctions = (0..3)
            .map(|k| Junction {
                point: pts[k],
                tolerance: 1e-6,
                key: format!("{k}"),
            })
            .collect::<Vec<_>>();
        let curves = (0..3)
            .map(|k| LoopCurve {
                id: format!("c{k}"),
                sketch_index: k,
                geom: LoopCurveGeom::Line {
                    start: pts[k],
                    end: pts[(k + 1) % 3],
                },
                reversed: false,
            })
            .collect::<Vec<_>>();
        let signed_area = signed_area(&curves, &junctions);
        Loop {
            curves,
            junctions,
            signed_area,
        }
    }

    #[test]
    fn loops_enclosing_at_most_tol_squared_are_degenerate() {
        // Area = ½·2e-6·h: 1e-12 at h = 1e-6 (inclusive bound), 2e-12 at h = 2e-6.
        let e = check_area(&tiny_triangle(0.5e-6), 1e-6).unwrap_err();
        assert_eq!(e.code(), "SKETCH_DEGENERATE_LOOP");
        assert!(check_area(&tiny_triangle(2e-6), 1e-6).is_ok());
    }

    #[test]
    fn reversing_a_loop_negates_its_area_and_keeps_junctions_consistent() {
        let lp = tiny_triangle(1e-3);
        let r = lp.reversed();
        assert!((r.signed_area + lp.signed_area).abs() == 0.0);
        for k in 0..3 {
            let (a, b) = r.curve_ends(k);
            let LoopCurveGeom::Line { start, end } = r.curves[k].geom else {
                unreachable!()
            };
            assert_eq!((a, b), (start, end));
        }
        assert!((signed_area(&r.curves, &r.junctions) - r.signed_area).abs() < 1e-24);
    }
}
