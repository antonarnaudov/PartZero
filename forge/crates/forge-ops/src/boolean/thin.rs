//! The smallest overlap that counts: SPEC [W0-41] (1)–(2) with [W0-48] and [W0-53].
//!
//! After [R-3]'s coincidence (aligned faces within the tolerance are snapped, `near`), the
//! common part `C = A ∩ B` of a two-solid step is a **contact**, not volume, where it is
//! *nowhere thicker than tol*: every point of it lies within *tol* of a face of the target
//! **and** of a face of the tool ([W0-48]), and it contains no ball of diameter greater than
//! *tol* ([W0-53]). A cut meets a target, and a join tool overlaps it, only where `C` is
//! somewhere thicker.
//!
//! `C` is read from the classified fragments: its boundary is the fragments of either
//! operand inside the other (`In`) or on a coincident face with the same orientation
//! (`OnSame`), grouped into connected components through shared pieces. A component is
//! **thick** on any of these witnesses, all points of `C`:
//! - a point of an `In` fragment (its interior points, and the ends, middle and quarter
//!   points of its boundary pieces) farther than *tol* from the other operand's faces — the
//!   one-sided depth of [W0-41] step 2 (a target corner 1.2e-6 mm inside a tool face);
//! - a point on the chord from a fragment's interior point along its inward normal to the
//!   next face of either operand (a segment inside `C`) farther than *tol* from the faces of
//!   either operand ([W0-48]'s two-sided test: the middle of a through-slit), or farther than
//!   *tol*/2 from the faces of both (a ball of diameter > *tol* inside `C`, [W0-53]: a covered
//!   fin 1.5e-6 mm thick).
//!
//! A component without a witness is **thin**. Distances to an operand's faces are exact
//! (orthogonal projections inside faces, closest points of edges), so a witness proves a
//! component thick. A thin verdict is a **sampled judgement**, never certified: a component
//! up to about 2·*tol* thick whose thickest point falls between samples (curved faces) is
//! judged thin wrongly. The samples are densified when the verdict is close (the largest
//! sampled thickness above *tol*/2: a 10 × 10 parameter grid of depth samples over each
//! fragment, a local ascent of the one-sided depth from the deepest two, and chords from a
//! 5 × 5 grid),
//! and a thin verdict is accepted only where a wrong one cannot pass silently:
//! - as the whole outcome of an operation (a single tool: `BOOLEAN_NO_INTERSECTION`, an
//!   explicit failure; the conformance contacts of `identity.json`);
//! - never as a step skipped beside the rest of a successful multi-operand operation (a
//!   contact tool beside a tool that meets, a target left separate by a join): there it is
//!   `FORGE_BOOLEAN_NEAR_COINCIDENT` (`mod.rs`, [`uncertified`]).
//!
//! A step whose `C` is thin everywhere is a contact ([`Common::Thin`]). One with thin and
//! thick components (a real cut beside a target edge within *tol* of an oblique tool face)
//! would need the thin part realized as coincident faces, which Forge does not do for
//! faces that are not aligned: `FORGE_BOOLEAN_NEAR_COINCIDENT` (SPEC [W0-41] (1), "a
//! configuration it cannot resolve"). A **thick** component may still contain a thin part
//! (review round 5: an L-shaped tool whose oblique face passes 8e-7 mm inside a target edge
//! and whose other arm cuts deep, one connected common part; the exact boolean gave a valid
//! body with a chamfer 1.6e-6 mm wide). Two tests find such parts, and either is
//! `FORGE_BOOLEAN_NEAR_COINCIDENT`:
//! - [`edge_sliver`]: an operand edge inside the other operand, within *tol* of one of its
//!   faces `G` beside a section curve on `G`, where the edge does not cross `G` (SPEC
//!   [W0-41] (1): the edge lies on `G`; a transversal crossing, however shallow, is exact).
//!   Where the intersection's vertex merging (within *tol*) has already joined the section
//!   curves to the edge (an edge up to about 7e-7 mm inside a 45° face), the result has the
//!   ruling's topology and no sliver is left to find;
//! - [`thin_fragment`]: an `In` fragment whose every sample is thin — within *tol* of the
//!   other operand and with a chord into `C` of at most *tol*, confirmed on the dense grid
//!   (a curved face dipping at most *tol* into a face beside a real overlap).
//!
//! A thin part of a thick component that neither test sees (a sliver whose samples miss
//! it) remains a sampled limit: its geometry is within *tol* of the ruling's (the part is
//! nowhere thicker than *tol*), only its topology differs (a face narrower than about
//! 2·*tol*).

use std::collections::{BTreeMap, BTreeSet};

use forge_core::geom::{Curve3, Line3};
use forge_core::linalg::{Point2, Point3, Vec3};
use forge_ssi::{SsiTolerance, intersect_curve_surface};

use super::chart::Chart;
use super::classify::{Class, Fragment};
use super::error::BooleanError;
use super::geom::{Aabb, param_on, uv_near};
use super::intersect::{Imprint, Loc, PieceSrc, VTOL, locate};
use super::model::Model;

/// The boundary entity of an operand nearest to a point.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Near {
    Face(usize),
    Edge(usize),
}

/// Distance from `p` to operand `k`'s boundary and the entity where it is attained, or
/// `(cap, None)` when it is at least `cap` (exact for faces whose surface projection is
/// global — planes and quadrics — and for edges).
fn nearest(m: &Model, k: usize, p: Point3, cap: f64) -> (f64, Option<Near>) {
    let pb = Aabb { lo: p, hi: p };
    let mut best = (cap, None);
    for fi in m.faces_of(k) {
        let f = &m.faces[fi];
        if !f.bbox.grown(best.0).overlaps(&pb) {
            continue;
        }
        let (u, v, d) = f.surface.project(p);
        if d >= best.0 {
            continue;
        }
        let uv = uv_near(&f.surface, p, Some(Point2::new(u, v)));
        // Inside the face; on (or extremely near) its boundary an edge is as near.
        if f.chart.contains(uv) == Some(true) {
            best = (d, Some(Near::Face(fi)));
        }
    }
    for (ei, e) in m.edges.iter().enumerate() {
        if e.operand != k || !e.bbox.grown(best.0).overlaps(&pb) {
            continue;
        }
        let d = param_on(&e.curve, e.range, p).1;
        if d < best.0 {
            best = (d, Some(Near::Edge(ei)));
        }
    }
    best
}

/// Distance from `p` to operand `k`'s boundary, or `cap` when it is at least `cap`.
pub(crate) fn boundary_distance(m: &Model, k: usize, p: Point3, cap: f64) -> f64 {
    nearest(m, k, p, cap).0
}

/// The outward normal of face `fi` at `uv` (the solid's side is behind it).
fn outward(m: &Model, fi: usize, uv: Point2) -> Option<Vec3> {
    let f = &m.faces[fi];
    let n = f.surface.normal(uv.x, uv.y)?;
    Some(if f.sense { n } else { -n })
}

/// Length of the segment from `p` along the unit direction `d` before it meets a face of
/// either operand (hits closer than `skip` ignored: `p` lies on its own face), up to
/// `reach`; `None` when a hit is tangential or the ray runs inside a surface.
fn chord(m: &Model, p: Point3, d: Vec3, skip: f64, reach: f64) -> Option<f64> {
    let tol = SsiTolerance::default();
    let line: Curve3 = Line3::new(p, d).ok()?.into();
    let seg = Aabb {
        lo: p.min_components(p + d * reach),
        hi: p.max_components(p + d * reach),
    };
    let mut best = reach;
    for (gi, g) in m.faces.iter().enumerate() {
        if !g.bbox.grown(VTOL).overlaps(&seg) {
            continue;
        }
        let hits = intersect_curve_surface(&line, (0.0, reach), &g.surface, g.uvbox, &tol).ok()?;
        if hits
            .overlaps
            .iter()
            .any(|o| o.t_range.1 > skip && o.t_range.0 < best)
        {
            return None;
        }
        for h in &hits.points {
            if h.t <= skip || h.t >= best {
                continue;
            }
            if locate(m, gi, h.point, h.uv) == Loc::Out {
                continue;
            }
            if h.contact.is_tangent() {
                return None;
            }
            best = h.t;
        }
    }
    Some(best)
}

/// Points of fragment `fr` for the depth test: its interior points and the ends, middles
/// and quarter points of its boundary pieces.
fn fragment_points(m: &Model, imp: &Imprint, fr: &Fragment) -> Vec<Point3> {
    let f = &m.faces[fr.face];
    let mut out: Vec<Point3> = std::iter::once(fr.uv)
        .chain(fr.alts.iter().copied())
        .map(|uv| f.surface.eval(uv.x, uv.y))
        .collect();
    for &(pi, _) in fr.loops.iter().flatten() {
        let pc = &imp.pieces[pi];
        for k in 0..=4 {
            let t = pc.range.0 + (pc.range.1 - pc.range.0) * k as f64 / 4.0;
            out.push(pc.curve.eval(t));
        }
    }
    out
}

/// Grid cells per parameter direction of the dense pass: depth samples, and (coarser)
/// chords, which cost an intersection with every face they may reach.
const GRID: usize = 10;
const CHORD_GRID: usize = 5;

/// The parameter box of fragment `fr` (its boundary pieces' pcurves on its face, and its
/// interior points); the face chart's box when the fragment has no boundary on its face (a
/// closed face) or the pieces' box is degenerate.
fn fragment_uv_box(imp: &Imprint, chart: &Chart, fr: &Fragment) -> (Point2, Point2) {
    let mut lo = Point2::new(f64::INFINITY, f64::INFINITY);
    let mut hi = Point2::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
    let mut add = |q: Point2| {
        lo = Point2::new(lo.x.min(q.x), lo.y.min(q.y));
        hi = Point2::new(hi.x.max(q.x), hi.y.max(q.y));
    };
    let mut bounded = false;
    for &(pi, _) in fr.loops.iter().flatten() {
        let pc = &imp.pieces[pi];
        let Some(on) = pc.on.iter().find(|o| o.face == fr.face) else {
            continue;
        };
        for k in 0..=8 {
            let t = pc.range.0 + (pc.range.1 - pc.range.0) * k as f64 / 8.0;
            add(on.pcurve.eval(t));
            bounded = true;
        }
    }
    for uv in std::iter::once(fr.uv).chain(fr.alts.iter().copied()) {
        add(uv);
    }
    let finite = lo.x.is_finite() && lo.y.is_finite() && hi.x.is_finite() && hi.y.is_finite();
    if !bounded || !finite || hi.x <= lo.x || hi.y <= lo.y {
        let ((u0, u1), (v0, v1)) = chart.uv_box();
        return (Point2::new(u0, v0), Point2::new(u1, v1));
    }
    (lo, hi)
}

/// Cell centres of an `n × n` grid over the parameter box of fragment `fr` (not all inside
/// it).
fn grid_cells(imp: &Imprint, charts: &[Chart], fr: &Fragment, n: usize) -> Vec<Point2> {
    let (lo, hi) = fragment_uv_box(imp, &charts[fr.face], fr);
    let mut out = Vec::with_capacity(n * n);
    for i in 0..n {
        for j in 0..n {
            out.push(Point2::new(
                lo.x + (hi.x - lo.x) * (i as f64 + 0.5) / n as f64,
                lo.y + (hi.y - lo.y) * (j as f64 + 0.5) / n as f64,
            ));
        }
    }
    out
}

/// Whether parameters `uv` lie inside fragment `fr` (point location in its face's split
/// chart: the costly part of the dense pass, so callers test only the points they use).
fn in_fragment(charts: &[Chart], fr: &Fragment, uv: Point2) -> bool {
    charts[fr.face].face_at(uv) == Some(fr.group)
}

/// Parameter points of fragment `fr` on an `n × n` grid over its box (the cell centres
/// inside it).
fn grid_uvs(imp: &Imprint, charts: &[Chart], fr: &Fragment, n: usize) -> Vec<Point2> {
    grid_cells(imp, charts, fr, n)
        .into_iter()
        .filter(|&uv| in_fragment(charts, fr, uv))
        .collect()
}

/// Chord origins of fragment `fr` on the [`CHORD_GRID`] grid: the cell centres inside it
/// and not on its boundary — farther than a tenth of a cell from each boundary piece (in
/// 3D). A point on a section piece bounding the fragment lies on the other operand's face,
/// and its chord need not enter `C` at all (a cell centre on the hypotenuse of a target
/// corner's triangle, review round 5).
fn chord_uvs(m: &Model, imp: &Imprint, charts: &[Chart], fr: &Fragment) -> Vec<Point2> {
    let f = &m.faces[fr.face];
    let (lo, hi) = fragment_uv_box(imp, &charts[fr.face], fr);
    let n = CHORD_GRID as f64;
    let mid = Point2::new(0.5 * (lo.x + hi.x), 0.5 * (lo.y + hi.y));
    let at = |du: f64, dv: f64| f.surface.eval(mid.x + du, mid.y + dv);
    let cell = at((hi.x - lo.x) / n, 0.0)
        .distance(at(0.0, 0.0))
        .max(at(0.0, (hi.y - lo.y) / n).distance(at(0.0, 0.0)));
    let margin = 0.1 * cell;
    grid_uvs(imp, charts, fr, CHORD_GRID)
        .into_iter()
        .filter(|uv| {
            let p = f.surface.eval(uv.x, uv.y);
            fr.loops.iter().flatten().all(|&(pi, _)| {
                let pc = &imp.pieces[pi];
                param_on(&pc.curve, pc.range, p).1 > margin
            })
        })
        .collect()
}

/// Local ascent of the one-sided depth of fragment `fr` (on operand `1 - other`'s face) in
/// operand `other` from `uv` (depth `d`), staying inside the fragment: a compass search
/// whose step starts at one grid cell and halves down to 1e-4 of the fragment's box (near a
/// smooth maximum the depth then differs from it by about 1e-8 of its variation over the
/// fragment). A step is taken to the first neighbour that is deeper and inside the
/// fragment. Returns the deepest point found and its depth (stops early above `stop`).
#[allow(clippy::too_many_arguments)]
fn ascend(
    m: &Model,
    charts: &[Chart],
    fr: &Fragment,
    other: usize,
    uv: Point2,
    d: f64,
    cell: Point2,
    stop: f64,
) -> (Point3, f64) {
    let f = &m.faces[fr.face];
    let (mut cur, mut depth) = (uv, d);
    let mut h = cell;
    let floor = Point2::new(cell.x * 1e-4 * GRID as f64, cell.y * 1e-4 * GRID as f64);
    const DIRS: [(f64, f64); 8] = [
        (1.0, 0.0),
        (-1.0, 0.0),
        (0.0, 1.0),
        (0.0, -1.0),
        (1.0, 1.0),
        (1.0, -1.0),
        (-1.0, 1.0),
        (-1.0, -1.0),
    ];
    for _ in 0..80 {
        if depth > stop || (h.x <= floor.x && h.y <= floor.y) {
            break;
        }
        let mut moved = false;
        for (a, b) in DIRS {
            let q = Point2::new(cur.x + a * h.x, cur.y + b * h.y);
            let dq = boundary_distance(m, other, f.surface.eval(q.x, q.y), 2.0 * VTOL);
            if dq > depth && in_fragment(charts, fr, q) {
                (cur, depth) = (q, dq);
                moved = true;
                break;
            }
        }
        if !moved {
            h = Point2::new(0.5 * h.x, 0.5 * h.y);
        }
    }
    (f.surface.eval(cur.x, cur.y), depth)
}

/// Depth samples `(point, one-sided depth)` of `In` fragment `fr` in operand `other`:
/// its own points ([`fragment_points`]); or, dense, the deepest points of a
/// [`GRID`]` × `[`GRID`] grid over its box that lie inside it and the results of [`ascend`]
/// from the two deepest. The grid's depths are all measured and its points tried deepest
/// first, so the first one inside the fragment is the deepest grid point of the fragment: a
/// thick witness if any grid point is one.
fn depth_samples(
    m: &Model,
    imp: &Imprint,
    fr: &Fragment,
    other: usize,
    dense: Option<&[Chart]>,
) -> Vec<(Point3, f64)> {
    let tol = VTOL;
    let depth = |p: Point3| boundary_distance(m, other, p, 2.0 * tol);
    let Some(charts) = dense else {
        return fragment_points(m, imp, fr)
            .into_iter()
            .map(|p| (p, depth(p)))
            .collect();
    };
    let f = &m.faces[fr.face];
    let grid: Vec<(Point2, Point3, f64)> = grid_cells(imp, charts, fr, GRID)
        .into_iter()
        .map(|uv| {
            let p = f.surface.eval(uv.x, uv.y);
            (uv, p, depth(p))
        })
        .collect();
    let mut order: Vec<usize> = (0..grid.len()).collect();
    order.sort_by(|&a, &b| grid[b].2.total_cmp(&grid[a].2).then(a.cmp(&b)));
    let mut starts: Vec<usize> = Vec::new();
    for i in order {
        if !in_fragment(charts, fr, grid[i].0) {
            continue;
        }
        if grid[i].2 > tol {
            return vec![(grid[i].1, grid[i].2)];
        }
        starts.push(i);
        if starts.len() == 2 {
            break;
        }
    }
    let (lo, hi) = fragment_uv_box(imp, &charts[fr.face], fr);
    let cell = Point2::new((hi.x - lo.x) / GRID as f64, (hi.y - lo.y) / GRID as f64);
    let mut out: Vec<(Point3, f64)> = starts.iter().map(|&i| (grid[i].1, grid[i].2)).collect();
    for &i in &starts {
        out.push(ascend(
            m, charts, fr, other, grid[i].0, grid[i].2, cell, tol,
        ));
    }
    out
}

/// A thin component: the largest sampled depth of its `In` fragments in the other operand
/// (at most the tolerance), and a point and a face of each operand in it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ThinPart {
    pub depth: f64,
    pub at: Point3,
    /// Provenance names of a target face and a tool face bounding it (either may be absent).
    pub entities: String,
}

/// What the samples of a set of fragments show.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Sampled {
    /// A witness farther than the tolerance ([`thin_part`]'s list): thick.
    Thick,
    /// No witness: the largest one-sided depth of the `In` samples, and the largest
    /// thickness evidence (depths, chord points' distances to either operand, twice their
    /// distance to the nearer one), which is at most the tolerance.
    Thin { depth: f64, evidence: f64 },
    /// Nothing measurable (every chord undecidable, no `In` fragment).
    Unmeasured,
}

/// The witnesses of the module docs over the fragments `set` (fragment indices), on their
/// own points or (`dense`) on the dense grid.
fn sample(
    m: &Model,
    imp: &Imprint,
    frags: &[Fragment],
    classes: &[Class],
    set: &[usize],
    dense: Option<&[Chart]>,
) -> Sampled {
    let tol = VTOL;
    let (mut depth, mut evidence): (f64, f64) = (0.0, 0.0);
    // Thin is claimed on evidence only: some sample must have been measured (a component of
    // coincident faces whose every chord is undecidable stays thick, as before this test).
    let mut measured = false;
    // One-sided depth of `In` fragments.
    for &i in set {
        if classes[i] != Class::In {
            continue;
        }
        let other = 1 - m.faces[frags[i].face].operand;
        for (_, d) in depth_samples(m, imp, &frags[i], other, dense) {
            if d > tol {
                return Sampled::Thick;
            }
            depth = depth.max(d);
            evidence = evidence.max(d);
            measured = true;
        }
    }
    // Points inside `C`: on chords along the inward normal from interior points.
    for &i in set {
        let fr = &frags[i];
        let f = &m.faces[fr.face];
        let uvs: Vec<Point2> = match dense {
            None => std::iter::once(fr.uv)
                .chain(fr.alts.iter().copied())
                .collect(),
            Some(charts) => chord_uvs(m, imp, charts, fr),
        };
        for uv in uvs {
            let Some(n) = outward(m, fr.face, uv) else {
                continue;
            };
            let p = f.surface.eval(uv.x, uv.y);
            let Some(len) = chord(m, p, -n, 1e-3 * tol, 8.0 * tol) else {
                continue;
            };
            for s in [0.25, 0.5, 0.75] {
                let x = p - n * (s * len);
                let (da, db) = (
                    boundary_distance(m, 0, x, 2.0 * tol),
                    boundary_distance(m, 1, x, 2.0 * tol),
                );
                // Farther than the tolerance from one operand's faces, or the centre of a
                // ball of diameter > tol inside `C`.
                if da > tol || db > tol || da.min(db) > 0.5 * tol {
                    return Sampled::Thick;
                }
                evidence = evidence.max(da.max(db)).max(2.0 * da.min(db));
                measured = true;
            }
        }
    }
    if measured {
        Sampled::Thin { depth, evidence }
    } else {
        Sampled::Unmeasured
    }
}

/// [`sample`] on the fragments' own points, then, when that finds them thin but the
/// largest thickness evidence exceeds half the tolerance, on the dense grid.
fn judge(
    m: &Model,
    imp: &Imprint,
    frags: &[Fragment],
    classes: &[Class],
    charts: &[Chart],
    set: &[usize],
) -> Sampled {
    match sample(m, imp, frags, classes, set, None) {
        Sampled::Thin { depth, evidence } if evidence > 0.5 * VTOL => {
            match sample(m, imp, frags, classes, set, Some(charts)) {
                Sampled::Thin {
                    depth: d2,
                    evidence: e2,
                } => Sampled::Thin {
                    depth: depth.max(d2),
                    evidence: evidence.max(e2),
                },
                Sampled::Thick => Sampled::Thick,
                Sampled::Unmeasured => Sampled::Thin { depth, evidence },
            }
        }
        s => s,
    }
}

/// Whether a component of `C` (fragment indices) is somewhere thicker than the tolerance:
/// `None` when it is, else what the thin component is.
fn thin_part(
    m: &Model,
    imp: &Imprint,
    frags: &[Fragment],
    classes: &[Class],
    charts: &[Chart],
    comp: &[usize],
) -> Option<ThinPart> {
    let Sampled::Thin { depth, .. } = judge(m, imp, frags, classes, charts, comp) else {
        return None;
    };
    let name = |k: usize| {
        comp.iter()
            .map(|&i| frags[i].face)
            .find(|&f| m.faces[f].operand == k)
            .map(|f| m.faces[f].prov.name())
            .unwrap_or_else(|| "-".into())
    };
    let fr = &frags[comp[0]];
    Some(ThinPart {
        depth,
        at: m.faces[fr.face].surface.eval(fr.uv.x, fr.uv.y),
        entities: format!("{} × {}", name(0), name(1)),
    })
}

/// The common part of a two-solid step.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Common {
    /// No fragment bounds a common volume (disjoint, touching, or coincident faces with
    /// opposite orientation only).
    Empty,
    /// Every component is somewhere thicker than the tolerance.
    Thick,
    /// Every component is nowhere thicker than the tolerance: a contact.
    Thin(ThinPart),
    /// Thin and thick components (the first thin one).
    Mixed(ThinPart),
}

/// The common part of the classified fragments of `m` (see the module docs); `charts` are
/// the faces' split charts (`classify::split_faces`), for the dense pass.
pub(crate) fn common(
    m: &Model,
    imp: &Imprint,
    frags: &[Fragment],
    classes: &[Class],
    charts: &[Chart],
) -> Common {
    let bounds: Vec<usize> = (0..frags.len())
        .filter(|&i| matches!(classes[i], Class::In | Class::OnSame))
        .collect();
    if bounds.is_empty() {
        return Common::Empty;
    }
    // Components through shared pieces (union–find over the bounding fragments).
    let mut uf: Vec<usize> = (0..bounds.len()).collect();
    fn find(uf: &mut [usize], mut x: usize) -> usize {
        while uf[x] != x {
            uf[x] = uf[uf[x]];
            x = uf[x];
        }
        x
    }
    let mut first_of_piece: BTreeMap<usize, usize> = BTreeMap::new();
    for (k, &i) in bounds.iter().enumerate() {
        for &(pi, _) in frags[i].loops.iter().flatten() {
            match first_of_piece.get(&pi) {
                Some(&j) => {
                    let (a, b) = (find(&mut uf, j), find(&mut uf, k));
                    if a != b {
                        uf[a.max(b)] = a.min(b);
                    }
                }
                None => {
                    first_of_piece.insert(pi, k);
                }
            }
        }
    }
    let mut comps: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (k, &b) in bounds.iter().enumerate() {
        let r = find(&mut uf, k);
        comps.entry(r).or_default().push(b);
    }
    let mut thin: Option<ThinPart> = None;
    let mut any_thick = false;
    for comp in comps.values() {
        match thin_part(m, imp, frags, classes, charts, comp) {
            None => any_thick = true,
            Some(t) => {
                if thin.is_none() {
                    thin = Some(t);
                }
            }
        }
    }
    if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
        eprintln!(
            "common part: {} components, thick {any_thick}, thin {thin:?}",
            comps.len()
        );
    }
    match (any_thick, thin) {
        (true, None) => Common::Thick,
        (false, Some(t)) => Common::Thin(t),
        (true, Some(t)) => Common::Mixed(t),
        (false, None) => Common::Empty,
    }
}

/// Reach of the section samples of [`edge_sliver`]: a section curve on `G` runs beside an
/// edge within this distance (an edge `d ≤ tol` inside an oblique face has its section
/// curves on the edge's faces `d / sin` of their angles to `G` away).
const BESIDE: f64 = 8.0 * VTOL;

/// Largest distance of a crossing vertex from the surface it crosses ([`edge_sliver`]): the
/// intersection's coincidence resolution (`near::COINCIDENT_OFFSET`), far below the
/// tolerance.
const CROSSING: f64 = super::near::COINCIDENT_OFFSET;

/// SPEC [W0-41] (1) inside a thick common part: the first operand edge (piece) that runs
/// inside the other operand within the tolerance of one of its faces `G` without crossing
/// `G`, beside a section curve on `G` — the edge lies on `G` by [R-3], and the exact boolean
/// would give a face narrower than about 2·*tol* between that section curve and the edge.
///
/// For each piece of an operand edge that bounds an `In` fragment and lies on no face of the
/// other operand (so it runs inside it), the section curves on the edge's own faces are
/// sampled (nine points each); a sample within [`BESIDE`] of the piece gives the piece's
/// point `q` next to it. The piece is a sliver at `q` when `q` is within the tolerance of
/// the other operand's boundary, the nearest entity is the section's face `G` of the other
/// operand (or an edge of `G`), and no end of the piece lies on that entity's faces: a
/// transversal crossing of `G` — at any angle — puts an end of the piece on `G` (a section
/// curve on `G` or an edge of `G` meets it there), and is exact geometry, not a sliver.
pub(crate) fn edge_sliver(
    m: &Model,
    imp: &Imprint,
    frags: &[Fragment],
    classes: &[Class],
) -> Option<ThinPart> {
    let tol = VTOL;
    let mut inside: BTreeSet<usize> = BTreeSet::new();
    for (fr, c) in frags.iter().zip(classes) {
        if *c == Class::In {
            inside.extend(fr.loops.iter().flatten().map(|&(pi, _)| pi));
        }
    }
    if inside.is_empty() {
        return None;
    }
    // The faces every imprint vertex lies on, through the pieces that end there.
    let mut vfaces: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); imp.verts.len()];
    for pc in &imp.pieces {
        for v in [pc.start, pc.end].into_iter().flatten() {
            vfaces[v].extend(pc.on.iter().map(|o| o.face));
        }
    }
    // The section pieces on every face.
    let mut sections: BTreeMap<usize, BTreeSet<usize>> = BTreeMap::new();
    for (si, sp) in imp.pieces.iter().enumerate() {
        if matches!(sp.src, PieceSrc::Section { .. }) {
            for o in &sp.on {
                sections.entry(o.face).or_default().insert(si);
            }
        }
    }
    // The faces of every operand edge.
    let mut edge_faces: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); m.edges.len()];
    for (fi, f) in m.faces.iter().enumerate() {
        for e in f.edges() {
            edge_faces[e].insert(fi);
        }
    }
    for &pi in &inside {
        let pc = &imp.pieces[pi];
        let PieceSrc::Edge(e) = pc.src else {
            continue;
        };
        let other = 1 - m.edges[e].operand;
        if pc.on.iter().any(|o| m.faces[o.face].operand == other) {
            continue;
        }
        let own: BTreeSet<usize> = pc.on.iter().map(|o| o.face).collect();
        // The other operand's faces the piece crosses at an end: an end vertex on the face
        // (a piece of it ends there) and on its surface. A crossing vertex is an edge–face
        // hit on the surface (vertices merged within the tolerance take the position of one
        // of their candidates, all on it); an end merged onto an operand vertex or an edge
        // of the face that is up to the tolerance away (the edge passing 8e-7 mm from the
        // tool's edge at the end of a sliver) is not a crossing.
        let crossed: BTreeSet<usize> = [pc.start, pc.end]
            .into_iter()
            .flatten()
            .flat_map(|v| {
                let p = imp.verts[v].p;
                vfaces[v]
                    .iter()
                    .copied()
                    .filter(move |&f| m.faces[f].surface.project(p).2 <= CROSSING)
            })
            .filter(|&f| m.faces[f].operand == other)
            .collect();
        let beside: BTreeSet<usize> = own
            .iter()
            .filter_map(|f| sections.get(f))
            .flatten()
            .copied()
            .collect();
        for si in beside {
            let sp = &imp.pieces[si];
            let g_faces: BTreeSet<usize> = sp
                .on
                .iter()
                .map(|o| o.face)
                .filter(|&f| m.faces[f].operand == other)
                .collect();
            for k in 0..=8 {
                let s = sp
                    .curve
                    .eval(sp.range.0 + (sp.range.1 - sp.range.0) * k as f64 / 8.0);
                let (t, dist) = param_on(&pc.curve, pc.range, s);
                if dist > BESIDE {
                    continue;
                }
                let q = pc.curve.eval(t);
                let (d, near) = nearest(m, other, q, tol * (1.0 + 1e-12));
                let near_faces: BTreeSet<usize> = match near {
                    None => continue,
                    Some(Near::Face(f)) => std::iter::once(f).collect(),
                    Some(Near::Edge(x)) => edge_faces[x].clone(),
                };
                if near_faces.is_disjoint(&g_faces) || !near_faces.is_disjoint(&crossed) {
                    continue;
                }
                let g = *near_faces
                    .intersection(&g_faces)
                    .next()
                    .expect("not disjoint");
                if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
                    eprintln!(
                        "edge sliver: piece {pi} of {} at {q:?}, {d:e} from {} (section piece {si})",
                        m.edges[e].prov.name(),
                        m.faces[g].prov.name()
                    );
                }
                return Some(ThinPart {
                    depth: d,
                    at: q,
                    entities: format!("{} × {}", m.edges[e].prov.name(), m.faces[g].prov.name()),
                });
            }
        }
    }
    None
}

/// A thin part of a thick common part that runs along no edge: the first `In` fragment
/// every sample of which is thin — within the tolerance of the other operand's boundary
/// (its own points), and a chord from each interior point along the inward normal (into
/// `C`) of at most the tolerance — confirmed on the dense grid ([`judge`]). A fragment next
/// to a thick witness (the faces of a target corner 1.2e-6 mm inside a tool face) has a
/// thick sample itself (the corner, the chord to it), and a layer that a cut leaves (a tool
/// face within the tolerance of the target's far face) has long chords into `C`: neither is
/// a thin part of `C`.
pub(crate) fn thin_fragment(
    m: &Model,
    imp: &Imprint,
    frags: &[Fragment],
    classes: &[Class],
    charts: &[Chart],
) -> Option<ThinPart> {
    let tol = VTOL;
    'frags: for (i, fr) in frags.iter().enumerate() {
        if classes[i] != Class::In {
            continue;
        }
        let f = &m.faces[fr.face];
        let other = 1 - f.operand;
        let mut depth: f64 = 0.0;
        for p in fragment_points(m, imp, fr) {
            let d = boundary_distance(m, other, p, 2.0 * tol);
            if d > tol {
                continue 'frags;
            }
            depth = depth.max(d);
        }
        let mut chords = 0;
        for uv in std::iter::once(fr.uv).chain(fr.alts.iter().copied()) {
            let Some(n) = outward(m, fr.face, uv) else {
                continue;
            };
            let p = f.surface.eval(uv.x, uv.y);
            match chord(m, p, -n, 1e-3 * tol, 8.0 * tol) {
                Some(len) if len <= tol => chords += 1,
                Some(_) => continue 'frags,
                None => {}
            }
        }
        if chords == 0 {
            continue;
        }
        // The dense grid confirms it (no thick witness on it).
        if judge(m, imp, frags, classes, charts, &[i]) == Sampled::Thick {
            continue;
        }
        let dense_chords_thin = chord_uvs(m, imp, charts, fr).into_iter().all(|uv| {
            let (Some(n), p) = (outward(m, fr.face, uv), f.surface.eval(uv.x, uv.y)) else {
                return true;
            };
            chord(m, p, -n, 1e-3 * tol, 8.0 * tol).is_none_or(|len| len <= tol)
        });
        if !dense_chords_thin {
            continue;
        }
        if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
            eprintln!(
                "thin fragment {} #{} (depth {depth:e}, {chords} chords)",
                f.prov.name(),
                fr.group
            );
        }
        return Some(ThinPart {
            depth,
            at: f.surface.eval(fr.uv.x, fr.uv.y),
            entities: f.prov.name(),
        });
    }
    None
}

/// `FORGE_BOOLEAN_NEAR_COINCIDENT` for a thin part of the common volume that Forge cannot
/// realize as a contact beside the rest of the operation.
pub(crate) fn unresolved(t: &ThinPart, why: &str) -> BooleanError {
    BooleanError::NearCoincident {
        entities: t.entities.clone(),
        offset: t.depth,
        limit: VTOL,
        point: t.at.to_array(),
        reason: format!(
            "the operands overlap by at most {:.3e} mm there, nowhere thicker than the linear tolerance: SPEC [R-3] makes that a contact (a target edge or vertex within the tolerance of a tool face lies on it), which the boolean realizes only for aligned faces; {why}",
            t.depth
        ),
    }
}

/// `FORGE_BOOLEAN_NEAR_COINCIDENT` for an operand edge within the tolerance of a face of the
/// other operand that it does not cross, beside a real overlap ([`edge_sliver`]).
pub(crate) fn sliver(t: &ThinPart) -> BooleanError {
    BooleanError::NearCoincident {
        entities: t.entities.clone(),
        offset: t.depth,
        limit: VTOL,
        point: t.at.to_array(),
        reason: format!(
            "the edge runs {:.3e} mm inside the other operand's face without crossing it: SPEC [W0-41] (1) puts it on that face, beside a real overlap; the boolean realizes that only for aligned faces, and the exact result would have a face narrower than twice the tolerance along the edge",
            t.depth
        ),
    }
}

/// `FORGE_BOOLEAN_NEAR_COINCIDENT` for a thin verdict ([`Common::Thin`], a sampled
/// judgement) that a successful multi-operand operation would apply silently.
pub(crate) fn uncertified(t: &ThinPart, why: &str) -> BooleanError {
    BooleanError::NearCoincident {
        entities: t.entities.clone(),
        offset: t.depth,
        limit: VTOL,
        point: t.at.to_array(),
        reason: format!(
            "the operands overlap by at most {:.3e} mm there (sampled; not certified): SPEC [R-3] makes that a contact only if no point of the overlap is thicker than the linear tolerance, and {why}, so a wrong judgement would not be seen",
            t.depth
        ),
    }
}
