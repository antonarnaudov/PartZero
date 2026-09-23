//! W1's [`ExprValidator`]: every expression rejection of SPEC-v1 §0.5 rule 1, plus parameter
//! scope, dependency order and cycles (§2.8 [D-13]).

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde_json::json;

use super::types::{Env, check};
use super::{Expr, ExprScope, ExprSite, ExprValidator, parse};
use crate::v1::params::{ParamUnit, ParamValue, Parameter};
use crate::v1::scalar::Scalar;
use crate::v1::{Document, MAX_EXPR_BYTES, ValidateOptions, ValidationError, ids};

/// The W1 expression checker: the default `ValidateOptions::expr`, so every default entry point
/// (`v1::validate`, `v1::from_json`, `VersionedDocument::from_json`) runs it (SPEC-v1 §0.5
/// rule 4 step 5); `ValidateOptions { expr: None, .. }` opts out. Per site it returns at most one of
/// `EXPR_SYNTAX`, `EXPR_UNKNOWN_NAME`, `EXPR_SCOPE`, `EXPR_UNKNOWN_FUNCTION`, `EXPR_ARITY`,
/// `EXPR_TYPE_MISMATCH`, `EXPR_UNIT_MISMATCH`, and one `PARAM_CYCLE` per strongly connected
/// component of the dependency graph that has a cycle (not one per elementary cycle: `a` on
/// both `a -> b -> a` and `a -> c -> a` is one error), at the site of the component's first
/// parameter in declaration order (see [`ParamGraph::cycles`]).
#[derive(Debug, Default, Clone, Copy)]
pub struct ExprChecker;

/// The checker instance of `ValidateOptions::default()` and [`options`].
pub static CHECKER: ExprChecker = ExprChecker;

/// Validation options with the W1 checker: what a v1 engine loads documents with. Equal to
/// `ValidateOptions::default()` (kept so that call sites can say so explicitly).
pub fn options() -> ValidateOptions<'static> {
    ValidateOptions {
        expr: Some(&CHECKER),
        ..Default::default()
    }
}

impl ExprValidator for ExprChecker {
    fn validate_expressions(&self, doc: &Document, sites: &[ExprSite<'_>]) -> Vec<ValidationError> {
        let mut per_site: Vec<Vec<ValidationError>> = vec![Vec::new(); sites.len()];
        let mut envs: BTreeMap<ExprScope, Env> = BTreeMap::new();
        for (i, s) in sites.iter().enumerate() {
            // W0 already rejects these without a parser (EXPR_SYNTAX).
            if s.text.trim().is_empty() || s.text.len() > MAX_EXPR_BYTES {
                continue;
            }
            let e = match parse(s.text) {
                Ok(e) => e,
                Err(se) => {
                    per_site[i].push(se.to_error(s.text).at(&s.path));
                    continue;
                }
            };
            let env = envs
                .entry(s.scope)
                .or_insert_with(|| Env::for_scope(doc, s.scope));
            if let Err(err) = check(&e, env, s.field) {
                per_site[i].push(err.at(&s.path));
            }
        }
        let graph = ParamGraph::new(doc);
        let mut trailing = Vec::new();
        for c in graph.cycles() {
            let err = c.to_error(doc);
            match sites.iter().position(|s| s.path == c.path) {
                Some(i) => per_site[i].push(err),
                None => trailing.push(err),
            }
        }
        per_site.into_iter().flatten().chain(trailing).collect()
    }
}

// ---- parameters -------------------------------------------------------------------------------

/// A parameter's position: `part` is `None` for document parameters. The derived order is
/// declaration order with document parameters first (the tie-break of §2.8 rule 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ParamId {
    pub part: Option<usize>,
    pub index: usize,
}

impl ParamId {
    /// Every parameter of `doc`, in declaration order (document parameters first).
    pub fn all(doc: &Document) -> Vec<ParamId> {
        let doc_params = (0..doc.params.len()).map(|index| ParamId { part: None, index });
        let part_params = doc.parts.iter().enumerate().flat_map(|(pi, p)| {
            (0..p.params.len()).map(move |index| ParamId {
                part: Some(pi),
                index,
            })
        });
        doc_params.chain(part_params).collect()
    }

    /// The scope its own expressions are resolved in.
    pub fn scope(self) -> ExprScope {
        match self.part {
            None => ExprScope::Document,
            Some(p) => ExprScope::Part(p),
        }
    }

    /// The parameter itself.
    pub fn get(self, doc: &Document) -> Option<&Parameter> {
        match self.part {
            None => doc.params.get(self.index),
            Some(p) => doc.parts.get(p)?.params.get(self.index),
        }
    }

    /// Its JSON pointer (`/params/0`, `/parts/1/params/2`).
    pub fn path(self) -> String {
        match self.part {
            None => format!("/params/{}", self.index),
            Some(p) => format!("/parts/{p}/params/{}", self.index),
        }
    }
}

/// Which parameter an identifier names in each scope (§2.8 rules 1–2; the first declaration
/// of a duplicated name wins, as in [`Env::for_scope`]).
#[derive(Debug, Clone, Default)]
pub struct ParamScopes {
    doc: BTreeMap<String, ParamId>,
    parts: Vec<BTreeMap<String, ParamId>>,
}

impl ParamScopes {
    pub fn new(doc: &Document) -> ParamScopes {
        let mut d = BTreeMap::new();
        for (index, p) in doc.params.iter().enumerate() {
            d.entry(p.name.clone())
                .or_insert(ParamId { part: None, index });
        }
        let parts = doc
            .parts
            .iter()
            .enumerate()
            .map(|(pi, part)| {
                let mut m = d.clone();
                for (index, p) in part.params.iter().enumerate() {
                    m.entry(p.name.clone()).or_insert(ParamId {
                        part: Some(pi),
                        index,
                    });
                }
                m
            })
            .collect();
        ParamScopes { doc: d, parts }
    }

    /// The parameter `name` resolves to in `scope`, if visible.
    pub fn lookup(&self, scope: ExprScope, name: &str) -> Option<ParamId> {
        match scope {
            ExprScope::Document => self.doc.get(name).copied(),
            ExprScope::Part(p) => self.parts.get(p)?.get(name).copied(),
        }
    }
}

/// The expression fields of a parameter, in the order of its sites: `value`, `min`, `max`
/// (bounds only for non-`bool` parameters, as the site walker).
pub fn param_expressions(p: &Parameter) -> Vec<(&'static str, &str)> {
    let mut v = Vec::new();
    if let ParamValue::Expr(t) = &p.value {
        v.push(("value", t.as_str()));
    }
    if p.unit != ParamUnit::Bool {
        for (field, b) in [("min", &p.min), ("max", &p.max)] {
            if let Some(Scalar::Expr(t)) = b {
                v.push((field, t.as_str()));
            }
        }
    }
    v
}

/// The parameter dependency graph of §2.8 rule 3: parameter → the visible parameters its
/// `value`, `min` and `max` expressions use.
///
/// **Bounds are edges.** A bound that uses a parameter makes the bounded parameter depend on
/// it: its range check, and so its status (`PARAM_OUT_OF_RANGE`, §2.8 rule 5), needs that
/// value. So `a { value: 5, max: "b" }` with `b { value: "a * 2" }` is `PARAM_CYCLE`, and so is
/// `a { value: 10, min: "a - 1" }`. The SPEC does not say whether a bound "uses" a parameter;
/// the W7a oracle and the W8 TypeScript validator make the same choice (flagged for a SPEC
/// ruling). Every expression that parses contributes edges, whether or not it type-checks.
#[derive(Debug, Clone)]
pub struct ParamGraph {
    params: Vec<ParamId>,
    deps: BTreeMap<ParamId, Vec<ParamId>>,
    /// JSON pointer of the first site of `p` that uses `q`.
    edge_site: BTreeMap<(ParamId, ParamId), String>,
}

/// A dependency cycle (`PARAM_CYCLE`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParamCycle {
    /// The cycle, closed (`members[0] == members[last]`), starting at its first parameter in
    /// declaration order and following dependencies (shortest cycle through it).
    pub members: Vec<ParamId>,
    /// The site the error is reported at: the first member's field that uses the second.
    pub path: String,
}

impl ParamCycle {
    /// The member names, closed (`["a", "b", "a"]`).
    pub fn names(&self, doc: &Document) -> Vec<String> {
        self.members
            .iter()
            .map(|m| m.get(doc).map_or_else(String::new, |p| ids::shown(&p.name)))
            .collect()
    }

    pub fn to_error(&self, doc: &Document) -> ValidationError {
        let names = self.names(doc);
        ValidationError::new(
            "PARAM_CYCLE",
            &self.path,
            format!("parameters depend on each other: {}", names.join(" -> ")),
            json!({ "cycle": names }),
        )
    }
}

impl ParamGraph {
    /// Build the graph. Expressions that do not parse contribute no edges; identifiers that
    /// are not visible parameters (unknown names, other parts' parameters, `PI`) neither.
    pub fn new(doc: &Document) -> ParamGraph {
        let scopes = ParamScopes::new(doc);
        let params = ParamId::all(doc);
        let mut deps = BTreeMap::new();
        let mut edge_site = BTreeMap::new();
        for &id in &params {
            let p = id.get(doc).expect("ParamId::all");
            let mut d: Vec<ParamId> = Vec::new();
            for (field, text) in param_expressions(p) {
                let Ok(e) = parse(text) else { continue };
                for q in used_params(&e, &scopes, id.scope()) {
                    if !d.contains(&q) {
                        d.push(q);
                        edge_site.insert((id, q), format!("{}/{field}", id.path()));
                    }
                }
            }
            deps.insert(id, d);
        }
        ParamGraph {
            params,
            deps,
            edge_site,
        }
    }

    /// Every parameter, in declaration order.
    pub fn params(&self) -> &[ParamId] {
        &self.params
    }

    /// The parameters `p` uses, in first-use order.
    pub fn dependencies(&self, p: ParamId) -> &[ParamId] {
        self.deps.get(&p).map_or(&[], Vec::as_slice)
    }

    /// The evaluation order of §2.8 rule 3: topological (dependencies first), ties broken by
    /// declaration order with document parameters first. The second list holds the
    /// parameters that are on or behind a cycle (never ordered), in declaration order.
    pub fn order(&self) -> (Vec<ParamId>, Vec<ParamId>) {
        let mut missing: BTreeMap<ParamId, usize> = BTreeMap::new();
        let mut users: BTreeMap<ParamId, Vec<ParamId>> = BTreeMap::new();
        for &p in &self.params {
            let d = self.dependencies(p);
            missing.insert(p, d.len());
            for &q in d {
                users.entry(q).or_default().push(p);
            }
        }
        let mut ready: BTreeSet<ParamId> = missing
            .iter()
            .filter(|(_, n)| **n == 0)
            .map(|(p, _)| *p)
            .collect();
        let mut order = Vec::with_capacity(self.params.len());
        while let Some(p) = ready.pop_first() {
            order.push(p);
            for u in users.get(&p).map_or(&[][..], Vec::as_slice) {
                let n = missing.get_mut(u).expect("every user is a parameter");
                *n -= 1;
                if *n == 0 {
                    ready.insert(*u);
                }
            }
        }
        let done: BTreeSet<ParamId> = order.iter().copied().collect();
        let blocked = self
            .params
            .iter()
            .copied()
            .filter(|p| !done.contains(p))
            .collect();
        (order, blocked)
    }

    /// Every dependency cycle, one per strongly connected component that has one, in
    /// declaration order of their first member.
    pub fn cycles(&self) -> Vec<ParamCycle> {
        let mut out: Vec<ParamCycle> = self
            .sccs()
            .into_iter()
            .filter_map(|scc| {
                let first = *scc.iter().min()?;
                let cyclic = scc.len() > 1 || self.dependencies(first).contains(&first);
                if !cyclic {
                    return None;
                }
                let members = self.shortest_cycle(first, &scc)?;
                let path = self
                    .edge_site
                    .get(&(members[0], members[1]))
                    .cloned()
                    .unwrap_or_else(|| format!("{}/value", first.path()));
                Some(ParamCycle { members, path })
            })
            .collect();
        out.sort_by_key(|c| c.members[0]);
        out
    }

    /// Breadth-first from `start` inside `scc`, dependencies in first-use order: the
    /// shortest cycle through `start`, closed.
    fn shortest_cycle(&self, start: ParamId, scc: &BTreeSet<ParamId>) -> Option<Vec<ParamId>> {
        let mut parent: BTreeMap<ParamId, ParamId> = BTreeMap::new();
        let mut queue = VecDeque::from([start]);
        while let Some(u) = queue.pop_front() {
            for &w in self.dependencies(u) {
                if w == start {
                    // Walk the BFS tree back from `u` to `start`, then close the cycle.
                    let mut cycle = vec![u];
                    let mut x = u;
                    while x != start {
                        x = parent[&x];
                        cycle.push(x);
                    }
                    cycle.reverse();
                    cycle.push(start);
                    return Some(cycle);
                }
                if scc.contains(&w) && w != start && !parent.contains_key(&w) {
                    parent.insert(w, u);
                    queue.push_back(w);
                }
            }
        }
        None
    }

    /// Strongly connected components (iterative Tarjan), each as a set.
    fn sccs(&self) -> Vec<BTreeSet<ParamId>> {
        let mut index: BTreeMap<ParamId, usize> = BTreeMap::new();
        let mut low: BTreeMap<ParamId, usize> = BTreeMap::new();
        let mut on_stack: BTreeSet<ParamId> = BTreeSet::new();
        let mut stack: Vec<ParamId> = Vec::new();
        let mut next = 0usize;
        let mut out = Vec::new();
        for &root in &self.params {
            if index.contains_key(&root) {
                continue;
            }
            let mut work: Vec<(ParamId, usize)> = vec![(root, 0)];
            index.insert(root, next);
            low.insert(root, next);
            next += 1;
            stack.push(root);
            on_stack.insert(root);
            while let Some(top) = work.last_mut() {
                let v = top.0;
                let d = self.dependencies(v);
                if top.1 < d.len() {
                    let w = d[top.1];
                    top.1 += 1;
                    match index.get(&w) {
                        None => {
                            index.insert(w, next);
                            low.insert(w, next);
                            next += 1;
                            stack.push(w);
                            on_stack.insert(w);
                            work.push((w, 0));
                        }
                        Some(&iw) if on_stack.contains(&w) => {
                            let m = low[&v].min(iw);
                            low.insert(v, m);
                        }
                        Some(_) => {}
                    }
                } else {
                    work.pop();
                    if let Some(&(u, _)) = work.last() {
                        let m = low[&u].min(low[&v]);
                        low.insert(u, m);
                    }
                    if low[&v] == index[&v] {
                        let mut scc = BTreeSet::new();
                        while let Some(x) = stack.pop() {
                            on_stack.remove(&x);
                            scc.insert(x);
                            if x == v {
                                break;
                            }
                        }
                        out.push(scc);
                    }
                }
            }
        }
        out
    }
}

/// The visible parameters `e` uses, in first-use order, without repeats.
pub fn used_params(e: &Expr, scopes: &ParamScopes, scope: ExprScope) -> Vec<ParamId> {
    let mut out: Vec<ParamId> = Vec::new();
    for n in e.identifiers() {
        // `PI` is the constant (a parameter cannot be named PI: RESERVED_NAME).
        if n == super::types::PI_NAME {
            continue;
        }
        if let Some(q) = scopes.lookup(scope, n)
            && !out.contains(&q)
        {
            out.push(q);
        }
    }
    out
}
