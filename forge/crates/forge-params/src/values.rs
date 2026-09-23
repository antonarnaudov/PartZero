//! Document parameters (SPEC-v1 §2.1 [D-6], §2.8 [D-13], §7.1 step 1): evaluation in
//! dependency order, bounds, `PARAM_FAILED` propagation, and the values feature fields use.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use forge_ir::v1::expr::{
    Env, Expr, ExprScope, ParamGraph, ParamId, ParamScopes, check, feature_sites, parse,
    used_params,
};
use forge_ir::v1::metrics::{ParamOut, ParamReport, ReportError};
use forge_ir::v1::{
    BoolScalar, Document, FieldType, ParamUnit, ParamValue, Parameter, Scalar, ids,
};
use serde_json::{Map, Value as Json, json};

use crate::eval::{EvalError, Value, eval_at, is_count, no_neg_zero};

/// A coded failure of a parameter or a feature field (§7.4): `code`, `message`, `details`.
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
    pub details: Map<String, Json>,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>, details: Json) -> Failure {
        let details = match details {
            Json::Object(m) => m,
            _ => Map::new(),
        };
        Failure {
            code,
            message: message.into(),
            details,
        }
    }

    fn from_eval(e: EvalError) -> Failure {
        Failure {
            code: e.code,
            message: e.message,
            details: e.details,
        }
    }

    fn from_expr(e: forge_ir::v1::expr::ExprError) -> Failure {
        Failure::new(e.code, e.message, e.details)
    }

    /// `PARAM_FAILED` because parameter `param` failed with `code` (§2.8 rule 5). Forge always
    /// names the **root cause**: the parameter that failed on its own and its own code
    /// (`EXPR_DOMAIN`, `EXPR_NOT_INTEGER`, `PARAM_OUT_OF_RANGE`, or `PARAM_CYCLE` on a rejected
    /// document), never an intermediate `PARAM_FAILED` parameter — for `c = b + 1`,
    /// `b = a * 2` and a failed `a`, both `b` and `c` report `{ "param": "a", "code": … }`.
    /// (Rule 5 reads "every parameter and feature that uses *it* … details `{ param, code }`";
    /// the W7a oracle names the directly used parameter instead; flagged in the W1 report.)
    pub fn param_failed(param: &str, code: &str) -> Failure {
        Failure::new(
            "PARAM_FAILED",
            format!("uses parameter {param:?}, which failed with {code}"),
            json!({ "param": param, "code": code }),
        )
    }

    /// The report form (§7.4).
    pub fn report(&self) -> ReportError {
        ReportError {
            code: self.code.to_string(),
            message: self.message.clone(),
            details: self.details.clone(),
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Failure {}

/// One evaluated parameter.
#[derive(Debug, Clone, PartialEq)]
pub struct ParamEntry {
    pub id: ParamId,
    pub name: String,
    /// `"doc"` for document parameters, else the part's name (the report's `scope`).
    pub scope: String,
    pub unit: ParamUnit,
    pub result: Result<Value, Failure>,
}

impl ParamEntry {
    /// The root cause a user of this parameter reports in `PARAM_FAILED`: the parameter that
    /// failed on its own, and its code.
    fn root(&self) -> Option<(String, String)> {
        Some(root_of(&self.name, self.result.as_ref().err()?))
    }
}

/// Every parameter of a document, evaluated (interface I2: `evaluate(&Document) ->
/// ParamValues`), plus what feature fields need to evaluate their expressions.
#[derive(Debug, Clone)]
pub struct ParamValues {
    entries: Vec<ParamEntry>,
    index: BTreeMap<ParamId, usize>,
    scopes: ParamScopes,
    envs: BTreeMap<ExprScope, Env>,
    order: Vec<ParamId>,
}

/// Evaluate every parameter of `doc` (SPEC-v1 §2.8, §7.1 step 1). The document should have
/// passed validation with the W1 checker (`forge_ir::v1::expr::options()`); on a document
/// that did not, every problem still becomes a parameter failure, never a guessed value.
pub fn evaluate(doc: &Document) -> ParamValues {
    let scopes = ParamScopes::new(doc);
    let graph = ParamGraph::new(doc);
    let (order, blocked) = graph.order();
    let mut envs = BTreeMap::new();
    envs.insert(
        ExprScope::Document,
        Env::for_scope(doc, ExprScope::Document),
    );
    for pi in 0..doc.parts.len() {
        envs.insert(
            ExprScope::Part(pi),
            Env::for_scope(doc, ExprScope::Part(pi)),
        );
    }
    let mut pv = ParamValues {
        entries: Vec::new(),
        index: BTreeMap::new(),
        scopes,
        envs,
        order: order.clone(),
    };
    let mut results: BTreeMap<ParamId, Result<Value, Failure>> = BTreeMap::new();
    for &id in &order {
        let r = pv.eval_param(doc, &graph, id, &results);
        results.insert(id, r);
    }
    // Only a rejected document (PARAM_CYCLE) has blocked parameters.
    let cycles = graph.cycles();
    let on_cycle: BTreeMap<ParamId, &forge_ir::v1::expr::ParamCycle> = cycles
        .iter()
        .flat_map(|c| c.members.iter().map(move |m| (*m, c)))
        .collect();
    for &id in &blocked {
        let r = match on_cycle.get(&id) {
            Some(c) => {
                let names = c.names(doc);
                Err(Failure::new(
                    "PARAM_CYCLE",
                    format!("parameters depend on each other: {}", names.join(" -> ")),
                    json!({ "cycle": names }),
                ))
            }
            None => {
                let culprit = first_reachable(&graph, id, |q| on_cycle.contains_key(&q));
                let name = culprit
                    .and_then(|q| q.get(doc))
                    .map_or_else(String::new, |p| ids::shown(&p.name));
                Err(Failure::param_failed(&name, "PARAM_CYCLE"))
            }
        };
        results.insert(id, r);
    }
    for id in ParamId::all(doc) {
        let p = id.get(doc).expect("ParamId::all");
        let scope = match id.part {
            None => "doc".to_string(),
            Some(pi) => ids::shown(&doc.parts[pi].name),
        };
        pv.index.insert(id, pv.entries.len());
        pv.entries.push(ParamEntry {
            id,
            name: p.name.clone(),
            scope,
            unit: p.unit,
            result: results.remove(&id).expect("every parameter is evaluated"),
        });
    }
    pv
}

/// Breadth-first over dependencies (first-use order): the first parameter satisfying `hit`.
fn first_reachable(
    graph: &ParamGraph,
    from: ParamId,
    hit: impl Fn(ParamId) -> bool,
) -> Option<ParamId> {
    let mut seen = BTreeSet::from([from]);
    let mut queue = VecDeque::from([from]);
    while let Some(u) = queue.pop_front() {
        for &w in graph.dependencies(u) {
            if hit(w) {
                return Some(w);
            }
            if seen.insert(w) {
                queue.push_back(w);
            }
        }
    }
    None
}

impl ParamValues {
    fn eval_param(
        &self,
        doc: &Document,
        graph: &ParamGraph,
        id: ParamId,
        done: &BTreeMap<ParamId, Result<Value, Failure>>,
    ) -> Result<Value, Failure> {
        let p = id.get(doc).expect("ParamId::all");
        // 1. A failed dependency decides first (§2.8 rule 5).
        for &q in graph.dependencies(id) {
            if let Some(Err(f)) = done.get(&q) {
                let name = q.get(doc).map_or("", |qp| qp.name.as_str());
                let (root, code) = root_of(name, f);
                return Err(Failure::param_failed(&ids::shown(&root), &code));
            }
        }
        let scope = id.scope();
        let field = p.unit.field_type();
        let lookup = |name: &str| -> Option<Value> {
            let q = self.scopes.lookup(scope, name)?;
            done.get(&q)?.as_ref().ok().copied()
        };
        // 2. The value.
        let v = match &p.value {
            ParamValue::Num(x) => literal(p, *x)?,
            ParamValue::Bool(b) => {
                if p.unit != ParamUnit::Bool {
                    return Err(kind_mismatch(p, "bool"));
                }
                Value::Bool(*b)
            }
            ParamValue::Expr(t) => self.eval_text(scope, t, field, &lookup)?,
        };
        // 3. Bounds (never on bool parameters: rejected with PARAM_INVALID). A bound has the
        //    parameter's type (§2.1), so it is evaluated at the parameter's own field: a `count`
        //    parameter's expression bound must be an exact integer (`EXPR_NOT_INTEGER`, as a
        //    non-integer literal bound is rejected by validation). A bound that fails fails the
        //    parameter with the bound's error (its message names the bound).
        if let Value::Num(x) = v
            && p.unit != ParamUnit::Bool
        {
            let bound = |name: &str, b: &Option<Scalar>| -> Result<Option<f64>, Failure> {
                match b {
                    None => Ok(None),
                    Some(Scalar::Num(y)) => Ok(Some(no_neg_zero(*y))),
                    Some(Scalar::Expr(t)) => self
                        .eval_text(scope, t, field, &lookup)
                        .map(|v| v.as_num())
                        .map_err(|mut f| {
                            f.message = format!("bound `{name}`: {}", f.message);
                            f
                        }),
                }
            };
            let lo = bound("min", &p.min)?;
            let hi = bound("max", &p.max)?;
            if lo.is_some_and(|lo| x < lo) || hi.is_some_and(|hi| x > hi) {
                return Err(Failure::new(
                    "PARAM_OUT_OF_RANGE",
                    format!(
                        "{:?} = {} is outside [{}, {}]",
                        ids::shown(&p.name),
                        fmt(x),
                        lo.map_or("-inf".into(), fmt),
                        hi.map_or("inf".into(), fmt)
                    ),
                    json!({ "name": ids::shown(&p.name), "value": x, "min": lo, "max": hi }),
                ));
            }
        }
        Ok(v)
    }

    /// Parse, check and evaluate `text` in `scope` for a `field`, resolving parameters with
    /// `lookup`. A rejection (the document was not validated) is returned as a failure.
    fn eval_text(
        &self,
        scope: ExprScope,
        text: &str,
        field: FieldType,
        lookup: &dyn Fn(&str) -> Option<Value>,
    ) -> Result<Value, Failure> {
        let e = parse(text).map_err(|s| Failure::from_expr(s.to_error(text)))?;
        let env = self
            .envs
            .get(&scope)
            .ok_or_else(|| Failure::new("EXPR_SCOPE", "no such part", json!({})))?;
        check(&e, env, field).map_err(Failure::from_expr)?;
        eval_at(&e, lookup, field).map_err(Failure::from_eval)
    }

    /// Every parameter, document parameters first, then per part, in declaration order.
    pub fn entries(&self) -> &[ParamEntry] {
        &self.entries
    }

    /// The evaluation order used (§2.8 rule 3).
    pub fn order(&self) -> &[ParamId] {
        &self.order
    }

    pub fn get(&self, id: ParamId) -> Option<&ParamEntry> {
        self.entries.get(*self.index.get(&id)?)
    }

    /// The parameter `name` resolves to in `scope`.
    pub fn lookup(&self, scope: ExprScope, name: &str) -> Option<&ParamEntry> {
        self.get(self.scopes.lookup(scope, name)?)
    }

    /// `true` when every parameter evaluated.
    pub fn all_ok(&self) -> bool {
        self.entries.iter().all(|e| e.result.is_ok())
    }

    /// The report's `params` (§7.2): document parameters first, then per part.
    pub fn report(&self) -> Vec<ParamReport> {
        self.entries
            .iter()
            .map(|e| ParamReport {
                name: ids::shown(&e.name),
                scope: e.scope.clone(),
                unit: e.unit,
                value: e.result.as_ref().ok().map(|v| match *v {
                    Value::Num(x) => ParamOut::Num(no_neg_zero(x)),
                    Value::Bool(b) => ParamOut::Bool(b),
                }),
                error: e.result.as_ref().err().map(Failure::report),
            })
            .collect()
    }

    /// The first failed parameter `e` uses in `scope` (source order), as `PARAM_FAILED`.
    pub fn failed_use(&self, scope: ExprScope, e: &Expr) -> Option<Failure> {
        for q in used_params(e, &self.scopes, scope) {
            if let Some((root, code)) = self.get(q).and_then(ParamEntry::root) {
                return Some(Failure::param_failed(&ids::shown(&root), &code));
            }
        }
        None
    }

    /// Evaluate an expression text of a site in `scope` for a field of type `field`:
    /// `PARAM_FAILED` when it uses a failed parameter, then `EXPR_DOMAIN` /
    /// `EXPR_NOT_INTEGER` from evaluation (a rejection code if the text was never validated).
    pub fn eval_expr(
        &self,
        scope: ExprScope,
        text: &str,
        field: FieldType,
    ) -> Result<Value, Failure> {
        let e = parse(text).map_err(|s| Failure::from_expr(s.to_error(text)))?;
        if let Some(f) = self.failed_use(scope, &e) {
            return Err(f);
        }
        let lookup = |name: &str| -> Option<Value> {
            self.lookup(scope, name)?.result.as_ref().ok().copied()
        };
        self.eval_text(scope, text, field, &lookup)
    }

    /// A numeric field of part `part`: a literal is returned exactly as stored, `-0` included;
    /// an expression is evaluated, its `-0` becoming `+0` (the caller then applies the field's
    /// range check, §0.5 rule 2).
    ///
    /// Literals are exempt from §2.7 rule 8 on purpose: the rule is about the *results* of
    /// evaluation ("every result −0 is replaced by +0"), a literal feature field is passed to
    /// the feature bit for bit as in v0 (migrated v0 documents keep their exact inputs), and the
    /// W7a oracle does the same (`Params.scalar` returns `float(v)`). Literal *parameter* values
    /// are normalized, because they are reported (§7.2) and enter expressions as results.
    pub fn scalar(&self, part: usize, s: &Scalar, field: FieldType) -> Result<f64, Failure> {
        match s {
            Scalar::Num(x) => Ok(*x),
            Scalar::Expr(t) => self
                .eval_expr(ExprScope::Part(part), t, field)?
                .as_num()
                .ok_or_else(|| {
                    Failure::new(
                        "EXPR_TYPE_MISMATCH",
                        "a bool at a numeric field (the expression was not validated)",
                        json!({ "expr": t, "expected": field.unit_name(), "found": "bool" }),
                    )
                }),
        }
    }

    /// A boolean field of part `part` (`suppressed`, `flip`, `tangent_chain`, `keep_tools`).
    pub fn boolean(&self, part: usize, b: &BoolScalar) -> Result<bool, Failure> {
        match b {
            BoolScalar::Bool(v) => Ok(*v),
            BoolScalar::Expr(t) => self
                .eval_expr(ExprScope::Part(part), t, FieldType::Bool)?
                .as_bool()
                .ok_or_else(|| {
                    Failure::new(
                        "EXPR_TYPE_MISMATCH",
                        "a number at a bool field (the expression was not validated)",
                        json!({ "expr": t, "expected": "bool", "found": "number" }),
                    )
                }),
        }
    }

    /// `PARAM_FAILED` for feature `index` of part `part` if any of its expressions uses a
    /// failed parameter (§2.8 rule 5: decided before the feature runs; §7.1 step 2 checks it
    /// first). The first such site in field order decides.
    pub fn feature_failure(&self, doc: &Document, part: usize, index: usize) -> Option<Failure> {
        let p = doc.parts.get(part)?;
        let f = p.features.get(index)?;
        for s in feature_sites(part, p, f, index) {
            if let Ok(e) = parse(s.text)
                && let Some(fail) = self.failed_use(s.scope, &e)
            {
                return Some(fail);
            }
        }
        None
    }
}

/// The parameter that failed on its own behind failure `f` of parameter `name`, and its code.
fn root_of(name: &str, f: &Failure) -> (String, String) {
    if f.code == "PARAM_FAILED"
        && let (Some(p), Some(c)) = (
            f.details.get("param").and_then(Json::as_str),
            f.details.get("code").and_then(Json::as_str),
        )
    {
        return (p.to_string(), c.to_string());
    }
    (name.to_string(), f.code.to_string())
}

fn fmt(x: f64) -> String {
    forge_ir::v1::expr::format_number(x)
}

/// A literal parameter value, defensively re-checked (validation rejects these, with the same
/// codes and details as W0's literal checks: `EXPR_NOT_INTEGER` carries the literal number in
/// `expr`, as `forge_ir::v1::validate` does).
fn literal(p: &Parameter, x: f64) -> Result<Value, Failure> {
    if p.unit == ParamUnit::Bool {
        return Err(kind_mismatch(p, "number"));
    }
    if !x.is_finite() {
        return Err(Failure::new(
            "NON_FINITE",
            "literal values must be finite",
            json!({ "field": "value" }),
        ));
    }
    if p.unit == ParamUnit::Count && !is_count(x) {
        return Err(Failure::new(
            "EXPR_NOT_INTEGER",
            format!(
                "a count must be an exact integer with |v| <= 2^31, got {}",
                fmt(x)
            ),
            json!({ "expr": x, "value": x }),
        ));
    }
    Ok(Value::Num(no_neg_zero(x)))
}

/// A literal of the wrong kind (validation rejects it): the details of W0's literal check
/// (`expr`/`subexpr` are the literal itself, `expected` the parameter's type, `found` `bool` or
/// `number`).
fn kind_mismatch(p: &Parameter, found: &str) -> Failure {
    let expected = p.unit.field_type().unit_name();
    let literal = serde_json::to_value(&p.value).unwrap_or(Json::Null);
    Failure::new(
        "EXPR_TYPE_MISMATCH",
        format!("a {found} literal for a {expected} parameter"),
        json!({ "expr": literal, "subexpr": literal, "expected": expected, "found": found }),
    )
}
