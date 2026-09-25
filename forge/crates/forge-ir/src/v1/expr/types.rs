//! Name resolution, types and dimensional analysis (SPEC-v1 §2.5 [D-10], §2.6 [D-11],
//! §2.8 [D-13], [W0-15]).
//!
//! [`typecheck`] computes the type in one bottom-up, left-to-right pass and stops at the first
//! problem, so one expression yields at most one error (the SPEC does not fix which of several
//! problems is reported; this order is the one of the Python reference that generated the I9
//! fixtures): an identifier is resolved where it occurs (`EXPR_UNKNOWN_NAME`, `EXPR_SCOPE`); a
//! call checks its name and arity (`EXPR_UNKNOWN_FUNCTION`, `EXPR_ARITY`) before its arguments;
//! `?:` requires a Bool condition before typing its branches; an operator types both operands
//! and then applies its rule (`EXPR_TYPE_MISMATCH`, `EXPR_UNIT_MISMATCH`). [`check_use_site`]
//! applies the field type (§2.5 "Use site").

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::OnceLock;

use serde_json::{Value, json};

use super::ExprScope;
use super::ast::{BinaryOp, Expr, UnaryOp};
use super::printer::canonical;
use crate::v1::params::ParamUnit;
use crate::v1::scalar::FieldType;
use crate::v1::{Document, ValidationError, ids};

// ---- errors -----------------------------------------------------------------------------------

// **Details vocabulary** of `EXPR_UNIT_MISMATCH` and `EXPR_TYPE_MISMATCH` (§7.5 keys `expr`,
// `subexpr`, `expected`, `found`): `expr` is the canonical text of the whole expression and
// `subexpr` that of the offending node; `found` is always a [W0-15] type notation (`mm`, `deg`,
// `1`, `mm^2`, `mm*deg`, `flex`, `bool`); `expected` is either a type notation (the type the
// context needs: the field's `mm`/`deg`/`1`/`bool`, the other operand's type, `1` for an
// exponent) or one of the four words below. Explanations go into `message`.

/// `expected` of a Bool where any number (Real or Flex) is needed.
pub const EXPECTED_NUMBER: &str = "number";
/// `expected` of the exponent of a dimensioned base (§2.5: an integer literal, optionally
/// negated and parenthesised); `found` is the exponent's type.
pub const EXPECTED_INTEGER_LITERAL: &str = "integer literal";
/// `expected` of `sqrt` of a dimension with an odd exponent; `found` is the argument's type.
pub const EXPECTED_EVEN: &str = "even exponents";
/// `expected` when a product, quotient or power would give a dimension exponent beyond
/// ±2^62 (`found` is the operand type that overflows it).
pub const EXPECTED_REPRESENTABLE: &str = "representable dimension";

/// A coded expression problem (§7.5) without a location; [`ExprError::at`] adds the path.
#[derive(Debug, Clone, PartialEq)]
pub struct ExprError {
    /// `EXPR_*` (or `PARAM_*`) code from the catalogue.
    pub code: &'static str,
    pub message: String,
    /// A JSON object with the catalogue's keys for `code`.
    pub details: Value,
}

impl ExprError {
    pub fn new(code: &'static str, message: impl Into<String>, details: Value) -> Self {
        Self {
            code,
            message: message.into(),
            details,
        }
    }

    /// The validation error at `path` (a JSON pointer).
    pub fn at(&self, path: &str) -> ValidationError {
        ValidationError::new(self.code, path, self.message.clone(), self.details.clone())
    }
}

impl fmt::Display for ExprError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ExprError {}

// ---- types ------------------------------------------------------------------------------------

/// A dimension vector `(L, A)`: exponents of length (mm) and angle (degrees).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Dim {
    pub length: i64,
    pub angle: i64,
}

impl Dim {
    /// Dimensionless, `(0, 0)`.
    pub const ONE: Dim = Dim::new(0, 0);
    /// Length in mm, `(1, 0)`.
    pub const LENGTH: Dim = Dim::new(1, 0);
    /// Angle in degrees, `(0, 1)`.
    pub const ANGLE: Dim = Dim::new(0, 1);

    pub const fn new(length: i64, angle: i64) -> Dim {
        Dim { length, angle }
    }

    pub fn is_one(self) -> bool {
        self == Dim::ONE
    }

    /// `self · other` (exponents add); `None` on overflow.
    pub fn checked_mul(self, o: Dim) -> Option<Dim> {
        Some(Dim::new(
            self.length.checked_add(o.length)?,
            self.angle.checked_add(o.angle)?,
        ))
    }

    /// `self / other` (exponents subtract); `None` on overflow.
    pub fn checked_div(self, o: Dim) -> Option<Dim> {
        Some(Dim::new(
            self.length.checked_sub(o.length)?,
            self.angle.checked_sub(o.angle)?,
        ))
    }

    /// `self ^ n` (exponents scale); `None` on overflow.
    pub fn checked_pow(self, n: i64) -> Option<Dim> {
        Some(Dim::new(
            self.length.checked_mul(n)?,
            self.angle.checked_mul(n)?,
        ))
    }

    /// `sqrt(self)`: `None` unless both exponents are even.
    pub fn sqrt(self) -> Option<Dim> {
        (self.length % 2 == 0 && self.angle % 2 == 0)
            .then(|| Dim::new(self.length / 2, self.angle / 2))
    }

    /// [W0-15] notation: `1`, `mm`, `mm^2`, `mm^-1`, `deg`, `mm*deg`, …
    pub fn notation(self) -> String {
        let f = |name: &str, e: i64| match e {
            0 => None,
            1 => Some(name.to_string()),
            e => Some(format!("{name}^{e}")),
        };
        let parts: Vec<String> = [f("mm", self.length), f("deg", self.angle)]
            .into_iter()
            .flatten()
            .collect();
        if parts.is_empty() {
            "1".into()
        } else {
            parts.join("*")
        }
    }
}

/// The static type of an expression (§2.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Type {
    Bool,
    /// A real with a fixed dimension.
    Real(Dim),
    /// A real whose dimension its context fixes (bare numbers, `PI`).
    Flex,
}

impl Type {
    pub const LENGTH: Type = Type::Real(Dim::LENGTH);
    pub const ANGLE: Type = Type::Real(Dim::ANGLE);
    pub const ONE: Type = Type::Real(Dim::ONE);

    /// [W0-15] notation: `flex`, `bool`, or the dimension's notation.
    pub fn notation(self) -> String {
        match self {
            Type::Bool => "bool".into(),
            Type::Flex => "flex".into(),
            Type::Real(d) => d.notation(),
        }
    }

    pub fn is_number(self) -> bool {
        !matches!(self, Type::Bool)
    }

    /// The type a parameter of this unit has when used (§2.5).
    pub fn of_unit(u: ParamUnit) -> Type {
        match u {
            ParamUnit::Mm => Type::LENGTH,
            ParamUnit::Deg => Type::ANGLE,
            ParamUnit::Ratio | ParamUnit::Count => Type::ONE,
            ParamUnit::Bool => Type::Bool,
        }
    }

    /// The fixed type a field of this type requires (a Flex result adopts it).
    pub fn of_field(f: FieldType) -> Type {
        match f {
            FieldType::Length => Type::LENGTH,
            FieldType::Angle => Type::ANGLE,
            FieldType::Ratio | FieldType::Count => Type::ONE,
            FieldType::Bool => Type::Bool,
        }
    }
}

impl fmt::Display for Type {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.notation())
    }
}

/// Unification of two numeric types (§2.5: `+ - %`, comparisons, `min`, `max`, `clamp`,
/// `hypot`, `atan2`, the branches of `?:`): equal fixed dimensions, or Flex adopts the other.
/// `None` when both are fixed and differ, or either is Bool.
pub fn unify(a: Type, b: Type) -> Option<Type> {
    match (a, b) {
        (Type::Flex, Type::Flex) => Some(Type::Flex),
        (Type::Flex, Type::Real(d)) | (Type::Real(d), Type::Flex) => Some(Type::Real(d)),
        (Type::Real(x), Type::Real(y)) if x == y => Some(Type::Real(x)),
        _ => None,
    }
}

/// `a * b` (§2.5): a Flex coefficient is dimensionless next to a fixed operand; Flex next to
/// a dimensionless operand stays Flex. `None` for Bool operands or exponent overflow.
pub fn mul_type(a: Type, b: Type) -> Option<Type> {
    match (a, b) {
        (Type::Flex, Type::Flex) => Some(Type::Flex),
        (Type::Flex, Type::Real(d)) | (Type::Real(d), Type::Flex) => Some(if d.is_one() {
            Type::Flex
        } else {
            Type::Real(d)
        }),
        (Type::Real(x), Type::Real(y)) => x.checked_mul(y).map(Type::Real),
        _ => None,
    }
}

/// `a / b` (§2.5). `None` for Bool operands or exponent overflow.
pub fn div_type(a: Type, b: Type) -> Option<Type> {
    match (a, b) {
        (Type::Flex, Type::Flex) => Some(Type::Flex),
        (Type::Flex, Type::Real(d)) => Some(if d.is_one() {
            Type::Flex
        } else {
            Type::Real(Dim::ONE.checked_div(d)?)
        }),
        (Type::Real(d), Type::Flex) => Some(if d.is_one() {
            Type::Flex
        } else {
            Type::Real(d)
        }),
        (Type::Real(x), Type::Real(y)) => x.checked_div(y).map(Type::Real),
        _ => None,
    }
}

// ---- functions --------------------------------------------------------------------------------

/// How many arguments a function takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arity {
    Exactly(usize),
    AtLeast(usize),
}

impl Arity {
    pub fn accepts(self, n: usize) -> bool {
        match self {
            Arity::Exactly(k) => n == k,
            Arity::AtLeast(k) => n >= k,
        }
    }

    fn describe(self) -> String {
        match self {
            Arity::Exactly(k) => k.to_string(),
            Arity::AtLeast(k) => format!("at least {k}"),
        }
    }
}

/// The functions of §2.6 and their arities.
pub const FUNCTIONS: &[(&str, Arity)] = &[
    ("min", Arity::AtLeast(2)),
    ("max", Arity::AtLeast(2)),
    ("abs", Arity::Exactly(1)),
    ("sqrt", Arity::Exactly(1)),
    ("floor", Arity::Exactly(1)),
    ("ceil", Arity::Exactly(1)),
    ("round", Arity::Exactly(1)),
    ("clamp", Arity::Exactly(3)),
    ("hypot", Arity::Exactly(2)),
    ("sin", Arity::Exactly(1)),
    ("cos", Arity::Exactly(1)),
    ("tan", Arity::Exactly(1)),
    ("asin", Arity::Exactly(1)),
    ("acos", Arity::Exactly(1)),
    ("atan", Arity::Exactly(1)),
    ("atan2", Arity::Exactly(2)),
];

/// The arity of function `name`, if it is one of §2.6.
pub fn function_arity(name: &str) -> Option<Arity> {
    FUNCTIONS.iter().find(|(n, _)| *n == name).map(|(_, a)| *a)
}

/// The only named constant (§2.6): π rounded to the nearest f64.
pub const PI_NAME: &str = "PI";

// ---- environment ------------------------------------------------------------------------------

/// What an identifier names in a scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Binding {
    /// A visible parameter.
    Param(ParamUnit),
    /// A parameter of another part (`EXPR_SCOPE`); the declaring part's display name.
    OtherPart(String),
}

/// The names an expression may use (§2.8).
#[derive(Debug, Clone, Default)]
pub struct Env {
    names: BTreeMap<String, Binding>,
    /// Visible parameter names in declaration order (for `similar`).
    order: Vec<String>,
    features: BTreeSet<String>,
    /// The suggestion index of `order`, built on the first unknown name (callers keep one
    /// `Env` per scope, so every expression of a scope shares it).
    index: OnceLock<SimilarIndex>,
}

impl Env {
    pub fn new() -> Env {
        Env::default()
    }

    /// Add a visible parameter (the first declaration of a name wins).
    pub fn param(mut self, name: &str, unit: ParamUnit) -> Env {
        self.add_param(name, unit);
        self
    }

    pub fn add_param(&mut self, name: &str, unit: ParamUnit) {
        if !self.names.contains_key(name) {
            self.names.insert(name.to_string(), Binding::Param(unit));
            self.order.push(name.to_string());
            self.index = OnceLock::new();
        }
    }

    /// Add another part's parameter (`EXPR_SCOPE` when used).
    pub fn add_other_part(&mut self, name: &str, part: &str) {
        self.names
            .entry(name.to_string())
            .or_insert_with(|| Binding::OtherPart(ids::shown(part)));
    }

    /// Add a feature name or id (used to flag `is_feature` on `EXPR_UNKNOWN_NAME`).
    pub fn add_feature(&mut self, name: &str) {
        self.features.insert(name.to_string());
    }

    /// The environment of an expression site in `scope` (§2.8): a document site sees the
    /// document parameters; a part site sees the document parameters and that part's, and
    /// another part's parameter is `EXPR_SCOPE`.
    pub fn for_scope(doc: &Document, scope: ExprScope) -> Env {
        let mut env = Env::new();
        for p in &doc.params {
            env.add_param(&p.name, p.unit);
        }
        if let ExprScope::Part(pi) = scope {
            if let Some(part) = doc.parts.get(pi) {
                for p in &part.params {
                    env.add_param(&p.name, p.unit);
                }
            }
            for (qi, part) in doc.parts.iter().enumerate() {
                if qi != pi {
                    for p in &part.params {
                        env.add_other_part(&p.name, &part.name);
                    }
                }
            }
        }
        for part in &doc.parts {
            for f in &part.features {
                env.add_feature(f.name());
                env.add_feature(f.id());
            }
        }
        env
    }

    /// The binding of `name`, if any.
    pub fn lookup(&self, name: &str) -> Option<&Binding> {
        self.names.get(name)
    }

    /// The unit of the visible parameter `name`.
    pub fn unit(&self, name: &str) -> Option<ParamUnit> {
        match self.names.get(name) {
            Some(Binding::Param(u)) => Some(*u),
            _ => None,
        }
    }

    /// [`similar`] over the visible parameters, through the scope's [`SimilarIndex`]: the
    /// same suggestions without scanning every parameter per unknown name.
    fn similar_params(&self, name: &str) -> Vec<String> {
        self.index
            .get_or_init(|| SimilarIndex::new(&self.order))
            .query(name, &self.order)
    }
}

/// The largest edit distance [`similar`] suggests.
const SIMILAR_MAX_DISTANCE: usize = 2;

/// Up to three candidates close to `name` (case-insensitive match or edit distance ≤ 2),
/// closest first, then in the given order. Only valid ids are ever suggested.
///
/// Bounded work (BACKLOG P2 "Expression validation DoS"): an unknown identifier may be as long
/// as the expression (`MAX_EXPR_BYTES`), and a full edit-distance table against every visible
/// parameter cost `len(name) · len(candidate)` cells per candidate — 2.6e5 cells per parameter
/// for a 4000-byte name, per expression. The result is unchanged by three exact prunings:
/// - every suggestion is a valid id, at most [`ids::MAX_ID_LEN`] bytes, and the distance is at
///   least the length difference, so a name longer than `MAX_ID_LEN + 2` has none and is
///   skipped before it is even case-folded;
/// - a candidate whose length differs from the name's by more than 2 is skipped before any
///   other test (a case-insensitive match has equal length);
/// - the distance is computed on the diagonal band `|i − j| ≤ 2` only, stopping at the first
///   row whose band exceeds 2 ([`levenshtein_within`]): at most `5 · (MAX_ID_LEN + 3)` cells
///   per candidate.
fn similar<'a>(name: &str, candidates: impl Iterator<Item = &'a str>) -> Vec<String> {
    if name.len() > ids::MAX_ID_LEN + SIMILAR_MAX_DISTANCE {
        return Vec::new();
    }
    let lower = name.to_ascii_lowercase();
    let mut rows = BandRows::default();
    let mut scored: Vec<(usize, usize, &str)> = candidates
        .enumerate()
        .filter(|(_, c)| c.len().abs_diff(name.len()) <= SIMILAR_MAX_DISTANCE)
        .filter(|(_, c)| *c != name && ids::is_id(c))
        .filter_map(|(i, c)| {
            let d = if c.eq_ignore_ascii_case(&lower) {
                0
            } else {
                rows.levenshtein_within(lower.as_bytes(), c.as_bytes(), SIMILAR_MAX_DISTANCE)?
            };
            Some((d, i, c))
        })
        .collect();
    scored.sort();
    scored
        .into_iter()
        .take(3)
        .map(|(_, _, c)| c.to_string())
        .collect()
}

/// An implicit trie of the case-folded valid candidate ids, for [`similar`] over many
/// candidates (BACKLOG P2 "Expression validation DoS", review round 2: a document with
/// thousands of unknown near-miss names and thousands of parameters of the same length cost
/// one banded table per name **and parameter** — quadratic, 10 s for 4000 × 4000 in a release
/// build).
///
/// The candidates are sorted by their case-folded bytes; a trie node is a run of them sharing
/// a prefix (`depth` bytes), its children the sub-runs by the next byte (found by binary
/// search), and the smallest declaration index of a run comes from a sparse table. Memory is
/// the candidates themselves plus `n log n` indices, whatever their lengths (a materialized
/// trie of `n` unshared 64-byte ids would hold `64·n` nodes).
///
/// A query walks the trie depth first, one banded edit-distance row per node (the row of the
/// node's prefix: cells `|i − j| ≤ 2`, capped at 3), and prunes a subtree when no candidate in
/// it can enter the three best: its row minimum (a lower bound on every distance below: row
/// minima never decrease) exceeds 2, or `(row minimum, smallest index in the subtree)` is not
/// smaller than the third best `(distance, index)` found so far. Children are walked by their
/// smallest index, so low-index matches are found first. The result is exactly [`similar`]'s
/// (property-tested against the full table).
#[derive(Debug, Clone, Default)]
struct SimilarIndex {
    /// `(case-folded bytes, declaration index)` of the valid ids, sorted.
    sorted: Vec<(Vec<u8>, u32)>,
    /// `mins[l][k]`: the smallest index among `sorted[k .. k + 2^l]`.
    mins: Vec<Vec<u32>>,
}

impl SimilarIndex {
    fn new(order: &[String]) -> SimilarIndex {
        let mut sorted: Vec<(Vec<u8>, u32)> = order
            .iter()
            .enumerate()
            .filter(|(_, c)| ids::is_id(c))
            .map(|(i, c)| {
                (
                    c.bytes().map(|b| b.to_ascii_lowercase()).collect(),
                    u32::try_from(i).unwrap_or(u32::MAX),
                )
            })
            .collect();
        sorted.sort_unstable();
        let mut mins = vec![sorted.iter().map(|x| x.1).collect::<Vec<u32>>()];
        let mut width = 1;
        while 2 * width <= sorted.len() {
            let prev = mins.last().expect("level");
            let next: Vec<u32> = (0..=sorted.len() - 2 * width)
                .map(|k| prev[k].min(prev[k + width]))
                .collect();
            mins.push(next);
            width *= 2;
        }
        SimilarIndex { sorted, mins }
    }

    /// The smallest declaration index in `sorted[lo..hi]` (non-empty).
    fn min_index(&self, lo: usize, hi: usize) -> u32 {
        let l = (usize::BITS - 1 - (hi - lo).leading_zeros()) as usize;
        self.mins[l][lo].min(self.mins[l][hi - (1 << l)])
    }

    /// [`similar`]`(name, order)`.
    fn query(&self, name: &str, order: &[String]) -> Vec<String> {
        const K: usize = SIMILAR_MAX_DISTANCE;
        const OVER: u8 = K as u8 + 1;
        if name.len() > ids::MAX_ID_LEN + K || self.sorted.is_empty() {
            return Vec::new();
        }
        let q: Vec<u8> = name.bytes().map(|b| b.to_ascii_lowercase()).collect();
        let m = q.len();
        // Deeper nodes are more than K edits from every prefix of the name.
        let max_depth = m + K;
        // One row per depth: a node's row is computed from its parent's, which stays in place
        // while the node's subtree is walked (depth first).
        let mut rows: Vec<Vec<u8>> = vec![vec![OVER; m + 1]; max_depth + 1];
        for (j, c) in rows[0].iter_mut().enumerate() {
            *c = u8::try_from(j.min(OVER as usize)).unwrap_or(OVER);
        }
        // The three best `(distance, index)`, ascending.
        let mut best: Vec<(u8, u32)> = Vec::with_capacity(4);
        // Nodes `(depth, lo, hi)`: runs of `sorted` sharing their first `depth` bytes.
        let mut stack: Vec<(usize, usize, usize)> = vec![(0, 0, self.sorted.len())];
        let mut children: Vec<(u32, usize, usize)> = Vec::new();
        while let Some((i, lo, hi)) = stack.pop() {
            let row_min = if i == 0 {
                0
            } else {
                let b = self.sorted[lo].0[i - 1];
                let (done, rest) = rows.split_at_mut(i);
                let (prev, cur) = (&done[i - 1], &mut rest[0]);
                cur.fill(OVER);
                let jlo = i.saturating_sub(K).max(1);
                let jhi = (i + K).min(m);
                cur[jlo - 1] = if jlo == 1 {
                    u8::try_from(i.min(OVER as usize)).unwrap_or(OVER)
                } else {
                    OVER
                };
                let mut row_min = cur[jlo - 1];
                for j in jlo..=jhi {
                    let sub = prev[j - 1] + u8::from(q[j - 1] != b);
                    let v = sub.min(prev[j] + 1).min(cur[j - 1] + 1).min(OVER);
                    cur[j] = v;
                    row_min = row_min.min(v);
                }
                row_min
            };
            if row_min > K as u8
                || (best.len() == 3 && (row_min, self.min_index(lo, hi)) >= best[2])
            {
                continue;
            }
            // Candidates ending here sort first in the run.
            let mut k = lo;
            let d = rows[i][m];
            while k < hi && self.sorted[k].0.len() == i {
                let e = self.sorted[k].1;
                if d <= K as u8 && order[e as usize] != name {
                    best.push((d, e));
                    best.sort_unstable();
                    best.truncate(3);
                }
                k += 1;
            }
            if i == max_depth {
                continue;
            }
            // Children: sub-runs by the byte at `i` (non-decreasing over the run).
            children.clear();
            while k < hi {
                let b = self.sorted[k].0[i];
                let e = k + self.sorted[k..hi].partition_point(|x| x.0[i] <= b);
                children.push((self.min_index(k, e), k, e));
                k = e;
            }
            // Walk the child with the smallest index first.
            children.sort_unstable_by(|x, y| y.0.cmp(&x.0));
            stack.extend(children.iter().map(|&(_, clo, chi)| (i + 1, clo, chi)));
        }
        best.into_iter()
            .map(|(_, e)| order[e as usize].clone())
            .collect()
    }
}

/// Two reusable rows of the banded edit-distance table.
#[derive(Default)]
struct BandRows {
    prev: Vec<usize>,
    cur: Vec<usize>,
}

impl BandRows {
    /// The byte edit distance between `a` and `b`, ASCII case folded, when it is at most `k`;
    /// `None` when it is larger. Only the cells with `|i − j| ≤ k` are computed (the others are
    /// at least `|i − j| > k`, stored as `k + 1`), values are capped at `k + 1`, and the scan
    /// stops at the first row whose every cell exceeds `k` (row minima never decrease).
    fn levenshtein_within(&mut self, a: &[u8], b: &[u8], k: usize) -> Option<usize> {
        if a.len().abs_diff(b.len()) > k {
            return None;
        }
        let over = k + 1;
        let m = b.len();
        self.prev.clear();
        self.prev.extend((0..=m).map(|j| j.min(over)));
        self.cur.clear();
        self.cur.resize(m + 1, over);
        for i in 1..=a.len() {
            let lo = i.saturating_sub(k).max(1);
            let hi = (i + k).min(m);
            let (prev, cur) = (&self.prev, &mut self.cur);
            cur[lo - 1] = if lo == 1 { i.min(over) } else { over };
            let mut row_min = cur[lo - 1];
            for j in lo..=hi {
                let sub = prev[j - 1] + usize::from(!a[i - 1].eq_ignore_ascii_case(&b[j - 1]));
                let v = sub.min(prev[j] + 1).min(cur[j - 1] + 1).min(over);
                cur[j] = v;
                row_min = row_min.min(v);
            }
            if hi < m {
                // The next row reads this cell as its `prev[j]` at its band's right end.
                cur[hi + 1] = over;
            }
            if row_min > k {
                return None;
            }
            std::mem::swap(&mut self.prev, &mut self.cur);
        }
        let d = self.prev[m];
        (d <= k).then_some(d)
    }
}

// ---- checking ---------------------------------------------------------------------------------

/// The static type of `e` (§2.5), before the use-site check. Errors, the first one found in
/// the order of the module documentation: `EXPR_UNKNOWN_NAME`, `EXPR_SCOPE`,
/// `EXPR_UNKNOWN_FUNCTION`, `EXPR_ARITY`, `EXPR_TYPE_MISMATCH`, `EXPR_UNIT_MISMATCH`.
pub fn typecheck(e: &Expr, env: &Env) -> Result<Type, ExprError> {
    Checker { root: e, env }.ty(e)
}

/// The use-site rule of §2.5: a Flex result takes the field's dimension; a fixed result must
/// equal it; `count` fields take Real(0,0) or Flex; `bool` fields take Bool.
pub fn check_use_site(e: &Expr, t: Type, field: FieldType) -> Result<(), ExprError> {
    let want = Type::of_field(field);
    let ok = match (t, want) {
        (Type::Bool, Type::Bool) => true,
        (Type::Bool, _) | (_, Type::Bool) => false,
        (Type::Flex, _) => true,
        (a, b) => a == b,
    };
    if ok {
        return Ok(());
    }
    let whole = canonical(e);
    let code = if (t == Type::Bool) != (want == Type::Bool) {
        "EXPR_TYPE_MISMATCH"
    } else {
        "EXPR_UNIT_MISMATCH"
    };
    Err(mismatch(
        code,
        &whole,
        &whole,
        field.unit_name(),
        &t.notation(),
        "at this field",
    ))
}

/// [`typecheck`] then [`check_use_site`]; returns the static type.
pub fn check(e: &Expr, env: &Env, field: FieldType) -> Result<Type, ExprError> {
    let t = typecheck(e, env)?;
    check_use_site(e, t, field)?;
    Ok(t)
}

/// Parse `text` and [`check`] it: every rejection of §0.5 an expression can have on its own.
pub fn check_text(text: &str, env: &Env, field: FieldType) -> Result<(Expr, Type), ExprError> {
    let e = super::parse(text).map_err(|s| s.to_error(text))?;
    let t = check(&e, env, field)?;
    Ok((e, t))
}

fn mismatch(
    code: &'static str,
    expr: &str,
    subexpr: &str,
    expected: &str,
    found: &str,
    context: &str,
) -> ExprError {
    ExprError::new(
        code,
        format!("`{subexpr}` {context}: expected {expected}, found {found}"),
        json!({ "expr": expr, "subexpr": subexpr, "expected": expected, "found": found }),
    )
}

struct Checker<'a> {
    root: &'a Expr,
    env: &'a Env,
}

impl Checker<'_> {
    fn err(&self, code: &'static str, at: &Expr, expected: &str, found: Type) -> ExprError {
        mismatch(
            code,
            &canonical(self.root),
            &canonical(at),
            expected,
            &found.notation(),
            "does not type-check",
        )
    }

    /// A numeric operand (Bool is `EXPR_TYPE_MISMATCH`).
    fn number(&self, at: &Expr, t: Type) -> Result<Type, ExprError> {
        if t.is_number() {
            Ok(t)
        } else {
            Err(self.err("EXPR_TYPE_MISMATCH", at, EXPECTED_NUMBER, t))
        }
    }

    fn boolean(&self, at: &Expr, t: Type) -> Result<(), ExprError> {
        if t == Type::Bool {
            Ok(())
        } else {
            Err(self.err("EXPR_TYPE_MISMATCH", at, "bool", t))
        }
    }

    fn unify(&self, at: &Expr, a: Type, b: Type) -> Result<Type, ExprError> {
        self.number(at, a)?;
        self.number(at, b)?;
        unify(a, b).ok_or_else(|| self.err("EXPR_UNIT_MISMATCH", at, &a.notation(), b))
    }

    /// An identifier where it occurs (§2.8): `PI`, a visible parameter, or an error.
    fn ident(&self, n: &str) -> Result<Type, ExprError> {
        if n == PI_NAME {
            return Ok(Type::Flex);
        }
        match self.env.lookup(n) {
            Some(Binding::Param(u)) => Ok(Type::of_unit(*u)),
            Some(Binding::OtherPart(part)) => Err(ExprError::new(
                "EXPR_SCOPE",
                format!("`{n}` is a parameter of part {part:?}, not visible here"),
                json!({ "name": n, "part": part }),
            )),
            None => {
                let is_feature = self.env.features.contains(n);
                Err(ExprError::new(
                    "EXPR_UNKNOWN_NAME",
                    if is_feature {
                        format!("`{n}` is a feature, not a parameter")
                    } else {
                        format!("unknown name `{n}`")
                    },
                    json!({ "name": n, "is_feature": is_feature, "similar": self.env.similar_params(n) }),
                ))
            }
        }
    }

    /// A call's function name and arity (§2.6), checked before its arguments.
    fn call_head(&self, name: &str, n: usize) -> Result<(), ExprError> {
        match function_arity(name) {
            None => Err(ExprError::new(
                "EXPR_UNKNOWN_FUNCTION",
                format!("unknown function `{name}`"),
                json!({
                    "name": name,
                    "similar": similar(name, FUNCTIONS.iter().map(|(n, _)| *n)),
                }),
            )),
            Some(a) if !a.accepts(n) => Err(ExprError::new(
                "EXPR_ARITY",
                format!("`{name}` takes {} argument(s), got {n}", a.describe()),
                json!({ "name": name, "expected": a.describe(), "found": n }),
            )),
            Some(_) => Ok(()),
        }
    }

    fn ty(&self, e: &Expr) -> Result<Type, ExprError> {
        if let Expr::Binary { .. } = e {
            // A left-associative chain is typed along its left spine without recursion (a flat
            // 4096-byte chain is ~2048 levels high); the order of checks, and so the error
            // reported, is that of the recursive definition: left operand, right operand, rule.
            let mut spine = Vec::new();
            let mut leaf = e;
            while let Expr::Binary { lhs, .. } = leaf {
                spine.push(leaf);
                leaf = lhs;
            }
            let mut a = self.ty(leaf)?;
            for node in spine.into_iter().rev() {
                let Expr::Binary { op, rhs, .. } = node else {
                    unreachable!("the spine holds binary nodes only")
                };
                let b = self.ty(rhs)?;
                a = self.binary(node, *op, a, b, rhs)?;
            }
            return Ok(a);
        }
        match e {
            Expr::Num { unit: None, .. } => Ok(Type::Flex),
            Expr::Num { unit: Some(u), .. } => Ok(if u.is_angle() {
                Type::ANGLE
            } else {
                Type::LENGTH
            }),
            Expr::Bool(_) => Ok(Type::Bool),
            Expr::Ident(n) => self.ident(n),
            Expr::Unary { op, operand } => {
                let t = self.ty(operand)?;
                match op {
                    UnaryOp::Neg => self.number(e, t),
                    UnaryOp::Not => self.boolean(e, t).map(|()| Type::Bool),
                }
            }
            Expr::Binary { .. } => unreachable!("typed along the spine above"),
            Expr::Cond {
                cond,
                then,
                otherwise,
            } => {
                // The condition first; both branches are type-checked (§2.7 rule 6).
                let c = self.ty(cond)?;
                if c != Type::Bool {
                    return Err(self.err("EXPR_TYPE_MISMATCH", cond, "bool", c));
                }
                let a = self.ty(then)?;
                let b = self.ty(otherwise)?;
                match (a, b) {
                    (Type::Bool, Type::Bool) => Ok(Type::Bool),
                    (Type::Bool, _) => Err(self.err("EXPR_TYPE_MISMATCH", e, "bool", b)),
                    (_, Type::Bool) => Err(self.err("EXPR_TYPE_MISMATCH", e, EXPECTED_NUMBER, b)),
                    _ => self.unify(e, a, b),
                }
            }
            Expr::Call { name, args } => {
                self.call_head(name, args.len())?;
                let ts = args
                    .iter()
                    .map(|a| self.ty(a))
                    .collect::<Result<Vec<_>, _>>()?;
                self.call(e, name, &ts)
            }
        }
    }

    fn binary(
        &self,
        e: &Expr,
        op: BinaryOp,
        a: Type,
        b: Type,
        rhs: &Expr,
    ) -> Result<Type, ExprError> {
        match op {
            BinaryOp::Or | BinaryOp::And => {
                self.boolean(e, a)?;
                self.boolean(e, b)?;
                Ok(Type::Bool)
            }
            BinaryOp::Eq | BinaryOp::Ne => match (a, b) {
                (Type::Bool, Type::Bool) => Ok(Type::Bool),
                (Type::Bool, t) => Err(self.err("EXPR_TYPE_MISMATCH", e, "bool", t)),
                (_, Type::Bool) => Err(self.err("EXPR_TYPE_MISMATCH", e, EXPECTED_NUMBER, b)),
                _ => self.unify(e, a, b).map(|_| Type::Bool),
            },
            BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge => {
                self.unify(e, a, b).map(|_| Type::Bool)
            }
            BinaryOp::Add | BinaryOp::Sub | BinaryOp::Rem => self.unify(e, a, b),
            BinaryOp::Mul => {
                self.number(e, a)?;
                self.number(e, b)?;
                mul_type(a, b)
                    .ok_or_else(|| self.err("EXPR_UNIT_MISMATCH", e, EXPECTED_REPRESENTABLE, b))
            }
            BinaryOp::Div => {
                self.number(e, a)?;
                self.number(e, b)?;
                div_type(a, b)
                    .ok_or_else(|| self.err("EXPR_UNIT_MISMATCH", e, EXPECTED_REPRESENTABLE, b))
            }
            BinaryOp::Pow => {
                self.number(e, a)?;
                self.number(e, b)?;
                match a {
                    Type::Bool => Err(self.err("EXPR_TYPE_MISMATCH", e, EXPECTED_NUMBER, a)),
                    // Flex or dimensionless base: a dimensionless exponent; the base's type.
                    Type::Flex => self.dimensionless_exponent(e, b).map(|()| a),
                    Type::Real(d) if d.is_one() => self.dimensionless_exponent(e, b).map(|()| a),
                    // Dimensioned base: an integer literal exponent, optionally negated.
                    Type::Real(d) => {
                        let n = rhs.integer_literal().ok_or_else(|| {
                            self.err("EXPR_UNIT_MISMATCH", e, EXPECTED_INTEGER_LITERAL, b)
                        })?;
                        // |n| < 2^62 keeps the i64 conversion exact.
                        let limit = (1u64 << 62) as f64;
                        (n.abs() < limit)
                            .then(|| d.checked_pow(n as i64))
                            .flatten()
                            .map(Type::Real)
                            .ok_or_else(|| {
                                self.err("EXPR_UNIT_MISMATCH", e, EXPECTED_REPRESENTABLE, a)
                            })
                    }
                }
            }
        }
    }

    fn dimensionless_exponent(&self, e: &Expr, b: Type) -> Result<(), ExprError> {
        match b {
            Type::Flex => Ok(()),
            Type::Real(d) if d.is_one() => Ok(()),
            _ => Err(self.err("EXPR_UNIT_MISMATCH", e, "1", b)),
        }
    }

    /// A call's rule, after [`Self::call_head`] and the argument types.
    fn call(&self, e: &Expr, name: &str, ts: &[Type]) -> Result<Type, ExprError> {
        // `call_head` checked the arity; re-check so this never indexes out of bounds.
        self.call_head(name, ts.len())?;
        match name {
            // Unified left to right: min(width, tilt, lid) is a unit mismatch.
            "min" | "max" | "clamp" | "hypot" => {
                let mut acc = ts[0];
                for t in &ts[1..] {
                    acc = self.unify(e, acc, *t)?;
                }
                Ok(acc)
            }
            "atan2" => self.unify(e, ts[0], ts[1]).map(|_| Type::ANGLE),
            _ => self.unary_call(e, name, self.number(e, ts[0])?),
        }
    }

    /// The one-argument functions, on a numeric argument type `t`.
    fn unary_call(&self, e: &Expr, name: &str, t: Type) -> Result<Type, ExprError> {
        match (name, t) {
            ("abs" | "floor" | "ceil" | "round", _) => Ok(t),
            ("sqrt", Type::Real(d)) => d
                .sqrt()
                .map(Type::Real)
                .ok_or_else(|| self.err("EXPR_UNIT_MISMATCH", e, EXPECTED_EVEN, t)),
            ("sqrt", _) => Ok(t),
            ("sin" | "cos" | "tan", Type::Flex) => Ok(Type::Flex),
            ("sin" | "cos" | "tan", Type::Real(d)) if d == Dim::ANGLE => Ok(Type::ONE),
            ("sin" | "cos" | "tan", _) => Err(self.err("EXPR_UNIT_MISMATCH", e, "deg", t)),
            ("asin" | "acos" | "atan", Type::Flex) => Ok(Type::ANGLE),
            ("asin" | "acos" | "atan", Type::Real(d)) if d.is_one() => Ok(Type::ANGLE),
            ("asin" | "acos" | "atan", _) => Err(self.err("EXPR_UNIT_MISMATCH", e, "1", t)),
            _ => Err(ExprError::new(
                "EXPR_UNKNOWN_FUNCTION",
                format!("unknown function `{name}`"),
                json!({ "name": name, "similar": [] }),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notation_follows_w0_15() {
        assert_eq!(Dim::new(0, 0).notation(), "1");
        assert_eq!(Dim::new(1, 0).notation(), "mm");
        assert_eq!(Dim::new(2, 0).notation(), "mm^2");
        assert_eq!(Dim::new(-1, 0).notation(), "mm^-1");
        assert_eq!(Dim::new(0, 1).notation(), "deg");
        assert_eq!(Dim::new(1, 1).notation(), "mm*deg");
        assert_eq!(Dim::new(2, -3).notation(), "mm^2*deg^-3");
        assert_eq!(Type::Flex.notation(), "flex");
        assert_eq!(Type::Bool.notation(), "bool");
    }

    #[test]
    fn similar_names_are_close_and_valid() {
        let names = ["width", "depth", "Width2", "bad id"];
        assert_eq!(similar("Width", names.into_iter()), vec!["width", "Width2"]);
        assert_eq!(similar("dpth", names.into_iter()), vec!["depth"]);
        assert!(similar("zzzzzz", names.into_iter()).is_empty());
        assert_eq!(levenshtein("kitten", "sitting"), 3);
    }

    /// The full table: the reference the banded [`BandRows::levenshtein_within`] must match.
    fn levenshtein(a: &str, b: &str) -> usize {
        let (a, b) = (a.as_bytes(), b.as_bytes());
        let mut prev: Vec<usize> = (0..=b.len()).collect();
        for (i, ca) in a.iter().enumerate() {
            let mut cur = vec![i + 1; b.len() + 1];
            for (j, cb) in b.iter().enumerate() {
                let sub = prev[j] + usize::from(ca != cb);
                cur[j + 1] = sub.min(prev[j + 1] + 1).min(cur[j] + 1);
            }
            prev = cur;
        }
        prev[b.len()]
    }

    /// `similar` before the pruning (full table on every candidate), kept as the reference.
    fn similar_reference<'a>(name: &str, candidates: impl Iterator<Item = &'a str>) -> Vec<String> {
        let lower = name.to_ascii_lowercase();
        let mut scored: Vec<(usize, usize, &str)> = candidates
            .enumerate()
            .filter(|(_, c)| *c != name && ids::is_id(c))
            .filter_map(|(i, c)| {
                let d = if c.to_ascii_lowercase() == lower {
                    0
                } else {
                    levenshtein(&lower, &c.to_ascii_lowercase())
                };
                (d <= 2).then_some((d, i, c))
            })
            .collect();
        scored.sort();
        scored
            .into_iter()
            .take(3)
            .map(|(_, _, c)| c.to_string())
            .collect()
    }

    #[test]
    fn banded_distance_matches_the_full_table_near_the_band_edges() {
        let mut rows = BandRows::default();
        let words = [
            "", "a", "ab", "ba", "abc", "abcd", "abdc", "xbcd", "abcde", "abcdef", "bcdef", "Abc",
            "kitten", "sitting", "sittin", "kitte", "width", "Width2", "wdith", "aaaa", "aaaaaa",
        ];
        for a in words {
            for b in words {
                let full = levenshtein(&a.to_ascii_lowercase(), &b.to_ascii_lowercase());
                for k in 0..4 {
                    let want = (full <= k).then_some(full);
                    let got = rows.levenshtein_within(a.as_bytes(), b.as_bytes(), k);
                    assert_eq!(got, want, "{a:?} vs {b:?}, k = {k}");
                }
            }
        }
    }

    proptest::proptest! {
        #[test]
        fn pruned_similar_equals_the_full_table(
            name in "[A-Za-z_][A-Za-z0-9_]{0,9}",
            cands in proptest::collection::vec("[A-Za-z_][A-Za-z0-9_]{0,9}|[ab]{0,6}|.{0,8}", 0..24),
        ) {
            let fast = similar(&name, cands.iter().map(String::as_str));
            let slow = similar_reference(&name, cands.iter().map(String::as_str));
            proptest::prop_assert_eq!(fast, slow);
        }

        #[test]
        fn banded_distance_equals_the_capped_full_distance(
            a in "[abAB]{0,12}",
            b in "[abAB]{0,12}",
            k in 0usize..5,
        ) {
            let full = levenshtein(&a.to_ascii_lowercase(), &b.to_ascii_lowercase());
            let got = BandRows::default().levenshtein_within(a.as_bytes(), b.as_bytes(), k);
            proptest::prop_assert_eq!(got, (full <= k).then_some(full));
        }
    }

    /// BACKLOG P2 "Expression validation DoS": unknown names are checked against every visible
    /// parameter. Before the pruning, one 4000-byte unknown name against 5,000 parameters of 64
    /// bytes built 5,000 tables of 4000 × 64 cells (1.3e9 cells, tens of seconds in a debug
    /// build) per expression. Now an overlong name is skipped outright and a near-length name
    /// costs at most 5 · 67 cells per parameter. The bound is generous (debug build, a loaded
    /// machine) and still three orders of magnitude under the old cost.
    #[test]
    fn unknown_name_suggestions_are_bounded_in_time() {
        use std::time::{Duration, Instant};
        let prefix = "p".repeat(60);
        let mut env = Env::new();
        for i in 0..5000 {
            env.add_param(&format!("{prefix}{i:04}"), ParamUnit::Mm);
        }
        let long = super::super::parse(&"q".repeat(4000)).expect("one identifier");
        // Same-length near misses keep every candidate inside the band for all 65 rows: the
        // worst case of the banded table.
        let near = super::super::parse(&format!("{prefix}0017x")).expect("one identifier");
        let order: Vec<String> = (0..5000).map(|i| format!("{prefix}{i:04}")).collect();
        let want = similar_reference(&format!("{prefix}0017x"), order.iter().map(String::as_str));
        assert_eq!(want.len(), 3);
        assert_eq!(want[0], format!("{prefix}0017"));
        let start = Instant::now();
        for _ in 0..50 {
            let e = typecheck(&long, &env).expect_err("unknown");
            assert_eq!(e.code, "EXPR_UNKNOWN_NAME");
            assert_eq!(e.details["similar"], json!([]));
        }
        for _ in 0..2 {
            let e = typecheck(&near, &env).expect_err("unknown");
            assert_eq!(e.details["similar"], json!(want));
        }
        let spent = start.elapsed();
        assert!(spent < Duration::from_secs(3), "suggestions took {spent:?}");
    }

    #[test]
    fn overlong_and_length_mismatched_names_get_no_suggestion() {
        let names = ["abc", "abcdef", "abcdefgh"];
        // Two bytes longer than the longest id can still be within distance 2 of it.
        let id64 = "a".repeat(ids::MAX_ID_LEN);
        let two_more = "a".repeat(ids::MAX_ID_LEN + 2);
        assert_eq!(
            similar(&two_more, [id64.as_str()].into_iter()),
            vec![id64.clone()]
        );
        let three_more = "a".repeat(ids::MAX_ID_LEN + 3);
        assert!(similar(&three_more, [id64.as_str()].into_iter()).is_empty());
        assert_eq!(similar("abcd", names.into_iter()), vec!["abc", "abcdef"]);
        assert!(similar("abcdefghijk", names.into_iter()).is_empty());
    }

    proptest::proptest! {
        /// The scope's trie index gives exactly the full scan's suggestions: case variants
        /// (one trie leaf for several ids), invalid ids (never suggested), shared prefixes
        /// and lengths around the band edges.
        #[test]
        fn index_suggestions_equal_the_full_table(
            name in "[A-Za-z_][A-Za-z0-9_]{0,9}|[abAB]{0,7}",
            cands in proptest::collection::vec(
                "[A-Za-z_][A-Za-z0-9_]{0,9}|[abAB_]{0,7}|[aA][bB]{0,4}[0-9]?|.{0,6}",
                0..40,
            ),
        ) {
            let slow = similar_reference(&name, cands.iter().map(String::as_str));
            let fast = SimilarIndex::new(&cands).query(&name, &cands);
            proptest::prop_assert_eq!(fast, slow);
        }
    }

    #[test]
    fn index_suggestions_keep_declaration_order_among_equal_distances() {
        let order: Vec<String> = ["width", "Width", "wdth", "widths", "WIDTH", "widt", "w1dth"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let idx = SimilarIndex::new(&order);
        for name in [
            "width", "WIDTH", "wIdth", "widh", "x", "", "widthss", "w1dth",
        ] {
            assert_eq!(
                idx.query(name, &order),
                similar_reference(name, order.iter().map(String::as_str)),
                "{name:?}"
            );
        }
        // A parameter added after a query rebuilds the scope's index.
        let mut env = Env::new().param("alpha", ParamUnit::Mm);
        assert!(env.similar_params("beta").is_empty());
        env.add_param("beta2", ParamUnit::Mm);
        assert_eq!(env.similar_params("beta"), vec!["beta2"]);
    }

    /// BACKLOG P2 "Expression validation DoS", document level (review round 2): `N` parameters
    /// of 63 bytes and `N` extrude distances that each name a different unknown near miss of
    /// the same length. Scanning every parameter per unknown name was quadratic (2.6 s for
    /// `N = 2000`, 10 s for 4000, release build); the scope's trie index makes each name's
    /// suggestions a walk of the few trie nodes within distance 2 that can still enter the
    /// three best. The bound is generous for a debug build on a loaded machine; the old cost
    /// at `N = 4000` was minutes in a debug build.
    #[test]
    fn a_document_of_thousands_of_unknown_names_and_parameters_validates_in_bounded_time() {
        use std::time::{Duration, Instant};
        const N: usize = 4000;
        let prefix = "p".repeat(58);
        let param = |i: usize| format!("{prefix}{i:05}");
        // Distinct, of the same length, one substitution (the first digit) away from
        // parameter `i` and from those with the same last four digits.
        let unknown = |i: usize| format!("{prefix}x{:04}", i % 10000);
        let params: Vec<serde_json::Value> = (0..N)
            .map(|i| json!({ "name": param(i), "unit": "mm", "value": "1 mm" }))
            .collect();
        let mut features = vec![json!({
            "type": "sketch", "id": "s1", "name": "base", "plane": "XY",
            "curves": [{ "kind": "rect", "id": "outline", "center": [0, 0], "w": 10, "h": 10 }]
        })];
        for i in 0..N {
            features.push(json!({
                "type": "extrude", "id": format!("e{i}"), "name": format!("e{i}"),
                "sketch": "s1", "distance": unknown(i)
            }));
        }
        let doc = json!({
            "schema": "aicad.ir/1",
            "meta": { "name": "dos" },
            "params": params,
            "parts": [{ "id": "p1", "name": "part", "features": features }]
        })
        .to_string();
        let start = Instant::now();
        let err = crate::v1::from_json(&doc).expect_err("unknown names");
        let spent = start.elapsed();
        let errors: Vec<ValidationError> = match err {
            crate::v1::LoadError::Invalid(v) => v,
            other => panic!("{other:?}"),
        };
        let unknowns: Vec<&ValidationError> = errors
            .iter()
            .filter(|e| e.code == "EXPR_UNKNOWN_NAME")
            .collect();
        assert_eq!(unknowns.len(), N, "{:?}", errors.first());
        // Spot checks against the full scan: the parameters one substitution away, in
        // declaration order, the first three suggested.
        let order: Vec<String> = (0..N).map(param).collect();
        for i in [0, 17, 1234, N - 1] {
            let want = similar_reference(&unknown(i), order.iter().map(String::as_str));
            let site = unknowns
                .iter()
                .find(|e| e.details["name"] == json!(unknown(i)))
                .expect("site");
            assert_eq!(site.details["similar"], json!(want), "{i}");
            assert!(!want.is_empty() && want.len() <= 3, "{i}: {want:?}");
        }
        assert!(spent < Duration::from_secs(20), "validation took {spent:?}");
    }
}
