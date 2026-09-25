//! Structural validation of IR v1 documents (SPEC-v1 §0.5 rule 1, every **R** code of §7.5).
//!
//! No geometry is evaluated. Expression syntax, typing, scope and cycles are W1's and plug in
//! through [`super::expr::ExprValidator`]. Every problem is returned (not just the first), each
//! with a JSON-pointer path and structured `details` (§7.4).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use super::compound::{self, Compound, PolygonSize};
use super::expr::{ExprScope, ExprSite, ExprValidator, LiteralSite, SiteOwner};
use super::features::*;
use super::holes;
use super::ids;
use super::params::{ParamUnit, ParamValue, Parameter};
use super::planes::*;
use super::refs::*;
use super::scalar::{BoolScalar, FieldType, SP2, SP3, Scalar};
use super::sketch::{Constraint, SketchCurve};
use super::{
    Document, IR_SCHEMA, LINEAR_TOLERANCE, MAX_COUNT_MAGNITUDE, MAX_EXPR_BYTES, PartStudio,
};

// ---- errors and options ---------------------------------------------------------------------

/// A coded rejection (SPEC-v1 §0.5, §7.4).
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{code} at {path}: {message}")]
pub struct ValidationError {
    /// Stable code from the catalogue ([`super::codes`]).
    pub code: &'static str,
    /// JSON pointer to the offending element.
    pub path: String,
    pub message: String,
    /// Structured context; keys per code in the catalogue.
    pub details: Value,
}

impl ValidationError {
    pub fn new(
        code: &'static str,
        path: impl Into<String>,
        message: impl Into<String>,
        details: Value,
    ) -> Self {
        Self {
            code,
            path: path.into(),
            message: message.into(),
            details,
        }
    }
}

impl From<crate::ValidationError> for ValidationError {
    fn from(e: crate::ValidationError) -> Self {
        Self {
            code: e.code,
            path: e.path,
            message: e.message,
            details: json!({}),
        }
    }
}

/// Validation options.
pub struct ValidateOptions<'a> {
    /// The expression validator of §0.5 rule 4 step 5. The default is W1's checker
    /// ([`super::expr::CHECKER`]), so every default entry point ([`validate`],
    /// [`super::from_json`], `VersionedDocument::from_json`) runs the whole rejection pipeline;
    /// `None` opts out and checks only what needs no parser (W0's structural checks).
    pub expr: Option<&'a dyn ExprValidator>,
    /// Optional feature types this engine does not implement (e.g. `["draft"]`, §6.9):
    /// rejected with `UNSUPPORTED_FEATURE`.
    pub unsupported_features: &'a [&'a str],
}

impl Default for ValidateOptions<'_> {
    fn default() -> Self {
        Self {
            expr: Some(&super::expr::CHECKER),
            unsupported_features: &[],
        }
    }
}

/// Validate a document with default options (the whole rejection pipeline, W1's expression
/// checks included). Returns every problem found.
pub fn validate(doc: &Document) -> Result<(), Vec<ValidationError>> {
    validate_with(doc, &ValidateOptions::default())
}

/// Validate a document. Returns every problem found, in document order (W1's expression
/// problems follow the structural ones).
pub fn validate_with(
    doc: &Document,
    opts: &ValidateOptions<'_>,
) -> Result<(), Vec<ValidationError>> {
    let mut v = Validator {
        doc,
        opts,
        errs: Vec::new(),
        names: BTreeSet::new(),
        feature_ids: BTreeSet::new(),
        part_ids: BTreeSet::new(),
        part_names: BTreeSet::new(),
    };
    v.document();
    // Generic checks over every Scalar site.
    let mut w = Walker::default();
    w.walk_document(doc);
    for s in &w.exprs {
        // No `expr` in these details: the text failed the grammar ([W0-12]).
        if s.text.trim().is_empty() {
            v.errs.push(ValidationError::new(
                "EXPR_SYNTAX",
                &s.path,
                "empty expression",
                json!({ "offset": 0, "expected": "an expression", "length": s.text.len() }),
            ));
        } else if s.text.len() > MAX_EXPR_BYTES {
            v.errs.push(ValidationError::new(
                "EXPR_SYNTAX",
                &s.path,
                format!("expression longer than {MAX_EXPR_BYTES} bytes"),
                json!({ "offset": MAX_EXPR_BYTES, "expected": "at most 4096 bytes", "length": s.text.len() }),
            ));
        }
    }
    for l in &w.literals {
        if !l.value.is_finite() {
            v.errs.push(ValidationError::new(
                "NON_FINITE",
                &l.path,
                "literal values must be finite",
                json!({ "field": l.path }),
            ));
        } else if l.field == FieldType::Count && !is_count(l.value) {
            v.errs.push(ValidationError::new(
                "EXPR_NOT_INTEGER",
                &l.path,
                format!(
                    "a count must be an exact integer with |v| <= 2^31, got {}",
                    l.value
                ),
                json!({ "expr": l.value, "value": l.value }),
            ));
        }
    }
    if let Some(hook) = opts.expr {
        v.errs.extend(hook.validate_expressions(doc, &w.exprs));
    }
    if v.errs.is_empty() {
        Ok(())
    } else {
        Err(v.errs)
    }
}

fn is_count(v: f64) -> bool {
    v.is_finite() && v.fract() == 0.0 && v.abs() <= MAX_COUNT_MAGNITUDE
}

fn tol() -> String {
    format!("> {LINEAR_TOLERANCE}")
}

// ---- per-part context -------------------------------------------------------------------------

/// What a query or a profile-curve id can name in a sketch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CurveClass {
    Line,
    Arc,
    Circle,
}

#[derive(Debug, Default, Clone)]
struct SketchInfo {
    /// Non-construction profile curves (lines, arcs, circles, compound members).
    profile: BTreeMap<String, CurveClass>,
    /// Polygons whose `n` is an expression: any `<id>.e<k>` is accepted.
    wild_polygons: Vec<String>,
    /// Hole-placeable points: `point` curves and `<circle>.center`.
    points: BTreeSet<String>,
    /// `point` curves in curve order (for `ids: "all"`).
    point_curves: Vec<String>,
}

impl SketchInfo {
    fn class(&self, id: &str) -> Option<CurveClass> {
        if let Some(c) = self.profile.get(id) {
            return Some(*c);
        }
        for p in &self.wild_polygons {
            if let Some(rest) = id
                .strip_prefix(p.as_str())
                .and_then(|r| r.strip_prefix(".e"))
                && !rest.is_empty()
                && rest.bytes().all(|b| b.is_ascii_digit())
            {
                return Some(CurveClass::Line);
            }
        }
        None
    }
}

#[derive(Debug, Clone)]
struct FeatInfo {
    ty: &'static str,
    /// For extrude/revolve: the consumed sketch id.
    sketch: Option<String>,
    /// For a tag: its target's kind.
    tag_kind: Option<EntityKind>,
}

#[derive(Default)]
struct PartCtx {
    earlier: BTreeMap<String, FeatInfo>,
    sketches: BTreeMap<String, SketchInfo>,
}

impl PartCtx {
    fn consumed_sketch(&self, feature: &str) -> Option<&SketchInfo> {
        let f = self.earlier.get(feature)?;
        self.sketches.get(f.sketch.as_ref()?)
    }
}

/// A Ref-valued field: which kinds it accepts and its default cardinality (§5.5, §6).
#[derive(Clone, Copy)]
struct RefField {
    kinds: &'static [EntityKind],
    card: Cardinality,
}

const FACE_ONE: RefField = RefField {
    kinds: &[EntityKind::Face],
    card: Cardinality::ONE,
};
const FACE_SOME: RefField = RefField {
    kinds: &[EntityKind::Face],
    card: Cardinality::SOME,
};
const FACE_ANY: RefField = RefField {
    kinds: &[EntityKind::Face],
    card: Cardinality::ANY,
};
const EDGE_ONE: RefField = RefField {
    kinds: &[EntityKind::Edge],
    card: Cardinality::ONE,
};
const EDGE_SOME: RefField = RefField {
    kinds: &[EntityKind::Edge],
    card: Cardinality::SOME,
};
const VERTEX_ONE: RefField = RefField {
    kinds: &[EntityKind::Vertex],
    card: Cardinality::ONE,
};
const BODY_ONE: RefField = RefField {
    kinds: &[EntityKind::Body],
    card: Cardinality::ONE,
};
const BODY_SOME: RefField = RefField {
    kinds: &[EntityKind::Body],
    card: Cardinality::SOME,
};
const ANY_SOME: RefField = RefField {
    kinds: &[],
    card: Cardinality::SOME,
};

// ---- the validator ----------------------------------------------------------------------------

struct Validator<'a> {
    doc: &'a Document,
    opts: &'a ValidateOptions<'a>,
    errs: Vec<ValidationError>,
    /// The shared namespace of feature and parameter names.
    names: BTreeSet<&'a str>,
    feature_ids: BTreeSet<&'a str>,
    part_ids: BTreeSet<&'a str>,
    part_names: BTreeSet<&'a str>,
}

impl<'a> Validator<'a> {
    fn err(
        &mut self,
        code: &'static str,
        path: impl Into<String>,
        message: impl Into<String>,
        details: Value,
    ) {
        self.errs
            .push(ValidationError::new(code, path, message, details));
    }

    fn document(&mut self) {
        let doc = self.doc;
        if doc.schema != IR_SCHEMA {
            self.err(
                "UNSUPPORTED_SCHEMA",
                "/schema",
                format!("expected {IR_SCHEMA:?}, got {:?}", doc.schema),
                json!({ "found": doc.schema, "supported": [crate::IR_SCHEMA, IR_SCHEMA] }),
            );
        }
        if doc.parts.is_empty() {
            self.err(
                "NO_PARTS",
                "/parts",
                "a document needs at least one part studio",
                json!({}),
            );
        }
        for (i, p) in doc.params.iter().enumerate() {
            self.param(p, &format!("/params/{i}"));
        }
        for (pi, part) in doc.parts.iter().enumerate() {
            self.part(pi, part);
        }
    }

    fn name(&mut self, name: &'a str, path: &str, reserved: &[&str]) {
        if let Err(p) = ids::check_id(name) {
            // Never echo a string that fails the grammar ([W0-12]).
            self.err(
                "INVALID_NAME",
                path,
                format!(
                    "names must match [A-Za-z_][A-Za-z0-9_]* with at most {} bytes ({})",
                    ids::MAX_ID_LEN,
                    p.as_str()
                ),
                json!({ "path": path, "reason": p.as_str(), "length": name.len() }),
            );
        } else if reserved.contains(&name) {
            self.err(
                "RESERVED_NAME",
                path,
                format!("{name:?} is a reserved word or CadScript builtin; pick another name"),
                json!({ "name": name }),
            );
        }
        if !self.names.insert(name) {
            self.err(
                "DUPLICATE_NAME",
                path,
                format!(
                    "{:?} is already a feature or parameter name",
                    ids::shown(name)
                ),
                json!({ "name": ids::shown(name) }),
            );
        }
    }

    /// An id declaration: `[A-Za-z_][A-Za-z0-9_]*`, 1–64 bytes ([W0-12]).
    fn id(&mut self, id: &str, path: &str) -> bool {
        match ids::check_id(id) {
            Ok(()) => true,
            Err(p) => {
                self.err(
                    "INVALID_ID",
                    path,
                    format!(
                        "ids must match [A-Za-z_][A-Za-z0-9_]* with at most {} bytes ({})",
                        ids::MAX_ID_LEN,
                        p.as_str()
                    ),
                    json!({ "path": path, "reason": p.as_str(), "length": id.len() }),
                );
                false
            }
        }
    }

    /// A string that refers to an id (`feature`, `curve`, `sketch`, constraint arguments, …):
    /// up to three `.`-separated ids ([W0-12]). Invalid ones are `INVALID_ID` and are not
    /// resolved further (so they are never echoed).
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

    fn param(&mut self, p: &'a Parameter, pp: &str) {
        let reserved = super::reserved_names();
        self.name(&p.name, &format!("{pp}/name"), &reserved);
        let name = p.name.as_str();
        if p.unit == ParamUnit::Bool {
            for (field, b) in [("min", &p.min), ("max", &p.max)] {
                if b.is_some() {
                    self.err(
                        "PARAM_INVALID",
                        format!("{pp}/{field}"),
                        "bounds are not allowed on a bool parameter",
                        json!({ "name": name, "reason": "bounds-on-bool" }),
                    );
                }
            }
        }
        let vp = format!("{pp}/value");
        match (&p.value, p.unit) {
            (ParamValue::Bool(_), u) if u != ParamUnit::Bool => self.err(
                "EXPR_TYPE_MISMATCH",
                &vp,
                "a boolean literal for a numeric parameter",
                json!({ "expr": p.value_json(), "subexpr": p.value_json(), "expected": u.field_type().unit_name(), "found": "bool" }),
            ),
            (ParamValue::Num(_), ParamUnit::Bool) => self.err(
                "EXPR_TYPE_MISMATCH",
                &vp,
                "a number literal for a bool parameter",
                json!({ "expr": p.value_json(), "subexpr": p.value_json(), "expected": "bool", "found": "number" }),
            ),
            // A non-integer literal count is EXPR_NOT_INTEGER from the generic literal-site check.
            _ => {}
        }
        let lo = p.min.as_ref().and_then(Scalar::literal);
        let hi = p.max.as_ref().and_then(Scalar::literal);
        if let (Some(lo), Some(hi)) = (lo, hi)
            && lo > hi
        {
            self.err(
                "PARAM_INVALID",
                format!("{pp}/max"),
                format!("min {lo} > max {hi}"),
                json!({ "name": name, "reason": "min-greater-than-max" }),
            );
        }
        if let ParamValue::Num(v) = p.value
            && (lo.is_some_and(|lo| v < lo) || hi.is_some_and(|hi| v > hi))
        {
            self.err(
                "PARAM_OUT_OF_RANGE",
                &vp,
                format!("{v} is outside [{}, {}]", fmt_opt(lo), fmt_opt(hi)),
                json!({ "name": name, "value": v, "min": lo, "max": hi }),
            );
        }
    }

    fn part(&mut self, pi: usize, part: &'a PartStudio) {
        let pp = format!("/parts/{pi}");
        if self.id(&part.id, &format!("{pp}/id")) && !self.part_ids.insert(&part.id) {
            self.err(
                "DUPLICATE_ID",
                format!("{pp}/id"),
                format!("part id {:?}", part.id),
                json!({ "id": part.id }),
            );
        }
        if let Err(p) = ids::check_id(&part.name) {
            let path = format!("{pp}/name");
            self.err(
                "INVALID_NAME",
                &path,
                format!(
                    "part names must match [A-Za-z_][A-Za-z0-9_]* with at most {} bytes ({})",
                    ids::MAX_ID_LEN,
                    p.as_str()
                ),
                json!({ "path": path, "reason": p.as_str(), "length": part.name.len() }),
            );
        } else if !self.part_names.insert(&part.name) {
            self.err(
                "DUPLICATE_NAME",
                format!("{pp}/name"),
                format!("part {:?}", part.name),
                json!({ "name": part.name }),
            );
        }
        for (i, p) in part.params.iter().enumerate() {
            self.param(p, &format!("{pp}/params/{i}"));
        }
        let mut ctx = PartCtx::default();
        for (fi, f) in part.features.iter().enumerate() {
            let fp = format!("{pp}/features/{fi}");
            self.feature(f, &fp, &mut ctx);
            let info = FeatInfo {
                ty: f.type_name(),
                sketch: match f {
                    Feature::Extrude(e) => Some(e.sketch.clone()),
                    Feature::Revolve(r) => Some(r.sketch.clone()),
                    _ => None,
                },
                tag_kind: match f {
                    Feature::Tag(t) => Some(t.target.kind),
                    _ => None,
                },
            };
            if let Feature::Sketch(s) = f {
                ctx.sketches.insert(s.id.clone(), sketch_info(s));
            }
            ctx.earlier.entry(f.id().to_string()).or_insert(info);
        }
    }

    fn feature(&mut self, f: &'a Feature, fp: &str, ctx: &mut PartCtx) {
        if self.id(f.id(), &format!("{fp}/id")) && !self.feature_ids.insert(f.id()) {
            self.err(
                "DUPLICATE_ID",
                format!("{fp}/id"),
                format!("feature id {:?}", f.id()),
                json!({ "id": f.id() }),
            );
        }
        self.name(f.name(), &format!("{fp}/name"), crate::RESERVED_NAMES);
        let ty = f.type_name();
        if !super::features::defined_versions(ty).contains(&f.v()) {
            self.err(
                "UNSUPPORTED_FEATURE_VERSION",
                format!("{fp}/v"),
                format!("{ty} v{} is not implemented", f.v()),
                json!({ "type": ty, "v": f.v(), "supported": super::features::defined_versions(ty) }),
            );
        }
        if self.opts.unsupported_features.contains(&ty) {
            self.err(
                "UNSUPPORTED_FEATURE",
                format!("{fp}/type"),
                format!("this engine does not implement {ty:?}"),
                json!({ "type": ty }),
            );
        }
        match f {
            Feature::Sketch(s) => self.sketch(s, fp, ctx),
            Feature::Extrude(e) => {
                self.sketch_ref(&e.sketch, &format!("{fp}/sketch"), ctx);
                self.regions(&e.regions, &e.sketch, fp, ctx);
                if let Some(d) = e.distance.literal()
                    && d <= LINEAR_TOLERANCE
                {
                    self.range("INVALID_DISTANCE", fp, "distance", d, &tol());
                }
                self.body_op(e.op, e.targets.as_ref(), fp, ctx);
            }
            Feature::Revolve(r) => {
                self.sketch_ref(&r.sketch, &format!("{fp}/sketch"), ctx);
                self.regions(&r.regions, &r.sketch, fp, ctx);
                if let Some(a) = r.angle.literal()
                    && !(a > 0.0 && a <= 360.0)
                {
                    self.range("INVALID_ANGLE", fp, "angle", a, "in (0, 360]");
                }
                if let (Some(dx), Some(dy)) =
                    (r.axis.direction[0].literal(), r.axis.direction[1].literal())
                    && (dx * dx + dy * dy).sqrt() <= LINEAR_TOLERANCE
                {
                    self.err(
                        "INVALID_AXIS",
                        format!("{fp}/axis"),
                        "axis direction must be non-zero",
                        json!({ "field": "axis", "value": [dx, dy], "expected": "a non-zero direction" }),
                    );
                }
                self.body_op(r.op, r.targets.as_ref(), fp, ctx);
            }
            Feature::Boolean(b) => {
                self.check_ref(&b.targets, &format!("{fp}/targets"), BODY_SOME, ctx);
                self.check_ref(&b.tools, &format!("{fp}/tools"), BODY_SOME, ctx);
            }
            Feature::Hole(h) => self.hole(h, fp, ctx),
            Feature::Thread(t) => self.thread(t, fp, ctx),
            Feature::Fillet(fl) => {
                self.check_ref(&fl.edges, &format!("{fp}/edges"), EDGE_SOME, ctx);
                if let Some(r) = fl.r.literal()
                    && r <= LINEAR_TOLERANCE
                {
                    self.range("INVALID_RADIUS", fp, "r", r, &tol());
                }
            }
            Feature::Chamfer(c) => self.chamfer(c, fp, ctx),
            Feature::Shell(s) => {
                self.check_ref(&s.body, &format!("{fp}/body"), BODY_ONE, ctx);
                if let Some(o) = &s.open {
                    self.check_ref(o, &format!("{fp}/open"), FACE_ANY, ctx);
                }
                if let Some(t) = s.thickness.literal()
                    && t <= LINEAR_TOLERANCE
                {
                    self.range("INVALID_VALUE", fp, "thickness", t, &tol());
                }
            }
            Feature::Draft(d) => {
                self.check_ref(&d.faces, &format!("{fp}/faces"), FACE_SOME, ctx);
                self.plane(&d.neutral, &format!("{fp}/neutral"), ctx);
                if let Some(a) = d.angle.literal()
                    && !(a > 0.0 && a < 45.0)
                {
                    self.range("INVALID_VALUE", fp, "angle", a, "in (0, 45)");
                }
            }
            Feature::Pattern(p) => self.pattern(p, fp, ctx),
            Feature::DatumPlane(d) => self.datum_plane(d, fp, ctx),
            Feature::DatumAxis(d) => self.datum_axis(d, fp, ctx),
            Feature::Tag(t) => self.check_ref(&t.target, &format!("{fp}/target"), ANY_SOME, ctx),
        }
    }

    fn range(&mut self, code: &'static str, fp: &str, field: &str, value: f64, expected: &str) {
        self.err(
            code,
            format!("{fp}/{field}"),
            format!("{field} = {value}: must be {expected}"),
            json!({ "field": field, "value": value, "expected": expected }),
        );
    }

    // ---- sketches --------------------------------------------------------------------------

    fn sketch(&mut self, s: &'a SketchFeature, fp: &str, ctx: &PartCtx) {
        self.plane(&s.plane, &format!("{fp}/plane"), ctx);
        if s.curves.is_empty() {
            self.err(
                "EMPTY_SKETCH",
                format!("{fp}/curves"),
                "a sketch needs at least one curve",
                json!({ "sketch": s.id }),
            );
        }
        let constrained = !s.constraints.is_empty();
        // Namespace: curve ids, derived solver ids, compound members, constraint ids (§0.3, §4.3).
        let mut ns: BTreeSet<String> = BTreeSet::new();
        let mut ents: BTreeMap<String, Ent> = BTreeMap::new();
        for (ci, c) in s.curves.iter().enumerate() {
            let cp = format!("{fp}/curves/{ci}");
            if !self.id(c.id(), &format!("{cp}/id")) {
                continue;
            }
            // One DUPLICATE_ID per curve: its own id or the first derived id that clashes.
            let mut clashed = false;
            for (eid, ent) in solver_entities(c) {
                if !ns.insert(eid.clone()) {
                    if !clashed {
                        self.err(
                            "DUPLICATE_ID",
                            format!("{cp}/id"),
                            format!(
                                "id {eid:?} (of curve {:?}) is already used in this sketch",
                                c.id()
                            ),
                            json!({ "id": eid }),
                        );
                    }
                    clashed = true;
                } else if let Some(ent) = ent {
                    ents.insert(eid, ent);
                }
            }
            self.curve(s, c, &cp, constrained);
        }
        for (k, con) in s.constraints.iter().enumerate() {
            let kp = format!("{fp}/constraints/{k}");
            if self.id(con.id(), &format!("{kp}/id")) && !ns.insert(con.id().to_string()) {
                self.err(
                    "DUPLICATE_ID",
                    format!("{kp}/id"),
                    format!(
                        "constraint id {:?} is already used in this sketch",
                        con.id()
                    ),
                    json!({ "id": con.id() }),
                );
            }
            self.constraint(con, &kp, &ents);
        }
    }

    fn curve(&mut self, s: &SketchFeature, c: &SketchCurve, cp: &str, constrained: bool) {
        if constrained {
            if c.is_compound() {
                self.err(
                    "SKETCH_MIXED_MODE",
                    cp,
                    format!("compound curve {:?} in a constrained sketch: use lines and constraints, or drop the constraints and drive the {} with parameters", c.id(), c.kind()),
                    json!({ "sketch": s.id, "path": cp }),
                );
            } else {
                let mut w = Walker::default();
                w.curve(
                    cp,
                    c,
                    SiteOwner::Feature {
                        part: 0,
                        index: 0,
                        id: String::new(),
                    },
                    ExprScope::Part(0),
                );
                for site in &w.exprs {
                    self.err(
                        "SKETCH_MIXED_MODE",
                        &site.path,
                        "a constrained sketch stores literal geometry only (the last solution); bind the value with a dimension constraint instead",
                        json!({ "sketch": s.id, "path": site.path }),
                    );
                }
            }
        }
        let degenerate = |this: &mut Self, reason: &str| {
            this.err(
                "DEGENERATE_CURVE",
                cp,
                reason.to_string(),
                json!({ "curve": c.id(), "reason": reason }),
            );
        };
        match c {
            SketchCurve::Line { start, end, .. } => {
                if let (Some(a), Some(b)) = (lit2(start), lit2(end))
                    && dist2(a, b) <= LINEAR_TOLERANCE
                {
                    degenerate(self, "zero-length line");
                }
            }
            SketchCurve::Arc {
                start, end, center, ..
            } => {
                if let (Some(a), Some(b), Some(m)) = (lit2(start), lit2(end), lit2(center)) {
                    let r0 = dist2(a, m);
                    let r1 = dist2(b, m);
                    if r0 <= LINEAR_TOLERANCE || r1 <= LINEAR_TOLERANCE {
                        degenerate(self, "zero-radius arc");
                    } else if !constrained && (r0 - r1).abs() > LINEAR_TOLERANCE {
                        self.err(
                            "INCONSISTENT_ARC",
                            cp,
                            format!("|start−center| = {r0} but |end−center| = {r1}"),
                            json!({ "curve": c.id(), "r_start": r0, "r_end": r1 }),
                        );
                    } else if dist2(a, b) <= LINEAR_TOLERANCE {
                        degenerate(self, "arc start == end; use a circle for a full turn");
                    }
                }
            }
            SketchCurve::Circle { radius, .. } => {
                if let Some(r) = radius.literal()
                    && r <= LINEAR_TOLERANCE
                {
                    degenerate(self, "circle radius must be > 0");
                }
            }
            SketchCurve::Point { .. } => {}
            SketchCurve::Rect {
                center,
                corner,
                w,
                h,
                r,
                ..
            } => {
                if center.is_some() == corner.is_some() {
                    self.err(
                        "CURVE_OPTIONS_CONFLICT",
                        cp,
                        "a rect needs exactly one of center / corner",
                        json!({ "curve": c.id(), "fields": ["center", "corner"] }),
                    );
                }
                self.positive_len(cp, "w", w);
                self.positive_len(cp, "h", h);
                if let Some(rv) = r.literal()
                    && rv < 0.0
                {
                    self.range("INVALID_VALUE", cp, "r", rv, ">= 0");
                } else if let (Some(wv), Some(hv), Some(rv)) =
                    (w.literal(), h.literal(), r.literal())
                    && wv > LINEAR_TOLERANCE
                    && hv > LINEAR_TOLERANCE
                    && rv > wv.min(hv) / 2.0
                {
                    self.range(
                        "INVALID_VALUE",
                        cp,
                        "r",
                        rv,
                        &format!("<= min(w, h)/2 = {}", wv.min(hv) / 2.0),
                    );
                }
            }
            SketchCurve::Slot { a, b, w, .. } => {
                self.positive_len(cp, "w", w);
                if let (Some(pa), Some(pb)) = (lit2(a), lit2(b))
                    && dist2(pa, pb) <= LINEAR_TOLERANCE
                {
                    self.range(
                        "INVALID_VALUE",
                        cp,
                        "b",
                        dist2(pa, pb),
                        &format!("|b − a| {}", tol()),
                    );
                }
            }
            SketchCurve::Polygon {
                n,
                circumradius,
                inradius,
                across_flats,
                side,
                ..
            } => {
                let sizes = [
                    ("circumradius", circumradius),
                    ("inradius", inradius),
                    ("across_flats", across_flats),
                    ("side", side),
                ];
                let given: Vec<_> = sizes.iter().filter(|(_, v)| v.is_some()).collect();
                if given.len() != 1 {
                    self.err(
                        "CURVE_OPTIONS_CONFLICT",
                        cp,
                        "a polygon needs exactly one of circumradius / inradius / across_flats / side",
                        json!({ "curve": c.id(), "fields": ["circumradius", "inradius", "across_flats", "side"] }),
                    );
                }
                for (field, v) in sizes {
                    if let Some(v) = v {
                        self.positive_len(cp, field, v);
                    }
                }
                if let Some(nv) = n.literal()
                    && is_count(nv)
                    && nv < 3.0
                {
                    self.range("INVALID_COUNT", cp, "n", nv, ">= 3");
                }
            }
        }
    }

    fn positive_len(&mut self, cp: &str, field: &str, v: &Scalar) {
        if let Some(x) = v.literal()
            && x <= LINEAR_TOLERANCE
        {
            self.range("INVALID_VALUE", cp, field, x, &tol());
        }
    }

    fn constraint(&mut self, con: &Constraint, kp: &str, ents: &BTreeMap<String, Ent>) {
        // The id itself is checked by the caller; never echo an invalid one ([W0-12]).
        let shown_id = ids::shown(con.id());
        let id = shown_id.as_str();
        if let Some((value, driving)) = con.dimension() {
            match (value, driving) {
                (None, true) => self.err(
                    "CONSTRAINT_VALUE_REQUIRED",
                    kp,
                    format!("driving dimension {id:?} needs a value"),
                    json!({ "constraint": id }),
                ),
                (Some(_), false) => self.err(
                    "CONSTRAINT_VALUE_ON_REFERENCE",
                    format!("{kp}/value"),
                    format!("reference dimension {id:?} must not have a value (it is measured)"),
                    json!({ "constraint": id }),
                ),
                (Some(v), true) => {
                    if let Some(x) = v.literal()
                        && con.type_name() != "angle"
                        && x <= 0.0
                    {
                        self.err(
                            "SKETCH_INVALID_DIMENSION",
                            format!("{kp}/value"),
                            format!("{} must be > 0, got {x}", con.type_name()),
                            json!({ "constraint": id, "value": x }),
                        );
                    }
                }
                (None, false) => {}
            }
        }
        let mut refs_ok = true;
        for (arg, id) in con.arguments() {
            refs_ok &= self.reference(id, &format!("{kp}/{arg}"));
        }
        if !refs_ok {
            return;
        }
        if let Err(e) = check_constraint_refs(con, ents) {
            let arg_path = |arg: &str| format!("{kp}/{arg}");
            match e {
                SolveErr::Unknown { arg, reference } => self.err(
                    "SKETCH_UNKNOWN_REFERENCE",
                    arg_path(arg),
                    format!("`{id}` references unknown entity `{reference}`"),
                    json!({ "owner": id, "reference": reference }),
                ),
                SolveErr::Wrong { arg, reference, expected, found } => self.err(
                    "SKETCH_WRONG_ENTITY_TYPE",
                    arg_path(arg),
                    format!("`{id}` expects {expected} for `{reference}`, found {found}"),
                    json!({ "owner": id, "reference": reference, "expected": expected, "found": found }),
                ),
                SolveErr::Combination { kind, a, b } => self.err(
                    "SKETCH_UNSUPPORTED_COMBINATION",
                    kp,
                    format!("`{id}`: unsupported {kind} between {a} and {b}"),
                    json!({ "id": id, "kind": kind, "a": a, "b": b }),
                ),
                SolveErr::SelfRef { arg, reference } => self.err(
                    "SKETCH_SELF_REFERENCE",
                    arg_path(arg),
                    format!("`{id}` references `{reference}` twice"),
                    json!({ "id": id, "reference": reference }),
                ),
            }
        }
    }

    fn sketch_ref(&mut self, sketch: &str, path: &str, ctx: &PartCtx) {
        if !self.reference(sketch, path) {
            return;
        }
        if !matches!(ctx.earlier.get(sketch), Some(f) if f.ty == "sketch") {
            self.err(
                "UNRESOLVED_SKETCH",
                path,
                format!(
                    "{sketch:?} is not the id of an earlier sketch feature in this part studio"
                ),
                json!({ "sketch": sketch }),
            );
        }
    }

    fn regions(&mut self, regions: &RegionSelection, sketch: &str, fp: &str, ctx: &PartCtx) {
        let RegionSelection::Curves(ids) = regions else {
            return;
        };
        if ids.is_empty() {
            self.err(
                "INVALID_VALUE",
                format!("{fp}/regions"),
                "regions must be \"all\" or a non-empty list of curve ids",
                json!({ "field": "regions", "value": [], "expected": "\"all\" or a non-empty list" }),
            );
        }
        for (k, id) in ids.iter().enumerate() {
            let rp = format!("{fp}/regions/{k}");
            if self.reference(id, &rp)
                && ids::is_ref(sketch)
                && let Some(info) = ctx.sketches.get(sketch)
                && info.class(id).is_none()
            {
                self.unknown_curve(&rp, sketch, id, info);
            }
        }
    }

    fn unknown_curve(&mut self, path: &str, feature: &str, curve: &str, info: &SketchInfo) {
        let similar: Vec<&String> = info
            .profile
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

    fn body_op(&mut self, op: BodyOp, targets: Option<&Targets>, fp: &str, ctx: &PartCtx) {
        match (op, targets) {
            (BodyOp::NewBody, Some(_)) => self.err(
                "INVALID_VALUE",
                format!("{fp}/targets"),
                "targets are only used when op is join, cut or intersect",
                json!({ "field": "targets", "value": null, "expected": "absent when op is new_body" }),
            ),
            (BodyOp::NewBody, None) => {}
            (_, None) => self.err(
                "BOOLEAN_TARGETS_REQUIRED",
                format!("{fp}/targets"),
                "join/cut/intersect need explicit targets (\"all\" or a body reference)",
                json!({ "feature": fp }),
            ),
            (_, Some(t)) => self.targets(t, &format!("{fp}/targets"), ctx),
        }
    }

    fn targets(&mut self, t: &Targets, path: &str, ctx: &PartCtx) {
        if let Targets::Ref(r) = t {
            self.check_ref(r, path, BODY_SOME, ctx);
        }
    }

    // ---- planes, axes, points, directions ----------------------------------------------------

    fn plane(&mut self, p: &PlaneRef, path: &str, ctx: &PartCtx) {
        match p {
            PlaneRef::Named(_) => {}
            PlaneRef::Frame(f) => self.frame(&f.origin, &f.normal, &f.x_dir, path),
            PlaneRef::Face(f) => {
                self.check_ref(&f.face, &format!("{path}/face"), FACE_ONE, ctx);
                if let Some(x) = &f.x_dir {
                    self.nonzero(x, &format!("{path}/x_dir"), "INVALID_VALUE");
                }
            }
            PlaneRef::Datum(d) => {
                self.datum_ref(&d.datum, &format!("{path}/datum"), "datum_plane", ctx)
            }
        }
    }

    fn frame(&mut self, _origin: &SP3, normal: &SP3, x_dir: &SP3, path: &str) {
        let (Some(n), Some(x)) = (lit3(normal), lit3(x_dir)) else {
            return;
        };
        let (ln, lx) = (len3(n), len3(x));
        if ln <= LINEAR_TOLERANCE || lx <= LINEAR_TOLERANCE {
            self.err(
                "INVALID_PLANE",
                path,
                "degenerate frame",
                json!({ "field": path, "reason": "zero-length normal or x_dir" }),
            );
        } else {
            let dot = (n[0] * x[0] + n[1] * x[1] + n[2] * x[2]) / (ln * lx);
            if dot.abs() > 1e-9 {
                self.err(
                    "INVALID_PLANE",
                    path,
                    format!("normal and x_dir must be perpendicular (cos = {dot:e})"),
                    json!({ "field": path, "reason": "normal and x_dir are not perpendicular" }),
                );
            }
        }
    }

    fn nonzero(&mut self, v: &SP3, path: &str, code: &'static str) {
        if let Some(x) = lit3(v)
            && len3(x) <= LINEAR_TOLERANCE
        {
            self.err(
                code,
                path,
                "direction must be non-zero",
                json!({ "field": path, "value": x, "expected": "a non-zero vector" }),
            );
        }
    }

    fn datum_ref(&mut self, id: &str, path: &str, expected: &'static str, ctx: &PartCtx) {
        if !self.reference(id, path) {
            return;
        }
        if !matches!(ctx.earlier.get(id), Some(f) if f.ty == expected) {
            self.err(
                "UNRESOLVED_FEATURE",
                path,
                format!("{id:?} is not an earlier {expected} feature of this part studio"),
                json!({ "id": id, "field": path, "expected": expected }),
            );
        }
    }

    fn axis(&mut self, a: &AxisRef, path: &str, ctx: &PartCtx) {
        if let AxisRef::Object(o) = a {
            self.axis_object(o, path, ctx);
        }
    }

    fn axis_object(&mut self, o: &AxisObject, path: &str, ctx: &PartCtx) {
        match o {
            AxisObject::Edge(e) => self.check_ref(&e.edge, &format!("{path}/edge"), EDGE_ONE, ctx),
            AxisObject::Cylinder(c) => {
                self.check_ref(&c.cylinder, &format!("{path}/cylinder"), FACE_ONE, ctx)
            }
            AxisObject::Datum(d) => {
                self.datum_ref(&d.datum, &format!("{path}/datum"), "datum_axis", ctx)
            }
            AxisObject::Line(l) => self.nonzero(
                &l.line.direction,
                &format!("{path}/line/direction"),
                "INVALID_AXIS",
            ),
        }
    }

    fn point(&mut self, p: &PointRef, path: &str, ctx: &PartCtx) {
        if let PointRef::Vertex(v) = p {
            self.check_ref(&v.vertex, &format!("{path}/vertex"), VERTEX_ONE, ctx);
        }
    }

    fn dir(&mut self, d: &Dir, path: &str, ctx: &PartCtx) {
        match d {
            Dir::Name(_) => {}
            Dir::Vector(v) => self.nonzero(v, path, "INVALID_VALUE"),
            Dir::Axis(o) => self.axis_object(o, path, ctx),
        }
    }

    // ---- references and queries ---------------------------------------------------------------

    fn check_ref(&mut self, r: &Ref, path: &str, field: RefField, ctx: &PartCtx) {
        let qkind = self.query(&r.q, &format!("{path}/q"), ctx);
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
                format!(
                    "this field takes {} references, not {}",
                    expected.join(" or "),
                    r.kind.as_str()
                ),
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
                "this field designates exactly one entity; card must be \"one\"",
                json!({ "field": path, "allowed": ["one", 1] }),
            );
        }
        if let Some(Cardinality::Exactly(0)) = r.card {
            self.err(
                "INVALID_CARDINALITY",
                format!("{path}/card"),
                "card must be one, some, any or an integer >= 1",
                json!({ "field": path, "allowed": ["one", "some", "any", ">= 1"] }),
            );
        }
    }

    fn feature_of(
        &mut self,
        feature: &str,
        path: &str,
        allowed: &[&str],
        ctx: &PartCtx,
        qpath: &str,
    ) -> Option<&'static str> {
        let fpath = format!("{path}/feature");
        if !self.reference(feature, &fpath) {
            return None;
        }
        match ctx.earlier.get(feature) {
            None => {
                self.err(
                    "UNRESOLVED_FEATURE",
                    &fpath,
                    format!("{feature:?} is not the id of an earlier feature of this part studio"),
                    json!({ "id": feature, "field": fpath, "expected": allowed }),
                );
                None
            }
            Some(f) if !allowed.is_empty() && !allowed.contains(&f.ty) => {
                self.err(
                    "QUERY_INVALID",
                    &fpath,
                    format!(
                        "this query needs a {} feature, {feature:?} is a {}",
                        allowed.join(" or "),
                        f.ty
                    ),
                    json!({ "path": qpath, "expected": allowed, "found": f.ty }),
                );
                None
            }
            Some(f) => Some(f.ty),
        }
    }

    fn curve_of(
        &mut self,
        feature: &str,
        curve: &str,
        path: &str,
        ctx: &PartCtx,
    ) -> Option<CurveClass> {
        if !self.reference(curve, path) {
            return None;
        }
        let info = ctx.consumed_sketch(feature)?.clone();
        let class = info.class(curve);
        if class.is_none() {
            self.unknown_curve(path, feature, curve, &info);
        }
        class
    }

    fn query_invalid(&mut self, path: &str, expected: &str, found: &str, message: String) {
        self.err(
            "QUERY_INVALID",
            path,
            message,
            json!({ "path": path, "expected": expected, "found": found }),
        );
    }

    /// The static kind of a query (§5.4), or `None` after reporting an error.
    fn query(&mut self, q: &Query, path: &str, ctx: &PartCtx) -> Option<EntityKind> {
        use EntityKind::*;
        const SWEEPS: &[&str] = &["extrude", "revolve"];
        const BODY_ORIGINS: &[&str] = &["extrude", "revolve", "pattern"];
        const CREATORS: &[&str] = &[
            "extrude", "revolve", "boolean", "hole", "fillet", "chamfer", "shell", "draft",
            "pattern",
        ];
        match q {
            Query::Body { feature, member } => {
                let ty = self.feature_of(feature, path, BODY_ORIGINS, ctx, path);
                if let (Some("extrude" | "revolve"), Some(m)) = (ty, member) {
                    self.curve_of(feature, m, &format!("{path}/member"), ctx);
                }
                Some(Body)
            }
            Query::Bodies {} => Some(Body),
            Query::Cap {
                feature, member, ..
            } => {
                if self
                    .feature_of(feature, path, &["extrude"], ctx, path)
                    .is_some()
                    && let Some(m) = member
                {
                    self.curve_of(feature, m, &format!("{path}/member"), ctx);
                }
                Some(Face)
            }
            Query::Endcap {
                feature, member, ..
            } => {
                if self
                    .feature_of(feature, path, &["revolve"], ctx, path)
                    .is_some()
                    && let Some(m) = member
                {
                    self.curve_of(feature, m, &format!("{path}/member"), ctx);
                }
                Some(Face)
            }
            Query::Side { feature, curve } => {
                if self.feature_of(feature, path, SWEEPS, ctx, path).is_some() {
                    self.curve_of(feature, curve, &format!("{path}/curve"), ctx);
                }
                Some(Face)
            }
            Query::Sides { feature, member } => {
                if self.feature_of(feature, path, SWEEPS, ctx, path).is_some()
                    && let Some(m) = member
                {
                    self.curve_of(feature, m, &format!("{path}/member"), ctx);
                }
                Some(Face)
            }
            Query::EdgeAt { feature, curve, .. } => {
                if self.feature_of(feature, path, SWEEPS, ctx, path).is_some()
                    && self.curve_of(feature, curve, &format!("{path}/curve"), ctx)
                        == Some(CurveClass::Circle)
                {
                    self.query_invalid(
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
                    if let Some(k) = self.query(sub, &sp, ctx)
                        && k != Face
                    {
                        self.query_invalid(
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
                self.feature_of(feature, path, &["hole"], ctx, path);
                self.id(at, &format!("{path}/at"));
                Some(Face)
            }
            Query::Created { feature, role } => {
                self.feature_of(feature, path, CREATORS, ctx, path);
                if let Some(r) = role {
                    self.id(r, &format!("{path}/role"));
                }
                Some(Face)
            }
            Query::Instance { feature, index } => {
                self.feature_of(feature, path, &["pattern"], ctx, path);
                if index.is_empty() || index.len() > 2 {
                    self.query_invalid(
                        &format!("{path}/index"),
                        "[i] or [i, j]",
                        &format!("{} indices", index.len()),
                        "an instance index is [i] or [i, j]".into(),
                    );
                }
                Some(Face)
            }
            Query::Tagged { feature } => {
                self.feature_of(feature, path, &["tag"], ctx, path)?;
                ctx.earlier.get(feature.as_str()).and_then(|f| f.tag_kind)
            }
            Query::Faces { of } => self.nav(of, path, &[Body, Edge, Vertex], Face, ctx),
            Query::Edges { of } => self.nav(of, path, &[Body, Face, Vertex], Edge, ctx),
            Query::Vertices { of } => self.nav(of, path, &[Body, Face, Edge], Vertex, ctx),
            Query::Owner { of } => self.nav(of, path, &[Face, Edge, Vertex], Body, ctx),
            Query::Union { of } | Query::Intersect { of } => {
                if of.is_empty() {
                    self.query_invalid(
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
                    if let Some(k) = self.query(sub, &sp, ctx) {
                        match kind {
                            None => kind = Some(k),
                            Some(k0) if k0 != k => self.query_invalid(
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
                let ka = self.query(a, &format!("{path}/a"), ctx);
                let kb = self.query(b, &format!("{path}/b"), ctx);
                if let (Some(ka), Some(kb)) = (ka, kb)
                    && ka != kb
                {
                    self.query_invalid(
                        &format!("{path}/b"),
                        ka.as_str(),
                        kb.as_str(),
                        "minus operands must have one kind".into(),
                    );
                }
                ka
            }
            Query::Filter { of, pred } => {
                let k = self.query(of, &format!("{path}/of"), ctx)?;
                self.predicate(pred, k, &format!("{path}/where"), ctx);
                Some(k)
            }
            Query::Extreme { of, dir, .. } => {
                self.dir(dir, &format!("{path}/dir"), ctx);
                self.query(of, &format!("{path}/of"), ctx)
            }
            Query::Largest { of } | Query::Smallest { of } => {
                let k = self.query(of, &format!("{path}/of"), ctx)?;
                if k == Vertex {
                    self.query_invalid(
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
        ctx: &PartCtx,
    ) -> Option<EntityKind> {
        let sp = format!("{path}/of");
        if let Some(k) = self.query(of, &sp, ctx)
            && !from.contains(&k)
        {
            let expected: Vec<&str> = from.iter().map(|k| k.as_str()).collect();
            self.query_invalid(
                &sp,
                &expected.join(" or "),
                k.as_str(),
                format!("cannot navigate from {}s to {}s", k.as_str(), to.as_str()),
            );
        }
        Some(to)
    }

    fn predicate(&mut self, p: &Predicate, k: EntityKind, path: &str, ctx: &PartCtx) {
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
            self.query_invalid(
                path,
                expected,
                k.as_str(),
                format!("predicate {name:?} does not apply to {}s", k.as_str()),
            );
        }
        match p {
            Predicate::Normal(d) | Predicate::Parallel(d) | Predicate::Perpendicular(d) => {
                self.dir(d, &format!("{path}/{name}"), ctx);
            }
            Predicate::Convex(b) | Predicate::Concave(b) | Predicate::Smooth(b) if !*b => {
                self.query_invalid(
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
                    self.query_invalid(
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
                        self.range("INVALID_VALUE", &format!("{path}/radius"), f, x, ">= 0");
                    }
                }
            }
            _ => {}
        }
    }

    // ---- holes ------------------------------------------------------------------------------

    fn hole(&mut self, h: &HoleFeature, fp: &str, ctx: &PartCtx) {
        self.plane(&h.on, &format!("{fp}/on"), ctx);
        let conflict = |this: &mut Self, field: &str, allowed: Value, message: String| {
            this.err(
                "HOLE_OPTIONS_CONFLICT",
                format!("{fp}/{field}"),
                message,
                json!({ "field": field, "allowed": allowed }),
            );
        };
        let sizes: Vec<&str> = HoleSize::ALL.iter().map(|s| s.as_str()).collect();
        let thread_standard = match &h.thread {
            Some(Thread::Spec(ThreadSpec {
                standard: Some(s), ..
            })) => Some(s.as_str()),
            _ => None,
        };
        if h.size.is_none() && h.d.is_none() && thread_standard.is_none() {
            self.err(
                "HOLE_SIZE_REQUIRED",
                fp,
                "a hole needs a standard size (\"M3\", …) or an explicit diameter d",
                json!({ "field": "size", "allowed": sizes }),
            );
        }
        // Presets need a size, and a table row for it.
        let presets = [
            (
                "cbore",
                matches!(h.cbore, Some(Counterbore::Preset(_))),
                holes::Preset::Counterbore,
            ),
            (
                "csink",
                matches!(h.csink, Some(Countersink::Preset(_))),
                holes::Preset::Countersink,
            ),
            (
                "insert",
                matches!(h.insert, Some(Insert::Preset(_))),
                holes::Preset::Insert,
            ),
        ];
        for (field, is_preset, preset) in presets {
            if !is_preset {
                continue;
            }
            match h.size {
                None => conflict(
                    self,
                    field,
                    json!(sizes),
                    format!("the {field} preset needs a standard size"),
                ),
                Some(size) if holes::preset_dims(size, preset).is_none() => {
                    let covered: Vec<&str> = HoleSize::ALL
                        .iter()
                        .filter(|s| holes::preset_dims(**s, preset).is_some())
                        .map(|s| s.as_str())
                        .collect();
                    conflict(
                        self,
                        field,
                        json!(covered),
                        format!(
                            "the {field} preset has no table value for {}",
                            size.as_str()
                        ),
                    );
                }
                _ => {}
            }
        }
        let heads: Vec<&str> = [
            ("cbore", h.cbore.is_some()),
            ("csink", h.csink.is_some()),
            ("insert", h.insert.is_some()),
        ]
        .into_iter()
        .filter(|(_, p)| *p)
        .map(|(n, _)| n)
        .collect();
        if heads.len() > 1 {
            conflict(
                self,
                heads[1],
                json!(["cbore", "csink", "insert"]),
                format!(
                    "at most one of cbore, csink, insert (got {})",
                    heads.join(", ")
                ),
            );
        }
        let threaded = !matches!(h.thread, None | Some(Thread::Flag(false)));
        if threaded && h.insert.is_some() {
            conflict(
                self,
                "thread",
                json!(["thread", "insert"]),
                "thread excludes insert".into(),
            );
        }
        if threaded && matches!(h.fit, HoleFit::Close | HoleFit::Loose) {
            conflict(
                self,
                "fit",
                json!(["normal", "tap"]),
                "a threaded hole uses the tap drill; fit close/loose contradicts it".into(),
            );
        }
        if threaded
            && h.size.is_none()
            && thread_standard.is_none()
            && !matches!(
                &h.thread,
                Some(Thread::Spec(ThreadSpec { pitch: Some(_), .. }))
            )
        {
            conflict(
                self,
                "thread",
                json!({ "pitch": "required without size" }),
                "a thread without a standard size needs a pitch".into(),
            );
        }
        match (&h.depth, &h.insert) {
            (None, None) => self.err(
                "HOLE_DEPTH_REQUIRED",
                format!("{fp}/depth"),
                "depth is required: \"through\", { \"blind\": h } or { \"up_to\": face }",
                json!({ "field": "depth", "allowed": ["through", "blind", "up_to"] }),
            ),
            (Some(_), Some(_)) => conflict(
                self,
                "depth",
                json!(["insert"]),
                "an insert sets its own blind depth".into(),
            ),
            _ => {}
        }
        if !h.tip.is_default() && !matches!(h.depth, Some(HoleDepth::Blind(_))) {
            conflict(
                self,
                "tip",
                json!(["blind"]),
                "tip applies to blind holes only".into(),
            );
        }
        if let HoleTip::Angle(a) = &h.tip
            && let Some(x) = a.literal()
            && !(x > 0.0 && x < 180.0)
        {
            self.range("INVALID_VALUE", fp, "tip", x, "in (0, 180)");
        }
        if let Some(d) = &h.d {
            self.positive_len(fp, "d", d);
        }
        match &h.depth {
            Some(HoleDepth::Blind(b)) => self.positive_len(&format!("{fp}/depth"), "blind", b),
            Some(HoleDepth::UpTo(r)) => {
                self.check_ref(r, &format!("{fp}/depth/up_to"), FACE_ONE, ctx)
            }
            _ => {}
        }
        if let Some(Counterbore::Custom(c)) = &h.cbore {
            self.positive_len(&format!("{fp}/cbore"), "d", &c.d);
            self.positive_len(&format!("{fp}/cbore"), "depth", &c.depth);
        }
        if let Some(Countersink::Custom(c)) = &h.csink {
            self.positive_len(&format!("{fp}/csink"), "d", &c.d);
            if let Some(x) = c.angle.literal()
                && !(x > 0.0 && x < 180.0)
            {
                self.range(
                    "INVALID_VALUE",
                    &format!("{fp}/csink"),
                    "angle",
                    x,
                    "in (0, 180)",
                );
            }
        }
        if let Some(Insert::Custom(c)) = &h.insert {
            self.positive_len(&format!("{fp}/insert"), "d", &c.d);
            self.positive_len(&format!("{fp}/insert"), "depth", &c.depth);
        }
        if let Some(Thread::Spec(t)) = &h.thread {
            for (f, v) in [("pitch", &t.pitch), ("depth", &t.depth)] {
                if let Some(v) = v {
                    self.positive_len(&format!("{fp}/thread"), f, v);
                }
            }
            if let Some(s) = &t.standard {
                self.thread_standard(&format!("{fp}/thread/standard"), s);
            }
            self.thread_starts(&format!("{fp}/thread"), &t.starts);
            // A modelled thread needs its major diameter: a size or a standard.
            if !t.modeled.is_false() && h.size.is_none() && t.standard.is_none() {
                conflict(
                    self,
                    "thread",
                    json!({ "standard": "required for a modelled thread without size" }),
                    "a modelled thread needs a size or thread.standard (its major diameter)".into(),
                );
            }
        }
        self.placement(&h.at, &format!("{fp}/at"), ctx);
        let on_face = matches!(h.on, PlaneRef::Face(_));
        match &h.targets {
            Some(t) => self.targets(t, &format!("{fp}/targets"), ctx),
            None if !on_face => self.err(
                "BOOLEAN_TARGETS_REQUIRED",
                format!("{fp}/targets"),
                "a hole placed on a plane that is not a face needs explicit targets",
                json!({ "feature": fp }),
            ),
            None => {}
        }
    }

    /// A `THREAD_STANDARDS` designation (`THREAD_STANDARD_UNKNOWN` otherwise).
    fn thread_standard(&mut self, path: &str, s: &str) {
        if super::threads::thread_standard(s).is_none() {
            let known = super::threads::thread_designations();
            self.err(
                "THREAD_STANDARD_UNKNOWN",
                path,
                format!("{s:?} is not a thread designation of THREAD_STANDARDS"),
                json!({ "field": "standard", "value": s, "allowed": known }),
            );
        }
    }

    /// A literal `starts` is a count in `[1, 8]` (`INVALID_COUNT`).
    fn thread_starts(&mut self, fp: &str, starts: &Option<Scalar>) {
        if let Some(n) = starts.as_ref().and_then(Scalar::literal)
            && !(n.fract() == 0.0 && (1.0..=8.0).contains(&n))
        {
            self.range("INVALID_COUNT", fp, "starts", n, "an integer in [1, 8]");
        }
    }

    /// Thread feature (§6.13).
    fn thread(&mut self, t: &ThreadFeature, fp: &str, ctx: &PartCtx) {
        self.check_ref(&t.face, &format!("{fp}/face"), FACE_ONE, ctx);
        match &t.standard {
            Some(s) => self.thread_standard(&format!("{fp}/standard"), s),
            None if t.major.is_none() || t.pitch.is_none() => self.err(
                "THREAD_SIZE_REQUIRED",
                fp,
                "a thread needs a standard designation, or both major and pitch",
                json!({ "field": "standard", "allowed": ["standard", "major + pitch"] }),
            ),
            None => {}
        }
        for (f, v) in [
            ("major", &t.major),
            ("pitch", &t.pitch),
            ("length", &t.length),
        ] {
            if let Some(v) = v {
                self.positive_len(fp, f, v);
            }
        }
        if let Some(o) = t.offset.as_ref().and_then(Scalar::literal)
            && (o < 0.0 || o.is_nan())
        {
            self.range("INVALID_VALUE", fp, "offset", o, ">= 0");
        }
        self.thread_starts(fp, &t.starts);
    }

    fn placement(&mut self, at: &HolePlacement, ap: &str, ctx: &PartCtx) {
        match at {
            HolePlacement::Points(p) => {
                let sp = format!("{ap}/points");
                self.sketch_ref(&p.sketch, &format!("{sp}/sketch"), ctx);
                if let PointIds::Ids(ids) = &p.ids {
                    if ids.is_empty() {
                        self.range_json(
                            "INVALID_VALUE",
                            &format!("{sp}/ids"),
                            "ids",
                            json!([]),
                            "\"all\" or a non-empty list",
                        );
                    }
                    let info = ctx.sketches.get(&p.sketch).cloned();
                    let mut seen = BTreeSet::new();
                    for (k, id) in ids.iter().enumerate() {
                        let ip = format!("{sp}/ids/{k}");
                        if !self.reference(id, &ip) {
                            continue;
                        }
                        if !seen.insert(id) {
                            self.err(
                                "DUPLICATE_ID",
                                &ip,
                                format!("position {id:?} listed twice"),
                                json!({ "id": id }),
                            );
                        }
                        if let Some(info) = &info
                            && !info.points.contains(id)
                        {
                            let similar: Vec<&String> = info
                                .points
                                .iter()
                                .filter(|p| similar(p, id))
                                .take(5)
                                .collect();
                            self.err(
                                "QUERY_UNKNOWN_CURVE",
                                &ip,
                                format!(
                                    "{id:?} is not a point (or circle center) of sketch {:?}",
                                    p.sketch
                                ),
                                json!({ "feature": p.sketch, "curve": id, "similar": similar }),
                            );
                        }
                    }
                }
            }
            HolePlacement::List(list) => {
                if list.is_empty() {
                    self.range_json(
                        "INVALID_VALUE",
                        &format!("{ap}/list"),
                        "list",
                        json!([]),
                        "a non-empty list",
                    );
                }
                let mut seen = BTreeSet::new();
                for (k, p) in list.iter().enumerate() {
                    let ip = format!("{ap}/list/{k}/id");
                    if self.id(&p.id, &ip) && !seen.insert(&p.id) {
                        self.err(
                            "DUPLICATE_ID",
                            &ip,
                            format!("position id {:?}", p.id),
                            json!({ "id": p.id }),
                        );
                    }
                }
            }
            HolePlacement::Grid(g) => {
                let gp = format!("{ap}/grid");
                self.count_min(&gp, "nx", &g.nx, 1.0);
                self.count_min(&gp, "ny", &g.ny, 1.0);
            }
            HolePlacement::Circle(c) => {
                let cp = format!("{ap}/circle");
                self.count_min(&cp, "n", &c.n, 1.0);
                self.positive_len(&cp, "d", &c.d);
            }
        }
    }

    fn range_json(
        &mut self,
        code: &'static str,
        path: &str,
        field: &str,
        value: Value,
        expected: &str,
    ) {
        self.err(
            code,
            path,
            format!("{field}: must be {expected}"),
            json!({ "field": field, "value": value, "expected": expected }),
        );
    }

    fn count_min(&mut self, base: &str, field: &str, v: &Scalar, min: f64) {
        if let Some(x) = v.literal()
            && is_count(x)
            && x < min
        {
            self.range("INVALID_COUNT", base, field, x, &format!(">= {min}"));
        }
    }

    // ---- chamfer, pattern, datums ----------------------------------------------------------------

    fn chamfer(&mut self, c: &ChamferFeature, fp: &str, ctx: &PartCtx) {
        self.check_ref(&c.edges, &format!("{fp}/edges"), EDGE_SOME, ctx);
        let form_ok = matches!(
            (&c.d2, &c.angle, &c.side),
            (None, None, None) | (Some(_), None, Some(_)) | (None, Some(_), Some(_))
        );
        if !form_ok {
            self.err(
                "CHAMFER_OPTIONS_CONFLICT",
                fp,
                "a chamfer is { d }, { d, d2, side } or { d, angle, side }",
                json!({ "fields": ["d", "d2", "angle", "side"] }),
            );
        }
        self.positive_len(fp, "d", &c.d);
        if let Some(d2) = &c.d2 {
            self.positive_len(fp, "d2", d2);
        }
        if let Some(a) = c.angle.as_ref().and_then(Scalar::literal)
            && !(a > 0.0 && a < 90.0)
        {
            self.range("INVALID_VALUE", fp, "angle", a, "in (0, 90)");
        }
        if let Some(s) = &c.side {
            self.check_ref(s, &format!("{fp}/side"), FACE_ONE, ctx);
        }
    }

    fn pattern(&mut self, p: &PatternFeature, fp: &str, ctx: &PartCtx) {
        let feature_seeds = matches!(p.seed, PatternSeed::Features(_));
        match &p.seed {
            PatternSeed::Features(seeds) => {
                if seeds.is_empty() {
                    self.range_json(
                        "INVALID_VALUE",
                        &format!("{fp}/seed/features"),
                        "features",
                        json!([]),
                        "a non-empty list",
                    );
                }
                for (k, id) in seeds.iter().enumerate() {
                    let sp = format!("{fp}/seed/features/{k}");
                    if !self.reference(id, &sp) {
                        continue;
                    }
                    match ctx.earlier.get(id) {
                        None => self.err(
                            "UNRESOLVED_FEATURE",
                            &sp,
                            format!("{id:?} is not the id of an earlier feature of this part studio"),
                            json!({ "id": id, "field": sp, "expected": ["extrude", "revolve", "hole"] }),
                        ),
                        Some(f) if !["extrude", "revolve", "hole"].contains(&f.ty) => self.err(
                            "PATTERN_SEED_UNSUPPORTED",
                            &sp,
                            format!("a {} cannot be a pattern seed (extrude, revolve or hole)", f.ty),
                            json!({ "seed": id, "type": f.ty }),
                        ),
                        _ => {}
                    }
                }
            }
            PatternSeed::Bodies(r) => {
                self.check_ref(r, &format!("{fp}/seed/bodies"), BODY_SOME, ctx)
            }
        }
        let lp = format!("{fp}/layout");
        let mut two_d = false;
        let counts: (Option<f64>, Option<f64>);
        match &p.layout {
            PatternLayout::Linear(l) => {
                let ll = format!("{lp}/linear");
                self.dir(&l.dir, &format!("{ll}/dir"), ctx);
                self.count_min(&ll, "count", &l.count, 1.0);
                if let Some(s) = l.spacing.literal()
                    && s.abs() <= LINEAR_TOLERANCE
                {
                    self.range(
                        "INVALID_VALUE",
                        &ll,
                        "spacing",
                        s,
                        &format!("|spacing| {}", tol()),
                    );
                }
                if l.dir2.is_some() != l.spacing2.is_some()
                    || (l.count2.is_some() && l.dir2.is_none())
                {
                    self.err(
                        "PATTERN_OPTIONS_CONFLICT",
                        &ll,
                        "a second direction needs dir2 and spacing2 (count2 defaults to 1)",
                        json!({ "fields": ["dir2", "count2", "spacing2"] }),
                    );
                }
                if let Some(d2) = &l.dir2 {
                    two_d = true;
                    self.dir(d2, &format!("{ll}/dir2"), ctx);
                }
                if let Some(c2) = &l.count2 {
                    self.count_min(&ll, "count2", c2, 1.0);
                }
                if let Some(s) = l.spacing2.as_ref().and_then(Scalar::literal)
                    && s.abs() <= LINEAR_TOLERANCE
                {
                    self.range(
                        "INVALID_VALUE",
                        &ll,
                        "spacing2",
                        s,
                        &format!("|spacing2| {}", tol()),
                    );
                }
                counts = (
                    l.count.literal(),
                    l.count2.as_ref().map_or(Some(1.0), Scalar::literal),
                );
            }
            PatternLayout::Circular(c) => {
                let cp = format!("{lp}/circular");
                self.axis(&c.axis, &format!("{cp}/axis"), ctx);
                self.count_min(&cp, "count", &c.count, 2.0);
                if let Some(a) = c.angle.literal()
                    && !(a > 0.0 && a <= 360.0)
                {
                    self.range("INVALID_ANGLE", &cp, "angle", a, "in (0, 360]");
                }
                counts = (c.count.literal(), None);
            }
            PatternLayout::Mirror(m) => {
                self.plane(&m.plane, &format!("{lp}/mirror/plane"), ctx);
                counts = (Some(2.0), None);
            }
        }
        for (k, idx) in p.skip.iter().enumerate() {
            let sp = format!("{fp}/skip/{k}");
            let want = if two_d { 2 } else { 1 };
            let seed = idx.iter().all(|i| *i == 0);
            let out_of_range = idx
                .first()
                .zip(counts.0)
                .is_some_and(|(i, n)| f64::from(*i) >= n)
                || (two_d
                    && idx
                        .get(1)
                        .zip(counts.1)
                        .is_some_and(|(j, n)| f64::from(*j) >= n));
            if idx.len() != want || seed || out_of_range {
                self.range_json(
                    "INVALID_VALUE",
                    &sp,
                    "skip",
                    json!(idx),
                    if two_d {
                        "[i, j] of an existing non-seed instance"
                    } else {
                        "[i] of an existing non-seed instance"
                    },
                );
            }
        }
        match (feature_seeds, p.op, &p.targets) {
            (true, PatternOp::NewBody, None) => {}
            (true, _, _) => self.err(
                "PATTERN_OPTIONS_CONFLICT",
                fp,
                "op and targets apply to body seeds only; feature seeds re-apply their own operation",
                json!({ "fields": ["op", "targets"] }),
            ),
            (false, PatternOp::Join, None) => self.err(
                "BOOLEAN_TARGETS_REQUIRED",
                format!("{fp}/targets"),
                "a body pattern with op join needs targets",
                json!({ "feature": fp }),
            ),
            (false, PatternOp::NewBody, Some(_)) => self.err(
                "PATTERN_OPTIONS_CONFLICT",
                format!("{fp}/targets"),
                "targets are only used with op join",
                json!({ "fields": ["op", "targets"] }),
            ),
            (false, _, Some(t)) => self.targets(t, &format!("{fp}/targets"), ctx),
            (false, PatternOp::NewBody, None) => {}
        }
    }

    fn mode_fields(&mut self, fp: &str, mode: &str, present: &[(&str, bool)], required: &[&str]) {
        let missing: Vec<&str> = required
            .iter()
            .copied()
            .filter(|r| !present.iter().any(|(n, p)| n == r && *p))
            .collect();
        let unexpected: Vec<&str> = present
            .iter()
            .filter(|(n, p)| *p && !required.contains(n))
            .map(|(n, _)| *n)
            .collect();
        if !missing.is_empty() || !unexpected.is_empty() {
            self.err(
                "DATUM_OPTIONS_CONFLICT",
                fp,
                format!("mode {mode:?} takes {}; missing [{}], not allowed [{}]", required.join(", "), missing.join(", "), unexpected.join(", ")),
                json!({ "mode": mode, "fields": required, "missing": missing, "unexpected": unexpected }),
            );
        }
    }

    fn datum_plane(&mut self, d: &DatumPlaneFeature, fp: &str, ctx: &PartCtx) {
        let present = [
            ("from", d.from.is_some()),
            ("distance", d.distance.is_some()),
            ("axis", d.axis.is_some()),
            ("angle", d.angle.is_some()),
            ("a", d.a.is_some()),
            ("b", d.b.is_some()),
            ("points", d.points.is_some()),
            ("origin", d.origin.is_some()),
            ("normal", d.normal.is_some()),
            ("x_dir", d.x_dir.is_some()),
        ];
        let (mode, required): (&str, &[&str]) = match d.mode {
            DatumPlaneMode::Offset => ("offset", &["from", "distance"]),
            DatumPlaneMode::Angle => ("angle", &["from", "axis", "angle"]),
            DatumPlaneMode::Midplane => ("midplane", &["a", "b"]),
            DatumPlaneMode::Through => ("through", &["points"]),
            DatumPlaneMode::Frame => ("frame", &["origin", "normal", "x_dir"]),
        };
        self.mode_fields(fp, mode, &present, required);
        for (field, p) in [("from", &d.from), ("a", &d.a), ("b", &d.b)] {
            if let Some(p) = p {
                self.plane(p, &format!("{fp}/{field}"), ctx);
            }
        }
        if let Some(a) = &d.axis {
            self.axis(a, &format!("{fp}/axis"), ctx);
        }
        if let Some(pts) = &d.points {
            for (k, p) in pts.iter().enumerate() {
                self.point(p, &format!("{fp}/points/{k}"), ctx);
            }
        }
        if let (Some(o), Some(n), Some(x)) = (&d.origin, &d.normal, &d.x_dir) {
            self.frame(o, n, x, fp);
        }
    }

    fn datum_axis(&mut self, d: &DatumAxisFeature, fp: &str, ctx: &PartCtx) {
        let present = [
            ("edge", d.edge.is_some()),
            ("face", d.face.is_some()),
            ("a", d.a.is_some()),
            ("b", d.b.is_some()),
            ("points", d.points.is_some()),
        ];
        let (mode, required): (&str, &[&str]) = match d.mode {
            DatumAxisMode::Edge => ("edge", &["edge"]),
            DatumAxisMode::Cylinder => ("cylinder", &["face"]),
            DatumAxisMode::Planes => ("planes", &["a", "b"]),
            DatumAxisMode::Points => ("points", &["points"]),
        };
        self.mode_fields(fp, mode, &present, required);
        if let Some(e) = &d.edge {
            self.check_ref(e, &format!("{fp}/edge"), EDGE_ONE, ctx);
        }
        if let Some(f) = &d.face {
            self.check_ref(f, &format!("{fp}/face"), FACE_ONE, ctx);
        }
        for (field, p) in [("a", &d.a), ("b", &d.b)] {
            if let Some(p) = p {
                self.plane(p, &format!("{fp}/{field}"), ctx);
            }
        }
        if let Some(pts) = &d.points {
            for (k, p) in pts.iter().enumerate() {
                self.point(p, &format!("{fp}/points/{k}"), ctx);
            }
        }
    }
}

impl Parameter {
    fn value_json(&self) -> Value {
        serde_json::to_value(&self.value).unwrap_or(Value::Null)
    }
}

fn fmt_opt(v: Option<f64>) -> String {
    v.map_or_else(|| "-inf/inf".into(), |x| x.to_string())
}

/// A cheap "did you mean" (shared prefix of 3+ bytes, or one edit on short ids).
fn similar(candidate: &str, wanted: &str) -> bool {
    let common = candidate
        .bytes()
        .zip(wanted.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    common >= 3.min(wanted.len()).max(1) && candidate != wanted
}

// ---- sketch helpers ---------------------------------------------------------------------------

/// forge-solve entity types (§4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ent {
    Point,
    Line,
    Circle,
    Arc,
}

impl Ent {
    fn name(self) -> &'static str {
        match self {
            Ent::Point => "point",
            Ent::Line => "line",
            Ent::Circle => "circle",
            Ent::Arc => "arc",
        }
    }
}

/// The ids a curve puts in the sketch namespace, with their solver entity type (§4.3): the
/// curve and its derived points; compound curves contribute their members (and the members'
/// derived points), with no entity of their own.
fn solver_entities(c: &SketchCurve) -> Vec<(String, Option<Ent>)> {
    let id = c.id();
    let line = |id: &str| {
        vec![
            (id.to_string(), Some(Ent::Line)),
            (format!("{id}.start"), Some(Ent::Point)),
            (format!("{id}.end"), Some(Ent::Point)),
        ]
    };
    let arc = |id: &str| {
        vec![
            (id.to_string(), Some(Ent::Arc)),
            (format!("{id}.start"), Some(Ent::Point)),
            (format!("{id}.end"), Some(Ent::Point)),
            (format!("{id}.center"), Some(Ent::Point)),
        ]
    };
    match c {
        SketchCurve::Point { .. } => vec![(id.to_string(), Some(Ent::Point))],
        SketchCurve::Line { .. } => line(id),
        SketchCurve::Arc { .. } => arc(id),
        SketchCurve::Circle { .. } => vec![
            (id.to_string(), Some(Ent::Circle)),
            (format!("{id}.center"), Some(Ent::Point)),
        ],
        SketchCurve::Rect { .. } | SketchCurve::Slot { .. } | SketchCurve::Polygon { .. } => {
            let n = match c {
                SketchCurve::Polygon { n, .. } => n
                    .literal()
                    .filter(|v| is_count(*v) && *v <= 4096.0)
                    .map(|v| v as u32),
                _ => None,
            };
            let mut out = vec![(id.to_string(), None)];
            for m in compound::member_names(c.kind(), n) {
                let mid = format!("{id}.{m}");
                if m.starts_with("c_") || m.starts_with("cap_") {
                    out.extend(arc(&mid));
                } else {
                    out.extend(line(&mid));
                }
            }
            out
        }
    }
}

fn sketch_info(s: &SketchFeature) -> SketchInfo {
    let mut info = SketchInfo::default();
    for c in &s.curves {
        let id = c.id().to_string();
        match c {
            SketchCurve::Point { .. } => {
                info.points.insert(id.clone());
                info.point_curves.push(id);
            }
            SketchCurve::Circle { construction, .. } => {
                info.points.insert(format!("{id}.center"));
                if !construction {
                    info.profile.insert(id, CurveClass::Circle);
                }
            }
            _ if c.construction() => {}
            SketchCurve::Line { .. } => {
                info.profile.insert(id, CurveClass::Line);
            }
            SketchCurve::Arc { .. } => {
                info.profile.insert(id, CurveClass::Arc);
            }
            SketchCurve::Polygon { n, .. } if n.literal().is_none() => info.wild_polygons.push(id),
            SketchCurve::Rect { .. } | SketchCurve::Slot { .. } | SketchCurve::Polygon { .. } => {
                for (eid, ent) in solver_entities(c) {
                    match ent {
                        Some(Ent::Line) => {
                            info.profile.insert(eid, CurveClass::Line);
                        }
                        Some(Ent::Arc) => {
                            info.profile.insert(eid, CurveClass::Arc);
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    info
}

enum SolveErr {
    Unknown {
        arg: &'static str,
        reference: String,
    },
    Wrong {
        arg: &'static str,
        reference: String,
        expected: &'static str,
        found: &'static str,
    },
    Combination {
        kind: &'static str,
        a: &'static str,
        b: &'static str,
    },
    SelfRef {
        arg: &'static str,
        reference: String,
    },
}

/// forge-solve's reference checks (`system.rs::compile_constraint`), in its order, on the IR
/// argument ids as written ([W0-9]: welding never turns two ids into a self-reference).
fn check_constraint_refs(con: &Constraint, ents: &BTreeMap<String, Ent>) -> Result<(), SolveErr> {
    use Constraint as C;
    let ent = |arg: &'static str, id: &str| -> Result<Ent, SolveErr> {
        ents.get(id).copied().ok_or_else(|| SolveErr::Unknown {
            arg,
            reference: id.to_string(),
        })
    };
    let want = |arg: &'static str,
                id: &str,
                ok: &[Ent],
                expected: &'static str|
     -> Result<Ent, SolveErr> {
        let e = ent(arg, id)?;
        if ok.contains(&e) {
            Ok(e)
        } else {
            Err(SolveErr::Wrong {
                arg,
                reference: id.to_string(),
                expected,
                found: e.name(),
            })
        }
    };
    let point = |arg, id: &str| want(arg, id, &[Ent::Point], "point");
    let line = |arg, id: &str| want(arg, id, &[Ent::Line], "line");
    let curve = |arg, id: &str| want(arg, id, &[Ent::Circle, Ent::Arc], "circle or arc");
    let distinct = |a: &str, b: &str| -> Result<(), SolveErr> {
        if a == b {
            Err(SolveErr::SelfRef {
                arg: "b",
                reference: b.to_string(),
            })
        } else {
            Ok(())
        }
    };
    match con {
        C::Coincident { a, b, .. } => {
            distinct(a, b)?;
            point("a", a)?;
            point("b", b)?;
        }
        C::Horizontal { line: l, .. } | C::Vertical { line: l, .. } => {
            line("line", l)?;
        }
        C::Parallel { a, b, .. } | C::Perpendicular { a, b, .. } | C::Angle { a, b, .. } => {
            distinct(a, b)?;
            line("a", a)?;
            line("b", b)?;
        }
        C::Tangent { a, b, .. } => {
            distinct(a, b)?;
            let (ea, eb) = (ent("a", a)?, ent("b", b)?);
            let is_curve = |e: Ent| matches!(e, Ent::Circle | Ent::Arc);
            let ok = (ea == Ent::Line && is_curve(eb))
                || (is_curve(ea) && eb == Ent::Line)
                || (is_curve(ea) && is_curve(eb));
            if !ok {
                return Err(SolveErr::Combination {
                    kind: "tangent",
                    a: ea.name(),
                    b: eb.name(),
                });
            }
        }
        C::Equal { a, b, .. } => {
            distinct(a, b)?;
            let (ea, eb) = (ent("a", a)?, ent("b", b)?);
            let is_curve = |e: Ent| matches!(e, Ent::Circle | Ent::Arc);
            if !((ea == Ent::Line && eb == Ent::Line) || (is_curve(ea) && is_curve(eb))) {
                return Err(SolveErr::Combination {
                    kind: "equal",
                    a: ea.name(),
                    b: eb.name(),
                });
            }
        }
        C::Distance { a, b, .. } => {
            distinct(a, b)?;
            point("a", a)?;
            want("b", b, &[Ent::Point, Ent::Line], "point or line")?;
        }
        C::Radius { curve: c, .. } | C::Diameter { curve: c, .. } => {
            curve("curve", c)?;
        }
        C::PointOnLine {
            point: p, line: l, ..
        }
        | C::Midpoint {
            point: p, line: l, ..
        } => {
            point("point", p)?;
            line("line", l)?;
        }
        C::PointOnCircle {
            point: p, curve: c, ..
        } => {
            point("point", p)?;
            curve("curve", c)?;
        }
        C::Symmetric { a, b, line: l, .. } => {
            distinct(a, b)?;
            point("a", a)?;
            point("b", b)?;
            line("line", l)?;
        }
        C::Fix { entity, x, y, .. } => match ent("entity", entity)? {
            Ent::Point => {}
            e @ (Ent::Line | Ent::Circle) if x.is_some() || y.is_some() => {
                return Err(SolveErr::Wrong {
                    arg: "entity",
                    reference: entity.clone(),
                    expected: "point (x/y targets)",
                    found: e.name(),
                });
            }
            Ent::Line | Ent::Circle => {}
            Ent::Arc => {
                return Err(SolveErr::Wrong {
                    arg: "entity",
                    reference: entity.clone(),
                    expected: "point, line or circle (fix an arc's points)",
                    found: "arc",
                });
            }
        },
    }
    Ok(())
}

fn lit2(p: &SP2) -> Option<[f64; 2]> {
    Some([p[0].literal()?, p[1].literal()?])
}

fn lit3(p: &SP3) -> Option<[f64; 3]> {
    Some([p[0].literal()?, p[1].literal()?, p[2].literal()?])
}

fn dist2(a: [f64; 2], b: [f64; 2]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

fn len3(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

/// Expand a compound curve whose fields are all literal (W0's conformance hook; W2 expands
/// evaluated values with [`compound::expand`] directly).
pub fn expand_literal(
    c: &SketchCurve,
) -> Option<Result<Vec<super::sketch::LiteralCurve>, compound::CompoundError>> {
    let comp = match c {
        SketchCurve::Rect {
            center,
            corner,
            w,
            h,
            r,
            ..
        } => Compound::Rect {
            center: match center {
                Some(p) => Some(lit2(p)?),
                None => None,
            },
            corner: match corner {
                Some(p) => Some(lit2(p)?),
                None => None,
            },
            w: w.literal()?,
            h: h.literal()?,
            r: r.literal()?,
        },
        SketchCurve::Slot { a, b, w, .. } => Compound::Slot {
            a: lit2(a)?,
            b: lit2(b)?,
            w: w.literal()?,
        },
        SketchCurve::Polygon {
            center,
            n,
            circumradius,
            inradius,
            across_flats,
            side,
            rotation,
            ..
        } => {
            let size = match (circumradius, inradius, across_flats, side) {
                (Some(v), None, None, None) => PolygonSize::Circumradius(v.literal()?),
                (None, Some(v), None, None) => PolygonSize::Inradius(v.literal()?),
                (None, None, Some(v), None) => PolygonSize::AcrossFlats(v.literal()?),
                (None, None, None, Some(v)) => PolygonSize::Side(v.literal()?),
                _ => return None,
            };
            Compound::Polygon {
                center: lit2(center)?,
                n: n.literal()?,
                size,
                rotation: rotation.literal()?,
            }
        }
        _ => return None,
    };
    Some(compound::expand(c.id(), &comp, c.construction()))
}

// ---- the site walker (shared with the W1 hook) --------------------------------------------------

/// Enumerates every Scalar of a document with its path, field type, scope and owner.
#[derive(Default)]
pub(crate) struct Walker<'a> {
    pub(crate) exprs: Vec<ExprSite<'a>>,
    pub(crate) literals: Vec<LiteralSite>,
    owner: Option<SiteOwner>,
    scope: Option<ExprScope>,
}

impl<'a> Walker<'a> {
    fn s(&mut self, path: String, v: &'a Scalar, field: FieldType) {
        let owner = self.owner.clone().expect("owner set");
        match v {
            Scalar::Num(x) => self.literals.push(LiteralSite {
                path,
                value: *x,
                field,
                owner,
            }),
            Scalar::Expr(e) => self.exprs.push(ExprSite {
                path,
                text: e,
                field,
                scope: self.scope.expect("scope set"),
                owner,
            }),
        }
    }
    fn b(&mut self, path: String, v: &'a BoolScalar) {
        if let BoolScalar::Expr(e) = v {
            self.exprs.push(ExprSite {
                path,
                text: e,
                field: FieldType::Bool,
                scope: self.scope.expect("scope set"),
                owner: self.owner.clone().expect("owner set"),
            });
        }
    }
    fn p2(&mut self, path: &str, v: &'a SP2, field: FieldType) {
        self.s(format!("{path}/0"), &v[0], field);
        self.s(format!("{path}/1"), &v[1], field);
    }
    fn p3(&mut self, path: &str, v: &'a SP3, field: FieldType) {
        for (i, s) in v.iter().enumerate() {
            self.s(format!("{path}/{i}"), s, field);
        }
    }
    fn opt(&mut self, path: String, v: &'a Option<Scalar>, field: FieldType) {
        if let Some(v) = v {
            self.s(path, v, field);
        }
    }

    pub(crate) fn walk_document(&mut self, doc: &'a Document) {
        for (i, p) in doc.params.iter().enumerate() {
            self.param(&format!("/params/{i}"), p, None, ExprScope::Document);
        }
        for (pi, part) in doc.parts.iter().enumerate() {
            for (i, p) in part.params.iter().enumerate() {
                self.param(
                    &format!("/parts/{pi}/params/{i}"),
                    p,
                    Some(pi),
                    ExprScope::Part(pi),
                );
            }
            for (fi, f) in part.features.iter().enumerate() {
                self.walk_feature(pi, part, f, fi);
            }
        }
    }

    fn param(&mut self, pp: &str, p: &'a Parameter, part: Option<usize>, scope: ExprScope) {
        self.owner = Some(SiteOwner::Param {
            part,
            name: p.name.clone(),
        });
        self.scope = Some(scope);
        let ft = p.unit.field_type();
        match &p.value {
            ParamValue::Num(x) => self.literals.push(LiteralSite {
                path: format!("{pp}/value"),
                value: *x,
                field: ft,
                owner: self.owner.clone().expect("owner set"),
            }),
            ParamValue::Expr(e) => self.exprs.push(ExprSite {
                path: format!("{pp}/value"),
                text: e,
                field: ft,
                scope,
                owner: self.owner.clone().expect("owner set"),
            }),
            ParamValue::Bool(_) => {}
        }
        if p.unit != ParamUnit::Bool {
            self.opt(format!("{pp}/min"), &p.min, ft);
            self.opt(format!("{pp}/max"), &p.max, ft);
        }
    }

    pub(crate) fn walk_feature(
        &mut self,
        pi: usize,
        _part: &'a PartStudio,
        f: &'a Feature,
        fi: usize,
    ) {
        use FieldType::*;
        let fp = format!("/parts/{pi}/features/{fi}");
        self.owner = Some(SiteOwner::Feature {
            part: pi,
            index: fi,
            id: f.id().to_string(),
        });
        self.scope = Some(ExprScope::Part(pi));
        self.b(format!("{fp}/suppressed"), f.suppressed());
        match f {
            Feature::Sketch(s) => {
                self.plane(&format!("{fp}/plane"), &s.plane);
                for (ci, c) in s.curves.iter().enumerate() {
                    self.curve_inner(&format!("{fp}/curves/{ci}"), c);
                }
                for (k, c) in s.constraints.iter().enumerate() {
                    let kp = format!("{fp}/constraints/{k}");
                    match c {
                        Constraint::Distance { value, .. }
                        | Constraint::Radius { value, .. }
                        | Constraint::Diameter { value, .. } => {
                            self.opt(format!("{kp}/value"), value, Length)
                        }
                        Constraint::Angle { value, .. } => {
                            self.opt(format!("{kp}/value"), value, Angle)
                        }
                        Constraint::Fix { x, y, .. } => {
                            self.opt(format!("{kp}/x"), x, Length);
                            self.opt(format!("{kp}/y"), y, Length);
                        }
                        _ => {}
                    }
                }
            }
            Feature::Extrude(e) => {
                self.s(format!("{fp}/distance"), &e.distance, Length);
                self.targets(&format!("{fp}/targets"), &e.targets);
            }
            Feature::Revolve(r) => {
                self.p2(&format!("{fp}/axis/origin"), &r.axis.origin, Length);
                self.p2(&format!("{fp}/axis/direction"), &r.axis.direction, Ratio);
                self.s(format!("{fp}/angle"), &r.angle, Angle);
                self.targets(&format!("{fp}/targets"), &r.targets);
            }
            Feature::Boolean(b) => {
                self.r(&format!("{fp}/targets"), &b.targets);
                self.r(&format!("{fp}/tools"), &b.tools);
                self.b(format!("{fp}/keep_tools"), &b.keep_tools);
            }
            Feature::Hole(h) => {
                self.plane(&format!("{fp}/on"), &h.on);
                self.b(format!("{fp}/flip"), &h.flip);
                match &h.at {
                    HolePlacement::Points(_) => {}
                    HolePlacement::List(l) => {
                        for (k, p) in l.iter().enumerate() {
                            self.p2(&format!("{fp}/at/list/{k}/at"), &p.at, Length);
                        }
                    }
                    HolePlacement::Grid(g) => {
                        let gp = format!("{fp}/at/grid");
                        self.s(format!("{gp}/nx"), &g.nx, Count);
                        self.s(format!("{gp}/ny"), &g.ny, Count);
                        self.s(format!("{gp}/dx"), &g.dx, Length);
                        self.s(format!("{gp}/dy"), &g.dy, Length);
                        self.p2(&format!("{gp}/center"), &g.center, Length);
                    }
                    HolePlacement::Circle(c) => {
                        let cp = format!("{fp}/at/circle");
                        self.s(format!("{cp}/n"), &c.n, Count);
                        self.s(format!("{cp}/d"), &c.d, Length);
                        self.p2(&format!("{cp}/center"), &c.center, Length);
                        self.s(format!("{cp}/start"), &c.start, Angle);
                    }
                }
                self.opt(format!("{fp}/d"), &h.d, Length);
                match &h.depth {
                    Some(HoleDepth::Blind(b)) => self.s(format!("{fp}/depth/blind"), b, Length),
                    Some(HoleDepth::UpTo(r)) => self.r(&format!("{fp}/depth/up_to"), r),
                    _ => {}
                }
                if let HoleTip::Angle(a) = &h.tip {
                    self.s(format!("{fp}/tip"), a, Angle);
                }
                if let Some(Counterbore::Custom(c)) = &h.cbore {
                    self.s(format!("{fp}/cbore/d"), &c.d, Length);
                    self.s(format!("{fp}/cbore/depth"), &c.depth, Length);
                }
                if let Some(Countersink::Custom(c)) = &h.csink {
                    self.s(format!("{fp}/csink/d"), &c.d, Length);
                    self.s(format!("{fp}/csink/angle"), &c.angle, Angle);
                }
                if let Some(Insert::Custom(c)) = &h.insert {
                    self.s(format!("{fp}/insert/d"), &c.d, Length);
                    self.s(format!("{fp}/insert/depth"), &c.depth, Length);
                }
                if let Some(Thread::Spec(t)) = &h.thread {
                    self.opt(format!("{fp}/thread/pitch"), &t.pitch, Length);
                    self.opt(format!("{fp}/thread/depth"), &t.depth, Length);
                    self.opt(format!("{fp}/thread/starts"), &t.starts, Count);
                    self.b(format!("{fp}/thread/modeled"), &t.modeled);
                }
                self.targets(&format!("{fp}/targets"), &h.targets);
            }
            Feature::Thread(t) => {
                self.r(&format!("{fp}/face"), &t.face);
                self.opt(format!("{fp}/major"), &t.major, Length);
                self.opt(format!("{fp}/pitch"), &t.pitch, Length);
                self.opt(format!("{fp}/length"), &t.length, Length);
                self.opt(format!("{fp}/offset"), &t.offset, Length);
                self.opt(format!("{fp}/starts"), &t.starts, Count);
                self.b(format!("{fp}/flip"), &t.flip);
                self.b(format!("{fp}/modeled"), &t.modeled);
            }
            Feature::Fillet(fl) => {
                self.r(&format!("{fp}/edges"), &fl.edges);
                self.s(format!("{fp}/r"), &fl.r, Length);
                self.b(format!("{fp}/tangent_chain"), &fl.tangent_chain);
            }
            Feature::Chamfer(c) => {
                self.r(&format!("{fp}/edges"), &c.edges);
                self.s(format!("{fp}/d"), &c.d, Length);
                self.opt(format!("{fp}/d2"), &c.d2, Length);
                self.opt(format!("{fp}/angle"), &c.angle, Angle);
                if let Some(s) = &c.side {
                    self.r(&format!("{fp}/side"), s);
                }
                self.b(format!("{fp}/tangent_chain"), &c.tangent_chain);
            }
            Feature::Shell(s) => {
                self.r(&format!("{fp}/body"), &s.body);
                if let Some(o) = &s.open {
                    self.r(&format!("{fp}/open"), o);
                }
                self.s(format!("{fp}/thickness"), &s.thickness, Length);
            }
            Feature::Draft(d) => {
                self.r(&format!("{fp}/faces"), &d.faces);
                self.plane(&format!("{fp}/neutral"), &d.neutral);
                self.s(format!("{fp}/angle"), &d.angle, Angle);
            }
            Feature::Pattern(p) => {
                if let PatternSeed::Bodies(r) = &p.seed {
                    self.r(&format!("{fp}/seed/bodies"), r);
                }
                match &p.layout {
                    PatternLayout::Linear(l) => {
                        let lp = format!("{fp}/layout/linear");
                        self.dir(&format!("{lp}/dir"), &l.dir);
                        self.s(format!("{lp}/count"), &l.count, Count);
                        self.s(format!("{lp}/spacing"), &l.spacing, Length);
                        if let Some(d) = &l.dir2 {
                            self.dir(&format!("{lp}/dir2"), d);
                        }
                        self.opt(format!("{lp}/count2"), &l.count2, Count);
                        self.opt(format!("{lp}/spacing2"), &l.spacing2, Length);
                    }
                    PatternLayout::Circular(c) => {
                        let cp = format!("{fp}/layout/circular");
                        self.axis(&format!("{cp}/axis"), &c.axis);
                        self.s(format!("{cp}/count"), &c.count, Count);
                        self.s(format!("{cp}/angle"), &c.angle, Angle);
                    }
                    PatternLayout::Mirror(m) => {
                        self.plane(&format!("{fp}/layout/mirror/plane"), &m.plane)
                    }
                }
                self.targets(&format!("{fp}/targets"), &p.targets);
            }
            Feature::DatumPlane(d) => {
                if let Some(p) = &d.from {
                    self.plane(&format!("{fp}/from"), p);
                }
                self.opt(format!("{fp}/distance"), &d.distance, Length);
                if let Some(a) = &d.axis {
                    self.axis(&format!("{fp}/axis"), a);
                }
                self.opt(format!("{fp}/angle"), &d.angle, Angle);
                if let Some(p) = &d.a {
                    self.plane(&format!("{fp}/a"), p);
                }
                if let Some(p) = &d.b {
                    self.plane(&format!("{fp}/b"), p);
                }
                if let Some(pts) = &d.points {
                    for (k, p) in pts.iter().enumerate() {
                        self.point(&format!("{fp}/points/{k}"), p);
                    }
                }
                if let Some(o) = &d.origin {
                    self.p3(&format!("{fp}/origin"), o, Length);
                }
                if let Some(n) = &d.normal {
                    self.p3(&format!("{fp}/normal"), n, Ratio);
                }
                if let Some(x) = &d.x_dir {
                    self.p3(&format!("{fp}/x_dir"), x, Ratio);
                }
            }
            Feature::DatumAxis(d) => {
                if let Some(e) = &d.edge {
                    self.r(&format!("{fp}/edge"), e);
                }
                if let Some(f) = &d.face {
                    self.r(&format!("{fp}/face"), f);
                }
                if let Some(p) = &d.a {
                    self.plane(&format!("{fp}/a"), p);
                }
                if let Some(p) = &d.b {
                    self.plane(&format!("{fp}/b"), p);
                }
                if let Some(pts) = &d.points {
                    for (k, p) in pts.iter().enumerate() {
                        self.point(&format!("{fp}/points/{k}"), p);
                    }
                }
                self.b(format!("{fp}/flip"), &d.flip);
            }
            Feature::Tag(t) => self.r(&format!("{fp}/target"), &t.target),
        }
    }

    /// Visit one curve's Scalars with an explicit owner/scope (used by the validator).
    pub(crate) fn curve(
        &mut self,
        cp: &str,
        c: &'a SketchCurve,
        owner: SiteOwner,
        scope: ExprScope,
    ) {
        self.owner = Some(owner);
        self.scope = Some(scope);
        self.curve_inner(cp, c);
    }

    fn curve_inner(&mut self, cp: &str, c: &'a SketchCurve) {
        use FieldType::*;
        match c {
            SketchCurve::Line { start, end, .. } => {
                self.p2(&format!("{cp}/start"), start, Length);
                self.p2(&format!("{cp}/end"), end, Length);
            }
            SketchCurve::Arc {
                start, end, center, ..
            } => {
                self.p2(&format!("{cp}/start"), start, Length);
                self.p2(&format!("{cp}/end"), end, Length);
                self.p2(&format!("{cp}/center"), center, Length);
            }
            SketchCurve::Circle { center, radius, .. } => {
                self.p2(&format!("{cp}/center"), center, Length);
                self.s(format!("{cp}/radius"), radius, Length);
            }
            SketchCurve::Point { at, .. } => self.p2(&format!("{cp}/at"), at, Length),
            SketchCurve::Rect {
                center,
                corner,
                w,
                h,
                r,
                ..
            } => {
                if let Some(p) = center {
                    self.p2(&format!("{cp}/center"), p, Length);
                }
                if let Some(p) = corner {
                    self.p2(&format!("{cp}/corner"), p, Length);
                }
                self.s(format!("{cp}/w"), w, Length);
                self.s(format!("{cp}/h"), h, Length);
                self.s(format!("{cp}/r"), r, Length);
            }
            SketchCurve::Slot { a, b, w, .. } => {
                self.p2(&format!("{cp}/a"), a, Length);
                self.p2(&format!("{cp}/b"), b, Length);
                self.s(format!("{cp}/w"), w, Length);
            }
            SketchCurve::Polygon {
                center,
                n,
                circumradius,
                inradius,
                across_flats,
                side,
                rotation,
                ..
            } => {
                self.p2(&format!("{cp}/center"), center, Length);
                self.s(format!("{cp}/n"), n, Count);
                self.opt(format!("{cp}/circumradius"), circumradius, Length);
                self.opt(format!("{cp}/inradius"), inradius, Length);
                self.opt(format!("{cp}/across_flats"), across_flats, Length);
                self.opt(format!("{cp}/side"), side, Length);
                self.s(format!("{cp}/rotation"), rotation, Angle);
            }
        }
    }

    fn targets(&mut self, path: &str, t: &'a Option<Targets>) {
        if let Some(Targets::Ref(r)) = t {
            self.r(path, r);
        }
    }

    fn plane(&mut self, path: &str, p: &'a PlaneRef) {
        use FieldType::*;
        match p {
            PlaneRef::Named(_) | PlaneRef::Datum(_) => {}
            PlaneRef::Frame(f) => {
                self.p3(&format!("{path}/origin"), &f.origin, Length);
                self.p3(&format!("{path}/normal"), &f.normal, Ratio);
                self.p3(&format!("{path}/x_dir"), &f.x_dir, Ratio);
            }
            PlaneRef::Face(f) => {
                self.r(&format!("{path}/face"), &f.face);
                if let Some(o) = &f.origin {
                    self.p3(&format!("{path}/origin"), o, Length);
                }
                if let Some(x) = &f.x_dir {
                    self.p3(&format!("{path}/x_dir"), x, Ratio);
                }
            }
        }
    }

    fn axis(&mut self, path: &str, a: &'a AxisRef) {
        if let AxisRef::Object(o) = a {
            self.axis_object(path, o);
        }
    }

    fn axis_object(&mut self, path: &str, o: &'a AxisObject) {
        match o {
            AxisObject::Edge(e) => self.r(&format!("{path}/edge"), &e.edge),
            AxisObject::Cylinder(c) => self.r(&format!("{path}/cylinder"), &c.cylinder),
            AxisObject::Datum(_) => {}
            AxisObject::Line(l) => {
                self.p3(
                    &format!("{path}/line/origin"),
                    &l.line.origin,
                    FieldType::Length,
                );
                self.p3(
                    &format!("{path}/line/direction"),
                    &l.line.direction,
                    FieldType::Ratio,
                );
            }
        }
        self.b(format!("{path}/flip"), o.flip());
    }

    fn point(&mut self, path: &str, p: &'a PointRef) {
        match p {
            PointRef::Point(v) => self.p3(path, v, FieldType::Length),
            PointRef::Vertex(v) => self.r(&format!("{path}/vertex"), &v.vertex),
        }
    }

    fn dir(&mut self, path: &str, d: &'a Dir) {
        match d {
            Dir::Name(_) => {}
            Dir::Vector(v) => self.p3(path, v, FieldType::Ratio),
            Dir::Axis(o) => self.axis_object(path, o),
        }
    }

    fn r(&mut self, path: &str, r: &'a Ref) {
        self.q(&format!("{path}/q"), &r.q);
    }

    fn q(&mut self, path: &str, q: &'a Query) {
        match q {
            Query::Between { a, b } | Query::Minus { a, b } => {
                self.q(&format!("{path}/a"), a);
                self.q(&format!("{path}/b"), b);
            }
            Query::Faces { of }
            | Query::Edges { of }
            | Query::Vertices { of }
            | Query::Owner { of }
            | Query::Largest { of }
            | Query::Smallest { of } => self.q(&format!("{path}/of"), of),
            Query::Union { of } | Query::Intersect { of } => {
                for (i, sub) in of.iter().enumerate() {
                    self.q(&format!("{path}/of/{i}"), sub);
                }
            }
            Query::Filter { of, pred } => {
                self.q(&format!("{path}/of"), of);
                let wp = format!("{path}/where");
                match pred {
                    Predicate::Normal(d) => self.dir(&format!("{wp}/normal"), d),
                    Predicate::Parallel(d) => self.dir(&format!("{wp}/parallel"), d),
                    Predicate::Perpendicular(d) => self.dir(&format!("{wp}/perpendicular"), d),
                    Predicate::Radius(rb) => {
                        self.opt(format!("{wp}/radius/eq"), &rb.eq, FieldType::Length);
                        self.opt(format!("{wp}/radius/min"), &rb.min, FieldType::Length);
                        self.opt(format!("{wp}/radius/max"), &rb.max, FieldType::Length);
                    }
                    _ => {}
                }
            }
            Query::Extreme { of, dir, .. } => {
                self.q(&format!("{path}/of"), of);
                self.dir(&format!("{path}/dir"), dir);
            }
            _ => {}
        }
    }
}
