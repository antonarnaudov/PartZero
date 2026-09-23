//! # Booleans (SPEC §6.0.3–§6.0.5, interface I4)
//!
//! [`apply_body_op`] joins, cuts or intersects target bodies with tool bodies on top of
//! `forge-ssi`, and [`unify_same_domain`] merges same-carrier faces and edges afterwards
//! (every result of `apply_body_op` is already unified).
//!
//! # Pipeline (two solids `A`, `B`)
//! 1. **Model** (`model`): both operands in flat tables; every face gets a chart of its
//!    trimmed parameter domain (`chart`, seam-free, ADR 0012), its parameter box and a
//!    certified 3D box.
//! 2. **Intersections** (`intersect`): face pairs pruned by boxes; edge–face hits with
//!    `intersect_curve_surface`; face–face branches with `intersect_surfaces`, trimmed to
//!    both faces by splitting at the edge–face hits (exactly the points where a branch
//!    crosses a face boundary) and testing piece middles; vertices merged within
//!    `LINEAR_TOLERANCE`; coincident edge pieces merged, every face a piece lies on
//!    recorded with a pcurve: fitted section pieces get pcurves on the **true**
//!    intersection of their two faces (Newton, `geom::fit_section_pcurve`), other pcurves
//!    are fitted to the surface projection of their curve, both within 1e-10 mm (C⁰ quintic
//!    pieces; review round 4: two faces of an edge fitted independently within 5e-8 mm left
//!    the bodies open by that much, and forge-check's divergence-theorem volumes then depended
//!    on its reference point by ~1e-9 relative).
//!    Coincident faces (SSI coincidence) are split by each other's imprinted edges: a 2D
//!    region boolean in the shared parameter space.
//!    Section ends lying on a boundary edge that no edge–face hit split (an edge that only
//!    touches the other surface, e.g. at a double point of the section) split that edge;
//!    pcurves running past the end of a closed branch's pcurve, or ending at a cone apex
//!    or sphere pole (where `u` is arbitrary), are refitted. Isolated contact points
//!    (tangent points, a cone apex or sphere pole resting on the other face) are recorded;
//!    at a singular point of a surface the face is located from points just off it.
//! 3. **Fragments** (`classify`): each face is re-arranged in its chart with the pieces on
//!    it; interior pieces that separate nothing (tangent contact lines: a slit inside a
//!    face, or a line across a band whose sides are one face) are dropped from the face and
//!    recorded as contacts. Each fragment is classified in / out / on-same / on-opposite
//!    (coincidence test, then certified ray casting; further interior points when one
//!    lands on the other operand's boundary).
//! 4. **Assembly** (`assemble`): selection by operation (a join without overlap or a cut
//!    that changes nothing stops here: `BOOLEAN_NO_INTERSECTION` at the caller), edge-use,
//!    vertex-fan, contact-point and contact-line checks (non-manifold results are
//!    `BOOLEAN_NON_MANIFOLD`), shells, voids, validated bodies whose edge tolerances cover
//!    the SSI `error_bound` and every pcurve deviation.
//! 5. **Unify** (`unify`): SPEC §6.0.4, with the key and alias rules of §5.2: faces on
//!    one carrier merged; edges on one line, circle or ellipse, or pieces of one
//!    intersection curve (B-splines, concatenated exactly across a closed curve's end),
//!    merged at vertices no other edge uses; a closed edge alone in its loops becomes a
//!    ring. Sphere faces with holes only, or whose loops all start and end on one pole, are
//!    re-parametrized with a pole chosen in 3D inside a hole (forge-check measures bands,
//!    not spheres minus disks, and reads a face whose loop ends all lie on one pole as the
//!    complement); pcurves moved to another parametrization reproduce their old image
//!    (`geom::refit_pcurve`). A required merge that cannot be built is an error, never a
//!    silently unmerged face.
//!
//! # Several operands (SPEC §6.0.3)
//! - **Join**: the overlap graph of all targets and tools (two operands are adjacent when
//!   they share volume or a face of positive area; every pair whose boxes meet is tested)
//!   gives the connected components of `T ∪ K`; each component is united in canonical
//!   order, each next operand overlapping one already united. A tool that overlaps no
//!   target is `BOOLEAN_NO_INTERSECTION`, whatever the order of the operands. A tool and
//!   an operand of another component that touch along an edge or at a point make `T ∪ K`
//!   non-manifold: `BOOLEAN_NON_MANIFOLD`. Two targets that touch were separate bodies
//!   touching before the operation and are left so (a contract note: SPEC §6.0.3 does not
//!   say whether such contacts count).
//! - **Cut**: each target minus every tool in turn (canonical order); `BOOLEAN_NO_INTERSECTION`
//!   names the tool closest to the targets.
//! - **Intersect**: the tools are united into components as for a join; each target is
//!   intersected with each component; pieces of one target from different components that
//!   touch are `BOOLEAN_NON_MANIFOLD`.
//!
//! The result does not depend on the order of `targets` and `tools` (up to operands with
//! the same origin and the same centroid).
//!
//! Debugging: `FORGE_BOOLEAN_DEBUG` (fragments, classification, failing checks),
//! `FORGE_BOOLEAN_DEBUG_FACE=<face name>` (a face's arrangement inputs),
//! `FORGE_BOOLEAN_DEBUG_SSI[_PRE]` (face-pair SSI inputs and results),
//! `FORGE_BOOLEAN_DEBUG_VERTS` (vertex candidates and merged vertices), `FORGE_CHART_DEBUG`
//! (arrangement pieces, node orders, cycles) print to stderr.
//!
//! # Identity (SPEC §6.0.3, §5.2)
//! Keys are SPEC keys (`Provenance::key`), never v0 display names (`keys`): operands'
//! unqualified caps of their origin feature get the body member `@m`, and edge and vertex
//! sources are face keys inside the boolean. Surviving faces, edges and vertices keep their
//! provenance (split pieces share it); an operand edge whose adjacent operand faces changed,
//! and every section edge, is a new edge `F/edge:{a|b}` keyed by the result faces around
//! it; new vertices are `F/vertex:{…}` for the operation's feature id `F`. Faces and edges
//! merged by §6.0.4 keep the byte-wise smallest key among the merged entities of the targets
//! (all of them if none is a target's); the other keys become aliases, resolved to the
//! finally surviving key across the steps of a multi-operand operation. Result bodies inherit the origin of the target they come from;
//! a join component containing several targets takes the one that sorts first (timeline
//! index, then member) and reports the others in `merged_into`; a target cut into pieces
//! yields several bodies with one origin (`BOOLEAN_SPLIT`); a consumed target is reported
//! in `removed` (`BOOLEAN_BODY_CONSUMED`). A target a join or cut leaves as it was (a
//! nested join tool, a cut tool that misses it) is `untouched`, not modified; a target
//! lying inside an intersect's tools is its own intersection and is reported `modified`
//! (SPEC §6.0.3 intersects every target; §6.0.5, as the oracle reports it).
//!
//! # Canonical order (SPEC §5.4)
//! Result bodies by origin (timeline index, member, instance), then pieces of one origin
//! by their exact centroid (forge-check mass properties), lexicographically with
//! tolerance `LINEAR_TOLERANCE·s`, `s` the diagonal of the operands' bounding box (at
//! least 1).
//!
//! # Failure
//! Every failure is a [`BooleanError`] with a stable code and structured details; a
//! consistency check that fails (face arrangement, classification, edge use counts,
//! validity of the rebuilt body) is an error, never a returned body (a failing check is
//! first retried once with the intersection's own section pcurves). SPEC [R-3]: before
//! intersecting, aligned faces within `LINEAR_TOLERANCE` and near-tangent contacts within it
//! are made exactly coincident or tangent by translating operand B by at most the tolerance
//! (`near::snap`); what no translation fixes, and failures that follow from distinct faces
//! closer than 1e-5 mm, are `FORGE_BOOLEAN_NEAR_COINCIDENT` (`near`: one rule for every
//! surface type and operation). A result body thinner than the tolerance is degenerate and
//! dropped. Every result body finally passes `forge_check` validity and the operation's
//! volume bounds (`guard`), or the operation is `FORGE_BOOLEAN_INVALID_RESULT`.

mod assemble;
mod chart;
mod classify;
pub mod corpus;
mod error;
mod geom;
mod guard;
mod intersect;
mod keys;
mod model;
mod near;
mod unify;

use std::collections::{BTreeMap, BTreeSet};

use forge_core::linalg::{Point2, Point3, Vec3};
use forge_core::topo::Body;
use forge_ir::v1::{EntityKind, LINEAR_TOLERANCE};
use serde::Serialize;

pub use error::{BooleanError, BooleanErrorDetails, SsiDiagnostics};
pub use forge_ir::v1::metrics::{BodyChange, Origin};
pub use unify::{Aliases, unify_same_domain};

use assemble::Assembly;
use classify::Class;
use geom::Aabb;
use intersect::VTOL;
use model::Model;

/// A body operation (SPEC §6.0.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BodyOp {
    /// Union of targets and tools; connected components.
    Join,
    /// Targets minus the union of the tools.
    Cut,
    /// Each target intersected with the union of the tools.
    Intersect,
}

/// An operand body with its identity.
#[derive(Clone, Debug)]
pub struct OpBody {
    /// The body.
    pub body: Body,
    /// Its origin (SPEC §5.2 rule 4).
    pub origin: Origin,
    /// Timeline index of the origin feature (orders origins, SPEC §5.4).
    pub timeline: usize,
}

/// A body created or modified by the operation.
#[derive(Clone, Debug)]
pub struct ResultBody {
    /// The (validated, unified) body.
    pub body: Body,
    /// Inherited origin.
    pub origin: Origin,
    /// `created` or `modified`.
    pub change: BodyChange,
}

/// An info or warning raised by the operation (SPEC §7.3).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum BooleanNote {
    /// `BOOLEAN_SPLIT` (info): a target was cut into several pieces.
    Split {
        /// The target's origin.
        origin: Origin,
        /// Number of pieces.
        pieces: usize,
    },
    /// `BOOLEAN_BODY_CONSUMED` (warning): a target disappeared.
    Consumed {
        /// The target's origin.
        origin: Origin,
    },
}

impl BooleanNote {
    /// Stable code.
    pub fn code(&self) -> &'static str {
        match self {
            BooleanNote::Split { .. } => "BOOLEAN_SPLIT",
            BooleanNote::Consumed { .. } => "BOOLEAN_BODY_CONSUMED",
        }
    }
    /// `"info"` or `"warning"`.
    pub fn severity(&self) -> &'static str {
        match self {
            BooleanNote::Split { .. } => "info",
            BooleanNote::Consumed { .. } => "warning",
        }
    }
}

/// Result of [`apply_body_op`].
#[derive(Clone, Debug)]
pub struct BodyOpResult {
    /// Bodies created or modified by the operation, in canonical order (origin, then
    /// centroid; SPEC §5.4).
    pub bodies: Vec<ResultBody>,
    /// Targets a join or cut left as they were (a nested join tool, a cut tool missing
    /// that target; not listed in `bodies`), in canonical order. An intersect never leaves
    /// a target untouched: one inside the tools is listed in `bodies` as `modified`.
    pub untouched: Vec<Origin>,
    /// The indices (into the caller's `targets` slice) of the targets listed in
    /// `untouched`, in the same order. Split pieces share their origin, so the origins
    /// alone cannot tell the caller which piece a later operation left as it was
    /// (integration: forge-regen keeps exactly these bodies in the part).
    pub untouched_targets: Vec<usize>,
    /// Join: targets merged into another target's body, `(merged, into)`.
    pub merged_into: Vec<(Origin, Origin)>,
    /// Origins of consumed targets.
    pub removed: Vec<Origin>,
    /// Targets split into several bodies, `(origin, pieces)`.
    pub splits: Vec<(Origin, usize)>,
    /// Infos and warnings, in the order raised.
    pub notes: Vec<BooleanNote>,
    /// Key aliases from same-domain merging of faces and edges, `(merged key, surviving
    /// key)`, sorted; chains across the steps of a multi-operand operation are resolved to
    /// the finally surviving key.
    pub aliases: Aliases,
    /// `true` if some intersection was not certified complete (SSI pass-through or
    /// safety net), or an operand's volume could not be measured so that the result guard
    /// checked only one-sided volume bounds; the result is still checked, but the caller
    /// may flag it.
    pub uncertified: bool,
}

/// Measured `(volume, area)` of a body (exact mass properties), when known.
type Mass = Option<(f64, f64)>;

/// Outcome of one two-solid boolean.
struct Two {
    bodies: Vec<Body>,
    /// `(volume, area)` of each body (measured by the result guard; `None` only for an
    /// unmeasured operand returned unchanged).
    masses: Vec<Mass>,
    /// The result differs from A (some fragment of A dropped, or of B kept).
    changed_a: bool,
    /// The operands overlap: they share volume or a face of positive area.
    overlap: bool,
    /// Where the operands' boundaries meet (along a curve or at a point), if they do.
    contact: Option<(Point3, EntityKind)>,
    uncertified: bool,
    aliases: Aliases,
}

/// `A op B` for two solids. Joins without overlap, cuts that change nothing and
/// intersections without overlap stop before assembly (no bodies); a join or intersection
/// whose result is `A` itself returns `A` unchanged (`changed_a == false`).
/// `ma`, `mb`: the operands' mass properties when the caller knows them (measured on
/// demand otherwise).
#[allow(clippy::too_many_arguments)]
fn boolean2(
    a: &Body,
    ma: Mass,
    b: &Body,
    mb: Mass,
    op: BodyOp,
    feature: &str,
    keys: &BTreeSet<String>,
) -> Result<Two, BooleanError> {
    let m0 = Model::new(a, b)?;
    let far = m0.bbox[0].distance(&m0.bbox[1]) > 10.0 * VTOL;
    if far {
        return Ok(Two {
            bodies: Vec::new(),
            masses: Vec::new(),
            changed_a: op == BodyOp::Intersect,
            overlap: false,
            contact: None,
            uncertified: false,
            aliases: Vec::new(),
        });
    }
    // SPEC [R-3]: aligned faces within the linear tolerance are coincident; B is translated
    // onto A by less than the tolerance (`near::snap`), and measured again.
    let snapped;
    let (m, b, mb) = match near::snap(&m0)? {
        Some(t) => {
            if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
                eprintln!("near-coincidence snap: operand B translated by {t:?}");
            }
            snapped = unify::translate_body(b, t)?;
            (Model::new(a, &snapped)?, &snapped, None)
        }
        None => (m0, b, mb),
    };
    near::check(&m)?;
    // Failures that follow from distinct faces the boolean cannot separate are reported as
    // such (`near::explain`).
    // Section boundaries are fitted onto the true intersection (`geom::fit_section_pcurve`);
    // where that moves a boundary across a near-tangent contact the arrangement reads
    // differently and a consistency check fails, the operation is run once more with the
    // intersection's own pcurves (the round-3 representation).
    let run = |sections: bool| boolean2_on(&m, a, ma, b, mb, op, feature, keys, sections);
    match run(true) {
        Err(BooleanError::Inconsistent { .. } | BooleanError::InvalidResult { .. }) => run(false),
        r => r,
    }
    .map_err(|e| near::explain(&m, e))
}

/// The rest of [`boolean2`] on the (snapped) model `m` of `a` and `b`.
#[allow(clippy::too_many_arguments)]
fn boolean2_on(
    m: &Model,
    a: &Body,
    ma: Mass,
    b: &Body,
    mb: Mass,
    op: BodyOp,
    feature: &str,
    keys: &BTreeSet<String>,
    sections: bool,
) -> Result<Two, BooleanError> {
    let imp = intersect::imprint(m, sections)?;
    let (mut frags, charts, contacts) = classify::split_faces(m, &imp)?;
    let mut classes = Vec::with_capacity(frags.len());
    for fr in &mut frags {
        let (c, uv) = classify::classify(m, &imp, fr)?;
        fr.uv = uv;
        classes.push(c);
    }
    if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
        for (fr, c) in frags.iter().zip(&classes) {
            let f = &m.faces[fr.face];
            eprintln!(
                "fragment {} #{}: {c:?} at {:?} ({} loops, {} coedges)",
                f.prov.name(),
                fr.group,
                f.surface.eval(fr.uv.x, fr.uv.y),
                fr.loops.len(),
                fr.loops.iter().map(Vec::len).sum::<usize>()
            );
        }
    }
    // Volume/area overlap: some fragment is inside the other operand, or coincident faces.
    let overlap = classes
        .iter()
        .any(|c| matches!(c, Class::In | Class::OnSame | Class::OnOpp));
    let sel = assemble::select(op, m, &frags, &classes);
    let kept: BTreeSet<usize> = sel.iter().map(|r| r.frag).collect();
    // The result differs from A if one of A's fragments is dropped or one of B's is kept.
    let changed_a = frags
        .iter()
        .enumerate()
        .any(|(i, f)| (m.faces[f.face].operand == 0) != kept.contains(&i));
    let stop = |bodies: Vec<Body>, masses: Vec<Mass>, changed_a: bool| Two {
        bodies,
        masses,
        changed_a,
        overlap,
        contact: imp.contact,
        uncertified: imp.uncertified,
        aliases: Vec::new(),
    };
    // A join without overlap, or a cut that changes nothing, fails or keeps the target at
    // the caller (SPEC §6.0.3); touching along an edge or at a point is not reported as a
    // non-manifold result then. An intersection without overlap is empty.
    match op {
        BodyOp::Join if !overlap => return Ok(stop(Vec::new(), Vec::new(), false)),
        BodyOp::Cut if !changed_a => return Ok(stop(Vec::new(), Vec::new(), false)),
        BodyOp::Intersect if !overlap => return Ok(stop(Vec::new(), Vec::new(), true)),
        BodyOp::Join | BodyOp::Intersect if !changed_a => {
            return Ok(stop(vec![a.clone()], vec![ma], false));
        }
        _ => {}
    }
    let asm = Assembly {
        m,
        imp: &imp,
        frags: &frags,
        charts: &charts,
        contacts: &contacts,
        feature,
    };
    let rbodies = asm.bodies(sel)?;
    // A cut result is bounded by A's outside and B's inside (reversed). A body made of B's
    // faces only is the inside of a **void** of B lying within A (a tool with a cavity:
    // the material the cavity leaves); made of faces of B's outer shell it would be a
    // closed copy of the tool (a sphere the target touches at a point), which no cut can
    // create.
    if op == BodyOp::Cut
        && rbodies.iter().any(|rb| {
            let faces = || {
                rb.shells
                    .iter()
                    .flatten()
                    .map(|rf| &m.faces[frags[rf.frag].face])
            };
            !faces().any(|f| f.operand == 0) && !faces().all(|f| f.void)
        })
    {
        return Err(BooleanError::inconsistent(
            "a cut result body is made of faces of the tool's outer shell only",
            feature,
        ));
    }
    let mut bodies = Vec::new();
    let mut masses = Vec::new();
    let mut aliases = Vec::new();
    for rb in &rbodies {
        let body = asm.build(rb)?;
        let (body, al) = unify::unify_keyed(&body, keys, Some(feature), sections)?;
        masses.push(Some(guard::valid_result(&body)?));
        aliases.extend(al);
        bodies.push(body);
    }
    let measured = guard::volumes(op, (a, ma), (b, mb), &masses)?;
    // SPEC [R-3]: a result body thinner than the linear tolerance is degenerate, not a
    // solid; it is dropped, never returned (review round 4: a 1e-6 mm sliver came back as a
    // two-face body). Thin means a mean thickness `2V/A` of at most half the tolerance: a
    // slab of thickness `tol/2`, a spherical cap or a circular-segment prism of height
    // `tol` (their mean thickness is about half their height). An intersection or cut left
    // with slivers only is then empty (`BOOLEAN_EMPTY_RESULT` or a consumed target at the
    // caller).
    let solid: Vec<bool> = masses
        .iter()
        .map(|m| m.is_none_or(|(v, area)| v > 0.25 * LINEAR_TOLERANCE * area))
        .collect();
    let (bodies, masses): (Vec<Body>, Vec<Mass>) = bodies
        .into_iter()
        .zip(masses)
        .zip(&solid)
        .filter(|(_, keep)| **keep)
        .map(|(x, _)| x)
        .unzip();
    Ok(Two {
        bodies,
        masses,
        changed_a,
        overlap,
        contact: imp.contact,
        uncertified: imp.uncertified || !measured,
        aliases,
    })
}

/// Mass properties of an operand (`None` when forge-check cannot measure it).
fn operand_mass(b: &Body) -> Mass {
    forge_check::mass_properties(b)
        .ok()
        .map(|mp| (mp.volume, mp.area))
}

/// Box of a body (certified boxes of its edges and faces).
fn body_box(b: &Body) -> Result<Aabb, BooleanError> {
    Ok(Model::new(b, &Body::default())?.bbox[0])
}

/// Model scale `s` of SPEC §5.4 for the operands: the diagonal of their box, at least 1.
fn scale_of(boxes: &[Aabb]) -> f64 {
    let mut all = Aabb::empty();
    for b in boxes {
        all.add_box(b);
    }
    if all.is_empty() {
        1.0
    } else {
        all.diag().max(1.0)
    }
}

/// Points of a body for distance estimates: vertices, 33 points per edge and the inside
/// points of a 9 × 9 parameter grid per face.
fn distance_samples(m: &Model) -> Vec<Point3> {
    let mut out: Vec<Point3> = m.verts.iter().map(|v| v.p).collect();
    for e in &m.edges {
        let n = 32;
        for i in 0..=n {
            out.push(
                e.curve
                    .eval(e.range.0 + (e.range.1 - e.range.0) * i as f64 / n as f64),
            );
        }
    }
    for f in &m.faces {
        let (u, v) = f.chart.uv_box();
        let n = 8;
        for i in 0..=n {
            for j in 0..=n {
                let uv = Point2::new(
                    u.0 + (u.1 - u.0) * i as f64 / n as f64,
                    v.0 + (v.1 - v.0) * j as f64 / n as f64,
                );
                if f.chart.contains(uv) == Some(true) {
                    out.push(f.surface.eval(uv.x, uv.y));
                }
            }
        }
    }
    out
}

/// Closest point of a body's boundary to `p`: its vertices, the closest points of its
/// edges and the orthogonal projections that fall inside its faces. `(distance, point)`.
fn closest_on(m: &Model, p: Point3) -> (f64, Point3) {
    let mut best = (f64::INFINITY, p);
    for v in &m.verts {
        let d = v.p.distance(p);
        if d < best.0 {
            best = (d, v.p);
        }
    }
    for e in &m.edges {
        let (t, d) = geom::param_on(&e.curve, e.range, p);
        if d < best.0 {
            best = (d, e.curve.eval(t));
        }
    }
    for f in &m.faces {
        let (u, v, d) = f.surface.project(p);
        if d >= best.0 {
            continue;
        }
        let uv = geom::uv_near(&f.surface, p, Some(Point2::new(u, v)));
        if f.chart.contains(uv) == Some(true) {
            best = (d, f.surface.eval(uv.x, uv.y));
        }
    }
    best
}

/// Distance between two bodies that do not touch (mm). An **upper bound**: the closest
/// pair among sampled points of each (vertices, edges, face grids) and their closest points
/// on the other body, refined by alternating closest points until it stops decreasing (a
/// local minimum of the distance, exact for the usual closest features: a vertex, edge or
/// face against a face, edge or vertex). Callers report 0 when the bodies touch (known
/// exactly from the intersection), never this estimate.
fn min_distance(a: &Body, b: &Body) -> f64 {
    let empty = Body::default();
    let (Ok(ma), Ok(mb)) = (Model::new(a, &empty), Model::new(b, &empty)) else {
        return f64::INFINITY;
    };
    let mut best = (f64::INFINITY, Point3::zero(), Point3::zero());
    for p in distance_samples(&ma) {
        let (d, q) = closest_on(&mb, p);
        if d < best.0 {
            best = (d, p, q);
        }
    }
    for q in distance_samples(&mb) {
        let (d, p) = closest_on(&ma, q);
        if d < best.0 {
            best = (d, p, q);
        }
    }
    for _ in 0..64 {
        let (_, p) = closest_on(&ma, best.2);
        let (d, q) = closest_on(&mb, p);
        if d < best.0 - 1e-15 * (1.0 + best.0) {
            best = (d, p, q);
        } else {
            break;
        }
    }
    best.0
}

/// Canonical key of an origin (SPEC §5.4): timeline index, member, instance.
type OriginKey = (usize, String, Option<Vec<u32>>);

fn origin_key(o: &OpBody) -> OriginKey {
    (
        o.timeline,
        o.origin.member.clone(),
        o.origin.instance.clone(),
    )
}

/// `a < b` lexicographically, coordinates within `tol` counting as equal (SPEC §5.4).
fn lex_less(a: &[f64; 3], b: &[f64; 3], tol: f64) -> bool {
    for i in 0..3 {
        if (a[i] - b[i]).abs() > tol {
            return a[i] < b[i];
        }
    }
    false
}

/// Centroid of a body for the canonical order (exact mass properties). `strict`: a body
/// forge-check cannot measure is an error (results must be measurable); otherwise (operand
/// order only) the centre of its box.
fn order_point(b: &Body, strict: bool) -> Result<[f64; 3], BooleanError> {
    match forge_check::mass_properties(b) {
        Ok(mp) if mp.centroid.iter().all(|x| x.is_finite()) => Ok(mp.centroid),
        Ok(_) if strict => Err(BooleanError::InvalidResult {
            issues: vec!["result body has a non-finite centroid".into()],
        }),
        Err(e) if strict => Err(BooleanError::InvalidResult {
            issues: vec![format!(
                "mass properties of a result body: {} ({e})",
                e.code()
            )],
        }),
        _ => {
            let bb = body_box(b)?;
            Ok(bb.lo.lerp(bb.hi, 0.5).to_array())
        }
    }
}

/// Canonical permutation of items with keys `keys` and bodies `bodies` (SPEC §5.4): by key,
/// then within runs of one key by centroid, lexicographically with tolerance
/// `LINEAR_TOLERANCE·scale` (the forge-refs `Scope::canonical` procedure: exact order first,
/// then a stable insertion with the tolerant comparison, which is not a total order).
/// Centroids are computed only for runs of more than one item.
fn canonical_perm<K: Ord>(
    keys: &[K],
    bodies: &[&Body],
    scale: f64,
    strict: bool,
) -> Result<Vec<usize>, BooleanError> {
    let mut idx: Vec<usize> = (0..keys.len()).collect();
    idx.sort_by(|&a, &b| keys[a].cmp(&keys[b]).then(a.cmp(&b)));
    let tol = LINEAR_TOLERANCE * scale;
    let mut out = Vec::with_capacity(idx.len());
    let mut i = 0;
    while i < idx.len() {
        let mut j = i + 1;
        while j < idx.len() && keys[idx[j]] == keys[idx[i]] {
            j += 1;
        }
        if j - i == 1 {
            out.push(idx[i]);
            i = j;
            continue;
        }
        let mut run: Vec<(usize, [f64; 3])> = Vec::with_capacity(j - i);
        for &k in &idx[i..j] {
            run.push((k, order_point(bodies[k], strict)?));
        }
        run.sort_by(|a, b| {
            (0..3)
                .map(|c| a.1[c].total_cmp(&b.1[c]))
                .find(|o| o.is_ne())
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.0.cmp(&b.0))
        });
        let mut sorted: Vec<(usize, [f64; 3])> = Vec::with_capacity(run.len());
        for item in run {
            let pos = sorted
                .iter()
                .position(|(_, p)| lex_less(&item.1, p, tol))
                .unwrap_or(sorted.len());
            sorted.insert(pos, item);
        }
        out.extend(sorted.into_iter().map(|x| x.0));
        i = j;
    }
    Ok(out)
}

/// `true` if two operands are the same body (bit-identical geometry and topology): a body
/// in both sets (`BOOLEAN_TOOL_IS_TARGET`), as opposed to two pieces of one split body,
/// which share an origin but not their geometry.
fn same_body(a: &Body, b: &Body) -> bool {
    a.faces().len() == b.faces().len()
        && a.edges().len() == b.edges().len()
        && a.vertices().len() == b.vertices().len()
        && format!("{a:?}") == format!("{b:?}")
}

/// Resolve alias chains `x → y`, `y → z` (successive merges of a multi-operand operation)
/// to the finally surviving keys; sorted, without duplicates or self-aliases.
fn collapse_aliases(al: Aliases) -> Aliases {
    let mut next: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (from, to) in al {
        if from != to {
            next.entry(from).or_default().insert(to);
        }
    }
    fn finals(
        k: &str,
        next: &BTreeMap<String, BTreeSet<String>>,
        seen: &mut BTreeSet<String>,
        out: &mut BTreeSet<String>,
    ) {
        if !seen.insert(k.to_string()) {
            return;
        }
        match next.get(k) {
            None => {
                out.insert(k.to_string());
            }
            Some(tos) => {
                for t in tos {
                    finals(t, next, seen, out);
                }
            }
        }
    }
    let mut res: Aliases = Vec::new();
    for from in next.keys() {
        let mut out = BTreeSet::new();
        let mut seen = BTreeSet::new();
        for t in &next[from] {
            finals(t, &next, &mut seen, &mut out);
        }
        for t in out {
            if t != *from {
                res.push((from.clone(), t));
            }
        }
    }
    res.sort();
    res.dedup();
    res
}

/// Apply a body operation (SPEC §6.0.3).
///
/// `targets` and `tools` are the resolved operand bodies; `feature` is the operation's
/// feature id (for the provenance of new edges and vertices). Tools are consumed; the
/// caller keeps them for `keep_tools`. The result does not depend on the order of the
/// operands. Errors: `FORGE_BOOLEAN_NO_OPERANDS` (an empty operand list),
/// `BOOLEAN_TOOL_IS_TARGET` (the same body in both lists), `BOOLEAN_NO_INTERSECTION`
/// (join: a tool overlaps no target; cut: no tool meets a target's interior),
/// `BOOLEAN_EMPTY_RESULT` (intersect: every target empty), `BOOLEAN_NON_MANIFOLD`, and the
/// other `FORGE_BOOLEAN_*` internal failures.
pub fn apply_body_op(
    op: BodyOp,
    targets: &[OpBody],
    tools: &[OpBody],
    feature: &str,
) -> Result<BodyOpResult, BooleanError> {
    apply(op, targets, tools, feature, None)
}

/// [`apply_body_op`] with the scope scale `s` of SPEC §5.4 (the model scale forge-regen's
/// scope uses, at least 1) for the tolerance of the canonical order of split pieces
/// (`LINEAR_TOLERANCE·s`), so that near-ties order as `Scope::canonical` orders them.
/// [`apply_body_op`] uses the diagonal of the operands' box instead.
pub fn apply_body_op_in_scope(
    op: BodyOp,
    targets: &[OpBody],
    tools: &[OpBody],
    feature: &str,
    scope_scale: f64,
) -> Result<BodyOpResult, BooleanError> {
    apply(op, targets, tools, feature, Some(scope_scale.max(1.0)))
}

fn apply(
    op: BodyOp,
    targets: &[OpBody],
    tools: &[OpBody],
    feature: &str,
    scale: Option<f64>,
) -> Result<BodyOpResult, BooleanError> {
    if targets.is_empty() {
        return Err(BooleanError::NoOperands { role: "targets" });
    }
    if tools.is_empty() {
        return Err(BooleanError::NoOperands { role: "tools" });
    }
    for t in targets {
        if let Some(k) = tools
            .iter()
            .find(|k| k.origin == t.origin && same_body(&k.body, &t.body))
        {
            return Err(BooleanError::ToolIsTarget {
                origin: k.origin.clone(),
            });
        }
    }
    // Operands as the boolean works on them: caps stamped with their body member, edge and
    // vertex sources as face keys (`keys`).
    let normalized = |o: &OpBody| -> Result<OpBody, BooleanError> {
        Ok(OpBody {
            body: keys::normalize(&o.body, Some(&o.origin))?,
            origin: o.origin.clone(),
            timeline: o.timeline,
        })
    };
    let targets: Vec<OpBody> = targets.iter().map(normalized).collect::<Result<_, _>>()?;
    let tools: Vec<OpBody> = tools.iter().map(normalized).collect::<Result<_, _>>()?;
    let (targets, tools) = (targets.as_slice(), tools.as_slice());
    let mut keys: BTreeSet<String> = BTreeSet::new();
    for t in targets {
        keys.extend(keys::entity_keys(&t.body));
    }
    let mut res = BodyOpResult {
        bodies: Vec::new(),
        untouched: Vec::new(),
        untouched_targets: Vec::new(),
        merged_into: Vec::new(),
        removed: Vec::new(),
        splits: Vec::new(),
        notes: Vec::new(),
        aliases: Vec::new(),
        uncertified: false,
    };
    let ctx = Ctx {
        feature,
        keys: &keys,
        scale,
    };
    match op {
        BodyOp::Join => join(targets, tools, &ctx, &mut res)?,
        BodyOp::Cut => cut(targets, tools, &ctx, &mut res)?,
        BodyOp::Intersect => intersect_op(targets, tools, &ctx, &mut res)?,
    }
    res.aliases = collapse_aliases(std::mem::take(&mut res.aliases));
    // Sources back to face names where unambiguous (`keys`).
    for rb in &mut res.bodies {
        rb.body = keys::denormalize(&rb.body)?;
    }
    Ok(res)
}

/// What every two-solid boolean of one operation shares.
struct Ctx<'a> {
    feature: &'a str,
    keys: &'a BTreeSet<String>,
    /// The scope scale for the canonical order (`None`: the operands' box).
    scale: Option<f64>,
}

/// Pairwise join outcomes of a set of operands, for the overlap graph (SPEC §6.0.3).
struct Graph<'a> {
    bodies: Vec<&'a Body>,
    /// Their mass properties.
    masses: Vec<Mass>,
    /// Canonical rank of each operand.
    rank: Vec<usize>,
    /// Outcomes of `boolean2(i, j, Join)` for `rank[i] < rank[j]`, for every pair whose
    /// boxes are within reach (the others neither overlap nor touch).
    pairs: BTreeMap<(usize, usize), Two>,
}

impl<'a> Graph<'a> {
    fn build(
        bodies: Vec<&'a Body>,
        masses: Vec<Mass>,
        order: &[usize],
        boxes: &[Aabb],
        ctx: &Ctx,
        res: &mut BodyOpResult,
    ) -> Result<Self, BooleanError> {
        let mut rank = vec![0; bodies.len()];
        for (r, &i) in order.iter().enumerate() {
            rank[i] = r;
        }
        let mut pairs = BTreeMap::new();
        for (x, &i) in order.iter().enumerate() {
            for &j in &order[x + 1..] {
                if boxes[i].distance(&boxes[j]) > 10.0 * VTOL {
                    continue;
                }
                let two = boolean2(
                    bodies[i],
                    masses[i],
                    bodies[j],
                    masses[j],
                    BodyOp::Join,
                    ctx.feature,
                    ctx.keys,
                )?;
                res.uncertified |= two.uncertified;
                pairs.insert((i, j), two);
            }
        }
        Ok(Graph {
            bodies,
            masses,
            rank,
            pairs,
        })
    }

    fn get(&self, i: usize, j: usize) -> Option<&Two> {
        let key = if self.rank[i] < self.rank[j] {
            (i, j)
        } else {
            (j, i)
        };
        self.pairs.get(&key)
    }

    fn overlap(&self, i: usize, j: usize) -> bool {
        self.get(i, j).is_some_and(|t| t.overlap)
    }

    /// Where `i` and `j` touch without overlapping, if they do.
    fn contact(&self, i: usize, j: usize) -> Option<(Point3, EntityKind)> {
        self.get(i, j)
            .filter(|t| !t.overlap)
            .and_then(|t| t.contact)
    }

    /// Connected components of the overlap graph among `members`, each in canonical order,
    /// ordered by their first member.
    fn components(&self, members: &[usize]) -> Vec<Vec<usize>> {
        let mut comps: Vec<Vec<usize>> = Vec::new();
        let mut done: BTreeSet<usize> = BTreeSet::new();
        let mut sorted = members.to_vec();
        sorted.sort_by_key(|&i| self.rank[i]);
        for &s in &sorted {
            if done.contains(&s) {
                continue;
            }
            let mut comp = vec![s];
            done.insert(s);
            let mut k = 0;
            while k < comp.len() {
                let c = comp[k];
                for &o in &sorted {
                    if !done.contains(&o) && self.overlap(c, o) {
                        done.insert(o);
                        comp.push(o);
                    }
                }
                k += 1;
            }
            comp.sort_by_key(|&i| self.rank[i]);
            comps.push(comp);
        }
        comps
    }

    /// Union of a component (canonical order, each next operand overlapping one already
    /// united). Returns the body, whether it differs from the first member, and its mass
    /// properties.
    fn unite(
        &mut self,
        comp: &[usize],
        ctx: &Ctx,
        res: &mut BodyOpResult,
    ) -> Result<(Body, bool, Mass), BooleanError> {
        let first = comp[0];
        let mut united = vec![first];
        let mut rest: Vec<usize> = comp[1..].to_vec();
        let mut acc: Option<(Body, Mass)> = None;
        let mut changed = false;
        while !rest.is_empty() {
            let pos = rest
                .iter()
                .position(|&j| united.iter().any(|&i| self.overlap(i, j)))
                .ok_or_else(|| {
                    BooleanError::inconsistent("a join component is not connected", ctx.feature)
                })?;
            let j = rest.remove(pos);
            let two = match &acc {
                // The pair's own union, computed with `first` as operand A.
                None => self.pairs.remove(&(first, j)).ok_or_else(|| {
                    BooleanError::inconsistent("missing pair outcome", ctx.feature)
                })?,
                Some((body, mass)) => {
                    let t = boolean2(
                        body,
                        *mass,
                        self.bodies[j],
                        self.masses[j],
                        BodyOp::Join,
                        ctx.feature,
                        ctx.keys,
                    )?;
                    res.uncertified |= t.uncertified;
                    t
                }
            };
            if !two.overlap || two.bodies.len() != 1 {
                return Err(BooleanError::inconsistent(
                    format!(
                        "overlapping join operands gave {} components",
                        two.bodies.len()
                    ),
                    ctx.feature,
                ));
            }
            changed |= two.changed_a;
            res.aliases.extend(two.aliases);
            acc = two.bodies.into_iter().zip(two.masses).next();
            united.push(j);
        }
        Ok(match acc {
            Some((b, m)) => (b, changed, m),
            None => (self.bodies[first].clone(), changed, self.masses[first]),
        })
    }
}

/// Canonical order of operands: targets (by origin, then centroid) before tools.
fn operand_order(
    targets: &[OpBody],
    tools: &[OpBody],
    scale: f64,
) -> Result<Vec<usize>, BooleanError> {
    let keys: Vec<(bool, OriginKey)> = targets
        .iter()
        .map(|t| (false, origin_key(t)))
        .chain(tools.iter().map(|k| (true, origin_key(k))))
        .collect();
    let bodies: Vec<&Body> = targets.iter().chain(tools).map(|o| &o.body).collect();
    canonical_perm(&keys, &bodies, scale, false)
}

fn non_manifold(c: (Point3, EntityKind)) -> BooleanError {
    BooleanError::non_manifold(c.1, c.0.to_array())
}

fn join(
    targets: &[OpBody],
    tools: &[OpBody],
    ctx: &Ctx,
    res: &mut BodyOpResult,
) -> Result<(), BooleanError> {
    let nt = targets.len();
    let ops: Vec<&OpBody> = targets.iter().chain(tools).collect();
    let boxes = ops
        .iter()
        .map(|o| body_box(&o.body))
        .collect::<Result<Vec<_>, _>>()?;
    let scale = ctx.scale.unwrap_or_else(|| scale_of(&boxes));
    let order = operand_order(targets, tools, scale)?;
    let mut g = Graph::build(
        ops.iter().map(|o| &o.body).collect(),
        ops.iter().map(|o| operand_mass(&o.body)).collect(),
        &order,
        &boxes,
        ctx,
        res,
    )?;
    // SPEC §6.0.3: every tool overlaps a target or shares a face of positive area with one.
    for &k in order.iter().filter(|&&i| i >= nt) {
        if (0..nt).any(|t| g.overlap(t, k)) {
            continue;
        }
        let touching = (0..nt).any(|t| g.contact(t, k).is_some());
        let d = if touching {
            0.0
        } else {
            (0..nt)
                .map(|t| min_distance(&targets[t].body, &ops[k].body))
                .fold(f64::INFINITY, f64::min)
        };
        return Err(BooleanError::NoIntersection {
            tool: ops[k].origin.clone(),
            min_distance: if d.is_finite() {
                d
            } else {
                boxes[k].distance(&boxes[0])
            },
        });
    }
    // Connected components of T ∪ K.
    let all: Vec<usize> = (0..ops.len()).collect();
    let comps = g.components(&all);
    let mut comp_of = vec![0usize; ops.len()];
    for (ci, c) in comps.iter().enumerate() {
        for &i in c {
            comp_of[i] = ci;
        }
    }
    let mut modified = vec![false; comps.len()];
    let mut out: Vec<(usize, ResultBody)> = Vec::new();
    for (ci, comp) in comps.iter().enumerate() {
        if comp.len() == 1 {
            continue;
        }
        let (body, changed, _) = g.unite(comp, ctx, res)?;
        // Every component with several members holds a target (tools overlap targets), and
        // targets sort first.
        let keep = comp[0];
        let merged: Vec<usize> = comp[1..].iter().copied().filter(|&i| i < nt).collect();
        if !changed && merged.is_empty() {
            continue;
        }
        modified[ci] = true;
        for &o in &merged {
            if targets[o].origin != targets[keep].origin {
                res.merged_into
                    .push((targets[o].origin.clone(), targets[keep].origin.clone()));
            }
        }
        out.push((
            keep,
            ResultBody {
                body,
                origin: targets[keep].origin.clone(),
                change: BodyChange::Modified,
            },
        ));
    }
    // Operands of different components touching along an edge or at a point: T ∪ K is
    // non-manifold there where the contact involves a tool (the operation creates it).
    // Two targets touching were separate bodies touching before the operation and stay
    // separate bodies: that contact is left as it was, whether or not a tool modifies one
    // of them elsewhere (as a cut treats targets one by one).
    for (x, &i) in order.iter().enumerate() {
        for &j in &order[x + 1..] {
            let (ci, cj) = (comp_of[i], comp_of[j]);
            if ci == cj || (i < nt && j < nt) {
                continue;
            }
            if let Some(c) = g.contact(i, j) {
                return Err(non_manifold(c));
            }
        }
    }
    for &i in order.iter().filter(|&&i| i < nt) {
        if !modified[comp_of[i]] {
            res.untouched.push(targets[i].origin.clone());
            res.untouched_targets.push(i);
        }
    }
    finish(out, targets, scale, res)
}

fn cut(
    targets: &[OpBody],
    tools: &[OpBody],
    ctx: &Ctx,
    res: &mut BodyOpResult,
) -> Result<(), BooleanError> {
    let nt = targets.len();
    let boxes = targets
        .iter()
        .chain(tools)
        .map(|o| body_box(&o.body))
        .collect::<Result<Vec<_>, _>>()?;
    let scale = ctx.scale.unwrap_or_else(|| scale_of(&boxes));
    let order = operand_order(targets, tools, scale)?;
    let tool_order: Vec<usize> = order
        .iter()
        .filter(|&&i| i >= nt)
        .map(|&i| i - nt)
        .collect();
    let tool_mass: Vec<Mass> = tools.iter().map(|k| operand_mass(&k.body)).collect();
    let mut out: Vec<(usize, ResultBody)> = Vec::new();
    let mut hit = vec![false; tools.len()];
    let mut touch = vec![false; tools.len()];
    for &ti in order.iter().filter(|&&i| i < nt) {
        let t = &targets[ti];
        let mut pieces: Vec<(Body, Mass)> = vec![(t.body.clone(), operand_mass(&t.body))];
        let mut changed = false;
        for &ki in &tool_order {
            let k = &tools[ki];
            let mut next = Vec::new();
            for (p, pm) in pieces {
                let two = boolean2(
                    &p,
                    pm,
                    &k.body,
                    tool_mass[ki],
                    BodyOp::Cut,
                    ctx.feature,
                    ctx.keys,
                )?;
                res.uncertified |= two.uncertified;
                touch[ki] |= two.overlap || two.contact.is_some();
                if two.changed_a {
                    changed = true;
                    hit[ki] = true;
                    res.aliases.extend(two.aliases);
                    next.extend(two.bodies.into_iter().zip(two.masses));
                } else {
                    next.push((p, pm));
                }
            }
            pieces = next;
        }
        if !changed {
            res.untouched.push(t.origin.clone());
            res.untouched_targets.push(ti);
            continue;
        }
        match pieces.len() {
            0 => {
                res.removed.push(t.origin.clone());
                res.notes.push(BooleanNote::Consumed {
                    origin: t.origin.clone(),
                });
            }
            n => {
                if n > 1 {
                    res.splits.push((t.origin.clone(), n));
                    res.notes.push(BooleanNote::Split {
                        origin: t.origin.clone(),
                        pieces: n,
                    });
                }
                for (p, _) in pieces {
                    out.push((
                        ti,
                        ResultBody {
                            body: p,
                            origin: t.origin.clone(),
                            change: BodyChange::Modified,
                        },
                    ));
                }
            }
        }
    }
    if !hit.iter().any(|&h| h) {
        // SPEC §6.0.3: no tool meets the interior of any target. Report the closest tool
        // (0 when it touches a target).
        let mut best: Option<(f64, usize)> = None;
        for &ki in &tool_order {
            let d = if touch[ki] {
                0.0
            } else {
                let d = targets
                    .iter()
                    .map(|t| min_distance(&t.body, &tools[ki].body))
                    .fold(f64::INFINITY, f64::min);
                if d.is_finite() {
                    d
                } else {
                    boxes[nt + ki].distance(&boxes[0])
                }
            };
            if best.is_none_or(|b| d < b.0) {
                best = Some((d, ki));
            }
        }
        let (d, ki) = best.expect("tools are not empty");
        return Err(BooleanError::NoIntersection {
            tool: tools[ki].origin.clone(),
            min_distance: d,
        });
    }
    finish(out, targets, scale, res)
}

fn intersect_op(
    targets: &[OpBody],
    tools: &[OpBody],
    ctx: &Ctx,
    res: &mut BodyOpResult,
) -> Result<(), BooleanError> {
    let nt = targets.len();
    let boxes = targets
        .iter()
        .chain(tools)
        .map(|o| body_box(&o.body))
        .collect::<Result<Vec<_>, _>>()?;
    let scale = ctx.scale.unwrap_or_else(|| scale_of(&boxes));
    let order = operand_order(targets, tools, scale)?;
    // Union of the tools: components of their overlap graph (tools that only touch stay
    // apart; the pieces they give are checked below).
    let tool_order: Vec<usize> = order
        .iter()
        .filter(|&&i| i >= nt)
        .map(|&i| i - nt)
        .collect();
    let mut g = Graph::build(
        tools.iter().map(|k| &k.body).collect(),
        tools.iter().map(|k| operand_mass(&k.body)).collect(),
        &tool_order,
        &boxes[nt..],
        ctx,
        res,
    )?;
    let all: Vec<usize> = (0..tools.len()).collect();
    let mut unions: Vec<(Body, Mass)> = Vec::new();
    for comp in g.components(&all) {
        let (body, _, mass) = g.unite(&comp, ctx, res)?;
        unions.push((body, mass));
    }
    let union_boxes = unions
        .iter()
        .map(|u| body_box(&u.0))
        .collect::<Result<Vec<_>, _>>()?;
    let mut out: Vec<(usize, ResultBody)> = Vec::new();
    let mut all_empty = true;
    for &ti in order.iter().filter(|&&i| i < nt) {
        let t = &targets[ti];
        let tm = operand_mass(&t.body);
        // (component, piece, mass)
        let mut pieces: Vec<(usize, Body, Mass)> = Vec::new();
        let mut unchanged = false;
        for (ui, (u, um)) in unions.iter().enumerate() {
            if boxes[ti].distance(&union_boxes[ui]) > 10.0 * VTOL {
                continue;
            }
            let two = boolean2(
                &t.body,
                tm,
                u,
                *um,
                BodyOp::Intersect,
                ctx.feature,
                ctx.keys,
            )?;
            res.uncertified |= two.uncertified;
            if two.overlap && !two.changed_a {
                // The target lies inside this component: the intersection is the target.
                unchanged = true;
                break;
            }
            res.aliases.extend(two.aliases);
            pieces.extend(
                two.bodies
                    .into_iter()
                    .zip(two.masses)
                    .map(|(b, m)| (ui, b, m)),
            );
        }
        if unchanged {
            // SPEC §6.0.3 intersects **each target** with the union of the tools, and §6.0.5
            // lists the bodies an operation created or modified: a target inside the tools
            // is its own intersection, reported as `modified` (with the unchanged geometry),
            // as the oracle reports every non-empty intersection (review round 4).
            all_empty = false;
            out.push((
                ti,
                ResultBody {
                    body: t.body.clone(),
                    origin: t.origin.clone(),
                    change: BodyChange::Modified,
                },
            ));
            continue;
        }
        // Pieces from different components touching along an edge or at a point: the
        // result touches itself (T ∩ ⋃K is non-manifold there).
        let several = pieces.iter().any(|(c, _, _)| *c != pieces[0].0);
        let piece_boxes = if several {
            pieces
                .iter()
                .map(|(_, b, _)| body_box(b))
                .collect::<Result<Vec<_>, _>>()?
        } else {
            Vec::new()
        };
        for x in 0..pieces.len() {
            for y in x + 1..pieces.len() {
                if pieces[x].0 == pieces[y].0
                    || piece_boxes[x].distance(&piece_boxes[y]) > 10.0 * VTOL
                {
                    continue;
                }
                let two = boolean2(
                    &pieces[x].1,
                    pieces[x].2,
                    &pieces[y].1,
                    pieces[y].2,
                    BodyOp::Join,
                    ctx.feature,
                    ctx.keys,
                )?;
                if two.overlap {
                    return Err(BooleanError::inconsistent(
                        "pieces of one target from disjoint tools overlap",
                        ctx.feature,
                    ));
                }
                if let Some(c) = two.contact {
                    return Err(non_manifold(c));
                }
            }
        }
        match pieces.len() {
            0 => {
                res.removed.push(t.origin.clone());
                res.notes.push(BooleanNote::Consumed {
                    origin: t.origin.clone(),
                });
            }
            n => {
                all_empty = false;
                if n > 1 {
                    res.splits.push((t.origin.clone(), n));
                    res.notes.push(BooleanNote::Split {
                        origin: t.origin.clone(),
                        pieces: n,
                    });
                }
                for (_, p, _) in pieces {
                    out.push((
                        ti,
                        ResultBody {
                            body: p,
                            origin: t.origin.clone(),
                            change: BodyChange::Modified,
                        },
                    ));
                }
            }
        }
    }
    if all_empty {
        return Err(BooleanError::EmptyResult {
            targets: order
                .iter()
                .filter(|&&i| i < nt)
                .map(|&i| targets[i].origin.clone())
                .collect(),
        });
    }
    finish(out, targets, scale, res)
}

/// Canonical order of the result bodies (SPEC §5.4): origin (timeline, member, instance),
/// then pieces of one origin by exact centroid with tolerance `LINEAR_TOLERANCE·s`.
fn finish(
    out: Vec<(usize, ResultBody)>,
    targets: &[OpBody],
    scale: f64,
    res: &mut BodyOpResult,
) -> Result<(), BooleanError> {
    let keys: Vec<OriginKey> = out.iter().map(|(t, _)| origin_key(&targets[*t])).collect();
    let perm = {
        let bodies: Vec<&Body> = out.iter().map(|(_, r)| &r.body).collect();
        canonical_perm(&keys, &bodies, scale, true)?
    };
    let mut slots: Vec<Option<ResultBody>> = out.into_iter().map(|x| Some(x.1)).collect();
    res.bodies = perm
        .into_iter()
        .map(|i| slots[i].take().expect("a permutation"))
        .collect();
    Ok(())
}

/// Ray directions shared by the classification and the shell tests.
pub(crate) fn classify_dirs() -> Vec<Vec3> {
    [
        [0.573_462_931_5, 0.618_033_988_7, 0.537_700_146_1],
        [-0.439_823_120_1, 0.766_044_443_1, -0.469_470_963_8],
        [0.271_828_182_8, -0.314_159_265_3, 0.909_297_426_8],
        [-0.832_049_307_2, -0.184_899_845_4, 0.522_687_228_6],
        [0.108_239_220_0, 0.994_125_159_8, -0.001_234_567_8],
        [0.947_368_421_1, 0.052_631_578_9, -0.315_789_473_7],
        [-0.267_261_241_9, -0.534_522_483_8, -0.801_783_725_7],
    ]
    .into_iter()
    .map(|d| Vec3::from(d).normalize().expect("unit"))
    .collect()
}

/// Debug: print every face's loops (curve kinds and end points).
pub(crate) fn debug_dump(body: &forge_core::topo::Body) {
    for (_, f) in body.faces().iter() {
        eprintln!(
            "face {} {} sense {}",
            f.provenance.name(),
            f.surface.kind_name(),
            f.sense
        );
        for &l in &f.loops {
            eprintln!(" loop");
            let Some(lp) = body.loop_(l) else { continue };
            for &cid in &lp.coedges {
                let Some(co) = body.coedge(cid) else { continue };
                let Some(e) = body.edge(co.edge) else {
                    continue;
                };
                let (t0, t1) = if co.forward {
                    e.t_range
                } else {
                    (e.t_range.1, e.t_range.0)
                };
                eprintln!(
                    "  {} fwd {} {:?} -> {:?} (mid {:?})",
                    e.curve.kind_name(),
                    co.forward,
                    e.curve.eval(t0),
                    e.curve.eval(t1),
                    e.curve.eval(0.5 * (t0 + t1))
                );
                if let Some(pc) = &co.pcurve {
                    let uv: Vec<(f64, f64)> = (0..=8)
                        .map(|i| {
                            let q = pc.eval(t0 + (t1 - t0) * i as f64 / 8.0);
                            (q.x, q.y)
                        })
                        .collect();
                    eprintln!("   pcurve {uv:.4?}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn al(v: &[(&str, &str)]) -> Aliases {
        v.iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    /// Successive merges `x → y`, `y → z` report `x → z` and `y → z`; self-aliases and
    /// duplicates disappear; a key merged into two survivors (split pieces) keeps both.
    #[test]
    fn alias_chains_resolve_to_the_final_key() {
        let got = collapse_aliases(al(&[
            ("k2/side:b", "k1/side:b"),
            ("k1/side:b", "a/side:b"),
            ("a/side:b", "a/side:b"),
            ("k2/side:b", "k1/side:b"),
            ("x", "y"),
            ("x", "z"),
        ]));
        assert_eq!(
            got,
            al(&[
                ("k1/side:b", "a/side:b"),
                ("k2/side:b", "a/side:b"),
                ("x", "y"),
                ("x", "z"),
            ])
        );
        // A cycle (never produced: survivors sort first) terminates.
        let got = collapse_aliases(al(&[("p", "q"), ("q", "p")]));
        assert!(got.iter().all(|(a, b)| a != b));
    }

    /// The tolerant lexicographic order of SPEC §5.4: coordinates within the tolerance tie
    /// and the next coordinate decides.
    #[test]
    fn lex_less_ties_within_the_tolerance() {
        let tol = 1e-6;
        assert!(lex_less(&[0.0, 1.0, 0.0], &[1.0, 0.0, 0.0], tol));
        assert!(lex_less(&[1.0 + 5e-7, 0.0, 0.0], &[1.0, 1.0, 0.0], tol));
        assert!(!lex_less(&[1.0, 1.0, 0.0], &[1.0 + 5e-7, 0.0, 0.0], tol));
        assert!(!lex_less(&[1.0, 1.0, 1.0], &[1.0, 1.0, 1.0], tol));
        assert!(lex_less(&[1.0, 1.0, 1.0 - 2e-6], &[1.0, 1.0, 1.0], tol));
    }

    /// Origins order first; runs of one origin by centroid (only runs are measured).
    #[test]
    fn canonical_order_is_by_key_then_centroid() {
        let cube = |x: f64| {
            let l = |id: &str, a: [f64; 2], b: [f64; 2]| forge_ir::SketchCurve::Line {
                id: id.into(),
                start: a,
                end: b,
            };
            corpus::Operand {
                feature: "c".into(),
                sketch: forge_ir::SketchFeature {
                    id: "s".into(),
                    name: "s".into(),
                    suppressed: false,
                    plane: forge_ir::PlaneSpec::Frame(forge_ir::Frame {
                        origin: [0.0, 0.0, 0.0],
                        normal: [0.0, 0.0, 1.0],
                        x_dir: [1.0, 0.0, 0.0],
                    }),
                    curves: vec![
                        l("b", [x, 0.0], [x + 1.0, 0.0]),
                        l("r", [x + 1.0, 0.0], [x + 1.0, 1.0]),
                        l("t", [x + 1.0, 1.0], [x, 1.0]),
                        l("l", [x, 1.0], [x, 0.0]),
                    ],
                },
                sweep: corpus::Sweep::Extrude {
                    distance: 1.0,
                    direction: forge_ir::SweepDirection::Normal,
                },
            }
            .build()
            .expect("cube")
        };
        let bodies = [cube(5.0), cube(0.0), cube(2.0), cube(-3.0)];
        let refs: Vec<&Body> = bodies.iter().collect();
        let keys = [1, 1, 0, 1];
        let perm = canonical_perm(&keys, &refs, 10.0, true).expect("order");
        assert_eq!(perm, vec![2, 3, 1, 0]);
    }
}
