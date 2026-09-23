//! The expression lexer (SPEC-v1 §2.3 [D-8], [W0-15]).

use super::SyntaxError;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Tok {
    /// A number literal (finite, non-negative, correctly rounded).
    Num(f64),
    /// An identifier; `true`, `false`, unit names and function names are identifiers here.
    Ident(String),
    LParen,
    RParen,
    Comma,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Caret,
    Lt,
    Le,
    Gt,
    Ge,
    EqEq,
    Ne,
    Not,
    AndAnd,
    OrOr,
    Question,
    Colon,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Token {
    pub tok: Tok,
    /// Byte offset of the token's first character.
    pub offset: usize,
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}

fn is_ident_continue(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Split `text` into tokens. Whitespace is exactly space and tab ([W0-15]); anything else
/// outside the grammar's alphabet is a lexical error (`EXPR_SYNTAX` without `expr`).
pub(crate) fn lex(text: &str) -> Result<Vec<Token>, SyntaxError> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    let err = |offset: usize, expected: &'static str| SyntaxError {
        offset,
        expected,
        lexes: false,
    };
    while i < b.len() {
        let c = b[i];
        if c == b' ' || c == b'\t' {
            i += 1;
            continue;
        }
        let start = i;
        if c.is_ascii_digit() {
            // number = digits [ "." digits ] [ ("e" | "E") ["+" | "-"] digits ]
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            if i < b.len() && b[i] == b'.' {
                i += 1;
                if !(i < b.len() && b[i].is_ascii_digit()) {
                    return Err(err(i, "digits after '.'"));
                }
                while i < b.len() && b[i].is_ascii_digit() {
                    i += 1;
                }
            }
            if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
                i += 1;
                if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
                    i += 1;
                }
                if !(i < b.len() && b[i].is_ascii_digit()) {
                    return Err(err(i, "digits in the exponent"));
                }
                while i < b.len() && b[i].is_ascii_digit() {
                    i += 1;
                }
            }
            // Rust's float parser is correctly rounded (round-half-even), like JSON.parse
            // and Python's float(); it returns ±∞ on overflow and the rounded value (possibly
            // 0) on underflow.
            let v: f64 = text[start..i].parse().map_err(|_| err(start, "a number"))?;
            if !v.is_finite() {
                // [W0-15] a literal that rounds to ±∞ is EXPR_SYNTAX.
                return Err(err(start, "a finite number literal"));
            }
            out.push(Token {
                tok: Tok::Num(v),
                offset: start,
            });
            continue;
        }
        if is_ident_start(c) {
            while i < b.len() && is_ident_continue(b[i]) {
                i += 1;
            }
            out.push(Token {
                tok: Tok::Ident(text[start..i].to_string()),
                offset: start,
            });
            continue;
        }
        let two = if i + 1 < b.len() {
            Some((c, b[i + 1]))
        } else {
            None
        };
        let (tok, len) = match two {
            Some((b'<', b'=')) => (Tok::Le, 2),
            Some((b'>', b'=')) => (Tok::Ge, 2),
            Some((b'=', b'=')) => (Tok::EqEq, 2),
            Some((b'!', b'=')) => (Tok::Ne, 2),
            Some((b'&', b'&')) => (Tok::AndAnd, 2),
            Some((b'|', b'|')) => (Tok::OrOr, 2),
            _ => match c {
                b'(' => (Tok::LParen, 1),
                b')' => (Tok::RParen, 1),
                b',' => (Tok::Comma, 1),
                b'+' => (Tok::Plus, 1),
                b'-' => (Tok::Minus, 1),
                b'*' => (Tok::Star, 1),
                b'/' => (Tok::Slash, 1),
                b'%' => (Tok::Percent, 1),
                b'^' => (Tok::Caret, 1),
                b'<' => (Tok::Lt, 1),
                b'>' => (Tok::Gt, 1),
                b'!' => (Tok::Not, 1),
                b'?' => (Tok::Question, 1),
                b':' => (Tok::Colon, 1),
                _ => return Err(err(start, "an operator, a number or a name")),
            },
        };
        out.push(Token { tok, offset: start });
        i += len;
    }
    Ok(out)
}
