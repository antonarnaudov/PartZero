//! W1 property tests (IR-V1 plan, W1 acceptance): `parse(canonical(e)) == e`, `canonical` is
//! idempotent, any spelling of a tree (redundant parentheses, whitespace, number forms) parses
//! to the same tree, the parser never panics, and the unit algebra laws of §2.5 hold.

#![allow(clippy::float_cmp)] // exact comparisons are the point

use forge_ir::v1::expr::{
    BinaryOp, Dim, Env, Expr, Type, UnaryOp, Unit, canonical, div_type, format_number, mul_type,
    nesting, parse, typecheck, unify,
};
use forge_ir::v1::{MAX_EXPR_BYTES, ParamUnit};
use proptest::prelude::*;

// ---- generators ---------------------------------------------------------------------------------

fn arb_num() -> impl Strategy<Value = f64> {
    prop_oneof![
        (0u32..1000).prop_map(f64::from),
        (0u32..100_000).prop_map(|k| f64::from(k) / 64.0),
        prop::sample::select(vec![0.1, 0.25, 1e-7, 1e21, 1e20, 5e-324, f64::MAX, 2.5e-3]),
        any::<u64>()
            .prop_map(f64::from_bits)
            .prop_filter("finite, non-negative", |x| x.is_finite() && *x >= 0.0),
    ]
}

fn arb_ident() -> impl Strategy<Value = String> {
    "[a-zA-Z_][a-zA-Z0-9_]{0,6}".prop_filter("keywords", |s| s != "true" && s != "false")
}

fn arb_unop() -> impl Strategy<Value = UnaryOp> {
    prop::sample::select(vec![UnaryOp::Neg, UnaryOp::Not])
}

fn arb_binop() -> impl Strategy<Value = BinaryOp> {
    prop::sample::select(BinaryOp::ALL.to_vec())
}

/// Any tree the grammar can produce (types are irrelevant to syntax).
fn arb_expr() -> impl Strategy<Value = Expr> {
    let leaf = prop_oneof![
        (
            arb_num(),
            prop::option::of(prop::sample::select(Unit::ALL.to_vec()))
        )
            .prop_map(|(value, unit)| Expr::Num { value, unit }),
        any::<bool>().prop_map(Expr::Bool),
        arb_ident().prop_map(Expr::Ident),
    ];
    leaf.prop_recursive(7, 96, 4, |inner| {
        prop_oneof![
            (arb_unop(), inner.clone()).prop_map(|(op, e)| Expr::unary(op, e)),
            (arb_binop(), inner.clone(), inner.clone())
                .prop_map(|(op, a, b)| Expr::binary(op, a, b)),
            (inner.clone(), inner.clone(), inner.clone()).prop_map(|(c, a, b)| Expr::cond(c, a, b)),
            (arb_ident(), prop::collection::vec(inner, 0..4)).prop_map(|(n, a)| Expr::call(n, a)),
        ]
    })
}

/// Trees around the nesting limit: a leaf wrapped 20–100 times, each wrapper one of the
/// constructs that nest (unary operand, `^` exponent or base, `?:` condition/branches, call
/// arguments, parenthesised operands) or that do not (either operand of a chain operator).
fn arb_deep() -> impl Strategy<Value = Expr> {
    (
        prop::collection::vec((0u8..16, arb_binop()), 20..100),
        prop_oneof![Just(Expr::ident("x")), Just(Expr::num(2.0))],
    )
        .prop_map(|(steps, leaf)| {
            let one = || Expr::num(1.0);
            steps.into_iter().fold(leaf, |e, (k, op)| match k {
                0 => Expr::unary(UnaryOp::Neg, e),
                1 => Expr::unary(UnaryOp::Not, e),
                2 => Expr::binary(BinaryOp::Pow, Expr::num(2.0), e),
                3 => Expr::binary(BinaryOp::Pow, e, Expr::num(2.0)),
                4 => Expr::cond(e, one(), one()),
                5 => Expr::cond(Expr::Bool(true), e, one()),
                6 => Expr::cond(Expr::Bool(true), one(), e),
                7 => Expr::call("f", vec![e]),
                8 => Expr::call("g", vec![one(), e]),
                9 => Expr::call("h", vec![Expr::call("k", vec![]), e]),
                10 | 11 => Expr::binary(op, e, one()),
                _ => Expr::binary(op, one(), e),
            })
        })
}

/// A tiny deterministic generator for the noisy printer.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn chance(&mut self, one_in: u64) -> bool {
        self.next().is_multiple_of(one_in)
    }
    fn ws(&mut self) -> &'static str {
        ["", "", " ", "\t", "  ", " \t"][(self.next() % 6) as usize]
    }
}

/// Print `e` with random redundant parentheses, random space/tab between tokens, and numbers
/// in any grammatical spelling: it must parse back to `e`.
fn noisy(e: &Expr, rng: &mut Lcg) -> String {
    fn go(e: &Expr, rng: &mut Lcg, out: &mut String) {
        let wrap = rng.chance(4);
        if wrap {
            out.push('(');
            out.push_str(rng.ws());
        }
        match e {
            Expr::Num { value, unit } => {
                let s = match rng.next() % 3 {
                    0 => format_number(*value),
                    1 => format!("{value:e}"),
                    _ => format!("{value:?}"),
                };
                out.push_str(&s);
                if let Some(u) = unit {
                    out.push_str(rng.ws());
                    out.push_str(u.as_str());
                }
            }
            Expr::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Expr::Ident(n) => out.push_str(n),
            Expr::Call { name, args } => {
                out.push_str(name);
                out.push_str(rng.ws());
                out.push('(');
                for (i, a) in args.iter().enumerate() {
                    if i > 0 {
                        out.push_str(rng.ws());
                        out.push(',');
                    }
                    out.push_str(rng.ws());
                    go(a, rng, out);
                }
                out.push_str(rng.ws());
                out.push(')');
            }
            Expr::Unary { op, operand } => {
                out.push_str(op.symbol());
                out.push_str(rng.ws());
                // Parentheses only where needed (a unary operand below unary level).
                let low = matches!(operand.as_ref(), Expr::Binary { op, .. } if *op != BinaryOp::Pow)
                    || matches!(operand.as_ref(), Expr::Cond { .. });
                paren(operand, low, rng, out);
            }
            Expr::Binary { op, lhs, rhs } => {
                let (l, r) = needs(*op, lhs, rhs);
                paren(lhs, l, rng, out);
                out.push_str(rng.ws());
                out.push_str(op.symbol());
                out.push_str(rng.ws());
                paren(rhs, r, rng, out);
            }
            Expr::Cond {
                cond,
                then,
                otherwise,
            } => {
                paren(cond, matches!(cond.as_ref(), Expr::Cond { .. }), rng, out);
                out.push_str(rng.ws());
                out.push('?');
                out.push_str(rng.ws());
                go(then, rng, out);
                out.push_str(rng.ws());
                out.push(':');
                out.push_str(rng.ws());
                go(otherwise, rng, out);
            }
        }
        if wrap {
            out.push_str(rng.ws());
            out.push(')');
        }
    }
    fn paren(e: &Expr, needed: bool, rng: &mut Lcg, out: &mut String) {
        if needed {
            out.push('(');
            go(e, rng, out);
            out.push(')');
        } else {
            go(e, rng, out);
        }
    }
    /// Whether each operand of `op` needs parentheses (the grammar of §2.3).
    fn needs(op: BinaryOp, l: &Expr, r: &Expr) -> (bool, bool) {
        let rank = |e: &Expr| -> u8 {
            match e {
                Expr::Cond { .. } => 0,
                Expr::Binary { op, .. } => match op {
                    BinaryOp::Or => 1,
                    BinaryOp::And => 2,
                    BinaryOp::Add | BinaryOp::Sub => 4,
                    BinaryOp::Mul | BinaryOp::Div | BinaryOp::Rem => 5,
                    BinaryOp::Pow => 7,
                    _ => 3,
                },
                Expr::Unary { .. } => 6,
                _ => 8,
            }
        };
        let (min_l, min_r) = match op {
            BinaryOp::Or => (1, 2),
            BinaryOp::And => (2, 3),
            BinaryOp::Add | BinaryOp::Sub => (4, 5),
            BinaryOp::Mul | BinaryOp::Div | BinaryOp::Rem => (5, 6),
            BinaryOp::Pow => (8, 6),
            _ => (4, 4),
        };
        (rank(l) < min_l, rank(r) < min_r)
    }
    let mut s = String::new();
    go(e, rng, &mut s);
    s
}

// ---- syntax properties -------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    /// §2.4: `parse(canonical(ast)) == ast` for every AST (whose canonical text fits).
    #[test]
    fn parse_of_canonical_is_identity(e in arb_expr()) {
        let c = canonical(&e);
        prop_assume!(c.len() <= MAX_EXPR_BYTES && nesting(&e) <= 64);
        let back = parse(&c).map_err(|err| TestCaseError::fail(format!("{c:?}: {err:?}")))?;
        prop_assert_eq!(&back, &e, "{}", c);
    }

    /// §2.3 nesting, exactly: the canonical text of a tree parses if and only if its nesting
    /// (one level per re-entry of the grammar, chains excluded) is at most 64; beyond, the error
    /// is the nesting limit.
    #[test]
    fn canonical_text_parses_iff_nesting_is_at_most_64(e in arb_deep()) {
        let c = canonical(&e);
        prop_assume!(c.len() <= MAX_EXPR_BYTES);
        match parse(&c) {
            Ok(back) => {
                prop_assert!(nesting(&e) <= 64, "{} has nesting {}", c, nesting(&e));
                prop_assert_eq!(&back, &e, "{}", c);
            }
            Err(err) => {
                prop_assert!(nesting(&e) > 64, "{}: {:?}", c, err);
                prop_assert_eq!(err.expected, "at most 64 nesting levels");
            }
        }
    }

    /// `canonical` is idempotent on text: canonical(parse(canonical(e))) == canonical(e).
    #[test]
    fn canonical_is_idempotent(e in arb_expr()) {
        let c = canonical(&e);
        prop_assume!(c.len() <= MAX_EXPR_BYTES);
        prop_assert_eq!(canonical(&parse(&c).unwrap()), c);
    }

    /// Every spelling of a tree (extra parentheses, whitespace, number forms) is the same tree.
    #[test]
    fn any_spelling_parses_to_the_same_tree(e in arb_expr(), seed in any::<u64>()) {
        let text = noisy(&e, &mut Lcg(seed));
        // Redundant parentheses may exceed the nesting bound; stay inside the limits.
        prop_assume!(text.len() <= MAX_EXPR_BYTES);
        match parse(&text) {
            Ok(back) => prop_assert_eq!(&back, &e, "{}", text),
            Err(err) => prop_assert!(err.expected.contains("64"), "{:?}: {:?}", text, err),
        }
    }

    /// The parser never panics, and whatever it accepts round-trips through the canonical form.
    #[test]
    fn parser_is_total(text in "[ \t0-9a-z_A-Z().,+*/%^<>=!&|?:eE-]{0,64}") {
        if let Ok(e) = parse(&text) {
            let c = canonical(&e);
            prop_assert_eq!(parse(&c).unwrap(), e, "{:?} -> {:?}", text, c);
        }
    }

    #[test]
    fn parser_is_total_on_any_unicode(text in "\\PC{0,40}") {
        let _ = parse(&text);
    }

    /// Canonical numbers: ECMAScript form, shortest round-trip.
    #[test]
    fn canonical_numbers_round_trip(bits in any::<u64>()) {
        let x = f64::from_bits(bits).abs();
        prop_assume!(x.is_finite());
        let s = format_number(x);
        let Expr::Num { value, unit: None } = parse(&s).unwrap() else { panic!("{s}") };
        prop_assert_eq!(value, x, "{}", s);
        // No trailing zeros in a fraction, no leading zeros, no '+' before a negative exponent.
        if let Some((_, frac)) = s.split_once('.') {
            let frac = frac.split('e').next().unwrap();
            prop_assert!(!frac.ends_with('0'), "{}", s);
        }
        prop_assert!(!s.starts_with("00"), "{}", s);
    }
}

// ---- unit algebra (§2.5) ----------------------------------------------------------------------

fn arb_type() -> impl Strategy<Value = Type> {
    prop_oneof![
        Just(Type::Flex),
        (-4i64..=4, -4i64..=4).prop_map(|(l, a)| Type::Real(Dim::new(l, a))),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(3000))]

    #[test]
    fn unify_is_commutative_idempotent_with_flex_identity(a in arb_type(), b in arb_type()) {
        prop_assert_eq!(unify(a, b), unify(b, a));
        prop_assert_eq!(unify(a, a), Some(a));
        prop_assert_eq!(unify(a, Type::Flex), Some(a));
        // Unify succeeds iff the fixed dimensions agree.
        if let (Type::Real(x), Type::Real(y)) = (a, b) {
            prop_assert_eq!(unify(a, b).is_some(), x == y);
        }
        prop_assert_eq!(unify(Type::Bool, a), None);
    }

    #[test]
    fn unify_is_associative(a in arb_type(), b in arb_type(), c in arb_type()) {
        let l = unify(a, b).and_then(|ab| unify(ab, c));
        let r = unify(b, c).and_then(|bc| unify(a, bc));
        prop_assert_eq!(l, r);
    }

    /// Products commute, and the dimension of a product is the sum of the dimensions when Flex
    /// counts as `(0, 0)` (a homomorphism, hence associative in dimension). Products are *not*
    /// associative as types: `Flex·Real(0,0) = Flex` (§2.5), see
    /// `products_associate_only_up_to_flex`.
    #[test]
    fn products_commute_and_add_dimensions(a in arb_type(), b in arb_type(), c in arb_type()) {
        prop_assert_eq!(mul_type(a, b), mul_type(b, a));
        let dim = |t: Type| match t { Type::Real(d) => d, _ => Dim::ONE };
        let ab = mul_type(a, b).unwrap();
        prop_assert_eq!(dim(ab), dim(a).checked_mul(dim(b)).unwrap());
        let l = mul_type(ab, c).unwrap();
        let r = mul_type(a, mul_type(b, c).unwrap()).unwrap();
        prop_assert_eq!(dim(l), dim(r));
        // A product is Flex only when one factor is Flex and the other Flex or dimensionless.
        if ab == Type::Flex {
            prop_assert!([a, b].contains(&Type::Flex) && dim(a).is_one() && dim(b).is_one());
        }
        // With no Flex factor, products are plain exponent sums: associative.
        if ![a, b, c].contains(&Type::Flex) {
            prop_assert_eq!(l, r);
        }
        prop_assert_eq!(mul_type(a, Type::Flex), Some(if a == Type::ONE { Type::Flex } else { a }));
    }

    #[test]
    fn exponents_add_and_subtract(l1 in -9i64..9, a1 in -9i64..9, l2 in -9i64..9, a2 in -9i64..9) {
        let (x, y) = (Dim::new(l1, a1), Dim::new(l2, a2));
        let prod = mul_type(Type::Real(x), Type::Real(y)).unwrap();
        prop_assert_eq!(prod, Type::Real(Dim::new(l1 + l2, a1 + a2)));
        let quot = div_type(Type::Real(x), Type::Real(y)).unwrap();
        prop_assert_eq!(quot, Type::Real(Dim::new(l1 - l2, a1 - a2)));
        // a / b == a * b^-1
        let inv = div_type(Type::ONE, Type::Real(y)).unwrap();
        prop_assert_eq!(Some(quot), mul_type(Type::Real(x), inv));
        // (a · b) / b == a
        prop_assert_eq!(div_type(prod, Type::Real(y)), Some(Type::Real(x)));
        // sqrt(d²) == d
        prop_assert_eq!(x.checked_pow(2).unwrap().sqrt(), Some(x));
    }

    /// The checker agrees with the algebra on whole expressions: typecheck(e1 op e2) ==
    /// op(typecheck(e1), typecheck(e2)).
    #[test]
    fn typecheck_is_compositional(i in 0usize..6, j in 0usize..6, op in 0usize..5) {
        let atoms = ["width", "tilt", "holes", "3", "width * width", "1 / tilt"];
        let env = Env::new()
            .param("width", ParamUnit::Mm)
            .param("tilt", ParamUnit::Deg)
            .param("holes", ParamUnit::Count);
        let t = |s: &str| typecheck(&parse(s).unwrap(), &env).ok();
        let (a, b) = (atoms[i], atoms[j]);
        let (ta, tb) = (t(a).unwrap(), t(b).unwrap());
        let (sym, want) = match op {
            0 => ("*", mul_type(ta, tb)),
            1 => ("/", div_type(ta, tb)),
            2 => ("+", unify(ta, tb)),
            3 => ("-", unify(ta, tb)),
            _ => ("%", unify(ta, tb)),
        };
        prop_assert_eq!(t(&format!("({a}) {sym} ({b})")), want);
    }
}

/// §2.5 as written: a Flex coefficient times a dimensionless *product* stays Flex, so typing
/// depends on association. `2 * width / width` is `1`; `2 * (width / width)` is `flex`.
#[test]
fn products_associate_only_up_to_flex() {
    let env = Env::new().param("width", ParamUnit::Mm);
    let t = |s: &str| typecheck(&parse(s).unwrap(), &env).unwrap();
    assert_eq!(t("2 * width / width"), Type::ONE);
    assert_eq!(t("2 * (width / width)"), Type::Flex);
    let (f, l) = (Type::Flex, Type::LENGTH);
    let inv = div_type(Type::ONE, l).unwrap();
    assert_eq!(mul_type(mul_type(f, l).unwrap(), inv), Some(Type::ONE));
    assert_eq!(mul_type(f, mul_type(l, inv).unwrap()), Some(Type::Flex));
}

#[test]
fn deep_trees_round_trip_at_the_nesting_limit() {
    // Wrap until one more wrapper would exceed 64 levels, in every recursive position.
    let mut e = Expr::ident("x");
    for k in 0.. {
        let next = match k % 5 {
            0 => Expr::unary(UnaryOp::Neg, e.clone()),
            1 => Expr::binary(BinaryOp::Pow, Expr::num(2.0), e.clone()),
            2 => Expr::cond(Expr::Bool(true), e.clone(), Expr::num(1.0)),
            3 => Expr::call("f", vec![e.clone()]),
            _ => Expr::binary(BinaryOp::Sub, Expr::num(1.0), e.clone()),
        };
        if nesting(&next) > 64 {
            break;
        }
        e = next;
    }
    assert!(nesting(&e) >= 63, "{}", nesting(&e));
    let c = canonical(&e);
    assert_eq!(parse(&c).unwrap(), e, "{c}");
    let too_deep = Expr::unary(UnaryOp::Not, Expr::call("f", vec![e]));
    assert!(nesting(&too_deep) > 64);
    let err = parse(&canonical(&too_deep)).unwrap_err();
    assert_eq!(err.expected, "at most 64 nesting levels");
}
