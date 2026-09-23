//! Ground truth by geometry.
//!
//! Every face and edge of an evaluated model gets a [`Label`] computed **only** from the
//! IR document (sketch curves, planes, sweep parameters, read with SPEC semantics) and
//! the body's geometry and adjacency. It never reads provenance, names, fingerprints
//! or the resolver:
//!
//! - **Extrude caps**: planar faces whose normal is parallel to the sweep direction,
//!   classified by their offset along it: `Start` at the start of the sweep range of
//!   SPEC §4.2 (`0` for `normal`/`reverse`, `−d/2` for `symmetric`), `End` at its end.
//! - **Revolve end caps**: planar faces containing the axis, classified by their angle
//!   about it: `Start` where the rotation of SPEC §4.3 starts (the profile plane for
//!   `normal`/`reverse`, `−Θ/2` for `symmetric`), `End` where it ends.
//! - **Side faces**: the face of sketch curve `c` is the one whose boundary, mapped back
//!   to the sketch (dropping the extrude offset, or to `(ρ, h)` about the revolve axis),
//!   lies on `c`, contains every off-axis endpoint of `c`, and whose carrier surface
//!   contains `c` itself.
//! - **Edges**: the (sorted) labels of their two faces, plus — for edges that map back
//!   to a single sketch point — the set of sketch-curve ends meeting there (so the two
//!   edges between the same two faces of a "D" profile are told apart).
//! - Caps carry their body's identity as the set of curves whose side faces the body
//!   has.
//!
//! [`expected`] maps an old entity's label through a mutation's [`Intent`] (curve
//! splits, renames, removals, end swaps) and looks the result up among the new model's
//! labels: the entity is the same, renamed, split into pieces, or gone.

use std::collections::{BTreeMap, BTreeSet};

use forge_core::geom::Surface;
use forge_core::linalg::{Point2, Point3, Vec2, Vec3};
use forge_core::math;
use forge_ir::{Document, Feature, SketchCurve, SketchFeature, SweepDirection};

use crate::fingerprint::edge_samples;
use crate::view::{EntityId, Loc, ModelView};

/// Which end of a sweep.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SweepEnd {
    /// Where the sweep starts.
    Start,
    /// Where it ends.
    End,
}

/// Which end of a sketch curve.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CurveEnd {
    /// The IR `start`.
    Start,
    /// The IR `end`.
    End,
}

impl CurveEnd {
    fn flip(self) -> Self {
        match self {
            CurveEnd::Start => CurveEnd::End,
            CurveEnd::End => CurveEnd::Start,
        }
    }
}

/// Ground-truth identity of a face.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FaceLabel {
    /// A (revolve end) cap of `feature`'s body whose side faces come from `body`.
    Cap {
        /// Feature name.
        feature: String,
        /// Curves whose side faces the body has.
        body: BTreeSet<String>,
        /// Start or end of the sweep.
        end: SweepEnd,
    },
    /// The face swept from sketch curve `curve`.
    Side {
        /// Feature name.
        feature: String,
        /// Sketch curve id.
        curve: String,
    },
}

/// Ground-truth identity of an edge.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EdgeLabel {
    /// The two faces, sorted.
    pub faces: [FaceLabel; 2],
    /// For edges that map to one sketch point: the curve ends meeting there, sorted.
    pub at: Option<Vec<(String, CurveEnd)>>,
}

/// Ground-truth identity of a face or edge.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Label {
    /// A face.
    Face(FaceLabel),
    /// An edge.
    Edge(EdgeLabel),
}

/// Labels of every entity of one model.
#[derive(Clone, Debug, Default)]
pub struct Truth {
    /// Label per entity.
    pub labels: BTreeMap<Loc, Label>,
    /// Entities per label (more than one = a labelling collision).
    pub by_label: BTreeMap<Label, Vec<Loc>>,
    /// Entities the labeller could not identify, with the reason.
    pub problems: Vec<(Loc, String)>,
    /// Sketch of each body feature.
    pub feature_sketch: BTreeMap<String, String>,
}

/// How a mutation maps design entities (sketch curves) from the old to the new model.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Intent {
    /// The sketch whose curves the mutation edits (the maps apply to features on it).
    pub sketch: Option<String>,
    /// Old curve id → new curve ids (empty = removed; absent = unchanged id).
    pub curve_map: BTreeMap<String, Vec<String>>,
    /// Old curve end → new curve end, where it is not implied by `curve_map`.
    pub end_map: BTreeMap<(String, CurveEnd), (String, CurveEnd)>,
    /// Old curve ids that were only renamed.
    pub renamed: BTreeSet<String>,
}

impl Intent {
    /// No change to curve identities.
    pub fn identity() -> Self {
        Self::default()
    }
}

/// What the ground truth expects a reference to an old entity to resolve to.
#[derive(Clone, Debug, PartialEq)]
pub enum Expected {
    /// The same design entity exists (possibly moved or resized).
    Same(Loc),
    /// The same entity exists, but the mutation renamed its source curve.
    Renamed(Loc),
    /// The entity was split into these pieces.
    Split(Vec<Loc>),
    /// The entity no longer exists.
    Gone,
    /// The ground truth could not decide (labelling problem): excluded from scores.
    Inconclusive(String),
}

impl Expected {
    /// Short label for reports.
    pub fn kind_str(&self) -> &'static str {
        match self {
            Expected::Same(_) => "same",
            Expected::Renamed(_) => "renamed",
            Expected::Split(_) => "split",
            Expected::Gone => "gone",
            Expected::Inconclusive(_) => "inconclusive",
        }
    }
}

// ---- sketch geometry ----------------------------------------------------------------------

/// A sketch curve's exact 2D geometry (SPEC §3 semantics).
#[derive(Clone, Debug)]
pub(crate) enum CurveG {
    Line {
        a: Point2,
        b: Point2,
    },
    Arc {
        c: Point2,
        r: f64,
        a0: f64,
        sweep: f64,
        start: Point2,
        end: Point2,
    },
    Circle {
        c: Point2,
        r: f64,
    },
}

fn wrap_pos(a: f64) -> f64 {
    let t = a % math::TAU;
    if t < 0.0 { t + math::TAU } else { t }
}

fn wrap_pi(a: f64) -> f64 {
    let t = wrap_pos(a + math::PI);
    t - math::PI
}

impl CurveG {
    pub(crate) fn from_ir(c: &SketchCurve) -> CurveG {
        match c {
            SketchCurve::Line { start, end, .. } => CurveG::Line {
                a: Point2::from(*start),
                b: Point2::from(*end),
            },
            SketchCurve::Arc {
                start,
                end,
                center,
                ccw,
                ..
            } => {
                let (s, e, c) = (
                    Point2::from(*start),
                    Point2::from(*end),
                    Point2::from(*center),
                );
                let a0 = math::atan2(s.y - c.y, s.x - c.x);
                let a1 = math::atan2(e.y - c.y, e.x - c.x);
                let sweep = if *ccw {
                    let d = wrap_pos(a1 - a0);
                    if d == 0.0 { math::TAU } else { d }
                } else {
                    let d = wrap_pos(a0 - a1);
                    -(if d == 0.0 { math::TAU } else { d })
                };
                CurveG::Arc {
                    c,
                    r: s.distance(c),
                    a0,
                    sweep,
                    start: s,
                    end: e,
                }
            }
            SketchCurve::Circle { center, radius, .. } => CurveG::Circle {
                c: Point2::from(*center),
                r: *radius,
            },
        }
    }

    pub(crate) fn ends(&self) -> Option<(Point2, Point2)> {
        match self {
            CurveG::Line { a, b } => Some((*a, *b)),
            CurveG::Arc { start, end, .. } => Some((*start, *end)),
            CurveG::Circle { .. } => None,
        }
    }

    pub(crate) fn point_at(&self, t: f64) -> Point2 {
        match self {
            CurveG::Line { a, b } => a.lerp(*b, t),
            CurveG::Arc {
                c, r, a0, sweep, ..
            } => {
                let (s, co) = math::sin_cos(a0 + sweep * t);
                *c + Vec2::new(co, s) * *r
            }
            CurveG::Circle { c, r } => {
                let (s, co) = math::sin_cos(math::TAU * t);
                *c + Vec2::new(co, s) * *r
            }
        }
    }

    pub(crate) fn distance(&self, p: Point2) -> f64 {
        match self {
            CurveG::Line { a, b } => {
                let d = *b - *a;
                let l2 = d.dot(d);
                let t = if l2 > 0.0 {
                    ((p - *a).dot(d) / l2).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                p.distance(a.lerp(*b, t))
            }
            CurveG::Arc {
                c,
                r,
                a0,
                sweep,
                start,
                end,
            } => {
                let ang = math::atan2(p.y - c.y, p.x - c.x);
                let rel = if *sweep > 0.0 {
                    wrap_pos(ang - a0)
                } else {
                    wrap_pos(a0 - ang)
                };
                let within = rel <= sweep.abs() + 1e-12;
                let on = (p.distance(*c) - r).abs();
                if within {
                    on
                } else {
                    p.distance(*start).min(p.distance(*end))
                }
            }
            CurveG::Circle { c, r } => (p.distance(*c) - r).abs(),
        }
    }
}

/// Sketch geometry with its plane frame (SPEC §2, read directly from the IR).
struct SketchG {
    o: Vec3,
    x: Vec3,
    y: Vec3,
    n: Vec3,
    curves: Vec<(String, CurveG)>,
}

impl SketchG {
    fn new(s: &SketchFeature) -> Self {
        let (o, x, y, n) = s.plane.resolve();
        SketchG {
            o: Vec3::from(o),
            x: Vec3::from(x),
            y: Vec3::from(y),
            n: Vec3::from(n),
            curves: s
                .curves
                .iter()
                .map(|c| (c.id().to_string(), CurveG::from_ir(c)))
                .collect(),
        }
    }
    fn to_2d(&self, p: Point3) -> Point2 {
        let w = p - self.o;
        Point2::new(w.dot(self.x), w.dot(self.y))
    }
    fn to_3d(&self, q: Point2) -> Point3 {
        self.o + self.x * q.x + self.y * q.y
    }
    fn curve(&self, id: &str) -> Option<&CurveG> {
        self.curves.iter().find(|(i, _)| i == id).map(|(_, c)| c)
    }
}

fn surface_distance(s: &Surface, p: Point3) -> f64 {
    s.project(p).2
}

// ---- labelling ----------------------------------------------------------------------------

fn boundary_samples(view: &ModelView, loc_body: usize, f: forge_core::topo::FaceId) -> Vec<Point3> {
    let body = &view.bodies[loc_body].body;
    let mut pts = Vec::new();
    for e in body.face_edges(f) {
        pts.extend(edge_samples(body, e));
    }
    pts
}

struct Ctx<'a> {
    sk: SketchG,
    feature: &'a str,
    tol: f64,
}

/// Revolve geometry: axis in 3D and in the sketch.
struct Axis {
    a3: Vec3,
    d3: Vec3,
    o2: Point2,
    dh: Vec2,
}

impl Axis {
    /// `(ρ, h)` of a 3D point.
    fn rho_h3(&self, p: Point3) -> (f64, f64) {
        let w = p - self.a3;
        let h = w.dot(self.d3);
        ((w - self.d3 * h).norm(), h)
    }
    /// Signed distance from the axis and height of a sketch point.
    fn side_h2(&self, q: Point2) -> (f64, f64) {
        let w = q - self.o2;
        (self.dh.perp_dot(w), self.dh.dot(w))
    }
    /// The sketch point at `(ρ, h)` on side `sigma` (±1).
    fn point_at_rho_h(&self, rho: f64, h: f64, sigma: f64) -> Point2 {
        self.o2 + self.dh * h + self.dh.perp() * (sigma * rho)
    }
}

/// Side of the axis a curve lies on (+1 left, −1 right): the sign at the sample farthest
/// from the axis.
fn curve_side(ax: &Axis, c: &CurveG) -> f64 {
    let mut best = 0.0_f64;
    for i in 0..=16 {
        let (s, _) = ax.side_h2(c.point_at(i as f64 / 16.0));
        if s.abs() > best.abs() {
            best = s;
        }
    }
    if best < 0.0 { -1.0 } else { 1.0 }
}

/// Label every entity of `view`, using the IR in `doc`.
pub fn label(doc: &Document, view: &ModelView) -> Truth {
    let mut t = Truth::default();
    // Feature and sketch lookup by name (names are unique per document).
    let mut sketches: BTreeMap<&str, &SketchFeature> = BTreeMap::new();
    let mut features: BTreeMap<&str, &Feature> = BTreeMap::new();
    for p in &doc.parts {
        for f in &p.features {
            if let Feature::Sketch(s) = f {
                sketches.insert(s.name.as_str(), s);
            }
            features.insert(f.name(), f);
        }
    }
    for (bi, b) in view.bodies.iter().enumerate() {
        let Some(feat) = features.get(b.feature.as_str()) else {
            continue;
        };
        let (sketch_name, is_revolve) = match feat {
            Feature::Extrude(e) => (e.sketch.as_str(), false),
            Feature::Revolve(r) => (r.sketch.as_str(), true),
            Feature::Sketch(_) => continue,
        };
        t.feature_sketch
            .insert(b.feature.clone(), sketch_name.to_string());
        let Some(sk) = sketches.get(sketch_name) else {
            continue;
        };
        let scale = view
            .entities()
            .into_iter()
            .find(|l| l.body == bi)
            .and_then(|l| view.info(l))
            .map_or(1.0, |i| i.fingerprint.scale);
        let ctx = Ctx {
            sk: SketchG::new(sk),
            feature: b.feature.as_str(),
            tol: 1e-6 * scale.max(1.0),
        };
        if is_revolve {
            if let Feature::Revolve(r) = feat {
                label_revolve(&mut t, view, bi, &ctx, r);
            }
        } else if let Feature::Extrude(e) = feat {
            label_extrude(&mut t, view, bi, &ctx, e);
        }
    }
    for (l, lab) in &t.labels {
        t.by_label.entry(lab.clone()).or_default().push(*l);
    }
    t
}

/// Find the unique sketch curve whose side face `pts2` (boundary mapped to the sketch)
/// bounds, with `on_surface` checking that the curve lies on the face's carrier.
fn match_side<'a>(
    ctx: &'a Ctx<'_>,
    pts2: &dyn Fn(&CurveG) -> Vec<Point2>,
    needs_end: &dyn Fn(&CurveG, Point2) -> bool,
    on_surface: &dyn Fn(&CurveG) -> bool,
) -> Result<&'a str, String> {
    let mut hits: Vec<&str> = Vec::new();
    for (id, c) in &ctx.sk.curves {
        let pts = pts2(c);
        if !pts.iter().all(|p| c.distance(*p) <= ctx.tol) {
            continue;
        }
        if let Some((a, b)) = c.ends() {
            let covered =
                |e: Point2| !needs_end(c, e) || pts.iter().any(|p| p.distance(e) <= ctx.tol);
            if !(covered(a) && covered(b)) {
                continue;
            }
        }
        if !on_surface(c) {
            continue;
        }
        hits.push(id.as_str());
    }
    match hits.as_slice() {
        [one] => Ok(one),
        [] => Err("no sketch curve matches the side face".into()),
        many => Err(format!("several curves match the side face: {many:?}")),
    }
}

fn label_extrude(
    t: &mut Truth,
    view: &ModelView,
    bi: usize,
    ctx: &Ctx<'_>,
    e: &forge_ir::ExtrudeFeature,
) {
    let body = &view.bodies[bi].body;
    let d = e.distance;
    let (z_start, z_end) = match e.direction {
        SweepDirection::Normal => (0.0, d),
        SweepDirection::Reverse => (0.0, -d),
        SweepDirection::Symmetric => (-0.5 * d, 0.5 * d),
    };
    let n = ctx.sk.n;
    let mut caps: Vec<(Loc, SweepEnd)> = Vec::new();
    let mut body_curves: BTreeSet<String> = BTreeSet::new();
    for (fid, f) in body.faces().iter() {
        let loc = Loc {
            body: bi,
            entity: EntityId::Face(fid),
        };
        if let Surface::Plane(p) = &f.surface
            && p.frame().z().dot(n).abs() >= 1.0 - 1e-9
        {
            let z = (p.frame().origin() - ctx.sk.o).dot(n);
            if (z - z_start).abs() <= ctx.tol {
                caps.push((loc, SweepEnd::Start));
            } else if (z - z_end).abs() <= ctx.tol {
                caps.push((loc, SweepEnd::End));
            } else {
                t.problems.push((loc, format!("cap plane at offset {z}")));
            }
            continue;
        }
        let samples = boundary_samples(view, bi, fid);
        let pts: Vec<Point2> = samples.iter().map(|p| ctx.sk.to_2d(*p)).collect();
        let zm = 0.5 * (z_start + z_end);
        let res = match_side(ctx, &|_| pts.clone(), &|_, _| true, &|c| {
            [0.25, 0.5, 0.75].iter().all(|&s| {
                surface_distance(&f.surface, ctx.sk.to_3d(c.point_at(s)) + n * zm) <= ctx.tol
            })
        });
        match res {
            Ok(c) => {
                body_curves.insert(c.to_string());
                t.labels.insert(
                    loc,
                    Label::Face(FaceLabel::Side {
                        feature: ctx.feature.to_string(),
                        curve: c.to_string(),
                    }),
                );
            }
            Err(msg) => t.problems.push((loc, msg)),
        }
    }
    for (loc, end) in caps {
        t.labels.insert(
            loc,
            Label::Face(FaceLabel::Cap {
                feature: ctx.feature.to_string(),
                body: body_curves.clone(),
                end,
            }),
        );
    }
    // Edges: faces + the junction for edges that project to one sketch point.
    let body_curve_list: Vec<&(String, CurveG)> = ctx
        .sk
        .curves
        .iter()
        .filter(|(id, _)| body_curves.contains(id))
        .collect();
    for (eid, _) in body.edges().iter() {
        let loc = Loc {
            body: bi,
            entity: EntityId::Edge(eid),
        };
        let pts: Vec<Point2> = edge_samples(body, eid)
            .iter()
            .map(|p| ctx.sk.to_2d(*p))
            .collect();
        let at = point_of(&pts, ctx.tol)
            .map(|p| junction(&body_curve_list, ctx.tol, |c| c.ends(), p, |_, q| q));
        edge_label(t, view, loc, eid, at);
    }
}

/// The single point a sample set collapses to, if it does.
fn point_of(pts: &[Point2], tol: f64) -> Option<Point2> {
    let first = *pts.first()?;
    pts.iter()
        .all(|p| p.distance(first) <= tol)
        .then_some(first)
}

/// Curve ends (of `curves`) at the sketch point `p`; `map_end` lets revolve compare in
/// `(ρ, h)`.
fn junction(
    curves: &[&(String, CurveG)],
    tol: f64,
    ends: impl Fn(&CurveG) -> Option<(Point2, Point2)>,
    p: Point2,
    map_end: impl Fn(&CurveG, Point2) -> Point2,
) -> Vec<(String, CurveEnd)> {
    let mut out = Vec::new();
    for (id, c) in curves {
        if let Some((a, b)) = ends(c) {
            if map_end(c, a).distance(p) <= tol {
                out.push((id.clone(), CurveEnd::Start));
            }
            if map_end(c, b).distance(p) <= tol {
                out.push((id.clone(), CurveEnd::End));
            }
        }
    }
    out.sort();
    out
}

fn edge_label(
    t: &mut Truth,
    view: &ModelView,
    loc: Loc,
    eid: forge_core::topo::EdgeId,
    at: Option<Vec<(String, CurveEnd)>>,
) {
    let body = &view.bodies[loc.body].body;
    let faces = body.edge_faces(eid);
    let labs: Vec<FaceLabel> = faces
        .iter()
        .filter_map(|f| {
            match t.labels.get(&Loc {
                body: loc.body,
                entity: EntityId::Face(*f),
            }) {
                Some(Label::Face(fl)) => Some(fl.clone()),
                _ => None,
            }
        })
        .collect();
    let [a, b] = labs.as_slice() else {
        t.problems
            .push((loc, format!("edge with {} labelled faces", labs.len())));
        return;
    };
    let mut pair = [a.clone(), b.clone()];
    pair.sort();
    t.labels
        .insert(loc, Label::Edge(EdgeLabel { faces: pair, at }));
}

fn label_revolve(
    t: &mut Truth,
    view: &ModelView,
    bi: usize,
    ctx: &Ctx<'_>,
    r: &forge_ir::RevolveFeature,
) {
    let body = &view.bodies[bi].body;
    let sk = &ctx.sk;
    let o2 = Point2::from(r.axis.origin);
    let Some(dh) = Vec2::from(r.axis.direction).normalize() else {
        return;
    };
    let a3 = sk.to_3d(o2);
    let Some(d3) = (sk.x * dh.x + sk.y * dh.y).normalize() else {
        return;
    };
    let ax = Axis { a3, d3, o2, dh };
    let full = r.angle >= 360.0;
    let theta = math::deg_to_rad(r.angle);

    let mut caps: Vec<(Loc, Point3)> = Vec::new();
    let mut body_curves: BTreeSet<String> = BTreeSet::new();
    let mut sides: Vec<f64> = Vec::new();
    for (fid, f) in body.faces().iter() {
        let loc = Loc {
            body: bi,
            entity: EntityId::Face(fid),
        };
        let samples = boundary_samples(view, bi, fid);
        if let Surface::Plane(p) = &f.surface
            && p.frame().z().dot(d3).abs() <= 1e-9
            && surface_distance(&f.surface, a3) <= ctx.tol
        {
            // An end cap: remember its farthest boundary point for the angle test.
            let far = samples
                .iter()
                .copied()
                .max_by(|a, b| ax.rho_h3(*a).0.total_cmp(&ax.rho_h3(*b).0));
            match far {
                Some(p) if !full => caps.push((loc, p)),
                _ => t.problems.push((loc, "unexpected end-cap plane".into())),
            }
            continue;
        }
        let rh: Vec<(f64, f64)> = samples.iter().map(|p| ax.rho_h3(*p)).collect();
        let res = match_side(
            ctx,
            &|c| {
                let s = curve_side(&ax, c);
                rh.iter()
                    .map(|&(rho, h)| ax.point_at_rho_h(rho, h, s))
                    .collect()
            },
            &|_, e| ax.side_h2(e).0.abs() > ctx.tol,
            &|c| {
                [0.25, 0.5, 0.75]
                    .iter()
                    .all(|&s| surface_distance(&f.surface, sk.to_3d(c.point_at(s))) <= ctx.tol)
            },
        );
        match res {
            Ok(c) => {
                body_curves.insert(c.to_string());
                if let Some(cg) = sk.curve(c) {
                    sides.push(curve_side(&ax, cg));
                }
                t.labels.insert(
                    loc,
                    Label::Face(FaceLabel::Side {
                        feature: ctx.feature.to_string(),
                        curve: c.to_string(),
                    }),
                );
            }
            Err(msg) => t.problems.push((loc, msg)),
        }
    }
    // End caps by angle. φ is measured about d3 from e1 (the sketch's left normal of the
    // axis); the profile lies at φ_p = 0 (left) or π (right).
    let sigma = sides.first().copied().unwrap_or(1.0);
    let e1 = (sk.x * (-dh.y) + sk.y * dh.x).normalize().unwrap_or(sk.x);
    let e2 = d3.cross(e1);
    let phi_p = if sigma > 0.0 { 0.0 } else { math::PI };
    let (start, end) = match r.direction {
        SweepDirection::Normal => (phi_p, phi_p + theta),
        SweepDirection::Reverse => (phi_p, phi_p - theta),
        SweepDirection::Symmetric => (phi_p - 0.5 * theta, phi_p + 0.5 * theta),
    };
    for (loc, p) in caps {
        let w = p - a3;
        let phi = math::atan2(w.dot(e2), w.dot(e1));
        let lab_end = if wrap_pi(phi - start).abs() <= 1e-7 {
            Some(SweepEnd::Start)
        } else if wrap_pi(phi - end).abs() <= 1e-7 {
            Some(SweepEnd::End)
        } else {
            None
        };
        match lab_end {
            Some(end) => {
                t.labels.insert(
                    loc,
                    Label::Face(FaceLabel::Cap {
                        feature: ctx.feature.to_string(),
                        body: body_curves.clone(),
                        end,
                    }),
                );
            }
            None => t
                .problems
                .push((loc, format!("end cap at unexpected angle {phi}"))),
        }
    }
    // Edges.
    let body_curve_list: Vec<&(String, CurveG)> = sk
        .curves
        .iter()
        .filter(|(id, _)| body_curves.contains(id))
        .collect();
    for (eid, _) in body.edges().iter() {
        let loc = Loc {
            body: bi,
            entity: EntityId::Edge(eid),
        };
        let rh: Vec<Point2> = edge_samples(body, eid)
            .iter()
            .map(|p| {
                let (rho, h) = ax.rho_h3(*p);
                Point2::new(rho, h)
            })
            .collect();
        let at = point_of(&rh, ctx.tol).and_then(|p| {
            // An edge on the axis (ρ = 0 everywhere) that does not move is a point only
            // if it has no length; profile-junction arcs have ρ > 0.
            (p.x > ctx.tol).then(|| {
                junction(
                    &body_curve_list,
                    ctx.tol,
                    |c| c.ends(),
                    p,
                    |_, q| {
                        let (s, h) = ax.side_h2(q);
                        Point2::new(s.abs(), h)
                    },
                )
            })
        });
        edge_label(t, view, loc, eid, at);
    }
}

// ---- expectations -------------------------------------------------------------------------

struct Mapper<'a> {
    old: &'a Truth,
    new: &'a Truth,
    intent: &'a Intent,
}

impl Mapper<'_> {
    fn applies(&self, feature: &str) -> bool {
        match (&self.intent.sketch, self.old.feature_sketch.get(feature)) {
            (Some(s), Some(fs)) => s == fs,
            _ => false,
        }
    }

    /// New ids of an old curve, and whether this was a rename.
    fn curve(&self, feature: &str, c: &str) -> (Vec<String>, bool) {
        if !self.applies(feature) {
            return (vec![c.to_string()], false);
        }
        match self.intent.curve_map.get(c) {
            Some(v) => (v.clone(), self.intent.renamed.contains(c)),
            None => (vec![c.to_string()], false),
        }
    }

    fn end(&self, feature: &str, c: &str, e: CurveEnd) -> Option<((String, CurveEnd), bool)> {
        if !self.applies(feature) {
            return Some(((c.to_string(), e), false));
        }
        if let Some(m) = self.intent.end_map.get(&(c.to_string(), e)) {
            return Some((m.clone(), self.intent.renamed.contains(c)));
        }
        let (ids, renamed) = self.curve(feature, c);
        match ids.as_slice() {
            [] => None,
            [one] => Some(((one.clone(), e), renamed)),
            [first, .., last] => Some((
                (
                    if e == CurveEnd::Start {
                        first.clone()
                    } else {
                        last.clone()
                    },
                    e,
                ),
                renamed,
            )),
        }
    }

    fn face(&self, f: &FaceLabel) -> (Vec<FaceLabel>, bool) {
        match f {
            FaceLabel::Side { feature, curve } => {
                let (ids, renamed) = self.curve(feature, curve);
                (
                    ids.into_iter()
                        .map(|c| FaceLabel::Side {
                            feature: feature.clone(),
                            curve: c,
                        })
                        .collect(),
                    renamed,
                )
            }
            FaceLabel::Cap { feature, body, end } => {
                // The body set only identifies the body: a renamed curve in it does not
                // make the cap itself "renamed".
                let mut mapped: BTreeSet<String> = BTreeSet::new();
                let renamed = false;
                for c in body {
                    mapped.extend(self.curve(feature, c).0);
                }
                // The new cap of the same feature and end whose body shares the most
                // curves with the mapped body.
                let mut best: Vec<(usize, &FaceLabel)> = Vec::new();
                for lab in self.new.by_label.keys() {
                    if let Label::Face(
                        fl @ FaceLabel::Cap {
                            feature: nf,
                            body: nb,
                            end: ne,
                        },
                    ) = lab
                        && nf == feature
                        && ne == end
                    {
                        let ov = nb.intersection(&mapped).count();
                        if ov > 0 {
                            best.push((ov, fl));
                        }
                    }
                }
                best.sort_by(|a, b| b.0.cmp(&a.0));
                match best.as_slice() {
                    [] => (Vec::new(), renamed),
                    [(_, one)] => (vec![(*one).clone()], renamed),
                    [(a, one), (b, _), ..] if a > b => (vec![(*one).clone()], renamed),
                    _ => (Vec::new(), renamed),
                }
            }
        }
    }

    fn feature_of(f: &FaceLabel) -> &str {
        match f {
            FaceLabel::Cap { feature, .. } | FaceLabel::Side { feature, .. } => feature,
        }
    }

    fn labels(&self, l: &Label) -> (Vec<Label>, bool) {
        match l {
            Label::Face(f) => {
                let (v, r) = self.face(f);
                (v.into_iter().map(Label::Face).collect(), r)
            }
            Label::Edge(e) => {
                let (fa, ra) = self.face(&e.faces[0]);
                let (fb, rb) = self.face(&e.faces[1]);
                let mut renamed = ra || rb;
                let feature = Self::feature_of(&e.faces[0]).to_string();
                let at = match &e.at {
                    None => None,
                    Some(ends) => {
                        let mut v = Vec::new();
                        for (c, end) in ends {
                            match self.end(&feature, c, *end) {
                                Some((m, r)) => {
                                    renamed |= r;
                                    v.push(m);
                                }
                                None => return (Vec::new(), renamed),
                            }
                        }
                        v.sort();
                        Some(v)
                    }
                };
                let mut out = Vec::new();
                for a in &fa {
                    for b in &fb {
                        let mut pair = [a.clone(), b.clone()];
                        pair.sort();
                        out.push(Label::Edge(EdgeLabel {
                            faces: pair,
                            at: at.clone(),
                        }));
                    }
                }
                (out, renamed)
            }
        }
    }
}

/// What a reference to the old entity at `loc` should resolve to in the new model.
pub fn expected(old: &Truth, new: &Truth, intent: &Intent, loc: Loc) -> Expected {
    let Some(lab) = old.labels.get(&loc) else {
        let why = old
            .problems
            .iter()
            .find(|(l, _)| *l == loc)
            .map_or("unlabelled".to_string(), |(_, m)| m.clone());
        return Expected::Inconclusive(format!("old entity: {why}"));
    };
    if old.by_label.get(lab).is_some_and(|v| v.len() > 1) {
        return Expected::Inconclusive("old label collision".into());
    }
    let m = Mapper { old, new, intent };
    let (targets, renamed) = m.labels(lab);
    let mut found: Vec<Loc> = Vec::new();
    for t in &targets {
        match new.by_label.get(t).map(Vec::as_slice) {
            None | Some([]) => {}
            Some([one]) => found.push(*one),
            Some(_) => return Expected::Inconclusive("new label collision".into()),
        }
    }
    found.sort();
    found.dedup();
    match found.as_slice() {
        [] => Expected::Gone,
        [one] if renamed => Expected::Renamed(*one),
        [one] => Expected::Same(*one),
        _ => Expected::Split(found),
    }
}

/// Flip the ends of `curve` (for a mutation that reverses its direction).
pub fn flipped_ends(curve: &str) -> BTreeMap<(String, CurveEnd), (String, CurveEnd)> {
    [CurveEnd::Start, CurveEnd::End]
        .into_iter()
        .map(|e| ((curve.to_string(), e), (curve.to_string(), e.flip())))
        .collect()
}
