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

    fn similar_params(&self, name: &str) -> Vec<String> {
        similar(name, self.order.iter().map(String::as_str))
    }
}

/// Up to three candidates close to `name` (case-insensitive match or edit distance ≤ 2),
/// closest first, then in the given order. Only valid ids are ever suggested.
fn similar<'a>(name: &str, candidates: impl Iterator<Item = &'a str>) -> Vec<String> {
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
}
