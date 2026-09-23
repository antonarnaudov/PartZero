//! Scripted mutations of IR v0 documents.
//!
//! Each generator inspects a model, picks its targets deterministically (sketch order,
//! loop order, lengths) and returns a [`Mutation`]: the document before and after, and
//! the [`Intent`] that tells the ground truth how sketch curves map across the edit
//! (splits, renames, removals, direction flips). Generators that do not apply to a model
//! return nothing; the runner validates every candidate (IR validation, evaluation, and a
//! topology-preservation check for the dimension family) and records rejections.
//!
//! # Families
//! - **(a) Dimension** — topology-preserving edits: offset a line, move a polygon
//!   vertex, resize a circle, move a hole, move a "D" loop so one junction lands on the
//!   other (adversarial for `#index` validation), scale a sketch, extrude distance and
//!   direction, revolve angle and direction, move the sketch plane, and two
//!   re-expressions with no geometric change (reverse a curve's direction, reorder a
//!   sketch's curve list).
//! - **(b) Suppress** — suppress a body feature, unsuppress one, suppress a sketch.
//! - **(c) Topology** — split a line (keeping or replacing its id), split an arc, add a
//!   hole, remove a hole, fillet a line–line corner with an arc and the inverse (remove
//!   an arc, extend its lines to a corner), bulge a line into an arc and flatten an arc
//!   into its chord (same id, new surface type), add a disjoint region (a new body of
//!   the same feature), revolve 360° → partial and partial → 360°, reorder independent
//!   features or parts, rename a curve, rename *and* move a circle. Dimension edits that turn out to change a
//!   face's type or count (a vertex moved off a revolve axis) are re-filed here.

use std::collections::BTreeSet;

use forge_core::linalg::{Point2, Vec2};
use forge_core::{Tolerance, math};
use forge_ir::{
    Document, Feature, Frame, PlaneSpec, SketchAxis, SketchCurve, SketchFeature, SweepDirection,
};
use forge_ops::{LoopCurveGeom, Region, regions};

use super::truth::{CurveEnd, CurveG, Intent, flipped_ends};

/// Mutation family (the spike's criteria are per family).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Family {
    /// (a) topology-preserving dimension edits.
    Dimension,
    /// (b) suppress / unsuppress.
    Suppress,
    /// (c) topology-changing edits.
    Topology,
}

impl Family {
    /// Report label.
    pub fn as_str(self) -> &'static str {
        match self {
            Family::Dimension => "(a) dimension",
            Family::Suppress => "(b) suppress",
            Family::Topology => "(c) topology",
        }
    }
}

/// One scripted edit.
#[derive(Clone, Debug)]
pub struct Mutation {
    /// Unique id within the model, e.g. `offset_line:bottom`.
    pub id: String,
    /// Family.
    pub family: Family,
    /// Generator name.
    pub kind: &'static str,
    /// What was done, in words.
    pub description: String,
    /// The document references are captured on.
    pub base: Document,
    /// The edited document.
    pub mutated: Document,
    /// How curve identities map across the edit.
    pub intent: Intent,
}

// ---- document helpers --------------------------------------------------------------------

fn p2(a: [f64; 2]) -> Point2 {
    Point2::from(a)
}

fn a2(p: Point2) -> [f64; 2] {
    [p.x, p.y]
}

/// Body features (part index, feature index) in document order, not suppressed.
fn body_features(doc: &Document) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    for (pi, p) in doc.parts.iter().enumerate() {
        for (fi, f) in p.features.iter().enumerate() {
            if matches!(f, Feature::Extrude(_) | Feature::Revolve(_)) && !f.suppressed() {
                out.push((pi, fi));
            }
        }
    }
    out
}

fn feature_sketch(f: &Feature) -> Option<&str> {
    match f {
        Feature::Extrude(e) => Some(&e.sketch),
        Feature::Revolve(r) => Some(&r.sketch),
        Feature::Sketch(_) => None,
    }
}

fn sketch_ref<'a>(doc: &'a Document, name: &str) -> Option<&'a SketchFeature> {
    doc.parts
        .iter()
        .flat_map(|p| &p.features)
        .find_map(|f| match f {
            Feature::Sketch(s) if s.name == name => Some(s),
            _ => None,
        })
}

fn sketch_mut<'a>(doc: &'a mut Document, name: &str) -> Option<&'a mut SketchFeature> {
    doc.parts
        .iter_mut()
        .flat_map(|p| p.features.iter_mut())
        .find_map(|f| match f {
            Feature::Sketch(s) if s.name == name => Some(s),
            _ => None,
        })
}

/// The revolve axis of the (first) revolve built on `sketch`, if any.
fn revolve_axis(doc: &Document, sketch: &str) -> Option<SketchAxis> {
    doc.parts
        .iter()
        .flat_map(|p| &p.features)
        .find_map(|f| match f {
            Feature::Revolve(r) if r.sketch == sketch => Some(r.axis.clone()),
            _ => None,
        })
}

/// Sketches used by body features, in document order, deduplicated.
fn used_sketches(doc: &Document) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (pi, fi) in body_features(doc) {
        if let Some(s) = feature_sketch(&doc.parts[pi].features[fi])
            && !out.iter().any(|x| x == s)
        {
            out.push(s.to_string());
        }
    }
    out
}

fn sketch_regions(doc: &Document, sketch: &str) -> Vec<Region> {
    sketch_ref(doc, sketch)
        .and_then(|s| regions(s, &Tolerance::IR_DEFAULT).ok())
        .unwrap_or_default()
}

fn curve_ends(c: &SketchCurve) -> Option<(Point2, Point2)> {
    match c {
        SketchCurve::Line { start, end, .. } | SketchCurve::Arc { start, end, .. } => {
            Some((p2(*start), p2(*end)))
        }
        SketchCurve::Circle { .. } => None,
    }
}

const SAME_POINT: f64 = 1e-7;

/// Move every curve end at `old` to `new`; only lines may be touched there.
fn move_point(s: &mut SketchFeature, old: Point2, new: Point2) -> bool {
    let touching: Vec<usize> = s
        .curves
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            curve_ends(c).is_some_and(|(a, b)| {
                a.distance(old) <= SAME_POINT || b.distance(old) <= SAME_POINT
            })
        })
        .map(|(i, _)| i)
        .collect();
    if touching.is_empty()
        || touching
            .iter()
            .any(|&i| !matches!(s.curves[i], SketchCurve::Line { .. }))
    {
        return false;
    }
    for i in touching {
        if let SketchCurve::Line { start, end, .. } = &mut s.curves[i] {
            if p2(*start).distance(old) <= SAME_POINT {
                *start = a2(new);
            }
            if p2(*end).distance(old) <= SAME_POINT {
                *end = a2(new);
            }
        }
    }
    true
}

/// Set the IR end of curve `id` that sits at `at` to `to` (lines only).
fn set_line_end_at(s: &mut SketchFeature, id: &str, at: Point2, to: Point2) -> bool {
    for c in &mut s.curves {
        if let SketchCurve::Line {
            id: cid,
            start,
            end,
        } = c
            && cid == id
        {
            if p2(*start).distance(at) <= SAME_POINT {
                *start = a2(to);
                return true;
            }
            if p2(*end).distance(at) <= SAME_POINT {
                *end = a2(to);
                return true;
            }
        }
    }
    false
}

fn line_len(c: &SketchCurve) -> f64 {
    match c {
        SketchCurve::Line { start, end, .. } => p2(*start).distance(p2(*end)),
        _ => 0.0,
    }
}

/// Bounding-box diagonal of a sketch's curve samples (its length scale).
fn sketch_diag(s: &SketchFeature) -> f64 {
    let (mut lo, mut hi) = (
        Point2::new(f64::INFINITY, f64::INFINITY),
        Point2::new(f64::NEG_INFINITY, f64::NEG_INFINITY),
    );
    for c in &s.curves {
        let g = CurveG::from_ir(c);
        for i in 0..=16 {
            let p = g.point_at(i as f64 / 16.0);
            lo = Point2::new(lo.x.min(p.x), lo.y.min(p.y));
            hi = Point2::new(hi.x.max(p.x), hi.y.max(p.y));
        }
    }
    lo.distance(hi)
}

fn sketch_bbox(s: &SketchFeature) -> (Point2, Point2) {
    let (mut lo, mut hi) = (
        Point2::new(f64::INFINITY, f64::INFINITY),
        Point2::new(f64::NEG_INFINITY, f64::NEG_INFINITY),
    );
    for c in &s.curves {
        let g = CurveG::from_ir(c);
        for i in 0..=32 {
            let p = g.point_at(i as f64 / 32.0);
            lo = Point2::new(lo.x.min(p.x), lo.y.min(p.y));
            hi = Point2::new(hi.x.max(p.x), hi.y.max(p.y));
        }
    }
    (lo, hi)
}

/// Signed distance of `q` from the revolve axis (positive on the left).
fn axis_side(axis: &SketchAxis, q: Point2) -> f64 {
    let d = Vec2::from(axis.direction)
        .normalize()
        .unwrap_or(Vec2::unit_y());
    d.perp_dot(q - p2(axis.origin))
}

fn on_axis(axis: Option<&SketchAxis>, q: Point2) -> bool {
    axis.is_some_and(|a| axis_side(a, q).abs() <= 1e-6)
}

/// Intersection of lines `p + s·d` and `q + t·e`.
fn intersect(p: Point2, d: Vec2, q: Point2, e: Vec2) -> Option<Point2> {
    let den = d.perp_dot(e);
    if den.abs() <= 1e-9 * d.norm() * e.norm() {
        return None;
    }
    let s = (q - p).perp_dot(e) / den;
    Some(p + d * s)
}

/// Translate the curves `ids` of a sketch by `v`.
fn translate_curves(s: &mut SketchFeature, ids: &BTreeSet<String>, v: Vec2) {
    for c in &mut s.curves {
        if !ids.contains(c.id()) {
            continue;
        }
        match c {
            SketchCurve::Line { start, end, .. } => {
                *start = a2(p2(*start) + v);
                *end = a2(p2(*end) + v);
            }
            SketchCurve::Arc {
                start, end, center, ..
            } => {
                *start = a2(p2(*start) + v);
                *end = a2(p2(*end) + v);
                *center = a2(p2(*center) + v);
            }
            SketchCurve::Circle { center, .. } => *center = a2(p2(*center) + v),
        }
    }
}

/// A fresh curve id derived from `base`.
fn fresh_id(s: &SketchFeature, base: &str) -> String {
    let taken: BTreeSet<&str> = s.curves.iter().map(SketchCurve::id).collect();
    if !taken.contains(base) {
        return base.to_string();
    }
    (2..)
        .map(|k| format!("{base}{k}"))
        .find(|c| !taken.contains(c.as_str()))
        .expect("unbounded")
}

struct Builder<'a> {
    model: &'a Document,
    out: Vec<Mutation>,
}

impl Builder<'_> {
    fn push(
        &mut self,
        family: Family,
        kind: &'static str,
        target: &str,
        description: String,
        mutated: Document,
        intent: Intent,
    ) {
        self.push_with_base(
            family,
            kind,
            target,
            description,
            self.model.clone(),
            mutated,
            intent,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn push_with_base(
        &mut self,
        family: Family,
        kind: &'static str,
        target: &str,
        description: String,
        base: Document,
        mutated: Document,
        intent: Intent,
    ) {
        self.out.push(Mutation {
            id: format!("{kind}:{target}"),
            family,
            kind,
            description,
            base,
            mutated,
            intent,
        });
    }

    fn edit_sketch(
        &self,
        sketch: &str,
        f: impl FnOnce(&mut SketchFeature) -> bool,
    ) -> Option<Document> {
        let mut d = self.model.clone();
        let s = sketch_mut(&mut d, sketch)?;
        f(s).then_some(d)
    }
}

/// `true` if `sketch` of `doc` still assembles into regions (SPEC §3.1).
fn sketch_valid(doc: &Document, sketch: &str) -> bool {
    sketch_ref(doc, sketch).is_some_and(|s| regions(s, &Tolerance::IR_DEFAULT).is_ok())
}

fn sketch_intent(sketch: &str) -> Intent {
    Intent {
        sketch: Some(sketch.to_string()),
        ..Intent::default()
    }
}

/// All candidate mutations for `model` (unvalidated), in a deterministic order.
pub fn mutations(model: &Document) -> Vec<Mutation> {
    let mut b = Builder {
        model,
        out: Vec::new(),
    };
    let sketches = used_sketches(model);
    if let Some(primary) = sketches.first() {
        dimension_sketch_edits(&mut b, primary);
    }
    dimension_feature_edits(&mut b);
    suppress_edits(&mut b);
    if let Some(primary) = sketches.first() {
        topology_sketch_edits(&mut b, primary);
    }
    // Multi-feature models: a topology edit on the last body feature's sketch too, so
    // references to other features are exercised against a changed neighbour.
    if let Some(last) = sketches.last()
        && sketches.len() > 1
    {
        split_line(&mut b, last, true, 0);
        add_hole(&mut b, last);
    }
    topology_feature_edits(&mut b);
    b.out
}

// ---- (a) dimension -----------------------------------------------------------------------

fn dimension_sketch_edits(b: &mut Builder<'_>, sketch: &str) {
    let regs = sketch_regions(b.model, sketch);
    let axis = revolve_axis(b.model, sketch);
    let Some(sk) = sketch_ref(b.model, sketch) else {
        return;
    };
    let diag = sketch_diag(sk);

    // Offset up to two outer-loop lines whose neighbours are lines.
    let mut offsets = 0;
    for r in &regs {
        let lp = &r.outer;
        let m = lp.curves.len();
        if m < 3 {
            continue;
        }
        for k in 0..m {
            if offsets >= 2 {
                break;
            }
            let (kp, kn) = ((k + m - 1) % m, (k + 1) % m);
            let is_line = |i: usize| matches!(lp.curves[i].geom, LoopCurveGeom::Line { .. });
            if !(is_line(kp) && is_line(k) && is_line(kn)) {
                continue;
            }
            let jk = lp.junctions[k].point;
            let jk1 = lp.junctions[kn].point;
            let jp = lp.junctions[kp].point;
            let jn = lp.junctions[(k + 2) % m].point;
            if [jk, jk1].iter().any(|q| on_axis(axis.as_ref(), *q)) {
                continue;
            }
            let d = jk1 - jk;
            let Some(dn) = d.normalize() else { continue };
            let out = Vec2::new(dn.y, -dn.x); // right of a counter-clockwise loop
            let delta = 0.02 * diag;
            let base = jk + out * delta;
            let (Some(a), Some(c)) = (
                intersect(base, d, jp, jk - jp),
                intersect(base, d, jk1, jn - jk1),
            ) else {
                continue;
            };
            let id = lp.curves[k].id.clone();
            if let Some(doc) =
                b.edit_sketch(sketch, |s| move_point(s, jk, a) && move_point(s, jk1, c))
            {
                b.push(
                    Family::Dimension,
                    "offset_line",
                    &id,
                    format!("offset line `{id}` of sketch `{sketch}` outward by {delta:.3} mm"),
                    doc,
                    Intent::identity(),
                );
                offsets += 1;
            }
        }
    }

    // Move one line–line vertex.
    'vertex: for r in &regs {
        let lp = &r.outer;
        let m = lp.curves.len();
        for k in 0..m {
            let kp = (k + m - 1) % m;
            let both_lines = matches!(lp.curves[kp].geom, LoopCurveGeom::Line { .. })
                && matches!(lp.curves[k].geom, LoopCurveGeom::Line { .. });
            let p = lp.junctions.get(k).map(|j| j.point);
            let Some(p) = p else { continue };
            if !both_lines || on_axis(axis.as_ref(), p) {
                continue;
            }
            let (s, c) = math::sin_cos_deg(37.0);
            let q = p + Vec2::new(c, s) * (0.015 * diag);
            let label = lp.junctions[k].key.clone();
            if let Some(doc) = b.edit_sketch(sketch, |s| move_point(s, p, q)) {
                b.push(
                    Family::Dimension,
                    "move_vertex",
                    &label,
                    format!(
                        "move the vertex {label} of sketch `{sketch}` by {:.3} mm",
                        0.015 * diag
                    ),
                    doc,
                    Intent::identity(),
                );
                break 'vertex;
            }
        }
    }

    // Resize the first circle.
    if let Some(id) = sk.curves.iter().find_map(|c| match c {
        SketchCurve::Circle { id, .. } => Some(id.clone()),
        _ => None,
    }) && let Some(doc) = b.edit_sketch(sketch, |s| {
        for c in &mut s.curves {
            if let SketchCurve::Circle {
                id: cid, radius, ..
            } = c
                && *cid == id
            {
                *radius *= 0.85;
                return true;
            }
        }
        false
    }) {
        b.push(
            Family::Dimension,
            "resize_circle",
            &id,
            format!("shrink circle `{id}` of sketch `{sketch}` to 85 % radius"),
            doc,
            Intent::identity(),
        );
    }

    // Translate the first hole loop.
    if let Some(hole) = regs.iter().flat_map(|r| r.holes.iter()).next() {
        let ids: BTreeSet<String> = hole.curves.iter().map(|c| c.id.clone()).collect();
        let v = Vec2::new(0.013 * diag, 0.009 * diag);
        let first = hole.curves[0].id.clone();
        if let Some(doc) = b.edit_sketch(sketch, |s| {
            translate_curves(s, &ids, v);
            true
        }) {
            b.push(
                Family::Dimension,
                "move_hole",
                &first,
                format!(
                    "move the hole loop {ids:?} of sketch `{sketch}` by ({:.3}, {:.3}) mm",
                    v.x, v.y
                ),
                doc,
                Intent::identity(),
            );
        }
    }

    // Adversarial move: translate a two-curve loop ("D") by the vector between its two
    // junctions, so one junction lands exactly where the other was.
    if let Some(lp) = regs
        .iter()
        .flat_map(|r| std::iter::once(&r.outer).chain(r.holes.iter()))
        .find(|l| l.curves.len() == 2)
    {
        let v = lp.junctions[0].point - lp.junctions[1].point;
        let ids: BTreeSet<String> = lp.curves.iter().map(|c| c.id.clone()).collect();
        if let Some(doc) = b.edit_sketch(sketch, |s| {
            translate_curves(s, &ids, v);
            true
        }) {
            b.push(
                Family::Dimension,
                "move_loop_by_junction_gap",
                &ids.iter().cloned().collect::<Vec<_>>().join("+"),
                format!(
                    "move the two-curve loop {ids:?} of sketch `{sketch}` by ({:.3}, {:.3}) mm: one of its junctions lands where the other was",
                    v.x, v.y
                ),
                doc,
                Intent::identity(),
            );
        }
    }

    // Scale the whole sketch about its origin (revolve: about the axis origin).
    let pivot = axis.as_ref().map_or(Point2::zero(), |a| p2(a.origin));
    if let Some(doc) = b.edit_sketch(sketch, |s| {
        let f = 1.15;
        let sc = |q: [f64; 2]| a2(pivot + (p2(q) - pivot) * f);
        for c in &mut s.curves {
            match c {
                SketchCurve::Line { start, end, .. } => {
                    *start = sc(*start);
                    *end = sc(*end);
                }
                SketchCurve::Arc {
                    start, end, center, ..
                } => {
                    *start = sc(*start);
                    *end = sc(*end);
                    *center = sc(*center);
                }
                SketchCurve::Circle { center, radius, .. } => {
                    *center = sc(*center);
                    *radius *= f;
                }
            }
        }
        true
    }) {
        b.push(
            Family::Dimension,
            "scale_sketch",
            sketch,
            format!(
                "scale sketch `{sketch}` by 1.15 about ({}, {})",
                pivot.x, pivot.y
            ),
            doc,
            Intent::identity(),
        );
    }

    // Move the sketch plane 2.5 mm along its normal.
    if let Some(doc) = b.edit_sketch(sketch, |s| {
        let (o, x, _, n) = s.plane.resolve();
        s.plane = PlaneSpec::Frame(Frame {
            origin: [o[0] + 2.5 * n[0], o[1] + 2.5 * n[1], o[2] + 2.5 * n[2]],
            normal: n,
            x_dir: x,
        });
        true
    }) {
        b.push(
            Family::Dimension,
            "move_plane",
            sketch,
            format!("move the plane of sketch `{sketch}` 2.5 mm along its normal"),
            doc,
            Intent::identity(),
        );
    }

    // Reverse one curve's direction (no geometric change): prefer an arc of a two-curve
    // loop (its junction edges form an #index family), else the first arc, else the
    // first line.
    let two_curve = regs
        .iter()
        .flat_map(|r| std::iter::once(&r.outer).chain(r.holes.iter()))
        .find(|l| l.curves.len() == 2)
        .map(|l| {
            l.curves
                .iter()
                .find(|c| matches!(c.geom, LoopCurveGeom::Arc { .. }))
                .unwrap_or(&l.curves[1])
                .id
                .clone()
        });
    let target = two_curve
        .or_else(|| {
            sk.curves.iter().find_map(|c| match c {
                SketchCurve::Arc { id, .. } => Some(id.clone()),
                _ => None,
            })
        })
        .or_else(|| {
            sk.curves.iter().find_map(|c| match c {
                SketchCurve::Line { id, .. } => Some(id.clone()),
                _ => None,
            })
        });
    if let Some(id) = target
        && let Some(doc) = b.edit_sketch(sketch, |s| {
            for c in &mut s.curves {
                match c {
                    SketchCurve::Line {
                        id: cid,
                        start,
                        end,
                    } if *cid == id => {
                        std::mem::swap(start, end);
                        return true;
                    }
                    SketchCurve::Arc {
                        id: cid,
                        start,
                        end,
                        ccw,
                        ..
                    } if *cid == id => {
                        std::mem::swap(start, end);
                        *ccw = !*ccw;
                        return true;
                    }
                    _ => {}
                }
            }
            false
        })
    {
        let mut intent = sketch_intent(sketch);
        intent.end_map = flipped_ends(&id);
        b.push(
            Family::Dimension,
            "reverse_curve",
            &id,
            format!("reverse the direction of curve `{id}` of sketch `{sketch}` (same geometry)"),
            doc,
            intent,
        );
    }

    // Reorder the curve list (no geometric change).
    if let Some(doc) = b.edit_sketch(sketch, |s| {
        s.curves.reverse();
        s.curves.len() > 1
    }) {
        b.push(
            Family::Dimension,
            "reorder_curves",
            sketch,
            format!("reverse the order of the curve list of sketch `{sketch}`"),
            doc,
            Intent::identity(),
        );
    }
}

fn dimension_feature_edits(b: &mut Builder<'_>) {
    let feats = body_features(b.model);
    let extrudes: Vec<(usize, usize)> = feats
        .iter()
        .copied()
        .filter(|&(p, f)| matches!(b.model.parts[p].features[f], Feature::Extrude(_)))
        .collect();
    let revolves: Vec<(usize, usize)> = feats
        .iter()
        .copied()
        .filter(|&(p, f)| matches!(b.model.parts[p].features[f], Feature::Revolve(_)))
        .collect();

    let mut picks = vec![extrudes.first().copied()];
    if extrudes.len() > 1 {
        picks.push(extrudes.last().copied());
    }
    for (k, (p, f)) in picks.into_iter().flatten().enumerate() {
        let factor = if k == 0 { 1.4 } else { 0.7 };
        let mut d = b.model.clone();
        let name = d.parts[p].features[f].name().to_string();
        if let Feature::Extrude(e) = &mut d.parts[p].features[f] {
            e.distance *= factor;
        }
        b.push(
            Family::Dimension,
            "extrude_distance",
            &name,
            format!("extrude `{name}` distance × {factor}"),
            d,
            Intent::identity(),
        );
    }
    if let Some(&(p, f)) = extrudes.first() {
        for (k, next) in [
            |d: SweepDirection| match d {
                SweepDirection::Normal => SweepDirection::Symmetric,
                SweepDirection::Symmetric => SweepDirection::Reverse,
                SweepDirection::Reverse => SweepDirection::Normal,
            },
            |d: SweepDirection| match d {
                SweepDirection::Normal => SweepDirection::Reverse,
                SweepDirection::Reverse => SweepDirection::Symmetric,
                SweepDirection::Symmetric => SweepDirection::Normal,
            },
        ]
        .into_iter()
        .enumerate()
        {
            let mut d = b.model.clone();
            let name = d.parts[p].features[f].name().to_string();
            let mut desc = String::new();
            if let Feature::Extrude(e) = &mut d.parts[p].features[f] {
                let to = next(e.direction);
                desc = format!("extrude `{name}` direction {:?} → {to:?}", e.direction);
                e.direction = to;
            }
            b.push(
                Family::Dimension,
                "extrude_direction",
                &format!("{name}#{k}"),
                desc,
                d,
                Intent::identity(),
            );
        }
    }
    for &(p, f) in revolves.iter().take(1) {
        let Feature::Revolve(r) = &b.model.parts[p].features[f] else {
            continue;
        };
        let name = r.name.clone();
        if r.angle < 360.0 {
            for (k, to) in [r.angle * 0.75, (r.angle + 60.0).min(350.0)]
                .into_iter()
                .enumerate()
            {
                let mut d = b.model.clone();
                if let Feature::Revolve(rr) = &mut d.parts[p].features[f] {
                    rr.angle = to;
                }
                b.push(
                    Family::Dimension,
                    "revolve_angle",
                    &format!("{name}#{k}"),
                    format!("revolve `{name}` angle {}° → {to}°", r.angle),
                    d,
                    Intent::identity(),
                );
            }
        }
        for (k, to) in [SweepDirection::Reverse, SweepDirection::Symmetric]
            .into_iter()
            .filter(|t| *t != r.direction)
            .enumerate()
        {
            let mut d = b.model.clone();
            if let Feature::Revolve(rr) = &mut d.parts[p].features[f] {
                rr.direction = to;
            }
            b.push(
                Family::Dimension,
                "revolve_direction",
                &format!("{name}#{k}"),
                format!(
                    "revolve `{name}` ({}°) direction {:?} → {to:?}",
                    r.angle, r.direction
                ),
                d,
                Intent::identity(),
            );
        }
    }
}

// ---- (b) suppress -------------------------------------------------------------------------

fn suppress_edits(b: &mut Builder<'_>) {
    let feats = body_features(b.model);
    let set_suppressed =
        |doc: &mut Document, p: usize, f: usize, v: bool| match &mut doc.parts[p].features[f] {
            Feature::Extrude(e) => e.suppressed = v,
            Feature::Revolve(r) => r.suppressed = v,
            Feature::Sketch(s) => s.suppressed = v,
        };
    let mut targets = Vec::new();
    if let Some(&last) = feats.last() {
        targets.push(last);
    }
    if let Some(&first) = feats.first()
        && feats.len() > 1
    {
        targets.push(first);
    }
    for (p, f) in targets {
        let name = b.model.parts[p].features[f].name().to_string();
        let mut d = b.model.clone();
        set_suppressed(&mut d, p, f, true);
        b.push(
            Family::Suppress,
            "suppress_feature",
            &name,
            format!("suppress feature `{name}`"),
            d,
            Intent::identity(),
        );
    }
    if let Some(&(p, f)) = feats.last() {
        let name = b.model.parts[p].features[f].name().to_string();
        let mut base = b.model.clone();
        set_suppressed(&mut base, p, f, true);
        b.push_with_base(
            Family::Suppress,
            "unsuppress_feature",
            &name,
            format!("unsuppress feature `{name}` (references captured while it was suppressed)"),
            base,
            b.model.clone(),
            Intent::identity(),
        );
    }
    if let Some(&(p, f)) = feats.first()
        && let Some(sk) = feature_sketch(&b.model.parts[p].features[f])
    {
        let sk = sk.to_string();
        let mut d = b.model.clone();
        if let Some(s) = sketch_mut(&mut d, &sk) {
            s.suppressed = true;
        }
        b.push(
            Family::Suppress,
            "suppress_sketch",
            &sk,
            format!("suppress sketch `{sk}` (its features fail with SKETCH_SUPPRESSED)"),
            d,
            Intent::identity(),
        );
    }
}

// ---- (c) topology -------------------------------------------------------------------------

/// Outer-loop lines of `sketch` (not lying on a revolve axis), longest first.
fn outer_lines(b: &Builder<'_>, sketch: &str) -> Vec<(String, f64)> {
    let regs = sketch_regions(b.model, sketch);
    let axis = revolve_axis(b.model, sketch);
    let Some(sk) = sketch_ref(b.model, sketch) else {
        return Vec::new();
    };
    let outer: BTreeSet<&str> = regs
        .iter()
        .flat_map(|r| r.outer.curves.iter().map(|c| c.id.as_str()))
        .collect();
    let mut v: Vec<(String, f64)> = sk
        .curves
        .iter()
        .filter(|c| outer.contains(c.id()))
        .filter_map(|c| match c {
            SketchCurve::Line { id, start, end } => {
                let on = on_axis(axis.as_ref(), p2(*start)) && on_axis(axis.as_ref(), p2(*end));
                (!on).then(|| (id.clone(), line_len(c)))
            }
            _ => None,
        })
        .collect();
    v.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    v
}

/// Split the `rank`-th longest outer line at 40 %; `keep` keeps the id on the first
/// piece, otherwise both pieces get new ids.
fn split_line(b: &mut Builder<'_>, sketch: &str, keep: bool, rank: usize) {
    let lines = outer_lines(b, sketch);
    let Some((id, _)) = lines.get(rank).cloned() else {
        return;
    };
    let mut intent = sketch_intent(sketch);
    let Some(sk) = sketch_ref(b.model, sketch) else {
        return;
    };
    let (ida, idb) = if keep {
        (id.clone(), fresh_id(sk, &format!("{id}_s")))
    } else {
        (
            fresh_id(sk, &format!("{id}_a")),
            fresh_id(sk, &format!("{id}_b")),
        )
    };
    let doc = b.edit_sketch(sketch, |s| {
        let Some(i) = s.curves.iter().position(|c| c.id() == id) else {
            return false;
        };
        let SketchCurve::Line { start, end, .. } = s.curves[i].clone() else {
            return false;
        };
        let m = a2(p2(start).lerp(p2(end), 0.4));
        s.curves[i] = SketchCurve::Line {
            id: ida.clone(),
            start,
            end: m,
        };
        s.curves.insert(
            i + 1,
            SketchCurve::Line {
                id: idb.clone(),
                start: m,
                end,
            },
        );
        true
    });
    let Some(doc) = doc else { return };
    intent
        .curve_map
        .insert(id.clone(), vec![ida.clone(), idb.clone()]);
    intent.end_map.insert(
        (id.clone(), CurveEnd::Start),
        (ida.clone(), CurveEnd::Start),
    );
    intent
        .end_map
        .insert((id.clone(), CurveEnd::End), (idb.clone(), CurveEnd::End));
    let (kind, how) = if keep {
        (
            "split_line_keep_id",
            format!("`{ida}` keeps the id, `{idb}` is new"),
        )
    } else {
        ("split_line_new_ids", format!("pieces `{ida}` and `{idb}`"))
    };
    b.push(
        Family::Topology,
        kind,
        &format!("{sketch}.{id}"),
        format!("split line `{id}` of sketch `{sketch}` at 40 % ({how})"),
        doc,
        intent,
    );
}

fn topology_sketch_edits(b: &mut Builder<'_>, sketch: &str) {
    split_line(b, sketch, true, 0);
    split_line(b, sketch, false, 1);
    split_arc(b, sketch);
    add_hole(b, sketch);
    remove_hole(b, sketch);
    fillet_corner(b, sketch);
    unfillet_corner(b, sketch);
    bulge_line(b, sketch);
    flatten_arc(b, sketch);
    add_region(b, sketch);
    rename_curves(b, sketch);
    rename_and_move_circle(b, sketch);
}

fn split_arc(b: &mut Builder<'_>, sketch: &str) {
    let Some(sk) = sketch_ref(b.model, sketch) else {
        return;
    };
    let Some(id) = sk.curves.iter().find_map(|c| match c {
        SketchCurve::Arc { id, .. } => Some(id.clone()),
        _ => None,
    }) else {
        return;
    };
    let idb = fresh_id(sk, &format!("{id}_s"));
    let Some(doc) = b.edit_sketch(sketch, |s| {
        let Some(i) = s.curves.iter().position(|c| c.id() == id) else {
            return false;
        };
        let SketchCurve::Arc {
            start,
            end,
            center,
            ccw,
            ..
        } = s.curves[i].clone()
        else {
            return false;
        };
        let g = CurveG::from_ir(&s.curves[i]);
        let m = a2(g.point_at(0.5));
        s.curves[i] = SketchCurve::Arc {
            id: id.clone(),
            start,
            end: m,
            center,
            ccw,
        };
        s.curves.insert(
            i + 1,
            SketchCurve::Arc {
                id: idb.clone(),
                start: m,
                end,
                center,
                ccw,
            },
        );
        true
    }) else {
        return;
    };
    let mut intent = sketch_intent(sketch);
    intent
        .curve_map
        .insert(id.clone(), vec![id.clone(), idb.clone()]);
    intent
        .end_map
        .insert((id.clone(), CurveEnd::End), (idb.clone(), CurveEnd::End));
    b.push(
        Family::Topology,
        "split_arc_keep_id",
        &format!("{sketch}.{id}"),
        format!("split arc `{id}` of sketch `{sketch}` at its middle (`{idb}` is new)"),
        doc,
        intent,
    );
}

/// Add a circular hole at the point of the first region farthest from every curve.
fn add_hole(b: &mut Builder<'_>, sketch: &str) {
    let regs = sketch_regions(b.model, sketch);
    let axis = revolve_axis(b.model, sketch);
    let Some(sk) = sketch_ref(b.model, sketch) else {
        return;
    };
    let Some(r) = regs.first() else { return };
    let geoms: Vec<CurveG> = sk.curves.iter().map(CurveG::from_ir).collect();
    let (lo, hi) = sketch_bbox(sk);
    let n = 48;
    let mut best: Option<(f64, Point2)> = None;
    for i in 1..n {
        for j in 1..n {
            let p = Point2::new(
                lo.x + (hi.x - lo.x) * i as f64 / n as f64,
                lo.y + (hi.y - lo.y) * j as f64 / n as f64,
            );
            let inside =
                r.outer.winding_number(p) != 0 && r.holes.iter().all(|h| h.winding_number(p) == 0);
            if !inside {
                continue;
            }
            let mut clear = geoms
                .iter()
                .map(|g| g.distance(p))
                .fold(f64::INFINITY, f64::min);
            if let Some(a) = &axis {
                clear = clear.min(axis_side(a, p).abs());
            }
            if best.is_none_or(|(c, _)| clear > c) {
                best = Some((clear, p));
            }
        }
    }
    let Some((clear, p)) = best else { return };
    let radius = 0.4 * clear;
    if radius <= 1e-3 {
        return;
    }
    let id = fresh_id(sk, "added_hole");
    let Some(doc) = b.edit_sketch(sketch, |s| {
        s.curves.push(SketchCurve::Circle {
            id: id.clone(),
            center: a2(p),
            radius,
        });
        true
    }) else {
        return;
    };
    b.push(
        Family::Topology,
        "add_hole",
        sketch,
        format!(
            "add hole `{id}` (r = {radius:.3} at ({:.3}, {:.3})) to sketch `{sketch}`",
            p.x, p.y
        ),
        doc,
        Intent::identity(),
    );
}

fn remove_hole(b: &mut Builder<'_>, sketch: &str) {
    let regs = sketch_regions(b.model, sketch);
    let Some(hole) = regs.iter().flat_map(|r| r.holes.iter()).next() else {
        return;
    };
    let ids: Vec<String> = hole.curves.iter().map(|c| c.id.clone()).collect();
    let Some(doc) = b.edit_sketch(sketch, |s| {
        s.curves.retain(|c| !ids.iter().any(|i| i == c.id()));
        true
    }) else {
        return;
    };
    let mut intent = sketch_intent(sketch);
    for i in &ids {
        intent.curve_map.insert(i.clone(), Vec::new());
    }
    b.push(
        Family::Topology,
        "remove_hole",
        &ids.join("+"),
        format!("remove the hole loop {ids:?} from sketch `{sketch}`"),
        doc,
        intent,
    );
}

/// Replace the first line–line corner of the first region's outer loop by a tangent arc.
fn fillet_corner(b: &mut Builder<'_>, sketch: &str) {
    let regs = sketch_regions(b.model, sketch);
    let axis = revolve_axis(b.model, sketch);
    let Some(sk) = sketch_ref(b.model, sketch) else {
        return;
    };
    for r in &regs {
        let lp = &r.outer;
        let m = lp.curves.len();
        for k in 0..m {
            let kp = (k + m - 1) % m;
            let (LoopCurveGeom::Line { start: ps, .. }, LoopCurveGeom::Line { end: ne, .. }) =
                (&lp.curves[kp].geom, &lp.curves[k].geom)
            else {
                continue;
            };
            let p = lp.junctions[k].point;
            if on_axis(axis.as_ref(), p) {
                continue;
            }
            let (l1, l2) = (ps.distance(p), ne.distance(p));
            let (Some(u1), Some(u2)) = ((*ps - p).normalize(), (*ne - p).normalize()) else {
                continue;
            };
            let cos_a = u1.dot(u2).clamp(-1.0, 1.0);
            let alpha = math::acos(cos_a);
            if !(0.2..=math::PI - 0.2).contains(&alpha) {
                continue;
            }
            let Some(bis) = (u1 + u2).normalize() else {
                continue;
            };
            let (idp, idn) = (lp.curves[kp].id.clone(), lp.curves[k].id.clone());
            let fid = fresh_id(sk, "fillet_1");
            // The largest of a few sizes that keeps the sketch valid.
            let found = [0.3, 0.1, 0.03].into_iter().find_map(|frac| {
                let t = frac * l1.min(l2);
                let rad = t * math::tan(0.5 * alpha);
                let c = p + bis * (rad / math::sin(0.5 * alpha));
                let (t1, t2) = (p + u1 * t, p + u2 * t);
                let ccw = (t1 - c).perp_dot(t2 - c) > 0.0;
                let doc = b.edit_sketch(sketch, |s| {
                    if !(set_line_end_at(s, &idp, p, t1) && set_line_end_at(s, &idn, p, t2)) {
                        return false;
                    }
                    s.curves.push(SketchCurve::Arc {
                        id: fid.clone(),
                        start: a2(t1),
                        end: a2(t2),
                        center: a2(c),
                        ccw,
                    });
                    true
                })?;
                sketch_valid(&doc, sketch).then_some((doc, rad))
            });
            let Some((doc, rad)) = found else {
                continue;
            };
            b.push(
                Family::Topology,
                "fillet_corner",
                &format!("{idp}|{idn}"),
                format!("replace the corner between `{idp}` and `{idn}` of sketch `{sketch}` by arc `{fid}` (r = {rad:.3})"),
                doc,
                Intent::identity(),
            );
            return;
        }
    }
}

/// Remove an arc between two non-parallel lines and extend the lines to their
/// intersection (the inverse of a fillet).
fn unfillet_corner(b: &mut Builder<'_>, sketch: &str) {
    let regs = sketch_regions(b.model, sketch);
    let axis = revolve_axis(b.model, sketch);
    for lp in regs
        .iter()
        .flat_map(|r| std::iter::once(&r.outer).chain(r.holes.iter()))
    {
        let m = lp.curves.len();
        if m < 3 {
            continue;
        }
        for k in 0..m {
            let (kp, kn) = ((k + m - 1) % m, (k + 1) % m);
            let (
                LoopCurveGeom::Line { start: ps, end: pe },
                LoopCurveGeom::Arc { .. },
                LoopCurveGeom::Line { start: ns, end: ne },
            ) = (&lp.curves[kp].geom, &lp.curves[k].geom, &lp.curves[kn].geom)
            else {
                continue;
            };
            let Some(p) = intersect(*pe, *pe - *ps, *ns, *ne - *ns) else {
                continue;
            };
            if on_axis(axis.as_ref(), p) {
                continue;
            }
            let (idp, arc, idn) = (
                lp.curves[kp].id.clone(),
                lp.curves[k].id.clone(),
                lp.curves[kn].id.clone(),
            );
            let (ja, jb) = (lp.junctions[k].point, lp.junctions[kn].point);
            let Some(doc) = b.edit_sketch(sketch, |s| {
                if !(set_line_end_at(s, &idp, ja, p) && set_line_end_at(s, &idn, jb, p)) {
                    return false;
                }
                s.curves.retain(|c| c.id() != arc);
                true
            }) else {
                continue;
            };
            if !sketch_valid(&doc, sketch) {
                continue;
            }
            let mut intent = sketch_intent(sketch);
            intent.curve_map.insert(arc.clone(), Vec::new());
            b.push(
                Family::Topology,
                "unfillet_corner",
                &arc,
                format!("remove arc `{arc}` of sketch `{sketch}` and extend `{idp}` and `{idn}` to a sharp corner"),
                doc,
                intent,
            );
            return;
        }
    }
}

/// Replace an arc (sweep < 180°) by the line through its endpoints (same id).
fn flatten_arc(b: &mut Builder<'_>, sketch: &str) {
    let Some(sk) = sketch_ref(b.model, sketch) else {
        return;
    };
    for c in &sk.curves {
        let SketchCurve::Arc { id, start, end, .. } = c else {
            continue;
        };
        let CurveG::Arc { sweep, .. } = CurveG::from_ir(c) else {
            continue;
        };
        if sweep.abs() >= math::PI - 1e-6 {
            continue;
        }
        let (id, start, end) = (id.clone(), *start, *end);
        let Some(doc) = b.edit_sketch(sketch, |s| {
            let Some(i) = s.curves.iter().position(|x| x.id() == id) else {
                return false;
            };
            s.curves[i] = SketchCurve::Line {
                id: id.clone(),
                start,
                end,
            };
            true
        }) else {
            continue;
        };
        if !sketch_valid(&doc, sketch) {
            continue;
        }
        b.push(
            Family::Topology,
            "flatten_arc",
            &format!("{sketch}.{id}"),
            format!("replace arc `{id}` of sketch `{sketch}` by its chord, same id"),
            doc,
            Intent::identity(),
        );
        return;
    }
}

/// Replace a line by an arc through the same endpoints (same id; plane → cylinder).
fn bulge_line(b: &mut Builder<'_>, sketch: &str) {
    let lines = outer_lines(b, sketch);
    let Some((id, len)) = lines.last().cloned() else {
        return;
    };
    let regs = sketch_regions(b.model, sketch);
    // Traversal direction of the line in its (counter-clockwise) outer loop.
    let Some((ta, tb)) = regs.iter().find_map(|r| {
        r.outer
            .curves
            .iter()
            .find(|c| c.id == id)
            .and_then(|c| match c.geom {
                LoopCurveGeom::Line { start, end } => Some((start, end)),
                _ => None,
            })
    }) else {
        return;
    };
    let Some(d) = (tb - ta).normalize() else {
        return;
    };
    let out = Vec2::new(d.y, -d.x);
    let sag = 0.08 * len;
    let rad = (0.25 * len * len + sag * sag) / (2.0 * sag);
    let mid = ta.lerp(tb, 0.5);
    let c = mid - out * (rad - sag);
    let apex = mid + out * sag;
    let Some(doc) = b.edit_sketch(sketch, |s| {
        let Some(i) = s.curves.iter().position(|x| x.id() == id) else {
            return false;
        };
        let SketchCurve::Line { start, end, .. } = s.curves[i].clone() else {
            return false;
        };
        let ccw = (p2(start) - c).perp_dot(apex - c) > 0.0;
        s.curves[i] = SketchCurve::Arc {
            id: id.clone(),
            start,
            end,
            center: a2(c),
            ccw,
        };
        true
    }) else {
        return;
    };
    b.push(
        Family::Topology,
        "bulge_line",
        &format!("{sketch}.{id}"),
        format!(
            "replace line `{id}` of sketch `{sketch}` by an outward arc (sagitta {sag:.3}), same id"
        ),
        doc,
        Intent::identity(),
    );
}

/// Add a disjoint square region beyond the sketch (a new body of the same feature).
fn add_region(b: &mut Builder<'_>, sketch: &str) {
    let axis = revolve_axis(b.model, sketch);
    let Some(sk) = sketch_ref(b.model, sketch) else {
        return;
    };
    let diag = sketch_diag(sk);
    let side = 0.15 * diag;
    let gap = 0.1 * diag;
    // Placement direction `u` (away from the axis for revolves) and along-direction `v`.
    let (origin, u, v) = match &axis {
        Some(a) => {
            let dh = Vec2::from(a.direction)
                .normalize()
                .unwrap_or(Vec2::unit_y());
            let sigma = {
                let g = sk.curves.first().map(CurveG::from_ir);
                let s = g.map_or(1.0, |g| axis_side(a, g.point_at(0.5)));
                if s < 0.0 { -1.0 } else { 1.0 }
            };
            (p2(a.origin), dh.perp() * sigma, dh)
        }
        None => (Point2::zero(), Vec2::unit_x(), Vec2::unit_y()),
    };
    let geoms: Vec<CurveG> = sk.curves.iter().map(CurveG::from_ir).collect();
    let (mut umax, mut vmin) = (f64::NEG_INFINITY, f64::INFINITY);
    for g in &geoms {
        for i in 0..=32 {
            let q = g.point_at(i as f64 / 32.0) - origin;
            umax = umax.max(q.dot(u));
            vmin = vmin.min(q.dot(v));
        }
    }
    let at = |a: f64, c: f64| origin + u * a + v * c;
    let (u0, u1, v0, v1) = (umax + gap, umax + gap + side, vmin, vmin + side);
    let corners = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
    let names = ["added_r_a", "added_r_b", "added_r_c", "added_r_d"];
    let Some(doc) = b.edit_sketch(sketch, |s| {
        let ids: Vec<String> = names.iter().map(|n| fresh_id(s, n)).collect();
        for k in 0..4 {
            s.curves.push(SketchCurve::Line {
                id: ids[k].clone(),
                start: a2(corners[k]),
                end: a2(corners[(k + 1) % 4]),
            });
        }
        true
    }) else {
        return;
    };
    b.push(
        Family::Topology,
        "add_region",
        sketch,
        format!("add a disjoint square region (side {side:.3}) to sketch `{sketch}`: a new body of the same feature"),
        doc,
        Intent::identity(),
    );
}

fn rename_curves(b: &mut Builder<'_>, sketch: &str) {
    let Some(sk) = sketch_ref(b.model, sketch) else {
        return;
    };
    let mut targets: Vec<String> = Vec::new();
    if let Some((id, _)) = outer_lines(b, sketch).first() {
        targets.push(id.clone());
    }
    if let Some(id) = sk.curves.iter().find_map(|c| match c {
        SketchCurve::Arc { id, .. } | SketchCurve::Circle { id, .. } => Some(id.clone()),
        SketchCurve::Line { .. } => None,
    }) {
        targets.push(id);
    }
    for id in targets {
        let new = fresh_id(sk, &format!("{id}_r"));
        let Some(doc) = b.edit_sketch(sketch, |s| {
            for c in &mut s.curves {
                match c {
                    SketchCurve::Line { id: cid, .. }
                    | SketchCurve::Arc { id: cid, .. }
                    | SketchCurve::Circle { id: cid, .. }
                        if *cid == id =>
                    {
                        *cid = new.clone();
                        return true;
                    }
                    _ => {}
                }
            }
            false
        }) else {
            continue;
        };
        let mut intent = sketch_intent(sketch);
        intent.curve_map.insert(id.clone(), vec![new.clone()]);
        intent.renamed.insert(id.clone());
        b.push(
            Family::Topology,
            "rename_curve",
            &format!("{sketch}.{id}"),
            format!("rename curve `{id}` of sketch `{sketch}` to `{new}`"),
            doc,
            intent,
        );
    }
}

/// Rename the first circle *and* move it slightly (a combined edit: the name is gone
/// and the geometry is no longer identical, so only an approximate match remains).
fn rename_and_move_circle(b: &mut Builder<'_>, sketch: &str) {
    let Some(sk) = sketch_ref(b.model, sketch) else {
        return;
    };
    let Some(id) = sk.curves.iter().find_map(|c| match c {
        SketchCurve::Circle { id, .. } => Some(id.clone()),
        _ => None,
    }) else {
        return;
    };
    let diag = sketch_diag(sk);
    let v = Vec2::new(0.01 * diag, 0.005 * diag);
    let new = fresh_id(sk, &format!("{id}_m"));
    let Some(doc) = b.edit_sketch(sketch, |s| {
        for c in &mut s.curves {
            if let SketchCurve::Circle {
                id: cid, center, ..
            } = c
                && *cid == id
            {
                *cid = new.clone();
                *center = a2(p2(*center) + v);
                return true;
            }
        }
        false
    }) else {
        return;
    };
    if !sketch_valid(&doc, sketch) {
        return;
    }
    let mut intent = sketch_intent(sketch);
    intent.curve_map.insert(id.clone(), vec![new.clone()]);
    intent.renamed.insert(id.clone());
    b.push(
        Family::Topology,
        "rename_and_move_circle",
        &format!("{sketch}.{id}"),
        format!(
            "rename circle `{id}` of sketch `{sketch}` to `{new}` and move it by ({:.3}, {:.3}) mm",
            v.x, v.y
        ),
        doc,
        intent,
    );
}

fn topology_feature_edits(b: &mut Builder<'_>) {
    // Revolve 360° → partial, partial → 360°.
    for (p, f) in body_features(b.model).into_iter().take(4) {
        let Feature::Revolve(r) = &b.model.parts[p].features[f] else {
            continue;
        };
        let name = r.name.clone();
        let (kind, to) = if r.angle >= 360.0 {
            ("revolve_partial", 270.0)
        } else {
            ("revolve_full", 360.0)
        };
        let from = r.angle;
        let mut d = b.model.clone();
        if let Feature::Revolve(rr) = &mut d.parts[p].features[f] {
            rr.angle = to;
        }
        b.push(
            Family::Topology,
            kind,
            &name,
            format!("revolve `{name}` angle {from}° → {to}°"),
            d,
            Intent::identity(),
        );
        break;
    }

    // Reorder: move the last independent (sketch, body feature) pair of a part to the
    // front of that part; swap the first two parts.
    for (pi, part) in b.model.parts.iter().enumerate() {
        let bodies: Vec<usize> = part
            .features
            .iter()
            .enumerate()
            .filter(|(_, f)| matches!(f, Feature::Extrude(_) | Feature::Revolve(_)))
            .map(|(i, _)| i)
            .collect();
        if bodies.len() < 2 {
            continue;
        }
        let last = *bodies.last().expect("non-empty");
        let Some(sk) = feature_sketch(&part.features[last]) else {
            continue;
        };
        let users = part
            .features
            .iter()
            .filter(|f| feature_sketch(f) == Some(sk))
            .count();
        let Some(si) = part.features.iter().position(|f| f.name() == sk) else {
            continue;
        };
        if users != 1 || si > last {
            continue;
        }
        let mut d = b.model.clone();
        let feats = &mut d.parts[pi].features;
        let fe = feats.remove(last);
        let s = feats.remove(si);
        feats.insert(0, fe);
        feats.insert(0, s);
        let name = part.features[last].name().to_string();
        b.push(
            Family::Topology,
            "reorder_features",
            &name,
            format!(
                "move sketch `{sk}` and feature `{name}` to the front of part `{}`",
                part.name
            ),
            d,
            Intent::identity(),
        );
        break;
    }
    if b.model.parts.len() > 1 {
        let mut d = b.model.clone();
        d.parts.swap(0, 1);
        b.push(
            Family::Topology,
            "reorder_parts",
            "0-1",
            "swap the order of the first two parts".to_string(),
            d,
            Intent::identity(),
        );
    }
}
