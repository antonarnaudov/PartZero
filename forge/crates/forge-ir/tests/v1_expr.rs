//! W1 — the expression language of SPEC-v1 §2.3–§2.8 in `forge_ir::v1::expr`: parser,
//! canonical printer, type checker, scopes, dependency graph and the validation hook.
//! (Values are `forge-params`' tests; the shared I9 fixtures run in `v1_conformance.rs`.)

#![allow(clippy::float_cmp)] // exact comparisons are the point

use std::path::{Path, PathBuf};

use forge_ir::v1::expr::{
    self, BinaryOp, Dim, Env, Expr, ExprScope, ParamGraph, ParamId, Type, UnaryOp, Unit, canonical,
    check_text, parse, typecheck,
};
use forge_ir::v1::{self, FieldType, LoadError, ParamUnit, ValidationError};
use serde_json::{Value, json};

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../corpus/v1")
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn canon(text: &str) -> String {
    canonical(&parse(text).unwrap_or_else(|e| panic!("{text:?}: {e:?}")))
}

fn syntax_error(text: &str) -> bool {
    parse(text).is_err()
}

/// The fixture environment of `expressions/cases.json`.
fn env() -> Env {
    Env::new()
        .param("width", ParamUnit::Mm)
        .param("depth", ParamUnit::Mm)
        .param("holes", ParamUnit::Count)
        .param("tilt", ParamUnit::Deg)
        .param("half", ParamUnit::Ratio)
        .param("lid", ParamUnit::Bool)
        .param("off", ParamUnit::Bool)
}

fn ty(text: &str) -> Result<String, &'static str> {
    typecheck(&parse(text).unwrap(), &env())
        .map(|t| t.notation())
        .map_err(|e| e.code)
}

fn at(text: &str, field: FieldType) -> Result<(), &'static str> {
    check_text(text, &env(), field)
        .map(|_| ())
        .map_err(|e| e.code)
}

// ---- grammar (§2.3) -----------------------------------------------------------------------------

#[test]
fn grammar_builds_the_documented_trees() {
    let n = Expr::num;
    let id = Expr::ident;
    let b = Expr::binary;
    assert_eq!(
        parse("1 + 2 * 3").unwrap(),
        b(BinaryOp::Add, n(1.0), b(BinaryOp::Mul, n(2.0), n(3.0)))
    );
    assert_eq!(
        parse("1 - 2 - 3").unwrap(),
        b(BinaryOp::Sub, b(BinaryOp::Sub, n(1.0), n(2.0)), n(3.0))
    );
    // Right-associative power; -a^2 = -(a^2); a^-1 is allowed.
    assert_eq!(
        parse("2 ^ 3 ^ 2").unwrap(),
        b(BinaryOp::Pow, n(2.0), b(BinaryOp::Pow, n(3.0), n(2.0)))
    );
    assert_eq!(
        parse("-a ^ 2").unwrap(),
        Expr::unary(UnaryOp::Neg, b(BinaryOp::Pow, id("a"), n(2.0)))
    );
    assert_eq!(
        parse("a ^ -1").unwrap(),
        b(BinaryOp::Pow, id("a"), Expr::unary(UnaryOp::Neg, n(1.0)))
    );
    // ?: is right-associative in its else branch; the condition is an or_expr.
    assert_eq!(
        parse("a ? b : c ? d : e").unwrap(),
        Expr::cond(id("a"), id("b"), Expr::cond(id("c"), id("d"), id("e")))
    );
    assert_eq!(parse("true").unwrap(), Expr::Bool(true));
    assert_eq!(parse("f()").unwrap(), Expr::call("f", vec![]));
    assert_eq!(
        parse("sin (30)").unwrap(),
        Expr::call("sin", vec![n(30.0)]),
        "[W0-15] a call after whitespace"
    );
    assert_eq!(
        parse("12mm").unwrap(),
        Expr::Num {
            value: 12.0,
            unit: Some(Unit::Mm)
        }
    );
    assert_eq!(
        parse("12 \t in").unwrap(),
        Expr::Num {
            value: 12.0,
            unit: Some(Unit::In)
        }
    );
    // A unit is recognised only directly after a number: elsewhere it is an identifier.
    assert_eq!(
        parse("mm * in").unwrap(),
        b(BinaryOp::Mul, id("mm"), id("in"))
    );
    assert_eq!(parse("-(2)").unwrap(), Expr::unary(UnaryOp::Neg, n(2.0)));
    assert_eq!(parse("((((x))))").unwrap(), id("x"));
}

#[test]
fn numbers_are_correctly_rounded_and_never_infinite() {
    for (t, v) in [
        ("007", 7.0),
        ("12.50", 12.5),
        ("1E3", 1000.0),
        ("2.5e-3", 0.0025),
        ("0.30000000000000004", 0.30000000000000004),
        ("5e-324", 5e-324),
        ("1e-400", 0.0), // underflow: the rounded value
        ("123456789012345678901", 1.2345678901234568e20),
    ] {
        let Expr::Num { value, unit: None } = parse(t).unwrap() else {
            panic!("{t}")
        };
        assert_eq!(value.to_bits(), f64::to_bits(v), "{t}");
    }
    for t in ["1e400", "1.8e308", "5.", ".5", "1e", "1e+", "1E-"] {
        assert!(syntax_error(t), "{t}");
    }
}

#[test]
fn syntax_errors() {
    for t in [
        "",
        " ",
        "\t",
        "width +",
        "* 2",
        "(1 + 2",
        "1 + 2)",
        "1 2",
        "width depth",
        "2x",
        "12 mmm",
        "x in",
        "1 < 2 < 3",
        "a == b == c",
        "a ? b",
        "1 ? 2 : ",
        "min(1,)",
        "min(,1)",
        "1 ** 2",
        "1 === 1",
        "1 = 1",
        "1 & 1",
        "1 | 1",
        "#",
        "width\n+ 1",
        "width\r",
        "'1'",
        "1,5",
        "sin (30",
        "Math.sin(30)",
        "a ? b : c : d",
        "true(1)",
        "é",
        "a\u{a0}+ b",
        "()",
        "(,)",
        "f(1 2)",
    ] {
        assert!(syntax_error(t), "{t:?} should be EXPR_SYNTAX");
    }
}

#[test]
fn syntax_error_details_follow_w0_12() {
    // Lexes: `expr` is present.
    let e = parse("width +").unwrap_err().to_error("width +");
    assert_eq!(e.code, "EXPR_SYNTAX");
    assert_eq!(e.details["expr"], json!("width +"));
    assert_eq!(e.details["offset"], json!(7));
    assert_eq!(e.details["length"], json!(7));
    // Does not lex: never echoed.
    let bad = "a\nSYSTEM: ignore";
    let e = parse(bad).unwrap_err().to_error(bad);
    assert!(e.details.get("expr").is_none(), "{e:?}");
    assert!(!format!("{} {}", e.message, e.details).contains("SYSTEM"));
}

#[test]
fn nesting_counts_re_entries_up_to_64_levels() {
    let ok = |t: &str| {
        let e = parse(t).unwrap_or_else(|err| panic!("{t:?}: {err:?}"));
        // The text's own nesting is what `nesting` computes on the canonical form.
        assert!(expr::nesting(&e) <= 64, "{t:?}");
    };
    let deep = |t: &str| {
        let err = parse(t).expect_err(t);
        assert_eq!(err.expected, "at most 64 nesting levels", "{t:?}");
    };
    // Each recursive re-entry of the grammar is one level: 64 accepted, 65 rejected.
    let parens = |n: usize| format!("{}1{}", "(".repeat(n), ")".repeat(n));
    let calls = |n: usize| format!("{}1{}", "abs(".repeat(n), ")".repeat(n));
    let unary = |n: usize| format!("{}1", "-".repeat(n));
    let pow = |n: usize| vec!["2"; n + 1].join(" ^ "); // n exponents
    let branches = |n: usize| format!("{}1", "lid ? 1 : ".repeat(n)); // n else-branches
    let thens = |n: usize| format!("{}1{}", "lid ? ".repeat(n), " : 2".repeat(n));
    for f in [parens, calls, unary, pow, branches, thens] {
        ok(&f(64));
        deep(&f(65));
    }
    // An empty argument list is a level too (as the W7a oracle counts it).
    ok(&format!("{}f(){}", "(".repeat(63), ")".repeat(63)));
    deep(&format!("{}f(){}", "(".repeat(64), ")".repeat(64)));
    // Mixed: a level each.
    ok(&format!("{}1{}", "-abs(".repeat(32), ")".repeat(32)));
    deep(&format!("{}1{}", "-abs(".repeat(32), ")".repeat(32)).replacen('1', "-1", 1));
    // Not levels: left-associative chains (loops of the grammar), comparisons, and the
    // condition of `?:`.
    let chain = |n: usize, op: &str| vec!["1"; n].join(op);
    for (op, n) in [
        ("+", 2000),
        ("-", 2000),
        ("*", 2000),
        ("/", 2000),
        ("%", 2000),
        ("&&", 1300),
        ("||", 1300),
    ] {
        let e = parse(&chain(n, op)).unwrap();
        assert_eq!(e.height() as usize, n, "{op}");
        assert_eq!(expr::nesting(&e), 0, "{op}");
    }
    ok(&format!("{} < 2 ? 1 : 2", parens(64)));
    ok(&format!("{} ? 1 : 2", parens(64).replace('1', "lid")));
    deep(&format!("lid ? {} : 2", parens(64)));
    // A flat chain inside 64 levels.
    ok(&format!(
        "{}{}{}",
        "(".repeat(64),
        chain(500, "+"),
        ")".repeat(64)
    ));
    // The error is at the token that opens the 65th level.
    let t = unary(65);
    let err = parse(&t).unwrap_err();
    assert_eq!(err.offset, 65);
    assert_eq!(
        err.to_error(&t).details["expected"],
        json!("at most 64 nesting levels")
    );
    let t = parens(65);
    assert_eq!(parse(&t).unwrap_err().offset, 65);
    // Deep inputs never overflow the stack.
    assert!(syntax_error(&"-".repeat(4000)));
    assert!(syntax_error(&"(".repeat(4000)));
    assert!(syntax_error(&format!("{}1", "f(".repeat(1000))));
    assert!(syntax_error(&vec!["2"; 2000].join("^")));
}

#[test]
fn the_length_limit_is_4096_bytes() {
    // The longest flat chain: 2048 operands in 4095 bytes, height 2048, nesting 0.
    let flat = vec!["1"; 2048].join("+");
    assert_eq!(flat.len(), 4095);
    let e = parse(&flat).unwrap();
    assert_eq!(e.height(), 2048);
    assert_eq!(typecheck(&e, &env()).unwrap(), Type::Flex);
    assert_eq!(parse(&canonical(&e)).is_ok(), canonical(&e).len() <= 4096);
    let wide = format!("({})", vec!["1"; 1300].join(",")); // not an expression anyway
    assert!(syntax_error(&wide));
    let max_len = format!("x{}", " ".repeat(4095));
    assert_eq!(max_len.len(), 4096);
    assert!(parse(&max_len).is_ok());
    let err = parse(&format!("{max_len} ")).unwrap_err();
    assert_eq!((err.offset, err.expected), (4096, "at most 4096 bytes"));
}

/// Stack safety: the deepest trees the limits allow (a 4096-byte flat chain is ~2048 levels
/// high along its left spine, inside up to 64 levels of real nesting) are parsed, printed,
/// typed, compared, cloned and dropped on a 1 MiB stack (the wasm32 default) in a debug build.
#[test]
fn the_deepest_accepted_trees_fit_a_one_mebibyte_stack() {
    const STACK: usize = 1 << 20;
    let inputs: Vec<String> = vec![
        vec!["width"; 600].join("+"),
        vec!["1"; 2048].join("+"),
        format!(
            "{}{}{}",
            "(".repeat(64),
            vec!["1"; 1980].join("*"),
            ")".repeat(64)
        ),
        // Alternate chains and nesting: every level holds a chain whose right operand nests.
        {
            let mut t = String::from("1");
            for _ in 0..31 {
                t = format!("{}-({t})", "1+".repeat(60));
            }
            t
        },
        vec!["lid"; 800].join("&&"),
        format!("{}||lid", vec!["width<1"; 400].join("||")),
    ];
    std::thread::Builder::new()
        .stack_size(STACK)
        .spawn(move || {
            let env = env();
            for t in &inputs {
                assert!(t.len() <= 4096, "{}", t.len());
                let e = parse(t).unwrap_or_else(|err| panic!("{err:?}"));
                let c = canonical(&e);
                if c.len() <= 4096 {
                    assert!(parse(&c).unwrap() == e);
                }
                let _ = typecheck(&e, &env);
                let copy = e.clone();
                assert!(copy == e);
                let _ = e.identifiers().len() + e.preorder().len();
                drop(copy);
            }
        })
        .unwrap()
        .join()
        .unwrap();
}

// ---- canonical form (§2.4) ------------------------------------------------------------------

#[test]
fn canonical_form_examples() {
    for (t, c) in [
        ("  width   -12 ", "width - 12"),
        ("width\t*\t2", "width * 2"),
        ("12mm", "12 mm"),
        ("1E3", "1000"),
        ("1e21", "1e+21"),
        ("1e20", "100000000000000000000"),
        ("0.000001", "0.000001"),
        ("0.0000001", "1e-7"),
        ("-0", "-0"),
        ("--3", "--3"),
        ("-(2)", "-2"),
        ("-2 ^ 2", "-(2 ^ 2)"),
        ("!(a ^ b)", "!(a ^ b)"),
        ("(-2) ^ 2", "(-2) ^ 2"),
        ("(2 ^ 3) ^ 2", "(2 ^ 3) ^ 2"),
        ("2 ^ -2 ^ 2", "2 ^ -(2 ^ 2)"),
        ("3 ^ (1 + 1)", "3 ^ (1 + 1)"),
        ("(2 / 3) * 4", "2 / 3 * 4"),
        ("1 - (2 - 3)", "1 - (2 - 3)"),
        ("1 - (2 + 3)", "1 - (2 + 3)"),
        ("(1 - 2) + 3", "1 - 2 + 3"),
        ("a * (b / c)", "a * (b / c)"),
        ("a || (b || c)", "a || (b || c)"),
        ("(a || b) && c", "(a || b) && c"),
        ("(a < b) == c", "(a < b) == c"),
        ("(a + b) < c", "a + b < c"),
        ("lid ? (off ? 1 : 2) : 3", "lid ? off ? 1 : 2 : 3"),
        ("(lid ? off : lid) ? 1 : 2", "(lid ? off : lid) ? 1 : 2"),
        ("lid ? 1 : (off ? 2 : 3)", "lid ? 1 : off ? 2 : 3"),
        ("(lid ? 1 : 2) * 3", "(lid ? 1 : 2) * 3"),
        ("max( a ,b,   c )", "max(a, b, c)"),
        ("f((a + b))", "f(a + b)"),
        ("-(a + b)", "-(a + b)"),
        ("-(-a)", "--a"),
        ("1 - -2", "1 - -2"),
        ("2 * -x", "2 * -x"),
        ("12 mm ^ 2", "12 mm ^ 2"),
        ("PI * 10 ^ 2", "PI * 10 ^ 2"),
    ] {
        assert_eq!(canon(t), c, "{t:?}");
        assert_eq!(canon(c), c, "{c:?} is a fixed point");
        assert_eq!(parse(c).unwrap(), parse(t).unwrap(), "{t:?}");
    }
}

// ---- types (§2.5) -----------------------------------------------------------------------------

#[test]
fn typing_table_rows() {
    // bare number, PI → Flex; unit literals.
    assert_eq!(ty("8"), Ok("flex".into()));
    assert_eq!(ty("PI"), Ok("flex".into()));
    assert_eq!(ty("2 cm"), Ok("mm".into()));
    assert_eq!(ty("1 in"), Ok("mm".into()));
    assert_eq!(ty("30 deg"), Ok("deg".into()));
    // parameters.
    assert_eq!(ty("width"), Ok("mm".into()));
    assert_eq!(ty("tilt"), Ok("deg".into()));
    assert_eq!(ty("holes"), Ok("1".into()));
    assert_eq!(ty("half"), Ok("1".into()));
    assert_eq!(ty("lid"), Ok("bool".into()));
    // unify: + - % comparisons min max clamp hypot branches.
    assert_eq!(ty("width - 12"), Ok("mm".into()));
    assert_eq!(ty("12 - width"), Ok("mm".into()));
    assert_eq!(ty("1 + 2"), Ok("flex".into()));
    assert_eq!(ty("width % 7"), Ok("mm".into()));
    assert_eq!(ty("width + holes"), Err("EXPR_UNIT_MISMATCH"));
    assert_eq!(ty("holes - 1"), Ok("1".into()));
    assert_eq!(ty("width < 3"), Ok("bool".into()));
    assert_eq!(ty("width < tilt"), Err("EXPR_UNIT_MISMATCH"));
    assert_eq!(ty("min(width, 3, depth)"), Ok("mm".into()));
    assert_eq!(ty("max(3, 4)"), Ok("flex".into()));
    assert_eq!(ty("clamp(tilt, 0, 90)"), Ok("deg".into()));
    assert_eq!(ty("hypot(3, width)"), Ok("mm".into()));
    assert_eq!(ty("lid ? 3 : width"), Ok("mm".into()));
    assert_eq!(ty("lid ? tilt : width"), Err("EXPR_UNIT_MISMATCH"));
    // products.
    assert_eq!(ty("2 * 3"), Ok("flex".into()));
    assert_eq!(ty("2 * width"), Ok("mm".into()));
    assert_eq!(ty("holes * 20"), Ok("flex".into()), "Flex·Real(0,0) = Flex");
    assert_eq!(ty("width * width"), Ok("mm^2".into()));
    assert_eq!(ty("width * tilt"), Ok("mm*deg".into()));
    assert_eq!(ty("half * holes"), Ok("1".into()));
    // quotients.
    assert_eq!(ty("6 / 3"), Ok("flex".into()));
    assert_eq!(ty("1 / width"), Ok("mm^-1".into()));
    assert_eq!(ty("180 / holes"), Ok("flex".into()));
    assert_eq!(ty("width / 2"), Ok("mm".into()));
    assert_eq!(ty("holes / 3"), Ok("flex".into()));
    assert_eq!(ty("width / depth"), Ok("1".into()));
    assert_eq!(ty("tilt / width"), Ok("mm^-1*deg".into()));
    // unary minus, abs, floor, ceil, round keep the type.
    for f in ["-", "abs", "floor", "ceil", "round"] {
        let t = if f == "-" {
            "-width".to_string()
        } else {
            format!("{f}(width)")
        };
        assert_eq!(ty(&t), Ok("mm".into()), "{t}");
    }
    // powers.
    assert_eq!(ty("2 ^ 3"), Ok("flex".into()));
    assert_eq!(ty("half ^ 2"), Ok("1".into()));
    assert_eq!(ty("2 ^ holes"), Ok("flex".into()));
    assert_eq!(ty("2 ^ width"), Err("EXPR_UNIT_MISMATCH"));
    assert_eq!(ty("width ^ 2"), Ok("mm^2".into()));
    assert_eq!(
        ty("width ^ 2.0"),
        Ok("mm^2".into()),
        "[W0-15] fractional zero"
    );
    assert_eq!(ty("width ^ -1"), Ok("mm^-1".into()));
    assert_eq!(ty("width ^ (-3)"), Ok("mm^-3".into()));
    assert_eq!(ty("width ^ 0"), Ok("1".into()));
    assert_eq!(ty("width ^ 2.5"), Err("EXPR_UNIT_MISMATCH"));
    assert_eq!(ty("width ^ holes"), Err("EXPR_UNIT_MISMATCH"));
    assert_eq!(ty("width ^ (1 + 1)"), Err("EXPR_UNIT_MISMATCH"));
    assert_eq!(ty("width ^ 2 mm"), Err("EXPR_UNIT_MISMATCH"));
    assert_eq!(ty("tilt ^ 2"), Ok("deg^2".into()));
    // sqrt.
    assert_eq!(ty("sqrt(2)"), Ok("flex".into()));
    assert_eq!(ty("sqrt(width * depth)"), Ok("mm".into()));
    assert_eq!(ty("sqrt(half)"), Ok("1".into()));
    assert_eq!(ty("sqrt(width)"), Err("EXPR_UNIT_MISMATCH"));
    // trigonometry.
    assert_eq!(ty("sin(30)"), Ok("flex".into()));
    assert_eq!(ty("cos(tilt)"), Ok("1".into()));
    assert_eq!(ty("tan(holes)"), Err("EXPR_UNIT_MISMATCH"));
    assert_eq!(ty("sin(width)"), Err("EXPR_UNIT_MISMATCH"));
    assert_eq!(ty("asin(0.5)"), Ok("deg".into()));
    assert_eq!(ty("acos(half)"), Ok("deg".into()));
    assert_eq!(ty("atan(tilt)"), Err("EXPR_UNIT_MISMATCH"));
    assert_eq!(ty("atan2(width, depth)"), Ok("deg".into()));
    assert_eq!(ty("atan2(1, 2)"), Ok("deg".into()));
    assert_eq!(ty("atan2(width, 3 deg)"), Err("EXPR_UNIT_MISMATCH"));
    // booleans.
    assert_eq!(ty("!lid && off || lid"), Ok("bool".into()));
    assert_eq!(ty("!width"), Err("EXPR_TYPE_MISMATCH"));
    assert_eq!(ty("width && lid"), Err("EXPR_TYPE_MISMATCH"));
    assert_eq!(ty("width ? 1 : 2"), Err("EXPR_TYPE_MISMATCH"));
    assert_eq!(ty("lid ? 1 : lid"), Err("EXPR_TYPE_MISMATCH"));
    assert_eq!(ty("lid ? off : lid"), Ok("bool".into()));
    assert_eq!(ty("lid == off"), Ok("bool".into()));
    assert_eq!(ty("lid == 1"), Err("EXPR_TYPE_MISMATCH"));
    assert_eq!(ty("lid < off"), Err("EXPR_TYPE_MISMATCH"));
    assert_eq!(ty("-lid"), Err("EXPR_TYPE_MISMATCH"));
    assert_eq!(ty("lid + 1"), Err("EXPR_TYPE_MISMATCH"));
    assert_eq!(ty("abs(lid)"), Err("EXPR_TYPE_MISMATCH"));
    assert_eq!(ty("lid ^ 2"), Err("EXPR_TYPE_MISMATCH"));
    // Both branches are type-checked even though only one is evaluated.
    assert_eq!(ty("lid ? 1 : width + tilt"), Err("EXPR_UNIT_MISMATCH"));
}

#[test]
fn use_site_rules() {
    use FieldType::*;
    // The everyday forms of §2.5 and the classic mistakes.
    assert_eq!(at("width - 12", Length), Ok(()));
    assert_eq!(at("(width - 12) / (holes - 1)", Length), Ok(()));
    assert_eq!(at("10 * sin(30)", Length), Ok(()));
    assert_eq!(at("holes * 20", Length), Ok(()));
    assert_eq!(at("width * sin(tilt)", Length), Ok(()));
    assert_eq!(at("width + holes", Length), Err("EXPR_UNIT_MISMATCH"));
    assert_eq!(at("sin(tilt)", Length), Err("EXPR_UNIT_MISMATCH"));
    assert_eq!(at("width * width", Length), Err("EXPR_UNIT_MISMATCH"));
    assert_eq!(at("tilt + 5 mm", Angle), Err("EXPR_UNIT_MISMATCH"));
    // Flex takes the field's dimension; count takes 1 or Flex; bool takes Bool.
    assert_eq!(at("45", Angle), Ok(()));
    assert_eq!(at("holes", Count), Ok(()));
    assert_eq!(
        at("7 / 2", Count),
        Ok(()),
        "integrality is an evaluation check"
    );
    assert_eq!(at("width / 7", Count), Err("EXPR_UNIT_MISMATCH"));
    assert_eq!(at("width / depth", Ratio), Ok(()));
    assert_eq!(at("lid", Bool), Ok(()));
    assert_eq!(at("width", Bool), Err("EXPR_TYPE_MISMATCH"));
    assert_eq!(at("lid", Length), Err("EXPR_TYPE_MISMATCH"));
    assert_eq!(at("width > 1", Count), Err("EXPR_TYPE_MISMATCH"));
    // Details carry expected/found in [W0-15] notation.
    let e = check_text("width * width", &env(), Length).unwrap_err();
    assert_eq!(
        e.details,
        json!({ "expr": "width * width", "subexpr": "width * width", "expected": "mm", "found": "mm^2" })
    );
    let e = check_text("1 + (width + tilt)", &env(), Length).unwrap_err();
    assert_eq!(e.details["subexpr"], json!("width + tilt"));
    assert_eq!(e.details["expr"], json!("1 + (width + tilt)"));
}

#[test]
fn names_functions_and_arity() {
    let mut env = env();
    env.add_feature("base");
    env.add_other_part("inner", "lid_part");
    let err = |t: &str| check_text(t, &env, FieldType::Length).unwrap_err();
    let e = err("thickness");
    assert_eq!(e.code, "EXPR_UNKNOWN_NAME");
    assert_eq!(e.details["is_feature"], json!(false));
    let e = err("base + 1");
    assert_eq!(
        (e.code, e.details["is_feature"].clone()),
        ("EXPR_UNKNOWN_NAME", json!(true))
    );
    let e = err("Width");
    assert_eq!(e.details["similar"], json!(["width"]));
    assert_eq!(
        err("sin").code,
        "EXPR_UNKNOWN_NAME",
        "a function name used as a value"
    );
    assert_eq!(err("mm").code, "EXPR_UNKNOWN_NAME");
    let e = err("inner * 2");
    assert_eq!(e.code, "EXPR_SCOPE");
    assert_eq!(e.details, json!({ "name": "inner", "part": "lid_part" }));
    let e = err("sinn(30)");
    assert_eq!(e.code, "EXPR_UNKNOWN_FUNCTION");
    // Closest first (edit distance), then catalogue order; at most three.
    assert_eq!(e.details["similar"], json!(["sin", "min", "asin"]));
    assert_eq!(err("width(2)").code, "EXPR_UNKNOWN_FUNCTION");
    assert_eq!(err("PI(1)").code, "EXPR_UNKNOWN_FUNCTION");
    for (t, n) in [
        ("min(1)", 1),
        ("max()", 0),
        ("sin(1, 2)", 2),
        ("clamp(1, 2)", 2),
        ("atan2(1)", 1),
        ("abs()", 0),
        ("hypot(1, 2, 3)", 3),
    ] {
        let e = err(t);
        assert_eq!(e.code, "EXPR_ARITY", "{t}");
        assert_eq!(e.details["found"], json!(n), "{t}");
    }
    assert!(check_text("min(1, 2, 3, 4, 5)", &env, FieldType::Length).is_ok());
    // One error per expression: the first problem of a bottom-up, left-to-right check. A
    // call's name and arity come before its arguments; a condition before its branches.
    assert_eq!(err("nope + foo(1)").code, "EXPR_UNKNOWN_NAME");
    assert_eq!(err("foo(nope)").code, "EXPR_UNKNOWN_FUNCTION");
    assert_eq!(err("min(nope)").code, "EXPR_ARITY");
    assert_eq!(err("width + tilt + nope").code, "EXPR_UNIT_MISMATCH");
    assert_eq!(err("nope + (width + tilt)").code, "EXPR_UNKNOWN_NAME");
    assert_eq!(err("width ? nope : 1").code, "EXPR_TYPE_MISMATCH");
    assert_eq!(err("lid ? nope : width + tilt").code, "EXPR_UNKNOWN_NAME");
    assert_eq!(err("min(width, tilt, lid)").code, "EXPR_UNIT_MISMATCH");
    assert_eq!(err("min(lid, width + tilt)").code, "EXPR_UNIT_MISMATCH");
    assert_eq!(err("min(width, lid)").code, "EXPR_TYPE_MISMATCH");
    assert_eq!(err("lid + nope").code, "EXPR_UNKNOWN_NAME");
}

#[test]
fn unit_notation_is_injective() {
    let mut seen = std::collections::BTreeMap::new();
    for l in -5..=5 {
        for a in -5..=5 {
            let d = Dim::new(l, a);
            if let Some(prev) = seen.insert(d.notation(), d) {
                panic!("{prev:?} and {d:?} print the same");
            }
        }
    }
    assert_eq!(Type::Real(Dim::new(0, 0)).notation(), "1");
}

// ---- documents: the validation hook, scopes and cycles (§2.8) ---------------------------------

fn doc(v: Value) -> v1::Document {
    serde_json::from_value(v).unwrap()
}

fn errors_with_checker(d: &v1::Document) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = match v1::validate_with(d, &expr::options()) {
        Ok(()) => vec![],
        Err(e) => e
            .into_iter()
            .map(|e| (e.code.to_string(), e.path))
            .collect(),
    };
    v.sort();
    v
}

/// Validation without W1's checker (W0's structural checks only).
fn w0_only() -> v1::ValidateOptions<'static> {
    v1::ValidateOptions {
        expr: None,
        ..Default::default()
    }
}

fn plate(params: Value, part_params: Value, distance: Value) -> v1::Document {
    doc(json!({ "schema": "aicad.ir/1", "params": params, "parts": [
        { "id": "p1", "name": "plate", "params": part_params, "features": [
            { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
                { "kind": "rect", "id": "o", "center": [0, 0], "w": 80, "h": 50 } ] },
            { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": distance } ] },
        { "id": "p2", "name": "other", "params": [{ "name": "q", "unit": "mm", "value": 1 }], "features": [] }
    ] }))
}

fn cp(code: &str, path: &str) -> (String, String) {
    (code.to_string(), path.to_string())
}

#[test]
fn scopes_follow_section_2_8() {
    let d = plate(
        json!([{ "name": "a", "unit": "mm", "value": 3 }, { "name": "b", "unit": "mm", "value": "c" }]),
        json!([{ "name": "c", "unit": "mm", "value": "a + 1" }, { "name": "e", "unit": "mm", "value": "q" }]),
        json!("a + c"),
    );
    assert_eq!(
        errors_with_checker(&d),
        vec![
            // A part parameter cannot use another part's parameter.
            cp("EXPR_SCOPE", "/parts/0/params/1/value"),
            // A document parameter cannot see part parameters at all.
            cp("EXPR_UNKNOWN_NAME", "/params/1/value"),
        ]
    );
    // Without the checker these documents are structurally valid.
    assert!(v1::validate_with(&d, &w0_only()).is_ok());
}

/// SPEC-v1 §0.5 rule 4 step 5: every default entry point runs W1's checker; `expr: None` opts
/// out.
#[test]
fn default_entry_points_run_the_checker() {
    let d = plate(
        json!([{ "name": "a", "unit": "mm", "value": "b" }, { "name": "b", "unit": "mm", "value": "a" }]),
        json!([]),
        json!("nope + 1"),
    );
    let want = vec![
        cp("EXPR_UNKNOWN_NAME", "/parts/0/features/1/distance"),
        cp("PARAM_CYCLE", "/params/0/value"),
    ];
    let sorted = |errs: Vec<ValidationError>| {
        let mut v: Vec<(String, String)> = errs
            .into_iter()
            .map(|e| (e.code.to_string(), e.path))
            .collect();
        v.sort();
        v
    };
    assert_eq!(sorted(v1::validate(&d).unwrap_err()), want);
    assert_eq!(errors_with_checker(&d), want);
    assert!(v1::ValidateOptions::default().expr.is_some());
    let text = v1::to_json(&d);
    for r in [
        v1::from_json(&text),
        forge_ir::VersionedDocument::from_json(&text).map(forge_ir::VersionedDocument::into_v1),
    ] {
        assert_eq!(code_paths(&r), Ok(want.clone()));
    }
    assert!(v1::validate_with(&d, &w0_only()).is_ok());
    assert!(load_with(&text, &w0_only()).is_ok());
}

#[test]
fn cycles_are_reported_once_at_their_first_parameter() {
    let d = plate(
        json!([
            { "name": "a", "unit": "mm", "value": "b + 1" },
            { "name": "b", "unit": "mm", "value": "c" },
            { "name": "c", "unit": "mm", "value": "a" },
            { "name": "s", "unit": "mm", "value": "s * 1" },
            { "name": "t", "unit": "mm", "value": 5, "max": "u" },
            { "name": "u", "unit": "mm", "value": "t * 2" }
        ]),
        json!([{ "name": "k", "unit": "mm", "value": "m" }, { "name": "m", "unit": "mm", "value": "k + a" }]),
        json!(8),
    );
    let errs = v1::validate_with(&d, &expr::options()).unwrap_err();
    let cycles: Vec<(&str, Value)> = errs
        .iter()
        .filter(|e| e.code == "PARAM_CYCLE")
        .map(|e| (e.path.as_str(), e.details["cycle"].clone()))
        .collect();
    assert_eq!(
        cycles,
        vec![
            ("/params/0/value", json!(["a", "b", "c", "a"])),
            ("/params/3/value", json!(["s", "s"])),
            // A bound that uses a parameter is a dependency too.
            ("/params/4/max", json!(["t", "u", "t"])),
            ("/parts/0/params/0/value", json!(["k", "m", "k"])),
        ]
    );
    assert_eq!(errs.len(), 4, "{errs:?}");
}

/// Choices the SPEC leaves open (flagged in the W1 report), pinned: bounds are dependency
/// edges (a bound that uses the bounded parameter itself is a cycle), one `PARAM_CYCLE` per
/// strongly connected component, and an expression that fails its type check still
/// contributes its edges.
#[test]
fn cycle_rules_are_pinned() {
    let cycles = |params: Value| -> Vec<(String, Value)> {
        let d = plate(params, json!([]), json!(8));
        match v1::validate(&d) {
            Ok(()) => vec![],
            Err(errs) => errs
                .into_iter()
                .filter(|e| e.code == "PARAM_CYCLE")
                .map(|e| (e.path, e.details["cycle"].clone()))
                .collect(),
        }
    };
    let at = |p: &str, c: Value| vec![(p.to_string(), c)];
    // A bound closing a loop through a value, and a bound using its own parameter.
    assert_eq!(
        cycles(json!([
            { "name": "a", "unit": "mm", "value": 10, "max": "b" },
            { "name": "b", "unit": "mm", "value": "a * 2" }
        ])),
        at("/params/0/max", json!(["a", "b", "a"]))
    );
    assert_eq!(
        cycles(json!([{ "name": "a", "unit": "mm", "value": 10, "min": "a - 1" }])),
        at("/params/0/min", json!(["a", "a"]))
    );
    // One error for a component with two elementary cycles through `a`.
    assert_eq!(
        cycles(json!([
            { "name": "a", "unit": "mm", "value": "b + c" },
            { "name": "b", "unit": "mm", "value": "a" },
            { "name": "c", "unit": "mm", "value": "a" }
        ])),
        at("/params/0/value", json!(["a", "b", "a"]))
    );
    // Ill-typed but parsed: the edge counts (EXPR_UNIT_MISMATCH and PARAM_CYCLE).
    let d = plate(
        json!([
            { "name": "a", "unit": "mm", "value": "b + 1 deg" },
            { "name": "b", "unit": "mm", "value": "a" }
        ]),
        json!([]),
        json!(8),
    );
    assert_eq!(
        errors_with_checker(&d),
        vec![
            cp("EXPR_UNIT_MISMATCH", "/params/0/value"),
            cp("PARAM_CYCLE", "/params/0/value")
        ]
    );
    // A bound that uses an unrelated parameter is fine.
    assert!(
        cycles(json!([
            { "name": "a", "unit": "mm", "value": 10, "max": "b" },
            { "name": "b", "unit": "mm", "value": 20 }
        ]))
        .is_empty()
    );
}

/// §7.5 details of the type rejections: `found` is a [W0-15] type notation, `expected` a type
/// notation or one of the documented words.
#[test]
fn mismatch_details_use_type_notation() {
    let words = [
        expr::EXPECTED_NUMBER,
        expr::EXPECTED_INTEGER_LITERAL,
        expr::EXPECTED_EVEN,
        expr::EXPECTED_REPRESENTABLE,
    ];
    let notation = |s: &str| {
        s == "flex"
            || s == "bool"
            || s == "1"
            || s.split('*').all(|f| {
                let (base, exp) = f.split_once('^').unwrap_or((f, "1"));
                (base == "mm" || base == "deg") && exp.parse::<i64>().is_ok_and(|e| e != 0)
            })
    };
    let env = env();
    let mut n = 0;
    for (text, field) in [
        ("width + tilt", FieldType::Length),
        ("width + lid", FieldType::Length),
        ("lid * 2", FieldType::Length),
        ("-lid", FieldType::Length),
        ("width ^ half", FieldType::Length),
        ("width ^ 4611686018427387904 * width", FieldType::Length),
        (
            "(width ^ 3000000000000000000) * (width ^ 3000000000000000000) * (width ^ 3000000000000000000) * (width ^ 3000000000000000000)",
            FieldType::Length,
        ),
        ("sqrt(width)", FieldType::Length),
        ("sin(width)", FieldType::Ratio),
        ("asin(width)", FieldType::Angle),
        ("lid ? width : lid", FieldType::Length),
        ("width ? 1 : 2", FieldType::Length),
        ("!width", FieldType::Bool),
        ("width < lid", FieldType::Bool),
        ("width", FieldType::Angle),
        ("lid", FieldType::Length),
        ("width", FieldType::Bool),
        ("min(width, tilt)", FieldType::Length),
        ("atan2(width, half)", FieldType::Angle),
    ] {
        let err = check_text(text, &env, field).expect_err(text);
        assert!(
            err.code == "EXPR_UNIT_MISMATCH" || err.code == "EXPR_TYPE_MISMATCH",
            "{text}: {err}"
        );
        let found = err.details["found"].as_str().unwrap();
        let expected = err.details["expected"].as_str().unwrap();
        assert!(notation(found), "{text}: found {found:?}");
        assert!(
            notation(expected) || words.contains(&expected),
            "{text}: expected {expected:?}"
        );
        assert_eq!(err.details["expr"], json!(canon(text)), "{text}");
        n += 1;
    }
    assert_eq!(n, 19);
}

#[test]
fn dependency_order_is_topological_with_declaration_ties() {
    let d = plate(
        json!([
            { "name": "a", "unit": "mm", "value": "b + d" },
            { "name": "b", "unit": "mm", "value": 1 },
            { "name": "c", "unit": "mm", "value": "a" },
            { "name": "d", "unit": "mm", "value": 2 }
        ]),
        json!([{ "name": "x", "unit": "mm", "value": "c" }, { "name": "y", "unit": "mm", "value": 1 }]),
        json!(8),
    );
    assert!(errors_with_checker(&d).is_empty());
    let g = ParamGraph::new(&d);
    let id = |part: Option<usize>, index| ParamId { part, index };
    let (order, blocked) = g.order();
    assert!(blocked.is_empty());
    assert_eq!(
        order,
        vec![
            id(None, 1),    // b
            id(None, 3),    // d
            id(None, 0),    // a (after b, d)
            id(None, 2),    // c
            id(Some(0), 0), // x
            id(Some(0), 1), // y
            id(Some(1), 0), // q
        ]
    );
    assert_eq!(g.dependencies(id(None, 0)), &[id(None, 1), id(None, 3)]);
}

#[test]
fn feature_fields_see_document_and_own_part_parameters() {
    let ok = plate(
        json!([{ "name": "t", "unit": "mm", "value": 4 }]),
        json!([{ "name": "u", "unit": "mm", "value": "2 * t" }]),
        json!("t + u"),
    );
    assert!(errors_with_checker(&ok).is_empty());
    let other = plate(json!([]), json!([]), json!("q"));
    assert_eq!(
        errors_with_checker(&other),
        vec![cp("EXPR_SCOPE", "/parts/0/features/1/distance")]
    );
    let feature = plate(json!([]), json!([]), json!("slab * 2"));
    assert_eq!(
        errors_with_checker(&feature),
        vec![cp("EXPR_UNKNOWN_NAME", "/parts/0/features/1/distance")]
    );
    let err = v1::validate_with(&feature, &expr::options()).unwrap_err();
    assert_eq!(err[0].details["is_feature"], json!(true));
}

#[test]
fn the_checker_does_not_duplicate_w0_expression_checks() {
    let blank = plate(json!([]), json!([]), json!("  "));
    assert_eq!(
        errors_with_checker(&blank),
        vec![cp("EXPR_SYNTAX", "/parts/0/features/1/distance")]
    );
    let long = plate(
        json!([]),
        json!([]),
        json!(format!("1{}", " ".repeat(4096))),
    );
    assert_eq!(
        errors_with_checker(&long),
        vec![cp("EXPR_SYNTAX", "/parts/0/features/1/distance")]
    );
}

#[test]
fn every_checker_error_is_an_r_code_with_object_details() {
    let d = plate(
        json!([{ "name": "a", "unit": "mm", "value": "b" }, { "name": "b", "unit": "mm", "value": "a + tilt" }]),
        json!([{ "name": "c", "unit": "bool", "value": "a > 1 ||" }]),
        json!("foo(a) + min(1)"),
    );
    let errs: Vec<ValidationError> = v1::validate_with(&d, &expr::options()).unwrap_err();
    assert!(errs.len() >= 3, "{errs:?}");
    for e in errs {
        let info = v1::codes::info(e.code).unwrap_or_else(|| panic!("{}", e.code));
        assert!(info.stage.contains('R'), "{}", e.code);
        assert!(e.details.is_object(), "{}", e.code);
        for k in e.details.as_object().unwrap().keys() {
            assert!(
                info.details.contains(&k.as_str()),
                "{}: detail {k} not in the catalogue",
                e.code
            );
        }
    }
}

// ---- the whole corpus with the checker ------------------------------------------------------

fn load_with(text: &str, opts: &v1::ValidateOptions<'_>) -> Result<v1::Document, LoadError> {
    forge_ir::VersionedDocument::from_json_with(text, opts)
        .map(forge_ir::VersionedDocument::into_v1)
}

fn code_paths(r: &Result<v1::Document, LoadError>) -> Result<Vec<(String, String)>, String> {
    match r {
        Ok(_) => Ok(vec![]),
        Err(LoadError::Invalid(errs)) => {
            let mut v: Vec<(String, String)> = errs
                .iter()
                .map(|e| (e.code.to_string(), e.path.clone()))
                .collect();
            v.sort();
            Ok(v)
        }
        Err(e) => Err(e.to_string()),
    }
}

#[test]
fn v1_programs_and_migrations_pass_the_checker() {
    let mut n = 0;
    let mut dirs = vec![corpus().join("programs")];
    for d in [
        "migration/programs",
        "migration/makerbench",
        "migration/renames",
    ] {
        dirs.push(corpus().join("conformance").join(d));
    }
    for dir in dirs {
        for e in std::fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            if !p.to_string_lossy().ends_with(".json")
                || p.to_string_lossy().ends_with(".renames.json")
            {
                continue;
            }
            let text = read(&p);
            load_with(&text, &expr::options()).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            n += 1;
        }
    }
    assert!(n >= 5 + 2 * 69, "{n} documents");
}

#[test]
fn the_checker_adds_nothing_to_non_expression_invalid_documents() {
    let f = v1::json::parse(&read(&corpus().join("conformance/invalid/documents.json"))).unwrap();
    let mut n = 0;
    for c in f["cases"].as_array().unwrap() {
        if c["parse_error"] == json!(true) {
            continue;
        }
        if c["requires"]
            .as_array()
            .is_some_and(|r| r.contains(&json!("expr")))
        {
            continue;
        }
        let text = serde_json::to_string(&c["document"]).unwrap();
        let without = code_paths(&load_with(&text, &w0_only()));
        let with = code_paths(&load_with(&text, &expr::options()));
        assert_eq!(with, without, "{}", c["id"]);
        n += 1;
    }
    assert!(n >= 150);
}

#[test]
fn query_typing_contexts_pass_the_checker() {
    let f = v1::json::parse(&read(&corpus().join("conformance/queries/typing.json"))).unwrap();
    let ctx = &f["context"];
    let base: v1::Document = serde_json::from_value(ctx.clone()).unwrap();
    v1::validate_with(&base, &expr::options()).unwrap_or_else(|e| panic!("{e:?}"));
    for c in f["cases"].as_array().unwrap() {
        let mut d = ctx.clone();
        d["parts"][0]["features"].as_array_mut().unwrap().push(json!({
            "type": "tag", "id": "tq", "name": "tq", "target": { "kind": c["kind"], "q": c["q"] }
        }));
        let text = serde_json::to_string(&d).unwrap();
        let without = code_paths(&load_with(&text, &w0_only()));
        let with = code_paths(&load_with(&text, &expr::options()));
        assert_eq!(with, without, "{}", c["id"]);
    }
}

// ---- canonical storage ------------------------------------------------------------------------

#[test]
fn canonicalize_expressions_rewrites_every_site_and_is_idempotent() {
    for e in std::fs::read_dir(corpus().join("programs")).unwrap() {
        let p = e.unwrap().path();
        let d = v1::from_json(&read(&p)).unwrap();
        let c = expr::canonicalize_expressions(&d).unwrap();
        assert_eq!(c, d, "{}: already canonical", p.display());
    }
    let d = plate(
        json!([
            { "name": "a", "unit": "mm", "value": "  8.0 " },
            { "name": "b", "unit": "mm", "value": "(a)*2", "min": "-0", "max": "1e3" },
            { "name": "on", "unit": "bool", "value": "true" },
            { "name": "neg", "unit": "mm", "value": "- 2.5" }
        ]),
        json!([]),
        json!("((b))-a"),
    );
    let c = expr::canonicalize_expressions(&d).unwrap();
    let j = serde_json::to_value(&c).unwrap();
    assert_eq!(j["params"][0]["value"], json!(8.0));
    assert_eq!(j["params"][1]["value"], json!("a * 2"));
    assert_eq!(j["params"][1]["min"], json!(0.0));
    assert!(j["params"][1]["min"].as_f64().unwrap().is_sign_positive());
    assert_eq!(j["params"][1]["max"], json!(1000.0));
    assert_eq!(j["params"][2]["value"], json!(true));
    assert_eq!(j["params"][3]["value"], json!(-2.5));
    assert_eq!(j["parts"][0]["features"][1]["distance"], json!("b - a"));
    assert_eq!(expr::canonicalize_expressions(&c).unwrap(), c);
    // Texts that do not parse are left for validation to reject.
    let bad = plate(json!([]), json!([]), json!("1 +"));
    assert_eq!(expr::canonicalize_expressions(&bad).unwrap(), bad);
}

/// Canonical storage never turns an accepted document into a rejected one: when it would (a
/// literal string whose JSON literal fails a load-time range check, or a canonical text beyond
/// 4096 bytes), the rewrite is refused with the rejections of the would-be document.
#[test]
fn canonicalize_expressions_preserves_validity_or_refuses() {
    let refused = |distance: Value, want: (&str, &str)| {
        let d = plate(
            json!([{ "name": "width", "unit": "mm", "value": 80 }]),
            json!([]),
            distance,
        );
        v1::validate(&d).unwrap_or_else(|e| panic!("{e:?}"));
        match expr::canonicalize_expressions(&d) {
            Err(expr::CanonicalizeError::Rejected(errs)) => {
                let got: Vec<(&str, &str)> =
                    errs.iter().map(|e| (e.code, e.path.as_str())).collect();
                assert_eq!(got, vec![want]);
            }
            other => panic!("{other:?}"),
        }
    };
    let at = "/parts/0/features/1/distance";
    // "-5" loads (INVALID_DISTANCE is an evaluation error of an expression) but -5 does not.
    refused(json!("-5"), ("INVALID_DISTANCE", at));
    // "1e-400" rounds to 0.
    refused(json!("1e-400"), ("INVALID_DISTANCE", at));
    // 4084 bytes of source, 4763 bytes of canonical text.
    let long = format!("min({})", vec!["width"; 680].join(","));
    assert_eq!(long.len(), 4084);
    refused(json!(long), ("EXPR_SYNTAX", at));
    // A count given as "2.5" (EXPR_NOT_INTEGER at evaluation, a rejection as a literal).
    let d = plate(
        json!([{ "name": "n", "unit": "count", "value": "2.5" }]),
        json!([]),
        json!(8),
    );
    v1::validate(&d).unwrap();
    assert!(matches!(
        expr::canonicalize_expressions(&d),
        Err(expr::CanonicalizeError::Rejected(e)) if e[0].code == "EXPR_NOT_INTEGER"
    ));
    // A rejected document is rewritten best-effort (it stays rejected).
    let bad = plate(json!([]), json!([]), json!("nope + (1)"));
    assert!(v1::validate(&bad).is_err());
    let c = expr::canonicalize_expressions(&bad).unwrap();
    assert_eq!(
        serde_json::to_value(&c).unwrap()["parts"][0]["features"][1]["distance"],
        json!("nope + 1")
    );
    // With the checker opted out, only W0's rejections count.
    let w0 = expr::canonicalize_expressions_with(&bad, &w0_only());
    assert!(w0.is_ok(), "{w0:?}");
    // Every accepted corpus document stays accepted (and is already canonical).
    for dir in ["programs", "conformance/migration/programs"] {
        for e in std::fs::read_dir(corpus().join(dir)).unwrap() {
            let p = e.unwrap().path();
            let name = p.to_string_lossy();
            if !name.ends_with(".json") || name.ends_with(".renames.json") {
                continue;
            }
            let d = v1::from_json(&read(&p)).unwrap();
            let c = expr::canonicalize_expressions(&d).unwrap_or_else(|e| panic!("{e}"));
            v1::validate(&c).unwrap();
        }
    }
}

#[test]
fn scopes_of_sites_match_param_ids() {
    let d = plate(
        json!([{ "name": "a", "unit": "mm", "value": "1" }]),
        json!([{ "name": "c", "unit": "mm", "value": "a" }]),
        json!(8),
    );
    for s in v1::expr::expr_sites(&d) {
        let id = if s.path.starts_with("/params/") {
            ParamId {
                part: None,
                index: 0,
            }
        } else {
            ParamId {
                part: Some(0),
                index: 0,
            }
        };
        assert_eq!(s.scope, id.scope());
        assert!(s.path.starts_with(&id.path()));
        assert_eq!(s.scope == ExprScope::Document, id.part.is_none());
    }
}
