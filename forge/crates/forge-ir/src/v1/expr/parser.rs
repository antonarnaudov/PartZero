//! The expression parser (SPEC-v1 §2.3 [D-8], [W0-15]): recursive descent over the grammar,
//! with the size limits enforced *while* parsing so that no input can exhaust the stack.
//!
//! **Limits** (`EXPR_SYNTAX` beyond): the text is at most [`MAX_EXPR_BYTES`] bytes, and its
//! **nesting depth** is at most [`MAX_EXPR_DEPTH`]. The SPEC does not define "nesting depth"
//! further; Forge counts what the W7a oracle counts (and the W8 TypeScript parser, except that
//! it does not count an empty argument list `f()`): one level per *recursive re-entry* of the
//! grammar, i.e. per
//! - parenthesised group `( … )`,
//! - call argument list `f( … )` (one level for the whole list, empty or not),
//! - branch of `?:` (the `then` and the `else` expression; not the condition),
//! - operand of a unary `-` or `!`,
//! - exponent of `^`.
//!
//! A left-associative chain (`a + b + c`, `a * b / c`, `p && q || r`) is a loop of the grammar,
//! not nesting: `1 + 1 + … + 1` is accepted up to the byte limit (about 2048 operands). The
//! parser's own recursion is therefore bounded by the depth limit, while an accepted tree can be
//! about 2048 levels high along its left spine; every walk over trees (printer, type checker,
//! evaluator, and `Expr`'s `Clone`, `PartialEq` and `Drop`) iterates instead of recursing
//! along left spines (tests `the_deepest_accepted_trees_*` run them on a 1 MiB stack).
//! [`super::nesting`] computes the depth of a tree's canonical text.
//!
//! A depth failure is reported at the byte offset of the token that would open the level
//! beyond the limit, with `expected: "at most 64 nesting levels"` (the oracle's wording).

use super::ast::{BinaryOp, Expr, UnaryOp, Unit};
use super::lexer::{Tok, Token, lex};
use super::types::ExprError;
use crate::v1::{MAX_EXPR_BYTES, MAX_EXPR_DEPTH};

/// Why a text is not an expression (`EXPR_SYNTAX`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntaxError {
    /// Byte offset where parsing stopped.
    pub offset: usize,
    /// What the parser expected there.
    pub expected: &'static str,
    /// `true` when the text is a valid token sequence (only then may `details.expr` echo it,
    /// [W0-12]).
    pub lexes: bool,
}

impl SyntaxError {
    /// The coded error for `text` (the text this error came from). Details:
    /// `{ "offset", "expected", "length", "expr"? }`.
    pub fn to_error(&self, text: &str) -> ExprError {
        let mut d = serde_json::json!({
            "offset": self.offset,
            "expected": self.expected,
            "length": text.len(),
        });
        if self.lexes {
            // Only grammar tokens, spaces and tabs: nothing an id or a prompt could hide in
            // beyond what an identifier can carry.
            d["expr"] = serde_json::json!(text);
        }
        ExprError::new(
            "EXPR_SYNTAX",
            format!(
                "expression syntax error at byte {}: expected {}",
                self.offset, self.expected
            ),
            d,
        )
    }
}

const DEPTH: &str = "at most 64 nesting levels";

/// Parse an expression (§2.3). Whitespace is space and tab only; units are recognised only
/// directly after a number; `true` and `false` are literals; an identifier followed by `(`
/// (after optional whitespace) is a call.
pub fn parse(text: &str) -> Result<Expr, SyntaxError> {
    if text.len() > MAX_EXPR_BYTES {
        return Err(SyntaxError {
            offset: MAX_EXPR_BYTES,
            expected: "at most 4096 bytes",
            lexes: false,
        });
    }
    let toks = lex(text)?;
    if toks.is_empty() {
        return Err(SyntaxError {
            offset: 0,
            expected: "an expression",
            lexes: false,
        });
    }
    let mut p = Parser {
        toks: &toks,
        pos: 0,
        end: text.len(),
    };
    let e = p.expr(0)?;
    if p.pos < toks.len() {
        return Err(p.err("an operator or the end of the expression"));
    }
    Ok(e)
}

struct Parser<'a> {
    toks: &'a [Token],
    pos: usize,
    end: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos).map(|t| &t.tok)
    }

    fn at(&self, t: &Tok) -> bool {
        self.peek() == Some(t)
    }

    fn offset(&self) -> usize {
        self.toks.get(self.pos).map_or(self.end, |t| t.offset)
    }

    fn err(&self, expected: &'static str) -> SyntaxError {
        SyntaxError {
            offset: self.offset(),
            expected,
            lexes: true,
        }
    }

    fn expect(&mut self, t: &Tok, what: &'static str) -> Result<(), SyntaxError> {
        if self.at(t) {
            self.pos += 1;
            Ok(())
        } else {
            Err(self.err(what))
        }
    }

    /// One nesting level deeper than `depth` (see the module documentation), or `EXPR_SYNTAX`
    /// at the current token when that exceeds [`MAX_EXPR_DEPTH`].
    fn deeper(&self, depth: u32) -> Result<u32, SyntaxError> {
        if depth + 1 > MAX_EXPR_DEPTH {
            return Err(self.err(DEPTH));
        }
        Ok(depth + 1)
    }

    /// `expr = cond ; cond = or_expr [ "?" expr ":" expr ]`
    fn expr(&mut self, depth: u32) -> Result<Expr, SyntaxError> {
        let c = self.or(depth)?;
        if !self.at(&Tok::Question) {
            return Ok(c);
        }
        self.pos += 1;
        let t = self.expr(self.deeper(depth)?)?;
        self.expect(&Tok::Colon, "':'")?;
        let o = self.expr(self.deeper(depth)?)?;
        Ok(Expr::cond(c, t, o))
    }

    fn or(&mut self, depth: u32) -> Result<Expr, SyntaxError> {
        let mut l = self.and(depth)?;
        while self.at(&Tok::OrOr) {
            self.pos += 1;
            let r = self.and(depth)?;
            l = Expr::binary(BinaryOp::Or, l, r);
        }
        Ok(l)
    }

    fn and(&mut self, depth: u32) -> Result<Expr, SyntaxError> {
        let mut l = self.cmp(depth)?;
        while self.at(&Tok::AndAnd) {
            self.pos += 1;
            let r = self.cmp(depth)?;
            l = Expr::binary(BinaryOp::And, l, r);
        }
        Ok(l)
    }

    /// `cmp_expr = add_expr [ cmp_op add_expr ]` (not associative: `a < b < c` leaves a
    /// comparison operator that nothing above accepts, so it is a syntax error).
    fn cmp(&mut self, depth: u32) -> Result<Expr, SyntaxError> {
        let l = self.add(depth)?;
        let op = match self.peek() {
            Some(Tok::Lt) => BinaryOp::Lt,
            Some(Tok::Le) => BinaryOp::Le,
            Some(Tok::Gt) => BinaryOp::Gt,
            Some(Tok::Ge) => BinaryOp::Ge,
            Some(Tok::EqEq) => BinaryOp::Eq,
            Some(Tok::Ne) => BinaryOp::Ne,
            _ => return Ok(l),
        };
        self.pos += 1;
        let r = self.add(depth)?;
        Ok(Expr::binary(op, l, r))
    }

    fn add(&mut self, depth: u32) -> Result<Expr, SyntaxError> {
        let mut l = self.mul(depth)?;
        loop {
            let op = match self.peek() {
                Some(Tok::Plus) => BinaryOp::Add,
                Some(Tok::Minus) => BinaryOp::Sub,
                _ => return Ok(l),
            };
            self.pos += 1;
            let r = self.mul(depth)?;
            l = Expr::binary(op, l, r);
        }
    }

    fn mul(&mut self, depth: u32) -> Result<Expr, SyntaxError> {
        let mut l = self.unary(depth)?;
        loop {
            let op = match self.peek() {
                Some(Tok::Star) => BinaryOp::Mul,
                Some(Tok::Slash) => BinaryOp::Div,
                Some(Tok::Percent) => BinaryOp::Rem,
                _ => return Ok(l),
            };
            self.pos += 1;
            let r = self.unary(depth)?;
            l = Expr::binary(op, l, r);
        }
    }

    /// `unary = ( "-" | "!" ) unary | power`
    fn unary(&mut self, depth: u32) -> Result<Expr, SyntaxError> {
        let op = match self.peek() {
            Some(Tok::Minus) => UnaryOp::Neg,
            Some(Tok::Not) => UnaryOp::Not,
            _ => return self.power(depth),
        };
        self.pos += 1;
        let o = self.unary(self.deeper(depth)?)?;
        Ok(Expr::unary(op, o))
    }

    /// `power = atom [ "^" unary ]` (right-associative through `unary`).
    fn power(&mut self, depth: u32) -> Result<Expr, SyntaxError> {
        let base = self.atom(depth)?;
        if !self.at(&Tok::Caret) {
            return Ok(base);
        }
        self.pos += 1;
        let exp = self.unary(self.deeper(depth)?)?;
        Ok(Expr::binary(BinaryOp::Pow, base, exp))
    }

    /// `atom = number [unit] | "true" | "false" | call | ident | "(" expr ")"`
    fn atom(&mut self, depth: u32) -> Result<Expr, SyntaxError> {
        let Some(tok) = self.peek().cloned() else {
            return Err(self.err("an operand"));
        };
        match tok {
            Tok::Num(value) => {
                self.pos += 1;
                // A unit only directly after a number (whitespace allowed: `12 mm`).
                let unit = match self.peek() {
                    Some(Tok::Ident(s)) => Unit::parse(s),
                    _ => None,
                };
                if unit.is_some() {
                    self.pos += 1;
                }
                Ok(Expr::Num { value, unit })
            }
            Tok::Ident(name) => {
                self.pos += 1;
                match name.as_str() {
                    "true" => return Ok(Expr::Bool(true)),
                    "false" => return Ok(Expr::Bool(false)),
                    _ => {}
                }
                if !self.at(&Tok::LParen) {
                    return Ok(Expr::Ident(name));
                }
                self.pos += 1;
                // One level for the argument list, empty or not (as the W7a oracle).
                let d = self.deeper(depth)?;
                let mut args = Vec::new();
                if !self.at(&Tok::RParen) {
                    loop {
                        args.push(self.expr(d)?);
                        if self.at(&Tok::Comma) {
                            self.pos += 1;
                        } else {
                            break;
                        }
                    }
                }
                self.expect(&Tok::RParen, "',' or ')'")?;
                Ok(Expr::Call { name, args })
            }
            Tok::LParen => {
                self.pos += 1;
                let e = self.expr(self.deeper(depth)?)?;
                self.expect(&Tok::RParen, "')'")?;
                Ok(e)
            }
            _ => Err(self.err("an operand")),
        }
    }
}
