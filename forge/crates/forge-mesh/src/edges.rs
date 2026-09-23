//! Edge discretization: every edge is sampled **once**, and both adjacent faces reuse
//! exactly these samples (the same mesh vertices), which makes the mesh watertight by
//! construction.
//!
//! # Sampling
//! 1. An initial partition from the curve type: a line needs only its endpoints; a
//!    circle gets the uniform angular step meeting the chordal, angular and length limits
//!    ([`Tol::circle_step`]); an ellipse starts from its major-radius circle; a B-spline
//!    starts from its knot spans (each split into `degree` pieces). Ring edges start at
//!    their range start (`t0`, deterministic) and get at least four samples.
//! 2. Adaptive bisection of every segment `[a, b]` until all of these hold:
//!    - curve chord: `|C(m) − (C(a)+C(b))/2| ≤ 0.74·δ`, tangent turn `≤ angular`,
//!      chord length `≤ max_edge_length`;
//!    - for **each adjacent face**: the parameter-space chord's midpoint, mapped through
//!      the surface, lies within `0.74·δ` of the 3D chord midpoint, and the surface
//!      normals at the ends differ by at most `angular`. This is exactly the test the
//!      face refinement applies to interior edges, so constrained boundary segments
//!      never need splitting later (and a straight edge whose pcurve is curved, or a
//!      straight edge across a twisted surface, is sampled finely enough).

use forge_core::geom::{Curve2, Curve3};
use forge_core::topo::Edge;

use crate::error::MeshError;
use crate::surf::{Sing, Surf, Tol, angle_between, mid2, virtual_pair};

/// Maximum bisection depth below the initial partition.
const MAX_DEPTH: u32 = 40;
/// Maximum samples per edge.
const MAX_EDGE_SAMPLES: usize = 1_000_000;

/// One face's view of an edge: its surface and the coedge pcurve (if any).
pub(crate) struct CoedgeView<'a> {
    pub surf: Surf<'a>,
    pub pcurve: Option<&'a Curve2>,
}

/// Initial parameter partition (sorted, including both ends).
fn initial_params(edge: &Edge, tol: &Tol) -> Vec<f64> {
    let (t0, t1) = edge.t_range;
    let span = t1 - t0;
    let uniform = |n: usize| -> Vec<f64> {
        let n = n.max(1);
        (0..=n)
            .map(|k| {
                if k == n {
                    t1
                } else {
                    t0 + span * (k as f64 / n as f64)
                }
            })
            .collect()
    };
    let min_n = if edge.is_ring() { 4 } else { 1 };
    match &edge.curve {
        Curve3::Line(_) => uniform(1),
        Curve3::Circle(c) => {
            let n = (span / tol.circle_step(c.radius())).ceil() as usize;
            uniform(n.max(min_n))
        }
        Curve3::Ellipse(e) => {
            let n = (span / tol.circle_step(e.rx().max(e.ry()))).ceil() as usize;
            uniform(n.max(min_n))
        }
        Curve3::BSpline(b) => {
            let mut brk = vec![t0];
            let mut last = t0;
            for &k in b.knots() {
                if k > last && k < t1 {
                    brk.push(k);
                    last = k;
                }
            }
            brk.push(t1);
            let pieces = b.degree().max(1);
            let mut out = vec![t0];
            for w in brk.windows(2) {
                for j in 1..=pieces {
                    out.push(if j == pieces {
                        w[1]
                    } else {
                        w[0] + (w[1] - w[0]) * (j as f64 / pieces as f64)
                    });
                }
            }
            if out.len() - 1 < min_n {
                uniform(min_n)
            } else {
                out
            }
        }
    }
}

struct Sampler<'a> {
    edge: &'a Edge,
    views: &'a [CoedgeView<'a>],
    tol: &'a Tol,
    out: Vec<f64>,
}

impl Sampler<'_> {
    fn ok(&self, a: f64, b: f64) -> bool {
        let c = &self.edge.curve;
        let m = 0.5 * (a + b);
        let [pa, da, _] = c.derivs2(a);
        let [pb, db, _] = c.derivs2(b);
        let pm = c.eval(m);
        let chord_mid = (pa + pb) * 0.5;
        let len = pa.distance(pb);
        if self
            .tol
            .badness(pm.distance(chord_mid), angle_between(da, db), len)
            > 1.0
        {
            return false;
        }
        for v in self.views {
            let uvm = v.surf.coedge_uv(v.pcurve, c, m, None);
            let uva = v.surf.coedge_uv(v.pcurve, c, a, Some(uvm));
            let uvb = v.surf.coedge_uv(v.pcurve, c, b, Some(uvm));
            let (sa, sb) = (v.surf.sing(uva), v.surf.sing(uvb));
            let (va, vb) = virtual_pair(uva, sa, uvb, sb);
            let dev = v.surf.eval(mid2(va, vb)).distance(chord_mid);
            let ang = match (v.surf.normal_param(va), v.surf.normal_param(vb)) {
                (Some(na), Some(nb)) if sa == Sing::No || sb == Sing::No => angle_between(na, nb),
                _ => 0.0,
            };
            if self.tol.badness(dev, ang, 0.0) > 1.0 {
                return false;
            }
        }
        true
    }

    fn refine(&mut self, a: f64, b: f64, depth: u32) -> Result<(), ()> {
        if self.out.len() > MAX_EDGE_SAMPLES {
            return Err(());
        }
        if self.ok(a, b) {
            self.out.push(b);
            return Ok(());
        }
        let m = 0.5 * (a + b);
        if depth >= MAX_DEPTH || !(m > a && m < b) {
            return Err(());
        }
        self.refine(a, m, depth + 1)?;
        self.refine(m, b, depth + 1)
    }
}

/// Sample parameters of an edge (sorted, `t0` first, `t1` last).
pub(crate) fn edge_params(
    edge: &Edge,
    views: &[CoedgeView<'_>],
    tol: &Tol,
    name: &str,
) -> Result<Vec<f64>, MeshError> {
    let init = initial_params(edge, tol);
    let mut s = Sampler {
        edge,
        views,
        tol,
        out: vec![init[0]],
    };
    for w in init.windows(2) {
        if s.refine(w[0], w[1], 0).is_err() {
            return Err(MeshError::EdgeRefinementLimit {
                edge: name.to_string(),
                samples: s.out.len(),
            });
        }
    }
    Ok(s.out)
}
