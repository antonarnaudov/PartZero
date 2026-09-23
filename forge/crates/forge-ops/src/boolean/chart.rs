//! Face arrangements in a planar **chart** of the face's parameter domain.
//!
//! A face is split along the curves that lie on it (its own boundary pieces, intersection
//! edges, imprinted edges of the other operand). Forge faces have no seams (ADR 0012), so
//! the parameter domain of a periodic surface is a cylinder or torus, and loops may wrap
//! around it. The arrangement is computed in a planar chart and glued back:
//!
//! 1. **Orientation.** Chart coordinates are `X = u`, `Y = σ·v` with `σ = +1` when the
//!    face's `sense` is true: the face then lies on the **left** of its loops in the chart
//!    (forge-check's convention).
//! 2. **Cuts.** For a periodic direction a cut line (`X = X_c`, and `Y = Y_c` on a torus) is
//!    placed in the middle of the widest gap between the critical parameter values of all
//!    curves (vertices, parameter extrema, iso-parameter curves), so every curve crosses it
//!    transversally and no vertex lies on it. Curves are split at the cut and shifted into
//!    the window `[X_c, X_c + P)`. The two copies of the cut line become **cut pieces**
//!    (virtual edges) that are glued pairwise.
//! 3. **Frame.** The window is closed by frame pieces: at a singular line of the surface
//!    (cone apex, sphere pole) or at a margin beyond all curves (unbounded directions).
//! 4. **Arrangement.** Nodes are B-rep vertices (identified by id, never by coordinates;
//!    a vertex at a singular line gets one node per chart position), cut crossings and
//!    frame corners. Outgoing half-edges are sorted by tangent angle (ties by the chord to
//!    a nearby point, i.e. curvature); `next(h)` is the clockwise neighbour of `twin(h)`.
//!    Positive-area cycles are region boundaries; every negative cycle is attached to the
//!    region found by a ray cast upwards from its highest point.
//! 5. **Status.** The inside half-edge of a boundary piece (traversed as its coedge) has the
//!    face on its left, the other side is outside; interior pieces have the face on both
//!    sides; glued cut pieces and interior pieces transmit status, and non-singular frames
//!    are outside. Contradictions are errors.
//! 6. **Faces.** Inside regions glued across cut pieces (never across real pieces) form the
//!    output faces; their loops follow `next` at B-rep vertices (at a singular vertex, the
//!    nearest outgoing edge along the singular line, on the face's side).
//!
//! Point location casts an axis-parallel ray and uses the nearest crossing: the crossed
//! half-edge that has the point on its left names the region (crossings are bisected on
//! the true pcurves, not on polylines).

use std::collections::{BTreeMap, BTreeSet};

use forge_core::geom::{Curve2, Surface};
use forge_core::linalg::{Point2, Vec2};
use forge_core::math;

use super::error::BooleanError;
use super::geom::singular_vs;

/// How an input curve is used by the face.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Use {
    /// A piece of the face boundary, traversed forward (`true`, along increasing `t`) or
    /// backward by the face's loop.
    Boundary(bool),
    /// A curve inside the face (both sides belong to the face).
    Interior,
}

/// One curve on the face: an edge (or piece of one) with its pcurve.
#[derive(Clone, Debug)]
pub(crate) struct Input {
    /// Pcurve on the face's surface (shares the edge parameter).
    pub pcurve: Curve2,
    /// Edge parameter range.
    pub range: (f64, f64),
    /// Vertex ids at `range.0` / `range.1` (the caller's ids); both `None` for a ring.
    pub start: Option<usize>,
    pub end: Option<usize>,
    pub use_: Use,
}

/// A face of the output: loops of `(input index, forward)`.
#[derive(Clone, Debug)]
pub(crate) struct OutFace {
    pub loops: Vec<Vec<(usize, bool)>>,
    /// A parameter point inside the face (away from its boundary).
    pub interior_uv: Option<Point2>,
    /// Further inside points, best first (for callers that find the first degenerate).
    pub more_uv: Vec<Point2>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Geo {
    /// Input `i` over `[t0, t1]`, chart point `(pc.x + sx, σ·pc.y + sy)`.
    Real {
        input: usize,
        t0: f64,
        t1: f64,
        shift: Vec2,
    },
    /// Straight segment `a → b` in chart coordinates.
    Seg { a: Point2, b: Point2 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Real,
    /// A piece of cut line `axis` (0: `X = const`, 1: `Y = const`); `high` for the copy
    /// at `X_c + P` (`Y_c + P`); `slot` pairs it with the other copy.
    Cut {
        axis: usize,
        high: bool,
        slot: usize,
    },
    /// Frame piece; `singular` when it lies on a singular line of the surface.
    Frame {
        singular: bool,
    },
}

#[derive(Clone, Debug)]
struct Piece {
    geo: Geo,
    kind: Kind,
    n0: usize,
    n1: usize,
}

#[derive(Clone, Copy, Debug)]
struct Node {
    pos: Point2,
    /// B-rep vertex id, if any.
    vertex: Option<usize>,
    /// On a singular frame line.
    singular: bool,
}

/// Chart configuration shared by construction and point location.
#[derive(Clone, Debug)]
struct Frame {
    sigma: f64,
    per: [Option<f64>; 2],
    /// Window start in X and Y for periodic directions.
    cut: [Option<f64>; 2],
    x_range: (f64, f64),
    y_range: (f64, f64),
    /// Which frame ends are singular lines: `[bottom, top]` (Y), for periodic-u surfaces.
    singular: [bool; 2],
}

/// The arrangement of one face.
pub(crate) struct Chart {
    frame: Frame,
    inputs: Vec<Input>,
    nodes: Vec<Node>,
    pieces: Vec<Piece>,
    /// `next` per half-edge (`2·piece + dir`).
    next: Vec<usize>,
    /// Region per half-edge (`usize::MAX`: the unbounded region).
    region_of: Vec<usize>,
    /// Region status: `Some(true)` inside.
    status: Vec<Option<bool>>,
    /// Output face (group) per region, `usize::MAX` outside.
    group: Vec<usize>,
    groups: usize,
    /// Signed area per region's outer cycle (chart units).
    region_area: Vec<f64>,
    surface: Surface,
    /// Scale of the parameter window (for relative thresholds).
    scale: f64,
    /// Interior inputs found to be bridges (both sides of every piece in one half-edge
    /// cycle) by the arrangement; the chart is rebuilt without them.
    bridges: Vec<usize>,
    /// Caller's index of each (kept) input.
    orig: Vec<usize>,
    /// Caller's indices of the inputs dropped as bridges.
    dropped: Vec<usize>,
}

const UNBOUNDED: usize = usize::MAX;

fn err(detail: impl Into<String>) -> BooleanError {
    BooleanError::inconsistent(detail, "face arrangement")
}

/// Ray directions for point location: `+X`, `+Y`, `−X`, `−Y` first (index 1 is `+Y`,
/// used from the highest point of a hole cycle), then generic directions that avoid
/// axis-aligned configurations.
const RAY_DIRS: [[f64; 2]; 12] = [
    [1.0, 0.0],
    [0.0, 1.0],
    [-1.0, 0.0],
    [0.0, -1.0],
    [0.803_207_531_480_644_9, 0.595_699_304_492_433_3],
    [-0.419_870_031_380_553_5, 0.907_584_130_523_780_7],
    [-0.964_966_028_492_113, -0.262_374_853_703_428_7],
    [0.296_209_875_817_686_3, -0.955_123_246_425_297_3],
    [0.997_564_050_259_824_2, -0.069_756_473_744_125_3],
    [0.121_869_343_405_147_5, 0.992_546_151_641_322],
    [-0.681_998_360_062_498_5, 0.731_353_701_619_170_5],
    [-0.559_192_903_470_746_8, -0.829_037_572_555_041_7],
];

/// Samples per span for crossings, areas and extrema.
const SPAN_SAMPLES: usize = 32;

fn spans_of(pc: &Curve2, t0: f64, t1: f64) -> Vec<(f64, f64)> {
    let (lo, hi) = (t0.min(t1), t0.max(t1));
    let mut pts = vec![lo];
    if let Curve2::BSpline(b) = pc {
        let mut ks: Vec<f64> = b
            .knots()
            .iter()
            .copied()
            .filter(|k| *k > lo && *k < hi)
            .collect();
        ks.dedup_by(|a, b| a.to_bits() == b.to_bits());
        pts.extend(ks);
    }
    pts.push(hi);
    pts.windows(2).map(|w| (w[0], w[1])).collect()
}

/// Gauss–Legendre 8-point nodes and weights on [-1, 1].
const GL8: [(f64, f64); 8] = [
    (-0.960_289_856_497_536_3, 0.101_228_536_290_376_26),
    (-0.796_666_477_413_626_7, 0.222_381_034_453_374_47),
    (-0.525_532_409_916_329, 0.313_706_645_877_887_3),
    (-0.183_434_642_495_649_8, 0.362_683_783_378_362),
    (0.183_434_642_495_649_8, 0.362_683_783_378_362),
    (0.525_532_409_916_329, 0.313_706_645_877_887_3),
    (0.796_666_477_413_626_7, 0.222_381_034_453_374_47),
    (0.960_289_856_497_536_3, 0.101_228_536_290_376_26),
];

impl Chart {
    /// Build the arrangement of `inputs` on a face of `surface` with `sense`.
    ///
    /// Interior inputs that separate nothing (both sides of the curve in one region: a
    /// tangent contact line inside the face, or one running from boundary to boundary of a
    /// band without splitting it) are no face boundaries: they are dropped (see
    /// [`Chart::dropped`]) and the arrangement is rebuilt without them.
    pub fn build(surface: &Surface, sense: bool, inputs: Vec<Input>) -> Result<Self, BooleanError> {
        let mut orig: Vec<usize> = (0..inputs.len()).collect();
        let mut inputs = inputs;
        let mut dropped: Vec<usize> = Vec::new();
        for _ in 0..8 {
            let mut c = Self::build_once(surface, sense, inputs.clone())?;
            if c.bridges.is_empty() {
                c.orig = orig;
                dropped.sort_unstable();
                c.dropped = dropped;
                return Ok(c);
            }
            let set: BTreeSet<usize> = c.bridges.iter().copied().collect();
            dropped.extend(set.iter().map(|&i| orig[i]));
            let keep: Vec<usize> = (0..inputs.len()).filter(|i| !set.contains(i)).collect();
            orig = keep.iter().map(|&i| orig[i]).collect();
            inputs = keep.iter().map(|&i| inputs[i].clone()).collect();
        }
        Err(err("bridge removal did not converge"))
    }

    /// Caller's indices of the interior inputs dropped because they separate nothing.
    pub fn dropped(&self) -> &[usize] {
        &self.dropped
    }

    fn build_once(
        surface: &Surface,
        sense: bool,
        inputs: Vec<Input>,
    ) -> Result<Self, BooleanError> {
        let sigma = if sense { 1.0 } else { -1.0 };
        let (pu, pv) = surface.periodicity();
        let per = [pu, pv];
        // Chart points of an input.
        let pt = |inp: &Input, t: f64| -> Point2 {
            let p = inp.pcurve.eval(t);
            Point2::new(p.x, sigma * p.y)
        };
        let der = |inp: &Input, t: f64| -> Vec2 {
            let d = inp.pcurve.d1(t);
            Vec2::new(d.x, sigma * d.y)
        };
        // ---- cuts -------------------------------------------------------------------
        let mut cut: [Option<f64>; 2] = [None, None];
        for axis in 0..2 {
            let Some(p) = per[axis] else { continue };
            let mut crit: Vec<f64> = Vec::new();
            for inp in &inputs {
                for (a, b) in spans_of(&inp.pcurve, inp.range.0, inp.range.1) {
                    let n = SPAN_SAMPLES;
                    let vals: Vec<f64> = (0..=n)
                        .map(|i| {
                            let t = a + (b - a) * i as f64 / n as f64;
                            let q = pt(inp, t);
                            if axis == 0 { q.x } else { q.y }
                        })
                        .collect();
                    crit.push(vals[0]);
                    crit.push(vals[n]);
                    let (mn, mx) = vals
                        .iter()
                        .fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), &x| {
                            (l.min(x), h.max(x))
                        });
                    if mx - mn <= 1e-9 * (1.0 + mx.abs()) {
                        crit.push(mn);
                        continue;
                    }
                    for i in 1..n {
                        let (x0, x1, x2) = (vals[i - 1], vals[i], vals[i + 1]);
                        if (x1 - x0) * (x2 - x1) <= 0.0 {
                            crit.push(x1);
                            // The true extremum lies within the neighbouring samples.
                            crit.push(x0);
                            crit.push(x2);
                        }
                    }
                }
            }
            if axis == 1 {
                // Singular lines of a periodic-v surface would be critical too (none for
                // ring tori).
            }
            let mut m: Vec<f64> = crit.iter().map(|&x| math::rem_euclid(x, p)).collect();
            m.sort_by(f64::total_cmp);
            let c = if m.is_empty() {
                0.0
            } else {
                let mut best = (m[0] + p - m[m.len() - 1], m[m.len() - 1]);
                for w in m.windows(2) {
                    if w[1] - w[0] > best.0 {
                        best = (w[1] - w[0], w[0]);
                    }
                }
                if best.0 < 1e-6 {
                    return Err(err(
                        "no room for a cut line (curves cover every parameter value)",
                    ));
                }
                best.1 + 0.5 * best.0
            };
            cut[axis] = Some(c);
        }
        // ---- split inputs at the cuts ------------------------------------------------
        let mut chart = Chart {
            frame: Frame {
                sigma,
                per,
                cut,
                x_range: (0.0, 0.0),
                y_range: (0.0, 0.0),
                singular: [false, false],
            },
            inputs,
            nodes: Vec::new(),
            pieces: Vec::new(),
            next: Vec::new(),
            region_of: Vec::new(),
            status: Vec::new(),
            group: Vec::new(),
            groups: 0,
            region_area: Vec::new(),
            surface: surface.clone(),
            scale: 1.0,
            bridges: Vec::new(),
            orig: Vec::new(),
            dropped: Vec::new(),
        };
        let singular_rows: Vec<f64> = singular_vs(surface).iter().map(|v| sigma * v).collect();
        let mut vnode: BTreeMap<(usize, i64), usize> = BTreeMap::new();
        // Cut crossings: (axis, position along the cut, input, t) collected first.
        struct Crossing {
            axis: usize,
            along: f64,
            node_lo: usize,
            node_hi: usize,
        }
        let mut crossings: Vec<Crossing> = Vec::new();
        let n_inputs = chart.inputs.len();
        let mut extent_lo = Point2::new(f64::INFINITY, f64::INFINITY);
        let mut extent_hi = Point2::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
        for ii in 0..n_inputs {
            let inp = chart.inputs[ii].clone();
            let (t0, t1) = inp.range;
            if t0.partial_cmp(&t1) != Some(std::cmp::Ordering::Less) {
                return Err(err("input with an empty parameter range"));
            }
            // Parameters where the input crosses a cut line (either axis).
            let mut cuts_t: Vec<(f64, usize)> = Vec::new();
            for axis in 0..2 {
                let (Some(c), Some(p)) = (cut[axis], per[axis]) else {
                    continue;
                };
                let coord = |t: f64| {
                    let q = pt(&inp, t);
                    if axis == 0 { q.x } else { q.y }
                };
                for (a, b) in spans_of(&inp.pcurve, t0, t1) {
                    let n = SPAN_SAMPLES;
                    let mut ta = a;
                    let mut ka = ((coord(a) - c) / p).floor();
                    for i in 1..=n {
                        let tb = if i == n {
                            b
                        } else {
                            a + (b - a) * i as f64 / n as f64
                        };
                        let kb = ((coord(tb) - c) / p).floor();
                        // (Whole numbers: they differ by at least one.)
                        if (kb - ka).abs() >= 0.5 {
                            // Crossings of every level between ka and kb (one normally).
                            let (lo_k, hi_k) = (ka.min(kb), ka.max(kb));
                            let mut k = lo_k + 1.0;
                            while k <= hi_k {
                                let level = c + k * p;
                                let (mut lo, mut hi) = (ta, tb);
                                let f_lo = coord(lo) - level;
                                for _ in 0..100 {
                                    let mid = 0.5 * (lo + hi);
                                    let fm = coord(mid) - level;
                                    if (fm < 0.0) == (f_lo < 0.0) {
                                        lo = mid;
                                    } else {
                                        hi = mid;
                                    }
                                }
                                cuts_t.push((0.5 * (lo + hi), axis));
                                k += 1.0;
                            }
                        }
                        ta = tb;
                        ka = kb;
                    }
                }
            }
            cuts_t.sort_by(|a, b| a.0.total_cmp(&b.0));
            // Pieces between consecutive cut parameters.
            let mut ts: Vec<f64> = vec![t0];
            ts.extend(cuts_t.iter().map(|c| c.0));
            ts.push(t1);
            let is_ring = inp.start.is_none() && inp.end.is_none();
            // Node at the start of the first piece and at the end of the last.
            let mut prev_node: Option<usize> = None;
            let mut first_node: Option<usize> = None;
            let npieces = ts.len() - 1;
            for k in 0..npieces {
                let (a, b) = (ts[k], ts[k + 1]);
                let mid = pt(&inp, 0.5 * (a + b));
                // Shift that brings the piece into the window.
                let shift = Vec2::new(
                    match (cut[0], per[0]) {
                        (Some(c), Some(p)) => -((mid.x - c) / p).floor() * p,
                        _ => 0.0,
                    },
                    match (cut[1], per[1]) {
                        (Some(c), Some(p)) => -((mid.y - c) / p).floor() * p,
                        _ => 0.0,
                    },
                );
                let pa = pt(&inp, a) + shift;
                let pb = pt(&inp, b) + shift;
                for (s0, s1) in spans_of(&inp.pcurve, a, b) {
                    let n = SPAN_SAMPLES;
                    for i in 0..=n {
                        let q = pt(&inp, s0 + (s1 - s0) * i as f64 / n as f64) + shift;
                        extent_lo = extent_lo.min_components2(q);
                        extent_hi = extent_hi.max_components2(q);
                    }
                }
                // Start node.
                let n0 = if k == 0 {
                    inp.start
                        .map(|v| chart.vertex_node(&mut vnode, v, pa, &singular_rows))
                } else {
                    prev_node
                };
                // End node.
                let n1 = if k + 1 == npieces {
                    inp.end
                        .map(|v| chart.vertex_node(&mut vnode, v, pb, &singular_rows))
                } else {
                    // A crossing: node at pb (on the high border) and its twin on the low
                    // border for the next piece.
                    let axis = cuts_t[k].1;
                    let p = per[axis].expect("periodic");
                    let hi_side = if axis == 0 {
                        (pb.x - cut[0].expect("cut")) > 0.5 * p
                    } else {
                        (pb.y - cut[1].expect("cut")) > 0.5 * p
                    };
                    let snap = |q: Point2, high: bool| -> Point2 {
                        let c = cut[axis].expect("cut");
                        let v = if high { c + p } else { c };
                        if axis == 0 {
                            Point2::new(v, q.y)
                        } else {
                            Point2::new(q.x, v)
                        }
                    };
                    let here = chart.add_node(snap(pb, hi_side), None, false);
                    let other = chart.add_node(snap(pb, !hi_side), None, false);
                    let along = if axis == 0 { pb.y } else { pb.x };
                    let (lo_n, hi_n) = if hi_side {
                        (other, here)
                    } else {
                        (here, other)
                    };
                    crossings.push(Crossing {
                        axis,
                        along,
                        node_lo: lo_n,
                        node_hi: hi_n,
                    });
                    prev_node = Some(other);
                    Some(here)
                };
                // Rings without crossings: a self-loop at a node on the ring.
                let (n0, n1) = match (n0, n1) {
                    (Some(x), Some(y)) => (x, y),
                    (None, None) if is_ring && npieces == 1 => {
                        let n = chart.add_node(pa, None, false);
                        (n, n)
                    }
                    (None, Some(y)) if is_ring => {
                        // First piece of a ring crossing cuts: starts where the last ends.
                        first_node = Some(usize::MAX);
                        (usize::MAX, y)
                    }
                    (Some(x), None) if is_ring => {
                        // Last piece of a ring: ends at the first piece's start.
                        (x, usize::MAX)
                    }
                    _ => return Err(err("open input without end vertices")),
                };
                chart.pieces.push(Piece {
                    geo: Geo::Real {
                        input: ii,
                        t0: a,
                        t1: b,
                        shift,
                    },
                    kind: Kind::Real,
                    n0,
                    n1,
                });
            }
            if is_ring && npieces > 1 {
                // Close the ring: the first piece starts at the last crossing's low twin.
                let last = chart.pieces.len() - 1;
                let first = chart.pieces.len() - npieces;
                let _ = first_node;
                // The last piece ends at a crossing too: its end node is the crossing
                // after the last cut parameter, which we create now.
                let axis = cuts_t[npieces - 2].1;
                let _ = axis;
                // `n1 == usize::MAX` on the last piece: create the crossing at t1 (≡ t0).
                // A ring's range is one period of its curve, so the end coincides with the
                // start: the last piece ends exactly where the first begins, i.e. in the
                // window, no crossing is needed there — reuse a fresh node shared by both.
                let q = match chart.pieces[last].geo {
                    Geo::Real { t1, shift, .. } => pt(&chart.inputs[ii], t1) + shift,
                    _ => unreachable!(),
                };
                let n = chart.add_node(q, None, false);
                chart.pieces[last].n1 = n;
                chart.pieces[first].n0 = n;
            }
        }
        // ---- window and frame -----------------------------------------------------------
        let size = {
            let d = extent_hi - extent_lo;
            if d.x.is_finite() && d.y.is_finite() {
                1.0 + d.x.abs().max(d.y.abs())
            } else {
                1.0
            }
        };
        chart.scale = size;
        // A margin that is no round number, so query points do not land on the frame.
        let margin = 0.2471 * size + 0.1373;
        let x_range = match (cut[0], per[0]) {
            (Some(c), Some(p)) => (c, c + p),
            _ => {
                if extent_lo.x.is_finite() {
                    (extent_lo.x - margin, extent_hi.x + margin)
                } else {
                    (-1.0, 1.0)
                }
            }
        };
        let (y_range, singular) = match (cut[1], per[1]) {
            (Some(c), Some(p)) => ((c, c + p), [false, false]),
            _ => {
                let (mut lo, mut hi) = if extent_lo.y.is_finite() {
                    (extent_lo.y - margin, extent_hi.y + margin)
                } else {
                    (-1.0, 1.0)
                };
                let mut sing = [false, false];
                let eps = 1e-9 * size;
                // A singular line of the surface (apex, pole) bounds the window on the side
                // where no curve lies: the surface ends there. A loopless face spans the
                // surface from its lowest to its highest singular line.
                let finite = extent_lo.y.is_finite();
                if !finite && !singular_rows.is_empty() {
                    let mn = singular_rows.iter().copied().fold(f64::INFINITY, f64::min);
                    let mx = singular_rows
                        .iter()
                        .copied()
                        .fold(f64::NEG_INFINITY, f64::max);
                    if mx > mn {
                        lo = mn;
                        hi = mx;
                        sing = [true, true];
                    }
                }
                let mut below: Option<f64> = None;
                let mut above: Option<f64> = None;
                for &s in singular_rows.iter().filter(|_| finite) {
                    if extent_lo.y >= s - eps {
                        below = Some(below.map_or(s, |b: f64| b.max(s)));
                    }
                    if extent_hi.y <= s + eps {
                        above = Some(above.map_or(s, |a: f64| a.min(s)));
                    }
                }
                if let Some(b) = below {
                    lo = b;
                    sing[0] = true;
                }
                if let Some(a) = above {
                    hi = a;
                    sing[1] = true;
                }
                if lo >= hi {
                    return Err(err("empty chart window"));
                }
                ((lo, hi), sing)
            }
        };
        chart.frame.x_range = x_range;
        chart.frame.y_range = y_range;
        chart.frame.singular = singular;
        // Corners.
        let c00 = chart.add_node(Point2::new(x_range.0, y_range.0), None, singular[0]);
        let c10 = chart.add_node(Point2::new(x_range.1, y_range.0), None, singular[0]);
        let c01 = chart.add_node(Point2::new(x_range.0, y_range.1), None, singular[1]);
        let c11 = chart.add_node(Point2::new(x_range.1, y_range.1), None, singular[1]);
        // Border lines: (fixed coordinate axis, value, from-corner, to-corner, kind).
        // Along each border, nodes sorted by the free coordinate.
        let mut border_nodes: [Vec<(f64, usize)>; 4] = [
            vec![(y_range.0, c00), (y_range.1, c01)], // left  X = x0
            vec![(y_range.0, c10), (y_range.1, c11)], // right X = x1
            vec![(x_range.0, c00), (x_range.1, c10)], // bottom Y = y0
            vec![(x_range.0, c01), (x_range.1, c11)], // top Y = y1
        ];
        for c in &crossings {
            if c.axis == 0 {
                border_nodes[0].push((c.along, c.node_lo));
                border_nodes[1].push((c.along, c.node_hi));
            } else {
                border_nodes[2].push((c.along, c.node_lo));
                border_nodes[3].push((c.along, c.node_hi));
            }
        }
        // Singular vertex nodes lie on the bottom/top frame.
        for (ni, n) in chart.nodes.iter().enumerate() {
            if n.vertex.is_some() && n.singular {
                if singular[0] && (n.pos.y - y_range.0).abs() <= 1e-7 * size {
                    border_nodes[2].push((n.pos.x, ni));
                } else if singular[1] && (n.pos.y - y_range.1).abs() <= 1e-7 * size {
                    border_nodes[3].push((n.pos.x, ni));
                } else {
                    return Err(err("vertex at a singular line off the chart frame"));
                }
            }
        }
        for b in &mut border_nodes {
            b.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.1.cmp(&y.1)));
        }
        let x_cut = cut[0].is_some();
        let y_cut = cut[1].is_some();
        // Left/right borders: cut pieces if u is periodic, frame otherwise.
        for (bi, high) in [(0usize, false), (1usize, true)] {
            let nodes = border_nodes[bi].clone();
            for (slot, w) in nodes.windows(2).enumerate() {
                let (a, b) = (chart.nodes[w[0].1].pos, chart.nodes[w[1].1].pos);
                let kind = if x_cut {
                    Kind::Cut {
                        axis: 0,
                        high,
                        slot,
                    }
                } else {
                    Kind::Frame { singular: false }
                };
                chart.pieces.push(Piece {
                    geo: Geo::Seg { a, b },
                    kind,
                    n0: w[0].1,
                    n1: w[1].1,
                });
            }
        }
        for (bi, high) in [(2usize, false), (3usize, true)] {
            let nodes = border_nodes[bi].clone();
            for (slot, w) in nodes.windows(2).enumerate() {
                let (a, b) = (chart.nodes[w[0].1].pos, chart.nodes[w[1].1].pos);
                let kind = if y_cut {
                    Kind::Cut {
                        axis: 1,
                        high,
                        slot,
                    }
                } else {
                    Kind::Frame {
                        singular: singular[if high { 1 } else { 0 }],
                    }
                };
                chart.pieces.push(Piece {
                    geo: Geo::Seg { a, b },
                    kind,
                    n0: w[0].1,
                    n1: w[1].1,
                });
            }
        }
        if x_cut && border_nodes[0].len() != border_nodes[1].len() {
            return Err(err("unpaired cut crossings (u)"));
        }
        if y_cut && border_nodes[2].len() != border_nodes[3].len() {
            return Err(err("unpaired cut crossings (v)"));
        }
        let _ = der;
        chart.arrange()?;
        Ok(chart)
    }

    fn add_node(&mut self, pos: Point2, vertex: Option<usize>, singular: bool) -> usize {
        self.nodes.push(Node {
            pos,
            vertex,
            singular,
        });
        self.nodes.len() - 1
    }

    /// The node of B-rep vertex `v` at chart position `pos` (one per chart position for
    /// vertices on a singular line).
    fn vertex_node(
        &mut self,
        map: &mut BTreeMap<(usize, i64), usize>,
        v: usize,
        pos: Point2,
        singular_rows: &[f64],
    ) -> usize {
        let on_singular = singular_rows
            .iter()
            .any(|&s| (pos.y - s).abs() <= 1e-7 * (1.0 + s.abs()));
        let key = if on_singular {
            (v, (pos.x * 1e9).round() as i64)
        } else {
            (v, i64::MIN)
        };
        if let Some(&n) = map.get(&key) {
            return n;
        }
        let n = self.add_node(pos, Some(v), on_singular);
        map.insert(key, n);
        n
    }

    /// Chart point of a piece at local parameter `s` (real: edge parameter; segment:
    /// `[0, 1]`).
    fn piece_point(&self, p: &Piece, s: f64) -> Point2 {
        match p.geo {
            Geo::Real { input, shift, .. } => {
                let q = self.inputs[input].pcurve.eval(s);
                Point2::new(q.x, self.frame.sigma * q.y) + shift
            }
            Geo::Seg { a, b } => a.lerp(b, s),
        }
    }

    fn piece_range(p: &Piece) -> (f64, f64) {
        match p.geo {
            Geo::Real { t0, t1, .. } => (t0, t1),
            Geo::Seg { .. } => (0.0, 1.0),
        }
    }

    /// Certified box of a piece over the parameter interval `[a, b]` (chart coordinates).
    fn piece_enclosure(&self, p: &Piece, a: f64, b: f64) -> (Point2, Point2) {
        use forge_core::scalar::Interval;
        match p.geo {
            Geo::Real { input, shift, .. } => {
                let q = self.inputs[input]
                    .pcurve
                    .eval(Interval::new(a.min(b), a.max(b)));
                let y = if self.frame.sigma > 0.0 { q.y } else { -q.y };
                (
                    Point2::new(q.x.lo() + shift.x, y.lo() + shift.y),
                    Point2::new(q.x.hi() + shift.x, y.hi() + shift.y),
                )
            }
            Geo::Seg { .. } => {
                let (x, y) = (self.piece_point(p, a), self.piece_point(p, b));
                (x.min_components2(y), x.max_components2(y))
            }
        }
    }

    fn piece_der(&self, p: &Piece, s: f64) -> Vec2 {
        match p.geo {
            Geo::Real { input, .. } => {
                let d = self.inputs[input].pcurve.d1(s);
                Vec2::new(d.x, self.frame.sigma * d.y)
            }
            Geo::Seg { a, b } => b - a,
        }
    }

    fn piece_spans(&self, p: &Piece) -> Vec<(f64, f64)> {
        match p.geo {
            Geo::Real { input, t0, t1, .. } => spans_of(&self.inputs[input].pcurve, t0, t1),
            Geo::Seg { .. } => vec![(0.0, 1.0)],
        }
    }

    /// Outgoing direction of half-edge `h` at its start node, and a point a little way
    /// along it (for tie-breaking).
    fn out_dir(&self, h: usize, frac: f64) -> (Vec2, Point2, Point2) {
        let p = &self.pieces[h / 2];
        let (a, b) = Self::piece_range(p);
        let fwd = h.is_multiple_of(2);
        let (s0, s1) = if fwd { (a, b) } else { (b, a) };
        let d = self.piece_der(p, s0) * if fwd { 1.0 } else { -1.0 };
        let start = self.piece_point(p, s0);
        let near = self.piece_point(p, s0 + (s1 - s0) * frac);
        (d, start, near)
    }

    fn arrange(&mut self) -> Result<(), BooleanError> {
        let nh = 2 * self.pieces.len();
        // Outgoing half-edges per node.
        let mut out: Vec<Vec<usize>> = vec![Vec::new(); self.nodes.len()];
        for (pi, p) in self.pieces.iter().enumerate() {
            if p.n0 >= self.nodes.len() || p.n1 >= self.nodes.len() {
                return Err(err("piece with an unset node"));
            }
            out[p.n0].push(2 * pi);
            out[p.n1].push(2 * pi + 1);
        }
        // Angular order (counter-clockwise from +X).
        let mut order: Vec<Vec<usize>> = Vec::with_capacity(out.len());
        for hs in &out {
            let mut keyed: Vec<(f64, usize)> = hs
                .iter()
                .map(|&h| {
                    let (d, st, near) = self.out_dir(h, 1e-6);
                    let d = if d.norm() > 0.0 { d } else { near - st };
                    (math::atan2(d.y, d.x), h)
                })
                .collect();
            // Measure angles from the middle of the widest gap between directions, so that
            // nearly equal directions never straddle the ±π cut (they must be adjacent to
            // be tie-broken).
            let mut reference = 0.0;
            if keyed.len() > 1 {
                let mut a: Vec<f64> = keyed.iter().map(|k| k.0).collect();
                a.sort_by(f64::total_cmp);
                let mut best = (a[0] + math::TAU - a[a.len() - 1], a[a.len() - 1]);
                for w in a.windows(2) {
                    if w[1] - w[0] > best.0 {
                        best = (w[1] - w[0], w[0]);
                    }
                }
                reference = best.1 + 0.5 * best.0;
                for k in &mut keyed {
                    k.0 = math::rem_euclid(k.0 - reference, math::TAU);
                }
            }
            keyed.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
            if std::env::var_os("FORGE_CHART_DEBUG").is_some() {
                let raw: Vec<_> = keyed
                    .iter()
                    .map(|&(k, h)| {
                        let (d, st, near) = self.out_dir(h, 1e-6);
                        (h, k, d, near - st)
                    })
                    .collect();
                eprintln!("keyed (ref {reference}): {raw:?}");
            }
            // Tie-breaks: equal tangents are ordered by the chord to a nearby point.
            let k = keyed.len();
            let mut i = 0;
            while i < k {
                // Nearly equal tangents (fitted curves' end tangents are only accurate
                // to their fit) are ordered by chords at one common distance from the node.
                let mut j = i + 1;
                while j < k && (keyed[j].0 - keyed[j - 1].0).abs() <= 1e-4 {
                    j += 1;
                }
                if j - i > 1 {
                    // The common tangent's actual angle (keys are measured from `reference`).
                    let base = keyed[i].0 + reference;
                    let len_of = |h: usize| -> f64 {
                        let p = &self.pieces[h / 2];
                        let (a, b) = Self::piece_range(p);
                        let mut l = 0.0;
                        let mut prev = self.piece_point(p, a);
                        for q in 1..=16 {
                            let x = self.piece_point(p, a + (b - a) * q as f64 / 16.0);
                            l += x.distance(prev);
                            prev = x;
                        }
                        l
                    };
                    let ell = keyed[i..j]
                        .iter()
                        .map(|&(_, h)| len_of(h))
                        .fold(f64::INFINITY, f64::min)
                        * 0.02;
                    let mut sub: Vec<(f64, usize)> = Vec::new();
                    for &(_, h) in &keyed[i..j] {
                        let mut ang = f64::NAN;
                        let len = len_of(h).max(1e-300);
                        for scale in [1.0, 10.0, 100.0] {
                            let frac = (scale * ell / len).min(0.5);
                            let (_, st, near) = self.out_dir(h, frac);
                            let c = near - st;
                            if c.norm() > 0.0 {
                                ang = math::atan2(c.y, c.x);
                                break;
                            }
                        }
                        // Relative to the common tangent, in (−π, π].
                        let rel = math::wrap_angle(ang - base + math::PI, 0.0) - math::PI;
                        sub.push((rel, h));
                    }
                    sub.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
                    for w in sub.windows(2) {
                        if (w[1].0 - w[0].0).abs() <= 1e-12 {
                            return Err(err("coincident curves at a vertex (unresolved tie)"));
                        }
                    }
                    for (off, (_, h)) in sub.into_iter().enumerate() {
                        keyed[i + off].1 = h;
                    }
                }
                i = j;
            }
            order.push(keyed.into_iter().map(|x| x.1).collect());
        }
        // next(h) = clockwise neighbour of twin(h) around h's end node.
        let mut pos_in: Vec<(usize, usize)> = vec![(0, 0); nh];
        for (ni, o) in order.iter().enumerate() {
            for (k, &h) in o.iter().enumerate() {
                pos_in[h] = (ni, k);
            }
        }
        let mut next = vec![usize::MAX; nh];
        for (h, nx) in next.iter_mut().enumerate() {
            let twin = h ^ 1;
            let (ni, k) = pos_in[twin];
            let o = &order[ni];
            *nx = o[(k + o.len() - 1) % o.len()];
        }
        self.next = next;
        // Cycles and their signed areas.
        let mut cycle_of = vec![usize::MAX; nh];
        let mut cycles: Vec<Vec<usize>> = Vec::new();
        for h in 0..nh {
            if cycle_of[h] != usize::MAX {
                continue;
            }
            let id = cycles.len();
            let mut cyc = Vec::new();
            let mut x = h;
            let mut guard = 0;
            loop {
                if cycle_of[x] != usize::MAX {
                    if x == h {
                        break;
                    }
                    return Err(err("half-edge cycles overlap"));
                }
                cycle_of[x] = id;
                cyc.push(x);
                x = self.next[x];
                guard += 1;
                if guard > nh + 1 {
                    return Err(err("runaway half-edge cycle"));
                }
            }
            cycles.push(cyc);
        }
        let areas: Vec<f64> = cycles.iter().map(|c| self.cycle_area(c)).collect();
        if std::env::var_os("FORGE_CHART_DEBUG").is_some() {
            for (pi, p) in self.pieces.iter().enumerate() {
                let (a, b) = Self::piece_range(p);
                eprintln!(
                    "piece {pi} {:?} n{}->n{} {:?} -> {:?}",
                    p.kind,
                    p.n0,
                    p.n1,
                    self.piece_point(p, a),
                    self.piece_point(p, b)
                );
            }
            for (ni, o) in order.iter().enumerate() {
                eprintln!("node {ni} {:?} order {o:?}", self.nodes[ni].pos);
            }
            for (ci, c) in cycles.iter().enumerate() {
                eprintln!("cycle {ci} area {} {c:?}", areas[ci]);
            }
        }
        // Interior inputs all of whose pieces have both sides in one cycle separate nothing.
        let mut bridged: BTreeMap<usize, bool> = BTreeMap::new();
        for (pi, p) in self.pieces.iter().enumerate() {
            if let Geo::Real { input, .. } = p.geo
                && self.inputs[input].use_ == Use::Interior
            {
                let b = cycle_of[2 * pi] == cycle_of[2 * pi + 1];
                let e = bridged.entry(input).or_insert(true);
                *e &= b;
            }
        }
        self.bridges = bridged.into_iter().filter(|x| x.1).map(|x| x.0).collect();
        if !self.bridges.is_empty() {
            return Ok(());
        }
        // Regions: positive cycles; negative cycles attach to the region above them.
        let mut region_of_cycle = vec![UNBOUNDED; cycles.len()];
        let mut region_area = Vec::new();
        for (ci, &a) in areas.iter().enumerate() {
            if a > 0.0 {
                region_of_cycle[ci] = region_area.len();
                region_area.push(a);
            }
        }
        // Parent cycle of each negative cycle (the cycle directly above its top point).
        let mut parent: Vec<Option<usize>> = vec![None; cycles.len()];
        for (ci, &a) in areas.iter().enumerate() {
            if a > 0.0 {
                continue;
            }
            // Highest sample of the cycle.
            let mut top = (f64::NEG_INFINITY, Point2::zero());
            for &h in &cycles[ci] {
                let p = &self.pieces[h / 2];
                for (s0, s1) in self.piece_spans(p) {
                    let n = SPAN_SAMPLES;
                    for i in 0..=n {
                        let q = self.piece_point(p, s0 + (s1 - s0) * i as f64 / n as f64);
                        if q.y > top.0 {
                            top = (q.y, q);
                        }
                    }
                }
            }
            // Upward rays leave the cycle at its top point; a ray through a node or tied with
            // another crossing is ambiguous, so try the other upward directions.
            let hit = [1usize, 9, 5, 4, 10]
                .into_iter()
                .find_map(|dir| self.ray_hit(top.1, dir, Some(&cycles[ci]), &cycle_of));
            parent[ci] = hit.map(|hh| cycle_of[hh]);
        }
        for ci in 0..cycles.len() {
            if areas[ci] > 0.0 {
                continue;
            }
            // Follow parents up to a positive cycle.
            let mut c = ci;
            let mut guard = 0;
            let mut reg = UNBOUNDED;
            while let Some(p) = parent[c] {
                if areas[p] > 0.0 {
                    reg = region_of_cycle[p];
                    break;
                }
                c = p;
                guard += 1;
                if guard > cycles.len() {
                    return Err(err("cyclic hole nesting"));
                }
            }
            region_of_cycle[ci] = reg;
        }
        let mut region_of = vec![UNBOUNDED; nh];
        for h in 0..nh {
            region_of[h] = region_of_cycle[cycle_of[h]];
        }
        self.region_of = region_of;
        self.region_area = region_area;
        self.resolve_status()?;
        // Interior inputs with the same output face on both sides of every piece (e.g. a
        // tangent contact line across a cylinder band, whose sides are glued across the
        // cut) bound nothing either.
        let mut same: BTreeMap<usize, bool> = BTreeMap::new();
        for (pi, p) in self.pieces.iter().enumerate() {
            if let Geo::Real { input, .. } = p.geo
                && self.inputs[input].use_ == Use::Interior
            {
                let g = |h: usize| {
                    let r = self.region_of[h];
                    if r == UNBOUNDED {
                        usize::MAX
                    } else {
                        self.group[r]
                    }
                };
                let b = g(2 * pi) == g(2 * pi + 1) && g(2 * pi) != usize::MAX;
                let e = same.entry(input).or_insert(true);
                *e &= b;
            }
        }
        self.bridges = same.into_iter().filter(|x| x.1).map(|x| x.0).collect();
        Ok(())
    }

    /// Signed area (½∮ X dY − Y dX) of a cycle, by Gauss quadrature per span.
    fn cycle_area(&self, cyc: &[usize]) -> f64 {
        let mut a = 0.0;
        for &h in cyc {
            let p = &self.pieces[h / 2];
            let sgn = if h % 2 == 0 { 1.0 } else { -1.0 };
            for (s0, s1) in self.piece_spans(p) {
                let (m, r) = (0.5 * (s0 + s1), 0.5 * (s1 - s0));
                for &(x, w) in &GL8 {
                    let s = m + r * x;
                    let q = self.piece_point(p, s);
                    let d = self.piece_der(p, s);
                    a += sgn * w * r * 0.5 * (q.x * d.y - q.y * d.x);
                }
            }
        }
        a
    }

    /// The half-edge whose curve the ray from `q` in direction `RAY_DIRS[dir]` crosses
    /// first, oriented so that `q` is on its **left** (`RAY_DIRS[1]` is `+Y`). Half-edges of
    /// `skip` (a cycle) are ignored. `None` if the ray meets nothing, or the nearest
    /// crossing is tangential, at a node, or tied with another crossing.
    fn ray_hit(
        &self,
        q: Point2,
        dir: usize,
        skip: Option<&Vec<usize>>,
        _cycle_of: &[usize],
    ) -> Option<usize> {
        let d = RAY_DIRS[dir];
        let d = Vec2::new(d[0], d[1]);
        // Signed offset from the ray's line (crossings are its sign changes) and position
        // along the ray.
        let along = |p: Point2| d.perp_dot(p - q);
        let across = |p: Point2| d.dot(p - q);
        let mut best: Option<(f64, usize, f64)> = None; // (distance, piece, rate)
        // Second-nearest distance (a tie with the nearest makes the ray ambiguous).
        let mut second = f64::INFINITY;
        let mut best_point = Point2::zero();
        for (pi, p) in self.pieces.iter().enumerate() {
            if let Some(sk) = skip
                && (sk.contains(&(2 * pi)) || sk.contains(&(2 * pi + 1)))
            {
                continue;
            }
            for (s0, s1) in self.piece_spans(p) {
                let n = SPAN_SAMPLES;
                let mut sa = s0;
                let mut fa = along(self.piece_point(p, sa));
                for i in 1..=n {
                    let sb = if i == n {
                        s1
                    } else {
                        s0 + (s1 - s0) * i as f64 / n as f64
                    };
                    let fb = along(self.piece_point(p, sb));
                    let crosses = (fa <= 0.0 && fb > 0.0) || (fa > 0.0 && fb <= 0.0);
                    if crosses {
                        let (mut lo, mut hi, mut flo) = (sa, sb, fa);
                        for _ in 0..100 {
                            let mid = 0.5 * (lo + hi);
                            let fm = along(self.piece_point(p, mid));
                            if (fm <= 0.0) == (flo <= 0.0) {
                                lo = mid;
                                flo = fm;
                            } else {
                                hi = mid;
                            }
                        }
                        let sc = 0.5 * (lo + hi);
                        let pc = self.piece_point(p, sc);
                        let dist = across(pc);
                        if dist > 0.0 {
                            let rate = d.perp_dot(self.piece_der(p, sc));
                            match best {
                                Some(b) if dist >= b.0 => second = second.min(dist),
                                Some(b) => {
                                    second = second.min(b.0);
                                    best = Some((dist, pi, rate));
                                    best_point = pc;
                                }
                                None => {
                                    best = Some((dist, pi, rate));
                                    best_point = pc;
                                }
                            }
                        }
                    }
                    sa = sb;
                    fa = fb;
                }
            }
        }
        let (bd, pi, rate) = best?;
        // Two pieces crossed at (almost) the same place, or the crossing is at a node (the
        // other pieces through it may be missed by rounding): ambiguous.
        if second - bd <= 1e-9 * self.scale
            || self
                .nodes
                .iter()
                .any(|n| n.pos.distance(best_point) <= 1e-9 * self.scale)
        {
            return None;
        }
        let dnorm = {
            let p = &self.pieces[pi];
            let (a, b) = Self::piece_range(p);
            self.piece_der(p, 0.5 * (a + b)).norm().max(1e-300)
        };
        if rate.abs() <= 1e-9 * dnorm {
            return None;
        }
        // `q` lies behind the crossing: on the left of a tangent `t` iff `d × t > 0`.
        Some(if rate > 0.0 { 2 * pi } else { 2 * pi + 1 })
    }

    fn resolve_status(&mut self) -> Result<(), BooleanError> {
        let nr = self.region_area.len();
        // Union-find over regions for "same status" (glue, interior pieces).
        let mut uf: Vec<usize> = (0..nr).collect();
        fn find(uf: &mut [usize], mut x: usize) -> usize {
            while uf[x] != x {
                uf[x] = uf[uf[x]];
                x = uf[x];
            }
            x
        }
        let union = |uf: &mut Vec<usize>, a: usize, b: usize| {
            if a == UNBOUNDED || b == UNBOUNDED {
                return;
            }
            let (ra, rb) = (find(uf, a), find(uf, b));
            if ra != rb {
                let (lo, hi) = (ra.min(rb), ra.max(rb));
                uf[hi] = lo;
            }
        };
        // The half-edge of a cut piece that has the window interior on its left.
        let inner = |p: &Piece, pi: usize| -> usize {
            match p.kind {
                // Left border (X = x0), nodes sorted by increasing Y: going down (reverse)
                // has +X on its left. Right border: going up (forward).
                Kind::Cut { axis: 0, high, .. } => 2 * pi + usize::from(!high),
                // Bottom border (Y = y0), sorted by increasing X: going +X (forward) has
                // +Y on its left. Top border: going −X (reverse).
                Kind::Cut { axis: _, high, .. } => 2 * pi + usize::from(high),
                _ => 2 * pi,
            }
        };
        let mut glue: BTreeMap<(usize, usize), [Option<usize>; 2]> = BTreeMap::new();
        for (pi, p) in self.pieces.iter().enumerate() {
            match p.kind {
                Kind::Cut { axis, high, slot } => {
                    let r = self.region_of[inner(p, pi)];
                    glue.entry((axis, slot)).or_insert([None, None])[usize::from(high)] = Some(r);
                }
                Kind::Real => {
                    if let Geo::Real { input, .. } = p.geo
                        && self.inputs[input].use_ == Use::Interior
                    {
                        let (a, b) = (self.region_of[2 * pi], self.region_of[2 * pi + 1]);
                        union(&mut uf, a, b);
                    }
                }
                Kind::Frame { .. } => {}
            }
        }
        for pair in glue.values() {
            match pair {
                [Some(a), Some(b)] => union(&mut uf, *a, *b),
                _ => return Err(err("cut piece without its glued twin")),
            }
        }
        // Known statuses.
        let mut st: Vec<Option<bool>> = vec![None; nr];
        let set = |uf: &mut Vec<usize>, st: &mut Vec<Option<bool>>, r: usize, v: bool| {
            if r == UNBOUNDED {
                return if v {
                    Err(err("the unbounded region is inside the face"))
                } else {
                    Ok(())
                };
            }
            let root = find(uf, r);
            match st[root] {
                Some(x) if x != v => Err(err("inconsistent inside/outside status")),
                _ => {
                    st[root] = Some(v);
                    Ok(())
                }
            }
        };
        for (pi, p) in self.pieces.iter().enumerate() {
            match (p.kind, p.geo) {
                (Kind::Real, Geo::Real { input, .. }) => match self.inputs[input].use_ {
                    Use::Boundary(fwd) => {
                        let hin = 2 * pi + usize::from(!fwd);
                        let rin = self.region_of[hin];
                        let rout = self.region_of[hin ^ 1];
                        set(&mut uf, &mut st, rin, true)?;
                        set(&mut uf, &mut st, rout, false)?;
                    }
                    Use::Interior => {
                        set(&mut uf, &mut st, self.region_of[2 * pi], true)?;
                    }
                },
                (Kind::Frame { singular: false }, _) => {
                    set(&mut uf, &mut st, self.region_of[2 * pi], false)?;
                    set(&mut uf, &mut st, self.region_of[2 * pi + 1], false)?;
                }
                _ => {}
            }
        }
        let has_boundary = self
            .inputs
            .iter()
            .any(|i| matches!(i.use_, Use::Boundary(_)));
        let mut status = vec![None; nr];
        for (r, sr) in status.iter_mut().enumerate() {
            let root = find(&mut uf, r);
            *sr = match st[root] {
                Some(v) => Some(v),
                None if !has_boundary => Some(true),
                None => return Err(err("region with undetermined status")),
            };
        }
        self.status = status;
        // Groups: inside regions glued across cut pieces only.
        let mut gu: Vec<usize> = (0..nr).collect();
        for pair in glue.values() {
            if let [Some(a), Some(b)] = pair
                && *a != UNBOUNDED
                && *b != UNBOUNDED
            {
                let (ra, rb) = (find(&mut gu, *a), find(&mut gu, *b));
                if ra != rb {
                    let (lo, hi) = (ra.min(rb), ra.max(rb));
                    gu[hi] = lo;
                }
            }
        }
        let mut gid: BTreeMap<usize, usize> = BTreeMap::new();
        let mut group = vec![usize::MAX; nr];
        for (r, gr) in group.iter_mut().enumerate() {
            if self.status[r] != Some(true) {
                continue;
            }
            let root = find(&mut gu, r);
            let n = gid.len();
            let g = *gid.entry(root).or_insert(n);
            *gr = g;
        }
        self.groups = gid.len();
        self.group = group;
        Ok(())
    }

    /// Number of output faces.
    pub fn face_count(&self) -> usize {
        self.groups
    }

    /// The output faces with their loops.
    pub fn faces(&self) -> Result<Vec<OutFace>, BooleanError> {
        // Real half-edges per (input, direction): their pieces in order.
        let mut pieces_of: Vec<Vec<usize>> = vec![Vec::new(); self.inputs.len()];
        for (pi, p) in self.pieces.iter().enumerate() {
            if let Geo::Real { input, .. } = p.geo {
                pieces_of[input].push(pi);
            }
        }
        for (ii, ps) in pieces_of.iter_mut().enumerate() {
            ps.sort_by(|a, b| {
                let ta = match self.pieces[*a].geo {
                    Geo::Real { t0, .. } => t0,
                    _ => 0.0,
                };
                let tb = match self.pieces[*b].geo {
                    Geo::Real { t0, .. } => t0,
                    _ => 0.0,
                };
                ta.total_cmp(&tb)
            });
            if ps.is_empty() {
                return Err(err(format!("input {ii} has no chart piece")));
            }
        }
        // Group of each input half-edge (input, dir) (dir 0 = forward).
        let mut hgroup: Vec<[Option<usize>; 2]> = vec![[None, None]; self.inputs.len()];
        for (ps, hg) in pieces_of.iter().zip(hgroup.iter_mut()) {
            for (dir, slot) in hg.iter_mut().enumerate() {
                let mut g: Option<Option<usize>> = None;
                for &pi in ps {
                    let r = self.region_of[2 * pi + dir];
                    let gr = if r == UNBOUNDED || self.group[r] == usize::MAX {
                        None
                    } else {
                        Some(self.group[r])
                    };
                    match g {
                        None => g = Some(gr),
                        Some(x) if x != gr => {
                            return Err(err("pieces of one edge side in different faces"));
                        }
                        _ => {}
                    }
                }
                *slot = g.flatten();
            }
        }
        // Loops per group.
        let mut out: Vec<OutFace> = (0..self.groups)
            .map(|_| OutFace {
                loops: Vec::new(),
                interior_uv: None,
                more_uv: Vec::new(),
            })
            .collect();
        let mut used = vec![[false; 2]; self.inputs.len()];
        for ii in 0..self.inputs.len() {
            for dir in 0..2 {
                let Some(g) = hgroup[ii][dir] else { continue };
                if used[ii][dir] {
                    continue;
                }
                let mut lp: Vec<(usize, bool)> = Vec::new();
                let (mut ci, mut cd) = (ii, dir);
                let mut guard = 0;
                loop {
                    if used[ci][cd] {
                        if (ci, cd) == (ii, dir) {
                            break;
                        }
                        return Err(err("loop walk re-entered a used edge side"));
                    }
                    if hgroup[ci][cd] != Some(g) {
                        return Err(err("loop walk left its face"));
                    }
                    used[ci][cd] = true;
                    lp.push((ci, cd == 0));
                    let inp = &self.inputs[ci];
                    if inp.start.is_none() && inp.end.is_none() {
                        break; // ring
                    }
                    let (nci, ncd) = self.next_input(&pieces_of, &hgroup, ci, cd, g)?;
                    ci = nci;
                    cd = ncd;
                    guard += 1;
                    if guard > 2 * self.inputs.len() + 2 {
                        return Err(err("runaway loop walk"));
                    }
                }
                out[g].loops.push(lp);
            }
        }
        // Order loops: planar faces put the counter-clockwise (outer) loop first.
        for f in &mut out {
            let mut keyed: Vec<(bool, Vec<(usize, bool)>)> = f
                .loops
                .drain(..)
                .map(|l| {
                    let a = self.loop_area(&l);
                    (a > 0.0, l)
                })
                .collect();
            keyed.sort_by_key(|(pos, _)| !*pos);
            f.loops = keyed.into_iter().map(|x| x.1).collect();
        }
        // Interior points; loops in the caller's input indices.
        for (g, f) in out.iter_mut().enumerate() {
            let mut pts = self.interior_points(g);
            if !pts.is_empty() {
                f.interior_uv = Some(pts.remove(0));
            }
            f.more_uv = pts;
            for l in &mut f.loops {
                for x in l.iter_mut() {
                    x.0 = self.orig[x.0];
                }
            }
        }
        Ok(out)
    }

    /// The input half-edge following `(input, dir)` in its loop.
    fn next_input(
        &self,
        pieces_of: &[Vec<usize>],
        hgroup: &[[Option<usize>; 2]],
        input: usize,
        dir: usize,
        g: usize,
    ) -> Result<(usize, usize), BooleanError> {
        let ps = &pieces_of[input];
        let last = if dir == 0 {
            *ps.last().expect("pieces")
        } else {
            ps[0]
        };
        let h = 2 * last + dir;
        let end_node = if dir == 0 {
            self.pieces[last].n1
        } else {
            self.pieces[last].n0
        };
        let node = self.nodes[end_node];
        if !node.singular {
            let x = self.next[h];
            let p = &self.pieces[x / 2];
            let Geo::Real { input: ni, .. } = p.geo else {
                return Err(err("loop continues along a virtual edge at a vertex"));
            };
            let nd = x % 2;
            // It must be the first piece of that input in direction nd.
            let first = if nd == 0 {
                pieces_of[ni][0]
            } else {
                *pieces_of[ni].last().expect("pieces")
            };
            if first != x / 2 {
                return Err(err("loop continues in the middle of an edge"));
            }
            return Ok((ni, nd));
        }
        // Singular vertex: nearest outgoing half-edge of the same face along the line.
        let v = node.vertex.expect("vertex node");
        let bottom = self.frame.singular[0]
            && (node.pos.y - self.frame.y_range.0).abs()
                <= (node.pos.y - self.frame.y_range.1).abs();
        let p_u = self.frame.per[0].unwrap_or(math::TAU);
        let u_in = node.pos.x;
        let mut best: Option<(f64, usize, usize)> = None;
        for (ci, inp) in self.inputs.iter().enumerate() {
            for (cd, &hg) in hgroup[ci].iter().enumerate() {
                if hg != Some(g) {
                    continue;
                }
                let starts = if cd == 0 { inp.start } else { inp.end };
                if starts != Some(v) {
                    continue;
                }
                let first = if cd == 0 {
                    pieces_of[ci][0]
                } else {
                    *pieces_of[ci].last().expect("pieces")
                };
                let n0 = if cd == 0 {
                    self.pieces[first].n0
                } else {
                    self.pieces[first].n1
                };
                let u_out = self.nodes[n0].pos.x;
                // Region above the line (bottom): move +X; below (top): move −X.
                let du = if bottom {
                    math::rem_euclid(u_out - u_in, p_u)
                } else {
                    math::rem_euclid(u_in - u_out, p_u)
                };
                let du = if du == 0.0 && (ci, cd) == (input, dir ^ 1) {
                    p_u
                } else {
                    du
                };
                if best.is_none_or(|b| du < b.0) {
                    best = Some((du, ci, cd));
                }
            }
        }
        best.map(|b| (b.1, b.2))
            .ok_or_else(|| err("no outgoing edge at a singular vertex"))
    }

    /// Signed area of a loop of inputs (continuous lift of its pcurves).
    fn loop_area(&self, lp: &[(usize, bool)]) -> f64 {
        let sigma = self.frame.sigma;
        let mut a = 0.0;
        let mut offset = Vec2::zero();
        let mut prev_end: Option<Point2> = None;
        for &(ii, fwd) in lp {
            let inp = &self.inputs[ii];
            let (t0, t1) = if fwd {
                inp.range
            } else {
                (inp.range.1, inp.range.0)
            };
            let start = {
                let q = inp.pcurve.eval(t0);
                Point2::new(q.x, sigma * q.y)
            };
            if let Some(pe) = prev_end {
                // Whole-period shift so the loop is continuous.
                let d = pe - (start + offset);
                let mut s = offset;
                if let Some(p) = self.frame.per[0] {
                    s.x += (d.x / p).round() * p;
                }
                if let Some(p) = self.frame.per[1] {
                    s.y += (d.y / p).round() * p;
                }
                offset = s;
            }
            let sgn = if fwd { 1.0 } else { -1.0 };
            for (s0, s1) in spans_of(&inp.pcurve, inp.range.0, inp.range.1) {
                let (m, r) = (0.5 * (s0 + s1), 0.5 * (s1 - s0));
                for &(x, w) in &GL8 {
                    let s = m + r * x;
                    let q = inp.pcurve.eval(s);
                    let q = Point2::new(q.x, sigma * q.y) + offset;
                    let d = inp.pcurve.d1(s);
                    let d = Vec2::new(d.x, sigma * d.y);
                    a += sgn * w * r * 0.5 * (q.x * d.y - q.y * d.x);
                }
            }
            let e = inp.pcurve.eval(t1);
            prev_end = Some(Point2::new(e.x, sigma * e.y) + offset);
        }
        a
    }

    /// Parameter points inside output face `g`, away from its boundary, best first: the
    /// middle between a long boundary piece and the next crossing along its inward normal,
    /// then other fractions of that distance (a middle can land on a curve the face does
    /// not contain, such as a tangent contact line of the other operand).
    fn interior_points(&self, g: usize) -> Vec<Point2> {
        // Candidates: offsets to the left of the longest real half-edges of the group.
        let mut cands: Vec<(f64, usize)> = Vec::new();
        for h in 0..self.region_of.len() {
            let r = self.region_of[h];
            if r == UNBOUNDED || self.group[r] != g {
                continue;
            }
            let p = &self.pieces[h / 2];
            if !matches!(p.kind, Kind::Real) {
                continue;
            }
            // Size of the piece in the chart (its sample box; a closed piece has no chord).
            let mut lo = Point2::new(f64::INFINITY, f64::INFINITY);
            let mut hi = Point2::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
            for (s0, s1) in self.piece_spans(p) {
                for i in 0..=8 {
                    let q = self.piece_point(p, s0 + (s1 - s0) * i as f64 / 8.0);
                    lo = lo.min_components2(q);
                    hi = hi.max_components2(q);
                }
            }
            cands.push((hi.distance(lo), h));
        }
        cands.sort_by(|x, y| y.0.total_cmp(&x.0).then(x.1.cmp(&y.1)));
        // Faces bounded only by virtual pieces (loopless): any region point.
        if cands.is_empty() {
            if !(0..self.region_area.len()).any(|r| self.group[r] == g) {
                return Vec::new();
            }
            let (x, y) = (
                0.5 * (self.frame.x_range.0 + self.frame.x_range.1),
                0.5 * (self.frame.y_range.0 + self.frame.y_range.1),
            );
            let y2 = self.frame.y_range.0 + 0.3172 * (self.frame.y_range.1 - self.frame.y_range.0);
            return vec![
                Point2::new(x, self.frame.sigma * y),
                Point2::new(x, self.frame.sigma * y2),
            ];
        }
        // For the longest pieces: the point halfway between the piece's middle and the
        // nearest boundary crossing along its inward normal; the most central one wins.
        let mut found: Vec<(f64, Point2)> = Vec::new();
        for &(size, h) in cands.iter().take(8) {
            let p = &self.pieces[h / 2];
            let (a, b) = Self::piece_range(p);
            let m = 0.5 * (a + b);
            let q = self.piece_point(p, m);
            let d = self.piece_der(p, m) * if h % 2 == 0 { 1.0 } else { -1.0 };
            let Some(n) = d.perp().normalize() else {
                continue;
            };
            // The start piece is not skipped (a closed piece is crossed again on its far
            // side); only crossings beyond a tiny offset count.
            let reach = self
                .ray_distance(q, n, usize::MAX)
                .unwrap_or(size)
                .min(size.max(1e-9));
            // Score: distance to the nearer of the two crossings.
            for (fi, frac) in [0.5, 0.3172, 0.6828, 0.1618].into_iter().enumerate() {
                let x = q + n * (frac * reach);
                if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() && fi == 0 {
                    eprintln!(
                        "interior cand g {g} h {h} q {q:?} n {n:?} size {size} reach {reach} x {x:?} -> {:?} (group {:?})",
                        self.locate_chart(x),
                        self.locate_chart(x).map(|r| if r == UNBOUNDED {
                            usize::MAX
                        } else {
                            self.group[r]
                        })
                    );
                }
                if self
                    .locate_chart(x)
                    .is_some_and(|r| r != UNBOUNDED && self.group[r] == g)
                {
                    let score = reach * frac.min(1.0 - frac);
                    found.push((score, Point2::new(x.x, self.frame.sigma * x.y)));
                }
            }
        }
        // Best first; ties keep the candidate order (deterministic).
        found.sort_by(|a, b| b.0.total_cmp(&a.0));
        found.into_iter().map(|x| x.1).collect()
    }

    /// Distance from `q` along the unit direction `n` to the nearest crossing with any
    /// piece other than `skip` (and beyond a tiny start offset); `None` if nothing is hit.
    fn ray_distance(&self, q: Point2, n: Vec2, skip: usize) -> Option<f64> {
        let eps = 1e-9 * self.scale;
        let side = |x: Point2| n.perp_dot(x - q);
        let mut best: Option<f64> = None;
        for (pi, p) in self.pieces.iter().enumerate() {
            if pi == skip {
                continue;
            }
            for (s0, s1) in self.piece_spans(p) {
                let k = SPAN_SAMPLES;
                let mut sa = s0;
                let mut fa = side(self.piece_point(p, sa));
                let touch = 1e-12 * self.scale;
                for i in 0..=k {
                    // Samples on the ray's line (collinear pieces, touching ends) count too.
                    let sx = if i == k {
                        s1
                    } else {
                        s0 + (s1 - s0) * i as f64 / k as f64
                    };
                    let x = self.piece_point(p, sx);
                    let t = (x - q).dot(n);
                    if side(x).abs() <= touch && t > eps && best.is_none_or(|b| t < b) {
                        best = Some(t);
                    }
                }
                for i in 1..=k {
                    let sb = if i == k {
                        s1
                    } else {
                        s0 + (s1 - s0) * i as f64 / k as f64
                    };
                    let fb = side(self.piece_point(p, sb));
                    if (fa < 0.0 && fb > 0.0) || (fa > 0.0 && fb < 0.0) {
                        let (mut lo, mut hi, mut flo) = (sa, sb, fa);
                        for _ in 0..80 {
                            let mid = 0.5 * (lo + hi);
                            let fm = side(self.piece_point(p, mid));
                            if (fm <= 0.0) == (flo <= 0.0) {
                                lo = mid;
                                flo = fm;
                            } else {
                                hi = mid;
                            }
                        }
                        let c = self.piece_point(p, 0.5 * (lo + hi));
                        let t = (c - q).dot(n);
                        if t > eps && best.is_none_or(|b| t < b) {
                            best = Some(t);
                        }
                    }
                    sa = sb;
                    fa = fb;
                }
            }
        }
        best
    }

    /// Region containing chart point `x` (`UNBOUNDED` outside the frame); `None` if the
    /// point location is ambiguous in every ray direction.
    fn locate_chart(&self, x: Point2) -> Option<usize> {
        // Periodic coordinates wrap into the window.
        // A point on a cut line lies on the window's edge, where rays leaving the window
        // cross nothing: move it just inside. The cut is no boundary of the face, and a point
        // on a real curve crossing the cut is found on the boundary in 3D by the callers.
        let wrap = |v: f64, c: f64, p: f64| {
            let d = 1e-9 * p;
            (c + math::rem_euclid(v - c, p)).clamp(c + d, c + p - d)
        };
        let mut x = x;
        if let (Some(c), Some(p)) = (self.frame.cut[0], self.frame.per[0]) {
            x.x = wrap(x.x, c, p);
        }
        if let (Some(c), Some(p)) = (self.frame.cut[1], self.frame.per[1]) {
            x.y = wrap(x.y, c, p);
        }
        // Outside the window (beyond a frame or a singular line): outside the face.
        let (xr, yr) = (self.frame.x_range, self.frame.y_range);
        // A point on a margin frame is outside the face (the frame lies beyond every curve);
        // on a singular line it is the apex or pole, outside the face's open domain.
        if (self.frame.per[0].is_none() && !(x.x > xr.0 && x.x < xr.1))
            || (self.frame.per[1].is_none() && !(x.y > yr.0 && x.y < yr.1))
        {
            return Some(UNBOUNDED);
        }
        for dir in [4usize, 5, 6, 7, 8, 9, 10, 11, 1, 3, 0, 2] {
            if let Some(h) = self.ray_hit(x, dir, None, &[]) {
                return Some(self.region_of[h]);
            }
        }
        None
    }

    /// Wrap parameters into the chart window.
    fn to_chart(&self, uv: Point2) -> Point2 {
        let mut x = uv.x;
        let mut y = self.frame.sigma * uv.y;
        if let (Some(c), Some(p)) = (self.frame.cut[0], self.frame.per[0]) {
            x = c + math::rem_euclid(x - c, p);
        }
        if let (Some(c), Some(p)) = (self.frame.cut[1], self.frame.per[1]) {
            y = c + math::rem_euclid(y - c, p);
        }
        Point2::new(x, y)
    }

    /// Point-in-face for parameters `uv`: `Some(true)` inside (in some output face),
    /// `Some(false)` outside, `None` if undecidable (on or extremely near the boundary).
    /// Callers detect "on the boundary" in 3D first.
    pub fn contains(&self, uv: Point2) -> Option<bool> {
        let x = self.to_chart(uv);
        // Beyond a singular frame line: outside the surface's parameter range.
        let r = self.locate_chart(x)?;
        Some(r != UNBOUNDED && self.status.get(r).copied().flatten() == Some(true))
    }

    /// Output face containing `uv`, if any.
    pub fn face_at(&self, uv: Point2) -> Option<usize> {
        let x = self.to_chart(uv);
        let r = self.locate_chart(x)?;
        if r == UNBOUNDED || self.group[r] == usize::MAX {
            None
        } else {
            Some(self.group[r])
        }
    }

    /// Output faces just off the singular line `v = vs` of the surface (a cone apex or a
    /// sphere pole) where it bounds the chart window: eight samples around the line at
    /// parameter distance `dv` from it, each `Some(Some(group))` inside an output face,
    /// `Some(None)` outside the face, `None` if undecidable. `None` if that line does not
    /// bound the window (the face does not reach the singular point).
    ///
    /// The singular point is a single 3D point but a whole line of parameters, outside the
    /// window's open domain, so point location there has to look around it.
    pub fn around_singular(&self, vs: f64, dv: f64) -> Option<Vec<Option<Option<usize>>>> {
        let (Some(c), Some(p)) = (self.frame.cut[0], self.frame.per[0]) else {
            return None;
        };
        let y = self.frame.sigma * vs;
        let (y0, y1) = self.frame.y_range;
        let eps = 1e-9 * self.scale;
        let (yl, side) = if self.frame.singular[0] && (y - y0).abs() <= eps {
            (y0, 1.0)
        } else if self.frame.singular[1] && (y - y1).abs() <= eps {
            (y1, -1.0)
        } else {
            return None;
        };
        let d = dv.min(0.25 * (y1 - y0));
        Some(
            (0..8)
                .map(|k| {
                    let x = c + (k as f64 + 0.5) / 8.0 * p;
                    self.locate_chart(Point2::new(x, yl + side * d)).map(|r| {
                        if r == UNBOUNDED || self.group[r] == usize::MAX {
                            None
                        } else {
                            Some(self.group[r])
                        }
                    })
                })
                .collect(),
        )
    }

    /// The parameter box of the inside regions: `(u range, v range)`; periodic ranges are
    /// at most one period wide (a full period when a face crosses the cut).
    pub fn uv_box(&self) -> ((f64, f64), (f64, f64)) {
        let mut lo = Point2::new(f64::INFINITY, f64::INFINITY);
        let mut hi = Point2::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
        let mut crosses = [false, false];
        for h in 0..self.region_of.len() {
            let r = self.region_of[h];
            if r == UNBOUNDED || self.status[r] != Some(true) {
                continue;
            }
            let p = &self.pieces[h / 2];
            if let Kind::Cut { axis, .. } = p.kind {
                crosses[axis] = true;
            }
            // Certified: interval enclosures of the piece over sub-intervals.
            for (s0, s1) in self.piece_spans(p) {
                let n = SPAN_SAMPLES;
                for i in 0..n {
                    let a = s0 + (s1 - s0) * i as f64 / n as f64;
                    let b = if i + 1 == n {
                        s1
                    } else {
                        s0 + (s1 - s0) * (i + 1) as f64 / n as f64
                    };
                    let (qlo, qhi) = self.piece_enclosure(p, a, b);
                    lo = lo.min_components2(qlo);
                    hi = hi.max_components2(qhi);
                }
            }
        }
        if !lo.x.is_finite() {
            // Loopless: the whole window.
            lo = Point2::new(self.frame.x_range.0, self.frame.y_range.0);
            hi = Point2::new(self.frame.x_range.1, self.frame.y_range.1);
            crosses = [self.frame.per[0].is_some(), self.frame.per[1].is_some()];
        }
        // Sampling may miss extrema slightly; pad.
        let pad = 1e-6 * self.scale;
        let mut u = (lo.x - pad, hi.x + pad);
        let mut y = (lo.y - pad, hi.y + pad);
        if let (Some(c), Some(p)) = (self.frame.cut[0], self.frame.per[0])
            && (crosses[0] || u.1 - u.0 >= p)
        {
            u = (c, c + p);
        }
        if let (Some(c), Some(p)) = (self.frame.cut[1], self.frame.per[1])
            && (crosses[1] || y.1 - y.0 >= p)
        {
            y = (c, c + p);
        }
        // Singular frames are exact limits.
        if self.frame.singular[0] {
            y.0 = y.0.max(self.frame.y_range.0);
        }
        if self.frame.singular[1] {
            y.1 = y.1.min(self.frame.y_range.1);
        }
        let v = if self.frame.sigma > 0.0 {
            (y.0, y.1)
        } else {
            (-y.1, -y.0)
        };
        // Sphere latitude stays in its natural range.
        let v = match &self.surface {
            Surface::Sphere(_) => (v.0.max(-math::FRAC_PI_2), v.1.min(math::FRAC_PI_2)),
            _ => v,
        };
        (u, v)
    }
}

/// Component-wise min/max for 2D points.
trait MinMax2 {
    fn min_components2(self, o: Self) -> Self;
    fn max_components2(self, o: Self) -> Self;
}

impl MinMax2 for Point2 {
    fn min_components2(self, o: Self) -> Self {
        Point2::new(self.x.min(o.x), self.y.min(o.y))
    }
    fn max_components2(self, o: Self) -> Self {
        Point2::new(self.x.max(o.x), self.y.max(o.y))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::geom::{Circle2, Cone, Cylinder, Line2, NurbsCurve2, Plane, Sphere};
    use forge_core::linalg::Frame as F3;

    fn seg(a: [f64; 2], b: [f64; 2]) -> (Curve2, (f64, f64)) {
        let (a, b) = (Point2::from(a), Point2::from(b));
        (
            Line2::through(a, b).expect("l").into(),
            (0.0, a.distance(b)),
        )
    }

    fn input(c: (Curve2, (f64, f64)), s: usize, e: usize, use_: Use) -> Input {
        Input {
            pcurve: c.0,
            range: c.1,
            start: Some(s),
            end: Some(e),
            use_,
        }
    }

    /// Unit square split by its diagonal: two triangles.
    #[test]
    fn square_split_by_a_diagonal_gives_two_faces() {
        let pl: Surface = Plane::new(F3::world()).into();
        let b = Use::Boundary(true);
        let inputs = vec![
            input(seg([0.0, 0.0], [1.0, 0.0]), 0, 1, b),
            input(seg([1.0, 0.0], [1.0, 1.0]), 1, 2, b),
            input(seg([1.0, 1.0], [0.0, 1.0]), 2, 3, b),
            input(seg([0.0, 1.0], [0.0, 0.0]), 3, 0, b),
            input(seg([0.0, 0.0], [1.0, 1.0]), 0, 2, Use::Interior),
        ];
        let ch = Chart::build(&pl, true, inputs).expect("chart");
        let faces = ch.faces().expect("faces");
        assert_eq!(faces.len(), 2);
        for f in &faces {
            assert_eq!(f.loops.len(), 1);
            assert_eq!(f.loops[0].len(), 3);
            let p = f.interior_uv.expect("interior");
            assert!(ch.contains(p) == Some(true));
        }
        assert_eq!(ch.contains(Point2::new(0.7, 0.2)), Some(true));
        assert_eq!(ch.contains(Point2::new(1.5, 0.2)), Some(false));
        assert_ne!(
            ch.face_at(Point2::new(0.7, 0.2)),
            ch.face_at(Point2::new(0.2, 0.7))
        );
    }

    /// A reversed face (sense false): loops run clockwise in (u, v).
    #[test]
    fn reversed_planar_face_with_a_hole() {
        let pl: Surface = Plane::new(F3::world()).into();
        let b = Use::Boundary(false);
        let circle: Curve2 = Circle2::new(Point2::new(0.5, 0.5), 0.2).expect("c").into();
        let inputs = vec![
            input(seg([0.0, 0.0], [1.0, 0.0]), 0, 1, b),
            input(seg([1.0, 0.0], [1.0, 1.0]), 1, 2, b),
            input(seg([1.0, 1.0], [0.0, 1.0]), 2, 3, b),
            input(seg([0.0, 1.0], [0.0, 0.0]), 3, 0, b),
            Input {
                pcurve: circle,
                range: (0.0, math::TAU),
                start: None,
                end: None,
                use_: Use::Boundary(true),
            },
        ];
        let ch = Chart::build(&pl, false, inputs).expect("chart");
        let faces = ch.faces().expect("faces");
        assert_eq!(faces.len(), 1);
        assert_eq!(faces[0].loops.len(), 2);
        assert_eq!(ch.contains(Point2::new(0.1, 0.1)), Some(true));
        assert_eq!(ch.contains(Point2::new(0.5, 0.5)), Some(false));
    }

    fn ring_u(v: f64, forward: bool) -> Input {
        Input {
            pcurve: Line2::new(Point2::new(0.0, v), Vec2::unit_x())
                .expect("l")
                .into(),
            range: (0.0, math::TAU),
            start: None,
            end: None,
            use_: Use::Boundary(forward),
        }
    }

    /// A full cylinder band (two rings) split by a third ring: two bands.
    #[test]
    fn cylinder_band_split_by_a_ring() {
        let cyl: Surface = Cylinder::new(F3::world(), 1.0).expect("c").into();
        let mut mid = ring_u(1.0, true);
        mid.use_ = Use::Interior;
        let inputs = vec![ring_u(0.0, true), ring_u(2.0, false), mid];
        let ch = Chart::build(&cyl, true, inputs).expect("chart");
        let faces = ch.faces().expect("faces");
        assert_eq!(faces.len(), 2, "{faces:?}");
        for f in &faces {
            assert_eq!(f.loops.len(), 2);
        }
        assert_eq!(ch.contains(Point2::new(3.0, 0.5)), Some(true));
        assert_eq!(ch.contains(Point2::new(-3.0, 2.5)), Some(false));
        let ((u0, u1), (v0, v1)) = ch.uv_box();
        assert!((u1 - u0 - math::TAU).abs() < 1e-12);
        assert!(v0 < 1e-5 && v0 > -1e-4 && (v1 - 2.0).abs() < 1e-4);
    }

    /// A cylinder band with a contractible hole (a circle pcurve) and a vertical slit
    /// line: the slit splits nothing (it does not separate), so one face.
    #[test]
    fn cylinder_band_with_a_hole() {
        let cyl: Surface = Cylinder::new(F3::world(), 1.0).expect("c").into();
        let hole: Curve2 = Circle2::new(Point2::new(1.0, 1.0), 0.3).expect("c").into();
        let inputs = vec![
            ring_u(0.0, true),
            ring_u(2.0, false),
            Input {
                pcurve: hole,
                range: (0.0, math::TAU),
                start: None,
                end: None,
                use_: Use::Boundary(false),
            },
        ];
        let ch = Chart::build(&cyl, true, inputs).expect("chart");
        let faces = ch.faces().expect("faces");
        assert_eq!(faces.len(), 1);
        assert_eq!(faces[0].loops.len(), 3);
        assert_eq!(ch.contains(Point2::new(1.0, 1.0)), Some(false));
        assert_eq!(ch.contains(Point2::new(1.0 + math::TAU, 1.5)), Some(true));
    }

    /// Points exactly on the cut line (the window's edge, `u` wrapped to the cut) are
    /// located like any other: the cut is no boundary.
    #[test]
    fn points_on_the_cut_line_are_inside_a_band() {
        let cyl: Surface = Cylinder::new(F3::world(), 1.0).expect("c").into();
        let ch =
            Chart::build(&cyl, true, vec![ring_u(0.0, true), ring_u(2.0, false)]).expect("chart");
        let c = ch.frame.cut[0].expect("cut");
        for u in [c, c + math::TAU, c - math::TAU, c + 3.0 * math::TAU] {
            assert_eq!(ch.contains(Point2::new(u, 1.5)), Some(true), "u {u}");
            assert_eq!(ch.contains(Point2::new(u, 2.5)), Some(false), "u {u}");
        }
    }

    /// An interior curve that separates nothing is no face boundary: a slit inside a
    /// square (a tangent contact line), and a generator across a cylinder band (its two
    /// sides are one face, glued across the cut). Both are dropped and reported.
    #[test]
    fn interior_curves_that_separate_nothing_are_dropped() {
        let pl: Surface = Plane::new(F3::world()).into();
        let b = Use::Boundary(true);
        let inputs = vec![
            input(seg([0.0, 0.0], [1.0, 0.0]), 0, 1, b),
            input(seg([1.0, 0.0], [1.0, 1.0]), 1, 2, b),
            input(seg([1.0, 1.0], [0.0, 1.0]), 2, 3, b),
            input(seg([0.0, 1.0], [0.0, 0.0]), 3, 0, b),
            // From the boundary into the interior, and wholly inside.
            input(seg([0.5, 0.0], [0.5, 0.6]), 4, 5, Use::Interior),
            input(seg([0.2, 0.8], [0.8, 0.8]), 6, 7, Use::Interior),
        ];
        let ch = Chart::build(&pl, true, inputs).expect("chart");
        assert_eq!(ch.dropped(), &[4, 5]);
        let faces = ch.faces().expect("faces");
        assert_eq!(faces.len(), 1);
        assert_eq!(faces[0].loops.len(), 1);
        assert_eq!(faces[0].loops[0].len(), 4);
        assert!(faces[0].loops[0].iter().all(|&(i, _)| i < 4));
        let p = faces[0].interior_uv.expect("interior");
        assert_eq!(ch.contains(p), Some(true));

        let cyl: Surface = Cylinder::new(F3::world(), 1.0).expect("c").into();
        let gen_line: Curve2 = NurbsCurve2::new(
            1,
            vec![0.0, 0.0, 2.0, 2.0],
            vec![[1.0, 0.0], [1.0, 2.0]],
            None,
        )
        .expect("n")
        .into();
        let arc = |v: f64, t0: f64, t1: f64, s: usize, e: usize, fwd: bool| Input {
            pcurve: Line2::new(Point2::new(0.0, v), Vec2::unit_x())
                .expect("l")
                .into(),
            range: (t0, t1),
            start: Some(s),
            end: Some(e),
            use_: Use::Boundary(fwd),
        };
        let inputs = vec![
            arc(0.0, 1.0, 1.0 + math::TAU, 0, 0, true),
            arc(2.0, 1.0, 1.0 + math::TAU, 1, 1, false),
            Input {
                pcurve: gen_line,
                range: (0.0, 2.0),
                start: Some(0),
                end: Some(1),
                use_: Use::Interior,
            },
        ];
        let ch = Chart::build(&cyl, true, inputs).expect("chart");
        assert_eq!(ch.dropped(), &[2]);
        let faces = ch.faces().expect("faces");
        assert_eq!(faces.len(), 1);
        assert_eq!(faces[0].loops.len(), 2);
        assert_eq!(ch.contains(Point2::new(1.5, 1.0)), Some(true));
    }

    /// A cylinder band cut by two vertical lines into two patches.
    #[test]
    fn cylinder_band_cut_by_two_generators() {
        let cyl: Surface = Cylinder::new(F3::world(), 1.0).expect("c").into();
        let line = |u: f64| -> Curve2 {
            NurbsCurve2::new(1, vec![0.0, 0.0, 2.0, 2.0], vec![[u, 0.0], [u, 2.0]], None)
                .expect("n")
                .into()
        };
        // Bottom ring split at u = 1 and u = 4 into two arcs; top ring likewise.
        let arc = |v: f64, _a: f64, _b: f64| -> Curve2 {
            Line2::new(Point2::new(0.0, v), Vec2::unit_x())
                .expect("l")
                .into()
        };
        let inputs = vec![
            Input {
                pcurve: arc(0.0, 1.0, 4.0),
                range: (1.0, 4.0),
                start: Some(0),
                end: Some(1),
                use_: Use::Boundary(true),
            },
            Input {
                pcurve: arc(0.0, 4.0, 1.0 + math::TAU),
                range: (4.0, 1.0 + math::TAU),
                start: Some(1),
                end: Some(0),
                use_: Use::Boundary(true),
            },
            Input {
                pcurve: arc(2.0, 1.0, 4.0),
                range: (1.0, 4.0),
                start: Some(2),
                end: Some(3),
                use_: Use::Boundary(false),
            },
            Input {
                pcurve: arc(2.0, 4.0, 1.0 + math::TAU),
                range: (4.0, 1.0 + math::TAU),
                start: Some(3),
                end: Some(2),
                use_: Use::Boundary(false),
            },
            Input {
                pcurve: line(1.0),
                range: (0.0, 2.0),
                start: Some(0),
                end: Some(2),
                use_: Use::Interior,
            },
            Input {
                pcurve: line(4.0),
                range: (0.0, 2.0),
                start: Some(1),
                end: Some(3),
                use_: Use::Interior,
            },
        ];
        let ch = Chart::build(&cyl, true, inputs).expect("chart");
        let faces = ch.faces().expect("faces");
        assert_eq!(faces.len(), 2);
        for f in &faces {
            assert_eq!(f.loops.len(), 1);
            assert_eq!(f.loops[0].len(), 4, "{f:?}");
        }
    }

    /// A sphere face with one small contractible hole: the face contains both poles.
    #[test]
    fn sphere_with_a_hole_contains_the_poles() {
        let s: Surface = Sphere::new(F3::world(), 1.0).expect("s").into();
        let hole: Curve2 = Circle2::new(Point2::new(1.0, 0.2), 0.1).expect("c").into();
        let inputs = vec![Input {
            pcurve: hole,
            range: (0.0, math::TAU),
            start: None,
            end: None,
            use_: Use::Boundary(false),
        }];
        let ch = Chart::build(&s, true, inputs).expect("chart");
        let faces = ch.faces().expect("faces");
        assert_eq!(faces.len(), 1);
        assert_eq!(ch.contains(Point2::new(1.0, 0.2)), Some(false));
        assert_eq!(ch.contains(Point2::new(4.0, 1.5)), Some(true));
        assert_eq!(ch.contains(Point2::new(4.0, -1.5)), Some(true));
    }

    /// A cone cap (one ring, the apex inside): a single face reaching the apex.
    #[test]
    fn cone_cap_reaches_the_apex() {
        let k: Surface = Cone::new(F3::world(), 1.0, 0.5).expect("k").into();
        // Apex at v = −1/tan 0.5; the ring at v = 1, the face below it (towards the apex).
        let ch = Chart::build(&k, true, vec![ring_u(1.0, false)]).expect("chart");
        let faces = ch.faces().expect("faces");
        assert_eq!(faces.len(), 1);
        assert_eq!(ch.contains(Point2::new(2.0, 0.0)), Some(true));
        assert_eq!(ch.contains(Point2::new(2.0, 1.5)), Some(false));
        let (_, (v0, v1)) = ch.uv_box();
        let apex = -1.0 / math::tan(0.5);
        assert!((v0 - apex).abs() < 1e-9, "{v0} vs {apex}");
        assert!((v1 - 1.0).abs() < 1e-4);
    }

    /// Point location at a singular point (the parameters there are a whole line outside
    /// the window): the faces just off the line decide. The cone cap reaches its apex; the
    /// hemispheres of a split sphere each own one pole; a band away from the poles owns
    /// neither.
    #[test]
    fn faces_around_a_singular_line() {
        let k: Surface = Cone::new(F3::world(), 1.0, 0.5).expect("k").into();
        let apex = -1.0 / math::tan(0.5);
        let ch = Chart::build(&k, true, vec![ring_u(1.0, false)]).expect("chart");
        let around = ch
            .around_singular(apex, 1e-5)
            .expect("the apex bounds the window");
        assert_eq!(around.len(), 8);
        assert!(around.iter().all(|g| *g == Some(Some(0))), "{around:?}");
        // The apex is at the point itself, not in the window.
        assert_eq!(ch.contains(Point2::new(2.0, apex)), Some(false));
        let s: Surface = Sphere::new(F3::world(), 1.0).expect("s").into();
        let mut eq = ring_u(0.0, true);
        eq.use_ = Use::Interior;
        let ch = Chart::build(&s, true, vec![eq]).expect("chart");
        let north = ch
            .around_singular(math::FRAC_PI_2, 1e-5)
            .expect("north pole");
        let south = ch
            .around_singular(-math::FRAC_PI_2, 1e-5)
            .expect("south pole");
        let g = |v: &Vec<Option<Option<usize>>>| {
            assert!(v.iter().all(|x| *x == v[0]), "{v:?}");
            v[0].flatten()
        };
        assert!(g(&north).is_some() && g(&south).is_some());
        assert_ne!(g(&north), g(&south));
        assert_eq!(g(&north), ch.face_at(Point2::new(1.0, 0.5)));
        // A band between two parallels: both poles outside.
        let ch =
            Chart::build(&s, true, vec![ring_u(-0.5, true), ring_u(0.5, false)]).expect("chart");
        for vs in [math::FRAC_PI_2, -math::FRAC_PI_2] {
            match ch.around_singular(vs, 1e-5) {
                None => {}
                Some(v) => assert!(v.iter().all(|x| *x == Some(None)), "{vs}: {v:?}"),
            }
        }
    }

    /// A loopless sphere face split by an equator ring: two hemispheres.
    #[test]
    fn full_sphere_split_by_the_equator() {
        let s: Surface = Sphere::new(F3::world(), 1.0).expect("s").into();
        let mut eq = ring_u(0.0, true);
        eq.use_ = Use::Interior;
        let ch = Chart::build(&s, true, vec![eq]).expect("chart");
        let faces = ch.faces().expect("faces");
        assert_eq!(faces.len(), 2);
        assert_ne!(
            ch.face_at(Point2::new(1.0, 0.5)),
            ch.face_at(Point2::new(1.0, -0.5))
        );
    }
}

#[cfg(test)]
mod disk_tests {
    use super::*;
    use forge_core::geom::{Circle2, Plane};
    use forge_core::linalg::Frame as F3;

    /// A disk face on a reversed cap (sense false, pcurve counter-clockwise, used
    /// backwards): points outside the disk are outside.
    #[test]
    fn reversed_disk_classifies_outside_points() {
        let pl: Surface = Plane::new(F3::world()).into();
        for (sense, fwd) in [(false, false), (true, true)] {
            let c: Curve2 = Circle2::new(Point2::new(1.5, -0.5), 1.5).expect("c").into();
            let ch = Chart::build(
                &pl,
                sense,
                vec![Input {
                    pcurve: c,
                    range: (0.0, math::TAU),
                    start: None,
                    end: None,
                    use_: Use::Boundary(fwd),
                }],
            )
            .expect("chart");
            assert_eq!(
                ch.contains(Point2::new(4.0, -0.5)),
                Some(false),
                "sense {sense}"
            );
            assert_eq!(
                ch.contains(Point2::new(1.5, -0.5)),
                Some(true),
                "sense {sense}"
            );
            assert_eq!(
                ch.contains(Point2::new(-2.0, 3.0)),
                Some(false),
                "sense {sense}"
            );
        }
    }
}

#[cfg(test)]
mod tangent_tests {
    use super::*;
    use forge_core::geom::{Circle2, Line2, Plane};
    use forge_core::linalg::Frame as F3;

    fn seg(a: [f64; 2], b: [f64; 2], s: usize, e: usize, use_: Use) -> Input {
        let (a, b) = (Point2::from(a), Point2::from(b));
        Input {
            pcurve: Line2::through(a, b).expect("l").into(),
            range: (0.0, a.distance(b)),
            start: Some(s),
            end: Some(e),
            use_,
        }
    }

    /// A circle tangent to two sides of a rectangle, from inside: the arcs between the
    /// tangency points split the face into three faces.
    #[test]
    fn circle_tangent_to_two_sides_splits_the_rectangle() {
        let pl: Surface = Plane::new(F3::world()).into();
        let b = Use::Boundary(true);
        let c: Curve2 = Circle2::new(Point2::new(1.5, 3.5), 3.5).expect("c").into();
        // Vertices: 0 (0,0), 1 (1.5,0) tangency, 2 (5,0), 3 (5,3.5) tangency, 4 (5,4.5),
        // 5 (x_t,4.5) crossing, 6 (0,4.5), 7 (0,z_l) crossing.
        let xt = 1.5 + (12.25f64 - 1.0).sqrt();
        let zl = 3.5 - (12.25f64 - 2.25).sqrt();
        let ang = |x: f64, y: f64| math::atan2(y - 3.5, x - 1.5);
        let arc = |a0: f64, a1: f64, s: usize, e: usize| Input {
            pcurve: c.clone(),
            range: (a0, a1),
            start: Some(s),
            end: Some(e),
            use_: Use::Interior,
        };
        let a_t = ang(xt, 4.5);
        let a_3 = 0.0;
        let a_1 = -math::FRAC_PI_2;
        let a_l = ang(0.0, zl);
        let inputs = vec![
            seg([0.0, 0.0], [1.5, 0.0], 0, 1, b),
            seg([1.5, 0.0], [5.0, 0.0], 1, 2, b),
            seg([5.0, 0.0], [5.0, 3.5], 2, 3, b),
            seg([5.0, 3.5], [5.0, 4.5], 3, 4, b),
            seg([5.0, 4.5], [xt, 4.5], 4, 5, b),
            seg([xt, 4.5], [0.0, 4.5], 5, 6, b),
            seg([0.0, 4.5], [0.0, zl], 6, 7, b),
            seg([0.0, zl], [0.0, 0.0], 7, 0, b),
            arc(a_3, a_t, 3, 5),
            arc(a_1, a_3, 1, 3),
            arc(a_l, a_1, 7, 1),
        ];
        let ch = Chart::build(&pl, true, inputs).expect("chart");
        let faces = ch.faces().expect("faces");
        assert_eq!(faces.len(), 4, "{faces:?}");
    }
}
