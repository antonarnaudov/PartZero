//! The expression evaluator of record (SPEC-v1 §2.7 [D-12]): IEEE-754 binary64, deterministic
//! and bit-identical on every target.
//!
//! - `+ − * /`, `sqrt`, `floor`, `ceil`, `round`, `abs`, `min`, `max` and `%` are the exactly
//!   specified IEEE operations (`%` is `fmod`, through [`forge_core::math::fmod`]);
//! - unit literals convert with one multiplication (`cm` ×10, `in` ×25.4);
//! - `a ^ b` uses binary exponentiation for integer `|b| ≤ 64`, else `pow`;
//! - `sin`/`cos`/`tan` are the normative degree functions of [`forge_ir::v1::degtrig`];
//!   inverse trigonometry returns degrees with the exact results of rule 5;
//! - every NaN or ±∞ result, division or `%` by zero and domain error is `EXPR_DOMAIN`;
//! - every `-0` result becomes `+0` before it is used (rule 8);
//! - `?:` evaluates only the chosen branch, `&&`/`||` short-circuit (rule 6).
//!
//! The evaluator expects a type-checked tree ([`forge_ir::v1::expr::check`]); on an unchecked
//! tree that mixes booleans and numbers or names an unbound identifier it fails with
//! [`EvalErrorKind::Unchecked`] instead of guessing.

use forge_core::math;
use forge_ir::v1::degtrig;
use forge_ir::v1::expr::{BinaryOp, Expr, UnaryOp, canonical};
use forge_ir::v1::{FieldType, MAX_COUNT_MAGNITUDE};
use serde_json::{Map, Value as Json, json};

/// `180/π` rounded to the nearest f64 (§2.7 rule 5).
pub const RAD_TO_DEG: f64 = 57.29577951308232;

/// An evaluated expression.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Value {
    Num(f64),
    Bool(bool),
}

impl Value {
    pub fn as_num(self) -> Option<f64> {
        match self {
            Value::Num(x) => Some(x),
            Value::Bool(_) => None,
        }
    }

    pub fn as_bool(self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(b),
            Value::Num(_) => None,
        }
    }

    pub fn to_json(self) -> Json {
        match self {
            Value::Num(x) => json!(x),
            Value::Bool(b) => json!(b),
        }
    }
}

/// What kind of failure an [`EvalError`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvalErrorKind {
    /// `EXPR_DOMAIN` (§2.7 rule 7).
    Domain,
    /// `EXPR_NOT_INTEGER` (§2.7 rule 9).
    NotInteger,
    /// The tree was not type-checked (a boolean where a number is needed, or an unbound name):
    /// a caller bug, reported instead of producing a value.
    Unchecked,
}

/// An evaluation failure with the details of §7.5.
#[derive(Debug, Clone, PartialEq)]
pub struct EvalError {
    pub kind: EvalErrorKind,
    pub code: &'static str,
    pub message: String,
    pub details: Map<String, Json>,
}

impl std::fmt::Display for EvalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for EvalError {}

/// §2.7 rule 8: `-0` → `+0`.
#[inline]
pub fn no_neg_zero(x: f64) -> f64 {
    if x == 0.0 { 0.0 } else { x }
}

/// `true` for an exact integer with `|v| ≤ 2^31` (§2.7 rule 9).
pub fn is_count(v: f64) -> bool {
    v.is_finite() && v.fract() == 0.0 && v.abs() <= MAX_COUNT_MAGNITUDE
}

/// Evaluate `e`, resolving identifiers with `lookup` (the constant `PI` is built in).
pub fn eval(e: &Expr, lookup: &dyn Fn(&str) -> Option<Value>) -> Result<Value, EvalError> {
    Ev { root: e, lookup }.eval(e)
}

/// Evaluate `e` for a field of type `field`: the value must be of the field's kind, and a
/// `count` value must be an exact integer with `|v| ≤ 2^31` (`EXPR_NOT_INTEGER`).
pub fn eval_at(
    e: &Expr,
    lookup: &dyn Fn(&str) -> Option<Value>,
    field: FieldType,
) -> Result<Value, EvalError> {
    let v = eval(e, lookup)?;
    match (field, v) {
        (FieldType::Bool, Value::Bool(_)) => Ok(v),
        (FieldType::Bool, Value::Num(_)) | (_, Value::Bool(_)) => Err(unchecked(
            e,
            &format!("a {} value at a {field:?} field", kind_name(v)),
        )),
        (FieldType::Count, Value::Num(x)) if !is_count(x) => {
            let mut d = Map::new();
            d.insert("expr".into(), json!(canonical(e)));
            d.insert("value".into(), json!(x));
            Err(EvalError {
                kind: EvalErrorKind::NotInteger,
                code: "EXPR_NOT_INTEGER",
                message: format!(
                    "a count must be an exact integer with |v| <= 2^31, got {}",
                    forge_ir::v1::expr::format_number(x)
                ),
                details: d,
            })
        }
        _ => Ok(v),
    }
}

fn kind_name(v: Value) -> &'static str {
    match v {
        Value::Num(_) => "number",
        Value::Bool(_) => "bool",
    }
}

fn unchecked(root: &Expr, why: &str) -> EvalError {
    let mut d = Map::new();
    d.insert("expr".into(), json!(canonical(root)));
    EvalError {
        kind: EvalErrorKind::Unchecked,
        code: "EXPR_TYPE_MISMATCH",
        message: format!("expression was not type-checked: {why}"),
        details: d,
    }
}

struct Ev<'a> {
    root: &'a Expr,
    lookup: &'a dyn Fn(&str) -> Option<Value>,
}

impl Ev<'_> {
    fn domain(&self, at: &Expr, operands: &[f64], why: &str) -> EvalError {
        let mut d = Map::new();
        d.insert("expr".into(), json!(canonical(self.root)));
        d.insert("subexpr".into(), json!(canonical(at)));
        d.insert("operands".into(), json!(operands));
        EvalError {
            kind: EvalErrorKind::Domain,
            code: "EXPR_DOMAIN",
            message: format!("`{}`: {why}", canonical(at)),
            details: d,
        }
    }

    /// A finite result (else `EXPR_DOMAIN`), with `-0` replaced by `+0`.
    fn fin(&self, at: &Expr, operands: &[f64], r: f64) -> Result<f64, EvalError> {
        if r.is_finite() {
            Ok(no_neg_zero(r))
        } else {
            Err(self.domain(at, operands, "the result is not a finite number"))
        }
    }

    fn num(&self, e: &Expr) -> Result<f64, EvalError> {
        self.num_of(self.eval(e)?)
    }

    fn num_of(&self, v: Value) -> Result<f64, EvalError> {
        match v {
            Value::Num(x) => Ok(x),
            Value::Bool(_) => Err(unchecked(self.root, "a bool where a number is needed")),
        }
    }

    fn boolean(&self, e: &Expr) -> Result<bool, EvalError> {
        self.bool_of(self.eval(e)?)
    }

    fn bool_of(&self, v: Value) -> Result<bool, EvalError> {
        match v {
            Value::Bool(b) => Ok(b),
            Value::Num(_) => Err(unchecked(self.root, "a number where a bool is needed")),
        }
    }

    fn eval(&self, e: &Expr) -> Result<Value, EvalError> {
        if let Expr::Binary { .. } = e {
            // A left-associative chain is evaluated along its left spine without recursion (a
            // flat 4096-byte chain is ~2048 levels high), in the order of the recursive
            // definition: left operand, then (unless it short-circuits) right operand.
            let mut spine = Vec::new();
            let mut leaf = e;
            while let Expr::Binary { lhs, .. } = leaf {
                spine.push(leaf);
                leaf = lhs;
            }
            let mut v = self.eval(leaf)?;
            for node in spine.into_iter().rev() {
                let Expr::Binary { op, rhs, .. } = node else {
                    unreachable!("the spine holds binary nodes only")
                };
                v = self.binary(node, *op, v, rhs)?;
            }
            return Ok(v);
        }
        match e {
            Expr::Num { value, unit } => {
                let v = match unit.and_then(|u| u.factor()) {
                    Some(f) => value * f,
                    None => *value,
                };
                self.fin(e, &[*value], v).map(Value::Num)
            }
            Expr::Bool(b) => Ok(Value::Bool(*b)),
            Expr::Ident(n) if n == forge_ir::v1::expr::PI_NAME => Ok(Value::Num(math::PI)),
            Expr::Ident(n) => {
                (self.lookup)(n).ok_or_else(|| unchecked(self.root, &format!("unbound `{n}`")))
            }
            Expr::Unary { op, operand } => match op {
                UnaryOp::Neg => {
                    let x = self.num(operand)?;
                    Ok(Value::Num(no_neg_zero(-x)))
                }
                UnaryOp::Not => Ok(Value::Bool(!self.boolean(operand)?)),
            },
            Expr::Binary { .. } => unreachable!("evaluated along the spine above"),
            Expr::Cond {
                cond,
                then,
                otherwise,
            } => {
                // Only the chosen branch is evaluated (rule 6).
                if self.boolean(cond)? {
                    self.eval(then)
                } else {
                    self.eval(otherwise)
                }
            }
            Expr::Call { name, args } => {
                let xs = args
                    .iter()
                    .map(|a| self.num(a))
                    .collect::<Result<Vec<f64>, _>>()?;
                self.call(e, name, &xs).map(Value::Num)
            }
        }
    }

    #[allow(clippy::float_cmp)] // `==` on numbers is exact IEEE equality (§2.7 rule 1)
    /// `e = lhs op rhs`, with `lhs` already evaluated to `a`.
    fn binary(&self, e: &Expr, op: BinaryOp, a: Value, rhs: &Expr) -> Result<Value, EvalError> {
        match op {
            // Short-circuit (rule 6).
            BinaryOp::And => Ok(Value::Bool(self.bool_of(a)? && self.boolean(rhs)?)),
            BinaryOp::Or => Ok(Value::Bool(self.bool_of(a)? || self.boolean(rhs)?)),
            BinaryOp::Eq | BinaryOp::Ne => {
                let b = self.eval(rhs)?;
                let eq = match (a, b) {
                    (Value::Bool(x), Value::Bool(y)) => x == y,
                    (Value::Num(x), Value::Num(y)) => x == y,
                    _ => return Err(unchecked(self.root, "a bool compared with a number")),
                };
                Ok(Value::Bool(if op == BinaryOp::Eq { eq } else { !eq }))
            }
            _ => {
                let a = self.num_of(a)?;
                let b = self.num(rhs)?;
                let ops = [a, b];
                let r = match op {
                    BinaryOp::Lt => return Ok(Value::Bool(a < b)),
                    BinaryOp::Le => return Ok(Value::Bool(a <= b)),
                    BinaryOp::Gt => return Ok(Value::Bool(a > b)),
                    BinaryOp::Ge => return Ok(Value::Bool(a >= b)),
                    BinaryOp::Add => a + b,
                    BinaryOp::Sub => a - b,
                    BinaryOp::Mul => a * b,
                    BinaryOp::Div => {
                        if b == 0.0 {
                            return Err(self.domain(e, &ops, "division by zero"));
                        }
                        a / b
                    }
                    BinaryOp::Rem => {
                        if b == 0.0 {
                            return Err(self.domain(e, &ops, "remainder by zero"));
                        }
                        math::fmod(a, b)
                    }
                    BinaryOp::Pow => return self.pow(e, a, b).map(Value::Num),
                    BinaryOp::And | BinaryOp::Or | BinaryOp::Eq | BinaryOp::Ne => {
                        unreachable!("handled above")
                    }
                };
                self.fin(e, &ops, r).map(Value::Num)
            }
        }
    }

    /// §2.7 rule 3.
    fn pow(&self, e: &Expr, a: f64, b: f64) -> Result<f64, EvalError> {
        let ops = [a, b];
        if b.fract() == 0.0 && b.abs() <= 64.0 {
            // Binary exponentiation, exactly the SPEC's loop.
            let mut n = b.abs() as u32;
            let mut r = 1.0;
            let mut p = a;
            loop {
                if n & 1 == 1 {
                    r *= p;
                }
                n >>= 1;
                if n == 0 {
                    break;
                }
                p *= p;
            }
            // Rule 7 is applied to the operation's result, `1 / r`: an intermediate `r` that
            // overflows to ±∞ under a negative exponent gives ±0 → 0, not EXPR_DOMAIN
            // (`1e300 ^ -2` = 0, as the W7a oracle; flagged for a SPEC ruling). `r = ±0` gives
            // ±∞ → EXPR_DOMAIN (`0 ^ -1`).
            let v = if b < 0.0 { 1.0 / r } else { r };
            return self.fin(e, &ops, v);
        }
        if a < 0.0 && b.fract() != 0.0 {
            return Err(self.domain(e, &ops, "a negative base with a non-integer exponent"));
        }
        if a == 0.0 && b < 0.0 {
            return Err(self.domain(e, &ops, "zero to a negative power"));
        }
        self.fin(e, &ops, math::powf(a, b))
    }

    fn call(&self, e: &Expr, name: &str, x: &[f64]) -> Result<f64, EvalError> {
        let arity = |n: usize| {
            if x.len() == n {
                Ok(())
            } else {
                Err(unchecked(
                    self.root,
                    &format!("`{name}` with {} arguments", x.len()),
                ))
            }
        };
        match name {
            "min" | "max" => {
                if x.len() < 2 {
                    return Err(unchecked(self.root, "min/max with fewer than 2 arguments"));
                }
                // IEEE comparison; on equality the first argument wins (§2.6).
                let mut r = x[0];
                for &v in &x[1..] {
                    if (name == "min" && v < r) || (name == "max" && v > r) {
                        r = v;
                    }
                }
                Ok(no_neg_zero(r))
            }
            "abs" => {
                arity(1)?;
                Ok(no_neg_zero(x[0].abs()))
            }
            "sqrt" => {
                arity(1)?;
                if x[0] < 0.0 {
                    return Err(self.domain(e, x, "square root of a negative number"));
                }
                self.fin(e, x, x[0].sqrt())
            }
            "floor" => {
                arity(1)?;
                self.fin(e, x, x[0].floor())
            }
            "ceil" => {
                arity(1)?;
                self.fin(e, x, x[0].ceil())
            }
            "round" => {
                arity(1)?;
                // Halves away from zero.
                self.fin(e, x, x[0].round())
            }
            "clamp" => {
                arity(3)?;
                let (v, lo, hi) = (x[0], x[1], x[2]);
                if lo > hi {
                    return Err(self.domain(e, x, "clamp with lo > hi"));
                }
                // min(max(x, lo), hi), the first argument winning ties.
                let m = if lo > v { lo } else { v };
                Ok(no_neg_zero(if hi < m { hi } else { m }))
            }
            "hypot" => {
                arity(2)?;
                self.fin(e, x, math::hypot(x[0], x[1]))
            }
            "sin" | "cos" | "tan" => {
                arity(1)?;
                let r = match name {
                    "sin" => degtrig::sin_deg(x[0]),
                    "cos" => degtrig::cos_deg(x[0]),
                    _ => degtrig::tan_deg(x[0]),
                };
                match r {
                    Some(v) => self.fin(e, x, v),
                    None => Err(self.domain(e, x, "tan of an odd multiple of 90 degrees")),
                }
            }
            "asin" | "acos" => {
                arity(1)?;
                let v = x[0];
                if v.abs() > 1.0 {
                    return Err(self.domain(e, x, "argument outside [-1, 1]"));
                }
                let exact = if name == "asin" {
                    asin_exact(v)
                } else {
                    acos_exact(v)
                };
                let r = match exact {
                    Some(d) => d,
                    None if name == "asin" => math::asin(v) * RAD_TO_DEG,
                    None => math::acos(v) * RAD_TO_DEG,
                };
                self.fin(e, x, r)
            }
            "atan" => {
                arity(1)?;
                let v = x[0];
                #[allow(clippy::float_cmp)] // exact table arguments
                let r = if v == 0.0 {
                    0.0
                } else if v == 1.0 {
                    45.0
                } else if v == -1.0 {
                    -45.0
                } else {
                    math::atan(v) * RAD_TO_DEG
                };
                self.fin(e, x, r)
            }
            "atan2" => {
                arity(2)?;
                let (y, xx) = (x[0], x[1]);
                if y == 0.0 && xx == 0.0 {
                    return Err(self.domain(e, x, "atan2(0, 0) is undefined"));
                }
                let r = atan2_exact(y, xx).unwrap_or_else(|| {
                    let d = math::atan2(y, xx) * RAD_TO_DEG;
                    // The range is (−180, 180]: a rounded −180 is the same direction as 180.
                    if d.to_bits() == (-180.0f64).to_bits() {
                        180.0
                    } else {
                        d
                    }
                });
                self.fin(e, x, r)
            }
            _ => Err(unchecked(self.root, &format!("unknown function `{name}`"))),
        }
    }
}

/// The exact results of §2.7 rule 5 for `asin`.
#[allow(clippy::float_cmp)] // exact table arguments
fn asin_exact(v: f64) -> Option<f64> {
    Some(match v {
        _ if v == 0.0 => 0.0,
        _ if v == 0.5 => 30.0,
        _ if v == -0.5 => -30.0,
        _ if v == 1.0 => 90.0,
        _ if v == -1.0 => -90.0,
        _ => return None,
    })
}

/// The exact results of §2.7 rule 5 for `acos`.
#[allow(clippy::float_cmp)] // exact table arguments
fn acos_exact(v: f64) -> Option<f64> {
    Some(match v {
        _ if v == 1.0 => 0.0,
        _ if v == 0.5 => 60.0,
        _ if v == 0.0 => 90.0,
        _ if v == -0.5 => 120.0,
        _ if v == -1.0 => 180.0,
        _ => return None,
    })
}

/// `atan2` is exact when `y = 0`, `x = 0` or `|y| = |x|` (§2.7 rule 5); `(0, 0)` is the
/// caller's `EXPR_DOMAIN`.
#[allow(clippy::float_cmp)] // exact comparisons are the rule
fn atan2_exact(y: f64, x: f64) -> Option<f64> {
    if y == 0.0 {
        return Some(if x > 0.0 { 0.0 } else { 180.0 });
    }
    if x == 0.0 {
        return Some(if y > 0.0 { 90.0 } else { -90.0 });
    }
    if y.abs() == x.abs() {
        return Some(match (y > 0.0, x > 0.0) {
            (true, true) => 45.0,
            (true, false) => 135.0,
            (false, true) => -45.0,
            (false, false) => -135.0,
        });
    }
    None
}

#[cfg(test)]
#[allow(clippy::float_cmp)] // exact comparisons are the point
mod tests {
    use super::*;
    use forge_ir::v1::expr::parse;

    fn ev(text: &str) -> Result<Value, EvalError> {
        eval(&parse(text).unwrap(), &|_| None)
    }

    fn num(text: &str) -> f64 {
        ev(text).unwrap().as_num().unwrap()
    }

    #[test]
    fn negative_zero_never_escapes() {
        for t in [
            "-0",
            "0 * -1",
            "-(0)",
            "round(-0.4)",
            "ceil(-0.5)",
            "-5 % 5",
            "abs(-0)",
        ] {
            let v = num(t);
            assert_eq!(v.to_bits(), 0, "{t}");
        }
    }

    #[test]
    fn binary_exponentiation_follows_the_spec_loop() {
        assert_eq!(num("2 ^ 10"), 1024.0);
        assert_eq!(num("2 ^ -2"), 0.25);
        assert_eq!(num("0 ^ 0"), 1.0);
        assert_eq!(num("(-2) ^ 3"), -8.0);
        assert_eq!(ev("0 ^ -1").unwrap_err().code, "EXPR_DOMAIN");
        assert_eq!(ev("(-8) ^ 0.5").unwrap_err().code, "EXPR_DOMAIN");
        assert_eq!(ev("2 ^ 1024").unwrap_err().code, "EXPR_DOMAIN");
        // |b| > 64 goes through pow.
        assert_eq!(num("2 ^ 65").to_bits(), math::powf(2.0, 65.0).to_bits());
    }

    #[test]
    fn inverse_trig_exact_table() {
        for (t, v) in [
            ("asin(0)", 0.0),
            ("asin(0.5)", 30.0),
            ("asin(-0.5)", -30.0),
            ("asin(1)", 90.0),
            ("asin(-1)", -90.0),
            ("acos(1)", 0.0),
            ("acos(0.5)", 60.0),
            ("acos(0)", 90.0),
            ("acos(-0.5)", 120.0),
            ("acos(-1)", 180.0),
            ("atan(0)", 0.0),
            ("atan(1)", 45.0),
            ("atan(-1)", -45.0),
            ("atan2(0, 1)", 0.0),
            ("atan2(0, -1)", 180.0),
            ("atan2(-0, -1)", 180.0),
            ("atan2(1, 0)", 90.0),
            ("atan2(-1, 0)", -90.0),
            ("atan2(3, 3)", 45.0),
            ("atan2(3, -3)", 135.0),
            ("atan2(-3, 3)", -45.0),
            ("atan2(-3, -3)", -135.0),
        ] {
            assert_eq!(num(t).to_bits(), f64::to_bits(v), "{t}");
        }
        // Tiny negative y, negative x: never −180.
        assert_eq!(num("atan2(-1e-300, -1)"), 180.0);
    }

    #[test]
    fn short_circuit_and_chosen_branch_only() {
        assert_eq!(ev("false && 1 / 0 > 0").unwrap(), Value::Bool(false));
        assert_eq!(ev("true || 1 / 0 > 0").unwrap(), Value::Bool(true));
        assert_eq!(num("true ? 1 : 1 / 0"), 1.0);
        assert_eq!(ev("true ? 1 / 0 : 1").unwrap_err().code, "EXPR_DOMAIN");
    }

    #[test]
    fn domain_details_name_the_subexpression() {
        let e = ev("1 + sqrt(2 - 3)").unwrap_err();
        assert_eq!(e.kind, EvalErrorKind::Domain);
        assert_eq!(e.details["expr"], json!("1 + sqrt(2 - 3)"));
        assert_eq!(e.details["subexpr"], json!("sqrt(2 - 3)"));
        assert_eq!(e.details["operands"], json!([-1.0]));
    }

    #[test]
    fn unchecked_trees_fail_loudly() {
        assert_eq!(ev("1 + true").unwrap_err().kind, EvalErrorKind::Unchecked);
        assert_eq!(ev("nope").unwrap_err().kind, EvalErrorKind::Unchecked);
        assert_eq!(ev("!3").unwrap_err().kind, EvalErrorKind::Unchecked);
        assert_eq!(ev("foo(1)").unwrap_err().kind, EvalErrorKind::Unchecked);
    }
}
