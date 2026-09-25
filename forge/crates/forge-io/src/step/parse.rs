//! A Part 21 (ISO 10303-21) reader: the lexer and parser of exchange structures.
//!
//! It reads the header and data sections into [`Record`]s and [`Instance`]s (simple and
//! complex entity instances) without interpreting any schema. [`super::verify`] builds on
//! it to check files the writer produced; STEP import (FM7) will build on it too.
//!
//! Supported: comments, typed parameters, nested lists, enumerations, binaries, `$` and
//! `*`, and the string encodings `''`, `\\`, `\S\`, `\X\hh`, `\X2\…\X0\` and `\X4\…\X0\`.
//! Several `DATA` sections are merged. Instance names must be unique.

use std::collections::BTreeMap;

use super::StepError;

/// A parameter value.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// `#n`.
    Ref(u64),
    /// An integer.
    Int(i64),
    /// A real.
    Real(f64),
    /// A decoded string.
    Str(String),
    /// `.NAME.` (without the dots).
    Enum(String),
    /// A binary `"…"` (hex digits, as written).
    Binary(String),
    /// `$`.
    Unset,
    /// `*`.
    Derived,
    /// `( … )`.
    List(Vec<Value>),
    /// `TYPE( … )`, e.g. `LENGTH_MEASURE(1.E-6)`.
    Typed(String, Vec<Value>),
}

impl Value {
    /// The referenced instance, if this is a reference.
    pub fn as_ref(&self) -> Option<u64> {
        match self {
            Value::Ref(r) => Some(*r),
            _ => None,
        }
    }
    /// The number (integer or real) as `f64`.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Real(x) => Some(*x),
            Value::Int(i) => Some(*i as f64),
            _ => None,
        }
    }
    /// The list elements, if this is a list.
    pub fn as_list(&self) -> Option<&[Value]> {
        match self {
            Value::List(v) => Some(v),
            _ => None,
        }
    }
    /// The string, if this is a string.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
    /// `.T.` → `true`, `.F.` → `false`.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Enum(e) if e == "T" => Some(true),
            Value::Enum(e) if e == "F" => Some(false),
            _ => None,
        }
    }
}

/// `NAME(args)`: a header entity or one partial record of an instance.
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    /// Entity name (upper case as written).
    pub name: String,
    /// Parameters.
    pub args: Vec<Value>,
}

/// An entity instance of the data section.
#[derive(Clone, Debug, PartialEq)]
pub enum Instance {
    /// `#n=NAME(...)`.
    Simple(Record),
    /// `#n=(A(...) B(...) ...)`.
    Complex(Vec<Record>),
}

impl Instance {
    /// The record for `name` (the simple record, or that partial record of a complex
    /// instance).
    pub fn record(&self, name: &str) -> Option<&Record> {
        match self {
            Instance::Simple(r) => (r.name == name).then_some(r),
            Instance::Complex(rs) => rs.iter().find(|r| r.name == name),
        }
    }
    /// The simple record's name, or `None` for a complex instance.
    pub fn simple_name(&self) -> Option<&str> {
        match self {
            Instance::Simple(r) => Some(&r.name),
            Instance::Complex(_) => None,
        }
    }
    /// All partial record names (one for a simple instance).
    pub fn names(&self) -> Vec<&str> {
        match self {
            Instance::Simple(r) => vec![r.name.as_str()],
            Instance::Complex(rs) => rs.iter().map(|r| r.name.as_str()).collect(),
        }
    }
}

/// A parsed exchange structure.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct P21File {
    /// Header entities (`FILE_DESCRIPTION`, `FILE_NAME`, `FILE_SCHEMA`, …), in order.
    pub header: Vec<Record>,
    /// Instances by instance number.
    pub data: BTreeMap<u64, Instance>,
}

impl P21File {
    /// The schema names of `FILE_SCHEMA`.
    pub fn schemas(&self) -> Vec<String> {
        self.header
            .iter()
            .find(|r| r.name == "FILE_SCHEMA")
            .and_then(|r| r.args.first())
            .and_then(Value::as_list)
            .map(|l| {
                l.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Keyword(String),
    Ref(u64),
    Int(i64),
    Real(f64),
    Str(String),
    Enum(String),
    Binary(String),
    Dollar,
    Star,
    LParen,
    RParen,
    Comma,
    Equals,
    Semi,
    Eof,
}

struct Lexer<'a> {
    b: &'a [u8],
    pos: usize,
}

fn syntax(offset: usize, detail: impl Into<String>) -> StepError {
    StepError::Syntax {
        offset,
        detail: detail.into(),
    }
}

impl<'a> Lexer<'a> {
    fn skip_ws(&mut self) -> Result<(), StepError> {
        loop {
            while self.pos < self.b.len() && self.b[self.pos].is_ascii_whitespace() {
                self.pos += 1;
            }
            if self.b[self.pos..].starts_with(b"/*") {
                let start = self.pos;
                match self.b[self.pos + 2..].windows(2).position(|w| w == b"*/") {
                    Some(k) => self.pos += 2 + k + 2,
                    None => return Err(syntax(start, "unterminated comment")),
                }
            } else {
                return Ok(());
            }
        }
    }

    fn next(&mut self) -> Result<(usize, Tok), StepError> {
        self.skip_ws()?;
        let start = self.pos;
        let Some(&c) = self.b.get(self.pos) else {
            return Ok((start, Tok::Eof));
        };
        let tok = match c {
            b'(' => {
                self.pos += 1;
                Tok::LParen
            }
            b')' => {
                self.pos += 1;
                Tok::RParen
            }
            b',' => {
                self.pos += 1;
                Tok::Comma
            }
            b'=' => {
                self.pos += 1;
                Tok::Equals
            }
            b';' => {
                self.pos += 1;
                Tok::Semi
            }
            b'$' => {
                self.pos += 1;
                Tok::Dollar
            }
            b'*' => {
                self.pos += 1;
                Tok::Star
            }
            b'#' => {
                self.pos += 1;
                let d0 = self.pos;
                while self.pos < self.b.len() && self.b[self.pos].is_ascii_digit() {
                    self.pos += 1;
                }
                let digits = std::str::from_utf8(&self.b[d0..self.pos]).unwrap_or("");
                let n: u64 = digits
                    .parse()
                    .map_err(|_| syntax(start, "bad instance name"))?;
                Tok::Ref(n)
            }
            b'\'' => Tok::Str(self.string()?),
            b'"' => {
                self.pos += 1;
                let d0 = self.pos;
                while self.pos < self.b.len() && self.b[self.pos] != b'"' {
                    self.pos += 1;
                }
                if self.pos >= self.b.len() {
                    return Err(syntax(start, "unterminated binary"));
                }
                let s = String::from_utf8_lossy(&self.b[d0..self.pos]).into_owned();
                self.pos += 1;
                Tok::Binary(s)
            }
            b'.' if self
                .b
                .get(self.pos + 1)
                .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_') =>
            {
                self.pos += 1;
                let d0 = self.pos;
                while self.pos < self.b.len()
                    && (self.b[self.pos].is_ascii_alphanumeric() || self.b[self.pos] == b'_')
                {
                    self.pos += 1;
                }
                if self.b.get(self.pos) != Some(&b'.') {
                    return Err(syntax(start, "unterminated enumeration"));
                }
                let s = String::from_utf8_lossy(&self.b[d0..self.pos]).to_ascii_uppercase();
                self.pos += 1;
                Tok::Enum(s)
            }
            b'+' | b'-' | b'0'..=b'9' | b'.' => self.number()?,
            c if c.is_ascii_alphabetic() || c == b'_' || c == b'!' => {
                let d0 = self.pos;
                self.pos += 1;
                while self.pos < self.b.len()
                    && (self.b[self.pos].is_ascii_alphanumeric()
                        || self.b[self.pos] == b'_'
                        || self.b[self.pos] == b'-')
                {
                    self.pos += 1;
                }
                Tok::Keyword(String::from_utf8_lossy(&self.b[d0..self.pos]).to_ascii_uppercase())
            }
            _ => return Err(syntax(start, format!("unexpected byte 0x{c:02X}"))),
        };
        Ok((start, tok))
    }

    fn number(&mut self) -> Result<Tok, StepError> {
        let start = self.pos;
        if matches!(self.b[self.pos], b'+' | b'-') {
            self.pos += 1;
        }
        let mut real = false;
        while self.pos < self.b.len() {
            let c = self.b[self.pos];
            if c.is_ascii_digit() {
                self.pos += 1;
            } else if c == b'.' {
                real = true;
                self.pos += 1;
            } else if c == b'E' || c == b'e' {
                real = true;
                self.pos += 1;
                if self.pos < self.b.len() && matches!(self.b[self.pos], b'+' | b'-') {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
        let text = std::str::from_utf8(&self.b[start..self.pos]).unwrap_or("");
        if real {
            // Part 21 allows `1.` and `1.E5`; Rust's parser accepts both.
            text.parse::<f64>()
                .map(Tok::Real)
                .map_err(|_| syntax(start, format!("bad real {text:?}")))
        } else {
            text.parse::<i64>()
                .map(Tok::Int)
                .map_err(|_| syntax(start, format!("bad integer {text:?}")))
        }
    }

    /// A string literal starting at the opening apostrophe, decoded.
    fn string(&mut self) -> Result<String, StepError> {
        let start = self.pos;
        self.pos += 1;
        let mut raw: Vec<u8> = Vec::new();
        loop {
            let Some(&c) = self.b.get(self.pos) else {
                return Err(syntax(start, "unterminated string"));
            };
            if c == b'\'' {
                if self.b.get(self.pos + 1) == Some(&b'\'') {
                    raw.push(b'\'');
                    self.pos += 2;
                    continue;
                }
                self.pos += 1;
                break;
            }
            if c == b'\n' || c == b'\r' {
                // Line breaks inside strings are not part of the value (§6.4.3).
                self.pos += 1;
                continue;
            }
            raw.push(c);
            self.pos += 1;
        }
        decode_string(&raw).ok_or_else(|| syntax(start, "bad string escape"))
    }
}

fn hex(b: &[u8]) -> Option<u32> {
    let s = std::str::from_utf8(b).ok()?;
    u32::from_str_radix(s, 16).ok()
}

/// Decode the control directives of a Part 21 string (§6.4.3).
fn decode_string(raw: &[u8]) -> Option<String> {
    let mut out = String::new();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] != b'\\' {
            // Plain run (non-conforming writers put UTF-8 here; decode it as such).
            let j = raw[i..]
                .iter()
                .position(|&c| c == b'\\')
                .map_or(raw.len(), |k| i + k);
            out.push_str(&String::from_utf8_lossy(&raw[i..j]));
            i = j;
            continue;
        }
        let rest = &raw[i..];
        if rest.starts_with(b"\\\\") {
            out.push('\\');
            i += 2;
        } else if rest.starts_with(b"\\X2\\") || rest.starts_with(b"\\X4\\") {
            let width = if rest[2] == b'2' { 4 } else { 8 };
            i += 4;
            loop {
                if raw[i..].starts_with(b"\\X0\\") {
                    i += 4;
                    break;
                }
                let digits = raw.get(i..i + width)?;
                let cp = hex(digits)?;
                out.push(char::from_u32(cp)?);
                i += width;
            }
        } else if rest.starts_with(b"\\X\\") {
            let cp = hex(raw.get(i + 3..i + 5)?)?;
            out.push(char::from_u32(cp)?);
            i += 5;
        } else if rest.starts_with(b"\\S\\") {
            let c = *raw.get(i + 3)?;
            out.push(char::from_u32(u32::from(c) + 128)?);
            i += 4;
        } else if rest.len() >= 4 && rest[1] == b'P' && rest[3] == b'\\' {
            // Code page switch (\PA\ …): ISO 8859 page selection; ignored.
            i += 4;
        } else {
            return None;
        }
    }
    Some(out)
}

struct Parser<'a> {
    lex: Lexer<'a>,
    peeked: Option<(usize, Tok)>,
}

impl<'a> Parser<'a> {
    fn peek(&mut self) -> Result<&(usize, Tok), StepError> {
        if self.peeked.is_none() {
            self.peeked = Some(self.lex.next()?);
        }
        Ok(self.peeked.as_ref().expect("peeked"))
    }
    fn bump(&mut self) -> Result<(usize, Tok), StepError> {
        match self.peeked.take() {
            Some(t) => Ok(t),
            None => self.lex.next(),
        }
    }
    fn expect(&mut self, want: &Tok, what: &str) -> Result<usize, StepError> {
        let (off, t) = self.bump()?;
        if &t == want {
            Ok(off)
        } else {
            Err(syntax(off, format!("expected {what}, found {t:?}")))
        }
    }
    fn keyword(&mut self) -> Result<(usize, String), StepError> {
        match self.bump()? {
            (off, Tok::Keyword(k)) => Ok((off, k)),
            (off, t) => Err(syntax(off, format!("expected a keyword, found {t:?}"))),
        }
    }

    /// `NAME ( params )`.
    fn record(&mut self) -> Result<Record, StepError> {
        let (_, name) = self.keyword()?;
        self.expect(&Tok::LParen, "'('")?;
        let args = self.params_until_rparen()?;
        Ok(Record { name, args })
    }

    /// Parameters up to and including the closing `)`.
    fn params_until_rparen(&mut self) -> Result<Vec<Value>, StepError> {
        let mut out = Vec::new();
        if self.peek()?.1 == Tok::RParen {
            self.bump()?;
            return Ok(out);
        }
        loop {
            out.push(self.value()?);
            match self.bump()? {
                (_, Tok::Comma) => continue,
                (_, Tok::RParen) => return Ok(out),
                (off, t) => return Err(syntax(off, format!("expected ',' or ')', found {t:?}"))),
            }
        }
    }

    fn value(&mut self) -> Result<Value, StepError> {
        let (off, t) = self.bump()?;
        Ok(match t {
            Tok::Ref(n) => Value::Ref(n),
            Tok::Int(i) => Value::Int(i),
            Tok::Real(x) => Value::Real(x),
            Tok::Str(s) => Value::Str(s),
            Tok::Enum(e) => Value::Enum(e),
            Tok::Binary(b) => Value::Binary(b),
            Tok::Dollar => Value::Unset,
            Tok::Star => Value::Derived,
            Tok::LParen => Value::List(self.params_until_rparen()?),
            Tok::Keyword(k) => {
                self.expect(&Tok::LParen, "'(' after a type name")?;
                Value::Typed(k, self.params_until_rparen()?)
            }
            t => return Err(syntax(off, format!("unexpected {t:?} in a parameter list"))),
        })
    }
}

/// Parse a Part 21 exchange structure.
pub fn parse(bytes: &[u8]) -> Result<P21File, StepError> {
    let mut p = Parser {
        lex: Lexer { b: bytes, pos: 0 },
        peeked: None,
    };
    let (off, magic) = p.keyword()?;
    if magic != "ISO-10303-21" {
        return Err(syntax(off, "missing ISO-10303-21 magic"));
    }
    p.expect(&Tok::Semi, "';'")?;
    let (off, h) = p.keyword()?;
    if h != "HEADER" {
        return Err(syntax(off, "missing HEADER section"));
    }
    p.expect(&Tok::Semi, "';'")?;
    let mut file = P21File::default();
    loop {
        if let (_, Tok::Keyword(k)) = p.peek()?
            && k == "ENDSEC"
        {
            p.bump()?;
            p.expect(&Tok::Semi, "';'")?;
            break;
        }
        let r = p.record()?;
        p.expect(&Tok::Semi, "';'")?;
        file.header.push(r);
    }
    loop {
        let (off, k) = p.keyword()?;
        match k.as_str() {
            "END-ISO-10303-21" => {
                p.expect(&Tok::Semi, "';'")?;
                break;
            }
            "DATA" => {
                if p.peek()?.1 == Tok::LParen {
                    p.bump()?;
                    p.params_until_rparen()?;
                }
                p.expect(&Tok::Semi, "';'")?;
                data_section(&mut p, &mut file)?;
            }
            _ => return Err(syntax(off, format!("unexpected section {k}"))),
        }
    }
    let (off, t) = p.bump()?;
    if t != Tok::Eof {
        return Err(syntax(off, "data after END-ISO-10303-21"));
    }
    Ok(file)
}

fn data_section(p: &mut Parser<'_>, file: &mut P21File) -> Result<(), StepError> {
    loop {
        match p.bump()? {
            (_, Tok::Keyword(k)) if k == "ENDSEC" => {
                p.expect(&Tok::Semi, "';'")?;
                return Ok(());
            }
            (off, Tok::Ref(n)) => {
                p.expect(&Tok::Equals, "'='")?;
                let inst = if p.peek()?.1 == Tok::LParen {
                    p.bump()?;
                    let mut parts = Vec::new();
                    while p.peek()?.1 != Tok::RParen {
                        parts.push(p.record()?);
                    }
                    p.bump()?;
                    if parts.is_empty() {
                        return Err(syntax(off, "empty complex instance"));
                    }
                    Instance::Complex(parts)
                } else {
                    Instance::Simple(p.record()?)
                };
                p.expect(&Tok::Semi, "';'")?;
                if file.data.insert(n, inst).is_some() {
                    return Err(syntax(off, format!("instance #{n} defined twice")));
                }
            }
            (off, t) => return Err(syntax(off, format!("expected an instance, found {t:?}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "ISO-10303-21;\nHEADER;\n/* a comment */\nFILE_DESCRIPTION(('x'),'2;1');\n\
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n\
#1=CARTESIAN_POINT('it''s',(0.,-1.5E-3,2));\n#2=( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );\n\
#3=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#2,'d\\X2\\00FC\\X0\\','$');\n\
#4=PRODUCT('a','b',$,(#1));\nENDSEC;\nEND-ISO-10303-21;\n";

    #[test]
    fn parses_header_simple_and_complex_instances() {
        let f = parse(SAMPLE.as_bytes()).expect("parses");
        assert_eq!(
            f.schemas(),
            vec!["AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }"]
        );
        let Instance::Simple(p) = &f.data[&1] else {
            panic!("simple")
        };
        assert_eq!(p.args[0], Value::Str("it's".into()));
        assert_eq!(
            p.args[1],
            Value::List(vec![Value::Real(0.0), Value::Real(-1.5e-3), Value::Int(2)])
        );
        let Instance::Complex(parts) = &f.data[&2] else {
            panic!("complex")
        };
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[2].args[0], Value::Enum("MILLI".into()));
        assert_eq!(parts[1].args[0], Value::Derived);
        let u = f.data[&3]
            .record("UNCERTAINTY_MEASURE_WITH_UNIT")
            .expect("rec");
        assert_eq!(
            u.args[0],
            Value::Typed("LENGTH_MEASURE".into(), vec![Value::Real(1e-6)])
        );
        assert_eq!(u.args[2], Value::Str("dü".into()));
        assert_eq!(
            f.data[&4].record("PRODUCT").expect("p").args[2],
            Value::Unset
        );
    }

    #[test]
    fn rejects_duplicates_and_garbage_with_offsets() {
        let dup = SAMPLE.replace("#4=PRODUCT", "#1=PRODUCT");
        let e = parse(dup.as_bytes()).expect_err("duplicate");
        assert_eq!(e.code(), "STEP_SYNTAX");
        let e = parse(b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=X(;\n").expect_err("bad");
        assert!(matches!(e, StepError::Syntax { .. }), "{e:?}");
        assert!(parse(b"hello").is_err());
    }

    #[test]
    fn string_escapes_round_trip_through_the_writer() {
        for s in ["plain", "it's", "back\\slash", "Klammer ü", "a𝔸b", "日本"] {
            let mut enc = String::new();
            super::super::p21::push_string(&mut enc, s);
            let text = format!(
                "ISO-10303-21;HEADER;ENDSEC;DATA;#1=PRODUCT({enc},'',$,());ENDSEC;END-ISO-10303-21;"
            );
            let f = parse(text.as_bytes()).expect("parses");
            assert_eq!(
                f.data[&1].record("PRODUCT").expect("p").args[0],
                Value::Str(s.into())
            );
        }
    }
}
