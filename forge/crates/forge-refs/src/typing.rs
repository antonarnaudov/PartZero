//! Static kinds and static checks of references and queries (SPEC-v1 §5.3 [W0-14], §5.4,
//! §5.5).
//!
//! Document validation (`forge_ir::v1::validate`) already rejects ill-typed queries. This
//! module is the same check over a [`FeatureTable`], for queries that do not come from a
//! validated document (the agent's `query` tool, synthesized candidate queries, the command
//! layer) and as defence in depth before evaluation. It is pinned to validation by the I9
//! query-typing fixtures (`corpus/v1/conformance/queries/typing.json`): both must produce the
//! same `{code, path}` multiset on every case.
//!
//! Paths are JSON pointers relative to the checked [`Ref`] (`/q/of/1`, `/kind`).

use forge_ir::v1::{
    AxisObject, CardWord, Cardinality, Dir, EntityKind, Predicate, Query, Ref, SP3, Scalar, ids,
};
use serde_json::{Value, json};

use crate::table::{CurveClass, FeatureTable};

/// A Ref-valued field: the kinds it accepts (empty: any) and its default cardinality (§5.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RefField {
    /// Accepted kinds; empty means any.
    pub kinds: &'static [EntityKind],
    /// The field's default cardinality.
    pub card: Cardinality,
}

impl RefField {
    /// A face, card `one` field (plane faces, chamfer `side`, cylinder axes).
    pub const FACE_ONE: RefField = RefField {
        kinds: &[EntityKind::Face],
        card: Cardinality::ONE,
    };
    /// Faces, `some` (draft `faces`).
    pub const FACE_SOME: RefField = RefField {
        kinds: &[EntityKind::Face],
        card: Cardinality::SOME,
    };
    /// Faces, `any` (shell `open`).
    pub const FACE_ANY: RefField = RefField {
        kinds: &[EntityKind::Face],
        card: Cardinality::ANY,
    };
    /// An edge, `one` (edge axes).
    pub const EDGE_ONE: RefField = RefField {
        kinds: &[EntityKind::Edge],
        card: Cardinality::ONE,
    };
    /// Edges, `some` (fillet/chamfer `edges`).
    pub const EDGE_SOME: RefField = RefField {
        kinds: &[EntityKind::Edge],
        card: Cardinality::SOME,
    };
    /// A vertex, `one` (points).
    pub const VERTEX_ONE: RefField = RefField {
        kinds: &[EntityKind::Vertex],
        card: Cardinality::ONE,
    };
    /// A body, `one` (shell `body`).
    pub const BODY_ONE: RefField = RefField {
        kinds: &[EntityKind::Body],
        card: Cardinality::ONE,
    };
    /// Bodies, `some` (targets, tools, pattern bodies).
    pub const BODY_SOME: RefField = RefField {
        kinds: &[EntityKind::Body],
        card: Cardinality::SOME,
    };
    /// Any kind, `some` (tag `target`).
    pub const ANY_SOME: RefField = RefField {
        kinds: &[],
        card: Cardinality::SOME,
    };

    /// The effective cardinality of a reference in this field.
    pub fn card_of(&self, r: &Ref) -> Cardinality {
        r.card.unwrap_or(self.card)
    }
}

/// A static problem: a catalogue code, a JSON pointer relative to the checked Ref, a message
/// and the catalogue's details.
#[derive(Clone, Debug, PartialEq)]
pub struct TypeError {
    /// `QUERY_INVALID`, `QUERY_UNKNOWN_CURVE`, `UNRESOLVED_FEATURE`, `REF_KIND_MISMATCH`,
    /// `INVALID_CARDINALITY`, `INVALID_VALUE`, `INVALID_AXIS` or `INVALID_ID`.
    pub code: &'static str,
    /// JSON pointer relative to the Ref.
    pub path: String,
    /// For people.
    pub message: String,
    /// Catalogue details.
    pub details: Value,
}

/// Check a Ref for a field: the query's static kind must equal `r.kind` and be accepted by
/// the field, and a single-entity field takes only `one`/`1`. Returns the kind, or every
/// problem found.
pub fn check_ref(
    r: &Ref,
    field: &RefField,
    table: &FeatureTable,
) -> Result<EntityKind, Vec<TypeError>> {
    let mut c = Checker {
        table,
        errs: Vec::new(),
    };
    c.check_ref(r, "", field);
    if c.errs.is_empty() {
        Ok(r.kind)
    } else {
        Err(c.errs)
    }
}

/// The static kind of a query, or every problem found (paths relative to the query).
pub fn static_kind(q: &Query, table: &FeatureTable) -> Result<EntityKind, Vec<TypeError>> {
    let mut c = Checker {
        table,
        errs: Vec::new(),
    };
    let k = c.query(q, "");
    match (k, c.errs.is_empty()) {
        (Some(k), true) => Ok(k),
        (None, true) => {
            // Defence in depth: every `None` records its reason; never an empty error list.
            c.invalid(
                "",
                "a statically typed query",
                q.op(),
                format!("the kind of this {} query could not be computed", q.op()),
            );
            Err(c.errs)
        }
        _ => Err(c.errs),
    }
}

struct Checker<'a> {
    table: &'a FeatureTable,
    errs: Vec<TypeError>,
}

const SWEEPS: &[&str] = &["extrude", "revolve"];
const BODY_ORIGINS: &[&str] = &["extrude", "revolve", "pattern", "transform"];
const CREATORS: &[&str] = &[
    "extrude",
    "revolve",
    "boolean",
    "hole",
    "fillet",
    "chamfer",
    "shell",
    "draft",
    "pattern",
    "transform",
];

fn lit3(v: &SP3) -> Option<[f64; 3]> {
    Some([v[0].literal()?, v[1].literal()?, v[2].literal()?])
}

impl Checker<'_> {
    fn err(
        &mut self,
        code: &'static str,
        path: impl Into<String>,
        message: String,
        details: Value,
    ) {
        self.errs.push(TypeError {
            code,
            path: path.into(),
            message,
            details,
        });
    }

    fn reference(&mut self, s: &str, path: &str) -> bool {
        match ids::check_ref(s) {
            Ok(()) => true,
            Err(p) => {
                self.err(
                    "INVALID_ID",
                    path,
                    format!("references must be ids joined by '.' ({})", p.as_str()),
                    json!({ "path": path, "reason": p.as_str(), "length": s.len() }),
                );
                false
            }
        }
    }

    fn id(&mut self, s: &str, path: &str) {
        if let Err(p) = ids::check_id(s) {
            self.err(
                "INVALID_ID",
                path,
                format!("ids must match [A-Za-z_][A-Za-z0-9_]* ({})", p.as_str()),
                json!({ "path": path, "reason": p.as_str(), "length": s.len() }),
            );
        }
    }

    fn check_ref(&mut self, r: &Ref, path: &str, field: &RefField) {
        let qkind = self.query(&r.q, &format!("{path}/q"));
        if let Some(k) = qkind
            && k != r.kind
        {
            self.err(
                "REF_KIND_MISMATCH",
                format!("{path}/kind"),
                format!(
                    "kind is {:?} but the query selects {}s",
                    r.kind.as_str(),
                    k.as_str()
                ),
                json!({ "field": path, "expected": k.as_str(), "found": r.kind.as_str() }),
            );
        }
        if !field.kinds.is_empty() && !field.kinds.contains(&r.kind) {
            let expected: Vec<&str> = field.kinds.iter().map(|k| k.as_str()).collect();
            self.err(
                "REF_KIND_MISMATCH",
                format!("{path}/kind"),
                format!("this field takes {} references", expected.join(" or ")),
                json!({ "field": path, "expected": expected, "found": r.kind.as_str() }),
            );
        }
        if field.card == Cardinality::ONE
            && let Some(c) = r.card
            && !matches!(
                c,
                Cardinality::Word(CardWord::One) | Cardinality::Exactly(1)
            )
        {
            self.err(
                "INVALID_CARDINALITY",
                format!("{path}/card"),
                "this field designates exactly one entity; card must be \"one\"".into(),
                json!({ "field": path, "allowed": ["one", 1] }),
            );
        }
        if let Some(Cardinality::Exactly(0)) = r.card {
            self.err(
                "INVALID_CARDINALITY",
                format!("{path}/card"),
                "card must be one, some, any or an integer >= 1".into(),
                json!({ "field": path, "allowed": ["one", "some", "any", ">= 1"] }),
            );
        }
    }

    /// The type of the feature a query names, if it is an earlier feature of an allowed type.
    fn feature_of(&mut self, feature: &str, path: &str, allowed: &[&str]) -> Option<String> {
        let fpath = format!("{path}/feature");
        if !self.reference(feature, &fpath) {
            return None;
        }
        match self.table.get(feature) {
            None => {
                self.err(
                    "UNRESOLVED_FEATURE",
                    &fpath,
                    format!("{feature:?} is not the id of an earlier feature of this part studio"),
                    json!({ "id": feature, "field": fpath, "expected": allowed }),
                );
                None
            }
            Some(f) if !allowed.is_empty() && !allowed.contains(&f.ty.as_str()) => {
                self.err(
                    "QUERY_INVALID",
                    &fpath,
                    format!(
                        "this query needs a {} feature, {feature:?} is a {}",
                        allowed.join(" or "),
                        f.ty
                    ),
                    json!({ "path": path, "expected": allowed, "found": f.ty }),
                );
                None
            }
            Some(f) => Some(f.ty.clone()),
        }
    }

    fn curve_of(&mut self, feature: &str, curve: &str, path: &str) -> Option<CurveClass> {
        if !self.reference(curve, path) {
            return None;
        }
        let profile = self.table.get(feature)?.profile.clone()?;
        let class = profile.class(curve);
        if class.is_none() {
            let similar: Vec<&String> = profile
                .curves
                .keys()
                .filter(|k| similar(k, curve))
                .take(5)
                .collect();
            self.err(
                "QUERY_UNKNOWN_CURVE",
                path,
                format!("{curve:?} is not a profile curve of the sketch consumed by {feature:?}"),
                json!({ "feature": feature, "curve": curve, "similar": similar }),
            );
        }
        class
    }

    fn invalid(&mut self, path: &str, expected: &str, found: &str, message: String) {
        self.err(
            "QUERY_INVALID",
            path,
            message,
            json!({ "path": path, "expected": expected, "found": found }),
        );
    }

    fn query(&mut self, q: &Query, path: &str) -> Option<EntityKind> {
        use EntityKind::*;
        match q {
            Query::Body { feature, member } => {
                let ty = self.feature_of(feature, path, BODY_ORIGINS);
                if let (Some("extrude" | "revolve"), Some(m)) = (ty.as_deref(), member) {
                    self.curve_of(feature, m, &format!("{path}/member"));
                }
                Some(Body)
            }
            Query::Bodies {} => Some(Body),
            Query::Cap {
                feature, member, ..
            } => {
                if self.feature_of(feature, path, &["extrude"]).is_some()
                    && let Some(m) = member
                {
                    self.curve_of(feature, m, &format!("{path}/member"));
                }
                Some(Face)
            }
            Query::Endcap {
                feature, member, ..
            } => {
                if self.feature_of(feature, path, &["revolve"]).is_some()
                    && let Some(m) = member
                {
                    self.curve_of(feature, m, &format!("{path}/member"));
                }
                Some(Face)
            }
            Query::Side { feature, curve } => {
                if self.feature_of(feature, path, SWEEPS).is_some() {
                    self.curve_of(feature, curve, &format!("{path}/curve"));
                }
                Some(Face)
            }
            Query::Sides { feature, member } => {
                if self.feature_of(feature, path, SWEEPS).is_some()
                    && let Some(m) = member
                {
                    self.curve_of(feature, m, &format!("{path}/member"));
                }
                Some(Face)
            }
            Query::EdgeAt { feature, curve, .. } => {
                if self.feature_of(feature, path, SWEEPS).is_some()
                    && self.curve_of(feature, curve, &format!("{path}/curve"))
                        == Some(CurveClass::Circle)
                {
                    self.invalid(
                        &format!("{path}/curve"),
                        "a line or arc (a curve with ends)",
                        "circle",
                        format!("{curve:?} is a circle: it has no ends"),
                    );
                }
                Some(Edge)
            }
            Query::Between { a, b } => {
                for (side, sub) in [("a", a), ("b", b)] {
                    let sp = format!("{path}/{side}");
                    if let Some(k) = self.query(sub, &sp)
                        && k != Face
                    {
                        self.invalid(
                            &sp,
                            "face",
                            k.as_str(),
                            format!(
                                "between takes two face queries, {side} selects {}s",
                                k.as_str()
                            ),
                        );
                    }
                }
                Some(Edge)
            }
            Query::HoleFace { feature, at, .. } => {
                self.feature_of(feature, path, &["hole"]);
                self.id(at, &format!("{path}/at"));
                Some(Face)
            }
            Query::Created { feature, role } => {
                self.feature_of(feature, path, CREATORS);
                if let Some(r) = role {
                    self.id(r, &format!("{path}/role"));
                }
                Some(Face)
            }
            Query::Instance { feature, index } => {
                self.feature_of(feature, path, &["pattern"]);
                if index.is_empty() || index.len() > 2 {
                    self.invalid(
                        &format!("{path}/index"),
                        "[i] or [i, j]",
                        &format!("{} indices", index.len()),
                        "an instance index is [i] or [i, j]".into(),
                    );
                }
                Some(Face)
            }
            Query::Tagged { feature } => {
                self.feature_of(feature, path, &["tag"])?;
                let kind = self.table.get(feature).and_then(|f| f.tag_kind());
                if kind.is_none() {
                    // A tag feature with no target (a malformed table): never a silent `None`.
                    self.invalid(
                        &format!("{path}/feature"),
                        "a tag with a target",
                        "a tag without a target",
                        format!("tag {feature:?} has no target reference"),
                    );
                }
                kind
            }
            Query::Faces { of } => self.nav(of, path, &[Body, Edge, Vertex], Face),
            Query::Edges { of } => self.nav(of, path, &[Body, Face, Vertex], Edge),
            Query::Vertices { of } => self.nav(of, path, &[Body, Face, Edge], Vertex),
            Query::Owner { of } => self.nav(of, path, &[Face, Edge, Vertex], Body),
            Query::Union { of } | Query::Intersect { of } => {
                if of.is_empty() {
                    self.invalid(
                        &format!("{path}/of"),
                        "at least one query",
                        "none",
                        format!("{} needs at least one operand", q.op()),
                    );
                    return None;
                }
                let mut kind = None;
                for (i, sub) in of.iter().enumerate() {
                    let sp = format!("{path}/of/{i}");
                    if let Some(k) = self.query(sub, &sp) {
                        match kind {
                            None => kind = Some(k),
                            Some(k0) if k0 != k => self.invalid(
                                &sp,
                                k0.as_str(),
                                k.as_str(),
                                format!(
                                    "set operands must have one kind: {} vs {}",
                                    k0.as_str(),
                                    k.as_str()
                                ),
                            ),
                            _ => {}
                        }
                    }
                }
                kind
            }
            Query::Minus { a, b } => {
                let ka = self.query(a, &format!("{path}/a"));
                let kb = self.query(b, &format!("{path}/b"));
                if let (Some(ka), Some(kb)) = (ka, kb)
                    && ka != kb
                {
                    self.invalid(
                        &format!("{path}/b"),
                        ka.as_str(),
                        kb.as_str(),
                        "minus operands must have one kind".into(),
                    );
                }
                ka
            }
            Query::Filter { of, pred } => {
                let k = self.query(of, &format!("{path}/of"))?;
                self.predicate(pred, k, &format!("{path}/where"));
                Some(k)
            }
            Query::Extreme { of, dir, .. } => {
                self.dir(dir, &format!("{path}/dir"));
                self.query(of, &format!("{path}/of"))
            }
            Query::Largest { of } | Query::Smallest { of } => {
                let k = self.query(of, &format!("{path}/of"))?;
                if k == Vertex {
                    self.invalid(
                        &format!("{path}/of"),
                        "faces, edges or bodies",
                        "vertex",
                        format!("{} needs a size; vertices have none", q.op()),
                    );
                }
                Some(k)
            }
        }
    }

    fn nav(
        &mut self,
        of: &Query,
        path: &str,
        from: &[EntityKind],
        to: EntityKind,
    ) -> Option<EntityKind> {
        let sp = format!("{path}/of");
        if let Some(k) = self.query(of, &sp)
            && !from.contains(&k)
        {
            let expected: Vec<&str> = from.iter().map(|k| k.as_str()).collect();
            self.invalid(
                &sp,
                &expected.join(" or "),
                k.as_str(),
                format!("cannot navigate from {}s to {}s", k.as_str(), to.as_str()),
            );
        }
        Some(to)
    }

    fn predicate(&mut self, p: &Predicate, k: EntityKind, path: &str) {
        use EntityKind::*;
        let applies = |kinds: &[EntityKind]| kinds.contains(&k);
        let (name, ok, expected): (&str, bool, &str) = match p {
            Predicate::Type(t) => (
                "type",
                t.applies_to(k),
                if t.applies_to(Face) { "faces" } else { "edges" },
            ),
            Predicate::Normal(_) => ("normal", applies(&[Face]), "faces"),
            Predicate::Parallel(_) => ("parallel", applies(&[Face, Edge]), "faces or edges"),
            Predicate::Perpendicular(_) => {
                ("perpendicular", applies(&[Face, Edge]), "faces or edges")
            }
            Predicate::Convex(_) => ("convex", applies(&[Edge]), "edges"),
            Predicate::Concave(_) => ("concave", applies(&[Edge]), "edges"),
            Predicate::Smooth(_) => ("smooth", applies(&[Edge]), "edges"),
            Predicate::Radius(_) => ("radius", applies(&[Face, Edge]), "faces or edges"),
        };
        if !ok {
            self.invalid(
                path,
                expected,
                k.as_str(),
                format!("predicate {name:?} does not apply to {}s", k.as_str()),
            );
        }
        match p {
            Predicate::Normal(d) | Predicate::Parallel(d) | Predicate::Perpendicular(d) => {
                self.dir(d, &format!("{path}/{name}"));
            }
            Predicate::Convex(b) | Predicate::Concave(b) | Predicate::Smooth(b) if !*b => {
                self.invalid(
                    &format!("{path}/{name}"),
                    "true",
                    "false",
                    format!("{{ {name:?}: false }} is not a predicate; use minus"),
                );
            }
            Predicate::Radius(r) => {
                let ok = match (&r.eq, &r.min, &r.max) {
                    (Some(_), None, None) => true,
                    (None, lo, hi) => lo.is_some() || hi.is_some(),
                    _ => false,
                };
                if !ok {
                    self.invalid(
                        &format!("{path}/radius"),
                        "{ eq } or { min?, max? }",
                        "other fields",
                        "radius takes eq, or min and/or max".into(),
                    );
                }
                for (f, v) in [("eq", &r.eq), ("min", &r.min), ("max", &r.max)] {
                    if let Some(x) = v.as_ref().and_then(Scalar::literal)
                        && x < 0.0
                    {
                        let fp = format!("{path}/radius/{f}");
                        self.err(
                            "INVALID_VALUE",
                            fp,
                            format!("{f} = {x}: must be >= 0"),
                            json!({ "field": f, "value": x, "expected": ">= 0" }),
                        );
                    }
                }
            }
            _ => {}
        }
    }

    fn nonzero(&mut self, v: &SP3, path: &str, code: &'static str) {
        if let Some(x) = lit3(v)
            && (x[0] * x[0] + x[1] * x[1] + x[2] * x[2]).sqrt() <= forge_ir::v1::LINEAR_TOLERANCE
        {
            self.err(
                code,
                path,
                "direction must be non-zero".into(),
                json!({ "field": path, "value": x, "expected": "a non-zero vector" }),
            );
        }
    }

    fn datum_ref(&mut self, id: &str, path: &str, expected: &'static str) {
        if !self.reference(id, path) {
            return;
        }
        if !matches!(self.table.get(id), Some(f) if f.ty == expected) {
            self.err(
                "UNRESOLVED_FEATURE",
                path,
                format!("{id:?} is not an earlier {expected} feature of this part studio"),
                json!({ "id": id, "field": path, "expected": expected }),
            );
        }
    }

    fn axis_object(&mut self, o: &AxisObject, path: &str) {
        match o {
            AxisObject::Edge(e) => {
                self.check_ref(&e.edge, &format!("{path}/edge"), &RefField::EDGE_ONE)
            }
            AxisObject::Cylinder(c) => self.check_ref(
                &c.cylinder,
                &format!("{path}/cylinder"),
                &RefField::FACE_ONE,
            ),
            AxisObject::Datum(d) => {
                self.datum_ref(&d.datum, &format!("{path}/datum"), "datum_axis")
            }
            AxisObject::Line(l) => self.nonzero(
                &l.line.direction,
                &format!("{path}/line/direction"),
                "INVALID_AXIS",
            ),
        }
    }

    fn dir(&mut self, d: &Dir, path: &str) {
        match d {
            Dir::Name(_) => {}
            Dir::Vector(v) => self.nonzero(v, path, "INVALID_VALUE"),
            Dir::Axis(o) => self.axis_object(o, path),
        }
    }
}

/// Validation's "did you mean" rule (the same cheap test: a shared prefix of 3 or more
/// bytes, fewer for short ids).
fn similar(candidate: &str, wanted: &str) -> bool {
    let common = candidate
        .bytes()
        .zip(wanted.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    common >= 3.min(wanted.len()).max(1) && candidate != wanted
}
