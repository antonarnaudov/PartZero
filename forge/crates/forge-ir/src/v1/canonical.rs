//! Canonical form (SPEC-v1 §0.4 [D-3]) for the defaults serde cannot omit by itself.
//!
//! Context-free defaults (`v: 1`, `suppressed: false`, `r: 0`, …) are omitted by
//! `skip_serializing_if`. This pass handles the context-dependent ones: a Ref's `card` equal to
//! its field's default cardinality (§5.5), and `thread: false` (the same as no thread).
//! Rewriting expression text to its canonical form (§2.4) is W1's printer; this pass never
//! touches expression strings.

use super::features::*;
use super::planes::*;
use super::refs::*;
use super::{Document, Feature};

/// Normalise a document in place so that [`super::to_json`] is canonical.
pub fn canonicalize(doc: &mut Document) {
    for part in &mut doc.parts {
        for f in &mut part.features {
            feature(f);
        }
    }
}

fn card(r: &mut Ref, default: Cardinality) {
    if r.card == Some(default) {
        r.card = None;
    }
    query(&mut r.q);
}

fn plane(p: &mut PlaneRef) {
    if let PlaneRef::Face(f) = p {
        card(&mut f.face, Cardinality::ONE);
    }
}

fn axis_object(o: &mut AxisObject) {
    match o {
        AxisObject::Edge(e) => card(&mut e.edge, Cardinality::ONE),
        AxisObject::Cylinder(c) => card(&mut c.cylinder, Cardinality::ONE),
        AxisObject::Datum(_) | AxisObject::Line(_) => {}
    }
}

fn axis(a: &mut AxisRef) {
    if let AxisRef::Object(o) = a {
        axis_object(o);
    }
}

fn dir(d: &mut Dir) {
    if let Dir::Axis(o) = d {
        axis_object(o);
    }
}

fn point(p: &mut PointRef) {
    if let PointRef::Vertex(v) = p {
        card(&mut v.vertex, Cardinality::ONE);
    }
}

fn targets(t: &mut Option<Targets>) {
    if let Some(Targets::Ref(r)) = t {
        card(r, Cardinality::SOME);
    }
}

fn query(q: &mut Query) {
    match q {
        Query::Between { a, b } | Query::Minus { a, b } => {
            query(a);
            query(b);
        }
        Query::Faces { of }
        | Query::Edges { of }
        | Query::Vertices { of }
        | Query::Owner { of }
        | Query::Largest { of }
        | Query::Smallest { of } => query(of),
        Query::Union { of } | Query::Intersect { of } => of.iter_mut().for_each(query),
        Query::Filter { of, pred } => {
            query(of);
            if let Predicate::Normal(d) | Predicate::Parallel(d) | Predicate::Perpendicular(d) =
                pred
            {
                dir(d);
            }
        }
        Query::Extreme { of, dir: d, .. } => {
            query(of);
            dir(d);
        }
        _ => {}
    }
}

fn feature(f: &mut Feature) {
    match f {
        Feature::Sketch(s) => plane(&mut s.plane),
        Feature::Extrude(e) => {
            if let Some(ExtrudeExtent::UpTo(p)) = &mut e.extent {
                plane(p);
            }
            targets(&mut e.targets);
        }
        Feature::Revolve(r) => targets(&mut r.targets),
        Feature::Boolean(b) => {
            card(&mut b.targets, Cardinality::SOME);
            card(&mut b.tools, Cardinality::SOME);
        }
        Feature::Hole(h) => {
            plane(&mut h.on);
            if let Some(HoleDepth::UpTo(r)) = &mut h.depth {
                card(r, Cardinality::ONE);
            }
            if matches!(h.thread, Some(Thread::Flag(false))) {
                h.thread = None;
            }
            targets(&mut h.targets);
        }
        Feature::Fillet(fl) => card(&mut fl.edges, Cardinality::SOME),
        Feature::Chamfer(c) => {
            card(&mut c.edges, Cardinality::SOME);
            if let Some(s) = &mut c.side {
                card(s, Cardinality::ONE);
            }
        }
        Feature::Shell(s) => {
            card(&mut s.body, Cardinality::ONE);
            if let Some(o) = &mut s.open {
                card(o, Cardinality::ANY);
            }
        }
        Feature::Draft(d) => {
            card(&mut d.faces, Cardinality::SOME);
            plane(&mut d.neutral);
        }
        Feature::Pattern(p) => {
            if let PatternSeed::Bodies(r) = &mut p.seed {
                card(r, Cardinality::SOME);
            }
            match &mut p.layout {
                PatternLayout::Linear(l) => {
                    dir(&mut l.dir);
                    if let Some(d) = &mut l.dir2 {
                        dir(d);
                    }
                    if l.count2.as_ref().is_some_and(|c| c.is_literal(1.0)) {
                        l.count2 = None;
                    }
                }
                PatternLayout::Circular(c) => axis(&mut c.axis),
                PatternLayout::Mirror(m) => plane(&mut m.plane),
            }
            targets(&mut p.targets);
        }
        Feature::DatumPlane(d) => {
            for p in [&mut d.from, &mut d.a, &mut d.b].into_iter().flatten() {
                plane(p);
            }
            if let Some(a) = &mut d.axis {
                axis(a);
            }
            if let Some(pts) = &mut d.points {
                pts.iter_mut().for_each(point);
            }
        }
        Feature::Transform(t) => {
            card(&mut t.bodies, Cardinality::SOME);
            if let Some(r) = &mut t.rotate {
                axis(&mut r.axis);
            }
        }
        Feature::DatumAxis(d) => {
            if let Some(e) = &mut d.edge {
                card(e, Cardinality::ONE);
            }
            if let Some(f) = &mut d.face {
                card(f, Cardinality::ONE);
            }
            for p in [&mut d.a, &mut d.b].into_iter().flatten() {
                plane(p);
            }
            if let Some(pts) = &mut d.points {
                pts.iter_mut().for_each(point);
            }
        }
        Feature::Tag(t) => card(&mut t.target, Cardinality::SOME),
    }
}
