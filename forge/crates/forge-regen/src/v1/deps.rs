//! The features a feature references **by id** (SPEC-v1 §7.1 step 2: "sketch, datum, tag,
//! pattern seed"). Their state is checked before the feature's field expressions and range
//! checks: `SKETCH_SUPPRESSED` / `DEPENDENCY_SUPPRESSED` / `DEPENDENCY_FAILED` decide the code
//! even when a field of the feature would also fail.
//!
//! Order: the feature's fields in declaration (= schema, = canonical JSON) order, depth first
//! through nested plane, axis and direction references and through every query (operands in
//! order); each id once, at its first occurrence. A `tagged` query is a reference by id to the
//! tag (§6.12) wherever it appears in a Ref, including the queries of plane, axis, direction and
//! point references. A Ref's `capture` holds keys, never feature ids, and is not searched.

use forge_ir::v1::{
    AxisObject, AxisRef, Dir, Feature, HoleDepth, HolePlacement, PatternLayout, PatternSeed,
    PlaneRef, PointRef, Predicate, Query, Ref, Targets,
};

/// How a feature is referenced by id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ByIdKind {
    /// A consumed sketch (extrude and revolve `sketch`, a hole's `at.points.sketch`).
    Sketch,
    /// A `{ "datum": id }` plane or axis reference.
    Datum,
    /// A `{ "op": "tagged", "feature": id }` query.
    Tag,
    /// An entry of a pattern's `seed.features`.
    Seed,
}

impl ByIdKind {
    /// The word used in messages and `UNRESOLVED_FEATURE` details.
    pub(crate) fn noun(self) -> &'static str {
        match self {
            ByIdKind::Sketch => "sketch",
            ByIdKind::Datum => "datum",
            ByIdKind::Tag => "tag",
            ByIdKind::Seed => "pattern seed",
        }
    }
}

/// Every feature `f` references by id, in field order, each id once (first occurrence).
pub(crate) fn by_id(f: &Feature) -> Vec<(String, ByIdKind)> {
    let mut w = Walk { out: Vec::new() };
    match f {
        Feature::Sketch(s) => w.plane(&s.plane),
        Feature::Extrude(e) => {
            w.push(&e.sketch, ByIdKind::Sketch);
            w.targets(e.targets.as_ref());
        }
        Feature::Revolve(r) => {
            w.push(&r.sketch, ByIdKind::Sketch);
            w.targets(r.targets.as_ref());
        }
        Feature::Boolean(b) => {
            w.r(&b.targets);
            w.r(&b.tools);
        }
        Feature::Hole(h) => {
            w.plane(&h.on);
            if let HolePlacement::Points(p) = &h.at {
                w.push(&p.sketch, ByIdKind::Sketch);
            }
            if let Some(HoleDepth::UpTo(r)) = &h.depth {
                w.r(r);
            }
            w.targets(h.targets.as_ref());
        }
        Feature::Fillet(x) => w.r(&x.edges),
        Feature::Thread(x) => w.r(&x.face),
        Feature::Chamfer(x) => {
            w.r(&x.edges);
            if let Some(r) = &x.side {
                w.r(r);
            }
        }
        Feature::Shell(x) => {
            w.r(&x.body);
            if let Some(r) = &x.open {
                w.r(r);
            }
        }
        Feature::Draft(x) => {
            w.r(&x.faces);
            w.plane(&x.neutral);
        }
        Feature::Pattern(p) => {
            match &p.seed {
                PatternSeed::Features(ids) => {
                    for id in ids {
                        w.push(id, ByIdKind::Seed);
                    }
                }
                PatternSeed::Bodies(r) => w.r(r),
            }
            match &p.layout {
                PatternLayout::Linear(l) => {
                    w.dir(&l.dir);
                    if let Some(d) = &l.dir2 {
                        w.dir(d);
                    }
                }
                PatternLayout::Circular(c) => w.axis(&c.axis),
                PatternLayout::Mirror(m) => w.plane(&m.plane),
            }
            w.targets(p.targets.as_ref());
        }
        Feature::DatumPlane(d) => {
            if let Some(p) = &d.from {
                w.plane(p);
            }
            if let Some(a) = &d.axis {
                w.axis(a);
            }
            for p in [&d.a, &d.b].into_iter().flatten() {
                w.plane(p);
            }
            for p in d.points.iter().flatten() {
                w.point(p);
            }
        }
        Feature::DatumAxis(d) => {
            for r in [&d.edge, &d.face].into_iter().flatten() {
                w.r(r);
            }
            for p in [&d.a, &d.b].into_iter().flatten() {
                w.plane(p);
            }
            for p in d.points.iter().flatten() {
                w.point(p);
            }
        }
        Feature::Tag(t) => w.r(&t.target),
    }
    w.out
}

struct Walk {
    out: Vec<(String, ByIdKind)>,
}

impl Walk {
    fn push(&mut self, id: &str, kind: ByIdKind) {
        if !self.out.iter().any(|(x, _)| x == id) {
            self.out.push((id.to_string(), kind));
        }
    }

    fn targets(&mut self, t: Option<&Targets>) {
        if let Some(Targets::Ref(r)) = t {
            self.r(r);
        }
    }

    fn plane(&mut self, p: &PlaneRef) {
        match p {
            PlaneRef::Named(_) | PlaneRef::Frame(_) => {}
            PlaneRef::Face(f) => self.r(&f.face),
            PlaneRef::Datum(d) => self.push(&d.datum, ByIdKind::Datum),
        }
    }

    fn axis(&mut self, a: &AxisRef) {
        if let AxisRef::Object(o) = a {
            self.axis_object(o);
        }
    }

    fn axis_object(&mut self, o: &AxisObject) {
        match o {
            AxisObject::Edge(e) => self.r(&e.edge),
            AxisObject::Cylinder(c) => self.r(&c.cylinder),
            AxisObject::Datum(d) => self.push(&d.datum, ByIdKind::Datum),
            AxisObject::Line(_) => {}
        }
    }

    fn dir(&mut self, d: &Dir) {
        if let Dir::Axis(o) = d {
            self.axis_object(o);
        }
    }

    fn point(&mut self, p: &PointRef) {
        if let PointRef::Vertex(v) = p {
            self.r(&v.vertex);
        }
    }

    fn r(&mut self, r: &Ref) {
        self.q(&r.q);
    }

    fn q(&mut self, q: &Query) {
        match q {
            Query::Tagged { feature } => self.push(feature, ByIdKind::Tag),
            Query::Between { a, b } | Query::Minus { a, b } => {
                self.q(a);
                self.q(b);
            }
            Query::Faces { of }
            | Query::Edges { of }
            | Query::Vertices { of }
            | Query::Owner { of }
            | Query::Largest { of }
            | Query::Smallest { of } => self.q(of),
            Query::Filter { of, pred } => {
                self.q(of);
                match pred {
                    Predicate::Normal(d) | Predicate::Parallel(d) | Predicate::Perpendicular(d) => {
                        self.dir(d);
                    }
                    Predicate::Type(_)
                    | Predicate::Convex(_)
                    | Predicate::Concave(_)
                    | Predicate::Smooth(_)
                    | Predicate::Radius(_) => {}
                }
            }
            Query::Extreme { of, dir, .. } => {
                self.q(of);
                self.dir(dir);
            }
            Query::Union { of } | Query::Intersect { of } => {
                for x in of {
                    self.q(x);
                }
            }
            // Named and broad sources name features too, but they are resolved with the query
            // (§5.7 step 1), not checked by id.
            Query::Body { .. }
            | Query::Bodies {}
            | Query::Cap { .. }
            | Query::Endcap { .. }
            | Query::Side { .. }
            | Query::Sides { .. }
            | Query::EdgeAt { .. }
            | Query::HoleFace { .. }
            | Query::Created { .. }
            | Query::Instance { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn feature(v: serde_json::Value) -> Feature {
        serde_json::from_value(v).expect("a feature")
    }

    fn ids(f: &Feature) -> Vec<(String, ByIdKind)> {
        by_id(f)
    }

    fn want(x: &[(&str, ByIdKind)]) -> Vec<(String, ByIdKind)> {
        x.iter().map(|(i, k)| ((*i).to_string(), *k)).collect()
    }

    #[test]
    fn a_sweep_lists_its_sketch_then_tags_in_its_targets() {
        let f = feature(
            json!({ "type": "extrude", "id": "e2", "name": "e2", "sketch": "s1",
            "distance": 1, "op": "cut", "targets": { "kind": "body",
              "q": { "op": "owner", "of": { "op": "union", "of": [
                { "op": "tagged", "feature": "t1" },
                { "op": "cap", "feature": "e1", "end": "end" },
                { "op": "tagged", "feature": "t0" },
                { "op": "tagged", "feature": "t1" } ] } } } }),
        );
        assert_eq!(
            ids(&f),
            want(&[
                ("s1", ByIdKind::Sketch),
                ("t1", ByIdKind::Tag),
                ("t0", ByIdKind::Tag)
            ])
        );
    }

    #[test]
    fn plane_axis_direction_and_predicate_references_are_searched_in_field_order() {
        let f = feature(
            json!({ "type": "datum_plane", "id": "d3", "name": "d3", "mode": "angle",
            "from": { "face": { "kind": "face", "q": { "op": "filter",
                "of": { "op": "tagged", "feature": "tf" },
                "where": { "normal": { "edge": { "kind": "edge",
                    "q": { "op": "tagged", "feature": "te" } } } } } } },
            "axis": { "datum": "a1", "flip": true }, "angle": 30 }),
        );
        assert_eq!(
            ids(&f),
            want(&[
                ("tf", ByIdKind::Tag),
                ("te", ByIdKind::Tag),
                ("a1", ByIdKind::Datum)
            ])
        );
        let f = feature(json!({ "type": "sketch", "id": "s", "name": "s",
            "plane": { "datum": "d1" }, "curves": [] }));
        assert_eq!(ids(&f), want(&[("d1", ByIdKind::Datum)]));
    }

    #[test]
    fn pattern_seeds_come_before_layout_and_targets() {
        let f = feature(json!({ "type": "pattern", "id": "p", "name": "p",
            "seed": { "features": ["e1", "h1"] },
            "layout": { "circular": { "axis": { "datum": "ax" }, "count": 4 } } }));
        assert_eq!(
            ids(&f),
            want(&[
                ("e1", ByIdKind::Seed),
                ("h1", ByIdKind::Seed),
                ("ax", ByIdKind::Datum)
            ])
        );
    }

    #[test]
    fn named_sources_and_captures_are_not_references_by_id() {
        let f = feature(json!({ "type": "tag", "id": "t", "name": "t", "target": {
            "kind": "face", "q": { "op": "created", "feature": "f1" } } }));
        assert!(by_id(&f).is_empty());
        let f = feature(json!({ "type": "fillet", "id": "f", "name": "f", "r": 1,
            "edges": { "kind": "edge", "q": { "op": "edges", "of": { "op": "body", "feature": "e1" } } } }));
        assert!(by_id(&f).is_empty());
    }
}
