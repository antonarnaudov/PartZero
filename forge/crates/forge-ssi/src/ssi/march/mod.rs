//! General surface–surface intersection: certified subdivision, marching, fitting.
//!
//! # Formulation
//! One operand is the *search surface* `P` (parametric), the other the *implicit
//! surface* `Q` (its distance form `d_Q`). The intersection is the zero set of
//! `G(u, v) = d_Q(S_P(u, v))` in `P`'s parameter box, a plane curve; `|G|` is (an upper
//! bound of) the distance of `S_P(u, v)` to `Q`, so tolerances stay geometric. `P` is the
//! operand with the nicer parametrization (plane > cylinder > ring torus > cone >
//! sphere > horn/spindle torus), preferring the one whose parametric singularities stay
//! off the other surface.
//!
//! # Completeness certificate
//! `P`'s box is subdivided (quadtree, non-dyadic split ratios so symmetric curves do
//! not run along cell edges). With interval arithmetic every cell becomes
//! - **excluded** if the enclosure of `G` (natural extension ∩ mean-value form) misses
//!   0: certainly no intersection;
//! - **regular** if `∂G/∂u` or `∂G/∂v` is certainly non-zero on it: the zero set in the
//!   cell is a graph over one parameter, so it holds no closed loop and every piece of
//!   curve in it reaches the cell boundary. The boundary crossings are computed with
//!   the certified 1D root finder;
//! - **irregular** if neither holds at the resolution size: possible tangency,
//!   singularity or branch crossing. Adjacent irregular cells form *clusters*.
//!
//! Every crossing is a seed; the tracer visits crossings as it moves from cell to cell
//! and new traces start from unvisited ones until all are visited. Hence every curve
//! piece that meets a regular cell is traced. Clusters are resolved explicitly: a
//! cluster without branch ends is an isolated tangential contact (if the surfaces meet
//! there within `fit`) or is certified empty on a finer grid; a cluster with branch ends
//! is a singular vertex (branch crossing, tangency point, surface singularity) where the
//! branches are joined, or a pass-through of a shallow crossing. Anything else is an
//! `SSI_TANGENT_UNRESOLVED` error — never a silently dropped contact.

mod trace;

use forge_core::geom::Surface;
use forge_core::math;
use forge_core::scalar::{Dual, Interval, Scalar};
use forge_core::{Point2, Point3, Vec2, Vec3};

use crate::clip::Patch;
use crate::error::SsiError;
use crate::func::{Fn1, Fn2, dist, param_slack};
use crate::roots1d::{RootOpts, find_roots};
use crate::ssi::{Ctx, PreBranch, PreVertex, finalize, singular_points};
use crate::types::{IntersectionGraph, Method, SsiStats};

use trace::Assembled;

/// Non-dyadic split ratios (u and v differ so that no symmetric configuration puts a
/// curve exactly on both split lines).
const SPLIT_U: f64 = 0.4990234375;
const SPLIT_V: f64 = 0.5068359375;

/// `G(u, v) = d_Q(S_P(u, v))`.
pub(crate) struct GFn<'a> {
    pub p: &'a Surface,
    pub q: &'a Surface,
}

impl Fn2 for GFn<'_> {
    fn eval<S: Scalar>(&self, u: S, v: S) -> S {
        dist(self.q, self.p.eval(u, v))
    }
}

impl GFn<'_> {
    /// `(G, G_u, G_v)` in `f64`.
    pub fn grad(&self, uv: Point2) -> (f64, Vec2) {
        let du = self.eval(Dual::variable(uv.x), Dual::constant(uv.y));
        let dv = self.eval(Dual::constant(uv.x), Dual::variable(uv.y));
        (du.v, Vec2::new(du.d, dv.d))
    }
    /// Hessian `[[G_uu, G_uv], [G_uv, G_vv]]` (nested duals).
    pub fn hessian(&self, uv: Point2) -> [[f64; 2]; 2] {
        let e = |a: Vec2, b: Vec2| {
            let u = Dual::new(Dual::new(uv.x, a.x), Dual::new(b.x, 0.0));
            let v = Dual::new(Dual::new(uv.y, a.y), Dual::new(b.y, 0.0));
            self.eval(u, v).d.d
        };
        let (x, y) = (Vec2::unit_x(), Vec2::unit_y());
        let (uu, uvv, vv) = (e(x, x), e(x, y), e(y, y));
        [[uu, uvv], [uvv, vv]]
    }
}

/// Classification of a quadtree cell.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Class {
    Excluded,
    Regular,
    Irregular,
}

/// A leaf cell.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Cell {
    pub u: (f64, f64),
    pub v: (f64, f64),
    pub class: Class,
    /// 3D diameter bound.
    pub size: f64,
}

impl Cell {
    pub fn contains(&self, uv: Point2) -> bool {
        uv.x >= self.u.0 && uv.x <= self.u.1 && uv.y >= self.v.0 && uv.y <= self.v.1
    }
    pub fn centre(&self) -> Point2 {
        Point2::new(
            0.5 * self.u.0 + 0.5 * self.u.1,
            0.5 * self.v.0 + 0.5 * self.v.1,
        )
    }
}

/// Quadtree node.
#[derive(Clone, Debug)]
struct TreeNode {
    u: (f64, f64),
    v: (f64, f64),
    /// Children (2 or 4) or the leaf index.
    kids: Vec<usize>,
    leaf: Option<usize>,
}

/// A certified crossing of the curve with a regular cell's edge.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Crossing {
    pub uv: Point2,
    pub p: Point3,
    pub visited: bool,
}

/// A special point where the intersection may be singular: a parametric singularity of
/// `P` lying on `Q`, or a geometric singularity of `Q` lying on `P`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Special {
    pub p: Point3,
    /// A singular row `v = row` of `P` (all `u`), or a point `uv` of `P`.
    pub row: Option<f64>,
    pub uv: Point2,
}

/// Everything the tracer and the cluster resolution need.
pub(crate) struct March<'a> {
    pub ctx: &'a Ctx<'a>,
    pub p: Patch<'a>,
    pub q: Patch<'a>,
    /// `true` if `P` is operand `a`.
    pub p_is_a: bool,
    pub g: GFn<'a>,
    /// Effective length scale.
    pub len: f64,
    pub h_min: f64,
    pub h_max: f64,
    tree: Vec<TreeNode>,
    roots: Vec<usize>,
    pub cells: Vec<Cell>,
    pub crossings: Vec<Crossing>,
    /// Crossing indices per leaf.
    pub leaf_crossings: Vec<Vec<usize>>,
    pub specials: Vec<Special>,
    pub full_u: bool,
    pub full_v: bool,
    pub stats: SsiStats,
    /// Set when some region could not be certified (pass-through of a cluster).
    pub uncertified: bool,
}

fn rank(s: &Surface) -> u8 {
    match s {
        Surface::Plane(_) => 0,
        Surface::Cylinder(_) => 1,
        Surface::Torus(t) if t.minor() < t.major() => 2,
        Surface::Cone(_) => 3,
        Surface::Sphere(_) => 4,
        Surface::Torus(t) if t.spindle_patch().is_none() => 5,
        _ => 6,
    }
}

/// Characteristic radius of a surface (feature size); planes have none.
fn feature_radius(s: &Surface) -> f64 {
    match s {
        Surface::Plane(_) | Surface::BSpline(_) => f64::INFINITY,
        Surface::Cylinder(c) => c.radius(),
        Surface::Sphere(c) => c.radius(),
        Surface::Torus(t) => t.minor(),
        Surface::Cone(c) => c.radius().max(1.0),
    }
}

/// Entry point.
pub(crate) fn march(ctx: &Ctx<'_>) -> Result<IntersectionGraph, SsiError> {
    let (pa, pb) = (ctx.a, ctx.b);
    // Singular rows of each operand that lie on the other: prefer the search surface
    // without them.
    let bad = |p: &Patch<'_>, q: &Patch<'_>| {
        singular_points(p)
            .iter()
            .filter(|(x, _)| dist(q.surf, *x).abs() <= 1e-3 * ctx.scale)
            .count()
    };
    let (ba, bb) = (bad(&pa, &pb), bad(&pb, &pa));
    let a_first = if ba != bb {
        ba < bb
    } else {
        rank(pa.surf) <= rank(pb.surf)
    };
    let (p, q) = if a_first { (pa, pb) } else { (pb, pa) };
    let len = ctx
        .scale
        .min(20.0 * feature_radius(pa.surf).min(feature_radius(pb.surf)));
    let mut m = March {
        ctx,
        p,
        q,
        p_is_a: a_first,
        g: GFn {
            p: p.surf,
            q: q.surf,
        },
        len,
        h_min: ctx.tol.resolution * len,
        h_max: 0.25 * len,
        tree: Vec::new(),
        roots: Vec::new(),
        cells: Vec::new(),
        crossings: Vec::new(),
        leaf_crossings: Vec::new(),
        specials: Vec::new(),
        full_u: p.dom.full_u(p.surf),
        full_v: p.dom.full_v(p.surf),
        stats: SsiStats::default(),
        uncertified: false,
    };
    if let Some(g) = m.coincidence_check() {
        return Ok(g);
    }
    m.find_specials();
    m.subdivide()?;
    m.compute_crossings()?;
    let raw = trace::trace_all(&mut m)?;
    let clusters = m.clusters();
    let assembled = trace::resolve_clusters(&mut m, raw, &clusters)?;
    m.stats.crossings = m.crossings.len();
    assemble(&m, assembled)
}

impl<'a> March<'a> {
    /// All of `P`'s box lies on `Q` (sampled on a 9 × 9 grid): the surfaces coincide.
    fn coincidence_check(&self) -> Option<IntersectionGraph> {
        let n = 9;
        for i in 0..n {
            for j in 0..n {
                let u = self.p.dom.u.0
                    + (self.p.dom.u.1 - self.p.dom.u.0) * (i as f64 + 0.5) / n as f64;
                let v = self.p.dom.v.0
                    + (self.p.dom.v.1 - self.p.dom.v.0) * (j as f64 + 0.5) / n as f64;
                if self.g.eval(u, v).abs() > self.ctx.tol.fit {
                    return None;
                }
            }
        }
        let mut g = IntersectionGraph::empty(Method::Marching);
        g.coincidence = Some(crate::types::Coincidence {
            same_orientation: true,
            uv_map: None,
        });
        Some(g)
    }

    fn find_specials(&mut self) {
        let fit = self.ctx.tol.fit;
        // Singular rows of P lying on Q.
        for (x, row) in singular_points(&self.p) {
            if dist(self.q.surf, x).abs() <= 10.0 * fit {
                self.specials.push(Special {
                    p: x,
                    row: Some(row),
                    uv: Point2::new(crate::func::mid(self.p.dom.u), row),
                });
            }
        }
        // Geometric singular points of Q lying on P (inside P's box).
        let mut qs: Vec<Point3> = Vec::new();
        match self.q.surf {
            Surface::Cone(c) => qs.push(c.apex()),
            Surface::Torus(t) if t.minor() >= t.major() => {
                if t.spindle_patch().is_some() {
                    let (a, _) = t.spindle_v_range().expect("spindle");
                    qs.push(t.eval(0.0, a));
                    qs.push(t.eval(0.0, -a));
                } else {
                    qs.push(t.frame().origin());
                }
            }
            _ => {}
        }
        for x in qs {
            if dist(self.p.surf, x).abs() <= 10.0 * fit {
                let (u, v) = self.p.refs();
                let uv = crate::func::uv_near(self.p.surf, x, u, v);
                let slack = param_slack(self.p.surf, uv, 10.0 * fit);
                if self.p.dom.contains(self.p.surf, uv, slack) {
                    self.specials.push(Special {
                        p: x,
                        row: None,
                        uv,
                    });
                }
            }
        }
    }

    /// Does the cell touch a special point / row?
    fn touches_special(&self, u: (f64, f64), v: (f64, f64)) -> bool {
        self.specials.iter().any(|s| match s.row {
            Some(r) => r >= v.0 - 1e-12 && r <= v.1 + 1e-12,
            None => {
                let su = self.wrap_u_into(s.uv.x, u);
                su >= u.0 - 1e-12
                    && su <= u.1 + 1e-12
                    && s.uv.y >= v.0 - 1e-12
                    && s.uv.y <= v.1 + 1e-12
            }
        })
    }

    /// Bring a periodic `u` into the window starting at `range.0` (if `P` is periodic).
    pub fn wrap_u_into(&self, u: f64, range: (f64, f64)) -> f64 {
        if self.p.surf.periodicity().0.is_some() {
            let base = self.p.dom.u.0;
            let w = base + math::wrap_angle(u - base, 0.0);
            if w > range.1 && w - math::TAU >= range.0 - 1e-12 {
                return w - math::TAU;
            }
            w
        } else {
            u
        }
    }

    /// Wrap `uv` into the box for periodic directions that cover a full period.
    pub fn canonical(&self, uv: Point2) -> Point2 {
        let mut out = uv;
        if self.full_u {
            let b = self.p.dom.u.0;
            out.x = b + math::wrap_angle(uv.x - b, 0.0);
        }
        if self.full_v {
            let b = self.p.dom.v.0;
            out.y = b + math::wrap_angle(uv.y - b, 0.0);
        }
        out
    }

    /// Initial grid: angular parameters split into pieces of at most π/2.
    fn initial_cells(&self) -> Vec<((f64, f64), (f64, f64))> {
        let (pu, pv) = self.p.surf.periodicity();
        let angular_v =
            pv.is_some() || matches!(self.p.surf, Surface::Sphere(_) | Surface::Torus(_));
        let split = |r: (f64, f64), angular: bool| -> Vec<(f64, f64)> {
            if !angular {
                return vec![r];
            }
            let n = ((r.1 - r.0) / math::FRAC_PI_2).ceil().max(1.0) as usize;
            (0..n)
                .map(|i| {
                    let a = r.0 + (r.1 - r.0) * i as f64 / n as f64;
                    let b = if i + 1 == n {
                        r.1
                    } else {
                        r.0 + (r.1 - r.0) * (i + 1) as f64 / n as f64
                    };
                    (a, b)
                })
                .collect()
        };
        let us = split(self.p.dom.u, pu.is_some());
        let vs = split(self.p.dom.v, angular_v);
        let mut out = Vec::new();
        for &u in &us {
            for &v in &vs {
                out.push((u, v));
            }
        }
        out
    }

    /// Classify a cell: `(class or None = split, size, split_u, split_v)`.
    fn classify(&self, u: (f64, f64), v: (f64, f64)) -> (Option<Class>, f64, bool, bool) {
        let ui = Interval::new(u.0, u.1);
        let vi = Interval::new(v.0, v.1);
        // Cheap exclusion first: the natural interval extension alone.
        if !self.g.eval(ui, vi).contains_zero() {
            return (Some(Class::Excluded), 0.0, false, false);
        }
        let gu = self.g.eval(Dual::variable(ui), Dual::constant(vi));
        let gv = self.g.eval(Dual::constant(ui), Dual::variable(vi));
        let (cu, cv) = (0.5 * u.0 + 0.5 * u.1, 0.5 * v.0 + 0.5 * v.1);
        let gc = self.g.eval(Interval::point(cu), Interval::point(cv));
        let mv = gc + gu.d * (ui - Interval::point(cu)) + gv.d * (vi - Interval::point(cv));
        let nat = gu.v;
        let val = {
            let x = nat.intersect(mv);
            if x.is_empty() { nat } else { x }
        };
        // 3D extents along u and v.
        let d = self.p.surf.derivs1(ui, vi);
        let ext_u = d[1].norm().hi() * (u.1 - u.0);
        let ext_v = d[2].norm().hi() * (v.1 - v.0);
        let e = d[0];
        let size = Vec3::new(e.x.width(), e.y.width(), e.z.width()).norm();
        let (su, sv) = if ext_u > 2.0 * ext_v {
            (true, false)
        } else if ext_v > 2.0 * ext_u {
            (false, true)
        } else {
            (true, true)
        };
        if !val.contains_zero() {
            return (Some(Class::Excluded), size, su, sv);
        }
        if size > self.h_max {
            return (None, size, su, sv);
        }
        let special = self.touches_special(u, v);
        let mono = (gu.d.is_finite() && !gu.d.contains_zero())
            || (gv.d.is_finite() && !gv.d.contains_zero());
        // A cell on the seam of a full period is regular only if it is across the seam too
        // (see `across_seam`); its class is all that changes, never its size or split.
        let speed = (d[1].norm().hi(), d[2].norm().hi());
        let mono = mono
            && self.across_seam(u, v, speed).is_none_or(|(wu, wv)| {
                let a = self.g.eval(Dual::variable(wu), Dual::constant(wv));
                let b = self.g.eval(Dual::constant(wu), Dual::variable(wv));
                (a.d.is_finite() && !a.d.contains_zero())
                    || (b.d.is_finite() && !b.d.contains_zero())
            });
        if mono && !special {
            return (Some(Class::Regular), size, su, sv);
        }
        if size <= self.h_min {
            return (Some(Class::Irregular), size, su, sv);
        }
        (None, size, su, sv)
    }

    /// The intervals of a cell that touches the seam of a direction covering a full period,
    /// widened across the seam by one minimal cell; `None` for other cells.
    ///
    /// `u₀` and `u₀ + 2π` are one line of the surface, but each floating-point end may miss
    /// it by a few ulps, so a point exactly on the seam can lie just outside the closed cell
    /// at one end. A singular point of `G` there (two cylinders touching on the seam, boolean
    /// seed 53 #38/#387) then makes the cell at that end certified-regular: its seam edge
    /// yields a crossing *at* the singular point and traces run through the point without
    /// meeting the irregular cluster found at the other end. Requiring regularity across
    /// the seam makes both ends irregular there, one cluster across the seam (clusters
    /// wrap).
    ///
    /// The band is the rounding of the box's ends (8 ulps) or one minimal cell (`h_min` in
    /// 3D over the cell's parametric speed `speed`, at most the cell's own width), whichever
    /// is larger. A band of ulps alone left the same failure for a singular point just
    /// **inside** one end, 1e-14 to 1e-9 in `u` from the seam (a rotated scene, or a box
    /// whose start is not the tangent line's angle bit for bit): the cell across the seam
    /// was certified regular while the point sat an ulp-sized distance beyond its edge, so
    /// the crossing arms were traced there as separate regular pieces whose edge crossings
    /// nearly coincide (`SSI_TANGENT_UNRESOLVED` with an odd number of branch ends). Within
    /// one minimal cell of the seam the point is as good as on it: both ends are irregular
    /// and form one cluster.
    fn across_seam(
        &self,
        u: (f64, f64),
        v: (f64, f64),
        speed: (f64, f64),
    ) -> Option<(Interval, Interval)> {
        let widen = |r: (f64, f64), d: (f64, f64), full: bool, speed: f64| -> ((f64, f64), bool) {
            if !full {
                return (r, false);
            }
            // Cells inherit the box's end values exactly (bit for bit) from their parents.
            let (at_lo, at_hi) = (
                r.0.to_bits() == d.0.to_bits(),
                r.1.to_bits() == d.1.to_bits(),
            );
            if !(at_lo || at_hi) {
                return (r, false);
            }
            let rounding = 8.0 * f64::EPSILON * d.0.abs().max(d.1.abs()).max(1.0);
            let cell = if speed.is_finite() && speed > 0.0 {
                (self.h_min / speed).min(r.1 - r.0)
            } else {
                0.0
            };
            let e = rounding.max(cell);
            let lo = if at_lo { r.0 - e } else { r.0 };
            let hi = if at_hi { r.1 + e } else { r.1 };
            ((lo, hi), true)
        };
        let (wu, su) = widen(u, self.p.dom.u, self.full_u, speed.0);
        let (wv, sv) = widen(v, self.p.dom.v, self.full_v, speed.1);
        (su || sv).then(|| (Interval::new(wu.0, wu.1), Interval::new(wv.0, wv.1)))
    }

    fn subdivide(&mut self) -> Result<(), SsiError> {
        let budget = self.ctx.tol.max_cells;
        let init = self.initial_cells();
        let mut stack: Vec<(usize, u32)> = Vec::new();
        for (u, v) in init {
            self.tree.push(TreeNode {
                u,
                v,
                kids: Vec::new(),
                leaf: None,
            });
            self.roots.push(self.tree.len() - 1);
        }
        for &r in self.roots.iter().rev() {
            stack.push((r, 0));
        }
        while let Some((ni, depth)) = stack.pop() {
            self.stats.cells += 1;
            if self.stats.cells > budget {
                return Err(SsiError::BudgetExceeded {
                    what: "subdivision cells",
                    limit: budget,
                });
            }
            let (u, v) = (self.tree[ni].u, self.tree[ni].v);
            let (class, size, su, sv) = self.classify(u, v);
            let class = if class.is_none() && depth >= 60 {
                Some(Class::Irregular)
            } else {
                class
            };
            if let Some(c) = class {
                self.cells.push(Cell {
                    u,
                    v,
                    class: c,
                    size,
                });
                self.tree[ni].leaf = Some(self.cells.len() - 1);
                match c {
                    Class::Regular => self.stats.regular_cells += 1,
                    Class::Irregular => self.stats.irregular_cells += 1,
                    Class::Excluded => {}
                }
                continue;
            }
            let us = if su {
                let m = u.0 + (u.1 - u.0) * SPLIT_U;
                vec![(u.0, m), (m, u.1)]
            } else {
                vec![u]
            };
            let vs = if sv {
                let m = v.0 + (v.1 - v.0) * SPLIT_V;
                vec![(v.0, m), (m, v.1)]
            } else {
                vec![v]
            };
            let mut kids = Vec::new();
            for &cu in &us {
                for &cv in &vs {
                    self.tree.push(TreeNode {
                        u: cu,
                        v: cv,
                        kids: Vec::new(),
                        leaf: None,
                    });
                    kids.push(self.tree.len() - 1);
                }
            }
            for &k in kids.iter().rev() {
                stack.push((k, depth + 1));
            }
            self.tree[ni].kids = kids;
        }
        self.leaf_crossings = vec![Vec::new(); self.cells.len()];
        Ok(())
    }

    /// The leaf containing `uv` (after canonical wrapping); `None` outside the box.
    pub fn locate(&self, uv: Point2) -> Option<usize> {
        let uv = self.canonical(uv);
        let inside =
            |n: &TreeNode| uv.x >= n.u.0 && uv.x <= n.u.1 && uv.y >= n.v.0 && uv.y <= n.v.1;
        let mut cur = *self.roots.iter().find(|&&r| inside(&self.tree[r]))?;
        loop {
            let n = &self.tree[cur];
            if let Some(l) = n.leaf {
                return Some(l);
            }
            cur = *n.kids.iter().find(|&&k| inside(&self.tree[k]))?;
        }
    }

    /// Certified crossings of the curve with every regular leaf's four edges.
    fn compute_crossings(&mut self) -> Result<(), SsiError> {
        struct EdgeFn<'b> {
            g: &'b GFn<'b>,
            fixed: f64,
            along_u: bool,
        }
        impl Fn1 for EdgeFn<'_> {
            fn eval<S: Scalar>(&self, s: S) -> S {
                if self.along_u {
                    self.g.eval(s, S::from_f64(self.fixed))
                } else {
                    self.g.eval(S::from_f64(self.fixed), s)
                }
            }
        }
        let n = self.cells.len();
        for li in 0..n {
            let c = self.cells[li];
            if c.class != Class::Regular {
                continue;
            }
            let edges = [
                (c.v.0, true, c.u),
                (c.v.1, true, c.u),
                (c.u.0, false, c.v),
                (c.u.1, false, c.v),
            ];
            for (fixed, along_u, (a, b)) in edges {
                let f = EdgeFn {
                    g: &self.g,
                    fixed,
                    along_u,
                };
                let opts = RootOpts {
                    zero_tol: 1e-3 * self.ctx.tol.fit,
                    min_width: 1e-12 * (b - a).abs().max(1e-300),
                    flat_width: 0.25 * (b - a),
                    max_pieces: 20_000,
                };
                let r = find_roots(&f, a, b, &opts)?;
                let mut params: Vec<f64> = r.roots.iter().map(|x| x.t).collect();
                if !r.flats.is_empty() {
                    // The curve runs along the edge: treat the cell as irregular.
                    self.cells[li].class = Class::Irregular;
                    self.stats.regular_cells -= 1;
                    self.stats.irregular_cells += 1;
                    params.clear();
                }
                for s in params {
                    let uv = if along_u {
                        Point2::new(s, fixed)
                    } else {
                        Point2::new(fixed, s)
                    };
                    let p = self.p.surf.eval(uv.x, uv.y);
                    // Deduplicate corner crossings of the same leaf.
                    if self.leaf_crossings[li]
                        .iter()
                        .any(|&k| self.crossings[k].p.distance(p) <= self.match_dist())
                    {
                        continue;
                    }
                    self.crossings.push(Crossing {
                        uv,
                        p,
                        visited: false,
                    });
                    let k = self.crossings.len() - 1;
                    self.leaf_crossings[li].push(k);
                }
            }
        }
        Ok(())
    }

    /// 3D distance under which two crossings are the same point.
    pub fn match_dist(&self) -> f64 {
        (1e-7 * self.len).max(10.0 * self.ctx.tol.fit)
    }

    /// Connected components of irregular leaves (8-connectivity, periodic wrap).
    pub fn clusters(&self) -> Vec<Vec<usize>> {
        let irr: Vec<usize> = (0..self.cells.len())
            .filter(|&i| self.cells[i].class == Class::Irregular)
            .collect();
        let mut comp = vec![usize::MAX; irr.len()];
        let mut out: Vec<Vec<usize>> = Vec::new();
        for s in 0..irr.len() {
            if comp[s] != usize::MAX {
                continue;
            }
            let id = out.len();
            comp[s] = id;
            let mut group = vec![irr[s]];
            let mut stack = vec![s];
            while let Some(i) = stack.pop() {
                for j in 0..irr.len() {
                    if comp[j] == usize::MAX && self.adjacent(irr[i], irr[j]) {
                        comp[j] = id;
                        group.push(irr[j]);
                        stack.push(j);
                    }
                }
            }
            group.sort_unstable();
            out.push(group);
        }
        out
    }

    fn adjacent(&self, i: usize, j: usize) -> bool {
        let (a, b) = (&self.cells[i], &self.cells[j]);
        let touch = |x: (f64, f64), y: (f64, f64)| x.0 <= y.1 + 1e-12 && y.0 <= x.1 + 1e-12;
        let du = |shift: f64| touch((a.u.0 + shift, a.u.1 + shift), b.u);
        let dv = |shift: f64| touch((a.v.0 + shift, a.v.1 + shift), b.v);
        let us: &[f64] = if self.full_u {
            &[0.0, math::TAU, -math::TAU]
        } else {
            &[0.0]
        };
        let vs: &[f64] = if self.full_v {
            &[0.0, math::TAU, -math::TAU]
        } else {
            &[0.0]
        };
        us.iter().any(|&s| du(s)) && vs.iter().any(|&s| dv(s))
    }
}

/// Assemble the final graph from traced, resolved branches.
fn assemble(m: &March<'_>, asm: Assembled) -> Result<IntersectionGraph, SsiError> {
    let mut pre: Vec<PreBranch> = Vec::new();
    let mut iso: Vec<PreVertex> = Vec::new();
    let mut stats = m.stats;
    for rb in &asm.branches {
        let pieces = trace::fit_branch(m, rb, &mut stats)?;
        pre.extend(pieces);
    }
    for v in &asm.points {
        iso.push(*v);
    }
    let certified = !m.uncertified;
    Ok(finalize(
        m.ctx,
        pre,
        iso,
        Method::Marching,
        certified,
        stats,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clip::Patch;
    use crate::ssi::Ctx;
    use crate::tolerance::SsiTolerance;
    use crate::types::{UvBox, VertexKind};
    use forge_core::geom::{Curve3, Plane, Torus};
    use forge_core::{Frame, Vec3};

    /// The Villarceau section has a closed form (`Method::PlaneTorusVillarceau`), so the
    /// public API never marches it; marching it directly keeps coverage of tracing through
    /// singular (tangential) crossing points: two circles of radius `R` that cross at the
    /// two tangency points, found as singular vertices, with no piece missed.
    #[test]
    fn marching_through_the_villarceau_crossings() {
        let (big, small) = (5.0f64, 3.0f64);
        let t: Surface = Torus::new(Frame::world(), big, small).expect("t").into();
        let th = math::asin(small / big);
        let n = Vec3::new(0.0, -math::sin(th), math::cos(th));
        let pl: Surface = Plane::from_point_normal(Vec3::zero(), n).expect("p").into();
        let ctx = Ctx::new(
            Patch {
                surf: &pl,
                dom: UvBox::natural(&pl, 12.0),
            },
            Patch {
                surf: &t,
                dom: UvBox::natural(&t, 0.0),
            },
            SsiTolerance::default(),
        );
        let g = march(&ctx).expect("ok");
        assert_eq!(g.method, Method::Marching);
        let sing: Vec<_> = g
            .vertices
            .iter()
            .filter(|v| v.kind == VertexKind::Singular)
            .collect();
        assert_eq!(sing.len(), 2, "{:#?}", g.vertices);
        assert!(sing.iter().all(|v| v.contact.is_tangent()));
        let mut len = 0.0;
        for b in &g.branches {
            // Branches end exactly at their vertices.
            for (end, t) in [(b.start, b.range.0), (b.end, b.range.1)] {
                let i = end.expect("vertex");
                assert!(g.vertices[i].point.distance(b.curve.eval(t)) <= 1e-9);
            }
            assert!(b.error_bound <= 1e-7);
            let Curve3::BSpline(c) = &b.curve else {
                panic!("fitted branch expected");
            };
            let mut ts: Vec<f64> = vec![b.range.0];
            ts.extend(
                c.knots()
                    .iter()
                    .copied()
                    .filter(|&k| k > b.range.0 && k < b.range.1),
            );
            ts.push(b.range.1);
            ts.dedup();
            let mut prev: Option<Point3> = None;
            for w in ts.windows(2) {
                for j in 0..256 {
                    let p = b.curve.eval(w[0] + (w[1] - w[0]) * f64::from(j) / 256.0);
                    // On one of the two circles of radius R about (±r, 0, 0).
                    let d1 = p.distance(Vec3::new(small, 0.0, 0.0));
                    let d2 = p.distance(Vec3::new(-small, 0.0, 0.0));
                    assert!((d1 - big).abs().min((d2 - big).abs()) < 1e-6, "{p:?}");
                    if let Some(q) = prev {
                        len += q.distance(p);
                    }
                    prev = Some(p);
                }
            }
            if let Some(q) = prev {
                len += q.distance(b.curve.eval(b.range.1));
            }
        }
        assert!((len - 2.0 * math::TAU * big).abs() < 1e-5, "length {len}");
    }
}
