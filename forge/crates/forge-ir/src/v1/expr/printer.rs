//! The canonical printer (SPEC-v1 §2.4 [D-9], [W0-11], [W0-15]).

use super::ast::{BinaryOp, Expr, Level};

/// The canonical text of an expression (§2.4): numbers in ECMAScript `Number::toString` form
/// followed by ` unit`; one space around every binary operator, `?` and `:`; no space after a
/// unary operator; `f(a, b)`; parentheses only where precedence and associativity need them,
/// plus around a `^` that is the operand of a unary operator (`-(a ^ 2)`, `!(a ^ b)`).
pub fn canonical(e: &Expr) -> String {
    let mut out = String::new();
    // Iterative (an explicit stack of what remains to print, last pushed first), so that a
    // tree of any height prints without recursion: a flat 4096-byte chain is ~2048 high.
    let mut todo: Vec<Item<'_>> = vec![Item::Expr(e)];
    while let Some(item) = todo.pop() {
        let e = match item {
            Item::Text(t) => {
                out.push_str(t);
                continue;
            }
            Item::Expr(e) => e,
        };
        match e {
            Expr::Num { value, unit } => {
                out.push_str(&format_number(*value));
                if let Some(u) = unit {
                    out.push(' ');
                    out.push_str(u.as_str());
                }
            }
            Expr::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Expr::Ident(n) => out.push_str(n),
            Expr::Call { name, args } => {
                out.push_str(name);
                out.push('(');
                todo.push(Item::Text(")"));
                for (i, a) in args.iter().enumerate().rev() {
                    child(&mut todo, a, Level::Cond);
                    if i > 0 {
                        todo.push(Item::Text(", "));
                    }
                }
            }
            Expr::Unary { op, operand } => {
                out.push_str(op.symbol());
                // The operand is at least unary; a `^` operand is parenthesised anyway (§2.4
                // rule 3: TypeScript rejects a unary operator directly before `**`).
                if operand.level() == Level::Pow {
                    todo.push(Item::Text(")"));
                    todo.push(Item::Expr(operand));
                    todo.push(Item::Text("("));
                } else {
                    child(&mut todo, operand, Level::Unary);
                }
            }
            Expr::Binary { op, lhs, rhs } => {
                let (l, r) = operand_levels(*op);
                child(&mut todo, rhs, r);
                todo.push(Item::Text(" "));
                todo.push(Item::Text(op.symbol()));
                todo.push(Item::Text(" "));
                child(&mut todo, lhs, l);
            }
            Expr::Cond {
                cond,
                then,
                otherwise,
            } => {
                child(&mut todo, otherwise, Level::Cond);
                todo.push(Item::Text(" : "));
                child(&mut todo, then, Level::Cond);
                todo.push(Item::Text(" ? "));
                child(&mut todo, cond, Level::Or);
            }
        }
    }
    out
}

/// What remains to print.
enum Item<'a> {
    Expr(&'a Expr),
    Text(&'static str),
}

/// Schedule `e`, in parentheses when its level is below `min` (pushed in reverse order).
fn child<'a>(todo: &mut Vec<Item<'a>>, e: &'a Expr, min: Level) {
    if e.level() < min {
        todo.push(Item::Text(")"));
        todo.push(Item::Expr(e));
        todo.push(Item::Text("("));
    } else {
        todo.push(Item::Expr(e));
    }
}

/// The nesting depth of `canonical(e)` as [`super::parse`] counts it (§2.3; one level per
/// parenthesised group, call argument list, `?:` branch, unary operand and `^` exponent; see the
/// parser's module documentation): `parse(&canonical(e))` succeeds if and only if this is at
/// most [`crate::v1::MAX_EXPR_DEPTH`] (and the text fits in [`crate::v1::MAX_EXPR_BYTES`]).
/// A flat chain `a + b + c` has nesting 0. Iterative, like [`canonical`].
pub fn nesting(e: &Expr) -> u32 {
    // 1 when `c` is printed in parentheses as an operand that needs level `min`.
    let paren = |c: &Expr, min: Level| u32::from(c.level() < min);
    let mut max = 0;
    let mut todo = vec![(e, 0u32)];
    while let Some((e, d)) = todo.pop() {
        max = max.max(d);
        match e {
            Expr::Num { .. } | Expr::Bool(_) | Expr::Ident(_) => {}
            Expr::Call { args, .. } => {
                // The argument list is one level, empty or not.
                max = max.max(d + 1);
                todo.extend(args.iter().map(|a| (a, d + 1)));
            }
            Expr::Unary { operand, .. } => {
                let p = if operand.level() == Level::Pow {
                    1
                } else {
                    paren(operand, Level::Unary)
                };
                todo.push((operand, d + 1 + p));
            }
            Expr::Binary {
                op: BinaryOp::Pow,
                lhs,
                rhs,
            } => {
                todo.push((lhs, d + paren(lhs, Level::Atom)));
                todo.push((rhs, d + 1 + paren(rhs, Level::Unary)));
            }
            Expr::Binary { op, lhs, rhs } => {
                let (l, r) = operand_levels(*op);
                todo.push((lhs, d + paren(lhs, l)));
                todo.push((rhs, d + paren(rhs, r)));
            }
            Expr::Cond {
                cond,
                then,
                otherwise,
            } => {
                todo.push((cond, d + paren(cond, Level::Or)));
                todo.push((then, d + 1));
                todo.push((otherwise, d + 1));
            }
        }
    }
    max
}

/// The lowest level each operand may have without parentheses.
fn operand_levels(op: BinaryOp) -> (Level, Level) {
    match op.level() {
        // Left-associative: the left operand may be at the operator's own level.
        Level::Or => (Level::Or, Level::And),
        Level::And => (Level::And, Level::Cmp),
        // Not associative: both operands at least `+`/`-` level.
        Level::Cmp => (Level::Add, Level::Add),
        Level::Add => (Level::Add, Level::Mul),
        Level::Mul => (Level::Mul, Level::Unary),
        // Base must be an atom; exponent at least unary.
        Level::Pow => (Level::Atom, Level::Unary),
        l => unreachable!("binary operator at level {l:?}"),
    }
}

/// A number in ECMAScript `Number::toString` form (ECMA-262 §6.1.6.1.20, [W0-11]): the
/// shortest digit string that round-trips; `-0` prints as `0`; plain decimal notation for
/// `1e-7 < |x| < 1e21` (`1000`, `0.000001`, `100000000000000000000`), otherwise `d.ddde±n`
/// (`1e-7`, `1e+21`, `1.5e+300`).
pub fn format_number(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let sci = shortest_sci(x.abs());
    let (mant, exp) = sci
        .split_once('e')
        .expect("LowerExp always has an exponent");
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    // value = 0.d1d2…dk × 10^n
    let n = exp.parse::<i64>().expect("integer exponent") + 1;
    let body = if k <= n && n <= 21 {
        let mut s = digits;
        s.extend(std::iter::repeat_n('0', (n - k) as usize));
        s
    } else if 0 < n && n <= 21 {
        let (a, b) = digits.split_at(n as usize);
        format!("{a}.{b}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let es = if e < 0 {
            format!("-{}", -e)
        } else {
            format!("+{e}")
        };
        if k == 1 {
            format!("{digits}e{es}")
        } else {
            let (a, b) = digits.split_at(1);
            format!("{a}.{b}e{es}")
        }
    };
    format!("{sign}{body}")
}

/// The ECMAScript digit selection for a positive finite `x`, as `d.ddde<exp>`: the fewest
/// digits `k` that round-trip; among the k-digit decimals that round-trip, the one closest to
/// the exact value of `x`; on a tie, the even one (ECMA-262 §6.1.6.1.20 note 2, which V8,
/// `JSON.parse`'s inverse and Python's `repr` follow).
///
/// Rust's shortest formatter (`{:e}`) gives the right `k` but rounds an exact tie up
/// (`1117288026597695.25` → `…695.3`, where ECMAScript and Python print `…695.2`), so the
/// digits are recomputed with Rust's exact formatter, which rounds half to even.
fn shortest_sci(x: f64) -> String {
    let shortest = format!("{x:e}");
    let k = shortest
        .split('e')
        .next()
        .map_or(1, |m| m.chars().filter(char::is_ascii_digit).count());
    let nearest = format!("{:.*e}", k - 1, x);
    // The nearest k-digit decimal round-trips unless `x` is a power of two whose lower
    // rounding gap is half the upper one; then the shortest form is the closest that does.
    if nearest
        .parse::<f64>()
        .is_ok_and(|y| y.to_bits() == x.to_bits())
    {
        // `{:.Ne}` keeps trailing zeros (`1.50e2`); the shortest form has none.
        let (m, e) = nearest.split_once('e').expect("LowerExp");
        let m = if m.contains('.') {
            m.trim_end_matches('0').trim_end_matches('.')
        } else {
            m
        };
        format!("{m}e{e}")
    } else {
        shortest
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecmascript_number_forms() {
        for (x, s) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (1e3, "1000"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e300, "1.5e+300"),
            (0.1, "0.1"),
            (0.30000000000000004, "0.30000000000000004"),
            (123456789012345678901.0, "123456789012345680000"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (2.5e-3, "0.0025"),
            (12.5, "12.5"),
            (-2.5, "-2.5"),
            (1.2345e-7, "1.2345e-7"),
            (123.456, "123.456"),
            // An exact tie between two shortest candidates: the even one (ECMAScript, Python).
            // 1117288026597695.25 exactly.
            (f64::from_bits(4832293505126582778), "1117288026597695.2"),
            (9007199254740992.0, "9007199254740992"),
            (5e-324 * 3.0, "1.5e-323"),
        ] {
            assert_eq!(format_number(x), s, "{x:e}");
        }
    }
}
