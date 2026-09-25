//! Shell (SPEC §6.8) by direct construction.
//!
//! Every face that is not open is offset by the thickness along its outward normal
//! (towards the interior for `inward`, away for `outward`); offsets of analytic faces are
//! exact (planes move, cylinders, spheres and tori change radius — a torus whose tube grows
//! past its axis becomes the outer sheet of a spindle torus —, cones shift), open faces
//! stay. The **offset body** has the input's topology: each vertex moves to the point where
//! its faces' offsets meet (Gauss–Newton on their signed distances, minimum-norm, so faces
//! tangent at a smooth edge are handled), each edge to the intersection of its two faces'
//! offsets (a line through the two new vertices, or the coaxial circle) — the sharp joins
//! of `GeomAbs_Intersection`.
//!
//! With `O` the outer and `I` the inner body (`inward`: the input and its offset; `outward`:
//! the offset and the input), the result is `O`'s faces that are not open, `I`'s faces that
//! are not open **reversed**, and for each open face `X` its **rims**. With no open face,
//! `I` reversed is a second shell: an internal void (info `SHELL_CLOSED_VOID`).
//!
//! **Openings.** A planar open face `X` whose edges are all convex (a box's top) is not
//! offset: its rims are the region of `X`'s plane between `O`'s and `I`'s faces there (one
//! face around the outer loop, one annulus per inner loop). An open face whose edges are all
//! **smooth** (the flat top of a rounded box: its neighbours are blends tangent to it) is
//! offset like the others — its neighbours' offsets never reach its plane — and its rims are
//! the **lateral faces** that close the wall between each of its edges `E` and the offset
//! edge `E' = E ± t·n` (W6 review round 4): the plane through a line edge along `n`, the
//! cylinder through a circle edge about its axis, joined along `v → v'` at its vertices,
//! where every face around `v` has the normal `n` (checked). Openings with both kinds of
//! edges, with a concave edge, or not planar are `SHELL_FAILED`.
//!
//! Supported: bodies of one shell; openings as above, pairwise not adjacent; faces of every
//! analytic type; edges that are lines or circles. Anything else is `SHELL_FAILED` with the
//! reason — notably (documented deferrals, W6 review round 6) a body whose blends meet in a
//! **mitre** (an ellipse where two fillets meet at a corner, a B-spline curved mitre): the
//! offset of such an edge is not built; and a vertex of more than three faces (the corner
//! triangle of three chamfers leaves four faces at each of its vertices), whose offset needs a
//! topology change.
//!
//! Checks. Proven violations are `SHELL_THICKNESS_TOO_LARGE`: an offset radius reaching zero
//! (`curvature`); an offset edge shorter than `10·tol` or reversed (attributed to the walls
//! at its two ends, whose offsets close it up), a face boundary found to
//! meet itself ([`crate::cert2d`]; attributed to the walls on the other side of the crossing
//! edges), or walls found to collide (`gap`): the **offset body** must not intersect itself
//! and must not meet the input except where the construction joins them — checked pairwise
//! and certified ([`crate::interfere`]), with each opening added as virtual faces (the
//! offset body's face on its plane, and the opening itself), so that a wall pushed through an
//! opening (a pocket's ceiling under a thin membrane) is caught like two walls colliding. The
//! limits name the pair of faces whose offsets collide. Two offset faces joined tangentially
//! along an edge (a blend's offset and its neighbours') are decided by the strict band
//! certificate first ([`crate::interfere::Checker::band_g1`]). What cannot be certified
//! either way — a pair forge-ssi and the band certificate cannot separate, a boundary test out
//! of budget — is **not** a collision (W6 review round 4): the shell is `SHELL_FAILED` naming
//! it, and it never feeds the feasible range. So is a vertex whose faces' offsets are not
//! found to meet (W6 review round 5): at a vertex of more than three faces they generally
//! have no common point at any thickness (the offset needs a topology change there, which
//! this construction does not make: `SHELL_FAILED` naming the vertex and its faces), and a
//! solve that does not converge proves nothing. The built body must pass
//! `forge_check::validate`.
//!
//! A planar face **used up** by its neighbours' offsets (a narrow bevel between two walls,
//! gone when their offsets meet across it) is neither an offset surface degenerating nor
//! opposite walls colliding, the two causes SPEC §6.8 gives `SHELL_THICKNESS_TOO_LARGE`:
//! below the thickness at which two walls meet in closed form it is `SHELL_FAILED`, naming
//! that face and the thickness at which it vanishes (W6 review round 3; a `reason` for it is
//! proposed to the Contract stage) — **unless the whole offset body collapses** there
//! ([`collapse_thickness`], W6 review round 6): an inward shell of a triangular, pentagonal or
//! wedge-shaped prism past its inradius, where every wall's offset meets the others' and the
//! cavity vanishes. That is walls colliding: `SHELL_THICKNESS_TOO_LARGE` (`gap`, naming the
//! walls whose offset edges turn over), with the collapse thickness as a closed-form
//! candidate of the feasible range, confirmed by construction.
//!
//! Feasible range (only after a **proven** violation at the requested thickness): a closed
//! form (parallel walls, tubes, a tube and a wall: the "gap / 2" limits, [`closed_forms`])
//! when the construction confirms it, otherwise a descent and bisection; within a fixed
//! budget of attempts ([`SEARCH_RUNS`], deterministic). The suggested value is always one
//! that was built, and it is reported only when `max + 0.001` and `1.01·max` were both
//! **proven** infeasible (the feasible-range property); otherwise `max_feasible_thickness`
//! is left out (SPEC §6.8 makes it optional) and the message says how far the search got.
//! Closed forms also give where an offset radius reaches zero ([`curvature_limits`]); just
//! below such a bound the offset is a sliver (a tube of a few µm) whose checks may not be
//! certified, and then no maximum is claimed either — those limits are outside the
//! feasible-range property, and the message states the closed-form bound instead (W6 review
//! round 5).

use std::collections::{BTreeMap, BTreeSet};

use forge_core::geom::{Circle3, Cone, Curve3, Cylinder, Plane, Sphere, Surface, Torus};
use forge_core::linalg::{Point3, Vec3};
use forge_core::topo::{Body, FaceId};
use forge_ir::v1::metrics::ShellReport;
use forge_ir::v1::{LINEAR_TOLERANCE, ShellDirection};

use crate::error::{BlendError, ShellLimit, ShellLimitReason, round_down_mm};
use crate::keys::{KeyMap, Pick};
use crate::plan::{PE, PF, PU, Plan};
use crate::topo::{Adj, Convexity, edge_convexity};

/// Shell options.
#[derive(Clone, Debug)]
pub struct ShellOptions {
    /// The feature id (provenance: `S/offset:{X}`, `S/rim:{X}`).
    pub feature: String,
    /// Keys and display names of the input's entities (derived from provenance for the
    /// entities it does not name).
    pub keys: Option<KeyMap>,
    /// Index of the body shelled, in the numbering of the open faces' [`Pick::body`]
    /// (default 0). Every open face must belong to it (`SHELL_FACE_NOT_ON_BODY`).
    pub body: usize,
}

impl ShellOptions {
    /// Options with derived keys and body index 0.
    pub fn new(feature: impl Into<String>) -> Self {
        Self {
            feature: feature.into(),
            keys: None,
            body: 0,
        }
    }
}

/// A shell result.
#[derive(Clone, Debug)]
pub struct ShellOutput {
    /// The new body (validated).
    pub body: Body,
    /// The report block (`shell`, SPEC §7.2).
    pub report: ShellReport,
}

#[derive(Clone, Debug)]
struct Viol {
    faces: BTreeSet<usize>,
    reason: ShellLimitReason,
    what: String,
}

#[derive(Clone, Debug)]
enum Fail {
    Failed(String),
    /// Proven violations (a radius reaching zero, walls found to collide).
    Infeasible(Vec<Viol>),
    /// A check that could not be certified either way (W6 review round 4): not a collision,
    /// so `SHELL_FAILED` naming it, and never a limit of the feasible range.
    Unverified(String),
    Invalid(String),
    /// Face `.0` (a planar polygon) is used up by the offsets of its neighbours: its offset
    /// loop collapses or turns over. Neither an offset surface degenerating nor opposite
    /// walls colliding, so not `SHELL_THICKNESS_TOO_LARGE` (SPEC §6.8): `SHELL_FAILED`
    /// naming that face (W6 review round 3).
    Vanishes(usize),
}

struct Cx<'a> {
    plan0: &'a Plan,
    adj: &'a Adj,
    open: BTreeSet<usize>,
    /// The open faces whose edges are all smooth: offset like the others, closed by lateral
    /// rims (see the module docs).
    smooth: BTreeSet<usize>,
    /// Each input face's `v` range (for the torus offsets).
    vrange: Vec<Option<(f64, f64)>>,
    feature: &'a str,
    fkey: Vec<String>,
    fname: Vec<String>,
    outward: bool,
    scale: f64,
    /// The smallest thickness at which two walls meet in closed form ([`closed_forms`]): a
    /// face used up below it vanishes by itself ([`Fail::Vanishes`]); at or above it, the
    /// walls collide across it (`gap`).
    wall_meet: f64,
}

/// The indefinite article for `word` in a message ("an ellipse", "a line").
fn article(word: &str) -> &'static str {
    match word.chars().next() {
        Some('a' | 'e' | 'i' | 'o' | 'u') => "an",
        _ => "a",
    }
}

/// Signed distance of `x` from face `f`'s surface along the outward normal, and that normal
/// at the closest point.
fn signed_dist(f: &PF, x: Point3) -> Option<(f64, Vec3)> {
    let (u, v, _) = f.surf.project(x);
    let p = f.surf.eval(u, v);
    let n = f.surf.normal(u, v)?;
    let n = if f.sense { n } else { -n };
    Some(((x - p).dot(n), n))
}

/// The surface of face `f` offset by `d` along its outward normal; `Err(true)` when a
/// radius reaches zero (curvature), `Err(false)` for an unsupported surface. `vr` is the
/// face's `v` range: a torus face whose tube grows past the axis becomes the outer sheet of
/// a spindle torus, provided the face stays off the axis (`R + r·cos v > 0` over `vr`;
/// reaching the axis is the offset degenerating).
fn offset_surface(f: &PF, d: f64, vr: Option<(f64, f64)>) -> Result<Surface, bool> {
    let sg = if f.sense { 1.0 } else { -1.0 };
    let min = 10.0 * LINEAR_TOLERANCE;
    match &f.surf {
        Surface::Plane(p) => {
            let fr = p.frame();
            let n = fr.z() * sg;
            Ok(Surface::Plane(Plane::new(
                fr.with_origin(fr.origin() + n * d),
            )))
        }
        Surface::Cylinder(c) => {
            let r = c.radius() + sg * d;
            if r <= min {
                return Err(true);
            }
            Cylinder::new(*c.frame(), r)
                .map(Surface::Cylinder)
                .map_err(|_| true)
        }
        Surface::Sphere(s) => {
            let r = s.radius() + sg * d;
            if r <= min {
                return Err(true);
            }
            Sphere::new(*s.frame(), r)
                .map(Surface::Sphere)
                .map_err(|_| true)
        }
        Surface::Cone(c) => {
            let a = c.half_angle();
            let mut r0 = c.radius() + sg * d / forge_core::math::cos(a);
            let mut fr = *c.frame();
            if r0 < min {
                // Re-anchor the frame at a section of positive radius.
                let dv = (min - r0 + 1.0) / forge_core::math::tan(a);
                fr = fr.with_origin(fr.origin() + fr.z() * dv);
                r0 += dv * forge_core::math::tan(a);
            }
            Cone::new(fr, r0, a).map(Surface::Cone).map_err(|_| true)
        }
        Surface::Torus(t) => {
            use forge_core::geom::SpindlePatch;
            let r = t.minor() + sg * d;
            if r <= min {
                return Err(true);
            }
            let big = t.major();
            match t.spindle_patch() {
                Some(SpindlePatch::Inner) => {
                    // The lemon sheet exists only while the tube crosses the axis.
                    if r <= big + min {
                        return Err(true);
                    }
                    Torus::spindle(*t.frame(), big, r, SpindlePatch::Inner)
                        .map(Surface::Torus)
                        .map_err(|_| true)
                }
                _ => {
                    // The face must stay off the axis: R + r·cos v > 0 over its v range.
                    let (v0, v1) = vr.ok_or(false)?;
                    let (c0, _) = crate::interfere::cos_range(v0, v1);
                    if big + r * c0 <= min {
                        return Err(true);
                    }
                    if r <= big {
                        Torus::new(*t.frame(), big, r)
                            .map(Surface::Torus)
                            .map_err(|_| true)
                    } else {
                        Torus::spindle(*t.frame(), big, r, SpindlePatch::Outer)
                            .map(Surface::Torus)
                            .map_err(|_| true)
                    }
                }
            }
        }
        // The offset of a helicoid is not a helicoid: shells of threaded bodies are unsupported.
        Surface::BSpline(_) | Surface::Helicoid(_) => Err(false),
    }
}

/// The point near `x0` where every face `fs[i]` is offset by `ds[i]`: minimum-norm
/// Gauss–Newton on the signed distances.
fn meet(plan: &Plan, fs: &[usize], ds: &[f64], x0: Point3, scale: f64) -> Option<Point3> {
    let mut x = x0;
    for _ in 0..40 {
        let mut rows: Vec<(Vec3, f64)> = Vec::with_capacity(fs.len());
        for (&f, &d) in fs.iter().zip(ds) {
            let (s, n) = signed_dist(plan.fs[f].as_ref()?, x)?;
            rows.push((n, s - d));
        }
        let worst = rows.iter().map(|r| r.1.abs()).fold(0.0, f64::max);
        if worst <= 1e-13 * scale {
            return Some(x);
        }
        // d = −Jᵀ (J Jᵀ + λI)⁻¹ r
        let k = rows.len();
        let mut m = vec![vec![0.0; k + 1]; k];
        for i in 0..k {
            for j in 0..k {
                m[i][j] = rows[i].0.dot(rows[j].0) + if i == j { 1e-12 } else { 0.0 };
            }
            m[i][k] = rows[i].1;
        }
        let y = solve(m)?;
        let mut dx = Vec3::zero();
        for i in 0..k {
            dx -= rows[i].0 * y[i];
        }
        x += dx;
        if !x.is_finite() {
            return None;
        }
    }
    let ok = fs.iter().zip(ds).all(|(&f, &d)| {
        signed_dist(plan.fs[f].as_ref().expect("face"), x)
            .is_some_and(|(s, _)| (s - d).abs() <= 1e-9 * scale)
    });
    ok.then_some(x)
}

/// Where the vertex at `p` of faces `fs` moves when every face there has the same outward
/// normal at `p` (within 1e-9) and moves by the same distance `delta(f)`: `p + δ·n`, exact
/// for analytic offsets (each offset surface holds `p + δ·n_f(p)`). `None` otherwise.
fn smooth_vertex(
    p0: &Plan,
    fs: &[usize],
    p: Point3,
    delta: &dyn Fn(usize) -> f64,
) -> Option<Point3> {
    let d0 = delta(*fs.first()?);
    let mut n0: Option<Vec3> = None;
    for &f in fs {
        if delta(f).to_bits() != d0.to_bits() {
            return None;
        }
        let (_, n) = signed_dist(p0.fs[f].as_ref()?, p)?;
        match n0 {
            None => n0 = Some(n),
            Some(m) => {
                if m.cross(n).norm() > 1e-9 || m.dot(n) <= 0.0 {
                    return None;
                }
            }
        }
    }
    Some(p + n0? * d0)
}

/// Gaussian elimination with partial pivoting on an augmented matrix.
#[allow(clippy::needless_range_loop)]
fn solve(mut m: Vec<Vec<f64>>) -> Option<Vec<f64>> {
    let k = m.len();
    for c in 0..k {
        let p = (c..k).max_by(|&a, &b| m[a][c].abs().total_cmp(&m[b][c].abs()))?;
        m.swap(c, p);
        let piv = m[c][c];
        if piv.abs() <= 1e-300 {
            return None;
        }
        for r in (c + 1)..k {
            let f = m[r][c] / piv;
            for j in c..=k {
                m[r][j] -= f * m[c][j];
            }
        }
    }
    let mut y = vec![0.0; k];
    for r in (0..k).rev() {
        let mut s = m[r][k];
        for j in (r + 1)..k {
            s -= m[r][j] * y[j];
        }
        y[r] = s / m[r][r];
    }
    Some(y)
}

struct Built {
    plan: Plan,
}

/// Is face `f` offset (every face but the openings with convex edges)?
fn is_offset(cx: &Cx<'_>, f: usize) -> bool {
    !cx.open.contains(&f) || cx.smooth.contains(&f)
}

/// The outward unit normal of planar face `f`.
fn plane_normal(f: &PF) -> Option<Vec3> {
    match &f.surf {
        Surface::Plane(p) => Some(if f.sense {
            p.frame().z()
        } else {
            -p.frame().z()
        }),
        _ => None,
    }
}

/// The vertices of face `f`'s loops, in order, without repeats.
fn face_vertices(p: &Plan, f: usize) -> Vec<usize> {
    let mut out = Vec::new();
    for u in p.fs[f]
        .as_ref()
        .map(|x| x.loops.concat())
        .unwrap_or_default()
    {
        if let Some(v) = p.use_start(&u)
            && !out.contains(&v)
        {
            out.push(v);
        }
    }
    out
}

/// The walls that close up the offset of edge `pe` (between the faces `own`) when it
/// collapses or turns over: the faces at its two end vertices other than its own two, whose
/// offsets approach each other along it (a slot's two walls, the floor of an open box and
/// its opening) — the edge's own faces are a consequence of that collision, not its cause
/// (W6 review round 5). Its own faces when its vertices have no others.
fn colliding_walls(cx: &Cx<'_>, pe: &PE, own: &BTreeSet<usize>) -> BTreeSet<usize> {
    let mut out = BTreeSet::new();
    for v in [pe.start, pe.end].into_iter().flatten() {
        for c in &cx.adj.corners[v] {
            if !own.contains(&c.face) {
                out.insert(c.face);
            }
        }
    }
    if out.is_empty() { own.clone() } else { out }
}

/// One construction at thickness `t`. `collect`: gather every violation (for the limits);
/// otherwise stop at the first proven one (a verdict for the feasible-range search).
fn attempt(cx: &Cx<'_>, t: f64, collect: bool) -> Result<Built, Fail> {
    let p0 = cx.plan0;
    let nf = p0.fs.len();
    let delta = |f: usize| -> f64 {
        if !is_offset(cx, f) {
            0.0
        } else if cx.outward {
            t
        } else {
            -t
        }
    };
    let mut viol: Vec<Viol> = Vec::new();
    // Offset surfaces.
    let mut surf: Vec<Surface> = Vec::with_capacity(nf);
    for f in 0..nf {
        let face = p0.fs[f].as_ref().expect("face");
        if !is_offset(cx, f) {
            surf.push(face.surf.clone());
            continue;
        }
        match offset_surface(face, delta(f), cx.vrange[f]) {
            Ok(s) => surf.push(s),
            Err(true) => {
                viol.push(Viol {
                    faces: [f].into_iter().collect(),
                    reason: ShellLimitReason::Curvature,
                    what: format!("the offset of {} degenerates", cx.fname[f]),
                });
                surf.push(face.surf.clone());
            }
            Err(false) => {
                return Err(Fail::Failed(format!(
                    "offsetting the {} face {} is not supported",
                    face.surf.kind_name(),
                    cx.fname[f]
                )));
            }
        }
    }
    if !viol.is_empty() {
        return Err(Fail::Infeasible(viol));
    }
    // A plan whose faces carry the offset surfaces (for the signed distances).
    let mut off = p0.clone();
    for (f, s) in surf.iter().enumerate() {
        off.fs[f].as_mut().expect("face").surf = s.clone();
    }
    // Offset vertices.
    let mut vpos: Vec<Point3> = Vec::with_capacity(p0.vs.len());
    for (v, pv) in p0.vs.iter().enumerate() {
        let mut fs: Vec<usize> = cx.adj.corners[v].iter().map(|c| c.face).collect();
        fs.sort_unstable();
        fs.dedup();
        if fs.is_empty() {
            vpos.push(pv.p);
            continue;
        }
        // A smooth vertex (every face there has the same outward normal and moves by the
        // same distance: a blended corner) moves exactly along that normal — Gauss–Newton on
        // nearly parallel offsets would place it a few 1e-6 mm off along them.
        if let Some(x) = smooth_vertex(p0, &fs, pv.p, &delta) {
            vpos.push(x);
            continue;
        }
        let zeros = vec![0.0; fs.len()];
        let Some(x) = meet(&off, &fs, &zeros, pv.p, cx.scale) else {
            // Not a proof of anything (W6 review round 5): a vertex of more than three faces
            // whose offsets have no common point needs a topology change there (a new edge
            // between two of its faces, as OCCT builds it), which this construction does not
            // make, at every thickness; with three faces or fewer the solve did not converge.
            // Neither is an offset degenerating or walls colliding (SPEC §6.8): SHELL_FAILED
            // naming the vertex and its faces, never a size limit.
            let names: Vec<&str> = fs.iter().map(|&f| cx.fname[f].as_str()).collect();
            let at = format!("({:.4}, {:.4}, {:.4})", pv.p.x, pv.p.y, pv.p.z);
            if fs.len() > 3 {
                return Err(Fail::Failed(format!(
                    "the offsets of the {} faces around the vertex at {at} ({}) do not meet at one point: offsetting a vertex of more than three faces needs a topology change there, which shell does not implement",
                    fs.len(),
                    names.join(", ")
                )));
            }
            return Err(Fail::Unverified(format!(
                "the point where the offsets of the faces around the vertex at {at} ({}) meet was not found (the solve did not converge, which does not prove that they do not meet)",
                names.join(", ")
            )));
        };
        vpos.push(x);
    }
    if !viol.is_empty() {
        return Err(Fail::Infeasible(viol));
    }
    // A smooth opening's lateral rims run along its normal: every corner must move by
    // exactly `delta·n` (all faces around it share the normal there).
    for &x in &cx.smooth {
        let n = plane_normal(p0.fs[x].as_ref().expect("face")).expect("planar opening");
        for v in face_vertices(p0, x) {
            let want = p0.vs[v].p + n * delta(x);
            if vpos[v].distance(want) > 1e-9 * cx.scale.max(1.0) {
                return Err(Fail::Failed(format!(
                    "the opening {} is not smooth at its corner ({:.4}, {:.4}, {:.4}): the faces there do not all share its normal, so its lateral rim is not defined",
                    cx.fname[x], p0.vs[v].p.x, p0.vs[v].p.y, p0.vs[v].p.z
                )));
            }
        }
    }
    // A face used up below the closed-form meeting of two walls: the shell fails naming it
    // — unless the whole offset body collapses there (its walls collide, SPEC §6.8's
    // `gap`: W6 review round 6), when the checks below prove the thickness infeasible (the
    // collapsed body's offset edges turn over) or the thin body is built and checked.
    if t < cx.wall_meet
        && let Some(f) = vanishing(cx, &vpos)
        && collapse_thickness(cx, f, t).is_none()
    {
        return Err(Fail::Vanishes(f));
    }
    // Offset edges.
    let mut edges: Vec<PE> = Vec::with_capacity(p0.es.len());
    for (e, pe) in p0.es.iter().enumerate() {
        let fs = cx.adj.edge_faces(e);
        if fs.len() != 2 {
            return Err(Fail::Failed(
                "an edge does not lie between two faces".into(),
            ));
        }
        let fset: BTreeSet<usize> = fs.iter().copied().collect();
        let curve = match &pe.curve {
            Curve3::Line(l) => {
                let (Some(s), Some(en)) = (pe.start, pe.end) else {
                    return Err(Fail::Failed("a line ring edge".into()));
                };
                let (a, b) = (vpos[s], vpos[en]);
                let along = (b - a).dot(l.dir());
                if along.is_nan() || along <= 10.0 * LINEAR_TOLERANCE {
                    viol.push(Viol {
                        faces: colliding_walls(cx, pe, &fset),
                        reason: ShellLimitReason::Gap,
                        what: "an offset edge collapses or turns over".into(),
                    });
                    continue;
                }
                crate::geom::line(a, l.dir()).expect("line")
            }
            Curve3::Circle(c) => {
                let fr = c.frame();
                let tm = 0.5 * (pe.range.0 + pe.range.1);
                let p = pe.curve.eval(tm);
                // Along a smooth edge (the faces tangent there) the offset point is exact.
                let Some(x) = smooth_vertex(p0, &fs, p, &delta)
                    .or_else(|| meet(&off, &fs, &[0.0, 0.0], p, cx.scale))
                else {
                    // A solve that does not converge proves nothing (W6 review round 5).
                    return Err(Fail::Unverified(format!(
                        "the point where the offsets of {} and {} meet on their circle edge was not found (the solve did not converge, which does not prove that they do not meet)",
                        cx.fname[fs[0]], cx.fname[fs[1]]
                    )));
                };
                let z = fr.z();
                let w = x - fr.origin();
                let h = w.dot(z);
                let rad = (w - z * h).norm();
                if rad <= 10.0 * LINEAR_TOLERANCE {
                    viol.push(Viol {
                        faces: fset,
                        reason: ShellLimitReason::Curvature,
                        what: "an offset circle shrinks to its axis".into(),
                    });
                    continue;
                }
                Curve3::Circle(
                    Circle3::new(fr.with_origin(fr.origin() + z * h), rad)
                        .map_err(|_| Fail::Failed("degenerate offset circle".into()))?,
                )
            }
            other => {
                let kind = other.kind_name();
                return Err(Fail::Failed(format!(
                    "offsetting {} {kind} edge (between {} and {}) is not supported: shell offsets line and circle edges only — the mitre where two fillets meet at a corner is an ellipse or a B-spline (a documented deferral: shells of bodies with mitred blends)",
                    article(kind),
                    cx.fname[fs[0]],
                    cx.fname[fs[1]]
                )));
            }
        };
        // The new curve must lie on both offset surfaces.
        let range = match (pe.start, pe.end) {
            (Some(s), Some(en)) => {
                let (ts, _) = curve.project(vpos[s]);
                let (te, _) = curve.project(vpos[en]);
                let (ts, te) = match curve.period() {
                    Some(per) => {
                        let ts = ts + ((pe.range.0 - ts) / per).round() * per;
                        let te = te + ((pe.range.1 - te) / per).round() * per;
                        (ts, te)
                    }
                    None => (ts, te),
                };
                let len = crate::geom::length(&curve, (ts, te.max(ts)));
                if len.is_nan() || len <= 10.0 * LINEAR_TOLERANCE || te <= ts {
                    viol.push(Viol {
                        faces: colliding_walls(cx, pe, &fset),
                        reason: ShellLimitReason::Gap,
                        what: "an offset edge collapses".into(),
                    });
                    continue;
                }
                (ts, te)
            }
            _ => pe.range,
        };
        for k in 0..=4 {
            let q = curve.eval(range.0 + (range.1 - range.0) * k as f64 / 4.0);
            for &f in &fs {
                let (s, _) = signed_dist(off.fs[f].as_ref().expect("face"), q)
                    .ok_or_else(|| Fail::Failed("degenerate normal".into()))?;
                if s.abs() > 1e-7 * cx.scale.max(1.0) {
                    return Err(Fail::Failed(format!(
                        "internal: an offset edge is {s:.3e} mm off an offset face of {}",
                        cx.fname[f]
                    )));
                }
            }
        }
        edges.push(PE {
            curve,
            range,
            start: pe.start,
            end: pe.end,
            tol: LINEAR_TOLERANCE,
            prov: pe.prov.clone(),
        });
    }
    if !viol.is_empty() {
        return Err(Fail::Infeasible(viol));
    }
    // Keys of the new faces.
    let offset_key = |f: usize| crate::keys::derived(cx.feature, "offset", &cx.fkey[f]).key();
    let rim_key = |f: usize| crate::keys::derived(cx.feature, "rim", &cx.fkey[f]).key();
    // In the result, which key the face at position f of the *offset* body carries.
    let new_face_key = |f: usize| {
        if cx.open.contains(&f) {
            rim_key(f)
        } else {
            offset_key(f)
        }
    };
    // Assemble: the result starts as the input plan; the offset body's vertices and edges are
    // appended.
    let mut res = p0.clone();
    let vbase = res.vs.len();
    for (v, x) in vpos.iter().enumerate() {
        let mut fs: Vec<usize> = cx.adj.corners[v].iter().map(|c| c.face).collect();
        fs.sort_unstable();
        fs.dedup();
        let keys: Vec<String> = fs.iter().map(|&f| new_face_key(f)).collect();
        res.add_v(*x, crate::keys::vertex_at(cx.feature, &keys));
    }
    let ebase = res.es.len();
    for (e, pe) in edges.into_iter().enumerate() {
        let fs = cx.adj.edge_faces(e);
        let prov =
            crate::keys::edge_between(cx.feature, &new_face_key(fs[0]), &new_face_key(fs[1]));
        res.add_e(PE {
            start: pe.start.map(|v| v + vbase),
            end: pe.end.map(|v| v + vbase),
            prov,
            ..pe
        });
    }
    // The joins `v → v'` of a smooth opening's lateral rims (along its normal).
    let mut join: BTreeMap<usize, usize> = BTreeMap::new();
    for &x in &cx.smooth {
        let n = plane_normal(p0.fs[x].as_ref().expect("face")).expect("planar opening");
        let dir = if cx.outward { n } else { -n };
        for v in face_vertices(p0, x) {
            if join.contains_key(&v) {
                continue;
            }
            let curve = crate::geom::line(p0.vs[v].p, dir).expect("line");
            let t1 = curve.project(vpos[v]).0;
            let i = res.add_e(PE {
                curve,
                range: (0.0, t1),
                start: Some(v),
                end: Some(v + vbase),
                tol: LINEAR_TOLERANCE,
                prov: crate::keys::derived(cx.feature, "rim", &p0.vs[v].prov.key()),
            });
            join.insert(v, i);
        }
    }
    // Loops of the offset body's face f (same traversal as the input, no pcurves).
    let off_loops = |f: usize| -> Vec<Vec<PU>> {
        p0.fs[f]
            .as_ref()
            .expect("face")
            .loops
            .iter()
            .map(|lp| {
                lp.iter()
                    .map(|u| PU {
                        edge: u.edge + ebase,
                        fwd: u.fwd,
                        pc: None,
                    })
                    .collect()
            })
            .collect()
    };
    let reversed = |lp: &[PU]| -> Vec<PU> {
        lp.iter()
            .rev()
            .map(|u| PU {
                edge: u.edge,
                fwd: !u.fwd,
                pc: u.pc.clone(),
            })
            .collect()
    };
    let closed_void = cx.open.is_empty();
    let inner_shell = if closed_void {
        res.shells.push(true);
        res.shells.len() - 1
    } else {
        0
    };
    // Rims, and whether each is a lateral one.
    let mut rims: Vec<(PF, bool)> = Vec::new();
    // Faces added to the result, with the input face they come from.
    let mut added: Vec<(usize, PF)> = Vec::new();
    for (f, surf_f) in surf.iter().enumerate() {
        let face = p0.fs[f].as_ref().expect("face").clone();
        let orig_loops = face.loops.clone();
        let o_loops = off_loops(f);
        if cx.smooth.contains(&f) {
            // Lateral rims, one per edge (see the module docs).
            let prov = crate::keys::derived(cx.feature, "rim", &cx.fkey[f]);
            let n = plane_normal(&face).expect("planar opening");
            for lp in &orig_loops {
                for u in lp {
                    rims.push((lateral(cx, p0, u, n, ebase, &join, prov.clone())?, true));
                }
            }
            res.fs[f] = None;
            continue;
        }
        if cx.open.contains(&f) {
            // Big = outer body's face, small = inner body's face at the opening.
            let (big, small) = if cx.outward {
                (o_loops, orig_loops)
            } else {
                (orig_loops, o_loops)
            };
            let prov = crate::keys::derived(cx.feature, "rim", &cx.fkey[f]);
            rims.push((
                PF {
                    surf: face.surf.clone(),
                    sense: face.sense,
                    prov: prov.clone(),
                    loops: vec![big[0].clone(), reversed(&small[0])],
                    shell: 0,
                    hint: None,
                },
                false,
            ));
            for i in 1..big.len() {
                rims.push((
                    PF {
                        surf: face.surf.clone(),
                        sense: face.sense,
                        prov: prov.clone(),
                        loops: vec![reversed(&small[i]), big[i].clone()],
                        shell: 0,
                        hint: None,
                    },
                    false,
                ));
            }
            res.fs[f] = None;
            continue;
        }
        let off_face = PF {
            surf: surf_f.clone(),
            sense: face.sense,
            prov: crate::keys::derived(cx.feature, "offset", &cx.fkey[f]),
            loops: o_loops,
            shell: 0,
            hint: None,
        };
        if cx.outward {
            // Outer wall: the offset face; inner wall: the input face reversed.
            let inner = PF {
                surf: face.surf.clone(),
                sense: !face.sense,
                prov: face.prov.clone(),
                loops: orig_loops.iter().map(|l| reversed(l)).collect(),
                shell: inner_shell,
                hint: None,
            };
            res.fs[f] = Some(off_face);
            added.push((f, inner));
        } else {
            let inner = PF {
                sense: !off_face.sense,
                loops: off_face.loops.iter().map(|l| reversed(l)).collect(),
                shell: inner_shell,
                hint: None,
                ..off_face
            };
            added.push((f, inner));
        }
    }
    let mut check_faces: Vec<usize> = Vec::new();
    let mut lat_faces: Vec<usize> = Vec::new();
    for (pf, is_lat) in rims {
        let i = res.add_f(pf);
        check_faces.push(i);
        if is_lat {
            lat_faces.push(i);
        }
    }
    let mut added_idx: Vec<(usize, usize)> = Vec::new();
    for (f, pf) in added {
        let i = res.add_f(pf);
        check_faces.push(i);
        added_idx.push((i, f));
    }
    if cx.outward {
        check_faces.extend((0..nf).filter(|f| res.fs[*f].is_some()));
    }
    // Pcurves, then crossings.
    let dev = res
        .fill_pcurves()
        .map_err(|m| Fail::Failed(format!("internal: {m}")))?;
    for (e, d) in dev {
        res.es[e].tol = res.es[e].tol.max(2.0 * d);
    }
    let owner = |f: usize| -> BTreeSet<usize> {
        // Map a result face back to input faces (by key).
        let key = res.fs[f].as_ref().map(|x| x.prov.key()).unwrap_or_default();
        (0..nf)
            .filter(|&g| cx.fkey[g] == key || offset_key(g) == key || rim_key(g) == key)
            .collect()
    };
    let mut unresolved: Option<String> = None;
    for &f in &check_faces {
        let (pairs, open) = crate::check::face_crossings_ex(&res, f);
        if pairs.is_empty() {
            if !open.is_empty() && unresolved.is_none() {
                let own: Vec<String> = owner(f).iter().map(|&g| cx.fname[g].clone()).collect();
                unresolved = Some(format!(
                    "the boundary of the wall from {} cannot be certified free of self-crossings (budget)",
                    own.join(" and ")
                ));
            }
            continue;
        }
        // The walls whose offsets collide are the faces on the other side of the crossing
        // edges (an edge of the result is an input edge or the offset copy of one).
        let own = owner(f);
        let mut faces: BTreeSet<usize> = BTreeSet::new();
        for (a, b) in &pairs {
            for e in [*a, *b] {
                let orig = if e >= ebase { e - ebase } else { e };
                if orig < p0.es.len() {
                    faces.extend(
                        cx.adj
                            .edge_faces(orig)
                            .into_iter()
                            .filter(|g| !own.contains(g)),
                    );
                }
            }
        }
        let names: Vec<String> = faces.iter().map(|&g| cx.fname[g].clone()).collect();
        let what = if names.is_empty() {
            "an offset face's boundary crosses itself".to_string()
        } else {
            format!(
                "the offset walls of {} collide (the boundary of an offset face crosses itself)",
                names.join(" and ")
            )
        };
        viol.push(Viol {
            faces: if faces.is_empty() { own } else { faces },
            reason: ShellLimitReason::Gap,
            what,
        });
        if !collect {
            break;
        }
    }
    if !viol.is_empty() {
        return Err(Fail::Infeasible(viol));
    }
    // Walls: the offset body must not intersect itself, nor the input except where they are
    // joined at the openings (certified; see `crate::interfere`).
    let parts = Parts {
        added: &added_idx,
        lateral: &lat_faces,
        surf: &surf,
        ebase,
        vbase,
    };
    collisions(cx, &res, &parts, &off_loops, collect)?;
    if let Some(m) = unresolved {
        return Err(Fail::Unverified(m));
    }
    Ok(Built { plan: res })
}

/// The lateral rim of a smooth opening along its use `u` (normal `n`): between the input
/// edge and its offset (`ebase` apart), joined at the vertices by the edges in `join`. Its
/// surface is the plane through a line edge along `n`, or the cylinder through a circle edge
/// about its axis; its outward normal is `n × t` (`t` the edge's direction in the opening's
/// loop: towards the opening's interior, where the wall ends). Loop, `E` running as in the
/// opening, `E'` its offset (inward: `E` on the outer body):
/// inward `E (a→b), join b→b', E' (b'→a'), join a'→a`; outward
/// `E' (a'→b'), join b'→b, E (b→a), join a→a'`. A ring edge gives two loops.
fn lateral(
    cx: &Cx<'_>,
    p0: &Plan,
    u: &PU,
    n: Vec3,
    ebase: usize,
    join: &BTreeMap<usize, usize>,
    prov: forge_core::topo::Provenance,
) -> Result<PF, Fail> {
    let pe = &p0.es[u.edge];
    let tm = 0.5 * (pe.range.0 + pe.range.1);
    let at = pe.curve.eval(tm);
    let tan = pe
        .curve
        .d1(tm)
        .normalize()
        .ok_or_else(|| Fail::Failed("a degenerate opening edge".into()))?;
    let tan = if u.fwd { tan } else { -tan };
    let out = n.cross(tan);
    let (surf, sense) = match &pe.curve {
        Curve3::Line(_) => {
            let fr = crate::geom::frame_zx(at, out, tan)
                .ok_or_else(|| Fail::Failed("a degenerate lateral rim".into()))?;
            (Surface::Plane(Plane::new(fr)), true)
        }
        Curve3::Circle(c) => {
            let cyl = Cylinder::new(*c.frame(), c.radius())
                .map_err(|_| Fail::Failed("a degenerate lateral rim".into()))?;
            let radial = at - c.frame().origin();
            let radial = radial - c.frame().z() * radial.dot(c.frame().z());
            (Surface::Cylinder(cyl), radial.dot(out) > 0.0)
        }
        other => {
            let kind = other.kind_name();
            return Err(Fail::Failed(format!(
                "a lateral rim along {} {kind} edge is not supported",
                article(kind)
            )));
        }
    };
    let e = u.edge;
    let e2 = u.edge + ebase;
    let pu = |edge: usize, fwd: bool| PU {
        edge,
        fwd,
        pc: None,
    };
    let loops = match (p0.use_start(u), p0.use_end(u)) {
        (Some(a), Some(b)) => {
            let (ja, jb) = (join[&a], join[&b]);
            if cx.outward {
                vec![vec![
                    pu(e2, u.fwd),
                    pu(jb, false),
                    pu(e, !u.fwd),
                    pu(ja, true),
                ]]
            } else {
                vec![vec![
                    pu(e, u.fwd),
                    pu(jb, true),
                    pu(e2, !u.fwd),
                    pu(ja, false),
                ]]
            }
        }
        _ => {
            if cx.outward {
                vec![vec![pu(e2, u.fwd)], vec![pu(e, !u.fwd)]]
            } else {
                vec![vec![pu(e, u.fwd)], vec![pu(e2, !u.fwd)]]
            }
        }
    };
    Ok(PF {
        surf,
        sense,
        prov,
        loops,
        shell: 0,
        hint: None,
    })
}

/// The first face that vanishes under the offset: a planar face bounded by one loop of line
/// edges (a polygon) whose offset polygon — its vertices moved to `vpos` — has lost its area
/// or turned over (signed area, in the face's plane, at most `10·tol` times its perimeter, or
/// of the opposite sign to the input's). A bevel or a narrow step between two walls is used
/// up this way when the walls' offsets meet across it.
fn vanishing(cx: &Cx<'_>, vpos: &[Point3]) -> Option<usize> {
    (0..cx.plan0.fs.len()).find(|&f| vanishes(cx, f, vpos))
}

/// Does face `f` vanish with its vertices at `vpos` (see [`vanishing`])?
fn vanishes(cx: &Cx<'_>, f: usize, vpos: &[Point3]) -> bool {
    let p0 = cx.plan0;
    let Some(face) = p0.fs[f].as_ref() else {
        return false;
    };
    if cx.open.contains(&f) || face.loops.len() != 1 {
        return false;
    }
    let Surface::Plane(pl) = &face.surf else {
        return false;
    };
    let lp = &face.loops[0];
    if lp.len() < 3
        || lp
            .iter()
            .any(|u| !matches!(p0.es[u.edge].curve, Curve3::Line(_)))
    {
        return false;
    }
    let Some(vs) = lp
        .iter()
        .map(|u| p0.use_start(u))
        .collect::<Option<Vec<usize>>>()
    else {
        return false;
    };
    let fr = pl.frame();
    let area = |pts: &dyn Fn(usize) -> Point3| -> (f64, f64) {
        let q: Vec<_> = vs
            .iter()
            .map(|&v| fr.to_local_point(pts(v)).truncate())
            .collect();
        let n = q.len();
        let a: f64 = (0..n).map(|i| q[i].perp_dot(q[(i + 1) % n])).sum::<f64>() * 0.5;
        let per: f64 = (0..n).map(|i| q[i].distance(q[(i + 1) % n])).sum();
        (a, per)
    };
    let (a0, _) = area(&|v| p0.vs[v].p);
    let (a1, per1) = area(&|v| vpos[v]);
    a0 != 0.0 && a1 * a0.signum() <= 10.0 * LINEAR_TOLERANCE * per1
}

/// The mean width `2V/A` of the offset body with its vertices at `vpos` — its volume `V` and
/// area `A` as a polyhedron (a slab of width `w` has `2V/A ≈ w`; a body turned inside out has
/// `V < 0`) — when every face is a plane bounded by line edges; `None` otherwise.
fn polyhedron_width(cx: &Cx<'_>, vpos: &[Point3]) -> Option<f64> {
    let p0 = cx.plan0;
    let (mut vol, mut area) = (0.0f64, 0.0f64);
    for face in p0.fs.iter().flatten() {
        if !matches!(face.surf, Surface::Plane(_)) {
            return None;
        }
        let mut av = Vec3::new(0.0, 0.0, 0.0);
        for lp in &face.loops {
            let mut pts: Vec<Point3> = Vec::with_capacity(lp.len());
            for u in lp {
                if !matches!(p0.es[u.edge].curve, Curve3::Line(_)) {
                    return None;
                }
                pts.push(vpos[p0.use_start(u)?]);
            }
            let Some(&o) = pts.first() else { continue };
            for i in 1..pts.len().saturating_sub(1) {
                let (a, b) = (pts[i] - o, pts[i + 1] - o);
                let c = a.cross(b);
                av += c;
                vol += (o - Point3::new(0.0, 0.0, 0.0)).dot(c);
            }
        }
        area += 0.5 * av.norm();
    }
    (area > 0.0).then_some(2.0 * (vol / 6.0) / area)
}

/// The thickness at which the offset body **collapses** (W6 review round 6), when face `f` —
/// which vanishes at thickness `t` — vanishes because the whole offset body is used up there
/// (an inward shell of a triangular or pentagonal prism, a wedge, a box between two walls
/// just less than `2t` apart): at the first thickness where `f` has vanished (bisected to
/// 1e-12 relative), the body's mean width (see [`polyhedron_width`]) is at most `40·tol` or
/// negative. That is opposite walls colliding (SPEC §6.8, `gap`), not a face used up while
/// the body goes on (a narrow bevel between two walls: then `None`, and the shell is
/// `SHELL_FAILED` naming the face). `None` too when the width cannot be computed (a curved
/// face) — the failure stays explicit.
fn collapse_thickness(cx: &Cx<'_>, f: usize, t: f64) -> Option<f64> {
    let gone = |x: f64| -> Option<bool> {
        let vpos = offset_vertices(cx, x)?;
        Some(vanishes(cx, f, &vpos))
    };
    if !gone(t)? {
        return None;
    }
    let (mut lo, mut hi) = (0.0f64, t);
    for _ in 0..100 {
        if hi - lo <= 1e-12 * t.max(1.0) {
            break;
        }
        let mid = 0.5 * (lo + hi);
        if gone(mid)? {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    let vpos = offset_vertices(cx, hi)?;
    let w = polyhedron_width(cx, &vpos)?;
    (w <= 40.0 * LINEAR_TOLERANCE && lo > 0.0).then_some(lo)
}

/// The thickness at which the offset body collapses below `t` ([`collapse_thickness`]),
/// found from the face that vanishes at `t` — a closed-form candidate of the feasible range
/// (W6 review round 6), confirmed by construction like the others.
fn collapse_at(cx: &Cx<'_>, t: f64) -> Option<f64> {
    let vpos = offset_vertices(cx, t)?;
    let f = vanishing(cx, &vpos)?;
    collapse_thickness(cx, f, t)
}

/// The largest thickness below `t` (to 1e-4 mm) at which face `f` does not vanish yet, when
/// the offset vertices can be computed there (for the message).
fn vanish_limit(cx: &Cx<'_>, f: usize, t: f64) -> Option<f64> {
    let gone = |x: f64| -> Option<bool> {
        let vpos = offset_vertices(cx, x)?;
        Some(vanishes(cx, f, &vpos))
    };
    let (mut lo, mut hi) = (0.0f64, t);
    for _ in 0..64 {
        if hi - lo <= 1e-4 {
            break;
        }
        let mid = 0.5 * (lo + hi);
        if gone(mid)? {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    (lo > 0.0).then_some(lo)
}

/// The offset body's vertex positions at thickness `t` (`None` when an offset surface
/// degenerates or the faces around a vertex do not meet).
fn offset_vertices(cx: &Cx<'_>, t: f64) -> Option<Vec<Point3>> {
    let p0 = cx.plan0;
    let mut off = p0.clone();
    for (f, pf) in off.fs.iter_mut().enumerate() {
        let Some(pf) = pf else { continue };
        if !is_offset(cx, f) {
            continue;
        }
        let d = if cx.outward { t } else { -t };
        pf.surf = offset_surface(p0.fs[f].as_ref()?, d, cx.vrange[f]).ok()?;
    }
    p0.vs
        .iter()
        .enumerate()
        .map(|(v, pv)| {
            let mut fs: Vec<usize> = cx.adj.corners[v].iter().map(|c| c.face).collect();
            fs.sort_unstable();
            fs.dedup();
            if fs.is_empty() {
                return Some(pv.p);
            }
            meet(&off, &fs, &vec![0.0; fs.len()], pv.p, cx.scale)
        })
        .collect()
}

/// The parts of an assembled result [`collisions`] needs: its faces added after the input's
/// (with the input face each comes from), the lateral rims, the offset surfaces, and where
/// the offset body's edges and vertices start.
struct Parts<'a> {
    added: &'a [(usize, usize)],
    lateral: &'a [usize],
    surf: &'a [Surface],
    ebase: usize,
    vbase: usize,
}

/// The certified wall-collision check. `res` is the assembled result (pcurves filled); the
/// input's edges and vertices keep their indices, the offset body's start at `ebase` and
/// `vbase`. Virtual faces are added to a copy: per opening `X` with convex edges, the offset
/// body's face on `X`'s plane (bounded by the offset edges) and `X` itself; per smooth
/// opening, its offset `X'` (the offset body is closed there) and `X` itself. Pairs checked:
/// - offset body × offset body (with those virtual faces): it must not intersect itself —
///   walls colliding, a wall pushed through an opening;
/// - offset body × input (with the openings as regions): the offset must stay off the
///   input's faces, except that a wall offset from a face next to a convex opening ends on
///   the opening's plane (inward: inside it) along its offset edge;
/// - outward: the offset body's face on a convex opening's plane (whose part outside the
///   opening becomes the rim) × the input's faces, except along the opening's own edges;
/// - the lateral rims of smooth openings × everything else.
///
/// The first **proven** contact decides (`collect`: every one is gathered, for the limits).
/// A pair that cannot be certified either way is [`Fail::Unverified`] naming it — unless a
/// proven contact is found among the other pairs.
fn collisions(
    cx: &Cx<'_>,
    res: &Plan,
    parts: &Parts<'_>,
    off_loops: &dyn Fn(usize) -> Vec<Vec<PU>>,
    collect: bool,
) -> Result<(), Fail> {
    use crate::interfere::{Checker, Outcome, Shared};
    let (added, ebase, vbase) = (parts.added, parts.ebase, parts.vbase);
    let p0 = cx.plan0;
    let nf = p0.fs.len();
    let mut chk = res.clone();
    let mut owner: BTreeMap<usize, usize> = BTreeMap::new();
    for f in 0..nf {
        owner.insert(f, f);
    }
    for &(i, f) in added {
        owner.insert(i, f);
    }
    for &i in parts.lateral {
        let key = res.fs[i].as_ref().expect("rim").prov.key();
        if let Some(x) = cx
            .smooth
            .iter()
            .copied()
            .find(|&x| crate::keys::derived(cx.feature, "rim", &cx.fkey[x]).key() == key)
        {
            owner.insert(i, x);
        }
    }
    let mut virt_off: Vec<(usize, usize)> = Vec::new();
    let mut virt_in: Vec<(usize, usize)> = Vec::new();
    for &f in &cx.open {
        let face = p0.fs[f].as_ref().expect("face");
        let surf = if cx.smooth.contains(&f) {
            parts.surf[f].clone()
        } else {
            face.surf.clone()
        };
        let i = chk.add_f(PF {
            surf,
            sense: face.sense,
            prov: face.prov.clone(),
            loops: off_loops(f),
            shell: 0,
            hint: None,
        });
        owner.insert(i, f);
        virt_off.push((i, f));
        let j = chk.add_f(PF {
            loops: face.loops.clone(),
            hint: None,
            ..face.clone()
        });
        owner.insert(j, f);
        virt_in.push((j, f));
    }
    chk.fill_pcurves()
        .map_err(|m| Fail::Failed(format!("internal: {m}")))?;
    // The two bodies' faces in `chk`.
    let (off_faces, in_faces): (Vec<usize>, Vec<usize>) = if cx.outward {
        (
            (0..nf).filter(|f| !cx.open.contains(f)).collect(),
            added.iter().map(|x| x.0).collect(),
        )
    } else {
        (
            added.iter().map(|x| x.0).collect(),
            (0..nf).filter(|f| !cx.open.contains(f)).collect(),
        )
    };
    let mut all: Vec<usize> = off_faces.clone();
    all.extend(in_faces.iter().copied());
    all.extend(virt_off.iter().map(|x| x.0));
    all.extend(virt_in.iter().map(|x| x.0));
    all.extend(parts.lateral.iter().copied());
    let mut ck = Checker::new(&chk, &all);
    ck.band_g1 = true;
    let edges_of = |f: usize| -> BTreeSet<usize> {
        p0.fs[f]
            .as_ref()
            .map(|x| x.loops.iter().flatten().map(|u| u.edge).collect())
            .unwrap_or_default()
    };
    // Input edges between input faces `a` and `b`.
    let common = |a: usize, b: usize| -> Vec<usize> {
        let eb = edges_of(b);
        edges_of(a).into_iter().filter(|e| eb.contains(e)).collect()
    };
    let shared_of = |edges: Vec<usize>, shift_e: usize, shift_v: usize| -> Shared {
        let mut points = Vec::new();
        for &e in &edges {
            for v in [p0.es[e].start, p0.es[e].end].into_iter().flatten() {
                points.push(chk.vs[v + shift_v].p);
            }
        }
        Shared {
            edges: edges.iter().map(|e| e + shift_e).collect(),
            points,
        }
    };
    let mut pairs: Vec<(usize, usize, Shared)> = Vec::new();
    let mut offs: Vec<usize> = off_faces.clone();
    offs.extend(virt_off.iter().map(|x| x.0));
    for (i, &a) in offs.iter().enumerate() {
        for &b in &offs[i + 1..] {
            pairs.push((a, b, ck.topo_shared(a, b)));
        }
    }
    let virt_in_of: BTreeMap<usize, usize> = virt_in.iter().copied().collect();
    for &a in &off_faces {
        let fa = owner[&a];
        for &b in in_faces.iter().chain(virt_in.iter().map(|x| &x.0)) {
            let fb = owner[&b];
            if fa == fb && !virt_in_of.contains_key(&b) {
                // A face and its own offset are parallel.
                continue;
            }
            // A wall next to a convex opening ends on its plane along its offset edge; a
            // smooth opening's offset stays clear of it.
            let sh = if virt_in_of.contains_key(&b) && !cx.smooth.contains(&fb) {
                shared_of(common(fa, fb), ebase, vbase)
            } else {
                Shared::default()
            };
            pairs.push((a, b, sh));
        }
    }
    if cx.outward {
        for &(a, t) in &virt_off {
            if cx.smooth.contains(&t) {
                continue;
            }
            for &b in &in_faces {
                pairs.push((a, b, shared_of(common(owner[&b], t), 0, 0)));
            }
        }
    }
    // Lateral rims against everything else (and each other).
    let mut others: Vec<usize> = offs.clone();
    others.extend(in_faces.iter().copied());
    others.extend(virt_in.iter().map(|x| x.0));
    for (i, &a) in parts.lateral.iter().enumerate() {
        for &b in others.iter().chain(&parts.lateral[i + 1..]) {
            pairs.push((a, b, ck.topo_shared(a, b)));
        }
    }
    let mut viol: Vec<Viol> = Vec::new();
    let mut unverified: Option<String> = None;
    for (a, b, sh) in &pairs {
        let (fa, fb) = (owner[a], owner[b]);
        let what = match ck.pair(*a, *b, sh) {
            Outcome::Clear => continue,
            Outcome::Hit { at, what } => format!(
                "the walls from {} and {} collide ({what} at ({:.4}, {:.4}, {:.4}))",
                cx.fname[fa], cx.fname[fb], at.x, at.y, at.z
            ),
            Outcome::Unverified(m) => {
                if unverified.is_none() {
                    unverified = Some(format!(
                        "the walls from {} ({}) and {} ({}) cannot be verified clear of each other: {m}",
                        cx.fname[fa], cx.fkey[fa], cx.fname[fb], cx.fkey[fb]
                    ));
                }
                continue;
            }
        };
        viol.push(Viol {
            faces: [fa, fb].into_iter().collect(),
            reason: ShellLimitReason::Gap,
            what,
        });
        if !collect {
            break;
        }
    }
    if !viol.is_empty() {
        Err(Fail::Infeasible(viol))
    } else if let Some(m) = unverified {
        Err(Fail::Unverified(m))
    } else {
        Ok(())
    }
}

/// Closed forms of the thickness at which two walls' offsets meet (the "gap/2" limits):
/// parallel planes moving towards each other meet at half their distance; cylinders with
/// parallel axes (radii `R_i + k_i·t`) at `D = R_1(t) + R_2(t)` (apart) or
/// `D = R_1(t) − R_2(t)` (one inside the other, a tube's wall); a cylinder and a plane
/// parallel to its axis, the plane moving towards it, at `s − t = R(t)`. Candidates
/// `(t, face, face)`, confirmed by construction (the faces may not face each other).
fn closed_forms(cx: &Cx<'_>) -> Vec<(f64, usize, usize)> {
    let p0 = cx.plan0;
    let dir = if cx.outward { 1.0 } else { -1.0 };
    let par = |a: Vec3, b: Vec3| a.cross(b).norm() <= 1e-9;
    let mut out = Vec::new();
    let faces: Vec<(usize, &PF)> = p0
        .fs
        .iter()
        .enumerate()
        .filter(|(f, _)| is_offset(cx, *f))
        .filter_map(|(f, x)| x.as_ref().map(|x| (f, x)))
        .collect();
    let sg = |pf: &PF| if pf.sense { 1.0 } else { -1.0 };
    for (i, &(fa, a)) in faces.iter().enumerate() {
        for &(fb, b) in &faces[i + 1..] {
            let t = match (&a.surf, &b.surf) {
                (Surface::Plane(pa), Surface::Plane(pb)) => {
                    // Each plane moves along m = dir·n (n outward).
                    let (na, nb) = (pa.frame().z() * sg(a), pb.frame().z() * sg(b));
                    if !par(na, nb) || na.dot(nb) > 0.0 {
                        continue;
                    }
                    let s = (pb.frame().origin() - pa.frame().origin()).dot(na * dir);
                    (s > 0.0).then_some(0.5 * s)
                }
                (Surface::Cylinder(ca), Surface::Cylinder(cb)) => {
                    let (za, zb) = (ca.frame().z(), cb.frame().z());
                    if !par(za, zb) {
                        continue;
                    }
                    let w = cb.frame().origin() - ca.frame().origin();
                    let d = (w - za * w.dot(za)).norm();
                    let (ra, rb) = (ca.radius(), cb.radius());
                    let (ka, kb) = (sg(a) * dir, sg(b) * dir);
                    if d >= ra + rb {
                        (ka + kb > 0.0).then(|| (d - ra - rb) / (ka + kb))
                    } else if d + rb <= ra {
                        (kb - ka > 0.0).then(|| (ra - rb - d) / (kb - ka))
                    } else if d + ra <= rb {
                        (ka - kb > 0.0).then(|| (rb - ra - d) / (ka - kb))
                    } else {
                        None
                    }
                }
                (Surface::Cylinder(c), Surface::Plane(pl))
                | (Surface::Plane(pl), Surface::Cylinder(c)) => {
                    let (cf, pf) = if matches!(a.surf, Surface::Cylinder(_)) {
                        (a, b)
                    } else {
                        (b, a)
                    };
                    let n = pl.frame().z() * sg(pf);
                    if n.dot(c.frame().z()).abs() > 1e-9 {
                        continue;
                    }
                    let m = n * dir;
                    let s = (c.frame().origin() - pl.frame().origin()).dot(m);
                    let k = sg(cf) * dir;
                    (s > c.radius() && 1.0 + k > 0.0).then(|| (s - c.radius()) / (1.0 + k))
                }
                _ => None,
            };
            if let Some(t) = t.filter(|t| t.is_finite() && *t > 0.0) {
                out.push((t, fa, fb));
            }
        }
    }
    // A wall moving towards a parallel opening that faces it (the floor of an open box
    // rising to the open top) reaches the opening's plane at their distance: only the wall
    // moves (W6 review round 3: its neighbours then vanish, which is this collision).
    for &(fa, a) in &faces {
        for &o in cx.open.difference(&cx.smooth) {
            let Some(b) = p0.fs[o].as_ref() else { continue };
            let (Surface::Plane(pa), Surface::Plane(pb)) = (&a.surf, &b.surf) else {
                continue;
            };
            let (na, nb) = (pa.frame().z() * sg(a), pb.frame().z() * sg(b));
            if !par(na, nb) || na.dot(nb) > 0.0 {
                continue;
            }
            let s = (pb.frame().origin() - pa.frame().origin()).dot(na * dir);
            if s.is_finite() && s > 0.0 {
                out.push((s, fa, o));
            }
        }
    }
    out
}

/// The thicknesses at which an offset surface degenerates, in closed form (W6 review round 5):
/// a cylinder's or sphere's radius, or a torus's tube, shrinking to [`offset_surface`]'s
/// floor; a torus face growing onto its axis; the lemon sheet of a spindle torus shrinking
/// back inside its axis. Candidates `(t, face)`, confirmed by construction like the others:
/// just below such a bound the offset is a sliver the checks may not certify, and then no
/// maximum is claimed (the message names the bound).
fn curvature_limits(cx: &Cx<'_>) -> Vec<(f64, usize)> {
    use forge_core::geom::SpindlePatch;
    let min = 10.0 * LINEAR_TOLERANCE;
    let dir = if cx.outward { 1.0 } else { -1.0 };
    let mut out = Vec::new();
    for (f, pf) in cx.plan0.fs.iter().enumerate() {
        let Some(pf) = pf else { continue };
        if !is_offset(cx, f) {
            continue;
        }
        // The radius changes by `k·t`.
        let k = if pf.sense { dir } else { -dir };
        let t = match &pf.surf {
            Surface::Cylinder(c) if k < 0.0 => Some(c.radius() - min),
            Surface::Sphere(x) if k < 0.0 => Some(x.radius() - min),
            Surface::Torus(tr) => {
                let (big, r) = (tr.major(), tr.minor());
                match tr.spindle_patch() {
                    Some(SpindlePatch::Inner) => (k < 0.0).then_some(r - big - min),
                    _ if k < 0.0 => Some(r - min),
                    _ => cx.vrange[f].and_then(|(v0, v1)| {
                        let (c0, _) = crate::interfere::cos_range(v0, v1);
                        // big + (r + k·t)·c0 = min, reachable only where c0 < 0.
                        (c0 < 0.0).then(|| ((min - big) / c0 - r) / k)
                    }),
                }
            }
            _ => None,
        };
        if let Some(t) = t.filter(|t| t.is_finite() && *t > 0.0) {
            out.push((t, f));
        }
    }
    out
}

fn run(cx: &Cx<'_>, t: f64, v0: f64) -> Result<Body, Fail> {
    let b = attempt(cx, t, false)?;
    let body = b.plan.build().map_err(Fail::Invalid)?;
    let v = crate::check::validate_body(&body).map_err(Fail::Invalid)?;
    let ok = if cx.outward { v > 0.0 } else { v < v0 };
    if !ok {
        return Err(Fail::Invalid(format!(
            "unexpected shell volume {v} (input {v0})"
        )));
    }
    Ok(body)
}

/// The largest number of constructions the feasible-range search runs after the requested
/// thickness (deterministic; W6 review round 4: a search on a body with many tangent walls
/// ran for minutes). When it runs out, the range found so far is reported (or none).
pub(crate) const SEARCH_RUNS: usize = 28;

/// One construction's verdict for the feasible-range search.
enum Verdict {
    Built,
    /// Proven infeasible (violations of the SPEC's two causes).
    Proven,
    /// Not decided: unverified, invalid, or a structural failure at this thickness.
    Unknown(String),
}

/// Runs constructions for the search within [`SEARCH_RUNS`].
struct Search<'a> {
    cx: &'a Cx<'a>,
    v0: f64,
    runs: std::cell::Cell<usize>,
}

impl Search<'_> {
    /// The verdict at `x`; `None` when the budget is spent.
    fn at(&self, x: f64) -> Option<Verdict> {
        if self.runs.get() >= SEARCH_RUNS {
            return None;
        }
        self.runs.set(self.runs.get() + 1);
        let r = run(self.cx, x, self.v0);
        Some(match r {
            Ok(_) => Verdict::Built,
            Err(Fail::Infeasible(_)) => Verdict::Proven,
            Err(Fail::Unverified(m)) => Verdict::Unknown(m),
            Err(Fail::Invalid(m)) => Verdict::Unknown(format!("the result is invalid: {m}")),
            Err(Fail::Failed(m)) => Verdict::Unknown(m),
            Err(Fail::Vanishes(f)) => {
                Verdict::Unknown(format!("face {} vanishes", self.cx.fname[f]))
            }
        })
    }
}

/// The feasible range below `thickness`, which is proven infeasible: `(max, note)`, `max`
/// only when confirmed (built, and `max + 0.001` and `1.01·max` both proven infeasible),
/// `note` saying how far the search got otherwise. Also the smallest thickness above `max`
/// found proven infeasible (for the limits).
fn feasible_range(sr: &Search<'_>, thickness: f64) -> (Option<f64>, Option<String>, f64) {
    let cx = sr.cx;
    let mut hi = thickness;
    let budget = || {
        format!(
            "the search for the largest feasible thickness stopped after {SEARCH_RUNS} constructions"
        )
    };
    // 1. A closed-form candidate — walls meeting, or an offset radius reaching zero
    //    ([`curvature_limits`], W6 review round 5) —: the largest multiple of 0.001 mm below
    //    it that builds.
    let analytic = closed_forms(cx)
        .into_iter()
        .map(|c| c.0)
        .chain(curvature_limits(cx).into_iter().map(|c| c.0))
        .chain(collapse_at(cx, thickness))
        .filter(|&x| x > 0.0 && x < thickness)
        .fold(f64::INFINITY, f64::min);
    let mut best: Option<f64> = None;
    if analytic.is_finite() {
        let top = (round_down_mm(analytic) * 1000.0).round() as i64;
        for k in (0..8i64).map(|i| top - i).take_while(|&k| k > 0) {
            let x = k as f64 / 1000.0;
            match sr.at(x) {
                Some(Verdict::Built) => {
                    best = Some(x);
                    break;
                }
                Some(Verdict::Proven) => hi = hi.min(x),
                Some(Verdict::Unknown(_)) | None => break,
            }
        }
    }
    // 2. Otherwise descend by factors of 4 to the first thickness that builds, bisect to
    //    5e-4 mm, and take the largest multiple of 0.001 mm below that builds.
    if best.is_none() {
        let floor = 20.0 * LINEAR_TOLERANCE;
        let mut lo = hi;
        let found = loop {
            if lo <= floor {
                return (
                    None,
                    Some(format!("no thickness down to {floor} mm builds")),
                    hi,
                );
            }
            lo = (lo * 0.25).max(floor);
            match sr.at(lo) {
                Some(Verdict::Built) => break lo,
                Some(Verdict::Proven) => hi = lo,
                Some(Verdict::Unknown(m)) => {
                    return (
                        None,
                        Some(format!(
                            "at a thickness of {lo:.4} mm the shell could not be decided ({m})"
                        )),
                        hi,
                    );
                }
                None => return (None, Some(budget()), hi),
            }
        };
        let mut lo = found;
        while hi - lo > 5e-4 {
            let mid = 0.5 * (lo + hi);
            match sr.at(mid) {
                Some(Verdict::Built) => lo = mid,
                Some(Verdict::Proven) => hi = mid,
                Some(Verdict::Unknown(_)) | None => break,
            }
        }
        let top = (round_down_mm(lo) * 1000.0).round() as i64;
        for k in (0..4i64).map(|i| top - i).take_while(|&k| k > 0) {
            let x = k as f64 / 1000.0;
            if x > lo {
                continue;
            }
            match sr.at(x) {
                Some(Verdict::Built) => {
                    best = Some(x);
                    break;
                }
                Some(Verdict::Proven) => hi = hi.min(x),
                Some(Verdict::Unknown(_)) | None => break,
            }
        }
        if best.is_none() {
            return (
                None,
                Some(format!(
                    "a thickness of about {lo:.4} mm builds, but no multiple of 0.001 mm below it could be confirmed"
                )),
                hi,
            );
        }
    }
    // 3. The feasible-range property, confirmed: `max + 0.001` and `1.01·max` are proven
    //    infeasible (a suggestion is never made without both).
    let mut b = best.expect("best");
    for _ in 0..3 {
        // (value, is it the next multiple of 0.001 mm)
        let mut moved: Option<(f64, bool)> = None;
        let mut unknown = None;
        // `b` is a multiple of 0.001 mm: the next one, exactly.
        let a1 = ((b * 1000.0).round() + 1.0) / 1000.0;
        let a2 = 1.01 * b;
        // Below 0.1 mm, 1 % is less than the 0.001 mm step: only the next multiple.
        for (x, is_next) in [(a1, true), (a2, false)] {
            if !is_next && x <= a1 + 1e-12 {
                continue;
            }
            if (x - thickness).abs() <= 1e-12 * thickness.max(1.0) {
                // The requested thickness itself: proven infeasible already.
                continue;
            }
            match sr.at(x) {
                Some(Verdict::Proven) => hi = hi.min(x),
                Some(Verdict::Built) => {
                    moved = Some((x, is_next));
                    break;
                }
                Some(Verdict::Unknown(m)) => {
                    unknown = Some(format!("at {x:.4} mm the shell could not be decided ({m})"));
                    break;
                }
                None => {
                    unknown = Some(budget());
                    break;
                }
            }
        }
        if let Some(m) = unknown {
            return (None, Some(format!("{b} mm builds; {m}")), hi);
        }
        match moved {
            None => return (Some(b), None, hi),
            Some((x, is_next)) => {
                // Thicker values build again (the construction is not monotone here):
                // move up to the largest multiple of 0.001 mm at or below `x`.
                let y = if is_next { a1 } else { round_down_mm(x) };
                if y > b && (is_next || matches!(sr.at(y), Some(Verdict::Built))) {
                    b = y;
                } else {
                    return (
                        None,
                        Some(format!(
                            "{b} mm and {x:.4} mm build but thicker values do not everywhere: no confirmed maximum"
                        )),
                        hi,
                    );
                }
            }
        }
    }
    (
        None,
        Some(format!("{b} mm builds; the maximum could not be confirmed")),
        hi,
    )
}

/// Shell `body` (SPEC §6.8): remove the `open` faces and offset the others by `thickness`
/// (see the module docs).
pub fn shell(
    body: &Body,
    open: &[Pick<FaceId>],
    thickness: f64,
    direction: ShellDirection,
    opts: &ShellOptions,
) -> Result<ShellOutput, BlendError> {
    if !(thickness.is_finite() && thickness > LINEAR_TOLERANCE) {
        return Err(BlendError::InvalidValue {
            code: "INVALID_VALUE",
            field: "thickness",
            value: thickness,
            expected: crate::blend::length_range(),
        });
    }
    let keys = KeyMap::complete(body, opts.keys.as_ref());
    let failed = |reason: String| BlendError::ShellFailed { reason };
    let plan0 =
        Plan::from_body(body).map_err(|m| failed(format!("the input body cannot be read: {m}")))?;
    let mut open_set = BTreeSet::new();
    let mut not_on: Vec<String> = Vec::new();
    for p in open {
        // A face of another body (or an id this body does not have) is never read as the
        // face of this body with the same arena index.
        let here = if p.body == opts.body {
            plan0.fmap.get(&p.id).copied()
        } else {
            None
        };
        match here {
            Some(i) => {
                open_set.insert(i);
            }
            None => {
                if !not_on.contains(&p.key) {
                    not_on.push(p.key.clone());
                }
            }
        }
    }
    if !not_on.is_empty() {
        return Err(BlendError::FaceNotOnBody { faces: not_on });
    }
    if plan0.shells.len() != 1 {
        return Err(failed(format!(
            "the body has {} shells; shells of bodies with voids are not supported",
            plan0.shells.len()
        )));
    }
    let adj = Adj::new(&plan0);
    let inv_f: BTreeMap<usize, FaceId> = plan0.fmap.iter().map(|(k, v)| (*v, *k)).collect();
    let fk: Vec<crate::error::Named> = (0..plan0.fs.len())
        .map(|i| {
            inv_f
                .get(&i)
                .and_then(|id| keys.face(*id))
                .unwrap_or_else(|| {
                    let prov = &plan0.fs[i].as_ref().expect("input face").prov;
                    crate::error::Named {
                        key: prov.key(),
                        name: prov.name(),
                    }
                })
        })
        .collect();
    let mut smooth = BTreeSet::new();
    for &f in &open_set {
        let face = plan0.fs[f].as_ref().expect("face");
        if !matches!(face.surf, Surface::Plane(_)) {
            return Err(failed(format!(
                "open face {} is a {}; only planar faces can be opened",
                fk[f].name,
                face.surf.kind_name()
            )));
        }
        let mut kinds: BTreeSet<Option<Convexity>> = BTreeSet::new();
        for u in face.loops.iter().flatten() {
            let others: Vec<usize> = adj
                .edge_faces(u.edge)
                .into_iter()
                .filter(|&g| g != f)
                .collect();
            if others.iter().any(|g| open_set.contains(g)) {
                return Err(failed(format!(
                    "open faces {} and {} are adjacent; adjacent openings are not supported",
                    fk[f].name, fk[others[0]].name
                )));
            }
            kinds.insert(edge_convexity(&plan0, &adj, u.edge));
        }
        if kinds.contains(&Some(Convexity::Concave)) || kinds.contains(&None) {
            return Err(failed(format!(
                "open face {} has a concave edge; the wall beyond it would rise above the opening",
                fk[f].name
            )));
        }
        if kinds.len() > 1 {
            return Err(failed(format!(
                "open face {} has both smooth (tangent) and sharp edges; openings bounded by both are not supported",
                fk[f].name
            )));
        }
        if kinds.contains(&Some(Convexity::Smooth)) {
            smooth.insert(f);
        }
    }
    // Removing the open faces must leave one connected surface: a pocket opened only
    // through a face that also bounds the outer walls leaves its walls and floor a separate
    // piece, and the shell would be two solids (W6 review round 3: that failed validation as
    // one shell of Euler characteristic 4).
    let kept: Vec<usize> = (0..plan0.fs.len())
        .filter(|f| plan0.fs[*f].is_some() && !open_set.contains(f))
        .collect();
    if let Some(&first) = kept.first() {
        let mut seen: BTreeSet<usize> = [first].into_iter().collect();
        let mut stack = vec![first];
        while let Some(f) = stack.pop() {
            for u in plan0.fs[f].as_ref().expect("face").loops.iter().flatten() {
                for g in adj.edge_faces(u.edge) {
                    if !open_set.contains(&g) && seen.insert(g) {
                        stack.push(g);
                    }
                }
            }
        }
        if let Some(&apart) = kept.iter().find(|f| !seen.contains(f)) {
            return Err(failed(format!(
                "without the open faces the body's surface falls apart ({} and {} are no longer connected): the shell would be separate solids",
                fk[first].name, fk[apart].name
            )));
        }
    }
    let mut scale: f64 = 1.0;
    for v in &plan0.vs {
        scale = scale.max(v.p.norm());
    }
    let vrange: Vec<Option<(f64, f64)>> = (0..plan0.fs.len())
        .map(|f| crate::interfere::face_uvbox(&plan0, f).map(|b| b.v))
        .collect();
    let mut cx = Cx {
        plan0: &plan0,
        adj: &adj,
        open: open_set.clone(),
        smooth,
        vrange,
        feature: &opts.feature,
        fname: fk.iter().map(|n| n.name.clone()).collect(),
        fkey: fk.iter().map(|n| n.key.clone()).collect(),
        outward: direction == ShellDirection::Outward,
        scale,
        wall_meet: f64::INFINITY,
    };
    cx.wall_meet = closed_forms(&cx)
        .into_iter()
        .map(|c| c.0)
        .fold(f64::INFINITY, f64::min);
    let cx = cx;
    let v0 = forge_check::mass_properties(body)
        .map(|m| m.volume)
        .map_err(|e| failed(format!("the input body cannot be measured: {e}")))?;
    let report = ShellReport {
        removed_faces: open_set.iter().map(|&f| cx.fkey[f].clone()).collect(),
        closed_void: open_set.is_empty(),
    };
    let first = match run(&cx, thickness, v0) {
        Ok(body) => return Ok(ShellOutput { body, report }),
        Err(f) => f,
    };
    let viol1 = match first {
        Fail::Infeasible(v) => v,
        Fail::Failed(m) => return Err(failed(m)),
        Fail::Unverified(m) => return Err(failed(m)),
        Fail::Invalid(m) => return Err(failed(format!("the result is invalid: {m}"))),
        Fail::Vanishes(f) => {
            return Err(failed(format!(
                "face {} ({}) vanishes: the offsets of its neighbours meet across it{}",
                cx.fname[f],
                cx.fkey[f],
                vanish_limit(&cx, f, thickness).map_or(String::new(), |x| format!(
                    " at a thickness of about {:.3} mm, so a smaller thickness may build",
                    round_down_mm(x)
                ))
            )));
        }
    };
    // Proven infeasible: the feasible range (bounded, confirmed; see the module docs).
    let sr = Search {
        cx: &cx,
        v0,
        runs: std::cell::Cell::new(0),
    };
    let (best, note, hi) = feasible_range(&sr, thickness);
    // Limits: the proven violations at the requested thickness and just above the maximum.
    let mut limits: BTreeMap<usize, ShellLimitReason> = BTreeMap::new();
    let mut add = |v: Vec<Viol>| {
        for x in v {
            for f in x.faces {
                limits.entry(f).or_insert(x.reason);
            }
        }
    };
    match attempt(&cx, thickness, true) {
        Err(Fail::Infeasible(v)) => add(v),
        _ => add(viol1.clone()),
    }
    if best.is_some()
        && hi < thickness
        && let Err(Fail::Infeasible(v)) = attempt(&cx, hi, true)
    {
        add(v);
    }
    // The message says what was proven (and, without a maximum, how far the search got and
    // where an offset radius reaches zero in closed form).
    let mut why = viol1.first().map(|v| v.what.clone()).unwrap_or_default();
    if let Some(tc) = collapse_at(&cx, thickness) {
        why = format!(
            "{why}; the offset body collapses at a thickness of about {:.4} mm: its walls collide",
            tc
        );
    }
    if best.is_none()
        && let Some((t, f)) = curvature_limits(&cx)
            .into_iter()
            .filter(|c| c.0 < thickness)
            .min_by(|a, b| a.0.total_cmp(&b.0))
    {
        let at = format!(
            "its radius reaches zero at a thickness of {:.3} mm, in closed form",
            t + 10.0 * LINEAR_TOLERANCE
        );
        let same = viol1
            .first()
            .is_some_and(|v| v.reason == ShellLimitReason::Curvature && v.faces.contains(&f));
        why = if same {
            format!("{why} ({at})")
        } else {
            format!("{why}; the offset of {} degenerates: {at}", cx.fname[f])
        };
    }
    let note = match note {
        Some(n) => Some(format!("{why}; {n}")),
        None => (!why.is_empty()).then_some(why),
    };
    Err(BlendError::ThicknessTooLarge {
        thickness,
        max_feasible_thickness: best,
        limits: limits
            .into_iter()
            .map(|(f, reason)| ShellLimit {
                key: cx.fkey[f].clone(),
                name: cx.fname[f].clone(),
                reason,
            })
            .collect(),
        note,
    })
}
