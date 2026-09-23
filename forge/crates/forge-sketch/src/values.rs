//! Resolved expression values (the boundary with W1's evaluator, interface I2).
//!
//! Sketch evaluation never parses or evaluates expressions itself: SPEC-v1 §2.7 makes the
//! W1 evaluator the evaluator of record. The caller evaluates every expression site of the
//! sketch (a curve coordinate, a compound size, a dimension `value`, a `fix` target) and hands
//! the results in through a [`ValueSource`]; this crate reads them by **feature-relative JSON
//! pointer**, the same addressing as [`forge_ir::v1::expr::feature_sites`] with the
//! `/parts/<p>/features/<i>` prefix removed (`/curves/0/w`, `/curves/2/start/1`,
//! `/constraints/4/value`, `/constraints/5/x`).
//!
//! [`ResolvedValues`] is the plain map implementation; [`sketch_expr_sites`] lists the sites a
//! caller has to resolve, with their field types.

use std::collections::BTreeMap;

use forge_ir::v1::expr::ExprSite;
use forge_ir::v1::{Constraint, FieldType, SP2, Scalar, SketchCurve, SketchFeature};
use serde_json::{Map, Value};

/// Why an expression site has no value: the evaluation error W1 reported for it
/// (`EXPR_DOMAIN`, `EXPR_NOT_INTEGER`, `PARAM_FAILED`, …), with its structured details
/// (SPEC-v1 §7.4). Sketch evaluation fails with exactly this code and these details.
#[derive(Debug, Clone, PartialEq)]
pub struct ValueError {
    /// A code of the catalogue (`forge_ir::v1::codes`).
    pub code: String,
    /// For people.
    pub message: String,
    /// Structured details (never arena ids).
    pub details: Map<String, Value>,
}

impl ValueError {
    /// A value error with the given code, message and details.
    pub fn new(code: impl Into<String>, message: impl Into<String>, details: Value) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: match details {
                Value::Object(m) => m,
                _ => Map::new(),
            },
        }
    }
}

/// One expression site of a sketch feature.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SiteRef<'a> {
    /// Feature-relative JSON pointer, e.g. `/curves/0/w`.
    pub path: &'a str,
    /// The stored expression text.
    pub text: &'a str,
    /// The field type fixing the expression's use-site type (SPEC-v1 §2.5).
    pub field: FieldType,
}

/// Where sketch evaluation gets the value of an expression site.
///
/// Implementations MUST be deterministic. `None` means "no value was provided for this site",
/// which is an integration bug and fails the sketch loudly (`FORGE_INTERNAL`), never a
/// silent default.
pub trait ValueSource {
    /// The evaluated value of the expression at `site` (mm, degrees, or a plain number for
    /// `count`/`ratio` fields), or its evaluation error.
    fn value(&self, site: &SiteRef<'_>) -> Option<Result<f64, ValueError>>;
}

/// Evaluated expression values by feature-relative JSON pointer.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResolvedValues {
    values: BTreeMap<String, Result<f64, ValueError>>,
}

impl ResolvedValues {
    /// No values (enough for a sketch without expressions).
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the value (or evaluation error) of the site at `path`.
    pub fn insert(&mut self, path: impl Into<String>, value: Result<f64, ValueError>) {
        self.values.insert(path.into(), value);
    }

    /// Builder form of [`ResolvedValues::insert`] for a successful value.
    pub fn with(mut self, path: impl Into<String>, value: f64) -> Self {
        self.insert(path, Ok(value));
        self
    }

    /// The stored entry of `path`.
    pub fn get(&self, path: &str) -> Option<&Result<f64, ValueError>> {
        self.values.get(path)
    }

    /// Number of entries.
    pub fn len(&self) -> usize {
        self.values.len()
    }

    /// `true` when there are no entries.
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// Resolve every expression site of `sketch` with `eval` (typically W1's evaluator over
    /// the document's parameter values, in the sketch's part scope).
    pub fn resolve(
        sketch: &SketchFeature,
        mut eval: impl FnMut(&SiteRef<'_>) -> Result<f64, ValueError>,
    ) -> Self {
        let mut out = Self::new();
        for site in sketch_expr_sites(sketch) {
            let v = eval(&site.as_ref());
            out.insert(site.path, v);
        }
        out
    }

    /// Build from document-level expression sites ([`forge_ir::v1::expr::feature_sites`]):
    /// keeps the sites under `feature_pointer` (e.g. `/parts/0/features/3`), keyed by their
    /// path relative to it, evaluated with `eval`.
    pub fn from_document_sites<'a>(
        feature_pointer: &str,
        sites: impl IntoIterator<Item = &'a ExprSite<'a>>,
        mut eval: impl FnMut(&ExprSite<'a>) -> Result<f64, ValueError>,
    ) -> Self {
        let mut out = Self::new();
        for site in sites {
            if let Some(rel) = site.path.strip_prefix(feature_pointer)
                && rel.starts_with('/')
            {
                out.insert(rel, eval(site));
            }
        }
        out
    }

    /// Resolve the sites of `sketch` whose expression is a single parameter name or a plain
    /// number literal, from a map of parameter values (mm, degrees or plain numbers). Any
    /// other expression is left unresolved (and fails the sketch if evaluated). Intended for
    /// tests and tools that bind dimensions to parameters one-to-one; the general case goes
    /// through W1's evaluator and [`ResolvedValues::resolve`].
    pub fn from_params(sketch: &SketchFeature, params: &BTreeMap<String, f64>) -> Self {
        let mut out = Self::new();
        for site in sketch_expr_sites(sketch) {
            let t = site.text.trim_matches([' ', '\t']);
            if let Some(v) = params.get(t) {
                out.insert(site.path, Ok(*v));
            } else if let Ok(v) = t.parse::<f64>()
                && v.is_finite()
                && t.bytes().all(|b| b.is_ascii_digit() || b == b'.')
            {
                out.insert(site.path, Ok(v));
            }
        }
        out
    }
}

impl ValueSource for ResolvedValues {
    fn value(&self, site: &SiteRef<'_>) -> Option<Result<f64, ValueError>> {
        self.values.get(site.path).cloned()
    }
}

impl<F> ValueSource for F
where
    F: Fn(&SiteRef<'_>) -> Result<f64, ValueError>,
{
    fn value(&self, site: &SiteRef<'_>) -> Option<Result<f64, ValueError>> {
        Some(self(site))
    }
}

/// An owned expression site of a sketch feature (see [`sketch_expr_sites`]).
#[derive(Debug, Clone, PartialEq)]
pub struct OwnedSite<'a> {
    /// Feature-relative JSON pointer.
    pub path: String,
    /// The expression text.
    pub text: &'a str,
    /// The field type.
    pub field: FieldType,
}

impl<'a> OwnedSite<'a> {
    /// Borrowed view.
    pub fn as_ref(&self) -> SiteRef<'_> {
        SiteRef {
            path: &self.path,
            text: self.text,
            field: self.field,
        }
    }
}

/// Every expression site of a sketch's curves and constraints, in document order, with its
/// feature-relative path and field type: exactly the curve and constraint sites of
/// [`forge_ir::v1::expr::feature_sites`] (the plane and `suppressed` are the caller's).
pub fn sketch_expr_sites(sketch: &SketchFeature) -> Vec<OwnedSite<'_>> {
    use FieldType::{Angle, Count, Length};
    let mut out: Vec<OwnedSite<'_>> = Vec::new();
    fn s<'a>(out: &mut Vec<OwnedSite<'a>>, path: String, v: &'a Scalar, field: FieldType) {
        if let Scalar::Expr(text) = v {
            out.push(OwnedSite {
                path,
                text: text.as_str(),
                field,
            });
        }
    }
    fn p2<'a>(out: &mut Vec<OwnedSite<'a>>, path: &str, v: &'a SP2, field: FieldType) {
        s(out, format!("{path}/0"), &v[0], field);
        s(out, format!("{path}/1"), &v[1], field);
    }
    for (ci, c) in sketch.curves.iter().enumerate() {
        let cp = format!("/curves/{ci}");
        match c {
            SketchCurve::Line { start, end, .. } => {
                p2(&mut out, &format!("{cp}/start"), start, Length);
                p2(&mut out, &format!("{cp}/end"), end, Length);
            }
            SketchCurve::Arc {
                start, end, center, ..
            } => {
                p2(&mut out, &format!("{cp}/start"), start, Length);
                p2(&mut out, &format!("{cp}/end"), end, Length);
                p2(&mut out, &format!("{cp}/center"), center, Length);
            }
            SketchCurve::Circle { center, radius, .. } => {
                p2(&mut out, &format!("{cp}/center"), center, Length);
                s(&mut out, format!("{cp}/radius"), radius, Length);
            }
            SketchCurve::Point { at, .. } => p2(&mut out, &format!("{cp}/at"), at, Length),
            SketchCurve::Rect {
                center,
                corner,
                w,
                h,
                r,
                ..
            } => {
                if let Some(p) = center {
                    p2(&mut out, &format!("{cp}/center"), p, Length);
                }
                if let Some(p) = corner {
                    p2(&mut out, &format!("{cp}/corner"), p, Length);
                }
                s(&mut out, format!("{cp}/w"), w, Length);
                s(&mut out, format!("{cp}/h"), h, Length);
                s(&mut out, format!("{cp}/r"), r, Length);
            }
            SketchCurve::Slot { a, b, w, .. } => {
                p2(&mut out, &format!("{cp}/a"), a, Length);
                p2(&mut out, &format!("{cp}/b"), b, Length);
                s(&mut out, format!("{cp}/w"), w, Length);
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
                p2(&mut out, &format!("{cp}/center"), center, Length);
                s(&mut out, format!("{cp}/n"), n, Count);
                for (name, v) in [
                    ("circumradius", circumradius),
                    ("inradius", inradius),
                    ("across_flats", across_flats),
                    ("side", side),
                ] {
                    if let Some(v) = v {
                        s(&mut out, format!("{cp}/{name}"), v, Length);
                    }
                }
                s(&mut out, format!("{cp}/rotation"), rotation, Angle);
            }
        }
    }
    for (k, con) in sketch.constraints.iter().enumerate() {
        let kp = format!("/constraints/{k}");
        match con {
            Constraint::Distance { value: Some(v), .. }
            | Constraint::Radius { value: Some(v), .. }
            | Constraint::Diameter { value: Some(v), .. } => {
                s(&mut out, format!("{kp}/value"), v, Length)
            }
            Constraint::Angle { value: Some(v), .. } => {
                s(&mut out, format!("{kp}/value"), v, Angle)
            }
            Constraint::Fix { x, y, .. } => {
                if let Some(v) = x {
                    s(&mut out, format!("{kp}/x"), v, Length);
                }
                if let Some(v) = y {
                    s(&mut out, format!("{kp}/y"), v, Length);
                }
            }
            _ => {}
        }
    }
    out
}
